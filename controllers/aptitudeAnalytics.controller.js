'use strict';
/**
 * Aptitude exam analytics — for school admins (every exam in the school) and
 * teachers (the exams they wrote or that reach a section they class-teach).
 *
 *   GET …/exams/analytics      the overview: how exams went across a year —
 *                              subject-wise, class-wise, the trend, the score
 *                              spread, and the students to celebrate or support.
 *   GET …/exams/:id/report     one exam in depth: its figures, what stands out,
 *                              marks distribution, section-wise and
 *                              student-wise results, and question analysis
 *                              (difficulty, discrimination, options chosen).
 *
 * Scores are computed exactly as a student's own result is (grade() /
 * scoredAttemptsSql — all-or-nothing per question, against the exam's total).
 * The admin routes set `req.examScope = 'school'`.
 */
const pool             = require('../db/pool');
const AptitudeExam     = require('../models/AptitudeExam');
const AptitudeQuestion = require('../models/AptitudeQuestion');
const ExamAttempt      = require('../models/ExamAttempt');
const { examSectionIds, scoredAttemptsSql } = require('../services/aptitudeExam');
const {
    T, PASS_RATIO, fetchRows, listWhere, resolveYear, yearOptions,
    classTeacherSections, readableExam, grade, rosterOf,
} = require('../services/aptitudeRead');

const fail = (res, e) => res.status(500).json({ success: false, message: e.message });
const FINISHED = ['submitted', 'auto_submitted'];
const GENERAL = 'General Aptitude';

const round = (n, d = 0) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (score, total) => (total ? (score / total) * 100 : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdDev(xs) {
    if (xs.length < 2) return null;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((n, x) => n + (x - m) ** 2, 0) / xs.length);
}

/** Ten bands of 10% — the last one closed at 100. */
function bands(pcts) {
    return Array.from({ length: 10 }, (_, i) => ({
        label: i === 9 ? '90–100%' : `${i * 10}–${i * 10 + 9}%`,
        from: i * 10,
        count: pcts.filter(p => (i === 9 ? p >= 90 : p >= i * 10 && p < i * 10 + 10)).length,
    }));
}

/**
 * The teacher's reach, as a WHERE over `ex`, appended to `params` (which
 * already hold `$1` school and `$2` zone as the first two slots of the query).
 */
async function scopeClause(req, params) {
    if (req.examScope === 'school') return 'true';
    const own = await classTeacherSections(req);
    // Placeholders continue after $1/$2 and whatever filters are already in `params`.
    const a = params.length + 3; const b = params.length + 4;
    params.push(String(req.userId), own);
    return `(ex."createdBy" = $${a}::uuid
             OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(ex.secs) t(id) WHERE t.id = ANY($${b}::text[])))`;
}

// ── Overview ─────────────────────────────────────────────────────────────────

