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
const Room                  = require('../models/Room');
const TeacherAvailability   = require('../models/TeacherAvailability');
const SubjectRequirement    = require('../models/SubjectRequirement');
const TimetableConfig       = require('../models/TimetableConfig');
const TimetableVersion      = require('../models/TimetableVersion');
const TimetableVersionEntry = require('../models/TimetableVersionEntry');
const TimetableConflict     = require('../models/TimetableConflict');
const TimetableAuditLog     = require('../models/TimetableAuditLog');

const tt = require('../services/timetable');
const persistence = require('../services/timetable/persistence');
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
                enforceRoomCapacity: true, enforceTeacherQualified: true, hardTeacherDailyLimit: true,
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
   SUBJECT REQUIREMENTS
   ══════════════════════════════════════════════════════════════════════════ */

exports.listRequirements = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.query.yearId);
        if (!year) return err(res, 'No academic year found', 404);
        const { sectionId } = req.query;
        if (!sectionId) return err(res, 'sectionId is required', 400);

        const section = await ClassSection.findOne({ _id: sectionId, school: req.schoolId })
            .populate('class', 'className').lean();
        if (!section) return err(res, 'Section not found', 404);

        const [rows, sst, classSubjects, subjects, teachers, rooms, timetable] = await Promise.all([
            SubjectRequirement.find({ school: req.schoolId, academicYear: year._id, section: sectionId }).lean(),
            SectionSubjectTeacher.find({ section: sectionId }).lean(),
            ClassSubject.find({ class: section.class?._id || section.class }).lean(),
            Subject.find({ school: req.schoolId }).sort({ subjectName: 1 }).lean(),
            User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('name').sort({ name: 1 }).lean(),
            Room.find({ school: req.schoolId, isActive: true }).select('roomName roomType capacity').sort({ roomName: 1 }).lean(),
            Timetable.findOne({ section: sectionId, academicYear: year._id }).lean(),
        ]);

        const teachersBySubject = new Map();
        for (const row of sst) {
            const key = sid(row.subject);
            if (!teachersBySubject.has(key)) teachersBySubject.set(key, []);
            teachersBySubject.get(key).push(sid(row.teacher));
        }

        // Subjects the section teaches but has no requirement row for yet.
        const covered = new Set(rows.map((r) => sid(r.subject)));
        const available = uniq([
            ...sst.map((x) => sid(x.subject)),
            ...classSubjects.map((x) => sid(x.subject)),
        ]).filter((s) => !covered.has(s));

        const teachingSlots = (timetable?.periodsStructure || [])
            .filter((p) => tt.periodTypeOf(p) === 'Teaching').length;

        ok(res, {
            selectedYearId: year._id,
            section: {
                _id: section._id,
                sectionName: section.sectionName,
                className: section.class?.className || '',
                strength: section.currentCount || 0,
                openOnSaturday: section.openOnSaturday,
            },
            requirements: rows,
            missingSubjects: available.map((id) => ({
                _id: id,
                subjectName: subjects.find((s) => sid(s._id) === id)?.subjectName || 'Subject',
                suggestedTeacher: (teachersBySubject.get(id) || [])[0] || null,
            })),
            subjects,
            teachers,
            rooms,
            teachersBySubject: Object.fromEntries(teachersBySubject),
            periodsPerDay: teachingSlots,
            totalWeekly: rows.reduce((n, r) => n + (Number(r.weeklyPeriods) || 0), 0),
        });
    } catch (e) { err(res, e, e.status); }
};

