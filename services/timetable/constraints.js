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

/**
 * Every (subject, teacher, room) triple a placement books.
 *
 * A plain block books one. A MERGED block books one per subject in the group —
 * they share the section's slot but each needs its own free teacher and room,
 * which is exactly what makes the group a single scheduling unit.
 */
function occupantsOf(block, placement) {
    const out = [{ subjectId: block.subjectId, teacherId: placement.teacherId || null, roomId: placement.roomId || null }];
    for (const m of placement.parallel || []) {
        out.push({ subjectId: m.subjectId, teacherId: m.teacherId || null, roomId: m.roomId || null });
    }
    return out;
}

/**
 * The sections a block occupies. Normally one; a cross-section merge books the
 * same slot in every member section, since one lesson is being taught to all of
 * them at once.
 */
const sectionsOf = (block) => (block.sectionIds && block.sectionIds.length
    ? block.sectionIds : [block.sectionId]);

function applyPlacement(state, block, placement) {
    const { day, periods } = placement;
    const occupants = occupantsOf(block, placement);
    const inSections = sectionsOf(block);
    for (const p of periods) {
        // One section slot for the whole unit — merged partners share it.
        for (const secId of inSections) state.sectionSlots.set(`${secId}#${slotKey(day, p)}`, block.id);
        for (const o of occupants) {
            if (o.teacherId) state.teacherSlots.set(`${o.teacherId}#${slotKey(day, p)}`, block.id);
            if (o.roomId)    state.roomSlots.set(`${o.roomId}#${slotKey(day, p)}`, block.id);
        }
    }
    for (const o of occupants) {
        if (o.teacherId) {
            bump(state.teacherDay, `${o.teacherId}#${day}`, periods.length);
            bump(state.teacherWeek, o.teacherId, periods.length);
        }
        for (const secId of inSections) bump(state.subjectDay, `${secId}#${o.subjectId}#${day}`, periods.length);
    }
    // The section only loses `periods.length` slots however many subjects share them.
    for (const secId of inSections) bump(state.sectionDay, `${secId}#${day}`, periods.length);
    state.placements.set(block.id, placement);
}

function removePlacement(state, block) {
    const placement = state.placements.get(block.id);
    if (!placement) return null;
    const { day, periods } = placement;
    const occupants = occupantsOf(block, placement);
    const inSections = sectionsOf(block);
    for (const p of periods) {
        for (const secId of inSections) state.sectionSlots.delete(`${secId}#${slotKey(day, p)}`);
        for (const o of occupants) {
            if (o.teacherId) state.teacherSlots.delete(`${o.teacherId}#${slotKey(day, p)}`);
            if (o.roomId)    state.roomSlots.delete(`${o.roomId}#${slotKey(day, p)}`);
        }
    }
    for (const o of occupants) {
        if (o.teacherId) {
            bump(state.teacherDay, `${o.teacherId}#${day}`, -periods.length);
            bump(state.teacherWeek, o.teacherId, -periods.length);
        }
        for (const secId of inSections) bump(state.subjectDay, `${secId}#${o.subjectId}#${day}`, -periods.length);
    }
    for (const secId of inSections) bump(state.sectionDay, `${secId}#${day}`, -periods.length);
    state.placements.delete(block.id);
    return placement;
}

/* ══════════════════════════════════════════════════════════════════════════
   HARD CONSTRAINTS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * HARD #7/#8: pick a room for one subject demand, or explain why none fits.
 * Order of preference: pinned room → compatible special room → section home room.
 *
 * `demand` is the block itself for a plain subject, or one merged partner —
 * partners are resolved one after another, so `taken` carries the rooms the
 * earlier partners of the SAME placement already claimed.
 *
 * Returns { ok, roomId, code, reason }.
 */
