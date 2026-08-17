'use strict';
/**
 * Timetable generation engine test suite.
 *
 *   node scripts/testTimetableEngine.js
 *
 * Runs entirely in memory — the engine is a pure function of its input, so no
 * database, no server and no test framework are required (the project has no
 * test runner installed and this deliberately does not add one).
 */

const assert = require('assert');
const { generate, compile } = require('../services/timetable/engine');
const { validate, validateMove } = require('../services/timetable/validator');
const { CONFLICT_TYPES, SEVERITY, slotKey } = require('../services/timetable/types');

/* ── Tiny test harness ───────────────────────────────────────────────────── */
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, error: e });
        console.log(`  ✗ ${name}\n      ${e.message}`);
    }
}
function group(name) { console.log(`\n${name}`); }

/* ── Fixture builders ────────────────────────────────────────────────────── */

const DAYS5 = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
// The spec's worked example (Mathematics 6 periods/week, max 1 per day) only
// fits a six-day week, which is the common Indian school pattern.
const DAYS6 = [...DAYS5, 'Saturday'];

/** 8 periods with a lunch break after P4 — the shape the ERP's auto-calc makes. */
function periods(n = 8, { lunchAfter = 4 } = {}) {
    const out = [];
    for (let i = 1; i <= n; i++) {
        if (i === lunchAfter + 1) {
            out.push({ periodNumber: 0, startTime: `${String(7 + i).padStart(2, '0')}:00`, endTime: `${String(7 + i).padStart(2, '0')}:30`, isRecess: true, recessName: 'Lunch', periodType: 'Lunch' });
        }
        out.push({ periodNumber: i, startTime: `${String(7 + i).padStart(2, '0')}:30`, endTime: `${String(8 + i).padStart(2, '0')}:15`, isRecess: false, periodType: 'Teaching' });
    }
    return out;
}

function section(id, overrides = {}) {
    return {
        id,
        classId: overrides.classId || `c-${id}`,
        className: overrides.className || `Class ${id}`,
        sectionName: overrides.sectionName || 'A',
        label: overrides.label || `Class ${id}`,
        strength: overrides.strength ?? 35,
        days: overrides.days || DAYS5,
        periods: overrides.periods || periods(8),
        periodsByDay: overrides.periodsByDay,
        homeRoomId: overrides.homeRoomId || null,
    };
}

function teacher(id, overrides = {}) {
    return {
        id,
        name: overrides.name || `Teacher ${id}`,
        unavailable: overrides.unavailable || [],
        maxPeriodsPerDay: overrides.maxPeriodsPerDay ?? 0,
        maxPeriodsPerWeek: overrides.maxPeriodsPerWeek ?? 0,
        hardDailyLimit: overrides.hardDailyLimit !== false,
        preferredDays: overrides.preferredDays || [],
        preferredPeriods: overrides.preferredPeriods || [],
        subjectIds: overrides.subjectIds || [],
    };
}

function requirement(sectionId, subjectId, weekly, overrides = {}) {
    return {
        id: `${sectionId}:${subjectId}`,
        sectionId,
        subjectId,
        subjectName: overrides.subjectName || subjectId,
        weeklyPeriods: weekly,
        teacherId: overrides.teacherId || null,
        altTeacherIds: overrides.altTeacherIds || [],
        subjectType: overrides.subjectType || 'Theory',
        roomId: overrides.roomId || null,
        roomTypes: overrides.roomTypes || [],
        requiresRoom: overrides.requiresRoom || false,
        consecutivePeriods: overrides.consecutivePeriods || 1,
        maxPerDay: overrides.maxPerDay || 1,
        hardMaxPerDay: overrides.hardMaxPerDay !== false,
        minGapPeriods: overrides.minGapPeriods || 0,
        preferredPeriods: overrides.preferredPeriods || [],
        preferredDays: overrides.preferredDays || [],
        difficulty: overrides.difficulty || 3,
        priority: overrides.priority || 0,
    };
}

function room(id, roomType, overrides = {}) {
    return {
        id,
        roomName: overrides.roomName || id,
        roomType,
        capacity: overrides.capacity ?? 40,
        unavailable: overrides.unavailable || [],
        subjects: overrides.subjects || [],
        homeSection: overrides.homeSection || null,
    };
}

/** A small but realistic single-section school. */
function basicSchool(overrides = {}) {
    return {
        days: DAYS6,
        sections: [section('s1', { days: DAYS6 })],
        teachers: [
            teacher('t-math',  { subjectIds: ['math'] }),
            teacher('t-eng',   { subjectIds: ['english'] }),
            teacher('t-sci',   { subjectIds: ['science'] }),
            teacher('t-hindi', { subjectIds: ['hindi'] }),
        ],
        requirements: [
            requirement('s1', 'math',    6, { teacherId: 't-math',  subjectName: 'Mathematics', difficulty: 5 }),
            requirement('s1', 'english', 5, { teacherId: 't-eng',   subjectName: 'English' }),
            requirement('s1', 'science', 5, { teacherId: 't-sci',   subjectName: 'Science', difficulty: 4 }),
            requirement('s1', 'hindi',   4, { teacherId: 't-hindi', subjectName: 'Hindi' }),
        ],
        rooms: [],
        seed: 42,
        ...overrides,
    };
}

