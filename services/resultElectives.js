'use strict';
/**
 * Electives (Oct 2026): who in a section takes which optional subject.
 *
 * Every subject of an exam used to be every student's: a student who studies
 * French had to be marked absent in Sanskrit for the sheet to go in — and
 * failed the exam for it. A subject given a roster here is its takers' alone:
 * on its marks sheet, in its class tests, in their results and on their exam
 * schedule; nobody else is "absent" from it. A subject with no roster is taken
 * by the whole section, as before.
 *
 * The office sets them for any section; a class (or vice class) teacher for
 * their own.
 */
const pool = require('../db/pool');
const ElectiveRoster = require('../models/ElectiveRoster');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const ClassSubject = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Subject = require('../models/Subject');
const AcademicYear = require('../models/AcademicYear');
const FormalExam = require('../models/FormalExam');
const User = require('../models/User');
const { isUuid } = require('../db/schema');
const { RuleError, trail } = require('./resultExams');
const board = require('./resultBoard');

const fail = (status, message) => { throw new RuleError(status, message); };
const jarr = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;

async function yearsOf(schoolId) {
    return AcademicYear.find({ school: schoolId }).select('yearName status startDate').sort({ startDate: -1 }).lean();
}

/** The sections a caller may set electives for: every one of the year, or a teacher's own. */
async function sectionsOf(schoolId, yearId, teacherId = null) {
    const params = [String(schoolId), String(yearId)];
    let mine = '';
    if (teacherId) { params.push(String(teacherId)); mine = `AND (s."classTeacher" = $3::uuid OR s."substituteTeacher" = $3::uuid)`; }
    const { rows } = await pool.query(`
        SELECT s."_id", s."sectionName", s."class", c."className", c."classNumber"
          FROM "${ClassSection.tableName}" s JOIN "${Class.tableName}" c ON c."_id" = s."class"
         WHERE s."school" = $1::uuid AND s."academicYear" = $2::uuid AND COALESCE(s."status", 'active') <> 'archived' ${mine}
         ORDER BY c."classNumber" NULLS LAST, c."className", s."sectionName"`, params);
    return rows;
}

/** The subjects a section can be examined in: its class's, and anything taught in it. */
async function subjectsOf(section) {
    const { rows } = await pool.query(`
        SELECT DISTINCT sub."_id", sub."subjectName", sub."subjectCode", sub."type"
          FROM "${Subject.tableName}" sub
         WHERE sub."_id" IN (SELECT cs."subject" FROM "${ClassSubject.tableName}" cs WHERE cs."class" = $1::uuid
                             UNION SELECT st."subject" FROM "${SectionSubjectTeacher.tableName}" st WHERE st."section" = $2::uuid)
         ORDER BY sub."subjectName"`, [String(section.class), String(section._id)]);
    return rows;
}

/**
 * GET …/results/electives — the year, its sections, and the chosen section's
 * subjects (an elective first), each with who takes it, beside the roll.
 */
async function electivesBoard(schoolId, { academicYear, sectionId, teacherId = null } = {}) {
    const years = await yearsOf(schoolId);
    const year = years.find((y) => String(y._id) === String(academicYear || '')) || years.find((y) => y.status === 'active') || years[0] || null;
    const base = {
        years: years.map((y) => ({ _id: y._id, yearName: y.yearName, current: y.status === 'active' })),
        year: year ? { _id: year._id, yearName: year.yearName } : null, sections: [], section: null, subjects: [], students: [],
    };
    if (!year) return base;
    const sections = await sectionsOf(schoolId, year._id, teacherId);
    const section = sections.find((s) => String(s._id) === String(sectionId || '')) || sections[0] || null;
    const out = { ...base, sections: sections.map((s) => ({ _id: s._id, sectionName: s.sectionName, className: s.className })) };
    if (!section) return out;
    const [subjects, rosters, students] = await Promise.all([
        subjectsOf(section),
        ElectiveRoster.find({ section: section._id }).lean(),
        board.rosterRows(section._id),
    ]);
    const rosterOf = new Map(rosters.map((r) => [String(r.subject), r]));
    const onRoll = new Set(students.map((u) => String(u._id)));
    const who = await User.find({ _id: { $in: rosters.map((r) => r.updatedBy).filter(Boolean) } }).select('name').lean();
    const nameOf = new Map(who.map((u) => [String(u._id), u.name]));
    return {
        ...out,
        section: { _id: section._id, sectionName: section.sectionName, className: section.className },
        subjects: subjects.map((s) => {
            const r = rosterOf.get(String(s._id));
            return {
                _id: s._id, subjectName: s.subjectName, subjectCode: s.subjectCode || '', type: s.type || '',
                elective: !!r,
                // Takers still on the roll; one who left keeps nothing here.
                students: r ? (r.students || []).map(String).filter((id) => onRoll.has(id)) : null,
                updatedAt: r?.updatedAt || null, updatedBy: r ? nameOf.get(String(r.updatedBy)) || '' : '',
            };
        }).sort((a, b) => (b.elective - a.elective) || (b.type === 'elective') - (a.type === 'elective') || a.subjectName.localeCompare(b.subjectName)),
        students: students.map((u) => ({ _id: u._id, name: u.name, rollNumber: u.rollNumber || '', admissionNumber: u.admissionNumber || '' })),
    };
}

