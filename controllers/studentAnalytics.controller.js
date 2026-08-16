'use strict';
//  Student Analytics — one 360° view of a student, assembled from every module
//  the school has switched on. Two audiences share this controller:
//
//    • school_admin — every student in the school
//    • teacher      — only students sitting in a section they own (class teacher
//                     or vice class teacher) or teach a subject in
//
//  Module blocks are computed ONLY when School.modules[<flag>] is true, and the
//  enabled flags ride along in the response so the web/mobile clients can render
//  exactly the tabs that have data behind them.

const User                  = require('../models/User');
const School                = require('../models/School');
const StudentProfile        = require('../models/StudentProfile');
const ClassSection          = require('../models/ClassSection');
const AcademicYear          = require('../models/AcademicYear');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Subject               = require('../models/Subject');
const Attendance            = require('../models/Attendance');
const AttendanceRecord      = require('../models/AttendanceRecord');
const FormalResult          = require('../models/FormalResult');
const ClassTest             = require('../models/ClassTest');
const ExamResult            = require('../models/ExamResult');
const ExamAttempt           = require('../models/ExamAttempt');
const ExamViolation         = require('../models/ExamViolation');
const FeeLedger             = require('../models/FeeLedger');
const FeePayment            = require('../models/FeePayment');
const StudentFeeAssignment  = require('../models/StudentFeeAssignment');
const StudentConcession     = require('../models/StudentConcession');
const LibraryIssuance       = require('../models/LibraryIssuance');
const LibraryFine           = require('../models/LibraryFine');
const LibraryReservation    = require('../models/LibraryReservation');
const TransportAssignment   = require('../models/TransportAssignment');
const TransportTrip         = require('../models/TransportTrip');
const TransportFeeInvoice   = require('../models/TransportFeeInvoice');
const TransportComplaint    = require('../models/TransportComplaint');
const VideoProgress         = require('../models/VideoProgress');
const VideoAssignment       = require('../models/VideoAssignment');
const AssignmentSubmission  = require('../models/AssignmentSubmission');
const Document              = require('../models/Document');
const Timetable             = require('../models/Timetable');
const TimetableEntry        = require('../models/TimetableEntry');
const NotificationReceipt   = require('../models/NotificationReceipt');
const InventoryIssue        = require('../models/InventoryIssue');
const StudentSectionHistory = require('../models/StudentSectionHistory');

const ok  = (res, d, s = 200) => res.status(s).json({ success: true, data: d });
const err = (res, e, s = 500) => res.status(s).json({ success: false, message: e.message || e });

// ── small helpers ─────────────────────────────────────────────────────────────
const sid    = (v) => (v == null ? '' : String(v._id ?? v));
const pct    = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const money  = (n) => Math.round((Number(n) || 0) * 100) / 100;
const low    = (s) => String(s || '').toLowerCase();
const sum    = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const monthKey = (d) => {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
};
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ageFrom = (dob) => {
    if (!dob) return null;
    const d = new Date(dob);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    let a = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a -= 1;
    return a >= 0 && a < 120 ? a : null;
};

// ── Scope: which sections may the caller look at? ─────────────────────────────
//  Admins get the whole school. Teachers get the union of the sections they are
//  class teacher / vice class teacher of, plus every section they teach a
//  subject in. Everything downstream filters on this list, so a teacher can
//  never reach a student outside their own classes.
async function resolveScope(req) {
    const school = req.schoolId;
    const activeYear = await AcademicYear.findOne({ school, status: 'active' }).lean();

    if (req.userRole === 'school_admin') {
        const filter = { school };
        if (activeYear) { filter.academicYear = activeYear._id; filter.status = 'active'; }
        const sections = await ClassSection.find(filter)
            .populate('class', 'className classNumber').lean();
        return {
            canSeeAll:  true,
            activeYear,
            sections:   sections.map((s) => shapeSection(s, [], [])),
            sectionIds: sections.map((s) => String(s._id)),
        };
    }

    const [own, links] = await Promise.all([
        ClassSection.find({
            school,
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
        }).select('_id classTeacher substituteTeacher').lean(),
        SectionSubjectTeacher.find({ teacher: req.userId })
            .populate('subject', 'subjectName').lean(),
    ]);

    const roles    = {};   // sectionId → ['Class Teacher', …]
    const subjects = {};   // sectionId → ['Maths', …]
    const addRole  = (id, role) => {
        const k = String(id);
        roles[k] = roles[k] || [];
        if (!roles[k].includes(role)) roles[k].push(role);
    };
    own.forEach((s) => addRole(
        s._id,
        String(s.classTeacher) === String(req.userId) ? 'Class Teacher' : 'Vice Class Teacher',
    ));
    links.forEach((l) => {
        if (!l.section) return;
        addRole(l.section, 'Subject Teacher');
        const k = String(l.section);
        subjects[k] = subjects[k] || [];
        const name = l.subject?.subjectName;
        if (name && !subjects[k].includes(name)) subjects[k].push(name);
    });

    const ids = Object.keys(roles);
    // Re-read through the school filter: a stale subject link must never widen
    // the scope past the teacher's own school.
    const sections = ids.length
        ? await ClassSection.find({ _id: { $in: ids }, school }).populate('class', 'className classNumber').lean()
        : [];

    return {
        canSeeAll:  false,
        activeYear,
        sections:   sections.map((s) => shapeSection(s, roles[String(s._id)] || [], subjects[String(s._id)] || [])),
        sectionIds: sections.map((s) => String(s._id)),
    };
}

function shapeSection(s, roles, subjects) {
    return {
        _id:          s._id,
        sectionName:  s.sectionName,
        classId:      sid(s.class),
        className:    s.class?.className || '',
        classNumber:  s.class?.classNumber ?? null,
        studentCount: (s.enrolledStudents || []).length,
        roles,
        subjects,
    };
}

async function getModules(schoolId) {
    const school = await School.findById(schoolId).select('modules').lean();
    const m = school?.modules || {};
    return {
        attendance:   !!m.attendance,
        result:       !!m.result,
        aptitudeExam: !!m.aptitudeExam,
        fees:         !!m.fees,
        library:      !!m.library,
        transport:    !!m.transport,
        videoLibrary: !!m.videoLibrary,
        document:     !!m.document,
        timetable:    !!m.timetable,
        inventory:    !!m.inventory,
        notification: !!m.notification,
    };
}

// ── GET /scope — sections the caller may analyse + enabled module flags ───────
exports.getScope = async (req, res) => {
    try {
        const [scope, modules] = await Promise.all([resolveScope(req), getModules(req.schoolId)]);
        ok(res, {
            role:      req.userRole,
            canSeeAll: scope.canSeeAll,
            academicYear: scope.activeYear
                ? { _id: scope.activeYear._id, yearName: scope.activeYear.yearName }
                : null,
            sections: scope.sections.sort((a, b) =>
                String(a.className).localeCompare(String(b.className), 'en', { numeric: true })
                || String(a.sectionName).localeCompare(String(b.sectionName))),
            modules,
        });
    } catch (e) { err(res, e); }
};

