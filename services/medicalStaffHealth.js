'use strict';
/**
 * Staff as patients (Oct 2026).
 *
 * The record — allergies, conditions, medicines, the person to call — is the
 * staff member's own: they can keep it up to date from their portal, and the
 * medical staff read it when they help them. A visit to the Medical Room by a
 * member of staff is a MedicalStaffVisit, kept apart from every student's
 * record; a medicine given comes out of the same stock (the ledger names the
 * visit), and is stopped when it clashes with an allergy on their record
 * unless a reason is given.
 */
const pool = require('../db/pool');
const { withTransaction } = require('../db/pool');
const { patch, insert } = require('../db/patch');
const { newId } = require('../db/schema');
const MedicalStaffHealth = require('../models/MedicalStaffHealth');
const MedicalStaffVisit = require('../models/MedicalStaffVisit');
const numbers = require('./medicalNumber');
const stock = require('./medicalStock');
const meds = require('./medicalMeds');
const safety = require('./medicalSafety');
const settingsSvc = require('./medicalSettings');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const R = require('./medicalRules');

const { refuse, notFound, str, num, oneOf, isUuid, toInstant } = R;
const S = (v) => String(v);
const who = (req) => req.user?.name || '';
const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);

const SEVERITY = { mild: 'Mild', moderate: 'Moderate', severe: 'Severe', life_threatening: 'Life-threatening' };
const OUTCOME = { in_room: 'In the room', back_to_work: 'Back to work', went_home: 'Went home', referred: 'Referred to hospital' };

/** A member of the school's staff (a teacher or an admin of this school). */
async function staffMember(schoolId, id) {
    if (!isUuid(id)) notFound('Staff member');
    const [u] = await run(
        `SELECT u."_id"::text AS "_id", u."name", u."role", u."phone", u."profileImage" AS "photo", tp."designation"
           FROM "users" u LEFT JOIN "teacherprofiles" tp ON tp."user" = u."_id"
          WHERE u."_id" = $1 AND u."school" = $2 AND u."role" IN ('teacher','school_admin')`,
        [S(id), S(schoolId)],
    );
    if (!u) notFound('Staff member');
    return u;
}

async function searchStaff(schoolId, q = '') {
    const term = str(q, 60);
    return run(
        `SELECT u."_id"::text AS "_id", u."name", u."role", u."profileImage" AS "photo", tp."designation"
           FROM "users" u LEFT JOIN "teacherprofiles" tp ON tp."user" = u."_id"
          WHERE u."school" = $1 AND u."role" IN ('teacher','school_admin') AND u."isActive" IS NOT FALSE
            AND ($2 = '' OR u."name" ILIKE '%' || $2 || '%' OR tp."designation" ILIKE '%' || $2 || '%')
          ORDER BY u."name" LIMIT 20`,
        [S(schoolId), term],
    );
}

/* ── The record ───────────────────────────────────────────────────────────── */

const EMPTY = { bloodGroup: '', allergies: [], conditions: [], medications: '', emergencyContact: {}, doctor: {}, notes: '' };

async function healthOf(schoolId, staffId) {
    const row = await MedicalStaffHealth.findOne({ school: schoolId, staff: staffId }).lean();
    return row || { ...EMPTY, staff: S(staffId), _id: null };
}

function healthFields(body) {
    const out = {};
    if (body.bloodGroup !== undefined) {
        const bg = str(body.bloodGroup, 8);
        if (bg && !R.BLOOD_GROUPS.includes(bg)) refuse('Choose a blood group from the list');
        out.bloodGroup = bg;
    }
    if (body.allergies !== undefined) {
        if (!Array.isArray(body.allergies) || body.allergies.length > 30) refuse('Allergies must be a list of at most 30');
        out.allergies = body.allergies.map((a) => ({
            allergen: str(a?.allergen, 80), severity: oneOf(a?.severity, SEVERITY, 'moderate'), reaction: str(a?.reaction, 200),
        })).filter((a) => a.allergen);
    }
    if (body.conditions !== undefined) {
        if (!Array.isArray(body.conditions) || body.conditions.length > 30) refuse('Conditions must be a list of at most 30');
        out.conditions = body.conditions.map((c) => ({ condition: str(c?.condition, 120), notes: str(c?.notes, 300) })).filter((c) => c.condition);
    }
    if (body.medications !== undefined) out.medications = str(body.medications, 600);
    if (body.emergencyContact !== undefined) {
        const e = body.emergencyContact || {};
        out.emergencyContact = { name: str(e.name, 120), relation: str(e.relation, 60), phone: str(e.phone, 30) };
    }
    if (body.doctor !== undefined) {
        const d = body.doctor || {};
        out.doctor = { name: str(d.name, 120), phone: str(d.phone, 30) };
    }
    if (body.notes !== undefined) out.notes = str(body.notes, 600);
    return out;
}

