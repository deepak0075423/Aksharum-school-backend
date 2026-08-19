'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hostel — student & parent portal (spec §9, §12, §13, §16, §17, §24).
//
//  Mounted behind requireModule('hostel') + requireRole, so these handlers only
//  ever run for a student or a parent whose school has the module and whose
//  designation-level access permits it.
//
//  Every read is bound to the caller: a student sees their own allocation, a
//  parent only the children on their existing ParentProfile. Nothing here trusts
//  a student id from the request body.
// ─────────────────────────────────────────────────────────────────────────────
const Hostel               = require('../models/Hostel');
const HostelAllocation     = require('../models/HostelAllocation');
const HostelAdmission      = require('../models/HostelAdmission');
const HostelAttendance     = require('../models/HostelAttendance');
const HostelLeave          = require('../models/HostelLeave');
const HostelOutpass        = require('../models/HostelOutpass');
const HostelVisitor        = require('../models/HostelVisitor');
const HostelComplaint      = require('../models/HostelComplaint');
const HostelFeeInvoice     = require('../models/HostelFeeInvoice');
const HostelDiscipline     = require('../models/HostelDiscipline');
const HostelIncident       = require('../models/HostelIncident');
const HostelAsset          = require('../models/HostelAsset');
const HostelMessMember     = require('../models/HostelMessMember');
const HostelMenu           = require('../models/HostelMenu');
const HostelMovement       = require('../models/HostelMovement');
const HostelDocument       = require('../models/HostelDocument');
const User                 = require('../models/User');
const StudentProfile       = require('../models/StudentProfile');

const qrcode = require('../utils/qrcode');
const { matrixToDataUri, matrixToPng } = require('../utils/pngEncoder');
const svc   = require('../services/hostelService');
const alloc = require('../services/hostelAllocation');
const admin = require('./hostel.controller');

const { ok, bad, fail, dayRange, getSettings, nextNumber, logAudit,
        notifyHostelStaff, studentSnapshot, childIdsOfParent } = svc;

const handle = (res, e) => (e instanceof alloc.RuleError || e.status === 400) ? bad(res, e.message) : fail(res, e);
const num = (v, d = 0) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));

/**
 * The student whose hostel data this request may touch.
 *   student — always themselves, whatever the query says
 *   parent  — the requested child, but only if they are on the ParentProfile
 * Returns null when the caller has no legitimate subject.
 */
async function subjectStudent(req) {
    if (req.userRole === 'student') return String(req.userId);
    if (req.userRole === 'parent') {
        const children = await childIdsOfParent(req.userId);
        if (!children.length) return null;
        const asked = req.query.student || req.body?.student;
        if (asked) return children.includes(String(asked)) ? String(asked) : null;
        return children[0];
    }
    return null;
}

