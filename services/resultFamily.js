'use strict';
/**
 * Results as a student, or a parent, reads them (Oct 2026 redesign).
 *
 * By STUDENT, not by section. The old endpoints looked up the student's
 * current section and listed its exams — so a student promoted on the day a
 * final's results came out (services/resultPromotion) was in next year's
 * section that same day, and their final result vanished from their own page.
 * A result belongs to the student it was worked out for, wherever they are now.
 *
 * What a family may see is resultExams' rule — published, not kept off the
 * portal, past its result date — written here in SQL; the rank is left out
 * when the exam hides ranks. Class figures (the section's average and top
 * score) are given beside each result: a mark means little without them.
 */
const pool = require('../db/pool');
const FormalExam = require('../models/FormalExam');
const FormalResult = require('../models/FormalResult');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const AcademicYear = require('../models/AcademicYear');
const ClassTest = require('../models/ClassTest');
const StudentProfile = require('../models/StudentProfile');
const Subject = require('../models/Subject');
const User = require('../models/User');
const { isUuid } = require('../db/schema');
const TZ = require('../config/timezone');
const { gradeFor, releasedSql, reSitting } = require('./resultExams');
const schoolClock = require('./schoolClock');
const ResultRecheck = require('../models/ResultRecheck');
const settings = require('./resultSettings');
const { movesFor } = require('./resultPromotion');
// Lazily, as publishedOn below: reportCard reads through resultExams too.
const familyOverall = (schoolId, studentId) => require('./reportCard').familyOverall(schoolId, studentId);
// Lazily: resultBoard requires resultExams, as this module does.
const publishedOn = (r) => require('./resultBoard').publishedOn(r);

