'use strict';
/**
 * Central action-notification service.
 * ────────────────────────────────────
 * Every module action calls notify() to fan a notification out to users:
 *   • Persists a Notification + one NotificationReceipt per recipient
 *   • Pushes `notification:new` + updated unread count to each recipient's
 *     sockets via the WebSocket Gateway (Redis chat.deliver channel)
 *   • Optionally emails recipients through the school's own SMTP
 *
 * notify() is fire-and-forget: it never throws and runs after the response.
 */
const Notification        = require('../models/Notification');
const NotificationReceipt = require('../models/NotificationReceipt');
const User                = require('../models/User');
const { publishNotificationCount, publishToUser } = require('../utils/redisPublisher');
const { sendSchoolMail, emailHeaderHtml, getMailContext } = require('../utils/schoolMailer');
const notificationLinks   = require('./notificationLinks');

async function _pushCount(userId) {
    try {
        const count = await NotificationReceipt.countDocuments({
            recipient: userId,
            isRead:    false,
            isCleared: false,
        });
        await publishNotificationCount(userId, count);
    } catch {}
}

// Batched variant for fan-outs: one grouped count query for ALL recipients
// instead of one countDocuments per user.
async function _pushCounts(userIds) {
    try {
        if (!userIds.length) return;
        const rows = await NotificationReceipt.aggregate([
            { $match: { recipient: { $in: userIds }, isRead: false, isCleared: false } },
            { $group: { _id: '$recipient', n: { $sum: 1 } } },
        ]);
        const countByUser = new Map(rows.map((r) => [String(r._id), r.n]));
        for (const uid of userIds) {
            publishNotificationCount(uid, countByUser.get(String(uid)) || 0).catch(() => {});
        }
    } catch {}
}

// The button points at /n/:receiptId rather than the resolved page: the same
// email may be opened on a laptop or a phone, and that route decides where to
// land (and hands off to the app when it is installed) at click time.
function _openButton(url) {
    if (!url) return '';
    return `
        <p style="margin:20px 0 0">
          <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;
             padding:11px 22px;border-radius:8px;font-weight:600;font-size:.9rem">Open in Aksharum</a>
        </p>
        <p style="color:#9ca3af;font-size:.75rem;margin:10px 0 0;word-break:break-all">
          Or paste this link into your browser: ${url}
        </p>`;
}

