'use strict';
/**
 * Take the admission module back out of the database.
 *
 *   node scripts/admissionRollback.js            report what it would remove
 *   node scripts/admissionRollback.js --commit   remove it
 *
 * Removed with --commit, in one transaction (all of it, or none of it):
 *   - the module's foreign keys and partial unique indexes (db/migrate.js
 *     admissionSteps), then its 23 tables — applications, documents, exams,
 *     results, lists, offers, payments, email templates and logs, settings…;
 *   - the "admission" key of each school's module switches, of its payment
 *     gateway's module switches, and of each designation's permissions;
 *   - admission receipt designs (receipttemplates, module 'admission').
 *
 * Only with their own flags, because they are people and files:
 *   --remove-applicant-accounts   applicant (role 'guest') sign-ins. A family
 *                                 whose child was enrolled already holds a
 *                                 student/parent account, which is never
 *                                 touched — enrolment created those as
 *                                 ordinary accounts.
 *   --remove-files                uploads/admission-docs (the uploaded
 *                                 documents; copies filed on enrolled
 *                                 students' records stay).
 *
 * Nothing outside the module is touched: students, parents, fees, transport,
 * hostel and medical records created when applicants were enrolled are the
 * school's records now and remain.
 *
 * While the admission code is still deployed, the next server start creates
 * the (empty) tables again — run this after the code is gone, or to start the
 * module afresh.
 */
require('dotenv').config({ quiet: true });
require('../config/timezone');
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');

const args = new Set(process.argv.slice(2));
const commit = args.has('--commit');
const removeAccounts = args.has('--remove-applicant-accounts');
const removeFiles = args.has('--remove-files');

const TABLES = [
    // Added Oct 15 2026: data-protection requests and the access log.
    'admissiondatarequests', 'admissionaccesslogs', 'admissionemailsuppressions', 'admissionrteclaims', 'admissionrefunds', 'admissionvisitslots', 'admissionvisitbookings', 'admissionappeals', 'admissionexports', 'admissionjobruns', 'admissionsourcespends', 'admissiongroups', 'admissiontransfers', 'admissiondigilockersessions',
    'admissionlistentries', 'admissionoffers', 'admissionlists', 'admissionresults', 'admissionattempts', 'admissioncandidates',
    'admissionquestions', 'admissionexams', 'admissionpayments', 'admissiondocuments', 'admissionevents', 'admissionemaillogs',
    'admissionapplications', 'admissionformversions', 'admissionforms', 'admissiondocumenttypes', 'admissionrounds',
    'admissionemailtemplates', 'admissionotps', 'admissionapplicants', 'admissionenquiries', 'admissioncounters', 'admissionsettings',
];
const INDEXES = ['ux_admissionsettings_slug', 'ux_admissionoffers_live', 'ux_admissionattempts_open', 'ux_admissionemailtemplates_current', 'ux_admissiondocuments_current'];
const DOCS = path.join(__dirname, '..', 'uploads', 'admission-docs');

async function folderSize(dir) {
    let files = 0;
    let bytes = 0;
    const walk = async (d) => {
        let entries = [];
        try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else { files += 1; bytes += (await fs.promises.stat(p).catch(() => ({ size: 0 }))).size; }
        }
    };
    await walk(dir);
    return { files, bytes };
}

(async () => {
    const client = await pool.getPool().connect();
    try {
        const { rows: present } = await client.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [TABLES]);
        const have = new Set(present.map((r) => r.t));
        console.log(`${commit ? 'Removing' : 'Would remove'} the admission module:`);
        for (const t of TABLES) {
            if (!have.has(t)) { console.log(`  ${t.padEnd(26)} (not there)`); continue; }
            const { rows: [c] } = await client.query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
            console.log(`  ${t.padEnd(26)} ${String(c.n).padStart(7)} row(s)`);
        }
        const { rows: fks } = await client.query(`SELECT conname, conrelid::regclass::text AS tbl FROM pg_constraint WHERE conname LIKE 'fk\\_adm%'`);
        console.log(`  ${fks.length} foreign key(s), ${INDEXES.length} partial unique index(es)`);
        const { rows: [flags] } = await client.query(
            `SELECT (SELECT COUNT(*) FROM "schools" WHERE "modules" ? 'admission')::int AS schools,
                    (SELECT COUNT(*) FROM "schools" WHERE ("paymentGateway"->'modules') ? 'admission')::int AS gateways,
                    (SELECT COUNT(*) FROM "designations" WHERE "permissions" ? 'admission')::int AS designations,
                    (SELECT COUNT(*) FROM "receipttemplates" WHERE "module" = 'admission')::int AS receipts,
                    (SELECT COUNT(*) FROM "users" WHERE "role" = 'guest')::int AS guests`);
        console.log(`  "admission" switch on ${flags.schools} school(s), ${flags.gateways} payment gateway(s), ${flags.designations} designation(s); ${flags.receipts} receipt design(s)`);
        console.log(`  ${flags.guests} applicant account(s) — ${removeAccounts ? 'REMOVED' : 'kept (add --remove-applicant-accounts to remove them)'}`);
        const docs = await folderSize(DOCS);
        console.log(`  ${docs.files} uploaded document file(s), ${(docs.bytes / 1024 / 1024).toFixed(1)} MB — ${removeFiles ? 'REMOVED' : 'kept (add --remove-files to remove them)'}`);

        if (!commit) {
            console.log('\nNothing was changed. Run again with --commit to remove it.');
            return;
        }

        await client.query('BEGIN');
        for (const f of fks) await client.query(`ALTER TABLE ${f.tbl} DROP CONSTRAINT IF EXISTS "${f.conname}"`);
        for (const i of INDEXES) await client.query(`DROP INDEX IF EXISTS "${i}"`);
        // No CASCADE: anything outside the module that has come to depend on a
        // table stops the rollback rather than being dropped with it.
        for (const t of TABLES) await client.query(`DROP TABLE IF EXISTS "${t}"`);
        await client.query(`UPDATE "schools" SET "modules" = "modules" - 'admission' WHERE "modules" ? 'admission'`);
        await client.query(`UPDATE "schools" SET "paymentGateway" = jsonb_set("paymentGateway", '{modules}', ("paymentGateway"->'modules') - 'admission') WHERE ("paymentGateway"->'modules') ? 'admission'`);
        await client.query(`UPDATE "designations" SET "permissions" = "permissions" - 'admission' WHERE "permissions" ? 'admission'`);
        await client.query(`DELETE FROM "receipttemplates" WHERE "module" = 'admission'`);
        if (removeAccounts) {
            await client.query(`DELETE FROM "notificationreceipts" WHERE "recipient" IN (SELECT "_id" FROM "users" WHERE "role" = 'guest')`);
            await client.query(`DELETE FROM "users" WHERE "role" = 'guest'`);
        }
        await client.query('COMMIT');
        if (removeFiles) await fs.promises.rm(DOCS, { recursive: true, force: true });
        console.log('\nRemoved.');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Nothing was changed:', e.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end().catch(() => {});
        process.exit(process.exitCode || 0);
    }
})();
