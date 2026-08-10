'use strict';
const User = require('../models/User');

exports.getReports = async (req, res) => {
    try {
        const school = req.schoolId;
        const [teachers, students] = await Promise.all([
            User.countDocuments({ school, role: 'teacher' }),
            User.countDocuments({ school, role: 'student' }),
        ]);
        res.json({ success: true, data: { teachers, students } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
