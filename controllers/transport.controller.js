'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Transport Management — Admin / Transport-Manager controller (spec §1–§23)
//  Gated by school.modules.transport + requireRole('school_admin').
// ─────────────────────────────────────────────────────────────────────────────
const Vehicle              = require('../models/Vehicle');
const TransportStaff       = require('../models/TransportStaff');
const TransportRoute       = require('../models/TransportRoute');
const TransportAssignment  = require('../models/TransportAssignment');
const TransportTrip        = require('../models/TransportTrip');
const VehicleLocation      = require('../models/VehicleLocation');
const FuelLog              = require('../models/FuelLog');
const MaintenanceRecord    = require('../models/MaintenanceRecord');
const TransportIncident    = require('../models/TransportIncident');
const TransportComplaint   = require('../models/TransportComplaint');
const TransportFeePlan     = require('../models/TransportFeePlan');
const TransportFeeInvoice  = require('../models/TransportFeeInvoice');
const TransportRequest     = require('../models/TransportRequest');
const TransportSettings    = require('../models/TransportSettings');
const TransportAuditLog    = require('../models/TransportAuditLog');
const StudentProfile       = require('../models/StudentProfile');
const User                 = require('../models/User');

const { notify, withParents } = require('../services/notifyService');

// ── tiny helpers ─────────────────────────────────────────────────────────────
const toId = (id) => String(id);                        // uuid strings for aggregation $match
const ok  = (res, data)             => res.json({ success: true, data });
const bad = (res, msg, code = 400)  => res.status(code).json({ success: false, message: msg });
const fail = (res, e)               => res.status(500).json({ success: false, message: e.message });
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

async function logAudit(req, actionType, entityType, entityId, description, meta = {}) {
    try {
        await TransportAuditLog.create({
            school: req.schoolId, user: req.userId, role: req.userRole,
            actionType, entityType, entityId, description, meta,
        });
    } catch { /* non-critical */ }
}

