'use strict';
const bcrypt        = require('bcryptjs');

const XLSX          = require('xlsx');
const User          = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');
const StudentProfile = require('../models/StudentProfile');
const ParentProfile  = require('../models/ParentProfile');
const ClassSection   = require('../models/ClassSection');
const Class          = require('../models/Class');
const AcademicYear   = require('../models/AcademicYear');
const School         = require('../models/School');
const { GATEWAY_MODULES } = require('../services/paymentGateway');
const ReceiptTemplate = require('../models/ReceiptTemplate');
const { PRESETS, renderReceipt, defaultTemplate, sampleReceipt } = require('../services/receiptRenderer');

// The design fields a school may set; everything else on the row is bookkeeping.
const TEMPLATE_FIELDS = [
    'preset', 'accentColor', 'headerText', 'footerText', 'notes', 'signatoryName',
    'showLogo', 'showBreakdown', 'showSignature', 'showPaymentMode',
];

/** School details as the receipt wants them, with the logo made absolute. */
function schoolForReceipt(school, req) {
    if (!school) return null;
    const origin = `${req.protocol}://${req.get('host')}`;
    return {
        name: school.name,
        address: school.address,
        logoUrl: school.logo ? (/^https?:/.test(school.logo) ? school.logo : `${origin}${school.logo}`) : '',
    };
}
exports._schoolForReceipt = schoolForReceipt;
const Designation    = require('../models/Designation');
const designationSvc = require('../services/designationService');
const mailer         = require('../config/mailer');
const { sendSchoolMail, emailHeaderHtml, getMailContext, invalidate: invalidateMailer } = require('../utils/schoolMailer');
const { notify } = require('../services/notifyService');
const { validate, isEmail, isPhone, isURL } = require('../utils/validators');
const authCache = require('../utils/authCache');
const { deleteSchoolLogo } = require('../utils/schoolLogoFile');
const { STATES_AND_UTS, isPincode, stateFromPincode } = require('../utils/indiaStates');
const { rollNumberTaken } = require('../utils/rollNumbers');
const admissionNo = require('../utils/admissionNumber');
const employeeIdUtil = require('../utils/employeeId');
const { capacityErrorById } = require('../utils/sectionCapacity');

// Generates a random 10-char one-time password, avoiding visually confusing chars
const generateOTP = () => {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const sendWelcomeEmail = (to, name, email, otp, schoolName, schoolId = null) => {
    const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`;
    // Fetch branding (logo) then send through the school's own SMTP when configured
    getMailContext(schoolId).then(({ school }) => {
    const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
      ${emailHeaderHtml(school, `Welcome to ${schoolName}!`)}
      <div style="background:#f9fafb;padding:28px 32px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
        <p style="margin-top:0">Hi <strong>${name}</strong>,</p>
        <p>Your school account has been created. Use the one-time credentials below to log in for the first time:</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#fff;border-radius:6px;border:1px solid #e5e7eb">
          <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:12px 16px;font-weight:600;width:40%;color:#6b7280">Login URL</td>
            <td style="padding:12px 16px"><a href="${loginUrl}" style="color:#4f46e5">${loginUrl}</a></td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:12px 16px;font-weight:600;color:#6b7280">Email</td>
            <td style="padding:12px 16px">${email}</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;font-weight:600;color:#6b7280">One-Time Password</td>
            <td style="padding:12px 16px;font-family:monospace;font-size:1.1rem;letter-spacing:2px"><strong>${otp}</strong></td>
          </tr>
        </table>
        <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:14px 16px;margin-bottom:20px">
          <strong>⚠️ Action required:</strong> After logging in you will be asked to set a permanent password.
          This one-time password will stop working once you do.
        </div>
        <p style="color:#6b7280;font-size:.88rem;margin-bottom:0">
          If you did not request this account, please contact your school administrator.<br>
          Do not share your credentials with anyone.
        </p>
      </div>
    </div>`;
    sendSchoolMail(schoolId, {
        to,
        subject: `Your ${schoolName} account is ready — action required`,
        html,
        fromName: schoolName,
    });
    }).catch(err => console.error(`[email] welcome failed for ${to}:`, err.message));
};

const jsonOk  = (res, data, status = 200) => res.status(status).json({ success: true,  data });
const jsonErr = (res, err, status = 500)  => res.status(status).json({ success: false, message: err.message || err });

// Shared by the student and teacher intakes. Both post as multipart (ID scans
// and certificates), so every value arrives as a string — booleans included.
const AADHAAR_RE = /^\d{12}$/;
const PAN_RE     = /^[A-Z]{5}\d{4}[A-Z]$/i;
const IFSC_RE    = /^[A-Z]{4}0[A-Z0-9]{6}$/i;
const isTrue = (v) => v === true || v === 'true' || v === 'on' || v === '1';

// ── Student profile: required demographic + address fields ────────────────────
// Enforced here as well as in the form so bulk/API callers cannot skip them.
// `address`/`city`/`state`/`pincode` are the CURRENT address; the permanent one
// is a separate prefixed block, required unless "same as current" is ticked.
const REQUIRED_PROFILE_FIELDS = [
    ['dob',        'Date of birth'],
    ['gender',     'Gender'],
    ['bloodGroup', 'Blood group'],
    ['category',   'Category'],
    ['nationality', 'Nationality'],
    ['emergencyContactName',     'Emergency contact name'],
    ['emergencyContactPhone',    'Emergency contact phone'],
    ['emergencyContactRelation', 'Emergency contact relation to the student'],
    ['aadhaarNumber', 'Aadhaar card number'],
    ['address',    'Current address'],
    ['city',       'Current city'],
    ['state',      'Current state'],
    ['pincode',    'Current PIN code'],
];

// Transfer admissions only — gated on `isTransferStudent`. The migration
// certificate stays optional; it is only issued when the board changes.
const REQUIRED_TRANSFER_FIELDS = [
    ['previousSchoolName',        'Previous school name'],
    ['previousSchoolAddress',     'Previous school address'],
    ['previousSchoolCity',        'Previous school city'],
    ['previousSchoolState',       'Previous school state'],
    ['previousSchoolPincode',     'Previous school PIN code'],
    ['previousSchoolMedium',      'Previous school medium'],
    ['previousSchoolBoard',       'Previous school board'],
    ['previousClass',             'Previous class'],
    ['previousAcademicYear',      'Previous academic year'],
    ['previousSchoolLeavingDate', 'Previous school leaving date'],
    ['previousSchoolContact',     'Previous school contact'],
    ['tcNumber',                  'TC number'],
    ['tcDate',                    'TC date'],
];

// Every StudentProfile field the intake form owns. Enrolment (class/section),
// roll and admission numbers are handled separately because they carry their
// own uniqueness checks.
const STUDENT_PROFILE_KEYS = [
    'dob', 'gender', 'bloodGroup', 'category', 'religion', 'nationality',
    'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
    'address', 'city', 'state', 'pincode', 'country',
    'permanentAddress', 'permanentCity', 'permanentState', 'permanentPincode', 'permanentCountry',
    'sameAsCurrent', 'aadhaarNumber', 'isTransferStudent', 'previousSchoolCountry',
    'previousSchoolStateBoardName',
    ...REQUIRED_TRANSFER_FIELDS.map(([key]) => key),
];

// Multipart field name -> StudentProfile key. Kept in one place because the
// route, the validator and the profile builder all need the same list.
const STUDENT_FILE_MAP = {
    photo:                 'photoFile',
    aadhaarFront:          'aadhaarFrontFile',
    aadhaarBack:           'aadhaarBackFile',
    birthCertificate:      'birthCertificateFile',
    casteCertificate:      'casteCertificateFile',
    disabilityCertificate: 'disabilityCertificateFile',
    medicalCertificate:    'medicalCertificateFile',
    tc:                    'tcFile',
    migrationCertificate:  'migrationCertificateFile',
};

// Guardian uploads are namespaced by role: fatherAadhaarFront, motherPanCard, …
const PARENT_FILE_MAP = {
    AadhaarFront: 'aadhaarFrontFile',
    AadhaarBack:  'aadhaarBackFile',
    PanCard:      'panCardFile',
    Photo:        'photoFile',
};
const PARENT_ROLES = ['father', 'mother', 'guardian'];

exports.STUDENT_DOC_FIELDS = [
    ...Object.keys(STUDENT_FILE_MAP),
    ...PARENT_ROLES.flatMap(role => Object.keys(PARENT_FILE_MAP).map(suffix => `${role}${suffix}`)),
];

/** `req.files` (multer .fields) -> { [fieldName]: storedFilename }. */
const uploadedNames = (files = {}) => Object.fromEntries(
    Object.entries(files).map(([key, list]) => [key, list?.[0]?.filename || '']).filter(([, v]) => v),
);

/**
 * Accept a value that may arrive as a real object (JSON request) or as a JSON
 * string (multipart request, where every field is text). Anything unparseable
 * is treated as absent rather than throwing.
 */
function parseMaybeJson(value) {
    if (value == null || value === '') return undefined;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return undefined; }
}

function validateStudentProfile(profile = {}, { partial = false } = {}) {
    const sent = (key) => !partial || profile[key] !== undefined;
    const missing = (key, label) => (sent(key) && !String(profile[key] ?? '').trim() ? `${label} is required` : null);

    for (const [key, label] of REQUIRED_PROFILE_FIELDS) {
        // On edit, only validate the fields the client actually sent
        const err = missing(key, label);
        if (err) return err;
    }
    if (profile.dob !== undefined && profile.dob && Number.isNaN(new Date(profile.dob).getTime()))
        return 'Invalid date of birth';
    if (profile.emergencyContactPhone !== undefined && String(profile.emergencyContactPhone || '').trim()
        && !isPhone(profile.emergencyContactPhone))
        return 'Emergency contact phone is not valid';
    if (profile.aadhaarNumber !== undefined && String(profile.aadhaarNumber || '').trim()
        && !AADHAAR_RE.test(String(profile.aadhaarNumber).replace(/\s/g, '')))
        return 'Aadhaar number must be 12 digits';
    if (profile.pincode !== undefined && String(profile.pincode || '').trim() && !isPincode(profile.pincode))
        return 'Current PIN code must be 6 digits';
    if (profile.state !== undefined && String(profile.state || '').trim() && !STATES_AND_UTS.includes(String(profile.state).trim()))
        return 'Select a valid current state or union territory';

    // Permanent address — skipped entirely when it mirrors the current one
    if (sent('sameAsCurrent') && !isTrue(profile.sameAsCurrent)) {
        const err = missing('permanentAddress', 'Permanent address')
            || missing('permanentPincode', 'Permanent PIN code')
            || missing('permanentCity',    'Permanent city')
            || missing('permanentState',   'Permanent state');
        if (err) return err;
        if (!isPincode(profile.permanentPincode)) return 'Permanent PIN code must be 6 digits';
        if (!STATES_AND_UTS.includes(String(profile.permanentState).trim()))
            return 'Select a valid permanent state or union territory';
    }

    // Previous school — only when the student transferred in
    if (sent('isTransferStudent') && isTrue(profile.isTransferStudent)) {
        for (const [key, label] of REQUIRED_TRANSFER_FIELDS) {
            const err = missing(key, label);
            if (err) return err;
        }
        // A state board only identifies the school once it is named
        if (String(profile.previousSchoolBoard).trim() === 'State Board'
            && !String(profile.previousSchoolStateBoardName ?? '').trim())
            return 'Name of the state board is required';
        if (profile.previousSchoolPincode && !isPincode(profile.previousSchoolPincode))
            return 'Previous school PIN code must be 6 digits';
        if (profile.previousSchoolState && !STATES_AND_UTS.includes(String(profile.previousSchoolState).trim()))
            return 'Select a valid previous school state or union territory';
        if (profile.previousSchoolContact && !isPhone(profile.previousSchoolContact))
            return 'Previous school contact number is not valid';
        for (const [key, label] of [['previousSchoolLeavingDate', 'leaving date'], ['tcDate', 'TC date']]) {
            if (profile[key] && Number.isNaN(new Date(profile[key]).getTime())) return `Invalid previous school ${label}`;
        }
    }
    return null;
}

/**
 * Document rules. A requirement is met by a file uploaded on this request or
 * by one already stored, so editing a student does not force a re-upload.
 */
function validateStudentDocs(profile = {}, uploads = {}, existing = null) {
    const has = (field) => !!uploads[field] || !!existing?.[STUDENT_FILE_MAP[field]];
    if (!has('photo'))            return "Student's passport size photo is required";
    if (!has('aadhaarFront'))     return "Aadhaar card front image is required";
    if (!has('aadhaarBack'))      return "Aadhaar card back image is required";
    if (!has('birthCertificate')) return 'Birth certificate is required';
    if (isTrue(profile.isTransferStudent) && !has('tc'))
        return 'Transfer Certificate (TC) upload is required for a transfer admission';
    return null;
}

/** Map the submitted profile + uploads onto the StudentProfile document shape. */
function buildStudentProfile(profile = {}, uploads = {}) {
    const out = { ...profile };
    const str = (v) => String(v ?? '').trim();

    out.nationality  = str(profile.nationality) || 'Indian';
    out.country      = str(profile.country) || 'India';
    if (profile.aadhaarNumber !== undefined) out.aadhaarNumber = str(profile.aadhaarNumber).replace(/\s/g, '');

    // "Same as current" copies the whole block, not just the street line
    out.sameAsCurrent = isTrue(profile.sameAsCurrent);
    if (out.sameAsCurrent) {
        out.permanentAddress = str(profile.address);
        out.permanentCity    = str(profile.city);
        out.permanentState   = str(profile.state);
        out.permanentPincode = str(profile.pincode);
        out.permanentCountry = out.country;
    } else if (profile.permanentAddress !== undefined) {
        out.permanentCountry = str(profile.permanentCountry) || 'India';
    }

    // A student who is not a transfer admission carries no previous-school data
    out.isTransferStudent = isTrue(profile.isTransferStudent);
    if (!out.isTransferStudent) {
        REQUIRED_TRANSFER_FIELDS.forEach(([key]) => { out[key] = ''; });
        out.previousSchoolCountry = 'India';
        out.previousSchoolStateBoardName = '';
        out.previousSchoolLeavingDate = null;
        out.tcDate = null;
    } else {
        out.previousSchoolCountry = str(profile.previousSchoolCountry) || 'India';
        // The board name only belongs to a state board
        out.previousSchoolStateBoardName = str(profile.previousSchoolBoard) === 'State Board'
            ? str(profile.previousSchoolStateBoardName) : '';
        out.previousSchoolLeavingDate = profile.previousSchoolLeavingDate ? new Date(profile.previousSchoolLeavingDate) : null;
        out.tcDate = profile.tcDate ? new Date(profile.tcDate) : null;
    }

    for (const [field, key] of Object.entries(STUDENT_FILE_MAP)) {
        if (uploads[field]) out[key] = uploads[field];
    }
    return out;
}

/**
 * Resolve the parent account for a student.
 *
 * `newParent` accepts the full shape — { father, mother, guardian, accountFor }
 * — where each block carries the guardian's contact, employment and ID details.
 * Father and mother are always required; the `guardian` block is only used when
 * `accountFor` is 'Guardian', i.e. neither parent is the legal guardian. The
 * login account is created for (or linked to) whoever `accountFor` names, and
 * only that person needs an email address. The older flat shape
 * ({ name, email, phone }) keeps working and is treated as the guardian.
 *
 * @returns {Promise<{ parentId: String|null, error: String|null }>}
 */
