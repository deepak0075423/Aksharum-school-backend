'use strict';
/**
 * Timetable generation, versioning and publishing.
 *
 * Kept separate from timetable.controller.js on purpose: that file serves the
 * LIVE timetable (admin section editor, teacher/student views, PDFs) and keeps
 * working untouched. This one owns the draft workspace — configuration, the
 * generator, conflicts, manual edits, versions — and only reaches the live
 * tables at publish time, through services/timetable/persistence.publishVersion.
 */

const AcademicYear          = require('../models/AcademicYear');
const ClassSection          = require('../models/ClassSection');
const Class                 = require('../models/Class');
const Subject               = require('../models/Subject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const ClassSubject          = require('../models/ClassSubject');
const User                  = require('../models/User');
const School                = require('../models/School');
const Timetable             = require('../models/Timetable');
const TimetableMergeGroup   = require('../models/TimetableMergeGroup');
const TimetableEntry        = require('../models/TimetableEntry');
const Room                  = require('../models/Room');
const TeacherAvailability   = require('../models/TeacherAvailability');
const SubjectRequirement    = require('../models/SubjectRequirement');
const TimetableConfig       = require('../models/TimetableConfig');
const TimetableVersion      = require('../models/TimetableVersion');
const TimetableVersionEntry = require('../models/TimetableVersionEntry');
const TimetableConflict     = require('../models/TimetableConflict');
const TimetableAuditLog     = require('../models/TimetableAuditLog');

const tt = require('../services/timetable');
const { daysForSection } = require('../utils/timetableDays');
const persistence = require('../services/timetable/persistence');
const { solve } = require('../services/timetable/solveRunner');
const { validate: validateBody } = require('../utils/validators');
const { newSeed } = require('../services/timetable/rng');

const ok  = (res, d, s = 200) => res.status(s).json({ success: true, data: d });
const err = (res, e, s = 500) => res.status(s).json({ success: false, message: e.message || e });

const sid = (v) => (v == null ? null : String(v._id ?? v));
const uniq = (a) => [...new Set(a.filter(Boolean))];

/* ── Shared helpers ──────────────────────────────────────────────────────── */

const resolveYear = async (schoolId, yearId) => {
    if (yearId) return AcademicYear.findOne({ _id: yearId, school: schoolId }).lean();
    return AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
};

async function logAudit(req, actionType, entityType, entityId, description, meta = {}, versionId = null) {
    try {
        await TimetableAuditLog.create({
            school: req.schoolId,
            user: req.userId,
            role: req.userRole,
            actionType,
            entityType,
            entityId: entityId || null,
            version: versionId,
            description,
            meta,
        });
    } catch (e) {
        console.error('[timetable-audit]', e.message);
    }
}

/** Load a version and confirm it belongs to the caller's school. */
async function getOwnedVersion(req, id) {
    const version = await TimetableVersion.findOne({ _id: id, school: req.schoolId, isDeleted: false }).lean();
    if (!version) {
        const e = new Error('Timetable version not found');
        e.status = 404;
        throw e;
    }
    return version;
}

/**
 * Soft edit lock. Two admins opening the same draft is fine; two admins SAVING
 * into it is not, so a mutation claims the version for 15 minutes.
 */
const LOCK_TTL_MS = 15 * 60 * 1000;
async function claimEditLock(req, version) {
    const holder = sid(version.lockedBy);
    const fresh = version.lockedAt && (Date.now() - new Date(version.lockedAt).getTime()) < LOCK_TTL_MS;
    if (holder && fresh && holder !== String(req.userId)) {
        const other = await User.findById(holder).select('name').lean();
        const e = new Error(`${other?.name || 'Another administrator'} is editing this timetable. Try again in a few minutes.`);
        e.status = 409;
        throw e;
    }
    await TimetableVersion.findByIdAndUpdate(version._id, { $set: { lockedBy: req.userId, lockedAt: new Date() } });
}

/**
 * Version entry rows → the shape the engine's validator expects.
 * `additionalSubjects` is carried through: merged subjects share one row, and a
 * validator that could not see them would report every merge as a class clash.
 */
const shapeEntries = (rows) => rows.map((e) => ({
    _id: sid(e._id),
    sectionId: sid(e.section),
    subjectId: sid(e.subject),
    teacherId: sid(e.teacher),
    roomId: sid(e.room),
    dayOfWeek: e.dayOfWeek,
    periodNumber: e.periodNumber,
    mergeGroup: e.mergeGroup || '',
    additionalSubjects: (e.additionalSubjects || []).map((m) => ({
        subjectId: sid(m.subject ?? m.subjectId),
        teacherId: sid(m.teacher ?? m.teacherId),
        roomId: sid(m.room ?? m.roomId),
    })),
}));

/**
 * One row per subject actually taught. A merged slot yields several — which is
 * what a teacher-wise or room-wise view has to iterate over.
 */
const explodeEntries = (rows) => rows.flatMap((e) => [
    { ...e, mergedWith: (e.additionalSubjects || []).map((m) => sid(m.subject ?? m.subjectId)) },
    ...(e.additionalSubjects || []).map((m) => ({
        ...e,
        subject: m.subject ?? m.subjectId,
        teacher: m.teacher ?? m.teacherId ?? null,
        room: m.room ?? m.roomId ?? null,
        additionalSubjects: [],
        isMergedPartner: true,
    })),
]);

/** Compile an engine context for a version, reusing the shared bulk loader. */
async function contextForVersion(version) {
    const { input, lookups } = await tt.loadGenerationInput({
        schoolId: version.school,
        academicYearId: version.academicYear,
        sectionIds: (version.sections || []).map(String),
        options: version.options || {},
    });
    return { ctx: tt.compile(input), input, lookups };
}

/** Period structure to stamp on a Timetable header row created at publish time. */
function structureFromInput(input) {
    const map = new Map();
    for (const s of input.sections) {
        const firstDay = s.days.find((d) => d !== 'Saturday') || s.days[0];
        const periods = (s.periodsByDay && s.periodsByDay[firstDay]) || [];
        const teaching = periods.filter((p) => p.periodType === 'Teaching');
        map.set(String(s.id), {
            schoolStartTime: teaching[0]?.startTime || '08:00',
            schoolEndTime: teaching[teaching.length - 1]?.endTime || '14:00',
            periodsStructure: periods.map((p) => ({
                periodNumber: p.periodNumber,
                startTime: p.startTime,
                endTime: p.endTime,
                isRecess: p.periodType !== 'Teaching',
                recessName: p.recessName || (p.periodType !== 'Teaching' ? p.periodType : ''),
                periodType: p.periodType,
            })),
        });
    }
    return map;
}

/* ══════════════════════════════════════════════════════════════════════════
   META — one call that fills every dropdown in the Generate dialog
   ══════════════════════════════════════════════════════════════════════════ */

exports.getMeta = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.query.yearId);
        const [years, classes, sections, subjects, teachers, rooms, school, config] = await Promise.all([
            AcademicYear.find({ school: req.schoolId }).sort({ createdAt: -1 }).lean(),
            year ? Class.find({ school: req.schoolId, academicYear: year._id }).sort({ classNumber: 1 }).lean() : [],
            year ? ClassSection.find({ school: req.schoolId, academicYear: year._id, status: 'active' }).lean() : [],
            Subject.find({ school: req.schoolId }).sort({ subjectName: 1 }).lean(),
            User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('name email').sort({ name: 1 }).lean(),
            Room.find({ school: req.schoolId, isActive: true }).sort({ roomName: 1 }).lean(),
            School.findById(req.schoolId).select('name leaveSettings').lean(),
            year ? TimetableConfig.findOne({ school: req.schoolId, academicYear: year._id }).lean() : null,
        ]);

        const byClass = new Map(classes.map((c) => [sid(c._id), { ...c, sections: [] }]));
        for (const s of sections) {
            byClass.get(sid(s.class))?.sections.push({
                _id: s._id, sectionName: s.sectionName, currentCount: s.currentCount,
                openOnSaturday: s.openOnSaturday, maxStudents: s.maxStudents,
            });
        }

        ok(res, {
            years,
            selectedYearId: year?._id || null,
            classes: [...byClass.values()],
            subjects,
            teachers,
            rooms,
            saturdayConfig: {
                working: school?.leaveSettings?.saturdayWorking !== false,
                mode: school?.leaveSettings?.saturdayMode || 'all',
                halfDay: !!school?.leaveSettings?.saturdayHalfDay,
            },
            hasConfig: !!config,
            roomTypes: tt.ROOM_TYPES,
            subjectTypes: tt.SUBJECT_TYPES,
            periodTypes: tt.PERIOD_TYPES,
            days: tt.DAYS,
        });
    } catch (e) { err(res, e, e.status); }
};

/* ══════════════════════════════════════════════════════════════════════════
   CLASS PLAN — the subjects, the week's capacity, and what each subject owes
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The teaching grid one section actually works, resolved exactly the way the
 * generator resolves it: the section's own saved structure first, then the
 * school-wide template, then its start/end/period timings.
 */
function sectionGrid({ section, timetable, config, satWorking }) {
    const weekday = tt.normalisePeriods(timetable?.periodsStructure).length
        ? tt.normalisePeriods(timetable.periodsStructure)
        : (tt.normalisePeriods(config?.periodTemplate).length
            ? tt.normalisePeriods(config.periodTemplate)
            : tt.normalisePeriods(tt.derivePeriods(section)));
    const saturday = tt.normalisePeriods(config?.saturdayTemplate);

    // Same resolver the published views use, so the solver and the screens can
    // never disagree about whether a section teaches on Saturday.
    const days = daysForSection(section, { leaveSettings: { saturdayWorking: satWorking } }, config?.workingDays);

    const breakdown = days.map((day) => {
        const periods = (day === 'Saturday' && saturday.length) ? saturday : weekday;
        return { day, periods: periods.filter((x) => x.periodType === 'Teaching').length };
    });
    return { days, breakdown, periodsPerWeek: breakdown.reduce((n, d) => n + d.periods, 0) };
}

/**
 * Which subjects each section teaches: its own teacher assignments plus the
 * subjects carried by its class. The same two sources the generator falls back
 * to, so the screen and the solver never disagree about what a section teaches.
 */
async function subjectsBySection(classId, sectionIds) {
    const [sst, classSubjects] = await Promise.all([
        SectionSubjectTeacher.find({ section: { $in: sectionIds } }).lean(),
        ClassSubject.find({ class: classId }).lean(),
    ]);
    const classSubjectIds = classSubjects.map((x) => sid(x.subject));
    const map = new Map(sectionIds.map((id) => [id, new Set(classSubjectIds)]));
    for (const row of sst) map.get(sid(row.section))?.add(sid(row.subject));
    return map;
}

/** How many days a week each of these sections actually teaches. */
async function workingDaysBySection(schoolId, academicYearId, sectionIds) {
    const [school, config, sections, timetables] = await Promise.all([
        School.findById(schoolId).select('leaveSettings').lean(),
        TimetableConfig.findOne({ school: schoolId, academicYear: academicYearId }).lean(),
        ClassSection.find({ _id: { $in: sectionIds } }).lean(),
        Timetable.find({ section: { $in: sectionIds }, academicYear: academicYearId }).lean(),
    ]);
    const satWorking = school?.leaveSettings?.saturdayWorking !== false;
    const ttBySection = new Map(timetables.map((t) => [sid(t.section), t]));
    return new Map(sections.map((section) => [
        sid(section._id),
        sectionGrid({ section, timetable: ttBySection.get(sid(section._id)), config, satWorking }).days.length,
    ]));
}

/**
 * Everything the Generate screen needs once a class is picked: which sections it
 * has, how many teaching periods the week actually holds, every subject taught,
 * and the weekly period count + merge grouping already saved for each.
 *
 * When several sections are in play their subject lists are compared here —
 * generating one plan for sections that teach different subjects would silently
 * apply the wrong requirements, so the mismatch is reported instead.
 */