/** Every generated entry, keyed for clash inspection. */
function entriesOf(result) {
    return result.assignments;
}
const errorsOf = (result) => result.conflicts.filter((c) => c.severity === SEVERITY.ERROR);

/* ══════════════════════════════════════════════════════════════════════════
   1. Basic generation
   ══════════════════════════════════════════════════════════════════════════ */

group('1. Basic generation');

test('generates a timetable satisfying every weekly requirement', () => {
    const result = generate(basicSchool());
    assert.strictEqual(errorsOf(result).length, 0, `unexpected errors: ${JSON.stringify(errorsOf(result).map((c) => c.description))}`);
    assert.strictEqual(result.assignments.length, 20, 'expected 6+5+5+4 = 20 periods');
    assert.strictEqual(result.stats.entriesGenerated, 20);
});

test('never schedules a subject into a break or lunch period', () => {
    const result = generate(basicSchool());
    // The fixture's lunch has periodNumber 0 and P1..P8 are teaching.
    for (const a of result.assignments) {
        assert.ok(a.periodNumber >= 1 && a.periodNumber <= 8, `period ${a.periodNumber} is not a teaching slot`);
    }
});

test('is reproducible: same seed produces an identical timetable', () => {
    const a = generate(basicSchool({ seed: 12345 }));
    const b = generate(basicSchool({ seed: 12345 }));
    assert.deepStrictEqual(
        a.assignments.map((x) => `${x.sectionId}|${x.dayOfWeek}|${x.periodNumber}|${x.subjectId}`),
        b.assignments.map((x) => `${x.sectionId}|${x.dayOfWeek}|${x.periodNumber}|${x.subjectId}`),
    );
});

test('different seeds explore different timetables', () => {
    const a = generate(basicSchool({ seed: 1 }));
    const b = generate(basicSchool({ seed: 987654 }));
    const key = (r) => r.assignments.map((x) => `${x.dayOfWeek}|${x.periodNumber}|${x.subjectId}`).join(',');
    assert.notStrictEqual(key(a), key(b), 'two very different seeds produced the same layout');
});

/* ══════════════════════════════════════════════════════════════════════════
   2-4. Clash prevention
   ══════════════════════════════════════════════════════════════════════════ */

group('2. Class clash prevention');

test('a section never has two subjects in the same period', () => {
    const result = generate(basicSchool());
    const seen = new Set();
    for (const a of entriesOf(result)) {
        const key = `${a.sectionId}#${slotKey(a.dayOfWeek, a.periodNumber)}`;
        assert.ok(!seen.has(key), `class clash at ${key}`);
        seen.add(key);
    }
});

group('3. Teacher clash prevention');

test('one teacher shared by three sections is never double-booked', () => {
    const input = {
        days: DAYS6,
        sections: [section('s1', { days: DAYS6 }), section('s2', { days: DAYS6 }), section('s3', { days: DAYS6 })],
        teachers: [
            teacher('t-shared', { subjectIds: ['math'] }),
            teacher('t-a', { subjectIds: ['english'] }),
            teacher('t-b', { subjectIds: ['english'] }),
            teacher('t-c', { subjectIds: ['english'] }),
        ],
        requirements: [
            requirement('s1', 'math', 6, { teacherId: 't-shared' }),
            requirement('s2', 'math', 6, { teacherId: 't-shared' }),
            requirement('s3', 'math', 6, { teacherId: 't-shared' }),
            requirement('s1', 'english', 5, { teacherId: 't-a' }),
            requirement('s2', 'english', 5, { teacherId: 't-b' }),
            requirement('s3', 'english', 5, { teacherId: 't-c' }),
        ],
        rooms: [],
        seed: 7,
    };
    const result = generate(input);
    assert.strictEqual(errorsOf(result).length, 0, JSON.stringify(errorsOf(result).map((c) => c.description)));
    const seen = new Set();
    for (const a of entriesOf(result)) {
        if (!a.teacherId) continue;
        const key = `${a.teacherId}#${slotKey(a.dayOfWeek, a.periodNumber)}`;
        assert.ok(!seen.has(key), `teacher clash at ${key}`);
        seen.add(key);
    }
    assert.strictEqual(entriesOf(result).length, 33);
});

test('a second teacher is used when the primary is already booked', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1'), section('s2')],
        teachers: [teacher('t1', { subjectIds: ['math'] }), teacher('t2', { subjectIds: ['math'] })],
        requirements: [
            // 30 periods of maths across two sections needs both teachers.
            requirement('s1', 'math', 15, { teacherId: 't1', altTeacherIds: ['t2'], maxPerDay: 3 }),
            requirement('s2', 'math', 15, { teacherId: 't1', altTeacherIds: ['t2'], maxPerDay: 3 }),
        ],
        rooms: [],
        seed: 3,
    };
    const result = generate(input);
    const used = new Set(entriesOf(result).map((a) => a.teacherId));
    assert.strictEqual(used.size, 2, 'expected both teachers to be used');
});

group('4. Room clash prevention');

