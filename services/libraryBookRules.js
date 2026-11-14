'use strict';
/**
 * What a book and its copies may hold — one set of rules for every way a book
 * reaches the catalogue: the Add/Edit Book form, Add Copies, editing a copy,
 * and the Excel upload. The web form mirrors these
 * (pages/library/librarian/bookRules.js); keep the two in step.
 *
 * Each check returns { field, message } for the first problem, so the form can
 * put the message under the field it is about.
 */
const { normIsbn } = require('./libraryRules');

// A person's name, English: starts with a letter, letters / spaces / . ' -
// inside ("J.K. Rowling", "O'Brien", "Jean-Paul Sartre"). No digits.
const AUTHOR_RX   = /^[A-Za-z](?:[A-Za-z .'-]*[A-Za-z.])?$/;
// A name of a thing (publisher, category, tag, vendor): letters, digits and
// ordinary punctuation, starting with a letter or digit.
const THING_RX    = /^[A-Za-z0-9][A-Za-z0-9 .,&'()/+:#%-]*$/;
const LETTERS_RX  = /^[A-Za-z][A-Za-z ]*$/;
const CODE_RX     = /^[A-Za-z0-9][A-Za-z0-9 /._#-]*$/;
const CONDITIONS  = ['new', 'good', 'fair', 'damaged'];
const MAX_AUTHORS = 10;
const MAX_COST    = 1000000;

const fail = (field, message) => ({ error: message, field });
const str  = (v) => (v === undefined || v === null ? '' : String(v)).trim();

/** ISBN-10 (last may be X) or ISBN-13, with its check digit. */
function isbnProblem(raw) {
    const v = str(raw);
    if (!v) return null;
    if (/^[-+]/.test(v) || /[^0-9Xx\s-]/.test(v))
        return 'ISBN can only have digits, hyphens and spaces (an ISBN-10 may end in X) — no minus sign';
    const d = normIsbn(v);
    if (d.length !== 10 && d.length !== 13) return `ISBN must be 10 or 13 digits — ${d.length} given`;
    if (d.length === 13) {
        if (/X/.test(d)) return 'An ISBN-13 has digits only';
        const sum = [...d].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0);
        if (sum % 10) return 'That ISBN-13 is not valid — check the digits (the last one is a check digit)';
    } else {
        if (/X/.test(d.slice(0, 9))) return 'Only the last character of an ISBN-10 can be X';
        const sum = [...d].reduce((n, c, i) => n + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
        if (sum % 11) return 'That ISBN-10 is not valid — check the digits (the last one is a check digit)';
    }
    return null;
}

/** "3", "3rd", "3rd edition" → "3"; anything else (0, negative, words) is refused. */
function editionOf(raw) {
    const v = str(raw);
    if (!v) return { value: '' };
    const m = v.match(/^(\d{1,3})(?:\s*(?:st|nd|rd|th))?(?:\s*ed(?:ition)?\.?)?$/i);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 999)
        return fail('edition', 'Edition must be a whole number from 1 to 999 (e.g. 3 for the 3rd edition)');
    return { value: String(Number(m[1])) };
}

function authorsOf(raw) {
    const list = (Array.isArray(raw) ? raw : str(raw).split(','))
        .map((a) => str(a).replace(/\s+/g, ' ')).filter(Boolean);
    if (list.length > MAX_AUTHORS) return fail('authors', `Up to ${MAX_AUTHORS} authors`);
    for (const a of list) {
        if (a.length < 2 || a.length > 100) return fail('authors', `"${a.slice(0, 30)}" — an author's name must be 2 to 100 characters`);
        if (!AUTHOR_RX.test(a))
            return fail('authors', `"${a.slice(0, 30)}" — author names can only have letters, spaces and . ' - (no numbers or symbols)`);
    }
    return { value: list };
}

const optional = (v, field, label, max, rx, how) => {
    const s = str(v);
    if (!s) return { value: '' };
    if (s.length > max) return fail(field, `${label} is too long (max ${max} characters)`);
    if (rx && !rx.test(s)) return fail(field, `${label} ${how}`);
    return { value: s };
};

/**
 * The catalogue record. `partial` (an edit) checks only what was sent;
 * `old` lets an unchanged legacy ISBN through so an edit to anything else is
 * never blocked by data entered before these rules.
 * @returns {{ value } | { error, field }}
 */
function checkBook(body = {}, { partial = false, old = null } = {}) {
    const out = {};
    const sent = (k) => body[k] !== undefined;

    if (!partial || sent('title')) {
        const t = str(body.title);
        if (!t) return fail('title', 'Title is required');
        if (t.length > 300) return fail('title', 'Title is too long (max 300 characters)');
        if (!/[A-Za-z0-9]/.test(t)) return fail('title', 'Title must have letters or numbers');
        out.title = t;
    }
    if (sent('authors')) {
        const r = authorsOf(body.authors); if (r.error) return r; out.authors = r.value;
    }
    if (sent('isbn')) {
        const v = str(body.isbn);
        const unchanged = old && normIsbn(old.isbn) === normIsbn(v);
        const why = unchanged ? null : isbnProblem(v);
        if (why) return fail('isbn', why);
        out.isbn = v;
    }
    if (sent('publisher')) {
        const r = optional(body.publisher, 'publisher', 'Publisher', 150, THING_RX, 'can only have letters, numbers and . , & \' ( ) / -');
        if (r.error) return r; out.publisher = r.value;
    }
    if (sent('category')) {
        const r = optional(body.category, 'category', 'Category', 60, THING_RX, 'can only have letters, numbers and . , & \' ( ) / -');
        if (r.error) return r; out.category = r.value;
    }
    if (sent('language')) {
        const r = optional(body.language, 'language', 'Language', 40, LETTERS_RX, 'can only have letters and spaces');
        if (r.error) return r; out.language = r.value || 'English';
    }
    if (sent('edition')) {
        const r = editionOf(body.edition); if (r.error) return r; out.edition = r.value;
    }
    if (sent('description')) {
        const d = str(body.description);
        if (d.length > 1000) return fail('description', 'Description is too long (max 1000 characters)');
        out.description = d;
    }
    if (sent('publishedYear')) {
        const y = body.publishedYear;
        if (y === '' || y === null) out.publishedYear = null;
        else {
            const n = Number(y);
            const max = new Date().getFullYear();
            if (!Number.isInteger(n) || n < 1450 || n > max)
                return fail('publishedYear', `Publication year must be a whole year from 1450 to ${max} — not in the future`);
            out.publishedYear = n;
        }
    }
    if (sent('pages')) {
        const p = body.pages;
        if (p === '' || p === null) out.pages = null;
        else {
            const n = Number(p);
            if (!Number.isInteger(n) || n < 1 || n > 20000)
                return fail('pages', 'Number of pages must be a whole number from 1 to 20000');
            out.pages = n;
        }
    }
    if (sent('subjects')) {
        const list = (Array.isArray(body.subjects) ? body.subjects : str(body.subjects).split(','))
            .map((t) => str(t)).filter(Boolean);
        const uniq = [...new Set(list)];
        if (uniq.length > 20) return fail('subjects', 'Up to 20 subjects / tags');
        const bad = uniq.find((t) => t.length > 40 || !THING_RX.test(t));
        if (bad) return fail('subjects', `"${bad.slice(0, 30)}" — a tag can be up to 40 letters, numbers and . , & ' ( ) / -`);
        out.subjects = uniq;
    }
    return { value: out };
}

/** A copy's acquisition details (Add Book with copies, Add Copies, edit a copy). */
function checkCopy(body = {}) {
    const out = {};
    const sent = (k) => body[k] !== undefined && body[k] !== null;
    if (sent('condition') && body.condition !== '') {
        if (!CONDITIONS.includes(body.condition)) return fail('condition', `Condition must be one of: ${CONDITIONS.join(', ')}`);
        out.condition = body.condition;
    }
    if (sent('rackLocation')) {
        const r = optional(body.rackLocation, 'rackLocation', 'Rack', 30, CODE_RX, 'can only have letters, numbers and - / _ . #');
        if (r.error) return r; out.rackLocation = r.value;
    }
    if (sent('vendor')) {
        const v = str(body.vendor);
        if (v) {
            if (v.length < 2 || v.length > 100) return fail('vendor', 'Vendor must be 2 to 100 characters');
            if (!/^[A-Za-z]/.test(v)) return fail('vendor', 'Vendor must start with a letter');
            if (!THING_RX.test(v)) return fail('vendor', 'Vendor can only have letters, numbers and . , & \' ( ) / -');
            if ((v.match(/[A-Za-z]/g) || []).length < 2) return fail('vendor', 'Enter the vendor\'s name');
        }
        out.vendor = v;
    }
    if (sent('billNumber')) {
        const r = optional(body.billNumber, 'billNumber', 'Bill number', 40, CODE_RX, 'can only have letters, numbers and - / _ . #');
        if (r.error) return r; out.billNumber = r.value;
    }
    if (sent('acquisitionDate')) {
        const s = str(body.acquisitionDate);
        if (!s) out.acquisitionDate = null;
        else {
            const d = new Date(s);
            if (Number.isNaN(d.getTime())) return fail('acquisitionDate', 'Acquired on is not a valid date');
            const today = new Date(); today.setHours(23, 59, 59, 999);
            if (d > today) return fail('acquisitionDate', 'Acquired on cannot be in the future');
            if (d.getFullYear() < 1900) return fail('acquisitionDate', 'Acquired on is too far in the past');
            out.acquisitionDate = s;
        }
    }
    if (sent('cost') && body.cost !== '') {
        const n = Number(body.cost);
        if (!Number.isFinite(n) || n < 0) return fail('cost', 'Cost must be zero or more — not negative');
        if (n > MAX_COST) return fail('cost', `Cost per copy cannot be more than ₹${MAX_COST.toLocaleString('en-IN')}`);
        if (Math.round(n * 100) !== n * 100) return fail('cost', 'Cost can have at most 2 decimal places');
        out.cost = n;
    }
    return { value: out };
}

/** 400 with the field the message is about. */
const refuse = (res, r) => res.status(400).json({ success: false, message: r.error, field: r.field });

module.exports = { checkBook, checkCopy, isbnProblem, editionOf, authorsOf, refuse, AUTHOR_RX };
