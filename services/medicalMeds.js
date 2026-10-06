'use strict';
/**
 * Medicines, supplies and medication administration (Oct 2026).
 *
 *   items      what the room stocks — medicines and first-aid supplies
 *   batches    their deliveries, through services/medicalStock (the one writer)
 *   plans      a medicine a student takes at school, on a schedule
 *   doses      every dose: scheduled from a plan, or given as needed — and
 *              the stock it took, in the same transaction
 *
 * The connected path the brief asks for:
 *   medicine bought → receive (batch + stock_in) → dose given → consume
 *   (stock reduced, ledger row) → administration history → the sweep sees the
 *   new balance and raises low-stock / expiry alerts.
 */
const pool = require('../db/pool');
const { withTransaction } = require('../db/pool');
const { patch, insert } = require('../db/patch');
const MedicalItem = require('../models/MedicalItem');
const MedicationPlan = require('../models/MedicationPlan');
const MedicationDose = require('../models/MedicationDose');
const MedicalDocument = require('../models/MedicalDocument');
const stock = require('./medicalStock');
const audit = require('./medicalAudit');
const notifyMed = require('./medicalNotify');
const access = require('./medicalAccess');
const settingsSvc = require('./medicalSettings');
const safety = require('./medicalSafety');
const {
    refuse, notFound, str, num, bool, oneOf, clock, toDay, dayStr, todayStr, isUuid, PLAN_FREQUENCY, labelOf,
} = require('./medicalRules');

const who = (req) => req.user?.name || '';
// A notice is sent after the write and never holds it up — nor brings the server down when it fails.
const quiet = (p) => Promise.resolve(p).catch((e) => console.error('[medical] notice failed:', e.message));

/** When a plan's doses are given, for a parent: "twice a day at 09:00, 14:00" (and the times alone, for the Hindi). */
const whenEn = (plan) => (plan.frequency === 'as_needed' ? 'when needed'
    : `${String(PLAN_FREQUENCY[plan.frequency] || '').toLowerCase()}${(plan.times || []).length ? ` at ${plan.times.join(', ')}` : ''}`);
const whenHi = (plan) => (plan.frequency === 'as_needed' ? 'ज़रूरत पड़ने पर' : (plan.times || []).join(', '));
const PLAN_NEWS = {
    paused:    { title: 'Medicine paused', body: (m, n) => `The Medical Room has paused ${m} for ${n} at school` },
    cancelled: { title: 'Medicine stopped', body: (m, n) => `The Medical Room has stopped giving ${m} to ${n} at school` },
    completed: { title: 'Medicine finished', body: (m, n) => `${n}'s ${m} at school is finished` },
    active:    { title: 'Medicine started again', body: (m, n) => `The Medical Room is giving ${m} to ${n} at school again` },
};

/* ── Items ────────────────────────────────────────────────────────────────── */

function itemFields(body, kind) {
    const out = {};
    if (body.name !== undefined) out.name = str(body.name, 120);
    if (body.genericName !== undefined) out.genericName = str(body.genericName, 120);
    if (body.category !== undefined) out.category = str(body.category, 80);
    if (body.form !== undefined) out.form = str(body.form, 40);
    if (body.strength !== undefined) out.strength = str(body.strength, 40);
    if (body.unit !== undefined) out.unit = str(body.unit, 30) || (kind === 'medicine' ? 'tablet' : 'piece');
    if (body.supplier !== undefined) out.supplier = str(body.supplier, 120);
    if (body.storageLocation !== undefined) out.storageLocation = str(body.storageLocation, 120);
    if (body.minStock !== undefined) {
        const n = num(body.minStock);
        if (n === null || n < 0) refuse('Minimum stock must be zero or more');
        out.minStock = n;
    }
    if (body.prescriptionOnly !== undefined) out.prescriptionOnly = bool(body.prescriptionOnly);
    if (body.controlled !== undefined) out.controlled = bool(body.controlled);
    if (body.remarks !== undefined) out.remarks = str(body.remarks, 500);
    if (body.barcodes !== undefined) out.barcodes = codesOf(body.barcodes);
    Object.assign(out, doseLimits(body));
    return out;
}

/** Barcodes as typed or scanned: a list, or one string split on commas and spaces; at most five. */
function codesOf(raw) {
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/)).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
    for (const c of list) if (!/^[A-Z0-9-]{4,40}$/.test(c)) refuse(`"${c}" does not look like a barcode`);
    const out = [...new Set(list)];
    if (out.length > 5) refuse('At most five barcodes per item');
    return out;
}

/** A barcode belongs to one item of the school. */
async function codesFree(schoolId, codes, exceptId = null) {
    if (!codes?.length) return;
    const { rows } = await pool.query(
        `SELECT "name", "strength" FROM "medicalitems" WHERE "school" = $1 AND "isActive" IS NOT FALSE AND "_id"::text <> $2 AND "barcodes" ?| $3::text[] LIMIT 1`,
        [String(schoolId), String(exceptId || ''), codes]);
    if (rows[0]) refuse(`That barcode is already on ${rows[0].name}${rows[0].strength ? ` ${rows[0].strength}` : ''}`, 409, 'MEDICAL_DUPLICATE');
}

/** The item a scanned pack belongs to, with what is usable now. */
async function itemByCode(req, code) {
    const c = String(code || '').trim().toUpperCase();
    if (!c) refuse('Scan or type the barcode');
    const { rows } = await pool.query(
        `SELECT i."_id"::text AS "_id", i."name", i."kind", i."strength", i."form", i."unit", i."storageLocation", i."controlled", i."prescriptionOnly",
                COALESCE(SUM(b."quantity") FILTER (WHERE b."expiryDate" IS NULL OR (b."expiryDate" AT TIME ZONE 'UTC')::date >= $3::date), 0)::float8 AS usable,
                MIN(b."expiryDate") FILTER (WHERE b."expiryDate" IS NOT NULL AND (b."expiryDate" AT TIME ZONE 'UTC')::date >= $3::date) AS "nextExpiry"
           FROM "medicalitems" i LEFT JOIN "medicalbatches" b ON b."item" = i."_id" AND b."status" = 'active' AND b."quantity" > 0
          WHERE i."school" = $1 AND i."isActive" IS NOT FALSE AND i."barcodes" ? $2
          GROUP BY i."_id" LIMIT 1`, [String(req.schoolId), c, todayStr()]);
    if (!rows[0]) refuse('No medicine or supply has that barcode — add it to the item on the web', 404, 'MEDICAL_NOT_FOUND');
    return rows[0];
}

