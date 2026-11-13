'use strict';
/**
 * Video Learning — provider credentials, sealed before they are stored.
 *
 * AES-256-GCM, the key derived from VIDEO_SECRETS_KEY (or, when that is not
 * set, from JWT_SECRET — the same arrangement services/admission/digilocker
 * uses for its access tokens). A sealed value is only ever opened inside the
 * provider code that needs it; it is never sent to a browser.
 */
const crypto = require('crypto');

const key = () => crypto.createHash('sha256')
    .update(`aksharum-video|${process.env.VIDEO_SECRETS_KEY || process.env.JWT_SECRET || ''}`).digest();

function seal(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

/** The sealed value opened, or '' when it cannot be (wrong key, damaged). */
function open(sealed) {
    try {
        const [iv, tag, body] = String(sealed || '').split('.').map((p) => Buffer.from(p || '', 'base64url'));
        if (!iv?.length || !tag?.length) return '';
        const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(body), d.final()]).toString('utf8');
    } catch { return ''; }
}

module.exports = { seal, open };
