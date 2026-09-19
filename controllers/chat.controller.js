'use strict';
/**
 * Chat HTTP endpoints.
 *
 * Thin by design: reads go through services/chatReadModel (raw SQL), every
 * message write through services/chatMessageService (the same writer the
 * WebSocket gateway reaches via /internal/chat/*), and every "may A talk to B"
 * question through services/chatPermissionService.
 *
 * Response shapes are the ones the web page and the Expo app already read;
 * new fields are only ever added.
 */
const Chat       = require('../models/Chat');
const ChatMember = require('../models/ChatMember');
const User       = require('../models/User');
const pool       = require('../db/pool');
const perm       = require('../services/chatPermissionService');
const broker     = require('../services/chatBrokerService');
const readModel  = require('../services/chatReadModel');
const writer     = require('../services/chatMessageService');
const classGroups = require('../services/classGroupService');

const { ChatError, actorFromRequest } = writer;

const isSchoolAdmin = (req) => req.userRole === 'school_admin';

function fail(res, err, fallback, tag) {
    if (err instanceof ChatError) {
        return res.status(err.status).json({ success: false, message: err.message, ...(err.code && { code: err.code }) });
    }
    console.error(`[chatCtrl] ${tag}:`, err);
    return res.status(500).json({ success: false, message: fallback });
}

/**
 * The caller's membership, or — for a school admin — read-only access to any
 * conversation in their own school. Anything else is a 403/404.
 */
async function accessTo(req, chatId) {
    const member = await ChatMember.findOne({ chat: chatId, user: req.userId, school: req.schoolId, isActive: true }).lean();
    if (member) return { member, observer: false };
    if (!isSchoolAdmin(req)) throw new ChatError(403, 'You are not a member of this conversation');
    const chat = await Chat.findOne({ _id: chatId, school: req.schoolId }).select('_id').lean();
    if (!chat) throw new ChatError(404, 'Conversation not found');
    return { member: null, observer: true };
}

const joinRoom = (userIds, chatId) =>
    Promise.all(userIds.map((uid) => broker.publishMembership('join', uid, chatId).catch(() => {})));

// ─── Chat list ────────────────────────────────────────────────────────────────

/** GET /api/chat/chats */
exports.getChats = async (req, res) => {
    try {
        // A student is in every class/subject group of their section — joined
        // here, as they open chat, rather than by hooking every place a student
        // can change section.
        if (req.userRole === 'student') {
            await classGroups.joinMyClassGroups(req.userId, req.schoolId).catch((e) => console.error('[chatCtrl] joinMyClassGroups:', e.message));
        }
        const data = await readModel.listChats(req.userId, req.schoolId, { isAdmin: isSchoolAdmin(req) });
        res.json({ success: true, data });
    } catch (err) { fail(res, err, 'Failed to load chats', 'getChats'); }
};

/** GET /api/chat/chats/:chatId — one list row, for a conversation the page has not seen yet */
exports.getChat = async (req, res) => {
    try {
        const data = await readModel.chatSummary(req.userId, req.schoolId, req.params.chatId, { isAdmin: isSchoolAdmin(req) });
        if (!data) return res.status(404).json({ success: false, message: 'Conversation not found' });
        res.json({ success: true, data });
    } catch (err) { fail(res, err, 'Failed to load chat', 'getChat'); }
};

/** GET /api/chat/chats/:chatId/profile — thread header + info panel */
exports.getChatProfile = async (req, res) => {
    try {
        await accessTo(req, req.params.chatId);
        const chat = await Chat.findOne({ _id: req.params.chatId, school: req.schoolId }).lean();
        if (!chat) return res.status(404).json({ success: false, message: 'Conversation not found' });
        if (classGroups.isClassGroup(chat)) await classGroups.reconcileSoon(chat).catch((e) => console.error('[chatCtrl] reconcile:', e.message));

        const data = await readModel.chatProfile(req.params.chatId, req.schoolId, req.userId);
        if (!data) return res.status(404).json({ success: false, message: 'Conversation not found' });
        if (classGroups.isClassGroup(chat)) data.manage = await classGroups.manageInfo(chat, req.userId, data.members || []);
        res.json({ success: true, data });
    } catch (err) { fail(res, err, 'Failed to load details', 'getChatProfile'); }
};

