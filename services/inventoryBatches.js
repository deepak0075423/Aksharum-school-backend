'use strict';
/**
 * What is left of each batch, worked out from the ledger.
 *
 * Batches went IN and never came out. A receipt records its batch number and
 * expiry; an issue records neither, because nobody picks a batch on the issue
 * form. So the module could tell you a batch existed and never that it had
 * gone, and an expiry date was a number in a row that nothing ever read.
 *
 * There is no batch-balance table to consult, and inventing one would not
 * recover the history already in the ledger. What the ledger does support is a
 * reconstruction: lots arrive in a known order with known quantities, stock
 * leaves in a known order with known quantities, and consuming the lots
 * earliest-expiry-first (FEFO — which is what a storekeeper actually does with
 * dated goods) gives the open lots.
 *
 * It is a model, not a measurement: a storekeeper who reaches past the front of
 * the shelf makes it wrong for that lot. It is still far better than the
 * alternative, which was reporting every batch ever received as if it were
 * still sitting there, and it is exact for the common case of one lot at a time.
 */
const InventoryStockTransaction = require('../models/InventoryStockTransaction');

const num = (v) => (Number.isFinite(+v) ? +v : 0);
const key = (item, warehouse) => `${item}::${warehouse}`;

/**
 * Open lots per (item, warehouse), earliest expiry first.
 *
 *   lots(school, { items: [...] }) -> Map<"item::warehouse", [{ batchNumber,
 *     expiryDate, received, remaining, receivedAt }]>
 *
 * Only movements that name a batch create a lot. Everything that leaves draws
 * down the open lots; anything that leaves beyond them is stock that was never
 * batched, which is normal for a school that batches only some of its goods.
 */
async function lots(school, { items = null } = {}) {
    const q = { school };
    if (items && items.length) q.item = { $in: items };
    const rows = await InventoryStockTransaction.find(q)
        .select('item warehouse quantity batchNumber expiryDate createdAt type')
        .sort({ createdAt: 1 }).lean();

    const open = new Map();     // key -> lot[]
    const draw = new Map();     // key -> quantity that has left and is not yet allocated

    for (const r of rows) {
        const k = key(r.item, r.warehouse);
        const qty = num(r.quantity);
        if (qty > 0 && (r.batchNumber || r.expiryDate)) {
            if (!open.has(k)) open.set(k, []);
            open.get(k).push({
                batchNumber: r.batchNumber || '',
                expiryDate: r.expiryDate || null,
                receivedAt: r.createdAt,
                received: qty,
                remaining: qty,
            });
        } else if (qty < 0) {
            draw.set(k, num(draw.get(k)) + Math.abs(qty));
        }
        // An untracked receipt adds stock no lot is responsible for, so it
        // cancels an equal amount of the outflow this reconstruction has to
        // explain. Without this, untracked goods would eat the dated lots.
        if (qty > 0 && !(r.batchNumber || r.expiryDate)) {
            draw.set(k, Math.max(0, num(draw.get(k)) - qty));
        }
    }

    // FEFO: whatever left the shelf came off the lot that expires first.
    for (const [k, list] of open) {
        list.sort((a, b) => {
            const ax = a.expiryDate ? +new Date(a.expiryDate) : Infinity;
            const bx = b.expiryDate ? +new Date(b.expiryDate) : Infinity;
            return ax - bx || +new Date(a.receivedAt) - +new Date(b.receivedAt);
        });
        let left = num(draw.get(k));
        for (const lot of list) {
            if (left <= 0) break;
            const take = Math.min(lot.remaining, left);
            lot.remaining -= take;
            left -= take;
        }
        open.set(k, list.filter(l => l.remaining > 0));
    }
    return open;
}

/** Flat list of open lots that carry an expiry date, soonest first. */
async function expiring(school, { items = null, withinDays = null } = {}) {
    const byKey = await lots(school, { items });
    const out = [];
    const now = Date.now();
    for (const [k, list] of byKey) {
        const [item, warehouse] = k.split('::');
        for (const lot of list) {
            if (!lot.expiryDate) continue;
            const days = Math.floor((+new Date(lot.expiryDate) - now) / 86400000);
            if (withinDays != null && days > withinDays) continue;
            out.push({ item, warehouse, ...lot, daysLeft: days, expired: days < 0 });
        }
    }
    return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

module.exports = { lots, expiring };
