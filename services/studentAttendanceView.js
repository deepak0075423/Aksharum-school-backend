'use strict';
/**
 * One student's attendance as they (or their parent) see it — the student's
 * Attendance page and the parent's Child Attendance page read the same answer.
 *
 * A month at a time: each day's status (rolled up across subject registers in
 * a subject-wise school), which days were holidays or never marked, the month
 * against the one before, the year so far with the student's standing in their
 * section, the alerts that apply, and their correction requests.
 *
 * Standing is a rank and the class average only — never another student's
 * name or figure, because a parent reads this too.
 */
const pool                 = require('../db/pool');
const AcademicYear         = require('../models/AcademicYear');
const Attendance           = require('../models/Attendance');
const AttendanceRecord     = require('../models/AttendanceRecord');
const AttendanceCorrection = require('../models/AttendanceCorrection');
const Class                = require('../models/Class');
const ClassSection         = require('../models/ClassSection');
const StudentProfile       = require('../models/StudentProfile');
const Subject              = require('../models/Subject');
const User                 = require('../models/User');
const sa                   = require('./studentAttendance');
const { daysOff }          = require('./schoolDays');
const { forStudent }       = require('./attendanceCorrections');
const { STREAK_ALERT, LOW_ATTENDANCE, LOW_MIN_MARKS } = require('./attendanceNotices');
const { localToday, keyDate, dateKey, addDays } = require('./staffAttendanceDays');

const T = (M) => `"${M.tableName}"`;
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthName = (y, m) => new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Days a marked day counts as, by its rolled-up status. */
function dayCounts(dayStatuses) {
    const c = { present: 0, late: 0, absent: 0, halfDay: 0, marked: 0 };
    for (const s of dayStatuses) {
        if (!s) continue;
        c.marked += 1;
        if (s === 'Present') c.present += 1;
        else if (s === 'Late') c.late += 1;
        else if (s === 'Absent') c.absent += 1;
        else if (s === 'Half-Day') c.halfDay += 1;
    }
    return c;
}

