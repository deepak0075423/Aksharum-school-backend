'use strict';
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const User    = require('../models/User');
const { isEmail, passwordError } = require('../utils/validators');
const identity  = require('../services/accountIdentity');
const { sendOtpEmail } = require('../utils/sendEmail');

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
        // An address is a person, not a seat: it may open a teaching post at one
        // school and a parent's account at another. Everything the password
        // opens is collected, and the person says which one they are here as.
        const rows = await identity.membershipsByEmail(email);
        const opened = rows.length ? await identity.openedBy(rows, password) : [];
        if (!opened.length) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        // Checked after the password so a wrong password never reveals whether
        // the account exists or which school it belongs to.
        return answerSignIn(res, opened);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * What to hand back once the person has proved who they are.
 *
 * One live membership signs them straight in, exactly as before. Several means
 * a choice only they can make — which school, which role — so nothing is issued
 * yet beyond a short-lived token that says "this address opened these seats".
 * None means every door their password opens has been closed, and the first
 * reason is the one worth telling them.
 */
async function answerSignIn(res, openedRows) {
    const { open, blocked } = identity.partition(openedRows);

    if (!open.length) {
        const first = blocked[0];
        return res.status(403).json({
            success: false,
            ...(first?.code === SCHOOL_INACTIVE ? { code: SCHOOL_INACTIVE } : {}),
            message: first?.reason || 'Account disabled',
        });
    }
    if (open.length === 1) return sendSessionFor(res, open[0]);

    // Ten minutes is long enough to read a list and short enough that a token
    // left on a shared screen is worthless. It names the seats it was issued
    // for, so it cannot be turned into a session for anything else.
    const selectionToken = jwt.sign(
        { purpose: 'select', email: open[0].email, ids: open.map((r) => String(r._id)) },
        process.env.JWT_SECRET,
        { expiresIn: '10m' },
    );
    return res.json({
        success:          true,
        requiresSelection: true,
        selectionToken,
        name:             open[0].name,
        email:            open[0].email,
        accounts:         open.map(identity.publicShape),
    });
}

/**
 * The signed-in answer, identical whichever way the person proved who they are.
 *
 * `row` is a membership row from the identity service; the full account (with
 * its school populated) is loaded here so the response keeps the exact shape
 * every client already reads.
 */
async function sendSessionFor(res, row) {
    const user = await User.findById(row._id).populate('school');
    if (!user || !user.isActive) {
        return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }
    // The other seats this same password opens, so the app can offer the
    // switcher without a second round trip.
    const accounts = await identity.switchTargets(row);
    return res.json({
        success: true,
        token:        signToken(user),
        refreshToken: signRefresh(user._id),
        user: {
            id:           user._id,
            _id:          user._id,
            name:         user.name,
            email:        user.email,
            role:         user.role,
            isFirstLogin: user.isFirstLogin,
            school:       user.school,
            profileImage: user.profileImage,
            accounts,
        },
    });
}

/**
 * POST /auth/select — finish a sign-in that stopped to ask which seat.
 *
 * The seat is re-read from the database rather than trusted from the token: a
 * membership can be switched off, or its school deactivated, between the list
 * being drawn and the person clicking it.
 */