// ═════════════════════════════════════════════════════════════════════════════
//  MY HOSTEL — the student's own profile (spec §9)
// ═════════════════════════════════════════════════════════════════════════════
exports.myHostel = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return bad(res, 'No hostel record is linked to this account', 404);

        const [snapshot, current, admissions, settings] = await Promise.all([
            studentSnapshot(req.schoolId, studentId),
            HostelAllocation.findOne({ school: req.schoolId, student: studentId, status: { $in: ['pending', 'active'] } })
                .populate('hostel', 'name code contactNumber email address facilities rules entryTime exitTime curfewTime warden assistantWarden')
                .populate('building', 'name').populate('floor', 'name floorNumber')
                .populate('room', 'roomNumber roomType facilities').populate('bed', 'bedNumber code').lean(),
            HostelAdmission.find({ school: req.schoolId, student: studentId }).sort('-createdAt')
                .populate('hostel', 'name').populate('academicYear', 'yearName').lean(),
            getSettings(req.schoolId),
        ]);

        if (!current) {
            return ok(res, {
                student: snapshot, resident: false, current: null, admissions,
                rules: { entryTime: settings.entryTime, exitTime: settings.exitTime, curfewTime: settings.curfewTime },
                canApply: settings.allowStudentSelfApplication || req.userRole === 'parent',
            });
        }

        const [warden, roommates, mess, assets, attendance] = await Promise.all([
            current.hostel?.warden ? User.findById(current.hostel.warden).select('name email phone profileImage').lean() : null,
            HostelAllocation.find({ school: req.schoolId, room: current.room?._id || current.room, status: 'active', student: { $ne: studentId } })
                .populate('student', 'name profileImage').populate('bed', 'bedNumber').lean(),
            HostelMessMember.findOne({ school: req.schoolId, student: studentId, status: 'active' })
                .populate('mess', 'name code mealTimings').lean(),
            HostelAsset.find({ school: req.schoolId, issuedTo: studentId, status: 'issued' }).lean(),
            HostelAttendance.find({ school: req.schoolId, student: studentId }).sort('-date').limit(30).lean(),
        ]);

        const attendanceSummary = attendance.reduce((m, a) => { m[a.status] = (m[a.status] || 0) + 1; return m; }, {});
        ok(res, {
            student: snapshot, resident: true, current, warden, roommates, mess, assets,
            attendance, attendanceSummary,
            admissions,
            rules: {
                entryTime: current.hostel?.entryTime || settings.entryTime,
                exitTime: current.hostel?.exitTime || settings.exitTime,
                curfewTime: current.hostel?.curfewTime || settings.curfewTime,
                visitorFrom: settings.visitorFrom, visitorTo: settings.visitorTo,
                visitorDays: settings.visitorDays,
                outpassFrom: settings.outpassFrom, outpassTo: settings.outpassTo,
                maxOutpassHours: settings.maxOutpassHours,
                hostelRules: current.hostel?.rules || [],
                facilities: current.hostel?.facilities || [],
            },
        });
    } catch (e) { fail(res, e); }
};

/** The children a parent may switch between — from the existing ParentProfile. */
exports.myChildren = async (req, res) => {
    try {
        const ids = await childIdsOfParent(req.userId);
        if (!ids.length) return ok(res, []);
        const [users, allocations, profiles] = await Promise.all([
            User.find({ _id: { $in: ids }, school: req.schoolId }).select('name email profileImage').lean(),
            HostelAllocation.find({ school: req.schoolId, student: { $in: ids }, status: 'active' })
                .populate('hostel', 'name').populate('room', 'roomNumber').lean(),
            StudentProfile.find({ user: { $in: ids }, school: req.schoolId })
                .select('user admissionNumber currentClass').populate('currentClass', 'className').lean(),
        ]);
        const byStudent = Object.fromEntries(allocations.map((a) => [String(a.student), a]));
        const profByUser = Object.fromEntries(profiles.map((p) => [String(p.user), p]));
        ok(res, users.map((u) => ({
            ...u,
            className: profByUser[String(u._id)]?.currentClass?.className || '',
            admissionNumber: profByUser[String(u._id)]?.admissionNumber || '',
            allocation: byStudent[String(u._id)] || null,
        })));
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ADMISSION APPLICATION (spec §8)
// ═════════════════════════════════════════════════════════════════════════════
exports.applyForHostel = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return bad(res, 'No student is linked to this account', 404);

        const settings = await getSettings(req.schoolId);
        if (req.userRole === 'student' && !settings.allowStudentSelfApplication) {
            return bad(res, 'Students cannot apply for hostel accommodation directly at this school');
        }
        if (req.userRole === 'parent' && !settings.allowParentApplication) {
            return bad(res, 'Parents cannot apply for hostel accommodation directly at this school');
        }

        const b = req.body;
        if (!b.hostel || !b.academicYear) return bad(res, 'Hostel and academic year are required');

        const [hostel, profile, open] = await Promise.all([
            Hostel.findOne({ _id: b.hostel, school: req.schoolId }).lean(),
            StudentProfile.findOne({ user: studentId, school: req.schoolId }).lean(),
            HostelAdmission.findOne({
                school: req.schoolId, student: studentId, academicYear: b.academicYear,
                status: { $in: ['draft', 'applied', 'pending_approval', 'approved'] },
            }).lean(),
        ]);
        if (!hostel) return bad(res, 'Hostel not found');
        if (!hostel.isActive || hostel.status !== 'active') return bad(res, 'This hostel is not accepting applications');
        if (open) return bad(res, 'You already have an open hostel application for that year');

        // Gender restriction is checked at application time too, so nobody
        // applies to a hostel they could never be allocated to.
        if (settings.enforceGenderRestriction) {
            const want = String(hostel.gender || '');
            const have = svc.genderOf(profile);
            if (want && !['any', 'co_ed'].includes(want) && have && have !== want) {
                return bad(res, `${hostel.name} is a ${want} hostel`);
            }
        }

        const row = await HostelAdmission.create({
            hostel: b.hostel,
            academicYear: b.academicYear,
            preferredRoomType: b.preferredRoomType || '',
            joiningDate: b.joiningDate || null,
            expectedLeavingDate: b.expectedLeavingDate || null,
            reason: b.reason || '',
            medicalInfo: b.medicalInfo || '',
            specialRequirements: b.specialRequirements || '',
            remarks: b.remarks || '',
            school: req.schoolId,
            student: studentId,
            applicationNumber: await nextNumber(HostelAdmission, req.schoolId, 'HA'),
            status: settings.admissionRequiresApproval ? 'pending_approval' : 'approved',
            guardianName:  b.guardianName  || profile?.guardianName  || profile?.fatherName  || '',
            guardianPhone: b.guardianPhone || profile?.guardianPhone || profile?.fatherPhone || '',
            guardianRelation: b.guardianRelation || profile?.guardianRelation || '',
            emergencyContactName:     b.emergencyContactName     || profile?.emergencyContactName     || '',
            emergencyContactPhone:    b.emergencyContactPhone    || profile?.emergencyContactPhone    || '',
            emergencyContactRelation: b.emergencyContactRelation || profile?.emergencyContactRelation || '',
            appliedBy: req.userId, appliedAt: new Date(), createdBy: req.userId,
        });

        const student = await User.findById(studentId).select('name').lean();
        await logAudit(req, { action: 'create', entityType: 'HostelAdmission', entityId: row._id, hostel: hostel._id,
            description: `Hostel application ${row.applicationNumber} filed by ${req.userRole} for ${student?.name}` });
        await notifyHostelStaff(req, { hostelId: hostel._id,
            title: 'New hostel application',
            body: `${student?.name} applied for accommodation at ${hostel.name} (${row.applicationNumber}).` });
        ok(res, row);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'You already have an open hostel application for that year');
        fail(res, e);
    }
};

