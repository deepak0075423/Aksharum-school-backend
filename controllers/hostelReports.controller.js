'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hostel → Reports: one read model per report tab.
//
//  GET /hostel/admin/board/reports?report=occupancy&hostel=&from=&to=&page=&limit=
//  answers the whole screen for one tab: the six page tiles (whole scope, no
//  filters), three charts and a page of the tab's table (filters applied).
//
//  Every figure is counted the way the list screens count it — the bed state,
//  a work order's state, an incident's kind, a discipline group and a fee's
//  balance are the expressions those boards use (hostelBoards.controller _sql),
//  so a report cannot disagree with the screen it summarises.
// ─────────────────────────────────────────────────────────────────────────────
const pool = require('../db/pool');
const { dayRange } = require('../services/hostelService');
const { T, TBL, params, inScope, eq, between, studentJoin, monthStart, share } = require('../services/hostelQuery');
const { BED_STATE, bedCounts, hostelsInScope } = require('../services/hostelOverview');

const HostelAdmission = require('../models/HostelAdmission');
const HostelAttendance = require('../models/HostelAttendance');
const HostelLeave = require('../models/HostelLeave');
const HostelOutpass = require('../models/HostelOutpass');
const HostelVisitor = require('../models/HostelVisitor');
const HostelMess = require('../models/HostelMess');
const HostelMessAttendance = require('../models/HostelMessAttendance');
const HostelMessExpense = require('../models/HostelMessExpense');
const HostelFeeInvoice = require('../models/HostelFeeInvoice');
const HostelComplaint = require('../models/HostelComplaint');
const HostelMaintenance = require('../models/HostelMaintenance');
const HostelIncident = require('../models/HostelIncident');
const HostelDiscipline = require('../models/HostelDiscipline');
const AcademicYear = require('../models/AcademicYear');

/** The boards' own state expressions — loaded late, the boards load this file. */
const S = () => require('./hostelBoards.controller')._sql;

const REPORTS = ['occupancy', 'admissions', 'attendance', 'mess', 'fees', 'leave', 'visitors', 'maintenance', 'complaints', 'incidents', 'discipline', 'summary'];

