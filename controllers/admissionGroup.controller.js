'use strict';
/**
 * Groups of schools (services/admission/groups.js): set up by the platform,
 * each school's listing and transfers in its office, the public group page,
 * and the family's applications across branches.
 */
const access = require('../services/admission/access');
const groups = require('../services/admission/groups');
const { handler } = require('../services/admission/util');

const TAG = 'admission groups';

// The platform (super admin).
exports.list = handler(async (req, res) => res.json({ success: true, data: await groups.list() }), TAG);
exports.create = handler(async (req, res) => res.status(201).json({ success: true, data: await groups.save(req, null, req.body || {}) }), TAG);
exports.update = handler(async (req, res) => res.json({ success: true, data: await groups.save(req, req.params.id, req.body || {}) }), TAG);
exports.remove = handler(async (req, res) => res.json({ success: true, data: await groups.remove(req.params.id) }), TAG);

// A school's office.
exports.mine = handler(async (req, res) => res.json({ success: true, data: await groups.forSchool(req.schoolId) }), TAG);
exports.setListed = handler(async (req, res) => res.json({ success: true, data: await groups.setListed(req, req.body?.listed === true) }), TAG);
exports.transfers = handler(async (req, res) => res.json({ success: true, data: await groups.transfers(req) }), TAG);
exports.offerTransfer = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.status(201).json({ success: true, data: await groups.offerTransfer(req, app, req.body || {}) });
}, TAG);
exports.decideTransfer = handler(async (req, res) => res.json({ success: true, data: await groups.decideTransfer(req, req.params.id, req.body || {}) }), TAG);
exports.cancelTransfer = handler(async (req, res) => res.json({ success: true, data: await groups.cancelTransfer(req, req.params.id) }), TAG);
exports.siblings = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await groups.officeSiblings(app) });
}, TAG);

// Anyone: the group page.
exports.publicGroup = handler(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60').json({ success: true, data: await groups.publicView(req.params.slug) });
}, TAG);

// The family.
exports.familyGroup = handler(async (req, res) => res.json({ success: true, data: await groups.familyView(req) }), TAG);
exports.setPreferences = handler(async (req, res) => res.json({ success: true, data: await groups.setPreferences(req, req.body?.order) }), TAG);
