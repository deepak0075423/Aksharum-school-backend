'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Everything the leave module writes into OTHER modules.
//
//  THE RULE FOR THIS FILE: every entry point is gated on the target module's own
//  School.modules flag. When that module is off for a school, the call returns
//  without touching anything and the leave module behaves exactly as it did
//  before the integration existed — same balances, same statuses, same
//  responses. A school that does not run Attendance must not see leave change
//  because Attendance exists somewhere else.
//
//  Every function is also best-effort: a downstream failure is logged and
//  swallowed. Marking an attendance register must never be the reason an
//  approval fails, because the approval is the thing that actually matters.
// ─────────────────────────────────────────────────────────────────────────────
const School = require('../models/School');
const { schoolModuleFlags } = require('../config/modules');
const {
    normalizeLeaveSettings, isSaturdayWorking, staffHolidaysInRange,
} = require('../utils/leaveDays');

/** Flags + leave settings for a school, in one read. */
async function contextFor(schoolId) {
    const school = await School.findById(schoolId).select('modules leaveSettings').lean();
    return {
        flags: schoolModuleFlags(school),
        leaveSettings: normalizeLeaveSettings(school?.leaveSettings),
    };
}

const isoDay   = (d) => new Date(d).toISOString().slice(0, 10);
const dayStart = (iso) => new Date(`${iso}T00:00:00.000Z`);
const dayEnd   = (iso) => new Date(`${iso}T23:59:59.999Z`);

