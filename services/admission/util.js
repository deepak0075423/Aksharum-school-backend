'use strict';
/**
 * Small shared pieces of the admission services: refusals that carry their
 * HTTP status and the field they are about, coercers for configuration
 * values, and the one way every controller answers an error.
 */
const { textProblem } = require('../../utils/textRules');
const { isEmail } = require('../../utils/validators');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUID.test(v);

/** Throw a refusal the controller turns into a 4xx with this message. */
function refuse(message, status = 400, extra = {}) {
    const e = new Error(message);
    e.status = status;
    e.expose = true;
    Object.assign(e, extra);
    throw e;
}

const notFound = (what = 'Record') => refuse(`${what} not found`, 404);

/** The response for an error: a refusal says what it is; anything else is a 500, logged. */
function sendError(res, err, tag = 'admission') {
    if (err && (err.expose || (err.status && err.status < 500))) {
        return res.status(err.status || 400).json({
            success: false, message: err.message,
            ...(err.field ? { field: err.field } : {}),
            ...(err.code && typeof err.code === 'string' ? { code: err.code } : {}),
            ...(err.errors ? { errors: err.errors } : {}),
        });
    }
    if (err && (err.code === 11000 || err.code === '23505')) {
        return res.status(409).json({ success: false, message: 'That already exists — refresh and try again' });
    }
    if (err && err.code === '23503') {
        return res.status(409).json({ success: false, message: 'Something else still refers to this record' });
    }
    console.error(`[${tag}]`, err);
    return res.status(500).json({ success: false, message: 'Something went wrong — please try again' });
}

/** Wrap an async handler so its errors go through sendError. */
const handler = (fn, tag) => async (req, res) => {
    try { await fn(req, res); } catch (err) { sendError(res, err, tag); }
};

// ── Coercers: configuration in, a value of the expected shape out ────────────

const str = (v, max = 200, d = '') => {
    if (v === undefined || v === null) return d;
    return String(v).trim().slice(0, max);
};
const bool = (v, d = false) => (v === undefined || v === null ? d : v === true || v === 'true' || v === 1 || v === '1');
const num = (v, { min = -Infinity, max = Infinity, d = null, int = false } = {}) => {
    if (v === undefined || v === null || v === '') return d;
    let n = Number(v);
    if (!Number.isFinite(n)) return d;
    if (int) n = Math.round(n);
    return Math.min(max, Math.max(min, n));
};
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(String).filter(isId))];
const date = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};
const HEX = /^#[0-9a-f]{6}$/i;
const color = (v, d) => (HEX.test(String(v || '')) ? String(v).toLowerCase() : d);
const httpUrl = (v) => {
    const s = String(v || '').trim();
    if (!s) return '';
    return /^https?:\/\/[^\s<>"']+$/i.test(s) ? s.slice(0, 300) : null;
};

/** Text a person typed into configuration: refused when it breaks the platform's text rules. */
function text(v, label, { max = 200, kind = 'text', required = false, field = null } = {}) {
    const s = str(v, 100000);
    if (!s) {
        if (required) refuse(`${label} is required`, 400, { field });
        return '';
    }
    if (s.length > max) refuse(`${label} must be at most ${max} characters`, 400, { field });
    const bad = textProblem(s, label, kind);
    if (bad) refuse(bad, 400, { field });
    return s;
}

function emailOrBlank(v, label, field = null) {
    const s = str(v, 200).toLowerCase();
    if (!s) return '';
    if (!isEmail(s)) refuse(`${label} must be a valid email address`, 400, { field });
    return s;
}

/** A Date as the YYYY-MM-DD the school's calendar means. */
const dayKey = (d) => {
    if (!d) return '';
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

module.exports = {
    UUID, isId, refuse, notFound, sendError, handler,
    str, bool, num, oneOf, ids, date, color, httpUrl, text, emailOrBlank, dayKey, round2,
};
