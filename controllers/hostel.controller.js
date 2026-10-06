'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hostel Management — administrative controller (spec §3–§29).
//
//  Mounted behind allowModuleAdmin('hostel'), so every handler here has already
//  passed: school module flag → designation permission → administrative level.
//  A warden who is not a school admin reaches the same handlers but sees only
//  the hostels they are assigned to — scopedFilter() applies that narrowing.
//
//  Nothing about students, employees, payments, notifications, documents or
//  assets is re-implemented: those come from User/StudentProfile, TeacherProfile,
//  FeeLedger, notifyService, the uploads pipeline and InventoryAsset.
// ─────────────────────────────────────────────────────────────────────────────
const Hostel                  = require('../models/Hostel');
const HostelBuilding          = require('../models/HostelBuilding');
const HostelFloor             = require('../models/HostelFloor');
const HostelRoom              = require('../models/HostelRoom');
const HostelBed               = require('../models/HostelBed');
const HostelAdmission         = require('../models/HostelAdmission');
const HostelAllocation        = require('../models/HostelAllocation');
const HostelAllocationHistory = require('../models/HostelAllocationHistory');
const HostelTransferRequest = require('../models/HostelTransferRequest');
const HostelAttendance        = require('../models/HostelAttendance');
const HostelLeave             = require('../models/HostelLeave');
const HostelOutpass           = require('../models/HostelOutpass');
const HostelVisitor           = require('../models/HostelVisitor');
const HostelStaffAssignment   = require('../models/HostelStaffAssignment');
const HostelMess              = require('../models/HostelMess');
const HostelMessMember        = require('../models/HostelMessMember');
const HostelMenu              = require('../models/HostelMenu');
const HostelMessAttendance    = require('../models/HostelMessAttendance');
const HostelMessExpense       = require('../models/HostelMessExpense');
const HostelFeePlan           = require('../models/HostelFeePlan');
const HostelFeeInvoice        = require('../models/HostelFeeInvoice');
const HostelComplaint         = require('../models/HostelComplaint');
const HostelMaintenance       = require('../models/HostelMaintenance');
const HostelAsset             = require('../models/HostelAsset');
const HostelMovement          = require('../models/HostelMovement');
const HostelIncident          = require('../models/HostelIncident');
const HostelDiscipline        = require('../models/HostelDiscipline');
const HostelDocument          = require('../models/HostelDocument');
const HostelSettings          = require('../models/HostelSettings');
const HostelAuditLog          = require('../models/HostelAuditLog');

const User           = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile        = require('../models/TeacherProfile');
const AcademicYear   = require('../models/AcademicYear');
const Class          = require('../models/Class');
const pool           = require('../db/pool');
const InventoryAsset = require('../models/InventoryAsset');

const crypto = require('crypto');
const qrcode = require('../utils/qrcode');
const { matrixToDataUri } = require('../utils/pngEncoder');
const svc = require('../services/hostelService');
const alloc = require('../services/hostelAllocation');
const overview = require('../services/hostelOverview');
const resident = require('../services/hostelResident');
const payments = require('../services/hostelPayments');

const { ok, bad, fail, toId, MONTHS, dayRange, monthStart, atTime, minutesBetween,
        getSettings, nextNumber, logAudit, diffFields, notifyStudentAndParents,
        notifyHostelStaff, postToLedger, studentSnapshot, scopedFilter, visibleHostelIds, systemRequest, signedFileUrl } = svc;

// A RuleError from the allocation engine is a 400 with its own message; anything
// else is a genuine 500.
const handle = (res, e) => (e instanceof alloc.RuleError || e instanceof payments.PaymentError || e.status === 400)
    ? bad(res, e.message, e.status || 400)
    : fail(res, e);

const num  = (v, d = 0) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));
const rx   = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const page = (q) => ({ page: Math.max(1, num(q.page, 1)), limit: Math.min(200, Math.max(1, num(q.limit, 20))) });
const paged = (rows, total, p) => ({ data: rows, total, page: p.page, pages: Math.ceil(total / p.limit) || 1 });

// Only the hostels this caller may write to. Returns true when unrestricted.
async function mayTouchHostel(req, hostelId) {
    const allowed = await visibleHostelIds(req);
    if (allowed === null) return true;
    return allowed.includes(String(hostelId));
}

// ═════════════════════════════════════════════════════════════════════════════
//  SETTINGS (spec §28) & META
// ═════════════════════════════════════════════════════════════════════════════
exports.getSettings = async (req, res) => {
    try { ok(res, await getSettings(req.schoolId)); } catch (e) { fail(res, e); }
};

/**
 * What each setting may hold. The screen already keeps to these; the server
 * checks again, because these rules are what every other endpoint obeys.
 */
const SETTING_RULES = (() => {
    const n = (min, max = 1e7, int = true) => ({ kind: 'number', min, max, int });
    const t = { kind: 'time' }; const b = { kind: 'bool' };
    const list = (allowed) => ({ kind: 'list', allowed });
    return {
        maxHostelCapacity: n(0, 100000), maxRoomCapacity: n(1, 100), enforceGenderRestriction: b, allowOvercapacityAllocation: b,
        autoAllocateOnApproval: b, allowTransferBetweenHostels: b, transferRequiresApproval: b, allowConcurrentLeaveAndOutpass: b,
        entryTime: t, exitTime: t, curfewTime: t, visitorFrom: t, visitorTo: t, outpassFrom: t, outpassTo: t,
        visitorDays: list(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']), maxOutpassHours: n(1, 72),
        lateReturnGraceMinutes: n(0, 600), lateReturnFine: n(0, 1e6, false), overdueAlertAfterMinutes: n(0, 1440), curfewViolationFine: n(0, 1e6, false),
        leaveRequiresParentApproval: b, outpassRequiresParentApproval: b, maxLeaveDaysPerRequest: n(1, 365), minLeaveNoticeDays: n(0, 60),
        maxOpenLeavesPerStudent: n(1, 20),
        attendanceSessions: list(['morning', 'evening', 'night', 'roll_call']), attendanceCorrectionNeedsApproval: b, attendanceCorrectionWindowDays: n(0, 90),
        autoGenerateMonthlyFees: b, feeDueDayOfMonth: n(1, 28), lateFeePerDay: n(0, 1e5, false), lateFeeGraceDays: n(0, 60),
        postToFeeLedger: b, securityDepositAmount: n(0, 1e7, false), chargeTeachers: b, prorateFirstMonth: b, autoApplyLateFees: b,
        rollCallIncludesTeachers: b,
        admissionRequiresApproval: b, allowStudentSelfApplication: b, allowParentApplication: b,
        requiredAdmissionDocuments: list(['admission', 'academic', 'id_proof', 'photo', 'medical', 'parent_authorization', 'undertaking', 'agreement', 'fee_receipt', 'other']),
        complaintSlaHours: n(1, 720), complaintAutoEscalate: b, complaintEscalateTo: { kind: 'user' },
        messAttendanceRequired: b, messLeaveNoticeHours: n(0, 168),
        notifyParentOnLeave: b, notifyParentOnOutpass: b, notifyParentOnLateReturn: b, notifyParentOnIncident: b,
        notifyParentOnDiscipline: b, notifyOnFeeDue: b, notifyOnVisitor: b, emailNotifications: b,
    };
})();
const LABEL = (k) => k.replace(/([A-Z])/g, ' $1').toLowerCase();

/** The body, checked against SETTING_RULES: { set } or { error }. */
async function checkSettings(req, body) {
    const set = {};
    for (const [k, v] of Object.entries(body || {})) {
        const rule = SETTING_RULES[k];
        if (!rule) continue;                                   // ids, timestamps, unknown keys: ignored
        if (rule.kind === 'bool') set[k] = !!v;
        else if (rule.kind === 'number') {
            const x = Number(v);
            if (v === '' || v === null || !Number.isFinite(x)) return { error: `The ${LABEL(k)} must be a number` };
            if (x < rule.min || x > rule.max) return { error: `The ${LABEL(k)} must be between ${rule.min} and ${rule.max}` };
            set[k] = rule.int ? Math.round(x) : x;
        } else if (rule.kind === 'time') {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) return { error: `The ${LABEL(k)} must be a time like 21:30` };
            set[k] = String(v);
        } else if (rule.kind === 'list') {
            const arr = Array.isArray(v) ? v.map(String) : [];
            const bad = arr.find((x) => !rule.allowed.includes(x));
            if (bad) return { error: `"${bad}" is not an option for the ${LABEL(k)}` };
            set[k] = [...new Set(arr)];
        } else if (rule.kind === 'user') {
            if (v && !await User.exists({ _id: v, school: req.schoolId })) return { error: 'The escalation owner was not found' };
            set[k] = v || null;
        }
    }
    if (set.attendanceSessions && !set.attendanceSessions.length) return { error: 'Keep at least one roll-call session' };
    return { set };
}

exports.updateSettings = async (req, res) => {
    try {
        // The settings govern every hostel in the school, so only the module's
        // admins change them — not a warden posted to one hostel.
        if (await visibleHostelIds(req) !== null) return bad(res, 'Only the hostel module\'s admins can change the hostel settings', 403);
        const before = await getSettings(req.schoolId);
        const { set: body, error } = await checkSettings(req, req.body);
        if (error) return bad(res, error);
        const s = await HostelSettings.findOneAndUpdate(
            { school: req.schoolId },
            { $set: { ...body, updatedBy: req.userId } },
            { new: true, upsert: true },
        );
        const d = diffFields(before, s, Object.keys(body));
        // A save that changed nothing is not an event in the log.
        if (Object.keys(d.after).length) {
            await logAudit(req, {
                action: 'update', entityType: 'HostelSettings', entityId: s._id,
                description: `Updated hostel settings (${Object.keys(d.after).length} change${Object.keys(d.after).length === 1 ? '' : 's'})`,
                before: d.before, after: d.after,
            });
        }
        ok(res, s);
    } catch (e) { fail(res, e); }
};

// Dropdown sources for every admin screen, in one round trip.
exports.getMeta = async (req, res) => {
    try {
        const school = req.schoolId;
        const allowed = await visibleHostelIds(req);
        const hostelQ = { school, isActive: true };
        if (allowed !== null) hostelQ._id = allowed.length ? { $in: allowed } : '__none__';

        const [hostels, buildings, floors, rooms, staff, years, messes, feePlans, classes] = await Promise.all([
            Hostel.find(hostelQ).select('name code hostelType gender capacity status').sort('name').lean(),
            HostelBuilding.find({ school, isActive: true }).select('name code hostel status floorCount').sort('name').lean(),
            HostelFloor.find({ school, isActive: true }).select('name floorNumber building hostel status').sort('floorNumber').lean(),
            HostelRoom.find({ school, isActive: true }).select('roomNumber code hostel building floor roomType capacity occupiedBeds status gender occupantType').sort('roomNumber').lean(),
            User.find({ school, role: { $in: ['teacher', 'school_admin'] }, isActive: true }).select('name email role phone').sort('name').lean(),
            AcademicYear.find({ school }).select('yearName status startDate endDate').sort('-startDate').lean(),
            HostelMess.find({ school, isActive: true }).select('name code hostels mealTimings').sort('name').lean(),
            HostelFeePlan.find({ school, isActive: true }).select('name feeType basis amount frequency hostel appliesTo').sort('name').lean(),
            // The classes a list can be filtered by: the ones students are actually
            // in. A class row exists per academic year, so listing every one would
            // offer "Class 9" once per year, all but one of them empty.
            pool.query(
                `SELECT c."_id", c."className", c."classNumber"
                   FROM "${Class.tableName}" c
                  WHERE c."school" = $1
                    AND EXISTS (SELECT 1 FROM "${StudentProfile.tableName}" p WHERE p."currentClass" = c."_id" AND p."school" = $1)
                  ORDER BY c."classNumber", c."className"`,
                [String(school)],
            ).then((r) => r.rows),
        ]);
        // On a posting, the dropdowns hold the caller's own hostels' structure only.
        const mine = (rows) => (allowed === null ? rows : rows.filter((r) => allowed.includes(String(r.hostel))));
        ok(res, { hostels, buildings: mine(buildings), floors: mine(floors), rooms: mine(rooms), staff, academicYears: years,
            messes: allowed === null ? messes : [], feePlans: allowed === null ? feePlans : [], classes });
    } catch (e) { fail(res, e); }
};

// Student picker — students who have no active allocation yet, for allocation screens.
/**
 * A student's first contact, from their parent's profile: the named guardian,
 * else the father, else the mother — whoever has a name on record.
 * The student profile carries no parent fields of its own.
 */
const GUARDIAN_SQL = (studentCol, schoolParam) => `
    LEFT JOIN LATERAL (
        SELECT CASE WHEN COALESCE(pp."guardian"->>'name', '') <> '' THEN pp."guardian"->>'name'
                    WHEN COALESCE(pp."father"->>'name', '') <> '' THEN pp."father"->>'name'
                    ELSE COALESCE(pp."mother"->>'name', pu."name") END AS "name",
               CASE WHEN COALESCE(pp."guardian"->>'name', '') <> '' THEN COALESCE(NULLIF(pp."guardian"->>'phone', ''), pu."phone")
                    WHEN COALESCE(pp."father"->>'name', '') <> '' THEN COALESCE(NULLIF(pp."father"->>'phone', ''), pu."phone")
                    ELSE COALESCE(NULLIF(pp."mother"->>'phone', ''), pu."phone") END AS "phone",
               CASE WHEN COALESCE(pp."guardian"->>'name', '') <> '' THEN 'Guardian'
                    WHEN COALESCE(pp."father"->>'name', '') <> '' THEN 'Father'
                    WHEN COALESCE(pp."mother"->>'name', '') <> '' THEN 'Mother'
                    ELSE COALESCE(NULLIF(pp."relationship", ''), 'Parent') END AS "relation"
          FROM "parentprofiles" pp LEFT JOIN "users" pu ON pu."_id" = pp."user"
         WHERE pp."school" = ${schoolParam} AND jsonb_typeof(pp."children") = 'array' AND pp."children" ? (${studentCol})::text
         ORDER BY pp."createdAt" DESC NULLS LAST LIMIT 1) g ON true`;

async function guardianOf(schoolId, studentId) {
    const { rows: [g] } = await pool.query(
        `SELECT g."name", g."phone", g."relation" FROM (SELECT $2::uuid AS "sid") s ${GUARDIAN_SQL('s."sid"', '$1')}`,
        [String(schoolId), String(studentId)]);
    return g && g.name ? g : null;
}

/**
 * The student picker behind every "Search by name, roll no. or admission no."
 * field: up to 50 matches, with class, gender, the first contact and any bed
 * they already hold. `onlyUnallocated` is applied BEFORE the limit, so a
 * school of thousands still finds the students still waiting for a bed.
 */
