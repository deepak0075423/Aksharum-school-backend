'use strict';
/**
 * Data protection endpoints (Oct 2026) — services/admission/privacy.js.
 *
 *   /portal/privacy …   the family: its requests, a copy of everything held,
 *                       agreeing to a changed privacy notice
 *   /admin/privacy …    the office: requests to answer, retention, the access log;
 *                       legal hold and revealing an Aadhaar number per application
 */
const pool = require('../db/pool');
const privacy = require('../services/admission/privacy');
const access = require('../services/admission/access');
const events = require('../services/admission/events');
const { handler, refuse } = require('../services/admission/util');

const TAG = 'admission privacy';

// ── The family ───────────────────────────────────────────────────────────────

exports.mine = handler(async (req, res) => {
    const s = req.portal.settings;
    const { rows: [profile] } = await pool.query(`SELECT "consentVersion", "consentAt" FROM "admissionapplicants" WHERE "user" = $1`, [String(req.userId)]);
    res.json({
        success: true,
        data: {
            requests: await privacy.myRequests(req),
            consent: { agreedVersion: profile?.consentVersion || 0, agreedAt: profile?.consentAt || null, currentVersion: s.portal.privacyVersion || 1, notice: s.portal.privacyNotice },
            officer: s.privacy?.officer || {}, requestDays: s.privacy?.requestDays || 30,
            kinds: privacy.KINDS.map((k) => ({ key: k, label: privacy.KIND_LABEL[k] })),
        },
    });
}, TAG);

exports.exportMine = handler(async (req, res) => {
    const data = await privacy.exportMine(req);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="my-admission-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(data, null, 2));
}, TAG);

exports.createRequest = handler(async (req, res) => {
    res.status(201).json({ success: true, data: await privacy.createRequest(req, req.body || {}) });
}, TAG);

/** Agree to the privacy notice as it now reads. */
exports.consent = handler(async (req, res) => {
    const current = Number(req.portal.settings.portal.privacyVersion) || 1;
    if (Math.round(Number(req.body?.version)) !== current) refuse('The privacy notice has changed again — please read it once more', 409, { code: 'CONSENT_STALE' });
    await pool.query(`UPDATE "admissionapplicants" SET "consentVersion" = $2, "consentAt" = now() WHERE "user" = $1`, [String(req.userId), current]);
    events.recordQuietly(req.schoolId, { by: req, type: 'privacy', action: 'consent', message: `Agreed to version ${current} of the privacy notice` });
    res.json({ success: true, data: { version: current } });
}, TAG);

// ── The office ───────────────────────────────────────────────────────────────

exports.requests = handler(async (req, res) => {
    res.json({ success: true, data: await privacy.officeRequests(req, { status: String(req.query.status || '') }) });
}, TAG);

exports.answer = handler(async (req, res) => {
    res.json({ success: true, data: await privacy.answerRequest(req, req.params.id, req.body || {}) });
}, TAG);

exports.erase = handler(async (req, res) => {
    res.json({ success: true, data: await privacy.eraseForRequest(req, req.params.id) });
}, TAG);

exports.retention = handler(async (req, res) => {
    const settings = await require('../services/admission/settings').getSettings(req.schoolId);
    res.json({ success: true, data: await privacy.retentionPreview(req.schoolId, settings) });
}, TAG);

exports.runRetention = handler(async (req, res) => {
    const settings = await require('../services/admission/settings').getSettings(req.schoolId, { fresh: true });
    res.json({ success: true, data: await privacy.runRetention(req.schoolId, settings, { by: req }) });
}, TAG);

exports.accessLog = handler(async (req, res) => {
    res.json({ success: true, data: await privacy.accessLog(req, { page: req.query.page, limit: req.query.limit }) });
}, TAG);

exports.legalHold = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await privacy.setLegalHold(req, app, { on: req.body?.on === true, reason: req.body?.reason }) });
}, TAG);

exports.reveal = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await privacy.reveal(req, app, req.body?.field) });
}, TAG);
