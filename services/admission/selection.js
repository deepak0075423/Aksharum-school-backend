'use strict';
/**
 * Selection: merit lists, offers, seats and confirmation.
 *
 * A list is built from criteria the school wrote down — weights over APPROVED
 * exam results, the tie-breakers it chose — never from anything hidden. Who it
 * selects is a proposal: the office can change any line (with a reason that
 * stays on the line), and nothing reaches a family until the list is approved
 * and published. An applicant is never rejected by a list; a line that is not
 * selected or waitlisted simply stays where it was for the next list.
 *
 * Every seat-taking step runs under the seat lock of its class (seats.js), so
 * publishing a list, a manual offer and a waiting-list promotion can never
 * hand out the same seat twice.
 */
const pool = require('../../db/pool');
const { patch } = require('../../db/patch');
const { buildInsert, withTransaction: inTx, lock: txLock } = require('../dbTx');
const AdmissionApplication = require('../../models/AdmissionApplication');
const AdmissionList = require('../../models/AdmissionList');
const AdmissionListEntry = require('../../models/AdmissionListEntry');
const AdmissionOffer = require('../../models/AdmissionOffer');
const AdmissionRound = require('../../models/AdmissionRound');
const AdmissionExam = require('../../models/AdmissionExam');
const School = require('../../models/School');
const Class = require('../../models/Class');
const AcademicYear = require('../../models/AcademicYear');
const workflow = require('./workflow');
const seats = require('./seats');
const settingsSvc = require('./settings');
const counters = require('./counters');
const events = require('./events');
const notify = require('./notify');
const fmt = require('./format');
const compliance = require('./compliance');
const quotasSvc = require('./quotas');
const lottery = require('./lottery');
const formEngine = require('./formEngine');
const { nameProblem, textProblem } = require('../../utils/textRules');
const { refuse, isId, str, num, date } = require('./util');

const TA = `"${AdmissionApplication.tableName}"`;
const TE = `"${AdmissionListEntry.tableName}"`;
const TO = `"${AdmissionOffer.tableName}"`;
const DEFAULT_POOL = ['verified', 'eligible', 'exam_completed', 'interview_completed', 'evaluated', 'waitlisted', 'selected', 'offer_expired'];

// ── Criteria ─────────────────────────────────────────────────────────────────

const METHODS = ['merit', 'lottery', 'points_lottery'];
const isLottery = (list) => list && (list.method === 'lottery' || list.method === 'points_lottery');

/**
 * Priority points for a points lottery: each rule reads one answer of the
 * application form ("lives within 1 km", "a sibling studies here") and adds
 * its points. Applicants are drawn most points first; equal points by lot.
 */
async function normalizePoints(schoolId, roundId, classId, rules) {
    const list = (Array.isArray(rules) ? rules : []).slice(0, 10);
    if (!list.length) refuse('A points lottery needs at least one rule — or make a plain lottery', 400, { field: 'criteria.points' });
    const round = await AdmissionRound.findOne({ _id: roundId, school: schoolId }).lean();
    const found = round ? await require('./applications').formFor(round, classId) : null;
    const fields = new Map(formEngine.allFields(found?.version?.schema || { sections: [] }).map((f) => [f.key, f]));
    return list.map((r, i) => {
        const field = str(r?.field, 40);
        const target = fields.get(field);
        if (!target || ['info', 'file'].includes(target.type)) refuse(`Rule ${i + 1}: choose a question of the class's application form`, 400, { field: 'criteria.points' });
        const op = formEngine.OPS.includes(r?.op) ? r.op : null;
        if (!op) refuse(`Rule ${i + 1}: choose how the answer is compared`, 400, { field: 'criteria.points' });
        let value = r?.value;
        if (['in', 'not_in'].includes(op)) value = (Array.isArray(value) ? value : String(value ?? '').split(',')).map((x) => str(x, 60)).filter(Boolean).slice(0, 30);
        else if (['checked', 'not_checked', 'filled', 'empty'].includes(op)) value = null;
        else if (['gt', 'lt', 'gte', 'lte'].includes(op)) value = target.type === 'date' ? str(value, 10) : Number(value);
        else value = str(value, 60);
        const label = str(r?.label, 80) || target.label || field;
        const bad = textProblem(label, `Rule ${i + 1} name`);
        if (bad) refuse(bad, 400, { field: 'criteria.points' });
        return { label, field, op, value, points: num(r?.points, { min: 1, max: 100, d: 1, int: true }) };
    });
}

function pointsFor(rules, data) {
    let total = 0;
    const why = {};
    for (const r of rules || []) {
        if (formEngine.conditionHolds({ mode: 'all', rules: [{ field: r.field, op: r.op, value: r.value }] }, data || {})) {
            total += r.points;
            why[r.label] = r.points;
        }
    }
    return { total, why };
}

async function normalizeCriteria(schoolId, roundId, input = {}, { method = 'merit', classId = null } = {}) {
    if (method !== 'merit') {
        const statuses = (Array.isArray(input.filters?.statuses) ? input.filters.statuses : DEFAULT_POOL).filter((s) => workflow.STATUSES[s] && !workflow.STATUSES[s].closed);
        return {
            weights: [], tieBreakers: [],
            points: method === 'points_lottery' ? await normalizePoints(schoolId, roundId, classId, input.points) : [],
            filters: { statuses: statuses.length ? statuses : DEFAULT_POOL, requirePass: false, minScore: null, requireDocsVerified: !!input.filters?.requireDocsVerified },
        };
    }
    const exams = await AdmissionExam.find({ school: schoolId, round: roundId }).select('_id name maxMarks').lean();
    const examIds = new Set(exams.map((e) => String(e._id)));
    const weights = (Array.isArray(input.weights) ? input.weights : []).slice(0, 10).map((w) => {
        const [kind, id, measure] = String(w?.source || '').split(':');
        if (kind !== 'exam' || !examIds.has(id)) refuse('Each weight must point at an exam of this round', 400, { field: 'criteria' });
        return { source: `exam:${id}${measure === 'raw' ? ':raw' : ''}`, weight: num(w.weight, { min: 0, max: 100, d: 1 }), label: exams.find((e) => String(e._id) === id)?.name || 'Exam' };
    });
    const statuses = (Array.isArray(input.filters?.statuses) ? input.filters.statuses : DEFAULT_POOL).filter((s) => workflow.STATUSES[s] && !workflow.STATUSES[s].closed);
    const ties = (Array.isArray(input.tieBreakers) ? input.tieBreakers : []).filter((t) => settingsSvc.TIE_BREAKERS.includes(t) || /^exam:[0-9a-f-]{36}$/i.test(t));
    return {
        weights,
        tieBreakers: ties,
        filters: {
            statuses: statuses.length ? statuses : DEFAULT_POOL,
            requirePass: !!input.filters?.requirePass,
            minScore: input.filters?.minScore === '' || input.filters?.minScore == null ? null : num(input.filters.minScore, { min: 0, max: 100000, d: null }),
            requireDocsVerified: !!input.filters?.requireDocsVerified,
        },
    };
}

// ── Building a list ──────────────────────────────────────────────────────────

/**
 * The ranked pool for a list: every application in its round and class that
 * the filters admit and that holds no seat already, scored by the weights
 * over approved results.
 */
