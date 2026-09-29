'use strict';
/**
 * Document numbering.
 *
 * Numbers used to come from "the highest one so far, plus one", which two
 * requests arriving together both read — so two documents got the same number
 * and the unique index turned one of them into a 500. These check the counter
 * hands out a distinct number every time, including under concurrency.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const { nextNumber } = require('../services/inventoryNumber');
const { makeSchool, teardown } = require('./helpers');

let S;
before(async () => { S = await makeSchool(); });
after(async () => { await teardown(S?.id); });

describe('document numbers', () => {
    test('each kind gets its own prefixed sequence', async () => {
        const year = new Date().getFullYear();
        const req = await nextNumber(S.id, 'request');
        const ord = await nextNumber(S.id, 'order');
        const iss = await nextNumber(S.id, 'issue');
        assert.match(req, new RegExp(`^REQ-${year}-\\d{3}$`));
        assert.match(ord, new RegExp(`^PO-${year}-\\d{3}$`));
        assert.match(iss, new RegExp(`^IR-${year}-\\d{3}$`));
    });

    test('items and assets get codes from the same counter', async () => {
        const a = await nextNumber(S.id, 'item');
        const b = await nextNumber(S.id, 'asset');
        assert.match(a, /^ITM-\d{4}-\d{3}$/);
        assert.match(b, /^AST-\d{4}-\d{3}$/);
    });

    test('it climbs, one at a time', async () => {
        const a = await nextNumber(S.id, 'request');
        const b = await nextNumber(S.id, 'request');
        const seq = (n) => Number(n.split('-').pop());
        assert.equal(seq(b), seq(a) + 1);
    });

    test('fifty at once produce fifty different numbers', async () => {
        const got = await Promise.all(Array.from({ length: 50 }, () => nextNumber(S.id, 'order')));
        assert.equal(new Set(got).size, 50, 'a duplicate here is a 500 in production');
    });

    test('two schools do not share a sequence', async () => {
        const other = await makeSchool();
        try {
            const mine = await nextNumber(S.id, 'issue');
            const theirs = await nextNumber(other.id, 'issue');
            const seq = (n) => Number(n.split('-').pop());
            assert.equal(seq(theirs), 1, 'a new school starts at one');
            assert.ok(seq(mine) > 1);
        } finally {
            const { destroy } = require('./helpers');
            await destroy(other.id);
        }
    });
});
