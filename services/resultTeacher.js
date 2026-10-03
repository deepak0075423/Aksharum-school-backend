'use strict';
/**
 * Results as a teacher works with them (Oct 2026 redesign).
 *
 *   marks       every live exam with a subject this teacher teaches in its
 *               section — one line per subject, with how far its sheet has got
 *   validation  as class teacher: exams whose every sheet is in, and class
 *               tests submitted for approval
 *   tests       the class tests this teacher set
 *   published   published results of the sections they teach or look after
 *
 * Only reads. Whether a teacher may DO something is still decided by
 * services/resultExams (formal exams) and controllers/classTest (class tests);
 * the readers here check the same relationship before showing anything — a
 * sheet to its subject teacher, a review to its class teacher — because these
 * are every student's marks.
 */
const pool = require('../db/pool');
const FormalExam = require('../models/FormalExam');
const ExamMarksSheet = require('../models/ExamMarksSheet');
const ClassTest = require('../models/ClassTest');
const ClassSection = require('../models/ClassSection');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const User = require('../models/User');
const { isUuid } = require('../db/schema');
const { STATUS_LABELS, MARKS_OPEN, RuleError, overallGrade } = require('./resultExams');
const settings = require('./resultSettings');
const board = require('./resultBoard');

const { T: TB, ROSTER, ANSWERED, jarr } = board.SQL;
/**
 * An elective's own count: its roster's students who are on the roll and
 * active — NULL when the subject has no elective roster (everyone takes it).
 */
const TAKERS = (section, subject) => `(SELECT CASE WHEN count(er."_id") = 0 THEN NULL ELSE count(tu."_id")::int END
          FROM "electiverosters" er
          LEFT JOIN LATERAL jsonb_array_elements_text(${jarr('er."students"')}) v ON true
          LEFT JOIN ${TB.users} tu ON tu."_id"::text = v AND tu."role" = 'student' AND tu."isActive" IS NOT FALSE
           AND v IN (SELECT jsonb_array_elements_text(${jarr('ts."enrolledStudents"')}) FROM ${TB.sections} ts WHERE ts."_id" = er."section")
         WHERE er."section" = ${section} AND er."subject" = ${subject})`;
const { todayOf } = require('./resultExams');
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const T = { ...TB, tests: `"${ClassTest.tableName}"` };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const fail = (status, message) => { throw new RuleError(status, message); };

const TEST_LABELS = { DRAFT: 'Draft', SUBMITTED: 'Waiting for approval', FINAL_APPROVED: 'Approved', REJECTED: 'Rejected', REOPENED: 'Being corrected' };

/* ── Who teaches what ─────────────────────────────────────────────────────── */

async function teaches(teacherId, sectionId, subjectId) {
    if (![teacherId, sectionId, subjectId].every((v) => isUuid(String(v || '')))) return false;
    return !!(await SectionSubjectTeacher.findOne({ teacher: teacherId, section: sectionId, subject: subjectId }).select('_id').lean());
}
async function teachesIn(teacherId, sectionId) {
    if (!isUuid(String(sectionId || ''))) return false;
    return !!(await SectionSubjectTeacher.findOne({ teacher: teacherId, section: sectionId }).select('_id').lean());
}
async function looksAfter(schoolId, teacherId, sectionId) {
    if (!isUuid(String(sectionId || ''))) return false;
    return !!(await ClassSection.findOne({
        _id: sectionId, school: schoolId, $or: [{ classTeacher: teacherId }, { substituteTeacher: teacherId }],
    }).select('_id').lean());
}

/* ── The board ────────────────────────────────────────────────────────────── */

