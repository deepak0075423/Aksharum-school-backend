'use strict';
const Attendance       = require('../models/Attendance');
const AttendanceRecord = require('../models/AttendanceRecord');
const TeacherAttendance = require('../models/TeacherAttendance');
const TeacherAttendanceRegularization = require('../models/TeacherAttendanceRegularization');
const AttendanceCorrection = require('../models/AttendanceCorrection');
const StudentProfile   = require('../models/StudentProfile');
const ClassSection     = require('../models/ClassSection');
const { notify, schoolAdminIds } = require('../services/notifyService');
const sa = require('../services/studentAttendance');
const notices = require('../services/attendanceNotices');
const { forStudent: studentCorrectionsOut } = require('../services/attendanceCorrections');

const fmtDay = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const ok  = (res, d, s=200) => res.status(s).json({ success: true, data: d });
const err = (res, e, s=500) => res.status(s).json({ success: false, message: e.message||e });

// Statuses are stored capitalized; the frontend uses lowercase — normalize here.
const low = (s) => String(s || '').toLowerCase();
const capReview  = (s) => (low(s) === 'approved' ? 'Approved' : low(s) === 'rejected' ? 'Rejected' : null);
// Student marks: Present | Absent | Late | Half-Day (services/studentAttendance.js)
const capRecord  = (s) => sa.capStatus(s);
const capTeacher = (s) => ({ present: 'Present', absent: 'Absent', 'half-day': 'Half-Day', leave: 'Leave' }[low(s)] || 'Present');

const dayRange = (dateStr) => {
    const start = new Date(dateStr + 'T00:00:00.000Z');
    const end   = new Date(dateStr + 'T23:59:59.999Z');
    return { start, end };
};

// ── Comp Off bridge (scenario 3) ─────────────────────────────────────────────
// Once a day's attendance is settled, the Comp Off engine decides — entirely
// from the school's Comp Off policy — whether that day earns a ready-to-apply
// draft. Fire-and-forget: comp off must never be able to fail a clock-out or an
// attendance approval, and the engine is idempotent per work date, so a repeat
// call on the same day creates nothing new.
function maybeGenerateCompOff(record, actorId) {
    if (!record) return;
    const plain = record.toObject ? record.toObject() : record;
    setImmediate(() => {
        require('../services/compOffService')
            .generateFromAttendance(plain, { actorId })
            .catch(e => console.error('[compOff] attendance hook failed:', e.message));
    });
}

const teacherSection = (req) => ClassSection.findOne({
    school: req.schoolId,
    $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
}).lean();

// A student's attendance for a month, one row per day. A day holding several
// registers (a subject-wise school) is rolled up and carries the registers
// behind it — services/studentAttendance.rollupByDay.
async function studentMonthRecords(studentId, schoolId, month, year) {
    const profile = await StudentProfile.findOne({ user: studentId, school: schoolId }).lean();
    if (!profile?.currentSection) return [];

    const filter = { section: profile.currentSection };
    if (month && year) {
        filter.date = { $gte: new Date(Date.UTC(year, month - 1, 1)), $lte: new Date(Date.UTC(year, month, 0, 23, 59, 59)) };
    }
    const sessions = await Attendance.find(filter).sort({ date: 1 }).lean();
    if (!sessions.length) return [];

    const records = await AttendanceRecord.find({
        attendance: { $in: sessions.map(s => s._id) },
        student: studentId,
    }).lean();
    const byId = Object.fromEntries(records.map(r => [String(r.attendance), r]));
    const subjectIds = [...new Set(sessions.map(s => s.subject).filter(Boolean).map(String))];
    const names = subjectIds.length
        ? new Map((await require('../models/Subject').find({ _id: { $in: subjectIds } }).select('subjectName').lean())
            .map(x => [String(x._id), x.subjectName]))
        : new Map();

    return sa.rollupByDay(sessions
        .filter(s => byId[String(s._id)])
        .map(s => ({
            _id:         byId[String(s._id)]._id,
            attendance:  s._id,
            date:        s.date,
            subject:     s.subject || null,
            subjectName: s.subject ? names.get(String(s.subject)) : '',
            status:      byId[String(s._id)].status,
            remarks:     byId[String(s._id)].remarks || '',
        })));
}

// ── Admin: teacher attendance regularization ─────────────────────────────────

// The admin request queue lives in attendanceAdmin.controller.js (`requests`).

