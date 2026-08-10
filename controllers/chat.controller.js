'use strict';
const Chat            = require('../models/Chat');
const ChatMember      = require('../models/ChatMember');
const Message         = require('../models/Message');
const MessageReceipt  = require('../models/MessageReceipt');
const User            = require('../models/User');
const perm            = require('../services/chatPermissionService');
const broker          = require('../services/chatBrokerService');

// ─── Chat list ────────────────────────────────────────────────────────────────

/** GET /api/chat/chats */
exports.getChats = async (req, res) => {
    try {
        const memberships = await ChatMember.find({
            user: req.userId, school: req.schoolId, isActive: true,
        })
        .populate({
            path: 'chat',
            populate: {
                path: 'lastMessage',
                select: 'content type sender isDeleted createdAt',
                populate: { path: 'sender', select: 'name' },
            },
        })
        .lean();

        const results = await Promise.all(
            memberships
                .filter(m => m.chat && m.chat._id)
                .map(m => _enrichChat(m, req.userId, req.schoolId))
        );

        results.sort((a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0));

        res.json({ success: true, data: results });
    } catch (err) {
        console.error('[chatCtrl] getChats:', err);
        res.status(500).json({ success: false, message: 'Failed to load chats' });
    }
};

async function _enrichChat(membership, userId, schoolId) {
    const chat = membership.chat;
    let displayName   = chat.name;
    let displayAvatar = chat.avatar;
    let otherUser     = null;
    let otherReadAt   = null;   // recipient's last-read time — drives read ticks

    if (chat.type === 'direct') {
        const other = await ChatMember.findOne({
            chat: chat._id, user: { $ne: userId }, isActive: true,
        }).populate('user', 'name role profileImage lastSeenAt').lean();
        if (other && other.user) {
            otherUser     = other.user;
            displayName   = other.user.name;
            displayAvatar = other.user.profileImage || '';
            otherReadAt   = other.lastReadAt || null;
        }
    }

    const unreadCount = await Message.countDocuments({
        chat:      chat._id,
        sender:    { $ne: userId },
        isDeleted: false,
        createdAt: { $gt: membership.lastReadAt || new Date(0) },
    });

    return {
        ...chat,
        displayName,
        displayAvatar,
        otherUser,
        otherReadAt,
        unreadCount,
        isMuted:    membership.isMuted,
        isArchived: membership.isArchived,
        memberRole: membership.role,
        lastReadAt: membership.lastReadAt,
    };
}

// ─── Messages ─────────────────────────────────────────────────────────────────

/** GET /api/chat/chats/:chatId/messages?before=<iso>&limit=40 */
exports.getMessages = async (req, res) => {
    try {
        const { chatId }             = req.params;
        const { before, limit = 40 } = req.query;

        const member        = await ChatMember.findOne({ chat: chatId, user: req.userId, isActive: true }).lean();
        const adminObserver = !member && req.userRole === 'school_admin';

        if (!member && !adminObserver) {
            return res.status(403).json({ success: false, message: 'Not a member' });
        }
        if (adminObserver) {
            const chat = await Chat.findOne({ _id: chatId, school: req.schoolId }).lean();
            if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
        }

        const filter = { chat: chatId, school: req.schoolId };
        if (before) filter.createdAt = { $lt: new Date(before) };

        const lim  = Math.min(parseInt(limit) || 40, 100);
        const msgs = await Message.find(filter)
            .populate('sender', 'name role profileImage')
            .populate({
                path: 'replyTo',
                select: 'content isDeleted type',
                populate: { path: 'sender', select: 'name' },
            })
            .sort({ createdAt: -1 })
            .limit(lim)
            .lean();

        // Skip read-tracking for admin observers (they are not members)
        if (!adminObserver) _markRead(chatId, req.userId, msgs).catch(() => {});

        // Only school admins see deleted content + full edit history.
        const isAdmin = req.userRole === 'school_admin';
        const shaped = msgs.map(m => {
            if (isAdmin) return m;
            const { editHistory, ...rest } = m;
            if (rest.isDeleted) { rest.content = ''; rest.attachments = []; }
            return rest;
        });

        res.json({
            success: true,
            data:    shaped.reverse(),
            hasMore: msgs.length >= lim,
        });
    } catch (err) {
        console.error('[chatCtrl] getMessages:', err);
        res.status(500).json({ success: false, message: 'Failed to load messages' });
    }
};

