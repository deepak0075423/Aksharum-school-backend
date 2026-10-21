'use strict';
/**
 * Exam and interview times a family chooses itself (Oct 2026).
 *
 * The office keeps scheduling candidates as before; on an offline exam or an
 * interview it may also publish times — each with room for so many — and the
 * family picks one from its application page, and may move it (so many times,
 * up to so many hours before). Room is counted under a lock, so two families
 * can never take the last place together. The chosen time is the candidate's
 * `slot`: the admit card, the reminders and the calendar file all follow it.
 */
const crypto = require('crypto');
const pool = require('../../db/pool');
const { withTransaction, lock } = require('../dbTx');
const events = require('./events');
const notify = require('./notify');
const fmt = require('./format');
const { refuse, str, num, bool, date } = require('./util');

const MAX_SLOTS = 300;
const ID_RE = /^[a-z0-9]{6,16}$/;

/**
 * The booking block as the exam keeps it: on only for offline exams and
 * interviews, times in order, ids kept across edits (bookings point at them).
 */
function normalizeBooking(input, mode, current = null) {
    const b = input || current || {};
    const enabled = bool(b.enabled, false);
    if (mode === 'online') {
        if (enabled) refuse('An online exam has a window to take it in, not times to book', 400, { field: 'booking' });
        return { enabled: false, slots: [], changeUntilHours: 24, maxChanges: 2 };
    }
    const list = (Array.isArray(b.slots) ? b.slots : []).slice(0, MAX_SLOTS + 1);
    if (list.length > MAX_SLOTS) refuse(`At most ${MAX_SLOTS} times`, 400, { field: 'booking.slots' });
    const seen = new Set();
    const slots = list.map((x, i) => {
        const startsAt = date(x?.startsAt);
        if (!startsAt) refuse(`Time ${i + 1} needs a date and time`, 400, { field: 'booking.slots' });
        let id = ID_RE.test(String(x?.id || '')) ? String(x.id) : crypto.randomBytes(5).toString('hex');
        if (seen.has(id)) id = crypto.randomBytes(5).toString('hex');
        seen.add(id);
        const room = str(x?.room, 60);
        return { id, startsAt, capacity: num(x?.capacity, { min: 1, max: 500, d: 10, int: true }), room };
    }).sort((a, z) => a.startsAt - z.startsAt);
    if (enabled && !slots.length) refuse('Add the times families can choose from', 400, { field: 'booking.slots' });
    return {
        enabled, slots,
        changeUntilHours: num(b.changeUntilHours, { min: 0, max: 168, d: 24, int: true }),
        maxChanges: num(b.maxChanges, { min: 0, max: 10, d: 2, int: true }),
    };
}

/** Places taken on each time: { slotId: n }. */
async function takenBySlot(examId, q = null) {
    const run = q || ((s, p) => pool.query(s, p));
    const { rows } = await run(
        `SELECT "slotId", COUNT(*)::int AS n FROM "admissioncandidates" WHERE "exam" = $1 AND "slotId" <> '' AND "status" <> 'withdrawn' GROUP BY "slotId"`, [String(examId)]);
    return Object.fromEntries(rows.map((r) => [r.slotId, r.n]));
}

/** An edit may not drop a time families hold, or make it smaller than what is taken. */
async function checkEdit(exam, next) {
    const taken = await takenBySlot(exam._id);
    const kept = new Map((next?.slots || []).map((s) => [s.id, s]));
    for (const old of exam.booking?.slots || []) {
        const n = taken[old.id] || 0;
        if (!n) continue;
        const now = kept.get(old.id);
        const when = fmt.fmtDateTime(old.startsAt);
        if (!now) refuse(`${n} ${n === 1 ? 'family has' : 'families have'} booked ${when} — move them before removing it`, 409, { code: 'SLOT_BOOKED' });
        if (now.capacity < n) refuse(`${n} places at ${when} are taken — it cannot hold fewer`, 409, { code: 'SLOT_BOOKED' });
        if (new Date(now.startsAt).getTime() !== new Date(old.startsAt).getTime()) refuse(`${when} is booked — add a new time instead of moving it`, 409, { code: 'SLOT_BOOKED' });
    }
    // Switching booking off keeps every time already chosen; it only stops new choices.
}

const hoursUntil = (d) => (new Date(d).getTime() - Date.now()) / 3600000;

/** The exam's candidate row for this application, if it was scheduled. */
async function candidateOf(examId, appId, q = null) {
    const run = q || ((s, p) => pool.query(s, p));
    const { rows: [c] } = await run(`SELECT * FROM "admissioncandidates" WHERE "exam" = $1 AND "application" = $2 AND "status" <> 'withdrawn'`, [String(examId), String(appId)]);
    return c || null;
}

/** What the family sees: the times, what is left of each, theirs, and whether they may still change. */
async function familyView(exam, cand, taken = null) {
    const b = exam.booking || {};
    if (!b.enabled && !cand?.slotId) return null;
    const t = taken || await takenBySlot(exam._id);
    const mine = (b.slots || []).find((s) => s.id === cand?.slotId) || null;
    const lockedMine = mine && hoursUntil(mine.startsAt) < b.changeUntilHours;
    const changesLeft = Math.max(0, (b.maxChanges ?? 2) - (cand?.slotChanges || 0));
    return {
        enabled: !!b.enabled,
        changeUntilHours: b.changeUntilHours,
        mine: mine ? { id: mine.id, startsAt: mine.startsAt, room: mine.room } : null,
        canChoose: !!b.enabled && cand?.status === 'scheduled' && (!mine || (!lockedMine && changesLeft > 0)),
        changesLeft: mine ? changesLeft : null,
        slots: (b.slots || []).filter((s) => hoursUntil(s.startsAt) >= b.changeUntilHours || s.id === cand?.slotId).map((s) => ({
            id: s.id, startsAt: s.startsAt, room: s.room, left: Math.max(0, s.capacity - (t[s.id] || 0)),
        })),
    };
}

