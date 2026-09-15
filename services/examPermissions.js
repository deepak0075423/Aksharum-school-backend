'use strict';
/**
 * Who may set an aptitude exam for which section, in which subject.
 *
 *   Class teacher / vice class teacher of a section  → any subject of that
 *     class, and a General Aptitude exam (no subject).
 *   Subject teacher of a section                     → only the subjects they
 *     are assigned to teach in THAT section (SectionSubjectTeacher).
 *   Anyone else                                      → nothing.
 *
 * An exam set for several sections must be allowed in every one of them for
 * its subject. Only the active academic year counts: last year's assignments
 * are history, not permission.
 *
 * "Vice class teacher" is stored as ClassSection.substituteTeacher (see
 * services/teacherDependencies.js). The admin routes do not use this — a school
 * admin, or a teacher whose designation grants module ADMIN access, reaches the
 * admin endpoints instead.
 */
const pool                  = require('../db/pool');
const AcademicYear          = require('../models/AcademicYear');
const ClassSection          = require('../models/ClassSection');
const Class                 = require('../models/Class');
const Subject               = require('../models/Subject');
const ClassSubject          = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const StudentProfile        = require('../models/StudentProfile');
const User                  = require('../models/User');

const qt = (Model) => `"${Model.tableName}"`;
const ROLE_LABEL = { class_teacher: 'Class teacher', vice_class_teacher: 'Vice class teacher', subject_teacher: 'Subject teacher' };

/**
 * Everything this teacher may do, section by section, for the active year.
 *
 * Returns `{ academicYear, sections: Map<sectionId, SectionScope>, subjects: Map<subjectId, name> }`
 * where a SectionScope is
 *   { _id, sectionName, classId, className, classNumber, students,
 *     role: 'class_teacher' | 'vice_class_teacher' | 'subject_teacher',
 *     anySubject: bool, general: bool, subjectIds: string[] }
 */
async function teacherExamScope(schoolId, teacherId) {
    const academicYear = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    const empty = { academicYear, sections: new Map(), subjects: new Map(), names: new Map() };
    if (!academicYear) return empty;

    const me = String(teacherId);
    const [yearSections, assignments, yearSubjects] = await Promise.all([
        ClassSection.find({ school: schoolId, academicYear: academicYear._id, status: 'active' })
            .select('sectionName class classTeacher substituteTeacher').lean(),
        SectionSubjectTeacher.find({ teacher: teacherId }).select('section subject').lean(),
        Subject.find({ school: schoolId, academicYear: academicYear._id }).select('subjectName').lean(),
    ]);
    const subjectName = new Map(yearSubjects.map(s => [String(s._id), s.subjectName]));
    const sectionById = new Map(yearSections.map(s => [String(s._id), s]));

    // Sections they lead, and the subjects they teach section by section.
    const led = new Map();
    for (const s of yearSections) {
        if (String(s.classTeacher || '') === me) led.set(String(s._id), 'class_teacher');
        else if (String(s.substituteTeacher || '') === me) led.set(String(s._id), 'vice_class_teacher');
    }
    const taught = new Map();
    for (const a of assignments) {
        const sec = String(a.section);
        if (!sectionById.has(sec) || !subjectName.has(String(a.subject))) continue;
        if (!taught.has(sec)) taught.set(sec, new Set());
        taught.get(sec).add(String(a.subject));
    }

    const ids = [...new Set([...led.keys(), ...taught.keys()])];
    if (!ids.length) return empty;

    const classIds = [...new Set(ids.map(id => String(sectionById.get(id).class)))];
    const [classes, classSubjects, sectionSubjects, counts] = await Promise.all([
        Class.find({ _id: { $in: classIds } }).select('className classNumber').lean(),
        ClassSubject.find({ class: { $in: classIds } }).select('class subject').lean(),
        SectionSubjectTeacher.find({ section: { $in: ids } }).select('section subject').lean(),
        pool.query(
            `SELECT sp."currentSection" AS id, count(*)::int AS n
               FROM ${qt(StudentProfile)} sp JOIN ${qt(User)} u ON u."_id" = sp."user" AND COALESCE(u."isActive", true)
              WHERE sp."currentSection" = ANY($1::uuid[]) GROUP BY 1`, [ids]),
    ]);
    const classById = new Map(classes.map(c => [String(c._id), c]));
    const students = Object.fromEntries(counts.rows.map(r => [String(r.id), r.n]));

    // "Any subject" for a class teacher means the class's own subjects — those
    // linked to the class, and any taught in the section. A class with no
    // subjects linked at all falls back to every subject of the year, so a
    // school that never set up class subjects is not locked out.
    const subjectsOfSection = (sectionId, classId) => {
        const set = new Set();
        classSubjects.filter(cs => String(cs.class) === classId).forEach(cs => set.add(String(cs.subject)));
        sectionSubjects.filter(ss => String(ss.section) === sectionId).forEach(ss => set.add(String(ss.subject)));
        const known = [...set].filter(id => subjectName.has(id));
        return known.length ? known : [...subjectName.keys()];
    };

    const sections = new Map();
    for (const id of ids) {
        const sec = sectionById.get(id);
        const cls = classById.get(String(sec.class)) || {};
        const role = led.get(id) || 'subject_teacher';
        const leads = role !== 'subject_teacher';
        sections.set(id, {
            _id: id,
            sectionName: sec.sectionName,
            classId: String(sec.class),
            className: cls.className || '',
            classNumber: cls.classNumber ?? null,
            students: students[id] || 0,
            role,
            roleLabel: ROLE_LABEL[role],
            anySubject: leads,
            general: leads,
            subjectIds: leads ? subjectsOfSection(id, String(sec.class)) : [...taught.get(id)],
            // What they teach there themselves, even when they also lead it.
            teaches: [...(taught.get(id) || [])],
        });
    }

    const subjects = new Map();
    for (const s of sections.values()) s.subjectIds.forEach(id => subjects.set(id, subjectName.get(id)));
    // `names` covers every subject of the year, so a refusal can name the one asked for.
    return { academicYear, sections, subjects, names: subjectName };
}

