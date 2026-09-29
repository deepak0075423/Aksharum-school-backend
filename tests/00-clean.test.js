'use strict';
/**
 * Runs first (the filename sorts first) and clears any scratch school a
 * previous run left behind when it crashed. Without it a stale school's rows
 * would be counted by the next run's assertions.
 */
const { test } = require('node:test');
const { sweepStragglers, ready } = require('./helpers');

test('no scratch school is left over from a previous run', async () => {
    await ready();
    await sweepStragglers();
});
