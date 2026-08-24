'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hostel module — shared services.
//
//  Everything the hostel controllers need that is not a request handler:
//  settings, document numbering, the audit writer, the notification wrappers,
//  fee-ledger posting and the hostel-scope resolver.
//
//  Integration points (all existing infrastructure, none of it re-implemented):
//    • services/notifyService  — in-app + email fan-out, parents included
//    • models/FeeLedger        — the Fees module's immutable double-entry ledger
//    • models/StudentProfile   — the student's medical / guardian master data
//    • models/User             — the only person master; no hostel staff table
// ─────────────────────────────────────────────────────────────────────────────
const Hostel                = require('../models/Hostel');
const HostelSettings        = require('../models/HostelSettings');
const HostelAuditLog        = require('../models/HostelAuditLog');
const HostelStaffAssignment = require('../models/HostelStaffAssignment');
const HostelAllocation      = require('../models/HostelAllocation');
const FeeLedger             = require('../models/FeeLedger');
const StudentProfile        = require('../models/StudentProfile');
const ParentProfile         = require('../models/ParentProfile');
const User                  = require('../models/User');
const { notify, withParents, schoolAdminIds } = require('./notifyService');

// ── response helpers, shared by both hostel controllers ──────────────────────
const ok   = (res, data)            => res.json({ success: true, data });
const bad  = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const fail = (res, e)               => res.status(500).json({ success: false, message: e.message });
const toId = (id) => String(id);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── dates ────────────────────────────────────────────────────────────────────
// Local-midnight day bounds — avoids the UTC shift toISOString() introduces.
function dayRange(dateLike) {
    const d = dateLike ? new Date(dateLike) : new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end   = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    return { start, end };
}
const dayStart  = (dateLike) => dayRange(dateLike).start;
const monthStart = (offset = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() - offset, 1);
};
// "16:00" on a given day -> Date. Returns null for a malformed time.
function atTime(dateLike, hhmm) {
    if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(dateLike || Date.now());
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
}
const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

// ── settings ─────────────────────────────────────────────────────────────────
// Every configurable rule is read through here, never hard-coded in a handler.
async function getSettings(schoolId) {
    let s = await HostelSettings.findOne({ school: schoolId });
    if (!s) s = await HostelSettings.create({ school: schoolId });
    return s;
}

