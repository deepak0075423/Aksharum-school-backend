'use strict';
/**
 * Report cards (Oct 2026): a student's year — or one term — on one sheet.
 *
 *   the exams     the ones marked "Include in overall result" — what the school
 *                 said makes up the year — or, where it marked none, every
 *                 published exam of the year; each a column, each subject a row.
 *                 A term's card has that term's exams only.
 *   overall       services/resultOverall — the school's own rule (marks added
 *                 up, or weighted parts and best-of), graded on the scale the
 *                 newest exam was published on; ranked in the section, and
 *                 across the class, only where every exam counted shows rank
 *   attendance    the year so far, a day at a time: a day of several registers
 *                 is rolled up the way the attendance pages roll it up
 *   remarks and   the class teacher's (ReportCardNote — one per year, and one
 *   co-scholastic per term for a school with terms), in the areas and grades the
 *                 school chose (Results → Settings); and each subject teacher's
 *                 remark from the newest exam
 *   promotion     where the final exam moved the student, if it did
 *
 * Who sees what. The office and the section's class and vice class teacher
 * see every published exam. A student and their parents see exactly what
 * their results page shows (published, not kept off the portal, past the
 * result date), and the remarks and co-scholastic grades once the section's
 * cards are RELEASED (ReportCardRelease) — or, for the year's card, once a
 * final exam's results have reached them, as before releasing existed. Until
 * then it is a progress report, marks only. A card with a withheld result is
 * withheld from the family whole.
 *
 * Built for many students at once — a section's cards print together — so
 * every read is one query over all of them, not one per student.
 */
const crypto = require('crypto');
const pool = require('../db/pool');
const School = require('../models/School');
const AcademicYear = require('../models/AcademicYear');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const FormalExam = require('../models/FormalExam');
const FormalResult = require('../models/FormalResult');
const StudentProfile = require('../models/StudentProfile');
const Subject = require('../models/Subject');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const AttendanceRecord = require('../models/AttendanceRecord');
const ReportCardNote = require('../models/ReportCardNote');
const ReportCardRelease = require('../models/ReportCardRelease');
const ReportCardVerification = require('../models/ReportCardVerification');
const { isUuid } = require('../db/schema');
const settings = require('./resultSettings');
const sa = require('./studentAttendance');
const { parentsOf } = require('./parentChildren');
const { localToday, keyDate, dateKey, addDays } = require('./staffAttendanceDays');
const { RuleError, familyOf, trail } = require('./resultExams');
const { movesFor } = require('./resultPromotion');
const overallEngine = require('./resultOverall');
const schoolClock = require('./schoolClock');
const { notify } = require('./notifyService');
const { yearOrderSql, byYear, newestYear } = require('../utils/listOrder');
const { escapeHtml: escHtml } = require('../utils/textRules');   // what a person typed stays text in an email

const t = (M) => `"${M.tableName}"`;
const T = {
    exams: t(FormalExam), results: t(FormalResult), sections: t(ClassSection), classes: t(Class), years: t(AcademicYear),
    profiles: t(StudentProfile), subjects: t(Subject), users: t(User), att: t(Attendance), records: t(AttendanceRecord),
};
const fail = (status, message) => { throw new RuleError(status, message); };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round1 = (v) => Math.round(Number(v) * 10) / 10;
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const jarr = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;
const REMARKS_MAX = 1000;
const FRONTEND = () => String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
const verifyUrl = (code) => `${FRONTEND()}/verify/report-card/${code}`;

/* ── The year, the term, the school ───────────────────────────────────────── */

async function years(schoolId) {
    const { rows } = await pool.query(
        `SELECT "_id", "yearName", "status", "startDate", "endDate" FROM ${T.years}
          WHERE "school" = $1::uuid ORDER BY ${yearOrderSql()}`, [String(schoolId)]);
    return rows;
}
/** The year asked for (one of this school's), else the one the school is in, else the latest. */
async function yearOf(schoolId, yearId) {
    const list = await years(schoolId);
    return list.find((y) => String(y._id) === String(yearId || ''))
        || list.find((y) => y.status === 'active') || newestYear(list);
}
const yearShape = (y) => (y ? { _id: y._id, yearName: y.yearName, current: y.status === 'active' } : null);
/** The term asked for, if it is one of the school's; '' — the year's card. */
const termOf = (conf, term) => ((conf.terms || []).some((x) => x.key === String(term || '')) ? String(term) : '');
const termLabel = (conf, term) => (conf.terms || []).find((x) => x.key === term)?.label || '';

async function letterhead(schoolId) {
    const s = await School.findById(schoolId).select('name code email phone address city state board boardName website logo').lean();
    if (!s) return null;
    return {
        _id: s._id, name: s.name, code: s.code || '', email: s.email || '', phone: s.phone || '', website: s.website || '',
        address: [s.address, s.city, s.state].map((x) => String(x || '').trim()).filter(Boolean).join(', '),
        board: s.boardName || s.board || '', logo: s.logo || '',
    };
}

/* ── Reads, for every student at once ─────────────────────────────────────── */

/** Days attended over the days marked, for the year so far — a day at a time. */
async function attendanceOf(studentIds, year) {
    const today = localToday();
    const from = year.startDate ? dateKey(year.startDate) : addDays(today, -365);
    const end = year.endDate ? dateKey(year.endDate) : today;
    const to = end < today ? end : today;
    const out = new Map();
    if (to < from) return out;
    const { rows } = await pool.query(`
        SELECT r."student"::text AS "student", to_char(a."date" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "key",
               array_agg(r."status") AS "statuses"
          FROM ${T.records} r JOIN ${T.att} a ON a."_id" = r."attendance"
         WHERE r."student" = ANY($1::uuid[]) AND a."date" >= $2 AND a."date" < $3
         GROUP BY 1, 2`, [studentIds, keyDate(from), keyDate(addDays(to, 1))]);
    rows.forEach((r) => {
        const day = sa.rollup(r.statuses || []);
        if (!day) return;
        const x = out.get(r.student) || { attended: 0, total: 0 };
        x.total += 1;
        x.attended += sa.credit(day);
        out.set(r.student, x);
    });
    for (const [k, x] of out) out.set(k, { attended: x.attended, total: x.total, percentage: sa.percentOf(x.attended, x.total), from, to });
    return out;
}

