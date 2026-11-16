'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/profile.controller');
const { verifyToken } = require('../../middleware/auth');
const { uploadProfile } = require('../../middleware/upload');

router.get('/',       verifyToken, ctrl.getProfile);
// The signed-in person's school's cookie policy (School Settings → Privacy & cookies).
router.get('/cookie-policy', verifyToken, require('../../controllers/cookiePolicy.controller').mine);
router.put('/update', verifyToken, uploadProfile.single('profileImage'), ctrl.updateProfile);

// The employee half of "my profile". Staff only, and limited to the fields an
// employee may correct about themselves — see SELF_EDITABLE in the controller.
router.get('/employee', verifyToken, ctrl.getMyEmployeeRecord);
router.put('/employee', verifyToken, ctrl.updateMyEmployeeRecord);

// The year switcher's list: the school's academic years as they are stored,
// which one is really active, and which one this person is looking at
// (services/yearScope.js). Open to every role — the switcher itself decides
// who is offered it.
router.get('/academic-years', verifyToken, async (req, res) => {
    try {
        const yearScope = require('../../services/yearScope');
        if (!req.schoolId) return res.json({ success: true, data: { years: [], active: null, viewing: null } });
        const years = await yearScope.yearsOf(req.schoolId);
        const active = years.find((y) => y.status === 'active') || null;
        const picked = yearScope.viewing();
        const viewing = years.find((y) => String(y._id) === String(picked)) || yearScope.runningYear(years);
        res.json({ success: true, data: {
            years: years.map((y) => ({ _id: y._id, yearName: y.yearName, status: y.status, startDate: y.startDate, endDate: y.endDate })),
            active: active ? String(active._id) : null,
            viewing: viewing ? String(viewing._id) : null,
        } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Shared school config — accessible to all roles via verifyToken
router.get('/school-config', verifyToken, async (req, res) => {
    try {
        const School = require('../../models/School');
        const school = await School.findById(req.schoolId).select('leaveSettings').lean();
        const ls     = school?.leaveSettings ?? {};
        res.json({ success: true, data: {
            saturdayWorking: ls.saturdayWorking !== false,
            saturdayMode:    ls.saturdayMode    || 'all',
            saturdayHalfDay: !!ls.saturdayHalfDay,
        }});
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
