'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Employee Directory — read model over the records the ERP already keeps.
//
//  Nothing here owns employee data. User + TeacherProfile remain the master;
//  assignments come from ClassSection / SectionSubjectTeacher; periods from the
//  Timetable module; attendance from TeacherAttendance; leave from the Leave
//  module; salary from EmployeeSalaryAssignment. The directory joins them and
//  applies one visibility policy (services/employeeDirectoryService.js).
//
//  Tenant isolation: every query below is filtered on req.schoolId, which comes
//  from the verified token — never from the request body or query string. The
//  by-id endpoints re-check `school` on the fetched row before answering, so a
//  guessed UUID from another school returns 404, not a record.
// ─────────────────────────────────────────────────────────────────────────────

const XLSX = require('xlsx');
const svc  = require('../services/employeeDirectoryService');
const ActivityLog = require('../models/ActivityLog');
const { RESPONSIBILITY_TYPES } = require('../models/EmployeeResponsibility');
const { VERIFICATION_SECTIONS, VERIFICATION_STATUSES } = require('../models/EmployeeVerification');
const { byClass, natural } = require('../utils/listOrder');

const {
    User, TeacherProfile, ClassSection, Class, Subject, SectionSubjectTeacher,
    AcademicYear, Timetable, TimetableEntry, Room, TeacherAttendance,
    LeaveApplication, LeaveBalance, LeaveType, EmployeeSalaryAssignment,
    EmployeeResponsibility, EmployeeVerification, EmployeeDepartment, SubstituteAssignment,
} = svc.models;

const { low, trim, pct } = svc;
const { getActiveAcademicYearLabel } = require('../utils/leaveDays');
const employeeDocs = require('../services/employeeDocuments');
const { notify } = require('../services/notifyService');
const { EmployeeDocumentReview } = employeeDocs.models;

const ok  = (res, data, status = 200) => res.status(status).json({ success: true, data });
// User-facing message only. The stack stays in the server log, never on the wire.
const fail = (res, e, status = 500) => {
    if (status >= 500) console.error('[employee-directory]', e);
    const message = typeof e === 'string' ? e : (status >= 500 ? 'Could not load the employee directory' : (e?.message || 'Request failed'));
    return res.status(status).json({ success: false, message });
};

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay   = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const isDate = (d) => d instanceof Date ? !Number.isNaN(d.getTime()) : !!d && !Number.isNaN(new Date(d).getTime());
const yearOf = (d) => (isDate(d) ? new Date(d).getFullYear() : null);
/** A date from a request, or `undefined` when it is not one (never an Invalid Date). */
const dateFrom = (v) => {
    if (v === null || v === '' || v === undefined) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
};

const RESPONSIBILITY_LABELS = {
    hod: 'HOD',
    academic_coordinator: 'Academic Coordinator',
    examination_coordinator: 'Examination Coordinator',
    house_coordinator: 'House Coordinator',
    club_coordinator: 'Club Coordinator',
    sports_coordinator: 'Sports Coordinator',
    discipline_coordinator: 'Discipline Coordinator',
    event_coordinator: 'Event Coordinator',
    other: 'Other',
};

// Which uploaded files back each verification section.
const DOCS_BY_SECTION = svc.DOCUMENT_DEFS.reduce((acc, d) => {
    (acc[d.verification] ||= []).push(d);
    return acc;
}, {});

const VERIFICATION_LABELS = {
    personal: 'Personal Information',
    contact: 'Contact Information',
    government_id: 'Government ID',
    education: 'Education',
    employment_documents: 'Employment Documents',
    bank: 'Bank Information',
};

// Where an employment stands — a fact about the job, not the account switch.
const STAGES = [
    { value: 'probation',  label: 'On probation' },
    { value: 'confirmed',  label: 'Confirmed' },
    { value: 'notice',     label: 'Serving notice' },
    { value: 'resigned',   label: 'Resigned' },
    { value: 'terminated', label: 'Terminated' },
    { value: 'retired',    label: 'Retired' },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.value, s.label]));
const EXITED = new Set(['resigned', 'terminated', 'retired']);
const STATUS_LABEL = { active: 'Active', on_leave: 'On leave', inactive: 'Inactive' };

const UNASSIGNED = 'Unassigned';

// ─────────────────────────────────────────────────────────────────────────────
//  Snapshot — one school-scoped read of everything the list view needs.
//
//  Search and filtering span User (name/email/phone), TeacherProfile
//  (employee id / designation / department) and the assignment tables
//  (subject / class / section), so no single indexed WHERE can answer them.
//  The set is bounded by one school's staff, so it is assembled once per
//  request and then filtered, sorted and PAGED IN THE SERVICE — the client
//  only ever receives one page.
//
//  `only`   one employee's page needs one employee: their row, their profile,
//           their manager — not every colleague's Aadhaar and bank columns.
//  `yearId` the assignments of another academic year (default: the active one).
// ─────────────────────────────────────────────────────────────────────────────
async function loadSnapshot(schoolId, { only = null, yearId = null } = {}) {
    const one = only ? String(only) : null;
    const [users, activeYear, admins, departments] = await Promise.all([
        User.find({ school: schoolId, role: 'teacher', ...(one ? { _id: one } : {}) })
            .select('name email phone profileImage profileIcon isActive lastSeenAt createdAt')
            .lean(),
        AcademicYear.findOne({ school: schoolId, status: 'active' }).lean(),
        // The school's administrators are not staff records, but they are who
        // the staff report to: they head the chart and can be picked as a manager.
        User.find({ school: schoolId, role: 'school_admin', isActive: true }).select('name profileImage').lean(),
        EmployeeDepartment.find({ school: schoolId }).lean(),
    ]);
    const userIds = users.map((u) => String(u._id));
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const adminById = new Map(admins.map((u) => [String(u._id), u]));

    const shownYear = yearId
        ? await AcademicYear.findOne({ _id: String(yearId), school: schoolId }).lean().catch(() => null)
        : activeYear;
    const yearFilter = shownYear ? { academicYear: shownYear._id } : {};
    const mine = one ? { employee: one } : {};
    const [profiles, sections, classes, subjects, responsibilities, verifications, reviews] = await Promise.all([
        TeacherProfile.find({ school: schoolId, ...(one ? { user: one } : {}) }).lean(),
        ClassSection.find({ school: schoolId, ...yearFilter }).lean(),
        Class.find({ school: schoolId, ...yearFilter }).lean(),
        // Scoped like the classes and sections above — subjects are per-year.
        Subject.find({ school: schoolId, ...yearFilter }).lean(),
        EmployeeResponsibility.find({ school: schoolId, isActive: true, ...mine }).lean(),
        EmployeeVerification.find({ school: schoolId, ...mine }).lean(),
        EmployeeDocumentReview.find({ school: schoolId, ...mine }).lean(),
    ]);

    const sectionById = new Map(sections.map((s) => [String(s._id), s]));
    const classById   = new Map(classes.map((c) => [String(c._id), c]));
    const subjectById = new Map(subjects.map((s) => [String(s._id), s]));

    // Subject teaching assignments, restricted to this school's sections.
    const sstRows = sections.length
        ? await SectionSubjectTeacher.find({
            section: { $in: sections.map((s) => String(s._id)) }, ...(one ? { teacher: one } : {}),
        }).lean()
        : [];

    // Leave covering today — the only status the ERP derives rather than stores.
    const today = new Date();
    const onLeaveRows = await LeaveApplication.find({
        school: schoolId,
        status: 'approved',
        fromDate: { $lte: endOfDay(today) },
        toDate:   { $gte: startOfDay(today) },
        ...(one ? { teacher: one } : {}),
    }).select('teacher').lean();
    const onLeaveToday = new Set(onLeaveRows.map((r) => String(r.teacher)));

    // Only profiles whose user still exists and belongs to this school.
    const profileByUser = new Map();
    for (const p of profiles) {
        const uid = String(p.user);
        if (userById.has(uid)) profileByUser.set(uid, p);
    }

    // One employee's page still names their manager: fetch that one person.
    const personById = new Map();
    if (one) {
        const managerId = profileByUser.get(one)?.reportingManager;
        if (managerId && !adminById.has(String(managerId))) {
            const [mu, mp] = await Promise.all([
                User.findOne({ _id: String(managerId), school: schoolId, role: 'teacher' }).select('name profileImage isActive').lean().catch(() => null),
                TeacherProfile.findOne({ user: String(managerId), school: schoolId }).select('user designation department employeeId').lean(),
            ]);
            if (mu) personById.set(String(managerId), { user: mu, profile: mp || {} });
        }
    }

    const assignmentsByTeacher = new Map();
    const push = (teacherId, entry) => {
        const k = String(teacherId);
        if (!userById.has(k)) return;
        if (!assignmentsByTeacher.has(k)) assignmentsByTeacher.set(k, []);
        assignmentsByTeacher.get(k).push(entry);
    };

    for (const row of sstRows) {
        const section = sectionById.get(String(row.section));
        if (!section) continue;
        const cls = classById.get(String(section.class));
        push(row.teacher, {
            role: 'subject_teacher',
            sectionId: String(section._id),
            sectionName: section.sectionName,
            classId: cls ? String(cls._id) : '',
            className: cls?.className || '',
            classNumber: cls?.classNumber ?? null,
            subjectId: String(row.subject),
            subjectName: subjectById.get(String(row.subject))?.subjectName || '',
        });
    }
    for (const section of sections) {
        const cls = classById.get(String(section.class));
        const base = {
            sectionId: String(section._id),
            sectionName: section.sectionName,
            classId: cls ? String(cls._id) : '',
            className: cls?.className || '',
            classNumber: cls?.classNumber ?? null,
            subjectId: '',
            subjectName: '',
        };
        if (section.classTeacher)       push(section.classTeacher,       { ...base, role: 'class_teacher' });
        if (section.substituteTeacher)  push(section.substituteTeacher,  { ...base, role: 'vice_class_teacher' });
    }

    // A responsibility with an end date behind it is no longer held; one whose
    // start date is still ahead is not held yet. Neither is "current".
    const dayStart = startOfDay(today);
    const dayEnd   = endOfDay(today);
    const responsibilitiesByTeacher = new Map();
    for (const r of responsibilities) {
        const k = String(r.employee);
        if (!userById.has(k)) continue;
        if (isDate(r.toDate) && new Date(r.toDate) < dayStart) continue;
        if (isDate(r.fromDate) && new Date(r.fromDate) > dayEnd) continue;
        if (!responsibilitiesByTeacher.has(k)) responsibilitiesByTeacher.set(k, []);
        const cls = r.class ? classById.get(String(r.class)) : null;
        const sec = r.section ? sectionById.get(String(r.section)) : null;
        responsibilitiesByTeacher.get(k).push({
            _id: String(r._id),
            type: r.type,
            title: r.title || '',
            label: trim(r.title) || RESPONSIBILITY_LABELS[r.type] || r.type,
            department: r.department || '',
            classId: r.class ? String(r.class) : '',
            sectionId: r.section ? String(r.section) : '',
            subjectId: r.subject ? String(r.subject) : '',
            className: cls?.className || '',
            sectionName: sec?.sectionName || '',
            subjectName: r.subject ? (subjectById.get(String(r.subject))?.subjectName || '') : '',
            fromDate: r.fromDate || null,
            toDate: r.toDate || null,
            notes: r.notes || '',
        });
    }

    const verificationByTeacher = new Map();
    for (const v of verifications) {
        const k = String(v.employee);
        if (!userById.has(k)) continue;
        if (!verificationByTeacher.has(k)) verificationByTeacher.set(k, {});
        verificationByTeacher.get(k)[v.section] = v;
    }

    // Each person's documents, worked out once from what was just read.
    const docsByTeacher = await employeeDocs.documentsBySchool(
        schoolId,
        userIds.map((uid) => profileByUser.get(uid) || { user: uid }),
        undefined,
        { reviews, sections: verifications },
    );

    // One spelling per department, whatever was typed: the listed department's
    // own, else the first one met. "Science" and "science" are one department.
    const deptSpelling = new Map(departments.map((d) => [low(d.name), d.name]));
    for (const p of profileByUser.values()) {
        const k = low(p.department);
        if (k && !deptSpelling.has(k)) deptSpelling.set(k, trim(p.department));
    }
    const desigSpelling = new Map();
    for (const p of profileByUser.values()) {
        const k = low(p.designation);
        if (k && !desigSpelling.has(k)) desigSpelling.set(k, trim(p.designation));
    }

    // "This year" starts when the working year does; with no year set up it is
    // the last twelve months, so the figure still means something.
    const yearStart = isDate(activeYear?.startDate) ? new Date(activeYear.startDate)
        : new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());

    return {
        activeYear, shownYear, yearStart, users, userIds, userById, adminById, personById, profileByUser,
        sections, classes, subjects, sectionById, classById, subjectById,
        assignmentsByTeacher, responsibilitiesByTeacher, verificationByTeacher, docsByTeacher,
        departments, deptSpelling, desigSpelling,
        onLeaveToday,
    };
}

// ── Row assembly ─────────────────────────────────────────────────────────────

/** Teaching vs non-teaching: explicit when stated, otherwise derived. */
function staffTypeOf(profile, assignments) {
    if (profile?.staffType === 'teaching' || profile?.staffType === 'non_teaching') {
        return { staffType: profile.staffType, staffTypeSource: 'set' };
    }
    const teaches = (assignments || []).length > 0 || (profile?.subjects || []).length > 0;
    return { staffType: teaches ? 'teaching' : 'non_teaching', staffTypeSource: 'derived' };
}

/**
 * Employment status. User.isActive is the ERP's employee status and stays the
 * source of truth — "on leave" is derived from an approved leave covering
 * today, never stored, so the two can never drift apart.
 */
function statusOf(user, onLeaveToday) {
    if (!user.isActive) return 'inactive';
    if (onLeaveToday.has(String(user._id))) return 'on_leave';
    return 'active';
}

/** A user id → the minimal person card the directory shows anywhere. */
function resolvePerson(snap, userId) {
    if (!userId) return null;
    const key = String(userId);
    const admin = snap.adminById.get(key);
    if (admin) {
        return {
            _id: key, name: admin.name, designation: 'School Administrator', department: '',
            employeeId: '', profileImage: admin.profileImage || '', isSchoolAdmin: true, inactive: false,
        };
    }
    const loose = snap.personById.get(key);
    const u = snap.userById.get(key) || loose?.user;
    if (!u) return null;
    const p = snap.profileByUser.get(key) || loose?.profile || {};
    return {
        _id: key,
        name: u.name,
        designation: p.designation || '',
        department: p.department || '',
        employeeId: p.employeeId || '',
        profileImage: u.profileImage || '',
        // Somebody still shown as reporting to a deactivated account needs a
        // new manager; every screen that names the manager can say so.
        inactive: u.isActive === false,
    };
}

