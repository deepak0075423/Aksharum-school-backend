'use strict';
/**
 * Quotas — seats set aside within a class (Oct 2026).
 *
 * A round's class can reserve seats for groups: the RTE Act's 25% for children
 * from economically weaker sections and disadvantaged groups (s.12(1)(c), in
 * private unaided schools, allotted by the state), staff wards, siblings,
 * management seats, sports. Each quota is its own pool of seats
 * (services/admission/seats.js); the general seats are what is left.
 *
 *   quota      { key, name, kind, seats, released, feeRule, claim }
 *   feeRule    { type: normal | free | percent, percent } — applied when an
 *              offer is made from the quota's seats
 *   claim      { field, op, value } — an answer on the form that puts an
 *              application in the quota when it is submitted ("Is a parent on
 *              the school's staff? = Yes"). The office then verifies or
 *              rejects the claim. RTE seats are never claimed this way: the
 *              state allots them, and the office imports the allotment.
 *
 * A quota's seats left unfilled can be released to the general seats; the
 * reimbursement the state owes for each RTE child is kept in a register.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../../db/pool');
const { patch } = require('../../db/patch');
const { withTransaction, lock, buildInsert } = require('../dbTx');
const AdmissionRound = require('../../models/AdmissionRound');
const AdmissionApplication = require('../../models/AdmissionApplication');
const AdmissionApplicant = require('../../models/AdmissionApplicant');
const AdmissionRteClaim = require('../../models/AdmissionRteClaim');
const User = require('../../models/User');
const School = require('../../models/School');
const AcademicYear = require('../../models/AcademicYear');
const formEngine = require('./formEngine');
const events = require('./events');
const counters = require('./counters');
const seats = require('./seats');
const identity = require('../accountIdentity');
const { refuse, str, num, isId, round2 } = require('./util');
const { textProblem, nameProblem } = require('../../utils/textRules');
const { isEmail, isPhone, normalizePhone } = require('../../utils/validators');

const KINDS = ['rte', 'staff', 'sibling', 'management', 'sports', 'other'];
const KIND_LABEL = { rte: 'RTE 25% (EWS / DG)', staff: 'Staff ward', sibling: 'Sibling', management: 'Management', sports: 'Sports', other: 'Other' };
const KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;
const TA = `"${AdmissionApplication.tableName}"`;

// ── Configuration ────────────────────────────────────────────────────────────

/** A class's quotas as the office wrote them, checked: keys, seats within the class, claims that read real questions. */
function normalizeQuotas(list, { classSeats = 0, current = [], fields = null, label = 'The class' } = {}) {
    const out = [];
    const keys = new Set();
    for (const [i, q] of (Array.isArray(list) ? list : []).slice(0, 8).entries()) {
        const name = str(q?.name, 60);
        if (!name) refuse(`${label}: quota ${i + 1} needs a name`, 400, { field: 'classes' });
        const bad = textProblem(name, `${label}: quota name`, 'title'); if (bad) refuse(bad, 400, { field: 'classes' });
        const kind = KINDS.includes(q?.kind) ? q.kind : 'other';
        const key = KEY_RE.test(String(q?.key || '')) ? q.key : `${kind}_${i + 1}`;
        if (keys.has(key)) refuse(`${label}: two quotas share the key "${key}"`, 400, { field: 'classes' });
        keys.add(key);
        const before = current.find((x) => x.key === key);
        const seatsN = num(q?.seats, { min: 0, max: 5000, d: 0, int: true });
        const released = Math.min(seatsN, Number(before?.released) || 0);
        const ft = ['normal', 'free', 'percent'].includes(q?.feeRule?.type) ? q.feeRule.type : (kind === 'rte' ? 'free' : 'normal');
        const feeRule = { type: ft, percent: ft === 'percent' ? num(q?.feeRule?.percent, { min: 1, max: 100, d: 50 }) : 0 };
        let claim = null;
        if (q?.claim?.field && kind !== 'rte') {
            const f = fields ? fields.get(String(q.claim.field)) : { type: 'text' };
            if (!f || ['info', 'file'].includes(f.type)) refuse(`${label}: the ${name} claim must read a question of the class's form`, 400, { field: 'classes' });
            const op = formEngine.OPS.includes(q.claim.op) ? q.claim.op : 'eq';
            let value = q.claim.value;
            if (['checked', 'not_checked', 'filled', 'empty'].includes(op)) value = null;
            else if (['in', 'not_in'].includes(op)) value = (Array.isArray(value) ? value : String(value ?? '').split(',')).map((x) => str(x, 60)).filter(Boolean);
            else value = str(value, 60);
            claim = { field: String(q.claim.field), op, value };
        }
        out.push({ key, name, kind, seats: seatsN, released, feeRule, claim });
    }
    const reserved = out.reduce((s, q) => s + q.seats, 0);
    if (classSeats > 0 && reserved > classSeats) refuse(`${label}: the quotas set aside ${reserved} seats, more than the class's ${classSeats}`, 400, { field: 'classes' });
    return out;
}