function resolveRoom(ctx, state, sectionId, demand, day, periods, ignoreBlockId = null, taken = null) {
    const free = (roomId) => !(taken && taken.has(roomId)) && periods.every((p) => {
        const holder = state.roomSlots.get(`${roomId}#${slotKey(day, p)}`);
        return holder === undefined || holder === ignoreBlockId;
    });
    const notBlocked = (room) => periods.every((p) => !room.blocked.has(slotKey(day, p)));

    // 1. Admin pinned one specific room — it is that room or nothing.
    if (demand.pinnedRoomId) {
        const room = ctx.rooms.get(demand.pinnedRoomId);
        if (!room) return { ok: false, code: CONFLICT_TYPES.PRACTICAL_ROOM_MISSING, reason: 'Pinned room no longer exists' };
        if (!notBlocked(room)) return { ok: false, code: CONFLICT_TYPES.ROOM_UNAVAILABLE, reason: `${room.name} is unavailable at this time` };
        if (!free(room.id))    return { ok: false, code: CONFLICT_TYPES.ROOM_CLASH, reason: `${room.name} is already booked at this time` };
        // Seat counts are not a constraint: a room is judged on its type and on
        // being free. A merged lesson is one class in one room regardless of how
        // many sections are sitting in it.
        return { ok: true, roomId: room.id };
    }

    // 2. A special room is required (lab / activity / sports …).
    if (demand.requiresRoom) {
        if (!demand.candidateRooms.length) {
            return {
                ok: false,
                code: CONFLICT_TYPES.PRACTICAL_ROOM_MISSING,
                reason: `No room of type ${demand.roomTypes.join(' / ') || 'required'} exists`,
            };
        }
        for (const roomId of demand.candidateRooms) {
            const room = ctx.rooms.get(roomId);
            if (room && notBlocked(room) && free(roomId)) return { ok: true, roomId };
        }
        return { ok: false, code: CONFLICT_TYPES.ROOM_CLASH, reason: 'All compatible rooms are booked at this time' };
    }

    // 3. Plain theory — use the section's home classroom when it is free. A
    //    merged partner finds it already taken and is simply scheduled without
    //    a room, which is correct: the class is in one place either way.
    const home = ctx.sections.get(sectionId)?.homeRoomId;
    if (home) {
        const room = ctx.rooms.get(home);
        if (room && notBlocked(room) && free(home)) return { ok: true, roomId: home };
    }
    // No room tracked ⇒ no room clash possible.
    return { ok: true, roomId: null };
}

/**
 * How many periods of `teacherId`'s load on `day` come from the block we are
 * allowed to ignore (the one being moved). Merge-aware: the ignored block may
 * hold this teacher as a merged partner rather than as its primary.
 */
function selfLoad(state, ignoreBlockId, teacherId, day) {
    if (!ignoreBlockId) return { day: 0, week: 0 };
    const pl = state.placements.get(ignoreBlockId);
    if (!pl) return { day: 0, week: 0 };
    const holds = pl.teacherId === teacherId || (pl.parallel || []).some((m) => m.teacherId === teacherId);
    if (!holds) return { day: 0, week: 0 };
    return { day: pl.day === day ? pl.periods.length : 0, week: pl.periods.length };
}

/**
 * HARD #2/#4/#9/#10: the first teacher of `demand` who is qualified, available,
 * free and under their ceilings. `taken` holds the teachers already claimed by
 * earlier merged partners of the same placement — nobody teaches two subjects
 * at once, merged or not.
 *
 * Returns { ok, teacherId, code, reason }.
 */
function resolveTeacher(ctx, state, demand, day, periods, size, ignore = null, taken = null) {
    let reason = null;
    let code = CONFLICT_TYPES.TEACHER_CLASH;

    for (const teacherId of demand.teacherOptions) {
        const t = ctx.teachers.get(teacherId);
        if (!t) continue;
        if (taken && taken.has(teacherId)) {
            reason = `${t.name} is already teaching another subject of this merged period`;
            code = CONFLICT_TYPES.TEACHER_CLASH;
            continue;
        }

        // HARD #9: must be qualified for / assigned to this subject.
        if (ctx.enforceTeacherQualified && t.subjects.size && !t.subjects.has(demand.subjectId)) {
            reason = `${t.name} is not assigned to teach ${demand.subjectName}`;
            code = CONFLICT_TYPES.SUBJECT_TEACHER_MISMATCH;
            continue;
        }
        // HARD #4: declared unavailable.
        if (periods.some((p) => t.blocked.has(slotKey(day, p)))) {
            reason = `${t.name} is unavailable on ${day}`;
            code = CONFLICT_TYPES.TEACHER_UNAVAILABLE;
            continue;
        }
        // HARD #2: already teaching elsewhere.
        let busy = false;
        for (const p of periods) {
            const holder = state.teacherSlots.get(`${teacherId}#${slotKey(day, p)}`);
            if (holder !== undefined && holder !== ignore) { busy = true; break; }
        }
        if (busy) {
            reason = `${t.name} is already teaching another class at ${day} P${periods[0]}`;
            code = CONFLICT_TYPES.TEACHER_CLASH;
            continue;
        }
        // HARD #10: daily / weekly workload ceilings.
        const self = selfLoad(state, ignore, teacherId, day);
        if (t.hardDailyLimit && t.maxPerDay > 0 &&
            (state.teacherDay.get(`${teacherId}#${day}`) || 0) - self.day + size > t.maxPerDay) {
            reason = `${t.name} is at their ${t.maxPerDay}-period daily limit on ${day}`;
            code = CONFLICT_TYPES.DAILY_LIMIT_EXCEEDED;
            continue;
        }
        if (t.maxPerWeek > 0 &&
            (state.teacherWeek.get(teacherId) || 0) - self.week + size > t.maxPerWeek) {
            reason = `${t.name} is at their ${t.maxPerWeek}-period weekly limit`;
            code = CONFLICT_TYPES.WEEKLY_LIMIT_EXCEEDED;
            continue;
        }
        return { ok: true, teacherId };
    }

    if (!demand.teacherOptions.length) {
        return { ok: false, code: CONFLICT_TYPES.NO_TEACHER_ASSIGNED, reason: `No teacher is assigned to ${demand.subjectName}` };
    }
    return { ok: false, code, reason: reason || 'No teacher free at this time' };
}

