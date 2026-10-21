'use strict';
/**
 * Getting admission email delivered (Oct 2026).
 *
 *   POST /webhooks/email-events     a mail provider reports bounces and spam
 *                                   complaints — signed with ADMISSION_WEBHOOK_SECRET
 *                                   (HMAC-SHA256 of the raw body, header
 *                                   X-Aksharum-Signature: sha256=<hex>)
 *   /admin/emails/suppressions …    the school's do-not-send list
 *   /admin/emails/domain-check      SPF, DMARC, DKIM and MX for the address mail is sent from
 *
 * A message the log shows as "sent" was accepted by the mail server — no
 * more. Bounces arrive later, through the webhook or as a permanent refusal
 * while sending; both put the address on the list.
 */
const crypto = require('crypto');
const dns = require('dns');
const pool = require('../db/pool');
const mailer = require('../services/admission/mailer');
const { getMailContext } = require('../utils/schoolMailer');
const { handler, refuse, isId, str } = require('../services/admission/util');
const { isEmail } = require('../utils/validators');

const TAG = 'admission delivery';

// ── The provider's webhook ───────────────────────────────────────────────────

function signatureOk(req) {
    const secret = process.env.ADMISSION_WEBHOOK_SECRET || '';
    const sent = String(req.get('x-aksharum-signature') || '').replace(/^sha256=/i, '');
    if (!secret || !req.rawBody || !/^[0-9a-f]{64}$/i.test(sent)) return false;
    const expect = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expect, 'hex'), Buffer.from(sent, 'hex'));
}

exports.webhook = async (req, res) => {
    try {
        // With no secret set the webhook does not exist.
        if (!process.env.ADMISSION_WEBHOOK_SECRET) return res.status(404).json({ success: false, message: 'Not found' });
        if (!signatureOk(req)) return res.status(401).json({ success: false, message: 'Bad signature' });
        const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 500) : [];
        let added = 0; let ignored = 0;
        for (const e of list) {
            const email = String(e?.email || '').trim().toLowerCase();
            const type = String(e?.type || '').toLowerCase();
            const permanent = type === 'complaint' || (type === 'bounce' && String(e?.bounceType || 'permanent').toLowerCase() === 'permanent');
            if (!isEmail(email) || !permanent) { ignored += 1; continue; }
            const school = isId(String(e?.school || '')) ? String(e.school) : null;
            await mailer.suppress(school, email, { source: type === 'complaint' ? 'complaint' : 'bounce', reason: str(e?.reason, 300) });
            added += 1;
        }
        return res.json({ success: true, data: { received: list.length, suppressed: added, ignored } });
    } catch (err) {
        console.error(`[${TAG}] webhook:`, err.message);
        return res.status(500).json({ success: false, message: 'Could not record the events' });
    }
};

// ── The school's list ────────────────────────────────────────────────────────

exports.suppressions = handler(async (req, res) => {
    const { rows } = await pool.query(
        `SELECT s."_id", s."email", s."source", s."reason", s."school", s."createdAt", u."name" AS "createdByName"
           FROM "admissionemailsuppressions" s LEFT JOIN "users" u ON u."_id" = s."createdBy"
          WHERE s."school" = $1 OR (s."school" IS NULL AND EXISTS (SELECT 1 FROM "admissionemaillogs" l WHERE l."school" = $1 AND l."to" = s."email"))
          ORDER BY s."createdAt" DESC LIMIT 500`, [String(req.schoolId)]);
    res.json({ success: true, data: rows.map((r) => ({ ...r, platformWide: !r.school })) });
}, TAG);

exports.addSuppression = handler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isEmail(email)) refuse('Enter a valid email address', 400, { field: 'email' });
    const row = await mailer.suppress(req.schoolId, email, { source: 'manual', reason: str(req.body?.reason, 300), by: req.userId });
    res.status(201).json({ success: true, data: row });
}, TAG);