/* ── small builders ───────────────────────────────────────────────────────── */
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const donut = (title, items, { center, foot, money } = {}) => ({ kind: 'donut', title, items: items.filter((i) => i.value > 0 || i.keep), center, foot, money: !!money });
const bars = (title, items, { legend, money, single, compare } = {}) => ({ kind: 'bars', title, items, legend, money: !!money, single: !!single, compare: !!compare });
/** Hostel filter plus the caller's scope, on one column. */
const scope = (col, ctx, p) => inScope(col, ctx.allowed, p) + eq(col, ctx.q.hostel, p, '::uuid');
const words = (v) => String(v || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Rows of `key → n` for one grouping. */
async function grouped(p, from, where, key, value = 'count(*)') {
    const { rows } = await pool.query(`SELECT ${key} AS "k", (${value})::float8 AS "n" ${from} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, p.list);
    return rows.map((r) => ({ k: r.k, n: num(r.n) }));
}

/** Per-hostel "part of whole" bars for every hostel in view, the empty ones too. */
function hostelBars(ctx, rows, title, legend, opts = {}) {
    const by = Object.fromEntries(rows.map((r) => [String(r.k), r]));
    const list = ctx.q.hostel ? ctx.hostels.filter((h) => h._id === String(ctx.q.hostel)) : ctx.hostels;
    return bars(title, list.map((h) => ({ label: h.name, value: num(by[h._id]?.a), total: num(by[h._id]?.b) })), { legend, ...opts });
}

/** A page of a query that selects `count(*) OVER () AS "__total"`. */
async function page(sql, p, ctx) {
    const list = [...p.list, ctx.limit, (ctx.page - 1) * ctx.limit];
    const { rows } = await pool.query(`${sql} LIMIT $${list.length - 1} OFFSET $${list.length}`, list);
    return { rows: rows.map(({ __total, ...r }) => r), total: rows[0]?.__total ?? 0 };
}

const placeOf = (r) => (r.roomNumber ? `${r.bcode ? `${r.bcode}-` : ''}${String(r.roomNumber).replace(/^room\s*/i, 'R')}` : '');

/* ═════════════════════════════════════════════════════════════════════════════
 *  Occupancy — rooms, their beds by BED_STATE (what the Dashboard counts)
 * ═════════════════════════════════════════════════════════════════════════════ */
const ROOM_TYPES = ['single', 'double', 'triple', 'four_bed', 'dormitory', 'custom'];
async function occupancy(ctx) {
    const { school, q } = ctx;
    const p = params();
    let where = `r."school" = ${p.$(school)} AND r."isActive" AND h."isActive"${scope('r."hostel"', ctx, p)}`
        + eq('r."building"', q.building, p, '::uuid') + (ROOM_TYPES.includes(q.roomType) ? eq('r."roomType"', q.roomType, p) : '');
    const { rows } = await pool.query(
        `SELECT r."_id", h."_id"::text AS "hid", h."name" AS "hostel", bl."name" AS "building", bl."code" AS "bcode", fl."name" AS "floor",
                r."roomNumber", r."roomType", r."status", bd.*
           FROM ${TBL.rooms} r
           JOIN ${TBL.hostels} h ON h."_id" = r."hostel"
           LEFT JOIN ${TBL.buildings} bl ON bl."_id" = r."building"
           LEFT JOIN ${TBL.floors} fl ON fl."_id" = r."floor"
           LEFT JOIN LATERAL (
               SELECT count(*) FILTER (WHERE s.st <> 'out')::int AS "beds",
                      count(*) FILTER (WHERE s.st = 'occupied')::int AS "occupied",
                      count(*) FILTER (WHERE s.st = 'available')::int AS "available",
                      count(*) FILTER (WHERE s.st = 'reserved')::int AS "reserved",
                      count(*) FILTER (WHERE s.st = 'maintenance')::int AS "maintenance"
                 FROM (SELECT ${BED_STATE} AS st FROM ${TBL.beds} b WHERE b."room" = r."_id" AND b."isActive") s) bd ON true
          WHERE ${where}
          ORDER BY lower(h."name"), bl."code" NULLS LAST, r."roomNumber"`, p.list);
    const state = (r) => (r.beds > 0 && r.occupied >= r.beds ? 'full' : r.occupied > 0 ? 'partial' : r.available > 0 ? 'available'
        : r.maintenance > 0 ? 'maintenance' : r.reserved > 0 ? 'reserved' : 'inactive');
    const sum = (k, list = rows) => list.reduce((s, r) => s + num(r[k]), 0);
    const beds = sum('beds'); const occ = sum('occupied');
    const byHostel = Object.values(rows.reduce((m, r) => {
        m[r.hid] = m[r.hid] || { k: r.hid, a: 0, b: 0 }; m[r.hid].a += r.occupied; m[r.hid].b += r.beds; return m;
    }, {}));
    const byType = Object.entries(rows.reduce((m, r) => { m[r.roomType || 'custom'] = (m[r.roomType || 'custom'] || 0) + r.beds; return m; }, {}));

    // The building and room-type pickers offer what is there to pick.
    const bp = params();
    const { rows: buildings } = await pool.query(
        `SELECT bl."_id", bl."name", h."name" AS "hostel" FROM ${TBL.buildings} bl JOIN ${TBL.hostels} h ON h."_id" = bl."hostel"
          WHERE bl."school" = ${bp.$(school)} AND bl."isActive"${scope('bl."hostel"', ctx, bp)} ORDER BY lower(h."name"), bl."name"`, bp.list);

    const at = (ctx.page - 1) * ctx.limit;
    return {
        charts: [
            donut('Room Occupancy Overview', [
                { key: 'occupied', label: 'Occupied', value: occ, keep: true },
                { key: 'available', label: 'Available', value: sum('available'), keep: true },
                { key: 'reserved', label: 'Reserved', value: sum('reserved'), keep: true },
                { key: 'maintenance', label: 'Maintenance', value: sum('maintenance') },
            ], { center: { value: `${share(occ, beds)}%`, label: 'Occupied' }, foot: { label: 'Total Capacity', value: beds } }),
            hostelBars(ctx, byHostel, 'Occupancy by Hostel', ['Occupied', 'Available']),
            donut('Room Type Distribution', byType.map(([k, v]) => ({ key: k, label: words(k), value: v })),
                { center: { value: beds, label: 'Total Beds' } }),
        ],
        columns: [
            { key: 'hostel', label: 'Hostel' }, { key: 'building', label: 'Building' }, { key: 'floor', label: 'Floor' },
            { key: 'room', label: 'Room No.' }, { key: 'roomType', label: 'Room Type', type: 'words' },
            { key: 'beds', label: 'Capacity', type: 'num' }, { key: 'occupied', label: 'Occupied', type: 'num' },
            { key: 'available', label: 'Available', type: 'num' }, { key: 'pct', label: 'Occupancy %', type: 'pct' },
            { key: 'state', label: 'Status', type: 'status' },
        ],
        rows: rows.slice(at, at + ctx.limit).map((r) => ({
            _id: r._id, hostel: r.hostel, building: r.building || '—', floor: r.floor || '—', room: placeOf(r), roomType: r.roomType,
            beds: r.beds, occupied: r.occupied, available: r.available, pct: share(r.occupied, r.beds), state: state(r),
        })),
        total: rows.length,
        options: {
            buildings: buildings.map((b) => ({ value: b._id, label: ctx.hostels.length > 1 ? `${b.name} · ${b.hostel}` : b.name })),
            roomTypes: ROOM_TYPES.map((t) => ({ value: t, label: words(t) })),
        },
        noDates: true,
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Admissions
 * ═════════════════════════════════════════════════════════════════════════════ */
const ADM_GROUP = `CASE
        WHEN x."status" IN ('draft', 'applied', 'pending_approval') THEN 'pending'
        WHEN x."status" = 'approved'   THEN 'approved'
        WHEN x."status" = 'completed'  THEN 'allocated'
        WHEN x."status" = 'waitlisted' THEN 'waitlisted'
        WHEN x."status" = 'rejected'   THEN 'rejected'
        ELSE 'cancelled' END`;
async function admissions(ctx) {
    const { school, q } = ctx;
    const build = (p) => ({
        from: `FROM ${T(HostelAdmission)} x LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel" ${studentJoin('st', 'x."student"')}`,
        where: `x."school" = ${p.$(school)}${scope('x."hostel"', ctx, p)}${between('COALESCE(x."appliedAt", x."createdAt")', q.from, q.to, p)}`
            + (q.status ? ` AND (${ADM_GROUP}) = ${p.$(q.status)}` : ''),
    });
    const [a, b, c, d] = [params(), params(), params(), params()].map((p) => ({ p, ...build(p) }));
    const [byGroup, byHostel, byType, table] = await Promise.all([
        grouped(a.p, a.from, a.where, ADM_GROUP),
        pool.query(`SELECT x."hostel"::text AS "k", count(*) FILTER (WHERE (${ADM_GROUP}) IN ('approved', 'allocated'))::int AS "a", count(*)::int AS "b"
                      ${b.from} WHERE ${b.where} GROUP BY 1`, b.p.list),
        grouped(c.p, c.from, c.where, `COALESCE(NULLIF(x."preferredRoomType", ''), 'any')`),
        page(`SELECT x."_id", x."applicationNumber", st."name" AS "student", stc."className" AS "class", h."name" AS "hostel", x."preferredRoomType",
                     COALESCE(x."appliedAt", x."createdAt") AS "applied", (${ADM_GROUP}) AS "state", count(*) OVER ()::int AS "__total"
                ${d.from} WHERE ${d.where} ORDER BY COALESCE(x."appliedAt", x."createdAt") DESC`, d.p, ctx),
    ]);
    const total = byGroup.reduce((s, r) => s + r.n, 0);
    return {
        charts: [
            donut('Applications by Status', byGroup.map((r) => ({ key: r.k, label: words(r.k), value: r.n })), { center: { value: total, label: 'Applications' } }),
            hostelBars(ctx, byHostel.rows, 'Approved by Hostel', ['Approved', 'Applied']),
            donut('Preferred Room Type', byType.map((r) => ({ key: r.k, label: r.k === 'any' ? 'No preference' : words(r.k), value: r.n })), { center: { value: total, label: 'Applications' } }),
        ],
        columns: [
            { key: 'applicationNumber', label: 'Application' }, { key: 'student', label: 'Student' }, { key: 'class', label: 'Class' },
            { key: 'hostel', label: 'Hostel' }, { key: 'preferredRoomType', label: 'Room Type', type: 'words' },
            { key: 'applied', label: 'Applied On', type: 'date' }, { key: 'state', label: 'Status', type: 'status' },
        ],
        ...table,
        options: { statuses: ['pending', 'approved', 'allocated', 'waitlisted', 'rejected', 'cancelled'].map((v) => ({ value: v, label: words(v) })) },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Attendance — the roll calls, and each resident's record over the period
 * ═════════════════════════════════════════════════════════════════════════════ */
const PRESENT = `x."status" IN ('present', 'late')`;
async function attendance(ctx) {
    const { school, q } = ctx;
    const build = (p) => ({
        from: `FROM ${T(HostelAttendance)} x LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"`,
        where: `x."school" = ${p.$(school)}${scope('x."hostel"', ctx, p)}${between('x."date"', q.from, q.to, p)}${eq('x."session"', q.session, p)}`,
    });
    const [a, b, c, d] = [params(), params(), params(), params()].map((p) => ({ p, ...build(p) }));
    const [byStatus, byHostel, bySession, table] = await Promise.all([
        grouped(a.p, a.from, a.where, 'x."status"'),
        pool.query(`SELECT x."hostel"::text AS "k", count(*) FILTER (WHERE ${PRESENT})::int AS "a", count(*)::int AS "b" ${b.from} WHERE ${b.where} GROUP BY 1`, b.p.list),
        grouped(c.p, c.from, c.where, 'x."session"'),
        page(`SELECT x."student" AS "_id", max(st."name") AS "student", max(stc."className") AS "class", max(h."name") AS "hostel",
                     count(*)::int AS "marked", count(*) FILTER (WHERE x."status" = 'present')::int AS "present",
                     count(*) FILTER (WHERE x."status" = 'late')::int AS "late", count(*) FILTER (WHERE x."status" = 'absent')::int AS "absent",
                     count(*) FILTER (WHERE x."status" IN ('on_leave', 'excused'))::int AS "leave",
                     round(100.0 * count(*) FILTER (WHERE ${PRESENT}) / NULLIF(count(*), 0), 1)::float8 AS "pct",
                     count(*) OVER ()::int AS "__total"
                ${d.from} ${studentJoin('st', 'x."student"')} WHERE ${d.where}
               GROUP BY x."student" ORDER BY 10 ASC NULLS LAST, 2`, d.p, ctx),
    ]);
    const marked = byStatus.reduce((s, r) => s + r.n, 0);
    const present = byStatus.filter((r) => ['present', 'late'].includes(r.k)).reduce((s, r) => s + r.n, 0);
    return {
        charts: [
            donut('Attendance Overview', byStatus.map((r) => ({ key: r.k, label: words(r.k), value: r.n })),
                { center: { value: `${share(present, marked)}%`, label: 'Present' }, foot: { label: 'Roll calls marked', value: marked } }),
            hostelBars(ctx, byHostel.rows, 'Attendance by Hostel', ['Present', 'Marked']),
            donut('By Session', bySession.map((r) => ({ key: r.k, label: words(r.k), value: r.n })), { center: { value: marked, label: 'Marked' } }),
        ],
        columns: [
            { key: 'student', label: 'Student' }, { key: 'class', label: 'Class' }, { key: 'hostel', label: 'Hostel' },
            { key: 'marked', label: 'Marked', type: 'num' }, { key: 'present', label: 'Present', type: 'num' }, { key: 'late', label: 'Late', type: 'num' },
            { key: 'absent', label: 'Absent', type: 'num' }, { key: 'leave', label: 'On Leave', type: 'num' }, { key: 'pct', label: 'Attendance %', type: 'pct' },
        ],
        ...table,
        options: { sessions: ['morning', 'evening', 'night', 'roll_call'].map((v) => ({ value: v, label: words(v) })) },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Mess — meals served, day by day, and what the kitchen spent
 * ═════════════════════════════════════════════════════════════════════════════ */
const MESS_COVERS = `(CASE WHEN jsonb_typeof(m."hostels") = 'array' THEN m."hostels" ELSE '[]'::jsonb END)`;
/** Messes the caller may see (serving any of their hostels), and serving the asked-for one. */
const messIn = (ctx, p) => (ctx.allowed === null ? '' : ` AND (jsonb_array_length(${MESS_COVERS}) = 0 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${MESS_COVERS}) v WHERE v = ANY(${p.$(ctx.allowed.map(String))}::text[])))`)
    + (ctx.q.hostel ? ` AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${MESS_COVERS}) v WHERE v = ${p.$(String(ctx.q.hostel))})` : '');
async function mess(ctx) {
    const { school, q } = ctx;
    const build = (p) => ({
        from: `FROM ${T(HostelMessAttendance)} x JOIN ${T(HostelMess)} m ON m."_id" = x."mess"`,
        where: `x."school" = ${p.$(school)}${messIn(ctx, p)}${between('x."date"', q.from, q.to, p)}${eq('x."meal"', q.meal, p)}`,
    });
    const ex = (p) => ({
        from: `FROM ${T(HostelMessExpense)} e JOIN ${T(HostelMess)} m ON m."_id" = e."mess"`,
        where: `e."school" = ${p.$(school)}${messIn(ctx, p)}${between('e."date"', q.from, q.to, p)}`,
    });
    const [a, b, d] = [params(), params(), params()].map((p) => ({ p, ...build(p) }));
    const e1 = params(); const e = ex(e1);
    const DAY = `to_char(x."date" AT TIME ZONE ${d.p.$(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}, 'YYYY-MM-DD')`;
    const [byStatus, byMess, byCat, table] = await Promise.all([
        grouped(a.p, a.from, a.where, 'x."status"'),
        pool.query(`SELECT m."name" AS "label", count(*) FILTER (WHERE x."status" IN ('taken', 'guest'))::int AS "a", count(*)::int AS "b"
                      ${b.from} WHERE ${b.where} GROUP BY 1 ORDER BY 1`, b.p.list),
        grouped(e1, e.from, e.where, 'e."category"', 'sum(e."amount")'),
        page(`SELECT ${DAY} AS "day",
                     count(*) FILTER (WHERE x."meal" = 'breakfast' AND x."status" IN ('taken', 'guest'))::int AS "breakfast",
                     count(*) FILTER (WHERE x."meal" = 'lunch' AND x."status" IN ('taken', 'guest'))::int AS "lunch",
                     count(*) FILTER (WHERE x."meal" = 'snacks' AND x."status" IN ('taken', 'guest'))::int AS "snacks",
                     count(*) FILTER (WHERE x."meal" = 'dinner' AND x."status" IN ('taken', 'guest'))::int AS "dinner",
                     COALESCE(sum(x."guestCount"), 0)::int AS "guests", count(*) FILTER (WHERE x."status" = 'skipped')::int AS "skipped",
                     count(*) OVER ()::int AS "__total"
                ${d.from} WHERE ${d.where} GROUP BY 1 ORDER BY 1 DESC`, d.p, ctx),
    ]);
    // The day's spending, for the days on this page.
    if (table.rows.length) {
        const sp = params(); const s2 = ex(sp);
        const zone = sp.$(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
        const days = sp.$(table.rows.map((r) => r.day));
        const { rows } = await pool.query(`SELECT to_char(e."date" AT TIME ZONE ${zone}, 'YYYY-MM-DD') AS "day", sum(e."amount")::float8 AS "n"
                                             ${s2.from} WHERE ${s2.where} AND to_char(e."date" AT TIME ZONE ${zone}, 'YYYY-MM-DD') = ANY(${days}::text[]) GROUP BY 1`, sp.list);
        const spent = Object.fromEntries(rows.map((r) => [r.day, num(r.n)]));
        table.rows.forEach((r) => { r.expense = spent[r.day] || 0; });
    }
    const marked = byStatus.reduce((s, r) => s + r.n, 0);
    const served = byStatus.filter((r) => ['taken', 'guest'].includes(r.k)).reduce((s, r) => s + r.n, 0);
    const spentAll = byCat.reduce((s, r) => s + r.n, 0);
    return {
        charts: [
            donut('Meals Overview', byStatus.map((r) => ({ key: r.k, label: words(r.k), value: r.n })),
                { center: { value: `${share(served, marked)}%`, label: 'Served' }, foot: { label: 'Meals marked', value: marked } }),
            bars('Meals Served by Mess', byMess.rows.map((r) => ({ label: r.label, value: r.a, total: r.b })), { legend: ['Served', 'Marked'] }),
            donut('Mess Expenses', byCat.map((r) => ({ key: r.k, label: words(r.k), value: r.n })), { center: { value: spentAll, label: 'Spent' }, money: true }),
        ],
        columns: [
            { key: 'day', label: 'Date', type: 'date' }, { key: 'breakfast', label: 'Breakfast', type: 'num' }, { key: 'lunch', label: 'Lunch', type: 'num' },
            { key: 'snacks', label: 'Snacks', type: 'num' }, { key: 'dinner', label: 'Dinner', type: 'num' }, { key: 'guests', label: 'Guests', type: 'num' },
            { key: 'skipped', label: 'Skipped', type: 'num' }, { key: 'expense', label: 'Spent', type: 'money' },
        ],
        ...table,
        options: { meals: ['breakfast', 'lunch', 'snacks', 'dinner', 'special'].map((v) => ({ value: v, label: words(v) })) },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Fees — billed, collected (net of refunds), still owed
 * ═════════════════════════════════════════════════════════════════════════════ */
const FEE_TYPES = ['admission', 'monthly', 'quarterly', 'annual', 'mess', 'laundry', 'electricity', 'security_deposit', 'fine', 'damage', 'other'];
async function fees(ctx) {
    const { school, q } = ctx;
    const { BALANCE, OWED } = S();
    const build = (p) => ({
        from: `FROM ${T(HostelFeeInvoice)} x LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"`,
        where: `x."school" = ${p.$(school)} AND x."status" <> 'cancelled'${scope('x."hostel"', ctx, p)}${between('x."createdAt"', q.from, q.to, p)}`
            + (q.feeType ? eq('x."feeType"', q.feeType, p) : ''),
    });
    const [a, b, c, d] = [params(), params(), params(), params()].map((p) => ({ p, ...build(p) }));
    const [{ rows: [t] }, byHostel, byType, table] = await Promise.all([
        pool.query(`SELECT COALESCE(sum(x."netAmount"), 0)::float8 AS "billed", COALESCE(sum(x."paidAmount"), 0)::float8 AS "paid",
                           COALESCE(sum(x."refundedAmount"), 0)::float8 AS "refunded",
                           COALESCE(sum(${BALANCE}) FILTER (WHERE ${OWED}), 0)::float8 AS "owed" ${a.from} WHERE ${a.where}`, a.p.list),
        pool.query(`SELECT x."hostel"::text AS "k", GREATEST(COALESCE(sum(x."paidAmount"), 0) - COALESCE(sum(x."refundedAmount"), 0), 0)::float8 AS "a",
                           COALESCE(sum(x."netAmount"), 0)::float8 AS "b" ${b.from} WHERE ${b.where} GROUP BY 1`, b.p.list),
        grouped(c.p, c.from, c.where, 'x."feeType"', 'sum(x."netAmount")'),
        page(`SELECT x."_id", x."invoiceNumber", st."name" AS "student", h."name" AS "hostel", x."feeType",
                     COALESCE(x."period"->>'label', '') AS "period", x."netAmount"::float8 AS "net", x."paidAmount"::float8 AS "paid",
                     (${BALANCE})::float8 AS "balance", x."dueDate" AS "due", x."status" AS "state", count(*) OVER ()::int AS "__total"
                ${d.from} ${studentJoin('st', 'x."student"')} WHERE ${d.where} ORDER BY x."createdAt" DESC`, d.p, ctx),
    ]);
    const collected = Math.max(0, t.paid - t.refunded);
    return {
        charts: [
            donut('Collection Overview', [
                { key: 'collected', label: 'Collected', value: collected, keep: true },
                { key: 'outstanding', label: 'Outstanding', value: t.owed, keep: true },
                { key: 'refunded', label: 'Refunded', value: t.refunded },
            ], { center: { value: `${share(collected, t.billed)}%`, label: 'Collected' }, foot: { label: 'Total billed', value: t.billed }, money: true }),
            hostelBars(ctx, byHostel.rows, 'Collection by Hostel', ['Collected', 'Billed'], { money: true }),
            donut('Billed by Fee Type', byType.map((r) => ({ key: r.k, label: words(r.k), value: r.n })), { center: { value: t.billed, label: 'Billed' }, money: true }),
        ],
        columns: [
            { key: 'invoiceNumber', label: 'Invoice' }, { key: 'student', label: 'Student' }, { key: 'hostel', label: 'Hostel' },
            { key: 'feeType', label: 'Fee Type', type: 'words' }, { key: 'period', label: 'Period' }, { key: 'net', label: 'Amount', type: 'money' },
            { key: 'paid', label: 'Paid', type: 'money' }, { key: 'balance', label: 'Balance', type: 'money' }, { key: 'due', label: 'Due', type: 'date' },
            { key: 'state', label: 'Status', type: 'status' },
        ],
        ...table,
        options: { feeTypes: FEE_TYPES.map((v) => ({ value: v, label: words(v) })) },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Leave & Outpass — both kinds of time away, in one list
 * ═════════════════════════════════════════════════════════════════════════════ */
const AWAY_GROUP = `CASE
        WHEN u."status" IN ('pending', 'parent_approved') THEN 'pending'
        WHEN u."status" = 'approved' THEN 'approved'
        WHEN u."status" = 'active'   THEN 'away'
        WHEN u."status" = 'returned' THEN 'returned'
        WHEN u."status" = 'overdue'  THEN 'overdue'
        ELSE 'closed' END`;
function awayUnion(ctx, p) {
    const { school, q } = ctx;
    const parts = [];
    if (q.kind !== 'outpass') {
        parts.push(`SELECT 'leave' AS "kind", x."_id", x."leaveNumber" AS "number", x."student", x."hostel", x."leaveType" AS "type",
                           x."fromDate" AS "start", x."toDate" AS "until", x."returnedAt" AS "back", 0 AS "late", x."status"
                      FROM ${T(HostelLeave)} x
                     WHERE x."school" = ${p.$(school)}${scope('x."hostel"', ctx, p)}${between('x."fromDate"', q.from, q.to, p)}`);
    }
    if (q.kind !== 'leave') {
        parts.push(`SELECT 'outpass', x."_id", x."outpassNumber", x."student", x."hostel", x."outpassType",
                           COALESCE(x."actualDepartureAt", x."departureDate"), x."expectedReturnAt", x."actualReturnAt",
                           COALESCE(x."lateReturnMinutes", 0), x."status"
                      FROM ${T(HostelOutpass)} x
                     WHERE x."school" = ${p.$(school)}${scope('x."hostel"', ctx, p)}${between('COALESCE(x."actualDepartureAt", x."departureDate")', q.from, q.to, p)}`);
    }
    return `(${parts.join(' UNION ALL ')}) u`;
}
async function leave(ctx) {
    const [a, b, c, d] = [params(), params(), params(), params()];
    const [byGroup, byHostel, byType, table] = await Promise.all([
        grouped(a, `FROM ${awayUnion(ctx, a)}`, 'true', AWAY_GROUP),
        pool.query(`SELECT u."hostel"::text AS "k", count(*) FILTER (WHERE u."status" IN ('returned', 'approved', 'active'))::int AS "a", count(*)::int AS "b"
                      FROM ${awayUnion(ctx, b)} GROUP BY 1`, b.list),
        grouped(c, `FROM ${awayUnion(ctx, c)}`, 'true', `u."kind" || ':' || COALESCE(u."type", 'other')`),
        page(`SELECT u."_id", u."kind", u."number", st."name" AS "student", h."name" AS "hostel", u."type", u."start", u."until", u."back",
                     u."late", (${AWAY_GROUP}) AS "state", count(*) OVER ()::int AS "__total"
                FROM ${awayUnion(ctx, d)} LEFT JOIN ${TBL.hostels} h ON h."_id" = u."hostel" ${studentJoin('st', 'u."student"')}
               ORDER BY u."start" DESC NULLS LAST`, d, ctx),
    ]);
    const total = byGroup.reduce((s, r) => s + r.n, 0);
    return {
        charts: [
            donut('Requests by Status', byGroup.map((r) => ({ key: r.k, label: words(r.k), value: r.n })), { center: { value: total, label: 'Requests' } }),
            hostelBars(ctx, byHostel.rows, 'Granted by Hostel', ['Granted', 'Requested']),
            donut('By Type', byType.slice(0, 7).map((r) => { const [k, t] = String(r.k).split(':'); return { key: r.k, label: `${words(k)} · ${words(t)}`, value: r.n }; }),
                { center: { value: total, label: 'Requests' } }),
        ],
        columns: [
            { key: 'kind', label: 'Kind', type: 'words' }, { key: 'number', label: 'No.' }, { key: 'student', label: 'Student' },
            { key: 'hostel', label: 'Hostel' }, { key: 'type', label: 'Type', type: 'words' }, { key: 'start', label: 'From', type: 'datetime' },
            { key: 'until', label: 'Until', type: 'datetime' }, { key: 'back', label: 'Returned', type: 'datetime' },
            { key: 'late', label: 'Late (min)', type: 'num' }, { key: 'state', label: 'Status', type: 'status' },
        ],
        ...table,
        options: { kinds: [{ value: 'leave', label: 'Leave only' }, { value: 'outpass', label: 'Outpasses only' }] },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Visitors
 * ═════════════════════════════════════════════════════════════════════════════ */
async function visitors(ctx) {
    const { school, q } = ctx;
    const { VISIT_AT } = S();
    const build = (p) => ({
        from: `FROM ${T(HostelVisitor)} x LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"`,
        where: `x."school" = ${p.$(school)} AND NOT COALESCE(x."isTemplate", false)${scope('x."hostel"', ctx, p)}${between(VISIT_AT, q.from, q.to, p)}`
            + eq('x."status"', q.status, p),
    });
    const [a, b, c, d] = [params(), params(), params(), params()].map((p) => ({ p, ...build(p) }));
    const [byStatus, byHostel, byRel, table] = await Promise.all([
        grouped(a.p, a.from, a.where, 'x."status"'),
        pool.query(`SELECT x."hostel"::text AS "k", count(*) FILTER (WHERE x."status" IN ('checked_in', 'checked_out'))::int AS "a", count(*)::int AS "b"
                      ${b.from} WHERE ${b.where} GROUP BY 1`, b.p.list),
        grouped(c.p, c.from, c.where, `COALESCE(NULLIF(lower(x."relationship"), ''), 'other')`),
        page(`SELECT x."_id", x."passNumber", x."visitorName", x."relationship", st."name" AS "student", h."name" AS "hostel", x."purpose",
                     x."entryTime" AS "entry", x."exitTime" AS "exit", x."status" AS "state", count(*) OVER ()::int AS "__total"
                ${d.from} ${studentJoin('st', 'x."student"')} WHERE ${d.where} ORDER BY ${VISIT_AT} DESC`, d.p, ctx),
    ]);
    const total = byStatus.reduce((s, r) => s + r.n, 0);
    const top = byRel.slice(0, 5); const rest = byRel.slice(5).reduce((s, r) => s + r.n, 0);
    return {
        charts: [
            donut('Visits by Status', byStatus.map((r) => ({ key: r.k, label: words(r.k), value: r.n })), { center: { value: total, label: 'Visits' } }),
            hostelBars(ctx, byHostel.rows, 'Visits by Hostel', ['Came in', 'Booked']),
            donut('Who Visits', [...top.map((r) => ({ key: r.k, label: words(r.k), value: r.n })), ...(rest ? [{ key: 'more', label: 'Others', value: rest }] : [])],
                { center: { value: total, label: 'Visits' } }),
        ],
        columns: [
            { key: 'passNumber', label: 'Pass' }, { key: 'visitorName', label: 'Visitor' }, { key: 'relationship', label: 'Relation', type: 'words' },
            { key: 'student', label: 'Student' }, { key: 'hostel', label: 'Hostel' }, { key: 'purpose', label: 'Purpose' },
            { key: 'entry', label: 'In', type: 'datetime' }, { key: 'exit', label: 'Out', type: 'datetime' }, { key: 'state', label: 'Status', type: 'status' },
        ],
        ...table,
        options: { statuses: ['pending', 'approved', 'checked_in', 'checked_out', 'rejected', 'cancelled'].map((v) => ({ value: v, label: words(v) })) },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Maintenance — work orders by the state the Maintenance screen gives them
 * ═════════════════════════════════════════════════════════════════════════════ */
async function maintenance(ctx) {
    const { school, q } = ctx;
    const today = dayRange().start;
    // Only the queries that judge a state carry the date it is judged by —
    // node-pg refuses a parameter nothing refers to.
    const build = (p, judged) => {
        const STATE = judged ? S().maintState(p.$(today)) : null;
        return {
            STATE,
            from: `FROM ${T(HostelMaintenance)} x LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel" LEFT JOIN ${TBL.rooms} rm ON rm."_id" = x."room"
                   LEFT JOIN ${TBL.buildings} bl ON bl."_id" = COALESCE(x."building", rm."building")`,
            where: `x."school" = ${p.$(school)}${scope('x."hostel"', ctx, p)}${between('x."createdAt"', q.from, q.to, p)}` + eq('x."category"', q.category, p),
        };
    };
    const [a, b, c, d] = [params(), params(), params(), params()].map((p, i) => ({ p, ...build(p, i === 0 || i === 3) }));
    const [byState, byHostel, byCat, table] = await Promise.all([
        grouped(a.p, a.from, a.where, `(${a.STATE})`),
        pool.query(`SELECT x."hostel"::text AS "k", count(*) FILTER (WHERE x."status" = 'completed')::int AS "a",
                           count(*) FILTER (WHERE x."status" <> 'cancelled')::int AS "b" ${b.from} WHERE ${b.where} GROUP BY 1`, b.p.list),
        grouped(c.p, c.from, c.where, 'x."category"'),
        page(`SELECT x."_id", x."requestNumber", COALESCE(NULLIF(x."title", ''), x."description") AS "title", h."name" AS "hostel",
                     rm."roomNumber", bl."code" AS "bcode", x."category", x."priority", x."createdAt" AS "raised", x."completedAt" AS "done",
                     COALESCE(x."actualCost", 0)::float8 AS "cost", (${d.STATE}) AS "state", count(*) OVER ()::int AS "__total"
                ${d.from} WHERE ${d.where} ORDER BY x."createdAt" DESC`, d.p, ctx),
    ]);
    table.rows.forEach((r) => { r.room = placeOf(r) || '—'; });
    const total = byState.reduce((s, r) => s + r.n, 0);
    return {
        charts: [
            donut('Work Orders by Status', byState.map((r) => ({ key: r.k, label: r.k === 'progress' ? 'In progress' : words(r.k), value: r.n })), { center: { value: total, label: 'Work orders' } }),
            hostelBars(ctx, byHostel.rows, 'Completed by Hostel', ['Completed', 'Raised']),
            donut('By Category', byCat.slice(0, 7).map((r) => ({ key: r.k, label: words(r.k), value: r.n })), { center: { value: total, label: 'Work orders' } }),
        ],
        columns: [
            { key: 'requestNumber', label: 'Work Order' }, { key: 'title', label: 'Title', type: 'clip' }, { key: 'hostel', label: 'Hostel' },
            { key: 'room', label: 'Room' }, { key: 'category', label: 'Category', type: 'words' }, { key: 'priority', label: 'Priority', type: 'words' },
            { key: 'raised', label: 'Raised', type: 'date' }, { key: 'done', label: 'Completed', type: 'date' }, { key: 'cost', label: 'Cost', type: 'money' },
            { key: 'state', label: 'Status', type: 'status' },
        ],
        ...table,
        options: { categories: ['electrical', 'plumbing', 'furniture', 'fan', 'ac', 'internet', 'cleaning', 'room', 'bathroom', 'common_area', 'other'].map((v) => ({ value: v, label: words(v) })) },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Complaints
 * ═════════════════════════════════════════════════════════════════════════════ */
async function complaints(ctx) {
    const { school, q } = ctx;
    const GROUP = `CASE WHEN ${S().COMPLAINT_OVERDUE} THEN 'overdue'
            WHEN x."status" IN ('open', 'assigned') THEN 'open' WHEN x."status" = 'in_progress' THEN 'progress'
            WHEN x."status" = 'reopened' THEN 'reopened' WHEN x."status" IN ('resolved', 'closed') THEN 'resolved' ELSE 'rejected' END`;
    const build = (p) => ({
        from: `FROM ${T(HostelComplaint)} x LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"`,
        where: `x."school" = ${p.$(school)}${scope('x."hostel"', ctx, p)}${between('x."createdAt"', q.from, q.to, p)}` + eq('x."category"', q.category, p),
    });
    const [a, b, c, d] = [params(), params(), params(), params()].map((p) => ({ p, ...build(p) }));
    const [byGroup, byHostel, byCat, table] = await Promise.all([
        grouped(a.p, a.from, a.where, GROUP),
        pool.query(`SELECT x."hostel"::text AS "k", count(*) FILTER (WHERE x."status" IN ('resolved', 'closed'))::int AS "a", count(*)::int AS "b"
                      ${b.from} WHERE ${b.where} GROUP BY 1`, b.p.list),
        grouped(c.p, c.from, c.where, 'x."category"'),
        page(`SELECT x."_id", x."ticketNumber", COALESCE(NULLIF(x."subject", ''), x."description") AS "subject",
                     COALESCE(st."name", rb."name") AS "raisedBy", h."name" AS "hostel", x."category", x."priority",
                     x."createdAt" AS "raised", x."resolutionDate" AS "resolved",
                     CASE WHEN x."resolutionDate" IS NOT NULL THEN round(extract(epoch FROM x."resolutionDate" - x."createdAt") / 3600)::int END AS "hours",
                     (${GROUP}) AS "state", count(*) OVER ()::int AS "__total"
                ${d.from} ${studentJoin('st', 'x."student"')} LEFT JOIN ${TBL.users} rb ON rb."_id" = x."raisedBy"
               WHERE ${d.where} ORDER BY x."createdAt" DESC`, d.p, ctx),
    ]);
    const total = byGroup.reduce((s, r) => s + r.n, 0);
    return {
        charts: [
            donut('Complaints by Status', byGroup.map((r) => ({ key: r.k, label: r.k === 'progress' ? 'In progress' : words(r.k), value: r.n })), { center: { value: total, label: 'Complaints' } }),
            hostelBars(ctx, byHostel.rows, 'Resolved by Hostel', ['Resolved', 'Raised']),
            donut('By Category', byCat.slice(0, 7).map((r) => ({ key: r.k, label: words(r.k), value: r.n })), { center: { value: total, label: 'Complaints' } }),
        ],
        columns: [
            { key: 'ticketNumber', label: 'Ticket' }, { key: 'subject', label: 'Subject', type: 'clip' }, { key: 'raisedBy', label: 'Raised By' },
            { key: 'hostel', label: 'Hostel' }, { key: 'category', label: 'Category', type: 'words' }, { key: 'priority', label: 'Priority', type: 'words' },
            { key: 'raised', label: 'Raised', type: 'date' }, { key: 'resolved', label: 'Resolved', type: 'date' }, { key: 'hours', label: 'Hours', type: 'num' },
            { key: 'state', label: 'Status', type: 'status' },
        ],
        ...table,
        options: { categories: ['room', 'mess', 'cleaning', 'security', 'maintenance', 'staff', 'food', 'facilities', 'internet', 'other'].map((v) => ({ value: v, label: words(v) })) },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Incidents & Medical
 * ═════════════════════════════════════════════════════════════════════════════ */
async function incidents(ctx) {
    const { school, q } = ctx;
    const KIND = S().INCIDENT_KIND;
    const build = (p) => ({
        from: `FROM ${T(HostelIncident)} x LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"`,
        where: `x."school" = ${p.$(school)}${scope('x."hostel"', ctx, p)}${between('x."date"', q.from, q.to, p)}`
            + (['incident', 'medical', 'emergency'].includes(q.kind) ? ` AND (${KIND}) = ${p.$(q.kind)}` : ''),
    });
    const [a, b, c, d] = [params(), params(), params(), params()].map((p) => ({ p, ...build(p) }));
    const [byKind, byHostel, bySev, table] = await Promise.all([
        grouped(a.p, a.from, a.where, `(${KIND})`),
        pool.query(`SELECT x."hostel"::text AS "k", count(*) FILTER (WHERE x."status" IN ('resolved', 'closed'))::int AS "a", count(*)::int AS "b"
                      ${b.from} WHERE ${b.where} GROUP BY 1`, b.p.list),
        grouped(c.p, c.from, c.where, 'x."severity"'),
        page(`SELECT x."_id", x."incidentNumber", x."date", COALESCE(NULLIF(x."title", ''), split_part(x."description", '. ', 1)) AS "title",
                     (${KIND}) AS "kind", st."name" AS "student", h."name" AS "hostel", x."severity", x."status" AS "state", count(*) OVER ()::int AS "__total"
                ${d.from} ${studentJoin('st', 'x."student"')} WHERE ${d.where} ORDER BY x."date" DESC`, d.p, ctx),
    ]);
    const total = byKind.reduce((s, r) => s + r.n, 0);
    const order = ['critical', 'high', 'medium', 'low'];
    return {
        charts: [
            donut('Records by Kind', byKind.map((r) => ({ key: r.k, label: { incident: 'Incidents', medical: 'Medical cases', emergency: 'Emergencies' }[r.k] || words(r.k), value: r.n })), { center: { value: total, label: 'Records' } }),
            hostelBars(ctx, byHostel.rows, 'Closed by Hostel', ['Resolved', 'Reported']),
            donut('By Severity', bySev.sort((x, y) => order.indexOf(x.k) - order.indexOf(y.k)).map((r) => ({ key: r.k, label: words(r.k), value: r.n })), { center: { value: total, label: 'Records' } }),
        ],
        columns: [
            { key: 'incidentNumber', label: 'No.' }, { key: 'date', label: 'Date', type: 'datetime' }, { key: 'title', label: 'Title', type: 'clip' },
            { key: 'kind', label: 'Kind', type: 'words' }, { key: 'student', label: 'Student' }, { key: 'hostel', label: 'Hostel' },
            { key: 'severity', label: 'Severity', type: 'words' }, { key: 'state', label: 'Status', type: 'status' },
        ],
        ...table,
        options: { kinds: ['incident', 'medical', 'emergency'].map((v) => ({ value: v, label: words(v) })) },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Discipline
 * ═════════════════════════════════════════════════════════════════════════════ */
async function discipline(ctx) {
    const { school, q } = ctx;
    const GROUP = S().DISC_GROUP;
    const build = (p) => ({
        from: `FROM ${T(HostelDiscipline)} x LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"`,
        where: `x."school" = ${p.$(school)}${scope('x."hostel"', ctx, p)}${between('x."date"', q.from, q.to, p)}`
            + (['warning', 'fine', 'escalation'].includes(q.group) ? ` AND (${GROUP}) = ${p.$(q.group)}` : ''),
    });
    const [a, b, c, d] = [params(), params(), params(), params()].map((p) => ({ p, ...build(p) }));
    const [byGroup, byHostel, byViolation, table] = await Promise.all([
        grouped(a.p, a.from, a.where, `(${GROUP})`),
        pool.query(`SELECT x."hostel"::text AS "k", count(*) FILTER (WHERE x."status" = 'served')::int AS "a", count(*)::int AS "b"
                      ${b.from} WHERE ${b.where} GROUP BY 1`, b.p.list),
        grouped(c.p, c.from, c.where, 'x."violationType"'),
        page(`SELECT x."_id", x."actionNumber", x."date", st."name" AS "student", h."name" AS "hostel", x."violation", x."actionType",
                     x."severity", COALESCE(x."fineAmount", 0)::float8 AS "fine", CASE WHEN x."isRepeatOffence" THEN 'Yes' ELSE '' END AS "repeat",
                     x."status" AS "state", count(*) OVER ()::int AS "__total"
                ${d.from} ${studentJoin('st', 'x."student"')} WHERE ${d.where} ORDER BY x."date" DESC`, d.p, ctx),
    ]);
    const total = byGroup.reduce((s, r) => s + r.n, 0);
    return {
        charts: [
            donut('Actions by Kind', byGroup.map((r) => ({ key: r.k, label: `${words(r.k)}s`, value: r.n })), { center: { value: total, label: 'Actions' } }),
            hostelBars(ctx, byHostel.rows, 'Resolved by Hostel', ['Resolved', 'Issued']),
            donut('By Violation', byViolation.slice(0, 7).map((r) => ({ key: r.k, label: words(r.k), value: r.n })), { center: { value: total, label: 'Actions' } }),
        ],
        columns: [
            { key: 'actionNumber', label: 'No.' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'student', label: 'Student' },
            { key: 'hostel', label: 'Hostel' }, { key: 'violation', label: 'Reason', type: 'clip' }, { key: 'actionType', label: 'Action', type: 'words' },
            { key: 'severity', label: 'Severity', type: 'words' }, { key: 'fine', label: 'Fine', type: 'money' }, { key: 'repeat', label: 'Repeat' },
            { key: 'state', label: 'Status', type: 'status' },
        ],
        ...table,
        options: { groups: ['warning', 'fine', 'escalation'].map((v) => ({ value: v, label: `${words(v)}s` })) },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Summary — the period against the one before it
 * ═════════════════════════════════════════════════════════════════════════════ */
async function periodFigures(ctx, start, end) {
    const { school } = ctx;
    const { PAYMENTS, PAID_AT, PAID_AMOUNT } = S();
    const one = async (Model, col, extra = '', value = 'count(*)', joins = '') => {
        const p = params();
        const { rows: [r] } = await pool.query(
            `SELECT COALESCE((${value}), 0)::float8 AS "n" FROM ${T(Model)} x ${joins}
              WHERE x."school" = ${p.$(school)}${scope('x."hostel"', ctx, p)} AND ${col} >= ${p.$(start)} AND ${col} < ${p.$(end)}${extra}`, p.list);
        return num(r?.n);
    };
    const mp = params();
    const messSpent = pool.query(
        `SELECT COALESCE(sum(e."amount"), 0)::float8 AS "n" FROM ${T(HostelMessExpense)} e JOIN ${T(HostelMess)} m ON m."_id" = e."mess"
          WHERE e."school" = ${mp.$(school)}${messIn(ctx, mp)} AND e."date" >= ${mp.$(start)} AND e."date" < ${mp.$(end)}`, mp.list).then((r) => num(r.rows[0]?.n));
    const [admitted, allocated, checkouts, marked, present, leaves, outpasses, visits, raised, resolved, incidentsN, actions, billed, paid, refunded, repairs, spent] = await Promise.all([
        one(HostelAdmission, 'COALESCE(x."appliedAt", x."createdAt")'),
        one(require('../models/HostelAllocation'), 'x."createdAt"'),
        one(require('../models/HostelAllocation'), 'x."vacatedDate"'),
        one(HostelAttendance, 'x."date"'),
        one(HostelAttendance, 'x."date"', ` AND ${PRESENT}`),
        one(HostelLeave, 'x."fromDate"'),
        one(HostelOutpass, 'COALESCE(x."actualDepartureAt", x."departureDate")'),
        one(HostelVisitor, S().VISIT_AT, ' AND NOT COALESCE(x."isTemplate", false)'),
        one(HostelComplaint, 'x."createdAt"'),
        one(HostelComplaint, 'x."resolutionDate"'),
        one(HostelIncident, 'x."date"'),
        one(HostelDiscipline, 'x."date"'),
        one(HostelFeeInvoice, 'x."createdAt"', ` AND x."status" <> 'cancelled'`, 'sum(x."netAmount")'),
        one(HostelFeeInvoice, PAID_AT, '', `sum(${PAID_AMOUNT})`, PAYMENTS),
        one(HostelFeeInvoice, 'x."refundedAt"', '', 'sum(x."refundedAmount")'),
        one(HostelMaintenance, 'x."completedAt"', ` AND x."status" = 'completed'`, 'sum(x."actualCost")'),
        messSpent,
    ]);
    return {
        // No roll calls is no figure, not 0% present.
        admitted, allocated, checkouts, marked, presentPct: marked ? share(present, marked) : null, leaves, outpasses, visits, raised, resolved,
        incidents: incidentsN, actions, billed, collected: Math.max(0, paid - refunded), repairs, spent,
    };
}
async function summary(ctx) {
    const { q, school } = ctx;
    const end = q.to ? dayRange(q.to).end : new Date();
    const start = q.from ? dayRange(q.from).start : monthStart(0);
    const span = Math.max(864e5, end - start);
    const prevStart = new Date(start.getTime() - span);
    const [now, before, beds] = await Promise.all([
        periodFigures(ctx, start, end), periodFigures(ctx, prevStart, start),
        bedCounts(school, ctx.q.hostel ? [String(ctx.q.hostel)] : ctx.hostels.map((h) => h._id)),
    ]);
    const M = [
        ['admitted', 'New applications'], ['allocated', 'Beds allotted'], ['checkouts', 'Checkouts'], ['marked', 'Roll calls marked'],
        ['presentPct', 'Attendance — present %', 'pct'], ['leaves', 'Leave requests'], ['outpasses', 'Outpasses'], ['visits', 'Visitors'],
        ['raised', 'Complaints raised'], ['resolved', 'Complaints resolved'], ['incidents', 'Incidents & medical cases'], ['actions', 'Disciplinary actions'],
        ['billed', 'Fees billed', 'money'], ['collected', 'Fees collected (net of refunds)', 'money'], ['spent', 'Mess spending', 'money'],
        ['repairs', 'Repair costs', 'money'],
    ];
    const rows = M.map(([k, label, type]) => ({
        _id: k, metric: label, now: now[k], before: before[k], kind: type || 'num',
        change: before[k] && now[k] != null ? Math.round(((now[k] - before[k]) / before[k]) * 1000) / 10 : null,
    }));
    const at = (ctx.page - 1) * ctx.limit;
    return {
        charts: [
            donut('Beds Right Now', [
                { key: 'occupied', label: 'Occupied', value: beds.occupied, keep: true }, { key: 'available', label: 'Available', value: beds.available, keep: true },
                { key: 'reserved', label: 'Reserved', value: beds.reserved }, { key: 'maintenance', label: 'Maintenance', value: beds.maintenance },
            ], { center: { value: `${share(beds.occupied, beds.total)}%`, label: 'Occupied' }, foot: { label: 'Total Capacity', value: beds.total } }),
            bars('This Period against the Last', [
                { label: 'Applications', value: now.admitted, total: Math.max(now.admitted, before.admitted), before: before.admitted },
                { label: 'Complaints', value: now.raised, total: Math.max(now.raised, before.raised), before: before.raised },
                { label: 'Incidents', value: now.incidents, total: Math.max(now.incidents, before.incidents), before: before.incidents },
                { label: 'Visitors', value: now.visits, total: Math.max(now.visits, before.visits), before: before.visits },
            ], { legend: ['This period', 'Previous period'], compare: true }),
            donut('Money In and Out', [
                { key: 'collected', label: 'Collected', value: now.collected }, { key: 'spent', label: 'Mess', value: now.spent },
                { key: 'repairs', label: 'Repairs', value: now.repairs },
            ], { center: { value: now.collected - now.spent - now.repairs, label: 'Net' }, money: true }),
        ],
        columns: [
            { key: 'metric', label: 'Measure' }, { key: 'now', label: 'This Period', type: 'metric' },
            { key: 'before', label: 'Previous Period', type: 'metric' }, { key: 'change', label: 'Change', type: 'change' },
        ],
        rows: rows.slice(at, at + ctx.limit),
        total: rows.length,
        period: { from: start, to: end, prevFrom: prevStart },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  The page tiles — whole scope, no filters
 * ═════════════════════════════════════════════════════════════════════════════ */
async function tiles(ctx) {
    const { school } = ctx;
    const ids = ctx.hostels.map((h) => h._id);
    const { PAYMENTS, PAID_AT, PAID_AMOUNT, maintState } = S();
    const p = params(); const f = params(); const m = params();
    const { rows: [yr] } = await pool.query(
        `SELECT "startDate", "yearName" FROM ${T(AcademicYear)} WHERE "school" = $1 AND "status" = 'active' ORDER BY "startDate" DESC NULLS LAST LIMIT 1`, [String(school)]);
    const yearStart = yr?.startDate && new Date(yr.startDate) <= new Date() ? new Date(yr.startDate) : monthStart(11);
    const STATE = maintState(m.$(dayRange().start));
    const [beds, { rows: [res] }, { rows: [fee] }, { rows: [wo] }] = await Promise.all([
        bedCounts(school, ids),
        pool.query(`SELECT count(*) FILTER (WHERE a."status" = 'active')::int AS "now",
                           count(*) FILTER (WHERE a."status" = 'active' AND COALESCE(a."fromDate", a."createdAt") >= ${p.$(monthStart(0))})::int AS "joined"
                      FROM ${TBL.allocations} a WHERE a."school" = ${p.$(school)}${inScope('a."hostel"', ctx.allowed, p)}`, p.list),
        pool.query(`SELECT COALESCE(sum(${PAID_AMOUNT}) FILTER (WHERE ${PAID_AT} >= ${f.$(yearStart)}), 0)::float8 AS "paid",
                           (SELECT COALESCE(sum(r."refundedAmount"), 0) FROM ${T(HostelFeeInvoice)} r
                             WHERE r."school" = ${f.$(school)} AND r."refundedAt" >= ${f.$(yearStart)}${inScope('r."hostel"', ctx.allowed, f)})::float8 AS "refunded"
                      FROM ${T(HostelFeeInvoice)} x ${PAYMENTS}
                     WHERE x."school" = ${f.$(school)}${inScope('x."hostel"', ctx.allowed, f)}`, f.list),
        pool.query(`SELECT count(*) FILTER (WHERE x."status" <> 'cancelled' AND x."createdAt" >= ${m.$(yearStart)})::int AS "raised",
                           count(*) FILTER (WHERE (${STATE}) NOT IN ('completed', 'cancelled'))::int AS "pending"
                      FROM ${T(HostelMaintenance)} x WHERE x."school" = ${m.$(school)}${inScope('x."hostel"', ctx.allowed, m)}`, m.list),
    ]);
    const vacant = Math.max(0, beds.total - beds.occupied);
    return {
        capacity: beds.total, hostels: ids.length, occupied: beds.occupied, vacant,
        occupiedPct: share(beds.occupied, beds.total), vacantPct: share(vacant, beds.total),
        residents: res?.now || 0, joined: res?.joined || 0,
        collected: Math.max(0, num(fee?.paid) - num(fee?.refunded)), year: yr?.yearName || '',
        maintenance: wo?.raised || 0, pending: wo?.pending || 0,
    };
}

const BUILDERS = { occupancy, admissions, attendance, mess, fees, leave, visitors, maintenance, complaints, incidents, discipline, summary };

/** The board: GET /hostel/admin/board/reports?report=… */
exports.report = async (req, { school, allowed, q: asked }) => {
    const report = REPORTS.includes(asked.report) ? asked.report : 'occupancy';
    const hostels = await hostelsInScope(school, allowed);
    // A hostel outside the caller's scope matches nothing — never everything.
    const q = asked.hostel && !hostels.some((h) => h._id === String(asked.hostel))
        ? { ...asked, hostel: '00000000-0000-0000-0000-000000000000' } : asked;
    const ctx = {
        school, allowed, q, hostels,
        page: Math.max(1, Number(q.page) || 1), limit: Math.max(1, Math.min(5000, Number(q.limit) || 10)),
    };
    const [body, t] = await Promise.all([BUILDERS[report](ctx), tiles(ctx)]);
    return { report, reports: REPORTS, tiles: t, ...body, page: ctx.page, limit: ctx.limit, pages: Math.max(1, Math.ceil((body.total || 0) / ctx.limit)) };
};