// ── document numbering ───────────────────────────────────────────────────────
// PREFIX-YYMM-#### (or -YYMMDD when the series is daily), matching the scheme
// the transport and inventory modules already use.
async function nextNumber(Model, schoolId, prefix, withDay = false) {
    const d  = new Date();
    const ym = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`
             + (withDay ? String(d.getDate()).padStart(2, '0') : '');
    const count = await Model.countDocuments({ school: schoolId });
    return `${prefix}-${ym}-${String(count + 1).padStart(4, '0')}`;
}

// ── audit ────────────────────────────────────────────────────────────────────
/**
 * Record one auditable operation. Never throws — an audit failure must not fail
 * the operation the user asked for, and the log is append-only by construction.
 */
async function logAudit(req, { action, entityType, entityId, description, hostel = null, before = null, after = null, meta = {} }) {
    try {
        await HostelAuditLog.create({
            school: req.schoolId,
            hostel,
            user: req.userId,
            userName: req.user?.name || '',
            role: req.userRole,
            actionType: action,
            entityType,
            entityId: entityId || null,
            description: description || '',
            before, after, meta,
            ip: req.ip || '',
            userAgent: String(req.headers?.['user-agent'] || '').slice(0, 300),
        });
    } catch { /* non-critical */ }
}

/** Only the fields that actually changed, for a readable audit diff. */
function diffFields(before, after, fields) {
    const b = {}; const a = {};
    for (const f of fields) {
        const ov = before?.[f]; const nv = after?.[f];
        if (JSON.stringify(ov ?? null) === JSON.stringify(nv ?? null)) continue;
        b[f] = ov ?? null; a[f] = nv ?? null;
    }
    return Object.keys(a).length ? { before: b, after: a } : { before: null, after: null };
}

// ── notifications (reuses notifyService — no new channel is built) ────────────
/**
 * Notify a student and, when the setting allows it, their parents.
 * `settingKey` names the HostelSettings toggle that governs the parent copy.
 */
async function notifyStudentAndParents(req, { studentId, title, body, settings, settingKey, email = null, link = null }) {
    try {
        const recipients = (settings && settingKey && settings[settingKey] === false)
            ? [String(studentId)]
            : await withParents([String(studentId)]);
        notify({
            school: req.schoolId,
            sender: req.userId,
            senderRole: req.userRole,
            title, body,
            recipients,
            email: email == null ? !!settings?.emailNotifications : email,
            includeSender: true,
            // Every hostel event opens on the hostel screen unless a caller
            // knows somewhere more specific.
            link: link || { type: 'hostel' },
        });
    } catch { /* fire-and-forget */ }
}

/** Notify the staff who run a hostel: its warden, assistant and school admins. */
async function notifyHostelStaff(req, { hostelId, title, body, email = false, link = null }) {
    try {
        const [h, assigns, admins] = await Promise.all([
            hostelId ? Hostel.findById(hostelId).select('warden assistantWarden').lean() : null,
            hostelId
                ? HostelStaffAssignment.find({ school: req.schoolId, hostel: hostelId, status: 'active' }).select('staff').lean()
                : [],
            schoolAdminIds(req.schoolId),
        ]);
        const ids = [
            ...(h?.warden ? [String(h.warden)] : []),
            ...(h?.assistantWarden ? [String(h.assistantWarden)] : []),
            ...assigns.map((a) => String(a.staff)),
            ...admins.map(String),
        ];
        if (!ids.length) return;
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title, body, recipients: [...new Set(ids)], email,
            link: link || { type: 'hostel' },
        });
    } catch { /* fire-and-forget */ }
}

// ── Fees module integration ──────────────────────────────────────────────────
/**
 * Post a hostel charge / payment / refund to the shared FeeLedger, so the
 * student's overall fee position stays in one place. The Fees module owns the
 * ledger; this only appends to it, and only when the school has left
 * `postToFeeLedger` on.
 *
 * Never throws: a ledger hiccup must not roll back a receipt the cashier already
 * handed over — the hostel invoice remains the authoritative record of the money.
 */
async function postToLedger({ schoolId, studentId, academicYearId, entryType, category, amount, description, invoiceId, feeHeadName = 'Hostel', createdBy = null, settings = null }) {
    try {
        const s = settings || await getSettings(schoolId);
        if (!s.postToFeeLedger) return null;
        if (!academicYearId || !amount) return null;

        const last = await FeeLedger.find({ school: schoolId, student: studentId, academicYear: academicYearId })
            .sort('-createdAt').limit(1).lean();
        const prev = last[0]?.runningBalance || 0;
        const delta = entryType === 'debit' ? Number(amount) : -Number(amount);

        return await FeeLedger.create({
            school: schoolId,
            student: studentId,
            academicYear: academicYearId,
            entryType, category,
            amount: Math.abs(Number(amount)),
            description,
            referenceType: 'HostelFeeInvoice',
            referenceId: invoiceId || null,
            runningBalance: prev + delta,
            feeHeadName,
            createdBy,
        });
    } catch (e) {
        console.error('[hostel] ledger post failed:', e.message);
        return null;
    }
}

// ── student master data (read-only reuse — nothing is duplicated) ────────────
/**
 * The student's own record as the hostel needs to see it: identity from User,
 * medical + guardian detail from StudentProfile. Read-only by design.
 */
async function studentSnapshot(schoolId, studentId) {
    const [user, profile] = await Promise.all([
        User.findOne({ _id: studentId, school: schoolId }).select('name email phone profileImage role isActive').lean(),
        StudentProfile.findOne({ user: studentId, school: schoolId })
            .select('gender bloodGroup dob admissionNumber currentClass currentSection '
                  + 'emergencyContactName emergencyContactPhone emergencyContactRelation '
                  + 'fatherName fatherPhone motherName motherPhone guardianName guardianPhone guardianRelation '
                  + 'medicalCertificateFile address city state')
            .populate('currentClass', 'className')
            .populate('currentSection', 'sectionName')
            .lean(),
    ]);
    if (!user) return null;
    return { ...user, profile: profile || null };
}

/** Normalised gender token for the allocation gender check. */
function genderOf(profile) {
    const g = String(profile?.gender || '').toLowerCase();
    if (g === 'male') return 'male';
    if (g === 'female') return 'female';
    return '';
}

// ── hostel scoping ───────────────────────────────────────────────────────────
/**
 * Which hostels the caller may act on.
 *
 * school_admin and a teacher whose designation grants hostel *admin* see every
 * hostel in their school. Any other staff member sees only the hostels they are
 * warden of or assigned to — so a floor supervisor's dashboard shows their block,
 * not the whole campus (spec §3, §27).
 *
 * @returns {Promise<string[]|null>} hostel ids, or null for "all hostels".
 */
async function visibleHostelIds(req) {
    if (req.userRole === 'school_admin' || req.userRole === 'super_admin') return null;
    const access = req.access || {};
    if (access.permissions?.hostel === 'admin') return null;

    const [owned, assigned] = await Promise.all([
        Hostel.find({ school: req.schoolId, $or: [{ warden: req.userId }, { assistantWarden: req.userId }] })
            .select('_id').lean(),
        HostelStaffAssignment.find({ school: req.schoolId, staff: req.userId, status: 'active' })
            .select('hostel').lean(),
    ]);
    return [...new Set([...owned.map((h) => String(h._id)), ...assigned.map((a) => String(a.hostel))])];
}

/**
 * Merge the caller's hostel scope into a query filter. An explicit ?hostel= is
 * intersected with the scope, never trusted on its own.
 */
async function scopedFilter(req, base = {}, hostelParam = undefined) {
    const q = { ...base, school: req.schoolId };
    const allowed = await visibleHostelIds(req);
    const asked = hostelParam !== undefined ? hostelParam : req.query.hostel;

    if (allowed === null) {
        if (asked) q.hostel = asked;
        return q;
    }
    if (!allowed.length) { q.hostel = '__none__'; return q; }   // matches nothing
    q.hostel = (asked && allowed.includes(String(asked))) ? asked : { $in: allowed };
    return q;
}

/** The student ids a parent is allowed to see, from the existing ParentProfile. */
async function childIdsOfParent(userId) {
    const p = await ParentProfile.findOne({ user: userId }).select('children').lean();
    return (p?.children || []).map(String);
}

module.exports = {
    ok, bad, fail, toId, MONTHS,
    dayRange, dayStart, monthStart, atTime, minutesBetween,
    getSettings, nextNumber, logAudit, diffFields,
    notifyStudentAndParents, notifyHostelStaff,
    postToLedger, studentSnapshot, genderOf,
    visibleHostelIds, scopedFilter, childIdsOfParent,
};
