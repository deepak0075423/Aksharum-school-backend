'use strict';
// Hard-constraint checking and soft-constraint scoring.
//
// HARD constraints gate whether a placement is legal at all — the solver never
// produces a schedule that breaks one. SOFT constraints are weighted penalties
// the optimiser tries to drive down after a legal schedule exists.
//
// Everything here works on plain objects (see engine.js `compile()`), so the
// whole rule set is unit-testable without a database.

const { CONFLICT_TYPES, slotKey } = require('./types');

/* ══════════════════════════════════════════════════════════════════════════
   Occupancy state
   ══════════════════════════════════════════════════════════════════════════ */

function createState() {
    return {
        sectionSlots: new Map(),   // section#day#period -> blockId
        teacherSlots: new Map(),   // teacher#day#period -> blockId
        roomSlots:    new Map(),   // room#day#period    -> blockId
        teacherDay:   new Map(),   // teacher#day        -> count
        teacherWeek:  new Map(),   // teacher            -> count
        subjectDay:   new Map(),   // section#subject#day-> count
        sectionDay:   new Map(),   // section#day        -> count
        placements:   new Map(),   // blockId -> { day, startIdx, periods, teacherId, roomId }
    };
}

const bump = (map, key, by) => map.set(key, (map.get(key) || 0) + by);

function applyPlacement(state, block, placement) {
    const { day, periods, teacherId, roomId } = placement;
    for (const p of periods) {
        state.sectionSlots.set(`${block.sectionId}#${slotKey(day, p)}`, block.id);
        if (teacherId) state.teacherSlots.set(`${teacherId}#${slotKey(day, p)}`, block.id);
        if (roomId)    state.roomSlots.set(`${roomId}#${slotKey(day, p)}`, block.id);
    }
    if (teacherId) {
        bump(state.teacherDay, `${teacherId}#${day}`, periods.length);
        bump(state.teacherWeek, teacherId, periods.length);
    }
    bump(state.subjectDay, `${block.sectionId}#${block.subjectId}#${day}`, periods.length);
    bump(state.sectionDay, `${block.sectionId}#${day}`, periods.length);
    state.placements.set(block.id, placement);
}

function removePlacement(state, block) {
    const placement = state.placements.get(block.id);
    if (!placement) return null;
    const { day, periods, teacherId, roomId } = placement;
    for (const p of periods) {
        state.sectionSlots.delete(`${block.sectionId}#${slotKey(day, p)}`);
        if (teacherId) state.teacherSlots.delete(`${teacherId}#${slotKey(day, p)}`);
        if (roomId)    state.roomSlots.delete(`${roomId}#${slotKey(day, p)}`);
    }
    if (teacherId) {
        bump(state.teacherDay, `${teacherId}#${day}`, -periods.length);
        bump(state.teacherWeek, teacherId, -periods.length);
    }
    bump(state.subjectDay, `${block.sectionId}#${block.subjectId}#${day}`, -periods.length);
    bump(state.sectionDay, `${block.sectionId}#${day}`, -periods.length);
    state.placements.delete(block.id);
    return placement;
}

/* ══════════════════════════════════════════════════════════════════════════
   HARD CONSTRAINTS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * HARD #7/#8: pick a room for this block, or explain why none fits.
 * Order of preference: pinned room → compatible special room → section home room.
 * Returns { ok, roomId, code, reason }.
 */