/** The students themselves, with the section the year placed them in when no exam says. */
async function studentsOf(schoolId, yearId, studentIds) {
    const { rows } = await pool.query(`
        SELECT u."_id", u."name", u."profileImage", sp."rollNumber", sp."admissionNumber", sp."dob",
               ys."_id" AS "sectionId", ys."sectionName", yc."className", yc."classNumber"
          FROM ${T.users} u
          LEFT JOIN LATERAL (SELECT * FROM ${T.profiles} p WHERE p."user" = u."_id" ORDER BY p."createdAt" DESC NULLS LAST LIMIT 1) sp ON true
          LEFT JOIN LATERAL (
              SELECT s."_id", s."sectionName", s."class" FROM ${T.sections} s
               WHERE s."school" = $1::uuid AND s."academicYear" = $2::uuid
                 AND ${jarr('s."enrolledStudents"')} @> to_jsonb(ARRAY[u."_id"::text])
               LIMIT 1) ys ON true
          LEFT JOIN ${T.classes} yc ON yc."_id" = ys."class"
         WHERE u."_id" = ANY($3::uuid[]) AND u."school" = $1::uuid AND u."role" = 'student'`,
    [String(schoolId), String(yearId), studentIds]);
    return new Map(rows.map((r) => [String(r._id), r]));
}

async function notesOf(schoolId, yearId, studentIds, term = '') {
    const rows = (await ReportCardNote.find({ school: schoolId, academicYear: yearId, student: { $in: studentIds } }).lean())
        .filter((r) => String(r.term || '') === String(term || ''));
    const by = [...new Set(rows.map((r) => String(r.updatedBy || '')).filter(isUuid))];
    const { rows: who } = by.length
        ? await pool.query(`SELECT "_id", "name" FROM ${T.users} WHERE "_id" = ANY($1::uuid[])`, [by]) : { rows: [] };
    const nameOf = new Map(who.map((w) => [String(w._id), w.name]));
    return new Map(rows.map((r) => [String(r.student), {
        remarks: r.remarks || '', coScholastic: r.coScholastic && typeof r.coScholastic === 'object' ? r.coScholastic : {},
        by: nameOf.get(String(r.updatedBy)) || '', at: r.updatedAt || null,
    }]));
}

async function parentNames(schoolId, studentIds) {
    const links = await parentsOf(studentIds, schoolId);
    const ids = [...new Set([...links.values()].flat().map(String))];
    if (!ids.length) return new Map();
    const { rows } = await pool.query(`SELECT "_id", "name" FROM ${T.users} WHERE "_id" = ANY($1::uuid[]) ORDER BY "name"`, [ids]);
    const nameOf = new Map(rows.map((r) => [String(r._id), r.name]));
    return new Map([...links.entries()].map(([k, list]) => [String(k), list.map((id) => nameOf.get(String(id))).filter(Boolean)]));
}

/** Which of these sections have released their cards (for the year, or a term): Set(sectionId). */
async function releasedSections(schoolId, yearId, sectionIds, term = '') {
    const ids = [...new Set(sectionIds.map(String))].filter(isUuid);
    if (!ids.length) return new Map();
    const rows = await ReportCardRelease.find({ school: schoolId, academicYear: yearId, section: { $in: ids } }).lean();
    return new Map(rows.filter((r) => String(r.term || '') === String(term || '') && r.releasedAt).map((r) => [String(r.section), r]));
}

/* ── The cards ────────────────────────────────────────────────────────────── */

/**
 * Report cards for these students in one year (or one term), in the order asked.
 *   audience  'office' (the office and the class teacher) or 'family'
 */