exports.getClassPlan = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.query.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const { classId } = req.query;
        if (!classId) return err(res, 'classId is required', 400);

        const klass = await Class.findOne({ _id: classId, school: req.schoolId, academicYear: year._id }).lean();
        if (!klass) return err(res, 'Class not found', 404);

        const allSections = await ClassSection.find({
            school: req.schoolId, academicYear: year._id, class: classId, status: 'active',
        }).sort({ sectionName: 1 }).lean();
        if (!allSections.length) return err(res, 'This class has no active sections', 400);

        // Which sections the plan covers: the ones asked for, or all of them.
        const asked = uniq(String(req.query.sectionIds || '').split(',').map((x) => x.trim()));
        const scope = asked.length
            ? allSections.filter((s) => asked.includes(sid(s._id)))
            : allSections;
        if (!scope.length) return err(res, 'None of those sections belong to this class', 400);
        const scopeIds = scope.map((s) => sid(s._id));

        const [school, config, timetables, sst, classSubjects, subjects, requirements, teachers] = await Promise.all([
            School.findById(req.schoolId).select('leaveSettings').lean(),
            TimetableConfig.findOne({ school: req.schoolId, academicYear: year._id }).lean(),
            Timetable.find({ section: { $in: scopeIds }, academicYear: year._id }).lean(),
            SectionSubjectTeacher.find({ section: { $in: scopeIds } }).lean(),
            ClassSubject.find({ class: classId }).lean(),
            Subject.find({ school: req.schoolId }).sort({ subjectName: 1 }).lean(),
            SubjectRequirement.find({ school: req.schoolId, academicYear: year._id, section: { $in: scopeIds } }).lean(),
            User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('name').sort({ name: 1 }).lean(),
        ]);

        const satWorking = school?.leaveSettings?.saturdayWorking !== false;
        const ttBySection = new Map(timetables.map((t) => [sid(t.section), t]));
        const subjectById = new Map(subjects.map((x) => [sid(x._id), x]));
        const teacherName = new Map(teachers.map((t) => [sid(t._id), t.name]));

        /* ── Capacity ────────────────────────────────────────────────────── */
        const grids = scope.map((section) => ({
            sectionId: sid(section._id),
            sectionName: section.sectionName,
            strength: section.currentCount || 0,
            openOnSaturday: section.openOnSaturday !== false,
            ...sectionGrid({ section, timetable: ttBySection.get(sid(section._id)), config, satWorking }),
        }));
        const weeks = grids.map((g) => g.periodsPerWeek);
        const capacity = {
            periodsPerWeek: Math.min(...weeks),
            min: Math.min(...weeks),
            max: Math.max(...weeks),
            uniform: Math.min(...weeks) === Math.max(...weeks),
            breakdown: grids[0].breakdown,
            days: grids[0].days,
            saturdayWorking: satWorking && grids.some((g) => g.days.includes('Saturday')),
        };

        /* ── Subjects, per section ───────────────────────────────────────── */
        const subjectsOfSection = new Map(scopeIds.map((id) => [
            id,
            new Set([
                ...classSubjects.map((x) => sid(x.subject)),
                ...sst.filter((x) => sid(x.section) === id).map((x) => sid(x.subject)),
            ]),
        ]));

        const reqBySection = new Map();
        for (const r of requirements) reqBySection.set(`${sid(r.section)}#${sid(r.subject)}`, r);

        const allSubjectIds = uniq([...subjectsOfSection.values()].flatMap((set) => [...set]));
        const rows = allSubjectIds.map((subjectId) => {
            const subject = subjectById.get(subjectId);
            const presentIn = scopeIds.filter((id) => subjectsOfSection.get(id).has(subjectId));
            const saved = scopeIds.map((id) => reqBySection.get(`${id}#${subjectId}`)).filter(Boolean);
            const weeklyValues = uniq(saved.map((r) => String(Number(r.weeklyPeriods) || 0)));
            const mergeValues = uniq(saved.map((r) => String(r.mergeGroup || '')).filter(Boolean));
            const assignedTeachers = uniq(sst
                .filter((x) => sid(x.subject) === subjectId && scopeIds.includes(sid(x.section)))
                .map((x) => sid(x.teacher)));

            // Every scheduling rule for this subject, so the Generate screen can
            // edit them all in one place. Where sections were configured
            // differently, the first section's row stands in and saving levels
            // them — one plan describes one class.
            const first = saved[0] || {};
            const practical = subject?.type === 'practical';

            return {
                _id: subjectId,
                subjectName: subject?.subjectName || 'Subject',
                subjectCode: subject?.subjectCode || '',
                type: subject?.type || 'theory',
                subjectType: first.subjectType || (practical ? 'Practical' : 'Theory'),
                // The saved figure when every section agrees; otherwise the
                // largest, which the admin can then correct in one place.
                weeklyPeriods: saved.length ? Math.max(...saved.map((r) => Number(r.weeklyPeriods) || 0)) : 0,
                weeklyVaries: weeklyValues.length > 1,
                consecutivePeriods: first.consecutivePeriods || (practical ? 2 : 1),
                maxPerDay: first.maxPerDay || (practical ? 2 : 1),
                hardMaxPerDay: first.hardMaxPerDay !== false,
                difficulty: first.difficulty || 3,
                priority: Number(first.priority) || 0,
                minGapPeriods: Number(first.minGapPeriods) || 0,
                requiresRoom: !!first.requiresRoom,
                room: sid(first.room),
                roomTypes: first.roomTypes || [],
                preferredDays: first.preferredDays || [],
                preferredPeriods: first.preferredPeriods || [],
                teacher: sid(first.teacher) || assignedTeachers[0] || null,
                altTeachers: (first.altTeachers || []).map(sid),
                mergeGroup: mergeValues[0] || '',
                mergeVaries: mergeValues.length > 1,
                teachers: assignedTeachers.map((id) => ({ _id: id, name: teacherName.get(id) || 'Teacher' })),
                hasRequirement: saved.length > 0,
                presentIn,
                missingIn: scopeIds.filter((id) => !presentIn.includes(id)),
            };
        }).sort((a, b) => a.subjectName.localeCompare(b.subjectName));

        /* ── Do the sections actually teach the same thing? ──────────────── */
        const labelOf = (id) => `${klass.className} ${grids.find((g) => g.sectionId === id)?.sectionName || ''}`.trim();
        const differences = rows
            .filter((r) => r.missingIn.length)
            .map((r) => ({
                subjectId: r._id,
                subjectName: r.subjectName,
                missingIn: r.missingIn.map(labelOf),
                presentIn: r.presentIn.map(labelOf),
            }));

        ok(res, {
            selectedYearId: year._id,
            class: { _id: klass._id, className: klass.className, classNumber: klass.classNumber },
            sections: allSections.map((x) => ({
                _id: x._id, sectionName: x.sectionName, currentCount: x.currentCount, openOnSaturday: x.openOnSaturday,
            })),
            scopeSectionIds: scopeIds,
            grids,
            capacity,
            subjects: rows,
            totalWeekly: rows.reduce((n, r) => n + r.weeklyPeriods, 0),
            structureMatches: {
                ok: differences.length === 0 && capacity.uniform,
                sameSubjects: differences.length === 0,
                sameCapacity: capacity.uniform,
                differences,
                message: differences.length
                    ? `These sections do not teach the same subjects: ${differences.map((d) => `${d.subjectName} is missing in ${d.missingIn.join(', ')}`).join('; ')}.`
                    : (capacity.uniform ? '' : `These sections have different weekly period counts (${capacity.min}–${capacity.max}). The plan is validated against the smaller week.`),
            },
        });
    } catch (e) { err(res, e, e.status); }
};

/* ══════════════════════════════════════════════════════════════════════════
   CONFIGURATION
   ══════════════════════════════════════════════════════════════════════════ */

exports.getConfig = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.query.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const [config, school] = await Promise.all([
            TimetableConfig.findOne({ school: req.schoolId, academicYear: year._id }).lean(),
            School.findById(req.schoolId).select('leaveSettings').lean(),
        ]);

        // Unsaved default so the settings screen always has something to render.
        const satWorking = school?.leaveSettings?.saturdayWorking !== false;
        const fallback = {
            school: req.schoolId,
            academicYear: year._id,
            workingDays: satWorking ? tt.DAYS.slice(0, 6) : tt.DAYS.slice(0, 5),
            periodTemplate: [],
            saturdayTemplate: [],
            allowSubjectsInActivity: false,
            defaults: {
                maxTeacherPeriodsPerDay: 6, maxTeacherPeriodsPerWeek: 30,
                enforceTeacherQualified: true, hardTeacherDailyLimit: true,
            },
            softWeights: tt.DEFAULT_SOFT_WEIGHTS,
            solver: tt.DEFAULT_SOLVER,
        };

        ok(res, { ...(config || fallback), isSaved: !!config, selectedYearId: year._id, yearName: year.yearName });
    } catch (e) { err(res, e, e.status); }
};

exports.saveConfig = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.body.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const body = req.body || {};
        const days = (body.workingDays || []).filter((d) => tt.DAYS.includes(d));
        if (!days.length) return err(res, 'Select at least one working day', 400);

        const cleanTemplate = (rows) => (rows || [])
            .filter((p) => p && (p.periodType !== 'Teaching' || p.periodNumber))
            .map((p) => ({
                periodNumber: Number(p.periodNumber) || 0,
                startTime: p.startTime || '',
                endTime: p.endTime || '',
                periodType: tt.PERIOD_TYPES.includes(p.periodType) ? p.periodType : 'Teaching',
                label: p.label || '',
            }));

        const template = cleanTemplate(body.periodTemplate);
        const numbers = template.filter((p) => p.periodType === 'Teaching').map((p) => p.periodNumber);
        if (new Set(numbers).size !== numbers.length) {
            return err(res, 'Teaching periods must have unique period numbers', 400);
        }

        const doc = await TimetableConfig.findOneAndUpdate(
            { school: req.schoolId, academicYear: year._id },
            {
                $set: {
                    workingDays: days,
                    periodTemplate: template,
                    saturdayTemplate: cleanTemplate(body.saturdayTemplate),
                    allowSubjectsInActivity: !!body.allowSubjectsInActivity,
                    defaults: { ...(body.defaults || {}) },
                    softWeights: { ...tt.DEFAULT_SOFT_WEIGHTS, ...(body.softWeights || {}) },
                    solver: { ...tt.DEFAULT_SOLVER, ...(body.solver || {}) },
                    updatedBy: req.userId,
                },
                $setOnInsert: { school: req.schoolId, academicYear: year._id },
            },
            { upsert: true, new: true },
        );

        await logAudit(req, 'update', 'Config', doc._id, `Updated timetable configuration for ${year.yearName}`);
        ok(res, doc);
    } catch (e) { err(res, e, e.status); }
};

/* ══════════════════════════════════════════════════════════════════════════
   ROOMS
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   MERGE GROUPS — sections taught a subject together
   ══════════════════════════════════════════════════════════════════════════ */

/** A group with its sections, subject and pins resolved for display. */
async function hydrateGroups(schoolId, groups) {
    if (!groups.length) return [];
    const sectionIds = uniq(groups.flatMap((g) => (g.sections || []).map(sid)));
    const [sections, subjects, teachers, rooms] = await Promise.all([
        ClassSection.find({ _id: { $in: sectionIds } }).select('sectionName class').lean(),
        Subject.find({ _id: { $in: uniq(groups.map((g) => sid(g.subject))) } }).select('subjectName').lean(),
        User.find({ _id: { $in: uniq(groups.map((g) => sid(g.teacher))) } }).select('name').lean(),
        Room.find({ _id: { $in: uniq(groups.map((g) => sid(g.room))) } }).select('roomName').lean(),
    ]);
    const classes = await Class.find({ _id: { $in: uniq(sections.map((x) => sid(x.class))) } }).select('className').lean();
    const className = new Map(classes.map((c) => [sid(c._id), c.className]));
    const sectionById = new Map(sections.map((x) => [sid(x._id), {
        _id: sid(x._id),
        label: `${className.get(sid(x.class)) || 'Class'} – ${x.sectionName}`,
    }]));
    const subjectName = new Map(subjects.map((x) => [sid(x._id), x.subjectName]));
    const teacherName = new Map(teachers.map((x) => [sid(x._id), x.name]));
    const roomName    = new Map(rooms.map((x) => [sid(x._id), x.roomName]));

    return groups.map((g) => ({
        _id: sid(g._id),
        subject: sid(g.subject),
        subjectName: subjectName.get(sid(g.subject)) || 'Subject',
        sections: (g.sections || []).map(sid).map((id) => sectionById.get(id) || { _id: id, label: 'Section' }),
        teacher: sid(g.teacher),
        teacherName: teacherName.get(sid(g.teacher)) || '',
        room: sid(g.room),
        roomName: roomName.get(sid(g.room)) || '',
        source: g.source || 'plan',
        isActive: g.isActive !== false,
        label: `${subjectName.get(sid(g.subject)) || 'Subject'} — ${(g.sections || []).map(sid).map((id) => sectionById.get(id)?.label || '?').join(' + ')}`,
    }));
}

/* ══════════════════════════════════════════════════════════════════════════
   CARRY FORWARD — last year's timetable as this year's starting point
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Copy a year's timetable settings into another year.
 *
 * Rebuilding a timetable from nothing every July is the single biggest chore in
 * this module. Sections are matched by class name + section name, because the
 * rows themselves are new every year — 9-A of 2025 and 9-A of 2026 are different
 * records describing the same room of children.
 *
 * Requirements, merges and the period grid carry; the placements do not. What
 * comes across is the PLAN, so the solver still produces a schedule that fits
 * this year's staff.
 */
