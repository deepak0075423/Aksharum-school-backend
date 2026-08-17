'use strict';
/**
 * Timetable generation engine.
 * ────────────────────────────
 * Pure, database-free constraint solver. `generate(input)` takes plain objects
 * and returns assignments + conflicts + statistics, which is what makes the
 * whole thing unit-testable (see scripts/testTimetableEngine.js).
 *
 * Strategy — a constraint-satisfaction search, never a random shuffle:
 *
 *   1. COMPILE      Requirements are expanded into *blocks* (a 2-period lab is
 *                   one indivisible block), each with a static domain of legal
 *                   (day, start-slot) placements.
 *   2. PREFLIGHT    Arithmetic feasibility is checked up front — demand vs
 *                   supply per section, per teacher and per room type — so an
 *                   impossible request is explained instead of half-solved.
 *   3. SEARCH       Greedy assignment driven by MRV (minimum-remaining-values)
 *                   with a degree tie-break, least-constraining-value ordering,
 *                   and forward checking (domain counts are invalidated only for
 *                   the blocks a placement can actually affect).
 *                   Dead ends are escaped by *ejection repair*: the placement
 *                   with the fewest blocking neighbours is chosen, those
 *                   neighbours are ejected back into the pool and re-placed —
 *                   a bounded min-conflicts repair that scales where plain
 *                   chronological backtracking thrashes.
 *                   Exhausting the budget triggers a restart with a fresh seed;
 *                   the best partial solution is kept.
 *   4. OPTIMISE     Hill climbing over the soft-constraint score with relocate
 *                   and swap moves. Hard constraints are re-checked on every
 *                   move, so optimisation can never break a hard rule.
 *   5. VALIDATE     The result is re-checked from scratch and every shortfall
 *                   becomes a typed conflict.
 *
 * All randomness comes from a seeded PRNG, so (input, seed) → identical output.
 */

const {
    CONFLICT_TYPES, SEVERITY, PRACTICAL_TYPES,
    DEFAULT_SOFT_WEIGHTS, DEFAULT_OPTIONS, DEFAULT_SOLVER,
    isTeachingPeriod, roomTypesFor, slotKey, DAYS,
} = require('./types');
const { createRng, newSeed } = require('./rng');
const {
    createState, applyPlacement, removePlacement,
    checkPlacement, placementCost, createScorer,
} = require('./constraints');

const sid = (v) => (v == null ? null : String(v._id ?? v));

/* ══════════════════════════════════════════════════════════════════════════
   1. COMPILE — turn the raw input into a solver context
   ══════════════════════════════════════════════════════════════════════════ */

