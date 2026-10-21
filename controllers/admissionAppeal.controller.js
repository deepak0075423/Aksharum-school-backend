'use strict';
/**
 * Re-checks and appeals (services/admission/appeals.js): the family files and
 * follows them from its application page; admission administrators answer.
 */
const access = require('../services/admission/access');
const appeals = require('../services/admission/appeals');
const { handler } = require('../services/admission/util');

const TAG = 'admission appeals';

exports.familyList = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const [options, list] = await Promise.all([appeals.options(app), appeals.forFamily(app)]);
    res.json({ success: true, data: { options, appeals: list } });
}, TAG);

exports.file = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const a = await appeals.file(req, app, req.body || {});
    res.status(201).json({ success: true, data: { _id: a._id, number: a.number, dueAt: a.dueAt } });
}, TAG);

exports.withdraw = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const a = await appeals.withdraw(req, app, req.params.appealId);
    res.json({ success: true, data: { _id: a._id, status: a.status } });
}, TAG);

exports.officeList = handler(async (req, res) => {
    const r = await appeals.list(req.schoolId, { status: req.query.status, kind: req.query.kind });
    res.json({ success: true, data: r.rows, totals: r.totals });
}, TAG);

exports.detail = handler(async (req, res) => {
    res.json({ success: true, data: await appeals.detail(req.schoolId, req.params.id) });
}, TAG);

exports.assign = handler(async (req, res) => {
    res.json({ success: true, data: await appeals.assign(req, req.params.id, req.body?.userId || null) });
}, TAG);

exports.decide = handler(async (req, res) => {
    res.json({ success: true, data: await appeals.decide(req, req.params.id, req.body || {}) });
}, TAG);