exports.carryForward = async (req, res) => {
    try {
        const from = await AcademicYear.findOne({ _id: req.body.fromYearId, school: req.schoolId }).lean();
        const to   = await AcademicYear.findOne({ _id: req.body.toYearId,   school: req.schoolId }).lean();
        if (!from) return err(res, 'Pick the year to copy from', 400);
        if (!to)   return err(res, 'Pick the year to copy into', 400);
        if (String(from._id) === String(to._id)) return err(res, 'Those are the same year', 400);

        const dryRun = req.body.apply !== true && req.body.apply !== 'true';

        const [fromSections, toSections] = await Promise.all([
            ClassSection.find({ school: req.schoolId, academicYear: from._id }).select('sectionName class').lean(),
            ClassSection.find({ school: req.schoolId, academicYear: to._id }).select('sectionName class').lean(),
        ]);
        if (!toSections.length) return err(res, `${to.yearName || 'That year'} has no sections yet`, 400);

        const classes = await Class.find({
            _id: { $in: uniq([...fromSections, ...toSections].map((x) => sid(x.class))) },
        }).select('className').lean();
        const className = new Map(classes.map((c) => [sid(c._id), c.className]));
        const keyOf = (x) => `${className.get(sid(x.class)) || '?'}#${x.sectionName}`;

        const toByKey = new Map(toSections.map((x) => [keyOf(x), x]));
        const pairs = [];
        const unmatched = [];
        for (const f of fromSections) {
            const match = toByKey.get(keyOf(f));
            if (match) pairs.push({ from: sid(f._id), to: sid(match._id), label: keyOf(f).replace('#', ' – ') });
            else unmatched.push(keyOf(f).replace('#', ' – '));
        }
        if (!pairs.length) return err(res, 'No sections in the two years share a class and section name', 400);

        const map = new Map(pairs.map((p) => [p.from, p.to]));

        const [reqs, merges, config, timetables] = await Promise.all([
            SubjectRequirement.find({ school: req.schoolId, academicYear: from._id, isActive: true }).lean(),
            TimetableMergeGroup.find({ school: req.schoolId, academicYear: from._id, isActive: true }).lean(),
            TimetableConfig.findOne({ school: req.schoolId, academicYear: from._id }).lean(),
            Timetable.find({ section: { $in: pairs.map((p) => p.from) }, academicYear: from._id })
                .select('section periodsStructure schoolStartTime schoolEndTime').lean(),
        ]);

        const carriedReqs = reqs.filter((r) => map.has(sid(r.section)));
        const carriedMerges = merges.filter((g) => (g.sections || []).every((x) => map.has(sid(x))));
        const droppedMerges = merges.length - carriedMerges.length;

        const plan = {
            fromYear: from.yearName || String(from._id),
            toYear: to.yearName || String(to._id),
            sections: pairs.map((p) => p.label),
            unmatchedSections: unmatched,
            requirements: carriedReqs.length,
            merges: carriedMerges.length,
            mergesDropped: droppedMerges,
            periodStructures: timetables.length,
            config: !!config,
        };
        if (dryRun) return ok(res, { ...plan, applied: false });

        /* ── Write ────────────────────────────────────────────────────────── */
        // Replaced, not merged: carrying forward twice must not double the plan.
        await SubjectRequirement.deleteMany({
            school: req.schoolId, academicYear: to._id, section: { $in: [...map.values()] },
        });
        if (carriedReqs.length) {
            await SubjectRequirement.insertMany(carriedReqs.map((r) => {
                const { _id, createdAt, updatedAt, ...rest } = r;
                return { ...rest, academicYear: to._id, section: map.get(sid(r.section)), createdBy: req.userId };
            }));
        }

        await TimetableMergeGroup.deleteMany({ school: req.schoolId, academicYear: to._id });
        if (carriedMerges.length) {
            await TimetableMergeGroup.insertMany(carriedMerges.map((g) => {
                const { _id, createdAt, updatedAt, ...rest } = g;
                return {
                    ...rest,
                    academicYear: to._id,
                    sections: (g.sections || []).map((x) => map.get(sid(x))),
                    createdBy: req.userId,
                };
            }));
        }

        if (config) {
            const { _id, createdAt, updatedAt, ...rest } = config;
            await TimetableConfig.findOneAndUpdate(
                { school: req.schoolId, academicYear: to._id },
                { $set: { ...rest, academicYear: to._id, updatedBy: req.userId } },
                { upsert: true },
            );
        }

        // The period grid too — a section with no structure falls back to the
        // school template, which is rarely what last year actually ran.
        let grids = 0;
        for (const t of timetables) {
            const target = map.get(sid(t.section));
            if (!target) continue;
            await Timetable.findOneAndUpdate(
                { section: target, academicYear: to._id },
                {
                    $set: {
                        periodsStructure: t.periodsStructure || [],
                        schoolStartTime: t.schoolStartTime || '08:00',
                        schoolEndTime: t.schoolEndTime || '15:00',
                    },
                    $setOnInsert: { section: target, academicYear: to._id, createdBy: req.userId },
                },
                { upsert: true },
            );
            grids += 1;
        }

        await logAudit(req, 'create', 'carry_forward', to._id,
            `Carried the timetable plan from ${plan.fromYear} into ${plan.toYear}`, plan);

        ok(res, { ...plan, periodStructures: grids, applied: true });
    } catch (e) { err(res, e, e.status); }
};

/* ══════════════════════════════════════════════════════════════════════════
   REPORTS — who is carrying what, and what the rooms are doing
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The published week, as rows one report can group any way it likes.
 *
 * Reads the LIVE timetable rather than a draft: these answer "what is actually
 * happening", not "what would happen if we published this".
 */
async function publishedWeek(schoolId, academicYearId) {
    const sections = await ClassSection.find({ school: schoolId, academicYear: academicYearId })
        .select('sectionName class').lean();
    if (!sections.length) return { rows: [], sections: [], days: [] };

    const [timetables, classes, school, config] = await Promise.all([
        Timetable.find({ section: { $in: sections.map((x) => x._id) }, academicYear: academicYearId })
            .select('_id section periodsStructure').lean(),
        Class.find({ _id: { $in: uniq(sections.map((x) => sid(x.class))) } }).select('className').lean(),
        School.findById(schoolId).select('leaveSettings').lean(),
        TimetableConfig.findOne({ school: schoolId, academicYear: academicYearId }).lean(),
    ]);
    if (!timetables.length) return { rows: [], sections: [], days: [] };

    const className = new Map(classes.map((c) => [sid(c._id), c.className]));
    const label = new Map(sections.map((x) => [
        sid(x._id), `${className.get(sid(x.class)) || 'Class'} – ${x.sectionName}`,
    ]));
    const sectionOf = new Map(timetables.map((t) => [sid(t._id), sid(t.section)]));

    const entries = await TimetableEntry.find({ timetable: { $in: timetables.map((t) => t._id) } })
        .select('timetable dayOfWeek periodNumber subject teacher room mergedSections').lean();

    const days = daysForSection(null, school, config?.workingDays);
    // One teaching slot per section per day, for the "free periods" arithmetic.
    const slotsPerSection = new Map(timetables.map((t) => [
        sid(t.section),
        (t.periodsStructure || []).filter((x) => !x.isRecess && (x.periodType || 'Teaching') === 'Teaching').length,
    ]));

    return {
        rows: entries.map((e) => ({
            section: sectionOf.get(sid(e.timetable)),
            sectionLabel: label.get(sectionOf.get(sid(e.timetable))) || 'Section',
            dayOfWeek: e.dayOfWeek,
            periodNumber: e.periodNumber,
            subject: sid(e.subject),
            teacher: sid(e.teacher),
            room: sid(e.room),
            mergedSections: (e.mergedSections || []).map(sid),
        })),
        sections: [...label.entries()].map(([id, l]) => ({ _id: id, label: l })),
        days,
        slotsPerSection,
    };
}

/**
 * GET — what every teacher is carrying, and when they are free.
 *
 * A merged lesson is one lesson however many sections sit in it, so it counts
 * once against the teacher who takes it.
 */
exports.teacherWorkload = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.query.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const { rows, days } = await publishedWeek(req.schoolId, year._id);
        const [teachers, subjects, availability] = await Promise.all([
            User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('name').sort('name').lean(),
            Subject.find({ school: req.schoolId }).select('subjectName').lean(),
            TeacherAvailability.find({ school: req.schoolId, academicYear: year._id }).lean(),
        ]);
        const subjectName = new Map(subjects.map((x) => [sid(x._id), x.subjectName]));
        const capOf = new Map(availability.map((a) => [sid(a.teacher), a.maxPeriodsPerWeek || 0]));

        // Merged lessons are written once per section — count the lesson, not the rows.
        const counted = new Set();
        const byTeacher = new Map();
        for (const r of rows) {
            if (!r.teacher) continue;
            const mergeKey = r.mergedSections.length
                ? `${[r.section, ...r.mergedSections].sort().join('|')}#${r.dayOfWeek}#${r.periodNumber}#${r.subject}`
                : null;
            if (mergeKey) {
                if (counted.has(mergeKey)) continue;
                counted.add(mergeKey);
            }
            if (!byTeacher.has(r.teacher)) {
                byTeacher.set(r.teacher, { periods: 0, byDay: {}, bySubject: {}, sections: new Set(), busy: new Set() });
            }
            const t = byTeacher.get(r.teacher);
            t.periods += 1;
            t.byDay[r.dayOfWeek] = (t.byDay[r.dayOfWeek] || 0) + 1;
            const sn = subjectName.get(r.subject) || 'Subject';
            t.bySubject[sn] = (t.bySubject[sn] || 0) + 1;
            t.sections.add(r.section);
            for (const secId of [r.section, ...r.mergedSections]) t.sections.add(secId);
            t.busy.add(`${r.dayOfWeek}#${r.periodNumber}`);
        }

        const periodsInWeek = Math.max(0, ...rows.map((r) => Number(r.periodNumber) || 0));
        const weekSlots = periodsInWeek * days.length;

        const report = teachers.map((t) => {
            const load = byTeacher.get(sid(t._id));
            const periods = load?.periods || 0;
            const cap = capOf.get(sid(t._id)) || 0;
            return {
                _id: sid(t._id),
                name: t.name,
                periods,
                freePeriods: Math.max(0, weekSlots - periods),
                sections: load ? load.sections.size : 0,
                busiestDay: load
                    ? Object.entries(load.byDay).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
                    : '',
                byDay: load?.byDay || {},
                bySubject: load
                    ? Object.entries(load.bySubject).map(([name, n]) => ({ subjectName: name, periods: n }))
                        .sort((a, b) => b.periods - a.periods)
                    : [],
                cap,
                overCap: cap > 0 && periods > cap,
            };
        }).sort((a, b) => b.periods - a.periods);

        const busy = report.filter((r) => r.periods > 0);
        ok(res, {
            days,
            weekSlots,
            teachers: report,
            summary: {
                teaching: busy.length,
                idle: report.length - busy.length,
                overCap: report.filter((r) => r.overCap).length,
                busiest: busy[0]?.periods || 0,
                lightest: busy.length ? busy[busy.length - 1].periods : 0,
                average: busy.length ? Math.round((busy.reduce((n, r) => n + r.periods, 0) / busy.length) * 10) / 10 : 0,
            },
        });
    } catch (e) { err(res, e, e.status); }
};

/** GET — how hard each room is worked, and when it sits empty. */
exports.roomUtilisation = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.query.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const { rows, days } = await publishedWeek(req.schoolId, year._id);
        const rooms = await Room.find({ school: req.schoolId, isActive: true })
            .select('roomName roomType').sort('roomName').lean();

        const periodsInWeek = Math.max(0, ...rows.map((r) => Number(r.periodNumber) || 0));
        const weekSlots = periodsInWeek * days.length;

        const counted = new Set();
        const byRoom = new Map();
        for (const r of rows) {
            if (!r.room) continue;
            // One merged lesson occupies the room once.
            const key = `${r.room}#${r.dayOfWeek}#${r.periodNumber}`;
            if (counted.has(key)) continue;
            counted.add(key);
            if (!byRoom.has(r.room)) byRoom.set(r.room, { periods: 0, byDay: {}, sections: new Set() });
            const b = byRoom.get(r.room);
            b.periods += 1;
            b.byDay[r.dayOfWeek] = (b.byDay[r.dayOfWeek] || 0) + 1;
            b.sections.add(r.section);
        }

        const report = rooms.map((room) => {
            const b = byRoom.get(sid(room._id));
            const periods = b?.periods || 0;
            return {
                _id: sid(room._id),
                roomName: room.roomName,
                roomType: room.roomType,
                periods,
                freeSlots: Math.max(0, weekSlots - periods),
                utilisation: weekSlots ? Math.round((periods / weekSlots) * 100) : 0,
                sections: b ? b.sections.size : 0,
                byDay: b?.byDay || {},
            };
        }).sort((a, b) => b.periods - a.periods);

        const unroomed = rows.filter((r) => !r.room).length;
        ok(res, {
            days,
            weekSlots,
            rooms: report,
            summary: {
                total: report.length,
                used: report.filter((r) => r.periods > 0).length,
                idle: report.filter((r) => r.periods === 0).length,
                busiest: report[0]?.roomName || '',
                periodsWithoutARoom: unroomed,
            },
        });
    } catch (e) { err(res, e, e.status); }
};

exports.listMergeGroups = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.query.yearId);
        if (!year) return err(res, 'No academic year found', 404);
        const filter = { school: req.schoolId, academicYear: year._id };
        if (req.query.subjectId) filter.subject = req.query.subjectId;
        const groups = await hydrateGroups(req.schoolId, await TimetableMergeGroup.find(filter).lean());
        // A group is only relevant to a class if the class owns one of its sections.
        if (req.query.sectionIds) {
            const want = new Set(String(req.query.sectionIds).split(',').map((x) => x.trim()).filter(Boolean));
            return ok(res, groups.filter((g) => g.sections.some((sec) => want.has(sec._id))));
        }
        ok(res, groups);
    } catch (e) { err(res, e, e.status); }
};

/**
 * Create or replace a merge. One subject may only be merged one way per year —
 * a section cannot be sitting in two different combined classes for the same
 * subject — so overlapping groups are replaced rather than stacked.
 */
exports.saveMergeGroup = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.body.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const subject = sid(req.body.subject);
        const sections = uniq((req.body.sections || []).map(sid));
        if (!subject) return err(res, 'A subject is required', 400);
        if (sections.length < 2) return err(res, 'Pick at least two sections to merge', 400);

        const known = await ClassSection.find({
            _id: { $in: sections }, school: req.schoolId, academicYear: year._id,
        }).select('_id').lean();
        if (known.length !== sections.length) return err(res, 'One of those sections is not in this academic year', 400);

        const payload = {
            school: req.schoolId,
            academicYear: year._id,
            subject,
            sections,
            teacher: sid(req.body.teacher) || null,
            room: sid(req.body.room) || null,
            source: req.body.source === 'manual' ? 'manual' : 'plan',
            isActive: req.body.isActive !== false,
            createdBy: req.userId,
        };

        const id = req.params.id || sid(req.body._id);
        let saved;
        if (id) {
            saved = await TimetableMergeGroup.findOneAndUpdate(
                { _id: id, school: req.schoolId }, { $set: payload }, { new: true },
            );
            if (!saved) return err(res, 'Merge not found', 404);
        } else {
            saved = await TimetableMergeGroup.create(payload);
        }

        // Drop any other group for this subject that shares a section with it.
        const siblings = await TimetableMergeGroup.find({
            school: req.schoolId, academicYear: year._id, subject,
            _id: { $ne: saved._id },
        }).lean();
        const overlapping = siblings
            .filter((g) => (g.sections || []).map(sid).some((x) => sections.includes(x)))
            .map((g) => g._id);
        if (overlapping.length) await TimetableMergeGroup.deleteMany({ _id: { $in: overlapping } });

        await logAudit(req, 'update', 'merge_group', saved._id,
            `Merged ${sections.length} sections for one subject`, { subject, sections });

        const [hydrated] = await hydrateGroups(req.schoolId, [saved.toObject ? saved.toObject() : saved]);
        ok(res, { ...hydrated, replaced: overlapping.length }, id ? 200 : 201);
    } catch (e) { err(res, e, e.status); }
};

