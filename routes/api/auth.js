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
// A 12-hour token that opens the private upload folders and nothing else
// (services/privateFiles) — the web app keeps it in a cookie, the phone app
// adds it to file addresses.
router.get('/file-token',        verifyToken, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: require('../../services/privateFiles').issueToken(req.user) });
});
router.post('/refresh',          ctrl.refreshToken);

module.exports = router;
