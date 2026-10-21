'use strict';
/**
 * Sending the admission module's emails, in each school's own words.
 *
 * Delivery goes through the platform's mail path (utils/schoolMailer): the
 * school's own SMTP when it has one configured, the platform's otherwise.
 * Every attempt is written to AdmissionEmailLog with what the mail server
 * said — a failure is recorded as a failure, never as sent.
 *
 * ADMISSION_MAIL_DRIVER
 *   smtp  (default) send for real
 *   log   send nothing; record the rendered email as 'logged' (development
 *         and automated tests — nothing leaves the machine)
 *
 * One-time codes are never kept in the log's context, so a failed code email
 * cannot be "retried" into a stale code — the applicant asks for a new one.
 */
const pool = require('../../db/pool');
const AdmissionEmailTemplate = require('../../models/AdmissionEmailTemplate');
const AdmissionEmailLog = require('../../models/AdmissionEmailLog');
const { sendSchoolMail, getMailContext, emailHeaderHtml } = require('../../utils/schoolMailer');
const { escapeHtml: esc } = require('../../utils/textRules');
const catalog = require('./emailCatalog');
const richText = require('./richText');
const settingsSvc = require('./settings');
const { refuse } = require('./util');

const SECRET_KEYS = new Set(['otp']);
const driver = () => (String(process.env.ADMISSION_MAIL_DRIVER || 'smtp').toLowerCase() === 'log' ? 'log' : 'smtp');
const frontend = () => String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');

/** Links into a school's portal. */
function portalLinks(slug) {
    const base = `${frontend()}/${slug || ''}`.replace(/\/+$/, '');
    return {
        portal_link: `${base}/dashboard`,
        login_link: `${base}/login`,
        application: (id) => `${base}/applications/${id}`,
    };
}

/** The wording in force for an event: the school's current version, or the default. */
async function templateFor(schoolId, event) {
    const def = catalog.EVENTS[event];
    if (!def) refuse(`Unknown email "${event}"`, 400);
    const row = await AdmissionEmailTemplate.findOne({ school: schoolId, event, isCurrent: true }).lean();
    if (row) return { subject: row.subject, body: row.body, enabled: def.required ? true : row.enabled !== false, version: row.version, custom: true };
    return { subject: def.subject, body: def.body, enabled: def.required ? true : !def.defaultOff, version: 0, custom: false };
}

/** The school's branded frame around a rendered body. */
function frame(school, settings, bodyHtml, { subtitle = '' } = {}) {
    const portal = settings?.portal || {};
    const contactBits = [portal.help?.email || portal.contact?.email, portal.help?.phone || portal.contact?.phone].filter(Boolean).map(esc);
    return `
<div style="background:#f3f4f6;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
    ${emailHeaderHtml(school, subtitle || portal.title || 'Admissions')}
    <div style="padding:26px 30px 8px">${bodyHtml}</div>
    <div style="padding:16px 30px 24px;border-top:1px solid #f0f0f3;color:#6b7280;font-size:12px;line-height:1.6">
      ${esc(portal.footer?.text || '')}${portal.footer?.text ? '<br>' : ''}
      ${contactBits.length ? `Admission office: ${contactBits.join(' · ')}<br>` : ''}
      This email was sent by ${esc(school?.name || 'the school')}'s admission portal.
    </div>
  </div>
</div>`;
}

/** Values every email can use. */
async function commonValues(schoolId, { school = null, settings = null } = {}) {
    const ctx = school ? { school } : await getMailContext(schoolId);
    const st = settings || await settingsSvc.getSettings(schoolId);
    const links = portalLinks(st.slug);
    const help = st.portal?.help || {};
    const contact = st.portal?.contact || {};
    return {
        school: ctx.school,
        settings: st,
        values: {
            school_name: ctx.school?.name || 'the school',
            portal_link: links.portal_link,
            login_link: links.login_link,
            support_email: help.email || contact.email || ctx.school?.email || '',
            support_phone: help.phone || contact.phone || '',
        },
        links,
    };
}

/**
 * Send one admission email. Never throws for a delivery failure — the failure
 * is logged and returned — but does refuse an unknown event.
 *
 * opts: { to, recipient, application, values, isTest, template: {subject, body} (preview/test of unsaved wording) }
 * Returns { status: 'sent'|'failed'|'logged'|'skipped', logId, error }.
 */
