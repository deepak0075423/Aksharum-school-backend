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
const TransportStaff      = require('../models/TransportStaff');

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

// ═════════════════════════════════════════════════════════════════════════════
//  STAFF RIDER — a teacher enrolled in the service
//
//  A teacher who rides the bus wants exactly what a student wants: which route,
//  which bus, who is driving, where it is, and what they owe. Every handler
//  above is keyed on `req.userId` and none of them reads a StudentProfile, so
//  they serve a teacher unchanged; these aliases exist so the routes read
//  honestly rather than mounting something called `studentTransport` under
//  /staff. Crew-only teachers (a driver with no enrolment of their own) get a
//  null assignment, which the screen presents as "you are crew, not a rider".
// ═════════════════════════════════════════════════════════════════════════════
exports.staffTransport      = exports.studentTransport;
exports.staffTrack          = exports.studentTrack;
exports.staffAttendance     = exports.studentAttendance;
exports.staffInvoices       = exports.studentInvoices;
exports.staffComplaints     = exports.studentComplaints;
exports.staffCreateComplaint = exports.studentCreateComplaint;

// ═════════════════════════════════════════════════════════════════════════════
//  CREW (spec §13) — the driver's, conductor's and crew member's own screen
//
//  Until now a driver signing in got the RIDER screen: which bus am I on, what
//  do I owe. That is the wrong question for someone who drives it. This answers
//  the crew's four: what am I crewing today, who is on board, is my paperwork
//  in date, and is my phone reporting a position.
//
//  Everything is keyed on req.userId, so there is no id to pass and nothing to
//  guess at — a crew member can only ever see their own duty.
// ═════════════════════════════════════════════════════════════════════════════

/** The TransportStaff row for whoever is signed in, or null. */
async function crewOf(req) {
    return TransportStaff.findOne({ school: req.schoolId, user: req.userId, isActive: true })
        .populate('assignedVehicle', 'vehicleNumber registrationNumber busName capacity gpsDeviceId status')
        .lean();
}

const DAY = 24 * 60 * 60 * 1000;
const daysTo = (d) => (d ? Math.round((new Date(d) - Date.now()) / DAY) : null);

/**
 * Today's duty · GET /transport/crew/duty
 */
exports.crewDuty = async (req, res) => {
    try {
        const me = await crewOf(req);
        if (!me) return bad(res, 'You do not hold a transport role', 403);
        const school = req.schoolId;
        const { start, end } = dayRange();

        // Routes this person crews, either at the wheel or riding with it.
        const routes = await TransportRoute.find({
            school, isActive: true, $or: [{ driver: me._id }, { attendant: me._id }],
        }).select('name routeCode shift stops color vehicle driver attendant distanceKm')
            .populate('vehicle', 'vehicleNumber busName capacity gpsDeviceId').lean();

        const routeIds = routes.map((r) => r._id);
        const trips = routeIds.length ? await TransportTrip.find({
            school, route: { $in: routeIds }, date: { $gte: start, $lt: end },
        }).sort('shift')
            .populate('route', 'name routeCode color')
            .populate('vehicle', 'vehicleNumber busName')
            .lean() : [];

        // The one to put at the top: whatever is running, else the next one due.
        const live = trips.find((t) => ['started', 'paused'].includes(t.status))
            || trips.find((t) => t.status === 'scheduled')
            || trips[0] || null;

        const riderCounts = (t) => {
            const list = t?.studentAttendance || [];
            return {
                total: list.length,
                boarded: list.filter((x) => x.status === 'boarded').length,
                dropped: list.filter((x) => x.status === 'dropped').length,
                absent: list.filter((x) => ['absent', 'no_show'].includes(x.status)).length,
                pending: list.filter((x) => x.status === 'pending').length,
            };
        };

        // Paperwork that is about to lapse. A driver is stopped by an expired
        // licence, so it is on their own screen and not only the office's.
        const alerts = [];
        const lic = daysTo(me.licenseExpiry);
        const med = daysTo(me.medicalCertExpiry);
        if (me.staffType === 'driver' && lic !== null && lic <= 45) {
            alerts.push({ kind: 'licence', days: lic, date: me.licenseExpiry,
                label: lic < 0 ? 'Your driving licence has expired' : 'Your driving licence expires soon' });
        }
        if (med !== null && med <= 45) {
            alerts.push({ kind: 'medical', days: med, date: me.medicalCertExpiry,
                label: med < 0 ? 'Your medical certificate has expired' : 'Your medical certificate expires soon' });
        }
        if (me.policeVerification && me.policeVerification.status !== 'verified') {
            alerts.push({ kind: 'police', days: null, date: null, label: 'Police verification is not complete' });
        }

        ok(res, {
            me: {
                _id: me._id, name: me.name, role: me.staffType, employeeId: me.employeeId,
                phone: me.phone, photo: me.photo, status: me.status,
                locationSharing: !!me.locationSharing,
                lastLocation: me.lastLocation || null,
                licenseNumber: me.licenseNumber, licenseType: me.licenseType,
                licenseExpiry: me.licenseExpiry, licenceDays: lic,
                medicalCertExpiry: me.medicalCertExpiry, medicalDays: med,
                policeVerified: me.policeVerification?.status === 'verified',
                experienceYears: me.experienceYears || 0,
                dateOfJoining: me.dateOfJoining,
            },
            vehicle: me.assignedVehicle || live?.vehicle || routes[0]?.vehicle || null,
            routes: routes.map((r) => ({
                _id: r._id, name: r.name, routeCode: r.routeCode, color: r.color, shift: r.shift,
                distanceKm: r.distanceKm || 0, stops: (r.stops || []).length,
                vehicle: r.vehicle || null,
                atTheWheel: String(r.driver) === String(me._id),
            })),
            trips: trips.map((t) => ({
                _id: t._id, tripCode: t.tripCode, status: t.status, shift: t.shift, direction: t.direction,
                startTime: t.startTime, endTime: t.endTime, delayMinutes: t.delayMinutes || 0,
                route: t.route, vehicle: t.vehicle, riders: riderCounts(t),
                stops: (t.stopEvents || []).map((x) => ({
                    name: x.name, sequence: x.sequence, status: x.status,
                    plannedTime: x.plannedTime, reachedAt: x.reachedAt,
                })),
            })),
            live: live ? {
                _id: live._id, status: live.status, shift: live.shift, direction: live.direction,
                delayMinutes: live.delayMinutes || 0, riders: riderCounts(live),
            } : null,
            alerts,
            tiles: {
                routes: routes.length,
                tripsToday: trips.length,
                done: trips.filter((t) => t.status === 'completed').length,
                ridersToday: trips.reduce((n, t) => n + (t.studentAttendance || []).length, 0),
            },
        });
    } catch (e) { fail(res, e); }
};

