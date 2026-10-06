'use strict';
/**
 * Safeguarding concerns (Oct 2026) — see models/MedicalSafeguardingConcern.
 *
 *   raise    any member of staff: what they saw or were told, in the words
 *            used, and what they did. The leads are told that a concern was
 *            raised — never who it is about, in a notification that can show
 *            on a locked phone.
 *   mine     what the person who raised it may see: that it is being dealt with
 *   log      the leads: every concern, its notes, its referral, its status
 *
 * The leads are settings.safeguardingLeads; when the school has named none,
 * its admins. Only a school admin names them (the Medical Room settings refuse
 * anyone else). Every reading by a lead is in the medical audit trail.
 */
const pool = require('../db/pool');
const { patch, insert } = require('../db/patch');
const MedicalSafeguardingConcern = require('../models/MedicalSafeguardingConcern');
const numbers = require('./medicalNumber');
const settingsSvc = require('./medicalSettings');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const R = require('./medicalRules');

const { refuse, notFound, str, oneOf, bool, isUuid, toInstant } = R;
const S = (v) => String(v);
const who = (req) => req.user?.name || '';
const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);

const CATEGORY = {
    physical: 'Physical harm', emotional: 'Emotional harm', sexual: 'Sexual abuse', neglect: 'Neglect', bullying: 'Bullying',
    online: 'Online safety', self_harm: 'Self-harm', disclosure: 'A child told me something', other: 'Other',
};
const STATUS = { open: 'Open', monitoring: 'Being watched', referred: 'Referred', closed: 'Closed' };
const REFER_TO = { police: 'Police', cwc: 'Child Welfare Committee', childline: 'Childline (1098)', doctor: 'A doctor / hospital', other: 'Other' };

/** The leads: the named ones who are still active staff, else the school's admins. */
async function leadsOf(schoolId) {
    const s = await settingsSvc.get(schoolId);
    const named = (s.safeguardingLeads || []).filter(isUuid);
    if (named.length) {
        const rows = await run(`SELECT "_id"::text AS "_id", "name" FROM "users" WHERE "_id" = ANY($1::uuid[]) AND "school" = $2 AND "isActive" IS NOT FALSE AND "role" IN ('teacher','school_admin')`, [named, S(schoolId)]);
        if (rows.length) return { named: true, people: rows };
    }
    const rows = await run(`SELECT "_id"::text AS "_id", "name" FROM "users" WHERE "school" = $1 AND "role" = 'school_admin' AND "isActive" IS NOT FALSE`, [S(schoolId)]);
    return { named: false, people: rows };
}

const isStaff = (req) => ['teacher', 'school_admin'].includes(req.userRole);

async function isLead(req) {
    const { people } = await leadsOf(req.schoolId);
    return people.some((p) => p._id === S(req.userId));
}

async function mustLead(req) {
    if (!(await isLead(req))) notFound('Concern');
}

async function me(req) {
    if (!isStaff(req)) refuse('Only school staff raise safeguarding concerns', 403, 'MEDICAL_STAFF_ONLY');
    const leads = await leadsOf(req.schoolId);
    const { REGIONS, INJURY_KIND } = require('./medicalVitals');
    return {
        isLead: leads.people.some((p) => p._id === S(req.userId)), leads: leads.people.map((p) => p.name), named: leads.named,
        categories: CATEGORY, statuses: STATUS, referTo: REFER_TO, regions: REGIONS, injuryKinds: INJURY_KIND,
    };
}

