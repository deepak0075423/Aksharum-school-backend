'use strict';
/**
 * Aadhaar and PAN numbers are one person's, so within a school a number is on
 * one record only. The records that carry them:
 *
 *   teacher   TeacherProfile.aadhaarNumber / panNumber
 *   student   StudentProfile.aadhaarNumber            (students have no PAN)
 *   father    ParentProfile.father.aadhaarNumber / panNumber
 *   mother    ParentProfile.mother.…
 *   guardian  ParentProfile.guardian.…
 *
 * Every repeat is refused — teacher vs teacher, a student vs anyone, one parent
 * vs another, father vs mother on the same admission, and a teacher entered
 * again as a parent (the school chose strict: one record per number). The rule
 * is per school: a student transferring to another school on the platform, or a
 * teacher working at two, is registered there without clearing this one.
 *
 * Only numbers a request is SETTING are checked — new, or different from what
 * the record already holds. An edit that re-sends an unchanged number is not
 * blocked by an old duplicate already in the data; that record can still have
 * its phone number corrected.
 */
const pool           = require('../db/pool');
const User           = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');
const StudentProfile = require('../models/StudentProfile');
const ParentProfile  = require('../models/ParentProfile');

const normAadhaar = (v) => String(v ?? '').replace(/\D/g, '');
const normPan     = (v) => String(v ?? '').replace(/\s/g, '').toUpperCase();
const norm        = (type, v) => (type === 'pan' ? normPan(v) : normAadhaar(v));

const TYPE_LABEL  = { aadhaar: 'Aadhaar number', pan: 'PAN number' };
const PARENT_SLOTS = ['father', 'mother', 'guardian'];

const q = (Model) => `"${Model.tableName}"`;

// One row per number on file: which record, which person, which kind of number.
const ON_FILE = (() => {
    const parentRows = PARENT_SLOTS.flatMap((slot) => ['aadhaar', 'pan'].map((type) => {
        const field = type === 'aadhaar' ? 'aadhaarNumber' : 'panNumber';
        const clean = type === 'aadhaar'
            ? `regexp_replace(COALESCE(pp."${slot}"->>'${field}', ''), '\\D', '', 'g')`
            : `upper(regexp_replace(COALESCE(pp."${slot}"->>'${field}', ''), '\\s', '', 'g'))`;
        return `
        SELECT '${slot}' AS kind, pp."_id"::text AS ref, '${type}' AS type, ${clean} AS val,
               COALESCE(NULLIF(pp."${slot}"->>'name', ''), pu."name", '') AS who,
               COALESCE(pu."email", '') AS "heldBy",
               (SELECT string_agg(cu."name", ', ' ORDER BY cu."name")
                  FROM jsonb_array_elements_text(
                           CASE WHEN jsonb_typeof(pp."children") = 'array' THEN pp."children" ELSE '[]'::jsonb END) AS c(id)
                  JOIN ${q(User)} cu ON cu."_id"::text = c.id) AS "childNames"
          FROM ${q(ParentProfile)} pp
          LEFT JOIN ${q(User)} pu ON pu."_id" = pp."user"
         WHERE COALESCE(pp."school", pu."school") = $1`;
    }));
    return [
        `SELECT 'teacher' AS kind, tp."user"::text AS ref, 'aadhaar' AS type,
                regexp_replace(COALESCE(tp."aadhaarNumber", ''), '\\D', '', 'g') AS val, u."name" AS who,
                COALESCE(u."email", '') AS "heldBy", NULL AS "childNames"
           FROM ${q(TeacherProfile)} tp JOIN ${q(User)} u ON u."_id" = tp."user"
          WHERE u."school" = $1`,
        `SELECT 'teacher', tp."user"::text, 'pan',
                upper(regexp_replace(COALESCE(tp."panNumber", ''), '\\s', '', 'g')), u."name", COALESCE(u."email", ''), NULL
           FROM ${q(TeacherProfile)} tp JOIN ${q(User)} u ON u."_id" = tp."user"
          WHERE u."school" = $1`,
        `SELECT 'student', sp."user"::text, 'aadhaar',
                regexp_replace(COALESCE(sp."aadhaarNumber", ''), '\\D', '', 'g'), u."name", COALESCE(u."email", ''), NULL
           FROM ${q(StudentProfile)} sp JOIN ${q(User)} u ON u."_id" = sp."user"
          WHERE u."school" = $1`,
        ...parentRows,
    ].join('\n UNION ALL \n');
})();

