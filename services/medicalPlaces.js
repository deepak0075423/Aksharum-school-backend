'use strict';
/**
 * Where the stock is, what to buy, and what was thrown away (Oct 2026).
 *
 *   places     the main Medical Room (made the first time it is needed), more
 *              rooms, first-aid kits, the bus kit, the hostel cabinet, the lab;
 *              what each holds and when it was last checked; moving stock
 *              between them (services/medicalStock.transfer)
 *   reorder    what is low or will run out within a month at the pace it is
 *              used, how much to order and what it should cost — and, where
 *              the Inventory module is on, a purchase request raised from it
 *   costs      what the Medical Room used and bought, month by month
 *   disposal   the register of medicine taken out of use, and how it went
 *   fridge     the medicine fridge's daily temperature; out of 2–8 °C tells
 *              the medical staff at once; a school day without a reading by
 *              noon is reminded (the sweep)
 */
const pool = require('../db/pool');
const { patch, insert } = require('../db/patch');
const MedicalLocation = require('../models/MedicalLocation');
const MedicalDisposal = require('../models/MedicalDisposal');
const MedicalTempLog = require('../models/MedicalTempLog');
const settingsSvc = require('./medicalSettings');
const stock = require('./medicalStock');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const R = require('./medicalRules');

const { refuse, notFound, str, num, oneOf, bool, isUuid, todayStr } = R;
const S = (v) => String(v);
const who = (req) => req.user?.name || '';
const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const r2 = (n) => Math.round(Number(n) * 100) / 100;

const PLACE_KIND = { room: 'Medical room', kit: 'First-aid kit', bus: 'Bus kit', hostel: 'Hostel', lab: 'Laboratory', sports: 'Sports kit', other: 'Other' };
const DISPOSAL_METHOD = {
    pharmacy_return: 'Returned to a pharmacy', supplier_return: 'Returned to the supplier', incineration: 'Incinerated (clinical waste)',
    sharps_bin: 'Sharps bin', drain_safe: 'Disposed of as the label allows', other: 'Other',
};
const FRIDGE_MIN = 2;
const FRIDGE_MAX = 8;

/* ── Places ───────────────────────────────────────────────────────────────── */

/** The main Medical Room — created, named after the room, the first time it is needed. */
async function ensureMain(schoolId) {
    const [m] = await run(`SELECT * FROM "medicallocations" WHERE "school" = $1 AND "isMain" = true LIMIT 1`, [S(schoolId)]);
    if (m) return m;
    const s = await settingsSvc.get(schoolId);
    try {
        const row = await insert(MedicalLocation, { school: schoolId, name: s.roomName || 'Medical Room', kind: 'room', isMain: true, place: s.roomLocation || '', sortOrder: 0 });
        return typeof row.toObject === 'function' ? row.toObject() : row;
    } catch {
        const [again] = await run(`SELECT * FROM "medicallocations" WHERE "school" = $1 AND "isMain" = true LIMIT 1`, [S(schoolId)]);
        return again;
    }
}

/** Every place, with what it holds: { _id, name, kind, isMain, items, units, expiring, expired, lastCheckedAt }. */
async function places(req, { all = false } = {}) {
    const main = await ensureMain(req.schoolId);
    const rows = await run(
        `SELECT l.*, l."_id"::text AS "_id",
                COALESCE(st."items", 0)::int AS "items", COALESCE(st."units", 0)::float8 AS "units",
                COALESCE(st."expiring", 0)::int AS "expiring", COALESCE(st."expired", 0)::int AS "expired"
           FROM "medicallocations" l
           LEFT JOIN LATERAL (
                SELECT count(DISTINCT b."item") AS "items", SUM(b."quantity") AS "units",
                       count(*) FILTER (WHERE b."expiryDate" IS NOT NULL AND (b."expiryDate" AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $2::date + 30) AS "expiring",
                       count(*) FILTER (WHERE b."expiryDate" IS NOT NULL AND (b."expiryDate" AT TIME ZONE 'UTC')::date < $2::date) AS "expired"
                  FROM "medicalbatches" b
                 WHERE b."school" = l."school" AND b."status" = 'active' AND b."quantity" > 0
                   AND (b."location" = l."_id" OR (l."isMain" AND b."location" IS NULL))
           ) st ON TRUE
          WHERE l."school" = $1 ${all ? '' : 'AND l."isActive" IS NOT FALSE'}
          ORDER BY l."isMain" DESC, l."sortOrder", l."name"`,
        [S(req.schoolId), todayStr()],
    );
    return { places: rows.map((r) => ({ ...r, kindLabel: PLACE_KIND[r.kind] || r.kind })), mainId: S(main._id) };
}

