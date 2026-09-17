'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Which registers a teacher may take — and read, rank and correct.
//
//  Day-wise school (School.attendanceSettings.registrationMode = 'day'):
//    the class teacher and the vice class teacher of a section take its one
//    register a day. A subject teacher has the class for a period and is not
//    who the day is recorded by.
//
//  Subject-wise school ('subject'):
//    a section has one register per subject per day.
//      class / vice class teacher → any subject of the section (they cover)
//      subject teacher            → only the subjects they teach in THAT section
//    The same rule services/examPermissions.js applies to setting exams.
//
//  Only the active academic year counts. A school with no active year cannot be
//  filtered by one, so every section stands — the rule attachedSections() in
//  section.controller has always used.
// ─────────────────────────────────────────────────────────────────────────────
const pool                  = require('../db/pool');
const AcademicYear          = require('../models/AcademicYear');
const ClassSection          = require('../models/ClassSection');
const Class                 = require('../models/Class');
const ClassSubject          = require('../models/ClassSubject');
const Subject               = require('../models/Subject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const StudentProfile        = require('../models/StudentProfile');
const Timetable             = require('../models/Timetable');
const TimetableEntry        = require('../models/TimetableEntry');
const User                  = require('../models/User');
const { registrationMode }  = require('./studentAttendance');

const T = (Model) => `"${Model.tableName}"`;
const ROLE_LABEL = { classTeacher: 'Class Teacher', vice: 'Vice Class Teacher', subject: 'Subject Teacher' };
const ROLE_RANK  = { classTeacher: 0, vice: 1, subject: 2 };

const classLabel = (c) => c?.className || (c?.classNumber != null ? `Class ${c.classNumber}` : 'Class');

/**
 * Everything this teacher may register, section by section.
 *
 * @returns {Promise<{ mode, activeYear, sections: Array<{
 *   _id, sectionName, classId, className, classNumber, label, role, roleLabel,
 *   classTeacher, students,
 *   subjects: Array<{ _id, name, mine, days }>   // subject mode only; [] in day mode
 * }> }>}
 */
async function attendanceScope(schoolId, userId, { mode: forced } = {}) {
    const me = String(userId);
    const [mode, activeYear] = await Promise.all([
        forced || registrationMode(schoolId),
        AcademicYear.findOne({ school: schoolId, status: 'active' }).lean(),
    ]);
    const thisYear = (s) => !activeYear || String(s.academicYear) === String(activeYear._id);

    const [led, links] = await Promise.all([
        ClassSection.find({
            school: schoolId,
            $or: [{ classTeacher: userId }, { substituteTeacher: userId }],
        }).lean(),
        mode === 'subject'
            ? SectionSubjectTeacher.find({ teacher: userId }).select('section subject').lean()
            : [],
    ]);

    const byId = new Map();
    for (const s of led.filter(thisYear)) {
        byId.set(String(s._id), { row: s, role: String(s.classTeacher) === me ? 'classTeacher' : 'vice', mine: new Set() });
    }
    if (mode === 'subject' && links.length) {
        const extraIds = [...new Set(links.map((l) => String(l.section)))].filter((id) => !byId.has(id));
        // A subject link carries no school of its own: re-read the section school-scoped.
        const extra = extraIds.length
            ? await ClassSection.find({ _id: { $in: extraIds }, school: schoolId }).lean()
            : [];
        for (const s of extra.filter(thisYear)) byId.set(String(s._id), { row: s, role: 'subject', mine: new Set() });
        for (const l of links) byId.get(String(l.section))?.mine.add(String(l.subject));
    }
    // A subject teacher with no subject that still exists in the section holds nothing.
    const ids = [...byId.keys()];
    if (!ids.length) return { mode, activeYear, sections: [] };

    const rows = [...byId.values()].map((x) => x.row);
    const classIds = [...new Set(rows.map((s) => String(s.class)))];
    const teacherIds = [...new Set(rows.map((s) => s.classTeacher).filter(Boolean).map(String))];

    const [classes, teachers, counts] = await Promise.all([
        Class.find({ _id: { $in: classIds } }).select('className classNumber').lean(),
        teacherIds.length ? User.find({ _id: { $in: teacherIds } }).select('name').lean() : [],
        pool.query(
            `SELECT sp."currentSection" AS "id", count(*)::int AS "n"
               FROM ${T(StudentProfile)} sp
               JOIN ${T(User)} u ON u."_id" = sp."user" AND u."isActive" IS NOT FALSE
              WHERE sp."currentSection" = ANY($1::uuid[]) GROUP BY 1`, [ids]),
    ]);
    const classOf   = new Map(classes.map((c) => [String(c._id), c]));
    const teacherOf = new Map(teachers.map((t) => [String(t._id), t.name]));
    const studentsOf = new Map(counts.rows.map((r) => [String(r.id), r.n]));

    let subjectsOf = new Map();
    if (mode === 'subject') subjectsOf = await sectionSubjects(schoolId, activeYear, rows, byId);

    const sections = ids.map((id) => {
        const { row, role } = byId.get(id);
        const c = classOf.get(String(row.class));
        return {
            _id: id,
            sectionName: row.sectionName,
            classId: String(row.class),
            className: c?.className || '',
            classNumber: c?.classNumber ?? null,
            label: `${classLabel(c)} (Section ${row.sectionName})`,
            role,
            roleLabel: ROLE_LABEL[role],
            classTeacher: row.classTeacher ? (teacherOf.get(String(row.classTeacher)) || '') : '',
            students: studentsOf.get(id) || 0,
            subjects: subjectsOf.get(id) || [],
        };
    })
        // A subject teacher whose subjects have all been removed has nothing to take.
        .filter((s) => mode !== 'subject' || s.subjects.length)
        .sort((a, b) => (ROLE_RANK[a.role] - ROLE_RANK[b.role])
            || ((a.classNumber ?? 999) - (b.classNumber ?? 999))
            || String(a.sectionName).localeCompare(String(b.sectionName)));

    return { mode, activeYear, sections };
}

/**
 * The subjects each section registers, and which of them this teacher may take.
 * A class / vice class teacher takes any subject of the section: the class's
 * subjects plus any taught in the section, falling back to every subject of the
 * year when a class has none linked (a school that never set them up is not
 * locked out). `days` are the weekdays the section's timetable schedules it.
 */
async function sectionSubjects(schoolId, activeYear, rows, byId) {
    const ids = rows.map((s) => String(s._id));
    const classIds = [...new Set(rows.map((s) => String(s.class)))];
    const [classSubjects, sectionLinks, timetables] = await Promise.all([
        ClassSubject.find({ class: { $in: classIds } }).select('class subject').lean(),
        SectionSubjectTeacher.find({ section: { $in: ids } }).select('section subject').lean(),
        Timetable.find({ section: { $in: ids }, ...(activeYear ? { academicYear: activeYear._id } : {}) })
            .select('_id section').lean(),
    ]);
    const entries = timetables.length
        ? await TimetableEntry.find({ timetable: { $in: timetables.map((t) => t._id) } })
            .select('timetable dayOfWeek subject additionalSubjects').lean()
        : [];

    const setOf = new Map(ids.map((id) => [id, new Set()]));
    for (const s of rows) {
        classSubjects.filter((cs) => String(cs.class) === String(s.class))
            .forEach((cs) => setOf.get(String(s._id)).add(String(cs.subject)));
    }
    sectionLinks.forEach((l) => setOf.get(String(l.section))?.add(String(l.subject)));

    const sectionOfTimetable = new Map(timetables.map((t) => [String(t._id), String(t.section)]));
    const daysOf = new Map();   // `${section}|${subject}` → Set(dayOfWeek)
    for (const e of entries) {
        const section = sectionOfTimetable.get(String(e.timetable));
        const subjects = [e.subject, ...(e.additionalSubjects || []).map((a) => a.subject)].filter(Boolean);
        for (const sub of subjects) {
            const key = `${section}|${sub}`;
            if (!daysOf.has(key)) daysOf.set(key, new Set());
            daysOf.get(key).add(e.dayOfWeek);
            setOf.get(section)?.add(String(sub));
        }
    }

    const allIds = new Set(ids.flatMap((id) => [...setOf.get(id), ...byId.get(id).mine]));
    const yearSubjects = await Subject.find({
        school: schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}),
    }).select('subjectName').lean();
    const nameOf = new Map(yearSubjects.map((s) => [String(s._id), s.subjectName]));
    const missing = [...allIds].filter((id) => !nameOf.has(id));
    if (missing.length) {
        (await Subject.find({ _id: { $in: missing }, school: schoolId }).select('subjectName').lean())
            .forEach((s) => nameOf.set(String(s._id), s.subjectName));
    }

    const out = new Map();
    for (const id of ids) {
        const { role, mine } = byId.get(id);
        let candidates = role === 'subject' ? [...mine] : [...setOf.get(id), ...mine];
        if (role !== 'subject' && !candidates.filter((x) => nameOf.has(x)).length) candidates = yearSubjects.map((s) => String(s._id));
        const subjects = [...new Set(candidates)]
            .filter((sid) => nameOf.has(sid))
            .map((sid) => ({
                _id: sid,
                name: nameOf.get(sid),
                mine: mine.has(sid),
                days: [...(daysOf.get(`${id}|${sid}`) || [])],
            }))
            .sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
        out.set(id, subjects);
    }
    return out;
}

