'use strict';
/**
 * The one writer of stock balances.
 *
 * Before this, every movement was a read-modify-write in JavaScript: read the
 * row, add the delta, save. Two issues of the same item at the same moment both
 * read the same balance and one of them was lost — and the ledger, written
 * afterwards, recorded a movement that the balance never reflected.
 *
 * It was also CLAMPED (`Math.max(0, …)`), which is worse than it sounds: the
 * ledger then holds a −50 whose balanceAfter is 0, and every figure
 * reconstructed from the ledger — the Stock screen's six-month trend, every
 * "from last month" delta — is permanently wrong with nothing to show for it.
 *
 * So: one UPDATE that does the arithmetic in the database, a CHECK that a
 * movement can never drive a balance negative, and the ledger row written in
 * the same transaction. The availability check is the update itself, which also
 * closes the check-then-act race the old guards had.
 */
const { withTransaction } = require('../db/pool');
const { newId } = require('../db/schema');

/** Thrown when a movement would take a balance below zero. */
class InsufficientStock extends Error {
    constructor(available, wanted, reserved = 0) {
        super(reserved > 0
            ? `Insufficient available stock (${available} free, ${wanted} needed — ${reserved} is reserved against approved requests)`
            : `Insufficient available stock (${available} on hand, ${wanted} needed)`);
        this.name = 'InsufficientStock';
        this.code = 'INSUFFICIENT_STOCK';
        this.available = available;
        this.wanted = wanted;
        this.reserved = reserved;
    }
}

// Movements that record physical reality rather than a decision. A breakage or
// a stock-take correction is allowed to eat into reserved stock: the goods are
// genuinely gone, and pretending otherwise would just move the lie elsewhere.
// The reservation survives and shows as unfulfillable, which is the truth.
const IGNORES_RESERVED = new Set(['adjustment', 'damage', 'writeoff', 'write_off', 'loss', 'audit']);

const num = (v) => (Number.isFinite(+v) ? +v : 0);

/**
 * Apply one signed movement and record it.
 *
 *   move(ctx, { item, warehouse, type, quantity, … })
 *
 * `ctx` carries school/user (a request works as-is). `quantity` is signed:
 * positive adds, negative removes. Returns the resulting balance.
 */
async function move(ctx, {
    item, warehouse, type, quantity, unitCost = 0,
    refType = '', refId = null, note = '',
    batchNumber = '', serialNumbers = [], expiryDate = null,
}, q) {
    const school = ctx.schoolId;
    const delta = num(quantity);
    if (!item || !warehouse) throw new Error('Item and warehouse are required');
    if (!delta) throw new Error('A movement of zero is not a movement');

    const run = async (sql) => {
        // ── The balance, changed atomically ──────────────────────────────
        // One statement: insert the row if this is the first movement for the
        // pair, otherwise add the delta to whatever is there NOW. `before` comes
        // back so the weighted-average cost can be computed from it without a
        // second read.
        const upsert = await sql(
            `INSERT INTO "inventorystocks"
                 ("_id", "school", "item", "warehouse", "quantity", "reserved", "avgCost", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, 0, $6, now(), now())
             ON CONFLICT ("school", "item", "warehouse") DO UPDATE
                 SET "quantity"  = "inventorystocks"."quantity" + $5,
                     "updatedAt" = now()
             RETURNING "_id", "quantity", COALESCE("avgCost", 0) AS "avgCost",
                       COALESCE("reserved", 0) AS "reserved",
                       "quantity" - $5 AS "before"`,
            [newId(), school, item, warehouse, delta, num(unitCost)],
        );
        const row = upsert.rows[0];
        const after = num(row.quantity);
        const before = num(row.before);
        const held = num(row.reserved);

        // ── The floor ────────────────────────────────────────────────────
        // Checked AFTER the update, inside the transaction, so it is the real
        // balance and not one that another request has moved since. Throwing
        // rolls the whole thing back, including the row we may have inserted.
        //
        // Two floors, not one. Nothing may drive a balance negative; and
        // nothing may take stock that is already promised to an approved
        // request, so the second request to reach for the last box is the one
        // that is turned away rather than whichever happens to commit first.
        if (after < 0) throw new InsufficientStock(Math.max(0, before), Math.abs(delta));
        if (delta < 0 && held > 0 && !IGNORES_RESERVED.has(type) && after < held) {
            throw new InsufficientStock(Math.max(0, before - held), Math.abs(delta), held);
        }

        // ── Weighted average cost, on the way in only ────────────────────
        let avgCost = num(row.avgCost);
        if (delta > 0 && num(unitCost) > 0) {
            const prevValue = Math.max(0, before) * avgCost;
            avgCost = after > 0 ? (prevValue + delta * num(unitCost)) / after : num(unitCost);
            await sql(`UPDATE "inventorystocks" SET "avgCost" = $1 WHERE "_id" = $2`, [avgCost, row._id]);
        }

        // ── The ledger entry, in the same transaction ────────────────────
        // It can no longer disagree with the balance it describes.
        await sql(
            `INSERT INTO "inventorystocktransactions"
                 ("_id", "school", "item", "warehouse", "type", "quantity", "balanceAfter",
                  "unitCost", "batchNumber", "serialNumbers", "expiryDate",
                  "refType", "refId", "note", "performedBy", "createdAt", "updatedAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now(), now())`,
            [
                newId(), school, item, warehouse, type, delta, after,
                num(unitCost), batchNumber || '',
                JSON.stringify(Array.isArray(serialNumbers) ? serialNumbers : []),
                expiryDate ? new Date(expiryDate) : null,
                refType || '', refId || null, note || '', ctx.userId || null,
            ],
        );

        return { _id: row._id, quantity: after, avgCost, before };
    };

    // Joins a transaction already in progress, or opens one of its own.
    return q ? run(q) : withTransaction(run);
}

