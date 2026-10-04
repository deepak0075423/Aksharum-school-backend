'use strict';
/**
 * The ID Card module's vocabulary and the few rules everything else leans on
 * (Oct 2026).
 *
 * ── Statuses ────────────────────────────────────────────────────────────────
 * Stored (somebody decided it):
 *   active      issued and in use
 *   blocked     suspended for now — can be activated again
 *   lost        reported lost — never valid again
 *   damaged     reported damaged — never valid again
 *   reissued    superseded by a newer card (details changed)
 *   cancelled   withdrawn for good (left the school, issued in error)
 * Worked out when read (nobody has to remember to set them):
 *   expired     a student card whose academic year is behind the school's
 *   generated   a student card issued ahead, for a year not yet begun
 *   pending     no card yet (a holder row, never a card row)
 *
 * ── Which year is "now" ─────────────────────────────────────────────────────
 * The school says, by marking an academic year active — the same switch every
 * other module reads. A student card is in force while its year is an active
 * one; a year that started before the newest active year is over; one that
 * starts after it has not begun. A school with no active year falls back to
 * the calendar (the year whose dates contain today).
 */
const pool = require('../db/pool');
const AcademicYear = require('../models/AcademicYear');
const schoolClock = require('./schoolClock');

class RuleError extends Error {
    constructor(status, message, extra) {
        super(message);
        this.status = status;
        this.extra = extra || null;
    }
}
const fail = (status, message, extra) => { throw new RuleError(status, message, extra); };

const STORED = ['active', 'blocked', 'lost', 'damaged', 'reissued', 'cancelled'];
const LIVE = ['active', 'blocked'];
const TERMINAL = ['lost', 'damaged', 'reissued', 'cancelled'];

const STATUS_LABEL = {
    pending: 'Pending', generated: 'Generated', active: 'Active', expired: 'Expired',
    blocked: 'Blocked', lost: 'Lost', damaged: 'Damaged', reissued: 'Reissued',
    cancelled: 'Cancelled', none: 'No card',
};

const PREFIX = { student: 'ST', teacher: 'TC', staff: 'SF', parent: 'PR' };

/** "2026-04-01T00:00:00Z" → "2026-04-01". Stored days are UTC midnight of the day meant. */
const dayKey = (d) => {
    if (!d) return '';
    const x = d instanceof Date ? d : new Date(d);
    return Number.isNaN(x.getTime()) ? '' : x.toISOString().slice(0, 10);
};

/** "2627" for the year 1 Apr 2026 – 31 Mar 2027 — its first and last calendar years. */
function yearCode(year) {
    const a = dayKey(year?.startDate).slice(2, 4);
    const b = dayKey(year?.endDate).slice(2, 4);
    if (a && b) return `${a}${b}`;
    const m = String(year?.yearName || '').match(/(\d{2,4})\D+(\d{2,4})/);
    return m ? `${m[1].slice(-2)}${m[2].slice(-2)}` : String(new Date().getFullYear()).slice(2);
}

/**
 * The school's academic years with where each stands today.
 *   → { years: [{ _id, yearName, startDate, endDate, status, phase }], byId, current, next, today }
 * phase: 'current' | 'past' | 'upcoming'. `current` is the newest in-force
 * year, `next` the first one after it.
 */
async function yearContext(schoolId) {
    const { rows } = await pool.query(
        `SELECT "_id", "yearName", "startDate", "endDate", "status"
           FROM "${AcademicYear.tableName}" WHERE "school" = $1::uuid
          ORDER BY "startDate" ASC NULLS LAST, "yearName" ASC`, [String(schoolId)]);
    const today = schoolClock.todayIn(schoolClock.zoneOf(schoolId));
    const active = rows.filter((y) => y.status === 'active');
    const anchor = active.length
        ? active.reduce((a, y) => (dayKey(y.startDate) > dayKey(a.startDate) ? y : a))
        : null;
    const years = rows.map((y) => {
        const start = dayKey(y.startDate);
        const end = dayKey(y.endDate);
        let phase;
        if (anchor) {
            if (y.status === 'active') phase = 'current';
            else phase = start < dayKey(anchor.startDate) ? 'past' : 'upcoming';
        } else if (end && end < today) phase = 'past';
        else if (start && start > today) phase = 'upcoming';
        else phase = 'current';
        return { _id: String(y._id), yearName: y.yearName, startDate: y.startDate, endDate: y.endDate, status: y.status, phase };
    });
    const byId = new Map(years.map((y) => [y._id, y]));
    const inForce = years.filter((y) => y.phase === 'current');
    const current = inForce.length ? inForce[inForce.length - 1] : null;
    const next = current ? years.find((y) => y.phase === 'upcoming' && dayKey(y.startDate) > dayKey(current.startDate)) || null
        : years.find((y) => y.phase === 'upcoming') || null;
    return { years, byId, current, next, today };
}

/**
 * What a card is now: its stored status, except that a student card that is
 * still `active` reads as expired once its year is over and as generated while
 * its year has not begun.
 */
function effectiveStatus(card, ctx) {
    if (!card) return 'pending';
    if (card.status !== 'active') return card.status;
    if (card.kind !== 'student') return 'active';
    const y = ctx?.byId?.get(String(card.academicYear || ''));
    if (!y) return 'expired';      // its year was deleted: nothing to be valid for
    if (y.phase === 'past') return 'expired';
    if (y.phase === 'upcoming') return 'generated';
    return 'active';
}

/** May new student cards be issued for this year? Only while it has not ended. */
function canIssueFor(year) {
    return !!year && year.phase !== 'past';
}

/** A card the office can still act on: live, and (for a student) not of a year gone by. */
function isActionable(card, ctx) {
    if (!LIVE.includes(card.status)) return false;
    if (card.kind !== 'student') return true;
    const y = ctx?.byId?.get(String(card.academicYear || ''));
    return !!y && y.phase !== 'past';
}

/** The holder's role on the card, worded for the card. */
const KIND_TITLE = { student: 'Student', teacher: 'Teacher', staff: 'Staff', parent: 'Parent' };

module.exports = {
    RuleError, fail, STORED, LIVE, TERMINAL, STATUS_LABEL, PREFIX, KIND_TITLE,
    dayKey, yearCode, yearContext, effectiveStatus, canIssueFor, isActionable,
};
