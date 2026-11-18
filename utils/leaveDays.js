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

// The label a LeaveBalance row stores in `academicYear`. Everything that has to
// match one of those rows — carry forward, allocation, accrual — must derive the
// string the same way, so it lives in one function.
function academicYearLabel(ay) {
    if (!ay) return null;
    if (ay.yearName) return ay.yearName;
    const y = new Date(ay.startDate || ay.createdAt).getFullYear();
    return `${y}-${String(y + 1).slice(-2)}`;
}

async function getActiveAcademicYearLabel(schoolId) {
    const ay = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    return academicYearLabel(ay);
}

/**
 * The balance before it is floored at zero. Negative once an overdraft has been
 * taken, and the overdraft cap has to be measured from here — measured from the
 * floored figure, every application could overdraw the full cap again.
 *
 * `expired` is what lapsed (comp off validity, a closed year, an exit);
 * `carriedOut` is what carry-forward moved into the next year. Both are gone
 * from this year.
 */
function rawRemainingOf(bal) {
    if (!bal) return 0;
    return (bal.totalAllocated || 0) + (bal.carriedForward || 0)
        - (bal.used || 0) - (bal.pending || 0) - (bal.expired || 0) - (bal.carriedOut || 0);
}

// Single definition of "days this employee can still spend".
function remainingOf(bal) {
    return Math.max(0, Math.round(rawRemainingOf(bal) * 100) / 100);
}

const utcMidnight = (d) => {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x;
};

/**
 * Today, as the UTC midnight of the school's own calendar day.
 *
 * Leave dates are stored as UTC midnight of the day picked. `utcMidnight(new
 * Date())` is the UTC calendar day instead, which between 00:00 and 05:30 IST is
 * still yesterday — so "no past dates" let yesterday through every night.
 * config/timezone.js pins the process to the school's zone, so the local
 * getters here are the school's calendar.
 */
function localToday(d = new Date()) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return new Date(`${key}T00:00:00.000Z`);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY_MS);

/**
 * Every day in [from, to] with what it is worth as a working day:
 *   { iso, weight, kind }  — weight 1 for a working day, 0.5 for a half-day
 *                            Saturday, 0 for a weekly off or a staff holiday;
 *                            kind 'work' | 'sunday' | 'weekly_off' | 'holiday'.
 * The one place leave, its preview, the sandwich rule and the "do these two
 * applications touch?" test all read a day's kind from.
 */
async function dayKinds(from, to, schoolId, leaveSettings = {}, holidayModule = false) {
    const start = utcMidnight(from);
    const end   = utcMidnight(to);
    const holidays = new Set();
    if (holidayModule && end >= start) {
        for (const h of await staffHolidaysInRange(start, end, schoolId)) {
            const cur = utcMidnight(h.startDate);
            const last = utcMidnight(h.endDate);
            while (cur <= last) { holidays.add(isoDay(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
        }
    }
    const out = [];
    const cur = new Date(start);
    while (cur <= end) {
        const dow = cur.getUTCDay();
        const iso = isoDay(cur);
        let weight = 1;
        let kind = 'work';
        if (dow === 0) { weight = 0; kind = 'sunday'; }
        else if (dow === 6) {
            weight = isSaturdayWorking(cur, leaveSettings) ? (leaveSettings.saturdayHalfDay ? 0.5 : 1) : 0;
            if (!weight) kind = 'weekly_off';
        }
        if (weight > 0 && holidays.has(iso)) { weight = 0; kind = 'holiday'; }
        out.push({ iso, weight, kind });
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}

/**
 * True when every day strictly between `a` and `b` (exclusive both ends) is a
 * weekly off or a holiday — i.e. two leaves ending on `a` and starting on `b`
 * leave no working day between them, so they are one absence.
 */
async function onlyOffDaysBetween(a, b, schoolId, leaveSettings, holidayModule) {
    const first = addDays(utcMidnight(a), 1);
    const last  = addDays(utcMidnight(b), -1);
    if (last < first) return true;
    // A gap longer than a fortnight always holds a working day.
    if ((last - first) / DAY_MS > 14) return false;
    const days = await dayKinds(first, last, schoolId, leaveSettings, holidayModule);
    return days.every((d) => d.weight === 0);
}

/**
 * The academic year a leave belongs to, decided by its dates.
 *
 * Every balance move used to resolve "whichever year is active right now", so
 * April leave filed in March drew on the old year. A leave that runs across a
 * year boundary is refused — each year's balance is a separate entitlement and
 * the employee files one application per year.
 *
 * Returns { label, startDate, endDate } or { error }. A school that has never
 * recorded an academic year falls back to the active label (none → error).
 */
async function leaveYearFor(schoolId, from, to) {
    const rows = await AcademicYear.find({ school: schoolId }).lean();
    if (!rows.length) return { error: 'No active academic year' };
    const f = utcMidnight(from);
    const t = utcMidnight(to || from);
    const holding = (d) => rows.find((y) => y.startDate && y.endDate
        && utcMidnight(y.startDate) <= d && utcMidnight(y.endDate) >= d);
    const yr = holding(f);
    if (!yr) {
        return { error: `No academic year covers ${f.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} — add the year first` };
    }
    const label = academicYearLabel(yr);
    const end = holding(t);
    if (!end || academicYearLabel(end) !== label) {
        return {
            error: `This leave runs past the end of ${label} (${isoDay(yr.endDate)}). `
                + 'Apply for the days in each academic year separately.',
        };
    }
    return { label, startDate: yr.startDate, endDate: yr.endDate };
}

/** The date window of one academic year, by its label. */
async function yearWindow(schoolId, label) {
    if (!label) return null;
    const rows = await AcademicYear.find({ school: schoolId }).lean();
    const yr = rows.find((y) => academicYearLabel(y) === label);
    return yr ? { label, startDate: yr.startDate, endDate: yr.endDate, status: yr.status } : null;
}

module.exports = {
    academicYearLabel,
    normalizeLeaveSettings,
    isSaturdayWorking,
    countWorkingDays,
    countCalendarDays,
    countHolidayWorkingDays,
    staffHolidaysInRange,
    getActiveAcademicYearLabel,
    remainingOf,
    rawRemainingOf,
    utcMidnight,
    localToday,
    isoDay,
    addDays,
    dayKinds,
    onlyOffDaysBetween,
    leaveYearFor,
    yearWindow,
};