async function rankPool(list, settings) {
    const c = list.criteria || {};
    const statuses = c.filters?.statuses?.length ? c.filters.statuses : DEFAULT_POOL;
    // A quota's list ranks only the applications whose claim to it holds.
    const { rows: apps } = await pool.query(
        `SELECT a."_id", a."applicationNumber", a."studentName", a."studentDob", a."submittedAt", a."status", a."docStatus"
           FROM ${TA} a
          WHERE a."school" = $1 AND a."round" = $2 AND a."class" = $3 AND a."status" = ANY($4::text[])
            AND NOT EXISTS (SELECT 1 FROM ${TO} o WHERE o."application" = a."_id" AND o."status" = ANY($5::text[]))
            ${list.quota ? `AND a."quota" = $6 AND a."quotaStatus" IN ('verified', 'allotted')` : ''}`,
        [String(list.school), String(list.round), String(list.class), statuses, seats.HOLDING_OFFER, ...(list.quota ? [list.quota] : [])]);
    if (!apps.length) return [];
    const ids = apps.map((a) => String(a._id));
    const examIds = [...new Set((c.weights || []).map((w) => w.source.split(':')[1]))];
    const tieExamIds = (c.tieBreakers || []).filter((t) => t.startsWith('exam:')).map((t) => t.split(':')[1]);
    const allExamIds = [...new Set([...examIds, ...tieExamIds])];
    const results = new Map();
    if (allExamIds.length) {
        const { rows } = await pool.query(
            `SELECT "application", "exam", "total", "percentage", "passed", "absent", "status" FROM "admissionresults"
              WHERE "application" = ANY($1::uuid[]) AND "exam" = ANY($2::uuid[]) AND "status" IN ('approved', 'published')`,
            [ids, allExamIds]);
        for (const r of rows) results.set(`${r.application}|${r.exam}`, r);
    }
    const ranked = [];
    for (const a of apps) {
        const breakdown = {};
        let score = null;
        let pass = true;
        let missing = false;
        if (c.weights?.length) {
            let sum = 0; let wsum = 0;
            for (const w of c.weights) {
                const [, examId, measure] = w.source.split(':');
                const r = results.get(`${a._id}|${examId}`);
                if (!r || r.absent) { missing = true; breakdown[w.label] = r?.absent ? 'Absent' : 'No approved result'; pass = false; continue; }
                const v = measure === 'raw' ? Number(r.total) || 0 : Number(r.percentage) || 0;
                breakdown[w.label] = Math.round(v * 100) / 100;
                if (r.passed === false) pass = false;
                sum += v * w.weight; wsum += w.weight;
            }
            score = wsum > 0 ? Math.round((sum / wsum) * 100) / 100 : null;
        }
        if (c.filters?.requirePass && (!pass || missing)) continue;
        if (c.filters?.minScore != null && (score == null || score < c.filters.minScore)) continue;
        if (c.filters?.requireDocsVerified && a.docStatus !== 'verified' && a.docStatus !== 'none') continue;
        ranked.push({ app: a, score, breakdown, examPct: (id) => Number(results.get(`${a._id}|${id}`)?.percentage) || -1 });
    }
    const ties = c.tieBreakers?.length ? c.tieBreakers : settings.selection.tieBreakers;
    const time = (d) => (d ? new Date(d).getTime() : Infinity);
    ranked.sort((x, y) => {
        const s = (y.score ?? -Infinity) - (x.score ?? -Infinity);
        if (s) return s;
        for (const t of ties) {
            let d = 0;
            if (t === 'score_desc') d = 0;
            else if (t === 'dob_asc') d = time(x.app.studentDob) - time(y.app.studentDob);
            else if (t === 'dob_desc') d = time(y.app.studentDob) - time(x.app.studentDob);
            else if (t === 'submitted_asc') d = time(x.app.submittedAt) - time(y.app.submittedAt);
            else if (t === 'name_asc') d = String(x.app.studentName).localeCompare(String(y.app.studentName));
            else if (t.startsWith('exam:')) { const id = t.split(':')[1]; d = y.examPct(id) - x.examPct(id); }
            if (d) return d;
        }
        return String(x.app.applicationNumber).localeCompare(String(y.app.applicationNumber));
    });
    return ranked;
}

/**
 * A lottery's pool, before its draw: every application the filters admit,
 * with its priority points. No order yet — the draw makes it. A line the
 * office excluded (with a reason) stays excluded.
 */
async function buildLotteryPool(list, q = null) {
    // One draw at a time per list, and never over a draw already made: the
    // pool is rebuilt, checked and drawn under this lock in one transaction.
    if (!q) return inTx((tq) => buildLotteryPool(list, tq));
    await txLock(q, `admission-draw:${list._id}`);
    const { rows: [cur] } = await q(`SELECT "status", "draw" FROM "admissionlists" WHERE "_id" = $1 FOR UPDATE`, [String(list._id)]);
    if (!cur || cur.status !== 'draft') refuse('Only a draft list can be rebuilt', 409);
    if (cur.draw) refuse('This list has already been drawn — the draw is final', 409, { code: 'ALREADY_DRAWN' });
    const c = list.criteria || {};
    const statuses = c.filters?.statuses?.length ? c.filters.statuses : DEFAULT_POOL;
    const { rows: apps } = await q(
        `SELECT a."_id", a."applicationNumber", a."data", a."docStatus" FROM ${TA} a
          WHERE a."school" = $1 AND a."round" = $2 AND a."class" = $3 AND a."status" = ANY($4::text[]) AND a."applicationNumber" <> ''
            AND NOT EXISTS (SELECT 1 FROM ${TO} o WHERE o."application" = a."_id" AND o."status" = ANY($5::text[]))
            ${list.quota ? `AND a."quota" = $6 AND a."quotaStatus" IN ('verified', 'allotted')` : ''}
          ORDER BY a."applicationNumber"`,
        [String(list.school), String(list.round), String(list.class), statuses, seats.HOLDING_OFFER, ...(list.quota ? [list.quota] : [])]);
    const eligible = apps.filter((a) => !c.filters?.requireDocsVerified || a.docStatus === 'verified' || a.docStatus === 'none');
    const { rows: manualRows } = await q(`SELECT "application", "reason", "changedBy" FROM ${TE} WHERE "list" = $1 AND "manual" AND "decision" = 'excluded'`, [String(list._id)]);
    const excluded = new Map(manualRows.map((m) => [String(m.application), m]));
    await q(`DELETE FROM ${TE} WHERE "list" = $1`, [String(list._id)]);
    let inPool = 0;
    for (const a of eligible) {
        const pts = list.method === 'points_lottery' ? pointsFor(c.points, a.data) : { total: 0, why: {} };
        const m = excluded.get(String(a._id));
        if (!m) inPool += 1;
        const { sql, params } = buildInsert(AdmissionListEntry, {
            school: list.school, list: list._id, application: a._id, rank: null, score: pts.total, breakdown: { points: pts.why },
            decision: m ? 'excluded' : 'not_selected', waitPosition: null, manual: !!m, reason: m?.reason || '', changedBy: m?.changedBy || null,
        });
        await q(sql, params);
    }
    await q(`UPDATE "admissionlists" SET "generatedAt" = now(), "updatedAt" = now() WHERE "_id" = $1`, [String(list._id)]);
    return { lines: eligible.length, selected: 0, waitlisted: 0, pool: inPool, drawn: false };
}

