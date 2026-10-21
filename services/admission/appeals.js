'use strict';
/**
 * Asking the school to look again (Oct 2026) — a re-check of a published exam
 * result, or an appeal against a decision that closed the application (not
 * eligible, not selected). The school sets the windows and how fast it
 * answers; an admission administrator decides, in writing.
 *
 *   upheld, re-check   the corrected marks are recorded on the result (with the
 *                      appeal's number as the reason) and published again
 *   upheld, decision   the application is reopened to the status chosen
 *   not upheld         the answer says why; nothing else changes
 *
 * Nothing here decides for the school: an appeal is never upheld or turned
 * down by itself, and an answer that is late is shown as late, not closed.
 */
const pool = require('../../db/pool');
const { withTransaction, lock, buildInsert } = require('../dbTx');
const AdmissionAppeal = require('../../models/AdmissionAppeal');
const AdmissionExam = require('../../models/AdmissionExam');
const settingsSvc = require('./settings');
const workflow = require('./workflow');
const events = require('./events');
const notify = require('./notify');
const fmt = require('./format');
const { refuse, isId, str } = require('./util');
const { textProblem } = require('../../utils/textRules');

const OPEN = ['open', 'in_review'];
const DECISION_STATUSES = ['rejected', 'ineligible'];
const KIND_LABEL = { recheck: 'Re-check of a result', decision: 'Appeal against a decision' };
const DAY = 86400000;

function words(v, label, max) {
    const t = str(v, max);
    const bad = textProblem(t, label, 'text');
    if (bad) refuse(bad, 400);
    return t;
}

async function nextNumber(schoolId, q) {
    const y = new Date().getFullYear();
    const n = await require('./counters').advance(schoolId, `appeal:${y}`, q);
    return `APL${y}${String(n).padStart(4, '0')}`;
}

/** What this application may appeal now, under the school's rules. */
async function options(app, settings = null) {
    const s = settings || await settingsSvc.getSettings(app.school);
    const a = s.appeals;
    const out = { enabled: !!a.enabled, note: a.note, answerDays: a.answerDays, recheck: [], decision: null, left: 0 };
    if (!a.enabled) return out;
    const { rows: mine } = await pool.query(`SELECT "kind", "exam", "status" FROM "admissionappeals" WHERE "application" = $1`, [String(app._id)]);
    out.left = Math.max(0, a.maxPerApplication - mine.filter((x) => x.status !== 'withdrawn').length);
    if (!out.left) return out;
    const now = Date.now();
    if (a.recheckDays > 0) {
        const { rows } = await pool.query(
            `SELECT e."_id", e."name", e."resultsPublishedAt" FROM "admissionresults" r JOIN "admissionexams" e ON e."_id" = r."exam"
              WHERE r."application" = $1 AND r."status" = 'published' AND e."resultsStatus" = 'published' AND e."resultsPublishedAt" <= now()`, [String(app._id)]);
        for (const e of rows) {
            const until = new Date(new Date(e.resultsPublishedAt).getTime() + a.recheckDays * DAY);
            if (until.getTime() < now) continue;
            if (mine.some((x) => x.kind === 'recheck' && String(x.exam) === String(e._id) && x.status !== 'withdrawn')) continue;
            out.recheck.push({ examId: e._id, name: e.name, until });
        }
    }
    if (a.decisionDays > 0 && DECISION_STATUSES.includes(app.status) && app.statusChangedAt) {
        const until = new Date(new Date(app.statusChangedAt).getTime() + a.decisionDays * DAY);
        const already = mine.some((x) => x.kind === 'decision' && x.status !== 'withdrawn');
        if (until.getTime() >= now && !already) out.decision = { status: app.status, label: workflow.STATUSES[app.status]?.label || app.status, until };
    }
    return out;
}

