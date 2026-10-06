'use strict';
/**
 * The one writer of Medical Room stock (Oct 2026).
 *
 * Stock is held in batches, and every change goes through here:
 *
 *   receive   a delivery — a new batch and a stock_in movement
 *   consume   doses, first aid, issues — taken first-expiry-first-out from
 *             batches that are still in date
 *   giveBack  a dose recorded in error — returned to the batches it came from
 *   adjust    a stock-take correction of one batch
 *   writeOff  expired, damaged or disposed — out of one batch (and onto the disposal register)
 *   transfer  from one place to another (the room, a first-aid kit, the bus) —
 *             the school's total does not change
 *
 * Every batch is at a place (MedicalLocation; null = the main Medical Room).
 * A consume takes from the main room unless it names another place.
 *
 * Each runs in ONE transaction that locks the item and its batches, changes
 * the balances, writes the ledger rows (MedicalStockMove) and re-totals the
 * item — so the ledger can never disagree with the balance it describes, and
 * two doses of the last strip cannot both be given. A caller composing a
 * bigger write (a visit with its medicines) passes its own transaction `q`.
 *
 * Expired stock is never dispensed: a consume that could only be met from a
 * batch past its date is refused and says so.
 */
const { withTransaction } = require('../db/pool');
const { newId } = require('../db/schema');
const { refuse, todayStr, dayStr, toDay, str, num } = require('./medicalRules');

const ITEMS = '"medicalitems"';
const BATCHES = '"medicalbatches"';
const MOVES = '"medicalstockmoves"';

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const tx = (q, fn) => (q ? fn(q) : withTransaction(fn));

async function lockItem(q, schoolId, itemId) {
    const { rows } = await q(`SELECT * FROM ${ITEMS} WHERE "_id" = $1::uuid AND "school" = $2::uuid FOR UPDATE`, [String(itemId), String(schoolId)]);
    if (!rows[0]) refuse('Item not found', 404, 'MEDICAL_NOT_FOUND');
    return rows[0];
}

/** Re-total an item from its batches. Physical stock: every batch still on the shelf. */
async function retotal(q, itemId) {
    const { rows } = await q(
        `UPDATE ${ITEMS} SET "stock" = COALESCE((SELECT ROUND(SUM("quantity")::numeric, 2)::float8 FROM ${BATCHES}
                 WHERE "item" = $1::uuid AND "status" = 'active'), 0), "updatedAt" = now()
          WHERE "_id" = $1::uuid RETURNING "stock"`,
        [String(itemId)],
    );
    return Number(rows[0]?.stock) || 0;
}

async function writeMove(q, ctx, item, { batch, type, quantity, itemBalance, batchBalance, reason = '', refKind = '', refId = null, student = null }) {
    await q(
        `INSERT INTO ${MOVES} ("_id","school","item","batch","kind","type","quantity","itemBalance","batchBalance",
                               "reason","refKind","refId","student","by","byName","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())`,
        [newId(), String(ctx.schoolId), String(item._id), batch ? String(batch) : null, item.kind, type, r2(quantity),
            r2(itemBalance), r2(batchBalance), str(reason, 300), refKind || '', refId ? String(refId) : null,
            student ? String(student) : null, ctx.userId ? String(ctx.userId) : null, ctx.user?.name || ctx.userName || ''],
    );
}

function positive(v, what = 'Quantity') {
    const n = num(v);
    if (n === null || n <= 0) refuse(`${what} must be more than zero`);
    if (n > 1000000) refuse(`${what} is too large`);
    return r2(n);
}

/** A place of this school, checked; null stays null (the main room). */
async function placeOf(run, schoolId, id) {
    if (!id) return null;
    const { rows } = await run(`SELECT "_id", "name", "isMain", "isActive" FROM "medicallocations" WHERE "_id" = $1::uuid AND "school" = $2::uuid`, [String(id), String(schoolId)]);
    if (!rows[0]) refuse('That place is not one of the school\'s', 404, 'MEDICAL_NOT_FOUND');
    if (rows[0].isActive === false) refuse(`${rows[0].name} is closed`);
    return rows[0];
}

