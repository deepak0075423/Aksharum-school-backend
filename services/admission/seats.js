'use strict';
/**
 * Seats in a class of a round.
 *
 * Seats are COUNTED from the rows that hold them, never kept as a running
 * number that could drift: an offer that is issued, accepted or confirmed
 * holds one; so does an application confirmed or enrolled without an offer
 * (a school that runs no Offer stage). Every change that takes or gives back
 * a seat runs inside withSeat(), which holds an advisory lock on
 * (round, class) for its transaction — two offers for the last seat are
 * serialised, and the second one sees it gone.
 *
 * Seats come in pools (Oct 2026): each quota of the class (RTE 25%, staff
 * wards …, services/admission/quotas.js) is its own pool, and the general
 * seats are the class's seats less every quota's — less what a quota has
 * released back. An offer holds a seat in its own pool (offer.quota); an
 * application confirmed without an offer holds one in its verified quota's.
 * With no quotas the general pool is the whole class, as before.
 *
 * A class with 0 seats is unlimited (its general pool; a quota always has a number).
 */
const AdmissionRound = require('../../models/AdmissionRound');
const AdmissionOffer = require('../../models/AdmissionOffer');
const AdmissionApplication = require('../../models/AdmissionApplication');
const { withTransaction, lock } = require('../dbTx');
const pool = require('../../db/pool');

const HOLDING_OFFER = ['issued', 'accepted', 'confirmed'];

async function classConfig(roundId, classId, q) {
    const run = q || ((s, p) => pool.query(s, p));
    const { rows } = await run(`SELECT "classes" FROM "${AdmissionRound.tableName}" WHERE "_id" = $1`, [String(roundId)]);
    const cls = (rows[0]?.classes || []).find((c) => String(c.class) === String(classId));
    return { seats: Number(cls?.seats) || 0, quotas: Array.isArray(cls?.quotas) ? cls.quotas : [] };
}

const open = (qd) => Math.max(0, (Number(qd.seats) || 0) - (Number(qd.released) || 0));

/** How many seats a pool has: a quota's (net of released), or the general seats (0 = unlimited). */
function capacityOf(cfg, quota = '') {
    if (quota) {
        const qd = cfg.quotas.find((x) => x.key === quota);
        return qd ? open(qd) : 0;
    }
    if (!cfg.seats) return 0;
    return Math.max(0, cfg.seats - cfg.quotas.reduce((s, x) => s + open(x), 0));
}

/** Seats held in one pool. */
async function takenIn(roundId, classId, quota, run) {
    const { rows } = await run(
        `SELECT COUNT(*)::int AS n FROM (
            SELECT o."application" FROM "${AdmissionOffer.tableName}" o
             WHERE o."round" = $1 AND o."class" = $2 AND o."status" = ANY($3::text[]) AND COALESCE(o."quota", '') = $4
            UNION
            SELECT a."_id" FROM "${AdmissionApplication.tableName}" a
             WHERE a."round" = $1 AND a."class" = $2 AND a."status" IN ('confirmed', 'enrolled')
               AND NOT EXISTS (SELECT 1 FROM "${AdmissionOffer.tableName}" o2 WHERE o2."application" = a."_id" AND o2."status" = ANY($3::text[]))
               AND (CASE WHEN a."quotaStatus" IN ('verified', 'allotted') THEN COALESCE(a."quota", '') ELSE '' END) = $4
         ) held`,
        [String(roundId), String(classId), HOLDING_OFFER, String(quota || '')]);
    return rows[0].n;
}

/** { capacity, taken, available (null = unlimited), quota } for one pool of a class of a round. */
async function state(roundId, classId, q = null, { quota = '' } = {}) {
    const run = q || ((s, p) => pool.query(s, p));
    const cfg = await classConfig(roundId, classId, q);
    const cap = capacityOf(cfg, quota);
    const taken = await takenIn(roundId, classId, quota, run);
    const unlimited = !quota && !cfg.seats;
    return { capacity: cap, taken, available: unlimited ? null : Math.max(0, cap - taken), quota: quota || '' };
}

/** Every pool of a class: the general seats first, then each quota. */
async function pools(roundId, classId, q = null) {
    const cfg = await classConfig(roundId, classId, q);
    const out = [{ ...(await state(roundId, classId, q, { quota: '' })), name: 'General' }];
    for (const qd of cfg.quotas) out.push({ ...(await state(roundId, classId, q, { quota: qd.key })), name: qd.name, kind: qd.kind, released: Number(qd.released) || 0, reserved: Number(qd.seats) || 0 });
    return out;
}

/** Seat state for every class of a round: the class totals, and its pools. */
async function roundState(roundId) {
    const { rows: [round] } = await pool.query(`SELECT "classes" FROM "${AdmissionRound.tableName}" WHERE "_id" = $1`, [String(roundId)]);
    const { rows } = await pool.query(
        `SELECT "class", COUNT(*)::int AS n FROM (
            SELECT o."class", o."application" FROM "${AdmissionOffer.tableName}" o WHERE o."round" = $1 AND o."status" = ANY($2::text[])
            UNION
            SELECT a."class", a."_id" FROM "${AdmissionApplication.tableName}" a WHERE a."round" = $1 AND a."status" IN ('confirmed', 'enrolled')
         ) held GROUP BY "class"`,
        [String(roundId), HOLDING_OFFER]);
    const taken = new Map(rows.map((r) => [String(r.class), r.n]));
    const out = [];
    for (const c of round?.classes || []) {
        const cap = Number(c.seats) || 0;
        const t = taken.get(String(c.class)) || 0;
        const quotas = Array.isArray(c.quotas) ? c.quotas : [];
        out.push({
            class: String(c.class), capacity: cap, taken: t, available: cap > 0 ? Math.max(0, cap - t) : null,
            pools: quotas.length ? await pools(roundId, c.class) : null,
        });
    }
    return out;
}

/** Run `fn(q, poolState)` holding the seat lock of (round, class) — the pool is the general seats unless a quota is named. */
function withSeat(roundId, classId, fn, { quota = '' } = {}) {
    return withTransaction(async (q) => {
        await lock(q, `admission-seat:${roundId}:${classId}`);
        const seats = await state(roundId, classId, q, { quota });
        return fn(q, seats);
    });
}

module.exports = { state, pools, roundState, withSeat, capacityOf, classConfig, HOLDING_OFFER };