// Hostels a student may apply to — gender-filtered so the list is truthful.
exports.availableHostels = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        const [settings, profile] = await Promise.all([
            getSettings(req.schoolId),
            studentId ? StudentProfile.findOne({ user: studentId, school: req.schoolId }).select('gender').lean() : null,
        ]);
        let rows = await Hostel.find({ school: req.schoolId, isActive: true, status: 'active' })
            .select('name code hostelType gender capacity facilities rules address contactNumber entryTime exitTime curfewTime').lean();

        if (settings.enforceGenderRestriction) {
            const g = svc.genderOf(profile);
            if (g) rows = rows.filter((h) => ['any', 'co_ed', g].includes(String(h.gender || 'any')));
        }
        // Free beds, so a student does not apply to a full hostel unaware.
        const HostelBed = require('../models/HostelBed');
        const free = await HostelBed.aggregate([
            { $match: { school: String(req.schoolId), status: 'available', isActive: true } },
            { $group: { _id: '$hostel', n: { $sum: 1 } } },
        ]);
        const freeMap = Object.fromEntries(free.map((f) => [String(f._id), f.n]));

        // The years an application can be filed against — otherwise the caller
        // would have to know an academic year id to apply.
        const AcademicYear = require('../models/AcademicYear');
        const academicYears = await AcademicYear.find({ school: req.schoolId, status: { $ne: 'archived' } })
            .select('yearName status startDate').sort('-startDate').lean();

        ok(res, {
            hostels: rows.map((h) => ({ ...h, availableBeds: freeMap[String(h._id)] || 0 })),
            academicYears,
        });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  LEAVE & OUTPASS (spec §12)
// ═════════════════════════════════════════════════════════════════════════════
exports.myLeaves = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return ok(res, []);
        const rows = await HostelLeave.find({ school: req.schoolId, student: studentId })
            .sort('-fromDate').limit(100)
            .populate('hostel', 'name').populate('wardenApprovedBy', 'name').lean();
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