/** (Re)build a draft list's lines. A decision the office changed by hand is kept. */
async function build(list) {
    if (!['draft'].includes(list.status)) refuse('Only a draft list can be rebuilt', 409);
    if (isLottery(list)) {
        if (list.draw) refuse('This list has been drawn — the draw is final. Cancel the list and make a new one to draw again.', 409, { code: 'ALREADY_DRAWN' });
        return buildLotteryPool(list);
    }
    const settings = await settingsSvc.getSettings(list.school);
    const ranked = await rankPool(list, settings);
    const { rows: manualRows } = await pool.query(`SELECT "application", "decision", "reason", "changedBy" FROM ${TE} WHERE "list" = $1 AND "manual"`, [String(list._id)]);
    const manual = new Map(manualRows.map((m) => [String(m.application), m]));
    const st = await seats.state(list.round, list.class, null, { quota: list.quota || '' });
    const target = list.seats > 0 ? list.seats : (st.available ?? ranked.length);
    let selected = 0; let waiting = 0;
    const lines = ranked.map((r, i) => {
        const m = manual.get(String(r.app._id));
        let decision;
        if (m) decision = m.decision;
        else if (selected < target) decision = 'selected';
        else if (waiting < (list.waitlistSize || 0)) decision = 'waitlisted';
        else decision = 'not_selected';
        if (decision === 'selected') selected += 1;
        if (decision === 'waitlisted') waiting += 1;
        return { r, rank: i + 1, decision, manual: !!m, reason: m?.reason || '', changedBy: m?.changedBy || null };
    });
    let pos = 0;
    for (const l of lines) l.waitPosition = l.decision === 'waitlisted' ? ++pos : null;
    const { withTransaction } = require('../dbTx');
    await withTransaction(async (q) => {
        await q(`DELETE FROM ${TE} WHERE "list" = $1`, [String(list._id)]);
        for (const l of lines) {
            const { sql, params } = buildInsert(AdmissionListEntry, {
                school: list.school, list: list._id, application: l.r.app._id, rank: l.rank, score: l.r.score, breakdown: l.r.breakdown,
                decision: l.decision, waitPosition: l.waitPosition, manual: l.manual, reason: l.reason, changedBy: l.changedBy,
            });
            await q(sql, params);
        }
        await q(`UPDATE "admissionlists" SET "generatedAt" = now(), "updatedAt" = now() WHERE "_id" = $1`, [String(list._id)]);
    });
    return { lines: lines.length, selected, waitlisted: waiting, seatsAvailable: st.available };
}

async function createList(req, input) {
    const roundId = String(input.round || '');
    const classId = String(input.class || '');
    if (!isId(roundId) || !isId(classId)) refuse('Choose the round and class');
    const round = await AdmissionRound.findOne({ _id: roundId, school: req.schoolId }).lean();
    if (!round) refuse('Round not found', 404);
    if (!(round.classes || []).some((c) => String(c.class) === classId)) refuse('That class is not part of the round');
    const { rows: [last] } = await pool.query(`SELECT COALESCE(MAX("listNo"), 0) AS n FROM "admissionlists" WHERE "round" = $1 AND "class" = $2`, [roundId, classId]);
    const listNo = Number(last.n) + 1;
    const ordinal = ['First', 'Second', 'Third', 'Fourth', 'Fifth'][listNo - 1] || `List ${listNo}`;
    const settings = await settingsSvc.getSettings(req.schoolId);
    const method = METHODS.includes(input.method) ? input.method : 'merit';
    await compliance.assertListMethod(settings, classId, method);
    const quotaKey = str(input.quota, 40);
    if (quotaKey && !quotasSvc.quotaDef((await quotasSvc.classOf(roundId, classId)).quotas, quotaKey)) refuse('That quota is not one of the class\'s', 400, { field: 'quota' });
    const nonce = method === 'merit' ? '' : lottery.newNonce();
    const list = await AdmissionList.create({
        school: req.schoolId, round: roundId, class: classId, listNo,
        name: str(input.name, 80) || `${ordinal} ${method === 'merit' ? 'List' : 'Lottery'}`,
        kind: ['merit', 'waiting', 'final'].includes(input.kind) ? input.kind : 'merit',
        method, quota: quotaKey, lotteryNonce: nonce, lotteryCommitment: nonce ? lottery.commitmentOf(nonce) : '',
        criteria: await normalizeCriteria(req.schoolId, roundId, input.criteria || {}, { method, classId }),
        seats: num(input.seats, { min: 0, max: 5000, d: 0, int: true }),
        waitlistSize: num(input.waitlistSize, { min: 0, max: 5000, d: 0, int: true }),
        acceptanceDeadline: date(input.acceptanceDeadline),
        paymentDeadline: date(input.paymentDeadline),
        visibility: { ...settings.selection.visibility, ...(input.visibility || {}) },
        notes: str(input.notes, 1000),
        createdBy: req.userId,
    });
    const built = await build(list.toObject ? list.toObject() : list);
    events.recordQuietly(req.schoolId, { by: req, type: 'list', action: 'created', message: method === 'merit'
        ? `${list.name} drafted — ${built.selected} selected, ${built.waitlisted} waitlisted`
        : `${list.name} drafted — ${built.pool} in the draw`, meta: { list: String(list._id) } });
    return { list: publicList(list.toObject ? list.toObject() : list), built };
}

async function updateList(req, list, input) {
    if (list.status !== 'draft') refuse('A list can be changed only while it is a draft', 409);
    if (list.draw && (input.criteria !== undefined || input.seats !== undefined || input.waitlistSize !== undefined)) {
        refuse('The draw has been made — its pool, seats and waiting places are final. Cancel the list and make a new one to change them.', 409, { code: 'ALREADY_DRAWN' });
    }
    const set = {};
    if (input.name !== undefined) set.name = str(input.name, 80) || list.name;
    if (input.criteria !== undefined) set.criteria = await normalizeCriteria(list.school, list.round, input.criteria, { method: list.method || 'merit', classId: list.class });
    if (input.seats !== undefined) set.seats = num(input.seats, { min: 0, max: 5000, d: 0, int: true });
    if (input.waitlistSize !== undefined) set.waitlistSize = num(input.waitlistSize, { min: 0, max: 5000, d: 0, int: true });
    if (input.acceptanceDeadline !== undefined) set.acceptanceDeadline = date(input.acceptanceDeadline);
    if (input.paymentDeadline !== undefined) set.paymentDeadline = date(input.paymentDeadline);
    if (input.visibility !== undefined) set.visibility = { showRank: !!input.visibility.showRank, showScore: !!input.visibility.showScore, showNames: !!input.visibility.showNames };
    if (input.notes !== undefined) set.notes = str(input.notes, 1000);
    const row = await patch(AdmissionList, list._id, set, { where: { status: 'draft' } });
    if (!row) refuse('The list changed — refresh', 409);
    const built = (input.criteria !== undefined || input.seats !== undefined || input.waitlistSize !== undefined) ? await build(row) : null;
    return { list: publicList(row), built };
}

/** Change one line's decision by hand — a reason is required and kept. */
async function setDecision(req, list, entryId, { decision, reason }) {
    if (list.status !== 'draft') refuse('Lines can be changed only while the list is a draft', 409);
    if (isLottery(list)) return setLotteryLine(req, list, entryId, { decision, reason });
    if (!['selected', 'waitlisted', 'not_selected', 'excluded'].includes(decision)) refuse('Choose selected, waitlisted, not selected or excluded');
    const why = str(reason, 300);
    if (!why) refuse('Give the reason for changing this line — it is kept with the list', 400, { field: 'reason' });
    const entry = await AdmissionListEntry.findOne({ _id: entryId, list: list._id }).lean();
    if (!entry) refuse('Line not found', 404);
    await patch(AdmissionListEntry, entry._id, { decision, manual: true, reason: why, changedBy: req.userId });
    // Waiting positions follow rank among the waitlisted.
    const { rows } = await pool.query(`SELECT "_id" FROM ${TE} WHERE "list" = $1 AND "decision" = 'waitlisted' ORDER BY "rank"`, [String(list._id)]);
    for (let i = 0; i < rows.length; i++) await pool.query(`UPDATE ${TE} SET "waitPosition" = $2 WHERE "_id" = $1`, [rows[i]._id, i + 1]);
    await pool.query(`UPDATE ${TE} SET "waitPosition" = NULL WHERE "list" = $1 AND "decision" <> 'waitlisted'`, [String(list._id)]);
    events.recordQuietly(list.school, { application: entry.application, by: req, type: 'list', action: 'line_changed', message: `${list.name}: set to ${decision.replace('_', ' ')} — ${why}` });
    return { ok: true };
}

/**
 * A lottery's lines are not chosen by hand. The office may only take a line
 * out (it should not have been in the draw — say why) or put it back; the
 * draw order stands, and seats go down it skipping the lines taken out.
 */