async function classOf(roundId, classId, q = null) {
    const run = q || ((s, p) => pool.query(s, p));
    const { rows: [round] } = await run(`SELECT * FROM "${AdmissionRound.tableName}" WHERE "_id" = $1`, [String(roundId)]);
    const cls = (round?.classes || []).find((c) => String(c.class) === String(classId));
    return { round, cls, quotas: Array.isArray(cls?.quotas) ? cls.quotas : [] };
}

const quotaDef = (quotas, key) => (key ? quotas.find((q) => q.key === key) || null : null);

/** The admission fee an offer from this quota's seats carries. */
function feeFor(def, fee) {
    if (!def || def.feeRule?.type === 'normal' || !def.feeRule) return { fee, note: '' };
    if (def.feeRule.type === 'free') return { fee: 0, note: `${def.name} — a free seat` };
    const cut = round2(fee * (Number(def.feeRule.percent) || 0) / 100);
    return { fee: round2(Math.max(0, fee - cut)), note: `${def.name} — ${def.feeRule.percent}% concession` };
}

// ── Claims, and the office deciding on them ──────────────────────────────────

/** On submission: the first quota whose claim the answers meet. Never overrides the office's own decision. */
async function claimOnSubmit(app) {
    if (app.quota && ['verified', 'rejected', 'allotted'].includes(app.quotaStatus)) return null;
    const { quotas } = await classOf(app.round, app.class);
    const hit = quotas.find((q) => q.claim && formEngine.conditionHolds({ mode: 'all', rules: [q.claim] }, app.data || {}));
    const set = hit ? { quota: hit.key, quotaStatus: 'claimed', quotaNote: '' } : (app.quotaStatus === 'claimed' ? { quota: '', quotaStatus: '', quotaNote: '' } : null);
    if (!set) return null;
    await patch(AdmissionApplication, app._id, set, { touch: false });
    if (hit) events.recordQuietly(app.school, { application: app._id, type: 'quota', action: 'claimed', message: `Applied under the ${hit.name} quota — to be checked`, visibility: 'applicant' });
    return hit;
}

/** The office puts an application in a quota, verifies or rejects its claim, or takes it out. */
async function setQuota(req, app, { quota = '', status = 'verified', note = '' } = {}) {
    if (app.quotaStatus === 'allotted') refuse('The state allotted this seat — its quota cannot be changed here', 409);
    if (['confirmed', 'enrolled'].includes(app.status)) refuse('The admission is confirmed — its quota is settled', 409);
    const { quotas } = await classOf(app.round, app.class);
    const def = quotaDef(quotas, String(quota || ''));
    if (quota && !def) refuse('That quota is not one of this class\'s', 400, { field: 'quota' });
    if (def?.kind === 'rte') refuse('RTE seats are allotted by the state — import the allotment instead', 409, { field: 'quota' });
    const st = !quota ? '' : ['claimed', 'verified', 'rejected'].includes(status) ? status : 'verified';
    const why = str(note, 300);
    if (st === 'rejected' && !why) refuse('Say why the claim is not accepted — the family is told', 400, { field: 'note' });
    if (why) { const bad = textProblem(why, 'The note'); if (bad) refuse(bad, 400, { field: 'note' }); }
    const row = await patch(AdmissionApplication, app._id, { quota: quota ? def.key : '', quotaStatus: st, quotaNote: why }, { touch: false });
    const msg = !quota ? 'Taken out of its quota' : st === 'verified' ? `Quota confirmed: ${def.name}` : st === 'rejected' ? `${def.name} quota claim not accepted — ${why}` : `Applied under the ${def.name} quota`;
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'quota', action: st || 'removed', message: msg, visibility: 'applicant' });
    return row;
}