// ── Filters ───────────────────────────────────────────────────────────────────
//  Two kinds. `classId` / `sectionId` / `search` / `gender` are columns, so SQL
//  answers them and the page is fetched straight from the database. The rest
//  (attendance %, result average, fee balance, books out, transport, account
//  status) are *derived* — they only exist once the per-student metrics have
//  been computed, so asking for one switches the roster to a pass that loads
//  the whole scoped set, computes metrics, then filters, sorts and pages in
//  memory. Same for any sort that isn't the default roll-number order.
const METRIC_FILTER_KEYS = ['status', 'attendance', 'result', 'fees', 'library', 'transport'];
const MEMORY_SORTS = new Set(['name', 'attendance', 'result', 'dues']);

const needsMetricPass = (q) =>
    METRIC_FILTER_KEYS.some((k) => q[k]) || MEMORY_SORTS.has(q.sortBy);

const ATTENDANCE_BANDS = {
    '90plus':    (v) => v != null && v >= 90,
    '75to90':    (v) => v != null && v >= 75 && v < 90,
    '60to75':    (v) => v != null && v >= 60 && v < 75,
    'below75':   (v) => v != null && v < 75,
    'below60':   (v) => v != null && v < 60,
    'untracked': (v) => v == null,
};
const RESULT_BANDS = {
    '75plus':     (v) => v != null && v >= 75,
    '60to75':     (v) => v != null && v >= 60 && v < 75,
    '40to60':     (v) => v != null && v >= 40 && v < 60,
    'below40':    (v) => v != null && v < 40,
    'unassessed': (v) => v == null,
};

function matchesFilters(row, q) {
    if (q.status === 'active'   && !row.isActive) return false;
    if (q.status === 'inactive' &&  row.isActive) return false;

    if (q.attendance) {
        const test = ATTENDANCE_BANDS[q.attendance];
        if (test && !test(row.attendancePercent)) return false;
    }
    if (q.result) {
        const test = RESULT_BANDS[q.result];
        if (test && !test(row.avgPercent)) return false;
    }
    if (q.fees === 'due'   && !((row.feeBalance || 0) > 0)) return false;
    if (q.fees === 'clear' &&  ((row.feeBalance || 0) > 0)) return false;

    if (q.library === 'out'     && !(row.booksOut || 0))     return false;
    if (q.library === 'overdue' && !(row.booksOverdue || 0)) return false;

    if (q.transport === 'assigned' && !row.transportAssigned) return false;
    if (q.transport === 'none'     &&  row.transportAssigned) return false;

    return true;
}