async function resolveNewParent(newParent, { schoolId, schoolName, uploads = {}, existingBlocks = null }) {
    if (!newParent) return { parentId: null, error: null };

    const str = (v) => String(v ?? '').trim();
    const blocks = PARENT_ROLES.reduce((acc, key) => {
        const b = newParent[key] || {};
        const prev = existingBlocks?.[key] || {};
        acc[key] = {
            name:          str(b.name),
            email:         str(b.email).toLowerCase(),
            phone:         str(b.phone),
            occupation:    str(b.occupation),
            organization:  str(b.organization),
            designation:   str(b.designation),
            qualification: str(b.qualification),
            annualIncome:  str(b.annualIncome),
            aadhaarNumber: str(b.aadhaarNumber).replace(/\s/g, ''),
            panNumber:     str(b.panNumber).toUpperCase(),
            // A document keeps whatever is on file unless this request replaces it
            aadhaarFrontFile: uploads[`${key}AadhaarFront`] || prev.aadhaarFrontFile || '',
            aadhaarBackFile:  uploads[`${key}AadhaarBack`]  || prev.aadhaarBackFile  || '',
            panCardFile:      uploads[`${key}PanCard`]      || prev.panCardFile      || '',
            photoFile:        uploads[`${key}Photo`]        || prev.photoFile        || '',
            ...(key === 'guardian' ? { relation: str(b.relation) } : {}),
        };
        return acc;
    }, {});

    const isStructured = Object.values(blocks).some(b => b.name || b.email);
    const accountFor   = ['Father', 'Mother', 'Guardian'].includes(newParent.accountFor)
        ? newParent.accountFor
        : 'Guardian';

    // Legacy flat payload — treat it as the guardian block
    if (!isStructured) {
        if (!newParent.name || !newParent.email) return { parentId: null, error: null };
        blocks.guardian = {
            ...blocks.guardian,
            name:  str(newParent.name),
            email: str(newParent.email).toLowerCase(),
            phone: str(newParent.phone),
        };
    }

    const holderKey = (isStructured ? accountFor : 'Guardian').toLowerCase();
    const holder    = blocks[holderKey];

    // Both parents are always on record. The guardian block is only filled in
    // when someone other than a parent holds the account.
    if (isStructured) {
        const needed = accountFor === 'Guardian' ? PARENT_ROLES : ['father', 'mother'];
        for (const key of needed) {
            const b = blocks[key];
            const label = key[0].toUpperCase() + key.slice(1);
            if (!b.name)          return { parentId: null, error: `${label}'s name is required` };
            if (!b.phone)         return { parentId: null, error: `${label}'s phone number is required` };
            if (!b.occupation)    return { parentId: null, error: `${label}'s occupation is required` };
            if (!b.aadhaarNumber) return { parentId: null, error: `${label}'s Aadhaar number is required` };
        }
        if (accountFor === 'Guardian' && !blocks.guardian.relation)
            return { parentId: null, error: "Guardian's relation to the student is required" };
    }
    if (!holder.name)  return { parentId: null, error: `${accountFor}'s name is required to create the parent account` };
    if (!holder.email) return { parentId: null, error: `${accountFor}'s email is required to create the parent account` };
    if (!isEmail(holder.email)) return { parentId: null, error: `${accountFor}'s email is not a valid email address` };
    for (const [key, b] of Object.entries(blocks)) {
        const label = key[0].toUpperCase() + key.slice(1);
        if (b.email && !isEmail(b.email)) return { parentId: null, error: `${label}'s email is not a valid email address` };
        if (b.phone && !isPhone(b.phone)) return { parentId: null, error: `${label}'s phone number is not valid` };
        if (b.aadhaarNumber && !AADHAAR_RE.test(b.aadhaarNumber)) return { parentId: null, error: `${label}'s Aadhaar number must be 12 digits` };
        if (b.panNumber && !PAN_RE.test(b.panNumber)) return { parentId: null, error: `${label}'s PAN number looks invalid (e.g. ABCDE1234F)` };
    }

    // Link to the existing account when that email is already registered
    let parentUser = await User.findOne({ email: holder.email });
    if (parentUser && parentUser.role !== 'parent')
        return { parentId: null, error: `${holder.email} already belongs to a ${String(parentUser.role).replace('_', ' ')} account — use a different email for the parent` };
    if (parentUser && String(parentUser.school) !== String(schoolId))
        return { parentId: null, error: `${holder.email} is registered with another school` };
    if (!parentUser) {
        const otp = generateOTP();
        parentUser = await createUserHelper(
            { name: holder.name, email: holder.email, phone: holder.phone, password: otp },
            'parent', schoolId,
        );
        sendWelcomeEmail(holder.email, holder.name, holder.email, otp, schoolName, schoolId);
    }

    await ParentProfile.findOneAndUpdate(
        { user: parentUser._id },
        {
            $set: {
                father: blocks.father, mother: blocks.mother, guardian: blocks.guardian,
                fatherOccupation:   blocks.father.occupation,
                motherOccupation:   blocks.mother.occupation,
                guardianOccupation: blocks.guardian.occupation,
                annualIncome:       holder.annualIncome,
                relationship: isStructured ? accountFor : 'Guardian',
            },
            $setOnInsert: { school: schoolId },
        },
        { upsert: true },
    );

    return { parentId: parentUser._id, error: null };
}

exports.getDashboard = async (req, res) => {
    try {
        const school = req.schoolId;
        const LeaveApplication = require('../models/LeaveApplication');
        const FeePayment       = require('../models/FeePayment');
        const FormalExam       = require('../models/FormalExam');
        const TeacherAttendanceRegularization = require('../models/TeacherAttendanceRegularization');
        const Notification     = require('../models/Notification');

        const [teachers, students, parents, sections,
               pendingLeaves, pendingPayments, examsToPublish, pendingRegularizations,
               recentNotifications] = await Promise.all([
            User.countDocuments({ school, role: 'teacher' }),
            User.countDocuments({ school, role: 'student' }),
            User.countDocuments({ school, role: 'parent' }),
            ClassSection.countDocuments({ school, status: 'active' }),
            LeaveApplication.countDocuments({ school, status: 'pending' }).catch(() => 0),
            FeePayment.countDocuments({ school, paymentStatus: 'pending' }).catch(() => 0),
            FormalExam.countDocuments({ school, status: 'CLASS_APPROVED' }).catch(() => 0),
            TeacherAttendanceRegularization.countDocuments({ school, status: 'Pending' }).catch(() => 0),
            Notification.find({ school }).sort({ createdAt: -1 }).limit(5)
                .select('title createdAt senderRole recipientCount').lean().catch(() => []),
        ]);

        jsonOk(res, {
            teachers, students, parents, sections,
            pending: {
                leaves:          pendingLeaves,
                payments:        pendingPayments,
                examsToPublish,
                regularizations: pendingRegularizations,
            },
            recentNotifications,
        });
    } catch (err) { jsonErr(res, err); }
};

const listUsers = (role) => async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '' } = req.query;
        const filter = { school: req.schoolId, role };
        if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }];
        const [users, total] = await Promise.all([
            User.find(filter).sort({ name: 1 }).skip((page-1)*+limit).limit(+limit).lean(),
            User.countDocuments(filter),
        ]);
        if (role === 'teacher' && users.length) {
            const profiles = await TeacherProfile.find({ user: { $in: users.map((u) => u._id) } })
                .select('user designation').lean();
            const desig = new Map(profiles.map((p) => [String(p.user), p.designation]));
            for (const u of users) u.designation = desig.get(String(u._id)) || '';
        }
        res.json({ success: true, data: { data: users, total, page: +page, pages: Math.ceil(total/+limit) } });
    } catch (err) { jsonErr(res, err); }
};

exports.getTeachers = listUsers('teacher');
exports.getAdmins   = listUsers('school_admin');

exports.getStudents = async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '' } = req.query;
        const schoolOid = String(req.schoolId);
        const matchFilter = { school: schoolOid, role: 'student' };
        if (search) matchFilter.$or = [
            { name: new RegExp(search, 'i') },
            { email: new RegExp(search, 'i') },
        ];
        const skip = (Number(page) - 1) * Number(limit);

        const [result] = await User.aggregate([
            { $match: matchFilter },
            { $sort: { name: 1 } },
            { $facet: {
                data: [
                    { $skip: skip },
                    { $limit: Number(limit) },
                    { $lookup: { from: 'studentprofiles', localField: '_id', foreignField: 'user', as: '_p' } },
                    { $addFields: { _p: { $arrayElemAt: ['$_p', 0] } } },
                    { $addFields: {
                        rollNumber:      '$_p.rollNumber',
                        gender:          '$_p.gender',
                        currentSection:  '$_p.currentSection',
                        currentClass:    '$_p.currentClass',
                    }},
                    { $lookup: { from: 'classsections', localField: 'currentSection', foreignField: '_id', as: '_sec' } },
                    { $addFields: { _sec: { $arrayElemAt: ['$_sec', 0] } } },
                    { $lookup: { from: 'classes', localField: '_sec.class', foreignField: '_id', as: '_cls' } },
                    // Students with a class but no section yet still show their class
                    { $lookup: { from: 'classes', localField: 'currentClass', foreignField: '_id', as: '_ownCls' } },
                    { $addFields: {
                        sectionName: '$_sec.sectionName',
                        className:   { $ifNull: [
                            { $arrayElemAt: ['$_cls.className', 0] },
                            { $arrayElemAt: ['$_ownCls.className', 0] },
                        ] },
                    }},
                    { $project: { _p: 0, _sec: 0, _cls: 0, _ownCls: 0 } },
                ],
                total: [{ $count: 'n' }],
            }},
        ]);

        const students = result?.data || [];
        const total    = result?.total?.[0]?.n || 0;
        res.json({ success: true, data: { data: students, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
    } catch (err) { jsonErr(res, err); }
};

exports.getTeacherDetail = async (req, res) => {
    try {
        const user    = await User.findById(req.params.id).lean();
        const profile = await TeacherProfile.findOne({ user: req.params.id }).lean();
        jsonOk(res, { user, profile });
    } catch (err) { jsonErr(res, err); }
};

exports.getStudentDetail = async (req, res) => {
    try {
        const user    = await User.findById(req.params.id).lean();
        const profile = await StudentProfile.findOne({ user: req.params.id })
            .populate('parent', 'name email phone')
            .populate({ path: 'currentSection', select: 'sectionName class', populate: { path: 'class', select: 'className classNumber' } })
            .lean();
        // The edit wizard prefills the father / mother / guardian blocks from here
        const parentProfile = profile?.parent
            ? await ParentProfile.findOne({ user: profile.parent._id || profile.parent }).lean()
            : null;
        jsonOk(res, { user, profile, parentProfile });
    } catch (err) { jsonErr(res, err); }
};

exports.updateStudentFull = async (req, res) => {
    try {
        // Same dual shape as createStudent: a multipart edit sends `profile` as
        // a JSON string plus any replacement uploads; older callers post the
        // profile fields flat on the body.
        const uploads     = uploadedNames(req.files);
        const sentProfile = parseMaybeJson(req.body.profile);
        const b           = sentProfile ? { ...req.body, ...sentProfile } : req.body;
        const newParent   = parseMaybeJson(req.body.newParent);
        // An omitted parentId leaves the link alone; an empty one unlinks.
        const parentId    = req.body.parentId;
        const { name, phone, password, rollNumber, admissionNumber, currentClass, currentSection } = b;

        // Update User fields
        const userUpdate = {};
        if (name  !== undefined) userUpdate.name  = name;
        if (phone !== undefined) userUpdate.phone = phone;
        // Only a freshly uploaded photo replaces the avatar — an edit that
        // leaves the photo alone must not clobber one the student set themselves
        if (uploads.photo) userUpdate.profileImage = `/uploads/student-docs/${uploads.photo}`;
        if (phone && !/^[+\d\s\-]{7,15}$/.test(phone))
            return res.status(400).json({ success: false, message: 'Invalid phone number' });
        const rollValue = rollNumber !== undefined ? String(rollNumber).trim() : undefined;
        if (rollValue) {
            const sectionId = currentSection !== undefined
                ? currentSection
                : (await StudentProfile.findOne({ user: req.params.id }, 'currentSection').lean())?.currentSection;
            if (sectionId) {
                const takenBy = await rollNumberTaken(sectionId, rollValue, req.params.id);
                if (takenBy) return res.status(400).json({ success: false, message: `Roll number ${rollValue} is already used by ${takenBy} in this section.` });
            }
        }
        // Only the profile fields actually submitted are checked, so partial
        // updates from other screens still work.
        const existing = await StudentProfile.findOne({ user: req.params.id }).lean();
        const sentFields = Object.fromEntries(
            STUDENT_PROFILE_KEYS.filter(k => b[k] !== undefined).map(k => [k, b[k]]),
        );
        const profileErr = validateStudentProfile(sentFields, { partial: true })
            // A document already on file counts as present, so an edit never
            // forces the admin to re-upload paperwork.
            || (sentProfile ? validateStudentDocs({ ...existing, ...sentFields }, uploads, existing) : null);
        if (profileErr) return res.status(400).json({ success: false, message: profileErr });
        if (password) {
            if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
            userUpdate.password = await bcrypt.hash(password, 12);
        }
        if (currentSection !== undefined && currentSection) {
            const full = await capacityErrorById(currentSection, req.params.id);
            if (full) return res.status(400).json({ success: false, message: full });
        }
        const user = await User.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, userUpdate, { new: true });
        if (!user) return res.status(404).json({ success: false, message: 'Student not found' });
        await authCache.invalidate(user._id);

        // Resolve parent
        let resolvedParentId = parentId !== undefined ? (parentId || null) : undefined;
        if (resolvedParentId === undefined && newParent) {
            const schoolName = req.user?.school?.name || 'School';
            // Documents already on the parent record survive an edit that does
            // not re-upload them.
            const existingParent = existing?.parent
                ? await ParentProfile.findOne({ user: existing.parent }).lean()
                : null;
            const { parentId: newId, error } = await resolveNewParent(newParent, {
                schoolId: req.schoolId, schoolName, uploads, existingBlocks: existingParent,
            });
            if (error) return res.status(400).json({ success: false, message: error });
            if (newId) resolvedParentId = newId;
        }

        // Update StudentProfile fields
        const profileUpdate = buildStudentProfile(sentFields, uploads);
        if (!sentProfile) {
            // Legacy flat body: only touch what was sent, and never let the
            // builder's defaults overwrite untouched columns.
            const fromUpload = new Set(Object.entries(STUDENT_FILE_MAP)
                .filter(([field]) => uploads[field]).map(([, key]) => key));
            for (const key of Object.keys(profileUpdate)) {
                if (sentFields[key] === undefined && !fromUpload.has(key)) delete profileUpdate[key];
            }
        }
        if (rollNumber      !== undefined) profileUpdate.rollNumber      = rollValue;
        if (admissionNumber !== undefined) {
            const adm = String(admissionNumber).trim();
            if (adm) {
                const admTaken = await StudentProfile.findOne({
                    school: req.schoolId, admissionNumber: adm, user: { $ne: req.params.id },
                }).lean();
                if (admTaken) return res.status(400).json({ success: false, message: `Admission number ${adm} is already in use.` });
            }
            profileUpdate.admissionNumber = adm;
        }
        if (profileUpdate.dob !== undefined) profileUpdate.dob = profileUpdate.dob || null;
        if (resolvedParentId !== undefined) profileUpdate.parent         = resolvedParentId;
        if (currentSection  !== undefined) profileUpdate.currentSection  = currentSection || null;
        if (currentClass    !== undefined) profileUpdate.currentClass    = currentClass || null;
        // Keep the class in step when only a section is sent
        if (currentClass === undefined && currentSection) {
            const sec = await ClassSection.findOne({ _id: currentSection, school: req.schoolId }, 'class').lean();
            if (sec?.class) profileUpdate.currentClass = sec.class;
        }

        await StudentProfile.findOneAndUpdate({ user: req.params.id }, profileUpdate, { upsert: true });
        if (resolvedParentId) {
            await ParentProfile.findOneAndUpdate(
                { user: resolvedParentId },
                { $setOnInsert: { school: req.schoolId }, $addToSet: { children: req.params.id } },
                { upsert: true }
            );
        }

        jsonOk(res, user);
    } catch (err) { jsonErr(res, err); }
};