/** Give a quota's unfilled seats to the general seats. */
async function release(req, roundId, classId, key, count) {
    return withTransaction(async (q) => {
        await lock(q, `admission-seat:${roundId}:${classId}`);
        const { round, quotas } = await classOf(roundId, classId, q);
        if (!round || String(round.school) !== String(req.schoolId)) refuse('Round not found', 404);
        const def = quotaDef(quotas, key);
        if (!def) refuse('Quota not found', 404);
        const st = await seats.state(roundId, classId, q, { quota: key });
        const n = num(count, { min: 1, max: 5000, d: 0, int: true });
        if (!n || n > st.available) refuse(`Only ${st.available} of the ${def.name} seats are unfilled`, 409);
        const classes = round.classes.map((c) => (String(c.class) !== String(classId) ? c : { ...c, quotas: c.quotas.map((x) => (x.key === key ? { ...x, released: (Number(x.released) || 0) + n } : x)) }));
        await q(`UPDATE "${AdmissionRound.tableName}" SET "classes" = $2::jsonb, "updatedAt" = now() WHERE "_id" = $1`, [String(roundId), JSON.stringify(classes)]);
        events.recordQuietly(req.schoolId, { by: req, type: 'quota', action: 'released', message: `${n} unfilled ${def.name} seat(s) released to the general seats` });
        return { released: n };
    });
}

// ── RTE allotments from the state ────────────────────────────────────────────

/**
 * The family's applicant account for an application the office enters: the
 * address's existing sign-in joined (its password kept), or a new one nobody
 * can use until the family sets a password ("Forgot password" on the portal);
 * no address at all: a closed placeholder the office works on alone.
 */
async function accountFor(schoolId, { name, email, phone }) {
    const address = String(email || '').trim().toLowerCase();
    if (address) {
        const rows = await identity.membershipsByEmail(address);
        const here = rows.find((r) => String(r.school || '') === String(schoolId) && r.role === 'guest');
        if (here) return { user: here, created: false };
        if (rows.some((r) => ['student', 'super_admin'].includes(r.role))) refuse(`${address} belongs to a student or platform account — use the parent's own email`, 400);
        const donor = rows.find((r) => r.password) || null;
        const credentials = donor ? { password: donor.password, isFirstLogin: !!donor.isFirstLogin } : { password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), isFirstLogin: true };
        const user = await User.create({ name, email: address, phone: phone || '', role: 'guest', school: schoolId, ...credentials, isActive: true });
        await AdmissionApplicant.create({ school: schoolId, user: user._id, phone: phone || '', verifiedAt: null, consentAt: null, consentVersion: 0, source: 'Office', linkedExisting: !!donor });
        return { user: user.toObject ? user.toObject() : user, created: true };
    }
    const placeholder = `allotment+${crypto.randomUUID()}@invalid.example`;
    const user = await User.create({ name, email: placeholder, phone: phone || '', role: 'guest', school: schoolId, password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), isFirstLogin: true, isActive: false });
    await AdmissionApplicant.create({ school: schoolId, user: user._id, phone: phone || '', consentVersion: 0, source: 'Office' });
    return { user: user.toObject ? user.toObject() : user, created: true };
}

const RELATIONS = { Father: 'father', Mother: 'mother', Guardian: 'guardian' };

/** Check one row of an allotment list. Returns the clean row or throws with the row number. */
function allotmentRow(r, i) {
    const at = `Row ${i + 1}`;
    const ref = str(r?.externalRef, 40);
    if (!ref || !/^[A-Za-z0-9/._-]+$/.test(ref)) refuse(`${at}: the state's application number is missing or has odd characters`, 400);
    const studentName = str(r?.studentName, 80);
    const nb = nameProblem(studentName, `${at}: the child's name`); if (!studentName || nb) refuse(nb || `${at}: the child's name is missing`, 400);
    const dob = /^\d{4}-\d{2}-\d{2}$/.test(String(r?.studentDob || '')) ? String(r.studentDob) : '';
    if (!dob) refuse(`${at}: the date of birth must be YYYY-MM-DD`, 400);
    const parentName = str(r?.parentName, 80);
    const pb = nameProblem(parentName, `${at}: the parent's name`); if (!parentName || pb) refuse(pb || `${at}: the parent's name is missing`, 400);
    if (!isPhone(r?.parentPhone)) refuse(`${at}: the parent's mobile must be a 10-digit number`, 400);
    const email = str(r?.parentEmail, 200).toLowerCase();
    if (email && !isEmail(email)) refuse(`${at}: the parent's email is not valid`, 400);
    return {
        externalRef: ref, studentName, studentDob: dob, studentGender: ['Male', 'Female', 'Other'].includes(r?.studentGender) ? r.studentGender : '',
        parentName, parentPhone: normalizePhone(r.parentPhone), parentEmail: email,
        relation: RELATIONS[r?.relation] ? r.relation : 'Guardian', category: ['EWS', 'DG'].includes(String(r?.category || '').toUpperCase()) ? String(r.category).toUpperCase() : '',
    };
}