exports.adminReviewRegularization = async (req, res) => {
    try {
        const { id, status, remarks } = req.body;
        const newStatus = capReview(status);
        if (!id || !newStatus) return err(res, 'id and status (approved/rejected) are required', 400);

        const request = await TeacherAttendanceRegularization.findOne({
            _id: id, school: req.schoolId, status: 'Pending',
        });
        if (!request) return err(res, 'Request not found or already reviewed', 404);

        // Four-eyes rule: nobody reviews their own request. Requests come from
        // teacher posts only, so this is the teacher who holds admin on the
        // attendance module and reached the queue through /admin.
        if (String(request.teacher) === String(req.userId))
            return err(res, 'You cannot review your own request — another admin must approve it', 403);

        request.status       = newStatus;
        request.reviewedBy   = req.userId;
        request.reviewedAt   = new Date();
        request.adminRemarks = (remarks || '').trim();
        await request.save();

        // Apply the approved punches to the teacher's attendance for that day.
        // Only the times the request carries are written — an existing punch is
        // never blanked. Requests without times (legacy) fall back to status.
        if (newStatus === 'Approved') {
            const dateStr = new Date(request.date).toISOString().split('T')[0];
            const { start, end } = dayRange(dateStr);
            const set = {
                remarks: `Regularized: ${request.requestType}. ${request.adminRemarks}`.trim(),
                markedBy: req.userId,
            };
            if (request.checkIn || request.checkOut) {
                set.status = 'Present';
                if (request.checkIn)  set.checkIn  = request.checkIn;
                if (request.checkOut) set.checkOut = request.checkOut;
            } else {
                set.status = request.requestedStatus;
            }
            const rec = await TeacherAttendance.findOneAndUpdate(
                { teacher: request.teacher, school: request.school, date: { $gte: start, $lte: end } },
                {
                    $set: set,
                    $setOnInsert: {
                        teacher: request.teacher,
                        school:  request.school,
                        date:    new Date(dateStr + 'T00:00:00.000Z'),
                    },
                },
                { upsert: true, new: true }
            );
            // Scenario 3: attendance is now approved. If the day was a holiday /
            // weekly off / Sunday, hand the teacher a pre-filled, ready-to-apply
            // Comp Off draft. Nothing is credited here — they still have to
            // apply, and an approver still has to sign it off.
            maybeGenerateCompOff(rec, req.userId);
        }
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: newStatus === 'Approved' ? '✅ Regularization approved' : '❌ Regularization rejected',
            body: `Your attendance regularization for ${fmtDay(request.date)} was ${low(newStatus)}.${request.adminRemarks ? `\nRemarks: ${request.adminRemarks}` : ''}`,
            recipients: [request.teacher],
            link: { type: 'attendance.mine', entityId: request._id },
        });
        ok(res, { ...request.toObject(), status: low(request.status) });
    } catch (e) { err(res, e); }
};

// Admin: directly regularise a teacher's attendance for a day (no request/approval)
exports.adminRegularizeAttendance = async (req, res) => {
    try {
        const { teacherId, date, checkIn, checkOut, status, remarks } = req.body;
        if (!teacherId || !date) return err(res, 'teacherId and date are required', 400);
        if (!checkIn && !checkOut && !status)
            return err(res, 'Provide clock-in/out times or a status', 400);

        const User = require('../models/User');
        const staff = await User.findOne({ _id: teacherId, school: req.schoolId }).select('_id role').lean();
        // Staff attendance is kept for teacher posts only — a school_admin post
        // never clocks in, so a record written for one would be a lone day in
        // an otherwise empty history.
        if (!staff || staff.role !== 'teacher')
            return err(res, 'Teacher not found', 404);

        const dateStr = new Date(date).toISOString().split('T')[0];
        if (dateStr > todayStr()) return err(res, 'Cannot regularise a future date', 400);
        const { start, end } = dayRange(dateStr);

        const set = { markedBy: req.userId, remarks: `Regularized by admin. ${remarks || ''}`.trim() };
        if (checkIn || checkOut) {
            set.status = 'Present';
            if (checkIn)  set.checkIn  = checkIn;
            if (checkOut) set.checkOut = checkOut;
        } else {
            set.status = capTeacher(status);
        }

        const rec = await TeacherAttendance.findOneAndUpdate(
            { teacher: teacherId, school: req.schoolId, date: { $gte: start, $lte: end } },
            { $set: set, $setOnInsert: { teacher: teacherId, school: req.schoolId, date: new Date(dateStr + 'T00:00:00.000Z') } },
            { upsert: true, new: true }
        );
        maybeGenerateCompOff(rec, req.userId);
        ok(res, { ...rec.toObject(), status: low(rec.status) });
    } catch (e) { err(res, e); }
};

