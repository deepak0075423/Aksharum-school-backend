'use strict';
const StudentProfile = require('../models/StudentProfile');
const ClassSection   = require('../models/ClassSection');

exports.getDashboard = async (req, res) => {
    try {
        const FeeLedger    = require('../models/FeeLedger');
        const AcademicYear = require('../models/AcademicYear');
        const dash         = require('../services/studentDashboard');

        const profile = await StudentProfile.findOne({ user: req.userId })
            .populate({ path: 'currentSection', populate: { path: 'class', select: 'className' } })
            .lean();

        const sectionId = profile?.currentSection?._id || null;

        // Outstanding fee balance
        const ay = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        const [snapshot, lastLedger] = await Promise.all([
            dash.studentSnapshot({ schoolId: req.schoolId, sectionId, studentId: req.userId }),
            ay ? FeeLedger.findOne({
                school: req.schoolId, student: req.userId, academicYear: ay._id,
            }).sort({ createdAt: -1 }).select('runningBalance').lean().catch(() => null) : null,
        ]);

        res.json({ success: true, data: {
            profile,
            ...snapshot,
            feeBalance: lastLedger?.runningBalance ?? 0,
        }});
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

/**
 * The student's own class. The whole answer is built by services/classView.js,
 * which the parent endpoint uses too — a parent looking at a child must see
 * exactly what the child sees.
 */
exports.getMyClass = async (req, res) => {
    try {
        const { classViewFor } = require('../services/classView');
        const view = await classViewFor({ studentId: req.userId, schoolId: req.schoolId });
        res.json({ success: true, data: view });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
