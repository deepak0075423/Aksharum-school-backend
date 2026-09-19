'use strict';
/**
 * Chat message writer
 * ───────────────────
 * The one place a chat message is created, read-marked, edited, deleted or
 * reacted to. Three doors lead here and they all behave identically:
 *
 *   REST            /api/chat/...                 (chat.controller — also the Expo app)
 *   WebSocket       browser → gateway → /internal/chat/*   (live sends, with an ack)
 *   Redis (legacy)  gateway publishes chat.send / chat.read (chatBrokerService)
 *
 * Before this existed the REST send and the broker's socket send were two
 * copies that had drifted: only one advanced the sender's read position, only
 * one allowed forwarding, neither checked that a reply quoted a message from
 * the same conversation (so a reply could lift text out of a chat the sender
 * was never in), and a school admin could delete or react to a message in any
 * school by id.
 *
 * Every function takes an `actor` — { userId, role, schoolId, name } — and
 * throws ChatError(status, message) for anything the caller should be told.
 */
const Chat           = require('../models/Chat');
const ChatMember     = require('../models/ChatMember');
const Message        = require('../models/Message');
const MessageReceipt = require('../models/MessageReceipt');
const broker         = require('./chatBrokerService');
const readModel      = require('./chatReadModel');

const MAX_LENGTH   = 4000;
const EDIT_WINDOW  = 24 * 60 * 60 * 1000;
const TYPES        = ['text', 'file', 'image'];
const POSTS_IN_READ_ONLY = ['school_admin', 'super_admin', 'teacher'];

class ChatError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code || null;
    }
}

const isSchoolAdmin = (actor) => actor.role === 'school_admin' || actor.role === 'super_admin';

/** A REST request's caller as an actor. */
const actorFromRequest = (req) => ({
    userId:   String(req.userId),
    role:     req.userRole,
    schoolId: req.schoolId ? String(req.schoolId) : null,
    name:     req.user?.name || '',
});

async function membership(chatId, actor) {
    return ChatMember.findOne({ chat: chatId, user: actor.userId, school: actor.schoolId, isActive: true }).lean();
}

// ─── Send ─────────────────────────────────────────────────────────────────────

function cleanAttachments(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 10).filter((a) => a && typeof a.fileUrl === 'string' && a.fileUrl.startsWith('/uploads/chat/'))
        .map((a) => ({
            originalName: String(a.originalName || '').slice(0, 200),
            fileName:     String(a.fileName || '').slice(0, 200),
            fileUrl:      a.fileUrl,
            fileType:     String(a.fileType || '').slice(0, 100),
            fileSize:     Number(a.fileSize) || 0,
        }));
}

const cleanClientId = (v) => (typeof v === 'string' && /^[\w-]{6,64}$/.test(v) ? v : null);

/**
 * Persist a message and deliver it to everyone in the conversation.
 * Idempotent on (sender, clientId): the same attempt arriving twice — a socket
 * send that timed out and was retried over REST — returns the first message.
 *
 * @returns {Promise<{ message: object, duplicate: boolean }>}
 */
