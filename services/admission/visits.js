'use strict';
/**
 * Campus visits (Oct 2026): the office opens times, a signed-in family books
 * one for so many people, and may cancel up to so many hours before; the
 * office marks who came, or cancels a time (everyone booked is told why).
 *
 * What is left of a time is counted from its bookings under a lock — never
 * kept as a number that two bookings could both read — so a time is never
 * overbooked. Times are the moment they start (the browser sends them), so the
 * server's own time zone plays no part.
 */
const pool = require('../../db/pool');
const { withTransaction, lock, buildInsert } = require('../dbTx');
const AdmissionVisitSlot = require('../../models/AdmissionVisitSlot');
const AdmissionVisitBooking = require('../../models/AdmissionVisitBooking');
const settingsSvc = require('./settings');
const events = require('./events');
const notify = require('./notify');
const fmt = require('./format');
const { refuse, isId, str, num, date } = require('./util');
const { textProblem } = require('../../utils/textRules');

const ACTIVE = ['booked', 'attended'];   // what holds a place
const MAX_NEW = 200;

const hoursUntil = (d) => (new Date(d).getTime() - Date.now()) / 3600000;

function words(v, label, max, kind = 'sentence') {
    const t = str(v, max);
    const bad = textProblem(t, label, kind);
    if (bad) refuse(bad, 400);
    return t;
}

/** People booked on each of these times: { slotId: n }. */
async function takenBySlot(slotIds, q = null) {
    if (!slotIds.length) return {};
    const run = q || ((s, p) => pool.query(s, p));
    const { rows } = await run(
        `SELECT "slot", COALESCE(SUM("people"), 0)::int AS n, COUNT(*)::int AS bookings FROM "admissionvisitbookings"
          WHERE "slot" = ANY($1::uuid[]) AND "status" = ANY($2::text[]) GROUP BY "slot"`, [slotIds.map(String), ACTIVE]);
    return Object.fromEntries(rows.map((r) => [String(r.slot), r]));
}

function values(slot, booking) {
    return {
        visit_title: slot.title, visit_date: fmt.fmtDate(slot.startsAt, { weekday: true }), visit_time: fmt.fmtTime(slot.startsAt),
        visit_location: slot.location || '', visit_people: String(booking?.people || 1),
    };
}

// ── The office ───────────────────────────────────────────────────────────────

/**
 * Open times: `starts` is a list of moments (ISO), the same title, length,
 * room and place for each. Up to 200 at once; never in the past.
 */
async function createSlots(req, input = {}) {
    const starts = (Array.isArray(input.starts) ? input.starts : []).slice(0, MAX_NEW + 1);
    if (!starts.length) refuse('Choose at least one date and time', 400, { field: 'starts' });
    if (starts.length > MAX_NEW) refuse(`At most ${MAX_NEW} times at once`, 400, { field: 'starts' });
    const when = starts.map((x, i) => {
        const d = date(x);
        if (!d) refuse(`Time ${i + 1} is not a date and time`, 400, { field: 'starts' });
        if (d < new Date()) refuse(`${fmt.fmtDateTime(d)} has passed`, 400, { field: 'starts' });
        if (d > new Date(Date.now() + 400 * 86400000)) refuse('Times can be opened up to a year ahead', 400, { field: 'starts' });
        return d;
    });
    const common = {
        title: words(input.title, 'Title', 80, 'title') || 'Campus visit',
        durationMinutes: num(input.durationMinutes, { min: 15, max: 480, d: 60, int: true }),
        capacity: num(input.capacity, { min: 1, max: 1000, d: 10, int: true }),
        location: words(input.location, 'Where to come', 160, 'title'),
        notes: words(input.notes, 'Notes for families', 600),
    };
    const rows = await withTransaction(async (q) => {
        const out = [];
        for (const startsAt of [...new Set(when.map((d) => d.getTime()))].map((t) => new Date(t))) {
            const { sql, params } = buildInsert(AdmissionVisitSlot, { school: req.schoolId, ...common, startsAt, status: 'open', createdBy: req.userId });
            out.push((await q(sql, params)).rows[0]);
        }
        return out;
    });
    events.recordQuietly(req.schoolId, { by: req, type: 'visit', action: 'opened', message: `${rows.length} visit time(s) opened — ${common.title}` });
    return rows;
}

