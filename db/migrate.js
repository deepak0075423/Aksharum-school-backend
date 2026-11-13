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
    {
        // A school code is unique across the platform, whatever its case or
        // spacing (services/schoolCode checks first; this holds a race). Codes
        // left blank by older records do not count.
        name: 'schools: one school per code',
        sql:  `CREATE UNIQUE INDEX IF NOT EXISTS "ux_schools_code_ci"
                 ON "schools" (lower(btrim("code"))) WHERE btrim(COALESCE("code", '')) <> ''`,
    },
    {
        // Medical Room: one scheduled dose per plan per time slot. The doses of
        // a day are generated both by the sweep and when the administration
        // screen is opened; the index is what makes the two arriving together
        // harmless (INSERT … ON CONFLICT DO NOTHING).
        name: 'medicationdoses: one dose per plan and slot',
        sql:  `CREATE UNIQUE INDEX IF NOT EXISTS "ux_medicationdoses_slot"
                 ON "medicationdoses" ("plan", "scheduledFor")
              WHERE "plan" IS NOT NULL AND "scheduledFor" IS NOT NULL`,
    },
    {
        // Medical Room: a student is in the room on one visit at a time, and
        // has one request open at a time. Checked by the service first; the
        // index is what makes two nurses pressing "Arrived" together safe.
        name: 'medicalvisits: one open visit per student',
        sql:  `CREATE UNIQUE INDEX IF NOT EXISTS "ux_medicalvisits_open"
                 ON "medicalvisits" ("school", "student")
              WHERE "status" IN ('in_room', 'observation', 'emergency') AND "archivedAt" IS NULL`,
    },
    {
        name: 'medicalrequests: one open request per student',
        sql:  `CREATE UNIQUE INDEX IF NOT EXISTS "ux_medicalrequests_open"
                 ON "medicalrequests" ("school", "student")
              WHERE "status" IN ('requested', 'accepted', 'arrived', 'treatment')`,
    },
    ...admissionSteps(),
    ...lmsSteps(),
];

/**
 * The admission module (Oct 2026): what its tables need beyond syncAll().
 *
 *   - a portal address belongs to one school, whatever its case;
 *   - one live offer per application, one exam sitting open at a time, one
 *     current wording per email, one current file per document type — the
 *     services check first, and these hold the race;
 *   - foreign keys between the module's OWN tables. The rest of the app keeps
 *     Mongo's no-foreign-key semantics, and references out to schools, users
 *     and classes follow it; inside the module, a document, an exam sitting or
 *     a list line without its application is never meaningful, so those go
 *     with it (CASCADE), and a round or payment that something still points
 *     at cannot be deleted (RESTRICT).
 *
 * Each foreign key is added only when missing, so every boot of every instance
 * may run this; two instances racing on the same key lose one harmlessly (the
 * runner logs and moves on). scripts/admissionRollback.js removes all of it.
 */