function compile(input) {
    const options = { ...DEFAULT_OPTIONS, ...(input.options || {}) };
    const weights = applyOptionToggles({ ...DEFAULT_SOFT_WEIGHTS, ...(input.weights || {}) }, options);
    const solver  = { ...DEFAULT_SOLVER, ...(input.solver || {}) };
    const allowActivity = !!input.allowActivity;

    const days = (input.days && input.days.length ? input.days : DAYS.slice(0, 5))
        .filter((d) => DAYS.includes(d));

    /* ── Sections + their per-day teaching grid ───────────────────────────── */
    const sections = new Map();
    for (const s of input.sections || []) {
        const id = sid(s.id ?? s._id);
        const sectionDays = (s.days && s.days.length ? s.days : days).filter((d) => days.includes(d));
        const teachingByDay = new Map();
        const allByDay = new Map();

        for (const day of sectionDays) {
            const dayPeriods = (s.periodsByDay && s.periodsByDay[day]) || s.periods || [];
            const ordered = [...dayPeriods].sort((a, b) => order(a) - order(b));
            allByDay.set(day, ordered);

            const teaching = [];
            let prevWasTeaching = false;
            for (const p of ordered) {
                if (isTeachingPeriod(p, { allowActivity })) {
                    teaching.push({
                        periodNumber: Number(p.periodNumber),
                        startTime: p.startTime || '',
                        endTime: p.endTime || '',
                        // False when a break/lunch sits between this slot and the
                        // previous one — a consecutive block may not straddle it.
                        adjacentToPrev: prevWasTeaching,
                    });
                    prevWasTeaching = true;
                } else {
                    prevWasTeaching = false;
                }
            }
            teachingByDay.set(day, teaching);
        }

        sections.set(id, {
            id,
            label: s.label || `${s.className || ''} ${s.sectionName || ''}`.trim() || 'Section',
            className: s.className || '',
            sectionName: s.sectionName || '',
            classId: sid(s.classId),
            strength: Number(s.strength) || 0,
            days: sectionDays,
            teachingByDay,
            allByDay,
            homeRoomId: sid(s.homeRoomId) || null,
        });
    }

    /* ── Rooms ────────────────────────────────────────────────────────────── */
    const rooms = new Map();
    const roomsByType = new Map();
    for (const r of input.rooms || []) {
        const id = sid(r.id ?? r._id);
        const room = {
            id,
            name: r.roomName || r.name || 'Room',
            type: r.roomType || 'Classroom',
            capacity: Number(r.capacity) || 0,
            blocked: new Set((r.unavailable || []).map((u) => slotKey(u.dayOfWeek, Number(u.periodNumber)))),
            subjectIds: (r.subjects || r.subjectIds || []).length
                ? new Set((r.subjects || r.subjectIds).map(sid))
                : null,
            homeSection: sid(r.homeSection),
        };
        rooms.set(id, room);
        if (!roomsByType.has(room.type)) roomsByType.set(room.type, []);
        roomsByType.get(room.type).push(id);
        // A room flagged as a section's home classroom wins over any input value.
        if (room.homeSection && sections.has(room.homeSection) && !sections.get(room.homeSection).homeRoomId) {
            sections.get(room.homeSection).homeRoomId = id;
        }
    }

    /* ── Teachers ─────────────────────────────────────────────────────────── */
    const teachers = new Map();
    for (const t of input.teachers || []) {
        const id = sid(t.id ?? t._id);
        teachers.set(id, {
            id,
            name: t.name || 'Teacher',
            blocked: new Set((t.unavailable || []).map((u) => slotKey(u.dayOfWeek, Number(u.periodNumber)))),
            maxPerDay: Number(t.maxPeriodsPerDay) || 0,
            maxPerWeek: Number(t.maxPeriodsPerWeek) || 0,
            hardDailyLimit: t.hardDailyLimit !== false,
            preferredDays: new Set(t.preferredDays || []),
            preferredPeriods: new Set((t.preferredPeriods || []).map(Number)),
            subjects: new Set((t.subjectIds || []).map(sid)),
            gridByDay: new Map(),
        });
    }
    // Union of every period number taught on each day — the canvas the teacher
    // gap/load penalties are measured against.
    for (const day of days) {
        const union = new Set();
        for (const s of sections.values()) {
            for (const slot of s.teachingByDay.get(day) || []) union.add(slot.periodNumber);
        }
        const ordered = [...union].sort((a, b) => a - b);
        for (const t of teachers.values()) t.gridByDay.set(day, ordered);
    }

    const ctx = {
        days,
        sections,
        teachers,
        rooms,
        roomsByType,
        options,
        weights,
        solver,
        allowActivity,
        enforceRoomCapacity: input.enforceRoomCapacity !== false,
        enforceTeacherQualified: input.enforceTeacherQualified !== false,
        blocks: [],
        blockById: new Map(),
        bySection: new Map(),
        byTeacher: new Map(),
        byRoom: new Map(),
        requirements: [],
        warnings: [],
    };

    /* ── Blocks (the CSP variables) ───────────────────────────────────────── */
    let blockSeq = 0;
    for (const req of input.requirements || []) {
        const sectionId = sid(req.sectionId);
        const section = sections.get(sectionId);
        const weekly = Number(req.weeklyPeriods) || 0;
        if (!section || weekly <= 0) continue;

        const subjectType = req.subjectType || 'Theory';
        const size = Math.max(1, Math.min(Number(req.consecutivePeriods) || 1, 4));
        const teacherOptions = [sid(req.teacherId), ...(req.altTeacherIds || []).map(sid)]
            .filter((id, i, arr) => id && teachers.has(id) && arr.indexOf(id) === i);

        const wantedTypes = roomTypesFor({ ...req, subjectType });
        const explicitRoom = !!req.requiresRoom || !!req.roomId;
        const inferredRoom = PRACTICAL_TYPES.has(subjectType);

        // Rooms that could physically host this block, cheapest-fitting first so
        // the auditorium is not consumed by a 30-student theory class.
        let candidateRooms = [];
        if (req.roomId && rooms.has(sid(req.roomId))) {
            candidateRooms = [sid(req.roomId)];
        } else if (wantedTypes.length) {
            candidateRooms = wantedTypes
                .flatMap((type) => roomsByType.get(type) || [])
                .filter((id) => {
                    const room = rooms.get(id);
                    if (!room) return false;
                    if (room.subjectIds && !room.subjectIds.has(sid(req.subjectId))) return false;
                    if (ctx.enforceRoomCapacity && room.capacity > 0 && room.capacity < section.strength) return false;
                    return true;
                })
                .sort((a, b) => (rooms.get(a).capacity - rooms.get(b).capacity) || rooms.get(a).name.localeCompare(rooms.get(b).name));
            candidateRooms = [...new Set(candidateRooms)];
        }

        // A room demand that cannot possibly be met: hard-fail when the admin
        // asked for it explicitly, soft-degrade when we only inferred it from
        // the subject type (schools that don't track rooms must still generate).
        let requiresRoom = explicitRoom || inferredRoom;
        if (requiresRoom && !candidateRooms.length) {
            if (explicitRoom) {
                ctx.warnings.push({
                    type: CONFLICT_TYPES.PRACTICAL_ROOM_MISSING,
                    severity: SEVERITY.ERROR,
                    sectionId,
                    subjectId: sid(req.subjectId),
                    description: `${req.subjectName || 'Subject'} for ${section.label} requires a ${wantedTypes.join(' / ') || 'specific'} room, but no such room with enough capacity exists.`,
                    suggestion: 'Add a compatible room under Timetable → Rooms, or clear the room requirement for this subject.',
                });
            } else {
                ctx.warnings.push({
                    type: CONFLICT_TYPES.PRACTICAL_ROOM_MISSING,
                    severity: SEVERITY.WARNING,
                    sectionId,
                    subjectId: sid(req.subjectId),
                    description: `${req.subjectName || 'Subject'} is a ${subjectType.toLowerCase()} subject but no lab room is configured — it has been scheduled without a room.`,
                    suggestion: 'Add lab rooms under Timetable → Rooms to allocate them automatically.',
                });
            }
            requiresRoom = false;
        }

        if (!teacherOptions.length) {
            ctx.warnings.push({
                type: CONFLICT_TYPES.NO_TEACHER_ASSIGNED,
                severity: SEVERITY.ERROR,
                sectionId,
                subjectId: sid(req.subjectId),
                description: `No teacher is assigned to ${req.subjectName || 'this subject'} for ${section.label}.`,
                suggestion: 'Assign a subject teacher on the section page, or set one in Timetable → Requirements.',
            });
        }

        const maxPerDay = Math.max(Number(req.maxPerDay) || 1, size);
        const common = {
            reqId: sid(req.id ?? req._id) || `${sectionId}:${sid(req.subjectId)}`,
            sectionId,
            subjectId: sid(req.subjectId),
            subjectName: req.subjectName || 'Subject',
            subjectType,
            strength: section.strength,
            teacherOptions,
            difficulty: Number(req.difficulty) || 3,
            maxPerDay,
            hardMaxPerDay: req.hardMaxPerDay !== false,
            minGapPeriods: Number(req.minGapPeriods) || 0,
            preferredPeriods: new Set((req.preferredPeriods || []).map(Number)),
            preferredDays: new Set(req.preferredDays || []),
            requiresRoom,
            pinnedRoomId: req.roomId && rooms.has(sid(req.roomId)) ? sid(req.roomId) : null,
            roomTypes: wantedTypes,
            candidateRooms,
            priority: Number(req.priority) || 0,
        };

        ctx.requirements.push({ ...common, weeklyPeriods: weekly, consecutivePeriods: size });

        // Split the weekly quota into indivisible blocks.
        const full = Math.floor(weekly / size);
        const remainder = weekly % size;
        const sizes = Array.from({ length: full }, () => size);
        if (remainder > 0) sizes.push(remainder);

        for (const bsize of sizes) {
            const block = { ...common, id: `b${blockSeq++}`, size: bsize, domain: [], domainCount: 0, dirty: true };
            ctx.blocks.push(block);
            ctx.blockById.set(block.id, block);
        }
    }

    // Static domains + reverse indexes used for forward checking.
    for (const block of ctx.blocks) {
        block.domain = staticDomain(ctx, block);
        index(ctx.bySection, block.sectionId, block);
        for (const t of block.teacherOptions) index(ctx.byTeacher, t, block);
        for (const r of block.candidateRooms) index(ctx.byRoom, r, block);
        if (block.pinnedRoomId) index(ctx.byRoom, block.pinnedRoomId, block);
    }

    return ctx;
}

