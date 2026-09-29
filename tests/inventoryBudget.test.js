'use strict';
/**
 * Budgets.
 *
 * There were two budget systems once, and they disagreed. There is one now:
 * the allocation is stored, the spend is summed from the purchase orders inside
 * the budget's scope and period, and nothing is kept as a running total that
 * could drift. These pin down the scoping rules, because they are the part that
 * is easy to get subtly wrong — an order counted against two budgets, or
 * against none.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const budgets = require('../services/inventoryBudget');
const Budget = require('../models/InventoryBudget');
const Order = require('../models/PurchaseOrder');
const Item = require('../models/InventoryItem');
const Department = require('../models/InventoryDepartment');
const { makeSchool, teardown } = require('./helpers');

let S, otherDept, labItem, spent;
before(async () => {
    S = await makeSchool();
    otherDept = await Department.create({ school: S.id, name: 'Arts', code: 'ART', isActive: true });
    labItem = await Item.create({
        school: S.id, name: 'Beaker', itemCode: 'ZZ-LAB-1', unit: 'Nos',
        category: String(S.laboratory._id), purchasePrice: 200, isActive: true,
    });

    const order = (extra, lines) => Order.create({
        school: S.id, poNumber: `ZZ-PO-${Math.random().toString(36).slice(2, 8)}`,
        vendor: String(S.vendor._id), items: lines,
        subTotal: 1000, taxTotal: 0, grandTotal: 1000, status: 'approved', ...extra,
    });

    // Science: one order of its own, one belonging to another department.
    await order({ department: String(S.dept._id) }, [
        { item: String(S.item._id), itemName: 'Test Widget', quantity: 10, unit: 'Nos', unitPrice: 100, gst: 0 },
    ]);
    await order({ department: String(otherDept._id) }, [
        { item: String(S.item._id), itemName: 'Test Widget', quantity: 10, unit: 'Nos', unitPrice: 100, gst: 0 },
    ]);
    // A mixed order: one stationery line, one laboratory line.
    await order({ department: String(S.dept._id) }, [
        { item: String(S.item._id), itemName: 'Test Widget', quantity: 4, unit: 'Nos', unitPrice: 100, gst: 0 },
        { item: String(labItem._id), itemName: 'Beaker', quantity: 3, unit: 'Nos', unitPrice: 200, gst: 0 },
    ]);
    // Cancelled: never spending.
    await order({ department: String(S.dept._id), status: 'cancelled' }, [
        { item: String(S.item._id), itemName: 'Test Widget', quantity: 99, unit: 'Nos', unitPrice: 100, gst: 0 },
    ]);
});
after(async () => { await teardown(S?.id); });

const load = async () => { spent = await budgets.load(S.id); return spent; };
const find = (name) => spent.find(b => b.name === name);

describe('what a budget counts', () => {
    test('a department budget counts its department and nothing else', async () => {
        await Budget.create({ school: S.id, name: 'Science', department: String(S.dept._id), allocated: 10000, status: 'active' });
        await load();
        // Two live Science orders of 1000 each; the other department's and the
        // cancelled one do not count.
        assert.equal(find('Science').spent, 2000);
    });

    test('a cancelled order is never spending', async () => {
        const live = await Order.countDocuments({ school: S.id, status: { $ne: 'cancelled' } });
        const all = await Order.countDocuments({ school: S.id });
        assert.equal(all - live, 1, 'the fixture has one cancelled order');
        assert.equal(find('Science').spent, 2000, 'and it is not in the total');
    });

    test('a category budget counts only the lines in that category', async () => {
        await Budget.create({ school: S.id, name: 'Lab Kit', category: String(S.laboratory._id), allocated: 10000, status: 'active' });
        await load();
        // Only the Beaker line of the mixed order: 3 × 200, no tax.
        assert.equal(find('Lab Kit').spent, 600, 'not the whole order it sits on');
    });

    test('a budget scoped to nothing claims nothing', async () => {
        await Budget.create({ school: S.id, name: 'Unscoped', allocated: 10000, status: 'active' });
        await load();
        assert.equal(find('Unscoped').spent, 0);
    });

    test('an order pinned to a budget belongs to that one alone', async () => {
        const pinned = await Budget.create({ school: S.id, name: 'Pinned', allocated: 10000, status: 'active' });
        await Order.create({
            school: S.id, poNumber: 'ZZ-PO-PIN', vendor: String(S.vendor._id),
            department: String(S.dept._id), budget: String(pinned._id),
            items: [{ item: String(S.item._id), itemName: 'Test Widget', quantity: 5, unit: 'Nos', unitPrice: 100, gst: 0 }],
            subTotal: 500, taxTotal: 0, grandTotal: 500, status: 'approved',
        });
        await load();
        assert.equal(find('Pinned').spent, 500);
        assert.equal(find('Science').spent, 2000, 'the department budget must not count it as well');
    });

    test('a period excludes what falls outside it', async () => {
        await Budget.create({
            school: S.id, name: 'Last Year', department: String(S.dept._id), allocated: 10000, status: 'active',
            periodStart: new Date('2020-01-01'), periodEnd: new Date('2020-12-31'),
        });
        await load();
        assert.equal(find('Last Year').spent, 0, 'this year’s orders are not last year’s spending');
    });

    test('remaining and usage follow from the allocation', async () => {
        const b = find('Science');
        assert.equal(b.remaining, b.allocated - b.spent);
        assert.equal(b.usage, Math.round((b.spent / b.allocated) * 100));
    });
});

describe('checkSpend', () => {
    test('a school with no budgets is never blocked', async () => {
        const fresh = await makeSchool();
        try {
            const r = await budgets.checkSpend(fresh.id, { department: null, items: [], total: 999999 });
            assert.equal(r.blocked, false, 'a school that has not set budgets up can still buy things');
        } finally {
            const { destroy } = require('./helpers');
            await destroy(fresh.id);
        }
    });

    test('an order that fits is allowed', async () => {
        const r = await budgets.checkSpend(S.id, { department: String(S.dept._id), items: [], total: 100 });
        assert.equal(r.blocked, false);
    });

    test('an order that does not fit is refused, and says which budget', async () => {
        const r = await budgets.checkSpend(S.id, { department: String(S.dept._id), items: [], total: 999999 });
        assert.equal(r.blocked, true);
        assert.match(r.message, /Science/);
    });
});
