'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Transport Portal — Parent (spec §12) & Student read/self-service controller.
//  Live tracking, driver/bus info, attendance history, fees, requests, complaints.
// ─────────────────────────────────────────────────────────────────────────────
const TransportAssignment = require('../models/TransportAssignment');
const TransportRoute      = require('../models/TransportRoute');
const TransportTrip       = require('../models/TransportTrip');
const TransportFeeInvoice = require('../models/TransportFeeInvoice');
const TransportRequest    = require('../models/TransportRequest');
const TransportComplaint  = require('../models/TransportComplaint');
const ParentProfile       = require('../models/ParentProfile');
const StudentProfile      = require('../models/StudentProfile');
const User                = require('../models/User');

const ok   = (res, data)            => res.json({ success: true, data });
const bad  = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const fail = (res, e)               => res.status(500).json({ success: false, message: e.message });

function dayRange(dateLike) {
    const d = dateLike ? new Date(dateLike) : new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end   = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    return { start, end };
}
async function nextNumber(Model, schoolId, prefix) {
    const d  = new Date();
    const ym = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const count = await Model.countDocuments({ school: schoolId });
    return `${prefix}-${ym}-${String(count + 1).padStart(4, '0')}`;
}

// The User ids of a parent's children (children[] with legacy `student` fallback).
async function childIdsOf(userId) {
    const p = await ParentProfile.findOne({ user: userId }).lean();
    if (!p) return [];
    return p.children?.length ? p.children.map(String) : (p.student ? [String(p.student)] : []);
}

// Full transport picture for one student: assignment + resolved stop names + crew.
async function buildTransport(studentId, schoolId) {
    const a = await TransportAssignment.findOne({ school: schoolId, student: studentId, status: { $in: ['active', 'suspended'] } })
        .populate({ path: 'route', select: 'name routeCode shift stops driver attendant vehicle',
            populate: [
                { path: 'driver', select: 'name phone photo performance' },
                { path: 'attendant', select: 'name phone' },
                { path: 'vehicle', select: 'vehicleNumber registrationNumber busName capacity gpsDeviceId' },
            ] })
        .populate('feePlan', 'name basis amount frequency').lean();
    if (!a) return null;
    const stops = a.route?.stops || [];
    a.pickupStopName = stops.find(s => String(s._id) === String(a.pickupStop))?.name || '';
    a.dropStopName   = stops.find(s => String(s._id) === String(a.dropStop))?.name || '';
    return a;
}

// Today's running trip on the student's route + this student's board status.
async function liveTrackFor(studentId, schoolId) {
    const a = await TransportAssignment.findOne({ school: schoolId, student: studentId, status: 'active' }).lean();
    if (!a) return { active: false, reason: 'no_assignment' };
    const { start, end } = dayRange();
    const trip = await TransportTrip.findOne({
        school: schoolId, route: a.route, date: { $gte: start, $lt: end },
        status: { $in: ['started', 'paused', 'completed'] },
    }).sort('-startTime')
        .populate('vehicle', 'vehicleNumber registrationNumber gpsDeviceId')
        .populate('driver', 'name phone').lean();
    if (!trip) return { active: false, reason: 'no_trip' };
    const mine = (trip.studentAttendance || []).find(s => String(s.student) === String(studentId));
    return {
        active: trip.status !== 'completed',
        status: trip.status, shift: trip.shift, direction: trip.direction,
        vehicle: trip.vehicle, driver: trip.driver,
        lastLocation: trip.lastLocation,
        delayMinutes: trip.delayMinutes,
        stops: (trip.stopEvents || []).map(s => ({ name: s.name, sequence: s.sequence, status: s.status, plannedTime: s.plannedTime, reachedAt: s.reachedAt })),
        myStatus: mine?.status || 'pending', myBoardTime: mine?.boardTime, myDropTime: mine?.dropTime,
    };
}

async function attendanceHistory(studentId, schoolId, limit = 30) {
    const trips = await TransportTrip.find({ school: schoolId, 'studentAttendance.student': studentId })
        .sort('-date').limit(+limit).populate('route', 'name').select('date shift direction tripCode route studentAttendance').lean();
    return trips.map(t => {
        const mine = (t.studentAttendance || []).find(s => String(s.student) === String(studentId)) || {};
        return { date: t.date, shift: t.shift, direction: t.direction, route: t.route?.name,
            status: mine.status, boardTime: mine.boardTime, dropTime: mine.dropTime, method: mine.method };
    });
}

