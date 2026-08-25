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
//  their record and in Class 5-A according to the class — which is what the
//  student intake form was doing. Everything that moves a student now goes
//  through here so the two cannot disagree.
//
//  currentCount is recomputed from the roster rather than incremented: it is a
//  denormalised counter, and $inc drifts the moment anything else touches the
//  array.
// ─────────────────────────────────────────────────────────────────────────────
const ClassSection   = require('../models/ClassSection');
const StudentProfile = require('../models/StudentProfile');

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

/**
 * Put `studentId` in `sectionId` — and nowhere else.
 *
 * @param {Object}  opts
 * @param {String}  opts.studentId
 * @param {String?} opts.sectionId  null/'' unenrols them from every section
 * @param {String}  opts.schoolId
 * @param {String?} opts.classId    the class to record; derived from the section when omitted
 * @param {Object?} opts.extra      further profile fields to set (e.g. { rollNumber })
 * @param {Boolean} opts.deferCounts skip the headcount recompute — for batch
 *                                   callers that call syncCounts() once at the end
 * @returns {Promise<{ section, class, removedFrom: String[] }>}
 */
async function setStudentSection({ studentId, sectionId, schoolId, classId = null, extra = null, deferCounts = false }) {
    const student = String(studentId);
    const target  = sectionId ? String(sectionId) : null;

    // Every section that currently claims this student. Scoped to the school so
    // a shared id can never reach across tenants.
    const holding = await ClassSection.find(
        { school: schoolId, enrolledStudents: student }, '_id',
    ).lean();
    const stale = holding.map(s => String(s._id)).filter(id => id !== target);

    for (const id of stale) {
        await ClassSection.updateOne({ _id: id }, { $pull: { enrolledStudents: student } });
    }

    let resolvedClass = classId ? String(classId) : null;
    if (target) {
        const section = await ClassSection.findOne({ _id: target, school: schoolId }, '_id class').lean();
        if (!section) {
            // A section that does not exist is not a section to join. The stale
            // rosters are still cleaned up, so the student is left unplaced
            // rather than in two places.
            if (!deferCounts) await syncCounts(stale);
            await writeProfile(student, schoolId, { currentSection: null, ...(extra || {}) });
            return { section: null, class: resolvedClass, removedFrom: stale };
        }
        await ClassSection.updateOne({ _id: target }, { $addToSet: { enrolledStudents: student } });
        if (!resolvedClass) resolvedClass = section.class ? String(section.class) : null;
    }

    if (!deferCounts) await syncCounts([...stale, ...(target ? [target] : [])]);

    // The profile is the other half of the same fact. currentClass is kept when
    // a student is unenrolled — "admitted to the class, not placed in a section
    // yet" is a real state the shuffle looks for.
    const set = { currentSection: target };
    if (resolvedClass) set.currentClass = resolvedClass;
    await writeProfile(student, schoolId, { ...set, ...(extra || {}) });

    return { section: target, class: resolvedClass, removedFrom: stale };
}

/**
 * Update the student's academic record — creating it when there isn't one.
 *
 * A student user without a StudentProfile is not hypothetical: legacy rows, an
 * intake that failed after the account was made, an import that skipped it.
 * Without this, enrolling such a student put them on the class roster and wrote
 * their class nowhere, so the section listed them and their own record was
 * blank. Matching on `user` alone (not user + school) means an existing record
 * is always updated rather than shadowed by a second one.
 */
async function writeProfile(studentId, schoolId, set) {
    const existing = await StudentProfile.findOne({ user: studentId }, '_id').lean();
    if (existing) {
        await StudentProfile.updateOne({ _id: existing._id }, { $set: set });
    } else {
        await StudentProfile.create({ user: studentId, school: schoolId, ...set });
    }
}

module.exports = { setStudentSection, syncCounts };
