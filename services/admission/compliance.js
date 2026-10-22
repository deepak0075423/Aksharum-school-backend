'use strict';
/**
 * The RTE Act's rule on selection, for a school's admission classes (Oct 2026).
 *
 * Section 13 of the Right of Children to Free and Compulsory Education Act,
 * 2009 forbids any "screening procedure" when admitting a child to elementary
 * education, and section 2(o) defines that as any method of choosing one child
 * over another other than a random one. So for those classes the module allows
 * no entrance test, no interview and no merit list — only a lottery — and an
 * offer by hand only while there is a seat for every waiting applicant.
 *
 * The school's settings (compliance.rte) say which classes the rule covers:
 * Classes 1–8 by number by default, pre-primary classes too where the school
 * says its state extends the rule to them. A school the Act does not bind (a
 * minority institution, for one) can switch it off, saying why — the change is
 * recorded. This is the platform keeping the rule; whether it applies is the
 * school's call, made with its own advice.
 */
const pool = require('../../db/pool');
const { refuse } = require('./util');

// Pre-primary classes are named, not numbered: a class without digits gets
// whatever number is free (controllers/class.controller), so names decide.
// KG1 / KG2 are how some schools name LKG / UKG (utils/classLevels) — `\bkg\b` alone misses them.
const PRE_PRIMARY = /\b(nursery|pre[\s-]?(nursery|primary|school|kg)|play[\s-]?(group|school)|kindergarten|kg|kg[\s-]?[12]|lkg|ukg|jr\.?\s?kg|sr\.?\s?kg|bal[\s-]?vatika)\b/i;

const DEFAULT_RTE = { enabled: true, classNumbers: [1, 2, 3, 4, 5, 6, 7, 8], prePrimary: false, exemptReason: '', exemptNote: '' };

function rteOf(settings) {
    return { ...DEFAULT_RTE, ...(settings?.compliance?.rte || {}) };
}

/** Is choosing between applicants for this class barred? { banned, why } */
function screeningRule(settings, cls) {
    const rte = rteOf(settings);
    if (!rte.enabled || !cls) return { banned: false, why: '' };
    const name = String(cls.className || '');
    const pre = PRE_PRIMARY.test(name);
    if (pre) return rte.prePrimary ? { banned: true, why: `${name} is a pre-primary class the school's RTE setting covers` } : { banned: false, why: '' };
    const n = Number(cls.classNumber);
    if (Number.isFinite(n) && rte.classNumbers.includes(n)) return { banned: true, why: `${name} is an elementary class (RTE Act, s.13)` };
    return { banned: false, why: '' };
}

async function classesOf(classIds) {
    const ids = [...new Set((classIds || []).map(String))];
    if (!ids.length) return [];
    const { rows } = await pool.query(`SELECT "_id", "className", "classNumber" FROM "classes" WHERE "_id" = ANY($1::uuid[])`, [ids]);
    return rows;
}

/** The classes, of these, where screening is barred. */
async function bannedClasses(settings, classIds) {
    const rows = await classesOf(classIds);
    return rows.filter((c) => screeningRule(settings, c).banned);
}

const NAMES = (rows) => rows.map((c) => c.className).join(', ');

/** An entrance test or interview may not select children for these classes. */
async function assertExamAllowed(settings, classIds, mode) {
    const banned = await bannedClasses(settings, classIds);
    if (!banned.length) return;
    const what = mode === 'interview' ? 'an interview' : 'an entrance test';
    refuse(`${NAMES(banned)}: the RTE Act (section 13) does not allow ${what} to choose children for elementary classes. Remove ${banned.length === 1 ? 'the class' : 'these classes'}, or select by a lottery list instead.`, 409,
        { code: 'SCREENING_NOT_ALLOWED', field: 'classes', classes: banned.map((c) => String(c._id)) });
}

/** A list for a barred class must be a lottery. */
async function assertListMethod(settings, classId, method) {
    if (method !== 'merit') return;
    const banned = await bannedClasses(settings, [classId]);
    if (!banned.length) return;
    refuse(`${NAMES(banned)}: the RTE Act allows only a random draw to choose between applicants for this class — make a lottery list.`, 409, { code: 'SCREENING_NOT_ALLOWED', field: 'method' });
}

/**
 * An offer made by hand for a barred class is choosing one child over another
 * — unless every applicant still waiting can have a seat.
 */
async function assertHandOffer(settings, app, seatState, waitingCount) {
    const banned = await bannedClasses(settings, [app.class]);
    if (!banned.length) return;
    if (seatState.available === null || seatState.available >= waitingCount) return;
    refuse(`${NAMES(banned)} has ${waitingCount} applications waiting for ${seatState.available} free seat(s). The RTE Act allows only a random draw to choose between them — make a lottery list for the class.`, 409, { code: 'SCREENING_NOT_ALLOWED' });
}

module.exports = { PRE_PRIMARY, DEFAULT_RTE, rteOf, screeningRule, bannedClasses, assertExamAllowed, assertListMethod, assertHandOffer };