async function setLotteryLine(req, list, entryId, { decision, reason }) {
    if (!['excluded', 'restore'].includes(decision)) refuse('In a lottery a line can only be taken out of the draw (with a reason) or put back', 400, { code: 'LOTTERY_ORDER' });
    const why = str(reason, 300);
    if (!why) refuse('Give the reason — it is kept with the list', 400, { field: 'reason' });
    const entry = await AdmissionListEntry.findOne({ _id: entryId, list: list._id }).lean();
    if (!entry) refuse('Line not found', 404);
    await patch(AdmissionListEntry, entry._id, decision === 'excluded'
        ? { decision: 'excluded', manual: true, reason: why, changedBy: req.userId }
        : { decision: 'not_selected', manual: false, reason: why, changedBy: req.userId });
    if (list.draw) await applyDrawOrder(list);
    events.recordQuietly(list.school, { application: entry.application, by: req, type: 'list', action: 'line_changed', message: `${list.name}: ${decision === 'excluded' ? 'taken out of the draw' : 'put back into the draw'} — ${why}` });
    return { ok: true };
}

/** Seats and waiting places down the draw order, skipping lines taken out. */
async function applyDrawOrder(list, q = null) {
    const run = q || ((s, p) => pool.query(s, p));
    const target = list.draw?.target ?? 0;
    const { rows } = await run(`SELECT "_id", "decision" FROM ${TE} WHERE "list" = $1 AND "rank" IS NOT NULL ORDER BY "rank"`, [String(list._id)]);
    let selected = 0; let waiting = 0;
    for (const r of rows) {
        if (r.decision === 'excluded') { await run(`UPDATE ${TE} SET "waitPosition" = NULL, "updatedAt" = now() WHERE "_id" = $1`, [r._id]); continue; }
        let d = 'not_selected'; let pos = null;
        if (selected < target) { d = 'selected'; selected += 1; } else if (waiting < (list.waitlistSize || 0)) { d = 'waitlisted'; waiting += 1; pos = waiting; }
        await run(`UPDATE ${TE} SET "decision" = $2, "waitPosition" = $3, "updatedAt" = now() WHERE "_id" = $1`, [r._id, d, pos]);
    }
    return { selected, waitlisted: waiting };
}

/**
 * Make the draw — once. The pool is taken fresh at this moment, fixed by its
 * fingerprint, and ordered by the seed (lottery.js). Two clicks at once: the
 * second finds the draw already recorded and is refused.
 */
