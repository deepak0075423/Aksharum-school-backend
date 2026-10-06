'use strict';
/**
 * "Confirm it is you" for the medical staff (Oct 2026), when the school turns
 * it on (settings.requireStepUp, off by default). Before the staff pages of the
 * Medical Room answer, a code emailed to the person's own address is asked
 * for, once every twelve hours on each browser or phone.
 *
 *   send     a six-digit code by email (only its hash is kept; 10 minutes, 5 tries;
 *            a new one at most once a minute)
 *   verify   the code → a step-up token (12 h), sent back on medical requests as
 *            the X-Medical-Step-Up header
 *   guard    the middleware: lets a request through when step-up is off, or the
 *            token is good for this person and school; else 403 MEDICAL_STEP_UP
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { insert, patch } = require('../db/patch');
const MedicalStepUp = require('../models/MedicalStepUp');
const settingsSvc = require('./medicalSettings');
const audit = require('./medicalAudit');
const R = require('./medicalRules');

const { refuse } = R;
const S = (v) => String(v);
const PURPOSE = 'medical-stepup';
const key = () => crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('aksharum:medical-stepup:v1').digest();
const hash = (code) => crypto.createHmac('sha256', key()).update(String(code)).digest('hex');

function tokenFor(req) {
    return jwt.sign({ sub: S(req.userId), school: S(req.schoolId), purpose: PURPOSE }, key(), { expiresIn: '12h' });
}

function tokenOk(req, token) {
    if (!token) return false;
    try {
        const p = jwt.verify(String(token), key());
        return p.purpose === PURPOSE && p.sub === S(req.userId) && p.school === S(req.schoolId);
    } catch { return false; }
}

/** A new code for this person. Returns the code (for the mailer — never sent back to the client). */
async function issue(req) {
    const { rows } = await pool.query(
        `SELECT "createdAt" FROM "medicalstepups" WHERE "user" = $1 AND "school" = $2 ORDER BY "createdAt" DESC LIMIT 1`,
        [S(req.userId), S(req.schoolId)],
    );
    if (rows[0] && Date.now() - new Date(rows[0].createdAt).getTime() < 60000) refuse('A code was sent less than a minute ago — check your email', 429, 'MEDICAL_STEP_UP_WAIT');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await insert(MedicalStepUp, { school: req.schoolId, user: req.userId, codeHash: hash(code), expiresAt: new Date(Date.now() + 10 * 60000) });
    return code;
}

/** `force`: a school admin proving the school's email works before turning this on. */
async function send(req, { force = false } = {}) {
    const s = await settingsSvc.get(req.schoolId);
    if (!s.requireStepUp && !force) return { required: false };
    const [u] = (await pool.query(`SELECT "email", "name" FROM "users" WHERE "_id" = $1`, [S(req.userId)])).rows;
    if (!u?.email) refuse('Your account has no email address — ask the school admin', 409, 'MEDICAL_STEP_UP_NO_EMAIL');
    const code = await issue(req);
    const { sendSchoolMail } = require('../utils/schoolMailer');
    const sent = await sendSchoolMail(req.schoolId, {
        to: u.email, subject: `Your Medical Room code: ${code}`,
        html: `<p>Hello ${u.name || ''},</p><p>Your code to open the Medical Room's records is <b style="font-size:20px;letter-spacing:3px">${code}</b>.</p><p>It works for 10 minutes. If you did not ask for it, tell the school admin.</p>`,
    });
    if (!sent) refuse('The code could not be emailed — the school\'s email may not be set up. Ask the school admin.', 502, 'MEDICAL_STEP_UP_MAIL');
    audit.log(req, { action: 'step_up_sent', entity: 'access', summary: `A sign-in code was emailed to ${who(u)}` });
    const at = u.email.indexOf('@');
    return { required: true, sentTo: at > 1 ? `${u.email[0]}${'•'.repeat(Math.max(1, at - 2))}${u.email.slice(at - 1)}` : u.email };
}
const who = (u) => u?.name || 'a member of staff';

async function verify(req, body = {}) {
    const code = String(body.code || '').replace(/\D/g, '');
    if (code.length !== 6) refuse('Enter the six-digit code from the email');
    const { rows } = await pool.query(
        `SELECT * FROM "medicalstepups" WHERE "user" = $1 AND "school" = $2 AND "usedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`,
        [S(req.userId), S(req.schoolId)],
    );
    const row = rows[0];
    if (!row || new Date(row.expiresAt) < new Date()) refuse('That code has expired — ask for a new one', 400, 'MEDICAL_STEP_UP_EXPIRED');
    if (row.attempts >= 5) refuse('Too many tries — ask for a new code', 429, 'MEDICAL_STEP_UP_LOCKED');
    if (hash(code) !== row.codeHash) {
        await pool.query(`UPDATE "medicalstepups" SET "attempts" = "attempts" + 1 WHERE "_id" = $1`, [row._id]);
        audit.log(req, { action: 'step_up_failed', entity: 'access', summary: 'A wrong sign-in code was entered' });
        refuse('That code is not right', 400, 'MEDICAL_STEP_UP_WRONG');
    }
    await patch(MedicalStepUp, row._id, { usedAt: new Date() }, { touch: false });
    audit.log(req, { action: 'step_up_passed', entity: 'access', summary: 'Confirmed with an emailed code' });
    return { token: tokenFor(req), expiresIn: 12 * 3600 };
}

/** The middleware for the staff routes. */
function guard(req, res, next) {
    settingsSvc.get(req.schoolId).then((s) => {
        if (!s.requireStepUp || tokenOk(req, req.headers['x-medical-step-up'])) return next();
        return res.status(403).json({ success: false, code: 'MEDICAL_STEP_UP', message: 'Confirm it is you: a code will be emailed to you' });
    }).catch(next);
}

module.exports = { send, verify, guard, issue, tokenOk, tokenFor };
