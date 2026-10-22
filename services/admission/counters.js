'use strict';
/**
 * Running numbers for admissions: application numbers, receipts, admit-card
 * roll numbers, offer letters.
 *
 * A number is a template the school chooses — "APP{YYYY}{#####}" gives
 * APP202700042 — and the running part continues per resolved prefix, so a new
 * academic year (or a template with {CLASS}) starts again at 1 without anyone
 * resetting anything. The counter row is advanced in ONE statement, so two
 * submissions arriving together can never be given the same number.
 *
 * Tokens: {INITIALS} {CODE} {YYYY} {YY} {MM} {DD} {CLASS} {CLASSNO}
 *         {####} (padded to the number of #) or {SEQ} (unpadded) — exactly one.
 */
const classLevels = require('../../utils/classLevels');
const pool = require('../../db/pool');
const AdmissionCounter = require('../../models/AdmissionCounter');

const TOKENS = ['INITIALS', 'CODE', 'YYYY', 'YY', 'MM', 'DD', 'CLASS', 'CLASSNO'];
const SEQ = /\{(#+|SEQ)\}/;

const initialsOf = (name) => String(name || '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase();

/** The first problem with a number template, or null. */
function templateProblem(template, label = 'Number format') {
    const t = String(template || '').trim();
    if (!t) return `${label} is required`;
    if (t.length > 40) return `${label} must be at most 40 characters`;
    const seqs = t.match(/\{(#+|SEQ)\}/g) || [];
    if (seqs.length !== 1) return `${label} must contain exactly one running number — {####} or {SEQ}`;
    const unknown = (t.match(/\{[^}]*\}/g) || []).filter((tok) => !SEQ.test(tok) && !TOKENS.includes(tok.slice(1, -1)));
    if (unknown.length) return `${label}: unknown token ${unknown[0]} — use {INITIALS}, {CODE}, {YYYY}, {YY}, {MM}, {DD}, {CLASS}, {CLASSNO} and one {####}`;
    const literal = t.replace(/\{[^}]*\}/g, '');
    if (!/^[A-Za-z0-9/_ -]*$/.test(literal)) return `${label} can only add letters, digits, spaces and - / _ around its tokens`;
    return null;
}

/** Split a template into the fixed text before and after its running number. */
function parts(template, { school = null, year = null, classDoc = null, on = new Date() } = {}) {
    const pad2 = (n) => String(n).padStart(2, '0');
    const y = year || on.getFullYear();
    const className = String(classDoc?.className || '');
    const classSlug = className.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    // A pre-primary class's number is 0 or below (utils/classLevels) — no use in
    // an application number, and "KG1"'s digit would read as Class 1 — so it
    // goes by its short name: NUR, LKG, KG1, PG.
    const n = Number(classDoc?.classNumber);
    const classNo = classDoc && Number.isInteger(n) && n < 1 && classLevels.levelOf(n)
        ? classLevels.shortOf(classDoc).replace(/[^A-Za-z0-9]/g, '').toUpperCase()
        : (className.match(/\d+/) || [])[0] || (classDoc?.classNumber != null ? String(classDoc.classNumber) : classSlug);
    const fill = (s) => s
        .replace(/\{INITIALS\}/g, initialsOf(school?.name))
        .replace(/\{CODE\}/g, String(school?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''))
        .replace(/\{YYYY\}/g, String(y))
        .replace(/\{YY\}/g, String(y).slice(-2))
        .replace(/\{MM\}/g, pad2(on.getMonth() + 1))
        .replace(/\{DD\}/g, pad2(on.getDate()))
        .replace(/\{CLASSNO\}/g, classNo)
        .replace(/\{CLASS\}/g, classSlug);
    const t = String(template || '');
    const m = t.match(SEQ);
    if (!m) return { prefix: fill(t), suffix: '', pad: 0 };
    return { prefix: fill(t.slice(0, m.index)), suffix: fill(t.slice(m.index + m[0].length)), pad: m[1] === 'SEQ' ? 0 : m[1].length };
}

/** Advance (school, key) and return the new value — atomic, on `q` when inside a transaction. */
async function advance(schoolId, key, q = null) {
    const run = q || ((sql, p) => pool.query(sql, p));
    const T = `"${AdmissionCounter.tableName}"`;
    const { rows } = await run(
        `INSERT INTO ${T} ("_id", "school", "key", "value") VALUES (gen_random_uuid(), $1::uuid, $2, 1)
         ON CONFLICT ("school", "key") DO UPDATE SET "value" = ${T}."value" + 1
         RETURNING "value"`,
        [String(schoolId), String(key)],
    );
    return Number(rows[0].value);
}

/**
 * The next number for `kind` ('application', 'receipt', 'admitCard', 'offer')
 * from `template`. The counter key is the kind plus the resolved prefix, so
 * each prefix runs on its own.
 */
async function nextNumber(schoolId, kind, template, ctx = {}, q = null) {
    const p = parts(template, ctx);
    const seq = await advance(schoolId, `${kind}:${p.prefix}|${p.suffix}`, q);
    return `${p.prefix}${String(seq).padStart(p.pad, '0')}${p.suffix}`;
}

/** What a template produces for the first number — for the settings preview. */
function preview(template, ctx = {}, seq = 1) {
    const p = parts(template, ctx);
    return `${p.prefix}${String(seq).padStart(p.pad, '0')}${p.suffix}`;
}

module.exports = { templateProblem, parts, advance, nextNumber, preview, initialsOf };
