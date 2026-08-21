'use strict';
/**
 * One-off backfill for LeaveApplication.academicYear.
 *
 * Applications filed before that column existed carry no year, so every balance
 * move on them falls back to "whichever year is active now" — the behaviour that
 * stranded held days across a rollover. This stamps each one with the year its
 * fromDate actually falls in, so the fallback is never needed again.
 *
 * Safe to re-run: rows that already carry a year are skipped.
 *
 *   node scripts/backfillLeaveAcademicYear.js          # report only
 *   node scripts/backfillLeaveAcademicYear.js --apply  # write
 */
require('dotenv').config();

const LeaveApplication = require('../models/LeaveApplication');
const AcademicYear     = require('../models/AcademicYear');
const { academicYearLabel } = require('../utils/leaveDays');

const APPLY = process.argv.includes('--apply');

(async () => {
    const pending = await LeaveApplication.find({ academicYear: null }).lean();
    if (!pending.length) {
        console.log('Nothing to backfill — every application already carries an academic year.');
        process.exit(0);
    }

    // Years are per school, so resolve them per school rather than globally.
    const bySchool = {};
    for (const app of pending) (bySchool[String(app.school)] ||= []).push(app);

    let stamped = 0;
    let unresolved = 0;
    console.log(`${pending.length} application(s) without an academic year across ${Object.keys(bySchool).length} school(s)\n`);

    for (const [schoolId, apps] of Object.entries(bySchool)) {
        const years = await AcademicYear.find({ school: schoolId }).lean();
        if (!years.length) {
            console.log(`  ${schoolId}: no academic years on record — ${apps.length} application(s) skipped`);
            unresolved += apps.length;
            continue;
        }

        for (const app of apps) {
            const from = new Date(app.fromDate);
            // The year whose range contains the leave. Falling outside every
            // range is possible for old data, so fall back to the year that was
            // active when it was filed, then to the school's active year.
            const containing = years.find(y =>
                new Date(y.startDate) <= from && from <= new Date(y.endDate));
            const filedIn = years.find(y => {
                const at = new Date(app.appliedAt || app.createdAt);
                return new Date(y.startDate) <= at && at <= new Date(y.endDate);
            });
            const target = containing || filedIn || years.find(y => y.status === 'active');
            const label = academicYearLabel(target);

            if (!label) { unresolved += 1; continue; }
            if (APPLY) {
                await LeaveApplication.updateOne({ _id: app._id }, { $set: { academicYear: label } });
            }
            stamped += 1;
        }
        console.log(`  ${schoolId}: ${apps.length} application(s) resolved against ${years.length} academic year(s)`);
    }

    console.log(`\n${APPLY ? 'Stamped' : 'Would stamp'} ${stamped} application(s).`);
    if (unresolved) console.log(`${unresolved} could not be resolved and were left alone (they keep the active-year fallback).`);
    if (!APPLY) console.log('\nDry run — re-run with --apply to write.');
    process.exit(0);
})().catch(e => { console.error('Backfill failed:', e.message); process.exit(1); });
