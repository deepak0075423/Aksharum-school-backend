'use strict';
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const User    = require('../models/User');
const { isEmail, passwordError } = require('../utils/validators');
const authCache = require('../utils/authCache');

// role + schoolId ride along so the WebSocket Gateway can route sockets without
// a round trip to the API on every handshake (it falls back to /internal/user-context
// for tokens issued before these claims existed).
const signToken = (user) => {
    const payload = { userId: user._id || user };
    if (user.role)   payload.role     = user.role;
    const school = user.school?._id || user.school;
    if (school)      payload.schoolId = String(school);
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
};

const signRefresh = (userId) =>
    jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });

// ─────────────────────────────────────────────────────────────────────────────
//  A deactivated school locks out everyone who belongs to it.
//
//  The two audiences get different instructions because they have different
//  remedies: a teacher / student / parent needs their own school administrator,
//  while the school admin's own school is the thing that was switched off, so
//  only the platform can help. Super admin has no school and is never affected.
//
//  Returns null when the caller may proceed, or {code, message} when they may not.
// ─────────────────────────────────────────────────────────────────────────────
const SCHOOL_INACTIVE = 'SCHOOL_INACTIVE';

function schoolLockout(user) {
    if (user.role === 'super_admin') return null;
    const school = user.school;
    // A missing school ref is not a lockout — that is an account-shape problem
    // the existing checks already cover.
    if (!school || typeof school !== 'object') return null;
    if (school.isActive !== false) return null;

    return {
        code: SCHOOL_INACTIVE,
        message: user.role === 'school_admin'
            ? `${school.name || 'Your school'} has been deactivated. Please contact support.`
            : `${school.name || 'Your school'} is currently inactive. Please contact your school administrator.`,
    };
}