async function teacherBoard(schoolId, teacherId) {
    const p = [String(teacherId), String(schoolId)];
    const [marks, validation, testQueue, tests, published, reExams] = await Promise.all([
        pool.query(`
            SELECT e."_id", e."title", e."code", e."examType", e."typeLabel", e."status", e."startDate", e."endDate", e."rejectionReason",
                   e."marksDueDate", e."school",
                   s."sectionName", c."className", c."classNumber", y."yearName",
                   sub."_id" AS "subjectId", sub."subjectName", sub."subjectCode",
                   (x->>'maxMarks')::numeric AS "maxMarks", (x->>'passingMarks')::numeric AS "passingMarks", x->>'examDate' AS "examDate",
                   (x->>'gradeOnly') = 'true' AS "gradeOnly", jsonb_typeof(x->'components') = 'array' AS "inParts",
                   m."status" AS "sheetStatus", m."submittedAt",
                   COALESCE((SELECT count(*)::int FROM jsonb_array_elements(${jarr('m."entries"')}) en WHERE ${ANSWERED}), 0) AS "entered",
                   COALESCE(${TAKERS('e."section"', 'st."subject"')}, ${ROSTER}) AS "roster"
              FROM ${T.exams} e
              JOIN ${T.sections} s ON s."_id" = e."section"
              LEFT JOIN ${T.classes} c ON c."_id" = s."class"
              LEFT JOIN ${T.years} y ON y."_id" = e."academicYear"
              CROSS JOIN LATERAL jsonb_array_elements(${jarr('e."subjects"')}) x
              JOIN ${T.sst} st ON st."section" = e."section" AND st."subject"::text = x->>'subject' AND st."teacher" = $1::uuid
              JOIN ${T.subjects} sub ON sub."_id" = st."subject"
              LEFT JOIN ${T.sheets} m ON m."exam" = e."_id" AND m."subject" = st."subject"
             WHERE e."school" = $2::uuid AND e."archivedAt" IS NULL
               AND e."status" IN ('MARKS_PENDING', 'REOPENED', 'REJECTED', 'SUBMITTED', 'CLASS_APPROVED')
             ORDER BY e."endDate" NULLS LAST, c."classNumber" NULLS LAST, s."sectionName", sub."subjectName"`, p),
        pool.query(`
            SELECT e."_id", e."title", e."code", e."examType", e."typeLabel", e."status", e."startDate", e."endDate",
                   s."sectionName", c."className", y."yearName",
                   jsonb_array_length(${jarr('e."subjects"')})::int AS "subjectCount", ${ROSTER} AS "roster",
                   (SELECT max(m."submittedAt") FROM ${T.sheets} m WHERE m."exam" = e."_id") AS "inAt"
              FROM ${T.exams} e
              JOIN ${T.sections} s ON s."_id" = e."section"
              LEFT JOIN ${T.classes} c ON c."_id" = s."class"
              LEFT JOIN ${T.years} y ON y."_id" = e."academicYear"
             WHERE e."school" = $2::uuid AND e."archivedAt" IS NULL AND e."status" = 'SUBMITTED'
               AND (s."classTeacher" = $1::uuid OR s."substituteTeacher" = $1::uuid)
             ORDER BY "inAt" NULLS LAST`, p),
        pool.query(`
            SELECT ct."_id", ct."title", ct."testDate", ct."maxMarks", ct."passingMarks", ct."topic", ct."classStats", ct."updatedAt",
                   sub."subjectName", s."sectionName", c."className", u."name" AS "setBy",
                   (SELECT count(*)::int FROM jsonb_array_elements(${jarr('ct."marks"')}) en WHERE ${ANSWERED}) AS "entered",
                   ${ROSTER} AS "roster"
              FROM ${T.tests} ct
              JOIN ${T.sections} s ON s."_id" = ct."section"
              LEFT JOIN ${T.classes} c ON c."_id" = s."class"
              LEFT JOIN ${T.subjects} sub ON sub."_id" = ct."subject"
              LEFT JOIN ${T.users} u ON u."_id" = ct."createdBy"
             WHERE ct."school" = $2::uuid AND ct."status" = 'SUBMITTED'
               AND (s."classTeacher" = $1::uuid OR s."substituteTeacher" = $1::uuid)
             ORDER BY ct."updatedAt"`, p),
        pool.query(`
            SELECT ct."_id", ct."title", ct."testDate", ct."maxMarks", ct."passingMarks", ct."status", ct."topic", ct."classStats",
                   ct."rejectionReason", ct."updatedAt", ct."section" AS "sectionId",
                   sub."subjectName", s."sectionName", c."className",
                   (SELECT count(*)::int FROM jsonb_array_elements(${jarr('ct."marks"')}) en WHERE ${ANSWERED}) AS "entered",
                   ${ROSTER} AS "roster"
              FROM ${T.tests} ct
              JOIN ${T.sections} s ON s."_id" = ct."section"
              LEFT JOIN ${T.classes} c ON c."_id" = s."class"
              LEFT JOIN ${T.subjects} sub ON sub."_id" = ct."subject"
             WHERE ct."school" = $2::uuid AND ct."createdBy" = $1::uuid
             ORDER BY ct."testDate" DESC, ct."createdAt" DESC
             LIMIT 200`, p),
        pool.query(`
            WITH mine AS (
                SELECT st."section" FROM ${T.sst} st WHERE st."teacher" = $1::uuid
                UNION
                SELECT s2."_id" FROM ${T.sections} s2 WHERE s2."school" = $2::uuid AND (s2."classTeacher" = $1::uuid OR s2."substituteTeacher" = $1::uuid)
            )
            SELECT e."_id", e."title", e."code", e."examType", e."typeLabel", e."finalApprovedAt", e."publishDate", e."archivedAt",
                   s."sectionName", c."className", y."yearName",
                   (s."classTeacher" = $1::uuid OR s."substituteTeacher" = $1::uuid) AS "classTeacher",
                   rs."students", rs."passed", rs."avgPct", rs."topPct",
                   COALESCE(my."subjects", '[]'::jsonb) AS "mySubjects"
              FROM ${T.exams} e
              JOIN ${T.sections} s ON s."_id" = e."section"
              LEFT JOIN ${T.classes} c ON c."_id" = s."class"
              LEFT JOIN ${T.years} y ON y."_id" = e."academicYear"
              LEFT JOIN LATERAL (
                  SELECT count(*)::int AS "students", count(*) FILTER (WHERE r."isPassed")::int AS "passed",
                         avg(r."percentage") AS "avgPct", max(r."percentage") AS "topPct"
                    FROM ${T.results} r WHERE r."exam" = e."_id") rs ON true
              LEFT JOIN LATERAL (
                  SELECT jsonb_agg(jsonb_build_object('subjectName', sub."subjectName", 'avgPct', q."avg", 'passPct', q."pass") ORDER BY sub."subjectName") AS "subjects"
                    FROM (SELECT x->>'subject' AS "sid",
                                 avg(((x->>'marksObtained')::numeric / NULLIF((x->>'maxMarks')::numeric, 0)) * 100) FILTER (WHERE COALESCE(x->>'isAbsent', 'false') <> 'true') AS "avg",
                                 count(*) FILTER (WHERE (x->>'isPassed') = 'true') * 100.0
                                   / NULLIF(count(*) FILTER (WHERE COALESCE(x->>'isAbsent', 'false') <> 'true'), 0) AS "pass"
                            FROM ${T.results} r2 CROSS JOIN LATERAL jsonb_array_elements(${jarr('r2."subjects"')}) x
                           WHERE r2."exam" = e."_id"
                             AND x->>'subject' IN (SELECT st."subject"::text FROM ${T.sst} st WHERE st."teacher" = $1::uuid AND st."section" = e."section")
                           GROUP BY 1) q
                    JOIN ${T.subjects} sub ON sub."_id"::text = q."sid") my ON true
             WHERE e."school" = $2::uuid AND e."status" = 'FINAL_APPROVED' AND e."section" IN (SELECT "section" FROM mine)
             ORDER BY e."finalApprovedAt" DESC NULLS LAST, e."title"
             LIMIT 100`, p),
        // Re-exams the office has set up, on papers of this teacher's subjects:
        // how many were not passed and still owe a re-exam mark, how many have one.
        pool.query(`
            SELECT e."_id", e."title", e."code", e."examType", e."typeLabel", e."reExam", s."sectionName", c."className", y."yearName",
                   sub."_id" AS "subjectId", sub."subjectName",
                   count(*) FILTER (WHERE (x->>'isPassed') IS DISTINCT FROM 'true' AND jsonb_typeof(x->'reExam') IS DISTINCT FROM 'object')::int AS "owed",
                   count(*) FILTER (WHERE jsonb_typeof(x->'reExam') = 'object')::int AS "entered"
              FROM ${T.exams} e
              JOIN ${T.sections} s ON s."_id" = e."section"
              LEFT JOIN ${T.classes} c ON c."_id" = s."class"
              LEFT JOIN ${T.years} y ON y."_id" = e."academicYear"
              JOIN ${T.results} r ON r."exam" = e."_id"
              CROSS JOIN LATERAL jsonb_array_elements(${jarr('r."subjects"')}) x
              JOIN ${T.sst} st ON st."section" = e."section" AND st."subject"::text = x->>'subject' AND st."teacher" = $1::uuid
              JOIN ${T.subjects} sub ON sub."_id" = st."subject"
             WHERE e."school" = $2::uuid AND e."status" = 'FINAL_APPROVED' AND e."archivedAt" IS NULL
               AND jsonb_typeof(e."reExam") = 'object'
             GROUP BY e."_id", s."sectionName", c."className", c."classNumber", y."yearName", sub."_id", sub."subjectName"
            HAVING count(*) FILTER (WHERE (x->>'isPassed') IS DISTINCT FROM 'true' OR jsonb_typeof(x->'reExam') = 'object') > 0
             ORDER BY e."finalApprovedAt" DESC NULLS LAST, c."classNumber" NULLS LAST, s."sectionName", sub."subjectName"`, p),
    ]);

    // Marks: one card per exam, its lines the subjects this teacher owes.
    const byExam = new Map();
    marks.rows.forEach((r) => {
        if (!byExam.has(String(r._id))) {
            byExam.set(String(r._id), {
                _id: r._id, title: r.title, code: r.code || '', examType: r.examType, examTypeLabel: settings.typeLabelOf(r),
                status: r.status, statusLabel: STATUS_LABELS[r.status] || r.status, open: MARKS_OPEN.includes(r.status),
                startDate: r.startDate, endDate: r.endDate, rejectionReason: r.rejectionReason || '',
                marksDueDate: r.marksDueDate || null,
                late: !!r.marksDueDate && MARKS_OPEN.includes(r.status) && dayKey(r.marksDueDate) < todayOf(r.school),
                className: r.className || '', sectionName: r.sectionName || '', yearName: r.yearName || '', roster: num(r.roster), subjects: [],
            });
        }
        const total = num(r.roster);
        const entered = Math.min(num(r.entered), total);
        byExam.get(String(r._id)).subjects.push({
            _id: r.subjectId, subjectName: r.subjectName, subjectCode: r.subjectCode || '',
            maxMarks: num(r.maxMarks), passingMarks: num(r.passingMarks), examDate: r.examDate || null,
            gradeOnly: !!r.gradeOnly, inParts: !!r.inParts,
            sheet: {
                status: r.sheetStatus === 'SUBMITTED' ? 'SUBMITTED' : entered ? 'DRAFT' : 'NOT_STARTED',
                entered, total, submittedAt: r.submittedAt || null,
            },
        });
    });
    const markExams = [...byExam.values()].map((e) => ({ ...e, owed: e.open ? e.subjects.filter((s) => s.sheet.status !== 'SUBMITTED').length : 0 }));
    // What is waiting on this teacher first, then what is with someone else.
    markExams.sort((a, b) => (b.owed > 0) - (a.owed > 0) || new Date(a.endDate || 0) - new Date(b.endDate || 0));

    const testRow = (r) => {
        const total = num(r.roster);
        return {
            _id: r._id, title: r.title, topic: r.topic || '', testDate: r.testDate, subjectName: r.subjectName || 'Subject',
            className: r.className || '', sectionName: r.sectionName || '', sectionId: r.sectionId || null,
            maxMarks: num(r.maxMarks), passingMarks: num(r.passingMarks),
            status: r.status || 'SUBMITTED', statusLabel: TEST_LABELS[r.status || 'SUBMITTED'] || r.status,
            rejectionReason: r.rejectionReason || '', setBy: r.setBy || '',
            entered: Math.min(num(r.entered), total), roster: total,
            stats: r.classStats || null, updatedAt: r.updatedAt,
        };
    };

    const out = {
        marks: markExams,
        validation: {
            exams: validation.rows.map((r) => ({
                _id: r._id, title: r.title, code: r.code || '', examType: r.examType, examTypeLabel: settings.typeLabelOf(r),
                startDate: r.startDate, endDate: r.endDate, className: r.className || '', sectionName: r.sectionName || '', yearName: r.yearName || '',
                subjectCount: num(r.subjectCount), roster: num(r.roster), inAt: r.inAt || null,
            })),
            tests: testQueue.rows.map(testRow),
        },
        tests: tests.rows.map(testRow),
        published: published.rows.map((r) => ({
            _id: r._id, title: r.title, code: r.code || '', examType: r.examType, examTypeLabel: settings.typeLabelOf(r),
            publishedOn: board.publishedOn(r),
            archived: !!r.archivedAt, className: r.className || '', sectionName: r.sectionName || '', yearName: r.yearName || '',
            classTeacher: !!r.classTeacher,
            students: num(r.students), passed: num(r.passed), passPct: num(r.students) ? Math.round((num(r.passed) / num(r.students)) * 100) : null,
            avgPct: pct1(r.avgPct), topPct: pct1(r.topPct),
            mySubjects: (Array.isArray(r.mySubjects) ? r.mySubjects : []).map((x) => ({ subjectName: x.subjectName, avgPct: pct1(x.avgPct), passPct: x.passPct === null ? null : Math.round(Number(x.passPct)) })),
        })),
    };
    // Re-exams: one card per exam, its lines the subjects this teacher owes marks in.
    const rx = new Map();
    reExams.rows.forEach((r) => {
        if (!rx.has(String(r._id))) {
            const set = r.reExam && typeof r.reExam === 'object' ? r.reExam : {};
            rx.set(String(r._id), {
                _id: r._id, title: r.title, code: r.code || '', examType: r.examType, examTypeLabel: settings.typeLabelOf(r),
                className: r.className || '', sectionName: r.sectionName || '', yearName: r.yearName || '',
                date: set.date || null, note: set.note || '', rule: set.rule === 'pass' ? 'pass' : 'scored', subjects: [],
            });
        }
        rx.get(String(r._id)).subjects.push({ _id: r.subjectId, subjectName: r.subjectName, owed: num(r.owed), entered: num(r.entered) });
    });
    out.reExams = [...rx.values()];

    // The sections this teacher looks after, so an empty Validation tab can
    // say why it is empty.
    const { rows: own } = await pool.query(`
        SELECT s."sectionName", c."className", (y."status" = 'active') AS "current"
          FROM ${T.sections} s
          LEFT JOIN ${T.classes} c ON c."_id" = s."class"
          LEFT JOIN ${T.years} y ON y."_id" = s."academicYear"
         WHERE s."school" = $2::uuid AND (s."classTeacher" = $1::uuid OR s."substituteTeacher" = $1::uuid)
         ORDER BY (y."status" = 'active') DESC, c."classNumber" NULLS LAST, s."sectionName"`, p);
    out.classTeacherOf = own.filter((r) => r.current !== false).map((r) => [r.className, r.sectionName].filter(Boolean).join(' – '));
    out.tiles = {
        toEnter: markExams.reduce((n, e) => n + e.owed, 0),
        toValidate: out.validation.exams.length + out.validation.tests.length,
        testsOpen: out.tests.filter((x) => ['DRAFT', 'REOPENED', 'REJECTED'].includes(x.status)).length,
        tests: out.tests.length,
        published: out.published.length,
        reExamsOwed: out.reExams.reduce((n, e) => n + e.subjects.reduce((m, x) => m + x.owed, 0), 0),
    };
    return out;
}

