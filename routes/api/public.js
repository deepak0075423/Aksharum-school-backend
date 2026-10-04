'use strict';
/**
 * Endpoints anybody may call, with no sign-in (Oct 2026) — only what a
 * printed document's QR code points at, and nothing it does not already show.
 */
const express = require('express');
const resultPortal = require('../../controllers/resultPortal.controller');

const router = express.Router();

// A report card's QR: did the school issue exactly this card?
router.get('/report-card/:code', resultPortal.verifyReportCard);
// …and its QR as an image, for the card shown on screen.
router.get('/report-card/:code/qr.svg', resultPortal.reportCardQr);

// An ID card's QR: is this card valid, and whose is it? (controllers/idCardPortal)
const idCardPortal = require('../../controllers/idCardPortal.controller');
router.get('/id-card/:code',         idCardPortal.verify);
router.get('/id-card/:code/qr.svg',  idCardPortal.qrSvg);
router.get('/id-card/:code/qr.png',  idCardPortal.qrPng);

module.exports = router;
