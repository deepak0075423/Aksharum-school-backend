'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Student attendance — the vocabulary and the counting rule, in one place.
//
//  Marks are stored capitalised: Present | Absent | Late | Half-Day. Every
//  screen that turns marks into a number asks here, so a Half-Day cannot count
//  as a full day on one page and as nothing on another.
//
//    credit   Present 1 · Late 1 · Half-Day ½ · Absent 0
//    percent  credit ÷ marks, rounded; null when there are no marks — "nothing
//             was taken" is not 0%.
//
//  Registration mode (School.attendanceSettings.registrationMode):
//    'day'      one register per section per day        (Attendance.subject null)
//    'subject'  one register per section per subject per day
//
//  Percentages count marks, so in subject mode each subject register is one
//  unit. A calendar shows one status per DAY, and a day holding several
//  registers is rolled up (rollup / rollupSql):
//    one mark                      → that mark
//    every mark Absent             → Absent
//    every mark Present            → Present
//    only Present and Late         → Late
//    anything else (some missed)   → Half-Day
// ─────────────────────────────────────────────────────────────────────────────
const School = require('../models/School');

const STATUSES = ['Present', 'Absent', 'Late', 'Half-Day'];
const CAP = {
    present: 'Present', absent: 'Absent', late: 'Late',
    'half-day': 'Half-Day', halfday: 'Half-Day', half_day: 'Half-Day', 'half day': 'Half-Day',
};
/** 'present' | 'Half-Day' | 'half_day' → the stored form; anything else → null. */
const capStatus = (s) => CAP[String(s || '').trim().toLowerCase()] || null;
/** The stored form → what clients use: 'present' | 'absent' | 'late' | 'half-day' | null. */
const lowStatus = (s) => (capStatus(s) ? capStatus(s).toLowerCase() : null);

const CREDIT = { Present: 1, Late: 1, 'Half-Day': 0.5, Absent: 0 };
const credit = (s) => CREDIT[capStatus(s)] ?? 0;

const percentOf = (attended, total) => (total ? Math.round((attended / total) * 100) : null);

/**
 * Counts for a list of marks (any casing).
 * `present` counts full attendance only (Present + Late, as before Half-Day
 * existed); `attended` is the credit the percentage is taken from.
 */
function tally(statuses) {
    const t = { total: 0, present: 0, absent: 0, late: 0, halfDay: 0, attended: 0 };
    for (const raw of statuses) {
        const s = capStatus(raw);
        if (!s) continue;
        t.total += 1;
        if (s === 'Present') t.present += 1;
        if (s === 'Late') { t.late += 1; t.present += 1; }
        if (s === 'Absent') t.absent += 1;
        if (s === 'Half-Day') t.halfDay += 1;
        t.attended += CREDIT[s];
    }
    t.percentage = percentOf(t.attended, t.total);
    return t;
}

/** One status for a day that may hold several registers (see header). */
function rollup(statuses) {
    const marks = statuses.map(capStatus).filter(Boolean);
    if (!marks.length) return null;
    if (marks.length === 1) return marks[0];
    if (marks.every((s) => s === 'Absent')) return 'Absent';
    if (marks.every((s) => s === 'Present')) return 'Present';
    if (marks.every((s) => s === 'Present' || s === 'Late')) return 'Late';
    return 'Half-Day';
}

/** SQL twins of credit() and rollup(), for queries that count in Postgres. */
const creditSql = (col) =>
    `(CASE ${col} WHEN 'Present' THEN 1 WHEN 'Late' THEN 1 WHEN 'Half-Day' THEN 0.5 ELSE 0 END)`;
const rollupSql = (col) => `(CASE
    WHEN count(${col}) = 0 THEN NULL
    WHEN count(${col}) = 1 THEN max(${col})
    WHEN bool_and(${col} = 'Absent') THEN 'Absent'
    WHEN bool_and(${col} = 'Present') THEN 'Present'
    WHEN bool_and(${col} IN ('Present', 'Late')) THEN 'Late'
    ELSE 'Half-Day' END)`;

// ── Registration mode ────────────────────────────────────────────────────────

const MODES = ['day', 'subject'];
const modeOf = (school) => (school?.attendanceSettings?.registrationMode === 'subject' ? 'subject' : 'day');

/** 'day' | 'subject' for this school; 'day' when never set. */
async function registrationMode(schoolId) {
    if (!schoolId) return 'day';
    const school = await School.findById(schoolId).select('attendanceSettings').lean();
    return modeOf(school);
}

/**
 * Group marks by calendar day and roll each day up. `rows` carry
 * `{ date, status, subject?, subjectName?, remarks?, attendance? }`; the answer
 * is one row per day, oldest first, with the registers behind it.
 */
function rollupByDay(rows) {
    const byDay = new Map();
    for (const r of rows) {
        const key = new Date(r.date).toISOString().slice(0, 10);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(r);
    }
    return [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, list]) => {
            const single = list.length === 1 && !list[0].subject;
            return {
                _id: list[0]._id,
                date: list[0].date,
                status: lowStatus(rollup(list.map((r) => r.status))),
                remarks: single ? (list[0].remarks || '') : '',
                ...(single ? {} : {
                    registers: list
                        .map((r) => ({
                            attendance: r.attendance, subject: r.subject || null,
                            subjectName: r.subjectName || (r.subject ? 'Subject' : 'Day register'),
                            status: lowStatus(r.status), remarks: r.remarks || '',
                        }))
                        .sort((a, b) => a.subjectName.localeCompare(b.subjectName)),
                }),
            };
        });
}

module.exports = {
    STATUSES, capStatus, lowStatus, credit, percentOf, tally, rollup, rollupByDay,
    creditSql, rollupSql, MODES, modeOf, registrationMode,
};