async function _markRead(chatId, userId, msgs) {
    if (!msgs.length) return;
    const latest = msgs[0]; // sorted desc, so first = newest
    await ChatMember.findOneAndUpdate(
        { chat: chatId, user: userId },
        { lastReadMessage: latest._id, lastReadAt: new Date() }
    );
    await MessageReceipt.updateMany(
        { chat: chatId, user: userId, readAt: null },
        { readAt: new Date() }
    );
    // Notify room so senders see read ticks
    broker.publishToRoom(chatId, 'chat:message_read', {
        chatId, userId: String(userId), messageId: latest._id, readAt: new Date(),
    }).catch(() => {});
}

/**
 * POST /api/chat/chats/:chatId/messages  body: { content, type, replyTo, attachments, tempId }
 * REST send path — persists the message and broadcasts it to the room via the
 * broker so gateway-connected members receive it in real time.
 */
exports.sendMessage = async (req, res) => {
    try {
        const { chatId } = req.params;
        const { content, type = 'text', replyTo, attachments = [], tempId, isForwarded = false } = req.body;

        const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
        if (!content?.trim() && !hasAttachments) {
            return res.status(400).json({ success: false, message: 'Content is required' });
        }

        const member = await ChatMember.findOne({ chat: chatId, user: req.userId, isActive: true }).lean();
        if (!member) return res.status(403).json({ success: false, message: 'Not a member of this chat' });

        const chat = await Chat.findOne({ _id: chatId, school: req.schoolId }).lean();
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        if (chat.isReadOnly && !['school_admin', 'super_admin', 'teacher'].includes(req.userRole)) {
            return res.status(403).json({ success: false, message: 'This is a read-only channel' });
        }

        const message = await Message.create({
            chat:        chatId,
            school:      req.schoolId,
            sender:      req.userId,
            senderRole:  req.userRole,
            content:     (content || '').trim(),
            type,
            attachments: hasAttachments ? attachments : [],
            replyTo:     isForwarded ? null : (replyTo || null),
            isForwarded: !!isForwarded,
        });

        await Chat.updateOne({ _id: chatId }, { lastMessage: message._id, lastActivity: new Date() });
        await ChatMember.updateOne(
            { chat: chatId, user: req.userId },
            { lastReadAt: new Date(), lastReadMessage: message._id }
        );

        const populated = await Message.findById(message._id)
            .populate('sender', 'name role profileImage')
            .populate({
                path: 'replyTo',
                select: 'content isDeleted type',
                populate: { path: 'sender', select: 'name' },
            })
            .lean();

        // Real-time broadcast + delivery receipts (non-blocking)
        broker.publishToRoom(chatId, 'chat:message', { ...populated, tempId: tempId || null }).catch(() => {});
        _writeReceipts(message._id, chatId, req.userId, req.schoolId).catch(() => {});

        res.status(201).json({ success: true, data: populated });
    } catch (err) {
        console.error('[chatCtrl] sendMessage:', err);
        res.status(500).json({ success: false, message: 'Failed to send message' });
    }
};

async function _writeReceipts(messageId, chatId, senderUserId, schoolId) {
    const members = await ChatMember.find({
        chat: chatId, user: { $ne: senderUserId }, isActive: true,
    }).select('user').lean();
    if (!members.length) return;
    await MessageReceipt.insertMany(
        members.map(m => ({
            message: messageId, chat: chatId, user: m.user,
            school:  schoolId, deliveredAt: new Date(),
        })),
        { ordered: false }
    );
}

// ─── Create direct chat ───────────────────────────────────────────────────────