async function cards(schoolId, { year, studentIds, audience = 'office', term = '' }) {
    const ids = [...new Set((studentIds || []).map(String).filter(isUuid))];
    if (!year || !ids.length) return [];
    const family = audience === 'family';
    const yearId = String(year._id);
    const conf = await settings.get(schoolId);
    const termKey = termOf(conf, term);

    const [people, results, attendance, notes, parents, moves, verifications] = await Promise.all([
        studentsOf(schoolId, yearId, ids),
        overallEngine.yearResults(schoolId, yearId, { studentIds: ids, family, term: termKey || null }),
        attendanceOf(ids, year), notesOf(schoolId, yearId, ids, termKey), parentNames(schoolId, ids), movesFor(ids),
        ReportCardVerification.find({ school: schoolId, academicYear: yearId, student: { $in: ids } }).lean(),
    ]);
    const byStudent = overallEngine.byStudent(results);
    const picks = new Map(ids.map((id) => [id, overallEngine.chosen(byStudent.get(id) || [])]));
    const sectionIds = [...new Set([...picks.values()].map((p) => p.rows.at(-1)?.section).filter(Boolean).map(String))];
    // The overall and the ranks, worked out over the whole of each section the
    // way the school's rule says (services/resultOverall).
    const { years: yearsOfSection } = sectionIds.length
        ? await overallEngine.yearsFor(schoolId, yearId, { sectionIds, family, allowAll: true, term: termKey || null })
        : { years: new Map() };
    const released = await releasedSections(schoolId, yearId,
        [...sectionIds, ...[...people.values()].map((p) => p.sectionId).filter(Boolean)], termKey);

    // The class's figures for each subject: its average and highest, per section.
    const figures = new Map();
    if (conf.report.showClassFigures) {
        for (const y of yearsOfSection.values()) {
            const k = String(y.section);
            if (!figures.has(k)) figures.set(k, new Map());
            for (const [sid, v] of y.subjects) {
                const m = figures.get(k);
                if (!m.has(sid)) m.set(sid, []);
                m.get(sid).push(v.percentage);
            }
        }
    }

    const subjectIds = [...new Set(results.flatMap((r) => (Array.isArray(r.subjects) ? r.subjects : []).map((x) => String(x.subject))).filter(isUuid))];
    const { rows: subs } = subjectIds.length
        ? await pool.query(`SELECT "_id", "subjectName", "subjectCode" FROM ${T.subjects} WHERE "_id" = ANY($1::uuid[])`, [subjectIds])
        : { rows: [] };
    const subOf = new Map(subs.map((s) => [String(s._id), s]));
    const verifyOf = new Map(verifications.filter((v) => String(v.term || '') === termKey).map((v) => [String(v.student), v]));

    return ids.filter((id) => people.has(id)).map((id) => {
        const who = people.get(id);
        const pick = picks.get(id);
        const rows = pick.rows;
        const last = rows.at(-1);
        const y = yearsOfSection.get(id) || null;
        const scale = y?.scale || overallEngine.yearScale(rows, conf);
        const showPoints = conf.report.showGradePoints && settings.hasPoints(scale);
        const pointOf = (g) => (showPoints ? settings.pointOf(scale, g) : null);

        // Columns: the exams; rows: every subject any of them examined, in the
        // order the exams first list them.
        const order = [];
        rows.forEach((r) => (Array.isArray(r.subjects) ? r.subjects : []).forEach((x) => {
            const k = String(x.subject);
            if (!order.includes(k)) order.push(k);
        }));
        const cell = (r, sid) => {
            const x = (Array.isArray(r.subjects) ? r.subjects : []).find((v) => String(v.subject) === sid);
            if (!x) return null;
            if (x.gradeOnly) return { gradeOnly: true, grade: x.grade || '', absent: !!x.isAbsent, marks: null, max: 0, grace: 0, point: null, passed: true };
            return {
                marks: x.isAbsent ? null : num(x.marksObtained), max: num(x.maxMarks), grace: num(x.graceMarks),
                grade: x.grade || '', point: pointOf(x.grade), absent: !!x.isAbsent, passed: !!x.isPassed,
                components: Array.isArray(x.components) ? x.components.map((c) => ({ label: c.label, marks: c.marks, max: c.maxMarks })) : null,
            };
        };
        const sectionFigures = figures.get(String(y?.section || last?.section || ''));
        const subjects = order.map((sid) => {
            const cells = rows.map((r) => cell(r, sid));
            const sat = cells.filter(Boolean);
            const graded = sat.length > 0 && sat.every((c) => c.gradeOnly);
            const agg = y?.subjects.get(sid) || null;
            // The subject teacher's word, from the newest exam that has one.
            let remark = '';
            if (conf.report.showSubjectRemarks) {
                for (const r of [...rows].reverse()) {
                    const x = (Array.isArray(r.subjects) ? r.subjects : []).find((v) => String(v.subject) === sid);
                    if (x?.remarks) { remark = x.remarks; break; }
                }
            }
            const list = sectionFigures?.get(sid) || [];
            return {
                _id: sid, subjectName: subOf.get(sid)?.subjectName || 'Subject', subjectCode: subOf.get(sid)?.subjectCode || '',
                cells, gradeOnly: graded,
                total: !graded && agg && (rows.length > 1 || y?.method === 'weighted')
                    ? { marks: agg.marks, max: agg.max, percentage: round1(agg.percentage), grade: agg.grade, point: pointOf(agg.grade), passed: agg.isPassed }
                    : null,
                remarks: remark,
                classFigures: !graded && list.length ? { avgPct: round1(list.reduce((a, b) => a + b, 0) / list.length), topPct: round1(Math.max(...list)) } : null,
            };
        });

        const ranked = conf.report.showRank && rows.length > 0 && rows.every((r) => r.showRank !== false);
        const final = rows.find((r) => r.examType === 'FINAL');
        const move = moves.find((m) => String(m.student) === id && rows.some((r) => String(r.exam) === String(m.exam)));
        const release = released.get(String(y?.section || last?.section || '')) || released.get(String(who.sectionId || ''));
        // A family reads the teacher's words once the cards are released — or,
        // for the year's card, with the final results (as before releasing existed).
        const complete = !!release || (!termKey && !!final);
        const note = notes.get(id);
        const showNotes = !family || complete;
        const withheld = rows.find((r) => r.withheld)?.withheld || null;
        const v = verifyOf.get(id);

        return {
            student: {
                _id: id, name: who.name, photo: who.profileImage || '', rollNumber: who.rollNumber || '', admissionNumber: who.admissionNumber || '',
                dob: who.dob || null,
                className: last?.className || who.className || '', sectionName: last?.sectionName || who.sectionName || '',
                parents: parents.get(id) || [],
            },
            basis: pick.basis,
            method: y?.method || 'marks',
            term: termKey, termLabel: termLabel(conf, termKey),
            exams: rows.map((r) => ({
                _id: r.exam, title: r.title, code: r.code || '', examType: r.examType, examTypeLabel: settings.typeLabelOf(r),
                startDate: r.startDate, endDate: r.endDate,
                total: num(r.totalMarks), max: num(r.totalMaxMarks), percentage: num(r.percentage), grade: r.grade || '', point: pointOf(r.grade),
                isPassed: !!r.isPassed,
                rank: conf.report.showRank && r.showRank !== false ? num(r.rank) || null : null,
                outOf: conf.report.showRank && r.showRank !== false ? num(r.outOf) : null,
                withheld: !!r.withheld,
            })),
            subjects,
            overall: y ? {
                marks: y.marks, max: y.max, percentage: y.percentage, grade: y.grade, isPassed: y.isPassed, point: pointOf(y.grade),
                rank: ranked ? y.rank : null, outOf: ranked ? y.outOf : null,
                classRank: ranked ? y.classRank : null, classOutOf: ranked ? y.classOutOf : null,
            } : null,
            attendance: conf.report.showAttendance ? (attendance.get(id) || { attended: 0, total: 0, percentage: null }) : null,
            coScholastic: showNotes ? conf.coScholastic.map((a) => ({ key: a.key, label: a.label, grade: note?.coScholastic?.[a.key] || '' })) : [],
            remarks: showNotes ? (note?.remarks || '') : '',
            notesBy: showNotes ? (note?.by || '') : '',
            notesAt: showNotes ? (note?.at || null) : null,
            notesHeld: family && !complete && !!(note?.remarks || Object.values(note?.coScholastic || {}).some(Boolean)),
            promotion: move ? {
                kind: move.kind, className: move.to.className, sectionName: move.to.sectionName, yearName: move.to.yearName, at: move.at,
            } : null,
            complete,
            released: release ? { at: release.releasedAt } : null,
            withheld: withheld ? { reason: withheld === 'withheld' ? '' : withheld } : null,
            verification: v && complete ? { code: v.code, url: verifyUrl(v.code) } : null,
            // The scale this card is graded on — its class's, as the newest exam
            // was published on it — for the key printed under the marks.
            scale: settings.scaleRows(scale),
            showGradePoints: showPoints,
        };
    });
}

