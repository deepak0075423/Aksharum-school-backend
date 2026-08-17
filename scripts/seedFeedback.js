'use strict';
/**
 * Seed the default feedback configuration for one school (or every school that
 * has the module enabled).
 *
 *   node scripts/seedFeedback.js                 # every school with modules.feedback
 *   node scripts/seedFeedback.js <schoolId>      # one school
 *   node scripts/seedFeedback.js --all           # every school, module flag or not
 *
 * Idempotent — it matches on the seed keys and only fills gaps, so running it
 * twice changes nothing.
 */
require('dotenv').config();
const connectDB = require('../config/db');
const School = require('../models/School');
const fb = require('../services/feedbackService');

(async () => {
    await connectDB();

    const arg = process.argv[2];
    let schools;
    if (arg && !arg.startsWith('--')) {
        const s = await School.findById(arg).lean();
        if (!s) { console.error(`School ${arg} not found`); process.exit(1); }
        schools = [s];
    } else {
        const filter = arg === '--all' ? {} : { 'modules.feedback': true };
        schools = await School.find(filter).select('name').lean();
    }

    if (!schools.length) {
        console.log('No schools matched. Enable the "feedback" module for a school, or pass --all.');
        process.exit(0);
    }

    for (const s of schools) {
        const created = await fb.seedDefaults(s._id, null);
        console.log(
            `[${s.name}] +${created.categories} categories, +${created.questions} questions, ` +
            `+${created.options} options, +${created.templates} template(s)`,
        );
    }

    console.log(`\nDone — ${schools.length} school(s) processed.`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