/** POST /api/chat/direct  body: { targetUserId } */
exports.createDirectChat = async (req, res) => {
    try {
        const targetUserId = req.body.targetUserId || req.body.receiverId;

        if (!targetUserId) return res.status(400).json({ success: false, message: 'targetUserId required' });
        if (String(targetUserId) === String(req.userId)) {
            return res.status(400).json({ success: false, message: 'Cannot chat with yourself' });
        }

        const receiver = await User.findOne({ _id: targetUserId, school: req.schoolId }).select('role').lean();
        if (!receiver) return res.status(404).json({ success: false, message: 'User not found' });

        const check = await perm.canMessage(req.userId, req.userRole, targetUserId, receiver.role, req.schoolId);
        if (!check.allowed) return res.status(403).json({ success: false, message: check.reason });

        // Find existing direct chat between these two users
        const myMemberships = await ChatMember.find({ user: req.userId, school: req.schoolId, isActive: true })
            .select('chat').lean();
        const myChatIds = myMemberships.map(m => m.chat);

        const existing = await ChatMember.findOne({
            chat:     { $in: myChatIds },
            user:     targetUserId,
            isActive: true,
        })
        .populate({ path: 'chat', match: { type: 'direct', school: req.schoolId } })
        .lean();

        if (existing && existing.chat) {
            return res.json({ success: true, data: existing.chat });
        }

        const chat = await Chat.create({
            school: req.schoolId, type: 'direct', createdBy: req.userId, lastActivity: new Date(),
        });
        await ChatMember.insertMany([
            { chat: chat._id, user: req.userId,   school: req.schoolId, role: 'admin' },
            { chat: chat._id, user: targetUserId, school: req.schoolId, role: 'member' },
        ]);

        await broker.publishMembership('join', req.userId, chat._id);
        await broker.publishMembership('join', targetUserId, chat._id);

        res.status(201).json({ success: true, data: chat.toObject() });
    } catch (err) {
        console.error('[chatCtrl] createDirectChat:', err);
        res.status(500).json({ success: false, message: 'Failed to create chat' });
    }
};

// ─── Create group ─────────────────────────────────────────────────────────────

/** POST /api/chat/group  body: { name, description, memberIds[], isReadOnly, type } */
exports.createGroup = async (req, res) => {
    try {
        const { name, description = '', isReadOnly = false } = req.body;
        let   { memberIds, type = 'group' }                  = req.body;

        if (!perm.canCreateGroup(req.userRole)) {
            return res.status(403).json({ success: false, message: 'You cannot create groups' });
        }
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Group name is required' });
        }

        if (typeof memberIds === 'string') {
            try { memberIds = JSON.parse(memberIds); } catch { memberIds = []; }
        }
        memberIds = (Array.isArray(memberIds) ? memberIds : [])
            .map(String)
            .filter(id => id !== String(req.userId));

        // Validate every proposed member
        for (const memberId of memberIds) {
            const rx = await User.findOne({ _id: memberId, school: req.schoolId }).select('name role').lean();
            if (!rx) continue;
            const c = await perm.canMessage(req.userId, req.userRole, memberId, rx.role, req.schoolId);
            if (!c.allowed) {
                return res.status(403).json({
                    success: false,
                    message: `Cannot add ${rx.name}: ${c.reason}`,
                });
            }
        }

        const chatType = type === 'broadcast' ? 'broadcast' : 'group';
        const chat = await Chat.create({
            school:      req.schoolId,
            type:        chatType,
            name:        name.trim(),
            description,
            createdBy:   req.userId,
            isReadOnly:  isReadOnly === true || isReadOnly === 'true',
            lastActivity: new Date(),
        });

        const allMembers = [String(req.userId), ...memberIds];
        await ChatMember.insertMany(
            allMembers.map(mid => ({
                chat:   chat._id,
                user:   mid,
                school: req.schoolId,
                role:   mid === String(req.userId) ? 'admin' : 'member',
            }))
        );

        for (const mid of allMembers) await broker.publishMembership('join', mid, chat._id);
        await broker.publishToRoom(chat._id, 'chat:group_created', {
            chatId: chat._id, name: chat.name, type: chat.type,
        });

        res.status(201).json({ success: true, data: chat.toObject() });
    } catch (err) {
        console.error('[chatCtrl] createGroup:', err);
        res.status(500).json({ success: false, message: 'Failed to create group' });
    }
};