async function send(actor, chatId, input = {}) {
    const content     = typeof input.content === 'string' ? input.content.trim() : '';
    const attachments = cleanAttachments(input.attachments);
    const clientId    = cleanClientId(input.clientId || input.tempId);
    const isForwarded = input.isForwarded === true || input.isForwarded === 'true';
    const type        = TYPES.includes(input.type) ? input.type : 'text';

    if (!chatId) throw new ChatError(400, 'chatId is required');
    if (!content && !attachments.length) throw new ChatError(400, 'Message is empty');
    if (content.length > MAX_LENGTH) throw new ChatError(400, `Messages are limited to ${MAX_LENGTH} characters`);

    if (clientId) {
        const seen = await Message.findOne({ sender: actor.userId, clientId }).select('_id chat').lean();
        if (seen) {
            if (String(seen.chat) !== String(chatId)) throw new ChatError(409, 'Duplicate message id');
            return { message: await readModel.messageById(seen._id, isSchoolAdmin(actor)), duplicate: true };
        }
    }

    const [member, chat] = await Promise.all([
        membership(chatId, actor),
        Chat.findOne({ _id: chatId, school: actor.schoolId }).lean(),
    ]);
    if (!chat) throw new ChatError(404, 'Conversation not found');
    if (!member) throw new ChatError(403, 'You are not a member of this conversation');
    if (chat.isReadOnly && !POSTS_IN_READ_ONLY.includes(actor.role)) {
        throw new ChatError(403, 'Only teachers and admins can post in this channel');
    }

    // A reply may only quote a message from the same conversation.
    let replyTo = null;
    if (input.replyTo && !isForwarded) {
        const quoted = await Message.findOne({ _id: input.replyTo, chat: chatId }).select('_id').lean();
        if (!quoted) throw new ChatError(400, 'The message you replied to is not in this conversation');
        replyTo = quoted._id;
    }

    let created;
    try {
        created = await Message.create({
            chat:       chatId,
            school:     actor.schoolId,
            sender:     actor.userId,
            senderRole: actor.role,
            content,
            type:       attachments.length ? type : 'text',
            attachments,
            replyTo,
            isForwarded,
            clientId,
        });
    } catch (err) {
        // Two attempts with one clientId raced past the lookup above; the unique
        // index kept one — answer with it.
        if (clientId && (err.code === '23505' || /duplicate key/i.test(err.message || ''))) {
            const seen = await Message.findOne({ sender: actor.userId, clientId }).select('_id').lean();
            if (seen) return { message: await readModel.messageById(seen._id, isSchoolAdmin(actor)), duplicate: true };
        }
        throw err;
    }

    const now = new Date();
    await Promise.all([
        Chat.updateOne({ _id: chatId }, { lastMessage: created._id, lastActivity: now }),
        // Sending is reading: nothing before your own message is unread to you.
        ChatMember.updateOne({ chat: chatId, user: actor.userId }, { lastReadAt: now, lastReadMessage: created._id }),
    ]);

    const message = await readModel.messageById(created._id, false);
    // Live delivery to every socket in the room — including the sender's other
    // tabs. `tempId` is the name the older clients match optimistic rows on.
    broker.publishToRoom(chatId, 'chat:message', { ...message, tempId: clientId }).catch(() => {});
    writeReceipts(created._id, chatId, actor.userId, actor.schoolId).catch(() => {});

    return { message: isSchoolAdmin(actor) ? await readModel.messageById(created._id, true) : message, duplicate: false };
}

