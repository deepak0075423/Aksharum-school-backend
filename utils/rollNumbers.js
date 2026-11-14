'use strict';
/**
 * Roll numbers are unique **within a section**, not school-wide: every section
 * numbers its own students from 1, so a global constraint would be unusable.
 *
 * A roll number belongs to the student's row for the section's year
 * (StudentEnrollment) — the profile only mirrors the active year's — so the
 * check reads the section's own rows.
 */
const pool              = require('../db/pool');
const StudentEnrollment = require('../models/StudentEnrollment');
const User              = require('../models/User');

/**
 * @param   {String} sectionId
 * @param   {String} rollNumber
 * @param   {String} [exceptStudentId]  student being edited (ignored in the check)
 * @returns {Promise<String|null>}      name of the student already holding it, or null
 */
async function rollNumberTaken(sectionId, rollNumber, exceptStudentId = null) {
    const value = String(rollNumber ?? '').trim();
    if (!sectionId || !value) return null;

    const { rows } = await pool.query(
        `SELECT "student" FROM "${StudentEnrollment.tableName}"
          WHERE "section" = $1::uuid AND btrim("rollNumber") = $2
            AND ($3::uuid IS NULL OR "student" <> $3::uuid)
          LIMIT 1`,
        [String(sectionId), value, exceptStudentId ? String(exceptStudentId) : null],
    );
    if (!rows.length) return null;

    const owner = await User.findById(rows[0].student, 'name').lean();
    return owner?.name || 'another student';
}

module.exports = { rollNumberTaken };
