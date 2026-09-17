'use strict';
/**
 * Teacher → Attendance: the registers a teacher takes, their class ranking and
 * the students' correction requests.
 *
 * Who may do what is services/attendanceScope.js — one register per section per
 * day in a day-wise school, one per subject per day in a subject-wise one — and
 * how marks become numbers is services/studentAttendance.js. Every handler here
 * checks the section (and subject) it is given against the scope; ids from the
 * client are never trusted.
 *
 * Dates: a register is stored at UTC midnight of its LOCAL calendar day and
 * every window is built from local 'YYYY-MM-DD' keys (staffAttendanceDays).
 */
const pool                 = require('../db/pool');
const { isUuid }           = require('../db/schema');
const Attendance           = require('../models/Attendance');
const AttendanceRecord     = require('../models/AttendanceRecord');
const AttendanceCorrection = require('../models/AttendanceCorrection');
const Subject              = require('../models/Subject');
const User                 = require('../models/User');
const { saveSectionMarks } = require('../services/attendanceMarks');
const { daysOff }          = require('../services/schoolDays');
const notices              = require('../services/attendanceNotices');
const {
    attendanceScope, pickRegister, holdsRegister, sectionStudents,
} = require('../services/attendanceScope');
const {
    capStatus, lowStatus, tally, rollup,
} = require('../services/studentAttendance');
const days = require('../services/staffAttendanceDays');

const { localToday, keyDate, dateKey, addDays } = days;
const T = (Model) => `"${Model.tableName}"`;

const ok  = (res, d, s = 200) => res.status(s).json({ success: true, data: d });
const err = (res, e, s = 500) => res.status(s).json({ success: false, message: e.message || e });

const isKey  = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const uuidOr = (v) => (isUuid(String(v || '')) ? String(v) : null);
const low    = (s) => (s == null ? null : String(s).toLowerCase());
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The section as a client shows it: everything but the subject list's internals. */
const sectionOut = (s) => (s ? {
    _id: s._id, label: s.label, className: s.className, classNumber: s.classNumber,
    sectionName: s.sectionName, role: s.role, roleLabel: s.roleLabel,
    classTeacher: s.classTeacher, students: s.students,
} : null);
const subjectOut = (s) => (s ? { _id: s._id, name: s.name, mine: s.mine, days: s.days } : null);

// ═══════════════════════════════════════════════════════════════════════════
//  GET /teacher/attendance?section=&subject=&date=
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One register: the students, their marks and remarks, and what the page needs
 * around them — the sections (and in a subject-wise school the subjects) this
 * teacher may take, whether the day is a holiday, and who opened the register.
 *
 * The original contract — `students` (with `user`), `records`, `sections`,
 * `section`, `refused` — is kept for the mobile app.
 */
