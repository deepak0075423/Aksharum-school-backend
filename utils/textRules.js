'use strict';
/**
 * What text a field takes (Oct 2026): English only, and never markup.
 * Same rules as the web (school-frontend/src/utils/textRules.js) and the app
 * (Nexora-Hives/utils/textRules.ts), which apply them while a person types.
 *
 * Kinds of field:
 *   text     anything written in English — letters A–Z, digits, punctuation
 *            and symbols (₹, °, ·, –, ’ …) — but not another script's letters,
 *            accented letters or another script's digits
 *   name     a person or a place: English letters, spaces and . ' -
 *   letters  English letters and spaces only
 *
 * Markup is never accepted anywhere: "<" followed by a letter, "/", "!" or "?"
 * is how a browser starts a tag (<script, </b, <!--, <?php), so it is refused
 * before it can be stored and later run.
 */

const MARKUP  = /<(?=[A-Za-z!/?])/;
// A letter, a mark or a digit from outside English. µ stays: it is a unit (µg).
const FOREIGN = /(?![A-Za-zµ])\p{L}|\p{M}|(?![0-9])\p{Nd}/u;
const KINDS = {
    name:    { ok: /^[A-Za-z][A-Za-z .'-]*$/, msg: (l) => `${l} can only have English letters, spaces and . ' -` },
    letters: { ok: /^[A-Za-z ]*$/,    msg: (l) => `${l} can only have English letters and spaces` },
};

const hasMarkup = (v) => MARKUP.test(String(v ?? ''));
const foreignChar = (v) => (String(v ?? '').match(FOREIGN) || [null])[0];

/** The first thing wrong with `value` as a field of `kind`, or null. */
function textProblem(value, label = 'This field', kind = 'text') {
    const v = String(value ?? '');
    if (!v) return null;
    if (hasMarkup(v)) return `${label} must not contain HTML or script tags`;
    const ch = foreignChar(v);
    if (ch) return `${label} must be in English — "${ch}" is not accepted`;
    const rule = KINDS[kind];
    if (rule && !rule.ok.test(v.trim())) return rule.msg(label);
    return null;
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

module.exports = { textProblem, nameProblem, hasMarkup, foreignChar, escapeHtml, MARKUP, FOREIGN };
