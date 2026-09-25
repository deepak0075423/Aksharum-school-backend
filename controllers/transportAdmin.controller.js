'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Transport — admin READ MODELS and the actions the Sep 2026 redesign added.
//
//  transport.controller.js stays the module's CRUD: one endpoint per entity,
//  shaped like the entity. Every screen in the redesign instead asks a single
//  question ("what should the Fuel page show today?") whose answer spans five
//  collections, so those queries live here, one exported function per screen,
//  named after the screen. Nothing in this file writes an entity that the CRUD
//  controller owns except through the same guards.
// ─────────────────────────────────────────────────────────────────────────────
const Vehicle             = require('../models/Vehicle');
const TransportStaff      = require('../models/TransportStaff');
const TransportRoute      = require('../models/TransportRoute');
const TransportAssignment = require('../models/TransportAssignment');
const TransportTrip       = require('../models/TransportTrip');
const VehicleLocation     = require('../models/VehicleLocation');
const FuelLog             = require('../models/FuelLog');
const MaintenanceRecord   = require('../models/MaintenanceRecord');
const TransportIncident   = require('../models/TransportIncident');
const TransportComplaint  = require('../models/TransportComplaint');
const TransportFeePlan    = require('../models/TransportFeePlan');
const TransportFeeInvoice = require('../models/TransportFeeInvoice');
const TransportRequest    = require('../models/TransportRequest');
const TransportSettings   = require('../models/TransportSettings');
const TransportAuditLog   = require('../models/TransportAuditLog');
const TransportReport     = require('../models/TransportReport');
const TransportStaffLocation = require('../models/TransportStaffLocation');
const StudentProfile      = require('../models/StudentProfile');
const TeacherProfile      = require('../models/TeacherProfile');
const User                = require('../models/User');
const School              = require('../models/School');
const AcademicYear        = require('../models/AcademicYear');

const { notify, withParents } = require('../services/notifyService');
const { occupancyByVehicle, syncOccupancy } = require('../services/transportSeats');

// ── replies ──────────────────────────────────────────────────────────────────
const ok   = (res, data)            => res.json({ success: true, data });
const bad  = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const fail = (res, e)               => res.status(500).json({ success: false, message: e.message });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── time ─────────────────────────────────────────────────────────────────────
// Local midnight, never toISOString — a UTC day boundary puts an 05:30 IST trip
// on the previous date.
function dayRange(dateLike) {
    const d = dateLike ? new Date(dateLike) : new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return { start, end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) };
}
const monthStart = (back = 0) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - back, 1); };
const daysAgo    = (n) => new Date(Date.now() - n * 864e5);
const addDays    = (d, n) => new Date(new Date(d).getTime() + n * 864e5);

/** A from/to window from ?from&to, ?days, or a default span of days. */
function windowFrom(query = {}, defaultDays = 30) {
    const to = query.to ? new Date(query.to) : new Date();
    let from;
    if (query.from) from = new Date(query.from);
    else if (query.days) from = daysAgo(+query.days);
    else from = daysAgo(defaultDays);
    const s = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const e = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
    return { from: s, to: e, days: Math.max(1, Math.round((e - s) / 864e5)) };
}

// ── numbers ──────────────────────────────────────────────────────────────────
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const pct = (a, b) => (b ? Math.round((num(a) / b) * 100) : 0);
/**
 * Percentages of a whole that add up to 100.
 *
 * Rounding each share on its own is what printed "23% · 0% · 78%" beside a
 * three-slice donut. Largest-remainder hands the leftover point to whichever
 * share was cut hardest, so the column always totals 100.
 */
function shares(values) {
    const nums = values.map(num);
    const total = nums.reduce((a, b) => a + b, 0);
    if (!total) return nums.map(() => 0);
    const exact = nums.map((v) => (v / total) * 100);
    const out = exact.map(Math.floor);
    let left = 100 - out.reduce((a, b) => a + b, 0);
    exact.map((v, i) => [v - out[i], i]).sort((x, y) => y[0] - x[0])
        .forEach(([, i]) => { if (left > 0) { out[i] += 1; left -= 1; } });
    return out;
}
const round1 = (v) => Math.round(num(v) * 10) / 10;
/** Percentage change, or null when there is no previous figure to compare to. */
const delta = (now, before) => (before ? Math.round(((num(now) - before) / before) * 100) : null);

// "07:15" → minutes since midnight. Returns null for anything unparseable, so
// a blank stop time never becomes 00:00 and sorts to the top of a timetable.
function hhmmToMin(s) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '').trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
}
const minToHhmm = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(Math.round(((m % 60) + 60) % 60)).padStart(2, '0')}`;

// Great-circle metres between two lat/lng pairs.
function metresBetween(a, b) {
    if (!a || !b || a.latitude == null || b.latitude == null || a.longitude == null || b.longitude == null) return null;
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * rad;
    const dLon = (b.longitude - a.longitude) * rad;
    const la1 = a.latitude * rad, la2 = b.latitude * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

// ── vocabulary ───────────────────────────────────────────────────────────────
// One colour per route, everywhere: the R-badge in the list, the line on the
// map, the slice in the donut and the bar in the chart are the same route, so
// they are the same colour. A route may override with its own `color`.
// This order is not taste: it is the output of the palette validator
// (adjacent-pair CVD separation, chroma floor, lightness band and 3:1 contrast
// against a white card all pass). Reordering or extending it re-opens those
// checks. The one warning it carries — green↔amber at ΔE 6.2 for protanopia —
// is allowed because every route mark is directly labelled with its R-tag and
// every slice has a named legend, which is the secondary encoding that band
// requires. A ninth route folds into a neutral "Other", it does not get a
// ninth generated hue.
const ROUTE_COLORS = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#db2777', '#a16207'];
const ROUTE_OTHER = '#94a3b8';
const routeColor = (route, i = 0) => route?.color || (i < ROUTE_COLORS.length ? ROUTE_COLORS[i] : ROUTE_OTHER);
/** "R1" from a code like RT-2609-0001, else the first characters of the name. */
function routeTag(route, i = 0) {
    const explicit = /(^|[^A-Za-z])R(\d{1,2})\b/.exec(String(route?.routeCode || ''));
    if (explicit) return `R${explicit[2]}`;
    const inName = /\bR(\d{1,2})\b/.exec(String(route?.name || ''));
    if (inName) return `R${inName[1]}`;
    return `R${i + 1}`;
}
/** Decorate routes with the tag/colour every screen draws them with. */
function tagRoutes(routes = []) {
    const sorted = [...routes].sort((a, b) => String(a.routeCode || '').localeCompare(String(b.routeCode || '')));
    const order = new Map(sorted.map((r, i) => [String(r._id), i]));
    return routes.map((r) => {
        const i = order.get(String(r._id)) ?? 0;
        return { ...r, tag: routeTag(r, i), color: routeColor(r, i) };
    });
}

/** The crew words the screens use; 'attendant' is the old name for a helper. */
const STAFF_ROLE = { driver: 'Driver', conductor: 'Conductor', helper: 'Helper', attendant: 'Helper' };
const staffRole = (s) => STAFF_ROLE[s?.staffType] || 'Crew';

const sentence = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : '');

async function getSettings(schoolId) {
    let s = await TransportSettings.findOne({ school: schoolId }).lean();
    if (!s) s = (await TransportSettings.create({ school: schoolId })).toObject?.() || { school: schoolId };
    // A settings row written before a column existed carries NULL in it, and a
    // plain spread lets that NULL win over the default — which is how the
    // Settings screen came to draw two unchosen radio buttons for a field that
    // has a default of 'km'. So the defaults fill anything null or absent.
    const fallback = {
        delayThresholdMin: 10, documentReminderDays: 30, geofenceRadiusM: 150, deviationAlertM: 500,
        serviceDueDays: 7, lowMileageThreshold: 4, fuelSpikePct: 20, missingFuelEntryDays: 7,
        maxStudentsPerBus: 60, trackingIntervalSec: 30, licenceReminderDays: 30, currency: 'INR',
        distanceUnit: 'km', timeFormat: '12h', moduleName: 'Transport', primaryColor: '#4f46e5',
        earlyArrivalBufferMin: 0, locationRetentionDays: 180, backupFrequency: 'weekly',
        gpsProvider: 'device', mapProvider: 'openfreemap', invoicePrefix: 'TF', invoiceDueDay: 10,
    };
    const merged = { ...fallback, ...s };
    for (const k of Object.keys(fallback)) {
        if (merged[k] === null || merged[k] === undefined || merged[k] === '') merged[k] = fallback[k];
    }
    return merged;
}

/**
 * What the browser needs to draw a map, from the school's settings.
 *
 * The Google key is a BROWSER key: it is meant to be public and is restricted
 * by HTTP referrer in the Google Cloud console, not by hiding it. It is only
 * sent when Google is actually the chosen provider, so a school on OpenFreeMap
 * never ships a key it is not using.
 */
function mapConfig(st) {
    const provider = st.mapProvider || 'openfreemap';
    return {
        provider,
        tiles: provider !== 'builtin',
        apiKey: provider === 'google' ? (st.mapApiKey || '') : '',
    };
}

async function logAudit(req, actionType, entityType, entityId, description, meta = {}) {
    try {
        await TransportAuditLog.create({
            school: req.schoolId, user: req.userId, role: req.userRole,
            actionType, entityType, entityId, description, meta,
        });
    } catch { /* an audit row must never fail the action it describes */ }
}

async function nextNumber(Model, schoolId, prefix, withDay = false) {
    const d = new Date();
    const ym = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`
             + (withDay ? String(d.getDate()).padStart(2, '0') : '');
    const count = await Model.countDocuments({ school: schoolId });
    return `${prefix}-${ym}-${String(count + 1).padStart(4, '0')}`;
}

/**
 * Class and section for a set of student User ids, plus admission number and
 * photo. Every screen that lists children needs exactly this, and it is two
 * queries however many students there are.
 */
async function studentIndex(ids = []) {
    const uniq = [...new Set(ids.map(String).filter(Boolean))];
    if (!uniq.length) return new Map();
    const [users, profiles] = await Promise.all([
        User.find({ _id: { $in: uniq } }).select('name email profileImage').lean(),
        StudentProfile.find({ user: { $in: uniq } })
            .select('user admissionNumber rollNumber photoFile currentClass currentSection')
            .populate({ path: 'currentSection', select: 'sectionName class', populate: { path: 'class', select: 'className' } })
            .populate({ path: 'currentClass', select: 'className' })
            .lean(),
    ]);
    const byProfile = new Map(profiles.map((p) => [String(p.user), p]));
    return new Map(users.map((u) => {
        const p = byProfile.get(String(u._id));
        const className = p?.currentSection?.class?.className || p?.currentClass?.className || '';
        const sectionName = p?.currentSection?.sectionName || '';
        return [String(u._id), {
            _id: u._id,
            name: u.name || '',
            photo: p?.photoFile || u.profileImage || '',
            admissionNumber: p?.admissionNumber || '',
            rollNumber: p?.rollNumber || '',
            className,
            sectionName,
            // Schools name their classes either "1" or "Class 1"; prefixing
            // blindly is what produced "Class Class 1A" on every student row.
            classLabel: className
                ? `${/^class\b/i.test(className) ? className : `Class ${className}`}${sectionName || ''}`
                : '',
        }];
    }));
}

exports._syncOccupancy = syncOccupancy;
exports._studentIndex = studentIndex;
exports._tagRoutes = tagRoutes;
/**
 * Names for enrolled people, whichever kind they are.
 *
 * `studentIndex` reads a StudentProfile and so returns nothing for a teacher;
 * enrolments now cover staff riders too, and a row whose name renders as "—"
 * is how that used to show up on screen.
 */
async function personIndex(ids = []) {
    const list = [...new Set(ids.filter(Boolean).map(String))];
    if (!list.length) return new Map();
    const users = await User.find({ _id: { $in: list } }).select('name email phone profileImage role').lean();
    const studentIds = users.filter((u) => u.role === 'student').map((u) => u._id);
    const teacherIds = users.filter((u) => u.role !== 'student').map((u) => u._id);
    const [students, teachers] = await Promise.all([
        studentIds.length ? studentIndex(studentIds) : Promise.resolve(new Map()),
        teacherIds.length
            ? TeacherProfile.find({ user: { $in: teacherIds } })
                .select('user employeeId designation department photoFile').lean()
            : Promise.resolve([]),
    ]);
    const byTeacher = new Map(teachers.map((t) => [String(t.user), t]));
    return new Map(users.map((u) => {
        if (u.role === 'student') {
            const s = students.get(String(u._id));
            return [String(u._id), { ...(s || { _id: u._id, name: u.name || '' }), personType: 'student' }];
        }
        const t = byTeacher.get(String(u._id)) || {};
        return [String(u._id), {
            _id: u._id, personType: 'teacher', name: u.name || '', email: u.email || '',
            phone: u.phone || '', photo: t.photoFile || u.profileImage || '',
            employeeId: t.employeeId || '', designation: t.designation || '', department: t.department || '',
            // So a teacher row can use the same column as a student's class.
            classLabel: [t.designation, t.department].filter(Boolean).join(' · ') || 'Staff',
            admissionNumber: t.employeeId || '',
        }];
    }));
}
exports._personIndex = personIndex;

/**
 * People who can be enrolled in the service · GET /transport/admin/enrollable
 *
 * Students AND teachers, each carrying whether they already have a live
 * enrolment, so the picker can show it rather than failing on submit.
 * `?personType=` narrows it; `?free=1` drops anyone already enrolled.
 */
exports.enrollablePeople = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', personType = '', classId = '', free = '', limit = 80 } = req.query;

        const roles = personType === 'teacher' ? ['teacher']
            : personType === 'student' ? ['student'] : ['student', 'teacher'];
        const users = await User.find({ school, role: { $in: roles }, isActive: true })
            .select('name email phone profileImage role').sort('name').lean();
        const ids = users.map((u) => u._id);
        const [index, live] = await Promise.all([
            personIndex(ids),
            TransportAssignment.find({ school, status: { $in: ['active', 'suspended'] } })
                .select('student route vehicle status personType').lean(),
        ]);
        const enrolled = new Map(live.map((a) => [String(a.student), a]));

        const needle = String(search).trim().toLowerCase();
        const rows = users.map((u) => {
            const p = index.get(String(u._id)) || {};
            const a = enrolled.get(String(u._id));
            return {
                _id: u._id,
                personType: u.role === 'student' ? 'student' : 'teacher',
                name: p.name || u.name || '',
                photo: p.photo || '',
                identifier: p.admissionNumber || p.employeeId || '',
                classLabel: p.classLabel || '',
                className: p.className || '',
                phone: p.phone || u.phone || '',
                enrolled: !!a,
                enrolmentStatus: a?.status || '',
            };
        }).filter((r) => {
            if (free && r.enrolled) return false;
            if (classId && r.className !== classId) return false;
            if (needle && ![r.name, r.identifier, r.classLabel].join(' ').toLowerCase().includes(needle)) return false;
            return true;
        });
        // Not-yet-enrolled first: that is who this picker is usually for.
        rows.sort((a, b) => (a.enrolled ? 1 : 0) - (b.enrolled ? 1 : 0) || a.name.localeCompare(b.name));
        ok(res, {
            data: rows.slice(0, +limit),
            total: rows.length,
            counts: {
                students: rows.filter((r) => r.personType === 'student').length,
                teachers: rows.filter((r) => r.personType === 'teacher').length,
                unenrolled: rows.filter((r) => !r.enrolled).length,
            },
        });
    } catch (e) { fail(res, e); }
};

exports._getSettings = getSettings;