// Sequential per-school document number: PREFIX-YYMM-#### (or -YYMMDD for trips).
async function nextNumber(Model, schoolId, prefix, withDay = false) {
    const d  = new Date();
    const ym = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`
             + (withDay ? String(d.getDate()).padStart(2, '0') : '');
    const count = await Model.countDocuments({ school: schoolId });
    return `${prefix}-${ym}-${String(count + 1).padStart(4, '0')}`;
}

// Local-midnight day range for a Date|string (avoids the UTC toISOString shift).
function dayRange(dateLike) {
    const d = dateLike ? new Date(dateLike) : new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end   = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    return { start, end };
}
function monthStart(offset = 0) {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() - offset, 1);
}

// Resolve the payable amount for an assignment under its fee plan (spec §14).
function resolveFeeAmount(plan, route, pickupStopId) {
    if (!plan) return 0;
    if (['flat', 'route', 'stop'].includes(plan.basis)) return plan.amount || 0;
    // distance / zone: locate the pickup stop's distance, match a zone band.
    let km = 0;
    if (route && pickupStopId) {
        const st = (route.stops || []).find(s => String(s._id) === String(pickupStopId));
        km = st?.distanceFromStart || 0;
    }
    const bands = [...(plan.zones || [])].sort((a, b) => a.maxDistanceKm - b.maxDistanceKm);
    const band  = bands.find(z => km <= z.maxDistanceKm) || bands[bands.length - 1];
    return band ? band.amount : (plan.amount || 0);
}

// ═════════════════════════════════════════════════════════════════════════════
//  SETTINGS & META
// ═════════════════════════════════════════════════════════════════════════════
async function getOrCreateSettings(schoolId) {
    let s = await TransportSettings.findOne({ school: schoolId });
    if (!s) s = await TransportSettings.create({ school: schoolId });
    return s;
}
exports.getSettings = async (req, res) => {
    try { ok(res, await getOrCreateSettings(req.schoolId)); } catch (e) { fail(res, e); }
};
exports.updateSettings = async (req, res) => {
    try {
        const s = await TransportSettings.findOneAndUpdate(
            { school: req.schoolId }, { $set: req.body }, { new: true, upsert: true });
        await logAudit(req, 'update', 'Settings', s._id, 'Updated transport settings');
        ok(res, s);
    } catch (e) { fail(res, e); }
};

// Lightweight lookups for dropdowns across the admin UI.
exports.getMeta = async (req, res) => {
    try {
        const school = req.schoolId;
        const [vehicles, drivers, attendants, routes, feePlans, students] = await Promise.all([
            Vehicle.find({ school, isActive: true }).select('vehicleNumber registrationNumber capacity status').sort('vehicleNumber').lean(),
            TransportStaff.find({ school, isActive: true, staffType: 'driver' }).select('name employeeId status').sort('name').lean(),
            TransportStaff.find({ school, isActive: true, staffType: 'attendant' }).select('name employeeId status').sort('name').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode shift stops vehicle').sort('name').lean(),
            TransportFeePlan.find({ school, isActive: true }).select('name basis amount frequency').sort('name').lean(),
            User.find({ school, role: 'student', isActive: true }).select('name email').sort('name').lean(),
        ]);
        ok(res, { vehicles, drivers, attendants, routes, feePlans, students });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  DASHBOARD (spec §1)
// ═════════════════════════════════════════════════════════════════════════════
exports.getDashboard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { start: todayStart, end: todayEnd } = dayRange();
        const settings = await getOrCreateSettings(school);
        const soon = new Date(Date.now() + settings.documentReminderDays * 864e5);
        const gpsCut = new Date(Date.now() - 5 * 60 * 1000);
        const m0 = monthStart();

        const [
            totalVehicles, activeVehicles, maintenanceVehicles,
            totalDrivers, activeDrivers, totalAttendants,
            todaysTrips, delayedTrips, completedTrips, runningTrips,
            activeAssignments, activeRoutes, capacityAgg,
            gpsVehicles, openComplaints, openIncidents, pendingRequests,
        ] = await Promise.all([
            Vehicle.countDocuments({ school, isActive: true }),
            Vehicle.countDocuments({ school, isActive: true, status: 'active' }),
            Vehicle.countDocuments({ school, isActive: true, status: 'maintenance' }),
            TransportStaff.countDocuments({ school, isActive: true, staffType: 'driver' }),
            TransportStaff.countDocuments({ school, isActive: true, staffType: 'driver', status: 'active' }),
            TransportStaff.countDocuments({ school, isActive: true, staffType: 'attendant' }),
            TransportTrip.countDocuments({ school, date: { $gte: todayStart, $lt: todayEnd } }),
            TransportTrip.countDocuments({ school, date: { $gte: todayStart, $lt: todayEnd }, delayMinutes: { $gt: settings.delayThresholdMin } }),
            TransportTrip.countDocuments({ school, date: { $gte: todayStart, $lt: todayEnd }, status: 'completed' }),
            TransportTrip.countDocuments({ school, date: { $gte: todayStart, $lt: todayEnd }, status: { $in: ['started', 'paused'] } }),
            TransportAssignment.countDocuments({ school, status: 'active' }),
            TransportRoute.countDocuments({ school, isActive: true, status: 'active' }),
            Vehicle.aggregate([{ $match: { school: toId(school), isActive: true } }, { $group: { _id: null, cap: { $sum: '$capacity' } } }]),
            VehicleLocation.distinct('vehicle', { school, recordedAt: { $gte: gpsCut } }),
            TransportComplaint.countDocuments({ school, status: { $in: ['open', 'assigned', 'in_progress'] } }),
            TransportIncident.countDocuments({ school, status: { $in: ['reported', 'investigating'] } }),
            TransportRequest.countDocuments({ school, status: 'pending' }),
        ]);

        // Fuel & maintenance cost this month.
        const [fuelAgg, maintAgg, feeAgg] = await Promise.all([
            FuelLog.aggregate([{ $match: { school: toId(school), date: { $gte: m0 } } }, { $group: { _id: null, cost: { $sum: '$totalCost' }, litres: { $sum: '$litres' } } }]),
            MaintenanceRecord.aggregate([{ $match: { school: toId(school), completedDate: { $gte: m0 } } }, { $group: { _id: null, cost: { $sum: '$cost' } } }]),
            TransportFeeInvoice.aggregate([{ $match: { school: toId(school), createdAt: { $gte: m0 } } }, { $group: { _id: null, billed: { $sum: '$netAmount' }, paid: { $sum: '$paidAmount' } } }]),
        ]);

        // Upcoming document renewals (vehicles + driver licences/medicals).
        const [vehRenewals, staffRenewals] = await Promise.all([
            Vehicle.find({
                school, isActive: true,
                $or: ['insuranceExpiry','fitnessExpiry','permitExpiry','roadTaxExpiry','pollutionExpiry']
                    .map(f => ({ [f]: { $ne: null, $lte: soon } })),
            }).select('vehicleNumber insuranceExpiry fitnessExpiry permitExpiry roadTaxExpiry pollutionExpiry').lean(),
            TransportStaff.find({
                school, isActive: true,
                $or: [{ licenseExpiry: { $ne: null, $lte: soon } }, { medicalCertExpiry: { $ne: null, $lte: soon } }],
            }).select('name employeeId licenseExpiry medicalCertExpiry').lean(),
        ]);
        const renewals = [];
        vehRenewals.forEach(v => {
            [['insurance','insuranceExpiry'],['fitness','fitnessExpiry'],['permit','permitExpiry'],['road tax','roadTaxExpiry'],['pollution','pollutionExpiry']]
                .forEach(([label, f]) => { if (v[f] && new Date(v[f]) <= soon) renewals.push({ kind: 'vehicle', name: v.vehicleNumber, doc: label, date: v[f] }); });
        });
        staffRenewals.forEach(s => {
            if (s.licenseExpiry && new Date(s.licenseExpiry) <= soon) renewals.push({ kind: 'driver', name: s.name, doc: 'licence', date: s.licenseExpiry });
            if (s.medicalCertExpiry && new Date(s.medicalCertExpiry) <= soon) renewals.push({ kind: 'driver', name: s.name, doc: 'medical', date: s.medicalCertExpiry });
        });
        renewals.sort((a, b) => new Date(a.date) - new Date(b.date));

        // 6-month fuel & fee trends.
        const trendFrom = monthStart(5);
        const [fuelTrend, feeTrend] = await Promise.all([
            FuelLog.aggregate([
                { $match: { school: toId(school), date: { $gte: trendFrom } } },
                { $group: { _id: { y: { $year: '$date' }, m: { $month: '$date' } }, cost: { $sum: '$totalCost' } } },
            ]),
            TransportFeeInvoice.aggregate([
                { $match: { school: toId(school), createdAt: { $gte: trendFrom } } },
                { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, paid: { $sum: '$paidAmount' } } },
            ]),
        ]);
        const buildTrend = (rows, key) => {
            const map = Object.fromEntries(rows.map(r => [`${r._id.y}-${r._id.m}`, r[key]]));
            const out = [];
            for (let i = 5; i >= 0; i--) {
                const d = new Date(); d.setMonth(d.getMonth() - i);
                out.push({ label: MONTHS[d.getMonth()], value: map[`${d.getFullYear()}-${d.getMonth() + 1}`] || 0 });
            }
            return out;
        };

        // Route utilization (top routes by assigned students vs vehicle capacity).
        const routeUtil = await TransportAssignment.aggregate([
            { $match: { school: toId(school), status: 'active' } },
            { $group: { _id: '$route', students: { $sum: 1 } } },
            { $sort: { students: -1 } }, { $limit: 8 },
            { $lookup: { from: 'transportroutes', localField: '_id', foreignField: '_id', as: 'r' } },
            { $unwind: '$r' },
            { $project: { name: '$r.name', students: 1 } },
        ]);

        const recentActivities = await TransportAuditLog.find({ school }).sort('-createdAt').limit(12)
            .populate('user', 'name').lean();

        const totalCapacity = capacityAgg[0]?.cap || 0;
        ok(res, {
            totalVehicles, activeVehicles, maintenanceVehicles,
            totalDrivers, activeDrivers, totalAttendants,
            todaysTrips, delayedTrips, completedTrips, runningTrips,
            studentsTransported: activeAssignments, activeRoutes,
            totalCapacity, occupancy: totalCapacity ? Math.round((activeAssignments / totalCapacity) * 100) : 0,
            gpsOnline: gpsVehicles.length,
            fuelCostMonth: fuelAgg[0]?.cost || 0, fuelLitresMonth: fuelAgg[0]?.litres || 0,
            maintenanceCostMonth: maintAgg[0]?.cost || 0,
            feeBilledMonth: feeAgg[0]?.billed || 0, feeCollectedMonth: feeAgg[0]?.paid || 0,
            openComplaints, openIncidents, pendingRequests,
            upcomingRenewals: renewals.slice(0, 12), renewalCount: renewals.length,
            fuelTrend: buildTrend(fuelTrend, 'cost'),
            feeTrend: buildTrend(feeTrend, 'paid'),
            routeUtilization: routeUtil,
            recentActivities,
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  VEHICLES (spec §2)
// ═════════════════════════════════════════════════════════════════════════════
exports.getVehicles = async (req, res) => {
    try {
        const { search = '', status, type, page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId, isActive: true };
        if (status) q.status = status;
        if (type)   q.vehicleType = type;
        if (search) q.$or = [
            { vehicleNumber: new RegExp(search, 'i') },
            { registrationNumber: new RegExp(search, 'i') },
            { busName: new RegExp(search, 'i') },
        ];
        const [rows, total] = await Promise.all([
            Vehicle.find(q).sort('vehicleNumber').skip((page - 1) * limit).limit(+limit).lean(),
            Vehicle.countDocuments(q),
        ]);
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
exports.getVehicle = async (req, res) => {
    try {
        const v = await Vehicle.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!v) return bad(res, 'Vehicle not found', 404);
        const [routes, fuel, maintenance, incidents, trips] = await Promise.all([
            TransportRoute.find({ school: req.schoolId, vehicle: v._id }).select('name routeCode shift').lean(),
            FuelLog.find({ school: req.schoolId, vehicle: v._id }).sort('-date').limit(10).lean(),
            MaintenanceRecord.find({ school: req.schoolId, vehicle: v._id }).sort('-createdAt').limit(10).lean(),
            TransportIncident.find({ school: req.schoolId, vehicle: v._id }).sort('-date').limit(10).lean(),
            TransportTrip.find({ school: req.schoolId, vehicle: v._id }).sort('-date').limit(10).select('tripCode date shift status delayMinutes').lean(),
        ]);
        ok(res, { ...v, history: { routes, fuel, maintenance, incidents, trips } });
    } catch (e) { fail(res, e); }
};
exports.createVehicle = async (req, res) => {
    try {
        const b = req.body;
        if (!b.registrationNumber) return bad(res, 'Registration number is required');
        const vehicleNumber = b.vehicleNumber || await nextNumber(Vehicle, req.schoolId, 'VH');
        const exists = await Vehicle.findOne({ school: req.schoolId, vehicleNumber });
        if (exists) return bad(res, 'Vehicle number already exists');
        const v = await Vehicle.create({ ...b, vehicleNumber, school: req.schoolId, createdBy: req.userId });
        await logAudit(req, 'create', 'Vehicle', v._id, `Added vehicle ${v.vehicleNumber}`);
        ok(res, v);
    } catch (e) { fail(res, e); }
};
exports.updateVehicle = async (req, res) => {
    try {
        const v = await Vehicle.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId }, { $set: req.body }, { new: true });
        if (!v) return bad(res, 'Vehicle not found', 404);
        await logAudit(req, 'update', 'Vehicle', v._id, `Updated vehicle ${v.vehicleNumber}`);
        ok(res, v);
    } catch (e) { fail(res, e); }
};
exports.deleteVehicle = async (req, res) => {
    try {
        const active = await TransportAssignment.countDocuments({ school: req.schoolId, vehicle: req.params.id, status: 'active' });
        if (active) return bad(res, `Cannot delete — ${active} students are still assigned to this vehicle`);
        const v = await Vehicle.findOneAndUpdate({ _id: req.params.id, school: req.schoolId },
            { $set: { isActive: false, status: 'retired' } }, { new: true });
        if (!v) return bad(res, 'Vehicle not found', 404);
        await logAudit(req, 'delete', 'Vehicle', v._id, `Retired vehicle ${v.vehicleNumber}`);
        ok(res, v);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  STAFF — Drivers & Attendants (spec §3, §4)
// ═════════════════════════════════════════════════════════════════════════════
exports.getStaff = async (req, res) => {
    try {
        const { search = '', staffType, status, page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId, isActive: true };
        if (staffType) q.staffType = staffType;
        if (status)    q.status = status;
        if (search) q.$or = [{ name: new RegExp(search, 'i') }, { employeeId: new RegExp(search, 'i') }, { phone: new RegExp(search, 'i') }];
        const [rows, total] = await Promise.all([
            TransportStaff.find(q).sort('name').skip((page - 1) * limit).limit(+limit).lean({ virtuals: true }),
            TransportStaff.countDocuments(q),
        ]);
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
exports.getStaffMember = async (req, res) => {
    try {
        const s = await TransportStaff.findOne({ _id: req.params.id, school: req.schoolId }).lean({ virtuals: true });
        if (!s) return bad(res, 'Staff not found', 404);
        const routes = await TransportRoute.find({ school: req.schoolId, $or: [{ driver: s._id }, { attendant: s._id }] })
            .select('name routeCode shift').lean();
        ok(res, { ...s, routes });
    } catch (e) { fail(res, e); }
};
exports.createStaff = async (req, res) => {
    try {
        const b = req.body;
        if (!b.name || !b.staffType) return bad(res, 'Name and staff type are required');
        const prefix = b.staffType === 'driver' ? 'DRV' : 'ATT';
        const employeeId = b.employeeId || await nextNumber(TransportStaff, req.schoolId, prefix);
        const exists = await TransportStaff.findOne({ school: req.schoolId, employeeId });
        if (exists) return bad(res, 'Employee ID already exists');
        const s = await TransportStaff.create({ ...b, employeeId, school: req.schoolId, createdBy: req.userId });
        await logAudit(req, 'create', 'Staff', s._id, `Added ${s.staffType} ${s.name}`);
        ok(res, s);
    } catch (e) { fail(res, e); }
};
exports.updateStaff = async (req, res) => {
    try {
        const s = await TransportStaff.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId }, { $set: req.body }, { new: true });
        if (!s) return bad(res, 'Staff not found', 404);
        await logAudit(req, 'update', 'Staff', s._id, `Updated ${s.staffType} ${s.name}`);
        ok(res, s);
    } catch (e) { fail(res, e); }
};
exports.deleteStaff = async (req, res) => {
    try {
        const s = await TransportStaff.findOneAndUpdate({ _id: req.params.id, school: req.schoolId },
            { $set: { isActive: false, status: 'inactive' } }, { new: true });
        if (!s) return bad(res, 'Staff not found', 404);
        await logAudit(req, 'delete', 'Staff', s._id, `Removed ${s.staffType} ${s.name}`);
        ok(res, s);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES & STOPS (spec §5, §6)
// ═════════════════════════════════════════════════════════════════════════════
exports.getRoutes = async (req, res) => {
    try {
        const { search = '', status, shift, page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId, isActive: true };
        if (status) q.status = status;
        if (shift)  q.shift = shift;
        if (search) q.$or = [{ name: new RegExp(search, 'i') }, { routeCode: new RegExp(search, 'i') }];
        const [rows, total] = await Promise.all([
            TransportRoute.find(q).sort('name').skip((page - 1) * limit).limit(+limit)
                .populate('vehicle', 'vehicleNumber capacity')
                .populate('driver', 'name phone').lean(),
            TransportRoute.countDocuments(q),
        ]);
        // attach live student counts
        const counts = await TransportAssignment.aggregate([
            { $match: { school: toId(req.schoolId), status: 'active' } },
            { $group: { _id: '$route', n: { $sum: 1 } } },
        ]);
        const cmap = Object.fromEntries(counts.map(c => [String(c._id), c.n]));
        rows.forEach(r => { r.studentCount = cmap[String(r._id)] || 0; });
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
exports.getRoute = async (req, res) => {
    try {
        const r = await TransportRoute.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('vehicle', 'vehicleNumber capacity registrationNumber')
            .populate('driver', 'name phone employeeId')
            .populate('attendant', 'name phone employeeId').lean();
        if (!r) return bad(res, 'Route not found', 404);
        const assignments = await TransportAssignment.find({ school: req.schoolId, route: r._id, status: 'active' })
            .populate('student', 'name').lean();
        r.studentCount = assignments.length;
        r.students = assignments;
        ok(res, r);
    } catch (e) { fail(res, e); }
};
exports.createRoute = async (req, res) => {
    try {
        const b = req.body;
        if (!b.name) return bad(res, 'Route name is required');
        const routeCode = b.routeCode || await nextNumber(TransportRoute, req.schoolId, 'RT');
        (b.stops || []).forEach((s, i) => { if (s.sequence == null) s.sequence = i + 1; });
        const r = await TransportRoute.create({ ...b, routeCode, school: req.schoolId, createdBy: req.userId });
        await logAudit(req, 'create', 'Route', r._id, `Created route ${r.name}`);
        ok(res, r);
    } catch (e) { fail(res, e); }
};
exports.updateRoute = async (req, res) => {
    try {
        const b = req.body;
        if (b.stops) b.stops.forEach((s, i) => { if (s.sequence == null) s.sequence = i + 1; });
        const r = await TransportRoute.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId }, { $set: b }, { new: true });
        if (!r) return bad(res, 'Route not found', 404);
        // keep vehicle denormalised on active assignments in sync
        if (b.vehicle !== undefined)
            await TransportAssignment.updateMany({ school: req.schoolId, route: r._id, status: 'active' }, { $set: { vehicle: b.vehicle || null } });
        await logAudit(req, 'update', 'Route', r._id, `Updated route ${r.name}`);
        ok(res, r);
    } catch (e) { fail(res, e); }
};
exports.deleteRoute = async (req, res) => {
    try {
        const active = await TransportAssignment.countDocuments({ school: req.schoolId, route: req.params.id, status: 'active' });
        if (active) return bad(res, `Cannot delete — ${active} students are assigned to this route`);
        const r = await TransportRoute.findOneAndUpdate({ _id: req.params.id, school: req.schoolId },
            { $set: { isActive: false, status: 'inactive' } }, { new: true });
        if (!r) return bad(res, 'Route not found', 404);
        await logAudit(req, 'delete', 'Route', r._id, `Deleted route ${r.name}`);
        ok(res, r);
    } catch (e) { fail(res, e); }
};
// Naive route optimisation — order stops by distanceFromStart (spec §5).
exports.optimizeRoute = async (req, res) => {
    try {
        const r = await TransportRoute.findOne({ _id: req.params.id, school: req.schoolId });
        if (!r) return bad(res, 'Route not found', 404);
        r.stops.sort((a, b) => (a.distanceFromStart || 0) - (b.distanceFromStart || 0));
        r.stops.forEach((s, i) => { s.sequence = i + 1; });
        await r.save();
        await logAudit(req, 'optimize', 'Route', r._id, `Optimised stop order for ${r.name}`);
        ok(res, r);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  STUDENT ASSIGNMENTS & SEATS (spec §7, §8)
// ═════════════════════════════════════════════════════════════════════════════
exports.getAssignments = async (req, res) => {
    try {
        const { route, status = 'active', search = '', page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId };
        if (status) q.status = status;
        if (route)  q.route = route;
        let studentFilter = null;
        if (search) {
            const users = await User.find({ school: req.schoolId, role: 'student', name: new RegExp(search, 'i') }).select('_id').lean();
            studentFilter = users.map(u => u._id);
            q.student = { $in: studentFilter };
        }
        const [rows, total] = await Promise.all([
            TransportAssignment.find(q).sort('-createdAt').skip((page - 1) * limit).limit(+limit)
                .populate('student', 'name email')
                .populate('route', 'name routeCode stops')
                .populate('vehicle', 'vehicleNumber')
                .populate('feePlan', 'name amount basis frequency').lean(),
            TransportAssignment.countDocuments(q),
        ]);
        // decorate stop names + class/section from StudentProfile
        const ids = rows.map(r => r.student?._id).filter(Boolean);
        const profs = await StudentProfile.find({ user: { $in: ids } })
            .populate({ path: 'currentSection', select: 'sectionName class', populate: { path: 'class', select: 'className' } }).lean();
        const pmap = Object.fromEntries(profs.map(p => [String(p.user), p]));
        rows.forEach(r => {
            const stops = r.route?.stops || [];
            r.pickupStopName = stops.find(s => String(s._id) === String(r.pickupStop))?.name || '';
            r.dropStopName   = stops.find(s => String(s._id) === String(r.dropStop))?.name || '';
            const p = pmap[String(r.student?._id)];
            r.className   = p?.currentSection?.class?.className || p?.class || '';
            r.sectionName = p?.currentSection?.sectionName || p?.section || '';
            if (r.route) delete r.route.stops;
        });
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
exports.createAssignment = async (req, res) => {
    try {
        const b = req.body;
        if (!b.student || !b.route) return bad(res, 'Student and route are required');
        const dup = await TransportAssignment.findOne({ school: req.schoolId, student: b.student, status: 'active' });
        if (dup) return bad(res, 'Student already has an active transport assignment');
        const route = await TransportRoute.findOne({ _id: b.route, school: req.schoolId }).lean();
        if (!route) return bad(res, 'Route not found');
        const vehicle = b.vehicle || route.vehicle;

        // Capacity + seat checks (spec §8).
        if (vehicle) {
            const veh = await Vehicle.findById(vehicle).lean();
            const occupied = await TransportAssignment.countDocuments({ school: req.schoolId, vehicle, status: 'active' });
            if (veh?.capacity && occupied >= veh.capacity) return bad(res, `Vehicle is full (${occupied}/${veh.capacity})`);
            if (b.seatNumber) {
                const taken = await TransportAssignment.findOne({ school: req.schoolId, vehicle, seatNumber: b.seatNumber, status: 'active' });
                if (taken) return bad(res, `Seat ${b.seatNumber} is already taken`);
            }
        }
        const a = await TransportAssignment.create({ ...b, vehicle, school: req.schoolId, createdBy: req.userId });
        if (vehicle) await Vehicle.updateOne({ _id: vehicle }, { $inc: { currentOccupancy: 1 } });
        await logAudit(req, 'create', 'Assignment', a._id, `Assigned transport for a student on route ${route.name}`);
        withParents([b.student]).then(targets => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🚌 Transport assigned',
            body: `Transport has been assigned on route "${route.name}".${b.seatNumber ? ` Seat: ${b.seatNumber}.` : ''}`,
            recipients: targets,
            link: { type: 'transport.mine', entityId: a._id },
        })).catch(() => {});
        ok(res, a);
    } catch (e) { fail(res, e); }
};
exports.updateAssignment = async (req, res) => {
    try {
        const a = await TransportAssignment.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId }, { $set: req.body }, { new: true });
        if (!a) return bad(res, 'Assignment not found', 404);
        await logAudit(req, 'update', 'Assignment', a._id, 'Updated transport assignment');
        ok(res, a);
    } catch (e) { fail(res, e); }
};
// suspend / cancel / reactivate
exports.setAssignmentStatus = async (req, res) => {
    try {
        const { status, reason = '' } = req.body;
        if (!['active', 'suspended', 'cancelled'].includes(status)) return bad(res, 'Invalid status');
        const a = await TransportAssignment.findOne({ _id: req.params.id, school: req.schoolId });
        if (!a) return bad(res, 'Assignment not found', 404);
        const was = a.status;
        a.status = status;
        a.suspensionReason = status === 'active' ? '' : reason;
        if (status === 'cancelled') a.endDate = new Date();
        await a.save();
        if (a.vehicle) {
            if (was === 'active' && status !== 'active') await Vehicle.updateOne({ _id: a.vehicle }, { $inc: { currentOccupancy: -1 } });
            if (was !== 'active' && status === 'active') await Vehicle.updateOne({ _id: a.vehicle }, { $inc: { currentOccupancy: 1 } });
        }
        await logAudit(req, status, 'Assignment', a._id, `Assignment ${status}`);
        withParents([a.student]).then(targets => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: `🚌 Transport ${status === 'active' ? 'reactivated' : status}`,
            body: `Your transport assignment is now ${status}.${a.suspensionReason ? `\nReason: ${a.suspensionReason}` : ''}`,
            recipients: targets,
            link: { type: 'transport.mine', entityId: a._id },
        })).catch(() => {});
        ok(res, a);
    } catch (e) { fail(res, e); }
};
// Visual seat map for a vehicle (spec §8).
exports.getSeatMap = async (req, res) => {
    try {
        const veh = await Vehicle.findOne({ _id: req.params.vehicleId, school: req.schoolId }).lean();
        if (!veh) return bad(res, 'Vehicle not found', 404);
        const taken = await TransportAssignment.find({ school: req.schoolId, vehicle: veh._id, status: 'active' })
            .populate('student', 'name').lean();
        const seatMap = {};
        taken.forEach(a => { if (a.seatNumber) seatMap[a.seatNumber] = a.student?.name || 'Assigned'; });
        ok(res, { capacity: veh.capacity, occupied: taken.length, available: Math.max(0, veh.capacity - taken.length), seatMap });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  TRIPS (spec §11) + LIVE TRACKING (spec §9) + ATTENDANCE (spec §10)
// ═════════════════════════════════════════════════════════════════════════════
// Generate the pickup+drop trips for a given date from all active routes.
exports.generateTrips = async (req, res) => {
    try {
        const date = req.body.date ? new Date(req.body.date) : new Date();
        const { start, end } = dayRange(date);
        const routes = await TransportRoute.find({ school: req.schoolId, isActive: true, status: 'active', vehicle: { $ne: null } }).lean();
        const routeIds = routes.map(r => r._id);

        // Batched: existing trips for the day + active assignments per route
        // (was one findOne + one find per route×shift), and the trip-code
        // sequence base counted once instead of per trip.
        const [existingTrips, allAssignments] = routeIds.length ? await Promise.all([
            TransportTrip.find({ school: req.schoolId, route: { $in: routeIds }, date: { $gte: start, $lt: end } }).select('route shift').lean(),
            TransportAssignment.find({ school: req.schoolId, route: { $in: routeIds }, status: 'active' }).lean(),
        ]) : [[], []];
        const tripExists = new Set(existingTrips.map(t => `${t.route}:${t.shift}`));
        const assignmentsByRoute = new Map();
        for (const a of allAssignments) {
            const key = String(a.route);
            if (!assignmentsByRoute.has(key)) assignmentsByRoute.set(key, []);
            assignmentsByRoute.get(key).push(a);
        }
        let tripSeq = await TransportTrip.countDocuments({ school: req.schoolId });
        const d = new Date();
        const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

        let created = 0;
        for (const r of routes) {
            const shifts = r.shift === 'both' ? ['morning', 'evening'] : [r.shift];
            for (const shift of shifts) {
                const direction = shift === 'morning' ? 'pickup' : 'drop';
                if (tripExists.has(`${r._id}:${shift}`)) continue;
                const assignments = assignmentsByRoute.get(String(r._id)) || [];
                const stopEvents = [...(r.stops || [])].sort((a, b) => a.sequence - b.sequence)
                    .map(s => ({ stop: s._id, name: s.name, sequence: s.sequence, plannedTime: shift === 'morning' ? s.arrivalTime : s.eveningTime }));
                const studentAttendance = assignments.map(a => ({
                    student: a.student, assignment: a._id,
                    stop: direction === 'pickup' ? a.pickupStop : a.dropStop, status: 'pending',
                }));
                tripSeq++;
                await TransportTrip.create({
                    school: req.schoolId, tripCode: `TRP-${ymd}-${String(tripSeq).padStart(4, '0')}`,
                    route: r._id, vehicle: r.vehicle, driver: r.driver, attendant: r.attendant,
                    date: start, shift, direction, stopEvents, studentAttendance, createdBy: req.userId,
                });
                created++;
            }
        }
        await logAudit(req, 'generate', 'Trip', null, `Generated ${created} trips for ${start.toDateString()}`);
        ok(res, { created });
    } catch (e) { fail(res, e); }
};
exports.getTrips = async (req, res) => {
    try {
        const { date, shift, status, route, page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId };
        if (date)   { const { start, end } = dayRange(date); q.date = { $gte: start, $lt: end }; }
        if (shift)  q.shift = shift;
        if (status) q.status = status;
        if (route)  q.route = route;
        const [rows, total] = await Promise.all([
            TransportTrip.find(q).sort('-date').skip((page - 1) * limit).limit(+limit)
                .populate('route', 'name routeCode')
                .populate('vehicle', 'vehicleNumber')
                .populate('driver', 'name phone').lean(),
            TransportTrip.countDocuments(q),
        ]);
        rows.forEach(t => {
            t.total   = t.studentAttendance?.length || 0;
            t.boarded = (t.studentAttendance || []).filter(s => ['boarded', 'dropped'].includes(s.status)).length;
            t.absent  = (t.studentAttendance || []).filter(s => s.status === 'absent').length;
            delete t.studentAttendance; delete t.stopEvents;
        });
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
exports.getTrip = async (req, res) => {
    try {
        const t = await TransportTrip.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('route', 'name routeCode stops')
            .populate('vehicle', 'vehicleNumber registrationNumber capacity')
            .populate('driver', 'name phone employeeId')
            .populate('attendant', 'name phone')
            .populate('studentAttendance.student', 'name').lean();
        if (!t) return bad(res, 'Trip not found', 404);
        ok(res, t);
    } catch (e) { fail(res, e); }
};
// start / pause / resume / complete / cancel
exports.tripAction = async (req, res) => {
    try {
        const { action, reason = '', odometer } = req.body;
        const t = await TransportTrip.findOne({ _id: req.params.id, school: req.schoolId });
        if (!t) return bad(res, 'Trip not found', 404);
        const now = new Date();
        switch (action) {
            case 'start':
                if (t.status !== 'scheduled' && t.status !== 'paused') return bad(res, 'Trip cannot be started');
                t.status = 'started'; t.startTime = t.startTime || now;
                if (odometer != null) t.startOdometer = odometer;
                break;
            case 'pause':  if (t.status !== 'started') return bad(res, 'Trip is not running'); t.status = 'paused'; t.pausedAt = now; break;
            case 'resume': if (t.status !== 'paused') return bad(res, 'Trip is not paused'); t.status = 'started'; break;
            case 'complete':
                t.status = 'completed'; t.endTime = now;
                if (odometer != null) { t.endOdometer = odometer; await Vehicle.updateOne({ _id: t.vehicle }, { $set: { odometer } }); }
                if (t.driver) await TransportStaff.updateOne({ _id: t.driver }, { $inc: { 'performance.totalTrips': 1 } });
                break;
            case 'cancel': t.status = 'cancelled'; t.cancellationReason = reason; break;
            default: return bad(res, 'Invalid action');
        }
        await t.save();
        await logAudit(req, `trip_${action}`, 'Trip', t._id, `Trip ${t.tripCode} ${action}`);
        ok(res, t);
    } catch (e) { fail(res, e); }
};
// mark a stop as reached / skipped (spec §11 missed stops)
exports.reachStop = async (req, res) => {
    try {
        const { stopId, status = 'reached', latitude, longitude } = req.body;
        const t = await TransportTrip.findOne({ _id: req.params.id, school: req.schoolId });
        if (!t) return bad(res, 'Trip not found', 404);
        const ev = t.stopEvents.id(stopId) || t.stopEvents.find(s => String(s.stop) === String(stopId));
        if (!ev) return bad(res, 'Stop not found on this trip');
        ev.status = status; ev.reachedAt = new Date();
        if (latitude != null) ev.latitude = latitude;
        if (longitude != null) ev.longitude = longitude;
        if (status === 'skipped' && !t.missedStops.includes(ev.name)) t.missedStops.push(ev.name);
        await t.save();
        ok(res, t);
    } catch (e) { fail(res, e); }
};
// bulk mark student boarding/drop attendance (spec §10)
exports.markTripAttendance = async (req, res) => {
    try {
        const { entries = [] } = req.body;   // [{ student, status, method }]
        const t = await TransportTrip.findOne({ _id: req.params.id, school: req.schoolId });
        if (!t) return bad(res, 'Trip not found', 404);
        const now = new Date();
        const map = Object.fromEntries(entries.map(e => [String(e.student), e]));
        t.studentAttendance.forEach(sa => {
            const e = map[String(sa.student)];
            if (!e) return;
            sa.status = e.status;
            sa.method = e.method || sa.method || 'manual';
            sa.byUser = req.userId;
            if (['boarded'].includes(e.status)) sa.boardTime = now;
            if (['dropped'].includes(e.status)) sa.dropTime = now;
        });
        await t.save();
        // NOTE: parent board/drop notifications (spec §19) fire here in production.
        await logAudit(req, 'attendance', 'Trip', t._id, `Marked attendance on trip ${t.tripCode}`);
        ok(res, t);
    } catch (e) { fail(res, e); }
};
// Ingest a GPS ping (spec §9) — from device or driver app.
exports.pushLocation = async (req, res) => {
    try {
        const { vehicle, trip, latitude, longitude, speed = 0, heading = 0, engineOn = true } = req.body;
        if (!vehicle || latitude == null || longitude == null) return bad(res, 'vehicle, latitude, longitude required');
        await VehicleLocation.create({ school: req.schoolId, vehicle, trip: trip || null, latitude, longitude, speed, heading, engineOn });
        if (trip) await TransportTrip.updateOne({ _id: trip, school: req.schoolId },
            { $set: { lastLocation: { latitude, longitude, speed, updatedAt: new Date() } } });
        ok(res, { received: true });
    } catch (e) { fail(res, e); }
};
// Live map: today's running trips with last known position (spec §9).
exports.getLiveTrips = async (req, res) => {
    try {
        const { start, end } = dayRange();
        const trips = await TransportTrip.find({ school: req.schoolId, date: { $gte: start, $lt: end }, status: { $in: ['started', 'paused'] } })
            .populate('route', 'name routeCode')
            .populate('vehicle', 'vehicleNumber registrationNumber gpsDeviceId')
            .populate('driver', 'name phone')
            .select('tripCode shift direction status lastLocation delayMinutes route vehicle driver studentAttendance stopEvents').lean();
        trips.forEach(t => {
            t.boarded = (t.studentAttendance || []).filter(s => ['boarded', 'dropped'].includes(s.status)).length;
            t.total   = t.studentAttendance?.length || 0;
            t.stopsReached = (t.stopEvents || []).filter(s => s.status === 'reached').length;
            t.stopsTotal   = t.stopEvents?.length || 0;
            delete t.studentAttendance; delete t.stopEvents;
        });
        ok(res, trips);
    } catch (e) { fail(res, e); }
};
// Trip playback / vehicle trail (spec §9).
exports.getTrail = async (req, res) => {
    try {
        const q = { school: req.schoolId };
        if (req.query.trip) q.trip = req.query.trip;
        else if (req.query.vehicle) { q.vehicle = req.query.vehicle; const { start } = dayRange(req.query.date); q.recordedAt = { $gte: start }; }
        else return bad(res, 'trip or vehicle required');
        const points = await VehicleLocation.find(q).sort('recordedAt').limit(2000)
            .select('latitude longitude speed heading recordedAt').lean();
        ok(res, points);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  FUEL (spec §15)
// ═════════════════════════════════════════════════════════════════════════════
exports.getFuelLogs = async (req, res) => {
    try {
        const { vehicle, page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId };
        if (vehicle) q.vehicle = vehicle;
        const [rows, total] = await Promise.all([
            FuelLog.find(q).sort('-date').skip((page - 1) * limit).limit(+limit).populate('vehicle', 'vehicleNumber').lean(),
            FuelLog.countDocuments(q),
        ]);
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
exports.createFuelLog = async (req, res) => {
    try {
        const b = req.body;
        if (!b.vehicle || !b.litres) return bad(res, 'Vehicle and litres are required');
        const prev = await FuelLog.findOne({ school: req.schoolId, vehicle: b.vehicle }).sort('-date').lean();
        const previousOdometer = prev?.odometer || 0;
        const distance = b.odometer && previousOdometer ? Math.max(0, b.odometer - previousOdometer) : 0;
        const totalCost = b.totalCost || (b.litres * (b.pricePerLitre || 0));
        const mileage = distance && b.litres ? +(distance / b.litres).toFixed(2) : 0;
        const log = await FuelLog.create({
            ...b, school: req.schoolId, previousOdometer, distance, totalCost, mileage, filledBy: req.userId,
        });
        if (b.odometer) await Vehicle.updateOne({ _id: b.vehicle }, { $set: { odometer: b.odometer, ...(mileage ? { mileage } : {}) } });
        await logAudit(req, 'create', 'Fuel', log._id, `Fuel entry ${b.litres}L`);
        ok(res, log);
    } catch (e) { fail(res, e); }
};
exports.deleteFuelLog = async (req, res) => {
    try { await FuelLog.deleteOne({ _id: req.params.id, school: req.schoolId }); ok(res, { deleted: true }); } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  MAINTENANCE (spec §16)
// ═════════════════════════════════════════════════════════════════════════════
exports.getMaintenance = async (req, res) => {
    try {
        const { vehicle, status, page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId };
        if (vehicle) q.vehicle = vehicle;
        if (status)  q.status = status;
        const [rows, total] = await Promise.all([
            MaintenanceRecord.find(q).sort('-createdAt').skip((page - 1) * limit).limit(+limit).populate('vehicle', 'vehicleNumber').lean(),
            MaintenanceRecord.countDocuments(q),
        ]);
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
exports.createMaintenance = async (req, res) => {
    try {
        const b = req.body;
        if (!b.vehicle || !b.title) return bad(res, 'Vehicle and title are required');
        b.cost = (b.cost || 0) || (b.labourCost || 0) + (b.parts || []).reduce((s, p) => s + (p.cost || 0) * (p.quantity || 1), 0);
        const m = await MaintenanceRecord.create({ ...b, school: req.schoolId, createdBy: req.userId });
        if (b.status === 'in_progress') await Vehicle.updateOne({ _id: b.vehicle }, { $set: { status: 'maintenance' } });
        await logAudit(req, 'create', 'Maintenance', m._id, `Logged maintenance: ${b.title}`);
        ok(res, m);
    } catch (e) { fail(res, e); }
};
exports.updateMaintenance = async (req, res) => {
    try {
        const m = await MaintenanceRecord.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId }, { $set: req.body }, { new: true });
        if (!m) return bad(res, 'Record not found', 404);
        if (req.body.status === 'completed') {
            if (!m.completedDate) { m.completedDate = new Date(); await m.save(); }
            await Vehicle.updateOne({ _id: m.vehicle, status: 'maintenance' }, { $set: { status: 'active' } });
        } else if (req.body.status === 'in_progress') {
            await Vehicle.updateOne({ _id: m.vehicle }, { $set: { status: 'maintenance' } });
        }
        await logAudit(req, 'update', 'Maintenance', m._id, `Updated maintenance ${m.title}`);
        ok(res, m);
    } catch (e) { fail(res, e); }
};
exports.deleteMaintenance = async (req, res) => {
    try { await MaintenanceRecord.deleteOne({ _id: req.params.id, school: req.schoolId }); ok(res, { deleted: true }); } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  INCIDENTS (spec §17)
// ═════════════════════════════════════════════════════════════════════════════
exports.getIncidents = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId };
        if (status) q.status = status;
        const [rows, total] = await Promise.all([
            TransportIncident.find(q).sort('-date').skip((page - 1) * limit).limit(+limit)
                .populate('vehicle', 'vehicleNumber').populate('driver', 'name').lean(),
            TransportIncident.countDocuments(q),
        ]);
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
exports.getIncident = async (req, res) => {
    try {
        const i = await TransportIncident.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('vehicle', 'vehicleNumber registrationNumber').populate('driver', 'name phone')
            .populate('studentsInvolved.student', 'name').populate('reportedBy', 'name').lean();
        if (!i) return bad(res, 'Incident not found', 404);
        ok(res, i);
    } catch (e) { fail(res, e); }
};
exports.createIncident = async (req, res) => {
    try {
        const b = req.body;
        if (!b.description) return bad(res, 'Description is required');
        const incidentCode = await nextNumber(TransportIncident, req.schoolId, 'INC');
        const i = await TransportIncident.create({ ...b, incidentCode, school: req.schoolId, reportedBy: req.userId });
        await logAudit(req, 'create', 'Incident', i._id, `Reported ${b.type || 'incident'} ${incidentCode}`);
        ok(res, i);
    } catch (e) { fail(res, e); }
};
exports.updateIncident = async (req, res) => {
    try {
        const i = await TransportIncident.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId }, { $set: req.body }, { new: true });
        if (!i) return bad(res, 'Incident not found', 404);
        await logAudit(req, 'update', 'Incident', i._id, `Updated incident ${i.incidentCode}`);
        ok(res, i);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  COMPLAINTS (spec §18)
// ═════════════════════════════════════════════════════════════════════════════
exports.getComplaints = async (req, res) => {
    try {
        const { status, category, page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId };
        if (status)   q.status = status;
        if (category) q.category = category;
        const [rows, total] = await Promise.all([
            TransportComplaint.find(q).sort('-createdAt').skip((page - 1) * limit).limit(+limit)
                .populate('raisedBy', 'name role').populate('route', 'name').populate('assignedTo', 'name').lean(),
            TransportComplaint.countDocuments(q),
        ]);
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
exports.getComplaint = async (req, res) => {
    try {
        const c = await TransportComplaint.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('raisedBy', 'name role').populate('route', 'name routeCode')
            .populate('vehicle', 'vehicleNumber').populate('driver', 'name')
            .populate('assignedTo', 'name').populate('timeline.by', 'name').lean();
        if (!c) return bad(res, 'Complaint not found', 404);
        ok(res, c);
    } catch (e) { fail(res, e); }
};
// admin may raise a complaint on behalf of a caller, or triage existing ones.
exports.createComplaint = async (req, res) => {
    try {
        const b = req.body;
        if (!b.subject) return bad(res, 'Subject is required');
        const complaintCode = await nextNumber(TransportComplaint, req.schoolId, 'CMP');
        const c = await TransportComplaint.create({
            ...b, complaintCode, school: req.schoolId, raisedBy: req.userId, raisedByRole: req.userRole,
            timeline: [{ action: 'created', by: req.userId, note: b.subject }],
        });
        await logAudit(req, 'create', 'Complaint', c._id, `Complaint ${complaintCode}`);
        ok(res, c);
    } catch (e) { fail(res, e); }
};
// assign / comment / resolve / close (workflow spec §18)
exports.actOnComplaint = async (req, res) => {
    try {
        const { action, assignedTo, note = '', resolution } = req.body;
        const c = await TransportComplaint.findOne({ _id: req.params.id, school: req.schoolId });
        if (!c) return bad(res, 'Complaint not found', 404);
        if (action === 'assign')      { c.status = 'assigned'; c.assignedTo = assignedTo || null; }
        else if (action === 'progress') c.status = 'in_progress';
        else if (action === 'resolve') { c.status = 'resolved'; c.resolution = resolution || note; }
        else if (action === 'close')    c.status = 'closed';
        else if (action !== 'comment')  return bad(res, 'Invalid action');
        c.timeline.push({ action, by: req.userId, note });
        await c.save();
        await logAudit(req, `complaint_${action}`, 'Complaint', c._id, `Complaint ${c.complaintCode} → ${c.status}`);
        ok(res, c);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  FEE PLANS & INVOICES (spec §14)
// ═════════════════════════════════════════════════════════════════════════════
exports.getFeePlans = async (req, res) => {
    try { ok(res, await TransportFeePlan.find({ school: req.schoolId, isActive: true }).sort('name').lean()); } catch (e) { fail(res, e); }
};
exports.createFeePlan = async (req, res) => {
    try {
        if (!req.body.name) return bad(res, 'Plan name is required');
        const p = await TransportFeePlan.create({ ...req.body, school: req.schoolId, createdBy: req.userId });
        await logAudit(req, 'create', 'FeePlan', p._id, `Created fee plan ${p.name}`);
        ok(res, p);
    } catch (e) { fail(res, e); }
};
exports.updateFeePlan = async (req, res) => {
    try {
        const p = await TransportFeePlan.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: req.body }, { new: true });
        if (!p) return bad(res, 'Plan not found', 404);
        ok(res, p);
    } catch (e) { fail(res, e); }
};
exports.deleteFeePlan = async (req, res) => {
    try {
        await TransportFeePlan.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: { isActive: false, status: 'inactive' } });
        ok(res, { deleted: true });
    } catch (e) { fail(res, e); }
};
exports.getInvoices = async (req, res) => {
    try {
        const { status, student, month, year, page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId };
        if (status)  q.status = status;
        if (student) q.student = student;
        if (year)    q['period.year'] = +year;
        if (month)   q['period.month'] = +month;
        const [rows, total, summary] = await Promise.all([
            TransportFeeInvoice.find(q).sort('-createdAt').skip((page - 1) * limit).limit(+limit)
                .populate('student', 'name').populate('feePlan', 'name').lean(),
            TransportFeeInvoice.countDocuments(q),
            TransportFeeInvoice.aggregate([{ $match: { ...q, school: toId(req.schoolId) } },
                { $group: { _id: null, billed: { $sum: '$netAmount' }, paid: { $sum: '$paidAmount' } } }]),
        ]);
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit),
            summary: { billed: summary[0]?.billed || 0, paid: summary[0]?.paid || 0, due: (summary[0]?.billed || 0) - (summary[0]?.paid || 0) } });
    } catch (e) { fail(res, e); }
};
// Bulk-generate monthly invoices from active assignments with a fee plan.
exports.generateInvoices = async (req, res) => {
    try {
        const now = new Date();
        const month = +req.body.month || (now.getMonth() + 1);
        const year  = +req.body.year || now.getFullYear();
        const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : new Date(year, month - 1, 10);
        const assignments = await TransportAssignment.find({ school: req.schoolId, status: 'active', feePlan: { $ne: null } })
            .populate('feePlan').populate('route', 'stops').lean();

        // Batched: one existence lookup for the whole billing period (was one
        // findOne per assignment) and the invoice sequence counted once.
        const studentIds = [...new Set(assignments.map(a => String(a.student)).filter(Boolean))];
        const existing = studentIds.length ? await TransportFeeInvoice.find({
            school: req.schoolId, student: { $in: studentIds }, 'period.month': month, 'period.year': year,
        }).select('student').lean() : [];
        const invoiced = new Set(existing.map(e => String(e.student)));
        let invSeq = await TransportFeeInvoice.countDocuments({ school: req.schoolId });
        const now2 = new Date();
        const ym = `${String(now2.getFullYear()).slice(2)}${String(now2.getMonth() + 1).padStart(2, '0')}`;

        let created = 0;
        for (const a of assignments) {
            if (invoiced.has(String(a.student))) continue;
            const amount = resolveFeeAmount(a.feePlan, a.route, a.pickupStop);
            if (!amount) continue;
            invoiced.add(String(a.student)); // guard against duplicate assignments in this run
            invSeq++;
            const inv = new TransportFeeInvoice({
                school: req.schoolId, invoiceNumber: `TF-${ym}-${String(invSeq).padStart(4, '0')}`,
                student: a.student, assignment: a._id, feePlan: a.feePlan._id,
                period: { month, year, label: `${MONTHS[month - 1]} ${year}` },
                amount, dueDate, generatedBy: req.userId,
            });
            await inv.save();
            created++;
        }
        await logAudit(req, 'generate', 'Invoice', null, `Generated ${created} transport invoices for ${MONTHS[month - 1]} ${year}`);
        ok(res, { created });
    } catch (e) { fail(res, e); }
};
exports.recordFeePayment = async (req, res) => {
    try {
        const { amount, mode = 'cash', reference = '', note = '' } = req.body;
        if (!amount || amount <= 0) return bad(res, 'Valid amount required');
        const inv = await TransportFeeInvoice.findOne({ _id: req.params.id, school: req.schoolId });
        if (!inv) return bad(res, 'Invoice not found', 404);
        if (inv.status === 'cancelled') return bad(res, 'Invoice is cancelled');
        inv.payments.push({ amount, mode, reference, note, receivedBy: req.userId,
            receiptNumber: await nextNumber(TransportFeeInvoice, req.schoolId, 'TRC') });
        await inv.save();
        await logAudit(req, 'payment', 'Invoice', inv._id, `Recorded ₹${amount} on ${inv.invoiceNumber}`);
        ok(res, inv);
    } catch (e) { fail(res, e); }
};
exports.cancelInvoice = async (req, res) => {
    try {
        const inv = await TransportFeeInvoice.findOne({ _id: req.params.id, school: req.schoolId });
        if (!inv) return bad(res, 'Invoice not found', 404);
        inv.status = 'cancelled'; await inv.save();
        await logAudit(req, 'cancel', 'Invoice', inv._id, `Cancelled ${inv.invoiceNumber}`);
        ok(res, inv);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  REQUESTS — approval workflow (spec §20)
// ═════════════════════════════════════════════════════════════════════════════
exports.getRequests = async (req, res) => {
    try {
        const { status = 'pending', page = 1, limit = 20 } = req.query;
        const q = { school: req.schoolId };
        if (status) q.status = status;
        const [rows, total] = await Promise.all([
            TransportRequest.find(q).sort('-createdAt').skip((page - 1) * limit).limit(+limit)
                .populate('requestedBy', 'name role').populate('student', 'name')
                .populate('details.route', 'name routeCode stops').lean(),
            TransportRequest.countDocuments(q),
        ]);
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
exports.actOnRequest = async (req, res) => {
    try {
        const { action, note = '' } = req.body;   // approve | reject
        const r = await TransportRequest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!r) return bad(res, 'Request not found', 404);
        if (r.status !== 'pending') return bad(res, 'Request already processed');
        r.reviewedBy = req.userId; r.reviewNote = note; r.reviewedAt = new Date();

        if (action === 'reject') {
            r.status = 'rejected'; await r.save();
            await logAudit(req, 'reject', 'Request', r._id, `Rejected ${r.requestCode}`);
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '🚌 Transport request rejected',
                body: `Your transport request ${r.requestCode} (${r.requestType.replace(/_/g, ' ')}) was rejected.${note ? `\nNote: ${note}` : ''}`,
                recipients: [r.requestedBy],
                link: { type: 'transport.requests', entityId: r._id },
            });
            return ok(res, r);
        }
        if (action !== 'approve') return bad(res, 'Invalid action');

        // Apply the approved change to the student's assignment.
        const d = r.details || {};
        if (r.requestType === 'cancellation') {
            await TransportAssignment.updateMany({ school: req.schoolId, student: r.student, status: 'active' },
                { $set: { status: 'cancelled', endDate: new Date(), suspensionReason: 'Parent cancellation request' } });
        } else if (r.requestType === 'new_transport') {
            const route = await TransportRoute.findById(d.route).lean();
            if (route) await TransportAssignment.create({
                school: req.schoolId, student: r.student, route: d.route, vehicle: route.vehicle,
                pickupStop: d.pickupStop, dropStop: d.dropStop, createdBy: req.userId,
            });
        } else {
            const a = await TransportAssignment.findOne({ school: req.schoolId, student: r.student, status: 'active' });
            if (a) {
                if (r.requestType === 'route_change' && d.route) { const route = await TransportRoute.findById(d.route).lean(); a.route = d.route; a.vehicle = route?.vehicle || a.vehicle; }
                if (r.requestType === 'stop_change') { if (d.pickupStop) a.pickupStop = d.pickupStop; if (d.dropStop) a.dropStop = d.dropStop; }
                if (r.requestType === 'temporary_address') { a.isTemporary = true; a.temporaryAddress = d.address; }
                if (r.requestType === 'permanent_address') a.temporaryAddress = '';
                await a.save();
            }
        }
        r.status = 'approved'; await r.save();
        await logAudit(req, 'approve', 'Request', r._id, `Approved ${r.requestCode} (${r.requestType})`);
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🚌 Transport request approved',
            body: `Your transport request ${r.requestCode} (${r.requestType.replace(/_/g, ' ')}) has been approved.${note ? `\nNote: ${note}` : ''}`,
            recipients: [r.requestedBy],
            link: { type: 'transport.requests', entityId: r._id },
        });
        ok(res, r);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  REPORTS (spec §22) & AUDIT
// ═════════════════════════════════════════════════════════════════════════════
exports.getReports = async (req, res) => {
    try {
        const school = toId(req.schoolId);
        const from = req.query.from ? new Date(req.query.from) : monthStart(2);
        const to   = req.query.to ? new Date(req.query.to) : new Date();
        const [fuel, maintenance, fees, occupancy, incidents] = await Promise.all([
            FuelLog.aggregate([{ $match: { school, date: { $gte: from, $lte: to } } },
                { $group: { _id: '$vehicle', litres: { $sum: '$litres' }, cost: { $sum: '$totalCost' }, avgMileage: { $avg: '$mileage' } } },
                { $lookup: { from: 'vehicles', localField: '_id', foreignField: '_id', as: 'v' } }, { $unwind: '$v' },
                { $project: { vehicle: '$v.vehicleNumber', litres: 1, cost: 1, avgMileage: { $round: ['$avgMileage', 1] } } }]),
            MaintenanceRecord.aggregate([{ $match: { school, createdAt: { $gte: from, $lte: to } } },
                { $group: { _id: '$category', count: { $sum: 1 }, cost: { $sum: '$cost' } } }, { $sort: { cost: -1 } }]),
            TransportFeeInvoice.aggregate([{ $match: { school, createdAt: { $gte: from, $lte: to } } },
                { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$netAmount' }, paid: { $sum: '$paidAmount' } } }]),
            TransportAssignment.aggregate([{ $match: { school, status: 'active' } },
                { $group: { _id: '$vehicle', students: { $sum: 1 } } },
                { $lookup: { from: 'vehicles', localField: '_id', foreignField: '_id', as: 'v' } }, { $unwind: '$v' },
                { $project: { vehicle: '$v.vehicleNumber', capacity: '$v.capacity', students: 1,
                    utilization: { $cond: [{ $gt: ['$v.capacity', 0] }, { $round: [{ $multiply: [{ $divide: ['$students', '$v.capacity'] }, 100] }, 0] }, 0] } } }]),
            TransportIncident.aggregate([{ $match: { school, date: { $gte: from, $lte: to } } },
                { $group: { _id: '$type', count: { $sum: 1 }, repairCost: { $sum: '$repairCost' } } }]),
        ]);
        ok(res, { range: { from, to }, fuel, maintenance, fees, occupancy, incidents });
    } catch (e) { fail(res, e); }
};
exports.getAuditLog = async (req, res) => {
    try {
        const { entityType, page = 1, limit = 30 } = req.query;
        const q = { school: req.schoolId };
        if (entityType) q.entityType = entityType;
        const [rows, total] = await Promise.all([
            TransportAuditLog.find(q).sort('-createdAt').skip((page - 1) * limit).limit(+limit).populate('user', 'name role').lean(),
            TransportAuditLog.countDocuments(q),
        ]);
        ok(res, { data: rows, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (e) { fail(res, e); }
};
