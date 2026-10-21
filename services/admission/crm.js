'use strict';
/**
 * Enquiries as the admission office works them (Oct 2026): who owns each, when
 * it is next followed up, every call, email and visit logged, walk-ins and
 * phone calls written down by the office, the enquirer's account linked when
 * they register — and, per source, what the school spent against what it got:
 * enquiries, applications, admissions, and the cost of each.
 */
const pool = require('../../db/pool');
const { buildInsert, withTransaction, lock } = require('../dbTx');
const AdmissionEnquiry = require('../../models/AdmissionEnquiry');
const AdmissionSourceSpend = require('../../models/AdmissionSourceSpend');
const events = require('./events');
const { refuse, isId, str, date, round2 } = require('./util');
const { textProblem, nameProblem } = require('../../utils/textRules');
const { isEmail, isPhone, normalizePhone } = require('../../utils/validators');

const STATUSES = ['new', 'contacted', 'registered', 'closed'];
const PRIORITIES = ['hot', 'warm', 'cold'];
const KINDS = { call: 'Phone call', email: 'Email', sms: 'Text message', whatsapp: 'WhatsApp', visit: 'Visit to the school', meeting: 'Meeting', note: 'Note' };
const OUTCOMES = { reached: 'Spoke to them', no_answer: 'No answer', left_message: 'Left a message', interested: 'Interested', not_interested: 'Not interested', will_apply: 'Will apply', other: '' };
const SOURCE_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

function words(v, label, max, kind = 'text') {
    const t = str(v, max);
    const bad = textProblem(t, label, kind);
    if (bad) refuse(bad, 400);
    return t;
}
const sourceOf = (v) => {
    const t = String(v || '').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40);
    return SOURCE_RE.test(t) ? t : '';
};

async function staffOf(schoolId, id) {
    if (!id) return null;
    if (!isId(String(id))) refuse('Choose a member of staff');
    const { rows: [u] } = await pool.query(`SELECT "_id", "name" FROM "users" WHERE "_id" = $1 AND "school" = $2 AND "role" = ANY('{school_admin,teacher}'::text[]) AND "isActive"`, [String(id), String(schoolId)]);
    if (!u) refuse('Choose an active member of staff', 400);
    return u;
}

// ── The list ─────────────────────────────────────────────────────────────────

async function list(req, q = {}) {
    const params = [String(req.schoolId)];
    const where = ['e."school" = $1'];
    const add = (sql, v) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (STATUSES.includes(q.status)) add('e."status" = ?', q.status);
    if (q.open === '1') where.push(`e."status" IN ('new', 'contacted')`);
    if (q.q) add(`(lower(e."name") LIKE ? OR lower(e."email") LIKE ? OR e."phone" LIKE ?)`, `%${String(q.q).toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    if (q.assignedTo === 'me') add('e."assignedTo" = ?', String(req.userId));
    else if (q.assignedTo === 'none') where.push('e."assignedTo" IS NULL');
    else if (q.assignedTo && isId(String(q.assignedTo))) add('e."assignedTo" = ?', String(q.assignedTo));
    if (q.due === 'today') where.push(`e."nextFollowUpAt" < (date_trunc('day', now()) + interval '1 day') AND e."status" IN ('new', 'contacted')`);
    if (q.due === 'overdue') where.push(`e."nextFollowUpAt" < now() AND e."status" IN ('new', 'contacted')`);
    if (PRIORITIES.includes(q.priority)) add('e."priority" = ?', q.priority);
    if (q.source) add('e."source" = ?', sourceOf(q.source));
    const limit = Math.min(100, Number(q.limit) || 25);
    const offset = (Math.max(1, Number(q.page) || 1) - 1) * limit;
    const order = q.due ? 'e."nextFollowUpAt" ASC NULLS LAST' : 'e."createdAt" DESC';
    const [{ rows }, { rows: [c] }, { rows: counts }, { rows: [due] }] = await Promise.all([
        pool.query(`SELECT e.*, c."className", u."name" AS "assigneeName" FROM "admissionenquiries" e LEFT JOIN "classes" c ON c."_id" = e."class" LEFT JOIN "users" u ON u."_id" = e."assignedTo"
                     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params),
        pool.query(`SELECT COUNT(*)::int AS n FROM "admissionenquiries" e WHERE ${where.join(' AND ')}`, params),
        pool.query(`SELECT "status", COUNT(*)::int AS n FROM "admissionenquiries" WHERE "school" = $1 GROUP BY 1`, [String(req.schoolId)]),
        pool.query(`SELECT COUNT(*) FILTER (WHERE "nextFollowUpAt" < now())::int AS overdue,
                           COUNT(*) FILTER (WHERE "nextFollowUpAt" < date_trunc('day', now()) + interval '1 day')::int AS today,
                           COUNT(*) FILTER (WHERE "assignedTo" = $2)::int AS mine
                      FROM "admissionenquiries" WHERE "school" = $1 AND "status" IN ('new', 'contacted')`, [String(req.schoolId), String(req.userId)]),
    ]);
    return { rows, total: c.n, counts: Object.fromEntries(counts.map((x) => [x.status, x.n])), due };
}

