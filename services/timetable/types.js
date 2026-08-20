'use strict';
// Shared vocabulary for the timetable generator. Kept dependency-free so the
// engine and its tests can be loaded without touching the database.

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const PERIOD_TYPES = ['Teaching', 'Break', 'Lunch', 'Activity', 'Assembly', 'Free'];

const SUBJECT_TYPES = ['Theory', 'Practical', 'Laboratory', 'Activity', 'Sports', 'Library', 'Other'];

const ROOM_TYPES = [
    'Classroom', 'Science Lab', 'Computer Lab', 'Physics Lab',
    'Chemistry Lab', 'Biology Lab', 'Library', 'Auditorium',
    'Activity Room', 'Sports', 'Other',
];

const CONFLICT_TYPES = {
    TEACHER_CLASH:            'TEACHER_CLASH',
    CLASS_CLASH:              'CLASS_CLASH',
    ROOM_CLASH:               'ROOM_CLASH',
    TEACHER_UNAVAILABLE:      'TEACHER_UNAVAILABLE',
    ROOM_UNAVAILABLE:         'ROOM_UNAVAILABLE',
    SUBJECT_PERIOD_SHORTAGE:  'SUBJECT_PERIOD_SHORTAGE',
    ROOM_CAPACITY:            'ROOM_CAPACITY',
    SUBJECT_TEACHER_MISMATCH: 'SUBJECT_TEACHER_MISMATCH',
    PRACTICAL_ROOM_MISSING:   'PRACTICAL_ROOM_MISSING',
    DAILY_LIMIT_EXCEEDED:     'DAILY_LIMIT_EXCEEDED',
    WEEKLY_LIMIT_EXCEEDED:    'WEEKLY_LIMIT_EXCEEDED',
    CONSECUTIVE_PERIOD_ERROR: 'CONSECUTIVE_PERIOD_ERROR',
    NON_TEACHING_SLOT:        'NON_TEACHING_SLOT',
    NO_TEACHER_ASSIGNED:      'NO_TEACHER_ASSIGNED',
    MERGE_GROUP_MISMATCH:     'MERGE_GROUP_MISMATCH',
    OTHER:                    'OTHER',
};

const SEVERITY = { ERROR: 'ERROR', WARNING: 'WARNING', INFO: 'INFO' };

// Subject types that need a dedicated room by default.
const PRACTICAL_TYPES = new Set(['Practical', 'Laboratory']);

// Which room types satisfy which subject type when the admin has not pinned one.
const DEFAULT_ROOM_TYPES = {
    Practical:  ['Science Lab', 'Computer Lab', 'Physics Lab', 'Chemistry Lab', 'Biology Lab'],
    Laboratory: ['Science Lab', 'Computer Lab', 'Physics Lab', 'Chemistry Lab', 'Biology Lab'],
    Activity:   ['Activity Room', 'Auditorium'],
    Sports:     ['Sports'],
    Library:    ['Library'],
};

const DEFAULT_SOFT_WEIGHTS = {
    sameSubjectTwiceADay: 8,
    spreadAcrossWeek:     4,
    difficultLastPeriod:  3,
    difficultConsecutive: 2,
    teacherLoadBalance:   3,
    teacherGaps:          4,
    studentGaps:          5,
    teacherPreferred:     2,
    subjectPreferred:     2,
    sameSubjectAdjacent:  3,
    dailyOverload:        3,
};

const DEFAULT_OPTIONS = {
    avoidSameSubjectTwiceADay: true,
    balanceDifficultSubjects:  true,
    minimizeTeacherGaps:       true,
    minimizeStudentGaps:       true,
    preferTeacherAvailability: true,
    keepPracticalsConsecutive: true,
    spreadAcrossWeek:          true,
    preserveManualEdits:       false,
};

const DEFAULT_SOLVER = {
    timeBudgetMs:   20000,
    maxRestarts:    3,
    optimiseRounds: 2000,
};

// The ten user-visible phases the progress UI ticks through.
const GENERATION_STEPS = [
    { key: 'load_classes',   label: 'Loading classes' },
    { key: 'load_teachers',  label: 'Loading teachers' },
    { key: 'load_subjects',  label: 'Loading subjects' },
    { key: 'load_rooms',     label: 'Loading rooms' },
    { key: 'availability',   label: 'Checking availability' },
    { key: 'hard',           label: 'Applying hard constraints' },
    { key: 'assign',         label: 'Assigning subjects' },
    { key: 'resolve',        label: 'Resolving conflicts' },
    { key: 'optimise',       label: 'Optimizing timetable' },
    { key: 'validate',       label: 'Final validation' },
];

/**
 * Resolve a period's type from a periodsStructure row.
 * Rows written before this module have only `isRecess`, so a missing
 * `periodType` degrades to Break/Teaching rather than blocking the generator.
 */
function periodTypeOf(period) {
    if (!period) return 'Teaching';
    const t = String(period.periodType || '').trim();
    if (t && PERIOD_TYPES.includes(t)) return t;
    if (period.isRecess) {
        const name = String(period.recessName || '').toLowerCase();
        if (name.includes('lunch')) return 'Lunch';
        if (name.includes('assembly')) return 'Assembly';
        if (name.includes('activity')) return 'Activity';
        return 'Break';
    }
    return 'Teaching';
}

/** Can a subject be scheduled into this period? */
function isTeachingPeriod(period, { allowActivity = false } = {}) {
    const t = periodTypeOf(period);
    if (t === 'Teaching') return true;
    if (t === 'Activity' && allowActivity) return true;
    return false;
}

/** Room types acceptable for a requirement, widest-to-narrowest. */
function roomTypesFor(req) {
    if (Array.isArray(req.roomTypes) && req.roomTypes.length) return req.roomTypes;
    return DEFAULT_ROOM_TYPES[req.subjectType] || [];
}

const slotKey = (day, period) => `${day}#${period}`;

module.exports = {
    DAYS, PERIOD_TYPES, SUBJECT_TYPES, ROOM_TYPES,
    CONFLICT_TYPES, SEVERITY, PRACTICAL_TYPES, DEFAULT_ROOM_TYPES,
    DEFAULT_SOFT_WEIGHTS, DEFAULT_OPTIONS, DEFAULT_SOLVER, GENERATION_STEPS,
    periodTypeOf, isTeachingPeriod, roomTypesFor, slotKey,
};
