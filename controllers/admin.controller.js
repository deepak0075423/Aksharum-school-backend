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
const mailer         = require('../config/mailer');
const { sendSchoolMail, emailHeaderHtml, getMailContext, invalidate: invalidateMailer } = require('../utils/schoolMailer');
const { notify } = require('../services/notifyService');
const { validate, isEmail, isPhone, isURL } = require('../utils/validators');
const authCache = require('../utils/authCache');
const { deleteSchoolLogo } = require('../utils/schoolLogoFile');
const { STATES_AND_UTS, isPincode, stateFromPincode } = require('../utils/indiaStates');

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

// ── Student profile: required demographic + address fields ────────────────────
// Enforced here as well as in the form so bulk/API callers cannot skip them.
const REQUIRED_PROFILE_FIELDS = [
    ['dob',        'Date of birth'],
    ['gender',     'Gender'],
    ['bloodGroup', 'Blood group'],
    ['category',   'Category'],
    ['address',    'Address'],
    ['city',       'City'],
    ['state',      'State'],
    ['pincode',    'PIN code'],
];

function validateStudentProfile(profile = {}, { partial = false } = {}) {
    for (const [key, label] of REQUIRED_PROFILE_FIELDS) {
        // On edit, only validate the fields the client actually sent
        if (partial && profile[key] === undefined) continue;
        if (!String(profile[key] ?? '').trim()) return `${label} is required`;
    }
    if (profile.dob !== undefined && profile.dob && Number.isNaN(new Date(profile.dob).getTime()))
        return 'Invalid date of birth';
    if (profile.pincode !== undefined && String(profile.pincode || '').trim() && !isPincode(profile.pincode))
        return 'PIN code must be 6 digits';
    if (profile.state !== undefined && String(profile.state || '').trim() && !STATES_AND_UTS.includes(String(profile.state).trim()))
        return 'Select a valid state or union territory';
    return null;
}

/**
 * Resolve the parent account for a student.
 *
 * `newParent` accepts the full shape — { father, mother, guardian, accountFor }
 * — where each block is { name, email, phone, occupation }. The login account is
 * created for (or linked to) whoever `accountFor` names; the other guardians are
 * stored on the ParentProfile as contact records. The older flat shape
 * ({ name, email, phone }, still sent by the mobile app) keeps working.
 *
 * @returns {Promise<{ parentId: String|null, error: String|null }>}
 */
async function resolveNewParent(newParent, { schoolId, schoolName }) {
    if (!newParent) return { parentId: null, error: null };

    const blocks = ['father', 'mother', 'guardian'].reduce((acc, key) => {
        const b = newParent[key] || {};
        acc[key] = {
            name:       String(b.name || '').trim(),
            email:      String(b.email || '').trim().toLowerCase(),
            phone:      String(b.phone || '').trim(),
            occupation: String(b.occupation || '').trim(),
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
            name:  String(newParent.name).trim(),
            email: String(newParent.email).trim().toLowerCase(),
            phone: String(newParent.phone || '').trim(),
            occupation: '',
        };
    }

    const holderKey = (isStructured ? accountFor : 'Guardian').toLowerCase();
    const holder    = blocks[holderKey];
    if (!holder.name)  return { parentId: null, error: `${accountFor}'s name is required to create the parent account` };
    if (!holder.email) return { parentId: null, error: `${accountFor}'s email is required to create the parent account` };
    if (!isEmail(holder.email)) return { parentId: null, error: `${accountFor}'s email is not a valid email address` };
    for (const [key, b] of Object.entries(blocks)) {
        if (b.email && !isEmail(b.email)) return { parentId: null, error: `${key[0].toUpperCase() + key.slice(1)}'s email is not a valid email address` };
        if (b.phone && !isPhone(b.phone)) return { parentId: null, error: `${key[0].toUpperCase() + key.slice(1)}'s phone number is not valid` };
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
                    }},
                    { $lookup: { from: 'classsections', localField: 'currentSection', foreignField: '_id', as: '_sec' } },
                    { $addFields: { _sec: { $arrayElemAt: ['$_sec', 0] } } },
                    { $lookup: { from: 'classes', localField: '_sec.class', foreignField: '_id', as: '_cls' } },
                    { $addFields: {
                        sectionName: '$_sec.sectionName',
                        className:   { $arrayElemAt: ['$_cls.className', 0] },
                    }},
                    { $project: { _p: 0, _sec: 0, _cls: 0 } },
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
        jsonOk(res, { user, profile });
    } catch (err) { jsonErr(res, err); }
};

