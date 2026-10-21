'use strict';
/**
 * How an online exam is laid out for one candidate (Oct 2026), and which of
 * their sittings counts.
 *
 *   sections     an exam's subjects, when they carry minutes, are timed
 *                sections: taken in order, each on its own clock, its answers
 *                closed when it ends (or when the candidate moves on early).
 *                The next section's clock starts when the last one closed —
 *                waiting between sections buys no time.
 *   draw         a subject's `draw` (or the exam's settings.drawCount) picks
 *                that many questions at random for each candidate. Every
 *                question drawn from one pool must carry the same marks, so
 *                every candidate's paper is worth the same.
 *   extra time   a candidate's `extraMinutes` (an accommodation the office
 *                records with its reason) lengthens the sitting — and each
 *                section in proportion — and may run past the exam's window.
 *   retakes      with more than one attempt allowed, the school chooses what
 *                counts: the latest, the best, or the average.
 *
 * The server keeps every clock; the page only shows them.
 */
const crypto = require('crypto');
const pool = require('../../db/pool');
const { round2 } = require('./util');

const RETAKE = ['latest', 'best', 'average'];

function shuffle(a) {
    const out = [...a];
    for (let i = out.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

const timedSections = (exam) => (exam.subjects || []).filter((s) => Number(s.minutes) > 0);
const isSectioned = (exam) => exam.mode === 'online' && timedSections(exam).length > 0;

/** Questions grouped by subject key ('' for none), in the exam's order. */
function pools(questions) {
    const m = new Map();
    for (const q of questions) {
        const k = q.subjectKey || '';
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(q);
    }
    return m;
}

/** What stops the layout working — checked before the exam is scheduled. */
function problems(exam, questions) {
    const out = [];
    const byKey = pools(questions);
    const subjects = exam.subjects || [];
    for (const s of subjects) {
        const list = byKey.get(s.key) || [];
        const draw = Number(s.draw) || 0;
        if (draw > 0) {
            if (list.length < draw) out.push(`${s.name}: ${draw} questions are drawn but only ${list.length} are set`);
            if (new Set(list.map((q) => Number(q.marks))).size > 1) out.push(`${s.name}: questions drawn at random must all carry the same marks, so every paper is worth the same`);
        }
    }
    if (isSectioned(exam)) {
        const loose = questions.filter((q) => !timedSections(exam).some((s) => s.key === q.subjectKey));
        if (loose.length) out.push(`${loose.length} question(s) are not in a timed section — give each one a subject that has minutes`);
    }
    const whole = Number(exam.settings?.drawCount) || 0;
    if (whole > 0 && !subjects.some((s) => Number(s.draw) > 0)) {
        if (questions.length < whole) out.push(`${whole} questions are drawn but only ${questions.length} are set`);
        if (new Set(questions.map((q) => Number(q.marks))).size > 1) out.push('Questions drawn at random must all carry the same marks, so every paper is worth the same');
    }
    return out;
}

/** The marks one candidate's paper is worth. */
function maxMarks(exam, questions) {
    const byKey = pools(questions);
    const whole = Number(exam.settings?.drawCount) || 0;
    const subjectDraws = (exam.subjects || []).some((s) => Number(s.draw) > 0);
    if (whole > 0 && !subjectDraws) return round2(whole * (Number(questions[0]?.marks) || 0));
    let total = 0;
    const counted = new Set();
    for (const s of exam.subjects || []) {
        const list = byKey.get(s.key) || [];
        counted.add(s.key);
        const draw = Number(s.draw) || 0;
        total += draw > 0 ? draw * (Number(list[0]?.marks) || 0) : list.reduce((t, q) => t + Number(q.marks || 0), 0);
    }
    for (const [k, list] of byKey) if (!counted.has(k)) total += list.reduce((t, q) => t + Number(q.marks || 0), 0);
    return round2(total);
}

/**
 * The paper for one sitting: the questions (drawn and in order), each
 * question's option order, the sections and their clocks, the deadline.
 */
function build(exam, questions, { extraMinutes = 0, now = new Date() } = {}) {
    const st = exam.settings || {};
    const byKey = pools(questions);
    const take = (list, n) => (n > 0 ? shuffle(list).slice(0, n) : (st.randomizeQuestions ? shuffle(list) : list));
    const optionOrder = {};
    for (const q of questions) {
        if ((q.type === 'single' || q.type === 'multiple') && st.randomizeOptions) optionOrder[String(q._id)] = shuffle((q.options || []).map((o) => o.id));
    }
    const extra = Math.max(0, Number(extraMinutes) || 0);
    const windowEnd = new Date(exam.endsAt).getTime() + extra * 60000;
    if (isSectioned(exam)) {
        const secs = timedSections(exam);
        const base = secs.reduce((t, s) => t + Number(s.minutes), 0);
        const sections = secs.map((s) => ({
            key: s.key, name: s.name,
            minutes: round2(Number(s.minutes) * (1 + extra / base)),
            questions: take(byKey.get(s.key) || [], Number(s.draw) || 0).map((q) => String(q._id)),
            startedAt: null, deadlineAt: null, closedAt: null,
        }));
        sections[0].startedAt = now;
        sections[0].deadlineAt = new Date(Math.min(now.getTime() + sections[0].minutes * 60000, windowEnd));
        const total = sections.reduce((t, s) => t + s.minutes, 0);
        return {
            questionOrder: sections.flatMap((s) => s.questions), optionOrder, sections, currentSection: 0,
            deadlineAt: new Date(Math.min(now.getTime() + total * 60000, windowEnd)),
        };
    }
    const whole = Number(st.drawCount) || 0;
    const subjectDraws = (exam.subjects || []).some((s) => Number(s.draw) > 0);
    let order;
    if (whole > 0 && !subjectDraws) order = take(questions, whole);
    else if (subjectDraws) {
        order = [];
        for (const s of exam.subjects || []) order.push(...take(byKey.get(s.key) || [], Number(s.draw) || 0));
        for (const [k, list] of byKey) if (!(exam.subjects || []).some((s) => s.key === k)) order.push(...take(list, 0));
        if (st.randomizeQuestions) order = shuffle(order);
    } else order = take(questions, 0);
    return {
        questionOrder: order.map((q) => String(q._id)), optionOrder, sections: [], currentSection: 0,
        deadlineAt: new Date(Math.min(now.getTime() + (Number(exam.durationMinutes) + extra) * 60000, windowEnd)),
    };
}

/**
 * Move the sections on to now: a section whose time is up is closed and the
 * next one opens at that moment. Returns the patch to store, or null.
 */
function advance(attempt, { now = new Date(), early = false } = {}) {
    const secs = (attempt.sections || []).map((s) => ({ ...s }));
    if (!secs.length) return null;
    let i = Number(attempt.currentSection) || 0;
    let changed = false;
    const finalDeadline = new Date(attempt.deadlineAt).getTime();
    while (i < secs.length) {
        const s = secs[i];
        const due = s.deadlineAt && new Date(s.deadlineAt).getTime() <= now.getTime();
        if (!due && !(early && !changed)) break;
        s.closedAt = due ? s.deadlineAt : now;
        changed = true;
        i += 1;
        if (i < secs.length) {
            const start = new Date(s.closedAt);
            secs[i].startedAt = start;
            secs[i].deadlineAt = new Date(Math.min(start.getTime() + secs[i].minutes * 60000, finalDeadline));
        }
        if (early) break;
    }
    return changed ? { sections: secs, currentSection: i } : null;
}

/** The questions whose answers may still change: the open section's, or all of them. */
function openQuestionIds(attempt) {
    const secs = attempt.sections || [];
    if (!secs.length) return new Set((attempt.questionOrder || []).map(String));
    const cur = secs[Number(attempt.currentSection) || 0];
    return new Set(cur ? cur.questions.map(String) : []);
}

/**
 * Which sitting counts, by the exam's retake rule. Each sitting's total is its
 * objective score plus any marks evaluators gave its written answers.
 */
async function counting(exam, applicationId, q = null) {
    const run = q || ((s, p) => pool.query(s, p));
    const { rows } = await run(
        `SELECT "_id", "attemptNo", "autoScore", "manualMarks", "manualPending", "submittedAt" FROM "admissionattempts"
          WHERE "exam" = $1 AND "application" = $2 AND "status" IN ('submitted', 'auto_submitted') ORDER BY "attemptNo"`, [String(exam._id), String(applicationId)]);
    if (!rows.length) return null;
    const manualOf = (a) => {
        const vals = Object.values(a.manualMarks || {}).map((m) => Number(m?.marks)).filter((n) => Number.isFinite(n));
        return vals.length ? round2(vals.reduce((s, n) => s + n, 0)) : null;
    };
    const total = (a) => (Number(a.autoScore) || 0) + (manualOf(a) || 0);
    const rule = RETAKE.includes(exam.settings?.retakePolicy) ? exam.settings.retakePolicy : 'latest';
    if (rule === 'best') {
        const best = rows.reduce((b, a) => (total(a) > total(b) ? a : b), rows[0]);
        return { autoScore: best.autoScore, manualScore: manualOf(best), attemptNo: best.attemptNo, rule, sittings: rows.length };
    }
    if (rule === 'average') {
        const auto = round2(rows.reduce((t, a) => t + (Number(a.autoScore) || 0), 0) / rows.length);
        const man = rows.some((a) => manualOf(a) != null) ? round2(rows.reduce((t, a) => t + (manualOf(a) || 0), 0) / rows.length) : null;
        return { autoScore: auto, manualScore: man, attemptNo: null, rule, sittings: rows.length };
    }
    const last = rows[rows.length - 1];
    return { autoScore: last.autoScore, manualScore: manualOf(last), attemptNo: last.attemptNo, rule, sittings: rows.length };
}

/** The page's signals, summed for the evaluator — evidence to look at, never a mark. */
function signals(attempt) {
    const out = {};
    for (const v of attempt?.violations || []) out[v.type] = (out[v.type] || 0) + 1;
    return out;
}

module.exports = { RETAKE, isSectioned, problems, maxMarks, build, advance, openQuestionIds, counting, signals, shuffle };