/** SQL that picks the batches at a place: the main room is also every batch with no place. */
async function atPlace(run, schoolId, location, params) {
    if (location === 'any') return '';
    const place = await placeOf(run, schoolId, location);
    if (place && !place.isMain) { params.push(String(place._id)); return ` AND "location" = $${params.length}::uuid`; }
    const { rows } = await run(`SELECT "_id" FROM "medicallocations" WHERE "school" = $1::uuid AND "isMain" = true LIMIT 1`, [String(schoolId)]);
    if (!rows[0]) return ' AND "location" IS NULL';
    params.push(String(rows[0]._id));
    return ` AND ("location" IS NULL OR "location" = $${params.length}::uuid)`;
}

/**
 * A delivery. Returns { batch, stock }.
 * body: { item, quantity, batchNumber, expiryDate, purchaseDate, supplier, unitCost, note }
 */
async function receive(ctx, body, q) {
    const quantity = positive(body.quantity);
    const expiry = toDay(body.expiryDate);
    if (body.expiryDate && !expiry) refuse('The expiry date is not a date');
    if (expiry && dayStr(expiry) < todayStr()) refuse('That batch has already expired — record it and write it off, or check the date');
    return tx(q, async (run) => {
        const item = await lockItem(run, ctx.schoolId, body.item);
        if (item.isActive === false) refuse('This item is archived — restore it before receiving stock');
        if (item.kind === 'medicine' && !expiry) refuse('A medicine batch needs its expiry date');
        const place = await placeOf(run, ctx.schoolId, body.location);
        const batchId = newId();
        await run(
            `INSERT INTO ${BATCHES} ("_id","school","item","batchNumber","quantity","received","unitCost","supplier",
                                     "purchaseDate","expiryDate","status","note","location","createdBy","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,'active',$10,$11,$12, now(), now())`,
            [batchId, String(ctx.schoolId), String(item._id), str(body.batchNumber, 60), quantity, Math.max(0, num(body.unitCost) || 0),
                str(body.supplier || item.supplier, 120), toDay(body.purchaseDate) || toDay(new Date()), expiry, str(body.note, 300),
                place && !place.isMain ? String(place._id) : null, ctx.userId ? String(ctx.userId) : null],
        );
        const stock = await retotal(run, item._id);
        await writeMove(run, ctx, item, { batch: batchId, type: 'stock_in', quantity, itemBalance: stock, batchBalance: quantity, reason: body.note || 'Received', refKind: 'batch', refId: batchId });
        return { batch: batchId, stock };
    });
}

/**
 * Take `quantity` of an item out of stock, first-expiry-first-out.
 * Returns { batches: [{ batch, batchNumber, quantity, expiryDate }], stock }.
 *
 * opts: { item, quantity, type (administered | first_aid | stock_out | disposed),
 *         batch (take from this one only), reason, refKind, refId, student }
 */
async function consume(ctx, opts, q) {
    const quantity = positive(opts.quantity);
    const type = ['administered', 'first_aid', 'stock_out', 'disposed'].includes(opts.type) ? opts.type : 'stock_out';
    return tx(q, async (run) => {
        const item = await lockItem(run, ctx.schoolId, opts.item);
        const params = [String(item._id)];
        let only = '';
        if (opts.batch) { params.push(String(opts.batch)); only = ` AND "_id" = $2::uuid`; }
        // From the room's own shelf unless a place (or a batch) is named.
        else only = await atPlace(run, ctx.schoolId, opts.location, params);
        const { rows: batches } = await run(
            `SELECT * FROM ${BATCHES} WHERE "item" = $1::uuid AND "status" = 'active' AND "quantity" > 0${only}
              ORDER BY "expiryDate" ASC NULLS LAST, "createdAt" ASC FOR UPDATE`,
            params,
        );
        const today = todayStr();
        const usable = batches.filter((b) => !b.expiryDate || dayStr(b.expiryDate) >= today);
        const expiredQty = r2(batches.filter((b) => !usable.includes(b)).reduce((s, b) => s + Number(b.quantity), 0));
        const available = r2(usable.reduce((s, b) => s + Number(b.quantity), 0));
        if (available < quantity) {
            const unit = item.unit || 'units';
            // Somewhere else in the school? Say so — it can be moved to the room.
            const { rows: elsewhere } = only && !opts.batch ? await run(
                `SELECT COALESCE(SUM("quantity"), 0)::float8 AS n FROM ${BATCHES} WHERE "item" = $1::uuid AND "status" = 'active' AND "quantity" > 0
                    AND ("expiryDate" IS NULL OR ("expiryDate" AT TIME ZONE 'UTC')::date >= $2::date)`, [String(item._id), today],
            ) : { rows: [{ n: available }] };
            const away = r2(Number(elsewhere[0].n) - available);
            refuse(
                `Not enough ${item.name} in date: ${available} ${unit} available, ${quantity} needed`
                + (expiredQty > 0 ? ` (${expiredQty} more is past its expiry date and cannot be given)` : '')
                + (away > 0 ? ` — ${away} ${unit} more are kept at other places; move some here first` : ''),
                409, 'MEDICAL_INSUFFICIENT_STOCK', { available, wanted: quantity, elsewhere: away },
            );
        }
        let left = quantity;
        const taken = [];
        for (const b of usable) {
            if (left <= 0) break;
            const n = r2(Math.min(left, Number(b.quantity)));
            const rest = r2(Number(b.quantity) - n);
            await run(`UPDATE ${BATCHES} SET "quantity" = $2, "status" = $3, "updatedAt" = now() WHERE "_id" = $1::uuid`,
                [String(b._id), rest, rest <= 0 ? 'depleted' : 'active']);
            taken.push({ batch: String(b._id), batchNumber: b.batchNumber || '', quantity: n, expiryDate: b.expiryDate, rest });
            left = r2(left - n);
        }
        const stock = await retotal(run, item._id);
        // The ledger: one row per batch, each with the item's balance as it
        // stood after that row — so the running balance reads true.
        let running = r2(stock + quantity);
        for (const t of taken) {
            running = r2(running - t.quantity);
            await writeMove(run, ctx, item, {
                batch: t.batch, type, quantity: -t.quantity, itemBalance: running, batchBalance: t.rest,
                reason: opts.reason, refKind: opts.refKind, refId: opts.refId, student: opts.student,
            });
        }
        return { batches: taken.map(({ rest, ...t }) => t), stock, item: { _id: String(item._id), name: item.name, unit: item.unit } };
    });
}

