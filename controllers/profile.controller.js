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
        if (req.file) updates.profileImage = `/uploads/profiles/${req.file.filename}`;
        const user = await User.findByIdAndUpdate(req.userId, updates, { new: true });
        res.json({ success: true, data: user });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
