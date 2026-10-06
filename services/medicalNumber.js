'use strict';
/**
 * Running numbers for the Medical Room's records — MR (request), MV (visit),
 * MI (incident) — per school and month: MV-2610-0042. One counter row per
 * (school, kind, month), incremented in the database, so two requests at the
 * same instant are given two different numbers.
 */
const { query } = require('../db/pool');
const { newId } = require('../db/schema');

const PREFIX = { request: 'MR', visit: 'MV', incident: 'MI', staff_visit: 'SV', safeguarding: 'SG', referral: 'RF', campaign: 'HC', outbreak: 'OB' };

async function next(school, kind, q) {
    const prefix = PREFIX[kind];
    if (!prefix) throw new Error(`Unknown medical record kind "${kind}"`);
    const now = new Date();
    const period = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const run = q || query;
    const { rows } = await run(
        `INSERT INTO "medicalcounters" ("_id","school","kind","period","value","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,1, now(), now())
         ON CONFLICT ("school","kind","period") DO UPDATE
             SET "value" = "medicalcounters"."value" + 1, "updatedAt" = now()
         RETURNING "value"`,
        [newId(), String(school), kind, period],
    );
    return `${prefix}-${period}-${String(rows[0]?.value || 1).padStart(4, '0')}`;
}

module.exports = { next, PREFIX };
