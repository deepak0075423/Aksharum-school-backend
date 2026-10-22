'use strict';
const nodemailer        = require('nodemailer');
const globalTransporter = require('../config/mailer');
const School            = require('../models/School');
const { escapeHtml: esc } = require('./textRules');   // what a person typed stays text in the email

// Public base URL of THIS backend (serves /uploads). Falls back to localhost dev port.
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;

// schoolId → { key, transporter } — key is a hash of the smtp config so a
// credential change invalidates the cached transporter automatically.
const _cache = new Map();

function _configKey(smtp) {
    return [smtp.host, smtp.port, smtp.secure, smtp.user, smtp.pass].join('|');
}

function _buildTransporter(smtp) {
    return nodemailer.createTransport({
        host:   smtp.host,
        port:   Number(smtp.port) || 587,
        secure: !!smtp.secure,
        auth:   { user: smtp.user, pass: smtp.pass },
    });
}

// "Use our school's own mail server" is on, and there is enough to log in with.
const hasOwnServer = (smtp) => !!(smtp?.enabled && smtp.host && smtp.user && smtp.pass);

// Resolve mail context for a school. Returns:
//   { transporter, fromEmail, school } — school is a lean doc with branding fields.
// Falls back to the platform transporter when the school has no usable SMTP config.
async function getMailContext(schoolId) {
    let school = null;
    if (schoolId) {
        school = await School.findById(schoolId)
            .select('name logo smtp email')
            .lean()
            .catch(() => null);
    }

    const smtp = school?.smtp;
    if (hasOwnServer(smtp)) {
        const key    = _configKey(smtp);
        const cached = _cache.get(schoolId.toString());
        let transporter = cached?.key === key ? cached.transporter : null;
        if (!transporter) {
            transporter = _buildTransporter(smtp);
            _cache.set(schoolId.toString(), { key, transporter });
        }
        return {
            transporter,
            fromEmail: smtp.fromEmail || smtp.user,
            fromName:  smtp.fromName  || school?.name || process.env.APP_NAME || 'School',
            school,
        };
    }

    return {
        transporter: globalTransporter,
        fromEmail:   process.env.SMTP_USER,
        fromName:    school?.name || process.env.APP_NAME || 'School',
        school,
    };
}

// Send one email on behalf of a school (uses its SMTP when configured).
// Never throws unless `rethrow` is set — most emails are fire-and-forget.
// `attachments` is nodemailer's own shape: [{ filename, content, contentType }].
// Used by payroll to send the payslip itself rather than only a link to it.
// `replyTo` and `text` (a plain-text twin of the HTML) are optional — the
// admission module sets both (services/admission/mailer.js).
async function sendSchoolMail(schoolId, { to, subject, html, text, fromName, replyTo, attachments, rethrow = false }) {
    try {
        const ctx = await getMailContext(schoolId);
        const info = await ctx.transporter.sendMail({
            from: `"${fromName || ctx.fromName}" <${ctx.fromEmail}>`,
            to,
            subject,
            html,
            ...(text ? { text } : {}),
            ...(replyTo ? { replyTo } : {}),
            ...(attachments && attachments.length ? { attachments } : {}),
        });
        console.log(`[mail] sent to ${to} — ${info.messageId}`);
        return info;
    } catch (e) {
        console.error(`[mail] failed for ${to}:`, e.message);
        if (rethrow) throw e;
        return null;
    }
}

/**
 * Mail for a PERSON rather than for one school. A password-reset code goes to
 * an address, and one address can belong to several schools (services/
 * accountIdentity), so whose mail server sends it is a choice:
 *
 *   - one of their schools has "Use our school's own mail server" on → that one;
 *   - several have → one of those, at random;
 *   - none has → the platform's (.env).
 *
 * The rest stand by in order — the other schools' own servers (shuffled), then
 * the platform's — so one school's broken mailbox does not leave the person
 * without their mail. `build(school)` returns { subject, html } for the school
 * whose server is sending (null for the platform), so the email carries the
 * sender's own name and logo.
 *
 * Resolves to { info, schoolId } — schoolId null when the platform sent it —
 * and throws the last failure when every server refused.
 */