async function send(schoolId, event, opts = {}) {
    const def = catalog.EVENTS[event];
    if (!def) refuse(`Unknown email "${event}"`, 400);
    const to = String(opts.to || '').trim().toLowerCase();
    if (!to) return { status: 'skipped', error: 'No address' };

    const tpl = opts.template ? { ...opts.template, enabled: true, version: -1 } : await templateFor(schoolId, event);
    const base = await commonValues(schoolId);
    const values = { ...base.values, ...(opts.values || {}) };
    const context = Object.fromEntries(Object.entries(values).filter(([k]) => !SECRET_KEYS.has(k)).map(([k, v]) => [k, String(v ?? '').slice(0, 500)]));
    const logBase = {
        school: schoolId, event, to, application: opts.application || null, recipient: opts.recipient || null,
        templateVersion: tpl.version, isTest: !!opts.isTest, context, attempt: opts.attempt || 1,
    };

    if (!tpl.enabled && !opts.isTest) {
        const row = await AdmissionEmailLog.create({ ...logBase, subject: '', status: 'skipped', error: 'This email is switched off', driver: driver() });
        return { status: 'skipped', logId: row._id, error: 'This email is switched off' };
    }
    // Reserved top-level domains (RFC 2606 / 6761) can never receive mail;
    // handing them to the mail server only earns bounces against the school's
    // sender reputation. Test data uses them, so this also keeps test runs off
    // the real mail server whatever process they reach.
    if (driver() !== 'log' && /\.(test|example|invalid|localhost)$/i.test(to.split('@')[1] || '')) {
        const row = await AdmissionEmailLog.create({ ...logBase, subject: '', status: 'skipped', error: 'Reserved test domain — not delivered', driver: driver() });
        return { status: 'skipped', logId: row._id, error: 'Reserved test domain — not delivered' };
    }

    // An address that bounced for good (or complained) is not written to again.
    const stop = await suppressed(schoolId, to);
    if (stop) {
        const why = `On the do-not-send list — ${stop.source === 'complaint' ? 'marked a message as spam' : stop.source === 'manual' ? 'added by the office' : 'the address bounced'}${stop.reason ? `: ${stop.reason.slice(0, 160)}` : ''}`;
        const row = await AdmissionEmailLog.create({ ...logBase, subject: '', status: 'skipped', error: why, driver: driver() });
        return { status: 'skipped', logId: row._id, error: why };
    }

    const subject = richText.renderSubject(tpl.subject, values);
    // What the delivery log keeps: the subject with every secret masked. The
    // office reads this log, and a reset code there would let anyone who runs
    // admissions take over the address — whose password is shared by every
    // account it holds, at every school.
    const masked = Object.fromEntries(Object.keys(values).filter((k) => SECRET_KEYS.has(k)).map((k) => [k, '••••••']));
    const storedSubject = Object.keys(masked).length ? richText.renderSubject(tpl.subject, { ...values, ...masked }) : subject;
    const html = frame(base.school, base.settings, richText.render(tpl.body, values));
    const text = richText.plainText(tpl.body, values);
    const replyTo = base.settings.email?.replyTo || undefined;
    const fromName = base.settings.email?.fromName || undefined;

    if (driver() === 'log') {
        // The log driver keeps the whole message — it exists so development
        // and tests can read what would have been sent, codes included. It
        // sends nothing and is never a production setting.
        const row = await AdmissionEmailLog.create({ ...logBase, subject: storedSubject, status: 'logged', driver: 'log', body: `${text}\n\n${html}` });
        return { status: 'logged', logId: row._id };
    }
    try {
        const info = await sendSchoolMail(schoolId, { to, subject, html, text, replyTo, fromName, rethrow: true });
        const row = await AdmissionEmailLog.create({ ...logBase, subject: storedSubject, status: 'sent', driver: 'smtp', messageId: String(info?.messageId || '') });
        return { status: 'sent', logId: row._id };
    } catch (e) {
        const error = String(e?.message || 'Mail server refused the message').slice(0, 500);
        const row = await AdmissionEmailLog.create({ ...logBase, subject: storedSubject, status: 'failed', driver: 'smtp', error });
        // The receiving server said this mailbox does not exist (a 5xx to RCPT TO): stop writing to it.
        if (Number(e?.responseCode) >= 550 && Number(e?.responseCode) < 560 && /RCPT/i.test(String(e?.command || ''))) {
            await suppress(schoolId, to, { source: 'smtp_reject', reason: error }).catch(() => {});
        }
        return { status: 'failed', logId: row._id, error };
    }
}

// ── The do-not-send list ─────────────────────────────────────────────────────

const AdmissionEmailSuppression = require('../../models/AdmissionEmailSuppression');

/** The suppression covering this address for this school (its own, or a platform-wide one), or null. */
async function suppressed(schoolId, email) {
    const { rows } = await pool.query(
        `SELECT "source", "reason" FROM "${AdmissionEmailSuppression.tableName}" WHERE "email" = $1 AND ("school" = $2 OR "school" IS NULL) ORDER BY "createdAt" DESC LIMIT 1`,
        [String(email).toLowerCase(), schoolId ? String(schoolId) : null]);
    return rows[0] || null;
}