// ── Writing one down, working it ─────────────────────────────────────────────

/** An enquiry the office writes down — a walk-in, a phone call. */
async function create(req, b = {}) {
    const name = str(b.name, 100);
    const badName = name ? nameProblem(name, 'Name') : 'The name is required';
    if (badName) refuse(badName, 400, { field: 'name' });
    const email = str(b.email, 200).toLowerCase();
    const phone = normalizePhone(str(b.phone, 20));
    if (!email && !phone) refuse('Give an email or a mobile number', 400, { field: 'email' });
    if (email && !isEmail(email)) refuse('Enter a valid email address', 400, { field: 'email' });
    if (phone && !isPhone(phone)) refuse('Enter a valid 10-digit mobile number', 400, { field: 'phone' });
    let classId = null;
    if (b.class) {
        if (!isId(String(b.class))) refuse('Choose a class of the school');
        const { rows } = await pool.query(`SELECT "_id" FROM "classes" WHERE "_id" = $1 AND "school" = $2`, [String(b.class), String(req.schoolId)]);
        if (!rows[0]) refuse('Choose a class of the school');
        classId = rows[0]._id;
    }
    const assignee = await staffOf(req.schoolId, b.assignedTo || req.userId);
    const { sql, params } = buildInsert(AdmissionEnquiry, {
        school: req.schoolId, name, email, phone, class: classId, message: words(b.message, 'What they asked', 1000),
        source: sourceOf(b.source) || 'walk_in', status: 'contacted', priority: PRIORITIES.includes(b.priority) ? b.priority : 'warm',
        assignedTo: assignee?._id || null, nextFollowUpAt: date(b.nextFollowUpAt), createdBy: req.userId, handledBy: req.userId,
        interactions: [{ kind: KINDS[b.kind] ? b.kind : 'visit', outcome: 'reached', text: 'Enquiry taken by the office', by: String(req.userId), byName: req.user?.name || '', at: new Date() }],
    });
    const { rows: [row] } = await pool.query(sql, params);
    events.recordQuietly(req.schoolId, { by: req, type: 'enquiry', action: 'created', message: `Enquiry from ${name} written down (${row.source})` });
    return row;
}

/** Status, owner, priority, next follow-up, why it was lost. */
async function update(req, id, b = {}) {
    if (!isId(String(id || ''))) refuse('Enquiry not found', 404);
    const { rows: [row] } = await pool.query(`SELECT * FROM "admissionenquiries" WHERE "_id" = $1 AND "school" = $2`, [String(id), String(req.schoolId)]);
    if (!row) refuse('Enquiry not found', 404);
    const set = { handledBy: req.userId };
    if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) refuse('Unknown status');
        set.status = b.status;
        if (b.status === 'closed') {
            set.lostReason = words(b.lostReason ?? row.lostReason, 'Why it was closed', 300);
            set.nextFollowUpAt = null;
        }
    }
    if (b.priority !== undefined) {
        if (!PRIORITIES.includes(b.priority)) refuse('Choose hot, warm or cold');
        set.priority = b.priority;
    }
    if (b.assignedTo !== undefined) set.assignedTo = (await staffOf(req.schoolId, b.assignedTo || null))?._id || null;
    if (b.nextFollowUpAt !== undefined) {
        set.nextFollowUpAt = b.nextFollowUpAt ? date(b.nextFollowUpAt) : null;
        if (b.nextFollowUpAt && !set.nextFollowUpAt) refuse('Choose a date for the follow-up', 400, { field: 'nextFollowUpAt' });
        set.followUpRemindedAt = null;
    }
    if (b.source !== undefined) set.source = sourceOf(b.source);
    const keys = Object.keys(set);
    const note = words(b.note, 'Note', 500);
    const { rows: [out] } = await pool.query(
        `UPDATE "admissionenquiries" SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')}${note ? `, "notes" = COALESCE("notes", '[]'::jsonb) || $${keys.length + 2}::jsonb` : ''}, "updatedAt" = now()
          WHERE "_id" = $1 RETURNING *`,
        [row._id, ...keys.map((k) => set[k]), ...(note ? [JSON.stringify([{ text: note, by: String(req.userId), byName: req.user?.name || '', at: new Date() }])] : [])]);
    return out;
}

