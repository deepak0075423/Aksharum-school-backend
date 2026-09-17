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
];

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
}

module.exports = { runMigrations, STEPS };
