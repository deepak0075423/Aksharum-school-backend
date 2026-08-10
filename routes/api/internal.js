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

router.get('/user-chats', requireInternalSecret, async (req, res) => {
    const { userId, schoolId } = req.query;
    if (!userId || !schoolId) {
        return res.status(400).json({ error: 'userId and schoolId are required' });
    }
    try {
        const memberships = await ChatMember.find({
            user: userId, school: schoolId, isActive: true,
        }).select('chat').lean();
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

module.exports = router;