/** A call, an email, a visit — what happened, and when to follow up next. */
async function logInteraction(req, id, b = {}) {
    if (!isId(String(id || ''))) refuse('Enquiry not found', 404);
    const kind = KINDS[b.kind] ? b.kind : null;
    if (!kind) refuse('Choose what kind of contact it was');
    const outcome = Object.prototype.hasOwnProperty.call(OUTCOMES, b.outcome) ? b.outcome : 'other';
    const text = words(b.text, 'What was said', 1000);
    if (!text && outcome === 'other') refuse('Say what happened', 400, { field: 'text' });
    const next = b.nextFollowUpAt ? date(b.nextFollowUpAt) : null;
    if (b.nextFollowUpAt && !next) refuse('Choose a date for the follow-up', 400, { field: 'nextFollowUpAt' });
    const entry = { kind, outcome, text, by: String(req.userId), byName: req.user?.name || '', at: new Date() };
    const { rows: [row] } = await pool.query(
        `UPDATE "admissionenquiries" SET "interactions" = COALESCE("interactions", '[]'::jsonb) || $3::jsonb,
                "status" = CASE WHEN "status" = 'new' AND $4 <> 'note' THEN 'contacted' ELSE "status" END,
                "nextFollowUpAt" = $5, "followUpRemindedAt" = NULL, "handledBy" = $6,
                "assignedTo" = COALESCE("assignedTo", $6), "updatedAt" = now()
          WHERE "_id" = $1 AND "school" = $2 RETURNING *`,
        [String(id), String(req.schoolId), JSON.stringify([entry]), kind, next, String(req.userId)]);
    if (!row) refuse('Enquiry not found', 404);
    return row;
}

/** A new applicant account with an open enquiry's email or mobile: the two are linked. */
async function linkRegistration(schoolId, user) {
    const email = String(user?.email || '').toLowerCase();
    const phone = normalizePhone(String(user?.phone || ''));
    if (!email && !phone) return 0;
    const { rowCount } = await pool.query(
        `UPDATE "admissionenquiries" SET "status" = 'registered', "applicant" = $4, "nextFollowUpAt" = NULL, "updatedAt" = now(),
                "interactions" = COALESCE("interactions", '[]'::jsonb) || jsonb_build_array(jsonb_build_object('kind', 'note', 'outcome', 'other', 'text', 'Registered on the admission portal', 'byName', 'System', 'at', now()))
          WHERE "school" = $1 AND "status" IN ('new', 'contacted') AND "applicant" IS NULL
            AND (("email" <> '' AND "email" = $2) OR ("phone" <> '' AND "phone" = $3))`,
        [String(schoolId), email, phone, String(user._id)]);
    return rowCount;
}

/** The sweep: an owner hears once when a follow-up falls due. */
async function followUpReminders(schoolId) {
    const { rows } = await pool.query(
        `UPDATE "admissionenquiries" SET "followUpRemindedAt" = now()
          WHERE "school" = $1 AND "status" IN ('new', 'contacted') AND "assignedTo" IS NOT NULL AND "nextFollowUpAt" IS NOT NULL
            AND "nextFollowUpAt" <= now() AND "followUpRemindedAt" IS NULL
          RETURNING "_id", "name", "assignedTo", "nextFollowUpAt"`, [String(schoolId)]);
    const byOwner = new Map();
    for (const r of rows) { if (!byOwner.has(String(r.assignedTo))) byOwner.set(String(r.assignedTo), []); byOwner.get(String(r.assignedTo)).push(r); }
    for (const [owner, list] of byOwner) {
        require('../notifyService').notify({
            school: schoolId, sender: owner, senderRole: 'system', recipients: [owner], includeSender: true,
            title: list.length === 1 ? `Follow up the enquiry from ${list[0].name}` : `${list.length} enquiries to follow up`,
            body: list.slice(0, 5).map((r) => r.name).join(', '), link: { type: 'admission.enquiries' },
        });
    }
    return rows.length;
}

// ── Sources: what was spent, what it brought ─────────────────────────────────