exports.register = async (req, res) => {
    try {
        const today = localToday();
        const date  = isKey(req.query.date) ? String(req.query.date) : today;
        const scope = await attendanceScope(req.schoolId, req.userId);
        const sections = scope.sections.map(sectionOut);

        const pick = pickRegister(scope, uuidOr(req.query.section), uuidOr(req.query.subject));
        if (pick.error || !pick.section) {
            return ok(res, {
                mode: scope.mode, date, students: [], records: [], sections, section: null,
                subjects: [], subject: null, session: null,
                ...(req.query.section || req.query.subject ? { refused: pick.error } : {}),
            });
        }
        const { section, subject } = pick;
        if (scope.mode === 'subject' && !subject) {
            return ok(res, {
                mode: scope.mode, date, students: [], records: [], sections, section: sectionOut(section),
                subjects: [], subject: null, session: null,
            });
        }

        const [students, session, off] = await Promise.all([
            sectionStudents(req.schoolId, section._id),
            Attendance.findOne({
                section: section._id,
                date: { $gte: keyDate(date), $lt: keyDate(addDays(date, 1)) },
                subject: subject ? subject._id : null,
            }).lean(),
            daysOff(req.schoolId, section.className, date, date),
        ]);
        const records = session
            ? await AttendanceRecord.find({ attendance: session._id }).select('student status remarks markedAt markedBy').lean()
            : [];
        const author = session?.createdBy ? await User.findById(session.createdBy).select('name').lean() : null;

        ok(res, {
            mode: scope.mode,
            date,
            future: date > today,
            dayOff: off.get(date) || null,
            sections,
            section: sectionOut(section),
            subjects: section.subjects.map(subjectOut),
            subject: subjectOut(subject),
            session: session ? { _id: session._id, createdAt: session.createdAt, createdBy: author?.name || '' } : null,
            students: students.map((s) => ({
                _id: s._id, name: s.name, photo: s.photo, rollNumber: s.rollNumber || '',
                user: { _id: s._id, name: s.name },
            })),
            records: records.map((r) => ({ ...r, status: lowStatus(r.status) })),
        });
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  POST /teacher/attendance/mark   { date, section, subject?, records: [{ studentId, status, remarks? }] }
// ═══════════════════════════════════════════════════════════════════════════

exports.mark = async (req, res) => {
    try {
        const { date, records } = req.body;
        if (!date || !Array.isArray(records)) return err(res, 'date and records are required', 400);
        const day = String(date).slice(0, 10);
        if (!isKey(day)) return err(res, 'date must be YYYY-MM-DD', 400);
        if (day > localToday()) return err(res, 'Attendance cannot be marked for a future date', 400);

        const scope = await attendanceScope(req.schoolId, req.userId);
        const pick = pickRegister(scope, uuidOr(req.body.section || req.body.sectionId), uuidOr(req.body.subject),
            { requireSubject: true });
        if (pick.error) return err(res, pick.error, 403);

        // Marks only for students of this section — the register is theirs.
        const roster = new Set((await sectionStudents(req.schoolId, pick.section._id)).map((s) => String(s._id)));
        const input = records.filter((r) => roster.has(String(r.studentId)));
        const refused = records.length - input.length;

        const { records: saved, changed } = await saveSectionMarks({
            schoolId:  req.schoolId,
            sectionId: pick.section._id,
            subjectId: pick.subject?._id || null,
            date:      day,
            // An unknown status has always been recorded as absent here (the
            // mobile register sends every row, unmarked ones as 'absent').
            records:   input.map((r) => ({
                studentId: r.studentId,
                status: capStatus(r.status) || 'Absent',
                remarks: r.remarks === undefined ? undefined : String(r.remarks || ''),
            })),
            actor: { userId: req.userId, role: req.userRole || 'teacher' },
        });
        saved.forEach((r) => { r.status = lowStatus(r.status); });
        // The array is the original response; the counts ride on the envelope.
        res.json({ success: true, data: saved, changed: changed.length, refused });
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  GET /teacher/attendance/calendar?section=&subject=&month=YYYY-MM
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One month of a register, a day at a time — the calendar beside Mark Students.
 *
 * A marked day is coloured by its worst mark: someone absent → 'absent', else
 * someone on a half day → 'half-day', else someone late → 'late', else
 * 'present' (everyone attended). A past working day with no register is
 * 'unmarked'; in a subject-wise school only on the weekdays the timetable
 * schedules that subject, so a subject taught twice a week is not "missed" on
 * the other three.
 */
exports.calendar = async (req, res) => {
    try {
        const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : localToday().slice(0, 7);
        const scope = await attendanceScope(req.schoolId, req.userId);
        const pick = pickRegister(scope, uuidOr(req.query.section), uuidOr(req.query.subject));
        if (pick.error || !pick.section) return ok(res, { month, days: [] });

        const [y, m] = month.split('-').map(Number);
        const from = `${month}-01`;
        const to   = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
        const today = localToday();

        const p = [String(pick.section._id), keyDate(from), keyDate(addDays(to, 1))];
        let subjectFilter = '';
        if (scope.mode === 'subject') {
            p.push(pick.subject ? String(pick.subject._id) : '00000000-0000-0000-0000-000000000000');
            subjectFilter = `AND a."subject" = $4`;
        }
        const [{ rows }, off] = await Promise.all([
            pool.query(
                `SELECT to_char(a."date" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "key",
                        count(r."_id")::int AS "total",
                        count(*) FILTER (WHERE r."status" = 'Present')::int  AS "present",
                        count(*) FILTER (WHERE r."status" = 'Absent')::int   AS "absent",
                        count(*) FILTER (WHERE r."status" = 'Late')::int     AS "late",
                        count(*) FILTER (WHERE r."status" = 'Half-Day')::int AS "halfDay"
                   FROM ${T(Attendance)} a
                   LEFT JOIN ${T(AttendanceRecord)} r ON r."attendance" = a."_id"
                  WHERE a."section" = $1 AND a."date" >= $2 AND a."date" < $3 ${subjectFilter}
                  GROUP BY 1`, p),
            daysOff(req.schoolId, pick.section.className, from, to),
        ]);
        const byKey = new Map(rows.map((r) => [r.key, r]));
        const scheduled = pick.subject?.days?.length ? new Set(pick.subject.days) : null;

        const out = [];
        for (let key = from; key <= to; key = addDays(key, 1)) {
            const hit = byKey.get(key);
            const entry = { key, state: null };
            if (hit && hit.total) {
                Object.assign(entry, {
                    total: hit.total, present: hit.present, absent: hit.absent, late: hit.late, halfDay: hit.halfDay,
                    percentage: tally([
                        ...Array(hit.present).fill('Present'), ...Array(hit.absent).fill('Absent'),
                        ...Array(hit.late).fill('Late'), ...Array(hit.halfDay).fill('Half-Day'),
                    ]).percentage,
                    state: hit.absent ? 'absent' : hit.halfDay ? 'half-day' : hit.late ? 'late' : 'present',
                });
            } else if (off.has(key)) {
                Object.assign(entry, { state: off.get(key).status, label: off.get(key).label });
            } else if (key <= today && (!scheduled || scheduled.has(WEEKDAY[keyDate(key).getUTCDay()]))) {
                entry.state = 'unmarked';
            }
            out.push(entry);
        }
        ok(res, { month, days: out });
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  GET /teacher/attendance/recent?limit=
// ═══════════════════════════════════════════════════════════════════════════

/** The registers most recently taken for anything this teacher holds. */
exports.recent = async (req, res) => {
    try {
        const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 3));
        const scope = await attendanceScope(req.schoolId, req.userId);
        if (!scope.sections.length) return ok(res, []);

        const { rows } = await pool.query(
            `SELECT a."_id", a."section", a."subject", a."date", a."createdAt", s."subjectName",
                    count(r."_id")::int AS "total",
                    count(*) FILTER (WHERE r."status" = 'Present')::int  AS "present",
                    count(*) FILTER (WHERE r."status" = 'Absent')::int   AS "absent",
                    count(*) FILTER (WHERE r."status" = 'Late')::int     AS "late",
                    count(*) FILTER (WHERE r."status" = 'Half-Day')::int AS "halfDay"
               FROM ${T(Attendance)} a
               LEFT JOIN ${T(Subject)} s ON s."_id" = a."subject"
               JOIN ${T(AttendanceRecord)} r ON r."attendance" = a."_id"
              WHERE a."section" = ANY($1::uuid[])
              GROUP BY a."_id", s."subjectName"
              ORDER BY a."date" DESC, a."createdAt" DESC
              LIMIT 60`,
            [scope.sections.map((s) => s._id)],
        );
        const sectionOf = new Map(scope.sections.map((s) => [s._id, s]));
        ok(res, rows
            .filter((r) => holdsRegister(scope, r.section, r.subject))
            .slice(0, limit)
            .map((r) => {
                const sec = sectionOf.get(String(r.section));
                const t = tally([
                    ...Array(r.present).fill('Present'), ...Array(r.absent).fill('Absent'),
                    ...Array(r.late).fill('Late'), ...Array(r.halfDay).fill('Half-Day'),
                ]);
                return {
                    _id: r._id, date: dateKey(r.date),
                    section: { _id: sec._id, label: sec.label, className: sec.className, classNumber: sec.classNumber, sectionName: sec.sectionName },
                    subject: r.subject ? { _id: r.subject, name: r.subjectName || 'Subject' } : null,
                    // A day register has no subject; what the teacher is to it stands in.
                    caption: r.subject ? (r.subjectName || 'Subject') : sec.roleLabel,
                    total: t.total, percentage: t.percentage,
                };
            }));
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  GET /teacher/attendance/ranking?section=&period=this-month|last-month|this-year
// ═══════════════════════════════════════════════════════════════════════════

const pad2 = (n) => String(n).padStart(2, '0');
const monthName = (y, m) => new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The window a period names, and the one it is compared against. */
function periodWindows(period, activeYear) {
    const today = localToday();
    const [y, m, d] = today.split('-').map(Number);
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    if (period === 'last-month') {
        const [ppy, ppm] = pm === 1 ? [py - 1, 12] : [py, pm - 1];
        return {
            key: period, label: monthName(py, pm),
            from: `${py}-${pad2(pm)}-01`, to: `${py}-${pad2(pm)}-${pad2(lastDay(py, pm))}`,
            previous: { label: monthName(ppy, ppm), from: `${ppy}-${pad2(ppm)}-01`, to: `${ppy}-${pad2(ppm)}-${pad2(lastDay(ppy, ppm))}` },
        };
    }
    if (period === 'this-year' && activeYear) {
        const start = dateKey(activeYear.startDate);
        const end   = dateKey(activeYear.endDate);
        return {
            key: period, label: activeYear.yearName || 'This academic year',
            from: start, to: today < end ? today : end,
            previous: null,
        };
    }
    // This month runs to today, against the same days of last month: the 1st to
    // the 17th against the 1st to the 17th, not a whole month.
    return {
        key: 'this-month', label: monthName(y, m),
        from: `${y}-${pad2(m)}-01`, to: today,
        previous: { label: monthName(py, pm), from: `${py}-${pad2(pm)}-01`, to: `${py}-${pad2(pm)}-${pad2(Math.min(d, lastDay(py, pm)))}` },
    };
}

const BANDS = [
    { key: '95', label: '≥ 95%',     test: (p) => p >= 95 },
    { key: '90', label: '90% - 94%', test: (p) => p >= 90 && p < 95 },
    { key: '80', label: '80% - 89%', test: (p) => p >= 80 && p < 90 },
    { key: '0',  label: '< 80%',     test: (p) => p < 80 },
];

exports.ranking = async (req, res) => {
    try {
        const scope = await attendanceScope(req.schoolId, req.userId);
        const sections = scope.sections.map(sectionOut);
        const pick = pickRegister(scope, uuidOr(req.query.section), null);
        const win  = periodWindows(req.query.period, scope.activeYear);
        const unit = scope.mode === 'subject' ? 'classes' : 'days';
        if (pick.error || !pick.section) {
            return ok(res, { mode: scope.mode, unit, sections, section: null, period: win, rows: [], top: [], distribution: [], today: null, average: null });
        }
        const section = pick.section;
        // A subject teacher's ranking counts their own subjects' registers; the
        // class and vice class teacher see every register of the section.
        const subjectIds = section.role === 'subject' ? section.subjects.map((s) => s._id) : null;

        const today = localToday();
        const earliest = win.previous ? win.previous.from : win.from;
        const [students, marks] = await Promise.all([
            sectionStudents(req.schoolId, section._id),
            pool.query(
                `SELECT r."student", r."status", to_char(a."date" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "key"
                   FROM ${T(AttendanceRecord)} r
                   JOIN ${T(Attendance)} a ON a."_id" = r."attendance"
                  WHERE a."section" = $1 AND a."date" >= $2 AND a."date" < $3
                    ${subjectIds ? 'AND a."subject" = ANY($4::uuid[])' : ''}`,
                [String(section._id), keyDate(earliest < today ? earliest : today),
                    keyDate(addDays(win.to > today ? win.to : today, 1)), ...(subjectIds ? [subjectIds] : [])],
            ),
        ]);

        const inWin  = (k, w) => w && k >= w.from && k <= w.to;
        const cur = new Map(), prev = new Map(), now = new Map();
        const push = (map, id, s) => { if (!map.has(id)) map.set(id, []); map.get(id).push(s); };
        for (const r of marks.rows) {
            const id = String(r.student);
            if (inWin(r.key, win)) push(cur, id, r.status);
            if (inWin(r.key, win.previous)) push(prev, id, r.status);
            if (r.key === today) push(now, id, r.status);
        }

        const rows = students.map((s) => {
            const t = tally(cur.get(String(s._id)) || []);
            const p = tally(prev.get(String(s._id)) || []);
            return {
                student: { _id: s._id, name: s.name, photo: s.photo, rollNumber: s.rollNumber || '' },
                present: t.present - t.late, absent: t.absent, late: t.late, halfDay: t.halfDay,
                total: t.total, attended: t.attended, percentage: t.percentage,
                previous: p.percentage,
                trend: t.percentage != null && p.percentage != null ? t.percentage - p.percentage : null,
            };
        }).sort((a, b) => ((b.percentage ?? -1) - (a.percentage ?? -1))
            || (b.attended - a.attended)
            || String(a.student.name).localeCompare(String(b.student.name)));

        // Standard competition ranking; students with nothing marked are unranked.
        let rank = 0, last = null;
        rows.forEach((r, i) => {
            if (r.percentage == null) { r.rank = null; return; }
            const key = `${r.percentage}|${r.attended}`;
            if (key !== last) { rank = i + 1; last = key; }
            r.rank = rank;
        });

        const all = (map) => [...map.values()].flat();
        const avgNow  = tally(all(cur)).percentage;
        const avgPrev = win.previous ? tally(all(prev)).percentage : null;

        const todayByStudent = students.map((s) => rollup(now.get(String(s._id)) || []));
        const todayCounts = { present: 0, absent: 0, late: 0, halfDay: 0, unmarked: 0 };
        todayByStudent.forEach((st) => {
            if (st === 'Present') todayCounts.present++;
            else if (st === 'Absent') todayCounts.absent++;
            else if (st === 'Late') todayCounts.late++;
            else if (st === 'Half-Day') todayCounts.halfDay++;
            else todayCounts.unmarked++;
        });

        const ranked = rows.filter((r) => r.percentage != null);
        ok(res, {
            mode: scope.mode, unit, sections, section: sectionOut(section),
            scopeNote: subjectIds ? `Counting your subjects: ${section.subjects.map((s) => s.name).join(', ')}` : '',
            period: win,
            today: { date: today, students: students.length, ...todayCounts, marked: students.length - todayCounts.unmarked },
            average: { value: avgNow, previous: avgPrev, change: avgNow != null && avgPrev != null ? avgNow - avgPrev : null },
            top: ranked.slice(0, 3),
            distribution: BANDS.map((b) => ({ key: b.key, label: b.label, count: ranked.filter((r) => b.test(r.percentage)).length })),
            rows,
        });
    } catch (e) { err(res, e); }
};

// ═══════════════════════════════════════════════════════════════════════════
//  Student correction requests
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Write one mark directly — a reviewed correction. Not a register save: the
 * student is told by the review notice, and the parent is not emailed again
 * about a day that already happened.
 */
async function applyMark({ attendanceId, studentId, status, remarks, actorId }) {
    const crypto = require('crypto');
    await pool.query(
        `INSERT INTO ${T(AttendanceRecord)} ("_id", "attendance", "student", "status", "remarks", "markedAt", "markedBy")
         VALUES ($1, $2, $3, $4, $5, now(), $6)
         ON CONFLICT ("attendance", "student") DO UPDATE
            SET "status" = EXCLUDED."status", "remarks" = EXCLUDED."remarks",
                "markedAt" = EXCLUDED."markedAt", "markedBy" = EXCLUDED."markedBy"`,
        [crypto.randomUUID(), String(attendanceId), String(studentId), status, remarks, String(actorId)],
    );
}

const event = (req, type, extra = {}) => ({
    event: type, at: new Date().toISOString(),
    by: String(req.userId), byName: req.user?.name || '', role: req.userRole || 'teacher', ...extra,
});

/** A correction as the teacher tab shows it. Batched lookups for a page of rows. */
async function shapeCorrections(rows, scope) {
    const ids = (field) => [...new Set(rows.map((r) => r[field]).filter(Boolean).map(String))];
    const [students, subjects, reviewers, profiles] = await Promise.all([
        ids('student').length ? User.find({ _id: { $in: ids('student') } }).select('name profileImage').lean() : [],
        ids('subject').length ? Subject.find({ _id: { $in: ids('subject') } }).select('subjectName').lean() : [],
        ids('reviewedBy').length ? User.find({ _id: { $in: ids('reviewedBy') } }).select('name').lean() : [],
        ids('student').length
            ? require('../models/StudentProfile').find({ user: { $in: ids('student') } }).select('user rollNumber').lean()
            : [],
    ]);
    const byId = (list) => new Map(list.map((x) => [String(x._id), x]));
    const S = byId(students), J = byId(subjects), R = byId(reviewers);
    const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
    const sectionOf = new Map(scope.sections.map((s) => [s._id, s]));

    return rows.map((r) => {
        const stu = S.get(String(r.student));
        const sec = sectionOf.get(String(r.section));
        const history = Array.isArray(r.history) ? r.history : [];
        const lastEvent = history[history.length - 1];
        return {
            _id: r._id,
            student: { _id: r.student, name: stu?.name || 'Student', photo: stu?.profileImage || '', rollNumber: roll.get(String(r.student)) || '' },
            section: { _id: r.section, label: sec?.label || '', className: sec?.className || '', sectionName: sec?.sectionName || '' },
            subject: r.subject ? { _id: r.subject, name: J.get(String(r.subject))?.subjectName || 'Subject' } : null,
            date: dateKey(r.date),
            currentStatus: low(r.currentStatus) === 'not marked' ? 'unmarked' : lowStatus(r.currentStatus),
            requestedStatus: lowStatus(r.requestedStatus),
            reason: r.reason,
            status: low(r.status),
            source: r.source || 'student',
            attachments: Array.isArray(r.attachments) ? r.attachments : [],
            history,
            awaitingReply: low(r.status) === 'pending' && lastEvent?.event === 'info_requested',
            teacherRemarks: r.teacherRemarks || '',
            reviewedBy: r.reviewedBy ? { _id: r.reviewedBy, name: R.get(String(r.reviewedBy))?.name || '' } : null,
            reviewedAt: r.reviewedAt,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt || r.reviewedAt || null,
        };
    });
}

/**
 * GET /teacher/attendance/corrections?status=&section=&month=YYYY-MM&search=&page=&limit=&focus=
 *
 * Requests on registers this teacher holds. `counts` cover everything the other
 * filters match, so the status chips and the tiles agree with the list.
 */
exports.corrections = async (req, res) => {
    try {
        const scope = await attendanceScope(req.schoolId, req.userId);
        const sections = scope.sections.map(sectionOut);
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 8));
        if (!scope.sections.length) {
            return res.json({ success: true, data: [], total: 0, page: 1, pages: 1, limit, counts: { all: 0, pending: 0, approved: 0, rejected: 0 }, sections, mode: scope.mode });
        }

        const wanted = uuidOr(req.query.section);
        const filter = { school: req.schoolId, section: { $in: wanted ? [wanted] : scope.sections.map((s) => s._id) } };
        const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : null;
        if (month) {
            const [y, m] = month.split('-').map(Number);
            filter.date = { $gte: keyDate(`${month}-01`), $lt: keyDate(addDays(`${month}-${pad2(lastDay(y, m))}`, 1)) };
        }
        let list = (await AttendanceCorrection.find(filter).sort({ createdAt: -1 }).lean())
            .filter((r) => holdsRegister(scope, r.section, r.subject));

        const q = String(req.query.search || '').trim().toLowerCase();
        let shaped = await shapeCorrections(list, scope);
        if (q) {
            shaped = shaped.filter((r) => r.student.name.toLowerCase().includes(q)
                || String(r.student.rollNumber).toLowerCase() === q
                || String(r.reason || '').toLowerCase().includes(q));
        }
        const counts = {
            all: shaped.length,
            pending: shaped.filter((r) => r.status === 'pending').length,
            approved: shaped.filter((r) => r.status === 'approved').length,
            rejected: shaped.filter((r) => r.status === 'rejected').length,
        };
        const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
        if (status) shaped = shaped.filter((r) => r.status === status);

        const total = shaped.length;
        const pages = Math.max(1, Math.ceil(total / limit));
        let page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
        const focus = uuidOr(req.query.focus);
        let focusFound;
        if (focus) {
            const at = shaped.findIndex((r) => String(r._id) === focus);
            focusFound = at >= 0;
            if (at >= 0) page = Math.floor(at / limit) + 1;
        }
        list = shaped.slice((page - 1) * limit, page * limit);

        res.json({
            success: true, data: list, total, page, pages, limit, counts, sections, mode: scope.mode,
            ...(focus ? { focusFound } : {}),
        });
    } catch (e) { err(res, e); }
};

/**
 * GET /teacher/correction-requests — the original flat list (the mobile app):
 * every request on a register this teacher holds, newest first.
 */
exports.correctionsList = async (req, res) => {
    try {
        const scope = await attendanceScope(req.schoolId, req.userId);
        if (!scope.sections.length) return ok(res, []);
        const rows = (await AttendanceCorrection.find({ school: req.schoolId, section: { $in: scope.sections.map((s) => s._id) } })
            .sort({ createdAt: -1 }).limit(200).lean())
            .filter((r) => holdsRegister(scope, r.section, r.subject));
        ok(res, await shapeCorrections(rows, scope));
    } catch (e) { err(res, e); }
};

/** The pending request, if this teacher holds its register. */
async function heldCorrection(req, id, scope) {
    const correction = await AttendanceCorrection.findOne({ _id: uuidOr(id), school: req.schoolId });
    if (!correction || !holdsRegister(scope, correction.section, correction.subject)) return null;
    return correction;
}

/**
 * POST /teacher/correction-requests/review { id, status: approved|rejected, remarks }
 * An approval writes the requested mark onto the register the request names.
 */
exports.review = async (req, res) => {
    try {
        const { id, remarks } = req.body;
        const decision = { approved: 'Approved', rejected: 'Rejected' }[low(req.body.status)];
        if (!uuidOr(id) || !decision) return err(res, 'id and status (approved/rejected) are required', 400);

        const scope = await attendanceScope(req.schoolId, req.userId);
        const correction = await heldCorrection(req, id, scope);
        if (!correction) return err(res, 'Request not found', 404);
        if (correction.status !== 'Pending') return err(res, 'This request has already been reviewed', 409);

        const text = String(remarks || '').trim().slice(0, 500);
        correction.status         = decision;
        correction.reviewedBy     = req.userId;
        correction.reviewedAt     = new Date();
        correction.updatedAt      = new Date();
        correction.teacherRemarks = text;
        correction.history = [...(correction.history || []), event(req, decision === 'Approved' ? 'approved' : 'rejected', { message: text })];
        await correction.save();

        if (decision === 'Approved' && correction.attendance) {
            await applyMark({
                attendanceId: correction.attendance, studentId: correction.student,
                status: correction.requestedStatus,
                remarks: `Corrected via student request.${text ? ` ${text}` : ''}`,
                actorId: req.userId,
            });
        }
        notices.correctionReviewed({ req, correction: correction.toObject(), approved: decision === 'Approved', remarks: text });
        const [row] = await shapeCorrections([correction.toObject()], scope);
        ok(res, row);
    } catch (e) { err(res, e); }
};

/** POST /teacher/attendance/corrections/:id/request-info { message } */
exports.requestInfo = async (req, res) => {
    try {
        const message = String(req.body.message || '').trim().slice(0, 500);
        if (!message) return err(res, 'Say what you need from the student', 400);

        const scope = await attendanceScope(req.schoolId, req.userId);
        const correction = await heldCorrection(req, req.params.id, scope);
        if (!correction) return err(res, 'Request not found', 404);
        if (correction.status !== 'Pending') return err(res, 'Only a pending request can be asked about', 409);

        correction.history = [...(correction.history || []), event(req, 'info_requested', { message })];
        correction.updatedAt = new Date();
        await correction.save();

        notices.correctionInfoRequested({ req, correction: correction.toObject(), message });
        const [row] = await shapeCorrections([correction.toObject()], scope);
        ok(res, row);
    } catch (e) { err(res, e); }
};

/**
 * POST /teacher/attendance/corrections { studentId, date, section, subject?, status, reason }
 *
 * A teacher correcting a mark themselves. The mark is written through the
 * register (so the student and parent hear of it like any change), and an
 * already-approved correction is kept as the record of who changed what, why.
 */
exports.createCorrection = async (req, res) => {
    try {
        const { studentId, date, reason } = req.body;
        const status = capStatus(req.body.status);
        const day = String(date || '').slice(0, 10);
        if (!uuidOr(studentId) || !isKey(day) || !status) return err(res, 'studentId, date and status are required', 400);
        if (!String(reason || '').trim()) return err(res, 'Give a reason for the correction', 400);
        if (day > localToday()) return err(res, 'Attendance cannot be corrected for a future date', 400);

        const scope = await attendanceScope(req.schoolId, req.userId);
        const pick = pickRegister(scope, uuidOr(req.body.section), uuidOr(req.body.subject), { requireSubject: true });
        if (pick.error) return err(res, pick.error, 403);

        const roster = await sectionStudents(req.schoolId, pick.section._id);
        if (!roster.some((s) => String(s._id) === String(studentId))) return err(res, 'That student is not in this section', 400);

        const prior = await pool.query(
            `SELECT r."status" FROM ${T(AttendanceRecord)} r JOIN ${T(Attendance)} a ON a."_id" = r."attendance"
              WHERE a."section" = $1 AND a."date" >= $2 AND a."date" < $3
                AND COALESCE(a."subject"::text, '') = $4 AND r."student" = $5`,
            [pick.section._id, keyDate(day), keyDate(addDays(day, 1)), pick.subject ? pick.subject._id : '', String(studentId)],
        );
        const was = prior.rows[0]?.status || 'Not Marked';
        if (was === status) return err(res, `The mark is already ${status}`, 400);

        const text = String(reason).trim().slice(0, 500);
        const { session } = await saveSectionMarks({
            schoolId: req.schoolId, sectionId: pick.section._id, subjectId: pick.subject?._id || null, date: day,
            records: [{ studentId, status, remarks: `Corrected by teacher. ${text}`.slice(0, 300) }],
            actor: { userId: req.userId, role: req.userRole || 'teacher' },
            note: `Corrected by ${req.user?.name || 'the teacher'}. Reason: ${text}`,
        });
        const now = new Date();
        const correction = await AttendanceCorrection.create({
            student: studentId, school: req.schoolId, section: pick.section._id,
            attendance: session._id, attendanceRecord: null, date: keyDate(day),
            subject: pick.subject?._id || null,
            currentStatus: was, requestedStatus: status, reason: text,
            status: 'Approved', source: 'teacher',
            reviewedBy: req.userId, reviewedAt: now, updatedAt: now, teacherRemarks: '',
            history: [event(req, 'corrected', { message: text })],
            createdAt: now,
        });
        const [row] = await shapeCorrections([correction.toObject ? correction.toObject() : correction], scope);
        ok(res, row, 201);
    } catch (e) { err(res, e); }
};