// Admin: search people (teachers + students) to regularise, with clear role labels
exports.adminSearchPeople = async (req, res) => {
    try {
        const User = require('../models/User');
        const { search = '' } = req.query;
        const filter = {
            school: req.schoolId,
            role: { $in: ['teacher', 'student'] },
        };
        if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }];

        const users = await User.find(filter).select('_id name email role').sort({ name: 1 }).limit(20).lean();

        // Enrich students with their class/section for disambiguation
        const studentIds = users.filter(u => u.role === 'student').map(u => u._id);
        let sectionByStudent = {};
        if (studentIds.length) {
            const profiles = await StudentProfile.find({ user: { $in: studentIds }, school: req.schoolId })
                .select('user currentSection rollNumber')
                .populate({ path: 'currentSection', select: 'sectionName class', populate: { path: 'class', select: 'className' } })
                .lean();
            sectionByStudent = profiles.reduce((m, p) => {
                m[String(p.user)] = {
                    className:   p.currentSection?.class?.className || '',
                    sectionName: p.currentSection?.sectionName || '',
                    rollNumber:  p.rollNumber || '',
                };
                return m;
            }, {});
        }

        ok(res, users.map(u => ({
            _id: u._id, name: u.name, email: u.email, role: u.role,
            ...(u.role === 'student' ? sectionByStudent[String(u._id)] || {} : {}),
        })));
    } catch (e) { err(res, e); }
};

// Admin: directly set a student's attendance status for a given day (no request).
// In a subject-wise school the mark belongs to one subject's register: `subject`
// names it. Without one, the day register is used — which is also where a
// school that has always registered by day keeps its marks.
exports.adminRegularizeStudent = async (req, res) => {
    try {
        const { studentId, date, status, remarks } = req.body;
        if (!studentId || !date || !status)
            return err(res, 'studentId, date and status are required', 400);
        const requested = capRecord(status);
        if (!requested) return err(res, 'status must be present, absent, late or half-day', 400);

        const dateStr = new Date(date).toISOString().split('T')[0];
        if (dateStr > todayStr()) return err(res, 'Cannot regularise a future date', 400);

        const profile = await StudentProfile.findOne({ user: studentId, school: req.schoolId })
            .select('currentSection').lean();
        if (!profile?.currentSection) return err(res, 'Student is not enrolled in a section', 404);

        const mode = await sa.registrationMode(req.schoolId);
        let subjectId = null;
        if (req.body.subject) {
            const Subject = require('../models/Subject');
            const subject = await Subject.findOne({ _id: req.body.subject, school: req.schoolId }).select('_id').lean();
            if (!subject) return err(res, 'Subject not found', 404);
            subjectId = subject._id;
        } else if (mode === 'subject') {
            return err(res, 'Attendance is taken subject-wise — choose the subject register to correct', 400);
        }

        const { start, end } = dayRange(dateStr);
        // Reuse the register, or create one so the record has a parent
        const session = await Attendance.findOneAndUpdate(
            { section: profile.currentSection, date: { $gte: start, $lte: end }, subject: subjectId },
            { $setOnInsert: { section: profile.currentSection, date: new Date(dateStr + 'T00:00:00.000Z'), subject: subjectId, createdBy: req.userId } },
            { upsert: true, new: true }
        );

        const prior = await AttendanceRecord.findOne({ attendance: session._id, student: studentId }).select('status').lean();
        const rec = await AttendanceRecord.findOneAndUpdate(
            { attendance: session._id, student: studentId },
            { $set: { status: requested, remarks: `Regularized by admin. ${remarks || ''}`.trim(),
                      markedAt: new Date(), markedBy: req.userId },
              $setOnInsert: { attendance: session._id, student: studentId } },
            { upsert: true, new: true }
        );
        if (prior?.status !== requested) {
            notices.marksChanged({
                schoolId: req.schoolId, sectionId: profile.currentSection, subjectId, date: dateStr,
                changed: [{ student: studentId, status: requested, was: prior?.status || null }],
                actor: { userId: req.userId, role: req.userRole },
                note: `Corrected by the school office.${remarks ? ` ${String(remarks).trim()}` : ''}`,
            });
        }
        ok(res, { ...rec.toObject(), status: sa.lowStatus(rec.status) });
    } catch (e) { err(res, e); }
};

// ── Teacher: self attendance ──────────────────────────────────────────────────