/** The family files an appeal. */
async function file(req, app, input = {}) {
    const kind = ['recheck', 'decision'].includes(input.kind) ? input.kind : null;
    if (!kind) refuse('Choose what you are asking the school to look at again');
    const reason = words(input.reason, 'Your reason', 2000);
    if (reason.length < 10) refuse('Tell the school why, in a sentence or two', 400, { field: 'reason' });
    const settings = await settingsSvc.getSettings(app.school);
    const appeal = await withTransaction(async (q) => {
        await lock(q, `admission-appeal:${app._id}`);
        const { rows: [fresh] } = await q(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [String(app._id)]);
        const opts = await options(fresh, settings);
        if (!opts.enabled) refuse('The school is not taking appeals online', 409);
        let exam = null;
        if (kind === 'recheck') {
            const o = opts.recheck.find((x) => String(x.examId) === String(input.examId || ''));
            if (!o) refuse(opts.left ? 'A re-check of that result cannot be asked for now — the window has closed, or you have already asked' : 'You have made as many appeals as the school allows', 409, { code: 'NOT_OPEN' });
            exam = o.examId;
        } else if (!opts.decision) {
            refuse(opts.left ? 'This decision cannot be appealed now — the window has closed, or you have already appealed' : 'You have made as many appeals as the school allows', 409, { code: 'NOT_OPEN' });
        }
        const { sql, params } = buildInsert(AdmissionAppeal, {
            school: app.school, application: app._id, applicant: app.applicant, number: await nextNumber(app.school, q), kind, exam,
            aboutStatus: fresh.status, reason, status: 'open', dueAt: new Date(Date.now() + settings.appeals.answerDays * DAY),
        });
        return (await q(sql, params)).rows[0];
    });
    const examName = appeal.exam ? (await AdmissionExam.findById(appeal.exam).select('name').lean())?.name : '';
    events.recordQuietly(app.school, {
        application: app._id, by: req, type: 'appeal', action: 'filed', visibility: 'applicant',
        message: `${KIND_LABEL[kind]}${examName ? ` (${examName})` : ''} asked for — ${appeal.number}. The school answers by ${fmt.fmtDate(appeal.dueAt)}.`,
    });
    notify.toApplicant(app, 'appeal_received', { appeal_number: appeal.number, appeal_kind: KIND_LABEL[kind].toLowerCase(), due_date: fmt.fmtDate(appeal.dueAt), exam_name: examName || '' });
    return appeal;
}

async function withdraw(req, app, appealId) {
    if (!isId(String(appealId || ''))) refuse('Appeal not found', 404);
    const { rows: [a] } = await pool.query(
        `UPDATE "admissionappeals" SET "status" = 'withdrawn', "updatedAt" = now() WHERE "_id" = $1 AND "application" = $2 AND "status" = 'open' RETURNING *`, [String(appealId), String(app._id)]);
    if (!a) refuse('Only an appeal the school has not started on can be withdrawn', 409);
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'appeal', action: 'withdrawn', visibility: 'applicant', message: `Appeal ${a.number} withdrawn` });
    return a;
}

/** The family's appeals — never the staff note. */
async function forFamily(app) {
    const { rows } = await pool.query(
        `SELECT a."_id", a."number", a."kind", a."status", a."reason", a."decision", a."dueAt", a."createdAt", a."decidedAt", e."name" AS "examName"
           FROM "admissionappeals" a LEFT JOIN "admissionexams" e ON e."_id" = a."exam" WHERE a."application" = $1 ORDER BY a."createdAt" DESC`, [String(app._id)]);
    return rows;
}

// ── The office ───────────────────────────────────────────────────────────────