/**
 * Take (or move to) a time. The family: within the exam's rules. The office
 * (`office: true`): any time, and past a full one only with `force`.
 */
async function choose(req, exam, app, slotId, { office = false, force = false } = {}) {
    const b = exam.booking || {};
    if (exam.status !== 'scheduled') refuse('This exam is not open for booking', 409);
    if (!office && !b.enabled) refuse('The school chooses the times for this exam', 409);
    const slot = (b.slots || []).find((s) => s.id === String(slotId || ''));
    if (!slot) refuse('That time is not one of the exam\'s', 404);
    const result = await withTransaction(async (q) => {
        await lock(q, `admission-exam-slots:${exam._id}`);
        const cand = await candidateOf(exam._id, app._id, q);
        if (!cand) refuse('This application is not scheduled for the exam', 404);
        if (cand.slotId === slot.id) return { cand, same: true };
        if (!office) {
            if (cand.status !== 'scheduled') refuse('Attendance has been marked — the time cannot change now', 409);
            if (hoursUntil(slot.startsAt) < b.changeUntilHours) refuse(`Times less than ${b.changeUntilHours} hours away cannot be booked here — please call the admission office`, 409, { code: 'TOO_LATE' });
            if (cand.slotId) {
                const old = (b.slots || []).find((s) => s.id === cand.slotId);
                if (old && hoursUntil(old.startsAt) < b.changeUntilHours) refuse(`Your time is less than ${b.changeUntilHours} hours away — it can no longer be changed here`, 409, { code: 'TOO_LATE' });
                if ((cand.slotChanges || 0) >= (b.maxChanges ?? 2)) refuse('You have changed the time as often as the school allows — please call the admission office', 409, { code: 'NO_CHANGES_LEFT' });
            }
        }
        const taken = (await takenBySlot(exam._id, q))[slot.id] || 0;
        if (taken >= slot.capacity && !(office && force)) refuse('That time is full — choose another', 409, { code: 'SLOT_FULL' });
        const { rows: [row] } = await q(
            `UPDATE "admissioncandidates" SET "slot" = $2, "slotId" = $3, "room" = COALESCE(NULLIF($4, ''), "room"),
                    "slotChanges" = "slotChanges" + $5, "slotBookedAt" = now(), "remindedAt" = NULL, "updatedAt" = now()
              WHERE "_id" = $1 AND "slotId" = $6 RETURNING *`,
            [cand._id, slot.startsAt, slot.id, slot.room || '', cand.slotId && !office ? 1 : 0, cand.slotId || '']);
        if (!row) refuse('The time was just changed — reload and try again', 409);
        return { cand: row, moved: !!cand.slotId };
    });
    if (!result.same) {
        const when = fmt.fmtDateTime(slot.startsAt);
        events.recordQuietly(app.school, {
            application: app._id, by: req, type: 'exam', action: result.moved ? 'slot_moved' : 'slot_booked', visibility: 'applicant',
            message: `${exam.name}: ${result.moved ? 'moved to' : 'booked for'} ${when}${slot.room ? `, ${slot.room}` : ''}${office ? ' by the office' : ''}`,
        });
        notify.toApplicant(app, 'slot_booked', require('./exams').examValues(exam, result.cand));
    }
    return result.cand;
}

/** The exam's times with what is taken — for the office. */
async function officeView(exam) {
    const taken = await takenBySlot(exam._id);
    const { rows: [u] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE "slotId" = '')::int AS unbooked FROM "admissioncandidates" WHERE "exam" = $1 AND "status" <> 'withdrawn'`, [String(exam._id)]);
    return {
        ...(exam.booking || { enabled: false, slots: [] }),
        slots: (exam.booking?.slots || []).map((s) => ({ ...s, taken: taken[s.id] || 0 })),
        unbooked: u.unbooked,
    };
}

/** The calendar file for a candidate's time (or the exam's). */
function calendarFor(exam, cand, schoolName, appLink) {
    const venue = exam.mode === 'online' ? 'Online, on the admission portal' : [exam.venue?.name, cand.room || exam.venue?.room, exam.venue?.address].filter(Boolean).join(', ');
    return require('./calendar').ics({
        uid: `exam-${cand._id}`, start: cand.slot || exam.startsAt, minutes: exam.durationMinutes,
        summary: `${exam.name} — ${schoolName}`, location: venue,
        description: [cand.rollNumber ? `Roll number ${cand.rollNumber}.` : '', exam.reportingTime ? `Report by ${fmt.fmtClock(exam.reportingTime)}.` : '', exam.requiredItems ? `Bring: ${exam.requiredItems}` : ''].filter(Boolean).join(' '),
        url: appLink,
    });
}

module.exports = { normalizeBooking, takenBySlot, checkEdit, familyView, choose, officeView, candidateOf, calendarFor };