/**
 * Can `block` sit at `day` starting at teaching-slot index `startIdx`?
 * Runs every hard constraint in cost order (cheapest rejections first) and
 * returns the teacher + room it would use.
 *
 * For a MERGED block every subject in the group is resolved here, against the
 * same periods: the placement is legal only when ALL of them find a teacher and
 * a room. That is what makes the group one indivisible scheduling unit.
 *
 * @returns {{ok:boolean, teacherId?:string, roomId?:string|null, parallel?:Array, code?:string, reason?:string}}
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

    // HARD #1: one subject per section per slot (a merged group counts as one).
    for (const p of periods) {
        for (const secId of sectionsOf(block)) {
            const holder = state.sectionSlots.get(`${secId}#${slotKey(day, p)}`);
            if (holder !== undefined && holder !== ignore) {
                const label = secId === block.sectionId
                    ? section.label
                    : (ctx.sections.get(secId)?.label || 'a merged section');
                return { ok: false, code: CONFLICT_TYPES.CLASS_CLASH, reason: `${label} already has a subject at ${day} P${p}` };
            }
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
            if (!other || other.subjectId !== block.subjectId) continue;
            // Overlapping section sets count as the same class for this rule.
            if (!sectionsOf(other).some((x) => sectionsOf(block).includes(x))) continue;
            const gap = Math.min(
                Math.abs(Math.min(...periods) - Math.max(...pl.periods)),
                Math.abs(Math.min(...pl.periods) - Math.max(...periods)),
            ) - 1;
            if (gap < block.minGapPeriods) {
                return { ok: false, code: CONFLICT_TYPES.CONSECUTIVE_PERIOD_ERROR, reason: `${block.subjectName} needs a gap of ${block.minGapPeriods} period(s)` };
            }
        }
    }

    // HARD #2/#4/#9/#10 then #3/#7/#8, for the primary subject and then for each
    // merged partner. Teachers and rooms already claimed by an earlier member of
    // this same placement are off the table for the next one.
    const takenTeachers = new Set();
    const takenRooms = new Set();

    const teacher = resolveTeacher(ctx, state, block, day, periods, block.size, ignore, takenTeachers);
    if (!teacher.ok) return { ok: false, code: teacher.code, reason: teacher.reason };
    takenTeachers.add(teacher.teacherId);

    const room = resolveRoom(ctx, state, block.sectionId, block, day, periods, ignore, takenRooms);
    if (!room.ok) return { ok: false, code: room.code, reason: room.reason };
    if (room.roomId) takenRooms.add(room.roomId);

    const parallel = [];
    for (const member of block.parallel || []) {
        const mTeacher = resolveTeacher(ctx, state, member, day, periods, block.size, ignore, takenTeachers);
        if (!mTeacher.ok) {
            return { ok: false, code: mTeacher.code, reason: `${member.subjectName} (merged with ${block.subjectName}): ${mTeacher.reason}` };
        }
        takenTeachers.add(mTeacher.teacherId);

        const mRoom = resolveRoom(ctx, state, block.sectionId, member, day, periods, ignore, takenRooms);
        if (!mRoom.ok) {
            return { ok: false, code: mRoom.code, reason: `${member.subjectName} (merged with ${block.subjectName}): ${mRoom.reason}` };
        }
        if (mRoom.roomId) takenRooms.add(mRoom.roomId);

        parallel.push({
            subjectId: member.subjectId,
            subjectName: member.subjectName,
            teacherId: mTeacher.teacherId,
            roomId: mRoom.roomId,
        });
    }

    return { ok: true, teacherId: teacher.teacherId, roomId: room.roomId, parallel, periods, day };
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