// ── Self attendance: clock in/out with derived statuses ───────────────────────
// Statuses are never hand-picked: clock-in → present, approved leave → leave /
// half-day, holidays & non-working days are skipped, anything else in the past
// counts as absent automatically.
//
// Self attendance belongs to the TEACHER role, decided by the post the session
// is signed in as — not by the person. One email can hold a school_admin post
// and a teacher post (separate User rows); only the teacher row clocks in, asks
// for a regularization or has a history to show. The routes are teacher-only
// already; this is the same rule held where the work is done, so mounting
// these handlers anywhere else cannot quietly hand them to another role.
const SELF_ATTENDANCE_ROLE = 'teacher';
const refuseSelfAttendance = (req, res) => {
    if (req.userRole === SELF_ATTENDANCE_ROLE) return false;
    res.status(403).json({
        success: false,
        code: 'SELF_ATTENDANCE_TEACHER_ONLY',
        message: 'Clock in, clock out and regularization requests are available from a teacher account only',
    });
    return true;
};

const hhmm = () => {
    const n = new Date();
    return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
};
// Server-LOCAL date string — toISOString() is UTC and shifts the day for TZ>0
// (e.g. a 02:00 IST clock-in was stored under yesterday), while
// buildSelfAttendanceMonth looks records up by the local day number.
const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const staffDaysSvc = require('../services/staffAttendanceDays');

const pad2 = (n) => String(n).padStart(2, '0');
const monthBounds = (month, year) => ({
    from: `${year}-${pad2(month)}-01`,
    to:   `${year}-${pad2(month)}-${pad2(new Date(Date.UTC(year, month, 0)).getUTCDate())}`,
});
const isKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

// The day-by-day derivation lives in services/staffAttendanceDays.js, shared
// with the admin staff report and the Regularise panel.
async function buildSelfAttendanceMonth(req, month, year) {
    const { from, to } = monthBounds(month, year);
    return staffDaysSvc.staffDays({ schoolId: req.schoolId, userId: req.userId, role: req.userRole }, from, to);
}

/**
 * GET my-attendance — `?month=&year=` for one calendar month (the original
 * contract every client uses), or `?from=YYYY-MM-DD&to=YYYY-MM-DD` for an
 * arbitrary window such as a calendar grid that shows the tail of the previous
 * month and the head of the next. Windows are capped at 62 days.
 */
exports.getTeacherSelfAttendance = async (req, res) => {
    try {
        if (refuseSelfAttendance(req, res)) return;
        const { from, to } = req.query;
        if (from || to) {
            if (!isKey(from) || !isKey(to) || from > to) return err(res, 'from and to must be YYYY-MM-DD, from ≤ to', 400);
            if (staffDaysSvc.addDays(from, 61) < to) return err(res, 'A window can span at most 62 days', 400);
            const since = (await staffDaysSvc.startDates(req.schoolId, [req.userId])).get(String(req.userId));
            const data = await staffDaysSvc.staffDays(
                { schoolId: req.schoolId, userId: req.userId, role: req.userRole, since }, from, to);
            return ok(res, data);
        }
        const now   = new Date();
        const month = +req.query.month || now.getMonth() + 1;
        const year  = +req.query.year  || now.getFullYear();
        const data  = await buildSelfAttendanceMonth(req, month, year);
        ok(res, data);
    } catch (e) { err(res, e); }
};

exports.clockIn = async (req, res) => {
    try {
        if (refuseSelfAttendance(req, res)) return;
        const { start, end } = dayRange(todayStr());

        const LeaveApplication = require('../models/LeaveApplication');
        const onLeave = await LeaveApplication.findOne({
            teacher: req.userId, school: req.schoolId, status: 'approved',
            fromDate: { $lte: end }, toDate: { $gte: start },
            leaveMode: 'full_day',
        }).lean().catch(() => null);
        if (onLeave) return err(res, 'You are on approved leave today', 400);

        const existing = await TeacherAttendance.findOne({
            teacher: req.userId, school: req.schoolId, date: { $gte: start, $lte: end },
        }).lean();
        if (existing?.checkIn) return err(res, `Already clocked in at ${existing.checkIn}`, 400);

        const rec = await TeacherAttendance.findOneAndUpdate(
            { teacher: req.userId, school: req.schoolId, date: { $gte: start, $lte: end } },
            {
                $set: { status: 'Present', checkIn: hhmm(), markedBy: req.userId },
                $setOnInsert: { teacher: req.userId, school: req.schoolId, date: new Date(todayStr() + 'T00:00:00.000Z') },
            },
            { upsert: true, new: true }
        );
        ok(res, { checkIn: rec.checkIn });
    } catch (e) { err(res, e); }
};