exports.searchStudents = async (req, res) => {
    try {
        const { search = '', onlyUnallocated = '', allocated = '', id = '' } = req.query;
        // `kind=teacher` turns the same picker to the staff register: a member
        // of staff can hold a bed too. Looking one up by id finds either.
        const staff = req.query.kind === 'teacher';
        const params = [String(req.schoolId)];
        const $ = (v) => { params.push(v); return `$${params.length}`; };
        let where = `u."school" = $1 AND u."isActive"`;
        where += id ? ` AND u."role" IN ('student', 'teacher') AND u."_id" = ${$(String(id))}::uuid`
                    : ` AND u."role" = '${staff ? 'teacher' : 'student'}'`;
        const term = String(search || '').trim();
        if (term) {
            const x = $(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
            where += ` AND (u."name" ILIKE ${x} OR u."email" ILIKE ${x} OR sp."admissionNumber" ILIKE ${x} OR sp."rollNumber"::text ILIKE ${x}
                            OR tp."employeeId" ILIKE ${x} OR tp."designation" ILIKE ${x})`;
        }
        if (onlyUnallocated === 'true') where += ` AND al."_id" IS NULL`;
        if (allocated === 'true') where += ` AND al."_id" IS NOT NULL AND al."status" = 'active'`;
        // A member of staff shows their employee id where a student shows an
        // admission number, and their designation where a student shows a class.
        const { rows } = await pool.query(
            `SELECT u."_id", u."name", u."email", u."profileImage", u."phone",
                    CASE WHEN u."role" = 'teacher' THEN 'teacher' ELSE 'student' END AS "kind",
                    COALESCE(sp."gender", tp."gender", '') AS "gender",
                    COALESCE(sp."admissionNumber", tp."employeeId", '') AS "admissionNumber",
                    COALESCE(sp."rollNumber"::text, '') AS "rollNumber",
                    COALESCE(c."className", tp."designation", '') AS "className",
                    COALESCE(cs."sectionName", '') AS "sectionName",
                    COALESCE(tp."department", '') AS "department",
                    COALESCE(sp."emergencyContactName", '') AS "emergencyContactName", COALESCE(sp."emergencyContactPhone", '') AS "emergencyContactPhone",
                    COALESCE(sp."emergencyContactRelation", '') AS "emergencyContactRelation",
                    g."name" AS "guardianName", g."phone" AS "guardianPhone", g."relation" AS "guardianRelation",
                    CASE WHEN al."_id" IS NULL THEN NULL ELSE jsonb_build_object('_id', al."_id", 'status', al."status", 'hostel', al."hostel",
                         'hostelName', h."name", 'room', al."room", 'roomNumber', rm."roomNumber", 'bed', al."bed", 'academicYear', al."academicYear") END AS "allocation"
               FROM "users" u
               LEFT JOIN LATERAL (SELECT * FROM "studentprofiles" p WHERE p."user" = u."_id" AND u."role" = 'student' ORDER BY p."createdAt" DESC NULLS LAST LIMIT 1) sp ON true
               LEFT JOIN LATERAL (SELECT * FROM "${TeacherProfile.tableName}" p WHERE p."user" = u."_id" AND u."role" = 'teacher' LIMIT 1) tp ON true
               LEFT JOIN "classes" c ON c."_id" = sp."currentClass"
               LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
               LEFT JOIN LATERAL (SELECT a.* FROM "${HostelAllocation.tableName}" a WHERE a."student" = u."_id" AND a."school" = $1
                                   AND a."status" IN ('pending', 'active') ORDER BY a."createdAt" DESC LIMIT 1) al ON true
               LEFT JOIN "${Hostel.tableName}" h ON h."_id" = al."hostel"
               LEFT JOIN "${HostelRoom.tableName}" rm ON rm."_id" = al."room"
               ${GUARDIAN_SQL('u."_id"', '$1')}
              WHERE ${where}
              ORDER BY lower(u."name") LIMIT ${Math.max(1, Math.min(500, Number(req.query.limit) || 50))}`, params);
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  DASHBOARD (spec §3)
// ═════════════════════════════════════════════════════════════════════════════
exports.getDashboard = async (req, res) => {
    try {
        const school = req.schoolId;
        const settings = await getSettings(school);
        const { start: todayStart, end: todayEnd } = dayRange();
        const allowed = await visibleHostelIds(req);
        // `scope` narrows every count below to the caller's hostels.
        const scope = allowed === null ? {} : { hostel: allowed.length ? { $in: allowed } : '__none__' };
        const hostelIdFilter = allowed === null ? {} : { _id: allowed.length ? { $in: allowed } : '__none__' };

        const [
            totalHostels, totalBuildings, totalFloors, totalRooms,
            bedTotals, activeAllocations, onLeaveNow, outsideNow,
            pendingAdmissions, waitlisted, pendingAllocations,
            pendingLeaves, pendingOutpasses, activeOutpasses, overdueOutpasses,
            todayVisitors, pendingComplaints, openMaintenance, recentIncidents,
        ] = await Promise.all([
            Hostel.countDocuments({ school, isActive: true, ...hostelIdFilter }),
            HostelBuilding.countDocuments({ school, isActive: true, ...scope }),
            HostelFloor.countDocuments({ school, isActive: true, ...scope }),
            HostelRoom.countDocuments({ school, isActive: true, ...scope }),
            HostelBed.aggregate([
                { $match: { school: toId(school), isActive: true, ...(allowed === null ? {} : { hostel: { $in: (allowed || []).map(String) } }) } },
                { $group: { _id: '$status', n: { $sum: 1 } } },
            ]),
            HostelAllocation.countDocuments({ school, status: 'active', ...scope }),
            HostelAllocation.countDocuments({ school, status: 'active', presence: 'on_leave', ...scope }),
            HostelAllocation.countDocuments({ school, status: 'active', presence: 'out', ...scope }),
            HostelAdmission.countDocuments({ school, status: { $in: ['applied', 'pending_approval'] }, ...scope }),
            HostelAdmission.countDocuments({ school, status: 'waitlisted', ...scope }),
            HostelAdmission.countDocuments({ school, status: 'approved', allocation: null, ...scope }),
            HostelLeave.countDocuments({ school, status: { $in: ['pending', 'parent_approved'] }, ...scope }),
            HostelOutpass.countDocuments({ school, status: 'pending', ...scope }),
            HostelOutpass.countDocuments({ school, status: 'active', ...scope }),
            HostelOutpass.countDocuments({ school, status: 'overdue', ...scope }),
            HostelVisitor.countDocuments({ school, isTemplate: false, createdAt: { $gte: todayStart, $lt: todayEnd }, ...scope }),
            HostelComplaint.countDocuments({ school, status: { $in: ['open', 'assigned', 'in_progress', 'reopened'] }, ...scope }),
            HostelMaintenance.countDocuments({ school, status: { $in: ['open', 'assigned', 'in_progress', 'on_hold'] }, ...scope }),
            HostelIncident.find({ school, ...scope }).sort('-date').limit(6)
                .populate('student', 'name').populate('hostel', 'name').lean(),
        ]);

        const bedByStatus = Object.fromEntries(bedTotals.map((b) => [b._id, b.n]));
        const totalBeds     = Object.values(bedByStatus).reduce((s, n) => s + n, 0);
        const occupiedBeds  = bedByStatus.occupied || 0;
        const availableBeds = bedByStatus.available || 0;
        const reservedBeds  = bedByStatus.reserved || 0;

        // Today's roll call across the caller's hostels, counted in STUDENTS —
        // each under their latest roll call of the day. Counting records made a
        // hostel with a morning and a night roll call show everyone twice. The
        // web dashboard reads the same helper, so the two cannot disagree.
        const attendanceToday = await overview.attendanceOn(school, allowed, 'today');

        // Outstanding hostel fees, in the caller's hostels.
        const feeAgg = await HostelFeeInvoice.aggregate([
            { $match: { school: toId(school), status: { $in: ['pending', 'partial', 'overdue'] },
                        ...(allowed === null ? {} : { hostel: { $in: (allowed || []).map(String) } }) } },
            { $group: { _id: null, billed: { $sum: '$netAmount' }, paid: { $sum: '$paidAmount' } } },
        ]);
        const outstandingFees = Math.max(0, (feeAgg[0]?.billed || 0) - (feeAgg[0]?.paid || 0));

        // ── charts ───────────────────────────────────────────────────────────
        const trendFrom = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - 13);
        const [attTrend, leaveTrend, outpassTrend, complaintStatus, maintStatus, feeTrend, hostelOccupancy] =
            await Promise.all([
                HostelAttendance.aggregate([
                    { $match: { school: toId(school), date: { $gte: trendFrom } } },
                    { $group: { _id: { d: { $dayOfMonth: '$date' }, m: { $month: '$date' }, s: '$status' }, n: { $sum: 1 } } },
                ]),
                HostelLeave.aggregate([
                    { $match: { school: toId(school), createdAt: { $gte: trendFrom } } },
                    { $group: { _id: { d: { $dayOfMonth: '$createdAt' }, m: { $month: '$createdAt' } }, n: { $sum: 1 } } },
                ]),
                HostelOutpass.aggregate([
                    { $match: { school: toId(school), createdAt: { $gte: trendFrom } } },
                    { $group: { _id: { d: { $dayOfMonth: '$createdAt' }, m: { $month: '$createdAt' } }, n: { $sum: 1 } } },
                ]),
                HostelComplaint.aggregate([
                    { $match: { school: toId(school) } },
                    { $group: { _id: '$status', n: { $sum: 1 } } },
                ]),
                HostelMaintenance.aggregate([
                    { $match: { school: toId(school) } },
                    { $group: { _id: '$status', n: { $sum: 1 } } },
                ]),
                HostelFeeInvoice.aggregate([
                    { $match: { school: toId(school), createdAt: { $gte: monthStart(5) } } },
                    { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } },
                                billed: { $sum: '$netAmount' }, paid: { $sum: '$paidAmount' } } },
                ]),
                HostelAllocation.aggregate([
                    { $match: { school: toId(school), status: 'active' } },
                    { $group: { _id: '$hostel', n: { $sum: 1 } } },
                ]),
            ]);

        // 14-day attendance trend as {label, present, absent, late}.
        const attByDay = {};
        for (const r of attTrend) {
            const k = `${r._id.m}-${r._id.d}`;
            attByDay[k] = attByDay[k] || { present: 0, absent: 0, late: 0, excused: 0, on_leave: 0 };
            attByDay[k][r._id.s] = r.n;
        }
        const dailySeries = (rows) => {
            const map = {};
            for (const r of rows) map[`${r._id.m}-${r._id.d}`] = r.n;
            return map;
        };
        const leaveMap = dailySeries(leaveTrend);
        const outMap   = dailySeries(outpassTrend);

        const attendanceTrend = []; const leaveSeries = []; const outpassSeries = [];
        for (let i = 13; i >= 0; i--) {
            const d = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - i);
            const k = `${d.getMonth() + 1}-${d.getDate()}`;
            const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
            const a = attByDay[k] || {};
            attendanceTrend.push({ label, present: a.present || 0, absent: a.absent || 0, late: a.late || 0 });
            leaveSeries.push({ label, value: leaveMap[k] || 0 });
            outpassSeries.push({ label, value: outMap[k] || 0 });
        }

        const feeMonths = [];
        const feeMap = Object.fromEntries(feeTrend.map((r) => [`${r._id.y}-${r._id.m}`, r]));
        for (let i = 5; i >= 0; i--) {
            const d = new Date(); d.setMonth(d.getMonth() - i);
            const r = feeMap[`${d.getFullYear()}-${d.getMonth() + 1}`];
            feeMonths.push({ label: MONTHS[d.getMonth()], billed: r?.billed || 0, collected: r?.paid || 0 });
        }

        // Per-hostel occupancy, named.
        const hostelRows = await Hostel.find({ school, isActive: true, ...hostelIdFilter }).select('name capacity').lean();
        const occByHostel = Object.fromEntries(hostelOccupancy.map((h) => [String(h._id), h.n]));
        const bedsByHostel = await HostelBed.aggregate([
            { $match: { school: toId(school), isActive: true } },
            { $group: { _id: '$hostel', beds: { $sum: 1 } } },
        ]);
        const bedMap = Object.fromEntries(bedsByHostel.map((b) => [String(b._id), b.beds]));
        const occupancy = hostelRows.map((h) => {
            const beds = bedMap[String(h._id)] || 0;
            const used = occByHostel[String(h._id)] || 0;
            return { name: h.name, beds, occupied: used, available: Math.max(0, beds - used),
                     percent: beds ? Math.round((used / beds) * 100) : 0 };
        });

        const recentActivities = await HostelAuditLog.find({ school }).sort('-createdAt').limit(12)
            .populate('user', 'name').lean();

        ok(res, {
            totalHostels, totalBuildings, totalFloors, totalRooms,
            totalBeds, occupiedBeds, availableBeds, reservedBeds,
            maintenanceBeds: bedByStatus.maintenance || 0,
            studentsStaying: activeAllocations - onLeaveNow - outsideNow,
            studentsOutside: outsideNow,
            studentsOnLeave: onLeaveNow,
            totalResidents: activeAllocations,
            attendanceToday: {
                present: attendanceToday.present,
                absent: attendanceToday.absent,
                late: attendanceToday.late,
                excused: attendanceToday.excused,
                marked: attendanceToday.marked,
            },
            pendingAdmissions, waitlisted, pendingAllocations,
            pendingLeaves, pendingOutpasses, activeOutpasses, overdueOutpasses,
            todayVisitors, pendingComplaints, openMaintenance,
            // A teacher in on a posting runs the hostel's day, not its books.
            outstandingFees: req.hostelDuty ? null : outstandingFees,
            recentIncidents, recentActivities,
            charts: {
                occupancy,
                bedAvailability: [
                    { label: 'Occupied', value: occupiedBeds },
                    { label: 'Available', value: availableBeds },
                    { label: 'Reserved', value: reservedBeds },
                    { label: 'Maintenance', value: bedByStatus.maintenance || 0 },
                ],
                attendanceTrend, leaveTrend: leaveSeries, outpassTrend: outpassSeries,
                complaintStatus: complaintStatus.map((c) => ({ label: c._id, value: c.n })),
                maintenanceStatus: maintStatus.map((m) => ({ label: m._id, value: m.n })),
                feeCollection: feeMonths,
            },
            settings: {
                curfewTime: settings.curfewTime,
                attendanceSessions: settings.attendanceSessions,
            },
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  HOSTEL SETUP (spec §4)
// ═════════════════════════════════════════════════════════════════════════════
exports.getHostels = async (req, res) => {
    try {
        const p = page(req.query);
        const { search = '', status, hostelType } = req.query;
        const q = await scopedFilter(req, { isActive: true }, null);
        delete q.hostel;                                   // this IS the hostel list
        const allowed = await visibleHostelIds(req);
        if (allowed !== null) q._id = allowed.length ? { $in: allowed } : '__none__';
        if (status) q.status = status;
        if (hostelType) q.hostelType = hostelType;
        if (search) q.$or = [{ name: rx(search) }, { code: rx(search) }];

        const [rows, total] = await Promise.all([
            Hostel.find(q).sort('name').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('warden', 'name email phone')
                .populate('assistantWarden', 'name email phone').lean(),
            Hostel.countDocuments(q),
        ]);

        // Live occupancy per hostel, one aggregate for the page.
        const ids = rows.map((r) => String(r._id));
        const [beds, occupied, rooms] = await Promise.all([
            HostelBed.aggregate([{ $match: { school: toId(req.schoolId), hostel: { $in: ids }, isActive: true } },
                { $group: { _id: '$hostel', n: { $sum: 1 } } }]),
            HostelBed.aggregate([{ $match: { school: toId(req.schoolId), hostel: { $in: ids }, status: 'occupied' } },
                { $group: { _id: '$hostel', n: { $sum: 1 } } }]),
            HostelRoom.aggregate([{ $match: { school: toId(req.schoolId), hostel: { $in: ids }, isActive: true } },
                { $group: { _id: '$hostel', n: { $sum: 1 } } }]),
        ]);
        const m = (arr) => Object.fromEntries(arr.map((x) => [String(x._id), x.n]));
        const bedMap = m(beds); const occMap = m(occupied); const roomMap = m(rooms);
        rows.forEach((r) => {
            r.totalBeds = bedMap[String(r._id)] || 0;
            r.occupiedBeds = occMap[String(r._id)] || 0;
            r.availableBeds = Math.max(0, r.totalBeds - r.occupiedBeds);
            r.totalRooms = roomMap[String(r._id)] || 0;
        });
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

exports.getHostel = async (req, res) => {
    try {
        if (!await mayTouchHostel(req, req.params.id)) return bad(res, 'You do not have access to this hostel', 403);
        const h = await Hostel.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('warden', 'name email phone profileImage')
            .populate('assistantWarden', 'name email phone profileImage').lean();
        if (!h) return bad(res, 'Hostel not found', 404);

        const [buildings, rooms, bedAgg, residents, staff, messes] = await Promise.all([
            HostelBuilding.find({ school: req.schoolId, hostel: h._id, isActive: true }).sort('name').lean(),
            HostelRoom.countDocuments({ school: req.schoolId, hostel: h._id, isActive: true }),
            HostelBed.aggregate([
                { $match: { school: toId(req.schoolId), hostel: toId(h._id), isActive: true } },
                { $group: { _id: '$status', n: { $sum: 1 } } },
            ]),
            HostelAllocation.countDocuments({ school: req.schoolId, hostel: h._id, status: 'active' }),
            HostelStaffAssignment.find({ school: req.schoolId, hostel: h._id, status: 'active' })
                .populate('staff', 'name email phone').lean(),
            HostelMess.find({ school: req.schoolId, hostels: h._id, isActive: true }).select('name code').lean(),
        ]);
        const beds = Object.fromEntries(bedAgg.map((b) => [b._id, b.n]));
        ok(res, {
            ...h,
            stats: {
                buildings: buildings.length,
                rooms,
                totalBeds: Object.values(beds).reduce((s, n) => s + n, 0),
                occupiedBeds: beds.occupied || 0,
                availableBeds: beds.available || 0,
                reservedBeds: beds.reserved || 0,
                residents,
            },
            buildings, staff, messes,
        });
    } catch (e) { fail(res, e); }
};

/**
 * The warden and assistant warden named on a hostel are postings too. Picking
 * one on the hostel's own form used to set the field and nothing else, so the
 * person never appeared on the Warden & Staff screen — and whoever held the
 * post before kept their posting, and with it their access to the hostel.
 * `before` is the hostel as it was (null when it is new).
 */
async function syncWardenPosts(req, hostel, before) {
    for (const [field, role] of [['warden', 'warden'], ['assistantWarden', 'assistant_warden']]) {
        const now = hostel[field] ? String(hostel[field]) : '';
        const was = before?.[field] ? String(before[field]) : '';
        if (now === was) continue;
        if (was) {
            await HostelStaffAssignment.updateMany(
                { school: req.schoolId, hostel: hostel._id, staff: was, role, status: 'active' },
                { $set: { status: 'inactive', isActive: false, toDate: new Date() } });
        }
        if (now && !await HostelStaffAssignment.exists({ school: req.schoolId, hostel: hostel._id, staff: now, role, status: 'active' })) {
            await HostelStaffAssignment.create({ school: req.schoolId, hostel: hostel._id, staff: now, role, status: 'active', isActive: true,
                fromDate: new Date(), createdBy: req.userId });
        }
    }
}

exports.createHostel = async (req, res) => {
    try {
        const b = req.body;
        if (!b.name) return bad(res, 'Hostel name is required');
        const code = (b.code || '').trim() || await nextNumber(Hostel, req.schoolId, 'HL');
        if (await Hostel.findOne({ school: req.schoolId, code })) return bad(res, 'A hostel with this code already exists');

        const settings = await getSettings(req.schoolId);
        if (settings.maxHostelCapacity > 0 && num(b.capacity) > settings.maxHostelCapacity) {
            return bad(res, `A hostel's capacity cannot exceed the configured maximum of ${settings.maxHostelCapacity}`);
        }
        const h = await Hostel.create({
            ...b, code, school: req.schoolId, createdBy: req.userId,
            capacity: num(b.capacity),
        });
        await syncWardenPosts(req, h, null);
        await logAudit(req, { action: 'create', entityType: 'Hostel', entityId: h._id, hostel: h._id,
            description: `Created hostel ${h.name} (${h.code})`, after: { name: h.name, code: h.code, status: h.status } });
        ok(res, h);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A hostel with this code already exists');
        fail(res, e);
    }
};

exports.updateHostel = async (req, res) => {
    try {
        if (!await mayTouchHostel(req, req.params.id)) return bad(res, 'You do not have access to this hostel', 403);
        const before = await Hostel.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Hostel not found', 404);
        const body = { ...req.body };
        delete body.school; delete body._id;
        if (body.capacity !== undefined) {
            body.capacity = num(body.capacity);
            const settings = await getSettings(req.schoolId);
            if (settings.maxHostelCapacity > 0 && body.capacity > settings.maxHostelCapacity) {
                return bad(res, `A hostel's capacity cannot exceed the configured maximum of ${settings.maxHostelCapacity}`);
            }
        }
        // Closing a hostel through its edit form is still closing it: not with people living there.
        if (body.status === 'inactive' || body.isActive === false) {
            const residents = await HostelAllocation.countDocuments({ school: req.schoolId, hostel: before._id, status: { $in: ['active', 'pending'] } });
            if (residents) return bad(res, `Cannot make this hostel inactive — ${residents} resident(s) still hold a bed here`);
        }

        const h = await Hostel.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        await syncWardenPosts(req, h, before);
        const d = diffFields(before, h, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'Hostel', entityId: h._id, hostel: h._id,
            description: `Updated hostel ${h.name}`, before: d.before, after: d.after });
        ok(res, h);
    } catch (e) { fail(res, e); }
};

// Soft delete — a hostel with residents is never removed (spec §31).
exports.deleteHostel = async (req, res) => {
    try {
        if (!await mayTouchHostel(req, req.params.id)) return bad(res, 'You do not have access to this hostel', 403);
        const residents = await HostelAllocation.countDocuments({ school: req.schoolId, hostel: req.params.id, status: { $in: ['active', 'pending'] } });
        if (residents) return bad(res, `Cannot deactivate — ${residents} resident(s) still hold a bed here`);

        const h = await Hostel.findOneAndUpdate({ _id: req.params.id, school: req.schoolId },
            { $set: { isActive: false, status: 'inactive' } }, { new: true });
        if (!h) return bad(res, 'Hostel not found', 404);
        await logAudit(req, { action: 'delete', entityType: 'Hostel', entityId: h._id, hostel: h._id,
            description: `Deactivated hostel ${h.name}` });
        ok(res, h);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  BUILDINGS & FLOORS (spec §5)
// ═════════════════════════════════════════════════════════════════════════════
exports.getBuildings = async (req, res) => {
    try {
        const q = await scopedFilter(req, { isActive: true });
        if (req.query.status) q.status = req.query.status;
        if (req.query.search) q.$or = [{ name: rx(req.query.search) }, { code: rx(req.query.search) }];
        const rows = await HostelBuilding.find(q).sort('name').populate('hostel', 'name code').lean();

        const ids = rows.map((r) => String(r._id));
        const [floors, beds, occ] = await Promise.all([
            HostelFloor.aggregate([{ $match: { school: toId(req.schoolId), building: { $in: ids }, isActive: true } }, { $group: { _id: '$building', n: { $sum: 1 } } }]),
            HostelBed.aggregate([{ $match: { school: toId(req.schoolId), building: { $in: ids }, isActive: true } }, { $group: { _id: '$building', n: { $sum: 1 } } }]),
            HostelBed.aggregate([{ $match: { school: toId(req.schoolId), building: { $in: ids }, status: 'occupied' } }, { $group: { _id: '$building', n: { $sum: 1 } } }]),
        ]);
        const m = (a) => Object.fromEntries(a.map((x) => [String(x._id), x.n]));
        const fM = m(floors); const bM = m(beds); const oM = m(occ);
        rows.forEach((r) => {
            r.floors = fM[String(r._id)] || 0;
            r.totalBeds = bM[String(r._id)] || 0;
            r.occupiedBeds = oM[String(r._id)] || 0;
            r.availableBeds = Math.max(0, r.totalBeds - r.occupiedBeds);
        });
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

/** Deactivate the floors, rooms and beds under a building or floor being closed (none is occupied — the caller checked). */
async function closeBelow(schoolId, where) {
    const off = { $set: { isActive: false, status: 'inactive' } };
    if (where.building) await HostelFloor.updateMany({ school: schoolId, building: where.building, isActive: true }, off);
    await HostelRoom.updateMany({ school: schoolId, ...where, isActive: true }, off);
    await HostelBed.updateMany({ school: schoolId, ...where, status: { $ne: 'occupied' } }, off);
}

/** "Ground Floor", "First Floor" … "Twelfth Floor", then "Floor 13". */
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth'];
const floorName = (n) => (n === 0 ? 'Ground Floor' : ORDINALS[n - 1] ? `${ORDINALS[n - 1]} Floor` : `Floor ${n}`);

exports.createBuilding = async (req, res) => {
    try {
        const b = req.body;
        if (!b.name || !b.hostel) return bad(res, 'Building name and hostel are required');
        if (!await mayTouchHostel(req, b.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const hostel = await Hostel.findOne({ _id: b.hostel, school: req.schoolId }).lean();
        if (!hostel) return bad(res, 'Hostel not found');

        const floorCount = num(b.floorCount);
        if (floorCount < 0 || floorCount > 60) return bad(res, 'A building has between 0 and 60 floors');
        const code = (b.code || '').trim() || await nextNumber(HostelBuilding, req.schoolId, 'BLD');
        const { createFloors, ...fields } = b;
        const row = await HostelBuilding.create({
            ...fields, code, school: req.schoolId, createdBy: req.userId,
            floorCount, capacity: num(b.capacity), expectedRooms: num(b.expectedRooms),
            facilities: Array.isArray(b.facilities) ? b.facilities.map(String).filter(Boolean) : [],
        });
        // "Number of floors" can also lay the floors down, numbered from the ground up.
        const floors = [];
        if (createFloors && floorCount > 0) {
            for (let n = 0; n < floorCount; n++) {
                floors.push(await HostelFloor.create({
                    school: req.schoolId, hostel: hostel._id, building: row._id, name: floorName(n), floorNumber: n,
                    status: 'active', createdBy: req.userId,
                }));
            }
        }
        await logAudit(req, { action: 'create', entityType: 'HostelBuilding', entityId: row._id, hostel: hostel._id,
            description: `Added building ${row.name} to ${hostel.name}${floors.length ? ` with ${floors.length} floor(s)` : ''}` });
        ok(res, { ...(row.toObject?.() ?? row), floors });
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A building with this code already exists in this hostel');
        fail(res, e);
    }
};

exports.updateBuilding = async (req, res) => {
    try {
        const before = await HostelBuilding.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Building not found', 404);
        if (!await mayTouchHostel(req, before.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const body = { ...req.body };
        delete body.school; delete body._id; delete body.hostel;   // a building never changes hostel
        if (body.status === 'inactive' || body.isActive === false) {
            const occupied = await HostelBed.countDocuments({ school: req.schoolId, building: before._id, status: 'occupied' });
            if (occupied) return bad(res, `Cannot make this building inactive — ${occupied} bed(s) in it are occupied`);
        }
        const row = await HostelBuilding.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelBuilding', entityId: row._id, hostel: row.hostel,
            description: `Updated building ${row.name}`, before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.deleteBuilding = async (req, res) => {
    try {
        const row = await HostelBuilding.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Building not found', 404);
        if (!await mayTouchHostel(req, row.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const occupied = await HostelBed.countDocuments({ school: req.schoolId, building: row._id, status: 'occupied' });
        if (occupied) return bad(res, `Cannot deactivate — ${occupied} bed(s) in this building are occupied`);

        await HostelBuilding.findByIdAndUpdate(row._id, { $set: { isActive: false, status: 'inactive' } });
        // Everything inside goes with it — a room in a closed building is not a room anyone can be given.
        await closeBelow(req.schoolId, { building: row._id });
        await logAudit(req, { action: 'delete', entityType: 'HostelBuilding', entityId: row._id, hostel: row.hostel,
            description: `Deactivated building ${row.name}` });
        ok(res, { _id: row._id });
    } catch (e) { fail(res, e); }
};

exports.getFloors = async (req, res) => {
    try {
        const q = await scopedFilter(req, { isActive: true });
        if (req.query.building) q.building = req.query.building;
        if (req.query.status) q.status = req.query.status;
        const rows = await HostelFloor.find(q).sort('floorNumber')
            .populate('hostel', 'name').populate('building', 'name code')
            .populate('supervisor', 'name email phone').lean();

        const ids = rows.map((r) => String(r._id));
        const [rooms, beds, occ] = await Promise.all([
            HostelRoom.aggregate([{ $match: { school: toId(req.schoolId), floor: { $in: ids }, isActive: true } }, { $group: { _id: '$floor', n: { $sum: 1 } } }]),
            HostelBed.aggregate([{ $match: { school: toId(req.schoolId), floor: { $in: ids }, isActive: true } }, { $group: { _id: '$floor', n: { $sum: 1 } } }]),
            HostelBed.aggregate([{ $match: { school: toId(req.schoolId), floor: { $in: ids }, status: 'occupied' } }, { $group: { _id: '$floor', n: { $sum: 1 } } }]),
        ]);
        const m = (a) => Object.fromEntries(a.map((x) => [String(x._id), x.n]));
        const rM = m(rooms); const bM = m(beds); const oM = m(occ);
        rows.forEach((r) => {
            r.totalRooms = rM[String(r._id)] || 0;
            r.totalBeds = bM[String(r._id)] || 0;
            r.occupiedBeds = oM[String(r._id)] || 0;
            r.availableBeds = Math.max(0, r.totalBeds - r.occupiedBeds);
        });
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

exports.createFloor = async (req, res) => {
    try {
        const b = req.body;
        if (!b.name || !b.building) return bad(res, 'Floor name and building are required');
        const building = await HostelBuilding.findOne({ _id: b.building, school: req.schoolId }).lean();
        if (!building) return bad(res, 'Building not found');
        if (!await mayTouchHostel(req, building.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const row = await HostelFloor.create({
            ...b, school: req.schoolId, hostel: building.hostel, createdBy: req.userId,
            floorNumber: num(b.floorNumber), capacity: num(b.capacity), commonRooms: num(b.commonRooms),
        });
        await logAudit(req, { action: 'create', entityType: 'HostelFloor', entityId: row._id, hostel: building.hostel,
            description: `Added floor ${row.name} to ${building.name}` });
        ok(res, row);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A floor with this number already exists in this building');
        fail(res, e);
    }
};

exports.updateFloor = async (req, res) => {
    try {
        const before = await HostelFloor.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Floor not found', 404);
        if (!await mayTouchHostel(req, before.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const body = { ...req.body };
        delete body.school; delete body._id; delete body.hostel; delete body.building;
        if (body.floorNumber !== undefined) body.floorNumber = num(body.floorNumber);
        if (body.status === 'inactive' || body.isActive === false) {
            const occupied = await HostelBed.countDocuments({ school: req.schoolId, floor: before._id, status: 'occupied' });
            if (occupied) return bad(res, `Cannot make this floor inactive — ${occupied} bed(s) on it are occupied`);
        }
        const row = await HostelFloor.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelFloor', entityId: row._id, hostel: row.hostel,
            description: `Updated floor ${row.name}`, before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.deleteFloor = async (req, res) => {
    try {
        const row = await HostelFloor.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Floor not found', 404);
        if (!await mayTouchHostel(req, row.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const occupied = await HostelBed.countDocuments({ school: req.schoolId, floor: row._id, status: 'occupied' });
        if (occupied) return bad(res, `Cannot deactivate — ${occupied} bed(s) on this floor are occupied`);
        await HostelFloor.findByIdAndUpdate(row._id, { $set: { isActive: false, status: 'inactive' } });
        await closeBelow(req.schoolId, { floor: row._id });
        await logAudit(req, { action: 'delete', entityType: 'HostelFloor', entityId: row._id, hostel: row.hostel,
            description: `Deactivated floor ${row.name}` });
        ok(res, { _id: row._id });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ROOMS & BEDS (spec §6, §7)
// ═════════════════════════════════════════════════════════════════════════════
exports.getRooms = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, { isActive: true });
        const { building, floor, status, roomType, search = '' } = req.query;
        if (building) q.building = building;
        if (floor) q.floor = floor;
        if (status) q.status = status;
        if (roomType) q.roomType = roomType;
        if (search) q.$or = [{ roomNumber: rx(search) }, { code: rx(search) }];

        const [rows, total] = await Promise.all([
            HostelRoom.find(q).sort('roomNumber').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('hostel', 'name code gender')
                .populate('building', 'name code')
                .populate('floor', 'name floorNumber').lean(),
            HostelRoom.countDocuments(q),
        ]);

        // Attach the beds so the grid can render occupancy without a call per room.
        const ids = rows.map((r) => String(r._id));
        const beds = await HostelBed.find({ school: req.schoolId, room: { $in: ids }, isActive: true })
            .sort('bedNumber').populate('student', 'name profileImage').lean();
        const byRoom = {};
        for (const b of beds) (byRoom[String(b.room)] = byRoom[String(b.room)] || []).push(b);
        rows.forEach((r) => {
            r.beds = byRoom[String(r._id)] || [];
            r.availableBeds = r.beds.filter((b) => b.status === 'available').length;
        });
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

exports.getRoom = async (req, res) => {
    try {
        const r = await HostelRoom.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('hostel', 'name code gender')
            .populate('building', 'name').populate('floor', 'name floorNumber').lean();
        if (!r) return bad(res, 'Room not found', 404);
        if (!await mayTouchHostel(req, r.hostel?._id || r.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const [beds, assets, complaints, maintenance] = await Promise.all([
            HostelBed.find({ school: req.schoolId, room: r._id }).sort('bedNumber')
                .populate('student', 'name email profileImage').lean(),
            HostelAsset.find({ school: req.schoolId, room: r._id }).lean(),
            HostelComplaint.find({ school: req.schoolId, room: r._id }).sort('-createdAt').limit(10).lean(),
            HostelMaintenance.find({ school: req.schoolId, room: r._id }).sort('-createdAt').limit(10).lean(),
        ]);
        ok(res, { ...r, beds, assets, complaints, maintenance });
    } catch (e) { fail(res, e); }
};

/**
 * Create a room. `generateBeds` (default true) also lays out `capacity` beds,
 * which is what a warden almost always wants and saves a second screen.
 */
exports.createRoom = async (req, res) => {
    try {
        const b = req.body;
        if (!b.roomNumber || !b.floor) return bad(res, 'Room number and floor are required');
        const floor = await HostelFloor.findOne({ _id: b.floor, school: req.schoolId }).lean();
        if (!floor) return bad(res, 'Floor not found');
        if (!await mayTouchHostel(req, floor.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const settings = await getSettings(req.schoolId);
        const capacity = num(b.capacity, 1);
        if (capacity < 1) return bad(res, 'Room capacity must be at least 1');
        if (settings.maxRoomCapacity && capacity > settings.maxRoomCapacity) {
            return bad(res, `Room capacity cannot exceed the configured maximum of ${settings.maxRoomCapacity}`);
        }

        const code = (b.code || '').trim() || await nextNumber(HostelRoom, req.schoolId, 'RM');
        const room = await HostelRoom.create({
            ...b, code, capacity, occupantType: resident.cleanOccupant(b.occupantType) || 'student',
            school: req.schoolId, hostel: floor.hostel, building: floor.building, floor: floor._id,
            createdBy: req.userId,
        });

        let beds = [];
        if (b.generateBeds !== false) {
            beds = await generateBedsForRoom(req, room, capacity);
            await HostelRoom.findByIdAndUpdate(room._id, { $set: { bedCount: beds.length } });
            room.bedCount = beds.length;
        }
        await logAudit(req, { action: 'create', entityType: 'HostelRoom', entityId: room._id, hostel: room.hostel,
            description: `Added room ${room.roomNumber} with ${beds.length} bed(s)` });
        ok(res, { ...room.toObject?.() ?? room, beds });
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A room with this number already exists in this hostel');
        fail(res, e);
    }
};

// Lays out beds 1..n for a room, skipping numbers that already exist.
async function generateBedsForRoom(req, room, count) {
    const existing = await HostelBed.find({ school: req.schoolId, room: room._id }).select('bedNumber').lean();
    const taken = new Set(existing.map((b) => String(b.bedNumber)));
    const out = [];
    for (let i = 1; out.length < count && i <= count + existing.length; i++) {
        const bedNumber = String(i);
        if (taken.has(bedNumber)) continue;
        const code = await nextNumber(HostelBed, req.schoolId, 'BD');
        const bedType = room.bedType === 'bunk' ? (i % 2 ? 'bunk_lower' : 'bunk_upper') : room.bedType === 'other' ? 'other' : 'single';
        out.push(await HostelBed.create({
            school: req.schoolId, hostel: room.hostel, building: room.building,
            floor: room.floor, room: room._id,
            bedNumber, code, bedType, occupantType: resident.occupantOf(room), status: 'available', createdBy: req.userId,
        }));
    }
    return out;
}

exports.updateRoom = async (req, res) => {
    try {
        const before = await HostelRoom.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Room not found', 404);
        if (!await mayTouchHostel(req, before.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const body = { ...req.body };
        delete body.school; delete body._id; delete body.hostel; delete body.building;
        delete body.occupiedBeds; delete body.bedCount;      // derived, never posted

        if (body.capacity !== undefined) {
            const settings = await getSettings(req.schoolId);
            body.capacity = num(body.capacity, before.capacity);
            const occupied = await HostelBed.countDocuments({ school: req.schoolId, room: before._id, status: 'occupied' });
            if (body.capacity < occupied) return bad(res, `Capacity cannot be below the ${occupied} bed(s) currently occupied`);
            if (settings.maxRoomCapacity && body.capacity > settings.maxRoomCapacity) {
                return bad(res, `Room capacity cannot exceed the configured maximum of ${settings.maxRoomCapacity}`);
            }
        }
        // A room may not be taken out of service while someone lives in it.
        if (['maintenance', 'inactive'].includes(body.status)) {
            const occupied = await HostelBed.countDocuments({ school: req.schoolId, room: before._id, status: 'occupied' });
            if (occupied) return bad(res, `Cannot mark this room ${body.status} — ${occupied} bed(s) are occupied`);
        }

        if (body.occupantType !== undefined) {
            body.occupantType = resident.cleanOccupant(body.occupantType);
            if (!body.occupantType) return bad(res, 'A room\'s beds are for students, for teachers, or for both');
        }

        const row = await HostelRoom.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        // "This room is for teachers" is a statement about its beds, so they
        // follow — except a bed whose present occupant would no longer fit.
        let bedsChanged = 0; let bedsKept = 0;
        if (body.occupantType && body.occupantType !== resident.occupantOf(before)) {
            const beds = await HostelBed.find({ school: req.schoolId, room: before._id, isActive: true }).select('status student occupantType').lean();
            const kinds = await resident.kindsOf(req.schoolId, beds.filter((b) => b.status === 'occupied').map((b) => b.student));
            const change = beds.filter((b) => {
                const fits = b.status !== 'occupied' || !b.student || resident.bedFits({ occupantType: body.occupantType }, kinds[String(b.student)] || 'student');
                if (!fits) bedsKept += 1;
                return fits && resident.occupantOf(b) !== body.occupantType;
            });
            if (change.length) await HostelBed.updateMany({ _id: { $in: change.map((b) => String(b._id)) } }, { $set: { occupantType: body.occupantType } });
            bedsChanged = change.length;
        }
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelRoom', entityId: row._id, hostel: row.hostel,
            description: `Updated room ${row.roomNumber}${bedsChanged ? ` — ${bedsChanged} bed(s) now for ${body.occupantType === 'both' ? 'students and teachers' : `${body.occupantType}s`}` : ''}`,
            before: d.before, after: d.after });
        ok(res, { ...(row.toObject?.() ?? row), bedsChanged, bedsKept });
    } catch (e) { fail(res, e); }
};

exports.deleteRoom = async (req, res) => {
    try {
        const row = await HostelRoom.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Room not found', 404);
        if (!await mayTouchHostel(req, row.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const occupied = await HostelBed.countDocuments({ school: req.schoolId, room: row._id, status: 'occupied' });
        if (occupied) return bad(res, `Cannot deactivate — ${occupied} bed(s) are occupied`);

        await HostelRoom.findByIdAndUpdate(row._id, { $set: { isActive: false, status: 'inactive' } });
        await HostelBed.updateMany({ school: req.schoolId, room: row._id, status: { $ne: 'occupied' } },
            { $set: { status: 'inactive', isActive: false } });
        await logAudit(req, { action: 'delete', entityType: 'HostelRoom', entityId: row._id, hostel: row.hostel,
            description: `Deactivated room ${row.roomNumber}` });
        ok(res, { _id: row._id });
    } catch (e) { fail(res, e); }
};

// ── Beds ─────────────────────────────────────────────────────────────────────
exports.getBeds = async (req, res) => {
    try {
        const q = await scopedFilter(req, {});
        const { room, floor, building, status, includeInactive } = req.query;
        if (room) q.room = room;
        if (floor) q.floor = floor;
        if (building) q.building = building;
        if (status) q.status = status;
        if (includeInactive !== 'true') q.isActive = true;
        const rows = await HostelBed.find(q).sort('bedNumber')
            .populate('student', 'name email profileImage')
            .populate('room', 'roomNumber roomType capacity').lean();
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

exports.createBed = async (req, res) => {
    try {
        const b = req.body;
        if (!b.room || !b.bedNumber) return bad(res, 'Room and bed number are required');
        const room = await HostelRoom.findOne({ _id: b.room, school: req.schoolId }).lean();
        if (!room) return bad(res, 'Room not found');
        if (!await mayTouchHostel(req, room.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const settings = await getSettings(req.schoolId);
        const bedCount = await HostelBed.countDocuments({ school: req.schoolId, room: room._id, isActive: true });
        if (!settings.allowOvercapacityAllocation && bedCount >= (room.capacity || 0)) {
            return bad(res, `Room ${room.roomNumber} already has its ${room.capacity} bed(s)`);
        }

        const code = (b.code || '').trim() || await nextNumber(HostelBed, req.schoolId, 'BD');
        const bed = await HostelBed.create({
            ...b, code, school: req.schoolId,
            // Stated on the form, else whatever the room's beds are for.
            occupantType: resident.cleanOccupant(b.occupantType) || resident.occupantOf(room),
            hostel: room.hostel, building: room.building, floor: room.floor, room: room._id,
            status: 'available', student: null, allocation: null, createdBy: req.userId,
        });
        await HostelRoom.findByIdAndUpdate(room._id, { $set: { bedCount: bedCount + 1 } });
        await logAudit(req, { action: 'create', entityType: 'HostelBed', entityId: bed._id, hostel: room.hostel,
            description: `Added bed ${bed.bedNumber} to room ${room.roomNumber}` });
        ok(res, bed);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A bed with this number already exists in this room');
        fail(res, e);
    }
};

// Bulk bed layout for a room (spec §7) — "give this room its beds".
exports.generateBeds = async (req, res) => {
    try {
        const room = await HostelRoom.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!room) return bad(res, 'Room not found', 404);
        if (!await mayTouchHostel(req, room.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const existing = await HostelBed.countDocuments({ school: req.schoolId, room: room._id, isActive: true });
        const want = Math.max(0, num(req.body.count, room.capacity) - existing);
        if (!want) return bad(res, 'This room already has all its beds');

        const beds = await generateBedsForRoom(req, room, want);
        await HostelRoom.findByIdAndUpdate(room._id, { $set: { bedCount: existing + beds.length } });
        await logAudit(req, { action: 'create', entityType: 'HostelBed', entityId: room._id, hostel: room.hostel,
            description: `Generated ${beds.length} bed(s) for room ${room.roomNumber}` });
        ok(res, beds);
    } catch (e) { fail(res, e); }
};

exports.updateBed = async (req, res) => {
    try {
        const before = await HostelBed.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Bed not found', 404);
        if (!await mayTouchHostel(req, before.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const body = { ...req.body };
        // Occupancy is only ever changed through the allocation engine.
        for (const f of ['school', '_id', 'hostel', 'building', 'floor', 'room', 'status', 'student', 'allocation', 'allocationDate']) delete body[f];
        if (body.occupantType !== undefined) {
            body.occupantType = resident.cleanOccupant(body.occupantType);
            if (!body.occupantType) return bad(res, 'A bed is for students, for teachers, or for both');
            // A bed cannot be re-labelled out from under the person sleeping in it.
            if (before.status === 'occupied' && before.student) {
                const kinds = await resident.kindsOf(req.schoolId, [before.student]);
                const kind = kinds[String(before.student)] || 'student';
                if (!resident.bedFits({ occupantType: body.occupantType }, kind)) {
                    return bad(res, `A ${kind} is in this bed — release them before keeping it for ${body.occupantType === 'teacher' ? 'teachers' : 'students'} only`);
                }
            }
        }

        const row = await HostelBed.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelBed', entityId: row._id, hostel: row.hostel,
            description: `Updated bed ${row.bedNumber}`, before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

// Reserve / free / send to maintenance (spec §7). Occupied beds are refused.
exports.setBedState = async (req, res) => {
    try {
        const bed = await HostelBed.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!bed) return bad(res, 'Bed not found', 404);
        if (!await mayTouchHostel(req, bed.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const updated = await alloc.setBedState({
            schoolId: req.schoolId, bedId: req.params.id, status: req.body.status,
            actorId: req.userId, actorName: req.user?.name || '', remarks: req.body.remarks || '',
        });
        await logAudit(req, { action: 'bed_state', entityType: 'HostelBed', entityId: bed._id, hostel: bed.hostel,
            description: `Bed ${bed.bedNumber} marked ${req.body.status}`,
            before: { status: bed.status }, after: { status: req.body.status } });
        ok(res, updated);
    } catch (e) { handle(res, e); }
};

exports.deleteBed = async (req, res) => {
    try {
        const bed = await HostelBed.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!bed) return bad(res, 'Bed not found', 404);
        if (!await mayTouchHostel(req, bed.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (bed.status === 'occupied') return bad(res, 'Release the student from this bed first');

        await HostelBed.findByIdAndUpdate(bed._id, { $set: { isActive: false, status: 'inactive' } });
        const count = await HostelBed.countDocuments({ school: req.schoolId, room: bed.room, isActive: true });
        await HostelRoom.findByIdAndUpdate(bed.room, { $set: { bedCount: count } });
        await logAudit(req, { action: 'delete', entityType: 'HostelBed', entityId: bed._id, hostel: bed.hostel,
            description: `Removed bed ${bed.bedNumber}` });
        ok(res, { _id: bed._id });
    } catch (e) { fail(res, e); }
};

/**
 * The drill-down occupancy tree (spec §32): Hostel → Building → Floor → Room →
 * Bed → Student, built from four flat reads rather than a query per node.
 */
exports.getOccupancyTree = async (req, res) => {
    try {
        const allowed = await visibleHostelIds(req);
        const hq = { school: req.schoolId, isActive: true };
        if (allowed !== null) hq._id = allowed.length ? { $in: allowed } : '__none__';
        if (req.query.hostel && (allowed === null || allowed.includes(String(req.query.hostel)))) hq._id = req.query.hostel;

        const hostels = await Hostel.find(hq).sort('name').lean();
        const hostelIds = hostels.map((h) => String(h._id));
        if (!hostelIds.length) return ok(res, []);

        const [buildings, floors, rooms, beds] = await Promise.all([
            HostelBuilding.find({ school: req.schoolId, hostel: { $in: hostelIds }, isActive: true }).sort('name').lean(),
            HostelFloor.find({ school: req.schoolId, hostel: { $in: hostelIds }, isActive: true }).sort('floorNumber').lean(),
            HostelRoom.find({ school: req.schoolId, hostel: { $in: hostelIds }, isActive: true }).sort('roomNumber').lean(),
            HostelBed.find({ school: req.schoolId, hostel: { $in: hostelIds }, isActive: true }).sort('bedNumber')
                .populate('student', 'name profileImage').lean(),
        ]);

        const group = (arr, key) => arr.reduce((m, x) => {
            (m[String(x[key])] = m[String(x[key])] || []).push(x); return m;
        }, {});
        const bedsByRoom = group(beds, 'room');
        const roomsByFloor = group(rooms, 'floor');
        const floorsByBuilding = group(floors, 'building');
        const buildingsByHostel = group(buildings, 'hostel');

        const tree = hostels.map((h) => ({
            _id: h._id, name: h.name, code: h.code, type: 'hostel',
            gender: h.gender, status: h.status,
            children: (buildingsByHostel[String(h._id)] || []).map((b) => ({
                _id: b._id, name: b.name, code: b.code, type: 'building', status: b.status,
                children: (floorsByBuilding[String(b._id)] || []).map((f) => ({
                    _id: f._id, name: f.name, floorNumber: f.floorNumber, type: 'floor', status: f.status,
                    children: (roomsByFloor[String(f._id)] || []).map((r) => ({
                        _id: r._id, name: r.roomNumber, type: 'room',
                        roomType: r.roomType, capacity: r.capacity, status: r.status,
                        occupiedBeds: r.occupiedBeds,
                        children: (bedsByRoom[String(r._id)] || []).map((bd) => ({
                            _id: bd._id, name: bd.bedNumber, type: 'bed',
                            status: bd.status, student: bd.student || null,
                        })),
                    })),
                })),
            })),
        }));
        ok(res, tree);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ADMISSIONS (spec §8)
// ═════════════════════════════════════════════════════════════════════════════
exports.getAdmissions = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { status, academicYear, search = '' } = req.query;
        if (status) q.status = status;
        if (academicYear) q.academicYear = academicYear;

        let rows = await HostelAdmission.find(q).sort('-createdAt')
            .skip((p.page - 1) * p.limit).limit(p.limit)
            .populate('student', 'name email profileImage')
            .populate('hostel', 'name code gender')
            .populate('academicYear', 'yearName')
            .populate('reviewedBy', 'name').lean();
        const total = await HostelAdmission.countDocuments(q);

        // Search filters on the populated student name, which the query layer
        // cannot reach — applied here on the current page.
        if (search) rows = rows.filter((r) => rx(search).test(r.student?.name || '') || rx(search).test(r.applicationNumber || ''));
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

exports.getAdmission = async (req, res) => {
    try {
        const a = await HostelAdmission.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('student', 'name email phone profileImage')
            .populate('hostel', 'name code gender capacity')
            .populate('academicYear', 'yearName')
            .populate('reviewedBy', 'name')
            .populate('allocation').lean();
        if (!a) return bad(res, 'Application not found', 404);
        if (!await mayTouchHostel(req, a.hostel?._id || a.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const [snapshot, documents, papers] = await Promise.all([
            studentSnapshot(req.schoolId, a.student?._id || a.student),
            HostelDocument.find({ school: req.schoolId, entityType: 'HostelAdmission', entityId: a._id, isActive: true }).lean(),
            admissionPapers(req.schoolId, a, await getSettings(req.schoolId)),
        ]);
        ok(res, { ...a, studentDetails: snapshot, documents, papers });
    } catch (e) { fail(res, e); }
};

/**
 * File an application. Guardian and emergency-contact defaults are lifted from
 * the existing StudentProfile so nobody retypes them, then snapshotted here.
 */
exports.createAdmission = async (req, res) => {
    try {
        const b = req.body;
        if (!b.student || !b.hostel || !b.academicYear) {
            return bad(res, 'Student, hostel and academic year are required');
        }
        if (!await mayTouchHostel(req, b.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const [hostel, student, profile, open] = await Promise.all([
            Hostel.findOne({ _id: b.hostel, school: req.schoolId }).lean(),
            User.findOne({ _id: b.student, school: req.schoolId, role: 'student' }).lean(),
            StudentProfile.findOne({ user: b.student, school: req.schoolId }).lean(),
            HostelAdmission.findOne({
                school: req.schoolId, student: b.student, academicYear: b.academicYear,
                status: { $in: ['draft', 'applied', 'pending_approval', 'approved'] },
            }).lean(),
        ]);
        if (!student) return bad(res, 'Student not found in this school');
        if (!hostel) return bad(res, 'Hostel not found');
        if (!hostel.isActive || hostel.status !== 'active') return bad(res, 'This hostel is not accepting admissions');
        if (open) return bad(res, 'This student already has an open hostel application for that year');

        const [settings, guardian] = await Promise.all([getSettings(req.schoolId), guardianOf(req.schoolId, b.student)]);
        const status = b.status === 'draft' ? 'draft'
            : settings.admissionRequiresApproval ? 'pending_approval' : 'approved';

        const row = await HostelAdmission.create({
            ...b,
            school: req.schoolId,
            applicationNumber: await nextNumber(HostelAdmission, req.schoolId, 'HA'),
            status,
            guardianName:  b.guardianName  || guardian?.name || '',
            guardianPhone: b.guardianPhone || guardian?.phone || '',
            guardianRelation: b.guardianRelation || guardian?.relation || '',
            emergencyContactName:     b.emergencyContactName     || profile?.emergencyContactName     || '',
            emergencyContactPhone:    b.emergencyContactPhone    || profile?.emergencyContactPhone    || '',
            emergencyContactRelation: b.emergencyContactRelation || profile?.emergencyContactRelation || '',
            appliedBy: req.userId,
            appliedAt: new Date(),
            reviewedBy: status === 'approved' ? req.userId : null,
            reviewedAt: status === 'approved' ? new Date() : null,
            createdBy: req.userId,
        });

        await logAudit(req, { action: 'create', entityType: 'HostelAdmission', entityId: row._id, hostel: hostel._id,
            description: `Hostel application ${row.applicationNumber} for ${student.name}`, after: { status } });
        await notifyHostelStaff(req, { hostelId: hostel._id,
            title: 'New hostel application',
            body: `${student.name} applied for accommodation at ${hostel.name} (${row.applicationNumber}).` });
        ok(res, row);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'This student already has an open hostel application for that year');
        fail(res, e);
    }
};

exports.updateAdmission = async (req, res) => {
    try {
        const before = await HostelAdmission.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Application not found', 404);
        if (!await mayTouchHostel(req, before.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (['approved', 'completed', 'cancelled'].includes(before.status)) {
            return bad(res, `A ${before.status} application can no longer be edited`);
        }
        const body = { ...req.body };
        // Editing an application changes what was asked for, never where it stands:
        // status, the waitlist position and the decision belong to decideAdmission,
        // which is what notifies the family and allocates the bed.
        for (const f of ['school', '_id', 'student', 'allocation', 'applicationNumber', 'reviewedBy', 'reviewedAt',
            'status', 'waitlistPosition', 'decisionRemark', 'appliedBy', 'appliedAt', 'createdBy', 'createdAt']) delete body[f];
        if (body.hostel && String(body.hostel) !== String(before.hostel)) {
            if (!await mayTouchHostel(req, body.hostel)) return bad(res, 'You do not have access to that hostel', 403);
            const target = await Hostel.findOne({ _id: body.hostel, school: req.schoolId, isActive: true }).select('_id').lean();
            if (!target) return bad(res, 'Hostel not found');
        }
        for (const f of ['joiningDate', 'expectedLeavingDate']) if (body[f] === '') body[f] = null;

        const row = await HostelAdmission.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelAdmission', entityId: row._id, hostel: row.hostel,
            description: `Updated application ${row.applicationNumber}`, before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/**
 * Approve / reject / waitlist / cancel an application (spec §8).
 *
 * Approval optionally allocates a bed in the same call: an explicit `bed`, or
 * the engine's own pick when settings say auto-allocate. Allocation failures do
 * NOT undo the approval — the application stays approved and appears under
 * "pending allocation", which is what a warden expects when the hostel is full.
 */
/**
 * The papers the school asks for with an application, and which of them are
 * on file — attached to the application itself or held for the student.
 */
async function admissionPapers(schoolId, a, settings) {
    const required = (settings.requiredAdmissionDocuments || []).map(String);
    if (!required.length) return { required: [], missing: [] };
    const docs = await HostelDocument.find({
        school: schoolId, isActive: true, docType: { $in: required },
        $or: [{ entityType: 'HostelAdmission', entityId: a._id }, { student: a.student?._id || a.student }],
    }).select('docType').lean();
    const have = new Set(docs.map((d) => d.docType));
    return { required, missing: required.filter((t) => !have.has(t)) };
}

/** Renumber a hostel's waiting list 1..n in its existing order. */
async function closeWaitlistGap(schoolId, hostelId) {
    const queue = await HostelAdmission.find({ school: schoolId, hostel: hostelId, status: 'waitlisted' })
        .select('waitlistPosition appliedAt').sort('waitlistPosition').lean();
    for (const [i, x] of queue.entries()) {
        if (x.waitlistPosition !== i + 1) await HostelAdmission.findByIdAndUpdate(x._id, { $set: { waitlistPosition: i + 1 } });
    }
}

/**
 * Whatever else follows from somebody becoming a resident: the security
 * deposit, where the school takes one. Never fails the allocation — a deposit
 * that could not be raised is logged and can be raised by hand.
 */
async function onMovedIn(req, allocation, settings) {
    try {
        if (!allocation || allocation.status !== 'active') return null;       // a held bed is not a stay yet
        return await payments.raiseDeposit(req, {
            studentId: allocation.student, allocation, kind: resident.residentKind(allocation), settings,
        });
    } catch (e) { console.error('[hostel] deposit not raised:', e.message); return null; }
}

/**
 * A bed given from the Allocations screen answers an approved application just
 * as one given from Admissions does. Without this the application sat under
 * "approved, awaiting a bed" for ever, though the student had moved in.
 */
async function settleAdmission(schoolId, studentId, academicYearId, allocationId) {
    const open = await HostelAdmission.findOne({ school: schoolId, student: studentId, academicYear: academicYearId, status: 'approved', allocation: null }).lean();
    if (open) await HostelAdmission.findByIdAndUpdate(open._id, { $set: { allocation: allocationId, status: 'completed' } });
}

exports.decideAdmission = async (req, res) => {
    try {
        const { action, remark = '', bed = null, allocate = false } = req.body;
        const valid = ['approve', 'reject', 'waitlist', 'cancel'];
        if (!valid.includes(action)) return bad(res, `Action must be one of: ${valid.join(', ')}`);

        const a = await HostelAdmission.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!a) return bad(res, 'Application not found', 404);
        if (!await mayTouchHostel(req, a.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (['completed', 'cancelled'].includes(a.status)) return bad(res, `This application is already ${a.status}`);

        const nextStatus = { approve: 'approved', reject: 'rejected', waitlist: 'waitlisted', cancel: 'cancelled' }[action];
        const settings = await getSettings(req.schoolId);

        // Approving with required papers missing is a decision, not an accident:
        // it has to be said out loud, and what was missing is kept on the record.
        let missingDocuments = a.missingDocuments || [];
        if (action === 'approve') {
            const papers = await admissionPapers(req.schoolId, a, settings);
            if (papers.missing.length && !req.body.acceptMissingDocuments) {
                return res.status(400).json({
                    success: false, code: 'DOCUMENTS_MISSING', missing: papers.missing,
                    message: `Required documents are missing: ${papers.missing.map((t) => t.replace(/_/g, ' ')).join(', ')}. Upload them, or approve anyway.`,
                });
            }
            missingDocuments = papers.missing;
        }
        const [student, hostel] = await Promise.all([
            User.findById(a.student).select('name').lean(),
            Hostel.findById(a.hostel).select('name').lean(),
        ]);

        // The end of the queue is one past the LAST position, not the head count:
        // once somebody leaves the list, count + 1 is a number already taken.
        let waitlistPosition = a.waitlistPosition;
        if (action === 'waitlist' && a.status !== 'waitlisted') {
            const queue = await HostelAdmission.find({ school: req.schoolId, hostel: a.hostel, status: 'waitlisted' }).select('waitlistPosition').lean();
            waitlistPosition = queue.reduce((m, x) => Math.max(m, x.waitlistPosition || 0), 0) + 1;
        }
        if (action !== 'waitlist') waitlistPosition = null;

        const updated = await HostelAdmission.findByIdAndUpdate(a._id, {
            $set: {
                status: nextStatus,
                reviewedBy: req.userId,
                reviewedAt: new Date(),
                decisionRemark: remark,
                waitlistPosition,
                missingDocuments,
            },
        }, { new: true });

        await logAudit(req, { action, entityType: 'HostelAdmission', entityId: a._id, hostel: a.hostel,
            description: `Application ${a.applicationNumber} ${nextStatus}${action === 'approve' && missingDocuments.length ? ` with ${missingDocuments.length} required document(s) missing` : ''}`,
            before: { status: a.status }, after: { status: nextStatus, remark, ...(action === 'approve' && missingDocuments.length ? { missingDocuments } : {}) } });
        // Somebody left the waiting list: everyone behind them moves up.
        if (a.status === 'waitlisted' && nextStatus !== 'waitlisted') await closeWaitlistGap(req.schoolId, a.hostel);

        // Optional allocation on approval.
        let allocation = null; let allocationError = null;
        if (action === 'approve' && (allocate || bed || settings.autoAllocateOnApproval)) {
            try {
                const targetBed = bed || (await alloc.findBestBed({
                    schoolId: req.schoolId, studentId: a.student, hostelId: a.hostel,
                    preferredRoomType: a.preferredRoomType, settings,
                }))?._id;
                if (!targetBed) throw new alloc.RuleError('No suitable bed is free in this hostel right now');

                const r = await alloc.allocateBed({
                    schoolId: req.schoolId, studentId: a.student, bedId: targetBed,
                    academicYearId: a.academicYear, admissionId: a._id,
                    actorId: req.userId, actorName: req.user?.name || '',
                    allocationMode: bed ? 'manual' : 'auto',
                    fromDate: a.joiningDate || new Date(),
                    toDate: a.expectedLeavingDate, settings,
                });
                allocation = r.allocation;
                await onMovedIn(req, allocation, settings);
                await HostelAdmission.findByIdAndUpdate(a._id, { $set: { allocation: allocation._id, status: 'completed' } });
                await logAudit(req, { action: 'allocate', entityType: 'HostelAllocation', entityId: allocation._id, hostel: a.hostel,
                    description: `Allocated ${student?.name} to ${r.room.roomNumber}/${r.bed.bedNumber}` });
            } catch (err) {
                // Reported to the caller; the approval itself stands.
                allocationError = err.message;
            }
        }

        const bodyText = {
            approved: `Your hostel application for ${hostel?.name} has been approved.`
                    + (allocation ? ' A bed has been allocated — check your hostel profile for the details.' : ' Room allocation will follow.'),
            rejected: `Your hostel application for ${hostel?.name} was not approved.${remark ? ` Reason: ${remark}` : ''}`,
            waitlisted: `Your hostel application for ${hostel?.name} is waitlisted at position ${waitlistPosition}.`,
            cancelled: `Your hostel application for ${hostel?.name} has been cancelled.`,
        }[nextStatus];

        await notifyStudentAndParents(req, {
            studentId: a.student, settings,
            title: `Hostel application ${nextStatus}`,
            body: bodyText,
        });

        ok(res, { admission: updated, allocation, allocationError });
    } catch (e) { handle(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ALLOCATION (spec §10) — every mutation goes through the transactional engine
// ═════════════════════════════════════════════════════════════════════════════
exports.getAllocations = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { status = 'active', room, floor, building, academicYear, presence } = req.query;
        if (status && status !== 'all') q.status = status;
        if (room) q.room = room;
        if (floor) q.floor = floor;
        if (building) q.building = building;
        if (academicYear) q.academicYear = academicYear;
        if (presence) q.presence = presence;

        let rows = await HostelAllocation.find(q).sort('-createdAt')
            .skip((p.page - 1) * p.limit).limit(p.limit)
            .populate('student', 'name email profileImage')
            .populate('hostel', 'name code').populate('building', 'name')
            .populate('floor', 'name floorNumber').populate('room', 'roomNumber roomType')
            .populate('bed', 'bedNumber code').lean();
        const total = await HostelAllocation.countDocuments(q);

        if (req.query.search) {
            const r = rx(req.query.search);
            rows = rows.filter((x) => r.test(x.student?.name || '') || r.test(x.room?.roomNumber || ''));
        }
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

// Manual allocation (spec §10).
exports.createAllocation = async (req, res) => {
    try {
        const { student, bed, academicYear, allocationType = 'permanent', fromDate, toDate, remarks = '' } = req.body;
        const hold = req.body.hold === true || req.body.hold === 'true';
        if (!student || !bed || !academicYear) return bad(res, 'Student, bed and academic year are required');

        const bedRow = await HostelBed.findOne({ _id: bed, school: req.schoolId }).lean();
        if (!bedRow) return bad(res, 'Bed not found');
        if (!await mayTouchHostel(req, bedRow.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const settings = await getSettings(req.schoolId);
        const r = await alloc.allocateBed({
            schoolId: req.schoolId, studentId: student, bedId: bed, academicYearId: academicYear,
            actorId: req.userId, actorName: req.user?.name || '',
            allocationType, allocationMode: 'manual', fromDate, toDate, remarks, settings, hold,
        });
        await settleAdmission(req.schoolId, student, academicYear, r.allocation._id);
        await onMovedIn(req, r.allocation, settings);

        await logAudit(req, { action: 'allocate', entityType: 'HostelAllocation', entityId: r.allocation._id, hostel: bedRow.hostel,
            description: `${hold ? 'Held a bed for' : 'Allocated'} ${r.student.name} ${hold ? 'in' : 'to'} ${r.hostel.name} · Room ${r.room.roomNumber} · Bed ${r.bed.bedNumber}`,
            after: { room: r.room.roomNumber, bed: r.bed.bedNumber, status: r.allocation.status } });
        await notifyStudentAndParents(req, {
            studentId: student, settings,
            title: hold ? 'Hostel bed reserved' : 'Hostel room allocated',
            body: hold
                ? `A bed is being held for you in ${r.hostel.name}, Room ${r.room.roomNumber}, Bed ${r.bed.bedNumber}. It is confirmed when you arrive.`
                : `You have been allocated ${r.hostel.name}, Room ${r.room.roomNumber}, Bed ${r.bed.bedNumber}.`,
        });
        ok(res, r.allocation);
    } catch (e) { handle(res, e); }
};

/**
 * Confirm a held bed: a PENDING allocation becomes active once the student has
 * arrived, and from then on they are a resident for every other screen.
 */
exports.confirmAllocation = async (req, res) => {
    try {
        const current = await HostelAllocation.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!current) return bad(res, 'Allocation not found', 404);
        if (!await mayTouchHostel(req, current.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const settings = await getSettings(req.schoolId);
        const r = await alloc.confirmAllocation({
            schoolId: req.schoolId, allocationId: req.params.id,
            actorId: req.userId, actorName: req.user?.name || '', remarks: req.body?.remarks || '',
        });
        await onMovedIn(req, r.allocation, settings);
        await logAudit(req, { action: 'allocate', entityType: 'HostelAllocation', entityId: current._id, hostel: current.hostel,
            description: `Confirmed ${r.student?.name || 'a student'} in ${r.hostel.name} · Room ${r.room?.roomNumber || '?'} · Bed ${r.bed.bedNumber}`,
            before: { status: 'pending' }, after: { status: 'active' } });
        await notifyStudentAndParents(req, {
            studentId: current.student, settings,
            title: 'Hostel room allocated',
            body: `Your bed in ${r.hostel.name}, Room ${r.room?.roomNumber || ''}, Bed ${r.bed.bedNumber} is confirmed.`,
        });
        ok(res, r.allocation);
    } catch (e) { handle(res, e); }
};

// Automatic allocation for one student (spec §10).
exports.autoAllocate = async (req, res) => {
    try {
        const { student, academicYear, hostel = null, preferredRoomType = '' } = req.body;
        if (!student || !academicYear) return bad(res, 'Student and academic year are required');
        if (hostel && !await mayTouchHostel(req, hostel)) return bad(res, 'You do not have access to this hostel', 403);
        // "Any suitable hostel" means any of the school's — which is not a posted warden's to choose from.
        if (!hostel && await visibleHostelIds(req) !== null) return bad(res, 'Choose the hostel to find a bed in');

        const settings = await getSettings(req.schoolId);
        const bed = await alloc.findBestBed({ schoolId: req.schoolId, studentId: student, hostelId: hostel, preferredRoomType, settings });
        if (!bed) return bad(res, 'No suitable bed is free under the current rules');

        const r = await alloc.allocateBed({
            schoolId: req.schoolId, studentId: student, bedId: bed._id, academicYearId: academicYear,
            actorId: req.userId, actorName: req.user?.name || '', allocationMode: 'auto', settings,
        });
        await settleAdmission(req.schoolId, student, academicYear, r.allocation._id);
        await onMovedIn(req, r.allocation, settings);
        await logAudit(req, { action: 'allocate', entityType: 'HostelAllocation', entityId: r.allocation._id, hostel: r.hostel._id,
            description: `Auto-allocated ${r.student.name} to Room ${r.room.roomNumber} · Bed ${r.bed.bedNumber}` });
        await notifyStudentAndParents(req, {
            studentId: student, settings,
            title: 'Hostel room allocated',
            body: `You have been allocated ${r.hostel.name}, Room ${r.room.roomNumber}, Bed ${r.bed.bedNumber}.`,
        });
        ok(res, r.allocation);
    } catch (e) { handle(res, e); }
};

/**
 * Bulk allocation (spec §10). Each student is allocated in its own transaction,
 * so one failure (wrong gender, hostel full) never rolls back the others — the
 * response lists exactly what happened to each.
 */
exports.bulkAllocate = async (req, res) => {
    try {
        const { students = [], academicYear, hostel = null, preferredRoomType = '' } = req.body;
        if (!students.length || !academicYear) return bad(res, 'Students and academic year are required');
        if (hostel && !await mayTouchHostel(req, hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (!hostel && await visibleHostelIds(req) !== null) return bad(res, 'Choose the hostel to allocate beds in');

        const settings = await getSettings(req.schoolId);
        const allocated = []; const failed = [];

        for (const studentId of students) {
            try {
                const bed = await alloc.findBestBed({ schoolId: req.schoolId, studentId, hostelId: hostel, preferredRoomType, settings });
                if (!bed) throw new alloc.RuleError('No suitable bed free');
                const r = await alloc.allocateBed({
                    schoolId: req.schoolId, studentId, bedId: bed._id, academicYearId: academicYear,
                    actorId: req.userId, actorName: req.user?.name || '', allocationMode: 'bulk', settings,
                });
                await settleAdmission(req.schoolId, studentId, academicYear, r.allocation._id);
                await onMovedIn(req, r.allocation, settings);
                allocated.push({
                    student: studentId, studentName: r.student.name,
                    hostel: r.hostel.name, room: r.room.roomNumber, bed: r.bed.bedNumber,
                    allocation: r.allocation._id,
                });
                notifyStudentAndParents(req, {
                    studentId, settings,
                    title: 'Hostel room allocated',
                    body: `You have been allocated ${r.hostel.name}, Room ${r.room.roomNumber}, Bed ${r.bed.bedNumber}.`,
                });
            } catch (err) {
                const u = await User.findById(studentId).select('name').lean();
                failed.push({ student: studentId, studentName: u?.name || String(studentId), reason: err.message });
            }
        }
        await logAudit(req, { action: 'bulk_allocate', entityType: 'HostelAllocation', hostel,
            description: `Bulk allocation: ${allocated.length} allocated, ${failed.length} failed`,
            meta: { allocated: allocated.length, failed: failed.length } });
        ok(res, { allocated, failed });
    } catch (e) { handle(res, e); }
};

// Transfer bed / room / floor / hostel (spec §10) — one operation for all four.
exports.transferAllocation = async (req, res) => {
    try {
        const { bed, reason = '', effectiveDate = null } = req.body;
        if (!bed) return bad(res, 'Destination bed is required');

        const current = await HostelAllocation.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!current) return bad(res, 'Allocation not found', 404);
        if (!await mayTouchHostel(req, current.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const target = await HostelBed.findOne({ _id: bed, school: req.schoolId }).lean();
        if (!target) return bad(res, 'Destination bed not found');
        if (!await mayTouchHostel(req, target.hostel)) return bad(res, 'You do not have access to the destination hostel', 403);

        const settings = await getSettings(req.schoolId);

        // The module's admins move people directly. A teacher in on a posting
        // asks, where the school wants transfers approved: the move waits in
        // the transfer requests for an admin to carry out.
        if (settings.transferRequiresApproval && req.hostelDuty) {
            if (!String(reason).trim()) return bad(res, 'Say why the resident should move — the request goes to the hostel administrators');
            // Refused now if it could never be carried out (wrong kind of bed, full room, gender).
            await alloc.validateAllocation({ schoolId: req.schoolId, studentId: current.student, bedId: bed, settings, ignoreAllocationId: current._id });
            if (!settings.allowTransferBetweenHostels && String(current.hostel) !== String(target.hostel)) {
                return bad(res, 'Transfers between hostels are switched off in hostel settings');
            }
            if (await HostelTransferRequest.exists({ school: req.schoolId, allocation: current._id, status: 'pending' })) {
                return bad(res, 'A room change is already waiting for approval for this resident');
            }
            const row = await HostelTransferRequest.create({
                school: req.schoolId, student: current.student, allocation: current._id, hostel: current.hostel,
                fromBed: current.bed, toBed: target._id, toHostel: target.hostel, reason,
                requestNumber: await nextNumber(HostelTransferRequest, req.schoolId, 'HTR', false, { fresh: true }),
                requestedBy: req.userId, requestedByRole: 'warden',
            });
            const who = await User.findById(current.student).select('name').lean();
            await logAudit(req, { action: 'create', entityType: 'HostelTransferRequest', entityId: row._id, hostel: current.hostel,
                description: `Asked to move ${who?.name} (${row.requestNumber})`, meta: { reason } });
            notifyHostelStaff(req, { hostelId: current.hostel, title: 'Room change waiting for approval',
                body: `${req.user?.name || 'A warden'} asked to move ${who?.name}. ${reason}` });
            return ok(res, { pending: true, request: row });
        }

        const r = await alloc.transferBed({
            schoolId: req.schoolId, allocationId: req.params.id, toBedId: bed,
            actorId: req.userId, actorName: req.user?.name || '', reason, effectiveDate, settings,
        });

        const [room, hostel, student] = await Promise.all([
            HostelRoom.findById(r.to.room).select('roomNumber').lean(),
            Hostel.findById(r.to.hostel).select('name').lean(),
            User.findById(current.student).select('name').lean(),
        ]);
        await logAudit(req, { action: 'transfer', entityType: 'HostelAllocation', entityId: r.allocation._id, hostel: target.hostel,
            description: `Transferred ${student?.name} to ${hostel?.name} · Room ${room?.roomNumber}`,
            before: { room: String(current.room), bed: String(current.bed) },
            after: { room: String(r.to.room), bed: String(r.to.bed) }, meta: { reason } });
        await notifyStudentAndParents(req, {
            studentId: current.student, settings,
            title: 'Hostel transfer',
            body: `You have been moved to ${hostel?.name}, Room ${room?.roomNumber}.${reason ? ` Reason: ${reason}` : ''}`,
        });
        ok(res, r.allocation);
    } catch (e) { handle(res, e); }
};

/** What a checkout has to settle: dues, the deposit held, items on issue, and what will be ended. */
async function checkoutSummary(schoolId, studentId) {
    const mine = { school: schoolId, student: studentId };
    const [dues, dep, assets, mess, leaves, passes, visits] = await Promise.all([
        HostelFeeInvoice.find({ ...mine, status: { $in: ['pending', 'partial', 'overdue'] }, feeType: { $ne: 'security_deposit' } }).select('netAmount paidAmount').lean(),
        payments.deposits(schoolId, studentId),
        HostelAsset.find({ school: schoolId, issuedTo: studentId, status: 'issued' }).select('name assetCode').lean(),
        HostelMessMember.countDocuments({ ...mine, status: 'active' }),
        HostelLeave.countDocuments({ ...mine, status: { $in: ['pending', 'parent_approved', 'approved'] } }),
        HostelOutpass.countDocuments({ ...mine, status: { $in: ['pending', 'approved'] } }),
        HostelVisitor.countDocuments({ ...mine, isTemplate: false, status: { $in: ['pending', 'approved'] } }),
    ]);
    return {
        outstandingDues: payments.round2(dues.reduce((t, i) => t + Math.max(0, (i.netAmount || 0) - (i.paidAmount || 0)), 0)),
        depositHeld: dep.total,
        depositInvoices: dep.held.map((x) => ({ _id: x.invoice._id, invoiceNumber: x.invoice.invoiceNumber, held: x.held,
            online: (x.invoice.payments || []).some((p) => p.mode === 'online' && p.gatewayPaymentId) })),
        unpaidDeposits: dep.unpaid.length,
        unreturnedAssets: assets,
        willEnd: { messEnrolments: mess, leaves, outpasses: passes, visits },
    };
}

exports.getCheckout = async (req, res) => {
    try {
        const a = await HostelAllocation.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!a) return bad(res, 'Allocation not found', 404);
        if (!await mayTouchHostel(req, a.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        ok(res, await checkoutSummary(req.schoolId, a.student));
    } catch (e) { fail(res, e); }
};

/**
 * Year-end rollover: each resident of the closing year either carries on in
 * the same bed under the new academic year, or checks out.
 *
 * A stay belongs to an academic year (fees, reports and the admissions of the
 * year are read by it), so without this every resident stays filed under a
 * year that has ended. Carrying forward keeps the bed and the allocation — it
 * is the same stay — and writes a history line; checking out goes through the
 * ordinary release, with everything that implies.
 */
exports.rolloverAllocations = async (req, res) => {
    try {
        const { toYear, carry = [], vacate = [], reason = '' } = req.body;
        if (!toYear) return bad(res, 'Choose the academic year to carry residents into');
        const year = await AcademicYear.findOne({ _id: toYear, school: req.schoolId }).select('yearName').lean();
        if (!year) return bad(res, 'Academic year not found');
        const ids = [...new Set([...carry, ...vacate].map(String))];
        if (!ids.length) return bad(res, 'Pick at least one resident');
        if (carry.some((id) => vacate.map(String).includes(String(id)))) return bad(res, 'A resident is either carried forward or checked out, not both');

        const rows = await HostelAllocation.find({ _id: { $in: ids }, school: req.schoolId, status: 'active' }).lean();
        const byId = Object.fromEntries(rows.map((a) => [String(a._id), a]));
        const names = Object.fromEntries((await User.find({ _id: { $in: rows.map((a) => String(a.student)) } }).select('name').lean()).map((u) => [String(u._id), u.name]));
        const carried = []; const vacated = []; const failed = [];

        for (const id of carry.map(String)) {
            const a = byId[id];
            if (!a) { failed.push({ allocation: id, reason: 'Not an active allocation' }); continue; }
            if (String(a.academicYear) === String(toYear)) { failed.push({ allocation: id, studentName: names[String(a.student)], reason: `Already in ${year.yearName}` }); continue; }
            await HostelAllocation.findByIdAndUpdate(a._id, { $set: { academicYear: toYear } });
            await HostelAllocationHistory.create({
                school: req.schoolId, student: a.student, allocation: a._id, academicYear: toYear, action: 'rolled_over',
                toHostel: a.hostel, toRoom: a.room, toBed: a.bed, studentName: names[String(a.student)] || '',
                reason: reason || `Carried forward to ${year.yearName}`, effectiveDate: new Date(),
                performedBy: req.userId, performedByName: req.user?.name || '',
            });
            carried.push(id);
        }
        for (const id of vacate.map(String)) {
            const a = byId[id];
            if (!a) { failed.push({ allocation: id, reason: 'Not an active allocation' }); continue; }
            try {
                await alloc.releaseBed({ schoolId: req.schoolId, allocationId: id, actorId: req.userId, actorName: req.user?.name || '',
                    reason: reason || 'Year-end checkout', status: 'vacated' });
                const mine = { school: req.schoolId, student: a.student };
                const gone = new Date();
                await Promise.all([
                    HostelMessMember.updateMany({ ...mine, status: 'active' }, { $set: { status: 'ended', toDate: gone } }),
                    HostelLeave.updateMany({ ...mine, status: { $in: ['pending', 'parent_approved', 'approved'] } }, { $set: { status: 'cancelled', cancelledAt: gone } }),
                    HostelOutpass.updateMany({ ...mine, status: { $in: ['pending', 'approved'] } }, { $set: { status: 'cancelled', qrToken: '' } }),
                    HostelVisitor.updateMany({ ...mine, isTemplate: false, status: { $in: ['pending', 'approved'] } }, { $set: { status: 'cancelled', qrToken: '' } }),
                ]);
                vacated.push(id);
            } catch (err) { failed.push({ allocation: id, studentName: names[String(a.student)], reason: err.message }); }
        }
        await logAudit(req, { action: 'rollover', entityType: 'HostelAllocation',
            description: `Year-end rollover to ${year.yearName}: ${carried.length} carried forward, ${vacated.length} checked out${failed.length ? `, ${failed.length} not done` : ''}`,
            meta: { toYear, carried: carried.length, vacated: vacated.length, failed: failed.length } });
        ok(res, { carried: carried.length, vacated: vacated.length, failed });
    } catch (e) { handle(res, e); }
};

// ── Online payments, for the fee desk ────────────────────────────────────────
/**
 * Every online checkout: the ones that went through, the ones nobody confirmed
 * (the money may or may not have moved), and money taken that could not be
 * placed. This is the list that says whether the gateway and the books agree.
 */
exports.getOnlinePayments = async (req, res) => {
    try {
        const params = [String(req.schoolId)];
        let where = 'x."school" = $1';
        const tab = String(req.query.tab || 'open');
        if (tab === 'open') where += ` AND (x."status" = 'created' OR COALESCE(x."unapplied", 0) > 0)`;
        else if (['paid', 'expired', 'created'].includes(tab)) { params.push(tab); where += ` AND x."status" = $${params.length}`; }
        const { rows } = await pool.query(
            `SELECT x."_id", x."orderId", x."amount", x."status", x."paymentId", x."receiptNumber", x."paidAt", x."unapplied", x."lines",
                    x."createdAt", x."lastCheckedAt", x."confirmedBy", x."openedByRole",
                    u."_id" AS "studentId", u."name" AS "studentName", u."profileImage" AS "studentPhoto",
                    CASE WHEN u."role" = 'teacher' THEN 'teacher' ELSE 'student' END AS "studentKind", ob."name" AS "openedByName"
               FROM "${require('../models/HostelPaymentOrder').tableName}" x
               LEFT JOIN "users" u ON u."_id" = x."student"
               LEFT JOIN "users" ob ON ob."_id" = x."openedBy"
              WHERE ${where} ORDER BY x."createdAt" DESC LIMIT 300`, params);
        const { rows: [c] } = await pool.query(
            `SELECT count(*) FILTER (WHERE "status" = 'created')::int AS "unconfirmed",
                    count(*) FILTER (WHERE COALESCE("unapplied", 0) > 0)::int AS "unapplied",
                    count(*) FILTER (WHERE "status" = 'paid')::int AS "paid",
                    count(*) FILTER (WHERE "status" = 'expired')::int AS "expired"
               FROM "${require('../models/HostelPaymentOrder').tableName}" WHERE "school" = $1`, [String(req.schoolId)]);
        ok(res, { rows, counts: c });
    } catch (e) { fail(res, e); }
};

/** Ask the gateway about one unconfirmed checkout, now. */
exports.checkOnlinePayment = async (req, res) => {
    try {
        const r = await payments.reconcileOrder(req, String(req.params.orderId));
        if (r.error) return bad(res, `The gateway could not be asked: ${r.error}`);
        ok(res, r);
    } catch (e) { handle(res, e); }
};

// ── Room changes waiting for a decision ─────────────────────────────────────
/** The requests, newest first — a warden's own hostels, or the whole school. */
exports.getTransferRequests = async (req, res) => {
    try {
        const allowed = await visibleHostelIds(req);
        const params = [String(req.schoolId)];
        let where = 'x."school" = $1';
        if (allowed !== null) { params.push(allowed.map(String)); where += ` AND x."hostel" = ANY($${params.length}::uuid[])`; }
        if (['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) { params.push(req.query.status); where += ` AND x."status" = $${params.length}`; }
        const { rows } = await pool.query(
            `SELECT x.*, u."name" AS "studentName", u."profileImage" AS "studentPhoto",
                    CASE WHEN u."role" = 'teacher' THEN 'teacher' ELSE 'student' END AS "studentKind",
                    rq."name" AS "requestedByName", db."name" AS "decidedByName",
                    fh."name" AS "fromHostelName", fr."roomNumber" AS "fromRoom", fb."bedNumber" AS "fromBedNumber",
                    th."name" AS "toHostelName", tr."roomNumber" AS "toRoom", tb."bedNumber" AS "toBedNumber", tb."status" AS "toBedStatus"
               FROM "${HostelTransferRequest.tableName}" x
               LEFT JOIN "users" u ON u."_id" = x."student"
               LEFT JOIN "users" rq ON rq."_id" = x."requestedBy"
               LEFT JOIN "users" db ON db."_id" = x."decidedBy"
               LEFT JOIN "${HostelBed.tableName}" fb ON fb."_id" = x."fromBed"
               LEFT JOIN "${HostelRoom.tableName}" fr ON fr."_id" = fb."room"
               LEFT JOIN "${Hostel.tableName}" fh ON fh."_id" = x."hostel"
               LEFT JOIN "${HostelBed.tableName}" tb ON tb."_id" = x."toBed"
               LEFT JOIN "${HostelRoom.tableName}" tr ON tr."_id" = tb."room"
               LEFT JOIN "${Hostel.tableName}" th ON th."_id" = COALESCE(x."toHostel", x."hostel")
              WHERE ${where}
              ORDER BY (x."status" = 'pending') DESC, x."createdAt" DESC LIMIT 200`, params);
        ok(res, { rows, pending: rows.filter((r) => r.status === 'pending').length });
    } catch (e) { fail(res, e); }
};

/**
 * Approve (and carry out) or reject a room change. Approving a resident's own
 * request needs a bed — they said why, the office says where.
 */
exports.decideTransferRequest = async (req, res) => {
    try {
        const { action, remark = '', bed = null } = req.body;
        if (!['approve', 'reject'].includes(action)) return bad(res, 'Action must be approve or reject');
        const t = await HostelTransferRequest.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!t) return bad(res, 'Request not found', 404);
        if (t.status !== 'pending') return bad(res, `This request is already ${t.status}`);

        const settings = await getSettings(req.schoolId);
        const set = { status: action === 'approve' ? 'approved' : 'rejected', decidedBy: req.userId, decidedAt: new Date(), decisionRemark: remark };
        let moved = null;
        if (action === 'approve') {
            const toBed = bed || t.toBed;
            if (!toBed) return bad(res, 'Choose the bed to move them to');
            const current = await HostelAllocation.findOne({ _id: t.allocation, school: req.schoolId }).lean();
            if (!current || !['pending', 'active'].includes(current.status)) {
                return bad(res, 'This resident no longer holds the bed the request was made from — reject it instead');
            }
            moved = await alloc.transferBed({
                schoolId: req.schoolId, allocationId: t.allocation, toBedId: toBed,
                actorId: req.userId, actorName: req.user?.name || '', reason: t.reason || t.preference || 'Room change approved', settings,
            });
            set.toBed = toBed; set.toHostel = moved.to.hostel; set.newAllocation = moved.allocation._id;
        } else if (!String(remark).trim()) return bad(res, 'Say why the request is turned down');

        const updated = await HostelTransferRequest.findByIdAndUpdate(t._id, { $set: set }, { new: true });
        const who = await User.findById(t.student).select('name').lean();
        await logAudit(req, { action, entityType: 'HostelTransferRequest', entityId: t._id, hostel: t.hostel,
            description: `Room change ${t.requestNumber} for ${who?.name} ${set.status}`, meta: { remark } });
        if (moved) {
            const [room, hostel] = await Promise.all([
                HostelRoom.findById(moved.to.room).select('roomNumber').lean(), Hostel.findById(moved.to.hostel).select('name').lean(),
            ]);
            await notifyStudentAndParents(req, { studentId: t.student, settings, title: 'Hostel transfer',
                body: `You have been moved to ${hostel?.name}, Room ${room?.roomNumber}.` });
        } else {
            await notifyStudentAndParents(req, { studentId: t.student, settings, title: 'Room change not approved',
                body: `The room change request ${t.requestNumber} was not approved. ${remark}` });
        }
        // Whoever asked hears the answer.
        if (t.requestedBy && String(t.requestedBy) !== String(t.student)) {
            const { notify } = require('../services/notifyService');
            notify({ school: req.schoolId, sender: req.userId, senderRole: req.userRole, recipients: [String(t.requestedBy)],
                title: `Room change ${set.status}`, body: `${t.requestNumber} for ${who?.name} was ${set.status}.${remark ? ` ${remark}` : ''}`, link: { type: 'hostel' } });
        }
        ok(res, updated);
    } catch (e) { handle(res, e); }
};

// Release / vacate — the allocation closes, the bed frees, history is kept.
exports.releaseAllocation = async (req, res) => {
    try {
        const { reason = '', status = 'vacated', vacatedDate = null, refundDeposit = false, refundReference = '', refundViaGateway = false } = req.body;
        const current = await HostelAllocation.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!current) return bad(res, 'Allocation not found', 404);
        if (!await mayTouchHostel(req, current.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const closed = await alloc.releaseBed({
            schoolId: req.schoolId, allocationId: req.params.id,
            actorId: req.userId, actorName: req.user?.name || '', reason, status, vacatedDate,
        });

        const settings = await getSettings(req.schoolId);
        const [student, hostel] = await Promise.all([
            User.findById(current.student).select('name').lean(),
            Hostel.findById(current.hostel).select('name').lean(),
        ]);
        await logAudit(req, { action: status === 'cancelled' ? 'cancel' : 'release',
            entityType: 'HostelAllocation', entityId: current._id, hostel: current.hostel,
            description: `${status === 'cancelled' ? 'Cancelled' : 'Vacated'} allocation for ${student?.name}`,
            before: { status: current.status }, after: { status }, meta: { reason } });

        // What only a resident can hold ends with the stay: the mess enrolment
        // (or they stay on the meal register), and requests not yet used — an
        // approved pass would otherwise still open the gate for someone who
        // no longer lives here.
        const gone = new Date();
        const mine = { school: req.schoolId, student: current.student };
        const [mess, leavesOff, passesOff, visitsOff] = await Promise.all([
            HostelMessMember.updateMany({ ...mine, status: 'active' }, { $set: { status: 'ended', toDate: gone } }),
            HostelLeave.updateMany({ ...mine, status: { $in: ['pending', 'parent_approved', 'approved'] } }, { $set: { status: 'cancelled', cancelledAt: gone } }),
            HostelOutpass.updateMany({ ...mine, status: { $in: ['pending', 'approved'] } }, { $set: { status: 'cancelled', qrToken: '' } }),
            HostelVisitor.updateMany({ ...mine, isTemplate: false, status: { $in: ['pending', 'approved'] } }, { $set: { status: 'cancelled', qrToken: '' } }),
        ]);
        const n = (r) => r?.modifiedCount ?? r?.nModified ?? r?.rowCount ?? 0;
        const ended = { messEnrolments: n(mess), leaves: n(leavesOff), outpasses: n(passesOff), visits: n(visitsOff) };

        // The deposit. One billed and never paid is no longer owed; one that was
        // paid is handed back here when the form says so — otherwise it stays
        // held, and the reply says how much.
        const dep = await payments.deposits(req.schoolId, current.student);
        for (const inv of dep.unpaid) {
            inv.status = 'cancelled';
            await inv.save();
            await postToLedger({ schoolId: req.schoolId, studentId: inv.student, academicYearId: inv.academicYear,
                entryType: 'credit', category: 'adjustment', amount: inv.netAmount,
                description: `Hostel deposit ${inv.invoiceNumber} cancelled at checkout`, invoiceId: inv._id, createdBy: req.userId, settings });
        }
        let depositRefunded = 0; let depositHeld = dep.total; const vouchers = [];
        if (refundDeposit === true || refundDeposit === 'true') {
            for (const { invoice, held } of dep.held) {
                try {
                    const r = await payments.refund(req, invoice, held, {
                        reference: refundReference, reason: 'Security deposit returned at checkout',
                        viaGateway: (refundViaGateway === true || refundViaGateway === 'true') && (invoice.payments || []).some((p) => p.mode === 'online' && p.gatewayPaymentId),
                    });
                    depositRefunded += held; depositHeld -= held; vouchers.push(r.voucherNumber);
                } catch (err) { ended.depositError = err.message; }
            }
        }

        // Outstanding money and unreturned assets follow the student out.
        const [dues, assets] = await Promise.all([
            HostelFeeInvoice.aggregate([
                { $match: { school: toId(req.schoolId), student: toId(current.student), status: { $in: ['pending', 'partial', 'overdue'] } } },
                { $group: { _id: null, billed: { $sum: '$netAmount' }, paid: { $sum: '$paidAmount' } } },
            ]),
            HostelAsset.countDocuments({ school: req.schoolId, issuedTo: current.student, status: 'issued' }),
        ]);
        const outstanding = Math.max(0, (dues[0]?.billed || 0) - (dues[0]?.paid || 0));
        if (depositHeld > 0) {
            await notifyHostelStaff(req, { hostelId: current.hostel, includeSender: true,
                title: 'Security deposit still held',
                body: `${student?.name} has checked out of ${hostel?.name} with a deposit of ${depositHeld} still held. Refund it from Hostel Fees.` });
        }

        await notifyStudentAndParents(req, {
            studentId: current.student, settings,
            title: 'Hostel checkout',
            body: `Your stay at ${hostel?.name} has been closed.`
                + (outstanding ? ` Outstanding hostel dues: ${outstanding}.` : '')
                + (assets ? ` ${assets} hostel item(s) are still on issue.` : '')
                + (depositRefunded ? ` Your security deposit of ${depositRefunded} has been refunded.` : depositHeld > 0 ? ` Your security deposit of ${depositHeld} will be refunded by the hostel office.` : ''),
        });
        ok(res, { allocation: closed, outstandingDues: outstanding, unreturnedAssets: assets, ended, depositRefunded, depositHeld, vouchers });
    } catch (e) { handle(res, e); }
};

exports.getAllocationHistory = async (req, res) => {
    try {
        const q = { school: req.schoolId };
        if (req.query.student) q.student = req.query.student;
        if (req.params.id) q.allocation = req.params.id;
        // On a posting: only moves into or out of the caller's own hostels.
        const allowed = await visibleHostelIds(req);
        if (allowed !== null) {
            if (!allowed.length) return ok(res, []);
            q.$or = [{ toHostel: { $in: allowed } }, { fromHostel: { $in: allowed } }];
        }
        const rows = await HostelAllocationHistory.find(q).sort('-createdAt').limit(200)
            .populate('performedBy', 'name')
            .populate('fromRoom', 'roomNumber').populate('toRoom', 'roomNumber')
            .populate('fromHostel', 'name').populate('toHostel', 'name').lean();
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

/**
 * A student's complete hostel profile (spec §9).
 *
 * Extends the existing student record rather than copying it: identity and
 * medical data come from User + StudentProfile, everything else is the hostel's
 * own history. This is what the Students screen embeds as a "Hostel" tab.
 */
exports.getStudentHostelProfile = async (req, res) => {
    try {
        const studentId = req.params.studentId;
        const snapshot = await studentSnapshot(req.schoolId, studentId);
        if (!snapshot) return bad(res, 'Student not found', 404);

        const [current, previous, admissions, attendance, leaves, outpasses,
               visitors, invoices, complaints, incidents, discipline, assets, messMember] = await Promise.all([
            HostelAllocation.findOne({ school: req.schoolId, student: studentId, status: { $in: ['pending', 'active'] } })
                .populate('hostel', 'name code contactNumber warden')
                .populate('building', 'name').populate('floor', 'name floorNumber')
                .populate('room', 'roomNumber roomType facilities').populate('bed', 'bedNumber code').lean(),
            HostelAllocation.find({ school: req.schoolId, student: studentId, status: { $in: ['transferred', 'vacated', 'cancelled'] } })
                .sort('-createdAt').limit(20)
                .populate('hostel', 'name').populate('room', 'roomNumber').populate('bed', 'bedNumber').lean(),
            HostelAdmission.find({ school: req.schoolId, student: studentId }).sort('-createdAt')
                .populate('hostel', 'name').populate('academicYear', 'yearName').lean(),
            HostelAttendance.find({ school: req.schoolId, student: studentId }).sort('-date').limit(30).lean(),
            HostelLeave.find({ school: req.schoolId, student: studentId }).sort('-fromDate').limit(20).lean(),
            HostelOutpass.find({ school: req.schoolId, student: studentId }).sort('-departureDate').limit(20).lean(),
            HostelVisitor.find({ school: req.schoolId, student: studentId, isTemplate: false }).sort('-createdAt').limit(20).lean(),
            HostelFeeInvoice.find({ school: req.schoolId, student: studentId }).sort('-createdAt').limit(30).lean(),
            HostelComplaint.find({ school: req.schoolId, student: studentId }).sort('-createdAt').limit(20).lean(),
            HostelIncident.find({ school: req.schoolId, student: studentId }).sort('-date').limit(20).lean(),
            HostelDiscipline.find({ school: req.schoolId, student: studentId }).sort('-date').limit(20).lean(),
            HostelAsset.find({ school: req.schoolId, issuedTo: studentId }).lean(),
            HostelMessMember.findOne({ school: req.schoolId, student: studentId, status: 'active' })
                .populate('mess', 'name code mealTimings').lean(),
        ]);

        if (current && !await mayTouchHostel(req, current.hostel?._id || current.hostel)) {
            return bad(res, 'You do not have access to this hostel', 403);
        }

        // Warden name for the "who do I call" line.
        let warden = null;
        if (current?.hostel?.warden) warden = await User.findById(current.hostel.warden).select('name email phone').lean();

        const attSummary = attendance.reduce((m, a) => { m[a.status] = (m[a.status] || 0) + 1; return m; }, {});
        const feeSummary = invoices.reduce((m, i) => {
            m.billed += i.netAmount || 0; m.paid += i.paidAmount || 0; return m;
        }, { billed: 0, paid: 0 });
        feeSummary.outstanding = Math.max(0, feeSummary.billed - feeSummary.paid);

        ok(res, {
            student: snapshot,
            hostelStatus: current ? 'resident' : (admissions.some((a) => ['applied', 'pending_approval'].includes(a.status)) ? 'applied' : 'not_resident'),
            current, warden, previousAllocations: previous, admissions,
            attendance, attendanceSummary: attSummary,
            leaves, outpasses, visitors,
            invoices, feeSummary,
            complaints, incidents, discipline, assets, mess: messMember,
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  HOSTEL ATTENDANCE (spec §11)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * The register for one hostel / date / session: every current resident, with
 * whatever has already been marked. Room- and floor-wise views are the same call
 * with a filter, so the UI has one endpoint to drive all three.
 */
exports.getAttendanceRegister = async (req, res) => {
    try {
        const { hostel, session = 'morning', date, room, floor, building } = req.query;
        if (!hostel) return bad(res, 'Hostel is required');
        if (!await mayTouchHostel(req, hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const { start, end } = dayRange(date);

        const q = { school: req.schoolId, hostel, status: 'active' };
        if (room) q.room = room;
        if (floor) q.floor = floor;
        if (building) q.building = building;

        const settings = await getSettings(req.schoolId);
        const residents = (await HostelAllocation.find(q)
            .populate('student', 'name email profileImage')
            .populate('room', 'roomNumber').populate('floor', 'name floorNumber')
            .populate('building', 'name').sort('createdAt').lean())
            // Staff who live in are not called at roll call, unless the school asks for it.
            .filter((r) => settings.rollCallIncludesTeachers || resident.residentKind(r) !== 'teacher');

        const studentIds = residents.map((r) => String(r.student?._id || r.student));
        const [marked, onLeave, onOutpass] = await Promise.all([
            HostelAttendance.find({
                school: req.schoolId, student: { $in: studentIds },
                date: { $gte: start, $lt: end }, session,
            }).lean(),
            HostelLeave.find({
                school: req.schoolId, student: { $in: studentIds },
                status: { $in: ['approved', 'active'] },
                fromDate: { $lte: end }, toDate: { $gte: start },
            }).select('student leaveType toDate').lean(),
            HostelOutpass.find({
                school: req.schoolId, student: { $in: studentIds }, status: { $in: ['active', 'overdue'] },
            }).select('student expectedReturnAt status').lean(),
        ]);

        const markMap  = Object.fromEntries(marked.map((m) => [String(m.student), m]));
        const leaveMap = Object.fromEntries(onLeave.map((l) => [String(l.student), l]));
        const outMap   = Object.fromEntries(onOutpass.map((o) => [String(o.student), o]));

        const rows = residents.map((r) => {
            const sid = String(r.student?._id || r.student);
            return {
                student: r.student, allocation: r._id,
                room: r.room, floor: r.floor, building: r.building,
                presence: r.presence,
                record: markMap[sid] || null,
                // Suggested status the marker can accept in one click.
                suggested: leaveMap[sid] ? 'on_leave' : outMap[sid] ? 'excused' : 'present',
                onLeave: leaveMap[sid] || null,
                onOutpass: outMap[sid] || null,
            };
        });
        const summary = rows.reduce((m, r) => {
            const s = r.record?.status || 'unmarked';
            m[s] = (m[s] || 0) + 1; return m;
        }, {});
        ok(res, { date: start, session, rows, summary, total: rows.length });
    } catch (e) { fail(res, e); }
};

/**
 * Bulk roll call (spec §11). Upserts one row per student for the date+session,
 * so re-submitting a register updates it instead of failing on the unique index.
 */
exports.markAttendance = async (req, res) => {
    try {
        const { hostel, session = 'morning', date, records = [] } = req.body;
        if (!hostel || !records.length) return bad(res, 'Hostel and at least one record are required');
        if (!await mayTouchHostel(req, hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const settings = await getSettings(req.schoolId);
        if (settings.attendanceSessions?.length && !settings.attendanceSessions.includes(session)) {
            return bad(res, `'${session}' is not one of this school's hostel attendance sessions`);
        }
        const { start, end } = dayRange(date);
        if (start > new Date()) return bad(res, 'Attendance cannot be marked for a future date');

        const allocations = await HostelAllocation.find({
            school: req.schoolId, hostel, status: 'active',
            student: { $in: records.map((r) => String(r.student)) },
        }).lean();
        const byStudent = Object.fromEntries(allocations.map((a) => [String(a.student), a]));

        // One read for everything already marked, rather than one per student.
        const marked = await HostelAttendance.find({
            school: req.schoolId, student: { $in: records.map((r) => String(r.student)) },
            date: { $gte: start, $lt: end }, session,
        }).lean();
        const existingBy = Object.fromEntries(marked.map((m) => [String(m.student), m]));

        let created = 0; let updated = 0; const skipped = [];
        for (const r of records) {
            const a = byStudent[String(r.student)];
            if (!a) { skipped.push({ student: r.student, reason: 'Not an active resident of this hostel' }); continue; }
            if (!['present', 'absent', 'late', 'excused', 'on_leave'].includes(r.status)) {
                skipped.push({ student: r.student, reason: `Unsupported status '${r.status}'` }); continue;
            }
            const existing = existingBy[String(r.student)];

            if (existing) {
                // A re-submit is an ordinary edit; a later change of mind goes
                // through the correction endpoint, which keeps the old value.
                // A remark is part of the mark: changing only the remark (or
                // clearing it) is saved too, which the old `||` silently dropped.
                const remarks = r.remarks === undefined ? existing.remarks : String(r.remarks || '');
                const statusChanged = existing.status !== r.status;
                if (statusChanged || remarks !== (existing.remarks || '')) {
                    await HostelAttendance.findByIdAndUpdate(existing._id, {
                        $set: statusChanged
                            ? { status: r.status, remarks, markedBy: req.userId, markedAt: new Date() }
                            : { remarks },
                    });
                    updated += 1;
                }
            } else {
                await HostelAttendance.create({
                    school: req.schoolId, hostel, student: r.student, allocation: a._id,
                    building: a.building, floor: a.floor, room: a.room,
                    date: start, session, status: r.status, remarks: r.remarks || '',
                    markedBy: req.userId, markedAt: new Date(),
                });
                created += 1;
            }
        }

        await logAudit(req, { action: 'mark_attendance', entityType: 'HostelAttendance', hostel,
            description: `Marked ${session} attendance: ${created} new, ${updated} updated`,
            meta: { date: start, session, created, updated, skipped: skipped.length } });

        // Absentees are what parents actually want to hear about.
        const absent = records.filter((r) => r.status === 'absent' && byStudent[String(r.student)]);
        for (const r of absent) {
            notifyStudentAndParents(req, {
                studentId: r.student, settings,
                title: 'Hostel attendance — absent',
                body: `Marked absent at the ${session} hostel roll call on ${start.toDateString()}.`,
                email: false,
            });
        }
        ok(res, { created, updated, skipped });
    } catch (e) { fail(res, e); }
};

/**
 * Correct a marked record (spec §11). The previous value is preserved and, when
 * settings require it, the correction waits for approval before it counts.
 */
exports.correctAttendance = async (req, res) => {
    try {
        const { status, reason = '' } = req.body;
        if (!status) return bad(res, 'The corrected status is required');

        const row = await HostelAttendance.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Attendance record not found', 404);
        if (!await mayTouchHostel(req, row.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (row.status === status) return bad(res, 'That is already the recorded status');

        const settings = await getSettings(req.schoolId);
        const ageDays = Math.floor((Date.now() - new Date(row.date)) / 864e5);
        if (settings.attendanceCorrectionWindowDays && ageDays > settings.attendanceCorrectionWindowDays) {
            return bad(res, `Corrections are only allowed within ${settings.attendanceCorrectionWindowDays} day(s)`);
        }

        const needsApproval = settings.attendanceCorrectionNeedsApproval && req.userRole !== 'school_admin';
        const updated = await HostelAttendance.findByIdAndUpdate(row._id, {
            $set: {
                status,
                previousStatus: row.status,
                correctedBy: req.userId,
                correctedAt: new Date(),
                correctionReason: reason,
                approvalStatus: needsApproval ? 'pending' : 'approved',
                approvedBy: needsApproval ? null : req.userId,
                approvedAt: needsApproval ? null : new Date(),
            },
        }, { new: true });

        await logAudit(req, { action: 'correct_attendance', entityType: 'HostelAttendance', entityId: row._id, hostel: row.hostel,
            description: `Attendance corrected ${row.status} → ${status}`,
            before: { status: row.status }, after: { status, reason } });
        if (needsApproval) {
            await notifyHostelStaff(req, { hostelId: row.hostel,
                title: 'Attendance correction awaiting approval',
                body: `A ${row.session} attendance record was changed from ${row.status} to ${status}.${reason ? ` Reason: ${reason}` : ''}` });
        }
        ok(res, updated);
    } catch (e) { fail(res, e); }
};

exports.approveAttendanceCorrection = async (req, res) => {
    try {
        const { approve = true, remark = '' } = req.body;
        const row = await HostelAttendance.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Attendance record not found', 404);
        if (!await mayTouchHostel(req, row.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (row.approvalStatus !== 'pending') return bad(res, 'This record has no correction awaiting approval');

        const updated = await HostelAttendance.findByIdAndUpdate(row._id, {
            $set: approve
                ? { approvalStatus: 'approved', approvedBy: req.userId, approvedAt: new Date() }
                // Rejecting restores the value that was there before the correction.
                : { approvalStatus: 'rejected', status: row.previousStatus || row.status, approvedBy: req.userId, approvedAt: new Date() },
        }, { new: true });

        await logAudit(req, { action: approve ? 'approve' : 'reject', entityType: 'HostelAttendance', entityId: row._id, hostel: row.hostel,
            description: `Attendance correction ${approve ? 'approved' : 'rejected'}`, meta: { remark } });
        ok(res, updated);
    } catch (e) { fail(res, e); }
};

exports.getAttendanceHistory = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { student, session, status, from, to, room, floor } = req.query;
        if (student) q.student = student;
        if (session) q.session = session;
        if (status) q.status = status;
        if (room) q.room = room;
        if (floor) q.floor = floor;
        if (from || to) {
            q.date = {};
            if (from) q.date.$gte = dayRange(from).start;
            if (to) q.date.$lt = dayRange(to).end;
        }
        const [rows, total] = await Promise.all([
            HostelAttendance.find(q).sort('-date').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name profileImage').populate('room', 'roomNumber')
                .populate('markedBy', 'name').populate('correctedBy', 'name').lean(),
            HostelAttendance.countDocuments(q),
        ]);
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  LEAVE (spec §12)
// ═════════════════════════════════════════════════════════════════════════════
const LEAVE_OPEN = ['pending', 'parent_approved', 'approved', 'active'];
/** What a leave or outpass form may never set: the workflow owns these. */
const WORKFLOW_FIELDS = ['_id', 'school', 'status', 'qrToken', 'approvedBy', 'approvedAt', 'wardenApprovedBy', 'wardenApprovedAt',
    'parentApprovedBy', 'parentApprovedAt', 'rejectedBy', 'rejectedAt', 'rejectionReason', 'cancelledAt', 'departedAt', 'returnedAt',
    'returnConfirmedBy', 'isOverdue', 'actualDepartureAt', 'actualReturnAt', 'verifiedOutBy', 'verifiedInBy', 'lateReturnMinutes',
    'leaveNumber', 'outpassNumber', 'totalDays', 'expectedReturnAt', 'createdAt', 'updatedAt'];

/**
 * Everything that must hold before a hostel leave is filed. Shared with the
 * student/parent portal so both surfaces enforce the same rules.
 */
async function validateLeave({ schoolId, studentId, fromDate, toDate, settings, ignoreId = null }) {
    const from = new Date(fromDate); const to = new Date(toDate);
    if (Number.isNaN(+from) || Number.isNaN(+to)) throw new alloc.RuleError('Valid from and to dates are required');
    if (to < from) throw new alloc.RuleError('Leave end date cannot be before the start date');

    const days = Math.floor((dayRange(to).start - dayRange(from).start) / 864e5) + 1;
    if (settings.maxLeaveDaysPerRequest && days > settings.maxLeaveDaysPerRequest) {
        throw new alloc.RuleError(`Leave cannot exceed ${settings.maxLeaveDaysPerRequest} day(s) per request`);
    }
    if (settings.minLeaveNoticeDays) {
        const notice = Math.floor((dayRange(from).start - dayRange().start) / 864e5);
        if (notice < settings.minLeaveNoticeDays) {
            throw new alloc.RuleError(`Leave must be applied for at least ${settings.minLeaveNoticeDays} day(s) in advance`);
        }
    }

    const allocation = await HostelAllocation.findOne({ school: schoolId, student: studentId, status: 'active' }).lean();
    if (!allocation) throw new alloc.RuleError('This student is not currently a hostel resident');

    // Overlapping leave.
    const overlapping = await HostelLeave.find({
        school: schoolId, student: studentId, status: { $in: LEAVE_OPEN },
        fromDate: { $lte: dayRange(to).end }, toDate: { $gte: dayRange(from).start },
    }).lean();
    if (overlapping.some((l) => String(l._id) !== String(ignoreId || ''))) {
        throw new alloc.RuleError('This student already has leave covering those dates');
    }
    // "Open" means still waiting AND still ahead: a request for dates already
    // gone, that nobody ever decided, must not use up the allowance for ever.
    const open = await HostelLeave.countDocuments({
        school: schoolId, student: studentId, status: { $in: ['pending', 'parent_approved'] }, toDate: { $gte: dayRange().start },
    });
    if (settings.maxOpenLeavesPerStudent && open >= settings.maxOpenLeavesPerStudent && !ignoreId) {
        throw new alloc.RuleError(`Only ${settings.maxOpenLeavesPerStudent} leave request(s) may be open at a time`);
    }

    // Concurrent outpass (spec §31) — configurable.
    // Only an outpass that touches these dates: one being used now while the
    // leave starts today, or one booked for a day inside the leave. A pass for
    // this afternoon says nothing about a leave next month.
    if (!settings.allowConcurrentLeaveAndOutpass) {
        const startsNow = dayRange(from).start <= dayRange().start;
        const [outNow, booked] = await Promise.all([
            startsNow ? HostelOutpass.countDocuments({ school: schoolId, student: studentId, status: { $in: ['active', 'overdue'] } }) : 0,
            HostelOutpass.countDocuments({
                school: schoolId, student: studentId, status: { $in: ['approved', 'active', 'overdue'] },
                departureDate: { $gte: dayRange(from).start, $lt: dayRange(to).end },
            }),
        ]);
        if (outNow) throw new alloc.RuleError('This resident is out on an outpass — it must be closed before leave can start');
        if (booked) throw new alloc.RuleError('This resident has an outpass on one of those days — cancel it or change the dates');
    }
    return { allocation, days };
}
exports._validateLeave = validateLeave;

exports.getLeaves = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { status, leaveType, student, from, to } = req.query;
        if (status && status !== 'all') q.status = status;
        if (leaveType) q.leaveType = leaveType;
        if (student) q.student = student;
        if (from || to) {
            q.fromDate = {};
            if (from) q.fromDate.$gte = dayRange(from).start;
            if (to) q.fromDate.$lt = dayRange(to).end;
        }
        const [rows, total] = await Promise.all([
            HostelLeave.find(q).sort('-createdAt').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name email profileImage').populate('hostel', 'name')
                .populate('wardenApprovedBy', 'name').populate('parentApprovedBy', 'name').lean(),
            HostelLeave.countDocuments(q),
        ]);
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

exports.createLeave = async (req, res) => {
    try {
        const b = req.body;
        if (!b.student || !b.fromDate || !b.toDate || !b.reason) {
            return bad(res, 'Student, dates and reason are required');
        }
        const settings = await getSettings(req.schoolId);
        const { allocation, days } = await validateLeave({
            schoolId: req.schoolId, studentId: b.student, fromDate: b.fromDate, toDate: b.toDate, settings,
        });
        if (!await mayTouchHostel(req, allocation.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        // Where a request stands is decided by actOnLeave, never by the form.
        const fields = { ...b };
        for (const f of WORKFLOW_FIELDS) delete fields[f];
        // Parent consent is a rule about students. A member of staff has no
        // parent to ask, and a leave that waits for one would wait for ever.
        const kind = resident.residentKind(allocation);
        const row = await HostelLeave.create({
            ...fields,
            school: req.schoolId, hostel: allocation.hostel, allocation: allocation._id,
            academicYear: allocation.academicYear,
            leaveNumber: await nextNumber(HostelLeave, req.schoolId, 'HLV'),
            totalDays: days, status: 'pending',
            parentApprovalRequired: kind === 'teacher' ? false : (b.parentApprovalRequired ?? settings.leaveRequiresParentApproval),
            appliedBy: req.userId, createdBy: req.userId,
        });

        const student = await User.findById(b.student).select('name').lean();
        await logAudit(req, { action: 'create', entityType: 'HostelLeave', entityId: row._id, hostel: allocation.hostel,
            description: `Leave ${row.leaveNumber} filed for ${student?.name} (${days} day(s))` });
        await notifyStudentAndParents(req, {
            studentId: b.student, settings, settingKey: 'notifyParentOnLeave',
            title: 'Hostel leave requested',
            body: `Leave from ${new Date(b.fromDate).toDateString()} to ${new Date(b.toDate).toDateString()} has been requested. Reason: ${b.reason}`,
        });
        ok(res, row);
    } catch (e) { handle(res, e); }
};

/**
 * Act on a leave: parent consent, warden approval, rejection, cancellation,
 * departure and return (spec §12). Presence on the allocation follows, so the
 * "students on leave" dashboard tile stays truthful.
 */
exports.actOnLeave = async (req, res) => {
    try {
        const { action, remark = '' } = req.body;
        const valid = ['parent_approve', 'approve', 'reject', 'cancel', 'depart', 'return'];
        if (!valid.includes(action)) return bad(res, `Action must be one of: ${valid.join(', ')}`);

        const l = await HostelLeave.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!l) return bad(res, 'Leave not found', 404);
        if (!await mayTouchHostel(req, l.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const settings = await getSettings(req.schoolId);
        const now = new Date();
        const set = {};
        let presence = null;

        if (action === 'parent_approve') {
            if (l.status !== 'pending') return bad(res, 'Only a pending request can receive parent consent');
            set.status = 'parent_approved'; set.parentApprovedBy = req.userId; set.parentApprovedAt = now;
        } else if (action === 'approve') {
            if (!['pending', 'parent_approved'].includes(l.status)) return bad(res, `A ${l.status} leave cannot be approved`);
            if (l.parentApprovalRequired && l.status !== 'parent_approved') {
                return bad(res, 'Parent consent is required before this leave can be approved');
            }
            set.status = 'approved'; set.wardenApprovedBy = req.userId; set.wardenApprovedAt = now;
        } else if (action === 'reject') {
            if (!['pending', 'parent_approved'].includes(l.status)) return bad(res, `A ${l.status} leave cannot be rejected`);
            set.status = 'rejected'; set.rejectedBy = req.userId; set.rejectedAt = now; set.rejectionReason = remark;
        } else if (action === 'cancel') {
            if (['returned', 'cancelled', 'rejected'].includes(l.status)) return bad(res, `This leave is already ${l.status}`);
            set.status = 'cancelled'; set.cancelledAt = now;
            if (l.status === 'active') presence = 'in';
        } else if (action === 'depart') {
            if (l.status !== 'approved') return bad(res, 'Only an approved leave can be started');
            set.status = 'active'; set.departedAt = now; presence = 'on_leave';
        } else if (action === 'return') {
            if (!['active', 'overdue'].includes(l.status)) return bad(res, 'Only an active leave can be closed on return');
            set.status = 'returned'; set.returnedAt = now; set.returnConfirmedBy = req.userId;
            set.isOverdue = false; presence = 'in';
        }

        const updated = await HostelLeave.findByIdAndUpdate(l._id, { $set: set }, { new: true });
        if (presence && l.allocation) {
            await HostelAllocation.findByIdAndUpdate(l.allocation, { $set: { presence } });
        }
        // Departure and return are movements too — one gate log for everything.
        if (action === 'depart' || action === 'return') {
            await HostelMovement.create({
                school: req.schoolId, hostel: l.hostel, student: l.student,
                direction: action === 'depart' ? 'out' : 'in',
                movementType: 'leave', reference: l._id, referenceType: 'HostelLeave',
                at: now, remarks: remark, recordedBy: req.userId,
            });
        }

        const student = await User.findById(l.student).select('name').lean();
        await logAudit(req, { action, entityType: 'HostelLeave', entityId: l._id, hostel: l.hostel,
            description: `Leave ${l.leaveNumber} — ${action} (${student?.name})`,
            before: { status: l.status }, after: { status: set.status }, meta: { remark } });

        const messages = {
            parent_approved: 'Parent consent recorded for the hostel leave request.',
            approved: `Hostel leave approved for ${new Date(l.fromDate).toDateString()} – ${new Date(l.toDate).toDateString()}.`,
            rejected: `Hostel leave was not approved.${remark ? ` Reason: ${remark}` : ''}`,
            cancelled: 'Hostel leave has been cancelled.',
            active: 'Departure on hostel leave recorded.',
            returned: 'Return from hostel leave recorded.',
        };
        if (messages[set.status]) {
            await notifyStudentAndParents(req, {
                studentId: l.student, settings, settingKey: 'notifyParentOnLeave',
                title: 'Hostel leave update', body: messages[set.status],
            });
        }
        ok(res, updated);
    } catch (e) { handle(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  OUTPASS (spec §12) — with QR gate verification
// ═════════════════════════════════════════════════════════════════════════════
/** When a pass stops being usable: its stated return, else the end of its day. */
const passEnd = (o) => (o.expectedReturnAt ? new Date(o.expectedReturnAt) : dayRange(o.departureDate).end);

/** Shared outpass validation, used by the admin and the student/parent surface. */
async function validateOutpass({ schoolId, studentId, departureDate, expectedDepartureTime, expectedReturnTime, expectedReturnDate, settings }) {
    const allocation = await HostelAllocation.findOne({ school: schoolId, student: studentId, status: 'active' }).lean();
    if (!allocation) throw new alloc.RuleError('This student is not currently a hostel resident');

    const depAt = atTime(departureDate, expectedDepartureTime);
    const retAt = atTime(expectedReturnDate || departureDate, expectedReturnTime);
    if (depAt && retAt && retAt <= depAt) {
        // An evening pass returning after midnight is legitimate — roll it over.
        // A return DATE was stated, though: a return before leaving is a mistake.
        if (expectedReturnDate) throw new alloc.RuleError('The expected return must be after the departure');
        retAt.setDate(retAt.getDate() + 1);
    }
    if (depAt && retAt && settings.maxOutpassHours) {
        const hours = (retAt - depAt) / 36e5;
        if (hours > settings.maxOutpassHours) {
            throw new alloc.RuleError(`An outpass cannot exceed ${settings.maxOutpassHours} hour(s)`);
        }
    }
    // Outpass window from settings.
    if (expectedDepartureTime && settings.outpassFrom && settings.outpassTo) {
        if (expectedDepartureTime < settings.outpassFrom || expectedDepartureTime > settings.outpassTo) {
            throw new alloc.RuleError(`Outpasses may only start between ${settings.outpassFrom} and ${settings.outpassTo}`);
        }
    }

    // One open outpass at a time — "open" being out right now, or asked for
    // and not yet past. A pass that was approved and never used must not block
    // every later request (the sweep also cancels those, see sweepOverdue).
    const passes = await HostelOutpass.find({
        school: schoolId, student: studentId, status: { $in: ['pending', 'approved', 'active', 'overdue'] },
    }).select('status expectedReturnAt departureDate').lean();
    if (passes.some((o) => ['active', 'overdue'].includes(o.status) || passEnd(o) > new Date())) {
        throw new alloc.RuleError('This student already has an open outpass');
    }

    // On leave ON THAT DAY, or away on leave right now — not "has a leave approved for next month".
    if (!settings.allowConcurrentLeaveAndOutpass) {
        const day = dayRange(departureDate);
        const [away, thatDay] = await Promise.all([
            HostelLeave.countDocuments({ school: schoolId, student: studentId, status: { $in: ['active', 'overdue'] } }),
            HostelLeave.countDocuments({
                school: schoolId, student: studentId, status: { $in: ['approved', 'active'] },
                fromDate: { $lt: day.end }, toDate: { $gte: day.start },
            }),
        ]);
        if (away || thatDay) throw new alloc.RuleError('This student is on leave then — an outpass cannot run at the same time');
    }
    return { allocation, expectedReturnAt: retAt };
}
exports._validateOutpass = validateOutpass;
exports._guardianOf = guardianOf;

exports.getOutpasses = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { status, outpassType, student, date } = req.query;
        if (status && status !== 'all') q.status = status;
        if (outpassType) q.outpassType = outpassType;
        if (student) q.student = student;
        if (date) { const { start, end } = dayRange(date); q.departureDate = { $gte: start, $lt: end }; }

        const [rows, total] = await Promise.all([
            HostelOutpass.find(q).sort('-departureDate').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name email profileImage').populate('hostel', 'name')
                .populate('approvedBy', 'name').lean(),
            HostelOutpass.countDocuments(q),
        ]);
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

exports.createOutpass = async (req, res) => {
    try {
        const b = req.body;
        if (!b.student || !b.purpose || !b.departureDate) {
            return bad(res, 'Student, purpose and departure date are required');
        }
        const settings = await getSettings(req.schoolId);
        const { allocation, expectedReturnAt } = await validateOutpass({
            schoolId: req.schoolId, studentId: b.student,
            departureDate: b.departureDate,
            expectedDepartureTime: b.expectedDepartureTime,
            expectedReturnTime: b.expectedReturnTime, expectedReturnDate: b.expectedReturnDate, settings,
        });
        if (!await mayTouchHostel(req, allocation.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const { expectedReturnDate, ...fields } = b;
        for (const f of WORKFLOW_FIELDS) delete fields[f];
        // Where the school asks for a parent's consent, a student's pass waits
        // for it. Staff have no parent to ask.
        const needsParent = !!settings.outpassRequiresParentApproval && resident.residentKind(allocation) !== 'teacher';
        const row = await HostelOutpass.create({
            ...fields, status: 'pending', parentApprovalRequired: needsParent, parentApprovedBy: null, parentApprovedAt: null,
            school: req.schoolId, hostel: allocation.hostel, allocation: allocation._id, academicYear: allocation.academicYear,
            outpassNumber: await nextNumber(HostelOutpass, req.schoolId, 'OP', true),
            expectedReturnAt,
            requestedBy: b.requestedBy || req.userId,
            createdBy: req.userId,
        });
        const student = await User.findById(b.student).select('name').lean();
        await logAudit(req, { action: 'create', entityType: 'HostelOutpass', entityId: row._id, hostel: allocation.hostel,
            description: `Outpass ${row.outpassNumber} requested for ${student?.name}` });
        await notifyStudentAndParents(req, {
            studentId: b.student, settings, settingKey: 'notifyParentOnOutpass',
            title: needsParent ? 'Outpass needs your consent' : 'Outpass requested',
            body: `An outpass has been requested for ${new Date(b.departureDate).toDateString()}. Purpose: ${b.purpose}`
                + (needsParent ? ' A parent\'s consent is needed before the warden can approve it.' : ''),
            // The consent IS the point of this message: it goes to the parents whatever the notify switch says.
            ...(needsParent ? { settingKey: undefined } : {}),
        });
        ok(res, row);
    } catch (e) { handle(res, e); }
};

/**
 * Approve / reject / cancel an outpass. Approval mints the QR token the gate
 * scans — an opaque random string, so a pass cannot be forged from an id.
 */
exports.actOnOutpass = async (req, res) => {
    try {
        const { action, remark = '' } = req.body;
        const valid = ['approve', 'reject', 'cancel', 'parent_approve'];
        if (!valid.includes(action)) return bad(res, `Action must be one of: ${valid.join(', ')}`);

        const o = await HostelOutpass.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!o) return bad(res, 'Outpass not found', 404);
        if (!await mayTouchHostel(req, o.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const set = {};
        if (action === 'parent_approve') {
            // The office records a consent given in person or on the phone.
            if (o.status !== 'pending') return bad(res, 'Only a pending outpass can receive parent consent');
            if (o.parentApprovedAt) return bad(res, 'Parent consent is already recorded');
            set.parentApprovedBy = req.userId; set.parentApprovedAt = new Date();
        } else if (action === 'approve') {
            if (o.status !== 'pending') return bad(res, `A ${o.status} outpass cannot be approved`);
            if (o.parentApprovalRequired && !o.parentApprovedAt) {
                return bad(res, 'Parent consent is required before this outpass can be approved');
            }
            set.status = 'approved'; set.approvedBy = req.userId; set.approvedAt = new Date();
            set.qrToken = crypto.randomBytes(24).toString('hex');
        } else if (action === 'reject') {
            if (o.status !== 'pending') return bad(res, `A ${o.status} outpass cannot be rejected`);
            set.status = 'rejected'; set.rejectedBy = req.userId; set.rejectionReason = remark;
        } else {
            if (['returned', 'cancelled', 'rejected'].includes(o.status)) return bad(res, `This outpass is already ${o.status}`);
            // Out, or out and late: the pass can only be closed by their return —
            // cancelling it would leave them marked outside with nothing to close.
            if (['active', 'overdue'].includes(o.status)) return bad(res, 'This student is currently out — record their return instead');
            set.status = 'cancelled'; set.qrToken = '';
        }

        const updated = await HostelOutpass.findByIdAndUpdate(o._id, { $set: set }, { new: true });
        if (updated && set.qrToken) updated.qrImage = passImage(set.qrToken);
        const settings = await getSettings(req.schoolId);
        const done = set.status || 'parent consent recorded';
        await logAudit(req, { action, entityType: 'HostelOutpass', entityId: o._id, hostel: o.hostel,
            description: `Outpass ${o.outpassNumber} ${done}`,
            before: { status: o.status }, after: { status: set.status || o.status }, meta: { remark } });
        await notifyStudentAndParents(req, {
            studentId: o.student, settings, settingKey: 'notifyParentOnOutpass',
            title: set.status ? `Outpass ${set.status}` : 'Outpass: parent consent recorded',
            body: set.status ? `Outpass ${o.outpassNumber} is ${set.status}.${remark ? ` ${remark}` : ''}`
                : `Parent consent has been recorded for outpass ${o.outpassNumber}. It now waits for the warden.`,
        });
        ok(res, updated);
    } catch (e) { fail(res, e); }
};

/**
 * Gate scan (spec §12, §20). Resolves the pass from its QR token — never from a
 * client-supplied id — and records departure or return, the movement log, the
 * student's presence and any late return with its fine.
 */
exports.gateScan = async (req, res) => {
    try {
        const { token, outpass, direction, gate = '', remarks = '' } = req.body;
        if (!token && !outpass) return bad(res, 'A QR token or outpass id is required');
        if (!['out', 'in'].includes(direction)) return bad(res, "Direction must be 'out' or 'in'");

        const o = token
            ? await HostelOutpass.findOne({ qrToken: token, school: req.schoolId }).lean()
            : await HostelOutpass.findOne({ _id: outpass, school: req.schoolId }).lean();
        if (!o) return bad(res, 'This pass is not valid', 404);
        if (!await mayTouchHostel(req, o.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const settings = await getSettings(req.schoolId);
        const now = new Date();
        const set = {}; let late = 0;

        if (direction === 'out') {
            if (o.status !== 'approved') return bad(res, `This pass is ${o.status} — it cannot be used to exit`);
            // An approved pass opens the gate on its own day, until its return time.
            if (now < dayRange(o.departureDate).start) return bad(res, `This pass is for ${new Date(o.departureDate).toDateString()} — it cannot be used before then`);
            if (now > passEnd(o)) return bad(res, 'This pass has expired — its return time has already passed');
            set.status = 'active'; set.actualDepartureAt = now; set.verifiedOutBy = req.userId;
        } else {
            if (!['active', 'overdue'].includes(o.status)) return bad(res, `This pass is ${o.status} — there is no exit to close`);
            set.status = 'returned'; set.actualReturnAt = now; set.verifiedInBy = req.userId; set.qrToken = '';
            if (o.expectedReturnAt) {
                const over = minutesBetween(o.expectedReturnAt, now) - (settings.lateReturnGraceMinutes || 0);
                if (over > 0) { late = over; set.lateReturnMinutes = over; }
            }
        }

        const updated = await HostelOutpass.findByIdAndUpdate(o._id, { $set: set }, { new: true });
        await HostelMovement.create({
            school: req.schoolId, hostel: o.hostel, student: o.student,
            direction, movementType: 'outpass', reference: o._id, referenceType: 'HostelOutpass',
            at: now, gate, remarks, isLate: late > 0, lateMinutes: late, recordedBy: req.userId,
        });
        if (o.allocation) {
            await HostelAllocation.findByIdAndUpdate(o.allocation, { $set: { presence: direction === 'out' ? 'out' : 'in' } });
        }

        // A late return is billable when the school has configured a fine.
        let fine = null;
        if (late > 0 && settings.lateReturnFine > 0) {
            fine = await raiseFine(req, {
                studentId: o.student, hostelId: o.hostel, allocationId: o.allocation,
                amount: settings.lateReturnFine,
                remarks: `Late return on outpass ${o.outpassNumber} (${late} min)`,
                settings,
            });
        }

        await logAudit(req, { action: direction === 'out' ? 'gate_out' : 'gate_in',
            entityType: 'HostelOutpass', entityId: o._id, hostel: o.hostel,
            description: `Outpass ${o.outpassNumber} — ${direction === 'out' ? 'departed' : 'returned'}${late ? ` (${late} min late)` : ''}`,
            meta: { gate, lateMinutes: late } });

        if (direction === 'in' && late > 0) {
            await notifyStudentAndParents(req, {
                studentId: o.student, settings, settingKey: 'notifyParentOnLateReturn',
                title: 'Late return to hostel',
                body: `Returned ${late} minute(s) after the expected time on outpass ${o.outpassNumber}.`
                    + (fine ? ` A late fee of ${settings.lateReturnFine} has been raised.` : ''),
            });
        }
        ok(res, { outpass: updated, lateMinutes: late, fine });
    } catch (e) { fail(res, e); }
};

/**
 * The scannable image for an approved pass.
 *
 * Rendered server-side as a PNG data URI (see utils/qrcode.js) so neither the
 * web app nor the Expo app needs a QR library — both simply display an image.
 */
function passImage(token) {
    if (!token) return null;
    return matrixToDataUri(qrcode.encode(token), { scale: 6, quietZone: 4 });
}
exports._passImage = passImage;

// The pass as a standalone PNG, for printing or embedding in an <img src>.
exports.outpassQr = async (req, res) => {
    try {
        const o = await HostelOutpass.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!o) return bad(res, 'Outpass not found', 404);
        if (!await mayTouchHostel(req, o.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (!o.qrToken) return bad(res, 'This outpass has no active pass');
        const { matrixToPng } = require('../utils/pngEncoder');
        const png = matrixToPng(qrcode.encode(o.qrToken), { scale: 8, quietZone: 4 });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `inline; filename="${o.outpassNumber || 'outpass'}.png"`);
        res.send(png);
    } catch (e) { fail(res, e); }
};

// Read a pass by its token — what the scanner app calls before confirming.
exports.verifyOutpass = async (req, res) => {
    try {
        const o = await HostelOutpass.findOne({ qrToken: req.params.token, school: req.schoolId })
            .populate('student', 'name profileImage email')
            .populate('hostel', 'name').lean();
        if (!o) return bad(res, 'This pass is not valid', 404);
        // A pass for another hostel is not this gate's to read — or to wave through.
        if (!await mayTouchHostel(req, o.hostel?._id || o.hostel)) return bad(res, 'This pass belongs to another hostel', 403);
        const room = await HostelAllocation.findOne({ _id: o.allocation }).populate('room', 'roomNumber').lean();
        ok(res, {
            ...o, room: room?.room || null,
            qrImage: passImage(o.qrToken),
            valid: ['approved', 'active', 'overdue'].includes(o.status),
            expectedAction: o.status === 'approved' ? 'out' : ['active', 'overdue'].includes(o.status) ? 'in' : null,
        });
    } catch (e) { fail(res, e); }
};

/**
 * Flip passes and leaves that outlived their return time to 'overdue' and alert
 * once. Idempotent: an already-notified row carries a stamp, so re-running
 * changes nothing. Called by the hourly worker and by the dashboard on demand.
 */
async function sweepOverdue(schoolId) {
    const now = new Date();
    const settings = await getSettings(schoolId);
    const grace = (settings.overdueAlertAfterMinutes || 0) * 60000;
    const cutoff = new Date(now - grace);

    const passes = await HostelOutpass.find({
        school: schoolId, status: 'active', expectedReturnAt: { $ne: null, $lt: cutoff },
    }).lean();
    const leaves = await HostelLeave.find({
        school: schoolId, status: 'active', toDate: { $lt: dayRange().start },
    }).lean();

    for (const p of passes) await HostelOutpass.findByIdAndUpdate(p._id, { $set: { status: 'overdue' } });
    for (const l of leaves) await HostelLeave.findByIdAndUpdate(l._id, { $set: { status: 'overdue', isOverdue: true } });

    // Say so — once. A row is only picked up while it is still 'active', so the
    // flip above is what keeps this from repeating on the next sweep. Somebody
    // not back when they should be is the one thing a hostel must hear about.
    if (passes.length || leaves.length) {
        const sys = await systemRequest(schoolId);
        if (sys) {
            const people = await User.find({ _id: { $in: [...passes, ...leaves].map((x) => String(x.student)) } }).select('name').lean();
            const nameOf = Object.fromEntries(people.map((u) => [String(u._id), u.name]));
            const at = (d) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
            for (const p of passes) {
                const who = nameOf[String(p.student)] || 'A resident';
                notifyHostelStaff(sys, { hostelId: p.hostel, includeSender: true, title: 'Resident overdue from outpass',
                    body: `${who} was due back by ${at(p.expectedReturnAt)} on outpass ${p.outpassNumber} and has not returned.` });
                notifyStudentAndParents(sys, { studentId: p.student, settings, settingKey: 'notifyParentOnLateReturn',
                    title: 'Overdue from hostel outpass',
                    body: `Outpass ${p.outpassNumber} expected a return by ${at(p.expectedReturnAt)}, and no return has been recorded at the hostel gate.` });
            }
            for (const l of leaves) {
                const who = nameOf[String(l.student)] || 'A resident';
                notifyHostelStaff(sys, { hostelId: l.hostel, includeSender: true, title: 'Resident overdue from leave',
                    body: `${who} was due back from leave ${l.leaveNumber} on ${new Date(l.toDate).toDateString()} and has not returned.` });
                notifyStudentAndParents(sys, { studentId: l.student, settings, settingKey: 'notifyParentOnLateReturn',
                    title: 'Overdue from hostel leave',
                    body: `Leave ${l.leaveNumber} ended on ${new Date(l.toDate).toDateString()}, and no return has been recorded at the hostel.` });
            }
        }
    }

    // A pass asked for (or approved) and never used, a day past its time: closed,
    // and its QR with it — otherwise it would open the gate on some later day.
    const dayAgo = new Date(now - 24 * 36e5);
    const stale = (await HostelOutpass.find({ school: schoolId, status: { $in: ['pending', 'approved'] } })
        .select('status expectedReturnAt departureDate remarks').lean()).filter((o) => passEnd(o) < dayAgo);
    for (const o of stale) {
        await HostelOutpass.findByIdAndUpdate(o._id, { $set: {
            status: 'cancelled', qrToken: '',
            remarks: [o.remarks, o.status === 'approved' ? 'Expired — the pass was not used' : 'Expired — not decided in time'].filter(Boolean).join(' · '),
        } });
    }

    // An invoice's stored status only moves when it is saved, so one nobody
    // touched stays 'pending' past its due date. The figures count by status.
    const { rowCount: invoices } = await pool.query(
        `UPDATE "${HostelFeeInvoice.tableName}" SET "status" = 'overdue', "updatedAt" = now()
          WHERE "school" = $1 AND "status" = 'pending' AND "dueDate" IS NOT NULL AND "dueDate" < now()`, [String(schoolId)]);

    return { outpasses: passes.length, leaves: leaves.length, expired: stale.length, invoices, passes, leaveRows: leaves };
}
exports.sweepOverdue = sweepOverdue;

exports.runOverdueSweep = async (req, res) => {
    try {
        const r = await sweepOverdue(req.schoolId);
        if (r.outpasses || r.leaves) {
            await logAudit(req, { action: 'overdue_sweep', entityType: 'HostelOutpass',
                description: `Marked ${r.outpasses} outpass(es) and ${r.leaves} leave(s) overdue` });
        }
        ok(res, { outpasses: r.outpasses, leaves: r.leaves });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  VISITORS (spec §13)
// ═════════════════════════════════════════════════════════════════════════════
exports.getVisitors = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, { isTemplate: req.query.list === 'true' });
        const { status, student, date, listType } = req.query;
        if (status && status !== 'all') q.status = status;
        if (student) q.student = student;
        if (listType) q.listType = listType;
        if (date) { const { start, end } = dayRange(date); q.createdAt = { $gte: start, $lt: end }; }

        const [rows, total] = await Promise.all([
            HostelVisitor.find(q).sort('-createdAt').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name profileImage').populate('hostel', 'name')
                .populate('approvedBy', 'name').lean(),
            HostelVisitor.countDocuments(q),
        ]);
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

/**
 * Is this the person on a standing list? By mobile number when both have one,
 * else by name — the whole name, not a fragment: "Ram" is not "Ramesh Kumar",
 * and the old substring test both blocked the wrong people and let a listed
 * "Ram Kumar" in as "Ram".
 */
const squash = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const sameVisitor = (a, b) => (digits(a.mobile).length >= 7 && digits(a.mobile) === digits(b.mobile))
    || (!!squash(a.visitorName) && squash(a.visitorName) === squash(b.visitorName));
/** The standing-list entry for this visitor of this resident, if there is one. Restricted wins. */
async function listedVisitor(schoolId, studentId, visitor) {
    const lists = await HostelVisitor.find({ school: schoolId, student: studentId, isTemplate: true }).lean();
    const hits = lists.filter((t) => sameVisitor(t, visitor));
    return hits.find((t) => t.listType === 'restricted') || hits[0] || null;
}
exports._listedVisitor = listedVisitor;

exports.createVisitor = async (req, res) => {
    try {
        const b = req.body;
        if (!b.visitorName || !b.student) return bad(res, 'Visitor name and student are required');

        const allocation = await HostelAllocation.findOne({ school: req.schoolId, student: b.student, status: 'active' }).lean();
        if (!allocation) return bad(res, 'This student is not currently a hostel resident');
        if (!await mayTouchHostel(req, allocation.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const settings = await getSettings(req.schoolId);
        const isTemplate = b.isTemplate === true;

        // Standing lists decide the outcome before anyone is troubled for approval.
        let status = b.status || 'pending';
        if (!isTemplate) {
            const listed = await listedVisitor(req.schoolId, b.student, b);
            if (listed?.listType === 'restricted') return bad(res, `${b.visitorName} is on this student's restricted visitor list`);
            if (listed?.listType === 'authorized') status = 'approved';

            // Visiting-hours check (spec §28).
            if (b.scheduledAt && settings.visitorFrom && settings.visitorTo) {
                const t = new Date(b.scheduledAt);
                const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
                if (hhmm < settings.visitorFrom || hhmm > settings.visitorTo) {
                    return bad(res, `Visitors are received between ${settings.visitorFrom} and ${settings.visitorTo}`);
                }
                const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getDay()];
                if (settings.visitorDays?.length && !settings.visitorDays.includes(day)) {
                    return bad(res, `Visitors are received on: ${settings.visitorDays.join(', ')}`);
                }
            }
        }

        const row = await HostelVisitor.create({
            ...b, status, isTemplate,
            school: req.schoolId, hostel: allocation.hostel,
            passNumber: isTemplate ? '' : await nextNumber(HostelVisitor, req.schoolId, 'VP', true),
            qrToken: status === 'approved' && !isTemplate ? crypto.randomBytes(24).toString('hex') : '',
            createdBy: req.userId,
        });

        await logAudit(req, { action: 'create', entityType: 'HostelVisitor', entityId: row._id, hostel: allocation.hostel,
            description: isTemplate ? `Added ${row.visitorName} to the ${row.listType} visitor list` : `Registered visitor ${row.visitorName}` });
        if (!isTemplate) {
            await notifyStudentAndParents(req, {
                studentId: b.student, settings, settingKey: 'notifyOnVisitor',
                title: 'Hostel visitor registered',
                body: `${row.visitorName}${row.relationship ? ` (${row.relationship})` : ''} has been registered as a visitor.`,
                email: false,
            });
        }
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/** Approve / reject / check in / check out a visitor (spec §13). */
exports.actOnVisitor = async (req, res) => {
    try {
        const { action, remark = '' } = req.body;
        const valid = ['approve', 'reject', 'entry', 'exit', 'cancel', 'block'];
        if (!valid.includes(action)) return bad(res, `Action must be one of: ${valid.join(', ')}`);

        const v = await HostelVisitor.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!v) return bad(res, 'Visitor record not found', 404);
        if (!await mayTouchHostel(req, v.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const now = new Date();
        const set = { remarks: remark || v.remarks };

        if (action === 'approve') {
            if (v.status !== 'pending') return bad(res, `A ${v.status} visitor cannot be approved`);
            set.status = 'approved'; set.approvedBy = req.userId; set.approvedAt = now;
            set.qrToken = crypto.randomBytes(24).toString('hex');
        } else if (action === 'reject') {
            if (v.status !== 'pending') return bad(res, `A ${v.status} visitor cannot be rejected`);
            set.status = 'rejected'; set.rejectionReason = remark;
        } else if (action === 'entry') {
            if (v.status !== 'approved') return bad(res, 'Only an approved visitor may be checked in');
            set.status = 'checked_in'; set.entryTime = now;
        } else if (action === 'exit') {
            if (v.status !== 'checked_in') return bad(res, 'This visitor has not been checked in');
            // Exit cannot precede entry (spec §31).
            if (v.entryTime && now < new Date(v.entryTime)) return bad(res, 'Exit time cannot be before entry time');
            set.status = 'checked_out'; set.exitTime = now; set.qrToken = '';
        } else if (action === 'cancel') {
            if (['checked_out', 'cancelled'].includes(v.status)) return bad(res, `This visit is already ${v.status}`);
            set.status = 'cancelled'; set.qrToken = '';
        } else if (action === 'block') {
            set.status = 'blocked'; set.listType = 'restricted'; set.qrToken = '';
            // Blocking a visit must stop the next one too. The restricted LIST is
            // what registration checks, and this visit row is not on it.
            if (!v.isTemplate && v.student && (await listedVisitor(req.schoolId, v.student, v))?.listType !== 'restricted') {
                await HostelVisitor.create({
                    school: req.schoolId, hostel: v.hostel, student: v.student, visitorName: v.visitorName, mobile: v.mobile || '',
                    relationship: v.relationship || '', isTemplate: true, listType: 'restricted', status: 'blocked',
                    remarks: remark || `Blocked after visit ${v.passNumber || ''}`.trim(), createdBy: req.userId,
                });
            }
        }

        const updated = await HostelVisitor.findByIdAndUpdate(v._id, { $set: set }, { new: true });
        if (updated && set.qrToken) updated.qrImage = passImage(set.qrToken);
        if (['entry', 'exit'].includes(action)) {
            await HostelMovement.create({
                school: req.schoolId, hostel: v.hostel, visitor: v._id, personName: v.visitorName,
                direction: action === 'entry' ? 'in' : 'out',
                movementType: 'visitor', reference: v._id, referenceType: 'HostelVisitor',
                at: now, remarks: remark, recordedBy: req.userId,
            });
        }
        await logAudit(req, { action, entityType: 'HostelVisitor', entityId: v._id, hostel: v.hostel,
            description: `Visitor ${v.visitorName} — ${action}`,
            before: { status: v.status }, after: { status: set.status } });

        if (action === 'entry') {
            const settings = await getSettings(req.schoolId);
            await notifyStudentAndParents(req, {
                studentId: v.student, settings, settingKey: 'notifyOnVisitor',
                title: 'Visitor checked in',
                body: `${v.visitorName} has checked in at the hostel.`, email: false,
            });
        }
        ok(res, updated);
    } catch (e) { fail(res, e); }
};

/**
 * A visitor's gate pass as a scannable image. The token never leaves the server
 * as text on a list: the screen asks for the image only when somebody opens it.
 */
exports.visitorPass = async (req, res) => {
    try {
        const v = await HostelVisitor.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('student', 'name').lean();
        if (!v) return bad(res, 'Visitor record not found', 404);
        if (!await mayTouchHostel(req, v.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        ok(res, {
            _id: v._id, passNumber: v.passNumber, visitorName: v.visitorName, studentName: v.student?.name || '',
            status: v.status, entryTime: v.entryTime, exitTime: v.exitTime, scheduledAt: v.scheduledAt,
            qrImage: v.qrToken ? passImage(v.qrToken) : null,
        });
    } catch (e) { fail(res, e); }
};

exports.deleteVisitor = async (req, res) => {
    try {
        const v = await HostelVisitor.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!v) return bad(res, 'Visitor record not found', 404);
        if (!await mayTouchHostel(req, v.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (!v.isTemplate) return bad(res, 'A visit record is history and cannot be deleted — cancel it instead');
        await HostelVisitor.deleteOne({ _id: v._id });
        await logAudit(req, { action: 'delete', entityType: 'HostelVisitor', entityId: v._id, hostel: v.hostel,
            description: `Removed ${v.visitorName} from the ${v.listType} visitor list` });
        ok(res, { _id: v._id });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  WARDEN & HOSTEL STAFF (spec §14) — assignments over existing employees
// ═════════════════════════════════════════════════════════════════════════════
exports.getStaffAssignments = async (req, res) => {
    try {
        const q = await scopedFilter(req, {});
        if (req.query.role) q.role = req.query.role;
        if (req.query.status) q.status = req.query.status; else q.status = 'active';
        if (req.query.floor) q.floor = req.query.floor;

        const rows = await HostelStaffAssignment.find(q).sort('role')
            .populate('staff', 'name email phone profileImage role')
            .populate('hostel', 'name code').populate('building', 'name')
            .populate('floor', 'name floorNumber').lean();
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

exports.createStaffAssignment = async (req, res) => {
    try {
        const b = req.body;
        if (!b.staff || !b.hostel || !b.role) return bad(res, 'Employee, hostel and role are required');
        if (!await mayTouchHostel(req, b.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        // The person must be an existing employee of this school — no new record.
        const staff = await User.findOne({ _id: b.staff, school: req.schoolId, role: { $in: ['teacher', 'school_admin'] } }).lean();
        if (!staff) return bad(res, 'That employee was not found in this school');

        const duplicate = await HostelStaffAssignment.findOne({
            school: req.schoolId, hostel: b.hostel, staff: b.staff, role: b.role,
            floor: b.floor || null, status: 'active',
        }).lean();
        if (duplicate) return bad(res, 'This employee already holds that role here');

        // A hostel has one warden. Naming a new one ends the last one's posting —
        // otherwise they stay posted, and keep their access, with nobody noticing.
        if (b.role === 'warden') {
            await HostelStaffAssignment.updateMany(
                { school: req.schoolId, hostel: b.hostel, role: 'warden', status: 'active', staff: { $ne: b.staff } },
                { $set: { status: 'inactive', isActive: false, toDate: new Date() } });
        }
        const row = await HostelStaffAssignment.create({ ...b, school: req.schoolId, createdBy: req.userId });

        // Warden / assistant warden also sit on the hostel itself, because the
        // rest of the module reads them from there.
        if (b.role === 'warden') await Hostel.findByIdAndUpdate(b.hostel, { $set: { warden: b.staff } });
        if (b.role === 'assistant_warden') await Hostel.findByIdAndUpdate(b.hostel, { $set: { assistantWarden: b.staff } });

        const hostel = await Hostel.findById(b.hostel).select('name').lean();
        await logAudit(req, { action: 'assign', entityType: 'HostelStaffAssignment', entityId: row._id, hostel: b.hostel,
            description: `Assigned ${staff.name} as ${b.role.replace(/_/g, ' ')} at ${hostel?.name}` });
        notifyHostelStaff(req, { hostelId: b.hostel,
            title: 'Hostel staff assignment',
            body: `${staff.name} has been assigned as ${b.role.replace(/_/g, ' ')} at ${hostel?.name}.` });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/**
 * The warden and assistant warden also sit on the hostel itself, because the
 * rest of the module reads them from there. Keep that in step with a change to
 * an assignment: `before` and `after` are the assignment either side of it.
 *
 * A post is only ever cleared when it still names THIS person — ending an old
 * warden's assignment must not unseat whoever holds the post now.
 */
async function syncHostelPosts(before, after) {
    const holds = (a, role) => !!a && a.status === 'active' && a.role === role;
    for (const [role, field] of [['warden', 'warden'], ['assistant_warden', 'assistantWarden']]) {
        if (holds(after, role)) {
            await Hostel.findByIdAndUpdate(after.hostel, { $set: { [field]: after.staff } });
        } else if (holds(before, role)) {
            await Hostel.updateOne({ _id: before.hostel, [field]: before.staff }, { $set: { [field]: null } });
        }
    }
}

const STAFF_EDITABLE = ['building', 'floor', 'role', 'shift', 'shiftStart', 'shiftEnd', 'responsibilities', 'fromDate', 'remarks', 'status'];

exports.updateStaffAssignment = async (req, res) => {
    try {
        const before = await HostelStaffAssignment.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Assignment not found', 404);
        if (!await mayTouchHostel(req, before.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const body = {};
        for (const f of STAFF_EDITABLE) if (req.body[f] !== undefined) body[f] = req.body[f];
        for (const f of ['building', 'floor']) if (body[f] === '') body[f] = null;
        if (body.fromDate === '') delete body.fromDate;
        if (body.status !== undefined && !['active', 'inactive'].includes(body.status)) return bad(res, 'Status must be active or inactive');
        // Status carries the two fields that say the same thing.
        if (body.status === 'active' && before.status !== 'active') { body.isActive = true; body.toDate = null; }
        if (body.status === 'inactive' && before.status !== 'inactive') { body.isActive = false; body.toDate = new Date(); }

        const next = { ...before, ...body };
        if (next.status === 'active') {
            const clash = await HostelStaffAssignment.findOne({
                school: req.schoolId, hostel: before.hostel, staff: before.staff, role: next.role,
                floor: next.floor || null, status: 'active', _id: { $ne: before._id },
            }).lean();
            if (clash) return bad(res, 'This employee already holds that role here');
        }

        const row = await HostelStaffAssignment.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        await syncHostelPosts(before, next);
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelStaffAssignment', entityId: row._id, hostel: row.hostel,
            description: 'Updated hostel staff assignment', before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.endStaffAssignment = async (req, res) => {
    try {
        const row = await HostelStaffAssignment.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Assignment not found', 404);
        if (!await mayTouchHostel(req, row.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        await HostelStaffAssignment.findByIdAndUpdate(row._id, { $set: { status: 'inactive', isActive: false, toDate: new Date() } });
        await syncHostelPosts(row, { ...row, status: 'inactive' });

        await logAudit(req, { action: 'unassign', entityType: 'HostelStaffAssignment', entityId: row._id, hostel: row.hostel,
            description: `Ended ${row.role.replace(/_/g, ' ')} assignment` });
        ok(res, { _id: row._id });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  MESS (spec §15)
// ═════════════════════════════════════════════════════════════════════════════
exports.getMesses = async (req, res) => {
    try {
        const q = { school: req.schoolId, isActive: true };
        if (req.query.status) q.status = req.query.status;
        const rows = await HostelMess.find(q).sort('name').populate('inCharge', 'name email phone').lean();

        const ids = rows.map((r) => String(r._id));
        const members = await HostelMessMember.aggregate([
            { $match: { school: toId(req.schoolId), mess: { $in: ids }, status: 'active' } },
            { $group: { _id: '$mess', n: { $sum: 1 } } },
        ]);
        const mMap = Object.fromEntries(members.map((m) => [String(m._id), m.n]));
        const hostels = await Hostel.find({ school: req.schoolId }).select('name').lean();
        const hMap = Object.fromEntries(hostels.map((h) => [String(h._id), h.name]));
        rows.forEach((r) => {
            r.memberCount = mMap[String(r._id)] || 0;
            r.hostelNames = (r.hostels || []).map((h) => hMap[String(h)]).filter(Boolean);
        });
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

exports.createMess = async (req, res) => {
    try {
        const b = req.body;
        if (!b.name) return bad(res, 'Mess name is required');
        const code = (b.code || '').trim() || await nextNumber(HostelMess, req.schoolId, 'MS');
        const row = await HostelMess.create({ ...b, code, school: req.schoolId, createdBy: req.userId });
        await logAudit(req, { action: 'create', entityType: 'HostelMess', entityId: row._id,
            description: `Created mess ${row.name}` });
        ok(res, row);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A mess with this code already exists');
        fail(res, e);
    }
};

exports.updateMess = async (req, res) => {
    try {
        const before = await HostelMess.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Mess not found', 404);
        const body = { ...req.body };
        delete body.school; delete body._id;
        const row = await HostelMess.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelMess', entityId: row._id,
            description: `Updated mess ${row.name}`, before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.deleteMess = async (req, res) => {
    try {
        const members = await HostelMessMember.countDocuments({ school: req.schoolId, mess: req.params.id, status: 'active' });
        if (members) return bad(res, `Cannot deactivate — ${members} student(s) are enrolled in this mess`);
        const row = await HostelMess.findOneAndUpdate({ _id: req.params.id, school: req.schoolId },
            { $set: { isActive: false, status: 'inactive' } }, { new: true });
        if (!row) return bad(res, 'Mess not found', 404);
        await logAudit(req, { action: 'delete', entityType: 'HostelMess', entityId: row._id, description: `Deactivated mess ${row.name}` });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/** A mess of THIS school, or null — every mess write starts from one. */
const ownMess = (req, id) => (id ? HostelMess.findOne({ _id: id, school: req.schoolId, isActive: true }).lean() : null);

// ── Mess membership (student mess allocation + dietary profile) ───────────────
exports.getMessMembers = async (req, res) => {
    try {
        const p = page(req.query);
        const q = { school: req.schoolId };
        if (req.query.mess) q.mess = req.query.mess;
        if (req.query.status) q.status = req.query.status; else q.status = 'active';
        if (req.query.foodPreference) q.foodPreference = req.query.foodPreference;
        const [rows, total] = await Promise.all([
            HostelMessMember.find(q).sort('-createdAt').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name email profileImage').populate('mess', 'name code')
                .populate('hostel', 'name').lean(),
            HostelMessMember.countDocuments(q),
        ]);
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

exports.enrolMessMember = async (req, res) => {
    try {
        const b = req.body;
        if (!b.student || !b.mess) return bad(res, 'Student and mess are required');
        if (!await ownMess(req, b.mess)) return bad(res, 'Mess not found', 404);
        const allocation = await HostelAllocation.findOne({ school: req.schoolId, student: b.student, status: 'active' }).lean();
        if (!allocation) return bad(res, 'Only a current hostel resident can be enrolled in a mess');
        const mess = await ownMess(req, b.mess);
        if ((mess.hostels || []).length && !mess.hostels.map(String).includes(String(allocation.hostel))) {
            return bad(res, `${mess.name} does not serve this resident's hostel`);
        }

        const existing = await HostelMessMember.findOne({ school: req.schoolId, student: b.student, status: 'active' }).lean();
        if (existing) return bad(res, 'This student is already enrolled in a mess — end that enrolment first');

        const row = await HostelMessMember.create({
            ...b, school: req.schoolId, hostel: allocation.hostel, allocation: allocation._id, createdBy: req.userId,
        });
        const student = await User.findById(b.student).select('name').lean();
        await logAudit(req, { action: 'create', entityType: 'HostelMessMember', entityId: row._id, hostel: allocation.hostel,
            description: `Enrolled ${student?.name} in the mess` });
        ok(res, row);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'This student is already enrolled in a mess');
        fail(res, e);
    }
};

exports.updateMessMember = async (req, res) => {
    try {
        const before = await HostelMessMember.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Enrolment not found', 404);
        const body = { ...req.body };
        for (const f of ['school', '_id', 'student', 'hostel', 'allocation', 'createdBy']) delete body[f];
        if (body.mess && !await ownMess(req, body.mess)) return bad(res, 'Mess not found', 404);
        // Ending or suspending an enrolment dates it; bringing it back clears the date.
        if (body.status && body.status !== before.status) body.toDate = body.status === 'active' ? null : new Date();
        const row = await HostelMessMember.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelMessMember', entityId: row._id, hostel: row.hostel,
            description: 'Updated mess enrolment', before: d.before, after: d.after });
        ok(res, row);
    } catch (e) {
        // One active enrolment per student — reactivating a second one trips the index.
        if (e.code === 11000 || e.code === '23505') return bad(res, 'This student is already enrolled in a mess — end that enrolment first');
        fail(res, e);
    }
};

// ── Menus (daily / weekly template / monthly view) ───────────────────────────
exports.getMenus = async (req, res) => {
    try {
        const { mess, from, to, isTemplate } = req.query;
        const q = { school: req.schoolId };
        if (mess) q.mess = mess;
        if (isTemplate === 'true') q.isTemplate = true;
        else {
            q.isTemplate = false;
            if (from || to) {
                q.date = {};
                if (from) q.date.$gte = dayRange(from).start;
                if (to) q.date.$lt = dayRange(to).end;
            }
        }
        const rows = await HostelMenu.find(q).sort(isTemplate === 'true' ? 'dayOfWeek' : 'date')
            .populate('mess', 'name code').lean();
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

exports.saveMenu = async (req, res) => {
    try {
        const b = req.body;
        if (!b.mess || !b.meal) return bad(res, 'Mess and meal are required');
        if (!await ownMess(req, b.mess)) return bad(res, 'Mess not found', 404);
        if (!b.isTemplate && !b.date) return bad(res, 'A dated menu needs a date');
        if (b.isTemplate && b.dayOfWeek == null) return bad(res, 'A template menu needs a day of week');

        const filter = { school: req.schoolId, mess: b.mess, meal: b.meal, isTemplate: !!b.isTemplate };
        if (b.isTemplate) filter.dayOfWeek = num(b.dayOfWeek);
        else { const { start, end } = dayRange(b.date); filter.date = { $gte: start, $lt: end }; }

        const existing = await HostelMenu.findOne(filter).lean();
        const payload = {
            ...b,
            school: req.schoolId,
            date: b.isTemplate ? null : dayRange(b.date).start,
            dayOfWeek: b.isTemplate ? num(b.dayOfWeek) : null,
            createdBy: req.userId,
        };
        const row = existing
            ? await HostelMenu.findByIdAndUpdate(existing._id, { $set: payload }, { new: true })
            : await HostelMenu.create(payload);

        await logAudit(req, { action: existing ? 'update' : 'create', entityType: 'HostelMenu', entityId: row._id,
            description: `${existing ? 'Updated' : 'Added'} ${b.meal} menu` });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.deleteMenu = async (req, res) => {
    try {
        const row = await HostelMenu.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Menu not found', 404);
        await HostelMenu.deleteOne({ _id: row._id });
        await logAudit(req, { action: 'delete', entityType: 'HostelMenu', entityId: row._id, description: `Removed ${row.meal} menu` });
        ok(res, { _id: row._id });
    } catch (e) { fail(res, e); }
};

/** Roll the weekly template forward into dated menus for a date range. */
exports.generateMenus = async (req, res) => {
    try {
        const { mess, from, to, overwrite = false } = req.body;
        if (!mess || !from || !to) return bad(res, 'Mess and a date range are required');
        const templates = await HostelMenu.find({ school: req.schoolId, mess, isTemplate: true }).lean();
        if (!templates.length) return bad(res, 'This mess has no weekly template to generate from');

        const start = dayRange(from).start; const end = dayRange(to).start;
        if (end < start) return bad(res, 'The end date cannot be before the start date');
        if ((end - start) / 864e5 > 92) return bad(res, 'Generate at most a quarter at a time');

        let created = 0; let skipped = 0;
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const day = d.getDay();
            for (const t of templates.filter((x) => x.dayOfWeek === day)) {
                const on = new Date(d);
                const exists = await HostelMenu.findOne({
                    school: req.schoolId, mess, meal: t.meal, isTemplate: false,
                    date: { $gte: dayRange(on).start, $lt: dayRange(on).end },
                }).lean();
                if (exists && !overwrite) { skipped += 1; continue; }
                const payload = {
                    school: req.schoolId, mess, meal: t.meal, isTemplate: false,
                    date: dayRange(on).start, dayOfWeek: null,
                    items: t.items, description: t.description, estimatedCost: t.estimatedCost,
                    status: 'published', createdBy: req.userId,
                };
                if (exists) await HostelMenu.findByIdAndUpdate(exists._id, { $set: payload });
                else await HostelMenu.create(payload);
                created += 1;
            }
        }
        await logAudit(req, { action: 'generate', entityType: 'HostelMenu',
            description: `Generated ${created} menu entries from the weekly template`, meta: { created, skipped } });
        ok(res, { created, skipped });
    } catch (e) { fail(res, e); }
};

// ── Meal attendance & mess expenses ──────────────────────────────────────────
exports.getMessAttendance = async (req, res) => {
    try {
        const { mess, date, meal } = req.query;
        if (!mess) return bad(res, 'Mess is required');
        const { start, end } = dayRange(date);

        const members = await HostelMessMember.find({ school: req.schoolId, mess, status: 'active' })
            .populate('student', 'name profileImage').lean();
        const q = { school: req.schoolId, mess, date: { $gte: start, $lt: end } };
        if (meal) q.meal = meal;
        const marked = await HostelMessAttendance.find(q).lean();
        const byStudent = {};
        for (const m of marked) (byStudent[String(m.student)] = byStudent[String(m.student)] || {})[m.meal] = m;

        ok(res, {
            date: start,
            rows: members.map((m) => ({
                member: m._id, student: m.student,
                foodPreference: m.foodPreference, allergies: m.allergies, mealPlan: m.mealPlan,
                meals: byStudent[String(m.student?._id || m.student)] || {},
            })),
        });
    } catch (e) { fail(res, e); }
};

exports.markMessAttendance = async (req, res) => {
    try {
        const { mess, date, meal, records = [] } = req.body;
        if (!mess || !meal || !records.length) return bad(res, 'Mess, meal and records are required');
        if (!await ownMess(req, mess)) return bad(res, 'Mess not found', 404);
        const { start, end } = dayRange(date);
        if (start > new Date()) return bad(res, 'Meal attendance cannot be marked for a future date');
        let created = 0; let updated = 0; const skipped = [];

        // Two reads for the whole register, rather than two per student.
        const ids = records.map((r) => String(r.student));
        const [members, marked] = await Promise.all([
            HostelMessMember.find({ school: req.schoolId, mess, status: 'active', student: { $in: ids } }).lean(),
            HostelMessAttendance.find({ school: req.schoolId, student: { $in: ids }, meal, date: { $gte: start, $lt: end } }).lean(),
        ]);
        const memberOf = Object.fromEntries(members.map((m) => [String(m.student), m]));
        const existingOf = Object.fromEntries(marked.map((m) => [String(m.student), m]));

        for (const r of records) {
            const member = memberOf[String(r.student)];
            // Only somebody enrolled in THIS mess can be marked at it.
            if (!member) { skipped.push({ student: r.student, reason: 'Not enrolled in this mess' }); continue; }
            const status = ['taken', 'skipped', 'on_leave', 'guest'].includes(r.status) ? r.status : 'taken';
            const existing = existingOf[String(r.student)];
            if (existing) {
                await HostelMessAttendance.findByIdAndUpdate(existing._id, {
                    $set: { status, guestCount: num(r.guestCount), remarks: r.remarks || '', markedBy: req.userId, selfMarked: false },
                });
                updated += 1;
            } else {
                await HostelMessAttendance.create({
                    school: req.schoolId, mess, student: r.student, hostel: member.hostel || null,
                    date: start, meal, status,
                    guestCount: num(r.guestCount), remarks: r.remarks || '', markedBy: req.userId,
                });
                created += 1;
            }
        }
        await logAudit(req, { action: 'mark_mess_attendance', entityType: 'HostelMessAttendance',
            description: `Marked ${meal} mess attendance: ${created} new, ${updated} updated` });
        ok(res, { created, updated, skipped });
    } catch (e) { fail(res, e); }
};

exports.getMessExpenses = async (req, res) => {
    try {
        const p = page(req.query);
        const q = { school: req.schoolId };
        if (req.query.mess) q.mess = req.query.mess;
        if (req.query.category) q.category = req.query.category;
        if (req.query.from || req.query.to) {
            q.date = {};
            if (req.query.from) q.date.$gte = dayRange(req.query.from).start;
            if (req.query.to) q.date.$lt = dayRange(req.query.to).end;
        }
        const [rows, total, agg] = await Promise.all([
            HostelMessExpense.find(q).sort('-date').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('mess', 'name').populate('recordedBy', 'name').lean(),
            HostelMessExpense.countDocuments(q),
            HostelMessExpense.aggregate([
                { $match: { school: toId(req.schoolId), ...(req.query.mess ? { mess: toId(req.query.mess) } : {}) } },
                { $group: { _id: '$category', total: { $sum: '$amount' } } },
            ]),
        ]);
        ok(res, { ...paged(rows, total, p), byCategory: agg.map((a) => ({ label: a._id, value: a.total })) });
    } catch (e) { fail(res, e); }
};

exports.createMessExpense = async (req, res) => {
    try {
        const b = req.body;
        if (!b.mess || !b.amount) return bad(res, 'Mess and amount are required');
        if (num(b.amount) <= 0) return bad(res, 'The amount must be more than zero');
        if (!await ownMess(req, b.mess)) return bad(res, 'Mess not found', 404);
        const row = await HostelMessExpense.create({ ...b, amount: num(b.amount), school: req.schoolId, recordedBy: req.userId });
        await logAudit(req, { action: 'create', entityType: 'HostelMessExpense', entityId: row._id,
            description: `Recorded mess expense of ${row.amount} (${row.category})` });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.deleteMessExpense = async (req, res) => {
    try {
        const row = await HostelMessExpense.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return bad(res, 'Expense not found', 404);
        await HostelMessExpense.deleteOne({ _id: row._id });
        await logAudit(req, { action: 'delete', entityType: 'HostelMessExpense', entityId: row._id,
            description: `Deleted mess expense of ${row.amount}` });
        ok(res, { _id: row._id });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  HOSTEL FEES (spec §16) — billing on top of the existing Fees infrastructure
// ═════════════════════════════════════════════════════════════════════════════
exports.getFeePlans = async (req, res) => {
    try {
        const q = { school: req.schoolId, isActive: true };
        if (req.query.hostel) q.hostel = req.query.hostel;
        if (req.query.feeType) q.feeType = req.query.feeType;
        const rows = await HostelFeePlan.find(q).sort('name').populate('hostel', 'name code').lean();
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

exports.createFeePlan = async (req, res) => {
    try {
        const b = req.body;
        if (!b.name) return bad(res, 'Plan name is required');
        if (b.basis === 'room_type' && !(b.roomTypeRates || []).length) {
            return bad(res, 'A room-type plan needs at least one rate band');
        }
        const row = await HostelFeePlan.create({ ...b, amount: num(b.amount), appliesTo: resident.cleanOccupant(b.appliesTo) || 'student',
            school: req.schoolId, createdBy: req.userId });
        await logAudit(req, { action: 'create', entityType: 'HostelFeePlan', entityId: row._id, hostel: row.hostel,
            description: `Created fee plan ${row.name} (${row.feeType})`, after: { amount: row.amount, basis: row.basis } });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.updateFeePlan = async (req, res) => {
    try {
        const before = await HostelFeePlan.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Fee plan not found', 404);
        const body = { ...req.body };
        delete body.school; delete body._id;
        if (body.amount !== undefined) body.amount = num(body.amount);
        if (body.appliesTo !== undefined) {
            body.appliesTo = resident.cleanOccupant(body.appliesTo);
            if (!body.appliesTo) return bad(res, 'A fee plan bills students, teachers, or both');
        }
        const row = await HostelFeePlan.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        // Fee changes must be audited (spec §31) — the before/after amounts are kept.
        await logAudit(req, { action: 'update', entityType: 'HostelFeePlan', entityId: row._id, hostel: row.hostel,
            description: `Updated fee plan ${row.name}`, before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.deleteFeePlan = async (req, res) => {
    try {
        const row = await HostelFeePlan.findOneAndUpdate({ _id: req.params.id, school: req.schoolId },
            { $set: { isActive: false, status: 'inactive' } }, { new: true });
        if (!row) return bad(res, 'Fee plan not found', 404);
        await logAudit(req, { action: 'delete', entityType: 'HostelFeePlan', entityId: row._id, hostel: row.hostel,
            description: `Deactivated fee plan ${row.name}` });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

// The payable amount for one student under a plan (flat, or by room type).
function resolvePlanAmount(plan, roomType) {
    if (!plan) return 0;
    if (plan.basis === 'room_type') {
        const band = (plan.roomTypeRates || []).find((z) => z.roomType === roomType);
        return num(band?.amount, plan.amount || 0);
    }
    return plan.amount || 0;
}

exports.getInvoices = async (req, res) => {
    try {
        const p = page(req.query);
        const q = { school: req.schoolId };
        const allowed = await visibleHostelIds(req);
        if (allowed !== null) q.hostel = allowed.length ? { $in: allowed } : '__none__';
        if (req.query.hostel) q.hostel = req.query.hostel;
        if (req.query.status && req.query.status !== 'all') q.status = req.query.status;
        if (req.query.student) q.student = req.query.student;
        if (req.query.feeType) q.feeType = req.query.feeType;
        if (req.query.academicYear) q.academicYear = req.query.academicYear;

        const [rows, total, agg] = await Promise.all([
            HostelFeeInvoice.find(q).sort('-createdAt').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name email profileImage').populate('hostel', 'name').lean(),
            HostelFeeInvoice.countDocuments(q),
            HostelFeeInvoice.aggregate([
                { $match: { school: toId(req.schoolId) } },
                { $group: { _id: null, billed: { $sum: '$netAmount' }, paid: { $sum: '$paidAmount' }, refunded: { $sum: '$refundedAmount' } } },
            ]),
        ]);
        const t = agg[0] || {};
        ok(res, {
            ...paged(rows, total, p),
            summary: {
                billed: t.billed || 0, collected: t.paid || 0, refunded: t.refunded || 0,
                outstanding: Math.max(0, (t.billed || 0) - (t.paid || 0)),
            },
        });
    } catch (e) { fail(res, e); }
};

exports.createInvoice = async (req, res) => {
    try {
        const b = req.body;
        if (!b.student || b.amount == null) return bad(res, 'A resident and an amount are required');
        if (num(b.amount) <= 0) return bad(res, 'The amount must be more than zero');
        // Billed to a student or a member of staff — which one comes from the account.
        const account = await resident.residentAccount(req.schoolId, b.student);
        if (!account) return bad(res, 'That person is not a student or teacher of this school');
        const allocation = await HostelAllocation.findOne({
            school: req.schoolId, student: b.student, status: { $in: ['active', 'pending'] },
        }).lean();

        const settings = await getSettings(req.schoolId);
        const row = await HostelFeeInvoice.create({
            ...b,
            school: req.schoolId,
            residentType: account.kind,
            payments: [], paidAmount: 0, refundedAmount: 0, status: 'pending',   // never taken from the request
            hostel: b.hostel || allocation?.hostel || null,
            allocation: allocation?._id || null,
            academicYear: b.academicYear || allocation?.academicYear || null,
            invoiceNumber: await nextNumber(HostelFeeInvoice, req.schoolId, 'HF'),
            amount: num(b.amount), discount: num(b.discount), lateFee: num(b.lateFee),
            generatedBy: req.userId,
        });

        await postToLedger({
            schoolId: req.schoolId, studentId: b.student, academicYearId: row.academicYear,
            entryType: 'debit', category: 'fee_charged', amount: row.netAmount,
            description: `Hostel ${row.feeType.replace(/_/g, ' ')} — ${row.invoiceNumber}`,
            invoiceId: row._id, feeHeadName: `Hostel ${row.feeType.replace(/_/g, ' ')}`,
            createdBy: req.userId, settings,
        });

        const student = await User.findById(b.student).select('name').lean();
        await logAudit(req, { action: 'create', entityType: 'HostelFeeInvoice', entityId: row._id, hostel: row.hostel,
            description: `Raised ${row.invoiceNumber} for ${student?.name} — ${row.netAmount}`,
            after: { amount: row.amount, discount: row.discount, netAmount: row.netAmount } });
        if (settings.notifyOnFeeDue) {
            await notifyStudentAndParents(req, {
                studentId: b.student, settings,
                title: 'Hostel fee raised',
                body: `A hostel ${row.feeType.replace(/_/g, ' ')} charge of ${row.netAmount} has been raised (${row.invoiceNumber}).`
                    + (row.dueDate ? ` Due by ${new Date(row.dueDate).toDateString()}.` : ''),
            });
        }
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/**
 * Bill every current resident a plan covers for one period (spec §16).
 * Idempotent per resident + plan + period, so re-running a month cannot
 * double-charge — which is what lets the clock call it as well as a person.
 *
 * Who is billed:
 *   · residents of the kind the plan is written for (students / teachers / both);
 *   · a teacher only when the school charges its staff at all;
 *   · for a MESS plan, only residents enrolled in a mess — the mess is opt-in,
 *     and a plan that billed the whole hostel charged people who never ate there.
 */
/**
 * When this unbroken stay began. A room change closes one allocation and opens
 * another on the same day, so the row someone holds now may be younger than
 * their stay; walking back through the transfers finds the day they moved in.
 */
async function stayStart(schoolId, a) {
    let start = dayRange(a.fromDate).start;
    const earlier = await HostelAllocation.find({ school: schoolId, student: a.student, status: 'transferred' }).select('fromDate vacatedDate').lean();
    for (let guard = 0; guard < 20; guard++) {
        const prev = earlier.find((x) => x.vacatedDate && Math.abs(dayRange(x.vacatedDate).start - start) <= 864e5 && dayRange(x.fromDate).start < start);
        if (!prev) break;
        start = dayRange(prev.fromDate).start;
    }
    return start;
}

async function billPlan(req, { plan, month, year, hostel = null, dueDate = null, settings, scope = null }) {
    const q = { school: req.schoolId, status: 'active' };
    if (hostel) q.hostel = hostel;
    else if (scope !== null) q.hostel = scope.length ? { $in: scope } : '__none__';
    else if (plan.hostel) q.hostel = plan.hostel;

    const allocations = await HostelAllocation.find(q).populate('room', 'roomType').lean();
    const label = month ? `${MONTHS[num(month) - 1]} ${year}` : String(year);
    const created = []; const skipped = [];
    // Who each resident is comes from their account, not from the row.
    const kinds = await resident.kindsOf(req.schoolId, allocations.map((a) => a.student));
    const inMess = plan.feeType === 'mess'
        ? new Set((await HostelMessMember.find({ school: req.schoolId, status: 'active', student: { $in: allocations.map((a) => String(a.student)) } })
            .select('student').lean()).map((m) => String(m.student)))
        : null;

    for (const a of allocations) {
        const kind = kinds[String(a.student)] || 'student';
        if (!resident.planCovers(plan, kind)) continue;
        if (kind === 'teacher' && !settings.chargeTeachers) {
            skipped.push({ student: a.student, reason: 'The hostel is free for teachers (Hostel Settings)' });
            continue;
        }
        if (inMess && !inMess.has(String(a.student))) {
            skipped.push({ student: a.student, reason: 'Not enrolled in a mess' });
            continue;
        }
        const existing = await HostelFeeInvoice.findOne({
            school: req.schoolId, student: a.student, feePlan: plan._id,
            'period.year': num(year), 'period.month': month ? num(month) : null,
        }).lean();
        if (existing) { skipped.push({ student: a.student, reason: 'Already billed for this period' }); continue; }

        let amount = resolvePlanAmount(plan, a.room?.roomType);
        if (!amount) { skipped.push({ student: a.student, reason: 'The plan resolves to a zero amount' }); continue; }

        // A month is billed to someone who was here for it. Moved in later:
        // not billed for that month at all. Moved in part-way: the days stayed,
        // where the school has asked for part-month billing.
        let partMonth = '';
        if (month) {
            const first = new Date(num(year), num(month) - 1, 1);
            const daysIn = new Date(num(year), num(month), 0).getDate();
            const monthEnd = new Date(num(year), num(month) - 1, daysIn, 23, 59, 59);
            let from = a.fromDate ? dayRange(a.fromDate).start : null;
            if (from && from > first) from = await stayStart(req.schoolId, a);     // a room change is not a new stay
            if (from && from > monthEnd) { skipped.push({ student: a.student, reason: 'Moved in after this period' }); continue; }
            if (from && from > first && settings.prorateFirstMonth && plan.frequency === 'monthly') {
                const days = daysIn - from.getDate() + 1;
                amount = Math.round((amount * days / daysIn) * 100) / 100;
                partMonth = `Part month: ${days} of ${daysIn} days, from ${from.toDateString()}`;
            }
        }

        const inv = await HostelFeeInvoice.create({
            school: req.schoolId, student: a.student, residentType: kind, hostel: a.hostel, allocation: a._id,
            academicYear: a.academicYear, feePlan: plan._id, feeType: plan.feeType,
            invoiceNumber: await nextNumber(HostelFeeInvoice, req.schoolId, 'HF'),
            period: { month: month ? num(month) : null, year: num(year), label },
            remarks: partMonth,
            amount,
            dueDate: dueDate ? new Date(dueDate)
                : month ? new Date(num(year), num(month) - 1, plan.dueDayOfMonth || settings.feeDueDayOfMonth) : null,
            isRefundable: plan.isRefundable,
            generatedBy: req.system ? null : req.userId,
        });
        await postToLedger({
            schoolId: req.schoolId, studentId: a.student, academicYearId: a.academicYear,
            entryType: 'debit', category: 'fee_charged', amount: inv.netAmount,
            description: `Hostel ${plan.feeType.replace(/_/g, ' ')} ${label} — ${inv.invoiceNumber}`,
            invoiceId: inv._id, feeHeadName: `Hostel ${plan.feeType.replace(/_/g, ' ')}`,
            createdBy: req.userId, settings,
        });
        created.push(inv);
        if (settings.notifyOnFeeDue) {
            notifyStudentAndParents(req, {
                studentId: a.student, settings,
                title: 'Hostel fee due',
                body: `Hostel ${plan.feeType.replace(/_/g, ' ')} for ${label}: ${inv.netAmount}. Invoice ${inv.invoiceNumber}.`,
            });
        }
    }
    return { created, skipped, label };
}

exports.generateInvoices = async (req, res) => {
    try {
        const { feePlan, hostel = null, month, year, dueDate = null } = req.body;
        if (!feePlan || !year) return bad(res, 'A fee plan and year are required');
        const plan = await HostelFeePlan.findOne({ _id: feePlan, school: req.schoolId }).lean();
        if (!plan) return bad(res, 'Fee plan not found');

        const settings = await getSettings(req.schoolId);
        const { created, skipped, label } = await billPlan(req, {
            plan, month, year, hostel, dueDate, settings, scope: await visibleHostelIds(req),
        });
        await logAudit(req, { action: 'generate', entityType: 'HostelFeeInvoice', hostel,
            description: `Generated ${created.length} hostel invoice(s) for ${label}`,
            meta: { plan: plan.name, created: created.length, skipped: skipped.length } });
        ok(res, { created: created.length, skipped: skipped.length, invoices: created, skippedRows: skipped });
    } catch (e) { fail(res, e); }
};

/**
 * Record a payment. The invoice is the receipt; the shared FeeLedger gets the
 * credit entry, so the student's overall position is right without a second
 * payment system.
 */
exports.payInvoice = async (req, res) => {
    try {
        const { amount, mode = 'cash', reference = '', note = '' } = req.body;
        const paid = num(amount);
        if (paid <= 0) return bad(res, 'A positive amount is required');
        // The counter takes cash, a cheque, UPI, a card or a transfer. 'online'
        // is recorded only by the gateway, with its own proof of payment.
        if (!payments.OFFLINE_MODES.includes(mode)) return bad(res, 'Choose how the payment was made: cash, cheque, UPI, card or bank transfer');
        if (mode !== 'cash' && !String(reference).trim()) return bad(res, `Enter the ${payments.MODE_LABEL[mode].toLowerCase()} reference`);

        const inv = await HostelFeeInvoice.findOne({ _id: req.params.id, school: req.schoolId });
        if (!inv) return bad(res, 'Invoice not found', 404);
        if (inv.hostel && !await mayTouchHostel(req, inv.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (inv.status === 'cancelled') return bad(res, 'This invoice has been cancelled');
        const due = payments.outstandingOf(inv);
        if (paid > due) return bad(res, `The outstanding amount is ${due}`);

        const r = await payments.settle(req, {
            lines: [{ invoice: inv, amount: paid }], mode, reference: String(reference).trim(), note, receivedBy: req.userId,
        });
        await notifyStudentAndParents(req, {
            studentId: inv.student, settings: r.settings,
            title: 'Hostel fee payment received',
            body: `Payment of ${paid} received against ${inv.invoiceNumber}. Receipt ${r.receiptNumber}.`,
        });
        ok(res, { invoice: inv.toObject ? inv.toObject() : inv, receiptNumber: r.receiptNumber });
    } catch (e) { handle(res, e); }
};

/** Concession / scholarship / waiver on an invoice (spec §16) — always audited. */
exports.discountInvoice = async (req, res) => {
    try {
        const { discount, reason = '' } = req.body;
        const value = num(discount);
        const inv = await HostelFeeInvoice.findOne({ _id: req.params.id, school: req.schoolId });
        if (!inv) return bad(res, 'Invoice not found', 404);
        if (inv.status === 'cancelled') return bad(res, 'This invoice has been cancelled');
        if (value < 0 || value > inv.amount) return bad(res, `The discount must be between 0 and ${inv.amount}`);
        // The resulting bill may not fall below what has already been collected —
        // that would leave the student in credit with no refund raised for it.
        const prospectiveNet = Math.max(0, (inv.amount || 0) - value + (inv.lateFee || 0));
        if (prospectiveNet < (inv.paidAmount || 0)) {
            return bad(res, `Already paid ${inv.paidAmount} — a discount of ${value} would drop the bill to ${prospectiveNet}. Refund the difference instead.`);
        }

        const before = { discount: inv.discount, netAmount: inv.netAmount };
        inv.discount = value;
        inv.discountReason = reason;
        await inv.save();

        const settings = await getSettings(req.schoolId);
        const delta = before.netAmount - inv.netAmount;
        if (delta !== 0) {
            // A concession credits the ledger; taking one back debits it again —
            // only the first half used to be posted, so the ledger drifted.
            await postToLedger({
                schoolId: req.schoolId, studentId: inv.student, academicYearId: inv.academicYear,
                entryType: delta > 0 ? 'credit' : 'debit', category: delta > 0 ? 'concession' : 'adjustment', amount: Math.abs(delta),
                description: `Hostel fee concession ${delta > 0 ? 'on' : 'reduced on'} ${inv.invoiceNumber}${reason ? ` — ${reason}` : ''}`,
                invoiceId: inv._id, createdBy: req.userId, settings,
            });
        }
        await logAudit(req, { action: 'discount', entityType: 'HostelFeeInvoice', entityId: inv._id, hostel: inv.hostel,
            description: `Discount on ${inv.invoiceNumber} set to ${value}${reason ? ` — ${reason}` : ''}`,
            before, after: { discount: inv.discount, netAmount: inv.netAmount } });
        ok(res, inv.toObject ? inv.toObject() : inv);
    } catch (e) { fail(res, e); }
};

/**
 * Refund — for a security deposit at checkout, and for over-collection.
 * `viaGateway: true` sends it back to the online payment it came from.
 */
exports.refundInvoice = async (req, res) => {
    try {
        const { amount, reference = '', reason = '', viaGateway = false } = req.body;
        const inv = await HostelFeeInvoice.findOne({ _id: req.params.id, school: req.schoolId });
        if (!inv) return bad(res, 'Invoice not found', 404);
        const r = await payments.refund(req, inv, num(amount), { reference, reason, viaGateway: viaGateway === true || viaGateway === 'true' });
        ok(res, { ...(inv.toObject ? inv.toObject() : inv), voucherNumber: r.voucherNumber });
    } catch (e) { handle(res, e); }
};

exports.cancelInvoice = async (req, res) => {
    try {
        const inv = await HostelFeeInvoice.findOne({ _id: req.params.id, school: req.schoolId });
        if (!inv) return bad(res, 'Invoice not found', 404);
        if (inv.paidAmount > 0) return bad(res, 'A part-paid invoice cannot be cancelled — refund it instead');

        const before = { status: inv.status };
        inv.status = 'cancelled';
        await inv.save();

        const settings = await getSettings(req.schoolId);
        await postToLedger({
            schoolId: req.schoolId, studentId: inv.student, academicYearId: inv.academicYear,
            entryType: 'credit', category: 'adjustment', amount: inv.netAmount,
            description: `Hostel invoice ${inv.invoiceNumber} cancelled`,
            invoiceId: inv._id, createdBy: req.userId, settings,
        });
        await logAudit(req, { action: 'cancel', entityType: 'HostelFeeInvoice', entityId: inv._id, hostel: inv.hostel,
            description: `Cancelled ${inv.invoiceNumber}`, before, after: { status: 'cancelled' } });
        ok(res, inv.toObject ? inv.toObject() : inv);
    } catch (e) { fail(res, e); }
};

/**
 * Raise a fine as its own invoice. Shared by the late-return gate handler and by
 * discipline actions, so a fine is billed the same way wherever it comes from.
 */
async function raiseFine(req, { studentId, hostelId, allocationId = null, amount, remarks = '', settings = null }) {
    const s = settings || await getSettings(req.schoolId);
    const allocation = allocationId
        ? await HostelAllocation.findById(allocationId).lean()
        : await HostelAllocation.findOne({ school: req.schoolId, student: studentId, status: 'active' }).lean();

    const inv = await HostelFeeInvoice.create({
        school: req.schoolId, student: studentId,
        hostel: hostelId || allocation?.hostel || null,
        allocation: allocation?._id || null,
        academicYear: allocation?.academicYear || null,
        feeType: 'fine',
        invoiceNumber: await nextNumber(HostelFeeInvoice, req.schoolId, 'HF'),
        amount: num(amount), remarks,
        dueDate: new Date(Date.now() + 7 * 864e5),
        generatedBy: req.userId,
    });
    await postToLedger({
        schoolId: req.schoolId, studentId, academicYearId: allocation?.academicYear,
        entryType: 'debit', category: 'fine', amount: inv.netAmount,
        description: `Hostel fine — ${remarks || inv.invoiceNumber}`,
        invoiceId: inv._id, feeHeadName: 'Hostel fine', createdBy: req.userId, settings: s,
    });
    await logAudit(req, { action: 'fine', entityType: 'HostelFeeInvoice', entityId: inv._id, hostel: inv.hostel,
        description: `Fine of ${inv.netAmount} raised — ${remarks}` });
    return inv;
}
exports.raiseFine = async (req, res) => {
    try {
        const { student, amount, remarks = '', hostel = null } = req.body;
        if (!student || !amount) return bad(res, 'Student and amount are required');
        ok(res, await raiseFine(req, { studentId: student, hostelId: hostel, amount, remarks }));
    } catch (e) { fail(res, e); }
};

/** Bring late fees up to date for a school. Idempotent — a fee already right is left alone. */
async function lateFeesFor(req, settings) {
    if (!settings.lateFeePerDay) return 0;
    const cutoff = new Date(Date.now() - (settings.lateFeeGraceDays || 0) * 864e5);
    const overdue = await HostelFeeInvoice.find({
        school: req.schoolId, status: { $in: ['pending', 'partial', 'overdue'] },
        dueDate: { $ne: null, $lt: cutoff },
    });
    let updated = 0;
    for (const inv of overdue) {
        // A fine is not charged a fine for being late.
        if (['fine', 'late_fee', 'security_deposit'].includes(inv.feeType)) continue;
        const days = Math.floor((Date.now() - new Date(inv.dueDate)) / 864e5) - (settings.lateFeeGraceDays || 0);
        if (days <= 0) continue;
        // Never more than the bill itself: a daily fee with no ceiling
        // overtakes the charge it is a penalty on.
        const want = Math.min(days * settings.lateFeePerDay, Math.max(0, (inv.amount || 0) - (inv.discount || 0)));
        if (inv.lateFee === want) continue;      // already at the right amount
        const before = inv.lateFee || 0;
        inv.lateFee = want;
        await inv.save();
        updated += 1;
        // The late fee is money owed like any other: the ledger moves with it.
        await postToLedger({
            schoolId: req.schoolId, studentId: inv.student, academicYearId: inv.academicYear,
            entryType: want > before ? 'debit' : 'credit', category: want > before ? 'fine' : 'adjustment', amount: Math.abs(want - before),
            description: `Late fee on ${inv.invoiceNumber} (${days} day(s) overdue)`,
            invoiceId: inv._id, feeHeadName: 'Hostel late fee', createdBy: req.userId, settings,
        });
        await logAudit(req, { action: 'late_fee', entityType: 'HostelFeeInvoice', entityId: inv._id, hostel: inv.hostel,
            description: `Late fee on ${inv.invoiceNumber} updated to ${want} (${days} day(s) overdue)`,
            before: { lateFee: before }, after: { lateFee: want } });
    }
    return updated;
}

/** Apply the configured late fee to invoices past their due date. Idempotent. */
exports.applyLateFees = async (req, res) => {
    try {
        const settings = await getSettings(req.schoolId);
        if (!settings.lateFeePerDay) return ok(res, { updated: 0, message: 'No late fee is configured' });
        ok(res, { updated: await lateFeesFor(req, settings) });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  COMPLAINTS (spec §17)
// ═════════════════════════════════════════════════════════════════════════════
exports.getComplaints = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { status, category, priority, student, assignedTo } = req.query;
        if (status && status !== 'all') q.status = status;
        if (category) q.category = category;
        if (priority) q.priority = priority;
        if (student) q.student = student;
        if (assignedTo) q.assignedTo = assignedTo;

        const [rows, total, byStatus] = await Promise.all([
            HostelComplaint.find(q).sort('-createdAt').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name profileImage').populate('hostel', 'name')
                .populate('room', 'roomNumber').populate('assignedTo', 'name').lean(),
            HostelComplaint.countDocuments(q),
            HostelComplaint.aggregate([
                { $match: { school: toId(req.schoolId) } },
                { $group: { _id: '$status', n: { $sum: 1 } } },
            ]),
        ]);
        ok(res, { ...paged(rows, total, p), byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.n])) });
    } catch (e) { fail(res, e); }
};

exports.getComplaint = async (req, res) => {
    try {
        const c = await HostelComplaint.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('student', 'name email profileImage').populate('hostel', 'name')
            .populate('room', 'roomNumber').populate('assignedTo', 'name email')
            .populate('resolvedBy', 'name').populate('escalatedTo', 'name').lean();
        if (!c) return bad(res, 'Complaint not found', 404);
        if (!await mayTouchHostel(req, c.hostel?._id || c.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const [maintenance, documents] = await Promise.all([
            HostelMaintenance.find({ school: req.schoolId, complaint: c._id }).lean(),
            HostelDocument.find({ school: req.schoolId, entityType: 'HostelComplaint', entityId: c._id, isActive: true }).lean(),
        ]);
        ok(res, {
            ...c, maintenance, documents,
            attachmentUrls: (c.attachments || []).map((f) => signedFileUrl(f)),
        });
    } catch (e) { fail(res, e); }
};

exports.createComplaint = async (req, res) => {
    try {
        const b = req.body;
        if (!b.description || !b.hostel) return bad(res, 'Hostel and description are required');
        if (!await mayTouchHostel(req, b.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        // A complaint raised for a room or on behalf of a resident must be about
        // THIS hostel — otherwise it lands in a warden's list it has nothing to do with.
        if (b.room) {
            const room = await HostelRoom.findOne({ _id: b.room, school: req.schoolId, hostel: b.hostel }).select('_id').lean();
            if (!room) return bad(res, 'That room is not in this hostel');
        }
        if (b.student) {
            const lives = await HostelAllocation.findOne({ school: req.schoolId, student: b.student, hostel: b.hostel, status: 'active' }).select('_id').lean();
            if (!lives) return bad(res, 'That student does not live in this hostel');
        }

        const settings = await getSettings(req.schoolId);
        const row = await HostelComplaint.create({
            ...b, school: req.schoolId, status: 'open', escalationLevel: 0,
            ticketNumber: await nextNumber(HostelComplaint, req.schoolId, 'HC'),
            dueAt: new Date(Date.now() + (settings.complaintSlaHours || 48) * 36e5),
            raisedBy: req.userId, raisedByRole: req.userRole,
        });
        await logAudit(req, { action: 'create', entityType: 'HostelComplaint', entityId: row._id, hostel: row.hostel,
            description: `Complaint ${row.ticketNumber} raised (${row.category}/${row.priority})` });
        await notifyHostelStaff(req, { hostelId: row.hostel,
            title: `New hostel complaint — ${row.category}`,
            body: `${row.ticketNumber} (${row.priority}): ${String(row.description).slice(0, 180)}` });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/**
 * Drive a complaint through its workflow (spec §17). One endpoint rather than
 * eight, because every step is the same shape: change status, append a comment,
 * notify. `escalate` raises the level and pings the configured escalation owner.
 */
exports.actOnComplaint = async (req, res) => {
    try {
        const { action, assignedTo = null, resolution = '', comment = '', priority = null, internal = false, rating = null } = req.body;
        const valid = ['assign', 'start', 'resolve', 'reopen', 'close', 'reject', 'escalate', 'comment', 'prioritize', 'rate'];
        if (!valid.includes(action)) return bad(res, `Action must be one of: ${valid.join(', ')}`);

        const c = await HostelComplaint.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!c) return bad(res, 'Complaint not found', 404);
        if (!await mayTouchHostel(req, c.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const now = new Date();
        const set = {};
        const push = [];
        if (comment) {
            push.push({ by: req.userId, byName: req.user?.name || '', byRole: req.userRole, text: comment, at: now, internal: !!internal });
        }

        if (action === 'assign') {
            if (!assignedTo) return bad(res, 'Assignee is required');
            set.assignedTo = assignedTo; set.assignedAt = now;
            if (['open', 'reopened'].includes(c.status)) set.status = 'assigned';
        } else if (action === 'start') {
            if (['closed', 'rejected'].includes(c.status)) return bad(res, `A ${c.status} complaint cannot be started`);
            set.status = 'in_progress';
        } else if (action === 'resolve') {
            if (['closed', 'rejected'].includes(c.status)) return bad(res, `A ${c.status} complaint cannot be resolved`);
            set.status = 'resolved'; set.resolution = resolution || c.resolution;
            set.resolutionDate = now; set.resolvedBy = req.userId;
        } else if (action === 'reopen') {
            if (!['resolved', 'closed'].includes(c.status)) return bad(res, 'Only a resolved or closed complaint can be reopened');
            set.status = 'reopened'; set.reopenCount = (c.reopenCount || 0) + 1;
        } else if (action === 'close') {
            if (c.status === 'closed') return bad(res, 'This complaint is already closed');
            set.status = 'closed';
        } else if (action === 'reject') {
            if (['resolved', 'closed', 'rejected'].includes(c.status)) return bad(res, `A ${c.status} complaint cannot be rejected`);
            set.status = 'rejected'; set.resolution = resolution || comment;
        } else if (action === 'escalate') {
            const settings = await getSettings(req.schoolId);
            set.escalationLevel = (c.escalationLevel || 0) + 1;
            set.escalatedAt = now;
            set.escalatedTo = assignedTo || settings.complaintEscalateTo || null;
            if (c.priority !== 'urgent') set.priority = c.priority === 'high' ? 'urgent' : 'high';
        } else if (action === 'prioritize') {
            if (!priority) return bad(res, 'A priority is required');
            set.priority = priority;
        } else if (action === 'rate') {
            if (c.status !== 'resolved' && c.status !== 'closed') return bad(res, 'Only a resolved complaint can be rated');
            const r = num(rating);
            if (r < 1 || r > 5) return bad(res, 'The rating must be between 1 and 5');
            set.rating = r;
        }

        const update = { $set: set };
        if (push.length) update.$push = { comments: { $each: push } };
        const updated = await HostelComplaint.findByIdAndUpdate(c._id, update, { new: true });

        await logAudit(req, { action, entityType: 'HostelComplaint', entityId: c._id, hostel: c.hostel,
            description: `Complaint ${c.ticketNumber} — ${action}`,
            before: { status: c.status, priority: c.priority },
            after: { status: set.status || c.status, priority: set.priority || c.priority }, meta: { comment } });

        if (c.student && ['assign', 'start', 'resolve', 'close', 'reject', 'escalate'].includes(action)) {
            const settings = await getSettings(req.schoolId);
            await notifyStudentAndParents(req, {
                studentId: c.student, settings, email: false,
                title: `Complaint ${updated.status}`,
                body: `Your hostel complaint ${c.ticketNumber} is now ${updated.status}.`
                    + (set.resolution ? ` ${set.resolution}` : ''),
            });
        }
        if (action === 'assign' && assignedTo) {
            notifyHostelStaff(req, { hostelId: c.hostel,
                title: 'Hostel complaint assigned',
                body: `${c.ticketNumber} (${c.category}) has been assigned.` });
        }
        ok(res, updated);
    } catch (e) { fail(res, e); }
};

/**
 * Escalate complaints that breached their SLA. Idempotent — a complaint already
 * past `dueAt` and escalated once has its due date pushed with the level, so it
 * does not re-escalate on every sweep.
 */
async function escalateOverdue(req, settings) {
    const due = await HostelComplaint.find({
        school: req.schoolId,
        status: { $in: ['open', 'assigned', 'in_progress', 'reopened'] },
        dueAt: { $ne: null, $lt: new Date() },
    }).lean();

    for (const c of due) {
        await HostelComplaint.findByIdAndUpdate(c._id, {
            $set: {
                escalationLevel: (c.escalationLevel || 0) + 1,
                escalatedAt: new Date(),
                escalatedTo: settings.complaintEscalateTo || null,
                priority: c.priority === 'urgent' ? 'urgent' : c.priority === 'high' ? 'urgent' : 'high',
                dueAt: new Date(Date.now() + (settings.complaintSlaHours || 48) * 36e5),
            },
        });
        notifyHostelStaff(req, { hostelId: c.hostel, includeSender: !!req.system,
            title: 'Hostel complaint escalated',
            body: `${c.ticketNumber} (${c.category}) passed its ${settings.complaintSlaHours}h SLA and has been escalated.` });
    }
    if (due.length) {
        await logAudit(req, { action: 'escalate', entityType: 'HostelComplaint',
            description: `Auto-escalated ${due.length} overdue complaint(s)` });
    }
    return due.length;
}

exports.escalateOverdueComplaints = async (req, res) => {
    try {
        const settings = await getSettings(req.schoolId);
        if (!settings.complaintAutoEscalate) return ok(res, { escalated: 0, message: 'Auto-escalation is switched off' });
        ok(res, { escalated: await escalateOverdue(req, settings) });
    } catch (e) { fail(res, e); }
};

/**
 * Everything the half-hourly clock does for one school: overdue passes and
 * leaves (with their alerts), unused passes, overdue invoices — and the two
 * automations a school switches on in Hostel Settings, which until now were
 * switches with nothing behind them: complaint escalation and monthly billing.
 */
exports.runSweep = async (schoolId) => {
    const r = await sweepOverdue(schoolId);
    const settings = await getSettings(schoolId);
    const out = { ...r, escalated: 0, billed: 0, lateFees: 0, reconciled: 0, flagged: 0, mealsChased: 0 };
    const sys = await systemRequest(schoolId);
    if (!sys) return out;                                       // nobody to act as: a school with no admin

    if (settings.complaintAutoEscalate) out.escalated = await escalateOverdue(sys, settings);

    if (settings.autoGenerateMonthlyFees) {
        // This month's bill for every monthly plan. billPlan skips anyone
        // already billed for the period, so running it every half hour
        // bills a resident once — including one who moved in mid-month.
        const now = new Date();
        const plans = await HostelFeePlan.find({ school: schoolId, isActive: true, frequency: 'monthly' }).lean();
        for (const plan of plans.filter((x) => x.status !== 'inactive')) {
            const done = await billPlan(sys, { plan, month: now.getMonth() + 1, year: now.getFullYear(), settings, scope: null });
            out.billed += done.created.length;
        }
        if (out.billed) {
            await logAudit(sys, { action: 'generate', entityType: 'HostelFeeInvoice',
                description: `Raised ${out.billed} monthly hostel invoice(s) automatically` });
        }
    }

    // Late fees kept up to date without the button, where the school asks for that.
    if (settings.autoApplyLateFees) out.lateFees = await lateFeesFor(sys, settings);

    // Online checkouts nobody confirmed: ask the gateway whether the money moved.
    try { out.reconciled = (await payments.reconcileOpen(sys)).paid; }
    catch (e) { console.error('[hostel] reconcile sweep:', e.message); }

    out.flagged = await flagInactiveResidents(sys);
    if (settings.messAttendanceRequired) out.mealsChased = await chaseMealRegisters(sys);
    return out;
};

/**
 * Residents whose school account is no longer active.
 *
 * Nothing outside the hostel knows about beds, so a student struck off in
 * Students — or a teacher who has left — went on holding one. The hostel is
 * told, once per stay (the stamp on the allocation is what makes it once), and
 * decides: a deactivation may be temporary, so the bed is not taken away here.
 * An account that no longer exists at all cannot come back; that bed is freed.
 */
async function flagInactiveResidents(req) {
    // Back in good standing: forget the flag, so a later lapse is reported again.
    await pool.query(
        `UPDATE "${HostelAllocation.tableName}" a SET "inactiveFlaggedAt" = NULL
           FROM "users" u WHERE u."_id" = a."student" AND u."isActive" AND a."school" = $1 AND a."inactiveFlaggedAt" IS NOT NULL`, [String(req.schoolId)]);
    const { rows } = await pool.query(
        `SELECT a."_id", a."student", a."hostel", u."name", (u."_id" IS NULL) AS "gone", h."name" AS "hostelName", r."roomNumber", b."bedNumber"
           FROM "${HostelAllocation.tableName}" a
           LEFT JOIN "users" u ON u."_id" = a."student"
           LEFT JOIN "${Hostel.tableName}" h ON h."_id" = a."hostel"
           LEFT JOIN "${HostelRoom.tableName}" r ON r."_id" = a."room"
           LEFT JOIN "${HostelBed.tableName}" b ON b."_id" = a."bed"
          WHERE a."school" = $1 AND a."status" IN ('pending', 'active') AND a."inactiveFlaggedAt" IS NULL
            AND (u."_id" IS NULL OR u."isActive" = false)`, [String(req.schoolId)]);
    for (const x of rows) {
        if (x.gone) {
            try {
                await alloc.releaseBed({ schoolId: req.schoolId, allocationId: x._id, actorId: req.userId, actorName: 'System',
                    reason: 'The account no longer exists', status: 'vacated' });
                await logAudit(req, { action: 'release', entityType: 'HostelAllocation', entityId: x._id, hostel: x.hostel,
                    description: `Freed ${x.hostelName} · ${x.roomNumber} · Bed ${x.bedNumber}: the resident's account no longer exists` });
            } catch (e) { console.error('[hostel] could not free an orphaned bed:', e.message); }
            continue;
        }
        await HostelAllocation.findByIdAndUpdate(x._id, { $set: { inactiveFlaggedAt: new Date() } });
        notifyHostelStaff(req, { hostelId: x.hostel, includeSender: true, title: 'Resident\'s account is inactive',
            body: `${x.name}'s school account has been deactivated, but they still hold ${x.hostelName} · ${x.roomNumber} · Bed ${x.bedNumber}. Vacate the bed from Allocations if they have left.` });
    }
    return rows.length;
}

/**
 * "Mess attendance required": a meal whose time has passed with nobody marked
 * is chased — once per mess, meal and day — so a register that was simply
 * forgotten is noticed the same day rather than at the month's reckoning.
 */
async function chaseMealRegisters(req) {
    const now = new Date();
    const { start, end } = dayRange(now);
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const messes = await HostelMess.find({ school: req.schoolId, isActive: true }).lean();
    let chased = 0;
    for (const mess of messes) {
        const members = await HostelMessMember.countDocuments({ school: req.schoolId, mess: mess._id, status: 'active' });
        if (!members) continue;
        for (const [meal, t] of Object.entries(mess.mealTimings || {})) {
            if (!t || t.enabled === false || !t.end) continue;
            const over = atTime(now, t.end);
            if (!over || now - over < 30 * 60000) continue;         // not over yet, or only just
            const key = `${today}:${meal}`;
            if ((mess.attendanceReminders || []).includes(key)) continue;
            const { rows: [m] } = await pool.query(
                `SELECT count(*)::int AS "n" FROM "${HostelMessAttendance.tableName}"
                  WHERE "school" = $1 AND "mess" = $2 AND "meal" = $3 AND "date" >= $4 AND "date" < $5 AND COALESCE("selfMarked", false) = false`,
                [String(req.schoolId), String(mess._id), meal, start, end]);
            // Asked once whether or not it was marked: a marked meal needs no chasing later either.
            await HostelMess.findByIdAndUpdate(mess._id, { $set: { attendanceReminders: [...(mess.attendanceReminders || []), key].slice(-40) } });
            mess.attendanceReminders = [...(mess.attendanceReminders || []), key];
            if (m.n > 0) continue;
            chased += 1;
            const { notify } = require('../services/notifyService');
            const admins = await require('../services/notifyService').schoolAdminIds(req.schoolId);
            notify({ school: req.schoolId, sender: req.userId, senderRole: 'system', includeSender: true,
                recipients: [...new Set([mess.inCharge, ...admins].filter(Boolean).map(String))],
                title: 'Meal attendance not recorded',
                body: `${meal[0].toUpperCase()}${meal.slice(1)} at ${mess.name} ended at ${t.end} and no attendance has been recorded for its ${members} member(s).`,
                link: { type: 'hostel' } });
        }
    }
    return chased;
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAINTENANCE (spec §18)
// ═════════════════════════════════════════════════════════════════════════════
exports.getMaintenance = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { status, category, priority, maintenanceType, room } = req.query;
        if (status && status !== 'all') q.status = status;
        if (category) q.category = category;
        if (priority) q.priority = priority;
        if (maintenanceType) q.maintenanceType = maintenanceType;
        if (room) q.room = room;

        const [rows, total, cost] = await Promise.all([
            HostelMaintenance.find(q).sort('-createdAt').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('hostel', 'name').populate('room', 'roomNumber')
                .populate('technician', 'name').populate('raisedBy', 'name').lean(),
            HostelMaintenance.countDocuments(q),
            HostelMaintenance.aggregate([
                { $match: { school: toId(req.schoolId), status: 'completed' } },
                { $group: { _id: null, total: { $sum: '$actualCost' } } },
            ]),
        ]);
        ok(res, { ...paged(rows, total, p), totalCost: cost[0]?.total || 0 });
    } catch (e) { fail(res, e); }
};

exports.createMaintenance = async (req, res) => {
    try {
        const b = req.body;
        if (!b.description || !b.hostel) return bad(res, 'Hostel and description are required');
        if (!await mayTouchHostel(req, b.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const row = await HostelMaintenance.create({
            ...b, school: req.schoolId,
            requestNumber: await nextNumber(HostelMaintenance, req.schoolId, 'HM'),
            estimatedCost: num(b.estimatedCost), recurEveryDays: num(b.recurEveryDays),
            raisedBy: req.userId,
        });
        await logAudit(req, { action: 'create', entityType: 'HostelMaintenance', entityId: row._id, hostel: row.hostel,
            description: `Maintenance ${row.requestNumber} raised (${row.category})` });
        await notifyHostelStaff(req, { hostelId: row.hostel,
            title: `Maintenance request — ${row.category}`,
            body: `${row.requestNumber} (${row.priority}): ${String(row.description).slice(0, 180)}` });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.updateMaintenance = async (req, res) => {
    try {
        const before = await HostelMaintenance.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Maintenance request not found', 404);
        if (!await mayTouchHostel(req, before.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const body = { ...req.body };
        for (const f of ['school', '_id', 'hostel', 'requestNumber', 'updates']) delete body[f];
        if (body.actualCost !== undefined) body.actualCost = num(body.actualCost);
        if (body.estimatedCost !== undefined) body.estimatedCost = num(body.estimatedCost);

        const row = await HostelMaintenance.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelMaintenance', entityId: row._id, hostel: row.hostel,
            description: `Updated maintenance ${row.requestNumber}`, before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/**
 * Drive a work order. Completing a recurring preventive job also schedules its
 * next occurrence, which is the whole point of `recurEveryDays`.
 */
exports.actOnMaintenance = async (req, res) => {
    try {
        const { action, technician = null, technicianName = '', vendorName = '', cost = null, resolution = '', comment = '', scheduledDate = null } = req.body;
        const valid = ['assign', 'start', 'hold', 'complete', 'cancel', 'comment', 'schedule'];
        if (!valid.includes(action)) return bad(res, `Action must be one of: ${valid.join(', ')}`);

        const m = await HostelMaintenance.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!m) return bad(res, 'Maintenance request not found', 404);
        if (!await mayTouchHostel(req, m.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const now = new Date();
        const set = {};
        const push = comment ? [{ by: req.userId, byName: req.user?.name || '', text: comment, at: now }] : [];

        if (action === 'assign') {
            set.technician = technician; set.technicianName = technicianName; set.vendorName = vendorName;
            set.assignedAt = now;
            if (m.status === 'open') set.status = 'assigned';
        } else if (action === 'start') {
            if (['completed', 'cancelled'].includes(m.status)) return bad(res, `A ${m.status} request cannot be started`);
            set.status = 'in_progress'; set.startedAt = m.startedAt || now;
        } else if (action === 'hold') {
            set.status = 'on_hold';
        } else if (action === 'complete') {
            if (m.status === 'completed') return bad(res, 'This request is already complete');
            set.status = 'completed'; set.completedAt = now;
            set.actualCost = cost != null ? num(cost) : m.actualCost;
            set.resolution = resolution || m.resolution;
        } else if (action === 'cancel') {
            if (m.status === 'completed') return bad(res, 'A completed request cannot be cancelled');
            set.status = 'cancelled';
        } else if (action === 'schedule') {
            if (!scheduledDate) return bad(res, 'A scheduled date is required');
            set.scheduledDate = new Date(scheduledDate);
            set.maintenanceType = m.maintenanceType === 'corrective' ? 'scheduled' : m.maintenanceType;
        }

        const update = { $set: set };
        if (push.length) update.$push = { updates: { $each: push } };
        const updated = await HostelMaintenance.findByIdAndUpdate(m._id, update, { new: true });

        // Roll a recurring preventive job forward.
        let nextJob = null;
        if (action === 'complete' && m.recurEveryDays > 0) {
            nextJob = await HostelMaintenance.create({
                school: req.schoolId, hostel: m.hostel, building: m.building, floor: m.floor,
                room: m.room, asset: m.asset,
                requestNumber: await nextNumber(HostelMaintenance, req.schoolId, 'HM'),
                category: m.category, maintenanceType: 'preventive', priority: m.priority,
                title: m.title, description: m.description,
                recurEveryDays: m.recurEveryDays,
                scheduledDate: new Date(now.getTime() + m.recurEveryDays * 864e5),
                estimatedCost: m.estimatedCost, raisedBy: req.userId,
            });
        }

        await logAudit(req, { action, entityType: 'HostelMaintenance', entityId: m._id, hostel: m.hostel,
            description: `Maintenance ${m.requestNumber} — ${action}`,
            before: { status: m.status, actualCost: m.actualCost },
            after: { status: set.status || m.status, actualCost: set.actualCost ?? m.actualCost } });

        // A completed job closes the complaint that triggered it, if any.
        if (action === 'complete' && m.complaint) {
            await HostelComplaint.findByIdAndUpdate(m.complaint, {
                $set: { status: 'resolved', resolution: set.resolution || 'Maintenance completed', resolutionDate: now, resolvedBy: req.userId },
            });
        }
        ok(res, { maintenance: updated, nextScheduled: nextJob });
    } catch (e) { fail(res, e); }
};

exports.deleteMaintenance = async (req, res) => {
    try {
        const m = await HostelMaintenance.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!m) return bad(res, 'Maintenance request not found', 404);
        if (!await mayTouchHostel(req, m.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (m.status === 'completed') return bad(res, 'A completed request is history and cannot be deleted');
        await HostelMaintenance.findByIdAndUpdate(m._id, { $set: { status: 'cancelled' } });
        await logAudit(req, { action: 'cancel', entityType: 'HostelMaintenance', entityId: m._id, hostel: m.hostel,
            description: `Cancelled maintenance ${m.requestNumber}` });
        ok(res, { _id: m._id });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ASSETS (spec §19) — mapping over the existing Inventory module
// ═════════════════════════════════════════════════════════════════════════════
exports.getAssets = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { room, category, status, issuedTo } = req.query;
        if (room) q.room = room;
        if (category) q.category = category;
        if (status && status !== 'all') q.status = status;
        if (issuedTo) q.issuedTo = issuedTo;

        const [rows, total] = await Promise.all([
            HostelAsset.find(q).sort('-createdAt').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('hostel', 'name').populate('room', 'roomNumber')
                .populate('issuedTo', 'name profileImage')
                .populate('inventoryAsset', 'assetCode name serialNumber status purchaseCost warrantyExpiry').lean(),
            HostelAsset.countDocuments(q),
        ]);
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

/**
 * Place an asset in a hostel. When `inventoryAsset` is supplied the descriptive
 * fields are copied from the Inventory record and the inventory row is moved to
 * 'assigned' — the Inventory module keeps owning the asset's financial life.
 */
exports.createAsset = async (req, res) => {
    try {
        const b = req.body;
        if (!b.hostel) return bad(res, 'Hostel is required');
        if (!await mayTouchHostel(req, b.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        let payload = { ...b };
        if (b.inventoryAsset) {
            const inv = await InventoryAsset.findOne({ _id: b.inventoryAsset, school: req.schoolId }).lean();
            if (!inv) return bad(res, 'That inventory asset was not found');
            const already = await HostelAsset.findOne({
                school: req.schoolId, inventoryAsset: inv._id, status: { $nin: ['returned', 'disposed'] },
            }).lean();
            if (already) return bad(res, 'That inventory asset is already placed in a hostel');
            payload = {
                ...payload,
                name: b.name || inv.name,
                assetCode: b.assetCode || inv.assetCode,
                inventoryItem: inv.item || null,
            };
        }
        if (!payload.name) return bad(res, 'Asset name is required');

        const row = await HostelAsset.create({
            ...payload, quantity: num(payload.quantity, 1), school: req.schoolId, createdBy: req.userId,
        });
        if (b.inventoryAsset) {
            const room = row.room ? await HostelRoom.findById(row.room).select('roomNumber').lean() : null;
            await InventoryAsset.findByIdAndUpdate(b.inventoryAsset, {
                $set: { status: 'assigned', location: room ? `Hostel room ${room.roomNumber}` : 'Hostel' },
            });
        }
        await logAudit(req, { action: 'create', entityType: 'HostelAsset', entityId: row._id, hostel: row.hostel,
            description: `Added asset ${row.name}${row.assetCode ? ` (${row.assetCode})` : ''}` });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.updateAsset = async (req, res) => {
    try {
        const before = await HostelAsset.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Asset not found', 404);
        if (!await mayTouchHostel(req, before.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const body = { ...req.body };
        for (const f of ['school', '_id', 'hostel', 'issuedTo', 'issuedAt', 'returnedAt']) delete body[f];
        const row = await HostelAsset.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelAsset', entityId: row._id, hostel: row.hostel,
            description: `Updated asset ${row.name}`, before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/** Issue / return / transfer / damage / replace / repair an asset (spec §19). */
/**
 * An asset's label: its code as a QR image, to print and stick on it. Scanning
 * the label on the Assets screen finds the asset again.
 */
exports.assetQr = async (req, res) => {
    try {
        const a = await HostelAsset.findOne({ _id: req.params.id, school: req.schoolId }).select('name assetCode hostel').lean();
        if (!a) return bad(res, 'Asset not found', 404);
        if (!await mayTouchHostel(req, a.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const code = a.assetCode || `HA:${a._id}`;
        ok(res, { code, name: a.name, qrImage: matrixToDataUri(qrcode.encode(code), { scale: 6, quietZone: 4 }) });
    } catch (e) { fail(res, e); }
};

exports.actOnAsset = async (req, res) => {
    try {
        const { action, student = null, room = null, note = '', damageCharge = null, condition = null } = req.body;
        const valid = ['issue', 'return', 'transfer', 'damage', 'replace', 'repair', 'restore', 'dispose'];
        if (!valid.includes(action)) return bad(res, `Action must be one of: ${valid.join(', ')}`);

        const a = await HostelAsset.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!a) return bad(res, 'Asset not found', 404);
        if (!await mayTouchHostel(req, a.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        if (['replaced', 'disposed'].includes(a.status)) return bad(res, `This asset has been ${a.status} — it can no longer be changed`);

        const now = new Date();
        // The note describes THIS step and goes to the activity log. It used to
        // overwrite `remarks`, which is the asset's own description — issuing a
        // bed "for exam week" renamed the bed.
        const set = {};

        if (action === 'issue') {
            if (!student) return bad(res, 'A student is required to issue an asset');
            if (a.status === 'issued') return bad(res, 'This asset is already on issue');
            const resident = await HostelAllocation.findOne({ school: req.schoolId, student, status: 'active' }).lean();
            if (!resident) return bad(res, 'Only a current hostel resident can be issued an asset');
            set.status = 'issued'; set.issuedTo = student; set.issuedAt = now; set.returnedAt = null;
        } else if (action === 'return') {
            if (a.status !== 'issued') return bad(res, 'This asset is not on issue');
            set.status = 'in_room'; set.returnedAt = now; set.issuedTo = null;
            if (condition) set.condition = condition;
        } else if (action === 'transfer') {
            if (!room) return bad(res, 'A destination room is required');
            const target = await HostelRoom.findOne({ _id: room, school: req.schoolId }).lean();
            if (!target) return bad(res, 'Destination room not found');
            if (!await mayTouchHostel(req, target.hostel)) return bad(res, 'You do not have access to that hostel', 403);
            set.room = target._id; set.hostel = target.hostel; set.building = target.building; set.floor = target.floor;
        } else if (action === 'damage') {
            set.status = 'damaged'; set.condition = 'damaged';
            set.damageNote = note; set.damageCharge = num(damageCharge);
        } else if (action === 'replace') {
            set.status = 'replaced'; set.condition = condition || 'scrapped'; set.issuedTo = null;
        } else if (action === 'repair') {
            set.status = 'under_repair';
        } else if (action === 'restore') {
            // Back from the workshop: in service again, with whoever held it.
            if (!['under_repair', 'damaged'].includes(a.status)) return bad(res, 'Only an asset that is damaged or under repair can be put back in service');
            set.status = a.issuedTo ? 'issued' : 'in_room';
            set.condition = ['new', 'good', 'fair'].includes(condition) ? condition : 'good';
        } else if (action === 'dispose') {
            set.status = 'disposed'; set.condition = 'scrapped'; set.issuedTo = null;
        }

        const updated = await HostelAsset.findByIdAndUpdate(a._id, { $set: set }, { new: true });

        // Keep the Inventory record in step when this maps to one.
        if (a.inventoryAsset) {
            const invStatus = { issue: 'assigned', return: 'assigned', restore: 'assigned', repair: 'under_repair', dispose: 'disposed', damage: 'under_repair' }[action];
            if (invStatus) await InventoryAsset.findByIdAndUpdate(a.inventoryAsset, { $set: { status: invStatus } });
        }

        // A damage charge is billed like any other hostel fine.
        let fine = null;
        if (action === 'damage' && num(damageCharge) > 0 && (a.issuedTo || student)) {
            fine = await raiseFine(req, {
                studentId: a.issuedTo || student, hostelId: a.hostel,
                amount: num(damageCharge),
                remarks: `Damage to hostel asset ${a.name}${note ? ` — ${note}` : ''}`,
            });
        }
        await logAudit(req, { action, entityType: 'HostelAsset', entityId: a._id, hostel: a.hostel,
            description: `Asset ${a.name} — ${action}${note ? `: ${String(note).slice(0, 160)}` : ''}`,
            before: { status: a.status, issuedTo: a.issuedTo }, after: { status: set.status || a.status, issuedTo: set.issuedTo }, meta: { note } });
        ok(res, { asset: updated, fine });
    } catch (e) { fail(res, e); }
};

// Inventory assets that are free to be placed in a hostel.
exports.getAvailableInventoryAssets = async (req, res) => {
    try {
        const placed = await HostelAsset.find({ school: req.schoolId, inventoryAsset: { $ne: null }, status: { $nin: ['returned', 'disposed'] } })
            .select('inventoryAsset').lean();
        const taken = new Set(placed.map((p) => String(p.inventoryAsset)));
        const rows = await InventoryAsset.find({ school: req.schoolId, status: { $in: ['in_store', 'assigned'] } })
            .select('name assetCode serialNumber status purchaseCost').sort('name').limit(300).lean();
        ok(res, rows.filter((r) => !taken.has(String(r._id))));
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  SECURITY & STUDENT MOVEMENT (spec §20)
// ═════════════════════════════════════════════════════════════════════════════
exports.getMovements = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { student, direction, movementType, date, from, to } = req.query;
        if (student) q.student = student;
        if (direction) q.direction = direction;
        if (movementType) q.movementType = movementType;
        if (date) { const r = dayRange(date); q.at = { $gte: r.start, $lt: r.end }; }
        else if (from || to) {
            q.at = {};
            if (from) q.at.$gte = dayRange(from).start;
            if (to) q.at.$lt = dayRange(to).end;
        }
        const [rows, total] = await Promise.all([
            HostelMovement.find(q).sort('-at').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name profileImage').populate('hostel', 'name')
                .populate('recordedBy', 'name').lean(),
            HostelMovement.countDocuments(q),
        ]);
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

/** Manual gate entry/exit — the guard's screen when there is no pass to scan. */
exports.recordMovement = async (req, res) => {
    try {
        const b = req.body;
        if (!b.direction || !['in', 'out'].includes(b.direction)) return bad(res, "Direction must be 'in' or 'out'");
        if (!b.student && !b.personName) return bad(res, 'A student or a person name is required');

        let allocation = null;
        if (b.student) {
            allocation = await HostelAllocation.findOne({ school: req.schoolId, student: b.student, status: 'active' }).lean();
            if (!allocation) return bad(res, 'This student is not currently a hostel resident');
            if (!await mayTouchHostel(req, allocation.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        }

        // A gate exit after curfew is worth flagging, not blocking — the warden
        // decides what to do with it.
        const settings = await getSettings(req.schoolId);
        const now = b.at ? new Date(b.at) : new Date();
        const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const afterCurfew = !!settings.curfewTime && hhmm > settings.curfewTime;

        const row = await HostelMovement.create({
            ...b,
            school: req.schoolId,
            hostel: b.hostel || allocation?.hostel,
            at: now,
            isLate: afterCurfew,
            remarks: b.remarks || (afterCurfew ? `After curfew (${settings.curfewTime})` : ''),
            recordedBy: req.userId,
        });
        if (allocation) {
            await HostelAllocation.findByIdAndUpdate(allocation._id, { $set: { presence: b.direction === 'out' ? 'out' : 'in' } });
        }
        await logAudit(req, { action: b.direction === 'out' ? 'gate_out' : 'gate_in',
            entityType: 'HostelMovement', entityId: row._id, hostel: row.hostel,
            description: `Gate ${b.direction} recorded${afterCurfew ? ' after curfew' : ''}`, meta: { gate: b.gate } });

        let fine = null;
        if (afterCurfew && b.student) {
            await notifyHostelStaff(req, { hostelId: row.hostel,
                title: 'After-curfew movement',
                body: `A resident moved ${b.direction} at ${hhmm}, after the ${settings.curfewTime} curfew.` });
            // Coming in after curfew is the violation the fine in Hostel Settings is
            // for. (A late return on an outpass is billed by the gate scan instead.)
            if (b.direction === 'in' && settings.curfewViolationFine > 0) {
                fine = await raiseFine(req, {
                    studentId: b.student, hostelId: row.hostel, allocationId: allocation._id,
                    amount: settings.curfewViolationFine, remarks: `Returned at ${hhmm}, after the ${settings.curfewTime} curfew`, settings,
                });
            }
        }
        ok(res, fine ? { ...(row.toObject?.() ?? row), fine } : row);
    } catch (e) { fail(res, e); }
};

/** The live "who is where" board (spec §20). */
exports.getLiveMovement = async (req, res) => {
    try {
        const q = await scopedFilter(req, { status: 'active' });
        const [inside, outside, onLeave, activeOutpasses, overdue, recent] = await Promise.all([
            HostelAllocation.countDocuments({ ...q, presence: 'in' }),
            HostelAllocation.countDocuments({ ...q, presence: 'out' }),
            HostelAllocation.countDocuments({ ...q, presence: 'on_leave' }),
            HostelOutpass.find(await scopedFilter(req, { status: 'active' }))
                .populate('student', 'name profileImage').sort('-actualDepartureAt').limit(50).lean(),
            HostelOutpass.find(await scopedFilter(req, { status: 'overdue' }))
                .populate('student', 'name profileImage').sort('expectedReturnAt').limit(50).lean(),
            HostelMovement.find(await scopedFilter(req, {})).sort('-at').limit(30)
                .populate('student', 'name profileImage').lean(),
        ]);
        ok(res, { inside, outside, onLeave, activeOutpasses, overdue, recent });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  INCIDENTS & MEDICAL (spec §21, §22)
// ═════════════════════════════════════════════════════════════════════════════
exports.getIncidents = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { status, incidentType, severity, student, medical } = req.query;
        if (status && status !== 'all') q.status = status;
        if (incidentType) q.incidentType = incidentType;
        if (severity) q.severity = severity;
        if (student) q.student = student;
        if (medical === 'true') q.incidentType = 'medical_emergency';

        const [rows, total] = await Promise.all([
            HostelIncident.find(q).sort('-date').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name profileImage').populate('hostel', 'name')
                .populate('room', 'roomNumber').populate('assignedOfficer', 'name')
                .populate('reportedBy', 'name').lean(),
            HostelIncident.countDocuments(q),
        ]);
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

exports.getIncident = async (req, res) => {
    try {
        const i = await HostelIncident.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('student', 'name email profileImage').populate('hostel', 'name')
            .populate('room', 'roomNumber').populate('assignedOfficer', 'name email')
            .populate('involvedStudents', 'name profileImage').lean();
        if (!i) return bad(res, 'Incident not found', 404);
        if (!await mayTouchHostel(req, i.hostel?._id || i.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        // Medical baseline comes from the existing student record, never a copy.
        const [medical, discipline, documents] = await Promise.all([
            i.student ? studentSnapshot(req.schoolId, i.student._id || i.student) : null,
            HostelDiscipline.find({ school: req.schoolId, incident: i._id }).lean(),
            HostelDocument.find({ school: req.schoolId, entityType: 'HostelIncident', entityId: i._id, isActive: true }).lean(),
        ]);
        ok(res, {
            ...i, studentDetails: medical, discipline, documents,
            attachmentUrls: (i.attachments || []).map((f) => signedFileUrl(f)),
        });
    } catch (e) { fail(res, e); }
};

exports.createIncident = async (req, res) => {
    try {
        const b = req.body;
        if (!b.description || !b.hostel) return bad(res, 'Hostel and description are required');
        if (!await mayTouchHostel(req, b.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const row = await HostelIncident.create({
            ...b, school: req.schoolId,
            incidentNumber: await nextNumber(HostelIncident, req.schoolId, 'HI'),
            reportedBy: req.userId, reportedByName: req.user?.name || '',
        });
        const settings = await getSettings(req.schoolId);
        await logAudit(req, { action: 'create', entityType: 'HostelIncident', entityId: row._id, hostel: row.hostel,
            description: `Incident ${row.incidentNumber} reported (${row.incidentType}/${row.severity})` });

        await notifyHostelStaff(req, { hostelId: row.hostel,
            title: `Hostel incident — ${row.incidentType.replace(/_/g, ' ')}`,
            body: `${row.incidentNumber} (${row.severity}): ${row.title ? `${row.title} — ` : ''}${String(row.description).slice(0, 200)}`,
            email: ['high', 'critical'].includes(row.severity) });

        // Parents hear about anything involving their child, and immediately for
        // a medical emergency.
        if (row.student) {
            const medical = row.incidentType === 'medical_emergency';
            await notifyStudentAndParents(req, {
                studentId: row.student, settings, settingKey: 'notifyParentOnIncident',
                title: medical ? 'Medical attention at the hostel' : 'Hostel incident reported',
                body: medical
                    ? `${row.title ? `${row.title}. ` : ''}${row.description}${row.treatmentGiven ? ` Treatment: ${row.treatmentGiven}.` : ''}${row.hospitalName ? ` Hospital: ${row.hospitalName}.` : ''}`
                    : `An incident (${row.incidentType.replace(/_/g, ' ')}) involving your ward has been recorded at the hostel.`,
                email: true,
            });
            if (medical) await HostelIncident.findByIdAndUpdate(row._id, { $set: { parentNotifiedAt: new Date() } });
            // A resident unwell in the hostel: the Medical Room hears of it, and sees them in the morning.
            if (medical) await require('../services/medicalHostel').fromHostelIncident(req, row).catch((e) => console.error('[hostel] → medical room:', e.message));
        }
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.updateIncident = async (req, res) => {
    try {
        const before = await HostelIncident.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Incident not found', 404);
        if (!await mayTouchHostel(req, before.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const body = { ...req.body };
        for (const f of ['school', '_id', 'incidentNumber', 'reportedBy', 'reportedByName', 'resolvedAt', 'parentNotifiedAt']) delete body[f];
        if (body.hostel && String(body.hostel) !== String(before.hostel) && !await mayTouchHostel(req, body.hostel)) {
            return bad(res, 'You do not have access to that hostel', 403);
        }
        // Resolved or closed carries the day it was dealt with; reopening clears it.
        if (['resolved', 'closed'].includes(body.status) && !before.resolvedAt) body.resolvedAt = new Date();
        if (['reported', 'investigating', 'action_taken'].includes(body.status)) body.resolvedAt = null;

        const row = await HostelIncident.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelIncident', entityId: row._id, hostel: row.hostel,
            description: `Updated incident ${row.incidentNumber}`, before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  DISCIPLINE (spec §23)
// ═════════════════════════════════════════════════════════════════════════════
exports.getDisciplineActions = async (req, res) => {
    try {
        const p = page(req.query);
        const q = await scopedFilter(req, {});
        const { student, actionType, severity, status } = req.query;
        if (student) q.student = student;
        if (actionType) q.actionType = actionType;
        if (severity) q.severity = severity;
        if (status && status !== 'all') q.status = status;

        const [rows, total] = await Promise.all([
            HostelDiscipline.find(q).sort('-date').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name profileImage').populate('hostel', 'name')
                .populate('issuedBy', 'name').populate('incident', 'incidentNumber incidentType').lean(),
            HostelDiscipline.countDocuments(q),
        ]);
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

/**
 * Issue a disciplinary action. Repeat offences are detected from the student's
 * prior actions and stamped on the row, so "track repeated violations" survives
 * later archiving. A fine is billed through the same path as every other charge.
 */
exports.createDisciplineAction = async (req, res) => {
    try {
        const b = { ...req.body };
        if (!b.student || !b.violation || !b.actionType) {
            return bad(res, 'Student, violation and action type are required');
        }
        // Settled here, never taken from the form.
        for (const f of ['fineInvoice', 'parentNotified', 'parentNotifiedAt', 'status', 'escalatedToPrincipal', 'escalatedAt']) delete b[f];
        if (b.incident && !await HostelIncident.exists({ _id: b.incident, school: req.schoolId })) return bad(res, 'That incident was not found', 404);
        const allocation = await HostelAllocation.findOne({ school: req.schoolId, student: b.student, status: 'active' }).lean();
        const hostelId = b.hostel || allocation?.hostel;
        if (!hostelId) return bad(res, 'This student is not a hostel resident and no hostel was given');
        if (!await mayTouchHostel(req, hostelId)) return bad(res, 'You do not have access to this hostel', 403);

        const priorCount = await HostelDiscipline.countDocuments({ school: req.schoolId, student: b.student });
        const settings = await getSettings(req.schoolId);

        const row = await HostelDiscipline.create({
            ...b,
            school: req.schoolId, hostel: hostelId,
            actionNumber: await nextNumber(HostelDiscipline, req.schoolId, 'HD'),
            fineAmount: num(b.fineAmount),
            priorCount,
            isRepeatOffence: priorCount > 0,
            escalatedToPrincipal: b.actionType === 'principal_escalation',
            escalatedAt: b.actionType === 'principal_escalation' ? new Date() : null,
            issuedBy: req.userId, issuedByName: req.user?.name || '',
        });

        // A fine becomes an invoice — one billing path for the whole module.
        let fine = null;
        if (row.fineAmount > 0) {
            fine = await raiseFine(req, {
                studentId: b.student, hostelId, allocationId: allocation?._id,
                amount: row.fineAmount,
                remarks: `Disciplinary fine — ${row.violation} (${row.actionNumber})`,
                settings,
            });
            await HostelDiscipline.findByIdAndUpdate(row._id, { $set: { fineInvoice: fine._id } });
        }

        await logAudit(req, { action: 'create', entityType: 'HostelDiscipline', entityId: row._id, hostel: hostelId,
            description: `Disciplinary action ${row.actionNumber}: ${row.actionType.replace(/_/g, ' ')} for ${row.violation}`,
            after: { actionType: row.actionType, fineAmount: row.fineAmount, isRepeatOffence: row.isRepeatOffence } });

        await notifyStudentAndParents(req, {
            studentId: b.student, settings, settingKey: 'notifyParentOnDiscipline',
            title: 'Hostel disciplinary action',
            body: `${row.actionType.replace(/_/g, ' ')} issued for: ${row.violation}.`
                + (row.fineAmount ? ` A fine of ${row.fineAmount} has been raised.` : '')
                + (row.isRepeatOffence ? ` This is a repeat offence (${priorCount} prior action(s)).` : ''),
            email: true,
        });
        if (row.actionType === 'principal_escalation' || row.severity === 'major') {
            await notifyHostelStaff(req, { hostelId,
                title: 'Disciplinary escalation',
                body: `${row.actionNumber}: ${row.violation} — escalated.`, email: true });
        }
        await HostelDiscipline.findByIdAndUpdate(row._id, { $set: { parentNotified: true, parentNotifiedAt: new Date() } });
        ok(res, { action: row, fine });
    } catch (e) { fail(res, e); }
};

exports.updateDisciplineAction = async (req, res) => {
    try {
        const before = await HostelDiscipline.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return bad(res, 'Disciplinary action not found', 404);
        if (!await mayTouchHostel(req, before.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const body = { ...req.body };
        // The fine and its invoice are settled at issue time and never re-edited.
        for (const f of ['school', '_id', 'student', 'actionNumber', 'fineAmount', 'fineInvoice', 'priorCount', 'isRepeatOffence', 'issuedBy', 'issuedByName']) delete body[f];
        if (body.hostel && String(body.hostel) !== String(before.hostel) && !await mayTouchHostel(req, body.hostel)) {
            return bad(res, 'You do not have access to that hostel', 403);
        }

        const row = await HostelDiscipline.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { $set: body }, { new: true });
        const d = diffFields(before, row, Object.keys(body));
        await logAudit(req, { action: 'update', entityType: 'HostelDiscipline', entityId: row._id, hostel: row.hostel,
            description: `Updated disciplinary action ${row.actionNumber}`, before: d.before, after: d.after });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/** A student's disciplinary record with the repeat-offence roll-up. */
exports.getStudentDiscipline = async (req, res) => {
    try {
        const q = await scopedFilter(req, { student: req.params.studentId });
        const rows = await HostelDiscipline.find(q)
            .sort('-date').populate('issuedBy', 'name').populate('incident', 'incidentNumber').lean();
        const byType = rows.reduce((m, r) => { m[r.actionType] = (m[r.actionType] || 0) + 1; return m; }, {});
        const totalFines = rows.reduce((s, r) => s + (r.fineAmount || 0), 0);
        ok(res, { actions: rows, total: rows.length, byType, totalFines,
                  repeatOffender: rows.length > 1, lastAction: rows[0] || null });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  DOCUMENTS (spec §25) — metadata over the existing uploads pipeline
// ═════════════════════════════════════════════════════════════════════════════
const path = require('path');
const fs   = require('fs');

exports.getDocuments = async (req, res) => {
    try {
        const p = page(req.query);
        const q = { school: req.schoolId, isActive: true };
        const allowed = await visibleHostelIds(req);
        if (allowed !== null && !req.query.student) q.hostel = allowed.length ? { $in: allowed } : '__none__';
        if (req.query.hostel) q.hostel = (allowed === null || allowed.includes(String(req.query.hostel))) ? req.query.hostel : '__none__';
        if (req.query.student) {
            q.student = req.query.student;
            // Asking by student used to skip the hostel scope altogether, so a
            // warden could read the papers of any student in the school.
            if (allowed !== null) {
                const lives = await HostelAllocation.exists({ school: req.schoolId, student: req.query.student, hostel: { $in: allowed }, status: { $in: ['active', 'pending'] } });
                if (!lives) return ok(res, paged([], 0, p));
            }
        }
        if (req.query.docType) q.docType = req.query.docType;
        if (req.query.entityType) { q.entityType = req.query.entityType; q.entityId = req.query.entityId; }
        if (req.query.verificationStatus) q.verificationStatus = req.query.verificationStatus;
        if (req.query.expiring === 'true') {
            q.expiryDate = { $ne: null, $lte: new Date(Date.now() + 30 * 864e5) };
        }
        const [rows, total] = await Promise.all([
            HostelDocument.find(q).sort('-createdAt').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('student', 'name profileImage').populate('uploadedBy', 'name')
                .populate('verifiedBy', 'name').lean(),
            HostelDocument.countDocuments(q),
        ]);
        rows.forEach((r) => { r.url = signedFileUrl(r.storedName); });
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};

/**
 * Upload one file and return the stored filename.
 *
 * Complaints, incidents, maintenance requests, leaves and outpasses all keep
 * `attachments: [String]` — the bare filename under uploads/hostel-docs. This
 * endpoint is what turns a picked file into one of those strings, so the forms
 * can attach evidence without five separate multipart routes. When `entityType`
 * and `entityId` are supplied the file is ALSO registered as a HostelDocument,
 * so it shows up in the documents register and can be verified there.
 */
exports.uploadAttachment = async (req, res) => {
    try {
        if (!req.file) return bad(res, 'A file is required');
        const { entityType = '', entityId = null, docType = 'other', student = null, hostel = null } = req.body;

        let document = null;
        if (entityType && entityId) {
            document = await HostelDocument.create({
                school: req.schoolId,
                hostel: hostel || null,
                student: student || null,
                entityType, entityId, docType,
                title: req.file.originalname,
                originalName: req.file.originalname,
                storedName: req.file.filename,
                mimeType: req.file.mimetype,
                fileSize: req.file.size,
                uploadedBy: req.userId,
                uploaderRole: req.userRole,
            });
        }
        await logAudit(req, { action: 'upload', entityType: 'HostelAttachment', entityId: document?._id || null,
            hostel: hostel || null, description: `Attached ${req.file.originalname}`,
            meta: { entityType, entityId } });

        ok(res, {
            storedName: req.file.filename,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
            url: signedFileUrl(req.file.filename),
            document: document?._id || null,
        });
    } catch (e) { fail(res, e); }
};

/** Upload — multipart, handled by the shared uploadHostelDoc middleware. */
exports.uploadDocument = async (req, res) => {
    try {
        if (!req.file) return bad(res, 'A file is required');
        const b = req.body;
        if (!b.title) return bad(res, 'A document title is required');
        if (b.hostel && !await mayTouchHostel(req, b.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        // A new version of an existing document: it takes over the old one's
        // holder and type, and the old one leaves the register (kept, inactive).
        // A staff document hangs off the member's hostel post, and is filed under that hostel.
        if (!b.replacesDocument && b.entityType === 'HostelStaffAssignment') {
            const post = b.entityId && await HostelStaffAssignment.findOne({ _id: b.entityId, school: req.schoolId }).lean();
            if (!post) return bad(res, 'That staff post was not found', 404);
            if (!await mayTouchHostel(req, post.hostel)) return bad(res, 'You do not have access to this hostel', 403);
            b.hostel = post.hostel; b.student = null;
        }
        if (!b.replacesDocument && b.student && !await User.exists({ _id: b.student, school: req.schoolId })) {
            return bad(res, 'That student was not found', 404);
        }
        let previous = null;
        if (b.replacesDocument) {
            previous = await HostelDocument.findOne({ _id: b.replacesDocument, school: req.schoolId, isActive: true }).lean();
            if (!previous) return bad(res, 'The document being replaced was not found', 404);
            if (!await mayTouchHostel(req, previous.hostel)) return bad(res, 'You do not have access to this hostel', 403);
            Object.assign(b, { hostel: previous.hostel, student: previous.student, entityType: previous.entityType,
                               entityId: previous.entityId, docType: b.docType || previous.docType });
        }

        const row = await HostelDocument.create({
            school: req.schoolId,
            hostel: b.hostel || null,
            student: b.student || null,
            entityType: b.entityType || '',
            entityId: b.entityId || null,
            docType: b.docType || 'other',
            title: b.title,
            description: b.description || '',
            originalName: req.file.originalname,
            storedName: req.file.filename,
            mimeType: req.file.mimetype,
            fileSize: req.file.size,
            expiryDate: b.expiryDate ? new Date(b.expiryDate) : null,
            version: previous ? (previous.version || 1) + 1 : 1,
            replacesDocument: previous ? previous._id : null,
            uploadedBy: req.userId,
            uploaderRole: req.userRole,
        });
        if (previous) await HostelDocument.findByIdAndUpdate(previous._id, { $set: { isActive: false } });
        await logAudit(req, { action: 'upload', entityType: 'HostelDocument', entityId: row._id, hostel: row.hostel,
            description: previous ? `Uploaded version ${row.version} of "${previous.title}"` : `Uploaded ${row.docType} document: ${row.title}` });
        ok(res, { ...row.toObject?.() ?? row, url: signedFileUrl(row.storedName) });
    } catch (e) { fail(res, e); }
};

exports.verifyDocument = async (req, res) => {
    try {
        const { status = 'verified', remark = '' } = req.body;
        if (!['verified', 'rejected', 'pending'].includes(status)) return bad(res, 'Unsupported verification status');
        const d = await HostelDocument.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!d) return bad(res, 'Document not found', 404);
        if (!await mayTouchHostel(req, d.hostel)) return bad(res, 'You do not have access to this hostel', 403);

        const row = await HostelDocument.findByIdAndUpdate(d._id, {
            $set: {
                verificationStatus: status,
                verifiedBy: req.userId, verifiedAt: new Date(), verificationRemark: remark,
            },
        }, { new: true });
        await logAudit(req, { action: 'verify', entityType: 'HostelDocument', entityId: d._id, hostel: d.hostel,
            description: `Document "${d.title}" ${status}`,
            before: { verificationStatus: d.verificationStatus }, after: { verificationStatus: status, remark } });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

// Soft delete — the row and its file survive so history stays intact (spec §31).
exports.deleteDocument = async (req, res) => {
    try {
        const d = await HostelDocument.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!d) return bad(res, 'Document not found', 404);
        if (!await mayTouchHostel(req, d.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        await HostelDocument.findByIdAndUpdate(d._id, { $set: { isActive: false } });
        await logAudit(req, { action: 'delete', entityType: 'HostelDocument', entityId: d._id, hostel: d.hostel,
            description: `Removed document "${d.title}"` });
        ok(res, { _id: d._id });
    } catch (e) { fail(res, e); }
};

exports.downloadDocument = async (req, res) => {
    try {
        const d = await HostelDocument.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!d) return bad(res, 'Document not found', 404);
        if (!await mayTouchHostel(req, d.hostel)) return bad(res, 'You do not have access to this hostel', 403);
        const file = path.join(__dirname, '..', 'uploads', 'hostel-docs', d.storedName);
        if (!fs.existsSync(file)) return bad(res, 'The stored file is missing', 404);
        res.download(file, d.originalName || d.storedName);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  COMMUNICATION (spec §24) — announcements through the existing notifier
// ═════════════════════════════════════════════════════════════════════════════
// Announcements live in hostelAnnouncements.controller.js — they are kept now, not just sent.

// ═════════════════════════════════════════════════════════════════════════════
//  REPORTS (spec §26)
// ═════════════════════════════════════════════════════════════════════════════
const REPORT_TYPES = [
    'occupancy', 'room_occupancy', 'bed_availability', 'allocation', 'admissions',
    'attendance', 'leave', 'outpass', 'late_return', 'visitors', 'fees', 'outstanding_fees',
    'mess', 'assets', 'maintenance', 'complaints', 'incidents', 'discipline',
    'movement', 'expenses', 'revenue', 'warden_activity', 'monthly_summary', 'annual_summary',
];
exports.getReportTypes = (req, res) => ok(res, REPORT_TYPES);

/**
 * One report endpoint (spec §26). Each type returns {columns, rows, summary} so
 * the UI renders, filters, prints and exports every report with one component —
 * the CSV/Excel export is the same shape written out by the export handler.
 */
async function buildReport(req) {
    const { type = 'occupancy', from, to, hostel = null } = req.query;
    const school = req.schoolId;
    const scope = await scopedFilter(req, {}, hostel);
    const range = {};
    if (from) range.$gte = dayRange(from).start;
    if (to) range.$lt = dayRange(to).end;
    const hasRange = Object.keys(range).length > 0;
    const dated = (field) => (hasRange ? { [field]: range } : {});

    const nameOf = (x) => x?.name || '';

    switch (type) {
        case 'occupancy':
        case 'room_occupancy':
        case 'bed_availability': {
            const rooms = await HostelRoom.find({ ...scope, isActive: true })
                .populate('hostel', 'name').populate('building', 'name').populate('floor', 'name').lean();
            const beds = await HostelBed.find({ ...scope, isActive: true }).lean();
            const byRoom = beds.reduce((m, b) => {
                const k = String(b.room);
                m[k] = m[k] || { occupied: 0, available: 0, reserved: 0, maintenance: 0, total: 0 };
                m[k][b.status] = (m[k][b.status] || 0) + 1; m[k].total += 1; return m;
            }, {});
            const rows = rooms.map((r) => {
                const b = byRoom[String(r._id)] || {};
                return {
                    hostel: nameOf(r.hostel), building: nameOf(r.building), floor: nameOf(r.floor),
                    room: r.roomNumber, roomType: r.roomType, capacity: r.capacity,
                    beds: b.total || 0, occupied: b.occupied || 0, available: b.available || 0,
                    reserved: b.reserved || 0, maintenance: b.maintenance || 0,
                    occupancyPercent: b.total ? Math.round(((b.occupied || 0) / b.total) * 100) : 0,
                    status: r.status,
                };
            });
            return {
                columns: ['hostel', 'building', 'floor', 'room', 'roomType', 'capacity', 'beds', 'occupied', 'available', 'reserved', 'maintenance', 'occupancyPercent', 'status'],
                rows,
                summary: {
                    rooms: rows.length,
                    beds: rows.reduce((s, r) => s + r.beds, 0),
                    occupied: rows.reduce((s, r) => s + r.occupied, 0),
                    available: rows.reduce((s, r) => s + r.available, 0),
                },
            };
        }
        case 'allocation': {
            const rows = await HostelAllocation.find({ ...scope, ...(hasRange ? { createdAt: range } : {}) })
                .populate('student', 'name email').populate('hostel', 'name')
                .populate('room', 'roomNumber').populate('bed', 'bedNumber')
                .populate('academicYear', 'yearName').sort('-createdAt').limit(5000).lean();
            return {
                columns: ['student', 'email', 'hostel', 'room', 'bed', 'academicYear', 'type', 'from', 'to', 'status', 'presence'],
                rows: rows.map((r) => ({
                    student: nameOf(r.student), email: r.student?.email || '',
                    hostel: nameOf(r.hostel), room: r.room?.roomNumber || '', bed: r.bed?.bedNumber || '',
                    academicYear: r.academicYear?.yearName || '', type: r.allocationType,
                    from: r.fromDate, to: r.toDate || r.vacatedDate, status: r.status, presence: r.presence,
                })),
                summary: { total: rows.length, active: rows.filter((r) => r.status === 'active').length },
            };
        }
        case 'admissions': {
            const rows = await HostelAdmission.find({ ...scope, ...(hasRange ? { createdAt: range } : {}) })
                .populate('student', 'name').populate('hostel', 'name').populate('academicYear', 'yearName')
                .sort('-createdAt').limit(5000).lean();
            const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
            return {
                columns: ['applicationNumber', 'student', 'hostel', 'academicYear', 'preferredRoomType', 'appliedAt', 'status', 'decisionRemark'],
                rows: rows.map((r) => ({
                    applicationNumber: r.applicationNumber, student: nameOf(r.student), hostel: nameOf(r.hostel),
                    academicYear: r.academicYear?.yearName || '', preferredRoomType: r.preferredRoomType,
                    appliedAt: r.appliedAt, status: r.status, decisionRemark: r.decisionRemark,
                })),
                summary: { total: rows.length, ...byStatus },
            };
        }
        case 'attendance': {
            const rows = await HostelAttendance.find({ ...scope, ...dated('date') })
                .populate('student', 'name').populate('hostel', 'name').populate('room', 'roomNumber')
                .sort('-date').limit(10000).lean();
            const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
            const marked = rows.length;
            return {
                columns: ['date', 'session', 'student', 'hostel', 'room', 'status', 'remarks'],
                rows: rows.map((r) => ({
                    date: r.date, session: r.session, student: nameOf(r.student),
                    hostel: nameOf(r.hostel), room: r.room?.roomNumber || '', status: r.status, remarks: r.remarks,
                })),
                summary: { ...byStatus, marked, presentPercent: marked ? Math.round(((byStatus.present || 0) / marked) * 100) : 0 },
            };
        }
        case 'leave': {
            const rows = await HostelLeave.find({ ...scope, ...(hasRange ? { fromDate: range } : {}) })
                .populate('student', 'name').populate('hostel', 'name').sort('-fromDate').limit(5000).lean();
            const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
            return {
                columns: ['leaveNumber', 'student', 'hostel', 'leaveType', 'fromDate', 'toDate', 'totalDays', 'status', 'reason'],
                rows: rows.map((r) => ({
                    leaveNumber: r.leaveNumber, student: nameOf(r.student), hostel: nameOf(r.hostel),
                    leaveType: r.leaveType, fromDate: r.fromDate, toDate: r.toDate,
                    totalDays: r.totalDays, status: r.status, reason: r.reason,
                })),
                summary: { total: rows.length, ...byStatus, totalDays: rows.reduce((s, r) => s + (r.totalDays || 0), 0) },
            };
        }
        case 'outpass':
        case 'late_return': {
            const q = { ...scope, ...(hasRange ? { departureDate: range } : {}) };
            if (type === 'late_return') q.lateReturnMinutes = { $gt: 0 };
            const rows = await HostelOutpass.find(q)
                .populate('student', 'name').populate('hostel', 'name').sort('-departureDate').limit(5000).lean();
            return {
                columns: ['outpassNumber', 'student', 'hostel', 'outpassType', 'purpose', 'destination', 'departureDate', 'expectedReturnAt', 'actualReturnAt', 'lateReturnMinutes', 'status'],
                rows: rows.map((r) => ({
                    outpassNumber: r.outpassNumber, student: nameOf(r.student), hostel: nameOf(r.hostel),
                    outpassType: r.outpassType, purpose: r.purpose, destination: r.destination,
                    departureDate: r.departureDate, expectedReturnAt: r.expectedReturnAt,
                    actualReturnAt: r.actualReturnAt, lateReturnMinutes: r.lateReturnMinutes, status: r.status,
                })),
                summary: {
                    total: rows.length,
                    late: rows.filter((r) => (r.lateReturnMinutes || 0) > 0).length,
                    totalLateMinutes: rows.reduce((s, r) => s + (r.lateReturnMinutes || 0), 0),
                },
            };
        }
        case 'visitors': {
            const rows = await HostelVisitor.find({ ...scope, isTemplate: false, ...(hasRange ? { createdAt: range } : {}) })
                .populate('student', 'name').populate('hostel', 'name').sort('-createdAt').limit(5000).lean();
            return {
                columns: ['passNumber', 'visitorName', 'relationship', 'student', 'hostel', 'purpose', 'entryTime', 'exitTime', 'status'],
                rows: rows.map((r) => ({
                    passNumber: r.passNumber, visitorName: r.visitorName, relationship: r.relationship,
                    student: nameOf(r.student), hostel: nameOf(r.hostel), purpose: r.purpose,
                    entryTime: r.entryTime, exitTime: r.exitTime, status: r.status,
                })),
                summary: { total: rows.length, checkedIn: rows.filter((r) => r.status === 'checked_in').length },
            };
        }
        case 'fees':
        case 'outstanding_fees':
        case 'revenue': {
            const q = { school, ...(hasRange ? { createdAt: range } : {}) };
            const allowed = await visibleHostelIds(req);
            if (hostel) q.hostel = hostel;
            else if (allowed !== null) q.hostel = allowed.length ? { $in: allowed } : '__none__';
            if (type === 'outstanding_fees') q.status = { $in: ['pending', 'partial', 'overdue'] };
            const rows = await HostelFeeInvoice.find(q).populate('student', 'name').populate('hostel', 'name')
                .sort('-createdAt').limit(5000).lean();
            const billed = rows.reduce((s, r) => s + (r.netAmount || 0), 0);
            const paid = rows.reduce((s, r) => s + (r.paidAmount || 0), 0);
            return {
                columns: ['invoiceNumber', 'student', 'hostel', 'feeType', 'period', 'amount', 'discount', 'lateFee', 'netAmount', 'paidAmount', 'dueDate', 'status'],
                rows: rows.map((r) => ({
                    invoiceNumber: r.invoiceNumber, student: nameOf(r.student), hostel: nameOf(r.hostel),
                    feeType: r.feeType, period: r.period?.label || '',
                    amount: r.amount, discount: r.discount, lateFee: r.lateFee,
                    netAmount: r.netAmount, paidAmount: r.paidAmount, dueDate: r.dueDate, status: r.status,
                })),
                summary: { invoices: rows.length, billed, collected: paid, outstanding: Math.max(0, billed - paid) },
            };
        }
        case 'mess': {
            const rows = await HostelMessAttendance.find({ school, ...(scope.hostel ? { hostel: scope.hostel } : {}), ...dated('date') })
                .populate('student', 'name').populate('mess', 'name').sort('-date').limit(10000).lean();
            const byMeal = rows.reduce((m, r) => { m[r.meal] = (m[r.meal] || 0) + 1; return m; }, {});
            return {
                columns: ['date', 'mess', 'student', 'meal', 'status', 'guestCount'],
                rows: rows.map((r) => ({
                    date: r.date, mess: nameOf(r.mess), student: nameOf(r.student),
                    meal: r.meal, status: r.status, guestCount: r.guestCount,
                })),
                summary: { total: rows.length, ...byMeal },
            };
        }
        case 'assets': {
            const rows = await HostelAsset.find(scope)
                .populate('hostel', 'name').populate('room', 'roomNumber').populate('issuedTo', 'name')
                .sort('name').limit(5000).lean();
            const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
            return {
                columns: ['name', 'assetCode', 'category', 'hostel', 'room', 'quantity', 'condition', 'issuedTo', 'status', 'damageCharge'],
                rows: rows.map((r) => ({
                    name: r.name, assetCode: r.assetCode, category: r.category, hostel: nameOf(r.hostel),
                    room: r.room?.roomNumber || '', quantity: r.quantity, condition: r.condition,
                    issuedTo: nameOf(r.issuedTo), status: r.status, damageCharge: r.damageCharge,
                })),
                summary: { total: rows.length, ...byStatus },
            };
        }
        case 'maintenance': {
            const rows = await HostelMaintenance.find({ ...scope, ...(hasRange ? { createdAt: range } : {}) })
                .populate('hostel', 'name').populate('room', 'roomNumber').sort('-createdAt').limit(5000).lean();
            const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
            return {
                columns: ['requestNumber', 'hostel', 'room', 'category', 'maintenanceType', 'priority', 'description', 'technicianName', 'scheduledDate', 'completedAt', 'actualCost', 'status'],
                rows: rows.map((r) => ({
                    requestNumber: r.requestNumber, hostel: nameOf(r.hostel), room: r.room?.roomNumber || '',
                    category: r.category, maintenanceType: r.maintenanceType, priority: r.priority,
                    description: r.description, technicianName: r.technicianName,
                    scheduledDate: r.scheduledDate, completedAt: r.completedAt, actualCost: r.actualCost, status: r.status,
                })),
                summary: { total: rows.length, ...byStatus, totalCost: rows.reduce((s, r) => s + (r.actualCost || 0), 0) },
            };
        }
        case 'complaints': {
            const rows = await HostelComplaint.find({ ...scope, ...(hasRange ? { createdAt: range } : {}) })
                .populate('student', 'name').populate('hostel', 'name').populate('assignedTo', 'name')
                .sort('-createdAt').limit(5000).lean();
            const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
            const resolved = rows.filter((r) => r.resolutionDate);
            const avgHours = resolved.length
                ? Math.round(resolved.reduce((s, r) => s + (new Date(r.resolutionDate) - new Date(r.createdAt)) / 36e5, 0) / resolved.length)
                : 0;
            return {
                columns: ['ticketNumber', 'student', 'hostel', 'category', 'priority', 'description', 'assignedTo', 'status', 'createdAt', 'resolutionDate', 'escalationLevel', 'rating'],
                rows: rows.map((r) => ({
                    ticketNumber: r.ticketNumber, student: nameOf(r.student), hostel: nameOf(r.hostel),
                    category: r.category, priority: r.priority, description: r.description,
                    assignedTo: nameOf(r.assignedTo), status: r.status, createdAt: r.createdAt,
                    resolutionDate: r.resolutionDate, escalationLevel: r.escalationLevel, rating: r.rating,
                })),
                summary: { total: rows.length, ...byStatus, avgResolutionHours: avgHours },
            };
        }
        case 'incidents': {
            const rows = await HostelIncident.find({ ...scope, ...dated('date') })
                .populate('student', 'name').populate('hostel', 'name').sort('-date').limit(5000).lean();
            const byType = rows.reduce((m, r) => { m[r.incidentType] = (m[r.incidentType] || 0) + 1; return m; }, {});
            return {
                columns: ['incidentNumber', 'date', 'student', 'hostel', 'incidentType', 'severity', 'description', 'actionTaken', 'status'],
                rows: rows.map((r) => ({
                    incidentNumber: r.incidentNumber, date: r.date, student: nameOf(r.student), hostel: nameOf(r.hostel),
                    incidentType: r.incidentType, severity: r.severity, description: r.description,
                    actionTaken: r.actionTaken, status: r.status,
                })),
                summary: { total: rows.length, ...byType },
            };
        }
        case 'discipline': {
            const rows = await HostelDiscipline.find({ ...scope, ...dated('date') })
                .populate('student', 'name').populate('hostel', 'name').sort('-date').limit(5000).lean();
            const byAction = rows.reduce((m, r) => { m[r.actionType] = (m[r.actionType] || 0) + 1; return m; }, {});
            return {
                columns: ['actionNumber', 'date', 'student', 'hostel', 'violation', 'violationType', 'actionType', 'severity', 'fineAmount', 'isRepeatOffence', 'status'],
                rows: rows.map((r) => ({
                    actionNumber: r.actionNumber, date: r.date, student: nameOf(r.student), hostel: nameOf(r.hostel),
                    violation: r.violation, violationType: r.violationType, actionType: r.actionType,
                    severity: r.severity, fineAmount: r.fineAmount, isRepeatOffence: r.isRepeatOffence, status: r.status,
                })),
                summary: { total: rows.length, ...byAction,
                           repeatOffences: rows.filter((r) => r.isRepeatOffence).length,
                           totalFines: rows.reduce((s, r) => s + (r.fineAmount || 0), 0) },
            };
        }
        case 'movement': {
            const rows = await HostelMovement.find({ ...scope, ...dated('at') })
                .populate('student', 'name').populate('hostel', 'name').sort('-at').limit(10000).lean();
            return {
                columns: ['at', 'student', 'personName', 'hostel', 'direction', 'movementType', 'gate', 'isLate', 'lateMinutes'],
                rows: rows.map((r) => ({
                    at: r.at, student: nameOf(r.student), personName: r.personName, hostel: nameOf(r.hostel),
                    direction: r.direction, movementType: r.movementType, gate: r.gate,
                    isLate: r.isLate, lateMinutes: r.lateMinutes,
                })),
                summary: {
                    total: rows.length,
                    out: rows.filter((r) => r.direction === 'out').length,
                    in: rows.filter((r) => r.direction === 'in').length,
                    late: rows.filter((r) => r.isLate).length,
                },
            };
        }
        case 'expenses': {
            // Mess spending is the whole school's kitchen: only the module's admins see it here.
            const whole = !scope.hostel || (await visibleHostelIds(req)) === null;
            const [mess, maint] = await Promise.all([
                whole ? HostelMessExpense.find({ school, ...dated('date') }).populate('mess', 'name').sort('-date').lean() : [],
                HostelMaintenance.find({ ...scope, status: 'completed', ...(hasRange ? { completedAt: range } : {}) })
                    .populate('hostel', 'name').lean(),
            ]);
            const rows = [
                ...mess.map((m) => ({ date: m.date, head: 'Mess', category: m.category, description: m.description || nameOf(m.mess), amount: m.amount })),
                ...maint.map((m) => ({ date: m.completedAt, head: 'Maintenance', category: m.category, description: m.description, amount: m.actualCost || 0 })),
            ].sort((a, b) => new Date(b.date) - new Date(a.date));
            return {
                columns: ['date', 'head', 'category', 'description', 'amount'],
                rows,
                summary: {
                    total: rows.reduce((s, r) => s + (r.amount || 0), 0),
                    mess: mess.reduce((s, r) => s + (r.amount || 0), 0),
                    maintenance: maint.reduce((s, r) => s + (r.actualCost || 0), 0),
                },
            };
        }
        case 'warden_activity': {
            const rows = await HostelAuditLog.find({ ...scope, ...(hasRange ? { createdAt: range } : {}) })
                .populate('user', 'name').sort('-createdAt').limit(5000).lean();
            const byUser = rows.reduce((m, r) => {
                const k = r.userName || nameOf(r.user) || 'System';
                m[k] = (m[k] || 0) + 1; return m;
            }, {});
            return {
                columns: ['createdAt', 'user', 'role', 'actionType', 'entityType', 'description'],
                rows: rows.map((r) => ({
                    createdAt: r.createdAt, user: r.userName || nameOf(r.user), role: r.role,
                    actionType: r.actionType, entityType: r.entityType, description: r.description,
                })),
                summary: { total: rows.length, byUser },
            };
        }
        case 'monthly_summary':
        case 'annual_summary': {
            const start = type === 'annual_summary'
                ? new Date(new Date().getFullYear(), 0, 1)
                : monthStart();
            const end = hasRange && range.$lt ? range.$lt : new Date();
            const win = { $gte: hasRange && range.$gte ? range.$gte : start, $lt: end };
            const [admissions, allocations, vacated, attendance, leaves, outpasses,
                   visitors, complaints, incidents, discipline, invoices, messCost, maintCost] = await Promise.all([
                HostelAdmission.countDocuments({ ...scope, createdAt: win }),
                HostelAllocation.countDocuments({ ...scope, createdAt: win }),
                HostelAllocation.countDocuments({ ...scope, vacatedDate: win }),
                HostelAttendance.aggregate([{ $match: { school: toId(school), date: win } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
                HostelLeave.countDocuments({ ...scope, createdAt: win }),
                HostelOutpass.countDocuments({ ...scope, createdAt: win }),
                HostelVisitor.countDocuments({ ...scope, isTemplate: false, createdAt: win }),
                HostelComplaint.countDocuments({ ...scope, createdAt: win }),
                HostelIncident.countDocuments({ ...scope, date: win }),
                HostelDiscipline.countDocuments({ ...scope, date: win }),
                HostelFeeInvoice.aggregate([{ $match: { school: toId(school), createdAt: win } },
                    { $group: { _id: null, billed: { $sum: '$netAmount' }, paid: { $sum: '$paidAmount' } } }]),
                HostelMessExpense.aggregate([{ $match: { school: toId(school), date: win } }, { $group: { _id: null, t: { $sum: '$amount' } } }]),
                HostelMaintenance.aggregate([{ $match: { school: toId(school), completedAt: win } }, { $group: { _id: null, t: { $sum: '$actualCost' } } }]),
            ]);
            const att = Object.fromEntries(attendance.map((a) => [a._id, a.n]));
            const marked = Object.values(att).reduce((s, n) => s + n, 0);
            const billed = invoices[0]?.billed || 0;
            const collected = invoices[0]?.paid || 0;
            const expenses = (messCost[0]?.t || 0) + (maintCost[0]?.t || 0);
            const rows = [
                { metric: 'New admissions', value: admissions },
                { metric: 'New allocations', value: allocations },
                { metric: 'Checkouts', value: vacated },
                { metric: 'Attendance marked', value: marked },
                { metric: 'Attendance — present %', value: marked ? Math.round(((att.present || 0) / marked) * 100) : 0 },
                { metric: 'Leave requests', value: leaves },
                { metric: 'Outpasses', value: outpasses },
                { metric: 'Visitors', value: visitors },
                { metric: 'Complaints', value: complaints },
                { metric: 'Incidents', value: incidents },
                { metric: 'Disciplinary actions', value: discipline },
                { metric: 'Fees billed', value: billed },
                { metric: 'Fees collected', value: collected },
                { metric: 'Expenses (mess + maintenance)', value: expenses },
                { metric: 'Net position', value: collected - expenses },
            ];
            return { columns: ['metric', 'value'], rows, summary: { from: win.$gte, to: win.$lt, billed, collected, expenses } };
        }
        default:
            throw Object.assign(new Error(`Unknown report type '${type}'`), { status: 400 });
    }
}

exports.getReport = async (req, res) => {
    try {
        const r = await buildReport(req);
        ok(res, { type: req.query.type || 'occupancy', ...r });
    } catch (e) { handle(res, e); }
};

/** CSV export of any report — the same shape the screen shows, written out. */
exports.exportReport = async (req, res) => {
    try {
        const { columns, rows } = await buildReport(req);
        const esc = (v) => {
            if (v == null) return '';
            const s = v instanceof Date ? v.toISOString() : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
        const name = `hostel-${req.query.type || 'occupancy'}-${new Date().toISOString().slice(0, 10)}.csv`;
        await logAudit(req, { action: 'export', entityType: 'HostelReport',
            description: `Exported the ${req.query.type || 'occupancy'} report (${rows.length} row(s))` });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.send(csv);
    } catch (e) { handle(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  AUDIT HISTORY (spec §24, §29)
// ═════════════════════════════════════════════════════════════════════════════
exports.getAuditLog = async (req, res) => {
    try {
        const p = page(req.query);
        const q = { school: req.schoolId };
        const { entityType, entityId, actionType, user, from, to, hostel } = req.query;
        if (entityType) q.entityType = entityType;
        if (entityId) q.entityId = entityId;
        if (actionType) q.actionType = actionType;
        if (user) q.user = user;
        if (hostel) q.hostel = hostel;
        if (from || to) {
            q.createdAt = {};
            if (from) q.createdAt.$gte = dayRange(from).start;
            if (to) q.createdAt.$lt = dayRange(to).end;
        }
        const [rows, total] = await Promise.all([
            HostelAuditLog.find(q).sort('-createdAt').skip((p.page - 1) * p.limit).limit(p.limit)
                .populate('user', 'name email').populate('hostel', 'name').lean(),
            HostelAuditLog.countDocuments(q),
        ]);
        ok(res, paged(rows, total, p));
    } catch (e) { fail(res, e); }
};