exports.getUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id).lean();
        if (!user) return res.status(404).json({ success: false, message: 'Not found' });
        jsonOk(res, user);
    } catch (err) { jsonErr(res, err); }
};

exports.updateUser = async (req, res) => {
    try {
        const { password, role, school, email, designation, ...allowed } = req.body;
        if (password) {
            if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
            allowed.password = await bcrypt.hash(password, 12);
        }
        if (allowed.phone && !/^[+\d\s\-]{7,15}$/.test(allowed.phone))
            return res.status(400).json({ success: false, message: 'Invalid phone number' });
        const user = await User.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            allowed,
            { new: true },
        );
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        await authCache.invalidate(user._id);
        // designation lives on TeacherProfile — it decides which module
        // permissions this teacher inherits, so the cached resolution has to go.
        if (designation !== undefined && user.role === 'teacher') {
            await TeacherProfile.findOneAndUpdate(
                { user: user._id },
                { $set: { designation: designation || '' }, $setOnInsert: { school: req.schoolId } },
                { upsert: true }
            );
            await designationSvc.invalidateUser(user._id);
        }
        jsonOk(res, user);
    } catch (err) { jsonErr(res, err); }
};

exports.toggleUser = async (req, res) => {
    try {
        const user = await User.findOne({ _id: req.params.id, school: req.schoolId });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        user.isActive = !user.isActive;
        await user.save();
        await authCache.invalidate(user._id);
        jsonOk(res, user);
    } catch (err) { jsonErr(res, err); }
};

const createUserHelper = async (body, role, school) => {
    const hashed = await bcrypt.hash(body.password, 12);
    return User.create({ ...body, email: body.email.toLowerCase(), role, school, password: hashed, isFirstLogin: true });
};

// ── Teacher intake ────────────────────────────────────────────────────────────

/**
 * Validate the teacher payload; returns the first problem, or null.
 *
 * `requireDocuments: false` keeps every other rule but drops the upload checks.
 * That is what the Excel importer needs: a spreadsheet cannot carry the Aadhaar,
 * PAN or experience scans, and those are the ONLY rules it is excused from.
 */
function validateTeacherIntake(b, files = {}, { requireDocuments = true } = {}) {
    const req = (value, label) => (!String(value ?? '').trim() ? `${label} is required` : null);
    // A sentinel keeps every `if (!file(...))` check below satisfied when the
    // caller has no uploads to offer.
    const file = (key) => (requireDocuments ? files[key]?.[0]?.filename || '' : 'not-required');

    // 1. Personal
    let e = req(b.name, 'Full name')
        || req(b.dob, 'Date of birth')
        || req(b.gender, 'Gender')
        || req(b.bloodGroup, 'Blood group')
        || req(b.fatherOrHusbandName, "Father's / husband's name")
        || req(b.emergencyContactName, 'Emergency contact name')
        || req(b.emergencyContactPhone, 'Emergency contact phone');
    if (e) return e;
    if (b.dob && Number.isNaN(new Date(b.dob).getTime())) return 'Invalid date of birth';
    if (!isPhone(b.emergencyContactPhone)) return 'Emergency contact phone is not valid';

    // 2. Contact
    e = req(b.phone, 'Mobile number')
        || req(b.email, 'Email address');
    if (e) return e;
    if (!isPhone(b.phone)) return 'Mobile number is not valid';
    if (b.alternatePhone && !isPhone(b.alternatePhone)) return 'Secondary phone number is not valid';
    if (!isEmail(b.email)) return 'Email address is not valid';

    // Addresses use the same street / PIN / city / state shape as student intake
    const addressError = (prefix, label) => {
        const err = req(b[`${prefix}Address`], `${label} address`)
            || req(b[`${prefix}Pincode`], `${label} PIN code`)
            || req(b[`${prefix}City`],    `${label} city`)
            || req(b[`${prefix}State`],   `${label} state`);
        if (err) return err;
        if (!isPincode(b[`${prefix}Pincode`])) return `${label} PIN code must be 6 digits`;
        if (!STATES_AND_UTS.includes(String(b[`${prefix}State`]).trim()))
            return `${label} state is not a valid Indian state or union territory`;
        return null;
    };
    e = addressError('current', 'Current residential');
    if (e) return e;
    if (!isTrue(b.sameAsCurrent)) {
        e = addressError('permanent', 'Permanent home');
        if (e) return e;
    }

    // 3. Government ID & tax
    e = req(b.aadhaarNumber, 'Aadhaar number') || req(b.panNumber, 'PAN number');
    if (e) return e;
    if (!AADHAAR_RE.test(String(b.aadhaarNumber).replace(/\s/g, ''))) return 'Aadhaar number must be 12 digits';
    if (!PAN_RE.test(String(b.panNumber).trim())) return 'PAN number looks invalid (e.g. ABCDE1234F)';
    if (!file('aadhaarFront')) return 'Aadhaar card front image is required';
    if (!file('aadhaarBack'))  return 'Aadhaar card back image is required';
    if (!file('panCard'))      return 'PAN card upload is required';

    // 4. Education — "Other" swaps in a free-text value, which is then required
    const qualification = b.qualification === 'Other' ? b.qualificationOther : b.qualification;
    if (!String(qualification ?? '').trim())
        return b.qualification === 'Other' ? 'Please type the other qualification' : 'Highest qualification is required';
    if (b.teachingDegree === 'Other' && !String(b.teachingDegreeOther ?? '').trim())
        return 'Please type the other teaching degree';

    // 5. Work experience
    if (!['fresher', 'experienced'].includes(b.employmentType))
        return 'Select whether the teacher is a fresher or experienced';
    if (b.employmentType === 'experienced') {
        e = req(b.totalExperience, 'Total years of experience')
            || req(b.previousSchool, 'Name of previous school')
            || req(b.lastDesignation, 'Last job designation');
        if (e) return e;
        if (!file('resignationLetter')) return 'Resignation letter of the last company is required';
    }

    // 6. Bank
    e = req(b.bankAccountHolder, 'Bank account holder name')
        || req(b.bankAccountNumber, 'Bank account number')
        || req(b.bankIfsc, 'IFSC code')
        || req(b.bankBranch, 'Bank branch name');
    if (e) return e;
    if (!/^\d{6,20}$/.test(String(b.bankAccountNumber).replace(/\s/g, ''))) return 'Bank account number must be 6–20 digits';
    if (!IFSC_RE.test(String(b.bankIfsc).trim())) return 'IFSC code looks invalid (e.g. HDFC0001234)';

    // 7. School internal
    e = req(b.joiningDate, 'Date of joining');
    if (e) return e;
    if (Number.isNaN(new Date(b.joiningDate).getTime())) return 'Invalid date of joining';

    return null;
}

/** Map the validated payload + uploads onto the TeacherProfile shape. */
function buildTeacherProfile(b, files = {}) {
    const file = (key) => files[key]?.[0]?.filename || '';
    const pick = (value, other) => (value === 'Other' ? String(other || '').trim() : String(value || '').trim());

    return {
        designation:  b.designation || '',
        // Department drives the directory's grouping and its main filter, so the
        // intake form collects it rather than leaving it to a later edit.
        department:   String(b.department || '').trim(),
        dob:          b.dob ? new Date(b.dob) : null,
        gender:       b.gender || '',
        bloodGroup:   b.bloodGroup || '',
        fatherOrHusbandName:   String(b.fatherOrHusbandName || '').trim(),
        emergencyContactName:  String(b.emergencyContactName || '').trim(),
        emergencyContactPhone: String(b.emergencyContactPhone || '').trim(),

        alternatePhone:   String(b.alternatePhone || '').trim(),
        currentAddress:   String(b.currentAddress || '').trim(),
        currentCity:      String(b.currentCity    || '').trim(),
        currentState:     String(b.currentState   || '').trim(),
        currentPincode:   String(b.currentPincode || '').trim(),
        currentCountry:   String(b.currentCountry || 'India').trim(),
        // "Same as current" copies the whole block, not just the street line
        ...(isTrue(b.sameAsCurrent) ? {
            permanentAddress: String(b.currentAddress || '').trim(),
            permanentCity:    String(b.currentCity    || '').trim(),
            permanentState:   String(b.currentState   || '').trim(),
            permanentPincode: String(b.currentPincode || '').trim(),
            permanentCountry: String(b.currentCountry || 'India').trim(),
        } : {
            permanentAddress: String(b.permanentAddress || '').trim(),
            permanentCity:    String(b.permanentCity    || '').trim(),
            permanentState:   String(b.permanentState   || '').trim(),
            permanentPincode: String(b.permanentPincode || '').trim(),
            permanentCountry: String(b.permanentCountry || 'India').trim(),
        }),

        aadhaarNumber:    String(b.aadhaarNumber || '').replace(/\s/g, ''),
        aadhaarFrontFile: file('aadhaarFront'),
        aadhaarBackFile:  file('aadhaarBack'),
        panNumber:        String(b.panNumber || '').trim().toUpperCase(),
        panCardFile:      file('panCard'),
        uanNumber:        String(b.uanNumber || '').trim(),

        qualification:  pick(b.qualification, b.qualificationOther),
        teachingDegree: pick(b.teachingDegree, b.teachingDegreeOther),

        employmentType:  b.employmentType,
        totalExperience: b.employmentType === 'experienced' ? String(b.totalExperience || '').trim() : '',
        previousSchool:  b.employmentType === 'experienced' ? String(b.previousSchool || '').trim()  : '',
        lastDesignation: b.employmentType === 'experienced' ? String(b.lastDesignation || '').trim() : '',
        // Legacy free-text field kept in step with the structured answer
        experience: b.employmentType === 'experienced' ? String(b.totalExperience || '').trim() : 'Fresher',
        experienceCertificateFile: file('experienceCertificate'),
        resignationLetterFile:     file('resignationLetter'),
        joiningLetterFile:         file('joiningLetter'),

        bankAccountHolder: String(b.bankAccountHolder || '').trim(),
        bankAccountNumber: String(b.bankAccountNumber || '').replace(/\s/g, ''),
        bankIfsc:          String(b.bankIfsc || '').trim().toUpperCase(),
        bankBranch:        String(b.bankBranch || '').trim(),

        joiningDate: b.joiningDate ? new Date(b.joiningDate) : null,
    };
}

// Profile keys whose value is derived from more than one posted field. Anything
// not listed here is fed by the field of the same name.
const TEACHER_FIELD_SOURCES = {
    qualification:   ['qualification', 'qualificationOther'],
    teachingDegree:  ['teachingDegree', 'teachingDegreeOther'],
    experience:      ['employmentType', 'totalExperience'],
    totalExperience: ['employmentType', 'totalExperience'],
    previousSchool:  ['employmentType', 'previousSchool'],
    lastDesignation: ['employmentType', 'lastDesignation'],
    permanentAddress: ['permanentAddress', 'sameAsCurrent'],
    permanentCity:    ['permanentCity', 'sameAsCurrent'],
    permanentState:   ['permanentState', 'sameAsCurrent'],
    permanentPincode: ['permanentPincode', 'sameAsCurrent'],
    permanentCountry: ['permanentCountry', 'sameAsCurrent'],
};

const TEACHER_FILE_FIELDS = [
    'aadhaarFrontFile', 'aadhaarBackFile', 'panCardFile',
    'experienceCertificateFile', 'resignationLetterFile', 'joiningLetterFile',
];
const TEACHER_FILE_BY_INPUT = {
    aadhaarFront: 'aadhaarFrontFile', aadhaarBack: 'aadhaarBackFile', panCard: 'panCardFile',
    experienceCertificate: 'experienceCertificateFile', resignationLetter: 'resignationLetterFile',
    joiningLetter: 'joiningLetterFile',
};
/**
 * Drop every key the payload did not actually feed. buildTeacherProfile fills
 * each field with a default, so writing it wholesale on a partial update would
 * blank whatever the caller left out — an edit that only corrects a phone
 * number, or an import sheet that only carries some of the columns.
 */
function pruneUnsuppliedTeacherFields(built, b) {
    for (const key of Object.keys(built)) {
        if (TEACHER_FILE_FIELDS.includes(key)) continue;
        const feeds = TEACHER_FIELD_SOURCES[key] || [key];
        if (!feeds.some((f) => b[f] !== undefined)) delete built[key];
    }
    return built;
}

/** Files already on the profile, shaped like multer's req.files. */
function fileStubsFor(profile) {
    const out = {};
    if (!profile) return out;
    for (const [input, field] of Object.entries(TEACHER_FILE_BY_INPUT)) {
        if (profile[field]) out[input] = [{ filename: profile[field] }];
    }
    return out;
}

exports.createTeacher = async (req, res) => {
    try {
        const b     = req.body;
        const files = req.files || {};
        const { name, email, phone, designation } = b;

        const problem = validateTeacherIntake(b, files);
        if (problem) return res.status(400).json({ success: false, message: problem });

        const exists = await User.findOne({ email: String(email).toLowerCase() });
        if (exists) return res.status(400).json({ success: false, message: 'Email already registered' });

        // Employee ID: use what was typed, else generate from the school's format
        const schoolDoc = await School.findById(req.schoolId).select('name code employeeIdFormat').lean();
        const typedId   = String(b.employeeId || '').trim();
        let employeeId  = typedId;
        if (typedId) {
            const idTaken = await TeacherProfile.findOne({ school: req.schoolId, employeeId: typedId }).lean();
            if (idTaken) return res.status(400).json({ success: false, message: `Employee ID ${typedId} is already in use.` });
        } else {
            employeeId = await employeeIdUtil.nextEmployeeId(schoolDoc || { _id: req.schoolId });
        }

        const otp  = generateOTP();
        const user = await createUserHelper({ name, email, phone, designation, password: otp }, 'teacher', req.schoolId);
        await TeacherProfile.create({
            user: user._id,
            school: req.schoolId,
            employeeId,
            ...buildTeacherProfile(b, files),
        });

        const schoolName = req.user?.school?.name || 'School';
        sendWelcomeEmail(email, name, email, otp, schoolName, req.schoolId);
        jsonOk(res, { ...user.toObject?.() ?? user, employeeId }, 201);
    } catch (err) { jsonErr(res, err, 400); }
};

/**
 * PUT /admin/teachers/:id — the full teacher record, edited with the same form
 * that created it.
 *
 * The edit is PARTIAL by design: only the fields the request actually sent are
 * written, and a document already on file counts as present. That is what lets
 * the wizard reopen on an existing teacher without forcing the admin to
 * re-upload paperwork just to correct a phone number.
 */