exports.deleteMergeGroup = async (req, res) => {
    try {
        const group = await TimetableMergeGroup.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!group) return err(res, 'Merge not found', 404);
        await TimetableMergeGroup.deleteOne({ _id: group._id });
        await logAudit(req, 'delete', 'merge_group', group._id, 'Removed a section merge');
        ok(res, { _id: sid(group._id) });
    } catch (e) { err(res, e, e.status); }
};

exports.listRooms = async (req, res) => {
    try {
        const filter = { school: req.schoolId };
        if (req.query.type) filter.roomType = req.query.type;
        if (req.query.building) filter.building = req.query.building;
        if (req.query.active !== 'all') filter.isActive = true;

        const rooms = await Room.find(filter)
            .populate('homeSection', 'sectionName class')
            .populate('subjects', 'subjectName')
            .sort({ roomName: 1 }).lean();
        ok(res, rooms);
    } catch (e) { err(res, e, e.status); }
};

const ROOM_RULES = {
    roomName: { label: 'Room name', required: true, minLen: 1, maxLen: 80 },
    capacity: { label: 'Capacity', type: 'number', min: 0, max: 5000 },
    roomType: { label: 'Room type', enum: tt.ROOM_TYPES },
};

function cleanSlots(rows) {
    return (rows || [])
        .filter((u) => u && tt.DAYS.includes(u.dayOfWeek) && Number(u.periodNumber) > 0)
        .map((u) => ({ dayOfWeek: u.dayOfWeek, periodNumber: Number(u.periodNumber), reason: u.reason || '' }));
}

exports.createRoom = async (req, res) => {
    try {
        const msg = validateBody(req.body, ROOM_RULES);
        if (msg) return err(res, msg, 400);

        const room = await Room.create({
            school: req.schoolId,
            roomName: req.body.roomName,
            roomNumber: req.body.roomNumber || '',
            roomType: req.body.roomType || 'Classroom',
            capacity: Number(req.body.capacity) || 0,
            building: req.body.building || '',
            homeSection: req.body.homeSection || null,
            subjects: req.body.subjects || [],
            unavailable: cleanSlots(req.body.unavailable),
            notes: req.body.notes || '',
            isActive: req.body.isActive !== false,
            createdBy: req.userId,
        });
        await logAudit(req, 'create', 'Room', room._id, `Added room ${room.roomName}`);
        ok(res, room, 201);
    } catch (e) {
        if (e.code === 11000) return err(res, 'A room with this number already exists', 409);
        err(res, e, e.status);
    }
};

exports.updateRoom = async (req, res) => {
    try {
        const msg = validateBody(req.body, ROOM_RULES);
        if (msg) return err(res, msg, 400);

        const $set = {
            roomName: req.body.roomName,
            roomNumber: req.body.roomNumber || '',
            roomType: req.body.roomType || 'Classroom',
            capacity: Number(req.body.capacity) || 0,
            building: req.body.building || '',
            homeSection: req.body.homeSection || null,
            subjects: req.body.subjects || [],
            unavailable: cleanSlots(req.body.unavailable),
            notes: req.body.notes || '',
            isActive: req.body.isActive !== false,
        };
        const owned = await Room.findOne({ _id: req.params.id, school: req.schoolId }).select('_id').lean();
        if (!owned) return err(res, 'Room not found', 404);
        const room = await Room.findByIdAndUpdate(owned._id, { $set }, { new: true });
        await logAudit(req, 'update', 'Room', room._id, `Updated room ${room.roomName}`);
        ok(res, room);
    } catch (e) {
        if (e.code === 11000) return err(res, 'A room with this number already exists', 409);
        err(res, e, e.status);
    }
};

exports.deleteRoom = async (req, res) => {
    try {
        const room = await Room.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!room) return err(res, 'Room not found', 404);

        // Rooms referenced by a published timetable are retired, not destroyed,
        // so historic schedules keep their room labels.
        const inUse = await TimetableVersionEntry.countDocuments({ room: room._id });
        if (inUse > 0) {
            await Room.findByIdAndUpdate(room._id, { $set: { isActive: false } });
            await logAudit(req, 'retire', 'Room', room._id, `Retired room ${room.roomName} (in use by ${inUse} entries)`);
            return ok(res, { retired: true, message: 'Room is in use by existing timetables — it has been deactivated instead of deleted.' });
        }
        await Room.deleteOne({ _id: room._id });
        await logAudit(req, 'delete', 'Room', room._id, `Deleted room ${room.roomName}`);
        ok(res, { deleted: true });
    } catch (e) { err(res, e, e.status); }
};

/* ══════════════════════════════════════════════════════════════════════════
   TEACHER AVAILABILITY
   ══════════════════════════════════════════════════════════════════════════ */

exports.listAvailability = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.query.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const [teachers, rows, sst, subjects] = await Promise.all([
            User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('name email').sort({ name: 1 }).lean(),
            TeacherAvailability.find({ school: req.schoolId, academicYear: year._id }).lean(),
            SectionSubjectTeacher.find({}).lean(),
            Subject.find({ school: req.schoolId }).select('subjectName').lean(),
        ]);

        const byTeacher = new Map(rows.map((r) => [sid(r.teacher), r]));
        const subjectName = new Map(subjects.map((s) => [sid(s._id), s.subjectName]));
        const subjectsOf = new Map();
        for (const row of sst) {
            const t = sid(row.teacher);
            if (!subjectsOf.has(t)) subjectsOf.set(t, new Set());
            const name = subjectName.get(sid(row.subject));
            if (name) subjectsOf.get(t).add(name);
        }

        ok(res, {
            selectedYearId: year._id,
            teachers: teachers.map((t) => {
                const a = byTeacher.get(sid(t._id));
                return {
                    _id: t._id,
                    name: t.name,
                    email: t.email,
                    subjects: [...(subjectsOf.get(sid(t._id)) || [])],
                    unavailable: a?.unavailable || [],
                    maxPeriodsPerDay: a?.maxPeriodsPerDay ?? null,
                    maxPeriodsPerWeek: a?.maxPeriodsPerWeek ?? null,
                    hardDailyLimit: a?.hardDailyLimit ?? true,
                    preferredDays: a?.preferredDays || [],
                    preferredPeriods: a?.preferredPeriods || [],
                    notes: a?.notes || '',
                    configured: !!a,
                };
            }),
        });
    } catch (e) { err(res, e, e.status); }
};

exports.saveAvailability = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.body.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const teacher = await User.findOne({ _id: req.params.teacherId, school: req.schoolId, role: 'teacher' }).select('name').lean();
        if (!teacher) return err(res, 'Teacher not found', 404);

        const toNum = (v) => (v === '' || v == null ? null : Math.max(0, Number(v) || 0));
        const doc = await TeacherAvailability.findOneAndUpdate(
            { school: req.schoolId, teacher: teacher._id, academicYear: year._id },
            {
                $set: {
                    unavailable: cleanSlots(req.body.unavailable),
                    maxPeriodsPerDay: toNum(req.body.maxPeriodsPerDay),
                    maxPeriodsPerWeek: toNum(req.body.maxPeriodsPerWeek),
                    hardDailyLimit: req.body.hardDailyLimit !== false,
                    preferredDays: (req.body.preferredDays || []).filter((d) => tt.DAYS.includes(d)),
                    preferredPeriods: (req.body.preferredPeriods || []).map(Number).filter((n) => n > 0),
                    notes: req.body.notes || '',
                    updatedBy: req.userId,
                },
                $setOnInsert: { school: req.schoolId, teacher: teacher._id, academicYear: year._id },
            },
            { upsert: true, new: true },
        );

        await logAudit(req, 'update', 'TeacherAvailability', doc._id, `Updated availability for ${teacher.name}`);
        ok(res, doc);
    } catch (e) { err(res, e, e.status); }
};

/* ══════════════════════════════════════════════════════════════════════════
   GENERATION
   ══════════════════════════════════════════════════════════════════════════ */

const initialProgress = () => ({
    percent: 0,
    step: tt.GENERATION_STEPS[0].key,
    steps: tt.GENERATION_STEPS.map((s) => ({ ...s, status: 'pending' })),
    startedAt: new Date().toISOString(),
});

function advanceProgress(progress, stepKey, percent) {
    const steps = progress.steps.map((s) => ({ ...s }));
    let hit = false;
    for (const s of steps) {
        if (s.key === stepKey) { s.status = 'active'; hit = true; }
        else if (!hit) s.status = 'done';
    }
    return { ...progress, steps, step: stepKey, percent: Math.min(99, percent) };
}

/**
 * The solver runs outside the request/response cycle: a whole-school run takes
 * seconds, and holding the HTTP connection open for it would both block the
 * client and risk a proxy timeout. Progress is written to the version row, so
 * ANY cluster worker can answer the poll — not just the one solving.
 */
/**
 * Slots a merge is already committed to, for sections this run is not touching.
 *
 * When a school generates section by section, the second run has to place the
 * merged lesson exactly where the first one put it — otherwise 9-A and 9-B end
 * up in the same room at different times, or in different rooms at the same one.
 * The published timetable is the record of what was already decided.
 */
async function mergePinsOutsideScope(schoolId, version, input) {
    const scope = new Set((version.sections || []).map(String));
    const groups = await TimetableMergeGroup.find({
        school: schoolId, academicYear: version.academicYear, isActive: true,
    }).lean();
    if (!groups.length) return [];

    // Only groups that straddle the scope boundary matter: if every member is
    // being regenerated, the solver is free to place them wherever it likes.
    const outside = [];
    for (const g of groups) {
        const members = (g.sections || []).map(String);
        if (members.length < 2) continue;
        const inScope = members.filter((m) => scope.has(m));
        const settled = members.filter((m) => !scope.has(m));
        if (!inScope.length || !settled.length) continue;
        outside.push({ subject: String(g.subject), inScope, settled });
    }
    if (!outside.length) return [];

    const settledIds = [...new Set(outside.flatMap((g) => g.settled))];
    const timetables = await Timetable.find({
        section: { $in: settledIds }, academicYear: version.academicYear,
    }).select('_id section').lean();
    if (!timetables.length) return [];
    const sectionOf = new Map(timetables.map((t) => [String(t._id), String(t.section)]));

    const entries = await TimetableEntry.find({
        timetable: { $in: timetables.map((t) => t._id) },
    }).select('timetable dayOfWeek periodNumber subject teacher room').lean();

    const pins = [];
    for (const e of entries) {
        const secId = sectionOf.get(String(e.timetable));
        const group = outside.find((g) => g.subject === String(e.subject) && g.settled.includes(secId));
        if (!group) continue;
        // Pin against a section this run IS generating — that is the one the
        // solver has a block for.
        for (const target of group.inScope) {
            pins.push({
                sectionId: target,
                subjectId: String(e.subject),
                teacherId: e.teacher ? String(e.teacher) : null,
                roomId: e.room ? String(e.room) : null,
                dayOfWeek: e.dayOfWeek,
                periodNumber: e.periodNumber,
                size: 1,
            });
        }
    }
    return pins;
}

// Exported for tests: the one-section-at-a-time path is the whole point of it.
exports._mergePinsOutsideScope = mergePinsOutsideScope;

async function runGeneration(versionId, schoolId) {
    let progress = initialProgress();
    try {
        const version = await TimetableVersion.findById(versionId).lean();
        if (!version) return;

        let lastWrite = 0;
        const onProgress = (stepKey, percent) => {
            progress = advanceProgress(progress, stepKey, percent);
            const now = Date.now();
            if (now - lastWrite < 250) return;           // don't hammer the DB
            lastWrite = now;
            persistence.writeProgress(versionId, progress).catch(() => {});
        };

        onProgress('load_classes', 3);
        const { input, lookups } = await tt.loadGenerationInput({
            schoolId,
            academicYearId: version.academicYear,
            sectionIds: (version.sections || []).map(String),
            options: version.options || {},
        });
        input.seed = version.seed || newSeed();

        // Carry hand-made edits over from the version this run is based on.
        const pins = [];
        if (version.options?.preserveManualEdits && version.basedOn) {
            const manual = await TimetableVersionEntry.find({ version: version.basedOn, isManual: true }).lean();
            pins.push(...manual.map((m) => ({
                sectionId: sid(m.section), subjectId: sid(m.subject), teacherId: sid(m.teacher),
                roomId: sid(m.room), dayOfWeek: m.dayOfWeek, periodNumber: m.periodNumber, size: 1,
            })));
        }
        // Merges already fixed by an earlier run. Generating one section at a
        // time must not move a lesson its partner is already sitting in, so any
        // published slot belonging to a merge partner OUTSIDE this scope is
        // pinned before the solver starts.
        pins.push(...await mergePinsOutsideScope(schoolId, version, input));
        if (pins.length) input.pinned = pins;

        // Off the request thread: the solve is pure CPU and would otherwise pin
        // this worker for its whole run, serving nothing else meanwhile.
        const result = await solve(input, onProgress);

        // Re-validate the finished grid independently of the solver. The worker
        // cannot ship its context back (it holds Maps and back-references), so
        // it is recompiled here from the same input — which is a stronger check
        // than reusing the solver's own, not a weaker one.
        const report = tt.validate(tt.compile(input), result.assignments);
        const conflicts = dedupeConflicts([...result.conflicts, ...report.conflicts]);

        await persistence.replaceVersionEntries(versionId, schoolId, result.assignments);
        const counts = await persistence.replaceConflicts(versionId, schoolId, conflicts);

        const stats = {
            ...result.stats,
            conflicts: counts.conflictCount,
            errors: counts.errorCount,
            warnings: counts.warningCount,
            derivedRequirementSections: lookups.derivedRequirementSections.length,
        };

        await TimetableVersion.findByIdAndUpdate(versionId, {
            $set: {
                status: counts.errorCount > 0 ? 'conflict' : 'generated',
                stats,
                seed: result.seed,
                generatedAt: new Date(),
                conflictCount: counts.conflictCount,
                errorCount: counts.errorCount,
                warningCount: counts.warningCount,
                validatedAt: null,
                progress: {
                    ...progress,
                    percent: 100,
                    step: 'done',
                    steps: progress.steps.map((s) => ({ ...s, status: 'done' })),
                    finishedAt: new Date().toISOString(),
                },
            },
        });
    } catch (e) {
        console.error('[timetable-generate]', e);
        await TimetableVersion.findByIdAndUpdate(versionId, {
            $set: {
                status: 'failed',
                progress: { ...progress, percent: 100, step: 'failed', error: e.message, finishedAt: new Date().toISOString() },
            },
        }).catch(() => {});
    }
}