async function slotOf(schoolId, id, q = null) {
    if (!isId(String(id || ''))) refuse('Visit time not found', 404);
    const run = q || ((s, p) => pool.query(s, p));
    const { rows: [s] } = await run(`SELECT * FROM "admissionvisitslots" WHERE "_id" = $1 AND "school" = $2${q ? ' FOR UPDATE' : ''}`, [String(id), String(schoolId)]);
    if (!s) refuse('Visit time not found', 404);
    return s;
}

/** Times between two dates, each with what is booked. */
async function officeList(schoolId, { from, to } = {}) {
    const start = date(from) || new Date(Date.now() - 7 * 86400000);
    const end = date(to) || new Date(Date.now() + 90 * 86400000);
    const { rows } = await pool.query(
        `SELECT * FROM "admissionvisitslots" WHERE "school" = $1 AND "startsAt" >= $2 AND "startsAt" < $3 ORDER BY "startsAt" LIMIT 500`, [String(schoolId), start, end]);
    const taken = await takenBySlot(rows.map((r) => r._id));
    return rows.map((r) => ({ ...r, booked: taken[String(r._id)]?.n || 0, bookings: taken[String(r._id)]?.bookings || 0 }));
}

async function updateSlot(req, id, input = {}) {
    const row = await withTransaction(async (q) => {
        const s = await slotOf(req.schoolId, id, q);
        if (s.status !== 'open') refuse('A cancelled time cannot be changed', 409);
        await lock(q, `admission-visit:${s._id}`);
        const set = {};
        if (input.capacity !== undefined) {
            const capacity = num(input.capacity, { min: 1, max: 1000, d: s.capacity, int: true });
            const booked = (await takenBySlot([s._id], q))[String(s._id)]?.n || 0;
            if (capacity < booked) refuse(`${booked} people are booked — it cannot hold fewer`, 409);
            set.capacity = capacity;
        }
        if (input.title !== undefined) set.title = words(input.title, 'Title', 80, 'title') || s.title;
        if (input.location !== undefined) set.location = words(input.location, 'Where to come', 160, 'title');
        if (input.notes !== undefined) set.notes = words(input.notes, 'Notes for families', 600);
        if (input.durationMinutes !== undefined) set.durationMinutes = num(input.durationMinutes, { min: 15, max: 480, d: s.durationMinutes, int: true });
        if (!Object.keys(set).length) return s;
        const keys = Object.keys(set);
        const { rows: [r] } = await q(`UPDATE "admissionvisitslots" SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')}, "updatedAt" = now() WHERE "_id" = $1 RETURNING *`, [s._id, ...keys.map((k) => set[k])]);
        return r;
    });
    return row;
}

/** Cancel a time: everyone booked is told why. */
async function cancelSlot(req, id, reason) {
    const why = words(reason, 'Reason', 300);
    if (!why) refuse('Say why the visit is cancelled — families are told', 400, { field: 'reason' });
    const { slot, told } = await withTransaction(async (q) => {
        const s = await slotOf(req.schoolId, id, q);
        if (s.status === 'cancelled') refuse('Already cancelled', 409);
        await q(`UPDATE "admissionvisitslots" SET "status" = 'cancelled', "cancelReason" = $2, "updatedAt" = now() WHERE "_id" = $1`, [s._id, why]);
        const { rows } = await q(
            `UPDATE "admissionvisitbookings" SET "status" = 'cancelled', "cancelledBy" = 'school', "cancelledAt" = now(), "updatedAt" = now()
              WHERE "slot" = $1 AND "status" = 'booked' RETURNING *`, [s._id]);
        return { slot: s, told: rows };
    });
    for (const b of told) notify.toApplicantUser(slot.school, b.applicant, 'visit_cancelled', { ...values(slot, b), reason: why });
    events.recordQuietly(req.schoolId, { by: req, type: 'visit', action: 'cancelled', message: `Visit ${fmt.fmtDateTime(slot.startsAt)} cancelled — ${why} (${told.length} booking(s))` });
    return { cancelled: told.length };
}