async function suppress(schoolId, email, { source = 'manual', reason = '', by = null } = {}) {
    const address = String(email || '').trim().toLowerCase();
    if (!address) return null;
    const { rows: [have] } = await pool.query(
        `SELECT "_id" FROM "${AdmissionEmailSuppression.tableName}" WHERE "email" = $1 AND "school" IS NOT DISTINCT FROM $2`, [address, schoolId ? String(schoolId) : null]);
    if (have) return have;
    return AdmissionEmailSuppression.create({ school: schoolId || null, email: address, source, reason: String(reason || '').slice(0, 500), createdBy: by });
}

/** Fire-and-forget: send after the response, never fail the request. */
function sendLater(schoolId, event, opts) {
    setImmediate(() => send(schoolId, event, opts).catch((e) => console.error(`[admission mail] ${event}:`, e.message)));
}

/** Send a logged email again — the stored context, today's wording. */
async function retry(schoolId, logId) {
    const row = await AdmissionEmailLog.findOne({ _id: logId, school: schoolId }).lean();
    if (!row) refuse('Email not found', 404);
    if (row.status !== 'failed') refuse('Only an email that failed can be sent again');
    if (catalog.EVENTS[row.event]?.needs?.includes('otp')) refuse('A code email cannot be sent again — the applicant should ask for a new code');
    return send(schoolId, row.event, {
        to: row.to, application: row.application, recipient: row.recipient, values: row.context || {}, attempt: (row.attempt || 1) + 1,
    });
}

/** Preview: wording (saved or not) rendered with sample values, nothing sent. */
async function preview(schoolId, event, { subject, body } = {}) {
    const tpl = await templateFor(schoolId, event);
    const base = await commonValues(schoolId);
    const values = { ...catalog.sampleValues(base.school), ...base.values };
    const s = subject ?? tpl.subject;
    const b = body ?? tpl.body;
    return {
        subject: richText.renderSubject(s, values),
        html: frame(base.school, base.settings, richText.render(b, values)),
        problems: [...richText.problems(s, catalog.EVENTS[event].placeholders), ...richText.problems(b, catalog.EVENTS[event].placeholders)],
    };
}

// ── Templates: reading and saving the school's wording ───────────────────────

async function listTemplates(schoolId) {
    const rows = await AdmissionEmailTemplate.find({ school: schoolId, isCurrent: true }).lean();
    const byEvent = new Map(rows.map((r) => [r.event, r]));
    return catalog.EVENT_KEYS.map((key) => {
        const def = catalog.EVENTS[key];
        const row = byEvent.get(key);
        return {
            event: key, label: def.label, group: def.group, description: def.description,
            required: !!def.required, needs: def.needs || [],
            placeholders: Object.entries(def.placeholders).map(([k, p]) => ({ key: k, label: p.label, link: !!p.link })),
            subject: row?.subject ?? def.subject, body: row?.body ?? def.body,
            enabled: def.required ? true : (row ? row.enabled !== false : !def.defaultOff),
            custom: !!row, version: row?.version || 0, updatedAt: row?.createdAt || null,
            defaultSubject: def.subject, defaultBody: def.body,
        };
    });
}

/** Save new wording for an event — a new version; the previous stays in history. */
async function saveTemplate(schoolId, event, { subject, body, enabled, note }, userId) {
    const def = catalog.EVENTS[event];
    if (!def) refuse(`Unknown email "${event}"`, 404);
    const current = await templateFor(schoolId, event);
    const s = richText.clean(subject ?? current.subject).trim();
    const b = richText.clean(body ?? current.body).trim();
    if (!s) refuse('The subject is required', 400, { field: 'subject' });
    if (s.length > 200) refuse('The subject must be at most 200 characters', 400, { field: 'subject' });
    if (!b) refuse('The message is required', 400, { field: 'body' });
    if (b.length > 10000) refuse('The message must be at most 10,000 characters', 400, { field: 'body' });
    const bad = [...richText.problems(s, def.placeholders).map((m) => ({ field: 'subject', m })), ...richText.problems(b, def.placeholders).map((m) => ({ field: 'body', m }))];
    if (bad.length) refuse(bad[0].m, 400, { field: bad[0].field, errors: bad.map((x) => ({ path: x.field, message: x.m })) });
    for (const need of def.needs || []) {
        if (!new RegExp(`\\{\\{\\s*${need}\\s*\\}\\}`).test(b)) refuse(`This email must include {{${need}}} in the message`, 400, { field: 'body' });
    }
    const on = def.required ? true : (enabled === undefined ? current.enabled : !!enabled);
    return insertVersion(schoolId, event, { subject: s, body: b, enabled: on, note: String(note || '').slice(0, 200), userId });
}

