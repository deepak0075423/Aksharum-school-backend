'use strict';
const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const School = require('../models/School');
const pool   = require('../db/pool');
const authCache = require('../utils/authCache');

// Auth runs on EVERY authenticated request, so it is the single hottest query in
// the app. A separate `User.findById(id)` + school lookup would cost two
// sequential round-trips (fetch user, then fetch school by its ref). Postgres can
// do it in one native LEFT JOIN. The school's columns are pulled out under a
// "__s_" alias prefix and reassembled into `user.school` below — this keeps the
// native pg column types intact (timestamptz -> Date, jsonb -> object), so the
// result is byte-for-byte identical to what populate() produced.
const SCHOOL_FIELDS = ['_id', ...Object.keys(School.schema.parsed().fields)];
const SCHOOL_SELECT = SCHOOL_FIELDS
    .map((f) => `s.${JSON.stringify(f)} AS ${JSON.stringify(`__s_${f}`)}`)
    .join(', ');
const AUTH_USER_SQL = `
    SELECT u.*, ${SCHOOL_SELECT}
    FROM ${JSON.stringify(User.tableName)} u
    LEFT JOIN ${JSON.stringify(School.tableName)} s ON s._id = u.school
    WHERE u._id = $1::uuid
    LIMIT 1`;

async function loadAuthUser(userId) {
    const { rows } = await pool.query(AUTH_USER_SQL, [String(userId)]);
    if (!rows.length) return null;
    const user = rows[0];
    // Reassemble the joined columns into `user.school`. A null/dangling ref means
    // the join produced no row (__s__id is null) -> school stays null, matching populate().
    const hasSchool = user.__s__id != null;
    const school = hasSchool ? {} : null;
    for (const f of SCHOOL_FIELDS) {
        if (hasSchool) school[f] = user[`__s_${f}`];
        delete user[`__s_${f}`];
    }
    user.school = school;
    return user;
}

const verifyToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7);

    if (!token) {
        return res.status(401).json({ success: false, message: 'Access token required' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        // Redis-cached first (bounded by a short TTL + explicit invalidation on
        // user mutations); fall back to the single-JOIN DB load and warm the cache.
        let user = await authCache.get(decoded.userId);
        if (!user) {
            user = await loadAuthUser(decoded.userId);
            if (user) await authCache.set(decoded.userId, user);
        }
        if (!user || !user.isActive) {
            return res.status(401).json({ success: false, message: 'User not found or inactive' });
        }
        // A school switched off mid-session ends that session too — otherwise
        // "no one from this school may sign in" would only hold for new logins
        // and existing tokens would keep working for their whole lifetime.
        // Super admin has no school and is never caught by this.
        if (user.role !== 'super_admin' && user.school && typeof user.school === 'object'
            && user.school.isActive === false) {
            return res.status(403).json({
                success: false,
                code: 'SCHOOL_INACTIVE',
                message: user.role === 'school_admin'
                    ? `${user.school.name || 'Your school'} has been deactivated. Please contact support.`
                    : `${user.school.name || 'Your school'} is currently inactive. Please contact your school administrator.`,
            });
        }
        req.user    = user;
        req.userId  = user._id;
        req.schoolId = user.school?._id || user.school;
        req.userRole = user.role;
        next();
    } catch (err) {
        const message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
        return res.status(401).json({ success: false, message });
    }
};

const requireRole = (...roles) => (req, res, next) => {
    if (!roles.includes(req.userRole)) {
        return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }
    next();
};

const requirePasswordReset = (req, res, next) => {
    if (req.user?.isFirstLogin) {
        return res.status(403).json({
            success: false,
            message: 'Password reset required',
            code: 'PASSWORD_RESET_REQUIRED',
        });
    }
    next();
};

module.exports = { verifyToken, requireRole, requirePasswordReset };