test('a single computer lab is never booked by two sections at once', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1'), section('s2'), section('s3')],
        teachers: [
            teacher('t1', { subjectIds: ['comp'] }),
            teacher('t2', { subjectIds: ['comp'] }),
            teacher('t3', { subjectIds: ['comp'] }),
        ],
        requirements: [
            requirement('s1', 'comp', 2, { teacherId: 't1', subjectType: 'Laboratory', consecutivePeriods: 2, maxPerDay: 2, requiresRoom: true, roomTypes: ['Computer Lab'] }),
            requirement('s2', 'comp', 2, { teacherId: 't2', subjectType: 'Laboratory', consecutivePeriods: 2, maxPerDay: 2, requiresRoom: true, roomTypes: ['Computer Lab'] }),
            requirement('s3', 'comp', 2, { teacherId: 't3', subjectType: 'Laboratory', consecutivePeriods: 2, maxPerDay: 2, requiresRoom: true, roomTypes: ['Computer Lab'] }),
        ],
        rooms: [room('lab1', 'Computer Lab', { capacity: 40 })],
        seed: 11,
    };
    const result = generate(input);
    assert.strictEqual(errorsOf(result).length, 0, JSON.stringify(errorsOf(result).map((c) => c.description)));
    const seen = new Set();
    for (const a of entriesOf(result)) {
        if (!a.roomId) continue;
        const key = `${a.roomId}#${slotKey(a.dayOfWeek, a.periodNumber)}`;
        assert.ok(!seen.has(key), `room clash at ${key}`);
        seen.add(key);
    }
    assert.strictEqual(entriesOf(result).filter((a) => a.roomId === 'lab1').length, 6);
});

/* ══════════════════════════════════════════════════════════════════════════
   5-6. Availability
   ══════════════════════════════════════════════════════════════════════════ */

group('5. Teacher availability');

test('a teacher is never scheduled in a slot they marked unavailable', () => {
    const blocked = [];
    for (const d of DAYS5) for (const p of [1, 2, 3]) blocked.push({ dayOfWeek: d, periodNumber: p });
    const input = basicSchool({
        teachers: [
            teacher('t-math', { subjectIds: ['math'], unavailable: blocked }),
            teacher('t-eng',   { subjectIds: ['english'] }),
            teacher('t-sci',   { subjectIds: ['science'] }),
            teacher('t-hindi', { subjectIds: ['hindi'] }),
        ],
        seed: 5,
    });
    const result = generate(input);
    assert.strictEqual(errorsOf(result).length, 0, JSON.stringify(errorsOf(result).map((c) => c.description)));
    for (const a of entriesOf(result)) {
        if (a.teacherId !== 't-math') continue;
        assert.ok(a.periodNumber > 3, `maths teacher scheduled at unavailable ${a.dayOfWeek} P${a.periodNumber}`);
    }
});

group('6. Room availability');

test('a room blocked for maintenance is never booked in that slot', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1')],
        teachers: [teacher('t1', { subjectIds: ['physics'] })],
        requirements: [
            requirement('s1', 'physics', 6, { teacherId: 't1', subjectType: 'Laboratory', consecutivePeriods: 2, maxPerDay: 2, requiresRoom: true, roomTypes: ['Physics Lab'] }),
        ],
        rooms: [room('plab', 'Physics Lab', {
            unavailable: DAYS5.map((d) => ({ dayOfWeek: d, periodNumber: 1 }))
                .concat(DAYS5.map((d) => ({ dayOfWeek: d, periodNumber: 2 }))),
        })],
        seed: 9,
    };
    const result = generate(input);
    assert.strictEqual(errorsOf(result).length, 0, JSON.stringify(errorsOf(result).map((c) => c.description)));
    for (const a of entriesOf(result)) {
        assert.ok(a.periodNumber > 2, `lab booked in a blocked slot: ${a.dayOfWeek} P${a.periodNumber}`);
    }
});

test('room capacity smaller than the class is rejected as a placement', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1', { strength: 50 })],
        teachers: [teacher('t1', { subjectIds: ['comp'] })],
        requirements: [
            requirement('s1', 'comp', 2, { teacherId: 't1', requiresRoom: true, roomTypes: ['Computer Lab'], consecutivePeriods: 2, maxPerDay: 2 }),
        ],
        rooms: [room('small', 'Computer Lab', { capacity: 20 })],
        enforceRoomCapacity: true,
        seed: 2,
    };
    const result = generate(input);
    const capacityIssue = result.conflicts.find((c) => c.type === CONFLICT_TYPES.PRACTICAL_ROOM_MISSING);
    assert.ok(capacityIssue, 'expected a room-capacity/availability conflict to be reported');
});

/* ══════════════════════════════════════════════════════════════════════════
   7-9. Subject rules
   ══════════════════════════════════════════════════════════════════════════ */

group('7. Weekly subject requirements');

test('each subject gets exactly its weekly period count', () => {
    const result = generate(basicSchool());
    const counts = {};
    for (const a of entriesOf(result)) counts[a.subjectId] = (counts[a.subjectId] || 0) + 1;
    assert.deepStrictEqual(counts, { math: 6, english: 5, science: 5, hindi: 4 });
});

