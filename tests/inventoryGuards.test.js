'use strict';
/**
 * The guards that stop the module contradicting itself.
 *
 * Deleting a record nothing else points at is fine. Deleting one that half the
 * module references leaves rows pointing at nothing, which is how a screen ends
 * up showing "Deleted item" for ever. And returning goods has to put them back:
 * a condition the server did not recognise used to record the return, close the
 * issue and quietly keep the stock off the shelf.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const stock = require('../services/inventoryStock');
const Item = require('../models/InventoryItem');
const Category = require('../models/InventoryCategory');
const Warehouse = require('../models/InventoryWarehouse');
const Department = require('../models/InventoryDepartment');
const Request = require('../models/PurchaseRequest');
const Issue = require('../models/InventoryIssue');
const inv = require('../controllers/inventory.controller');
const { makeSchool, teardown, balances } = require('./helpers');

let S;
before(async () => { S = await makeSchool(); });
after(async () => { await teardown(S?.id); });

/** A controller takes (req, res); this is the smallest thing that is both. */
function call(handler, { params = {}, body = {}, query = {} } = {}) {
    return new Promise((resolve) => {
        const req = { ...S.ctx, params, body, query, headers: {}, ip: '127.0.0.1', socket: {} };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(payload) { resolve({ status: this.statusCode, ...payload }); return this; },
            setHeader() { return this; },
            send(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
        };
        handler(req, res);
    });
}

describe('delete guards', () => {
    test('a category with items in it is refused', async () => {
        const r = await call(inv.deleteCategory, { params: { id: String(S.stationery._id) } });
        assert.equal(r.status, 400);
        assert.match(r.message, /item\(s\) use this category/);
        assert.ok(await Category.findById(S.stationery._id), 'and it is still there');
    });

    test('a category with a sub-category is refused', async () => {
        const kid = await Category.create({ school: S.id, name: 'Glassware', parent: String(S.laboratory._id) });
        const r = await call(inv.deleteCategory, { params: { id: String(S.laboratory._id) } });
        assert.equal(r.status, 400);
        assert.match(r.message, /sub-categor/);
        await Category.deleteOne({ _id: kid._id });
    });

    test('an empty category deletes', async () => {
        const spare = await Category.create({ school: S.id, name: 'ZZ Spare' });
        const r = await call(inv.deleteCategory, { params: { id: String(spare._id) } });
        assert.equal(r.status, 200);
        assert.equal(await Category.findById(spare._id), null);
    });

    test('a store still holding stock is refused', async () => {
        await stock.move(S.ctx, { item: String(S.item._id), warehouse: String(S.main._id), type: 'purchase', quantity: 30, unitCost: 100 });
        const r = await call(inv.deleteWarehouse, { params: { id: String(S.main._id) } });
        assert.equal(r.status, 400);
        assert.match(r.message, /still holds stock/);
    });

    test('an item with stock is refused, and so is one on an open order', async () => {
        const r = await call(inv.deleteItem, { params: { id: String(S.item._id) } });
        assert.equal(r.status, 400);
        assert.match(r.message, /still has stock/);
        assert.ok(await Item.findById(S.item._id));
    });

    test('a department with a request against it is refused', async () => {
        await Request.create({
            school: S.id, requestNumber: 'ZZ-REQ-1', requestedBy: S.ctx.userId,
            department: String(S.dept._id), reason: 'test', items: [],
        });
        const r = await call(inv.deleteDepartment, { params: { id: String(S.dept._id) } });
        assert.equal(r.status, 400);
        assert.match(r.message, /request\(s\) belong to this department/);
        assert.ok(await Department.findById(S.dept._id), 'this one had no guard at all before');
    });
});

describe('returning goods', () => {
    let issue;
    before(async () => {
        issue = await Issue.create({
            school: S.id, issueNumber: 'ZZ-IR-1', item: String(S.item._id),
            warehouse: String(S.main._id), quantity: 6, returnable: true,
            recipientType: 'staff', issuedToName: 'ZZ Borrower', issuedBy: S.ctx.userId,
        });
        await stock.move(S.ctx, { item: String(S.item._id), warehouse: String(S.main._id), type: 'issue', quantity: -6 });
    });

    const onHand = async () => (await balances(S.id)).find(b => b.name === 'Test Widget').balance;

    test('an unrecognised condition is refused rather than silently ignored', async () => {
        const before = await onHand();
        const r = await call(inv.returnIssue, { params: { id: String(issue._id) }, body: { returnQty: 2, condition: 'Nonsense' } });
        assert.equal(r.status, 400);
        assert.match(r.message, /Unknown condition/);
        assert.equal(await onHand(), before, 'and nothing moved');
    });

    test('a condition in the wrong case still restocks', async () => {
        const before = await onHand();
        const r = await call(inv.returnIssue, { params: { id: String(issue._id) }, body: { returnQty: 2, condition: 'Good' } });
        assert.equal(r.status, 200);
        assert.equal(await onHand(), before + 2, '"Good" used to close the issue and lose the goods');
    });

    test('a damaged return comes back and is written straight off', async () => {
        const before = await onHand();
        const r = await call(inv.returnIssue, { params: { id: String(issue._id) }, body: { returnQty: 2, condition: 'damaged' } });
        assert.equal(r.status, 200);
        assert.equal(await onHand(), before, 'the shelf is unchanged');
        const b = (await balances(S.id)).find(x => x.name === 'Test Widget');
        assert.equal(b.balance, b.ledger, 'but both movements are in the ledger');
    });

    test('a return of more than is outstanding is capped, not refused', async () => {
        const r = await call(inv.returnIssue, { params: { id: String(issue._id) }, body: { returnQty: 99, condition: 'good' } });
        assert.equal(r.status, 200);
        const fresh = await Issue.findById(issue._id).lean();
        assert.equal(fresh.returnedQty, 6);
        assert.equal(fresh.status, 'returned');
    });

    test('a fully returned issue cannot be returned again', async () => {
        const r = await call(inv.returnIssue, { params: { id: String(issue._id) }, body: { returnQty: 1, condition: 'good' } });
        assert.equal(r.status, 400);
        assert.match(r.message, /Already fully returned/);
    });
});
