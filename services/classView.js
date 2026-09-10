'use strict';
/**
 * One student's class, as every role sees it.
 *
 * The student's own page and the parent's page ask the same question about the
 * same student, so they ask it through one builder rather than two that drift.
 * The parent endpoint calls this once per child — a parent with two children in
 * different classes gets two complete answers, not the first child's twice.
 */
const StudentProfile        = require('../models/StudentProfile');
const ClassSection          = require('../models/ClassSection');
const Class                 = require('../models/Class');
const User                  = require('../models/User');
const AcademicYear          = require('../models/AcademicYear');   // registered for populate()
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const ClassMonitor          = require('../models/ClassMonitor');
const ClassAnnouncement     = require('../models/ClassAnnouncement');
const ClassSubject          = require('../models/ClassSubject');

void AcademicYear;   // required for its side effect: populate('academicYear')

const EMPTY = { subjectTeachers: [], monitors: [], classmates: [], announcements: [], subjects: [] };

/**
 * A student belongs to a section by either route — the profile's `currentSection`
 * pointer or the section's own `enrolledStudents` roster — and the two are not
 * always in step. Reading the pointer alone told students placed through the
 * roster that they had no class at all.
 */
async function findSection(profile, studentId, schoolId) {
    if (profile?.currentSection) return profile.currentSection;
    const scope = schoolId ? { enrolledStudents: studentId, school: schoolId } : { enrolledStudents: studentId };
    const bySection = await ClassSection.findOne(scope).select('_id').lean();
    return bySection?._id || null;
}

/**
 * @param {object}  opts
 * @param {string}  opts.studentId  the student's User id
 * @param {string} [opts.schoolId]  scopes every lookup when given
 * @param {object} [opts.profile]   an already-loaded StudentProfile, to save a query
 */
async function classViewFor({ studentId, schoolId, profile: known }) {
    const profile = known || await StudentProfile.findOne(
        schoolId ? { user: studentId, school: schoolId } : { user: studentId },
    ).lean();

    const sectionId = await findSection(profile, studentId, schoolId);
    const section   = sectionId
        ? await ClassSection.findById(sectionId)
            .populate('class', 'className classNumber')
            .populate('classTeacher',      'name email')
            .populate('substituteTeacher', 'name email')
            .populate('academicYear',      'yearName')
            .lean()
        : null;

    if (!section) {
        // Admitted to a class but not placed in a section yet is a real state —
        // the class shuffle exists to resolve exactly it — so name the class
        // rather than claiming there is none.
        const cls = profile?.currentClass
            ? await Class.findById(profile.currentClass).select('className classNumber').lean()
            : null;
        return { ...EMPTY, profile, section: null, pendingClass: cls || null };
    }

    const [subjectLinks, monitorRows, classmateUsers, announcements, subjectRows] = await Promise.all([
        SectionSubjectTeacher.find({ section: section._id })
            .populate('subject', 'subjectName')
            .populate('teacher', 'name')
            .lean().catch(() => []),
        ClassMonitor.find({ section: section._id, status: 'active' }).lean().catch(() => []),
        User.find({ _id: { $in: section.enrolledStudents || [] } }).select('name').lean(),
        ClassAnnouncement.find({ section: section._id, status: 'active' })
            .sort({ createdAt: -1 }).limit(10).lean().catch(() => []),
        // What the class offers, whether or not a teacher is attached to it yet
        ClassSubject.find({ class: section.class?._id || section.class })
            .populate('subject', 'subjectName').lean().catch(() => []),
    ]);

    const rosterIds = (classmateUsers || []).map((c) => c._id);
    const profiles  = rosterIds.length
        ? await StudentProfile.find({ user: { $in: rosterIds } }).select('user rollNumber').lean()
        : [];
    const rollByUser = Object.fromEntries(profiles.map((p) => [String(p.user), p.rollNumber]));

    const classmates = (classmateUsers || [])
        .map((c) => ({
            _id:        c._id,
            name:       c.name,
            rollNumber: rollByUser[String(c._id)] || '',
            isMe:       String(c._id) === String(studentId),
        }))
        .sort((a, b) =>
            String(a.rollNumber).localeCompare(String(b.rollNumber), undefined, { numeric: true })
            || String(a.name).localeCompare(String(b.name)));

    // One line per subject+teacher pair, however many periods they hold.
    const seen = new Set();
    const subjectTeachers = [];
    (subjectLinks || []).forEach((st) => {
        if (!st.subject) return;
        const key = `${st.subject._id}:${st.teacher?._id}`;
        if (seen.has(key)) return;
        seen.add(key);
        subjectTeachers.push({ subject: st.subject.subjectName, teacher: st.teacher?.name || '' });
    });

    const nameById = Object.fromEntries((classmateUsers || []).map((u) => [String(u._id), u.name]));
    // A monitor is normally on the roster, but the two can drift — look up the
    // stragglers rather than dropping them from the list without a word.
    const strays = (monitorRows || [])
        .map((m) => String(m.student)).filter((id) => id && !nameById[id]);
    if (strays.length) {
        (await User.find({ _id: { $in: [...new Set(strays)] } }).select('name').lean())
            .forEach((u) => { nameById[String(u._id)] = u.name; });
    }
    const monitors = (monitorRows || [])
        .map((m) => ({ _id: m._id, name: nameById[String(m.student)] || '' }))
        .filter((m) => m.name);

    const subjects = (subjectRows || [])
        .filter((r) => r.subject)
        .map((r) => ({ _id: r.subject._id, name: r.subject.subjectName }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return { profile, section, pendingClass: null, subjectTeachers, monitors, classmates, announcements, subjects };
}

module.exports = { classViewFor };