// ─── Contacts ─────────────────────────────────────────────────────────────────

/** GET /api/chat/contacts?q=<search> */
exports.getContacts = async (req, res) => {
    try {
        const { q } = req.query;
        let contacts = await perm.getAllowedContacts(req.userId, req.userRole, req.schoolId);
        if (q) {
            const s = q.toLowerCase();
            contacts = contacts.filter(
                c => c.name.toLowerCase().includes(s) || c.role.toLowerCase().includes(s)
            );
        }
        res.json({ success: true, data: contacts });
    } catch (err) {
        console.error('[chatCtrl] getContacts:', err);
        res.status(500).json({ success: false, message: 'Failed to load contacts' });
    }
};

// ─── Message search ───────────────────────────────────────────────────────────

/** GET /api/chat/search?q=<text>&chatId=<optional> */
exports.searchMessages = async (req, res) => {
    try {
        const { q, chatId } = req.query;

        if (!q || q.trim().length < 2) return res.json({ success: true, data: [] });

        const memberships = await ChatMember.find({ user: req.userId, school: req.schoolId, isActive: true })
            .select('chat').lean();
        const chatIds = memberships.map(m => m.chat);

        const filter = {
            school:    req.schoolId,
            chat:      chatId ? chatId : { $in: chatIds },
            isDeleted: false,
            $text:     { $search: q.trim() },
        };

        const msgs = await Message.find(filter, { score: { $meta: 'textScore' } })
            .populate('sender', 'name role profileImage')
            .populate('chat', 'name type')
            .sort({ score: { $meta: 'textScore' } })
            .limit(30)
            .lean();

        res.json({ success: true, data: msgs });
    } catch (err) {
        console.error('[chatCtrl] searchMessages:', err);
        res.status(500).json({ success: false, message: 'Search failed' });
    }
};

// ─── Edit / Delete messages ───────────────────────────────────────────────────

/** PATCH /api/chat/messages/:msgId  body: { content } */
exports.editMessage = async (req, res) => {
    try {
        const { msgId }   = req.params;
        const { content } = req.body;

        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, message: 'Content required' });
        }

        const msg = await Message.findOne({ _id: msgId, sender: req.userId, isDeleted: false }).lean();
        if (!msg) return res.status(403).json({ success: false, message: 'Not authorised' });

        if (Date.now() - new Date(msg.createdAt).getTime() > 86_400_000) {
            return res.status(400).json({ success: false, message: 'Cannot edit messages older than 24 hours' });
        }

        const now = new Date();
        await Message.findByIdAndUpdate(msgId, {
            content: content.trim(), isEdited: true, editedAt: now,
            // Keep the version we're replacing for the admin audit trail
            $push: { editHistory: { content: msg.content, editedAt: now } },
        });

        await broker.publishToRoom(msg.chat, 'chat:message_edited', {
            messageId: msgId, chatId: String(msg.chat),
            content: content.trim(), editedAt: now,
            // Prev content only reaches admin clients (they already hold it) —
            // non-admin clients ignore it. Kept out of persisted socket payload.
            previousContent: msg.content,
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[chatCtrl] editMessage:', err);
        res.status(500).json({ success: false, message: 'Failed to edit' });
    }
};

/** DELETE /api/chat/messages/:msgId */
exports.deleteMessage = async (req, res) => {
    try {
        const { msgId } = req.params;

        const msg = await Message.findOne({ _id: msgId, isDeleted: false }).lean();
        if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });

        const isOwner = String(msg.sender) === String(req.userId);
        const isAdmin = ['school_admin', 'super_admin'].includes(req.userRole);
        if (!isOwner && !isAdmin) {
            return res.status(403).json({ success: false, message: 'Not authorised' });
        }

        await Message.findByIdAndUpdate(msgId, {
            isDeleted: true, deletedAt: new Date(), deletedBy: req.userId,
        });

        await broker.publishToRoom(msg.chat, 'chat:message_deleted', {
            messageId: msgId, chatId: String(msg.chat),
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[chatCtrl] deleteMessage:', err);
        res.status(500).json({ success: false, message: 'Failed to delete' });
    }
};

