'use strict';
/**
 * Independent validation of a finished timetable.
 *
 * Deliberately does NOT reuse the solver's internal state: it rebuilds
 * everything from the entries as stored and re-derives every violation. That
 * way a timetable that was hand-edited, imported, or produced by an older
 * version of the engine is checked just as strictly as a fresh generation —
 * which is what "never publish an invalid timetable" requires.
 */

const { CONFLICT_TYPES, SEVERITY, isTeachingPeriod, periodTypeOf, slotKey } = require('./types');

const sid = (v) => (v == null ? null : String(v._id ?? v));

/**
 * @param {object} ctx      compiled context from engine.compile()
 * @param {Array}  entries  [{ sectionId, subjectId, teacherId, roomId, dayOfWeek, periodNumber }]
 * @returns {{conflicts: Array, stats: object}}
 */
function validate(ctx, entries) {
    const conflicts = [];
    const push = (c) => conflicts.push(c);

    const sectionSlot = new Map();   // section#day#period -> entry
    const slotSubjects = new Map();  // section#day#period -> Set(subjectId)
    const teacherSlot = new Map();
    const roomSlot = new Map();
    const teacherDay = new Map();
    const teacherWeek = new Map();
    const subjectDay = new Map();    // section#subject#day -> count
    const weeklyCount = new Map();   // section#subject -> count

    const label = (sectionId) => ctx.sections.get(sectionId)?.label || 'Section';
    const subjName = (sectionId, subjectId) =>
        ctx.requirements.find((r) => r.sectionId === sectionId && r.subjectId === subjectId)?.subjectName || 'Subject';

    // MERGED subjects sit inside one row as `additionalSubjects`. Flatten them
    // into an occupant each — every one still needs its own free teacher and
    // room — but tag them with the row they came from, so sharing the section's
    // slot is recognised as a merge and not reported as a class clash.
    const occupants = [];
    entries.forEach((raw, rowIndex) => {
        const rowId = String(raw._id ?? raw.id ?? `row${rowIndex}`);
        const base = {
            rowId,
            sectionId: sid(raw.sectionId ?? raw.section),
            dayOfWeek: raw.dayOfWeek,
            periodNumber: Number(raw.periodNumber),
        };
        occupants.push({
            ...base,
            subjectId: sid(raw.subjectId ?? raw.subject),
            teacherId: sid(raw.teacherId ?? raw.teacher),
            roomId: sid(raw.roomId ?? raw.room),
            merged: false,
        });
        for (const m of raw.additionalSubjects || []) {
            occupants.push({
                ...base,
                subjectId: sid(m.subjectId ?? m.subject),
                teacherId: sid(m.teacherId ?? m.teacher),
                roomId: sid(m.roomId ?? m.room),
                merged: true,
            });
        }
    });

    for (const e of occupants) {
        if (!e.subjectId) continue;
        const section = ctx.sections.get(e.sectionId);
        if (!section) {
            push({
                type: CONFLICT_TYPES.OTHER, severity: SEVERITY.ERROR,
                sectionId: e.sectionId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                description: 'Entry belongs to a section that is not part of this timetable version.',
                suggestion: 'Delete the entry or regenerate the version.',
            });
            continue;
        }

        // HARD #13 + #5: the slot must exist and be a teaching period.
        const dayPeriods = section.allByDay.get(e.dayOfWeek);
        const period = (dayPeriods || []).find((p) => Number(p.periodNumber) === e.periodNumber);
        if (!dayPeriods) {
            push({
                type: CONFLICT_TYPES.NON_TEACHING_SLOT, severity: SEVERITY.ERROR,
                sectionId: e.sectionId, subjectId: e.subjectId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                description: `${label(e.sectionId)} does not work on ${e.dayOfWeek}.`,
                suggestion: 'Remove this entry or add the day to the section timetable structure.',
            });
        } else if (!period) {
            push({
                type: CONFLICT_TYPES.NON_TEACHING_SLOT, severity: SEVERITY.ERROR,
                sectionId: e.sectionId, subjectId: e.subjectId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                description: `Period ${e.periodNumber} does not exist in ${label(e.sectionId)}'s day structure.`,
                suggestion: 'Remove this entry or update the period structure.',
            });
        } else if (!isTeachingPeriod(period, { allowActivity: ctx.allowActivity })) {
            push({
                type: CONFLICT_TYPES.NON_TEACHING_SLOT, severity: SEVERITY.ERROR,
                sectionId: e.sectionId, subjectId: e.subjectId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                description: `${subjName(e.sectionId, e.subjectId)} is scheduled during ${periodTypeOf(period).toLowerCase()} (${e.dayOfWeek} P${e.periodNumber}).`,
                suggestion: 'Move the period to a teaching slot.',
            });
        }

        // HARD #1: class clash. Merged subjects share their slot by design, so
        // only occupants from DIFFERENT rows collide.
        const cKey = `${e.sectionId}#${slotKey(e.dayOfWeek, e.periodNumber)}`;
        const held = sectionSlot.get(cKey);
        if (held && held.rowId !== e.rowId) {
            push({
                type: CONFLICT_TYPES.CLASS_CLASH, severity: SEVERITY.ERROR,
                sectionId: e.sectionId, subjectId: e.subjectId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                description: `${label(e.sectionId)} has two subjects at ${e.dayOfWeek} P${e.periodNumber}.`,
                suggestion: 'Delete one of the two entries, or merge the two subjects if they are meant to run together.',
            });
        } else if (!held) {
            sectionSlot.set(cKey, e);
        }
        if (!slotSubjects.has(cKey)) slotSubjects.set(cKey, new Set());
        slotSubjects.get(cKey).add(e.subjectId);

        // HARD #2 / #4 / #9 / #10: teacher rules.
        if (!e.teacherId) {
            push({
                type: CONFLICT_TYPES.NO_TEACHER_ASSIGNED, severity: SEVERITY.WARNING,
                sectionId: e.sectionId, subjectId: e.subjectId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                description: `No teacher assigned for ${subjName(e.sectionId, e.subjectId)} at ${e.dayOfWeek} P${e.periodNumber}.`,
                suggestion: 'Assign a teacher before publishing.',
            });
        } else {
            const t = ctx.teachers.get(e.teacherId);
            const tKey = `${e.teacherId}#${slotKey(e.dayOfWeek, e.periodNumber)}`;
            const clash = teacherSlot.get(tKey);
            if (clash) {
                push({
                    type: CONFLICT_TYPES.TEACHER_CLASH, severity: SEVERITY.ERROR,
                    sectionId: e.sectionId, subjectId: e.subjectId, teacherId: e.teacherId,
                    dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                    description: `${t?.name || 'Teacher'} is booked for both ${label(clash.sectionId)} and ${label(e.sectionId)} at ${e.dayOfWeek} P${e.periodNumber}.`,
                    suggestion: 'Move one of the two periods or assign an alternate teacher.',
                });
            } else {
                teacherSlot.set(tKey, e);
            }
            if (t) {
                if (t.blocked.has(slotKey(e.dayOfWeek, e.periodNumber))) {
                    push({
                        type: CONFLICT_TYPES.TEACHER_UNAVAILABLE, severity: SEVERITY.ERROR,
                        sectionId: e.sectionId, subjectId: e.subjectId, teacherId: e.teacherId,
                        dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                        description: `${t.name} is marked unavailable at ${e.dayOfWeek} P${e.periodNumber}.`,
                        suggestion: 'Move the period or update the teacher\'s availability.',
                    });
                }
                if (ctx.enforceTeacherQualified && t.subjects.size && !t.subjects.has(e.subjectId)) {
                    push({
                        type: CONFLICT_TYPES.SUBJECT_TEACHER_MISMATCH, severity: SEVERITY.ERROR,
                        sectionId: e.sectionId, subjectId: e.subjectId, teacherId: e.teacherId,
                        dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                        description: `${t.name} is not assigned to teach ${subjName(e.sectionId, e.subjectId)}.`,
                        suggestion: 'Assign the subject to this teacher, or pick a qualified teacher.',
                    });
                }
            }
            teacherDay.set(`${e.teacherId}#${e.dayOfWeek}`, (teacherDay.get(`${e.teacherId}#${e.dayOfWeek}`) || 0) + 1);
            teacherWeek.set(e.teacherId, (teacherWeek.get(e.teacherId) || 0) + 1);
        }

        // HARD #3 / #8: room rules.
        if (e.roomId) {
            const room = ctx.rooms.get(e.roomId);
            const rKey = `${e.roomId}#${slotKey(e.dayOfWeek, e.periodNumber)}`;
            const clash = roomSlot.get(rKey);
            if (clash) {
                push({
                    type: CONFLICT_TYPES.ROOM_CLASH, severity: SEVERITY.ERROR,
                    sectionId: e.sectionId, subjectId: e.subjectId, roomId: e.roomId,
                    dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                    description: `${room?.name || 'Room'} is double-booked by ${label(clash.sectionId)} and ${label(e.sectionId)} at ${e.dayOfWeek} P${e.periodNumber}.`,
                    suggestion: 'Assign a different room to one of the classes.',
                });
            } else {
                roomSlot.set(rKey, e);
            }
            if (room) {
                if (room.blocked.has(slotKey(e.dayOfWeek, e.periodNumber))) {
                    push({
                        type: CONFLICT_TYPES.ROOM_UNAVAILABLE, severity: SEVERITY.ERROR,
                        sectionId: e.sectionId, roomId: e.roomId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber,
                        description: `${room.name} is unavailable at ${e.dayOfWeek} P${e.periodNumber}.`,
                        suggestion: 'Pick another room or clear the room\'s blocked slot.',
                    });
                }
            }
        }

        subjectDay.set(`${e.sectionId}#${e.subjectId}#${e.dayOfWeek}`, (subjectDay.get(`${e.sectionId}#${e.subjectId}#${e.dayOfWeek}`) || 0) + 1);
        weeklyCount.set(`${e.sectionId}#${e.subjectId}`, (weeklyCount.get(`${e.sectionId}#${e.subjectId}`) || 0) + 1);
    }

    /* ── Aggregate checks ────────────────────────────────────────────────── */

    // HARD #6: weekly requirement satisfied.
    for (const req of ctx.requirements) {
        const got = weeklyCount.get(`${req.sectionId}#${req.subjectId}`) || 0;
        if (got < req.weeklyPeriods) {
            push({
                type: CONFLICT_TYPES.SUBJECT_PERIOD_SHORTAGE, severity: SEVERITY.ERROR,
                sectionId: req.sectionId, subjectId: req.subjectId, teacherId: req.teacherOptions[0] || null,
                description: `${req.subjectName} for ${label(req.sectionId)}: ${got} of ${req.weeklyPeriods} weekly periods scheduled.`,
                suggestion: `Place ${req.weeklyPeriods - got} more period(s) or reduce the requirement.`,
                meta: { scheduled: got, required: req.weeklyPeriods },
            });
        } else if (got > req.weeklyPeriods) {
            push({
                type: CONFLICT_TYPES.SUBJECT_PERIOD_SHORTAGE, severity: SEVERITY.WARNING,
                sectionId: req.sectionId, subjectId: req.subjectId,
                description: `${req.subjectName} for ${label(req.sectionId)}: ${got} periods scheduled, ${req.weeklyPeriods} required.`,
                suggestion: 'Remove the extra period(s) or raise the weekly requirement.',
                meta: { scheduled: got, required: req.weeklyPeriods },
            });
        }

        // HARD #11: per-day subject cap.
        for (const day of ctx.days) {
            const n = subjectDay.get(`${req.sectionId}#${req.subjectId}#${day}`) || 0;
            if (n > req.maxPerDay) {
                push({
                    type: CONFLICT_TYPES.DAILY_LIMIT_EXCEEDED,
                    severity: req.hardMaxPerDay ? SEVERITY.ERROR : SEVERITY.WARNING,
                    sectionId: req.sectionId, subjectId: req.subjectId, dayOfWeek: day,
                    description: `${req.subjectName} runs ${n} times on ${day} for ${label(req.sectionId)} (max ${req.maxPerDay}).`,
                    suggestion: 'Move the extra period to another day.',
                });
            }
        }

        // HARD #12: consecutive-period requirement actually honoured.
        if (req.consecutivePeriods > 1) {
            for (const day of ctx.days) {
                const section = ctx.sections.get(req.sectionId);
                const teaching = section?.teachingByDay.get(day) || [];
                let run = 0;
                const runs = [];
                for (const slot of teaching) {
                    const inSlot = slotSubjects.get(`${req.sectionId}#${slotKey(day, slot.periodNumber)}`);
                    if (inSlot && inSlot.has(req.subjectId)) run++;
                    else { if (run) runs.push(run); run = 0; }
                }
                if (run) runs.push(run);
                const broken = runs.filter((r) => r % req.consecutivePeriods !== 0 && r < req.consecutivePeriods);
                if (broken.length) {
                    push({
                        type: CONFLICT_TYPES.CONSECUTIVE_PERIOD_ERROR, severity: SEVERITY.WARNING,
                        sectionId: req.sectionId, subjectId: req.subjectId, dayOfWeek: day,
                        description: `${req.subjectName} needs ${req.consecutivePeriods} consecutive periods but sits alone on ${day} for ${label(req.sectionId)}.`,
                        suggestion: 'Move it next to its paired period or regenerate.',
                    });
                }
            }
        }
    }

    // HARD #10: teacher workload ceilings.
    for (const [key, count] of teacherDay) {
        const [teacherId, day] = key.split('#');
        const t = ctx.teachers.get(teacherId);
        if (!t || !t.maxPerDay || count <= t.maxPerDay) continue;
        push({
            type: CONFLICT_TYPES.DAILY_LIMIT_EXCEEDED,
            severity: t.hardDailyLimit ? SEVERITY.ERROR : SEVERITY.WARNING,
            teacherId, dayOfWeek: day,
            description: `${t.name} has ${count} periods on ${day} (limit ${t.maxPerDay}).`,
            suggestion: 'Move a period to another day or raise the teacher\'s daily limit.',
        });
    }
    for (const [teacherId, count] of teacherWeek) {
        const t = ctx.teachers.get(teacherId);
        if (!t || !t.maxPerWeek || count <= t.maxPerWeek) continue;
        push({
            type: CONFLICT_TYPES.WEEKLY_LIMIT_EXCEEDED, severity: SEVERITY.ERROR,
            teacherId,
            description: `${t.name} has ${count} periods this week (limit ${t.maxPerWeek}).`,
            suggestion: 'Reassign some periods to another teacher.',
        });
    }

    const errorCount = conflicts.filter((c) => c.severity === SEVERITY.ERROR).length;
    const warningCount = conflicts.filter((c) => c.severity === SEVERITY.WARNING).length;

    return {
        conflicts,
        valid: errorCount === 0,
        stats: {
            entries: occupants.length,
            errorCount,
            warningCount,
            infoCount: conflicts.length - errorCount - warningCount,
        },
    };
}