async function drawLottery(req, list, { phrase, witnesses } = {}) {
    if (!isLottery(list)) refuse('This list is ranked by merit, not drawn', 409);
    if (list.status !== 'draft') refuse('Only a draft list can be drawn', 409);
    if (list.draw) refuse('This list has already been drawn — the draw is final', 409, { code: 'ALREADY_DRAWN' });
    const p = lottery.normalPhrase(phrase);
    if (p.length < 4) refuse('Enter the draw phrase given out at the draw — at least 4 characters', 400, { field: 'phrase' });
    if (p.length > 120) refuse('The draw phrase can be at most 120 characters', 400, { field: 'phrase' });
    const bad = textProblem(p, 'The draw phrase');
    if (bad) refuse(bad, 400, { field: 'phrase' });
    const names = (Array.isArray(witnesses) ? witnesses : String(witnesses || '').split(',')).map((w) => str(w, 80)).filter(Boolean).slice(0, 10);
    for (const w of names) { const wb = nameProblem(w, 'A witness\'s name'); if (wb) refuse(wb, 400, { field: 'witnesses' }); }
    let made; let record; let inDrawCount = 0;
    const out = await inTx(async (q) => {
        // The pool as it stands now, fixed under the list's draw lock.
        await buildLotteryPool(list, q);
        const { rows: lines } = await q(
            `SELECT e."_id", e."decision", e."score", a."applicationNumber" FROM ${TE} e JOIN ${TA} a ON a."_id" = e."application" WHERE e."list" = $1`, [String(list._id)]);
        const inDraw = lines.filter((l) => l.decision !== 'excluded');
        if (!inDraw.length) refuse('Nobody is in the draw — check the list\'s filters', 409);
        inDrawCount = inDraw.length;
        made = lottery.draw({ listId: String(list._id), nonce: list.lotteryNonce, phrase: p, lines: inDraw.map((l) => ({ applicationNumber: l.applicationNumber, points: Number(l.score) || 0, id: l._id })) });
        const st = await seats.state(list.round, list.class, q, { quota: list.quota || '' });
        const target = list.seats > 0 ? list.seats : (st.available ?? inDraw.length);
        record = {
            algorithm: made.algorithm, at: new Date(), by: String(req.userId), byName: req.user?.name || '', phrase: p, witnesses: names,
            nonce: list.lotteryNonce, commitment: list.lotteryCommitment, input: made.ordered.map((l) => [l.applicationNumber, l.points]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
            inputHash: made.inputHash, seed: made.seed, poolSize: inDraw.length, target, method: list.method,
        };
        const { rows: [claimed] } = await q(`UPDATE "admissionlists" SET "draw" = $2::jsonb, "updatedAt" = now() WHERE "_id" = $1 AND "draw" IS NULL AND "status" = 'draft' RETURNING "_id"`, [String(list._id), JSON.stringify(record)]);
        if (!claimed) refuse('This list has already been drawn — the draw is final', 409, { code: 'ALREADY_DRAWN' });
        for (const l of made.ordered) {
            await q(`UPDATE ${TE} SET "rank" = $2, "breakdown" = jsonb_set(COALESCE("breakdown", '{}'::jsonb), '{drawKey}', to_jsonb($3::text)), "updatedAt" = now() WHERE "_id" = $1`, [l.id, l.drawNo, l.key]);
        }
        const placed = await applyDrawOrder({ ...list, draw: record }, q);
        await q(`UPDATE "admissionlists" SET "draw" = "draw" || $2::jsonb WHERE "_id" = $1`, [String(list._id), JSON.stringify(placed)]);
        return placed;
    });
    events.recordQuietly(list.school, { by: req, type: 'list', action: 'drawn', message: `${list.name} drawn — ${inDrawCount} in the draw, ${out.selected} selected, ${out.waitlisted} waitlisted; phrase "${p}"${names.length ? `; witnessed by ${names.join(', ')}` : ''}`, meta: { list: String(list._id), seed: made.seed } });
    return { drawn: true, poolSize: inDrawCount, ...out };
}

/** Recompute a draw from its record and compare it with the list. */
async function verifyDraw(list) {
    if (!list.draw) refuse('This list has not been drawn yet', 409);
    const { rows } = await pool.query(`SELECT e."rank", a."applicationNumber" FROM ${TE} e JOIN ${TA} a ON a."_id" = e."application" WHERE e."list" = $1 AND e."rank" IS NOT NULL`, [String(list._id)]);
    const ranks = new Map(rows.map((r) => [String(r.applicationNumber), r.rank]));
    return lottery.verify(String(list._id), list.draw, ranks);
}

/**
 * Cancel a list that will not be published — a drawn lottery cannot just be
 * deleted (that would let a draw be made again unseen), so it stays on record
 * with the reason, beside the next one.
 */
async function cancelList(req, list, reason) {
    if (!['draft', 'pending_approval', 'approved'].includes(list.status)) refuse('Only a list not yet published can be cancelled — close a published one', 409);
    const why = str(reason, 300);
    if (!why) refuse('Say why the list is cancelled — it is kept on record', 400, { field: 'reason' });
    const row = await patch(AdmissionList, list._id, { status: 'cancelled', cancelReason: why, publishAt: null }, { where: { status: list.status } });
    if (!row) refuse('The list changed — refresh', 409);
    events.recordQuietly(list.school, { by: req, type: 'list', action: 'cancelled', message: `${list.name} cancelled — ${why}${list.draw ? ' (its draw stays on record)' : ''}` });
    return publicList(row);
}

/** A list as it leaves the server: a lottery's secret never does before its draw. */
function publicList(list) {
    if (!list) return list;
    const { lotteryNonce, ...rest } = list;
    return rest;
}

async function submitForApproval(req, list) {
    if (list.status !== 'draft') refuse('Only a draft list can be sent for approval', 409);
    if (isLottery(list) && !list.draw) refuse('Make the draw before sending the list for approval', 409, { code: 'NOT_DRAWN' });
    const { rows: [n] } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${TE} WHERE "list" = $1`, [String(list._id)]);
    if (!n.n) refuse('The list has nobody on it — check its filters', 409);
    const row = await patch(AdmissionList, list._id, { status: 'pending_approval', submittedBy: req.userId }, { where: { status: 'draft' } });
    events.recordQuietly(list.school, { by: req, type: 'list', action: 'submitted', message: `${list.name} sent for approval` });
    return publicList(row);
}

async function approve(req, list) {
    if (list.status !== 'pending_approval') refuse('The list is not waiting for approval', 409);
    const row = await patch(AdmissionList, list._id, { status: 'approved', approvedBy: req.userId, approvedAt: new Date() }, { where: { status: 'pending_approval' } });
    events.recordQuietly(list.school, { by: req, type: 'list', action: 'approved', message: `${list.name} approved` });
    return publicList(row);
}

async function sendBack(req, list, note) {
    if (!['pending_approval', 'approved'].includes(list.status)) refuse('Only a list waiting for approval or not yet published can go back to draft', 409);
    const row = await patch(AdmissionList, list._id, { status: 'draft', approvedBy: null, approvedAt: null, publishAt: null }, { where: { status: list.status } });
    events.recordQuietly(list.school, { by: req, type: 'list', action: 'returned', message: `${list.name} returned to draft${note ? ` — ${str(note, 300)}` : ''}` });
    return publicList(row);
}

// ── Offers ───────────────────────────────────────────────────────────────────

const LIST_EMAIL = (listNo) => (listNo === 1 ? 'first_list_selection' : listNo === 2 ? 'second_list_selection' : 'next_list_selection');

async function offerTerms(app, { respondBy = null, feeAmount = null, feeDueAt = null }, settings) {
    const round = await AdmissionRound.findById(app.round).lean();
    const cls = (round?.classes || []).find((c) => String(c.class) === String(app.class));
    const fee = feeAmount != null ? Math.max(0, Number(feeAmount) || 0) : Math.max(0, Number(cls?.admissionFee ?? round?.admissionFee) || 0);
    const by = respondBy ? new Date(respondBy) : new Date(Date.now() + settings.selection.offerValidityDays * 86400000);
    const due = feeDueAt ? new Date(feeDueAt) : new Date(by.getTime() + (Number(round?.admissionFeeDueDays) || 7) * 86400000);
    return { fee, respondBy: by, feeDueAt: due };
}

/**
 * Issue an offer inside a seat lock (q) — returns the offer, or null when the
 * class has no seat left. Moves the application to Offer Issued (or, where
 * the school runs no Offer stage, to Selected).
 */
async function issueOffer(q, app, { req = null, list = null, terms, settings, after, quota = '' }) {
    const flow = workflow.compile(settings.workflow);
    // A quota's seat carries its own fee rule (an RTE seat is free).
    const def = quota ? quotasSvc.quotaDef((await quotasSvc.classOf(app.round, app.class, q)).quotas, quota) : null;
    const adjusted = quotasSvc.feeFor(def, terms.fee);
    terms = { ...terms, fee: adjusted.fee };
    const school = await School.findById(app.school).select('name code').lean();
    const year = await AcademicYear.findById(app.academicYear).select('startDate').lean();
    const number = await counters.nextNumber(app.school, 'offer', settings.numbering.offer, { school, year: year?.startDate ? new Date(year.startDate).getFullYear() : null }, q);
    // The round's instalment plan, fixed for this offer.
    const { rows: [rplan] } = await q(`SELECT "instalments" FROM "admissionrounds" WHERE "_id" = $1`, [String(app.round)]);
    const schedule = require('./payments').planFor(rplan, terms.fee, terms.feeDueAt);
    const { sql, params } = buildInsert(AdmissionOffer, {
        school: app.school, application: app._id, round: app.round, class: app.class, list: list?._id || null, offerNumber: number, schedule,
        status: 'issued', issuedAt: new Date(), respondBy: terms.respondBy, feeAmount: terms.fee, feeDueAt: terms.feeDueAt, issuedBy: req?.userId || null,
        quota: quota || '',
    });
    const { rows: [offer] } = await q(sql, params);
    if (adjusted.note) await events.record(app.school, { application: app._id, by: req, type: 'fee', action: 'quota_fee', message: `Admission fee ${fmt.money(adjusted.fee)} — ${adjusted.note}`, visibility: 'applicant' }, q);
    const target = flow.enabled('offer') ? 'offer_issued' : 'selected';
    const set = {
        offerStatus: 'issued', admissionFeeAmount: terms.fee, admissionFeeStatus: terms.fee > 0 ? 'due' : 'not_required',
        ...(list ? { selection: { list: String(list._id), listName: list.name, listNo: list.listNo, decision: 'selected' } } : {}),
    };
    // A school with no Offer stage may already have this applicant as Selected.
    const appRow = app.status === target
        ? await patch(AdmissionApplication, app._id, set, { q })
        : await require('./applications').move(req, app, target, { system: true, q, after, quiet: true, set });
    return { offer, app: appRow };
}

/** Publish a list now (or schedule it): issue its offers, waitlist its waiting lines. */
async function publish(req, list, { at = null } = {}) {
    if (list.status !== 'approved') refuse('Approve the list before publishing it', 409);
    const when = at ? new Date(at) : null;
    if (when && Number.isNaN(when.getTime())) refuse('Choose a valid date and time');
    if (when && when > new Date(Date.now() + 60 * 1000)) {
        const row = await patch(AdmissionList, list._id, { publishAt: when }, { where: { status: 'approved' } });
        events.recordQuietly(list.school, { by: req, type: 'list', action: 'scheduled', message: `${list.name} will be published on ${fmt.fmtDateTime(when)}` });
        return { scheduled: true, list: publicList(row) };
    }
    return publishNow(req, list);
}

async function publishNow(req, list) {
    const settings = await settingsSvc.getSettings(list.school);
    // Claim the list first: a scheduled publication and a click cannot both run it.
    const claimed = await patch(AdmissionList, list._id, { status: 'published', publishedAt: new Date() }, { where: { status: 'approved' } });
    if (!claimed) refuse('This list has already been published', 409);
    const { rows: lines } = await pool.query(
        `SELECT e.*, a."status" AS "appStatus" FROM ${TE} e JOIN ${TA} a ON a."_id" = e."application"
          WHERE e."list" = $1 ORDER BY e."rank"`, [String(list._id)]);
    const out = { offered: 0, waitlisted: 0, noSeat: 0, skipped: 0 };
    const after = [];
    try {
    await seats.withSeat(list.round, list.class, async (q, st) => {
        let available = st.available;
        for (const line of lines.filter((l) => l.decision === 'selected')) {
            const { rows: [app] } = await q(`SELECT * FROM ${TA} WHERE "_id" = $1 FOR UPDATE`, [line.application]);
            if (!app || workflow.isClosed(app.status) || ['offer_issued', 'accepted', 'payment_pending', 'confirmed', 'enrolled'].includes(app.status)) { out.skipped += 1; continue; }
            if (available !== null && available <= 0) {
                await q(`UPDATE ${TE} SET "decision" = 'waitlisted', "reason" = 'No seat left when the list was published', "updatedAt" = now() WHERE "_id" = $1`, [line._id]);
                line.decision = 'waitlisted';
                out.noSeat += 1;
                continue;
            }
            const terms = await offerTerms(app, { respondBy: list.acceptanceDeadline, feeDueAt: list.paymentDeadline }, settings);
            const { offer } = await issueOffer(q, app, { req, list, terms, settings, after, quota: list.quota || '' });
            await q(`UPDATE ${TE} SET "offer" = $2, "updatedAt" = now() WHERE "_id" = $1`, [line._id, offer._id]);
            if (available !== null) available -= 1;
            out.offered += 1;
            after.push(() => notify.toApplicant({ ...app, status: 'offer_issued' }, LIST_EMAIL(list.listNo), offerValues(offer, list, line)));
        }
        // Waiting positions, in rank order (including lines that just lost their seat).
        let pos = 0;
        for (const line of lines.filter((l) => l.decision === 'waitlisted').sort((a, b) => a.rank - b.rank)) {
            pos += 1;
            await q(`UPDATE ${TE} SET "waitPosition" = $2, "updatedAt" = now() WHERE "_id" = $1`, [line._id, pos]);
            const { rows: [app] } = await q(`SELECT * FROM ${TA} WHERE "_id" = $1 FOR UPDATE`, [line.application]);
            if (!app || workflow.isClosed(app.status)) { out.skipped += 1; continue; }
            const selection = { list: String(list._id), listName: list.name, listNo: list.listNo, decision: 'waitlisted', rank: line.rank, waitPosition: pos };
            if (app.status !== 'waitlisted' && !['offer_issued', 'accepted', 'payment_pending', 'confirmed'].includes(app.status)) {
                await require('./applications').move(req, app, 'waitlisted', { system: true, q, after, quiet: true, set: { selection } });
            } else {
                await patch(AdmissionApplication, app._id, { selection }, { q });
            }
            out.waitlisted += 1;
            const p = pos;
            after.push(() => notify.toApplicant(app, 'waiting_list', { list_name: list.name, selection_list: list.name, waitlist_position: String(p), rank: String(line.rank) }));
        }
    }, { quota: list.quota || '' });
    } catch (e) {
        // Nothing of it was committed — the list goes back to approved, to be published again.
        await patch(AdmissionList, list._id, { status: 'approved', publishedAt: null }, { where: { status: 'published' } }).catch(() => {});
        throw e;
    }
    for (const fn of after) await fn();
    events.recordQuietly(list.school, { by: req, type: 'list', action: 'published', message: `${list.name} published — ${out.offered} offered, ${out.waitlisted} waitlisted${out.noSeat ? `, ${out.noSeat} moved to the waiting list for want of seats` : ''}` });
    return { published: true, ...out };
}

function offerValues(offer, list, line) {
    return {
        list_name: list?.name || 'Admission offer', selection_list: list?.name || '', rank: line?.rank ? String(line.rank) : '',
        offer_deadline: fmt.fmtDate(offer.respondBy), admission_deadline: fmt.fmtDate(offer.feeDueAt),
        fee_amount: fmt.money(offer.feeAmount), payment_deadline: fmt.fmtDate(offer.feeDueAt),
    };
}

/** A manual offer, outside any list. */
async function manualOffer(req, app, input = {}) {
    const settings = await settingsSvc.getSettings(app.school);
    if (workflow.isClosed(app.status) && app.status !== 'offer_expired') refuse('This application is closed', 409);
    // The Offer stage's own checks, as the school set them — an offer by hand
    // is a system move, which would otherwise pass them by.
    const flowNow = workflow.compile(settings.workflow);
    const offerStage = flowNow.stage('offer');
    if (flowNow.enabled('offer') && offerStage?.requiredChecks?.length) {
        const facts = await require('./applications').factsFor(app);
        const failing = offerStage.requiredChecks.filter((c) => !workflow.checkPasses(c, facts));
        if (failing.length) refuse(`Not ready for an offer: ${failing.map((c) => workflow.CHECK_PROBLEMS[c] || workflow.CHECKS[c]).join('; ')}`, 409, { code: 'NOT_READY' });
    }
    if (['offer_issued', 'accepted', 'payment_pending', 'confirmed', 'enrolled'].includes(app.status)) refuse('This application already holds an offer', 409);
    if (!['verified', 'eligible', 'exam_completed', 'interview_completed', 'evaluated', 'selected', 'waitlisted', 'offer_expired'].includes(app.status)) {
        refuse('An offer can be made once the application has been reviewed', 409);
    }
    // The seat comes from the application's verified quota, unless the office names the pool.
    const held = ['verified', 'allotted'].includes(app.quotaStatus) ? app.quota : '';
    const bucket = input.quota !== undefined && input.quota !== null ? str(input.quota, 40) : held;
    if (bucket && bucket !== held) refuse('An offer from a quota\'s seats needs the application\'s claim to that quota verified first', 409, { code: 'QUOTA_NOT_VERIFIED' });
    const after = [];
    const result = await seats.withSeat(app.round, app.class, async (q, st) => {
        if (st.available !== null && st.available <= 0) refuse(`No seat left in ${bucket ? 'this quota' : 'this class'} (${st.taken} of ${st.capacity} held)`, 409, { code: 'NO_SEAT' });
        // RTE classes: a seat by hand is choosing one child over another — unless every one
        // waiting in the same pool can have one. A child the state allotted was chosen by the state.
        if (app.quotaStatus !== 'allotted') {
            const { rows: [w] } = await q(
                `SELECT COUNT(*)::int AS n FROM ${TA} a WHERE a."round" = $1 AND a."class" = $2 AND a."status" = ANY($3::text[])
                   AND NOT EXISTS (SELECT 1 FROM ${TO} o WHERE o."application" = a."_id" AND o."status" = ANY($4::text[]))
                   ${bucket ? `AND a."quota" = $5 AND a."quotaStatus" IN ('verified', 'allotted')` : ''}`,
                [String(app.round), String(app.class), DEFAULT_POOL, seats.HOLDING_OFFER, ...(bucket ? [bucket] : [])]);
            await compliance.assertHandOffer(settings, app, st, w.n);
        }
        const { rows: [locked] } = await q(`SELECT * FROM ${TA} WHERE "_id" = $1 FOR UPDATE`, [String(app._id)]);
        if (locked.status !== app.status) refuse('The application changed — refresh and try again', 409);
        const terms = await offerTerms(locked, { respondBy: input.respondBy, feeAmount: input.feeAmount, feeDueAt: input.feeDueAt }, settings);
        return issueOffer(q, locked, { req, terms, settings, after, quota: bucket });
    }, { quota: bucket });
    for (const fn of after) await fn();
    notify.toApplicant(result.app, 'admission_offer', offerValues(result.offer, null, null));
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'offer', action: 'issued', message: `Offer ${result.offer.offerNumber} issued${input.note ? ` — ${str(input.note, 300)}` : ''}` });
    return result;
}

/** The live offer of an application, if any. */
async function liveOffer(applicationId, q = null) {
    const run = q || ((s, p) => pool.query(s, p));
    const { rows } = await run(`SELECT * FROM ${TO} WHERE "application" = $1 AND "status" = ANY($2::text[]) ORDER BY "issuedAt" DESC LIMIT 1`, [String(applicationId), seats.HOLDING_OFFER]);
    return rows[0] || null;
}

/** The applicant (or the office on their behalf) accepts or declines. */
async function respond(req, app, accept, note = '', { byApplicant = false } = {}) {
    const settings = await settingsSvc.getSettings(app.school);
    if (byApplicant && !settings.selection.allowApplicantResponse) refuse('Please contact the admission office to respond to this offer', 403);
    const offer = await liveOffer(app._id);
    if (!offer || offer.status !== 'issued') refuse('There is no open offer on this application', 409);
    if (offer.respondBy && new Date(offer.respondBy) < new Date()) refuse('The time to respond to this offer has passed', 409, { code: 'OFFER_EXPIRED' });
    const flow = workflow.compile(settings.workflow);
    const after = [];
    const { withTransaction } = require('../dbTx');
    const updated = await withTransaction(async (q) => {
        const o = await patch(AdmissionOffer, offer._id, { status: accept ? 'accepted' : 'declined', respondedAt: new Date(), responseNote: str(note, 300) }, { where: { status: 'issued' }, q });
        if (!o) refuse('The offer changed — refresh and try again', 409);
        const apps = require('./applications');
        let row = await apps.move(byApplicant ? req : req, app, accept ? 'accepted' : 'declined', {
            system: true, q, after, quiet: true, actorIsApplicant: byApplicant, reason: accept ? '' : (str(note, 300) || 'Offer declined'),
            set: { offerStatus: accept ? 'accepted' : 'declined' },
        });
        if (accept && flow.enabled('fee_payment') && Number(offer.feeAmount) > 0 && row.admissionFeeStatus === 'due') {
            row = await apps.move(req, row, 'payment_pending', { system: true, q, after, quiet: true });
        }
        return row;
    });
    for (const fn of after) await fn();
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'offer', action: accept ? 'accepted' : 'declined', message: `Offer ${offer.offerNumber} ${accept ? 'accepted' : 'declined'}${note ? ` — ${str(note, 300)}` : ''}`, visibility: 'applicant' });
    if (!accept) await promote(app.round, app.class, { reason: `${app.applicationNumber} declined` });
    return updated;
}

/** An offer that lapsed, was withdrawn or cancelled gives its seat back. */
async function closeOffer(offer, status, { req = null, reason = '', moveApp = true } = {}) {
    const { withTransaction } = require('../dbTx');
    const after = [];
    const closed = await withTransaction(async (q) => {
        const o = await patch(AdmissionOffer, offer._id, { status, reason: str(reason, 300), closedBy: req?.userId || null }, { where: { status: offer.status }, q });
        if (!o) return null;
        if (moveApp) {
            const { rows: [app] } = await q(`SELECT * FROM ${TA} WHERE "_id" = $1 FOR UPDATE`, [String(offer.application)]);
            if (app && ['offer_issued', 'accepted', 'payment_pending'].includes(app.status)) {
                await require('./applications').move(req, app, 'offer_expired', { system: true, q, after, quiet: true, reason, set: { offerStatus: status } });
            } else if (app) {
                await patch(AdmissionApplication, app._id, { offerStatus: status }, { q });
            }
        }
        return o;
    });
    for (const fn of after) await fn();
    return closed;
}

async function withdrawOffer(req, app, reason) {
    const offer = await liveOffer(app._id);
    if (!offer || offer.status === 'confirmed') refuse('There is no open offer to withdraw', 409);
    const why = str(reason, 300);
    if (!why) refuse('Say why the offer is withdrawn — the family is told', 400, { field: 'reason' });
    await closeOffer(offer, 'withdrawn', { req, reason: why });
    notify.toApplicant(app, 'admission_cancelled', { reason: why, status: 'Offer withdrawn' });
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'offer', action: 'withdrawn', message: `Offer ${offer.offerNumber} withdrawn — ${why}`, visibility: 'applicant' });
    await promote(app.round, app.class, { reason: `${app.applicationNumber}'s offer withdrawn` });
    return { ok: true };
}

async function extendOffer(req, app, respondBy) {
    const offer = await liveOffer(app._id);
    if (!offer || !['issued', 'accepted'].includes(offer.status)) refuse('There is no open offer to extend', 409);
    const by = date(respondBy);
    if (!by || by < new Date()) refuse('Choose a date in the future');
    const set = offer.status === 'issued' ? { respondBy: by, remindedAt: null } : { feeDueAt: by, remindedAt: null };
    await patch(AdmissionOffer, offer._id, set);
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'offer', action: 'extended', message: `${offer.status === 'issued' ? 'Response' : 'Fee payment'} deadline moved to ${fmt.fmtDate(by)}`, visibility: 'applicant' });
    return { ok: true };
}