// ─── Messages ─────────────────────────────────────────────────────────────────

/** GET /api/chat/chats/:chatId/messages?before=<iso>|after=<iso>&limit=40 */
exports.getMessages = async (req, res) => {
    try {
        const { chatId } = req.params;
        const { before, after, limit } = req.query;
        const { member, observer } = await accessTo(req, chatId);

        const { messages, hasMore } = await readModel.messagesPage(chatId, req.schoolId, {
            before, after, limit, isAdmin: isSchoolAdmin(req),
        });

        // Opening a conversation is reading it. Scrolling back (before=) reads
        // nothing new, a reconnect catch-up (after=) may be for a conversation
        // that is not on screen, and observers are not members.
        if (member && !before && !after && messages.length) {
            writer.markRead(actorFromRequest(req), chatId).catch(() => {});
        }

        res.json({ success: true, data: messages, hasMore, observer });
    } catch (err) { fail(res, err, 'Failed to load messages', 'getMessages'); }
};

/** POST /api/chat/chats/:chatId/messages  { content, type, replyTo, attachments, clientId|tempId, isForwarded } */
exports.sendMessage = async (req, res) => {
    try {
        const { message, duplicate } = await writer.send(actorFromRequest(req), req.params.chatId, req.body || {});
        res.status(duplicate ? 200 : 201).json({ success: true, data: message });
    } catch (err) { fail(res, err, 'Failed to send message', 'sendMessage'); }
};

/** POST /api/chat/chats/:chatId/read  { messageId? } */
exports.markRead = async (req, res) => {
    try {
        const data = await writer.markRead(actorFromRequest(req), req.params.chatId, req.body?.messageId || null);
        res.json({ success: true, data });
    } catch (err) { fail(res, err, 'Failed to mark read', 'markRead'); }
};

/** PATCH /api/chat/messages/:msgId  { content } */
exports.editMessage = async (req, res) => {
    try {
        const data = await writer.edit(actorFromRequest(req), req.params.msgId, req.body?.content);
        res.json({ success: true, data });
    } catch (err) { fail(res, err, 'Failed to edit', 'editMessage'); }
};

/** DELETE /api/chat/messages/:msgId */
exports.deleteMessage = async (req, res) => {
    try {
        await writer.remove(actorFromRequest(req), req.params.msgId);
        res.json({ success: true });
    } catch (err) { fail(res, err, 'Failed to delete', 'deleteMessage'); }
};

/** POST /api/chat/messages/:msgId/react  { emoji } */
exports.toggleReaction = async (req, res) => {
    try {
        const data = await writer.react(actorFromRequest(req), req.params.msgId, req.body?.emoji);
        res.json({ success: true, data });
    } catch (err) { fail(res, err, 'Failed to react', 'toggleReaction'); }
};

// ─── Members ──────────────────────────────────────────────────────────────────

/** GET /api/chat/chats/:chatId/members */
exports.getChatMembers = async (req, res) => {
    try {
        await accessTo(req, req.params.chatId);
        const members = await ChatMember.find({ chat: req.params.chatId, isActive: true })
            .populate('user', 'name role profileImage email')
            .lean();
        res.json({ success: true, data: members });
    } catch (err) { fail(res, err, 'Failed to load members', 'getChatMembers'); }
};

// ─── Contacts ─────────────────────────────────────────────────────────────────

/**
 * GET /api/chat/contacts?q=&role=&limit=
 *
 * Everyone the caller may start a conversation with, each with a short line
 * (subjects, class, whose parent). A school admin may reach the whole school,
 * so that one list is searched and cut in SQL; without `limit` it stays whole,
 * which is what the Expo app's client-side filter expects.
 */
