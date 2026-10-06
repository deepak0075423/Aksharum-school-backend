'use strict';
/**
 * Medical equipment (Oct 2026): what the room has, where it is, the state it
 * is in and when it is next serviced. Every service, status or condition
 * change is appended to the item's `log` — the history is never rewritten.
 */
const { patch } = require('../db/patch');
const MedicalEquipment = require('../models/MedicalEquipment');
const audit = require('./medicalAudit');
const R = require('./medicalRules');

const { refuse, notFound, str, num, oneOf, isUuid, toDay, dayStr, todayStr } = R;
const who = (req) => req.user?.name || '';
const plainOf = (row) => (row && typeof row.toObject === 'function' ? row.toObject() : row);

function fields(body, prev = {}) {
    const out = {};
    if (body.name !== undefined) out.name = str(body.name, 120);
    if (body.type !== undefined) out.type = oneOf(body.type, R.EQUIP_TYPE, prev.type || 'other');
    for (const k of ['serialNumber', 'vendor', 'location', 'remarks']) if (body[k] !== undefined) out[k] = str(body[k], k === 'remarks' ? 600 : 120);
    if (body.quantity !== undefined) {
        const n = num(body.quantity);
        if (n === null || n < 1 || !Number.isInteger(n)) refuse('Quantity must be a whole number, 1 or more');
        out.quantity = n;
    }
    for (const k of ['purchaseDate', 'warrantyUntil', 'lastMaintenanceOn', 'nextMaintenanceOn']) if (body[k] !== undefined) out[k] = toDay(body[k]);
    if (out.purchaseDate && dayStr(out.purchaseDate) > todayStr()) refuse('The purchase date is in the future');
    if (out.lastMaintenanceOn && dayStr(out.lastMaintenanceOn) > todayStr()) refuse('The last maintenance date is in the future');
    if (body.condition !== undefined) out.condition = oneOf(body.condition, R.EQUIP_CONDITION, prev.condition || 'good');
    if (body.status !== undefined) out.status = oneOf(body.status, R.EQUIP_STATUS, prev.status || 'available');
    return out;
}

async function find(req, id) {
    if (!isUuid(id)) notFound('Equipment');
    const row = await MedicalEquipment.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row) notFound('Equipment');
    return row;
}

const entry = (req, kind, note, extra = {}) => ({ at: new Date(), kind, note: str(note, 400), by: req.userId, byName: who(req), ...extra });

async function create(req, body) {
    const f = fields(body);
    if (!f.name) refuse('Name the equipment');
    const row = plainOf(await MedicalEquipment.create({
        school: req.schoolId, quantity: 1, condition: 'good', status: 'available', ...f,
        log: [entry(req, 'note', 'Added to the Medical Room')], createdBy: req.userId,
    }));
    audit.log(req, { action: 'created', entity: 'equipment', entityId: row._id, summary: `Equipment added: ${row.name}` });
    return row;
}

async function update(req, id, body) {
    const row = await find(req, id);
    const f = fields(body, row);
    if (f.name === '') refuse('The name cannot be empty');
    const changes = audit.diff(row, f);
    if (!changes.length) return row;
    const log = [];
    if (f.status && f.status !== row.status) log.push(entry(req, 'status', `${R.EQUIP_STATUS[row.status].label} → ${R.EQUIP_STATUS[f.status].label}${body.note ? ` — ${str(body.note, 200)}` : ''}`));
    if (f.condition && f.condition !== row.condition) log.push(entry(req, 'condition', `${R.EQUIP_CONDITION[row.condition].label} → ${R.EQUIP_CONDITION[f.condition].label}`));
    const out = await patch(MedicalEquipment, id, { ...f, ...(f.nextMaintenanceOn !== undefined ? { maintenanceNotifiedFor: null } : {}) }, { where: { school: req.schoolId }, push: { log } });
    audit.log(req, { action: 'updated', entity: 'equipment', entityId: id, summary: `Equipment ${row.name} updated`, changes });
    return out;
}

/** Maintenance done: { date, note, cost, nextMaintenanceOn, condition }. */
async function maintain(req, id, body) {
    const row = await find(req, id);
    const date = toDay(body.date) || toDay(todayStr());
    if (dayStr(date) > todayStr()) refuse('Maintenance cannot be recorded for a future date');
    const note = str(body.note, 400);
    if (!note) refuse('Say what was done');
    const next = toDay(body.nextMaintenanceOn);
    if (next && dayStr(next) <= dayStr(date)) refuse('The next maintenance must be after this one');
    const set = { lastMaintenanceOn: date, nextMaintenanceOn: next || null };
    if (body.condition !== undefined) set.condition = oneOf(body.condition, R.EQUIP_CONDITION, row.condition);
    if (row.status === 'under_maintenance') set.status = 'available';
    const out = await patch(MedicalEquipment, id, set, {
        where: { school: req.schoolId },
        push: { log: entry(req, 'maintenance', note, { date: dayStr(date), cost: num(body.cost) || 0 }) },
    });
    audit.log(req, { action: 'maintained', entity: 'equipment', entityId: id, summary: `Maintenance recorded for ${row.name}: ${note}` });
    return out;
}

async function archive(req, id, body = {}) {
    const row = await find(req, id);
    if (row.archivedAt) refuse('This equipment is already archived');
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say why it is being removed');
    const out = await patch(MedicalEquipment, id, { archivedAt: new Date(), archivedBy: req.userId, archiveReason: reason, status: 'retired' }, { where: { school: req.schoolId }, push: { log: entry(req, 'status', `Retired — ${reason}`) } });
    audit.log(req, { action: 'archived', entity: 'equipment', entityId: id, summary: `Equipment ${row.name} retired — ${reason}` });
    return out;
}

module.exports = { create, update, maintain, archive, find };