exports.updateTeacherFull = async (req, res) => {
    try {
        const b     = req.body;
        const files = req.files || {};

        const user = await User.findOne({ _id: req.params.id, school: req.schoolId, role: 'teacher' });
        if (!user) return res.status(404).json({ success: false, message: 'Teacher not found' });
        const existing = await TeacherProfile.findOne({ user: user._id, school: req.schoolId }).lean();

        // Validated against the merged record, so paperwork already on file
        // satisfies the intake rules.
        const problem = validateTeacherIntake(
            { ...(existing || {}), ...b },
            { ...fileStubsFor(existing), ...files },
        );
        if (problem) return res.status(400).json({ success: false, message: problem });

        if (b.email && String(b.email).toLowerCase() !== String(user.email).toLowerCase()) {
            const taken = await User.findOne({ email: String(b.email).toLowerCase() }).lean();
            if (taken) return res.status(400).json({ success: false, message: 'Email already registered' });
        }

        const typedId = String(b.employeeId ?? '').trim();
        if (typedId && typedId !== (existing?.employeeId || '')) {
            const idTaken = await TeacherProfile.findOne({ school: req.schoolId, employeeId: typedId }).lean();
            if (idTaken) return res.status(400).json({ success: false, message: `Employee ID ${typedId} is already in use.` });
        }

        const userUpdate = {};
        if (b.name  !== undefined) userUpdate.name  = String(b.name).trim();
        if (b.phone !== undefined) userUpdate.phone = String(b.phone).trim();
        if (b.email !== undefined) userUpdate.email = String(b.email).toLowerCase().trim();
        if (b.password) {
            if (String(b.password).length < 6)
                return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
            userUpdate.password = await bcrypt.hash(b.password, 12);
        }
        if (Object.keys(userUpdate).length) {
            await User.findByIdAndUpdate(user._id, userUpdate);
            await authCache.invalidate(user._id);
        }

        // A blank upload must not wipe the file already on record.
        const built = buildTeacherProfile(b, files);
        for (const key of TEACHER_FILE_FIELDS) {
            if (!built[key] && existing?.[key]) built[key] = existing[key];
        }
        // ...and neither must an omitted field.
        pruneUnsuppliedTeacherFields(built, b);
        if (typedId) built.employeeId = typedId;

        await TeacherProfile.findOneAndUpdate(
            { user: user._id, school: req.schoolId },
            { $set: built, $setOnInsert: { user: user._id, school: req.schoolId } },
            { upsert: true },
        );
        // The designation decides which modules this teacher reaches.
        if (built.designation !== (existing?.designation || '')) {
            await designationSvc.invalidateUser(user._id);
        }
        jsonOk(res, { _id: String(user._id) });
    } catch (err) { jsonErr(res, err, 400); }
};

exports.createStudent = async (req, res) => {
    try {
        // Multipart posts send `profile` / `newParent` as JSON strings alongside
        // the uploads; a plain JSON body sends them as objects.
        const { name, email, phone } = req.body;
        const uploads   = uploadedNames(req.files);
        const profile   = parseMaybeJson(req.body.profile) || {};
        const newParent = parseMaybeJson(req.body.newParent);
        const parentId  = req.body.parentId || null;
        if (!name?.trim())  return res.status(400).json({ success: false, message: 'Full name is required' });
        if (!email?.trim()) return res.status(400).json({ success: false, message: 'Email is required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: 'Invalid email format' });
        if (phone && !/^[+\d\s\-]{7,15}$/.test(phone)) return res.status(400).json({ success: false, message: 'Invalid phone number' });
        // Class is required; the section can be assigned later. A section on its
        // own is still accepted (mobile + bulk import) — the class is derived.
        let classId = profile.currentClass || null;
        if (!classId && profile.currentSection) {
            const sec = await ClassSection.findOne({ _id: profile.currentSection, school: req.schoolId }, 'class').lean();
            classId = sec?.class || null;
        }
        if (!classId) return res.status(400).json({ success: false, message: 'Class is required' });
        profile.currentClass = classId;

        // Admission number: use what was typed, otherwise generate from the
        // school's configured format.
        const schoolDoc = await School.findById(req.schoolId).select('name code admissionNumberFormat').lean();
        const classDoc  = await Class.findById(classId).select('className classNumber').lean();
        const typedAdm  = String(profile.admissionNumber ?? '').trim();
        if (typedAdm) {
            const admTaken = await StudentProfile.findOne({ school: req.schoolId, admissionNumber: typedAdm }).lean();
            if (admTaken) return res.status(400).json({ success: false, message: `Admission number ${typedAdm} is already in use.` });
            profile.admissionNumber = typedAdm;
        } else {
            profile.admissionNumber = await admissionNo.nextAdmissionNumber(schoolDoc || { _id: req.schoolId }, classDoc);
        }

        // Roll number is optional at intake — sections assign them in bulk later
        const roll = String(profile.rollNumber ?? '').trim();
        if (roll && profile.currentSection) {
            const takenBy = await rollNumberTaken(profile.currentSection, roll);
            if (takenBy) return res.status(400).json({ success: false, message: `Roll number ${roll} is already used by ${takenBy} in this section.` });
        }
        const profileErr = validateStudentProfile(profile) || validateStudentDocs(profile, uploads);
        if (profileErr) return res.status(400).json({ success: false, message: profileErr });
        // A section that is already at capacity does not take another student.
        if (profile.currentSection) {
            const full = await capacityErrorById(profile.currentSection);
            if (full) return res.status(400).json({ success: false, message: full });
        }
        const exists = await User.findOne({ email: email.toLowerCase() });
        if (exists) return res.status(400).json({ success: false, message: 'Email already registered' });

        // Create (or link) the parent account before the student, so a bad
        // parent payload doesn't leave a student behind
        const schoolName = req.user?.school?.name || 'School';
        let resolvedParentId = parentId || null;
        if (!resolvedParentId) {
            const { parentId: newId, error } = await resolveNewParent(newParent, { schoolId: req.schoolId, schoolName, uploads });
            if (error) return res.status(400).json({ success: false, message: error });
            resolvedParentId = newId;
        }

        const otp = generateOTP();
        // The passport photo doubles as the account avatar
        const user = await createUserHelper(
            { name, email, phone, password: otp, ...(uploads.photo ? { profileImage: `/uploads/student-docs/${uploads.photo}` } : {}) },
            'student', req.schoolId,
        );
        const profileData = { user: user._id, school: req.schoolId, ...buildStudentProfile(profile, uploads) };
        if (resolvedParentId) profileData.parent = resolvedParentId;
        await StudentProfile.create(profileData);
        if (resolvedParentId) {
            await ParentProfile.findOneAndUpdate(
                { user: resolvedParentId },
                { $setOnInsert: { school: req.schoolId }, $addToSet: { children: user._id } },
                { upsert: true }
            );
        }
        sendWelcomeEmail(email, name, email, otp, schoolName, req.schoolId);
        jsonOk(res, user, 201);
    } catch (err) { jsonErr(res, err, 400); }
};

exports.createAdmin = async (req, res) => {
    try {
        const err = validate(req.body, {
            name:  { label: 'Full name', required: true, minLen: 2 },
            email: { label: 'Email', required: true, type: 'email' },
            phone: { label: 'Phone', type: 'phone' },
        });
        if (err) return res.status(400).json({ success: false, message: err });
        const exists = await User.findOne({ email: req.body.email.toLowerCase() });
        if (exists) return res.status(400).json({ success: false, message: 'Email already registered' });

        const otp = generateOTP();
        const user = await createUserHelper({ ...req.body, password: otp }, 'school_admin', req.schoolId);
        const schoolName = req.user?.school?.name || 'School';
        sendWelcomeEmail(req.body.email, req.body.name, req.body.email, otp, schoolName, req.schoolId);
        jsonOk(res, user, 201);
    } catch (err) { jsonErr(res, err, 400); }
};

exports.deleteUser = async (req, res) => {
    try {
        const userId = req.params.id;
        // Only allow deleting non-super-admin users belonging to this school
        const target = await User.findById(userId).select('_id role school').lean();
        if (!target || String(target.school) !== String(req.schoolId))
            return res.status(404).json({ success: false, message: 'User not found' });
        if (target.role === 'super_admin')
            return res.status(403).json({ success: false, message: 'Super admin accounts cannot be deleted' });
        if (String(target._id) === String(req.userId))
            return res.status(403).json({ success: false, message: 'You cannot delete your own account' });
        // Remove from all section enrollments
        const affectedSections = await ClassSection.find({ enrolledStudents: userId }, '_id').lean();
        if (affectedSections.length) {
            await ClassSection.updateMany(
                { enrolledStudents: userId },
                { $pull: { enrolledStudents: userId } }
            );
            // Recalculate currentCount for each affected section
            const updated = await ClassSection.find({ _id: { $in: affectedSections.map(s => s._id) } }, 'enrolledStudents').lean();
            const ops = updated.map(s => ({
                updateOne: { filter: { _id: s._id }, update: { $set: { currentCount: s.enrolledStudents.length } } },
            }));
            if (ops.length) await ClassSection.bulkWrite(ops);
        }
        await StudentProfile.deleteOne({ user: userId });
        await User.findByIdAndDelete(userId);
        await authCache.invalidate(userId);
        res.json({ success: true, message: 'User deleted' });
    } catch (err) { jsonErr(res, err); }
};

exports.bulkDeleteUsers = async (req, res) => {
    try {
        const reqIds = req.body.ids || [];
        // Restrict to this school's non-super-admin users, excluding the requester
        const deletable = await User.find({
            _id: { $in: reqIds, $ne: req.userId },
            school: req.schoolId,
            role: { $ne: 'super_admin' },
        }).select('_id').lean();
        const ids = deletable.map(u => String(u._id));
        const skipped = reqIds.length - ids.length;
        if (!ids.length) return res.json({
            success: true, deleted: 0, skipped,
            message: 'Selected accounts cannot be deleted',
        });
        // Remove all ids from section enrollments
        const affectedSections = await ClassSection.find({ enrolledStudents: { $in: ids } }, '_id').lean();
        if (affectedSections.length) {
            await ClassSection.updateMany(
                { enrolledStudents: { $in: ids } },
                { $pull: { enrolledStudents: { $in: ids } } }
            );
            const updated = await ClassSection.find({ _id: { $in: affectedSections.map(s => s._id) } }, 'enrolledStudents').lean();
            const ops = updated.map(s => ({
                updateOne: { filter: { _id: s._id }, update: { $set: { currentCount: s.enrolledStudents.length } } },
            }));
            if (ops.length) await ClassSection.bulkWrite(ops);
        }
        await StudentProfile.deleteMany({ user: { $in: ids } });
        await User.deleteMany({ _id: { $in: ids }, school: req.schoolId });
        await authCache.invalidateMany(ids);
        res.json({
            success: true,
            deleted: ids.length,
            skipped,
            message: skipped > 0
                ? `${ids.length} user(s) deleted · ${skipped} protected account(s) skipped`
                : `${ids.length} user(s) deleted`,
        });
    } catch (err) { jsonErr(res, err); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Bulk import.
//
//  Both sheets mirror the admin's own add-teacher and add-student wizards column
//  for column, so an imported account is as complete as a typed one. A row is
//  turned into exactly the payload that form posts and then run through the SAME
//  validators and profile builders — there is no second, looser rule set for
//  spreadsheets. The one thing a sheet cannot carry is an upload (ID scans,
//  certificates), so those checks are all that is switched off; the reference
//  sheet in each template says which paperwork still has to be attached by hand.
// ─────────────────────────────────────────────────────────────────────────────

// The intake forms' own dropdown lists. Kept here so the templates offer, and
// the importer accepts, precisely what an admin can pick in the wizard.
const BLOOD_GROUPS   = ['A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', 'O+', 'O−'];
const CATEGORIES     = ['General', 'OBC', 'SC', 'ST', 'EWS'];
const QUALIFICATIONS = ['B.A.', 'B.Sc.', 'B.Com.', 'M.A.', 'M.Sc.', 'M.Com.', 'B.Tech.', 'M.Tech.', 'Ph.D.'];
const TEACHING_DEGREES = ['B.Ed.', 'D.El.Ed.', 'M.Ed.', 'NTT'];
const SCHOOL_BOARDS  = ['CBSE', 'ICSE', 'State Board', 'IB', 'Cambridge (IGCSE)', 'NIOS', 'Other'];
const SCHOOL_MEDIUMS = ['English', 'Hindi', 'Marathi', 'Gujarati', 'Bengali', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Urdu', 'Other'];
const GENDERS        = ['Male', 'Female', 'Other'];

// Sheet dates arrive as dd/mm/yyyy text (the templates force the column to
// text so Excel cannot silently reformat them). Returns null on anything else,
// which the callers turn into a row error rather than a wrong date.
function parseSheetDate(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    const parts = value.replace(/-/g, '/').split('/');
    if (parts.length !== 3) return null;
    const [d, m, y] = parts;
    if (String(y).length !== 4) return null;
    const dt = new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * A dropdown value typed by hand. Matching is case-insensitive but what gets
 * stored is the form's own spelling, so "male" and "Male" do not become two
 * different genders. An unlisted value is kept as typed — that is how the
 * wizard's "Other → type it in" fields behave.
 */
const matchOption = (raw, options) => {
    const typed = String(raw ?? '').trim();
    return options.find((o) => o.toLowerCase() === typed.toLowerCase()) || typed;
};

// Excel users type an ASCII hyphen ("B-"); the dropdowns emit a Unicode minus
// ("B−"). Both have to land on the same value or one blood group is stored two
// different ways depending on how the record was created.
const normalizeBloodGroup = (raw) => {
    const typed = String(raw ?? '').trim();
    const ascii = typed.replace(/[−–—]/g, '-').toLowerCase();
    return BLOOD_GROUPS.find((g) => g.replace(/−/g, '-').toLowerCase() === ascii) || typed;
};

// A spreadsheet has no checkbox, so the yes/no columns are read as text.
const sheetBool = (raw) => ['yes', 'y', 'true', '1'].includes(String(raw ?? '').trim().toLowerCase());

/**
 * Column reader for one sheet row. Headers are matched case- and
 * space-insensitively, and every field also accepts the shorter headers of the
 * earlier templates, so a sheet a school has already filled in still imports.
 * Returns '' for a column that is blank or absent.
 */
function sheetRow(raw) {
    const cells = {};
    Object.keys(raw).forEach((k) => { cells[k.trim().toLowerCase()] = String(raw[k] ?? '').trim(); });
    return (...aliases) => {
        for (const alias of aliases) {
            if (cells[alias]) return cells[alias];
        }
        return '';
    };
}

// A whole sheet can fail on one missing column, and the report rides back inside
// the JSON/SSE response rather than costing a second round trip. That only stays
// cheap if it is bounded: a student row is 76 columns, so ~200 of them is already
// around half a megabyte of base64. Past that the sheet itself is the thing to
// fix, and the "How to fix" page says so.
const MAX_ERROR_ROWS = 200;

/**
 * The rows that did NOT import, handed back as a workbook to correct.
 *
 * It is the admin's own sheet, filtered to the failed rows, with the row number
 * and the reason added in front. Because the importers look columns up by name
 * and ignore the ones they do not recognise, this file is itself a valid import
 * sheet: fix what the Error column names, upload this same file, done. Rows that
 * imported are absent from it, so a re-upload cannot duplicate them.
 *
 * @param {String[]} headers  the header row of the uploaded sheet, in order
 * @param {Array}    failures [{ row, reason, raw }] — `raw` is the original row
 * @returns {{ filename, base64, rows, total }|null}
 */
function buildErrorReport(headers, failures, filename) {
    if (!failures.length) return null;
    const shown = failures.slice(0, MAX_ERROR_ROWS);
    const cols  = ['Row', 'Error', ...headers];
    const body  = shown.map((f) => [
        f.row,
        f.reason,
        ...headers.map((h) => {
            const v = f.raw?.[h];
            return v === undefined || v === null ? '' : String(v);
        }),
    ]);

    const ws = XLSX.utils.aoa_to_sheet([cols, ...body]);
    // Every column but the row number goes back as text: these cells are the
    // admin's own, and Excel must not "helpfully" re-read a PIN code or a
    // dd/mm/yyyy date on the way out and back in again.
    forceTextColumns(ws, cols.map((_, i) => i).slice(1), body.length);
    ws['!cols'] = [
        { wch: 6 }, { wch: 58 },
        ...headers.map((h) => ({ wch: Math.max(12, Math.min(30, String(h).length + 4)) })),
    ];

    const guide = [
        ['How to fix these rows'],
        [],
        ['1.', 'The Error column says what stopped each row.'],
        ['2.', 'Correct the cells it names — everything else is exactly as you uploaded it.'],
        ['3.', 'Upload this same file again. Row and Error are ignored by the importer.'],
        [],
        ['Only the rows that failed are in this file, so re-uploading cannot'],
        ['duplicate the ones that already imported.'],
    ];
    if (failures.length > shown.length) {
        guide.push(
            [],
            [`${failures.length} rows failed — the first ${shown.length} are listed here.`],
            ['That many failures usually means one thing is wrong across the whole sheet.'],
            ['Fix it in your original file and upload that again, rather than working from this one.'],
        );
    }
    const guideWs = XLSX.utils.aoa_to_sheet(guide);
    guideWs['!cols'] = [{ wch: 4 }, { wch: 78 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Errors');
    XLSX.utils.book_append_sheet(wb, guideWs, 'How to fix');

    return {
        filename,
        base64: XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }),
        rows:   shown.length,
        total:  failures.length,
    };
}

/**
 * Keep only the columns the row actually filled in. A blank optional cell then
 * means "leave whatever is on file alone" rather than "erase it", which is what
 * makes a corrected sheet safe to re-upload. Blank REQUIRED cells still fail,
 * because the shared validators run on the pruned object.
 */
const suppliedOnly = (obj) => Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== '' && v !== null && v !== undefined),
);

exports.bulkTeachers = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        const schoolName = req.user?.school?.name || 'School';
        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows  = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        // The header row verbatim, so a failed row can be handed back in the
        // admin's own column order rather than a guessed one.
        const headerRow = (XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })[0] || [])
            .map((h) => String(h).trim());
        // Needed once for the employee-ID format, not per row.
        const bulkSchoolDoc = await School.findById(req.schoolId).select('name code employeeIdFormat').lean();

        let created = 0;
        let updated = 0;
        const errors = [];
        // The same failures, each still carrying the row it came from, so they
        // can be written back out as a sheet to correct.
        const failures = [];
        for (let i = 0; i < rows.length; i++) {
            const rowNum = i + 2;
            const cell   = sheetRow(rows[i]);

            const name  = cell('full name', 'name');
            const email = cell('email address', 'email').toLowerCase();
            const fail  = (reason) => {
                errors.push({ row: rowNum, name: name || '?', reason });
                failures.push({ row: rowNum, reason, raw: rows[i] });
            };

            // Dates are dd/mm/yyyy. They are parsed here rather than left to the
            // shared validator, which would hand the string to `new Date` and
            // read 04/12/1990 as the fourth of December.
            const dobRaw  = cell('date of birth', 'dob');
            const joinRaw = cell('date of joining', 'joining date', 'joiningdate');
            const dob     = parseSheetDate(dobRaw);
            const joining = parseSheetDate(joinRaw);
            if (dobRaw  && !dob)     { fail('Invalid Date of Birth (use dd/mm/yyyy)'); continue; }
            if (joinRaw && !joining) { fail('Invalid Date of Joining (use dd/mm/yyyy)'); continue; }

            const employeeId = cell('employee id', 'employeeid');
            // The row, shaped exactly like the seven-step wizard's POST body.
            const b = {
                ...suppliedOnly({
                    name,
                    email,
                    dob,
                    gender:     matchOption(cell('gender'), GENDERS),
                    bloodGroup: normalizeBloodGroup(cell('blood group', 'bloodgroup')),
                    fatherOrHusbandName:   cell("father's / husband's name", 'father / husband name', "father's name", 'father name'),
                    emergencyContactName:  cell('emergency contact name'),
                    emergencyContactPhone: cell('emergency contact phone'),

                    phone:          cell('phone number', 'mobile number', 'phone'),
                    alternatePhone: cell('alternate phone', 'secondary phone'),
                    currentAddress: cell('current address', 'address'),
                    currentCity:    cell('current city', 'city'),
                    currentState:   matchOption(cell('current state', 'state'), STATES_AND_UTS),
                    currentPincode: cell('current pincode', 'current pin code', 'pincode'),
                    currentCountry: cell('current country', 'country') || 'India',
                    permanentAddress: cell('permanent address'),
                    permanentCity:    cell('permanent city'),
                    permanentState:   matchOption(cell('permanent state'), STATES_AND_UTS),
                    permanentPincode: cell('permanent pincode', 'permanent pin code'),
                    permanentCountry: cell('permanent country') || 'India',

                    aadhaarNumber: cell('aadhaar number', 'aadhar number'),
                    panNumber:     cell('pan number'),
                    uanNumber:     cell('uan number'),

                    qualification:  matchOption(cell('qualification'), QUALIFICATIONS),
                    teachingDegree: matchOption(cell('teaching degree', 'teachingdegree'), TEACHING_DEGREES),

                    totalExperience: cell('total experience', 'experience'),
                    previousSchool:  cell('previous school'),
                    lastDesignation: cell('last designation'),

                    bankAccountHolder: cell('bank account holder', 'bank account holder name'),
                    bankAccountNumber: cell('bank account number'),
                    bankIfsc:          cell('ifsc code', 'bank ifsc'),
                    bankBranch:        cell('bank branch', 'bank branch name'),

                    joiningDate: joining,
                    designation: cell('designation'),
                    department:  cell('department'),
                }),
                // These two decide what other fields mean, so they are always
                // present: blank reads as "no" / "unanswered", never as
                // "leave the stored value alone".
                sameAsCurrent:  sheetBool(cell('permanent same as current', 'same as current')),
                employmentType: matchOption(cell('employment type'), ['fresher', 'experienced']).toLowerCase(),
            };

            // Every rule the add-teacher form enforces, minus the uploads.
            const problem = validateTeacherIntake(b, {}, { requireDocuments: false });
            if (problem) { fail(problem); continue; }

            // Only the columns this row filled in are written, so re-uploading a
            // partial sheet never blanks what is already on file — and the ID
            // scans, which no sheet can carry, are never touched at all.
            const profileFields = buildTeacherProfile(b, {});
            for (const key of TEACHER_FILE_FIELDS) delete profileFields[key];
            pruneUnsuppliedTeacherFields(profileFields, b);

            try {
                const exists = await User.findOne({ email }).lean();
                if (exists) {
                    // Re-uploading a sheet updates the existing teacher rather
                    // than failing the row. Other roles are never overwritten.
                    if (exists.role !== 'teacher' || String(exists.school) !== String(req.schoolId)) {
                        fail(`Email "${email}" belongs to another account`);
                        continue;
                    }
                    const current = await TeacherProfile.findOne({ user: exists._id }).lean();
                    // A typed employee ID may be a correction, but it must not
                    // collide with one another teacher already holds.
                    if (employeeId && employeeId !== (current?.employeeId || '')) {
                        const taken = await TeacherProfile.findOne({ school: req.schoolId, employeeId }).lean();
                        if (taken) { fail(`Employee ID "${employeeId}" is already in use`); continue; }
                        profileFields.employeeId = employeeId;
                    }
                    await User.updateOne({ _id: exists._id }, { $set: { name, ...(b.phone ? { phone: b.phone } : {}) } });
                    await authCache.invalidate(exists._id);
                    await TeacherProfile.findOneAndUpdate(
                        { user: exists._id },
                        { $set: profileFields, $setOnInsert: { school: req.schoolId } },
                        { upsert: true },
                    );
                    // The designation decides which modules this teacher reaches.
                    if (profileFields.designation !== undefined
                        && profileFields.designation !== (current?.designation || '')) {
                        await designationSvc.invalidateUser(exists._id);
                    }
                    updated++;
                    continue;
                }
                // An employee ID is part of the employee record, so a bulk-created
                // teacher gets one the same way the add-teacher form does —
                // typed if supplied, otherwise generated from the school's format.
                let resolvedId = employeeId;
                if (resolvedId) {
                    const taken = await TeacherProfile.findOne({ school: req.schoolId, employeeId: resolvedId }).lean();
                    if (taken) { fail(`Employee ID "${resolvedId}" is already in use`); continue; }
                } else {
                    resolvedId = await employeeIdUtil.nextEmployeeId(bulkSchoolDoc || { _id: req.schoolId });
                }
                const otp  = generateOTP();
                const user = await createUserHelper(
                    { name, email, phone: b.phone, designation: b.designation, password: otp },
                    'teacher', req.schoolId,
                );
                await TeacherProfile.create({
                    user: user._id, school: req.schoolId, employeeId: resolvedId, ...profileFields,
                });
                sendWelcomeEmail(email, name, email, otp, schoolName, req.schoolId);
                created++;
            } catch (e) {
                fail(e.code === 11000 ? 'Duplicate entry' : e.message);
            }
        }
        res.json({
            success: true, created, updated, errors,
            errorFile: buildErrorReport(headerRow, failures, 'teacher-import-errors.xlsx'),
        });
    } catch (err) { jsonErr(res, err); }
};