async function insertVersion(schoolId, event, { subject, body, enabled, note, userId }) {
    const { withTransaction } = require('../dbTx');
    const T = `"${AdmissionEmailTemplate.tableName}"`;
    return withTransaction(async (q) => {
        await q('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`admission-template:${schoolId}:${event}`]);
        const { rows: [last] } = await q(`SELECT COALESCE(MAX("version"), 0) AS v FROM ${T} WHERE "school" = $1 AND "event" = $2`, [String(schoolId), event]);
        await q(`UPDATE ${T} SET "isCurrent" = false WHERE "school" = $1 AND "event" = $2 AND "isCurrent"`, [String(schoolId), event]);
        const { rows: [row] } = await q(
            `INSERT INTO ${T} ("_id", "school", "event", "version", "isCurrent", "enabled", "subject", "body", "note", "updatedBy", "createdAt")
             VALUES (gen_random_uuid(), $1, $2, $3, true, $4, $5, $6, $7, $8, now()) RETURNING *`,
            [String(schoolId), event, Number(last.v) + 1, enabled, subject, body, note || '', userId || null]);
        return row;
    });
}

/** Switch an optional email on or off without changing its wording. */
async function setEnabled(schoolId, event, enabled, userId) {
    const def = catalog.EVENTS[event];
    if (!def) refuse(`Unknown email "${event}"`, 404);
    if (def.required) refuse('This email cannot be switched off — applicants need it to sign in');
    const t = await templateFor(schoolId, event);
    return insertVersion(schoolId, event, { subject: t.subject, body: t.body, enabled: !!enabled, note: enabled ? 'Switched on' : 'Switched off', userId });
}

async function versions(schoolId, event) {
    return AdmissionEmailTemplate.find({ school: schoolId, event }).sort({ version: -1 }).limit(50).lean();
}

/** Bring back an earlier version — as a new version, so history only grows. */
async function restore(schoolId, event, version, userId) {
    const row = await AdmissionEmailTemplate.findOne({ school: schoolId, event, version: Number(version) }).lean();
    if (!row) refuse('That version was not found', 404);
    return insertVersion(schoolId, event, { subject: row.subject, body: row.body, enabled: row.enabled !== false, note: `Restored version ${row.version}`, userId });
}

async function resetToDefault(schoolId, event, userId) {
    const def = catalog.EVENTS[event];
    if (!def) refuse(`Unknown email "${event}"`, 404);
    return insertVersion(schoolId, event, { subject: def.subject, body: def.body, enabled: def.required ? true : !def.defaultOff, note: 'Reset to the default wording', userId });
}

async function logs(schoolId, { status, event, q: search, page = 1, limit = 25 } = {}) {
    const params = [String(schoolId)];
    const where = ['"school" = $1'];
    if (status) { params.push(String(status)); where.push(`"status" = $${params.length}`); }
    if (event) { params.push(String(event)); where.push(`"event" = $${params.length}`); }
    if (search) { params.push(`%${String(search).toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`); where.push(`(lower("to") LIKE $${params.length} OR lower("subject") LIKE $${params.length})`); }
    const lim = Math.min(100, Math.max(1, Number(limit) || 25));
    const off = (Math.max(1, Number(page) || 1) - 1) * lim;
    const T = `"${AdmissionEmailLog.tableName}"`;
    const [{ rows }, { rows: [c] }, { rows: counts }] = await Promise.all([
        pool.query(`SELECT "_id", "event", "to", "subject", "status", "error", "driver", "attempt", "isTest", "templateVersion", "application", "createdAt"
                      FROM ${T} WHERE ${where.join(' AND ')} ORDER BY "createdAt" DESC LIMIT ${lim} OFFSET ${off}`, params),
        pool.query(`SELECT COUNT(*)::int AS n FROM ${T} WHERE ${where.join(' AND ')}`, params),
        pool.query(`SELECT "status", COUNT(*)::int AS n FROM ${T} WHERE "school" = $1 AND "createdAt" > now() - interval '30 days' GROUP BY 1`, [String(schoolId)]),
    ]);
    return {
        rows: rows.map((r) => ({ ...r, label: catalog.EVENTS[r.event]?.label || r.event, canRetry: r.status === 'failed' && !catalog.EVENTS[r.event]?.needs?.includes('otp') })),
        total: c.n,
        last30: Object.fromEntries(counts.map((x) => [x.status, x.n])),
    };
}

module.exports = {
    driver, portalLinks, templateFor, frame, commonValues, send, sendLater, retry, preview,
    listTemplates, saveTemplate, setEnabled, versions, restore, resetToDefault, logs,
    suppressed, suppress,
};