async function sendPersonMail(schoolIds, to, build) {
    const ids = [...new Set((schoolIds || []).filter(Boolean).map(String))];
    const schools = ids.length
        ? await School.find({ _id: { $in: ids } }).select('_id smtp').lean()
        : [];
    const own = schools.filter((s) => hasOwnServer(s.smtp)).map((s) => String(s._id));
    for (let i = own.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [own[i], own[j]] = [own[j], own[i]];
    }
    let lastErr = null;
    for (const schoolId of [...own, null]) {
        try {
            const ctx = await getMailContext(schoolId);
            const { subject, html } = build(schoolId ? ctx.school : null);
            const from = schoolId
                ? `"${ctx.fromName}" <${ctx.fromEmail}>`
                : (process.env.EMAIL_FROM || `"${ctx.fromName}" <${ctx.fromEmail}>`);
            const info = await ctx.transporter.sendMail({ from, to, subject, html });
            console.log(`[mail] sent to ${to} through ${schoolId ? `school ${schoolId}'s own mail server` : 'the platform mail server'} — ${info.messageId}`);
            return { info, schoolId };
        } catch (e) {
            lastErr = e;
            console.error(`[mail] ${schoolId ? `school ${schoolId}'s own mail server` : 'the platform mail server'} failed for ${to}:`, e.message);
        }
    }
    throw lastErr;
}

// Absolute URL of the school's uploaded logo (empty string when none).
// Handles both storage formats: bare filename and "/uploads/images/<file>".
function schoolLogoUrl(school) {
    const logo = school?.logo;
    if (!logo) return '';
    if (/^https?:\/\//.test(logo)) return logo;
    if (logo.startsWith('/uploads')) return `${BACKEND_URL}${logo}`;
    return `${BACKEND_URL}/uploads/images/${logo}`;
}

// Shared email header: school logo (when set) + school/app name.
function emailHeaderHtml(school, subtitle = '') {
    const logo = schoolLogoUrl(school);
    const name = school?.name || process.env.APP_NAME || 'School';
    return `
      <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:28px 32px;border-radius:12px 12px 0 0;text-align:center">
        ${logo ? `<img src="${esc(logo)}" alt="${esc(name)}" style="max-height:64px;max-width:200px;object-fit:contain;background:#fff;border-radius:8px;padding:6px;margin-bottom:10px"/>` : ''}
        <h1 style="color:#fff;margin:0;font-size:1.35rem">${logo ? '' : '🎓 '}${esc(name)}</h1>
        ${subtitle ? `<p style="margin:6px 0 0;color:rgba(255,255,255,.85);font-size:13px">${esc(subtitle)}</p>` : ''}
      </div>`;
}

/**
 * The other welcome: this person already signs in here, and has just been given
 * a post somewhere new — a second school, or a second role at this one.
 *
 * There are no credentials to send. They keep the password they already use, so
 * "your account has been created, here is a one-time password" would be both
 * wrong and alarming — and acting on it would lock them out of the school they
 * already work at. What they need to know is that this school is now on their
 * sign-in, and that they choose between schools after signing in.
 *
 * Shared by the school office and the platform's own user screens so the two
 * cannot drift apart.
 */
function sendSchoolAddedEmail(to, name, roleLabel, schoolName, schoolId = null) {
    const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`;
    return getMailContext(schoolId).then(({ school }) => {
        const where = schoolName || school?.name || 'a new school';
        const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
      ${emailHeaderHtml(school, `You've been added to ${where}`)}
      <div style="background:#f9fafb;padding:28px 32px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
        <p style="margin-top:0">Hi <strong>${esc(name)}</strong>,</p>
        <p>You have been added to <strong>${esc(where)}</strong> as a ${roleLabel}.</p>
        <p>Nothing changes about how you sign in — keep using <strong>${esc(to)}</strong> and your existing
           password. After signing in you will be asked which school you want to open, and you can
           switch between them at any time from your profile.</p>
        <p style="margin:24px 0">
          <a href="${loginUrl}" style="background:#4f46e5;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;display:inline-block">Sign in</a>
        </p>
        <p style="color:#6b7280;font-size:.88rem;margin-bottom:0">
          If you were not expecting this, please contact ${where}.
        </p>
      </div>
    </div>`;
        return sendSchoolMail(schoolId, {
            to,
            subject: `You've been added to ${where}`,
            html,
            fromName: where,
        });
    }).catch((err) => console.error(`[email] school-added notice failed for ${to}:`, err.message));
}

// Drop a school's cached transporter (call after SMTP settings change).
function invalidate(schoolId) {
    if (schoolId) _cache.delete(schoolId.toString());
}

module.exports = { getMailContext, sendSchoolMail, sendPersonMail, schoolLogoUrl, emailHeaderHtml, sendSchoolAddedEmail, invalidate };
