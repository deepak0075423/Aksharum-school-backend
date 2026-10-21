'use strict';
/**
 * Enquiries as the office works them, and what each source of families cost
 * (services/admission/crm.js).
 */
const crm = require('../services/admission/crm');
const { handler } = require('../services/admission/util');

const TAG = 'admission enquiries';

exports.list = handler(async (req, res) => {
    const r = await crm.list(req, req.query);
    res.json({ success: true, data: r.rows, total: r.total, counts: r.counts, due: r.due, kinds: crm.KINDS, outcomes: crm.OUTCOMES });
}, TAG);

exports.create = handler(async (req, res) => res.status(201).json({ success: true, data: await crm.create(req, req.body || {}) }), TAG);
exports.update = handler(async (req, res) => res.json({ success: true, data: await crm.update(req, req.params.id, req.body || {}) }), TAG);
exports.interaction = handler(async (req, res) => res.status(201).json({ success: true, data: await crm.logInteraction(req, req.params.id, req.body || {}) }), TAG);
exports.sources = handler(async (req, res) => res.json({ success: true, data: await crm.sources(req.schoolId, req.query.academicYear) }), TAG);
exports.setSpend = handler(async (req, res) => res.json({ success: true, data: await crm.setSpend(req, req.body || {}) }), TAG);
