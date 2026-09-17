'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  What a staff member's day was — derived, never hand-picked.
//
//  Staff attendance stores only punches (TeacherAttendance). Everything else a
//  calendar shows is worked out from four sources: the punch, approved leave,
//  the school's holidays, and which Saturdays it works. A past working day with
//  none of those is absent automatically.
//
//  This used to live inside attendance.controller as a one-person, one-month
//  loop. The admin attendance screen now asks the same question for a calendar
//  grid that spills into the neighbouring months, for "this year", and for every
//  member of staff at once in the reports tab — so the rule lives here, once,
//  and the queries are batched: one round of four queries covers any number of
//  people over any range, rather than four queries per person per month.
// ─────────────────────────────────────────────────────────────────────────────
const TeacherAttendance = require('../models/TeacherAttendance');
const LeaveApplication  = require('../models/LeaveApplication');
const Holiday           = require('../models/Holiday');
const School            = require('../models/School');

/** 'YYYY-MM-DD' of the server's LOCAL calendar day. */
function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** UTC midnight of a 'YYYY-MM-DD' key — how every attendance date is stored. */
const keyDate = (key) => new Date(`${key}T00:00:00.000Z`);
/** The key a stored date belongs to (stored dates are UTC midnight). */
const dateKey = (d) => new Date(d).toISOString().slice(0, 10);

function addDays(key, n) {
    const d = keyDate(key);
    d.setUTCDate(d.getUTCDate() + n);
    return dateKey(d);
}

/** Is this Saturday a working day under the school's leave settings? */
function saturdayWorking(dayOfMonth, ls = {}) {
    if (ls.saturdayWorking === false) return false;
    const ordinal = Math.ceil(dayOfMonth / 7); // 1st..5th Saturday of the month
    if (ls.saturdayMode === '1_3_5') return [1, 3, 5].includes(ordinal);
    if (ls.saturdayMode === '2_4')   return [2, 4].includes(ordinal);
    return true; // 'all'
}

// A stored range [from, to] covers a day when the day falls between their
// calendar dates — both ends are dates, whatever time they were saved with.
const covers = (from, to, key) => dateKey(from) <= key && key <= dateKey(to);

/** Holidays that apply to staff in this department. */
const staffHolidays = (holidays, dept) => holidays.filter((h) =>
    !h.applicability || h.applicability.scope !== 'specific_departments'
    || (h.applicability.departments || []).includes(dept));

const departmentOf = (role) => (role === 'teacher' ? 'teaching_staff' : 'admin_staff');

/**
 * Everything the classifier needs for these people over [from, to], in four
 * queries whatever the head count.
 *
 * @param {String}   schoolId
 * @param {String[]} userIds
 * @param {String}   from  'YYYY-MM-DD'
 * @param {String}   to    'YYYY-MM-DD'
 */
async function loadInputs(schoolId, userIds, from, to) {
    const start = keyDate(from);
    const end   = new Date(`${to}T23:59:59.999Z`);
    const ids   = userIds.map(String);

    const [records, leaves, holidays, school] = await Promise.all([
        ids.length
            ? TeacherAttendance.find({ teacher: { $in: ids }, date: { $gte: start, $lte: end } }).lean()
            : [],
        ids.length
            ? LeaveApplication.find({
                teacher: { $in: ids }, school: schoolId, status: 'approved',
                fromDate: { $lte: end }, toDate: { $gte: start },
            }).populate('leaveType', 'name').lean().catch(() => [])
            : [],
        Holiday.find({
            school: schoolId, startDate: { $lte: end }, endDate: { $gte: start },
        }).lean().catch(() => []),
        School.findById(schoolId).select('leaveSettings').lean(),
    ]);

    const recordsBy = new Map();
    for (const r of records) recordsBy.set(`${r.teacher}|${dateKey(r.date)}`, r);
    const leavesBy = new Map();
    for (const l of leaves) {
        const k = String(l.teacher);
        if (!leavesBy.has(k)) leavesBy.set(k, []);
        leavesBy.get(k).push(l);
    }
    return { recordsBy, leavesBy, holidays, leaveSettings: school?.leaveSettings || {} };
}

/**
 * The first day each person's attendance can be owed: their joining date where
 * the profile records one, otherwise the day their account was created. Before
 * it a working day is not an absence — nobody can miss a school they had not
 * joined, and counting it would make "this year against last year" compare a
 * member of staff with the eleven months before they arrived.
 */
async function startDates(schoolId, userIds) {
    const User           = require('../models/User');
    const TeacherProfile = require('../models/TeacherProfile');
    const ids = userIds.map(String);
    if (!ids.length) return new Map();
    const [users, profiles] = await Promise.all([
        User.find({ _id: { $in: ids }, school: schoolId }).select('_id createdAt').lean(),
        TeacherProfile.find({ user: { $in: ids } }).select('user joiningDate').lean(),
    ]);
    const joined = new Map(profiles.filter((p) => p.joiningDate).map((p) => [String(p.user), dateKey(p.joiningDate)]));
    const localKey = (d) => {
        const x = new Date(d);
        return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };
    return new Map(users.map((u) => [String(u._id), joined.get(String(u._id)) || (u.createdAt ? localKey(u.createdAt) : null)]));
}

