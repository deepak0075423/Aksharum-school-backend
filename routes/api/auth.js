'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/auth.controller');
const { verifyToken } = require('../../middleware/auth');

router.post('/login',            ctrl.login);
// One address can open several seats — a teaching post at one school, a parent's
// account at another. /select finishes a sign-in that stopped to ask which one;
// /accounts and /switch are the same choice made later, without signing out.
router.post('/select',           ctrl.selectAccount);
router.get('/accounts',          verifyToken, ctrl.listAccounts);
router.post('/switch',           verifyToken, ctrl.switchAccount);
router.get('/google/config',     ctrl.googleConfig);
router.post('/google',           ctrl.googleLogin);
router.post('/logout',           verifyToken, ctrl.logout);
router.post('/forgot-password',  ctrl.forgotPassword);
router.post('/verify-otp',       ctrl.verifyOtp);
router.post('/new-password',     ctrl.newPassword);
router.post('/reset-password',   verifyToken, ctrl.resetPassword);
router.get('/magic/:token',      ctrl.magicLogin);
router.get('/me',                verifyToken, ctrl.getMe);
router.post('/refresh',          ctrl.refreshToken);

module.exports = router;