exports.getContacts = async (req, res) => {
    try {
        const q     = String(req.query.q || '').trim();
        const role  = ['teacher', 'student', 'parent', 'school_admin'].includes(req.query.role) ? req.query.role : null;
        const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500) : null;

        let contacts;
        if (isSchoolAdmin(req)) {
            const params = [String(req.schoolId), String(req.userId), q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null, role];
            const { rows } = await pool.query(
                `SELECT "_id", "name", "role", "email", "profileImage" FROM "users"
                  WHERE "school" = $1::uuid AND "_id" <> $2::uuid AND "isActive" = true
                    AND "role" IN ('teacher', 'student', 'parent', 'school_admin')
                    AND ($3::text IS NULL OR "name" ILIKE $3 OR "email" ILIKE $3)
                    AND ($4::text IS NULL OR "role" = $4::text)
                  ORDER BY "name"
                  ${limit ? `LIMIT ${limit}` : ''}`,
                params,
            );
            contacts = rows.map((r) => ({ ...r, _id: String(r._id) }));
        } else {
            contacts = await perm.getAllowedContacts(req.userId, req.userRole, req.schoolId);
            if (q) {
                const s = q.toLowerCase();
                contacts = contacts.filter((c) => (c.name || '').toLowerCase().includes(s) || (c.role || '').toLowerCase().includes(s));
            }
            if (role) contacts = contacts.filter((c) => c.role === role);
            contacts.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            if (limit) contacts = contacts.slice(0, limit);
        }

        const lines = await readModel.contactLines(contacts.map((c) => c._id), req.schoolId);
        res.json({ success: true, data: contacts.map((c) => ({ ...c, _id: String(c._id), line: lines.get(String(c._id)) || '' })) });
    } catch (err) { fail(res, err, 'Failed to load contacts', 'getContacts'); }
};

// ─── Search / unread / heartbeat ──────────────────────────────────────────────

/** GET /api/chat/search?q=<text>&chatId=<optional> */
exports.searchMessages = async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ success: true, data: [] });
        const data = await readModel.searchMessages(req.userId, req.schoolId, q, { chatId: req.query.chatId || null });
        res.json({ success: true, data });
    } catch (err) { fail(res, err, 'Search failed', 'searchMessages'); }
};

/** GET /api/chat/unread-count */
exports.getUnreadCount = async (req, res) => {
    try {
        res.json({ success: true, data: { count: await readModel.unreadTotal(req.userId, req.schoolId) } });
    } catch {
        res.json({ success: true, data: { count: 0 } });
    }
};

/** POST /api/chat/heartbeat — refresh my presence, return total unread count */
exports.heartbeat = async (req, res) => {
    try {
        await User.updateOne({ _id: req.userId }, { lastSeenAt: new Date() });
        res.json({ success: true, data: { unread: await readModel.unreadTotal(req.userId, req.schoolId) } });
    } catch {
        res.json({ success: true, data: { unread: 0 } });
    }
};

// ─── Create chats ─────────────────────────────────────────────────────────────