exports.updateStudentFull = async (req, res) => {
    try {
        const { name, phone, password, rollNumber, admissionNumber, dob, gender, bloodGroup,
                category, address, city, state, pincode, country,
                currentSection, parentId, newParent } = req.body;

        // Update User fields
        const userUpdate = {};
        if (name  !== undefined) userUpdate.name  = name;
        if (phone !== undefined) userUpdate.phone = phone;
        if (phone && !/^[+\d\s\-]{7,15}$/.test(phone))
            return res.status(400).json({ success: false, message: 'Invalid phone number' });
        if (rollNumber !== undefined && !String(rollNumber).trim())
            return res.status(400).json({ success: false, message: 'Roll number is required' });
        // Only the demographic/address fields actually submitted are checked, so
        // partial updates from other screens still work.
        const profileErr = validateStudentProfile(
            { dob, gender, bloodGroup, category, address, city, state, pincode },
            { partial: true },
        );
        if (profileErr) return res.status(400).json({ success: false, message: profileErr });
        if (password) {
            if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
            userUpdate.password = await bcrypt.hash(password, 12);
        }
        const user = await User.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, userUpdate, { new: true });
        if (!user) return res.status(404).json({ success: false, message: 'Student not found' });
        await authCache.invalidate(user._id);

        // Resolve parent
        let resolvedParentId = parentId !== undefined ? (parentId || null) : undefined;
        if (resolvedParentId === undefined && newParent) {
            const schoolName = req.user?.school?.name || 'School';
            const { parentId: newId, error } = await resolveNewParent(newParent, { schoolId: req.schoolId, schoolName });
            if (error) return res.status(400).json({ success: false, message: error });
            if (newId) resolvedParentId = newId;
        }

        // Update StudentProfile fields
        const profileUpdate = {};
        if (rollNumber      !== undefined) profileUpdate.rollNumber      = rollNumber;
        if (admissionNumber !== undefined) profileUpdate.admissionNumber = admissionNumber;
        if (dob             !== undefined) profileUpdate.dob             = dob || null;
        if (gender          !== undefined) profileUpdate.gender          = gender;
        if (bloodGroup      !== undefined) profileUpdate.bloodGroup      = bloodGroup;
        if (category        !== undefined) profileUpdate.category        = category;
        if (address         !== undefined) profileUpdate.address         = address;
        if (city            !== undefined) profileUpdate.city            = city;
        if (state           !== undefined) profileUpdate.state           = state;
        if (pincode         !== undefined) profileUpdate.pincode         = pincode;
        if (country         !== undefined) profileUpdate.country         = country || 'India';
        if (resolvedParentId !== undefined) profileUpdate.parent         = resolvedParentId;
        if (currentSection  !== undefined) profileUpdate.currentSection  = currentSection || null;

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
        // designation lives on TeacherProfile (drives Librarian RBAC)
        if (designation !== undefined && user.role === 'teacher') {
            await TeacherProfile.findOneAndUpdate(
                { user: user._id },
                { $set: { designation: designation || '' }, $setOnInsert: { school: req.schoolId } },
                { upsert: true }
            );
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

exports.createTeacher = async (req, res) => {
    try {
        const { name, email, phone, designation, password } = req.body;
        if (!name?.trim())  return res.status(400).json({ success: false, message: 'Full name is required' });
        if (!email?.trim()) return res.status(400).json({ success: false, message: 'Email is required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: 'Invalid email format' });
        if (phone && !/^[+\d\s\-]{7,15}$/.test(phone)) return res.status(400).json({ success: false, message: 'Invalid phone number' });
        const exists = await User.findOne({ email: email.toLowerCase() });
        if (exists) return res.status(400).json({ success: false, message: 'Email already registered' });

        const otp = generateOTP();
        const user = await createUserHelper({ name, email, phone, designation, password: otp }, 'teacher', req.schoolId);
        await TeacherProfile.create({ user: user._id, school: req.schoolId, designation: designation || '' });
        const schoolName = req.user?.school?.name || 'School';
        sendWelcomeEmail(email, name, email, otp, schoolName, req.schoolId);
        jsonOk(res, user, 201);
    } catch (err) { jsonErr(res, err, 400); }
};

exports.createStudent = async (req, res) => {
    try {
        const { name, email, phone, password, profile = {}, parentId, newParent } = req.body;
        if (!name?.trim())  return res.status(400).json({ success: false, message: 'Full name is required' });
        if (!email?.trim()) return res.status(400).json({ success: false, message: 'Email is required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: 'Invalid email format' });
        if (phone && !/^[+\d\s\-]{7,15}$/.test(phone)) return res.status(400).json({ success: false, message: 'Invalid phone number' });
        if (!profile.rollNumber || !String(profile.rollNumber).trim())
            return res.status(400).json({ success: false, message: 'Roll number is required' });
        const profileErr = validateStudentProfile(profile);
        if (profileErr) return res.status(400).json({ success: false, message: profileErr });
        const exists = await User.findOne({ email: email.toLowerCase() });
        if (exists) return res.status(400).json({ success: false, message: 'Email already registered' });

        // Create (or link) the parent account before the student, so a bad
        // parent payload doesn't leave a student behind
        const schoolName = req.user?.school?.name || 'School';
        let resolvedParentId = parentId || null;
        if (!resolvedParentId) {
            const { parentId: newId, error } = await resolveNewParent(newParent, { schoolId: req.schoolId, schoolName });
            if (error) return res.status(400).json({ success: false, message: error });
            resolvedParentId = newId;
        }

        const otp = generateOTP();
        const user = await createUserHelper({ name, email, phone, password: otp }, 'student', req.schoolId);
        const profileData = { user: user._id, school: req.schoolId, ...profile };
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

exports.bulkTeachers = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        const schoolName = req.user?.school?.name || 'School';
        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

        let created = 0;
        const errors = [];
        for (let i = 0; i < rows.length; i++) {
            const rowNum = i + 2;
            const r = {};
            Object.keys(rows[i]).forEach(k => { r[k.trim().toLowerCase()] = String(rows[i][k]).trim(); });

            const name        = r['full name']     || r['name']  || '';
            const email       = (r['email address'] || r['email'] || '').toLowerCase();
            const phone       = r['phone number']   || r['phone'] || '';
            const designation = r['designation']    || '';

            if (!name || !email) { errors.push({ row: rowNum, name: name || '?', reason: 'Full Name and Email Address are required' }); continue; }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push({ row: rowNum, name, reason: `Invalid email "${email}"` }); continue; }
            if (phone && !/^[+\d\s\-]{7,15}$/.test(phone)) { errors.push({ row: rowNum, name, reason: `Invalid phone "${phone}"` }); continue; }

            try {
                const exists = await User.findOne({ email }).lean();
                if (exists) { errors.push({ row: rowNum, name, reason: `Email "${email}" already registered` }); continue; }
                const otp  = generateOTP();
                const user = await createUserHelper({ name, email, phone, password: otp }, 'teacher', req.schoolId);
                await TeacherProfile.create({ user: user._id, school: req.schoolId, designation });
                sendWelcomeEmail(email, name, email, otp, schoolName, req.schoolId);
                created++;
            } catch (e) {
                errors.push({ row: rowNum, name, reason: e.code === 11000 ? 'Duplicate entry' : e.message });
            }
        }
        res.json({ success: true, created, errors });
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
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

        push({ type: 'total', total: rows.length });

        const activeYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        const classes    = await Class.find({ school: req.schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}) }).lean();
        const sections   = await ClassSection.find({ school: req.schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}) }).lean();
        const classMap   = {};
        classes.forEach(c => { classMap[c.className.toLowerCase()] = c; });
        const sectionMap = {};
        sections.forEach(s => { sectionMap[`${s.class.toString()}_${s.sectionName.toLowerCase()}`] = s; });

        let created = 0;
        const errors = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNum = i + 2;
            const r = {};
            Object.keys(row).forEach(k => { r[k.trim().toLowerCase()] = String(row[k]).trim(); });

            const name        = r['full name']          || r['name']        || '';
            const email       = (r['email address']     || r['email']       || '').toLowerCase();
            const phone       = r['phone number']        || r['phone']       || '';
            const admNo       = r['admission number']    || r['admissionnumber'] || '';
            const dobRaw      = r['date of birth']       || r['dob']         || '';
            const gender      = r['gender']              || '';
            const bloodGroup  = r['blood group']         || r['bloodgroup']  || '';
            const category    = r['category']            || '';
            const className   = r['class']               || '';
            const sectionName = r['section']             || '';
            const address     = r['address']             || '';
            const city        = r['city']                || '';
            const stateName   = r['state']               || '';
            const pincode     = String(r['pincode'] || r['pin code'] || r['postal code'] || '').trim();
            const parentName  = r['parent full name']    || r['parent name'] || '';
            const parentEmail = (r['parent email']       || '').toLowerCase();
            const parentPhone = r['parent phone number'] || r['parent phone'] || '';

            push({ type: 'processing', current: i + 1, total: rows.length, name: name || `Row ${rowNum}` });

            const missing = [];
            if (!name)        missing.push('Full Name');
            if (!email)       missing.push('Email Address');
            if (!phone)       missing.push('Phone Number');
            if (!admNo)       missing.push('Admission Number');
            if (!dobRaw)      missing.push('Date of Birth');
            if (!gender)      missing.push('Gender');
            if (!bloodGroup)  missing.push('Blood Group');
            if (!category)    missing.push('Category');
            if (!className)   missing.push('Class');
            if (!sectionName) missing.push('Section');
            if (!address)     missing.push('Address');
            if (!parentName)  missing.push('Parent Full Name');
            if (!parentEmail) missing.push('Parent Email');
            if (!parentPhone) missing.push('Parent Phone Number');
            if (missing.length) {
                errors.push({ row: rowNum, name, reason: `Missing: ${missing.join(', ')}` });
                push({ type: 'row_done', row: rowNum, name, success: false, reason: `Missing: ${missing.join(', ')}` });
                continue;
            }

            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                errors.push({ row: rowNum, name, reason: 'Invalid student email' });
                push({ type: 'row_done', row: rowNum, name, success: false, reason: 'Invalid student email' });
                continue;
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail)) {
                errors.push({ row: rowNum, name, reason: 'Invalid parent email' });
                push({ type: 'row_done', row: rowNum, name, success: false, reason: 'Invalid parent email' });
                continue;
            }

            let dob = null;
            const dobParts = dobRaw.replace(/-/g, '/').split('/');
            if (dobParts.length === 3) {
                const [d, m, y] = dobParts;
                dob = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
                if (isNaN(dob.getTime())) dob = null;
            }
            if (!dob) {
                errors.push({ row: rowNum, name, reason: 'Invalid Date of Birth (use dd/mm/yyyy)' });
                push({ type: 'row_done', row: rowNum, name, success: false, reason: 'Invalid Date of Birth (use dd/mm/yyyy)' });
                continue;
            }

            const clasDoc = classMap[className.toLowerCase()];
            if (!clasDoc) {
                const reason = `Class "${className}" not found in active year`;
                errors.push({ row: rowNum, name, reason });
                push({ type: 'row_done', row: rowNum, name, success: false, reason });
                continue;
            }
            const section = sectionMap[`${clasDoc._id.toString()}_${sectionName.toLowerCase()}`];
            if (!section) {
                const reason = `Section "${sectionName}" not found in class "${className}"`;
                errors.push({ row: rowNum, name, reason });
                push({ type: 'row_done', row: rowNum, name, success: false, reason });
                continue;
            }

            const studentExists = await User.findOne({ email }).lean();
            if (studentExists) {
                const reason = `Email "${email}" already registered`;
                errors.push({ row: rowNum, name, reason });
                push({ type: 'row_done', row: rowNum, name, success: false, reason });
                continue;
            }

            try {
                let parentUserId = null;
                const existingParent = await User.findOne({ email: parentEmail }).lean();
                if (existingParent) {
                    parentUserId = existingParent._id;
                    const pp = await ParentProfile.findOne({ user: existingParent._id }).lean();
                    if (!pp) await ParentProfile.create({ user: existingParent._id, school: req.schoolId });
                } else {
                    const parentOtp = generateOTP();
                    const parentUser = await createUserHelper({ name: parentName, email: parentEmail, phone: parentPhone, password: parentOtp }, 'parent', req.schoolId);
                    await ParentProfile.create({ user: parentUser._id, school: req.schoolId });
                    parentUserId = parentUser._id;
                    sendWelcomeEmail(parentEmail, parentName, parentEmail, parentOtp, schoolName, req.schoolId);
                }

                const otp = generateOTP();
                const studentUser = await createUserHelper({ name, email, phone, password: otp }, 'student', req.schoolId);
                await StudentProfile.create({
                    user: studentUser._id, school: req.schoolId, admissionNumber: admNo,
                    dob, gender, bloodGroup, category,
                    address, city, state: stateName, pincode,
                    // PIN prefix fills the state in when the sheet leaves it blank
                    ...(stateName ? {} : { state: stateFromPincode(pincode) }),
                    country: 'India',
                    currentSection: section._id, parent: parentUserId,
                });
                await ParentProfile.findOneAndUpdate({ user: parentUserId }, { $addToSet: { children: studentUser._id } });
                sendWelcomeEmail(email, name, email, otp, schoolName, req.schoolId);

                created++;
                push({ type: 'row_done', row: rowNum, name, success: true });
            } catch (e) {
                const reason = e.code === 11000 ? 'Duplicate entry' : e.message;
                errors.push({ row: rowNum, name, reason });
                push({ type: 'row_done', row: rowNum, name, success: false, reason });
            }
        }

        push({ type: 'done', created, errors });
        res.end();
    } catch (e) {
        push({ type: 'error', message: e.message });
        res.end();
    }
};

