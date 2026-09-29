'use strict';
/**
 * What a budget has, and what it has left.
 *
 * There used to be TWO budget systems. `InventoryDepartment.annualBudget` and
 * `usedBudget` were what actually blocked a purchase order; `InventoryBudget`
 * was what the Budgets screen drew. They did not know about each other, and
 * they disagreed on purpose as well as by accident: `usedBudget` was charged
 * when an order was CREATED, so an order nobody ever approved held the
 * department's money forever, while the screen counted every order that had
 * not been cancelled.
 *
 * There is one now. `InventoryBudget` holds the allocation; the spend is summed
 * from the purchase orders inside its scope and period, so it cannot drift.
 * `checkSpend` is what a new order is measured against.
 */
const InventoryBudget = require('../models/InventoryBudget');
const InventoryItem = require('../models/InventoryItem');
const InventoryDepartment = require('../models/InventoryDepartment');
const PurchaseOrder = require('../models/PurchaseOrder');
const pool = require('../db/pool');

const num = (v) => (Number.isFinite(+v) ? +v : 0);
const id = (v) => (v == null ? '' : String(v._id ?? v));
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

// An order that has been cancelled is not spending. Everything else is
// committed money, whether the goods have arrived or not — which is the point
// of a budget.
const COMMITTED = (o) => o.status !== 'cancelled';

/** What one budget covers, and how much of it is gone. */
function spendOf(budget, orders, itemCategoryOf) {
    const from = budget.periodStart ? new Date(budget.periodStart).getTime() : -Infinity;
    const to = budget.periodEnd ? endOfDay(budget.periodEnd).getTime() : Infinity;
    const wantDep = id(budget.department);
    const wantCat = id(budget.category);

    let spent = 0;
    const lines = [];
    for (const o of orders) {
        if (!COMMITTED(o)) continue;
        const t = new Date(o.createdAt).getTime();
        if (t < from || t > to) continue;

        // An order pinned to a budget belongs to that budget and no other.
        if (id(o.budget) && id(o.budget) !== String(budget._id)) continue;
        const pinned = id(o.budget) === String(budget._id);

        if (!pinned) {
            if (wantDep && id(o.department) !== wantDep) continue;
            if (wantCat) {
                const hits = (o.items || []).filter(li => li.item && itemCategoryOf.get(String(li.item)) === wantCat);
                if (!hits.length) continue;
                // Only the part of the order that belongs to this category.
                const part = hits.reduce((s, li) => s + num(li.quantity) * num(li.unitPrice) * (1 + num(li.gst) / 100), 0);
                spent += part;
                lines.push({ order: o, amount: part, partial: true });
                continue;
            }
            if (!wantDep && !wantCat) continue;  // scoped to nothing claims nothing
        }
        spent += num(o.grandTotal);
        lines.push({ order: o, amount: num(o.grandTotal), partial: false });
    }
    return { spent, lines };
}

/**
 * Every active budget with its spend, ready to be measured against.
 *
 * The spend is summed in the database, per budget, in one statement. It used to
 * read every purchase order the school had ever raised and every item in the
 * catalogue, then fold them in JavaScript — work that grew with the school's
 * whole history to produce a handful of numbers. The rule it applies is the
 * same one `spendOf` documents, and `spendOf` is still what `checkSpend` uses
 * on the small set of orders one new order has to be measured against.
 */