/** minHoursBetween / maxPerDay as sent: blank clears the figure (the class rule then applies). */
function doseLimits(body) {
    const out = {};
    if (body.minHoursBetween !== undefined) {
        const n = num(body.minHoursBetween);
        if (n !== null && (n <= 0 || n > 72)) refuse('The least time between doses must be between 0 and 72 hours');
        out.minHoursBetween = n;
    }
    if (body.maxPerDay !== undefined) {
        const n = num(body.maxPerDay);
        if (n !== null && (n < 1 || n > 24 || !Number.isInteger(n))) refuse('The most doses in 24 hours must be a whole number from 1 to 24');
        out.maxPerDay = n;
    }
    return out;
}

async function findItem(schoolId, id) {
    if (!isUuid(id)) notFound('Item');
    const item = await MedicalItem.findOne({ _id: id, school: schoolId }).lean();
    if (!item) notFound('Item');
    return item;
}

/**
 * A new medicine or supply — with its first batch when a quantity is given,
 * so "Add medicine" is one step for the person at the shelf.
 */
async function createItem(req, body) {
    const kind = body.kind === 'supply' ? 'supply' : 'medicine';
    const fields = itemFields(body, kind);
    if (!fields.name) refuse(kind === 'medicine' ? 'Give the medicine a name' : 'Give the supply a name');
    const { rows: dup } = await pool.query(
        `SELECT 1 FROM "medicalitems" WHERE "school" = $1 AND "kind" = $2 AND lower("name") = lower($3)
            AND COALESCE("strength", '') = $4 AND "isActive" IS NOT FALSE LIMIT 1`,
        [String(req.schoolId), kind, fields.name, fields.strength || ''],
    );
    if (dup.length) refuse(`${fields.name}${fields.strength ? ` ${fields.strength}` : ''} is already in the list — receive stock into it instead`, 409, 'MEDICAL_DUPLICATE');
    await codesFree(req.schoolId, fields.barcodes);

    const firstQty = num(body.quantity);
    const result = await withTransaction(async (q) => {
        const item = await insert(MedicalItem, {
            school: req.schoolId, kind, unit: kind === 'medicine' ? 'tablet' : 'piece', ...fields,
            stock: 0, isActive: true, createdBy: req.userId,
        }, { q });
        let batch = null;
        if (firstQty && firstQty > 0) {
            batch = await stock.receive(req, {
                item: item._id, quantity: firstQty, batchNumber: body.batchNumber, expiryDate: body.expiryDate,
                purchaseDate: body.purchaseDate, supplier: body.supplier, unitCost: body.unitCost, note: 'Opening stock',
            }, q);
        }
        return { item, batch };
    });
    audit.log(req, { action: 'created', entity: kind, entityId: result.item._id, summary: `Added ${kind} ${fields.name}${firstQty ? ` with ${firstQty} ${fields.unit || ''} in stock` : ''}` });
    return findItem(req.schoolId, result.item._id);
}

async function updateItem(req, id, body) {
    const item = await findItem(req.schoolId, id);
    const fields = itemFields(body, item.kind);
    if (fields.name === '') refuse('The name cannot be empty');
    await codesFree(req.schoolId, fields.barcodes, id);
    const changes = audit.diff(item, fields);
    if (!changes.length) return item;
    const row = await patch(MedicalItem, id, { ...fields, updatedBy: req.userId }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'updated', entity: item.kind, entityId: id, summary: `Edited ${item.name}`, changes });
    return row;
}

