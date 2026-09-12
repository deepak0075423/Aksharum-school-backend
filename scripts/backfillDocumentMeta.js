'use strict';
/**
 * One-off backfill for Document.docType and Document.academicYear.
 *
 * Both columns were added when the admin Documents landing page was rebuilt:
 * the tabs and the TYPE column read `docType`, and the year filter reads
 * `academicYear`. Documents uploaded before that carry neither, so without this
 * they all land under "Other" and under no year at all — present in the list,
 * unreachable from every filter above it.
 *
 * `docType` is guessed once, here, from the assignment flag and the school's own
 * filing label ("Notice", "Circulars", "Study Material" and the like). A guess
 * is only ever written where the field is empty, and the admin can correct any
 * row afterwards — which is the point of storing it rather than re-deriving the
 * guess on every read.
 *
 * `academicYear` is the year whose window the upload date falls inside, not
 * whichever year happens to be active now: a notice from two years ago belongs
 * in the year it was sent.
 *
 * Safe to re-run: rows that already carry both are skipped.
 *
 *   node scripts/backfillDocumentMeta.js          # report only
 *   node scripts/backfillDocumentMeta.js --apply  # write
 */
require('dotenv').config();

const Document     = require('../models/Document');
const AcademicYear = require('../models/AcademicYear');

const APPLY = process.argv.includes('--apply');

/**
 * The kind a document most likely is, read off its filing label.
 *
 * Ordered: "Assignment Notice" is a notice about assignments only if nothing
 * earlier claims it, and the assignment flag beats every label.
 */
const RULES = [
    [/\b(study|note|material|resource|worksheet|syllabus|chapter|lesson)\b/i, 'study_material'],
    [/\b(circular)\b/i,                                                        'circular'],
    [/\b(notice|announcement|memo|bulletin)\b/i,                               'notice'],
    [/\b(assignment|homework|task|submission)\b/i,                             'assignment'],
];

function guessType(doc) {
    if (doc.isAssignment) return 'assignment';
    const text = `${doc.category || ''} ${doc.title || ''}`;
    for (const [re, type] of RULES) if (re.test(text)) return type;
    return 'other';
}

(async () => {
    const docs = await Document.find({}).lean();
    const pending = docs.filter((d) => !d.docType || d.docType === 'other' || !d.academicYear);

    if (!pending.length) {
        console.log(`Nothing to backfill — all ${docs.length} document(s) already carry a type and a year.`);
        process.exit(0);
    }

    const bySchool = {};
    for (const d of pending) (bySchool[String(d.school)] ||= []).push(d);

    console.log(`${pending.length} of ${docs.length} document(s) need a type or a year, across ${Object.keys(bySchool).length} school(s)\n`);

    let typed = 0;
    let filed = 0;
    let unfiled = 0;

    for (const [schoolId, list] of Object.entries(bySchool)) {
        const years = (await AcademicYear.find({ school: schoolId }).lean())
            .filter((y) => y.startDate && y.endDate);

        // Falls back to the active year for a school whose windows do not cover
        // the upload date — an import dated before the first year was created.
        const active = (await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean())?._id || null;

        for (const doc of list) {
            const set = {};

            if (!doc.docType || doc.docType === 'other') {
                const guess = guessType(doc);
                if (guess !== 'other') { set.docType = guess; typed += 1; }
                else if (!doc.docType) { set.docType = 'other'; }
            }

            if (!doc.academicYear) {
                const at = new Date(doc.createdAt || Date.now());
                const covering = years.find((y) => new Date(y.startDate) <= at && at <= new Date(y.endDate));
                const year = covering?._id || active;
                if (year) { set.academicYear = year; filed += 1; }
                else      { unfiled += 1; }
            }

            if (!Object.keys(set).length) continue;

            const label = [
                set.docType ? `type=${set.docType}` : null,
                set.academicYear ? 'year stamped' : null,
            ].filter(Boolean).join(', ');
            console.log(`  ${doc.title?.slice(0, 48).padEnd(50)} ${label}`);

            if (APPLY) await Document.updateOne({ _id: doc._id }, { $set: set });
        }
    }

    console.log(`\n${typed} typed, ${filed} filed under a year, ${unfiled} left unfiled (no academic year covers them).`);
    console.log(APPLY ? 'Written.' : 'Dry run — re-run with --apply to write.');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
