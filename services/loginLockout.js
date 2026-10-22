'use strict';
/**
 * Five wrong passwords lock an address's password sign-in for 24 hours.
 *
 * Counted per ADDRESS, not per row: an address is one person with one password
 * (services/accountIdentity), so a guess against it is a guess against every
 * post it opens — and both doors that check that password, the sign-in page and
 * an admission portal's, go through checkPassword() and share the one count.
 *
 * Addresses no account uses are counted exactly the same way, so neither the
 * count nor the lock tells a stranger whether an address is registered — the
 * same reason a wrong password has never said which half was wrong.
 *
 * What is guarded is the password, so:
 *   - a locked address is refused before its password is compared at all — a
 *     right guess during the lock looks exactly like a wrong one;
 *   - a right password clears the count;
 *   - a NEW password ends the count and the lock (see passwordStamp): whoever
 *     set it proved who they are another way — the emailed code, the school
 *     office — and the guesses were aimed at a password that no longer exists;
 *   - sessions already open are untouched, and Google sign-in and one-time
 *     links are not password guesses, so a stranger who types five wrong
 *     passwords against a teacher's address cannot throw them out of the app.
 */
const crypto       = require('crypto');
const pool         = require('../db/pool');
const { newId }    = require('../db/schema');
const LoginAttempt = require('../models/LoginAttempt');
const identity     = require('./accountIdentity');

const MAX_FAILURES = 5;
const LOCK_HOURS   = 24;
const LOCK_SPAN    = `${LOCK_HOURS} hours`;

const T = `"${LoginAttempt.tableName}"`;

/**
 * A fingerprint of the password an address has now — '' when no account uses
 * it. The rows of one address normally share one hash; should they ever drift,
 * every hash goes in, so a change to any of them counts as a new password.
 */
function stampOf(rows) {
    const hashes = [...new Set((rows || []).map((r) => r.password).filter(Boolean))].sort();
    if (!hashes.length) return '';
    return crypto.createHash('sha256').update(hashes.join('\n')).digest('hex').slice(0, 32);
}

/** When this address's password sign-in opens again, or null when it is open now. */
async function lockedUntil(address, rows) {
    const { rows: hit } = await pool.query(
        `SELECT "lockedUntil" FROM ${T}
          WHERE "email" = $1 AND "lockedUntil" > now() AND "passwordStamp" = $2`,
        [address, stampOf(rows)],
    );
    return hit[0]?.lockedUntil || null;
}

// The count after this failure. An old count starts again from one: one whose
// lock has run out, one last added to over a day ago, or one typed against a
// password the address no longer has.
const NEXT_COUNT = `CASE WHEN a."lockedUntil" IS NOT NULL
                           OR a."lastFailedAt" IS NULL
                           OR a."lastFailedAt" <= now() - $3::interval
                           OR a."passwordStamp" IS DISTINCT FROM $4
                         THEN 1 ELSE a."failures" + 1 END`;
// A lock already in force stays exactly as it is — a failure that raced past
// the check neither adds to the count nor pushes the lock further out.
const LOCKED_NOW = `(a."lockedUntil" > now() AND a."passwordStamp" = $4)`;

/** One more wrong password against this address — one statement, so two at once both count. */
async function recordFailure(address, rows) {
    const { rows: [r] } = await pool.query(`
        INSERT INTO ${T} AS a ("_id", "email", "failures", "lastFailedAt", "lockedUntil", "passwordStamp")
        VALUES ($1::uuid, $2, 1, now(), CASE WHEN 1 >= $5::int THEN now() + $3::interval END, $4)
        ON CONFLICT ("email") DO UPDATE SET
            "failures"      = CASE WHEN ${LOCKED_NOW} THEN a."failures" ELSE ${NEXT_COUNT} END,
            "lockedUntil"   = CASE WHEN ${LOCKED_NOW} THEN a."lockedUntil"
                                   WHEN ${NEXT_COUNT} >= $5::int THEN now() + $3::interval END,
            "lastFailedAt"  = now(),
            "passwordStamp" = $4
        RETURNING "failures", "lockedUntil"`,
    [newId(), address, LOCK_SPAN, stampOf(rows), MAX_FAILURES]);
    return { failures: Math.min(Number(r.failures), MAX_FAILURES), lockedUntil: r.lockedUntil || null };
}