/* ── One sheet, one review, one result list ───────────────────────────────── */

/**
 * A subject's marks sheet for the teacher who teaches it there — the office's
 * grid (resultBoard.marksSheet), with the teacher's own rules: they write
 * while mark entry is open; after that, corrections are the office's.
 */
async function sheetFor(schoolId, teacherId, examId, subjectId) {
    if (!isUuid(String(examId || ''))) return null;
    const exam = await FormalExam.findOne({ _id: examId, school: schoolId }).select('section status archivedAt').lean();
    if (!exam) return null;
    if (!(await teaches(teacherId, exam.section, subjectId))) fail(403, 'You do not teach this subject in this section');
    const data = await board.marksSheet(schoolId, examId, subjectId);
    if (!data) return null;
    data.editable = !exam.archivedAt && MARKS_OPEN.includes(exam.status);
    data.correcting = false;
    return data;
}

/**
 * The class teacher's review: every student's marks in every subject, with
 * the total, percentage and grade they come to — what has to be read before
 * the marks are validated, and what the old screen never showed (it listed
 * the sheets, not the marks on them). Grace, where the exam allows it, is
 * added when the results are published, so these are the marks as entered.
 */
async function reviewFor(schoolId, teacherId, examId) {
    if (!isUuid(String(examId || ''))) return null;
    const exam = await FormalExam.findOne({ _id: examId, school: schoolId }).lean();
    if (!exam) return null;
    if (!(await looksAfter(schoolId, teacherId, exam.section))) fail(403, 'Only the class teacher can review these marks');
    const rules = require('./resultExams');

    // The figures are the results exactly as publishing would work them out —
    // electives, parts, graded papers and grace included — beside the marks
    // as entered, so a blank is still seen as a blank.
    const scale = await rules.scaleForExam(exam);
    const [detail, roster, sheets, computed, takers] = await Promise.all([
        board.detail(schoolId, examId),
        board.rosterRows(exam.section),
        ExamMarksSheet.find({ exam: examId }).select('subject entries').lean(),
        rules.computeResults({ ...exam, reExam: null }, { scale }),
        rules.takersOf(exam.section, rules.subjectIdsOf(exam)),
    ]);
    const entryOf = new Map();
    sheets.forEach((sh) => (sh.entries || []).forEach((e) => entryOf.set(`${sh.subject}:${e.student}`, e)));
    const resultOf = new Map(computed.map((r) => [String(r.student), r]));
    const cfgOf = new Map((exam.subjects || []).map((c) => [String(c.subject), c]));

    const subjects = detail.subjects.map((s) => ({
        _id: s.subject._id, subjectName: s.subject.subjectName, subjectCode: s.subject.subjectCode,
        maxMarks: s.maxMarks, passingMarks: s.passingMarks, teachers: s.teachers.map((x) => x.name),
        components: s.components || null, gradeOnly: !!s.gradeOnly, elective: !!s.elective,
        sheet: s.sheet,
    }));
    const students = roster.map((u) => {
        let blank = 0;
        const cells = subjects.map((s) => {
            const t = takers.get(String(s._id));
            if (t && !t.has(String(u._id))) return { na: true };   // an elective they do not take
            const e = entryOf.get(`${s._id}:${u._id}`);
            const cfg = cfgOf.get(String(s._id));
            if (!rules.answeredFor(cfg, e)) { blank += 1; return null; }
            if (e.isAbsent) return { absent: true };
            if (s.gradeOnly) return { grade: e.grade };
            const m = num(e.marksObtained);
            const partFailed = (s.components || []).some((c) => Number(c.passingMarks) > 0 && num(e.parts?.[c.key]) < Number(c.passingMarks));
            return { marks: m, parts: e.parts || null, below: m < s.passingMarks || partFailed };
        });
        const r = resultOf.get(String(u._id));
        const grace = r ? r.subjects.reduce((n, x) => n + num(x.graceMarks), 0) : 0;
        return {
            _id: u._id, name: u.name, rollNumber: u.rollNumber || '', admissionNumber: u.admissionNumber || '',
            cells, total: r ? r.totalMarks : 0, max: r ? r.totalMaxMarks : 0, percentage: r ? r.percentage : 0,
            grade: r ? r.grade : '', passed: !!r?.isPassed && !blank, blank, grace,
        };
    });
    const pcts = students.map((x) => x.percentage);
    return {
        exam: {
            _id: detail._id, title: detail.title, code: detail.code, examTypeLabel: detail.examTypeLabel, status: detail.status, statusLabel: detail.statusLabel,
            className: detail.className, sectionName: detail.sectionName, yearName: detail.yearName,
            startDate: detail.startDate, endDate: detail.endDate, options: detail.options,
        },
        subjects,
        students,
        // The grades the figures are on: the class's scale, best first.
        scale: settings.scaleRows(scale).map((b) => ({ grade: b.grade, pass: b.pass })),
        stats: {
            students: students.length,
            passing: students.filter((x) => x.passed).length,
            avgPct: pcts.length ? pct1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
            topPct: pcts.length ? Math.max(...pcts) : null,
            blank: students.reduce((n, x) => n + x.blank, 0),
            graced: students.filter((x) => x.grace > 0).length,
        },
        can: { validate: exam.status === 'SUBMITTED', reject: exam.status === 'SUBMITTED' },
    };
}

