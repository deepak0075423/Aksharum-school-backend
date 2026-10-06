'use strict';
/**
 * Inventory — the admin read model (Sep 2026 redesign, to the user's twelve
 * mockups).
 *
 * The CRUD controller beside this one (inventory.controller.js) still owns every
 * write that existed before: it is what the teacher portal and the old screens
 * call, and its response shapes were deliberately left alone. What it could not
 * do is answer the questions the redesigned screens ask — "how many items are
 * low, out, under repair or never tracked", "what did stock look like in June",
 * "what has this vendor actually supplied" — because each of those is a join
 * across four collections that the per-collection list endpoints cannot reach.
 *
 * So: ONE endpoint per screen. Each returns the tiles, the charts, the filter
 * option lists and the page of rows that screen draws, already shaped, so no
 * screen fans out to six endpoints and then reconciles them in the browser.
 *
 * Two rules hold throughout:
 *   · Nothing here is stored twice. A budget's spend, a warehouse's usage, a
 *     vendor's order count and an item's stock status are all summed at read
 *     time from the rows that caused them, so they cannot drift.
 *   · A figure that cannot be computed honestly is not invented. Where a
 *     mockup shows a trend, it is reconstructed from the immutable stock ledger
 *     (balance now, minus everything that moved since) — which is exact — and
 *     where even that is impossible the field is omitted and the screen says so.
 */
const InventoryCategory         = require('../models/InventoryCategory');
const InventoryVendor           = require('../models/InventoryVendor');
const InventoryWarehouse        = require('../models/InventoryWarehouse');
const InventoryDepartment       = require('../models/InventoryDepartment');
const InventoryBudget           = require('../models/InventoryBudget');
const InventoryItem             = require('../models/InventoryItem');
const InventoryStock            = require('../models/InventoryStock');
const InventoryStockTransaction = require('../models/InventoryStockTransaction');
const PurchaseRequest           = require('../models/PurchaseRequest');
const PurchaseOrder             = require('../models/PurchaseOrder');
const InventoryIssue            = require('../models/InventoryIssue');
const InventoryAsset            = require('../models/InventoryAsset');
const InventoryAuditLog         = require('../models/InventoryAuditLog');
const Q                         = require('../services/inventoryQuery');
const AcademicYear              = require('../models/AcademicYear');
const User                      = require('../models/User');
const budgets                   = require('../services/inventoryBudget');
const { nextNumber }            = require('../services/inventoryNumber');

const ok  = (res, data)            => res.json({ success: true, data });
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const err = (res, e)               => res.status(500).json({ success: false, message: e.message });

/* ── Small shared shapes ─────────────────────────────────────────────────── */

const num   = (v) => (Number.isFinite(+v) ? +v : 0);
const round = (v) => Math.round(num(v));
const pct   = (a, b) => (num(b) ? Math.round((num(a) / num(b)) * 100) : 0);
const id    = (v) => (v == null ? '' : String(v._id ?? v));
const esc   = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rx    = (s) => new RegExp(esc(String(s).trim()), 'i');
// snake_case out of the database into something a person reads. The ledger
// screen already called this on the fallback path for a movement type the
// MOVEMENT map did not know; the map happens to cover every type in the enum,
// so the call was never reached and never threw — but it would have.
const words = (v) => String(v ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

const MS_DAY = 24 * 60 * 60 * 1000;
// Fixed three-letter months. toLocaleString('en-IN', {month:'short'}) returns
// "Sept" under current ICU, which is four characters wide in an axis built for
// three and does not match any other month label on the same chart.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (d) => MON[new Date(d).getMonth()];
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay   = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const monthStart = (d, back = 0) => new Date(d.getFullYear(), d.getMonth() - back, 1, 0, 0, 0, 0);

/** Paging that can never divide by zero or ask Postgres for a negative offset. */
function paging(query, fallbackLimit = 8) {
    const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || fallbackLimit));
    const page  = Math.max(1, parseInt(query.page, 10) || 1);
    return { page, limit, skip: (page - 1) * limit };
}
/** A page of an in-memory array, plus the envelope every screen's pager reads. */
function pageOf(rows, { page, limit }) {
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const p     = Math.min(page, pages);
    return { rows: rows.slice((p - 1) * limit, p * limit), total, pages, page: p, limit };
}

/** A [from, to] pair from `?from=&to=`, or null when the screen sent neither. */
function range(query) {
    const from = query.from ? startOfDay(query.from) : null;
    const to   = query.to   ? endOfDay(query.to)     : null;
    if (!from && !to) return null;
    return { from, to };
}
const inRange = (d, r) => {
    if (!r || !d) return !r;
    const t = new Date(d).getTime();
    if (r.from && t < r.from.getTime()) return false;
    if (r.to   && t > r.to.getTime())   return false;
    return true;
};

/**
 * Month-by-month counts of documents by their creation date — the sparkline
 * every tile in the mockups carries. Real numbers, not decoration: a tile whose
 * line rises is a tile whose figure rose.
 */
function monthlySeries(rows, months = 6, dateKey = 'createdAt', filter = null) {
    const now = new Date();
    const buckets = [];
    for (let i = months - 1; i >= 0; i--) {
        const s = monthStart(now, i);
        const e = monthStart(now, i - 1);
        buckets.push({ start: s, end: e, label: monthLabel(s), value: 0 });
    }
    for (const r of rows) {
        if (filter && !filter(r)) continue;
        const t = new Date(r[dateKey] || r.createdAt || 0).getTime();
        for (const b of buckets) {
            if (t >= b.start.getTime() && t < b.end.getTime()) { b.value++; break; }
        }
    }
    return buckets.map(b => ({ label: b.label, value: b.value }));
}

/** "+12%" against the same measure a month ago, or null when there is no base. */
function deltaPct(now, before) {
    if (!Number.isFinite(before) || before <= 0) return null;
    return Math.round(((num(now) - before) / before) * 100);
}
/** How many of `rows` existed before `date` — the base for a month-on-month delta. */
const countBefore = (rows, date, key = 'createdAt') =>
    rows.filter(r => new Date(r[key] || 0).getTime() < date.getTime()).length;

/* ── Vocabulary ──────────────────────────────────────────────────────────── */

// The five buckets every item falls into, in precedence order. They are
// mutually exclusive and they sum to the item count, which is what lets the
// dashboard donut and the Items tiles agree with each other.
const STOCK_STATE = ['in_stock', 'low_stock', 'out_of_stock', 'under_repair', 'not_tracked'];

// Old asset rows used five words, the redesign's filter uses four. Both map
// onto one vocabulary here so a filter written against the new words still
// finds a row saved under the old ones.
const ASSET_STATE = {
    in_use: 'in_use', assigned: 'in_use',
    in_store: 'in_store',
    under_repair: 'under_maintenance',
    out_of_service: 'out_of_service', lost: 'out_of_service',
    retired: 'retired', disposed: 'retired',
};
const assetState = (a) => ASSET_STATE[a?.status] || 'in_store';

// The module a log line belongs to, from the record it touched.
const LOG_MODULE = {
    InventoryItem: 'Items', InventoryStock: 'Stock', InventoryStockTransaction: 'Stock',
    PurchaseRequest: 'Request', PurchaseOrder: 'Purchase Order', InventoryIssue: 'Issue / Return',
    InventoryAsset: 'Assets', InventoryVendor: 'Vendor', InventoryCategory: 'Categories',
    InventoryWarehouse: 'Warehouses', InventoryDepartment: 'Budget', InventoryBudget: 'Budget',
};
// The verb a log line reports, from its action type.
function logVerb(actionType = '') {
    const a = String(actionType).toUpperCase();
    if (a.endsWith('_CREATED') || a.endsWith('_ADDED') || a.includes('CREATE')) return 'created';
    if (a.endsWith('_DELETED') || a.includes('DELETE')) return 'deleted';
    if (a.endsWith('_UPDATED') || a.includes('UPDATE')) return 'updated';
    if (a.includes('APPROVED')) return 'approved';
    if (a.includes('REJECTED')) return 'rejected';
    if (a.includes('ISSUED')) return 'issued';
    if (a.includes('RETURNED')) return 'returned';
    if (a.includes('RECEIVED')) return 'received';
    if (a.includes('CANCEL')) return 'cancelled';
    if (a.includes('TRANSFER')) return 'transferred';
    if (a.includes('ADJUST') || a.includes('STOCK')) return 'updated';
    return 'updated';
}

/* ── The indexes every board builds on ───────────────────────────────────── */

/**
 * Every master list a screen needs to name a row, loaded once. These are small
 * per school (tens of rows, not thousands) and are needed by almost every
 * board, so they are fetched together rather than joined per row.
 */
async function masters(school) {
    const [categories, warehouses, vendors, departments] = await Promise.all([
        InventoryCategory.find({ school }).sort({ name: 1 }).lean(),
        InventoryWarehouse.find({ school }).sort({ name: 1 }).lean(),
        InventoryVendor.find({ school }).sort({ name: 1 }).lean(),
        InventoryDepartment.find({ school }).sort({ name: 1 }).lean(),
    ]);
    const byId = (list) => { const m = new Map(); list.forEach(r => m.set(String(r._id), r)); return m; };
    return {
        categories, warehouses, vendors, departments,
        cat: byId(categories), wh: byId(warehouses), ven: byId(vendors), dep: byId(departments),
    };
}

/**
 * On-hand quantity, reserved quantity and value, per item and per (item,
 * warehouse) — summed from the stock rows, never stored.
 */
async function stockIndex(school) {
    const rows = await InventoryStock.find({ school }).lean();
    const byItem = new Map();
    const byWarehouse = new Map();
    for (const r of rows) {
        const it = String(r.item); const wh = String(r.warehouse);
        const qty = num(r.quantity); const res = num(r.reserved); const cost = num(r.avgCost);
        const a = byItem.get(it) || { qty: 0, reserved: 0, value: 0, cost: 0, places: [], updatedAt: null };
        a.qty += qty; a.reserved += res; a.value += qty * cost;
        if (cost > a.cost) a.cost = cost;
        a.places.push({ warehouse: wh, quantity: qty, reserved: res, avgCost: cost, updatedAt: r.updatedAt, _id: r._id });
        if (!a.updatedAt || new Date(r.updatedAt) > new Date(a.updatedAt)) a.updatedAt = r.updatedAt;
        byItem.set(it, a);
        const w = byWarehouse.get(wh) || { qty: 0, value: 0, items: 0 };
        w.qty += qty; w.value += qty * cost; w.items += 1;
        byWarehouse.set(wh, w);
    }
    return { rows, byItem, byWarehouse };
}

/** Item ids that have at least one asset away for repair. */
async function repairIndex(school) {
    const rows = await InventoryAsset.find({ school, status: 'under_repair' }).select('item').lean();
    const s = new Set();
    rows.forEach(r => { if (r.item) s.add(String(r.item)); });
    return s;
}

/** Which of the five buckets one item sits in. See STOCK_STATE. */
function itemState(item, stock, repairing) {
    if (repairing && repairing.has(String(item._id))) return 'under_repair';
    if (!stock || !stock.places || !stock.places.length) return 'not_tracked';
    const qty = num(stock.qty);
    if (qty <= 0) return 'out_of_stock';
    if (num(item.reorderLevel) > 0 && qty <= num(item.reorderLevel)) return 'low_stock';
    return 'in_stock';
}
/** The same question for one stock row, which has one warehouse's quantity. */
function rowState(item, qty) {
    if (num(qty) <= 0) return 'out_of_stock';
    if (num(item?.reorderLevel) > 0 && num(qty) <= num(item.reorderLevel)) return 'low_stock';
    return 'in_stock';
}

/**
 * What the ledger says moved since `date`, per item.
 *
 * The stock ledger is immutable and its quantities are signed, so
 *     balance(date) = balance(now) − Σ movements after date
 * is not an estimate — it is the balance, reconstructed. Every "from last
 * month" figure and the six-month stock trend are built on this.
 */
async function movedSince(school, date) {
    const rows = await InventoryStockTransaction.find({ school, createdAt: { $gte: date } })
        .select('item quantity createdAt').lean();
    return rows;
}
function netByItemAfter(txns, date) {
    const m = new Map();
    for (const t of txns) {
        if (new Date(t.createdAt).getTime() < date.getTime()) continue;
        const k = String(t.item);
        m.set(k, num(m.get(k)) + num(t.quantity));
    }
    return m;
}

/** A category as every screen draws it: a name, a mark and a tint. */
const catChip = (c) => (c ? { _id: String(c._id), name: c.name, icon: c.icon || 'box', color: c.color || '' } : null);
const whChip  = (w) => (w ? { _id: String(w._id), name: w.name, code: w.code || '', campus: w.campus || '' } : null);

/** A person as a row shows them, tolerating a missing or deleted user. */
const who = (u, fallback = '') => ({
    _id: u ? String(u._id || u) : '',
    name: u?.name || fallback || 'Unknown',
    role: u?.role || '',
    email: u?.email || '',
    photo: u?.profileImage || '',
});

