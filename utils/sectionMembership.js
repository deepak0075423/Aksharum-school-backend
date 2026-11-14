'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Which section a student is in — recorded in two places, kept as one fact.
//
//  A student's section lives on StudentProfile (currentSection / currentClass)
//  AND on ClassSection.enrolledStudents. Different screens read different ones:
//  the students list and every parent view resolve class through the profile,
//  while the section page, attendance, exams, the timetable fan-out and the
//  shuffle all read the roster.
//
//  Writing only one of them leaves a student who is in Class 8-A according to
//  their record and in Class 5-A according to the class. Since Nov 2026 every
//  placement goes through services/enrollment.js, which writes the student's
//  row for ONE academic year (StudentEnrollment), that year's rosters and the
//  record's pointer together. The old helper here took a student off every
//  section of every year on each move, and is gone; only the headcount
//  recompute is left.
//
//  currentCount is recomputed from the roster rather than incremented: it is a
//  denormalised counter, and $inc drifts the moment anything else touches the
//  array.
// ─────────────────────────────────────────────────────────────────────────────
const ClassSection   = require('../models/ClassSection');

/** Recompute currentCount for the given sections from their actual rosters. */
async function syncCounts(sectionIds) {
    const ids = [...new Set(sectionIds.map(String).filter(Boolean))];
    if (!ids.length) return;
    const rows = await ClassSection.find({ _id: { $in: ids } }, '_id enrolledStudents').lean();
    for (const s of rows) {
        await ClassSection.updateOne(
            { _id: s._id },
            { $set: { currentCount: (s.enrolledStudents || []).length } },
        );
    }
}

module.exports = { syncCounts };