function _emailHtml({ school, recipientName, title, body, openUrl }) {
    return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
      ${emailHeaderHtml(school, 'You have a new notification')}
      <div style="background:#f9fafb;padding:24px 28px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none">
        <p style="margin-top:0">Dear <strong>${recipientName || 'User'}</strong>,</p>
        <div style="background:#fff;border-left:4px solid #4f46e5;border-radius:0 8px 8px 0;padding:14px 18px;margin-bottom:16px">
          <h2 style="margin:0 0 4px;font-size:1.05rem;color:#1e293b">${title}</h2>
        </div>
        <p style="white-space:pre-wrap;line-height:1.6;margin:0">${body}</p>
        ${_openButton(openUrl)}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#9ca3af;font-size:.8rem;margin:0">This is an automated notification — please do not reply.</p>
      </div>
    </div>`;
}

/**
 * Fan a notification out to specific users.
 *
 * @param {Object}   opts
 * @param {ObjectId} opts.school      School scope (null for cross-school/system)
 * @param {ObjectId} opts.sender      Acting user (req.userId)
 * @param {String}   opts.senderRole  Acting user's role (req.userRole)
 * @param {String}   opts.title       Short headline
 * @param {String}   opts.body        Message body
 * @param {Array}    opts.recipients  User ids (or {_id} docs); deduped, sender excluded
 * @param {Boolean}  [opts.email]     Also email recipients via school SMTP
 * @param {Boolean}  [opts.includeSender] Keep the sender in the recipient list
 * @param {Object}   [opts.link]      Where it takes the reader — { type, entityId?, params? }.
 *                                    See services/notificationLinks for the types.
 *                                    Omitted, the notification opens on itself.
 */
function notify(opts) {
    setImmediate(() => _notify(opts).catch(e =>
        console.error('[notify] failed:', e.message)));
}

async function _notify({ school, sender, senderRole, title, body, recipients = [], email = false, includeSender = false, link = null }) {
    if (!sender || !title || !body) return;

    const ids = [...new Set(
        recipients
            .map(r => (r?._id ?? r)?.toString())
            .filter(Boolean)
            .filter(id => includeSender || id !== sender.toString())
    )];
    if (!ids.length) return;

    const notification = await Notification.create({
        school:     school || null,
        sender,
        senderRole: senderRole || 'system',
        title:      String(title).trim(),
        body:       String(body).trim(),
        channels:   { inApp: true, email: !!email },
        target:     { type: 'individual' },
        link:       notificationLinks.normalize(link) || undefined,
        recipientCount: ids.length,
    });

    // The inserted receipts already carry the ids each reader's link is built
    // from, so the fan-out does not need a second pass over the table — which
    // matters: a school-wide notification writes thousands of rows.
    const inserted = await NotificationReceipt.insertMany(
        ids.map(uid => ({
            notification: notification._id,
            recipient:    uid,
            school:       school || null,
        })),
        { ordered: false }
    ).catch(() => []);

    const receiptOf = new Map((inserted || []).map(r => [String(r.recipient), String(r._id)]));
    // An insert that gave up part-way still has rows on disk; read back only
    // then, rather than on every send.
    if (receiptOf.size < ids.length) {
        const rows = await NotificationReceipt.find({ notification: notification._id }, '_id recipient').lean();
        rows.forEach(r => receiptOf.set(String(r.recipient), String(r._id)));
    }

    // The live payload carries each reader's own destination, and that depends
    // on their role — so the push is built per recipient rather than broadcast
    // identically. One indexed lookup for the whole fan-out.
    const users  = await User.find({ _id: { $in: ids } }, 'name email role').lean();
    const roleOf = new Map(users.map(u => [String(u._id), u.role]));

    const stored = notificationLinks.normalize(link);
    for (const uid of ids) {
        const receiptId = receiptOf.get(String(uid)) || null;
        publishToUser(uid, 'notification:new', {
            _id:        notification._id,
            receiptId,
            title:      notification.title,
            body:       notification.body,
            senderRole: notification.senderRole,
            createdAt:  notification.createdAt,
            link:       notificationLinks.resolve(stored, roleOf.get(String(uid)), receiptId),
        });
    }
    _pushCounts(ids);

    if (email) {
        try {
            const { school: schoolDoc } = await getMailContext(school);
            for (const u of users) {
                if (!u.email) continue;
                const receiptId = receiptOf.get(String(u._id));
                sendSchoolMail(school, {
                    to:      u.email,
                    subject: `[${schoolDoc?.name || 'Notification'}] ${title}`,
                    html:    _emailHtml({
                        school: schoolDoc, recipientName: u.name, title, body,
                        openUrl: receiptId ? notificationLinks.receiptUrl(receiptId) : null,
                    }),
                });
            }
        } catch (e) {
            console.error('[notify] email fan-out failed:', e.message);
        }
    }
}

// ── Common recipient lookups ──────────────────────────────────────────────────

async function schoolAdminIds(schoolId) {
    const admins = await User.find({ school: schoolId, role: 'school_admin', isActive: true }, '_id').lean();
    return admins.map(a => a._id);
}

// Student user ids → { studentIds, parentIds } (parents resolved via StudentProfile)
async function withParents(studentIds) {
    const StudentProfile = require('../models/StudentProfile');
    const profiles = await StudentProfile.find(
        { user: { $in: studentIds }, parent: { $ne: null } }, 'parent'
    ).lean();
    return [...new Set([
        ...studentIds.map(String),
        ...profiles.map(p => p.parent.toString()),
    ])];
}

module.exports = { notify, schoolAdminIds, withParents };
