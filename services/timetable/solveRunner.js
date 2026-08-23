'use strict';
/**
 * Runs the solver off the request thread, with an in-process fallback.
 *
 * If worker threads are unavailable for any reason the solve still happens —
 * generation is too important to fail because a thread could not start — but the
 * normal path keeps the event loop free.
 */
const path = require('path');

const WORKER = path.join(__dirname, 'solveWorker.js');

/**
 * @param {object}   input        the engine input
 * @param {function} onProgress   (stepKey, percent)
 * @returns {Promise<{assignments, conflicts, stats, seed, score, ranInWorker}>}
 */
function solve(input, onProgress = () => {}) {
    let Worker;
    try { ({ Worker } = require('worker_threads')); } catch { Worker = null; }

    if (!Worker) {
        const { generate } = require('./engine');
        const r = generate(input, { onProgress });
        return Promise.resolve({ ...r, ranInWorker: false });
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const worker = new Worker(WORKER, { workerData: { input } });

        worker.on('message', (msg) => {
            if (msg.type === 'progress') return onProgress(msg.stepKey, msg.percent);
            if (msg.type === 'error') {
                settled = true;
                const e = new Error(msg.message);
                e.stack = msg.stack || e.stack;
                worker.terminate();
                return reject(e);
            }
            if (msg.type === 'done') {
                settled = true;
                worker.terminate();
                return resolve({ ...msg, ranInWorker: true });
            }
        });

        worker.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
        worker.on('exit', (code) => {
            if (!settled) reject(new Error(`Timetable solver stopped unexpectedly (exit ${code})`));
        });
    });
}

module.exports = { solve };
