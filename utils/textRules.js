'use strict';
/**
 * What a field takes (Oct 2026): English only, never markup, and only the
 * characters its purpose needs. Same rules as the web
 * (school-frontend/src/utils/textRules.js) and the app
 * (Nexora-Hives/utils/textRules.ts), which apply them while a person types —
 * keep the three in sync.
 *
 * Kinds of field:
 *   text     anything written in English — letters A–Z, digits, punctuation
 *            and symbols (₹, °, ·, –, ’ …) — but not another script's letters,
 *            accented letters or another script's digits
 *   name     a person's name: English letters and spaces
 *   letters  English letters and spaces (a relation, a religion, a language)
 *   place    a city, district, state or country: English letters, spaces,
 *            . ' - ( ) and digits ("North 24 Parganas" is a district the PIN
 *            lookup fills in; the screens do not let anyone type digits there)
 *   title    the name of a thing: English letters, digits, spaces and . , - & ' ( ) / + : # %
 *   code     an ID: English letters, digits and - / _ .
 *   upper    capital letters and digits
 *   digits   digits only;  decimal  a number with one decimal point
 *   token    printable English characters without spaces
 *   pincode, aadhaar, pan, ifsc, gstin, account, uan, hsn, otp, date, time — formats
 *
 * Markup is never accepted anywhere: "<" followed by a letter, "/", "!" or "?"
 * is how a browser starts a tag (<script, </b, <!--, <?php), so it is refused
 * before it can be stored and later run.
 */

const MARKUP  = /<(?=[A-Za-z!/?])/;
// A letter, a mark or a digit from outside English. µ stays: it is a unit (µg).
const FOREIGN = /(?![A-Za-zµ])\p{L}|\p{M}|(?![0-9])\p{Nd}/u;
const KINDS = {
    name:    { ok: /^[A-Za-z][A-Za-z ]*$/,            msg: (l) => `${l} can only have English letters and spaces` },
    letters: { ok: /^[A-Za-z][A-Za-z ]*$/,            msg: (l) => `${l} can only have English letters and spaces` },
    place:   { ok: /^[A-Za-z][A-Za-z0-9 .'()-]*$/,    msg: (l) => `${l} can only have English letters, spaces and . ' - ( )` },
    title:   { ok: /^[A-Za-z0-9 .,&'()/+:#%-]+$/,     msg: (l) => `${l} can only have English letters, numbers, spaces and . , - & ' ( ) / + : # %` },
    code:    { ok: /^[A-Za-z0-9/._-]+$/,              msg: (l) => `${l} can only have English letters, numbers and - / _ .` },
    upper:   { ok: /^[A-Z0-9]+$/, upper: true,        msg: (l) => `${l} can only have capital letters and numbers` },
    digits:  { ok: /^[0-9]+$/,                        msg: (l) => `${l} can only have numbers` },
    decimal: { ok: /^(\d+\.?\d*|\.\d+)$/,             msg: (l) => `${l} must be a number` },
    token:   { ok: /^[!-~]+$/,                        msg: (l) => `${l} cannot have spaces` },
    pincode: { ok: /^[1-9]\d{5}$/,                    msg: (l) => `${l} must be a 6-digit PIN code` },
    aadhaar: { ok: /^\d{12}$/,                        msg: (l) => `${l} must be 12 digits` },
    pan:     { ok: /^[A-Z]{5}\d{4}[A-Z]$/, upper: true, msg: (l) => `${l} must be 5 letters, 4 digits and a letter, like ABCDE1234F` },
    ifsc:    { ok: /^[A-Z]{4}0[A-Z0-9]{6}$/, upper: true, msg: (l) => `${l} must be 11 characters, like HDFC0001234` },
    gstin:   { ok: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[A-Z0-9]$/, upper: true, msg: (l) => `${l} must be 15 characters, like 22ABCDE1234F1Z5` },
    account: { ok: /^\d{9,18}$/,                      msg: (l) => `${l} must be 9 to 18 digits` },
    uan:     { ok: /^\d{12}$/,                        msg: (l) => `${l} must be 12 digits` },
    hsn:     { ok: /^(\d{4}|\d{6}|\d{8})$/,           msg: (l) => `${l} must be 4, 6 or 8 digits` },
    otp:     { ok: /^\d{6}$/,                         msg: (l) => `${l} must be 6 digits` },
    date:    { ok: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, msg: (l) => `${l} must be a date as YYYY-MM-DD` },
    time:    { ok: /^([01]\d|2[0-3]):[0-5]\d$/,       msg: (l) => `${l} must be a time as HH:MM` },
};

const hasMarkup = (v) => MARKUP.test(String(v ?? ''));
const foreignChar = (v) => (String(v ?? '').match(FOREIGN) || [null])[0];

/** The first thing wrong with `value` as a field of `kind`, or null. */
function textProblem(value, label = 'This field', kind = 'text') {
    const v = String(value ?? '');
    if (!v.trim()) return null;   // empty is for the field's own "required"
    if (hasMarkup(v)) return `${label} must not contain HTML or script tags`;
    const ch = foreignChar(v);
    if (ch) return `${label} must be in English — "${ch}" is not accepted`;
    const rule = KINDS[kind];
    if (!rule) return null;
    const t = rule.upper ? v.trim().toUpperCase() : v.trim();
    return rule.ok.test(t) ? null : rule.msg(label);
}

/**
 * A person's name, held to the 'name' rule. On an edit pass the stored value
 * as `current`: a name left as it was is not re-judged, so a record saved
 * before the rule can still be edited.
 */
function nameProblem(value, label = 'Name', current) {
    const v = String(value ?? '').trim();
    if (!v || (current !== undefined && current !== null && v === String(current).trim())) return null;
    return textProblem(v, label, 'name');
}

/** For HTML the server writes (emails, receipts, print sheets): text stays text. */
const escapeHtml = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

module.exports = { textProblem, nameProblem, hasMarkup, foreignChar, escapeHtml, MARKUP, FOREIGN, KINDS };
