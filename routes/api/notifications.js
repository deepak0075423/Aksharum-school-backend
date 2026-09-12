'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/notification.controller');
const { verifyToken, requirePasswordReset } = require('../../middleware/auth');

const guard = [verifyToken, requirePasswordReset];

router.get('/inbox',                     guard, ctrl.getInboxApi);
router.get('/all',                       guard, ctrl.getAllNotifications);
router.get('/unread-count',              guard, ctrl.getUnreadCount);
router.get('/sent',                      guard, ctrl.getSent);
router.post('/mark-all-read',            guard, ctrl.markAllRead);
router.post('/clear-all',               guard, ctrl.clearAll);
router.post('/archive-read',            guard, ctrl.archiveRead);
// The selection bar: read / unread / archive / restore / delete over many ids.
router.post('/bulk',                    guard, ctrl.bulk);
// Empties one box. POST rather than DELETE because it carries which box.
router.post('/delete-all',              guard, ctrl.deleteAll);
router.get('/:receiptId/resolve',       guard, ctrl.resolveReceipt);
router.patch('/:receiptId/mark-read',   guard, ctrl.markOneRead);
router.patch('/:receiptId/mark-unread', guard, ctrl.markOneUnread);
// Archiving is DELETE for the bell, which only ever clears; the notifications
// page can put one back, so it also has the other half of the pair.
router.post('/:receiptId/restore',      guard, ctrl.restoreOne);
router.delete('/:receiptId',            guard, ctrl.clearOne);
router.get('/classes/:classId/sections', guard, ctrl.getSectionsByClass);

module.exports = router;
