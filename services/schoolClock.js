'use strict';
/**
 * Each school's own clock, for the Results module (Oct 2026).
 *
 * The process runs on one zone (config/timezone — the platform's), and the
 * Results module read every "today" and every "the result date has begun" off
 * it: a school elsewhere had its results released, its reminders counted and
 * its exam days rolled over on another place's midnight. A school may now name
 * its zone (School.timezone); this answers in it, and falls back to the
 * platform's when it names none.
 *
 * Reads that must stay synchronous (visibleToFamilies is called while shaping
 * rows) take the zone from a small cache, primed at boot, refreshed in the
 * background and updated the moment a school's zone is changed here.
 */
const pool = require('../db/pool');
const PLATFORM = require('../config/timezone');

const zones = new Map();          // schoolId → IANA zone
let primed = false;
const REFRESH_MS = 10 * 60 * 1000;

const valid = (zone) => {
    if (!zone || typeof zone !== 'string') return false;
    try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
};

/** Load every school's zone (boot, and every ten minutes after). */
async function prime() {
    try {
        const { rows } = await pool.query(`SELECT "_id", "timezone" FROM "schools"`);
        zones.clear();
        for (const r of rows) if (valid(r.timezone)) zones.set(String(r._id), r.timezone);
        primed = true;
    } catch (e) {
        console.error('[schoolClock] could not load time zones:', e.message);
    }
}
let timer = null;
function start() {
    if (timer) return;
    prime();
    timer = setInterval(prime, REFRESH_MS);
    if (timer.unref) timer.unref();
}

/** The school's zone — its own when it has named one, else the platform's. */
function zoneOf(schoolId) {
    if (!primed) start();
    return zones.get(String(schoolId || '')) || PLATFORM;
}
/** Remember a school's new zone at once (the settings page changed it). */
function setZone(schoolId, zone) {
    if (valid(zone)) zones.set(String(schoolId), zone);
    else zones.delete(String(schoolId));
}

/** Minutes the zone is ahead of UTC at instant `at`. */
function offsetMinutes(zone, at) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * The instant a calendar day begins on a zone's clock. `day` is a stored day
 * (UTC midnight of the day meant) or "YYYY-MM-DD".
 */
function dayStartIn(day, zone = PLATFORM) {
    const d = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00.000Z`) : new Date(day);
    if (Number.isNaN(d.getTime())) return null;
    const midnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    let t = midnightUtc - offsetMinutes(zone, new Date(midnightUtc)) * 60000;
    // Across a daylight-saving change the offset at the answer can differ.
    const again = midnightUtc - offsetMinutes(zone, new Date(t)) * 60000;
    if (again !== t) t = again;
    return new Date(t);
}

/** Today on a zone's clock, "YYYY-MM-DD". */
function todayIn(zone = PLATFORM, now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

module.exports = { zoneOf, setZone, prime, start, dayStartIn, todayIn, offsetMinutes, valid, PLATFORM };
