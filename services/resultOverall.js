'use strict';
/**
 * The year's overall result — worked out ONE way for every screen that shows
 * it: the office's Overall page, the merit list, the report card and the
 * family's overall card (Oct 2026).
 *
 *   counted    the published exams marked "Include in overall result" — and,
 *              when the school's rule names them, the approved class tests
 *   'marks'    the counted exams' marks added up, per subject and in all: an
 *              exam weighs what it is out of (the module's original rule)
 *   'weighted' each part — an exam type, or class tests — a share of every
 *              subject: the best N of its papers when the rule says so,
 *              averaged as percentages and weighed; the year's percentage is
 *              the average of the subjects'
 *   terms      when the school weighs its terms, each term is worked out from
 *              its own exams and the year is the terms weighed (class tests
 *              count across the whole year)
 *   pass       'every' — every counted exam passed (the original rule);
 *              'aggregate' — every subject's year percentage at or above the
 *              school's pass percentage
 *
 * Graded papers count in nothing. Grades are on the scale of the newest
 * counted exam as it was published (FormalExam.gradeBands), so a scale changed
 * mid-year never leaves a card graded on two.
 */
const pool = require('../db/pool');
const FormalExam = require('../models/FormalExam');
const FormalResult = require('../models/FormalResult');
const ClassTest = require('../models/ClassTest');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const AcademicYear = require('../models/AcademicYear');
const StudentProfile = require('../models/StudentProfile');
const User = require('../models/User');
const { isUuid } = require('../db/schema');
const settings = require('./resultSettings');
const schoolClock = require('./schoolClock');