async function bookingsOf(schoolId, id) {
    const s = await slotOf(schoolId, id);
    const { rows } = await pool.query(
        `SELECT "_id", "name", "email", "phone", "people", "note", "status", "cancelledBy", "createdAt" FROM "admissionvisitbookings"
          WHERE "slot" = $1 ORDER BY ("status" = 'cancelled'), "createdAt"`, [s._id]);
    return { slot: s, bookings: rows };
}

/** Mark who came. */
async function markBooking(req, bookingId, status) {
    if (!['attended', 'no_show', 'booked'].includes(status)) refuse('Mark the visit attended or not attended');
    if (!isId(String(bookingId || ''))) refuse('Booking not found', 404);
    const { rows: [b] } = await pool.query(
        `UPDATE "admissionvisitbookings" SET "status" = $3, "updatedAt" = now() WHERE "_id" = $1 AND "school" = $2 AND "status" <> 'cancelled' RETURNING *`,
        [String(bookingId), String(req.schoolId), status]);
    if (!b) refuse('Booking not found, or it was cancelled', 404);
    return b;
}

// ── Families ─────────────────────────────────────────────────────────────────

/** Upcoming open times (with what is left) and the family's own bookings. */
async function familyView(schoolId, userId) {
    const settings = await settingsSvc.getSettings(schoolId);
    const v = settings.visits;
    const { rows: slots } = v.enabled ? await pool.query(
        `SELECT "_id", "title", "startsAt", "durationMinutes", "location", "notes", "capacity" FROM "admissionvisitslots"
          WHERE "school" = $1 AND "status" = 'open' AND "startsAt" > now() + interval '30 minutes' AND "startsAt" < now() + interval '120 days'
          ORDER BY "startsAt" LIMIT 300`, [String(schoolId)]) : { rows: [] };
    const taken = await takenBySlot(slots.map((s) => s._id));
    const mine = userId ? (await pool.query(
        `SELECT b."_id", b."people", b."status", b."note", b."cancelledBy", b."createdAt", s."_id" AS "slotId", s."title", s."startsAt", s."durationMinutes", s."location", s."cancelReason"
           FROM "admissionvisitbookings" b JOIN "admissionvisitslots" s ON s."_id" = b."slot"
          WHERE b."school" = $1 AND b."applicant" = $2 AND s."startsAt" > now() - interval '30 days' ORDER BY s."startsAt" DESC LIMIT 20`, [String(schoolId), String(userId)])).rows : [];
    return {
        enabled: v.enabled, intro: v.intro, maxPeople: v.maxPeople, cancelUntilHours: v.cancelUntilHours,
        slots: slots.map(({ capacity, ...s }) => ({ ...s, left: Math.max(0, capacity - (taken[String(s._id)]?.n || 0)) })),
        mine: mine.map((b) => ({ ...b, canCancel: b.status === 'booked' && hoursUntil(b.startsAt) >= v.cancelUntilHours })),
    };
}

async function book(req, slotId, input = {}) {
    const settings = await settingsSvc.getSettings(req.schoolId);
    const v = settings.visits;
    if (!v.enabled) refuse('The school is not taking visit bookings online', 409);
    const people = num(input.people, { min: 1, max: v.maxPeople, d: 1, int: true });
    if (Number(input.people) > v.maxPeople) refuse(`At most ${v.maxPeople} people per booking`, 400, { field: 'people' });
    const note = words(input.note, 'Your note', 300);
    const { slot, booking } = await withTransaction(async (q) => {
        const s = await slotOf(req.schoolId, slotId, q);
        if (s.status !== 'open') refuse('This visit has been cancelled', 409);
        if (hoursUntil(s.startsAt) < 0.5) refuse('This visit is about to start — choose a later one', 409);
        await lock(q, `admission-visit:${s._id}`);
        const { rows: [dup] } = await q(`SELECT 1 FROM "admissionvisitbookings" WHERE "slot" = $1 AND "applicant" = $2 AND "status" = ANY($3::text[])`, [s._id, String(req.userId), ACTIVE]);
        if (dup) refuse('You have already booked this visit', 409, { code: 'ALREADY_BOOKED' });
        const booked = (await takenBySlot([s._id], q))[String(s._id)]?.n || 0;
        const left = s.capacity - booked;
        if (people > left) refuse(left > 0 ? `Only ${left} place${left === 1 ? '' : 's'} left on this visit` : 'This visit is full — choose another time', 409, { code: 'VISIT_FULL' });
        const { rows: [u] } = await q(`SELECT "name", "email", "phone" FROM "users" WHERE "_id" = $1`, [String(req.userId)]);
        const { sql, params } = buildInsert(AdmissionVisitBooking, {
            school: req.schoolId, slot: s._id, applicant: req.userId, name: u?.name || '', email: u?.email || '', phone: u?.phone || '', people, note, status: 'booked',
        });
        return { slot: s, booking: (await q(sql, params)).rows[0] };
    });
    notify.toApplicantUser(req.schoolId, req.userId, 'visit_booked', values(slot, booking));
    events.recordQuietly(req.schoolId, { by: req, type: 'visit', action: 'booked', message: `Visit ${fmt.fmtDateTime(slot.startsAt)} booked for ${people}` });
    return booking;
}