test('max-per-day of 1 is honoured for a 6-period subject', () => {
    const result = generate(basicSchool());
    const perDay = {};
    for (const a of entriesOf(result)) {
        if (a.subjectId !== 'math') continue;
        perDay[a.dayOfWeek] = (perDay[a.dayOfWeek] || 0) + 1;
    }
    for (const [day, n] of Object.entries(perDay)) {
        assert.strictEqual(n, 1, `maths ran ${n} times on ${day}, max is 1`);
    }
});

test('a weekly quota that cannot fit under its own per-day cap is reported up front', () => {
    // 6 periods/week at 1 per day across a 5-day week = at most 5.
    const input = basicSchool({ days: DAYS5, sections: [section('s1', { days: DAYS5 })] });
    const result = generate(input);
    const c = result.conflicts.find((x) => x.type === CONFLICT_TYPES.SUBJECT_PERIOD_SHORTAGE);
    assert.ok(c, 'expected a period-shortage conflict');
    assert.match(c.description, /requires 6 periods\/week/);
    assert.match(c.suggestion, /max per day/);
});

group('8. Practical subjects');

test('a practical subject is placed in a compatible lab', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1')],
        teachers: [teacher('t1', { subjectIds: ['chem'] })],
        requirements: [
            requirement('s1', 'chem', 4, { teacherId: 't1', subjectType: 'Laboratory', consecutivePeriods: 2, maxPerDay: 2, requiresRoom: true, roomTypes: ['Chemistry Lab'] }),
        ],
        rooms: [room('clab', 'Chemistry Lab'), room('cls', 'Classroom')],
        seed: 4,
    };
    const result = generate(input);
    assert.strictEqual(errorsOf(result).length, 0);
    assert.ok(entriesOf(result).every((a) => a.roomId === 'clab'), 'practical must land in the chemistry lab');
});

test('a lab requirement with no lab in the school reports PRACTICAL_ROOM_MISSING', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1')],
        teachers: [teacher('t1', { subjectIds: ['bio'] })],
        requirements: [
            requirement('s1', 'bio', 2, { teacherId: 't1', subjectType: 'Laboratory', requiresRoom: true, roomTypes: ['Biology Lab'], consecutivePeriods: 2, maxPerDay: 2 }),
        ],
        rooms: [room('cls', 'Classroom')],
        seed: 6,
    };
    const result = generate(input);
    const c = result.conflicts.find((x) => x.type === CONFLICT_TYPES.PRACTICAL_ROOM_MISSING);
    assert.ok(c, 'expected PRACTICAL_ROOM_MISSING');
    assert.strictEqual(c.severity, SEVERITY.ERROR);
});

test('a school with no rooms at all still generates (room allocation skipped)', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1')],
        teachers: [teacher('t1', { subjectIds: ['sci'] }), teacher('t2', { subjectIds: ['math'] })],
        requirements: [
            requirement('s1', 'sci', 4, { teacherId: 't1', subjectType: 'Practical', consecutivePeriods: 2, maxPerDay: 2 }),
            requirement('s1', 'math', 5, { teacherId: 't2' }),
        ],
        rooms: [],
        seed: 8,
    };
    const result = generate(input);
    assert.strictEqual(errorsOf(result).length, 0, JSON.stringify(errorsOf(result).map((c) => c.description)));
    assert.strictEqual(entriesOf(result).length, 9);
    assert.ok(result.conflicts.some((c) => c.severity === SEVERITY.WARNING && c.type === CONFLICT_TYPES.PRACTICAL_ROOM_MISSING));
});

group('9. Consecutive periods');

test('a 2-period lab always lands in back-to-back slots', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1')],
        teachers: [teacher('t1', { subjectIds: ['comp'] }), teacher('t2', { subjectIds: ['math'] })],
        requirements: [
            requirement('s1', 'comp', 4, { teacherId: 't1', subjectType: 'Laboratory', consecutivePeriods: 2, maxPerDay: 2, requiresRoom: true, roomTypes: ['Computer Lab'] }),
            requirement('s1', 'math', 5, { teacherId: 't2' }),
        ],
        rooms: [room('lab', 'Computer Lab')],
        seed: 13,
    };
    const result = generate(input);
    const byDay = {};
    for (const a of entriesOf(result)) {
        if (a.subjectId !== 'comp') continue;
        (byDay[a.dayOfWeek] = byDay[a.dayOfWeek] || []).push(a.periodNumber);
    }
    for (const [day, ps] of Object.entries(byDay)) {
        ps.sort((x, y) => x - y);
        assert.strictEqual(ps.length, 2, `expected a pair on ${day}, got ${ps}`);
        assert.strictEqual(ps[1] - ps[0], 1, `lab periods not adjacent on ${day}: ${ps}`);
    }
});