function resolveRoom(ctx, state, block, day, periods, ignoreBlockId = null) {
    const free = (roomId) => periods.every((p) => {
        const holder = state.roomSlots.get(`${roomId}#${slotKey(day, p)}`);
        return holder === undefined || holder === ignoreBlockId;
    });
    const notBlocked = (room) => periods.every((p) => !room.blocked.has(slotKey(day, p)));

    // 1. Admin pinned one specific room — it is that room or nothing.
    if (block.pinnedRoomId) {
        const room = ctx.rooms.get(block.pinnedRoomId);
        if (!room) return { ok: false, code: CONFLICT_TYPES.PRACTICAL_ROOM_MISSING, reason: 'Pinned room no longer exists' };
        if (!notBlocked(room)) return { ok: false, code: CONFLICT_TYPES.ROOM_UNAVAILABLE, reason: `${room.name} is unavailable at this time` };
        if (!free(room.id))    return { ok: false, code: CONFLICT_TYPES.ROOM_CLASH, reason: `${room.name} is already booked at this time` };
        if (ctx.enforceRoomCapacity && room.capacity > 0 && room.capacity < block.strength) {
            return { ok: false, code: CONFLICT_TYPES.ROOM_CAPACITY, reason: `${room.name} seats ${room.capacity}, section needs ${block.strength}` };
        }
        return { ok: true, roomId: room.id };
    }

    // 2. A special room is required (lab / activity / sports …).
    if (block.requiresRoom) {
        if (!block.candidateRooms.length) {
            return {
                ok: false,
                code: CONFLICT_TYPES.PRACTICAL_ROOM_MISSING,
                reason: `No room of type ${block.roomTypes.join(' / ') || 'required'} exists with enough capacity`,
            };
        }
        for (const roomId of block.candidateRooms) {
            const room = ctx.rooms.get(roomId);
            if (room && notBlocked(room) && free(roomId)) return { ok: true, roomId };
        }
        return { ok: false, code: CONFLICT_TYPES.ROOM_CLASH, reason: 'All compatible rooms are booked at this time' };
    }

    // 3. Plain theory — use the section's home classroom when it is free.
    const home = ctx.sections.get(block.sectionId)?.homeRoomId;
    if (home) {
        const room = ctx.rooms.get(home);
        if (room && notBlocked(room) && free(home)) return { ok: true, roomId: home };
    }
    // No room tracked ⇒ no room clash possible.
    return { ok: true, roomId: null };
}

/**
 * Can `block` sit at `day` starting at teaching-slot index `startIdx`?
 * Runs every hard constraint in cost order (cheapest rejections first) and
 * returns the teacher + room it would use.
 *
 * @returns {{ok:boolean, teacherId?:string, roomId?:string|null, code?:string, reason?:string}}
 */