/** The engine and the validator can both flag the same thing — show it once. */
function dedupeConflicts(conflicts) {
    const seen = new Set();
    const out = [];
    for (const c of conflicts) {
        const key = [
            c.type, c.severity, sid(c.sectionId ?? c.section), sid(c.teacherId ?? c.teacher),
            sid(c.subjectId ?? c.subject), sid(c.roomId ?? c.room), c.dayOfWeek || '', c.periodNumber ?? '',
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
    }
    return out;
}

/**
 * Write the Generate screen's subject plan onto the sections it covers.
 *
 * The plan is the same SubjectRequirement rows the Requirements screen edits —
 * generation has one source of truth, not a parallel copy. Only the fields the
 * screen actually shows are written, so a per-section room, difficulty or
 * alternate-teacher setup made earlier survives untouched.
 */
async function applySubjectPlan({ req, year, sectionIds, plan, daysBySection }) {
    const subjectIds = uniq(plan.map((r) => sid(r.subject ?? r._id ?? r.subjectId)));
    const [subjects, sst, existing] = await Promise.all([
        Subject.find({ _id: { $in: subjectIds } }).lean(),
        SectionSubjectTeacher.find({ section: { $in: sectionIds } }).lean(),
        SubjectRequirement.find({ school: req.schoolId, academicYear: year._id, section: { $in: sectionIds } }).lean(),
    ]);
    const subjectById = new Map(subjects.map((x) => [sid(x._id), x]));
    const have = new Map(existing.map((r) => [`${sid(r.section)}#${sid(r.subject)}`, r]));

    let written = 0;
    for (const sectionId of sectionIds) {
        for (const row of plan) {
            const subjectId = sid(row.subject ?? row._id ?? row.subjectId);
            if (!subjectId) continue;
            const weekly = Math.max(0, Number(row.weeklyPeriods) || 0);
            const current = have.get(`${sectionId}#${subjectId}`);
            const subject = subjectById.get(subjectId);
            const practical = subject?.type === 'practical';
            // Teachers the section itself has for this subject win over the plan's
            // choice, which may have come from a different section of the class.
            const sectionTeachers = sst
                .filter((x) => sid(x.section) === sectionId && sid(x.subject) === subjectId)
                .map((x) => sid(x.teacher));

            // Zero periods means "not taught this week" — drop the row rather
            // than leaving a 0-period requirement lying around.
            if (weekly === 0) {
                if (current) { await SubjectRequirement.deleteOne({ _id: current._id }); written++; }
                continue;
            }

            const block = Math.max(1, Math.min(4, Number(row.consecutivePeriods) || (practical ? 2 : 1)));
            // The per-day cap has to permit the weekly count the screen asked for:
            // 8 periods across 6 working days is impossible at 1 a day, and the
            // solver would silently place 6. Raise the cap to fit, never lower it.
            const days = Math.max(1, daysBySection?.get(sectionId) || 5);
            const askedPerDay = Math.max(1, Number(row.maxPerDay) || 1);
            const maxPerDay = Math.max(askedPerDay, block, Math.ceil(weekly / days));

            // Who teaches this subject here. One plan row cannot name a teacher
            // for several sections at once, so across a whole class each section
            // keeps its own assigned teacher and the plan's choice becomes an
            // alternate; for a single section the plan is talking about that
            // section, so its choice wins.
            const planTeacher = sid(row.teacher);
            const chosenTeacher = sectionIds.length > 1
                ? (sectionTeachers[0] || planTeacher || null)
                : (planTeacher || sectionTeachers[0] || null);

            await SubjectRequirement.findOneAndUpdate(
                { section: sectionId, subject: subjectId, academicYear: year._id },
                {
                    $set: {
                        school: req.schoolId,
                        weeklyPeriods: weekly,
                        mergeGroup: String(row.mergeGroup || '').trim(),
                        teacher: chosenTeacher,
                        altTeachers: uniq([
                            ...(row.altTeachers || []).map(sid),
                            ...sectionTeachers,
                            planTeacher,
                        ]).filter((t) => t && t !== chosenTeacher),
                        subjectType: tt.SUBJECT_TYPES.includes(row.subjectType)
                            ? row.subjectType : (practical ? 'Practical' : 'Theory'),
                        room: sid(row.room) || null,
                        roomTypes: (row.roomTypes || []).filter((t) => tt.ROOM_TYPES.includes(t)),
                        requiresRoom: !!row.requiresRoom,
                        consecutivePeriods: block,
                        maxPerDay,
                        hardMaxPerDay: row.hardMaxPerDay !== false,
                        minGapPeriods: Math.max(0, Number(row.minGapPeriods) || 0),
                        preferredPeriods: (row.preferredPeriods || []).map(Number).filter((n) => n > 0),
                        preferredDays: (row.preferredDays || []).filter((d) => tt.DAYS.includes(d)),
                        difficulty: Math.min(5, Math.max(1, Number(row.difficulty) || 3)),
                        priority: Number(row.priority) || 0,
                        isActive: true,
                    },
                    $setOnInsert: { section: sectionId, subject: subjectId, academicYear: year._id, createdBy: req.userId },
                },
                { upsert: true, new: true },
            );
            written++;
        }
    }
    return written;
}

/** Reject a plan that cannot fit the week, or that merges a subject with itself. */
function validateSubjectPlan(plan, capacity) {
    const seen = new Set();
    for (const row of plan) {
        const subjectId = sid(row.subject ?? row._id ?? row.subjectId);
        if (!subjectId) return 'Every row of the subject plan needs a subject';
        if (seen.has(subjectId)) return 'The same subject appears twice in the subject plan';
        seen.add(subjectId);
        const weekly = Number(row.weeklyPeriods);
        if (!Number.isFinite(weekly) || weekly < 0 || weekly > 60) {
            return `Weekly periods for ${row.subjectName || 'a subject'} must be between 0 and 60`;
        }
    }

    // Merged subjects share their periods, so a group costs the week ONE run of
    // slots — counting each member would reject plans that actually fit.
    const groups = new Map();
    let demand = 0;
    for (const row of plan) {
        const weekly = Number(row.weeklyPeriods) || 0;
        const key = String(row.mergeGroup || '').trim();
        if (!key) { demand += weekly; continue; }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ ...row, weekly });
    }
    for (const [key, members] of groups) {
        if (members.length < 2) {
            return `"${members[0]?.subjectName || key}" is marked as merged but has no subject to merge with`;
        }
        const counts = uniq(members.map((m) => String(m.weekly)));
        if (counts.length > 1) {
            return `Merged subjects ${members.map((m) => m.subjectName || 'subject').join(' + ')} must have the same number of periods per week`;
        }
        demand += members[0].weekly;
    }

    if (demand <= 0) {
        // Saving an all-zero plan would delete every requirement row, and the
        // loader would then fall back to derived defaults — the opposite of
        // what the admin asked for.
        return 'Give at least one subject a weekly period count';
    }
    if (capacity > 0 && demand > capacity) {
        return `The plan needs ${demand} periods a week but only ${capacity} are available. Reduce it by ${demand - capacity}.`;
    }
    return null;
}

exports.generate = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.body.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        // Scope is a class plus either one of its sections or all of them. The
        // stored scopeType stays for older versions and the version list's label.
        const classId = req.body.classId || null;
        const requested = uniq((req.body.sectionIds || []).map(String).filter(Boolean));
        const allSections = req.body.allSections === true || req.body.allSections === 'true';

        let sections;
        if (classId) {
            const inClass = await ClassSection.find({
                school: req.schoolId, academicYear: year._id, class: classId, status: 'active',
            }).select('_id').lean();
            if (!inClass.length) return err(res, 'This class has no active sections to generate for', 400);
            sections = (allSections || !requested.length)
                ? inClass
                : inClass.filter((s) => requested.includes(sid(s._id)));
            if (!sections.length) return err(res, 'Select a section, or choose all sections of the class', 400);
        } else {
            // Legacy callers (and regenerate) still pass a scope type.
            const scopeType = req.body.scopeType || 'single';
            if (!['single', 'multiple', 'school'].includes(scopeType)) {
                return err(res, 'Generation scope must be single, multiple or school', 400);
            }
            sections = await tt.resolveScope(req.schoolId, year._id, scopeType, {
                sectionIds: requested,
                classIds: (req.body.classIds || []).filter(Boolean),
            });
            if (!sections.length) {
                return err(res, scopeType === 'school'
                    ? 'This academic year has no active sections to generate for'
                    : 'Select at least one class or section', 400);
            }
        }
        const sectionIds = sections.map((s) => sid(s._id));
        const scopeType = classId
            ? (sectionIds.length === 1 ? 'single' : 'multiple')
            : (req.body.scopeType || 'single');

        // Duplicate-submit guard: one run at a time per school+year.
        const running = await TimetableVersion.findOne({
            school: req.schoolId, academicYear: year._id, status: 'generating', isDeleted: false,
        }).lean();
        if (running) {
            return res.status(409).json({
                success: false,
                message: 'A timetable is already being generated for this academic year.',
                data: { versionId: running._id },
            });
        }

        // The subject plan from the Generate screen — weekly periods per subject
        // and which of them are merged — is saved before the solver reads them.
        const plan = Array.isArray(req.body.subjectPlan) ? req.body.subjectPlan : null;
        if (plan) {
            const capacity = Number(req.body.periodsPerWeek) || 0;
            const msg = validateSubjectPlan(plan, capacity);
            if (msg) return err(res, msg, 400);

            // One plan cannot describe sections that teach different subjects —
            // it would quietly write the wrong requirements onto some of them.
            if (classId && sectionIds.length > 1) {
                const bySection = await subjectsBySection(classId, sectionIds);
                const planned = plan
                    .filter((r) => (Number(r.weeklyPeriods) || 0) > 0)
                    .map((r) => ({ id: sid(r.subject ?? r._id ?? r.subjectId), name: r.subjectName || 'A subject' }));
                const gaps = planned.filter((x) => [...bySection.values()].some((set) => !set.has(x.id)));
                if (gaps.length) {
                    return err(res, `These sections do not teach the same subjects (${gaps.map((x) => x.name).join(', ')} is not taught in every section). Generate them one section at a time, or give every section the same subjects.`, 400);
                }
            }
            await applySubjectPlan({
                req, year, sectionIds, plan,
                daysBySection: await workingDaysBySection(req.schoolId, year._id, sectionIds),
            });
        }

        const versionNumber = await persistence.nextVersionNumber(req.schoolId, year._id);
        const version = await TimetableVersion.create({
            school: req.schoolId,
            academicYear: year._id,
            versionNumber,
            label: req.body.label || `Version ${versionNumber}`,
            description: req.body.description || '',
            status: 'generating',
            scopeType,
            scopeClasses: classId ? [classId] : (req.body.classIds || []).filter(Boolean),
            sections: sectionIds,
            options: { ...tt.DEFAULT_OPTIONS, ...(req.body.options || {}) },
            seed: Number(req.body.seed) || newSeed(),
            basedOn: req.body.basedOn || null,
            progress: initialProgress(),
            generatedBy: req.userId,
            createdBy: req.userId,
        });

        await logAudit(req, 'generate', 'Version', version._id,
            `Started generation of ${version.label} (${sections.length} section(s))`,
            { scopeType, classId, sections: sections.length, seed: version.seed, planRows: plan?.length || 0 }, version._id);

        // Fire and forget — the client polls /progress.
        setImmediate(() => runGeneration(version._id, req.schoolId));

        ok(res, {
            versionId: version._id,
            versionNumber,
            status: 'generating',
            sections: sections.length,
            progress: version.progress,
        }, 202);
    } catch (e) { err(res, e, e.status); }
};

exports.getProgress = async (req, res) => {
    try {
        const version = await TimetableVersion.findOne({ _id: req.params.id, school: req.schoolId })
            .select('status progress stats conflictCount errorCount warningCount versionNumber label').lean();
        if (!version) return err(res, 'Timetable version not found', 404);
        ok(res, version);
    } catch (e) { err(res, e, e.status); }
};

exports.regenerate = async (req, res) => {
    try {
        const source = await getOwnedVersion(req, req.params.id);
        const versionNumber = await persistence.nextVersionNumber(req.schoolId, source.academicYear);

        const running = await TimetableVersion.findOne({
            school: req.schoolId, academicYear: source.academicYear, status: 'generating', isDeleted: false,
        }).lean();
        if (running) return err(res, 'A timetable is already being generated for this academic year.', 409);

        const version = await TimetableVersion.create({
            school: req.schoolId,
            academicYear: source.academicYear,
            versionNumber,
            label: req.body.label || `Version ${versionNumber} (regenerated)`,
            description: `Regenerated from version ${source.versionNumber}`,
            status: 'generating',
            scopeType: source.scopeType,
            scopeClasses: source.scopeClasses,
            sections: source.sections,
            options: { ...source.options, ...(req.body.options || {}) },
            // A new seed by default, or the old one to reproduce the same run.
            seed: req.body.reuseSeed ? source.seed : (Number(req.body.seed) || newSeed()),
            basedOn: source._id,
            progress: initialProgress(),
            generatedBy: req.userId,
            createdBy: req.userId,
        });

        await logAudit(req, 'regenerate', 'Version', version._id,
            `Regenerated from version ${source.versionNumber}`, { basedOn: source._id }, version._id);
        setImmediate(() => runGeneration(version._id, req.schoolId));
        ok(res, { versionId: version._id, versionNumber, status: 'generating' }, 202);
    } catch (e) { err(res, e, e.status); }
};

/* ══════════════════════════════════════════════════════════════════════════
   VERSIONS
   ══════════════════════════════════════════════════════════════════════════ */

