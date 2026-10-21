'use strict';
/**
 * The admission office's operations: the health card (services/admission/
 * jobRuns.js) and exports prepared in the background (exportJobs.js).
 */
const jobRuns = require('../services/admission/jobRuns');
const exportJobs = require('../services/admission/exportJobs');
const { handler } = require('../services/admission/util');

const TAG = 'admission operations';

exports.health = handler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ success: true, data: await jobRuns.health(req.schoolId) });
}, TAG);

exports.exports = handler(async (req, res) => {
    res.json({ success: true, data: await exportJobs.list(req.schoolId) });
}, TAG);

exports.queueExport = handler(async (req, res) => {
    res.status(202).json({ success: true, data: await exportJobs.queue(req, req.body || {}) });
}, TAG);

exports.downloadExport = handler(async (req, res) => {
    await exportJobs.download(req, res, req.params.id);
}, TAG);