function admissionSteps() {
    const indexes = [
        ['admissionsettings: one portal per address',
            `CREATE UNIQUE INDEX IF NOT EXISTS "ux_admissionsettings_slug"
               ON "admissionsettings" (lower(btrim("slug"))) WHERE btrim(COALESCE("slug", '')) <> ''`],
        ['admissionoffers: one live offer per application',
            `CREATE UNIQUE INDEX IF NOT EXISTS "ux_admissionoffers_live"
               ON "admissionoffers" ("application") WHERE "status" IN ('issued', 'accepted', 'confirmed')`],
        ['admissionattempts: one sitting open per exam and application',
            `CREATE UNIQUE INDEX IF NOT EXISTS "ux_admissionattempts_open"
               ON "admissionattempts" ("exam", "application") WHERE "status" = 'in_progress'`],
        ['admissionemailtemplates: one current wording per event',
            `CREATE UNIQUE INDEX IF NOT EXISTS "ux_admissionemailtemplates_current"
               ON "admissionemailtemplates" ("school", "event") WHERE "isCurrent"`],
        ['admissiondocuments: one current file per document type',
            `CREATE UNIQUE INDEX IF NOT EXISTS "ux_admissiondocuments_current"
               ON "admissiondocuments" ("application", "docKey") WHERE "current" AND "docKey" <> ''`],
    ];
    // [constraint, child table, column, parent table, on delete]
    const keys = [
        ['fk_admformversions_form',      'admissionformversions', 'form',        'admissionforms',        'CASCADE'],
        ['fk_admapplications_round',     'admissionapplications', 'round',       'admissionrounds',       'RESTRICT'],
        ['fk_admapplications_version',   'admissionapplications', 'formVersion', 'admissionformversions', 'RESTRICT'],
        ['fk_admdocuments_application',  'admissiondocuments',    'application', 'admissionapplications', 'CASCADE'],
        ['fk_admdocuments_type',         'admissiondocuments',    'docType',     'admissiondocumenttypes', 'SET NULL'],
        ['fk_admevents_application',     'admissionevents',       'application', 'admissionapplications', 'CASCADE'],
        ['fk_admexams_round',            'admissionexams',        'round',       'admissionrounds',       'RESTRICT'],
        ['fk_admquestions_exam',         'admissionquestions',    'exam',        'admissionexams',        'CASCADE'],
        ['fk_admcandidates_exam',        'admissioncandidates',   'exam',        'admissionexams',        'CASCADE'],
        ['fk_admcandidates_application', 'admissioncandidates',   'application', 'admissionapplications', 'CASCADE'],
        ['fk_admattempts_exam',          'admissionattempts',     'exam',        'admissionexams',        'CASCADE'],
        ['fk_admattempts_application',   'admissionattempts',     'application', 'admissionapplications', 'CASCADE'],
        ['fk_admresults_exam',           'admissionresults',      'exam',        'admissionexams',        'CASCADE'],
        ['fk_admresults_application',    'admissionresults',      'application', 'admissionapplications', 'CASCADE'],
        ['fk_admlists_round',            'admissionlists',        'round',       'admissionrounds',       'RESTRICT'],
        ['fk_admlistentries_list',       'admissionlistentries',  'list',        'admissionlists',        'CASCADE'],
        ['fk_admlistentries_application','admissionlistentries',  'application', 'admissionapplications', 'CASCADE'],
        ['fk_admoffers_application',     'admissionoffers',       'application', 'admissionapplications', 'CASCADE'],
        ['fk_admoffers_list',            'admissionoffers',       'list',        'admissionlists',        'SET NULL'],
        ['fk_admlistentries_offer',      'admissionlistentries',  'offer',       'admissionoffers',       'SET NULL'],
        ['fk_admpayments_application',   'admissionpayments',     'application', 'admissionapplications', 'RESTRICT'],
        ['fk_admemaillogs_application',  'admissionemaillogs',    'application', 'admissionapplications', 'SET NULL'],
    ];
    return [
        ...indexes.map(([name, sql]) => ({ name, sql })),
        ...keys.map(([con, child, col, parent, onDelete]) => ({
            name: `${child}.${col} → ${parent} (${onDelete})`,
            sql: `DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${con}') THEN
                        ALTER TABLE "${child}" ADD CONSTRAINT "${con}"
                            FOREIGN KEY ("${col}") REFERENCES "${parent}"("_id") ON DELETE ${onDelete};
                    END IF;
                  END $$`,
        })),
    ];
}

/**
 * Video Learning (Nov 2026): what the Lms* tables need beyond syncAll().
 *
 *   - one LIVE assignment of a book per class and section (an ended one is
 *     history and does not count), one open request per school for the same
 *     thing, one book per board, class, subject, title, edition and publisher,
 *     one provider that new uploads go to — the services check first, and
 *     these hold the race;
 *   - foreign keys between the module's OWN tables, as for admissions: a
 *     chapter goes with its book and a heartbeat with its session (CASCADE),
 *     while a board, book, chapter or video that a school's assignment, a
 *     release or a student's progress points at cannot be deleted (RESTRICT) —
 *     which is the rule "used content is archived, never removed", enforced
 *     by the database as well as by services/lms/catalog. References out to
 *     schools, users, classes and sections keep the app's no-foreign-key rule.
 */