/** Put back what a consume took (a dose recorded in error). `batches` as consume returned them. */
async function giveBack(ctx, { item, batches = [], reason = 'Returned', refKind = '', refId = null, student = null }, q) {
    const list = (batches || []).filter((b) => b?.batch && Number(b.quantity) > 0);
    if (!list.length) return { stock: null };
    return tx(q, async (run) => {
        const it = await lockItem(run, ctx.schoolId, item);
        const done = [];
        for (const b of list) {
            const { rows } = await run(`SELECT * FROM ${BATCHES} WHERE "_id" = $1::uuid AND "item" = $2::uuid FOR UPDATE`, [String(b.batch), String(it._id)]);
            const row = rows[0];
            if (!row) continue;
            const n = r2(b.quantity);
            if (!['active', 'depleted'].includes(row.status)) {
                // Written off since the dose (expired, damaged, disposed): the
                // units come back and go straight out again with the batch — a
                // returned row and a write-off row, so the ledger still sums to
                // the stock and the batch stays at what it was.
                done.push({ batch: String(row._id), quantity: n, rest: r2(row.quantity), writtenOff: row.status });
                continue;
            }
            // A batch used up by this dose is back on the shelf.
            const qty = r2(Number(row.quantity) + n);
            await run(`UPDATE ${BATCHES} SET "quantity" = $2, "status" = 'active', "updatedAt" = now() WHERE "_id" = $1::uuid`, [String(row._id), qty]);
            done.push({ batch: String(row._id), quantity: n, rest: qty });
        }
        const stock = await retotal(run, it._id);
        let running = r2(stock - done.filter((d) => !d.writtenOff).reduce((s, d) => s + d.quantity, 0));
        for (const d of done) {
            if (d.writtenOff) {
                await writeMove(run, ctx, it, { batch: d.batch, type: 'returned', quantity: d.quantity, itemBalance: r2(running + d.quantity), batchBalance: r2(d.rest + d.quantity), reason, refKind, refId, student });
                await writeMove(run, ctx, it, { batch: d.batch, type: d.writtenOff, quantity: -d.quantity, itemBalance: running, batchBalance: d.rest, reason: 'Returned to a batch already written off', refKind, refId, student });
                continue;
            }
            running = r2(running + d.quantity);
            await writeMove(run, ctx, it, { batch: d.batch, type: 'returned', quantity: d.quantity, itemBalance: running, batchBalance: d.rest, reason, refKind, refId, student });
        }
        return { stock };
    });
}

