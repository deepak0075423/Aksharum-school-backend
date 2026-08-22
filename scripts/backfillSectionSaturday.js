'use strict';
/**
 * One-off backfill for ClassSection.openOnSaturday.
 *
 * The column defaults to false and, before this change, was written in exactly
 * one place — as a side effect of saving a section's period structure. Any
 * section whose structure had never been saved through that screen read as
 * "closed on Saturday" even though the school works Saturdays, which is why the
 * generator scheduled nothing on Saturday and the student, teacher and PDF views
 * all stopped at Friday.
 *
 * The flag carries no independent information: nothing but that sync has ever
 * written it. So this re-derives it from the school's own leaveSettings, which
 * is what the app now treats as the source of truth.
 *
 *   node scripts/backfillSectionSaturday.js          # report only
 *   node scripts/backfillSectionSaturday.js --apply  # write
 */
require('dotenv').config();
const connectDB = require('../config/db');
const School = require('../models/School');
const ClassSection = require('../models/ClassSection');
const { schoolWorksSaturday, syncSectionsToSchoolSaturday } = require('../utils/timetableDays');

(async () => {
    const apply = process.argv.includes('--apply');
    await connectDB();

    const schools = await School.find({}).select('name leaveSettings').lean();
    let total = 0;

    for (const school of schools) {
        const open = schoolWorksSaturday(school);
        const stale = await ClassSection.find({ school: school._id, openOnSaturday: !open })
            .select('sectionName class').lean();
        if (!stale.length) {
            console.log(`${school.name}: Saturday ${open ? 'on' : 'off'} — all sections already in step`);
            continue;
        }
        total += stale.length;
        console.log(`${school.name}: Saturday ${open ? 'on' : 'off'} — ${stale.length} section(s) out of step`);
        if (apply) {
            const n = await syncSectionsToSchoolSaturday(school._id, school);
            console.log(`  → updated ${n}`);
        }
    }

    console.log(apply
        ? `\nDone. ${total} section(s) brought in line.`
        : `\n${total} section(s) would change. Re-run with --apply to write.`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