/** Published results of a section this teacher teaches in or looks after. */
async function resultsFor(schoolId, teacherId, examId) {
    if (!isUuid(String(examId || ''))) return null;
    const exam = await FormalExam.findOne({ _id: examId, school: schoolId }).select('section status').lean();
    if (!exam) return null;
    const allowed = (await looksAfter(schoolId, teacherId, exam.section)) || (await teachesIn(teacherId, exam.section));
    if (!allowed) fail(403, 'These results are not for a section you teach');
    if (exam.status !== 'FINAL_APPROVED') fail(400, 'These results have not been published');
    return board.results(schoolId, examId);
}

/**
 * A class test as a marks sheet — the same shape as an exam subject's, so the
 * one grid serves both. Its setter may write it while it is a draft or being
 * corrected; the class teacher reads it to approve it — and so may the office
 * (`office`), which reads every class test and approves where the class
 * teacher cannot.
 */
async function testSheet(schoolId, teacherId, testId, { office = false } = {}) {
    if (!isUuid(String(testId || ''))) return null;
    const test = await ClassTest.findOne({ _id: testId, school: schoolId }).lean();
    if (!test) return null;
    const mine = !office && String(test.createdBy) === String(teacherId);
    const reviewer = office || await looksAfter(schoolId, teacherId, test.section);
    if (!mine && !reviewer) fail(403, 'This class test is not yours to open');

    const { rows: [where] } = await pool.query(`
        SELECT s."sectionName", c."className", y."yearName", sub."_id" AS "subjectId", sub."subjectName", sub."subjectCode", u."name" AS "setBy"
          FROM ${T.sections} s
          LEFT JOIN ${T.classes} c ON c."_id" = s."class"
          LEFT JOIN ${T.years} y ON y."_id" = s."academicYear"
          LEFT JOIN ${T.subjects} sub ON sub."_id" = $2::uuid
          LEFT JOIN ${T.users} u ON u."_id" = $3::uuid
         WHERE s."_id" = $1::uuid`, [String(test.section), String(test.subject), String(test.createdBy)]);
    // An elective's test is sat by its roster only.
    const [all, takers] = await Promise.all([board.rosterRows(test.section), board.takersBySubject(test.section)]);
    const own = takers.get(String(test.subject));
    const roster = own ? all.filter((u) => own.has(String(u._id))) : all;
    const entryOf = new Map((test.marks || []).map((m) => [String(m.student), m]));
    const entered = (test.marks || []).some((m) => m.isAbsent || (m.marksObtained !== null && m.marksObtained !== undefined));
    return {
        exam: {
            _id: test._id, title: test.title, status: test.status, statusLabel: TEST_LABELS[test.status] || test.status,
            className: where?.className || '', sectionName: where?.sectionName || '', yearName: where?.yearName || '', archived: false,
        },
        subject: { _id: where?.subjectId || test.subject, subjectName: where?.subjectName || 'Subject', subjectCode: where?.subjectCode || '' },
        config: { maxMarks: num(test.maxMarks), passingMarks: num(test.passingMarks), examDate: test.testDate },
        teachers: [where?.setBy].filter(Boolean),
        sheet: {
            status: test.status === 'SUBMITTED' || test.status === 'FINAL_APPROVED' ? 'SUBMITTED' : entered ? 'DRAFT' : 'NOT_STARTED',
            submittedBy: '', submittedAt: null, updatedAt: test.updatedAt,
        },
        editable: mine && ['DRAFT', 'REOPENED'].includes(test.status),
        correcting: false,
        students: roster.map((u) => {
            const e = entryOf.get(String(u._id));
            return {
                _id: u._id, name: u.name, isActive: u.isActive !== false, rollNumber: u.rollNumber || '', admissionNumber: u.admissionNumber || '',
                marksObtained: e && e.marksObtained !== null && e.marksObtained !== undefined ? num(e.marksObtained) : null,
                isAbsent: !!e?.isAbsent, remarks: e?.remarks || '',
            };
        }),
        test: {
            topic: test.topic || '', description: test.description || '', rejectionReason: test.rejectionReason || '',
            stats: test.classStats || null, mine, reviewer,
            canReview: reviewer && test.status === 'SUBMITTED',
            canReopen: mine && test.status === 'REJECTED',
        },
    };
}

