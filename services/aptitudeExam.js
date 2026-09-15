'use strict';
/**
 * What the aptitude exam controllers share: scoring, the exam's time window,
 * the sections it reaches, the question rules, and the SQL fragments the admin
 * screen counts with.
 *
 * The SQL here must agree with the JavaScript beside it. The student is scored
 * by `scoreAttempt()` when they open their result; the admin's averages are
 * scored by `SCORED_ATTEMPTS` in Postgres. If the two ever disagree the admin
 * sees a class average no student's own result adds up to — so every rule in
 * one has a twin in the other, and the comments say which.
 */
const AcademicYear = require('../models/AcademicYear');

// ── Scoring ───────────────────────────────────────────────────────────────────

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/** All-or-nothing per question: the chosen set must equal the correct set exactly. */
function scoreAttempt(questions, answers) {
    let score = 0;
    const ansMap = Object.fromEntries((answers || []).map(a => [a.question.toString(), a.selectedOptions || []]));
    for (const q of questions) {
        const selected = ansMap[q._id.toString()] || [];
        const correct  = q.correctAnswers || [];
        const isCorrect = selected.length === correct.length &&
            correct.every(c => selected.includes(c)) &&
            selected.every(s => correct.includes(s));
        if (isCorrect) score += q.marks;
    }
    return score;
}

async function getActiveYear(schoolId) {
    return AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
}

// ── Audience ──────────────────────────────────────────────────────────────────

/** Every section an exam reaches. Rows from before `sections` existed carry only `section`. */
function examSectionIds(exam) {
    const list = (Array.isArray(exam?.sections) ? exam.sections : []).filter(Boolean).map(String);
    if (list.length) return [...new Set(list)];
    return exam?.section ? [String(exam.section?._id || exam.section)] : [];
}

/** An ORM filter matching exams that reach this section, whichever column says so. */
const reachesSection = (sectionId) => ({ $or: [{ section: sectionId }, { sections: sectionId }] });

/** …or any of these sections. */
const reachesAnySection = (ids) => ({ $or: [{ section: { $in: ids } }, { sections: { $in: ids } }] });

// ── Time ──────────────────────────────────────────────────────────────────────

/**
 * The server's own zone. `examWindow()` builds its dates with `new Date('…T10:00:00')`,
 * which JavaScript reads in the process's local zone — the SQL has to read the
 * same wall-clock time in the same zone or a 10:00 exam opens at 15:30.
 */
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const HHMM = /^\d{1,2}:\d{2}$/;

/**
 * When an exam opens and closes. `examDate` is stored as UTC midnight of the
 * calendar day (the form posts YYYY-MM-DD), so the day is read off the ISO
 * string, never off local getters.
 */
function examWindow(exam) {
    const day   = new Date(exam.examDate).toISOString().slice(0, 10);
    const time  = HHMM.test(exam.startTime || '') ? exam.startTime.padStart(5, '0') : '00:00';
    const start = new Date(`${day}T${time}:00`);
    const end   = new Date(start.getTime() + (Number(exam.duration) || 0) * 60 * 1000);
    return { start, end };
}

/**
 * Where an exam is in its life — the one status the admin screen shows.
 *
 *   draft      being written; students cannot see it
 *   scheduled  published, not open yet
 *   live       open right now
 *   completed  closed (by the clock, or because every student submitted)
 *   cancelled  withdrawn
 *
 * The stored `status` alone cannot say "live": nothing flips it when the clock
 * passes the start time. Twin of STAGE_SQL below.
 */
function examStage(exam, now = new Date()) {
    if (exam.status === 'cancelled') return 'cancelled';
    if (exam.status === 'draft')     return 'draft';
    if (exam.status === 'completed') return 'completed';
    const { start, end } = examWindow(exam);
    if (now < start) return 'scheduled';
    if (now < end)   return 'live';
    return 'completed';
}

/** SQL: an exam row's opening instant. Needs the server zone as a parameter. Twin of examWindow(). */
const startSql = (alias, tzParam) => `(
    ((${alias}."examDate" AT TIME ZONE 'UTC')::date
      + (CASE WHEN ${alias}."startTime" ~ '^\\d{1,2}:\\d{2}$' THEN ${alias}."startTime" ELSE '00:00' END)::time
    ) AT TIME ZONE ${tzParam})`;

const endSql = (alias, tzParam) =>
    `(${startSql(alias, tzParam)} + COALESCE(${alias}."duration", 0) * interval '1 minute')`;

/** SQL twin of examStage(). */
const stageSql = (alias, tzParam) => `(CASE
    WHEN ${alias}."status" = 'cancelled' THEN 'cancelled'
    WHEN ${alias}."status" = 'draft'     THEN 'draft'
    WHEN ${alias}."status" = 'completed' THEN 'completed'
    WHEN now() < ${startSql(alias, tzParam)} THEN 'scheduled'
    WHEN now() < ${endSql(alias, tzParam)}   THEN 'live'
    ELSE 'completed' END)`;