exports.login = async (req, res) => {
    try {
        const { email, password, schoolCode } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password required' });
        }
        const user = await User.findOne({ email: email.toLowerCase() }).populate('school');
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        if (!user.isActive) {
            return res.status(403).json({ success: false, message: 'Account disabled' });
        }
        // Checked after the password so a wrong password never reveals whether
        // the account exists or which school it belongs to.
        const locked = schoolLockout(user);
        if (locked) {
            return res.status(403).json({ success: false, code: locked.code, message: locked.message });
        }
        sendSession(res, user);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

/** The signed-in answer, identical whichever way the person proved who they are. */
function sendSession(res, user) {
    res.json({
        success: true,
        token:        signToken(user),
        refreshToken: signRefresh(user._id),
        user: {
            id:           user._id,
            name:         user.name,
            email:        user.email,
            role:         user.role,
            isFirstLogin: user.isFirstLogin,
            school:       user.school,
            profileImage: user.profileImage,
        },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sign in with Google
//
//  Google vouches for an email address; it never creates an account. The
//  address has to belong to an account the school already made, and that
//  account goes through exactly the checks a password sign-in does — disabled
//  accounts and deactivated schools are refused the same way. A first-login
//  account still has to set its password afterwards.
//
//  The browser's Google popup hands back a one-time authorization code; it is
//  exchanged here, server to server, with the client secret. The ID token comes
//  back from Google's token endpoint over TLS, which OpenID Connect accepts in
//  place of a signature check — its claims are still checked: issued for this
//  app, by Google, not expired, and for an email Google has verified.
//
//  Off until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set; the page
//  asks /google/config and shows no button while it is off.
// ─────────────────────────────────────────────────────────────────────────────
const googleConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

exports.googleConfig = (req, res) => {
    res.json({
        success:  true,
        enabled:  googleConfigured(),
        clientId: googleConfigured() ? process.env.GOOGLE_CLIENT_ID : null,
    });
};

const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

function decodeJwtPayload(token) {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
}

exports.googleLogin = async (req, res) => {
    const refuse = (status, message) => res.status(status).json({ success: false, message });
    try {
        if (!googleConfigured()) return refuse(404, 'Google sign-in is not enabled');
        // The popup flow's code must be redeemed by a script on our page, not by
        // a form another site posted — Google's guidance for this flow.
        if (req.get('X-Requested-With') !== 'XMLHttpRequest') return refuse(400, 'Invalid request');
        const code = String(req.body?.code || '');
        if (!code) return refuse(400, 'Google did not return a sign-in code');

        const exchange = await fetch('https://oauth2.googleapis.com/token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id:     process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri:  'postmessage',
                grant_type:    'authorization_code',
            }),
            signal: AbortSignal.timeout(10000),
        });
        const tokens = await exchange.json().catch(() => ({}));
        if (!exchange.ok || !tokens.id_token) return refuse(401, 'Google sign-in could not be completed. Please try again.');

        const claims = decodeJwtPayload(tokens.id_token);
        const valid = claims
            && GOOGLE_ISSUERS.includes(claims.iss)
            && claims.aud === process.env.GOOGLE_CLIENT_ID
            && Number(claims.exp) * 1000 > Date.now()
            && (claims.email_verified === true || claims.email_verified === 'true')
            && claims.email;
        if (!valid) return refuse(401, 'Google could not confirm this email address');

        const user = await User.findOne({ email: String(claims.email).toLowerCase() }).populate('school');
        if (!user) {
            return refuse(401, `No account uses ${claims.email}. Sign in with your email and password, or ask your school office to add this address.`);
        }
        if (!user.isActive) return refuse(403, 'Account disabled');
        const locked = schoolLockout(user);
        if (locked) return res.status(403).json({ success: false, code: locked.code, message: locked.message });

        sendSession(res, user);
    } catch (err) {
        res.status(500).json({ success: false, message: 'Google sign-in failed. Please try again.' });
    }
};

exports.logout = (req, res) => {
    res.json({ success: true, message: 'Logged out' });
};

exports.getMe = async (req, res) => {
    res.json({ success: true, user: req.user });
};

exports.refreshToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        const user = await User.findById(decoded.userId).populate('school');
        if (!user || !user.isActive) return res.status(401).json({ success: false, message: 'Invalid token' });
        const locked = schoolLockout(user);
        if (locked) return res.status(403).json({ success: false, code: locked.code, message: locked.message });
        const token = signToken(user);
        res.json({ success: true, token });
    } catch (err) {
        res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const pwErr = passwordError(newPassword);
        if (pwErr) return res.status(400).json({ success: false, message: pwErr });
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        // First-login: OTP already verified by login — skip current password check
        if (!user.isFirstLogin) {
            if (!currentPassword) {
                return res.status(400).json({ success: false, message: 'Current password is required' });
            }
            if (!(await bcrypt.compare(currentPassword, user.password))) {
                return res.status(400).json({ success: false, message: 'Current password incorrect' });
            }
        }
        user.password     = await bcrypt.hash(newPassword, 12);
        user.isFirstLogin = false;
        await user.save();
        await authCache.invalidate(user._id); // clear cached isFirstLogin so the reset gate lifts immediately
        res.json({ success: true, message: 'Password updated' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!isEmail(email)) return res.status(400).json({ success: false, message: 'A valid email address is required' });
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.json({ success: true, message: 'If that email exists, an OTP was sent' });
        }
        const otp     = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 10 * 60 * 1000);
        user.resetOtp        = otp;
        user.resetOtpExpires = expires;
        await user.save();
        // TODO: send OTP via email
        res.json({ success: true, message: 'OTP sent to registered email' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.verifyOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;
        const user = await User.findOne({
            email:          email?.toLowerCase(),
            resetOtp:       otp,
            resetOtpExpires: { $gt: Date.now() },
        });
        if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        const resetToken  = crypto.randomBytes(32).toString('hex');
        user.resetToken   = resetToken;
        user.resetOtp     = undefined;
        user.resetOtpExpires = undefined;
        await user.save();
        res.json({ success: true, resetToken });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.newPassword = async (req, res) => {
    try {
        const { resetToken, password } = req.body;
        if (!resetToken) return res.status(400).json({ success: false, message: 'Reset token is required' });
        const pwErr = passwordError(password);
        if (pwErr) return res.status(400).json({ success: false, message: pwErr });
        const user = await User.findOne({ resetToken });
        if (!user) return res.status(400).json({ success: false, message: 'Invalid reset token' });
        user.password         = await bcrypt.hash(password, 12);
        user.resetToken       = undefined;
        user.isFirstLogin     = false;
        await user.save();
        await authCache.invalidate(user._id); // clear cached isFirstLogin so the reset gate lifts immediately
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.magicLogin = async (req, res) => {
    try {
        const { token } = req.params;
        const user = await User.findOneAndUpdate(
            { loginToken: token, loginTokenExpiry: { $gt: new Date() } },
            { $set: { loginToken: null, loginTokenExpiry: null } },
            { new: false },
        ).populate('school');
        if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired magic link' });
        // The link may have been issued while the account was still live. It is
        // burned above either way — a deactivated account must not be able to
        // retry it — but the same two gates the password login applies still
        // decide whether anyone gets in.
        if (!user.isActive) {
            return res.status(403).json({ success: false, message: 'Account disabled' });
        }
        const locked = schoolLockout(user);
        if (locked) {
            return res.status(403).json({ success: false, code: locked.code, message: locked.message });
        }
        const jwtToken = signToken(user);
        const refresh  = signRefresh(user._id);
        res.json({
            success: true,
            token: jwtToken,
            refreshToken: refresh,
            user: { id: user._id, name: user.name, email: user.email, role: user.role, school: user.school },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