exports.saveRequirements = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.body.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const { sectionId } = req.params;
        const section = await ClassSection.findOne({ _id: sectionId, school: req.schoolId }).lean();
        if (!section) return err(res, 'Section not found', 404);

        const rows = Array.isArray(req.body.requirements) ? req.body.requirements : [];
        const seen = new Set();
        for (const r of rows) {
            const msg = validateBody(r, {
                subject: { label: 'Subject', required: true },
                weeklyPeriods: { label: 'Weekly periods', required: true, type: 'number', min: 0, max: 60 },
                consecutivePeriods: { label: 'Consecutive periods', type: 'number', min: 1, max: 4 },
                maxPerDay: { label: 'Max per day', type: 'number', min: 1, max: 12 },
                difficulty: { label: 'Difficulty', type: 'number', min: 1, max: 5 },
                subjectType: { label: 'Subject type', enum: tt.SUBJECT_TYPES },
            });
            if (msg) return err(res, msg, 400);
            if (seen.has(sid(r.subject))) return err(res, 'The same subject appears twice', 400);
            seen.add(sid(r.subject));
            if (Number(r.consecutivePeriods) > Number(r.weeklyPeriods) && Number(r.weeklyPeriods) > 0) {
                return err(res, 'Consecutive periods cannot exceed the weekly requirement', 400);
            }
        }

        const existing = await SubjectRequirement.find({ school: req.schoolId, academicYear: year._id, section: sectionId }).lean();
        const keep = new Set(rows.map((r) => sid(r.subject)));
        for (const old of existing) {
            if (!keep.has(sid(old.subject))) await SubjectRequirement.deleteOne({ _id: old._id });
        }

        const saved = [];
        for (const r of rows) {
            const doc = await SubjectRequirement.findOneAndUpdate(
                { section: sectionId, subject: r.subject, academicYear: year._id },
                {
                    $set: {
                        school: req.schoolId,
                        weeklyPeriods: Number(r.weeklyPeriods) || 0,
                        teacher: r.teacher || null,
                        altTeachers: (r.altTeachers || []).filter(Boolean),
                        subjectType: r.subjectType || 'Theory',
                        room: r.room || null,
                        roomTypes: (r.roomTypes || []).filter((t) => tt.ROOM_TYPES.includes(t)),
                        requiresRoom: !!r.requiresRoom,
                        consecutivePeriods: Math.max(1, Number(r.consecutivePeriods) || 1),
                        maxPerDay: Math.max(1, Number(r.maxPerDay) || 1),
                        hardMaxPerDay: r.hardMaxPerDay !== false,
                        minGapPeriods: Math.max(0, Number(r.minGapPeriods) || 0),
                        preferredPeriods: (r.preferredPeriods || []).map(Number).filter((n) => n > 0),
                        preferredDays: (r.preferredDays || []).filter((d) => tt.DAYS.includes(d)),
                        difficulty: Math.min(5, Math.max(1, Number(r.difficulty) || 3)),
                        priority: Number(r.priority) || 0,
                        isActive: r.isActive !== false,
                    },
                    $setOnInsert: { section: sectionId, subject: r.subject, academicYear: year._id, createdBy: req.userId },
                },
                { upsert: true, new: true },
            );
            saved.push(doc);
        }

        await logAudit(req, 'update', 'Requirement', sectionId,
            `Saved ${saved.length} subject requirement(s)`, { sectionId, count: saved.length });
        ok(res, { saved: saved.length, requirements: saved });
    } catch (e) { err(res, e, e.status); }
};

/**
 * Seed requirements for one section (or every section in scope) from the
 * subject-teacher assignments that already exist, so an admin never starts from
 * a blank screen.
 */