/** Everything the page around a card needs once: the letterhead, the year, the school's choices. */
async function frame(schoolId, year, term = '') {
    const [school, conf] = await Promise.all([letterhead(schoolId), settings.get(schoolId)]);
    const termKey = termOf(conf, term);
    return {
        school,
        year: yearShape(year),
        term: termKey, termLabel: termLabel(conf, termKey),
        terms: conf.terms.map((x) => ({ key: x.key, label: x.label })),
        scale: conf.scaleRows,
        showGradePoints: conf.report.showGradePoints && settings.hasPoints(conf.scale),
        coScholasticGrades: conf.coScholasticGrades,
        areas: conf.coScholastic,
        principalTitle: conf.report.principalTitle,
        footer: conf.report.footer,
        showAttendance: conf.report.showAttendance,
        showRank: conf.report.showRank,
        showClassFigures: conf.report.showClassFigures,
        showSubjectRemarks: conf.report.showSubjectRemarks,
        principalSignature: conf.report.principalSignature || '',
        schoolSeal: conf.report.schoolSeal || '',
        remarkBank: conf.remarkBank,
        rule: { method: conf.overall.method, passRule: conf.overall.passRule, passPercent: conf.overall.passPercent },
    };
}

/* ── Sections ─────────────────────────────────────────────────────────────── */

/** The sections of a year — all of them, or those a teacher is class or vice class teacher of. */
async function sectionsOf(schoolId, yearId, teacherId = null) {
    const params = [String(schoolId), String(yearId)];
    let mine = '';
    if (teacherId) { params.push(String(teacherId)); mine = `AND (s."classTeacher" = $3::uuid OR s."substituteTeacher" = $3::uuid)`; }
    const { rows } = await pool.query(`
        SELECT s."_id", s."sectionName", c."className", c."classNumber",
               (SELECT count(*)::int FROM ${T.users} u
                 WHERE u."role" = 'student' AND u."isActive" IS NOT FALSE
                   AND u."_id"::text IN (SELECT v FROM jsonb_array_elements_text(${jarr('s."enrolledStudents"')}) v)) AS "students"
          FROM ${T.sections} s JOIN ${T.classes} c ON c."_id" = s."class"
         WHERE s."school" = $1::uuid AND s."academicYear" = $2::uuid ${mine}
         ORDER BY c."classNumber" NULLS LAST, c."className", s."sectionName"`, params);
    return rows.map((r) => ({ _id: r._id, sectionName: r.sectionName, className: r.className, classNumber: num(r.classNumber), students: num(r.students) }));
}

/** The section's students on its roll, in roll order. */
async function rollOf(sectionId) {
    const { rows } = await pool.query(`
        SELECT u."_id" FROM ${T.sections} s
          JOIN ${T.users} u ON u."role" = 'student' AND u."isActive" IS NOT FALSE
           AND u."_id"::text IN (SELECT v FROM jsonb_array_elements_text(${jarr('s."enrolledStudents"')}) v)
          LEFT JOIN LATERAL (SELECT "rollNumber" FROM ${T.profiles} WHERE "user" = u."_id" ORDER BY "createdAt" DESC NULLS LAST LIMIT 1) sp ON true
         WHERE s."_id" = $1::uuid
         ORDER BY NULLIF(regexp_replace(COALESCE(sp."rollNumber", ''), '\\D', '', 'g'), '')::bigint NULLS LAST, u."name"`, [String(sectionId)]);
    return rows.map((r) => String(r._id));
}

/** The years a teacher holds a class teacher's post in, A–Z. */
async function teacherYears(schoolId, teacherId) {
    const { rows } = await pool.query(`
        SELECT DISTINCT y."_id", y."yearName", y."status", y."startDate", y."endDate" FROM ${T.sections} s JOIN ${T.years} y ON y."_id" = s."academicYear"
         WHERE s."school" = $1::uuid AND (s."classTeacher" = $2::uuid OR s."substituteTeacher" = $2::uuid)`, [String(schoolId), String(teacherId)]);
    return rows.sort(byYear);
}

/**
 * GET …/report-cards — one section's report cards, for the office or its class
 * teacher: the year, term and section pickers, each student's card, and
 * whether the section's cards have been released and sent.
 */
