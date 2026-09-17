'use strict';
/**
 * The days a class does not meet — shared by every student attendance calendar
 * (the teacher's register calendar, the student's and the parent's).
 *
 * Sundays, the Saturdays the school does not work (School.leaveSettings), and
 * holidays that apply to students of this class. Holidays name class ROWS, and
 * "Class 8" is a new row every academic year, so a class-specific holiday is
 * matched on the class NAME. A department holiday is for staff, not students.
 */
const Class   = require('../models/Class');
const Holiday = require('../models/Holiday');
const School  = require('../models/School');
const days    = require('./staffAttendanceDays');

const { keyDate, addDays } = days;

/** @returns {Promise<Map<'YYYY-MM-DD', { status: 'weekend'|'holiday', label? }>>} */
async function daysOff(schoolId, className, from, to) {
    const [school, holidays] = await Promise.all([
        School.findById(schoolId).select('leaveSettings').lean(),
        Holiday.find({ school: schoolId, startDate: { $lte: new Date(`${to}T23:59:59.999Z`) }, endDate: { $gte: keyDate(from) } })
            .select('name startDate endDate applicability').lean().catch(() => []),
    ]);
    const classIds = [...new Set(holidays.flatMap((h) => (h.applicability?.scope === 'specific_classes' ? h.applicability.classes || [] : [])).map(String))];
    const names = classIds.length
        ? new Map((await Class.find({ _id: { $in: classIds } }).select('className').lean()).map((c) => [String(c._id), c.className]))
        : new Map();
    const applies = (h) => {
        const scope = h.applicability?.scope || 'all';
        if (scope === 'all') return true;
        if (scope === 'specific_classes') return (h.applicability.classes || []).some((id) => names.get(String(id)) === className);
        return false;
    };
    const ls = school?.leaveSettings || {};
    const off = new Map();
    for (let key = from; key <= to; key = addDays(key, 1)) {
        const d = keyDate(key);
        const dow = d.getUTCDay();
        if (dow === 0 || (dow === 6 && !days.saturdayWorking(d.getUTCDate(), ls))) { off.set(key, { status: 'weekend' }); continue; }
        const h = holidays.find((x) => applies(x) && days.covers(x.startDate, x.endDate, key));
        if (h) off.set(key, { status: 'holiday', label: h.name });
    }
    return off;
}

module.exports = { daysOff };