exports.clockOut = async (req, res) => {
    try {
        if (refuseSelfAttendance(req, res)) return;
        const { start, end } = dayRange(todayStr());
        const rec = await TeacherAttendance.findOne({
            teacher: req.userId, school: req.schoolId, date: { $gte: start, $lte: end },
        });
        if (!rec?.checkIn) return err(res, 'Clock in first', 400);

        rec.checkOut = hhmm();
        if (!rec.markedBy) rec.markedBy = req.userId;
        await rec.save();
        // The day is complete — self-marked attendance needs no further sign-off,
        // so this is the point at which it can qualify for a Comp Off draft.
        maybeGenerateCompOff(rec, req.userId);
        ok(res, { checkIn: rec.checkIn, checkOut: rec.checkOut });
    } catch (e) { err(res, e); }
};

exports.getRegularizationForm = async (req, res) => {
    try {
        if (refuseSelfAttendance(req, res)) return;
        // Recent self-attendance for context + the teacher's pending requests
        const [recent, myRequests] = await Promise.all([
            TeacherAttendance.find({ teacher: req.userId }).sort({ date: -1 }).limit(30).lean(),
            TeacherAttendanceRegularization.find({ teacher: req.userId }).sort({ createdAt: -1 }).limit(20).lean(),
        ]);
        ok(res, {
            recent:   recent.map(r => ({ ...r, status: low(r.status) })),
            requests: myRequests.map(r => ({ ...r, status: low(r.status) })),
        });
    } catch (e) { err(res, e); }
};

exports.submitRegularization = async (req, res) => {
    try {
        if (refuseSelfAttendance(req, res)) return;
        const { date, checkIn, checkOut, reason } = req.body;
        if (!date || !reason) return err(res, 'date and reason are required', 400);
        if (!checkIn && !checkOut)
            return err(res, 'Provide the missed clock-in and/or clock-out time', 400);

        const dateStr = new Date(date).toISOString().split('T')[0];
        if (dateStr > todayStr()) return err(res, 'Cannot mark attendance for a future date', 400);

        const { start, end } = dayRange(dateStr);
        const existing = await TeacherAttendanceRegularization.findOne({
            teacher: req.userId, school: req.schoolId,
            date: { $gte: start, $lte: end },
            status: 'Pending',
        }).lean();
        if (existing) return err(res, 'A pending request already exists for this date', 400);

        const reg = await TeacherAttendanceRegularization.create({
            teacher: req.userId, school: req.schoolId,
            date: new Date(dateStr + 'T00:00:00.000Z'),
            requestType:     'Missed Punch',
            requestedStatus: 'Present',
            checkIn:  checkIn  || '',
            checkOut: checkOut || '',
            reason: String(reason).trim(),
            status: 'Pending',
        });
        schoolAdminIds(req.schoolId).then(admins => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🕐 New attendance regularization request',
            body: `${req.user?.name || 'A staff member'} requested regularization for ${fmtDay(reg.date)}.\nReason: ${reg.reason}`,
            recipients: admins,
            link: { type: 'attendance.regularizations', entityId: reg._id },
        })).catch(() => {});
        ok(res, { ...reg.toObject(), status: low(reg.status) }, 201);
    } catch (e) { err(res, e); }
};

// ── Attendance ranking (students ranked by attendance % within a section) ─────

async function computeSectionRanking(sectionId, schoolId) {
    const User         = require('../models/User');
    const AcademicYear = require('../models/AcademicYear');
    const section = await ClassSection.findOne({ _id: sectionId, school: schoolId }).lean();
    if (!section) return [];

    // Restrict to the active academic year's date window
    const ay = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    const sessionFilter = { section: sectionId };
    if (ay?.startDate && ay?.endDate) {
        sessionFilter.date = { $gte: new Date(ay.startDate), $lte: new Date(ay.endDate) };
    }

    const sessions   = await Attendance.find(sessionFilter).select('_id').lean();
    const sessionIds = sessions.map(s => s._id);

    const records = sessionIds.length
        ? await AttendanceRecord.find({ attendance: { $in: sessionIds } }).select('student status').lean()
        : [];

    // Each student over their own marks, Half-Day as half — the rule every
    // attendance figure uses (services/studentAttendance.js).
    const marksOf = {};
    for (const r of records) (marksOf[String(r.student)] = marksOf[String(r.student)] || []).push(r.status);

    const ids = section.enrolledStudents || [];
    const [students, profiles] = await Promise.all([
        User.find({ _id: { $in: ids } }).select('name').lean(),
        StudentProfile.find({ user: { $in: ids } }).select('user rollNumber').lean(),
    ]);
    const rollById = Object.fromEntries(profiles.map(p => [String(p.user), p.rollNumber]));

    const list = students.map(s => {
        const t = sa.tally(marksOf[String(s._id)] || []);
        return {
            student: { _id: s._id, name: s.name, rollNumber: rollById[String(s._id)] || '' },
            present: t.attended, total: t.total, halfDay: t.halfDay, percentage: t.percentage ?? 0,
        };
    });

    list.sort((a, b) => b.percentage - a.percentage || (a.student.name || '').localeCompare(b.student.name || ''));

    // Standard competition ranking (ties share a rank)
    let rank = 0, prevPct = null;
    list.forEach((it, i) => {
        if (it.percentage !== prevPct) { rank = i + 1; prevPct = it.percentage; }
        it.rank = rank;
    });
    return list;
}