/** POST /api/chat/direct  { targetUserId } — opens the existing conversation when there is one */
exports.createDirectChat = async (req, res) => {
    try {
        const targetUserId = req.body.targetUserId || req.body.receiverId;
        if (!targetUserId) return res.status(400).json({ success: false, message: 'targetUserId required' });
        if (String(targetUserId) === String(req.userId)) {
            return res.status(400).json({ success: false, message: 'Cannot chat with yourself' });
        }

        const receiver = await User.findOne({ _id: targetUserId, school: req.schoolId, isActive: true }).select('role').lean();
        if (!receiver) return res.status(404).json({ success: false, message: 'User not found' });

        const check = await perm.canMessage(req.userId, req.userRole, targetUserId, receiver.role, req.schoolId);
        if (!check.allowed) return res.status(403).json({ success: false, message: check.reason });

        const { rows } = await pool.query(
            `SELECT c."_id" FROM "chats" c
               JOIN "chatmembers" a ON a."chat" = c."_id" AND a."user" = $1::uuid
               JOIN "chatmembers" b ON b."chat" = c."_id" AND b."user" = $2::uuid
              WHERE c."school" = $3::uuid AND c."type" = 'direct'
              ORDER BY c."lastActivity" DESC NULLS LAST LIMIT 1`,
            [String(req.userId), String(targetUserId), String(req.schoolId)],
        );

        let chatId = rows[0]?._id;
        let created = false;
        if (chatId) {
            // A direct conversation is never really left — bring either side back.
            await ChatMember.updateMany({ chat: chatId, user: { $in: [req.userId, targetUserId] } }, { isActive: true });
        } else {
            const chat = await Chat.create({ school: req.schoolId, type: 'direct', createdBy: req.userId, lastActivity: new Date() });
            chatId = chat._id;
            created = true;
            await ChatMember.insertMany([
                { chat: chatId, user: req.userId,   school: req.schoolId, role: 'admin' },
                { chat: chatId, user: targetUserId, school: req.schoolId, role: 'member' },
            ]);
        }
        await joinRoom([req.userId, targetUserId], chatId);

        const data = await readModel.chatSummary(req.userId, req.schoolId, chatId, { isAdmin: isSchoolAdmin(req) });
        res.status(created ? 201 : 200).json({ success: true, data });
    } catch (err) { fail(res, err, 'Failed to create chat', 'createDirectChat'); }
};

function parseIds(v) {
    let ids = v;
    if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = [ids]; } }
    return [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
}

/** Every proposed member must be someone the caller may message. */
async function vetMembers(req, ids) {
    if (!ids.length) return [];
    const users = await User.find({ _id: { $in: ids }, school: req.schoolId, isActive: true }).select('name role').lean();
    for (const u of users) {
        const c = await perm.canMessage(req.userId, req.userRole, u._id, u.role, req.schoolId);
        if (!c.allowed) throw new ChatError(403, `Cannot add ${u.name}: ${c.reason}`);
    }
    return users.map((u) => String(u._id));
}

/**
 * A teacher's own groups are staff groups. Students (and their parents) are
 * reached through a class group or a subject group, whose membership follows
 * the school's records — otherwise a subject teacher could build a class group
 * with any teacher they liked in it, which is exactly what those rules forbid.
 */
async function staffOnly(req, ids) {
    if (!ids.length) return;
    const users = await User.find({ _id: { $in: ids }, school: req.schoolId }).select('name role').lean();
    const outsider = users.find((u) => !['teacher', 'school_admin'].includes(u.role));
    if (outsider) {
        throw new ChatError(403, `${outsider.name} can’t be added here — students join through a class group or a subject group`);
    }
}

/** POST /api/chat/group  { name, description, memberIds[], isReadOnly, type } */
exports.createGroup = async (req, res) => {
    try {
        const { description = '', isReadOnly = false, type = 'group' } = req.body;
        const name = String(req.body.name || '').trim();

        if (!perm.canCreateGroup(req.userRole)) throw new ChatError(403, 'You cannot create groups');
        if (!name) throw new ChatError(400, 'Group name is required');
        if (name.length > 80) throw new ChatError(400, 'Group names are limited to 80 characters');

        const wanted = parseIds(req.body.memberIds).filter((id) => id !== String(req.userId));
        if (req.userRole === 'teacher') await staffOnly(req, wanted);
        const memberIds = await vetMembers(req, wanted);
        if (!memberIds.length) throw new ChatError(400, 'Add at least one member');

        const chat = await Chat.create({
            school:       req.schoolId,
            type:         type === 'broadcast' ? 'broadcast' : 'group',
            name,
            description:  String(description || '').trim().slice(0, 300),
            createdBy:    req.userId,
            isReadOnly:   isReadOnly === true || isReadOnly === 'true' || type === 'broadcast',
            lastActivity: new Date(),
        });
        const everyone = [String(req.userId), ...memberIds];
        await ChatMember.insertMany(everyone.map((uid) => ({
            chat: chat._id, user: uid, school: req.schoolId, role: uid === String(req.userId) ? 'admin' : 'member',
        })));

        await joinRoom(everyone, chat._id);
        broker.publishToRoom(chat._id, 'chat:group_created', { chatId: String(chat._id), name: chat.name, type: chat.type }).catch(() => {});

        const data = await readModel.chatSummary(req.userId, req.schoolId, chat._id, { isAdmin: isSchoolAdmin(req) });
        res.status(201).json({ success: true, data });
    } catch (err) { fail(res, err, 'Failed to create group', 'createGroup'); }
};

