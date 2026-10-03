'use strict';
/**
 * Exam schedules — the formal exams' papers, as students, parents and
 * teachers see them (Oct 2026).
 *
 * Everything comes from the exams the office creates in the Result module:
 * each paper's date and its start and end time (FormalExam.subjects). Nothing
 * is entered twice — move a paper on the exam and every schedule moves too.
 *
 *   a student   the exams of their own section — and of any section whose
 *               roll they are on, so last year's still shows after a promotion
 *   a parent    the same, for each child, at every school the person is a
 *               parent at (services/parentChildren.childrenAcrossSchools)
 *   a teacher   the exams of every section they teach a subject in or are
 *               class teacher of, with their own papers and class marked
 *   the office  every section's, with each exam's status and the papers of
 *               one class that clash across two exams
 *
 * An exam is on the schedule from the moment it is created. "Show exam in
 * student portal" switched off keeps it from students and parents (not from
 * its teachers); an archived exam has been put away and leaves every schedule.
 *
 * Paper dates are stored at UTC midnight of the day they mean, and "today" is
 * the school's day (config/timezone), so the two are compared as days.
 */
const pool = require('../db/pool');
const TZ = require('../config/timezone');
const { isUuid } = require('../db/schema');
const FormalExam = require('../models/FormalExam');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const AcademicYear = require('../models/AcademicYear');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const StudentProfile = require('../models/StudentProfile');
const Subject = require('../models/Subject');
const { visibleToFamilies, todayOf } = require('./resultExams');
const ElectiveRoster = require('../models/ElectiveRoster');
const { typeLabelOf } = require('./resultSettings');
const { studentCard } = require('./resultFamily');

const t = (M) => `"${M.tableName}"`;
const T = {
    exams: t(FormalExam), sections: t(ClassSection), classes: t(Class), years: t(AcademicYear),
    sst: t(SectionSubjectTeacher), profiles: t(StudentProfile), subjects: t(Subject),
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const dayIso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
/** The school's today, as YYYY-MM-DD — on its own clock (services/schoolClock). */
const todayIso = (schoolId = null) => (schoolId ? todayOf(schoolId)
    : new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));

/** Ongoing first, then what is coming soonest, then what is over, latest first. */
const ORDER = { ongoing: 0, upcoming: 1, completed: 2 };
function sortExams(list) {
    return list.sort((a, b) => ORDER[a.when] - ORDER[b.when]
        || (a.when === 'completed'
            ? String(b.endDate || '').localeCompare(String(a.endDate || ''))
            : String(a.startDate || '').localeCompare(String(b.startDate || '')))
        || (a.classNumber ?? 99) - (b.classNumber ?? 99) || String(a.sectionName).localeCompare(String(b.sectionName)));
}

/**
 * The exams of these sections, each with its papers in sitting order.
 *   family    leave out what the office keeps off the student portal
 *   teacher   mark the papers this teacher teaches, and their own class
 */
