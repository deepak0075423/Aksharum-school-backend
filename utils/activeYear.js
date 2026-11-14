'use strict';
/**
 * The school's active academic year as a date window — for lists that should
 * show "this year" and move on when the school switches year (the library's
 * recent issuances, a member's recent movements).
 *
 * `end` is the last instant of the end date. null when the school has no
 * active year, so callers can fall back to "everything" rather than nothing.
 */
const AcademicYear = require('../models/AcademicYear');

async function activeYearWindow(schoolId) {
    const y = await AcademicYear.findOne({ school: schoolId, status: 'active' })
        .select('yearName startDate endDate').lean();
    if (!y?.startDate) return null;
    const end = y.endDate ? new Date(new Date(y.endDate).getTime() + 86399999) : null;
    return { yearName: y.yearName, start: new Date(y.startDate), end };
}

module.exports = { activeYearWindow };