exports.listVersions = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.query.yearId);
        const filter = { school: req.schoolId, isDeleted: false };
        if (year) filter.academicYear = year._id;
        if (req.query.status) filter.status = req.query.status;

        const versions = await TimetableVersion.find(filter)
            .populate('generatedBy', 'name')
            .populate('publishedBy', 'name')
            .sort({ versionNumber: -1 })
            .lean();

        ok(res, {
            selectedYearId: year?._id || null,
            yearName: year?.yearName || '',
            versions: versions.map((v) => ({
                ...v,
                sectionCount: (v.sections || []).length,
                sections: undefined,
            })),
        });
    } catch (e) { err(res, e, e.status); }
};

exports.getVersion = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        const [entries, conflicts, sections, subjects, teachers, rooms, timetables, year] = await Promise.all([
            TimetableVersionEntry.find({ version: version._id }).lean(),
            TimetableConflict.find({ version: version._id }).sort({ severity: 1, createdAt: 1 }).lean(),
            ClassSection.find({ _id: { $in: version.sections || [] } }).populate('class', 'className classNumber').lean(),
            Subject.find({ school: req.schoolId }).select('subjectName subjectCode type').lean(),
            User.find({ school: req.schoolId, role: 'teacher' }).select('name').lean(),
            Room.find({ school: req.schoolId }).select('roomName roomNumber roomType capacity building').lean(),
            Timetable.find({ section: { $in: version.sections || [] }, academicYear: version.academicYear }).lean(),
            AcademicYear.findById(version.academicYear).select('yearName').lean(),
        ]);

        const school = await School.findById(req.schoolId).select('leaveSettings').lean();
        const config = await TimetableConfig.findOne({ school: req.schoolId, academicYear: version.academicYear }).lean();
        const satWorking = school?.leaveSettings?.saturdayWorking !== false;

        const ttBySection = new Map(timetables.map((t) => [sid(t.section), t]));
        const structures = {};
        for (const s of sections) {
            const stored = ttBySection.get(sid(s._id))?.periodsStructure;
            const fromConfig = config?.periodTemplate;
            const rows = (stored && stored.length) ? stored : ((fromConfig && fromConfig.length) ? fromConfig : tt.derivePeriods(s));
            structures[sid(s._id)] = tt.normalisePeriods(rows);
        }

        ok(res, {
            version,
            yearName: year?.yearName || '',
            entries,
            conflicts,
            structures,
            saturdayTemplate: tt.normalisePeriods(config?.saturdayTemplate),
            days: (config?.workingDays?.length ? config.workingDays : (satWorking ? tt.DAYS.slice(0, 6) : tt.DAYS.slice(0, 5))),
            sections: sections.map((s) => ({
                _id: s._id,
                sectionName: s.sectionName,
                className: s.class?.className || '',
                classNumber: s.class?.classNumber ?? 0,
                label: `${s.class?.className || ''} ${s.sectionName || ''}`.trim(),
                strength: s.currentCount || 0,
                openOnSaturday: s.openOnSaturday,
            })).sort((a, b) => a.classNumber - b.classNumber || a.sectionName.localeCompare(b.sectionName)),
            subjects,
            teachers,
            rooms,
        });
    } catch (e) { err(res, e, e.status); }
};

exports.getConflicts = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        const filter = { version: version._id };
        if (req.query.severity) filter.severity = req.query.severity;
        if (req.query.type) filter.type = req.query.type;

        const conflicts = await TimetableConflict.find(filter)
            .populate('section', 'sectionName class')
            .populate('teacher', 'name')
            .populate('subject', 'subjectName')
            .populate('room', 'roomName')
            .sort({ severity: 1, createdAt: 1 })
            .lean();

        ok(res, {
            conflicts,
            summary: {
                total: conflicts.length,
                errors: conflicts.filter((c) => c.severity === 'ERROR').length,
                warnings: conflicts.filter((c) => c.severity === 'WARNING').length,
                info: conflicts.filter((c) => c.severity === 'INFO').length,
            },
        });
    } catch (e) { err(res, e, e.status); }
};

exports.updateVersion = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        if (version.status === 'published') return err(res, 'A published version cannot be renamed', 400);

        const updated = await TimetableVersion.findByIdAndUpdate(version._id, {
            $set: {
                label: req.body.label ?? version.label,
                description: req.body.description ?? version.description,
            },
        }, { new: true });
        await logAudit(req, 'update', 'Version', version._id, `Renamed version to "${updated.label}"`, {}, version._id);
        ok(res, updated);
    } catch (e) { err(res, e, e.status); }
};

exports.duplicateVersion = async (req, res) => {
    try {
        const source = await getOwnedVersion(req, req.params.id);
        const versionNumber = await persistence.nextVersionNumber(req.schoolId, source.academicYear);

        const copy = await TimetableVersion.create({
            school: req.schoolId,
            academicYear: source.academicYear,
            versionNumber,
            label: req.body.label || `Copy of ${source.label || `Version ${source.versionNumber}`}`,
            description: `Duplicated from version ${source.versionNumber}`,
            status: 'draft',
            scopeType: source.scopeType,
            scopeClasses: source.scopeClasses,
            sections: source.sections,
            options: source.options,
            seed: source.seed,
            basedOn: source._id,
            stats: source.stats,
            generatedBy: source.generatedBy,
            generatedAt: source.generatedAt,
            createdBy: req.userId,
        });

        await persistence.copyEntries(source._id, copy._id, req.schoolId);
        const conflicts = await TimetableConflict.find({ version: source._id }).lean();
        const counts = await persistence.replaceConflicts(copy._id, req.schoolId, conflicts.map((c) => ({
            type: c.type, severity: c.severity, sectionId: c.section, classId: c.class, teacherId: c.teacher,
            subjectId: c.subject, roomId: c.room, dayOfWeek: c.dayOfWeek, periodNumber: c.periodNumber,
            description: c.description, suggestion: c.suggestion, meta: c.meta,
        })));
        await TimetableVersion.findByIdAndUpdate(copy._id, { $set: { ...counts } });

        await logAudit(req, 'duplicate', 'Version', copy._id,
            `Duplicated version ${source.versionNumber} into version ${versionNumber}`, {}, copy._id);
        ok(res, copy, 201);
    } catch (e) { err(res, e, e.status); }
};

exports.archiveVersion = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        if (version.status === 'published') {
            return err(res, 'Publish a replacement before archiving the live timetable', 400);
        }
        await TimetableVersion.findByIdAndUpdate(version._id, { $set: { status: 'archived', archivedAt: new Date() } });
        await logAudit(req, 'archive', 'Version', version._id, `Archived version ${version.versionNumber}`, {}, version._id);
        ok(res, { archived: true });
    } catch (e) { err(res, e, e.status); }
};

exports.deleteVersion = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        if (version.status === 'published') return err(res, 'The published timetable cannot be deleted', 400);
        // Soft delete: the audit trail keeps pointing at a row that still exists.
        await TimetableVersion.findByIdAndUpdate(version._id, { $set: { isDeleted: true } });
        await logAudit(req, 'delete', 'Version', version._id, `Deleted version ${version.versionNumber}`, {}, version._id);
        ok(res, { deleted: true });
    } catch (e) { err(res, e, e.status); }
};

exports.compareVersions = async (req, res) => {
    try {
        const [a, b] = await Promise.all([
            getOwnedVersion(req, req.params.id),
            getOwnedVersion(req, req.params.otherId),
        ]);
        const [ea, eb, sections, subjects, teachers] = await Promise.all([
            TimetableVersionEntry.find({ version: a._id }).lean(),
            TimetableVersionEntry.find({ version: b._id }).lean(),
            ClassSection.find({ _id: { $in: uniq([...(a.sections || []), ...(b.sections || [])]).map(String) } })
                .populate('class', 'className').lean(),
            Subject.find({ school: req.schoolId }).select('subjectName').lean(),
            User.find({ school: req.schoolId, role: 'teacher' }).select('name').lean(),
        ]);

        const label = new Map(sections.map((s) => [sid(s._id), `${s.class?.className || ''} ${s.sectionName}`.trim()]));
        const subjectName = new Map(subjects.map((s) => [sid(s._id), s.subjectName]));
        const teacherName = new Map(teachers.map((t) => [sid(t._id), t.name]));

        const index = (rows) => new Map(rows.map((r) => [`${sid(r.section)}#${r.dayOfWeek}#${r.periodNumber}`, r]));
        const ia = index(ea);
        const ib = index(eb);
        const mergedIds = (r) => (r.additionalSubjects || []).map((m) => sid(m.subject ?? m.subjectId)).sort().join(',');
        const describe = (r) => (r
            ? {
                subject: [sid(r.subject), ...(r.additionalSubjects || []).map((m) => sid(m.subject ?? m.subjectId))]
                    .map((id) => subjectName.get(id) || '—').join(' + '),
                teacher: uniq([sid(r.teacher), ...(r.additionalSubjects || []).map((m) => sid(m.teacher ?? m.teacherId))])
                    .map((id) => teacherName.get(id) || '').filter(Boolean).join(' · '),
                room: sid(r.room),
            }
            : null);

        const changes = [];
        for (const key of new Set([...ia.keys(), ...ib.keys()])) {
            const [sectionId, day, period] = key.split('#');
            const from = ia.get(key);
            const to = ib.get(key);
            const same = from && to
                && sid(from.subject) === sid(to.subject)
                && sid(from.teacher) === sid(to.teacher)
                && sid(from.room) === sid(to.room)
                && mergedIds(from) === mergedIds(to);
            if (same) continue;
            changes.push({
                sectionId, section: label.get(sectionId) || 'Section', dayOfWeek: day, periodNumber: Number(period),
                from: describe(from), to: describe(to),
                kind: !from ? 'added' : !to ? 'removed' : 'changed',
            });
        }
        changes.sort((x, y) => x.section.localeCompare(y.section)
            || tt.DAYS.indexOf(x.dayOfWeek) - tt.DAYS.indexOf(y.dayOfWeek)
            || x.periodNumber - y.periodNumber);

        ok(res, {
            from: { _id: a._id, versionNumber: a.versionNumber, label: a.label, status: a.status, entries: ea.length },
            to: { _id: b._id, versionNumber: b.versionNumber, label: b.label, status: b.status, entries: eb.length },
            changes,
            summary: {
                total: changes.length,
                added: changes.filter((c) => c.kind === 'added').length,
                removed: changes.filter((c) => c.kind === 'removed').length,
                changed: changes.filter((c) => c.kind === 'changed').length,
            },
        });
    } catch (e) { err(res, e, e.status); }
};

/* ══════════════════════════════════════════════════════════════════════════
   MANUAL EDITING
   ══════════════════════════════════════════════════════════════════════════ */

const EDITABLE = new Set(['draft', 'generated', 'conflict', 'validated', 'failed']);

async function assertEditable(req, version) {
    if (!EDITABLE.has(version.status)) {
        const e = new Error(version.status === 'published'
            ? 'The published timetable cannot be edited directly — duplicate it into a new draft first.'
            : `A ${version.status} version cannot be edited`);
        e.status = 400;
        throw e;
    }
    await claimEditLock(req, version);
}

/** Re-run validation for a version and persist the resulting conflicts. */
async function revalidate(version, extraEntries) {
    const { ctx } = await contextForVersion(version);
    const entries = extraEntries || await TimetableVersionEntry.find({ version: version._id }).lean();
    const report = tt.validate(ctx, shapeEntries(entries));
    const counts = await persistence.replaceConflicts(version._id, version.school, dedupeConflicts(report.conflicts));
    return { report, counts, ctx, entries };
}

exports.moveEntry = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        await assertEditable(req, version);

        const { dayOfWeek, periodNumber } = req.body;
        if (!tt.DAYS.includes(dayOfWeek)) return err(res, 'Invalid day', 400);
        if (!(Number(periodNumber) > 0)) return err(res, 'Invalid period', 400);

        const entry = await TimetableVersionEntry.findOne({ _id: req.params.entryId, version: version._id }).lean();
        if (!entry) return err(res, 'Timetable entry not found', 404);
        if (entry.isLocked && !req.body.override) {
            return err(res, 'This period is locked. Unlock it before moving.', 400);
        }

        const { ctx } = await contextForVersion(version);
        const entries = await TimetableVersionEntry.find({ version: version._id }).lean();
        const shaped = shapeEntries(entries);

        const check = tt.validateMove(ctx, shaped, {
            entryId: sid(entry._id),
            dayOfWeek,
            periodNumber: Number(periodNumber),
            teacherId: req.body.teacherId,
            roomId: req.body.roomId,
        });

        // Hard conflicts block the move. An explicit override is allowed only
        // with a reason, and it is written to the audit trail.
        const override = req.body.override === true;
        if (!check.ok && !override) {
            return res.status(409).json({
                success: false,
                message: check.blocking[0]?.description || 'Cannot move this timetable entry.',
                data: { conflicts: check.blocking, canOverride: true },
            });
        }
        if (!check.ok && override && !String(req.body.overrideReason || '').trim()) {
            return err(res, 'An override reason is required to force a conflicting move', 400);
        }

        await TimetableVersionEntry.findByIdAndUpdate(entry._id, {
            $set: {
                dayOfWeek,
                periodNumber: Number(periodNumber),
                teacher: req.body.teacherId ?? entry.teacher,
                room: req.body.roomId !== undefined ? req.body.roomId : entry.room,
                isManual: true,
            },
        });

        const { counts } = await revalidate(version);
        await TimetableVersion.findByIdAndUpdate(version._id, {
            $set: { ...counts, status: counts.errorCount > 0 ? 'conflict' : 'draft', validatedAt: null },
        });

        const subject = await Subject.findById(entry.subject).select('subjectName').lean();
        await logAudit(req, override ? 'override_move' : 'move', 'Entry', entry._id,
            `${subject?.subjectName || 'Period'}: ${entry.dayOfWeek} P${entry.periodNumber} → ${dayOfWeek} P${periodNumber}`,
            {
                from: { dayOfWeek: entry.dayOfWeek, periodNumber: entry.periodNumber },
                to: { dayOfWeek, periodNumber: Number(periodNumber) },
                override,
                overrideReason: req.body.overrideReason || '',
                conflicts: override ? check.blocking : [],
            }, version._id);

        ok(res, { moved: true, warnings: check.conflicts.filter((c) => c.severity !== 'ERROR'), ...counts });
    } catch (e) { err(res, e, e.status); }
};