exports.applyLeave = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return bad(res, 'No student is linked to this account', 404);
        const b = req.body;
        if (!b.fromDate || !b.toDate || !b.reason) return bad(res, 'Dates and a reason are required');

        const settings = await getSettings(req.schoolId);
        const { allocation, days } = await admin._validateLeave({
            schoolId: req.schoolId, studentId, fromDate: b.fromDate, toDate: b.toDate, settings,
        });

        const row = await HostelLeave.create({
            leaveType: b.leaveType || 'home',
            fromDate: b.fromDate, toDate: b.toDate, reason: b.reason,
            destination: b.destination || '',
            guardianName: b.guardianName || '', guardianPhone: b.guardianPhone || '',
            emergencyContact: b.emergencyContact || '',
            school: req.schoolId, hostel: allocation.hostel, allocation: allocation._id,
            academicYear: allocation.academicYear,
            leaveNumber: await nextNumber(HostelLeave, req.schoolId, 'HLV'),
            totalDays: days,
            parentApprovalRequired: settings.leaveRequiresParentApproval,
            // A parent filing the request is itself the parent consent.
            status: (req.userRole === 'parent' && settings.leaveRequiresParentApproval) ? 'parent_approved' : 'pending',
            parentApprovedBy: req.userRole === 'parent' ? req.userId : null,
            parentApprovedAt: req.userRole === 'parent' ? new Date() : null,
            appliedBy: req.userId, createdBy: req.userId,
        });

        const student = await User.findById(studentId).select('name').lean();
        await logAudit(req, { action: 'create', entityType: 'HostelLeave', entityId: row._id, hostel: allocation.hostel,
            description: `Leave ${row.leaveNumber} requested by ${req.userRole} for ${student?.name}` });
        await notifyHostelStaff(req, { hostelId: allocation.hostel,
            title: 'Hostel leave request',
            body: `${student?.name} requested ${days} day(s) leave from ${new Date(b.fromDate).toDateString()}. Reason: ${b.reason}` });
        ok(res, row);
    } catch (e) { handle(res, e); }
};

/**
 * The student cancels their own pending request; a parent can additionally give
 * or withhold consent, which is the parent-approval stage of the workflow.
 */
exports.actOnMyLeave = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        const { action, remark = '' } = req.body;
        const l = await HostelLeave.findOne({ _id: req.params.id, school: req.schoolId, student: studentId }).lean();
        if (!l) return bad(res, 'Leave not found', 404);

        const set = {};
        if (action === 'cancel') {
            if (!['pending', 'parent_approved', 'approved'].includes(l.status)) {
                return bad(res, `A ${l.status} leave cannot be cancelled here`);
            }
            set.status = 'cancelled'; set.cancelledAt = new Date();
        } else if (action === 'parent_approve' && req.userRole === 'parent') {
            if (l.status !== 'pending') return bad(res, 'Only a pending request can receive consent');
            set.status = 'parent_approved'; set.parentApprovedBy = req.userId; set.parentApprovedAt = new Date();
        } else if (action === 'parent_reject' && req.userRole === 'parent') {
            if (l.status !== 'pending') return bad(res, 'Only a pending request can be declined');
            set.status = 'rejected'; set.rejectedBy = req.userId; set.rejectedAt = new Date(); set.rejectionReason = remark;
        } else {
            return bad(res, 'Unsupported action');
        }

        const updated = await HostelLeave.findByIdAndUpdate(l._id, { $set: set }, { new: true });
        await logAudit(req, { action, entityType: 'HostelLeave', entityId: l._id, hostel: l.hostel,
            description: `Leave ${l.leaveNumber} — ${action} by ${req.userRole}`,
            before: { status: l.status }, after: { status: set.status } });
        await notifyHostelStaff(req, { hostelId: l.hostel,
            title: 'Hostel leave update',
            body: `Leave ${l.leaveNumber} is now ${set.status}.${remark ? ` ${remark}` : ''}` });
        ok(res, updated);
    } catch (e) { fail(res, e); }
};