exports.getOverview = async (req, res) => {
    try {
        const { yearId } = await resolveYear(req.schoolId, req.query.year || req.query.academicYear);
        const { params, where } = listWhere({ yearId, subject: req.query.subject, classNumber: req.query.classNumber });
        const scope = await scopeClause(req, params);
        const fullWhere = `${where} AND ${scope}`;

        const scopeOnly = [];
        const scopeForYears = await scopeClause(req, scopeOnly);
        const [rows, years] = await Promise.all([
            fetchRows({ schoolId: req.schoolId, where: fullWhere, params, order: 'ex.start_ts ASC', limit: 1000 }),
            yearOptions(req.schoolId, { where: scopeForYears, params: scopeOnly }),
        ]);

        const closed = rows.filter(r => r.stage === 'completed');
        const ids = closed.map(r => r._id);
        const attempts = ids.length ? (await pool.query(
            `WITH scored AS (${scoredAttemptsSql('$1', T)})
             SELECT s."exam", s."student", s.score::float AS score, e."totalMarks" AS total,
                    a."startedAt", a."submittedAt", a."violationCount", a."status",
                    u."name", sp."rollNumber", c."className", c."classNumber", cs."sectionName", cs."_id" AS section
               FROM scored s
               JOIN ${T.exams} e      ON e."_id" = s."exam"
               JOIN ${T.attempts} a   ON a."_id" = s."_id"
               LEFT JOIN ${T.users} u    ON u."_id" = s."student"
               LEFT JOIN ${T.profiles} sp ON sp."user" = s."student"
               LEFT JOIN ${T.sections} cs ON cs."_id" = a."section"
               LEFT JOIN ${T.classes} c   ON c."_id" = cs."class"`,
            [ids],
        )).rows : [];
        attempts.forEach(a => { a.pct = pct(a.score, a.total); a.passed = a.score >= a.total * PASS_RATIO; });

        const byExam = new Map();
        attempts.forEach(a => { const k = String(a.exam); if (!byExam.has(k)) byExam.set(k, []); byExam.get(k).push(a); });
        const statOf = (list) => ({
            attempts: list.length,
            average: round(mean(list.map(a => a.pct))),
            passRate: list.length ? round((list.filter(a => a.passed).length / list.length) * 100) : null,
            highest: list.length ? round(Math.max(...list.map(a => a.pct))) : null,
            lowest: list.length ? round(Math.min(...list.map(a => a.pct))) : null,
        });

        const eligible = closed.reduce((n, r) => n + r.eligible, 0);
        const submitted = closed.reduce((n, r) => n + r.submitted, 0);
        const times = attempts.filter(a => a.startedAt && a.submittedAt).map(a => new Date(a.submittedAt) - new Date(a.startedAt));

        // Subject-wise: exams grouped by subject name (subjects are per-year rows).
        const subjects = new Map();
        closed.forEach(r => {
            const name = r.subjectName || GENERAL;
            if (!subjects.has(name)) subjects.set(name, { name, exams: 0, list: [], best: null });
            const g = subjects.get(name);
            const list = byExam.get(String(r._id)) || [];
            g.exams += 1; g.list.push(...list);
            const avg = mean(list.map(a => a.pct));
            if (avg != null && (!g.best || avg > g.best.average)) g.best = { _id: r._id, title: r.title, average: round(avg) };
        });

        // Class-wise: by the section each student sat the exam in.
        const classes = new Map();
        attempts.forEach(a => {
            const key = String(a.section || 'unknown');
            if (!classes.has(key)) classes.set(key, { key, label: a.className ? `${a.className} – ${a.sectionName}` : 'Unplaced', classNumber: a.classNumber, sectionName: a.sectionName || '', list: [], students: new Set() });
            const g = classes.get(key); g.list.push(a); g.students.add(String(a.student));
        });

        // Students across exams.
        const students = new Map();
        attempts.forEach(a => {
            const key = String(a.student);
            if (!students.has(key)) students.set(key, { _id: key, name: a.name || '—', rollNumber: a.rollNumber || '', className: a.className ? `${a.className} – ${a.sectionName}` : '', list: [] });
            students.get(key).list.push(a);
        });
        const studentRows = [...students.values()].map(s => ({
            _id: s._id, name: s.name, rollNumber: s.rollNumber, className: s.className,
            exams: s.list.length,
            average: round(mean(s.list.map(a => a.pct))),
            best: round(Math.max(...s.list.map(a => a.pct))),
            passed: s.list.filter(a => a.passed).length,
        }));

        const passMarkPct = PASS_RATIO * 100;
        res.json({
            success: true,
            data: {
                academicYear: yearId || 'all',
                academicYears: years,
                kpis: {
                    exams: rows.length,
                    closed: closed.length,
                    upcoming: rows.filter(r => ['scheduled', 'live'].includes(r.stage)).length,
                    drafts: rows.filter(r => r.stage === 'draft').length,
                    attempts: attempts.length,
                    students: students.size,
                    average: round(mean(attempts.map(a => a.pct))),
                    median: round(median(attempts.map(a => a.pct))),
                    passRate: attempts.length ? round((attempts.filter(a => a.passed).length / attempts.length) * 100) : null,
                    completion: eligible ? round((submitted / eligible) * 100) : null,
                    submitted, eligible,
                    averageTime: times.length ? Math.round(mean(times)) : null,
                    autoSubmitted: attempts.filter(a => a.status === 'auto_submitted').length,
                    passMark: passMarkPct,
                },
                subjects: [...subjects.values()]
                    .map(g => ({ name: g.name, exams: g.exams, ...statOf(g.list), best: g.best }))
                    .sort((a, b) => (b.average ?? -1) - (a.average ?? -1)),
                classes: [...classes.values()]
                    .map(g => ({ key: g.key, label: g.label, students: g.students.size, ...statOf(g.list), classNumber: g.classNumber, sectionName: g.sectionName }))
                    .sort((a, b) => (a.classNumber ?? 999) - (b.classNumber ?? 999) || String(a.sectionName).localeCompare(String(b.sectionName))),
                trend: closed.map(r => {
                    const st = statOf(byExam.get(String(r._id)) || []);
                    return { _id: r._id, title: r.title, date: r.startsAt, average: st.average, passRate: st.passRate, attempts: st.attempts };
                }).filter(t => t.attempts > 0),
                distribution: bands(attempts.map(a => a.pct)),
                exams: [...rows].reverse().map(r => {
                    const st = statOf(byExam.get(String(r._id)) || []);
                    return {
                        _id: r._id, title: r.title, subjectName: r.subjectName, stage: r.stage, examDate: r.examDate, startTime: r.startTime,
                        startsAt: r.startsAt, audience: r.audience, eligible: r.eligible, submitted: r.submitted, totalMarks: r.totalMarks,
                        completion: r.eligible ? round((r.submitted / r.eligible) * 100) : null,
                        average: st.average, highest: st.highest, lowest: st.lowest, passRate: st.passRate, results: r.results,
                    };
                }),
                topStudents: studentRows.filter(s => s.average != null).sort((a, b) => b.average - a.average || b.exams - a.exams).slice(0, 8),
                needsSupport: studentRows.filter(s => s.average != null && s.average < passMarkPct).sort((a, b) => a.average - b.average).slice(0, 8),
                options: {
                    subjects: [...new Set(rows.map(r => r.subjectName || GENERAL))].sort()
                        .map(n => ({ value: n === GENERAL ? '__general' : n, label: n })),
                    classes: [...new Map(rows.flatMap(r => r.sections.map(s => [s.classNumber, s.className]))).entries()]
                        .filter(([n]) => n != null).sort((a, b) => a[0] - b[0])
                        .map(([n, name]) => ({ value: String(n), label: name })),
                },
            },
        });
    } catch (e) { fail(res, e); }
};