/**
 * The register a request names, checked against the scope — never trusted.
 * Without `sectionId` the teacher means their first section; without
 * `subjectId` in a subject-wise school, the first subject they may take there.
 *
 * @returns {{ section, subject, error? }}
 */
function pickRegister(scope, sectionId, subjectId, { requireSubject = false } = {}) {
    const section = sectionId
        ? scope.sections.find((s) => s._id === String(sectionId))
        : scope.sections[0];
    if (!section) {
        return { section: null, subject: null, error: sectionId ? 'You do not take attendance for that section' : 'No section is assigned to you' };
    }
    if (scope.mode !== 'subject') return { section, subject: null };

    if (!subjectId) {
        if (requireSubject) return { section, subject: null, error: 'Choose the subject this register is for' };
        return { section, subject: section.subjects[0] || null };
    }
    const subject = section.subjects.find((s) => s._id === String(subjectId));
    if (!subject) return { section, subject: null, error: `You do not take ${section.label} for that subject` };
    return { section, subject };
}

/**
 * Whether this scope may act on a register of `sectionId` with `subjectId`
 * (null = a day register). Lead roles act on every register of their section,
 * day or subject, including ones taken before the school changed mode.
 */
function holdsRegister(scope, sectionId, subjectId) {
    const section = scope.sections.find((s) => s._id === String(sectionId));
    if (!section) return false;
    if (section.role !== 'subject') return true;
    return !!subjectId && section.subjects.some((s) => s._id === String(subjectId));
}