// ─── Group management ─────────────────────────────────────────────────────────

async function requireGroupAdmin(req, chatId) {
    const [me, chat] = await Promise.all([
        ChatMember.findOne({ chat: chatId, user: req.userId, school: req.schoolId, role: 'admin', isActive: true }).lean(),
        Chat.findOne({ _id: chatId, school: req.schoolId }).lean(),
    ]);
    if (!chat) throw new ChatError(404, 'Conversation not found');
    if (chat.type === 'direct') throw new ChatError(400, 'This is not a group');
    if (!me) throw new ChatError(403, 'Only group admins can do that');
    return chat;
}

/** PATCH /api/chat/group/:chatId/settings  { name, description, isReadOnly } */
exports.updateGroupSettings = async (req, res) => {
    try {
        const { chatId } = req.params;
        await requireGroupAdmin(req, chatId);
        const { name, description, isReadOnly } = req.body;

        const update = {};
        if (name !== undefined) {
            const n = String(name).trim();
            if (!n) throw new ChatError(400, 'Group name is required');
            update.name = n.slice(0, 80);
        }
        if (description !== undefined) update.description = String(description || '').trim().slice(0, 300);
        if (isReadOnly !== undefined)  update.isReadOnly = isReadOnly === true || isReadOnly === 'true';

        await Chat.findByIdAndUpdate(chatId, update);
        broker.publishToRoom(chatId, 'chat:group_updated', { chatId: String(chatId), ...update }).catch(() => {});
        res.json({ success: true, data: update });
    } catch (err) { fail(res, err, 'Failed to update group', 'updateGroupSettings'); }
};

/** POST /api/chat/group/:chatId/member  { memberId } | { memberIds: [] } */
exports.addMember = async (req, res) => {
    try {
        const { chatId } = req.params;
        const chat = await requireGroupAdmin(req, chatId);
        const wanted = parseIds(req.body.memberIds || req.body.memberId);
        if (!wanted.length) throw new ChatError(400, 'memberId required');
        if (classGroups.isClassGroup(chat)) await classGroups.assertCanAdd(chat, wanted);
        else if (req.userRole === 'teacher') await staffOnly(req, wanted);

        const existing = await ChatMember.find({ chat: chatId, user: { $in: wanted } }).lean();
        const byUser = new Map(existing.map((m) => [String(m.user), m]));
        const fresh = wanted.filter((id) => !byUser.get(id)?.isActive);
        if (!fresh.length) throw new ChatError(400, wanted.length === 1 ? 'Already a member' : 'Everyone picked is already a member');

        // Class/subject groups were vetted against the section's records above.
        const allowed = classGroups.isClassGroup(chat) ? fresh : await vetMembers(req, fresh);
        for (const uid of allowed) {
            const row = byUser.get(uid);
            if (row) await ChatMember.findByIdAndUpdate(row._id, { isActive: true, role: 'member', joinedAt: new Date() });
            else await ChatMember.create({ chat: chatId, user: uid, school: req.schoolId, role: 'member' });
        }
        await joinRoom(allowed, chatId);
        for (const uid of allowed) {
            broker.publishToRoom(chatId, 'chat:member_added', { chatId: String(chatId), userId: uid }).catch(() => {});
        }
        res.json({ success: true, data: { added: allowed.length } });
    } catch (err) { fail(res, err, 'Failed to add member', 'addMember'); }
};

