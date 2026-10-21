'use strict';
/**
 * A check that a person, not a script, is filling a public portal form (Oct
 * 2026): creating an account, asking for a password reset, sending an
 * enquiry. Cloudflare Turnstile or hCaptcha, checked on the server
 * with the provider; the rate limits stay in front of it either way.
 *
 *   CAPTCHA_PROVIDER     turnstile | hcaptcha — off without it
 *   CAPTCHA_SITE_KEY     the public key the portal's widget uses
 *   CAPTCHA_SECRET       the secret the server checks answers with (never sent to a browser)
 *   CAPTCHA_VERIFY_URL   only to point the check somewhere else (a test)
 *
 * A school can switch it off for its own portal (Settings → Numbers & security).
 * When the provider cannot be reached the form is refused — a check that is
 * skipped whenever it fails would be no check.
 */
const { refuse } = require('./util');

const VERIFY = {
    turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    hcaptcha: 'https://api.hcaptcha.com/siteverify',
};

function config() {
    const provider = String(process.env.CAPTCHA_PROVIDER || '').trim().toLowerCase();
    const siteKey = String(process.env.CAPTCHA_SITE_KEY || '').trim();
    const secret = String(process.env.CAPTCHA_SECRET || '').trim();
    const known = !!VERIFY[provider];
    return { provider: known ? provider : '', siteKey, ready: known && !!siteKey && !!secret, verifyUrl: process.env.CAPTCHA_VERIFY_URL || VERIFY[provider] || '', secret };
}

/** What the portal's page needs to draw the widget — never the secret. */
function forPortal(settings) {
    const c = config();
    if (!c.ready || settings?.security?.captcha === false) return null;
    return { provider: c.provider, siteKey: c.siteKey };
}

/** Check the widget's answer. Refuses when it is missing, wrong or cannot be checked. */
async function verify(req, settings) {
    const c = config();
    if (!c.ready || settings?.security?.captcha === false) return { ok: true, skipped: true };
    const token = String(req.body?.captchaToken || '').trim();
    if (!token || token.length > 4096) refuse('Please complete the check that you are not a robot', 400, { code: 'CAPTCHA_REQUIRED', field: 'captcha' });
    let out;
    try {
        const body = new URLSearchParams({ secret: c.secret, response: token, ...(req.ip ? { remoteip: req.ip } : {}), ...(c.provider === 'hcaptcha' ? { sitekey: c.siteKey } : {}) });
        const r = await fetch(c.verifyUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(6000) });
        out = await r.json();
    } catch {
        refuse('The check that you are not a robot could not be done just now — please try again', 503, { code: 'CAPTCHA_UNAVAILABLE' });
    }
    if (!out?.success) refuse('The check that you are not a robot did not pass — please try it again', 400, { code: 'CAPTCHA_FAILED', field: 'captcha' });
    return { ok: true };
}

/** Express middleware for the public portal's forms (after access.publicPortal). */
function required(req, res, next) {
    verify(req, req.portal?.settings).then(() => next()).catch((e) => {
        res.status(e.status || 400).json({ success: false, message: e.message, code: e.code, field: e.field });
    });
}

module.exports = { config, forPortal, verify, required };