/** A right password: the count starts again. */
async function clear(address) {
    await pool.query(`DELETE FROM ${T} WHERE "email" = $1`, [address]);
}

/** Rows that no longer hold anything: no lock in force and no failure within the last day. */
async function prune() {
    const { rowCount } = await pool.query(
        `DELETE FROM ${T}
          WHERE ("lockedUntil" IS NULL OR "lockedUntil" <= now())
            AND ("lastFailedAt" IS NULL OR "lastFailedAt" <= now() - $1::interval)`,
        [LOCK_SPAN],
    );
    return rowCount;
}

// ── What the person is told ──────────────────────────────────────────────────

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "13 hours 20 minutes" — how long until `until`, never less than a minute. */
function waitText(until) {
    const mins = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (!h) return plural(m, 'minute');
    return m ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
}

/** The refusal while an address is locked: 423, with when it opens again. */
function lockedRefusal(until, { justNow = false } = {}) {
    const retryAfter = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 1000));
    const message = justNow
        ? `${MAX_FAILURES} wrong attempts — this account is locked for ${LOCK_HOURS} hours. Reset your password with “Forgot password?” to unlock it sooner.`
        : `This account is locked after ${MAX_FAILURES} wrong attempts. Try again in ${waitText(until)}, or reset your password with “Forgot password?” to unlock it now.`;
    return {
        status: 423,
        body: {
            code:        'ACCOUNT_LOCKED',
            message,
            lockedUntil: new Date(until).toISOString(),
            retryAfter,
            attempts:    { failed: MAX_FAILURES, max: MAX_FAILURES, left: 0, lockHours: LOCK_HOURS },
        },
    };
}

/** The refusal for a wrong password: 401 with the count, or the lock it has just set. */
function failureRefusal({ failures, lockedUntil: until }) {
    if (until) return lockedRefusal(until, { justNow: true });
    const left = MAX_FAILURES - failures;
    return {
        status: 401,
        body: {
            code:     'INVALID_CREDENTIALS',
            message:  `Invalid email or password. ${plural(left, 'attempt')} left before this account is locked for ${LOCK_HOURS} hours.`,
            attempts: { failed: failures, max: MAX_FAILURES, left, lockHours: LOCK_HOURS },
        },
    };
}

/**
 * The password check every sign-in door shares.
 *
 * Returns `{ opened }` — the membership rows this password opens, for the door
 * to decide what to do with — or `{ refusal }`: `{ status, body }` to send back
 * as it is (body carries `code`, `message`, `attempts`, and on a lock
 * `lockedUntil` + `retryAfter`).
 */
async function checkPassword(email, password) {
    const address = identity.normEmail(email);
    // No address is this long; storing a count for one would only be room for junk.
    if (address.length > 254) return { refusal: { status: 400, body: { message: 'Enter a valid email address' } } };

    const rows  = await identity.membershipsByEmail(address);
    const until = await lockedUntil(address, rows);
    if (until) return { refusal: lockedRefusal(until) };

    const opened = rows.length ? await identity.openedBy(rows, password) : [];
    if (!opened.length) return { refusal: failureRefusal(await recordFailure(address, rows)) };

    await clear(address);
    return { opened };
}

/** Send a refusal from checkPassword() as an Express response. */
function sendRefusal(res, { status, body }) {
    if (body.retryAfter) res.setHeader('Retry-After', String(body.retryAfter));
    return res.status(status).json({ success: false, ...body });
}

module.exports = {
    MAX_FAILURES,
    LOCK_HOURS,
    checkPassword,
    sendRefusal,
    prune,
    stampOf,
};