/** Working days in [from, to] as YYYY-MM-DD, weekly offs and holidays removed. */
async function workingDatesIn(from, to, schoolId, leaveSettings, skipHolidays) {
    const holidaySet = new Set();
    if (skipHolidays) {
        for (const h of await staffHolidaysInRange(from, to, schoolId)) {
            const cur = new Date(h.startDate); cur.setUTCHours(0, 0, 0, 0);
            const end = new Date(h.endDate);   end.setUTCHours(0, 0, 0, 0);
            while (cur <= end) { holidaySet.add(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
        }
    }
    const out = [];
    const cur = new Date(from); cur.setUTCHours(0, 0, 0, 0);
    const end = new Date(to);   end.setUTCHours(0, 0, 0, 0);
    while (cur <= end) {
        const dow = cur.getUTCDay();
        const key = cur.toISOString().slice(0, 10);
        const weekly = dow === 0 || (dow === 6 && !isSaturdayWorking(cur, leaveSettings));
        if (!weekly && !holidaySet.has(key)) out.push(key);
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}

// ── Attendance ───────────────────────────────────────────────────────────────

/**
 * Write a `Leave` attendance row for each working day an approved leave covers.
 *
 * TeacherAttendance has always carried a `Leave` status that nothing ever wrote,
 * so an approved leave day was neither present nor absent and every attendance
 * percentage over that range was computed against a hole.
 *
 * No-op when the Attendance module is off for the school.
 */
async function markAttendanceForLeave(app, schoolId, ctx = null) {
    try {
        const { flags, leaveSettings } = ctx || await contextFor(schoolId);
        if (!flags.attendance) return { skipped: 'attendance-disabled' };

        const TeacherAttendance = require('../models/TeacherAttendance');
        const dates = await workingDatesIn(app.fromDate, app.toDate, schoolId, leaveSettings, flags.holiday);
        if (!dates.length) return { marked: 0 };

        // One read for the whole range rather than two per day — a month-long
        // leave was otherwise sixty round trips.
        const existing = await TeacherAttendance.find({
            teacher: app.teacher, school: schoolId,
            date: { $gte: dayStart(dates[0]), $lte: dayEnd(dates[dates.length - 1]) },
        }).lean();
        const byDate = new Map(existing.map(r => [isoDay(r.date), r]));

        const status = app.leaveMode === 'half_day' ? 'Half-Day' : 'Leave';
        let marked = 0;
        for (const d of dates) {
            // Never overwrite a real presence record — if someone actually
            // clocked in that day, that fact outranks the leave.
            if (byDate.get(d)?.checkIn) continue;

            await TeacherAttendance.findOneAndUpdate(
                { teacher: app.teacher, school: schoolId, date: { $gte: dayStart(d), $lte: dayEnd(d) } },
                {
                    $set: { status, remarks: `Leave: ${app.reason || ''}`.slice(0, 200) },
                    $setOnInsert: { teacher: app.teacher, school: schoolId, date: dayStart(d) },
                },
                { upsert: true },
            );
            marked += 1;
        }
        return { marked };
    } catch (err) {
        console.error('[leave\u2192attendance] mark failed:', err.message);
        return { error: err.message };
    }
}

/** Undo the rows markAttendanceForLeave wrote. No-op when Attendance is off. */
async function clearAttendanceForLeave(app, schoolId, ctx = null) {
    try {
        const { flags, leaveSettings } = ctx || await contextFor(schoolId);
        if (!flags.attendance) return { skipped: 'attendance-disabled' };

        const TeacherAttendance = require('../models/TeacherAttendance');
        const dates = await workingDatesIn(app.fromDate, app.toDate, schoolId, leaveSettings, flags.holiday);
        if (!dates.length) return { cleared: 0 };

        const rows = await TeacherAttendance.find({
            teacher: app.teacher, school: schoolId,
            status: { $in: ['Leave', 'Half-Day'] },
            date: { $gte: dayStart(dates[0]), $lte: dayEnd(dates[dates.length - 1]) },
        }).lean();

        // Only rows this integration owns. `checkIn` defaults to '' rather than
        // null, so emptiness is tested here rather than in the query — a filter
        // on null silently matched nothing and left every row behind.
        const wanted = new Set(dates);
        const mine = rows.filter(r => !r.checkIn && wanted.has(isoDay(r.date)));
        let cleared = 0;
        for (const r of mine) {
            const res = await TeacherAttendance.deleteOne({ _id: r._id });
            cleared += res.deletedCount || 0;
        }
        return { cleared };
    } catch (err) {
        console.error('[leave\u2192attendance] clear failed:', err.message);
        return { error: err.message };
    }
}

// ── Substitute cover ─────────────────────────────────────────────────────────

/**
 * Ask the substitute engine to find cover for the days an approval just freed.
 *
 * Substitute cover lives inside the Timetable module and has no flag of its
 * own, so that is what gates this. Previously the engine only ever pulled —
 * approving leave for tomorrow told nobody, and the gap surfaced when a class
 * went unattended.
 *
 * Sweeps only future dates: back-dated leave has no cover to arrange.
 */
async function requestSubstituteCover(app, schoolId, ctx = null) {
    try {
        const { flags, leaveSettings } = ctx || await contextFor(schoolId);
        if (!flags.timetable) return { skipped: 'timetable-disabled' };

        const substitute = require('./substituteService');

        const today = new Date(); today.setUTCHours(0, 0, 0, 0);
        const dates = (await workingDatesIn(app.fromDate, app.toDate, schoolId, leaveSettings, flags.holiday))
            .filter(d => new Date(`${d}T00:00:00.000Z`) >= today)
            .slice(0, 31);   // a sane ceiling for one approval

        // Deliberately not forced: runAutoAssign honours the school's own
        // autoAssign setting, so a school that arranges cover by hand still
        // only gets the requirement rows raised, never an automatic assignment.
        let swept = 0;
        let assigned = 0;
        for (const d of dates) {
            const r = await substitute.runAutoAssign(schoolId, d);
            assigned += r?.assigned || 0;
            swept += 1;
        }
        return { sweptDates: swept, assigned };
    } catch (err) {
        console.error('[leave→substitute] sweep failed:', err.message);
        return { error: err.message };
    }
}

module.exports = {
    contextFor,
    workingDatesIn,
    markAttendanceForLeave,
    clearAttendanceForLeave,
    requestSubstituteCover,
};