async function raise(req, body = {}) {
    if (!isStaff(req)) refuse('Only school staff raise safeguarding concerns', 403, 'MEDICAL_STAFF_ONLY');
    const student = await access.assertStudent(req.schoolId, body.student);
    const description = str(body.description, 4000);
    if (description.length < 15) refuse('Write down what you saw or were told, in the words used');
    const observedAt = toInstant(body.observedAt) || new Date();
    if (observedAt > new Date(Date.now() + 5 * 60000)) refuse('That time is in the future');
    const injuries = Array.isArray(body.injuries) && body.injuries.length ? require('./medicalVitals').injuriesOf(body.injuries) : [];
    const number = await numbers.next(req.schoolId, 'safeguarding');
    const row = await insert(MedicalSafeguardingConcern, {
        school: req.schoolId, number, student: student._id, category: oneOf(body.category, CATEGORY, 'other'), urgent: bool(body.urgent),
        description, observedAt, location: str(body.location, 200), injuries, actionTaken: str(body.actionTaken, 1500),
        raisedBy: req.userId, raisedByName: who(req), raisedAt: new Date(), status: 'open', notes: [],
    });
    // The trail says that a concern exists and who raised it — not what it says.
    audit.log(req, { action: 'concern_raised', entity: 'safeguarding', entityId: row._id, summary: `${number}: a safeguarding concern was raised` });
    const leads = await leadsOf(req.schoolId);
    const to = leads.people.map((p) => p._id).filter((id) => id !== S(req.userId));
    if (to.length) {
        tell.send(req, {
            to, priority: bool(body.urgent) ? 'high' : null, link: { type: 'medical.safeguarding' },
            title: bool(body.urgent) ? 'Urgent safeguarding concern' : 'New safeguarding concern',
            body: `A member of staff raised a safeguarding concern (${number}). Open the safeguarding log to read it.`,
        });
    }
    return { _id: S(row._id), number, status: 'open', leads: leads.people.map((p) => p.name), named: leads.named };
}

async function mine(req) {
    if (!isStaff(req)) return [];
    return run(
        `SELECT c."_id"::text AS "_id", c."number", c."category", c."raisedAt", c."status", u."name" AS "studentName"
           FROM "medicalsafeguardingconcerns" c JOIN "users" u ON u."_id" = c."student"
          WHERE c."school" = $1 AND c."raisedBy" = $2 ORDER BY c."raisedAt" DESC LIMIT 50`,
        [S(req.schoolId), S(req.userId)],
    ).then((rows) => rows.map((r) => ({ ...r, categoryLabel: CATEGORY[r.category], statusLabel: STATUS[r.status] })));
}

async function log(req, { status = 'active' } = {}) {
    await mustLead(req);
    const st = ['open', 'monitoring', 'referred', 'closed', 'all', 'active'].includes(status) ? status : 'active';
    const where = st === 'all' ? '' : st === 'active' ? `AND c."status" <> 'closed'` : `AND c."status" = '${st}'`;
    const rows = await run(
        `SELECT c."_id"::text AS "_id", c."number", c."category", c."urgent", c."raisedAt", c."raisedByName", c."status", c."student"::text AS "student",
                u."name" AS "studentName", jsonb_array_length(COALESCE(c."notes", '[]'::jsonb)) AS "noteCount"
           FROM "medicalsafeguardingconcerns" c JOIN "users" u ON u."_id" = c."student"
          WHERE c."school" = $1 ${where} ORDER BY c."urgent" DESC, c."raisedAt" DESC LIMIT 200`,
        [S(req.schoolId)],
    );
    const cards = await access.studentCards(req.schoolId, rows.map((r) => r.student));
    audit.log(req, { action: 'viewed', entity: 'safeguarding', summary: `Opened the safeguarding log (${rows.length})` });
    const [counts] = await run(
        `SELECT count(*) FILTER (WHERE "status" <> 'closed')::int AS "active", count(*) FILTER (WHERE "status" = 'open')::int AS "open",
                count(*) FILTER (WHERE "status" = 'referred')::int AS "referred", count(*)::int AS "all"
           FROM "medicalsafeguardingconcerns" WHERE "school" = $1`, [S(req.schoolId)],
    );
    return { rows: rows.map((r) => ({ ...r, classLabel: cards.get(r.student)?.classLabel || '', categoryLabel: CATEGORY[r.category], statusLabel: STATUS[r.status] })), counts };
}

async function findConcern(req, id) {
    await mustLead(req);
    if (!isUuid(id)) notFound('Concern');
    const c = await MedicalSafeguardingConcern.findOne({ _id: id, school: req.schoolId }).lean();
    if (!c) notFound('Concern');
    return c;
}

