'use strict';
/**
 * The watchman.
 *
 * A sweep that runs hourly has one job beyond noticing things: not saying the
 * same thing sixty times. These check it reports a condition once, escalates
 * when it gets worse without re-announcing itself, and reports it again after
 * it clears and comes back.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const alerts = require('../services/inventoryAlerts');
const stock = require('../services/inventoryStock');
const Alert = require('../models/InventoryAlert');
const Issue = require('../models/InventoryIssue');
const Budget = require('../models/InventoryBudget');
const { makeSchool, teardown } = require('./helpers');

let S;
before(async () => { S = await makeSchool({ reorderLevel: 20 }); });
after(async () => { await teardown(S?.id); });

const item = () => String(S.item._id);
const main = () => String(S.main._id);
const rowsOf = (kind) => Alert.find({ school: S.id, kind }).lean();

describe('low stock', () => {
    test('a comfortable item says nothing', async () => {
        await stock.move(S.ctx, { item: item(), warehouse: main(), type: 'purchase', quantity: 100, unitCost: 100 });
        const n = await alerts.sweepLowStock(S.id);
        assert.equal(n, 0);
    });

    test('falling to the reorder level is reported once', async () => {
        await stock.move(S.ctx, { item: item(), warehouse: main(), type: 'issue', quantity: -85 });  // 15, level is 20
        assert.equal(await alerts.sweepLowStock(S.id), 1);
        assert.equal(await alerts.sweepLowStock(S.id), 0, 'the second sweep must be silent');
        assert.equal((await rowsOf('low_stock')).length, 1);
        assert.equal((await rowsOf('low_stock'))[0].level, 'warn');
    });

    test('running out entirely is worse news, and is said again', async () => {
        await stock.move(S.ctx, { item: item(), warehouse: main(), type: 'issue', quantity: -15 });
        assert.equal(await alerts.sweepLowStock(S.id), 1, 'low → out is new news');
        const rows = await rowsOf('low_stock');
        assert.equal(rows.length, 1, 'but the subject holds one row, not two');
        assert.equal(rows[0].level, 'critical');
        assert.equal(await alerts.sweepLowStock(S.id), 0, 'and it does not repeat itself');
    });

    test('restocking clears it, and a later fall is reported afresh', async () => {
        await stock.move(S.ctx, { item: item(), warehouse: main(), type: 'purchase', quantity: 100, unitCost: 100 });
        await alerts.sweepLowStock(S.id);
        assert.equal((await rowsOf('low_stock')).length, 0, 'the record goes when the condition does');
        await stock.move(S.ctx, { item: item(), warehouse: main(), type: 'issue', quantity: -90 });
        assert.equal(await alerts.sweepLowStock(S.id), 1, 'next term it is news again');
    });

    test('it measures what is free, not what is on the shelf', async () => {
        await Alert.deleteMany({ school: S.id });
        await stock.move(S.ctx, { item: item(), warehouse: main(), type: 'purchase', quantity: 100, unitCost: 100 });
        await alerts.sweepLowStock(S.id);                       // comfortable, nothing said
        await Alert.deleteMany({ school: S.id });
        await stock.reserve(S.ctx, { item: item(), warehouse: main(), quantity: 100 });
        assert.equal(await alerts.sweepLowStock(S.id), 1, 'stock promised to a request cannot meet the next one');
        await stock.release(S.ctx, { item: item(), warehouse: main(), quantity: 100 });
    });
});

describe('overdue returns', () => {
    test('an issue past its date is reported, once', async () => {
        await Issue.create({
            school: S.id, issueNumber: 'ZZ-OD-1', item: item(), warehouse: main(),
            quantity: 2, returnable: true, recipientType: 'staff', issuedToName: 'ZZ Late',
            issuedBy: S.ctx.userId, expectedReturn: new Date(Date.now() - 86400000 * 3),
        });
        assert.equal(await alerts.sweepOverdueReturns(S.id), 1);
        assert.equal(await alerts.sweepOverdueReturns(S.id), 0);
    });

    test('a consumable is never overdue', async () => {
        await Issue.create({
            school: S.id, issueNumber: 'ZZ-OD-2', item: item(), warehouse: main(),
            quantity: 2, returnable: false, recipientType: 'staff', issuedToName: 'ZZ Consumable',
            issuedBy: S.ctx.userId, expectedReturn: new Date(Date.now() - 86400000 * 9),
        });
        assert.equal(await alerts.sweepOverdueReturns(S.id), 0, 'chalk does not come back');
    });
});

describe('budgets', () => {
    test('a budget under its threshold says nothing', async () => {
        await Budget.create({
            school: S.id, name: 'ZZ Science Budget', code: 'ZZSCI',
            department: String(S.dept._id), allocated: 100000, alertAt: 90, status: 'active',
        });
        assert.equal(await alerts.sweepBudgets(S.id), 0);
    });

    test('a budget with no allocation is never reported', async () => {
        await Budget.create({ school: S.id, name: 'ZZ Empty', allocated: 0, status: 'active' });
        assert.equal(await alerts.sweepBudgets(S.id), 0, 'zero of zero is not a hundred per cent');
    });
});

describe('the whole sweep', () => {
    test('one part failing does not stop the rest', async () => {
        const out = await alerts.runInventorySweep(S.id);
        assert.equal(typeof out.total, 'number');
        for (const k of ['lowStock', 'expiry', 'overdue', 'budget', 'capacity']) {
            assert.equal(typeof out[k], 'number', `${k} must report a number even when it finds nothing`);
        }
    });

    test('a school with the module off is not swept', async () => {
        const schools = await alerts.schoolsToSweep();
        assert.ok(schools.includes(S.id), 'this one has it on');
    });
});
