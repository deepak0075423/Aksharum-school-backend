'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/profile.controller');
const { verifyToken } = require('../../middleware/auth');
const { uploadProfile } = require('../../middleware/upload');

router.get('/',       verifyToken, ctrl.getProfile);
router.put('/update', verifyToken, uploadProfile.single('profileImage'), ctrl.updateProfile);

// The employee half of "my profile". Staff only, and limited to the fields an
// employee may correct about themselves — see SELF_EDITABLE in the controller.
router.get('/employee', verifyToken, ctrl.getMyEmployeeRecord);
router.put('/employee', verifyToken, ctrl.updateMyEmployeeRecord);

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