exports.createEntry = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        await assertEditable(req, version);

        const msg = validateBody(req.body, {
            section: { label: 'Section', required: true },
            subject: { label: 'Subject', required: true },
            dayOfWeek: { label: 'Day', required: true, enum: tt.DAYS },
            periodNumber: { label: 'Period', required: true, type: 'number', min: 1 },
        });
        if (msg) return err(res, msg, 400);
        if (!(version.sections || []).map(String).includes(String(req.body.section))) {
            return err(res, 'That section is not part of this timetable version', 400);
        }

        const shaped = shapeEntries(await TimetableVersionEntry.find({ version: version._id }).lean());
        const candidate = {
            _id: 'new', sectionId: String(req.body.section), subjectId: String(req.body.subject),
            teacherId: req.body.teacher || null, roomId: req.body.room || null,
            dayOfWeek: req.body.dayOfWeek, periodNumber: Number(req.body.periodNumber),
            additionalSubjects: [],
        };

        const { ctx } = await contextForVersion(version);
        const check = tt.validateMove(ctx, [...shaped, candidate], { entryId: 'new', dayOfWeek: candidate.dayOfWeek, periodNumber: candidate.periodNumber });
        if (!check.ok && req.body.override !== true) {
            return res.status(409).json({
                success: false,
                message: check.blocking[0]?.description || 'Cannot add a period here.',
                data: { conflicts: check.blocking, canOverride: true },
            });
        }

        const entry = await TimetableVersionEntry.create({
            version: version._id,
            school: req.schoolId,
            section: req.body.section,
            dayOfWeek: req.body.dayOfWeek,
            periodNumber: Number(req.body.periodNumber),
            subject: req.body.subject,
            teacher: req.body.teacher || null,
            room: req.body.room || null,
            isManual: true,
            note: req.body.note || '',
        });

        const { counts } = await revalidate(version);
        await TimetableVersion.findByIdAndUpdate(version._id, {
            $set: { ...counts, status: counts.errorCount > 0 ? 'conflict' : 'draft', validatedAt: null },
        });
        await logAudit(req, 'create', 'Entry', entry._id,
            `Added a period at ${entry.dayOfWeek} P${entry.periodNumber}`, {}, version._id);
        ok(res, { entry, ...counts }, 201);
    } catch (e) {
        if (e.code === 11000) return err(res, 'That slot already has a subject', 409);
        err(res, e, e.status);
    }
};

exports.updateEntry = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        await assertEditable(req, version);

        const entry = await TimetableVersionEntry.findOne({ _id: req.params.entryId, version: version._id }).lean();
        if (!entry) return err(res, 'Timetable entry not found', 404);

        const $set = { isManual: true };
        if (req.body.subject !== undefined) $set.subject = req.body.subject;
        if (req.body.teacher !== undefined) $set.teacher = req.body.teacher || null;
        if (req.body.room !== undefined) $set.room = req.body.room || null;
        if (req.body.note !== undefined) $set.note = req.body.note || '';
        if (req.body.isLocked !== undefined) $set.isLocked = !!req.body.isLocked;

        await TimetableVersionEntry.findByIdAndUpdate(entry._id, { $set });

        const { counts } = await revalidate(version);
        await TimetableVersion.findByIdAndUpdate(version._id, {
            $set: { ...counts, status: counts.errorCount > 0 ? 'conflict' : 'draft', validatedAt: null },
        });
        await logAudit(req, 'update', 'Entry', entry._id,
            `Edited the period at ${entry.dayOfWeek} P${entry.periodNumber}`, { changes: $set }, version._id);
        ok(res, { updated: true, ...counts });
    } catch (e) { err(res, e, e.status); }
};

exports.deleteEntry = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        await assertEditable(req, version);

        const entry = await TimetableVersionEntry.findOne({ _id: req.params.entryId, version: version._id }).lean();
        if (!entry) return err(res, 'Timetable entry not found', 404);
        await TimetableVersionEntry.deleteOne({ _id: entry._id });

        const { counts } = await revalidate(version);
        await TimetableVersion.findByIdAndUpdate(version._id, {
            $set: { ...counts, status: counts.errorCount > 0 ? 'conflict' : 'draft', validatedAt: null },
        });
        await logAudit(req, 'delete', 'Entry', entry._id,
            `Cleared the period at ${entry.dayOfWeek} P${entry.periodNumber}`, {}, version._id);
        ok(res, { deleted: true, ...counts });
    } catch (e) { err(res, e, e.status); }
};

/** Release this admin's edit lock (called when the preview screen unmounts). */
exports.releaseLock = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        if (sid(version.lockedBy) === String(req.userId)) {
            await TimetableVersion.findByIdAndUpdate(version._id, { $set: { lockedBy: null, lockedAt: null } });
        }
        ok(res, { released: true });
    } catch (e) { err(res, e, e.status); }
};

/* ══════════════════════════════════════════════════════════════════════════
   VALIDATE & PUBLISH
   ══════════════════════════════════════════════════════════════════════════ */

exports.validateVersion = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        const { report, counts } = await revalidate(version);

        await TimetableVersion.findByIdAndUpdate(version._id, {
            $set: {
                ...counts,
                status: counts.errorCount > 0 ? 'conflict' : 'validated',
                validatedAt: counts.errorCount > 0 ? null : new Date(),
            },
        });
        await logAudit(req, 'validate', 'Version', version._id,
            `Validated version ${version.versionNumber}: ${counts.errorCount} error(s), ${counts.warningCount} warning(s)`,
            counts, version._id);

        ok(res, {
            valid: report.valid,
            ...counts,
            conflicts: report.conflicts,
            message: report.valid
                ? 'Timetable is ready to publish.'
                : `${counts.errorCount} issue(s) must be resolved before publishing.`,
        });
    } catch (e) { err(res, e, e.status); }
};

/**
 * Live corrections that publishing is about to reproject over.
 *
 * Publish replaces every entry of every section in the version, so anything
 * typed into the live grid since the last publish disappears. The draft side has
 * `preserveManualEdits` for exactly this; the live side had nothing, so the loss
 * was silent. Now it is counted, listed, and has to be acknowledged.
 */
/**
 * Teachers and rooms this draft would collide with in sections it does not own.
 *
 * The solver only ever sees the sections in its own scope, so a version is
 * internally perfect and can still put a teacher in two places once it lands
 * beside a timetable published from a different run. That is how five genuine
 * double-bookings reached the live grid unnoticed. Publish is the last moment
 * anyone can catch it, so it is checked here against what is already live.
 */
