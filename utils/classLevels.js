'use strict';
/**
 * The classes a school can create (Oct 2026): four pre-primary years, then
 * Class 1 to Class 12 — and the number each one carries.
 *
 * The number is what classes are ORDERED by everywhere (utils/listOrder) and
 * what promotion climbs (services/resultPromotion: next class = number + 1),
 * so pre-primary sits below 1 and UKG / KG2 leads straight into Class 1:
 *
 *   −3 Playgroup / Pre-Nursery   −2 Nursery   −1 LKG / KG1   0 UKG / KG2   1…12 Class 1…12
 *
 * Three of the four go by two names; the school picks the one it uses, and
 * that is the class's name. `short` is what fits on a grade chip or before a
 * section letter ("LKG A"), where a class from 1 to 12 shows its number.
 *
 * Same list on the web (src/utils/classLevels.js) and the phone
 * (utils/classLevels.ts).
 */
const PRE_PRIMARY = [
    { number: -3, label: 'Playgroup / Pre-Nursery', names: ['Playgroup', 'Pre-Nursery'], short: ['PG', 'PN'] },
    { number: -2, label: 'Nursery',                 names: ['Nursery'],                   short: ['NUR'] },
    { number: -1, label: 'LKG / KG1',               names: ['LKG', 'KG1'],                short: ['LKG', 'KG1'] },
    { number: 0,  label: 'UKG / KG2',               names: ['UKG', 'KG2'],                short: ['UKG', 'KG2'] },
];
const CLASS_LEVELS = [
    ...PRE_PRIMARY,
    ...Array.from({ length: 12 }, (_, i) => ({
        number: i + 1, label: `Class ${i + 1}`, names: [`Class ${i + 1}`], short: [String(i + 1)],
    })),
];
const SUMMARY = 'Playgroup / Pre-Nursery, Nursery, LKG / KG1, UKG / KG2 or Class 1 to Class 12';

const levelOf = (number) => {
    if (number === null || number === undefined || number === '') return null;
    const n = Number(number);
    return Number.isInteger(n) ? CLASS_LEVELS.find((l) => l.number === n) || null : null;
};

const squash = (s) => String(s ?? '').toLowerCase().replace(/[\s._-]+/g, '');

// Other ways a pre-primary year is written, for names typed in an older app.
const ALIASES = { pg: 'Playgroup', lowerkg: 'LKG', juniorkg: 'LKG', upperkg: 'UKG', seniorkg: 'UKG' };
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

/**
 * The standard class a typed name means — { number, name } with the name in
 * its standard spelling ("lkg" → LKG, "Class V" or "grade 5" → Class 5) — or
 * null when it is none of them.
 */
function levelForName(typed) {
    const key = squash(typed);
    if (!key) return null;
    const aliased = ALIASES[key] ? squash(ALIASES[key]) : key;
    for (const lvl of PRE_PRIMARY) {
        const name = lvl.names.find((n) => squash(n) === aliased);
        if (name) return { number: lvl.number, name };
    }
    const m = key.match(/^(?:class|grade|std|standard)?(\d{1,2}|[ivx]{1,4})$/);
    if (m) {
        const n = /^\d+$/.test(m[1]) ? Number(m[1]) : ROMAN[m[1]];
        if (n >= 1 && n <= 12) return { number: n, name: `Class ${n}` };
    }
    return null;
}

/** "LKG", "PG", "5" — a class in a few characters. Anything unrecognised keeps its own name. */
function shortOf(cls) {
    const n = Number(cls?.classNumber);
    const name = String(cls?.className ?? '').trim();
    if (Number.isInteger(n) && n >= 1) return String(n);
    const lvl = levelOf(n);
    const i = lvl ? lvl.names.findIndex((x) => x.toLowerCase() === name.toLowerCase()) : -1;
    return i >= 0 ? lvl.short[i] : name;
}

module.exports = { CLASS_LEVELS, PRE_PRIMARY, SUMMARY, levelOf, levelForName, shortOf };