async function list(schoolId, { status = '', kind = '' } = {}) {
    const params = [String(schoolId)];
    let where = '';
    if (status === 'waiting') where += ` AND a."status" = ANY('{open,in_review}'::text[])`;
    else if (['open', 'in_review', 'upheld', 'not_upheld', 'withdrawn'].includes(status)) { params.push(status); where += ` AND a."status" = $${params.length}`; }
    if (['recheck', 'decision'].includes(kind)) { params.push(kind); where += ` AND a."kind" = $${params.length}`; }
    const { rows } = await pool.query(
        `SELECT a."_id", a."number", a."kind", a."status", a."dueAt", a."createdAt", a."decidedAt", a."assignedTo", a."aboutStatus",
                p."_id" AS "applicationId", p."applicationNumber", p."studentName", e."name" AS "examName", u."name" AS "assigneeName",
                (a."status" = ANY('{open,in_review}'::text[]) AND a."dueAt" < now()) AS "overdue"
           FROM "admissionappeals" a JOIN "admissionapplications" p ON p."_id" = a."application"
           LEFT JOIN "admissionexams" e ON e."_id" = a."exam" LEFT JOIN "users" u ON u."_id" = a."assignedTo"
          WHERE a."school" = $1${where} ORDER BY (a."status" = ANY('{open,in_review}'::text[])) DESC, a."dueAt" ASC NULLS LAST, a."createdAt" DESC LIMIT 500`, params);
    const { rows: [t] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE "status" = ANY('{open,in_review}'::text[]))::int AS waiting,
                COUNT(*) FILTER (WHERE "status" = ANY('{open,in_review}'::text[]) AND "dueAt" < now())::int AS overdue,
                COUNT(*) FILTER (WHERE "status" = 'upheld')::int AS upheld, COUNT(*) FILTER (WHERE "status" = 'not_upheld')::int AS "notUpheld"
           FROM "admissionappeals" WHERE "school" = $1`, [String(schoolId)]);
    return { rows, totals: t };
}

async function appealOf(schoolId, id, q = null) {
    if (!isId(String(id || ''))) refuse('Appeal not found', 404);
    const run = q || ((s, p) => pool.query(s, p));
    const { rows: [a] } = await run(`SELECT * FROM "admissionappeals" WHERE "_id" = $1 AND "school" = $2${q ? ' FOR UPDATE' : ''}`, [String(id), String(schoolId)]);
    if (!a) refuse('Appeal not found', 404);
    return a;
}

/** Everything the decider needs: the appeal, the application, and for a re-check the marks as they stand. */
async function detail(schoolId, id) {
    const a = await appealOf(schoolId, id);
    const { rows: [app] } = await pool.query(`SELECT "_id", "applicationNumber", "studentName", "status", "statusChangedAt", "class" FROM "admissionapplications" WHERE "_id" = $1`, [a.application]);
    let exam = null; let result = null;
    if (a.exam) {
        exam = await AdmissionExam.findById(a.exam).select('name mode subjects maxMarks passMarks resultsStatus').lean();
        result = (await pool.query(`SELECT "_id", "marks", "total", "percentage", "grade", "passed", "absent", "corrections", "remarks", "published" FROM "admissionresults" WHERE "exam" = $1 AND "application" = $2`, [a.exam, a.application])).rows[0] || null;
    }
    const reopenTo = a.kind === 'decision'
        ? Object.entries(workflow.STATUSES).filter(([k, s]) => !s.closed && !s.system && k !== 'draft').map(([k, s]) => ({ key: k, label: s.label }))
        : [];
    return { appeal: a, application: app, exam, result, reopenTo };
}

async function assign(req, id, userId) {
    const a = await appealOf(req.schoolId, id);
    if (!OPEN.includes(a.status)) refuse('This appeal has been answered', 409);
    let who = null;
    if (userId) {
        if (!isId(String(userId))) refuse('Choose a member of staff');
        const { rows: [u] } = await pool.query(`SELECT "_id" FROM "users" WHERE "_id" = $1 AND "school" = $2 AND "role" = ANY('{school_admin,teacher}'::text[]) AND "isActive"`, [String(userId), String(req.schoolId)]);
        if (!u) refuse('Choose an active member of staff', 400);
        who = u._id;
    }
    const { rows: [r] } = await pool.query(
        `UPDATE "admissionappeals" SET "assignedTo" = $2, "status" = CASE WHEN "status" = 'open' THEN 'in_review' ELSE "status" END, "updatedAt" = now() WHERE "_id" = $1 RETURNING *`, [a._id, who]);
    return r;
}

/**
 * Decide. input: { outcome: 'upheld'|'not_upheld', decision (to the family),
 * internalNote, marks (re-check upheld), reopenTo (decision upheld) }.
 */
async function decide(req, id, input = {}) {
    if (!(await require('./access').isAdmin(req))) refuse('An appeal is decided by an admission administrator', 403);
    const outcome = ['upheld', 'not_upheld'].includes(input.outcome) ? input.outcome : null;
    if (!outcome) refuse('Choose whether the appeal is upheld');
    const decision = words(input.decision, 'The answer to the family', 2000);
    if (decision.length < 10) refuse('Write the answer the family will read', 400, { field: 'decision' });
    const internalNote = words(input.internalNote, 'The staff note', 2000);
    const a = await appealOf(req.schoolId, id);
    if (!OPEN.includes(a.status)) refuse('This appeal has been answered', 409);
    const { rows: [app] } = await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [a.application]);
    const result = { outcome: {} };
    if (outcome === 'upheld' && a.kind === 'recheck') {
        const exam = await AdmissionExam.findById(a.exam).lean();
        const { rows: [res] } = await pool.query(`SELECT * FROM "admissionresults" WHERE "exam" = $1 AND "application" = $2`, [a.exam, a.application]);
        if (!exam || !res) refuse('The result is no longer there', 409);
        if (!input.marks || typeof input.marks !== 'object') refuse('Enter the corrected marks — an upheld re-check changes them', 400, { field: 'marks' });
        const exams = require('./exams');
        const row = await exams.correctResult(req, exam, res, { marks: input.marks, reason: `Re-check ${a.number}: ${decision.slice(0, 200)}` });
        if (exam.resultsStatus === 'published') await exams.publishResultsNow(req, exam);
        result.outcome = { before: { marks: res.marks, total: res.total, grade: res.grade, passed: res.passed }, after: { marks: row.marks, total: row.total, grade: row.grade, passed: row.passed } };
    } else if (outcome === 'upheld' && a.kind === 'decision') {
        const to = String(input.reopenTo || '');
        const target = workflow.STATUSES[to];
        if (!target || target.closed || target.system || to === 'draft') refuse('Choose the stage the application goes back to', 400, { field: 'reopenTo' });
        if (!DECISION_STATUSES.includes(app.status)) refuse('The application is no longer closed — it has moved on since the appeal', 409);
        await require('./applications').move(req, app, to, { reopen: true, remarks: decision, note: `Appeal ${a.number} upheld${internalNote ? ` — ${internalNote}` : ''}`, quiet: true });
        result.outcome = { reopenedTo: to, from: app.status };
    }
    const { rows: [row] } = await pool.query(
        `UPDATE "admissionappeals" SET "status" = $2, "decision" = $3, "internalNote" = $4, "outcome" = $5::jsonb, "decidedBy" = $6, "decidedAt" = now(), "updatedAt" = now()
          WHERE "_id" = $1 AND "status" = ANY('{open,in_review}'::text[]) RETURNING *`,
        [a._id, outcome, decision, internalNote, JSON.stringify(result.outcome), req.userId]);
    if (!row) refuse('This appeal was answered meanwhile', 409);
    events.recordQuietly(app.school, {
        application: app._id, by: req, type: 'appeal', action: outcome, visibility: 'applicant',
        message: `Appeal ${a.number} ${outcome === 'upheld' ? 'upheld' : 'not upheld'}: ${decision}`,
    });
    if (internalNote) events.recordQuietly(app.school, { application: app._id, by: req, type: 'note', action: 'appeal_note', message: `Appeal ${a.number} — staff note: ${internalNote}` });
    notify.toApplicant(app, 'appeal_decided', { appeal_number: a.number, appeal_outcome: outcome === 'upheld' ? 'upheld' : 'not upheld', appeal_decision: decision });
    return row;
}

module.exports = { options, file, withdraw, forFamily, list, detail, assign, decide, KIND_LABEL };