async function findPlace(req, id) {
    if (!isUuid(id)) notFound('Place');
    const p = await MedicalLocation.findOne({ _id: id, school: req.schoolId }).lean();
    if (!p) notFound('Place');
    return p;
}

function placeFields(body, prev = {}) {
    const out = {};
    if (body.name !== undefined || !prev._id) { out.name = str(body.name ?? prev.name, 80); if (!out.name) refuse('Give the place a name'); }
    if (body.kind !== undefined) out.kind = oneOf(body.kind, PLACE_KIND, prev.kind || 'kit');
    for (const k of ['place', 'keeper']) if (body[k] !== undefined) out[k] = str(body[k], 120);
    if (body.note !== undefined) out.note = str(body.note, 300);
    if (body.sortOrder !== undefined) out.sortOrder = Math.max(0, Math.min(999, num(body.sortOrder) || 0));
    return out;
}

async function addPlace(req, body = {}) {
    await ensureMain(req.schoolId);
    const f = placeFields(body);
    const [dup] = await run(`SELECT 1 FROM "medicallocations" WHERE "school" = $1 AND lower("name") = lower($2) AND "isActive" IS NOT FALSE`, [S(req.schoolId), f.name]);
    if (dup) refuse(`There is already a place called ${f.name}`);
    const row = await insert(MedicalLocation, { school: req.schoolId, kind: 'kit', ...f, isMain: false });
    audit.log(req, { action: 'created', entity: 'location', entityId: row._id, summary: `New place: ${row.name} (${PLACE_KIND[row.kind]})` });
    return typeof row.toObject === 'function' ? row.toObject() : row;
}

async function updatePlace(req, id, body = {}) {
    const p = await findPlace(req, id);
    const set = placeFields(body, p);
    if (p.isMain && set.kind && set.kind !== 'room') refuse('The main Medical Room stays a room');
    if (body.isActive !== undefined && !bool(body.isActive)) {
        if (p.isMain) refuse('The main Medical Room cannot be closed');
        const [held] = await run(`SELECT count(*)::int AS n FROM "medicalbatches" WHERE "location" = $1 AND "status" = 'active' AND "quantity" > 0`, [S(id)]);
        if (held.n) refuse(`${p.name} still holds stock — move it or write it off first`);
        set.isActive = false;
    } else if (body.isActive !== undefined) set.isActive = true;
    const row = await patch(MedicalLocation, id, set, { where: { school: req.schoolId } });
    audit.log(req, { action: set.isActive === false ? 'closed' : 'updated', entity: 'location', entityId: id, summary: `${row.name}${set.isActive === false ? ' closed' : ' changed'}` });
    return row;
}

/** A kit looked over: everything there, in date. */
async function checkPlace(req, id, body = {}) {
    const p = await findPlace(req, id);
    const note = str(body.note, 300);
    const row = await patch(MedicalLocation, id, { lastCheckedAt: new Date(), lastCheckedName: who(req), note: note || p.note }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'checked', entity: 'location', entityId: id, summary: `${p.name} checked${note ? ` — ${note}` : ''}` });
    return row;
}

/** What one place holds, batch by batch. */
async function placeStock(req, id) {
    const p = await findPlace(req, id);
    const rows = await run(
        `SELECT b."_id"::text AS "_id", b."batchNumber", b."quantity", b."expiryDate", i."_id"::text AS "item", i."name", i."strength", i."unit", i."kind",
                (b."expiryDate" AT TIME ZONE 'UTC')::date - $3::date AS "daysLeft"
           FROM "medicalbatches" b JOIN "medicalitems" i ON i."_id" = b."item"
          WHERE b."school" = $1 AND b."status" = 'active' AND b."quantity" > 0 AND (b."location" = $2 OR ($4 AND b."location" IS NULL))
          ORDER BY i."name", b."expiryDate" NULLS LAST`,
        [S(req.schoolId), S(id), todayStr(), !!p.isMain],
    );
    return { place: { ...p, kindLabel: PLACE_KIND[p.kind] }, batches: rows };
}