/** POST /api/chat/messages/:msgId/react  { emoji } */
exports.toggleReaction = async (req, res) => {
    try {
        const { msgId } = req.params;
        const { emoji } = req.body;
        const userName  = req.user?.name || '';

        if (!emoji) return res.status(400).json({ success: false, message: 'emoji required' });

        const msg = await Message.findOne({ _id: msgId, isDeleted: false }).lean();
        if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });

        const existing = (msg.reactions || []).find(r => String(r.user) === String(req.userId));
        let update;
        if (existing && existing.emoji === emoji) {
            update = { $pull: { reactions: { user: req.userId } } };
        } else if (existing) {
            await Message.findByIdAndUpdate(msgId, { $pull: { reactions: { user: req.userId } } });
            update = { $push: { reactions: { emoji, user: req.userId, userName } } };
        } else {
            update = { $push: { reactions: { emoji, user: req.userId, userName } } };
        }

        const updated = await Message.findByIdAndUpdate(msgId, update, { new: true }).lean();

        await broker.publishToRoom(msg.chat, 'chat:reaction', {
            messageId: msgId, chatId: String(msg.chat), reactions: updated.reactions,
        });

        res.json({ success: true, data: updated.reactions });
    } catch (err) {
        console.error('[chatCtrl] toggleReaction:', err);
        res.status(500).json({ success: false, message: 'Failed' });
    }
};

// ─── Group management ─────────────────────────────────────────────────────────

/** PATCH /api/chat/group/:chatId/settings  body: { name, description, isReadOnly } */
exports.updateGroupSettings = async (req, res) => {
    try {
        const { chatId }                        = req.params;
        const { name, description, isReadOnly } = req.body;

        const adminCheck = await ChatMember.findOne({
            chat: chatId, user: req.userId, role: 'admin', isActive: true,
        }).lean();
        if (!adminCheck) {
            return res.status(403).json({ success: false, message: 'Only group admins can update settings' });
        }

        const update = {};
        if (name !== undefined)        update.name        = name.trim();
        if (description !== undefined) update.description = description;
        if (isReadOnly !== undefined)  update.isReadOnly  = isReadOnly === true || isReadOnly === 'true';

        await Chat.findByIdAndUpdate(chatId, update);

        await broker.publishToRoom(chatId, 'chat:group_updated', { chatId, ...update });

        res.json({ success: true });
    } catch (err) {
        console.error('[chatCtrl] updateGroupSettings:', err);
        res.status(500).json({ success: false, message: 'Failed to update group' });
    }
};

/** POST /api/chat/group/:chatId/member  body: { memberId } */
exports.addMember = async (req, res) => {
    try {
        const { chatId }   = req.params;
        const { memberId } = req.body;

        if (!memberId) return res.status(400).json({ success: false, message: 'memberId required' });

        const adminCheck = await ChatMember.findOne({
            chat: chatId, user: req.userId, role: 'admin', isActive: true,
        }).lean();
        if (!adminCheck) {
            return res.status(403).json({ success: false, message: 'Only group admins can add members' });
        }

        const existing = await ChatMember.findOne({ chat: chatId, user: memberId }).lean();
        if (existing) {
            if (existing.isActive) {
                return res.status(400).json({ success: false, message: 'User is already a member' });
            }
            await ChatMember.findByIdAndUpdate(existing._id, { isActive: true });
        } else {
            const rx = await User.findOne({ _id: memberId, school: req.schoolId }).select('role').lean();
            if (!rx) return res.status(404).json({ success: false, message: 'User not found' });
            const c = await perm.canMessage(req.userId, req.userRole, memberId, rx.role, req.schoolId);
            if (!c.allowed) return res.status(403).json({ success: false, message: c.reason });
            await ChatMember.create({ chat: chatId, user: memberId, school: req.schoolId, role: 'member' });
        }

        await broker.publishMembership('join', memberId, chatId);
        await broker.publishToRoom(chatId, 'chat:member_added', { chatId, userId: memberId });

        res.json({ success: true });
    } catch (err) {
        console.error('[chatCtrl] addMember:', err);
        res.status(500).json({ success: false, message: 'Failed to add member' });
    }
};