// Locks are always taken item first, then batch — the order consume() uses —
// so two writers can never hold one each and wait on the other.
async function findBatch(run, ctx, batchId) {
    const { rows } = await run(`SELECT "_id", "item" FROM ${BATCHES} WHERE "_id" = $1::uuid AND "school" = $2::uuid`, [String(batchId), String(ctx.schoolId)]);
    if (!rows[0]) refuse('Batch not found', 404, 'MEDICAL_NOT_FOUND');
    return rows[0];
}

/** A stock-take: this batch now holds `quantity`. */
async function adjust(ctx, { batch, quantity, reason }, q) {
    const target = num(quantity);
    if (target === null || target < 0) refuse('The counted quantity must be zero or more');
    if (!str(reason)) refuse('Say why the stock is being adjusted');
    return tx(q, async (run) => {
        const b0 = await findBatch(run, ctx, batch);
        const item = await lockItem(run, ctx.schoolId, b0.item);
        const b = (await run(`SELECT * FROM ${BATCHES} WHERE "_id" = $1::uuid FOR UPDATE`, [String(b0._id)])).rows[0];
        if (!['active', 'depleted'].includes(b.status)) refuse('This batch has been written off — it cannot be adjusted');
        const delta = r2(target - Number(b.quantity));
        if (!delta) refuse('The count matches what is recorded — nothing to adjust');
        const status = target > 0 ? 'active' : 'depleted';
        await run(`UPDATE ${BATCHES} SET "quantity" = $2, "status" = $3, "updatedAt" = now() WHERE "_id" = $1::uuid`, [String(b._id), r2(target), status]);
        const stock = await retotal(run, item._id);
        await writeMove(run, ctx, item, { batch: b._id, type: 'adjustment', quantity: delta, itemBalance: stock, batchBalance: r2(target), reason, refKind: 'batch', refId: b._id });
        return { stock, delta };
    });
}

/**
 * Remove stock that cannot be used: expired, damaged or disposed of.
 * Without a quantity the whole remaining batch goes, and the batch takes that
 * status; a part leaves the rest of the batch in stock.
 */
async function writeOff(ctx, { batch, quantity = null, type = 'expired', reason = '' }, q) {
    const kind = ['expired', 'damaged', 'disposed'].includes(type) ? type : 'disposed';
    return tx(q, async (run) => {
        const b0 = await findBatch(run, ctx, batch);
        const item = await lockItem(run, ctx.schoolId, b0.item);
        const b = (await run(`SELECT * FROM ${BATCHES} WHERE "_id" = $1::uuid FOR UPDATE`, [String(b0._id)])).rows[0];
        if (b.status !== 'active') refuse('This batch is not in stock');
        const have = Number(b.quantity);
        if (have <= 0) refuse('There is nothing left in this batch');
        const n = quantity === null || quantity === '' || quantity === undefined ? have : positive(quantity);
        if (n > have) refuse(`Only ${have} ${item.unit || 'units'} are left in this batch`);
        if (kind === 'expired' && b.expiryDate && dayStr(b.expiryDate) >= todayStr() && !str(reason)) {
            refuse('This batch is not past its expiry date — say why it is being written off as expired');
        }
        const rest = r2(have - n);
        const status = rest <= 0 ? kind : 'active';
        await run(`UPDATE ${BATCHES} SET "quantity" = $2, "status" = $3, "updatedAt" = now() WHERE "_id" = $1::uuid`, [String(b._id), rest, status]);
        const stock = await retotal(run, item._id);
        await writeMove(run, ctx, item, { batch: b._id, type: kind, quantity: -n, itemBalance: stock, batchBalance: rest, reason: reason || (kind === 'expired' ? 'Past expiry date' : ''), refKind: 'batch', refId: b._id });
        // Out of use is not yet gone: it waits on the disposal register until someone destroys or returns it.
        let disposal = null;
        if (kind !== 'disposed') {
            disposal = newId();
            await run(
                `INSERT INTO "medicaldisposals" ("_id","school","item","batch","itemName","batchNumber","quantity","unit","reason","note","status","method",
                                                 "createdBy","createdByName","createdAt","updatedAt")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'awaiting','',$11,$12, now(), now())`,
                [disposal, String(ctx.schoolId), String(item._id), String(b._id), item.name, b.batchNumber || '', n, item.unit || '', kind, str(reason, 300),
                    ctx.userId ? String(ctx.userId) : null, ctx.user?.name || ''],
            );
        }
        return { stock, quantity: n, status, disposal };
    });
}