test('a consecutive block never straddles the lunch break', () => {
    // Lunch sits after P4, so a pair may never be P4+P5.
    const input = {
        days: DAYS5,
        sections: [section('s1', { periods: periods(8, { lunchAfter: 4 }) })],
        teachers: [teacher('t1', { subjectIds: ['comp'] })],
        requirements: [
            requirement('s1', 'comp', 10, { teacherId: 't1', consecutivePeriods: 2, maxPerDay: 2, subjectType: 'Laboratory' }),
        ],
        rooms: [],
        seed: 21,
    };
    const result = generate(input);
    const byDay = {};
    for (const a of entriesOf(result)) (byDay[a.dayOfWeek] = byDay[a.dayOfWeek] || []).push(a.periodNumber);
    for (const [day, ps] of Object.entries(byDay)) {
        ps.sort((x, y) => x - y);
        assert.ok(!(ps.includes(4) && ps.includes(5) && ps.length === 2), `block straddled lunch on ${day}`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
   10. Teacher workload
   ══════════════════════════════════════════════════════════════════════════ */

group('10. Teacher daily/weekly limits');

test('a hard daily limit of 2 is never exceeded', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1')],
        teachers: [
            teacher('t-capped', { subjectIds: ['math'], maxPeriodsPerDay: 2, hardDailyLimit: true }),
            teacher('t-free', { subjectIds: ['eng'] }),
        ],
        requirements: [
            requirement('s1', 'math', 10, { teacherId: 't-capped', maxPerDay: 2 }),
            requirement('s1', 'eng', 5, { teacherId: 't-free' }),
        ],
        rooms: [],
        seed: 17,
    };
    const result = generate(input);
    const perDay = {};
    for (const a of entriesOf(result)) {
        if (a.teacherId !== 't-capped') continue;
        perDay[a.dayOfWeek] = (perDay[a.dayOfWeek] || 0) + 1;
    }
    for (const [day, n] of Object.entries(perDay)) assert.ok(n <= 2, `${n} periods on ${day} exceeds the cap of 2`);
});

test('a weekly limit lower than the demand is reported before solving', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1')],
        teachers: [teacher('t1', { subjectIds: ['math'], maxPeriodsPerWeek: 4 })],
        requirements: [requirement('s1', 'math', 10, { teacherId: 't1', maxPerDay: 2 })],
        rooms: [],
        seed: 19,
    };
    const result = generate(input);
    const c = result.conflicts.find((x) => x.type === CONFLICT_TYPES.WEEKLY_LIMIT_EXCEEDED);
    assert.ok(c, 'expected WEEKLY_LIMIT_EXCEEDED from preflight');
    assert.match(c.description, /can only teach 4/);
});

/* ══════════════════════════════════════════════════════════════════════════
   11-12. Impossible timetables & conflict reporting
   ══════════════════════════════════════════════════════════════════════════ */

group('11. Impossible timetable');

test('demanding more periods than the week holds is reported, not silently truncated', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1', { periods: periods(4) })], // 4 teaching periods × 5 days = 20
        teachers: [teacher('t1', { subjectIds: ['math'] }), teacher('t2', { subjectIds: ['eng'] })],
        requirements: [
            requirement('s1', 'math', 15, { teacherId: 't1', maxPerDay: 4 }),
            requirement('s1', 'eng', 15, { teacherId: 't2', maxPerDay: 4 }),
        ],
        rooms: [],
        seed: 23,
    };
    const result = generate(input);
    const shortage = result.conflicts.find((c) => c.type === CONFLICT_TYPES.SUBJECT_PERIOD_SHORTAGE);
    assert.ok(shortage, 'expected SUBJECT_PERIOD_SHORTAGE');
    assert.strictEqual(shortage.severity, SEVERITY.ERROR);
    // Whatever DID fit is still returned so the admin can work from it.
    assert.ok(result.assignments.length > 0 && result.assignments.length <= 20);
});

test('a subject with no teacher is reported', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1')],
        teachers: [],
        requirements: [requirement('s1', 'math', 5)],
        rooms: [],
        seed: 29,
    };
    const result = generate(input);
    assert.ok(result.conflicts.some((c) => c.type === CONFLICT_TYPES.NO_TEACHER_ASSIGNED));
});

group('12. Conflict reporting shape');

test('every conflict carries a type, severity, description and suggestion', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1', { periods: periods(3) })],
        teachers: [teacher('t1', { subjectIds: ['math'], maxPeriodsPerWeek: 2 })],
        requirements: [requirement('s1', 'math', 12, { teacherId: 't1', maxPerDay: 3 })],
        rooms: [],
        seed: 31,
    };
    const result = generate(input);
    assert.ok(result.conflicts.length > 0);
    for (const c of result.conflicts) {
        assert.ok(Object.values(CONFLICT_TYPES).includes(c.type), `unknown type ${c.type}`);
        assert.ok([SEVERITY.ERROR, SEVERITY.WARNING, SEVERITY.INFO].includes(c.severity));
        assert.ok(c.description && c.description.length > 5, 'conflict needs a human description');
        assert.ok(c.suggestion && c.suggestion.length > 5, 'conflict needs a suggested resolution');
    }
});

/* ══════════════════════════════════════════════════════════════════════════
   13-14. Validation & manual moves
   ══════════════════════════════════════════════════════════════════════════ */

group('13. Manual move validation');