/** DELETE /api/chat/group/:chatId/member/:memberId — an admin removing someone, or anyone leaving */
exports.removeMember = async (req, res) => {
    try {
        const { chatId, memberId } = req.params;
        const leaving = String(memberId) === String(req.userId);
        if (!leaving) await requireGroupAdmin(req, chatId);

        const row = await ChatMember.findOne({ chat: chatId, user: memberId, school: req.schoolId, isActive: true }).lean();
        if (!row) throw new ChatError(404, 'Not a member');
        const chat = await Chat.findOne({ _id: chatId, school: req.schoolId }).lean();
        if (classGroups.isClassGroup(chat)) await classGroups.assertCanRemove(chat, memberId, { leaving });
        await ChatMember.findByIdAndUpdate(row._id, { isActive: false });

        // The last admin walking out would leave a group nobody can manage —
        // hand it to whoever has been in it longest.
        if (row.role === 'admin') {
            const admins = await ChatMember.countDocuments({ chat: chatId, isActive: true, role: 'admin' });
            if (!admins) {
                const heir = await ChatMember.findOne({ chat: chatId, isActive: true }).sort({ joinedAt: 1 }).lean();
                if (heir) await ChatMember.findByIdAndUpdate(heir._id, { role: 'admin' });
            }
        }

        broker.publishToRoom(chatId, 'chat:member_removed', { chatId: String(chatId), userId: String(memberId) }).catch(() => {});
        broker.publishMembership('leave', memberId, chatId).catch(() => {});
        res.json({ success: true });
    } catch (err) { fail(res, err, 'Failed to remove member', 'removeMember'); }
};

// ─── Mute / archive ───────────────────────────────────────────────────────────

/** POST /api/chat/:chatId/mute  { muteUntil? } */
exports.toggleMute = async (req, res) => {
    try {
        const { chatId } = req.params;
        const member = await ChatMember.findOne({ chat: chatId, user: req.userId, school: req.schoolId, isActive: true }).lean();
        if (!member) throw new ChatError(403, 'Not a member');
        const muteUntil = req.body?.muteUntil ? new Date(req.body.muteUntil) : null;
        const update = member.isMuted
            ? { isMuted: false, muteUntil: null }
            : { isMuted: true, muteUntil: muteUntil && !Number.isNaN(muteUntil.getTime()) ? muteUntil : null };
        await ChatMember.updateOne({ _id: member._id }, update);
        broker.publishToUser(req.userId, 'chat:prefs', { chatId: String(chatId), isMuted: update.isMuted }).catch(() => {});
        res.json({ success: true, data: { isMuted: update.isMuted } });
    } catch (err) { fail(res, err, 'Failed to toggle mute', 'toggleMute'); }
};

/** POST /api/chat/:chatId/archive */
exports.toggleArchive = async (req, res) => {
    try {
        const { chatId } = req.params;
        const member = await ChatMember.findOne({ chat: chatId, user: req.userId, school: req.schoolId, isActive: true }).lean();
        if (!member) throw new ChatError(403, 'Not a member');
        await ChatMember.updateOne({ _id: member._id }, { isArchived: !member.isArchived });
        broker.publishToUser(req.userId, 'chat:prefs', { chatId: String(chatId), isArchived: !member.isArchived }).catch(() => {});
        res.json({ success: true, data: { isArchived: !member.isArchived } });
    } catch (err) { fail(res, err, 'Failed to toggle archive', 'toggleArchive'); }
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
    } catch (err) { fail(res, err, 'Upload failed', 'uploadFile'); }
};

// ─── Admin oversight ──────────────────────────────────────────────────────────

/** GET /api/chat/admin/people?q=&role=&page=&limit= — everyone who has taken part in a conversation */
exports.getAdminPeople = async (req, res) => {
    try {
        if (!isSchoolAdmin(req)) throw new ChatError(403, 'Admin only');
        res.json({ success: true, ...(await readModel.adminPeople(req.schoolId, req.query)) });
    } catch (err) { fail(res, err, 'Failed to load people', 'getAdminPeople'); }
};