function checkPlacement(ctx, state, block, day, startIdx, opts = {}) {
    const ignore = opts.ignoreBlockId || null;
    const section = ctx.sections.get(block.sectionId);
    const teaching = section.teachingByDay.get(day);
    if (!teaching) return { ok: false, code: CONFLICT_TYPES.NON_TEACHING_SLOT, reason: `${section.label} does not work on ${day}` };

    // HARD #12: consecutive periods must be genuinely adjacent teaching slots.
    if (startIdx + block.size > teaching.length) {
        return { ok: false, code: CONFLICT_TYPES.CONSECUTIVE_PERIOD_ERROR, reason: 'Not enough consecutive teaching periods left in the day' };
    }
    const periods = [];
    for (let i = 0; i < block.size; i++) {
        const cur = teaching[startIdx + i];
        // A break/lunch between two teaching slots splits the block.
        if (i > 0 && cur.adjacentToPrev === false) {
            return { ok: false, code: CONFLICT_TYPES.CONSECUTIVE_PERIOD_ERROR, reason: 'A break falls between these periods' };
        }
        periods.push(cur.periodNumber);
    }

    // HARD #1: one subject per section per slot.
    for (const p of periods) {
        const holder = state.sectionSlots.get(`${block.sectionId}#${slotKey(day, p)}`);
        if (holder !== undefined && holder !== ignore) {
            return { ok: false, code: CONFLICT_TYPES.CLASS_CLASH, reason: `${section.label} already has a subject at ${day} P${p}` };
        }
    }

    // HARD #11: subject periods per day (when configured hard).
    if (block.hardMaxPerDay) {
        const already = state.subjectDay.get(`${block.sectionId}#${block.subjectId}#${day}`) || 0;
        const self = ignore && state.placements.get(ignore)?.day === day ? state.placements.get(ignore).periods.length : 0;
        if (already - self + block.size > block.maxPerDay) {
            return { ok: false, code: CONFLICT_TYPES.DAILY_LIMIT_EXCEEDED, reason: `${block.subjectName} may run at most ${block.maxPerDay} period(s) per day` };
        }
    }

    // Minimum gap between two blocks of the same subject on the same day.
    if (block.minGapPeriods > 0) {
        for (const [otherId, pl] of state.placements) {
            if (otherId === ignore || pl.day !== day) continue;
            const other = ctx.blockById.get(otherId);
            if (!other || other.sectionId !== block.sectionId || other.subjectId !== block.subjectId) continue;
            const gap = Math.min(
                Math.abs(Math.min(...periods) - Math.max(...pl.periods)),
                Math.abs(Math.min(...pl.periods) - Math.max(...periods)),
            ) - 1;
            if (gap < block.minGapPeriods) {
                return { ok: false, code: CONFLICT_TYPES.CONSECUTIVE_PERIOD_ERROR, reason: `${block.subjectName} needs a gap of ${block.minGapPeriods} period(s)` };
            }
        }
    }

    // HARD #2/#4/#9/#10: teacher clash, availability, qualification, workload.
    let chosenTeacher = null;
    let teacherReason = null;
    let teacherCode = CONFLICT_TYPES.TEACHER_CLASH;
    for (const teacherId of block.teacherOptions) {
        const t = ctx.teachers.get(teacherId);
        if (!t) continue;

        // HARD #9: must be qualified for / assigned to this subject.
        if (ctx.enforceTeacherQualified && t.subjects.size && !t.subjects.has(block.subjectId)) {
            teacherReason = `${t.name} is not assigned to teach ${block.subjectName}`;
            teacherCode = CONFLICT_TYPES.SUBJECT_TEACHER_MISMATCH;
            continue;
        }
        // HARD #4: declared unavailable.
        if (periods.some((p) => t.blocked.has(slotKey(day, p)))) {
            teacherReason = `${t.name} is unavailable on ${day}`;
            teacherCode = CONFLICT_TYPES.TEACHER_UNAVAILABLE;
            continue;
        }
        // HARD #2: already teaching elsewhere.
        let busy = false;
        for (const p of periods) {
            const holder = state.teacherSlots.get(`${teacherId}#${slotKey(day, p)}`);
            if (holder !== undefined && holder !== ignore) { busy = true; break; }
        }
        if (busy) {
            teacherReason = `${t.name} is already teaching another class at ${day} P${periods[0]}`;
            teacherCode = CONFLICT_TYPES.TEACHER_CLASH;
            continue;
        }
        // HARD #10: daily / weekly workload ceilings.
        const selfDay = ignore && state.placements.get(ignore)?.teacherId === teacherId && state.placements.get(ignore)?.day === day
            ? state.placements.get(ignore).periods.length : 0;
        const selfWeek = ignore && state.placements.get(ignore)?.teacherId === teacherId
            ? state.placements.get(ignore).periods.length : 0;
        if (t.hardDailyLimit && t.maxPerDay > 0 &&
            (state.teacherDay.get(`${teacherId}#${day}`) || 0) - selfDay + block.size > t.maxPerDay) {
            teacherReason = `${t.name} is at their ${t.maxPerDay}-period daily limit on ${day}`;
            teacherCode = CONFLICT_TYPES.DAILY_LIMIT_EXCEEDED;
            continue;
        }
        if (t.maxPerWeek > 0 &&
            (state.teacherWeek.get(teacherId) || 0) - selfWeek + block.size > t.maxPerWeek) {
            teacherReason = `${t.name} is at their ${t.maxPerWeek}-period weekly limit`;
            teacherCode = CONFLICT_TYPES.WEEKLY_LIMIT_EXCEEDED;
            continue;
        }
        chosenTeacher = teacherId;
        break;
    }

    if (!chosenTeacher) {
        if (!block.teacherOptions.length) {
            return { ok: false, code: CONFLICT_TYPES.NO_TEACHER_ASSIGNED, reason: `No teacher is assigned to ${block.subjectName} for ${section.label}` };
        }
        return { ok: false, code: teacherCode, reason: teacherReason || 'No teacher free at this time' };
    }

    // HARD #3/#7/#8: rooms.
    const room = resolveRoom(ctx, state, block, day, periods, ignore);
    if (!room.ok) return { ok: false, code: room.code, reason: room.reason };

    return { ok: true, teacherId: chosenTeacher, roomId: room.roomId, periods, day };
}

/* ══════════════════════════════════════════════════════════════════════════
   SOFT CONSTRAINTS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Cheap local estimate used to ORDER candidate placements during search
 * (least-constraining-value). Not the authoritative score — that is scoreAll().
 */