test('a legal move is allowed', () => {
    const input = basicSchool();
    const result = generate(input);
    const ctx = compile(input);
    const entries = result.assignments.map((a, i) => ({
        _id: `e${i}`, sectionId: a.sectionId, subjectId: a.subjectId,
        teacherId: a.teacherId, roomId: a.roomId, dayOfWeek: a.dayOfWeek, periodNumber: a.periodNumber,
    }));
    // Find a genuinely empty slot in the section's week.
    const used = new Set(entries.map((e) => `${e.dayOfWeek}#${e.periodNumber}`));
    let target = null;
    for (const d of DAYS6) for (let p = 1; p <= 8 && !target; p++) if (!used.has(`${d}#${p}`)) target = { d, p };
    assert.ok(target, 'fixture should leave a free slot');

    const move = { entryId: 'e0', dayOfWeek: target.d, periodNumber: target.p };
    const check = validateMove(ctx, entries, move);
    assert.strictEqual(check.ok, true, `move rejected: ${JSON.stringify(check.blocking)}`);
});

test('a move onto an occupied slot is rejected with a class clash', () => {
    const input = basicSchool();
    const result = generate(input);
    const ctx = compile(input);
    const entries = result.assignments.map((a, i) => ({
        _id: `e${i}`, sectionId: a.sectionId, subjectId: a.subjectId,
        teacherId: a.teacherId, roomId: a.roomId, dayOfWeek: a.dayOfWeek, periodNumber: a.periodNumber,
    }));
    const target = entries[1];
    const check = validateMove(ctx, entries, { entryId: 'e0', dayOfWeek: target.dayOfWeek, periodNumber: target.periodNumber });
    assert.strictEqual(check.ok, false);
    assert.ok(check.blocking.some((c) => c.type === CONFLICT_TYPES.CLASS_CLASH));
});

test('a move that double-books a teacher in another section is rejected', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1'), section('s2')],
        teachers: [teacher('t1', { subjectIds: ['math'] })],
        requirements: [
            requirement('s1', 'math', 1, { teacherId: 't1' }),
            requirement('s2', 'math', 1, { teacherId: 't1' }),
        ],
        rooms: [],
        seed: 37,
    };
    const ctx = compile(input);
    const entries = [
        { _id: 'a', sectionId: 's1', subjectId: 'math', teacherId: 't1', roomId: null, dayOfWeek: 'Monday', periodNumber: 1 },
        { _id: 'b', sectionId: 's2', subjectId: 'math', teacherId: 't1', roomId: null, dayOfWeek: 'Tuesday', periodNumber: 1 },
    ];
    const check = validateMove(ctx, entries, { entryId: 'b', dayOfWeek: 'Monday', periodNumber: 1 });
    assert.strictEqual(check.ok, false);
    assert.ok(check.blocking.some((c) => c.type === CONFLICT_TYPES.TEACHER_CLASH));
});

test('a move into a lunch period is rejected', () => {
    const input = basicSchool();
    const ctx = compile(input);
    const entries = [{ _id: 'a', sectionId: 's1', subjectId: 'math', teacherId: 't-math', roomId: null, dayOfWeek: 'Monday', periodNumber: 1 }];
    const check = validateMove(ctx, entries, { entryId: 'a', dayOfWeek: 'Monday', periodNumber: 0 });
    assert.strictEqual(check.ok, false);
    assert.ok(check.blocking.some((c) => c.type === CONFLICT_TYPES.NON_TEACHING_SLOT));
});

group('14. Publish validation');

test('a freshly generated timetable validates clean', () => {
    const input = basicSchool();
    const result = generate(input);
    const ctx = compile(input);
    const report = validate(ctx, result.assignments);
    assert.strictEqual(report.valid, true, JSON.stringify(report.conflicts.map((c) => c.description)));
    assert.strictEqual(report.stats.errorCount, 0);
});

test('validation independently catches a hand-injected teacher clash', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1'), section('s2')],
        teachers: [teacher('t1', { subjectIds: ['math'] })],
        requirements: [
            requirement('s1', 'math', 1, { teacherId: 't1' }),
            requirement('s2', 'math', 1, { teacherId: 't1' }),
        ],
        rooms: [],
    };
    const ctx = compile(input);
    const report = validate(ctx, [
        { sectionId: 's1', subjectId: 'math', teacherId: 't1', dayOfWeek: 'Monday', periodNumber: 1 },
        { sectionId: 's2', subjectId: 'math', teacherId: 't1', dayOfWeek: 'Monday', periodNumber: 1 },
    ]);
    assert.strictEqual(report.valid, false);
    assert.ok(report.conflicts.some((c) => c.type === CONFLICT_TYPES.TEACHER_CLASH));
});

test('validation catches an unmet weekly requirement', () => {
    const input = basicSchool();
    const ctx = compile(input);
    const report = validate(ctx, [
        { sectionId: 's1', subjectId: 'math', teacherId: 't-math', dayOfWeek: 'Monday', periodNumber: 1 },
    ]);
    assert.strictEqual(report.valid, false);
    const shortage = report.conflicts.find((c) => c.type === CONFLICT_TYPES.SUBJECT_PERIOD_SHORTAGE && c.subjectId === 'math');
    assert.ok(shortage);
    assert.match(shortage.description, /1 of 6/);
});