exports.myOutpasses = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return ok(res, []);
        const rows = await HostelOutpass.find({ school: req.schoolId, student: studentId })
            .sort('-departureDate').limit(100).populate('approvedBy', 'name').lean();
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

exports.applyOutpass = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return bad(res, 'No student is linked to this account', 404);
        const b = req.body;
        if (!b.purpose || !b.departureDate) return bad(res, 'Purpose and departure date are required');

        const settings = await getSettings(req.schoolId);
        if (settings.outpassRequiresParentApproval && req.userRole === 'student' && !b.guardianPhone) {
            return bad(res, 'A guardian contact is required for an outpass at this school');
        }
        const { allocation, expectedReturnAt } = await admin._validateOutpass({
            schoolId: req.schoolId, studentId,
            departureDate: b.departureDate,
            expectedDepartureTime: b.expectedDepartureTime,
            expectedReturnTime: b.expectedReturnTime, settings,
        });

        const row = await HostelOutpass.create({
            outpassType: b.outpassType || 'day',
            purpose: b.purpose, destination: b.destination || '',
            departureDate: b.departureDate,
            expectedDepartureTime: b.expectedDepartureTime || '',
            expectedReturnTime: b.expectedReturnTime || '',
            expectedReturnAt,
            guardianName: b.guardianName || '', guardianPhone: b.guardianPhone || '',
            emergencyContact: b.emergencyContact || '',
            school: req.schoolId, hostel: allocation.hostel, allocation: allocation._id,
            outpassNumber: await nextNumber(HostelOutpass, req.schoolId, 'OP', true),
            requestedBy: req.userId, createdBy: req.userId,
        });

        const student = await User.findById(studentId).select('name').lean();
        await logAudit(req, { action: 'create', entityType: 'HostelOutpass', entityId: row._id, hostel: allocation.hostel,
            description: `Outpass ${row.outpassNumber} requested by ${req.userRole} for ${student?.name}` });
        await notifyHostelStaff(req, { hostelId: allocation.hostel,
            title: 'Outpass request',
            body: `${student?.name} requested an outpass for ${new Date(b.departureDate).toDateString()}. Purpose: ${b.purpose}` });
        ok(res, row);
    } catch (e) { handle(res, e); }
};

exports.cancelMyOutpass = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        const o = await HostelOutpass.findOne({ _id: req.params.id, school: req.schoolId, student: studentId }).lean();
        if (!o) return bad(res, 'Outpass not found', 404);
        if (!['pending', 'approved'].includes(o.status)) return bad(res, `A ${o.status} outpass cannot be cancelled here`);

        const updated = await HostelOutpass.findByIdAndUpdate(o._id, { $set: { status: 'cancelled', qrToken: '' } }, { new: true });
        await logAudit(req, { action: 'cancel', entityType: 'HostelOutpass', entityId: o._id, hostel: o.hostel,
            description: `Outpass ${o.outpassNumber} cancelled by ${req.userRole}` });
        ok(res, updated);
    } catch (e) { fail(res, e); }
};

// The pass itself — the QR payload the gate scans (spec §12).
exports.myOutpassPass = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        const o = await HostelOutpass.findOne({ _id: req.params.id, school: req.schoolId, student: studentId })
            .populate('hostel', 'name').populate('student', 'name profileImage').lean();
        if (!o) return bad(res, 'Outpass not found', 404);
        if (!['approved', 'active', 'overdue'].includes(o.status)) return bad(res, 'This outpass has no active pass');
        const a = await HostelAllocation.findById(o.allocation).populate('room', 'roomNumber').lean();
        ok(res, {
            outpassNumber: o.outpassNumber, student: o.student, hostel: o.hostel,
            room: a?.room?.roomNumber || '', purpose: o.purpose, destination: o.destination,
            departureDate: o.departureDate, expectedReturnAt: o.expectedReturnAt,
            status: o.status, qrToken: o.qrToken,
            // Rendered here so the web app and the Expo app both just show an
            // image — see utils/qrcode.js for why this is not a client library.
            qrImage: o.qrToken ? matrixToDataUri(qrcode.encode(o.qrToken), { scale: 6, quietZone: 4 }) : null,
        });
    } catch (e) { fail(res, e); }
};