async function examsFor(schoolId, sectionIds, { family = false, teacherId = null, studentId = null } = {}) {
    const ids = [...new Set((sectionIds || []).map(String).filter(isUuid))];
    if (!ids.length) return [];
    const params = [String(schoolId), ids];
    const mine = teacherId ? `(s."classTeacher" = $3::uuid OR s."substituteTeacher" = $3::uuid)` : 'false';
    if (teacherId) params.push(String(teacherId));
    const { rows } = await pool.query(`
        SELECT e."_id", e."school", e."title", e."code", e."examType", e."typeLabel", e."description", e."startDate", e."endDate", e."status", e."timetableShared",
               e."publishDate", e."finalApprovedAt", e."showInPortal", e."subjects", e."section" AS "sectionId",
               s."sectionName", c."className", c."classNumber", y."yearName", ${mine} AS "myClass"
          FROM ${T.exams} e
          JOIN ${T.sections} s ON s."_id" = e."section"
          LEFT JOIN ${T.classes} c ON c."_id" = s."class"
          LEFT JOIN ${T.years} y ON y."_id" = e."academicYear"
         WHERE e."school" = $1::uuid AND e."section" = ANY($2::uuid[]) AND e."archivedAt" IS NULL
           ${family ? `AND e."showInPortal" IS DISTINCT FROM false AND e."timetableShared" IS DISTINCT FROM false` : ''}`, params);
    if (!rows.length) return [];

    const subjectIds = [...new Set(rows.flatMap((r) => (Array.isArray(r.subjects) ? r.subjects : []).map((x) => String(x.subject))).filter(isUuid))];
    const [{ rows: subs }, { rows: taught }] = await Promise.all([
        subjectIds.length
            ? pool.query(`SELECT "_id", "subjectName", "subjectCode" FROM ${T.subjects} WHERE "_id" = ANY($1::uuid[])`, [subjectIds])
            : { rows: [] },
        teacherId
            ? pool.query(`SELECT "section", "subject" FROM ${T.sst} WHERE "teacher" = $1::uuid AND "section" = ANY($2::uuid[])`, [String(teacherId), ids])
            : { rows: [] },
    ]);
    const subOf = new Map(subs.map((x) => [String(x._id), x]));
    const teaches = new Set(taught.map((x) => `${x.section}:${x.subject}`));
    // A student's own schedule leaves out the electives they do not take.
    const notMine = new Set();
    if (studentId) {
        const rosters = await ElectiveRoster.find({ section: { $in: ids } }).select('section subject students').lean();
        rosters.forEach((r) => {
            if (!(r.students || []).map(String).includes(String(studentId))) notMine.add(`${r.section}:${r.subject}`);
        });
    }
    const today = todayIso(schoolId);
    const now = new Date();

    return sortExams(rows.map((r) => {
        const papers = (Array.isArray(r.subjects) ? r.subjects : []).filter((x) => !notMine.has(`${r.sectionId}:${x.subject}`)).map((x) => {
            const sub = subOf.get(String(x.subject));
            const date = dayIso(x.examDate);
            return {
                subjectId: String(x.subject), subjectName: sub?.subjectName || 'Subject', subjectCode: sub?.subjectCode || '',
                date, startTime: x.startTime || '', endTime: x.endTime || '',
                maxMarks: num(x.maxMarks), passingMarks: num(x.passingMarks), order: num(x.order),
                done: !!date && date < today, today: date === today,
                ...(teacherId ? { mine: teaches.has(`${r.sectionId}:${x.subject}`) } : {}),
            };
        }).sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999'))
            || a.startTime.localeCompare(b.startTime) || a.order - b.order);
        const startDate = dayIso(r.startDate);
        const endDate = dayIso(r.endDate);
        const when = endDate && endDate < today ? 'completed' : startDate && startDate > today ? 'upcoming' : 'ongoing';
        const published = r.status === 'FINAL_APPROVED';
        return {
            _id: r._id, title: r.title, code: r.code || '', examType: r.examType, examTypeLabel: typeLabelOf(r), status: r.status,
            timetableShared: r.timetableShared !== false,
            description: r.description || '', startDate, endDate, when,
            sectionId: r.sectionId, className: r.className || '', classNumber: r.classNumber, sectionName: r.sectionName || '', yearName: r.yearName || '',
            myClass: !!r.myClass,
            // Results, once there are any: a family sees them on the Results page.
            results: published ? { published: true, visible: family ? visibleToFamilies({ ...r, status: r.status }, now) : true } : null,
            papers,
            dated: papers.filter((p) => p.date).length,
        };
    }));
}

/** The next paper still to be sat, across these exams — what a schedule leads with. */
function nextPaper(exams) {
    let best = null;
    exams.forEach((e) => e.papers.forEach((p) => {
        if (!p.date || p.done) return;
        const key = `${p.date} ${p.startTime || '99:99'}`;
        if (!best || key < best.key) best = { key, exam: { _id: e._id, title: e.title, className: e.className, sectionName: e.sectionName }, ...p };
    }));
    if (!best) return null;
    const { key, ...out } = best;
    return out;
}

/** A student's schedule: their section's exams, and those of any roll they are on. */
async function studentSchedule(schoolId, studentId) {
    const [student, { rows }] = await Promise.all([
        studentCard(schoolId, studentId),
        pool.query(`
            SELECT s."_id" FROM ${T.sections} s
             WHERE s."school" = $1::uuid
               AND (s."enrolledStudents" @> jsonb_build_array($2::text)
                    OR s."_id" = (SELECT p."currentSection" FROM ${T.profiles} p WHERE p."user" = $3::uuid ORDER BY p."createdAt" DESC NULLS LAST LIMIT 1))`,
        [String(schoolId), String(studentId), String(studentId)]),
    ]);
    const exams = await examsFor(schoolId, rows.map((r) => r._id), { family: true, studentId });
    return { student, exams, next: nextPaper(exams), today: todayIso(schoolId) };
}

/**
 * A teacher's schedule: every section they teach a subject in or are class
 * teacher of — this year's first — and those sections' exams.
 */