async function load(school) {
    const all = await InventoryBudget.find({ school, status: 'active' }).lean();
    if (!all.length) return [];

    const { rows } = await pool.query(`
        WITH b AS (
            SELECT "_id", "department", "category", "periodStart", "periodEnd"
              FROM "inventorybudgets"
             WHERE "school" = $1 AND "status" = 'active'
        ),
        o AS (
            SELECT "_id", "department", "budget", "items", "grandTotal", "createdAt"
              FROM "purchaseorders"
             WHERE "school" = $1 AND "status" <> 'cancelled'
        )
        SELECT b."_id",
               COALESCE(SUM(
                   CASE
                       -- Pinned to this budget: the whole order belongs to it.
                       WHEN o."budget" = b."_id" THEN o."grandTotal"
                       -- Scoped by category: only the lines in that category,
                       -- priced with their own tax.
                       WHEN b."category" IS NOT NULL THEN COALESCE((
                           SELECT SUM(COALESCE((li->>'quantity')::numeric, 0)
                                    * COALESCE((li->>'unitPrice')::numeric, 0)
                                    * (1 + COALESCE((li->>'gst')::numeric, 0) / 100))
                             FROM jsonb_array_elements(
                                      CASE WHEN jsonb_typeof(o."items") = 'array' THEN o."items" ELSE '[]'::jsonb END) li
                             JOIN "inventoryitems" it ON it."_id" = (li->>'item')::uuid
                            WHERE it."category" = b."category"), 0)
                       ELSE o."grandTotal"
                   END), 0)::numeric AS "spent"
          FROM b
          LEFT JOIN o ON
               -- An order pinned to another budget belongs to that one only.
               (o."budget" IS NULL OR o."budget" = b."_id")
               AND (b."periodStart" IS NULL OR o."createdAt" >= b."periodStart")
               AND (b."periodEnd"   IS NULL OR o."createdAt" <= date_trunc('day', b."periodEnd") + INTERVAL '1 day' - INTERVAL '1 microsecond')
               AND (
                   o."budget" = b."_id"
                   OR (
                       -- Scoped to nothing claims nothing.
                       (b."department" IS NOT NULL OR b."category" IS NOT NULL)
                       AND (b."department" IS NULL OR o."department" = b."department")
                       AND (b."category" IS NULL OR EXISTS (
                               SELECT 1 FROM jsonb_array_elements(
                                   CASE WHEN jsonb_typeof(o."items") = 'array' THEN o."items" ELSE '[]'::jsonb END) li
                               JOIN "inventoryitems" it2 ON it2."_id" = (li->>'item')::uuid
                              WHERE it2."category" = b."category"))
                   )
               )
         GROUP BY b."_id"`, [String(school)]);

    const spentBy = new Map(rows.map(r => [String(r._id), num(r.spent)]));
    return all.map(b => {
        const spent = num(spentBy.get(String(b._id)));
        return {
            ...b,
            spent,
            remaining: num(b.allocated) - spent,
            usage: num(b.allocated) > 0 ? Math.round((spent / num(b.allocated)) * 100) : 0,
        };
    });
}

/**
 * May this order be raised?
 *
 * Every budget the order falls inside has to have room for it. A purchase that
 * belongs to no budget at all is allowed — a school that has not set budgets up
 * should not be locked out of buying anything.
 */
async function checkSpend(school, { department, budget, items = [], total }) {
    const live = await load(school);
    if (!live.length) return { blocked: false, budgets: [] };

    const itemIds = items.map(l => l.item).filter(Boolean);
    const cats = itemIds.length
        ? await InventoryItem.find({ school, _id: { $in: itemIds } }).select('category').lean()
        : [];
    const catIds = new Set(cats.map(c => id(c.category)).filter(Boolean));

    const applies = (b) => {
        if (budget) return String(b._id) === String(budget);
        const wantDep = id(b.department);
        const wantCat = id(b.category);
        if (wantDep && id(department) !== wantDep) return false;
        if (wantCat && !catIds.has(wantCat)) return false;
        return !!(wantDep || wantCat);
    };

    const hit = live.filter(applies);
    const over = hit.find(b => num(b.allocated) > 0 && num(total) > b.remaining);
    if (over) {
        return {
            blocked: true,
            message: `Purchase blocked — ₹${Math.round(num(total)).toLocaleString('en-IN')} exceeds what is left in ${over.name} (₹${Math.round(over.remaining).toLocaleString('en-IN')} of ₹${Math.round(num(over.allocated)).toLocaleString('en-IN')}).`,
            budget: over,
        };
    }
    // Not blocking, but worth saying: this order crosses an alert threshold.
    const warn = hit.find(b => num(b.allocated) > 0
        && ((b.spent + num(total)) / num(b.allocated)) * 100 >= (num(b.alertAt) || 90));
    return { blocked: false, budgets: hit, warn: warn || null };
}

/** The dashboard's per-department roll-up, summed rather than stored. */
async function byDepartment(school) {
    const [deps, live] = await Promise.all([
        InventoryDepartment.find({ school, isActive: true }).select('name').lean(),
        load(school),
    ]);
    return deps.map(d => {
        const mine = live.filter(b => id(b.department) === String(d._id));
        const allocated = mine.reduce((s, b) => s + num(b.allocated), 0);
        const spent = mine.reduce((s, b) => s + b.spent, 0);
        return {
            _id: d._id, name: d.name,
            annualBudget: allocated, usedBudget: Math.round(spent),
            remaining: Math.round(allocated - spent),
            utilization: allocated ? Math.round((spent / allocated) * 100) : 0,
            budgets: mine.length,
        };
    });
}

module.exports = { load, checkSpend, byDepartment, spendOf };
