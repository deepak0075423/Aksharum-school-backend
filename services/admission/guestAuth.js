'use strict';
/**
 * Applicant accounts on a school's admission portal.
 *
 * An applicant is a `guest` User — one membership of one school, exactly like
 * every other account (services/accountIdentity) — so they sign in, refresh,
 * reset and switch the way everyone does. What is particular to them:
 *
 *   - The account does not exist until the email is verified. Registering
 *     sends a code and parks the details (password hash included) on the code;
 *     verifying creates the account. An address nobody controls can never hold
 *     an account, and an unfinished sign-up blocks no one.
 *   - Every answer that could tell a stranger whether an address has an
 *     account is the same either way: registering, resending and "forgot
 *     password" always say "we sent a code". Only once the code proves the
 *     inbox is theirs is the person told about accounts behind it.
 *   - One address is one person. If it already signs in to Aksharum (a parent
 *     here, a teacher elsewhere), the applicant account joins that sign-in and
 *     keeps its password — a portal sign-up must not quietly change the
 *     password someone uses at another school. The one exception: an address
 *     whose password was never chosen (a first-login one-time password) takes
 *     the password just verified, as "Forgot password" would let them.
 *   - A student's address is never shared with another account (the rule in
 *     accountIdentity), so it cannot become an applicant account either.
 */
const bcrypt = require('bcryptjs');
const pool = require('../../db/pool');
const User = require('../../models/User');
const AdmissionApplicant = require('../../models/AdmissionApplicant');
const identity = require('../accountIdentity');
const lockout = require('../loginLockout');
const authCache = require('../../utils/authCache');
const { isEmail, isPhone, normalizePhone, passwordError } = require('../../utils/validators');
const { nameProblem } = require('../../utils/textRules');
const otp = require('./otp');
const mailer = require('./mailer');
const events = require('./events');
const { refuse, str } = require('./util');

const genericSent = (email, security) => ({
    message: `If ${email} can receive email, a 6-digit code is on its way. It is valid for ${security.otpExpiryMinutes} minutes.`,
    expiresInMinutes: security.otpExpiryMinutes,
    resendIn: security.otpResendSeconds,
});

function portalOpenFor(portal, action) {
    if (!portal?.live) refuse('Online admissions are not available for this school', 404, { code: 'PORTAL_OFF' });
    const status = portal.settings.portal.status;
    if (status === 'maintenance') refuse(portal.settings.portal.maintenanceMessage || 'The portal is being updated', 503, { code: 'PORTAL_MAINTENANCE' });
    if (action === 'register' && status !== 'open') refuse(portal.settings.portal.closedMessage || 'Registrations are closed', 403, { code: 'PORTAL_CLOSED' });
}

/** The guest membership this address holds at the portal's school, if any. */
const guestRowHere = (rows, schoolId) => rows.find((r) => r.role === 'guest' && String(r.school) === String(schoolId));

// ── Registering ──────────────────────────────────────────────────────────────

async function register(portal, body, { ip = '', source = '' } = {}) {
    portalOpenFor(portal, 'register');
    const schoolId = portal.school._id;
    const security = portal.settings.security;
    const name = str(body.name, 100);
    const email = str(body.email, 200).toLowerCase();
    const phone = normalizePhone(str(body.phone, 20));
    const password = String(body.password ?? '');

    if (!name) refuse('Your name is required', 400, { field: 'name' });
    const badName = nameProblem(name, 'Your name');
    if (badName) refuse(badName, 400, { field: 'name' });
    if (!isEmail(email)) refuse('Enter a valid email address', 400, { field: 'email' });
    if (!isPhone(phone)) refuse('Enter a valid 10-digit mobile number', 400, { field: 'phone' });
    const pwBad = passwordError(password);
    if (pwBad) refuse(pwBad, 400, { field: 'password' });
    if (body.consent !== true) refuse('Please agree to the privacy notice to continue', 400, { field: 'consent' });

    // Worked out now (the password is only in hand now) and kept with the code:
    // does this password already open the address? Nothing about it is said
    // until the code proves the inbox belongs to whoever typed it.
    const rows = await identity.membershipsByEmail(email);
    const matchesExisting = rows.length ? (await identity.openedBy(rows, password)).length > 0 : false;

    const issued = await otp.issue(schoolId, email, 'register', {
        security, ip,
        payload: {
            name, phone, passwordHash: await bcrypt.hash(password, 12), matchesExisting,
            consentVersion: portal.settings.portal.privacyVersion || 1, source: str(source, 60),
        },
    });
    if (issued.blocked) {
        refuse(issued.blocked.capped
            ? 'Too many codes have been sent to this address — please try again later'
            : `Please wait ${issued.blocked.retryAfter} seconds before asking for another code`,
        429, { code: 'OTP_COOLDOWN', retryAfter: issued.blocked.retryAfter });
    }
    undeliverable(await mailer.send(schoolId, 'email_otp', {
        to: email, values: { applicant_name: name, otp: issued.code, otp_expiry_minutes: String(security.otpExpiryMinutes) },
    }));
    return genericSent(email, security);
}

