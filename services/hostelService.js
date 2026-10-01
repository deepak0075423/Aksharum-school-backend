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
const HostelCounter         = require('../models/HostelCounter');
const FeeLedger             = require('../models/FeeLedger');
const StudentProfile        = require('../models/StudentProfile');
const ParentProfile         = require('../models/ParentProfile');
const User                  = require('../models/User');
const { notify, withParents, schoolAdminIds } = require('./notifyService');
const pool = require('../db/pool');

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
//
// The running part comes from a per-school counter (models/HostelCounter), bumped
// in one UPDATE. It used to be `count of rows + 1`, which hands the same number
// out twice once a row is deleted or two requests land together. A series seen
// for the first time starts from the count, so numbering carries on from where
// the old scheme left it.
async function bumpCounter(schoolId, key) {
    try {
        const { rows } = await pool.query(
            `UPDATE "${HostelCounter.tableName}" SET "value" = "value" + 1, "updatedAt" = now()
              WHERE "school" = $1 AND "key" = $2 RETURNING "value"`, [String(schoolId), key]);
        return rows.length ? Number(rows[0].value) : null;
    } catch { return null; }                                   // table not created yet: seed it below
}
async function nextNumber(Model, schoolId, prefix, withDay = false, { fresh = false } = {}) {
    const d  = new Date();
    const ym = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`
             + (withDay ? String(d.getDate()).padStart(2, '0') : '');
    let n = await bumpCounter(schoolId, prefix);
    if (n == null) {
        // `fresh`: a series that never existed before starts at 1, not at the row count.
        const seed = fresh ? 1 : (await Model.countDocuments({ school: schoolId })) + 1;
        try { await HostelCounter.create({ school: schoolId, key: prefix, value: seed }); n = seed; }
        catch { n = await bumpCounter(schoolId, prefix); }     // somebody else seeded it first
        if (n == null) throw new Error('Could not allocate a document number');
    }
    return `${prefix}-${ym}-${String(n).padStart(4, '0')}`;
}

/**
 * The next receipt number, HR-000001 upwards, from a counter on the settings
 * row bumped in a single UPDATE. The old receipts were numbered from a COUNT
 * of invoices, so two payments taken between two invoices shared a number;
 * the counter cannot repeat however the payments interleave.
 */
async function nextReceiptNumber(schoolId) {
    await getSettings(schoolId);                               // the row must exist to be bumped
    const { rows } = await pool.query(
        `UPDATE "${HostelSettings.tableName}" SET "lastReceiptNumber" = COALESCE("lastReceiptNumber", 0) + 1
          WHERE "school" = $1 RETURNING "lastReceiptNumber"`, [String(schoolId)]);
    if (!rows.length) throw new Error('Could not allocate a receipt number');
    return `HR-${String(rows[0].lastReceiptNumber).padStart(6, '0')}`;
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
async function notifyHostelStaff(req, { hostelId, title, body, email = false, link = null, includeSender = false }) {
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
            title, body, recipients: [...new Set(ids)], email, includeSender,
            link: link || { type: 'hostel' },
        });
    } catch { /* fire-and-forget */ }
}

/**
 * A stand-in request for work nobody asked for — the half-hourly sweep. The
 * notification service needs a sender, so a school admin lends their id (and
 * is told too: `includeSender`); the role says it was the system.
 * Null when the school has no admin to send as.
 */
async function systemRequest(schoolId) {
    const admins = await schoolAdminIds(schoolId);
    if (!admins.length) return null;
    return { schoolId, userId: String(admins[0]), userRole: 'system', user: { name: 'System' }, headers: {}, ip: '', system: true };
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
        // The ledger is a STUDENT's fee position. A member of staff living in
        // the hostel has no row in it, and a charge of theirs must not start one.
        const account = await User.findOne({ _id: studentId, school: schoolId }).select('role').lean();
        if (account?.role !== 'student') return null;

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
    // A member of staff has no student profile; what identifies them is their
    // employee record.
    const staff = user.role === 'teacher'
        ? await require('../models/TeacherProfile').findOne({ user: studentId })
            .select('employeeId designation department gender').lean()
        : null;
    return { ...user, profile: profile || null, staff: staff || null };
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

// ── hostel files ─────────────────────────────────────────────────────────────
/**
 * A link to a hostel file that works for a few hours and for that file only.
 *
 * Hostel papers — ID proofs, medical notes, a child's complaint photo — used
 * to be served from /uploads to anyone who had the address, logged in or not.
 * That folder is now closed (server.js). A file is read either with a login
 * (GET /hostel/files/:name, which checks whose it is) or through one of these
 * links, which the API hands only to someone it has already checked.
 */
const FILE_LINK_HOURS = 6;
const fileSig = (name, exp) => require('crypto').createHmac('sha256', String(process.env.JWT_SECRET || 'hostel-files'))
    .update(`${name}|${exp}`).digest('hex').slice(0, 40);
function signedFileUrl(storedName) {
    if (!storedName) return '';
    const name = require('path').basename(String(storedName));
    const exp = Date.now() + FILE_LINK_HOURS * 36e5;
    return `/api/hostel/file/${encodeURIComponent(name)}?exp=${exp}&sig=${fileSig(name, exp)}`;
}
/**
 * The hosted checkout page for one order, for a payer with no browser session
 * of their own — the phone app opens it in the system browser, which cannot
 * carry a login. Signed like a file link, and good for half an hour. The path
 * is relative to the API root.
 */
function signedPayPath(orderId) {
    const exp = Date.now() + 30 * 60000;
    return `/hostel/pay/${encodeURIComponent(orderId)}?exp=${exp}&sig=${fileSig(`pay:${orderId}`, exp)}`;
}
const checkPaySig = (orderId, exp, sig) => checkFileSig(`pay:${orderId}`, exp, sig);

/** Is this the signature we gave out for this file, and is it still in date? */
function checkFileSig(name, exp, sig) {
    const until = Number(exp);
    if (!name || !Number.isFinite(until) || until < Date.now()) return false;
    const want = Buffer.from(fileSig(name, until)); const got = Buffer.from(String(sig || ''));
    return want.length === got.length && require('crypto').timingSafeEqual(want, got);
}

/** The student ids a parent is allowed to see, from the existing ParentProfile. */
async function childIdsOfParent(userId) {
    const p = await ParentProfile.findOne({ user: userId }).select('children').lean();
    return (p?.children || []).map(String);
}

module.exports = {
    ok, bad, fail, toId, MONTHS,
    dayRange, dayStart, monthStart, atTime, minutesBetween,
    getSettings, nextNumber, logAudit, systemRequest, diffFields,
    notifyStudentAndParents, notifyHostelStaff,
    postToLedger, nextReceiptNumber, studentSnapshot, genderOf,
    visibleHostelIds, scopedFilter, childIdsOfParent, signedFileUrl, checkFileSig, signedPayPath, checkPaySig,
};