/** The pass as a bare PNG, for saving to the camera roll or printing. */
exports.myOutpassQr = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        const o = await HostelOutpass.findOne({ _id: req.params.id, school: req.schoolId, student: studentId }).lean();
        if (!o) return bad(res, 'Outpass not found', 404);
        if (!o.qrToken) return bad(res, 'This outpass has no active pass');
        const png = matrixToPng(qrcode.encode(o.qrToken), { scale: 8, quietZone: 4 });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `inline; filename="${o.outpassNumber || 'outpass'}.png"`);
        res.send(png);
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  VISITORS, ATTENDANCE, FEES, COMPLAINTS, MESS (read + the student's own writes)
// ═════════════════════════════════════════════════════════════════════════════
exports.myVisitors = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return ok(res, { visits: [], authorized: [], restricted: [] });
        const rows = await HostelVisitor.find({ school: req.schoolId, student: studentId }).sort('-createdAt').limit(100).lean();
        ok(res, {
            visits: rows.filter((r) => !r.isTemplate),
            authorized: rows.filter((r) => r.isTemplate && r.listType === 'authorized'),
            restricted: rows.filter((r) => r.isTemplate && r.listType === 'restricted'),
        });
    } catch (e) { fail(res, e); }
};

/** Pre-register an expected visitor — it still needs warden approval. */
exports.requestVisitor = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return bad(res, 'No student is linked to this account', 404);
        const b = req.body;
        if (!b.visitorName) return bad(res, "The visitor's name is required");

        const allocation = await HostelAllocation.findOne({ school: req.schoolId, student: studentId, status: 'active' }).lean();
        if (!allocation) return bad(res, 'You are not currently a hostel resident');

        const settings = await getSettings(req.schoolId);
        const blocked = await HostelVisitor.findOne({
            school: req.schoolId, student: studentId, isTemplate: true, listType: 'restricted',
            visitorName: new RegExp(String(b.visitorName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        }).lean();
        if (blocked) return bad(res, `${b.visitorName} is on the restricted visitor list`);

        if (b.scheduledAt && settings.visitorFrom && settings.visitorTo) {
            const t = new Date(b.scheduledAt);
            const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
            if (hhmm < settings.visitorFrom || hhmm > settings.visitorTo) {
                return bad(res, `Visitors are received between ${settings.visitorFrom} and ${settings.visitorTo}`);
            }
        }

        const row = await HostelVisitor.create({
            visitorName: b.visitorName, mobile: b.mobile || '', relationship: b.relationship || '',
            purpose: b.purpose || '', visitorCount: num(b.visitorCount, 1),
            idProofType: b.idProofType || '', idProofNumber: b.idProofNumber || '',
            scheduledAt: b.scheduledAt || null,
            school: req.schoolId, hostel: allocation.hostel, student: studentId,
            passNumber: await nextNumber(HostelVisitor, req.schoolId, 'VP', true),
            status: 'pending', createdBy: req.userId,
        });
        await logAudit(req, { action: 'create', entityType: 'HostelVisitor', entityId: row._id, hostel: allocation.hostel,
            description: `Visitor ${row.visitorName} pre-registered by ${req.userRole}` });
        await notifyHostelStaff(req, { hostelId: allocation.hostel,
            title: 'Visitor pre-registration',
            body: `${row.visitorName}${row.relationship ? ` (${row.relationship})` : ''} is expected. Approval needed.` });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

exports.myAttendance = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return ok(res, { rows: [], summary: {} });
        const q = { school: req.schoolId, student: studentId };
        if (req.query.from || req.query.to) {
            q.date = {};
            if (req.query.from) q.date.$gte = dayRange(req.query.from).start;
            if (req.query.to) q.date.$lt = dayRange(req.query.to).end;
        }
        const rows = await HostelAttendance.find(q).sort('-date').limit(200).lean();
        const summary = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
        summary.total = rows.length;
        summary.presentPercent = rows.length ? Math.round(((summary.present || 0) / rows.length) * 100) : 0;
        ok(res, { rows, summary });
    } catch (e) { fail(res, e); }
};