/** SQL twin of examSectionIds(): the exam's sections as a jsonb array. */
const sectionsSql = (alias) => `(CASE
    WHEN jsonb_typeof(${alias}."sections") = 'array' AND jsonb_array_length(${alias}."sections") > 0
    THEN ${alias}."sections"
    ELSE jsonb_build_array(${alias}."section") END)`;

/**
 * SQL: one row per finished attempt with its score.
 *
 * Twin of scoreAttempt(): a question earns its marks only when the chosen set
 * and the correct set are the same set. An unanswered question is an empty
 * choice — which, exactly as in the JS, matches a question with no correct
 * answers recorded. Non-array JSON is read as empty rather than raising.
 * `$ids` names the parameter holding the exam ids (uuid[]).
 */
const scoredAttemptsSql = (idsParam, t) => `
    SELECT a."exam", a."_id", a."student",
           COALESCE(SUM(q."marks") FILTER (
               WHERE jsonb_array_length(COALESCE(ans.sel, '[]'::jsonb)) = jsonb_array_length(q.cor)
                 AND COALESCE(ans.sel, '[]'::jsonb) @> q.cor
                 AND q.cor @> COALESCE(ans.sel, '[]'::jsonb)
           ), 0) AS score
      FROM ${t.attempts} a
      LEFT JOIN LATERAL (
          SELECT q0."_id", q0."marks",
                 CASE WHEN jsonb_typeof(q0."correctAnswers") = 'array' THEN q0."correctAnswers" ELSE '[]'::jsonb END AS cor
            FROM ${t.questions} q0
           WHERE q0."exam" = a."exam"
      ) q ON true
      LEFT JOIN LATERAL (
          SELECT CASE WHEN jsonb_typeof(x->'selectedOptions') = 'array' THEN x->'selectedOptions' ELSE '[]'::jsonb END AS sel
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a."answers") = 'array' THEN a."answers" ELSE '[]'::jsonb END) x
           WHERE x->>'question' = q."_id"::text
           LIMIT 1
      ) ans ON true
     WHERE a."status" IN ('submitted', 'auto_submitted')
       AND a."exam" = ANY(${idsParam}::uuid[])
     GROUP BY a."exam", a."_id", a."student"`;

// ── Questions ─────────────────────────────────────────────────────────────────

const QUESTION_TYPES = ['mcq_single', 'mcq_multiple', 'true_false'];
const TF_OPTIONS = [{ optionId: 'true', text: 'True' }, { optionId: 'false', text: 'False' }];

/**
 * The rules one question must meet, whichever door it came in by — the form or
 * a spreadsheet. Returns `{ question }` or `{ error }`.
 */
function checkQuestion({ questionText, questionType, options, correctAnswers, marks }) {
    const text = String(questionText || '').trim();
    if (!text) return { error: 'Question text is required' };
    if (!QUESTION_TYPES.includes(questionType)) return { error: 'Type must be single choice, multiple choice or true/false' };

    const m = Number(marks);
    if (!Number.isFinite(m) || m < 0.5) return { error: 'Marks must be 0.5 or more' };

    let opts = questionType === 'true_false'
        ? TF_OPTIONS
        : (options || []).map(o => ({ optionId: String(o.optionId), text: String(o.text || '').trim() })).filter(o => o.text);
    if (questionType !== 'true_false' && opts.length < 2) return { error: 'Give at least two options' };

    const ids = new Set(opts.map(o => o.optionId));
    const correct = [...new Set((correctAnswers || []).map(String))];
    if (!correct.length) return { error: 'Mark the correct answer' };
    const stray = correct.find(c => !ids.has(c));
    if (stray) return { error: `Correct answer "${stray.toUpperCase()}" is not one of the options` };
    if (questionType !== 'mcq_multiple' && correct.length !== 1) return { error: 'A single-answer question takes exactly one correct answer' };

    return { question: { questionText: text, questionType, options: opts, correctAnswers: correct, marks: m } };
}

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

/** Read one spreadsheet cell by any of the ways a header might be spelled. */
function cell(row, ...names) {
    const keys = Object.keys(row);
    for (const n of names) {
        const hit = keys.find(k => k.trim().toLowerCase().replace(/[\s_]+/g, ' ') === n);
        if (hit !== undefined && String(row[hit]).trim() !== '') return String(row[hit]).trim();
    }
    return '';
}

/**
 * One spreadsheet row → the question it describes, or why it cannot be one.
 *
 * Columns: Question · Type · Option A … Option F · Correct · Marks. Type may be
 * left blank: two or more letters in Correct make it multiple choice, and a
 * True/False answer with no options makes it true/false.
 */