/**
 * The code could not go because the address is on the do-not-send list (it
 * bounced). Registering, the person is giving their own address, so saying so
 * tells them nothing about anyone else — and saves a wait for an email that
 * will never come.
 */
function undeliverable(result) {
    if (result?.status === 'skipped' && /do-not-send list/.test(result.error || '')) {
        refuse('Email to this address has bounced before, so we cannot send the code. Please use another email address, or contact the admission office.', 409, { code: 'EMAIL_UNDELIVERABLE', field: 'email' });
    }
}

/** Ask for another registration code — the details stay as they were given. */
async function resendRegistration(portal, body, { ip = '' } = {}) {
    portalOpenFor(portal, 'register');
    const schoolId = portal.school._id;
    const security = portal.settings.security;
    const email = str(body.email, 200).toLowerCase();
    if (!isEmail(email)) refuse('Enter a valid email address', 400, { field: 'email' });
    // The details wait on the last code; without one there is nothing to resend
    // — the same answer either way, so this says nothing about the address.
    const { rows } = await pool.query(
        `SELECT "payload" FROM "admissionotps" WHERE "school" = $1 AND "email" = $2 AND "purpose" = 'register'
          AND "consumedAt" IS NULL AND "createdAt" > now() - interval '1 day' ORDER BY "createdAt" DESC LIMIT 1`,
        [String(schoolId), email]);
    if (!rows[0]?.payload) return genericSent(email, security);
    const issued = await otp.issue(schoolId, email, 'register', { security, ip, payload: rows[0].payload });
    if (issued.blocked) {
        refuse(`Please wait ${issued.blocked.retryAfter} seconds before asking for another code`, 429, { code: 'OTP_COOLDOWN', retryAfter: issued.blocked.retryAfter });
    }
    undeliverable(await mailer.send(schoolId, 'email_otp', {
        to: email, values: { applicant_name: rows[0].payload.name, otp: issued.code, otp_expiry_minutes: String(security.otpExpiryMinutes) },
    }));
    return genericSent(email, security);
}

/**
 * Verify the code and open the account. Returns
 *   { status: 'created', row }   a new sign-in — the caller starts a session
 *   { status: 'linked', row, session: bool, message }
 *                                joined an existing sign-in; a session only
 *                                when the password typed is that sign-in's
 *   { status: 'exists', message } already an applicant here — sign in
 */
async function verifyRegistration(portal, body) {
    portalOpenFor(portal, 'verify');
    const schoolId = portal.school._id;
    const email = str(body.email, 200).toLowerCase();
    if (!isEmail(email)) refuse('Enter a valid email address', 400, { field: 'email' });
    const code = await otp.verify(schoolId, email, 'register', body.code);
    const p = code.payload || {};

    const rows = await identity.membershipsByEmail(email);
    const here = guestRowHere(rows, schoolId);
    if (here) {
        return { status: 'exists', message: `You already have an applicant account with ${portal.school.name}. Sign in with your password — or reset it if you have forgotten it.` };
    }
    if (rows.some((r) => r.role === 'super_admin')) refuse('This email belongs to a platform administrator and cannot be used for an applicant account', 400, { field: 'email' });
    if (rows.some((r) => r.role === 'student')) {
        refuse('This email is used by a student\'s school account, which cannot be shared. Please register with a different email — a parent\'s, for example.', 400, { field: 'email', code: 'STUDENT_EMAIL' });
    }

    let credentials;
    let linked = false;
    let session = true;
    if (!rows.length) {
        credentials = { password: p.passwordHash, isFirstLogin: false };
    } else {
        linked = true;
        const donor = rows.find((r) => r.password) || rows[0];
        if (donor.isFirstLogin) {
            // Nobody ever chose this address's password; its owner just did.
            await identity.setCredentials(email, { passwordHash: p.passwordHash, isFirstLogin: false });
            credentials = { password: p.passwordHash, isFirstLogin: false };
        } else {
            credentials = { password: donor.password, isFirstLogin: false };
            session = !!p.matchesExisting;
        }
    }

    let user;
    try {
        user = await User.create({
            name: p.name, email, phone: p.phone || '', role: 'guest', school: schoolId,
            ...credentials, isActive: true,
        });
    } catch (e) {
        if (e.code === 11000) return { status: 'exists', message: `You already have an applicant account with ${portal.school.name}. Sign in with your password.` };
        throw e;
    }
    await AdmissionApplicant.create({
        school: schoolId, user: user._id, phone: p.phone || '', verifiedAt: new Date(),
        consentAt: new Date(), consentVersion: p.consentVersion || 1, source: p.source || '', linkedExisting: linked,
    });
    events.recordQuietly(schoolId, {
        by: { _id: user._id, name: user.name, role: 'guest' }, type: 'account', action: linked ? 'registered_linked' : 'registered',
        message: `${user.name} created an applicant account${linked ? ' (joined an existing Aksharum sign-in)' : ''}`,
    });
    mailer.sendLater(schoolId, 'guest_registration', { to: email, recipient: user._id, values: { applicant_name: user.name } });
    // An open enquiry from the same email or mobile now has its account (services/admission/crm.js).
    require('./crm').linkRegistration(schoolId, { _id: user._id, email, phone: p.phone || '' }).catch(() => {});

    const row = { _id: user._id, email, password: credentials.password };
    if (!linked) return { status: 'created', row };
    return {
        status: 'linked', row, session,
        message: session
            ? 'Your email already signs in to Aksharum, so your applicant account uses the same sign-in.'
            : 'Your email already signs in to Aksharum. Your applicant account uses that same password — sign in with it, or reset it if you have forgotten it.',
    };
}

