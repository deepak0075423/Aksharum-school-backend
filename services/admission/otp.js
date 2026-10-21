'use strict';
/**
 * One-time codes for the admission portal: verifying a new applicant's email
 * and resetting a password.
 *
 * The code is generated and judged here, by the server, and nowhere else —
 * email templates can show it but cannot change how long it lasts or how many
 * guesses it allows. Only a keyed hash is stored (keyed with a secret derived
 * from JWT_SECRET, so a copy of the table does not reveal codes), compared in
 * constant time.
 *
 *   - each code: one use, `otpMaxAttempts` wrong guesses, `otpExpiryMinutes`
 *   - a new code invalidates the last, and cannot be sent again within
 *     `otpResendSeconds`, nor more than `otpMaxSendsPerHour` times an hour
 *   - a guess is counted BEFORE it is judged (one UPDATE … RETURNING), and a
 *     right one is spent with a compare-and-set, so two requests can neither
 *     both guess past the limit nor both spend the same code
 */
const crypto = require('crypto');
const pool = require('../../db/pool');
const AdmissionOtp = require('../../models/AdmissionOtp');
const { buildInsert } = require('../dbTx');
const { refuse } = require('./util');

const T = `"${AdmissionOtp.tableName}"`;
const key = () => crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('aksharum:admission-otp:v1').digest();
const hashOf = (schoolId, email, purpose, code) =>
    crypto.createHmac('sha256', key()).update(`${schoolId}|${String(email).toLowerCase()}|${purpose}|${code}`).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/**
 * When the next code may be sent, given the last few: { ok } or { ok: false, retryAfter }.
 */
async function sendWindow(schoolId, email, purpose, security) {
    const { rows } = await pool.query(
        `SELECT "createdAt" FROM ${T} WHERE "school" = $1 AND "email" = $2 AND "purpose" = $3 AND "createdAt" > now() - interval '1 hour'
          ORDER BY "createdAt" DESC`,
        [String(schoolId), String(email).toLowerCase(), purpose],
    );
    if (rows.length) {
        const since = (Date.now() - new Date(rows[0].createdAt).getTime()) / 1000;
        if (since < security.otpResendSeconds) return { ok: false, retryAfter: Math.ceil(security.otpResendSeconds - since) };
    }
    if (rows.length >= security.otpMaxSendsPerHour) {
        const oldest = new Date(rows[rows.length - 1].createdAt).getTime();
        return { ok: false, retryAfter: Math.max(60, Math.ceil((oldest + 3600 * 1000 - Date.now()) / 1000)), capped: true };
    }
    return { ok: true };
}

/**
 * Issue a code. Returns { code, expiresAt } — the caller emails it — or
 * { blocked: { retryAfter } } when the address must wait.
 */
async function issue(schoolId, email, purpose, { security, payload = null, ip = '' }) {
    const address = String(email).trim().toLowerCase();
    const window = await sendWindow(schoolId, address, purpose, security);
    if (!window.ok) return { blocked: window };
    await pool.query(
        `UPDATE ${T} SET "invalidatedAt" = now()
          WHERE "school" = $1 AND "email" = $2 AND "purpose" = $3 AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL`,
        [String(schoolId), address, purpose],
    );
    const code = newCode();
    const expiresAt = new Date(Date.now() + security.otpExpiryMinutes * 60 * 1000);
    const { sql, params } = buildInsert(AdmissionOtp, {
        school: schoolId, email: address, purpose, codeHash: hashOf(schoolId, address, purpose, code),
        expiresAt, maxAttempts: security.otpMaxAttempts, payload, ip: String(ip || '').slice(0, 64),
    });
    await pool.query(sql, params);
    return { code, expiresAt };
}

/**
 * Judge a code. Returns the code's row (with its payload) when it is right,
 * and spends it; otherwise refuses with a message that says only what the
 * person can act on.
 */
async function verify(schoolId, email, purpose, code) {
    const address = String(email || '').trim().toLowerCase();
    const given = String(code || '').trim();
    if (!/^\d{6}$/.test(given)) refuse('Enter the 6-digit code from the email', 400, { field: 'code' });
    // Count the guess first — atomically — on the live code, if any.
    const { rows } = await pool.query(
        `UPDATE ${T} SET "attempts" = "attempts" + 1
          WHERE "_id" = (SELECT "_id" FROM ${T}
                          WHERE "school" = $1 AND "email" = $2 AND "purpose" = $3
                            AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL
                          ORDER BY "createdAt" DESC LIMIT 1)
          RETURNING *`,
        [String(schoolId), address, purpose],
    );
    const row = rows[0];
    if (!row) refuse('That code is not valid any more — ask for a new one', 400, { field: 'code', code: 'OTP_INVALID' });
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
        await pool.query(`UPDATE ${T} SET "invalidatedAt" = now() WHERE "_id" = $1`, [row._id]);
        refuse('That code has expired — ask for a new one', 400, { field: 'code', code: 'OTP_EXPIRED' });
    }
    if (row.attempts > row.maxAttempts) {
        await pool.query(`UPDATE ${T} SET "invalidatedAt" = now() WHERE "_id" = $1`, [row._id]);
        refuse('Too many wrong codes — ask for a new one', 429, { field: 'code', code: 'OTP_LOCKED' });
    }
    const expected = Buffer.from(row.codeHash, 'hex');
    const actual = Buffer.from(hashOf(schoolId, address, purpose, given), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        const left = row.maxAttempts - row.attempts;
        if (left <= 0) await pool.query(`UPDATE ${T} SET "invalidatedAt" = now() WHERE "_id" = $1`, [row._id]);
        refuse(left > 0 ? `That code is not right — ${left} ${left === 1 ? 'try' : 'tries'} left` : 'Too many wrong codes — ask for a new one',
            left > 0 ? 400 : 429, { field: 'code', code: left > 0 ? 'OTP_WRONG' : 'OTP_LOCKED', attemptsLeft: Math.max(0, left) });
    }
    // Spend it — once, even if two requests arrive with it together.
    const spent = await pool.query(`UPDATE ${T} SET "consumedAt" = now() WHERE "_id" = $1 AND "consumedAt" IS NULL RETURNING "_id"`, [row._id]);
    if (!spent.rowCount) refuse('That code has already been used', 400, { field: 'code', code: 'OTP_USED' });
    return row;
}

module.exports = { issue, verify, sendWindow, hashOf };