// Student: ranking within own section, with own rank highlighted
exports.getMyClassRanking = async (req, res) => {
    try {
        const profile = await StudentProfile.findOne({ user: req.userId, school: req.schoolId }).lean();
        if (!profile?.currentSection) return ok(res, { ranking: [], myRank: null, total: 0 });
        const ranking = await computeSectionRanking(profile.currentSection, req.schoolId);
        const me = ranking.find(r => String(r.student._id) === String(req.userId));
        ok(res, { ranking, myRank: me?.rank || null, total: ranking.length, myPercentage: me?.percentage ?? null });
    } catch (e) { err(res, e); }
};

// Teacher (class/vice teacher): ranking for their section
exports.getSectionRanking = async (req, res) => {
    try {
        const mySection = await teacherSection(req);
        if (!mySection) return ok(res, { ranking: [], section: null });
        const ranking = await computeSectionRanking(mySection._id, req.schoolId);
        ok(res, { ranking, section: { _id: mySection._id, sectionName: mySection.sectionName } });
    } catch (e) { err(res, e); }
};

// ── Teacher: section dashboard & student profile ──────────────────────────────

exports.getAttendanceDashboard = async (req, res) => {
    try {
        const mySection = await teacherSection(req);
        if (!mySection) return ok(res, { students: [], sessions: 0 });

        const [students, sessions] = await Promise.all([
            StudentProfile.find({ currentSection: mySection._id }).populate('user', 'name').lean(),
            Attendance.find({ section: mySection._id }).select('_id date').lean(),
        ]);
        const sessionIds = sessions.map(s => s._id);
        const records = sessionIds.length
            ? await AttendanceRecord.find({ attendance: { $in: sessionIds } }).lean()
            : [];

        const marksOf = {};
        for (const r of records) (marksOf[String(r.student)] = marksOf[String(r.student)] || []).push(r.status);

        const data = students.map(sp => {
            const t = sa.tally(marksOf[String(sp.user?._id)] || []);
            return {
                student: { _id: sp.user?._id, name: sp.user?.name, rollNumber: sp.rollNumber },
                present: t.present - t.late, absent: t.absent, late: t.late, halfDay: t.halfDay,
                total: t.total, percentage: t.percentage ?? 0,
            };
        });
        ok(res, { students: data, sessions: sessions.length });
    } catch (e) { err(res, e); }
};

exports.getStudentProfile = async (req, res) => {
    try {
        const profile = await StudentProfile.findOne({ user: req.params.studentId, school: req.schoolId })
            .populate('user', 'name email').lean();
        const records = await studentMonthRecords(req.params.studentId, req.schoolId, null, null);
        ok(res, { profile, records: records.slice(-30) });
    } catch (e) { err(res, e); }
};

// ── Teacher: student correction requests ──────────────────────────────────────
// Listing, reviewing and asking about requests: teacherAttendance.controller.js.

// ── Student: calendar & corrections ──────────────────────────────────────────

exports.getStudentAttendanceCalendar = async (req, res) => {
    try {
        const { month, year } = req.query;
        const records = await studentMonthRecords(req.userId, req.schoolId, +month || null, +year || null);
        ok(res, records);
    } catch (e) { err(res, e); }
};

/** Files multer accepted for a correction, as they are stored on it. */
const correctionFiles = (req) => (req.files || []).map(f => ({
    name: f.originalname, url: `/uploads/attendance-docs/${f.filename}`,
    size: f.size, type: f.mimetype, at: new Date().toISOString(), by: String(req.userId),
}));

exports.getStudentCorrectionForm = async (req, res) => {
    try {
        const requests = await AttendanceCorrection.find({ student: req.userId, school: req.schoolId })
            .sort({ createdAt: -1 }).limit(30).lean();
        ok(res, await studentCorrectionsOut(requests));
    } catch (e) { err(res, e); }
};