/**
 * Bring in the children the state allotted to the school's RTE quota. Each
 * becomes an application already selected — the state chose, not the school —
 * under the quota, with the state's reference. A reference already imported
 * is skipped, so the same list can be loaded twice safely.
 */
async function importAllotments(req, roundId, { class: classId, quota: key, rows } = {}) {
    if (!isId(String(roundId || '')) || !isId(String(classId || ''))) refuse('Choose the round and class');
    const { round, cls, quotas } = await classOf(roundId, classId);
    if (!round || String(round.school) !== String(req.schoolId) || !cls) refuse('Round or class not found', 404);
    const def = quotaDef(quotas, String(key || ''));
    if (!def || def.kind !== 'rte') refuse('Choose the class\'s RTE quota — set one up on the round first', 400, { field: 'quota' });
    const list = (Array.isArray(rows) ? rows : []).slice(0, 500).map(allotmentRow);
    if (!list.length) refuse('The allotment list is empty');
    const refs = new Set();
    for (const r of list) { if (refs.has(r.externalRef)) refuse(`${r.externalRef} appears twice in the list`, 400); refs.add(r.externalRef); }
    const form = await require('./applications').formFor(round, classId);
    const school = await School.findById(req.schoolId).select('name code').lean();
    const year = await AcademicYear.findById(round.academicYear).select('startDate').lean();
    const settings = await require('./settings').getSettings(req.schoolId);
    const classDoc = (await pool.query(`SELECT "className", "classNumber" FROM "classes" WHERE "_id" = $1`, [String(classId)])).rows[0];
    const out = { imported: 0, skipped: 0, accounts: 0 };
    for (const r of list) {
        const { rows: [have] } = await pool.query(`SELECT "_id" FROM ${TA} WHERE "round" = $1 AND "externalRef" = $2`, [String(roundId), r.externalRef]);
        if (have) { out.skipped += 1; continue; }
        const { user, created } = await accountFor(req.schoolId, { name: r.parentName, email: r.parentEmail, phone: r.parentPhone });
        if (created) out.accounts += 1;
        const rel = RELATIONS[r.relation];
        const data = { studentName: r.studentName, studentDob: r.studentDob, ...(r.studentGender ? { studentGender: r.studentGender } : {}), [`${rel}Name`]: r.parentName, [`${rel}Phone`]: r.parentPhone };
        await withTransaction(async (q) => {
            const number = await counters.nextNumber(req.schoolId, 'application', settings.numbering.application, { school, classDoc, year: year?.startDate ? new Date(year.startDate).getFullYear() : null }, q);
            const { sql, params } = buildInsert(AdmissionApplication, {
                school: req.schoolId, round: roundId, academicYear: round.academicYear, class: classId, applicant: user._id,
                form: form?.form?._id || null, formVersion: form?.version?._id || null, formVersionNo: form?.version?.version || null,
                applicationNumber: number, status: 'selected', stage: 'selection', statusChangedAt: new Date(), data,
                studentName: r.studentName, studentDob: new Date(`${r.studentDob}T00:00:00Z`), studentGender: r.studentGender,
                guardianName: r.parentName, guardianEmail: r.parentEmail, guardianPhone: r.parentPhone, source: 'RTE allotment',
                submittedAt: new Date(), lastSubmittedAt: new Date(), decidedAt: new Date(), lastActivityAt: new Date(),
                quota: def.key, quotaStatus: 'allotted', quotaNote: r.category ? `Category ${r.category}` : '', externalRef: r.externalRef,
                docStatus: 'missing', createdBy: req.userId,
            });
            const { rows: [app] } = await q(sql, params);
            await events.record(req.schoolId, { application: app._id, by: req, type: 'quota', action: 'allotted', message: `Allotted a seat under the RTE Act (s.12(1)(c)) by the state — reference ${r.externalRef}`, visibility: 'applicant' }, q);
        });
        out.imported += 1;
    }
    events.recordQuietly(req.schoolId, { by: req, type: 'quota', action: 'rte_import', message: `RTE allotment imported for ${classDoc?.className || 'a class'}: ${out.imported} new, ${out.skipped} already in` });
    return out;
}

