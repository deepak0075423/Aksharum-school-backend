'use strict';
// Deterministic PRNG (mulberry32).
//
// The solver is a search, not a lottery — randomness is used ONLY to break ties
// between equally-scored placements and to diversify restarts. Seeding it means
// the same input + same seed always produces the same timetable, which is what
// makes a generation reproducible for debugging and for "regenerate identically".

function createRng(seed = 1) {
    let a = (Number(seed) >>> 0) || 1;
    const next = () => {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        /** integer in [0, n) */
        int: (n) => Math.floor(next() * n),
        pick: (arr) => (arr.length ? arr[Math.floor(next() * arr.length)] : undefined),
        /** Fisher-Yates, in place */
        shuffle(arr) {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(next() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            return arr;
        },
    };
}

/** A fresh seed for a new generation run. */
const newSeed = () => Math.floor(Math.random() * 2147483647) + 1;

module.exports = { createRng, newSeed };