exports.downloadStudentTemplate = (req, res) => {
    const headers = [
        'Full Name', 'Email Address', 'Phone Number', 'Admission Number',
        'Date of Birth', 'Gender', 'Blood Group', 'Category',
        'Class', 'Section', 'Address', 'City', 'State', 'Pincode',
        'Parent Full Name', 'Parent Email', 'Parent Phone Number',
    ];
    const sample = [
        'Ravi Kumar', 'ravi.kumar@example.com', '9876543210', 'ADM2024001',
        '15/08/2010', 'Male', 'B+', 'General',
        'Class 10', 'A', '123 Main Street', 'Pune', 'Maharashtra', '411001',
        'Suresh Kumar', 'suresh.kumar@example.com', '9876543200',
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, sample]);

    // Force text format on columns that Excel would otherwise misinterpret:
    // col 2 = Phone Number, col 3 = Admission Number, col 4 = Date of Birth,
    // col 13 = Pincode, col 16 = Parent Phone
    [2, 3, 4, 13, 16].forEach(col => {
        const addr = XLSX.utils.encode_cell({ r: 1, c: col });
        if (ws[addr]) { ws[addr].t = 's'; ws[addr].z = '@'; }
    });

    // Column widths so the file looks usable when opened
    ws['!cols'] = [
        { wch: 20 }, { wch: 28 }, { wch: 15 }, { wch: 16 },
        { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
        { wch: 12 }, { wch: 10 }, { wch: 28 },
        { wch: 20 }, { wch: 28 }, { wch: 18 },
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Students');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="student-template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
};

exports.downloadTeacherTemplate = (req, res) => {
    const headers = ['Full Name', 'Email Address', 'Phone Number', 'Designation'];
    const sample  = ['Anita Sharma', 'anita.sharma@example.com', '9876543210', 'Teacher'];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
    const phoneCell = XLSX.utils.encode_cell({ r: 1, c: 2 });
    if (ws[phoneCell]) { ws[phoneCell].t = 's'; ws[phoneCell].z = '@'; }
    ws['!cols'] = [{ wch: 20 }, { wch: 28 }, { wch: 15 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Teachers');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="teacher-template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
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

const DEFAULT_DESIGNATIONS = ['Teacher', 'Class Teacher', 'Librarian'];

exports.getDesignations = async (req, res) => {
    try {
        const school = await School.findById(req.schoolId).select('designations').lean();
        const list = (school?.designations?.length ? school.designations : DEFAULT_DESIGNATIONS);
        jsonOk(res, list);
    } catch (err) { jsonErr(res, err); }
};

exports.updateDesignations = async (req, res) => {
    try {
        let { designations } = req.body;
        if (!Array.isArray(designations)) return res.status(400).json({ success: false, message: 'designations must be an array' });
        designations = [...new Set(designations.map(d => String(d).trim()).filter(Boolean))];
        if (!designations.length) return res.status(400).json({ success: false, message: 'At least one designation is required' });

        await School.findByIdAndUpdate(req.schoolId, { designations });
        jsonOk(res, designations);
    } catch (err) { jsonErr(res, err); }
};

exports.getSchoolSettings = async (req, res) => {
    try {
        const school = await School.findById(req.schoolId)
            .select('name code email phone website logo leaveSettings')
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
            req.schoolId, update, { new: true, select: 'name code email phone website logo leaveSettings' }
        ).lean();

        if (previousLogo && previousLogo !== school?.logo) deleteSchoolLogo(previousLogo);

        res.json({ success: true, data: school });
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
