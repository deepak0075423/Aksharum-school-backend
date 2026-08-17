'use strict';
// Working-day / weekly-off arithmetic shared by the leave controller and the
// Comp Off engine. Both need the exact same answer to "is this date a working
// day for this school?" — keeping one copy is what stops leave and comp off
// from disagreeing about a Saturday.
const Holiday      = require('../models/Holiday');
const AcademicYear = require('../models/AcademicYear');

// Always returns a complete leaveSettings object — fills in schema defaults for
// any field absent from older rows (lean() reads return raw columns without defaults).
function normalizeLeaveSettings(ls = {}) {
    return {
        saturdayWorking: ls.saturdayWorking !== false,           // default true
        saturdayMode:    ls.saturdayMode    || 'all',            // default 'all'
        saturdayHalfDay: !!ls.saturdayHalfDay,                  // default false
    };
}

// Returns true if the given date (a Saturday) is a working day per leaveSettings
function isSaturdayWorking(date, leaveSettings = {}) {
    const { saturdayWorking = true, saturdayMode = 'all' } = leaveSettings;
    if (!saturdayWorking) return false;
    if (saturdayMode === 'all') return true;
    const nth = Math.ceil(date.getUTCDate() / 7);
    if (saturdayMode === '1_3_5') return nth % 2 === 1;
    if (saturdayMode === '2_4')   return nth % 2 === 0;
    return true;
}

function countWorkingDays(from, to, leaveSettings = {}) {
    const { saturdayHalfDay = false } = leaveSettings;
    let days = 0;
    const cur = new Date(from);
    cur.setUTCHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setUTCHours(0, 0, 0, 0);
    while (cur <= end) {
        const dow = cur.getUTCDay();
        if (dow === 6) {
            if (isSaturdayWorking(cur, leaveSettings)) days += saturdayHalfDay ? 0.5 : 1;
        } else if (dow !== 0) {
            days += 1;
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
}

// Every school holiday overlapping [from, to] that applies to staff.
async function staffHolidaysInRange(from, to, schoolId) {
    return Holiday.find({
        school: schoolId,
        startDate: { $lte: to },
        endDate:   { $gte: from },
        $or: [
            { 'applicability.scope': 'all' },
            { 'applicability.departments': 'teaching_staff' },
        ],
    }).lean();
}

// Returns the number of working days within [from, to] that are school holidays
// (applicable to 'all' or 'teaching_staff'). Uses a Set to avoid double-counting.
async function countHolidayWorkingDays(from, to, schoolId, leaveSettings) {
    const holidays = await staffHolidaysInRange(from, to, schoolId);

    const holidaySet = new Set();
    for (const h of holidays) {
        const hStart = new Date(h.startDate); hStart.setUTCHours(0, 0, 0, 0);
        const hEnd   = new Date(h.endDate);   hEnd.setUTCHours(0, 0, 0, 0);
        const rangeStart = hStart < from ? from : hStart;
        const rangeEnd   = hEnd   > to   ? to   : hEnd;
        const cur = new Date(rangeStart);
        while (cur <= rangeEnd) {
            const dow = cur.getUTCDay();
            if (dow === 6) {
                if (isSaturdayWorking(cur, leaveSettings)) holidaySet.add(cur.toISOString().slice(0, 10));
            } else if (dow !== 0) {
                holidaySet.add(cur.toISOString().slice(0, 10));
            }
            cur.setUTCDate(cur.getUTCDate() + 1);
        }
    }
    return holidaySet.size;
}

// Every calendar day in [from, to] inclusive. This is what the "sandwich rule"
// charges: a weekend or holiday falling between two leave days is consumed as
// leave rather than skipped over.
function countCalendarDays(from, to) {
    const start = new Date(from); start.setUTCHours(0, 0, 0, 0);
    const end   = new Date(to);   end.setUTCHours(0, 0, 0, 0);
    if (end < start) return 0;
    return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

async function getActiveAcademicYearLabel(schoolId) {
    const ay = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    if (!ay) return null;
    if (ay.yearName) return ay.yearName;
    const y = new Date(ay.startDate || ay.createdAt).getFullYear();
    return `${y}-${String(y + 1).slice(-2)}`;
}

// Single definition of "days this employee can still spend". `expired` is the
// comp-off lapse counter — it is 0 for every other leave type, so this formula
// is identical to the historical one everywhere else.
function remainingOf(bal) {
    if (!bal) return 0;
    return Math.max(0,
        (bal.totalAllocated || 0) + (bal.carriedForward || 0)
        - (bal.used || 0) - (bal.pending || 0) - (bal.expired || 0));
}

const utcMidnight = (d) => {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x;
};

module.exports = {
    normalizeLeaveSettings,
    isSaturdayWorking,
    countWorkingDays,
    countCalendarDays,
    countHolidayWorkingDays,
    staffHolidaysInRange,
    getActiveAcademicYearLabel,
    remainingOf,
    utcMidnight,
};