async function transfer(req, body = {}) {
    const out = await stock.transfer(req, { item: body.item, from: body.from || null, to: body.to || null, quantity: body.quantity, note: body.note });
    audit.log(req, { action: 'transferred', entity: 'medicine', entityId: out.item, summary: `Moved ${out.quantity} from ${out.from} to ${out.to}` });
    return out;
}

/* ── Reorder and costs ────────────────────────────────────────────────────── */

/**
 * What to order: items low on stock, or that will run out within `days` at
 * the pace of the last 30 days. Suggested = a month's use + the minimum − what is usable.
 */
async function reorder(req, { days = 30 } = {}) {
    const horizon = Math.min(Math.max(Number(days) || 30, 7), 120);
    const rows = await run(
        `SELECT i."_id"::text AS "_id", i."name", i."strength", i."unit", i."kind", i."category", i."minStock", i."supplier",
                COALESCE((SELECT SUM(b."quantity") FROM "medicalbatches" b WHERE b."item" = i."_id" AND b."status" = 'active'
                          AND (b."expiryDate" IS NULL OR (b."expiryDate" AT TIME ZONE 'UTC')::date >= $2::date)), 0)::float8 AS "usable",
                COALESCE((SELECT -SUM(m."quantity") FROM "medicalstockmoves" m WHERE m."item" = i."_id"
                          AND m."type" IN ('administered','first_aid','stock_out') AND m."createdAt" > now() - interval '30 days'), 0)::float8 AS "used30",
                (SELECT b."unitCost" FROM "medicalbatches" b WHERE b."item" = i."_id" AND b."unitCost" > 0 ORDER BY b."createdAt" DESC LIMIT 1)::float8 AS "lastCost"
           FROM "medicalitems" i WHERE i."school" = $1 AND i."isActive" IS NOT FALSE
          ORDER BY i."name"`,
        [S(req.schoolId), todayStr()],
    );
    const out = [];
    for (const r of rows) {
        const perDay = r.used30 / 30;
        const daysLeft = perDay > 0 ? Math.floor(r.usable / perDay) : null;
        const low = r.usable <= (Number(r.minStock) || 0);
        const soon = daysLeft !== null && daysLeft <= horizon;
        if (!low && !soon) continue;
        const want = perDay > 0 ? Math.ceil(perDay * horizon + (Number(r.minStock) || 0) - r.usable) : Math.ceil((Number(r.minStock) || 0) * 2 - r.usable);
        const suggested = Math.max(1, want);
        out.push({
            ...r, usable: r2(r.usable), used30: r2(r.used30), perDay: r2(perDay), daysLeft, low, suggested,
            estimate: r.lastCost ? r2(r.lastCost * suggested) : null,
            why: low ? (r.usable <= 0 ? 'Out of stock' : `At or below the minimum of ${r.minStock}`) : `Runs out in about ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        });
    }
    out.sort((a, b) => Number(b.usable <= 0) - Number(a.usable <= 0) || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
    const inventoryOn = await inventoryEnabled(req.schoolId);
    return { rows: out, total: r2(out.reduce((t, r) => t + (r.estimate || 0), 0)), inventory: inventoryOn };
}

async function inventoryEnabled(schoolId) {
    const [s] = await run(`SELECT ("modules"->>'inventory')::boolean AS on FROM "schools" WHERE "_id" = $1`, [S(schoolId)]);
    return !!s?.on;
}

/**
 * Raise an Inventory purchase request from the reorder list:
 * body { lines: [{ item, quantity }], priority, reason }.
 */
async function raisePurchaseRequest(req, body = {}) {
    if (!(await inventoryEnabled(req.schoolId))) refuse('The Inventory module is not on for this school — order the usual way', 409, 'MEDICAL_NO_INVENTORY');
    const lines = Array.isArray(body.lines) ? body.lines.slice(0, 50) : [];
    if (!lines.length) refuse('Choose what to order');
    const items = [];
    for (const l of lines) {
        if (!isUuid(l?.item)) refuse('Choose items from the list');
        const quantity = Math.ceil(num(l.quantity) || 0);
        if (quantity < 1) refuse('Give how many of each');
        const [i] = await run(
            `SELECT i."name", i."strength", i."unit", (SELECT b."unitCost" FROM "medicalbatches" b WHERE b."item" = i."_id" AND b."unitCost" > 0 ORDER BY b."createdAt" DESC LIMIT 1)::float8 AS "lastCost"
               FROM "medicalitems" i WHERE i."_id" = $1 AND i."school" = $2`, [S(l.item), S(req.schoolId)],
        );
        if (!i) refuse('One of the items is not the Medical Room\'s');
        items.push({ item: null, itemName: `${i.name}${i.strength ? ` ${i.strength}` : ''} (Medical Room)`, quantity, unit: i.unit || 'Nos', estimatedPrice: Number(i.lastCost) || 0 });
    }
    const PurchaseRequest = require('../models/PurchaseRequest');
    const { nextNumber } = require('./inventoryNumber');
    const estimatedTotal = r2(items.reduce((t, i) => t + i.quantity * i.estimatedPrice, 0));
    const requestNumber = await nextNumber(req.schoolId, 'request');
    const pr = await PurchaseRequest.create({
        school: req.schoolId, requestNumber, requestedBy: req.userId, department: null,
        reason: str(body.reason, 300) || 'Medical Room reorder', priority: oneOf(body.priority, { low: 1, normal: 1, high: 1, urgent: 1 }, 'normal'),
        items, estimatedTotal, status: 'pending', checks: { stockAvailable: false, budgetOk: true, possibleDuplicate: false },
    });
    try {
        await require('../models/InventoryAuditLog').create({
            school: req.schoolId, user: req.userId, role: req.userRole, actionType: 'PR_CREATED', entityType: 'PurchaseRequest', entityId: pr._id,
            description: `Purchase request ${requestNumber} raised from the Medical Room reorder list`,
        });
    } catch { /* the Inventory trail is not critical */ }
    audit.log(req, { action: 'purchase_request', entity: 'medicine', summary: `Raised ${requestNumber}: ${items.map((i) => `${i.quantity} × ${i.itemName}`).join(', ')}` });
    const { notify, schoolAdminIds } = require('./notifyService');
    schoolAdminIds(req.schoolId).then((admins) => notify({
        school: req.schoolId, sender: req.userId, senderRole: req.userRole, recipients: admins,
        title: '📦 New purchase request — Medical Room',
        body: `${who(req)} raised ${requestNumber} (${items.length} item${items.length === 1 ? '' : 's'}, est. ₹${estimatedTotal.toLocaleString('en-IN')}).`,
        link: { type: 'inventory.requests', entityId: pr._id },
    })).catch(() => {});
    return { requestNumber, _id: S(pr._id), estimatedTotal };
}

/** What was used and bought, month by month (default 12 months), and this month's biggest costs. */
async function costs(req, { months = 12 } = {}) {
    const n = Math.min(Math.max(Number(months) || 12, 1), 36);
    const tz = R.ZONE;
    const byMonth = await run(
        `SELECT to_char(date_trunc('month', m."createdAt" AT TIME ZONE '${tz}'), 'YYYY-MM') AS "month",
                COALESCE(SUM(CASE WHEN m."type" IN ('administered','first_aid','stock_out') THEN -m."quantity" * COALESCE(b."unitCost", 0) END), 0)::float8 AS "used",
                COALESCE(SUM(CASE WHEN m."type" = 'stock_in' THEN m."quantity" * COALESCE(b."unitCost", 0) END), 0)::float8 AS "bought",
                COALESCE(SUM(CASE WHEN m."type" IN ('expired','damaged','disposed') THEN -m."quantity" * COALESCE(b."unitCost", 0) END), 0)::float8 AS "wasted"
           FROM "medicalstockmoves" m LEFT JOIN "medicalbatches" b ON b."_id" = m."batch"
          WHERE m."school" = $1 AND m."createdAt" > date_trunc('month', now()) - make_interval(months => $2::int - 1)
          GROUP BY 1 ORDER BY 1`,
        [S(req.schoolId), n],
    );
    const top = await run(
        `SELECT i."name", i."strength", SUM(-m."quantity")::float8 AS "quantity", i."unit", SUM(-m."quantity" * COALESCE(b."unitCost", 0))::float8 AS "value"
           FROM "medicalstockmoves" m JOIN "medicalitems" i ON i."_id" = m."item" LEFT JOIN "medicalbatches" b ON b."_id" = m."batch"
          WHERE m."school" = $1 AND m."type" IN ('administered','first_aid','stock_out') AND m."createdAt" >= date_trunc('month', now())
          GROUP BY i."_id" ORDER BY 5 DESC NULLS LAST, 3 DESC LIMIT 10`,
        [S(req.schoolId)],
    );
    return { months: byMonth.map((r) => ({ ...r, used: r2(r.used), bought: r2(r.bought), wasted: r2(r.wasted) })), top: top.map((t) => ({ ...t, value: r2(t.value) })) };
}

/* ── Disposal register ────────────────────────────────────────────────────── */

async function disposals(req, { status = 'awaiting' } = {}) {
    const st = ['awaiting', 'disposed', 'all'].includes(status) ? status : 'awaiting';
    const rows = await run(
        `SELECT *, "_id"::text AS "_id" FROM "medicaldisposals" WHERE "school" = $1 ${st === 'all' ? '' : 'AND "status" = $2'} ORDER BY "createdAt" DESC LIMIT 200`,
        st === 'all' ? [S(req.schoolId)] : [S(req.schoolId), st],
    );
    const [c] = await run(`SELECT count(*) FILTER (WHERE "status" = 'awaiting')::int AS "awaiting", count(*) FILTER (WHERE "status" = 'disposed')::int AS "disposed" FROM "medicaldisposals" WHERE "school" = $1`, [S(req.schoolId)]);
    return { rows: rows.map((r) => ({ ...r, methodLabel: DISPOSAL_METHOD[r.method] || '' })), counts: c };
}

/** How it finally went: body { method, reference, witness, note }. */
async function dispose(req, id, body = {}) {
    if (!isUuid(id)) notFound('Disposal');
    const d = await MedicalDisposal.findOne({ _id: id, school: req.schoolId }).lean();
    if (!d) notFound('Disposal');
    if (d.status === 'disposed') refuse('Already recorded as disposed');
    const method = oneOf(body.method, DISPOSAL_METHOD, null);
    if (!method) refuse('Say how it was disposed of');
    let witness = { witnessBy: null, witnessName: '' };
    if (body.witness) {
        if (!isUuid(body.witness) || S(body.witness) === S(req.userId)) refuse('The witness must be another member of staff');
        const [u] = await run(`SELECT "name" FROM "users" WHERE "_id" = $1 AND "school" = $2 AND "role" IN ('teacher','school_admin')`, [S(body.witness), S(req.schoolId)]);
        if (!u) refuse('The witness must be a member of this school\'s staff');
        witness = { witnessBy: S(body.witness), witnessName: u.name };
    }
    const [item] = await run(`SELECT "controlled" FROM "medicalitems" WHERE "_id" = $1`, [S(d.item)]);
    if (item?.controlled && !witness.witnessBy) refuse('A controlled medicine is destroyed in front of a witness', 409, 'MEDICAL_WITNESS_REQUIRED');
    const row = await patch(MedicalDisposal, id, {
        status: 'disposed', method, reference: str(body.reference, 120), note: str(body.note, 300) || d.note,
        disposedAt: new Date(), disposedBy: req.userId, disposedByName: who(req), ...witness,
    }, { where: { school: req.schoolId, status: 'awaiting' } });
    if (!row) refuse('Someone recorded this a moment ago', 409, 'MEDICAL_STALE');
    audit.log(req, { action: 'disposed', entity: 'medicine', entityId: d.item, summary: `${d.quantity} ${d.unit} ${d.itemName}${d.batchNumber ? ` (batch ${d.batchNumber})` : ''}: ${DISPOSAL_METHOD[method]}${witness.witnessName ? `, witnessed by ${witness.witnessName}` : ''}` });
    return row;
}

/* ── The fridge ───────────────────────────────────────────────────────────── */

async function logTemp(req, body = {}) {
    const current = num(body.current);
    if (current === null || current < -30 || current > 40) refuse('Give the fridge temperature in °C');
    const min = body.min === undefined || body.min === '' ? null : num(body.min);
    const max = body.max === undefined || body.max === '' ? null : num(body.max);
    if (min !== null && max !== null && min > max) refuse('The minimum is above the maximum');
    let location = null;
    if (body.location) location = S((await findPlace(req, body.location))._id);
    const outOfRange = current < FRIDGE_MIN || current > FRIDGE_MAX || (min !== null && min < FRIDGE_MIN) || (max !== null && max > FRIDGE_MAX);
    const action = str(body.action, 300);
    if (outOfRange && !action) refuse(`Outside ${FRIDGE_MIN}–${FRIDGE_MAX} °C: say what you did (for example "moved vaccines to the spare fridge, rang the supplier")`, 400, 'MEDICAL_FRIDGE_ACTION');
    const row = await insert(MedicalTempLog, {
        school: req.schoolId, location, fridge: str(body.fridge, 80) || 'Medicine fridge', at: new Date(), current, min, max, reset: bool(body.reset),
        outOfRange, action, by: req.userId, byName: who(req),
    });
    audit.log(req, { action: outOfRange ? 'fridge_out_of_range' : 'fridge_logged', entity: 'fridge', entityId: row._id, summary: `${row.fridge}: ${current} °C${min !== null ? `, min ${min}` : ''}${max !== null ? `, max ${max}` : ''}${outOfRange ? ` — OUT OF RANGE: ${action}` : ''}` });
    if (outOfRange) {
        tell.toStaff(req, {
            title: `${row.fridge} out of range — ${current} °C`,
            body: `${who(req)} read ${current} °C${min !== null ? ` (min ${min})` : ''}${max !== null ? ` (max ${max})` : ''}. Vaccines and insulin must stay at ${FRIDGE_MIN}–${FRIDGE_MAX} °C: check them before use. Action taken: ${action}`,
            urgent: true, link: { type: 'medical.desk' },
        });
    }
    return typeof row.toObject === 'function' ? row.toObject() : row;
}

async function tempLogs(req, { days = 30 } = {}) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    const rows = await run(
        `SELECT *, "_id"::text AS "_id" FROM "medicaltemplogs" WHERE "school" = $1 AND "at" > now() - make_interval(days => $2::int) ORDER BY "at" DESC LIMIT 400`,
        [S(req.schoolId), d],
    );
    const tz = R.ZONE;
    const [today] = await run(
        `SELECT count(*)::int AS n FROM "medicaltemplogs" WHERE "school" = $1 AND ("at" AT TIME ZONE '${tz}')::date = (now() AT TIME ZONE '${tz}')::date`,
        [S(req.schoolId)],
    );
    return { rows, loggedToday: today.n > 0, range: { min: FRIDGE_MIN, max: FRIDGE_MAX } };
}

/**
 * The sweep, after noon on a weekday: a school that keeps a fridge log and has
 * no reading today is reminded — once a day (the claim).
 */
async function sweepFridge(schoolId, staff, claim) {
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6 || now.getHours() < 12) return;
    const tz = R.ZONE;
    const [s] = await run(
        `SELECT
            (SELECT count(*)::int FROM "medicaltemplogs" WHERE "school" = $1 AND "at" > now() - interval '30 days') AS "recent",
            (SELECT count(*)::int FROM "medicaltemplogs" WHERE "school" = $1 AND ("at" AT TIME ZONE '${tz}')::date = (now() AT TIME ZONE '${tz}')::date) AS "today"`,
        [S(schoolId)],
    );
    if (!s.recent || s.today) return;
    if (!(await claim(schoolId, 'fridge_unlogged', todayStr(), 'warning'))) return;
    await tell.system(schoolId, {
        to: staff, title: 'Fridge temperature not logged today',
        body: `No reading of the medicine fridge has been recorded today. Vaccines and insulin must stay at ${FRIDGE_MIN}–${FRIDGE_MAX} °C — read the thermometer and log it.`,
        link: { type: 'medical.desk' },
    });
}

module.exports = {
    PLACE_KIND, DISPOSAL_METHOD, FRIDGE_MIN, FRIDGE_MAX,
    ensureMain, places, findPlace, addPlace, updatePlace, checkPlace, placeStock, transfer,
    reorder, raisePurchaseRequest, costs, inventoryEnabled,
    disposals, dispose, logTemp, tempLogs, sweepFridge,
};
