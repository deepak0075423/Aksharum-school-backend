'use strict';
/**
 * One-off normalisation for leave applications left in `modification_requested`.
 *
 * The "send back for modification" action has been removed from the leave
 * module, so nothing can produce or act on that status any more. Rows already
 * carrying it would be stranded: approve, reject and cancel all refuse them, and
 * the pending days they hold would never be released.
 *
 * They move back to `pending`, which is what they always were underneath — the
 * pending hold was set on apply and was never cleared when the status changed,
 * so no balance moves here and no ledger row is written. The application simply
 * returns to the approver's queue.
 *
 * Safe to re-run: once nothing is in that status there is nothing left to do.
 *
 *   node scripts/normalizeModificationRequestedLeave.js          # report only
 *   node scripts/normalizeModificationRequestedLeave.js --apply  # write
 */
require('dotenv').config();

const LeaveApplication = require('../models/LeaveApplication');

const APPLY = process.argv.includes('--apply');

const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '—';

(async () => {
    // The status is gone from the schema enum, so this queries the stored value
    // directly — the ORM does not validate enums on read or on filter.
    const stranded = await LeaveApplication.find({ status: 'modification_requested' }).lean();
    if (!stranded.length) {
        console.log('Nothing to normalise — no application is in modification_requested.');
        process.exit(0);
    }

    const bySchool = {};
    for (const app of stranded) (bySchool[String(app.school)] ||= []).push(app);

    console.log(`${stranded.length} application(s) in modification_requested across ${Object.keys(bySchool).length} school(s)\n`);
    for (const [schoolId, apps] of Object.entries(bySchool)) {
        console.log(`  ${schoolId}: ${apps.length} application(s)`);
        for (const app of apps) {
            console.log(`    ${app._id}  teacher ${app.teacher}  ${fmtDate(app.fromDate)} – ${fmtDate(app.toDate)}  ${app.totalDays} day(s)`);
        }
    }

    if (APPLY) {
        // adminComment is left as it is: it holds whatever the approver asked
        // for, and it is still shown to the employee on their own leave list.
        const res = await LeaveApplication.updateMany(
            { status: 'modification_requested' },
            { $set: { status: 'pending' } },
        );
        console.log(`\nReturned ${res.modifiedCount ?? stranded.length} application(s) to pending. No balance or ledger change.`);
    } else {
        console.log(`\nWould return ${stranded.length} application(s) to pending. No balance or ledger change.`);
        console.log('Dry run — re-run with --apply to write.');
    }
    process.exit(0);
})().catch(e => { console.error('Normalisation failed:', e.message); process.exit(1); });