exports.seedRequirements = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.body.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const sectionIds = req.body.sectionId
            ? [req.body.sectionId]
            : (await ClassSection.find({ school: req.schoolId, academicYear: year._id, status: 'active' }).select('_id').lean())
                .map((s) => sid(s._id));
        if (!sectionIds.length) return err(res, 'No sections found', 404);

        const [sections, sst, classSubjects, subjects, timetables, existing] = await Promise.all([
            ClassSection.find({ _id: { $in: sectionIds } }).lean(),
            SectionSubjectTeacher.find({ section: { $in: sectionIds } }).lean(),
            ClassSubject.find({}).lean(),
            Subject.find({ school: req.schoolId }).lean(),
            Timetable.find({ section: { $in: sectionIds }, academicYear: year._id }).lean(),
            SubjectRequirement.find({ school: req.schoolId, academicYear: year._id, section: { $in: sectionIds } }).lean(),
        ]);

        const subjectById = new Map(subjects.map((s) => [sid(s._id), s]));
        const ttBySection = new Map(timetables.map((t) => [sid(t.section), t]));
        const have = new Set(existing.map((r) => `${sid(r.section)}#${sid(r.subject)}`));

        const school = await School.findById(req.schoolId).select('leaveSettings').lean();
        const satWorking = school?.leaveSettings?.saturdayWorking !== false;

        let created = 0;
        for (const section of sections) {
            const secId = sid(section._id);
            const subjectIds = uniq([
                ...sst.filter((x) => sid(x.section) === secId).map((x) => sid(x.subject)),
                ...classSubjects.filter((x) => sid(x.class) === sid(section.class)).map((x) => sid(x.subject)),
            ]);
            if (!subjectIds.length) continue;

            const periods = ttBySection.get(secId)?.periodsStructure || tt.derivePeriods(section);
            const perDay = periods.filter((p) => tt.periodTypeOf(p) === 'Teaching').length;
            const days = (satWorking && section.openOnSaturday !== false) ? 6 : 5;
            const weekly = Math.max(1, Math.floor((perDay * days) / subjectIds.length));

            for (const subjectId of subjectIds) {
                if (have.has(`${secId}#${subjectId}`)) continue;
                const subject = subjectById.get(subjectId);
                const teachers = sst.filter((x) => sid(x.section) === secId && sid(x.subject) === subjectId).map((x) => sid(x.teacher));
                const practical = subject?.type === 'practical';
                await SubjectRequirement.create({
                    school: req.schoolId,
                    academicYear: year._id,
                    section: secId,
                    subject: subjectId,
                    weeklyPeriods: weekly,
                    teacher: teachers[0] || null,
                    altTeachers: teachers.slice(1),
                    subjectType: practical ? 'Practical' : 'Theory',
                    roomTypes: [],
                    requiresRoom: false,
                    consecutivePeriods: practical ? 2 : 1,
                    maxPerDay: practical ? 2 : Math.max(1, Math.ceil(weekly / days)),
                    hardMaxPerDay: true,
                    difficulty: 3,
                    createdBy: req.userId,
                });
                created++;
            }
        }

        await logAudit(req, 'seed', 'Requirement', null, `Seeded ${created} subject requirement(s) from section assignments`, { sections: sectionIds.length });
        ok(res, { created, sections: sectionIds.length });
    } catch (e) { err(res, e, e.status); }
};