function placementCost(ctx, state, block, day, periods, teacherId) {
    const w = ctx.weights;
    let cost = 0;
    const section = ctx.sections.get(block.sectionId);

    // Same subject already on this day.
    const sameDay = state.subjectDay.get(`${block.sectionId}#${block.subjectId}#${day}`) || 0;
    if (sameDay > 0) cost += w.sameSubjectTwiceADay * sameDay;

    // Keep each day's load even across the week.
    cost += w.spreadAcrossWeek * (state.sectionDay.get(`${block.sectionId}#${day}`) || 0) * 0.25;

    const teaching = section.teachingByDay.get(day) || [];
    const lastPeriod = teaching.length ? teaching[teaching.length - 1].periodNumber : null;

    if (block.difficulty >= 4) {
        if (periods.includes(lastPeriod)) cost += w.difficultLastPeriod;
        // Hard subject stacked next to another hard subject.
        for (const p of [periods[0] - 1, periods[periods.length - 1] + 1]) {
            const neighbour = state.sectionSlots.get(`${block.sectionId}#${slotKey(day, p)}`);
            const nb = neighbour && ctx.blockById.get(neighbour);
            if (nb && nb.difficulty >= 4) cost += w.difficultConsecutive;
        }
    }

    // Same subject butting up against itself across two blocks.
    for (const p of [periods[0] - 1, periods[periods.length - 1] + 1]) {
        const neighbour = state.sectionSlots.get(`${block.sectionId}#${slotKey(day, p)}`);
        const nb = neighbour && ctx.blockById.get(neighbour);
        if (nb && nb.subjectId === block.subjectId) cost += w.sameSubjectAdjacent;
    }

    // Subject's own day/period preferences.
    if (block.preferredDays.size && !block.preferredDays.has(day)) cost += w.subjectPreferred;
    if (block.preferredPeriods.size && !periods.some((p) => block.preferredPeriods.has(p))) cost += w.subjectPreferred;

    const t = teacherId && ctx.teachers.get(teacherId);
    if (t) {
        if (t.preferredDays.size && !t.preferredDays.has(day)) cost += w.teacherPreferred;
        if (t.preferredPeriods.size && !periods.some((p) => t.preferredPeriods.has(p))) cost += w.teacherPreferred;
        // Level teacher load across days.
        cost += w.teacherLoadBalance * (state.teacherDay.get(`${teacherId}#${day}`) || 0) * 0.3;
        // Prefer slots adjacent to what the teacher already has (fewer gaps).
        const before = state.teacherSlots.has(`${teacherId}#${slotKey(day, periods[0] - 1)}`);
        const after  = state.teacherSlots.has(`${teacherId}#${slotKey(day, periods[periods.length - 1] + 1)}`);
        const hasDay = (state.teacherDay.get(`${teacherId}#${day}`) || 0) > 0;
        if (hasDay && !before && !after) cost += w.teacherGaps;
    }

    return cost;
}

/** Soft penalty contributed by one section's week. */
function scoreSection(ctx, state, sectionId) {
    const w = ctx.weights;
    const section = ctx.sections.get(sectionId);
    if (!section) return 0;
    let score = 0;

    const perDayCount = [];
    const subjectDayCounts = new Map(); // subjectId -> [countPerDay]

    section.days.forEach((day, dayIdx) => {
        const teaching = section.teachingByDay.get(day) || [];
        let filled = 0;
        let firstFilled = -1;
        let lastFilled = -1;

        teaching.forEach((slot, i) => {
            const blockId = state.sectionSlots.get(`${sectionId}#${slotKey(day, slot.periodNumber)}`);
            if (!blockId) return;
            filled++;
            if (firstFilled < 0) firstFilled = i;
            lastFilled = i;

            const block = ctx.blockById.get(blockId);
            if (!block) return;

            if (!subjectDayCounts.has(block.subjectId)) {
                subjectDayCounts.set(block.subjectId, new Array(section.days.length).fill(0));
            }
            subjectDayCounts.get(block.subjectId)[dayIdx]++;

            // Hard subject in the final period of the day.
            if (block.difficulty >= 4 && i === teaching.length - 1) score += w.difficultLastPeriod;

            // Two hard subjects back to back.
            if (i > 0 && block.difficulty >= 4) {
                const prevId = state.sectionSlots.get(`${sectionId}#${slotKey(day, teaching[i - 1].periodNumber)}`);
                const prev = prevId && ctx.blockById.get(prevId);
                if (prev && prev.difficulty >= 4 && prev.subjectId !== block.subjectId) score += w.difficultConsecutive;
            }

            // Same subject in adjacent periods across separate blocks.
            if (i > 0) {
                const prevId = state.sectionSlots.get(`${sectionId}#${slotKey(day, teaching[i - 1].periodNumber)}`);
                if (prevId && prevId !== blockId) {
                    const prev = ctx.blockById.get(prevId);
                    if (prev && prev.subjectId === block.subjectId) score += w.sameSubjectAdjacent;
                }
            }

            // Subject's declared preferences.
            if (block.preferredDays.size && !block.preferredDays.has(day)) score += w.subjectPreferred;
            if (block.preferredPeriods.size && !block.preferredPeriods.has(slot.periodNumber)) score += w.subjectPreferred;
        });

        perDayCount.push(filled);

        // Free slots sandwiched between taught periods (students idling).
        if (firstFilled >= 0) {
            let holes = 0;
            for (let i = firstFilled; i <= lastFilled; i++) {
                if (!state.sectionSlots.has(`${sectionId}#${slotKey(day, teaching[i].periodNumber)}`)) holes++;
            }
            score += w.studentGaps * holes;
        }
    });

    // Same subject more than once a day, and clustering into few days.
    for (const counts of subjectDayCounts.values()) {
        let daysUsed = 0;
        for (const c of counts) {
            if (c > 0) daysUsed++;
            if (c > 1) score += w.sameSubjectTwiceADay * (c - 1);
        }
        const total = counts.reduce((a, b) => a + b, 0);
        // Ideally a subject touches min(total, workingDays) distinct days.
        const ideal = Math.min(total, counts.length);
        if (daysUsed < ideal) score += w.spreadAcrossWeek * (ideal - daysUsed);
    }

    // One day carrying far more periods than the others.
    if (perDayCount.length > 1) {
        const mean = perDayCount.reduce((a, b) => a + b, 0) / perDayCount.length;
        const variance = perDayCount.reduce((a, b) => a + (b - mean) ** 2, 0) / perDayCount.length;
        score += w.dailyOverload * Math.sqrt(variance);
    }

    return score;
}

