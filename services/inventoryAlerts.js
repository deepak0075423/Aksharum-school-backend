'use strict';
/**
 * The inventory module's watchman.
 *
 * Every threshold the module asks a school to set — a reorder level on an item,
 * `alertAt` on a budget, `lowCapacityAt` on a store, an expected return date on
 * an issue, an expiry date on a batch — existed only as a number on a form.
 * Nothing read them. A school could set a reorder level of 20 and discover at
 * zero that nothing had ever told them, because the only code that looked at
 * stock ran when somebody happened to open the Stock screen.
 *
 * So: one sweep, run on a timer, that reads those thresholds and says something
 * when they are crossed. Five things are watched:
 *
 *   low stock        an item at or below its reorder level (or out entirely)
 *   expiry           a dated batch that is close to, or past, its date
 *   overdue return   a returnable issue whose date has gone by
 *   budget           spend at or past the budget's own alert percentage
 *   capacity         a store at or past its own capacity threshold
 *
 * Each is reported ONCE per condition (InventoryAlert records what was said),
 * and the record is cleared when the condition clears, so the same item running
 * low again next term is reported again. Severity is part of the identity: an
 * item that has been reported "low" is reported again when it goes "out".
 */
const InventoryItem             = require('../models/InventoryItem');
const InventoryStock            = require('../models/InventoryStock');
const InventoryIssue            = require('../models/InventoryIssue');
const InventoryWarehouse        = require('../models/InventoryWarehouse');
const InventoryAlert            = require('../models/InventoryAlert');
const School                    = require('../models/School');
const User                      = require('../models/User');
const budgets                   = require('./inventoryBudget');
const batches                   = require('./inventoryBatches');
const { notify, schoolAdminIds } = require('./notifyService');

const num = (v) => (Number.isFinite(+v) ? +v : 0);
const MS_DAY = 86400000;
const EXPIRY_WARN_DAYS = 30;

/** Schools that have the module switched on. */
async function schoolsToSweep() {
    const rows = await School.find({ 'modules.inventory': true }).select('_id').lean();
    return rows.map(r => String(r._id));
}

/**
 * Say it once. Returns true if this is new news, false if the school has
 * already been told and nothing has got worse.
 */
async function claim(school, kind, key, level, meta) {
    try {
        await InventoryAlert.create({ school, kind, key, level, meta: meta || {}, sentAt: new Date() });
        return true;
    } catch (e) {
        // The unique index is the whole mechanism: a duplicate means "already said".
        if (/duplicate|unique/i.test(e.message || '')) return false;
        throw e;
    }
}

/** The condition cleared — forget it, so it can be reported afresh. */
async function clear(school, kind, keys) {
    if (!keys.length) return;
    await InventoryAlert.deleteMany({ school, kind, key: { $in: keys } });
}

/**
 * Say it once, but say it again when it gets worse.
 *
 * Escalating used to mean clearing the subject and re-claiming — which also
 * deleted the row being written, so anything at the worst level re-announced
 * itself every sweep. Only the OTHER levels are dropped: the subject keeps
 * exactly one row, at the level it was last reported.
 */
async function claimAt(school, kind, key, level, meta) {
    await InventoryAlert.deleteMany({ school, kind, key, level: { $ne: level } });
    return claim(school, kind, key, level, meta);
}

/**
 * Who hears about it. Store alerts also go to that store's manager, because
 * they are the person who can move something; everything else goes to the
 * office. `notify` needs a sender, and a sweep has no acting user, so the
 * first admin sends to the rest and to themselves.
 */
async function audience(school, extra = []) {
    const admins = (await schoolAdminIds(school)).map(String);
    const ids = [...new Set([...admins, ...extra.filter(Boolean).map(String)])];
    return { sender: admins[0] || ids[0] || null, recipients: ids };
}

function say(school, sender, recipients, title, body, link) {
    if (!sender || !recipients.length) return;
    notify({
        school, sender, senderRole: 'system', title, body,
        recipients, includeSender: true, link,
    });
}

/* ── 1. Low stock ───────────────────────────────────────────────────────────
   Measured on what is FREE, not what is on the shelf: stock promised to an
   approved request cannot be used to meet the next one, so counting it would
   report a school as comfortable right up to the moment it was not. */