/** What the class test form may offer: the sections and subjects this teacher teaches. */
async function testOptions(schoolId, teacherId) {
    const { rows } = await pool.query(`
        SELECT st."section", st."subject", s."sectionName", c."className", c."classNumber", sub."subjectName", y."status" AS "yearStatus", y."yearName"
          FROM ${T.sst} st
          JOIN ${T.sections} s ON s."_id" = st."section" AND s."school" = $2::uuid
          LEFT JOIN ${T.classes} c ON c."_id" = s."class"
          LEFT JOIN ${T.years} y ON y."_id" = s."academicYear"
          JOIN ${T.subjects} sub ON sub."_id" = st."subject"
         WHERE st."teacher" = $1::uuid AND COALESCE(s."status", 'active') <> 'archived'
         ORDER BY (y."status" = 'active') DESC, c."classNumber" NULLS LAST, s."sectionName", sub."subjectName"`, [String(teacherId), String(schoolId)]);
    return rows.map((r) => ({
        sectionId: r.section, subjectId: r.subject, sectionName: r.sectionName, className: r.className || '',
        subjectName: r.subjectName, yearName: r.yearName || '', current: r.yearStatus === 'active',
    }));
}

module.exports = { teacherBoard, sheetFor, reviewFor, resultsFor, testSheet, testOptions, teaches, looksAfter, TEST_LABELS };
