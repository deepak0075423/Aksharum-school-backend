'use strict';
/**
 * Times families book themselves (Oct 2026): an exam or interview time from
 * the ones the office published (services/admission/slots.js), and campus
 * visits (services/admission/visits.js). Every rule — room left, how late a
 * time may be changed, how many people — is checked in those services.
 */
const AdmissionExam = require('../models/AdmissionExam');
const access = require('../services/admission/access');
const slots = require('../services/admission/slots');
const visits = require('../services/admission/visits');
const settingsSvc = require('../services/admission/settings');
const mailer = require('../services/admission/mailer');
const calendar = require('../services/admission/calendar');
const { handler, refuse, isId } = require('../services/admission/util');

const TAG = 'admission booking';

async function familyExam(req) {
    const app = await access.ownApplication(req, req.params.id);
    if (!isId(String(req.params.examId || ''))) refuse('Exam not found', 404);
    const exam = await AdmissionExam.findOne({ _id: req.params.examId, school: req.schoolId }).lean();
    if (!exam) refuse('Exam not found', 404);
    const cand = await slots.candidateOf(exam._id, app._id);
    if (!cand) refuse('This application is not scheduled for the exam', 404);
    return { app, exam, cand };
}

// ── Exam and interview times ─────────────────────────────────────────────────

exports.examSlotsForFamily = handler(async (req, res) => {
    const { exam, cand } = await familyExam(req);
    res.json({ success: true, data: await slots.familyView(exam, cand) });
}, TAG);

exports.chooseExamSlot = handler(async (req, res) => {
    const { app, exam } = await familyExam(req);
    const cand = await slots.choose(req, exam, app, req.body?.slotId);
    res.json({ success: true, data: { slot: cand.slot, slotId: cand.slotId, room: cand.room } });
}, TAG);

exports.examCalendar = handler(async (req, res) => {
    const { app, exam, cand } = await familyExam(req);
    if (exam.status !== 'scheduled') refuse('This exam is not scheduled', 409);
    if (exam.booking?.enabled && !cand.slotId && !cand.slot) refuse('Choose a time first', 409);
    const { rows: [school] } = await require('../db/pool').query('SELECT "name" FROM "schools" WHERE "_id" = $1', [String(req.schoolId)]);
    const settings = await settingsSvc.getSettings(req.schoolId);
    calendar.send(res, `${exam.name}-${cand.rollNumber || 'admission'}`, slots.calendarFor(exam, cand, school?.name || 'School', mailer.portalLinks(settings.slug).application(app._id)));
}, TAG);

exports.examSlotsForOffice = handler(async (req, res) => {
    const exam = await access.schoolRow(AdmissionExam, req, req.params.id, 'Exam');
    res.json({ success: true, data: await slots.officeView(exam) });
}, TAG);

// ── Campus visits ────────────────────────────────────────────────────────────

exports.officeVisits = handler(async (req, res) => {
    res.json({ success: true, data: await visits.officeList(req.schoolId, { from: req.query.from, to: req.query.to }) });
}, TAG);

exports.openVisits = handler(async (req, res) => {
    res.status(201).json({ success: true, data: await visits.createSlots(req, req.body || {}) });
}, TAG);

exports.updateVisit = handler(async (req, res) => {
    res.json({ success: true, data: await visits.updateSlot(req, req.params.id, req.body || {}) });
}, TAG);

exports.cancelVisit = handler(async (req, res) => {
    res.json({ success: true, data: await visits.cancelSlot(req, req.params.id, req.body?.reason) });
}, TAG);

exports.visitBookings = handler(async (req, res) => {
    res.json({ success: true, data: await visits.bookingsOf(req.schoolId, req.params.id) });
}, TAG);

exports.markVisitBooking = handler(async (req, res) => {
    res.json({ success: true, data: await visits.markBooking(req, req.params.bookingId, req.body?.status) });
}, TAG);

/** The portal's visit times for anyone — what is left, never who booked. */
exports.publicVisits = handler(async (req, res) => {
    const v = await visits.familyView(req.portal.school._id, null);
    res.set('Cache-Control', 'no-store').json({ success: true, data: { ...v, mine: [] } });
}, TAG);

exports.familyVisits = handler(async (req, res) => {
    res.json({ success: true, data: await visits.familyView(req.schoolId, req.userId) });
}, TAG);

exports.bookVisit = handler(async (req, res) => {
    res.status(201).json({ success: true, data: await visits.book(req, req.params.slotId, req.body || {}) });
}, TAG);

exports.cancelVisitBooking = handler(async (req, res) => {
    res.json({ success: true, data: await visits.cancelByFamily(req, req.params.bookingId) });
}, TAG);

exports.visitCalendar = handler(async (req, res) => {
    calendar.send(res, 'school-visit', await visits.calendarFor(req, req.params.bookingId));
}, TAG);