async function sweepLowStock(school) {
    const items = await InventoryItem.find({ school, isActive: true, reorderLevel: { $gt: 0 } })
        .select('name itemCode unit reorderLevel').lean();
    if (!items.length) return 0;

    const ids = items.map(i => String(i._id));
    const stock = await InventoryStock.find({ school, item: { $in: ids } })
        .select('item quantity reserved').lean();
    const free = new Map();
    for (const s of stock) {
        free.set(String(s.item), num(free.get(String(s.item))) + Math.max(0, num(s.quantity) - num(s.reserved)));
    }

    const { sender, recipients } = await audience(school);
    const healthy = [];
    let sent = 0;
    for (const it of items) {
        const have = num(free.get(String(it._id)));
        const level = have <= 0 ? 'critical' : have <= num(it.reorderLevel) ? 'warn' : null;
        if (!level) { healthy.push(`item:${it._id}`); continue; }
        // A worse level is new news; the milder row is dropped so the subject
        // never holds two.
        if (!(await claimAt(school, 'low_stock', `item:${it._id}`, level, { have, reorderLevel: it.reorderLevel }))) continue;
        sent++;
        say(school, sender, recipients,
            level === 'critical' ? '📦 Out of stock' : '📦 Stock is running low',
            level === 'critical'
                ? `${it.name} (${it.itemCode}) has nothing left to issue. Its reorder level is ${num(it.reorderLevel)} ${it.unit || ''}.`.trim()
                : `${it.name} (${it.itemCode}) is down to ${have} ${it.unit || ''}`.trim()
                    + `, at or below its reorder level of ${num(it.reorderLevel)}.`,
            { type: 'inventory.stock', entityId: it._id });
    }
    await clear(school, 'low_stock', healthy);
    return sent;
}

/* ── 2. Expiry ──────────────────────────────────────────────────────────────
   Open lots only — see services/inventoryBatches for how "open" is worked out
   from a ledger that never recorded which batch left. */
async function sweepExpiry(school) {
    const dated = await InventoryItem.find({ school, isActive: true, hasExpiry: true }).select('name itemCode unit').lean();
    if (!dated.length) return 0;
    const byId = new Map(dated.map(i => [String(i._id), i]));

    const lots = await batches.expiring(school, { items: dated.map(i => String(i._id)), withinDays: EXPIRY_WARN_DAYS });
    const { sender, recipients } = await audience(school);
    const live = new Set();
    let sent = 0;
    for (const lot of lots) {
        const it = byId.get(String(lot.item));
        if (!it) continue;
        const k = `lot:${lot.item}:${lot.warehouse}:${lot.batchNumber || 'unbatched'}:${lot.expiryDate ? new Date(lot.expiryDate).toISOString().slice(0, 10) : ''}`;
        live.add(k);
        const level = lot.expired ? 'critical' : 'warn';
        if (!(await claimAt(school, 'expiry', k, level, { remaining: lot.remaining, daysLeft: lot.daysLeft }))) continue;
        sent++;
        const batchTag = lot.batchNumber ? ` (batch ${lot.batchNumber})` : '';
        say(school, sender, recipients,
            lot.expired ? '⚠️ Stock has expired' : '⏳ Stock is close to expiry',
            lot.expired
                ? `${lot.remaining} ${it.unit || 'unit(s)'} of ${it.name}${batchTag} expired ${Math.abs(lot.daysLeft)} day(s) ago and should be written off.`
                : `${lot.remaining} ${it.unit || 'unit(s)'} of ${it.name}${batchTag} expires in ${lot.daysLeft} day(s). Use or move it first.`,
            { type: 'inventory.stock', entityId: it._id });
    }
    // Anything no longer in the window has been used, written off or is simply
    // no longer near its date.
    const stale = await InventoryAlert.find({ school, kind: 'expiry' }).select('key').lean();
    await clear(school, 'expiry', stale.map(r => r.key).filter(k => !live.has(k)));
    return sent;
}

/* ── 3. Overdue returns ─────────────────────────────────────────────────────
   The borrower hears about it, and so does the office. */
async function sweepOverdueReturns(school) {
    const today = new Date();
    const open = await InventoryIssue.find({
        school, returnable: true, status: { $ne: 'returned' },
        expectedReturn: { $ne: null, $lt: today },
    }).select('issueNumber item quantity returnedQty expectedReturn issuedToUser issuedToName').lean();

    const { sender, recipients } = await audience(school);
    const live = new Set();
    let sent = 0;
    if (open.length) {
        const items = await InventoryItem.find({ school, _id: { $in: open.map(i => i.item) } }).select('name unit').lean();
        const byId = new Map(items.map(i => [String(i._id), i]));
        for (const iss of open) {
            const days = Math.floor((today - new Date(iss.expectedReturn)) / MS_DAY);
            if (days < 1) continue;
            // Re-reported as it gets worse rather than every half hour: one at
            // a day late, one at a week, one at a month.
            const level = days >= 30 ? 'critical' : days >= 7 ? 'chase' : 'warn';
            const k = `issue:${iss._id}`;
            live.add(k);
            if (!(await claimAt(school, 'overdue_return', k, level, { days }))) continue;
            sent++;
            const it = byId.get(String(iss.item));
            const outstanding = num(iss.quantity) - num(iss.returnedQty);
            const who = iss.issuedToName || 'the borrower';
            say(school, sender, [...new Set([...recipients, ...(iss.issuedToUser ? [String(iss.issuedToUser)] : [])])],
                '↩️ Item is overdue for return',
                `${outstanding} ${it?.unit || 'unit(s)'} of ${it?.name || 'an item'} issued to ${who} on ${iss.issueNumber}`
                + ` was due back ${days} day(s) ago.`,
                { type: 'inventory.issues', entityId: iss._id });
        }
    }
    const stale = await InventoryAlert.find({ school, kind: 'overdue_return' }).select('key').lean();
    await clear(school, 'overdue_return', stale.map(r => r.key).filter(k => !live.has(k)));
    return sent;
}