/**
 * GET /student/attendance/day?date= — the registers of one day and this
 * student's mark on each: what a correction can be asked about.
 */
exports.getStudentAttendanceDay = async (req, res) => {
    try {
        const dateStr = String(req.query.date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return err(res, 'date must be YYYY-MM-DD', 400);
        const mode = await sa.registrationMode(req.schoolId);
        const profile = await StudentProfile.findOne({ user: req.userId, school: req.schoolId }).lean();
        if (!profile?.currentSection) return ok(res, { mode, date: dateStr, registers: [] });

        const { start, end } = dayRange(dateStr);
        const sessions = await Attendance.find({ section: profile.currentSection, date: { $gte: start, $lte: end } }).lean();
        const [records, pending] = await Promise.all([
            sessions.length ? AttendanceRecord.find({ attendance: { $in: sessions.map(s => s._id) }, student: req.userId }).lean() : [],
            sessions.length ? AttendanceCorrection.find({ attendance: { $in: sessions.map(s => s._id) }, student: req.userId, status: 'Pending' }).select('attendance').lean() : [],
        ]);
        const recordOf = new Map(records.map(r => [String(r.attendance), r]));
        const pendingOn = new Set(pending.map(p => String(p.attendance)));
        const subjectIds = sessions.map(s => s.subject).filter(Boolean);
        const names = subjectIds.length
            ? new Map((await require('../models/Subject').find({ _id: { $in: subjectIds } }).select('subjectName').lean()).map(x => [String(x._id), x.subjectName]))
            : new Map();
        ok(res, {
            mode, date: dateStr,
            registers: sessions.map(s => ({
                attendance: s._id,
                subject: s.subject ? { _id: s.subject, name: names.get(String(s.subject)) || 'Subject' } : null,
                status: sa.lowStatus(recordOf.get(String(s._id))?.status),
                pending: pendingOn.has(String(s._id)),
            })).sort((a, b) => String(a.subject?.name || '').localeCompare(String(b.subject?.name || ''))),
        });
    } catch (e) { err(res, e); }
};

/**
 * POST /student/correction/submit  (multipart: date, attendance?, requestedStatus, reason, attachments[])
 *
 * `attendance` names the register when the day holds more than one (a
 * subject-wise school); a day with a single register needs only the date.
 */
exports.submitStudentCorrection = async (req, res) => {
    try {
        const { date, requestedStatus, reason } = req.body;
        if (!date || !requestedStatus || !String(reason || '').trim())
            return err(res, 'date, requestedStatus and reason are required', 400);

        const requested = capRecord(requestedStatus);
        if (!requested) return err(res, 'requestedStatus must be present, absent, late or half-day', 400);

        // Students may only regularize within the last one month
        const dateStr = new Date(date).toISOString().split('T')[0];
        if (dateStr > todayStr()) return err(res, 'Cannot request a correction for a future date', 400);
        const oneMonthAgo = new Date(); oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        if (new Date(dateStr + 'T00:00:00.000Z') < new Date(oneMonthAgo.toISOString().split('T')[0] + 'T00:00:00.000Z'))
            return err(res, 'Correction requests are only allowed for the last one month', 400);

        const profile = await StudentProfile.findOne({ user: req.userId, school: req.schoolId }).lean();
        if (!profile?.currentSection) return err(res, 'You are not enrolled in a section', 400);

        const { start, end } = dayRange(dateStr);
        const sessions = await Attendance.find({
            section: profile.currentSection, date: { $gte: start, $lte: end },
        }).lean();
        if (!sessions.length) return err(res, 'No attendance was taken on that date', 400);

        let session;
        if (req.body.attendance) {
            session = sessions.find(s => String(s._id) === String(req.body.attendance));
            if (!session) return err(res, 'That register is not one of yours for this date', 400);
        } else if (sessions.length === 1) {
            session = sessions[0];
        } else {
            return err(res, 'Attendance was taken for several subjects that day — choose which one to correct', 400);
        }

        const existing = await AttendanceCorrection.findOne({
            student: req.userId, attendance: session._id, status: 'Pending',
        }).lean();
        if (existing) return err(res, 'A pending correction request already exists for this register', 400);

        const record = await AttendanceRecord.findOne({ attendance: session._id, student: req.userId }).lean();
        if (record?.status === requested) return err(res, `You are already marked ${requested}`, 400);

        const files = correctionFiles(req);
        const text = String(reason).trim().slice(0, 500);
        const now = new Date();
        const corr = await AttendanceCorrection.create({
            student: req.userId,
            school:  req.schoolId,
            section: session.section,
            attendance:       session._id,
            attendanceRecord: record?._id || null,
            date:             session.date,
            subject:          session.subject || null,
            currentStatus:    record?.status || 'Not Marked',
            requestedStatus:  requested,
            reason: text,
            status: 'Pending',
            source: 'student',
            attachments: files,
            history: [{ event: 'submitted', at: now.toISOString(), by: String(req.userId), byName: req.user?.name || '', role: 'student', message: text, attachments: files.map(f => f.url) }],
            updatedAt: now,
            createdAt: now,
        });

        // The reviewing teachers, and the student's family, hear of it.
        notices.correctionSubmitted({ req, correction: corr.toObject ? corr.toObject() : corr });
        const [out] = await studentCorrectionsOut([corr.toObject ? corr.toObject() : corr]);
        ok(res, out, 201);
    } catch (e) { err(res, e); }
};

/**
 * POST /student/correction/:id/reply  (multipart: message, attachments[])
 * Answer a teacher who asked for more — the reply and any files join the trail.
 */
exports.replyStudentCorrection = async (req, res) => {
    try {
        const message = String(req.body.message || '').trim().slice(0, 500);
        const files = correctionFiles(req);
        if (!message && !files.length) return err(res, 'Write a reply or attach a file', 400);

        const corr = await AttendanceCorrection.findOne({ _id: req.params.id, student: req.userId, school: req.schoolId });
        if (!corr) return err(res, 'Request not found', 404);
        if (corr.status !== 'Pending') return err(res, 'This request has already been reviewed', 409);

        const now = new Date();
        corr.attachments = [...(corr.attachments || []), ...files];
        corr.history = [...(corr.history || []), {
            event: 'replied', at: now.toISOString(), by: String(req.userId), byName: req.user?.name || '',
            role: 'student', message, attachments: files.map(f => f.url),
        }];
        corr.updatedAt = now;
        await corr.save();

        notices.correctionReplied({ req, correction: corr.toObject(), message, fileCount: files.length });
        const [out] = await studentCorrectionsOut([corr.toObject()]);
        ok(res, out);
    } catch (e) { err(res, e); }
};

// ── Parent: child calendar ────────────────────────────────────────────────────

/**
 * The child a parent asks about (`?child=`, or the older `?childId=`), matched
 * against the parent's own children by both links — never trusted. Without one,
 * their first child. Returns { child, children }.
 */
async function parentChild(req) {
    const { childCards } = require('../services/parentChildren');
    const children = await childCards(req.userId, req.schoolId);
    const wanted = String(req.query.child || req.query.childId || '');
    const child = children.find((c) => c._id === wanted) || children[0] || null;
    return { child, children };
}

/** GET /parent/child-attendance?child=&month=&year= — one month, one row per day (the mobile app). */
exports.getParentChildAttendance = async (req, res) => {
    try {
        const { child } = await parentChild(req);
        if (!child) return ok(res, []);
        const { month, year } = req.query;
        const records = await studentMonthRecords(child._id, req.schoolId, +month || null, +year || null);
        ok(res, records);
    } catch (e) { err(res, e); }
};

/** GET /student/attendance/overview?month=YYYY-MM — services/studentAttendanceView.js */
exports.getStudentAttendanceOverview = async (req, res) => {
    try {
        const { attendanceOverview } = require('../services/studentAttendanceView');
        const data = await attendanceOverview({ schoolId: req.schoolId, studentId: req.userId, month: req.query.month });
        if (!data) return err(res, 'Student not found', 404);
        ok(res, data);
    } catch (e) { err(res, e); }
};

/** GET /parent/child-attendance/overview?child=&month=YYYY-MM — the same view, for one of the parent's children. */
exports.getParentChildAttendanceOverview = async (req, res) => {
    try {
        const { child, children } = await parentChild(req);
        if (!child) return ok(res, { children: [], child: null });
        const { attendanceOverview } = require('../services/studentAttendanceView');
        const data = await attendanceOverview({ schoolId: req.schoolId, studentId: child._id, month: req.query.month });
        ok(res, { ...data, children, child });
    } catch (e) { err(res, e); }
};

/** GET /parent/child-attendance/requests?child= — the child's correction requests, to read. */
exports.getParentChildCorrections = async (req, res) => {
    try {
        const { child } = await parentChild(req);
        if (!child) return ok(res, []);
        const rows = await AttendanceCorrection.find({ student: child._id, school: req.schoolId })
            .sort({ createdAt: -1 }).limit(50).lean();
        ok(res, await studentCorrectionsOut(rows));
    } catch (e) { err(res, e); }
};
