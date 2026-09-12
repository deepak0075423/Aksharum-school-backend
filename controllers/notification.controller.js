'use strict';
const Notification        = require('../models/Notification');
const NotificationReceipt = require('../models/NotificationReceipt');
const User                = require('../models/User');
const StudentProfile      = require('../models/StudentProfile');
const ClassSection        = require('../models/ClassSection');
const mailer              = require('../config/mailer');
const { publishNotificationCount, publishToUser } = require('../utils/redisPublisher');
const { sendSchoolMail, emailHeaderHtml } = require('../utils/schoolMailer');
const notificationLinks   = require('../services/notificationLinks');

// Recompute and push unread count for one user via the WebSocket Gateway
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

// Batched variant for broadcast fan-outs (can be hundreds of recipients):
// one grouped count query instead of one countDocuments per user.
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

/**
 * Give every receipt the destination it opens on, for THIS reader.
 * Resolution happens here rather than at send time because the same
 * notification points at different screens for a teacher, an admin and a
 * parent — and the sender does not know who will read it on what.
 */
function withLinks(receipts, role) {
    return receipts.map(r => {
        const n = r.notification;
        return {
            ...r,
            link: notificationLinks.resolve(n?.link, role, String(r._id)),
        };
    });
}

exports.getList = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        const [notifications, total] = await Promise.all([
            Notification.find(filter).sort({ createdAt: -1 }).skip((page-1)*limit).limit(+limit).lean(),
            Notification.countDocuments(filter),
        ]);
        res.json({ success: true, data: notifications, total, page: +page, pages: Math.ceil(total/limit) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Recipient resolution ──────────────────────────────────────────────────────
async function resolveRecipients({ targetType, school, classId, sectionId, targetSchools = [] }) {
    switch (targetType) {
        case 'all':
            return User.find({ school, role: { $in: ['teacher', 'student', 'parent', 'school_admin'] } }, '_id email name school role').lean();
        case 'all_teachers':
            return User.find({ school, role: 'teacher' }, '_id email name school role').lean();
        case 'all_students':
            return User.find({ school, role: 'student' }, '_id email name school role').lean();
        case 'all_parents':
            return User.find({ school, role: 'parent' }, '_id email name school role').lean();
        case 'class_students': {
            const secs = await ClassSection.find({ class: classId, school }, 'enrolledStudents').lean();
            const ids  = [...new Set(secs.flatMap(s => s.enrolledStudents.map(id => id.toString())))];
            return User.find({ _id: { $in: ids }, school, role: 'student' }, '_id email name school role').lean();
        }
        case 'class_parents': {
            const secs       = await ClassSection.find({ class: classId, school }, 'enrolledStudents').lean();
            const studentIds = [...new Set(secs.flatMap(s => s.enrolledStudents.map(id => id.toString())))];
            const profiles   = await StudentProfile.find({ user: { $in: studentIds }, parent: { $ne: null } }, 'parent').lean();
            const parentIds  = [...new Set(profiles.map(p => p.parent.toString()))];
            return User.find({ _id: { $in: parentIds }, school, role: 'parent' }, '_id email name school role').lean();
        }
        case 'section_students': {
            const sec = await ClassSection.findById(sectionId, 'enrolledStudents').lean();
            const ids = (sec?.enrolledStudents || []).map(id => id.toString());
            return User.find({ _id: { $in: ids }, school, role: 'student' }, '_id email name school role').lean();
        }
        case 'section_parents': {
            const sec        = await ClassSection.findById(sectionId, 'enrolledStudents').lean();
            const studentIds = (sec?.enrolledStudents || []).map(id => id.toString());
            const profiles   = await StudentProfile.find({ user: { $in: studentIds }, parent: { $ne: null } }, 'parent').lean();
            const parentIds  = [...new Set(profiles.map(p => p.parent.toString()))];
            return User.find({ _id: { $in: parentIds }, school, role: 'parent' }, '_id email name school role').lean();
        }
        case 'section_all': {
            const sec        = await ClassSection.findById(sectionId, 'enrolledStudents').lean();
            const studentIds = (sec?.enrolledStudents || []).map(id => id.toString());
            const profiles   = await StudentProfile.find({ user: { $in: studentIds }, parent: { $ne: null } }, 'parent').lean();
            const parentIds  = [...new Set(profiles.map(p => p.parent.toString()))];
            const allIds     = [...new Set([...studentIds, ...parentIds])];
            return User.find({ _id: { $in: allIds }, school }, '_id email name school role').lean();
        }
        // Super-admin targets — only school_admin recipients
        case 'all_schools':
            return User.find({ role: 'school_admin' }, '_id email name school role').lean();
        case 'specific_school': {
            const schoolIds = (targetSchools.length ? targetSchools : (school ? [school] : []))
                .map(String).filter(Boolean);
            if (!schoolIds.length) return [];
            return User.find({ school: { $in: schoolIds }, role: 'school_admin' }, '_id email name school role').lean();
        }
        default:
            return [];
    }
}

function dispatchEmails({ recipients, title, body, schoolName, schoolId, school, receiptOf }) {
    // The button is built per recipient — it points at that reader's own
    // receipt, so opening it lands them on the notification (and marks it read)
    // whichever device they happen to be on.
    const html = (openUrl) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
      ${emailHeaderHtml(school || { name: schoolName }, title)}
      <div style="background:#f9fafb;padding:24px 28px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
        <p style="white-space:pre-wrap;line-height:1.6;margin:0">${body}</p>
        ${openUrl ? `
        <p style="margin:20px 0 0">
          <a href="${openUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;
             padding:11px 22px;border-radius:8px;font-weight:600;font-size:.9rem">Open in Aksharum</a>
        </p>
        <p style="color:#9ca3af;font-size:.75rem;margin:10px 0 0;word-break:break-all">
          Or paste this link into your browser: ${openUrl}
        </p>` : ''}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#9ca3af;font-size:.8rem;margin:0">This notification was sent by your school administration.</p>
      </div>
    </div>`;

    recipients.forEach(u => {
        if (!u.email) return;
        const receiptId = receiptOf?.get(String(u._id));
        sendSchoolMail(schoolId, {
            to:      u.email,
            subject: `[${schoolName}] ${title}`,
            html:    html(receiptId ? notificationLinks.receiptUrl(receiptId) : null),
            fromName: schoolName,
        });
    });
}

/**
 * The sections a teacher may address.
 *
 * A teacher reaches a section three ways — class teacher, vice class teacher,
 * subject teacher — and any of the three is a reason to be able to tell that
 * class something. Same rule getMySections reports to the UI, applied here
 * because a target the composer does not offer is still a target the endpoint
 * would otherwise accept.
 */
async function teacherSectionIds(userId, schoolId) {
    const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
    const [own, links] = await Promise.all([
        ClassSection.find({
            school: schoolId,
            $or: [{ classTeacher: userId }, { substituteTeacher: userId }],
        }, '_id').lean(),
        SectionSubjectTeacher.find({ teacher: userId }, 'section').lean(),
    ]);
    const linked = links.map((l) => String(l.section)).filter(Boolean);
    // A subject link carries no school of its own, so those sections are
    // re-read school-scoped rather than trusted.
    const checked = linked.length
        ? await ClassSection.find({ _id: { $in: linked }, school: schoolId }, '_id').lean()
        : [];
    return new Set([...own, ...checked].map((s) => String(s._id)));
}

// ── Send ──────────────────────────────────────────────────────────────────────
exports.send = async (req, res) => {
    try {
        const { title, body, targetType = 'all', classId, sectionId, targetSchools = [] } = req.body;
        // A person writing a notification is the only one who knows how urgent
        // it is — a module's is derived from where it points. Anything else
        // stores null and takes the derived value.
        const priority = notificationLinks.PRIORITIES.includes(req.body.priority) ? req.body.priority : null;
        const channels = {
            inApp: req.body.channels?.inApp !== false,
            email: req.body.channels?.email === true,
        };

        if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });
        if (!body?.trim())  return res.status(400).json({ success: false, message: 'Message body is required' });
        if (!channels.inApp && !channels.email)
            return res.status(400).json({ success: false, message: 'Select at least one channel (In-App or Email)' });

        // Role-based target type whitelist
        const adminTargets = ['all','all_teachers','all_students','all_parents',
                              'class_students','class_parents',
                              'section_students','section_parents','section_all'];
        if (req.userRole !== 'super_admin' && !adminTargets.includes(targetType))
            return res.status(403).json({ success: false, message: 'Invalid target type for your role' });

        // An ordinary teacher may only address a section, and only one of their
        // own. The whitelist above is about target *types*, so without this a
        // teacher could post to any class in the school by naming its id — the
        // composer never offered it, but the endpoint accepted it. A teacher
        // whose designation grants admin on the notification module runs the
        // module and keeps the full set.
        const teacherIsModuleAdmin = req.access?.permissions?.notification === 'admin';
        if (req.userRole === 'teacher' && !teacherIsModuleAdmin) {
            const sectionTargets = ['section_students', 'section_parents', 'section_all'];
            if (!sectionTargets.includes(targetType))
                return res.status(403).json({ success: false, message: 'You can only send to a section you teach' });
            const mine = await teacherSectionIds(req.userId, req.schoolId);
            if (!sectionId || !mine.has(String(sectionId)))
                return res.status(403).json({ success: false, message: 'You can only send to a section you teach' });
        }

        // Contextual field validation
        if (['class_students','class_parents'].includes(targetType) && !classId)
            return res.status(400).json({ success: false, message: 'Please select a class' });
        if (['section_students','section_parents','section_all'].includes(targetType) && !sectionId)
            return res.status(400).json({ success: false, message: 'Please select a section' });
        if (targetType === 'specific_school' && !targetSchools.length && !req.schoolId)
            return res.status(400).json({ success: false, message: 'Please select at least one school' });

        const target = { type: targetType };
        if (classId)   target.class   = classId;
        if (sectionId) target.section = sectionId;
        if (targetType === 'specific_school') target.schools = targetSchools;

        // Resolve first — sending to an empty audience is a mistake worth
        // reporting, not a stored notification nobody ever receives.
        const recipients = await resolveRecipients({ targetType, school: req.schoolId, classId, sectionId, targetSchools });
        if (!recipients.length)
            return res.status(400).json({ success: false, message: 'No recipients matched this target — nothing was sent.' });

        const notification = await Notification.create({
            school:     req.schoolId || null,
            sender:     req.userId,
            senderRole: req.userRole,
            title:      title.trim(),
            body:       body.trim(),
            channels,
            target,
            priority,
        });

        if (channels.inApp && recipients.length) {
            const docs = recipients.map(u => ({
                notification: notification._id,
                recipient:    u._id,
                // Super-admin sends have no schoolId of their own — scope each
                // receipt to the recipient's school so it stays queryable.
                school:       req.schoolId || u.school || null,
            }));
            // A typed broadcast has no destination of its own, so each reader's
            // link opens the notification itself — which needs their own receipt
            // id, taken from the insert rather than a second pass over a table
            // this may have just written thousands of rows to.
            const inserted = await NotificationReceipt.insertMany(docs, { ordered: false }).catch(() => []);
            const receiptOf = new Map((inserted || []).map(r => [String(r.recipient), String(r._id)]));
            if (receiptOf.size < recipients.length) {
                const rows = await NotificationReceipt
                    .find({ notification: notification._id }, '_id recipient').lean();
                rows.forEach(r => receiptOf.set(String(r.recipient), String(r._id)));
            }
            // Fire-and-forget: real-time event + updated count via the WebSocket Gateway
            recipients.forEach(u => {
                const receiptId = receiptOf.get(String(u._id)) || null;
                publishToUser(u._id, 'notification:new', {
                    _id:        notification._id,
                    receiptId,
                    title:      notification.title,
                    body:       notification.body,
                    senderRole: notification.senderRole,
                    createdAt:  notification.createdAt,
                    link:       notificationLinks.resolve(null, u.role, receiptId),
                });
            });
            _pushCounts(recipients.map(u => u._id));
            // Emails go out below and need the same per-reader ids
            req._notifReceiptOf = receiptOf;
        }

        await Notification.findByIdAndUpdate(notification._id, { recipientCount: recipients.length });

        if (channels.email && recipients.length) {
            const School = require('../models/School');
            if (req.schoolId) {
                const school = await School.findById(req.schoolId, 'name logo').lean();
                dispatchEmails({
                    recipients,
                    title:      title.trim(),
                    body:       body.trim(),
                    schoolName: school?.name || 'School',
                    schoolId:   req.schoolId,
                    school,
                    receiptOf:  req._notifReceiptOf,
                });
            } else {
                // Super-admin send: mail each school's admins through their own
                // SMTP/branding instead of a generic "School" header.
                const schoolIds = [...new Set(recipients.map(u => u.school && String(u.school)).filter(Boolean))];
                const schools   = await School.find({ _id: { $in: schoolIds } }, 'name logo').lean();
                const byId      = new Map(schools.map(s => [String(s._id), s]));
                for (const sid of schoolIds) {
                    const school = byId.get(sid);
                    dispatchEmails({
                        recipients: recipients.filter(u => String(u.school) === sid),
                        title:      title.trim(),
                        body:       body.trim(),
                        schoolName: school?.name || 'School',
                        schoolId:   sid,
                        school,
                        receiptOf:  req._notifReceiptOf,
                    });
                }
            }
        }

        res.status(201).json({ success: true, data: { ...notification.toObject(), recipientCount: recipients.length } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Inbox ─────────────────────────────────────────────────────────────────────
exports.getInboxApi = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const receipts = await NotificationReceipt.find({ recipient: req.userId, isCleared: false })
            .populate('notification')
            .sort({ createdAt: -1 })
            .skip((page-1)*+limit)
            .limit(+limit)
            .lean();
        const unread = await NotificationReceipt.countDocuments({ recipient: req.userId, isRead: false, isCleared: false });
        res.json({ success: true, data: withLinks(receipts, req.userRole), unread });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.markAllRead = async (req, res) => {
    try {
        await NotificationReceipt.updateMany({ recipient: req.userId, isRead: false }, { isRead: true, readAt: new Date() });
        _pushCount(req.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.clearAll = async (req, res) => {
    try {
        await NotificationReceipt.updateMany({ recipient: req.userId }, { isCleared: true, clearedAt: new Date() });
        _pushCount(req.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.markOneRead = async (req, res) => {
    try {
        await NotificationReceipt.findOneAndUpdate(
            { _id: req.params.receiptId, recipient: req.userId },
            { isRead: true, readAt: new Date() }
        );
        _pushCount(req.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.clearOne = async (req, res) => {
    try {
        await NotificationReceipt.findOneAndUpdate(
            { _id: req.params.receiptId, recipient: req.userId },
            { isCleared: true, clearedAt: new Date() }
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Acting on several at once ─────────────────────────────────────────────────
/**
 * One endpoint for everything the selection bar offers.
 *
 * Every statement is scoped to `recipient = req.userId` as well as to the ids,
 * so a receipt belonging to somebody else is not acted on — and reports as
 * simply not found rather than as a refusal, which would confirm it exists.
 *
 * **Delete removes the receipt, never the notification.** The same notification
 * is one row shared by everybody who received it, and the sender's Sent tab
 * reads that row: deleting it would erase one person's mailbox *and* the
 * sender's record of having written to the other three hundred.
 */
const BULK_ACTIONS = {
    read:    { isRead: true,  readAt: () => new Date() },
    unread:  { isRead: false, readAt: () => null },
    archive: { isCleared: true,  clearedAt: () => new Date() },
    restore: { isCleared: false, clearedAt: () => null },
};

exports.bulk = async (req, res) => {
    try {
        const { query } = require('../db/pool');
        const action = String(req.body.action || '');
        const ids    = [...new Set((req.body.ids || []).map(String).filter(Boolean))];

        if (!ids.length) return res.status(400).json({ success: false, message: 'Nothing was selected' });
        if (action !== 'delete' && !BULK_ACTIONS[action])
            return res.status(400).json({ success: false, message: `Unknown action '${action}'` });

        const R = NotificationReceipt.tableName;
        let rowCount = 0;

        if (action === 'delete') {
            ({ rowCount } = await query(
                `DELETE FROM "${R}" WHERE recipient = $1 AND _id = ANY($2::uuid[])`,
                [req.userId, ids],
            ));
        } else {
            const shape = BULK_ACTIONS[action];
            const sets  = Object.entries(shape).map(([k, v], i) => `"${k}" = $${i + 3}`).join(', ');
            const vals  = Object.values(shape).map((v) => (typeof v === 'function' ? v() : v));
            ({ rowCount } = await query(
                `UPDATE "${R}" SET ${sets} WHERE recipient = $1 AND _id = ANY($2::uuid[])`,
                [req.userId, ids, ...vals],
            ));
        }

        _pushCount(req.userId);
        res.json({ success: true, affected: rowCount });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

/**
 * Empty one box.
 *
 * Scoped to the box the reader is looking at, because "delete all" from inside
 * the archive must not also take the inbox they have not read yet. `all` is
 * offered too, and is the only one that needs the warning the page gives it.
 */
exports.deleteAll = async (req, res) => {
    try {
        const { query } = require('../db/pool');
        const box = ['inbox', 'archived', 'all'].includes(req.body.box) ? req.body.box : 'inbox';
        const R   = NotificationReceipt.tableName;

        const scope = box === 'inbox'    ? ' AND NOT COALESCE("isCleared", false)'
                    : box === 'archived' ? ' AND COALESCE("isCleared", false)'
                    : '';
        const { rowCount } = await query(
            `DELETE FROM "${R}" WHERE recipient = $1${scope}`, [req.userId],
        );

        _pushCount(req.userId);
        res.json({ success: true, deleted: rowCount });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Sent ──────────────────────────────────────────────────────────────────────
/**
 * What this account has sent, and whether anybody read it.
 *
 * The list on its own answers "did it go out". The figure that matters is the
 * one after that — a notice to 340 parents that 12 have opened is a notice that
 * has not been delivered in any sense the sender cares about — so each row
 * carries its own read-through, counted from the receipts in one grouped query
 * over the page rather than one query per row.
 */
const SENT_SORTS = {
    newest:     'n."createdAt" DESC',
    oldest:     'n."createdAt" ASC',
    recipients: 'COALESCE(n."recipientCount", 0) DESC, n."createdAt" DESC',
    title:      'n.title ASC, n."createdAt" DESC',
};

exports.getSent = async (req, res) => {
    try {
        const { query } = require('../db/pool');
        const links = notificationLinks;

        const page  = Math.max(1, Math.floor(Number(req.query.page) || 1));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 20)));

        const N = Notification.tableName;
        const R = NotificationReceipt.tableName;

        const params = [req.userId];
        const where  = ['n.sender = $1'];

        if (req.query.audience) { params.push(String(req.query.audience)); where.push(`n.target->>'type' = $${params.length}`); }
        // "What did I actually broadcast", as against everything a module
        // raised in my name when I approved or issued something. Both were
        // genuinely sent from this account, so both belong on the tab — but
        // they are different questions and the list is mostly the second one.
        if (req.query.kind === 'announcement') where.push(`COALESCE(n.target->>'type', '') <> 'individual'`);
        if (req.query.kind === 'activity')     where.push(`COALESCE(n.target->>'type', '') = 'individual'`);
        if (req.query.channel === 'email') where.push(`COALESCE((n.channels->>'email')::boolean, false)`);
        if (req.query.channel === 'inApp') where.push(`COALESCE((n.channels->>'inApp')::boolean, true)`);
        if (req.query.priority) { params.push(String(req.query.priority)); where.push(`${links.prioritySql('n.link', 'n.priority')} = $${params.length}`); }
        if (req.query.q && String(req.query.q).trim()) {
            params.push(`%${String(req.query.q).trim()}%`);
            where.push(`(n.title ILIKE $${params.length} OR n.body ILIKE $${params.length})`);
        }

        const whereSql = `WHERE ${where.join(' AND ')}`;
        const order    = SENT_SORTS[req.query.sort] || SENT_SORTS.newest;

        const [rowsRes, countRes] = await Promise.all([
            query(
                `SELECT n._id, n.title, n.body, n."createdAt", n.channels, n.target, n.link,
                        n."senderRole", COALESCE(n."recipientCount", 0)::int AS "recipientCount",
                        ${links.prioritySql('n.link', 'n.priority')} AS priority
                   FROM "${N}" n ${whereSql}
                  ORDER BY ${order}
                  LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
                params,
            ),
            query(`SELECT COUNT(*)::int AS n FROM "${N}" n ${whereSql}`, params),
        ]);

        const ids = rowsRes.rows.map((r) => r._id);
        let readBy = new Map();
        if (ids.length) {
            const seen = await query(
                `SELECT notification,
                        COUNT(*)::int AS delivered,
                        COUNT(*) FILTER (WHERE COALESCE("isRead", false))::int AS opened
                   FROM "${R}" WHERE notification = ANY($1::uuid[]) GROUP BY notification`,
                [ids],
            );
            readBy = new Map(seen.rows.map((r) => [String(r.notification), r]));
        }

        const data = rowsRes.rows.map((row) => {
            const seen = readBy.get(String(row._id));
            return {
                ...row,
                // Delivered counts the in-app receipts that exist. An email-only
                // notification has none, and reports 0 rather than pretending.
                delivered: seen?.delivered ?? 0,
                opened:    seen?.opened ?? 0,
                module:    (() => { const key = links.moduleOf(row.link); return { key, label: links.moduleLabel(key) }; })(),
            };
        });

        res.json({
            success: true, data,
            total: countRes.rows[0]?.n || 0,
            page, pages: Math.max(1, Math.ceil((countRes.rows[0]?.n || 0) / limit)),
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getSectionsByClass = async (req, res) => {
    try {
        const sections = await ClassSection.find({ class: req.params.classId, school: req.schoolId }).lean();
        res.json({ success: true, data: sections });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getUnreadCount = async (req, res) => {
    try {
        const count = await NotificationReceipt.countDocuments({ recipient: req.userId, isRead: false, isCleared: false });
        res.json({ success: true, count });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

/**
 * GET /notifications/all — the notifications page's list.
 * ───────────────────────────────────────────────────────
 * Everything the reader has ever received, narrowed. The page offers a search,
 * a module, a priority, a kind and a read state, and all five are applied here
 * rather than in the browser: an account a year old has thousands of receipts,
 * and a filter that only searches the fifty rows already fetched answers the
 * wrong question.
 *
 * Raw SQL because every one of those filters crosses the join — the words are
 * on the notification, the read flag is on the receipt, and the module and the
 * priority are derived from the notification's destination. db/aggregate.js
 * runs $lookup in JS, which would mean loading both tables to filter three
 * rows.
 *
 * Called with no parameters — which is what the teacher/student/parent page
 * and the mobile app still do — it returns what it always did: every receipt,
 * cleared ones included, newest first.
 */
const BOXES = ['all', 'inbox', 'archived'];

const SORTS = {
    newest:   'r."createdAt" DESC',
    oldest:   'r."createdAt" ASC',
    unread:   'COALESCE(r."isRead", false) ASC, r."createdAt" DESC',
    priority: '{{RANK}} ASC, r."createdAt" DESC',
    title:    'n.title ASC, r."createdAt" DESC',
};

exports.getAllNotifications = async (req, res) => {
    try {
        const { query } = require('../db/pool');
        const links     = notificationLinks;

        const page  = Math.max(1, Math.floor(Number(req.query.page) || 1));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
        const box   = BOXES.includes(req.query.box) ? req.query.box : 'all';

        const R = NotificationReceipt.tableName;
        const N = Notification.tableName;
        const U = User.tableName;

        const moduleExpr   = links.moduleSql('n.link');
        const priorityExpr = links.prioritySql('n.link', 'n.priority');
        const rankExpr     = links.priorityRankSql('n.link', 'n.priority');
        // 'individual' is what every module stamps on a notification raised
        // about one record; anything else was addressed to an audience.
        const kindExpr     = `(CASE WHEN COALESCE(n.target->>'type', '') = 'individual' THEN 'activity' ELSE 'announcement' END)`;

        const params = [req.userId];
        const where  = ['r.recipient = $1'];
        const add    = (sql, value) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)); };

        if (box === 'inbox')    where.push('NOT COALESCE(r."isCleared", false)');
        if (box === 'archived') where.push('COALESCE(r."isCleared", false)');

        if (req.query.read === 'unread') where.push('NOT COALESCE(r."isRead", false)');
        if (req.query.read === 'read')   where.push('COALESCE(r."isRead", false)');

        if (req.query.module)   add(`${moduleExpr} = $?`, String(req.query.module));
        if (req.query.priority) add(`${priorityExpr} = $?`, String(req.query.priority));
        if (req.query.kind)     add(`${kindExpr} = $?`, String(req.query.kind));
        if (req.query.q && String(req.query.q).trim()) {
            const q = `%${String(req.query.q).trim()}%`;
            params.push(q);
            where.push(`(n.title ILIKE $${params.length} OR n.body ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
        }

        const from = `FROM "${R}" r
             JOIN "${N}" n ON n._id = r.notification
        LEFT JOIN "${U}" u ON u._id = n.sender`;
        const whereSql = `WHERE ${where.join(' AND ')}`;
        const order    = (SORTS[req.query.sort] || SORTS.newest).replace('{{RANK}}', rankExpr);

        const [rowsRes, countRes, boxRes] = await Promise.all([
            query(
                `SELECT r._id, r."isRead", r."isCleared", r."readAt", r."createdAt",
                        n._id AS n_id, n.title, n.body, n."senderRole", n."createdAt" AS n_created,
                        n.link, n.target,
                        u.name AS sender_name, u.role AS sender_user_role,
                        ${moduleExpr} AS module_key,
                        ${priorityExpr} AS priority,
                        ${kindExpr} AS kind
                 ${from} ${whereSql}
                 ORDER BY ${order}
                 LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
                params,
            ),
            query(`SELECT COUNT(*)::int AS n ${from} ${whereSql}`, params),
            // The tab badges. Counted over the whole mailbox, never the filter —
            // "Inbox 3" must not drop to 0 because the reader searched for a word.
            // Sent is counted here too, so the tab carries its number before
            // anybody has opened it.
            query(
                `SELECT COUNT(*) FILTER (WHERE NOT COALESCE(r."isCleared", false))::int AS inbox,
                        COUNT(*) FILTER (WHERE NOT COALESCE(r."isCleared", false)
                                           AND NOT COALESCE(r."isRead", false))::int AS unread,
                        COUNT(*) FILTER (WHERE COALESCE(r."isCleared", false))::int AS archived,
                        (SELECT COUNT(*)::int FROM "${N}" WHERE sender = $1) AS sent
                   FROM "${R}" r WHERE r.recipient = $1`,
                [req.userId],
            ),
        ]);

        const total = countRes.rows[0]?.n || 0;
        const boxes = boxRes.rows[0] || { inbox: 0, unread: 0, archived: 0, sent: 0 };

        const data = rowsRes.rows.map((row) => ({
            _id:       row._id,
            isRead:    !!row.isRead,
            isCleared: !!row.isCleared,
            readAt:    row.readAt,
            createdAt: row.createdAt,
            priority:  row.priority,
            kind:      row.kind,
            module:    { key: row.module_key, label: links.moduleLabel(row.module_key) },
            // A module notification is raised by whoever acted — the teacher who
            // applied, the librarian who issued — so the name is theirs. A
            // notification nobody's account is behind reads as "System".
            sender:    { name: row.sender_name || 'System', role: row.sender_user_role || row.senderRole || '' },
            notification: {
                _id:        row.n_id,
                title:      row.title,
                body:       row.body,
                senderRole: row.senderRole,
                createdAt:  row.n_created,
                target:     row.target || null,
            },
            link: links.resolve(row.link, req.userRole, String(row._id)),
        }));

        res.json({
            success: true, data,
            total, unread: boxes.unread, boxes,
            page, pages: Math.max(1, Math.ceil(total / limit)),
            modules: links.MODULE_OPTIONS,
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

/**
 * Put a notification back on the pile.
 * Reading one is not a decision — an inbox where the only way to un-mark
 * something is to remember it existed is an inbox people stop trusting.
 */
exports.markOneUnread = async (req, res) => {
    try {
        await NotificationReceipt.findOneAndUpdate(
            { _id: req.params.receiptId, recipient: req.userId },
            { isRead: false, readAt: null },
        );
        _pushCount(req.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

/** Out of the archive and back into the inbox. The undo for DELETE /:receiptId. */
exports.restoreOne = async (req, res) => {
    try {
        await NotificationReceipt.findOneAndUpdate(
            { _id: req.params.receiptId, recipient: req.userId },
            { isCleared: false, clearedAt: null },
        );
        _pushCount(req.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

/**
 * Archive every read notification in the inbox.
 * The bulk action that matches how the page is actually used: read the ones
 * that matter, then clear the rest out in one go. Deliberately never touches an
 * unread row — that would hide something nobody has looked at.
 */
exports.archiveRead = async (req, res) => {
    try {
        const { query } = require('../db/pool');
        const R = NotificationReceipt.tableName;
        const { rowCount } = await query(
            `UPDATE "${R}" SET "isCleared" = true, "clearedAt" = NOW()
              WHERE recipient = $1 AND COALESCE("isRead", false) AND NOT COALESCE("isCleared", false)`,
            [req.userId],
        );
        res.json({ success: true, archived: rowCount });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

/**
 * GET /notifications/:receiptId/resolve
 * "I have this notification — where does it go, and what does it say?"
 * The one thing an email link, a push tap and a cold app start all need, and
 * the only place that also marks the notification read as a side effect of
 * opening it. Returns 404 for a receipt that is not the caller's, so a guessed
 * id tells the guesser nothing.
 */
exports.resolveReceipt = async (req, res) => {
    try {
        const receipt = await NotificationReceipt
            .findOne({ _id: req.params.receiptId, recipient: req.userId })
            .populate('notification')
            .lean();
        if (!receipt) return res.status(404).json({ success: false, message: 'Notification not found' });

        if (!receipt.isRead) {
            await NotificationReceipt.updateOne({ _id: receipt._id }, { isRead: true, readAt: new Date() });
            _pushCount(req.userId);
        }

        const n = receipt.notification;
        // Shaped like a row from GET /all, so the page that opens a receipt it
        // has not got on screen — an emailed link landing on page 4 of a
        // filtered list — can show it without a second, differently-shaped call.
        const sender  = n?.sender ? await User.findById(n.sender, 'name role').lean() : null;
        const modKey  = notificationLinks.moduleOf(n?.link);
        res.json({
            success: true,
            data: {
                _id:       receipt._id,
                isRead:    true,
                isCleared: !!receipt.isCleared,
                createdAt: receipt.createdAt,
                readAt:    receipt.readAt || new Date(),
                priority:  notificationLinks.priorityOf(n),
                kind:      n?.target?.type === 'individual' ? 'activity' : 'announcement',
                module:    { key: modKey, label: notificationLinks.moduleLabel(modKey) },
                sender:    { name: sender?.name || 'System', role: sender?.role || n?.senderRole || '' },
                notification: n ? {
                    _id: n._id, title: n.title, body: n.body,
                    senderRole: n.senderRole, createdAt: n.createdAt,
                    target: n.target || null,
                } : null,
                link: notificationLinks.resolve(n?.link, req.userRole, String(receipt._id)),
            },
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