// Nulls always sink to the bottom regardless of direction — "no data" is never
// the top of a ranking a teacher is meant to act on.
function sortRows(rows, q) {
    const key = { attendance: 'attendancePercent', result: 'avgPercent', dues: 'feeBalance' }[q.sortBy];
    if (q.sortBy === 'name') {
        const dir = q.sortDir === 'desc' ? -1 : 1;
        return rows.sort((a, b) => dir * String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
    }
    if (!key) return rows;
    // Worst-first is the actionable default for attendance and results; for dues
    // the largest debt is what matters, so that one defaults the other way.
    const dir = (q.sortDir || (q.sortBy === 'dues' ? 'desc' : 'asc')) === 'desc' ? -1 : 1;
    return rows.sort((a, b) => {
        const av = a[key], bv = b[key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return dir * (av - bv);
    });
}

function shapeStudent(p, metrics) {
    const id = String(p.user?._id || p.user);
    return {
        _id:             id,
        name:            p.user?.name || '',
        email:           p.user?.email || '',
        profileImage:    p.user?.profileImage || '',
        isActive:        p.user?.isActive !== false,
        rollNumber:      p.rollNumber || '',
        admissionNumber: p.admissionNumber || '',
        gender:          p.gender || '',
        className:       p.currentSection?.class?.className || '',
        sectionName:     p.currentSection?.sectionName || '',
        sectionId:       sid(p.currentSection),
        ...metrics[id],
    };
}

// ── Student roster resolution shared by /students and /overview ───────────────
//  Returns the StudentProfile rows the caller is allowed to see, already
//  narrowed by the requested class/section/search/gender filters.
async function scopedProfiles(req, scope, { paginate = false } = {}) {
    const { sectionId, classId, search, gender } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const filter = { school: req.schoolId };
    if (gender) filter.gender = gender;

    // Section narrowing — always intersected with the caller's scope.
    let allowed = scope.sectionIds;
    if (sectionId) {
        if (!allowed.includes(String(sectionId))) return { forbidden: true };
        allowed = [String(sectionId)];
    } else if (classId) {
        const inClass = scope.sections.filter((s) => String(s.classId) === String(classId)).map((s) => String(s._id));
        if (!inClass.length) return { profiles: [], total: 0, page, limit };
        allowed = inClass;
    }
    // An admin browsing unfiltered should also see students who have been
    // admitted but not placed in a section yet — they are invisible to any
    // section-based filter, and they are exactly the ones worth chasing.
    const includeUnplaced = scope.canSeeAll && !sectionId && !classId;
    if (!allowed.length && !includeUnplaced) return { profiles: [], total: 0, page, limit };
    if (includeUnplaced) {
        filter.$or = [{ currentSection: { $in: allowed } }, { currentSection: null }];
    } else {
        filter.currentSection = { $in: allowed };
    }

    if (search && String(search).trim()) {
        const rx = escapeRx(String(search).trim());
        const [users, profs] = await Promise.all([
            User.find({
                school: req.schoolId, role: 'student',
                $or: [{ name: { $regex: rx, $options: 'i' } }, { email: { $regex: rx, $options: 'i' } }],
            }).select('_id').lean(),
            StudentProfile.find({
                school: req.schoolId,
                $or: [
                    { admissionNumber: { $regex: rx, $options: 'i' } },
                    { rollNumber:      { $regex: rx, $options: 'i' } },
                ],
            }).select('user').lean(),
        ]);
        const ids = new Set([...users.map((u) => String(u._id)), ...profs.map((p) => String(p.user))]);
        if (!ids.size) return { profiles: [], total: 0, page, limit };
        filter.user = { $in: [...ids] };
    }

    const query = StudentProfile.find(filter)
        .populate('user', 'name email phone profileImage isActive lastSeenAt')
        .populate({ path: 'currentSection', select: 'sectionName class', populate: { path: 'class', select: 'className classNumber' } })
        .sort({ rollNumber: 1 });

    // Deleting a user does not always take its StudentProfile with it. Such a
    // row populates to a null user and would render as a nameless student, so
    // drop it here. (Done after paging, so a page can come back a row short —
    // acceptable for what is a data-integrity artifact, not a normal state.)
    const withUser = (rows) => rows.filter((r) => r.user && r.user._id);

    if (paginate) {
        // countDocuments() would count the orphaned rows dropped just above, so
        // the roster's "N total" would exceed what it can actually list — and
        // disagree with /overview, which filters the same way over the full set.
        // Two single-column reads keep the number exact.
        const [profiles, refs, live] = await Promise.all([
            query.skip((page - 1) * limit).limit(limit).lean(),
            StudentProfile.find(filter).select('user').lean(),
            User.find({ school: req.schoolId, role: 'student' }).select('_id').lean(),
        ]);
        const liveIds = new Set(live.map((u) => String(u._id)));
        const total = refs.reduce((n, r) => n + (liveIds.has(String(r.user)) ? 1 : 0), 0);
        return { profiles: withUser(profiles), total, page, limit };
    }
    const profiles = withUser(await query.lean());
    return { profiles, total: profiles.length, page, limit };
}

// ── Batch metrics for a page of students ─────────────────────────────────────
//  One query per module for the whole page instead of one per student.
async function batchMetrics(studentIds, sectionIds, modules, schoolId, activeYear) {
    const out = {};
    studentIds.forEach((id) => { out[id] = {}; });
    if (!studentIds.length) return out;

    const jobs = [];

    if (modules.attendance && sectionIds.length) {
        jobs.push((async () => {
            const sessions = await Attendance.find({ section: { $in: sectionIds } }).select('_id').lean();
            if (!sessions.length) return;
            const records = await AttendanceRecord.find({
                attendance: { $in: sessions.map((s) => s._id) },
                student:    { $in: studentIds },
            }).select('student status').lean();
            const tally = {};
            records.forEach((r) => {
                const k = String(r.student);
                tally[k] = tally[k] || { total: 0, present: 0 };
                tally[k].total += 1;
                if (low(r.status) !== 'absent') tally[k].present += 1;
            });
            studentIds.forEach((id) => {
                const t = tally[id];
                out[id].attendancePercent = t ? pct(t.present, t.total) : null;
                out[id].attendanceDays    = t ? t.total : 0;
            });
        })());
    }

    if (modules.result) {
        jobs.push((async () => {
            const results = await FormalResult.find({ student: { $in: studentIds }, school: schoolId })
                .select('student percentage grade isPassed generatedAt')
                .sort({ generatedAt: 1 }).lean();
            const byStudent = {};
            results.forEach((r) => {
                const k = String(r.student);
                (byStudent[k] = byStudent[k] || []).push(r);
            });
            studentIds.forEach((id) => {
                const list = byStudent[id] || [];
                out[id].examCount   = list.length;
                out[id].avgPercent  = list.length ? Math.round((sum(list, (r) => r.percentage) / list.length) * 10) / 10 : null;
                out[id].lastGrade   = list.length ? (list[list.length - 1].grade || '') : '';
                out[id].failedExams = list.filter((r) => r.isPassed === false).length;
            });
        })());
    }

    if (modules.fees) {
        jobs.push((async () => {
            const filter = { student: { $in: studentIds }, school: schoolId };
            if (activeYear) filter.academicYear = activeYear._id;
            const entries = await FeeLedger.find(filter)
                .select('student entryType category amount runningBalance createdAt')
                .sort({ createdAt: 1 }).lean();
            const byStudent = {};
            entries.forEach((e) => { (byStudent[String(e.student)] = byStudent[String(e.student)] || []).push(e); });
            studentIds.forEach((id) => {
                const list = byStudent[id] || [];
                if (!list.length) { out[id].feeBalance = 0; out[id].feePaid = 0; return; }
                out[id].feeBalance = money(list[list.length - 1].runningBalance);
                out[id].feePaid    = money(sum(list.filter((e) => e.entryType === 'credit' && e.category === 'payment'), (e) => e.amount));
            });
        })());
    }

    if (modules.library) {
        jobs.push((async () => {
            const issues = await LibraryIssuance.find({
                issuedTo: { $in: studentIds }, school: schoolId, status: { $in: ['issued', 'overdue'] },
            }).select('issuedTo status dueDate').lean();
            const now = new Date();
            issues.forEach((i) => {
                const k = String(i.issuedTo);
                out[k].booksOut = (out[k]?.booksOut || 0) + 1;
                if (low(i.status) === 'overdue' || (i.dueDate && new Date(i.dueDate) < now)) {
                    out[k].booksOverdue = (out[k].booksOverdue || 0) + 1;
                }
            });
        })());
    }

    if (modules.transport) {
        jobs.push((async () => {
            const assigns = await TransportAssignment.find({
                student: { $in: studentIds }, school: schoolId, status: 'active',
            }).select('student').lean();
            const assigned = new Set(assigns.map((a) => String(a.student)));
            studentIds.forEach((id) => { out[id].transportAssigned = assigned.has(id); });
        })());
    }

    if (modules.videoLibrary) {
        jobs.push((async () => {
            const progress = await VideoProgress.find({ student: { $in: studentIds }, school: schoolId })
                .select('student completed progressPercent').lean();
            const byStudent = {};
            progress.forEach((p) => { (byStudent[String(p.student)] = byStudent[String(p.student)] || []).push(p); });
            studentIds.forEach((id) => {
                const list = byStudent[id] || [];
                out[id].videosWatched   = list.length;
                out[id].videosCompleted = list.filter((p) => p.completed).length;
            });
        })());
    }

    await Promise.all(jobs);
    return out;
}

// ── Roster loader — the one place filters, sorting and paging are applied ────
//  `paginate: false` (used by /overview) always takes the metric pass, because
//  the roll-up has to reflect exactly the same filtered population the roster
//  shows — otherwise the KPI tiles and the list below them disagree.
async function loadRoster(req, scope, modules, { paginate }) {
    const metricPass = paginate ? needsMetricPass(req.query) : true;
    const result = await scopedProfiles(req, scope, { paginate: paginate && !metricPass });
    if (result.forbidden) return result;

    const { profiles, page, limit } = result;
    const studentIds = profiles.map((p) => String(p.user._id));
    const sectionIds = [...new Set(profiles.map((p) => sid(p.currentSection)).filter(Boolean))];
    const metrics = await batchMetrics(studentIds, sectionIds, modules, req.schoolId, scope.activeYear);

    let rows = profiles.map((p) => shapeStudent(p, metrics));
    if (metricPass) {
        rows = sortRows(rows.filter((r) => matchesFilters(r, req.query)), req.query);
    } else if (req.query.sortBy === 'roll' && req.query.sortDir === 'desc') {
        rows = rows.reverse();
    }

    const total    = metricPass ? rows.length : result.total;
    const pageRows = (paginate && metricPass)
        ? rows.slice((page - 1) * limit, page * limit)
        : rows;

    return { rows, pageRows, total, page, limit };
}

// ── GET /students — the roster with headline metrics ─────────────────────────
exports.getStudents = async (req, res) => {
    try {
        const [scope, modules] = await Promise.all([resolveScope(req), getModules(req.schoolId)]);
        const result = await loadRoster(req, scope, modules, { paginate: true });
        if (result.forbidden) return err(res, 'You are not assigned to this section', 403);

        const { pageRows, total, page, limit } = result;
        ok(res, {
            modules,
            total, page, limit,
            pages: Math.max(1, Math.ceil(total / limit)),
            students: pageRows,
        });
    } catch (e) { err(res, e); }
};

// ── GET /overview — class/school level roll-up over the same scope ────────────
exports.getOverview = async (req, res) => {
    try {
        const [scope, modules] = await Promise.all([resolveScope(req), getModules(req.schoolId)]);
        const result = await loadRoster(req, scope, modules, { paginate: false });
        if (result.forbidden) return err(res, 'You are not assigned to this section', 403);

        const { rows } = result;
        const sectionIds = [...new Set(rows.map((r) => r.sectionId).filter(Boolean))];

        const gender = { male: 0, female: 0, other: 0, unspecified: 0 };
        rows.forEach((r) => {
            const g = low(r.gender);
            if (g === 'male') gender.male += 1;
            else if (g === 'female') gender.female += 1;
            else if (g === 'other') gender.other += 1;
            else gender.unspecified += 1;
        });

        const withAtt = rows.filter((r) => r.attendancePercent != null);
        const withRes = rows.filter((r) => r.avgPercent != null);

        const overview = {
            modules,
            scope: {
                canSeeAll: scope.canSeeAll,
                sectionCount: sectionIds.length,
                sections: scope.sections,
            },
            totals: {
                students: rows.length,
                active:   rows.filter((r) => r.isActive).length,
                gender,
            },
        };

        if (modules.attendance) {
            const bands = { above90: 0, from75to90: 0, from60to75: 0, below60: 0 };
            withAtt.forEach((r) => {
                if (r.attendancePercent >= 90) bands.above90 += 1;
                else if (r.attendancePercent >= 75) bands.from75to90 += 1;
                else if (r.attendancePercent >= 60) bands.from60to75 += 1;
                else bands.below60 += 1;
            });
            overview.attendance = {
                average: withAtt.length ? Math.round((sum(withAtt, (r) => r.attendancePercent) / withAtt.length) * 10) / 10 : null,
                tracked: withAtt.length,
                bands,
                lowest: [...withAtt].sort((a, b) => a.attendancePercent - b.attendancePercent).slice(0, 5),
            };
        }

        if (modules.result) {
            overview.results = {
                average:  withRes.length ? Math.round((sum(withRes, (r) => r.avgPercent) / withRes.length) * 10) / 10 : null,
                assessed: withRes.length,
                toppers:  [...withRes].sort((a, b) => b.avgPercent - a.avgPercent).slice(0, 5),
                needHelp: [...withRes].sort((a, b) => a.avgPercent - b.avgPercent).slice(0, 5),
                failing:  rows.filter((r) => (r.failedExams || 0) > 0).length,
            };
        }

        if (modules.fees) {
            const owing = rows.filter((r) => (r.feeBalance || 0) > 0);
            overview.fees = {
                collected:   money(sum(rows, (r) => r.feePaid || 0)),
                outstanding: money(sum(owing, (r) => r.feeBalance)),
                defaulters:  owing.length,
                topDues:     [...owing].sort((a, b) => b.feeBalance - a.feeBalance).slice(0, 5),
            };
        }

        if (modules.library) {
            overview.library = {
                booksOut: sum(rows, (r) => r.booksOut || 0),
                overdue:  sum(rows, (r) => r.booksOverdue || 0),
                readers:  rows.filter((r) => (r.booksOut || 0) > 0).length,
            };
        }

        if (modules.videoLibrary) {
            overview.videos = {
                watched:   sum(rows, (r) => r.videosWatched || 0),
                completed: sum(rows, (r) => r.videosCompleted || 0),
                viewers:   rows.filter((r) => (r.videosWatched || 0) > 0).length,
            };
        }

        ok(res, overview);
    } catch (e) { err(res, e); }
};

// ── Per-student module blocks ────────────────────────────────────────────────

async function generalBlock(ctx) {
    const { profile, user } = ctx;
    const sectionId = sid(profile.currentSection);

    const [section, history, parent] = await Promise.all([
        sectionId
            ? ClassSection.findById(sectionId)
                .populate('class', 'className classNumber')
                .populate('classTeacher', 'name email phone')
                .populate('substituteTeacher', 'name email phone')
                .lean()
            : null,
        StudentSectionHistory.find({ student: user._id })
            .populate({ path: 'oldSection', select: 'sectionName class', populate: { path: 'class', select: 'className' } })
            .populate({ path: 'newSection', select: 'sectionName class', populate: { path: 'class', select: 'className' } })
            .sort({ transferDate: -1 }).limit(10).lean(),
        profile.parent ? User.findById(sid(profile.parent)).select('name email phone').lean() : null,
    ]);

    const subjectTeachers = sectionId
        ? await SectionSubjectTeacher.find({ section: sectionId })
            .populate('subject', 'subjectName subjectCode')
            .populate('teacher', 'name email').lean()
        : [];

    return {
        student: {
            _id:          user._id,
            name:         user.name,
            email:        user.email,
            phone:        user.phone || '',
            profileImage: user.profileImage || '',
            isActive:     user.isActive !== false,
            lastSeenAt:   user.lastSeenAt || null,
            joinedAt:     user.createdAt || null,
        },
        profile: {
            admissionNumber: profile.admissionNumber || '',
            rollNumber:      profile.rollNumber || '',
            gender:          profile.gender || '',
            dob:             profile.dob || null,
            age:             ageFrom(profile.dob),
            bloodGroup:      profile.bloodGroup || '',
            religion:        profile.religion || '',
            category:        profile.category || '',
            address:         profile.address || '',
            city:            profile.city || '',
            state:           profile.state || '',
            pincode:         profile.pincode || '',
            country:         profile.country || '',
        },
        placement: {
            className:        section?.class?.className || profile.class || '',
            classNumber:      section?.class?.classNumber ?? null,
            sectionName:      section?.sectionName || profile.section || '',
            sectionId,
            classTeacher:     section?.classTeacher || null,
            viceClassTeacher: section?.substituteTeacher || null,
            // Drop links whose subject or teacher no longer resolves — a deleted
            // subject/teacher leaves the join row behind and it would render blank.
            subjectTeachers: subjectTeachers
                .filter((t) => t.subject?.subjectName || t.teacher?.name)
                .map((t) => ({
                    subject: t.subject?.subjectName || '',
                    code:    t.subject?.subjectCode || '',
                    teacher: t.teacher?.name || '',
                    email:   t.teacher?.email || '',
                })),
        },
        parent: parent || null,
        sectionHistory: history.map((h) => ({
            date:   h.transferDate,
            from:   h.oldSection ? `${h.oldSection.class?.className || ''} ${h.oldSection.sectionName || ''}`.trim() : '',
            to:     h.newSection ? `${h.newSection.class?.className || ''} ${h.newSection.sectionName || ''}`.trim() : '',
            reason: h.transferReason || '',
        })),
    };
}

async function attendanceBlock(ctx) {
    const { user, profile } = ctx;
    const sectionId = sid(profile.currentSection);
    if (!sectionId) return { tracked: false, total: 0, present: 0, absent: 0, late: 0, percent: null, monthly: [], recent: [], rank: null, sectionSize: 0 };

    const sessions = await Attendance.find({ section: sectionId }).sort({ date: 1 }).lean();
    if (!sessions.length) {
        return { tracked: false, total: 0, present: 0, absent: 0, late: 0, percent: null, monthly: [], recent: [], rank: null, sectionSize: 0 };
    }
    const sessionIds = sessions.map((s) => s._id);
    const dateOf = Object.fromEntries(sessions.map((s) => [String(s._id), s.date]));

    // Whole-section records power both the student's own numbers and their rank.
    const allRecords = await AttendanceRecord.find({ attendance: { $in: sessionIds } })
        .select('attendance student status remarks').lean();

    const mine = allRecords.filter((r) => String(r.student) === String(user._id));
    const counts = { present: 0, absent: 0, late: 0 };
    const monthly = {};
    mine.forEach((r) => {
        const st = low(r.status);
        if (counts[st] !== undefined) counts[st] += 1;
        const k = monthKey(dateOf[String(r.attendance)]);
        monthly[k] = monthly[k] || { month: k, present: 0, absent: 0, late: 0, total: 0 };
        monthly[k].total += 1;
        if (monthly[k][st] !== undefined) monthly[k][st] += 1;
    });

    // Rank inside the section: present+late counted as attended, same as the %.
    const tally = {};
    allRecords.forEach((r) => {
        const k = String(r.student);
        tally[k] = tally[k] || { total: 0, attended: 0 };
        tally[k].total += 1;
        if (low(r.status) !== 'absent') tally[k].attended += 1;
    });
    const ladder = Object.entries(tally)
        .map(([id, t]) => ({ id, percent: pct(t.attended, t.total) }))
        .sort((a, b) => b.percent - a.percent);
    const rank = ladder.findIndex((x) => x.id === String(user._id)) + 1;

    const total = mine.length;
    const recent = mine
        .map((r) => ({ date: dateOf[String(r.attendance)], status: low(r.status), remarks: r.remarks || '' }))
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 20);

    return {
        tracked:     true,
        total,
        present:     counts.present,
        absent:      counts.absent,
        late:        counts.late,
        percent:     pct(counts.present + counts.late, total),
        monthly:     Object.values(monthly)
            .map((m) => ({ ...m, percent: pct(m.present + m.late, m.total) }))
            .sort((a, b) => a.month.localeCompare(b.month))
            .slice(-12),
        recent,
        rank:        rank || null,
        sectionSize: ladder.length,
    };
}

async function resultsBlock(ctx) {
    const { user, profile, schoolId } = ctx;
    const sectionId = sid(profile.currentSection);

    const [formal, tests, subjects] = await Promise.all([
        FormalResult.find({ student: user._id, school: schoolId })
            .populate('exam', 'title examType startDate endDate status')
            .sort({ generatedAt: 1 }).lean(),
        sectionId
            ? ClassTest.find({ section: sectionId, school: schoolId })
                .populate('subject', 'subjectName')
                .sort({ testDate: 1 }).lean()
            : [],
        Subject.find({ school: schoolId }).select('subjectName').lean(),
    ]);
    const subjectName = Object.fromEntries(subjects.map((s) => [String(s._id), s.subjectName]));

    const exams = formal.map((r) => ({
        _id:        r._id,
        title:      r.exam?.title || 'Exam',
        examType:   r.exam?.examType || '',
        date:       r.exam?.endDate || r.generatedAt,
        obtained:   r.totalMarks,
        max:        r.totalMaxMarks,
        percentage: r.percentage,
        grade:      r.grade || '',
        rank:       r.rank || null,
        isPassed:   r.isPassed,
        subjects:   (r.subjects || []).map((s) => ({
            subject:  subjectName[sid(s.subject)] || 'Subject',
            obtained: s.marksObtained,
            max:      s.maxMarks,
            grade:    s.grade || '',
            isPassed: s.isPassed,
            isAbsent: s.isAbsent,
            percent:  pct(s.marksObtained, s.maxMarks),
        })),
    }));

    // Class tests hold every student's marks in one row — pull out just this one.
    const myTests = [];
    tests.forEach((t) => {
        const entry = (t.marks || []).find((m) => String(m.student) === String(user._id));
        if (!entry) return;
        myTests.push({
            _id:       t._id,
            title:     t.title,
            subject:   t.subject?.subjectName || '',
            date:      t.testDate,
            obtained:  entry.marksObtained,
            max:       t.maxMarks,
            passing:   t.passingMarks,
            grade:     entry.grade || '',
            isAbsent:  entry.isAbsent,
            percent:   entry.isAbsent ? null : pct(entry.marksObtained, t.maxMarks),
            classAvg:  t.classStats?.average ?? null,
            status:    low(t.status),
        });
    });

    // Subject strength across both assessment types.
    const bySubject = {};
    exams.forEach((e) => e.subjects.forEach((s) => {
        if (s.isAbsent) return;
        bySubject[s.subject] = bySubject[s.subject] || { subject: s.subject, points: [], source: 'exam' };
        bySubject[s.subject].points.push(s.percent);
    }));
    myTests.forEach((t) => {
        if (t.isAbsent || !t.subject) return;
        bySubject[t.subject] = bySubject[t.subject] || { subject: t.subject, points: [], source: 'test' };
        bySubject[t.subject].points.push(t.percent);
    });
    const subjectAverages = Object.values(bySubject)
        .map((s) => ({
            subject:     s.subject,
            average:     Math.round((sum(s.points, (p) => p) / s.points.length) * 10) / 10,
            assessments: s.points.length,
        }))
        .sort((a, b) => b.average - a.average);

    const graded = exams.filter((e) => e.percentage != null);
    return {
        exams,
        classTests: myTests,
        subjectAverages,
        strongest: subjectAverages[0] || null,
        weakest:   subjectAverages.length > 1 ? subjectAverages[subjectAverages.length - 1] : null,
        summary: {
            examsTaken:  exams.length,
            testsTaken:  myTests.length,
            average:     graded.length ? Math.round((sum(graded, (e) => e.percentage) / graded.length) * 10) / 10 : null,
            best:        graded.length ? Math.max(...graded.map((e) => e.percentage)) : null,
            bestRank:    graded.filter((e) => e.rank).length ? Math.min(...graded.filter((e) => e.rank).map((e) => e.rank)) : null,
            failedExams: exams.filter((e) => e.isPassed === false).length,
        },
        trend: exams.map((e) => ({ label: e.title, date: e.date, percentage: e.percentage })),
    };
}

async function aptitudeBlock(ctx) {
    const { user, schoolId } = ctx;
    const [results, attempts, violations] = await Promise.all([
        ExamResult.find({ student: user._id, school: schoolId })
            .populate({ path: 'exam', select: 'title examDate subject totalMarks', populate: { path: 'subject', select: 'subjectName' } })
            .sort({ createdAt: 1 }).lean(),
        ExamAttempt.find({ student: user._id, school: schoolId }).select('status violationCount submittedAt').lean(),
        ExamViolation.find({ student: user._id, school: schoolId }).select('violationType occurredAt').lean(),
    ]);

    const list = results.map((r) => ({
        _id:        r._id,
        title:      r.exam?.title || 'Aptitude exam',
        subject:    r.exam?.subject?.subjectName || '',
        date:       r.exam?.examDate || r.createdAt,
        obtained:   r.obtainedMarks,
        max:        r.totalMarks,
        percentage: r.percentage,
    }));

    const violationTypes = {};
    violations.forEach((v) => { violationTypes[v.violationType] = (violationTypes[v.violationType] || 0) + 1; });

    return {
        exams: list,
        summary: {
            attempted:  attempts.length,
            submitted:  attempts.filter((a) => ['submitted', 'auto_submitted'].includes(low(a.status))).length,
            evaluated:  list.length,
            average:    list.length ? Math.round((sum(list, (e) => e.percentage) / list.length) * 10) / 10 : null,
            best:       list.length ? Math.max(...list.map((e) => e.percentage)) : null,
            violations: violations.length,
        },
        violationTypes: Object.entries(violationTypes).map(([type, count]) => ({ type, count })),
    };
}

async function feesBlock(ctx) {
    const { user, schoolId, activeYear } = ctx;
    const yearFilter = activeYear ? { academicYear: activeYear._id } : {};

    const [ledger, payments, assignment, concessions] = await Promise.all([
        FeeLedger.find({ student: user._id, school: schoolId, ...yearFilter })
            .sort({ createdAt: 1 }).lean(),
        FeePayment.find({ student: user._id, school: schoolId, ...yearFilter })
            .sort({ paymentDate: -1 }).limit(20).lean(),
        StudentFeeAssignment.findOne({ student: user._id, school: schoolId, isActive: true, ...yearFilter })
            .populate('feeStructure', 'name').lean(),
        StudentConcession.find({ student: user._id, school: schoolId, isActive: true, ...yearFilter })
            .populate('concession', 'name concessionType value').lean(),
    ]);

    const charged    = sum(ledger.filter((e) => e.entryType === 'debit'  && e.category === 'fee_charged'), (e) => e.amount);
    const paid       = sum(ledger.filter((e) => e.entryType === 'credit' && e.category === 'payment'),     (e) => e.amount);
    const concession = sum(ledger.filter((e) => e.entryType === 'credit' && e.category === 'concession'),  (e) => e.amount);
    const fine       = sum(ledger.filter((e) => e.entryType === 'debit'  && e.category === 'fine'),        (e) => e.amount);
    const balance    = ledger.length ? ledger[ledger.length - 1].runningBalance : 0;

    const monthly = {};
    ledger.filter((e) => e.entryType === 'credit' && e.category === 'payment').forEach((e) => {
        const k = monthKey(e.createdAt);
        monthly[k] = monthly[k] || { month: k, paid: 0 };
        monthly[k].paid += Number(e.amount) || 0;
    });

    const confirmed = payments.filter((p) => low(p.paymentStatus) === 'completed');

    return {
        summary: {
            assigned:   money(assignment?.totalAmount || charged),
            charged:    money(charged),
            paid:       money(paid),
            concession: money(concession),
            fine:       money(fine),
            balance:    money(balance),
            status:     balance > 0 ? 'due' : (charged > 0 ? 'clear' : 'not_assigned'),
            structure:  assignment?.feeStructure?.name || (assignment?.useCustom ? 'Custom' : ''),
        },
        monthly: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)).slice(-12)
            .map((m) => ({ ...m, paid: money(m.paid) })),
        payments: payments.map((p) => ({
            _id:      p._id,
            receipt:  p.receiptNumber || '',
            amount:   money(p.amount),
            mode:     p.paymentMode || '',
            status:   low(p.paymentStatus),
            date:     p.paymentDate,
            refunded: !!p.isRefunded,
        })),
        lastPaymentAt: confirmed.length ? confirmed[0].paymentDate : null,
        concessions: concessions.map((c) => ({
            name:  c.concession?.name || 'Concession',
            type:  c.concession?.concessionType || '',
            value: c.concession?.value ?? null,
            from:  c.validFrom, to: c.validTo,
        })),
        ledger: ledger.slice(-25).reverse().map((e) => ({
            date: e.createdAt, type: e.entryType, category: e.category,
            description: e.description, amount: money(e.amount),
            balance: money(e.runningBalance), period: e.periodLabel || '',
        })),
    };
}