const label = (s) => `${s.className} – ${s.sectionName}`;

/**
 * Whether this scope may set an exam for these sections in this subject.
 * Returns `null` when allowed, or the reason it is not — naming the section and
 * what the teacher may set there, so the message says how to fix it.
 */
function examPermissionError(scope, sectionIds, subjectId) {
    const ids = [...new Set((sectionIds || []).map(String))];
    if (!ids.length) return 'Choose at least one class section';
    const subject = subjectId ? String(subjectId) : null;

    for (const id of ids) {
        const s = scope.sections.get(id);
        if (!s) return 'You can only set exams for a section you are class teacher, vice class teacher or a subject teacher of';
        if (!subject) {
            if (!s.general) {
                return `A General Aptitude exam (no subject) can only be set by a class teacher or vice class teacher. In ${label(s)} you teach ${s.subjectIds.map(x => scope.subjects.get(x)).join(', ')} — choose that subject`;
            }
            continue;
        }
        if (!s.subjectIds.includes(subject)) {
            const name = scope.names?.get(subject) || scope.subjects.get(subject) || 'that subject';
            return s.anySubject
                ? `${name} is not a subject of ${label(s)}`
                : `You are not assigned to teach ${name} in ${label(s)} — you teach ${s.subjectIds.map(x => scope.subjects.get(x)).join(', ')} there`;
        }
    }
    return null;
}

/** The scope as the Create Exam form reads it: classes → sections with their role and allowed subjects. */
function scopeForForm(scope) {
    const byClass = new Map();
    for (const s of scope.sections.values()) {
        if (!byClass.has(s.classId)) byClass.set(s.classId, { _id: s.classId, className: s.className, classNumber: s.classNumber, sections: [] });
        byClass.get(s.classId).sections.push({
            _id: s._id, sectionName: s.sectionName, students: s.students,
            role: s.role, roleLabel: s.roleLabel, general: s.general, anySubject: s.anySubject,
            subjectIds: s.subjectIds, teaches: s.teaches,
        });
    }
    const byName = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
    const classes = [...byClass.values()]
        .sort((a, b) => (a.classNumber ?? 0) - (b.classNumber ?? 0) || byName(a.className, b.className));
    classes.forEach(c => c.sections.sort((a, b) => byName(a.sectionName, b.sectionName)));
    return {
        academicYear: scope.academicYear ? { _id: scope.academicYear._id, name: scope.academicYear.yearName } : null,
        classes,
        subjects: [...scope.subjects.entries()]
            .map(([_id, subjectName]) => ({ _id, subjectName }))
            .sort((a, b) => byName(a.subjectName, b.subjectName)),
        restricted: true,
    };
}

module.exports = { teacherExamScope, examPermissionError, scopeForForm, ROLE_LABEL };
