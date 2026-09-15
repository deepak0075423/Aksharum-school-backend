'use strict';
/**
 * The wall clock this app runs on — the school's, not the host's.
 *
 * Much of the backend reads a time of day in the process's local zone: an
 * exam's "17:15" start is built with `new Date('2026-09-15T17:15:00')`, "today"
 * and "this month" come from local getters, and the SQL is handed the same zone
 * (`SERVER_TZ`). A developer's machine is set to IST, so all of it was right in
 * development; a production host runs in UTC, so a 5:15 PM exam opened at
 * 10:45 PM IST and every "today" rolled over at 5:30 AM.
 *
 * Require this FIRST — before anything that creates a Date or reads the zone at
 * load time (services/aptitudeExam.js captures SERVER_TZ once). Node re-reads
 * `process.env.TZ` when it is assigned, so setting it here is enough. Stored
 * dates are `timestamptz` instants and do not move.
 *
 * Override with APP_TIMEZONE (an IANA name). The host's own TZ is deliberately
 * not consulted: servers are commonly pinned to UTC, which is exactly the bug.
 */
require('dotenv').config({ quiet: true });

const zone = (process.env.APP_TIMEZONE || 'Asia/Kolkata').trim();

try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
} catch {
    throw new Error(`APP_TIMEZONE "${zone}" is not a valid IANA time zone (e.g. Asia/Kolkata)`);
}

process.env.TZ = zone;

module.exports = zone;
