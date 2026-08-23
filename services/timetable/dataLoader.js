'use strict';
/**
 * Loads everything the engine needs in a fixed number of queries.
 *
 * Whole-school generation touches every section, teacher, subject, room and
 * period structure at once, so the loader is deliberately written as ~11 bulk
 * `find({ _id: { $in: [...] } })` calls — never a per-section lookup. The cost
 * of loading a 60-section campus is the same shape as loading one section.
 */

const ClassSection          = require('../../models/ClassSection');
const Class                 = require('../../models/Class');
const Subject               = require('../../models/Subject');
const SectionSubjectTeacher = require('../../models/SectionSubjectTeacher');
const ClassSubject          = require('../../models/ClassSubject');
const User                  = require('../../models/User');
const School                = require('../../models/School');
const Timetable             = require('../../models/Timetable');
const Room                  = require('../../models/Room');
const TeacherAvailability   = require('../../models/TeacherAvailability');
const SubjectRequirement    = require('../../models/SubjectRequirement');
const TimetableMergeGroup   = require('../../models/TimetableMergeGroup');
const TimetableConfig       = require('../../models/TimetableConfig');

const { DAYS, PRACTICAL_TYPES, periodTypeOf } = require('./types');

const sid = (v) => (v == null ? null : String(v._id ?? v));
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/* ── Period structure fallbacks ──────────────────────────────────────────── */

const parseTime  = (t) => { const [h, m] = String(t || '00:00').split(':'); return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0); };
const formatTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;

/**
 * Build a period grid from a section's own timing fields. Mirrors the
 * auto-calculate already used by the section timetable editor, so a section
 * that never had a structure saved still gets its real school timings — never
 * hard-coded ones.
 */
function derivePeriods(section) {
    const nPeriods   = Math.max(1, Number(section.totalPeriods) || 8);
    const lunchMins  = Math.max(0, Number(section.lunchTimeTotalInMinutes) || 30);
    const lunchAfter = Math.max(0, Number(section.lunchAfterPeriod) || 4);
    let startMin     = parseTime(section.startTime || '08:00');
    const endMin     = parseTime(section.endTime || '14:00');

    const totalAvail = Math.max(nPeriods, endMin - startMin - lunchMins);
    const periodLen  = Math.floor(totalAvail / nPeriods);
    const remainder  = totalAvail % nPeriods;

    const out = [];
    let pCount = 1;
    for (let i = 1; i <= nPeriods + 1; i++) {
        if (i - 1 === lunchAfter && lunchMins > 0) {
            out.push({ periodNumber: 0, startTime: formatTime(startMin), endTime: formatTime(startMin + lunchMins), isRecess: true, recessName: 'Lunch', periodType: 'Lunch' });
            startMin += lunchMins;
        }
        if (pCount <= nPeriods) {
            const dur = periodLen + (pCount === nPeriods ? remainder : 0);
            out.push({ periodNumber: pCount, startTime: formatTime(startMin), endTime: formatTime(startMin + dur), isRecess: false, recessName: '', periodType: 'Teaching' });
            startMin += dur;
            pCount++;
        }
    }
    return out;
}

/** Normalise a stored periodsStructure row into the engine's shape. */
const normalisePeriods = (rows) => (rows || [])
    .filter((p) => p && (p.periodNumber != null || p.isRecess))
    .map((p) => ({
        periodNumber: Number(p.periodNumber) || 0,
        startTime: p.startTime || '',
        endTime: p.endTime || '',
        isRecess: !!p.isRecess,
        recessName: p.recessName || '',
        periodType: periodTypeOf(p),
    }));

/* ── Working days ────────────────────────────────────────────────────────── */

function workingDaysFor(config, school) {
    if (config?.workingDays?.length) return config.workingDays.filter((d) => DAYS.includes(d));
    const satWorking = school?.leaveSettings?.saturdayWorking !== false;
    return satWorking ? DAYS.slice(0, 6) : DAYS.slice(0, 5);
}

/* ══════════════════════════════════════════════════════════════════════════
   Scope resolution
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Turn a generation scope into a concrete list of section ids.
 * @param {'single'|'multiple'|'school'} scopeType
 */