async function setItemActive(req, id, active) {
    const item = await findItem(req.schoolId, id);
    if (!active && Number(item.stock) > 0 && !bool(req.body?.force)) {
        refuse(`${item.name} still has ${item.stock} ${item.unit} in stock — write the stock off first, or archive anyway`, 409, 'MEDICAL_HAS_STOCK');
    }
    if (!active) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "medicationplans" WHERE "school" = $1 AND "item" = $2 AND "status" IN ('active', 'paused')`, [String(req.schoolId), String(id)]);
        if (rows[0].n) refuse(`${item.name} is in ${rows[0].n} medication plan${rows[0].n === 1 ? '' : 's'} — end those first`, 409, 'MEDICAL_IN_USE');
    }
    const row = await patch(MedicalItem, id, { isActive: !!active, updatedBy: req.userId }, { where: { school: req.schoolId } });
    audit.log(req, { action: active ? 'restored' : 'archived', entity: item.kind, entityId: id, summary: `${active ? 'Restored' : 'Archived'} ${item.name}` });
    return row;
}

/* ── Stock (thin wrappers that audit) ─────────────────────────────────────── */

async function stockIn(req, itemId, body) {
    const item = await findItem(req.schoolId, itemId);
    const out = await stock.receive(req, { ...body, item: itemId });
    audit.log(req, { action: 'stock_in', entity: item.kind, entityId: itemId, summary: `Received ${num(body.quantity)} ${item.unit} of ${item.name}${body.batchNumber ? ` (batch ${str(body.batchNumber)})` : ''}` });
    return out;
}

async function stockOut(req, itemId, body) {
    const item = await findItem(req.schoolId, itemId);
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say what the stock was taken out for');
    const out = await stock.consume(req, { item: itemId, quantity: body.quantity, batch: body.batch || null, type: 'stock_out', reason });
    audit.log(req, { action: 'stock_out', entity: item.kind, entityId: itemId, summary: `Took out ${num(body.quantity)} ${item.unit} of ${item.name} — ${reason}` });
    return out;
}

async function adjustBatch(req, batchId, body) {
    const out = await stock.adjust(req, { batch: batchId, quantity: body.quantity, reason: str(body.reason, 300) });
    audit.log(req, { action: 'stock_adjusted', entity: 'batch', entityId: batchId, summary: `Stock count adjusted by ${out.delta > 0 ? '+' : ''}${out.delta} — ${str(body.reason, 200)}` });
    return out;
}

async function writeOffBatch(req, batchId, body) {
    const type = oneOf(body.type, { expired: 1, damaged: 1, disposed: 1 }, 'expired');
    const out = await stock.writeOff(req, { batch: batchId, quantity: body.quantity, type, reason: str(body.reason, 300) });
    audit.log(req, { action: `marked_${type}`, entity: 'batch', entityId: batchId, summary: `Wrote off ${out.quantity} as ${type}${body.reason ? ` — ${str(body.reason, 200)}` : ''}` });
    return out;
}

/* ── Medication plans ─────────────────────────────────────────────────────── */

const SLOTS = { once: 1, twice: 2, thrice: 3 };

function planTimes(frequency, raw) {
    if (frequency === 'as_needed') return [];
    const list = [...new Set((Array.isArray(raw) ? raw : String(raw || '').split(',')).map(clock).filter(Boolean))].sort();
    const want = SLOTS[frequency];
    if (want && list.length !== want) refuse(`${PLAN_FREQUENCY[frequency]} needs ${want} time${want === 1 ? '' : 's'} of day`);
    if (!list.length) refuse('Add at least one time of day');
    if (list.length > 8) refuse('At most eight times a day');
    return list;
}

async function planDocument(req, studentId, id) {
    if (!id) return null;
    if (!isUuid(id)) refuse('That prescription could not be found');
    const doc = await MedicalDocument.findOne({ _id: id, school: req.schoolId, student: studentId, archivedAt: null }).select('_id').lean();
    if (!doc) refuse('That prescription is not one of this student\'s documents');
    return String(doc._id);
}

/**
 * A plan with no parent authorisation is created PAUSED — nothing is
 * scheduled until the family's consent is recorded (authorizePlan).
 */
async function createPlan(req, body) {
    const student = await access.assertStudent(req.schoolId, body.student, { current: true });
    const source = body.source === 'parent' ? 'parent' : 'school';
    let item = null;
    if (source === 'school') {
        if (!body.item) refuse('Choose the medicine from stock, or mark it as supplied by the parent');
        item = await findItem(req.schoolId, body.item);
        if (item.kind !== 'medicine') refuse('Only a medicine can be given on a plan');
        if (item.isActive === false) refuse(`${item.name} is archived`);
    }
    const medicineName = str(body.medicineName, 120) || (item ? `${item.name}${item.strength ? ` ${item.strength}` : ''}` : '');
    if (!medicineName) refuse('Name the medicine');
    const dosage = str(body.dosage, 120);
    if (!dosage) refuse('Give the dosage — e.g. "1 tablet (500 mg)"');
    const frequency = oneOf(body.frequency, PLAN_FREQUENCY, 'once');
    const times = planTimes(frequency, body.times);
    const days = [...new Set((Array.isArray(body.days) ? body.days : [1, 2, 3, 4, 5, 6]).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    if (!days.length) refuse('Choose the days the medicine is given');
    const startDate = toDay(body.startDate) || toDay(todayStr());
    const endDate = toDay(body.endDate);
    if (endDate && dayStr(endDate) < dayStr(startDate)) refuse('The end date is before the start date');
    // Zero is a real answer: puffs of an inhaler are not counted out of stock.
    const perDose = source === 'school' ? (num(body.quantityPerDose) ?? 1) : 0;
    if (perDose < 0) refuse('Quantity per dose cannot be negative');
    // The family's own medicine: how much of what they send in one dose uses (0 = not counted, e.g. an inhaler).
    const supplyPerDose = source === 'parent' ? (num(body.supplyPerDose) ?? 1) : 1;
    if (supplyPerDose < 0) refuse('The amount per dose cannot be negative');
    const authorized = bool(body.parentAuthorized ?? body.parentAuthorization?.authorized);
    // A plan for a medicine the child is allergic to is stopped here, not at its first dose.
    const allergy = (await safety.check(req.schoolId, student._id, { medicineName, item })).blocks.filter((b) => b.code === 'allergy');
    const reason = str(body.override?.reason, 300);
    if (allergy.length && !reason) {
        refuse(allergy.map((b) => b.message).join('. '), 409, 'MEDICAL_SAFETY', { problems: allergy, warnings: [] });
    }

    const row = await MedicationPlan.create({
        school: req.schoolId, student: student._id, source, item: item?._id || null, medicineName, dosage,
        quantityPerDose: perDose, supplyPerDose, route: str(body.route, 40) || 'Oral', reason: str(body.reason, 200), frequency, times, days,
        startDate, endDate, instructions: str(body.instructions, 600),
        ...doseLimits(body),
        parentAuthorization: authorized
            ? { authorized: true, by: str(body.authorizedBy || body.parentAuthorization?.by, 120), byUser: null, at: new Date() }
            : { authorized: false, by: '', byUser: null, at: null },
        prescription: await planDocument(req, student._id, body.prescription),
        status: authorized ? 'active' : 'paused',
        statusNote: authorized ? '' : 'Waiting for parent authorisation',
        activeFrom: authorized ? new Date() : null,
        createdBy: req.userId, updatedBy: req.userId,
    });
    audit.log(req, { action: 'created', entity: 'medication_plan', entityId: row._id, student: student._id, summary: `Medication plan: ${medicineName} ${dosage} (${PLAN_FREQUENCY[frequency]})` });
    if (allergy.length) {
        audit.log(req, { action: 'safety_override', entity: 'medication_plan', entityId: row._id, student: student._id, summary: `Plan for ${medicineName} despite: ${allergy.map((b) => b.message).join('; ')} — reason: ${reason}` });
    }
    if (authorized) await ensureDoses(req.schoolId, todayStr(), { plan: row._id });
    // Nothing is given until the family says yes — so they are asked, live, now.
    if (!authorized) {
        quiet(notifyMed.toParents(req, student._id, {
            title: `Please authorise a medicine — ${student.name}`,
            body: `The Medical Room plans to give ${student.name} ${medicineName} (${dosage}, ${whenEn({ frequency, times })}) at school. Nothing is given until you authorise it on the Medical Room page.`,
            setting: 'parentMedicine', tab: 'medicines',
            i18n: { key: 'plan_authorise', vars: { name: student.name, medicine: medicineName, dosage, when: whenHi({ frequency, times }) } },
        }));
    }
    return row.toObject ? row.toObject() : row;
}

async function findPlan(req, id) {
    if (!isUuid(id)) notFound('Medication plan');
    const plan = await MedicationPlan.findOne({ _id: id, school: req.schoolId }).lean();
    if (!plan) notFound('Medication plan');
    return plan;
}

async function updatePlan(req, id, body) {
    const plan = await findPlan(req, id);
    if (['completed', 'cancelled'].includes(plan.status)) refuse('This plan has ended — start a new one');
    const set = {};
    if (body.dosage !== undefined) { set.dosage = str(body.dosage, 120); if (!set.dosage) refuse('Give the dosage'); }
    if (body.instructions !== undefined) set.instructions = str(body.instructions, 600);
    if (body.reason !== undefined) set.reason = str(body.reason, 200);
    if (body.route !== undefined) set.route = str(body.route, 40) || 'Oral';
    if (body.quantityPerDose !== undefined && plan.source === 'school') set.quantityPerDose = Math.max(0, num(body.quantityPerDose) || 0);
    if (body.supplyPerDose !== undefined && plan.source === 'parent') set.supplyPerDose = Math.max(0, num(body.supplyPerDose) || 0);
    if (body.frequency !== undefined || body.times !== undefined) {
        set.frequency = oneOf(body.frequency ?? plan.frequency, PLAN_FREQUENCY, plan.frequency);
        set.times = planTimes(set.frequency, body.times ?? plan.times);
    }
    if (body.days !== undefined) {
        set.days = [...new Set((body.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
        if (!set.days.length) refuse('Choose the days the medicine is given');
    }
    if (body.endDate !== undefined) {
        set.endDate = toDay(body.endDate);
        if (set.endDate && dayStr(set.endDate) < dayStr(plan.startDate)) refuse('The end date is before the start date');
    }
    if (body.prescription !== undefined) set.prescription = await planDocument(req, plan.student, body.prescription);
    Object.assign(set, doseLimits(body));
    const changes = audit.diff(plan, set);
    if (!changes.length) return plan;
    const reschedule = !!(set.times || set.days || set.endDate !== undefined);
    // The new schedule applies from now: no slot earlier today is owed under it.
    if (reschedule && plan.status === 'active') set.activeFrom = new Date();
    const row = await patch(MedicationPlan, id, { ...set, updatedBy: req.userId }, { where: { school: req.schoolId } });
    // Doses not yet given follow the new schedule. The open slots still to come
    // are DELETED, not cancelled: a cancelled row keeps its (plan, time) slot
    // taken in the unique index, and the slot could never be generated again —
    // a changed end date used to cost the rest of the day's doses. The ones
    // already given, refused or missed are history and stay.
    if (reschedule) {
        await pool.query(`DELETE FROM "medicationdoses" WHERE "plan" = $1 AND "status" = 'scheduled' AND "scheduledFor" >= now()`, [String(id)]);
        if (row.status === 'active') await ensureDoses(req.schoolId, todayStr(), { plan: id });
    }
    // A dose still waiting is given as the plan says NOW — the dosage and the
    // stock it takes were copied onto it when it was scheduled.
    if (set.dosage !== undefined || set.quantityPerDose !== undefined) {
        await pool.query(
            `UPDATE "medicationdoses" SET "dosage" = $2, "quantity" = $3, "updatedAt" = now() WHERE "plan" = $1 AND "status" = 'scheduled'`,
            [String(id), row.dosage, row.source === 'school' ? Number(row.quantityPerDose) || 0 : 0],
        );
    }
    audit.log(req, { action: 'updated', entity: 'medication_plan', entityId: id, student: plan.student, summary: `Edited plan ${plan.medicineName}`, changes });
    // The family hears when how much or when changes — once they have authorised the plan at all.
    if (plan.parentAuthorization?.authorized && changes.some((c) => ['dosage', 'frequency', 'times', 'days'].includes(c.field))) {
        const card = await access.studentCard(req.schoolId, plan.student);
        const name = card?.name || 'your child';
        quiet(notifyMed.toParents(req, plan.student, {
            title: `Medicine plan changed — ${name}`,
            body: `${row.medicineName} for ${name} at school is now ${row.dosage}, ${whenEn(row)}.`,
            setting: 'parentMedicine', tab: 'medicines',
            i18n: { key: 'plan_changed', vars: { name, medicine: row.medicineName, dosage: row.dosage, when: whenHi(row) } },
        }));
    }
    return row;
}

async function authorizePlan(req, id, body = {}) {
    const plan = await findPlan(req, id);
    if (plan.parentAuthorization?.authorized) refuse('This plan is already authorised');
    if (['completed', 'cancelled'].includes(plan.status)) refuse('This plan has ended');
    const by = str(body.by, 120);
    const becomesActive = plan.status === 'paused' && plan.statusNote === 'Waiting for parent authorisation';
    const row = await patch(MedicationPlan, id, {
        parentAuthorization: { authorized: true, by, byUser: req.userRole === 'parent' ? req.userId : null, at: new Date() },
        status: becomesActive ? 'active' : plan.status,
        statusNote: '', updatedBy: req.userId,
        ...(becomesActive ? { activeFrom: new Date() } : {}),
    }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'authorised', entity: 'medication_plan', entityId: id, student: plan.student, summary: `Parent authorisation recorded for ${plan.medicineName}${by ? ` (${by})` : ''}` });
    if (row.status === 'active') await ensureDoses(req.schoolId, todayStr(), { plan: id });
    // A parent said yes in the app: the medical staff hear it (a paper form recorded by the staff tells nobody).
    if (req.userRole === 'parent') {
        const card = await access.studentCard(req.schoolId, plan.student);
        quiet(notifyMed.toStaff(req, {
            title: `Medicine authorised — ${card?.name || 'a student'}`,
            body: `${who(req) || 'A parent'} authorised ${plan.medicineName} (${plan.dosage}) for ${card?.name || 'a student'}${row.status === 'active' ? ' — it is on the medicine round from now' : ''}.`,
            setting: 'staffParentUpdates', link: { type: 'medical.round' },
        }));
    }
    return row;
}

async function setPlanStatus(req, id, status, note = '') {
    const plan = await findPlan(req, id);
    const allowed = { active: ['paused', 'completed', 'cancelled'], paused: ['active', 'completed', 'cancelled'], completed: [], cancelled: [] };
    const from = plan.status;
    if (!(allowed[from] || []).includes(status)) refuse(`A ${from} plan cannot be made ${status}`);
    if (status === 'active' && !plan.parentAuthorization?.authorized) refuse('Record the parent\'s authorisation before the plan starts');
    const row = await patch(MedicationPlan, id, {
        status, statusNote: str(note, 200), updatedBy: req.userId,
        // Resumed: the plan owes doses from now on, not the slots it slept through.
        ...(status === 'active' ? { activeFrom: new Date() } : {}),
    }, { where: { school: req.schoolId, status: from } });
    if (!row) refuse('This plan was changed by someone else — reload and try again', 409, 'MEDICAL_STALE');
    if (status !== 'active') {
        // Slots still to come are deleted so a resumed plan can have them again
        // (a cancelled row would hold its slot in the unique index for good);
        // a slot already past but never recorded is closed with the reason.
        await pool.query(`DELETE FROM "medicationdoses" WHERE "plan" = $1 AND "status" = 'scheduled' AND "scheduledFor" >= now()`, [String(id)]);
        await pool.query(
            `UPDATE "medicationdoses" SET "status" = 'cancelled', "note" = $2, "updatedAt" = now()
              WHERE "plan" = $1 AND "status" = 'scheduled'`,
            [String(id), `Plan ${status}`],
        );
    } else {
        await ensureDoses(req.schoolId, todayStr(), { plan: id });
    }
    audit.log(req, { action: status === 'active' ? 'resumed' : status, entity: 'medication_plan', entityId: id, student: plan.student, summary: `Plan ${plan.medicineName} ${status}${note ? ` — ${str(note, 120)}` : ''}` });
    const news = PLAN_NEWS[status];
    if (news) {
        const card = await access.studentCard(req.schoolId, plan.student);
        const name = card?.name || 'your child';
        const why = str(note, 200);
        quiet(notifyMed.toParents(req, plan.student, {
            title: `${news.title} — ${name}`,
            body: `${news.body(plan.medicineName, name)}${why ? `: ${why}` : ''}.`,
            setting: 'parentMedicine', tab: 'medicines',
            i18n: { key: 'plan_status', vars: { name, medicine: plan.medicineName, status, note: why } },
        }));
    }
    return row;
}

/* ── Doses ────────────────────────────────────────────────────────────────── */

/**
 * The scheduled doses of `day` ('YYYY-MM-DD') for every active, authorised
 * plan that covers it — or only `opts.plan`. Idempotent: the unique index on
 * (plan, scheduledFor) lets the sweep and a screen generate the same day at
 * the same moment without doubling anything.
 */
async function ensureDoses(schoolId, day = todayStr(), opts = {}) {
    const [y, m, d] = day.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const params = [day, weekday];
    const where = [`p."status" = 'active'`, `p."frequency" <> 'as_needed'`,
        `(p."parentAuthorization"->>'authorized')::boolean IS TRUE`,
        `(p."startDate" AT TIME ZONE 'UTC')::date <= $1::date`,
        `(p."endDate" IS NULL OR (p."endDate" AT TIME ZONE 'UTC')::date >= $1::date)`,
        `p."days" @> to_jsonb($2::int)`];
    if (schoolId) { params.push(String(schoolId)); where.push(`p."school" = $${params.length}`); }
    if (opts.plan) { params.push(String(opts.plan)); where.push(`p."_id" = $${params.length}`); }
    const { rows: plans } = await pool.query(`SELECT p.* FROM "medicationplans" p WHERE ${where.join(' AND ')}`, params);
    let made = 0;
    for (const p of plans) {
        const from = p.activeFrom ? new Date(p.activeFrom).getTime() : null;
        for (const t of p.times || []) {
            const [hh, mm] = String(t).split(':').map(Number);
            const at = new Date(y, m - 1, d, hh, mm, 0, 0);   // on the school's clock
            // Never a slot from before the schedule took effect — it would only
            // be recorded as "missed" by the next sweep.
            if (from !== null && at.getTime() < from) continue;
            const { rowCount } = await pool.query(
                `INSERT INTO "medicationdoses" ("_id","school","student","plan","item","source","medicineName","dosage","quantity",
                                                 "batches","scheduledFor","status","createdAt","updatedAt")
                 VALUES (gen_random_uuid(),$1,$2,$3,$4,'plan',$5,$6,$7,'[]'::jsonb,$8,'scheduled', now(), now())
                 ON CONFLICT ("plan","scheduledFor") WHERE "plan" IS NOT NULL AND "scheduledFor" IS NOT NULL DO NOTHING`,
                [String(p.school), String(p.student), String(p._id), p.item ? String(p.item) : null, p.medicineName, p.dosage,
                    p.source === 'school' ? Number(p.quantityPerDose) || 0 : 0, at],
            );
            made += rowCount;
        }
    }
    return made;
}

/**
 * Doses still 'scheduled' long after their time are recorded as missed — the
 * school's `missedDoseAfterMinutes` after the slot. A dose given late is
 * still recorded as given if someone records it before then.
 */
async function markMissed(schoolId = null) {
    const params = [];
    let scope = '';
    if (schoolId) { params.push(String(schoolId)); scope = `AND d."school" = $1`; }
    // A school that never saved its settings has no row, and still gets the
    // default window — hence the sub-select rather than a join.
    // The doses themselves come back, so the medical staff can be told which.
    const { rows } = await pool.query(
        `UPDATE "medicationdoses" d SET "status" = 'missed', "note" = 'Not recorded in time', "updatedAt" = now()
          WHERE d."status" = 'scheduled' ${scope}
            AND d."scheduledFor" < now() - make_interval(mins => COALESCE(
                (SELECT s."missedDoseAfterMinutes" FROM "medicalsettingses" s WHERE s."school" = d."school" LIMIT 1), 120)::int)
          RETURNING d."_id"::text AS id, d."school"::text AS school, d."student"::text AS student, d."scheduledFor", d."medicineName"`,
        params,
    );
    return rows;
}

async function findDose(req, id) {
    if (!isUuid(id)) notFound('Dose');
    const dose = await MedicationDose.findOne({ _id: id, school: req.schoolId }).lean();
    if (!dose) notFound('Dose');
    return dose;
}

/**
 * A controlled medicine needs a second member of staff to witness the dose:
 * `witness` (a user id) from the body or the override. Returns who, or stops
 * the dose with MEDICAL_WITNESS_REQUIRED so the screen can ask.
 */
async function witnessFor(req, item, body = {}) {
    if (!item?.controlled) return { witnessBy: null, witnessName: '' };
    const id = body.witness || body.override?.witness;
    if (!id) refuse(`${item.name} is a controlled medicine — a second member of staff must witness the dose`, 409, 'MEDICAL_WITNESS_REQUIRED', { item: String(item._id) });
    if (!isUuid(id) || String(id) === String(req.userId)) refuse('The witness must be another member of staff');
    const { rows } = await require('../db/pool').query(
        `SELECT "name" FROM "users" WHERE "_id" = $1 AND "school" = $2 AND "role" IN ('teacher','school_admin') AND "isActive" IS NOT FALSE`,
        [String(id), String(req.schoolId)],
    );
    if (!rows.length) refuse('The witness must be a member of this school\'s staff');
    return { witnessBy: String(id), witnessName: rows[0].name };
}

/**
 * Give a medicine now — from a plan (as needed, or outside its slots), from
 * stock with no plan, or the family's own medicine. Used on its own and by a
 * Medical Room visit (pass its transaction `q` and `visit`).
 *
 * body: { student, plan?, item?, source?, medicineName?, dosage, quantity?, note?, givenAt? }
 */
async function giveDose(req, body, q = null, { visit = null, notifyParents = true, log = true } = {}) {
    const studentId = String(body.student);
    let plan = null;
    if (body.plan) {
        plan = await findPlan(req, body.plan);
        if (String(plan.student) !== studentId) refuse('That medication plan belongs to another student');
        if (plan.status !== 'active') refuse(`The plan for ${plan.medicineName} is ${plan.status}`);
    }
    const source = plan ? plan.source : (body.source === 'parent' ? 'parent' : 'school');
    let item = null;
    if (source === 'school') {
        const itemId = plan?.item || body.item;
        if (!itemId) refuse('Choose the medicine from stock, or mark it as the family\'s own');
        item = await findItem(req.schoolId, itemId);
        if (item.kind !== 'medicine') refuse(`${item.name} is a supply, not a medicine`);
        if (item.prescriptionOnly && !plan) refuse(`${item.name} is given only against a medication plan`);
    }
    const medicineName = str(body.medicineName, 120) || plan?.medicineName || (item ? `${item.name}${item.strength ? ` ${item.strength}` : ''}` : '');
    if (!medicineName) refuse('Name the medicine');
    const dosage = str(body.dosage, 120) || plan?.dosage || '';
    if (!dosage) refuse(`Give the dosage of ${medicineName}`);
    // A plan's 0 per dose is deliberate (two puffs do not use up an inhaler), so only a
    // plan with no figure at all falls back to one unit.
    const perDose = plan ? (plan.quantityPerDose === null || plan.quantityPerDose === undefined ? 1 : Number(plan.quantityPerDose) || 0) : 1;
    const quantity = source === 'school' ? (num(body.quantity) ?? perDose) : 0;
    if (quantity < 0) refuse(`The quantity of ${medicineName} cannot be less than 0`);
    const givenAt = body.givenAt ? new Date(body.givenAt) : new Date();
    if (Number.isNaN(givenAt.getTime()) || givenAt > new Date(Date.now() + 5 * 60000)) refuse('A dose cannot be recorded in the future');
    // Allergies, the gap since the last dose, the daily maximum: stopped here
    // unless someone says why it goes ahead (services/medicalSafety).
    const safe = await safety.enforce(req, studentId, { medicineName, item, plan }, body.override);
    const witness = await witnessFor(req, item, body);

    const run = async (tq) => {
        const doseId = require('../db/schema').newId();
        let taken = { batches: [] };
        if (source === 'school' && quantity > 0) {
            taken = await stock.consume(req, { item: item._id, quantity, type: 'administered', reason: `${medicineName} ${dosage}`.trim(), refKind: 'dose', refId: doseId, student: studentId }, tq);
        }
        const dose = await insert(MedicationDose, {
            _id: doseId, school: req.schoolId, student: studentId, plan: plan?._id || null, item: item?._id || null,
            source: visit ? 'visit' : 'manual', medicineName, dosage, quantity, batches: taken.batches,
            scheduledFor: null, status: 'given', givenAt, givenBy: req.userId, givenByName: who(req),
            note: str(body.note, 300), visit: visit ? String(visit) : null, recordedBy: req.userId,
            safetyOverrides: safe.overrides, ...witness,
        }, { q: tq });
        return { dose, unit: item?.unit || '' };
    };
    const out = q ? await run(q) : await withTransaction(run);
    // Inside someone else's transaction the caller logs, once it has committed.
    if (log) audit.log(req, { action: 'administered', entity: 'dose', entityId: out.dose._id, student: studentId, summary: `Gave ${medicineName} — ${dosage}${quantity ? ` (${quantity} ${out.unit})` : ''}${witness.witnessName ? `, witnessed by ${witness.witnessName}` : ''}` });
    // Inside a visit the visit logs it, once the visit has committed.
    if (log && safe.overrides.length) overridden(req, studentId, out.dose._id, medicineName, safe.overrides);
    // The family's own medicine: counted once the dose (and any visit around it) has committed.
    if (plan?.source === 'parent') setTimeout(() => supplyWatch(req, plan._id).catch((e) => console.error('[medical] supply watch failed:', e.message)), 800);
    if (notifyParents) {
        const card = await access.studentCard(req.schoolId, studentId);
        notifyMed.toParents(req, studentId, {
            title: 'Medicine given at school',
            body: `${card?.name || 'Your child'} was given ${medicineName} (${dosage}) by the Medical Room at ${givenAt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.`,
            setting: 'parentMedicine', tab: 'medicines',
            i18n: { key: 'medicine_given', vars: { name: card?.name || 'आपके बच्चे', time: givenAt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }), medicine: medicineName, dose: dosage } },
        });
    }
    return { ...out.dose, unit: out.unit, safetyWarnings: safe.warnings };
}

/** A dose given past a safety check: in the audit log, and an allergy is the room's business at once. */
function overridden(req, studentId, doseId, medicineName, overrides) {
    audit.log(req, {
        action: 'safety_override', entity: 'dose', entityId: doseId, student: studentId,
        summary: `Gave ${medicineName} despite: ${overrides.map((o) => o.message).join('; ')} — reason: ${overrides[0].reason}`,
    });
    if (overrides.some((o) => o.code === 'allergy')) {
        access.studentCard(req.schoolId, studentId).then((card) => notifyMed.toStaff(req, {
            title: `Check this · medicine given despite an allergy — ${card?.name || 'a student'}`,
            body: `${req.user?.name || 'Someone'} gave ${medicineName} to ${card?.name || 'a student'} past the allergy check (${overrides.find((o) => o.code === 'allergy').message}). Reason given: ${overrides[0].reason}.`,
            link: { type: 'medical.desk' }, urgent: true,
        })).catch(() => {});
    }
}

/**
 * Record what happened to a scheduled dose: given, refused or missed. Only a
 * dose still 'scheduled' can be recorded — two people at the cabinet cannot
 * both give it (compare-and-set), and the stock moves with the record.
 */
async function recordDose(req, id, body) {
    const dose = await findDose(req, id);
    const status = oneOf(body.status, { given: 1, refused: 1, missed: 1 }, null);
    if (!status) refuse('Record the dose as given, refused or missed');
    if (dose.status !== 'scheduled' && !(dose.status === 'missed' && status === 'given')) {
        refuse(`This dose is already recorded as ${dose.status}`, 409, 'MEDICAL_STALE');
    }
    const note = str(body.note, 300);
    if (status === 'refused' && !note) refuse('Say why the dose was refused');
    const plan = dose.plan ? await MedicationPlan.findOne({ _id: dose.plan }).lean() : null;
    const givenAt = status === 'given' ? (body.givenAt ? new Date(body.givenAt) : new Date()) : null;
    if (givenAt && Number.isNaN(givenAt.getTime())) refuse('The time the dose was given is not a valid time');
    if (givenAt && givenAt > new Date(Date.now() + 5 * 60000)) refuse('A dose cannot be recorded as given in the future');
    let safe = { overrides: [], warnings: [] };
    let witness = { witnessBy: null, witnessName: '' };
    if (status === 'given') {
        const item = plan?.item ? await MedicalItem.findOne({ _id: plan.item }).lean() : null;
        safe = await safety.enforce(req, dose.student, { medicineName: dose.medicineName, item, plan, excludeDose: dose._id }, body.override);
        witness = await witnessFor(req, item, body);
    }

    const row = await withTransaction(async (q) => {
        let batches = [];
        if (status === 'given' && plan?.source === 'school' && plan.item && Number(dose.quantity) > 0) {
            const taken = await stock.consume(req, { item: plan.item, quantity: dose.quantity, type: 'administered', reason: `${dose.medicineName} ${dose.dosage}`.trim(), refKind: 'dose', refId: dose._id, student: dose.student }, q);
            batches = taken.batches;
        }
        const out = await patch(MedicationDose, id, {
            status, note, batches,
            givenAt, givenBy: status === 'given' ? req.userId : null, givenByName: status === 'given' ? who(req) : '',
            recordedBy: req.userId, safetyOverrides: safe.overrides, ...witness,
        }, { where: { school: req.schoolId, status: dose.status }, q });
        if (!out) refuse('Someone else recorded this dose a moment ago — reload to see it', 409, 'MEDICAL_STALE');
        return out;
    });
    audit.log(req, { action: status === 'given' ? 'administered' : `dose_${status}`, entity: 'dose', entityId: id, student: dose.student, summary: `${dose.medicineName} ${dose.dosage} — ${status}${note ? ` (${note})` : ''}` });
    if (safe.overrides.length) overridden(req, dose.student, id, dose.medicineName, safe.overrides);
    // The family's own medicine: running low → the family is asked for more.
    if (status === 'given' && plan?.source === 'parent') supplyWatch(req, plan._id).catch((e) => console.error('[medical] supply watch failed:', e.message));
    if (status === 'given' || status === 'refused') {
        const card = await access.studentCard(req.schoolId, dose.student);
        notifyMed.toParents(req, dose.student, {
            title: status === 'given' ? 'Medicine given at school' : 'Medicine refused at school',
            body: status === 'given'
                ? `${card?.name || 'Your child'} was given ${dose.medicineName} (${dose.dosage}) at ${givenAt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.`
                : `${card?.name || 'Your child'} did not take ${dose.medicineName} (${dose.dosage}) today${note ? `: ${note}` : ''}.`,
            setting: 'parentMedicine', tab: 'medicines',
            i18n: status === 'given'
                ? { key: 'medicine_given', vars: { name: card?.name || 'आपके बच्चे', time: givenAt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }), medicine: dose.medicineName, dose: dose.dosage } }
                : { key: 'medicine_refused', vars: { name: card?.name || 'आपके बच्चे', medicine: dose.medicineName, dose: dose.dosage, note } },
        });
    }
    return { ...row, safetyWarnings: safe.warnings };
}

/** Undo a dose: a given one goes back into stock (from the batches it came from). */
async function cancelDose(req, id, body = {}) {
    const dose = await findDose(req, id);
    if (dose.status === 'cancelled') refuse('This dose is already cancelled');
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say why the dose is being cancelled');
    const row = await withTransaction(async (q) => {
        if (dose.status === 'given' && (dose.batches || []).length && dose.item) {
            await stock.giveBack(req, { item: dose.item, batches: dose.batches, reason: `Dose cancelled — ${reason}`, refKind: 'dose', refId: dose._id, student: dose.student }, q);
        }
        const out = await patch(MedicationDose, id, { status: 'cancelled', note: reason, recordedBy: req.userId }, { where: { school: req.schoolId, status: dose.status }, q });
        if (!out) refuse('This dose was changed by someone else — reload and try again', 409, 'MEDICAL_STALE');
        // A dose given in a visit is listed on the visit too: a cancelled one is
        // not "medicine given" any more. The dose row keeps its history.
        if (dose.visit) {
            await q(
                `UPDATE "medicalvisits" SET "medicines" = COALESCE((SELECT jsonb_agg(m) FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof("medicines") = 'array' THEN "medicines" ELSE '[]'::jsonb END) m
                     WHERE m->>'dose' IS DISTINCT FROM $2), '[]'::jsonb), "updatedAt" = now()
                  WHERE "_id" = $1::uuid AND "school" = $3::uuid`,
                [String(dose.visit), String(id), String(req.schoolId)],
            );
        }
        return out;
    });
    audit.log(req, { action: 'dose_cancelled', entity: 'dose', entityId: id, student: dose.student, summary: `Cancelled ${dose.medicineName} (${dose.status}) — ${reason}` });
    // The family was told it was given (or refused): they hear it was recorded by mistake.
    if (['given', 'refused'].includes(dose.status)) {
        const card = await access.studentCard(req.schoolId, dose.student);
        const name = card?.name || 'your child';
        const at = dose.givenAt || dose.scheduledFor;
        const when = at ? ` at ${new Date(at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase()}` : '';
        quiet(notifyMed.toParents(req, dose.student, {
            title: `Correction — ${name}`,
            body: `The ${dose.medicineName} recorded as ${dose.status} for ${name}${when} was recorded by mistake and has been taken off the record.`,
            setting: 'parentMedicine', tab: 'medicines',
            i18n: { key: 'dose_correction', vars: { name, medicine: dose.medicineName } },
        }));
    }
    return row;
}

/* ── The family's own medicine: how much is left ───────────────────────────── */

/** Doses left of a family-supplied plan: { received, returned, given, perDose, left, doses } (null when not counted). */
async function supplyOf(plan) {
    if (plan.source !== 'parent') return null;
    const entries = plan.supplied || [];
    const received = entries.filter((e) => e.kind === 'received').reduce((n, e) => n + Number(e.quantity || 0), 0);
    const returned = entries.filter((e) => e.kind === 'returned').reduce((n, e) => n + Number(e.quantity || 0), 0);
    if (!received) return { received: 0, returned, given: 0, perDose: null, left: null, doses: null };
    const perDose = plan.supplyPerDose === null || plan.supplyPerDose === undefined ? 1 : Number(plan.supplyPerDose) || 0;
    const { rows } = await require('../db/pool').query(
        `SELECT count(*)::int AS n FROM "medicationdoses" WHERE "plan" = $1 AND "status" = 'given'`, [String(plan._id)],
    );
    const given = rows[0].n;
    const left = Math.max(0, received - returned - given * perDose);
    return { received, returned, given, perDose, left, doses: perDose ? Math.floor(left / perDose) : null };
}

/** Record medicine the family handed in, or what was handed back to them. body: { kind, quantity, note } */
async function recordSupply(req, planId, body = {}) {
    const plan = await findPlan(req, planId);
    if (plan.source !== 'parent') refuse('Only the family\'s own medicine is counted here — the school\'s stock has its own record');
    const kind = oneOf(body.kind, { received: 1, returned: 1 }, null);
    if (!kind) refuse('Say whether the medicine was handed in or handed back');
    const quantity = num(body.quantity);
    if (!quantity || quantity <= 0) refuse('Give how much');
    if (kind === 'returned') {
        const cur = await supplyOf(plan);
        if (cur.left !== null && quantity > cur.left) refuse(`Only ${cur.left} is left to hand back`);
    }
    const entry = { at: new Date(), kind, quantity, note: str(body.note, 200), by: String(req.userId), byName: who(req) };
    const row = await patch(MedicationPlan, planId, kind === 'received' ? { supplyNotifiedLeft: null } : {}, { push: { supplied: entry }, where: { school: req.schoolId } });
    // The family hears that what they sent arrived (or was handed back).
    {
        const card = await access.studentCard(req.schoolId, plan.student);
        const name = card?.name || 'your child';
        quiet(notifyMed.toParents(req, plan.student, {
            title: kind === 'received' ? `Medicine received — ${name}` : `Medicine handed back — ${name}`,
            body: kind === 'received'
                ? `The Medical Room received ${quantity} of ${plan.medicineName} for ${name}${entry.note ? ` (${entry.note})` : ''}.`
                : `The Medical Room handed back ${quantity} of ${plan.medicineName} for ${name}${entry.note ? ` (${entry.note})` : ''}.`,
            setting: 'parentMedicine', tab: 'medicines',
            i18n: { key: kind === 'received' ? 'supply_received' : 'supply_returned', vars: { name, medicine: plan.medicineName, quantity } },
        }));
    }
    audit.log(req, { action: kind === 'received' ? 'supply_received' : 'supply_returned', entity: 'medication_plan', entityId: planId, student: plan.student, summary: `${plan.medicineName}: ${quantity} ${kind === 'received' ? 'handed in by the family' : 'handed back to the family'}${entry.note ? ` — ${entry.note}` : ''}` });
    return { ...row, supply: await supplyOf(row) };
}

/** After a dose of the family's medicine: three doses or fewer left → the family is asked, once per level. */
async function supplyWatch(req, planId) {
    const plan = await MedicationPlan.findOne({ _id: planId }).lean();
    const s = plan ? await supplyOf(plan) : null;
    if (!s || s.doses === null || s.doses > 3) return;
    const prev = plan.supplyNotifiedLeft ?? null;
    if (prev !== null && prev <= s.doses) return;
    // Claimed first: two doses given a moment apart must not both ask the family.
    const claimed = await patch(MedicationPlan, planId, { supplyNotifiedLeft: s.doses }, { where: { supplyNotifiedLeft: prev }, touch: false });
    if (!claimed) return;
    const card = await access.studentCard(req.schoolId, plan.student);
    notifyMed.toParents(req, plan.student, {
        title: s.doses ? `Please send more ${plan.medicineName}` : `${plan.medicineName} has run out at school`,
        body: s.doses
            ? `The Medical Room has ${s.doses} dose${s.doses === 1 ? '' : 's'} of ${plan.medicineName} left for ${card?.name || 'your child'}. Please send more.`
            : `The Medical Room has no ${plan.medicineName} left for ${card?.name || 'your child'} — the next dose cannot be given until more is sent.`,
        setting: 'parentMedicine', urgent: !s.doses, tab: 'medicines',
    });
}

/* ── Counting the shelf ───────────────────────────────────────────────────── */

/** Count an item against the record: body { counted, witness (a controlled medicine), note }. */
async function countItem(req, itemId, body = {}) {
    const item = await findItem(req.schoolId, itemId);
    const counted = num(body.counted);
    if (counted === null || counted < 0) refuse('Give the number counted');
    const witness = await witnessFor(req, item, { witness: body.witness });
    const expected = Number(item.stock) || 0;
    const difference = Math.round((counted - expected) * 100) / 100;
    const MedicalStockCount = require('../models/MedicalStockCount');
    const row = await insert(MedicalStockCount, {
        school: req.schoolId, item: item._id, at: new Date(), expected, counted, difference, note: str(body.note, 300),
        countedBy: req.userId, countedByName: who(req), ...witness,
    });
    audit.log(req, {
        action: difference ? 'count_discrepancy' : 'stock_count', entity: 'medicine', entityId: item._id,
        summary: `${item.name}: counted ${counted}, record says ${expected}${difference ? ` — ${difference > 0 ? '+' : ''}${difference}` : ' — matches'}${witness.witnessName ? `, witnessed by ${witness.witnessName}` : ''}`,
    });
    if (difference) {
        notifyMed.toStaff(req, {
            title: `Count does not match — ${item.name}`,
            body: `${who(req)} counted ${counted} ${item.unit || ''} of ${item.name}; the record says ${expected}. ${item.controlled ? 'A controlled medicine: check the doses given since the last count.' : 'Check the doses and stock moves since the last count.'}`,
            urgent: !!item.controlled, link: { type: 'medical.desk' },
        });
    }
    return typeof row.toObject === 'function' ? row.toObject() : row;
}

async function counts(req, itemId) {
    const item = await findItem(req.schoolId, itemId);
    const { rows } = await require('../db/pool').query(
        `SELECT *, "_id"::text AS "_id" FROM "medicalstockcounts" WHERE "school" = $1 AND "item" = $2 ORDER BY "at" DESC LIMIT 30`,
        [String(req.schoolId), String(item._id)],
    );
    return rows;
}

module.exports = {
    supplyOf, recordSupply, supplyWatch, witnessFor, countItem, counts,
    findItem, createItem, updateItem, setItemActive, stockIn, stockOut, adjustBatch, writeOffBatch, itemByCode,
    createPlan, updatePlan, authorizePlan, setPlanStatus, findPlan,
    ensureDoses, markMissed, giveDose, recordDose, cancelDose, findDose, labelOf, overridden, doseLimits,
};