// ═════════════════════════════════════════════════════════════════════════════
//  PARENT (spec §12)
// ═════════════════════════════════════════════════════════════════════════════
exports.parentChildren = async (req, res) => {
    try {
        const ids = await childIdsOf(req.userId);
        const out = [];
        for (const id of ids) {
            const [user, a] = await Promise.all([
                User.findById(id).select('name').lean(),
                buildTransport(id, req.schoolId),
            ]);
            if (!user) continue;
            out.push({
                studentId: id, name: user.name,
                hasTransport: !!a,
                route: a?.route?.name, routeCode: a?.route?.routeCode,
                vehicle: a?.route?.vehicle?.vehicleNumber, seatNumber: a?.seatNumber,
                pickupStop: a?.pickupStopName, dropStop: a?.dropStopName, status: a?.status,
            });
        }
        ok(res, out);
    } catch (e) { fail(res, e); }
};
async function guardParentChild(req, res) {
    const studentId = req.query.studentId || req.body.studentId;
    if (!studentId) { bad(res, 'studentId is required'); return null; }
    const ids = await childIdsOf(req.userId);
    if (!ids.includes(String(studentId))) { bad(res, 'Not your child', 403); return null; }
    return studentId;
}
exports.parentTransport = async (req, res) => {
    try { const id = await guardParentChild(req, res); if (!id) return;
        ok(res, await buildTransport(id, req.schoolId)); } catch (e) { fail(res, e); }
};
exports.parentTrack = async (req, res) => {
    try { const id = await guardParentChild(req, res); if (!id) return;
        ok(res, await liveTrackFor(id, req.schoolId)); } catch (e) { fail(res, e); }
};
exports.parentAttendance = async (req, res) => {
    try { const id = await guardParentChild(req, res); if (!id) return;
        ok(res, await attendanceHistory(id, req.schoolId, req.query.limit)); } catch (e) { fail(res, e); }
};
exports.parentInvoices = async (req, res) => {
    try { const id = await guardParentChild(req, res); if (!id) return;
        ok(res, await TransportFeeInvoice.find({ school: req.schoolId, student: id }).sort('-createdAt').limit(24).lean()); } catch (e) { fail(res, e); }
};
exports.parentCreateRequest = async (req, res) => {
    try {
        const id = await guardParentChild(req, res); if (!id) return;
        const { requestType, details = {} } = req.body;
        if (!requestType) return bad(res, 'requestType is required');
        const current = await TransportAssignment.findOne({ school: req.schoolId, student: id, status: 'active' }).lean();
        const r = await TransportRequest.create({
            school: req.schoolId, requestCode: await nextNumber(TransportRequest, req.schoolId, 'TRQ'),
            requestedBy: req.userId, student: id, requestType, currentAssignment: current?._id || null, details,
        });
        ok(res, r);
    } catch (e) { fail(res, e); }
};
exports.parentRequests = async (req, res) => {
    try { ok(res, await TransportRequest.find({ school: req.schoolId, requestedBy: req.userId })
        .sort('-createdAt').populate('student', 'name').populate('details.route', 'name').lean()); } catch (e) { fail(res, e); }
};
exports.parentCreateComplaint = async (req, res) => {
    try {
        const { subject, category, description, studentId, route, vehicle } = req.body;
        if (!subject) return bad(res, 'Subject is required');
        if (studentId) { const ids = await childIdsOf(req.userId); if (!ids.includes(String(studentId))) return bad(res, 'Not your child', 403); }
        const c = await TransportComplaint.create({
            school: req.schoolId, complaintCode: await nextNumber(TransportComplaint, req.schoolId, 'CMP'),
            raisedBy: req.userId, raisedByRole: req.userRole, student: studentId || null,
            subject, category: category || 'other', description, route: route || null, vehicle: vehicle || null,
            timeline: [{ action: 'created', by: req.userId, note: subject }],
        });
        ok(res, c);
    } catch (e) { fail(res, e); }
};
exports.parentComplaints = async (req, res) => {
    try { ok(res, await TransportComplaint.find({ school: req.schoolId, raisedBy: req.userId })
        .sort('-createdAt').populate('route', 'name').lean()); } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  STUDENT (self view)
// ═════════════════════════════════════════════════════════════════════════════
exports.studentTransport = async (req, res) => {
    try { ok(res, await buildTransport(req.userId, req.schoolId)); } catch (e) { fail(res, e); }
};
exports.studentTrack = async (req, res) => {
    try { ok(res, await liveTrackFor(req.userId, req.schoolId)); } catch (e) { fail(res, e); }
};
exports.studentAttendance = async (req, res) => {
    try { ok(res, await attendanceHistory(req.userId, req.schoolId, req.query.limit)); } catch (e) { fail(res, e); }
};
exports.studentInvoices = async (req, res) => {
    try { ok(res, await TransportFeeInvoice.find({ school: req.schoolId, student: req.userId }).sort('-createdAt').limit(24).lean()); } catch (e) { fail(res, e); }
};
exports.studentCreateComplaint = async (req, res) => {
    try {
        const { subject, category, description } = req.body;
        if (!subject) return bad(res, 'Subject is required');
        const a = await TransportAssignment.findOne({ school: req.schoolId, student: req.userId, status: 'active' }).lean();
        const c = await TransportComplaint.create({
            school: req.schoolId, complaintCode: await nextNumber(TransportComplaint, req.schoolId, 'CMP'),
            raisedBy: req.userId, raisedByRole: req.userRole, student: req.userId,
            subject, category: category || 'other', description, route: a?.route || null, vehicle: a?.vehicle || null,
            timeline: [{ action: 'created', by: req.userId, note: subject }],
        });
        ok(res, c);
    } catch (e) { fail(res, e); }
};
exports.studentComplaints = async (req, res) => {
    try { ok(res, await TransportComplaint.find({ school: req.schoolId, raisedBy: req.userId }).sort('-createdAt').lean()); } catch (e) { fail(res, e); }
};