/** Save the record — by the person themselves (`self`) or by the medical staff. */
async function saveHealth(req, staffId, body = {}, { self = false } = {}) {
    const member = await staffMember(req.schoolId, staffId);
    const set = healthFields(body);
    if (!Object.keys(set).length) refuse('Nothing to save');
    const before = await MedicalStaffHealth.findOne({ school: req.schoolId, staff: member._id }).lean();
    let row;
    if (before) row = await patch(MedicalStaffHealth, before._id, { ...set, updatedBy: req.userId, updatedByName: who(req) }, { where: { school: req.schoolId } });
    else row = await insert(MedicalStaffHealth, { school: req.schoolId, staff: member._id, ...EMPTY, ...set, updatedBy: req.userId, updatedByName: who(req) });
    audit.log(req, {
        action: before ? 'updated' : 'created', entity: 'staff_health', entityId: row._id,
        summary: `${self ? `${member.name} updated their own` : `${who(req)} updated ${member.name}'s`} staff health record`,
        changes: audit.diff(before || {}, set, Object.keys(set)),
    });
    return typeof row.toObject === 'function' ? row.toObject() : row;
}

/* ── Visits ───────────────────────────────────────────────────────────────── */

async function findVisit(req, id) {
    if (!isUuid(id)) notFound('Staff visit');
    const v = await MedicalStaffVisit.findOne({ _id: id, school: req.schoolId }).lean();
    if (!v) notFound('Staff visit');
    return v;
}

/**
 * Medicines for a member of staff: lines [{ item, quantity, dosage }], checked
 * against their allergies; a clash stops unless `override.reason` is given.
 */
async function takeMedicines(req, visitId, staffId, lines, q, override) {
    const out = [];
    const health = await healthOf(req.schoolId, staffId);
    const overrides = [];
    for (const line of Array.isArray(lines) ? lines : []) {
        if (!line?.item) continue;
        const quantity = num(line.quantity);
        if (!quantity || quantity <= 0) refuse('Give how much of the medicine was given');
        const item = await meds.findItem(req.schoolId, line.item);
        if (item.kind !== 'medicine') refuse(`${item.name} is a supply, not a medicine`);
        const dosage = str(line.dosage, 120);
        if (!dosage) refuse(`Give the dose of ${item.name}`);
        const { blocks } = safety.allergyProblems((health.allergies || []).map((a) => ({ ...a, category: 'medicine' })), safety.describe({ item }));
        if (blocks.length) {
            const reason = str(override?.reason, 300);
            if (!reason) refuse(blocks[0].message, 409, 'MEDICAL_SAFETY', { problems: blocks, warnings: [] });
            overrides.push({ item: item.name, problems: blocks.map((b) => b.message), reason, by: S(req.userId), byName: who(req), at: new Date() });
        }
        const taken = await stock.consume(req, { item: item._id, quantity, type: 'administered', reason: 'Given to a member of staff', refKind: 'staff_visit', refId: visitId }, q);
        out.push({ item: S(item._id), name: item.name, dosage, quantity, unit: item.unit, batches: taken.batches, at: new Date() });
    }
    return { given: out, overrides };
}