test('validation catches a room double-booking', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1'), section('s2')],
        teachers: [teacher('t1', { subjectIds: ['comp'] }), teacher('t2', { subjectIds: ['comp'] })],
        requirements: [
            requirement('s1', 'comp', 1, { teacherId: 't1' }),
            requirement('s2', 'comp', 1, { teacherId: 't2' }),
        ],
        rooms: [room('lab', 'Computer Lab')],
    };
    const ctx = compile(input);
    const report = validate(ctx, [
        { sectionId: 's1', subjectId: 'comp', teacherId: 't1', roomId: 'lab', dayOfWeek: 'Monday', periodNumber: 1 },
        { sectionId: 's2', subjectId: 'comp', teacherId: 't2', roomId: 'lab', dayOfWeek: 'Monday', periodNumber: 1 },
    ]);
    assert.ok(report.conflicts.some((c) => c.type === CONFLICT_TYPES.ROOM_CLASH));
});

/* ══════════════════════════════════════════════════════════════════════════
   16-18. Regeneration, multi-class, whole school
   ══════════════════════════════════════════════════════════════════════════ */

group('16. Regeneration with manual edits preserved');

test('pinned entries survive a regeneration', () => {
    const input = basicSchool({
        seed: 101,
        pinned: [{ sectionId: 's1', subjectId: 'math', dayOfWeek: 'Monday', periodNumber: 1, size: 1, teacherId: 't-math' }],
    });
    const result = generate(input);
    const pinnedEntry = result.assignments.find((a) => a.dayOfWeek === 'Monday' && a.periodNumber === 1);
    assert.ok(pinnedEntry, 'pinned slot should be filled');
    assert.strictEqual(pinnedEntry.subjectId, 'math');
    assert.strictEqual(pinnedEntry.isManual, true);
});

group('17. Multiple classes');

test('six sections with shared teachers generate without hard violations', () => {
    const sections = [];
    const requirements = [];
    const teachers = [];
    const subjects = ['math', 'english', 'science', 'hindi', 'social'];
    for (const s of subjects) {
        // Two teachers per subject shared across all six sections.
        teachers.push(teacher(`t-${s}-1`, { subjectIds: [s] }));
        teachers.push(teacher(`t-${s}-2`, { subjectIds: [s] }));
    }
    for (let i = 1; i <= 6; i++) {
        sections.push(section(`s${i}`));
        subjects.forEach((s, k) => {
            requirements.push(requirement(`s${i}`, s, k === 0 ? 6 : 5, {
                teacherId: `t-${s}-${(i % 2) + 1}`,
                altTeacherIds: [`t-${s}-${((i + 1) % 2) + 1}`],
                maxPerDay: 2,
            }));
        });
    }
    const result = generate({ days: DAYS5, sections, teachers, requirements, rooms: [], seed: 55 });
    const ctx = compile({ days: DAYS5, sections, teachers, requirements, rooms: [], seed: 55 });
    const report = validate(ctx, result.assignments);
    const hard = report.conflicts.filter((c) => c.severity === SEVERITY.ERROR);
    assert.strictEqual(hard.length, 0, JSON.stringify(hard.slice(0, 3).map((c) => c.description)));
    assert.strictEqual(result.assignments.length, 6 * 26);
});

group('18. Whole-school scale');

test('24 sections × 6 subjects generates within budget and validates clean', () => {
    const sections = [];
    const requirements = [];
    const teachers = [];
    const subjects = ['math', 'english', 'science', 'hindi', 'social', 'computer'];
    // 6 teachers per subject → 36 teachers, each carrying ~4 sections.
    for (const s of subjects) {
        for (let k = 1; k <= 6; k++) teachers.push(teacher(`t-${s}-${k}`, { subjectIds: [s], maxPeriodsPerDay: 7, maxPeriodsPerWeek: 32 }));
    }
    for (let i = 1; i <= 24; i++) {
        sections.push(section(`s${i}`, { strength: 35 }));
        subjects.forEach((s) => {
            const k = ((i - 1) % 6) + 1;
            requirements.push(requirement(`s${i}`, s, 6, {
                teacherId: `t-${s}-${k}`,
                altTeacherIds: [`t-${s}-${(k % 6) + 1}`],
                maxPerDay: 2,
            }));
        });
    }
    const input = { days: DAYS5, sections, teachers, requirements, rooms: [], seed: 77, solver: { timeBudgetMs: 30000, maxRestarts: 2, optimiseRounds: 1500 } };
    const started = Date.now();
    const result = generate(input);
    const elapsed = Date.now() - started;

    const report = validate(compile(input), result.assignments);
    const hard = report.conflicts.filter((c) => c.severity === SEVERITY.ERROR);

    console.log(`      → ${result.assignments.length} entries, ${elapsed}ms, ${hard.length} hard conflicts, score ${result.stats.softScore}`);
    assert.strictEqual(hard.length, 0, JSON.stringify(hard.slice(0, 3).map((c) => c.description)));
    assert.strictEqual(result.assignments.length, 24 * 36);
    assert.ok(elapsed < 60000, `generation took ${elapsed}ms`);
});

/* ══════════════════════════════════════════════════════════════════════════
   Soft constraints
   ══════════════════════════════════════════════════════════════════════════ */