/**
 * PUT …/results/electives — one subject's takers in one section. `students`
 * null makes it everyone's subject again. A published result is not changed
 * by this (it is worked out again only if withdrawn and republished) — the
 * reply says so when there is one.
 */
async function saveElective(ctx, { sectionId, subjectId, students } = {}) {
    if (!isUuid(String(sectionId || '')) || !isUuid(String(subjectId || ''))) fail(400, 'Choose the section and the subject');
    const section = await ClassSection.findOne({ _id: sectionId, school: ctx.schoolId }).select('sectionName class academicYear enrolledStudents').lean();
    if (!section) fail(404, 'Section not found');
    if (ctx.userRole === 'teacher') {
        const { rows } = await pool.query(`SELECT 1 FROM "${ClassSection.tableName}" WHERE "_id" = $1::uuid AND ("classTeacher" = $2::uuid OR "substituteTeacher" = $2::uuid)`,
            [String(section._id), String(ctx.userId)]);
        if (!rows.length) fail(403, 'Only the section\'s class teacher can set its electives');
    }
    const subjects = await subjectsOf(section);
    const subject = subjects.find((s) => String(s._id) === String(subjectId));
    if (!subject) fail(400, 'That subject is not taught in this section');
    const cls = section.class ? await Class.findById(section.class).select('className').lean() : null;
    const where = [cls?.className, section.sectionName].filter(Boolean).join(' – ');

    if (students === null || students === undefined || students === 'all') {
        await ElectiveRoster.deleteOne({ section: section._id, subject: subject._id });
        trail(ctx, 'ELECTIVE_CLEARED', 'Electives', section._id, `${subject.subjectName} in ${where} is every student's subject again`);
    } else {
        if (!Array.isArray(students)) fail(400, 'Give the students who take the subject');
        const roll = new Set((section.enrolledStudents || []).map(String));
        const ids = [...new Set(students.map(String))].filter(isUuid);
        const stray = ids.filter((id) => !roll.has(id));
        if (stray.length) fail(400, `${stray.length} of those students ${stray.length === 1 ? 'is' : 'are'} not on this section's roll`);
        const { newId } = require('../db/schema');
        await pool.query(
            `INSERT INTO "${ElectiveRoster.tableName}" ("_id", "school", "section", "subject", "students", "updatedBy", "createdAt", "updatedAt")
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6::uuid, now(), now())
             ON CONFLICT ("section", "subject") DO UPDATE SET "students" = EXCLUDED."students", "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = now()`,
            [newId(), String(ctx.schoolId), String(section._id), String(subject._id), JSON.stringify(ids), String(ctx.userId)]);
        trail(ctx, 'ELECTIVE_SET', 'Electives', section._id, `${subject.subjectName} in ${where}: ${ids.length} student${ids.length === 1 ? '' : 's'}`);
    }
    // Results already published in the section with this subject keep their figures.
    const { rows: [pub] } = await pool.query(
        `SELECT count(*)::int AS "n" FROM "${FormalExam.tableName}" e
          WHERE e."section" = $1::uuid AND e."status" = 'FINAL_APPROVED'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(${jarr('e."subjects"')}) x WHERE x->>'subject' = $2)`,
        [String(section._id), String(subject._id)]);
    return {
        ...(await electivesBoard(ctx.schoolId, { academicYear: section.academicYear, sectionId: section._id, teacherId: ctx.userRole === 'teacher' ? ctx.userId : null })),
        note: pub?.n ? `${pub.n} published exam${pub.n === 1 ? '' : 's'} already include ${subject.subjectName} — their results keep the figures they were published with unless they are withdrawn and published again.` : '',
    };
}

module.exports = { electivesBoard, saveElective };
