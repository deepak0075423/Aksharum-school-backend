'use strict';
const School = require('../models/School');

const requireModule = (moduleName) => async (req, res, next) => {
    try {
        const schoolId = req.schoolId;
        if (!schoolId) return next();

        const school = await School.findById(schoolId).lean();
        if (!school) {
            return res.status(404).json({ success: false, message: 'School not found' });
        }
        const modules = school.modules || {};
        if (!modules[moduleName]) {
            return res.status(403).json({
                success: false,
                message: `Module '${moduleName}' is not enabled for your school`,
                code: 'MODULE_DISABLED',
            });
        }
        next();
    } catch (err) {
        next(err);
    }
};

module.exports = requireModule;