/**
 * Who is on this trip · GET /transport/crew/roster?trip=
 *
 * The register for one of MY trips. The trip is checked against the routes this
 * person crews, so a crew member cannot read another bus's children.
 */
exports.crewRoster = async (req, res) => {
    try {
        const me = await crewOf(req);
        if (!me) return bad(res, 'You do not hold a transport role', 403);
        const trip = await TransportTrip.findOne({ _id: req.query.trip, school: req.schoolId })
            .populate('route', 'name routeCode stops driver attendant').lean();
        if (!trip) return bad(res, 'Trip not found', 404);
        const mine = [trip.route?.driver, trip.route?.attendant, trip.driver, trip.attendant]
            .some((x) => String(x) === String(me._id));
        if (!mine) return bad(res, 'That trip is not one of yours', 403);

        const list = trip.studentAttendance || [];
        const users = list.length
            ? await User.find({ _id: { $in: list.map((x) => String(x.student)) } }).select('name profileImage').lean()
            : [];
        const byId = new Map(users.map((u) => [String(u._id), u]));
        const stops = new Map((trip.route?.stops || []).map((s) => [String(s._id), s.name]));

        ok(res, {
            trip: { _id: trip._id, tripCode: trip.tripCode, status: trip.status,
                shift: trip.shift, direction: trip.direction, route: trip.route?.name },
            riders: list.map((x) => ({
                student: x.student,
                name: byId.get(String(x.student))?.name || 'Unknown',
                photo: byId.get(String(x.student))?.profileImage || '',
                stop: stops.get(String(x.stop)) || '',
                status: x.status, method: x.method,
                boardTime: x.boardTime, dropTime: x.dropTime,
            })),
        });
    } catch (e) { fail(res, e); }
};

/**
 * Turn my own location sharing on or off · POST /transport/crew/sharing
 *
 * The office can set this too, but the person whose phone it is has to be able
 * to switch it off — a position collected without that is not consent.
 */
exports.crewSetSharing = async (req, res) => {
    try {
        const row = await TransportStaff.findOne({ school: req.schoolId, user: req.userId, isActive: true });
        if (!row) return bad(res, 'You do not hold a transport role', 403);
        row.locationSharing = !!req.body.locationSharing;
        await row.save();
        ok(res, { locationSharing: row.locationSharing });
    } catch (e) { fail(res, e); }
};

/**
 * Prove this trip is one the caller crews · middleware
 *
 * The trip lifecycle handlers in transport.controller (start, reach a stop,
 * mark the register) are complete and correct, and they compute the delay and
 * fire the parent notifications on the way through. What they never had was a
 * door a driver could come in by: they sit behind adminGuard and are keyed on
 * `{_id, school}` alone, so nothing but the office could call them — and the
 * office is not on the bus. Every one of them was therefore dead code, and with
 * it the whole live half of the module.
 *
 * This is that door. It checks the trip belongs to the crew member signed in,
 * and then the SAME handler runs, so there is one implementation of "a stop was
 * reached" rather than an admin one and a driver one that drift apart.
 */
exports.ownTrip = async (req, res, next) => {
    try {
        const me = await crewOf(req);
        if (!me) return bad(res, 'You do not hold a transport role', 403);
        const trip = await TransportTrip.findOne({ _id: req.params.id, school: req.schoolId })
            .select('driver attendant route').lean();
        if (!trip) return bad(res, 'Trip not found', 404);
        const route = await TransportRoute.findById(trip.route).select('driver attendant').lean();
        const mine = [trip.driver, trip.attendant, route?.driver, route?.attendant]
            .some((x) => String(x) === String(me._id));
        if (!mine) return bad(res, 'That trip is not one of yours', 403);

        // Cancelling a run is the office's call, not the crew's: it strands
        // every child on it and somebody has to arrange cover.
        if (req.body?.action === 'cancel') {
            return bad(res, 'Only the transport office can cancel a run — ring them', 403);
        }
        req.crew = me;
        return next();
    } catch (e) { return fail(res, e); }
};