async function sources(schoolId, yearId = null) {
    const s = String(schoolId);
    const y = yearId && isId(String(yearId)) ? String(yearId) : null;
    const yearApps = y ? 'AND a."academicYear" = $2' : '';
    const yearRange = y ? `AND e."createdAt" >= (SELECT "startDate" FROM "academicyears" WHERE "_id" = $2) - interval '12 months'
                           AND e."createdAt" < (SELECT "endDate" FROM "academicyears" WHERE "_id" = $2)` : '';
    const params = y ? [s, y] : [s];
    const [{ rows: enq }, { rows: apps }, { rows: spend }] = await Promise.all([
        pool.query(`SELECT COALESCE(NULLIF(e."source", ''), 'unknown') AS source, COUNT(*)::int AS enquiries,
                           COUNT(*) FILTER (WHERE e."status" = 'registered')::int AS registered
                      FROM "admissionenquiries" e WHERE e."school" = $1 ${yearRange} GROUP BY 1`, params),
        pool.query(`SELECT COALESCE(NULLIF(lower(a."source"), ''), 'unknown') AS source,
                           COUNT(*) FILTER (WHERE a."submittedAt" IS NOT NULL)::int AS applications,
                           COUNT(*) FILTER (WHERE a."status" IN ('confirmed', 'enrolled'))::int AS admissions
                      FROM "admissionapplications" a WHERE a."school" = $1 ${yearApps} GROUP BY 1`, params),
        pool.query(`SELECT "source", "label", "amount", "note" FROM "admissionsourcespends" WHERE "school" = $1 AND ${y ? '"academicYear" = $2' : '"academicYear" IS NULL'}`, params),
    ]);
    const map = new Map();
    const row = (k) => { if (!map.has(k)) map.set(k, { source: k, label: '', enquiries: 0, registered: 0, applications: 0, admissions: 0, spend: 0, note: '' }); return map.get(k); };
    for (const r of enq) Object.assign(row(r.source), { enquiries: r.enquiries, registered: r.registered });
    for (const r of apps) Object.assign(row(r.source), { applications: r.applications, admissions: r.admissions });
    for (const r of spend) Object.assign(row(r.source), { label: r.label, spend: Number(r.amount) || 0, note: r.note });
    const out = [...map.values()].map((r) => ({
        ...r,
        costPerApplication: r.spend && r.applications ? round2(r.spend / r.applications) : null,
        costPerAdmission: r.spend && r.admissions ? round2(r.spend / r.admissions) : null,
        conversion: r.applications ? round2((r.admissions / r.applications) * 100) : null,
    })).sort((a, b) => b.admissions - a.admissions || b.applications - a.applications || b.enquiries - a.enquiries);
    const total = out.reduce((t, r) => ({ enquiries: t.enquiries + r.enquiries, applications: t.applications + r.applications, admissions: t.admissions + r.admissions, spend: round2(t.spend + r.spend) }), { enquiries: 0, applications: 0, admissions: 0, spend: 0 });
    return { rows: out, total: { ...total, costPerAdmission: total.spend && total.admissions ? round2(total.spend / total.admissions) : null } };
}

/** What was spent on one source, for one year (or overall). */
async function setSpend(req, b = {}) {
    const source = sourceOf(b.source);
    if (!source) refuse('Name the source in lower-case letters, numbers, - _ or . (e.g. newspaper, facebook, walk_in)', 400, { field: 'source' });
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) refuse('Enter the amount spent', 400, { field: 'amount' });
    const y = b.academicYear && isId(String(b.academicYear)) ? String(b.academicYear) : null;
    if (y) {
        const { rows } = await pool.query(`SELECT 1 FROM "academicyears" WHERE "_id" = $1 AND "school" = $2`, [y, String(req.schoolId)]);
        if (!rows[0]) refuse('Choose an academic year of the school');
    }
    const label = words(b.label, 'Name', 80, 'title');
    const note = words(b.note, 'Note', 300);
    return withTransaction(async (q) => {
        await lock(q, `admission-spend:${req.schoolId}:${y || 'all'}:${source}`);
        const { rows: [cur] } = await q(`SELECT "_id" FROM "admissionsourcespends" WHERE "school" = $1 AND "source" = $2 AND "academicYear" IS NOT DISTINCT FROM $3::uuid`, [String(req.schoolId), source, y]);
        if (cur) {
            const { rows: [r] } = await q(`UPDATE "admissionsourcespends" SET "amount" = $2, "label" = $3, "note" = $4, "updatedBy" = $5, "updatedAt" = now() WHERE "_id" = $1 RETURNING *`, [cur._id, round2(amount), label, note, req.userId]);
            return r;
        }
        const { sql, params } = buildInsert(AdmissionSourceSpend, { school: req.schoolId, academicYear: y, source, label, amount: round2(amount), note, updatedBy: req.userId });
        return (await q(sql, params)).rows[0];
    });
}

module.exports = { list, create, update, logInteraction, linkRegistration, followUpReminders, sources, setSpend, KINDS, OUTCOMES, sourceOf };
