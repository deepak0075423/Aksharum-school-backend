'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Employee Directory — field-level visibility policy and record assembly.
//
//  There is no employee master here. Every value is read from the records the
//  ERP already keeps:
//
//      User               account, name, official email/phone, active flag
//      TeacherProfile     employment, personal, contact, IDs, bank, education
//      ClassSection       class teacher / vice class teacher
//      SectionSubjectTeacher   subject ↔ section assignments
//      Timetable(+Entry)  periods, rooms, free periods
//      TeacherAttendance  attendance summary
//      LeaveApplication / LeaveBalance   leave summary
//      EmployeeSalaryAssignment          CTC
//      Document           shared documents
//      Designation        the caller's module permissions
//
//  Two things are new because nothing existed to hold them:
//  EmployeeResponsibility and EmployeeVerification.
//
//  ── Visibility ──────────────────────────────────────────────────────────────
//  The caller's level on the `employeeDirectory` module (from the designation
//  matrix) decides what comes back. school_admin is administrative on every
//  module their school has enabled, so it resolves to 'admin' the same way a
//  promoted designation does — no role is hard-coded below.
//
//      admin  full record, sensitive values MASKED (never raw in a list or
//             profile response); an explicit, audited reveal returns the raw
//             value for one field at a time.
//      user   professional information only. Aadhaar / PAN / bank / salary /
//             personal / private documents / attendance / leave are not put on
//             the response object at all — they are never serialised, so there
//             is nothing for a client to un-hide.
//      self   an employee always sees their own full permitted record.
//
//  Bank and payroll ride a second gate: administrative access to the `payroll`
//  module, which is the existing permission that governs salary data.
// ─────────────────────────────────────────────────────────────────────────────