async function teacherSchedule(schoolId, teacherId) {
    const { rows: sections } = await pool.query(`
        SELECT s."_id", s."sectionName", c."className", c."classNumber", y."yearName", (y."status" = 'active') AS "current",
               (s."classTeacher" = $1::uuid OR s."substituteTeacher" = $1::uuid) AS "myClass",
               COALESCE((SELECT jsonb_agg(sub."subjectName" ORDER BY sub."subjectName")
                           FROM ${T.sst} st JOIN ${T.subjects} sub ON sub."_id" = st."subject"
                          WHERE st."section" = s."_id" AND st."teacher" = $1::uuid), '[]'::jsonb) AS "mySubjects"
          FROM ${T.sections} s
          LEFT JOIN ${T.classes} c ON c."_id" = s."class"
          LEFT JOIN ${T.years} y ON y."_id" = s."academicYear"
         WHERE s."school" = $2::uuid AND COALESCE(s."status", 'active') <> 'archived'
           AND (s."classTeacher" = $1::uuid OR s."substituteTeacher" = $1::uuid
                OR EXISTS (SELECT 1 FROM ${T.sst} st WHERE st."section" = s."_id" AND st."teacher" = $1::uuid))
         ORDER BY (y."status" = 'active') DESC, c."classNumber" NULLS LAST, s."sectionName"`, [String(teacherId), String(schoolId)]);
    const exams = await examsFor(schoolId, sections.map((x) => x._id), { teacherId });
    return {
        sections: sections.map((x) => ({
            _id: x._id, className: x.className || '', sectionName: x.sectionName || '', yearName: x.yearName || '',
            current: x.current !== false, myClass: !!x.myClass, mySubjects: Array.isArray(x.mySubjects) ? x.mySubjects : [],
        })),
        exams,
        next: nextPaper(exams.map((e) => ({ ...e, papers: e.papers.filter((p) => p.mine || e.myClass) }))),
        today: todayIso(schoolId),
    };
}

/**
 * The office's schedule: every section's exams, this year's sections first —
 * the school's papers day by day. Each exam carries its status, so one still
 * being planned is told from one under way; and a paper that overlaps another
 * EXAM's paper for the same section is marked `clash` — the exam form refuses
 * two overlapping papers within one exam, but nothing stopped a unit test and
 * a mid-term being set for the same class at the same hour.
 */
async function officeSchedule(schoolId) {
    const { rows: sections } = await pool.query(`
        SELECT s."_id", s."sectionName", c."className", c."classNumber", y."yearName", (y."status" = 'active') AS "current"
          FROM ${T.sections} s
          LEFT JOIN ${T.classes} c ON c."_id" = s."class"
          LEFT JOIN ${T.years} y ON y."_id" = s."academicYear"
         WHERE s."school" = $1::uuid AND COALESCE(s."status", 'active') <> 'archived'
           AND EXISTS (SELECT 1 FROM ${T.exams} e WHERE e."section" = s."_id" AND e."archivedAt" IS NULL)
         ORDER BY (y."status" = 'active') DESC, c."classNumber" NULLS LAST, s."sectionName"`, [String(schoolId)]);
    const exams = await examsFor(schoolId, sections.map((x) => x._id));
    // Papers of one section, on one day, at overlapping times, in different exams.
    const bySection = new Map();
    exams.forEach((e) => e.papers.forEach((p) => {
        if (!p.date || !p.startTime) return;
        const k = `${e.sectionId}:${p.date}`;
        if (!bySection.has(k)) bySection.set(k, []);
        bySection.get(k).push({ e, p });
    }));
    for (const list of bySection.values()) {
        list.forEach((a, i) => list.slice(i + 1).forEach((b) => {
            if (String(a.e._id) === String(b.e._id)) return;
            const aEnd = a.p.endTime || a.p.startTime; const bEnd = b.p.endTime || b.p.startTime;
            if (a.p.startTime < bEnd && b.p.startTime < aEnd || a.p.startTime === b.p.startTime) {
                a.p.clash = `${b.p.subjectName} of ${b.e.title}`;
                b.p.clash = `${a.p.subjectName} of ${a.e.title}`;
            }
        }));
    }
    return {
        sections: sections.map((x) => ({
            _id: x._id, className: x.className || '', sectionName: x.sectionName || '', yearName: x.yearName || '',
            current: x.current !== false, myClass: false, mySubjects: [],
        })),
        exams, next: nextPaper(exams), today: todayIso(schoolId),
    };
}

module.exports = { examsFor, studentSchedule, teacherSchedule, officeSchedule, nextPaper, todayIso };