exports.bulkStudents = async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    // Stream progress via SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const push = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); if (res.flush) res.flush(); };

    try {
        const schoolName = req.user?.school?.name || 'School';
        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows  = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const headerRow = (XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })[0] || [])
            .map((h) => String(h).trim());

        push({ type: 'total', total: rows.length });

        const bulkSchool = await School.findById(req.schoolId).select('name code admissionNumberFormat').lean();
        const activeYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        const classes    = await Class.find({ school: req.schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}) }).lean();
        const sections   = await ClassSection.find({ school: req.schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}) }).lean();
        const classMap   = {};
        classes.forEach(c => { classMap[c.className.toLowerCase()] = c; });
        const sectionMap = {};
        sections.forEach(s => { sectionMap[`${s.class.toString()}_${s.sectionName.toLowerCase()}`] = s; });

        let created = 0;
        let updated = 0;
        const errors = [];
        // The same failures, each still carrying the row it came from, so they
        // can be written back out as a sheet to correct.
        const failures = [];
        // sectionId -> live set of student ids seated there during this import.
        const rosterBySection = new Map();

        for (let i = 0; i < rows.length; i++) {
            const rowNum = i + 2;
            const cell   = sheetRow(rows[i]);

            const name        = cell('full name', 'name');
            const email       = cell('email address', 'email').toLowerCase();
            const phone       = cell('phone number', 'mobile number', 'phone');
            const className   = cell('class');
            const sectionName = cell('section');
            const admNo       = cell('admission number', 'admissionnumber');
            const rollNumber  = cell('roll number', 'rollnumber');

            push({ type: 'processing', current: i + 1, total: rows.length, name: name || `Row ${rowNum}` });

            const fail = (reason) => {
                errors.push({ row: rowNum, name, reason });
                failures.push({ row: rowNum, reason, raw: rows[i] });
                push({ type: 'row_done', row: rowNum, name, success: false, reason });
            };

            // ── Account + enrolment: the columns the profile validator does not
            //    own, because they carry their own uniqueness and seat checks.
            const missing = [];
            if (!name)        missing.push('Full Name');
            if (!email)       missing.push('Email Address');
            if (!phone)       missing.push('Phone Number');
            if (!className)   missing.push('Class');
            if (!sectionName) missing.push('Section');
            if (missing.length) { fail(`Missing: ${missing.join(', ')}`); continue; }
            if (!isEmail(email)) { fail('Invalid student email'); continue; }
            if (!isPhone(phone)) { fail(`Invalid phone "${phone}"`); continue; }

            // Dates are dd/mm/yyyy; `new Date` would read them as mm/dd/yyyy.
            const dates   = {};
            let   dateErr = null;
            for (const [key, label, ...aliases] of [
                ['dob', 'Date of Birth', 'date of birth', 'dob'],
                ['previousSchoolLeavingDate', 'Previous School Leaving Date', 'previous school leaving date', 'leaving date'],
                ['tcDate', 'TC Date', 'tc date'],
            ]) {
                const raw = cell(...aliases);
                if (!raw) continue;
                const parsed = parseSheetDate(raw);
                if (!parsed) { dateErr = `Invalid ${label} (use dd/mm/yyyy)`; break; }
                dates[key] = parsed;
            }
            if (dateErr) { fail(dateErr); continue; }

            // ── The profile, shaped exactly like the add-student wizard's POST
            const pincode = cell('pincode', 'pin code', 'postal code');
            const profile = {
                ...suppliedOnly({
                    dob:         dates.dob,
                    gender:      matchOption(cell('gender'), GENDERS),
                    bloodGroup:  normalizeBloodGroup(cell('blood group', 'bloodgroup')),
                    category:    matchOption(cell('category'), CATEGORIES),
                    religion:    cell('religion'),
                    nationality: cell('nationality') || 'Indian',
                    emergencyContactName:     cell('emergency contact name'),
                    emergencyContactPhone:    cell('emergency contact phone'),
                    emergencyContactRelation: cell('emergency contact relation', 'emergency contact relation to the student'),

                    address: cell('address', 'current address'),
                    city:    cell('city', 'current city'),
                    // A blank state is derived from the PIN code, as the form does
                    state:   matchOption(cell('state', 'current state') || stateFromPincode(pincode), STATES_AND_UTS),
                    pincode,
                    country: cell('country', 'current country') || 'India',
                    permanentAddress: cell('permanent address'),
                    permanentCity:    cell('permanent city'),
                    permanentState:   matchOption(cell('permanent state'), STATES_AND_UTS),
                    permanentPincode: cell('permanent pincode', 'permanent pin code'),
                    permanentCountry: cell('permanent country') || 'India',

                    aadhaarNumber: cell('aadhaar number', 'aadhar number'),

                    previousSchoolName:    cell('previous school name'),
                    previousSchoolAddress: cell('previous school address'),
                    previousSchoolCity:    cell('previous school city'),
                    previousSchoolState:   matchOption(cell('previous school state'), STATES_AND_UTS),
                    previousSchoolPincode: cell('previous school pincode', 'previous school pin code'),
                    previousSchoolCountry: cell('previous school country') || 'India',
                    previousSchoolMedium:  matchOption(cell('previous school medium'), SCHOOL_MEDIUMS),
                    previousSchoolBoard:   matchOption(cell('previous school board'), SCHOOL_BOARDS),
                    previousSchoolStateBoardName: cell('state board name', 'previous school state board name'),
                    previousClass:         cell('previous class'),
                    previousAcademicYear:  cell('previous academic year'),
                    previousSchoolLeavingDate: dates.previousSchoolLeavingDate,
                    previousSchoolContact: cell('previous school contact'),
                    tcNumber:              cell('tc number'),
                    tcDate:                dates.tcDate,
                }),
                // Both gate whole blocks, so they are always present: blank reads
                // as "no", never as "leave the stored value alone".
                sameAsCurrent:     sheetBool(cell('permanent same as current', 'same as current')),
                isTransferStudent: sheetBool(cell('transfer student', 'is transfer student')),
            };

            // The same validator the wizard runs. Only the document checks are
            // skipped — the certificates are attached later by editing the
            // student, which the template's reference sheet spells out.
            const profileErr = validateStudentProfile(profile);
            if (profileErr) { fail(profileErr); continue; }

            // ── Father / mother / guardian, one column group each ─────────────
            const parentBlock = (role) => suppliedOnly({
                name:          cell(`${role} name`, `${role} full name`),
                email:         cell(`${role} email`).toLowerCase(),
                phone:         cell(`${role} phone`, `${role} phone number`),
                occupation:    cell(`${role} occupation`),
                organization:  cell(`${role} organization`),
                designation:   cell(`${role} designation`),
                qualification: cell(`${role} qualification`),
                annualIncome:  cell(`${role} annual income`),
                aadhaarNumber: cell(`${role} aadhaar number`, `${role} aadhar number`),
                panNumber:     cell(`${role} pan number`),
                ...(role === 'guardian' ? { relation: cell('guardian relation') } : {}),
            });
            const newParent = {
                // Whoever holds the login. The wizard defaults to the father.
                accountFor: matchOption(cell('account for'), ['Father', 'Mother', 'Guardian']) || 'Father',
                father:   parentBlock('father'),
                mother:   parentBlock('mother'),
                guardian: parentBlock('guardian'),
            };
            if (!PARENT_ROLES.some(role => newParent[role].name || newParent[role].email)) {
                // A sheet from the older three-column template names one parent
                // only; resolveNewParent still accepts that flat shape.
                const legacyName  = cell('parent full name', 'parent name');
                const legacyEmail = cell('parent email').toLowerCase();
                if (!legacyName || !legacyEmail) { fail('Parent / guardian details are required'); continue; }
                newParent.name  = legacyName;
                newParent.email = legacyEmail;
                newParent.phone = cell('parent phone number', 'parent phone');
            }

            const clasDoc = classMap[className.toLowerCase()];
            if (!clasDoc) { fail(`Class "${className}" not found in active year`); continue; }
            const section = sectionMap[`${clasDoc._id.toString()}_${sectionName.toLowerCase()}`];
            if (!section) { fail(`Section "${sectionName}" not found in class "${className}"`); continue; }

            // Seats filled earlier in THIS import must count, so the roster is
            // tracked across rows rather than re-read from the pre-run snapshot.
            const secKey = String(section._id);
            if (!rosterBySection.has(secKey)) {
                rosterBySection.set(secKey, new Set((section.enrolledStudents || []).map(String)));
            }
            const sectionRoster = rosterBySection.get(secKey);
            const sectionSeats  = Number(section.maxStudents) || 0;

            // A row whose email already exists updates that student instead of
            // failing, so a corrected sheet can simply be re-uploaded.
            const studentExists = await User.findOne({ email }).lean();
            if (studentExists && (studentExists.role !== 'student' || String(studentExists.school) !== String(req.schoolId))) {
                fail(`Email "${email}" belongs to another account`);
                continue;
            }

            // Seats are counted against the roster as it grows during this run,
            // so a sheet with more rows than seats fails the surplus rows rather
            // than overfilling the section.
            const alreadySeated = studentExists && sectionRoster.has(String(studentExists._id));
            if (sectionSeats > 0 && !alreadySeated && sectionRoster.size >= sectionSeats) {
                fail(`Section "${section.sectionName}" of ${className} is full `
                   + `(${sectionRoster.size} of ${sectionSeats} seats taken)`);
                continue;
            }

            try {
                const existingProfile = studentExists
                    ? await StudentProfile.findOne({ user: studentExists._id }).lean()
                    : null;

                // Admission and roll numbers carry the form's uniqueness rules.
                if (admNo) {
                    const admTaken = await StudentProfile.findOne({
                        school: req.schoolId, admissionNumber: admNo,
                        ...(studentExists ? { user: { $ne: studentExists._id } } : {}),
                    }).lean();
                    if (admTaken) { fail(`Admission number ${admNo} is already in use`); continue; }
                }
                if (rollNumber) {
                    const takenBy = await rollNumberTaken(section._id, rollNumber, studentExists?._id);
                    if (takenBy) { fail(`Roll number ${rollNumber} is already used by ${takenBy} in this section`); continue; }
                }

                // Same helper the wizard uses, so the guardian blocks, the login
                // holder and the welcome email all behave identically. Documents
                // already on the parent record survive a re-import.
                const existingParent = existingProfile?.parent
                    ? await ParentProfile.findOne({ user: existingProfile.parent }).lean()
                    : null;
                const { parentId, error: parentErr } = await resolveNewParent(newParent, {
                    schoolId: req.schoolId, schoolName, uploads: {}, existingBlocks: existingParent,
                });
                if (parentErr) { fail(parentErr); continue; }
                if (!parentId) { fail('Parent / guardian details are required'); continue; }

                // Blank in the sheet → generated from the school's format
                const admissionNumber = admNo || await admissionNo.nextAdmissionNumber(bulkSchool, clasDoc);
                const profileData = {
                    school: req.schoolId,
                    ...buildStudentProfile(profile, {}),
                    admissionNumber,
                    currentClass: clasDoc._id,
                    currentSection: section._id,
                    parent: parentId,
                    // Optional in the sheet: sections assign roll numbers in bulk later.
                    ...(rollNumber ? { rollNumber } : {}),
                };

                let studentUser = studentExists;
                if (studentUser) {
                    await User.updateOne({ _id: studentUser._id }, { $set: { name, ...(phone ? { phone } : {}) } });
                    await authCache.invalidate(studentUser._id);
                    await StudentProfile.findOneAndUpdate(
                        { user: studentUser._id },
                        { $set: profileData },
                        { upsert: true },
                    );
                    updated++;
                    sectionRoster.add(String(studentUser._id));
                } else {
                    const otp = generateOTP();
                    studentUser = await createUserHelper({ name, email, phone, password: otp }, 'student', req.schoolId);
                    await StudentProfile.create({ user: studentUser._id, ...profileData });
                    sectionRoster.add(String(studentUser._id));
                    sendWelcomeEmail(email, name, email, otp, schoolName, req.schoolId);
                    created++;
                }
                // Enrol (idempotent) so the section roster matches the sheet
                await ClassSection.updateOne(
                    { _id: section._id },
                    { $addToSet: { enrolledStudents: studentUser._id } },
                );
                await ParentProfile.findOneAndUpdate({ user: parentId }, { $addToSet: { children: studentUser._id } });

                push({ type: 'row_done', row: rowNum, name, success: true });
            } catch (e) {
                fail(e.code === 11000 ? 'Duplicate entry' : e.message);
            }
        }

        // Section rosters changed above — bring their headcounts back in line
        const touched = await ClassSection.find({ school: req.schoolId }, '_id enrolledStudents').lean();
        const countOps = touched.map(sec => ({
            updateOne: { filter: { _id: sec._id }, update: { $set: { currentCount: (sec.enrolledStudents || []).length } } },
        }));
        if (countOps.length) await ClassSection.bulkWrite(countOps);

        push({
            type: 'done', created, updated, errors,
            errorFile: buildErrorReport(headerRow, failures, 'student-import-errors.xlsx'),
        });
        res.end();
    } catch (e) {
        push({ type: 'error', message: e.message });
        res.end();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Bulk-import templates.
//
//  Each template carries one column per field of the matching intake wizard, in
//  the wizard's own step order, so importing a sheet and filling in the form
//  produce the same record. Two things keep a template honest:
//
//    * the sample row is built from the school's OWN data, so the example
//      imports as-is instead of failing on a class that never existed; and
//    * a "Reference" sheet lists the exact values the importer accepts, which
//      are the intake dropdowns' own lists.
// ─────────────────────────────────────────────────────────────────────────────

// Marks the columns Excel would otherwise mangle (leading zeros, dd/mm/yyyy)
// as text, so what the admin typed is what the importer reads.
function forceTextColumns(ws, cols, lastRow) {
    for (let r = 1; r <= lastRow; r += 1) {
        for (const c of cols) {
            const addr = XLSX.utils.encode_cell({ r, c });
            if (ws[addr]) { ws[addr].t = 's'; ws[addr].z = '@'; }
        }
    }
}

// Column indices by header name. Naming them beats counting them: these sheets
// are dozens of columns wide and an off-by-one silently reformats a phone
// number or a date.
const colsFor = (headers, names) => names.map((n) => headers.indexOf(n)).filter((i) => i >= 0);

// The sample row, written against the header names rather than by position, for
// the same reason. Anything not named is left blank.
const sampleFor = (headers, values) => headers.map((h) => values[h] ?? '');

const widthsFor = (headers) => headers.map((h) => ({ wch: Math.max(12, Math.min(30, h.length + 4)) }));

function sendWorkbook(res, wb, filename) {
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
}

// One "Reference" sheet per template: the accepted values, so an admin does not
// have to guess what the importer will take.
function referenceSheet(wb, sections) {
    const rows = [];
    for (const [title, values] of sections) {
        rows.push([title]);
        if (values.length) values.forEach((v) => rows.push(['', v]));
        else rows.push(['', '(none configured yet)']);
        rows.push([]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 30 }, { wch: 52 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Reference');
}

// The seven steps of the add-student wizard, flattened into columns.
const STUDENT_TEMPLATE_HEADERS = [
    // 1. Basic
    'Full Name', 'Email Address', 'Phone Number',
    // 2. Personal
    'Date of Birth', 'Gender', 'Blood Group', 'Category', 'Religion', 'Nationality',
    'Emergency Contact Name', 'Emergency Contact Phone', 'Emergency Contact Relation',
    // 3. Address
    'Address', 'City', 'State', 'Pincode', 'Country',
    'Permanent Same As Current',
    'Permanent Address', 'Permanent City', 'Permanent State', 'Permanent Pincode', 'Permanent Country',
    // 4. Documents — only the number travels in a sheet; the scans are uploaded later
    'Aadhaar Number',
    // 5. Previous school
    'Transfer Student', 'Previous School Name', 'Previous School Address', 'Previous School City',
    'Previous School State', 'Previous School Pincode', 'Previous School Country',
    'Previous School Medium', 'Previous School Board', 'State Board Name',
    'Previous Class', 'Previous Academic Year', 'Previous School Leaving Date',
    'Previous School Contact', 'TC Number', 'TC Date',
    // 6. Enrolment
    'Class', 'Section', 'Admission Number', 'Roll Number',
    // 7. Parents / guardian
    'Account For',
    'Father Name', 'Father Email', 'Father Phone', 'Father Occupation', 'Father Organization',
    'Father Designation', 'Father Qualification', 'Father Annual Income', 'Father Aadhaar Number', 'Father PAN Number',
    'Mother Name', 'Mother Email', 'Mother Phone', 'Mother Occupation', 'Mother Organization',
    'Mother Designation', 'Mother Qualification', 'Mother Annual Income', 'Mother Aadhaar Number', 'Mother PAN Number',
    'Guardian Name', 'Guardian Relation', 'Guardian Email', 'Guardian Phone', 'Guardian Occupation',
    'Guardian Organization', 'Guardian Designation', 'Guardian Qualification', 'Guardian Annual Income',
    'Guardian Aadhaar Number', 'Guardian PAN Number',
];

exports.downloadStudentTemplate = async (req, res) => {
    try {
        const headers = STUDENT_TEMPLATE_HEADERS;

        // Sample row built from this school's real classes and sections, so the
        // example imports as-is instead of failing on a class that never existed.
        const activeYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        const yearFilter = activeYear ? { academicYear: activeYear._id } : {};
        const classes  = await Class.find({ school: req.schoolId, ...yearFilter }).sort('classNumber').lean();
        const sections = await ClassSection.find({ school: req.schoolId, ...yearFilter }).lean();

        const firstClass   = classes[0] || null;
        const firstSection = firstClass
            ? sections.find((s) => String(s.class) === String(firstClass._id))
            : null;
        const school = await School.findById(req.schoolId).select('city state').lean();
        const city   = school?.city  || 'Pune';
        const state  = STATES_AND_UTS.includes(school?.state) ? school.state : 'Maharashtra';

        const sample = sampleFor(headers, {
            'Full Name': 'Ravi Kumar', 'Email Address': 'ravi.kumar@example.com', 'Phone Number': '9876543210',

            'Date of Birth': '15/08/2010', Gender: 'Male', 'Blood Group': 'B+',
            Category: 'General', Religion: 'Hindu', Nationality: 'Indian',
            'Emergency Contact Name': 'Suresh Kumar', 'Emergency Contact Phone': '9876543200',
            'Emergency Contact Relation': 'Father',

            Address: '123 Main Street', City: city, State: state, Pincode: '411001', Country: 'India',
            'Permanent Same As Current': 'Yes',

            'Aadhaar Number': '123456789012',

            'Transfer Student': 'No',
            'Previous School Country': 'India',

            Class: firstClass?.className || 'Class 1',
            Section: firstSection?.sectionName || 'A',

            'Account For': 'Father',
            'Father Name': 'Suresh Kumar', 'Father Email': 'suresh.kumar@example.com',
            'Father Phone': '9876543200', 'Father Occupation': 'Engineer',
            'Father Organization': 'Tata Motors', 'Father Designation': 'Senior Engineer',
            'Father Qualification': 'B.Tech.', 'Father Annual Income': '850000',
            'Father Aadhaar Number': '123456789013', 'Father PAN Number': 'ABCDE1234F',

            'Mother Name': 'Sunita Kumar', 'Mother Phone': '9876543201',
            'Mother Occupation': 'Teacher', 'Mother Qualification': 'M.A.',
            'Mother Aadhaar Number': '123456789014',
        });

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
        forceTextColumns(ws, colsFor(headers, [
            'Phone Number', 'Date of Birth', 'Emergency Contact Phone',
            'Pincode', 'Permanent Pincode', 'Aadhaar Number',
            'Previous School Pincode', 'Previous School Leaving Date', 'Previous School Contact',
            'Previous Academic Year', 'TC Date', 'Admission Number', 'Roll Number',
            'Father Phone', 'Father Aadhaar Number', 'Father PAN Number',
            'Mother Phone', 'Mother Aadhaar Number', 'Mother PAN Number',
            'Guardian Phone', 'Guardian Aadhaar Number', 'Guardian PAN Number',
        ]), 1);
        ws['!cols'] = widthsFor(headers);
        XLSX.utils.book_append_sheet(wb, ws, 'Students');

        const sectionLabels = classes.flatMap((c) => sections
            .filter((sec) => String(sec.class) === String(c._id))
            .map((sec) => `${c.className}  →  ${sec.sectionName}`));

        referenceSheet(wb, [
            ['Classes (use exactly this text)', classes.map((c) => c.className)],
            ['Class → Section pairs', sectionLabels],
            ['Gender', GENDERS],
            ['Blood Group', BLOOD_GROUPS],
            ['Category', CATEGORIES],
            ['Previous School Board', SCHOOL_BOARDS],
            ['Previous School Medium', SCHOOL_MEDIUMS],
            ['Account For (who holds the login)', ['Father', 'Mother', 'Guardian']],
            ['Yes / No columns', [
                'Permanent Same As Current — Yes copies the current address into the permanent one',
                'Transfer Student — Yes turns on the whole Previous School block below',
            ]],
            ['Date format (all date columns)', ['dd/mm/yyyy  (e.g. 15/08/2010)']],
            ['State / UT (use exactly this text)', STATES_AND_UTS],
            ['Leave blank to auto-generate', ['Admission Number', 'Roll Number']],
            ['Required in every row', [
                'Full Name', 'Email Address', 'Phone Number',
                'Date of Birth', 'Gender', 'Blood Group', 'Category', 'Nationality',
                'Emergency Contact Name', 'Emergency Contact Phone', 'Emergency Contact Relation',
                'Address', 'City', 'State', 'Pincode',
                'Aadhaar Number', 'Class', 'Section',
            ]],
            ['Required unless Permanent Same As Current = Yes', [
                'Permanent Address', 'Permanent City', 'Permanent State', 'Permanent Pincode',
            ]],
            ['Required only when Transfer Student = Yes', [
                'Previous School Name', 'Previous School Address', 'Previous School City',
                'Previous School State', 'Previous School Pincode',
                'Previous School Medium', 'Previous School Board',
                'Previous Class', 'Previous Academic Year', 'Previous School Leaving Date',
                'Previous School Contact', 'TC Number', 'TC Date',
                'State Board Name — only when the board is "State Board"',
            ]],
            ['Parents — required in every row', [
                'Father Name, Father Phone, Father Occupation, Father Aadhaar Number',
                'Mother Name, Mother Phone, Mother Occupation, Mother Aadhaar Number',
                'The email of whoever "Account For" names — that is the login',
                'Guardian Name / Phone / Occupation / Aadhaar Number / Relation',
                '   ...only when Account For = Guardian',
            ]],
            ['Cannot be imported — upload by editing the student', [
                'Passport size photo',
                'Aadhaar card front and back scans',
                'Birth certificate, caste / disability / medical certificates',
                'Transfer Certificate and migration certificate',
                'Father / mother / guardian Aadhaar, PAN and photo scans',
            ]],
        ]);

        sendWorkbook(res, wb, 'student-template.xlsx');
    } catch (err) { jsonErr(res, err); }
};

// The seven steps of the add-teacher wizard, flattened into columns.
const TEACHER_TEMPLATE_HEADERS = [
    // 1. Personal
    'Full Name', 'Date of Birth', 'Gender', 'Blood Group', "Father's / Husband's Name",
    'Emergency Contact Name', 'Emergency Contact Phone',
    // 2. Contact
    'Phone Number', 'Alternate Phone', 'Email Address',
    'Current Address', 'Current City', 'Current State', 'Current Pincode', 'Current Country',
    'Permanent Same As Current',
    'Permanent Address', 'Permanent City', 'Permanent State', 'Permanent Pincode', 'Permanent Country',
    // 3. Government ID — numbers only; the scans are uploaded later
    'Aadhaar Number', 'PAN Number', 'UAN Number',
    // 4. Education
    'Qualification', 'Teaching Degree',
    // 5. Work experience
    'Employment Type', 'Total Experience', 'Previous School', 'Last Designation',
    // 6. Bank
    'Bank Account Holder', 'Bank Account Number', 'IFSC Code', 'Bank Branch',
    // 7. School internal
    'Date of Joining', 'Designation', 'Department', 'Employee ID',
];

exports.downloadTeacherTemplate = async (req, res) => {
    try {
        const headers = TEACHER_TEMPLATE_HEADERS;

        // The designation list the add-teacher form itself offers, so the sample
        // row and the reference sheet cannot suggest one that does not exist.
        await designationSvc.ensureSeeded(req.schoolId, req.userId);
        const rows   = await Designation.find({ school: req.schoolId, isActive: true }).sort('name').select('name').lean();
        const school = await School.findById(req.schoolId).select('designations city state').lean();
        const designations = rows.length
            ? rows.map((r) => r.name)
            : (school?.designations?.length ? school.designations : DEFAULT_DESIGNATIONS);
        const city  = school?.city  || 'Pune';
        const state = STATES_AND_UTS.includes(school?.state) ? school.state : 'Maharashtra';

        const sample = sampleFor(headers, {
            'Full Name': 'Anita Sharma', 'Date of Birth': '12/04/1990', Gender: 'Female', 'Blood Group': 'B+',
            "Father's / Husband's Name": 'Ramesh Sharma',
            'Emergency Contact Name': 'Ramesh Sharma', 'Emergency Contact Phone': '9876543200',

            'Phone Number': '9876543210', 'Email Address': 'anita.sharma@example.com',
            'Current Address': '12 Rose Villa, MG Road', 'Current City': city,
            'Current State': state, 'Current Pincode': '411001', 'Current Country': 'India',
            'Permanent Same As Current': 'Yes',

            'Aadhaar Number': '123456789012', 'PAN Number': 'ABCDE1234F',

            Qualification: 'M.Sc.', 'Teaching Degree': 'B.Ed.',

            'Employment Type': 'Experienced', 'Total Experience': '5 years',
            'Previous School': 'Sunrise Public School', 'Last Designation': 'PGT Mathematics',

            'Bank Account Holder': 'Anita Sharma', 'Bank Account Number': '12345678901234',
            'IFSC Code': 'HDFC0001234', 'Bank Branch': 'MG Road',

            'Date of Joining': '01/06/2021',
            Designation: designations[0] || 'Teacher',
            Department: 'Mathematics',
        });

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
        forceTextColumns(ws, colsFor(headers, [
            'Date of Birth', 'Emergency Contact Phone', 'Phone Number', 'Alternate Phone',
            'Current Pincode', 'Permanent Pincode',
            'Aadhaar Number', 'PAN Number', 'UAN Number',
            'Bank Account Number', 'IFSC Code', 'Date of Joining', 'Employee ID',
        ]), 1);
        ws['!cols'] = widthsFor(headers);
        XLSX.utils.book_append_sheet(wb, ws, 'Teachers');

        referenceSheet(wb, [
            ['Designations (this school)', designations],
            ['Gender', GENDERS],
            ['Blood Group', BLOOD_GROUPS],
            ['Qualification', [
                ...QUALIFICATIONS,
                'Any other — type the qualification itself, not the word "Other"',
            ]],
            ['Teaching Degree', [
                ...TEACHING_DEGREES,
                'Any other — type the degree itself, not the word "Other"',
            ]],
            ['Employment Type', ['Fresher', 'Experienced']],
            ['Yes / No columns', [
                'Permanent Same As Current — Yes copies the current address into the permanent one',
            ]],
            ['Date format (all date columns)', ['dd/mm/yyyy  (e.g. 01/06/2021)']],
            ['State / UT (use exactly this text)', STATES_AND_UTS],
            ['Leave blank to auto-generate', ['Employee ID']],
            ['Required in every row', [
                'Full Name', 'Date of Birth', 'Gender', 'Blood Group',
                "Father's / Husband's Name", 'Emergency Contact Name', 'Emergency Contact Phone',
                'Phone Number', 'Email Address',
                'Current Address', 'Current City', 'Current State', 'Current Pincode',
                'Aadhaar Number', 'PAN Number', 'Qualification', 'Employment Type',
                'Bank Account Holder', 'Bank Account Number', 'IFSC Code', 'Bank Branch',
                'Date of Joining',
            ]],
            ['Required unless Permanent Same As Current = Yes', [
                'Permanent Address', 'Permanent City', 'Permanent State', 'Permanent Pincode',
            ]],
            ['Required only when Employment Type = Experienced', [
                'Total Experience', 'Previous School', 'Last Designation',
            ]],
            ['Format', [
                'Aadhaar Number — 12 digits',
                'PAN Number — ABCDE1234F',
                'IFSC Code — HDFC0001234',
                'Bank Account Number — 6 to 20 digits',
            ]],
            ['Cannot be imported — upload by editing the teacher', [
                'Aadhaar card front and back scans',
                'PAN card scan',
                'Resignation letter of the last company (required for experienced staff)',
                'Experience certificate and joining letter',
            ]],
        ]);

        sendWorkbook(res, wb, 'teacher-template.xlsx');
    } catch (err) { jsonErr(res, err); }
};

exports.checkEmail = async (req, res) => {
    try {
        const { email } = req.query;
        if (!email?.trim()) return res.json({ success: true, exists: false });
        const exists = await User.exists({ email: email.toLowerCase().trim() });
        res.json({ success: true, exists: !!exists });
    } catch (err) { jsonErr(res, err); }
};

// Parent search for the student form. Returns every match (not just the first)
// so an admin can pick the right parent and link them to as many children as
// they have — one parent account is shared across all their students.
// ── PIN code → country / state / city ─────────────────────────────────────────
// Proxied through the API (not called from the browser) so the response can be
// cached and a CORS-less public API stays server-side. When India Post is
// unreachable the PIN prefix still yields the state, so the form is never stuck.
const PIN_CACHE = new Map();          // pincode -> resolved payload
const PIN_CACHE_MAX = 2000;

exports.pincodeLookup = async (req, res) => {
    const pincode = String(req.params.pincode || '').trim();
    if (!isPincode(pincode))
        return res.status(400).json({ success: false, message: 'PIN code must be 6 digits' });

    if (PIN_CACHE.has(pincode)) return jsonOk(res, PIN_CACHE.get(pincode));

    const fallback = {
        pincode,
        country: 'India',
        state:   stateFromPincode(pincode),
        city:    '',
        district: '',
        areas:   [],
        source:  'offline',
    };

    let result = fallback;
    try {
        const r = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, {
            signal: AbortSignal.timeout(4000),
        });
        if (r.ok) {
            const body = await r.json();
            const entry = Array.isArray(body) ? body[0] : null;
            const offices = entry?.Status === 'Success' ? (entry.PostOffice || []) : [];
            if (offices.length) {
                const first = offices[0];
                const state = STATES_AND_UTS.includes(first.State) ? first.State : stateFromPincode(pincode);
                result = {
                    pincode,
                    country:  first.Country || 'India',
                    state,
                    city:     first.District || first.Division || '',
                    district: first.District || '',
                    areas:    [...new Set(offices.map(o => o.Name).filter(Boolean))],
                    source:   'india-post',
                };
            }
        }
    } catch { /* offline / timeout — fall through to the prefix-derived state */ }

    if (!result.state && !result.city)
        return res.status(404).json({ success: false, message: `No location found for PIN code ${pincode}` });

    if (PIN_CACHE.size >= PIN_CACHE_MAX) PIN_CACHE.clear();
    PIN_CACHE.set(pincode, result);
    jsonOk(res, result);
};

// Live preview of the next admission number for a given (unsaved) format
exports.previewAdmissionNumber = async (req, res) => {
    try {
        const school = await School.findById(req.schoolId).select('name code admissionNumberFormat').lean();
        if (!school) return res.status(404).json({ success: false, message: 'School not found' });

        const format = String(req.query.format || school.admissionNumberFormat || admissionNo.DEFAULT_FORMAT).trim();
        const fmtErr = admissionNo.validateFormat(format);
        if (fmtErr) return res.status(400).json({ success: false, message: fmtErr });

        // {CLASS}/{CLASSNO} need a class to render — preview against a real one
        const activeYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).select('_id').lean();
        const classes = await Class.find({
            school: req.schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}),
        }).select('className classNumber').lean();
        // Stable pick so the preview doesn't jump between classes
        const classDoc = classes.sort((a, b) =>
            String(a.className).localeCompare(String(b.className), 'en', { numeric: true }))[0] || null;

        jsonOk(res, {
            format,
            sampleClass: classDoc?.className || null,
            samples: [
                await admissionNo.previewAdmissionNumber(format, school, 1, classDoc),
                await admissionNo.previewAdmissionNumber(format, school, 2, classDoc),
            ],
            next: await admissionNo.nextAdmissionNumber({ ...school, admissionNumberFormat: format }, classDoc),
        });
    } catch (err) { jsonErr(res, err); }
};