async function detail(req, id) {
    const c = await findConcern(req, id);
    const card = await access.studentCard(req.schoolId, c.student);
    const others = await run(
        `SELECT "_id"::text AS "_id", "number", "category", "raisedAt", "status" FROM "medicalsafeguardingconcerns"
          WHERE "school" = $1 AND "student" = $2 AND "_id" <> $3 ORDER BY "raisedAt" DESC LIMIT 20`,
        [S(req.schoolId), S(c.student), S(id)],
    );
    audit.log(req, { action: 'viewed', entity: 'safeguarding', entityId: id, summary: `Read safeguarding concern ${c.number}` });
    return { ...c, _id: S(c._id), student: card, categoryLabel: CATEGORY[c.category], statusLabel: STATUS[c.status], earlier: others.map((o) => ({ ...o, categoryLabel: CATEGORY[o.category], statusLabel: STATUS[o.status] })) };
}

async function addNote(req, id, body = {}) {
    const c = await findConcern(req, id);
    const text = str(body.text, 3000);
    if (!text) refuse('Write the note');
    const row = await patch(MedicalSafeguardingConcern, id, {}, { push: { notes: { at: new Date(), by: S(req.userId), byName: who(req), text } }, where: { school: req.schoolId } });
    audit.log(req, { action: 'concern_note', entity: 'safeguarding', entityId: id, summary: `Note added to ${c.number}` });
    return row;
}

async function setStatus(req, id, body = {}) {
    const c = await findConcern(req, id);
    const status = oneOf(body.status, STATUS, null);
    if (!status) refuse('Choose where the concern stands');
    const set = { status };
    const note = str(body.note, 1000);
    if (status === 'referred') {
        const to = oneOf(body.referTo, REFER_TO, null);
        if (!to) refuse('Say who it was referred to');
        set.referral = { to, toLabel: REFER_TO[to], reference: str(body.reference, 120), at: new Date(), byName: who(req), note };
    }
    if (status === 'closed') {
        if (!note) refuse('Say why the concern is closed');
        set.closedAt = new Date(); set.closeReason = note;
    } else { set.closedAt = null; set.closeReason = ''; }
    const row = await patch(MedicalSafeguardingConcern, id, set, {
        push: { notes: { at: new Date(), by: S(req.userId), byName: who(req), text: `${STATUS[status]}${set.referral ? ` — ${set.referral.toLabel}${set.referral.reference ? ` (${set.referral.reference})` : ''}` : ''}${note ? `: ${note}` : ''}` } },
        where: { school: req.schoolId },
    });
    audit.log(req, { action: `concern_${status}`, entity: 'safeguarding', entityId: id, summary: `${c.number}: ${STATUS[status]}` });
    // The person who raised it hears that it is being dealt with — no more.
    if (S(c.raisedBy) !== S(req.userId) && ['referred', 'closed'].includes(status)) {
        tell.send(req, { to: [S(c.raisedBy)], title: `Your safeguarding concern ${c.number}`, body: status === 'closed' ? 'The safeguarding lead has dealt with it. Thank you for raising it.' : 'The safeguarding lead has acted on it. Thank you for raising it.', link: { type: 'medical.safeguarding' } });
    }
    return row;
}

/** Who may be named a lead: active staff of the school. */
async function cleanLeads(schoolId, list) {
    if (!Array.isArray(list)) refuse('Safeguarding leads must be a list of people');
    const ids = [...new Set(list.map(S).filter(isUuid))];
    if (ids.length > 10) refuse('Name at most 10 safeguarding leads');
    if (!ids.length) return [];
    const rows = await run(`SELECT "_id"::text AS "_id" FROM "users" WHERE "_id" = ANY($1::uuid[]) AND "school" = $2 AND "role" IN ('teacher','school_admin') AND "isActive" IS NOT FALSE`, [ids, S(schoolId)]);
    if (rows.length !== ids.length) refuse('A safeguarding lead must be a member of this school\'s staff');
    return ids;
}

module.exports = { CATEGORY, STATUS, REFER_TO, leadsOf, isLead, me, raise, mine, log, detail, addNote, setStatus, cleanLeads };