/**
 * Several movements that must all happen or none of them — a transfer, a
 * return that is written straight back off, a receipt of many lines.
 */
async function moveAll(ctx, movements) {
    return withTransaction(async (q) => {
        const out = [];
        for (const m of movements) out.push(await move(ctx, m, q));
        return out;
    });
}

// ── Reservations ────────────────────────────────────────────────────────────
// `reserved` sat on the model from the beginning with a comment describing what
// it meant and no code that ever wrote it, so `available` was always just
// `quantity` and an approved request was a promise the system could not keep.
//
// A reservation is stock that is spoken for but still physically on the shelf:
// approved, not yet handed over. It is taken when a request is approved and
// given back when the request leaves that state — issued, ordered instead,
// rejected or cancelled. Nothing else touches it.

/**
 * Hold `quantity` of an item at a store. Refuses if that much is not free.
 * Atomic: the WHERE clause is the availability check, so two approvals racing
 * for the last box cannot both win.
 */
async function reserve(ctx, { item, warehouse, quantity }, q) {
    const qty = Math.abs(num(quantity));
    if (!item || !warehouse) throw new Error('Item and warehouse are required');
    if (!qty) return null;

    const run = async (sql) => {
        const upd = await sql(
            `UPDATE "inventorystocks"
                SET "reserved" = COALESCE("reserved", 0) + $4, "updatedAt" = now()
              WHERE "school" = $1 AND "item" = $2 AND "warehouse" = $3
                AND "quantity" - COALESCE("reserved", 0) >= $4
              RETURNING "quantity", "reserved"`,
            [ctx.schoolId, item, warehouse, qty],
        );
        if (!upd.rows.length) {
            // Either no row at all, or not enough free. Read it to say which.
            const cur = await sql(
                `SELECT "quantity", COALESCE("reserved", 0) AS "reserved" FROM "inventorystocks"
                  WHERE "school" = $1 AND "item" = $2 AND "warehouse" = $3`,
                [ctx.schoolId, item, warehouse],
            );
            const r = cur.rows[0] || { quantity: 0, reserved: 0 };
            throw new InsufficientStock(Math.max(0, num(r.quantity) - num(r.reserved)), qty, num(r.reserved));
        }
        return upd.rows[0];
    };
    return q ? run(q) : withTransaction(run);
}

/**
 * Give a hold back. Never throws and never goes below zero — releasing is
 * cleanup, and cleanup that can fail is worse than cleanup that is generous.
 */
async function release(ctx, { item, warehouse, quantity }, q) {
    const qty = Math.abs(num(quantity));
    if (!item || !warehouse || !qty) return null;
    const run = async (sql) => {
        const upd = await sql(
            `UPDATE "inventorystocks"
                SET "reserved" = GREATEST(0, COALESCE("reserved", 0) - $4), "updatedAt" = now()
              WHERE "school" = $1 AND "item" = $2 AND "warehouse" = $3
              RETURNING "quantity", "reserved"`,
            [ctx.schoolId, item, warehouse, qty],
        );
        return upd.rows[0] || null;
    };
    return q ? run(q) : withTransaction(run);
}

/** All of them or none — an approval covers every line of a request. */
async function reserveAll(ctx, holds) {
    return withTransaction(async (q) => {
        const out = [];
        for (const h of holds) out.push(await reserve(ctx, h, q));
        return out;
    });
}

/** Best-effort release of many holds; one bad line never blocks the rest. */
async function releaseAll(ctx, holds) {
    return withTransaction(async (q) => {
        for (const h of holds) await release(ctx, h, q).catch(() => {});
    });
}

module.exports = { move, moveAll, reserve, release, reserveAll, releaseAll, InsufficientStock };