// ── Signing in ───────────────────────────────────────────────────────────────

/**
 * The applicant membership at this portal's school that this email and
 * password open. Refusals never say whether the address exists — unless the
 * password was right, in which case the person already knows.
 */
async function login(portal, body) {
    portalOpenFor(portal, 'login');
    const email = str(body.email, 200).toLowerCase();
    const password = String(body.password ?? '');
    if (!isEmail(email) || !password) refuse('Enter your email and password', 400);
    // The same count as the main sign-in page: it is the address's one password
    // either way, so five wrong guesses here lock it there too (services/loginLockout).
    const { opened, refusal } = await lockout.checkPassword(email, password);
    if (refusal) refuse(refusal.body.message, refusal.status, refusal.body);
    const here = guestRowHere(opened, portal.school._id);
    if (!here) {
        refuse(`This email has no applicant account with ${portal.school.name} yet. Create one to apply — you can keep the same password.`, 403, { code: 'NO_APPLICANT_ACCOUNT' });
    }
    if (!here.isActive) refuse('This applicant account has been switched off. Please contact the admission office.', 403, { code: 'ACCOUNT_DISABLED' });
    await AdmissionApplicant.updateOne({ user: here._id }, { $set: { lastLoginAt: new Date() } }).catch(() => {});
    return here;
}

// ── Forgotten password ───────────────────────────────────────────────────────

async function forgot(portal, body, { ip = '' } = {}) {
    portalOpenFor(portal, 'forgot');
    const schoolId = portal.school._id;
    const security = portal.settings.security;
    const email = str(body.email, 200).toLowerCase();
    if (!isEmail(email)) refuse('Enter a valid email address', 400, { field: 'email' });
    const answer = genericSent(email, security);
    const rows = await identity.membershipsByEmail(email);
    const here = guestRowHere(rows, schoolId);
    if (!here || !here.isActive) return answer;
    const issued = await otp.issue(schoolId, email, 'reset', { security, ip });
    // Waiting is not announced either: it would say the address has an account.
    if (issued.blocked) return answer;
    await mailer.send(schoolId, 'password_reset', {
        to: email, recipient: here._id, values: { applicant_name: here.name, otp: issued.code, otp_expiry_minutes: String(security.otpExpiryMinutes) },
    });
    return answer;
}

/**
 * Set a new password with a reset code. The password is the address's — every
 * Aksharum sign-in on this email changes with it, as with "Forgot password" on
 * the main sign-in page.
 */
async function reset(portal, body) {
    portalOpenFor(portal, 'reset');
    const schoolId = portal.school._id;
    const email = str(body.email, 200).toLowerCase();
    if (!isEmail(email)) refuse('Enter a valid email address', 400, { field: 'email' });
    const pwBad = passwordError(body.password);
    if (pwBad) refuse(pwBad, 400, { field: 'password' });
    await otp.verify(schoolId, email, 'reset', body.code);
    const rows = await identity.membershipsByEmail(email);
    const here = guestRowHere(rows, schoolId);
    if (!here) refuse('That code is not valid any more — ask for a new one', 400, { field: 'code' });
    const hash = await bcrypt.hash(String(body.password), 12);
    await identity.setCredentials(email, { passwordHash: hash, isFirstLogin: false, extra: { resetToken: null, resetTokenExpiry: null } });
    events.recordQuietly(schoolId, { by: { _id: here._id, name: here.name, role: 'guest' }, type: 'account', action: 'password_reset', message: `${here.name} reset their password` });
    await authCache.invalidate(String(here._id)).catch(() => {});
    return { ...here, password: hash };
}

module.exports = { register, resendRegistration, verifyRegistration, login, forgot, reset, portalOpenFor, guestRowHere };