/**
 * One person's days over [from, to].
 *
 * Returns `{ days, summary, today }`:
 *  - days: `{ key, day, date, status, label?, checkIn?, checkOut? }` where status
 *    is present | absent | leave | half-day | holiday | weekend | pending
 *    (today, not clocked in) | null (a future working day)
 *  - summary: counts of present / absent / leave / half-day / holiday
 *  - today: the clock state, when today falls inside the range
 *
 * `since` ('YYYY-MM-DD', optional) is the first day attendance is owed — pass
 * it from startDates(). The original month calendar does not, and is unchanged.
 */
function classify(inputs, { userId, role, since = null }, from, to) {
    const { recordsBy, leavesBy, holidays, leaveSettings } = inputs;
    const uid      = String(userId);
    const today    = localToday();
    const leaves   = leavesBy.get(uid) || [];
    const hols     = staffHolidays(holidays, departmentOf(role));
    const leaveOn  = (key) => leaves.find((l) => covers(l.fromDate, l.toDate, key));

    const days    = [];
    const summary = { present: 0, absent: 0, leave: 0, 'half-day': 0, holiday: 0 };

    for (let key = from; key <= to; key = addDays(key, 1)) {
        const date = keyDate(key);
        const dow  = date.getUTCDay();
        const day  = date.getUTCDate();
        const entry = { key, day, date, status: null };

        const holiday = hols.find((h) => covers(h.startDate, h.endDate, key));
        if (dow === 0 || (dow === 6 && !saturdayWorking(day, leaveSettings))) {
            entry.status = 'weekend';
        } else if (holiday) {
            entry.status = 'holiday';
            entry.label  = holiday.name;
            summary.holiday++;
        } else {
            const rec   = recordsBy.get(`${uid}|${key}`);
            const leave = leaveOn(key);
            // A clock-in, or an approved regularization (status Present), counts as present
            if (rec?.checkIn || (rec && rec.status === 'Present')) {
                entry.status   = 'present';
                entry.checkIn  = rec.checkIn || '';
                entry.checkOut = rec.checkOut || '';
                // How the day came to be recorded: clocked by the teacher, or
                // written by an approved or direct regularization.
                entry.remarks  = rec.remarks || '';
                entry.source   = /^Regulari[sz]ed/i.test(rec.remarks || '') ? 'regularized' : 'clock';
                summary.present++;
            } else if (leave) {
                entry.status = leave.leaveMode === 'half_day' ? 'half-day' : 'leave';
                entry.label  = leave.leaveType?.name || 'Leave';
                summary[entry.status]++;
            } else if (key < today) {
                entry.status = 'absent';   // auto-absent: past working day, never clocked in
                summary.absent++;
            } else if (key === today) {
                entry.status = 'pending';  // today, not clocked in yet
            }
            // future working days stay null
        }
        // Before `since` (see startDates) nothing is owed: an absence, leave or
        // holiday there is not one of theirs. A punch that exists still counts.
        if (since && key < since && entry.status && !['weekend', 'present'].includes(entry.status)) {
            if (entry.status in summary) summary[entry.status]--;
            entry.status = null;
            delete entry.label;
        }
        days.push(entry);
    }

    let todayState = null;
    if (from <= today && today <= to) {
        const rec   = recordsBy.get(`${uid}|${today}`);
        const leave = leaveOn(today);
        todayState = {
            clockedIn:  !!rec?.checkIn,
            clockedOut: !!rec?.checkOut,
            checkIn:    rec?.checkIn  || '',
            checkOut:   rec?.checkOut || '',
            onLeave:    !!leave,
            leaveLabel: leave ? (leave.leaveType?.name || 'Leave') : '',
        };
    }

    return { days, summary, today: todayState };
}

/**
 * Attendance rate over the days that were owed: holidays and full-day leave are
 * not days anyone failed to turn up for, so they stay out of the divisor, and a
 * half-day leave counts half. The same rule the teacher dashboard applies.
 * Null when nothing was owed — "no working days yet" is not 0%.
 */
function percentOf(summary) {
    if (!summary) return null;
    const half    = summary['half-day'] || 0;
    const counted = (summary.present || 0) + (summary.absent || 0) + half;
    if (!counted) return null;
    return Math.round((((summary.present || 0) + half * 0.5) / counted) * 100);
}

/** One person over one range — the common case. */
async function staffDays({ schoolId, userId, role, since = null }, from, to) {
    const inputs = await loadInputs(schoolId, [userId], from, to);
    return classify(inputs, { userId, role, since }, from, to);
}

module.exports = {
    localToday, keyDate, dateKey, addDays, saturdayWorking, covers,
    loadInputs, classify, staffDays, percentOf, startDates,
};