async function libraryBlock(ctx) {
    const { user, schoolId } = ctx;
    const [issuances, fines, reservations] = await Promise.all([
        LibraryIssuance.find({ issuedTo: user._id, school: schoolId })
            .populate('book', 'title authors isbn')
            .sort({ issueDate: -1 }).lean(),
        LibraryFine.find({ user: user._id, school: schoolId }).lean(),
        LibraryReservation.find({ reservedBy: user._id, school: schoolId })
            .populate('book', 'title').lean(),
    ]);

    const now = new Date();
    const active  = issuances.filter((i) => ['issued', 'overdue'].includes(low(i.status)));
    const overdue = active.filter((i) => low(i.status) === 'overdue' || (i.dueDate && new Date(i.dueDate) < now));
    const returned = issuances.filter((i) => low(i.status) === 'returned');

    // Reading habit: how long books are kept vs. how long they were allowed.
    const returnedOnTime = returned.filter((i) => i.returnDate && i.dueDate && new Date(i.returnDate) <= new Date(i.dueDate)).length;

    return {
        summary: {
            totalIssued:   issuances.length,
            currentlyOut:  active.length,
            overdue:       overdue.length,
            returned:      returned.length,
            onTimeReturns: returnedOnTime,
            punctuality:   pct(returnedOnTime, returned.length),
            renewals:      sum(issuances, (i) => i.renewalCount || 0),
            fineTotal:     money(sum(fines, (f) => f.amount)),
            finePending:   money(sum(fines.filter((f) => low(f.status) === 'pending'), (f) => f.amount)),
            reservations:  reservations.filter((r) => ['pending', 'ready'].includes(low(r.status))).length,
        },
        current: active.map((i) => ({
            _id: i._id, title: i.book?.title || 'Book',
            author: Array.isArray(i.book?.authors) ? i.book.authors.join(', ') : (i.book?.authors || ''),
            issueDate: i.issueDate, dueDate: i.dueDate,
            daysOverdue: i.dueDate && new Date(i.dueDate) < now
                ? Math.floor((now - new Date(i.dueDate)) / 86400000) : 0,
            status: low(i.status),
        })),
        history: issuances.slice(0, 20).map((i) => ({
            _id: i._id, title: i.book?.title || 'Book',
            issueDate: i.issueDate, dueDate: i.dueDate, returnDate: i.returnDate,
            status: low(i.status), fine: money(i.fine || 0),
        })),
        fines: fines.map((f) => ({
            _id: f._id, type: f.fineType, amount: money(f.amount),
            daysOverdue: f.daysOverdue || 0, status: low(f.status), paidAt: f.paidAt,
        })),
    };
}

