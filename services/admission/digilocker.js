'use strict';
/**
 * DigiLocker (Oct 2026): a family fetches documents issued to them — a birth
 * certificate from the municipal body, a mark sheet from a board, a transfer
 * certificate — straight from DigiLocker into an application, instead of
 * scanning paper. The issuer is recorded on the document; the office sees it.
 *
 * Needs the platform to be a DigiLocker partner (MeriPehchaan OAuth 2.0 with
 * PKCE). Off unless all of these are set:
 *
 *   DIGILOCKER_CLIENT_ID, DIGILOCKER_CLIENT_SECRET
 *   DIGILOCKER_REDIRECT_URI   https://<api host>/api/admission/digilocker/callback
 *   DIGILOCKER_BASE_URL       default https://digilocker.meripehchaan.gov.in/public/oauth2
 *
 * What it never does: decide anything. A fetched document goes through the
 * same checks as an upload (type, size, real file, virus scan); it is marked
 * verified at once only where the school switched that on (Settings → Applications
 * → DigiLocker) — a written, visible rule. The account's date of birth is set
 * beside the student's for the office to see, not to judge.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../../db/pool');
const { buildInsert } = require('../dbTx');
const AdmissionDigilockerSession = require('../../models/AdmissionDigilockerSession');
const settingsSvc = require('./settings');
const events = require('./events');
const { refuse } = require('./util');

const SESSION_MINUTES = 30;
const MAX_BYTES = 10 * 1024 * 1024;

function config() {
    const c = {
        clientId: String(process.env.DIGILOCKER_CLIENT_ID || '').trim(),
        secret: String(process.env.DIGILOCKER_CLIENT_SECRET || '').trim(),
        redirectUri: String(process.env.DIGILOCKER_REDIRECT_URI || '').trim(),
        base: String(process.env.DIGILOCKER_BASE_URL || 'https://digilocker.meripehchaan.gov.in/public/oauth2').replace(/\/+$/, ''),
    };
    c.ready = !!(c.clientId && c.secret && /^https?:\/\//.test(c.redirectUri));
    return c;
}

async function available(schoolId) {
    if (!config().ready) return false;
    const s = await settingsSvc.getSettings(schoolId);
    return s.digilocker?.enabled !== false;
}

// ── The access token, encrypted at rest ──────────────────────────────────────
const key = () => crypto.createHash('sha256').update(`aksharum-digilocker|${process.env.JWT_SECRET || ''}`).digest();
function seal(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}
function open(sealed) {
    const [iv, tag, body] = String(sealed || '').split('.').map((p) => Buffer.from(p || '', 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

/** DDMMYYYY (DigiLocker's way) or YYYY-MM-DD → YYYY-MM-DD, or ''. */
function isoDob(v) {
    const t = String(v || '').trim();
    if (/^\d{8}$/.test(t)) return `${t.slice(4, 8)}-${t.slice(2, 4)}-${t.slice(0, 2)}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
    if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(t)) return `${t.slice(6, 10)}-${t.slice(3, 5)}-${t.slice(0, 2)}`;
    return '';
}

// ── Connecting ───────────────────────────────────────────────────────────────

/** Start: a state and a PKCE pair for this application; the address to send the family to. */
async function start(req, app) {
    const c = config();
    if (!(await available(app.school))) refuse('DigiLocker is not available on this portal', 409, { code: 'DIGILOCKER_OFF' });
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    await pool.query(`UPDATE "admissiondigilockersessions" SET "status" = 'ended', "token" = '', "updatedAt" = now() WHERE "application" = $1 AND "status" IN ('started', 'connected')`, [String(app._id)]);
    const { sql, params } = buildInsert(AdmissionDigilockerSession, {
        school: app.school, application: app._id, applicant: req.userId, state, codeVerifier: verifier, status: 'started',
        expiresAt: new Date(Date.now() + SESSION_MINUTES * 60000),
    });
    await pool.query(sql, params);
    const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' });
    return { url: `${c.base}/1/authorize?${q}` };
}

async function call(url, opts = {}) {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
        let msg = `DigiLocker answered ${r.status}`;
        try { const j = await r.json(); msg = j.error_description || j.error || msg; } catch { /* not json */ }
        throw new Error(msg);
    }
    return r;
}

/**
 * DigiLocker sends the family back here with a code (or an error). The code is
 * swapped for a token; the account and the list of issued documents are read.
 * Returns where to send the browser next — the application's page.
 */
async function callback({ code, state, error }) {
    const c = config();
    const { rows: [s] } = await pool.query(`SELECT * FROM "admissiondigilockersessions" WHERE "state" = $1`, [String(state || '')]);
    const back = async (ok) => {
        if (!s) return `${String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/`;
        const st = await settingsSvc.getSettings(s.school);
        return `${String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/${st.slug}/applications/${s.application}?digilocker=${ok ? 'connected' : 'failed'}`;
    };
    if (!s || s.status !== 'started' || new Date(s.expiresAt) < new Date()) return back(false);
    const fail = async (why) => {
        await pool.query(`UPDATE "admissiondigilockersessions" SET "status" = 'failed', "error" = $2, "codeVerifier" = '', "updatedAt" = now() WHERE "_id" = $1`, [s._id, String(why).slice(0, 300)]);
        return back(false);
    };
    if (error || !code) return fail(error || 'No code came back');
    try {
        const tok = await (await call(`${c.base}/1/token`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code), client_id: c.clientId, client_secret: c.secret, redirect_uri: c.redirectUri, code_verifier: s.codeVerifier }),
        })).json();
        if (!tok.access_token) return fail('No access token');
        const auth = { Authorization: `Bearer ${tok.access_token}` };
        const user = tok.name ? tok : await (await call(`${c.base}/1/user`, { headers: auth })).json().catch(() => ({}));
        const list = await (await call(`${c.base}/2/files/issued`, { headers: auth })).json();
        const files = (Array.isArray(list?.items) ? list.items : []).filter((f) => f && f.uri && f.type !== 'dir').slice(0, 100).map((f) => ({
            uri: String(f.uri).slice(0, 300), name: String(f.name || f.description || f.doctype || 'Document').slice(0, 160), doctype: String(f.doctype || '').slice(0, 40),
            issuer: String(f.issuer || '').slice(0, 160), date: String(f.date || '').slice(0, 30), mime: Array.isArray(f.mime) ? f.mime.join(',') : String(f.mime || ''), size: Number(f.size) || 0,
        }));
        const account = {
            name: String(user.name || '').slice(0, 120), dob: isoDob(user.dob), gender: String(user.gender || '').slice(0, 10),
            idHash: user.digilockerid ? crypto.createHash('sha256').update(String(user.digilockerid)).digest('hex').slice(0, 32) : '',
        };
        await pool.query(
            `UPDATE "admissiondigilockersessions" SET "status" = 'connected', "token" = $2, "account" = $3::jsonb, "files" = $4::jsonb, "codeVerifier" = '', "updatedAt" = now() WHERE "_id" = $1`,
            [s._id, seal(tok.access_token), JSON.stringify(account), JSON.stringify(files)]);
        events.recordQuietly(s.school, { application: s.application, by: { _id: s.applicant, role: 'guest' }, type: 'document', action: 'digilocker_connected', message: `DigiLocker connected — ${files.length} issued document(s) found`, visibility: 'applicant' });
        return back(true);
    } catch (e) {
        return fail(e.message);
    }
}

/** The live session of an application, if any (an expired one is ended on the way). */
async function sessionOf(app) {
    const { rows: [s] } = await pool.query(`SELECT * FROM "admissiondigilockersessions" WHERE "application" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [String(app._id)]);
    if (s && s.status === 'connected' && new Date(s.expiresAt) < new Date()) {
        await pool.query(`UPDATE "admissiondigilockersessions" SET "status" = 'ended', "token" = '', "updatedAt" = now() WHERE "_id" = $1`, [s._id]);
        return { ...s, status: 'ended', token: '' };
    }
    return s || null;
}

/** For the family's page: whether it can be used, and the locker's documents. */
async function view(app) {
    const on = await available(app.school);
    const s = on ? await sessionOf(app) : null;
    const dob = app.studentDob ? new Date(app.studentDob).toISOString().slice(0, 10) : '';
    return {
        available: on,
        status: s?.status || null,
        error: s?.status === 'failed' ? 'DigiLocker could not be connected — try again' : '',
        account: s?.status === 'connected' ? { name: s.account?.name, dobMatchesStudent: !!(s.account?.dob && dob && s.account.dob === dob) } : null,
        files: s?.status === 'connected' ? s.files : [],
        expiresAt: s?.status === 'connected' ? s.expiresAt : null,
    };
}

/** Fetch one issued document into the application as `docKey`. */
async function importFile(req, app, { uri, docKey }) {
    const c = config();
    const s = await sessionOf(app);
    if (!s || s.status !== 'connected') refuse('Connect DigiLocker first — the connection lasts thirty minutes', 409, { code: 'DIGILOCKER_NOT_CONNECTED' });
    const f = (s.files || []).find((x) => x.uri === String(uri || ''));
    if (!f) refuse('That document is not in your DigiLocker', 404);
    const r = await call(`${c.base}/1/file/${encodeURIComponent(f.uri)}`, { headers: { Authorization: `Bearer ${open(s.token)}` } }).catch((e) => refuse(`DigiLocker did not send the document: ${e.message}`, 502));
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) refuse('The document from DigiLocker is empty or too large', 422);
    const ctype = String(r.headers.get('content-type') || f.mime || '').toLowerCase();
    const ext = ctype.includes('pdf') ? 'pdf' : ctype.includes('png') ? 'png' : ctype.includes('jpeg') || ctype.includes('jpg') ? 'jpg' : 'pdf';
    const tmp = path.join(os.tmpdir(), `adm-digilocker-${crypto.randomUUID()}.${ext}`);
    await fs.promises.writeFile(tmp, buf);
    const apps = require('./applications');
    const documents = require('./documents');
    const schema = await apps.schemaOf(app);
    // Through the same checks as an upload: the type it is for, the file's kind and size, a virus scan.
    const { row, type } = await documents.upload(app, docKey, { path: tmp, originalname: `${f.name.replace(/[^\w .-]+/g, '').slice(0, 80) || 'document'}.${ext}`, size: buf.length, mimetype: ctype }, { req, applicant: true, schema });
    const dob = app.studentDob ? new Date(app.studentDob).toISOString().slice(0, 10) : '';
    const originMeta = {
        issuer: f.issuer, doctype: f.doctype, name: f.name, issuedOn: f.date, fetchedAt: new Date(),
        account: { name: s.account?.name || '', dobMatchesStudent: !!(s.account?.dob && dob && s.account.dob === dob) },
    };
    await pool.query(`UPDATE "admissiondocuments" SET "origin" = 'digilocker', "originMeta" = $2::jsonb WHERE "_id" = $1`, [row._id, JSON.stringify(originMeta)]);
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'document', action: 'digilocker_fetched', message: `${type.name} fetched from DigiLocker${f.issuer ? ` — issued by ${f.issuer}` : ''}`, visibility: 'applicant' });
    // Verified at once only where the school wrote that rule down (Settings).
    const settings = await settingsSvc.getSettings(app.school);
    if (settings.digilocker?.autoVerify) {
        await pool.query(`UPDATE "admissiondocuments" SET "status" = 'verified', "reviewedAt" = now(), "reviewNote" = $2, "history" = COALESCE("history", '[]'::jsonb) || $3::jsonb WHERE "_id" = $1`,
            [row._id, `Issued by ${f.issuer || 'the issuer'} through DigiLocker`, JSON.stringify([{ status: 'verified', by: 'system', at: new Date(), note: 'Issued through DigiLocker — the school verifies these at once' }])]);
        await documents.refresh(app, schema);
    }
    return { _id: row._id, docKey: type.key, name: type.name, issuer: f.issuer, verified: !!settings.digilocker?.autoVerify };
}

/** The sweep: sessions past their time lose their token. */
async function expire() {
    const { rowCount } = await pool.query(`UPDATE "admissiondigilockersessions" SET "status" = 'ended', "token" = '', "codeVerifier" = '', "updatedAt" = now() WHERE "status" IN ('started', 'connected') AND "expiresAt" < now()`);
    await pool.query(`DELETE FROM "admissiondigilockersessions" WHERE "createdAt" < now() - interval '30 days'`);
    return rowCount;
}

module.exports = { config, available, start, callback, view, importFile, expire, isoDob, seal, open };