/** Load the users a board needs to name, in one query. */
async function userIndex(school, ids) {
    const want = [...new Set(ids.filter(Boolean).map(String))];
    if (!want.length) return new Map();
    const rows = await User.find({ _id: { $in: want } })
        .select('name role email profileImage').lean();
    const m = new Map();
    rows.forEach(u => m.set(String(u._id), u));
    return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. Dashboard
   ═══════════════════════════════════════════════════════════════════════════ */

exports.overview = async (req, res) => {
    try {
        const school = req.schoolId;
        const now = new Date();
        const monthAgo = new Date(now.getTime() - 30 * MS_DAY);
        const weekAgo  = new Date(now.getTime() - 7 * MS_DAY);
        const in30     = new Date(now.getTime() + 30 * MS_DAY);
        // How far back "Top Consumed Items" looks. The card offers 30/90/180.
        const consumedDays = Math.min(365, Math.max(7, parseInt(req.query.consumedDays, 10) || 30));
        const consumedFrom = new Date(now.getTime() - consumedDays * MS_DAY);

        const [m, stock, repairing, items, requests, logs, expiryTx, consumedTx, movedTx] = await Promise.all([
            masters(school),
            stockIndex(school),
            repairIndex(school),
            InventoryItem.find({ school }).lean(),
            PurchaseRequest.find({ school }).select('status createdAt').lean(),
            InventoryAuditLog.find({ school }).sort({ timestamp: -1 }).limit(12).lean(),
            InventoryStockTransaction.find({ school, expiryDate: { $ne: null } })
                .select('item warehouse expiryDate quantity batchNumber').lean(),
            InventoryStockTransaction.find({ school, type: 'issue', createdAt: { $gte: consumedFrom } })
                .select('item quantity').lean(),
            movedSince(school, monthAgo),
        ]);

        // ── Tiles ────────────────────────────────────────────────────────────
        const states = new Map();
        items.forEach(it => states.set(String(it._id), itemState(it, stock.byItem.get(String(it._id)), repairing)));
        const tally = Object.fromEntries(STOCK_STATE.map(k => [k, 0]));
        states.forEach(v => { tally[v] += 1; });

        const stockValue = [...stock.byItem.values()].reduce((s, a) => s + a.value, 0);

        // A month ago: today's balance minus everything the ledger moved since.
        const netSince = netByItemAfter(movedTx, monthAgo);
        let valueThen = 0;
        for (const it of items) {
            const k = String(it._id);
            const a = stock.byItem.get(k);
            if (!a) continue;
            const qtyThen = num(a.qty) - num(netSince.get(k));
            valueThen += Math.max(0, qtyThen) * num(a.cost);
        }

        const lowThen = (() => {
            let n = 0;
            for (const it of items) {
                const a = stock.byItem.get(String(it._id));
                if (!a) continue;
                const q = num(a.qty) - num(netSince.get(String(it._id)));
                if (num(it.reorderLevel) > 0 && q > 0 && q <= num(it.reorderLevel)) n++;
            }
            return n;
        })();

        const pendingRequests = requests.filter(r => r.status === 'pending');
        const pendingLastWeek = pendingRequests.filter(r => new Date(r.createdAt) >= weekAgo).length;

        // Batches with an expiry date inside the next 30 days, newest batch per
        // item — an item is "expiring" once, not once per receipt.
        const expiringByItem = new Map();
        for (const t of expiryTx) {
            const exp = new Date(t.expiryDate);
            if (!(exp >= startOfDay(now) && exp <= in30)) continue;
            const k = String(t.item);
            const prev = expiringByItem.get(k);
            if (!prev || exp < new Date(prev.expiryDate)) expiringByItem.set(k, t);
        }

        const itemById = new Map(items.map(i => [String(i._id), i]));
        const activeWarehouses = m.warehouses.filter(w => w.isActive !== false);

        const tiles = {
            totalItems:    { value: items.length, delta: deltaPct(items.length, countBefore(items, monthAgo)) },
            stockValue:    { value: round(stockValue), delta: deltaPct(stockValue, valueThen) },
            pendingRequests: { value: pendingRequests.length, added: pendingLastWeek },
            lowStock:      { value: tally.low_stock, added: tally.low_stock - lowThen },
            expiringSoon:  { value: expiringByItem.size },
            warehouses:    { value: activeWarehouses.length, total: m.warehouses.length },
        };

        // ── Stock status donut ───────────────────────────────────────────────
        const stockStatus = {
            total: items.length,
            slices: [
                { key: 'in_stock',     label: 'In Stock',     value: tally.in_stock },
                { key: 'low_stock',    label: 'Low Stock',    value: tally.low_stock },
                { key: 'out_of_stock', label: 'Out of Stock', value: tally.out_of_stock },
                { key: 'under_repair', label: 'Under Repair', value: tally.under_repair },
                { key: 'not_tracked',  label: 'Not Tracked',  value: tally.not_tracked },
            ].map(s => ({ ...s, pct: pct(s.value, items.length) })),
        };

        // ── Recent activity ──────────────────────────────────────────────────
        const actorIds = logs.map(l => l.user);
        const users = await userIndex(school, actorIds);
        const activity = logs.slice(0, 5).map(l => ({
            _id: String(l._id),
            verb: logVerb(l.actionType),
            module: LOG_MODULE[l.entityType] || 'Inventory',
            title: l.description || l.actionType,
            sub: l.referenceCode || '',
            at: l.timestamp,
            by: who(users.get(String(l.user))),
        }));

        // ── Top consumed (the chosen window of issue movements) ──────────────
        const consumed = new Map();
        for (const t of consumedTx) {
            const k = String(t.item);
            consumed.set(k, num(consumed.get(k)) + Math.abs(num(t.quantity)));
        }
        const topConsumed = [...consumed.entries()]
            .map(([k, v]) => {
                const it = itemById.get(k);
                return it ? {
                    _id: k, name: it.name, itemCode: it.itemCode, unit: it.unit,
                    image: it.image || '', consumed: v,
                    category: catChip(m.cat.get(id(it.category))),
                } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.consumed - a.consumed)
            .slice(0, 5);
        const topConsumedMax = topConsumed.reduce((mx, r) => Math.max(mx, r.consumed), 0);

        // ── Low stock table ──────────────────────────────────────────────────
        const lowStockRows = items
            .filter(it => states.get(String(it._id)) === 'low_stock')
            .map(it => {
                const a = stock.byItem.get(String(it._id));
                return {
                    _id: String(it._id), name: it.name, itemCode: it.itemCode, unit: it.unit,
                    image: it.image || '', category: catChip(m.cat.get(id(it.category))),
                    current: round(a?.qty), reorderLevel: num(it.reorderLevel),
                    suggested: Math.max(num(it.reorderLevel) * 2 - round(a?.qty), num(it.reorderLevel), 1),
                    warehouse: whChip(m.wh.get(id(it.warehouse))),
                    state: 'low_stock',
                };
            })
            .sort((a, b) => (a.current / (a.reorderLevel || 1)) - (b.current / (b.reorderLevel || 1)))
            .slice(0, 6);

        // ── Expiring table ───────────────────────────────────────────────────
        const expiringRows = [...expiringByItem.entries()]
            .map(([k, t]) => {
                const it = itemById.get(k);
                if (!it) return null;
                const days = Math.ceil((new Date(t.expiryDate).getTime() - startOfDay(now).getTime()) / MS_DAY);
                return {
                    _id: k, name: it.name, itemCode: it.itemCode, image: it.image || '',
                    expiryDate: t.expiryDate, daysLeft: days, batchNumber: t.batchNumber || '',
                    state: days <= 7 ? 'expiring_now' : 'expiring_soon',
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.daysLeft - b.daysLeft)
            .slice(0, 6);

        ok(res, {
            tiles, stockStatus, activity, topConsumed, topConsumedMax, consumedDays,
            lowStock: lowStockRows, expiring: expiringRows,
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   2. Items
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The item master, filtered, sorted, counted and paged in the database.
 *
 * It used to read every item and every stock row the school had into Node and
 * work on the arrays. The answer was right; the cost grew with the catalogue
 * rather than with the eight rows on the page. The shape of the response has
 * not changed — only where the work happens.
 *
 * The tiles count the whole school and so are a second, small query: they have
 * to keep meaning "4 low on stock" while a filter is narrowing the table.
 */
exports.itemBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', category = '', state = '', warehouse = '', sort = 'name', dir = 'asc' } = req.query;
        const monthAgo = new Date(Date.now() - 30 * MS_DAY);

        const p = Q.params();
        p.$(String(school));                       // $1, used by both CTEs

        const where = [`i."school" = $1`];
        if (category) where.push(`i."category" = ${p.$(String(category))}`);
        if (state)    where.push(`${Q.STATE_SQL} = ${p.$(String(state))}`);
        if (search) {
            const pat = Q.like(p, search);
            where.push(`(i."name" ILIKE ${pat} OR i."itemCode" ILIKE ${pat} OR i."barcode" ILIKE ${pat}
                         OR i."brand" ILIKE ${pat} OR c."name" ILIKE ${pat})`);
        }
        if (warehouse) {
            // An item belongs to a store if it is that store's by default, or
            // if that store is actually holding some of it.
            const wh = p.$(String(warehouse));
            where.push(`(i."warehouse" = ${wh} OR EXISTS (
                SELECT 1 FROM ${Q.T(InventoryStock)} sx
                 WHERE sx."school" = $1 AND sx."item" = i."_id"
                   AND sx."warehouse" = ${wh} AND sx."quantity" > 0))`);
        }

        const base = `
            WITH ${Q.STOCK_CTE(Q.T(InventoryStock))},
                 ${Q.REPAIR_CTE(Q.T(InventoryAsset))}
            SELECT i."_id", i."name", i."description", i."image", i."itemCode", i."barcode",
                   i."brand", i."model", i."unit", i."reorderLevel", i."purchasePrice",
                   i."isAsset", i."hasExpiry", i."isActive", i."createdAt",
                   i."category" AS "categoryId",
                   COALESCE(stk."qty", 0)      AS "current",
                   COALESCE(stk."reserved", 0) AS "reserved",
                   CASE WHEN COALESCE(stk."value", 0) > 0 THEN stk."value"
                        ELSE COALESCE(i."purchasePrice", 0) * COALESCE(stk."qty", 0) END AS "value",
                   COALESCE(stk."places", 0)   AS "placeCount",
                   -- One store holding it all is the item's location; several
                   -- means there is no single answer, and the screen says so.
                   CASE WHEN COALESCE(stk."places", 0) = 1 THEN stk."onlyWarehouse" ELSE i."warehouse" END AS "warehouseId",
                   COALESCE(stk."stockAt", i."updatedAt") AS "updatedAt",
                   ${Q.STATE_SQL} AS "state",
                   c."name" AS "categoryName",
                   count(*) OVER ()::int AS "__matched"
              FROM ${Q.T(InventoryItem)} i
              LEFT JOIN stk ON stk."item" = i."_id"
              LEFT JOIN fix ON fix."item" = i."_id"
              LEFT JOIN ${Q.T(InventoryCategory)} c ON c."_id" = i."category"
             WHERE ${where.join(' AND ')}`;

        const SORTS = {
            name: '"name"', itemCode: '"itemCode"', category: '"categoryName"',
            current: '"current"', reorderLevel: '"reorderLevel"', unit: '"unit"',
            // The five buckets in the order the screen lists them, not alphabetically.
            state: `array_position(ARRAY[${STOCK_STATE.map(x => `'${x}'`).join(',')}]::text[], "state")`,
            warehouse: '"warehouseId"', createdAt: '"createdAt"',
        };

        // Tiles count the whole school, whatever the filter says.
        const tp = Q.params();
        tp.$(String(school));
        const tileSql = `
            WITH ${Q.STOCK_CTE(Q.T(InventoryStock))},
                 ${Q.REPAIR_CTE(Q.T(InventoryAsset))},
                 lab AS (SELECT ${Q.STATE_SQL} AS "state", i."createdAt"
                           FROM ${Q.T(InventoryItem)} i
                           LEFT JOIN stk ON stk."item" = i."_id"
                           LEFT JOIN fix ON fix."item" = i."_id"
                          WHERE i."school" = $1)
            SELECT count(*)::int AS "total",
                   count(*) FILTER (WHERE "state" = 'in_stock')::int     AS "inStock",
                   count(*) FILTER (WHERE "state" = 'low_stock')::int    AS "lowStock",
                   count(*) FILTER (WHERE "state" = 'out_of_stock')::int AS "outOfStock",
                   count(*) FILTER (WHERE "state" = 'under_repair')::int AS "underRepair",
                   count(*) FILTER (WHERE "state" = 'not_tracked')::int  AS "notTracked",
                   count(*) FILTER (WHERE "createdAt" < ${tp.$(monthAgo)})::int AS "before"
              FROM lab`;

        const [m, listed, tiles] = await Promise.all([
            masters(school),
            Q.page(base, p, { sort, dir, page: req.query.page, limit: req.query.limit || 8, sorts: SORTS, fallback: 'name' }),
            Q.pool.query(tileSql, tp.list),
        ]);
        const t = tiles.rows[0] || {};

        ok(res, {
            tiles: {
                total:       { value: num(t.total), delta: deltaPct(num(t.total), num(t.before)) },
                inStock:     { value: num(t.inStock), pct: pct(num(t.inStock), num(t.total)) },
                lowStock:    { value: num(t.lowStock) },
                outOfStock:  { value: num(t.outOfStock) },
                underRepair: { value: num(t.underRepair) },
                notTracked:  { value: num(t.notTracked) },
            },
            filters: {
                categories: m.categories.filter(c => c.isActive !== false).map(catChip),
                warehouses: m.warehouses.filter(w => w.isActive !== false).map(whChip),
            },
            rows: listed.rows.map(r => ({
                _id: String(r._id),
                name: r.name,
                description: r.description || '',
                image: r.image || '',
                itemCode: r.itemCode,
                barcode: r.barcode || '',
                brand: r.brand || '',
                model: r.model || '',
                unit: r.unit || 'Nos',
                category: catChip(m.cat.get(String(r.categoryId || ''))),
                categoryId: r.categoryId ? String(r.categoryId) : '',
                warehouse: whChip(m.wh.get(String(r.warehouseId || ''))),
                warehouseId: r.warehouseId ? String(r.warehouseId) : '',
                locations: num(r.placeCount) > 1 ? num(r.placeCount) : 0,
                current: round(r.current),
                reserved: round(r.reserved),
                reorderLevel: num(r.reorderLevel),
                purchasePrice: num(r.purchasePrice),
                value: round(r.value),
                isAsset: !!r.isAsset,
                hasExpiry: !!r.hasExpiry,
                isActive: r.isActive !== false,
                state: r.state,
                updatedAt: r.updatedAt,
                createdAt: r.createdAt,
            })),
            page: listed.page, pages: listed.pages, total: listed.total, limit: listed.limit,
            matched: listed.matched,
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   3. Stock
   ═══════════════════════════════════════════════════════════════════════════ */

exports.stockBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', category = '', warehouse = '', state = '', months = 6, donutWarehouse = '', sort = 'updatedAt', dir = 'desc' } = req.query;
        const now = new Date();
        const monthAgo = new Date(now.getTime() - 30 * MS_DAY);
        const span = Math.min(12, Math.max(3, parseInt(months, 10) || 6));
        const windowStart = monthStart(now, span - 1);

        // ── The table: one row per (item, warehouse) that has ever held stock.
        // Filtered, sorted, counted and paged in the database; it grows with
        // the catalogue times the number of stores, which is the biggest table
        // on any of these screens.
        const ROW_STATE = `
            CASE WHEN COALESCE(s."quantity", 0) <= 0 THEN 'out_of_stock'
                 WHEN COALESCE(i."reorderLevel", 0) > 0
                      AND COALESCE(s."quantity", 0) <= i."reorderLevel" THEN 'low_stock'
                 ELSE 'in_stock' END`;

        const rp = Q.params();
        const rwhere = [`s."school" = ${rp.$(String(school))}`, `i."_id" IS NOT NULL`];
        if (category)  rwhere.push(`i."category" = ${rp.$(String(category))}`);
        if (warehouse) rwhere.push(`s."warehouse" = ${rp.$(String(warehouse))}`);
        if (state)     rwhere.push(`${ROW_STATE} = ${rp.$(String(state))}`);
        if (search) {
            const pat = Q.like(rp, search);
            rwhere.push(`(i."name" ILIKE ${pat} OR i."itemCode" ILIKE ${pat}
                          OR c."name" ILIKE ${pat} OR w."name" ILIKE ${pat})`);
        }
        const rowBase = `
            SELECT s."_id", s."item" AS "itemId", s."warehouse" AS "warehouseId",
                   s."quantity" AS "current", COALESCE(s."reserved", 0) AS "reserved",
                   COALESCE(s."avgCost", 0) AS "avgCost", s."updatedAt",
                   i."name", i."itemCode", i."image", i."unit", i."reorderLevel",
                   i."category" AS "categoryId",
                   ${ROW_STATE} AS "state",
                   count(*) OVER ()::int AS "__matched"
              FROM ${Q.T(InventoryStock)} s
              JOIN ${Q.T(InventoryItem)} i ON i."_id" = s."item"
              LEFT JOIN ${Q.T(InventoryCategory)} c ON c."_id" = i."category"
              LEFT JOIN ${Q.T(InventoryWarehouse)} w ON w."_id" = s."warehouse"
             WHERE ${rwhere.join(' AND ')}`;
        const ROW_SORTS = {
            name: 'i."name"', itemCode: 'i."itemCode"', category: 'c."name"',
            warehouse: 'w."name"', current: 's."quantity"', reorderLevel: 'i."reorderLevel"',
            value: '(s."quantity" * COALESCE(s."avgCost", 0))',
            state: `array_position(ARRAY[${STOCK_STATE.map(x => `'${x}'`).join(',')}]::text[], ${ROW_STATE})`,
            updatedAt: 's."updatedAt"',
        };

        // Whole-school item counts, the same five buckets the Items board uses.
        const tp = Q.params();
        tp.$(String(school));
        const tallySql = `
            WITH ${Q.STOCK_CTE(Q.T(InventoryStock))},
                 ${Q.REPAIR_CTE(Q.T(InventoryAsset))},
                 lab AS (SELECT ${Q.STATE_SQL} AS "state"
                           FROM ${Q.T(InventoryItem)} i
                           LEFT JOIN stk ON stk."item" = i."_id"
                           LEFT JOIN fix ON fix."item" = i."_id"
                          WHERE i."school" = $1)
            SELECT count(*)::int AS "items",
                   count(*) FILTER (WHERE "state" = 'in_stock')::int     AS "inStock",
                   count(*) FILTER (WHERE "state" = 'low_stock')::int    AS "lowStock",
                   count(*) FILTER (WHERE "state" = 'out_of_stock')::int AS "outOfStock"
              FROM lab`;

        // The donut and the top-five list are aggregates, so they are summed
        // in the database rather than folded out of a full row list.
        const dp = Q.params();
        dp.$(String(school));
        const donutWhere = donutWarehouse ? `AND s."warehouse" = ${dp.$(String(donutWarehouse))}` : '';
        const donutSql = `
            SELECT COALESCE(c."_id"::text, 'none') AS "key",
                   COALESCE(c."name", 'Uncategorised') AS "label",
                   COALESCE(NULLIF(c."icon", ''), 'box') AS "icon",
                   count(*)::int AS "value",
                   COALESCE(SUM(s."quantity" * COALESCE(s."avgCost", 0)), 0)::numeric AS "worth"
              FROM ${Q.T(InventoryStock)} s
              JOIN ${Q.T(InventoryItem)} i ON i."_id" = s."item"
              LEFT JOIN ${Q.T(InventoryCategory)} c ON c."_id" = i."category"
             WHERE s."school" = $1 AND s."quantity" > 0 ${donutWhere}
             GROUP BY 1, 2, 3
             ORDER BY "value" DESC`;

        const vp = Q.params();
        vp.$(String(school));
        const topSql = `
            SELECT i."_id", i."name", i."itemCode", i."image", i."category" AS "categoryId",
                   COALESCE(SUM(s."quantity" * COALESCE(s."avgCost", 0)), 0)::numeric AS "value",
                   COALESCE(SUM(s."quantity"), 0)::numeric AS "qty"
              FROM ${Q.T(InventoryStock)} s
              JOIN ${Q.T(InventoryItem)} i ON i."_id" = s."item"
             WHERE s."school" = $1
             GROUP BY i."_id", i."name", i."itemCode", i."image", i."category"
             ORDER BY "value" DESC
             LIMIT 5`;

        const [m, stock, repairing, items, txns, listed, tally, donutRows, topRows] = await Promise.all([
            masters(school), stockIndex(school), repairIndex(school),
            // The trend below reconstructs six months of history for EVERY
            // item, so it genuinely needs the catalogue and the ledger window.
            // That is a property of the question, not of how it is asked.
            InventoryItem.find({ school }).lean(),
            InventoryStockTransaction.find({ school, createdAt: { $gte: windowStart } })
                .select('item quantity createdAt').lean(),
            Q.page(rowBase, rp, { sort, dir, page: req.query.page, limit: req.query.limit || 8, sorts: ROW_SORTS, fallback: 'updatedAt' }),
            Q.pool.query(tallySql, tp.list),
            Q.pool.query(donutSql, dp.list),
            Q.pool.query(topSql, vp.list),
        ]);
        const tallyRow = tally.rows[0] || {};
        const tallyItems = {
            in_stock: num(tallyRow.inStock), low_stock: num(tallyRow.lowStock),
            out_of_stock: num(tallyRow.outOfStock),
        };

        // A month ago, from the ledger.
        const netSince = netByItemAfter(txns, monthAgo);
        let inStockThen = 0;
        for (const it of items) {
            const a = stock.byItem.get(String(it._id));
            if (!a) continue;
            const q = num(a.qty) - num(netSince.get(String(it._id)));
            if (q > 0) inStockThen++;
        }

        const activeWh = m.warehouses.filter(w => w.isActive !== false).length;

        // ── Donut: stock value / item count by category ──────────────────────
        const donutTotal = donutRows.rows.reduce((t, c) => t + num(c.value), 0);
        let slices = donutRows.rows.map(c => ({
            key: c.key, label: c.label, icon: c.icon, value: num(c.value), worth: round(c.worth),
        }));
        // Beyond five named categories the tail is one "Others" slice — a legend
        // of fifteen one-percent wedges tells nobody anything.
        if (slices.length > 5) {
            const head = slices.slice(0, 5);
            const tail = slices.slice(5);
            head.push({
                key: 'others', label: 'Others', icon: 'box',
                value: tail.reduce((s, c) => s + c.value, 0),
                worth: tail.reduce((s, c) => s + c.worth, 0),
            });
            slices = head;
        }
        const distribution = {
            total: donutTotal,
            slices: slices.map(s => ({ ...s, pct: pct(s.value, donutTotal) })),
        };

        // ── Trend: in / low / out counts at the end of each of `span` months ─
        // Reconstructed backwards from today's balances through the ledger.
        const trend = [];
        const balances = new Map();
        items.forEach(it => balances.set(String(it._id), num(stock.byItem.get(String(it._id))?.qty)));
        const tracked = items.filter(it => (stock.byItem.get(String(it._id))?.places || []).length);
        for (let i = 0; i < span; i++) {
            const edge = i === 0 ? now : monthStart(now, i - 1);
            // Everything that moved at or after `edge` is undone to get the
            // balance as it stood then.
            const net = netByItemAfter(txns, edge);
            let inS = 0, low = 0, out = 0;
            for (const it of tracked) {
                const k = String(it._id);
                const q = num(balances.get(k)) - num(net.get(k));
                if (q <= 0) out++;
                else if (num(it.reorderLevel) > 0 && q <= num(it.reorderLevel)) low++;
                else inS++;
            }
            trend.unshift({
                label: monthLabel(monthStart(now, i)),
                month: monthStart(now, i).toISOString().slice(0, 7),
                in_stock: inS, low_stock: low, out_of_stock: out,
            });
        }

        // ── Top items by stock value ─────────────────────────────────────────
        const topValue = topRows.rows.map(r => ({
            _id: String(r._id), name: r.name, itemCode: r.itemCode, image: r.image || '',
            category: catChip(m.cat.get(String(r.categoryId || ''))),
            value: round(r.value), qty: round(r.qty),
        }));

        ok(res, {
            tiles: {
                inStock:    { value: tallyItems.in_stock, delta: deltaPct(tallyItems.in_stock, inStockThen), series: trend.map(t => t.in_stock) },
                lowStock:   { value: tallyItems.low_stock, series: trend.map(t => t.low_stock) },
                outOfStock: { value: tallyItems.out_of_stock, pct: pct(tallyItems.in_stock, num(tallyRow.items)), series: trend.map(t => t.out_of_stock) },
                warehouses: { value: m.warehouses.length, active: activeWh, inactive: m.warehouses.length - activeWh },
            },
            distribution, trend, topValue,
            filters: {
                categories: m.categories.filter(c => c.isActive !== false).map(catChip),
                warehouses: m.warehouses.map(whChip),
            },
            rows: listed.rows.map(r => ({
                _id: String(r._id),
                itemId: String(r.itemId),
                name: r.name, itemCode: r.itemCode, image: r.image || '',
                unit: r.unit || 'Nos',
                category: catChip(m.cat.get(String(r.categoryId || ''))),
                categoryId: r.categoryId ? String(r.categoryId) : '',
                warehouse: whChip(m.wh.get(String(r.warehouseId || ''))),
                warehouseId: String(r.warehouseId),
                current: round(r.current), reserved: round(r.reserved),
                available: Math.max(0, round(r.current) - round(r.reserved)),
                reorderLevel: num(r.reorderLevel),
                avgCost: num(r.avgCost),
                value: round(num(r.current) * num(r.avgCost)),
                state: r.state,
                updatedAt: r.updatedAt,
            })),
            page: listed.page, pages: listed.pages, total: listed.total, limit: listed.limit,
            matched: listed.matched,
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   4. Requests
   ═══════════════════════════════════════════════════════════════════════════ */

// The screen's five tabs, and which stored statuses each one holds. `cancelled`
// and `fulfilled_from_stock` have no tab of their own but are still real
// outcomes, so they appear under All and nowhere else.
const REQUEST_TABS = {
    all:       null,
    pending:   ['pending'],
    approved:  ['approved', 'fulfilled_from_stock'],
    rejected:  ['rejected', 'cancelled'],
    converted: ['converted'],
};

/** A tab's statuses as a SQL predicate, from the same map the tabs are named by. */
const tabWhere = (col, keys) => (keys && keys.length
    ? `${col} = ANY(ARRAY[${keys.map(k => `'${k}'`).join(',')}]::text[])`
    : null);

exports.requestBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', department = '', status = '', tab = 'all', sort = 'createdAt', dir = 'desc' } = req.query;
        const r = range(req.query);

        const p = Q.params();
        const sid = p.$(String(school));
        const where = [`q."school" = ${sid}`];
        const tabSql = tabWhere('q."status"', REQUEST_TABS[tab]);
        if (tabSql)     where.push(tabSql);
        if (status)     where.push(`q."status" = ${p.$(String(status))}`);
        if (department) where.push(`q."department" = ${p.$(String(department))}`);
        if (r?.from)    where.push(`q."createdAt" >= ${p.$(r.from)}`);
        if (r?.to)      where.push(`q."createdAt" <= ${p.$(r.to)}`);
        if (search) {
            const pat = Q.like(p, search);
            // The line names live inside the `items` JSON, so a search for an
            // item has to look in there — it is how people actually search.
            where.push(`(q."requestNumber" ILIKE ${pat} OR q."reason" ILIKE ${pat} OR u."name" ILIKE ${pat}
                         OR EXISTS (SELECT 1 FROM jsonb_array_elements(
                                        CASE WHEN jsonb_typeof(q."items") = 'array' THEN q."items" ELSE '[]'::jsonb END) li
                                     WHERE li->>'itemName' ILIKE ${pat}))`);
        }

        const base = `
            SELECT q."_id", q."requestNumber", q."createdAt", q."items", q."reason", q."priority",
                   q."estimatedTotal", q."status", q."checks", q."approvals",
                   q."department" AS "departmentId", q."purchaseOrder",
                   u."_id" AS "byId", u."name" AS "byName", u."role" AS "byRole",
                   u."email" AS "byEmail", u."profileImage" AS "byPhoto",
                   dep."name" AS "departmentName",
                   (SELECT COALESCE(SUM((li->>'quantity')::numeric), 0)
                      FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(q."items") = 'array' THEN q."items" ELSE '[]'::jsonb END) li) AS "totalQty",
                   count(*) OVER ()::int AS "__matched"
              FROM ${Q.T(PurchaseRequest)} q
              LEFT JOIN ${Q.T(User)} u ON u."_id" = q."requestedBy"
              LEFT JOIN ${Q.T(InventoryDepartment)} dep ON dep."_id" = q."department"
             WHERE ${where.join(' AND ')}`;

        const SORTS = {
            createdAt: 'q."createdAt"', requestNumber: 'q."requestNumber"',
            department: 'dep."name"', requestedBy: 'u."name"',
            quantity: '"totalQty"', status: 'q."status"',
        };

        // Tabs and tiles describe the whole school, so they are counted once
        // rather than derived from the page.
        const cp = Q.params();
        const cid = cp.$(String(school));
        const tabCount = (keys) => (keys ? `count(*) FILTER (WHERE ${tabWhere('"status"', keys)})::int` : 'count(*)::int');
        const countSql = `
            SELECT count(*)::int AS "all",
                   ${tabCount(REQUEST_TABS.pending)}   AS "pending",
                   ${tabCount(REQUEST_TABS.approved)}  AS "approved",
                   ${tabCount(REQUEST_TABS.rejected)}  AS "rejected",
                   ${tabCount(REQUEST_TABS.converted)} AS "converted",
                   count(*) FILTER (WHERE "createdAt" < now() - INTERVAL '30 days')::int AS "before"
              FROM ${Q.T(PurchaseRequest)} WHERE "school" = ${cid}`;

        const series = (keys) => Q.monthly(
            `SELECT "createdAt" AS "at" FROM ${Q.T(PurchaseRequest)}
              WHERE "school" = $1${keys ? ` AND ${tabWhere('"status"', keys)}` : ''}`, [String(school)]);

        const [m, listed, counts, sAll, sPending, sApproved, sRejected, sConverted] = await Promise.all([
            masters(school),
            Q.page(base, p, { sort, dir, page: req.query.page, limit: req.query.limit || 10, sorts: SORTS, fallback: 'createdAt' }),
            Q.pool.query(countSql, cp.list),
            series(null), series(REQUEST_TABS.pending), series(REQUEST_TABS.approved),
            series(REQUEST_TABS.rejected), series(REQUEST_TABS.converted),
        ]);
        const c = counts.rows[0] || {};

        // The line and approval decoration stays in Node: it reads two small
        // JSON arrays on the ten rows of the page, not the whole table. The
        // items those lines point at are looked up for the page only — loading
        // the whole master to decorate ten rows is the thing being undone here.
        const actorIds = listed.rows.flatMap(x => (x.approvals || []).map(a => a.actor)).filter(Boolean);
        const lineItemIds = [...new Set(listed.rows
            .flatMap(x => (Array.isArray(x.items) ? x.items : []).map(li => li.item))
            .filter(Boolean).map(String))];
        const [actors, lineItems] = await Promise.all([
            userIndex(school, actorIds),
            lineItemIds.length
                ? InventoryItem.find({ school, _id: { $in: lineItemIds } })
                    .select('itemCode image unit category').lean()
                : [],
        ]);
        const itemChip = new Map(lineItems.map(i => [String(i._id), i]));

        ok(res, {
            tiles: {
                total:     { value: num(c.all), delta: deltaPct(num(c.all), num(c.before)), series: sAll },
                pending:   { value: num(c.pending),   series: sPending },
                approved:  { value: num(c.approved),  series: sApproved },
                rejected:  { value: num(c.rejected),  series: sRejected },
                converted: { value: num(c.converted), series: sConverted },
            },
            tabs: {
                all: num(c.all), pending: num(c.pending), approved: num(c.approved),
                rejected: num(c.rejected), converted: num(c.converted),
            },
            filters: { departments: m.departments.map(d => ({ _id: String(d._id), name: d.name })) },
            rows: listed.rows.map(q => {
                const lines = (Array.isArray(q.items) ? q.items : []).map(li => {
                    const it = li.item ? itemChip.get(String(li.item)) : null;
                    return {
                        _id: String(li._id || ''),
                        name: li.itemName,
                        itemCode: it?.itemCode || '',
                        image: it?.image || '',
                        category: catChip(m.cat.get(String(it?.category || ''))),
                        quantity: num(li.quantity),
                        unit: li.unit || it?.unit || 'Nos',
                        estimatedPrice: num(li.estimatedPrice),
                    };
                });
                const approvals = Array.isArray(q.approvals) ? q.approvals : [];
                const stage = approvals.find(a => a.action === 'pending');
                return {
                    _id: String(q._id),
                    requestNumber: q.requestNumber,
                    date: q.createdAt,
                    lines,
                    totalQty: num(q.totalQty),
                    unit: lines.length === 1 ? lines[0].unit : '',
                    department: q.departmentId ? { _id: String(q.departmentId), name: q.departmentName } : null,
                    departmentId: q.departmentId ? String(q.departmentId) : '',
                    requestedBy: who(q.byId ? { _id: q.byId, name: q.byName, role: q.byRole, email: q.byEmail, profileImage: q.byPhoto } : null),
                    purpose: q.reason || '',
                    priority: q.priority || 'normal',
                    estimatedTotal: num(q.estimatedTotal),
                    status: q.status,
                    checks: q.checks || {},
                    stage: stage ? stage.stage : '',
                    approvals: approvals.map(a => ({
                        stage: a.stage, action: a.action, comment: a.comment || '',
                        actedAt: a.actedAt, actor: who(actors.get(String(a.actor))),
                    })),
                    purchaseOrder: q.purchaseOrder ? String(q.purchaseOrder) : '',
                    createdAt: q.createdAt,
                };
            }),
            page: listed.page, pages: listed.pages, total: listed.total, limit: listed.limit,
            matched: listed.matched,
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   5. Purchase Orders
   ═══════════════════════════════════════════════════════════════════════════ */

// `ordered` is the pre-redesign status for "placed with the vendor" and reads
// as In Transit beside `in_transit`; `partially_received` sits with Delivered,
// because goods have arrived.
const ORDER_TABS = {
    all: null,
    pending: ['pending_approval', 'draft'],
    approved: ['approved'],
    transit: ['ordered', 'in_transit'],
    delivered: ['received', 'partially_received'],
    cancelled: ['cancelled'],
};
const ORDER_STATE = {
    draft: 'draft', pending_approval: 'pending_approval', approved: 'approved',
    ordered: 'in_transit', in_transit: 'in_transit',
    partially_received: 'partially_received', received: 'delivered', cancelled: 'cancelled',
};

exports.orderBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', vendor = '', status = '', tab = 'all', sort = 'createdAt', dir = 'desc' } = req.query;
        const r = range(req.query);

        // The screen's five states are not the eight the column holds, so the
        // mapping goes into the query — otherwise filtering by "in transit"
        // means fetching everything and comparing in Node.
        const STATE = Q.caseOf('o."status"', ORDER_STATE, 'draft');
        const LATE = `(${STATE} IN ('in_transit', 'approved')
                       AND o."expectedDelivery" IS NOT NULL
                       AND o."expectedDelivery" < ${Q.TODAY})`;

        const p = Q.params();
        const where = [`o."school" = ${p.$(String(school))}`];
        const tabSql = tabWhere('o."status"', ORDER_TABS[tab]);
        if (tabSql)  where.push(tabSql);
        if (status)  where.push(`${STATE} = ${p.$(String(status))}`);
        if (vendor)  where.push(`o."vendor" = ${p.$(String(vendor))}`);
        if (r?.from) where.push(`o."createdAt" >= ${p.$(r.from)}`);
        if (r?.to)   where.push(`o."createdAt" <= ${p.$(r.to)}`);
        if (search) {
            const pat = Q.like(p, search);
            where.push(`(o."poNumber" ILIKE ${pat} OR v."name" ILIKE ${pat} OR o."terms" ILIKE ${pat}
                         OR EXISTS (SELECT 1 FROM jsonb_array_elements(
                                        CASE WHEN jsonb_typeof(o."items") = 'array' THEN o."items" ELSE '[]'::jsonb END) li
                                     WHERE li->>'itemName' ILIKE ${pat}))`);
        }

        const base = `
            SELECT o."_id", o."poNumber", o."createdAt", o."items", o."subTotal", o."taxTotal",
                   o."discount", o."grandTotal", o."expectedDelivery", o."receivedAt",
                   o."approvedAt", o."dispatchedAt", o."invoice", o."terms", o."status",
                   o."vendor" AS "vendorId", o."department" AS "departmentId", o."warehouse" AS "warehouseId",
                   ${STATE} AS "state", ${LATE} AS "late",
                   v."name" AS "vendorName", v."logo" AS "vendorLogo", v."vendorCategory",
                   dep."name" AS "departmentName",
                   jsonb_array_length(CASE WHEN jsonb_typeof(o."items") = 'array' THEN o."items" ELSE '[]'::jsonb END) AS "itemCount",
                   (SELECT COALESCE(SUM((li->>'quantity')::numeric), 0) FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(o."items") = 'array' THEN o."items" ELSE '[]'::jsonb END) li) AS "unitCount",
                   (SELECT COALESCE(SUM(COALESCE((li->>'receivedQty')::numeric, 0)), 0) FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(o."items") = 'array' THEN o."items" ELSE '[]'::jsonb END) li) AS "receivedCount",
                   count(*) OVER ()::int AS "__matched"
              FROM ${Q.T(PurchaseOrder)} o
              LEFT JOIN ${Q.T(InventoryVendor)} v ON v."_id" = o."vendor"
              LEFT JOIN ${Q.T(InventoryDepartment)} dep ON dep."_id" = o."department"
             WHERE ${where.join(' AND ')}`;

        const SORTS = {
            createdAt: 'o."createdAt"', poNumber: 'o."poNumber"', vendor: 'v."name"',
            items: '"itemCount"', total: 'o."grandTotal"',
            expectedDelivery: 'o."expectedDelivery"', status: `${STATE}`,
        };

        const cp = Q.params();
        const cid = cp.$(String(school));
        const tabCount = (keys) => (keys ? `count(*) FILTER (WHERE ${tabWhere('"status"', keys)})::int` : 'count(*)::int');
        const countSql = `
            SELECT count(*)::int AS "all",
                   ${tabCount(ORDER_TABS.pending)}   AS "pending",
                   ${tabCount(ORDER_TABS.approved)}  AS "approved",
                   ${tabCount(ORDER_TABS.transit)}   AS "transit",
                   ${tabCount(ORDER_TABS.delivered)} AS "delivered",
                   ${tabCount(ORDER_TABS.cancelled)} AS "cancelled",
                   count(*) FILTER (WHERE "createdAt" < now() - INTERVAL '30 days')::int AS "before"
              FROM ${Q.T(PurchaseOrder)} WHERE "school" = ${cid}`;

        const series = (keys) => Q.monthly(
            `SELECT "createdAt" AS "at" FROM ${Q.T(PurchaseOrder)}
              WHERE "school" = $1${keys ? ` AND ${tabWhere('"status"', keys)}` : ''}`, [String(school)]);

        const [m, listed, counts, sAll, sPending, sApproved, sTransit, sDelivered] = await Promise.all([
            masters(school),
            Q.page(base, p, { sort, dir, page: req.query.page, limit: req.query.limit || 10, sorts: SORTS, fallback: 'createdAt' }),
            Q.pool.query(countSql, cp.list),
            series(null), series(ORDER_TABS.pending), series(ORDER_TABS.approved),
            series(ORDER_TABS.transit), series(ORDER_TABS.delivered),
        ]);
        const c = counts.rows[0] || {};

        // Only the items the page's lines actually name.
        const lineItemIds = [...new Set(listed.rows
            .flatMap(o => (Array.isArray(o.items) ? o.items : []).map(li => li.item))
            .filter(Boolean).map(String))];
        const lineItems = lineItemIds.length
            ? await InventoryItem.find({ school, _id: { $in: lineItemIds } }).select('name itemCode image category').lean()
            : [];
        const itemChip = new Map(lineItems.map(i => [String(i._id), i]));

        ok(res, {
            tiles: {
                total:     { value: num(c.all), delta: deltaPct(num(c.all), num(c.before)), series: sAll },
                pending:   { value: num(c.pending),   series: sPending },
                approved:  { value: num(c.approved),  series: sApproved },
                transit:   { value: num(c.transit),   series: sTransit },
                delivered: { value: num(c.delivered), series: sDelivered },
            },
            tabs: {
                all: num(c.all), pending: num(c.pending), approved: num(c.approved),
                transit: num(c.transit), delivered: num(c.delivered), cancelled: num(c.cancelled),
            },
            filters: { vendors: m.vendors.map(v => ({ _id: String(v._id), name: v.name })) },
            rows: listed.rows.map(o => ({
                _id: String(o._id),
                poNumber: o.poNumber,
                date: o.createdAt,
                vendor: o.vendorId
                    ? { _id: String(o.vendorId), name: o.vendorName, logo: o.vendorLogo || '', category: o.vendorCategory || '' }
                    : null,
                vendorId: o.vendorId ? String(o.vendorId) : '',
                department: o.departmentId ? { _id: String(o.departmentId), name: o.departmentName } : null,
                warehouse: whChip(m.wh.get(String(o.warehouseId || ''))),
                lines: (Array.isArray(o.items) ? o.items : []).map(li => {
                    const it = li.item ? itemChip.get(String(li.item)) : null;
                    return {
                        name: it?.name || li.itemName,
                        itemCode: it?.itemCode || '',
                        image: it?.image || '',
                        icon: catChip(m.cat.get(String(it?.category || '')))?.icon || 'box',
                        quantity: num(li.quantity), unit: li.unit || 'Nos',
                        unitPrice: num(li.unitPrice), gst: num(li.gst), receivedQty: num(li.receivedQty),
                    };
                }),
                itemCount: num(o.itemCount),
                unitCount: num(o.unitCount),
                receivedCount: num(o.receivedCount),
                subTotal: num(o.subTotal), taxTotal: num(o.taxTotal), discount: num(o.discount),
                total: num(o.grandTotal),
                expectedDelivery: o.expectedDelivery,
                receivedAt: o.receivedAt,
                approvedAt: o.approvedAt,
                dispatchedAt: o.dispatchedAt,
                invoice: o.invoice || {},
                terms: o.terms || '',
                state: o.state, late: !!o.late,
                status: o.status,
                createdAt: o.createdAt,
            })),
            page: listed.page, pages: listed.pages, total: listed.total, limit: listed.limit,
            matched: listed.matched,
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   6. Issue / Return
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The screen lists TRANSACTIONS, not issues: one row when something goes out,
 * another when part of it comes back. Both are flattened out of the issue
 * record here — the return rows come from `returns[]`, which is why a second
 * partial return no longer overwrites the first one's date and condition.
 */
exports.issueBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const {
            search = '', type = '', status = '', userType = '', category = '',
            user = '', department = '', condition = '', tab = 'all',
            sort = 'date', dir = 'desc',
        } = req.query;
        const r = range(req.query);

        // ── The transaction list ────────────────────────────────────────
        // One row when something goes out and another when part of it comes
        // back, which is what the screen shows. The return rows are unnested
        // out of the issue's `returns` JSON rather than reconstructed in Node,
        // so the whole thing filters, sorts and pages in the database.
        const txnCte = (t) => `
            txn AS (
                SELECT 'i:' || iss."_id"::text                            AS "_id",
                       iss."_id"                                          AS "issueId",
                       'issue'::text                                      AS "kind",
                       iss."issueNumber"                                  AS "txnNumber",
                       COALESCE(iss."issueDate", iss."createdAt")          AS "date",
                       COALESCE(iss."quantity", 0)                        AS "quantity",
                       lower(regexp_replace(COALESCE(NULLIF(iss."conditionOut", ''), 'Good'), '\\s+', '_', 'g')) AS "condition",
                       iss."expectedReturn"                               AS "expectedReturn",
                       GREATEST(0, COALESCE(iss."quantity", 0) - COALESCE(iss."returnedQty", 0)) AS "outstanding",
                       COALESCE(iss."note", '')                           AS "note",
                       iss."item", iss."warehouse", iss."issuedToUser", iss."department",
                       iss."issuedToName", iss."classLabel", iss."recipientType",
                       COALESCE(iss."returnable", true)                   AS "returnable",
                       iss."createdAt"                                    AS "issuedAt"
                  FROM ${t} iss
                 WHERE iss."school" = $1
                UNION ALL
                SELECT 'r:' || COALESCE(ret->>'_id', iss."_id"::text || '-r'),
                       iss."_id",
                       'return'::text,
                       COALESCE(NULLIF(ret->>'returnNumber', ''), iss."issueNumber" || '-R'),
                       (ret->>'returnedAt')::timestamptz,
                       COALESCE((ret->>'quantity')::numeric, 0),
                       COALESCE(NULLIF(ret->>'condition', ''), 'good'),
                       NULL::timestamptz,
                       0,
                       COALESCE(ret->>'note', ''),
                       iss."item", iss."warehouse", iss."issuedToUser", iss."department",
                       iss."issuedToName", iss."classLabel", iss."recipientType",
                       COALESCE(iss."returnable", true),
                       iss."createdAt"
                  FROM ${t} iss,
                       LATERAL jsonb_array_elements(COALESCE(iss."returns", '[]'::jsonb)) ret
                 WHERE iss."school" = $1
            )`;

        // A returnable issue with nothing outstanding is back; one past its
        // date is overdue; a consumable never comes back at all.
        const STATE = `
            CASE WHEN txn."kind" = 'return'      THEN 'returned'
                 WHEN txn."returnable" IS NOT TRUE THEN 'consumed'
                 WHEN txn."outstanding" <= 0     THEN 'returned'
                 WHEN txn."expectedReturn" IS NOT NULL
                      AND txn."expectedReturn" < ${Q.TODAY} THEN 'overdue'
                 ELSE 'pending_return' END`;

        const TAB_SQL = {
            all: null,
            issues: `txn."kind" = 'issue'`,
            returns: `txn."kind" = 'return'`,
            pending: `txn."kind" = 'issue' AND ${STATE} = 'pending_return'`,
            overdue: `txn."kind" = 'issue' AND ${STATE} = 'overdue'`,
        };

        const p = Q.params();
        p.$(String(school));
        const where = ['true'];
        if (TAB_SQL[tab])  where.push(TAB_SQL[tab]);
        if (type)          where.push(`txn."kind" = ${p.$(String(type))}`);
        if (status)        where.push(`${STATE} = ${p.$(String(status))}`);
        if (userType)      where.push(`COALESCE(NULLIF(txn."recipientType", ''), CASE WHEN txn."issuedToUser" IS NULL THEN 'department' ELSE 'staff' END) = ${p.$(String(userType))}`);
        if (user)          where.push(`txn."issuedToUser" = ${p.$(String(user))}`);
        if (category)      where.push(`it."category" = ${p.$(String(category))}`);
        if (department)    where.push(`txn."department" = ${p.$(String(department))}`);
        if (condition)     where.push(`txn."condition" = ${p.$(String(condition))}`);
        if (r?.from)       where.push(`txn."date" >= ${p.$(r.from)}`);
        if (r?.to)         where.push(`txn."date" <= ${p.$(r.to)}`);
        if (search) {
            const pat = Q.like(p, search);
            where.push(`(txn."txnNumber" ILIKE ${pat} OR it."name" ILIKE ${pat} OR it."itemCode" ILIKE ${pat}
                         OR u."name" ILIKE ${pat} OR txn."issuedToName" ILIKE ${pat}
                         OR txn."classLabel" ILIKE ${pat} OR dep."name" ILIKE ${pat})`);
        }

        const base = `
            WITH ${txnCte(Q.T(InventoryIssue))}
            SELECT txn.*, ${STATE} AS "state",
                   it."name" AS "itemName", it."itemCode", it."image" AS "itemImage",
                   it."unit" AS "itemUnit", it."category" AS "categoryId",
                   u."name" AS "userName", u."role" AS "userRole",
                   u."profileImage" AS "userPhoto", u."email" AS "userEmail",
                   dep."name" AS "departmentName",
                   count(*) OVER ()::int AS "__matched"
              FROM txn
              LEFT JOIN ${Q.T(InventoryItem)} it ON it."_id" = txn."item"
              LEFT JOIN ${Q.T(User)} u ON u."_id" = txn."issuedToUser"
              LEFT JOIN ${Q.T(InventoryDepartment)} dep ON dep."_id" = txn."department"
             WHERE ${where.join(' AND ')}`;

        const SORTS = {
            date: 'txn."date"', txnNumber: 'txn."txnNumber"', kind: 'txn."kind"',
            user: `COALESCE(u."name", txn."issuedToName")`,
            quantity: 'txn."quantity"', condition: 'txn."condition"',
            expectedReturn: 'txn."expectedReturn"', state: `${STATE}`,
        };

        // ── The whole-school figures ────────────────────────────────────
        // Tabs and tiles count everything, whatever the filter narrows to, so
        // they are their own query rather than a count of the page.
        const cp = Q.params();
        cp.$(String(school));
        const countSql = `
            WITH ${txnCte(Q.T(InventoryIssue))}
            SELECT count(*)::int AS "all",
                   count(*) FILTER (WHERE txn."kind" = 'issue')::int  AS "issues",
                   count(*) FILTER (WHERE txn."kind" = 'return')::int AS "returns",
                   count(*) FILTER (WHERE txn."kind" = 'issue' AND ${STATE} = 'pending_return')::int AS "pending",
                   count(*) FILTER (WHERE txn."kind" = 'issue' AND ${STATE} = 'overdue')::int        AS "overdue",
                   count(*) FILTER (WHERE txn."kind" = 'issue'
                        AND txn."issuedAt" < now() - INTERVAL '30 days')::int AS "issuesBefore",
                   count(*) FILTER (WHERE txn."kind" = 'return'
                        AND txn."date" < now() - INTERVAL '30 days')::int     AS "returnsBefore"
              FROM txn`;

        const up = Q.params();
        up.$(String(school));
        const usersSql = `
            SELECT DISTINCT u."_id", u."name"
              FROM ${Q.T(InventoryIssue)} iss
              JOIN ${Q.T(User)} u ON u."_id" = iss."issuedToUser"
             WHERE iss."school" = $1
             ORDER BY u."name"`;

        const [m, listed, counts, pickable, issueSeries, returnSeries] = await Promise.all([
            masters(school),
            Q.page(base, p, { sort, dir, page: req.query.page, limit: req.query.limit || 8, sorts: SORTS, fallback: 'date' }),
            Q.pool.query(countSql, cp.list),
            Q.pool.query(usersSql, up.list),
            Q.monthly(`SELECT "createdAt" AS "at" FROM ${Q.T(InventoryIssue)} WHERE "school" = $1`, [String(school)]),
            Q.monthly(`SELECT (ret->>'returnedAt')::timestamptz AS "at"
                         FROM ${Q.T(InventoryIssue)} iss,
                              LATERAL jsonb_array_elements(COALESCE(iss."returns", '[]'::jsonb)) ret
                        WHERE iss."school" = $1`, [String(school)]),
        ]);
        const c = counts.rows[0] || {};

        ok(res, {
            tiles: {
                issues:  { value: num(c.issues), delta: deltaPct(num(c.issues), num(c.issuesBefore)), series: issueSeries },
                returns: { value: num(c.returns), delta: deltaPct(num(c.returns), num(c.returnsBefore)), series: returnSeries },
                pending: { value: num(c.pending) },
                overdue: { value: num(c.overdue) },
            },
            tabs: {
                all: num(c.all), issues: num(c.issues), returns: num(c.returns),
                pending: num(c.pending), overdue: num(c.overdue),
            },
            filters: {
                categories: m.categories.filter(x => x.isActive !== false).map(catChip),
                departments: m.departments.map(x => ({ _id: String(x._id), name: x.name })),
                users: pickable.rows.map(x => ({ _id: String(x._id), name: x.name })),
            },
            rows: listed.rows.map(x => ({
                _id: x._id,
                issueId: String(x.issueId),
                kind: x.kind,
                txnNumber: x.txnNumber,
                date: x.date,
                quantity: num(x.quantity),
                condition: x.condition,
                expectedReturn: x.expectedReturn,
                outstanding: num(x.outstanding),
                state: x.state,
                note: x.note || '',
                returnable: x.returnable !== false,
                item: x.item ? {
                    _id: String(x.item), name: x.itemName, itemCode: x.itemCode,
                    image: x.itemImage || '', unit: x.itemUnit || 'Nos',
                    category: catChip(m.cat.get(String(x.categoryId || ''))),
                } : { _id: '', name: 'Deleted item', itemCode: '', image: '', unit: '', category: null },
                categoryId: x.categoryId ? String(x.categoryId) : '',
                user: x.issuedToUser
                    ? who({ _id: x.issuedToUser, name: x.userName, role: x.userRole, email: x.userEmail, profileImage: x.userPhoto }, x.issuedToName)
                    : who(null, x.issuedToName || 'Not recorded'),
                userId: x.issuedToUser ? String(x.issuedToUser) : '',
                userType: x.recipientType || (x.issuedToUser ? 'staff' : 'department'),
                place: x.classLabel || x.departmentName || '',
                departmentId: x.department ? String(x.department) : '',
                warehouse: whChip(m.wh.get(String(x.warehouse || ''))),
            })),
            page: listed.page, pages: listed.pages, total: listed.total, limit: listed.limit,
            matched: listed.matched,
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   7. Assets
   ═══════════════════════════════════════════════════════════════════════════ */

exports.assetBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', category = '', location = '', status = '', condition = '', sort = 'assetCode', dir = 'asc' } = req.query;

        // The vocabulary map and the 60-day renewal window, as SQL. An asset's
        // category is its own, or the master item's when it has none — the
        // fallback has to be in the query or the filter misses those rows.
        const STATE = Q.caseOf('a."status"', ASSET_STATE, 'in_store');
        const CAT = `COALESCE(a."category", i."category")`;
        const LOC = `COALESCE(NULLIF(a."location", ''), w."name", '')`;
        const SOONEST = `LEAST(
            CASE WHEN a."warrantyExpiry"   BETWEEN ${Q.TODAY} AND ${Q.TODAY} + INTERVAL '60 days' THEN a."warrantyExpiry"   END,
            CASE WHEN a."amcExpiry"        BETWEEN ${Q.TODAY} AND ${Q.TODAY} + INTERVAL '60 days' THEN a."amcExpiry"        END,
            CASE WHEN a."insuranceExpiry"  BETWEEN ${Q.TODAY} AND ${Q.TODAY} + INTERVAL '60 days' THEN a."insuranceExpiry"  END,
            CASE WHEN a."nextMaintenance"  BETWEEN ${Q.TODAY} AND ${Q.TODAY} + INTERVAL '60 days' THEN a."nextMaintenance"  END)`;
        const VALUE = `CASE WHEN COALESCE(a."currentValue", 0) > 0 THEN a."currentValue" ELSE COALESCE(a."purchaseCost", 0) END`;

        const SELECT = `
            SELECT a."_id", a."assetCode", a."name", a."image", a."serialNumber",
                   a."purchaseDate", a."purchaseCost", a."warrantyExpiry", a."amcExpiry",
                   a."insuranceExpiry", a."nextMaintenance", a."condition", a."status",
                   a."repairs", a."assignedTo", a."assignedName", a."warehouse", a."createdAt",
                   ${VALUE}   AS "currentValue",
                   ${STATE}   AS "state",
                   ${CAT}     AS "categoryId",
                   ${LOC}     AS "location",
                   ${SOONEST} AS "renewalAt",
                   COALESCE(NULLIF(a."image", ''), i."image", '') AS "displayImage",
                   u."_id" AS "byId", u."name" AS "byName", u."role" AS "byRole",
                   u."email" AS "byEmail", u."profileImage" AS "byPhoto"`;
        const FROM = `
              FROM ${Q.T(InventoryAsset)} a
              LEFT JOIN ${Q.T(InventoryItem)} i ON i."_id" = a."item"
              LEFT JOIN ${Q.T(InventoryWarehouse)} w ON w."_id" = a."warehouse"
              LEFT JOIN ${Q.T(InventoryCategory)} c ON c."_id" = COALESCE(a."category", i."category")
              LEFT JOIN ${Q.T(User)} u ON u."_id" = a."assignedTo"`;

        const p = Q.params();
        const where = [`a."school" = ${p.$(String(school))}`];
        if (category)  where.push(`${CAT} = ${p.$(String(category))}`);
        if (location)  where.push(`${LOC} = ${p.$(String(location))}`);
        if (status)    where.push(`${STATE} = ${p.$(String(status))}`);
        if (condition) where.push(`COALESCE(NULLIF(a."condition", ''), 'good') = ${p.$(String(condition))}`);
        if (search) {
            const pat = Q.like(p, search);
            where.push(`(a."name" ILIKE ${pat} OR a."assetCode" ILIKE ${pat} OR a."serialNumber" ILIKE ${pat}
                         OR c."name" ILIKE ${pat} OR ${LOC} ILIKE ${pat})`);
        }
        const base = `${SELECT}, count(*) OVER ()::int AS "__matched" ${FROM} WHERE ${where.join(' AND ')}`;

        const SORTS = {
            assetCode: 'a."assetCode"', name: 'a."name"', category: 'c."name"',
            location: LOC, assignedTo: `COALESCE(u."name", a."assignedName")`,
            purchaseDate: 'a."purchaseDate"', value: VALUE, state: STATE,
            condition: 'a."condition"', nextMaintenance: 'a."nextMaintenance"',
        };

        // Tiles, the donut and the location list describe the whole register.
        const cp = Q.params();
        const cid = cp.$(String(school));
        const countSql = `
            SELECT count(*)::int AS "total",
                   count(*) FILTER (WHERE ${STATE} = 'in_use')::int            AS "inUse",
                   count(*) FILTER (WHERE ${STATE} = 'in_store')::int          AS "inStore",
                   count(*) FILTER (WHERE ${STATE} = 'under_maintenance')::int AS "maintenance",
                   count(*) FILTER (WHERE ${STATE} = 'out_of_service')::int    AS "outOfService",
                   count(*) FILTER (WHERE ${STATE} = 'retired')::int           AS "retired",
                   count(*) FILTER (WHERE ${SOONEST} IS NOT NULL)::int         AS "renewals",
                   count(*) FILTER (WHERE a."createdAt" < now() - INTERVAL '30 days')::int AS "before"
              ${FROM} WHERE a."school" = ${cid}`;

        const dp = Q.params();
        const did = dp.$(String(school));
        const donutSql = `
            SELECT COALESCE(c."_id"::text, 'none') AS "key",
                   COALESCE(c."name", 'Uncategorised') AS "label",
                   COALESCE(NULLIF(c."icon", ''), 'box') AS "icon",
                   count(*)::int AS "value",
                   COALESCE(SUM(${VALUE}), 0)::numeric AS "worth"
              ${FROM} WHERE a."school" = ${did}
             GROUP BY 1, 2, 3 ORDER BY "value" DESC`;

        const lp = Q.params();
        const lid = lp.$(String(school));
        const locSql = `SELECT DISTINCT ${LOC} AS "location" ${FROM}
                         WHERE a."school" = ${lid} AND ${LOC} <> '' ORDER BY 1`;

        const rp = Q.params();
        const rid = rp.$(String(school));
        const renewSql = `${SELECT} ${FROM}
                           WHERE a."school" = ${rid} AND ${SOONEST} IS NOT NULL
                           ORDER BY ${SOONEST} ASC LIMIT 5`;

        const [m, listed, counts, donutRows, locRows, renewRows, series] = await Promise.all([
            masters(school),
            Q.page(base, p, { sort, dir, page: req.query.page, limit: req.query.limit || 8, sorts: SORTS, fallback: 'assetCode' }),
            Q.pool.query(countSql, cp.list),
            Q.pool.query(donutSql, dp.list),
            Q.pool.query(locSql, lp.list),
            Q.pool.query(renewSql, rp.list),
            Q.monthly(`SELECT "createdAt" AS "at" FROM ${Q.T(InventoryAsset)} WHERE "school" = $1`, [String(school)]),
        ]);
        const c = counts.rows[0] || {};
        const total = num(c.total);

        // Which of the four dates is the one coming up, for the renewal list.
        const today = startOfDay(new Date());
        const renewalOf = (a) => {
            const marks = [
                ['Warranty expires', a.warrantyExpiry],
                ['AMC renewal due', a.amcExpiry],
                ['Insurance renewal due', a.insuranceExpiry],
                ['Maintenance due', a.nextMaintenance],
            ].filter(([, d]) => d && new Date(d) >= today && new Date(d) <= new Date(today.getTime() + 60 * MS_DAY))
             .sort((x, y) => new Date(x[1]) - new Date(y[1]));
            if (!marks.length) return null;
            const [label, date] = marks[0];
            return { label, date, days: Math.ceil((new Date(date).getTime() - today.getTime()) / MS_DAY) };
        };

        const shape = (a) => {
            const repairs = Array.isArray(a.repairs) ? a.repairs : [];
            const openRepair = repairs.find(r2 => r2.status !== 'completed' && r2.status !== 'returned');
            return {
                _id: String(a._id),
                assetCode: a.assetCode,
                name: a.name,
                image: a.displayImage || '',
                serialNumber: a.serialNumber || '',
                category: catChip(m.cat.get(String(a.categoryId || ''))),
                categoryId: a.categoryId ? String(a.categoryId) : '',
                warehouse: whChip(m.wh.get(String(a.warehouse || ''))),
                location: a.location || '',
                assignedTo: a.byId
                    ? who({ _id: a.byId, name: a.byName, role: a.byRole, email: a.byEmail, profileImage: a.byPhoto }, a.assignedName)
                    : (a.assignedName ? who(null, a.assignedName) : null),
                purchaseDate: a.purchaseDate,
                purchaseCost: num(a.purchaseCost),
                currentValue: num(a.currentValue),
                warrantyExpiry: a.warrantyExpiry,
                amcExpiry: a.amcExpiry,
                insuranceExpiry: a.insuranceExpiry,
                nextMaintenance: a.nextMaintenance,
                condition: a.condition || 'good',
                state: a.state,
                openRepair: openRepair ? {
                    _id: String(openRepair._id), complaint: openRepair.complaint,
                    status: openRepair.status, reportedAt: openRepair.reportedAt,
                    technician: openRepair.technician || '', cost: num(openRepair.cost),
                } : null,
                repairs: repairs.length,
                repairLog: repairs
                    .map(r2 => ({
                        _id: String(r2._id), complaint: r2.complaint, status: r2.status,
                        technician: r2.technician || '', cost: num(r2.cost), note: r2.note || '',
                        reportedAt: r2.reportedAt, completedAt: r2.completedAt,
                        open: !['completed', 'returned'].includes(r2.status),
                    }))
                    .sort((x, y) => new Date(y.reportedAt) - new Date(x.reportedAt)),
                repairSpend: round(repairs.reduce((t, r2) => t + num(r2.cost), 0)),
                createdAt: a.createdAt,
            };
        };

        let slices = donutRows.rows.map(x => ({
            key: x.key, label: x.label, icon: x.icon, value: num(x.value), worth: round(x.worth),
        }));
        if (slices.length > 5) {
            const tail = slices.slice(5);
            slices = slices.slice(0, 5).concat([{
                key: 'others', label: 'Others', icon: 'box',
                value: tail.reduce((t, x) => t + x.value, 0),
                worth: tail.reduce((t, x) => t + x.worth, 0),
            }]);
        }

        ok(res, {
            tiles: {
                total:       { value: total, delta: deltaPct(total, num(c.before)), series },
                inUse:       { value: num(c.inUse), pct: pct(num(c.inUse), total) },
                maintenance: { value: num(c.maintenance), pct: pct(num(c.maintenance), total) },
                outOfService:{ value: num(c.outOfService), pct: pct(num(c.outOfService), total) },
                renewals:    { value: num(c.renewals), pct: pct(num(c.renewals), total) },
                live:        { value: total - num(c.retired) },
            },
            distribution: {
                total,
                slices: slices.map(x => ({ ...x, pct: pct(x.value, total) })),
            },
            statusBars: [
                { key: 'in_use', label: 'In Use', value: num(c.inUse) + num(c.inStore) },
                { key: 'under_maintenance', label: 'Maintenance', value: num(c.maintenance) },
                { key: 'out_of_service', label: 'Out of Service', value: num(c.outOfService) },
                { key: 'retired', label: 'Retired', value: num(c.retired) },
            ],
            renewals: renewRows.rows.map(a => ({ ...shape(a), renewal: renewalOf(a) })).filter(a => a.renewal),
            filters: {
                categories: m.categories.filter(x => x.isActive !== false).map(catChip),
                locations: locRows.rows.map(x => x.location),
            },
            rows: listed.rows.map(shape),
            page: listed.page, pages: listed.pages, total: listed.total, limit: listed.limit,
            matched: listed.matched,
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   8. Vendors
   ═══════════════════════════════════════════════════════════════════════════ */

exports.vendorBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', category = '', status = '', city = '', sort = 'name', dir = 'asc' } = req.query;
        const now = new Date();
        const monthAgo = new Date(now.getTime() - 30 * MS_DAY);

        // What each vendor has traded, summed in the database. Reading every
        // purchase order the school has ever raised to add up a column on
        // twenty vendor rows is work that grows with the school's history
        // rather than with the page.
        const tp = Q.params();
        const tid = tp.$(String(school));
        const { rows: tradeRows } = await Q.pool.query(`
            SELECT o."vendor",
                   count(*)::int                                                     AS "orders",
                   COALESCE(SUM(o."grandTotal") FILTER (WHERE o."status" <> 'cancelled'), 0)::numeric AS "value",
                   count(*) FILTER (WHERE o."status" IN ('received', 'partially_received'))::int AS "delivered",
                   count(*) FILTER (WHERE o."status" IN ('pending_approval', 'approved', 'ordered', 'in_transit'))::int AS "pending",
                   COALESCE(SUM(o."grandTotal" - COALESCE((o."invoice"->>'amount')::numeric, 0))
                            FILTER (WHERE o."status" IN ('pending_approval', 'approved', 'ordered', 'in_transit')), 0)::numeric AS "outstanding",
                   max(o."createdAt")                                                AS "lastOrder",
                   -- Distinct items across the vendor's orders, counted without
                   -- building a Set per vendor in Node.
                   (SELECT count(DISTINCT COALESCE(li->>'item', 'name:' || (li->>'itemName')))
                      FROM ${Q.T(PurchaseOrder)} o2,
                           LATERAL jsonb_array_elements(
                               CASE WHEN jsonb_typeof(o2."items") = 'array' THEN o2."items" ELSE '[]'::jsonb END) li
                     WHERE o2."school" = o."school" AND o2."vendor" = o."vendor")::int AS "itemsSupplied"
              FROM ${Q.T(PurchaseOrder)} o
             WHERE o."school" = ${tid} AND o."vendor" IS NOT NULL
             GROUP BY o."school", o."vendor"`, tp.list);
        const vendors = await InventoryVendor.find({ school }).lean();
        const trade = new Map(tradeRows.map(t => [String(t.vendor), {
            orders: num(t.orders), value: num(t.value), itemsSupplied: num(t.itemsSupplied),
            delivered: num(t.delivered), pending: num(t.pending),
            outstanding: num(t.outstanding), lastOrder: t.lastOrder,
        }]));

        const decorated = vendors.map(v => {
            const t = trade.get(String(v._id)) || { orders: 0, value: 0, itemsSupplied: 0, delivered: 0, pending: 0, lastOrder: null, outstanding: 0 };
            return {
                _id: String(v._id),
                name: v.name,
                logo: v.logo || '',
                tagline: v.tagline || '',
                supplies: v.supplies || '',
                contactPerson: v.contactPerson || '',
                phone: v.phone || '',
                email: v.email || '',
                address: v.address || '',
                city: v.city || '',
                state: v.state || '',
                pincode: v.pincode || '',
                website: v.website || '',
                gstNumber: v.gstNumber || '',
                pan: v.pan || '',
                vendorCategory: v.vendorCategory || '',
                paymentTerms: v.paymentTerms || '',
                preferred: !!v.preferred,
                rating: num(v.performance?.rating),
                itemsSupplied: t.itemsSupplied,
                totalOrders: t.orders,
                totalValue: round(t.value),
                outstanding: round(Math.max(0, t.outstanding)),
                lastOrder: t.lastOrder,
                isActive: v.isActive !== false,
                state: v.preferred ? 'preferred' : (v.isActive !== false ? 'active' : 'inactive'),
                createdAt: v.createdAt,
            };
        });

        const active = decorated.filter(v => v.isActive && !v.preferred).length;
        const inactive = decorated.filter(v => !v.isActive).length;
        const preferred = decorated.filter(v => v.preferred).length;

        let rows = decorated;
        if (search)   rows = rows.filter(v => rx(search).test(`${v.name} ${v.contactPerson} ${v.phone} ${v.email} ${v.gstNumber} ${v.city}`));
        if (category) rows = rows.filter(v => v.vendorCategory === category);
        if (city)     rows = rows.filter(v => v.city === city);
        if (status)   rows = rows.filter(v => v.state === status);

        const SORT = {
            name: (a, b) => a.name.localeCompare(b.name),
            contactPerson: (a, b) => a.contactPerson.localeCompare(b.contactPerson),
            city: (a, b) => a.city.localeCompare(b.city),
            itemsSupplied: (a, b) => a.itemsSupplied - b.itemsSupplied,
            totalOrders: (a, b) => a.totalOrders - b.totalOrders,
            totalValue: (a, b) => a.totalValue - b.totalValue,
            state: (a, b) => a.state.localeCompare(b.state),
        };
        rows = [...rows].sort(SORT[sort] || SORT.name);
        if (dir === 'desc') rows.reverse();

        const paged = pageOf(rows, paging(req.query, 8));

        ok(res, {
            tiles: {
                total:     { value: decorated.length, delta: deltaPct(decorated.length, countBefore(vendors, monthAgo)), series: monthlySeries(vendors).map(s => s.value) },
                active:    { value: active, pct: pct(active, decorated.length) },
                inactive:  { value: inactive, pct: pct(inactive, decorated.length) },
                preferred: { value: preferred, pct: pct(preferred, decorated.length) },
            },
            filters: {
                categories: [...new Set(decorated.map(v => v.vendorCategory).filter(Boolean))].sort(),
                cities: [...new Set(decorated.map(v => v.city).filter(Boolean))].sort(),
            },
            ...paged,
            matched: rows.length,
        });
    } catch (e) { err(res, e); }
};

exports.vendorDetail = async (req, res) => {
    try {
        const school = req.schoolId;
        const vendor = await InventoryVendor.findOne({ _id: req.params.id, school }).lean();
        if (!vendor) return bad(res, 'That vendor could not be found', 404);

        // This vendor's orders, then only the items THOSE orders name — the
        // whole catalogue was being read to decorate a handful of lines.
        const orders = await PurchaseOrder.find({ school, vendor: vendor._id }).sort({ createdAt: -1 }).lean();
        const lineItemIds = [...new Set(orders
            .flatMap(o => (o.items || []).map(li => li.item))
            .filter(Boolean).map(String))];
        const [items, cats] = await Promise.all([
            lineItemIds.length
                ? InventoryItem.find({ school, _id: { $in: lineItemIds } })
                    .select('name itemCode image category unit purchasePrice').lean()
                : [],
            InventoryCategory.find({ school }).lean(),
        ]);
        const itemById = new Map(items.map(i => [String(i._id), i]));
        const catById = new Map(cats.map(c => [String(c._id), c]));

        // Everything this vendor has ever supplied, with what it cost last time.
        const supplied = new Map();
        for (const o of orders) {
            for (const li of (o.items || [])) {
                const key = li.item ? String(li.item) : `name:${li.itemName}`;
                const it = li.item ? itemById.get(String(li.item)) : null;
                const s = supplied.get(key) || {
                    _id: li.item ? String(li.item) : '',
                    name: it?.name || li.itemName,
                    itemCode: it?.itemCode || '',
                    image: it?.image || '',
                    category: catChip(catById.get(id(it?.category))),
                    unit: li.unit || it?.unit || 'Nos',
                    quantity: 0, orders: 0, value: 0, lastPrice: 0, lastAt: null,
                };
                s.quantity += num(li.quantity);
                s.orders += 1;
                s.value += num(li.quantity) * num(li.unitPrice);
                if (!s.lastAt || new Date(o.createdAt) > new Date(s.lastAt)) {
                    s.lastAt = o.createdAt; s.lastPrice = num(li.unitPrice);
                }
                supplied.set(key, s);
            }
        }

        const paid = orders.reduce((s, o) => s + num(o.invoice?.amount), 0);
        const billed = orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + num(o.grandTotal), 0);

        // Delivery record — on time against the date the PO promised.
        const delivered = orders.filter(o => o.receivedAt && o.expectedDelivery);
        const onTime = delivered.filter(o => new Date(o.receivedAt) <= endOfDay(o.expectedDelivery)).length;

        ok(res, {
            vendor: {
                ...vendor,
                _id: String(vendor._id),
                state: vendor.preferred ? 'preferred' : (vendor.isActive !== false ? 'active' : 'inactive'),
            },
            stats: {
                itemsSupplied: supplied.size,
                totalOrders: orders.length,
                totalValue: round(billed),
                paid: round(paid),
                outstanding: round(Math.max(0, billed - paid)),
                onTimePct: pct(onTime, delivered.length),
                deliveredOrders: delivered.length,
            },
            items: [...supplied.values()].sort((a, b) => b.value - a.value),
            orders: orders.slice(0, 25).map(o => ({
                _id: String(o._id), poNumber: o.poNumber, date: o.createdAt,
                total: num(o.grandTotal), itemCount: (o.items || []).length,
                state: ORDER_STATE[o.status] || o.status,
                expectedDelivery: o.expectedDelivery, receivedAt: o.receivedAt,
            })),
            payments: orders
                .filter(o => o.invoice && (o.invoice.number || num(o.invoice.amount)))
                .map(o => ({
                    _id: String(o._id), poNumber: o.poNumber,
                    invoiceNumber: o.invoice.number || '—',
                    date: o.invoice.date || o.receivedAt || o.createdAt,
                    amount: num(o.invoice.amount), total: num(o.grandTotal),
                    settled: num(o.invoice.amount) >= num(o.grandTotal),
                })),
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   9. Categories
   ═══════════════════════════════════════════════════════════════════════════ */

exports.categoryBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', status = '', parent = '', sort = 'name', dir = 'asc' } = req.query;
        const now = new Date();
        const monthAgo = new Date(now.getTime() - 30 * MS_DAY);

        // Each category's own figures, summed per category in the database
        // rather than by walking the whole catalogue in Node.
        const cp = Q.params();
        cp.$(String(school));
        const [cats, perCat] = await Promise.all([
            InventoryCategory.find({ school }).lean(),
            Q.pool.query(`
                WITH ${Q.STOCK_CTE(Q.T(InventoryStock))},
                     ${Q.REPAIR_CTE(Q.T(InventoryAsset))}
                SELECT i."category",
                       count(*)::int AS "items",
                       COALESCE(SUM(CASE WHEN COALESCE(stk."value", 0) > 0 THEN stk."value"
                                         ELSE COALESCE(i."purchasePrice", 0) * COALESCE(stk."qty", 0) END), 0)::numeric AS "value",
                       count(*) FILTER (WHERE ${Q.STATE_SQL} IN ('low_stock', 'out_of_stock'))::int AS "low",
                       max(i."updatedAt") AS "updatedAt"
                  FROM ${Q.T(InventoryItem)} i
                  LEFT JOIN stk ON stk."item" = i."_id"
                  LEFT JOIN fix ON fix."item" = i."_id"
                 WHERE i."school" = $1 AND i."category" IS NOT NULL
                 GROUP BY i."category"`, cp.list),
        ]);
        const catById = new Map(cats.map(c => [String(c._id), c]));

        // A sub-category's figures roll up into its parent as well — a parent
        // that reported nothing while all of its items sat in its children
        // would be worse than no figure at all.
        const roll = new Map(cats.map(c => [String(c._id), { items: 0, value: 0, low: 0, updatedAt: null }]));
        const own  = new Map(cats.map(c => [String(c._id), { items: 0, value: 0, low: 0 }]));
        for (const r of perCat.rows) {
            const k = String(r.category);
            if (!roll.has(k)) continue;
            const add = (target, key) => {
                const t = target.get(key); if (!t) return;
                t.items += num(r.items); t.value += num(r.value); t.low += num(r.low);
                if ('updatedAt' in t && (!t.updatedAt || new Date(r.updatedAt) > new Date(t.updatedAt))) t.updatedAt = r.updatedAt;
            };
            add(own, k);
            add(roll, k);
            const parentId = id(catById.get(k)?.parent);
            if (parentId && roll.has(parentId)) add(roll, parentId);
        }

        const decorated = cats.map(c => {
            const k = String(c._id);
            const r = roll.get(k);
            const p = catById.get(id(c.parent));
            return {
                _id: k,
                name: c.name,
                description: c.description || '',
                icon: c.icon || 'box',
                color: c.color || '',
                parent: p ? { _id: String(p._id), name: p.name, icon: p.icon || 'box' } : null,
                parentId: id(c.parent),
                children: cats.filter(x => id(x.parent) === k).length,
                items: r.items,
                ownItems: own.get(k).items,
                value: round(r.value),
                lowStock: r.low,
                defaultUnit: c.defaultUnit || '',
                defaultGst: num(c.defaultGst),
                defaultHsnCode: c.defaultHsnCode || '',
                isActive: c.isActive !== false,
                state: c.isActive !== false ? 'active' : 'inactive',
                updatedAt: r.updatedAt || c.updatedAt,
                createdAt: c.createdAt,
            };
        });

        // The whole catalogue's figures. Summed from each category's own totals
        // rather than the rolled-up ones, or a parent would count its
        // children's items a second time.
        const totalItems = perCat.rows.reduce((t, r) => t + num(r.items), 0);
        const totalValue = perCat.rows.reduce((t, r) => t + num(r.value), 0);
        const lowCount = perCat.rows.reduce((t, r) => t + num(r.low), 0);

        let rows = decorated;
        if (search) rows = rows.filter(c => rx(search).test(`${c.name} ${c.description}`));
        if (status) rows = rows.filter(c => c.state === status);
        if (parent) rows = rows.filter(c => (parent === 'top' ? !c.parentId : c.parentId === parent));

        const SORT = {
            name: (a, b) => a.name.localeCompare(b.name),
            'name-desc': (a, b) => b.name.localeCompare(a.name),
            items: (a, b) => b.items - a.items,
            value: (a, b) => b.value - a.value,
            recent: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        };
        rows = [...rows].sort(SORT[sort] || SORT.name);
        if (dir === 'desc' && SORT[sort] && !String(sort).includes('desc')) rows.reverse();

        const paged = pageOf(rows, paging(req.query, 10));

        ok(res, {
            tiles: {
                total:      { value: cats.length, delta: deltaPct(cats.length, countBefore(cats, monthAgo)), series: monthlySeries(cats).map(s => s.value) },
                items:      { value: totalItems },
                value:      { value: round(totalValue) },
                lowStock:   { value: lowCount },
            },
            filters: { parents: decorated.filter(c => !c.parentId).map(c => ({ _id: c._id, name: c.name })) },
            ...paged,
            matched: rows.length,
        });
    } catch (e) { err(res, e); }
};

exports.categoryDetail = async (req, res) => {
    try {
        const school = req.schoolId;
        const cat = await InventoryCategory.findOne({ _id: req.params.id, school }).lean();
        if (!cat) return bad(res, 'That category could not be found', 404);

        // The category and its children, then only THEIR items — this used to
        // read the school's whole catalogue and throw most of it away.
        const kidRows = await InventoryCategory.find({ school, parent: String(cat._id) }).select('_id').lean();
        const kids = kidRows.map(c => String(c._id));
        const scope = new Set([String(cat._id), ...kids]);

        const [cats, mine, stock, repairing, orders] = await Promise.all([
            InventoryCategory.find({ school }).lean(),
            InventoryItem.find({ school, category: { $in: [...scope] } }).lean(),
            stockIndex(school),
            repairIndex(school),
            PurchaseOrder.find({ school }).sort({ createdAt: -1 }).limit(120).lean(),
        ]);
        const mineIds = new Set(mine.map(i => String(i._id)));
        const whs = await InventoryWarehouse.find({ school }).lean();
        const whById = new Map(whs.map(w => [String(w._id), w]));

        const rows = mine.map(it => {
            const a = stock.byItem.get(String(it._id));
            return {
                _id: String(it._id), name: it.name, itemCode: it.itemCode, image: it.image || '',
                unit: it.unit || 'Nos', current: round(a?.qty), reorderLevel: num(it.reorderLevel),
                value: round(a?.value), state: itemState(it, a, repairing),
                warehouse: whChip(whById.get(id(it.warehouse))),
            };
        }).sort((a, b) => b.value - a.value);

        // Where this category's stock physically sits.
        const byWarehouse = new Map();
        for (const s of stock.rows) {
            if (!mineIds.has(String(s.item))) continue;
            const w = whById.get(String(s.warehouse));
            const k = String(s.warehouse);
            const c = byWarehouse.get(k) || { _id: k, name: w?.name || 'Unknown store', code: w?.code || '', quantity: 0, value: 0, items: 0 };
            c.quantity += num(s.quantity); c.value += num(s.quantity) * num(s.avgCost); c.items += 1;
            byWarehouse.set(k, c);
        }

        const history = [];
        for (const o of orders) {
            const lines = (o.items || []).filter(li => li.item && mineIds.has(String(li.item)));
            if (!lines.length) continue;
            history.push({
                _id: String(o._id), poNumber: o.poNumber, date: o.createdAt,
                state: ORDER_STATE[o.status] || o.status,
                quantity: lines.reduce((s, l) => s + num(l.quantity), 0),
                value: round(lines.reduce((s, l) => s + num(l.quantity) * num(l.unitPrice), 0)),
                lines: lines.length,
            });
        }

        ok(res, {
            category: {
                ...cat, _id: String(cat._id),
                icon: cat.icon || 'box',
                parent: cats.find(c => String(c._id) === id(cat.parent))
                    ? { _id: id(cat.parent), name: cats.find(c => String(c._id) === id(cat.parent)).name } : null,
                state: cat.isActive !== false ? 'active' : 'inactive',
            },
            stats: {
                items: mine.length,
                value: round(rows.reduce((s, r) => s + r.value, 0)),
                lowStock: rows.filter(r => r.state === 'low_stock' || r.state === 'out_of_stock').length,
                updatedAt: mine.reduce((mx, it) => (!mx || new Date(it.updatedAt) > new Date(mx) ? it.updatedAt : mx), null) || cat.updatedAt,
                subCategories: kids.length,
            },
            items: rows,
            stock: [...byWarehouse.values()].sort((a, b) => b.value - a.value).map(w => ({ ...w, value: round(w.value), quantity: round(w.quantity) })),
            history: history.slice(0, 20),
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   10. Warehouses
   ═══════════════════════════════════════════════════════════════════════════ */

exports.warehouseBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', status = '', location = '', type = '', sort = 'name', dir = 'asc' } = req.query;
        const now = new Date();
        const monthAgo = new Date(now.getTime() - 30 * MS_DAY);

        // What each store holds, summed per store. The stores themselves are
        // a handful of rows; the stock they hold is not, and rolling it up in
        // Node meant reading every balance the school has to fill in three
        // columns on six rows.
        const up = Q.params();
        const uid = up.$(String(school));
        const [whs, usage] = await Promise.all([
            InventoryWarehouse.find({ school }).lean(),
            Q.pool.query(`
                SELECT "warehouse",
                       COALESCE(SUM("quantity"), 0)::numeric                             AS "qty",
                       COALESCE(SUM("quantity" * COALESCE("avgCost", 0)), 0)::numeric    AS "value",
                       count(*)::int                                                     AS "items"
                  FROM ${Q.T(InventoryStock)}
                 WHERE "school" = ${uid}
                 GROUP BY "warehouse"`, up.list),
        ]);
        const held = new Map(usage.rows.map(r => [String(r.warehouse), {
            qty: num(r.qty), value: num(r.value), items: num(r.items),
        }]));

        const decorated = whs.map(w => {
            const k = String(w._id);
            const u = held.get(k) || { qty: 0, value: 0, items: 0 };
            const capacity = num(w.capacity);
            const used = round(u.qty);
            const usage = capacity > 0 ? Math.min(999, Math.round((used / capacity) * 100)) : null;
            const lowAt = num(w.lowCapacityAt) || 80;
            return {
                _id: k,
                name: w.name,
                code: w.code || '',
                type: w.type || 'department',
                description: w.description || '',
                image: w.image || '',
                campus: w.campus || '',
                location: w.location || w.campus || '',
                contactPerson: w.contactPerson || '',
                phone: w.phone || '',
                capacity,
                used,
                available: capacity > 0 ? Math.max(0, capacity - used) : null,
                usage,
                value: round(u.value),
                itemCount: u.items,
                isActive: w.isActive !== false,
                // A store is "Low Capacity" when it is nearly full — the figure
                // the school set, not a number we picked.
                state: w.isActive === false ? 'inactive'
                    : (usage != null && usage >= lowAt) ? 'low_capacity' : 'active',
                createdAt: w.createdAt,
            };
        });

        const active = decorated.filter(w => w.state === 'active').length;
        const low = decorated.filter(w => w.state === 'low_capacity').length;
        const inactive = decorated.filter(w => w.state === 'inactive').length;

        let rows = decorated;
        if (search)   rows = rows.filter(w => rx(search).test(`${w.name} ${w.code} ${w.location} ${w.description}`));
        if (status)   rows = rows.filter(w => w.state === status);
        if (location) rows = rows.filter(w => w.location === location);
        if (type)     rows = rows.filter(w => w.type === type);

        const SORT = {
            name: (a, b) => a.name.localeCompare(b.name),
            code: (a, b) => a.code.localeCompare(b.code),
            type: (a, b) => a.type.localeCompare(b.type),
            location: (a, b) => a.location.localeCompare(b.location),
            capacity: (a, b) => a.capacity - b.capacity,
            usage: (a, b) => num(a.usage) - num(b.usage),
            state: (a, b) => a.state.localeCompare(b.state),
        };
        rows = [...rows].sort(SORT[sort] || SORT.name);
        if (dir === 'desc') rows.reverse();

        const paged = pageOf(rows, paging(req.query, 10));

        ok(res, {
            tiles: {
                total:    { value: decorated.length, delta: deltaPct(decorated.length, countBefore(whs, monthAgo)), series: monthlySeries(whs).map(s => s.value) },
                active:   { value: active, pct: pct(active, decorated.length) },
                low:      { value: low, pct: pct(low, decorated.length) },
                inactive: { value: inactive, pct: pct(inactive, decorated.length) },
            },
            filters: { locations: [...new Set(decorated.map(w => w.location).filter(Boolean))].sort() },
            ...paged,
            matched: rows.length,
        });
    } catch (e) { err(res, e); }
};

exports.warehouseDetail = async (req, res) => {
    try {
        const school = req.schoolId;
        const wh = await InventoryWarehouse.findOne({ _id: req.params.id, school }).lean();
        if (!wh) return bad(res, 'That warehouse could not be found', 404);

        const [m, stock, txns] = await Promise.all([
            masters(school),
            InventoryStock.find({ school, warehouse: wh._id }).lean(),
            InventoryStockTransaction.find({ school, warehouse: wh._id }).sort({ createdAt: -1 }).limit(25).lean(),
        ]);
        // Only the items this store actually holds or has moved — the whole
        // catalogue was being read to name a few dozen rows.
        const wanted = [...new Set([
            ...stock.map(x => String(x.item)),
            ...txns.map(t => String(t.item)),
        ].filter(Boolean))];
        const items = wanted.length
            ? await InventoryItem.find({ school, _id: { $in: wanted } })
                .select('name itemCode image category unit reorderLevel rack shelf bin').lean()
            : [];
        const itemById = new Map(items.map(i => [String(i._id), i]));
        const users = await userIndex(school, [wh.manager, ...txns.map(t => t.performedBy)]);

        const rows = stock.map(s => {
            const it = itemById.get(String(s.item));
            if (!it) return null;
            return {
                _id: String(s._id), itemId: String(it._id),
                name: it.name, itemCode: it.itemCode, image: it.image || '',
                unit: it.unit || 'Nos',
                category: catChip(m.cat.get(id(it.category))),
                quantity: round(s.quantity), reserved: round(s.reserved),
                value: round(num(s.quantity) * num(s.avgCost)),
                reorderLevel: num(it.reorderLevel),
                state: rowState(it, s.quantity),
                rack: it.rack || '', shelf: it.shelf || '', bin: it.bin || '',
                updatedAt: s.updatedAt,
            };
        }).filter(Boolean).sort((a, b) => b.value - a.value);

        const used = rows.reduce((s, r) => s + r.quantity, 0);
        const capacity = num(wh.capacity);

        // The named places inside the store, from where its items are filed.
        const spots = new Map();
        for (const r of rows) {
            const key = [r.rack, r.shelf, r.bin].filter(Boolean).join(' / ') || 'Unfiled';
            const s = spots.get(key) || { name: key, items: 0, quantity: 0 };
            s.items += 1; s.quantity += r.quantity;
            spots.set(key, s);
        }

        ok(res, {
            warehouse: {
                ...wh, _id: String(wh._id),
                code: wh.code || '', type: wh.type || 'department',
                manager: wh.manager ? who(users.get(String(wh.manager))) : null,
                state: wh.isActive === false ? 'inactive'
                    : (capacity > 0 && (used / capacity) * 100 >= (num(wh.lowCapacityAt) || 80)) ? 'low_capacity' : 'active',
            },
            stats: {
                items: rows.length,
                units: used,
                capacity,
                available: capacity > 0 ? Math.max(0, capacity - used) : null,
                usage: capacity > 0 ? Math.min(999, Math.round((used / capacity) * 100)) : null,
                value: round(rows.reduce((s, r) => s + r.value, 0)),
                lowStock: rows.filter(r => r.state !== 'in_stock').length,
            },
            stock: rows,
            spots: [...spots.values()].sort((a, b) => b.quantity - a.quantity),
            activity: txns.map(t => ({
                _id: String(t._id), type: t.type, quantity: num(t.quantity),
                balanceAfter: num(t.balanceAfter), note: t.note || '',
                item: itemById.get(String(t.item))
                    ? { _id: String(t.item), name: itemById.get(String(t.item)).name, itemCode: itemById.get(String(t.item)).itemCode }
                    : null,
                by: who(users.get(String(t.performedBy))),
                at: t.createdAt,
            })),
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   11. Budgets
   ═══════════════════════════════════════════════════════════════════════════ */

// What a budget has spent lives in services/inventoryBudget.js — the same
// function the purchase-order guard uses, so the screen and the block can
// never disagree about how much is left.
const budgetSpend = (budget, orders, itemCatOf) => budgets.spendOf(budget, orders, itemCatOf);

exports.budgetBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', academicYear = '', department = '', category = '', status = '', tab = 'all', sort = 'name', dir = 'asc' } = req.query;
        const now = new Date();

        // The spend comes from services/inventoryBudget, which sums it per
        // budget in one statement. This screen used to read every purchase
        // order and every item in the school to work out the same figures in
        // Node, and the monthly chart below read them a second time.
        const mp = Q.params();
        const mid = mp.$(String(school));
        const [m, allBudgets, live, monthlyRows, years] = await Promise.all([
            masters(school),
            InventoryBudget.find({ school }).lean(),
            budgets.load(school),
            Q.pool.query(`
                SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS "month",
                       COALESCE(SUM("grandTotal"), 0)::numeric              AS "spent",
                       count(*)::int                                       AS "orders"
                  FROM ${Q.T(PurchaseOrder)}
                 WHERE "school" = ${mid} AND "status" <> 'cancelled'
                   AND "createdAt" >= date_trunc('month', now()) - INTERVAL '11 months'
                 GROUP BY 1`, mp.list),
            AcademicYear.find({ school }).lean(),
        ]);
        const yearById = new Map(years.map(y => [String(y._id), y]));
        // `load` only returns active budgets; a closed one still shows on this
        // screen, with the spend it had when it was closed.
        const spentById = new Map(live.map(b => [String(b._id), num(b.spent)]));
        const closedSpend = allBudgets.filter(b => !spentById.has(String(b._id)));
        if (closedSpend.length) {
            const { rows } = await Q.pool.query(`
                SELECT "budget", COALESCE(SUM("grandTotal"), 0)::numeric AS "spent"
                  FROM ${Q.T(PurchaseOrder)}
                 WHERE "school" = $1 AND "status" <> 'cancelled' AND "budget" = ANY($2::uuid[])
                 GROUP BY "budget"`, [String(school), closedSpend.map(b => String(b._id))]);
            rows.forEach(r => spentById.set(String(r.budget), num(r.spent)));
        }

        const decorated = allBudgets.map(b => {
            const spent = num(spentById.get(String(b._id)));
            const allocated = num(b.allocated);
            const remaining = allocated - spent;
            const usage = allocated > 0 ? Math.round((spent / allocated) * 100) : 0;
            const y = yearById.get(id(b.academicYear));
            return {
                _id: String(b._id),
                name: b.name,
                code: b.code || '',
                icon: b.icon || 'wallet',
                scope: b.scope || 'department',
                department: m.dep.get(id(b.department)) ? { _id: id(b.department), name: m.dep.get(id(b.department)).name } : null,
                departmentId: id(b.department),
                category: catChip(m.cat.get(id(b.category))),
                categoryId: id(b.category),
                academicYear: y ? { _id: String(y._id), name: y.yearName } : null,
                academicYearId: id(b.academicYear),
                periodStart: b.periodStart,
                periodEnd: b.periodEnd,
                allocated,
                spent: round(spent),
                remaining: round(remaining),
                usage,
                description: b.description || '',
                alertAt: num(b.alertAt) || 90,
                // Over Budget is what spending more than the allocation means;
                // closed is the school's own decision.
                state: b.status === 'closed' ? 'closed'
                    : remaining < 0 ? 'over_budget'
                    : usage >= (num(b.alertAt) || 90) ? 'near_limit' : 'active',
                createdAt: b.createdAt,
            };
        });

        const hasDept = (b) => !!b.departmentId;
        const hasCat  = (b) => !!b.categoryId;
        const tabs = {
            all: decorated.length,
            department: decorated.filter(hasDept).length,
            category: decorated.filter(hasCat).length,
        };

        // Monthly overview — every budget's spend, month by month, across the
        // widest period any of them covers.
        const monthly = (() => {
            const buckets = [];
            for (let i = 11; i >= 0; i--) {
                const s = monthStart(now, i); const e = monthStart(now, i - 1);
                buckets.push({ month: s.toISOString().slice(0, 7), label: monthLabel(s), spent: 0, orders: 0 });
            }
            const byMonth = new Map(monthlyRows.rows.map(r => [r.month, r]));
            for (const b of buckets) {
                const r = byMonth.get(b.month);
                if (r) { b.spent = num(r.spent); b.orders = num(r.orders); }
            }
            const allocatedPerMonth = decorated.reduce((s, b) => s + b.allocated, 0) / 12;
            return buckets.map(b => ({ ...b, spent: round(b.spent), allocated: round(allocatedPerMonth) }));
        })();

        let rows = decorated;
        if (tab === 'department') rows = rows.filter(hasDept);
        if (tab === 'category')   rows = rows.filter(hasCat);
        if (search)       rows = rows.filter(b => rx(search).test(`${b.name} ${b.code} ${b.department?.name || ''} ${b.category?.name || ''}`));
        if (academicYear) rows = rows.filter(b => b.academicYearId === academicYear);
        if (department)   rows = rows.filter(b => b.departmentId === department);
        if (category)     rows = rows.filter(b => b.categoryId === category);
        if (status)       rows = rows.filter(b => b.state === status);

        const SORT = {
            name: (a, b) => a.name.localeCompare(b.name),
            department: (a, b) => (a.department?.name || '').localeCompare(b.department?.name || ''),
            category: (a, b) => (a.category?.name || '').localeCompare(b.category?.name || ''),
            allocated: (a, b) => a.allocated - b.allocated,
            spent: (a, b) => a.spent - b.spent,
            remaining: (a, b) => a.remaining - b.remaining,
            usage: (a, b) => a.usage - b.usage,
        };
        rows = [...rows].sort(SORT[sort] || SORT.name);
        if (dir === 'desc') rows.reverse();

        const paged = pageOf(rows, paging(req.query, 10));

        const allocated = decorated.reduce((s, b) => s + b.allocated, 0);
        const spent = decorated.reduce((s, b) => s + b.spent, 0);
        const overCount = decorated.filter(b => b.state === 'over_budget').length;
        const lastYearAllocated = allBudgets
            .filter(b => b.periodStart && new Date(b.periodStart) < monthStart(now, 12))
            .reduce((s, b) => s + num(b.allocated), 0);

        ok(res, {
            tiles: {
                allocated: { value: round(allocated), delta: deltaPct(allocated, lastYearAllocated), series: monthly.slice(-6).map(x => x.allocated) },
                spent:     { value: round(spent), pct: pct(spent, allocated), series: monthly.slice(-6).map(x => x.spent) },
                remaining: { value: round(allocated - spent), pct: pct(allocated - spent, allocated) },
                over:      { value: overCount },
            },
            tabs, monthly,
            filters: {
                years: years.map(y => ({ _id: String(y._id), name: y.yearName, status: y.status })),
                departments: m.departments.map(d => ({ _id: String(d._id), name: d.name })),
                categories: m.categories.filter(c => c.isActive !== false).map(catChip),
            },
            ...paged,
            matched: rows.length,
        });
    } catch (e) { err(res, e); }
};

exports.budgetDetail = async (req, res) => {
    try {
        const school = req.schoolId;
        const budget = await InventoryBudget.findOne({ _id: req.params.id, school }).lean();
        if (!budget) return bad(res, 'That budget could not be found', 404);

        // Only orders that could possibly count against this budget: inside its
        // period, not cancelled, and either pinned to it or belonging to its
        // department. A budget scoped by category still needs its lines looked
        // at, which is what `budgetSpend` does — but on a far smaller set than
        // every order the school has ever raised.
        const oq = { school, status: { $ne: 'cancelled' } };
        if (budget.periodStart || budget.periodEnd) {
            oq.createdAt = {};
            if (budget.periodStart) oq.createdAt.$gte = new Date(budget.periodStart);
            if (budget.periodEnd) {
                const end = new Date(budget.periodEnd); end.setHours(23, 59, 59, 999);
                oq.createdAt.$lte = end;
            }
        }
        if (id(budget.department) && !id(budget.category)) {
            oq.$or = [{ department: id(budget.department) }, { budget: String(budget._id) }];
        }

        const [m, orders, years] = await Promise.all([
            masters(school),
            PurchaseOrder.find(oq).sort({ createdAt: -1 }).lean(),
            AcademicYear.find({ school }).lean(),
        ]);
        // A budget scoped by category has to know each line's category, so the
        // items those orders name are read — not the whole catalogue.
        const budgetItemIds = [...new Set(orders
            .flatMap(o => (o.items || []).map(li => li.item))
            .filter(Boolean).map(String))];
        const items = budgetItemIds.length
            ? await InventoryItem.find({ school, _id: { $in: budgetItemIds } })
                .select('name itemCode image category unit').lean()
            : [];
        const itemById = new Map(items.map(i => [String(i._id), i]));
        const itemCatOf = new Map(items.map(i => [String(i._id), id(i.category)]));
        const { spent, lines } = budgetSpend(budget, orders, itemCatOf);

        const allocated = num(budget.allocated);
        const y = years.find(x => String(x._id) === id(budget.academicYear));

        // What the money went on, item by item.
        const byItem = new Map();
        for (const { order, partial } of lines) {
            for (const li of (order.items || [])) {
                if (partial && !(li.item && itemCatOf.get(String(li.item)) === id(budget.category))) continue;
                const key = li.item ? String(li.item) : `name:${li.itemName}`;
                const it = li.item ? itemById.get(String(li.item)) : null;
                const c = byItem.get(key) || {
                    _id: li.item ? String(li.item) : '', name: it?.name || li.itemName,
                    itemCode: it?.itemCode || '', image: it?.image || '',
                    category: catChip(m.cat.get(id(it?.category))),
                    quantity: 0, amount: 0,
                };
                c.quantity += num(li.quantity);
                c.amount += num(li.quantity) * num(li.unitPrice) * (1 + num(li.gst) / 100);
                byItem.set(key, c);
            }
        }

        const expenses = lines
            .map(({ order, amount, partial }) => ({
                _id: String(order._id), poNumber: order.poNumber,
                vendor: m.ven.get(id(order.vendor))?.name || '',
                date: order.createdAt, amount: round(amount), partial,
                state: ORDER_STATE[order.status] || order.status,
                title: (order.items || [])[0]?.itemName || order.poNumber,
                itemCount: (order.items || []).length,
            }))
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        // Month-by-month spend across the budget's own period.
        const history = (() => {
            const map = new Map();
            for (const e of expenses) {
                const k = new Date(e.date).toISOString().slice(0, 7);
                map.set(k, num(map.get(k)) + e.amount);
            }
            return [...map.entries()].sort().map(([month, amount]) => ({
                month,
                label: `${monthLabel(`${month}-01T00:00:00`)} ${month.slice(2, 4)}`,
                amount: round(amount),
            }));
        })();

        ok(res, {
            budget: {
                ...budget, _id: String(budget._id),
                department: m.dep.get(id(budget.department)) ? { _id: id(budget.department), name: m.dep.get(id(budget.department)).name } : null,
                category: catChip(m.cat.get(id(budget.category))),
                academicYear: y ? { _id: String(y._id), name: y.yearName } : null,
                state: budget.status === 'closed' ? 'closed'
                    : (allocated - spent) < 0 ? 'over_budget'
                    : (allocated > 0 && (spent / allocated) * 100 >= (num(budget.alertAt) || 90)) ? 'near_limit' : 'active',
            },
            stats: {
                allocated,
                spent: round(spent),
                remaining: round(allocated - spent),
                usage: allocated > 0 ? Math.round((spent / allocated) * 100) : 0,
                orders: lines.length,
            },
            expenses,
            items: [...byItem.values()].map(x => ({ ...x, amount: round(x.amount) })).sort((a, b) => b.amount - a.amount),
            history,
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   12. Activity Log
   ═══════════════════════════════════════════════════════════════════════════ */

// Actions that change or destroy a record's meaning rather than adding to it.
// The screen counts these as "Critical Changes"; old rows that predate the
// `critical` flag are judged by the same rule here so the count is not wrong
// for everything logged before Sep 2026.
const CRITICAL = /DELETE|CANCEL|REJECT|SCRAP|WRITE_OFF|DISPOS|BUDGET|WRITEOFF|LOST/i;
const isCritical = (l) => (l.critical === true) || CRITICAL.test(l.actionType || '');

/**
 * The same classification the JS helpers do, expressed as SQL, so the log can
 * be filtered on module, verb and severity without reading it into Node.
 * Built once from the constants above — they are the only source, so the two
 * cannot drift.
 */
const LOG_MODULE_SQL = Q.caseOf('l."entityType"', LOG_MODULE, 'Inventory');
const LOG_VERB_SQL = Q.chainOf(`upper(COALESCE(l."actionType", ''))`, [
    [`(%s LIKE '%\\_CREATED' OR %s LIKE '%\\_ADDED' OR %s LIKE '%CREATE%')`, 'created'],
    [`(%s LIKE '%\\_DELETED' OR %s LIKE '%DELETE%')`, 'deleted'],
    [`(%s LIKE '%\\_UPDATED' OR %s LIKE '%UPDATE%')`, 'updated'],
    [`%s LIKE '%APPROVED%'`, 'approved'],
    [`%s LIKE '%REJECTED%'`, 'rejected'],
    [`%s LIKE '%ISSUED%'`, 'issued'],
    [`%s LIKE '%RETURNED%'`, 'returned'],
    [`%s LIKE '%RECEIVED%'`, 'received'],
    [`%s LIKE '%CANCEL%'`, 'cancelled'],
    [`%s LIKE '%TRANSFER%'`, 'transferred'],
], 'updated');
// Matches CRITICAL above. `~*` is Postgres's case-insensitive regex.
const LOG_CRITICAL_SQL = `(l."critical" IS TRUE
    OR COALESCE(l."actionType", '') ~* 'DELETE|CANCEL|REJECT|SCRAP|WRITE_OFF|DISPOS|BUDGET|WRITEOFF|LOST')`;

/**
 * The audit log, filtered and paged in the database.
 *
 * It used to take the newest 4,000 rows and filter the array. A school past
 * four thousand log lines — which is a term or two — simply could not search
 * the older ones: they were never in the array to be found.
 */
function activityWhere(school, query) {
    const { search = '', module = '', action = '', user = '', entityType = '', critical = '' } = query;
    const r = range(query);
    const p = Q.params();
    const where = [`l."school" = ${p.$(String(school))}`];
    if (user)       where.push(`l."user" = ${p.$(String(user))}`);
    if (entityType) where.push(`l."entityType" = ${p.$(String(entityType))}`);
    if (module)     where.push(`${LOG_MODULE_SQL} = ${p.$(String(module))}`);
    if (action)     where.push(`${LOG_VERB_SQL} = ${p.$(String(action))}`);
    if (critical === 'true') where.push(LOG_CRITICAL_SQL);
    if (r?.from)    where.push(`l."timestamp" >= ${p.$(r.from)}`);
    if (r?.to)      where.push(`l."timestamp" <= ${p.$(r.to)}`);
    if (search) {
        const pat = Q.like(p, search);
        where.push(`(l."description" ILIKE ${pat} OR l."actionType" ILIKE ${pat}
                     OR l."referenceCode" ILIKE ${pat} OR l."entityType" ILIKE ${pat})`);
    }
    return { p, where: where.join(' AND ') };
}

const ACTIVITY_SELECT = `
    SELECT l."_id", l."timestamp", l."user", l."role", l."actionType", l."entityType",
           l."entityId", l."description", l."referenceCode", l."ip", l."meta",
           ${LOG_MODULE_SQL} AS "module",
           ${LOG_VERB_SQL}   AS "verb",
           ${LOG_CRITICAL_SQL} AS "isCritical",
           u."name" AS "byName", u."role" AS "byRole",
           u."email" AS "byEmail", u."profileImage" AS "byPhoto"`;

exports.activityBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { p, where } = activityWhere(school, req.query);

        const base = `
            ${ACTIVITY_SELECT}, count(*) OVER ()::int AS "__matched"
              FROM ${Q.T(InventoryAuditLog)} l
              LEFT JOIN ${Q.T(User)} u ON u."_id" = l."user"
             WHERE ${where}`;

        // The tiles describe the whole log, not the filtered view — a count of
        // "total activities" that moved when you typed in the search box would
        // be describing the search, not the school.
        const tp = Q.params();
        const sid = tp.$(String(school));
        const tileSql = `
            SELECT count(*)::int AS "total",
                   count(*) FILTER (WHERE l."timestamp" >= date_trunc('day', now()))::int AS "today",
                   count(*) FILTER (WHERE l."timestamp" >= date_trunc('day', now()) - INTERVAL '1 day'
                                      AND l."timestamp" <  date_trunc('day', now()))::int AS "yesterday",
                   count(*) FILTER (WHERE l."timestamp" < now() - INTERVAL '30 days')::int AS "before",
                   count(DISTINCT l."user") FILTER (WHERE l."timestamp" >= now() - INTERVAL '30 days')::int AS "activeUsers",
                   count(DISTINCT l."user") FILTER (WHERE l."timestamp" >= date_trunc('month', now()))::int AS "monthUsers",
                   count(DISTINCT ${LOG_MODULE_SQL}) FILTER (WHERE l."timestamp" >= now() - INTERVAL '30 days')::int AS "modules",
                   count(*) FILTER (WHERE l."timestamp" >= now() - INTERVAL '30 days' AND ${LOG_CRITICAL_SQL})::int AS "critical"
              FROM ${Q.T(InventoryAuditLog)} l
             WHERE l."school" = ${sid}`;

        const up = Q.params();
        const usersSql = `
            SELECT DISTINCT u."_id", u."name"
              FROM ${Q.T(InventoryAuditLog)} l
              JOIN ${Q.T(User)} u ON u."_id" = l."user"
             WHERE l."school" = ${up.$(String(school))}
             ORDER BY u."name"`;

        const [listed, tiles, pickable, series] = await Promise.all([
            Q.page(base, p, {
                sort: 'timestamp', dir: req.query.dir || 'desc',
                page: req.query.page, limit: req.query.limit || 10,
                sorts: { timestamp: 'l."timestamp"' },
            }),
            Q.pool.query(tileSql, tp.list),
            Q.pool.query(usersSql, up.list),
            Q.monthly(`SELECT "timestamp" AS "at" FROM ${Q.T(InventoryAuditLog)} WHERE "school" = $1`, [String(school)]),
        ]);
        const t = tiles.rows[0] || {};

        ok(res, {
            tiles: {
                total:    { value: num(t.total), delta: deltaPct(num(t.total), num(t.before)), series },
                users:    { value: num(t.activeUsers), added: num(t.monthUsers) },
                modules:  { value: num(t.modules) },
                today:    { value: num(t.today), delta: deltaPct(num(t.today), num(t.yesterday)) },
                critical: { value: num(t.critical) },
            },
            filters: {
                modules: [...new Set(Object.values(LOG_MODULE))].sort(),
                actions: ['created', 'updated', 'deleted', 'approved', 'rejected', 'issued', 'returned', 'received', 'cancelled', 'transferred'],
                entityTypes: [...new Set(Object.keys(LOG_MODULE))],
                users: pickable.rows.map(u => ({ _id: String(u._id), name: u.name })),
            },
            rows: listed.rows.map(l => ({
                _id: String(l._id),
                at: l.timestamp,
                by: who(l.user ? { _id: l.user, name: l.byName, role: l.byRole, email: l.byEmail, profileImage: l.byPhoto } : null),
                role: l.role || '',
                verb: l.verb,
                actionType: l.actionType,
                module: l.module,
                entityType: l.entityType || '',
                entityId: l.entityId ? String(l.entityId) : '',
                description: l.description || l.actionType,
                referenceCode: l.referenceCode || '',
                ip: l.ip || '',
                critical: !!l.isCritical,
                hasMeta: !!(l.meta && Object.keys(l.meta).length),
            })),
            total: listed.total, pages: listed.pages, page: listed.page, limit: listed.limit,
            matched: listed.matched,
        });
    } catch (e) { err(res, e); }
};

exports.activityDetail = async (req, res) => {
    try {
        const school = req.schoolId;
        const log = await InventoryAuditLog.findOne({ _id: req.params.id, school }).lean();
        if (!log) return bad(res, 'That activity entry could not be found', 404);
        const users = await userIndex(school, [log.user]);
        const u = users.get(String(log.user));

        // The record the line refers to, if it is still there. A log entry
        // outlives what it describes, so a missing target is normal and is
        // reported as such rather than as an error.
        let target = null;
        const MODELS = {
            InventoryItem, InventoryVendor, InventoryCategory, InventoryWarehouse,
            InventoryAsset, InventoryIssue, InventoryDepartment, InventoryBudget,
            PurchaseOrder, PurchaseRequest,
        };
        const Model = MODELS[log.entityType];
        if (Model && log.entityId) {
            const doc = await Model.findOne({ _id: log.entityId, school }).lean().catch(() => null);
            if (doc) {
                target = {
                    _id: String(doc._id),
                    label: doc.name || doc.poNumber || doc.requestNumber || doc.issueNumber || doc.assetCode || doc.itemCode || '',
                    code: doc.poNumber || doc.requestNumber || doc.issueNumber || doc.assetCode || doc.itemCode || doc.code || '',
                    status: doc.status || '',
                    total: num(doc.grandTotal) || num(doc.estimatedTotal) || num(doc.allocated) || 0,
                    itemCount: Array.isArray(doc.items) ? doc.items.length : 0,
                    createdAt: doc.createdAt,
                };
            }
        }

        ok(res, {
            entry: {
                _id: String(log._id),
                at: log.timestamp,
                by: who(u),
                role: log.role || '',
                verb: logVerb(log.actionType),
                actionType: log.actionType,
                module: LOG_MODULE[log.entityType] || 'Inventory',
                entityType: log.entityType || '',
                entityId: log.entityId ? String(log.entityId) : '',
                description: log.description || log.actionType,
                referenceCode: log.referenceCode || '',
                ip: log.ip || '',
                critical: isCritical(log),
                meta: log.meta || null,
            },
            target,
        });
    } catch (e) { err(res, e); }
};

/** Every matching line as a CSV, for the Export Logs button. */
exports.activityExport = async (req, res) => {
    try {
        const school = req.schoolId;
        const { p, where } = activityWhere(school, req.query);
        // Capped in the database. The old cap was applied to an array that had
        // itself been cut to the newest 4,000, so an export of "everything
        // matching" quietly meant "matching, within the newest four thousand".
        const { rows: capped } = await Q.pool.query(`
            ${ACTIVITY_SELECT}
              FROM ${Q.T(InventoryAuditLog)} l
              LEFT JOIN ${Q.T(User)} u ON u."_id" = l."user"
             WHERE ${where}
             ORDER BY l."timestamp" DESC
             LIMIT 5000`, p.list);
        const cell = (v) => {
            const s = v == null ? '' : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const header = ['Date & Time', 'User', 'Role', 'Action', 'Module', 'Description', 'Reference', 'IP Address', 'Critical'];
        const body = capped.map(l => [
            new Date(l.timestamp).toISOString(),
            l.byName || 'Unknown',
            l.role || '',
            l.verb,
            l.module,
            l.description || l.actionType,
            l.referenceCode || '',
            l.ip || '',
            l.isCritical ? 'yes' : 'no',
        ].map(cell).join(','));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="inventory-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send([header.join(','), ...body].join('\n'));
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   Shared option lists — what every form's dropdowns are made of
   ═══════════════════════════════════════════════════════════════════════════ */

exports.formMeta = async (req, res) => {
    try {
        const school = req.schoolId;
        const [m, items, years, budgets, staff, stock] = await Promise.all([
            masters(school),
            InventoryItem.find({ school, isActive: true })
                .select('name itemCode unit purchasePrice gst category warehouse reorderLevel image').sort({ name: 1 }).lean(),
            AcademicYear.find({ school }).lean(),
            InventoryBudget.find({ school, status: 'active' }).select('name code department category').sort({ name: 1 }).lean(),
            User.find({ school, isActive: true, role: { $in: ['school_admin', 'teacher'] } })
                .select('name role email profileImage').sort({ name: 1 }).limit(500).lean(),
            InventoryStock.find({ school }).select('item warehouse quantity reserved').lean(),
        ]);

        // Every form that moves stock needs to know what is there. Without
        // this the Issue form read `item.onHand` off a list that never carried
        // it, so its summary panel said "0 — out of stock" for everything.
        // Per store as well as in total, because an issue comes out of ONE
        // store and the total is not what governs it.
        const held = new Map();
        for (const s2 of stock) {
            const k = String(s2.item);
            const cur = held.get(k) || { onHand: 0, reserved: 0, byWarehouse: {} };
            cur.onHand += num(s2.quantity);
            cur.reserved += num(s2.reserved);
            cur.byWarehouse[String(s2.warehouse)] = {
                onHand: num(s2.quantity), reserved: num(s2.reserved),
                available: Math.max(0, num(s2.quantity) - num(s2.reserved)),
            };
            held.set(k, cur);
        }
        ok(res, {
            categories: m.categories.filter(c => c.isActive !== false).map(c => ({
                ...catChip(c), parent: id(c.parent),
                defaultUnit: c.defaultUnit || '', defaultGst: num(c.defaultGst), defaultHsnCode: c.defaultHsnCode || '',
                defaultWarehouse: id(c.defaultWarehouse),
            })),
            warehouses: m.warehouses.map(w => ({ ...whChip(w), type: w.type || 'department', isActive: w.isActive !== false, capacity: num(w.capacity) })),
            vendors: m.vendors.filter(v => v.isActive !== false).map(v => ({ _id: String(v._id), name: v.name, vendorCategory: v.vendorCategory || '', paymentTerms: v.paymentTerms || '' })),
            departments: m.departments.map(d => ({ _id: String(d._id), name: d.name })),
            items: items.map(i => ({
                _id: String(i._id), name: i.name, itemCode: i.itemCode, unit: i.unit || 'Nos',
                purchasePrice: num(i.purchasePrice), gst: num(i.gst), image: i.image || '',
                category: id(i.category), warehouse: id(i.warehouse), reorderLevel: num(i.reorderLevel),
                ...(held.get(String(i._id)) || { onHand: 0, reserved: 0, byWarehouse: {} }),
                available: Math.max(0, (held.get(String(i._id))?.onHand || 0) - (held.get(String(i._id))?.reserved || 0)),
            })),
            years: years.map(y => ({ _id: String(y._id), name: y.yearName, status: y.status, startDate: y.startDate, endDate: y.endDate })),
            budgets: budgets.map(b => ({ _id: String(b._id), name: b.name, code: b.code || '' })),
            staff: staff.map(u => ({ _id: String(u._id), name: u.name, role: u.role, email: u.email, photo: u.profileImage || '' })),
            units: ['Nos', 'Piece', 'Box', 'Ream', 'Packet', 'Set', 'Kg', 'Litre', 'Metre', 'Pair', 'Dozen', 'Bundle'],
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   Writes the redesigned screens need
   ═══════════════════════════════════════════════════════════════════════════ */

const CRITICAL_ACTION = /DELETE|CANCEL|REJECT|SCRAP|WRITE_OFF|DISPOS|LOST|BUDGET/i;
function clientIp(req) {
    const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return (fwd || req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
async function audit(req, actionType, entityType, entityId, description, meta, referenceCode = '') {
    try {
        await InventoryAuditLog.create({
            school: req.schoolId, user: req.userId, role: req.userRole,
            actionType, entityType, entityId, description, meta,
            referenceCode, ip: clientIp(req), critical: CRITICAL_ACTION.test(actionType),
        });
    } catch { /* an audit line must never fail the action it describes */ }
}

/* ── Budgets ─────────────────────────────────────────────────────────────── */

/** BUD-SCI-2026 — the department's initials and the year the period starts in. */
async function nextBudgetCode(school, name, department, periodStart) {
    const dep = department ? await InventoryDepartment.findOne({ _id: department, school }).select('name').lean() : null;
    const src = (dep?.name || name || 'GEN').replace(/[^A-Za-z ]/g, '').trim();
    const abbr = src.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase() || 'GEN';
    const year = periodStart ? new Date(periodStart).getFullYear() : new Date().getFullYear();
    let code = `BUD-${abbr}-${year}`;
    // Two budgets for one department in one year are allowed; their codes still
    // have to differ, so the second gets a suffix.
    for (let n = 2; await InventoryBudget.countDocuments({ school, code }); n++) code = `BUD-${abbr}-${year}-${n}`;
    return code;
}

const BUDGET_FIELDS = ['name', 'scope', 'department', 'category', 'academicYear', 'periodStart',
    'periodEnd', 'allocated', 'description', 'icon', 'owner', 'alertAt', 'status'];

function budgetBody(body) {
    const out = {};
    for (const k of BUDGET_FIELDS) {
        if (!(k in body)) continue;
        if (['department', 'category', 'academicYear', 'owner'].includes(k)) out[k] = body[k] || null;
        else if (['allocated', 'alertAt'].includes(k)) out[k] = Number(body[k]) || 0;
        else if (['periodStart', 'periodEnd'].includes(k)) out[k] = body[k] || null;
        else out[k] = body[k];
    }
    return out;
}

/** The checks both create and update run. Returns a message, or null. */
function budgetProblem(b) {
    if (!b.name) return 'Give the budget a name';
    if (!(Number(b.allocated) > 0)) return 'Allocate an amount greater than zero';
    const scope = b.scope || 'department';
    if (scope === 'department' && !b.department) return 'Pick the department this budget belongs to';
    if (scope === 'category' && !b.category) return 'Pick the category this budget covers';
    if (scope === 'both' && (!b.department || !b.category)) return 'Pick both a department and a category';
    if (b.periodStart && b.periodEnd && new Date(b.periodEnd) < new Date(b.periodStart))
        return 'The period ends before it starts';
    return null;
}

exports.createBudget = async (req, res) => {
    try {
        const body = budgetBody(req.body);
        const problem = budgetProblem(body);
        if (problem) return bad(res, problem);
        const code = String(req.body.code || '').trim()
            || await nextBudgetCode(req.schoolId, body.name, body.department, body.periodStart);
        const budget = await InventoryBudget.create({
            ...body, code, school: req.schoolId, createdBy: req.userId,
        });
        await audit(req, 'BUDGET_CREATED', 'InventoryBudget', budget._id,
            `Created budget ${budget.name}`, { allocated: budget.allocated }, code);
        ok(res, budget);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A budget with this name already exists for that year');
        err(res, e);
    }
};

exports.updateBudget = async (req, res) => {
    try {
        const current = await InventoryBudget.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!current) return bad(res, 'That budget could not be found', 404);
        const body = budgetBody(req.body);
        const problem = budgetProblem({ ...current, ...body });
        if (problem) return bad(res, problem);
        if (req.body.code !== undefined) body.code = String(req.body.code).trim() || current.code;
        const budget = await InventoryBudget.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId }, body, { new: true });
        await audit(req, 'BUDGET_UPDATED', 'InventoryBudget', budget._id,
            `Updated budget allocation ${budget.name}`, { allocated: budget.allocated }, budget.code);
        ok(res, budget);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A budget with this name already exists for that year');
        err(res, e);
    }
};

exports.deleteBudget = async (req, res) => {
    try {
        // A budget that purchase orders were charged to is the only record of
        // what they were charged against, so it is closed, not erased.
        const pinned = await PurchaseOrder.countDocuments({ school: req.schoolId, budget: req.params.id });
        if (pinned) return bad(res, `Cannot delete — ${pinned} purchase order(s) are charged to this budget. Close it instead.`);
        const budget = await InventoryBudget.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!budget) return bad(res, 'That budget could not be found', 404);
        await audit(req, 'BUDGET_DELETED', 'InventoryBudget', budget._id,
            `Deleted budget ${budget.name}`, null, budget.code);
        ok(res, { deleted: true });
    } catch (e) { err(res, e); }
};

/* ── Purchase order approval ─────────────────────────────────────────────── */

exports.approveOrder = async (req, res) => {
    try {
        const po = await PurchaseOrder.findOne({ _id: req.params.id, school: req.schoolId });
        if (!po) return bad(res, 'That purchase order could not be found', 404);
        if (po.status === 'cancelled') return bad(res, 'That purchase order was cancelled');
        if (!['draft', 'pending_approval'].includes(po.status)) return bad(res, 'That purchase order is already approved');
        po.status = 'approved';
        po.approvedBy = req.userId;
        po.approvedAt = new Date();
        await po.save();
        await audit(req, 'PO_APPROVED', 'PurchaseOrder', po._id,
            `Approved purchase order ${po.poNumber}`, { total: po.grandTotal }, po.poNumber);
        ok(res, po);
    } catch (e) { err(res, e); }
};

exports.dispatchOrder = async (req, res) => {
    try {
        const po = await PurchaseOrder.findOne({ _id: req.params.id, school: req.schoolId });
        if (!po) return bad(res, 'That purchase order could not be found', 404);
        if (!['approved', 'ordered'].includes(po.status))
            return bad(res, 'Only an approved purchase order can be marked as dispatched');
        po.status = 'in_transit';
        po.dispatchedAt = new Date();
        if (req.body?.expectedDelivery) po.expectedDelivery = req.body.expectedDelivery;
        await po.save();
        await audit(req, 'PO_DISPATCHED', 'PurchaseOrder', po._id,
            `Purchase order ${po.poNumber} marked in transit`, null, po.poNumber);
        ok(res, po);
    } catch (e) { err(res, e); }
};

/* ── Items: the bulk actions on the Items screen ─────────────────────────── */

exports.bulkItems = async (req, res) => {
    try {
        const { ids = [], action, category, warehouse } = req.body;
        const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(Boolean);
        if (!list.length) return bad(res, 'Pick at least one item first');
        if (list.length > 500) return bad(res, 'That is more than 500 items — narrow the selection first');

        const items = await InventoryItem.find({ _id: { $in: list }, school: req.schoolId }).select('name itemCode').lean();
        if (!items.length) return bad(res, 'None of those items belong to this school', 404);
        const owned = items.map(i => String(i._id));

        let changed = 0;
        if (action === 'activate' || action === 'deactivate') {
            const r = await InventoryItem.updateMany({ _id: { $in: owned }, school: req.schoolId },
                { isActive: action === 'activate' });
            changed = r?.modifiedCount ?? owned.length;
        } else if (action === 'category') {
            if (!category) return bad(res, 'Pick the category to move them to');
            const exists = await InventoryCategory.countDocuments({ _id: category, school: req.schoolId });
            if (!exists) return bad(res, 'That category could not be found', 404);
            const r = await InventoryItem.updateMany({ _id: { $in: owned }, school: req.schoolId }, { category });
            changed = r?.modifiedCount ?? owned.length;
        } else if (action === 'warehouse') {
            if (!warehouse) return bad(res, 'Pick the store to move them to');
            const exists = await InventoryWarehouse.countDocuments({ _id: warehouse, school: req.schoolId });
            if (!exists) return bad(res, 'That store could not be found', 404);
            const r = await InventoryItem.updateMany({ _id: { $in: owned }, school: req.schoolId }, { warehouse });
            changed = r?.modifiedCount ?? owned.length;
        } else if (action === 'delete') {
            // An item that still holds stock is not deleted — deleting it would
            // strand the stock rows and the ledger entries that point at it.
            const holding = await InventoryStock.find({ school: req.schoolId, item: { $in: owned }, quantity: { $gt: 0 } })
                .select('item').lean();
            const blocked = new Set(holding.map(h => String(h.item)));
            const free = owned.filter(x => !blocked.has(x));
            if (free.length) await InventoryItem.deleteMany({ _id: { $in: free }, school: req.schoolId });
            changed = free.length;
            await audit(req, 'ITEMS_BULK_DELETED', 'InventoryItem', null,
                `Deleted ${free.length} item(s)`, { requested: owned.length, blocked: blocked.size });
            return ok(res, {
                changed,
                blocked: blocked.size,
                message: blocked.size
                    ? `${free.length} deleted. ${blocked.size} still hold stock and were kept.`
                    : `${free.length} item(s) deleted.`,
            });
        } else {
            return bad(res, 'That bulk action is not one this screen offers');
        }

        await audit(req, 'ITEMS_BULK_UPDATED', 'InventoryItem', null,
            `Bulk ${action} on ${changed} item(s)`, { action, count: changed });
        ok(res, { changed, message: `${changed} item(s) updated.` });
    } catch (e) { err(res, e); }
};

/* ── Reorder: the button beside a low-stock row ──────────────────────────── */

exports.reorderItem = async (req, res) => {
    try {
        const { item, quantity, department, reason } = req.body;
        const it = await InventoryItem.findOne({ _id: item, school: req.schoolId }).lean();
        if (!it) return bad(res, 'That item could not be found', 404);

        const stock = await InventoryStock.find({ school: req.schoolId, item: it._id }).lean();
        const onHand = stock.reduce((s, r) => s + num(r.quantity), 0);
        const qty = Math.max(1, Math.round(Number(quantity)
            || Math.max(num(it.reorderLevel) * 2 - onHand, num(it.reorderLevel), 1)));

        // An item already on an open request does not need a second one — this
        // button is one click from a table and is easy to press twice.
        const open = await PurchaseRequest.find({ school: req.schoolId, status: { $in: ['pending', 'approved'] } })
            .select('requestNumber items').lean();
        const dup = open.find(r => (r.items || []).some(li => id(li.item) === String(it._id)));
        if (dup) return bad(res, `${it.name} is already on open request ${dup.requestNumber}`);

        const requestNumber = await nextNumber(req.schoolId, 'request');
        const estimatedTotal = qty * num(it.purchasePrice);

        const request = await PurchaseRequest.create({
            school: req.schoolId, requestNumber, requestedBy: req.userId,
            department: department || null,
            reason: reason || `Stock reorder — ${onHand} left against a reorder level of ${num(it.reorderLevel)}`,
            priority: onHand <= 0 ? 'urgent' : 'high',
            items: [{ item: it._id, itemName: it.name, quantity: qty, unit: it.unit || 'Nos', estimatedPrice: num(it.purchasePrice) }],
            estimatedTotal,
            checks: { stockAvailable: false, budgetOk: true, possibleDuplicate: false },
        });
        await audit(req, 'REQUEST_CREATED', 'PurchaseRequest', request._id,
            `Created reorder request for ${it.name}`, { quantity: qty }, requestNumber);
        ok(res, { request, message: `Reorder request ${requestNumber} raised for ${qty} ${it.unit || 'Nos'}.` });
    } catch (e) { err(res, e); }
};

/* ── Assets: the status / condition change from the row menu ─────────────── */

exports.setAssetState = async (req, res) => {
    try {
        const { status, condition, location, assignedTo, assignedName, nextMaintenance } = req.body;
        const asset = await InventoryAsset.findOne({ _id: req.params.id, school: req.schoolId });
        if (!asset) return bad(res, 'That asset could not be found', 404);
        const allowed = ['in_store', 'in_use', 'assigned', 'under_repair', 'out_of_service', 'retired', 'disposed', 'lost'];
        if (status) {
            if (!allowed.includes(status)) return bad(res, 'That is not an asset status');
            asset.status = status;
            // Taking an asset out of service, or retiring it, ends whoever had it.
            if (['retired', 'disposed', 'out_of_service', 'in_store'].includes(status)) {
                asset.assignedTo = null; asset.assignedName = '';
            }
        }
        if (condition) {
            if (!['good', 'fair', 'poor', 'damaged'].includes(condition)) return bad(res, 'That is not an asset condition');
            asset.condition = condition;
        }
        if (location !== undefined) asset.location = location;
        if (nextMaintenance !== undefined) asset.nextMaintenance = nextMaintenance || null;
        if (assignedTo !== undefined) {
            asset.assignedTo = assignedTo || null;
            asset.assignedName = assignedName || '';
            if (assignedTo && !status) asset.status = 'in_use';
        }
        await asset.save();
        await audit(req, 'ASSET_UPDATED', 'InventoryAsset', asset._id,
            `Updated asset details ${asset.name}`, { status: asset.status, condition: asset.condition }, asset.assetCode);
        ok(res, asset);
    } catch (e) { err(res, e); }
};

/* ── Requests raised by an administrator ─────────────────────────────────── */

/**
 * The Requests screen's "New Request" button.
 *
 * The teacher portal's create endpoint sits behind `requireRole('teacher')`,
 * so an administrator calling it is refused — which is right for that route
 * and wrong for this screen. Same document, same checks, admin guard.
 */
exports.createRequest = async (req, res) => {
    try {
        const school = req.schoolId;
        const { department, reason, priority, items } = req.body;
        const lines = (Array.isArray(items) ? items : [])
            .filter(l => l && l.item && num(l.quantity) > 0);
        if (!lines.length) return bad(res, 'Add at least one item with a quantity');
        if (!String(reason || '').trim()) return bad(res, 'Say what the items are for');

        // Only this school's items, and only at the price the master holds —
        // an estimate typed by the browser is not a source of truth.
        const known = await InventoryItem.find({ school, _id: { $in: lines.map(l => l.item) } })
            .select('name unit purchasePrice reorderLevel').lean();
        const byId = new Map(known.map(i => [String(i._id), i]));
        const bad_ = lines.find(l => !byId.has(String(l.item)));
        if (bad_) return bad(res, 'One of those items does not belong to this school', 404);

        const priced = lines.map(l => {
            const it = byId.get(String(l.item));
            return {
                item: l.item, itemName: it.name,
                quantity: Math.round(num(l.quantity)),
                unit: l.unit || it.unit || 'Nos',
                estimatedPrice: num(it.purchasePrice),
            };
        });
        const estimatedTotal = priced.reduce((s, l) => s + l.quantity * l.estimatedPrice, 0);

        // The pre-checks an approver sees: is it already on hand, and has
        // someone asked for the same thing this week?
        const stock = await InventoryStock.find({ school, item: { $in: priced.map(l => l.item) } })
            .select('item quantity reserved').lean();
        const onHand = new Map();
        stock.forEach(s => onHand.set(String(s.item), num(onHand.get(String(s.item))) + Math.max(0, num(s.quantity) - num(s.reserved))));
        const stockAvailable = priced.every(l => num(onHand.get(String(l.item))) >= l.quantity);

        const recent = await PurchaseRequest.find({
            school, status: { $in: ['pending', 'approved'] },
            createdAt: { $gte: new Date(Date.now() - 7 * MS_DAY) },
        }).select('items').lean();
        const wanted = new Set(priced.map(l => String(l.item)));
        const possibleDuplicate = recent.some(r => (r.items || []).some(li => wanted.has(id(li.item))));

        const requestNumber = await nextNumber(school, 'request');

        const request = await PurchaseRequest.create({
            school, requestNumber, requestedBy: req.userId,
            department: department || null,
            reason: String(reason).trim().slice(0, 500),
            priority: ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal',
            items: priced, estimatedTotal: round(estimatedTotal),
            status: 'pending',
            approvals: [{ stage: 'Inventory Admin', action: 'pending' }],
            checks: { stockAvailable, budgetOk: true, possibleDuplicate },
        });
        await audit(req, 'REQUEST_CREATED', 'PurchaseRequest', request._id,
            `Created new request ${requestNumber}`, { items: priced.length, total: round(estimatedTotal) }, requestNumber);
        ok(res, request);
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   The stock ledger, and one item's whole story
   ═══════════════════════════════════════════════════════════════════════════ */

// What each kind of movement is called on screen, and which way it goes.
const MOVEMENT = {
    purchase: ['Received', 'in'], return: ['Returned', 'in'], transfer_in: ['Transferred in', 'in'],
    issue: ['Issued', 'out'], damage: ['Damaged', 'out'], scrap: ['Scrapped', 'out'],
    transfer_out: ['Transferred out', 'out'], repair: ['To repair', 'out'],
    adjustment: ['Adjustment', 'either'], audit: ['Audit correction', 'either'],
};

/**
 * Every movement of stock there has ever been.
 *
 * The ledger has been written since the module was built and no screen had
 * ever shown it — an audit trail nobody could read. This is that screen: the
 * same filters the Stock board takes, plus a movement type and a date range,
 * paged in the database because this is the one table that grows without
 * bound.
 */
exports.ledgerBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', item = '', warehouse = '', type = '', direction = '', sort = 'at', dir = 'desc' } = req.query;
        const r = range(req.query);

        // Everything filters in the database now. A search or a direction used
        // to take the newest 3,000 rows and narrow the array, which meant a
        // school past three thousand movements could not find an older one at
        // all — and the totals underneath described that slice, not the filter.
        const p = Q.params();
        const where = [`t."school" = ${p.$(String(school))}`];
        if (item)      where.push(`t."item" = ${p.$(String(item))}`);
        if (warehouse) where.push(`t."warehouse" = ${p.$(String(warehouse))}`);
        if (type)      where.push(`t."type" = ${p.$(String(type))}`);
        if (direction) where.push(direction === 'in' ? `t."quantity" >= 0` : `t."quantity" < 0`);
        if (r?.from)   where.push(`t."createdAt" >= ${p.$(r.from)}`);
        if (r?.to)     where.push(`t."createdAt" <= ${p.$(r.to)}`);
        if (search) {
            const pat = Q.like(p, search);
            where.push(`(it."name" ILIKE ${pat} OR it."itemCode" ILIKE ${pat} OR w."name" ILIKE ${pat}
                         OR t."note" ILIKE ${pat} OR t."batchNumber" ILIKE ${pat} OR u."name" ILIKE ${pat}
                         -- A serial is the one thing a serial number exists to
                         -- be looked up by, so the JSON array is searched too.
                         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                                        CASE WHEN jsonb_typeof(t."serialNumbers") = 'array'
                                             THEN t."serialNumbers" ELSE '[]'::jsonb END) sn
                                     WHERE sn ILIKE ${pat}))`);
        }
        const clause = where.join(' AND ');
        const joins = `
              LEFT JOIN ${Q.T(InventoryItem)} it ON it."_id" = t."item"
              LEFT JOIN ${Q.T(InventoryWarehouse)} w ON w."_id" = t."warehouse"
              LEFT JOIN ${Q.T(User)} u ON u."_id" = t."performedBy"`;

        const base = `
            SELECT t."_id", t."createdAt" AS "at", t."type", t."quantity", t."balanceAfter",
                   t."unitCost", t."batchNumber", t."serialNumbers", t."expiryDate",
                   t."refType", t."refId", t."note",
                   it."_id" AS "itemId", it."name" AS "itemName", it."itemCode",
                   it."image" AS "itemImage", it."unit" AS "itemUnit", it."category" AS "categoryId",
                   t."warehouse" AS "warehouseId",
                   u."_id" AS "byId", u."name" AS "byName", u."role" AS "byRole",
                   u."email" AS "byEmail", u."profileImage" AS "byPhoto",
                   count(*) OVER ()::int AS "__matched"
              FROM ${Q.T(InventoryStockTransaction)} t ${joins}
             WHERE ${clause}`;

        // The figures describe the window the filters chose. Summed in the
        // database, so they describe the whole window however large it is.
        const sumSql = `
            SELECT COALESCE(SUM(GREATEST(t."quantity", 0)), 0)::numeric                       AS "inQty",
                   COALESCE(SUM(LEAST(t."quantity", 0)), 0)::numeric                          AS "outQty",
                   COALESCE(SUM(GREATEST(t."quantity", 0) * COALESCE(t."unitCost", 0)), 0)::numeric AS "inValue"
              FROM ${Q.T(InventoryStockTransaction)} t ${joins}
             WHERE ${clause}`;

        const SORTS = {
            at: 't."createdAt"', quantity: 't."quantity"', balanceAfter: 't."balanceAfter"',
            item: 'it."name"', type: 't."type"',
        };

        const ip = Q.params();
        const [m, listed, sums, pickable] = await Promise.all([
            masters(school),
            Q.page(base, p, { sort, dir, page: req.query.page, limit: req.query.limit || 25, sorts: SORTS, fallback: 'at' }),
            Q.pool.query(sumSql, p.list),
            InventoryItem.find({ school }).select('name itemCode').sort({ name: 1 }).limit(500).lean(),
        ]);
        const sum = sums.rows[0] || {};

        ok(res, {
            tiles: {
                movements: { value: listed.matched },
                received: { value: round(sum.inQty) },
                issued: { value: round(Math.abs(num(sum.outQty))) },
                receivedValue: { value: round(sum.inValue) },
            },
            filters: {
                warehouses: m.warehouses.map(whChip),
                types: Object.entries(MOVEMENT).map(([value, [label]]) => ({ value, label })),
                items: pickable.map(i => ({ _id: String(i._id), name: `${i.name} · ${i.itemCode}` })),
            },
            rows: listed.rows.map(t => {
                const [label, way] = MOVEMENT[t.type] || [words(t.type), num(t.quantity) >= 0 ? 'in' : 'out'];
                return {
                    _id: String(t._id),
                    at: t.at,
                    type: t.type,
                    label,
                    direction: num(t.quantity) >= 0 ? 'in' : 'out',
                    way,
                    item: t.itemId ? {
                        _id: String(t.itemId), name: t.itemName, itemCode: t.itemCode,
                        image: t.itemImage || '', unit: t.itemUnit || 'Nos',
                        category: catChip(m.cat.get(String(t.categoryId || ''))),
                    } : { _id: '', name: 'Deleted item', itemCode: '', image: '', unit: '', category: null },
                    warehouse: whChip(m.wh.get(String(t.warehouseId || ''))),
                    quantity: num(t.quantity),
                    balanceAfter: num(t.balanceAfter),
                    unitCost: num(t.unitCost),
                    value: round(Math.abs(num(t.quantity)) * num(t.unitCost)),
                    batchNumber: t.batchNumber || '',
                    serialNumbers: Array.isArray(t.serialNumbers) ? t.serialNumbers : [],
                    expiryDate: t.expiryDate,
                    refType: t.refType || '',
                    refId: t.refId ? String(t.refId) : '',
                    note: t.note || '',
                    by: who(t.byId ? { _id: t.byId, name: t.byName, role: t.byRole, email: t.byEmail, profileImage: t.byPhoto } : null),
                };
            }),
            page: listed.page, pages: listed.pages, total: listed.total, limit: listed.limit,
            matched: listed.matched,
        });
    } catch (e) { err(res, e); }
};

exports.itemDetail = async (req, res) => {
    try {
        const school = req.schoolId;
        const it = await InventoryItem.findOne({ _id: req.params.id, school }).lean();
        if (!it) return bad(res, 'That item could not be found', 404);

        const [m, stock, txns, assets, orders, issues] = await Promise.all([
            masters(school),
            InventoryStock.find({ school, item: it._id }).lean(),
            InventoryStockTransaction.find({ school, item: it._id }).sort({ createdAt: -1 }).limit(30).lean(),
            InventoryAsset.find({ school, item: it._id }).select('assetCode name status').lean(),
            PurchaseOrder.find({ school, 'items.item': it._id }).sort({ createdAt: -1 }).limit(20).lean(),
            InventoryIssue.find({ school, item: it._id }).sort({ createdAt: -1 }).limit(20).lean(),
        ]);
        const users = await userIndex(school, [...txns.map(t => t.performedBy), ...issues.map(i => i.issuedToUser)]);

        const onHand = stock.reduce((s2, r) => s2 + num(r.quantity), 0);
        const value = stock.reduce((s2, r) => s2 + num(r.quantity) * num(r.avgCost), 0);
        const repairing = assets.some(a => a.status === 'under_repair');
        const state = repairing ? 'under_repair'
            : !stock.length ? 'not_tracked'
            : onHand <= 0 ? 'out_of_stock'
            : (num(it.reorderLevel) > 0 && onHand <= num(it.reorderLevel)) ? 'low_stock'
            : 'in_stock';

        ok(res, {
            item: {
                ...it, _id: String(it._id),
                category: catChip(m.cat.get(id(it.category))),
                warehouse: whChip(m.wh.get(id(it.warehouse))),
                state,
            },
            stats: {
                onHand: round(onHand),
                value: round(value),
                reorderLevel: num(it.reorderLevel),
                places: stock.filter(r => num(r.quantity) > 0).length,
                assets: assets.length,
                issuedOut: round(issues.reduce((s2, i) => s2 + Math.max(0, num(i.quantity) - num(i.returnedQty)), 0)),
            },
            stock: stock.map(r => ({
                _id: String(r._id),
                warehouse: whChip(m.wh.get(String(r.warehouse))),
                quantity: round(r.quantity),
                value: round(num(r.quantity) * num(r.avgCost)),
                avgCost: num(r.avgCost),
                state: rowState(it, r.quantity),
                updatedAt: r.updatedAt,
            })).sort((a, b) => b.quantity - a.quantity),
            movements: txns.map(t => {
                const [label] = MOVEMENT[t.type] || [words(t.type)];
                return {
                    _id: String(t._id), at: t.createdAt, type: t.type, label,
                    quantity: num(t.quantity), balanceAfter: num(t.balanceAfter),
                    warehouse: whChip(m.wh.get(String(t.warehouse)))?.name || '',
                    note: t.note || '', by: who(users.get(String(t.performedBy))),
                };
            }),
            orders: orders.map(o => ({
                _id: String(o._id), poNumber: o.poNumber, date: o.createdAt,
                vendor: m.ven.get(id(o.vendor))?.name || '',
                state: ORDER_STATE[o.status] || o.status,
                quantity: (o.items || []).filter(l => id(l.item) === String(it._id))
                    .reduce((s2, l) => s2 + num(l.quantity), 0),
            })),
            issues: issues.map(i => ({
                _id: String(i._id), issueNumber: i.issueNumber, date: i.issueDate || i.createdAt,
                quantity: num(i.quantity), outstanding: Math.max(0, num(i.quantity) - num(i.returnedQty)),
                to: i.issuedToUser ? who(users.get(String(i.issuedToUser)), i.issuedToName).name : (i.issuedToName || i.classLabel || '—'),
            })),
            assets: assets.map(a => ({ _id: String(a._id), assetCode: a.assetCode, name: a.name, state: assetState(a) })),
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   Printable documents — the paper an inventory office has to hand over
   ═══════════════════════════════════════════════════════════════════════════
   The module could raise an order, receive against it and issue the goods, and
   none of it could leave the screen. A vendor needs the order, a storekeeper
   signs for the delivery, and whoever takes stock away signs for that. Each is
   rendered as a self-contained printable page — see services/inventoryDocs. */

const docs = require('../services/inventoryDocs');
const School = require('../models/School');

/** School identity for the letterhead, with the logo made absolute. */
async function letterhead(req) {
    const school = await School.findById(req.schoolId).select('name address logo').lean();
    if (!school) return null;
    const origin = `${req.protocol}://${req.get('host')}`;
    return {
        name: school.name,
        address: typeof school.address === 'string'
            ? school.address
            : [school.address?.line1, school.address?.city, school.address?.state, school.address?.pincode].filter(Boolean).join(', '),
        logoUrl: school.logo ? (/^https?:/.test(school.logo) ? school.logo : `${origin}${school.logo}`) : '',
    };
}

const sendHtml = (res, html) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
};

exports.printPurchaseOrder = async (req, res) => {
    try {
        const po = await PurchaseOrder.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('items.item', 'itemCode')
            .populate('purchaseRequest', 'requestNumber')
            .lean();
        if (!po) return bad(res, 'Purchase order not found', 404);

        const [vendor, department, warehouse, school, raisedBy, approvedBy] = await Promise.all([
            po.vendor ? InventoryVendor.findById(po.vendor).lean() : null,
            po.department ? InventoryDepartment.findById(po.department).select('name').lean() : null,
            po.warehouse ? InventoryWarehouse.findById(po.warehouse).select('name location').lean() : null,
            letterhead(req),
            po.createdBy ? User.findById(po.createdBy).select('name').lean() : null,
            po.approvedBy ? User.findById(po.approvedBy).select('name').lean() : null,
        ]);
        sendHtml(res, docs.purchaseOrder({ po, vendor, department, warehouse, school, raisedBy, approvedBy }));
    } catch (e) { err(res, e); }
};

exports.printGoodsReceived = async (req, res) => {
    try {
        const po = await PurchaseOrder.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!po) return bad(res, 'Purchase order not found', 404);
        if (!['partially_received', 'received'].includes(po.status)) {
            return bad(res, 'Nothing has been received against this order yet');
        }
        const [vendor, warehouse, school, receivedBy] = await Promise.all([
            po.vendor ? InventoryVendor.findById(po.vendor).lean() : null,
            po.warehouse ? InventoryWarehouse.findById(po.warehouse).select('name location').lean() : null,
            letterhead(req),
            User.findById(req.userId).select('name').lean(),
        ]);
        // What this note covers: everything received to date, since a receipt
        // is not stored as an event of its own.
        const lines = (po.items || [])
            .filter(l => num(l.receivedQty) > 0)
            .map(l => ({
                itemName: l.itemName, unit: l.unit,
                ordered: num(l.quantity), received: num(l.receivedQty), now: num(l.receivedQty),
            }));
        sendHtml(res, docs.goodsReceived({ po, vendor, warehouse, school, receivedBy, lines }));
    } catch (e) { err(res, e); }
};

exports.printIssueSlip = async (req, res) => {
    try {
        const issue = await InventoryIssue.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('issuedToUser', 'name email')
            .lean();
        if (!issue) return bad(res, 'Issue not found', 404);

        const [item, warehouse, department, school, issuedBy] = await Promise.all([
            InventoryItem.findById(issue.item).select('name itemCode unit category').lean()
                .then(async (it) => (it && it.category
                    ? { ...it, category: await InventoryCategory.findById(it.category).select('name').lean() }
                    : it)),
            issue.warehouse ? InventoryWarehouse.findById(issue.warehouse).select('name location').lean() : null,
            issue.department ? InventoryDepartment.findById(issue.department).select('name').lean() : null,
            letterhead(req),
            issue.issuedBy ? User.findById(issue.issuedBy).select('name').lean() : null,
        ]);
        sendHtml(res, docs.issueSlip({ issue, item, warehouse, department, school, issuedBy }));
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   Bulk item import
   ═══════════════════════════════════════════════════════════════════════════
   The Items screen had an Import button that told you import was on the
   roadmap. A school arriving with a spreadsheet of four hundred items had to
   type them in one at a time through a seven-step wizard.

   The CSV is parsed in the browser — it is the browser that has the file — and
   arrives here as rows. This endpoint does the part the browser cannot: it
   resolves category and store names against what this school actually has,
   checks codes against the ones already taken, and writes the survivors.

   It runs in two passes. `?check=1` validates and reports, changing nothing, so
   the screen can show exactly what will happen before anyone commits; without
   it the same validation runs again and the valid rows are created. The second
   validation is not redundant — the data can move between the two calls. */

const IMPORT_COLUMNS = [
    { key: 'name', label: 'Name', required: true },
    { key: 'itemCode', label: 'Code', hint: 'Left blank, one is generated' },
    { key: 'category', label: 'Category', hint: 'Must already exist' },
    { key: 'unit', label: 'Unit' },
    { key: 'purchasePrice', label: 'Purchase Price', number: true },
    { key: 'gst', label: 'GST %', number: true },
    { key: 'hsnCode', label: 'HSN Code' },
    { key: 'reorderLevel', label: 'Reorder Level', number: true },
    { key: 'warehouse', label: 'Default Store', hint: 'Must already exist' },
    { key: 'brand', label: 'Brand' },
    { key: 'model', label: 'Model' },
    { key: 'barcode', label: 'Barcode' },
    { key: 'description', label: 'Description' },
];

exports.itemImportTemplate = async (req, res) => {
    try {
        const [cats, whs] = await Promise.all([
            InventoryCategory.find({ school: req.schoolId, isActive: { $ne: false } }).select('name').sort({ name: 1 }).lean(),
            InventoryWarehouse.find({ school: req.schoolId, isActive: { $ne: false } }).select('name').sort({ name: 1 }).lean(),
        ]);
        ok(res, {
            columns: IMPORT_COLUMNS,
            categories: cats.map(c => c.name),
            warehouses: whs.map(w => w.name),
        });
    } catch (e) { err(res, e); }
};

exports.importItems = async (req, res) => {
    try {
        const school = req.schoolId;
        const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
        const dryRun = String(req.query.check || req.body?.check || '') === '1' || req.body?.check === true;
        if (!rows.length) return bad(res, 'There is nothing to import');
        if (rows.length > 2000) return bad(res, 'That is more than 2,000 rows — split the file and import it in parts');

        const [cats, whs, existing] = await Promise.all([
            InventoryCategory.find({ school }).select('name').lean(),
            InventoryWarehouse.find({ school }).select('name').lean(),
            InventoryItem.find({ school }).select('itemCode name').lean(),
        ]);
        // Matched case-insensitively and trimmed: a spreadsheet's " Stationery"
        // is the same category as "Stationery", and refusing it would be
        // pedantry rather than safety.
        const norm = (v) => String(v ?? '').trim().toLowerCase();
        const catBy = new Map(cats.map(c => [norm(c.name), String(c._id)]));
        const whBy = new Map(whs.map(w => [norm(w.name), String(w._id)]));
        const takenCode = new Set(existing.map(i => norm(i.itemCode)));
        const takenName = new Set(existing.map(i => norm(i.name)));
        const seenCode = new Set();

        const report = [];
        const ready = [];
        rows.forEach((raw, i) => {
            const line = Number(raw.__line) || i + 2;   // +2: header row, 1-based
            const errors = [];
            const warnings = [];
            const name = String(raw.name ?? '').trim();
            if (!name) errors.push('Name is required');

            let code = String(raw.itemCode ?? '').trim();
            if (code) {
                if (takenCode.has(norm(code))) errors.push(`Code "${code}" is already used by another item`);
                else if (seenCode.has(norm(code))) errors.push(`Code "${code}" appears twice in this file`);
                else seenCode.add(norm(code));
            }
            if (name && takenName.has(norm(name))) {
                warnings.push('An item with this name already exists — this will create a second one');
            }

            let category = null;
            const catName = String(raw.category ?? '').trim();
            if (catName) {
                category = catBy.get(norm(catName)) || null;
                if (!category) errors.push(`No category called "${catName}" — create it first`);
            }
            let warehouse = null;
            const whName = String(raw.warehouse ?? '').trim();
            if (whName) {
                warehouse = whBy.get(norm(whName)) || null;
                if (!warehouse) errors.push(`No store called "${whName}" — create it first`);
            }

            const numField = (key, label) => {
                const v = raw[key];
                if (v === undefined || v === null || String(v).trim() === '') return 0;
                const n = Number(String(v).replace(/[₹,\s]/g, ''));
                if (!Number.isFinite(n) || n < 0) { errors.push(`${label} "${v}" is not a number`); return 0; }
                return n;
            };
            const purchasePrice = numField('purchasePrice', 'Purchase price');
            const gst = numField('gst', 'GST');
            const reorderLevel = numField('reorderLevel', 'Reorder level');
            if (gst > 100) errors.push(`GST of ${gst}% is not a percentage`);

            report.push({ line, name: name || '(no name)', errors, warnings });
            if (!errors.length) {
                ready.push({
                    school, name, itemCode: code || '', category, warehouse,
                    unit: String(raw.unit ?? '').trim() || 'Nos',
                    purchasePrice, gst, reorderLevel,
                    hsnCode: String(raw.hsnCode ?? '').trim(),
                    brand: String(raw.brand ?? '').trim(),
                    model: String(raw.model ?? '').trim(),
                    barcode: String(raw.barcode ?? '').trim(),
                    description: String(raw.description ?? '').trim(),
                    createdBy: req.userId, isActive: true,
                });
            }
        });

        const failed = report.filter(r => r.errors.length);
        if (dryRun) {
            return ok(res, {
                checked: true, total: rows.length,
                valid: ready.length, invalid: failed.length,
                warnings: report.filter(r => r.warnings.length).length,
                rows: report,
            });
        }
        if (!ready.length) {
            return bad(res, 'Every row has a problem — nothing was imported. Fix the file and try again.');
        }

        // Codes are handed out one at a time so two rows can never be given the
        // same one, and each item is created on its own: one bad row must not
        // take the other three hundred and ninety-nine with it.
        const created = [];
        const late = [];
        for (const row of ready) {
            try {
                if (!row.itemCode) row.itemCode = await nextNumber(school, 'item');
                created.push(await InventoryItem.create(row));
            } catch (e) {
                late.push({ name: row.name, message: /duplicate|unique/i.test(e.message) ? 'That code was taken while the import was running' : e.message });
            }
        }

        await audit(req, 'ITEMS_IMPORTED', 'InventoryItem', null,
            `Imported ${created.length} item(s) from a file`,
            { attempted: rows.length, created: created.length, rejected: failed.length + late.length });

        ok(res, {
            checked: false, total: rows.length,
            created: created.length, invalid: failed.length,
            failedRows: report.filter(r => r.errors.length),
            failedWrites: late,
            items: created.map(i => ({ _id: String(i._id), name: i.name, itemCode: i.itemCode })),
        });
    } catch (e) { err(res, e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   Reports
   ═══════════════════════════════════════════════════════════════════════════
   Every other screen answers "what is happening now". None of them answered
   "what did we spend on science last term", "which items move and which sit on
   the shelf for a year", or "what is the stock worth" — the questions a school
   is actually asked at a budget meeting.

   Six reports, one endpoint. Each returns the same shape — a title, a summary
   strip, columns and rows — so the screen is one table and the CSV export is
   one function, rather than six of each. The period is applied to whatever the
   report measures by; a valuation is a snapshot and ignores it, which the
   report says rather than silently applying a filter that means nothing. */

const REPORTS = {
    valuation: { title: 'Stock Valuation', blurb: 'What is on the shelf and what it is worth, right now.', dated: false },
    movement: { title: 'Stock Movement', blurb: 'What came in and what went out over the period.', dated: true },
    consumption: { title: 'Consumption by Department', blurb: 'Who used what, and what it cost.', dated: true },
    purchases: { title: 'Purchase Summary', blurb: 'What was ordered, from whom, and against which budget.', dated: true },
    reorder: { title: 'Reorder List', blurb: 'Everything at or below its reorder level, with what to buy.', dated: false },
    assets: { title: 'Asset Register', blurb: 'The asset list with current value and where each one is.', dated: false },
};

exports.reportMeta = async (req, res) => {
    try {
        ok(res, { reports: Object.entries(REPORTS).map(([key, r]) => ({ key, ...r })) });
    } catch (e) { err(res, e); }
};

exports.report = async (req, res) => {
    try {
        const school = req.schoolId;
        const kind = String(req.params.kind || 'valuation');
        const spec = REPORTS[kind];
        if (!spec) return bad(res, 'There is no such report', 404);

        const { from = '', to = '', category = '', warehouse = '', department = '', vendor = '' } = req.query;
        const since = from ? new Date(`${from}T00:00:00`) : null;
        const until = to ? new Date(`${to}T23:59:59`) : null;
        const m = await masters(school);

        let columns = [];
        let rows = [];
        let summary = [];

        if (kind === 'valuation') {
            const [items, stock] = await Promise.all([
                InventoryItem.find({ school, isActive: true }).select('name itemCode unit category purchasePrice reorderLevel').lean(),
                InventoryStock.find({ school }).select('item warehouse quantity reserved avgCost').lean(),
            ]);
            const byId = new Map(items.map(i => [String(i._id), i]));
            rows = stock
                .filter(s => byId.has(String(s.item)))
                .filter(s => !warehouse || String(s.warehouse) === String(warehouse))
                .filter(s => !category || id(byId.get(String(s.item)).category) === String(category))
                .map(s => {
                    const it = byId.get(String(s.item));
                    // Weighted average cost is what the goods actually cost; the
                    // list price is what they would cost to replace. Valuing at
                    // the list price overstates the shelf, so avgCost wins where
                    // there is one.
                    const unitValue = num(s.avgCost) || num(it.purchasePrice);
                    return {
                        item: it.name, itemCode: it.itemCode,
                        category: m.cat.get(id(it.category))?.name || 'Uncategorised',
                        warehouse: m.wh.get(id(s.warehouse))?.name || '—',
                        quantity: num(s.quantity), reserved: num(s.reserved),
                        available: Math.max(0, num(s.quantity) - num(s.reserved)),
                        unit: it.unit || 'Nos',
                        unitValue: round(unitValue),
                        value: round(num(s.quantity) * unitValue),
                    };
                })
                .sort((a, b) => b.value - a.value);
            columns = [
                ['item', 'Item'], ['itemCode', 'Code'], ['category', 'Category'], ['warehouse', 'Store'],
                ['quantity', 'On hand', 'num'], ['reserved', 'Reserved', 'num'], ['available', 'Available', 'num'],
                ['unit', 'Unit'], ['unitValue', 'Unit value', 'money'], ['value', 'Value', 'money'],
            ];
            const total = rows.reduce((t, r) => t + r.value, 0);
            summary = [
                { label: 'Lines', value: rows.length },
                { label: 'Units held', value: rows.reduce((t, r) => t + r.quantity, 0) },
                { label: 'Total value', value: round(total), money: true },
                { label: 'Reserved units', value: rows.reduce((t, r) => t + r.reserved, 0) },
            ];
        }

        if (kind === 'movement' || kind === 'consumption') {
            const q = { school };
            if (since || until) { q.createdAt = {}; if (since) q.createdAt.$gte = since; if (until) q.createdAt.$lte = until; }
            if (warehouse) q.warehouse = warehouse;
            const txns = await InventoryStockTransaction.find(q)
                .select('item warehouse type quantity unitCost createdAt refType refId').lean();
            const items = await InventoryItem.find({ school }).select('name itemCode unit category purchasePrice').lean();
            const byId = new Map(items.map(i => [String(i._id), i]));

            if (kind === 'movement') {
                const agg = new Map();
                for (const t of txns) {
                    const it = byId.get(String(t.item));
                    if (!it) continue;
                    if (category && id(it.category) !== String(category)) continue;
                    const k = String(t.item);
                    const cur = agg.get(k) || {
                        item: it.name, itemCode: it.itemCode, unit: it.unit || 'Nos',
                        category: m.cat.get(id(it.category))?.name || 'Uncategorised',
                        inQty: 0, outQty: 0, inValue: 0, outValue: 0, moves: 0,
                    };
                    const qty = num(t.quantity);
                    const value = Math.abs(qty) * (num(t.unitCost) || num(it.purchasePrice));
                    if (qty >= 0) { cur.inQty += qty; cur.inValue += value; }
                    else { cur.outQty += Math.abs(qty); cur.outValue += value; }
                    cur.moves += 1;
                    agg.set(k, cur);
                }
                rows = [...agg.values()]
                    .map(r => ({ ...r, net: r.inQty - r.outQty, inValue: round(r.inValue), outValue: round(r.outValue) }))
                    .sort((a, b) => b.outQty - a.outQty);
                columns = [
                    ['item', 'Item'], ['itemCode', 'Code'], ['category', 'Category'], ['unit', 'Unit'],
                    ['inQty', 'In', 'num'], ['outQty', 'Out', 'num'], ['net', 'Net', 'num'],
                    ['moves', 'Movements', 'num'], ['outValue', 'Value out', 'money'],
                ];
                summary = [
                    { label: 'Items moved', value: rows.length },
                    { label: 'Units in', value: rows.reduce((t, r) => t + r.inQty, 0) },
                    { label: 'Units out', value: rows.reduce((t, r) => t + r.outQty, 0) },
                    { label: 'Value out', value: round(rows.reduce((t, r) => t + r.outValue, 0)), money: true },
                ];
            } else {
                // Consumption is what LEFT and who it went to, so it is read off
                // the issues rather than the ledger: only an issue knows the
                // department. A transfer between stores is not consumption.
                const iq = { school };
                if (since || until) { iq.issueDate = {}; if (since) iq.issueDate.$gte = since; if (until) iq.issueDate.$lte = until; }
                if (warehouse) iq.warehouse = warehouse;
                if (department) iq.department = department;
                const issues = await InventoryIssue.find(iq)
                    .select('item quantity returnedQty department classLabel recipientType issueDate').lean();
                const agg = new Map();
                for (const iss of issues) {
                    const it = byId.get(String(iss.item));
                    if (!it) continue;
                    if (category && id(it.category) !== String(category)) continue;
                    const who = m.dep.get(id(iss.department))?.name || iss.classLabel || words(iss.recipientType || 'staff');
                    const k = `${who}::${String(iss.item)}`;
                    const cur = agg.get(k) || {
                        department: who, item: it.name, itemCode: it.itemCode, unit: it.unit || 'Nos',
                        issued: 0, returned: 0, issues: 0,
                    };
                    cur.issued += num(iss.quantity);
                    cur.returned += num(iss.returnedQty);
                    cur.issues += 1;
                    agg.set(k, cur);
                }
                rows = [...agg.values()].map(r => {
                    const it = items.find(i => i.itemCode === r.itemCode);
                    const consumed = r.issued - r.returned;
                    return { ...r, consumed, value: round(consumed * num(it?.purchasePrice)) };
                }).sort((a, b) => b.value - a.value);
                columns = [
                    ['department', 'Department / Class'], ['item', 'Item'], ['itemCode', 'Code'], ['unit', 'Unit'],
                    ['issued', 'Issued', 'num'], ['returned', 'Returned', 'num'],
                    ['consumed', 'Consumed', 'num'], ['value', 'Value', 'money'],
                ];
                summary = [
                    { label: 'Lines', value: rows.length },
                    { label: 'Units issued', value: rows.reduce((t, r) => t + r.issued, 0) },
                    { label: 'Units consumed', value: rows.reduce((t, r) => t + r.consumed, 0) },
                    { label: 'Value consumed', value: round(rows.reduce((t, r) => t + r.value, 0)), money: true },
                ];
            }
        }

        if (kind === 'purchases') {
            const q = { school, status: { $ne: 'cancelled' } };
            if (since || until) { q.createdAt = {}; if (since) q.createdAt.$gte = since; if (until) q.createdAt.$lte = until; }
            if (department) q.department = department;
            if (vendor) q.vendor = vendor;
            const orders = await PurchaseOrder.find(q)
                .select('poNumber vendor department budget grandTotal subTotal taxTotal status createdAt expectedDelivery items').lean();
            const budgetNames = new Map((await InventoryBudget.find({ school }).select('name').lean())
                .map(b => [String(b._id), b.name]));
            rows = orders.map(o => ({
                poNumber: o.poNumber,
                date: o.createdAt,
                vendor: m.ven.get(id(o.vendor))?.name || '—',
                department: m.dep.get(id(o.department))?.name || '—',
                budget: budgetNames.get(id(o.budget)) || '—',
                lines: (o.items || []).length,
                received: (o.items || []).reduce((t, l) => t + num(l.receivedQty), 0),
                ordered: (o.items || []).reduce((t, l) => t + num(l.quantity), 0),
                subTotal: round(o.subTotal), taxTotal: round(o.taxTotal), total: round(o.grandTotal),
                status: o.status,
            })).sort((a, b) => new Date(b.date) - new Date(a.date));
            columns = [
                ['poNumber', 'Order No.'], ['date', 'Raised', 'date'], ['vendor', 'Vendor'],
                ['department', 'Department'], ['budget', 'Budget'], ['lines', 'Lines', 'num'],
                ['ordered', 'Ordered', 'num'], ['received', 'Received', 'num'],
                ['subTotal', 'Subtotal', 'money'], ['taxTotal', 'Tax', 'money'],
                ['total', 'Total', 'money'], ['status', 'Status', 'words'],
            ];
            summary = [
                { label: 'Orders', value: rows.length },
                { label: 'Committed', value: round(rows.reduce((t, r) => t + r.total, 0)), money: true },
                { label: 'Fully received', value: rows.filter(r => r.status === 'received').length },
                { label: 'Still open', value: rows.filter(r => !['received', 'cancelled'].includes(r.status)).length },
            ];
        }

        if (kind === 'reorder') {
            const [items, stock] = await Promise.all([
                InventoryItem.find({ school, isActive: true, reorderLevel: { $gt: 0 } })
                    .select('name itemCode unit category purchasePrice reorderLevel warehouse').lean(),
                InventoryStock.find({ school }).select('item quantity reserved').lean(),
            ]);
            const free = new Map();
            for (const s of stock) {
                free.set(String(s.item), num(free.get(String(s.item))) + Math.max(0, num(s.quantity) - num(s.reserved)));
            }
            rows = items
                .filter(it => !category || id(it.category) === String(category))
                .map(it => {
                    const have = num(free.get(String(it._id)));
                    // Enough to clear the level and leave the same again as
                    // headroom, which is what a storekeeper orders in practice.
                    const suggested = Math.max(0, num(it.reorderLevel) * 2 - have);
                    return {
                        item: it.name, itemCode: it.itemCode,
                        category: m.cat.get(id(it.category))?.name || 'Uncategorised',
                        warehouse: m.wh.get(id(it.warehouse))?.name || '—',
                        available: have, reorderLevel: num(it.reorderLevel),
                        shortfall: Math.max(0, num(it.reorderLevel) - have),
                        suggested, unit: it.unit || 'Nos',
                        estimatedCost: round(suggested * num(it.purchasePrice)),
                        state: have <= 0 ? 'out_of_stock' : have <= num(it.reorderLevel) ? 'low_stock' : 'in_stock',
                    };
                })
                .filter(r => r.state !== 'in_stock')
                .sort((a, b) => b.shortfall - a.shortfall);
            columns = [
                ['item', 'Item'], ['itemCode', 'Code'], ['category', 'Category'], ['warehouse', 'Default store'],
                ['available', 'Available', 'num'], ['reorderLevel', 'Reorder level', 'num'],
                ['shortfall', 'Short by', 'num'], ['suggested', 'Suggested order', 'num'],
                ['unit', 'Unit'], ['estimatedCost', 'Estimated cost', 'money'], ['state', 'Status', 'words'],
            ];
            summary = [
                { label: 'Items to reorder', value: rows.length },
                { label: 'Out of stock', value: rows.filter(r => r.state === 'out_of_stock').length },
                { label: 'Units to order', value: rows.reduce((t, r) => t + r.suggested, 0) },
                { label: 'Estimated cost', value: round(rows.reduce((t, r) => t + r.estimatedCost, 0)), money: true },
            ];
        }

        if (kind === 'assets') {
            const assets = await InventoryAsset.find({ school }).lean();
            rows = assets
                .filter(a => !category || id(a.category) === String(category))
                .filter(a => !warehouse || id(a.warehouse) === String(warehouse))
                .map(a => ({
                    assetCode: a.assetCode, asset: a.name,
                    category: m.cat.get(id(a.category))?.name || 'Uncategorised',
                    warehouse: m.wh.get(id(a.warehouse))?.name || '—',
                    location: a.location || '—',
                    serialNumber: a.serialNumber || '—',
                    purchaseDate: a.purchaseDate,
                    purchaseCost: round(a.purchaseCost),
                    currentValue: round(num(a.currentValue) || num(a.purchaseCost)),
                    condition: a.condition || 'good',
                    state: assetState(a),
                }))
                .sort((a, b) => b.currentValue - a.currentValue);
            columns = [
                ['assetCode', 'Code'], ['asset', 'Asset'], ['category', 'Category'],
                ['warehouse', 'Store'], ['location', 'Location'], ['serialNumber', 'Serial'],
                ['purchaseDate', 'Bought', 'date'], ['purchaseCost', 'Cost', 'money'],
                ['currentValue', 'Current value', 'money'], ['condition', 'Condition', 'words'],
                ['state', 'Status', 'words'],
            ];
            const cost = rows.reduce((t, r) => t + r.purchaseCost, 0);
            const value = rows.reduce((t, r) => t + r.currentValue, 0);
            summary = [
                { label: 'Assets', value: rows.length },
                { label: 'Original cost', value: round(cost), money: true },
                { label: 'Current value', value: round(value), money: true },
                { label: 'Depreciated', value: round(cost - value), money: true },
            ];
        }

        ok(res, {
            kind, title: spec.title, blurb: spec.blurb, dated: spec.dated,
            columns: columns.map(([key, label, format]) => ({ key, label, format: format || 'text' })),
            summary, rows,
            filters: {
                categories: m.categories.map(c => ({ value: String(c._id), label: c.name })),
                warehouses: m.warehouses.map(w => ({ value: String(w._id), label: w.name })),
                departments: m.departments.map(dd => ({ value: String(dd._id), label: dd.name })),
                vendors: m.vendors.map(v => ({ value: String(v._id), label: v.name })),
            },
        });
    } catch (e) { err(res, e); }
};