async function transportBlock(ctx) {
    const { user, schoolId } = ctx;
    const assignment = await TransportAssignment.findOne({ student: user._id, school: schoolId, status: 'active' })
        .populate('route', 'name routeCode stops')
        .populate('vehicle', 'vehicleNumber busName registrationNumber')
        .populate('feePlan', 'name amount frequency')
        .lean();

    if (!assignment) {
        const invoicesOnly = await TransportFeeInvoice.find({ student: user._id, school: schoolId }).lean();
        return {
            assigned: false,
            assignment: null,
            trips: { total: 0, boarded: 0, absent: 0, noShow: 0, percent: null, recent: [] },
            fees: invoiceSummary(invoicesOnly),
            complaints: [],
        };
    }

    const stopName = (stopId) => (assignment.route?.stops || [])
        .find((s) => String(s._id) === String(stopId))?.name || '';

    // Trip attendance lives inside each trip row; scope to this route and the
    // last 90 days so the scan stays small.
    const since = new Date(Date.now() - 90 * 86400000);
    const [trips, invoices, complaints] = await Promise.all([
        TransportTrip.find({ school: schoolId, route: sid(assignment.route), date: { $gte: since } })
            .sort({ date: -1 }).lean(),
        TransportFeeInvoice.find({ student: user._id, school: schoolId }).sort({ dueDate: -1 }).lean(),
        TransportComplaint.find({ student: user._id, school: schoolId }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);

    const myEvents = [];
    trips.forEach((t) => {
        const rec = (t.studentAttendance || []).find((a) => String(a.student) === String(user._id));
        if (!rec) return;
        myEvents.push({
            date: t.date, shift: t.shift, direction: t.direction,
            status: low(rec.status), method: rec.method || '',
            boardTime: rec.boardTime, dropTime: rec.dropTime,
            delayMinutes: t.delayMinutes || 0,
        });
    });
    const boarded = myEvents.filter((e) => e.status === 'boarded' || e.status === 'dropped').length;

    return {
        assigned: true,
        assignment: {
            route:      assignment.route?.name || '',
            routeCode:  assignment.route?.routeCode || '',
            vehicle:    assignment.vehicle?.vehicleNumber || assignment.vehicle?.registrationNumber || '',
            busName:    assignment.vehicle?.busName || '',
            pickupStop: stopName(assignment.pickupStop),
            dropStop:   stopName(assignment.dropStop),
            shift:      assignment.shift,
            seatNumber: assignment.seatNumber || '',
            feePlan:    assignment.feePlan?.name || '',
            since:      assignment.effectiveDate,
            temporary:  !!assignment.isTemporary,
        },
        trips: {
            total:   myEvents.length,
            boarded,
            absent:  myEvents.filter((e) => e.status === 'absent').length,
            noShow:  myEvents.filter((e) => e.status === 'no_show').length,
            percent: pct(boarded, myEvents.length),
            recent:  myEvents.slice(0, 15),
        },
        fees: invoiceSummary(invoices),
        complaints: complaints.map((c) => ({
            _id: c._id, code: c.complaintCode, subject: c.subject,
            category: c.category, priority: c.priority, status: low(c.status),
            raisedAt: c.createdAt, resolution: c.resolution || '',
        })),
    };
}

function invoiceSummary(invoices) {
    const billed = sum(invoices, (i) => i.netAmount || i.amount);
    const paid   = sum(invoices, (i) => i.paidAmount);
    return {
        invoices: invoices.length,
        billed:   money(billed),
        paid:     money(paid),
        due:      money(billed - paid),
        overdue:  invoices.filter((i) => low(i.status) === 'overdue').length,
        list: invoices.slice(0, 10).map((i) => ({
            _id: i._id, number: i.invoiceNumber, period: i.period?.label || '',
            amount: money(i.netAmount || i.amount), paid: money(i.paidAmount),
            dueDate: i.dueDate, status: low(i.status),
        })),
    };
}

async function videosBlock(ctx) {
    const { user, profile, schoolId } = ctx;
    const sectionId = sid(profile.currentSection);

    const [progress, assignments] = await Promise.all([
        VideoProgress.find({ student: user._id, school: schoolId })
            .populate('video', 'title durationSec thumbnailUrl')
            .sort({ lastWatchedAt: -1 }).lean(),
        VideoAssignment.find({
            school: schoolId, isDeleted: false,
            $or: [
                ...(sectionId ? [{ section: sectionId }] : []),
                { students: user._id },
            ],
        }).select('title status endDate mandatory minWatchPercent videos students recipientCount').lean(),
    ]);

    // Only assignments that actually reach this student (a section-wide row may
    // still carry an explicit recipient list).
    const mine = assignments.filter((a) => {
        const list = (a.students || []).map(String);
        return !list.length || list.includes(String(user._id));
    });

    const completed  = progress.filter((p) => p.completed);
    const watchedSec = sum(progress, (p) => p.watchedSeconds);

    return {
        summary: {
            assignments:      mine.length,
            activeAssignments: mine.filter((a) => low(a.status) === 'active').length,
            videosStarted:    progress.length,
            videosCompleted:  completed.length,
            completionRate:   pct(completed.length, progress.length),
            watchHours:       Math.round((watchedSec / 3600) * 10) / 10,
            avgProgress:      progress.length ? Math.round((sum(progress, (p) => p.progressPercent) / progress.length) * 10) / 10 : null,
            replays:          sum(progress, (p) => p.replayCount || 0),
            lastWatchedAt:    progress.length ? progress[0].lastWatchedAt : null,
        },
        recent: progress.slice(0, 15).map((p) => ({
            _id:        p._id,
            title:      p.video?.title || 'Video',
            progress:   p.progressPercent,
            completed:  p.completed,
            watchedMin: Math.round((p.watchedSeconds || 0) / 60),
            lastAt:     p.lastWatchedAt,
        })),
        assignments: mine.slice(0, 15).map((a) => ({
            _id: a._id, title: a.title, status: low(a.status),
            dueDate: a.endDate, mandatory: !!a.mandatory,
            videoCount: (a.videos || []).length,
        })),
    };
}

async function documentsBlock(ctx) {
    const { user, profile, schoolId } = ctx;
    const sectionId = sid(profile.currentSection);

    const targetFilter = {
        school: schoolId, isAssignment: true, isArchived: false,
        $or: [
            { targetType: 'whole_school' },
            ...(sectionId ? [{ targetSections: sectionId }] : []),
            { targetUsers: user._id },
        ],
    };
    const [assignments, submissions] = await Promise.all([
        Document.find(targetFilter).select('title dueDate totalMarks marksEnabled allowSubmission createdAt').sort({ createdAt: -1 }).lean(),
        AssignmentSubmission.find({ student: user._id, school: schoolId })
            .populate('document', 'title dueDate totalMarks').sort({ submittedAt: -1 }).lean(),
    ]);

    const submittedFor = new Set(submissions.map((s) => sid(s.document)));
    const graded = submissions.filter((s) => s.marks != null);
    const late   = submissions.filter((s) => low(s.status) === 'late').length;
    const pending = assignments.filter((a) => !submittedFor.has(String(a._id)));

    return {
        summary: {
            assigned:   assignments.length,
            submitted:  submissions.length,
            pending:    pending.length,
            late,
            reviewed:   submissions.filter((s) => s.reviewedAt).length,
            avgMarks:   graded.length ? Math.round((sum(graded, (s) => s.marks) / graded.length) * 10) / 10 : null,
            onTimeRate: pct(submissions.length - late, submissions.length),
        },
        pending: pending.slice(0, 10).map((a) => ({
            _id: a._id, title: a.title, dueDate: a.dueDate,
            overdue: !!(a.dueDate && new Date(a.dueDate) < new Date()),
        })),
        submissions: submissions.slice(0, 15).map((s) => ({
            _id: s._id, title: s.document?.title || 'Assignment',
            status: low(s.status), submittedAt: s.submittedAt,
            marks: s.marks ?? null, totalMarks: s.document?.totalMarks ?? null,
            feedback: s.feedback || '', reviewedAt: s.reviewedAt,
        })),
    };
}

async function timetableBlock(ctx) {
    const { profile } = ctx;
    const sectionId = sid(profile.currentSection);
    if (!sectionId) return { hasTimetable: false, periodsPerWeek: 0, subjects: [] };

    const timetable = await Timetable.findOne({ section: sectionId }).lean();
    if (!timetable) return { hasTimetable: false, periodsPerWeek: 0, subjects: [] };

    const entries = await TimetableEntry.find({ timetable: timetable._id })
        .populate('subject', 'subjectName')
        .populate('teacher', 'name').lean();

    const bySubject = {};
    entries.forEach((e) => {
        const name = e.subject?.subjectName;
        if (!name) return;
        bySubject[name] = bySubject[name] || { subject: name, periods: 0, teachers: [] };
        bySubject[name].periods += 1;
        const t = e.teacher?.name;
        if (t && !bySubject[name].teachers.includes(t)) bySubject[name].teachers.push(t);
    });

    return {
        hasTimetable:   true,
        periodsPerWeek: entries.length,
        subjects: Object.values(bySubject).sort((a, b) => b.periods - a.periods),
    };
}

async function inventoryBlock(ctx) {
    const { user, schoolId } = ctx;
    const issues = await InventoryIssue.find({ issuedToUser: user._id, school: schoolId })
        .populate('item', 'name itemCode unit').sort({ issueDate: -1 }).lean();
    return {
        summary: {
            issued:    issues.length,
            open:      issues.filter((i) => low(i.status) !== 'returned').length,
            returned:  issues.filter((i) => low(i.status) === 'returned').length,
            overdue:   issues.filter((i) => low(i.status) !== 'returned' && i.expectedReturn && new Date(i.expectedReturn) < new Date()).length,
        },
        items: issues.slice(0, 15).map((i) => ({
            _id: i._id, item: i.item?.name || i.issuedToName || 'Item',
            quantity: i.quantity, issueDate: i.issueDate,
            expectedReturn: i.expectedReturn, status: low(i.status),
        })),
    };
}

async function notificationsBlock(ctx) {
    const { user, schoolId } = ctx;
    const receipts = await NotificationReceipt.find({ recipient: user._id, school: schoolId })
        .select('isRead readAt createdAt').lean();
    const read = receipts.filter((r) => r.isRead).length;
    return {
        summary: {
            received: receipts.length,
            read,
            unread:   receipts.length - read,
            readRate: pct(read, receipts.length),
        },
    };
}

// ── GET /students/:studentId — the full dashboard for one student ────────────
exports.getStudentAnalytics = async (req, res) => {
    try {
        const studentId = req.params.studentId;
        const [scope, modules] = await Promise.all([resolveScope(req), getModules(req.schoolId)]);

        const [user, profile] = await Promise.all([
            User.findOne({ _id: studentId, school: req.schoolId, role: 'student' }).lean(),
            StudentProfile.findOne({ user: studentId, school: req.schoolId }).lean(),
        ]);
        if (!user || !profile) return err(res, 'Student not found', 404);

        // A teacher may only open a student sitting in one of their sections.
        if (!scope.canSeeAll) {
            const section = sid(profile.currentSection);
            if (!section || !scope.sectionIds.includes(section)) {
                return err(res, 'This student is not in one of your classes', 403);
            }
        }

        const ctx = { user, profile, schoolId: req.schoolId, activeYear: scope.activeYear };
        const viewer = scope.sections.find((s) => String(s._id) === sid(profile.currentSection));

        const blocks = { general: await generalBlock(ctx) };
        const jobs = [];
        const run = (key, fn) => jobs.push(fn(ctx).then((v) => { blocks[key] = v; }));

        if (modules.attendance)   run('attendance',    attendanceBlock);
        if (modules.result)       run('results',       resultsBlock);
        if (modules.aptitudeExam) run('aptitude',      aptitudeBlock);
        if (modules.fees)         run('fees',          feesBlock);
        if (modules.library)      run('library',       libraryBlock);
        if (modules.transport)    run('transport',     transportBlock);
        if (modules.videoLibrary) run('videos',        videosBlock);
        if (modules.document)     run('documents',     documentsBlock);
        if (modules.timetable)    run('timetable',     timetableBlock);
        if (modules.inventory)    run('inventory',     inventoryBlock);
        if (modules.notification) run('notifications', notificationsBlock);

        await Promise.all(jobs);

        ok(res, {
            modules,
            viewer: {
                role:     req.userRole,
                roles:    scope.canSeeAll ? ['School Admin'] : (viewer?.roles || []),
                subjects: viewer?.subjects || [],
            },
            academicYear: scope.activeYear
                ? { _id: scope.activeYear._id, yearName: scope.activeYear.yearName }
                : null,
            ...blocks,
        });
    } catch (e) { err(res, e); }
};