/* ── 4. Budgets ─────────────────────────────────────────────────────────────
   Spend is summed from purchase orders, never stored — see
   services/inventoryBudget. `alertAt` is the school's own percentage. */
async function sweepBudgets(school) {
    const rows = await budgets.load(school);
    const { sender, recipients } = await audience(school);
    const fine = [];
    let sent = 0;
    for (const b of rows) {
        const allocated = num(b.allocated);
        if (allocated <= 0) continue;
        const pct = Math.round((num(b.spent) / allocated) * 100);
        const at = num(b.alertAt) || 90;
        const level = pct >= 100 ? 'critical' : pct >= at ? 'warn' : null;
        if (!level) { fine.push(`budget:${b._id}`); continue; }
        if (!(await claimAt(school, 'budget', `budget:${b._id}`, level, { pct, spent: b.spent, allocated }))) continue;
        sent++;
        say(school, sender, recipients,
            level === 'critical' ? '💸 Budget is spent' : '💸 Budget is close to its limit',
            level === 'critical'
                ? `${b.name} has committed ₹${Math.round(num(b.spent)).toLocaleString('en-IN')} against an allocation of ₹${Math.round(allocated).toLocaleString('en-IN')} — ${pct}%. Further orders against it will be refused.`
                : `${b.name} is at ${pct}% of its allocation (₹${Math.round(num(b.spent)).toLocaleString('en-IN')} of ₹${Math.round(allocated).toLocaleString('en-IN')}), past its alert threshold of ${at}%.`,
            { type: 'inventory.budgets', entityId: b._id });
    }
    await clear(school, 'budget', fine);
    return sent;
}

/* ── 5. Store capacity ──────────────────────────────────────────────────────
   Counted in units held, which is what `capacity` is measured in. */
async function sweepCapacity(school) {
    const stores = await InventoryWarehouse.find({ school, isActive: true, capacity: { $gt: 0 } })
        .select('name code capacity lowCapacityAt manager').lean();
    if (!stores.length) return 0;

    const stock = await InventoryStock.find({ school, warehouse: { $in: stores.map(s => String(s._id)) } })
        .select('warehouse quantity').lean();
    const held = new Map();
    for (const s of stock) held.set(String(s.warehouse), num(held.get(String(s.warehouse))) + num(s.quantity));

    const roomy = [];
    let sent = 0;
    for (const w of stores) {
        const used = num(held.get(String(w._id)));
        const pct = Math.round((used / num(w.capacity)) * 100);
        const at = num(w.lowCapacityAt) || 80;
        const level = pct >= 100 ? 'critical' : pct >= at ? 'warn' : null;
        if (!level) { roomy.push(`warehouse:${w._id}`); continue; }
        if (!(await claimAt(school, 'capacity', `warehouse:${w._id}`, level, { pct, used, capacity: w.capacity }))) continue;
        sent++;
        const { sender, recipients } = await audience(school, [w.manager]);
        say(school, sender, recipients,
            level === 'critical' ? '🏬 A store is full' : '🏬 A store is running out of room',
            `${w.name}${w.code ? ` (${w.code})` : ''} is holding ${used} of ${num(w.capacity)} units — ${pct}%`
            + (level === 'critical' ? '. Nothing more will fit.' : `, past its threshold of ${at}%.`),
            { type: 'inventory.warehouses', entityId: w._id });
    }
    await clear(school, 'capacity', roomy);
    return sent;
}

/** Everything, for one school. Each part is independent: one failing does not stop the rest. */
async function runInventorySweep(school) {
    const out = { lowStock: 0, expiry: 0, overdue: 0, budget: 0, capacity: 0 };
    const parts = [
        ['lowStock', sweepLowStock], ['expiry', sweepExpiry], ['overdue', sweepOverdueReturns],
        ['budget', sweepBudgets], ['capacity', sweepCapacity],
    ];
    for (const [name, fn] of parts) {
        try { out[name] = await fn(school); }
        catch (e) { console.error(`[Inventory] ${name} sweep failed for ${school}:`, e.message); }
    }
    out.total = Object.values(out).reduce((a, b) => a + b, 0);
    return out;
}

module.exports = {
    schoolsToSweep, runInventorySweep,
    sweepLowStock, sweepExpiry, sweepOverdueReturns, sweepBudgets, sweepCapacity,
};
