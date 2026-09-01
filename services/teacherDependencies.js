'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  What still points at a teacher.
//
//  Deactivating or deleting a teacher used to be unconditional. That left
//  sections with no class teacher, subjects with nobody against them, library
//  copies booked out to an account that no longer answers, and timetable periods
//  referencing a deleted user. This collects every such reference so the admin
//  is shown what has to be resolved first, and both write paths refuse until it
//  is.
//
//  Three families, matching the three places an admin has to go and fix things:
//
//    assignments  class teacher, vice class teacher, the subjects the teacher is
//                 listed against, and their section subject-teacher rows. Always
//                 checked — this is core school structure, not a module.
//    library      copies still out on loan. Only when the module is enabled.
//    timetable    periods the teacher holds. Only when the module is enabled.
//
//  Timetable is the ONLY family that can be cleared automatically, which is what
//  Force Deactivate does — a period with no teacher is a state the grid already
//  understands and displays as an open slot. The other two cannot be: a section
//  with no class teacher, and a book that never came back, are each somebody's
//  decision rather than a field to blank.
//
//  "Vice class teacher" is stored as ClassSection.substituteTeacher. The name is
//  historical; class.controller and the employee directory both read it as the
//  vice class teacher and so does this.
// ─────────────────────────────────────────────────────────────────────────────
const School              = require('../models/School');
const Class               = require('../models/Class');
const ClassSection        = require('../models/ClassSection');
const Subject             = require('../models/Subject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const AcademicYear        = require('../models/AcademicYear');
const LibraryIssuance     = require('../models/LibraryIssuance');
const Timetable           = require('../models/Timetable');
const TimetableEntry      = require('../models/TimetableEntry');

// A copy is still the borrower's problem until it comes back. 'lost' is settled
// through the fine, not by returning it, so it does not hold a deactivation up.
const ACTIVE_ISSUANCE = ['issued', 'overdue'];

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const sid = (v) => (v == null ? '' : String(v._id ?? v));

/**
 * Every live reference to `teacherId` within `schoolId`.
 *
 * Scoped to the active academic year wherever a year exists: a class teacher of
 * a section from three years ago is history, not a dependency, and blocking on
 * it would make an old teacher impossible to ever remove.
 */
async function collect(teacherId, schoolId) {
    const id = String(teacherId);

    const [school, activeYear] = await Promise.all([
        School.findById(schoolId).select('modules').lean(),
        AcademicYear.findOne({ school: schoolId, status: 'active' }).lean(),
    ]);
    const modules = school?.modules || {};
    const yearFilter = activeYear ? { academicYear: activeYear._id } : {};

    // ── 1. Assignments ───────────────────────────────────────────────────────
    const [sections, classes, subjectRows] = await Promise.all([
        ClassSection.find({ school: schoolId, ...yearFilter })
            .select('sectionName class classTeacher substituteTeacher').lean(),
        Class.find({ school: schoolId, ...yearFilter }).select('className classNumber').lean(),
        Subject.find({ school: schoolId, teachers: teacherId }).select('subjectName subjectCode').lean(),
    ]);
    const classById = new Map(classes.map((c) => [String(c._id), c]));
    const where = (section) => {
        const cls = classById.get(String(section.class));
        return {
            sectionId:   String(section._id),
            sectionName: section.sectionName || '',
            classId:     cls ? String(cls._id) : '',
            className:   cls?.className || '',
        };
    };

    const classTeacher      = sections.filter((s) => sid(s.classTeacher) === id).map(where);
    const viceClassTeacher  = sections.filter((s) => sid(s.substituteTeacher) === id).map(where);

    const sectionById = new Map(sections.map((s) => [String(s._id), s]));
    const sstRows = sections.length
        ? await SectionSubjectTeacher.find({
            section: { $in: sections.map((s) => s._id) },
            teacher: teacherId,
        }).populate('subject', 'subjectName').lean()
        : [];
    const subjectTeacher = sstRows
        .filter((r) => sectionById.has(String(r.section)))
        .map((r) => ({
            ...where(sectionById.get(String(r.section))),
            subjectId:   sid(r.subject),
            subjectName: r.subject?.subjectName || '',
        }));

    const subjects = subjectRows.map((s) => ({
        subjectId:   String(s._id),
        subjectName: s.subjectName || '',
        subjectCode: s.subjectCode || '',
    }));

    // ── 2. Library ───────────────────────────────────────────────────────────
    let library = { enabled: !!modules.library, books: [], count: 0 };
    if (modules.library) {
        const loans = await LibraryIssuance.find({
            school: schoolId, issuedTo: teacherId, status: { $in: ACTIVE_ISSUANCE },
        })
            .populate('book', 'title authors isbn')
            .populate('bookCopy', 'uniqueCode')
            .lean();
        const now = Date.now();
        library.books = loans.map((l) => ({
            issuanceId: String(l._id),
            title:      l.book?.title || 'Untitled',
            authors:    l.book?.authors || '',
            isbn:       l.book?.isbn || '',
            copyCode:   l.bookCopy?.uniqueCode || '',
            issueDate:  l.issueDate || null,
            dueDate:    l.dueDate || null,
            status:     l.status,
            overdue:    l.status === 'overdue' || (l.dueDate ? new Date(l.dueDate).getTime() < now : false),
        }));
        library.count = library.books.length;
    }

    // ── 3. Timetable ─────────────────────────────────────────────────────────
    let timetable = { enabled: !!modules.timetable, periods: [], count: 0 };
    if (modules.timetable) {
        timetable.periods = await teacherPeriods(teacherId, schoolId, activeYear);
        timetable.count   = timetable.periods.length;
    }

    const assignmentCount =
        classTeacher.length + viceClassTeacher.length + subjects.length + subjectTeacher.length;

    // Force clears the timetable and nothing else, so it is only on the table
    // when the timetable is all that is left in the way.
    const blockedByAssignments = assignmentCount > 0;
    const blockedByLibrary     = library.count > 0;
    const blockedByTimetable   = timetable.count > 0;

    return {
        assignments: { classTeacher, viceClassTeacher, subjects, subjectTeacher, count: assignmentCount },
        library,
        timetable,
        blocked: blockedByAssignments || blockedByLibrary || blockedByTimetable,
        blockedBy: [
            ...(blockedByAssignments ? ['assignments'] : []),
            ...(blockedByLibrary     ? ['library']     : []),
            ...(blockedByTimetable   ? ['timetable']   : []),
        ],
        canForce: blockedByTimetable && !blockedByAssignments && !blockedByLibrary,
    };
}

/**
 * The teacher's periods in the active year, flattened for display.
 *
 * A merged period carries its extra subjects in `additionalSubjects`, each with
 * its own teacher — so a teacher can hold a slot without being its primary
 * `teacher`. Both are matched, the same way the teacher's own timetable screen
 * does it, or Force Deactivate would leave half the periods still pointing here.
 */
async function teacherPeriods(teacherId, schoolId, activeYear) {
    const id = String(teacherId);
    const sections = await ClassSection.find({
        school: schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}),
    }).select('_id').lean();
    if (!sections.length) return [];

    const timetables = await Timetable.find({ section: { $in: sections.map((s) => s._id) } })
        .select('_id periodsStructure').lean();
    if (!timetables.length) return [];

    const structureByTT = new Map(timetables.map((t) => [String(t._id), t.periodsStructure || []]));
    const entries = await TimetableEntry.find({
        timetable: { $in: timetables.map((t) => t._id) },
        $or: [{ teacher: teacherId }, { 'additionalSubjects.teacher': teacherId }],
    })
        .populate('subject', 'subjectName')
        .populate('additionalSubjects.subject', 'subjectName')
        .populate({
            path: 'timetable',
            select: 'section',
            populate: { path: 'section', select: 'sectionName class', populate: { path: 'class', select: 'className' } },
        })
        .lean();

    return entries
        .map((e) => {
            // Show the subject this teacher actually holds, which on a merged
            // period is not necessarily the slot's primary one.
            let subject = e.subject;
            if (sid(e.teacher) !== id) {
                const extra = (e.additionalSubjects || []).find((a) => sid(a.teacher) === id);
                if (extra) subject = extra.subject;
            }
            const slot = (structureByTT.get(sid(e.timetable)) || [])
                .find((p) => Number(p.periodNumber) === Number(e.periodNumber));
            return {
                entryId:      String(e._id),
                dayOfWeek:    e.dayOfWeek,
                periodNumber: e.periodNumber,
                startTime:    slot?.startTime || '',
                endTime:      slot?.endTime || '',
                subjectName:  subject?.subjectName || '',
                className:    e.timetable?.section?.class?.className || '',
                sectionName:  e.timetable?.section?.sectionName || '',
            };
        })
        .sort((a, b) =>
            DAY_ORDER.indexOf(a.dayOfWeek) - DAY_ORDER.indexOf(b.dayOfWeek)
            || a.periodNumber - b.periodNumber);
}

