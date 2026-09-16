'use strict';
const nodemailer        = require('nodemailer');
const globalTransporter = require('../config/mailer');
const School            = require('../models/School');

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
    if (smtp?.enabled && smtp.host && smtp.user && smtp.pass) {
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
async function sendSchoolMail(schoolId, { to, subject, html, fromName, rethrow = false }) {
    try {
        const ctx = await getMailContext(schoolId);
        const info = await ctx.transporter.sendMail({
            from: `"${fromName || ctx.fromName}" <${ctx.fromEmail}>`,
            to,
            subject,
            html,
        });
        console.log(`[mail] sent to ${to} — ${info.messageId}`);
        return info;
    } catch (e) {
        console.error(`[mail] failed for ${to}:`, e.message);
        if (rethrow) throw e;
        return null;
    }
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
        ${logo ? `<img src="${logo}" alt="${name}" style="max-height:64px;max-width:200px;object-fit:contain;background:#fff;border-radius:8px;padding:6px;margin-bottom:10px"/>` : ''}
        <h1 style="color:#fff;margin:0;font-size:1.35rem">${logo ? '' : '🎓 '}${name}</h1>
        ${subtitle ? `<p style="margin:6px 0 0;color:rgba(255,255,255,.85);font-size:13px">${subtitle}</p>` : ''}
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
        <p style="margin-top:0">Hi <strong>${name}</strong>,</p>
        <p>You have been added to <strong>${where}</strong> as a ${roleLabel}.</p>
        <p>Nothing changes about how you sign in — keep using <strong>${to}</strong> and your existing
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

module.exports = { getMailContext, sendSchoolMail, schoolLogoUrl, emailHeaderHtml, sendSchoolAddedEmail, invalidate };
