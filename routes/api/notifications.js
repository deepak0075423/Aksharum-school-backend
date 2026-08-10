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
router.patch('/:receiptId/mark-read',   guard, ctrl.markOneRead);
router.delete('/:receiptId',            guard, ctrl.clearOne);
router.get('/classes/:classId/sections', guard, ctrl.getSectionsByClass);

module.exports = router;