const t = (M) => `"${M.tableName}"`;
const T = {
    exams: t(FormalExam), results: t(FormalResult), tests: t(ClassTest), sections: t(ClassSection), classes: t(Class),
    years: t(AcademicYear), profiles: t(StudentProfile), users: t(User),
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const jarr = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;
const releasedSql = (col, tz) => `(${col} IS NULL OR (${col} AT TIME ZONE 'UTC')::date <= (now() AT TIME ZONE ${tz})::date)`;

/**
 * Published results of a year, with what the overall needs of each exam.
 *   studentIds / sectionIds / classNumber   narrow the read
 *   family     only what a family may see (published, on the portal, past the result date)
 *   term       one term's exams only
 */
async function yearResults(schoolId, yearId, { studentIds = null, sectionIds = null, classNumber = null, family = false, term = null } = {}) {
    const params = [String(schoolId), String(yearId)];
    const w = [];
    const $ = (v) => { params.push(v); return `$${params.length}`; };
    if (studentIds) w.push(`r."student" = ANY(${$(studentIds.map(String))}::uuid[])`);
    if (sectionIds) w.push(`e."section" = ANY(${$(sectionIds.map(String))}::uuid[])`);
    if (classNumber !== null && classNumber !== undefined && classNumber !== '' && Number.isFinite(Number(classNumber))) w.push(`c."classNumber" = ${$(Number(classNumber))}`);
    if (family) w.push(`e."showInPortal" IS DISTINCT FROM false AND ${releasedSql('e."publishDate"', `${$(schoolClock.zoneOf(schoolId))}::text`)}`);
    if (term !== null && term !== undefined) w.push(`COALESCE(e."term", '') = ${$(String(term))}`);
    const { rows } = await pool.query(`
        SELECT r."student"::text AS "student", r."exam"::text AS "exam", r."subjects", r."totalMarks", r."totalMaxMarks", r."percentage",
               r."grade", r."rank", r."isPassed",
               e."title", e."code", e."examType", COALESCE(NULLIF(e."typeKey", ''), e."examType") AS "typeKey", e."typeLabel",
               COALESCE(e."term", '') AS "term", e."startDate", e."endDate", e."includeInOverall", e."showRank", e."gradeBands",
               e."withheld", e."createdAt",
               e."section"::text AS "section", s."sectionName", c."className", c."classNumber",
               (SELECT count(*)::int FROM ${T.results} x WHERE x."exam" = e."_id") AS "outOf"
          FROM ${T.results} r
          JOIN ${T.exams} e ON e."_id" = r."exam"
          LEFT JOIN ${T.sections} s ON s."_id" = e."section"
          LEFT JOIN ${T.classes} c ON c."_id" = s."class"
         WHERE e."school" = $1::uuid AND e."academicYear" = $2::uuid AND e."status" = 'FINAL_APPROVED'
           ${w.length ? `AND ${w.join(' AND ')}` : ''}
         ORDER BY COALESCE(e."endDate", e."startDate") NULLS LAST, e."createdAt", e."_id"`, params);
    return rows.map((r) => ({
        ...r,
        withheld: (Array.isArray(r.withheld) ? r.withheld : []).some((x) => String(x.student) === r.student)
            ? (r.withheld.find((x) => String(x.student) === r.student)?.reason || 'withheld') : null,
    }));
}

/** Approved class tests of a year for these students: [{ student, subject, marks, max, absent, testDate }]. */
async function yearTests(schoolId, yearId, studentIds) {
    const ids = [...new Set((studentIds || []).map(String))].filter(isUuid);
    if (!ids.length) return [];
    const { rows } = await pool.query(`
        SELECT m->>'student' AS "student", ct."subject"::text AS "subject", ct."maxMarks", ct."testDate",
               (m->>'marksObtained')::numeric AS "marks", COALESCE(m->>'isAbsent', 'false') = 'true' AS "absent"
          FROM ${T.tests} ct CROSS JOIN LATERAL jsonb_array_elements(${jarr('ct."marks"')}) m
         WHERE ct."school" = $1::uuid AND ct."academicYear" = $2::uuid AND ct."status" = 'FINAL_APPROVED'
           AND m->>'student' = ANY($3::text[])`, [String(schoolId), String(yearId), ids]);
    return rows.filter((r) => r.absent || r.marks !== null).map((r) => ({
        student: r.student, subject: r.subject, max: num(r.maxMarks), marks: r.absent ? 0 : num(r.marks), absent: !!r.absent, testDate: r.testDate,
    }));
}

/** The counted exams of one student's list: those included in the overall, else every one (`basis: 'all'`). */
function chosen(list) {
    const counted = list.filter((r) => r.includeInOverall === true);
    return { basis: counted.length ? 'overall' : 'all', rows: counted.length ? counted : list };
}

/** The scale to grade the year on: the newest counted exam's, as published; else the class's. */
function yearScale(rows, conf) {
    const withBands = [...rows].reverse().find((r) => r.gradeBands && Array.isArray(r.gradeBands.bands));
    if (withBands) return withBands.gradeBands;
    const last = rows.at(-1);
    return settings.scaleForClass(conf, last?.classNumber);
}

const papersOf = (r) => (Array.isArray(r.subjects) ? r.subjects : []).filter((x) => !x.gradeOnly);
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const bestOf = (list, n) => (n ? [...list].sort((a, b) => b - a).slice(0, n) : list);
const pctOf = (marks, max) => (max > 0 ? (marks / max) * 100 : null);

/** One group of exams (a term, or the year) per subject: Map(subject → pct), and the group's percentage. */
function groupFigures(rows, tests, rule) {
    const subjects = new Map();
    if (rule.method === 'weighted') {
        const ids = new Set([...rows.flatMap((r) => papersOf(r).map((x) => String(x.subject))), ...tests.map((x) => String(x.subject))]);
        for (const sid of ids) {
            let weighed = 0; let weights = 0;
            for (const part of rule.parts) {
                let pcts;
                if (part.source === settings.CLASS_TEST) {
                    pcts = tests.filter((x) => String(x.subject) === sid && x.max > 0).map((x) => (x.marks / x.max) * 100);
                } else {
                    pcts = rows.filter((r) => r.typeKey === part.source).flatMap((r) => papersOf(r).filter((x) => String(x.subject) === sid && Number(x.maxMarks) > 0)
                        .map((x) => (x.isAbsent ? 0 : (num(x.marksObtained) / num(x.maxMarks)) * 100)));
                }
                const p = avg(bestOf(pcts, part.best));
                if (p === null) continue;
                weighed += p * part.weight; weights += part.weight;
            }
            if (weights) subjects.set(sid, { pct: weighed / weights });
        }
        const pcts = [...subjects.values()].map((x) => x.pct);
        return { subjects, pct: avg(pcts), marks: null, max: null };
    }
    // 'marks': added up, per subject and in all.
    const per = new Map();
    for (const r of rows) {
        for (const x of papersOf(r)) {
            const sid = String(x.subject);
            const cur = per.get(sid) || { marks: 0, max: 0 };
            cur.marks += x.isAbsent ? 0 : num(x.marksObtained); cur.max += num(x.maxMarks);
            per.set(sid, cur);
        }
    }
    for (const [sid, v] of per) subjects.set(sid, { pct: pctOf(v.marks, v.max), marks: v.marks, max: v.max });
    const marks = rows.reduce((s, r) => s + num(r.totalMarks), 0);
    const max = rows.reduce((s, r) => s + num(r.totalMaxMarks), 0);
    return { subjects, pct: pctOf(marks, max), marks, max };
}

/**
 * One student's year from their counted results (and class tests).
 *   → { basis, method, marks, max, percentage, grade, isPassed, scale, termWise,
 *       subjects: Map(subject → { percentage, grade, isPassed, marks, max }), exams: [ids] }
 *   or null when nothing is counted.
 */
function yearOf(list, tests, conf, { allowAll = false } = {}) {
    const pick = chosen(list);
    if (!list.length || (!allowAll && pick.basis === 'all')) return null;
    const rows = pick.rows;
    const rule = conf.overall;
    const scale = yearScale(rows, conf);
    const usesTests = rule.method === 'weighted' && rule.parts.some((p) => p.source === settings.CLASS_TEST);
    const yearTests = usesTests ? tests : [];
    const weightedTerms = (conf.terms || []).some((x) => x.weight !== null && x.weight !== undefined);

    let group;
    if (weightedTerms) {
        // Each term its own figures, then the terms weighed.
        const weightOf = new Map(conf.terms.map((x) => [x.key, x.weight ?? 0]));
        const byTerm = new Map();
        rows.forEach((r) => { if (!byTerm.has(r.term)) byTerm.set(r.term, []); byTerm.get(r.term).push(r); });
        const terms = [...byTerm.entries()].map(([key, rs]) => ({ key, w: weightOf.get(key) || 0, f: groupFigures(rs, yearTests, rule) }))
            .filter((x) => x.w > 0 && x.f.pct !== null);
        const subjects = new Map();
        const ids = new Set(terms.flatMap((x) => [...x.f.subjects.keys()]));
        for (const sid of ids) {
            let s = 0; let w = 0;
            for (const x of terms) { const v = x.f.subjects.get(sid); if (v && v.pct !== null) { s += v.pct * x.w; w += x.w; } }
            if (w) subjects.set(sid, { pct: s / w });
        }
        const total = terms.reduce((a, x) => a + x.w, 0);
        group = { subjects, pct: total ? terms.reduce((a, x) => a + x.f.pct * x.w, 0) / total : null, marks: null, max: null };
    } else {
        group = groupFigures(rows, yearTests, rule);
    }
    if (group.pct === null) return null;

    // Passing: every counted exam, or every subject on its year's figure.
    const subjectPassedEvery = (sid) => rows.every((r) => papersOf(r).filter((x) => String(x.subject) === sid).every((x) => x.isPassed));
    const subjects = new Map();
    for (const [sid, v] of group.subjects) {
        const passed = rule.passRule === 'aggregate' ? v.pct >= rule.passPercent : subjectPassedEvery(sid);
        subjects.set(sid, {
            percentage: round2(v.pct), isPassed: passed, grade: settings.gradeFor(v.pct, 100, passed, false, scale),
            marks: v.marks === undefined ? null : round2(v.marks), max: v.max === undefined ? null : round2(v.max),
        });
    }
    const isPassed = rule.passRule === 'aggregate' ? [...subjects.values()].every((x) => x.isPassed) : rows.every((r) => r.isPassed === true);
    const pct = round2(group.pct);
    return {
        basis: pick.basis, method: rule.method, termWise: weightedTerms,
        marks: group.marks === null ? null : round2(group.marks), max: group.max === null ? null : round2(group.max),
        percentage: pct, grade: settings.overallGrade(pct, isPassed, scale), isPassed, scale,
        subjects, exams: rows.map((r) => r.exam),
        withheld: rows.some((r) => r.withheld) ? (rows.find((r) => r.withheld).withheld) : null,
    };
}

/** Group a year's rows by student. */
function byStudent(rows) {
    const out = new Map();
    rows.forEach((r) => { if (!out.has(r.student)) out.set(r.student, []); out.get(r.student).push(r); });
    return out;
}

/**
 * Overall figures for many students at once, with competition ranks within
 * the section of their latest counted exam and within the class (every
 * section of it). → Map(student → year + { section, rank, outOf, classRank, classOutOf })
 */
async function yearsFor(schoolId, yearId, { studentIds = null, sectionIds = null, classNumber = null, family = false, allowAll = false, term = null } = {}) {
    const conf = await settings.get(schoolId);
    const rows = await yearResults(schoolId, yearId, { studentIds, sectionIds, classNumber, family, term });
    const grouped = byStudent(rows);
    const usesTests = conf.overall.method === 'weighted' && conf.overall.parts.some((p) => p.source === settings.CLASS_TEST);
    const tests = usesTests ? await yearTests(schoolId, yearId, [...grouped.keys()]) : [];
    const testsOf = new Map();
    tests.forEach((x) => { if (!testsOf.has(x.student)) testsOf.set(x.student, []); testsOf.get(x.student).push(x); });
    const out = new Map();
    for (const [student, list] of grouped) {
        const y = yearOf(list, testsOf.get(student) || [], conf, { allowAll });
        if (!y) continue;
        const last = chosen(list).rows.at(-1);
        out.set(student, { ...y, section: last.section, sectionName: last.sectionName, className: last.className, classNumber: last.classNumber, rows: list });
    }
    rankWithin(out, (y) => y.section, 'rank', 'outOf');
    rankWithin(out, (y) => String(y.classNumber ?? y.className ?? ''), 'classRank', 'classOutOf');
    return { years: out, conf };
}

/** Competition rank on the percentage, within each group. */
function rankWithin(map, keyOf, rankKey, outKey) {
    const groups = new Map();
    for (const [student, y] of map) {
        const k = keyOf(y);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push([student, y]);
    }
    for (const list of groups.values()) {
        list.sort((a, b) => b[1].percentage - a[1].percentage);
        list.forEach(([, y], i) => {
            y[rankKey] = i > 0 && list[i - 1][1].percentage === y.percentage ? list[i - 1][1][rankKey] : i + 1;
            y[outKey] = list.length;
        });
    }
}

module.exports = { yearResults, yearTests, yearOf, yearsFor, chosen, yearScale, rankWithin, byStudent, releasedSql };