// Live preview of the next employee ID for a given (unsaved) format
exports.previewEmployeeId = async (req, res) => {
    try {
        const school = await School.findById(req.schoolId).select('name code employeeIdFormat').lean();
        if (!school) return res.status(404).json({ success: false, message: 'School not found' });

        const format = String(req.query.format || school.employeeIdFormat || employeeIdUtil.DEFAULT_FORMAT).trim();
        const fmtErr = employeeIdUtil.validateFormat(format);
        if (fmtErr) return res.status(400).json({ success: false, message: fmtErr });

        jsonOk(res, {
            format,
            samples: [
                await employeeIdUtil.previewEmployeeId(format, school, 1),
                await employeeIdUtil.previewEmployeeId(format, school, 2),
            ],
            next: await employeeIdUtil.nextEmployeeId({ ...school, employeeIdFormat: format }),
        });
    } catch (err) { jsonErr(res, err); }
};

// Static list for the address form's state dropdown
exports.getStates = (_req, res) => jsonOk(res, STATES_AND_UTS);

exports.parentLookup = async (req, res) => {
    try {
        const { q } = req.query;
        if (!q?.trim()) return res.json({ success: true, data: [] });

        const term = q.trim();
        const rx   = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const parents = await User.find({
            role: 'parent', school: req.schoolId,
            $or: [{ email: rx }, { phone: rx }, { name: rx }],
        }).select('name email phone').limit(10).lean();

        if (!parents.length) return res.json({ success: true, data: [] });

        // Annotate with the children already linked — linking another child to a
        // parent who has one is normal, and admins need to see it to be sure.
        const parentIds = parents.map(p => p._id);
        const profiles  = await StudentProfile.find({ parent: { $in: parentIds } }, 'parent user').lean();
        const students  = profiles.length
            ? await User.find({ _id: { $in: profiles.map(p => p.user) } }).select('name').lean()
            : [];
        const nameById  = new Map(students.map(s => [String(s._id), s.name]));
        const kidsByParent = new Map();
        profiles.forEach(p => {
            const key = String(p.parent);
            if (!kidsByParent.has(key)) kidsByParent.set(key, []);
            const nm = nameById.get(String(p.user));
            if (nm) kidsByParent.get(key).push(nm);
        });

        res.json({
            success: true,
            data: parents.map(p => ({ ...p, children: kidsByParent.get(String(p._id)) || [] })),
        });
    } catch (err) { jsonErr(res, err); }
};