async function addVisit(req, body = {}) {
    const member = await staffMember(req.schoolId, body.staff);
    const reason = str(body.reason, 200);
    if (!reason) refuse('Give the reason for the visit');
    const arrivedAt = toInstant(body.arrivedAt) || new Date();
    if (arrivedAt > new Date(Date.now() + 5 * 60000)) refuse('The arrival time is in the future');
    const settings = await settingsSvc.get(req.schoolId);
    const reading = require('./medicalVitals').readingOf(body.vitals, settings.temperatureUnit);
    const outcome = oneOf(body.outcome, OUTCOME, 'in_room');
    const id = newId();
    let overrides = [];
    const row = await withTransaction(async (q) => {
        const number = await numbers.next(req.schoolId, 'staff_visit', q);
        const meds0 = await takeMedicines(req, id, member._id, body.medicines, q, body.override);
        overrides = meds0.overrides;
        return insert(MedicalStaffVisit, {
            _id: id, school: req.schoolId, number, staff: member._id, arrivedAt, reason, symptoms: str(body.symptoms, 600),
            vitals: reading ? { ...reading, flags: R.vitalFlags(reading) } : {}, treatment: str(body.treatment, 1500), medicines: meds0.given,
            outcome, outcomeNote: str(body.outcomeNote, 300), privateNotes: str(body.privateNotes, 2000),
            handledBy: req.userId, handledByName: who(req), departedAt: outcome === 'in_room' ? null : new Date(), createdBy: req.userId,
        }, { q });
    });
    audit.log(req, { action: 'created', entity: 'staff_visit', entityId: id, summary: `${row.number}: ${member.name} — ${reason}${row.medicines.length ? ` · given ${row.medicines.map((m) => m.name).join(', ')}` : ''}` });
    for (const o of overrides) {
        audit.log(req, { action: 'safety_override', entity: 'staff_visit', entityId: id, summary: `${o.item} given to ${member.name} despite: ${o.problems.join('; ')} — ${o.reason}` });
    }
    if (overrides.length) {
        tell.toStaff(req, { title: `Allergy override — ${member.name}`, body: `${who(req)} gave ${overrides.map((o) => o.item).join(', ')} despite an allergy on record: ${overrides[0].reason}`, urgent: true, link: { type: 'medical.room' } });
    }
    return typeof row.toObject === 'function' ? row.toObject() : row;
}

async function updateVisit(req, id, body = {}) {
    const v = await findVisit(req, id);
    if (v.archivedAt) refuse('This visit is archived');
    const set = {};
    for (const k of ['symptoms', 'treatment', 'outcomeNote']) if (body[k] !== undefined) set[k] = str(body[k], k === 'treatment' ? 1500 : 600);
    if (body.privateNotes !== undefined) set.privateNotes = str(body.privateNotes, 2000);
    if (body.outcome !== undefined) {
        set.outcome = oneOf(body.outcome, OUTCOME, v.outcome);
        set.departedAt = set.outcome === 'in_room' ? null : (v.departedAt || new Date());
    }
    if (body.vitals !== undefined) {
        const settings = await settingsSvc.get(req.schoolId);
        const reading = require('./medicalVitals').readingOf(body.vitals, settings.temperatureUnit);
        if (reading) set.vitals = { ...reading, flags: R.vitalFlags(reading) };
    }
    const hasMeds = Array.isArray(body.medicines) && body.medicines.some((m) => m?.item);
    let overrides = [];
    const row = await withTransaction(async (q) => {
        if (hasMeds) {
            const m = await takeMedicines(req, id, v.staff, body.medicines, q, body.override);
            overrides = m.overrides;
            set.medicines = [...(v.medicines || []), ...m.given];
        }
        if (!Object.keys(set).length) return v;
        return patch(MedicalStaffVisit, id, set, { where: { school: req.schoolId }, q });
    });
    const changes = audit.diff(v, set, Object.keys(set).filter((k) => k !== 'medicines'));
    if (changes.length || hasMeds) audit.log(req, { action: 'updated', entity: 'staff_visit', entityId: id, summary: `Updated ${v.number}${hasMeds ? ' — medicine given' : ''}`, changes });
    for (const o of overrides) audit.log(req, { action: 'safety_override', entity: 'staff_visit', entityId: id, summary: `${o.item} given despite: ${o.problems.join('; ')} — ${o.reason}` });
    return row;
}

