'use strict';
/**
 * Quotas and the RTE seats (Oct 2026) — services/admission/quotas.js.
 *
 *   PATCH /admin/applications/:id/quota      put an application in a quota, verify or reject its claim
 *   POST  /admin/rounds/:id/quotas/release   give a quota's unfilled seats to the general seats
 *   POST  /admin/rounds/:id/rte-allotments   import the children the state allotted
 *   GET   /admin/rte/register …              the reimbursement register for a year
 */
const AdmissionRound = require('../models/AdmissionRound');
const access = require('../services/admission/access');
const quotas = require('../services/admission/quotas');
const seats = require('../services/admission/seats');
const { handler, refuse, isId } = require('../services/admission/util');

const TAG = 'admission quota';

exports.setQuota = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await quotas.setQuota(req, app, req.body || {}) });
}, TAG);

exports.release = handler(async (req, res) => {
    const round = await access.schoolRow(AdmissionRound, req, req.params.id, 'Round');
    const b = req.body || {};
    if (!isId(String(b.class || ''))) refuse('Choose the class');
    res.json({ success: true, data: await quotas.release(req, round._id, String(b.class), String(b.quota || ''), b.seats) });
}, TAG);

exports.importAllotments = handler(async (req, res) => {
    const round = await access.schoolRow(AdmissionRound, req, req.params.id, 'Round');
    res.status(201).json({ success: true, data: await quotas.importAllotments(req, round._id, req.body || {}) });
}, TAG);

exports.pools = handler(async (req, res) => {
    const round = await access.schoolRow(AdmissionRound, req, req.params.id, 'Round');
    if (!isId(String(req.query.class || ''))) refuse('Choose the class');
    res.json({ success: true, data: await seats.pools(round._id, String(req.query.class)) });
}, TAG);

exports.register = handler(async (req, res) => {
    const data = await quotas.register(req, String(req.query.year || ''));
    if (req.query.format === 'csv') {
        const esc = (v) => {
            const s = String(v ?? '');
            const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
            return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        };
        const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
        const lines = [['Student', 'Admission number', 'Class', 'Per-child amount', 'Claimed', 'Claimed on', 'Received', 'Received on', 'Status', 'Reference', 'Notes'].join(',')];
        for (const r of data.rows) lines.push([r.studentName, r.admissionNumber, r.className, r.perChildAmount ?? '', r.claimedAmount ?? '', day(r.claimedAt), r.receivedAmount ?? '', day(r.receivedAt), r.status, r.reference, r.notes].map(esc).join(','));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="rte-reimbursement-register.csv"');
        return res.send(lines.join('\n'));
    }
    res.json({ success: true, data });
}, TAG);

exports.updateClaim = handler(async (req, res) => {
    res.json({ success: true, data: await quotas.updateClaim(req, req.params.id, req.body || {}) });
}, TAG);