async function cancelByFamily(req, bookingId) {
    if (!isId(String(bookingId || ''))) refuse('Booking not found', 404);
    const settings = await settingsSvc.getSettings(req.schoolId);
    return withTransaction(async (q) => {
        const { rows: [b] } = await q(`SELECT * FROM "admissionvisitbookings" WHERE "_id" = $1 AND "school" = $2 AND "applicant" = $3 FOR UPDATE`, [String(bookingId), String(req.schoolId), String(req.userId)]);
        if (!b) refuse('Booking not found', 404);
        if (b.status !== 'booked') refuse('This booking is not open', 409);
        const s = await slotOf(req.schoolId, b.slot, q);
        if (hoursUntil(s.startsAt) < settings.visits.cancelUntilHours) refuse(`Visits can be cancelled here up to ${settings.visits.cancelUntilHours} hours before — please call the admission office`, 409, { code: 'TOO_LATE' });
        const { rows: [r] } = await q(`UPDATE "admissionvisitbookings" SET "status" = 'cancelled', "cancelledBy" = 'family', "cancelledAt" = now(), "updatedAt" = now() WHERE "_id" = $1 RETURNING *`, [b._id]);
        return r;
    });
}

/** The calendar file for a family's booking. */
async function calendarFor(req, bookingId) {
    if (!isId(String(bookingId || ''))) refuse('Booking not found', 404);
    const { rows: [b] } = await pool.query(
        `SELECT b.*, s."title", s."startsAt", s."durationMinutes", s."location", s."notes" FROM "admissionvisitbookings" b JOIN "admissionvisitslots" s ON s."_id" = b."slot"
          WHERE b."_id" = $1 AND b."school" = $2 AND b."applicant" = $3`, [String(bookingId), String(req.schoolId), String(req.userId)]);
    if (!b || b.status === 'cancelled') refuse('Booking not found', 404);
    const { rows: [school] } = await pool.query(`SELECT "name" FROM "schools" WHERE "_id" = $1`, [String(req.schoolId)]);
    return require('./calendar').ics({
        uid: `visit-${b._id}`, start: b.startsAt, minutes: b.durationMinutes, summary: `${b.title} — ${school?.name || 'school'}`,
        location: b.location, description: [`${b.people} ${b.people === 1 ? 'person' : 'people'}.`, b.notes].filter(Boolean).join(' '),
    });
}

/** Reminders, once each, so many hours before (the sweep). */
async function reminders(schoolId, settings) {
    const hours = Number(settings.visits?.reminderHours) || 0;
    if (!settings.visits?.enabled || !hours) return 0;
    const { rows } = await pool.query(
        `UPDATE "admissionvisitbookings" b SET "remindedAt" = now()
           FROM "admissionvisitslots" s
          WHERE s."_id" = b."slot" AND b."school" = $1 AND b."status" = 'booked' AND b."remindedAt" IS NULL AND s."status" = 'open'
            AND s."startsAt" > now() AND s."startsAt" <= now() + make_interval(hours => $2)
            AND b."createdAt" < now() - interval '1 hour'
          RETURNING b.*, s."title", s."startsAt", s."location"`, [String(schoolId), hours]);
    for (const b of rows) notify.toApplicantUser(schoolId, b.applicant, 'visit_reminder', values(b, b));
    return rows.length;
}

module.exports = { createSlots, officeList, updateSlot, cancelSlot, bookingsOf, markBooking, familyView, book, cancelByFamily, calendarFor, reminders, takenBySlot };
