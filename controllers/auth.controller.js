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
        const token   = signToken(user);
        const refresh = signRefresh(user._id);
        res.json({
            success: true,
            token,
            refreshToken: refresh,
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
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
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
