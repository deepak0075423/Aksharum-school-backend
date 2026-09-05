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

const {
    User, TeacherProfile, ClassSection, Class, Subject, SectionSubjectTeacher,
    AcademicYear, Timetable, TimetableEntry, Room, TeacherAttendance,
    LeaveApplication, LeaveBalance, LeaveType, EmployeeSalaryAssignment,
    EmployeeResponsibility, EmployeeVerification,
} = svc.models;

const { low, trim, pct } = svc;

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

// Which uploaded files back each verification section. A section that has slots
// but no files has nothing to review — see setVerification.
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

// ─────────────────────────────────────────────────────────────────────────────
//  Snapshot — one school-scoped read of everything the list view needs.
//
//  Search and filtering span User (name/email/phone), TeacherProfile
//  (employee id / designation / department) and the assignment tables
//  (subject / class / section), so no single indexed WHERE can answer them.
//  The set is bounded by one school's staff, so it is assembled once per
//  request and then filtered, sorted and PAGED IN THE SERVICE — the client
//  only ever receives one page.
// ─────────────────────────────────────────────────────────────────────────────
async function loadSnapshot(schoolId) {
    const [users, activeYear] = await Promise.all([
        User.find({ school: schoolId, role: 'teacher' })
            .select('name email phone profileImage profileIcon isActive lastSeenAt createdAt')
            .lean(),
        AcademicYear.findOne({ school: schoolId, status: 'active' }).lean(),
    ]);
    const userIds = users.map((u) => String(u._id));
    const userById = new Map(users.map((u) => [String(u._id), u]));

    const yearFilter = activeYear ? { academicYear: activeYear._id } : {};
    const [profiles, sections, classes, subjects, responsibilities, verifications] = await Promise.all([
        TeacherProfile.find({ school: schoolId }).lean(),
        ClassSection.find({ school: schoolId, ...yearFilter }).lean(),
        Class.find({ school: schoolId, ...yearFilter }).lean(),
        // Scoped like the classes and sections above — subjects are per-year.
        Subject.find({ school: schoolId, ...yearFilter }).lean(),
        EmployeeResponsibility.find({ school: schoolId, isActive: true }).lean(),
        EmployeeVerification.find({ school: schoolId }).lean(),
    ]);

    const sectionById = new Map(sections.map((s) => [String(s._id), s]));
    const classById   = new Map(classes.map((c) => [String(c._id), c]));
    const subjectById = new Map(subjects.map((s) => [String(s._id), s]));

    // Subject teaching assignments, restricted to this school's sections.
    const sstRows = sections.length
        ? await SectionSubjectTeacher.find({ section: { $in: sections.map((s) => String(s._id)) } }).lean()
        : [];

    // Leave covering today — the only status the ERP derives rather than stores.
    const today = new Date();
    const onLeaveRows = await LeaveApplication.find({
        school: schoolId,
        status: 'approved',
        fromDate: { $lte: endOfDay(today) },
        toDate:   { $gte: startOfDay(today) },
    }).select('teacher').lean();
    const onLeaveToday = new Set(onLeaveRows.map((r) => String(r.teacher)));

    // Only profiles whose user still exists and belongs to this school.
    const profileByUser = new Map();
    for (const p of profiles) {
        const uid = String(p.user);
        if (userById.has(uid)) profileByUser.set(uid, p);
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

    const responsibilitiesByTeacher = new Map();
    for (const r of responsibilities) {
        const k = String(r.employee);
        if (!userById.has(k)) continue;
        if (!responsibilitiesByTeacher.has(k)) responsibilitiesByTeacher.set(k, []);
        const cls = r.class ? classById.get(String(r.class)) : null;
        const sec = r.section ? sectionById.get(String(r.section)) : null;
        responsibilitiesByTeacher.get(k).push({
            _id: String(r._id),
            type: r.type,
            label: trim(r.title) || RESPONSIBILITY_LABELS[r.type] || r.type,
            department: r.department || '',
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

    return {
        activeYear, users, userIds, userById, profileByUser,
        sections, classes, subjects, sectionById, classById, subjectById,
        assignmentsByTeacher, responsibilitiesByTeacher, verificationByTeacher,
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
    const u = snap.userById.get(key);
    if (!u) return null;
    const p = snap.profileByUser.get(key) || {};
    return {
        _id: key,
        name: u.name,
        designation: p.designation || '',
        department: p.department || '',
        employeeId: p.employeeId || '',
        profileImage: u.profileImage || '',
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

    const completion = svc.computeCompletion(user, p);
    const verification = snap.verificationByTeacher.get(uid) || {};
    const pendingVerification = VERIFICATION_SECTIONS.some((s) => (verification[s]?.status || 'pending') !== 'verified');

    return {
        _id: uid,
        name: user.name,
        profileImage: user.profileImage || '',
        profileIcon: user.profileIcon || '',
        employeeId: p.employeeId || '',
        designation: p.designation || '',
        department: p.department || '',
        staffType, staffTypeSource,
        employmentStatus: statusOf(user, snap.onLeaveToday),
        isActive: !!user.isActive,
        joiningDate: p.joiningDate || null,
        joiningYear: yearOf(p.joiningDate),
        officialEmail: user.email,
        officialPhone: user.phone || '',
        employmentType: p.employmentType || '',
        subjects: subjectNames,
        classes: [...classKeys.values()],
        classTeacherOf,
        isClassTeacher: classTeacherOf.length > 0,
        responsibilities: snap.responsibilitiesByTeacher.get(uid) || [],
        // Who someone reports to is org-chart information, so it is resolved to
        // a name for every tier rather than left as an id only admins can look up.
        reportingManagerId: p.reportingManager ? String(p.reportingManager) : '',
        reportingManager: resolvePerson(snap, p.reportingManager),
        profileCompletion: completion.percent,
        missingCount: completion.missing.length,
        missingDocumentCount: completion.missingDocuments.length,
        pendingVerification,
        lastSeenAt: user.lastSeenAt || null,
        // Kept off the wire, used by search / filters only.
        _search: [
            user.name, user.email, user.phone, p.employeeId, p.designation, p.department,
            ...subjectNames, ...[...classKeys.values()].map((c) => c.label),
        ].map(low).join(' '),
        _assignments: assignments,
    };
}

/**
 * Strip a row down to the tier the viewer is entitled to.
 *
 * A teacher with normal access is looking colleagues up, not administering
 * them, so the row is cut to what that actually needs: who they are, what they
 * teach, and how to reach them. Employment facts — staff classification, joining
 * date, account status, profile completeness, verification state — are dropped
 * from the object, not flagged, so they are never serialised at all.
 */
function projectRow(row, viewer) {
    const vis = svc.visibilityFor(viewer, row._id);
    const { _search, _assignments, ...rest } = row;
    if (vis.personal) return { ...rest, canViewProfile: true };
    return {
        _id: rest._id,
        name: rest.name,
        profileImage: rest.profileImage,
        profileIcon: rest.profileIcon,
        employeeId: rest.employeeId,
        designation: rest.designation,
        department: rest.department,
        officialEmail: rest.officialEmail,
        officialPhone: rest.officialPhone,
        subjects: rest.subjects,
        classes: rest.classes,
        classTeacherOf: rest.classTeacherOf,
        isClassTeacher: rest.isClassTeacher,
        responsibilities: rest.responsibilities,
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
    if (q.department   && low(row.department)   !== low(q.department))   return false;
    if (q.designation  && low(row.designation)  !== low(q.designation))  return false;
    if (q.staffType    && row.staffType         !== q.staffType)         return false;
    if (q.employmentType && row.employmentType  !== q.employmentType)    return false;
    if (q.status       && row.employmentStatus  !== q.status)            return false;
    // Account state, which is NOT the `status` above: a teacher on approved
    // leave today reads as 'on_leave' there while their account is perfectly
    // active. 'all' (or omitting it) keeps everyone.
    if (q.accountStatus === 'active'   && row.isActive === false) return false;
    if (q.accountStatus === 'inactive' && row.isActive !== false) return false;
    if (q.joiningYear  && String(row.joiningYear || '') !== String(q.joiningYear)) return false;
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
    return true;
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

// ─────────────────────────────────────────────────────────────────────────────
//  GET /meta — filter options plus what this caller may do.
// ─────────────────────────────────────────────────────────────────────────────
exports.getMeta = async (req, res) => {
    try {
        const { viewer, snap, rows } = await collect(req);
        const uniq = (vals) => [...new Set(vals.map(trim).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        // Administrative filters key on fields a normal directory user never
        // receives, so they are not offered to one.
        const admin = viewer.isAdmin;

        ok(res, {
            viewer: {
                level: viewer.level,
                isAdmin: viewer.isAdmin,
                canViewPayroll: viewer.payrollAdmin,
                canReveal: viewer.isAdmin,
                designation: viewer.designation,
                userId: viewer.userId,
            },
            modules: viewer.modules,
            academicYear: snap.activeYear ? { _id: String(snap.activeYear._id), yearName: snap.activeYear.yearName } : null,
            filters: {
                departments:  uniq(rows.map((r) => r.department)),
                designations: uniq(rows.map((r) => r.designation)),
                joiningYears: admin
                    ? [...new Set(rows.map((r) => r.joiningYear).filter(Boolean))].sort((a, b) => b - a)
                    : [],
                staffTypes: admin
                    ? [{ value: 'teaching', label: 'Teaching' }, { value: 'non_teaching', label: 'Non-Teaching' }]
                    : [],
                employmentTypes: admin
                    ? [{ value: 'fresher', label: 'Fresher' }, { value: 'experienced', label: 'Experienced' }]
                    : [],
                statuses: admin ? [
                    { value: 'active', label: 'Active' },
                    { value: 'on_leave', label: 'On Leave' },
                    { value: 'inactive', label: 'Inactive' },
                ] : [],
                classes: snap.classes
                    .map((c) => ({ _id: String(c._id), label: c.className, classNumber: c.classNumber }))
                    .sort((a, b) => (a.classNumber ?? 0) - (b.classNumber ?? 0)),
                sections: snap.sections.map((s) => ({
                    _id: String(s._id),
                    classId: String(s.class),
                    label: `${snap.classById.get(String(s.class))?.className || 'Class'} ${s.sectionName}`.trim(),
                })),
                subjects: snap.subjects
                    .map((s) => ({ _id: String(s._id), label: s.subjectName }))
                    .sort((a, b) => a.label.localeCompare(b.label)),
                // Only administrators pick a reporting manager, but the list is
                // just names already visible in the directory.
                managers: admin
                    ? rows.map((r) => ({ _id: r._id, label: r.name, designation: r.designation }))
                        .sort((a, b) => a.label.localeCompare(b.label))
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

        const byKey = (get) => {
            const m = new Map();
            for (const r of rows) {
                const k = trim(get(r)) || 'Unassigned';
                m.set(k, (m.get(k) || 0) + 1);
            }
            return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
        };

        const recentCutoff = new Date();
        recentCutoff.setMonth(recentCutoff.getMonth() - 3);

        // Anyone who joined on or after the active year began. The overview
        // reports the school's own year rather than a rolling three months —
        // "new this year" is the number an admin is actually asked for.
        const yearStart = isDate(snap.activeYear?.startDate) ? new Date(snap.activeYear.startDate) : null;
        const joinedThisYear = yearStart
            ? rows.filter((r) => isDate(r.joiningDate) && new Date(r.joiningDate) >= yearStart)
            : [];
        // Headcount before this year began, and the growth since. Derived from
        // joining dates only, so it counts arrivals and cannot see departures —
        // the client says "new this year", never "turnover".
        const carriedOver = rows.length - joinedThisYear.length;
        const growthPct = carriedOver > 0
            ? Math.round((joinedThisYear.length / carriedOver) * 1000) / 10
            : null;

        // Three buckets rather than one average: an average of 24% hides whether
        // that is everyone half-done or most people not started.
        const complete   = rows.filter((r) => r.profileCompletion >= 100).length;
        const notStarted = rows.filter((r) => r.profileCompletion < 25).length;

        ok(res, {
            totals: {
                employees: rows.length,
                active:    rows.filter((r) => r.employmentStatus === 'active').length,
                inactive:  rows.filter((r) => !r.isActive).length,
                onLeave:   rows.filter((r) => r.employmentStatus === 'on_leave').length,
                teaching:     rows.filter((r) => r.staffType === 'teaching').length,
                nonTeaching:  rows.filter((r) => r.staffType === 'non_teaching').length,
                incompleteProfiles:  rows.filter((r) => r.profileCompletion < 100).length,
                pendingVerification: rows.filter((r) => r.pendingVerification).length,
                documentsNeedAttention: rows.filter((r) => r.missingDocumentCount > 0).length,
                classTeachers: rows.filter((r) => r.isClassTeacher).length,
                newJoiners: rows.filter((r) => isDate(r.joiningDate) && new Date(r.joiningDate) >= recentCutoff).length,
                newThisYear: joinedThisYear.length,
            },
            growthPct,
            completionBuckets: {
                complete,
                notStarted,
                inProgress: rows.length - complete - notStarted,
            },
            // The newest arrivals, newest first. Someone with no joining date on
            // file has nothing to be recent by, so they are left out rather than
            // sorted to one end of a list titled "recently joined".
            recentEmployees: rows
                .filter((r) => isDate(r.joiningDate))
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
            averageCompletion: rows.length
                ? Math.round((rows.reduce((s, r) => s + r.profileCompletion, 0) / rows.length) * 10) / 10
                : 0,
            lowestCompletion: [...rows]
                .sort((a, b) => a.profileCompletion - b.profileCompletion)
                .slice(0, 5)
                .map((r) => ({ _id: r._id, name: r.name, employeeId: r.employeeId, percent: r.profileCompletion })),
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
function headcounts(rows, activeYear) {
    const yearStart = isDate(activeYear?.startDate) ? new Date(activeYear.startDate) : null;
    const newThisYear = yearStart
        ? rows.filter((r) => isDate(r.joiningDate) && new Date(r.joiningDate) >= yearStart).length
        : 0;
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
        const { viewer, snap, rows } = await collect(req);
        const page  = Math.max(1, Number(req.query.page) || 1);
        // The UI offers 10 / 25 / 50 / 100. Anything else is clamped rather than
        // rejected, so a caller can never talk the server into returning the
        // whole staff table in one response.
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

        const filtered = rows.filter((r) => matches(r, req.query));
        const sorted   = sortRows(filtered, req.query.sortBy, req.query.sortDir);
        const pageRows = sorted.slice((page - 1) * limit, page * limit);

        ok(res, {
            employees: pageRows.map((r) => projectRow(r, viewer)),
            total: filtered.length,
            page, limit,
            pages: Math.max(1, Math.ceil(filtered.length / limit)),
            grandTotal: rows.length,
            stats: headcounts(rows, snap.activeYear),
            viewer: { level: viewer.level, isAdmin: viewer.isAdmin, userId: viewer.userId },
        });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Employee lookup — the single place a :id is turned into a record.
//  Returns null for an id that is not a teacher of the caller's school, which
//  every caller below turns into a 404. This is the IDOR guard.
// ─────────────────────────────────────────────────────────────────────────────
async function findEmployee(req) {
    const id = String(req.params.id || '');
    if (!id) return null;
    const user = await User.findOne({ _id: id, school: req.schoolId, role: 'teacher' })
        .select('name email phone profileImage profileIcon isActive lastSeenAt createdAt')
        .lean()
        .catch(() => null);
    if (!user) return null;
    const profile = await TeacherProfile.findOne({ user: id, school: req.schoolId }).lean();
    return { user, profile: profile || null };
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /employees/:id — the full profile, cut to the viewer's tier.
// ─────────────────────────────────────────────────────────────────────────────
exports.getEmployee = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        const found  = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);

        const { user, profile } = found;
        const p   = profile || {};
        const vis = svc.visibilityFor(viewer, user._id);
        const snap = await loadSnapshot(req.schoolId);
        const row  = buildRow(user, snap);

        const verificationRows = await EmployeeVerification.find({ school: req.schoolId, employee: String(user._id) }).lean();
        const verifierIds = [...new Set(verificationRows.map((v) => v.verifiedBy).filter(Boolean).map(String))];
        const verifiers = verifierIds.length
            ? await User.find({ _id: { $in: verifierIds } }).select('name').lean()
            : [];
        const verifierName = new Map(verifiers.map((u) => [String(u._id), u.name]));
        const verificationBySection = {};
        for (const v of verificationRows) {
            verificationBySection[v.section] = { ...v, verifiedByName: verifierName.get(String(v.verifiedBy)) || '' };
        }

        const manager = row.reportingManager;

        const out = {
            viewer: {
                level: viewer.level,
                isAdmin: viewer.isAdmin,
                isSelf: vis.self,
                canViewPayroll: viewer.payrollAdmin,
                canReveal: vis.canReveal,
            },
            visibility: {
                personal: vis.personal, contact: vis.contactFull, employment: vis.employmentFull,
                education: vis.educationDocs, attendance: vis.attendance, leave: vis.leave,
                documents: vis.documents, governmentId: vis.governmentId, bank: vis.bank,
                payroll: vis.payroll, completion: vis.completion,
            },
            modules: viewer.modules,

            // ── Overview — professional information, everyone in the directory
            overview: {
                _id: String(user._id),
                name: user.name,
                profileImage: user.profileImage || '',
                profileIcon: user.profileIcon || '',
                employeeId: p.employeeId || '',
                teacherId: p.employeeId || '',
                designation: p.designation || '',
                department: p.department || '',
                staffType: row.staffType,
                staffTypeSource: row.staffTypeSource,
                employmentStatus: row.employmentStatus,
                isActive: !!user.isActive,
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
                lastSeenAt: user.lastSeenAt || null,
            },
            subjectsClasses: {
                academicYear: snap.activeYear?.yearName || '',
                assignments: row._assignments.map((a) => ({
                    role: a.role,
                    roleLabel: a.role === 'class_teacher' ? 'Class Teacher'
                        : a.role === 'vice_class_teacher' ? 'Vice Class Teacher' : 'Subject Teacher',
                    subject: a.subjectName,
                    className: a.className,
                    sectionName: a.sectionName,
                    sectionId: a.sectionId,
                    classId: a.classId,
                })),
            },
            responsibilities: row.responsibilities,
            verification: VERIFICATION_SECTIONS.map((s) => {
                const v = verificationBySection[s];
                return {
                    section: s,
                    label: VERIFICATION_LABELS[s],
                    status: v?.status || 'pending',
                    note: v?.note || '',
                    verifiedBy: v?.verifiedByName || '',
                    verifiedAt: v?.verifiedAt || null,
                    expiresAt: v?.expiresAt || null,
                };
            }),
        };

        // Education is professional information; the certificates behind it are not.
        out.education = {
            qualifications: [
                ...(trim(p.qualification) ? [{
                    qualification: p.qualification, kind: 'highest', specialization: '',
                    institution: '', passingYear: null, grade: '',
                    certificate: '', verificationStatus: verificationBySection.education?.status || 'pending',
                }] : []),
                ...(trim(p.teachingDegree) ? [{
                    qualification: p.teachingDegree, kind: 'teaching_degree', specialization: '',
                    institution: '', passingYear: null, grade: '',
                    certificate: '', verificationStatus: verificationBySection.education?.status || 'pending',
                }] : []),
            ],
            // The employee record stores one highest qualification and one
            // teaching degree. The shape above is a list so additional
            // qualifications can be added later without changing this contract.
            supportsMultiple: false,
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
            designation: p.designation || '',
            department: p.department || '',
            staffType: row.staffType,
            employmentStatus: row.employmentStatus,
            reportingManager: manager,
            // Campus / branch has no entity in this ERP; the School row is the tenant.
            campus: null,
            ...(vis.employmentFull ? {
                employmentType: p.employmentType || '',
                totalExperience: p.totalExperience || p.experience || '',
                previousSchool: p.previousSchool || '',
                lastDesignation: p.lastDesignation || '',
            } : {}),
        };

        if (vis.documents) {
            const docs = svc.buildDocuments(p, verificationBySection);
            out.documents = docs.map((d) => ({ ...d, url: d.sensitive && !vis.governmentId ? '' : d.url }))
                .filter((d) => !d.sensitive || vis.governmentId);
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
                .findOne({ employee: String(user._id), school: req.schoolId, isActive: true }).lean();
            out.payroll = assign ? {
                annualCtc: assign.ctc || 0,
                effectiveDate: assign.effectiveDate || null,
                revisions: (assign.ctcRevisions || []).length,
            } : null;
        }

        if (vis.completion) out.profileCompletion = svc.computeCompletion(user, p);

        ok(res, out);
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  POST /employees/:id/reveal — one unmasked value, audited.
//  Guarded by requireModuleAdmin('employeeDirectory') at the route, and again
//  here for the payroll-owned fields.
// ─────────────────────────────────────────────────────────────────────────────
exports.revealField = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        const found  = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);

        const field = trim(req.body?.field);
        const def   = svc.REVEALABLE[field];
        if (!def) return fail(res, 'That field cannot be revealed', 400);

        const vis = svc.visibilityFor(viewer, found.user._id);
        if (def.gate === 'bank' && !vis.bank) {
            return fail(res, 'Administrative access to the payroll module is required to see bank details', 403);
        }
        if (def.gate === 'governmentId' && !vis.governmentId) {
            return fail(res, 'You do not have access to government ID information', 403);
        }

        const value = trim(found.profile?.[field]);
        if (!value) return fail(res, 'Not on file', 404);

        // The log records THAT a value was read, never the value itself.
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
                viewerRole: viewer.role,
                viewerDesignation: viewer.designation,
                ip: req.ip || '',
                userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
                at: new Date().toISOString(),
            },
        }).catch(() => {});

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
        const found = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);

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
                teacher: String(found.user._id),
            }).lean()
            : [];

        const subjectIds = [...new Set(entries.map((e) => String(e.subject)).filter(Boolean))];
        const roomIds    = [...new Set(entries.map((e) => e.room).filter(Boolean).map(String))];
        const [subjects, rooms] = await Promise.all([
            subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select('subjectName').lean() : [],
            roomIds.length    ? Room.find({ _id: { $in: roomIds } }).select('roomName roomNumber').lean() : [],
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

        // Free periods are read from the section's own period structure, so the
        // directory never re-derives a school day of its own.
        const maxPeriods = Math.max(0, ...timetables.map((t) => (t.periodsStructure || []).length));
        const freeByDay = Object.fromEntries(DAYS.map((d) => {
            const busy = new Set(week[d].map((p) => p.periodNumber));
            const free = [];
            for (let i = 1; i <= maxPeriods; i += 1) if (!busy.has(i)) free.push(i);
            return [d, free];
        }));

        const todayName = DAYS[(new Date().getDay() + 6) % 7] || '';
        ok(res, {
            academicYear: activeYear?.yearName || '',
            days: DAYS,
            week,
            today: { day: todayName, periods: week[todayName] || [] },
            freePeriods: freeByDay,
            totalPeriodsPerWeek: entries.length,
            maxPeriods,
        });
    } catch (e) { fail(res, e); }
};

exports.getAttendance = async (req, res) => {
    try {
        const viewer = await svc.resolveViewer(req);
        const found  = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);
        const vis = svc.visibilityFor(viewer, found.user._id);
        if (!vis.attendance) return fail(res, 'You do not have access to attendance information', 403);
        if (!viewer.modules.attendance) return fail(res, 'The attendance module is not enabled for your school', 403);

        const now  = new Date();
        const from = req.query.from ? new Date(req.query.from) : new Date(now.getFullYear(), now.getMonth() - 5, 1);
        const to   = req.query.to   ? new Date(req.query.to)   : now;

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
            range: { from, to },
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
        const found  = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);
        const vis = svc.visibilityFor(viewer, found.user._id);
        if (!vis.leave) return fail(res, 'You do not have access to leave information', 403);
        if (!viewer.modules.leave) return fail(res, 'The leave module is not enabled for your school', 403);

        const teacherId = String(found.user._id);
        const [applications, balances, types] = await Promise.all([
            LeaveApplication.find({ teacher: teacherId, school: req.schoolId }).lean(),
            LeaveBalance.find({ teacher: teacherId, school: req.schoolId }).lean(),
            LeaveType.find({ school: req.schoolId }).select('name code').lean(),
        ]);
        const typeName = new Map(types.map((t) => [String(t._id), t.name]));
        const today = startOfDay(new Date());

        const approved = applications.filter((a) => a.status === 'approved');
        ok(res, {
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
            upcoming: approved
                .filter((a) => new Date(a.fromDate) >= today)
                .sort((a, b) => new Date(a.fromDate) - new Date(b.fromDate))
                .slice(0, 5)
                .map((a) => ({
                    leaveType: typeName.get(String(a.leaveType)) || '',
                    fromDate: a.fromDate, toDate: a.toDate, totalDays: a.totalDays, status: a.status,
                })),
            recent: [...applications]
                .sort((a, b) => new Date(b.fromDate) - new Date(a.fromDate))
                .slice(0, 10)
                .map((a) => ({
                    leaveType: typeName.get(String(a.leaveType)) || '',
                    fromDate: a.fromDate, toDate: a.toDate, totalDays: a.totalDays, status: a.status,
                })),
        });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Departments — derived from TeacherProfile.department, the field the employee
//  record already carries. No department master is created.
// ─────────────────────────────────────────────────────────────────────────────
exports.getDepartments = async (req, res) => {
    try {
        const { rows } = await collect(req);
        const byName = new Map();
        for (const r of rows) {
            const name = trim(r.department) || 'Unassigned';
            if (!byName.has(name)) byName.set(name, { name, total: 0, active: 0, teaching: 0, nonTeaching: 0, designations: new Set(), members: [] });
            const d = byName.get(name);
            d.total += 1;
            if (r.employmentStatus === 'active') d.active += 1;
            if (r.staffType === 'teaching') d.teaching += 1; else d.nonTeaching += 1;
            if (r.designation) d.designations.add(r.designation);
            d.members.push({ _id: r._id, name: r.name, designation: r.designation, employeeId: r.employeeId });
        }
        ok(res, {
            departments: [...byName.values()]
                .map((d) => ({ ...d, designations: [...d.designations].sort(), members: d.members.sort((a, b) => a.name.localeCompare(b.name)) }))
                .sort((a, b) => (a.name === 'Unassigned' ? 1 : b.name === 'Unassigned' ? -1 : b.total - a.total)),
        });
    } catch (e) { fail(res, e); }
};

exports.getDesignations = async (req, res) => {
    try {
        const { rows } = await collect(req);
        const byName = new Map();
        for (const r of rows) {
            const name = trim(r.designation) || 'Unassigned';
            if (!byName.has(name)) byName.set(name, { name, total: 0, active: 0, members: [] });
            const d = byName.get(name);
            d.total += 1;
            if (r.employmentStatus === 'active') d.active += 1;
            d.members.push({ _id: r._id, name: r.name, department: r.department, employeeId: r.employeeId });
        }
        ok(res, { designations: [...byName.values()].sort((a, b) => b.total - a.total) });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /org-structure — the reporting tree, with the designation/department
//  grouping the ERP already has as the fallback shape.
// ─────────────────────────────────────────────────────────────────────────────
exports.getOrgStructure = async (req, res) => {
    try {
        const { rows } = await collect(req);
        const byId = new Map(rows.map((r) => [r._id, r]));

        const node = (r) => ({
            _id: r._id, name: r.name, designation: r.designation, department: r.department,
            employeeId: r.employeeId, profileImage: r.profileImage, staffType: r.staffType,
            employmentStatus: r.employmentStatus, children: [],
        });
        const nodes = new Map(rows.map((r) => [r._id, node(r)]));
        const roots = [];
        for (const r of rows) {
            const parentId = r.reportingManagerId;
            // A manager who left, or a cycle of one, falls back to a root.
            if (parentId && parentId !== r._id && nodes.has(parentId)) nodes.get(parentId).children.push(nodes.get(r._id));
            else roots.push(nodes.get(r._id));
        }
        // Guard against a longer cycle: anything unreachable from a root is
        // promoted rather than lost.
        const seen = new Set();
        const walk = (n, depth = 0) => {
            if (seen.has(n._id) || depth > 20) return;
            seen.add(n._id);
            n.children.sort((a, b) => a.name.localeCompare(b.name));
            n.children.forEach((c) => walk(c, depth + 1));
        };
        roots.sort((a, b) => a.name.localeCompare(b.name));
        roots.forEach((r) => walk(r));
        for (const r of rows) if (!seen.has(r._id)) { roots.push(nodes.get(r._id)); walk(nodes.get(r._id)); }

        const byDepartment = new Map();
        for (const r of rows) {
            const dep = trim(r.department) || 'Unassigned';
            if (!byDepartment.has(dep)) byDepartment.set(dep, new Map());
            const desigs = byDepartment.get(dep);
            const desig = trim(r.designation) || 'Unassigned';
            if (!desigs.has(desig)) desigs.set(desig, []);
            desigs.get(desig).push({ _id: r._id, name: r.name, employeeId: r.employeeId });
        }

        ok(res, {
            hasReportingLines: rows.some((r) => r.reportingManagerId && byId.has(r.reportingManagerId)),
            tree: roots,
            byDepartment: [...byDepartment].map(([department, desigs]) => ({
                department,
                designations: [...desigs].map(([designation, members]) => ({ designation, members })),
                total: [...desigs.values()].reduce((s, m) => s + m.length, 0),
            })).sort((a, b) => b.total - a.total),
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

exports.updateEmployment = async (req, res) => {
    try {
        const found = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);
        if (!found.profile) return fail(res, 'This employee has no profile record yet', 400);

        const patch = {};
        const before = {};
        const b = req.body || {};

        if (b.department !== undefined) {
            patch.department = trim(b.department);
            before.department = found.profile.department || '';
        }
        if (b.staffType !== undefined) {
            const v = trim(b.staffType);
            if (!['teaching', 'non_teaching', ''].includes(v)) return fail(res, 'Invalid staff type', 400);
            patch.staffType = v;
            before.staffType = found.profile.staffType || '';
        }
        if (b.reportingManager !== undefined) {
            const managerId = trim(b.reportingManager);
            if (managerId) {
                if (managerId === String(found.user._id)) return fail(res, 'An employee cannot report to themselves', 400);
                const manager = await User.findOne({ _id: managerId, school: req.schoolId, role: 'teacher' }).select('_id').lean();
                if (!manager) return fail(res, 'That reporting manager is not an employee of this school', 400);
                // Walk up the existing chain so a new edge cannot close a loop.
                let cursor = managerId; let hops = 0;
                while (cursor && hops < 50) {
                    if (cursor === String(found.user._id)) return fail(res, 'That would create a reporting loop', 400);
                    const up = await TeacherProfile.findOne({ user: cursor, school: req.schoolId }).select('reportingManager').lean();
                    cursor = up?.reportingManager ? String(up.reportingManager) : '';
                    hops += 1;
                }
            }
            patch.reportingManager = managerId || null;
            before.reportingManager = found.profile.reportingManager ? String(found.profile.reportingManager) : '';
        }
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

exports.setVerification = async (req, res) => {
    try {
        const found = await findEmployee(req);
        if (!found) return fail(res, 'Employee not found', 404);

        const section = trim(req.body?.section);
        const status  = trim(req.body?.status);
        if (!VERIFICATION_SECTIONS.includes(section)) return fail(res, 'Unknown verification section', 400);
        if (!VERIFICATION_STATUSES.includes(status))  return fail(res, 'Unknown verification status', 400);

        // A section backed by uploads cannot be signed off while none are on
        // file: there is no evidence to have reviewed. The UI hides the button,
        // this is the rule behind it.
        if (status === 'verified') {
            const defs = DOCS_BY_SECTION[section] || [];
            if (defs.length) {
                const onFile = defs.filter((d) => trim(found.profile?.[d.key]));
                if (!onFile.length) {
                    return fail(res, `${VERIFICATION_LABELS[section]} has no document on file to verify. `
                        + 'Upload the paperwork on the employee record first.', 400);
                }
            }
        }

        const existing = await EmployeeVerification.findOne({ employee: String(found.user._id), section }).lean();
        const payload = {
            school: req.schoolId,
            employee: String(found.user._id),
            section,
            status,
            note: trim(req.body?.note),
            verifiedBy: status === 'verified' ? req.userId : null,
            verifiedAt: status === 'verified' ? new Date() : null,
            expiresAt: req.body?.expiresAt ? new Date(req.body.expiresAt) : null,
        };
        if (existing) await EmployeeVerification.findByIdAndUpdate(existing._id, { $set: payload });
        else await EmployeeVerification.create(payload);

        await audit(req, {
            actionType: 'UPDATE_EMPLOYEE_VERIFICATION',
            entityType: 'EmployeeVerification',
            entityId: String(found.user._id),
            oldValue: existing ? { section, status: existing.status, note: existing.note || '' } : null,
            newValue: { section, status, note: payload.note, employeeName: found.user.name },
        });
        ok(res, { section, status });
    } catch (e) { fail(res, e); }
};

exports.getVerificationQueue = async (req, res) => {
    try {
        const { snap, rows } = await collect(req);
        const verifications = await EmployeeVerification.find({ school: req.schoolId }).lean();
        const bySection = new Map();
        for (const v of verifications) {
            if (!bySection.has(String(v.employee))) bySection.set(String(v.employee), {});
            bySection.get(String(v.employee))[v.section] = v.status;
        }
        const sectionTotals = Object.fromEntries(VERIFICATION_SECTIONS.map((s) => [s, { verified: 0, pending: 0, rejected: 0 }]));

        const employees = rows.map((r) => {
            const state = bySection.get(r._id) || {};
            const profile = snap.profileByUser.get(r._id) || {};
            const sections = VERIFICATION_SECTIONS.map((s) => {
                const status = state[s] || 'pending';
                sectionTotals[s][status] += 1;
                // The paperwork a reviewer has to open before signing this
                // section off. Empty for the sections this ERP keeps as field
                // values only — those are reviewed on the employee's profile.
                const defs = DOCS_BY_SECTION[s] || [];
                const documents = defs
                    .filter((d) => trim(profile[d.key]))
                    .map((d) => ({ key: d.key, label: d.label, url: `${svc.STAFF_DOC_BASE}/${profile[d.key]}` }));
                return {
                    section: s,
                    label: VERIFICATION_LABELS[s],
                    status,
                    documents,
                    // True when the section is backed by uploads at all. One of
                    // these with no files cannot be verified — there is nothing
                    // to look at.
                    documentBacked: defs.length > 0,
                    missingDocuments: defs.length > 0 && documents.length === 0,
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
        const filter = { school: req.schoolId };
        if (req.query.employee) filter.employee = String(req.query.employee);
        if (req.query.type)     filter.type = String(req.query.type);
        if (req.query.active !== 'all') filter.isActive = true;

        const rows = await EmployeeResponsibility.find(filter).sort({ createdAt: -1 }).lean();
        const userIds = [...new Set(rows.map((r) => String(r.employee)))];
        const [users, classes, sections, subjects] = await Promise.all([
            userIds.length ? User.find({ _id: { $in: userIds }, school: req.schoolId }).select('name').lean() : [],
            Class.find({ school: req.schoolId }).select('className').lean(),
            ClassSection.find({ school: req.schoolId }).select('sectionName class').lean(),
            Subject.find({ school: req.schoolId }).select('subjectName').lean(),
        ]);
        const nameById    = new Map(users.map((u) => [String(u._id), u.name]));
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
                    notes: r.notes || '', isActive: r.isActive !== false,
                })),
            types: RESPONSIBILITY_TYPES.map((t) => ({ value: t, label: RESPONSIBILITY_LABELS[t] })),
        });
    } catch (e) { fail(res, e); }
};

exports.createResponsibility = async (req, res) => {
    try {
        const b = req.body || {};
        const employeeId = trim(b.employee);
        if (!RESPONSIBILITY_TYPES.includes(trim(b.type))) return fail(res, 'Unknown responsibility type', 400);

        const employee = await User.findOne({ _id: employeeId, school: req.schoolId, role: 'teacher' }).select('name').lean();
        if (!employee) return fail(res, 'That employee does not belong to this school', 400);

        // Every reference is re-checked against the caller's school, so a
        // borrowed id from another tenant cannot be attached.
        const scoped = {};
        for (const [key, Model] of [['class', Class], ['section', ClassSection], ['subject', Subject], ['academicYear', AcademicYear]]) {
            const id = trim(b[key]);
            if (!id) { scoped[key] = null; continue; }
            const row = await Model.findOne({ _id: id, school: req.schoolId }).select('_id').lean();
            if (!row) return fail(res, `The selected ${key} does not belong to this school`, 400);
            scoped[key] = id;
        }

        const created = await EmployeeResponsibility.create({
            school: req.schoolId,
            employee: employeeId,
            type: trim(b.type),
            title: trim(b.title),
            department: trim(b.department),
            ...scoped,
            fromDate: b.fromDate ? new Date(b.fromDate) : null,
            toDate:   b.toDate   ? new Date(b.toDate)   : null,
            notes: trim(b.notes),
            isActive: b.isActive !== false,
            assignedBy: req.userId,
        });
        await audit(req, {
            actionType: 'ASSIGN_EMPLOYEE_RESPONSIBILITY',
            entityType: 'EmployeeResponsibility',
            entityId: String(created._id),
            oldValue: null,
            newValue: { employee: employeeId, employeeName: employee.name, type: trim(b.type), title: trim(b.title) },
        });
        ok(res, { _id: String(created._id) }, 201);
    } catch (e) { fail(res, e); }
};

exports.removeResponsibility = async (req, res) => {
    try {
        const row = await EmployeeResponsibility.findOne({ _id: String(req.params.id), school: req.schoolId }).lean();
        if (!row) return fail(res, 'Responsibility not found', 404);
        await EmployeeResponsibility.findByIdAndDelete(String(row._id));
        await audit(req, {
            actionType: 'REMOVE_EMPLOYEE_RESPONSIBILITY',
            entityType: 'EmployeeResponsibility',
            entityId: String(row._id),
            oldValue: { employee: String(row.employee), type: row.type, title: row.title || '' },
            newValue: {},
        });
        ok(res, { removed: String(row._id) });
    } catch (e) { fail(res, e); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Reports — administrative only. Sensitive columns are never included, in any
//  format: an export cannot leak what the profile endpoint masks.
// ─────────────────────────────────────────────────────────────────────────────
const REPORTS = {
    directory: {
        label: 'Employee Directory',
        columns: ['Employee ID', 'Name', 'Designation', 'Department', 'Type', 'Status', 'Joining Date', 'Subjects', 'Classes', 'Email', 'Phone'],
        build: (rows) => rows.map((r) => [
            r.employeeId, r.name, r.designation, r.department,
            r.staffType === 'teaching' ? 'Teaching' : 'Non-Teaching',
            r.employmentStatus, fmtDate(r.joiningDate),
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
            const m = new Map();
            for (const r of rows) for (const s of r.subjects) {
                if (!m.has(s)) m.set(s, []);
                m.get(s).push(r.name);
            }
            return [...m].sort((a, b) => a[0].localeCompare(b[0]))
                .map(([subject, names]) => [subject, names.length, [...new Set(names)].sort().join(', ')]);
        },
    },
    'by-class': {
        label: 'Class-wise Teachers',
        columns: ['Class / Section', 'Teachers', 'Class Teacher', 'Names'],
        build: (rows) => {
            const m = new Map();
            for (const r of rows) for (const a of r._assignments) {
                const key = `${a.className || 'Class'} ${a.sectionName || ''}`.trim();
                if (!m.has(key)) m.set(key, { names: new Set(), classTeacher: '' });
                m.get(key).names.add(r.name);
                if (a.role === 'class_teacher') m.get(key).classTeacher = r.name;
            }
            return [...m].sort((a, b) => a[0].localeCompare(b[0]))
                .map(([key, v]) => [key, v.names.size, v.classTeacher, [...v.names].sort().join(', ')]);
        },
    },
    'active-inactive': {
        label: 'Active / Inactive Employees',
        columns: ['Employee ID', 'Name', 'Designation', 'Status', 'Last Seen'],
        build: (rows) => rows.map((r) => [r.employeeId, r.name, r.designation, r.employmentStatus, fmtDate(r.lastSeenAt)]),
    },
    'new-joiners': {
        label: 'New Joiners',
        columns: ['Employee ID', 'Name', 'Designation', 'Department', 'Joining Date'],
        build: (rows) => {
            const cutoff = new Date();
            cutoff.setMonth(cutoff.getMonth() - 12);
            return rows
                .filter((r) => isDate(r.joiningDate) && new Date(r.joiningDate) >= cutoff)
                .sort((a, b) => new Date(b.joiningDate) - new Date(a.joiningDate))
                .map((r) => [r.employeeId, r.name, r.designation, r.department, fmtDate(r.joiningDate)]);
        },
    },
    'profile-completion': {
        label: 'Profile Completion',
        columns: ['Employee ID', 'Name', 'Completion %', 'Missing Fields'],
        build: (rows) => [...rows].sort((a, b) => a.profileCompletion - b.profileCompletion)
            .map((r) => [r.employeeId, r.name, r.profileCompletion, r.missingCount]),
    },
    'pending-verification': {
        label: 'Pending Verification',
        columns: ['Employee ID', 'Name', 'Designation', 'Department'],
        build: (rows) => rows.filter((r) => r.pendingVerification)
            .map((r) => [r.employeeId, r.name, r.designation, r.department]),
    },
    'missing-documents': {
        label: 'Missing Documents',
        columns: ['Employee ID', 'Name', 'Missing Documents'],
        build: (rows) => rows.filter((r) => r.missingDocumentCount > 0)
            .map((r) => [r.employeeId, r.name, r.missingDocumentCount]),
    },
};

function fmtDate(d) {
    if (!isDate(d)) return '';
    const x = new Date(d);
    return `${String(x.getDate()).padStart(2, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${x.getFullYear()}`;
}

function groupCount(rows, get) {
    const m = new Map();
    for (const r of rows) {
        const k = trim(get(r)) || 'Unassigned';
        if (!m.has(k)) m.set(k, { total: 0, active: 0, teaching: 0, nonTeaching: 0 });
        const v = m.get(k);
        v.total += 1;
        if (r.employmentStatus === 'active') v.active += 1;
        if (r.staffType === 'teaching') v.teaching += 1; else v.nonTeaching += 1;
    }
    return [...m].sort((a, b) => b[1].total - a[1].total)
        .map(([label, v]) => [label, v.total, v.active, v.teaching, v.nonTeaching]);
}

exports.listReports = (_req, res) => ok(res, {
    reports: Object.entries(REPORTS).map(([key, r]) => ({ key, label: r.label, columns: r.columns })),
});

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

        const fileBase = `${def.label.replace(/[^\w]+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
        if (format === 'csv') {
            const esc = (v) => {
                const s = v == null ? '' : String(v);
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const csv = [def.columns, ...data].map((r) => r.map(esc).join(',')).join('\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
            return res.send('﻿' + csv);
        }
        if (format === 'xlsx') {
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([def.columns, ...data]), 'Report');
            const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`);
            return res.send(buf);
        }
        return fail(res, 'Unsupported export format', 400);
    } catch (e) { fail(res, e); }
};

// Exported for the test script.
exports._internal = { loadSnapshot, buildRow, matches, sortRows, REPORTS };