function buildRow(user, snap) {
    const uid = String(user._id);
    const p   = snap.profileByUser.get(uid) || {};
    const assignments = snap.assignmentsByTeacher.get(uid) || [];
    const { staffType, staffTypeSource } = staffTypeOf(p, assignments);

    const subjectNames = [...new Set(assignments.map((a) => a.subjectName).filter(Boolean))];
    const classKeys = new Map();
    for (const a of assignments) {
        if (!a.sectionId) continue;
        classKeys.set(a.sectionId, {
            sectionId: a.sectionId,
            classId: a.classId,
            label: `${a.className || 'Class'} ${a.sectionName || ''}`.trim(),
            classNumber: a.classNumber,
        });
    }
    const classTeacherOf = assignments
        .filter((a) => a.role === 'class_teacher')
        .map((a) => `${a.className || 'Class'} ${a.sectionName || ''}`.trim());

    const docs = snap.docsByTeacher.get(uid) || { documents: [], outstanding: [] };
    const rejected = new Set(docs.documents.filter((d) => d.state === 'rejected').map((d) => d.key));
    const completion = svc.computeCompletion(user, p, rejected);
    const verification = snap.verificationByTeacher.get(uid) || {};
    const pendingVerification = VERIFICATION_SECTIONS.some((s) => (verification[s]?.status || 'pending') !== 'verified');
    const department  = snap.deptSpelling.get(low(p.department)) || '';
    const designation = snap.desigSpelling.get(low(p.designation)) || '';
    const joined = isDate(p.joiningDate) ? new Date(p.joiningDate) : null;

    return {
        _id: uid,
        name: user.name,
        profileImage: user.profileImage || '',
        profileIcon: user.profileIcon || '',
        employeeId: p.employeeId || '',
        designation,
        department,
        staffType, staffTypeSource,
        employmentStatus: statusOf(user, snap.onLeaveToday),
        employmentStage: p.employmentStage || '',
        exitDate: p.exitDate || null,
        isActive: !!user.isActive,
        joiningDate: p.joiningDate || null,
        joiningYear: yearOf(p.joiningDate),
        // Joined since the working year began, and not a date still to come:
        // the ONE meaning of "new joiner" — the overview's and the Reports
        // page's figure, the ?joined=year filter and the New Joiners report.
        joinedThisYear: !!(joined && joined >= snap.yearStart && joined <= endOfDay(new Date())),
        officialEmail: user.email,
        officialPhone: user.phone || '',
        employmentType: p.employmentType || '',
        subjects: subjectNames,
        classes: [...classKeys.values()].sort((a, b) => byClass(a, b) || natural(a.label, b.label)),
        classTeacherOf,
        isClassTeacher: classTeacherOf.length > 0,
        responsibilities: snap.responsibilitiesByTeacher.get(uid) || [],
        // Who someone reports to is org-chart information, so it is resolved to
        // a name for every tier rather than left as an id only admins can look up.
        reportingManagerId: p.reportingManager ? String(p.reportingManager) : '',
        reportingManager: resolvePerson(snap, p.reportingManager),
        profileCompletion: completion.percent,
        missingCount: completion.missing.length,
        // What the person still owes the office — a required document missing,
        // or any document rejected. The same rule as the reminder desk, so the
        // overview, the report and that desk count the same people.
        missingDocumentCount: docs.outstanding.length,
        owedMissing: docs.outstanding.filter((o) => o.reason === 'missing').map((o) => o.label),
        owedRejected: docs.outstanding.filter((o) => o.reason === 'rejected').map((o) => o.label),
        documentsAwaitingReview: docs.documents.filter((d) => d.state === 'pending' || d.state === 'resubmitted').length,
        pendingVerification,
        lastSeenAt: user.lastSeenAt || null,
        // Kept off the wire, used by search / filters / reports only.
        _search: [
            user.name, user.email, user.phone, p.employeeId, p.designation, p.department,
            ...subjectNames, ...[...classKeys.values()].map((c) => c.label),
        ].map(low).join(' '),
        _assignments: assignments,
        _dob: p.dob || null,
        _gender: p.gender || '',
        _qualification: trim(p.qualification),
        _exitReason: p.exitReason || '',
    };
}

/**
 * Strip a row down to the tier the viewer is entitled to.
 *
 * A teacher with normal access is looking colleagues up, not administering
 * them, so the row is cut to what that actually needs: who they are, what they
 * teach, and how to reach them. Employment facts — joining date, account
 * status, profile completeness, verification state — are dropped from the
 * object, not flagged, so they are never serialised at all.
 */
function projectRow(row, viewer) {
    const vis = svc.visibilityFor(viewer, row._id);
    // eslint-disable-next-line no-unused-vars
    const { _search, _assignments, _dob, _gender, _qualification, _exitReason, ...rest } = row;
    if (vis.personal) return { ...rest, canViewProfile: true };
    return {
        _id: rest._id,
        name: rest.name,
        profileImage: rest.profileImage,
        profileIcon: rest.profileIcon,
        employeeId: rest.employeeId,
        designation: rest.designation,
        department: rest.department,
        // Teaching or not is plain from what somebody teaches; the list's own
        // Teaching / Non-Teaching tiles filter on it for every reader.
        staffType: rest.staffType,
        officialEmail: rest.officialEmail,
        officialPhone: rest.officialPhone,
        subjects: rest.subjects,
        classes: rest.classes,
        classTeacherOf: rest.classTeacherOf,
        isClassTeacher: rest.isClassTeacher,
        // eslint-disable-next-line no-unused-vars
        responsibilities: rest.responsibilities.map(({ notes, ...r }) => r),
        reportingManager: rest.reportingManager,
        canViewProfile: true,
    };
}

// ── Search / filter / sort ───────────────────────────────────────────────────

function matches(row, q) {
    const search = low(q.search);
    if (search) {
        // Every term must appear somewhere in the row — partial, case-insensitive.
        const terms = search.split(/\s+/).filter(Boolean);
        if (!terms.every((t) => row._search.includes(t))) return false;
    }
    // "Unassigned" is the bucket getDepartments() emits for a row with no
    // department, so filtering by it here means the same thing it means there:
    // the people who have not been placed. Without this the Departments screen
    // could count them but never show them, and an empty ?department= is
    // indistinguishable from "no filter".
    if (q.department) {
        const wanted = low(q.department);
        const held   = low(row.department);
        if (wanted === 'unassigned' ? !!held : held !== wanted) return false;
    }
    // Same rule as the department above: the "Unassigned" bucket the roll-ups
    // emit is a real filter value here, meaning nobody set one.
    if (q.designation) {
        const wanted = low(q.designation);
        const held   = low(row.designation);
        if (wanted === 'unassigned' ? !!held : held !== wanted) return false;
    }
    if (q.staffType    && row.staffType         !== q.staffType)         return false;
    if (q.employmentType && row.employmentType  !== q.employmentType)    return false;
    if (q.status       && row.employmentStatus  !== q.status)            return false;
    if (q.stage && (q.stage === 'none' ? !!row.employmentStage : row.employmentStage !== q.stage)) return false;
    // Account state, which is NOT the `status` above: a teacher on approved
    // leave today reads as 'on_leave' there while their account is perfectly
    // active. 'all' (or omitting it) keeps everyone.
    if (q.accountStatus === 'active'   && row.isActive === false) return false;
    if (q.accountStatus === 'inactive' && row.isActive !== false) return false;
    if (q.joiningYear  && String(row.joiningYear || '') !== String(q.joiningYear)) return false;
    if (q.joined === 'year' && !row.joinedThisYear) return false;
    if (q.reportingManager && row.reportingManagerId !== String(q.reportingManager)) return false;
    if (q.subject) {
        const want = low(q.subject);
        if (!row._assignments.some((a) => low(a.subjectId) === want || low(a.subjectName) === want)) return false;
    }
    if (q.classId  && !row._assignments.some((a) => a.classId === String(q.classId)))   return false;
    if (q.sectionId && !row._assignments.some((a) => a.sectionId === String(q.sectionId))) return false;
    if (q.verification === 'pending'  && !row.pendingVerification) return false;
    if (q.verification === 'verified' &&  row.pendingVerification) return false;
    if (q.completion === 'incomplete' && row.profileCompletion >= 100) return false;
    if (q.completion === 'complete'   && row.profileCompletion < 100)  return false;
    // Owing the office a document: `missing` = a required one never uploaded.
    if (q.owed === 'any'     && !row.missingDocumentCount) return false;
    if (q.owed === 'missing' && !row.owedMissing.length)   return false;
    return true;
}

// What a colleague lookup may filter and sort on. Everything else keys on a
// field that reader is never sent — and a filter on a hidden field tells them
// its value just the same ("who is in the list when I ask for unverified?").
const OPEN_FILTERS = ['search', 'department', 'designation', 'staffType', 'subject', 'classId', 'sectionId'];
const OPEN_SORTS   = ['name', 'employeeId', 'designation', 'department'];

/** The query as this viewer may ask it. */
function queryFor(viewer, raw = {}) {
    if (viewer.isAdmin) return raw;
    const q = {};
    for (const k of OPEN_FILTERS) if (raw[k]) q[k] = raw[k];
    // Deactivated accounts are an administrative matter.
    q.accountStatus = 'active';
    if (OPEN_SORTS.includes(String(raw.sortBy))) q.sortBy = raw.sortBy;
    if (raw.sortDir) q.sortDir = raw.sortDir;
    return q;
}