const t = (M) => `"${M.tableName}"`;
const T = {
    exams: t(FormalExam), results: t(FormalResult), sections: t(ClassSection), classes: t(Class), years: t(AcademicYear),
    tests: t(ClassTest), profiles: t(StudentProfile), subjects: t(Subject), users: t(User),
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const jarr = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;

/** Who the page is about: name, roll, and where they are now. */
async function studentCard(schoolId, studentId) {
    const { rows: [r] } = await pool.query(`
        SELECT u."_id", u."name", u."profileImage", sp."rollNumber", sp."admissionNumber",
               s."sectionName", COALESCE(c."className", pc."className") AS "className", y."yearName"
          FROM ${T.users} u
          LEFT JOIN LATERAL (SELECT * FROM ${T.profiles} p WHERE p."user" = u."_id" ORDER BY p."createdAt" DESC NULLS LAST LIMIT 1) sp ON true
          LEFT JOIN ${T.sections} s ON s."_id" = sp."currentSection"
          LEFT JOIN ${T.classes} c ON c."_id" = s."class"
          LEFT JOIN ${T.classes} pc ON pc."_id" = sp."currentClass"
          LEFT JOIN ${T.years} y ON y."_id" = COALESCE(c."academicYear", pc."academicYear")
         WHERE u."_id" = $1::uuid AND u."school" = $2::uuid`, [String(studentId), String(schoolId)]);
    if (!r) return null;
    return {
        _id: r._id, name: r.name, profileImage: r.profileImage || '', rollNumber: r.rollNumber || '', admissionNumber: r.admissionNumber || '',
        className: r.className || '', sectionName: r.sectionName || '', yearName: r.yearName || '',
    };
}

/** Every result this student may see, newest first, each a full scorecard. */
async function examResults(schoolId, studentId) {
    const { rows } = await pool.query(`
        SELECT r."_id", r."exam" AS "examId", r."subjects", r."totalMarks", r."totalMaxMarks", r."percentage", r."grade", r."rank", r."isPassed",
               r."reExam" AS "resultReExam", e."reExam" AS "examReExam", e."withheld", e."gradeBands",
               e."title", e."code", e."examType", e."typeLabel", e."description", e."startDate", e."endDate", e."publishDate", e."finalApprovedAt", e."showRank",
               e."school", COALESCE(e."term", '') AS "term",
               s."sectionName", c."className", c."classNumber", y."yearName",
               st."students", st."avgPct", st."topPct", st."passed", st."bySubject"
          FROM ${T.results} r
          JOIN ${T.exams} e ON e."_id" = r."exam"
          LEFT JOIN ${T.sections} s ON s."_id" = e."section"
          LEFT JOIN ${T.classes} c ON c."_id" = s."class"
          LEFT JOIN ${T.years} y ON y."_id" = e."academicYear"
          LEFT JOIN LATERAL (
              SELECT count(*)::int AS "students", avg(x."percentage") AS "avgPct", max(x."percentage") AS "topPct",
                     count(*) FILTER (WHERE x."isPassed")::int AS "passed",
                     -- Each paper's class figures: its average and highest, as percentages of the paper.
                     (SELECT jsonb_object_agg(q."sid", jsonb_build_object('avg', q."avg", 'top', q."top"))
                        FROM (SELECT p->>'subject' AS "sid",
                                     avg(((p->>'marksObtained')::numeric / NULLIF((p->>'maxMarks')::numeric, 0)) * 100) FILTER (WHERE COALESCE(p->>'isAbsent', 'false') <> 'true') AS "avg",
                                     max(((p->>'marksObtained')::numeric / NULLIF((p->>'maxMarks')::numeric, 0)) * 100) FILTER (WHERE COALESCE(p->>'isAbsent', 'false') <> 'true') AS "top"
                                FROM ${T.results} x2 CROSS JOIN LATERAL jsonb_array_elements(${jarr('x2."subjects"')}) p
                               WHERE x2."exam" = e."_id" AND COALESCE(p->>'gradeOnly', 'false') <> 'true'
                               GROUP BY 1) q) AS "bySubject"
                FROM ${T.results} x WHERE x."exam" = e."_id") st ON true
         WHERE r."student" = $1::uuid AND e."school" = $2::uuid
           AND e."status" = 'FINAL_APPROVED' AND e."showInPortal" IS DISTINCT FROM false
           AND ${releasedSql('e."publishDate"', '$3::text')}
         ORDER BY COALESCE(e."endDate", e."startDate") DESC NULLS LAST, e."createdAt" DESC`, [String(studentId), String(schoolId), schoolClock.zoneOf(schoolId)]);

    const subjectIds = [...new Set(rows.flatMap((r) => (Array.isArray(r.subjects) ? r.subjects : []).map((x) => String(x.subject))).filter(isUuid))];
    const [{ rows: subs }, moves, conf, ranks, checks] = await Promise.all([
        subjectIds.length
            ? pool.query(`SELECT "_id", "subjectName", "subjectCode" FROM ${T.subjects} WHERE "_id" = ANY($1::uuid[])`, [subjectIds])
            : { rows: [] },
        movesFor([studentId]),
        settings.get(schoolId),
        require('./resultBoard').classRanksFor(rows.map((r) => r.examId)),
        ResultRecheck.find({ student: studentId, exam: { $in: rows.map((r) => String(r.examId)) } }).sort({ createdAt: -1 }).lean(),
    ]);
    const subOf = new Map(subs.map((s) => [String(s._id), s]));
    const moveOf = new Map(moves.map((m) => [m.exam, m]));
    const now = new Date();

    return rows.map((r) => {
        const showRank = r.showRank !== false;
        const subjects = Array.isArray(r.subjects) ? r.subjects : [];
        // A re-exam the school has dated, for papers this student has still to sit again.
        const rx = r.examReExam && typeof r.examReExam === 'object' ? r.examReExam : null;
        const owed = rx ? subjects.filter((x) => !x.isPassed && !x.reExam && !x.gradeOnly && reSitting(rx, x.subject)) : [];
        const scale = r.gradeBands?.bands ? r.gradeBands : settings.scaleForClass(conf, r.classNumber);
        const held = (Array.isArray(r.withheld) ? r.withheld : []).find((w) => String(w.student) === String(studentId));
        const exam = {
            _id: r.examId, title: r.title, code: r.code || '', examType: r.examType, examTypeLabel: settings.typeLabelOf(r),
            description: r.description || '', startDate: r.startDate, endDate: r.endDate,
            // The day the results reached this family (resultBoard.publishedOn).
            publishedOn: publishedOn(r),
            className: r.className || '', sectionName: r.sectionName || '', yearName: r.yearName || '',
            termLabel: (conf.terms || []).find((x) => x.key === r.term)?.label || '',
        };
        // Withheld: the family sees that it is, and why — no figures.
        if (held) {
            return { _id: r._id, exam, withheld: { reason: held.reason || '' }, subjects: [], scale: settings.scaleRows(scale) };
        }
        // Asking for a paper to be checked again: open for the school's days after the results arrived.
        const since = exam.publishedOn ? new Date(exam.publishedOn) : null;
        const until = conf.recheckDays > 0 && since ? new Date(since.getTime() + conf.recheckDays * 864e5) : null;
        const mine = checks.filter((c) => String(c.exam) === String(r.examId));
        const cr = ranks.get(`${r.examId}:${studentId}`);
        const figures = r.bySubject && typeof r.bySubject === 'object' ? r.bySubject : {};
        return {
            _id: r._id,
            exam,
            subjects: subjects.map((x) => {
                const sub = subOf.get(String(x.subject));
                const f = figures[String(x.subject)] || null;
                const ask = mine.find((c) => String(c.subject) === String(x.subject)) || null;
                return {
                    _id: String(x.subject), subjectName: sub?.subjectName || 'Subject', subjectCode: sub?.subjectCode || '',
                    marksObtained: num(x.marksObtained), graceMarks: num(x.graceMarks), maxMarks: num(x.maxMarks), passingMarks: num(x.passingMarks),
                    grade: x.grade || '', isPassed: !!x.isPassed, isAbsent: !!x.isAbsent, remarks: x.remarks || '',
                    gradeOnly: !!x.gradeOnly,
                    components: Array.isArray(x.components) ? x.components : null,
                    // Sat again: the figures above are the re-exam's; `original` is the first sitting.
                    reExam: x.reExam ? { marksObtained: x.reExam.marksObtained ?? null, isAbsent: !!x.reExam.isAbsent, original: x.reExam.original || null } : null,
                    classFigures: f && !x.gradeOnly ? { avgPct: pct1(f.avg), topPct: pct1(f.top) } : null,
                    recheck: ask ? { _id: ask._id, status: ask.status, outcome: ask.outcome || '', response: ask.response || '', before: ask.before || null, after: ask.after || null } : null,
                };
            }),
            reExam: !!r.resultReExam,
            reExamDue: owed.length ? {
                date: rx.date || null, note: rx.note || '',
                subjects: owed.map((x) => subOf.get(String(x.subject))?.subjectName || 'Subject'),
                papers: owed.map((x) => ({ subjectName: subOf.get(String(x.subject))?.subjectName || 'Subject', ...reSitting(rx, x.subject) })),
            } : null,
            totalMarks: num(r.totalMarks), totalMaxMarks: num(r.totalMaxMarks), percentage: num(r.percentage),
            grade: r.grade || '', isPassed: !!r.isPassed,
            rank: showRank ? num(r.rank) || null : null,
            outOf: showRank ? num(r.students) : null,
            // Across every section of the class, where the exam shows ranks.
            classRank: showRank && cr ? cr.classRank : null, classOutOf: showRank && cr ? cr.classOutOf : null,
            grace: subjects.reduce((s, x) => s + num(x.graceMarks), 0),
            classFigures: { students: num(r.students), avgPct: pct1(r.avgPct), topPct: pct1(r.topPct), passPct: num(r.students) ? Math.round((num(r.passed) / num(r.students)) * 100) : null },
            promotion: moveOf.get(String(r.examId)) || null,
            scale: settings.scaleRows(scale),
            recheck: { open: !!until && now <= until, until: until || null, days: conf.recheckDays },
        };
    });
}

/**
 * Approved class tests the student sat — whichever section they sat them in —
 * and those of their current section, so a test they missed still shows.
 */
async function classTests(schoolId, studentId) {
    // Each test graded on its class's scale (Results → Settings).
    const conf = await settings.get(schoolId);
    const { rows } = await pool.query(`
        SELECT ct."_id", ct."title", ct."testDate", ct."maxMarks", ct."passingMarks", ct."topic", ct."classStats",
               sub."subjectName", s."sectionName", c."className", c."classNumber",
               (SELECT m FROM jsonb_array_elements(${jarr('ct."marks"')}) m WHERE m->>'student' = $1::text LIMIT 1) AS "mine"
          FROM ${T.tests} ct
          LEFT JOIN ${T.subjects} sub ON sub."_id" = ct."subject"
          LEFT JOIN ${T.sections} s ON s."_id" = ct."section"
          LEFT JOIN ${T.classes} c ON c."_id" = s."class"
         WHERE ct."school" = $2::uuid AND ct."status" = 'FINAL_APPROVED'
           AND (EXISTS (SELECT 1 FROM jsonb_array_elements(${jarr('ct."marks"')}) m WHERE m->>'student' = $1::text)
                OR ct."section" = (SELECT p."currentSection" FROM ${T.profiles} p WHERE p."user" = $3::uuid ORDER BY p."createdAt" DESC NULLS LAST LIMIT 1))
         ORDER BY ct."testDate" DESC, ct."createdAt" DESC
         LIMIT 200`, [String(studentId), String(schoolId), String(studentId)]);
    return rows.map((r) => {
        const scale = settings.scaleForClass(conf, r.classNumber);
        const m = r.mine || null;
        const sat = m && !m.isAbsent && m.marksObtained !== null && m.marksObtained !== undefined;
        const pct = sat && num(r.maxMarks) ? Math.round((num(m.marksObtained) / num(r.maxMarks)) * 1000) / 10 : null;
        const stats = r.classStats || {};
        return {
            _id: r._id, title: r.title, topic: r.topic || '', testDate: r.testDate, subjectName: r.subjectName || 'Subject',
            className: r.className || '', sectionName: r.sectionName || '',
            maxMarks: num(r.maxMarks), passingMarks: num(r.passingMarks),
            mine: m ? {
                marksObtained: sat ? num(m.marksObtained) : null, isAbsent: !!m.isAbsent, remarks: m.remarks || '',
                grade: sat ? gradeFor(num(m.marksObtained), num(r.maxMarks), num(m.marksObtained) >= num(r.passingMarks), false, scale) : '',
                percentage: pct, isPassed: sat ? num(m.marksObtained) >= num(r.passingMarks) : false,
            } : null,
            classFigures: {
                average: stats.average ?? null, highest: stats.highest ?? null, passPercent: stats.passPercent ?? null,
                avgPct: stats.average !== null && stats.average !== undefined && num(r.maxMarks) ? Math.round((num(stats.average) / num(r.maxMarks)) * 1000) / 10 : null,
            },
            // The scale the grade is on, so a screen colours it as that scale says.
            scale: settings.scaleRows(scale).map((b) => ({ grade: b.grade, pass: b.pass })),
        };
    });
}

/**
 * The whole page for one student: who they are, every result, their class
 * tests, the year's overall result, and the figures the page leads with — all
 * from the same rows, so the tiles can never disagree with the list under them.
 */
async function overview(schoolId, studentId) {
    const [student, exams, tests, overall] = await Promise.all([
        studentCard(schoolId, studentId), examResults(schoolId, studentId), classTests(schoolId, studentId),
        familyOverall(schoolId, studentId),
    ]);
    // A withheld result is listed (so the family sees it is), and counts in nothing.
    const shown = exams.filter((e) => !e.withheld);
    const pcts = shown.map((e) => e.percentage);
    const best = shown.reduce((b, e) => (!b || e.percentage > b.percentage ? e : b), null);
    const sat = tests.filter((x) => x.mine && x.mine.percentage !== null);

    // Each subject across every exam: the average of the papers sat, so an
    // absence is a gap, not a zero.
    const bySubject = new Map();
    shown.forEach((e) => e.subjects.filter((x) => !x.gradeOnly).forEach((x) => {
        const k = x.subjectName.trim().toLowerCase();
        if (!bySubject.has(k)) bySubject.set(k, { subjectName: x.subjectName, sat: 0, sum: 0, papers: 0, passed: 0 });
        const row = bySubject.get(k);
        row.papers += 1;
        if (!x.isAbsent && x.maxMarks) { row.sat += 1; row.sum += (x.marksObtained / x.maxMarks) * 100; }
        if (x.isPassed) row.passed += 1;
    }));

    return {
        student,
        exams,
        classTests: tests,
        promotion: shown.find((e) => e.promotion)?.promotion || null,
        // The year's overall result, where the school counts exams towards one.
        overall,
        stats: {
            exams: shown.length,
            passed: shown.filter((e) => e.isPassed).length,
            avgPct: pcts.length ? pct1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
            best: best ? { title: best.exam.title, percentage: best.percentage, grade: best.grade } : null,
            latest: shown[0] ? { title: shown[0].exam.title, percentage: shown[0].percentage, grade: shown[0].grade, rank: shown[0].rank, outOf: shown[0].outOf } : null,
            tests: tests.length,
            testAvgPct: sat.length ? pct1(sat.reduce((s, x) => s + x.mine.percentage, 0) / sat.length) : null,
        },
        // Oldest first — a trend reads left to right.
        trend: shown.slice().reverse().map((e) => ({
            _id: e._id, title: e.exam.title, code: e.exam.code, examTypeLabel: e.exam.examTypeLabel,
            date: e.exam.endDate || e.exam.startDate, percentage: e.percentage, classAvgPct: e.classFigures.avgPct,
        })),
        subjects: [...bySubject.values()]
            .map((s) => ({ subjectName: s.subjectName, papers: s.papers, sat: s.sat, passed: s.passed, avgPct: s.sat ? pct1(s.sum / s.sat) : null }))
            .sort((a, b) => (b.avgPct ?? -1) - (a.avgPct ?? -1) || a.subjectName.localeCompare(b.subjectName)),
    };
}

/**
 * Which of these students a record is about — an exam (they have a result in
 * it, or are on the roll of the section sitting it) or a class test (they have
 * a mark in it). A notice about one child's result opens the parent's page with
 * the record's id and no child named: with several children it landed on the
 * first of them by name, which was usually the wrong one.
 */
async function studentAbout(recordId, studentIds) {
    const ids = [...new Set((studentIds || []).map(String).filter(isUuid))];
    if (!isUuid(String(recordId || '')) || !ids.length) return null;
    const { rows } = await pool.query(`
        SELECT x."student" FROM (
            SELECT r."student"::text AS "student", 1 AS "o" FROM ${T.results} r
             WHERE r."exam" = $1::uuid AND r."student" = ANY($2::uuid[])
            UNION ALL
            SELECT m->>'student', 2 FROM ${T.tests} ct CROSS JOIN LATERAL jsonb_array_elements(${jarr('ct."marks"')}) m
             WHERE ct."_id" = $1::uuid AND m->>'student' = ANY($3::text[])
            UNION ALL
            SELECT v, 3 FROM ${T.exams} e JOIN ${T.sections} s ON s."_id" = e."section"
              CROSS JOIN LATERAL jsonb_array_elements_text(${jarr('s."enrolledStudents"')}) v
             WHERE e."_id" = $1::uuid AND v = ANY($3::text[])
        ) x ORDER BY x."o" LIMIT 1`, [String(recordId), ids, ids]);
    return rows[0]?.student || null;
}

module.exports = { overview, examResults, classTests, studentCard, studentAbout };