exports.deleteRequirement = async (req, res) => {
    try {
        const row = await SubjectRequirement.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!row) return err(res, 'Requirement not found', 404);
        await SubjectRequirement.deleteOne({ _id: row._id });
        await logAudit(req, 'delete', 'Requirement', row._id, 'Deleted a subject requirement', { section: row.section });
        ok(res, { deleted: true });
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
        if (version.options?.preserveManualEdits && version.basedOn) {
            const manual = await TimetableVersionEntry.find({ version: version.basedOn, isManual: true }).lean();
            input.pinned = manual.map((m) => ({
                sectionId: sid(m.section), subjectId: sid(m.subject), teacherId: sid(m.teacher),
                roomId: sid(m.room), dayOfWeek: m.dayOfWeek, periodNumber: m.periodNumber, size: 1,
            }));
        }

        const result = tt.generate(input, { onProgress });

        // Re-validate the finished grid independently of the solver.
        const report = tt.validate(result.ctx, result.assignments);
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

exports.generate = async (req, res) => {
    try {
        const year = await resolveYear(req.schoolId, req.body.yearId);
        if (!year) return err(res, 'No academic year found', 404);

        const scopeType = req.body.scopeType || 'single';
        if (!['single', 'multiple', 'school'].includes(scopeType)) {
            return err(res, 'Generation scope must be single, multiple or school', 400);
        }

        const sections = await tt.resolveScope(req.schoolId, year._id, scopeType, {
            sectionIds: (req.body.sectionIds || []).filter(Boolean),
            classIds: (req.body.classIds || []).filter(Boolean),
        });
        if (!sections.length) {
            return err(res, scopeType === 'school'
                ? 'This academic year has no active sections to generate for'
                : 'Select at least one class or section', 400);
        }

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

        const versionNumber = await persistence.nextVersionNumber(req.schoolId, year._id);
        const version = await TimetableVersion.create({
            school: req.schoolId,
            academicYear: year._id,
            versionNumber,
            label: req.body.label || `Version ${versionNumber}`,
            description: req.body.description || '',
            status: 'generating',
            scopeType,
            scopeClasses: (req.body.classIds || []).filter(Boolean),
            sections: sections.map((s) => sid(s._id)),
            options: { ...tt.DEFAULT_OPTIONS, ...(req.body.options || {}) },
            seed: Number(req.body.seed) || newSeed(),
            basedOn: req.body.basedOn || null,
            progress: initialProgress(),
            generatedBy: req.userId,
            createdBy: req.userId,
        });

        await logAudit(req, 'generate', 'Version', version._id,
            `Started generation of ${version.label} (${scopeType}, ${sections.length} section(s))`,
            { scopeType, sections: sections.length, seed: version.seed }, version._id);

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
        const describe = (r) => (r
            ? { subject: subjectName.get(sid(r.subject)) || '—', teacher: teacherName.get(sid(r.teacher)) || '', room: sid(r.room) }
            : null);

        const changes = [];
        for (const key of new Set([...ia.keys(), ...ib.keys()])) {
            const [sectionId, day, period] = key.split('#');
            const from = ia.get(key);
            const to = ib.get(key);
            const same = from && to
                && sid(from.subject) === sid(to.subject)
                && sid(from.teacher) === sid(to.teacher)
                && sid(from.room) === sid(to.room);
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
    const report = tt.validate(ctx, entries.map((e) => ({
        sectionId: sid(e.section), subjectId: sid(e.subject), teacherId: sid(e.teacher),
        roomId: sid(e.room), dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
    })));
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
        const shaped = entries.map((e) => ({
            _id: sid(e._id), sectionId: sid(e.section), subjectId: sid(e.subject),
            teacherId: sid(e.teacher), roomId: sid(e.room), dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
        }));

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

        const shaped = (await TimetableVersionEntry.find({ version: version._id }).lean()).map((e) => ({
            _id: sid(e._id), sectionId: sid(e.section), subjectId: sid(e.subject),
            teacherId: sid(e.teacher), roomId: sid(e.room), dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
        }));
        const candidate = {
            _id: 'new', sectionId: String(req.body.section), subjectId: String(req.body.subject),
            teacherId: req.body.teacher || null, roomId: req.body.room || null,
            dayOfWeek: req.body.dayOfWeek, periodNumber: Number(req.body.periodNumber),
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
            const r = tt.validate(ctx, entries.map((e) => ({
                sectionId: sid(e.section), subjectId: sid(e.subject), teacherId: sid(e.teacher),
                roomId: sid(e.room), dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
            })));
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
        });
    }
    if (studentIds.length) {
        const names = sections.map((s) => `${s.class?.className || ''} ${s.sectionName || ''}`.trim()).filter(Boolean);
        await notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '🗓️ New class timetable',
            body: `The timetable for ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} has been updated.`,
            recipients: studentIds,
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

    return { entries, sections, sectionById, subjectName, teacherName, roomName, structureFor, year, days: usedDays.length ? usedDays : days.slice(0, 5), view };
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
    const { entries, sections, subjectName, teacherName, roomName, structureFor, year, days, view } = model;

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
                    subject: { subjectName: subjectName.get(sid(e.subject)) || '—' },
                    teacher: { name: [teacherName.get(sid(e.teacher)), roomName.get(sid(e.room))].filter(Boolean).join(' · ') },
                })),
                days: days.filter((d) => rows.some((r) => r.dayOfWeek === d)),
            });
        }
    } else if (view === 'teacher') {
        const byTeacher = new Map();
        for (const e of entries) {
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
        for (const e of entries) {
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
    const { entries, sections, sectionById, subjectName, teacherName, roomName, days, view } = model;
    const wb = XLSX.utils.book_new();

    // A flat sheet first — the shape people actually pivot and filter on.
    const flat = entries.map((e) => ({
        Class: sectionById.get(sid(e.section))?.class?.className || '',
        Section: sectionById.get(sid(e.section))?.sectionName || '',
        Day: e.dayOfWeek,
        Period: e.periodNumber,
        Subject: subjectName.get(sid(e.subject)) || '',
        Teacher: teacherName.get(sid(e.teacher)) || '',
        Room: roomName.get(sid(e.room)) || '',
        Edited: e.isManual ? 'Manual' : 'Generated',
    })).sort((a, b) => String(a.Class).localeCompare(String(b.Class))
        || days.indexOf(a.Day) - days.indexOf(b.Day) || a.Period - b.Period);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flat), 'All Periods');

    // Then one grid per class / teacher / room, matching the chosen view.
    const groups = new Map();
    for (const e of entries) {
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
                    ? [subjectName.get(sid(hit.subject)), teacherName.get(sid(hit.teacher)), roomName.get(sid(hit.room))]
                        .filter(Boolean).join('\n')
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