async function sectionCards(schoolId, { yearId, sectionId, teacherId = null, term = '' } = {}) {
    const list = teacherId ? await teacherYears(schoolId, teacherId) : await years(schoolId);
    const year = list.find((y) => String(y._id) === String(yearId || ''))
        || list.find((y) => y.status === 'active') || newestYear(list);
    const base = { years: list.map(yearShape), year: yearShape(year), sections: [], section: null, cards: [], frame: null, release: null };
    if (!year) return base;
    const sections = await sectionsOf(schoolId, year._id, teacherId);
    const section = sections.find((s) => String(s._id) === String(sectionId || '')) || sections[0] || null;
    const f = await frame(schoolId, year, term);
    if (!section) return { ...base, sections, frame: f };
    const ids = await rollOf(section._id);
    const [list2, rel] = await Promise.all([
        cards(schoolId, { year, studentIds: ids, audience: 'office', term: f.term }),
        ReportCardRelease.find({ school: schoolId, academicYear: year._id, section: section._id }).lean(),
    ]);
    const r = rel.find((x) => String(x.term || '') === f.term) || null;
    const who = r ? await User.find({ _id: { $in: [r.releasedBy, r.sentBy].filter(Boolean) } }).select('name').lean() : [];
    const nameOf = new Map(who.map((u) => [String(u._id), u.name]));
    return {
        ...base, sections, section, frame: f, cards: list2,
        release: r ? {
            releasedAt: r.releasedAt || null, releasedBy: nameOf.get(String(r.releasedBy)) || '',
            sentAt: r.sentAt || null, sentBy: nameOf.get(String(r.sentBy)) || '', sentCount: num(r.sentCount),
        } : null,
    };
}

/** May this teacher write this student's card for this year? Their class or vice class teacher. */
async function teacherMayWrite(schoolId, teacherId, studentId, yearId) {
    const { rows } = await pool.query(`
        SELECT 1 FROM ${T.sections} s
         WHERE s."school" = $1::uuid AND s."academicYear" = $2::uuid
           AND (s."classTeacher" = $3::uuid OR s."substituteTeacher" = $3::uuid)
           AND ${jarr('s."enrolledStudents"')} @> to_jsonb(ARRAY[$4::text]) LIMIT 1`,
    [String(schoolId), String(yearId), String(teacherId), String(studentId)]);
    return rows.length > 0;
}
/** Is this teacher the class or vice class teacher of this section? */
async function teacherHolds(schoolId, teacherId, sectionId) {
    const { rows } = await pool.query(`SELECT 1 FROM ${T.sections} s WHERE s."_id" = $1::uuid AND s."school" = $2::uuid
                                        AND (s."classTeacher" = $3::uuid OR s."substituteTeacher" = $3::uuid)`, [String(sectionId), String(schoolId), String(teacherId)]);
    return rows.length > 0;
}

/**
 * The class teacher's remarks and co-scholastic grades for one student's year
 * (or one term). Only what the body names changes; a grade must be one the
 * school uses, and an empty one clears it. Written as one statement — the
 * remarks and the grades never overwrite each other's latest.
 */
async function saveNotes(ctx, body = {}) {
    const studentId = String(body.studentId || body.student || '');
    if (!isUuid(studentId)) fail(400, 'Choose the student');
    const year = await yearOf(ctx.schoolId, body.academicYear);
    if (!year || (body.academicYear && String(year._id) !== String(body.academicYear))) fail(404, 'Academic year not found');
    const student = await User.findOne({ _id: studentId, school: ctx.schoolId, role: 'student' }).select('name').lean();
    if (!student) fail(404, 'Student not found');
    if (ctx.userRole === 'teacher' && !(await teacherMayWrite(ctx.schoolId, ctx.userId, studentId, year._id))) {
        fail(403, `Only ${student.name}'s class teacher or vice class teacher can write this report card`);
    }

    const conf = await settings.get(ctx.schoolId);
    const term = termOf(conf, body.term);
    if (body.term && !term) fail(400, 'Choose one of the school\'s terms');
    let remarks;
    if (body.remarks !== undefined) {
        remarks = String(body.remarks ?? '').trim();
        if (remarks.length > REMARKS_MAX) fail(400, `Remarks are ${REMARKS_MAX} characters at most`);
    }
    let grades;
    if (body.coScholastic !== undefined) {
        if (!body.coScholastic || typeof body.coScholastic !== 'object' || Array.isArray(body.coScholastic)) fail(400, 'Give the co-scholastic grades by area');
        const areas = new Map(conf.coScholastic.map((a) => [a.key, a.label]));
        grades = {};
        for (const [k, v] of Object.entries(body.coScholastic)) {
            if (!areas.has(k)) fail(400, 'That co-scholastic area is not one the school grades');
            const g = String(v ?? '').trim();
            if (g && !conf.coScholasticGrades.includes(g)) fail(400, `${areas.get(k)}: choose one of ${conf.coScholasticGrades.join(', ')}`);
            grades[k] = g;
        }
    }
    if (remarks === undefined && grades === undefined) fail(400, 'Nothing to save');

    // One row per student, year and term (db/migrate.js): made if missing,
    // then changed in SQL — only what was sent, merged into what is there.
    const { newId } = require('../db/schema');
    await pool.query(
        `INSERT INTO "${ReportCardNote.tableName}" ("_id", "school", "academicYear", "student", "term", "remarks", "coScholastic", "updatedBy", "createdAt", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, '', '{}'::jsonb, $6::uuid, now(), now())
         ON CONFLICT ("school", "academicYear", "student", (COALESCE("term", ''))) DO NOTHING`,
        [newId(), String(ctx.schoolId), String(year._id), studentId, term, isUuid(String(ctx.userId || '')) ? String(ctx.userId) : null]);
    const sets = ['"updatedAt" = now()', `"updatedBy" = $5::uuid`];
    const params = [String(ctx.schoolId), String(year._id), studentId, term, isUuid(String(ctx.userId || '')) ? String(ctx.userId) : null];
    if (remarks !== undefined) { params.push(remarks); sets.push(`"remarks" = $${params.length}`); }
    if (grades !== undefined) {
        // An empty grade takes that area's grade away; the others stay.
        const keep = Object.fromEntries(Object.entries(grades).filter(([, g]) => g));
        const drop = Object.keys(grades).filter((k) => !grades[k]);
        params.push(JSON.stringify(keep)); const a = params.length;
        params.push(drop); const b = params.length;
        sets.push(`"coScholastic" = ((CASE WHEN jsonb_typeof("coScholastic") = 'object' THEN "coScholastic" ELSE '{}'::jsonb END) - $${b}::text[]) || $${a}::jsonb`);
    }
    await pool.query(
        `UPDATE "${ReportCardNote.tableName}" SET ${sets.join(', ')}
          WHERE "school" = $1::uuid AND "academicYear" = $2::uuid AND "student" = $3::uuid AND COALESCE("term", '') = $4`, params);
    const [card] = await cards(ctx.schoolId, { year, studentIds: [studentId], audience: 'office', term });
    return card || null;
}