/** Soft penalty contributed by one teacher's week. */
function scoreTeacher(ctx, state, teacherId) {
    const w = ctx.weights;
    const t = ctx.teachers.get(teacherId);
    if (!t) return 0;
    let score = 0;

    const loads = [];
    for (const day of ctx.days) {
        const slots = t.gridByDay.get(day) || [];
        let first = -1;
        let last = -1;
        let count = 0;
        slots.forEach((periodNumber, i) => {
            if (!state.teacherSlots.has(`${teacherId}#${slotKey(day, periodNumber)}`)) return;
            count++;
            if (first < 0) first = i;
            last = i;
            if (t.preferredDays.size && !t.preferredDays.has(day)) score += w.teacherPreferred;
            if (t.preferredPeriods.size && !t.preferredPeriods.has(periodNumber)) score += w.teacherPreferred;
        });
        loads.push(count);
        // Idle periods wedged between the teacher's first and last class.
        if (first >= 0) {
            let holes = 0;
            for (let i = first; i <= last; i++) {
                if (!state.teacherSlots.has(`${teacherId}#${slotKey(day, slots[i])}`)) holes++;
            }
            score += w.teacherGaps * holes;
        }
        // Over the soft daily cap (only reachable when the cap is not hard).
        if (!t.hardDailyLimit && t.maxPerDay > 0 && count > t.maxPerDay) {
            score += w.dailyOverload * (count - t.maxPerDay) * 2;
        }
    }

    // Uneven spread of the week's load across days.
    if (loads.length > 1) {
        const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
        const variance = loads.reduce((a, b) => a + (b - mean) ** 2, 0) / loads.length;
        score += w.teacherLoadBalance * Math.sqrt(variance);
    }
    return score;
}

/**
 * Full soft score with per-section / per-teacher caching, so the optimiser can
 * re-score a candidate move by recomputing only the parts it touched.
 */
function createScorer(ctx, state) {
    const sectionCache = new Map();
    const teacherCache = new Map();

    const sectionScore = (id) => {
        if (!sectionCache.has(id)) sectionCache.set(id, scoreSection(ctx, state, id));
        return sectionCache.get(id);
    };
    const teacherScore = (id) => {
        if (!teacherCache.has(id)) teacherCache.set(id, scoreTeacher(ctx, state, id));
        return teacherCache.get(id);
    };

    return {
        invalidate(sectionIds = [], teacherIds = []) {
            for (const id of sectionIds) sectionCache.delete(id);
            for (const id of teacherIds) teacherCache.delete(id);
        },
        total() {
            let sum = 0;
            for (const id of ctx.sections.keys()) sum += sectionScore(id);
            for (const id of ctx.teachers.keys()) sum += teacherScore(id);
            return sum;
        },
        partial(sectionIds, teacherIds) {
            let sum = 0;
            for (const id of new Set(sectionIds)) sum += sectionScore(id);
            for (const id of new Set(teacherIds.filter(Boolean))) sum += teacherScore(id);
            return sum;
        },
    };
}

module.exports = {
    createState, applyPlacement, removePlacement,
    checkPlacement, resolveRoom, placementCost,
    scoreSection, scoreTeacher, createScorer,
};
