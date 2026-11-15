'use strict';
/**
 * Two facts about stored documents that were written wrongly, put right once
 * (db/migrate.js runs this from its once-only ledger).
 *
 * 1. DUE DATES. The form sends a day, and it was stored as `new Date('2026-11-20')`
 *    — midnight UTC, 5:30 AM in India. Work was "late" from half past five on
 *    the morning it was due. Every due date sitting exactly on UTC midnight is
 *    moved to the end of that day in the school's own zone, which is what a new
 *    one is stored as now; a submission marked late only because of that
 *    half-past-five cut-off is put back to on time.
 *
 * 2. FILE PATHS. Each file recorded the server's own disk path
 *    (/var/www/…/uploads/documents/x.pdf) and that went out to every reader.
 *    They are rewritten as the address under the server root.
 */
const pool = require('../db/pool');

const FILE_TABLES = ['documents', 'documentversions', 'documentcomments', 'assignmentsubmissions'];

async function run() {
    const zone = process.env.TZ || 'Asia/Kolkata';

    const due = await pool.query(
        `UPDATE "documents"
            SET "dueDate" = ((date_trunc('day', "dueDate" AT TIME ZONE 'UTC') + interval '1 day' - interval '1 millisecond') AT TIME ZONE $1)
          WHERE "dueDate" IS NOT NULL
            AND ("dueDate" AT TIME ZONE 'UTC')::time = time '00:00:00'`,
        [zone],
    );

    const late = await pool.query(
        `UPDATE "assignmentsubmissions" s
            SET "status" = 'submitted'
           FROM "documents" d
          WHERE d."_id" = s."document" AND s."status" = 'late'
            AND d."dueDate" IS NOT NULL AND s."submittedAt" IS NOT NULL
            AND s."submittedAt" <= d."dueDate"`,
    );

    let paths = 0;
    for (const table of FILE_TABLES) {
        const r = await pool.query(
            `UPDATE "${table}" t
                SET "files" = (
                  SELECT jsonb_agg(
                           CASE WHEN COALESCE(x.f->>'storedName', '') <> ''
                                THEN x.f || jsonb_build_object('filePath', 'uploads/documents/' || (x.f->>'storedName'))
                                ELSE x.f END
                           ORDER BY x.ord)
                    FROM jsonb_array_elements(t."files") WITH ORDINALITY x(f, ord))
              WHERE jsonb_typeof(t."files") = 'array' AND jsonb_array_length(t."files") > 0
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(t."files") f
                   WHERE COALESCE(f->>'storedName', '') <> ''
                     AND COALESCE(f->>'filePath', '') NOT LIKE 'uploads/documents/%')`,
        );
        paths += r.rowCount;
    }

    return { due: due.rowCount, late: late.rowCount, paths };
}

module.exports = { run };
