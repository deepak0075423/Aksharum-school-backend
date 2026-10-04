'use strict';
/**
 * Schema changes that syncAll() cannot make on its own.
 *
 * ensureTable() is additive by design — it creates tables, adds columns and
 * creates indexes, and it never drops anything, so a mistaken model edit can
 * never take data with it. The cost is that a constraint which has to be
 * REMOVED has to be named here instead, once, and idempotently.
 *
 * Every statement must be safe to run on every boot of every instance, in any
 * order, including concurrently: that is what makes this safe to leave wired
 * into startup rather than remembering to run it by hand on deploy.
 */
const pool = require('./pool');

const STEPS = [
    {
        // users.email was unique platform-wide, which made one address one
        // person at one school in one role. It is now one PERSON, who may hold
        // a post at several schools and several roles — enforced by the
        // (email, school, role) unique index the model declares instead.
        // Dropping this is what allows the second membership to be created.
        name: 'users.email: drop platform-wide unique index',
        sql:  'DROP INDEX IF EXISTS "ux_users_email"',
    },
    {
        // Attendance registers were one per section per day. A school that takes
        // attendance subject-wise keeps one per subject per day, so uniqueness
        // moves to (section, date, subject) — with a day register's null subject
        // folded to '' so two day registers still collide. Created before the
        // old index is dropped: the old one already guarantees the new holds.
        name: 'attendances: unique per section, date and subject',
        sql:  `CREATE UNIQUE INDEX IF NOT EXISTS "ux_attendances_register"
                 ON "attendances" ("section", "date", (COALESCE("subject"::text, '')))`,
    },
    {
        name: 'attendances: drop the one-register-per-day unique index',
        sql:  'DROP INDEX IF EXISTS "ux_attendances_6a938f2e"',
    },
    {
        // Report card notes were one per student per year. A school with terms
        // writes one per term too, so uniqueness moves to (school, year,
        // student, term) — with a note from before terms (term NULL) folded to
        // '' — created before the old index is dropped, which already
        // guarantees the new one holds.
        name: 'reportcardnotes: unique per student, year and term',
        sql:  `CREATE UNIQUE INDEX IF NOT EXISTS "ux_reportcardnotes_term"
                 ON "reportcardnotes" ("school", "academicYear", "student", (COALESCE("term", '')))`,
    },
    {
        name: 'reportcardnotes: drop the one-note-per-year unique index',
        sql:  'DROP INDEX IF EXISTS "ux_reportcardnotes_ee667e5c"',
    },
    {
        // ID cards: one card in force per holder — per holder and year for a
        // student. A card that was lost, damaged, replaced or cancelled is
        // history and does not count, which is why the index is partial: the
        // replacement is a second row for the same holder and year.
        name: 'idcards: one live card per holder and year',
        sql:  `CREATE UNIQUE INDEX IF NOT EXISTS "ux_idcards_live"
                 ON "idcards" ("holder", "kind", (COALESCE("academicYear"::text, '')))
              WHERE "status" IN ('active', 'blocked')`,
    },
];

/**
 * Data changes that must happen exactly once, not on every boot: each is
 * claimed in the "datamigrations" ledger first (one row per name), so of two
 * servers booting together only one runs it; a step that fails gives its
 * claim back, to be tried again on the next boot.
 */
const ONCE = [
    {
        // Results stored before Oct 2026 could carry a grade that contradicted
        // their pass/fail. The first server with the new grading re-grades
        // them, before any school can change its scale — the step that used to
        // be "run scripts/fixResultGrades.js --apply after deploying".
        name: 'results: grades agree with pass and fail (Oct 2026)',
        run: async () => {
            const { results, classTests } = await require('../services/gradeBackfill').regrade({ apply: true });
            return `${results.changed} of ${results.scanned} results, ${classTests.changed} of ${classTests.scanned} class tests re-graded`;
        },
    },
];

async function runOnce() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS "datamigrations" ("name" text PRIMARY KEY, "ranAt" timestamptz NOT NULL DEFAULT now(), "result" text)`);
    } catch (err) {
        console.warn(`[db] data migrations skipped: ${err.message}`);
        return;
    }
    for (const step of ONCE) {
        const { rows } = await pool.query(`INSERT INTO "datamigrations" ("name") VALUES ($1) ON CONFLICT ("name") DO NOTHING RETURNING "name"`, [step.name])
            .catch(() => ({ rows: [] }));
        if (!rows.length) continue;   // done before, or another server has it
        try {
            const result = await step.run();
            await pool.query(`UPDATE "datamigrations" SET "result" = $2, "ranAt" = now() WHERE "name" = $1`, [step.name, String(result || 'done')]);
            console.log(`[db] data migration: ${step.name} — ${result || 'done'}`);
        } catch (err) {
            await pool.query(`DELETE FROM "datamigrations" WHERE "name" = $1`, [step.name]).catch(() => {});
            console.warn(`[db] data migration failed, will retry next boot (${step.name}): ${err.message}`);
        }
    }
}

async function runMigrations() {
    for (const step of STEPS) {
        try {
            await pool.query(step.sql);
        } catch (err) {
            // A migration that cannot run must not take the server down with it
            // — the app still boots, and the log says exactly what is missing.
            console.warn(`[db] migration skipped (${step.name}): ${err.message}`);
        }
    }
    await runOnce();
}

module.exports = { runMigrations, runOnce, STEPS, ONCE };
