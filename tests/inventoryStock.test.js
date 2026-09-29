'use strict';
/**
 * The one writer of stock balances.
 *
 * These are the invariants the rest of the module rests on: a balance can
 * never go negative, the ledger always agrees with the balance it describes,
 * concurrent movements cannot lose each other, and stock promised to an
 * approved request cannot be taken by somebody else.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const stock = require('../services/inventoryStock');
const { makeSchool, teardown, balances } = require('./helpers');

let S;
before(async () => { S = await makeSchool(); });
after(async () => { await teardown(S?.id); });

const item = () => String(S.item._id);
const main = () => String(S.main._id);
const lab = () => String(S.lab._id);

describe('stock movement', () => {
    test('a receipt raises the balance and writes one ledger row', async () => {
        const r = await stock.move(S.ctx, {
            item: item(), warehouse: main(), type: 'purchase', quantity: 40, unitCost: 100,
        });
        assert.equal(r.quantity, 40);
        const [row] = (await balances(S.id)).filter(b => b.name === 'Test Widget');
        assert.equal(row.balance, 40);
        assert.equal(row.ledger, 40, 'the ledger must describe the balance');
    });

    test('an issue lowers it', async () => {
        await stock.move(S.ctx, { item: item(), warehouse: main(), type: 'issue', quantity: -15 });
        const [row] = (await balances(S.id)).filter(b => b.name === 'Test Widget');
        assert.equal(row.balance, 25);
        assert.equal(row.ledger, 25);
    });

    test('nothing can drive a balance below zero', async () => {
        await assert.rejects(
            () => stock.move(S.ctx, { item: item(), warehouse: main(), type: 'issue', quantity: -999 }),
            (e) => e.code === 'INSUFFICIENT_STOCK',
        );
        const [row] = (await balances(S.id)).filter(b => b.name === 'Test Widget');
        assert.equal(row.balance, 25, 'the refused movement must leave nothing behind');
        assert.equal(row.ledger, 25, 'and no ledger row either');
    });

    test('a movement of zero is refused rather than recorded', async () => {
        await assert.rejects(() => stock.move(S.ctx, { item: item(), warehouse: main(), type: 'issue', quantity: 0 }));
    });

    test('concurrent issues cannot lose each other', async () => {
        // Ten at once, each taking one. A read-modify-write in JavaScript loses
        // some of these; the balance afterwards is the whole test.
        await Promise.all(Array.from({ length: 10 }, () =>
            stock.move(S.ctx, { item: item(), warehouse: main(), type: 'issue', quantity: -1 })));
        const [row] = (await balances(S.id)).filter(b => b.name === 'Test Widget');
        assert.equal(row.balance, 15);
        assert.equal(row.ledger, 15);
    });

    test('a race for the last unit lets exactly one through', async () => {
        await stock.move(S.ctx, { item: item(), warehouse: lab(), type: 'purchase', quantity: 1 });
        const tries = await Promise.allSettled(Array.from({ length: 5 }, () =>
            stock.move(S.ctx, { item: item(), warehouse: lab(), type: 'issue', quantity: -1 })));
        const won = tries.filter(t => t.status === 'fulfilled').length;
        assert.equal(won, 1, 'one movement should succeed, not five');
        const [row] = (await balances(S.id)).filter(b => b.name === 'Test Widget' && b.balance === 0);
        assert.ok(row, 'the lab store should be left at zero');
    });

    test('moveAll is all or nothing', async () => {
        const before = (await balances(S.id)).find(b => b.balance === 15).balance;
        await assert.rejects(() => stock.moveAll(S.ctx, [
            { item: item(), warehouse: main(), type: 'issue', quantity: -1 },
            { item: item(), warehouse: main(), type: 'issue', quantity: -9999 },   // this one cannot happen
        ]));
        const after = (await balances(S.id)).find(b => b.balance === before);
        assert.ok(after, 'the first movement must be rolled back with the second');
    });
});

describe('reservations', () => {
    test('a hold does not move stock but does reduce what is free', async () => {
        await stock.reserve(S.ctx, { item: item(), warehouse: main(), quantity: 10 });
        const row = (await balances(S.id)).find(b => b.reserved > 0);
        assert.equal(row.balance, 15, 'the goods are still on the shelf');
        assert.equal(row.reserved, 10);
    });

    test('an ordinary movement cannot take reserved stock', async () => {
        await assert.rejects(
            () => stock.move(S.ctx, { item: item(), warehouse: main(), type: 'issue', quantity: -10 }),
            (e) => e.code === 'INSUFFICIENT_STOCK' && e.reserved === 10,
        );
        // But what is free still moves.
        await stock.move(S.ctx, { item: item(), warehouse: main(), type: 'issue', quantity: -5 });
        const row = (await balances(S.id)).find(b => b.reserved > 0);
        assert.equal(row.balance, 10);
    });

    test('a correction may, because the goods are genuinely gone', async () => {
        await stock.move(S.ctx, { item: item(), warehouse: main(), type: 'damage', quantity: -2 });
        const row = (await balances(S.id)).find(b => b.reserved > 0);
        assert.equal(row.balance, 8, 'a breakage is not blocked by a promise');
        assert.equal(row.ledger, 8);
    });

    test('a hold cannot be taken twice', async () => {
        await assert.rejects(
            () => stock.reserve(S.ctx, { item: item(), warehouse: main(), quantity: 50 }),
            (e) => e.code === 'INSUFFICIENT_STOCK',
        );
    });

    test('releasing gives it back and never goes below zero', async () => {
        await stock.release(S.ctx, { item: item(), warehouse: main(), quantity: 10 });
        await stock.release(S.ctx, { item: item(), warehouse: main(), quantity: 10 });  // again, on purpose
        const row = (await balances(S.id)).find(b => b.balance === 8);
        assert.equal(row.reserved, 0);
    });

    test('the ledger and the balances agree for everything this school has', async () => {
        for (const b of await balances(S.id)) {
            assert.equal(b.balance, b.ledger, `${b.name}: balance ${b.balance} vs ledger ${b.ledger}`);
        }
    });
});
