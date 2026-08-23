'use strict';
/**
 * The solver, run on a worker thread.
 *
 * `generate()` is pure CPU — measured at 5.2s for a 60-section school and up to
 * its full 20s budget under teacher scarcity. Run inline it pins the Node event
 * loop for that whole time, and under PM2 cluster mode that worker serves no
 * other request meanwhile. The engine takes a plain object and a seed and
 * returns a plain object, so it moves onto a thread without ceremony.
 *
 * Progress is posted back over the message port, so the caller's progress
 * writer behaves exactly as it did in-process.
 */
const { parentPort, workerData } = require('worker_threads');
const { generate } = require('./engine');

try {
    const result = generate(workerData.input, {
        onProgress: (stepKey, percent) => {
            parentPort.postMessage({ type: 'progress', stepKey, percent });
        },
    });
    // `ctx` holds Maps and back-references — it cannot cross the thread boundary
    // and the caller only needs it for revalidation, which is redone there.
    parentPort.postMessage({
        type: 'done',
        assignments: result.assignments,
        conflicts: result.conflicts,
        stats: result.stats,
        seed: result.seed,
        score: result.score,
    });
} catch (e) {
    parentPort.postMessage({ type: 'error', message: e.message, stack: e.stack });
}