// ── One exam ─────────────────────────────────────────────────────────────────

exports.getExamReport = async (req, res) => {
    try {
        const hit = await readableExam(req);
        if (!hit) return res.status(404).json({ success: false, message: 'Exam not found' });
        const raw = hit.exam;

        const [[row], questions, attempts, roster] = await Promise.all([
            fetchRows({ schoolId: req.schoolId, where: 'ex."_id" = $3::uuid', params: [raw._id], order: 'ex."_id"' }),
            AptitudeQuestion.find({ exam: raw._id }).sort({ order: 1 }).lean(),
            ExamAttempt.find({ exam: raw._id }).populate('student', 'name email profileImage').lean(),
            rosterOf(raw),
        ]);

        const total = Number(raw.totalMarks) || 0;
        const passMark = Math.ceil(total * PASS_RATIO);

        // Section names for every section the exam reaches and every section a student sat it in.
        const sectionIds = [...new Set([...examSectionIds(raw), ...attempts.map(a => String(a.section)).filter(Boolean)])];
        const { rows: secRows } = sectionIds.length ? await pool.query(
            `SELECT s."_id", s."sectionName", c."className", c."classNumber"
               FROM ${T.sections} s LEFT JOIN ${T.classes} c ON c."_id" = s."class"
              WHERE s."_id" = ANY($1::uuid[])`, [sectionIds]) : { rows: [] };
        const secLabel = new Map(secRows.map(s => [String(s._id), { label: `${s.className} – ${s.sectionName}`, classNumber: s.classNumber, sectionName: s.sectionName }]));
        const { rows: profiles } = attempts.length ? await pool.query(
            `SELECT sp."user", sp."rollNumber" FROM ${T.profiles} sp WHERE sp."user" = ANY($1::uuid[])`,
            [attempts.map(a => String(a.student?._id || a.student))]) : { rows: [] };
        const rollOf = new Map(profiles.map(p => [String(p.user), p.rollNumber || '']));

        // ── Every student: attempts marked, and the roster who never opened it ──
        const graded = attempts.map(a => {
            const sid = String(a.student?._id || a.student);
            const done = FINISHED.includes(a.status);
            const g = done ? grade(questions, a.answers || []) : null;
            return {
                _id: sid,
                name: a.student?.name || '—',
                photo: a.student?.profileImage || '',
                rollNumber: rollOf.get(sid) || '',
                section: String(a.section || ''),
                className: secLabel.get(String(a.section))?.label || '',
                status: a.status,
                score: g ? g.score : null,
                percentage: g ? round(pct(g.score, total)) : null,
                exactPct: g ? pct(g.score, total) : null,
                passed: g ? g.score >= passMark : null,
                correct: g?.correct ?? null, incorrect: g?.incorrect ?? null, unanswered: g?.unanswered ?? null,
                timeTaken: a.startedAt && a.submittedAt ? new Date(a.submittedAt) - new Date(a.startedAt) : null,
                violations: a.violationCount || 0,
                submittedAt: a.submittedAt,
                items: g?.items || null,
            };
        });
        const started = new Set(graded.map(g => g._id));
        const closedStage = row?.stage === 'completed';
        const missing = roster.filter(s => !started.has(String(s._id))).map(s => ({
            _id: String(s._id), name: s.name, photo: s.photo || '', rollNumber: s.rollNumber || '', className: s.className || '',
            section: '', status: closedStage ? 'missed' : 'not_started',
            score: null, percentage: null, passed: null, correct: null, incorrect: null, unanswered: null, timeTaken: null, violations: 0,
        }));
        // Roster rows carry a label but no section id; recover it from the label.
        const idByLabel = new Map([...secLabel.entries()].map(([id, v]) => [v.label, id]));
        missing.forEach(m => { m.section = idByLabel.get(m.className) || ''; });

        const finished = graded.filter(g => g.score != null).sort((a, b) => b.score - a.score);
        let rank = 0; let last = null;
        finished.forEach((g, i) => { if (g.score !== last) { rank = i + 1; last = g.score; } g.rank = rank; });

        // Statistics from exact percentages — averaging each student's rounded
        // figure drifts from the overview, which averages the exact ones.
        const pcts = finished.map(g => g.exactPct);
        const times = finished.filter(g => g.timeTaken != null).map(g => g.timeTaken);
        const eligible = graded.length + missing.length;
        const passedN = finished.filter(g => g.passed).length;

        const kpis = {
            eligible,
            started: graded.length,
            submitted: finished.length,
            autoSubmitted: graded.filter(g => g.status === 'auto_submitted').length,
            inProgress: graded.filter(g => g.status === 'in_progress').length,
            notAttempted: missing.length,
            completion: eligible ? round((finished.length / eligible) * 100) : null,
            totalMarks: total,
            passMark,
            averageScore: finished.length ? round(mean(finished.map(g => g.score)), 1) : null,
            average: round(mean(pcts)),
            median: round(median(pcts)),
            stdDev: round(stdDev(pcts), 1),
            highest: finished.length ? finished[0].score : null,
            lowest: finished.length ? finished[finished.length - 1].score : null,
            passed: passedN,
            passRate: finished.length ? round((passedN / finished.length) * 100) : null,
            averageTime: times.length ? Math.round(mean(times)) : null,
            fastest: times.length ? Math.min(...times) : null,
            slowest: times.length ? Math.max(...times) : null,
            duration: raw.duration,
            violations: graded.reduce((n, g) => n + g.violations, 0),
            studentsWithViolations: graded.filter(g => g.violations > 0).length,
            questions: questions.length,
        };

        // ── Section-wise ──
        const sectionKeys = [...new Set([...examSectionIds(raw), ...graded.map(g => g.section).filter(Boolean)])];
        const sections = sectionKeys.map(id => {
            const mine = [...graded, ...missing].filter(g => g.section === id);
            const done = mine.filter(g => g.score != null);
            const p = done.map(g => g.exactPct);
            return {
                _id: id,
                label: secLabel.get(id)?.label || 'Unknown section',
                classNumber: secLabel.get(id)?.classNumber ?? null,
                eligible: mine.length,
                submitted: done.length,
                completion: mine.length ? round((done.length / mine.length) * 100) : null,
                average: round(mean(p)),
                highest: p.length ? round(Math.max(...p)) : null,
                lowest: p.length ? round(Math.min(...p)) : null,
                passRate: done.length ? round((done.filter(g => g.passed).length / done.length) * 100) : null,
            };
        }).sort((a, b) => (a.classNumber ?? 999) - (b.classNumber ?? 999) || a.label.localeCompare(b.label));

        // ── Question analysis ──
        // Discrimination: share right in the top 27% of scorers minus the share
        // right in the bottom 27%. Near zero, the question does not separate
        // stronger from weaker students; below zero, stronger students got it
        // wrong more often — usually a wrong key or a misleading question.
        const n27 = finished.length >= 4 ? Math.max(1, Math.round(finished.length * 0.27)) : 0;
        const upper = finished.slice(0, n27);
        const lower = finished.slice(-n27);
        const rightIn = (group, qid) => group.filter(g => g.items.find(it => String(it._id) === qid)?.isCorrect).length / (group.length || 1);

        const questionStats = questions.map((q, i) => {
            const qid = String(q._id);
            const its = finished.map(g => g.items.find(it => String(it._id) === qid)).filter(Boolean);
            const right = its.filter(it => it.isCorrect).length;
            const blank = its.filter(it => !(it.selected || []).length).length;
            const opts = (q.questionType === 'true_false' ? [{ optionId: 'true', text: 'True' }, { optionId: 'false', text: 'False' }] : q.options || [])
                .map((o, j) => ({
                    optionId: o.optionId,
                    letter: q.questionType === 'true_false' ? (o.optionId === 'true' ? 'T' : 'F') : String.fromCharCode(65 + j),
                    text: o.text,
                    isKey: (q.correctAnswers || []).includes(o.optionId),
                    chosen: its.filter(it => (it.selected || []).includes(o.optionId)).length,
                }));
            const wrong = opts.filter(o => !o.isKey && o.chosen > 0).sort((a, b) => b.chosen - a.chosen)[0] || null;
            return {
                _id: qid,
                number: i + 1,
                questionText: q.questionText,
                questionType: q.questionType,
                marks: q.marks,
                answered: its.length - blank,
                correct: right,
                incorrect: its.length - right - blank,
                unanswered: blank,
                successRate: its.length ? round((right / its.length) * 100) : null,
                discrimination: n27 ? round(rightIn(upper, qid) - rightIn(lower, qid), 2) : null,
                options: opts,
                commonWrong: wrong ? { letter: wrong.letter, text: wrong.text, chosen: wrong.chosen } : null,
            };
        });

        const types = [...new Set(questions.map(q => q.questionType))].map(t => {
            const qs = questionStats.filter(q => q.questionType === t);
            return {
                type: t, questions: qs.length, marks: qs.reduce((n, q) => n + (Number(q.marks) || 0), 0),
                successRate: round(mean(qs.map(q => q.successRate).filter(v => v != null))),
            };
        });

        // ── The same subject, in the rest of the year ──
        let subjectContext = null;
        if (row?.subjectName && raw.academicYear) {
            const { rows: peers } = await pool.query(
                `SELECT e."_id" FROM ${T.exams} e JOIN ${T.subjects} sub ON sub."_id" = e."subject"
                  WHERE e."school" = $1 AND e."academicYear" = $2 AND lower(sub."subjectName") = lower($3)
                    AND e."_id" <> $4 AND e."status" <> 'draft' AND e."status" <> 'cancelled'`,
                [String(req.schoolId), String(raw.academicYear), row.subjectName, String(raw._id)]);
            if (peers.length) {
                const { rows: sc } = await pool.query(
                    `WITH scored AS (${scoredAttemptsSql('$1', T)})
                     SELECT avg(s.score / NULLIF(e."totalMarks", 0) * 100)::float AS avg, count(DISTINCT s."exam")::int AS exams
                       FROM scored s JOIN ${T.exams} e ON e."_id" = s."exam"`, [peers.map(p => p._id)]);
                if (sc[0]?.exams) subjectContext = { subjectName: row.subjectName, exams: sc[0].exams, average: round(sc[0].avg) };
            }
        }

        // ── What stands out ──
        const insights = [];
        if (!finished.length) {
            insights.push({ tone: 'info', text: row?.stage === 'completed' ? 'Nobody submitted this exam.' : 'No submissions yet — analytics fill in as students submit.' });
        } else {
            if (kpis.average != null) {
                const passPct = PASS_RATIO * 100;
                insights.push(kpis.average >= passPct
                    ? { tone: 'good', text: `Class average ${kpis.average}% — ${kpis.passRate}% of students cleared the pass mark of ${passMark}/${total}.` }
                    : { tone: 'bad', text: `Class average ${kpis.average}% is below the pass mark (${passPct}%) — only ${passedN} of ${finished.length} passed.` });
            }
            if (kpis.notAttempted > 0 && row?.stage === 'completed') {
                insights.push({ tone: kpis.completion < 80 ? 'warn' : 'info', text: `${plural(kpis.notAttempted, 'student')} did not attempt the exam (${kpis.completion}% completion).` });
            }
            const rated = questionStats.filter(q => q.successRate != null);
            if (rated.length) {
                const hardest = [...rated].sort((a, b) => a.successRate - b.successRate)[0];
                insights.push({
                    tone: hardest.successRate < 30 ? 'warn' : 'info',
                    text: `Hardest question: Q${hardest.number} — ${hardest.successRate}% got it fully right${hardest.commonWrong ? `; the most common wrong choice was ${hardest.commonWrong.letter} “${hardest.commonWrong.text}” (${plural(hardest.commonWrong.chosen, 'student')})` : ''}.`,
                });
                const easy = rated.filter(q => q.successRate >= 90);
                if (easy.length) insights.push({ tone: 'info', text: `${plural(easy.length, 'question')} (${easy.map(q => `Q${q.number}`).join(', ')}) ${easy.length === 1 ? 'was' : 'were'} answered correctly by 90% or more.` });
            }
            const negative = questionStats.filter(q => q.discrimination != null && q.discrimination < 0);
            if (negative.length) insights.push({ tone: 'bad', text: `${negative.map(q => `Q${q.number}`).join(', ')}: stronger students got ${negative.length === 1 ? 'it' : 'these'} wrong more often than weaker ones — check the answer key.` });
            const skipped = questionStats.filter(q => q.answered + q.unanswered > 0 && q.unanswered / (q.answered + q.unanswered) >= 0.3);
            if (skipped.length) insights.push({ tone: 'warn', text: `${skipped.map(q => `Q${q.number}`).join(', ')} ${skipped.length === 1 ? 'was' : 'were'} left blank by 30% or more — a sign of time pressure or unclear wording.` });
            const withScores = sections.filter(s => s.average != null);
            if (withScores.length >= 2) {
                const sorted = [...withScores].sort((a, b) => b.average - a.average);
                const gap = sorted[0].average - sorted[sorted.length - 1].average;
                if (gap >= 10) insights.push({ tone: 'info', text: `${sorted[0].label} averaged ${gap} points above ${sorted[sorted.length - 1].label}.` });
            }
            if (kpis.autoSubmitted > 0) insights.push({ tone: 'warn', text: `${plural(kpis.autoSubmitted, 'paper')} ${kpis.autoSubmitted === 1 ? 'was' : 'were'} auto-submitted (time ran out or tab switches); ${plural(kpis.studentsWithViolations, 'student')} switched tabs during the exam.` });
            if (subjectContext) {
                const diff = kpis.average - subjectContext.average;
                insights.push({ tone: diff >= 0 ? 'good' : 'warn', text: `${Math.abs(diff)} points ${diff >= 0 ? 'above' : 'below'} the ${subjectContext.subjectName} average (${subjectContext.average}%) across ${plural(subjectContext.exams, 'other exam')} this year.` });
            }
            if (kpis.averageTime != null && raw.duration) {
                const share = Math.round((kpis.averageTime / (raw.duration * 60000)) * 100);
                if (share <= 40) insights.push({ tone: 'info', text: `Students used ${share}% of the time on average — the paper may be shorter than its ${raw.duration} minutes.` });
            }
        }

        res.json({
            success: true,
            data: {
                exam: row,
                kpis,
                distribution: bands(pcts),
                sections,
                students: [...finished, ...graded.filter(g => g.score == null), ...missing].map(({ items, exactPct, ...g }) => g),
                questions: questionStats,
                types,
                subjectContext,
                insights,
            },
        });
    } catch (e) { fail(res, e); }
};