group('19. Soft-constraint optimisation');

test('subjects are spread across the week rather than stacked on one day', () => {
    const result = generate(basicSchool({ seed: 71 }));
    const daysUsed = new Set(result.assignments.filter((a) => a.subjectId === 'math').map((a) => a.dayOfWeek));
    assert.ok(daysUsed.size >= 4, `maths only touched ${daysUsed.size} day(s)`);
});

test('minimizeStudentGaps actually reduces mid-day holes', () => {
    const countHoles = (result) => {
        const perDay = {};
        for (const a of result.assignments) (perDay[a.dayOfWeek] = perDay[a.dayOfWeek] || []).push(a.periodNumber);
        let holes = 0;
        for (const ps of Object.values(perDay)) {
            ps.sort((a, b) => a - b);
            holes += (ps[ps.length - 1] - ps[0] + 1) - ps.length;
        }
        return holes;
    };
    const on  = countHoles(generate(basicSchool({ seed: 91 })));
    const off = countHoles(generate(basicSchool({ seed: 91, options: { minimizeStudentGaps: false } })));
    assert.ok(on <= off, `gaps with the option on (${on}) should not exceed with it off (${off})`);
});

test('turning a soft option off does not break hard constraints', () => {
    const result = generate(basicSchool({
        seed: 61,
        options: {
            avoidSameSubjectTwiceADay: false, balanceDifficultSubjects: false,
            minimizeTeacherGaps: false, minimizeStudentGaps: false,
            preferTeacherAvailability: false, keepPracticalsConsecutive: false,
            spreadAcrossWeek: false,
        },
    }));
    assert.strictEqual(errorsOf(result).length, 0);
    assert.strictEqual(result.assignments.length, 20);
});

/* ══════════════════════════════════════════════════════════════════════════
   Edge cases from the spec
   ══════════════════════════════════════════════════════════════════════════ */

group('20. Edge cases');

test('a section that works Saturday gets Saturday periods; one that does not, does not', () => {
    const withSat = section('s1', { days: [...DAYS5, 'Saturday'] });
    const input = {
        days: [...DAYS5, 'Saturday'],
        sections: [withSat, section('s2', { days: DAYS5 })],
        teachers: [teacher('t1', { subjectIds: ['math'] }), teacher('t2', { subjectIds: ['math'] })],
        requirements: [
            requirement('s1', 'math', 6, { teacherId: 't1', maxPerDay: 1 }),
            requirement('s2', 'math', 5, { teacherId: 't2', maxPerDay: 1 }),
        ],
        rooms: [],
        seed: 43,
    };
    const result = generate(input);
    assert.strictEqual(errorsOf(result).length, 0, JSON.stringify(errorsOf(result).map((c) => c.description)));
    assert.ok(result.assignments.some((a) => a.sectionId === 's1' && a.dayOfWeek === 'Saturday'), 's1 should use Saturday for its 6th period');
    assert.ok(!result.assignments.some((a) => a.sectionId === 's2' && a.dayOfWeek === 'Saturday'), 's2 must never get a Saturday period');
});

test('a half-day Saturday with fewer periods is respected', () => {
    const sat = section('s1', { days: [...DAYS5, 'Saturday'] });
    sat.periodsByDay = {};
    for (const d of DAYS5) sat.periodsByDay[d] = periods(8);
    sat.periodsByDay.Saturday = periods(3, { lunchAfter: 99 });
    const input = {
        days: [...DAYS5, 'Saturday'],
        sections: [sat],
        teachers: [teacher('t1', { subjectIds: ['math'] })],
        requirements: [requirement('s1', 'math', 6, { teacherId: 't1', maxPerDay: 1 })],
        rooms: [],
        seed: 47,
    };
    const result = generate(input);
    for (const a of result.assignments) {
        if (a.dayOfWeek === 'Saturday') assert.ok(a.periodNumber <= 3, `Saturday only has 3 periods, got P${a.periodNumber}`);
    }
});

test('an odd number of periods for a paired subject still schedules the remainder', () => {
    const input = {
        days: DAYS5,
        sections: [section('s1')],
        teachers: [teacher('t1', { subjectIds: ['comp'] })],
        requirements: [
            requirement('s1', 'comp', 5, { teacherId: 't1', consecutivePeriods: 2, maxPerDay: 2, subjectType: 'Laboratory' }),
        ],
        rooms: [],
        seed: 53,
    };
    const result = generate(input);
    assert.strictEqual(errorsOf(result).length, 0);
    assert.strictEqual(result.assignments.length, 5, 'two pairs plus one single');
});

test('generation with zero requirements is a no-op, not a crash', () => {
    const result = generate({ days: DAYS5, sections: [section('s1')], teachers: [], requirements: [], rooms: [], seed: 1 });
    assert.strictEqual(result.assignments.length, 0);
    assert.strictEqual(result.conflicts.length, 0);
});

/* ── Summary ─────────────────────────────────────────────────────────────── */

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  • ${f.name}\n    ${f.error.stack?.split('\n').slice(0, 3).join('\n    ')}`);
    process.exit(1);
}
process.exit(0);
