'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken, requirePasswordReset } = require('../../middleware/auth');
const ctrl = require('../../controllers/chat.controller');

const guard = [verifyToken, requirePasswordReset];

// ── Chat list & messages ──────────────────────────────────────────────────────
router.get('/chats',                  guard, ctrl.getChats);
router.get('/chats/:chatId/messages', guard, ctrl.getMessages);
router.post('/chats/:chatId/messages',guard, ctrl.sendMessage);
router.get('/chats/:chatId/members',  guard, ctrl.getChatMembers);

// ── Contacts / search / unread ────────────────────────────────────────────────
router.get('/contacts',     guard, ctrl.getContacts);
router.get('/search',       guard, ctrl.searchMessages);
router.get('/unread-count', guard, ctrl.getUnreadCount);
router.post('/heartbeat',   guard, ctrl.heartbeat);

// ── Create chats ──────────────────────────────────────────────────────────────
router.post('/direct', guard, ctrl.createDirectChat);
router.post('/group',  guard, ctrl.createGroup);

// ── Message actions ───────────────────────────────────────────────────────────
router.patch('/messages/:msgId',        guard, ctrl.editMessage);
router.delete('/messages/:msgId',       guard, ctrl.deleteMessage);
router.post('/messages/:msgId/react',   guard, ctrl.toggleReaction);

// ── Group management ──────────────────────────────────────────────────────────
router.patch('/group/:chatId/settings',          guard, ctrl.updateGroupSettings);
router.post('/group/:chatId/member',             guard, ctrl.addMember);
router.delete('/group/:chatId/member/:memberId', guard, ctrl.removeMember);

// ── Admin oversight ───────────────────────────────────────────────────────────
router.get('/admin/school-users', guard, ctrl.getSchoolUsers);
router.get('/admin/user-chats',   guard, ctrl.getAdminUserChats);

// ── Per-chat preferences ──────────────────────────────────────────────────────
router.post('/:chatId/mute',    guard, ctrl.toggleMute);
router.post('/:chatId/archive', guard, ctrl.toggleArchive);

module.exports = router;