const SORTERS = {
    name:        (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
    employeeId:  (a, b) => String(a.employeeId || '').localeCompare(String(b.employeeId || ''), undefined, { numeric: true }),
    joiningDate: (a, b) => new Date(a.joiningDate || 0) - new Date(b.joiningDate || 0),
    designation: (a, b) => String(a.designation || '').localeCompare(String(b.designation || '')),
    department:  (a, b) => String(a.department || '').localeCompare(String(b.department || '')),
    status:      (a, b) => String(a.employmentStatus).localeCompare(String(b.employmentStatus)),
    completion:  (a, b) => a.profileCompletion - b.profileCompletion,
};

function sortRows(rows, sortBy = 'name', sortDir = 'asc') {
    const cmp = SORTERS[sortBy] || SORTERS.name;
    const out = [...rows].sort((a, b) => cmp(a, b) || SORTERS.name(a, b));
    return sortDir === 'desc' ? out.reverse() : out;
}

async function collect(req) {
    const viewer = await svc.resolveViewer(req);
    const snap   = await loadSnapshot(req.schoolId);
    const rows   = snap.users.map((u) => buildRow(u, snap));
    return { viewer, snap, rows };
}

/** Count rows into named buckets, "Science" and "science" as one. */
function bucket(rows, get) {
    const m = new Map();
    for (const r of rows) {
        const name = trim(get(r)) || UNASSIGNED;
        const k = low(name);
        if (!m.has(k)) m.set(k, { label: name, rows: [] });
        m.get(k).rows.push(r);
    }
    return [...m.values()];
}

/** Whose day (month + day) falls within the next `days` — birthdays, joining anniversaries. */
function upcoming(rows, get, days = 30) {
    const today = startOfDay(new Date());
    const out = [];
    for (const r of rows) {
        const d = get(r);
        if (!isDate(d)) continue;
        const on = new Date(d);
        let next = new Date(today.getFullYear(), on.getMonth(), on.getDate());
        if (next < today) next = new Date(today.getFullYear() + 1, on.getMonth(), on.getDate());
        const inDays = Math.round((next - today) / 86400000);
        if (inDays > days) continue;
        out.push({
            _id: r._id, name: r.name, profileImage: r.profileImage, designation: r.designation,
            date: next, inDays, years: next.getFullYear() - on.getFullYear(),
        });
    }
    return out.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /meta — filter options plus what this caller may do.
// ─────────────────────────────────────────────────────────────────────────────
exports.getMeta = async (req, res) => {
    try {
        const { viewer, snap, rows: all } = await collect(req);
        const uniq = (vals) => [...new Set(vals.map(trim).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        // Administrative filters key on fields a normal directory user never
        // receives, so they are not offered to one — and that reader's options
        // are drawn from the staff they can actually list.
        const admin = viewer.isAdmin;
        const rows = admin ? all : all.filter((r) => r.isActive);
        const years = admin
            ? await AcademicYear.find({ school: req.schoolId }).select('yearName status startDate').lean()
            : [];

        ok(res, {
            viewer: {
                level: viewer.level,
                isAdmin: viewer.isAdmin,
                canViewPayroll: viewer.payrollAdmin,
                canReveal: viewer.isAdmin,
                // Adding, editing and deactivating an employee are the school
                // administrator's own screens (Admin → Teachers, Designations);
                // a teacher who administers the directory is not let into them.
                canManageAccounts: viewer.role === 'school_admin',
                designation: viewer.designation,
                userId: viewer.userId,
            },
            modules: viewer.modules,
            academicYear: snap.activeYear ? { _id: String(snap.activeYear._id), yearName: snap.activeYear.yearName } : null,
            academicYears: years
                .sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0))
                .map((y) => ({ _id: String(y._id), yearName: y.yearName, active: y.status === 'active' })),
            filters: {
                // The unplaced are offered as a filter only when there are
                // some, and always last — it is a gap, not a department.
                departments: [
                    ...uniq([...rows.map((r) => r.department), ...(admin ? snap.departments.map((d) => d.name) : [])]),
                    ...(rows.some((r) => !trim(r.department)) ? [UNASSIGNED] : []),
                ],
                designations: [
                    ...uniq(rows.map((r) => r.designation)),
                    ...(rows.some((r) => !trim(r.designation)) ? [UNASSIGNED] : []),
                ],
                joiningYears: admin
                    ? [...new Set(rows.map((r) => r.joiningYear).filter(Boolean))].sort((a, b) => b - a)
                    : [],
                staffTypes: [{ value: 'teaching', label: 'Teaching' }, { value: 'non_teaching', label: 'Non-Teaching' }],
                employmentTypes: admin
                    ? [{ value: 'fresher', label: 'Fresher' }, { value: 'experienced', label: 'Experienced' }]
                    : [],
                statuses: admin ? [
                    { value: 'active', label: 'Active' },
                    { value: 'on_leave', label: 'On Leave' },
                    { value: 'inactive', label: 'Inactive' },
                ] : [],
                stages: admin ? STAGES : [],
                classes: snap.classes
                    .map((c) => ({ _id: String(c._id), label: c.className, classNumber: c.classNumber }))
                    .sort((a, b) => byClass(a, b) || natural(a.label, b.label)),
                sections: snap.sections.map((s) => {
                    const cls = snap.classById.get(String(s.class));
                    return {
                        _id: String(s._id),
                        classId: String(s.class),
                        classNumber: cls?.classNumber ?? null,
                        sectionName: s.sectionName,
                        label: `${cls?.className || 'Class'} ${s.sectionName}`.trim(),
                    };
                }).sort((a, b) => byClass(a, b) || natural(a.sectionName, b.sectionName)),
                subjects: snap.subjects
                    .map((s) => ({ _id: String(s._id), label: s.subjectName }))
                    .sort((a, b) => a.label.localeCompare(b.label)),
                // Who can be reported to: the school's administrators first,
                // then every employee whose account is live. Nobody is given a
                // deactivated manager.
                managers: admin
                    ? [
                        ...[...snap.adminById.values()].map((u) => ({ _id: String(u._id), label: u.name, designation: 'School Administrator' })),
                        ...all.filter((r) => r.isActive).map((r) => ({ _id: r._id, label: r.name, designation: r.designation })),
                    ].sort((a, b) => a.label.localeCompare(b.label))
                    : [],
                responsibilityTypes: RESPONSIBILITY_TYPES.map((t) => ({ value: t, label: RESPONSIBILITY_LABELS[t] })),
                verificationSections: VERIFICATION_SECTIONS.map((s) => ({ value: s, label: VERIFICATION_LABELS[s] })),
            },
            // Campus / branch is not modelled in this ERP — a School row is
            // itself the tenant — so the filter is reported as unavailable
            // rather than faked.
            unsupported: ['campus'],
        });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /dashboard — headline counts over the caller's school. Administrative:
//  the counts summarise records a normal directory user cannot open.
// ─────────────────────────────────────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
    try {
        const { snap, rows } = await collect(req);
        // The office chases the people who work here: a deactivated account's
        // unfinished profile, unsigned sections and missing papers are nobody's
        // to-do. Headcounts above them still cover everyone on the books.
        const live = rows.filter((r) => r.isActive);

        const byKey = (get) => bucket(rows, get)
            .map((b) => ({ label: b.label, count: b.rows.length }))
            .sort((a, b) => b.count - a.count);

        // Anyone who joined on or after the active year began. The overview
        // reports the school's own year rather than a rolling three months —
        // "new this year" is the number an admin is actually asked for.
        const joinedThisYear = rows.filter((r) => r.joinedThisYear);
        // Headcount before this year began, and the growth since. Derived from
        // joining dates only, so it counts arrivals and cannot see departures —
        // the client says "new this year", never "turnover".
        const carriedOver = rows.length - joinedThisYear.length;
        const growthPct = carriedOver > 0
            ? Math.round((joinedThisYear.length / carriedOver) * 1000) / 10
            : null;

        // Three buckets rather than one average: an average of 24% hides whether
        // that is everyone half-done or most people not started.
        const complete   = live.filter((r) => r.profileCompletion >= 100).length;
        const notStarted = live.filter((r) => r.profileCompletion < 25).length;

        ok(res, {
            totals: {
                employees: rows.length,
                active:    rows.filter((r) => r.employmentStatus === 'active').length,
                // Accounts that are switched on — active plus on leave today.
                liveAccounts: live.length,
                inactive:  rows.filter((r) => !r.isActive).length,
                onLeave:   rows.filter((r) => r.employmentStatus === 'on_leave').length,
                teaching:     rows.filter((r) => r.staffType === 'teaching').length,
                nonTeaching:  rows.filter((r) => r.staffType === 'non_teaching').length,
                incompleteProfiles:  live.filter((r) => r.profileCompletion < 100).length,
                pendingVerification: live.filter((r) => r.pendingVerification).length,
                documentsNeedAttention: live.filter((r) => r.missingDocumentCount > 0).length,
                documentsAwaitingReview: live.reduce((n, r) => n + r.documentsAwaitingReview, 0),
                classTeachers: rows.filter((r) => r.isClassTeacher).length,
                newThisYear: joinedThisYear.length,
            },
            growthPct,
            completionBuckets: {
                complete,
                notStarted,
                inProgress: live.length - complete - notStarted,
            },
            // The newest arrivals, newest first. Someone with no joining date on
            // file has nothing to be recent by, so they are left out rather than
            // sorted to one end of a list titled "recently joined".
            recentEmployees: rows
                .filter((r) => isDate(r.joiningDate) && new Date(r.joiningDate) <= endOfDay(new Date()))
                .sort((a, b) => new Date(b.joiningDate) - new Date(a.joiningDate))
                .slice(0, 5)
                .map((r) => ({
                    _id: r._id,
                    name: r.name,
                    profileImage: r.profileImage,
                    designation: r.designation,
                    department: r.department,
                    joiningDate: r.joiningDate,
                    employmentStatus: r.employmentStatus,
                })),
            byDepartment:  byKey((r) => r.department),
            byDesignation: byKey((r) => r.designation),
            averageCompletion: live.length
                ? Math.round((live.reduce((s, r) => s + r.profileCompletion, 0) / live.length) * 10) / 10
                : 0,
            lowestCompletion: [...live]
                .sort((a, b) => a.profileCompletion - b.profileCompletion)
                .slice(0, 5)
                .map((r) => ({ _id: r._id, name: r.name, employeeId: r.employeeId, percent: r.profileCompletion })),
            // The next thirty days, for the people who work here now.
            birthdays:     upcoming(live, (r) => r._dob).slice(0, 8),
            anniversaries: upcoming(live, (r) => r.joiningDate).filter((x) => x.years > 0).slice(0, 8),
            academicYear: snap.activeYear?.yearName || '',
            academicYearStart: snap.activeYear?.startDate || null,
        });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /employees — the paged directory.
// ─────────────────────────────────────────────────────────────────────────────
// Headcounts for the tiles above the list.
//
// Counted over every row the caller may see, NOT the filtered page: the tiles
// describe the school, and a summary that moved every time a filter changed
// would be answering a different question each time it was read. Active and
// inactive are the ACCOUNT state here, so the two sum to the total and each
// tile maps onto the accountStatus filter it sets.
function headcounts(rows) {
    // The row's own flag (buildRow) — one rule for this, the overview and ?joined=year.
    const newThisYear = rows.filter((r) => r.joinedThisYear).length;
    const carriedOver = rows.length - newThisYear;
    return {
        employees:   rows.length,
        active:      rows.filter((r) => r.isActive !== false).length,
        inactive:    rows.filter((r) => r.isActive === false).length,
        teaching:    rows.filter((r) => r.staffType === 'teaching').length,
        nonTeaching: rows.filter((r) => r.staffType === 'non_teaching').length,
        onLeave:     rows.filter((r) => r.employmentStatus === 'on_leave').length,
        newThisYear,
        // Arrivals only — joining dates cannot show who left, so the client
        // says "joined this year" rather than implying net turnover.
        growthPct: carriedOver > 0 ? Math.round((newThisYear / carriedOver) * 1000) / 10 : null,
    };
}

exports.getEmployees = async (req, res) => {
    try {
        const { viewer, rows: all } = await collect(req);
        // A colleague lookup lists the staff who work here, and may filter and
        // sort only on what it is shown (queryFor).
        const rows  = viewer.isAdmin ? all : all.filter((r) => r.isActive);
        const query = queryFor(viewer, req.query);
        // The UI offers 10 / 25 / 50 / 100. Anything else is clamped rather than
        // rejected, so a caller can never talk the server into returning the
        // whole staff table in one response.
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

        const filtered = rows.filter((r) => matches(r, query));
        const sorted   = sortRows(filtered, query.sortBy, query.sortDir);
        const pages    = Math.max(1, Math.ceil(filtered.length / limit));
        // A page past the end (the list shrank since it was asked for) is the
        // last page, not an empty one that reads as "nobody matches".
        const page     = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
        const pageRows = sorted.slice((page - 1) * limit, page * limit);

        const counts = headcounts(rows);
        ok(res, {
            employees: pageRows.map((r) => projectRow(r, viewer)),
            total: filtered.length,
            page, limit, pages,
            grandTotal: rows.length,
            stats: viewer.isAdmin ? counts
                : { employees: counts.employees, teaching: counts.teaching, nonTeaching: counts.nonTeaching },
            viewer: {
                level: viewer.level, isAdmin: viewer.isAdmin, userId: viewer.userId,
                canManageAccounts: viewer.role === 'school_admin',
            },
        });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Employee lookup — the single place a :id is turned into a record.
//  Returns null for an id that is not a teacher of the caller's school, which
//  every caller below turns into a 404. This is the IDOR guard.
//
//  Pass `viewer` on the endpoints a normal directory user reaches: a
//  deactivated account is not theirs to open (it is not in their list either).
// ─────────────────────────────────────────────────────────────────────────────
async function findEmployee(req, viewer = null) {
    const id = String(req.params.id || '');
    if (!id) return null;
    const user = await User.findOne({ _id: id, school: req.schoolId, role: 'teacher' })
        .select('name email phone profileImage profileIcon isActive lastSeenAt createdAt')
        .lean()
        .catch(() => null);
    if (!user) return null;
    if (viewer && !viewer.isAdmin && !user.isActive && String(user._id) !== viewer.userId) return null;
    const profile = await TeacherProfile.findOne({ user: id, school: req.schoolId }).lean();
    return { user, profile: profile || null };
}

/** Names for a set of user ids, as a Map. */
async function namesOf(ids) {
    const list = [...new Set([...ids].filter(Boolean).map(String))];
    if (!list.length) return new Map();
    const users = await User.find({ _id: { $in: list } }).select('name').lean();
    return new Map(users.map((u) => [String(u._id), u.name]));
}

const ROLE_LABEL = { class_teacher: 'Class Teacher', vice_class_teacher: 'Vice Class Teacher', subject_teacher: 'Subject Teacher' };
const assignmentView = (a) => ({
    role: a.role,
    roleLabel: ROLE_LABEL[a.role] || 'Subject Teacher',
    subject: a.subjectName,
    className: a.className,
    sectionName: a.sectionName,
    sectionId: a.sectionId,
    classId: a.classId,
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /employees/:id — the full profile, cut to the viewer's tier.
// ─────────────────────────────────────────────────────────────────────────────
exports.getEmployee = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        const found  = await findEmployee(req, viewer);
        if (!found) return fail(res, 'Employee not found', 404);

        const { user, profile } = found;
        const p   = profile || {};
        const uid = String(user._id);
        const vis = svc.visibilityFor(viewer, user._id);
        // One person's page reads one person — not every colleague's record.
        const snap = await loadSnapshot(req.schoolId, { only: uid });
        const row  = buildRow(user, snap);

        const verificationBySection = { ...(snap.verificationByTeacher.get(uid) || {}) };
        const reviews = vis.documents
            ? await EmployeeDocumentReview.find({ school: req.schoolId, employee: uid }).select('reviewedBy').lean()
            : [];
        const names = await namesOf([
            ...Object.values(verificationBySection).map((v) => v.verifiedBy),
            ...reviews.map((r) => r.reviewedBy),
        ]);
        for (const s of Object.keys(verificationBySection)) {
            verificationBySection[s] = { ...verificationBySection[s], verifiedByName: names.get(String(verificationBySection[s].verifiedBy)) || '' };
        }

        const manager = row.reportingManager;

        const out = {
            viewer: {
                level: viewer.level,
                isAdmin: viewer.isAdmin,
                isSelf: vis.self,
                canViewPayroll: viewer.payrollAdmin,
                canReveal: vis.canReveal,
                canRevealBank: vis.canReveal && vis.bank,
                // The account itself — the wizard, deactivation — is the school
                // administrator's (Admin → Teachers); see getMeta.
                canManageAccounts: viewer.role === 'school_admin',
            },
            visibility: {
                personal: vis.personal, contact: vis.contactFull, employment: vis.employmentFull,
                education: vis.educationDocs, attendance: vis.attendance, leave: vis.leave,
                documents: vis.documents, governmentId: vis.governmentId, bank: vis.bank,
                payroll: vis.payroll, completion: vis.completion, verification: vis.verification,
            },
            modules: viewer.modules,

            // ── Overview — professional information, everyone in the directory
            overview: {
                _id: uid,
                name: user.name,
                profileImage: user.profileImage || '',
                profileIcon: user.profileIcon || '',
                employeeId: p.employeeId || '',
                teacherId: p.employeeId || '',
                designation: row.designation,
                department: row.department,
                staffType: row.staffType,
                joiningDate: p.joiningDate || null,
                officialEmail: user.email,
                officialPhone: user.phone || '',
                subjects: row.subjects,
                classes: row.classes,
                classTeacherOf: row.classTeacherOf,
                reportingManager: manager,
                workplace: {
                    name: req.user?.school?.name || '',
                    city: req.user?.school?.city || '',
                    state: req.user?.school?.state || '',
                },
                // Account state and last sign-in: the office's, and the person's own.
                ...(vis.status ? {
                    staffTypeSource: row.staffTypeSource,
                    employmentStatus: row.employmentStatus,
                    employmentStage: row.employmentStage,
                    isActive: !!user.isActive,
                    lastSeenAt: user.lastSeenAt || null,
                } : {}),
            },
            subjectsClasses: {
                academicYear: snap.activeYear?.yearName || '',
                academicYearId: snap.activeYear ? String(snap.activeYear._id) : '',
                assignments: row._assignments.map(assignmentView),
            },
            // eslint-disable-next-line no-unused-vars
            responsibilities: vis.status ? row.responsibilities : row.responsibilities.map(({ notes, ...r }) => r),
        };

        // Who signed what off is the office's working state — not a colleague's to read.
        if (vis.verification) {
            out.verification = VERIFICATION_SECTIONS.map((s) => {
                const v = verificationBySection[s];
                return {
                    section: s,
                    label: VERIFICATION_LABELS[s],
                    status: v?.status || 'pending',
                    note: v?.note || '',
                    verifiedBy: v?.verifiedByName || '',
                    verifiedAt: v?.verifiedAt || null,
                };
            });
        }

        // Education is professional information; the certificates behind it are not.
        const eduStatus = vis.verification ? (verificationBySection.education?.status || 'pending') : undefined;
        const text = (v) => trim(v).slice(0, 120);
        out.education = {
            qualifications: [
                ...(trim(p.qualification) ? [{
                    qualification: p.qualification, kind: 'highest', specialization: '',
                    institution: '', passingYear: null, grade: '', verificationStatus: eduStatus,
                }] : []),
                ...(trim(p.teachingDegree) ? [{
                    qualification: p.teachingDegree, kind: 'teaching_degree', specialization: '',
                    institution: '', passingYear: null, grade: '', verificationStatus: eduStatus,
                }] : []),
                // Everything else the person holds, added on the Education tab.
                ...(Array.isArray(p.qualifications) ? p.qualifications : []).map((q, i) => ({
                    index: i, kind: 'additional',
                    qualification: text(q?.qualification), specialization: text(q?.specialization),
                    institution: text(q?.institution), passingYear: q?.passingYear || null, grade: text(q?.grade),
                    verificationStatus: eduStatus,
                })).filter((q) => q.qualification),
            ],
            supportsMultiple: true,
        };

        if (vis.personal) {
            out.personal = {
                fullName: user.name,
                dob: p.dob || null,
                gender: p.gender || '',
                bloodGroup: p.bloodGroup || '',
                fatherOrHusbandName: p.fatherOrHusbandName || '',
                emergencyContactName: p.emergencyContactName || '',
                emergencyContactPhone: p.emergencyContactPhone || '',
            };
        }
        if (vis.contactFull) {
            out.contact = {
                phone: user.phone || '',
                alternatePhone: p.alternatePhone || '',
                email: user.email,
                currentAddress: {
                    line: p.currentAddress || '', city: p.currentCity || '', state: p.currentState || '',
                    pincode: p.currentPincode || '', country: p.currentCountry || '',
                },
                permanentAddress: {
                    line: p.permanentAddress || '', city: p.permanentCity || '', state: p.permanentState || '',
                    pincode: p.permanentPincode || '', country: p.permanentCountry || '',
                },
                emergencyContact: { name: p.emergencyContactName || '', phone: p.emergencyContactPhone || '' },
            };
        }
        out.employment = {
            employeeId: p.employeeId || '',
            teacherId: p.employeeId || '',
            joiningDate: p.joiningDate || null,
            designation: row.designation,
            department: row.department,
            staffType: row.staffType,
            reportingManager: manager,
            // Campus / branch has no entity in this ERP; the School row is the tenant.
            campus: null,
            ...(vis.employmentFull ? {
                // 'set' = somebody chose it; 'derived' = read off the assignments.
                staffTypeSource: row.staffTypeSource,
                employmentStatus: row.employmentStatus,
                employmentType: p.employmentType || '',
                totalExperience: p.totalExperience || p.experience || '',
                previousSchool: p.previousSchool || '',
                lastDesignation: p.lastDesignation || '',
                employmentStage: p.employmentStage || '',
                employmentStageLabel: STAGE_LABEL[p.employmentStage] || '',
                probationEndDate: p.probationEndDate || null,
                confirmationDate: p.confirmationDate || null,
                exitDate: p.exitDate || null,
                exitReason: p.exitReason || '',
            } : {}),
        };

        if (vis.documents) {
            // Every slot, on file or not: the office sees what is missing and
            // can put a paper handed in at the desk straight onto the record.
            const view = await employeeDocs.documentsOf(req.schoolId, profile || { user: uid }, names);
            const sectionSigner = (d) => (d.state === 'verified' && !d.reviewedBy ? (verificationBySection[d.section]?.verifiedByName || '') : d.reviewedBy);
            out.documents = view.documents
                .filter((d) => !d.sensitive || (d.gate === 'bank' ? vis.bank : vis.governmentId))
                .map((d) => ({
                    key: d.key, category: d.category, label: d.label, required: d.required,
                    fileName: d.fileName, url: d.url, sensitive: d.sensitive,
                    uploadedAt: d.uploadedAt,
                    verificationStatus: d.state,
                    rejectionComment: d.comment || '',
                    verifiedBy: sectionSigner(d) || '',
                    verifiedAt: d.state === 'verified' ? (d.reviewedAt || verificationBySection[d.section]?.verifiedAt || null) : null,
                }));
            out.hasProfile = !!profile;
        }

        if (vis.governmentId) {
            out.governmentIds = {
                aadhaarNumber: svc.maskAadhaar(p.aadhaarNumber),
                aadhaarMasked: true,
                panNumber: svc.maskPan(p.panNumber),
                panMasked: true,
                uanNumber: svc.maskUan(p.uanNumber),
                uanMasked: true,
                aadhaarFront: p.aadhaarFrontFile ? `${svc.STAFF_DOC_BASE}/${p.aadhaarFrontFile}` : '',
                aadhaarBack:  p.aadhaarBackFile  ? `${svc.STAFF_DOC_BASE}/${p.aadhaarBackFile}`  : '',
                panDocument:  p.panCardFile      ? `${svc.STAFF_DOC_BASE}/${p.panCardFile}`      : '',
                verificationStatus: verificationBySection.government_id?.status || 'pending',
            };
        }

        if (vis.bank) {
            out.bank = {
                accountHolder: p.bankAccountHolder || '',
                accountNumber: svc.maskAccount(p.bankAccountNumber),
                accountMasked: true,
                ifsc: p.bankIfsc || '',
                branch: p.bankBranch || '',
                verificationStatus: verificationBySection.bank?.status || 'pending',
            };
        }

        // Salary rides administrative access to the payroll module, and only
        // when the school has that module switched on.
        if (vis.payroll && viewer.modules.payroll) {
            const assign = await EmployeeSalaryAssignment
                .findOne({ employee: uid, school: req.schoolId, isActive: true }).lean();
            // The CTC in force this month — the stored column is a cache that
            // a future-dated revision does not move until its month arrives.
            const today = new Date();
            out.payroll = assign ? {
                annualCtc: EmployeeSalaryAssignment.activeCtc(assign, today.getFullYear(), today.getMonth() + 1) || assign.ctc || 0,
                effectiveDate: assign.effectiveDate || null,
                revisions: (assign.ctcRevisions || []).length,
            } : null;
        }

        if (vis.completion) {
            const rejected = new Set((snap.docsByTeacher.get(uid)?.documents || []).filter((d) => d.state === 'rejected').map((d) => d.key));
            out.profileCompletion = svc.computeCompletion(user, p, rejected);
        }

        ok(res, out);
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /employees/:id/assignments?year=<academic year id> — what the person
//  taught in another year. The profile itself always shows the active one.
// ─────────────────────────────────────────────────────────────────────────────
exports.getAssignments = async (req, res) => {
    try {
        const found = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);
        const yearId = trim(req.query.year);
        const snap = await loadSnapshot(req.schoolId, { only: String(found.user._id), yearId: yearId || null });
        if (yearId && !snap.shownYear) return fail(res, 'That academic year does not belong to this school', 404);
        const row = buildRow(found.user, snap);
        ok(res, {
            academicYear: snap.shownYear?.yearName || '',
            academicYearId: snap.shownYear ? String(snap.shownYear._id) : '',
            assignments: row._assignments.map(assignmentView),
        });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /employees/:id/qualifications — the qualifications beyond the highest
//  one and the teaching degree (those two stay on the teacher form).
// ─────────────────────────────────────────────────────────────────────────────
exports.updateQualifications = async (req, res) => {
    try {
        const found = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);
        if (!found.profile) return fail(res, 'This employee has no profile record yet', 400);

        const list = Array.isArray(req.body?.qualifications) ? req.body.qualifications : null;
        if (!list) return fail(res, 'Send the list of qualifications', 400);
        if (list.length > 10) return fail(res, 'Up to ten additional qualifications can be kept', 400);
        const thisYear = new Date().getFullYear();
        const clean = [];
        for (const q of list) {
            const qualification = trim(q?.qualification).slice(0, 80);
            if (!qualification) return fail(res, 'Each qualification needs its name (for example M.Sc. Physics)', 400);
            const year = q?.passingYear === '' || q?.passingYear == null ? null : Number(q.passingYear);
            if (year !== null && (!Number.isInteger(year) || year < 1950 || year > thisYear)) {
                return fail(res, `The passing year of ${qualification} must be between 1950 and ${thisYear}`, 400);
            }
            clean.push({
                qualification,
                specialization: trim(q?.specialization).slice(0, 80),
                institution: trim(q?.institution).slice(0, 120),
                passingYear: year,
                grade: trim(q?.grade).slice(0, 30),
            });
        }

        const uid = String(found.user._id);
        await TeacherProfile.findOneAndUpdate({ user: uid, school: req.schoolId }, { $set: { qualifications: clean } });
        await employeeDocs.reopenForChanges(req.schoolId, uid,
            { user: found.user, profile: found.profile },
            { user: found.user, profile: { ...found.profile, qualifications: clean } }, req.userId);
        await audit(req, {
            actionType: 'UPDATE_EMPLOYEE_QUALIFICATIONS',
            entityId: uid,
            oldValue: { count: (found.profile.qualifications || []).length },
            newValue: { count: clean.length, qualifications: clean.map((q) => q.qualification), employeeName: found.user.name },
        });
        ok(res, { qualifications: clean });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /employees/:id/history — what has been done to this record, newest
//  first: placements, sign-offs, document decisions, and every time one of the
//  masked numbers was read in full. The log has always been written; this is
//  the first screen that shows it.
// ─────────────────────────────────────────────────────────────────────────────
const HISTORY_TEXT = {
    REVEAL_EMPLOYEE_SENSITIVE_FIELD: (n) => `Read the ${n.label || 'masked value'} in full`,
    UPDATE_EMPLOYEE_DIRECTORY_PLACEMENT: (n) => `Changed ${Object.keys(n).filter((k) => !['employeeName', 'ip', 'userAgent'].includes(k))
        .map((k) => employeeDocs.labelOf(k).toLowerCase()).join(', ') || 'the placement'}`,
    UPDATE_EMPLOYEE_VERIFICATION: (n) => `Marked ${VERIFICATION_LABELS[n.section] || n.section} ${n.status}${n.note ? ` — “${n.note}”` : ''}`,
    REOPEN_EMPLOYEE_VERIFICATION: (n) => `${VERIFICATION_LABELS[n.section] || n.section} put back to pending${n.reason ? ` — ${n.reason.replace(/^Reopened — /, '')}` : ''}`,
    VERIFY_EMPLOYEE_DOCUMENT: (n) => `Accepted ${n.document || 'a document'}`,
    REJECT_EMPLOYEE_DOCUMENT: (n) => `Rejected ${n.document || 'a document'}${n.comment ? ` — “${n.comment}”` : ''}`,
    UPLOAD_EMPLOYEE_DOCUMENT: (n) => `Uploaded ${n.document || 'a document'}${n.byOffice ? ' (by the office)' : ''}`,
    RESUBMIT_EMPLOYEE_DOCUMENT: (n) => `Uploaded ${n.document || 'a document'} again after it was rejected`,
    UPDATE_EMPLOYEE_QUALIFICATIONS: (n) => `Updated the additional qualifications (${n.count || 0} on file)`,
    CLOSE_EMPLOYEE_CHANGE_REQUEST: (n) => `${n.status === 'done' ? 'Dealt with' : 'Declined'} a correction request${n.reply ? ` — “${n.reply}”` : ''}`,
    ASSIGN_EMPLOYEE_RESPONSIBILITY: (n) => `Assigned the responsibility ${n.title || RESPONSIBILITY_LABELS[n.type] || ''}`.trim(),
    UPDATE_EMPLOYEE_RESPONSIBILITY: (n) => `${n.ended ? 'Ended' : 'Changed'} the responsibility ${n.title || RESPONSIBILITY_LABELS[n.type] || ''}`.trim(),
    REMOVE_EMPLOYEE_RESPONSIBILITY: (n, o) => `Removed the responsibility ${o?.title || RESPONSIBILITY_LABELS[o?.type] || ''}`.trim(),
};

exports.getHistory = async (req, res) => {
    try {
        const found = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);
        const uid = String(found.user._id);
        const logs = await ActivityLog.find({ school: req.schoolId, entityId: uid, actionType: { $in: Object.keys(HISTORY_TEXT) } })
            .sort({ createdAt: -1 }).limit(150).lean();
        const names = await namesOf(logs.map((l) => l.user));
        ok(res, {
            events: logs.map((l) => ({
                _id: String(l._id),
                at: l.createdAt,
                by: names.get(String(l.user)) || 'Someone no longer on the staff',
                bySelf: String(l.user) === uid,
                action: l.actionType,
                sensitive: l.actionType === 'REVEAL_EMPLOYEE_SENSITIVE_FIELD',
                text: HISTORY_TEXT[l.actionType](l.newValue || {}, l.oldValue || {}),
            })),
        });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  POST /employees/:id/reveal — one unmasked value, audited.
//  For an administrator (each field behind its own gate), and for the employee
//  reading their own record. Nobody else.
// ─────────────────────────────────────────────────────────────────────────────
exports.revealField = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        const found  = await findEmployee(req, viewer);
        if (!found) return fail(res, 'Employee not found', 404);

        const field = trim(req.body?.field);
        const def   = svc.REVEALABLE[field];
        if (!def) return fail(res, 'That field cannot be revealed', 400);

        const vis = svc.visibilityFor(viewer, found.user._id);
        if (!vis.canReveal) return fail(res, 'You do not have access to this information', 403);
        if (def.gate === 'bank' && !vis.bank) {
            return fail(res, 'Bank details are open to the school administrator and the payroll administrators', 403);
        }
        if (def.gate === 'governmentId' && !vis.governmentId) {
            return fail(res, 'You do not have access to government ID information', 403);
        }

        const value = trim(found.profile?.[field]);
        if (!value) return fail(res, 'Not on file', 404);

        // The log records THAT a value was read, never the value itself — and
        // the value is only handed over once that record exists. A read that
        // could not be written down is not given.
        try {
            await ActivityLog.create({
                user: req.userId,
                school: req.schoolId,
                actionType: 'REVEAL_EMPLOYEE_SENSITIVE_FIELD',
                entityType: 'TeacherProfile',
                entityId: String(found.user._id),
                oldValue: null,
                newValue: {
                    field,
                    label: def.label,
                    employeeName: found.user.name,
                    own: vis.self,
                    viewerRole: viewer.role,
                    viewerDesignation: viewer.designation,
                    ip: req.ip || '',
                    userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
                    at: new Date().toISOString(),
                },
            });
        } catch (e) {
            console.error('[employee-directory] reveal could not be logged:', e.message);
            return fail(res, 'This could not be recorded in the audit log, so the value was not shown. Try again.', 503);
        }

        ok(res, { field, value, label: def.label });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Timetable / Attendance / Leave — summaries read from the live modules.
// ─────────────────────────────────────────────────────────────────────────────
exports.getTimetable = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        if (!viewer.modules.timetable) return fail(res, 'The timetable module is not enabled for your school', 403);
        const found = await findEmployee(req, viewer);
        if (!found) return fail(res, 'Employee not found', 404);
        const teacherId = String(found.user._id);

        const activeYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        const sections = await ClassSection.find({
            school: req.schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}),
        }).lean();
        const sectionById = new Map(sections.map((s) => [String(s._id), s]));
        const classes = await Class.find({ school: req.schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}) }).lean();
        const classById = new Map(classes.map((c) => [String(c._id), c]));

        const timetables = sections.length
            ? await Timetable.find({ section: { $in: sections.map((s) => String(s._id)) } }).lean()
            : [];
        const ttById = new Map(timetables.map((t) => [String(t._id), t]));

        const entries = timetables.length
            ? await TimetableEntry.find({
                timetable: { $in: timetables.map((t) => String(t._id)) },
                teacher: teacherId,
            }).lean()
            : [];

        // Cover for the coming week: the periods this person takes for someone
        // else, and their own periods somebody else is taking.
        const from = startOfDay(new Date());
        const to   = endOfDay(new Date(Date.now() + 6 * 86400000));
        const window = { school: req.schoolId, date: { $gte: from, $lte: to }, status: 'assigned' };
        const [covering, coveredBy] = await Promise.all([
            SubstituteAssignment.find({ ...window, substituteTeacher: teacherId }).lean().catch(() => []),
            SubstituteAssignment.find({ ...window, originalTeacher: teacherId }).lean().catch(() => []),
        ]);

        const subjectIds = [...new Set([...entries, ...covering, ...coveredBy].map((e) => e.subject).filter(Boolean).map(String))];
        const roomIds    = [...new Set(entries.map((e) => e.room).filter(Boolean).map(String))];
        const [subjects, rooms, people] = await Promise.all([
            subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean() : [],
            roomIds.length    ? Room.find({ _id: { $in: roomIds } }).select('roomName roomNumber').lean() : [],
            namesOf([...covering.map((c) => c.originalTeacher), ...coveredBy.map((c) => c.substituteTeacher)]),
        ]);
        const subjectById = new Map(subjects.map((s) => [String(s._id), s.subjectName]));
        const roomById    = new Map(rooms.map((r) => [String(r._id), r.roomNumber ? `${r.roomName} (${r.roomNumber})` : r.roomName]));

        const week = Object.fromEntries(DAYS.map((d) => [d, []]));
        for (const e of entries) {
            const tt  = ttById.get(String(e.timetable));
            const sec = tt ? sectionById.get(String(tt.section)) : null;
            const cls = sec ? classById.get(String(sec.class)) : null;
            if (!week[e.dayOfWeek]) continue;
            week[e.dayOfWeek].push({
                periodNumber: e.periodNumber,
                subject: subjectById.get(String(e.subject)) || '',
                className: cls?.className || '',
                sectionName: sec?.sectionName || '',
                sectionId: sec ? String(sec._id) : '',
                room: e.room ? (roomById.get(String(e.room)) || '') : '',
            });
        }
        for (const d of DAYS) week[d].sort((a, b) => a.periodNumber - b.periodNumber);

        // Free periods are read from the sections' own period structure, so the
        // directory never re-derives a school day of its own. Only TEACHING
        // periods count: a break or lunch row is not a period anybody is free in.
        const teachingNumbers = timetables.flatMap((t) => (t.periodsStructure || [])
            .filter((row) => !row.isRecess && Number(row.periodNumber) > 0)
            .map((row) => Number(row.periodNumber)));
        const maxPeriods = Math.max(0, ...teachingNumbers);
        const freeByDay = Object.fromEntries(DAYS.map((d) => {
            const busy = new Set(week[d].map((p) => p.periodNumber));
            const free = [];
            for (let i = 1; i <= maxPeriods; i += 1) if (!busy.has(i)) free.push(i);
            return [d, free];
        }));

        const coverView = (c, otherId) => {
            const sec = sectionById.get(String(c.section));
            const cls = sec ? classById.get(String(sec.class)) : null;
            return {
                _id: String(c._id), date: c.date, dayOfWeek: c.dayOfWeek, periodNumber: c.periodNumber,
                subject: c.subject ? (subjectById.get(String(c.subject)) || '') : '',
                className: cls?.className || '', sectionName: sec?.sectionName || '',
                with: people.get(String(otherId)) || '',
            };
        };
        const byWhen = (a, b) => new Date(a.date) - new Date(b.date) || a.periodNumber - b.periodNumber;

        const todayName = DAYS[(new Date().getDay() + 6) % 7] || '';
        ok(res, {
            academicYear: activeYear?.yearName || '',
            days: DAYS,
            week,
            today: { day: todayName, periods: week[todayName] || [] },
            freePeriods: freeByDay,
            totalPeriodsPerWeek: entries.length,
            maxPeriods,
            cover: {
                covering:  covering.map((c) => coverView(c, c.originalTeacher)).sort(byWhen),
                coveredBy: coveredBy.map((c) => coverView(c, c.substituteTeacher)).sort(byWhen),
            },
        });
    } catch (e) { fail(res, e); }
};

exports.getAttendance = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        const found  = await findEmployee(req, viewer);
        if (!found) return fail(res, 'Employee not found', 404);
        const vis = svc.visibilityFor(viewer, found.user._id);
        if (!vis.attendance) return fail(res, 'You do not have access to attendance information', 403);
        if (!viewer.modules.attendance) return fail(res, 'The attendance module is not enabled for your school', 403);

        // The window: named (30 days / six months / this academic year) or two
        // dates. A date that is not one is refused, not passed to the database.
        const now = new Date();
        const range = ['30d', '6m', 'year'].includes(String(req.query.range)) ? String(req.query.range) : '';
        let from; let to = now; let label = 'Last six months';
        if (req.query.from || req.query.to) {
            from = dateFrom(req.query.from);
            to   = req.query.to ? dateFrom(req.query.to) : now;
            if (!from || !to) return fail(res, 'Choose valid dates for the attendance range', 400);
            if (from > to) return fail(res, 'The range starts after it ends', 400);
            label = 'Chosen dates';
        } else if (range === '30d') {
            from = new Date(now.getTime() - 29 * 86400000); label = 'Last 30 days';
        } else if (range === 'year') {
            const year = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).select('startDate yearName').lean();
            from = isDate(year?.startDate) ? new Date(year.startDate) : new Date(now.getFullYear(), now.getMonth() - 11, 1);
            label = year?.yearName ? `Academic year ${year.yearName}` : 'Last twelve months';
        } else {
            from = new Date(now.getFullYear(), now.getMonth() - 5, 1);
        }
        if (to - from > 400 * 86400000) return fail(res, 'Choose a range of a year or less', 400);

        const records = await TeacherAttendance.find({
            teacher: String(found.user._id), school: req.schoolId,
            date: { $gte: startOfDay(from), $lte: endOfDay(to) },
        }).select('date status checkIn checkOut').lean();

        const counts = { Present: 0, Absent: 0, 'Half-Day': 0, Leave: 0 };
        for (const r of records) if (counts[r.status] !== undefined) counts[r.status] += 1;
        // A half day counts as half a present day, matching how the attendance
        // module reports a teacher's own percentage.
        const marked  = records.length;
        const present = counts.Present + counts['Half-Day'] * 0.5;

        ok(res, {
            range: { from: startOfDay(from), to, key: range || (req.query.from ? 'custom' : '6m'), label },
            present: counts.Present,
            absent: counts.Absent,
            halfDay: counts['Half-Day'],
            leave: counts.Leave,
            marked,
            percent: marked ? Math.round((present / marked) * 1000) / 10 : null,
            recent: [...records].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10),
        });
    } catch (e) { fail(res, e); }
};

exports.getLeave = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        const found  = await findEmployee(req, viewer);
        if (!found) return fail(res, 'Employee not found', 404);
        const vis = svc.visibilityFor(viewer, found.user._id);
        if (!vis.leave) return fail(res, 'You do not have access to leave information', 403);
        if (!viewer.modules.leave) return fail(res, 'The leave module is not enabled for your school', 403);

        const teacherId = String(found.user._id);
        const [everyApplication, allBalances, types, activeYear, activeYearRow] = await Promise.all([
            LeaveApplication.find({ teacher: teacherId, school: req.schoolId }).lean(),
            LeaveBalance.find({ teacher: teacherId, school: req.schoolId }).lean(),
            LeaveType.find({ school: req.schoolId }).select('name code').lean(),
            getActiveAcademicYearLabel(req.schoolId).catch(() => null),
            AcademicYear.findOne({ school: req.schoolId, status: 'active' }).select('startDate endDate').lean(),
        ]);
        const typeName = new Map(types.map((t) => [String(t._id), t.name]));

        // One row per leave type, for ONE year. A balance row exists per
        // (type × academic year), and every year's rows used to be listed
        // together with no year beside them — so Casual Leave appeared once
        // for each year on record, each with different figures. The year shown
        // is the one the Leave module is counting (the active year); a school
        // with no active year falls back to the latest year on record.
        const years = [...new Set(allBalances.map((b) => String(b.academicYear || '')))].sort();
        const year = activeYear && years.includes(String(activeYear)) ? String(activeYear) : (years[years.length - 1] || (activeYear ? String(activeYear) : null));
        const balances = allBalances
            .filter((b) => String(b.academicYear || '') === year)
            .sort((a, b) => (typeName.get(String(a.leaveType)) || '').localeCompare(typeName.get(String(b.leaveType)) || ''));
        const today = startOfDay(new Date());

        // The requests are for the SAME year as the balances beside them — days
        // taken three years ago do not belong next to this year's allowance.
        // A request stamped with its year is matched on it; an older one that
        // was never stamped is placed by its dates, when the year shown is the
        // active one.
        const showingActive = !!activeYear && String(activeYear) === year;
        const inActiveYear = (a) => showingActive && isDate(activeYearRow?.startDate)
            && new Date(a.fromDate) >= new Date(activeYearRow.startDate)
            && (!isDate(activeYearRow?.endDate) || new Date(a.fromDate) <= endOfDay(activeYearRow.endDate));
        const applications = year
            ? everyApplication.filter((a) => (a.academicYear ? String(a.academicYear) === year : inActiveYear(a)))
            : everyApplication;

        const approved = applications.filter((a) => a.status === 'approved');
        const line = (a) => ({
            leaveType: typeName.get(String(a.leaveType)) || '',
            fromDate: a.fromDate, toDate: a.toDate, totalDays: a.totalDays, status: a.status,
        });
        ok(res, {
            balanceYear: year,
            balances: balances.map((b) => ({
                leaveType: typeName.get(String(b.leaveType)) || '',
                academicYear: b.academicYear,
                allocated: b.totalAllocated || 0,
                carriedForward: b.carriedForward || 0,
                used: b.used || 0,
                pending: b.pending || 0,
                expired: b.expired || 0,
                remaining: Math.max(0, (b.totalAllocated || 0) + (b.carriedForward || 0)
                    - (b.used || 0) - (b.pending || 0) - (b.expired || 0)),
            })),
            taken: approved.reduce((s, a) => s + (Number(a.totalDays) || 0), 0),
            pendingRequests: applications.filter((a) => a.status === 'pending').length,
            approvedRequests: approved.length,
            rejectedRequests: applications.filter((a) => a.status === 'rejected').length,
            // On leave now, or about to be: anything approved that has not ended.
            upcoming: approved
                .filter((a) => new Date(a.toDate) >= today)
                .sort((a, b) => new Date(a.fromDate) - new Date(b.fromDate))
                .slice(0, 5)
                .map((a) => ({ ...line(a), ongoing: new Date(a.fromDate) <= endOfDay(new Date()) })),
            recent: [...applications]
                .sort((a, b) => new Date(b.fromDate) - new Date(a.fromDate))
                .slice(0, 10)
                .map(line),
        });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Administrative writes. Each one edits the EXISTING employee record and
//  writes an ActivityLog entry with the previous and new value.
// ─────────────────────────────────────────────────────────────────────────────
async function audit(req, { actionType, entityId, oldValue, newValue, entityType = 'TeacherProfile' }) {
    await ActivityLog.create({
        user: req.userId, school: req.schoolId, actionType, entityType, entityId,
        oldValue, newValue: { ...newValue, ip: req.ip || '', userAgent: String(req.headers['user-agent'] || '').slice(0, 200) },
    }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
//  Departments — the school's list (EmployeeDepartment) joined to the name on
//  each employee record. A listed department nobody is in yet still shows; a
//  name typed on somebody's record that was never listed shows too, marked so,
//  until it is added to the list or its people are moved.
// ─────────────────────────────────────────────────────────────────────────────
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 &/().,'-]{1,59}$/;

exports.getDepartments = async (req, res) => {
    try {
        const { snap, rows } = await collect(req);
        const groups = new Map(bucket(rows, (r) => r.department).map((g) => [low(g.label), g]));
        const view = (name, members, listed) => ({
            _id: listed ? String(listed._id) : null,
            listed: !!listed || name === UNASSIGNED,
            name,
            description: listed?.description || '',
            head: listed?.head ? resolvePerson(snap, listed.head) : null,
            total: members.length,
            // Accounts that are switched on. Somebody on leave today still works here.
            active: members.filter((r) => r.isActive).length,
            teaching: members.filter((r) => r.staffType === 'teaching').length,
            nonTeaching: members.filter((r) => r.staffType !== 'teaching').length,
            designations: [...new Set(members.map((r) => r.designation).filter(Boolean))].sort(),
            members: members
                .map((r) => ({ _id: r._id, name: r.name, designation: r.designation, employeeId: r.employeeId, isActive: r.isActive }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        });

        const out = [];
        for (const d of snap.departments) {
            const g = groups.get(low(d.name));
            out.push(view(d.name, g?.rows || [], d));
            groups.delete(low(d.name));
        }
        for (const g of groups.values()) out.push(view(g.label, g.rows, null));

        ok(res, {
            departments: out.sort((a, b) => (a.name === UNASSIGNED ? 1 : b.name === UNASSIGNED ? -1
                : b.total - a.total || a.name.localeCompare(b.name))),
        });
    } catch (e) { fail(res, e); }
};

/** `{ name }` checked and tidied, or `{ error }`. */
function departmentName(raw) {
    const name = trim(raw).replace(/\s+/g, ' ');
    if (!name) return { error: 'Give the department a name' };
    if (low(name) === low(UNASSIGNED)) return { error: '"Unassigned" is what the people without a department are called — choose another name' };
    if (!NAME_OK.test(name)) return { error: 'A department name is 2 to 60 letters, numbers and spaces' };
    return { name };
}

/** A head has to be somebody who works here now. Returns the id, null, or `undefined` when refused. */
async function headFor(req, raw) {
    const id = trim(raw);
    if (!id) return null;
    const u = await User.findOne({ _id: id, school: req.schoolId, isActive: true }).select('role').lean().catch(() => null);
    return u && ['teacher', 'school_admin'].includes(u.role) ? id : undefined;
}

/** The profile rows whose department is `name`, whatever its capitals. */
async function profilesIn(schoolId, name) {
    const all = await TeacherProfile.find({ school: schoolId }).select('department user').lean();
    return all.filter((p) => low(p.department) === low(name));
}

exports.createDepartment = async (req, res) => {
    try {
        const { name, error } = departmentName(req.body?.name);
        if (error) return fail(res, error, 400);
        const listed = await EmployeeDepartment.find({ school: req.schoolId }).select('name').lean();
        if (listed.some((d) => low(d.name) === low(name))) return fail(res, `${name} is already on the list`, 409);
        const head = await headFor(req, req.body?.head);
        if (head === undefined) return fail(res, 'The head of a department has to be an active member of staff', 400);

        const row = await EmployeeDepartment.create({
            school: req.schoolId, name, description: trim(req.body?.description).slice(0, 200), head, createdBy: req.userId,
        });
        // People already carrying this name in other capitals take the listed spelling.
        const members = (await profilesIn(req.schoolId, name)).filter((p) => p.department !== name);
        if (members.length) {
            await TeacherProfile.updateMany({ _id: { $in: members.map((p) => String(p._id)) } }, { $set: { department: name } });
        }
        await audit(req, {
            actionType: 'CREATE_EMPLOYEE_DEPARTMENT', entityType: 'EmployeeDepartment', entityId: String(row._id),
            oldValue: null, newValue: { name },
        });
        ok(res, { _id: String(row._id), name }, 201);
    } catch (e) { fail(res, e); }
};

exports.updateDepartment = async (req, res) => {
    try {
        const row = await EmployeeDepartment.findOne({ _id: String(req.params.id), school: req.schoolId }).lean().catch(() => null);
        if (!row) return fail(res, 'Department not found', 404);
        const patch = {};
        if (req.body?.name !== undefined) {
            const { name, error } = departmentName(req.body.name);
            if (error) return fail(res, error, 400);
            if (name !== row.name) {
                const listed = await EmployeeDepartment.find({ school: req.schoolId }).select('name').lean();
                if (listed.some((d) => String(d._id) !== String(row._id) && low(d.name) === low(name))) {
                    return fail(res, `${name} is already a department — move the staff there instead of renaming`, 409);
                }
                patch.name = name;
            }
        }
        if (req.body?.description !== undefined) patch.description = trim(req.body.description).slice(0, 200);
        if (req.body?.head !== undefined) {
            const head = await headFor(req, req.body.head);
            if (head === undefined) return fail(res, 'The head of a department has to be an active member of staff', 400);
            patch.head = head;
        }
        if (!Object.keys(patch).length) return ok(res, { _id: String(row._id), moved: 0 });

        await EmployeeDepartment.findByIdAndUpdate(row._id, { $set: patch });
        // The department's name is what sits on each member's record: a rename
        // goes with them, or the old name would live on as a second department.
        let moved = 0;
        if (patch.name) {
            const members = await profilesIn(req.schoolId, row.name);
            moved = members.length;
            if (moved) await TeacherProfile.updateMany({ _id: { $in: members.map((p) => String(p._id)) } }, { $set: { department: patch.name } });
        }
        await audit(req, {
            actionType: 'UPDATE_EMPLOYEE_DEPARTMENT', entityType: 'EmployeeDepartment', entityId: String(row._id),
            oldValue: { name: row.name, description: row.description || '', head: row.head ? String(row.head) : '' },
            newValue: { ...patch, moved },
        });
        ok(res, { _id: String(row._id), moved });
    } catch (e) { fail(res, e); }
};

/**
 * POST /departments/move { from, to } — everyone in one department into
 * another: how two spellings are merged, and how a department is emptied
 * before it is removed. `to` "Unassigned" (or blank) leaves them unplaced.
 */
exports.moveDepartment = async (req, res) => {
    try {
        const from = trim(req.body?.from);
        const toRaw = trim(req.body?.to);
        if (!from) return fail(res, 'Say which department to move the staff out of', 400);
        const unplace = !toRaw || low(toRaw) === low(UNASSIGNED);
        if (!unplace && low(from) === low(toRaw)) return fail(res, 'That is the same department', 400);

        const [listed, all] = await Promise.all([
            EmployeeDepartment.find({ school: req.schoolId }).lean(),
            TeacherProfile.find({ school: req.schoolId }).select('department').lean(),
        ]);
        // The destination has to exist — listed, or already on somebody's record.
        let to = '';
        if (!unplace) {
            to = listed.find((d) => low(d.name) === low(toRaw))?.name
                || trim(all.find((p) => low(p.department) === low(toRaw))?.department);
            if (!to) return fail(res, `${toRaw} is not a department yet — add it to the list first`, 400);
        }
        const members = low(from) === low(UNASSIGNED)
            ? all.filter((p) => !trim(p.department))
            : all.filter((p) => low(p.department) === low(from));
        if (members.length) {
            await TeacherProfile.updateMany({ _id: { $in: members.map((p) => String(p._id)) } }, { $set: { department: to } });
        }
        // An emptied department that was on the list goes with the merge when asked.
        const source = listed.find((d) => low(d.name) === low(from));
        const removed = !!source && req.body?.remove !== false;
        if (removed) await EmployeeDepartment.findByIdAndDelete(String(source._id));

        await audit(req, {
            actionType: 'MOVE_EMPLOYEE_DEPARTMENT', entityType: 'EmployeeDepartment',
            entityId: source ? String(source._id) : null,
            oldValue: { from }, newValue: { to: to || UNASSIGNED, moved: members.length, removed },
        });
        ok(res, { moved: members.length, to: to || UNASSIGNED, removed });
    } catch (e) { fail(res, e); }
};

exports.removeDepartment = async (req, res) => {
    try {
        const row = await EmployeeDepartment.findOne({ _id: String(req.params.id), school: req.schoolId }).lean().catch(() => null);
        if (!row) return fail(res, 'Department not found', 404);
        const members = await profilesIn(req.schoolId, row.name);
        if (members.length) {
            return fail(res, `${members.length} ${members.length === 1 ? 'person is' : 'people are'} still in ${row.name} — move them to another department first`, 409);
        }
        await EmployeeDepartment.findByIdAndDelete(String(row._id));
        await audit(req, {
            actionType: 'REMOVE_EMPLOYEE_DEPARTMENT', entityType: 'EmployeeDepartment', entityId: String(row._id),
            oldValue: { name: row.name }, newValue: {},
        });
        ok(res, { removed: String(row._id) });
    } catch (e) { fail(res, e); }
};

exports.getDesignations = async (req, res) => {
    try {
        const { rows } = await collect(req);
        ok(res, {
            designations: bucket(rows, (r) => r.designation).map((g) => ({
                name: g.label,
                total: g.rows.length,
                active: g.rows.filter((r) => r.isActive).length,
                members: g.rows.map((r) => ({ _id: r._id, name: r.name, department: r.department, employeeId: r.employeeId, isActive: r.isActive })),
            })).sort((a, b) => b.total - a.total),
        });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /org-structure — the reporting tree, with the designation/department
//  grouping the ERP already has as the fallback shape.
// ─────────────────────────────────────────────────────────────────────────────
exports.getOrgStructure = async (req, res) => {
    try {
        const { snap, rows } = await collect(req);

        const nodes = new Map(rows.map((r) => [r._id, {
            _id: r._id, name: r.name, designation: r.designation, department: r.department,
            employeeId: r.employeeId, profileImage: r.profileImage, staffType: r.staffType,
            employmentStatus: r.employmentStatus, children: [],
        }]));
        // The school's administrators head the chart. They are not staff
        // records (no profile, nothing to verify), so they are marked and the
        // page counts employees without them.
        for (const [id, u] of snap.adminById) {
            nodes.set(id, {
                _id: id, name: u.name, designation: 'School Administrator', department: '',
                employeeId: '', profileImage: u.profileImage || '', staffType: '',
                employmentStatus: 'active', isSchoolAdmin: true, children: [],
            });
        }

        // Each person is hung under their manager only if that cannot close a
        // loop: the chain above the manager is walked first, and an edge that
        // would lead back to the person is dropped (they sit at the top). The
        // accepted edges are therefore always a forest — a loop on record can
        // no longer produce a tree that refers to itself.
        const parentOf = new Map();
        const roots = [];
        for (const r of rows) {
            const parentId = r.reportingManagerId;
            let ok2 = !!parentId && parentId !== r._id && nodes.has(parentId);
            for (let cursor = parentId, hops = 0; ok2 && cursor; cursor = parentOf.get(cursor), hops += 1) {
                if (cursor === r._id || hops > rows.length) ok2 = false;
            }
            if (ok2) { parentOf.set(r._id, parentId); nodes.get(parentId).children.push(nodes.get(r._id)); }
            else roots.push(nodes.get(r._id));
        }
        // An administrator appears once somebody reports to them.
        for (const id of snap.adminById.keys()) if (nodes.get(id).children.length) roots.push(nodes.get(id));

        const byName = (a, b) => (b.isSchoolAdmin ? 1 : 0) - (a.isSchoolAdmin ? 1 : 0) || a.name.localeCompare(b.name);
        const order = (n) => { n.children.sort(byName); n.children.forEach(order); };
        roots.sort(byName);
        roots.forEach(order);

        const byDepartment = bucket(rows, (r) => r.department).map((dep) => {
            const desigs = bucket(dep.rows, (r) => r.designation);
            return {
                department: dep.label,
                designations: desigs.map((g) => ({
                    designation: g.label,
                    members: g.rows.map((r) => ({ _id: r._id, name: r.name, employeeId: r.employeeId })),
                })),
                total: dep.rows.length,
            };
        }).sort((a, b) => b.total - a.total);

        ok(res, {
            hasReportingLines: parentOf.size > 0,
            employeeCount: rows.length,
            reporting: parentOf.size,
            tree: roots,
            byDepartment,
        });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Placement — department, staff type, reporting line, and where the
//  employment stands. One rule set for one person and for many at once.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Work out the change `body` asks for on one profile. Returns `{ error }` or
 * `{ patch, before }`. `ctx` carries the school's departments and reporting
 * lines, read once for the whole request.
 */
function placementFor(found, b, ctx) {
    const patch = {};
    const before = {};
    const uid = String(found.user._id);

    if (b.department !== undefined) {
        const typed = trim(b.department).replace(/\s+/g, ' ');
        if (typed && low(typed) !== low(UNASSIGNED) && !NAME_OK.test(typed)) return { error: 'A department name is 2 to 60 letters, numbers and spaces' };
        // The spelling already in use wins, so a second department is never
        // made by a different capital letter.
        patch.department = !typed || low(typed) === low(UNASSIGNED) ? '' : (ctx.deptSpelling.get(low(typed)) || typed);
        before.department = found.profile.department || '';
    }
    if (b.staffType !== undefined) {
        const v = trim(b.staffType);
        if (!['teaching', 'non_teaching', ''].includes(v)) return { error: 'Invalid staff type' };
        patch.staffType = v;
        before.staffType = found.profile.staffType || '';
    }
    if (b.reportingManager !== undefined) {
        const managerId = trim(b.reportingManager);
        if (managerId) {
            if (managerId === uid) return { error: `${found.user.name} cannot report to themselves` };
            if (!ctx.managerIds.has(managerId)) return { error: 'The reporting manager has to be an active member of staff at this school' };
            // Walk up the existing chain so a new edge cannot close a loop.
            for (let cursor = managerId, hops = 0; cursor && hops < 200; cursor = ctx.managerOf.get(cursor) || '', hops += 1) {
                if (cursor === uid) return { error: `That would create a reporting loop — ${found.user.name} is above that person` };
            }
        }
        patch.reportingManager = managerId || null;
        before.reportingManager = found.profile.reportingManager ? String(found.profile.reportingManager) : '';
    }
    if (b.employmentStage !== undefined) {
        const v = trim(b.employmentStage);
        if (v && !STAGE_LABEL[v]) return { error: 'Unknown employment stage' };
        patch.employmentStage = v;
        before.employmentStage = found.profile.employmentStage || '';
    }
    for (const [key, label] of [['probationEndDate', 'probation end date'], ['confirmationDate', 'confirmation date'], ['exitDate', 'last working day']]) {
        if (b[key] === undefined) continue;
        const d = dateFrom(b[key]);
        if (d === undefined) return { error: `The ${label} is not a valid date` };
        patch[key] = d;
        before[key] = found.profile[key] || null;
    }
    if (b.exitReason !== undefined) {
        patch.exitReason = trim(b.exitReason).slice(0, 300);
        before.exitReason = found.profile.exitReason || '';
    }

    // The dates have to agree with each other and with the joining date.
    const at = (k) => (patch[k] !== undefined ? patch[k] : found.profile[k]);
    const joined = isDate(found.profile.joiningDate) ? startOfDay(found.profile.joiningDate) : null;
    for (const [key, label] of [['probationEndDate', 'Probation'], ['confirmationDate', 'Confirmation'], ['exitDate', 'The last working day']]) {
        if (patch[key] && joined && startOfDay(patch[key]) < joined) return { error: `${label} cannot be before the date of joining` };
    }
    const stage = patch.employmentStage !== undefined ? patch.employmentStage : (found.profile.employmentStage || '');
    if (EXITED.has(stage) && (patch.employmentStage !== undefined || patch.exitDate !== undefined) && !at('exitDate')) {
        return { error: `Give the last working day for someone marked ${STAGE_LABEL[stage].toLowerCase()}` };
    }
    return { patch, before };
}

/** The departments and reporting lines `placementFor` checks against. */
async function placementContext(schoolId) {
    const snap = await loadSnapshot(schoolId);
    const managerOf = new Map();
    for (const [uid, p] of snap.profileByUser) if (p.reportingManager) managerOf.set(uid, String(p.reportingManager));
    return {
        snap,
        deptSpelling: snap.deptSpelling,
        managerOf,
        managerIds: new Set([...snap.adminById.keys(), ...snap.users.filter((u) => u.isActive).map((u) => String(u._id))]),
    };
}

exports.updateEmployment = async (req, res) => {
    try {
        const found = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);
        if (!found.profile) return fail(res, 'This employee has no profile record yet', 400);

        const ctx = await placementContext(req.schoolId);
        const { patch, before, error } = placementFor(found, req.body || {}, ctx);
        if (error) return fail(res, error, 400);
        if (!Object.keys(patch).length) return fail(res, 'Nothing to update', 400);

        await TeacherProfile.findOneAndUpdate({ user: String(found.user._id), school: req.schoolId }, { $set: patch });
        await audit(req, {
            actionType: 'UPDATE_EMPLOYEE_DIRECTORY_PLACEMENT',
            entityId: String(found.user._id),
            oldValue: before,
            newValue: { ...patch, employeeName: found.user.name },
        });
        ok(res, { updated: Object.keys(patch) });
    } catch (e) { fail(res, e); }
};

/**
 * PUT /employees/bulk-employment { ids, department?, reportingManager?,
 * staffType?, employmentStage? } — the same placement, for many people. Each
 * is checked on their own; the ones that cannot take it are reported back by
 * name rather than stopping the rest.
 */
exports.bulkEmployment = async (req, res) => {
    try {
        const b = req.body || {};
        const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean))].slice(0, 300);
        if (!ids.length) return fail(res, 'Choose the employees to change', 400);
        const change = {};
        for (const k of ['department', 'reportingManager', 'staffType', 'employmentStage']) if (b[k] !== undefined) change[k] = b[k];
        if (!Object.keys(change).length) return fail(res, 'Choose what to change', 400);

        const ctx = await placementContext(req.schoolId);
        const done = [];
        const skipped = [];
        for (const id of ids) {
            const user = ctx.snap.userById.get(id);
            const profile = ctx.snap.profileByUser.get(id);
            if (!user) { skipped.push({ name: 'Someone no longer on the staff', reason: 'Not an employee of this school' }); continue; }
            if (!profile) { skipped.push({ name: user.name, reason: 'No staff record yet' }); continue; }
            const { patch, before, error } = placementFor({ user, profile }, change, ctx);
            if (error) { skipped.push({ name: user.name, reason: error }); continue; }
            await TeacherProfile.findByIdAndUpdate(profile._id, { $set: patch });
            // Later people in the same batch are checked against lines as they now stand.
            if (patch.reportingManager !== undefined) {
                if (patch.reportingManager) ctx.managerOf.set(id, patch.reportingManager); else ctx.managerOf.delete(id);
            }
            await audit(req, {
                actionType: 'UPDATE_EMPLOYEE_DIRECTORY_PLACEMENT', entityId: id,
                oldValue: before, newValue: { ...patch, employeeName: user.name, bulk: true },
            });
            done.push(user.name);
        }
        ok(res, { updated: done.length, skipped });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a section cannot be signed off yet, or '' when it can.
 *
 *  · its key values are not on file — there is nothing to have checked;
 *  · a document it REQUIRES has not been uploaded;
 *  · a document that is on file has not been accepted on its own.
 *
 * An optional document nobody uploaded stops nothing: a fresher has no
 * resignation letter to give, and their record can still be complete.
 */
function sectionProblem(section, user, profile, documents) {
    const p = profile || {};
    const def = svc.SECTION_FIELDS[section];
    const blank = (def?.key || []).filter(([k]) => {
        const v = svc.USER_FIELDS.has(k) ? user?.[k] : p[k];
        return v instanceof Date ? Number.isNaN(v.getTime()) : !trim(v);
    });
    if (blank.length) {
        return `${VERIFICATION_LABELS[section]} cannot be verified — ${blank.map(([, l]) => l).join(' and ')} `
            + `${blank.length === 1 ? 'is' : 'are'} not on file. Complete the employee record first.`;
    }
    const mine = documents.filter((d) => d.section === section);
    const missing = mine.filter((d) => d.required && !d.fileName);
    if (missing.length) {
        return `${VERIFICATION_LABELS[section]} is still waiting for ${missing.map((d) => d.label).join(', ')}. `
            + 'Upload the paperwork on the employee record first.';
    }
    const open = mine.filter((d) => d.fileName && d.state !== 'verified');
    if (open.length) {
        return `Verify or reject each document first — ${open.map((d) => d.label).join(', ')} `
            + `${open.length === 1 ? 'has' : 'have'} not been accepted yet.`;
    }
    return '';
}

exports.setVerification = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        const found = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);
        const uid = String(found.user._id);

        const section = trim(req.body?.section);
        const status  = trim(req.body?.status);
        const note    = trim(req.body?.note).slice(0, 300);
        if (!VERIFICATION_SECTIONS.includes(section)) return fail(res, 'Unknown verification section', 400);
        if (!VERIFICATION_STATUSES.includes(status))  return fail(res, 'Unknown verification status', 400);

        // Nobody signs their own record off, whatever their designation.
        if (uid === viewer.userId) return fail(res, 'You cannot verify your own record — another administrator has to', 403);
        // Bank details can only be checked by somebody who can read them.
        if (section === 'bank' && !svc.visibilityFor(viewer, uid).bank) {
            return fail(res, 'Bank details are verified by the school administrator or a payroll administrator', 403);
        }
        if (status === 'rejected' && note.length < 5) {
            return fail(res, 'Say what is wrong with this section — the employee is shown it', 400);
        }
        if (status === 'verified') {
            const { documents } = await employeeDocs.documentsOf(req.schoolId, found.profile || { user: uid });
            const problem = sectionProblem(section, found.user, found.profile, documents);
            if (problem) return fail(res, problem, 400);
        }

        const existing = await EmployeeVerification.findOne({ employee: uid, section }).lean();
        const payload = {
            school: req.schoolId,
            employee: uid,
            section,
            status,
            note,
            verifiedBy: status === 'verified' ? req.userId : null,
            verifiedAt: status === 'verified' ? new Date() : null,
        };
        if (existing) await EmployeeVerification.findByIdAndUpdate(existing._id, { $set: payload });
        else {
            // Two reviewers at once both find no row; the second insert meets
            // the unique index and becomes the update it should have been.
            try { await EmployeeVerification.create(payload); }
            catch (e) {
                const row = await EmployeeVerification.findOne({ employee: uid, section }).lean();
                if (!row) throw e;
                await EmployeeVerification.findByIdAndUpdate(row._id, { $set: payload });
            }
        }

        await audit(req, {
            actionType: 'UPDATE_EMPLOYEE_VERIFICATION',
            entityType: 'EmployeeVerification',
            entityId: uid,
            oldValue: existing ? { section, status: existing.status, note: existing.note || '' } : null,
            newValue: { section, status, note: payload.note, employeeName: found.user.name },
        });
        // A rejected section is the employee's to put right — they are told why.
        if (status === 'rejected' && existing?.status !== 'rejected') {
            notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: `Your ${VERIFICATION_LABELS[section].toLowerCase()} could not be verified`,
                body: `The school office could not verify your ${VERIFICATION_LABELS[section].toLowerCase()}: ${note}. Contact the office, or ask for a correction from My Documents.`,
                recipients: [uid],
                link: { type: 'directory.mydocs' },
            });
        }
        ok(res, { section, status });
    } catch (e) { fail(res, e); }
};

exports.getVerificationQueue = async (req, res) => {
    try {
        const { viewer, snap, rows: all } = await collect(req);
        // The queue is the people who work here: the same staff the Documents
        // and Reminders tabs beside it list. A deactivated account is not
        // waiting on anybody's review.
        const rows = all.filter((r) => r.isActive);
        const sectionTotals = Object.fromEntries(VERIFICATION_SECTIONS.map((s) => [s, { verified: 0, pending: 0, rejected: 0 }]));

        const employees = rows.map((r) => {
            const state = snap.verificationByTeacher.get(r._id) || {};
            const profile = snap.profileByUser.get(r._id) || null;
            const user = snap.userById.get(r._id);
            const docs = snap.docsByTeacher.get(r._id)?.documents || [];
            const vis = svc.visibilityFor(viewer, r._id);
            const sections = VERIFICATION_SECTIONS.map((s) => {
                const status = state[s]?.status || 'pending';
                sectionTotals[s][status] += 1;
                const mine = docs.filter((d) => d.section === s);
                const restricted = (s === 'bank' && !vis.bank) || r._id === viewer.userId;
                const documents = restricted ? [] : mine.filter((d) => d.fileName).map((d) => ({
                    key: d.key, label: d.label, url: d.url, fileName: d.fileName, required: d.required,
                    // Each document's own decision — verified, rejected,
                    // pending, or re-submitted after a rejection.
                    state: d.state, comment: d.comment || '',
                    reviewedAt: d.reviewedAt || null, resubmittedAt: d.resubmittedAt || null,
                }));
                const missingRequired = mine.filter((d) => d.required && !d.fileName).map((d) => d.label);
                const problem = status === 'verified' ? '' : sectionProblem(s, user, profile, docs);
                return {
                    section: s,
                    label: VERIFICATION_LABELS[s],
                    status,
                    note: state[s]?.note || '',
                    documents,
                    documentBacked: (DOCS_BY_SECTION[s] || []).length > 0,
                    // Required paperwork that has not arrived: nothing can be
                    // signed until it does.
                    missingRequired,
                    missingDocuments: missingRequired.length > 0,
                    // The reason the server would refuse a sign-off right now.
                    problem,
                    // This reader may not see (bank: a teacher without payroll access) or
                    // may not sign (their own record) this section.
                    restricted,
                    restrictedWhy: !restricted ? '' : r._id === viewer.userId
                        ? 'This is your own record — another administrator verifies it.'
                        : 'Bank details are open to the school administrator and the payroll administrators only.',
                };
            });
            const verifiedCount = sections.filter((s) => s.status === 'verified').length;
            return {
                _id: r._id, name: r.name, employeeId: r.employeeId,
                designation: r.designation, department: r.department,
                profileImage: r.profileImage,
                sections, verifiedCount,
                totalSections: VERIFICATION_SECTIONS.length,
                percent: pct(verifiedCount, VERIFICATION_SECTIONS.length),
                profileCompletion: r.profileCompletion,
                missingDocumentCount: r.missingDocumentCount,
            };
        }).sort((a, b) => a.verifiedCount - b.verifiedCount || a.name.localeCompare(b.name));

        ok(res, {
            employees,
            sectionTotals: VERIFICATION_SECTIONS.map((s) => ({ section: s, label: VERIFICATION_LABELS[s], ...sectionTotals[s] })),
            fullyVerified: employees.filter((e) => e.verifiedCount === VERIFICATION_SECTIONS.length).length,
        });
    } catch (e) { fail(res, e); }
};

// ── Responsibilities ─────────────────────────────────────────────────────────
exports.listResponsibilities = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        const filter = { school: req.schoolId };
        if (req.query.employee) filter.employee = String(req.query.employee);
        if (req.query.type)     filter.type = String(req.query.type);
        // The ended ones, and the office's notes, are administrative.
        const everything = viewer.isAdmin && req.query.active === 'all';
        if (!everything) filter.isActive = true;

        const found = await EmployeeResponsibility.find(filter).sort({ createdAt: -1 }).lean();
        const today = startOfDay(new Date());
        const rows = everything ? found
            : found.filter((r) => !(isDate(r.toDate) && new Date(r.toDate) < today) && !(isDate(r.fromDate) && new Date(r.fromDate) > endOfDay(today)));
        const userIds = [...new Set(rows.map((r) => String(r.employee)))];
        const [users, classes, sections, subjects] = await Promise.all([
            userIds.length ? User.find({ _id: { $in: userIds }, school: req.schoolId }).select('name isActive').lean() : [],
            Class.find({ school: req.schoolId }).select('className').lean(),
            ClassSection.find({ school: req.schoolId }).select('sectionName class').lean(),
            Subject.find({ school: req.schoolId }).select('subjectName').lean(),
        ]);
        const shown = viewer.isAdmin ? users : users.filter((u) => u.isActive);
        const nameById    = new Map(shown.map((u) => [String(u._id), u.name]));
        const classById   = new Map(classes.map((c) => [String(c._id), c.className]));
        const sectionById = new Map(sections.map((s) => [String(s._id), s.sectionName]));
        const subjectById = new Map(subjects.map((s) => [String(s._id), s.subjectName]));

        ok(res, {
            responsibilities: rows
                // A responsibility whose employee has been deleted is dropped
                // rather than shown against a blank name.
                .filter((r) => nameById.has(String(r.employee)))
                .map((r) => ({
                    _id: String(r._id),
                    employee: String(r.employee),
                    employeeName: nameById.get(String(r.employee)) || '',
                    type: r.type,
                    label: trim(r.title) || RESPONSIBILITY_LABELS[r.type] || r.type,
                    department: r.department || '',
                    className: r.class ? (classById.get(String(r.class)) || '') : '',
                    sectionName: r.section ? (sectionById.get(String(r.section)) || '') : '',
                    subjectName: r.subject ? (subjectById.get(String(r.subject)) || '') : '',
                    fromDate: r.fromDate, toDate: r.toDate,
                    ...(viewer.isAdmin ? { notes: r.notes || '' } : {}),
                    isActive: r.isActive !== false,
                })),
            types: RESPONSIBILITY_TYPES.map((t) => ({ value: t, label: RESPONSIBILITY_LABELS[t] })),
        });
    } catch (e) { fail(res, e); }
};

/**
 * The fields of a responsibility, checked: every reference against the
 * caller's school (a borrowed id from another tenant cannot be attached), the
 * dates against each other. Returns `{ error }` or `{ fields }`.
 */
async function responsibilityFields(req, b, current = {}) {
    const fields = {};
    if (b.type !== undefined || !current.type) {
        if (!RESPONSIBILITY_TYPES.includes(trim(b.type))) return { error: 'Unknown responsibility type' };
        fields.type = trim(b.type);
    }
    if (b.title !== undefined)      fields.title = trim(b.title).slice(0, 80);
    if (b.department !== undefined) fields.department = trim(b.department).slice(0, 60);
    if (b.notes !== undefined)      fields.notes = trim(b.notes).slice(0, 300);
    for (const [key, Model] of [['class', Class], ['section', ClassSection], ['subject', Subject], ['academicYear', AcademicYear]]) {
        if (b[key] === undefined) continue;
        const id = trim(b[key]);
        if (!id) { fields[key] = null; continue; }
        const row = await Model.findOne({ _id: id, school: req.schoolId }).select('_id').lean().catch(() => null);
        if (!row) return { error: `The selected ${key} does not belong to this school` };
        fields[key] = id;
    }
    for (const [key, label] of [['fromDate', 'start date'], ['toDate', 'end date']]) {
        if (b[key] === undefined) continue;
        const d = dateFrom(b[key]);
        if (d === undefined) return { error: `The ${label} is not a valid date` };
        fields[key] = d;
    }
    const from = fields.fromDate !== undefined ? fields.fromDate : current.fromDate;
    const to   = fields.toDate !== undefined ? fields.toDate : current.toDate;
    if (isDate(from) && isDate(to) && startOfDay(to) < startOfDay(from)) return { error: 'The end date is before the start date' };
    const type = fields.type || current.type;
    const title = fields.title !== undefined ? fields.title : (current.title || '');
    if (type === 'other' && !title) return { error: 'Give this responsibility a title — "Other" says nothing by itself' };
    return { fields };
}

const scopeOf = (r) => [r.type, low(r.title), low(r.department), r.class || '', r.section || '', r.subject || ''].map(String).join('|');
const isCurrent = (r) => r.isActive !== false && !(isDate(r.toDate) && new Date(r.toDate) < startOfDay(new Date()));

/** The same post held twice, or a department with two heads. Returns a message or ''. */
async function responsibilityClash(req, candidate, selfId = null) {
    const others = (await EmployeeResponsibility.find({ school: req.schoolId, isActive: true }).lean())
        .filter((r) => String(r._id) !== String(selfId || '') && isCurrent(r));
    if (others.some((r) => String(r.employee) === String(candidate.employee) && scopeOf(r) === scopeOf(candidate))) {
        return 'This person already holds exactly that responsibility';
    }
    if (candidate.type === 'hod' && trim(candidate.department)) {
        const holder = others.find((r) => r.type === 'hod' && low(r.department) === low(candidate.department)
            && String(r.employee) !== String(candidate.employee));
        if (holder) {
            const u = await User.findById(String(holder.employee)).select('name').lean();
            return `${u?.name || 'Somebody else'} is already the HOD of ${trim(candidate.department)} — end that first`;
        }
    }
    return '';
}

exports.createResponsibility = async (req, res) => {
    try {
        const b = req.body || {};
        const employeeId = trim(b.employee);
        const employee = await User.findOne({ _id: employeeId, school: req.schoolId, role: 'teacher' }).select('name isActive').lean().catch(() => null);
        if (!employee) return fail(res, 'That employee does not belong to this school', 400);
        if (!employee.isActive) return fail(res, `${employee.name}'s account is deactivated — a responsibility cannot be given to them`, 400);

        const { fields, error } = await responsibilityFields(req, b);
        if (error) return fail(res, error, 400);
        const candidate = { employee: employeeId, title: '', department: '', ...fields };
        const clash = await responsibilityClash(req, candidate);
        if (clash) return fail(res, clash, 409);

        const created = await EmployeeResponsibility.create({
            school: req.schoolId,
            ...candidate,
            isActive: true,
            assignedBy: req.userId,
        });
        await audit(req, {
            actionType: 'ASSIGN_EMPLOYEE_RESPONSIBILITY',
            // Logged against the PERSON, so it shows in their history.
            entityId: employeeId,
            oldValue: null,
            newValue: { responsibility: String(created._id), employeeName: employee.name, type: candidate.type, title: candidate.title },
        });
        ok(res, { _id: String(created._id) }, 201);
    } catch (e) { fail(res, e); }
};

/** PUT /responsibilities/:id — change it, or end it (`{ end: true }` or a past `toDate`). */
exports.updateResponsibility = async (req, res) => {
    try {
        const row = await EmployeeResponsibility.findOne({ _id: String(req.params.id), school: req.schoolId }).lean().catch(() => null);
        if (!row) return fail(res, 'Responsibility not found', 404);
        const b = { ...(req.body || {}) };
        const ending = b.end === true || b.end === 'true';
        if (ending && b.toDate === undefined) b.toDate = new Date();

        const { fields, error } = await responsibilityFields(req, b, row);
        if (error) return fail(res, error, 400);
        const next = { ...row, ...fields };
        if (!ending && isCurrent(next)) {
            const clash = await responsibilityClash(req, next, row._id);
            if (clash) return fail(res, clash, 409);
        }
        await EmployeeResponsibility.findByIdAndUpdate(String(row._id), { $set: fields });
        await audit(req, {
            actionType: 'UPDATE_EMPLOYEE_RESPONSIBILITY',
            entityId: String(row.employee),
            oldValue: { type: row.type, title: row.title || '', department: row.department || '', toDate: row.toDate || null },
            newValue: { responsibility: String(row._id), type: next.type, title: next.title || '', ended: ending || !isCurrent(next) },
        });
        ok(res, { _id: String(row._id), ended: !isCurrent(next) });
    } catch (e) { fail(res, e); }
};

exports.removeResponsibility = async (req, res) => {
    try {
        const row = await EmployeeResponsibility.findOne({ _id: String(req.params.id), school: req.schoolId }).lean().catch(() => null);
        if (!row) return fail(res, 'Responsibility not found', 404);
        await EmployeeResponsibility.findByIdAndDelete(String(row._id));
        await audit(req, {
            actionType: 'REMOVE_EMPLOYEE_RESPONSIBILITY',
            entityId: String(row.employee),
            oldValue: { responsibility: String(row._id), type: row.type, title: row.title || '' },
            newValue: {},
        });
        ok(res, { removed: String(row._id) });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Reports — administrative only. Sensitive columns are never included, in any
//  format: an export cannot leak what the profile endpoint masks.
// ─────────────────────────────────────────────────────────────────────────────
const staffLabel = (r) => (r.staffType === 'teaching' ? 'Teaching' : 'Non-Teaching');
const statusLabel = (r) => STATUS_LABEL[r.employmentStatus] || '';

/** Whole years and months between two dates, as "4 y 2 m". */
function serviceOf(from, to = new Date()) {
    if (!isDate(from)) return { months: null, text: '' };
    const a = new Date(from); const b = new Date(to);
    let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) months -= 1;
    if (months < 0) return { months: null, text: '' };
    return { months, text: `${Math.floor(months / 12)} y ${months % 12} m` };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const REPORTS = {
    directory: {
        label: 'Employee Directory',
        columns: ['Employee ID', 'Name', 'Designation', 'Department', 'Type', 'Status', 'Joining Date', 'Subjects', 'Classes', 'Email', 'Phone'],
        build: (rows) => rows.map((r) => [
            r.employeeId, r.name, r.designation, r.department,
            staffLabel(r), statusLabel(r), fmtDate(r.joiningDate),
            r.subjects.join(', '), r.classes.map((c) => c.label).join(', '),
            r.officialEmail, r.officialPhone,
        ]),
    },
    'by-department': {
        label: 'Department-wise Employees',
        columns: ['Department', 'Employees', 'Active', 'Teaching', 'Non-Teaching'],
        build: (rows) => groupCount(rows, (r) => r.department),
    },
    'by-designation': {
        label: 'Designation-wise Employees',
        columns: ['Designation', 'Employees', 'Active', 'Teaching', 'Non-Teaching'],
        build: (rows) => groupCount(rows, (r) => r.designation),
    },
    'by-subject': {
        label: 'Subject-wise Teachers',
        columns: ['Subject', 'Teachers', 'Names'],
        build: (rows) => {
            // Counted by person, not by name: two teachers called the same
            // thing are two teachers.
            const m = new Map();
            for (const r of rows) for (const s of r.subjects) {
                if (!m.has(s)) m.set(s, new Map());
                m.get(s).set(r._id, r.name);
            }
            return [...m].sort((a, b) => a[0].localeCompare(b[0]))
                .map(([subject, people]) => [subject, people.size, [...people.values()].sort().join(', ')]);
        },
    },
    'by-class': {
        label: 'Class-wise Teachers',
        columns: ['Class / Section', 'Teachers', 'Class Teacher', 'Names'],
        build: (rows) => {
            const m = new Map();
            for (const r of rows) for (const a of r._assignments) {
                if (!a.sectionId) continue;
                if (!m.has(a.sectionId)) {
                    m.set(a.sectionId, {
                        label: `${a.className || 'Class'} ${a.sectionName || ''}`.trim(),
                        classNumber: a.classNumber, sectionName: a.sectionName || '', people: new Map(), classTeacher: '',
                    });
                }
                m.get(a.sectionId).people.set(r._id, r.name);
                if (a.role === 'class_teacher') m.get(a.sectionId).classTeacher = r.name;
            }
            // In class order (Nursery … Class 12), then section A–Z — never
            // "Class 10" ahead of "Class 2".
            return [...m.values()].sort((a, b) => byClass(a, b) || natural(a.sectionName, b.sectionName))
                .map((v) => [v.label, v.people.size, v.classTeacher, [...v.people.values()].sort().join(', ')]);
        },
    },
    'active-inactive': {
        label: 'Active / Inactive Employees',
        columns: ['Employee ID', 'Name', 'Designation', 'Status', 'Employment', 'Last Seen'],
        build: (rows) => rows.map((r) => [r.employeeId, r.name, r.designation, statusLabel(r), STAGE_LABEL[r.employmentStage] || '', fmtDate(r.lastSeenAt)]),
    },
    'new-joiners': {
        label: 'New Joiners',
        columns: ['Employee ID', 'Name', 'Designation', 'Department', 'Joining Date'],
        // The same people the "New joiners" tile counts: joined since the
        // working year began (buildRow's joinedThisYear).
        build: (rows) => rows
            .filter((r) => r.joinedThisYear)
            .sort((a, b) => new Date(b.joiningDate) - new Date(a.joiningDate))
            .map((r) => [r.employeeId, r.name, r.designation, r.department, fmtDate(r.joiningDate)]),
    },
    'service-length': {
        label: 'Length of Service',
        columns: ['Employee ID', 'Name', 'Designation', 'Department', 'Joining Date', 'Service', 'Months'],
        build: (rows) => rows
            .filter((r) => r.isActive && isDate(r.joiningDate))
            .map((r) => ({ r, s: serviceOf(r.joiningDate) }))
            .filter((x) => x.s.months !== null)
            .sort((a, b) => b.s.months - a.s.months)
            .map(({ r, s }) => [r.employeeId, r.name, r.designation, r.department, fmtDate(r.joiningDate), s.text, s.months]),
    },
    birthdays: {
        label: 'Birthdays',
        columns: ['Month', 'Day', 'Employee ID', 'Name', 'Designation', 'Department'],
        // The day and the month only — a list of birthdays has no use for the year.
        build: (rows) => rows
            .filter((r) => r.isActive && isDate(r._dob))
            .map((r) => ({ r, d: new Date(r._dob) }))
            .sort((a, b) => a.d.getMonth() - b.d.getMonth() || a.d.getDate() - b.d.getDate() || a.r.name.localeCompare(b.r.name))
            .map(({ r, d }) => [MONTHS[d.getMonth()], d.getDate(), r.employeeId, r.name, r.designation, r.department]),
    },
    'by-gender': {
        label: 'Gender-wise Employees',
        columns: ['Gender', 'Employees', 'Active', 'Teaching', 'Non-Teaching'],
        build: (rows) => groupCount(rows, (r) => r._gender, 'Not recorded'),
    },
    'by-qualification': {
        label: 'Qualification-wise Employees',
        columns: ['Highest Qualification', 'Employees', 'Active', 'Teaching', 'Non-Teaching'],
        build: (rows) => groupCount(rows, (r) => r._qualification, 'Not recorded'),
    },
    exits: {
        label: 'Exits',
        columns: ['Employee ID', 'Name', 'Designation', 'Department', 'Joining Date', 'Stage', 'Last Working Day', 'Service', 'Reason'],
        // Everyone serving notice or already gone, latest first.
        build: (rows) => rows
            .filter((r) => r.employmentStage === 'notice' || EXITED.has(r.employmentStage))
            .sort((a, b) => new Date(b.exitDate || 0) - new Date(a.exitDate || 0))
            .map((r) => [r.employeeId, r.name, r.designation, r.department, fmtDate(r.joiningDate),
                STAGE_LABEL[r.employmentStage], fmtDate(r.exitDate),
                serviceOf(r.joiningDate, isDate(r.exitDate) ? r.exitDate : new Date()).text, r._exitReason]),
    },
    'profile-completion': {
        label: 'Profile Completion',
        columns: ['Employee ID', 'Name', 'Completion %', 'Missing Fields'],
        build: (rows) => rows.filter((r) => r.isActive).sort((a, b) => a.profileCompletion - b.profileCompletion)
            .map((r) => [r.employeeId, r.name, r.profileCompletion, r.missingCount]),
    },
    'pending-verification': {
        label: 'Pending Verification',
        columns: ['Employee ID', 'Name', 'Designation', 'Department'],
        build: (rows) => rows.filter((r) => r.isActive && r.pendingVerification)
            .map((r) => [r.employeeId, r.name, r.designation, r.department]),
    },
    'missing-documents': {
        label: 'Documents Owed',
        columns: ['Employee ID', 'Name', 'Designation', 'Not Uploaded', 'To Upload Again'],
        // What the reminder desk chases, for the same people: a required
        // document missing, or any document rejected. ?owed=missing narrows it
        // to the first kind (the "Waiting on uploads" tab).
        build: (rows) => rows.filter((r) => r.isActive && r.missingDocumentCount > 0)
            .map((r) => [r.employeeId, r.name, r.designation, r.owedMissing.join(', '), r.owedRejected.join(', ')]),
    },
};

function fmtDate(d) {
    if (!isDate(d)) return '';
    const x = new Date(d);
    return `${String(x.getDate()).padStart(2, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${x.getFullYear()}`;
}

function groupCount(rows, get, blank = UNASSIGNED) {
    return bucket(rows, (r) => trim(get(r)) || blank)
        .map((g) => [
            g.label, g.rows.length,
            g.rows.filter((r) => r.isActive).length,
            g.rows.filter((r) => r.staffType === 'teaching').length,
            g.rows.filter((r) => r.staffType !== 'teaching').length,
        ])
        .sort((a, b) => b[1] - a[1]);
}

exports.listReports = (_req, res) => ok(res, {
    reports: Object.entries(REPORTS).map(([key, r]) => ({ key, label: r.label, columns: r.columns })),
});

// A cell that a spreadsheet would run as a formula is handed over as text.
const inert = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

exports.getReport = async (req, res) => {
    try {
        const def = REPORTS[String(req.params.type)];
        if (!def) return fail(res, 'Unknown report', 404);

        const { rows } = await collect(req);
        const scoped = rows.filter((r) => matches(r, req.query));
        const data = def.build(sortRows(scoped, req.query.sortBy || 'name', req.query.sortDir));

        const format = String(req.query.format || 'json').toLowerCase();
        if (format === 'json') {
            return ok(res, { key: req.params.type, label: def.label, columns: def.columns, rows: data, total: data.length });
        }
        if (!['csv', 'xlsx'].includes(format)) return fail(res, 'Unsupported export format', 400);

        // A file of staff names, phones and emails leaving the system is
        // written down like any other read of the record.
        await audit(req, {
            actionType: 'EXPORT_EMPLOYEE_REPORT', entityType: 'EmployeeReport', entityId: null,
            oldValue: null,
            newValue: {
                report: req.params.type, label: def.label, format, rows: data.length,
                filters: Object.fromEntries(Object.entries(req.query).filter(([k, v]) => v && k !== 'format').map(([k, v]) => [k, String(v).slice(0, 80)])),
            },
        });

        const sheet = data.map((r) => r.map(inert));
        const fileBase = `${def.label.replace(/[^\w]+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
        if (format === 'csv') {
            const esc = (v) => {
                const s = v == null ? '' : String(v);
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const csv = [def.columns, ...sheet].map((r) => r.map(esc).join(',')).join('\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
            return res.send('﻿' + csv);
        }
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([def.columns, ...sheet]), 'Report');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`);
        return res.send(buf);
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /employees/:id/profile.pdf — the record on paper, for a file or a
//  meeting. Government and bank numbers are printed MASKED, exactly as the
//  screen shows them; nothing here unmasks.
// ─────────────────────────────────────────────────────────────────────────────
exports.getProfilePdf = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        const found = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);
        const { user } = found;
        const p = found.profile || {};
        const uid = String(user._id);
        const vis = svc.visibilityFor(viewer, uid);
        const snap = await loadSnapshot(req.schoolId, { only: uid });
        const row = buildRow(user, snap);
        const sections = snap.verificationByTeacher.get(uid) || {};
        const docs = snap.docsByTeacher.get(uid)?.documents || [];

        await audit(req, {
            actionType: 'EXPORT_EMPLOYEE_PROFILE', entityId: uid, oldValue: null,
            newValue: { employeeName: user.name, format: 'pdf' },
        });

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ size: 'A4', margin: 44 });
        const safe = String(user.name || 'employee').replace(/[^\w]+/g, '-').toLowerCase();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safe}-profile.pdf"`);
        doc.pipe(res);

        const INK = '#111827'; const MUTED = '#6b7280'; const RULE = '#e5e7eb'; const ACCENT = '#4f46e5';
        const width = doc.page.width - 88;
        const say = (v) => (v === 0 || trim(v) ? String(v) : '—');
        const heading = (title) => {
            if (doc.y > doc.page.height - 120) doc.addPage();
            doc.moveDown(0.9).font('Helvetica-Bold').fontSize(11).fillColor(ACCENT).text(title.toUpperCase(), { characterSpacing: 0.6 });
            doc.moveTo(44, doc.y + 3).lineTo(44 + width, doc.y + 3).strokeColor(RULE).lineWidth(1).stroke();
            doc.moveDown(0.5);
        };
        const line = (label, value) => {
            if (doc.y > doc.page.height - 70) doc.addPage();
            const y = doc.y;
            doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, 44, y, { width: 150 });
            doc.font('Helvetica').fontSize(10).fillColor(INK).text(say(value), 200, y, { width: width - 156 });
            doc.moveDown(0.35);
        };
        const address = (prefix) => [p[`${prefix}Address`], p[`${prefix}City`], p[`${prefix}State`], p[`${prefix}Pincode`]].map(trim).filter(Boolean).join(', ');

        doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(req.user?.school?.name || 'School', { align: 'right' });
        doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(user.name || 'Employee', 44, doc.y - 4);
        doc.font('Helvetica').fontSize(10.5).fillColor(MUTED)
            .text([p.employeeId, row.designation, row.department].map(trim).filter(Boolean).join('  ·  ') || 'No employment details on file');
        doc.fontSize(9).text(`Profile ${row.profileCompletion}% complete  ·  ${statusLabel(row)}${row.employmentStage ? `  ·  ${STAGE_LABEL[row.employmentStage]}` : ''}`);

        heading('Employment');
        line('Employee ID', p.employeeId);
        line('Designation', row.designation);
        line('Department', row.department);
        line('Employee type', staffLabel(row));
        line('Date of joining', fmtDate(p.joiningDate));
        line('Service', serviceOf(p.joiningDate, isDate(p.exitDate) ? p.exitDate : new Date()).text);
        line('Reporting manager', row.reportingManager?.name);
        line('Fresher / experienced', p.employmentType === 'experienced' ? 'Experienced' : p.employmentType === 'fresher' ? 'Fresher' : '');
        if (p.employmentType === 'experienced') {
            line('Previous school', p.previousSchool);
            line('Last designation', p.lastDesignation);
        }
        if (p.employmentStage) line('Employment stage', STAGE_LABEL[p.employmentStage]);
        if (isDate(p.probationEndDate)) line('Probation ends', fmtDate(p.probationEndDate));
        if (isDate(p.confirmationDate)) line('Confirmed on', fmtDate(p.confirmationDate));
        if (isDate(p.exitDate)) { line('Last working day', fmtDate(p.exitDate)); line('Reason', p.exitReason); }

        heading('Teaching load');
        line('Subjects', row.subjects.join(', '));
        line('Classes & sections', row.classes.map((c) => c.label).join(', '));
        line('Class teacher of', row.classTeacherOf.join(', '));
        line('Responsibilities', row.responsibilities.map((r) => (r.department ? `${r.label} (${r.department})` : r.label)).join(', '));

        heading('Personal');
        line('Date of birth', fmtDate(p.dob));
        line('Gender', p.gender);
        line('Blood group', p.bloodGroup);
        line("Father's / husband's name", p.fatherOrHusbandName);
        line('Emergency contact', [p.emergencyContactName, p.emergencyContactPhone].map(trim).filter(Boolean).join(' · '));

        heading('Contact');
        line('Mobile', user.phone);
        line('Secondary phone', p.alternatePhone);
        line('Email', user.email);
        line('Current address', address('current'));
        line('Permanent address', address('permanent'));

        heading('Education');
        line('Highest qualification', p.qualification);
        line('Teaching degree', p.teachingDegree);
        for (const q of (Array.isArray(p.qualifications) ? p.qualifications : [])) {
            line(trim(q?.qualification) || 'Qualification',
                [q?.specialization, q?.institution, q?.passingYear, q?.grade].map((v) => trim(v)).filter(Boolean).join(' · '));
        }

        heading('Government ID (masked)');
        line('Aadhaar number', svc.maskAadhaar(p.aadhaarNumber));
        line('PAN number', svc.maskPan(p.panNumber));
        line('UAN / PF number', svc.maskUan(p.uanNumber));

        if (vis.bank) {
            heading('Bank (masked)');
            line('Account holder', p.bankAccountHolder);
            line('Account number', svc.maskAccount(p.bankAccountNumber));
            line('IFSC', p.bankIfsc);
            line('Branch', p.bankBranch);
        }

        heading('Verification');
        for (const s of VERIFICATION_SECTIONS) {
            const v = sections[s];
            line(VERIFICATION_LABELS[s], v?.status === 'verified' ? `Verified ${fmtDate(v.verifiedAt)}` : v?.status === 'rejected' ? 'Rejected' : 'Pending');
        }

        heading('Documents');
        const docWords = { missing: 'Not uploaded', pending: 'Awaiting review', resubmitted: 'Re-submitted', verified: 'Verified', rejected: 'Rejected' };
        for (const d of docs.filter((x) => x.fileName || x.required)) {
            if (d.gate === 'bank' && !vis.bank) continue;
            line(d.label, docWords[d.state] || d.state);
        }

        doc.moveDown(1.2).font('Helvetica').fontSize(8).fillColor(MUTED)
            .text(`Generated ${fmtDate(new Date())} from the Employee Directory. Government ID and bank numbers are masked. Confidential — for the school office.`, 44, doc.y, { width });
        doc.end();
        return undefined;
    } catch (e) {
        if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return undefined; }
        return fail(res, e);
    }
};

// Exported for scripts that check the read model.
exports._internal = { loadSnapshot, buildRow, matches, sortRows, REPORTS, sectionProblem, queryFor };