exports.removeSuppression = handler(async (req, res) => {
    if (!isId(String(req.params.id || ''))) refuse('Not found', 404);
    const { rowCount } = await pool.query(`DELETE FROM "admissionemailsuppressions" WHERE "_id" = $1 AND "school" = $2`, [String(req.params.id), String(req.schoolId)]);
    if (!rowCount) refuse('Not found — an address the whole platform stopped sending to can only be cleared by the platform', 404);
    res.json({ success: true });
}, TAG);

// ── Is the sending domain set up? ────────────────────────────────────────────

/** Judge a domain's DNS. `look` = { txt(name) → [strings], mx(name) → [records] } (DNS, or a test's own). */
async function domainReport(look, domain, selector) {
    const [own, dmarcTxt, mx, dkimTxt] = await Promise.all([
        look.txt(domain), look.txt(`_dmarc.${domain}`), look.mx(domain),
        selector ? look.txt(`${selector}._domainkey.${domain}`) : Promise.resolve(null),
    ]);
    const spf = own.filter((t) => /^v=spf1\b/i.test(t));
    const dmarc = dmarcTxt.filter((t) => /^v=DMARC1\b/i.test(t));
    const policy = (dmarc[0]?.match(/\bp=(none|quarantine|reject)\b/i) || [])[1]?.toLowerCase() || '';
    const checks = [
        {
            key: 'spf', label: 'SPF — who may send for the domain', ok: spf.length === 1,
            detail: !spf.length ? `No SPF record on ${domain}. Add a TXT record starting "v=spf1" that includes your mail provider.`
                : spf.length > 1 ? 'There is more than one SPF record — receivers treat that as an error. Merge them into one.' : spf[0],
        },
        {
            key: 'dmarc', label: 'DMARC — what receivers do with failures', ok: dmarc.length === 1,
            detail: !dmarc.length ? `No DMARC record at _dmarc.${domain}. Start with "v=DMARC1; p=none; rua=mailto:…" and tighten it later.`
                : `${dmarc[0]}${policy === 'none' ? ' (monitoring only — consider quarantine once reports look clean)' : ''}`,
        },
        selector
            ? { key: 'dkim', label: `DKIM — the signature key (selector "${selector}")`, ok: (dkimTxt || []).some((t) => /\bp=[A-Za-z0-9+/=]{20,}/.test(t)), detail: (dkimTxt || []).length ? 'Key published.' : `No key at ${selector}._domainkey.${domain}. Your mail provider gives the record to add.` }
            : { key: 'dkim', label: 'DKIM — the signature key', ok: null, detail: 'Enter the selector your mail provider uses (for example "google" or "s1") to check it.' },
        { key: 'mx', label: 'MX — the domain receives mail (for bounces and replies)', ok: mx.length > 0, detail: mx.length ? mx.map((m) => m.exchange).join(', ') : `No MX record on ${domain}.` },
    ];
    return { domain, checks, ok: checks.every((c) => c.ok !== false) };
}

const resolver = () => {
    const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
    return {
        txt: (name) => r.resolveTxt(name).then((rows) => rows.map((x) => x.join(''))).catch(() => []),
        mx: (name) => r.resolveMx(name).catch(() => []),
    };
};

exports.domainCheck = handler(async (req, res) => {
    const ctx = await getMailContext(req.schoolId);
    const from = String(ctx.fromEmail || '').toLowerCase();
    const domain = from.split('@')[1] || '';
    if (!domain) refuse('No sending address is set up — add the school\'s mail server under School Settings → Email', 409);
    const selector = /^[a-z0-9._-]{1,63}$/i.test(String(req.query.selector || '')) ? String(req.query.selector) : '';
    const report = await domainReport(resolver(), domain, selector);
    res.json({
        success: true,
        data: { ...report, from, ownServer: !!(ctx.school?.smtp?.enabled && ctx.school?.smtp?.host), driver: mailer.driver() },
    });
}, TAG);

exports.domainReport = domainReport;