async function attendanceOverview({ schoolId, studentId, month }) {
    const today = localToday();
    const ym = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : today.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const from = `${ym}-01`;
    const to   = `${ym}-${pad(lastDay(y, m))}`;
    // This month runs to today and is compared with the same days of last month.
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    const isCurrent = ym === today.slice(0, 7);
    const upto = isCurrent ? Math.min(Number(today.slice(8)), lastDay(py, pm)) : lastDay(py, pm);
    const prev = { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(upto)}`, label: monthName(py, pm) };

    const [user, profile, mode, year] = await Promise.all([
        User.findOne({ _id: studentId, school: schoolId, role: 'student' }).select('name profileImage').lean(),
        StudentProfile.findOne({ user: studentId, school: schoolId }).select('currentSection currentClass rollNumber').lean(),
        sa.registrationMode(schoolId),
        AcademicYear.findOne({ school: schoolId, status: 'active' }).select('yearName startDate endDate').lean(),
    ]);
    if (!user) return null;

    const section = profile?.currentSection
        ? await ClassSection.findOne({ _id: profile.currentSection, school: schoolId }).select('sectionName class').lean() : null;
    const klass = (section?.class || profile?.currentClass)
        ? await Class.findById(section?.class || profile.currentClass).select('className').lean() : null;

    const yFrom = year?.startDate ? dateKey(year.startDate) : addDays(today, -365);
    const yTo   = year?.endDate ? dateKey(year.endDate) : today;
    const earliest = [prev.from, yFrom].sort()[0];
    const latest   = [to, yTo, today].sort().reverse()[0];

    // Every mark this student holds from the earliest window to the latest.
    const { rows: marks } = await pool.query(
        `SELECT r."status", r."remarks", a."_id" AS "attendance", a."subject", s."subjectName",
                to_char(a."date" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "key"
           FROM ${T(AttendanceRecord)} r
           JOIN ${T(Attendance)} a ON a."_id" = r."attendance"
           LEFT JOIN ${T(Subject)} s ON s."_id" = a."subject"
          WHERE r."student" = $1 AND a."date" >= $2 AND a."date" < $3`,
        [String(studentId), keyDate(earliest), keyDate(addDays(latest, 1))],
    );
    const inRange = (k, a, b) => k >= a && k <= b;

    // ── The month, day by day ──
    const byDay = new Map();
    for (const r of marks.filter((x) => inRange(x.key, from, to))) {
        if (!byDay.has(r.key)) byDay.set(r.key, []);
        byDay.get(r.key).push(r);
    }
    const [off, sectionDays] = await Promise.all([
        daysOff(schoolId, klass?.className || '', from, to),
        section ? pool.query(
            `SELECT DISTINCT to_char("date" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "key" FROM ${T(Attendance)}
              WHERE "section" = $1 AND "date" >= $2 AND "date" < $3`,
            [String(section._id), keyDate(from), keyDate(addDays(to, 1))]) : { rows: [] },
    ]);
    const registerTaken = new Set(sectionDays.rows.map((r) => r.key));

    const days = [];
    for (let key = from; key <= to; key = addDays(key, 1)) {
        const list = byDay.get(key);
        if (list?.length) {
            const single = list.length === 1 && !list[0].subject;
            days.push({
                key,
                state: sa.lowStatus(sa.rollup(list.map((x) => x.status))),
                remarks: single ? (list[0].remarks || '') : '',
                ...(single ? {} : {
                    registers: list.map((x) => ({
                        attendance: x.attendance, subject: x.subject || null,
                        subjectName: x.subjectName || (x.subject ? 'Subject' : 'Day register'),
                        status: sa.lowStatus(x.status), remarks: x.remarks || '',
                    })).sort((a, b) => a.subjectName.localeCompare(b.subjectName)),
                }),
                offLabel: off.get(key)?.label || '',
            });
        } else if (off.has(key)) {
            days.push({ key, state: off.get(key).status, label: off.get(key).label || '' });
        } else if (key <= today) {
            // A school day with nothing for this student: the register was not
            // taken, or was taken without them.
            days.push({ key, state: 'unmarked', registerTaken: registerTaken.has(key) });
        } else {
            days.push({ key, state: null });
        }
    }

    const rollupWindow = (a, b) => {
        const perDay = new Map();
        for (const r of marks.filter((x) => inRange(x.key, a, b))) {
            if (!perDay.has(r.key)) perDay.set(r.key, []);
            perDay.get(r.key).push(r.status);
        }
        return {
            marks: sa.tally(marks.filter((x) => inRange(x.key, a, b)).map((x) => x.status)),
            days: dayCounts([...perDay.values()].map((l) => sa.rollup(l))),
        };
    };
    const current  = rollupWindow(from, isCurrent ? today : to);
    const previous = rollupWindow(prev.from, prev.to);
    const notMarked = days.filter((d) => d.state === 'unmarked').length;

    // ── The year, and where the student stands in their section ──
    const yearWin = rollupWindow(yFrom, yTo);
    let standing = { rank: null, of: 0, classAverage: null };
    if (section) {
        const { rows: board } = await pool.query(
            `SELECT r."student"::text AS "student", count(*)::int AS "total",
                    sum(${sa.creditSql('r."status"')})::float AS "attended"
               FROM ${T(AttendanceRecord)} r
               JOIN ${T(Attendance)} a ON a."_id" = r."attendance"
              WHERE a."section" = $1 AND a."date" >= $2 AND a."date" < $3
              GROUP BY r."student"`,
            [String(section._id), keyDate(yFrom), keyDate(addDays(yTo, 1))],
        );
        const pcts = board.map((b) => ({ id: b.student, pct: sa.percentOf(b.attended, b.total) }))
            .sort((a, b) => b.pct - a.pct);
        const mine = pcts.find((p) => p.id === String(studentId));
        const totalMarks = board.reduce((n, b) => n + b.total, 0);
        const totalAttended = board.reduce((n, b) => n + b.attended, 0);
        standing = {
            rank: mine ? pcts.findIndex((p) => p.pct === mine.pct) + 1 : null,
            of: pcts.length,
            classAverage: sa.percentOf(totalAttended, totalMarks),
        };
    }

    // Absent school days in a row, counting back from the latest marked day.
    const perDayYear = new Map();
    for (const r of marks.filter((x) => inRange(x.key, yFrom, yTo))) {
        if (!perDayYear.has(r.key)) perDayYear.set(r.key, []);
        perDayYear.get(r.key).push(r.status);
    }
    let streak = 0;
    for (const k of [...perDayYear.keys()].sort().reverse()) {
        if (sa.rollup(perDayYear.get(k)) === 'Absent') streak += 1; else break;
    }

    const alerts = [];
    if (streak >= STREAK_ALERT) alerts.push({ kind: 'streak', count: streak });
    if (yearWin.marks.total >= LOW_MIN_MARKS && yearWin.marks.percentage < LOW_ATTENDANCE) {
        alerts.push({ kind: 'low', percentage: yearWin.marks.percentage, threshold: LOW_ATTENDANCE });
    }

    // ── Correction requests ──
    const requests = await AttendanceCorrection.find({ student: studentId, school: schoolId })
        .sort({ createdAt: -1 }).limit(40).lean();
    const shaped = await forStudent(requests);
    const monthAgo = new Date(); monthAgo.setMonth(monthAgo.getMonth() - 1);

    return {
        month: ym, today, mode, isCurrent,
        label: monthName(y, m),
        threshold: LOW_ATTENDANCE,
        canRequestFrom: `${monthAgo.getFullYear()}-${pad(monthAgo.getMonth() + 1)}-${pad(monthAgo.getDate())}`,
        student: {
            _id: String(studentId), name: user.name, photo: user.profileImage || '',
            rollNumber: profile?.rollNumber || '', className: klass?.className || '', sectionName: section?.sectionName || '',
        },
        days,
        summary: { ...current, notMarked },
        previous: { ...previous, label: prev.label },
        year: { label: year?.yearName || 'This year', ...yearWin, ...standing },
        streak, alerts,
        requests: {
            total: shaped.length,
            pending: shaped.filter((r) => r.status === 'pending').length,
            awaitingReply: shaped.filter((r) => r.awaitingReply).length,
            recent: shaped.slice(0, 3),
        },
    };
}

module.exports = { attendanceOverview };
