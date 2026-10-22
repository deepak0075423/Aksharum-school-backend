'use strict';
/**
 * How often a password-reset code may be emailed to one address.
 *
 *   - 60 seconds between codes, so a second click is not a second email;
 *   - three codes in a row at most — the third starts a 24-hour wait, after
 *     which the address has three again. A day without asking starts the count
 *     afresh too, and so does a completed reset.
 *
 * Counted per ADDRESS: the reset is the address's one password (services/
 * accountIdentity), whichever of its accounts the person is thinking of. Each
 * request claims its send in one statement, so two clicks at once cannot both
 * get through — and the claim comes BEFORE the email: if the email then fails,
 * the send is handed back, because a code nobody received must not use up one
 * of the three.
 */
const crypto  = require('crypto');
const pool    = require('../db/pool');
const { newId } = require('../db/schema');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const identity = require('./accountIdentity');
const { waitText } = require('./loginLockout');

const RESEND_SECONDS = 60;
const MAX_SENDS      = 3;
const WAIT_HOURS     = 24;

const T = `"${PasswordResetRequest.tableName}"`;

// The last run is over — the third code's day has passed, or a day has gone by
// without a code being asked for. Either way the address starts again at one.
const RUN_OVER = `(a."lastSentAt" IS NULL OR a."lastSentAt" <= now() - $3::interval)`;

/**
 * Take one send for this address, or be told to wait.
 *
 * Returns `{ ok: true, address, claimId, resendIn, sendsLeft, maxSends, availableAt }`
 * (`availableAt` set once this was the last of the three), or
 * `{ ok: false, limited, retryAfter, availableAt, sendsLeft }` — `limited` when
 * all three are used (a day's wait), otherwise the 60-second gap.
 */
async function claim(email) {
    const address = identity.normEmail(email);
    const claimId = crypto.randomUUID();
    const { rows: [won] } = await pool.query(`
        INSERT INTO ${T} AS a ("_id", "email", "sends", "lastSentAt", "prevSentAt", "claimId")
        VALUES ($1::uuid, $2, 1, now(), NULL, $6)
        ON CONFLICT ("email") DO UPDATE SET
            "sends"      = CASE WHEN ${RUN_OVER} THEN 1 ELSE a."sends" + 1 END,
            "prevSentAt" = a."lastSentAt",
            "lastSentAt" = now(),
            "claimId"    = $6
         WHERE ${RUN_OVER}
            OR (a."sends" < $4::int AND a."lastSentAt" <= now() - $5::interval)
        RETURNING "sends", "lastSentAt" + $3::interval AS "dayEndsAt"`,
    [newId(), address, `${WAIT_HOURS} hours`, MAX_SENDS, `${RESEND_SECONDS} seconds`, claimId]);
    if (won) {
        const sendsLeft = MAX_SENDS - Number(won.sends);
        return {
            ok: true, address, claimId,
            resendIn: RESEND_SECONDS, sendsLeft, maxSends: MAX_SENDS,
            availableAt: sendsLeft > 0 ? null : won.dayEndsAt,
        };
    }
    // Refused: which wait applies, and until when — worked out by the database
    // clock that made the decision, not this server's.
    const { rows: [row] } = await pool.query(`
        SELECT "sends", w."at" AS "availableAt", GREATEST(1, CEIL(EXTRACT(EPOCH FROM w."at" - now())))::int AS "retryAfter"
          FROM ${T},
               LATERAL (SELECT "lastSentAt" + CASE WHEN "sends" >= $2::int THEN $3::interval ELSE $4::interval END AS "at") w
         WHERE "email" = $1`,
    [address, MAX_SENDS, `${WAIT_HOURS} hours`, `${RESEND_SECONDS} seconds`]);
    if (!row) return { ok: false, limited: false, retryAfter: RESEND_SECONDS, availableAt: null, sendsLeft: MAX_SENDS };
    const limited = Number(row.sends) >= MAX_SENDS;
    return {
        ok: false, limited,
        retryAfter: row.retryAfter,
        availableAt: row.availableAt,
        sendsLeft: Math.max(0, MAX_SENDS - Number(row.sends)),
    };
}

/** The email for a claimed send could not go out: hand the send back. */
async function release({ address, claimId }) {
    await pool.query(
        `UPDATE ${T} SET "sends" = GREATEST("sends" - 1, 0), "lastSentAt" = "prevSentAt", "claimId" = ''
          WHERE "email" = $1 AND "claimId" = $2`,
        [address, claimId],
    );
}

/** The password was reset: the address starts again with three. */
async function clear(email) {
    await pool.query(`DELETE FROM ${T} WHERE "email" = $1`, [identity.normEmail(email)]);
}

/** A refused claim as `{ status, body }` — 429 either way, with how long to wait. */
function refusal(r) {
    if (r.limited) {
        return {
            status: 429,
            body: {
                code:        'OTP_LIMIT',
                message:     `You have already asked for ${MAX_SENDS} codes. You can ask for a new one in ${waitText(r.availableAt)}.`,
                retryAfter:  r.retryAfter,
                availableAt: r.availableAt ? new Date(r.availableAt).toISOString() : null,
                sendsLeft:   0,
                maxSends:    MAX_SENDS,
            },
        };
    }
    return {
        status: 429,
        body: {
            code:       'OTP_WAIT',
            message:    `Please wait ${r.retryAfter} second${r.retryAfter === 1 ? '' : 's'} before asking for a new code.`,
            retryAfter: r.retryAfter,
            sendsLeft:  r.sendsLeft,
            maxSends:   MAX_SENDS,
        },
    };
}

module.exports = { RESEND_SECONDS, MAX_SENDS, WAIT_HOURS, claim, release, clear, refusal };