/**
 * Active students of a section, the section's roster by both pointers — the
 * profile's currentSection, and the section's enrolledStudents for a student
 * whose profile names no section. Ordered by roll number, then name.
 */
async function sectionStudents(schoolId, sectionId) {
    const { rows } = await pool.query(
        `SELECT u."_id", u."name", u."profileImage" AS "photo", sp."rollNumber"
           FROM ${T(User)} u
           LEFT JOIN ${T(StudentProfile)} sp ON sp."user" = u."_id" AND sp."school" = $2
          WHERE u."role" = 'student' AND u."school" = $2 AND u."isActive" IS NOT FALSE
            AND (sp."currentSection" = $1
                 OR (sp."currentSection" IS NULL AND u."_id"::text IN (
                        SELECT jsonb_array_elements_text(
                                 CASE WHEN jsonb_typeof(cs."enrolledStudents") = 'array'
                                      THEN cs."enrolledStudents" ELSE '[]'::jsonb END)
                          FROM ${T(ClassSection)} cs WHERE cs."_id" = $1)))
          ORDER BY NULLIF(regexp_replace(COALESCE(sp."rollNumber", ''), '\\D', '', 'g'), '')::numeric NULLS LAST, u."name"`,
        [String(sectionId), String(schoolId)],
    );
    return rows;
}

/**
 * Every subject a section registers, for the office — which takes any of them.
 * Same sources as a class teacher's list (class subjects, section assignments,
 * the timetable, falling back to the year's subjects).
 */
async function officeSectionSubjects(schoolId, sectionId) {
    const row = await ClassSection.findOne({ _id: sectionId, school: schoolId }).lean();
    if (!row) return [];
    const activeYear = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    const year = activeYear && String(row.academicYear) === String(activeYear._id)
        ? activeYear
        : (row.academicYear ? await AcademicYear.findById(row.academicYear).lean() : null);
    const byId = new Map([[String(row._id), { row, role: 'classTeacher', mine: new Set() }]]);
    const out = await sectionSubjects(schoolId, year, [row], byId);
    return (out.get(String(row._id)) || []).map(({ _id, name, days }) => ({ _id, name, days }));
}

module.exports = { attendanceScope, pickRegister, holdsRegister, sectionStudents, officeSectionSubjects, ROLE_LABEL };
