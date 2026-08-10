'use strict';
// True on exactly ONE process in the deployment:
//   • PM2 cluster mode  -> the worker whose NODE_APP_INSTANCE is '0'
//   • fork mode / dev / tests / plain `node server.js` -> NODE_APP_INSTANCE unset,
//     so it is true (there is only one process anyway).
//
// Background singletons — the monthly leave-accrual timer and the chat-broker
// Redis consumer — MUST run here only. Under cluster mode every worker would
// otherwise fire the timer N times and consume each chat message N times
// (N-fold duplicate messages/receipts). This flag is what makes cluster mode safe.
const inst = process.env.NODE_APP_INSTANCE;
const isPrimaryWorker = inst === undefined || inst === '' || inst === '0';

module.exports = { isPrimaryWorker };