exports.selectAccount = async (req, res) => {
    try {
        const { selectionToken, userId } = req.body || {};
        if (!selectionToken || !userId) {
            return res.status(400).json({ success: false, message: 'Selection token and account are required' });
        }
        let claims;
        try {
            claims = jwt.verify(selectionToken, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ success: false, code: 'SELECTION_EXPIRED', message: 'That took too long — please sign in again' });
        }
        if (claims.purpose !== 'select' || !Array.isArray(claims.ids) || !claims.ids.includes(String(userId))) {
            return res.status(403).json({ success: false, message: 'That account is not available on this sign-in' });
        }
        const rows = await identity.membershipsByEmail(claims.email);
        const row  = rows.find((r) => String(r._id) === String(userId));
        if (!row) return res.status(404).json({ success: false, message: 'Account not found' });
        return answerSignIn(res, [row]);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * GET /auth/accounts — the seats reachable from this session.
 *
 * Same address, live membership, live school, and the same password as the one
 * this session was opened with. The current seat is in the list and marked, so
 * the switcher can show where the person is standing.
 */
exports.listAccounts = async (req, res) => {
    try {
        const accounts = await identity.switchTargets(req.user);
        res.json({ success: true, accounts });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * POST /auth/switch — change seat without signing out.
 *
 * Issues a fresh session for another membership of the same person — the same
 * seats their password (or one-time link) opened at sign-in.
 */
exports.switchAccount = async (req, res) => {
    try {
        const { userId } = req.body || {};
        if (!userId) return res.status(400).json({ success: false, message: 'Account is required' });
        if (String(userId) === String(req.userId)) {
            return res.status(400).json({ success: false, message: 'You are already using this account' });
        }
        const targets = await identity.switchTargets(req.user);
        if (!targets.some((t) => t.id === String(userId))) {
            return res.status(403).json({ success: false, message: 'That account is not available from this session' });
        }
        const rows = await identity.membershipsByEmail(req.user.email);
        const row  = rows.find((r) => String(r._id) === String(userId));
        if (!row) return res.status(404).json({ success: false, message: 'Account not found' });
        return answerSignIn(res, [row]);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

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

        // Google vouches for the address; the address resolves to every seat it
        // holds, exactly as a password sign-in does — including the chooser.
        const rows = await identity.membershipsByEmail(String(claims.email));
        if (!rows.length) {
            return refuse(401, `No account uses ${claims.email}. Sign in with your email and password, or ask your school office to add this address.`);
        }
        return answerSignIn(res, rows);
    } catch (err) {
        res.status(500).json({ success: false, message: 'Google sign-in failed. Please try again.' });
    }
};

exports.logout = (req, res) => {
    res.json({ success: true, message: 'Logged out' });
};

exports.getMe = async (req, res) => {
    // req.user comes straight from `SELECT u.*`, so the password hash is on it.
    // It has no business leaving the server — strip it here rather than hope
    // every caller remembers to.
    const { password, otp, otpExpiry, loginToken, resetToken, ...user } = req.user;
    // The seats this session can move between, so the app can draw the switcher
    // on a plain page load and not only right after sign-in.
    const accounts = await identity.switchTargets(req.user);
    res.json({ success: true, user: { ...user, accounts } });
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
        // One person, one password. Written across every seat this address
        // holds, so a teacher who is also a parent does not end up with a new
        // password at one school and the old one at the other. setCredentials
        // clears each of those cached auth entries, so the first-login gate
        // lifts immediately rather than waiting out the TTL.
        await identity.setCredentials(user.email, {
            passwordHash: await bcrypt.hash(newPassword, 12),
            isFirstLogin: false,
        });
        res.json({ success: true, message: 'Password updated' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Forgotten password.
//
//  The address is what proves ownership here — whoever reads the inbox gets the
//  OTP — so the reset covers every seat that address holds, the same way the
//  signed-in password change does. The three steps write to the columns the
//  model actually declares (otp / otpExpiry / resetToken / resetTokenExpiry);
//  they used to write resetOtp and resetOtpExpires, which are not fields on the
//  User schema, so nothing was ever stored and step two could not match.
// ─────────────────────────────────────────────────────────────────────────────

exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!isEmail(email)) return res.status(400).json({ success: false, message: 'A valid email address is required' });
        // The same answer either way: whether an address has an account here is
        // not something a stranger gets to find out.
        const generic = { success: true, message: 'If that email exists, an OTP was sent' };
        const rows = await identity.membershipsByEmail(email);
        const live = identity.partition(rows).open;
        if (!live.length) return res.json(generic);

        const otp     = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 10 * 60 * 1000);
        await identity.setCredentials(email, { extra: { otp, otpExpiry: expires } });
        // Best effort: a mail failure must not tell the caller whether the
        // address exists, so it is logged and the same answer goes back.
        try {
            await sendOtpEmail({ to: live[0].email, name: live[0].name, otp });
        } catch (mailErr) {
            console.error('[auth] reset OTP email failed:', mailErr.message);
        }
        res.json(generic);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.verifyOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;
        const rows = await identity.membershipsByEmail(email);
        const row  = rows.find((r) => r.otp && String(r.otp) === String(otp ?? '')
            && r.otpExpiry && new Date(r.otpExpiry).getTime() > Date.now());
        if (!row) return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });

        const resetToken = crypto.randomBytes(32).toString('hex');
        // The OTP is spent the moment it is exchanged, and the token that
        // replaces it expires on its own — an unfinished reset does not leave a
        // key lying around for a day.
        await identity.setCredentials(row.email, {
            extra: {
                resetToken,
                resetTokenExpiry: new Date(Date.now() + 15 * 60 * 1000),
                otp: null,
                otpExpiry: null,
            },
        });
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
        const row = await identity.byResetToken(resetToken);
        if (!row) return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
        await identity.setCredentials(row.email, {
            passwordHash: await bcrypt.hash(password, 12),
            isFirstLogin: false,
            extra: { resetToken: null, resetTokenExpiry: null },
        });
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.magicLogin = async (req, res) => {
    try {
        const { token } = req.params;
        // Burned before anything else is decided: whatever happens next, a
        // one-time link is never usable twice.
        const linked = await User.findOneAndUpdate(
            { loginToken: token, loginTokenExpiry: { $gt: new Date() } },
            { $set: { loginToken: null, loginTokenExpiry: null } },
            { new: false },
        );
        if (!linked) return res.status(400).json({ success: false, message: 'Invalid or expired magic link' });

        // A one-time link proves who the person is, the same way their password
        // does — so it opens what their password opens: every post behind the
        // address that shares the linked post's credentials. A parent with
        // children at two schools therefore gets the same "which school?"
        // question here as at the password form, rather than being dropped into
        // whichever school the link happened to be issued from.
        //
        // answerSignIn applies the same gates as every other sign-in: posts that
        // are switched off, or whose school is, are not offered, and when none
        // is left the first reason is what the person is told.
        const rows = await identity.membershipsByEmail(linked.email);
        const linkedRow = rows.find((r) => String(r._id) === String(linked._id));
        if (!linkedRow) return res.status(400).json({ success: false, message: 'Invalid or expired magic link' });
        return answerSignIn(res, rows.filter((r) => r.password === linkedRow.password));
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
