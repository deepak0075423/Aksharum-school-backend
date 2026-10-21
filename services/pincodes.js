'use strict';
/**
 * PIN code → state, district and post offices — one lookup for every address
 * form (the student/teacher/school forms and the admission portal).
 *
 * Where the answer comes from, best first:
 *   1. the PIN directory kept in this database — India Post's "All India
 *      Pincode Directory" (data.gov.in), loaded with scripts/importPincodes.js;
 *   2. India Post's public lookup (api.postalpincode.in), when the directory
 *      has not been loaded or does not have the PIN;
 *   3. offline: the state the PIN's first digits belong to — and only where
 *      those digits belong to one state (utils/indiaStates stateFromPincode).
 *
 * Results are cached in memory. Nothing here invents a place: a PIN nobody
 * knows comes back null.
 */
const pool = require('../db/pool');
const { STATES_AND_UTS, isPincode, stateFromPincode } = require('../utils/indiaStates');

const CACHE = new Map();
const CACHE_MAX = 2000;
let directoryRows = null;        // rows in the directory, counted once (null: not counted yet)
let countedAt = 0;

/** "UTTAR PRADESH" / "uttar pradesh" → "Uttar Pradesh", if it is one of ours. */
function stateName(raw) {
    const t = String(raw || '').trim().toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ');
    if (!t) return '';
    const alias = { 'orissa': 'Odisha', 'pondicherry': 'Puducherry', 'nct of delhi': 'Delhi', 'new delhi': 'Delhi', 'the dadra and nagar haveli and daman and diu': 'Dadra and Nagar Haveli and Daman and Diu', 'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu', 'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu', 'jammu & kashmir': 'Jammu and Kashmir', 'andaman & nicobar islands': 'Andaman and Nicobar Islands' };
    if (alias[t]) return alias[t];
    return STATES_AND_UTS.find((s) => s.toLowerCase() === t) || '';
}

/** Title Case for a district or office name as the directory spells it ("SOUTH WEST DELHI"). */
const titled = (v) => String(v || '').trim().toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\s+/g, ' ');

async function directorySize() {
    if (directoryRows !== null && Date.now() - countedAt < 10 * 60000) return directoryRows;
    try {
        const { rows: [r] } = await pool.query('SELECT COUNT(*)::int AS n FROM "pincodes"');
        directoryRows = r.n;
    } catch { directoryRows = 0; }
    countedAt = Date.now();
    return directoryRows;
}

async function fromDirectory(pin) {
    if (!(await directorySize())) return null;
    const { rows } = await pool.query(`SELECT "officeName", "district", "state" FROM "pincodes" WHERE "pincode" = $1 ORDER BY "officeName" LIMIT 60`, [pin]);
    if (!rows.length) return null;
    const state = stateName(rows[0].state) || stateFromPincode(pin);
    return {
        pincode: pin, country: 'India', state, city: titled(rows[0].district), district: titled(rows[0].district),
        // "Connaught Place SO" → "Connaught Place": the office type is not part of the place.
        areas: [...new Set(rows.map((r) => titled(r.officeName).replace(/\s+(S|H|B)\.?O\.?$/i, '')).filter(Boolean))], source: 'directory',
    };
}

async function fromIndiaPost(pin) {
    try {
        const r = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return null;
        const body = await r.json();
        const entry = Array.isArray(body) ? body[0] : null;
        const offices = entry?.Status === 'Success' ? (entry.PostOffice || []) : [];
        if (!offices.length) return null;
        const first = offices[0];
        return {
            pincode: pin, country: first.Country || 'India', state: stateName(first.State) || stateFromPincode(pin),
            city: first.District || first.Division || '', district: first.District || '',
            areas: [...new Set(offices.map((o) => o.Name).filter(Boolean))], source: 'india-post',
        };
    } catch { return null; }   // offline / timeout
}

/** The place a PIN belongs to, or null when nobody knows it. */
async function lookup(pincode) {
    const pin = String(pincode || '').trim();
    if (!isPincode(pin)) return null;
    if (CACHE.has(pin)) return CACHE.get(pin);
    let result = await fromDirectory(pin) || await fromIndiaPost(pin);
    if (!result) {
        const state = stateFromPincode(pin);
        result = state ? { pincode: pin, country: 'India', state, city: '', district: '', areas: [], source: 'offline' } : null;
        if (!result) return null;   // not cached: India Post may answer next time
        // An offline guess is not kept for long — the next call tries India Post again.
        setTimeout(() => { if (CACHE.get(pin) === result) CACHE.delete(pin); }, 5 * 60000).unref?.();
    }
    if (CACHE.size >= CACHE_MAX) CACHE.clear();
    CACHE.set(pin, result);
    return result;
}

/** After an import: forget what was counted and cached. */
function reset() { directoryRows = null; CACHE.clear(); }

module.exports = { lookup, stateName, titled, reset };