async function resolveScope(schoolId, academicYearId, scopeType, { sectionIds = [], classIds = [] } = {}) {
    const base = { school: schoolId, academicYear: academicYearId, status: 'active' };
    if (scopeType === 'school') {
        return ClassSection.find(base).select('_id').lean();
    }
    if (scopeType === 'multiple') {
        const filter = { ...base };
        if (sectionIds.length) filter._id = { $in: sectionIds };
        else if (classIds.length) filter.class = { $in: classIds };
        else return [];
        return ClassSection.find(filter).select('_id').lean();
    }
    if (!sectionIds.length) return [];
    return ClassSection.find({ ...base, _id: { $in: sectionIds.slice(0, 1) } }).select('_id').lean();
}

/* ══════════════════════════════════════════════════════════════════════════
   Main loader
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * @returns engine input + the lookup maps the controller needs for labelling.
 */
async function loadGenerationInput({ schoolId, academicYearId, sectionIds, options = {} }) {
    const ids = uniq(sectionIds.map(sid));
    if (!ids.length) throw new Error('No sections in scope');

    const [school, config, sections, rooms, availability, requirements, allSubjects] = await Promise.all([
        School.findById(schoolId).select('leaveSettings name').lean(),
        TimetableConfig.findOne({ school: schoolId, academicYear: academicYearId }).lean(),
        ClassSection.find({ _id: { $in: ids } }).lean(),
        Room.find({ school: schoolId, isActive: true }).lean(),
        TeacherAvailability.find({ school: schoolId, academicYear: academicYearId }).lean(),
        SubjectRequirement.find({ school: schoolId, academicYear: academicYearId, section: { $in: ids }, isActive: true }).lean(),
        Subject.find({ school: schoolId }).lean(),
    ]);

    // Sections taught together. Loaded school-wide for the year, not just for
    // the scope, so generating ONE section still knows it belongs to a merge —
    // that is what lets a later run land on the slot an earlier one fixed.
    const mergeGroups = await TimetableMergeGroup.find({
        school: schoolId, academicYear: academicYearId, isActive: true,
    }).lean();
    // section#subject -> { key, sections, teacher, room }
    const mergeBySectionSubject = new Map();
    for (const g of mergeGroups) {
        const members = uniq((g.sections || []).map(sid));
        if (members.length < 2) continue;
        for (const secId of members) {
            mergeBySectionSubject.set(`${secId}#${sid(g.subject)}`, {
                key: sid(g._id), members, teacher: sid(g.teacher), room: sid(g.room),
            });
        }
    }
    const mergeFor = (sectionId, subjectId) => mergeBySectionSubject.get(`${sectionId}#${subjectId}`) || null;

    const classIds = uniq(sections.map((s) => sid(s.class)));
    const [classes, timetables, sst, classSubjects] = await Promise.all([
        Class.find({ _id: { $in: classIds } }).select('className classNumber').lean(),
        Timetable.find({ section: { $in: ids }, academicYear: academicYearId }).lean(),
        SectionSubjectTeacher.find({ section: { $in: ids } }).lean(),
        ClassSubject.find({ class: { $in: classIds } }).lean(),
    ]);

    // Teachers referenced anywhere, plus every active teacher (alternates).
    const teacherDocs = await User.find({ school: schoolId, role: 'teacher', isActive: true })
        .select('name email').lean();

    const classById   = new Map(classes.map((c) => [sid(c._id), c]));
    const subjectById = new Map(allSubjects.map((s) => [sid(s._id), s]));
    const ttBySection = new Map(timetables.map((t) => [sid(t.section), t]));
    const availByTeacher = new Map(availability.map((a) => [sid(a.teacher), a]));

    // section -> subject -> [teacherIds]
    const sstIndex = new Map();
    for (const row of sst) {
        const key = `${sid(row.section)}#${sid(row.subject)}`;
        if (!sstIndex.has(key)) sstIndex.set(key, []);
        sstIndex.get(key).push(sid(row.teacher));
    }
    // subject -> teachers anywhere in the school (qualification set)
    const subjectsByTeacher = new Map();
    for (const row of sst) {
        const t = sid(row.teacher);
        if (!subjectsByTeacher.has(t)) subjectsByTeacher.set(t, new Set());
        subjectsByTeacher.get(t).add(sid(row.subject));
    }
    for (const subject of allSubjects) {
        for (const t of subject.teachers || []) {
            const tid = sid(t);
            if (!subjectsByTeacher.has(tid)) subjectsByTeacher.set(tid, new Set());
            subjectsByTeacher.get(tid).add(sid(subject._id));
        }
    }

    const globalDays = workingDaysFor(config, school);
    const satWorking = school?.leaveSettings?.saturdayWorking !== false;
    const homeRoomBySection = new Map(rooms.filter((r) => r.homeSection).map((r) => [sid(r.homeSection), sid(r._id)]));

    /* ── Sections ─────────────────────────────────────────────────────────── */
    const engineSections = sections.map((s) => {
        const stored = normalisePeriods(ttBySection.get(sid(s._id))?.periodsStructure);
        const fromConfig = normalisePeriods(config?.periodTemplate);
        const weekday = stored.length ? stored : (fromConfig.length ? fromConfig : normalisePeriods(derivePeriods(s)));
        const saturday = normalisePeriods(config?.saturdayTemplate);

        const sectionDays = globalDays.filter((d) => (d === 'Saturday' ? (satWorking && s.openOnSaturday !== false) : true));
        const periodsByDay = {};
        for (const day of sectionDays) {
            periodsByDay[day] = day === 'Saturday' && saturday.length ? saturday : weekday;
        }

        return {
            id: sid(s._id),
            classId: sid(s.class),
            className: classById.get(sid(s.class))?.className || '',
            sectionName: s.sectionName || '',
            label: `${classById.get(sid(s.class))?.className || ''} ${s.sectionName || ''}`.trim(),
            strength: Number(s.currentCount) || (s.enrolledStudents || []).length || 0,
            days: sectionDays,
            periodsByDay,
            homeRoomId: homeRoomBySection.get(sid(s._id)) || null,
        };
    });

    /* ── Requirements ─────────────────────────────────────────────────────── */
    // Explicit SubjectRequirement rows win. Sections with none fall back to the
    // subjects already assigned to them, so a school can generate before ever
    // opening the requirements screen.
    const reqBySection = new Map();
    for (const r of requirements) {
        const key = sid(r.section);
        if (!reqBySection.has(key)) reqBySection.set(key, []);
        reqBySection.get(key).push(r);
    }

    /**
     * Merge fields for one requirement. A pinned teacher or room on the group
     * wins over whatever the section had on its own — the whole point is that
     * the merged sections share one of each.
     */
    const mergeFields = (sectionId, subjectId, ownTeacher, ownRoom) => {
        const g = mergeFor(sectionId, subjectId);
        if (!g) return { sectionMerge: '' };
        return {
            sectionMerge: g.key,
            ...(g.teacher ? { teacherId: g.teacher } : {}),
            ...(g.room ? { roomId: g.room, requiresRoom: true } : {}),
        };
    };

    const engineRequirements = [];
    const derivedFor = [];
    for (const section of engineSections) {
        const rows = reqBySection.get(section.id) || [];
        if (rows.length) {
            for (const r of rows) {
                const subject = subjectById.get(sid(r.subject));
                engineRequirements.push({
                    id: sid(r._id),
                    sectionId: section.id,
                    subjectId: sid(r.subject),
                    subjectName: subject?.subjectName || 'Subject',
                    weeklyPeriods: Number(r.weeklyPeriods) || 0,
                    teacherId: sid(r.teacher) || (sstIndex.get(`${section.id}#${sid(r.subject)}`) || [])[0] || null,
                    altTeacherIds: uniq([
                        ...(r.altTeachers || []).map(sid),
                        ...(sstIndex.get(`${section.id}#${sid(r.subject)}`) || []),
                    ]).filter((t) => t !== sid(r.teacher)),
                    subjectType: r.subjectType || subjectTypeFromSubject(subject),
                    roomId: sid(r.room),
                    roomTypes: r.roomTypes || [],
                    requiresRoom: !!r.requiresRoom,
                    consecutivePeriods: Number(r.consecutivePeriods) || 1,
                    maxPerDay: Number(r.maxPerDay) || 1,
                    hardMaxPerDay: r.hardMaxPerDay !== false,
                    minGapPeriods: Number(r.minGapPeriods) || 0,
                    preferredPeriods: r.preferredPeriods || [],
                    preferredDays: r.preferredDays || [],
                    difficulty: Number(r.difficulty) || 3,
                    priority: Number(r.priority) || 0,
                    // Shared key ⇒ scheduled in the same period as its partners.
                    mergeGroup: String(r.mergeGroup || '').trim(),
                    ...mergeFields(section.id, sid(r.subject), sid(r.teacher), sid(r.room)),
                });
            }
            continue;
        }

        // Derived defaults: every subject the section teaches, sharing the week
        // evenly across the available teaching slots.
        const subjectIds = uniq([
            ...sst.filter((x) => sid(x.section) === section.id).map((x) => sid(x.subject)),
            ...classSubjects.filter((x) => sid(x.class) === section.classId).map((x) => sid(x.subject)),
        ]);
        if (!subjectIds.length) continue;

        let slots = 0;
        for (const day of section.days) slots += (section.periodsByDay[day] || []).filter((p) => p.periodType === 'Teaching').length;
        const per = Math.max(1, Math.floor(slots / subjectIds.length));
        derivedFor.push(section.id);

        for (const subjectId of subjectIds) {
            const subject = subjectById.get(subjectId);
            const teachers = sstIndex.get(`${section.id}#${subjectId}`) || [];
            engineRequirements.push({
                id: `derived:${section.id}:${subjectId}`,
                sectionId: section.id,
                subjectId,
                subjectName: subject?.subjectName || 'Subject',
                weeklyPeriods: per,
                teacherId: teachers[0] || null,
                altTeacherIds: teachers.slice(1),
                subjectType: subjectTypeFromSubject(subject),
                roomTypes: [],
                requiresRoom: false,
                consecutivePeriods: subject?.type === 'practical' ? 2 : 1,
                maxPerDay: subject?.type === 'practical' ? 2 : 1,
                hardMaxPerDay: true,
                minGapPeriods: 0,
                preferredPeriods: [],
                preferredDays: [],
                difficulty: 3,
                priority: 0,
                mergeGroup: '',
                ...mergeFields(section.id, subjectId, teachers[0] || null, null),
                derived: true,
            });
        }
    }

    /* ── Teachers ─────────────────────────────────────────────────────────── */
    const defaults = config?.defaults || {};
    const engineTeachers = teacherDocs.map((t) => {
        const a = availByTeacher.get(sid(t._id));
        return {
            id: sid(t._id),
            name: t.name || 'Teacher',
            unavailable: a?.unavailable || [],
            maxPeriodsPerDay: a?.maxPeriodsPerDay ?? defaults.maxTeacherPeriodsPerDay ?? 0,
            maxPeriodsPerWeek: a?.maxPeriodsPerWeek ?? defaults.maxTeacherPeriodsPerWeek ?? 0,
            hardDailyLimit: a?.hardDailyLimit ?? defaults.hardTeacherDailyLimit ?? true,
            preferredDays: a?.preferredDays || [],
            preferredPeriods: a?.preferredPeriods || [],
            subjectIds: [...(subjectsByTeacher.get(sid(t._id)) || [])],
        };
    });

    return {
        input: {
            days: globalDays,
            sections: engineSections,
            requirements: engineRequirements,
            teachers: engineTeachers,
            rooms: rooms.map((r) => ({ ...r, id: sid(r._id) })),
            options,
            weights: config?.softWeights,
            solver: config?.solver,
            allowActivity: !!config?.allowSubjectsInActivity,
            enforceTeacherQualified: defaults.enforceTeacherQualified !== false,
        },
        lookups: {
            school,
            config,
            sections,
            classById,
            subjectById,
            teacherById: new Map(teacherDocs.map((t) => [sid(t._id), t])),
            roomById: new Map(rooms.map((r) => [sid(r._id), r])),
            derivedRequirementSections: derivedFor,
        },
    };
}

function subjectTypeFromSubject(subject) {
    if (!subject) return 'Theory';
    if (subject.type === 'practical') return 'Practical';
    return 'Theory';
}

module.exports = {
    loadGenerationInput, resolveScope, derivePeriods,
    normalisePeriods, workingDaysFor, PRACTICAL_TYPES,
};