/** Called when an application is withdrawn or cancelled: its offer goes and the seat moves on. */
async function releaseFor(app, { req = null, reason = '' } = {}) {
    const offer = await liveOffer(app._id);
    if (offer) await closeOffer(offer, app.status === 'withdrawn' ? 'withdrawn' : 'cancelled', { req, reason, moveApp: false });
    await patch(AdmissionApplication, app._id, { offerStatus: offer ? (app.status === 'withdrawn' ? 'withdrawn' : 'cancelled') : app.offerStatus }, { touch: false }).catch(() => {});
    if (offer || ['confirmed'].includes(app.status)) await promote(app.round, app.class, { reason: `${app.applicationNumber || 'An application'} left` });
}

/**
 * A seat came free: offer it to the next on the waiting list — when the
 * school asked for that — or tell the admission office.
 */
async function promote(roundId, classId, opts = {}) {
    try { return await promoteNow(roundId, classId, opts); } catch (e) {
        console.error('[admission] waiting-list promotion:', e.message);
        return { promoted: 0, error: e.message };
    }
}

async function promoteNow(roundId, classId, { reason = '' } = {}) {
    const { rows: [round] } = await pool.query(`SELECT "school" FROM "admissionrounds" WHERE "_id" = $1`, [String(roundId)]);
    if (!round) return { promoted: 0 };
    const settings = await settingsSvc.getSettings(round.school);
    if (!settings.selection.autoPromoteWaitlist) {
        const admins = await require('../designationService').moduleAdminIds(round.school, 'admission');
        const cls = await Class.findById(classId).select('className').lean();
        require('../notifyService').notify({
            school: round.school, sender: admins[0] || round.school, senderRole: 'system', recipients: admins, includeSender: true,
            title: `A seat is free in ${cls?.className || 'a class'}`, body: `${reason || 'An offer closed'}. Waiting-list promotion is set to manual — offer the seat from the selection list.`,
            link: { type: 'admission.selection' },
        });
        return { promoted: 0 };
    }
    const after = [];
    let promoted = 0;
    // Each pool of seats moves its own waiting list: a freed RTE seat goes to the RTE list's next, a general one to the general list's.
    const cfg = await seats.classConfig(roundId, classId);
    for (const bucket of ['', ...cfg.quotas.map((x) => x.key)]) {
        await seats.withSeat(roundId, classId, async (q, st) => {
            let available = st.available;
            let guard = 0;
            while ((available === null || available > 0) && guard++ < 50) {
                const { rows: [next] } = await q(
                    `SELECT e."_id" AS "entryId", e."list", e."rank", l."name" AS "listName", l."listNo", a.*
                       FROM ${TE} e
                       JOIN "admissionlists" l ON l."_id" = e."list" AND l."status" = 'published' AND l."round" = $1 AND l."class" = $2 AND COALESCE(l."quota", '') = $3
                       JOIN ${TA} a ON a."_id" = e."application" AND a."status" = 'waitlisted'
                      WHERE e."decision" = 'waitlisted'
                      ORDER BY l."listNo" DESC, e."waitPosition" ASC NULLS LAST
                      LIMIT 1 FOR UPDATE OF a`, [String(roundId), String(classId), bucket]);
                if (!next) break;
                const app = { ...next, _id: next._id };
                const terms = await offerTerms(app, {}, settings);
                const list = { _id: next.list, name: next.listName, listNo: next.listNo };
                const { offer } = await issueOffer(q, app, { list, terms, settings, after, quota: bucket });
                await q(`UPDATE ${TE} SET "decision" = 'selected', "offer" = $2, "reason" = 'Promoted from the waiting list', "updatedAt" = now() WHERE "_id" = $1`, [next.entryId, offer._id]);
                after.push(() => notify.toApplicant(app, 'next_list_selection', offerValues(offer, list, { rank: next.rank })));
                after.push(() => events.recordQuietly(round.school, { application: app._id, type: 'offer', action: 'promoted', message: `Offered a seat from the waiting list (${list.name})`, visibility: 'applicant' }));
                promoted += 1;
                if (available !== null) available -= 1;
                if (available === null) break;   // unlimited seats: one free seat, one promotion
            }
        }, { quota: bucket });
    }
    for (const fn of after) await fn();
    return { promoted };
}