/** GET /api/chat/admin/people/:userId — that person's conversations, direct and group */
exports.getAdminPersonChats = async (req, res) => {
    try {
        if (!isSchoolAdmin(req)) throw new ChatError(403, 'Admin only');
        const data = await readModel.adminPersonConversations(req.schoolId, req.params.userId);
        if (!data) throw new ChatError(404, 'User not found');
        res.json({ success: true, data });
    } catch (err) { fail(res, err, 'Failed to load conversations', 'getAdminPersonChats'); }
};

// ─── Class & subject groups (teacher-made) ───────────────────────────────────

/** GET /api/chat/class-groups/options — the class and subject groups this teacher may create */
exports.getClassGroupOptions = async (req, res) => {
    try {
        res.json({ success: true, data: await classGroups.options(actorFromRequest(req)) });
    } catch (err) { fail(res, err, 'Failed to load class groups', 'getClassGroupOptions'); }
};

/** GET /api/chat/class-groups/roster?kind=&sectionId=&subjectId= — who the group would hold */
exports.getClassGroupRoster = async (req, res) => {
    try {
        res.json({ success: true, data: await classGroups.roster(actorFromRequest(req), req.query) });
    } catch (err) { fail(res, err, 'Failed to load the class', 'getClassGroupRoster'); }
};

/** POST /api/chat/class-groups  { kind, sectionId, subjectId?, name, description, isReadOnly, teacherIds[] } */
exports.createClassGroup = async (req, res) => {
    try {
        const { chatId } = await classGroups.create(actorFromRequest(req), req.body || {});
        const data = await readModel.chatSummary(req.userId, req.schoolId, chatId);
        res.status(201).json({ success: true, data });
    } catch (err) {
        if (err instanceof ChatError && err.chatId) {
            return res.status(err.status).json({ success: false, message: err.message, chatId: err.chatId });
        }
        fail(res, err, 'Failed to create the group', 'createClassGroup');
    }
};

/** POST /api/chat/group/:chatId/sync — bring a class/subject group back in step with the section */
exports.syncGroup = async (req, res) => {
    try {
        const chat = await requireGroupAdmin(req, req.params.chatId);
        if (!classGroups.isClassGroup(chat)) throw new ChatError(400, 'Only class and subject groups follow a class roster');
        res.json({ success: true, data: await classGroups.reconcile(chat) });
    } catch (err) { fail(res, err, 'Failed to sync the group', 'syncGroup'); }
};

/** GET /api/chat/group/:chatId/candidates — who may still be added to a class/subject group */
exports.getGroupCandidates = async (req, res) => {
    try {
        const chat = await requireGroupAdmin(req, req.params.chatId);
        if (!classGroups.isClassGroup(chat)) throw new ChatError(400, 'Use contacts for this group');
        res.json({ success: true, data: await classGroups.candidates(chat) });
    } catch (err) { fail(res, err, 'Failed to load candidates', 'getGroupCandidates'); }
};

/** GET /api/chat/admin/school-users?q=<search> */
exports.getSchoolUsers = async (req, res) => {
    try {
        if (!isSchoolAdmin(req)) throw new ChatError(403, 'Admin only');
        const q = (req.query.q || '').trim();
        const filter = { school: req.schoolId };
        if (q) filter.name = { $regex: q, $options: 'i' };
        const users = await User.find(filter).select('name role profileImage').limit(40).lean();
        res.json({ success: true, data: users });
    } catch (err) { fail(res, err, 'Failed', 'getSchoolUsers'); }
};

/** GET /api/chat/admin/user-chats?userId=<id> */
exports.getAdminUserChats = async (req, res) => {
    try {
        if (!isSchoolAdmin(req)) throw new ChatError(403, 'Admin only');
        const { userId } = req.query;
        if (!userId) throw new ChatError(400, 'userId required');
        const targetUser = await User.findOne({ _id: userId, school: req.schoolId }).select('name role').lean();
        if (!targetUser) throw new ChatError(404, 'User not found');
        const chats = await readModel.listChats(userId, req.schoolId, { isAdmin: true });
        res.json({ success: true, data: { chats, user: targetUser } });
    } catch (err) { fail(res, err, 'Failed', 'getAdminUserChats'); }
};