/**
 * Drop the teacher out of every period they hold, leaving the slots open.
 *
 * The primary teacher is nulled; a merged period's `additionalSubjects` entry is
 * nulled in place rather than removed, because the subject is still taught there
 * — it just has nobody against it, which is exactly what an unassigned slot is.
 *
 * @returns {Promise<Number>} periods cleared
 */
async function unassignTimetable(teacherId, schoolId) {
    const id = String(teacherId);
    const activeYear = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    const sections = await ClassSection.find({
        school: schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}),
    }).select('_id').lean();
    if (!sections.length) return 0;

    const timetables = await Timetable.find({ section: { $in: sections.map((s) => s._id) } })
        .select('_id').lean();
    if (!timetables.length) return 0;

    const entries = await TimetableEntry.find({
        timetable: { $in: timetables.map((t) => t._id) },
        $or: [{ teacher: teacherId }, { 'additionalSubjects.teacher': teacherId }],
    }).select('teacher additionalSubjects').lean();

    let cleared = 0;
    for (const e of entries) {
        const update = {};
        if (sid(e.teacher) === id) update.teacher = null;
        const extras = e.additionalSubjects || [];
        if (extras.some((a) => sid(a.teacher) === id)) {
            update.additionalSubjects = extras.map((a) =>
                (sid(a.teacher) === id ? { ...a, teacher: null } : a));
        }
        if (!Object.keys(update).length) continue;
        await TimetableEntry.updateOne({ _id: e._id }, { $set: update });
        cleared += 1;
    }
    return cleared;
}

/** One line an admin can act on, for the toast that accompanies a refusal. */
function summarise(report) {
    const bits = [];
    if (report.assignments.count) bits.push(`${report.assignments.count} class/subject assignment(s)`);
    if (report.library.count)     bits.push(`${report.library.count} book(s) on loan`);
    if (report.timetable.count)   bits.push(`${report.timetable.count} timetable period(s)`);
    return bits.join(', ');
}

module.exports = { collect, unassignTimetable, summarise, ACTIVE_ISSUANCE };