// ── Confirming the admission ─────────────────────────────────────────────────

/** What still stands between this application and confirmation. */
async function confirmationBlockers(app, settings) {
    const blockers = [];
    const flow = workflow.compile(settings.workflow);
    const offerStage = flow.enabled('offer');
    const okStatuses = offerStage ? ['accepted', 'payment_pending'] : ['selected', 'accepted', 'payment_pending'];
    if (!okStatuses.includes(app.status)) blockers.push(offerStage ? 'The offer has not been accepted' : 'The applicant has not been selected');
    // On an instalment plan whose round allows it, the first instalment is enough to confirm.
    let firstPaid = false;
    let plan = null;
    if (app.admissionFeeStatus === 'due') {
        const { rows: [r] } = await pool.query(`SELECT "confirmWith" FROM "admissionrounds" WHERE "_id" = $1`, [String(app.round)]);
        plan = r?.confirmWith === 'first' ? await require('./payments').scheduleOf(app) : null;
        firstPaid = !!plan && plan[0].owing <= 0;
    }
    if (settings.conversion.requireAdmissionFeePaid && app.admissionFeeStatus === 'due' && !firstPaid) {
        blockers.push(plan ? `The first instalment of the admission fee (${fmt.money(plan[0].amount)}) is not paid` : 'The admission fee is not paid or waived');
    }
    const apps = require('./applications');
    const schema = await apps.schemaOf(app);
    const types = await require('./documents').typesOf(app.school);
    const docs = await require('./documents').currentDocs(app._id);
    const reqs = require('./documents').requirements(app, schema, types);
    const byKey = new Map(docs.map((d) => [d.docKey, d]));
    for (const r of reqs) {
        const gateHere = r.type.gate === 'before_confirmation' || (settings.conversion.requireDocumentsVerified && r.required && r.type.verification);
        if (!gateHere) continue;
        const d = byKey.get(r.type.key);
        if (r.required && !d) blockers.push(`${r.type.name} has not been uploaded`);
        else if (d && r.type.verification && d.status !== 'verified') blockers.push(`${r.type.name} is not verified`);
    }
    // The stage's own checks, as the school configured them — each said as
    // what is wrong, so one already listed above is not listed again.
    const stage = flow.stage('confirmation');
    if (stage?.requiredChecks?.length) {
        const facts = await apps.factsFor(app, schema);
        const docNamed = blockers.some((b) => / has not been uploaded$| is not verified$/.test(b));
        for (const c of stage.requiredChecks) {
            if (workflow.checkPasses(c, facts)) continue;
            if (c === 'admission_fee_paid' && (firstPaid || plan)) continue;   // already said, the instalment way
            if (docNamed && ['documents_uploaded', 'documents_verified'].includes(c)) continue;
            blockers.push(workflow.CHECK_PROBLEMS[c] || workflow.CHECKS[c]);
        }
    }
    return [...new Set(blockers)];
}