// ── School Settings ───────────────────────────────────────────────────────────

// ── Teacher designations (dropdown source, admin-managed) ─────────────────────

// Designations now live in their own table together with the module access they
// grant — see models/Designation.js and controllers/designation.controller.js.
// These two endpoints keep the original string[] contract the teacher create /
// edit forms consume; the permission grid is served from /designations/matrix.
const DEFAULT_DESIGNATIONS = designationSvc.DEFAULT_DESIGNATIONS;

exports.getDesignations = async (req, res) => {
    try {
        await designationSvc.ensureSeeded(req.schoolId, req.userId);
        const rows = await Designation.find({ school: req.schoolId, isActive: true })
            .sort('name').select('name').lean();
        if (rows.length) return jsonOk(res, rows.map(r => r.name));
        // A school with no rows at all (e.g. no designations configured yet)
        const school = await School.findById(req.schoolId).select('designations').lean();
        jsonOk(res, school?.designations?.length ? school.designations : DEFAULT_DESIGNATIONS);
    } catch (err) { jsonErr(res, err); }
};

// Bulk save of just the names. Rows that disappear from the list are removed only
// when no teacher holds them, and new names arrive with the default permission
// set; existing rows keep the permissions already configured for them.
exports.updateDesignations = async (req, res) => {
    try {
        let { designations } = req.body;
        if (!Array.isArray(designations)) return res.status(400).json({ success: false, message: 'designations must be an array' });
        designations = [...new Set(designations.map(d => String(d).trim()).filter(Boolean))];
        if (!designations.length) return res.status(400).json({ success: false, message: 'At least one designation is required' });

        await designationSvc.ensureSeeded(req.schoolId, req.userId);
        const rows = await Designation.find({ school: req.schoolId }).lean();
        const byKey = new Map(rows.map(r => [r.name.trim().toLowerCase(), r]));
        const keep  = new Set(designations.map(d => d.toLowerCase()));

        for (const name of designations) {
            const existing = byKey.get(name.toLowerCase());
            if (existing) {
                if (existing.isActive === false) await Designation.findByIdAndUpdate(existing._id, { $set: { isActive: true } });
                continue;
            }
            await Designation.create({
                school: req.schoolId,
                name,
                permissions: designationSvc.defaultPermissionsFor(name),
                createdBy: req.userId || null,
            });
        }
        for (const row of rows) {
            if (keep.has(row.name.trim().toLowerCase())) continue;
            const inUse = await designationSvc.countTeachers(req.schoolId, row.name);
            // Still held by someone: deactivate rather than delete, so the
            // permission row survives for anyone who has it.
            if (inUse > 0) await Designation.findByIdAndUpdate(row._id, { $set: { isActive: false } });
            else await Designation.findByIdAndDelete(row._id);
        }

        await School.findByIdAndUpdate(req.schoolId, { designations });
        await designationSvc.invalidate(req.schoolId);
        jsonOk(res, designations);
    } catch (err) { jsonErr(res, err); }
};