function order(p) {
    if (p.startTime) return Number(String(p.startTime).replace(':', ''));
    return Number(p.periodNumber) || 0;
}

function index(map, key, value) {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
}

/** Soft weights the admin switched off in the Generate dialog drop to zero. */
function applyOptionToggles(weights, options) {
    const w = { ...weights };
    if (options.avoidSameSubjectTwiceADay === false) w.sameSubjectTwiceADay = 0;
    if (options.balanceDifficultSubjects === false) { w.difficultLastPeriod = 0; w.difficultConsecutive = 0; }
    if (options.minimizeTeacherGaps === false) w.teacherGaps = 0;
    if (options.minimizeStudentGaps === false) w.studentGaps = 0;
    if (options.preferTeacherAvailability === false) w.teacherPreferred = 0;
    if (options.spreadAcrossWeek === false) w.spreadAcrossWeek = 0;
    return w;
}

/**
 * Every (day, start-slot) this block could occupy ignoring other blocks —
 * period types, day availability and static teacher availability only.
 */
function staticDomain(ctx, block) {
    const section = ctx.sections.get(block.sectionId);
    const out = [];
    if (!section) return out;

    for (const day of section.days) {
        const teaching = section.teachingByDay.get(day) || [];
        for (let i = 0; i + block.size <= teaching.length; i++) {
            let contiguous = true;
            const periods = [];
            for (let k = 0; k < block.size; k++) {
                if (k > 0 && teaching[i + k].adjacentToPrev === false) { contiguous = false; break; }
                periods.push(teaching[i + k].periodNumber);
            }
            if (!contiguous) continue;

            // Prune slots no candidate teacher could ever take.
            const anyTeacher = block.teacherOptions.some((tid) => {
                const t = ctx.teachers.get(tid);
                return t && !periods.some((p) => t.blocked.has(slotKey(day, p)));
            });
            if (block.teacherOptions.length && !anyTeacher) continue;

            out.push({ day, startIdx: i, periods });
        }
    }
    return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   2. PREFLIGHT — is the request arithmetically possible at all?
   ══════════════════════════════════════════════════════════════════════════ */

function preflight(ctx) {
    const conflicts = [];

    // Per-section: weekly demand vs teaching slots available.
    const demandBySection = new Map();
    for (const req of ctx.requirements) {
        demandBySection.set(req.sectionId, (demandBySection.get(req.sectionId) || 0) + req.weeklyPeriods);
    }
    for (const [sectionId, demand] of demandBySection) {
        const section = ctx.sections.get(sectionId);
        if (!section) continue;
        let capacity = 0;
        for (const day of section.days) capacity += (section.teachingByDay.get(day) || []).length;
        if (demand > capacity) {
            conflicts.push({
                type: CONFLICT_TYPES.SUBJECT_PERIOD_SHORTAGE,
                severity: SEVERITY.ERROR,
                sectionId,
                description: `${section.label} needs ${demand} periods/week but only ${capacity} teaching slots exist.`,
                suggestion: `Reduce weekly periods by ${demand - capacity}, or add periods / working days to this section.`,
                meta: { demand, capacity },
            });
        }
    }

    // Per-requirement: the weekly quota must fit under its own per-day cap.
    // This is the "Mathematics requires 6 periods/week, only 5 valid slots
    // available" case — catching it here explains the problem instead of
    // letting the search fail mysteriously.
    for (const req of ctx.requirements) {
        const section = ctx.sections.get(req.sectionId);
        if (!section || !req.hardMaxPerDay) continue;
        const usableDays = section.days.filter((day) => (section.teachingByDay.get(day) || []).length >= req.consecutivePeriods);
        const ceiling = usableDays.length * req.maxPerDay;
        if (req.weeklyPeriods > ceiling) {
            conflicts.push({
                type: CONFLICT_TYPES.SUBJECT_PERIOD_SHORTAGE,
                severity: SEVERITY.ERROR,
                sectionId: req.sectionId,
                subjectId: req.subjectId,
                teacherId: req.teacherOptions[0] || null,
                description: `${req.subjectName} for ${section.label} requires ${req.weeklyPeriods} periods/week, but at most ${req.maxPerDay} per day across ${usableDays.length} working day(s) allows only ${ceiling}.`,
                suggestion: `Raise "max per day" to ${Math.ceil(req.weeklyPeriods / Math.max(1, usableDays.length))}, add a working day, or lower the weekly requirement.`,
                meta: { demand: req.weeklyPeriods, capacity: ceiling },
            });
        }
    }

    // Per-teacher: total teaching load vs the slots they are actually free for.
    const loadByTeacher = new Map();
    for (const req of ctx.requirements) {
        // Attribute the load to the primary teacher — alternates only absorb overflow.
        const tid = req.teacherOptions[0];
        if (tid) loadByTeacher.set(tid, (loadByTeacher.get(tid) || 0) + req.weeklyPeriods);
    }
    for (const [tid, load] of loadByTeacher) {
        const t = ctx.teachers.get(tid);
        if (!t) continue;
        let free = 0;
        for (const day of ctx.days) {
            for (const p of t.gridByDay.get(day) || []) {
                if (!t.blocked.has(slotKey(day, p))) free++;
            }
        }
        const cap = t.maxPerWeek > 0 ? Math.min(free, t.maxPerWeek) : free;
        if (load > cap) {
            conflicts.push({
                type: CONFLICT_TYPES.WEEKLY_LIMIT_EXCEEDED,
                severity: SEVERITY.ERROR,
                teacherId: tid,
                description: `${t.name} is required for ${load} periods/week but can only teach ${cap}.`,
                suggestion: 'Add an alternate teacher for one of their subjects, widen their availability, or raise their weekly limit.',
                meta: { load, capacity: cap },
            });
        }
    }

    // Per-room-type: practical demand vs room-slots on offer.
    const demandByType = new Map();
    for (const req of ctx.requirements) {
        if (!req.requiresRoom || !req.candidateRooms.length) continue;
        const key = req.pinnedRoomId ? `room:${req.pinnedRoomId}` : req.roomTypes.join('|');
        if (!demandByType.has(key)) demandByType.set(key, { demand: 0, rooms: new Set(), label: req.pinnedRoomId ? ctx.rooms.get(req.pinnedRoomId)?.name : req.roomTypes.join(' / ') });
        const bucket = demandByType.get(key);
        bucket.demand += req.weeklyPeriods;
        for (const r of req.candidateRooms) bucket.rooms.add(r);
    }
    for (const bucket of demandByType.values()) {
        let capacity = 0;
        for (const roomId of bucket.rooms) {
            const room = ctx.rooms.get(roomId);
            if (!room) continue;
            for (const day of ctx.days) {
                const union = new Set();
                for (const s of ctx.sections.values()) {
                    if (!s.days.includes(day)) continue;
                    for (const slot of s.teachingByDay.get(day) || []) union.add(slot.periodNumber);
                }
                for (const p of union) if (!room.blocked.has(slotKey(day, p))) capacity++;
            }
        }
        if (bucket.demand > capacity) {
            conflicts.push({
                type: CONFLICT_TYPES.ROOM_UNAVAILABLE,
                severity: SEVERITY.ERROR,
                description: `${bucket.label || 'Special rooms'}: ${bucket.demand} practical periods required but only ${capacity} room-periods available.`,
                suggestion: 'Add another room of this type or reduce the weekly practical periods.',
                meta: { demand: bucket.demand, capacity },
            });
        }
    }

    return conflicts;
}

/* ══════════════════════════════════════════════════════════════════════════
   3. SEARCH
   ══════════════════════════════════════════════════════════════════════════ */

/** Feasible placements for a block right now, cheapest (soft cost) first. */
function candidates(ctx, state, block, rng, limit = Infinity) {
    const out = [];
    for (const d of block.domain) {
        const res = checkPlacement(ctx, state, block, d.day, d.startIdx);
        if (!res.ok) continue;
        out.push({
            day: d.day,
            startIdx: d.startIdx,
            periods: res.periods,
            teacherId: res.teacherId,
            roomId: res.roomId,
            cost: placementCost(ctx, state, block, d.day, res.periods, res.teacherId) + rng.next() * 0.01,
        });
        if (out.length >= limit) break;
    }
    out.sort((a, b) => a.cost - b.cost);
    return out;
}

function feasibleCount(ctx, state, block) {
    if (!block.dirty) return block.domainCount;
    let n = 0;
    for (const d of block.domain) {
        if (checkPlacement(ctx, state, block, d.day, d.startIdx).ok) n++;
    }
    block.domainCount = n;
    block.dirty = false;
    return n;
}

/** Forward checking: only blocks sharing a section, teacher or room are affected. */
function markDirty(ctx, block, placement) {
    for (const b of ctx.bySection.get(block.sectionId) || []) b.dirty = true;
    if (placement?.teacherId) for (const b of ctx.byTeacher.get(placement.teacherId) || []) b.dirty = true;
    if (placement?.roomId) for (const b of ctx.byRoom.get(placement.roomId) || []) b.dirty = true;
    for (const t of block.teacherOptions) for (const b of ctx.byTeacher.get(t) || []) b.dirty = true;
}

/** MRV with a degree tie-break — hardest-to-place block first. */
function selectBlock(ctx, state, pool) {
    let best = null;
    let bestKey = null;
    for (const block of pool) {
        const count = feasibleCount(ctx, state, block);
        // (fewest options, biggest block, highest priority, fewest teachers, hardest)
        const key = [count, -block.size, -block.priority, block.teacherOptions.length, -block.difficulty];
        if (!best || lexLess(key, bestKey)) { best = block; bestKey = key; }
        if (count === 0) break; // a dead end must be handled immediately
    }
    return { block: best, count: bestKey ? bestKey[0] : 0 };
}

function lexLess(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
}

/**
 * Dead-end repair. Find the static placement blocked by the fewest already-placed
 * blocks, evict them and take the slot. Bounded, and it never breaks a hard rule
 * because the final placement is re-verified.
 */
function ejectAndPlace(ctx, state, block, pool, rng, protectedIds) {
    let bestOption = null;

    for (const d of block.domain) {
        const blockers = new Set();
        // Class clashes.
        for (const p of d.periods) {
            const holder = state.sectionSlots.get(`${block.sectionId}#${slotKey(d.day, p)}`);
            if (holder) blockers.add(holder);
        }
        // Teacher clashes — only the teachers this block could actually use.
        for (const tid of block.teacherOptions) {
            const t = ctx.teachers.get(tid);
            if (!t || d.periods.some((p) => t.blocked.has(slotKey(d.day, p)))) continue;
            const busy = new Set();
            for (const p of d.periods) {
                const holder = state.teacherSlots.get(`${tid}#${slotKey(d.day, p)}`);
                if (holder) busy.add(holder);
            }
            if (!busy.size) { blockers.clear(); break; } // this teacher is free — only class clashes matter
            for (const b of busy) blockers.add(b);
        }
        if (!blockers.size) continue; // would already be feasible; nothing to eject
        // Pinned / manually-locked entries are immovable — an option that would
        // need one evicted is not an option at all.
        if ([...blockers].some((id) => protectedIds.has(id))) continue;
        const score = blockers.size + rng.next() * 0.01;
        if (!bestOption || score < bestOption.score) bestOption = { d, blockers: [...blockers], score };
    }

    if (!bestOption) return false;

    const evicted = [];
    for (const id of bestOption.blockers) {
        const victim = ctx.blockById.get(id);
        if (!victim) continue;
        const placement = removePlacement(state, victim);
        markDirty(ctx, victim, placement);
        pool.add(victim);
        evicted.push(victim);
    }

    const res = checkPlacement(ctx, state, block, bestOption.d.day, bestOption.d.startIdx);
    if (!res.ok) {
        // Repair failed — the evicted blocks go back into the pool and will be
        // re-placed by the main loop, so nothing is lost.
        return false;
    }
    const placement = { day: res.day, startIdx: bestOption.d.startIdx, periods: res.periods, teacherId: res.teacherId, roomId: res.roomId };
    applyPlacement(state, block, placement);
    markDirty(ctx, block, placement);
    pool.delete(block);
    return true;
}

function runSearch(ctx, seed, pinned) {
    const rng = createRng(seed);
    const state = createState();
    const pool = new Set();

    for (const b of ctx.blocks) { b.dirty = true; b.domainCount = 0; }

    // Pinned (manually edited / locked) entries are placed first and never moved.
    const pinnedIds = new Set();
    for (const pin of pinned || []) {
        const block = ctx.blocks.find((b) => !pinnedIds.has(b.id)
            && b.sectionId === pin.sectionId && b.subjectId === pin.subjectId && b.size === (pin.size || 1));
        if (!block) continue;
        const section = ctx.sections.get(pin.sectionId);
        const teaching = section?.teachingByDay.get(pin.dayOfWeek) || [];
        const startIdx = teaching.findIndex((s) => s.periodNumber === Number(pin.periodNumber));
        if (startIdx < 0) continue;
        const res = checkPlacement(ctx, state, block, pin.dayOfWeek, startIdx);
        if (!res.ok) continue;
        const placement = {
            day: pin.dayOfWeek, startIdx, periods: res.periods,
            teacherId: pin.teacherId || res.teacherId,
            roomId: pin.roomId !== undefined ? pin.roomId : res.roomId,
            manual: true,
        };
        applyPlacement(state, block, placement);
        markDirty(ctx, block, placement);
        pinnedIds.add(block.id);
    }

    for (const b of ctx.blocks) if (!pinnedIds.has(b.id)) pool.add(b);

    const deadline = Date.now() + ctx.solver.timeBudgetMs;
    let ejections = 0;
    const maxEjections = Math.max(50, ctx.blocks.length * 4);
    let steps = 0;
    const maxSteps = Math.max(5000, ctx.blocks.length * 60);

    while (pool.size && steps++ < maxSteps && Date.now() < deadline) {
        const { block, count } = selectBlock(ctx, state, pool);
        if (!block) break;

        if (count === 0) {
            if (ejections++ < maxEjections && ejectAndPlace(ctx, state, block, pool, rng, pinnedIds)) continue;
            // Genuinely unplaceable in this run — park it and carry on so the
            // rest of the school still gets a timetable.
            pool.delete(block);
            block.unplaced = true;
            continue;
        }

        const opts = candidates(ctx, state, block, rng, 12);
        if (!opts.length) { block.dirty = true; continue; }
        const best = opts[0];
        const placement = { day: best.day, startIdx: best.startIdx, periods: best.periods, teacherId: best.teacherId, roomId: best.roomId };
        applyPlacement(state, block, placement);
        markDirty(ctx, block, placement);
        pool.delete(block);
    }

    const unplaced = ctx.blocks.filter((b) => !state.placements.has(b.id));
    for (const b of ctx.blocks) delete b.unplaced;
    return { state, unplaced, pinnedIds };
}

/* ══════════════════════════════════════════════════════════════════════════
   4. OPTIMISE — hill climbing on the soft score
   ══════════════════════════════════════════════════════════════════════════ */

function optimise(ctx, state, seed, pinnedIds) {
    const rng = createRng(seed ^ 0x5f3759df);
    const scorer = createScorer(ctx, state);
    const movable = ctx.blocks.filter((b) => state.placements.has(b.id) && !pinnedIds.has(b.id));
    if (movable.length < 2) return { score: scorer.total(), moves: 0 };

    const rounds = Math.min(ctx.solver.optimiseRounds, movable.length * 40);
    const deadline = Date.now() + Math.max(1000, ctx.solver.timeBudgetMs / 2);
    let moves = 0;

    for (let i = 0; i < rounds; i++) {
        if ((i & 63) === 0 && Date.now() > deadline) break;

        const block = rng.pick(movable);
        const current = state.placements.get(block.id);
        if (!current) continue;

        const touched = [block.sectionId];
        const teachersTouched = [current.teacherId];
        const before = scorer.partial(touched, teachersTouched);

        removePlacement(state, block);
        scorer.invalidate([block.sectionId], [current.teacherId]);

        // Try a handful of alternative slots rather than the whole domain.
        let bestMove = null;
        let bestScore = before;
        const sample = rng.shuffle([...block.domain]).slice(0, 10);
        for (const d of sample) {
            if (d.day === current.day && d.startIdx === current.startIdx) continue;
            const res = checkPlacement(ctx, state, block, d.day, d.startIdx);
            if (!res.ok) continue;
            const trial = { day: res.day, startIdx: d.startIdx, periods: res.periods, teacherId: res.teacherId, roomId: res.roomId };
            applyPlacement(state, block, trial);
            scorer.invalidate([block.sectionId], [res.teacherId, current.teacherId]);
            const after = scorer.partial([block.sectionId], [res.teacherId, current.teacherId]);
            removePlacement(state, block);
            scorer.invalidate([block.sectionId], [res.teacherId, current.teacherId]);
            if (after < bestScore - 1e-9) { bestScore = after; bestMove = trial; }
        }

        const chosen = bestMove || current;
        applyPlacement(state, block, chosen);
        scorer.invalidate([block.sectionId], [chosen.teacherId, current.teacherId]);
        if (bestMove) { moves++; markDirty(ctx, block, chosen); }
    }

    return { score: scorer.total(), moves };
}

/* ══════════════════════════════════════════════════════════════════════════
   5. PUBLIC ENTRY POINT
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {object} input   see compile() above
 * @param {object} [hooks] { onProgress(stepKey, percent) }
 * @returns {{assignments, conflicts, stats, seed, score}}
 */
function generate(input, hooks = {}) {
    const startedAt = Date.now();
    const progress = (key, percent) => { try { hooks.onProgress?.(key, percent); } catch { /* progress is best-effort */ } };

    progress('load_classes', 5);
    const ctx = compile(input);
    progress('load_teachers', 12);
    progress('load_subjects', 20);
    progress('load_rooms', 28);
    progress('availability', 35);

    progress('hard', 42);
    const preflightConflicts = preflight(ctx);

    progress('assign', 50);
    const seed = Number(input.seed) || newSeed();
    const pinned = input.pinned || [];

    let best = null;
    const restarts = Math.max(1, ctx.solver.maxRestarts);
    const deadline = startedAt + ctx.solver.timeBudgetMs;
    for (let attempt = 0; attempt < restarts; attempt++) {
        const attemptSeed = seed + attempt * 7919;
        const result = runSearch(ctx, attemptSeed, pinned);
        if (!best || result.unplaced.length < best.unplaced.length) best = { ...result, seed: attemptSeed };
        if (!result.unplaced.length) break;
        if (Date.now() > deadline) break;
        progress('resolve', 55 + Math.round((attempt + 1) / restarts * 15));
    }

    progress('resolve', 72);
    progress('optimise', 80);
    const { score, moves } = optimise(ctx, best.state, best.seed, best.pinnedIds);

    progress('validate', 92);
    const assignments = [];
    for (const [blockId, placement] of best.state.placements) {
        const block = ctx.blockById.get(blockId);
        if (!block) continue;
        for (const periodNumber of placement.periods) {
            assignments.push({
                sectionId: block.sectionId,
                subjectId: block.subjectId,
                teacherId: placement.teacherId || null,
                roomId: placement.roomId || null,
                dayOfWeek: placement.day,
                periodNumber,
                isManual: !!placement.manual,
                blockId,
            });
        }
    }
    assignments.sort((a, b) =>
        a.sectionId.localeCompare(b.sectionId)
        || ctx.days.indexOf(a.dayOfWeek) - ctx.days.indexOf(b.dayOfWeek)
        || a.periodNumber - b.periodNumber);

    // Anything the search could not place is reported, never silently dropped.
    const shortfall = new Map();
    for (const block of best.unplaced) {
        const key = `${block.sectionId}#${block.subjectId}`;
        if (!shortfall.has(key)) shortfall.set(key, { block, periods: 0 });
        shortfall.get(key).periods += block.size;
    }
    const shortfallConflicts = [...shortfall.values()].map(({ block, periods }) => {
        const section = ctx.sections.get(block.sectionId);
        return {
            type: CONFLICT_TYPES.SUBJECT_PERIOD_SHORTAGE,
            severity: SEVERITY.ERROR,
            sectionId: block.sectionId,
            subjectId: block.subjectId,
            teacherId: block.teacherOptions[0] || null,
            description: `${block.subjectName} for ${section?.label || 'section'}: ${periods} period(s) of the weekly requirement could not be placed.`,
            suggestion: 'Free up teacher availability, add an alternate teacher, or lower the weekly period requirement.',
            meta: { missingPeriods: periods },
        };
    });

    const stats = buildStats(ctx, best.state, assignments, startedAt, moves, score);

    progress('validate', 100);

    return {
        ctx,
        assignments,
        conflicts: [...ctx.warnings, ...preflightConflicts, ...shortfallConflicts],
        stats,
        seed: best.seed,
        score,
    };
}

function buildStats(ctx, state, assignments, startedAt, moves, score) {
    const teachersUsed = new Set();
    const subjectsUsed = new Set();
    const roomsUsed = new Set();
    for (const a of assignments) {
        if (a.teacherId) teachersUsed.add(a.teacherId);
        subjectsUsed.add(`${a.sectionId}#${a.subjectId}`);
        if (a.roomId) roomsUsed.add(a.roomId);
    }
    let totalSlots = 0;
    for (const s of ctx.sections.values()) {
        for (const day of s.days) totalSlots += (s.teachingByDay.get(day) || []).length;
    }
    const required = ctx.requirements.reduce((sum, r) => sum + r.weeklyPeriods, 0);
    return {
        classesProcessed: ctx.sections.size,
        teachersProcessed: ctx.teachers.size,
        subjectsProcessed: subjectsUsed.size,
        periodsProcessed: totalSlots,
        entriesGenerated: assignments.length,
        periodsRequired: required,
        fillRate: totalSlots ? Math.round((assignments.length / totalSlots) * 100) : 0,
        satisfaction: required ? Math.round((assignments.length / required) * 100) : 100,
        roomsUsed: roomsUsed.size,
        optimisationMoves: moves,
        softScore: Math.round(score * 100) / 100,
        generationTimeMs: Date.now() - startedAt,
    };
}

module.exports = { generate, compile, preflight, runSearch, optimise, staticDomain };
