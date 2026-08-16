'use strict';
/**
 * Roll numbers are unique **within a section**, not school-wide: every section
 * numbers its own students from 1, so a global constraint would be unusable.
 */
const ClassSection   = require('../models/ClassSection');
const StudentProfile = require('../models/StudentProfile');
const User           = require('../models/User');

/**
 * @param   {String} sectionId
 * @param   {String} rollNumber
 * @param   {String} [exceptStudentId]  student being edited (ignored in the check)
 * @returns {Promise<String|null>}      name of the student already holding it, or null
 */
async function rollNumberTaken(sectionId, rollNumber, exceptStudentId = null) {
    const value = String(rollNumber ?? '').trim();
    if (!sectionId || !value) return null;

    const section = await ClassSection.findById(sectionId, 'enrolledStudents').lean();
    const peers = (section?.enrolledStudents || [])
        .map(String)
        .filter(id => id !== String(exceptStudentId || ''));
    if (!peers.length) return null;

    const clash = await StudentProfile.findOne({ user: { $in: peers }, rollNumber: value }).lean();
    if (!clash) return null;

    const owner = await User.findById(clash.user, 'name').lean();
    return owner?.name || 'another student';
}

module.exports = { rollNumberTaken };
