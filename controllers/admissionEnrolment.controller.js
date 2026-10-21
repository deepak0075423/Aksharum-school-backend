'use strict';
/**
 * Enrolling many at once, and the offers forecast (services/admission/enrolment.js).
 */
const enrolment = require('../services/admission/enrolment');
const { handler } = require('../services/admission/util');

const TAG = 'admission enrolment';

exports.plan = handler(async (req, res) => res.json({ success: true, data: await enrolment.bulkPlan(req, { classId: req.query.class, roundId: req.query.round }) }), TAG);
exports.bulk = handler(async (req, res) => res.json({ success: true, data: await enrolment.bulkEnrol(req, req.body?.rows) }), TAG);
exports.forecast = handler(async (req, res) => res.json({ success: true, data: await enrolment.forecast(req.schoolId, req.query.round) }), TAG);