// ═════════════════════════════════════════════════════════════════════════════
//  DASHBOARD  ·  GET /transport/admin/overview
// ═════════════════════════════════════════════════════════════════════════════
exports.overview = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const { start: todayStart, end: todayEnd } = dayRange();
        const { start: yStart, end: yEnd } = dayRange(daysAgo(1));
        const m0 = monthStart();
        const routeFilter = req.query.route && req.query.route !== 'all' ? req.query.route : null;

        const [vehicles, crew, routesRaw, assignments, trips, yTrips, schoolDoc] = await Promise.all([
            Vehicle.find({ school, isActive: true }).select('vehicleNumber status capacity latitude longitude vehicleType').lean(),
            TransportStaff.find({ school, isActive: true }).select('name staffType status').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode shift status color zone').lean(),
            TransportAssignment.find({ school, status: 'active' }).select('route vehicle student').lean(),
            TransportTrip.find({ school, date: { $gte: todayStart, $lt: todayEnd } })
                .select('route vehicle driver attendant status delayMinutes shift direction lastLocation tripCode studentAttendance updatedAt').lean(),
            TransportTrip.find({ school, date: { $gte: yStart, $lt: yEnd } }).select('studentAttendance').lean(),
            School.findById(school).select('name address').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));

        // ── Fleet ────────────────────────────────────────────────────────────
        const fleet = { total: vehicles.length, active: 0, maintenance: 0, inactive: 0 };
        vehicles.forEach((v) => {
            if (v.status === 'maintenance') fleet.maintenance++;
            else if (v.status === 'active') fleet.active++;
            else fleet.inactive++;
        });

        // ── Crew. "On duty" is a crew member rostered onto a trip today; with no
        //    trips yet it falls back to who is simply active, which is what a
        //    school means before the first bus rolls.
        const dutyIds = new Set(trips.flatMap((t) => [t.driver, t.attendant]).filter(Boolean).map(String));
        const activeCrew = crew.filter((c) => c.status === 'active');
        const onDuty = dutyIds.size ? activeCrew.filter((c) => dutyIds.has(String(c._id))).length : activeCrew.length;
        const crewTile = {
            total: crew.length, onDuty, offDuty: crew.length - onDuty,
            drivers: crew.filter((c) => c.staffType === 'driver').length,
            conductors: crew.filter((c) => c.staffType === 'conductor').length,
            helpers: crew.filter((c) => ['helper', 'attendant'].includes(c.staffType)).length,
            onLeave: crew.filter((c) => c.status === 'on_leave').length,
        };

        // ── Students transported. Today's figure is who actually boarded; before
        //    the first trip of the day that is 0, so the tile falls back to who
        //    is assigned and says which it is showing.
        const boardedOn = (list) => new Set(list.flatMap((t) => (t.studentAttendance || [])
            .filter((s) => ['boarded', 'dropped'].includes(s.status)).map((s) => String(s.student)))).size;
        const boardedToday = boardedOn(trips);
        const boardedYesterday = boardedOn(yTrips);
        const assigned = assignments.length;

        // ── Routes by shift ──────────────────────────────────────────────────
        const activeRoutes = routes.filter((r) => r.status === 'active');
        const shifts = { morning: 0, afternoon: 0, both: 0 };
        activeRoutes.forEach((r) => {
            if (r.shift === 'morning') shifts.morning++;
            else if (r.shift === 'evening') shifts.afternoon++;
            else shifts.both++;
        });

        // ── Today's trips donut ──────────────────────────────────────────────
        const scoped = routeFilter ? trips.filter((t) => String(t.route) === String(routeFilter)) : trips;
        const tripTile = { total: scoped.length, completed: 0, inProgress: 0, delayed: 0, cancelled: 0, scheduled: 0 };
        scoped.forEach((t) => {
            if (t.status === 'cancelled') tripTile.cancelled++;
            else if ((t.delayMinutes || 0) > st.delayThresholdMin) tripTile.delayed++;
            else if (t.status === 'completed') tripTile.completed++;
            else if (['started', 'paused'].includes(t.status)) tripTile.inProgress++;
            else tripTile.scheduled++;
        });

        // ── Money ────────────────────────────────────────────────────────────
        const [todayPay, yestPay, monthInvoices, fuelRows] = await Promise.all([
            TransportFeeInvoice.find({ school, 'payments.paidAt': { $gte: todayStart, $lt: todayEnd } }).select('payments').lean(),
            TransportFeeInvoice.find({ school, 'payments.paidAt': { $gte: yStart, $lt: yEnd } }).select('payments').lean(),
            TransportFeeInvoice.find({ school, createdAt: { $gte: m0 } }).select('netAmount paidAmount status dueDate').lean(),
            FuelLog.find({ school, date: { $gte: monthStart(5) } }).select('date litres totalCost').lean(),
        ]);
        const sumPaidBetween = (rows, a, b) => rows.reduce((s, inv) => s + (inv.payments || [])
            .filter((p) => p.paidAt && new Date(p.paidAt) >= a && new Date(p.paidAt) < b)
            .reduce((x, p) => x + num(p.amount), 0), 0);
        const collectedToday = sumPaidBetween(todayPay, todayStart, todayEnd);
        const collectedYesterday = sumPaidBetween(yestPay, yStart, yEnd);

        const money = { billed: 0, collected: 0, pending: 0, overdue: 0 };
        const nowTs = new Date();
        monthInvoices.forEach((i) => {
            if (i.status === 'cancelled') return;
            const due = Math.max(0, num(i.netAmount) - num(i.paidAmount));
            money.billed += num(i.netAmount);
            money.collected += num(i.paidAmount);
            if (due > 0) { if (i.dueDate && new Date(i.dueDate) < nowTs) money.overdue += due; else money.pending += due; }
        });
        money.pct = pct(money.collected, money.billed);

        // ── Fuel, six months ─────────────────────────────────────────────────
        const fuelBuckets = new Map();
        fuelRows.forEach((f) => {
            const d = new Date(f.date);
            const k = `${d.getFullYear()}-${d.getMonth()}`;
            const cur = fuelBuckets.get(k) || { litres: 0, cost: 0 };
            cur.litres += num(f.litres); cur.cost += num(f.totalCost);
            fuelBuckets.set(k, cur);
        });
        const fuelTrend = [];
        for (let i = 5; i >= 0; i--) {
            const d = monthStart(i);
            const b = fuelBuckets.get(`${d.getFullYear()}-${d.getMonth()}`) || { litres: 0, cost: 0 };
            fuelTrend.push({ label: MONTHS[d.getMonth()], litres: Math.round(b.litres), cost: Math.round(b.cost) });
        }

        // ── Upcoming items ───────────────────────────────────────────────────
        const soon = addDays(new Date(), st.documentReminderDays);
        const in7 = addDays(new Date(), 7);
        const [maintDue, pendingRequests, openIncidents, openComplaints, vehDocs, staffDocs, recent] = await Promise.all([
            MaintenanceRecord.countDocuments({ school, status: { $in: ['scheduled', 'in_progress'] }, scheduledDate: { $ne: null, $lte: in7 } }),
            TransportRequest.countDocuments({ school, status: 'pending' }),
            TransportIncident.countDocuments({ school, status: { $in: ['reported', 'investigating'] } }),
            TransportComplaint.countDocuments({ school, status: { $in: ['open', 'assigned', 'in_progress'] } }),
            Vehicle.find({
                school, isActive: true,
                $or: ['insuranceExpiry', 'fitnessExpiry', 'permitExpiry', 'roadTaxExpiry', 'pollutionExpiry']
                    .map((f) => ({ [f]: { $ne: null, $lte: soon } })),
            }).select('vehicleNumber insuranceExpiry fitnessExpiry permitExpiry roadTaxExpiry pollutionExpiry').lean(),
            TransportStaff.find({
                school, isActive: true,
                $or: [{ licenseExpiry: { $ne: null, $lte: soon } }, { medicalCertExpiry: { $ne: null, $lte: soon } }],
            }).select('name licenseExpiry medicalCertExpiry').lean(),
            TransportAuditLog.find({ school }).sort('-createdAt').limit(10).populate('user', 'name').lean(),
        ]);
        const renewals = [];
        vehDocs.forEach((v) => [['Insurance', 'insuranceExpiry'], ['Fitness', 'fitnessExpiry'], ['Permit', 'permitExpiry'],
            ['Road tax', 'roadTaxExpiry'], ['Pollution', 'pollutionExpiry']].forEach(([label, f]) => {
            if (v[f] && new Date(v[f]) <= soon) renewals.push({ kind: 'vehicle', name: v.vehicleNumber, doc: label, date: v[f] });
        }));
        staffDocs.forEach((s) => {
            if (s.licenseExpiry && new Date(s.licenseExpiry) <= soon) renewals.push({ kind: 'crew', name: s.name, doc: 'Licence', date: s.licenseExpiry });
            if (s.medicalCertExpiry && new Date(s.medicalCertExpiry) <= soon) renewals.push({ kind: 'crew', name: s.name, doc: 'Medical', date: s.medicalCertExpiry });
        });
        renewals.sort((a, b) => new Date(a.date) - new Date(b.date));

        // ── Alerts. Built from what actually happened, newest first — nothing
        //    here is a placeholder row.
        const alerts = [];
        scoped.filter((t) => (t.delayMinutes || 0) > st.delayThresholdMin).slice(0, 4).forEach((t) => {
            const r = routeById.get(String(t.route));
            const v = vehicles.find((x) => String(x._id) === String(t.vehicle));
            alerts.push({
                tone: 'warn', icon: 'delay',
                title: `${v?.vehicleNumber || 'Vehicle'} delayed by ${t.delayMinutes} mins`,
                detail: `${r ? `Route ${r.tag}` : 'Route'}${t.shift ? ` · ${t.shift === 'morning' ? 'Morning' : 'Afternoon'}` : ''}`,
                at: t.updatedAt || new Date(), link: '/admin/transport/trips',
            });
        });
        const dueSoonJobs = await MaintenanceRecord.find({ school, status: { $in: ['scheduled', 'in_progress'] }, scheduledDate: { $ne: null, $lte: in7 } })
            .sort('scheduledDate').limit(3).populate('vehicle', 'vehicleNumber').lean();
        dueSoonJobs.forEach((m) => alerts.push({
            tone: 'info', icon: 'wrench',
            title: `${m.vehicle?.vehicleNumber || 'Vehicle'} scheduled maintenance`,
            detail: m.title || 'Service due', at: m.scheduledDate, link: '/admin/transport/maintenance',
        }));
        const newReqs = await TransportRequest.find({ school, status: 'pending' }).sort('-createdAt').limit(3).lean();
        if (newReqs.length) alerts.push({
            tone: 'blue', icon: 'request',
            title: `New transport request${newReqs.length > 1 ? `s (${newReqs.length} students)` : ''}`,
            detail: newReqs[0].requestCode || 'Awaiting approval', at: newReqs[0].createdAt, link: '/admin/transport/requests',
        });
        const newComplaints = await TransportComplaint.find({ school, status: { $in: ['open', 'assigned'] } })
            .sort('-createdAt').limit(3).populate('route', 'name routeCode').lean();
        newComplaints.forEach((c) => alerts.push({
            tone: 'bad', icon: 'megaphone', title: 'Complaint registered',
            detail: c.route ? `Regarding ${c.route.name}` : (c.subject || ''), at: c.createdAt, link: '/admin/transport/complaints',
        }));
        alerts.sort((a, b) => new Date(b.at) - new Date(a.at));

        // ── Live vehicles for the dashboard's small map ───────────────────────
        const liveMarkers = trips.filter((t) => ['started', 'paused'].includes(t.status) && t.lastLocation?.latitude != null)
            .map((t) => {
                const r = routeById.get(String(t.route));
                const v = vehicles.find((x) => String(x._id) === String(t.vehicle));
                return {
                    vehicle: v?.vehicleNumber || '', route: r?.tag || '', color: r?.color || '#3b82f6',
                    latitude: t.lastLocation.latitude, longitude: t.lastLocation.longitude,
                    state: (t.delayMinutes || 0) > st.delayThresholdMin ? 'delayed' : (t.lastLocation.speed ? 'on_route' : 'at_stop'),
                };
            });

        ok(res, {
            date: new Date(),
            routes: routes.map((r) => ({ _id: r._id, name: r.name, tag: r.tag, color: r.color })),
            tiles: {
                fleet,
                crew: crewTile,
                students: {
                    value: boardedToday || assigned,
                    basis: boardedToday ? 'boarded' : 'assigned',
                    delta: boardedToday ? delta(boardedToday, boardedYesterday) : null,
                    assigned,
                },
                routesTile: { total: activeRoutes.length, ...shifts },
                collectedToday: { value: Math.round(collectedToday), delta: delta(collectedToday, collectedYesterday) },
            },
            trips: tripTile,
            money,
            fuelTrend,
            alerts: alerts.slice(0, 6),
            upcoming: {
                maintenanceDue: maintDue, renewals: renewals.length,
                requests: pendingRequests, incidents: openIncidents, complaints: openComplaints,
            },
            renewals: renewals.slice(0, 6),
            map: mapConfig(st),
            live: {
                onRoute: liveMarkers.length,
                markers: liveMarkers,
                school: { name: schoolDoc?.name || 'School', latitude: st.schoolLatitude ?? null, longitude: st.schoolLongitude ?? null },
            },
            activity: recent.map((a) => ({
                at: a.createdAt, action: a.actionType, entity: a.entityType,
                description: a.description, by: a.user?.name || 'System',
                tone: /cancel|delete|reject|fail/i.test(a.actionType) ? 'bad'
                    : /delay|pause|suspend/i.test(a.actionType) ? 'warn'
                    : /complete|approve|pay|create/i.test(a.actionType) ? 'good' : 'info',
            })),
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  LIVE MAP  ·  GET /transport/admin/live-board
// ═════════════════════════════════════════════════════════════════════════════
/**
 * What a vehicle is doing right now.
 *
 * The old live endpoint only knew about vehicles that were on a running trip,
 * so a bus sitting in the yard and a bus whose tracker had died looked the
 * same — both simply absent from the map. Five states are separated here:
 *   maintenance — the workshop has it
 *   delayed     — running, but past the school's delay threshold
 *   at_stop     — running, standing still at a stop it has reached
 *   on_route    — running and moving
 *   idle        — no trip, but the tracker reported within the stale window
 *   offline     — no trip and no ping
 */
function vehicleState(vehicle, trip, lastPing, st, staleMs) {
    if (vehicle.status === 'maintenance') return 'maintenance';
    if (trip && ['started', 'paused'].includes(trip.status)) {
        if ((trip.delayMinutes || 0) > st.delayThresholdMin) return 'delayed';
        const speed = trip.lastLocation?.speed ?? lastPing?.speed ?? 0;
        return speed > 2 ? 'on_route' : 'at_stop';
    }
    if (lastPing && Date.now() - new Date(lastPing.recordedAt).getTime() < staleMs) return 'idle';
    return 'offline';
}

exports.liveBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const { start, end } = dayRange();
        // A tracker is "stale" after four reporting intervals, floored at two
        // minutes — so a 30s interval does not flap a bus to Offline on one
        // dropped packet, and a 10-minute interval is not called live for an hour.
        const staleMs = Math.max(120, (st.trackingIntervalSec || 30) * 4) * 1000;

        const [vehicles, routesRaw, trips, pings, schoolDoc] = await Promise.all([
            Vehicle.find({ school, isActive: true }).select('vehicleNumber registrationNumber vehicleType status capacity photo gpsDeviceId').sort('vehicleNumber').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode shift status color zone stops distanceKm geofenceRadiusM driver vehicle').lean(),
            TransportTrip.find({ school, date: { $gte: start, $lt: end } })
                .select('tripCode route vehicle driver status shift direction delayMinutes lastLocation stopEvents studentAttendance startTime endTime').lean(),
            VehicleLocation.find({ school, recordedAt: { $gte: daysAgo(1) } }).sort('-recordedAt')
                .select('vehicle latitude longitude speed heading recordedAt').limit(4000).lean(),
            School.findById(school).select('name').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));

        // Newest ping per vehicle (the list is already newest-first).
        const lastPing = new Map();
        pings.forEach((p) => { const k = String(p.vehicle); if (!lastPing.has(k)) lastPing.set(k, p); });

        // The trip a vehicle is on now, else its most recent one today.
        const tripByVehicle = new Map();
        trips.forEach((t) => {
            const k = String(t.vehicle);
            const cur = tripByVehicle.get(k);
            const running = ['started', 'paused'].includes(t.status);
            if (!cur || (running && !['started', 'paused'].includes(cur.status))) tripByVehicle.set(k, t);
        });
        const driverIds = [...new Set(trips.map((t) => t.driver).concat(routes.map((r) => r.driver)).filter(Boolean).map(String))];
        const drivers = driverIds.length
            ? await TransportStaff.find({ _id: { $in: driverIds } }).select('name phone photo staffType user lastLocation locationSharing').lean() : [];
        const driverById = new Map(drivers.map((d) => [String(d._id), d]));

        // Crew who are sharing a position from their own device. A person and
        // their bus are different answers — a driver who has stepped off, a
        // conductor walking a child to the door — so they are plotted apart.
        const crewRows = await TransportStaff.find({ school, isActive: true, locationSharing: true })
            .select('name photo staffType user lastLocation').lean();
        const crewEmployees = await employeeIndex(crewRows.map((c) => c.user));
        const crew = crewRows
            .filter((c) => c.lastLocation?.latitude != null)
            .map((c) => {
                const emp = crewEmployees.get(String(c.user));
                const at = c.lastLocation.at ? new Date(c.lastLocation.at) : null;
                return {
                    _id: c._id, name: emp?.name || c.name, photo: emp?.photo || c.photo,
                    roleLabel: staffRole(c), staffType: c.staffType,
                    latitude: c.lastLocation.latitude, longitude: c.lastLocation.longitude,
                    accuracy: c.lastLocation.accuracy, speed: c.lastLocation.speed || 0,
                    at, stale: !at || (Date.now() - at.getTime()) > staleMs,
                };
            });

        const rows = vehicles.map((v) => {
            const trip = tripByVehicle.get(String(v._id));
            const ping = lastPing.get(String(v._id));
            const route = trip ? routeById.get(String(trip.route)) : routes.find((r) => String(r.vehicle) === String(v._id));
            const driver = driverById.get(String(trip?.driver || route?.driver || ''));
            const state = vehicleState(v, trip, ping, st, staleMs);
            const loc = trip?.lastLocation?.latitude != null ? trip.lastLocation : ping;
            return {
                _id: v._id, vehicleNumber: v.vehicleNumber, registrationNumber: v.registrationNumber,
                vehicleType: v.vehicleType, photo: v.photo || '', capacity: v.capacity || 0,
                hasTracker: !!v.gpsDeviceId,
                route: route ? { _id: route._id, name: route.name, tag: route.tag, color: route.color, zone: route.zone } : null,
                driver: driver ? { _id: driver._id, name: driver.name, phone: driver.phone, photo: driver.photo } : null,
                state,
                speed: Math.round(num(trip?.lastLocation?.speed ?? ping?.speed)),
                heading: Math.round(num(ping?.heading)),
                delayMinutes: trip?.delayMinutes || 0,
                latitude: loc?.latitude ?? null,
                longitude: loc?.longitude ?? null,
                lastSeen: ping?.recordedAt || trip?.lastLocation?.updatedAt || null,
                trip: trip ? {
                    _id: trip._id, tripCode: trip.tripCode, status: trip.status, shift: trip.shift, direction: trip.direction,
                    onBoard: (trip.studentAttendance || []).filter((s) => s.status === 'boarded').length,
                    total: (trip.studentAttendance || []).length,
                    stopsReached: (trip.stopEvents || []).filter((s) => s.status === 'reached').length,
                    stopsTotal: (trip.stopEvents || []).length,
                } : null,
            };
        });

        const counts = rows.reduce((a, r) => { a[r.state] = (a[r.state] || 0) + 1; return a; }, {});
        const running = trips.filter((t) => ['started', 'paused'].includes(t.status));
        const onBoard = running.reduce((s, t) => s + (t.studentAttendance || []).filter((x) => x.status === 'boarded').length, 0);
        const assignedTotal = await TransportAssignment.countDocuments({ school, status: 'active' });

        // ── Stop board for one vehicle (the rail's "Route Stops" panel) ───────
        const focusId = req.query.vehicle && req.query.vehicle !== 'all' ? String(req.query.vehicle) : String(rows.find((r) => r.trip)?._id || rows[0]?._id || '');
        const focusRow = rows.find((r) => String(r._id) === focusId) || rows[0] || null;
        let stopBoard = null;
        if (focusRow) {
            const trip = tripByVehicle.get(String(focusRow._id));
            const route = focusRow.route ? routeById.get(String(focusRow.route._id)) : null;
            const events = trip?.stopEvents?.length
                ? [...trip.stopEvents].sort((a, b) => a.sequence - b.sequence)
                : [...(route?.stops || [])].sort((a, b) => a.sequence - b.sequence)
                    .map((s) => ({ name: s.name, sequence: s.sequence, plannedTime: s.arrivalTime, status: 'pending' }));
            stopBoard = {
                vehicle: focusRow.vehicleNumber,
                route: focusRow.route,
                stops: events.map((e) => ({
                    name: e.name, sequence: e.sequence, status: e.status,
                    plannedTime: e.plannedTime || '', reachedAt: e.reachedAt || null,
                })),
            };
        }

        // ── Geofence & deviation alerts ──────────────────────────────────────
        // A running bus more than deviationAlertM from EVERY stop on its route
        // has left its corridor. With no stop coordinates saved there is nothing
        // to measure against, and the panel says so rather than inventing calm.
        const alerts = [];
        let measurable = 0;
        running.forEach((t) => {
            const route = routeById.get(String(t.route));
            const pos = t.lastLocation?.latitude != null ? t.lastLocation : lastPing.get(String(t.vehicle));
            const stops = (route?.stops || []).filter((s) => s.latitude != null && s.longitude != null);
            if (!pos || pos.latitude == null || !stops.length) return;
            measurable++;
            const nearest = stops.reduce((best, s) => {
                const d = metresBetween(pos, s);
                return d != null && (best == null || d < best.d) ? { d, stop: s } : best;
            }, null);
            if (nearest && nearest.d > (route.geofenceRadiusM || st.deviationAlertM)) {
                const v = vehicles.find((x) => String(x._id) === String(t.vehicle));
                alerts.push({
                    tone: 'bad', vehicle: v?.vehicleNumber || '', route: route.tag,
                    title: `${v?.vehicleNumber || 'Vehicle'} is off its route`,
                    detail: `${(nearest.d / 1000).toFixed(1)} km from ${nearest.stop.name}`,
                    at: pos.updatedAt || pos.recordedAt || new Date(),
                });
            }
        });

        // ── Upcoming stops in the next 15 minutes ────────────────────────────
        const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
        const upcomingStops = [];
        running.forEach((t) => {
            const route = routeById.get(String(t.route));
            const v = vehicles.find((x) => String(x._id) === String(t.vehicle));
            (t.stopEvents || []).filter((e) => e.status === 'pending').forEach((e) => {
                const m = hhmmToMin(e.plannedTime);
                if (m == null) return;
                const inMin = m - nowMin;
                if (inMin >= 0 && inMin <= 15) upcomingStops.push({
                    vehicle: v?.vehicleNumber || '', route: route?.tag || '', color: route?.color || '#3b82f6',
                    stop: e.name, inMinutes: inMin, plannedTime: e.plannedTime,
                });
            });
        });
        upcomingStops.sort((a, b) => a.inMinutes - b.inMinutes);

        // ── Recent activity on the road (not the audit log) ──────────────────
        const activity = [];
        trips.forEach((t) => {
            const route = routeById.get(String(t.route));
            const v = vehicles.find((x) => String(x._id) === String(t.vehicle));
            const name = v?.vehicleNumber || 'Vehicle';
            if (t.startTime) activity.push({ at: t.startTime, tone: 'good', text: `${name} started trip`, tag: 'On time' });
            if (t.endTime) activity.push({ at: t.endTime, tone: 'good', text: `${name} completed trip`, tag: 'On time' });
            if ((t.delayMinutes || 0) > st.delayThresholdMin) activity.push({
                at: t.lastLocation?.updatedAt || t.startTime || new Date(), tone: 'bad',
                text: `${name} delayed by ${t.delayMinutes} mins`, tag: 'Delay',
            });
            (t.stopEvents || []).filter((e) => e.status === 'reached' && e.reachedAt).slice(-3).forEach((e) => activity.push({
                at: e.reachedAt, tone: 'good', text: `${name} reached ${e.name}`, tag: route ? route.tag : '',
            }));
        });
        activity.sort((a, b) => new Date(b.at) - new Date(a.at));

        ok(res, {
            pollSeconds: st.trackingIntervalSec || 30,
            tiles: {
                fleet: {
                    total: vehicles.length,
                    running: (counts.on_route || 0) + (counts.at_stop || 0) + (counts.delayed || 0),
                    idle: counts.idle || 0, offline: counts.offline || 0, maintenance: counts.maintenance || 0,
                },
                onBoard: { value: onBoard, assigned: assignedTotal, pct: pct(onBoard, assignedTotal) },
                routes: {
                    total: routes.filter((r) => r.status === 'active').length,
                    morning: routes.filter((r) => r.shift === 'morning').length,
                    afternoon: routes.filter((r) => r.shift === 'evening').length,
                    both: routes.filter((r) => r.shift === 'both').length,
                },
                trips: {
                    ongoing: running.length, total: trips.length,
                    pct: pct(trips.filter((t) => t.status === 'completed').length + running.length, trips.length),
                },
                incidents: await TransportIncident.countDocuments({ school, status: { $in: ['reported', 'investigating'] }, date: { $gte: start } }),
            },
            school: { name: schoolDoc?.name || 'School', latitude: st.schoolLatitude ?? null, longitude: st.schoolLongitude ?? null },
            map: mapConfig(st),
            vehicles: rows,
            routes: routes.map((r) => ({
                _id: r._id, name: r.name, tag: r.tag, color: r.color, zone: r.zone, shift: r.shift,
                stops: (r.stops || []).map((s) => ({ _id: s._id, name: s.name, sequence: s.sequence, latitude: s.latitude, longitude: s.longitude })),
            })),
            focusVehicle: focusRow?._id || null,
            crew,
            crewSharing: crewRows.length,
            stopBoard,
            geofence: { alerts, measurable, running: running.length },
            upcomingStops: upcomingStops.slice(0, 8),
            activity: activity.slice(0, 8),
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  VEHICLES  ·  GET /transport/admin/vehicle-board
// ═════════════════════════════════════════════════════════════════════════════
exports.vehicleBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', status = '', route = '', type = '', fuelType = '', page = 1, limit = 8 } = req.query;
        const { start, end } = dayRange();
        const m0 = monthStart();

        const [all, routesRaw, todaysTrips, fuelMonth, fuelPrev, occupancy] = await Promise.all([
            Vehicle.find({ school, isActive: true }).sort('vehicleNumber').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode shift zone color vehicle driver status').lean(),
            TransportTrip.find({ school, date: { $gte: start, $lt: end } })
                .select('vehicle status startTime endTime delayMinutes route shift stopEvents').lean(),
            FuelLog.find({ school, date: { $gte: m0 } }).select('litres totalCost vehicle').lean(),
            FuelLog.find({ school, date: { $gte: monthStart(1), $lt: m0 } }).select('litres').lean(),
            occupancyByVehicle(school),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeByVehicle = new Map();
        routes.forEach((r) => { if (r.vehicle) routeByVehicle.set(String(r.vehicle), r); });

        const driverIds = [...new Set(routes.map((r) => r.driver).filter(Boolean).map(String))];
        const drivers = driverIds.length
            ? await TransportStaff.find({ _id: { $in: driverIds } }).select('name phone photo staffType status').lean() : [];
        const driverById = new Map(drivers.map((d) => [String(d._id), d]));

        // Last trip today per vehicle, with the word the table prints for it.
        const lastTrip = new Map();
        todaysTrips.forEach((t) => {
            const k = String(t.vehicle);
            const cur = lastTrip.get(k);
            const at = t.endTime || t.startTime || t.createdAt;
            if (!cur || new Date(at) > new Date(cur.at)) lastTrip.set(k, { at, status: t.status, delay: t.delayMinutes || 0 });
        });

        const litresMonth = fuelMonth.reduce((s, f) => s + num(f.litres), 0);
        const litresPrev = fuelPrev.reduce((s, f) => s + num(f.litres), 0);

        const tiles = {
            total: all.length,
            active: all.filter((v) => v.status === 'active').length,
            maintenance: all.filter((v) => v.status === 'maintenance').length,
            inactive: all.filter((v) => !['active', 'maintenance'].includes(v.status)).length,
            fuel: { litres: Math.round(litresMonth), delta: delta(litresMonth, litresPrev) },
        };

        // ── Filter ───────────────────────────────────────────────────────────
        const needle = String(search).trim().toLowerCase();
        let rows = all.filter((v) => {
            if (status && v.status !== status) return false;
            if (type && v.vehicleType !== type) return false;
            if (fuelType && v.fuelType !== fuelType) return false;
            if (route) {
                const r = routeByVehicle.get(String(v._id));
                if (!r || String(r._id) !== String(route)) return false;
            }
            if (needle) {
                const r = routeByVehicle.get(String(v._id));
                const d = driverById.get(String(r?.driver || ''));
                const hay = [v.vehicleNumber, v.registrationNumber, v.busName, v.manufacturer, r?.name, d?.name].join(' ').toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        });
        const total = rows.length;
        const p = Math.max(1, +page), lim = Math.max(1, +limit);
        rows = rows.slice((p - 1) * lim, p * lim);

        const decorate = (v) => {
            const r = routeByVehicle.get(String(v._id));
            const d = driverById.get(String(r?.driver || ''));
            const lt = lastTrip.get(String(v._id));
            return {
                ...v,
                occupancy: occupancy.get(String(v._id)) || 0,
                route: r ? { _id: r._id, name: r.name, tag: r.tag, color: r.color, zone: r.zone } : null,
                driver: d ? { _id: d._id, name: d.name, phone: d.phone, photo: d.photo, status: d.status } : null,
                lastTrip: lt ? { at: lt.at, status: lt.status, delay: lt.delay } : null,
                compliance: complianceFor(v),
            };
        };

        ok(res, {
            tiles,
            data: rows.map(decorate),
            total, page: p, pages: Math.max(1, Math.ceil(total / lim)),
            filters: {
                routes: routes.map((r) => ({ value: r._id, label: `${r.tag} — ${r.name}` })),
                types: [...new Set(all.map((v) => v.vehicleType).filter(Boolean))],
                fuelTypes: [...new Set(all.map((v) => v.fuelType).filter(Boolean))],
            },
        });
    } catch (e) { fail(res, e); }
};

/** Document expiry roll-up for a vehicle, newest deadline first. */
function complianceFor(v, withinDays = 30) {
    const soon = addDays(new Date(), withinDays);
    const now = new Date();
    const docs = [['Insurance', v.insuranceExpiry], ['Fitness', v.fitnessExpiry], ['Permit', v.permitExpiry],
                  ['Road Tax', v.roadTaxExpiry], ['Pollution (PUC)', v.pollutionExpiry]]
        .filter(([, d]) => d)
        .map(([label, d]) => ({
            label, date: d,
            state: new Date(d) < now ? 'expired' : new Date(d) <= soon ? 'due' : 'ok',
            days: Math.ceil((new Date(d) - now) / 864e5),
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    return {
        docs,
        expired: docs.filter((d) => d.state === 'expired').length,
        due: docs.filter((d) => d.state === 'due').length,
        state: docs.some((d) => d.state === 'expired') ? 'expired' : docs.some((d) => d.state === 'due') ? 'due' : 'ok',
    };
}

/** The rail's five tabs for one vehicle — Overview, Driver, Route, Maintenance, Documents. */
exports.vehicleDetail = async (req, res) => {
    try {
        const school = req.schoolId;
        const v = await Vehicle.findOne({ _id: req.params.id, school }).lean();
        if (!v) return bad(res, 'Vehicle not found', 404);
        const [routesRaw, fuel, maintenance, incidents, trips, occupancy] = await Promise.all([
            TransportRoute.find({ school, isActive: true, vehicle: v._id }).select('name routeCode shift zone color stops distanceKm estimatedDurationMin driver attendant schedule').lean(),
            FuelLog.find({ school, vehicle: v._id }).sort('-date').limit(6).lean(),
            MaintenanceRecord.find({ school, vehicle: v._id }).sort('-createdAt').limit(8).lean(),
            TransportIncident.find({ school, vehicle: v._id }).sort('-date').limit(5).select('incidentCode type severity status date description').lean(),
            TransportTrip.find({ school, vehicle: v._id }).sort('-date').limit(6).select('tripCode date shift status delayMinutes studentAttendance').lean(),
            occupancyByVehicle(school),
        ]);
        const routes = tagRoutes(routesRaw);
        const crewIds = [...new Set(routes.flatMap((r) => [r.driver, r.attendant]).filter(Boolean).map(String))];
        const crew = crewIds.length ? await TransportStaff.find({ _id: { $in: crewIds } }).lean({ virtuals: true }) : [];

        ok(res, {
            ...v,
            occupancy: occupancy.get(String(v._id)) || 0,
            compliance: complianceFor(v),
            routes,
            crew: crew.map((c) => ({ ...c, roleLabel: staffRole(c) })),
            fuel, maintenance, incidents,
            trips: trips.map((t) => ({
                _id: t._id, tripCode: t.tripCode, date: t.date, shift: t.shift, status: t.status, delayMinutes: t.delayMinutes,
                boarded: (t.studentAttendance || []).filter((s) => ['boarded', 'dropped'].includes(s.status)).length,
                total: (t.studentAttendance || []).length,
            })),
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  DRIVERS, CONDUCTORS & CREW  ·  GET /transport/admin/staff-board
// ═════════════════════════════════════════════════════════════════════════════
/**
 * The five documents the crew rail lists, in its order.
 *
 * Two of them (licence, medical) have their own dated columns because renewal
 * dashboards filter on them; the other three live in documents[]. Aadhaar is
 * taken from the employee record when there is one — the school already holds
 * it there and asking for it twice is how two numbers end up disagreeing.
 */
function staffDocuments(s, reminderDays = 30, employee = null) {
    const now = new Date();
    const soon = addDays(now, reminderDays);
    const byType = new Map((s.documents || []).map((d) => [d.docType, d]));
    const row = (label, docType, expiry, verifiedFlag) => {
        const d = byType.get(docType);
        const exp = expiry || d?.expiryDate || null;
        let state = 'missing';
        if (exp) state = new Date(exp) < now ? 'expired' : new Date(exp) <= soon ? 'due' : 'ok';
        else if (verifiedFlag) state = 'verified';
        else if (d?.file || d?.number) state = 'verified';
        return { label, docType, number: d?.number || '', expiry: exp, state };
    };
    return [
        row('Driving License', 'license', s.licenseExpiry || null),
        row('Medical Certificate', 'medical', s.medicalCertExpiry || null),
        row('Police Verification', 'police_verification', null, s.policeVerification?.status === 'verified'),
        row('Aadhaar Card', 'aadhaar', null, !!employee?.aadhaarNumber),
        row('Address Proof', 'address_proof', null, !!employee?.address),
    ];
}
/** Is this crew member on an approved leave that covers `on`? */
function leaveOn(s, on = new Date()) {
    return (s.leaves || []).find((l) => l.status === 'approved'
        && new Date(l.fromDate) <= on && new Date(l.toDate) >= new Date(on.getFullYear(), on.getMonth(), on.getDate())) || null;
}

/**
 * Identity for a set of employee User ids: the User row plus its TeacherProfile.
 *
 * This is where a crew member's name, phone, photo, employee id, designation and
 * emergency contact come from now. TransportStaff keeps its own copies only for
 * the standalone rows created before crew were linked to employees.
 */
async function employeeIndex(userIds = []) {
    const uniq = [...new Set(userIds.map(String).filter(Boolean))];
    if (!uniq.length) return new Map();
    const [users, profiles] = await Promise.all([
        User.find({ _id: { $in: uniq } }).select('name email phone profileImage role isActive').lean(),
        TeacherProfile.find({ user: { $in: uniq } })
            .select('user employeeId designation department staffType gender dob joiningDate bloodGroup '
                  + 'alternatePhone currentAddress currentCity emergencyContactName emergencyContactPhone aadhaarNumber')
            .lean(),
    ]);
    const byUser = new Map(profiles.map((p) => [String(p.user), p]));
    return new Map(users.map((u) => {
        const p = byUser.get(String(u._id)) || {};
        return [String(u._id), {
            _id: u._id, name: u.name || '', email: u.email || '', phone: u.phone || p.alternatePhone || '',
            photo: u.profileImage || '', isActive: u.isActive !== false,
            employeeId: p.employeeId || '', designation: p.designation || '', department: p.department || '',
            staffType: p.staffType || '', gender: p.gender || '', dateOfBirth: p.dob || null,
            dateOfJoining: p.joiningDate || null, bloodGroup: p.bloodGroup || '',
            address: [p.currentAddress, p.currentCity].filter(Boolean).join(', '),
            emergencyContact: { name: p.emergencyContactName || '', phone: p.emergencyContactPhone || '', relation: '' },
            aadhaarNumber: p.aadhaarNumber || '',
        }];
    }));
}

/** The crew words the screens use; 'attendant' is the old name for a helper. */
const ROLE_OF = (v) => (v === 'helper' ? 'helper' : v);

exports.staffBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const { search = '', role = '', status = '', route = '', page = 1, limit = 8 } = req.query;
        const [all, routesRaw] = await Promise.all([
            TransportStaff.find({ school, isActive: true }).sort('name').lean({ virtuals: true }),
            TransportRoute.find({ school, isActive: true }).select('name routeCode zone color driver backupDriver attendant').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const employees = await employeeIndex(all.map((s) => s.user));

        // Every route a crew member appears on, in any seat.
        const routesByStaff = new Map();
        routes.forEach((r) => [r.driver, r.backupDriver, r.attendant].filter(Boolean).forEach((id) => {
            const k = String(id);
            if (!routesByStaff.has(k)) routesByStaff.set(k, []);
            routesByStaff.get(k).push({ _id: r._id, name: r.name, tag: r.tag, color: r.color, zone: r.zone });
        }));

        const today = new Date();
        // A position older than four reporting intervals (floored at 2 min) is
        // stale — the same test the vehicle map uses, so the two agree.
        const staleMs = Math.max(120, (st.trackingIntervalSec || 30) * 4) * 1000;
        const decorate = (s) => {
            const emp = employees.get(String(s.user)) || null;
            const docs = staffDocuments(s, st.licenceReminderDays, emp);
            const leave = leaveOn(s, today);
            const expiring = docs.filter((d) => d.state === 'due' || d.state === 'expired');
            const loc = s.lastLocation?.latitude != null ? s.lastLocation : null;
            return {
                ...s,
                // Identity comes from the employee record when there is one.
                name: emp?.name || s.name,
                phone: emp?.phone || s.phone,
                photo: emp?.photo || s.photo,
                employeeId: emp?.employeeId || s.employeeId,
                address: emp?.address || s.address,
                emergencyContact: emp?.emergencyContact?.name ? emp.emergencyContact : s.emergencyContact,
                dateOfBirth: emp?.dateOfBirth || s.dateOfBirth,
                dateOfJoining: emp?.dateOfJoining || s.dateOfJoining,
                employee: emp,
                linked: !!emp,
                designation: emp?.designation || '',
                department: emp?.department || '',
                roleLabel: staffRole(s),
                routes: routesByStaff.get(String(s._id)) || [],
                documents: docs,
                expiringDocuments: expiring.length,
                onLeave: !!leave,
                leave,
                location: loc ? {
                    ...loc,
                    stale: !loc.at || (Date.now() - new Date(loc.at).getTime()) > staleMs,
                } : null,
                // The word the Status column prints. A document about to lapse
                // outranks "Active": it is the thing the school must act on.
                displayStatus: leave || s.status === 'on_leave' ? 'on_leave'
                    : s.status !== 'active' ? 'inactive'
                    : expiring.length ? 'document_expiring' : 'active',
            };
        };
        const decorated = all.map(decorate);

        const isDriver = (s) => s.staffType === 'driver';
        const isConductor = (s) => s.staffType === 'conductor';
        const isHelper = (s) => ['helper', 'attendant'].includes(s.staffType);
        const inRole = (s) => (!role ? true : role === 'helper' ? isHelper(s) : s.staffType === role);

        // Tiles count the role being looked at when a role is picked, and the
        // whole crew on the combined screen.
        const scope = decorated.filter(inRole);
        const onLeave = scope.filter((s) => s.displayStatus === 'on_leave');
        const tiles = {
            total: scope.length,
            drivers: decorated.filter(isDriver).length,
            conductors: decorated.filter(isConductor).length,
            helpers: decorated.filter(isHelper).length,
            active: scope.filter((s) => s.status === 'active' && s.displayStatus !== 'on_leave').length,
            onLeave: onLeave.length,
            onLeaveBreakdown: {
                drivers: onLeave.filter(isDriver).length,
                conductors: onLeave.filter(isConductor).length,
                helpers: onLeave.filter(isHelper).length,
            },
            expiringDocuments: scope.filter((s) => s.expiringDocuments > 0).length,
            onRoute: scope.filter((s) => s.routes.length).length,
            unassigned: scope.filter((s) => !s.routes.length).length,
            sharingLocation: scope.filter((s) => s.locationSharing).length,
            liveNow: scope.filter((s) => s.location && !s.location.stale).length,
            unlinked: scope.filter((s) => !s.linked).length,
            newRequests: await TransportRequest.countDocuments({ school, status: 'pending', requestType: 'special_trip' }),
        };

        const needle = String(search).trim().toLowerCase();
        let rows = scope.filter((s) => {
            if (status && s.displayStatus !== status) return false;
            if (route && !s.routes.some((r) => String(r._id) === String(route))) return false;
            if (needle) {
                const hay = [s.name, s.employeeId, s.phone, s.licenseNumber, s.designation].join(' ').toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        });
        const total = rows.length;
        const p = Math.max(1, +page), lim = Math.max(1, +limit);
        rows = rows.slice((p - 1) * lim, p * lim);

        // ── The three panels under the table ─────────────────────────────────
        const in30 = addDays(today, 30);
        const upcomingLeave = scope.flatMap((s) => (s.leaves || [])
            .filter((l) => l.status !== 'cancelled' && new Date(l.toDate) >= today && new Date(l.fromDate) <= in30)
            .map((l) => ({ staff: s.name, staffId: s._id, role: s.roleLabel, photo: s.photo, ...l })))
            .sort((a, b) => new Date(a.fromDate) - new Date(b.fromDate)).slice(0, 6);
        const birthdays = scope.filter((s) => s.dateOfBirth && new Date(s.dateOfBirth).getMonth() === today.getMonth())
            .map((s) => ({ _id: s._id, name: s.name, role: s.roleLabel, photo: s.photo, date: s.dateOfBirth, day: new Date(s.dateOfBirth).getDate() }))
            .sort((a, b) => a.day - b.day);
        const joinees = scope.filter((s) => s.dateOfJoining && new Date(s.dateOfJoining) >= monthStart())
            .map((s) => ({ _id: s._id, name: s.name, role: s.roleLabel, photo: s.photo, date: s.dateOfJoining }))
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        ok(res, {
            role: role || 'all',
            tiles, data: rows, total, page: p, pages: Math.max(1, Math.ceil(total / lim)),
            filters: { routes: routes.map((r) => ({ value: r._id, label: `${r.tag} — ${r.name}` })) },
            upcomingLeave, birthdays, joinees,
            school: { name: '', latitude: st.schoolLatitude ?? null, longitude: st.schoolLongitude ?? null },
            map: mapConfig(st),
            trackingIntervalSec: st.trackingIntervalSec || 30,
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ASSIGNING AN EMPLOYEE A TRANSPORT ROLE
//
//  Transport never creates an account. A driver, a conductor and a crew member
//  are each an existing teacher/employee account with a transport role attached
//  to it — the person keeps the one account they sign in with, and Teachers stays
//  the only place an account is born. So the only two writes here are: give a
//  free account a role, and take one away.
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Employees who could be given a transport role · GET /transport/admin/staff/employees
 *
 * Drivers and conductors are members of staff, so they are created once in
 * Teachers/Employees and given a role here. Anyone who ALREADY crews — a driver,
 * a conductor or a crew member on a live record — is left out, because one person
 * holds one transport role: moving them is an edit of their crew record, not a
 * second assignment. Ending a role frees the account again, so it comes back.
 *
 * `includeAssigned=1` puts them back in, each carrying the role it holds, for a
 * caller that wants the whole register rather than who is free.
 */
exports.assignableEmployees = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', staffType = '', limit = 60, includeAssigned = '' } = req.query;
        const withHeld = includeAssigned === '1' || includeAssigned === 'true';
        const users = await User.find({ school, role: 'teacher', isActive: true })
            .select('name email phone profileImage').sort('name').lean();
        const ids = users.map((u) => u._id);
        const [profiles, held] = await Promise.all([
            ids.length ? TeacherProfile.find({ user: { $in: ids } })
                .select('user employeeId designation department staffType').lean() : [],
            TransportStaff.find({ school, isActive: true, user: { $ne: null } }).select('user staffType').lean(),
        ]);
        const byUser = new Map(profiles.map((p) => [String(p.user), p]));
        const heldBy = new Map(held.map((h) => [String(h.user), h.staffType]));

        const needle = String(search).trim().toLowerCase();
        const rows = users.map((u) => {
            const p = byUser.get(String(u._id)) || {};
            return {
                _id: u._id, name: u.name, email: u.email, phone: u.phone || '', photo: u.profileImage || '',
                employeeId: p.employeeId || '', designation: p.designation || '', department: p.department || '',
                staffType: p.staffType || '',
                transportRole: heldBy.get(String(u._id)) || null,
            };
        }).filter((r) => {
            // The whole point of the list: who is still free to be given a role.
            if (r.transportRole && !withHeld) return false;
            // Non-teaching staff first — a driver is one — but teaching staff are
            // not excluded: small schools really do have a teacher who drives.
            if (staffType && r.staffType !== staffType) return false;
            if (needle && ![r.name, r.employeeId, r.email, r.designation, r.department].join(' ').toLowerCase().includes(needle)) return false;
            return true;
        });
        rows.sort((a, b) => (a.transportRole ? 1 : 0) - (b.transportRole ? 1 : 0)
            || (b.staffType === 'non_teaching') - (a.staffType === 'non_teaching')
            || a.name.localeCompare(b.name));
        ok(res, { data: rows.slice(0, +limit), total: rows.length, assignedHidden: withHeld ? 0 : heldBy.size });
    } catch (e) { fail(res, e); }
};

/**
 * Give an employee a transport role · POST /transport/admin/staff/assign
 *
 * Creates the TransportStaff record, or re-points an existing one. The person's
 * name, phone and photo are NOT copied — they are read from the employee record
 * every time, so a change of phone number does not have to be made twice.
 */
exports.assignCrewRole = async (req, res) => {
    try {
        const school = req.schoolId;
        const {
            user, staffType, employeeId = '',
            // Driver-specific
            licenseNumber = '', licenseType = '', licenseExpiry = null, experienceYears = 0,
            // Contact — kept on the transport record because the number a parent
            // rings on the road is not always the one on the employee file.
            phone = '', address = '', emergencyContact = null,
            // Safety
            medicalCertExpiry = null, policeVerified = null,
            // What they crew
            vehicle = null, dateOfJoining = null,
            locationSharing = false, notes = '',
        } = req.body;
        if (!user) return bad(res, 'Pick the employee this role is for');
        if (!['driver', 'conductor', 'helper'].includes(staffType)) return bad(res, 'Pick a role: driver, conductor or helper');

        const u = await User.findOne({ _id: user, school, role: 'teacher' }).select('name').lean();
        if (!u) return bad(res, 'That employee is not on this school\'s staff', 404);
        if (staffType === 'driver' && !String(licenseNumber).trim()) {
            return bad(res, 'A driver needs a licence number');
        }

        // The vehicle this person crews, when the school names one here rather
        // than through the route.
        if (vehicle) {
            const veh = await Vehicle.findOne({ _id: vehicle, school }).select('vehicleNumber').lean();
            if (!veh) return bad(res, 'That vehicle is not on this school\'s fleet', 404);
        }
        const police = policeVerified === null || policeVerified === undefined ? null : {
            status: policeVerified ? 'verified' : 'pending',
            date: policeVerified ? new Date() : null,
            file: '',
        };

        const existing = await TransportStaff.findOne({ school, user, isActive: true });
        if (existing) {
            existing.staffType = staffType;
            if (licenseNumber) existing.licenseNumber = licenseNumber;
            if (licenseType) existing.licenseType = licenseType;
            if (licenseExpiry) existing.licenseExpiry = licenseExpiry;
            if (medicalCertExpiry) existing.medicalCertExpiry = medicalCertExpiry;
            if (phone) existing.phone = phone;
            if (address) existing.address = address;
            if (dateOfJoining) existing.dateOfJoining = dateOfJoining;
            if (emergencyContact) existing.emergencyContact = emergencyContact;
            if (police) existing.policeVerification = police;
            existing.experienceYears = +experienceYears || existing.experienceYears;
            existing.locationSharing = !!locationSharing;
            if (notes) existing.notes = notes;
            await existing.save();
            if (vehicle) existing.assignedVehicle = vehicle;
            await logAudit(req, 'update', 'Staff', existing._id, `${u.name} is now a ${staffType}`);
            return ok(res, existing);
        }

        const prefix = { driver: 'DRV', conductor: 'CND', helper: 'HLP' }[staffType];
        const profile = await TeacherProfile.findOne({ user }).select('employeeId').lean();
        const code = employeeId || profile?.employeeId || await nextNumber(TransportStaff, school, prefix);
        const clash = await TransportStaff.findOne({ school, employeeId: code });
        if (clash) return bad(res, `Employee ID ${code} is already used by another crew record`);

        const row = await TransportStaff.create({
            school, user, staffType, employeeId: code,
            // Kept as a fallback only; the screens read the employee record.
            name: u.name,
            phone, address, dateOfJoining, assignedVehicle: vehicle || null,
            licenseNumber, licenseType, licenseExpiry, medicalCertExpiry,
            ...(police ? { policeVerification: police } : {}),
            ...(emergencyContact ? { emergencyContact } : {}),
            experienceYears: +experienceYears || 0, locationSharing: !!locationSharing, notes,
            createdBy: req.userId,
        });
        await logAudit(req, 'create', 'Staff', row._id, `${u.name} assigned as ${staffType}`);
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/** Detach a crew record from its employee account, leaving it standalone. */
exports.unlinkCrewEmployee = async (req, res) => {
    try {
        const row = await TransportStaff.findOne({ _id: req.params.id, school: req.schoolId });
        if (!row) return bad(res, 'Crew member not found', 404);
        if (!row.user) return bad(res, 'That record is not linked to an employee');
        const emp = await User.findById(row.user).select('name phone profileImage').lean();
        // Keep what was on screen a moment ago: copy the identity down before
        // cutting the link, or the row would lose its name.
        if (emp) {
            row.name = row.name || emp.name;
            row.phone = row.phone || emp.phone || '';
            row.photo = row.photo || emp.profileImage || '';
        }
        row.user = null;
        row.locationSharing = false;
        await row.save();
        await logAudit(req, 'update', 'Staff', row._id, `Unlinked ${row.name} from their employee account`);
        ok(res, row);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  CREW LOCATION
// ═════════════════════════════════════════════════════════════════════════════
/** Validate and store one ping, and keep the snapshot on the crew record. */
async function storeStaffPing(schoolId, staffRow, body, userId) {
    const lat = Number(body.latitude), lng = Number(body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('latitude and longitude are required');
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('That is not a point on Earth');
    const at = body.recordedAt ? new Date(body.recordedAt) : new Date();
    const ping = await TransportStaffLocation.create({
        school: schoolId, staff: staffRow._id, user: userId || staffRow.user || null,
        trip: body.trip || null, latitude: lat, longitude: lng,
        accuracy: body.accuracy != null ? Number(body.accuracy) : null,
        speed: Number(body.speed) || 0, heading: Number(body.heading) || 0,
        battery: body.battery != null ? Number(body.battery) : null,
        source: ['device', 'vehicle', 'manual'].includes(body.source) ? body.source : 'device',
        recordedAt: at,
    });
    await TransportStaff.updateOne({ _id: staffRow._id }, {
        $set: {
            lastLocation: {
                latitude: lat, longitude: lng,
                accuracy: ping.accuracy, speed: ping.speed, source: ping.source, at,
            },
        },
    });
    return ping;
}

/** Admin / device ingest · POST /transport/admin/staff/:id/location */
exports.pushStaffLocation = async (req, res) => {
    try {
        const row = await TransportStaff.findOne({ _id: req.params.id, school: req.schoolId });
        if (!row) return bad(res, 'Crew member not found', 404);
        if (!row.locationSharing) return bad(res, 'Location sharing is off for this crew member — turn it on first');
        const ping = await storeStaffPing(req.schoolId, row, req.body, req.userId);
        ok(res, { received: true, at: ping.recordedAt });
    } catch (e) { bad(res, e.message); }
};

/**
 * A crew member's own device · POST /transport/staff/location
 *
 * The caller is the employee, so the record is found from their own user id —
 * one person can never push a position for someone else.
 */
exports.selfPushLocation = async (req, res) => {
    try {
        const row = await TransportStaff.findOne({ school: req.schoolId, user: req.userId, isActive: true });
        if (!row) return bad(res, 'You do not hold a transport role', 403);
        if (!row.locationSharing) return bad(res, 'Location sharing is off for your account', 403);
        const ping = await storeStaffPing(req.schoolId, row, req.body, req.userId);
        ok(res, { received: true, at: ping.recordedAt });
    } catch (e) { bad(res, e.message); }
};

/** Turn location sharing on or off for one crew member. */
exports.setLocationSharing = async (req, res) => {
    try {
        const row = await TransportStaff.findOne({ _id: req.params.id, school: req.schoolId });
        if (!row) return bad(res, 'Crew member not found', 404);
        if (req.body.on && !row.user) return bad(res, 'Link this record to an employee account first — a position comes from their device');
        row.locationSharing = !!req.body.on;
        if (!row.locationSharing) row.lastLocation = { latitude: null, longitude: null, accuracy: null, speed: 0, source: '', at: null };
        await row.save();
        await logAudit(req, 'update', 'Staff', row._id, `Location sharing ${row.locationSharing ? 'on' : 'off'} for ${row.name}`);
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/** One crew member's recent trail · GET /transport/admin/staff/:id/trail */
exports.staffTrail = async (req, res) => {
    try {
        const school = req.schoolId;
        const row = await TransportStaff.findOne({ _id: req.params.id, school }).lean();
        if (!row) return bad(res, 'Crew member not found', 404);
        const { start } = dayRange(req.query.date);
        const points = await TransportStaffLocation.find({ school, staff: row._id, recordedAt: { $gte: start } })
            .sort('recordedAt').limit(2000)
            .select('latitude longitude speed heading accuracy battery recordedAt source').lean();
        ok(res, { staff: { _id: row._id, name: row.name }, points, lastLocation: row.lastLocation || null });
    } catch (e) { fail(res, e); }
};

/** The rail's "Mark Leave" action. */
exports.markStaffLeave = async (req, res) => {
    try {
        const { fromDate, toDate, leaveType = 'casual', reason = '' } = req.body;
        if (!fromDate || !toDate) return bad(res, 'From and to dates are required');
        if (new Date(toDate) < new Date(fromDate)) return bad(res, 'The leave cannot end before it starts');
        const s = await TransportStaff.findOne({ _id: req.params.id, school: req.schoolId });
        if (!s) return bad(res, 'Staff not found', 404);

        // A driver on leave must not stay rostered: say which routes need cover
        // rather than silently leaving a bus without a driver.
        const covering = await TransportRoute.find({
            school: req.schoolId, isActive: true, status: 'active',
            $or: [{ driver: s._id }, { attendant: s._id }],
        }).select('name routeCode').lean();

        s.leaves = [...(s.leaves || []), { fromDate: new Date(fromDate), toDate: new Date(toDate), leaveType, reason, status: 'approved', approvedBy: req.userId }];
        const now = new Date();
        if (new Date(fromDate) <= now && new Date(toDate) >= new Date(now.getFullYear(), now.getMonth(), now.getDate())) s.status = 'on_leave';
        await s.save();
        await logAudit(req, 'leave', 'Staff', s._id, `${s.name} on leave ${new Date(fromDate).toDateString()} → ${new Date(toDate).toDateString()}`);
        ok(res, { staff: s, needsCover: covering.map((r) => ({ _id: r._id, name: r.name, routeCode: r.routeCode })) });
    } catch (e) { fail(res, e); }
};

/** Put a crew member back on duty, closing any leave that covers today. */
exports.endStaffLeave = async (req, res) => {
    try {
        const s = await TransportStaff.findOne({ _id: req.params.id, school: req.schoolId });
        if (!s) return bad(res, 'Staff not found', 404);
        const today = new Date();
        s.leaves = (s.leaves || []).map((l) => (l.status === 'approved' && new Date(l.toDate) >= today && new Date(l.fromDate) <= today
            ? { ...l, toDate: today, status: 'approved' } : l));
        s.status = 'active';
        await s.save();
        await logAudit(req, 'leave_end', 'Staff', s._id, `${s.name} back on duty`);
        ok(res, s);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES  ·  GET /transport/admin/route-board
// ═════════════════════════════════════════════════════════════════════════════
/**
 * The school's current academic year, and the half of it we are in.
 *
 * The mockups compare against "this term". No term exists in the data model,
 * so a term here is half an academic year, and the label says which months it
 * covers — the figure is honest and the wording does not claim more.
 */
async function currentTerm(schoolId) {
    const now = new Date();
    const years = await AcademicYear.find({ school: schoolId, status: 'active' }).sort('-startDate').lean();
    const year = years.find((y) => new Date(y.startDate) <= now && new Date(y.endDate) >= now) || years[0];
    if (!year) {
        const from = monthStart(3);
        return { from, prevFrom: monthStart(6), prevTo: from, label: 'last 3 months', yearName: '' };
    }
    const s = new Date(year.startDate), e = new Date(year.endDate);
    const mid = new Date((s.getTime() + e.getTime()) / 2);
    const inSecondHalf = now >= mid;
    const from = inSecondHalf ? mid : s;
    const prevFrom = inSecondHalf ? s : new Date(s.getFullYear() - 1, s.getMonth(), s.getDate());
    const fmt = (d) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    return {
        from, prevFrom, prevTo: from, yearName: year.yearName,
        label: `${fmt(from)} – ${fmt(inSecondHalf ? e : mid)}`,
    };
}

exports.routeBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const { search = '', status = '' } = req.query;
        const term = await currentTerm(school);
        const { start, end } = dayRange();

        const [routesRaw, assignments, vehicles, staff, trips, locations, schoolDoc] = await Promise.all([
            TransportRoute.find({ school, isActive: true }).sort('routeCode').lean(),
            TransportAssignment.find({ school }).select('route status createdAt').lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber registrationNumber capacity photo status vehicleType manufacturer').lean(),
            TransportStaff.find({ school, isActive: true }).select('name phone photo staffType status').lean(),
            TransportTrip.find({ school, date: { $gte: start, $lt: addDays(start, 2) } })
                .select('route vehicle shift direction status startTime tripCode delayMinutes lastLocation').lean(),
            VehicleLocation.find({ school, recordedAt: { $gte: daysAgo(1) } }).sort('-recordedAt').select('vehicle latitude longitude speed recordedAt').limit(2000).lean(),
            School.findById(school).select('name').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const vehicleById = new Map(vehicles.map((v) => [String(v._id), v]));
        const staffById = new Map(staff.map((s) => [String(s._id), s]));
        const lastPing = new Map();
        locations.forEach((p) => { const k = String(p.vehicle); if (!lastPing.has(k)) lastPing.set(k, p); });

        const activeAssign = assignments.filter((a) => a.status === 'active');
        const countByRoute = new Map();
        activeAssign.forEach((a) => countByRoute.set(String(a.route), (countByRoute.get(String(a.route)) || 0) + 1));

        const decorate = (r) => {
            const v = vehicleById.get(String(r.vehicle));
            const d = staffById.get(String(r.driver));
            const att = staffById.get(String(r.attendant));
            const stops = [...(r.stops || [])].sort((a, b) => a.sequence - b.sequence);
            const ping = v ? lastPing.get(String(v._id)) : null;
            // A route's distance may be typed in, or read off its last stop.
            const distanceKm = r.distanceKm || round1(stops.reduce((m, s) => Math.max(m, num(s.distanceFromStart)), 0));
            return {
                _id: r._id, name: r.name, routeCode: r.routeCode, tag: r.tag, color: r.color, zone: r.zone,
                description: r.description, shift: r.shift, routeType: r.routeType, status: r.status,
                students: countByRoute.get(String(r._id)) || 0,
                stops: stops.map((s) => ({
                    _id: s._id, name: s.name, sequence: s.sequence, latitude: s.latitude, longitude: s.longitude,
                    arrivalTime: s.arrivalTime, eveningTime: s.eveningTime, distanceFromStart: s.distanceFromStart,
                    landmark: s.landmark, maxStudents: s.maxStudents,
                })),
                stopCount: stops.length,
                stopSummary: stops.slice(0, 3).map((s) => s.name).join(' · '),
                distanceKm,
                durationMin: r.estimatedDurationMin || 0,
                capacity: v?.capacity || 0,
                schedule: {
                    morningStart: r.schedule?.morningStart || stops[0]?.arrivalTime || '',
                    morningEnd: r.schedule?.morningEnd || stops[stops.length - 1]?.arrivalTime || '',
                    eveningStart: r.schedule?.eveningStart || stops[0]?.eveningTime || '',
                    eveningEnd: r.schedule?.eveningEnd || stops[stops.length - 1]?.eveningTime || '',
                },
                vehicle: v ? { _id: v._id, vehicleNumber: v.vehicleNumber, registrationNumber: v.registrationNumber, photo: v.photo, capacity: v.capacity, manufacturer: v.manufacturer, status: v.status } : null,
                driver: d ? { _id: d._id, name: d.name, phone: d.phone, photo: d.photo } : null,
                attendant: att ? { _id: att._id, name: att.name, phone: att.phone, photo: att.photo } : null,
                live: ping ? { latitude: ping.latitude, longitude: ping.longitude, speed: ping.speed, at: ping.recordedAt } : null,
                geofenceRadiusM: r.geofenceRadiusM || st.geofenceRadiusM,
                effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, createdAt: r.createdAt,
            };
        };
        const all = routes.map(decorate);

        const needle = String(search).trim().toLowerCase();
        const rows = all.filter((r) => {
            if (status && r.status !== status) return false;
            if (needle && ![r.name, r.routeCode, r.tag, r.zone, r.stopSummary].join(' ').toLowerCase().includes(needle)) return false;
            return true;
        });

        const assignedNow = activeAssign.length;
        const assignedPrevTerm = assignments.filter((a) => new Date(a.createdAt) < term.from).length;
        const tiles = {
            total: all.length,
            active: all.filter((r) => r.status === 'active').length,
            inactive: all.filter((r) => ['inactive', 'draft'].includes(r.status)).length,
            maintenance: all.filter((r) => r.status === 'maintenance').length,
            newThisTerm: all.filter((r) => new Date(r.createdAt) >= term.from).length,
            students: assignedNow,
            studentsDelta: delta(assignedNow, assignedPrevTerm),
            term: term.label,
            yearName: term.yearName,
        };

        // ── Upcoming trips (today and tomorrow, not yet run) ─────────────────
        const upcoming = trips.filter((t) => ['scheduled', 'started'].includes(t.status))
            .map((t) => {
                const r = all.find((x) => String(x._id) === String(t.route));
                return {
                    _id: t._id, tripCode: t.tripCode, route: r ? { tag: r.tag, name: r.name, color: r.color } : null,
                    shift: t.shift, direction: t.direction, status: t.status, delayMinutes: t.delayMinutes || 0,
                    at: t.startTime || null,
                    plannedTime: t.shift === 'morning' ? r?.schedule.morningStart : r?.schedule.eveningStart,
                };
            })
            .sort((a, b) => String(a.plannedTime || '').localeCompare(String(b.plannedTime || '')))
            .slice(0, 6);

        const activity = await TransportAuditLog.find({ school, entityType: { $in: ['Route', 'Assignment'] } })
            .sort('-createdAt').limit(6).populate('user', 'name').lean();

        ok(res, {
            tiles,
            data: rows,
            utilization: all.filter((r) => r.status !== 'inactive').map((r) => ({ tag: r.tag, name: r.name, color: r.color, students: r.students, capacity: r.capacity })),
            upcoming,
            activity: activity.map((a) => ({ at: a.createdAt, text: a.description, by: a.user?.name || 'System', action: a.actionType })),
            school: { name: schoolDoc?.name || 'School', latitude: st.schoolLatitude ?? null, longitude: st.schoolLongitude ?? null },
            map: mapConfig(st),
            palette: ROUTE_COLORS,
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ASSIGNMENTS  ·  GET /transport/admin/assignment-board
// ═════════════════════════════════════════════════════════════════════════════
/**
 * One assignment, as every view of this screen needs it.
 *
 * Pickup and drop times are NOT stored on the assignment: they are the times
 * the route's timetable gives that child's stop, so storing them would create a
 * second truth that drifts the moment a stop time is edited.
 */
function decorateAssignment(a, { routeById, vehicleById, students, staffById }) {
    const r = routeById.get(String(a.route));
    const stops = r?.stops || [];
    const pickup = stops.find((s) => String(s._id) === String(a.pickupStop));
    const drop = stops.find((s) => String(s._id) === String(a.dropStop));
    const v = vehicleById.get(String(a.vehicle || r?.vehicle || ''));
    const d = staffById.get(String(r?.driver || ''));
    return {
        _id: a._id, status: a.status, seatNumber: a.seatNumber, shift: a.shift,
        effectiveDate: a.effectiveDate, endDate: a.endDate, createdAt: a.createdAt,
        isTemporary: a.isTemporary, temporaryAddress: a.temporaryAddress,
        suspensionReason: a.suspensionReason, notes: a.notes, feePlan: a.feePlan,
        student: students.get(String(a.student)) || { _id: a.student, name: '—' },
        route: r ? { _id: r._id, name: r.name, tag: r.tag, color: r.color, zone: r.zone } : null,
        vehicle: v ? { _id: v._id, vehicleNumber: v.vehicleNumber, manufacturer: v.manufacturer, capacity: v.capacity } : null,
        driver: d ? { _id: d._id, name: d.name, phone: d.phone, photo: d.photo } : null,
        pickupStop: pickup ? { _id: pickup._id, name: pickup.name, sequence: pickup.sequence } : null,
        dropStop: drop ? { _id: drop._id, name: drop.name, sequence: drop.sequence } : null,
        pickupTime: pickup?.arrivalTime || '',
        dropTime: drop?.eveningTime || drop?.departureTime || '',
    };
}

exports.assignmentBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', route = '', status = 'active', classId = '', page = 1, limit = 8, view = 'students' } = req.query;
        const term = await currentTerm(school);

        const [assignments, routesRaw, vehicles, staff] = await Promise.all([
            TransportAssignment.find({ school }).sort('-createdAt').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode zone color shift stops vehicle driver status').lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber manufacturer capacity status').lean(),
            TransportStaff.find({ school, isActive: true }).select('name phone photo staffType status leaves').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));
        const vehicleById = new Map(vehicles.map((v) => [String(v._id), v]));
        const staffById = new Map(staff.map((s) => [String(s._id), s]));

        const active = assignments.filter((a) => a.status === 'active');
        // personIndex, not studentIndex: an enrolment may be a staff rider. It
        // derives the kind from the ACCOUNT rather than from the row's
        // personType, because ensureTable adds a column without applying its
        // default and rows written before it exists carry ''.
        const students = await personIndex(assignments.map((a) => a.student));
        const ctx = { routeById, vehicleById, students, staffById };

        // ── Tiles ────────────────────────────────────────────────────────────
        const usedVehicles = new Set(active.map((a) => String(a.vehicle)).filter((x) => x && x !== 'null'));
        const routeDrivers = new Set(routes.filter((r) => r.status === 'active' && r.driver).map((r) => String(r.driver)));
        const driversOnLeave = [...routeDrivers].filter((id) => leaveOn(staffById.get(id) || {})).length;
        const assignedPrevTerm = assignments.filter((a) => new Date(a.createdAt) < term.from).length;
        const routesWithStudents = new Set(active.map((a) => String(a.route)));
        const activeRoutes = routes.filter((r) => r.status === 'active');

        const allStudents = await User.countDocuments({ school, role: 'student', isActive: true });
        const tiles = {
            assigned: active.length,
            assignedDelta: delta(active.length, assignedPrevTerm),
            routes: activeRoutes.length,
            routesUsedPct: pct([...routesWithStudents].filter((id) => routeById.get(id)?.status === 'active').length, activeRoutes.length),
            vehiclesInUse: usedVehicles.size,
            vehiclesSpare: Math.max(0, vehicles.filter((v) => v.status === 'active').length - usedVehicles.size),
            driversAssigned: routeDrivers.size,
            driversOnLeave,
            unassigned: Math.max(0, allStudents - active.length),
            term: term.label,
        };

        // ── The picked view ──────────────────────────────────────────────────
        const needle = String(search).trim().toLowerCase();
        const matches = (a) => {
            if (status && a.status !== status) return false;
            if (route && String(a.route) !== String(route)) return false;
            const s = students.get(String(a.student));
            if (classId && s?.className !== classId) return false;
            if (needle) {
                const r = routeById.get(String(a.route));
                const hay = [s?.name, s?.admissionNumber, s?.classLabel, r?.name, r?.tag].join(' ').toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        };
        const filtered = assignments.filter(matches);
        const decorated = filtered.map((a) => decorateAssignment(a, ctx));

        let groups = null;
        if (view !== 'students') {
            // Route-wise / stop-wise / vehicle-wise / driver-wise are the same
            // rows folded on a different key — one place, four keys.
            const keyOf = {
                routes: (x) => (x.route ? { id: x.route._id, label: `${x.route.tag} — ${x.route.name}`, sub: x.route.zone, color: x.route.color } : null),
                stops: (x) => (x.pickupStop ? { id: x.pickupStop._id, label: x.pickupStop.name, sub: x.route ? `${x.route.tag} · Stop ${x.pickupStop.sequence}` : '', color: x.route?.color } : null),
                vehicles: (x) => (x.vehicle ? { id: x.vehicle._id, label: x.vehicle.vehicleNumber, sub: x.vehicle.manufacturer, color: x.route?.color } : null),
                drivers: (x) => (x.driver ? { id: x.driver._id, label: x.driver.name, sub: x.driver.phone, color: x.route?.color } : null),
            }[view];
            const map = new Map();
            decorated.forEach((x) => {
                const k = keyOf ? keyOf(x) : null;
                const id = k ? String(k.id) : '__none';
                if (!map.has(id)) map.set(id, { ...(k || { id: null, label: 'Not set', sub: '', color: '#94a3b8' }), students: [], count: 0 });
                const g = map.get(id);
                g.count++;
                if (g.students.length < 12) g.students.push(x);
            });
            groups = [...map.values()].sort((a, b) => b.count - a.count);
        }

        const p = Math.max(1, +page), lim = Math.max(1, +limit);
        const paged = decorated.slice((p - 1) * lim, p * lim);

        // ── Panels ───────────────────────────────────────────────────────────
        const summary = routes.map((r) => ({
            _id: r._id, tag: r.tag, name: r.name, color: r.color,
            students: active.filter((a) => String(a.route) === String(r._id)).length,
        })).filter((r) => r.students > 0).sort((a, b) => b.students - a.students);

        const assignedIds = new Set(active.map((a) => String(a.student)));
        const unassignedUsers = await User.find({ school, role: 'student', isActive: true }).select('name').limit(400).lean();
        const unassignedIds = unassignedUsers.filter((u) => !assignedIds.has(String(u._id))).map((u) => u._id);
        const unassignedIndex = await studentIndex(unassignedIds.slice(0, 40));
        const unassignedStudents = [...unassignedIndex.values()].sort((a, b) => a.name.localeCompare(b.name));

        const recent = assignments.slice(0, 5).map((a) => {
            const x = decorateAssignment(a, ctx);
            return {
                at: a.createdAt, student: x.student, route: x.route, status: a.status,
                text: a.status === 'cancelled' ? `Assignment removed — ${x.student.name}`
                    : `${x.student.name} assigned to ${x.route?.tag || 'a route'}`,
                tone: a.status === 'cancelled' ? 'bad' : a.status === 'suspended' ? 'warn' : 'good',
            };
        });

        // Approved or pending requests that take effect later, plus routes the
        // workshop has taken out of service — the two things that will move
        // children between now and next week.
        const futureReqs = await TransportRequest.find({
            school, status: { $in: ['pending', 'approved'] },
            $or: [{ 'details.fromDate': { $gte: new Date() } }, { status: 'pending' }],
        }).sort('details.fromDate').limit(6).lean();
        const reqStudents = await personIndex(futureReqs.map((r) => r.student));
        const upcomingChanges = futureReqs.map((r) => ({
            at: r.details?.fromDate || r.createdAt,
            type: r.requestType,
            status: r.status,
            student: reqStudents.get(String(r.student)) || null,
            // Sentence case, so these read like the "Route change — R5" rows
            // pushed in below them rather than raw enum values.
            text: `${sentence(String(r.requestType).replace(/_/g, ' '))} — ${reqStudents.get(String(r.student))?.name || 'student'}`,
            tone: r.status === 'pending' ? 'warn' : 'info',
        }));
        const maintRoutes = routes.filter((r) => r.status === 'maintenance');
        maintRoutes.forEach((r) => upcomingChanges.push({
            at: new Date(), type: 'route_maintenance', status: 'active',
            text: `Route change — ${r.tag} (${active.filter((a) => String(a.route) === String(r._id)).length} students)`,
            detail: 'Due to vehicle maintenance', tone: 'warn',
        }));

        const classes = [...new Set([...students.values()].map((s) => s.className).filter(Boolean))].sort();

        ok(res, {
            tiles, data: paged, groups, total: decorated.length, page: p, pages: Math.max(1, Math.ceil(decorated.length / lim)),
            summary, unassignedStudents, unassignedTotal: tiles.unassigned,
            recent, upcomingChanges: upcomingChanges.slice(0, 6),
            filters: { routes: routes.map((r) => ({ value: r._id, label: `${r.tag} — ${r.name}` })), classes },
        });
    } catch (e) { fail(res, e); }
};

/**
 * Bulk assign · POST /transport/admin/assignments/bulk
 *
 * Every student is decided on its own and reported on its own: a run of forty
 * where three are already assigned must place the other thirty-seven, not fail.
 * Capacity is counted once for the whole run, not per row, or the last seat is
 * sold repeatedly.
 */
exports.bulkAssign = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const { students = [], route: routeId, pickupStop = null, dropStop = null, feePlan = null, shift = 'both', vehicle: vehicleOverride = null } = req.body;
        if (!Array.isArray(students) || !students.length) return bad(res, 'Pick at least one student');
        if (!routeId) return bad(res, 'Pick a route');

        const route = await TransportRoute.findOne({ _id: routeId, school }).lean();
        if (!route) return bad(res, 'Route not found', 404);
        const vehicleId = vehicleOverride || route.vehicle || null;
        const vehicle = vehicleId ? await Vehicle.findOne({ _id: vehicleId, school }).lean() : null;

        const ids = [...new Set(students.map(String))];
        const [existing, validStudents, occupied] = await Promise.all([
            TransportAssignment.find({ school, student: { $in: ids }, status: 'active' }).select('student').lean(),
            User.find({ school, _id: { $in: ids }, role: 'student', isActive: true }).select('name').lean(),
            vehicleId ? TransportAssignment.countDocuments({ school, vehicle: vehicleId, status: 'active' }) : 0,
        ]);
        const already = new Set(existing.map((e) => String(e.student)));
        const known = new Map(validStudents.map((u) => [String(u._id), u]));
        const cap = vehicle?.capacity || st.maxStudentsPerBus || 0;
        let seatsLeft = st.allowOverbooking || !cap ? Infinity : Math.max(0, cap - occupied);

        const results = [];
        const created = [];
        for (const id of ids) {
            const u = known.get(id);
            if (!u) { results.push({ student: id, ok: false, reason: 'Not a student of this school' }); continue; }
            if (already.has(id)) { results.push({ student: id, name: u.name, ok: false, reason: 'Already has an active assignment' }); continue; }
            if (seatsLeft <= 0) { results.push({ student: id, name: u.name, ok: false, reason: `Vehicle is full (${cap} seats)` }); continue; }
            const a = await TransportAssignment.create({
                school, student: id, route: routeId, vehicle: vehicleId,
                pickupStop, dropStop, shift, feePlan, createdBy: req.userId,
            });
            seatsLeft--; created.push(a); results.push({ student: id, name: u.name, ok: true, assignment: a._id });
        }
        if (created.length) {
            await syncOccupancy(school, [vehicleId]);
            await logAudit(req, 'bulk_assign', 'Assignment', null, `Assigned ${created.length} students to ${route.name}`, { route: routeId });
            withParents(created.map((c) => c.student)).then((targets) => notify({
                school, sender: req.userId, senderRole: req.userRole,
                title: '🚌 Transport assigned',
                body: `Transport has been assigned on route "${route.name}".`,
                recipients: targets, link: { type: 'transport.mine', entityId: null },
            })).catch(() => {});
        }
        ok(res, { created: created.length, skipped: results.filter((r) => !r.ok).length, results });
    } catch (e) { fail(res, e); }
};

/**
 * Import · POST /transport/admin/assignments/import
 *
 * The page parses the spreadsheet (it already has the file); this matches each
 * row to real records and reports every rejection with its row number, so a
 * 200-row sheet with four typos tells the user which four.
 * `dryRun` validates without writing — what the preview step calls.
 */
exports.importAssignments = async (req, res) => {
    try {
        const school = req.schoolId;
        const { rows = [], dryRun = false } = req.body;
        if (!Array.isArray(rows) || !rows.length) return bad(res, 'Nothing to import');
        if (rows.length > 1000) return bad(res, 'Import at most 1000 rows at a time');

        const [routes, profiles, users, existing] = await Promise.all([
            TransportRoute.find({ school, isActive: true }).select('name routeCode stops vehicle').lean(),
            StudentProfile.find({ school }).select('user admissionNumber').lean(),
            User.find({ school, role: 'student', isActive: true }).select('name email').lean(),
            TransportAssignment.find({ school, status: 'active' }).select('student').lean(),
        ]);
        const byAdm = new Map(profiles.filter((p) => p.admissionNumber).map((p) => [String(p.admissionNumber).trim().toLowerCase(), String(p.user)]));
        const byEmail = new Map(users.filter((u) => u.email).map((u) => [String(u.email).trim().toLowerCase(), String(u._id)]));
        const byName = new Map();
        users.forEach((u) => {
            const k = String(u.name || '').trim().toLowerCase();
            byName.set(k, byName.has(k) ? '__ambiguous' : String(u._id));   // a repeated name is never guessed
        });
        const routeByCode = new Map(routes.map((r) => [String(r.routeCode).trim().toLowerCase(), r]));
        const routeByName = new Map(routes.map((r) => [String(r.name).trim().toLowerCase(), r]));
        const assigned = new Set(existing.map((e) => String(e.student)));

        const results = [];
        const toCreate = [];
        rows.forEach((raw, i) => {
            const line = i + 1;
            const key = (k) => String(raw[k] ?? '').trim();
            const studentKey = key('admissionNumber') || key('admission_no') || key('email') || key('student') || key('studentName');
            const sid = byAdm.get(studentKey.toLowerCase()) || byEmail.get(studentKey.toLowerCase()) || byName.get(studentKey.toLowerCase());
            if (!sid) return results.push({ line, ok: false, reason: `No student matches "${studentKey || '(blank)'}"` });
            if (sid === '__ambiguous') return results.push({ line, ok: false, reason: `"${studentKey}" matches more than one student — use the admission number` });
            if (assigned.has(sid)) return results.push({ line, ok: false, reason: 'Student already has an active assignment' });

            const routeKey = (key('route') || key('routeCode') || key('routeName')).toLowerCase();
            const route = routeByCode.get(routeKey) || routeByName.get(routeKey);
            if (!route) return results.push({ line, ok: false, reason: `No route matches "${key('route') || '(blank)'}"` });

            const stopName = (n) => {
                const t = key(n).toLowerCase();
                if (!t) return null;
                return (route.stops || []).find((s) => String(s.name).trim().toLowerCase() === t)?._id || '__missing';
            };
            const pickup = stopName('pickupStop') ?? null;
            const drop = stopName('dropStop') ?? null;
            if (pickup === '__missing') return results.push({ line, ok: false, reason: `"${key('pickupStop')}" is not a stop on ${route.name}` });
            if (drop === '__missing') return results.push({ line, ok: false, reason: `"${key('dropStop')}" is not a stop on ${route.name}` });

            assigned.add(sid);
            toCreate.push({
                school, student: sid, route: route._id, vehicle: route.vehicle || null,
                pickupStop: pickup, dropStop: drop, seatNumber: key('seatNumber'),
                shift: ['morning', 'evening', 'both'].includes(key('shift')) ? key('shift') : 'both',
                createdBy: req.userId,
            });
            results.push({ line, ok: true, student: sid, route: route.name });
        });

        if (!dryRun && toCreate.length) {
            for (const doc of toCreate) await TransportAssignment.create(doc);
            await syncOccupancy(school, toCreate.map((d) => d.vehicle));
            await logAudit(req, 'import', 'Assignment', null, `Imported ${toCreate.length} transport assignments`);
        }
        ok(res, {
            dryRun: !!dryRun, total: rows.length,
            created: dryRun ? 0 : toCreate.length, ready: toCreate.length,
            failed: results.filter((r) => !r.ok).length, results,
        });
    } catch (e) { fail(res, e); }
};

/** "Send Notification" — to a whole route, or to the students picked. */
exports.notifyAssignees = async (req, res) => {
    try {
        const { route: routeId = null, students = [], title = '', body = '' } = req.body;
        if (!title.trim() || !body.trim()) return bad(res, 'A title and a message are required');
        const q = { school: req.schoolId, status: 'active' };
        if (routeId) q.route = routeId;
        else if (students.length) q.student = { $in: students.map(String) };
        else return bad(res, 'Pick a route or some students');
        const rows = await TransportAssignment.find(q).select('student').lean();
        if (!rows.length) return bad(res, 'Nobody matches — nothing was sent');
        const targets = await withParents(rows.map((r) => r.student));
        await notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: title.trim(), body: body.trim(), recipients: targets,
            link: { type: 'transport.mine', entityId: null },
        });
        await logAudit(req, 'notify', 'Assignment', routeId, `Notified ${rows.length} students' families`);
        ok(res, { students: rows.length, recipients: targets.length });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  TRIPS  ·  GET /transport/admin/trip-board
// ═════════════════════════════════════════════════════════════════════════════
/** A morning bus leaves school to collect; an afternoon bus leaves to deliver. */
const directionLabel = (t) => (t.direction === 'pickup' ? 'School → City' : 'City → School');
const shiftLabel = (t) => (t.tripType && t.tripType !== 'regular'
    ? `${t.tripType.charAt(0).toUpperCase()}${t.tripType.slice(1)} Trip`
    : t.shift === 'morning' ? 'Morning Trip' : 'Afternoon Trip');

exports.tripBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const { date, route = '', vehicle = '', driver = '', tripType = '', status = '', search = '', page = 1, limit = 8 } = req.query;
        const { start, end } = dayRange(date);

        const [trips, routesRaw, vehicles, staff, weekTrips, assignedTotal] = await Promise.all([
            TransportTrip.find({ school, date: { $gte: start, $lt: end } }).sort('shift').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode zone color shift stops schedule').lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber manufacturer photo capacity vehicleType').lean(),
            TransportStaff.find({ school, isActive: true }).select('name phone photo staffType').lean(),
            TransportTrip.find({ school, date: { $gte: daysAgo(6) } }).select('date shift status').lean(),
            TransportAssignment.countDocuments({ school, status: 'active' }),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));
        const vehicleById = new Map(vehicles.map((v) => [String(v._id), v]));
        const staffById = new Map(staff.map((s) => [String(s._id), s]));

        const decorate = (t) => {
            const r = routeById.get(String(t.route));
            const v = vehicleById.get(String(t.vehicle));
            const d = staffById.get(String(t.driver));
            const att = staffById.get(String(t.attendant));
            const sa = t.studentAttendance || [];
            const boarded = sa.filter((s) => ['boarded', 'dropped'].includes(s.status)).length;
            const delayed = (t.delayMinutes || 0) > st.delayThresholdMin;
            return {
                _id: t._id, tripCode: t.tripCode, date: t.date, shift: t.shift, direction: t.direction,
                tripType: t.tripType || 'regular', title: t.title || '',
                shiftLabel: shiftLabel(t), directionLabel: directionLabel(t),
                status: t.status, displayStatus: t.status === 'cancelled' ? 'cancelled'
                    : delayed && t.status !== 'completed' ? 'delayed'
                    : t.status === 'completed' ? 'completed'
                    : ['started', 'paused'].includes(t.status) ? 'in_progress' : 'scheduled',
                delayMinutes: t.delayMinutes || 0,
                startTime: t.startTime, endTime: t.endTime,
                plannedStart: t.shift === 'morning' ? r?.schedule?.morningStart || '' : r?.schedule?.eveningStart || '',
                durationMin: t.startTime && t.endTime ? Math.round((new Date(t.endTime) - new Date(t.startTime)) / 60000) : null,
                boarded, absent: sa.filter((s) => s.status === 'absent').length, total: sa.length,
                route: r ? { _id: r._id, name: r.name, tag: r.tag, color: r.color, zone: r.zone } : null,
                vehicle: v ? { _id: v._id, vehicleNumber: v.vehicleNumber, manufacturer: v.manufacturer, photo: v.photo } : null,
                driver: d ? { _id: d._id, name: d.name, phone: d.phone, photo: d.photo } : null,
                attendant: att ? { _id: att._id, name: att.name } : null,
                stopsTotal: (t.stopEvents || []).length,
                stopsReached: (t.stopEvents || []).filter((e) => e.status === 'reached').length,
            };
        };
        const all = trips.map(decorate);

        const tiles = {
            total: all.length,
            completed: all.filter((t) => t.displayStatus === 'completed').length,
            inProgress: all.filter((t) => t.displayStatus === 'in_progress').length,
            // Counted on lateness, not on the status word: a trip that ran 12
            // minutes late and has since finished still ran late, and the day's
            // delays must not vanish the moment the buses get back.
            delayed: all.filter((t) => t.delayMinutes > st.delayThresholdMin && t.displayStatus !== 'cancelled').length,
            cancelled: all.filter((t) => t.displayStatus === 'cancelled').length,
            scheduled: all.filter((t) => t.displayStatus === 'scheduled').length,
            students: new Set(trips.flatMap((t) => (t.studentAttendance || [])
                .filter((s) => ['boarded', 'dropped'].includes(s.status)).map((s) => String(s.student)))).size,
            assigned: assignedTotal,
            inProgressRoutes: all.filter((t) => t.displayStatus === 'in_progress').map((t) => t.route?.tag).filter(Boolean),
            delayedRoutes: all.filter((t) => t.delayMinutes > st.delayThresholdMin && t.displayStatus !== 'cancelled')
                .map((t) => ({ tag: t.route?.tag, minutes: t.delayMinutes })),
        };

        const needle = String(search).trim().toLowerCase();
        const rows = all.filter((t) => {
            if (route && String(t.route?._id) !== String(route)) return false;
            if (vehicle && String(t.vehicle?._id) !== String(vehicle)) return false;
            if (driver && String(t.driver?._id) !== String(driver)) return false;
            if (tripType && t.tripType !== tripType) return false;
            if (status && t.displayStatus !== status) return false;
            if (needle && ![t.tripCode, t.route?.name, t.route?.tag, t.vehicle?.vehicleNumber, t.driver?.name, t.shiftLabel].join(' ').toLowerCase().includes(needle)) return false;
            return true;
        });
        const p = Math.max(1, +page), lim = Math.max(1, +limit);

        // ── Charts ───────────────────────────────────────────────────────────
        // $dayOfWeek is not available in this ORM's aggregation, and folding
        // seven days in JS is cheaper than seven round trips anyway.
        const byDay = new Map();
        weekTrips.forEach((t) => {
            const d = new Date(t.date);
            const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            if (!byDay.has(k)) byDay.set(k, { label: DAYS[d.getDay()], morning: 0, afternoon: 0, at: d });
            const b = byDay.get(k);
            if (t.shift === 'morning') b.morning++; else b.afternoon++;
        });
        const byWeekday = [...byDay.values()].sort((a, b) => a.at - b.at).map(({ label, morning, afternoon }) => ({ label, morning, afternoon }));
        const routeWise = routes.map((r) => ({
            tag: r.tag, name: r.name, color: r.color,
            trips: all.filter((t) => String(t.route?._id) === String(r._id)).length,
        })).filter((r) => r.trips > 0).sort((a, b) => b.trips - a.trips);

        ok(res, {
            date: start, tiles, data: rows.slice((p - 1) * lim, p * lim),
            total: rows.length, page: p, pages: Math.max(1, Math.ceil(rows.length / lim)),
            byWeekday, routeWise,
            filters: {
                routes: routes.map((r) => ({ value: r._id, label: `${r.tag} — ${r.name}` })),
                vehicles: vehicles.map((v) => ({ value: v._id, label: v.vehicleNumber })),
                drivers: staff.filter((s) => s.staffType === 'driver').map((s) => ({ value: s._id, label: s.name })),
                tripTypes: ['regular', 'special', 'excursion', 'event', 'exam'],
            },
        });
    } catch (e) { fail(res, e); }
};

/** One trip, with its stop timeline and roll — the Trips rail and Timeline view. */
exports.tripDetail = async (req, res) => {
    try {
        const school = req.schoolId;
        const t = await TransportTrip.findOne({ _id: req.params.id, school }).lean();
        if (!t) return bad(res, 'Trip not found', 404);
        const [routeRaw, vehicle, crew, students] = await Promise.all([
            TransportRoute.findOne({ _id: t.route, school }).select('name routeCode zone color stops schedule distanceKm').lean(),
            t.vehicle ? Vehicle.findById(t.vehicle).select('vehicleNumber registrationNumber manufacturer capacity photo').lean() : null,
            TransportStaff.find({ _id: { $in: [t.driver, t.attendant].filter(Boolean) } }).select('name phone photo staffType').lean(),
            personIndex((t.studentAttendance || []).map((s) => s.student)),
        ]);
        const [route] = routeRaw ? tagRoutes([routeRaw]) : [null];
        const driver = crew.find((c) => String(c._id) === String(t.driver)) || null;
        const attendant = crew.find((c) => String(c._id) === String(t.attendant)) || null;
        const sa = t.studentAttendance || [];

        // Timeline: every stop, with how many children it accounts for.
        const events = [...(t.stopEvents || [])].sort((a, b) => a.sequence - b.sequence).map((e) => ({
            _id: e._id, stop: e.stop, name: e.name, sequence: e.sequence,
            plannedTime: e.plannedTime || '', status: e.status, reachedAt: e.reachedAt,
            students: sa.filter((s) => String(s.stop) === String(e.stop)).length,
            boarded: sa.filter((s) => String(s.stop) === String(e.stop) && ['boarded', 'dropped'].includes(s.status)).length,
        }));

        ok(res, {
            ...t,
            shiftLabel: shiftLabel(t), directionLabel: directionLabel(t),
            durationMin: t.startTime && t.endTime ? Math.round((new Date(t.endTime) - new Date(t.startTime)) / 60000) : null,
            route, vehicle, driver, attendant,
            timeline: events,
            roll: sa.map((s) => ({
                ...s, student: students.get(String(s.student)) || { _id: s.student, name: '—' },
                stopName: (t.stopEvents || []).find((e) => String(e.stop) === String(s.stop))?.name || '',
            })),
            counts: {
                total: sa.length,
                boarded: sa.filter((s) => ['boarded', 'dropped'].includes(s.status)).length,
                absent: sa.filter((s) => s.status === 'absent').length,
                pending: sa.filter((s) => s.status === 'pending').length,
            },
        });
    } catch (e) { fail(res, e); }
};

/**
 * Schedule one trip · POST /transport/admin/trips/schedule
 *
 * The generator makes the day's regular trips from routes. This is the other
 * kind: an excursion or an exam shuttle that exists once, on a date, and must
 * never be recreated by tomorrow's sweep — which is what `tripType` guards.
 */
exports.scheduleTrip = async (req, res) => {
    try {
        const school = req.schoolId;
        const { route: routeId, date, shift = 'morning', tripType = 'special', title = '', vehicle: vehicleId, driver: driverId, attendant = null, students = null } = req.body;
        if (!routeId) return bad(res, 'Pick a route');
        if (!date) return bad(res, 'Pick a date');
        const route = await TransportRoute.findOne({ _id: routeId, school }).lean();
        if (!route) return bad(res, 'Route not found', 404);
        const { start } = dayRange(date);

        const dup = await TransportTrip.findOne({ school, route: routeId, date: start, shift, tripType });
        if (dup) return bad(res, `A ${tripType} trip already exists on ${route.name} for that date and shift`);

        const direction = shift === 'morning' ? 'pickup' : 'drop';
        const stopEvents = [...(route.stops || [])].sort((a, b) => a.sequence - b.sequence)
            .map((s) => ({ stop: s._id, name: s.name, sequence: s.sequence, plannedTime: shift === 'morning' ? s.arrivalTime : s.eveningTime }));
        const assignQ = { school, route: routeId, status: 'active' };
        if (Array.isArray(students) && students.length) assignQ.student = { $in: students.map(String) };
        const assignments = await TransportAssignment.find(assignQ).lean();

        const trip = await TransportTrip.create({
            school, tripCode: await nextNumber(TransportTrip, school, 'TRP', true),
            route: routeId, vehicle: vehicleId || route.vehicle, driver: driverId || route.driver, attendant: attendant || route.attendant,
            date: start, shift, direction, tripType, title,
            stopEvents,
            studentAttendance: assignments.map((a) => ({
                student: a.student, assignment: a._id,
                stop: direction === 'pickup' ? a.pickupStop : a.dropStop, status: 'pending',
            })),
            createdBy: req.userId,
        });
        await logAudit(req, 'create', 'Trip', trip._id, `Scheduled ${tripType} trip ${trip.tripCode} on ${route.name}`);
        ok(res, trip);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  FUEL  ·  GET /transport/admin/fuel-board
// ═════════════════════════════════════════════════════════════════════════════
const VEHICLE_TYPE_LABEL = { bus: 'School Bus', mini_bus: 'Mini Bus', van: 'Van', car: 'Car', tempo: 'Tempo Traveller', other: 'Other' };

exports.fuelBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const { vehicle = '', driver = '', search = '', page = 1, limit = 5 } = req.query;
        const w = windowFrom(req.query, 30);
        const prev = { from: new Date(w.from.getTime() - (w.to - w.from)), to: w.from };

        const [logs, prevLogs, vehicles, staff] = await Promise.all([
            FuelLog.find({ school, date: { $gte: w.from, $lt: w.to } }).sort('-date').lean(),
            FuelLog.find({ school, date: { $gte: prev.from, $lt: prev.to } }).select('litres totalCost mileage vehicle').lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber vehicleType photo fuelType mileage odometer manufacturer').lean(),
            TransportStaff.find({ school, isActive: true }).select('name photo staffType').lean(),
        ]);
        const vehicleById = new Map(vehicles.map((v) => [String(v._id), v]));
        const staffById = new Map(staff.map((s) => [String(s._id), s]));

        const sum = (rows, k) => rows.reduce((s, r) => s + num(r[k]), 0);
        const avgMileage = (rows) => {
            const m = rows.filter((r) => num(r.mileage) > 0);
            return m.length ? round1(sum(m, 'mileage') / m.length) : 0;
        };
        const refuelled = new Set(logs.map((l) => String(l.vehicle)));
        const tiles = {
            expense: Math.round(sum(logs, 'totalCost')), expenseDelta: delta(sum(logs, 'totalCost'), sum(prevLogs, 'totalCost')),
            litres: Math.round(sum(logs, 'litres')), litresDelta: delta(sum(logs, 'litres'), sum(prevLogs, 'litres')),
            mileage: avgMileage(logs), mileageDelta: delta(avgMileage(logs), avgMileage(prevLogs)),
            refuelled: refuelled.size, fleet: vehicles.length, refuelledPct: pct(refuelled.size, vehicles.length),
        };

        // ── Trend: one point per day in the window ───────────────────────────
        const byDay = new Map();
        logs.forEach((l) => {
            const d = new Date(l.date);
            const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            const cur = byDay.get(k) || { at: new Date(d.getFullYear(), d.getMonth(), d.getDate()), litres: 0, cost: 0 };
            cur.litres += num(l.litres); cur.cost += num(l.totalCost);
            byDay.set(k, cur);
        });
        const trend = [...byDay.values()].sort((a, b) => a.at - b.at)
            .map((b) => ({ label: `${b.at.getDate()} ${MONTHS[b.at.getMonth()]}`, litres: Math.round(b.litres), cost: Math.round(b.cost), at: b.at }));

        // ── Distribution by vehicle type ─────────────────────────────────────
        const byType = new Map();
        logs.forEach((l) => {
            const v = vehicleById.get(String(l.vehicle));
            const key = v?.vehicleType || 'other';
            byType.set(key, (byType.get(key) || 0) + num(l.litres));
        });
        const typeRows = [...byType.entries()].sort((a, b) => b[1] - a[1]);
        const typePct = shares(typeRows.map(([, litres]) => litres));
        const distribution = typeRows.map(([k, litres], i) => ({
            key: k, label: VEHICLE_TYPE_LABEL[k] || k, litres: Math.round(litres), pct: typePct[i],
        }));

        // ── Top consumers ────────────────────────────────────────────────────
        const byVehicle = new Map();
        logs.forEach((l) => {
            const k = String(l.vehicle);
            const cur = byVehicle.get(k) || { litres: 0, cost: 0, count: 0, mileages: [] };
            cur.litres += num(l.litres); cur.cost += num(l.totalCost); cur.count++;
            if (num(l.mileage) > 0) cur.mileages.push(num(l.mileage));
            byVehicle.set(k, cur);
        });
        const top = [...byVehicle.entries()].map(([id, x]) => {
            const v = vehicleById.get(id);
            return {
                _id: id, vehicleNumber: v?.vehicleNumber || '—', manufacturer: v?.manufacturer || '', photo: v?.photo || '',
                litres: Math.round(x.litres), cost: Math.round(x.cost), fills: x.count,
                mileage: x.mileages.length ? round1(x.mileages.reduce((a, b) => a + b, 0) / x.mileages.length) : 0,
            };
        }).sort((a, b) => b.litres - a.litres);

        // ── Alerts. Every one is a measurement against a setting, not a guess.
        const alerts = [];
        const fleetAvg = tiles.mileage;
        top.forEach((v) => {
            if (v.mileage && v.mileage < (st.lowMileageThreshold || 4)) alerts.push({
                tone: 'bad', kind: 'low_mileage', title: 'Low Mileage Alert',
                detail: `${v.vehicleNumber} mileage dropped to ${v.mileage} km/l`, at: new Date(),
            });
            if (fleetAvg && v.mileage && v.mileage > 0) {
                const overPct = Math.round(((fleetAvg - v.mileage) / fleetAvg) * 100);
                if (overPct >= (st.fuelSpikePct || 20)) alerts.push({
                    tone: 'warn', kind: 'high_consumption', title: 'High Fuel Consumption',
                    detail: `${v.vehicleNumber} consumed ${overPct}% more than average`, at: new Date(),
                });
            }
        });
        // Three or more fills in 48 hours is a refuelling pattern worth a look.
        const fillsByVehicle = new Map();
        logs.forEach((l) => {
            const k = String(l.vehicle);
            if (!fillsByVehicle.has(k)) fillsByVehicle.set(k, []);
            fillsByVehicle.get(k).push(new Date(l.date));
        });
        fillsByVehicle.forEach((dates, k) => {
            const sorted = dates.sort((a, b) => a - b);
            for (let i = 2; i < sorted.length; i++) {
                if (sorted[i] - sorted[i - 2] <= 2 * 864e5) {
                    alerts.push({
                        tone: 'info', kind: 'unusual', title: 'Unusual Refueling',
                        detail: `${vehicleById.get(k)?.vehicleNumber || 'Vehicle'} refueled 3 times in 2 days`, at: sorted[i],
                    });
                    break;
                }
            }
        });
        const silentCut = daysAgo(st.missingFuelEntryDays || 7);
        const lastFill = new Map();
        const allLogs = await FuelLog.find({ school }).select('vehicle date').sort('-date').limit(2000).lean();
        allLogs.forEach((l) => { const k = String(l.vehicle); if (!lastFill.has(k)) lastFill.set(k, new Date(l.date)); });
        vehicles.forEach((v) => {
            const last = lastFill.get(String(v._id));
            if (!last || last < silentCut) alerts.push({
                tone: 'warn', kind: 'missing', title: 'Missing Fuel Entry',
                detail: `${v.vehicleNumber} has no fuel entry in the last ${st.missingFuelEntryDays || 7} days`,
                at: last || null,
            });
        });

        // ── Table ────────────────────────────────────────────────────────────
        const needle = String(search).trim().toLowerCase();
        const rows = logs.filter((l) => {
            if (vehicle && String(l.vehicle) !== String(vehicle)) return false;
            if (driver && String(l.driver) !== String(driver)) return false;
            if (needle) {
                const v = vehicleById.get(String(l.vehicle));
                const d = staffById.get(String(l.driver));
                if (![v?.vehicleNumber, d?.name, l.vendor, l.receipt].join(' ').toLowerCase().includes(needle)) return false;
            }
            return true;
        }).map((l) => ({
            ...l,
            vehicle: vehicleById.get(String(l.vehicle)) || null,
            driver: staffById.get(String(l.driver)) || null,
        }));
        const p = Math.max(1, +page), lim = Math.max(1, +limit);

        ok(res, {
            range: { from: w.from, to: w.to, days: w.days },
            tiles, trend, distribution, top: top.slice(0, 6),
            alerts: alerts.slice(0, 6),
            data: rows.slice((p - 1) * lim, p * lim), total: rows.length, page: p, pages: Math.max(1, Math.ceil(rows.length / lim)),
            filters: {
                vehicles: vehicles.map((v) => ({ value: v._id, label: v.vehicleNumber })),
                drivers: staff.filter((s) => s.staffType === 'driver').map((s) => ({ value: s._id, label: s.name })),
            },
        });
    } catch (e) { fail(res, e); }
};

/** Bulk upload of fuel entries, validated row by row like the assignment import. */
exports.bulkFuel = async (req, res) => {
    try {
        const school = req.schoolId;
        const { rows = [], dryRun = false } = req.body;
        if (!Array.isArray(rows) || !rows.length) return bad(res, 'Nothing to upload');
        if (rows.length > 1000) return bad(res, 'Upload at most 1000 rows at a time');
        const [vehicles, drivers] = await Promise.all([
            Vehicle.find({ school, isActive: true }).select('vehicleNumber registrationNumber odometer').lean(),
            TransportStaff.find({ school, isActive: true, staffType: 'driver' }).select('name employeeId').lean(),
        ]);
        const vByNumber = new Map(vehicles.flatMap((v) => [
            [String(v.vehicleNumber).trim().toLowerCase(), v],
            [String(v.registrationNumber).trim().toLowerCase(), v],
        ]));
        const dByName = new Map(drivers.flatMap((d) => [
            [String(d.name).trim().toLowerCase(), d],
            [String(d.employeeId).trim().toLowerCase(), d],
        ]));

        const results = [];
        const ready = [];
        rows.forEach((raw, i) => {
            const line = i + 1;
            const key = (k) => String(raw[k] ?? '').trim();
            const v = vByNumber.get(key('vehicle').toLowerCase());
            if (!v) return results.push({ line, ok: false, reason: `No vehicle matches "${key('vehicle') || '(blank)'}"` });
            const litres = +key('litres');
            if (!(litres > 0)) return results.push({ line, ok: false, reason: 'Litres must be a number above zero' });
            const when = key('date') ? new Date(key('date')) : new Date();
            if (Number.isNaN(when.getTime())) return results.push({ line, ok: false, reason: `"${key('date')}" is not a date` });
            const price = +key('pricePerLitre') || 0;
            const cost = +key('totalCost') || round1(litres * price);
            ready.push({
                school, vehicle: v._id, date: when, litres, pricePerLitre: price, totalCost: cost,
                odometer: +key('odometer') || 0, vendor: key('station') || key('vendor'), receipt: key('billNo') || key('receipt'),
                driver: dByName.get(key('driver').toLowerCase())?._id || null, filledBy: req.userId,
            });
            results.push({ line, ok: true, vehicle: v.vehicleNumber, litres });
        });

        if (!dryRun && ready.length) {
            // Written oldest-first so each entry's odometer delta is measured
            // against the fill before it, not after it.
            for (const doc of ready.sort((a, b) => a.date - b.date)) {
                const prev = await FuelLog.findOne({ school, vehicle: doc.vehicle, date: { $lt: doc.date } }).sort('-date').lean();
                const previousOdometer = prev?.odometer || 0;
                const distance = doc.odometer && previousOdometer ? Math.max(0, doc.odometer - previousOdometer) : 0;
                await FuelLog.create({
                    ...doc, previousOdometer, distance,
                    mileage: distance && doc.litres ? round1(distance / doc.litres) : 0,
                });
                if (doc.odometer) await Vehicle.updateOne({ _id: doc.vehicle, odometer: { $lt: doc.odometer } }, { $set: { odometer: doc.odometer } });
            }
            await logAudit(req, 'import', 'Fuel', null, `Uploaded ${ready.length} fuel entries`);
        }
        ok(res, { dryRun: !!dryRun, total: rows.length, created: dryRun ? 0 : ready.length, ready: ready.length, failed: results.filter((r) => !r.ok).length, results });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  MAINTENANCE  ·  GET /transport/admin/maintenance-board
// ═════════════════════════════════════════════════════════════════════════════
const MAINT_CATEGORY = {
    service: 'Routine Service', oil_change: 'Routine Service', engine: 'Repairs', brakes: 'Repairs',
    battery: 'Parts Replacement', ac: 'Repairs', tyres: 'Tyres', body: 'Repairs', other: 'Others',
};
const MAINT_GROUP_ORDER = ['Routine Service', 'Repairs', 'Parts Replacement', 'Tyres', 'Others'];

exports.maintenanceBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const { vehicle = '', serviceType = '', status = '', search = '', page = 1, limit = 5 } = req.query;
        const w = windowFrom(req.query, 30);
        const m0 = monthStart();
        const now = new Date();

        const [records, vehicles, monthly, lastMonth] = await Promise.all([
            MaintenanceRecord.find({ school }).sort('-createdAt').lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber vehicleType photo status odometer manufacturer').lean(),
            MaintenanceRecord.countDocuments({ school, scheduledDate: { $gte: m0 } }),
            MaintenanceRecord.countDocuments({ school, scheduledDate: { $gte: monthStart(1), $lt: m0 } }),
        ]);
        const vehicleById = new Map(vehicles.map((v) => [String(v._id), v]));

        /** A job is overdue when its scheduled day has passed and nobody closed it. */
        const isOverdue = (m) => ['scheduled', 'in_progress'].includes(m.status) && m.scheduledDate && new Date(m.scheduledDate) < now;
        const dueSoonCut = addDays(now, st.serviceDueDays || 7);

        const tiles = {
            vehicles: vehicles.length,
            active: vehicles.filter((v) => v.status === 'active').length,
            inMaintenance: vehicles.filter((v) => v.status === 'maintenance').length,
            scheduledThisMonth: monthly,
            scheduledDelta: delta(monthly, lastMonth),
            overdue: records.filter(isOverdue).length,
            inWorkshop: records.filter((m) => m.status === 'in_progress').length,
        };

        // ── Scheduled vs completed, six months ───────────────────────────────
        const buckets = new Map();
        for (let i = 5; i >= 0; i--) {
            const d = monthStart(i);
            buckets.set(`${d.getFullYear()}-${d.getMonth()}`, { label: MONTHS[d.getMonth()], scheduled: 0, completed: 0 });
        }
        records.forEach((m) => {
            const s = m.scheduledDate && new Date(m.scheduledDate);
            const c = m.completedDate && new Date(m.completedDate);
            if (s) { const b = buckets.get(`${s.getFullYear()}-${s.getMonth()}`); if (b) b.scheduled++; }
            if (c) { const b = buckets.get(`${c.getFullYear()}-${c.getMonth()}`); if (b) b.completed++; }
        });
        const overview = [...buckets.values()];

        // ── Cost breakdown ───────────────────────────────────────────────────
        const inWindow = records.filter((m) => {
            const at = m.completedDate || m.scheduledDate || m.createdAt;
            return at && new Date(at) >= w.from && new Date(at) < w.to;
        });
        const costByGroup = new Map();
        inWindow.forEach((m) => {
            const g = MAINT_CATEGORY[m.category] || 'Others';
            costByGroup.set(g, (costByGroup.get(g) || 0) + num(m.cost));
        });
        const totalCost = [...costByGroup.values()].reduce((a, b) => a + b, 0);
        const groups = MAINT_GROUP_ORDER.filter((g) => costByGroup.has(g));
        const groupPct = shares(groups.map((g) => costByGroup.get(g)));
        const breakdown = groups.map((g, i) => ({
            label: g, cost: Math.round(costByGroup.get(g)), pct: groupPct[i],
        }));

        // ── Per-vehicle service state ────────────────────────────────────────
        const openByVehicle = new Map();
        records.filter((m) => ['scheduled', 'in_progress'].includes(m.status)).forEach((m) => {
            const k = String(m.vehicle);
            const cur = openByVehicle.get(k);
            if (!cur || (m.scheduledDate && cur.scheduledDate && new Date(m.scheduledDate) < new Date(cur.scheduledDate))) openByVehicle.set(k, m);
        });
        const serviceState = (v) => {
            if (v.status === 'maintenance') return 'in_maintenance';
            const m = openByVehicle.get(String(v._id));
            if (!m || !m.scheduledDate) return 'up_to_date';
            const d = new Date(m.scheduledDate);
            if (d < now) return 'overdue';
            if (d <= dueSoonCut) return 'due_soon';
            return 'up_to_date';
        };
        const states = vehicles.map(serviceState);
        const serviceStatus = {
            upToDate: states.filter((s) => s === 'up_to_date').length,
            dueSoon: states.filter((s) => s === 'due_soon').length,
            overdue: states.filter((s) => s === 'overdue').length,
            inMaintenance: states.filter((s) => s === 'in_maintenance').length,
            fleet: vehicles.length,
            dueDays: st.serviceDueDays || 7,
        };

        // ── Upcoming services ────────────────────────────────────────────────
        const upcoming = records.filter((m) => ['scheduled', 'in_progress'].includes(m.status) && m.scheduledDate)
            .sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate))
            .slice(0, 6)
            .map((m) => {
                const v = vehicleById.get(String(m.vehicle));
                const d = new Date(m.scheduledDate);
                return {
                    _id: m._id, title: m.title, category: m.category,
                    vehicle: v ? { vehicleNumber: v.vehicleNumber, manufacturer: v.manufacturer } : null,
                    date: m.scheduledDate, day: d.getDate(), month: MONTHS[d.getMonth()].toUpperCase(),
                    state: d < now ? 'overdue' : d <= dueSoonCut ? 'due_soon' : 'scheduled',
                };
            });

        // ── Table ────────────────────────────────────────────────────────────
        const needle = String(search).trim().toLowerCase();
        const rows = records.filter((m) => {
            if (vehicle && String(m.vehicle) !== String(vehicle)) return false;
            if (serviceType && m.category !== serviceType) return false;
            if (status && (status === 'overdue' ? !isOverdue(m) : m.status !== status)) return false;
            if (needle) {
                const v = vehicleById.get(String(m.vehicle));
                if (![v?.vehicleNumber, m.title, m.description, m.vendor, m.category].join(' ').toLowerCase().includes(needle)) return false;
            }
            return true;
        }).map((m) => ({
            ...m,
            vehicle: vehicleById.get(String(m.vehicle)) || null,
            displayStatus: isOverdue(m) ? 'overdue' : m.status,
            categoryLabel: MAINT_CATEGORY[m.category] || 'Others',
        }));
        const p = Math.max(1, +page), lim = Math.max(1, +limit);

        ok(res, {
            range: { from: w.from, to: w.to },
            tiles, overview, breakdown, totalCost: Math.round(totalCost), serviceStatus, upcoming,
            data: rows.slice((p - 1) * lim, p * lim), total: rows.length, page: p, pages: Math.max(1, Math.ceil(rows.length / lim)),
            filters: {
                vehicles: vehicles.map((v) => ({ value: v._id, label: v.vehicleNumber })),
                serviceTypes: [...new Set(records.map((m) => m.category).filter(Boolean))],
            },
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  INCIDENTS  ·  GET /transport/admin/incident-board
// ═════════════════════════════════════════════════════════════════════════════
const INCIDENT_LABEL = {
    breakdown: 'Breakdown', accident: 'Accident', delay: 'Delay', behavior: 'Behavior Issue',
    route_deviation: 'Route Deviation', medical: 'Medical', safety: 'Safety', fire: 'Fire', other: 'Other',
};
const INCIDENT_TONE = {
    breakdown: 'red', accident: 'blue', delay: 'amber', behavior: 'purple',
    route_deviation: 'green', medical: 'pink', safety: 'amber', fire: 'red', other: 'slate',
};

exports.incidentBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { type = '', status = '', route = '', search = '', page = 1, limit = 8 } = req.query;
        const w = windowFrom(req.query, 30);
        const prev = { from: new Date(w.from.getTime() - (w.to - w.from)), to: w.from };

        const st = await getSettings(school);
        const [all, prevRows, vehicles, staff, routesRaw] = await Promise.all([
            TransportIncident.find({ school, date: { $gte: w.from, $lt: w.to } }).sort('-date').lean(),
            TransportIncident.find({ school, date: { $gte: prev.from, $lt: prev.to } }).select('status injuredCount').lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber manufacturer').lean(),
            TransportStaff.find({ school, isActive: true }).select('name photo staffType phone').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode color zone vehicle').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const vehicleById = new Map(vehicles.map((v) => [String(v._id), v]));
        const staffById = new Map(staff.map((s) => [String(s._id), s]));
        const routeByVehicle = new Map(routes.filter((r) => r.vehicle).map((r) => [String(r.vehicle), r]));

        const isOpen = (i) => ['reported', 'investigating'].includes(i.status);
        const isResolved = (i) => ['resolved', 'closed'].includes(i.status);
        const stale48 = all.filter((i) => isOpen(i) && Date.now() - new Date(i.createdAt || i.date).getTime() > 48 * 3600e3).length;

        const tiles = {
            total: all.length, totalDelta: delta(all.length, prevRows.length),
            open: all.filter(isOpen).length, stale48,
            resolved: all.filter(isResolved).length,
            resolvedDelta: delta(all.filter(isResolved).length, prevRows.filter((i) => ['resolved', 'closed'].includes(i.status)).length),
            injuries: all.reduce((s, i) => s + num(i.injuredCount), 0),
        };

        // ── By type ──────────────────────────────────────────────────────────
        const byType = new Map();
        all.forEach((i) => byType.set(i.type, (byType.get(i.type) || 0) + 1));
        const typeRows = [...byType.entries()].sort((a, b) => b[1] - a[1]);
        const typePct = shares(typeRows.map(([, n]) => n));
        const types = typeRows.map(([k, n], i) => ({
            key: k, label: INCIDENT_LABEL[k] || k, tone: INCIDENT_TONE[k] || 'slate', count: n, pct: typePct[i],
        }));

        // ── Trend, one point every few days across the window ────────────────
        const step = Math.max(1, Math.round(w.days / 7));
        const trend = [];
        for (let d = new Date(w.from); d < w.to; d = addDays(d, step)) {
            const next = addDays(d, step);
            trend.push({
                label: `${d.getDate()} ${MONTHS[d.getMonth()]}`,
                count: all.filter((i) => new Date(i.date) >= d && new Date(i.date) < next).length,
            });
        }

        const decorate = (i) => {
            const v = vehicleById.get(String(i.vehicle));
            const r = routeByVehicle.get(String(i.vehicle));
            return {
                ...i,
                typeLabel: INCIDENT_LABEL[i.type] || i.type, tone: INCIDENT_TONE[i.type] || 'slate',
                vehicle: v ? { _id: v._id, vehicleNumber: v.vehicleNumber } : null,
                driver: staffById.get(String(i.driver)) || null,
                route: r ? { _id: r._id, tag: r.tag, name: r.name, color: r.color } : null,
                locationText: i.location?.address || '',
            };
        };
        const decorated = all.map(decorate);

        const needle = String(search).trim().toLowerCase();
        const rows = decorated.filter((i) => {
            if (type && i.type !== type) return false;
            if (status && i.status !== status) return false;
            if (route && String(i.route?._id) !== String(route)) return false;
            if (needle && ![i.incidentCode, i.description, i.vehicle?.vehicleNumber, i.driver?.name, i.locationText, i.typeLabel]
                .join(' ').toLowerCase().includes(needle)) return false;
            return true;
        });
        const p = Math.max(1, +page), lim = Math.max(1, +limit);

        ok(res, {
            range: { from: w.from, to: w.to },
            tiles, types, trend, map: mapConfig(st),
            locations: decorated.filter((i) => i.location?.latitude != null)
                .map((i) => ({ _id: i._id, latitude: i.location.latitude, longitude: i.location.longitude, type: i.type, tone: i.tone, label: i.typeLabel, address: i.locationText })),
            data: rows.slice((p - 1) * lim, p * lim), total: rows.length, page: p, pages: Math.max(1, Math.ceil(rows.length / lim)),
            recent: decorated[0] || null,
            filters: {
                types: [...byType.keys()].map((k) => ({ value: k, label: INCIDENT_LABEL[k] || k })),
                routes: routes.map((r) => ({ value: r._id, label: `${r.tag} — ${r.name}` })),
            },
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  COMPLAINTS  ·  GET /transport/admin/complaint-board
// ═════════════════════════════════════════════════════════════════════════════
const COMPLAINT_LABEL = {
    driver_behavior: 'Driver Behavior', late_bus: 'Late Pickup', delay: 'Late Drop',
    route_deviation: 'Route Deviation', bus_condition: 'Vehicle Condition', safety: 'Safety Concern',
    lost_item: 'Lost Item', overcrowding: 'Overcrowding', other: 'Other',
};
const COMPLAINT_TONE = {
    driver_behavior: 'blue', late_bus: 'amber', delay: 'amber', route_deviation: 'purple',
    bus_condition: 'pink', safety: 'green', lost_item: 'slate', overcrowding: 'red', other: 'slate',
};

exports.complaintBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { status = '', category = '', route = '', search = '', page = 1, limit = 8 } = req.query;
        const w = windowFrom(req.query, 30);
        const prev = { from: new Date(w.from.getTime() - (w.to - w.from)), to: w.from };

        const [all, prevRows, routesRaw, vehicles] = await Promise.all([
            TransportComplaint.find({ school, createdAt: { $gte: w.from, $lt: w.to } }).sort('-createdAt').lean(),
            TransportComplaint.find({ school, createdAt: { $gte: prev.from, $lt: prev.to } }).select('status rating createdAt resolvedAt updatedAt').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode color zone').lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));
        const vehicleById = new Map(vehicles.map((v) => [String(v._id), v]));

        const peopleIds = [...new Set(all.flatMap((c) => [c.raisedBy, c.assignedTo, c.student]).filter(Boolean).map(String))];
        const people = peopleIds.length ? await User.find({ _id: { $in: peopleIds } }).select('name role profileImage').lean() : [];
        const personById = new Map(people.map((u) => [String(u._id), u]));
        const staff = await TransportStaff.find({ school, isActive: true }).select('name photo staffType').lean();
        const staffById = new Map(staff.map((s) => [String(s._id), s]));

        const isOpen = (c) => ['open', 'assigned', 'in_progress'].includes(c.status);
        const isResolved = (c) => ['resolved', 'closed'].includes(c.status);
        const rated = all.filter((c) => num(c.rating) > 0);
        const prevRated = prevRows.filter((c) => num(c.rating) > 0);
        const avg = (rows, pick) => (rows.length ? round1(rows.reduce((s, r) => s + num(pick(r)), 0) / rows.length) : 0);

        // Resolution time in days, measured on the rows that actually closed.
        const closedWith = (rows) => rows.filter(isResolved).map((c) => {
            const end = c.resolvedAt || c.updatedAt;
            return end ? (new Date(end) - new Date(c.createdAt)) / 864e5 : null;
        }).filter((d) => d != null && d >= 0);
        const resDays = closedWith(all);
        const prevResDays = closedWith(prevRows);
        const avgRes = resDays.length ? round1(resDays.reduce((a, b) => a + b, 0) / resDays.length) : 0;
        const prevAvgRes = prevResDays.length ? round1(prevResDays.reduce((a, b) => a + b, 0) / prevResDays.length) : 0;

        const open = all.filter(isOpen);
        const tiles = {
            total: all.length, totalDelta: delta(all.length, prevRows.length),
            open: open.length,
            openAssigned: open.filter((c) => c.assignedTo).length,
            openUnassigned: open.filter((c) => !c.assignedTo).length,
            resolved: all.filter(isResolved).length,
            resolvedDelta: delta(all.filter(isResolved).length, prevRows.filter(isResolved).length),
            rating: avg(rated, (c) => c.rating), ratingCount: rated.length,
            ratingDelta: rated.length && prevRated.length ? round1(avg(rated, (c) => c.rating) - avg(prevRated, (c) => c.rating)) : null,
            resolutionDays: avgRes, resolutionDelta: delta(avgRes, prevAvgRes),
        };

        // ── Trend: raised vs resolved ────────────────────────────────────────
        const step = Math.max(1, Math.round(w.days / 7));
        const trend = [];
        for (let d = new Date(w.from); d < w.to; d = addDays(d, step)) {
            const next = addDays(d, step);
            trend.push({
                label: `${d.getDate()} ${MONTHS[d.getMonth()]}`,
                raised: all.filter((c) => new Date(c.createdAt) >= d && new Date(c.createdAt) < next).length,
                resolved: all.filter((c) => { const e = c.resolvedAt || (isResolved(c) ? c.updatedAt : null); return e && new Date(e) >= d && new Date(e) < next; }).length,
            });
        }

        const byCat = new Map();
        all.forEach((c) => byCat.set(c.category, (byCat.get(c.category) || 0) + 1));
        const catRows = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
        const catPct = shares(catRows.map(([, n]) => n));
        const categories = catRows.map(([k, n], i) => ({
            key: k, label: COMPLAINT_LABEL[k] || k, tone: COMPLAINT_TONE[k] || 'slate', count: n, pct: catPct[i],
        }));

        const decorate = (c) => {
            const raiser = personById.get(String(c.raisedBy));
            const r = routeById.get(String(c.route));
            return {
                ...c,
                categoryLabel: COMPLAINT_LABEL[c.category] || c.category, tone: COMPLAINT_TONE[c.category] || 'slate',
                raisedBy: raiser ? { _id: raiser._id, name: raiser.name, role: raiser.role, photo: raiser.profileImage } : null,
                assignedTo: personById.get(String(c.assignedTo)) || staffById.get(String(c.assignedTo)) || null,
                route: r ? { _id: r._id, tag: r.tag, name: r.name, color: r.color } : null,
                vehicle: vehicleById.get(String(c.vehicle)) || null,
            };
        };
        const decorated = all.map(decorate);

        const needle = String(search).trim().toLowerCase();
        const rows = decorated.filter((c) => {
            if (status && c.status !== status) return false;
            if (category && c.category !== category) return false;
            if (route && String(c.route?._id) !== String(route)) return false;
            if (needle && ![c.complaintCode, c.subject, c.description, c.raisedBy?.name, c.route?.name, c.categoryLabel]
                .join(' ').toLowerCase().includes(needle)) return false;
            return true;
        });
        const p = Math.max(1, +page), lim = Math.max(1, +limit);

        ok(res, {
            range: { from: w.from, to: w.to },
            tiles, trend, categories,
            data: rows.slice((p - 1) * lim, p * lim), total: rows.length, page: p, pages: Math.max(1, Math.ceil(rows.length / lim)),
            recent: decorated.slice(0, 4),
            assignees: [
                ...people.filter((u) => ['school_admin', 'teacher'].includes(u.role)).map((u) => ({ value: u._id, label: u.name, kind: 'user' })),
                ...staff.map((s) => ({ value: s._id, label: s.name, kind: 'staff' })),
            ],
            filters: {
                categories: Object.entries(COMPLAINT_LABEL).map(([value, label]) => ({ value, label })),
                routes: routes.map((r) => ({ value: r._id, label: `${r.tag} — ${r.name}` })),
            },
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  FEE PLANS  ·  GET /transport/admin/fee-plan-board
// ═════════════════════════════════════════════════════════════════════════════
const FREQ_LABEL = { monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly', one_time: 'One Time' };
/** How many times a year a plan bills — what turns its amount into annual revenue. */
const FREQ_PER_YEAR = { monthly: 12, quarterly: 4, yearly: 1, one_time: 1 };

exports.feePlanBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', status = '', route = '', vehicleType = '', page = 1, limit = 8 } = req.query;
        const term = await currentTerm(school);

        const [plans, assignments, routesRaw, invoices, studentTotal] = await Promise.all([
            TransportFeePlan.find({ school, isActive: true }).sort('name').lean(),
            TransportAssignment.find({ school, status: 'active' }).select('feePlan route student pickupStop').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode color zone stops').lean(),
            TransportFeeInvoice.find({ school, createdAt: { $gte: monthStart(5) } }).select('netAmount paidAmount status dueDate createdAt feePlan').lean(),
            User.countDocuments({ school, role: 'student', isActive: true }),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));

        const byPlan = new Map();
        assignments.forEach((a) => { const k = String(a.feePlan); if (a.feePlan) byPlan.set(k, (byPlan.get(k) || 0) + 1); });
        const enrolled = assignments.filter((a) => a.feePlan).length;

        const decorate = (p) => {
            const r = routeById.get(String(p.route));
            const students = byPlan.get(String(p._id)) || 0;
            // A zone plan's "amount" is a band table; the headline figure is the
            // lowest band, and the screen shows the range beside it.
            const bands = [...(p.zones || [])].sort((a, b) => a.maxDistanceKm - b.maxDistanceKm);
            const amount = ['distance', 'zone'].includes(p.basis) && bands.length ? bands[0].amount : p.amount;
            return {
                ...p,
                // The route's tag when the plan is named after one ("R1 - South
                // Zone" → "R1"), otherwise an initial. Four plans all badged "R"
                // told a reader nothing.
                letter: (r?.tag
                    || (String(p.name || '').trim().match(/^([A-Za-z]+\d+)\b/) || [])[1]
                    || String(p.name || '?').trim().charAt(0).toUpperCase()
                    || '?').toUpperCase(),
                route: r ? { _id: r._id, tag: r.tag, name: r.name, color: r.color, zone: r.zone } : null,
                scope: p.zoneLabel || r?.zone || r?.name || (p.basis === 'flat' ? 'All Routes' : '—'),
                vehicleTypeLabel: p.vehicleType ? (VEHICLE_TYPE_LABEL[p.vehicleType] || (p.vehicleType === 'any' ? 'Bus / Van' : p.vehicleType)) : '—',
                frequencyLabel: FREQ_LABEL[p.frequency] || p.frequency,
                students,
                amount,
                amountRange: bands.length ? { min: bands[0].amount, max: bands[bands.length - 1].amount } : null,
                annual: amount * (FREQ_PER_YEAR[p.frequency] || 1) * students,
            };
        };
        const all = plans.map(decorate);

        const activePlans = all.filter((p) => p.status === 'active');
        const annual = activePlans.reduce((s, p) => s + p.annual, 0);
        // Last year's annual figure cannot be reconstructed from plans that have
        // since changed, so the comparison is made on billed invoices instead.
        const billedThisYear = invoices.filter((i) => new Date(i.createdAt) >= monthStart(11)).reduce((s, i) => s + num(i.netAmount), 0);
        const billedPrevYear = await TransportFeeInvoice.find({ school, createdAt: { $gte: monthStart(23), $lt: monthStart(11) } }).select('netAmount').lean();

        const tiles = {
            plans: activePlans.length,
            plansDelta: delta(activePlans.length, all.filter((p) => new Date(p.createdAt) < term.from && p.status === 'active').length),
            enrolled, enrolledPct: pct(enrolled, studentTotal), studentTotal,
            annual: Math.round(annual),
            annualDelta: delta(billedThisYear, billedPrevYear.reduce((s, i) => s + num(i.netAmount), 0)),
            pendingApprovals: all.filter((p) => p.approvalStatus === 'pending').length,
        };

        // ── Revenue trend, expected vs collected ─────────────────────────────
        const buckets = new Map();
        for (let i = 5; i >= 0; i--) {
            const d = monthStart(i);
            buckets.set(`${d.getFullYear()}-${d.getMonth()}`, { label: MONTHS[d.getMonth()], expected: 0, collected: 0 });
        }
        invoices.forEach((i) => {
            const d = new Date(i.createdAt);
            const b = buckets.get(`${d.getFullYear()}-${d.getMonth()}`);
            if (!b || i.status === 'cancelled') return;
            b.expected += num(i.netAmount); b.collected += num(i.paidAmount);
        });
        const revenueTrend = [...buckets.values()].map((b) => ({ ...b, expected: Math.round(b.expected), collected: Math.round(b.collected) }));

        // ── Student distribution by plan ─────────────────────────────────────
        const distribution = all.filter((p) => p.students > 0)
            .map((p, i) => ({ _id: p._id, label: p.route ? `${p.route.tag} - ${p.route.name}` : p.name, students: p.students, pct: pct(p.students, enrolled), color: p.route?.color || (i < ROUTE_COLORS.length ? ROUTE_COLORS[i] : ROUTE_OTHER) }))
            .sort((a, b) => b.students - a.students);

        // ── Collection status, counted in students not invoices ──────────────
        const thisMonth = monthStart();
        const monthInv = invoices.filter((i) => new Date(i.createdAt) >= thisMonth && i.status !== 'cancelled');
        const now = new Date();
        const statusOf = (i) => {
            if (num(i.paidAmount) >= num(i.netAmount) && num(i.netAmount) > 0) return 'paid';
            if (num(i.paidAmount) > 0) return 'partial';
            return i.dueDate && new Date(i.dueDate) < now ? 'overdue' : 'pending';
        };
        const collection = { paid: 0, partial: 0, pending: 0, overdue: 0 };
        monthInv.forEach((i) => { collection[statusOf(i)]++; });
        const collectionRows = Object.entries(collection);
        const collectionPct = shares(collectionRows.map(([, n]) => n));
        const collectionStatus = collectionRows.map(([k, n], i) => ({ key: k, students: n, pct: collectionPct[i] }));

        // ── Upcoming renewals ────────────────────────────────────────────────
        const renewals = all.filter((p) => p.renewalDate && new Date(p.renewalDate) >= now)
            .sort((a, b) => new Date(a.renewalDate) - new Date(b.renewalDate)).slice(0, 5)
            .map((p) => {
                const d = new Date(p.renewalDate);
                return {
                    _id: p._id, name: p.route ? `${p.route.tag} - ${p.route.name}` : p.name, students: p.students,
                    date: p.renewalDate, day: String(d.getDate()).padStart(2, '0'), month: MONTHS[d.getMonth()].toUpperCase(),
                    inDays: Math.ceil((d - now) / 864e5),
                };
            });

        const needle = String(search).trim().toLowerCase();
        const rows = all.filter((p) => {
            if (status && p.status !== status) return false;
            if (route && String(p.route?._id) !== String(route)) return false;
            if (vehicleType && p.vehicleType !== vehicleType) return false;
            if (needle && ![p.name, p.scope, p.vehicleTypeLabel, p.description].join(' ').toLowerCase().includes(needle)) return false;
            return true;
        });
        const pg = Math.max(1, +page), lim = Math.max(1, +limit);

        ok(res, {
            tiles, revenueTrend, distribution, collectionStatus, renewals,
            data: rows.slice((pg - 1) * lim, pg * lim), total: rows.length, page: pg, pages: Math.max(1, Math.ceil(rows.length / lim)),
            filters: {
                routes: routes.map((r) => ({ value: r._id, label: `${r.tag} — ${r.name}` })),
                vehicleTypes: Object.entries(VEHICLE_TYPE_LABEL).map(([value, label]) => ({ value, label })),
            },
        });
    } catch (e) { fail(res, e); }
};

/** Sign off (or send back) a plan that was drafted for approval. */
exports.approveFeePlan = async (req, res) => {
    try {
        const { action = 'approve', note = '' } = req.body;
        if (!['approve', 'reject'].includes(action)) return bad(res, 'Invalid action');
        const p = await TransportFeePlan.findOne({ _id: req.params.id, school: req.schoolId });
        if (!p) return bad(res, 'Plan not found', 404);
        if (p.approvalStatus !== 'pending') return bad(res, 'This plan is not awaiting approval');
        p.approvalStatus = action === 'approve' ? 'approved' : 'rejected';
        p.approvedBy = req.userId;
        p.approvedAt = new Date();
        if (action === 'reject') p.status = 'inactive';
        await p.save();
        await logAudit(req, action, 'FeePlan', p._id, `${action === 'approve' ? 'Approved' : 'Rejected'} fee plan ${p.name}${note ? ` — ${note}` : ''}`);
        ok(res, p);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  INVOICES  ·  GET /transport/admin/invoice-board
// ═════════════════════════════════════════════════════════════════════════════
/**
 * An invoice's live status.
 *
 * The stored `status` is stamped when the row is saved, so an invoice that fell
 * due yesterday still says "pending" until something touches it. Money screens
 * must not under-report arrears, so the window is recomputed on read.
 */
function invoiceStatus(i, now = new Date()) {
    if (i.status === 'cancelled') return 'cancelled';
    const net = num(i.netAmount), paid = num(i.paidAmount);
    if (paid >= net && net > 0) return 'paid';
    if (i.dueDate && new Date(i.dueDate) < now) return 'overdue';
    if (paid > 0) return 'partial';
    return 'pending';
}

exports.invoiceBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { status = '', route = '', month = '', search = '', page = 1, limit = 8 } = req.query;
        const w = windowFrom(req.query, 365);
        const now = new Date();

        const [invoices, prevInvoices, routesRaw, assignments] = await Promise.all([
            TransportFeeInvoice.find({ school, createdAt: { $gte: w.from, $lt: w.to } }).sort('-createdAt').lean(),
            TransportFeeInvoice.find({ school, createdAt: { $gte: new Date(w.from.getTime() - (w.to - w.from)), $lt: w.from } }).select('netAmount').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode color zone').lean(),
            TransportAssignment.find({ school }).select('student route').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));
        // An older invoice predates the route column; fall back to the student's
        // assignment so the Route column is not blank for historic rows.
        const routeByStudent = new Map(assignments.map((a) => [String(a.student), String(a.route)]));
        const students = await personIndex(invoices.map((i) => i.student));

        const decorate = (i) => {
            const rid = i.route || routeByStudent.get(String(i.student));
            const r = routeById.get(String(rid));
            return {
                ...i,
                liveStatus: invoiceStatus(i, now),
                due: Math.max(0, num(i.netAmount) - num(i.paidAmount)),
                student: students.get(String(i.student)) || { _id: i.student, name: '—' },
                route: r ? { _id: r._id, tag: r.tag, name: r.name, color: r.color, zone: r.zone } : null,
            };
        };
        const all = invoices.map(decorate);
        const live = all.filter((i) => i.liveStatus !== 'cancelled');

        const sumBy = (rows, f) => Math.round(rows.reduce((s, i) => s + f(i), 0));
        const invoiced = sumBy(live, (i) => num(i.netAmount));
        const paid = sumBy(live, (i) => num(i.paidAmount));
        const pending = sumBy(live.filter((i) => i.liveStatus === 'pending' || i.liveStatus === 'partial'), (i) => i.due);
        const overdue = sumBy(live.filter((i) => i.liveStatus === 'overdue'), (i) => i.due);

        const tiles = {
            invoiced, invoicedDelta: delta(invoiced, prevInvoices.reduce((s, i) => s + num(i.netAmount), 0)),
            paid, collectionRate: pct(paid, invoiced),
            pending, pendingPct: pct(pending, invoiced),
            overdue, overduePct: pct(overdue, invoiced),
            generated: live.length,
        };

        // ── Collection trend, six months ─────────────────────────────────────
        const buckets = new Map();
        for (let i = 5; i >= 0; i--) {
            const d = monthStart(i);
            buckets.set(`${d.getFullYear()}-${d.getMonth()}`, { label: MONTHS[d.getMonth()], paid: 0, pending: 0, overdue: 0, billed: 0 });
        }
        live.forEach((i) => {
            const d = new Date(i.createdAt);
            const b = buckets.get(`${d.getFullYear()}-${d.getMonth()}`);
            if (!b) return;
            b.billed += num(i.netAmount);
            b.paid += num(i.paidAmount);
            if (i.liveStatus === 'overdue') b.overdue += i.due; else b.pending += i.due;
        });
        const trend = [...buckets.values()].map((b) => ({
            label: b.label, paid: Math.round(b.paid), pending: Math.round(b.pending),
            overdue: Math.round(b.overdue), rate: pct(b.paid, b.billed),
        }));

        const counts = { paid: 0, pending: 0, partial: 0, overdue: 0 };
        live.forEach((i) => { counts[i.liveStatus] = (counts[i.liveStatus] || 0) + 1; });
        const statusCounts = [counts.paid, counts.pending + counts.partial, counts.overdue];
        const statusPct = shares(statusCounts);
        const distribution = [
            { key: 'paid', label: 'Paid', count: statusCounts[0], pct: statusPct[0] },
            { key: 'pending', label: 'Pending', count: statusCounts[1], pct: statusPct[1] },
            { key: 'overdue', label: 'Overdue', count: statusCounts[2], pct: statusPct[2] },
        ];

        const byRoute = new Map();
        live.forEach((i) => {
            const k = i.route ? String(i.route._id) : '__none';
            const cur = byRoute.get(k) || { route: i.route, amount: 0 };
            cur.amount += num(i.netAmount);
            byRoute.set(k, cur);
        });
        const topRoutes = [...byRoute.values()].filter((x) => x.route)
            .map((x) => ({ ...x.route, amount: Math.round(x.amount), pct: pct(x.amount, invoiced) }))
            .sort((a, b) => b.amount - a.amount).slice(0, 6);

        // ── Upcoming due, grouped by the day they fall due ───────────────────
        const dueGroups = new Map();
        live.filter((i) => ['pending', 'partial'].includes(i.liveStatus) && i.dueDate && new Date(i.dueDate) >= now)
            .forEach((i) => {
                const d = new Date(i.dueDate);
                const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
                const cur = dueGroups.get(k) || { date: d, day: String(d.getDate()).padStart(2, '0'), month: MONTHS[d.getMonth()].toUpperCase(), count: 0, amount: 0 };
                cur.count++; cur.amount += i.due;
                dueGroups.set(k, cur);
            });
        const upcomingDue = [...dueGroups.values()].sort((a, b) => a.date - b.date).slice(0, 4)
            .map((g) => ({ ...g, amount: Math.round(g.amount) }));

        const needle = String(search).trim().toLowerCase();
        const rows = all.filter((i) => {
            if (status && i.liveStatus !== status) return false;
            if (route && String(i.route?._id) !== String(route)) return false;
            if (month && String(i.period?.month) !== String(month)) return false;
            if (needle && ![i.invoiceNumber, i.student?.name, i.route?.name, i.period?.label].join(' ').toLowerCase().includes(needle)) return false;
            return true;
        });
        const p = Math.max(1, +page), lim = Math.max(1, +limit);

        ok(res, {
            range: { from: w.from, to: w.to },
            tiles, trend, distribution, topRoutes, upcomingDue,
            data: rows.slice((p - 1) * lim, p * lim), total: rows.length, page: p, pages: Math.max(1, Math.ceil(rows.length / lim)),
            filters: { routes: routes.map((r) => ({ value: r._id, label: `${r.tag} — ${r.name}` })), months: MONTHS.map((m, i) => ({ value: i + 1, label: m })) },
        });
    } catch (e) { fail(res, e); }
};

/**
 * Send payment reminders · POST /transport/admin/invoices/remind
 *
 * Either for the invoices picked, or for everything unpaid and due within the
 * school's reminder window. Nothing is sent for a paid or cancelled invoice,
 * and the count returned is what was actually sent.
 */
exports.remindInvoices = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const { invoices: ids = [], scope = 'due', message = '' } = req.body;
        const q = { school };
        if (ids.length) q._id = { $in: ids.map(String) };
        else if (scope === 'overdue') q.dueDate = { $lt: new Date() };
        else q.dueDate = { $lte: addDays(new Date(), st.reminderDaysBeforeDue || 3) };

        const rows = await TransportFeeInvoice.find(q).lean();
        const now = new Date();
        const owing = rows.filter((i) => ['pending', 'partial', 'overdue'].includes(invoiceStatus(i, now)));
        if (!owing.length) return ok(res, { sent: 0, message: 'Nothing is outstanding — no reminders were sent' });

        const students = await personIndex(owing.map((i) => i.student));
        let sent = 0;
        for (const inv of owing) {
            const s = students.get(String(inv.student));
            const targets = await withParents([inv.student]);
            if (!targets.length) continue;
            await notify({
                school, sender: req.userId, senderRole: req.userRole,
                title: '🚌 Transport fee reminder',
                body: message.trim() || `Transport fee ${inv.invoiceNumber} for ${inv.period?.label || ''} — ₹${Math.max(0, num(inv.netAmount) - num(inv.paidAmount))} is ${invoiceStatus(inv, now) === 'overdue' ? 'overdue' : 'due'}${inv.dueDate ? ` on ${new Date(inv.dueDate).toDateString()}` : ''}.`,
                recipients: targets,
                link: { type: 'transport.fees', entityId: inv._id },
            });
            await TransportFeeInvoice.updateOne({ _id: inv._id }, { $set: { lastReminderAt: new Date() }, $inc: { remindersSent: 1 } });
            sent++;
            if (s) { /* name resolved for the audit line below */ }
        }
        await logAudit(req, 'remind', 'Invoice', null, `Sent ${sent} transport fee reminders`);
        ok(res, { sent, considered: owing.length });
    } catch (e) { fail(res, e); }
};

/** A printable receipt/invoice — opened as HTML, which is what the browser prints. */
exports.invoiceReceipt = async (req, res) => {
    try {
        const school = req.schoolId;
        const inv = await TransportFeeInvoice.findOne({ _id: req.params.id, school }).lean();
        if (!inv) return bad(res, 'Invoice not found', 404);
        const [schoolDoc, st, students, plan, route] = await Promise.all([
            School.findById(school).select('name address logo').lean(),
            getSettings(school),
            personIndex([inv.student]),
            inv.feePlan ? TransportFeePlan.findById(inv.feePlan).select('name frequency').lean() : null,
            inv.route ? TransportRoute.findById(inv.route).select('name routeCode').lean() : null,
        ]);
        const s = students.get(String(inv.student));
        const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
        const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const row = (k, v) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
        const payments = (inv.payments || []).map((p) => `<tr><td>${new Date(p.paidAt).toDateString()}</td><td>${esc(p.mode)}</td><td>${esc(p.receiptNumber || '—')}</td><td class="r">${money(p.amount)}</td></tr>`).join('');

        res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html><head><meta charset="utf-8">
<title>${esc(inv.invoiceNumber)}</title><style>
*{box-sizing:border-box}body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;margin:0;padding:32px;background:#f8fafc}
.sheet{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:24px 0 8px;color:#475569}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #4f46e5;padding-bottom:16px}
.muted{color:#64748b;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #eef2f7;font-size:13px}
th{color:#64748b;font-weight:600;width:170px}.r{text-align:right}
.total{display:flex;justify-content:flex-end;gap:32px;margin-top:16px;font-size:16px;font-weight:700}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;background:#dcfce7;color:#166534}
.badge.due{background:#fee2e2;color:#991b1b}
@media print{body{background:#fff;padding:0}.sheet{border:0}}
</style></head><body><div class="sheet">
<div class="head"><div><h1>${esc(schoolDoc?.name || 'School')}</h1>
<div class="muted">${esc(schoolDoc?.address || '')}</div>
<div class="muted">Transport Office${st.contactPhone ? ` · ${esc(st.contactPhone)}` : ''}${st.contactEmail ? ` · ${esc(st.contactEmail)}` : ''}</div></div>
<div style="text-align:right"><div class="muted">TRANSPORT FEE RECEIPT</div><h1>${esc(inv.invoiceNumber)}</h1>
<span class="badge ${invoiceStatus(inv) === 'paid' ? '' : 'due'}">${invoiceStatus(inv).toUpperCase()}</span></div></div>
<h2>Student</h2><table>
${row('Name', s?.name || '—')}${row('Admission No.', s?.admissionNumber || '—')}${row('Class', s?.classLabel || '—')}
${row('Route', route ? `${route.name} (${route.routeCode})` : '—')}${row('Fee plan', plan ? `${plan.name} · ${FREQ_LABEL[plan.frequency] || plan.frequency}` : '—')}
</table>
<h2>Billing</h2><table>
${row('Period', inv.period?.label || '—')}${row('Amount', money(inv.amount))}
${inv.discount ? row('Discount', `− ${money(inv.discount)}`) : ''}${inv.lateFee ? row('Late fee', money(inv.lateFee)) : ''}
${row('Net payable', money(inv.netAmount))}${row('Due date', inv.dueDate ? new Date(inv.dueDate).toDateString() : '—')}
</table>
<h2>Payments</h2><table><thead><tr><th style="width:auto">Date</th><th style="width:auto">Mode</th><th style="width:auto">Receipt</th><th class="r" style="width:auto">Amount</th></tr></thead>
<tbody>${payments || '<tr><td colspan="4" class="muted">No payments recorded yet.</td></tr>'}</tbody></table>
<div class="total"><span>Paid ${money(inv.paidAmount)}</span><span>Balance ${money(Math.max(0, num(inv.netAmount) - num(inv.paidAmount)))}</span></div>
<p class="muted" style="margin-top:28px">Generated ${new Date().toLocaleString('en-IN')} — this is a computer-generated receipt.</p>
</div></body></html>`);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  REQUESTS  ·  GET /transport/admin/request-board
// ═════════════════════════════════════════════════════════════════════════════
const REQUEST_LABEL = {
    pickup_change: 'Pickup Change', drop_change: 'Drop Change', leave_request: 'Leave Request',
    special_trip: 'Special Trip', route_change: 'Route Change', stop_change: 'Stop Change',
    new_transport: 'New Transport', temporary_address: 'Temporary Address',
    permanent_address: 'Address Change', cancellation: 'Cancellation', other: 'Other',
};
const REQUEST_TONE = {
    pickup_change: 'blue', drop_change: 'green', leave_request: 'amber', special_trip: 'purple',
    route_change: 'pink', stop_change: 'blue', new_transport: 'green', temporary_address: 'amber',
    permanent_address: 'amber', cancellation: 'red', other: 'slate',
};

/** The one-line "Details" column: what was actually asked for. */
function requestDetail(r, routeName, stopNames) {
    const d = r.details || {};
    const when = d.fromDate ? new Date(d.fromDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
    const reason = d.reason ? ` (${d.reason})` : '';
    switch (r.requestType) {
        case 'pickup_change': return `Change pickup point to ${stopNames.pickup || d.address || 'a new stop'}`;
        case 'drop_change': return `Drop at ${stopNames.drop || d.address || 'a new stop'}`;
        case 'stop_change': return `Change stop to ${stopNames.pickup || stopNames.drop || d.address || 'a new stop'}`;
        case 'route_change': return `Move to ${routeName || 'another route'}`;
        case 'new_transport': return `New transport on ${routeName || 'a route'}`;
        case 'leave_request': return `Not required${when ? ` on ${when}` : ''}${reason}`;
        case 'special_trip': return d.note || d.reason || 'Special trip requested';
        case 'temporary_address': return `Temporary address${when ? ` from ${when}` : ''} — ${d.address || ''}`.trim();
        case 'permanent_address': return `Address change — ${d.address || ''}`.trim();
        case 'cancellation': return `Cancel transport${when ? ` from ${when}` : ''}${reason}`;
        default: return d.note || d.reason || '—';
    }
}

exports.requestBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { type = '', status = '', route = '', search = '', page = 1, limit = 8 } = req.query;
        const w = windowFrom(req.query, 30);
        const prev = { from: new Date(w.from.getTime() - (w.to - w.from)), to: w.from };

        const [all, prevRows, routesRaw] = await Promise.all([
            TransportRequest.find({ school, createdAt: { $gte: w.from, $lt: w.to } }).sort('-createdAt').lean(),
            TransportRequest.find({ school, createdAt: { $gte: prev.from, $lt: prev.to } }).select('status').lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode color zone stops').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));
        const students = await personIndex(all.map((r) => r.student));
        const requesterIds = [...new Set(all.map((r) => r.requestedBy).filter(Boolean).map(String))];
        const requesters = requesterIds.length ? await User.find({ _id: { $in: requesterIds } }).select('name role').lean() : [];
        const requesterById = new Map(requesters.map((u) => [String(u._id), u]));

        const stopName = (routeDoc, id) => (routeDoc?.stops || []).find((s) => String(s._id) === String(id))?.name || '';
        const decorate = (r) => {
            const rt = routeById.get(String(r.details?.route));
            return {
                ...r,
                typeLabel: REQUEST_LABEL[r.requestType] || r.requestType,
                tone: REQUEST_TONE[r.requestType] || 'slate',
                student: students.get(String(r.student)) || { _id: r.student, name: '—' },
                requestedBy: requesterById.get(String(r.requestedBy)) || null,
                route: rt ? { _id: rt._id, tag: rt.tag, name: rt.name, color: rt.color } : null,
                detailText: requestDetail(r, rt?.name, { pickup: stopName(rt, r.details?.pickupStop), drop: stopName(rt, r.details?.dropStop) }),
            };
        };
        const decorated = all.map(decorate);

        const count = (rows, s) => rows.filter((r) => r.status === s).length;
        const tiles = {
            total: all.length, totalDelta: delta(all.length, prevRows.length),
            approved: count(all, 'approved'), approvedPct: pct(count(all, 'approved'), all.length),
            pending: count(all, 'pending'), pendingPct: pct(count(all, 'pending'), all.length),
            rejected: count(all, 'rejected'), rejectedPct: pct(count(all, 'rejected'), all.length),
            requiresAction: all.filter((r) => r.requiresAction && r.status === 'pending').length,
            cancelled: count(all, 'cancelled'),
        };

        const step = Math.max(1, Math.round(w.days / 7));
        const trend = [];
        for (let d = new Date(w.from); d < w.to; d = addDays(d, step)) {
            const next = addDays(d, step);
            const slice = all.filter((r) => new Date(r.createdAt) >= d && new Date(r.createdAt) < next);
            trend.push({
                label: `${d.getDate()} ${MONTHS[d.getMonth()]}`,
                approved: count(slice, 'approved'), pending: count(slice, 'pending'),
                rejected: count(slice, 'rejected'), total: slice.length,
            });
        }

        const byType = new Map();
        all.forEach((r) => byType.set(r.requestType, (byType.get(r.requestType) || 0) + 1));
        const typeRows = [...byType.entries()].sort((a, b) => b[1] - a[1]);
        const typePct = shares(typeRows.map(([, n]) => n));
        const types = typeRows.map(([k, n], i) => ({
            key: k, label: REQUEST_LABEL[k] || k, tone: REQUEST_TONE[k] || 'slate', count: n, pct: typePct[i],
        }));

        const needle = String(search).trim().toLowerCase();
        const rows = decorated.filter((r) => {
            if (type && r.requestType !== type) return false;
            if (status && r.status !== status) return false;
            if (route && String(r.route?._id) !== String(route)) return false;
            if (needle && ![r.requestCode, r.student?.name, r.typeLabel, r.detailText].join(' ').toLowerCase().includes(needle)) return false;
            return true;
        });
        const p = Math.max(1, +page), lim = Math.max(1, +limit);

        ok(res, {
            range: { from: w.from, to: w.to },
            tiles, trend, types,
            data: rows.slice((p - 1) * lim, p * lim), total: rows.length, page: p, pages: Math.max(1, Math.ceil(rows.length / lim)),
            recent: decorated.slice(0, 4),
            filters: {
                types: Object.entries(REQUEST_LABEL).map(([value, label]) => ({ value, label })),
                routes: routes.map((r) => ({ value: r._id, label: `${r.tag} — ${r.name}` })),
            },
        });
    } catch (e) { fail(res, e); }
};

/** An admin raising a request on a family's behalf (the "New Request" button). */
exports.createRequest = async (req, res) => {
    try {
        const school = req.schoolId;
        const { student, requestType, details = {}, priority = 'normal', requiresAction = false } = req.body;
        if (!student) return bad(res, 'Pick a student');
        if (!requestType) return bad(res, 'Pick a request type');
        const u = await User.findOne({ _id: student, school, role: 'student' }).select('name').lean();
        if (!u) return bad(res, 'Student not found in this school', 404);
        const current = await TransportAssignment.findOne({ school, student, status: 'active' }).lean();
        const r = await TransportRequest.create({
            school, requestCode: await nextNumber(TransportRequest, school, 'REQ'),
            requestedBy: req.userId, student, requestType, details,
            currentAssignment: current?._id || null, priority, requiresAction,
        });
        await logAudit(req, 'create', 'Request', r._id, `Raised ${REQUEST_LABEL[requestType] || requestType} for ${u.name}`);
        ok(res, r);
    } catch (e) { fail(res, e); }
};

/** Flag/unflag a pending request as needing something before it can be decided. */
exports.flagRequest = async (req, res) => {
    try {
        const { requiresAction = true, note = '' } = req.body;
        const r = await TransportRequest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!r) return bad(res, 'Request not found', 404);
        if (r.status !== 'pending') return bad(res, 'Only a pending request can be flagged');
        r.requiresAction = !!requiresAction;
        r.actionNote = note;
        await r.save();
        await logAudit(req, 'flag', 'Request', r._id, `${requiresAction ? 'Flagged' : 'Cleared'} ${r.requestCode}${note ? ` — ${note}` : ''}`);
        ok(res, r);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  REPORTS  ·  GET /transport/admin/report-board
// ═════════════════════════════════════════════════════════════════════════════
/** The nine reports the screen offers, in the order it lists them. */
const REPORT_CATALOG = [
    { key: 'trip_summary', category: 'trips', name: 'Trip Summary Report', description: 'Total trips, completed vs scheduled, distance, duration.', icon: 'bus' },
    { key: 'route_performance', category: 'trips', name: 'Route Performance Report', description: 'On-time performance, delays, route-wise analysis.', icon: 'route' },
    { key: 'vehicle_utilization', category: 'trips', name: 'Vehicle Utilization Report', description: 'Usage, idle time, distance covered.', icon: 'gauge' },
    { key: 'fuel_consumption', category: 'fuel', name: 'Fuel Consumption Report', description: 'Fuel usage, cost analysis, mileage.', icon: 'fuel' },
    { key: 'maintenance', category: 'maintenance', name: 'Maintenance Report', description: 'Service history, upcoming due, costs.', icon: 'wrench' },
    { key: 'incident', category: 'incidents', name: 'Incident Report', description: 'Safety incidents, driver behavior, resolution status.', icon: 'alert' },
    { key: 'student_transport', category: 'students', name: 'Student Transport Report', description: 'Student ridership, pickup/drop statistics.', icon: 'students' },
    { key: 'fees_revenue', category: 'finance', name: 'Fees & Revenue Report', description: 'Collections, pending payments, route-wise revenue.', icon: 'rupee' },
    { key: 'compliance', category: 'compliance', name: 'Compliance Report', description: 'Documents, licenses, insurance, fitness status.', icon: 'shield' },
];

/**
 * Build one report's table.
 *
 * Every builder answers with the same shape — columns, rows, summary — so the
 * page renders any of the nine without knowing which, and CSV export is one
 * function rather than nine.
 */
async function buildReport(key, school, w, st, filters = {}) {
    const onTime = (t) => (t.delayMinutes || 0) <= (st.delayThresholdMin || 10);
    const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

    if (key === 'trip_summary' || key === 'route_performance' || key === 'vehicle_utilization') {
        const [trips, routesRaw, vehicles, staff] = await Promise.all([
            TransportTrip.find({ school, date: { $gte: w.from, $lt: w.to } }).lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode color zone distanceKm').lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber capacity odometer vehicleType').lean(),
            TransportStaff.find({ school, isActive: true }).select('name staffType').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));
        const vehicleById = new Map(vehicles.map((v) => [String(v._id), v]));
        const staffById = new Map(staff.map((s) => [String(s._id), s]));

        if (key === 'trip_summary') {
            const rows = trips.map((t) => ({
                tripCode: t.tripCode, date: fmtDay(t.date),
                route: routeById.get(String(t.route))?.name || '—',
                vehicle: vehicleById.get(String(t.vehicle))?.vehicleNumber || '—',
                driver: staffById.get(String(t.driver))?.name || '—',
                shift: t.shift === 'morning' ? 'Morning' : 'Afternoon',
                status: t.status,
                students: (t.studentAttendance || []).filter((s) => ['boarded', 'dropped'].includes(s.status)).length,
                delay: t.delayMinutes || 0,
                duration: t.startTime && t.endTime ? Math.round((new Date(t.endTime) - new Date(t.startTime)) / 60000) : '',
            }));
            return {
                columns: [['tripCode', 'Trip'], ['date', 'Date'], ['route', 'Route'], ['vehicle', 'Vehicle'], ['driver', 'Driver'],
                          ['shift', 'Shift'], ['status', 'Status'], ['students', 'Students', 'r'], ['delay', 'Delay (min)', 'r'], ['duration', 'Duration (min)', 'r']],
                rows,
                summary: {
                    Trips: trips.length,
                    Completed: trips.filter((t) => t.status === 'completed').length,
                    Cancelled: trips.filter((t) => t.status === 'cancelled').length,
                    'On time %': pct(trips.filter(onTime).length, trips.length),
                },
            };
        }
        if (key === 'route_performance') {
            const rows = routes.map((r) => {
                const mine = trips.filter((t) => String(t.route) === String(r._id));
                const delays = mine.map((t) => t.delayMinutes || 0);
                return {
                    route: `${r.tag} — ${r.name}`, zone: r.zone || '—', trips: mine.length,
                    completed: mine.filter((t) => t.status === 'completed').length,
                    onTimePct: pct(mine.filter(onTime).length, mine.length),
                    avgDelay: delays.length ? round1(delays.reduce((a, b) => a + b, 0) / delays.length) : 0,
                    students: mine.reduce((s, t) => s + (t.studentAttendance || []).filter((x) => ['boarded', 'dropped'].includes(x.status)).length, 0),
                    distanceKm: r.distanceKm || 0,
                };
            }).filter((r) => r.trips > 0).sort((a, b) => b.onTimePct - a.onTimePct);
            return {
                columns: [['route', 'Route'], ['zone', 'Zone'], ['trips', 'Trips', 'r'], ['completed', 'Completed', 'r'],
                          ['onTimePct', 'On time %', 'r'], ['avgDelay', 'Avg delay (min)', 'r'], ['students', 'Students', 'r'], ['distanceKm', 'Distance (km)', 'r']],
                rows,
                summary: { Routes: rows.length, 'Fleet on time %': pct(trips.filter(onTime).length, trips.length) },
            };
        }
        const days = Math.max(1, Math.round((w.to - w.from) / 864e5));
        const rows = vehicles.map((v) => {
            const mine = trips.filter((t) => String(t.vehicle) === String(v._id));
            const km = mine.reduce((s, t) => s + (t.endOdometer && t.startOdometer ? Math.max(0, t.endOdometer - t.startOdometer) : 0), 0);
            const activeDays = new Set(mine.map((t) => new Date(t.date).toDateString())).size;
            const seats = mine.length ? Math.round(mine.reduce((s, t) => s + (t.studentAttendance || []).length, 0) / mine.length) : 0;
            return {
                vehicle: v.vehicleNumber, type: VEHICLE_TYPE_LABEL[v.vehicleType] || v.vehicleType,
                trips: mine.length, activeDays, idleDays: Math.max(0, days - activeDays),
                distanceKm: km, capacity: v.capacity || 0, avgSeatsUsed: seats,
                utilizationPct: pct(seats, v.capacity || 0),
            };
        }).sort((a, b) => b.trips - a.trips);
        return {
            columns: [['vehicle', 'Vehicle'], ['type', 'Type'], ['trips', 'Trips', 'r'], ['activeDays', 'Active days', 'r'],
                      ['idleDays', 'Idle days', 'r'], ['distanceKm', 'Distance (km)', 'r'], ['capacity', 'Capacity', 'r'],
                      ['avgSeatsUsed', 'Avg seats used', 'r'], ['utilizationPct', 'Utilisation %', 'r']],
            rows,
            summary: { Vehicles: rows.length, Trips: trips.length, 'Distance (km)': rows.reduce((s, r) => s + r.distanceKm, 0) },
        };
    }

    if (key === 'fuel_consumption') {
        const [logs, vehicles] = await Promise.all([
            FuelLog.find({ school, date: { $gte: w.from, $lt: w.to } }).lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber vehicleType fuelType').lean(),
        ]);
        const byId = new Map(vehicles.map((v) => [String(v._id), v]));
        const groups = new Map();
        logs.forEach((l) => {
            const k = String(l.vehicle);
            const cur = groups.get(k) || { litres: 0, cost: 0, fills: 0, distance: 0 };
            cur.litres += num(l.litres); cur.cost += num(l.totalCost); cur.fills++; cur.distance += num(l.distance);
            groups.set(k, cur);
        });
        const rows = [...groups.entries()].map(([id, g]) => {
            const v = byId.get(id);
            return {
                vehicle: v?.vehicleNumber || '—', type: VEHICLE_TYPE_LABEL[v?.vehicleType] || '—', fuelType: v?.fuelType || '—',
                fills: g.fills, litres: round1(g.litres), cost: Math.round(g.cost), distanceKm: Math.round(g.distance),
                mileage: g.litres ? round1(g.distance / g.litres) : 0,
                costPerKm: g.distance ? round1(g.cost / g.distance) : 0,
            };
        }).sort((a, b) => b.litres - a.litres);
        return {
            columns: [['vehicle', 'Vehicle'], ['type', 'Type'], ['fuelType', 'Fuel'], ['fills', 'Fills', 'r'], ['litres', 'Litres', 'r'],
                      ['cost', 'Cost (₹)', 'r'], ['distanceKm', 'Distance (km)', 'r'], ['mileage', 'Mileage (km/l)', 'r'], ['costPerKm', 'Cost / km (₹)', 'r']],
            rows,
            summary: { Litres: round1(rows.reduce((s, r) => s + r.litres, 0)), 'Cost (₹)': rows.reduce((s, r) => s + r.cost, 0) },
        };
    }

    if (key === 'maintenance') {
        const [records, vehicles] = await Promise.all([
            MaintenanceRecord.find({ school, $or: [{ scheduledDate: { $gte: w.from, $lt: w.to } }, { completedDate: { $gte: w.from, $lt: w.to } }] }).lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber').lean(),
        ]);
        const byId = new Map(vehicles.map((v) => [String(v._id), v]));
        const rows = records.map((m) => ({
            vehicle: byId.get(String(m.vehicle))?.vehicleNumber || '—',
            title: m.title, category: MAINT_CATEGORY[m.category] || m.category, maintenanceType: m.maintenanceType,
            scheduled: fmtDay(m.scheduledDate), completed: fmtDay(m.completedDate),
            odometer: m.odometer || 0, cost: Math.round(num(m.cost)), vendor: m.vendor || '—', status: m.status,
        })).sort((a, b) => String(b.scheduled).localeCompare(String(a.scheduled)));
        return {
            columns: [['vehicle', 'Vehicle'], ['title', 'Job'], ['category', 'Category'], ['maintenanceType', 'Type'],
                      ['scheduled', 'Scheduled'], ['completed', 'Completed'], ['odometer', 'Odometer', 'r'], ['cost', 'Cost (₹)', 'r'], ['vendor', 'Vendor'], ['status', 'Status']],
            rows,
            summary: { Jobs: rows.length, Completed: records.filter((m) => m.status === 'completed').length, 'Cost (₹)': rows.reduce((s, r) => s + r.cost, 0) },
        };
    }

    if (key === 'incident') {
        const [rowsRaw, vehicles, staff] = await Promise.all([
            TransportIncident.find({ school, date: { $gte: w.from, $lt: w.to } }).sort('-date').lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber').lean(),
            TransportStaff.find({ school, isActive: true }).select('name').lean(),
        ]);
        const v = new Map(vehicles.map((x) => [String(x._id), x.vehicleNumber]));
        const s = new Map(staff.map((x) => [String(x._id), x.name]));
        const rows = rowsRaw.map((i) => ({
            code: i.incidentCode, date: fmtDay(i.date), type: INCIDENT_LABEL[i.type] || i.type, severity: i.severity,
            vehicle: v.get(String(i.vehicle)) || '—', driver: s.get(String(i.driver)) || '—',
            location: i.location?.address || '—', injuries: i.injuredCount || 0,
            repairCost: Math.round(num(i.repairCost)), status: i.status,
        }));
        return {
            columns: [['code', 'Code'], ['date', 'Date'], ['type', 'Type'], ['severity', 'Severity'], ['vehicle', 'Vehicle'],
                      ['driver', 'Driver'], ['location', 'Location'], ['injuries', 'Injuries', 'r'], ['repairCost', 'Repair (₹)', 'r'], ['status', 'Status']],
            rows,
            summary: {
                Incidents: rows.length, Open: rowsRaw.filter((i) => ['reported', 'investigating'].includes(i.status)).length,
                Injuries: rows.reduce((a, r) => a + r.injuries, 0),
            },
        };
    }

    if (key === 'student_transport') {
        const [assignments, routesRaw, vehicles, trips] = await Promise.all([
            TransportAssignment.find({ school, status: 'active' }).lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode stops').lean(),
            Vehicle.find({ school, isActive: true }).select('vehicleNumber').lean(),
            TransportTrip.find({ school, date: { $gte: w.from, $lt: w.to } }).select('studentAttendance').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));
        const vById = new Map(vehicles.map((v) => [String(v._id), v.vehicleNumber]));
        const students = await personIndex(assignments.map((a) => a.student));
        const rides = new Map();
        trips.forEach((t) => (t.studentAttendance || []).forEach((s) => {
            const k = String(s.student);
            const cur = rides.get(k) || { offered: 0, taken: 0 };
            cur.offered++;
            if (['boarded', 'dropped'].includes(s.status)) cur.taken++;
            rides.set(k, cur);
        }));
        const rows = assignments.map((a) => {
            const st2 = students.get(String(a.student));
            const r = routeById.get(String(a.route));
            const stop = (id) => (r?.stops || []).find((x) => String(x._id) === String(id))?.name || '—';
            const ride = rides.get(String(a.student)) || { offered: 0, taken: 0 };
            return {
                student: st2?.name || '—', admissionNumber: st2?.admissionNumber || '—', class: st2?.classLabel || '—',
                route: r ? `${r.tag} — ${r.name}` : '—', pickup: stop(a.pickupStop), drop: stop(a.dropStop),
                vehicle: vById.get(String(a.vehicle)) || '—', seat: a.seatNumber || '—',
                trips: ride.offered, boarded: ride.taken, boardingPct: pct(ride.taken, ride.offered),
            };
        }).sort((a, b) => a.student.localeCompare(b.student));
        return {
            columns: [['student', 'Student'], ['admissionNumber', 'Admission No.'], ['class', 'Class'], ['route', 'Route'],
                      ['pickup', 'Pickup'], ['drop', 'Drop'], ['vehicle', 'Vehicle'], ['seat', 'Seat'],
                      ['trips', 'Trips', 'r'], ['boarded', 'Boarded', 'r'], ['boardingPct', 'Boarding %', 'r']],
            rows,
            summary: { Students: rows.length, Routes: new Set(rows.map((r) => r.route)).size },
        };
    }

    if (key === 'fees_revenue') {
        const [invoices, routesRaw, assignments] = await Promise.all([
            TransportFeeInvoice.find({ school, createdAt: { $gte: w.from, $lt: w.to } }).lean(),
            TransportRoute.find({ school, isActive: true }).select('name routeCode').lean(),
            TransportAssignment.find({ school }).select('student route').lean(),
        ]);
        const routes = tagRoutes(routesRaw);
        const routeById = new Map(routes.map((r) => [String(r._id), r]));
        const routeByStudent = new Map(assignments.map((a) => [String(a.student), String(a.route)]));
        const students = await personIndex(invoices.map((i) => i.student));
        const now = new Date();
        const rows = invoices.map((i) => {
            const st2 = students.get(String(i.student));
            const r = routeById.get(String(i.route || routeByStudent.get(String(i.student))));
            return {
                invoice: i.invoiceNumber, student: st2?.name || '—', class: st2?.classLabel || '—',
                route: r ? `${r.tag} — ${r.name}` : '—', period: i.period?.label || '—',
                billed: Math.round(num(i.netAmount)), paid: Math.round(num(i.paidAmount)),
                due: Math.round(Math.max(0, num(i.netAmount) - num(i.paidAmount))),
                dueDate: fmtDay(i.dueDate), status: invoiceStatus(i, now),
            };
        }).sort((a, b) => String(a.student).localeCompare(String(b.student)));
        return {
            columns: [['invoice', 'Invoice'], ['student', 'Student'], ['class', 'Class'], ['route', 'Route'], ['period', 'Period'],
                      ['billed', 'Billed (₹)', 'r'], ['paid', 'Paid (₹)', 'r'], ['due', 'Due (₹)', 'r'], ['dueDate', 'Due date'], ['status', 'Status']],
            rows,
            summary: {
                Invoices: rows.length, 'Billed (₹)': rows.reduce((s, r) => s + r.billed, 0),
                'Collected (₹)': rows.reduce((s, r) => s + r.paid, 0), 'Outstanding (₹)': rows.reduce((s, r) => s + r.due, 0),
            },
        };
    }

    if (key === 'compliance') {
        const [vehicles, staff] = await Promise.all([
            Vehicle.find({ school, isActive: true }).lean(),
            TransportStaff.find({ school, isActive: true }).lean(),
        ]);
        const now = new Date();
        const rows = [];
        vehicles.forEach((v) => complianceFor(v, st.documentReminderDays).docs.forEach((d) => rows.push({
            subject: v.vehicleNumber, kind: 'Vehicle', document: d.label,
            expiry: fmtDay(d.date), daysLeft: Math.ceil((new Date(d.date) - now) / 864e5),
            state: d.state === 'ok' ? 'Valid' : d.state === 'due' ? 'Expiring' : 'Expired',
        })));
        staff.forEach((s) => staffDocuments(s, st.licenceReminderDays).forEach((d) => rows.push({
            subject: s.name, kind: staffRole(s), document: d.label,
            expiry: d.expiry ? fmtDay(d.expiry) : '—',
            daysLeft: d.expiry ? Math.ceil((new Date(d.expiry) - now) / 864e5) : '',
            state: { ok: 'Valid', due: 'Expiring', expired: 'Expired', verified: 'Verified', missing: 'Not on file' }[d.state],
        })));
        rows.sort((a, b) => (a.daysLeft === '' ? 1 : b.daysLeft === '' ? -1 : a.daysLeft - b.daysLeft));
        return {
            columns: [['subject', 'Vehicle / Person'], ['kind', 'Type'], ['document', 'Document'], ['expiry', 'Valid till'], ['daysLeft', 'Days left', 'r'], ['state', 'Status']],
            rows,
            summary: {
                Documents: rows.length, Expired: rows.filter((r) => r.state === 'Expired').length,
                Expiring: rows.filter((r) => r.state === 'Expiring').length,
                'Not on file': rows.filter((r) => r.state === 'Not on file').length,
            },
        };
    }
    throw new Error(`Unknown report "${key}"`);
}

exports.reportBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const w = windowFrom(req.query, 30);
        const prev = { from: new Date(w.from.getTime() - (w.to - w.from)), to: w.from };

        const [trips, prevTrips, fuel, prevFuel, maint, prevMaint, incidents, prevIncidents, routesRaw, saved] = await Promise.all([
            TransportTrip.find({ school, date: { $gte: w.from, $lt: w.to } }).select('date status delayMinutes route studentAttendance').lean(),
            TransportTrip.find({ school, date: { $gte: prev.from, $lt: prev.to } }).select('status studentAttendance').lean(),
            FuelLog.find({ school, date: { $gte: w.from, $lt: w.to } }).select('date litres totalCost').lean(),
            FuelLog.find({ school, date: { $gte: prev.from, $lt: prev.to } }).select('litres').lean(),
            MaintenanceRecord.countDocuments({ school, createdAt: { $gte: w.from, $lt: w.to } }),
            MaintenanceRecord.countDocuments({ school, createdAt: { $gte: prev.from, $lt: prev.to } }),
            TransportIncident.countDocuments({ school, date: { $gte: w.from, $lt: w.to } }),
            TransportIncident.countDocuments({ school, date: { $gte: prev.from, $lt: prev.to } }),
            TransportRoute.find({ school, isActive: true }).select('name routeCode color zone').lean(),
            TransportReport.find({ school }).sort('-createdAt').limit(40).populate('generatedBy', 'name').lean(),
        ]);
        const routes = tagRoutes(routesRaw);

        const ridersOf = (rows) => rows.reduce((s, t) => s + (t.studentAttendance || []).filter((x) => ['boarded', 'dropped'].includes(x.status)).length, 0);
        const litres = fuel.reduce((s, f) => s + num(f.litres), 0);
        const tiles = {
            trips: trips.length, tripsDelta: delta(trips.length, prevTrips.length),
            students: ridersOf(trips), studentsDelta: delta(ridersOf(trips), ridersOf(prevTrips)),
            fuel: Math.round(litres), fuelDelta: delta(litres, prevFuel.reduce((s, f) => s + num(f.litres), 0)),
            maintenance: maint, maintenanceDelta: delta(maint, prevMaint),
            incidents, incidentsDelta: delta(incidents, prevIncidents),
        };

        // ── Trips scheduled vs completed, and fuel, across the window ────────
        const step = Math.max(1, Math.round(w.days / 7));
        const tripsOverview = [];
        const fuelTrend = [];
        for (let d = new Date(w.from); d < w.to; d = addDays(d, step)) {
            const next = addDays(d, step);
            const slice = trips.filter((t) => new Date(t.date) >= d && new Date(t.date) < next);
            const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
            tripsOverview.push({ label, scheduled: slice.length, completed: slice.filter((t) => t.status === 'completed').length });
            fuelTrend.push({ label, litres: Math.round(fuel.filter((f) => new Date(f.date) >= d && new Date(f.date) < next).reduce((s, f) => s + num(f.litres), 0)) });
        }

        const routePerformance = routes.map((r) => {
            const mine = trips.filter((t) => String(t.route) === String(r._id));
            return {
                tag: r.tag, name: r.name, color: r.color,
                onTimePct: pct(mine.filter((t) => (t.delayMinutes || 0) <= st.delayThresholdMin).length, mine.length),
                trips: mine.length,
            };
        }).filter((r) => r.trips > 0).sort((a, b) => b.onTimePct - a.onTimePct);

        ok(res, {
            range: { from: w.from, to: w.to, days: w.days },
            tiles, tripsOverview, fuelTrend, routePerformance,
            catalog: REPORT_CATALOG,
            scheduled: saved.filter((r) => r.schedule?.frequency).map((r) => ({
                _id: r._id, name: r.name, reportType: r.reportType, format: r.format, status: r.status,
                frequency: r.schedule.frequency, recipients: r.schedule.recipients,
                lastRunAt: r.schedule.lastRunAt, nextRunAt: r.schedule.nextRunAt,
            })),
            recent: saved.filter((r) => r.generatedAt).slice(0, 8).map((r) => ({
                _id: r._id, name: r.name, reportType: r.reportType,
                category: r.category, format: r.format, status: r.status,
                generatedAt: r.generatedAt, generatedBy: r.generatedBy?.name || 'System', rowCount: r.rowCount,
            })),
        });
    } catch (e) { fail(res, e); }
};

/** Run a report now and keep a record of the run. */
exports.generateReport = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const { reportType, format = 'pdf', name = '', filters = {} } = req.body;
        const meta = REPORT_CATALOG.find((r) => r.key === reportType);
        if (!meta) return bad(res, 'Pick one of the available reports');
        const w = windowFrom(req.body, 30);
        const built = await buildReport(reportType, school, w, st, filters);
        const row = await TransportReport.create({
            school, name: name.trim() || meta.name, reportType, category: meta.category, format,
            range: { preset: req.body.preset || 'custom', from: w.from, to: w.to }, filters,
            status: 'completed', generatedAt: new Date(), generatedBy: req.userId,
            rowCount: built.rows.length, summary: built.summary,
        });
        await logAudit(req, 'generate', 'Report', row._id, `Generated ${meta.name} (${built.rows.length} rows)`);
        ok(res, { report: row, ...built, meta, range: { from: w.from, to: w.to } });
    } catch (e) { fail(res, e); }
};

/**
 * Download a report.
 *
 * It is rebuilt from live data rather than served from a stored file, so a link
 * kept in an inbox can never hand someone last month's numbers under this
 * month's heading.
 */
exports.downloadReport = async (req, res) => {
    try {
        const school = req.schoolId;
        const st = await getSettings(school);
        const saved = await TransportReport.findOne({ _id: req.params.id, school }).lean();
        if (!saved) return bad(res, 'Report not found', 404);
        const meta = REPORT_CATALOG.find((r) => r.key === saved.reportType);
        const w = { from: new Date(saved.range?.from || daysAgo(30)), to: new Date(saved.range?.to || Date.now()) };
        w.days = Math.max(1, Math.round((w.to - w.from) / 864e5));
        const built = await buildReport(saved.reportType, school, w, st, saved.filters || {});
        const fmt = String(req.query.format || saved.format || 'csv').toLowerCase();
        const fileBase = `${saved.name.replace(/[^\w.-]+/g, '_')}_${new Date().toISOString().slice(0, 10)}`;

        if (fmt === 'csv' || fmt === 'excel') {
            const cell = (v) => {
                const s = String(v ?? '');
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const csv = [built.columns.map((c) => cell(c[1])).join(',')]
                .concat(built.rows.map((r) => built.columns.map((c) => cell(r[c[0]])).join(','))).join('\n');
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
            return res.send(`﻿${csv}`);
        }

        const schoolDoc = await School.findById(school).select('name').lean();
        const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html><head><meta charset="utf-8">
<title>${esc(saved.name)}</title><style>
body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;margin:0;padding:28px;background:#f8fafc}
.sheet{max-width:1100px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px}
h1{font-size:19px;margin:0 0 2px}.muted{color:#64748b;font-size:12px}
.sum{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
.sum div{border:1px solid #e2e8f0;border-radius:10px;padding:8px 14px;min-width:120px}
.sum b{display:block;font-size:18px}table{width:100%;border-collapse:collapse;margin-top:10px}
th,td{padding:7px 9px;border-bottom:1px solid #eef2f7;text-align:left;font-size:12px}
th{background:#f8fafc;color:#475569;font-weight:600}td.r,th.r{text-align:right}
@media print{body{background:#fff;padding:0}.sheet{border:0}}
</style></head><body><div class="sheet">
<h1>${esc(saved.name)}</h1>
<div class="muted">${esc(schoolDoc?.name || '')} · ${esc(meta?.description || '')}</div>
<div class="muted">${w.from.toDateString()} → ${new Date(w.to.getTime() - 1).toDateString()} · ${built.rows.length} rows · generated ${new Date().toLocaleString('en-IN')}</div>
<div class="sum">${Object.entries(built.summary).map(([k, v]) => `<div><span class="muted">${esc(k)}</span><b>${esc(typeof v === 'number' ? v.toLocaleString('en-IN') : v)}</b></div>`).join('')}</div>
<table><thead><tr>${built.columns.map((c) => `<th class="${c[2] === 'r' ? 'r' : ''}">${esc(c[1])}</th>`).join('')}</tr></thead>
<tbody>${built.rows.map((r) => `<tr>${built.columns.map((c) => `<td class="${c[2] === 'r' ? 'r' : ''}">${esc(r[c[0]])}</td>`).join('')}</tr>`).join('')
 || `<tr><td colspan="${built.columns.length}" class="muted">Nothing in this window.</td></tr>`}</tbody></table>
</div></body></html>`);
    } catch (e) { fail(res, e); }
};

/** Create or update a standing report instruction. */
exports.saveScheduledReport = async (req, res) => {
    try {
        const { _id, name, reportType, format = 'pdf', frequency, weekday = 1, dayOfMonth = 1, recipients = [], preset = 'last_30_days', status = 'active' } = req.body;
        const meta = REPORT_CATALOG.find((r) => r.key === reportType);
        if (!meta) return bad(res, 'Pick one of the available reports');
        if (!['daily', 'weekly', 'monthly'].includes(frequency)) return bad(res, 'Pick how often it should run');
        const bad_ = recipients.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e).trim()));
        if (bad_.length) return bad(res, `Not an email address: ${bad_[0]}`);

        const next = (() => {
            const d = new Date();
            if (frequency === 'daily') return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), 1);
            if (frequency === 'weekly') {
                const delta_ = ((+weekday - d.getDay()) + 7) % 7 || 7;
                return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), delta_);
            }
            return new Date(d.getFullYear(), d.getMonth() + 1, Math.min(28, +dayOfMonth || 1));
        })();

        const payload = {
            school: req.schoolId, name: (name || meta.name).trim(), reportType, category: meta.category, format,
            range: { preset }, status,
            schedule: { frequency, weekday: +weekday, dayOfMonth: +dayOfMonth, recipients: recipients.map((e) => String(e).trim()), nextRunAt: next },
        };
        const row = _id
            ? await TransportReport.findOneAndUpdate({ _id, school: req.schoolId }, { $set: payload }, { new: true })
            : await TransportReport.create(payload);
        if (!row) return bad(res, 'Report not found', 404);
        await logAudit(req, _id ? 'update' : 'create', 'Report', row._id, `${_id ? 'Updated' : 'Scheduled'} ${row.name} (${frequency})`);
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.deleteReport = async (req, res) => {
    try {
        const row = await TransportReport.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Report not found', 404);
        await TransportReport.deleteOne({ _id: req.params.id, school: req.schoolId });
        await logAudit(req, 'delete', 'Report', req.params.id, `Removed report ${row.name}`);
        ok(res, { deleted: true });
    } catch (e) { fail(res, e); }
};

/** Pause / resume a standing report. */
exports.toggleReport = async (req, res) => {
    try {
        const row = await TransportReport.findOne({ _id: req.params.id, school: req.schoolId });
        if (!row) return bad(res, 'Report not found', 404);
        if (!row.schedule?.frequency) return bad(res, 'That report is not on a schedule');
        row.status = row.status === 'paused' ? 'active' : 'paused';
        await row.save();
        await logAudit(req, 'update', 'Report', row._id, `${row.status === 'paused' ? 'Paused' : 'Resumed'} ${row.name}`);
        ok(res, row);
    } catch (e) { fail(res, e); }
};
exports._buildReport = buildReport;
exports._REPORT_CATALOG = REPORT_CATALOG;

// ═════════════════════════════════════════════════════════════════════════════
//  SETTINGS  ·  GET/PUT /transport/admin/settings/full
// ═════════════════════════════════════════════════════════════════════════════
exports.settingsFull = async (req, res) => {
    try {
        const school = req.schoolId;
        const [st, schoolDoc, years, counts] = await Promise.all([
            getSettings(school),
            School.findById(school).select('name address phone email').lean(),
            AcademicYear.find({ school }).sort('-startDate').select('yearName startDate endDate status').lean(),
            Promise.all([
                Vehicle.countDocuments({ school, isActive: true }),
                TransportStaff.countDocuments({ school, isActive: true }),
                TransportRoute.countDocuments({ school, isActive: true }),
                TransportAssignment.countDocuments({ school, status: 'active' }),
                TransportTrip.countDocuments({ school }),
                VehicleLocation.countDocuments({ school }),
                TransportFeeInvoice.countDocuments({ school }),
                FuelLog.countDocuments({ school }),
                MaintenanceRecord.countDocuments({ school }),
            ]),
        ]);
        const [vehicles, staff, routes, assignments, trips, pings, invoices, fuel, maintenance] = counts;
        ok(res, {
            settings: st,
            school: {
                name: schoolDoc?.name || '', address: schoolDoc?.address || '',
                phone: schoolDoc?.phone || '', email: schoolDoc?.email || '',
            },
            academicYears: years,
            data: { vehicles, staff, routes, assignments, trips, pings, invoices, fuel, maintenance },
        });
    } catch (e) { fail(res, e); }
};

// Only these may be written from the Settings screen. Anything else in the body
// is ignored — a settings form must never be a way to set arbitrary columns.
const SETTABLE = [
    'contactEmail', 'contactPhone', 'officeAddress', 'timezone', 'currency', 'academicYear', 'distanceUnit',
    'timeFormat', 'allowParentTracking', 'autoAssignStudents', 'schoolLatitude', 'schoolLongitude',
    'defaultGeofenceRadiusM', 'geofenceRadiusM', 'deviationAlertM', 'maxStopsPerRoute', 'stopDwellMinutes',
    'averageSpeedKmph', 'requireStopCoordinates',
    'maxStudentsPerBus', 'allowOverbooking', 'documentReminderDays', 'serviceDueDays', 'serviceIntervalKm',
    'lowMileageThreshold', 'fuelSpikePct', 'missingFuelEntryDays',
    'licenceReminderDays', 'requirePoliceVerification', 'requireMedicalCertificate', 'maxTripsPerDriverPerDay', 'driverAppEnabled',
    'autoGenerateTrips', 'generateDaysAhead', 'skipWeekends', 'skipHolidays', 'requireTripApproval',
    'earlyArrivalBufferMin', 'delayThresholdMin', 'attendanceMethods', 'autoMarkAbsentAfterMin',
    'invoiceDueDay', 'autoGenerateInvoices', 'invoicePrefix', 'lateFeePerDay', 'lateFeeGraceDays',
    'siblingDiscountPct', 'reminderDaysBeforeDue', 'stopServiceOnNonPayment',
    'notifyOnTripStart', 'notifyOnBoard', 'notifyOnDrop', 'notifyOnReachSchool', 'notifyOnDelay',
    'notifyOnIncident', 'notifyOnMaintenanceDue', 'notifyOnInvoice', 'channels',
    'trackingIntervalSec', 'showLiveLocationToParents', 'showEtaToParents', 'storeLocationHistory',
    'locationRetentionDays', 'gpsProvider', 'mapProvider', 'mapApiKey',
    'parentCanRaiseRequest', 'parentCanRaiseComplaint', 'studentCanViewRoute', 'teacherCanViewTrips',
    'moduleName', 'primaryColor', 'showInMainMenu', 'autoBackup', 'backupFrequency',
];
// Numbers a school can get wrong in a way that breaks something downstream.
const RANGES = {
    delayThresholdMin: [1, 120], earlyArrivalBufferMin: [0, 60], maxStudentsPerBus: [1, 120],
    trackingIntervalSec: [5, 900], geofenceRadiusM: [20, 5000], deviationAlertM: [50, 20000],
    defaultGeofenceRadiusM: [20, 5000], documentReminderDays: [1, 365], licenceReminderDays: [1, 365],
    serviceDueDays: [1, 90], serviceIntervalKm: [100, 100000], lowMileageThreshold: [0.5, 40],
    fuelSpikePct: [1, 200], missingFuelEntryDays: [1, 90], invoiceDueDay: [1, 28],
    lateFeePerDay: [0, 10000], lateFeeGraceDays: [0, 60], siblingDiscountPct: [0, 100],
    reminderDaysBeforeDue: [0, 60], locationRetentionDays: [1, 3650], generateDaysAhead: [1, 30],
    maxStopsPerRoute: [1, 100], stopDwellMinutes: [0, 30], averageSpeedKmph: [5, 120],
    autoMarkAbsentAfterMin: [0, 240], maxTripsPerDriverPerDay: [1, 12],
};

exports.updateSettingsFull = async (req, res) => {
    try {
        const patch = {};
        for (const k of SETTABLE) if (req.body[k] !== undefined) patch[k] = req.body[k];
        if (!Object.keys(patch).length) return bad(res, 'Nothing to save');

        for (const [k, [lo, hi]] of Object.entries(RANGES)) {
            if (patch[k] === undefined || patch[k] === '' || patch[k] === null) continue;
            const v = Number(patch[k]);
            if (!Number.isFinite(v)) return bad(res, `${k} must be a number`);
            if (v < lo || v > hi) return bad(res, `${k} must be between ${lo} and ${hi}`);
            patch[k] = v;
        }
        if (patch.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.contactEmail)) return bad(res, 'That contact email does not look right');
        if (patch.primaryColor && !/^#[0-9a-f]{6}$/i.test(patch.primaryColor)) return bad(res, 'Pick a colour as a #rrggbb value');
        if (patch.attendanceMethods) {
            const allowed = ['rfid', 'qr', 'manual', 'face', 'biometric'];
            patch.attendanceMethods = [...new Set(patch.attendanceMethods)].filter((m) => allowed.includes(m));
            if (!patch.attendanceMethods.length) return bad(res, 'Keep at least one way of taking attendance');
        }
        if (patch.earlyArrivalBufferMin != null && patch.delayThresholdMin != null
            && +patch.earlyArrivalBufferMin > +patch.delayThresholdMin) {
            return bad(res, 'The early-arrival buffer cannot be larger than the late threshold');
        }
        if (patch.moduleName !== undefined && !String(patch.moduleName).trim()) return bad(res, 'The module needs a name');

        const s = await TransportSettings.findOneAndUpdate(
            { school: req.schoolId }, { $set: patch }, { new: true, upsert: true });
        await logAudit(req, 'update', 'Settings', s._id, `Updated transport settings (${Object.keys(patch).join(', ')})`);
        ok(res, s);
    } catch (e) { fail(res, e); }
};

/** Put every setting back to its shipped default. Records nothing else. */
exports.resetSettings = async (req, res) => {
    try {
        await TransportSettings.deleteOne({ school: req.schoolId });
        const s = await TransportSettings.create({ school: req.schoolId });
        await logAudit(req, 'reset', 'Settings', s._id, 'Reset transport settings to defaults');
        ok(res, s);
    } catch (e) { fail(res, e); }
};

/**
 * Export the module's data as JSON.
 *
 * Deliberately NOT a database dump: it is the records this school owns, with
 * their ids, so it can be read back or handed to an auditor. GPS pings are
 * excluded unless asked for — they are by far the largest table and almost
 * never what someone means by "export my transport data".
 */
exports.exportData = async (req, res) => {
    try {
        const school = req.schoolId;
        const want = String(req.query.include || 'vehicles,staff,routes,assignments,trips,fuel,maintenance,incidents,complaints,feePlans,invoices,requests')
            .split(',').map((s) => s.trim()).filter(Boolean);
        const sources = {
            vehicles: () => Vehicle.find({ school, isActive: true }).lean(),
            staff: () => TransportStaff.find({ school, isActive: true }).lean(),
            routes: () => TransportRoute.find({ school, isActive: true }).lean(),
            assignments: () => TransportAssignment.find({ school }).lean(),
            trips: () => TransportTrip.find({ school, date: { $gte: monthStart(11) } }).lean(),
            fuel: () => FuelLog.find({ school }).lean(),
            maintenance: () => MaintenanceRecord.find({ school }).lean(),
            incidents: () => TransportIncident.find({ school }).lean(),
            complaints: () => TransportComplaint.find({ school }).lean(),
            feePlans: () => TransportFeePlan.find({ school }).lean(),
            invoices: () => TransportFeeInvoice.find({ school }).lean(),
            requests: () => TransportRequest.find({ school }).lean(),
            settings: () => TransportSettings.findOne({ school }).lean(),
            locations: () => VehicleLocation.find({ school, recordedAt: { $gte: daysAgo(7) } }).lean(),
        };
        const out = { exportedAt: new Date(), school };
        for (const k of want) if (sources[k]) out[k] = await sources[k]();
        await logAudit(req, 'export', 'Settings', null, `Exported transport data (${want.join(', ')})`);
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="transport-export-${new Date().toISOString().slice(0, 10)}.json"`);
        res.send(JSON.stringify(out, null, 2));
    } catch (e) { fail(res, e); }
};

/** Stamp a backup. The file itself is the export above — this records that one was taken. */
exports.markBackup = async (req, res) => {
    try {
        const s = await TransportSettings.findOneAndUpdate(
            { school: req.schoolId }, { $set: { lastBackupAt: new Date() } }, { new: true, upsert: true });
        await logAudit(req, 'backup', 'Settings', s._id, 'Recorded a transport data backup');
        ok(res, s);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ACTIVITY LOG  ·  GET /transport/admin/activity
// ═════════════════════════════════════════════════════════════════════════════
exports.activityBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { entityType = '', actionType = '', user = '', search = '', page = 1, limit = 25 } = req.query;
        const w = windowFrom(req.query, 30);
        const q = { school, createdAt: { $gte: w.from, $lt: w.to } };
        if (entityType) q.entityType = entityType;
        if (actionType) q.actionType = actionType;
        if (user) q.user = user;

        const [rows, total, everything] = await Promise.all([
            TransportAuditLog.find(q).sort('-createdAt').skip((Math.max(1, +page) - 1) * +limit).limit(+limit).populate('user', 'name role').lean(),
            TransportAuditLog.countDocuments(q),
            TransportAuditLog.find({ school, createdAt: { $gte: w.from, $lt: w.to } }).select('entityType actionType user').lean(),
        ]);
        const needle = String(search).trim().toLowerCase();
        const filtered = needle ? rows.filter((r) => [r.description, r.entityType, r.actionType, r.user?.name].join(' ').toLowerCase().includes(needle)) : rows;

        const actorIds = [...new Set(everything.map((r) => r.user).filter(Boolean).map(String))];
        const actors = actorIds.length ? await User.find({ _id: { $in: actorIds } }).select('name role').lean() : [];

        ok(res, {
            range: { from: w.from, to: w.to },
            data: filtered.map((r) => ({
                _id: r._id, at: r.createdAt, actionType: r.actionType, entityType: r.entityType, entityId: r.entityId,
                description: r.description, meta: r.meta,
                by: r.user ? { _id: r.user._id, name: r.user.name, role: r.user.role } : null,
                tone: /cancel|delete|reject|fail|reset/i.test(r.actionType) ? 'bad'
                    : /delay|pause|suspend|flag/i.test(r.actionType) ? 'warn'
                    : /complete|approve|pay|create|generate/i.test(r.actionType) ? 'good' : 'info',
            })),
            total, page: Math.max(1, +page), pages: Math.max(1, Math.ceil(total / +limit)),
            filters: {
                entityTypes: [...new Set(everything.map((r) => r.entityType))].sort(),
                actionTypes: [...new Set(everything.map((r) => r.actionType))].sort(),
                users: actors.map((u) => ({ value: u._id, label: u.name })),
            },
        });
    } catch (e) { fail(res, e); }
};