const lastFour = (v) => `ending ${String(v).slice(-4)}`;

function describe(row) {
    if (row.kind === 'teacher') return `${row.who || 'a teacher'} (teacher)`;
    if (row.kind === 'student') return `${row.who || 'a student'} (student)`;
    return `${row.who || `a ${row.kind}`} (${row.kind}${row.childNames ? ` of ${row.childNames}` : ' on a parent record'})`;
}

/**
 * @param schoolId
 * @param entries  numbers this request is setting:
 *                 [{ type: 'aadhaar'|'pan', value, label: "Father's Aadhaar number",
 *                    owner: { kind: 'teacher'|'student'|'father'|'mother'|'guardian', ref } }]
 *                 `owner.ref` is the record being written (a user id for teacher and
 *                 student, the ParentProfile id for a parent slot), or null when new.
 * @param peers    numbers elsewhere in the same request that are not being changed
 *                 but must still not be repeated by an entry (e.g. the student's own
 *                 Aadhaar while the parent blocks are being saved).
 * @returns {Promise<string|null>} the refusal message, or null
 */
async function identityClash(schoolId, entries, { peers = [], sameIdentity = '' } = {}) {
    const clean = entries
        .map((e) => ({ ...e, value: norm(e.type, e.value) }))
        .filter((e) => e.value);
    if (!clean.length) return null;

    // Within the request: two people on one form with the same number.
    const all = [...clean, ...peers.map((p) => ({ ...p, value: norm(p.type, p.value) })).filter((p) => p.value)];
    for (let i = 0; i < clean.length; i++) {
        for (let j = 0; j < all.length; j++) {
            if (all[j] === clean[i]) continue;
            if (all[j].type === clean[i].type && all[j].value === clean[i].value) {
                return `${clean[i].label} and ${all[j].label} are the same — each person needs their own ${TYPE_LABEL[clean[i].type]}`;
            }
        }
    }

    // On file. The record-and-slot being overwritten by this very request does
    // not count against itself: its stored value is the one being replaced.
    const replaced = new Set(clean.filter((e) => e.owner?.ref).map((e) => `${e.owner.kind}|${e.owner.ref}|${e.type}`));
    const aadhaars = clean.filter((e) => e.type === 'aadhaar').map((e) => e.value);
    const pans     = clean.filter((e) => e.type === 'pan').map((e) => e.value);

    const { rows } = await pool.query(
        `SELECT * FROM (${ON_FILE}) x
          WHERE x.val <> ''
            AND ((x.type = 'aadhaar' AND x.val = ANY($2::text[])) OR (x.type = 'pan' AND x.val = ANY($3::text[])))`,
        [String(schoolId), aadhaars, pans],
    );
    // One person's own number, on their own other record, is not a repeat.
    //
    // A teacher who is also a parent at the same school holds two records here
    // — a teaching post and a parent account — but one Aadhaar and one PAN. The
    // rule is one number per PERSON per school, and the thing that says two
    // records are one person is the address they sign in with (see
    // services/accountIdentity.js). Without this, the second record could never
    // be created: the school would be told the number belongs to someone else,
    // and that someone else would be them.
    const mine = String(sameIdentity || '').trim().toLowerCase();
    for (const e of clean) {
        const hit = rows.find((r) => r.type === e.type && r.val === e.value
            && !replaced.has(`${r.kind}|${r.ref}|${r.type}`)
            && !(mine && String(r.heldBy || '').toLowerCase() === mine));
        if (hit) return `${e.label} (${lastFour(e.value)}) is already registered to ${describe(hit)} in this school`;
    }
    return null;
}

/** True when `next` would change what `prev` holds — only then is it checked. */
const changed = (type, next, prev) => norm(type, next) !== '' && norm(type, next) !== norm(type, prev);

module.exports = { identityClash, changed, normAadhaar, normPan, TYPE_LABEL, PARENT_SLOTS };
