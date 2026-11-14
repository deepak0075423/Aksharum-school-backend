'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Build (or repair) StudentEnrollment from what the school already holds.
//
//  Runs once at boot through the datamigrations ledger, and is safe to run
//  again for one school as a repair. Every step is idempotent.
//
//  Where the old data disagreed with itself, this is the order of trust:
//    1. section rosters — they carry the year (a section belongs to one), and
//       they are the only record of years that have ended;
//       a student on two rosters of the same year keeps the section their
//       profile points at, else the newer section;
//    2. the profile's pointer — for a placement no roster lists (the profile
//       said "Class 8-A" while 8-A's roster did not), or a class with no
//       section yet; it never overrides a year the rosters already settled;
//    3. the rosters are then rewritten from the rows, so each lists exactly
//       the students placed in it (same-year duplicates and ids that are not
//       students of the school drop out), and every pointer is recomputed.
// ─────────────────────────────────────────────────────────────────────────────
const { withTransaction } = require('./dbTx');
const { refreshPointers, T } = require('./enrollment');
const User = require('../models/User');

const U = `"${User.tableName}"`;
const ARR = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;

async function reconcile({ schoolId = null } = {}) {
    const scope = schoolId ? `AND cs."school" = $1::uuid` : '';
    const scopeP = schoolId ? `AND u."school" = $1::uuid` : '';
    const args = schoolId ? [String(schoolId)] : [];

    return withTransaction(async (q) => {
        // One run at a time, across servers.
        await q(`SELECT pg_advisory_xact_lock(hashtext('enrollment:reconcile')::bigint)`);

        // 1. From the rosters.
        const fromRosters = await q(
            `INSERT INTO ${T.enr} ("_id", "school", "student", "academicYear", "class", "section", "rollNumber", "source", "createdAt", "updatedAt")
             SELECT DISTINCT ON (r."student", r."year")
                    gen_random_uuid(), r."school", r."student", r."year", r."class", r."section", r."roll", 'backfill', now(), now()
               FROM (
                    SELECT cs."school", u."_id" AS "student", cs."academicYear" AS "year", cs."class", cs."_id" AS "section",
                           CASE WHEN sp."currentSection" = cs."_id" THEN COALESCE(sp."rollNumber", '') ELSE '' END AS "roll",
                           (sp."currentSection" = cs."_id") AS "pointed", cs."createdAt"
                      FROM ${T.sec} cs
                     CROSS JOIN LATERAL jsonb_array_elements_text(${ARR('cs."enrolledStudents"')}) AS e(v)
                      JOIN ${U} u ON u."_id"::text = e.v AND u."role" = 'student' AND u."school" = cs."school"
                      LEFT JOIN ${T.prof} sp ON sp."user" = u."_id"
                     WHERE cs."academicYear" IS NOT NULL AND cs."class" IS NOT NULL ${scope}
               ) r
              ORDER BY r."student", r."year", r."pointed" DESC NULLS LAST, r."createdAt" DESC NULLS LAST
             ON CONFLICT ("student", "academicYear") DO NOTHING`,
            args,
        );

        // 2. From the profile's pointer, for a year no roster settled.
        const fromProfiles = await q(
            `INSERT INTO ${T.enr} ("_id", "school", "student", "academicYear", "class", "section", "rollNumber", "source", "createdAt", "updatedAt")
             SELECT gen_random_uuid(), u."school", u."_id", c."academicYear", c."_id", s."_id",
                    CASE WHEN s."_id" IS NOT NULL THEN COALESCE(sp."rollNumber", '') ELSE '' END,
                    'backfill', now(), now()
               FROM ${T.prof} sp
               JOIN ${U} u ON u."_id" = sp."user" AND u."role" = 'student'
               LEFT JOIN ${T.sec} ps ON ps."_id" = sp."currentSection" AND ps."school" = u."school"
               JOIN ${T.cls} c ON c."_id" = COALESCE(ps."class", sp."currentClass") AND c."school" = u."school"
               LEFT JOIN ${T.sec} s ON s."_id" = ps."_id" AND s."class" = c."_id"
              WHERE c."academicYear" IS NOT NULL ${scopeP}
             ON CONFLICT ("student", "academicYear") DO NOTHING`,
            args,
        );

        // 3a. Rosters list exactly their rows, in the order they had.
        const rosters = await q(
            `WITH want AS (
                SELECT cs."_id",
                       COALESCE((SELECT jsonb_agg(x.v ORDER BY x.o)
                                   FROM jsonb_array_elements_text(${ARR('cs."enrolledStudents"')}) WITH ORDINALITY AS x(v, o)
                                  WHERE EXISTS (SELECT 1 FROM ${T.enr} e WHERE e."section" = cs."_id" AND e."student"::text = x.v)), '[]'::jsonb)
                       || COALESCE((SELECT jsonb_agg(e."student"::text ORDER BY e."createdAt")
                                      FROM ${T.enr} e
                                     WHERE e."section" = cs."_id"
                                       AND NOT (${ARR('cs."enrolledStudents"')} ? e."student"::text)), '[]'::jsonb) AS "list"
                  FROM ${T.sec} cs
                 WHERE true ${scope}
             )
             UPDATE ${T.sec} cs
                SET "enrolledStudents" = want."list", "currentCount" = jsonb_array_length(want."list")
               FROM want
              WHERE want."_id" = cs."_id"
                AND (cs."enrolledStudents" IS DISTINCT FROM want."list" OR cs."currentCount" IS DISTINCT FROM jsonb_array_length(want."list"))`,
            args,
        );

        // 3b. Every pointer from the rows, school by school.
        const schools = schoolId ? [String(schoolId)]
            : (await q(`SELECT DISTINCT "school" FROM ${T.prof} WHERE "school" IS NOT NULL`)).rows.map((r) => String(r.school));
        let moved = 0;
        for (const s of schools) moved += await refreshPointers(q, { schoolId: s });

        return {
            fromRosters: fromRosters.rowCount,
            fromProfiles: fromProfiles.rowCount,
            rostersRewritten: rosters.rowCount,
            pointersMoved: moved,
        };
    });
}

module.exports = { reconcile };