async function clashesOutsideVersion(version, entries) {
    const scope = new Set((version.sections || []).map(String));
    const teacherIds = uniq(entries.map((e) => sid(e.teacher)).filter(Boolean));
    const roomIds    = uniq(entries.map((e) => sid(e.room)).filter(Boolean));
    if (!teacherIds.length && !roomIds.length) return [];

    // Every OTHER section's live timetable for this year.
    const timetables = await Timetable.find({ academicYear: version.academicYear })
        .select('_id section').lean();
    const outside = timetables.filter((t) => !scope.has(sid(t.section)));
    if (!outside.length) return [];

    const live = await TimetableEntry.find({
        timetable: { $in: outside.map((t) => t._id) },
        $or: [
            ...(teacherIds.length ? [{ teacher: { $in: teacherIds } }] : []),
            ...(roomIds.length    ? [{ room:    { $in: roomIds } }]    : []),
        ],
    }).select('timetable dayOfWeek periodNumber teacher room mergedSections').lean();
    if (!live.length) return [];

    const sectionOf = new Map(outside.map((t) => [sid(t._id), sid(t.section)]));
    const [sections, teachers, rooms] = await Promise.all([
        ClassSection.find({ _id: { $in: uniq([...sectionOf.values()]) } }).select('sectionName').lean(),
        User.find({ _id: { $in: teacherIds } }).select('name').lean(),
        Room.find({ _id: { $in: roomIds } }).select('roomName').lean(),
    ]);
    const sectionName = new Map(sections.map((x) => [sid(x._id), x.sectionName]));
    const teacherName = new Map(teachers.map((x) => [sid(x._id), x.name]));
    const roomName    = new Map(rooms.map((x) => [sid(x._id), x.roomName]));

    // Index the live side once — entries × live is otherwise quadratic.
    const bySlot = new Map();
    for (const l of live) {
        const key = `${l.dayOfWeek}#${l.periodNumber}`;
        if (!bySlot.has(key)) bySlot.set(key, []);
        bySlot.get(key).push(l);
    }

    const out = [];
    for (const e of entries) {
        for (const l of bySlot.get(`${e.dayOfWeek}#${e.periodNumber}`) || []) {
            const otherSection = sectionOf.get(sid(l.timetable));
            // A merged lesson is the same lesson in both places, not a collision.
            const shared = (l.mergedSections || []).map(sid).includes(sid(e.section))
                || (e.mergedSections || []).map(sid).includes(otherSection);
            if (shared) continue;
            const where = `${sectionName.get(otherSection) || 'another section'} at ${e.dayOfWeek} P${e.periodNumber}`;
            if (e.teacher && sid(l.teacher) === sid(e.teacher)) {
                out.push({
                    kind: 'teacher',
                    name: teacherName.get(sid(e.teacher)) || 'A teacher',
                    dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                    message: `${teacherName.get(sid(e.teacher)) || 'A teacher'} is already teaching ${where}`,
                });
            }
            if (e.room && sid(l.room) === sid(e.room)) {
                out.push({
                    kind: 'room',
                    name: roomName.get(sid(e.room)) || 'A room',
                    dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                    message: `${roomName.get(sid(e.room)) || 'A room'} is already booked by ${where}`,
                });
            }
        }
    }
    // The same teacher clashing across six periods is one problem, listed six
    // times, so collapse to one line per person or room per slot.
    const seen = new Set();
    return out.filter((c) => {
        const k = `${c.kind}#${c.name}#${c.dayOfWeek}#${c.periodNumber}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

async function liveEditsAtRisk(version) {
    const timetables = await Timetable.find({
        section: { $in: version.sections || [] }, academicYear: version.academicYear,
    }).select('_id section').lean();
    if (!timetables.length) return [];

    const sectionOf = new Map(timetables.map((t) => [sid(t._id), sid(t.section)]));
    const edits = await TimetableEntry.find({
        timetable: { $in: timetables.map((t) => t._id) }, isManual: true,
    }).select('timetable dayOfWeek periodNumber subject teacher').lean();
    if (!edits.length) return [];

    const [sections, subjects] = await Promise.all([
        ClassSection.find({ _id: { $in: [...new Set(sectionOf.values())] } }).select('sectionName').lean(),
        Subject.find({ _id: { $in: uniq(edits.map((e) => sid(e.subject))) } }).select('subjectName').lean(),
    ]);
    const sectionName = new Map(sections.map((x) => [sid(x._id), x.sectionName]));
    const subjectName = new Map(subjects.map((x) => [sid(x._id), x.subjectName]));

    return edits.map((e) => ({
        section: sectionOf.get(sid(e.timetable)),
        sectionName: sectionName.get(sectionOf.get(sid(e.timetable))) || 'Section',
        dayOfWeek: e.dayOfWeek,
        periodNumber: e.periodNumber,
        subjectName: subjectName.get(sid(e.subject)) || 'Subject',
    }));
}

/** GET — what publishing this version would overwrite, before committing to it. */
exports.publishPreview = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        const entries = await TimetableVersionEntry.find({ version: version._id }).lean();
        const [atRisk, outside] = await Promise.all([
            liveEditsAtRisk(version),
            clashesOutsideVersion(version, entries),
        ]);
        ok(res, {
            liveEdits: atRisk,
            count: atRisk.length,
            sections: uniq(atRisk.map((x) => x.section)).length,
            outsideClashes: outside,
        });
    } catch (e) { err(res, e, e.status); }
};

exports.publishVersion = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        if (version.status === 'published') return err(res, 'This version is already published', 400);
        if (version.status === 'generating') return err(res, 'Generation is still running', 400);
        if (version.status === 'archived') return err(res, 'Restore this version before publishing it', 400);

        // Never publish blind: revalidate from scratch, whatever the stored state says.
        const { report, counts, input } = await (async () => {
            const { ctx, input: loaded } = await contextForVersion(version);
            const entries = await TimetableVersionEntry.find({ version: version._id }).lean();
            const r = tt.validate(ctx, shapeEntries(entries));
            const c = await persistence.replaceConflicts(version._id, version.school, dedupeConflicts(r.conflicts));
            return { report: r, counts: c, input: loaded };
        })();

        if (!report.valid) {
            await TimetableVersion.findByIdAndUpdate(version._id, { $set: { ...counts, status: 'conflict', validatedAt: null } });
            return res.status(400).json({
                success: false,
                message: `Cannot publish: ${counts.errorCount} unresolved issue(s).`,
                data: { conflicts: report.conflicts.filter((c) => c.severity === 'ERROR').slice(0, 20), ...counts },
            });
        }

        const entries = await TimetableVersionEntry.find({ version: version._id }).lean();
        if (!entries.length) return err(res, 'This version has no periods to publish', 400);

        // Hand edits made in the live grid are about to be replaced. Say so, and
        // make the admin agree to it rather than discovering it afterwards.
        // …and so is a clash with a section this version does not own.
        const overwrite = req.body?.overwriteLiveEdits === true || req.body?.overwriteLiveEdits === 'true';
        const outside = await clashesOutsideVersion(version, entries);
        if (outside.length && !overwrite) {
            return res.status(409).json({
                success: false,
                message: `This timetable clashes with ${outside.length} already-published period(s) in other sections.`,
                data: { outsideClashes: outside, blocked: true },
            });
        }

        const atRisk = await liveEditsAtRisk(version);
        if (atRisk.length && !overwrite) {
            return res.status(409).json({
                success: false,
                message: `Publishing replaces ${atRisk.length} hand-edited period(s) in the live timetable.`,
                data: { liveEdits: atRisk, blocked: true },
            });
        }

        const result = await persistence.publishVersion({
            version,
            entries,
            userId: req.userId,
            structureBySection: structureFromInput(input),
        });

        await logAudit(req, 'publish', 'Version', version._id,
            `Published version ${version.versionNumber} — ${result.entries} periods across ${result.sections} section(s)`,
            result, version._id);

        // Fan-out runs after the response; publishing must not wait on email.
        setImmediate(() => notifyPublished(req, version, entries).catch((e) => console.error('[timetable-notify]', e.message)));

        ok(res, {
            published: true,
            ...result,
            message: 'Timetable published. Teachers and students can now see it.',
        });
    } catch (e) { err(res, e, e.status); }
};

exports.restoreVersion = async (req, res) => {
    try {
        const source = await getOwnedVersion(req, req.params.id);
        const versionNumber = await persistence.nextVersionNumber(req.schoolId, source.academicYear);

        const copy = await TimetableVersion.create({
            school: req.schoolId,
            academicYear: source.academicYear,
            versionNumber,
            label: `Restored from version ${source.versionNumber}`,
            description: source.description,
            status: 'draft',
            scopeType: source.scopeType,
            scopeClasses: source.scopeClasses,
            sections: source.sections,
            options: source.options,
            seed: source.seed,
            basedOn: source._id,
            stats: source.stats,
            createdBy: req.userId,
        });
        await persistence.copyEntries(source._id, copy._id, req.schoolId);
        const { counts } = await revalidate(copy);
        await TimetableVersion.findByIdAndUpdate(copy._id, {
            $set: { ...counts, status: counts.errorCount > 0 ? 'conflict' : 'draft' },
        });

        await logAudit(req, 'restore', 'Version', copy._id,
            `Restored version ${source.versionNumber} as a new draft (version ${versionNumber})`, {}, copy._id);
        ok(res, { versionId: copy._id, versionNumber }, 201);
    } catch (e) { err(res, e, e.status); }
};

/** Tell affected teachers and students their schedule changed. */
async function notifyPublished(req, version, entries) {
    const { notify } = require('../services/notifyService');
    const sections = await ClassSection.find({ _id: { $in: version.sections || [] } })
        .populate('class', 'className').select('sectionName class enrolledStudents').lean();

    const teacherIds = uniq(entries.map((e) => sid(e.teacher)));
    const studentIds = uniq(sections.flatMap((s) => (s.enrolledStudents || []).map(String)));

    if (teacherIds.length) {
        await notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🗓️ New timetable published',
            body: 'Your teaching schedule has been updated. Open Timetable to see your new periods.',
            recipients: teacherIds,
            link: { type: 'timetable' },
        });
    }
    if (studentIds.length) {
        const names = sections.map((s) => `${s.class?.className || ''} ${s.sectionName || ''}`.trim()).filter(Boolean);
        await notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🗓️ New class timetable',
            body: `The timetable for ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} has been updated.`,
            recipients: studentIds,
            link: { type: 'timetable' },
        });
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   AUDIT
   ══════════════════════════════════════════════════════════════════════════ */

exports.listAudit = async (req, res) => {
    try {
        const filter = { school: req.schoolId };
        if (req.query.versionId) filter.version = req.query.versionId;
        if (req.query.actionType) filter.actionType = req.query.actionType;

        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const [logs, total] = await Promise.all([
            TimetableAuditLog.find(filter).populate('user', 'name').sort({ createdAt: -1 })
                .skip(Number(req.query.skip) || 0).limit(limit).lean(),
            TimetableAuditLog.countDocuments(filter),
        ]);
        ok(res, { logs, total });
    } catch (e) { err(res, e, e.status); }
};

/* ══════════════════════════════════════════════════════════════════════════
   EXPORT
   ══════════════════════════════════════════════════════════════════════════ */

/** Shared shaping used by both the PDF and the Excel export. */
async function buildExportModel(req, version, view) {
    const [entries, sections, subjects, teachers, rooms, timetables, year, config] = await Promise.all([
        TimetableVersionEntry.find({ version: version._id }).lean(),
        ClassSection.find({ _id: { $in: version.sections || [] } }).populate('class', 'className classNumber').lean(),
        Subject.find({ school: req.schoolId }).select('subjectName').lean(),
        User.find({ school: req.schoolId, role: 'teacher' }).select('name').lean(),
        Room.find({ school: req.schoolId }).select('roomName roomNumber').lean(),
        Timetable.find({ section: { $in: version.sections || [] }, academicYear: version.academicYear }).lean(),
        AcademicYear.findById(version.academicYear).select('yearName').lean(),
        TimetableConfig.findOne({ school: req.schoolId, academicYear: version.academicYear }).lean(),
    ]);

    const subjectName = new Map(subjects.map((s) => [sid(s._id), s.subjectName]));
    const teacherName = new Map(teachers.map((t) => [sid(t._id), t.name]));
    const roomName    = new Map(rooms.map((r) => [sid(r._id), r.roomName]));
    const ttBySection = new Map(timetables.map((t) => [sid(t.section), t]));
    const sectionById = new Map(sections.map((s) => [sid(s._id), s]));

    const structureFor = (sectionId) => {
        const stored = ttBySection.get(sectionId)?.periodsStructure;
        if (stored?.length) return tt.normalisePeriods(stored);
        if (config?.periodTemplate?.length) return tt.normalisePeriods(config.periodTemplate);
        const section = sectionById.get(sectionId);
        return section ? tt.normalisePeriods(tt.derivePeriods(section)) : [];
    };

    const days = config?.workingDays?.length ? config.workingDays : tt.DAYS.slice(0, 6);
    const usedDays = days.filter((d) => entries.some((e) => e.dayOfWeek === d));

    // A merged slot is ONE row in a class grid ("Maths + Computer") but a
    // separate line in every teacher-wise and room-wise view.
    const occupants = explodeEntries(entries);
    const slotSubjects = (e) => [sid(e.subject), ...(e.additionalSubjects || []).map((m) => sid(m.subject ?? m.subjectId))];
    const slotLabel = (e) => slotSubjects(e).map((id) => subjectName.get(id) || '—').join(' + ');
    const slotStaff = (e) => uniq([
        sid(e.teacher), ...(e.additionalSubjects || []).map((m) => sid(m.teacher ?? m.teacherId)),
    ]).map((id) => teacherName.get(id) || '').filter(Boolean).join(' · ');
    const slotRooms = (e) => uniq([
        sid(e.room), ...(e.additionalSubjects || []).map((m) => sid(m.room ?? m.roomId)),
    ]).map((id) => roomName.get(id) || '').filter(Boolean).join(' · ');

    return {
        entries, occupants, sections, sectionById, subjectName, teacherName, roomName,
        slotLabel, slotStaff, slotRooms, structureFor, year,
        days: usedDays.length ? usedDays : days.slice(0, 5), view,
    };
}

exports.exportVersion = async (req, res) => {
    try {
        const version = await getOwnedVersion(req, req.params.id);
        const view = ['class', 'teacher', 'room'].includes(req.query.view) ? req.query.view : 'class';
        const format = req.query.format === 'excel' ? 'excel' : 'pdf';
        const model = await buildExportModel(req, version, view);

        if (format === 'excel') return exportExcel(res, version, model);
        return exportPdf(req, res, version, model);
    } catch (e) {
        console.error('[timetable-export]', e);
        res.status(e.status || 500).send('Failed to generate the timetable export.');
    }
};

async function exportPdf(req, res, version, model) {
    const School = require('../models/School');
    const { generateTimetablePDF, generateMessagePDF } = require('../utils/timetablePdf');
    const school = await School.findById(req.schoolId).lean();
    const { entries, occupants, sections, subjectName, teacherName, roomName, structureFor, year, days, view } = model;
    const { slotLabel, slotStaff, slotRooms } = model;

    const pages = [];

    if (view === 'class') {
        const sorted = [...sections].sort((a, b) =>
            (a.class?.classNumber ?? 0) - (b.class?.classNumber ?? 0) || String(a.sectionName).localeCompare(String(b.sectionName)));
        for (const section of sorted) {
            const secId = sid(section._id);
            const rows = entries.filter((e) => sid(e.section) === secId);
            if (!rows.length) continue;
            pages.push({
                className: section.class?.className || 'Class',
                sectionName: section.sectionName,
                yearName: year?.yearName || '',
                timetable: { periodsStructure: structureFor(secId) },
                entries: rows.map((e) => ({
                    dayOfWeek: e.dayOfWeek,
                    periodNumber: e.periodNumber,
                    subject: { subjectName: slotLabel(e) },
                    teacher: { name: [slotStaff(e), slotRooms(e)].filter(Boolean).join(' · ') },
                })),
                days: days.filter((d) => rows.some((r) => r.dayOfWeek === d)),
            });
        }
    } else if (view === 'teacher') {
        const byTeacher = new Map();
        for (const e of occupants) {
            const t = sid(e.teacher);
            if (!t) continue;
            if (!byTeacher.has(t)) byTeacher.set(t, []);
            byTeacher.get(t).push(e);
        }
        const firstStructure = sections.length ? structureFor(sid(sections[0]._id)) : [];
        for (const [teacherId, rows] of [...byTeacher.entries()].sort((a, b) =>
            (teacherName.get(a[0]) || '').localeCompare(teacherName.get(b[0]) || ''))) {
            pages.push({
                className: teacherName.get(teacherId) || 'Teacher',
                sectionName: 'Schedule',
                yearName: year?.yearName || '',
                timetable: { periodsStructure: firstStructure },
                entries: rows.map((e) => ({
                    dayOfWeek: e.dayOfWeek,
                    periodNumber: e.periodNumber,
                    subject: { subjectName: subjectName.get(sid(e.subject)) || '—' },
                    teacher: { name: model.sectionById.get(sid(e.section))
                        ? `${model.sectionById.get(sid(e.section)).class?.className || ''} ${model.sectionById.get(sid(e.section)).sectionName}`.trim()
                        : '' },
                })),
                days,
            });
        }
    } else {
        const byRoom = new Map();
        for (const e of occupants) {
            const r = sid(e.room);
            if (!r) continue;
            if (!byRoom.has(r)) byRoom.set(r, []);
            byRoom.get(r).push(e);
        }
        const firstStructure = sections.length ? structureFor(sid(sections[0]._id)) : [];
        for (const [roomId, rows] of byRoom) {
            pages.push({
                className: roomName.get(roomId) || 'Room',
                sectionName: 'Bookings',
                yearName: year?.yearName || '',
                timetable: { periodsStructure: firstStructure },
                entries: rows.map((e) => ({
                    dayOfWeek: e.dayOfWeek,
                    periodNumber: e.periodNumber,
                    subject: { subjectName: subjectName.get(sid(e.subject)) || '—' },
                    teacher: { name: teacherName.get(sid(e.teacher)) || '' },
                })),
                days,
            });
        }
    }

    const filename = `timetable-v${version.versionNumber}-${view}.pdf`;
    if (!pages.length) return generateMessagePDF(res, 'This timetable has nothing to export yet.', filename);
    generateTimetablePDF(res, pages, school, filename);
}

function exportExcel(res, version, model) {
    const XLSX = require('xlsx');
    const { entries, occupants, sectionById, subjectName, teacherName, roomName, days, view } = model;
    const { slotLabel, slotStaff, slotRooms } = model;
    const wb = XLSX.utils.book_new();

    // A flat sheet first — the shape people actually pivot and filter on. One
    // line per subject taught, so a merged period contributes a line each.
    const flat = occupants.map((e) => ({
        Class: sectionById.get(sid(e.section))?.class?.className || '',
        Section: sectionById.get(sid(e.section))?.sectionName || '',
        Day: e.dayOfWeek,
        Period: e.periodNumber,
        Subject: subjectName.get(sid(e.subject)) || '',
        Teacher: teacherName.get(sid(e.teacher)) || '',
        Room: roomName.get(sid(e.room)) || '',
        Merged: e.isMergedPartner || (e.mergedWith || []).length ? 'Yes' : '',
        Edited: e.isManual ? 'Manual' : 'Generated',
    })).sort((a, b) => String(a.Class).localeCompare(String(b.Class))
        || days.indexOf(a.Day) - days.indexOf(b.Day) || a.Period - b.Period);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flat), 'All Periods');

    // Then one grid per class / teacher / room, matching the chosen view.
    const groups = new Map();
    for (const e of (view === 'class' ? entries : occupants)) {
        let key = null;
        let title = null;
        if (view === 'class') {
            key = sid(e.section);
            const s = sectionById.get(key);
            title = `${s?.class?.className || 'Class'} ${s?.sectionName || ''}`.trim();
        } else if (view === 'teacher') {
            key = sid(e.teacher);
            title = teacherName.get(key);
        } else {
            key = sid(e.room);
            title = roomName.get(key);
        }
        if (!key || !title) continue;
        if (!groups.has(key)) groups.set(key, { title, rows: [] });
        groups.get(key).rows.push(e);
    }

    for (const { title, rows } of groups.values()) {
        const periodNumbers = [...new Set(rows.map((r) => r.periodNumber))].sort((a, b) => a - b);
        const grid = periodNumbers.map((p) => {
            const row = { Period: `P${p}` };
            for (const day of days) {
                const hit = rows.find((r) => r.dayOfWeek === day && r.periodNumber === p);
                row[day] = hit
                    ? [slotLabel(hit), slotStaff(hit), slotRooms(hit)].filter(Boolean).join('\n')
                    : '';
            }
            return row;
        });
        // Excel sheet names cap at 31 chars and reject / \ ? * [ ]
        const safe = title.replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet';
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(grid), safe);
    }

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="timetable-v${version.versionNumber}-${view}.xlsx"`);
    res.send(buffer);
}
