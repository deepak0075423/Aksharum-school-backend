'use strict';
/**
 * The boards, now that they filter, sort, count and page in the database.
 *
 * The thing worth guarding is not the SQL — it is that the figures still add
 * up: a tab's number equals the rows that tab shows, a tile counts the whole
 * school rather than the filtered page, and paging a list never loses or
 * repeats a row.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const stock = require('../services/inventoryStock');
const admin = require('../controllers/inventoryAdmin.controller');
const Item = require('../models/InventoryItem');
const Issue = require('../models/InventoryIssue');
const { makeSchool, teardown } = require('./helpers');

let S;
const ITEMS = 14;

before(async () => {
    S = await makeSchool({ reorderLevel: 10 });
    // A catalogue big enough to page, in three states: comfortable, low, and
    // one never stocked at all.
    for (let i = 0; i < ITEMS; i++) {
        const it = await Item.create({
            school: S.id, name: `Widget ${String(i).padStart(2, '0')}`, itemCode: `ZZ-1${String(i).padStart(2, '0')}`,
            unit: 'Nos', category: String(i % 2 ? S.stationery._id : S.laboratory._id),
            warehouse: String(S.main._id), purchasePrice: 10 * (i + 1), reorderLevel: 10, isActive: true,
        });
        if (i < 10) {
            await stock.move(S.ctx, {
                item: String(it._id), warehouse: String(S.main._id), type: 'purchase',
                quantity: i < 5 ? 50 : 4, unitCost: 10 * (i + 1),
            });
        }
    }
    // A handful of issues, one of them partly returned, to give the issue
    // board both kinds of transaction row.
    for (let i = 0; i < 4; i++) {
        const iss = await Issue.create({
            school: S.id, issueNumber: `ZZ-IR-${i}`, item: String(S.item._id),
            warehouse: String(S.main._id), quantity: 3, returnable: i % 2 === 0,
            recipientType: 'staff', issuedToName: `ZZ Borrower ${i}`, issuedBy: S.ctx.userId,
            expectedReturn: i === 0 ? new Date(Date.now() - 86400000 * 5) : null,   // one overdue
            returns: i === 2 ? [{ returnNumber: `ZZ-IR-${i}-R01`, quantity: 1, condition: 'good', restocked: true, returnedAt: new Date() }] : [],
            returnedQty: i === 2 ? 1 : 0,
            status: i === 2 ? 'partially_returned' : 'issued',
        });
        assert.ok(iss._id);
    }
});
after(async () => { await teardown(S?.id); });

/** Call a board handler and hand back what it would have sent. */
function board(handler, query = {}) {
    return new Promise((resolve, reject) => {
        const req = { ...S.ctx, query, params: {}, body: {}, headers: {}, socket: {} };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(payload) {
                if (!payload.success) return reject(new Error(payload.message));
                resolve(payload.data);
                return this;
            },
        };
        handler(req, res);
    });
}

describe('the item board', () => {
    test('its tiles add up to the catalogue', async () => {
        const d = await board(admin.itemBoard);
        const t = d.tiles;
        const sum = t.inStock.value + t.lowStock.value + t.outOfStock.value + t.underRepair.value + t.notTracked.value;
        assert.equal(sum, t.total.value, 'the five buckets are meant to be exhaustive');
        assert.equal(t.total.value, ITEMS + 1, 'the fixture item plus the fourteen');
    });

    test('a state filter returns exactly what the tile counts', async () => {
        const all = await board(admin.itemBoard);
        const low = await board(admin.itemBoard, { state: 'low_stock', limit: 100 });
        assert.equal(low.matched, all.tiles.lowStock.value);
        assert.ok(low.rows.every(r => r.state === 'low_stock'));
    });

    test('a filter narrows the rows but never the tiles', async () => {
        const all = await board(admin.itemBoard);
        const one = await board(admin.itemBoard, { search: 'Widget 03' });
        assert.equal(one.matched, 1);
        assert.deepEqual(one.tiles.total, all.tiles.total, 'a tile that moved with the search box would be describing the search');
    });

    test('paging loses nothing and repeats nothing', async () => {
        const seen = new Set();
        let pages = 0;
        for (let p = 1; p <= 10; p++) {
            const d = await board(admin.itemBoard, { page: p, limit: 4, sort: 'name', dir: 'asc' });
            d.rows.forEach(r => seen.add(r._id));
            pages = d.pages;
            if (p >= d.pages) break;
        }
        assert.equal(seen.size, ITEMS + 1);
        assert.equal(pages, Math.ceil((ITEMS + 1) / 4));
    });

    test('sorting actually sorts, in both directions', async () => {
        const up = await board(admin.itemBoard, { sort: 'current', dir: 'asc', limit: 100 });
        const down = await board(admin.itemBoard, { sort: 'current', dir: 'desc', limit: 100 });
        const q = (d) => d.rows.map(r => r.current);
        assert.deepEqual(q(up), [...q(up)].sort((a, b) => a - b));
        assert.deepEqual(q(down), [...q(down)].sort((a, b) => b - a));
    });
});

describe('the issue board', () => {
    test('a transaction row per issue and per return', async () => {
        const d = await board(admin.issueBoard, { limit: 100 });
        assert.equal(d.tabs.issues, 4);
        assert.equal(d.tabs.returns, 1);
        assert.equal(d.tabs.all, 5, 'four issues and the one return');
        assert.equal(d.matched, d.tabs.all);
    });

    test('each tab returns exactly what it counts', async () => {
        const d = await board(admin.issueBoard, { limit: 100 });
        for (const tab of ['issues', 'returns', 'pending', 'overdue']) {
            const t = await board(admin.issueBoard, { tab, limit: 100 });
            assert.equal(t.matched, d.tabs[tab], `tab ${tab}`);
        }
    });

    test('the overdue tab is the one past its date', async () => {
        const t = await board(admin.issueBoard, { tab: 'overdue', limit: 100 });
        assert.equal(t.matched, 1);
        assert.equal(t.rows[0].state, 'overdue');
        assert.ok(new Date(t.rows[0].expectedReturn) < new Date());
    });

    test('a consumable is never counted as a pending return', async () => {
        const t = await board(admin.issueBoard, { tab: 'pending', limit: 100 });
        assert.ok(t.rows.every(r => r.returnable), 'a consumable does not come back');
    });
});

describe('the stock board', () => {
    test('a row per item and store that has ever held stock', async () => {
        const d = await board(admin.stockBoard, { limit: 100 });
        assert.equal(d.matched, 10, 'ten of the fourteen were stocked');
        assert.ok(d.rows.every(r => r.warehouse && r.itemId));
    });

    test('its donut slices add up to its own total', async () => {
        const d = await board(admin.stockBoard);
        const sum = d.distribution.slices.reduce((t, s) => t + s.value, 0);
        assert.equal(sum, d.distribution.total);
    });

    test('the top-value list is in value order and no longer than five', async () => {
        const d = await board(admin.stockBoard);
        assert.ok(d.topValue.length <= 5);
        const v = d.topValue.map(t => t.value);
        assert.deepEqual(v, [...v].sort((a, b) => b - a));
    });
});

describe('the audit board', () => {
    test('every row carries a module and a verb', async () => {
        const d = await board(admin.activityBoard, { limit: 50 });
        assert.ok(d.rows.every(r => r.module && r.verb), 'the SQL classification must cover every line');
    });

    test('filtering by verb returns only that verb', async () => {
        const d = await board(admin.activityBoard, { action: 'created', limit: 100 });
        assert.ok(d.rows.every(r => r.verb === 'created'));
    });
});
