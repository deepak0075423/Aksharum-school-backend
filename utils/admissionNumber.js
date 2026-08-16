'use strict';
/**
 * Admission numbers follow a per-school template, e.g. "{INITIALS}{YYYY}{####}"
 * → KEHS20260001 for Khalsa English High School in 2026.
 *
 * Tokens
 *   {INITIALS}  first letter of each word of the school name (KEHS)
 *   {CODE}      the school's code
 *   {YYYY}      4-digit year — the active academic year's starting year,
 *               falling back to the current calendar year
 *   {YY}        the same year, 2 digits
 *   {MM}        2-digit month of admission
 *   {DD}        2-digit date of admission
 *   {CLASS}     class name, uppercased without spaces (Class 5 -> CLASS5)
 *   {CLASSNO}   just the class number (Class 5 -> 5; Nursery -> NURSERY)
 *   {####}      running number, zero-padded to the number of #'s (0001…9999)
 *   {SEQ}       running number with no padding
 * Separators such as "/", "-" and spaces — and any other literal text — are
 * copied through as-is.
 *
 * The running number continues per resolved prefix, so a format containing
 * {CLASS} numbers each class separately, and one containing {DD} restarts daily.
 */
const AcademicYear   = require('../models/AcademicYear');
const StudentProfile = require('../models/StudentProfile');

const DEFAULT_FORMAT = '{INITIALS}{YYYY}{####}';
const SEQ_TOKEN = /\{(#+|SEQ)\}/;

const initialsOf = (name) =>
    String(name || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(w => w[0])
        .join('')
        .toUpperCase();

/** Validate a template — it must contain exactly one sequence token. */
function validateFormat(format) {
    const value = String(format || '').trim();
    if (!value) return 'Admission number format is required';
    if (value.length > 40) return 'Admission number format is too long';
    const seqTokens = value.match(/\{(#+|SEQ)\}/g) || [];
    if (seqTokens.length === 0) return 'Format must include a running number — add {####} or {SEQ}';
    if (seqTokens.length > 1)   return 'Format can include only one running number token';
    const unknown = (value.match(/\{[^}]*\}/g) || [])
        .filter(t => !/^\{(INITIALS|CODE|YYYY|YY|MM|DD|CLASS|CLASSNO|#+|SEQ)\}$/.test(t));
    if (unknown.length)
        return `Unknown token ${unknown[0]} — use {INITIALS}, {CODE}, {YYYY}, {YY}, {MM}, {DD}, {CLASS}, {CLASSNO} or {####}`;
    return null;
}

/** Year used by {YYYY}/{YY}: the academic year's start, else this calendar year. */
async function resolveYear(schoolId) {
    try {
        const active = await AcademicYear.findOne({ school: schoolId, status: 'active' }).select('startDate').lean();
        if (active?.startDate) return new Date(active.startDate).getFullYear();
    } catch { /* fall through */ }
    return new Date().getFullYear();
}

/**
 * Split a template into the fixed part before the sequence, the part after it,
 * and how many digits the sequence is padded to.
 */
function parseFormat(format, { school, year, classDoc = null, on = new Date() }) {
    const template = String(format || DEFAULT_FORMAT).trim() || DEFAULT_FORMAT;
    const pad2 = (n) => String(n).padStart(2, '0');
    const className = String(classDoc?.className || '');
    const classSlug = className.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    // The digits in the class name ("Class 5" -> 5). Names without a number
    // ("Nursery") fall back to the name itself rather than the hidden grade
    // value, which means nothing to an admin.
    const classNo = (className.match(/\d+/) || [])[0] || classSlug;

    const fill = (part) => part
        .replace(/\{INITIALS\}/g, initialsOf(school?.name))
        .replace(/\{CODE\}/g, String(school?.code || '').toUpperCase())
        .replace(/\{YYYY\}/g, String(year))
        .replace(/\{YY\}/g, String(year).slice(-2))
        .replace(/\{MM\}/g, pad2(on.getMonth() + 1))
        .replace(/\{DD\}/g, pad2(on.getDate()))
        .replace(/\{CLASS\}/g, classSlug)
        .replace(/\{CLASSNO\}/g, classNo);

    const match = template.match(SEQ_TOKEN);
    if (!match) return { prefix: fill(template), suffix: '', pad: 0 };

    const idx = match.index;
    return {
        prefix: fill(template.slice(0, idx)),
        suffix: fill(template.slice(idx + match[0].length)),
        pad:    match[1] === 'SEQ' ? 0 : match[1].length,
    };
}

const compose = ({ prefix, suffix, pad }, seq) =>
    `${prefix}${String(seq).padStart(pad, '0')}${suffix}`;

/** What the next number would look like — used by the settings preview. */
async function previewAdmissionNumber(format, school, seq = 1, classDoc = null) {
    const year = await resolveYear(school?._id);
    return compose(parseFormat(format, { school, year, classDoc }), seq);
}

/**
 * Next free admission number for a school. Derived from the highest existing
 * number sharing the same prefix, so it stays correct across restarts.
 *
 * @param {Object} school     school document (needs _id, name, code, admissionNumberFormat)
 * @param {Object} [classDoc]  the student's class — only needed for {CLASS}/{CLASSNO}
 * @returns {Promise<String>}
 */
async function nextAdmissionNumber(school, classDoc = null) {
    const year  = await resolveYear(school?._id);
    const parts = parseFormat(school?.admissionNumberFormat || DEFAULT_FORMAT, { school, year, classDoc });

    const existing = await StudentProfile.find(
        { school: school._id, admissionNumber: { $ne: '' } }, 'admissionNumber',
    ).lean();

    const taken = new Set(existing.map(p => String(p.admissionNumber || '')));
    let highest = 0;
    for (const value of taken) {
        if (!value.startsWith(parts.prefix)) continue;
        const middle = parts.suffix
            ? value.slice(parts.prefix.length, value.length - parts.suffix.length)
            : value.slice(parts.prefix.length);
        const n = Number(middle);
        if (Number.isInteger(n) && n > highest) highest = n;
    }

    // Skip over any number already used manually
    let seq = highest + 1;
    let candidate = compose(parts, seq);
    while (taken.has(candidate)) candidate = compose(parts, ++seq);
    return candidate;
}

module.exports = {
    DEFAULT_FORMAT, initialsOf, validateFormat, parseFormat,
    previewAdmissionNumber, nextAdmissionNumber, resolveYear,
};