/* ── Releasing, verifying, sending ────────────────────────────────────────── */

/** A short code for a card's QR — unambiguous letters and digits. */
function newCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(10);
    return [...bytes].map((b) => abc[b % abc.length]).join('');
}

/** What a card's QR proves: the figures issued, kept with the code. */
function snapshotOf(card, year) {
    return {
        name: card.student.name, className: card.student.className, sectionName: card.student.sectionName,
        rollNumber: card.student.rollNumber, admissionNumber: card.student.admissionNumber,
        yearName: year?.yearName || '', termLabel: card.termLabel || '',
        percentage: card.overall?.percentage ?? null, grade: card.overall?.grade || '',
        result: card.overall ? (card.overall.isPassed ? 'Passed' : 'Not passed') : '',
        promotion: card.promotion ? `${card.promotion.kind === 'repeated' ? 'Continues in' : card.promotion.kind === 'passedOut' ? 'Passed out of' : 'Promoted to'} ${[card.promotion.className, card.promotion.sectionName].filter(Boolean).join(' – ')}` : '',
        exams: card.exams.map((e) => ({ title: e.title, percentage: e.percentage, grade: e.grade })),
    };
}

/** Make (or bring up to date) the verification code of each of these cards. */
async function ensureVerifications(schoolId, year, list) {
    const existing = await ReportCardVerification.find({ school: schoolId, academicYear: year._id, student: { $in: list.map((c) => c.student._id) } }).lean();
    for (const card of list) {
        const term = card.term || '';
        const have = existing.find((v) => String(v.student) === String(card.student._id) && String(v.term || '') === term);
        const snap = snapshotOf(card, year);
        if (have) {
            await pool.query(`UPDATE "${ReportCardVerification.tableName}" SET "snapshot" = $2::jsonb, "updatedAt" = now() WHERE "_id" = $1::uuid`,
                [String(have._id), JSON.stringify(snap)]);
            card.verification = { code: have.code, url: verifyUrl(have.code) };
        } else {
            let code = newCode();
            for (let i = 0; i < 3; i += 1) {
                try {
                    await ReportCardVerification.create({ code, school: schoolId, academicYear: year._id, student: card.student._id, term, snapshot: snap });
                    break;
                } catch (e) {
                    if (e.code !== '23505' && e.code !== 11000) throw e;
                    code = newCode();
                }
            }
            card.verification = { code, url: verifyUrl(code) };
        }
    }
    return list;
}

/**
 * Release a section's report cards to its families (or take the release
 * back): from then on they see the whole card, and each family is told.
 * The office, or the section's class / vice class teacher.
 */
async function release(ctx, { academicYear, sectionId, term = '', released = true } = {}) {
    const year = await yearOf(ctx.schoolId, academicYear);
    if (!year) fail(404, 'Academic year not found');
    const section = await ClassSection.findOne({ _id: sectionId, school: ctx.schoolId, academicYear: year._id }).select('sectionName class').lean();
    if (!section) fail(404, 'Section not found');
    if (ctx.userRole === 'teacher' && !(await teacherHolds(ctx.schoolId, ctx.userId, section._id))) fail(403, 'Only the section\'s class teacher can release its report cards');
    const conf = await settings.get(ctx.schoolId);
    const key = termOf(conf, term);
    if (term && !key) fail(400, 'Choose one of the school\'s terms');
    const cls = section.class ? await Class.findById(section.class).select('className').lean() : null;
    const where = [cls?.className, section.sectionName].filter(Boolean).join(' – ');
    const what = `${key ? `${termLabel(conf, key)} ` : ''}report cards`;

    const { newId } = require('../db/schema');
    await pool.query(
        `INSERT INTO "${ReportCardRelease.tableName}" ("_id", "school", "academicYear", "section", "term", "releasedAt", "releasedBy", "createdAt", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, NULL, NULL, now(), now())
         ON CONFLICT ("school", "academicYear", "section", "term") DO NOTHING`,
        [newId(), String(ctx.schoolId), String(year._id), String(section._id), key]);
    const { rows: [row] } = await pool.query(
        `UPDATE "${ReportCardRelease.tableName}" SET "releasedAt" = $5, "releasedBy" = $6::uuid, "updatedAt" = now()
          WHERE "school" = $1::uuid AND "academicYear" = $2::uuid AND "section" = $3::uuid AND "term" = $4
          RETURNING *`,
        [String(ctx.schoolId), String(year._id), String(section._id), key, released ? new Date() : null, released ? String(ctx.userId) : null]);
    trail(ctx, released ? 'REPORT_CARDS_RELEASED' : 'REPORT_CARDS_UNRELEASED', 'ReportCards', section._id,
        `${released ? 'Released' : 'Took back'} the ${what} of ${where} (${year.yearName})`, { term: key, year: String(year._id) });

    if (released) {
        const ids = await rollOf(section._id);
        const list = await cards(ctx.schoolId, { year, studentIds: ids, audience: 'family', term: key });
        await ensureVerifications(ctx.schoolId, year, list.filter((c) => !c.withheld && c.exams.length));
        // Each family hears their own child's card is ready — not one whose card is withheld.
        const ready = list.filter((c) => !c.withheld && c.exams.length).map((c) => c.student._id);
        for (const sid of ready) {
            familyOf(ctx.schoolId, [sid]).then((recipients) => {
                try {
                    notify({
                        school: ctx.schoolId, sender: ctx.userId, senderRole: ctx.userRole,
                        title: `📄 Report card ready: ${year.yearName}${key ? ` · ${termLabel(conf, key)}` : ''}`,
                        body: `The ${what.replace(/s$/, '')} is ready to read under Results → Report Card.`,
                        recipients, link: { type: 'results.reportcard', entityId: section._id },
                    });
                } catch (e) { console.error('[report cards] notice failed:', e.message); }
            }).catch(() => {});
        }
    }
    return row;
}