function lmsSteps() {
    const indexes = [
        ['lmsbookassignments: one live assignment per class, section and book',
            `CREATE UNIQUE INDEX IF NOT EXISTS "ux_lmsbookassignments_live"
               ON "lmsbookassignments" ("class", (COALESCE("section"::text, '')), "book") WHERE "status" = 'active'`],
        ['lmsrequests: one open request per school for the same thing',
            `CREATE UNIQUE INDEX IF NOT EXISTS "ux_lmsrequests_open"
               ON "lmsrequests" ("school", "dedupeKey")
            WHERE "status" IN ('pending', 'under_review', 'approved', 'in_progress') AND "dedupeKey" <> ''`],
        ['lmsbooks: one book per board, class, subject, title, edition and publisher',
            `CREATE UNIQUE INDEX IF NOT EXISTS "ux_lmsbooks_identity"
               ON "lmsbooks" ("board", "classLevel", "subject", lower(btrim("title")), lower(btrim(COALESCE("edition", ''))), lower(btrim(COALESCE("publisher", ''))))
            WHERE "status" <> 'archived'`],
        ['lmsproviders: one provider for new uploads',
            `CREATE UNIQUE INDEX IF NOT EXISTS "ux_lmsproviders_default" ON "lmsproviders" (("isDefault")) WHERE "isDefault"`],
        ['lmsvideos: one asset per Vimeo or YouTube video',
            `CREATE UNIQUE INDEX IF NOT EXISTS "ux_lmsvideos_provider_asset"
               ON "lmsvideos" ("provider", "providerAssetId") WHERE "providerAssetId" <> ''`],
        ['lmsreleases: releases of a section that are open or booked',
            `CREATE INDEX IF NOT EXISTS "ix_lmsreleases_live" ON "lmsreleases" ("section", "releaseAt") WHERE "status" IN ('scheduled', 'active')`],
        ['lmsprogresses: a section\'s progress on a chapter video',
            `CREATE INDEX IF NOT EXISTS "ix_lmsprogresses_cv_student" ON "lmsprogresses" ("chapterVideo", "student")`],
    ];
    // [constraint, child table, column, parent table, on delete]
    const keys = [
        ['fk_lmssubjectmaps_board',      'lmssubjectmaps',     'board',        'lmsboards',          'RESTRICT'],
        ['fk_lmssubjectmaps_subject',    'lmssubjectmaps',     'subject',      'lmssubjects',        'RESTRICT'],
        ['fk_lmsbooks_board',            'lmsbooks',           'board',        'lmsboards',          'RESTRICT'],
        ['fk_lmsbooks_subject',          'lmsbooks',           'subject',      'lmssubjects',        'RESTRICT'],
        ['fk_lmschapters_book',          'lmschapters',        'book',         'lmsbooks',           'CASCADE'],
        ['fk_lmschaptervideos_chapter',  'lmschaptervideos',   'chapter',      'lmschapters',        'CASCADE'],
        ['fk_lmschaptervideos_book',     'lmschaptervideos',   'book',         'lmsbooks',           'CASCADE'],
        ['fk_lmschaptervideos_video',    'lmschaptervideos',   'video',        'lmsvideos',          'RESTRICT'],
        ['fk_lmsvideos_subject',         'lmsvideos',          'subject',      'lmssubjects',        'SET NULL'],
        ['fk_lmsuploads_video',          'lmsuploads',         'video',        'lmsvideos',          'CASCADE'],
        ['fk_lmsjobs_video',             'lmsjobs',            'video',        'lmsvideos',          'CASCADE'],
        ['fk_lmsschoolconfigs_board',    'lmsschoolconfigs',   'board',        'lmsboards',          'RESTRICT'],
        ['fk_lmsschoolsubjects_subject', 'lmsschoolsubjects',  'lmsSubject',   'lmssubjects',        'RESTRICT'],
        ['fk_lmsbookassignments_book',   'lmsbookassignments', 'book',         'lmsbooks',           'RESTRICT'],
        ['fk_lmsrequests_book',          'lmsrequests',        'book',         'lmsbooks',           'SET NULL'],
        ['fk_lmsreleases_assignment',    'lmsreleases',        'assignment',   'lmsbookassignments', 'RESTRICT'],
        ['fk_lmsreleases_book',          'lmsreleases',        'book',         'lmsbooks',           'RESTRICT'],
        ['fk_lmsreleases_chapter',       'lmsreleases',        'chapter',      'lmschapters',        'RESTRICT'],
        ['fk_lmsreleases_chaptervideo',  'lmsreleases',        'chapterVideo', 'lmschaptervideos',   'RESTRICT'],
        ['fk_lmsprogresses_book',        'lmsprogresses',      'book',         'lmsbooks',           'RESTRICT'],
        ['fk_lmsprogresses_chapter',     'lmsprogresses',      'chapter',      'lmschapters',        'RESTRICT'],
        ['fk_lmsprogresses_chaptervideo','lmsprogresses',      'chapterVideo', 'lmschaptervideos',   'RESTRICT'],
        ['fk_lmsprogresses_video',       'lmsprogresses',      'video',        'lmsvideos',          'RESTRICT'],
        ['fk_lmswatchsessions_progress', 'lmswatchsessions',   'progress',     'lmsprogresses',      'CASCADE'],
        ['fk_lmsheartbeats_session',     'lmsheartbeats',      'session',      'lmswatchsessions',   'CASCADE'],
    ];
    return [
        ...indexes.map(([name, sql]) => ({ name, sql })),
        ...keys.map(([con, child, col, parent, onDelete]) => ({
            name: `${child}.${col} → ${parent} (${onDelete})`,
            sql: `DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${con}') THEN
                        ALTER TABLE "${child}" ADD CONSTRAINT "${con}"
                            FOREIGN KEY ("${col}") REFERENCES "${parent}"("_id") ON DELETE ${onDelete};
                    END IF;
                  END $$`,
        })),
    ];
}

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
    {
        // Phone numbers were stored as typed ("+91 98765 43210"); every phone
        // field now holds a 10-digit mobile number. Only formatting and the
        // country code go — a number that would not become a valid mobile is
        // left as it is (scripts/normalizePhones.js lists those).
        name: 'phones: stored as 10-digit mobile numbers (Oct 2026)',
        run: async () => {
            const r = await require('../services/phoneBackfill').normalizeStoredPhones({ apply: true });
            return `${r.changed} of ${r.scanned} phone numbers rewritten as ten digits, ${r.leftAlone} left as they are${r.skipped ? `, ${r.skipped} saved meanwhile` : ''}`;
        },
    },
    {
        // Video Learning was rebuilt around books and chapters (Nov 2026). The
        // videos of the old master library are copied into the new asset
        // library, once, so nothing uploaded before is lost; the old tables
        // are left exactly as they were.
        name: 'video learning: old master videos copied into the asset library (Nov 2026)',
        run: async () => {
            const r = await require('../services/lms/legacy').copyMasterVideos();
            return `${r.copied} of ${r.found} old master videos copied, ${r.skipped} already there`;
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
