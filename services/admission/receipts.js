'use strict';
/**
 * Admission receipts, in the school's own receipt design — the same renderer
 * and the same per-module, per-payment-mode templates as fees, library fines
 * and hostel fees (services/receiptRenderer, Settings → Receipts), with
 * "admission" as the module.
 */
const pool = require('../../db/pool');
const ReceiptTemplate = require('../../models/ReceiptTemplate');
const School = require('../../models/School');
const { renderReceipt, defaultTemplate } = require('../receiptRenderer');
const { refuse, isId } = require('./util');

const MODE_LABEL = { cash: 'Cash', cheque: 'Cheque', dd: 'Demand draft', bank_transfer: 'Bank transfer', upi: 'UPI', card: 'Card', online: 'Online' };

async function render(req, app, paymentId) {
    if (!isId(String(paymentId || ''))) refuse('Receipt not found', 404);
    const { rows: [p] } = await pool.query(
        `SELECT * FROM "admissionpayments" WHERE "_id" = $1 AND "application" = $2 AND "school" = $3 AND "status" IN ('paid', 'void')`,
        [String(paymentId), String(app._id), String(app.school)]);
    if (!p) refuse('Receipt not found', 404);
    const mode = p.mode === 'online' ? 'online' : 'offline';
    const [school, template, applicant, cls] = await Promise.all([
        School.findById(app.school).select('name address logo').lean(),
        ReceiptTemplate.findOne({ school: app.school, module: 'admission', paymentMode: mode }).lean(),
        pool.query(`SELECT "name", "email" FROM "users" WHERE "_id" = $1`, [String(app.applicant)]).then((r) => r.rows[0]),
        pool.query(`SELECT "className" FROM "classes" WHERE "_id" = $1`, [String(app.class)]).then((r) => r.rows[0]),
    ]);
    const settings = await require('./settings').getSettings(app.school);
    const origin = `${req.protocol}://${req.get('host')}`;
    const receipt = {
        module: 'admission', paymentMode: mode,
        number: p.receiptNumber, date: p.paidAt,
        paidBy: applicant?.name || app.guardianName || '',
        paidByDetailLabel: 'For', paidByDetail: `${app.studentName || 'Applicant'} — ${cls?.className || ''} (application ${app.applicationNumber || ''})`,
        title: p.kind === 'application_fee' ? 'Application fee' : 'Admission fee',
        lines: [{ label: p.kind === 'application_fee' ? 'Application fee' : 'Admission fee', amount: p.amount }],
        total: p.amount,
        offlineModeLabel: MODE_LABEL[p.mode] || 'Cash',
        reference: p.mode === 'online' ? p.paymentId : p.reference,
        ...(p.status === 'void' ? { labels: { stamp: 'CANCELLED', doc: 'Cancelled receipt' } } : {}),
    };
    const tpl = template || { ...defaultTemplate('admission', mode), notes: settings.fees.receiptNote || '' };
    const schoolForReceipt = school && {
        name: school.name, address: school.address,
        logoUrl: school.logo ? (/^https?:/.test(school.logo) ? school.logo : `${origin}${school.logo.startsWith('/') ? school.logo : `/uploads/images/${school.logo}`}`) : '',
    };
    return { html: renderReceipt(receipt, tpl, { school: schoolForReceipt }), receipt: { ...receipt, school: schoolForReceipt } };
}

/** Send the receipt: the rendered page, or its data for the phone (`?format=json`). */
async function send(req, res, app, paymentId) {
    const r = await render(req, app, paymentId);
    if (String(req.query.format || '').toLowerCase() === 'json') return res.json({ success: true, data: r.receipt });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(r.html);
}

module.exports = { render, send };