function questionFromRow(row) {
    const text    = cell(row, 'question', 'question text', 'questiontext');
    const rawType = cell(row, 'type', 'question type', 'questiontype').toLowerCase();
    const rawCor  = cell(row, 'correct', 'correct answer', 'correct answers', 'answer', 'answers');
    const rawMark = cell(row, 'marks', 'mark', 'points');

    const options = LETTERS
        .map(l => ({ optionId: l, text: cell(row, `option ${l}`, `option${l}`, l) }))
        .filter(o => o.text);

    const corTokens = rawCor.split(/[,;/|\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const isTF = corTokens.length === 1 && ['true', 'false', 't', 'f'].includes(corTokens[0]) && !options.length;

    let questionType;
    if (/multi/.test(rawType)) questionType = 'mcq_multiple';
    else if (/true|false|tf|bool/.test(rawType)) questionType = 'true_false';
    else if (/single|mcq|choice/.test(rawType)) questionType = 'mcq_single';
    else if (!rawType) questionType = isTF ? 'true_false' : corTokens.length > 1 ? 'mcq_multiple' : 'mcq_single';
    else return { error: `Unknown type "${rawType}"` };

    const correctAnswers = questionType === 'true_false'
        ? corTokens.map(c => (c === 't' ? 'true' : c === 'f' ? 'false' : c))
        : corTokens;

    return checkQuestion({
        questionText: text,
        questionType,
        options,
        correctAnswers,
        marks: rawMark === '' ? 1 : rawMark,
    });
}

// ── Ready to publish? ─────────────────────────────────────────────────────────

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const s_ = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How many questions could not be answered correctly by anyone: no key, or a key that points nowhere. */
function answerKeyProblems(questions) {
    return (questions || []).filter((q) => {
        const ids = new Set((q.questionType === 'true_false' ? ['true', 'false'] : (q.options || []).map(o => String(o.optionId))));
        const key = (q.correctAnswers || []).map(String);
        if (!key.length || key.some(k => !ids.has(k))) return true;
        if (q.questionType !== 'true_false' && (q.options || []).length < 2) return true;
        return q.questionType !== 'mcq_multiple' && key.length !== 1;
    }).length;
}

/**
 * Whether an exam can be published, and — when it cannot — exactly what is
 * missing, in words the person fixing it can act on.
 *
 * An exam is published only when:
 *   questions  it holds exactly the number of questions it was set for
 *   marks      a total is set, and its questions' marks add up to that total —
 *              scores are worked out against the total, so a paper whose
 *              questions carry 32 marks "out of 40" can never score 100%
 *   answers    every question has a usable answer key
 *   schedule   its slot has not already passed
 *   audience   it reaches at least one section
 *
 * Pure: the admin list, the teacher's board, the question editor and the
 * publish endpoint all read the same verdict. The browser's twin is
 * school-frontend/src/pages/exams/readiness.js — keep the two in step.
 */
function publishReadiness({ totalQuestions, totalMarks, questionCount, questionMarks, answerKeyProblems: badKeys = 0, endsAt, sectionCount = 1, now = new Date() }) {
    const want = Number(totalQuestions) || 0;
    const have = Number(questionCount) || 0;
    const total = round2(totalMarks);
    const marks = round2(questionMarks);

    const checks = [];

    const qOk = want >= 1 && have === want;
    checks.push({
        key: 'questions',
        label: 'Questions',
        ok: qOk,
        detail: want < 1 ? 'Set how many questions the exam has'
            : have === want ? `All ${s_(want, 'question')} added`
            : have < want ? `${have} of ${want} added — add ${s_(want - have, 'more question')}`
            : `${have} added but the exam is set for ${want} — remove ${s_(have - want, 'question')} or raise the total`,
    });

    const mOk = total > 0 && marks === total;
    checks.push({
        key: 'marks',
        label: 'Total marks',
        ok: mOk,
        detail: total <= 0 ? 'Set the exam’s total marks'
            : marks === total ? `Questions carry all ${total} marks`
            : have === 0 ? `No marks allocated yet — the questions must add up to ${total}`
            : marks < total ? `${marks} of ${total} marks allocated — ${round2(total - marks)} still to allocate`
            : `Questions carry ${marks} marks but the exam is out of ${total} — ${round2(marks - total)} over`,
    });

    checks.push({
        key: 'answers',
        label: 'Answer keys',
        ok: badKeys === 0,
        detail: badKeys === 0 ? 'Every question has a correct answer'
            : `${s_(badKeys, 'question')} ${badKeys === 1 ? 'has' : 'have'} no usable correct answer`,
    });

    const late = endsAt && new Date(endsAt) <= now;
    checks.push({
        key: 'schedule',
        label: 'Schedule',
        ok: !late,
        detail: late ? 'The exam date and time have already passed — pick a later slot' : 'Scheduled for a future slot',
    });

    checks.push({
        key: 'audience',
        label: 'Sections',
        ok: sectionCount > 0,
        detail: sectionCount > 0 ? `Reaches ${s_(sectionCount, 'section')}` : 'Choose at least one section',
    });

    const missing = checks.filter(c => !c.ok);
    return {
        ready: missing.length === 0,
        checks,
        missing: missing.map(c => c.key),
        message: missing.length ? `Not ready to publish: ${missing.map(c => c.detail).join('; ')}` : 'Ready to publish',
    };
}

module.exports = {
    publishReadiness, answerKeyProblems,
    shuffle, scoreAttempt, getActiveYear,
    examSectionIds, reachesSection, reachesAnySection,
    SERVER_TZ, examWindow, examStage, startSql, endSql, stageSql, sectionsSql, scoredAttemptsSql,
    QUESTION_TYPES, checkQuestion, questionFromRow,
};