/**
 * Move stock between places: { item, from, to, quantity, note }. Taken
 * first-expiry-first-out from `from` (in-date batches only); each part lands
 * at `to` in a batch with the same number and expiry (added to one that is
 * already there). Two ledger rows per part; the total does not change.
 */
async function transfer(ctx, { item: itemId, from = null, to = null, quantity, note = '' }, q) {
    const n = positive(quantity);
    return tx(q, async (run) => {
        const item = await lockItem(run, ctx.schoolId, itemId);
        const src = await placeOf(run, ctx.schoolId, from);
        const dst = await placeOf(run, ctx.schoolId, to);
        const srcKey = src && !src.isMain ? String(src._id) : null;
        const dstKey = dst && !dst.isMain ? String(dst._id) : null;
        if (srcKey === dstKey) refuse('Choose two different places');
        const params = [String(item._id)];
        const where = await atPlace(run, ctx.schoolId, from, params);
        const today = todayStr();
        const { rows: batches } = await run(
            `SELECT * FROM ${BATCHES} WHERE "item" = $1::uuid AND "status" = 'active' AND "quantity" > 0${where}
              ORDER BY "expiryDate" ASC NULLS LAST, "createdAt" ASC FOR UPDATE`, params,
        );
        const usable = batches.filter((b) => !b.expiryDate || dayStr(b.expiryDate) >= today);
        const have = r2(usable.reduce((t, b) => t + Number(b.quantity), 0));
        if (have < n) refuse(`Only ${have} ${item.unit || 'units'} of ${item.name} in date at ${src?.name || 'the Medical Room'}`);
        let left = n;
        const stock = Number(item.stock) || 0;
        const why = str(note, 200) || `${src?.name || 'Medical Room'} → ${dst?.name || 'Medical Room'}`;
        for (const b of usable) {
            if (left <= 0) break;
            const part = r2(Math.min(left, Number(b.quantity)));
            const rest = r2(Number(b.quantity) - part);
            await run(`UPDATE ${BATCHES} SET "quantity" = $2, "status" = $3, "updatedAt" = now() WHERE "_id" = $1::uuid`, [String(b._id), rest, rest <= 0 ? 'depleted' : 'active']);
            const { rows: same } = await run(
                `SELECT "_id", "quantity" FROM ${BATCHES} WHERE "item" = $1::uuid AND "status" = 'active' AND "batchNumber" = $2
                    AND "expiryDate" IS NOT DISTINCT FROM $3 AND "location" IS NOT DISTINCT FROM $4::uuid AND "_id" <> $5::uuid LIMIT 1 FOR UPDATE`,
                [String(item._id), b.batchNumber || '', b.expiryDate, dstKey, String(b._id)],
            );
            let target; let targetQty;
            if (same[0]) {
                target = String(same[0]._id); targetQty = r2(Number(same[0].quantity) + part);
                await run(`UPDATE ${BATCHES} SET "quantity" = $2, "updatedAt" = now() WHERE "_id" = $1::uuid`, [target, targetQty]);
            } else {
                target = newId(); targetQty = part;
                await run(
                    `INSERT INTO ${BATCHES} ("_id","school","item","batchNumber","quantity","received","unitCost","supplier","purchaseDate","expiryDate","status","note","location","createdBy","createdAt","updatedAt")
                     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,'active',$10,$11,$12, now(), now())`,
                    [target, String(ctx.schoolId), String(item._id), b.batchNumber || '', part, Number(b.unitCost) || 0, b.supplier || '', b.purchaseDate, b.expiryDate,
                        `Moved from ${src?.name || 'the Medical Room'}`, dstKey, ctx.userId ? String(ctx.userId) : null],
                );
            }
            await writeMove(run, ctx, item, { batch: b._id, type: 'transfer_out', quantity: -part, itemBalance: stock, batchBalance: rest, reason: why, refKind: 'batch', refId: target });
            await writeMove(run, ctx, item, { batch: target, type: 'transfer_in', quantity: part, itemBalance: stock, batchBalance: targetQty, reason: why, refKind: 'batch', refId: b._id });
            left = r2(left - part);
        }
        await retotal(run, item._id);
        return { item: String(item._id), quantity: n, from: src?.name || 'Medical Room', to: dst?.name || 'Medical Room' };
    });
}

module.exports = { receive, consume, giveBack, adjust, writeOff, transfer, retotal, placeOf };