exports.myFees = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return ok(res, { invoices: [], summary: {} });
        const invoices = await HostelFeeInvoice.find({ school: req.schoolId, student: studentId })
            .sort('-createdAt').populate('hostel', 'name').lean();
        const billed = invoices.reduce((s, i) => s + (i.netAmount || 0), 0);
        const paid = invoices.reduce((s, i) => s + (i.paidAmount || 0), 0);
        ok(res, {
            invoices,
            summary: {
                billed, paid, outstanding: Math.max(0, billed - paid),
                overdue: invoices.filter((i) => i.status === 'overdue').length,
            },
        });
    } catch (e) { fail(res, e); }
};

exports.myComplaints = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return ok(res, []);
        const rows = await HostelComplaint.find({ school: req.schoolId, student: studentId })
            .sort('-createdAt').limit(100).populate('assignedTo', 'name').lean();
        // Internal staff notes are not the resident's business.
        rows.forEach((r) => {
            r.comments = (r.comments || []).filter((c) => !c.internal);
            r.attachmentUrls = (r.attachments || []).map((f) => `/uploads/hostel-docs/${f}`);
        });
        ok(res, rows);
    } catch (e) { fail(res, e); }
};

exports.raiseComplaint = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return bad(res, 'No student is linked to this account', 404);
        const b = req.body;
        if (!b.description) return bad(res, 'A description is required');

        const allocation = await HostelAllocation.findOne({ school: req.schoolId, student: studentId, status: 'active' }).lean();
        if (!allocation) return bad(res, 'You are not currently a hostel resident');

        const settings = await getSettings(req.schoolId);
        const row = await HostelComplaint.create({
            category: b.category || 'other', priority: b.priority || 'medium',
            subject: b.subject || '', description: b.description, attachments: b.attachments || [],
            school: req.schoolId, hostel: allocation.hostel, room: allocation.room, student: studentId,
            ticketNumber: await nextNumber(HostelComplaint, req.schoolId, 'HC'),
            dueAt: new Date(Date.now() + (settings.complaintSlaHours || 48) * 36e5),
            raisedBy: req.userId, raisedByRole: req.userRole,
        });
        await logAudit(req, { action: 'create', entityType: 'HostelComplaint', entityId: row._id, hostel: allocation.hostel,
            description: `Complaint ${row.ticketNumber} raised by ${req.userRole} (${row.category})` });
        await notifyHostelStaff(req, { hostelId: allocation.hostel,
            title: `New hostel complaint — ${row.category}`,
            body: `${row.ticketNumber} (${row.priority}): ${String(row.description).slice(0, 180)}` });
        ok(res, row);
    } catch (e) { fail(res, e); }
};

/**
 * Attach a file to something the caller owns.
 *
 * Same shape as the administrative endpoint: the upload returns a stored
 * filename which the complaint form then submits in `attachments`. A resident
 * photographing a broken tap is the whole reason this exists.
 */
exports.uploadAttachment = async (req, res) => {
    try {
        if (!req.file) return bad(res, 'A file is required');
        const studentId = await subjectStudent(req);
        if (!studentId) return bad(res, 'No student is linked to this account', 404);

        const { entityType = '', entityId = null } = req.body;
        // Only ever attach to a record that belongs to this student.
        if (entityType && entityId) {
            const Model = { HostelComplaint, HostelLeave, HostelOutpass }[entityType];
            if (!Model) return bad(res, 'Attachments are not supported on that record');
            const owned = await Model.findOne({ _id: entityId, school: req.schoolId, student: studentId }).lean();
            if (!owned) return bad(res, 'Record not found', 404);
        }

        const allocation = await HostelAllocation.findOne({ school: req.schoolId, student: studentId, status: 'active' }).lean();
        await HostelDocument.create({
            school: req.schoolId,
            hostel: allocation?.hostel || null,
            student: studentId,
            entityType, entityId: entityId || null,
            docType: entityType === 'HostelComplaint' ? 'complaint' : 'other',
            title: req.file.originalname,
            originalName: req.file.originalname,
            storedName: req.file.filename,
            mimeType: req.file.mimetype,
            fileSize: req.file.size,
            uploadedBy: req.userId,
            uploaderRole: req.userRole,
        });
        await logAudit(req, { action: 'upload', entityType: 'HostelAttachment', hostel: allocation?.hostel || null,
            description: `${req.userRole} attached ${req.file.originalname}` });

        ok(res, {
            storedName: req.file.filename,
            originalName: req.file.originalname,
            url: `/uploads/hostel-docs/${req.file.filename}`,
        });
    } catch (e) { fail(res, e); }
};