// ── The reimbursement register ───────────────────────────────────────────────

const CLAIM_STATUS = ['pending', 'claimed', 'received', 'rejected'];

/** Every RTE child admitted for the year, each with a register line (made when missing). */
async function register(req, yearId) {
    if (!isId(String(yearId || ''))) refuse('Choose the academic year');
    const { rows: apps } = await pool.query(
        `SELECT a."_id", a."studentName", a."admissionNumber", a."studentUser", a."quota", a."round", a."class", c."className"
           FROM ${TA} a LEFT JOIN "classes" c ON c."_id" = a."class"
          WHERE a."school" = $1 AND a."academicYear" = $2 AND a."status" = 'enrolled' AND a."quota" <> '' AND a."quotaStatus" IN ('allotted', 'verified')`,
        [String(req.schoolId), String(yearId)]);
    for (const a of apps) {
        const { quotas } = await classOf(a.round, a.class);
        if (quotaDef(quotas, a.quota)?.kind !== 'rte') continue;
        const { sql, params } = buildInsert(AdmissionRteClaim, {
            school: req.schoolId, academicYear: yearId, application: a._id, student: a.studentUser, studentName: a.studentName,
            admissionNumber: a.admissionNumber, className: a.className || '', status: 'pending',
        });
        await pool.query(`${sql.replace(' RETURNING *', '')} ON CONFLICT ("academicYear", "application") DO NOTHING`, params);
    }
    const { rows } = await pool.query(`SELECT * FROM "${AdmissionRteClaim.tableName}" WHERE "school" = $1 AND "academicYear" = $2 ORDER BY "className", "studentName"`, [String(req.schoolId), String(yearId)]);
    const totals = rows.reduce((t, r) => ({ claimed: t.claimed + (Number(r.claimedAmount) || 0), received: t.received + (Number(r.receivedAmount) || 0) }), { claimed: 0, received: 0 });
    return { rows, totals: { children: rows.length, claimed: round2(totals.claimed), received: round2(totals.received), outstanding: round2(totals.claimed - totals.received) } };
}

async function updateClaim(req, id, input = {}) {
    if (!isId(String(id || ''))) refuse('Not found', 404);
    const { rows: [c] } = await pool.query(`SELECT * FROM "${AdmissionRteClaim.tableName}" WHERE "_id" = $1 AND "school" = $2`, [String(id), String(req.schoolId)]);
    if (!c) refuse('Not found', 404);
    const set = {};
    if (input.status !== undefined) { if (!CLAIM_STATUS.includes(input.status)) refuse('Choose pending, claimed, received or rejected'); set.status = input.status; }
    for (const k of ['perChildAmount', 'claimedAmount', 'receivedAmount']) if (input[k] !== undefined) set[k] = input[k] === '' || input[k] === null ? null : num(input[k], { min: 0, max: 10000000, d: null });
    for (const k of ['claimedAt', 'receivedAt']) if (input[k] !== undefined) set[k] = input[k] ? new Date(input[k]) : null;
    if (input.reference !== undefined) { const v = str(input.reference, 80); const bad = textProblem(v, 'The reference', 'code'); if (v && bad) refuse(bad, 400); set.reference = v; }
    if (input.notes !== undefined) { const v = str(input.notes, 500); const bad = textProblem(v, 'The notes'); if (bad) refuse(bad, 400); set.notes = v; }
    if (set.status === 'claimed' && !set.claimedAt && !c.claimedAt) set.claimedAt = new Date();
    if (set.status === 'received' && !set.receivedAt && !c.receivedAt) set.receivedAt = new Date();
    set.updatedBy = req.userId;
    return patch(AdmissionRteClaim, c._id, set);
}

module.exports = { KINDS, KIND_LABEL, normalizeQuotas, classOf, quotaDef, feeFor, claimOnSubmit, setQuota, release, accountFor, importAllotments, register, updateClaim, CLAIM_STATUS };