/** DELETE /api/chat/group/:chatId/member/:memberId */
exports.removeMember = async (req, res) => {
    try {
        const { chatId, memberId } = req.params;

        if (String(memberId) !== String(req.userId)) {
            const check = await ChatMember.findOne({
                chat: chatId, user: req.userId, role: 'admin', isActive: true,
            }).lean();
            if (!check) return res.status(403).json({ success: false, message: 'Only admins can remove members' });
        }

        await ChatMember.findOneAndUpdate({ chat: chatId, user: memberId }, { isActive: false });

        await broker.publishMembership('leave', memberId, chatId);
        await broker.publishToRoom(chatId, 'chat:member_removed', { chatId, userId: memberId });

        res.json({ success: true });
    } catch (err) {
        console.error('[chatCtrl] removeMember:', err);
        res.status(500).json({ success: false, message: 'Failed to remove member' });
    }
};

// ─── Mute / Archive ───────────────────────────────────────────────────────────

/** POST /api/chat/:chatId/mute  body: { muteUntil? } */
exports.toggleMute = async (req, res) => {
    try {
        const { chatId }    = req.params;
        const { muteUntil } = req.body || {};

        const member = await ChatMember.findOne({ chat: chatId, user: req.userId }).lean();
        if (!member) return res.status(403).json({ success: false, message: 'Not a member' });

        const update = member.isMuted
            ? { isMuted: false, muteUntil: null }
            : { isMuted: true,  muteUntil: muteUntil ? new Date(muteUntil) : null };

        await ChatMember.findOneAndUpdate({ chat: chatId, user: req.userId }, update);
        res.json({ success: true, data: { isMuted: !member.isMuted } });
    } catch (err) {
        console.error('[chatCtrl] toggleMute:', err);
        res.status(500).json({ success: false, message: 'Failed to toggle mute' });
    }
};

/** POST /api/chat/:chatId/archive */
exports.toggleArchive = async (req, res) => {
    try {
        const { chatId } = req.params;

        const member = await ChatMember.findOne({ chat: chatId, user: req.userId }).lean();
        if (!member) return res.status(403).json({ success: false, message: 'Not a member' });

        await ChatMember.findOneAndUpdate({ chat: chatId, user: req.userId }, {
            isArchived: !member.isArchived,
        });
        res.json({ success: true, data: { isArchived: !member.isArchived } });
    } catch (err) {
        console.error('[chatCtrl] toggleArchive:', err);
        res.status(500).json({ success: false, message: 'Failed to toggle archive' });
    }
};

// ─── File upload ──────────────────────────────────────────────────────────────

/** POST /api/chat/upload  multipart: file */
exports.uploadFile = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        const isImage = req.file.mimetype.startsWith('image/');
        res.json({
            success: true,
            data: {
                attachment: {
                    originalName: req.file.originalname,
                    fileName:     req.file.filename,
                    fileUrl:      `/uploads/chat/${req.file.filename}`,
                    fileType:     req.file.mimetype,
                    fileSize:     req.file.size,
                },
                type: isImage ? 'image' : 'file',
            },
        });
    } catch (err) {
        console.error('[chatCtrl] uploadFile:', err);
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
};