/**
 * Send a section's released report cards to the parents (Oct 2026): each
 * parent with an email address gets their child's card as a PDF, from the
 * school's own address, and an in-app notice. Runs after the reply.
 *   → { students, parents } queued
 */
async function sendCards(ctx, { academicYear, sectionId, term = '', studentId = null } = {}) {
    const year = await yearOf(ctx.schoolId, academicYear);
    if (!year) fail(404, 'Academic year not found');
    const section = await ClassSection.findOne({ _id: sectionId, school: ctx.schoolId, academicYear: year._id }).select('sectionName class').lean();
    if (!section) fail(404, 'Section not found');
    if (ctx.userRole === 'teacher' && !(await teacherHolds(ctx.schoolId, ctx.userId, section._id))) fail(403, 'Only the section\'s class teacher can send its report cards');
    const conf = await settings.get(ctx.schoolId);
    const key = termOf(conf, term);
    const rel = (await releasedSections(ctx.schoolId, year._id, [section._id], key)).get(String(section._id));
    if (!rel) fail(400, 'Release the report cards first — parents are sent what they can see');

    const ids = studentId ? [String(studentId)] : await rollOf(section._id);
    const list = (await cards(ctx.schoolId, { year, studentIds: ids, audience: 'family', term: key })).filter((c) => !c.withheld && c.exams.length);
    if (!list.length) fail(400, 'There are no report cards to send here');
    await ensureVerifications(ctx.schoolId, year, list);
    const links = await parentsOf(list.map((c) => c.student._id), ctx.schoolId);
    const parentIds = [...new Set([...links.values()].flat().map(String))];
    const { rows: parents } = parentIds.length
        ? await pool.query(`SELECT "_id", "name", "email" FROM ${T.users} WHERE "_id" = ANY($1::uuid[]) AND "isActive" IS NOT FALSE`, [parentIds])
        : { rows: [] };
    const parentOf = new Map(parents.map((p) => [String(p._id), p]));
    const f = await frame(ctx.schoolId, year, key);
    const count = { students: list.length, parents: 0 };
    for (const c of list) count.parents += (links.get(String(c.student._id)) || []).filter((p) => parentOf.get(String(p))?.email).length;

    await pool.query(`UPDATE "${ReportCardRelease.tableName}" SET "sentAt" = now(), "sentBy" = $2::uuid, "sentCount" = $3, "updatedAt" = now() WHERE "_id" = $1::uuid`,
        [String(rel._id), String(ctx.userId), count.parents]);
    trail(ctx, 'REPORT_CARDS_SENT', 'ReportCards', section._id,
        `Sent ${list.length} report card${list.length === 1 ? '' : 's'} to ${count.parents} parent${count.parents === 1 ? '' : 's'}`, { term: key, year: String(year._id) });

    // The mail goes out after the reply: a section's PDFs take a while.
    setImmediate(async () => {
        const { renderReportCardsBuffer } = require('../utils/reportCardPdf');
        const { sendSchoolMail, emailHeaderHtml, getMailContext } = require('../utils/schoolMailer');
        const { school } = await getMailContext(ctx.schoolId).catch(() => ({ school: null }));
        for (const c of list) {
            try {
                const to = (links.get(String(c.student._id)) || []).map((p) => parentOf.get(String(p))).filter((p) => p?.email);
                const pdf = await renderReportCardsBuffer({ frame: f, cards: [c], family: true });
                const label = `${year.yearName}${key ? ` · ${termLabel(conf, key)}` : ''}`;
                const filename = `report-card-${String(c.student.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${String(year.yearName).replace(/[^0-9-]/g, '')}.pdf`;
                for (const p of to) {
                    await sendSchoolMail(ctx.schoolId, {
                        to: p.email, subject: `Report card — ${c.student.name} (${label})`,
                        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
                                 ${emailHeaderHtml(school, `Report card · ${label}`)}
                                 <div style="background:#f9fafb;padding:24px 28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
                                   <p style="margin-top:0">Dear ${escHtml(p.name || 'Parent')},</p>
                                   <p>${escHtml(c.student.name)}'s report card for ${escHtml(label)} is attached. You can also read it in the app, under Results → Report Card.</p>
                                   ${c.verification ? `<p style="color:#6b7280;font-size:13px">Verify it at <a href="${escHtml(c.verification.url)}">${escHtml(c.verification.url)}</a></p>` : ''}
                                 </div></div>`,
                        attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
                    });
                }
                familyOf(ctx.schoolId, [c.student._id]).then((recipients) => {
                    try {
                        notify({
                            school: ctx.schoolId, sender: ctx.userId, senderRole: ctx.userRole,
                            title: `📄 Report card: ${c.student.name}`,
                            body: `${c.student.name}'s report card for ${label} has been sent${to.length ? ' to your email' : ''}. It is also under Results → Report Card.`,
                            recipients, link: { type: 'results.reportcard', entityId: section._id },
                        });
                    } catch { /* a notice never fails the sending */ }
                }).catch(() => {});
            } catch (e) {
                console.error(`[report cards] sending ${c.student._id} failed:`, e.message);
            }
        }
    });
    return count;
}

