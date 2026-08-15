'use strict';
const Notification        = require('../models/Notification');
const NotificationReceipt = require('../models/NotificationReceipt');
const User                = require('../models/User');
const StudentProfile      = require('../models/StudentProfile');
const ClassSection        = require('../models/ClassSection');
const mailer              = require('../config/mailer');
const { publishNotificationCount, publishToUser } = require('../utils/redisPublisher');
const { sendSchoolMail, emailHeaderHtml } = require('../utils/schoolMailer');

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
            return User.find({ school, role: { $in: ['teacher', 'student', 'parent', 'school_admin'] } }, '_id email name school').lean();
        case 'all_teachers':
            return User.find({ school, role: 'teacher' }, '_id email name school').lean();
        case 'all_students':
            return User.find({ school, role: 'student' }, '_id email name school').lean();
        case 'all_parents':
            return User.find({ school, role: 'parent' }, '_id email name school').lean();
        case 'class_students': {
            const secs = await ClassSection.find({ class: classId, school }, 'enrolledStudents').lean();
            const ids  = [...new Set(secs.flatMap(s => s.enrolledStudents.map(id => id.toString())))];
            return User.find({ _id: { $in: ids }, school, role: 'student' }, '_id email name school').lean();
        }
        case 'class_parents': {
            const secs       = await ClassSection.find({ class: classId, school }, 'enrolledStudents').lean();
            const studentIds = [...new Set(secs.flatMap(s => s.enrolledStudents.map(id => id.toString())))];
            const profiles   = await StudentProfile.find({ user: { $in: studentIds }, parent: { $ne: null } }, 'parent').lean();
            const parentIds  = [...new Set(profiles.map(p => p.parent.toString()))];
            return User.find({ _id: { $in: parentIds }, school, role: 'parent' }, '_id email name school').lean();
        }
        case 'section_students': {
            const sec = await ClassSection.findById(sectionId, 'enrolledStudents').lean();
            const ids = (sec?.enrolledStudents || []).map(id => id.toString());
            return User.find({ _id: { $in: ids }, school, role: 'student' }, '_id email name school').lean();
        }
        case 'section_parents': {
            const sec        = await ClassSection.findById(sectionId, 'enrolledStudents').lean();
            const studentIds = (sec?.enrolledStudents || []).map(id => id.toString());
            const profiles   = await StudentProfile.find({ user: { $in: studentIds }, parent: { $ne: null } }, 'parent').lean();
            const parentIds  = [...new Set(profiles.map(p => p.parent.toString()))];
            return User.find({ _id: { $in: parentIds }, school, role: 'parent' }, '_id email name school').lean();
        }
        case 'section_all': {
            const sec        = await ClassSection.findById(sectionId, 'enrolledStudents').lean();
            const studentIds = (sec?.enrolledStudents || []).map(id => id.toString());
            const profiles   = await StudentProfile.find({ user: { $in: studentIds }, parent: { $ne: null } }, 'parent').lean();
            const parentIds  = [...new Set(profiles.map(p => p.parent.toString()))];
            const allIds     = [...new Set([...studentIds, ...parentIds])];
            return User.find({ _id: { $in: allIds }, school }, '_id email name school').lean();
        }
        // Super-admin targets — only school_admin recipients
        case 'all_schools':
            return User.find({ role: 'school_admin' }, '_id email name school').lean();
        case 'specific_school': {
            const schoolIds = (targetSchools.length ? targetSchools : (school ? [school] : []))
                .map(String).filter(Boolean);
            if (!schoolIds.length) return [];
            return User.find({ school: { $in: schoolIds }, role: 'school_admin' }, '_id email name school').lean();
        }
        default:
            return [];
    }
}

function dispatchEmails({ recipients, title, body, schoolName, schoolId, school }) {
    const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
      ${emailHeaderHtml(school || { name: schoolName }, title)}
      <div style="background:#f9fafb;padding:24px 28px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
        <p style="white-space:pre-wrap;line-height:1.6;margin:0">${body}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#9ca3af;font-size:.8rem;margin:0">This notification was sent by your school administration.</p>
      </div>
    </div>`;

    recipients.forEach(u => {
        if (!u.email) return;
        sendSchoolMail(schoolId, {
            to:      u.email,
            subject: `[${schoolName}] ${title}`,
            html,
            fromName: schoolName,
        });
    });
}

// ── Send ──────────────────────────────────────────────────────────────────────
exports.send = async (req, res) => {
    try {
        const { title, body, targetType = 'all', classId, sectionId, targetSchools = [] } = req.body;
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
        });

        if (channels.inApp && recipients.length) {
            const docs = recipients.map(u => ({
                notification: notification._id,
                recipient:    u._id,
                // Super-admin sends have no schoolId of their own — scope each
                // receipt to the recipient's school so it stays queryable.
                school:       req.schoolId || u.school || null,
            }));
            await NotificationReceipt.insertMany(docs, { ordered: false }).catch(() => {});
            // Fire-and-forget: real-time event + updated count via the WebSocket Gateway
            const rtPayload = {
                _id:        notification._id,
                title:      notification.title,
                body:       notification.body,
                senderRole: notification.senderRole,
                createdAt:  notification.createdAt,
            };
            recipients.forEach(u => {
                publishToUser(u._id, 'notification:new', rtPayload);
            });
            _pushCounts(recipients.map(u => u._id));
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
        res.json({ success: true, data: receipts, unread });
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

// ── Sent ──────────────────────────────────────────────────────────────────────
exports.getSent = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const [notifications, total] = await Promise.all([
            Notification.find({ sender: req.userId }).sort({ createdAt: -1 }).skip((page-1)*+limit).limit(+limit).lean(),
            Notification.countDocuments({ sender: req.userId }),
        ]);
        res.json({ success: true, data: notifications, total, page: +page, pages: Math.ceil(total/+limit) });
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

// Returns ALL receipts (including cleared) for the notifications page — no deletion allowed
exports.getAllNotifications = async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const receipts = await NotificationReceipt.find({ recipient: req.userId })
            .populate('notification')
            .sort({ createdAt: -1 })
            .skip((page - 1) * +limit)
            .limit(+limit)
            .lean();
        const total  = await NotificationReceipt.countDocuments({ recipient: req.userId });
        const unread = await NotificationReceipt.countDocuments({ recipient: req.userId, isRead: false });
        res.json({ success: true, data: receipts, total, unread, page: +page, pages: Math.ceil(total / +limit) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
