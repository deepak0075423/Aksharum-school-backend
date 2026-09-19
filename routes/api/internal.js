'use strict';
const express                = require('express');
const router                 = express.Router();
const ChatMember             = require('../../models/ChatMember');
const NotificationReceipt    = require('../../models/NotificationReceipt');
const User                   = require('../../models/User');

const requireInternalSecret = (req, res, next) => {
    const secret = process.env.INTERNAL_SECRET;
    if (!secret) return res.status(503).json({ error: 'INTERNAL_SECRET not configured' });
    if (req.headers['x-internal-secret'] !== secret) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
};

// Role + school of a user — the gateway calls this when a socket's token
// carries only userId, so it can still join rooms and stamp chat sends.
router.get('/user-context', requireInternalSecret, async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    try {
        const user = await User.findById(userId).select('role school isActive').lean();
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({
            userId:   String(user._id),
            role:     user.role,
            schoolId: user.school ? String(user.school) : '',
            isActive: user.isActive !== false,
        });
    } catch {
        res.status(500).json({ error: 'Internal error' });
    }
});

router.get('/user-chats', requireInternalSecret, async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    try {
        // schoolId is an optional narrowing filter — a socket whose token has no
        // school claim must still get its rooms rather than an empty list.
        const filter = { user: userId, isActive: true };
        if (req.query.schoolId) filter.school = req.query.schoolId;
        const memberships = await ChatMember.find(filter).select('chat').lean();
        res.json({ chatIds: memberships.map(m => String(m.chat)) });
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
});

// Gateway calls this on socket connect to get the user's initial unread count
router.get('/user-notification-count', requireInternalSecret, async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    try {
        const count = await NotificationReceipt.countDocuments({
            recipient: userId,
            isRead:    false,
            isCleared: false,
        });
        res.json({ count });
    } catch {
        res.status(500).json({ error: 'Internal error' });
    }
});

// Gateway calls this over the socket lifecycle (connect / presence timer /
// disconnect) to keep the user's lastSeenAt fresh — replaces the old client
// POST /api/chat/heartbeat polling.
router.post('/user-seen', requireInternalSecret, async (req, res) => {
    const userId = req.body?.userId || req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    try {
        await User.updateOne({ _id: userId }, { lastSeenAt: new Date() });
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Internal error' });
    }
});

// ── Chat commands from the gateway ───────────────────────────────────────────
// A browser sends over its socket and waits for an ack; the gateway turns that
// into one of these calls and hands the answer straight back. Commands travel
// over HTTP (a reply per request, load-balanced across workers); fan-out to the
// room still travels over Redis (chat.deliver), published by the writer.
//
// The user id comes from a socket the gateway has already verified. Role,
// school and every access gate are re-resolved here from the database, exactly
// as a REST call would be (chatMessageService.actorForUser).
const chatWriter = require('../../services/chatMessageService');

const chatCommand = (run) => async (req, res) => {
    try {
        const actor = await chatWriter.actorForUser(req.body?.userId);
        const data = await run(actor, req.body || {});
        res.json({ ok: true, data });
    } catch (err) {
        if (err instanceof chatWriter.ChatError) {
            return res.status(err.status).json({ ok: false, status: err.status, message: err.message, code: err.code });
        }
        console.error('[internal/chat]', err);
        res.status(500).json({ ok: false, status: 500, message: 'Could not complete that — try again' });
    }
};

router.post('/chat/send', requireInternalSecret, chatCommand(async (actor, b) => {
    const { message, duplicate } = await chatWriter.send(actor, b.chatId, b);
    return { message, duplicate };
}));

router.post('/chat/read', requireInternalSecret, chatCommand((actor, b) =>
    chatWriter.markRead(actor, b.chatId, b.messageId || null)));

module.exports = router;