/** Add a comment, reopen or rate a complaint the caller raised. */
exports.actOnMyComplaint = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        const { action, comment = '', rating = null } = req.body;
        const c = await HostelComplaint.findOne({ _id: req.params.id, school: req.schoolId, student: studentId }).lean();
        if (!c) return bad(res, 'Complaint not found', 404);

        const set = {}; const push = [];
        if (action === 'comment') {
            if (!comment) return bad(res, 'A comment is required');
            push.push({ by: req.userId, byName: req.user?.name || '', byRole: req.userRole, text: comment, at: new Date(), internal: false });
        } else if (action === 'reopen') {
            if (!['resolved', 'closed'].includes(c.status)) return bad(res, 'Only a resolved complaint can be reopened');
            set.status = 'reopened'; set.reopenCount = (c.reopenCount || 0) + 1;
            if (comment) push.push({ by: req.userId, byName: req.user?.name || '', byRole: req.userRole, text: comment, at: new Date(), internal: false });
        } else if (action === 'rate') {
            if (!['resolved', 'closed'].includes(c.status)) return bad(res, 'Only a resolved complaint can be rated');
            const r = num(rating);
            if (r < 1 || r > 5) return bad(res, 'The rating must be between 1 and 5');
            set.rating = r;
        } else return bad(res, 'Unsupported action');

        const update = { $set: set };
        if (push.length) update.$push = { comments: { $each: push } };
        const updated = await HostelComplaint.findByIdAndUpdate(c._id, update, { new: true });
        await logAudit(req, { action, entityType: 'HostelComplaint', entityId: c._id, hostel: c.hostel,
            description: `Complaint ${c.ticketNumber} — ${action} by ${req.userRole}` });
        if (action === 'reopen') {
            await notifyHostelStaff(req, { hostelId: c.hostel,
                title: 'Hostel complaint reopened', body: `${c.ticketNumber} has been reopened.` });
        }
        ok(res, updated);
    } catch (e) { fail(res, e); }
};

exports.myMess = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return ok(res, { member: null, menu: [] });
        const member = await HostelMessMember.findOne({ school: req.schoolId, student: studentId, status: 'active' })
            .populate('mess', 'name code mealTimings holidays').lean();
        if (!member) return ok(res, { member: null, menu: [] });

        const from = req.query.from ? dayRange(req.query.from).start : dayRange().start;
        const to = req.query.to ? dayRange(req.query.to).end : new Date(from.getTime() + 7 * 864e5);
        const menu = await HostelMenu.find({
            school: req.schoolId, mess: member.mess?._id || member.mess,
            isTemplate: false, status: 'published', date: { $gte: from, $lt: to },
        }).sort('date').lean();
        ok(res, { member, menu });
    } catch (e) { fail(res, e); }
};

/** The student's own discipline, incident and movement record (spec §9). */
exports.myRecord = async (req, res) => {
    try {
        const studentId = await subjectStudent(req);
        if (!studentId) return ok(res, { discipline: [], incidents: [], movements: [], documents: [] });
        const [discipline, incidents, movements, documents] = await Promise.all([
            HostelDiscipline.find({ school: req.schoolId, student: studentId }).sort('-date').limit(50).lean(),
            HostelIncident.find({ school: req.schoolId, student: studentId }).sort('-date').limit(50).lean(),
            HostelMovement.find({ school: req.schoolId, student: studentId }).sort('-at').limit(50).lean(),
            HostelDocument.find({ school: req.schoolId, student: studentId, isActive: true }).sort('-createdAt').lean(),
        ]);
        documents.forEach((d) => { d.url = `/uploads/hostel-docs/${d.storedName}`; });
        ok(res, { discipline, incidents, movements, documents });
    } catch (e) { fail(res, e); }
};