async function confirm(req, app) {
    const settings = await settingsSvc.getSettings(app.school);
    const blockers = await confirmationBlockers(app, settings);
    if (blockers.length) refuse(`Not ready to confirm: ${blockers.join('; ')}`, 409, { code: 'NOT_READY', errors: blockers.map((m) => ({ path: 'confirm', message: m })) });
    const access = require('./access');
    const stage = workflow.compile(settings.workflow).stage('confirmation');
    if (stage?.requiresApproval && !(await access.isAdmin(req))) refuse('Confirming an admission needs an admission administrator', 403);
    const after = [];
    const live = await liveOffer(app._id);
    const confirmPool = live ? (live.quota || '') : (['verified', 'allotted'].includes(app.quotaStatus) ? app.quota : '');
    const updated = await seats.withSeat(app.round, app.class, async (q, st) => {
        const { rows: [locked] } = await q(`SELECT * FROM ${TA} WHERE "_id" = $1 FOR UPDATE`, [String(app._id)]);
        if (locked.status !== app.status) refuse('The application changed — refresh and try again', 409);
        const offer = await liveOffer(app._id, q);
        if (!offer && st.available !== null && st.available <= 0) refuse('No seat left in this class', 409, { code: 'NO_SEAT' });
        if (offer) await patch(AdmissionOffer, offer._id, { status: 'confirmed' }, { q });
        return require('./applications').move(req, locked, 'confirmed', { system: true, q, after, quiet: true, set: { offerStatus: offer ? 'confirmed' : locked.offerStatus } });
    }, { quota: confirmPool });
    for (const fn of after) await fn();
    // The move above already wrote "Admission confirmed" to the history.
    notify.toApplicant(updated, 'admission_confirmed');
    return updated;
}

// ── Scheduled work ───────────────────────────────────────────────────────────

/** Lists whose publication time has come. */
async function publishDue() {
    const { rows } = await pool.query(`SELECT * FROM "admissionlists" WHERE "status" = 'approved' AND "publishAt" IS NOT NULL AND "publishAt" <= now() LIMIT 20`);
    let n = 0;
    for (const list of rows) {
        try { await publishNow(null, list); n += 1; } catch (e) { if (e.status !== 409) console.error('[admission] scheduled list:', e.message); }
    }
    return n;
}

/** Offers nobody answered in time, and accepted offers whose fee was not paid by its date. */
async function expireDue() {
    const { rows } = await pool.query(
        `SELECT o.* FROM ${TO} o JOIN ${TA} a ON a."_id" = o."application"
          WHERE (o."status" = 'issued' AND o."respondBy" IS NOT NULL AND o."respondBy" < now())
             OR (o."status" = 'accepted' AND o."feeDueAt" IS NOT NULL AND o."feeDueAt" < now() AND a."admissionFeeStatus" = 'due')
          LIMIT 50`);
    let n = 0;
    for (const offer of rows) {
        // On an instalment plan, paying the first instalment in time keeps the offer.
        if (offer.status === 'accepted' && Array.isArray(offer.schedule) && offer.schedule.length > 1) {
            const { rows: [app] } = await pool.query(`SELECT * FROM ${TA} WHERE "_id" = $1`, [offer.application]);
            const plan = app ? await require('./payments').scheduleOf(app) : null;
            if (plan && plan[0].owing <= 0) continue;
        }
        const reason = offer.status === 'issued' ? `No response by ${fmt.fmtDate(offer.respondBy)}` : `Admission fee not paid by ${fmt.fmtDate(offer.feeDueAt)}`;
        const closed = await closeOffer(offer, 'expired', { reason }).catch((e) => { console.error('[admission] expire:', e.message); return null; });
        if (!closed) continue;
        n += 1;
        const { rows: [app] } = await pool.query(`SELECT * FROM ${TA} WHERE "_id" = $1`, [offer.application]);
        if (app) {
            notify.toApplicant(app, 'admission_cancelled', { reason: `The offer has expired: ${reason.toLowerCase()}.`, status: 'Offer expired' });
            events.recordQuietly(app.school, { application: app._id, type: 'offer', action: 'expired', message: `Offer expired — ${reason}`, visibility: 'applicant' });
        }
        await promote(offer.round, offer.class, { reason: `An offer expired (${reason})` });
    }
    return n;
}

module.exports = {
    DEFAULT_POOL, normalizeCriteria, rankPool, build, createList, updateList, setDecision, submitForApproval, approve, sendBack,
    publish, publishNow, manualOffer, liveOffer, respond, closeOffer, withdrawOffer, extendOffer, releaseFor, promote,
    confirmationBlockers, confirm, publishDue, expireDue, offerValues,
    METHODS, isLottery, drawLottery, verifyDraw, cancelList, publicList, pointsFor,
};
