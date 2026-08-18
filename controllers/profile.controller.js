'use strict';
const User           = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');
const StudentProfile = require('../models/StudentProfile');
const ParentProfile  = require('../models/ParentProfile');

exports.getProfile = async (req, res) => {
    try {
        const user = await User.findById(req.userId).populate('school').lean();
        let profile = null;
        if (user.role === 'teacher')  profile = await TeacherProfile.findOne({ user: req.userId }).lean();
        if (user.role === 'student')  profile = await StudentProfile.findOne({ user: req.userId }).lean();
        if (user.role === 'parent')   profile = await ParentProfile.findOne({ user: req.userId }).lean();
        res.json({ success: true, data: { user, profile } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.updateProfile = async (req, res) => {
    try {
        // Whitelist self-editable fields only (never role/school/email/password)
        const updates = {};
        for (const k of ['name', 'phone', 'profileIcon']) {
            if (req.body[k] !== undefined) updates[k] = req.body[k];
        }
        if (updates.name !== undefined && !String(updates.name).trim())
            return res.status(400).json({ success: false, message: 'Name is required' });
        if (updates.phone && !/^[+\d\s\-]{7,15}$/.test(updates.phone))
            return res.status(400).json({ success: false, message: 'Invalid phone number' });
        // A new photo replaces any emoji avatar, so the two can never disagree.
        if (req.file) {
            updates.profileImage = `/uploads/profiles/${req.file.filename}`;
            updates.profileIcon = '';
        } else if (req.body.removeProfileImage === 'true' || req.body.removeProfileImage === true) {
            updates.profileImage = '';
        }
        const user = await User.findByIdAndUpdate(req.userId, updates, { new: true });
        res.json({ success: true, data: user });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  A teacher editing their OWN employment record.
//
//  The whitelist is the point. An employee may correct the facts about
//  themselves that only they really know — how to reach them, their emergency
//  contact, their address, their qualifications. They may NOT edit the things
//  that decide what they can do or what they are paid: designation, department,
//  employee ID, joining date, reporting manager, staff type, government IDs,
//  bank details and every uploaded document stay with the administrator.
// ─────────────────────────────────────────────────────────────────────────────
const SELF_EDITABLE = [
    'gender', 'dob', 'bloodGroup', 'fatherOrHusbandName',
    'emergencyContactName', 'emergencyContactPhone',
    'alternatePhone',
    'currentAddress', 'currentCity', 'currentState', 'currentPincode', 'currentCountry',
    'permanentAddress', 'permanentCity', 'permanentState', 'permanentPincode', 'permanentCountry',
    'qualification', 'teachingDegree',
];

exports.getMyEmployeeRecord = async (req, res) => {
    try {
        const TeacherProfile = require('../models/TeacherProfile');
        const profile = await TeacherProfile.findOne({ user: req.userId, school: req.schoolId }).lean();
        if (!profile) return res.json({ success: true, data: null });
        const out = {};
        for (const k of SELF_EDITABLE) out[k] = profile[k] ?? '';
        res.json({ success: true, data: { editable: out, fields: SELF_EDITABLE } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateMyEmployeeRecord = async (req, res) => {
    try {
        if (req.userRole !== 'teacher' && req.userRole !== 'school_admin') {
            return res.status(403).json({ success: false, message: 'No employee record on this account' });
        }
        const TeacherProfile = require('../models/TeacherProfile');
        const { isPhone } = require('../utils/validators');
        const { STATES_AND_UTS, isPincode } = require('../utils/indiaStates');

        const b = req.body || {};
        const updates = {};
        for (const k of SELF_EDITABLE) {
            if (b[k] !== undefined) updates[k] = typeof b[k] === 'string' ? b[k].trim() : b[k];
        }
        if (!Object.keys(updates).length) {
            return res.status(400).json({ success: false, message: 'Nothing to update' });
        }

        if (updates.gender && !['Male', 'Female', 'Other'].includes(updates.gender))
            return res.status(400).json({ success: false, message: 'Gender must be Male, Female or Other' });
        if (updates.dob) {
            const d = new Date(updates.dob);
            if (Number.isNaN(d.getTime())) return res.status(400).json({ success: false, message: 'Invalid date of birth' });
            updates.dob = d;
        }
        for (const k of ['emergencyContactPhone', 'alternatePhone']) {
            if (updates[k] && !isPhone(updates[k]))
                return res.status(400).json({ success: false, message: `${k === 'alternatePhone' ? 'Secondary phone' : 'Emergency contact phone'} is not valid` });
        }
        for (const [k, label] of [['currentPincode', 'Current'], ['permanentPincode', 'Permanent']]) {
            if (updates[k] && !isPincode(updates[k]))
                return res.status(400).json({ success: false, message: `${label} PIN code must be 6 digits` });
        }
        for (const [k, label] of [['currentState', 'Current'], ['permanentState', 'Permanent']]) {
            if (updates[k] && !STATES_AND_UTS.includes(updates[k]))
                return res.status(400).json({ success: false, message: `${label} state is not a valid Indian state or union territory` });
        }

        await TeacherProfile.findOneAndUpdate(
            { user: req.userId, school: req.schoolId },
            { $set: updates, $setOnInsert: { user: req.userId, school: req.schoolId } },
            { upsert: true },
        );
        res.json({ success: true, data: { updated: Object.keys(updates) } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
