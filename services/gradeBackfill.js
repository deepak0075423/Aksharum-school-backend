'use strict';
/**
 * Re-grade results stored before Oct 2026, when a grade could contradict the
 * result printed beside it (scripts/fixResultGrades.js by hand; db/migrate.js
 * runs it once, on the first boot of a server that has it).
 *
 * Grades were bands of percentage alone, and the pass mark is the school's own
 * per subject — so with the usual pass mark of 33, a student on 35% PASSED a
 * subject with grade F, and one on 45% against a pass mark of 50 FAILED it with
 * grade D. services/resultSettings now grades so the two always agree (gradeFor
 * / overallGrade): absent is AB, not passed is the highest failing grade, and a
 * pass is never a failing grade.
 *
 * Only grade letters change. Marks, totals, percentages, pass/fail and ranks
 * stay exactly as published — the stored `isPassed` (grace included) is what
 * the grade is made to agree with. Each result is graded on the scale its
 * exam was published on (FormalExam.gradeBands) — else its class's scale; a
 * class test on its class's. A graded-only paper keeps the grade its teacher
 * gave: it was never worked out from marks. Safe to run any number of times.
 *
 * At boot the server is already answering while this runs, so a row is only
 * written if it is still as it was read; one saved meanwhile was graded by the
 * new code anyway, and is left alone (counted in `skipped`).
 */
const pool = require('../db/pool');
const { gradeFor, overallGrade, scaleOf } = require('./resultSettings');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function regrade({ apply = false, school = null } = {}) {
    const scales = new Map();
    const scaleFor = async (schoolId, classNumber) => {
        const k = `${schoolId}:${classNumber ?? ''}`;
        if (!scales.has(k)) scales.set(k, await scaleOf(String(schoolId), classNumber));
        return scales.get(k);
    };

    // Exam results.
    const { rows } = await pool.query(`
        SELECT r."_id", r."school", r."subjects", r."percentage", r."grade", r."isPassed", e."gradeBands", c."classNumber"
          FROM "formalresults" r
          LEFT JOIN "formalexams" e ON e."_id" = r."exam"
          LEFT JOIN "classsections" s ON s."_id" = e."section"
          LEFT JOIN "classes" c ON c."_id" = s."class"
         ${school ? 'WHERE r."school" = $1::uuid' : ''}`, school ? [school] : []);
    const results = { scanned: rows.length, changed: 0, subjectsChanged: 0, skipped: 0, samples: [] };
    for (const r of rows) {
        const scale = r.gradeBands?.bands ? r.gradeBands : await scaleFor(r.school, r.classNumber);
        const subjects = Array.isArray(r.subjects) ? r.subjects : [];
        let touched = false;
        const next = subjects.map((x) => {
            if (x.gradeOnly) return x;
            const g = gradeFor(num(x.marksObtained), num(x.maxMarks), !!x.isPassed, !!x.isAbsent, scale);
            if (g === x.grade) return x;
            touched = true; results.subjectsChanged += 1;
            if (results.samples.length < 5) results.samples.push(`subject ${x.marksObtained}/${x.maxMarks} ${x.isPassed ? 'pass' : 'fail'}: ${x.grade} → ${g}`);
            return { ...x, grade: g };
        });
        const overall = overallGrade(num(r.percentage), !!r.isPassed, scale);
        if (overall !== r.grade) touched = true;
        if (!touched) continue;
        results.changed += 1;
        if (apply) {
            const { rowCount } = await pool.query(`
                UPDATE "formalresults" SET "subjects" = $2::jsonb, "grade" = $3
                 WHERE "_id" = $1::uuid AND "subjects" IS NOT DISTINCT FROM $4::jsonb AND "grade" IS NOT DISTINCT FROM $5`,
                [String(r._id), JSON.stringify(next), overall, r.subjects == null ? null : JSON.stringify(r.subjects), r.grade]);
            if (!rowCount) { results.changed -= 1; results.skipped += 1; }
        }
    }

    // Class tests: each mark graded on its class's scale.
    const { rows: tests } = await pool.query(`
        SELECT t."_id", t."school", t."marks", t."maxMarks", t."passingMarks", c."classNumber"
          FROM "classtests" t
          LEFT JOIN "classsections" s ON s."_id" = t."section"
          LEFT JOIN "classes" c ON c."_id" = s."class"
         ${school ? 'WHERE t."school" = $1::uuid' : ''}`, school ? [school] : []);
    const classTests = { scanned: tests.length, changed: 0, marksChanged: 0, skipped: 0 };
    for (const t of tests) {
        const scale = await scaleFor(t.school, t.classNumber);
        const marks = Array.isArray(t.marks) ? t.marks : [];
        let touched = false;
        const next = marks.map((m) => {
            if (m.isAbsent || m.marksObtained === null || m.marksObtained === undefined) return m;
            const value = num(m.marksObtained);
            const g = gradeFor(value, num(t.maxMarks), value >= num(t.passingMarks), false, scale);
            if (g === m.grade) return m;
            touched = true; classTests.marksChanged += 1;
            return { ...m, grade: g };
        });
        if (!touched) continue;
        classTests.changed += 1;
        if (apply) {
            const { rowCount } = await pool.query(`UPDATE "classtests" SET "marks" = $2::jsonb WHERE "_id" = $1::uuid AND "marks" IS NOT DISTINCT FROM $3::jsonb`,
                [String(t._id), JSON.stringify(next), t.marks == null ? null : JSON.stringify(t.marks)]);
            if (!rowCount) { classTests.changed -= 1; classTests.skipped += 1; }
        }
    }
    return { results, classTests };
}

module.exports = { regrade };
