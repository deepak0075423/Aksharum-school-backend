'use strict';
// Shared request-body validation helpers.
//
// Field checks return booleans. `validate(body, rules)` runs a rule map
// against a request body and returns the first error message, or null when
// the body is valid — mirroring the `_validateSchool`-style helpers already
// used in controllers:
//
//   const err = validate(req.body, {
//       name:  { label: 'Name', required: true, minLen: 2 },
//       email: { label: 'Email', required: true, type: 'email' },
//       phone: { label: 'Phone', type: 'phone' },            // optional field
//       role:  { label: 'Role', required: true, enum: ['teacher', 'student'] },
//       amount:{ label: 'Amount', required: true, type: 'number', min: 0 },
//   });
//   if (err) return res.status(400).json({ success: false, message: err });

// Phone numbers are Indian mobile numbers — the platform is India-only: ten
// digits, the first 6–9, stored without +91 or a leading 0. normalizePhone()
// drops the formatting a person, an older app or an imported sheet may send
// ("+91 98765 43210", "098765-43210", the number 9876543210), so the number
// itself is what is checked and stored. Anything else in it (a letter, an
// extension) is left alone for isPhone to refuse — never silently cut down.
const PHONE_LENGTH = 10;
const normalizePhone = (v) => {
    const s = String(v ?? '').trim();
    if (!/^[\d\s\-().+]+$/.test(s) || s.split('+').length > 2) return s;
    const d = s.replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) return d.slice(2);
    if (d.length === 11 && d.startsWith('0')) return d.slice(1);
    return d;
};

const isEmail    = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? '').trim());
const isPhone    = (v) => /^[6-9]\d{9}$/.test(normalizePhone(v));
const isURL      = (v) => /^https?:\/\/.+\..+/.test(String(v ?? '').trim());
const isPincode  = (v) => /^\d{4,10}$/.test(String(v ?? '').trim());
const isObjectId = (v) => /^[0-9a-fA-F]{24}$/.test(String(v ?? ''));
const isDate     = (v) => !Number.isNaN(new Date(v).getTime());
const isTime     = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? '').trim());

const TYPE_CHECKS = {
    email:    { check: isEmail,    msg: (l) => `${l} must be a valid email address` },
    phone:    { check: isPhone,    msg: (l) => `${l} must be a valid 10-digit mobile number` },
    name:     { check: (v) => /^[A-Za-z][A-Za-z .'-]*$/.test(String(v).trim()), msg: (l) => `${l} can only have English letters, spaces and . ' -` },
    url:      { check: isURL,      msg: (l) => `${l} must be a valid URL starting with http:// or https://` },
    pincode:  { check: isPincode,  msg: (l) => `${l} must be 4-10 digits` },
    objectId: { check: isObjectId, msg: (l) => `${l} is not a valid id` },
    date:     { check: isDate,     msg: (l) => `${l} must be a valid date` },
    time:     { check: isTime,     msg: (l) => `${l} must be a valid time (HH:MM)` },
    number:   { check: (v) => !Number.isNaN(Number(v)) && String(v).trim() !== '', msg: (l) => `${l} must be a number` },
};

/**
 * @param {object} body  request body
 * @param {object} rules { field: { label, required, type, enum, min, max, minLen, maxLen, regex, regexMsg } }
 * @returns {string|null} first error message, or null when valid
 */
const validate = (body = {}, rules = {}) => {
    for (const [field, rule] of Object.entries(rules)) {
        const label = rule.label || field;
        const raw   = body[field];
        const empty = raw === undefined || raw === null || String(raw).trim() === '';

        if (empty) {
            if (rule.required) return `${label} is required`;
            continue;                                   // optional + empty → skip remaining checks
        }
        const val = typeof raw === 'string' ? raw.trim() : raw;

        if (rule.type && TYPE_CHECKS[rule.type] && !TYPE_CHECKS[rule.type].check(val))
            return TYPE_CHECKS[rule.type].msg(label);
        if (rule.enum && !rule.enum.includes(val))
            return `${label} must be one of: ${rule.enum.join(', ')}`;
        if (rule.minLen !== undefined && String(val).length < rule.minLen)
            return `${label} must be at least ${rule.minLen} characters`;
        if (rule.maxLen !== undefined && String(val).length > rule.maxLen)
            return `${label} must be at most ${rule.maxLen} characters`;
        if (rule.min !== undefined && Number(val) < rule.min)
            return `${label} must be at least ${rule.min}`;
        if (rule.max !== undefined && Number(val) > rule.max)
            return `${label} must be at most ${rule.max}`;
        if (rule.regex && !rule.regex.test(String(val)))
            return rule.regexMsg || `${label} has an invalid format`;
    }
    return null;
};

// Password strength shared by auth + user management: 8+ chars with letters and digits.
const passwordError = (pw) => {
    const v = String(pw ?? '');
    if (v.length < 8) return 'Password must be at least 8 characters';
    if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return 'Password must contain both letters and numbers';
    return null;
};

/** The message for one phone field, or null when it is fine (or empty and optional). */
const phoneError = (v, label = 'Mobile number', { required = false } = {}) => {
    if (!String(v ?? '').trim()) return required ? `${label} is required` : null;
    return isPhone(v) ? null : `${label} must be a valid 10-digit mobile number`;
};

module.exports = { validate, passwordError, isEmail, isPhone, normalizePhone, phoneError, PHONE_LENGTH, isURL, isPincode, isObjectId, isDate, isTime };