/**
 * GET /public/report-card/:code — what the QR on a printed card proves: the
 * school issued this card, with these figures. No sign-in: whoever holds the
 * paper can check it. Nothing beyond what the card itself prints is shown.
 */
async function verify(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(c)) fail(404, 'No report card has this code');
    const v = await ReportCardVerification.findOne({ code: c }).lean();
    if (!v) fail(404, 'No report card has this code');
    const school = await School.findById(v.school).select('name city state logo').lean();
    return {
        code: v.code, issuedAt: v.issuedAt, updatedAt: v.updatedAt,
        school: school ? { name: school.name, place: [school.city, school.state].filter(Boolean).join(', '), logo: school.logo || '' } : null,
        card: v.snapshot || null,
    };
}

/**
 * A student's own card (the student, or a parent for a child): the years they
 * have results in that they may see, and the card for the year (and term)
 * asked for — else the latest of them, else the year the school is in.
 */
async function familyCard(schoolId, studentId, yearId, term = '') {
    const { rows: seen } = await pool.query(`
        SELECT DISTINCT y."_id", y."yearName", y."status", y."startDate", y."endDate"
          FROM ${T.results} r JOIN ${T.exams} e ON e."_id" = r."exam" JOIN ${T.years} y ON y."_id" = e."academicYear"
         WHERE r."student" = $1::uuid AND e."school" = $2::uuid AND e."status" = 'FINAL_APPROVED'
           AND e."showInPortal" IS DISTINCT FROM false AND ${overallEngine.releasedSql('e."publishDate"', '$3::text')}`,
        [String(studentId), String(schoolId), schoolClock.zoneOf(schoolId)]);
    seen.sort(byYear);
    const year = seen.find((y) => String(y._id) === String(yearId || '')) || newestYear(seen) || await yearOf(schoolId, null);
    const out = { years: seen.map(yearShape), year: yearShape(year), frame: null, card: null };
    if (!year) return out;
    const f = await frame(schoolId, year, term);
    const [card] = await cards(schoolId, { year, studentIds: [studentId], audience: 'family', term: f.term });
    // Withheld: the family is told so, and shown nothing else of it.
    if (card?.withheld) {
        return { ...out, frame: f, card: null, withheld: { reason: card.withheld.reason || '', student: card.student } };
    }
    return { ...out, frame: f, card: card || null };
}

/**
 * A student's overall result for the year, as their family may see it: the
 * exams marked "Include in overall result" whose results have reached them,
 * worked out by the school's rule exactly as the office's overall result is.
 * The year is the latest one such a result is in. Null when the school counts
 * no exam towards an overall result, or none has reached the family yet, or
 * one of them is withheld. `of` is how many exams the section's year counts,
 * published or not, so "2 of 3 so far" can be said.
 */
async function familyOverall(schoolId, studentId) {
    const { rows: [latest] } = await pool.query(`
        SELECT e."academicYear" FROM ${T.results} r JOIN ${T.exams} e ON e."_id" = r."exam"
         WHERE r."student" = $1::uuid AND e."school" = $2::uuid AND e."status" = 'FINAL_APPROVED' AND e."includeInOverall" IS TRUE
           AND e."showInPortal" IS DISTINCT FROM false AND ${overallEngine.releasedSql('e."publishDate"', '$3::text')}
         ORDER BY COALESCE(e."endDate", e."startDate") DESC NULLS LAST LIMIT 1`, [String(studentId), String(schoolId), schoolClock.zoneOf(schoolId)]);
    if (!latest) return null;
    const year = await yearOf(schoolId, latest.academicYear);
    if (!year || String(year._id) !== String(latest.academicYear)) return null;
    const mine = await overallEngine.yearResults(schoolId, year._id, { studentIds: [String(studentId)], family: true });
    const counted = mine.filter((r) => r.includeInOverall === true);
    if (!counted.length || counted.some((r) => r.withheld)) return null;
    const section = String(counted.at(-1).section);
    const conf = await settings.get(schoolId);
    const [{ years: ys }, { rows: [planned] }] = await Promise.all([
        overallEngine.yearsFor(schoolId, year._id, { sectionIds: [section], family: true }),
        pool.query(`SELECT count(*)::int AS "n" FROM ${T.exams} e
                     WHERE e."section" = $1::uuid AND e."academicYear" = $2::uuid AND e."includeInOverall" IS TRUE
                       AND (e."archivedAt" IS NULL OR e."status" = 'FINAL_APPROVED')`, [section, String(year._id)]),
    ]);
    const o = ys.get(String(studentId));
    if (!o) return null;
    const ranked = conf.report.showRank && counted.every((r) => r.showRank !== false);
    return {
        year: yearShape(year),
        marks: o.marks, max: o.max, percentage: o.percentage, grade: o.grade, isPassed: o.isPassed, method: o.method,
        scale: o.scale ? settings.scaleRows(o.scale).map((b) => ({ grade: b.grade, pass: b.pass })) : null,
        rank: ranked ? o.rank : null, outOf: ranked ? o.outOf : null,
        classRank: ranked ? o.classRank : null, classOutOf: ranked ? o.classOutOf : null,
        exams: counted.map((x) => ({ _id: x.exam, title: x.title, examTypeLabel: settings.typeLabelOf(x), percentage: num(x.percentage), isPassed: !!x.isPassed })),
        of: Math.max(num(planned?.n), counted.length),
        final: counted.some((x) => x.examType === 'FINAL'),
    };
}

module.exports = {
    cards, frame, sectionCards, saveNotes, familyCard, familyOverall, yearOf, teacherMayWrite, teacherHolds, letterhead,
    release, sendCards, verify, ensureVerifications, verifyUrl, REMARKS_MAX, round2,
};