// Total unread across every chat the user belongs to, in one query — each
// chat has its own lastReadAt cutoff, so we OR together one (chat, cutoff)
// condition per membership instead of looping a countDocuments per chat.
async function totalUnreadForUser(userId, schoolId) {
    const memberships = await ChatMember.find({
        user: userId, school: schoolId, isActive: true, isMuted: false,
    }).select('chat lastReadAt').lean();
    if (!memberships.length) return 0;

    return Message.countDocuments({
        sender:    { $ne: userId },
        isDeleted: false,
        $or: memberships.map((m) => ({ chat: m.chat, createdAt: { $gt: m.lastReadAt || new Date(0) } })),
    });
}

// ─── Unread count (for topbar badge) ─────────────────────────────────────────

/** GET /api/chat/unread-count */
exports.getUnreadCount = async (req, res) => {
    try {
        const total = await totalUnreadForUser(req.userId, req.schoolId);
        res.json({ success: true, data: { count: total } });
    } catch {
        res.json({ success: true, data: { count: 0 } });
    }
};

// ─── Presence heartbeat + unread badge ────────────────────────────────────────

/** POST /api/chat/heartbeat — refresh my presence, return total unread count */
exports.heartbeat = async (req, res) => {
    try {
        await User.updateOne({ _id: req.userId }, { lastSeenAt: new Date() });
        const unread = await totalUnreadForUser(req.userId, req.schoolId);
        res.json({ success: true, data: { unread } });
    } catch {
        res.json({ success: true, data: { unread: 0 } });
    }
};

// ─── Chat members (group member list) ─────────────────────────────────────────

/** GET /api/chat/chats/:chatId/members */
exports.getChatMembers = async (req, res) => {
    try {
        const { chatId } = req.params;

        const me = await ChatMember.findOne({ chat: chatId, user: req.userId, isActive: true }).lean();
        const adminObserver = !me && req.userRole === 'school_admin';
        if (!me && !adminObserver) return res.status(403).json({ success: false, message: 'Not a member' });

        const members = await ChatMember.find({ chat: chatId, isActive: true })
            .populate('user', 'name role profileImage email')
            .lean();

        res.json({ success: true, data: members });
    } catch (err) {
        console.error('[chatCtrl] getChatMembers:', err);
        res.status(500).json({ success: false, message: 'Failed to load members' });
    }
};

// ─── Admin: browse school users / oversight ───────────────────────────────────

/** GET /api/chat/admin/school-users?q=<search>  — school_admin only */
exports.getSchoolUsers = async (req, res) => {
    try {
        if (req.userRole !== 'school_admin') {
            return res.status(403).json({ success: false, message: 'Admin only' });
        }
        const q      = (req.query.q || '').trim();
        const filter = { school: req.schoolId };
        if (q) filter.name = { $regex: q, $options: 'i' };

        const users = await User.find(filter)
            .select('name role profileImage')
            .limit(40)
            .lean();

        res.json({ success: true, data: users });
    } catch (err) {
        console.error('[chatCtrl] getSchoolUsers:', err);
        res.status(500).json({ success: false, message: 'Failed' });
    }
};

/** GET /api/chat/admin/user-chats?userId=<id>  — school_admin only */
exports.getAdminUserChats = async (req, res) => {
    try {
        if (req.userRole !== 'school_admin') {
            return res.status(403).json({ success: false, message: 'Admin only' });
        }
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ success: false, message: 'userId required' });

        const targetUser = await User.findOne({ _id: userId, school: req.schoolId }).select('name role').lean();
        if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });

        const memberships = await ChatMember.find({
            user: userId, school: req.schoolId, isActive: true,
        })
        .populate({
            path: 'chat',
            populate: {
                path: 'lastMessage',
                select: 'content type sender isDeleted createdAt',
                populate: { path: 'sender', select: 'name' },
            },
        })
        .lean();

        const results = await Promise.all(
            memberships
                .filter(m => m.chat && m.chat._id)
                .map(m => _enrichChat(m, userId, req.schoolId))
        );

        results.sort((a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0));

        res.json({ success: true, data: { chats: results, user: targetUser } });
    } catch (err) {
        console.error('[chatCtrl] getAdminUserChats:', err);
        res.status(500).json({ success: false, message: 'Failed' });
    }
};