async function archiveVisit(req, id, body = {}) {
    const v = await findVisit(req, id);
    if (v.archivedAt) refuse('Already archived');
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say why the visit is archived');
    const row = await patch(MedicalStaffVisit, id, { archivedAt: new Date(), archivedBy: req.userId, archiveReason: reason }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'archived', entity: 'staff_visit', entityId: id, summary: `${v.number} archived — ${reason}` });
    return row;
}

/** One member of staff, for the medical staff: the record and every visit. */
async function staffCard(req, staffId) {
    const member = await staffMember(req.schoolId, staffId);
    const [health, visits] = await Promise.all([
        healthOf(req.schoolId, member._id),
        run(`SELECT * FROM "medicalstaffvisits" WHERE "school" = $1 AND "staff" = $2 ORDER BY "arrivedAt" DESC LIMIT 50`, [S(req.schoolId), member._id]),
    ]);
    return { staff: member, health, visits };
}

/** The member of staff's own view: their record and their visits, without the private notes. */
async function mine(req) {
    const member = await staffMember(req.schoolId, req.userId);
    const [health, visits] = await Promise.all([
        healthOf(req.schoolId, member._id),
        run(`SELECT "_id"::text AS "_id", "number", "arrivedAt", "reason", "treatment", "medicines", "outcome", "outcomeNote", "departedAt", "handledByName"
               FROM "medicalstaffvisits" WHERE "school" = $1 AND "staff" = $2 AND "archivedAt" IS NULL ORDER BY "arrivedAt" DESC LIMIT 30`, [S(req.schoolId), member._id]),
    ]);
    return { staff: { _id: member._id, name: member.name }, health, visits: visits.map((x) => ({ ...x, outcomeLabel: OUTCOME[x.outcome] })) };
}

/** The staff visits list: today | in the room | all, with a name search. */
async function board(req, f = {}) {
    const p = [S(req.schoolId)];
    const where = ['v."school" = $1', f.archived === '1' ? 'v."archivedAt" IS NOT NULL' : 'v."archivedAt" IS NULL'];
    const tab = ['today', 'in_room', 'all'].includes(f.tab) ? f.tab : 'today';
    if (tab === 'today') where.push(`(v."arrivedAt" AT TIME ZONE '${R.ZONE}')::date = (now() AT TIME ZONE '${R.ZONE}')::date`);
    if (tab === 'in_room') where.push(`v."outcome" = 'in_room'`);
    const q = str(f.q, 60);
    if (q) { p.push(q); where.push(`(u."name" ILIKE '%' || $${p.length} || '%' OR v."reason" ILIKE '%' || $${p.length} || '%' OR v."number" ILIKE '%' || $${p.length} || '%')`); }
    const limit = Math.min(Math.max(Number(f.limit) || 20, 1), 100);
    const page = Math.max(Number(f.page) || 1, 1);
    const rows = await run(
        `SELECT v."_id"::text AS "_id", v."number", v."arrivedAt", v."reason", v."outcome", v."medicines", v."handledByName", v."archivedAt",
                u."_id"::text AS "staffId", u."name" AS "staffName", u."profileImage" AS "staffPhoto", tp."designation", count(*) OVER() AS total
           FROM "medicalstaffvisits" v JOIN "users" u ON u."_id" = v."staff" LEFT JOIN "teacherprofiles" tp ON tp."user" = u."_id"
          WHERE ${where.join(' AND ')} ORDER BY v."arrivedAt" DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        p,
    );
    const total = Number(rows[0]?.total || 0);
    return { rows: rows.map(({ total: _t, ...r }) => ({ ...r, outcomeLabel: OUTCOME[r.outcome] })), total, page, pages: Math.max(1, Math.ceil(total / limit)), limit, tab };
}

module.exports = { SEVERITY, OUTCOME, searchStaff, staffMember, healthOf, saveHealth, findVisit, addVisit, updateVisit, archiveVisit, staffCard, mine, board };
