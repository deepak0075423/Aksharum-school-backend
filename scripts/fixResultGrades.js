'use strict';
/**
 * Re-grade results stored before Oct 2026, when a grade could contradict the
 * result printed beside it.
 *
 * Grades were bands of percentage alone, and the pass mark is the school's own
 * per subject — so with the usual pass mark of 33, a student on 35% PASSED a
 * subject with grade F, and one on 45% against a pass mark of 50 FAILED it with
 * grade D. services/resultSettings now grades so the two always agree (gradeFor
 * / overallGrade): absent is AB, not passed is the scale's highest failing
 * grade, and a pass is never a failing grade.
 *
 * This only rewrites the grade letters. Marks, totals, percentages, pass/fail
 * and ranks are left exactly as published — the stored `isPassed` (grace
 * included) is what the new grade is made to agree with.
 *
 *   node scripts/fixResultGrades.js                 report what would change
 *   node scripts/fixResultGrades.js --apply         change it
 *   node scripts/fixResultGrades.js --school <id>   one school only
 *
 * Exam results and class tests are both covered. Safe to run twice:
 * a second run finds nothing to change. The work is services/gradeBackfill —
 * which a server also runs ONCE by itself, on its first boot with this code
 * (db/migrate.js, ledger table "datamigrations"), so a deploy needs no step by
 * hand; this script stays for a look first, or for one school.
 */
require('dotenv').config({ quiet: true });
require('../config/timezone');
const pool = require('../db/pool');
const { regrade } = require('../services/gradeBackfill');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const schoolAt = args.indexOf('--school');
const school = schoolAt >= 0 ? args[schoolAt + 1] : null;

(async () => {
    try {
        const { results: r, classTests: t } = await regrade({ apply, school });
        console.log(`${apply ? 'Re-graded' : 'Would re-grade'}${school ? ` (school ${school})` : ''}:`);
        console.log(`  exam results  ${r.changed} of ${r.scanned} (${r.subjectsChanged} subject grades)`);
        r.samples.forEach((x) => console.log(`      e.g. ${x}`));
        console.log(`  class tests   ${t.changed} of ${t.scanned} (${t.marksChanged} marks)`);
        if (r.skipped || t.skipped) console.log(`  left alone    ${r.skipped + t.skipped} saved by someone while this ran (graded by the new code already)`);
        if (!apply && (r.changed || t.changed)) console.log('Run again with --apply to change them.');
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await pool.end().catch(() => {});
        process.exit(process.exitCode || 0);
    }
})();