const User                  = require('../models/User');
const TeacherProfile        = require('../models/TeacherProfile');
const ClassSection          = require('../models/ClassSection');
const Class                 = require('../models/Class');
const Subject               = require('../models/Subject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const AcademicYear          = require('../models/AcademicYear');
const Timetable             = require('../models/Timetable');
const TimetableEntry        = require('../models/TimetableEntry');
const Room                  = require('../models/Room');
const TeacherAttendance     = require('../models/TeacherAttendance');
const LeaveApplication      = require('../models/LeaveApplication');
const LeaveBalance          = require('../models/LeaveBalance');
const LeaveType             = require('../models/LeaveType');
const EmployeeSalaryAssignment = require('../models/EmployeeSalaryAssignment');
const EmployeeResponsibility   = require('../models/EmployeeResponsibility');
const EmployeeVerification     = require('../models/EmployeeVerification');
const Document              = require('../models/Document');
const designations          = require('./designationService');

const sid  = (v) => (v == null ? '' : String(v._id ?? v));
const low  = (s) => String(s ?? '').toLowerCase().trim();
const trim = (s) => String(s ?? '').trim();
const pct  = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

// ── Masking ──────────────────────────────────────────────────────────────────
// Every mask keeps the last few characters so a human can still match a value
// against paperwork in front of them, and nothing more.

const maskTail = (value, keep, groupOf = 0) => {
    const raw = trim(value).replace(/\s+/g, '');
    if (!raw) return '';
    if (raw.length <= keep) return 'X'.repeat(raw.length);
    const hidden = 'X'.repeat(raw.length - keep);
    const tail   = raw.slice(-keep);
    if (!groupOf) return hidden + tail;
    // The hidden run is grouped, the visible tail stays whole — grouping across
    // the boundary would split the digits the reader is trying to match.
    const groups = hidden.match(new RegExp(`.{1,${groupOf}}`, 'g')) || [];
    return [...groups, tail].join(' ');
};

const maskAadhaar = (v) => maskTail(v, 4, 4);                   // XXXX XXXX 1234
// Fixed shape regardless of the real length: an account number's digit count is
// itself a hint, and every bank uses a different one.
const maskAccount = (v) => {
    const raw = trim(v).replace(/\s+/g, '');
    if (!raw) return '';
    if (raw.length <= 4) return 'X'.repeat(raw.length);
    return `XXXX XXXX ${raw.slice(-4)}`;                        // XXXX XXXX 4521
};
const maskUan     = (v) => maskTail(v, 4, 0);
const maskPan     = (v) => {                                    // XXXXX1234F
    const raw = trim(v).toUpperCase();
    if (raw.length !== 10) return maskTail(raw, 4, 0);
    return `XXXXX${raw.slice(5)}`;
};

// Which fields the reveal endpoint understands, what it reads, and which gate
// each one sits behind. Nothing outside this table can ever be revealed.
const REVEALABLE = {
    aadhaarNumber:     { source: 'profile', gate: 'governmentId', label: 'Aadhaar number' },
    panNumber:         { source: 'profile', gate: 'governmentId', label: 'PAN number' },
    uanNumber:         { source: 'profile', gate: 'governmentId', label: 'UAN / PF number' },
    bankAccountNumber: { source: 'profile', gate: 'bank',         label: 'Bank account number' },
};

// ── Viewer ───────────────────────────────────────────────────────────────────

/**
 * Resolve the caller into the capabilities the directory branches on.
 * Everything is derived from the designation matrix — no role literal decides
 * what a caller may see beyond "school_admin is administrative on its school's
 * enabled modules", which designationService already encodes.
 */
async function resolveViewer(req) {
    const access = await designations.requestAccess(req);
    const level  = access.permissions.employeeDirectory || designations.NONE;
    const isAdmin = level === designations.ADMIN;
    // Salary data has its own owner in this ERP: administrative access to the
    // payroll module. An employee-directory admin does not inherit it.
    const payrollAdmin = access.permissions.payroll === designations.ADMIN;

    return {
        userId: String(req.userId),
        schoolId: String(req.schoolId || ''),
        role: req.userRole,
        level,
        isAdmin,
        payrollAdmin,
        modules: access.moduleFlags,
        designation: access.designation || '',
    };
}

/** What the viewer may see about one particular employee. */
function visibilityFor(viewer, employeeId) {
    const self = String(employeeId) === viewer.userId;
    const admin = viewer.isAdmin;
    return {
        self,
        admin,
        // Professional information — the tier every directory user gets.
        overview:         true,
        subjectsClasses:  true,
        responsibilities: true,
        timetable:        true,
        // Restricted tiers.
        personal:      admin || self,
        contactFull:   admin || self,
        employmentFull: admin || self,
        educationDocs: admin || self,
        attendance:    admin || self,
        leave:         admin || self,
        documents:     admin || self,
        governmentId:  admin || self,
        bank:          (admin && viewer.payrollAdmin) || self,
        payroll:       viewer.payrollAdmin || self,
        completion:    admin || self,
        // Only an administrator may unmask, and only for someone else's record
        // through the audited endpoint; an employee's own values are theirs.
        canReveal:     admin || self,
    };
}

// ── Profile completion ───────────────────────────────────────────────────────
// Mirrors validateTeacherIntake() in controllers/admin.controller.js — the
// school's actual definition of a complete employee record. Nothing is invented
// here: if the intake wizard demands it, it counts.

const COMPLETION_FIELDS = [
    { key: 'name',                  label: 'Full name',              on: 'user' },
    { key: 'email',                 label: 'Email address',          on: 'user' },
    { key: 'phone',                 label: 'Mobile number',          on: 'user' },
    { key: 'dob',                   label: 'Date of birth' },
    { key: 'gender',                label: 'Gender' },
    { key: 'bloodGroup',            label: 'Blood group' },
    { key: 'fatherOrHusbandName',   label: "Father's / husband's name" },
    { key: 'emergencyContactName',  label: 'Emergency contact name' },
    { key: 'emergencyContactPhone', label: 'Emergency contact phone' },
    { key: 'currentAddress',        label: 'Current address' },
    { key: 'currentCity',           label: 'Current city' },
    { key: 'currentState',          label: 'Current state' },
    { key: 'currentPincode',        label: 'Current PIN code' },
    { key: 'permanentAddress',      label: 'Permanent address' },
    { key: 'aadhaarNumber',         label: 'Aadhaar number' },
    { key: 'aadhaarFrontFile',      label: 'Aadhaar front image',    doc: true },
    { key: 'aadhaarBackFile',       label: 'Aadhaar back image',     doc: true },
    { key: 'panNumber',             label: 'PAN number' },
    { key: 'panCardFile',           label: 'PAN card upload',        doc: true },
    { key: 'qualification',         label: 'Highest qualification' },
    { key: 'employmentType',        label: 'Fresher / experienced' },
    { key: 'bankAccountHolder',     label: 'Bank account holder' },
    { key: 'bankAccountNumber',     label: 'Bank account number' },
    { key: 'bankIfsc',              label: 'IFSC code' },
    { key: 'bankBranch',            label: 'Bank branch' },
    { key: 'joiningDate',           label: 'Date of joining' },
    { key: 'employeeId',            label: 'Employee ID' },
];

// Only demanded of an experienced hire, exactly as the intake validator does.
const EXPERIENCED_ONLY = [
    { key: 'totalExperience',       label: 'Total years of experience' },
    { key: 'previousSchool',        label: 'Previous school' },
    { key: 'lastDesignation',       label: 'Last designation' },
    { key: 'resignationLetterFile', label: 'Resignation letter', doc: true },
];

function computeCompletion(user, profile) {
    const p = profile || {};
    const required = [...COMPLETION_FIELDS];
    if (p.employmentType === 'experienced') required.push(...EXPERIENCED_ONLY);

    const missing = [];
    let filled = 0;
    for (const f of required) {
        const source = f.on === 'user' ? user : p;
        const value  = source?.[f.key];
        const ok = value instanceof Date ? !Number.isNaN(value.getTime()) : !!trim(value);
        if (ok) filled += 1; else missing.push({ key: f.key, label: f.label, isDocument: !!f.doc });
    }
    return {
        percent: pct(filled, required.length),
        filled,
        total: required.length,
        missing,
        missingDocuments: missing.filter((m) => m.isDocument),
    };
}

// ── Documents ────────────────────────────────────────────────────────────────
// The employee's own paperwork lives as filenames on TeacherProfile, uploaded
// through the teacher intake wizard into /uploads/staff-docs.

const STAFF_DOC_BASE = '/uploads/staff-docs';

const DOCUMENT_DEFS = [
    { key: 'aadhaarFrontFile',          category: 'identity',   label: 'Aadhaar — Front',        sensitive: true,  verification: 'government_id' },
    { key: 'aadhaarBackFile',           category: 'identity',   label: 'Aadhaar — Back',         sensitive: true,  verification: 'government_id' },
    { key: 'panCardFile',               category: 'identity',   label: 'PAN Card',               sensitive: true,  verification: 'government_id' },
    { key: 'resignationLetterFile',     category: 'employment', label: 'Resignation Letter',     sensitive: false, verification: 'employment_documents' },
    { key: 'experienceCertificateFile', category: 'employment', label: 'Experience Certificate', sensitive: false, verification: 'employment_documents' },
    { key: 'joiningLetterFile',         category: 'employment', label: 'Joining Letter',         sensitive: false, verification: 'employment_documents' },
];

function buildDocuments(profile, verificationBySection) {
    const p = profile || {};
    return DOCUMENT_DEFS
        .filter((d) => trim(p[d.key]))
        .map((d) => {
            const v = verificationBySection[d.verification];
            return {
                key: d.key,
                category: d.category,
                label: d.label,
                fileName: p[d.key],
                url: `${STAFF_DOC_BASE}/${p[d.key]}`,
                sensitive: d.sensitive,
                uploadedAt: p.createdAt || null,
                verificationStatus: v?.status || 'pending',
                verifiedAt: v?.verifiedAt || null,
                verifiedBy: v?.verifiedByName || '',
                expiresAt: v?.expiresAt || null,
            };
        });
}

module.exports = {
    sid, low, trim, pct,
    maskAadhaar, maskAccount, maskPan, maskUan, maskTail,
    REVEALABLE,
    resolveViewer, visibilityFor,
    computeCompletion, COMPLETION_FIELDS, EXPERIENCED_ONLY,
    buildDocuments, DOCUMENT_DEFS, STAFF_DOC_BASE,
    models: {
        User, TeacherProfile, ClassSection, Class, Subject, SectionSubjectTeacher,
        AcademicYear, Timetable, TimetableEntry, Room, TeacherAttendance,
        LeaveApplication, LeaveBalance, LeaveType, EmployeeSalaryAssignment,
        EmployeeResponsibility, EmployeeVerification, Document,
    },
};