async function writeReceipts(messageId, chatId, senderId, schoolId) {
    const members = await ChatMember.find({ chat: chatId, user: { $ne: senderId }, isActive: true }).select('user').lean();
    if (!members.length) return;
    await MessageReceipt.insertMany(
        members.map((m) => ({ message: messageId, chat: chatId, user: m.user, school: schoolId, deliveredAt: new Date() })),
        { ordered: false },
    );
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Everything in this conversation up to now is read by this member. Tells the
 * room, so the sender's ticks turn blue while they watch.
 */
async function markRead(actor, chatId, messageId = null) {
    const member = await membership(chatId, actor);
    if (!member) throw new ChatError(403, 'You are not a member of this conversation');

    const readAt = new Date();
    let lastReadMessage = member.lastReadMessage || null;
    if (messageId) {
        const m = await Message.findOne({ _id: messageId, chat: chatId }).select('_id').lean();
        if (m) lastReadMessage = m._id;
    } else {
        const { rows } = await require('../db/pool').query(
            `SELECT "_id" FROM "messages" WHERE "chat" = $1::uuid ORDER BY "createdAt" DESC LIMIT 1`, [String(chatId)]);
        if (rows[0]) lastReadMessage = rows[0]._id;
    }

    await Promise.all([
        ChatMember.updateOne({ _id: member._id }, { lastReadAt: readAt, lastReadMessage }),
        MessageReceipt.updateMany({ chat: chatId, user: actor.userId, readAt: null }, { readAt }),
    ]);
    broker.publishToRoom(chatId, 'chat:message_read', {
        chatId: String(chatId), userId: actor.userId,
        messageId: lastReadMessage ? String(lastReadMessage) : null, readAt: readAt.toISOString(),
    }).catch(() => {});
    return { readAt: readAt.toISOString() };
}

// ─── Edit / delete / react ────────────────────────────────────────────────────

async function edit(actor, messageId, rawContent) {
    const content = typeof rawContent === 'string' ? rawContent.trim() : '';
    if (!content) throw new ChatError(400, 'Message is empty');
    if (content.length > MAX_LENGTH) throw new ChatError(400, `Messages are limited to ${MAX_LENGTH} characters`);

    const msg = await Message.findOne({ _id: messageId, sender: actor.userId, school: actor.schoolId, isDeleted: false }).lean();
    if (!msg) throw new ChatError(403, 'You can only edit your own messages');
    if (Date.now() - new Date(msg.createdAt).getTime() > EDIT_WINDOW) {
        throw new ChatError(400, 'Messages can only be edited within 24 hours');
    }
    if (msg.content === content) return { content, editedAt: msg.editedAt };

    const editedAt = new Date();
    // $set spelled out: this ORM drops plain fields that sit beside an operator,
    // so `{ content, $push }` recorded the history and never saved the new text.
    await Message.findByIdAndUpdate(messageId, {
        $set:  { content, isEdited: true, editedAt },
        // The version being replaced, for the school admin's audit trail.
        $push: { editHistory: { content: msg.content, editedAt } },
    });
    broker.publishToRoom(msg.chat, 'chat:message_edited', {
        messageId: String(messageId), chatId: String(msg.chat), content, editedAt: editedAt.toISOString(),
        // Admin clients append this to the history they hold; others ignore it.
        previousContent: msg.content,
    }).catch(() => {});
    return { content, editedAt: editedAt.toISOString() };
}

async function remove(actor, messageId) {
    const msg = await Message.findOne({ _id: messageId, school: actor.schoolId, isDeleted: false }).lean();
    if (!msg) throw new ChatError(404, 'Message not found');
    const isOwner = String(msg.sender) === String(actor.userId);
    if (!isOwner && !isSchoolAdmin(actor)) throw new ChatError(403, 'You can only delete your own messages');

    await Message.findByIdAndUpdate(messageId, { isDeleted: true, deletedAt: new Date(), deletedBy: actor.userId });
    broker.publishToRoom(msg.chat, 'chat:message_deleted', {
        messageId: String(messageId), chatId: String(msg.chat), deletedBy: actor.userId,
    }).catch(() => {});
    return { chatId: String(msg.chat) };
}

async function react(actor, messageId, emoji) {
    if (typeof emoji !== 'string' || !emoji.trim() || emoji.length > 16) throw new ChatError(400, 'emoji is required');
    const msg = await Message.findOne({ _id: messageId, school: actor.schoolId, isDeleted: false }).lean();
    if (!msg) throw new ChatError(404, 'Message not found');
    if (!(await membership(msg.chat, actor))) throw new ChatError(403, 'You are not a member of this conversation');

    const mine = (msg.reactions || []).find((r) => String(r.user) === String(actor.userId));
    if (mine) await Message.findByIdAndUpdate(messageId, { $pull: { reactions: { user: actor.userId } } });
    let reactions;
    if (mine && mine.emoji === emoji) {
        reactions = (msg.reactions || []).filter((r) => String(r.user) !== String(actor.userId));
    } else {
        const updated = await Message.findByIdAndUpdate(
            messageId, { $push: { reactions: { emoji, user: actor.userId, userName: actor.name || '' } } }, { new: true },
        ).lean();
        reactions = updated?.reactions || [];
    }
    reactions = reactions.map((r) => ({ ...r, user: String(r.user) }));
    broker.publishToRoom(msg.chat, 'chat:reaction', { messageId: String(messageId), chatId: String(msg.chat), reactions }).catch(() => {});
    return reactions;
}

// ─── Actor for the gateway's internal routes ──────────────────────────────────

/**
 * Resolve a socket's user id into an actor, applying every gate a REST call
 * passes through: an active user at an active school, past the first-login
 * password reset, at a school that runs chat, with a designation that allows
 * it. Role and school come from the database, not from the socket's claims.
 */
async function actorForUser(userId) {
    const { loadSessionUser } = require('../middleware/auth');
    const designations = require('./designationService');

    const user = userId ? await loadSessionUser(String(userId)) : null;
    if (!user || !user.isActive) throw new ChatError(401, 'User not found or inactive');
    if (user.role !== 'super_admin' && user.school && typeof user.school === 'object' && user.school.isActive === false) {
        throw new ChatError(403, 'Your school is inactive');
    }
    if (user.isFirstLogin) throw new ChatError(403, 'Password reset required');

    const pseudo = {
        user, userId: user._id, userRole: user.role, schoolId: user.school?._id || user.school,
    };
    if (pseudo.schoolId) {
        const access = await designations.requestAccess(pseudo);
        if (!access.moduleFlags.chat) throw new ChatError(403, 'Chat is not enabled for your school', 'MODULE_DISABLED');
        if ((access.permissions.chat || designations.NONE) === designations.NONE) {
            throw new ChatError(403, 'Your designation does not have access to chat', 'MODULE_ACCESS_DENIED');
        }
    }
    return actorFromRequest(pseudo);
}

module.exports = {
    ChatError,
    actorFromRequest,
    actorForUser,
    send,
    markRead,
    edit,
    remove,
    react,
    MAX_LENGTH,
};
