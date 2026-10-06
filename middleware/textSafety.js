'use strict';
/**
 * Every text a request carries: English, and never markup (utils/textRules).
 *
 * Applied to every request body, the way phone numbers are (middleware/
 * phoneFields): after the JSON and form parsers (server.js), and after multer
 * for a multipart form (middleware/upload.js). A field that breaks a rule is
 * refused with a 400 that names it — nothing is silently changed:
 *
 *   markup     "<script>", "<img onerror=…>", "</b>", "<!--" — anywhere
 *   English    another script's letters, accented letters or digits — except
 *              where a field is meant to hold them (a notice written in Hindi
 *              on purpose, `…Hi`) and in chat, which is free conversation
 *
 * Not checked: passwords and one-time codes (never shown, and any character
 * is allowed in them), sign-in tokens, base64 image data: URLs (not text), and
 * the gateway's /internal calls. Per-field rules (a person's name is letters
 * only, …) are the handlers' — this is the floor under every field.
 */
const { hasMarkup, foreignChar } = require('../utils/textRules');

const SKIP = new Set([
    'password', 'newPassword', 'currentPassword', 'confirmPassword', 'oldPassword', 'otp', 'code_verifier',
    'token', 'refreshToken', 'idToken', 'credential', 'accessToken', 'razorpay_signature',
]);
const NATIVE = /[a-z]Hi$/;          // a field written in Hindi on purpose (Medical Room notices: textHi)
const MAX_DEPTH = 8;

const LABELS = { csv: 'The file' };
const labelOf = (key) => {
    if (LABELS[key]) return LABELS[key];
    const words = String(key || 'This field').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : 'This field';
};

/** The first refusal in `node`, or null. `english` is false where any language is allowed. */
function checkText(node, { english = true } = {}, key = null, depth = 0) {
    if (node === null || node === undefined || depth > MAX_DEPTH) return null;
    if (typeof node === 'string') {
        if (key && SKIP.has(key)) return null;
        if (/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*$/i.test(node)) return null;   // an image, not text
        if (hasMarkup(node)) return `${labelOf(key)} must not contain HTML or script tags`;
        if (english && !(key && NATIVE.test(key))) {
            const ch = foreignChar(node);
            if (ch) return `${labelOf(key)} must be in English — "${ch}" is not accepted`;
        }
        return null;
    }
    if (Array.isArray(node)) {
        for (const x of node) { const bad = checkText(x, { english }, key, depth + 1); if (bad) return bad; }
        return null;
    }
    if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (SKIP.has(k)) continue;
            const bad = checkText(v, { english }, k, depth + 1);
            if (bad) return bad;
        }
    }
    return null;
}

const optionsFor = (req) => ({ english: !/^\/api\/chat(\/|$)/.test(req.originalUrl || '') });
const exempt = (req) => /^\/internal(\/|$)/.test(req.originalUrl || '');

function textSafety(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || exempt(req)) return next();
    const bad = checkText(req.body, optionsFor(req));
    if (bad) return res.status(400).json({ success: false, message: bad, code: 'INVALID_TEXT' });
    return next();
}

/**
 * An imported sheet's rows are not a request body, so they are checked here:
 * the first problem as "Row 7: Full name must be in English …", or null.
 * Row 1 is the sheet's header, so the first data row is 2.
 */
function sheetTextProblem(rows = [], { firstRow = 2 } = {}) {
    for (let i = 0; i < rows.length; i++) {
        const bad = checkText(rows[i]);
        if (bad) return `Row ${i + firstRow}: ${bad}`;
    }
    return null;
}

module.exports = { textSafety, checkText, sheetTextProblem, textOptionsFor: optionsFor, textExempt: exempt };