exports.getSchoolSettings = async (req, res) => {
    try {
        const school = await School.findById(req.schoolId)
            .select('name code email phone website logo leaveSettings admissionNumberFormat employeeIdFormat')
            .lean();
        if (!school) return res.status(404).json({ success: false, message: 'School not found' });
        res.json({ success: true, data: school });
    } catch (e) { jsonErr(res, e); }
};

exports.updateSchoolSettings = async (req, res) => {
    try {
        const { code, email, phone, website } = req.body;
        const err = validate(req.body, {
            email:   { label: 'Email', type: 'email' },
            phone:   { label: 'Phone', type: 'phone' },
            website: { label: 'Website', type: 'url' },
            code:    { label: 'School Code', regex: /^$|^[A-Za-z0-9_-]{2,20}$/, regexMsg: 'School Code must be 2-20 letters, numbers, hyphens or underscores' },
        });
        if (err) return res.status(400).json({ success: false, message: err });
        const update = {};
        if (code    !== undefined) update.code    = (code    || '').trim();
        if (email   !== undefined) update.email   = (email   || '').trim().toLowerCase();
        if (phone   !== undefined) update.phone   = (phone   || '').trim();
        if (website !== undefined) update.website = (website || '').trim();
        if (req.body.admissionNumberFormat !== undefined) {
            const fmt = String(req.body.admissionNumberFormat).trim();
            const fmtErr = admissionNo.validateFormat(fmt);
            if (fmtErr) return res.status(400).json({ success: false, message: fmtErr });
            update.admissionNumberFormat = fmt;
        }
        if (req.body.employeeIdFormat !== undefined) {
            const fmt = String(req.body.employeeIdFormat).trim();
            const fmtErr = employeeIdUtil.validateFormat(fmt);
            if (fmtErr) return res.status(400).json({ success: false, message: fmtErr });
            update.employeeIdFormat = fmt;
        }

        // leaveSettings may arrive as JSON string (FormData) or object (JSON body)
        let ls = req.body.leaveSettings;
        if (ls) {
            if (typeof ls === 'string') ls = JSON.parse(ls);
            if (ls.saturdayWorking !== undefined)  update['leaveSettings.saturdayWorking']  = !!ls.saturdayWorking;
            if (ls.saturdayMode   !== undefined)   update['leaveSettings.saturdayMode']     = ls.saturdayMode;
            if (ls.saturdayHalfDay !== undefined)  update['leaveSettings.saturdayHalfDay']  = !!ls.saturdayHalfDay;
        }
        // A new upload replaces the logo; removeLogo clears it. In both cases the
        // file it replaces is deleted so uploads/ doesn't collect orphans.
        const removeLogo = req.body.removeLogo === true || req.body.removeLogo === 'true';
        if (req.file)          update.logo = req.file.filename;
        else if (removeLogo)   update.logo = '';

        let previousLogo = null;
        if (update.logo !== undefined) {
            const current = await School.findById(req.schoolId).select('logo').lean();
            previousLogo = current?.logo || null;
        }

        const school = await School.findByIdAndUpdate(
            req.schoolId, update, { new: true, select: 'name code email phone website logo leaveSettings admissionNumberFormat employeeIdFormat' }
        ).lean();

        if (previousLogo && previousLogo !== school?.logo) deleteSchoolLogo(previousLogo);

        res.json({ success: true, data: school });
    } catch (e) { jsonErr(res, e); }
};

// ── Payment gateway (per-school, shared by every module that takes money) ─────
//
// Lives here rather than in Fees because library fines are payable too, and a
// school has one merchant account, not one per module.

exports.getPaymentGateway = async (req, res) => {
    try {
        const school = await School.findById(req.schoolId).select('paymentGateway modules').lean();
        const gw = school?.paymentGateway || {};
        // Secrets are never returned — only whether one is stored.
        jsonOk(res, {
            enabled:  !!gw.enabled,
            provider: gw.provider || 'none',
            razorpayKeyId:        gw.razorpayKeyId || '',
            stripePublishableKey: gw.stripePublishableKey || '',
            currency:       gw.currency || 'INR',
            currencySymbol: gw.currencySymbol || '₹',
            modules: {
                fees:    !!gw.modules?.fees,
                library: !!gw.modules?.library,
            },
            hasRazorpaySecret: !!gw.razorpayKeySecret,
            hasStripeSecret:   !!gw.stripeSecretKey,
            // Which modules the school runs at all — the screen only offers
            // those, and hides itself entirely when neither is on.
            availableModules: {
                fees:    !!school?.modules?.fees,
                library: !!school?.modules?.library,
            },
        });
    } catch (e) { jsonErr(res, e); }
};

exports.updatePaymentGateway = async (req, res) => {
    try {
        const {
            enabled, provider, razorpayKeyId, razorpayKeySecret,
            stripePublishableKey, stripeSecretKey, currency, currencySymbol, modules,
        } = req.body;

        const school = await School.findById(req.schoolId).select('paymentGateway modules').lean();
        const current = school?.paymentGateway || {};
        const wantProvider = provider === undefined ? (current.provider || 'none') : provider;

        if (!['razorpay', 'stripe', 'none'].includes(wantProvider))
            return res.status(400).json({ success: false, message: 'Choose a supported payment gateway' });

        const update = {};
        if (enabled !== undefined) update['paymentGateway.enabled'] = !!enabled;
        if (provider !== undefined) update['paymentGateway.provider'] = provider;
        if (razorpayKeyId        !== undefined) update['paymentGateway.razorpayKeyId'] = String(razorpayKeyId).trim();
        if (stripePublishableKey !== undefined) update['paymentGateway.stripePublishableKey'] = String(stripePublishableKey).trim();
        if (currency       !== undefined) update['paymentGateway.currency'] = String(currency).trim().toUpperCase() || 'INR';
        if (currencySymbol !== undefined) update['paymentGateway.currencySymbol'] = String(currencySymbol).trim() || '₹';

        // A blank secret means "leave the stored one alone", so a save from a
        // form that never shows the secret cannot wipe it.
        if (razorpayKeySecret) update['paymentGateway.razorpayKeySecret'] = String(razorpayKeySecret).trim();
        if (stripeSecretKey)   update['paymentGateway.stripeSecretKey']   = String(stripeSecretKey).trim();

        // A module can only be pointed at the gateway if the school runs it.
        if (modules !== undefined) {
            for (const key of GATEWAY_MODULES) {
                const wanted = !!modules[key];
                if (wanted && !school?.modules?.[key])
                    return res.status(400).json({ success: false, message: `The ${key} module is not enabled for this school` });
                update[`paymentGateway.modules.${key}`] = wanted;
            }
        }

        // Turning it on with nothing behind it would fail at the checkout, in
        // front of a parent — refuse here instead.
        const finalEnabled = enabled !== undefined ? !!enabled : !!current.enabled;
        if (finalEnabled) {
            if (wantProvider === 'none')
                return res.status(400).json({ success: false, message: 'Choose a gateway before switching online payment on' });
            if (wantProvider === 'razorpay') {
                const keyId  = update['paymentGateway.razorpayKeyId'] ?? current.razorpayKeyId;
                const secret = update['paymentGateway.razorpayKeySecret'] ?? current.razorpayKeySecret;
                if (!keyId || !secret)
                    return res.status(400).json({ success: false, message: 'Enter both the Razorpay key id and key secret' });
            }
            if (wantProvider === 'stripe') {
                const pk = update['paymentGateway.stripePublishableKey'] ?? current.stripePublishableKey;
                const sk = update['paymentGateway.stripeSecretKey'] ?? current.stripeSecretKey;
                if (!pk || !sk)
                    return res.status(400).json({ success: false, message: 'Enter both the Stripe publishable key and secret key' });
            }
            const pointedAt = GATEWAY_MODULES.some(k =>
                update[`paymentGateway.modules.${k}`] ?? current.modules?.[k]);
            if (!pointedAt)
                return res.status(400).json({ success: false, message: 'Pick at least one module that should use this gateway' });
        }

        await School.findByIdAndUpdate(req.schoolId, { $set: update });
        return exports.getPaymentGateway(req, res);   // reads no query params, so re-dispatch is safe here
    } catch (e) { jsonErr(res, e); }
};

// ── Receipt templates ─────────────────────────────────────────────────────────
//
// One design per module per payment mode. A school that wants the same receipt
// whether a parent paid at the counter or online ticks "use for both", and the
// controller writes the same design to both rows — so nothing downstream has to
// work out which case it is looking at.

/**
 * The designs for one module, as the settings screen wants them.
 *
 * A plain function rather than something both handlers reach by re-dispatching:
 * the save used to reload by assigning `req.query.module` and calling the GET
 * handler, and `req.query` is a getter — the assignment never took, the reload
 * fell back to 'fees', and a library-only school was told the fees module was
 * not enabled when it had just saved a library design.
 */
async function receiptTemplatePayload(schoolId, moduleRaw) {
    const module = ['fees', 'library'].includes(moduleRaw) ? moduleRaw : 'fees';
    const school = await School.findById(schoolId).select('modules').lean();
    if (!school?.modules?.[module]) {
        return { error: `The ${module} module is not enabled for this school` };
    }

    const saved = await ReceiptTemplate.find({ school: schoolId, module }).lean();
    const pick = (mode) => saved.find(t => t.paymentMode === mode) || defaultTemplate(module, mode);

    const online  = pick('online');
    const offline = pick('offline');
    return {
        data: {
            module,
            online,
            offline,
            // Two identical designs mean the school never wanted them apart.
            sameForBoth: TEMPLATE_FIELDS.every(k => String(online[k] ?? '') === String(offline[k] ?? '')),
            presets: Object.entries(PRESETS).map(([key, p]) => ({ key, ...p })),
        },
    };
}

exports.getReceiptTemplates = async (req, res) => {
    try {
        const result = await receiptTemplatePayload(req.schoolId, req.query.module);
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        jsonOk(res, result.data);
    } catch (e) { jsonErr(res, e); }
};

exports.updateReceiptTemplate = async (req, res) => {
    try {
        const { module, paymentMode, sameForBoth, ...rest } = req.body;
        if (!['fees', 'library'].includes(module))
            return res.status(400).json({ success: false, message: 'Choose a module' });
        if (!sameForBoth && !['online', 'offline'].includes(paymentMode))
            return res.status(400).json({ success: false, message: 'Choose which payments this design is for' });

        const school = await School.findById(req.schoolId).select('modules').lean();
        if (!school?.modules?.[module])
            return res.status(400).json({ success: false, message: `The ${module} module is not enabled for this school` });

        if (rest.preset && !PRESETS[rest.preset])
            return res.status(400).json({ success: false, message: 'Choose one of the available designs' });
        if (rest.accentColor && !/^#[0-9a-fA-F]{3,8}$/.test(rest.accentColor))
            return res.status(400).json({ success: false, message: 'The accent colour must be a hex value like #4F46E5' });

        const design = {};
        for (const key of TEMPLATE_FIELDS) if (rest[key] !== undefined) design[key] = rest[key];

        const modes = sameForBoth ? ['online', 'offline'] : [paymentMode];
        for (const mode of modes) {
            await ReceiptTemplate.findOneAndUpdate(
                { school: req.schoolId, module, paymentMode: mode },
                { ...design, school: req.schoolId, module, paymentMode: mode, updatedBy: req.userId },
                { upsert: true, new: true },
            );
        }

        const result = await receiptTemplatePayload(req.schoolId, module);
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        jsonOk(res, result.data);
    } catch (e) { jsonErr(res, e); }
};

/** Renders the design against sample data, so the screen previews truthfully. */
exports.previewReceiptTemplate = async (req, res) => {
    try {
        const module = ['fees', 'library'].includes(req.query.module) ? req.query.module : 'fees';
        const school = await School.findById(req.schoolId).select('name address logo').lean();

        const design = {};
        for (const key of TEMPLATE_FIELDS) {
            if (req.query[key] === undefined) continue;
            design[key] = ['showLogo', 'showBreakdown', 'showSignature', 'showPaymentMode'].includes(key)
                ? req.query[key] === 'true'
                : req.query[key];
        }
        const sample = sampleReceipt(module);
        sample.paymentMode = req.query.paymentMode === 'offline' ? 'offline' : 'online';

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderReceipt(sample, design, { school: schoolForReceipt(school, req) }));
    } catch (e) { jsonErr(res, e); }
};

// ── SMTP Settings (per-school outgoing mail) ──────────────────────────────────

exports.getSmtpSettings = async (req, res) => {
    try {
        const school = await School.findById(req.schoolId).select('smtp').lean();
        const smtp = school?.smtp || {};
        // Never return the stored password — only whether one is set
        jsonOk(res, {
            enabled:     !!smtp.enabled,
            host:        smtp.host      || '',
            port:        smtp.port      || 587,
            secure:      !!smtp.secure,
            user:        smtp.user      || '',
            fromName:    smtp.fromName  || '',
            fromEmail:   smtp.fromEmail || '',
            hasPassword: !!smtp.pass,
        });
    } catch (e) { jsonErr(res, e); }
};

exports.updateSmtpSettings = async (req, res) => {
    try {
        const { enabled, host, port, secure, user, pass, fromName, fromEmail } = req.body;
        const err = validate(req.body, {
            port:      { label: 'SMTP port', type: 'number', min: 1, max: 65535 },
            fromEmail: { label: 'From email', type: 'email' },
        });
        if (err) return res.status(400).json({ success: false, message: err });
        const update = {
            'smtp.enabled':   !!enabled,
            'smtp.host':      (host      || '').trim(),
            'smtp.port':      Number(port) || 587,
            'smtp.secure':    !!secure,
            'smtp.user':      (user      || '').trim(),
            'smtp.fromName':  (fromName  || '').trim(),
            'smtp.fromEmail': (fromEmail || '').trim().toLowerCase(),
        };
        // Blank password means "keep the existing one"
        if (pass) update['smtp.pass'] = pass;

        if (update['smtp.enabled'] && (!update['smtp.host'] || !update['smtp.user'])) {
            return res.status(400).json({ success: false, message: 'Host and username are required to enable SMTP' });
        }

        const school = await School.findByIdAndUpdate(req.schoolId, update, { new: true, select: 'smtp' }).lean();
        if (update['smtp.enabled'] && !school.smtp?.pass) {
            await School.findByIdAndUpdate(req.schoolId, { 'smtp.enabled': false });
            return res.status(400).json({ success: false, message: 'Password is required to enable SMTP' });
        }

        invalidateMailer(req.schoolId);
        jsonOk(res, { saved: true });
    } catch (e) { jsonErr(res, e); }
};

exports.testSmtp = async (req, res) => {
    try {
        const to = (req.body.to || req.user?.email || '').trim();
        if (!to) return res.status(400).json({ success: false, message: 'Recipient email is required' });

        const school = await School.findById(req.schoolId).select('name smtp logo').lean();
        if (!school?.smtp?.enabled) {
            return res.status(400).json({ success: false, message: 'Enable and save SMTP settings before testing' });
        }

        await sendSchoolMail(req.schoolId, {
            to,
            subject: `SMTP test — ${school.name}`,
            html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
              ${emailHeaderHtml(school, 'SMTP configuration test')}
              <div style="background:#f9fafb;padding:24px 28px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none">
                <p style="margin-top:0">✅ Your school's SMTP settings are working.</p>
                <p style="color:#6b7280;font-size:.85rem;margin-bottom:0">All emails for <strong>${school.name}</strong> will now be sent through this mailbox.</p>
              </div>
            </div>`,
            rethrow: true,
        });
        jsonOk(res, { sent: true, to });
    } catch (e) {
        res.status(502).json({ success: false, message: `Test email failed: ${e.message}` });
    }
};