/**
 * Check a single drag-and-drop move before it is committed.
 * `entries` must be the version's CURRENT entries including the one being moved.
 *
 * @returns {{ok:boolean, conflicts:Array, blocking:Array}}
 */
function validateMove(ctx, entries, move) {
    const moved = entries.map((e) => (
        String(e._id ?? e.id) === String(move.entryId)
            ? { ...e, dayOfWeek: move.dayOfWeek, periodNumber: Number(move.periodNumber), room: move.roomId ?? e.room, teacher: move.teacherId ?? e.teacher }
            : e
    ));
    const before = validate(ctx, entries);
    const after = validate(ctx, moved);

    // Only conflicts the move INTRODUCES should block it — a version that was
    // already short two periods must still be editable.
    const key = (c) => `${c.type}|${c.sectionId || ''}|${c.teacherId || ''}|${c.roomId || ''}|${c.dayOfWeek || ''}|${c.periodNumber ?? ''}|${c.subjectId || ''}`;
    const had = new Set(before.conflicts.map(key));
    const introduced = after.conflicts.filter((c) => !had.has(key(c)));
    const blocking = introduced.filter((c) => c.severity === 'ERROR');

    return { ok: blocking.length === 0, conflicts: introduced, blocking };
}

module.exports = { validate, validateMove };
