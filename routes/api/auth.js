'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/auth.controller');
const { verifyToken } = require('../../middleware/auth');

router.post('/login',            ctrl.login);
router.post('/logout',           verifyToken, ctrl.logout);
router.post('/forgot-password',  ctrl.forgotPassword);
router.post('/verify-otp',       ctrl.verifyOtp);
router.post('/new-password',     ctrl.newPassword);
router.post('/reset-password',   verifyToken, ctrl.resetPassword);
router.get('/magic/:token',      ctrl.magicLogin);
router.get('/me',                verifyToken, ctrl.getMe);
router.post('/refresh',          ctrl.refreshToken);

module.exports = router;
