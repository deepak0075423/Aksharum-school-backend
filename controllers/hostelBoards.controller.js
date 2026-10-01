'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hostel — one read model ("board") per redesigned admin list screen.
//
//  GET /hostel/admin/board/:screen answers everything that screen draws —
//  tiles, tab counts and one page of rows — so a screen makes one call and its
//  numbers cannot disagree with each other. The CRUD and workflow endpoints in
//  hostel.controller.js are untouched: the screens still write through them.
//
//  Each board builds its SQL from services/hostelQuery.js. A board's `build(p)`
//  is called once PER QUERY with a fresh parameter list: node-pg refuses a
//  statement handed more parameters than it references.
// ─────────────────────────────────────────────────────────────────────────────
const pool = require('../db/pool');
const { ok, bad, fail, visibleHostelIds, getSettings, dayRange } = require('../services/hostelService');
const Q = require('../services/hostelQuery');
const { BED_STATE, bedCounts, hostelsInScope, structureCounts } = require('../services/hostelOverview');

const HostelAdmission = require('../models/HostelAdmission');
const HostelAllocation = require('../models/HostelAllocation');
const HostelAllocationHistory = require('../models/HostelAllocationHistory');
const HostelAttendance = require('../models/HostelAttendance');
const HostelLeave = require('../models/HostelLeave');
const HostelOutpass = require('../models/HostelOutpass');
const HostelVisitor = require('../models/HostelVisitor');
const HostelMovement = require('../models/HostelMovement');
const HostelStaffAssignment = require('../models/HostelStaffAssignment');
const HostelMess = require('../models/HostelMess');
const HostelMessMember = require('../models/HostelMessMember');
const HostelMessAttendance = require('../models/HostelMessAttendance');
const HostelMessExpense = require('../models/HostelMessExpense');
const HostelFeeInvoice = require('../models/HostelFeeInvoice');
const HostelFeePlan = require('../models/HostelFeePlan');
const AcademicYear = require('../models/AcademicYear');
const HostelComplaint = require('../models/HostelComplaint');
const HostelMaintenance = require('../models/HostelMaintenance');
const HostelAsset = require('../models/HostelAsset');
const HostelIncident = require('../models/HostelIncident');
const HostelDiscipline = require('../models/HostelDiscipline');
const HostelDocument = require('../models/HostelDocument');
const HostelAnnouncement = require('../models/HostelAnnouncement');
const HostelAuditLog = require('../models/HostelAuditLog');
const HostelBed = require('../models/HostelBed');
const HostelFloor = require('../models/HostelFloor');
const HostelBuilding = require('../models/HostelBuilding');

const { TBL, T, params, inScope, eq, search, between, studentJoin, studentCols, currentPlaceJoin, placeJoin, placeCols,
        counts, board, monthStart, monthDelta, share } = Q;

/* ═════════════════════════════════════════════════════════════════════════════
 *  Hostels
 * ═════════════════════════════════════════════════════════════════════════════ */
async function hostels(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `ho."school" = ${p.$(school)} AND ho."isActive"${inScope('ho."_id"', allowed, p)}`;
        if (filtered) {
            where += search(['ho."name"', 'ho."code"', 'w."name"'], q.search, p)
                + eq('ho."gender"', q.gender, p)
                + eq('ho."status"', q.status, p)
                + eq('ho."hostelType"', q.type, p);
        }
        const from = `FROM ${TBL.hostels} ho
            LEFT JOIN ${TBL.users} w ON w."_id" = ho."warden"
            LEFT JOIN LATERAL (
                SELECT count(*) FILTER (WHERE s.st <> 'out')::int AS "total",
                       count(*) FILTER (WHERE s.st = 'occupied')::int AS "occupied",
                       count(*) FILTER (WHERE s.st = 'available')::int AS "available"
                  FROM (SELECT ${BED_STATE} AS st
                          FROM ${TBL.beds} b
                          JOIN ${TBL.hostels} h ON h."_id" = b."hostel"
                          LEFT JOIN ${TBL.rooms} r ON r."_id" = b."room"
                         WHERE b."hostel" = ho."_id" AND b."isActive") s) bd ON true
            LEFT JOIN LATERAL (SELECT count(*)::int AS "n" FROM ${TBL.rooms} r
                                WHERE r."hostel" = ho."_id" AND r."isActive") rm ON true`;
        return { from, where };
    };

    const p = params();
    const { from, where } = build(p, true);
    const [result, live] = await Promise.all([
        board({
            p, from, where,
            select: `ho."_id", ho."name", ho."code", ho."hostelType", ho."gender", ho."status", ho."capacity",
                     ho."photos", ho."contactNumber", ho."city",
                     w."_id" AS "wardenId", w."name" AS "wardenName", w."phone" AS "wardenPhone",
                     bd."total" AS "beds", bd."occupied", bd."available", rm."n" AS "rooms"`,
            sorts: { name: 'lower(ho."name")', created: 'ho."createdAt"' },
            sort: q.sort, dir: q.dir || 'asc', fallback: 'name', page: q.page, limit: q.limit,
        }),
        hostelsInScope(school, allowed),
    ]);
    const beds = await bedCounts(school, live.map((h) => h._id));
    return {
        ...result,
        tiles: {
            hostels: live.length,
            beds: beds.total, occupied: beds.occupied, available: beds.available,
            occupiedPct: share(beds.occupied, beds.total, 0),
            availablePct: share(beds.available, beds.total, 0),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Buildings & Floors
 *
 *  One answer holds the whole screen: every building with its figures, the
 *  chosen building's floors, and the chosen floor's rooms. Beds are counted by
 *  BED_STATE, so a building's "available" is the beds the allocation engine
 *  would actually hand out — the same number the Hostels screen and the
 *  Dashboard print.
 * ═════════════════════════════════════════════════════════════════════════════ */

/** Live bed figures for whatever row `owner` points at (a building, floor, room). */
const bedsOf = (col, owner) => `
    LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE s.st <> 'out')::int AS "beds",
               count(*) FILTER (WHERE s.st = 'occupied')::int AS "occupied",
               count(*) FILTER (WHERE s.st = 'available')::int AS "available",
               count(*) FILTER (WHERE s.st = 'maintenance')::int AS "maintenance",
               count(*) FILTER (WHERE s.st = 'reserved')::int AS "reserved",
               count(*) FILTER (WHERE s.st = 'out')::int AS "out"
          FROM (SELECT ${BED_STATE} AS st
                  FROM ${TBL.beds} b
                  JOIN ${TBL.hostels} h ON h."_id" = b."hostel"
                  LEFT JOIN ${TBL.rooms} r ON r."_id" = b."room"
                 WHERE b."${col}" = ${owner} AND b."isActive") s) bd ON true`;

async function structure(req, { school, allowed, q }) {
    const p = params();
    let where = `x."school" = ${p.$(school)} AND x."isActive"${inScope('x."hostel"', allowed, p)}`;
    where += search(['x."name"', 'x."code"'], q.search, p) + eq('x."hostel"', q.hostel, p, '::uuid');
    const { rows: buildings } = await pool.query(
        `SELECT x."_id", x."name", x."code", x."status", x."description", x."capacity", x."floorCount", x."expectedRooms", x."facilities",
                h0."_id" AS "hostelId", h0."name" AS "hostelName",
                fl."n" AS "floors", rm."n" AS "rooms", bd."beds", bd."occupied", bd."available"
           FROM ${TBL.buildings} x
           JOIN ${TBL.hostels} h0 ON h0."_id" = x."hostel" AND h0."isActive"
           LEFT JOIN LATERAL (SELECT count(*)::int AS "n" FROM ${TBL.floors} f WHERE f."building" = x."_id" AND f."isActive") fl ON true
           LEFT JOIN LATERAL (SELECT count(*)::int AS "n" FROM ${TBL.rooms} r WHERE r."building" = x."_id" AND r."isActive") rm ON true
           ${bedsOf('building', 'x."_id"')}
          WHERE ${where}
          ORDER BY lower(h0."name"), lower(x."name")
          LIMIT 500`,
        p.list,
    );

    // How many buildings the caller has at all — the filters must not make a
    // school with buildings look like one that has none.
    const tp = params();
    const { rows: [all] } = await pool.query(
        `SELECT count(*)::int AS "n" FROM ${TBL.buildings} x
          WHERE x."school" = ${tp.$(school)} AND x."isActive"${inScope('x."hostel"', allowed, tp)}`,
        tp.list,
    );

    const selected = buildings.find((b) => String(b._id) === String(q.building)) || buildings[0] || null;
    if (!selected) return { buildings, total: all.n, selected: null, floors: [], floor: null, rooms: [] };

    const fp = params();
    const { rows: floors } = await pool.query(
        `SELECT x."_id", x."name", x."floorNumber", x."status", x."capacity", x."facilities", x."commonRooms",
                sv."_id" AS "supervisorId", sv."name" AS "supervisorName",
                rm."n" AS "rooms", bd."beds", bd."occupied", bd."available"
           FROM ${TBL.floors} x
           LEFT JOIN ${TBL.users} sv ON sv."_id" = x."supervisor"
           LEFT JOIN LATERAL (SELECT count(*)::int AS "n" FROM ${TBL.rooms} r WHERE r."floor" = x."_id" AND r."isActive") rm ON true
           ${bedsOf('floor', 'x."_id"')}
          WHERE x."school" = ${fp.$(school)} AND x."building" = ${fp.$(String(selected._id))}::uuid AND x."isActive"
          ORDER BY x."floorNumber", lower(x."name")`,
        fp.list,
    );

    const floor = floors.find((f) => String(f._id) === String(q.floor)) || floors[0] || null;
    let rooms = [];
    if (floor) {
        const rp = params();
        ({ rows: rooms } = await pool.query(
            `SELECT x."_id", x."roomNumber", x."code", x."roomType", x."capacity", x."status", x."gender",
                    bd."beds", bd."occupied", bd."available"
               FROM ${TBL.rooms} x
               ${bedsOf('room', 'x."_id"')}
              WHERE x."school" = ${rp.$(school)} AND x."floor" = ${rp.$(String(floor._id))}::uuid AND x."isActive"
              ORDER BY x."roomNumber"`,
            rp.list,
        ));
    }
    return { buildings, total: all.n, selected, floors, floor: floor ? String(floor._id) : null, rooms };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Rooms & Beds
 * ═════════════════════════════════════════════════════════════════════════════ */

/**
 * The state a ROOM is listed under. Taken out of service or sent for repair by
 * hand wins; otherwise the beds decide — a room with no bed left to give is
 * Full, whatever mix of occupied, held and broken beds made it so.
 */
const ROOM_STATE = `CASE
        WHEN x."status" = 'inactive' OR h0."status" <> 'active' THEN 'inactive'
        WHEN x."status" = 'maintenance'                         THEN 'maintenance'
        WHEN x."status" = 'reserved'                            THEN 'reserved'
        WHEN bd."beds" > 0 AND bd."available" = 0               THEN 'full'
        ELSE 'available'
    END`;
const ROOM_STATES = ['available', 'full', 'reserved', 'maintenance', 'inactive'];

/** The beds of some rooms, each with whoever sleeps in it, keyed by room. */
async function bedsByRoom(school, roomIds) {
    if (!roomIds.length) return {};
    const { rows } = await pool.query(
        `SELECT b."_id", b."room", b."bedNumber", b."code", b."bedType", b."status", b."remarks",
                CASE WHEN b."occupantType" IN ('teacher', 'both') THEN b."occupantType" ELSE 'student' END AS "occupantType",
                ${BED_STATE} AS "state", COALESCE(al."fromDate", b."allocationDate") AS "allocatedOn",
                b."allocation" AS "allocationId", ${studentCols('st')}
           FROM ${TBL.beds} b
           JOIN ${TBL.hostels} h ON h."_id" = b."hostel"
           LEFT JOIN ${TBL.rooms} r ON r."_id" = b."room"
           LEFT JOIN ${TBL.allocations} al ON al."_id" = b."allocation"
           ${studentJoin('st', 'b."student"')}
          WHERE b."school" = $1 AND b."room" = ANY($2::uuid[]) AND b."isActive"
          ORDER BY length(b."bedNumber"), b."bedNumber"`,
        [String(school), roomIds.map(String)],
    );
    const by = {};
    for (const b of rows) (by[String(b.room)] = by[String(b.room)] || []).push(b);
    return by;
}

async function rooms(req, { school, allowed, q }) {
    const p = params();
    let where = `x."school" = ${p.$(school)} AND x."isActive"${inScope('x."hostel"', allowed, p)}`;
    const term = String(q.search || '').trim();
    if (term) {
        // A room by its number or code — or by who lives in it.
        const like = p.$(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where += ` AND (x."roomNumber" ILIKE ${like} OR x."code" ILIKE ${like} OR EXISTS (
                        SELECT 1 FROM ${TBL.beds} sb JOIN ${TBL.users} su ON su."_id" = sb."student"
                         WHERE sb."room" = x."_id" AND sb."status" = 'occupied' AND su."name" ILIKE ${like}))`;
    }
    where += eq('x."hostel"', q.hostel, p, '::uuid') + eq('x."building"', q.building, p, '::uuid')
        + eq('x."floor"', q.floor, p, '::uuid') + eq('x."roomType"', q.roomType || q.type, p);
    if (ROOM_STATES.includes(q.status)) where += ` AND (${ROOM_STATE}) = ${p.$(q.status)}`;
    const from = `FROM ${TBL.rooms} x
        JOIN ${TBL.hostels} h0 ON h0."_id" = x."hostel" AND h0."isActive"
        LEFT JOIN ${TBL.buildings} bl ON bl."_id" = x."building"
        LEFT JOIN ${TBL.floors} fl ON fl."_id" = x."floor"
        ${bedsOf('room', 'x."_id"')}`;

    const [result, live] = await Promise.all([
        board({
            p, from, where,
            select: `x."_id", x."roomNumber", x."code", x."roomType", x."capacity", x."status", x."gender",
                    CASE WHEN x."occupantType" IN ('teacher', 'both') THEN x."occupantType" ELSE 'student' END AS "occupantType",
                     x."hostel" AS "hostelId", h0."name" AS "hostelName",
                     x."building" AS "buildingId", bl."name" AS "buildingName",
                     x."floor" AS "floorId", fl."name" AS "floorName", fl."floorNumber",
                     bd."beds", bd."occupied", bd."available", bd."maintenance", (${ROOM_STATE}) AS "state"`,
            sorts: { room: `lower(h0."name"), length(x."roomNumber"), x."roomNumber"` },
            sort: 'room', dir: 'asc', page: q.page, limit: q.limit,
        }),
        hostelsInScope(school, allowed),
    ]);
    const ids = live.map((h) => h._id);
    const [beds, structure0, byRoom] = await Promise.all([
        bedCounts(school, ids),
        structureCounts(school, ids),
        bedsByRoom(school, result.rows.map((r) => r._id)),
    ]);
    result.rows.forEach((r) => { r.bedList = byRoom[String(r._id)] || []; });
    return {
        ...result,
        tiles: {
            rooms: structure0.rooms, beds: beds.total, occupied: beds.occupied, available: beds.available,
            maintenance: beds.maintenance, reserved: beds.reserved,
            occupiedPct: share(beds.occupied, beds.total, 0), availablePct: share(beds.available, beds.total, 0),
            maintenancePct: share(beds.maintenance, beds.total, 0),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Occupancy Map
 *
 *  The tree on the left is every hostel the caller may see, down to its rooms.
 *  The figures and the key are the chosen BUILDING's; the plan is the chosen
 *  FLOOR's rooms with every bed and whoever is in it.
 * ═════════════════════════════════════════════════════════════════════════════ */
async function occupancy(req, { school, allowed, q }) {
    const live = await hostelsInScope(school, allowed);
    const blank = { rooms: 0, beds: 0, occupied: 0, available: 0, reserved: 0, maintenance: 0, inactive: 0,
        occupiedPct: 0, availablePct: 0, maintenancePct: 0 };
    if (!live.length) return { tree: [], hostel: null, building: null, floor: null, tiles: blank, floors: [], rooms: [] };

    const ids = live.map((h) => h._id);
    const [{ rows: bld }, { rows: flr }, { rows: rms }] = await Promise.all([
        pool.query(`SELECT "_id", "hostel", "name", "code", "status" FROM ${TBL.buildings}
                     WHERE "school" = $1 AND "hostel" = ANY($2::uuid[]) AND "isActive" ORDER BY lower("name")`, [String(school), ids]),
        pool.query(`SELECT "_id", "building", "name", "floorNumber", "status" FROM ${TBL.floors}
                     WHERE "school" = $1 AND "hostel" = ANY($2::uuid[]) AND "isActive" ORDER BY "floorNumber", lower("name")`, [String(school), ids]),
        pool.query(`SELECT "_id", "floor", "roomNumber" FROM ${TBL.rooms}
                     WHERE "school" = $1 AND "hostel" = ANY($2::uuid[]) AND "isActive" ORDER BY length("roomNumber"), "roomNumber"`, [String(school), ids]),
    ]);
    const S = (v) => String(v);
    const group = (arr, key) => arr.reduce((m, x) => { (m[S(x[key])] = m[S(x[key])] || []).push(x); return m; }, {});
    const roomsBy = group(rms, 'floor'); const floorsBy = group(flr, 'building'); const bldBy = group(bld, 'hostel');
    const tree = live.map((h) => ({
        _id: h._id, name: h.name, code: h.code,
        buildings: (bldBy[h._id] || []).map((b) => ({
            _id: S(b._id), name: b.name, code: b.code,
            floors: (floorsBy[S(b._id)] || []).map((f) => ({
                _id: S(f._id), name: f.name, floorNumber: f.floorNumber,
                rooms: (roomsBy[S(f._id)] || []).map((r) => ({ _id: S(r._id), name: r.roomNumber })),
            })),
        })),
    }));

    const hostel = tree.find((h) => h._id === S(q.hostel)) || tree[0];
    const building = hostel.buildings.find((b) => b._id === S(q.building)) || hostel.buildings[0] || null;
    const floor = building ? (building.floors.find((f) => f._id === S(q.floor)) || building.floors[0] || null) : null;

    // Figures for the chosen building, or the whole hostel while it has none.
    const tp = [String(school), building ? building._id : hostel._id];
    const col = building ? 'building' : 'hostel';
    const [{ rows: states }, { rows: [rc] }] = await Promise.all([
        pool.query(
            `SELECT ${BED_STATE} AS "state", count(*)::int AS "n"
               FROM ${TBL.beds} b
               JOIN ${TBL.hostels} h ON h."_id" = b."hostel"
               LEFT JOIN ${TBL.rooms} r ON r."_id" = b."room"
              WHERE b."school" = $1 AND b."${col}" = $2::uuid AND b."isActive"
              GROUP BY 1`, tp),
        pool.query(`SELECT count(*)::int AS "n" FROM ${TBL.rooms} WHERE "school" = $1 AND "${col}" = $2::uuid AND "isActive"`, tp),
    ]);
    const n = Object.fromEntries(states.map((r) => [r.state, r.n]));
    const beds = (n.occupied || 0) + (n.available || 0) + (n.reserved || 0) + (n.maintenance || 0);
    const tiles = {
        rooms: rc.n, beds, occupied: n.occupied || 0, available: n.available || 0,
        reserved: n.reserved || 0, maintenance: n.maintenance || 0, inactive: n.out || 0,
        occupiedPct: share(n.occupied, beds, 0), availablePct: share(n.available, beds, 0),
        maintenancePct: share(n.maintenance, beds, 0),
    };

    let rooms0 = [];
    if (floor) {
        const rp = params();
        ({ rows: rooms0 } = await pool.query(
            `SELECT x."_id", x."roomNumber", x."code", x."roomType", x."capacity", x."status",
                    bd."beds", bd."occupied", bd."available", (${ROOM_STATE}) AS "state"
               FROM ${TBL.rooms} x
               JOIN ${TBL.hostels} h0 ON h0."_id" = x."hostel"
               ${bedsOf('room', 'x."_id"')}
              WHERE x."school" = ${rp.$(school)} AND x."floor" = ${rp.$(floor._id)}::uuid AND x."isActive"
              ORDER BY length(x."roomNumber"), x."roomNumber"`,
            rp.list,
        ));
        const byRoom = await bedsByRoom(school, rooms0.map((r) => r._id));
        rooms0.forEach((r) => { r.bedList = byRoom[S(r._id)] || []; });
    }
    return {
        tree, tiles, rooms: rooms0,
        hostel: hostel._id, building: building ? building._id : null, floor: floor ? floor._id : null,
        path: { hostel: hostel.name, building: building?.name || '', floor: floor?.name || '' },
        floors: building ? building.floors.map((f) => ({ _id: f._id, name: f.name })) : [],
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Admissions
 * ═════════════════════════════════════════════════════════════════════════════ */
const ADMISSION_TABS = {
    all: 'true',
    pending: `x."status" IN ('draft', 'applied', 'pending_approval')`,
    approved: `x."status" IN ('approved', 'completed')`,
    rejected: `x."status" = 'rejected'`,
    waitlist: `x."status" = 'waitlisted'`,
};

async function admissions(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['st."name"', 'x."applicationNumber"', 'stp."admissionNumber"'], q.search, p)
                + eq('x."academicYear"', q.academicYear, p, '::uuid')
                + eq('x."hostel"', q.hostel, p, '::uuid')
                + eq('stp."currentClass"', q.class, p, '::uuid');
            if (q.status && ADMISSION_TABS[q.status]) where += ` AND (${ADMISSION_TABS[q.status]})`;
        }
        const from = `FROM ${T(HostelAdmission)} x
            ${studentJoin('st', 'x."student"')}
            LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"`;
        return { from, where };
    };
    const p = params(); const { from, where } = build(p, true);
    const tp = params(); const t = build(tp, false);
    const [result, tiles] = await Promise.all([
        board({
            p, from, where, tabs: ADMISSION_TABS, tab: q.tab,
            select: `x."_id", x."applicationNumber", x."status", x."preferredRoomType", x."appliedAt", x."createdAt",
                     x."joiningDate", x."reason", x."waitlistPosition", x."allocation", x."decisionRemark",
                     h."_id" AS "hostelId", h."name" AS "hostelName", ${studentCols('st')}`,
            sorts: { applied: 'COALESCE(x."appliedAt", x."createdAt")', number: 'x."applicationNumber"', student: 'lower(st."name")' },
            sort: q.sort, dir: q.dir, fallback: 'applied', page: q.page, limit: q.limit,
        }),
        counts(tp, t.from, t.where, ADMISSION_TABS),
    ]);
    const total = tiles.all || 0;
    return {
        ...result,
        tiles: {
            total, approved: tiles.approved, pending: tiles.pending, rejected: tiles.rejected, waitlist: tiles.waitlist,
            approvedPct: share(tiles.approved, total, 0), pendingPct: share(tiles.pending, total, 0),
            rejectedPct: share(tiles.rejected, total, 0),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Allocations
 * ═════════════════════════════════════════════════════════════════════════════ */
const ALLOCATION_TABS = {
    all: 'true',
    active: `x."status" = 'active'`,
    pending: `x."status" = 'pending'`,
    vacated: `x."status" IN ('vacated', 'transferred', 'cancelled')`,
};

/**
 * A conflict is an active allocation whose bed does not agree with it — the bed
 * is not occupied, or is held for a different allocation. The allocation engine
 * keeps the two in step, so any count here is data somebody edited by hand.
 */
const CONFLICT = `x."status" = 'active' AND (bd."_id" IS NULL OR bd."status" <> 'occupied'
                  OR bd."allocation" IS DISTINCT FROM x."_id")`;

async function allocations(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['st."name"', 'stp."rollNumber"', 'stp."admissionNumber"', 'pr."roomNumber"'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid')
                + eq('x."building"', q.building, p, '::uuid')
                + eq('x."room"', q.room, p, '::uuid')
                + eq('stp."currentClass"', q.class, p, '::uuid');
            if (q.status && ALLOCATION_TABS[q.status]) where += ` AND (${ALLOCATION_TABS[q.status]})`;
        }
        const from = `FROM ${T(HostelAllocation)} x
            ${studentJoin('st', 'x."student"')}
            LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
            ${placeJoin('p', { building: 'x."building"', room: 'x."room"', bed: 'x."bed"' })}
            LEFT JOIN ${TBL.beds} bd ON bd."_id" = x."bed"`;
        return { from, where };
    };
    // placeJoin('p', …) aliases the building, room and bed pb / pr / pd; the
    // search above relies on "pr".
    const p = params(); const { from, where } = build(p, true);
    const tp = params(); const t = build(tp, false);
    const [result, tiles] = await Promise.all([
        board({
            p, from, where, tabs: ALLOCATION_TABS, tab: q.tab,
            select: `x."_id", x."status", x."presence", x."fromDate", x."toDate", x."vacatedDate", x."createdAt",
                     x."allocationType", x."allocationMode", x."academicYear",
                     h."_id" AS "hostelId", h."name" AS "hostelName",
                     ${placeCols('p')}, (${CONFLICT}) AS "conflict", ${studentCols('st')},
                     (x."status" IN ('pending', 'active') AND st."isActive" = false) AS "accountInactive"`,
            sorts: { allocated: 'COALESCE(x."fromDate", x."createdAt")', student: 'lower(st."name")', room: 'pr."roomNumber"' },
            sort: q.sort, dir: q.dir, fallback: 'allocated', page: q.page, limit: q.limit,
        }),
        counts(tp, t.from, t.where, { active: ALLOCATION_TABS.active, pending: ALLOCATION_TABS.pending, conflicts: CONFLICT }),
    ]);
    const allocated = (tiles.active || 0) + (tiles.pending || 0);
    return {
        ...result,
        tiles: {
            allocated, active: tiles.active, pending: tiles.pending, conflicts: tiles.conflicts,
            activePct: share(tiles.active, allocated, 0), pendingPct: share(tiles.pending, allocated, 0),
            conflictsPct: share(tiles.conflicts, allocated, 0),
        },
    };
}

/** The allocation log — the Allocations screen's History tab. */
async function allocationHistory(req, { school, allowed, q }) {
    const p = params();
    let where = `x."school" = ${p.$(school)}`;
    if (allowed !== null) {
        where += ` AND (x."fromHostel" = ANY(${p.$(allowed)}::uuid[]) OR x."toHostel" = ANY(${p.$(allowed)}::uuid[]))`;
    }
    where += search(['st."name"', 'x."fromLabel"', 'x."toLabel"', 'x."reason"'], q.search, p);
    const from = `FROM ${T(HostelAllocationHistory)} x
        ${studentJoin('st', 'x."student"')}
        LEFT JOIN ${TBL.users} pb ON pb."_id" = x."performedBy"`;
    return board({
        p, from, where,
        select: `x."_id", x."action", x."fromLabel", x."toLabel", x."reason", x."createdAt", x."effectiveDate",
                 COALESCE(NULLIF(x."performedByName", ''), pb."name") AS "performedByName",
                 ${studentCols('st')}, COALESCE(st."name", NULLIF(x."studentName", '')) AS "studentName"`,
        sorts: { at: 'x."createdAt"' }, sort: 'at', dir: 'desc', page: q.page, limit: q.limit,
    });
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Attendance
 *
 *  The register is one hostel's residents for a date and session, whole — a
 *  roll call is submitted for everyone at once, so the screen pages and searches
 *  it on the client and the marks it holds always cover every resident.
 * ═════════════════════════════════════════════════════════════════════════════ */
const SESSIONS = ['morning', 'evening', 'night', 'roll_call'];
const MARKS = ['present', 'absent', 'late', 'excused', 'on_leave'];

async function attendance(req, { school, allowed, q }) {
    const live = await hostelsInScope(school, allowed);
    const settings = await getSettings(school);
    const sessions = (settings.attendanceSessions || []).filter((x) => SESSIONS.includes(x));
    const hostel = live.find((h) => h._id === String(q.hostel)) || live[0] || null;
    const session = SESSIONS.includes(q.session) ? q.session : (sessions[0] || 'morning');
    const { start, end } = dayRange(q.date);
    const base = { hostel: hostel?._id || null, hostels: live, date: start, session, sessions: sessions.length ? sessions : SESSIONS,
        sessionTimes: settings.attendanceSessionTimes || {}, correctionWindowDays: settings.attendanceCorrectionWindowDays || 0 };
    if (!hostel) return { ...base, rows: [], total: 0, saved: 0, submittedAt: null, submittedBy: '', pendingCorrections: 0 };

    const isToday = dayRange().start.getTime() === start.getTime();
    const p = params();
    const $school = p.$(school); const $hostel = p.$(hostel._id); const $start = p.$(start); const $end = p.$(end); const $session = p.$(session);
    let where = `al."school" = ${$school} AND al."hostel" = ${$hostel}::uuid AND al."status" = 'active'`;
    // Staff who live in are not on the roll call unless the school asks for it.
    if (!settings.rollCallIncludesTeachers) where += ` AND COALESCE(al."residentType", 'student') <> 'teacher'`;
    where += eq('al."building"', q.building, p, '::uuid') + eq('al."floor"', q.floor, p, '::uuid') + eq('pr."roomType"', q.roomType, p);
    const { rows } = await pool.query(
        `SELECT al."_id" AS "allocationId", al."presence", ${studentCols('st')}, ${placeCols('p')}, fl."name" AS "floorName",
                at."_id" AS "recordId", at."status" AS "recordStatus", at."remarks" AS "recordRemarks",
                at."approvalStatus", at."previousStatus", at."markedAt", mb."name" AS "markedByName",
                lv."leaveType", lv."toDate" AS "leaveTo", ${isToday ? 'op."status"' : 'NULL'} AS "outpassStatus"
           FROM ${TBL.allocations} al
           ${studentJoin('st', 'al."student"')}
           ${placeJoin('p', { building: 'al."building"', room: 'al."room"', bed: 'al."bed"' })}
           LEFT JOIN ${TBL.floors} fl ON fl."_id" = al."floor"
           LEFT JOIN ${T(HostelAttendance)} at ON at."student" = al."student" AND at."school" = al."school"
                AND at."date" >= ${$start} AND at."date" < ${$end} AND at."session" = ${$session}
           LEFT JOIN ${TBL.users} mb ON mb."_id" = at."markedBy"
           LEFT JOIN LATERAL (SELECT l."leaveType", l."toDate" FROM ${T(HostelLeave)} l
                               WHERE l."student" = al."student" AND l."school" = al."school"
                                 AND l."status" IN ('approved', 'active') AND l."fromDate" < ${$end} AND l."toDate" >= ${$start}
                               ORDER BY l."fromDate" DESC LIMIT 1) lv ON true
           LEFT JOIN LATERAL (SELECT o."status" FROM ${T(HostelOutpass)} o
                               WHERE o."student" = al."student" AND o."school" = al."school" AND o."status" IN ('active', 'overdue')
                               LIMIT 1) op ON true
          WHERE ${where}
          ORDER BY lower(pb."name"), length(pr."roomNumber"), pr."roomNumber", length(pd."bedNumber"), pd."bedNumber", lower(st."name")`,
        p.list,
    );
    // What the marker can accept in one click: away on approved leave, out on a
    // pass, else present.
    rows.forEach((r) => { r.suggested = r.leaveType ? 'on_leave' : r.outpassStatus ? 'excused' : 'present'; });

    const marked = rows.filter((r) => r.recordId);
    const latest = marked.reduce((m, r) => (!m || new Date(r.markedAt) > new Date(m.markedAt) ? r : m), null);
    const { rows: [pc] } = await pool.query(
        `SELECT count(*)::int AS "n" FROM ${T(HostelAttendance)} x
          WHERE x."school" = $1 AND x."approvalStatus" = 'pending'${allowed === null ? '' : ' AND x."hostel" = ANY($2::uuid[])'}`,
        allowed === null ? [String(school)] : [String(school), allowed.map(String)],
    );
    return { ...base, rows, total: rows.length, saved: marked.length,
        submittedAt: latest?.markedAt || null, submittedBy: latest?.markedByName || '', pendingCorrections: pc.n };
}

/** Every roll-call record — the History tab, and the corrections among them. */
const ATT_TABS = {
    all: 'true',
    corrections: `x."approvalStatus" <> 'not_required'`,
    pending: `x."approvalStatus" = 'pending'`,
};
async function attendanceHistory(req, { school, allowed, q }) {
    const p = params();
    let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
    where += search(['st."name"', 'stp."rollNumber"', 'stp."admissionNumber"', 'pr."roomNumber"'], q.search, p)
        + eq('x."hostel"', q.hostel, p, '::uuid') + eq('x."student"', q.student, p, '::uuid')
        + (SESSIONS.includes(q.session) ? eq('x."session"', q.session, p) : '')
        + (MARKS.includes(q.status) ? eq('x."status"', q.status, p) : '')
        + between('x."date"', q.from, q.to, p);
    const from = `FROM ${T(HostelAttendance)} x
        ${studentJoin('st', 'x."student"')}
        LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
        ${placeJoin('p', { building: 'x."building"', room: 'x."room"', bed: 'NULL::uuid' })}
        LEFT JOIN ${TBL.users} mb ON mb."_id" = x."markedBy"
        LEFT JOIN ${TBL.users} cb ON cb."_id" = x."correctedBy"
        LEFT JOIN ${TBL.users} ab ON ab."_id" = x."approvedBy"`;
    return board({
        p, from, where, tabs: ATT_TABS, tab: q.tab,
        select: `x."_id", x."date", x."session", x."status", x."remarks", x."previousStatus", x."correctionReason",
                 x."approvalStatus", x."markedAt", x."correctedAt", x."approvedAt",
                 mb."name" AS "markedByName", cb."name" AS "correctedByName", ab."name" AS "approvedByName",
                 h."name" AS "hostelName", pb."name" AS "buildingName", pb."code" AS "buildingCode",
                 pr."roomNumber", ${studentCols('st')}`,
        sorts: { date: 'x."date" DESC, x."markedAt"', corrected: 'x."correctedAt"' },
        sort: q.tab && q.tab !== 'all' ? 'corrected' : 'date', dir: 'desc', page: q.page, limit: q.limit,
    });
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Leave
 * ═════════════════════════════════════════════════════════════════════════════ */
const LEAVE_TABS = {
    all: 'true',
    pending: `x."status" IN ('pending', 'parent_approved')`,
    // Granted, whatever came of it since: waiting to go, away, late back, or back.
    approved: `x."status" IN ('approved', 'active', 'overdue', 'returned')`,
    rejected: `x."status" = 'rejected'`,
    active: `x."status" IN ('active', 'overdue')`,
    past: `x."status" = 'returned'`,
};
const LEAVE_STATUSES = ['pending', 'parent_approved', 'approved', 'rejected', 'cancelled', 'active', 'returned', 'overdue'];
const LEAVE_TYPES = ['short', 'weekend', 'holiday', 'medical', 'emergency', 'home', 'other'];

/** A request's student, and where they live — through the allocation it was filed against. */
const residentFrom = (Model) => `FROM ${T(Model)} x
        ${studentJoin('st', 'x."student"')}
        LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
        LEFT JOIN ${TBL.allocations} al ON al."_id" = x."allocation"
        ${placeJoin('p', { building: 'al."building"', room: 'al."room"', bed: 'al."bed"' })}`;
const RESIDENT_COLS = `h."_id" AS "hostelId", h."name" AS "hostelName", ${placeCols('p')}, ${studentCols('st')}`;

async function leave(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['st."name"', 'stp."rollNumber"', 'stp."admissionNumber"', 'x."leaveNumber"'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid') + eq('stp."currentClass"', q.class, p, '::uuid')
                + (LEAVE_TYPES.includes(q.leaveType) ? eq('x."leaveType"', q.leaveType, p) : '')
                + (LEAVE_STATUSES.includes(q.status) ? eq('x."status"', q.status, p) : '')
                + between('x."fromDate"', q.from, q.to, p);
            if (q.consent === 'awaiting') where += ` AND x."parentApprovalRequired" AND x."parentApprovedAt" IS NULL AND x."status" = 'pending'`;
            if (q.consent === 'recorded') where += ` AND x."parentApprovedAt" IS NOT NULL`;
        }
        return { from: residentFrom(HostelLeave), where };
    };
    const p = params(); const { from, where } = build(p, true);
    const tp = params(); const t = build(tp, false);
    const dp = params(); const d = build(dp, false);
    const [result, tiles, delta] = await Promise.all([
        board({
            p, from, where, tabs: LEAVE_TABS, tab: q.tab,
            select: `x."_id", x."leaveNumber", x."leaveType", x."fromDate", x."toDate", x."totalDays", x."reason", x."destination",
                     x."status", x."createdAt", x."parentApprovalRequired", x."parentApprovedAt", x."wardenApprovedAt",
                     x."departedAt", x."returnedAt", x."rejectionReason", x."guardianName", x."guardianPhone", x."emergencyContact",
                     x."attachments", ${RESIDENT_COLS}`,
            sorts: { applied: 'x."createdAt"', from: 'x."fromDate"', student: 'lower(st."name")' },
            sort: q.sort, dir: q.dir, fallback: 'applied', page: q.page, limit: q.limit,
        }),
        counts(tp, t.from, t.where, { total: 'true', approved: LEAVE_TABS.approved, pending: LEAVE_TABS.pending, rejected: LEAVE_TABS.rejected }),
        monthDelta(dp, d.from, d.where, 'x."createdAt"'),
    ]);
    return {
        ...result,
        tiles: {
            ...tiles, delta,
            approvedPct: share(tiles.approved, tiles.total, 0), pendingPct: share(tiles.pending, tiles.total, 0),
            rejectedPct: share(tiles.rejected, tiles.total, 0),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Outpass
 * ═════════════════════════════════════════════════════════════════════════════ */
const OUTPASS_TABS = {
    all: 'true',
    pending: `x."status" = 'pending'`,
    // Granted and not out right now: waiting to leave, or already back.
    approved: `x."status" IN ('approved', 'returned')`,
    rejected: `x."status" = 'rejected'`,
    active: `x."status" IN ('active', 'overdue')`,
    overdue: `x."status" = 'overdue'`,
};
const OUTPASS_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'active', 'returned', 'overdue'];
const OUTPASS_TYPES = ['day', 'night', 'weekend', 'medical', 'emergency', 'academic', 'market', 'other'];

async function outpass(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['st."name"', 'stp."rollNumber"', 'stp."admissionNumber"', 'x."outpassNumber"'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid') + eq('al."building"', q.building, p, '::uuid')
                + eq('al."room"', q.room, p, '::uuid') + eq('stp."currentClass"', q.class, p, '::uuid')
                + (OUTPASS_TYPES.includes(q.outpassType) ? eq('x."outpassType"', q.outpassType, p) : '')
                + (OUTPASS_STATUSES.includes(q.status) ? eq('x."status"', q.status, p) : '')
                + between('x."departureDate"', q.from, q.to, p);
            if (q.late === '1' || q.late === 'true') where += ` AND x."lateReturnMinutes" > 0`;
        }
        return { from: residentFrom(HostelOutpass), where };
    };
    const p = params(); const { from, where } = build(p, true);
    const tp = params(); const t = build(tp, false);
    const dp = params(); const d = build(dp, false);
    const [result, tiles, delta] = await Promise.all([
        board({
            p, from, where, tabs: OUTPASS_TABS, tab: q.tab,
            select: `x."_id", x."outpassNumber", x."outpassType", x."purpose", x."destination", x."departureDate",
                     x."expectedDepartureTime", x."expectedReturnTime", x."expectedReturnAt", x."actualDepartureAt", x."actualReturnAt",
                     x."status", x."createdAt", x."approvedAt", x."rejectionReason", x."lateReturnMinutes", x."remarks",
                     x."guardianName", x."guardianPhone", x."emergencyContact",
                     COALESCE(x."parentApprovalRequired", false) AS "parentApprovalRequired", x."parentApprovedAt",
                     (COALESCE(x."parentApprovalRequired", false) AND x."parentApprovedAt" IS NULL AND x."status" = 'pending') AS "awaitingParent",
                     (x."qrToken" <> '') AS "hasPass", x."qrToken", ${RESIDENT_COLS}`,
            sorts: { out: 'x."departureDate" DESC, x."expectedDepartureTime"', created: 'x."createdAt"', student: 'lower(st."name")' },
            sort: q.sort, dir: q.dir, fallback: 'out', page: q.page, limit: q.limit,
        }),
        counts(tp, t.from, t.where, { total: 'true', approved: OUTPASS_TABS.approved, pending: OUTPASS_TABS.pending,
            rejected: OUTPASS_TABS.rejected, active: OUTPASS_TABS.active }),
        monthDelta(dp, d.from, d.where, 'x."createdAt"'),
    ]);
    return {
        ...result,
        tiles: {
            ...tiles, delta,
            approvedPct: share(tiles.approved, tiles.total), pendingPct: share(tiles.pending, tiles.total),
            rejectedPct: share(tiles.rejected, tiles.total), activePct: share(tiles.active, tiles.total),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Visitors
 * ═════════════════════════════════════════════════════════════════════════════ */
const VISITOR_TABS = {
    all: 'true',
    inside: `x."status" = 'checked_in'`,
    pending: `x."status" = 'pending'`,
    // Let in, whether they have come yet, are inside, or have been and gone.
    approved: `x."status" IN ('approved', 'checked_in', 'checked_out')`,
    rejected: `x."status" IN ('rejected', 'blocked')`,
    history: `x."status" IN ('checked_out', 'cancelled')`,
};
const VISITOR_STATUSES = ['pending', 'approved', 'rejected', 'checked_in', 'checked_out', 'cancelled', 'blocked'];
/** When a visit happens, for sorting and the date filter: they came, else were due, else asked. */
const VISIT_AT = `COALESCE(x."entryTime", x."scheduledAt", x."createdAt")`;

async function visitors(req, { school, allowed, q }) {
    const lists = q.list === '1' || q.list === 'true' || q.tab === 'lists';
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)} AND COALESCE(x."isTemplate", false) = ${lists ? 'true' : 'false'}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['x."visitorName"', 'x."mobile"', 'x."passNumber"', 'st."name"', 'stp."rollNumber"'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid')
                + (q.type ? ` AND x."relationship" ILIKE ${p.$(`%${String(q.type).replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}` : '')
                + (VISITOR_STATUSES.includes(q.status) ? eq('x."status"', q.status, p) : '')
                + (['authorized', 'restricted'].includes(q.listType) ? eq('x."listType"', q.listType, p) : '')
                + between(VISIT_AT, q.from, q.to, p);
        }
        const from = `FROM ${T(HostelVisitor)} x
            ${studentJoin('st', 'x."student"')}
            LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
            ${currentPlaceJoin('cp', 'x."student"')}
            ${placeJoin('p', { building: 'cp."building"', room: 'cp."room"', bed: 'cp."bed"' })}
            LEFT JOIN ${TBL.users} ab ON ab."_id" = x."approvedBy"`;
        return { from, where };
    };
    const select = `x."_id", x."passNumber", x."visitorName", x."mobile", x."relationship", x."purpose", x."visitorCount",
                    x."idProofType", x."idProofNumber", x."scheduledAt", x."entryTime", x."exitTime", x."status", x."listType",
                    x."rejectionReason", x."remarks", x."createdAt", x."approvedAt", ab."name" AS "approvedByName",
                    (x."qrToken" <> '') AS "hasPass", h."_id" AS "hostelId", h."name" AS "hostelName",
                    ${placeCols('p')}, ${studentCols('st')}`;
    const p = params(); const { from, where } = build(p, true);
    if (lists) {
        // The standing lists: no stages, no tiles — just who is on them.
        return board({ p, from, where, select, sorts: { name: 'lower(x."visitorName")' }, sort: 'name', dir: 'asc', page: q.page, limit: q.limit });
    }
    const tp = params(); const t = build(tp, false);
    const dp = params(); const d = build(dp, false);
    const lp = params();
    const [result, tiles, delta, { rows: [lc] }] = await Promise.all([
        board({
            p, from, where, tabs: VISITOR_TABS, tab: q.tab, select,
            sorts: { at: VISIT_AT, name: 'lower(x."visitorName")' }, sort: q.sort, dir: q.dir, fallback: 'at', page: q.page, limit: q.limit,
        }),
        counts(tp, t.from, t.where, { total: 'true', approved: VISITOR_TABS.approved, pending: VISITOR_TABS.pending,
            rejected: VISITOR_TABS.rejected, inside: VISITOR_TABS.inside }),
        monthDelta(dp, d.from, d.where, 'x."createdAt"'),
        pool.query(`SELECT count(*)::int AS "n" FROM ${T(HostelVisitor)} x
                     WHERE x."school" = ${lp.$(school)} AND x."isTemplate"${inScope('x."hostel"', allowed, lp)}`, lp.list),
    ]);
    return {
        ...result, tabs: { ...result.tabs, lists: lc.n },
        tiles: {
            ...tiles, delta,
            approvedPct: share(tiles.approved, tiles.total), pendingPct: share(tiles.pending, tiles.total),
            rejectedPct: share(tiles.rejected, tiles.total),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Security & Student Movement
 *
 *  The tiles are the residents as they stand now (presence on the allocation);
 *  the table is the gate log, each line under the state that movement put its
 *  student in — and "overdue" while the pass it left on is still not closed.
 * ═════════════════════════════════════════════════════════════════════════════ */
const MOVE_STATE = `CASE
        WHEN x."direction" = 'in'                                  THEN 'inside'
        WHEN op."status" = 'overdue' OR lv."status" = 'overdue'    THEN 'overdue'
        WHEN x."movementType" = 'leave'                            THEN 'on_leave'
        ELSE 'out'
    END`;
const MOVE_TABS = {
    all: 'true',
    inside: `x."direction" = 'in'`,
    outside: `x."direction" = 'out' AND x."movementType" <> 'leave'`,
    leave: `x."movementType" = 'leave'`,
    outpass: `x."movementType" = 'outpass'`,
    overdue: `(${MOVE_STATE}) = 'overdue' OR x."isLate"`,
};
const MOVE_TYPES = ['gate', 'outpass', 'leave', 'visitor', 'vehicle', 'medical', 'other'];

async function movements(req, { school, allowed, q }) {
    const p = params();
    let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
    where += search(['st."name"', 'x."personName"', 'stp."rollNumber"', 'op."outpassNumber"', 'lv."leaveNumber"', 'x."gate"'], q.search, p)
        + eq('x."hostel"', q.hostel, p, '::uuid') + eq('cp."building"', q.building, p, '::uuid') + eq('cp."room"', q.room, p, '::uuid')
        + (MOVE_TYPES.includes(q.movementType) ? eq('x."movementType"', q.movementType, p) : '')
        + (['in', 'out'].includes(q.direction) ? eq('x."direction"', q.direction, p) : '')
        + between('x."at"', q.from, q.to, p);
    if (['inside', 'out', 'on_leave', 'overdue'].includes(q.status)) where += ` AND (${MOVE_STATE}) = ${p.$(q.status)}`;
    if (q.late === '1' || q.late === 'true') where += ` AND x."isLate"`;
    const from = `FROM ${T(HostelMovement)} x
        ${studentJoin('st', 'x."student"')}
        LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
        ${currentPlaceJoin('cp', 'x."student"')}
        ${placeJoin('p', { building: 'cp."building"', room: 'cp."room"', bed: 'cp."bed"' })}
        LEFT JOIN ${T(HostelOutpass)} op ON x."referenceType" = 'HostelOutpass' AND op."_id" = x."reference"
        LEFT JOIN ${T(HostelLeave)} lv ON x."referenceType" = 'HostelLeave' AND lv."_id" = x."reference"
        LEFT JOIN ${TBL.users} rb ON rb."_id" = x."recordedBy"`;

    const ap = params();
    const op = params();
    const [result, { rows: [live] }, { rows: [passes] }] = await Promise.all([
        board({
            p, from, where, tabs: MOVE_TABS, tab: q.tab,
            select: `x."_id", x."direction", x."movementType", x."at", x."gate", x."vehicleNumber", x."remarks", x."isLate", x."lateMinutes",
                     x."personName", x."referenceType", (${MOVE_STATE}) AS "state",
                     op."outpassNumber", op."status" AS "outpassStatus", lv."leaveNumber", lv."status" AS "leaveStatus",
                     rb."name" AS "recordedByName", h."_id" AS "hostelId", h."name" AS "hostelName",
                     ${placeCols('p')}, ${studentCols('st')}`,
            sorts: { at: 'x."at"' }, sort: 'at', dir: q.dir, page: q.page, limit: q.limit,
        }),
        pool.query(
            `SELECT count(*)::int AS "residents",
                    count(*) FILTER (WHERE al."presence" = 'in')::int AS "inside",
                    count(*) FILTER (WHERE al."presence" = 'out')::int AS "outside",
                    count(*) FILTER (WHERE al."presence" = 'on_leave')::int AS "onLeave"
               FROM ${TBL.allocations} al
              WHERE al."school" = ${ap.$(school)} AND al."status" = 'active'${inScope('al."hostel"', allowed, ap)}`,
            ap.list,
        ),
        pool.query(
            `SELECT (SELECT count(*) FROM ${T(HostelOutpass)} o WHERE o."school" = ${op.$(school)} AND o."status" IN ('active', 'overdue')${inScope('o."hostel"', allowed, op)})::int AS "activeOutpasses",
                    (SELECT count(*) FROM ${T(HostelOutpass)} o WHERE o."school" = ${op.$(school)} AND o."status" = 'overdue'${inScope('o."hostel"', allowed, op)})::int
                  + (SELECT count(*) FROM ${T(HostelLeave)} l WHERE l."school" = ${op.$(school)} AND l."status" = 'overdue'${inScope('l."hostel"', allowed, op)})::int AS "overdue"`,
            op.list,
        ),
    ]);
    const n = live.residents;
    return {
        ...result,
        tiles: {
            residents: n, inside: live.inside, outside: live.outside, onLeave: live.onLeave,
            activeOutpasses: passes.activeOutpasses, overdue: passes.overdue,
            insidePct: share(live.inside, n, 0), outsidePct: share(live.outside, n, 0), onLeavePct: share(live.onLeave, n, 0),
            activeOutpassesPct: share(passes.activeOutpasses, n, 0), overduePct: share(passes.overdue, n, 0),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Warden & Staff
 *
 *  A row is an ASSIGNMENT — an existing employee holding a post at a hostel —
 *  not a person: someone who is warden of one hostel and assistant at another
 *  is two rows, because they are two jobs with two shifts.
 * ═════════════════════════════════════════════════════════════════════════════ */
const STAFF_ROLES = ['warden', 'assistant_warden', 'caretaker', 'security', 'housekeeping', 'mess_staff', 'maintenance', 'floor_supervisor'];
const STAFF_SHIFTS = ['morning', 'evening', 'night', 'general', 'rotational'];
const STAFF_TABS = {
    all: 'true',
    wardens: `x."role" = 'warden'`,
    assistants: `x."role" = 'assistant_warden'`,
    support: `x."role" NOT IN ('warden', 'assistant_warden')`,
    inactive: `x."status" = 'inactive'`,
};

async function staff(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['u."name"', 'u."email"', 'u."phone"'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid')
                + (STAFF_ROLES.includes(q.role) ? eq('x."role"', q.role, p) : '')
                + (['active', 'inactive'].includes(q.status) ? eq('x."status"', q.status, p) : '')
                + (STAFF_SHIFTS.includes(q.shift) ? eq('x."shift"', q.shift, p) : '');
        }
        const from = `FROM ${T(HostelStaffAssignment)} x
            LEFT JOIN ${TBL.users} u ON u."_id" = x."staff"
            LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
            LEFT JOIN ${TBL.buildings} bl ON bl."_id" = x."building"
            LEFT JOIN ${TBL.floors} fl ON fl."_id" = x."floor"`;
        return { from, where };
    };
    const p = params(); const { from, where } = build(p, true);
    const tp = params(); const t = build(tp, false);
    const month = tp.$(monthStart(0));
    const [result, { rows: [tiles] }] = await Promise.all([
        board({
            p, from, where, tabs: STAFF_TABS, tab: q.tab,
            select: `x."_id", x."role", x."shift", x."shiftStart", x."shiftEnd", x."responsibilities", x."fromDate", x."toDate",
                     x."status", x."remarks", x."staff" AS "staffId", u."name" AS "staffName", u."email" AS "staffEmail",
                     u."phone" AS "staffPhone", u."profileImage" AS "staffPhoto",
                     x."hostel" AS "hostelId", h."name" AS "hostelName", x."building" AS "buildingId", bl."name" AS "buildingName",
                     x."floor" AS "floorId", fl."name" AS "floorName"`,
            sorts: { post: `CASE x."role" WHEN 'warden' THEN 0 WHEN 'assistant_warden' THEN 1 ELSE 2 END, (x."status" <> 'active'), lower(u."name")`,
                joined: 'x."fromDate"', name: 'lower(u."name")' },
            sort: q.sort, dir: q.dir || 'asc', fallback: 'post', page: q.page, limit: q.limit,
        }),
        pool.query(
            `SELECT count(*)::int AS "total",
                    count(*) FILTER (WHERE ${STAFF_TABS.wardens})::int AS "wardens",
                    count(*) FILTER (WHERE ${STAFF_TABS.assistants})::int AS "assistants",
                    count(*) FILTER (WHERE ${STAFF_TABS.support})::int AS "support",
                    count(*) FILTER (WHERE x."fromDate" >= ${month})::int AS "joined",
                    count(*) FILTER (WHERE x."status" = 'inactive' AND x."toDate" >= ${month})::int AS "left"
               ${t.from} WHERE ${t.where}`,
            tp.list,
        ),
    ]);
    return {
        ...result,
        tiles: {
            total: tiles.total, wardens: tiles.wardens, assistants: tiles.assistants, support: tiles.support,
            // Net change this month: who joined, less whose assignment ended.
            change: tiles.joined - tiles.left,
            wardensPct: share(tiles.wardens, tiles.total), assistantsPct: share(tiles.assistants, tiles.total),
            supportPct: share(tiles.support, tiles.total),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Mess
 *
 *  A mess serves a list of hostels (or all of them, when the list is empty). A
 *  warden sees the messes that serve a hostel of theirs.
 * ═════════════════════════════════════════════════════════════════════════════ */
const MESS_HOSTELS = `(CASE WHEN jsonb_typeof(x."hostels") = 'array' THEN x."hostels" ELSE '[]'::jsonb END)`;
const messScope = (allowed, p) => (allowed === null || allowed === undefined ? ''
    : ` AND (jsonb_array_length(${MESS_HOSTELS}) = 0 OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${MESS_HOSTELS}) sc(v) WHERE sc.v = ANY(${p.$(allowed.map(String))}::text[])))`);
const messServes = (hostel, p) => (hostel ? ` AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${MESS_HOSTELS}) sv(v) WHERE sv.v = ${p.$(String(hostel))})` : '');
const MESS_MEALS = ['breakfast', 'lunch', 'snacks', 'dinner'];
const MEAL_KINDS = [...MESS_MEALS, 'special'];
const UNPAID = `('pending', 'partial', 'overdue')`;
/** Has this member an unpaid mess bill? `m` is the alias of the membership row. */
const messDue = (m) => `(SELECT COALESCE(sum(i."netAmount" - i."paidAmount"), 0)::float8 FROM ${T(HostelFeeInvoice)} i
                          WHERE i."school" = ${m}."school" AND i."student" = ${m}."student" AND i."feeType" = 'mess' AND i."status" IN ${UNPAID})`;

/** The meals a membership covers in a day, by its plan and what its mess serves. */
function mealsInPlan(plan, timings) {
    const served = MESS_MEALS.filter((k) => timings?.[k]?.enabled !== false);
    if (plan === 'breakfast_only') return served.includes('breakfast') ? 1 : 0;
    if (plan === 'lunch_dinner') return served.filter((k) => k === 'lunch' || k === 'dinner').length;
    return served.length;
}

/**
 * When the current term began: the active academic year, cut in two. "From last
 * term" on the Total Messes tile counts what was added since then.
 */
async function termStart(school) {
    const { rows: [y] } = await pool.query(
        `SELECT "startDate", "endDate" FROM ${T(AcademicYear)} WHERE "school" = $1 AND "status" = 'active'
          ORDER BY "startDate" DESC NULLS LAST LIMIT 1`, [String(school)]);
    const now = Date.now();
    const start = y?.startDate ? new Date(y.startDate).getTime() : null;
    const end = y?.endDate ? new Date(y.endDate).getTime() : null;
    if (start && end && start <= now) {
        const mid = start + (end - start) / 2;
        return new Date(now >= mid ? mid : start);
    }
    return monthStart(6);
}

async function messTiles(school, allowed) {
    const day = dayRange();
    const p = params();
    const $school = p.$(school);
    const scope = messScope(allowed, p);
    const term = await termStart(school);
    const [{ rows: messes }, { rows: plans }, { rows: [a] }, { rows: [e] }, { rows: [d] }] = await Promise.all([
        pool.query(`SELECT x."_id", x."capacity", x."mealTimings", x."createdAt" FROM ${T(HostelMess)} x
                     WHERE x."school" = ${$school} AND x."isActive"${scope}`, p.list),
        pool.query(`SELECT m."mess", m."mealPlan", count(*)::int AS "n" FROM ${T(HostelMessMember)} m
                     JOIN ${T(HostelMess)} x ON x."_id" = m."mess" AND x."isActive"
                    WHERE m."school" = ${$school} AND m."status" = 'active'${scope} GROUP BY 1, 2`, p.list),
        (() => { const q = params(); const s1 = q.$(school); const sc = messScope(allowed, q);
            return pool.query(`SELECT (count(*) FILTER (WHERE at."status" = 'taken') + COALESCE(sum(at."guestCount"), 0))::int AS "served"
                                 FROM ${T(HostelMessAttendance)} at JOIN ${T(HostelMess)} x ON x."_id" = at."mess" AND x."isActive"
                                WHERE at."school" = ${s1}${sc} AND at."date" >= ${q.$(day.start)} AND at."date" < ${q.$(day.end)}`, q.list); })(),
        (() => { const q = params(); const s1 = q.$(school); const sc = messScope(allowed, q); const m0 = q.$(monthStart(0)); const m1 = q.$(monthStart(1));
            return pool.query(`SELECT COALESCE(sum(ex."amount") FILTER (WHERE ex."date" >= ${m0}), 0)::float8 AS "now",
                                      COALESCE(sum(ex."amount") FILTER (WHERE ex."date" >= ${m1} AND ex."date" < ${m0}), 0)::float8 AS "prev"
                                 FROM ${T(HostelMessExpense)} ex JOIN ${T(HostelMess)} x ON x."_id" = ex."mess" AND x."isActive"
                                WHERE ex."school" = ${s1}${sc}`, q.list); })(),
        (() => { const q = params(); const s1 = q.$(school); const sc = messScope(allowed, q);
            return pool.query(`SELECT count(DISTINCT m."student")::int AS "n" FROM ${T(HostelMessMember)} m
                                 JOIN ${T(HostelMess)} x ON x."_id" = m."mess" AND x."isActive"
                                WHERE m."school" = ${s1} AND m."status" = 'active'${sc} AND ${messDue('m')} > 0`, q.list); })(),
    ]);
    const timings = Object.fromEntries(messes.map((m) => [String(m._id), m.mealTimings]));
    const members = plans.reduce((n, r) => n + r.n, 0);
    const planned = plans.reduce((n, r) => n + r.n * mealsInPlan(r.mealPlan, timings[String(r.mess)]), 0);
    const capacity = messes.reduce((n, m) => n + (Number(m.capacity) || 0), 0);
    return {
        messes: messes.length, newThisTerm: messes.filter((m) => new Date(m.createdAt) >= term).length,
        members, capacity, occupancyPct: share(members, capacity, 0),
        served: a.served, planned, servedPct: share(a.served, planned, 0),
        expenses: e.now, expensesLast: e.prev, expensesPct: e.prev ? Math.round(((e.now - e.prev) / e.prev) * 100) : null,
        dues: d.n, duesPct: share(d.n, members),
    };
}

async function mess(req, { school, allowed, q }) {
    const p = params();
    let where = `x."school" = ${p.$(school)} AND x."isActive"${messScope(allowed, p)}`;
    where += search(['x."name"', 'x."code"', 'ic."name"'], q.search, p) + messServes(q.hostel, p)
        + (['active', 'inactive'].includes(q.status) ? eq('x."status"', q.status, p) : '')
        + (['veg', 'non_veg', 'both'].includes(q.messType) ? eq('x."messType"', q.messType, p) : '');
    const m0 = p.$(monthStart(0)); const m1 = p.$(monthStart(1));
    const from = `FROM ${T(HostelMess)} x
        LEFT JOIN ${TBL.users} ic ON ic."_id" = x."inCharge"
        LEFT JOIN LATERAL (SELECT count(*)::int AS "n" FROM ${T(HostelMessMember)} m WHERE m."mess" = x."_id" AND m."status" = 'active') mm ON true
        LEFT JOIN LATERAL (
            SELECT COALESCE(sum(ex."amount") FILTER (WHERE ex."date" >= ${m0}), 0)::float8 AS "now",
                   COALESCE(sum(ex."amount") FILTER (WHERE ex."date" >= ${m1} AND ex."date" < ${m0}), 0)::float8 AS "prev"
              FROM ${T(HostelMessExpense)} ex WHERE ex."mess" = x."_id") ex ON true`;
    const [result, tiles] = await Promise.all([
        board({
            p, from, where,
            select: `x."_id", x."name", x."code", x."messType", x."capacity", x."location", x."status", x."mealTimings", x."vendorName",
                     x."vendorContact", x."vendorEmail", x."contractFrom", x."contractTo", x."contractAmount",
                     x."inCharge" AS "inChargeId", ic."name" AS "inChargeName", ic."phone" AS "inChargePhone", ic."profileImage" AS "inChargePhoto",
                     ${MESS_HOSTELS} AS "hostels",
                     (SELECT COALESCE(json_agg(hh."name" ORDER BY lower(hh."name")), '[]'::json) FROM ${TBL.hostels} hh
                       WHERE hh."_id"::text IN (SELECT jsonb_array_elements_text(${MESS_HOSTELS}))) AS "hostelNames",
                     mm."n" AS "members", ex."now" AS "monthCost", ex."prev" AS "lastMonthCost"`,
            sorts: { name: 'lower(x."name")' }, sort: 'name', dir: 'asc', page: q.page, limit: q.limit,
        }),
        messTiles(school, allowed),
    ]);
    result.rows.forEach((r) => {
        r.costPct = r.lastMonthCost ? Math.round(((r.monthCost - r.lastMonthCost) / r.lastMonthCost) * 100) : null;
        r.memberPct = share(r.members, r.capacity, 0);
    });
    return { ...result, tiles };
}

/** Everyone enrolled in a mess. */
async function messMembers(req, { school, allowed, q }) {
    const p = params();
    let where = `m."school" = ${p.$(school)} AND x."isActive"${messScope(allowed, p)}`;
    where += search(['st."name"', 'stp."rollNumber"', 'stp."admissionNumber"'], q.search, p)
        + eq('m."mess"', q.mess, p, '::uuid') + eq('m."hostel"', q.hostel, p, '::uuid')
        + (['veg', 'non_veg', 'vegan', 'jain', 'eggetarian', 'other'].includes(q.foodPreference) ? eq('m."foodPreference"', q.foodPreference, p) : '')
        + (['active', 'suspended', 'ended'].includes(q.status) ? eq('m."status"', q.status, p) : (q.status === 'all' ? '' : ` AND m."status" = 'active'`));
    if (q.dues === '1' || q.dues === 'true') where += ` AND ${messDue('m')} > 0`;
    const from = `FROM ${T(HostelMessMember)} m
        JOIN ${T(HostelMess)} x ON x."_id" = m."mess"
        ${studentJoin('st', 'm."student"')}
        LEFT JOIN ${TBL.hostels} h ON h."_id" = m."hostel"
        ${currentPlaceJoin('cp', 'm."student"')}
        ${placeJoin('p', { building: 'cp."building"', room: 'cp."room"', bed: 'cp."bed"' })}`;
    return board({
        p, from, where,
        select: `m."_id", m."mess" AS "messId", x."name" AS "messName", m."foodPreference", m."allergies", m."dietaryNotes", m."mealPlan",
                 m."fromDate", m."toDate", m."status", h."name" AS "hostelName", ${messDue('m')} AS "dueAmount",
                 ${placeCols('p')}, ${studentCols('st')}`,
        sorts: { name: 'lower(st."name")', since: 'm."fromDate"' }, sort: q.sort, dir: q.dir || 'asc', fallback: 'name', page: q.page, limit: q.limit,
    });
}

/** One meal's register: every active member of a mess, and what is marked. */
async function messAttendance(req, { school, allowed, q }) {
    const p = params();
    const $school = p.$(school);
    const scope = messScope(allowed, p);
    const { rows: list } = await pool.query(
        `SELECT x."_id", x."name", x."mealTimings" FROM ${T(HostelMess)} x WHERE x."school" = ${$school} AND x."isActive"${scope} ORDER BY lower(x."name")`, p.list);
    const chosen = list.find((m) => String(m._id) === String(q.mess)) || list[0] || null;
    const meal = MEAL_KINDS.includes(q.meal) ? q.meal : 'lunch';
    const { start, end } = dayRange(q.date);
    const base = { messes: list.map((m) => ({ _id: String(m._id), name: m.name })), mess: chosen ? String(chosen._id) : null, meal, date: start,
        timing: chosen?.mealTimings?.[meal] || null };
    if (!chosen) return { ...base, rows: [], total: 0, saved: 0 };
    const rp = params();
    const { rows } = await pool.query(
        `SELECT m."_id" AS "memberId", m."foodPreference", m."allergies", m."mealPlan",
                at."_id" AS "recordId", at."status" AS "recordStatus", at."guestCount", at."remarks" AS "recordRemarks",
                COALESCE(at."selfMarked", false) AS "selfMarked",
                (lv."_id" IS NOT NULL) AS "onLeave", ${placeCols('p')}, ${studentCols('st')}
           FROM ${T(HostelMessMember)} m
           ${studentJoin('st', 'm."student"')}
           ${currentPlaceJoin('cp', 'm."student"')}
           ${placeJoin('p', { building: 'cp."building"', room: 'cp."room"', bed: 'cp."bed"' })}
           LEFT JOIN ${T(HostelMessAttendance)} at ON at."student" = m."student" AND at."school" = m."school"
                AND at."meal" = ${rp.$(meal)} AND at."date" >= ${rp.$(start)} AND at."date" < ${rp.$(end)}
           LEFT JOIN LATERAL (SELECT l."_id" FROM ${T(HostelLeave)} l
                               WHERE l."student" = m."student" AND l."school" = m."school" AND l."status" IN ('approved', 'active')
                                 AND l."fromDate" < ${rp.$(end)} AND l."toDate" >= ${rp.$(start)} LIMIT 1) lv ON true
          WHERE m."school" = ${rp.$(school)} AND m."mess" = ${rp.$(String(chosen._id))}::uuid AND m."status" = 'active'
          ORDER BY lower(st."name")`,
        rp.list,
    );
    rows.forEach((r) => { r.suggested = r.onLeave ? 'on_leave' : 'taken'; });
    return { ...base, rows, total: rows.length, saved: rows.filter((r) => r.recordId).length };
}

const EXPENSE_CATS = ['groceries', 'vegetables', 'dairy', 'gas', 'vendor_bill', 'salary', 'equipment', 'other'];
async function messExpenses(req, { school, allowed, q }) {
    // The summary is for the chosen mess and dates; the category filter and the
    // search narrow only the rows, so a category card never hides its siblings.
    const build = (p, rowsOnly) => {
        let where = `ex."school" = ${p.$(school)} AND x."isActive"${messScope(allowed, p)}`;
        where += eq('ex."mess"', q.mess, p, '::uuid') + between('ex."date"', q.from, q.to, p);
        if (rowsOnly) {
            where += search(['ex."description"', 'ex."vendorName"', 'ex."invoiceNumber"'], q.search, p)
                + (EXPENSE_CATS.includes(q.category) ? eq('ex."category"', q.category, p) : '');
        }
        const from = `FROM ${T(HostelMessExpense)} ex
            JOIN ${T(HostelMess)} x ON x."_id" = ex."mess"
            LEFT JOIN ${TBL.users} rb ON rb."_id" = ex."recordedBy"`;
        return { from, where };
    };
    const p = params(); const { from, where } = build(p, true);
    const sp = params(); const sm = build(sp, false);
    const [result, { rows: cats }] = await Promise.all([
        board({
            p, from, where,
            select: `ex."_id", ex."date", ex."category", ex."description", ex."amount"::float8 AS "amount", ex."vendorName", ex."invoiceNumber",
                     ex."mess" AS "messId", x."name" AS "messName", rb."name" AS "recordedByName"`,
            sorts: { date: 'ex."date"', amount: 'ex."amount"' }, sort: q.sort, dir: q.dir, fallback: 'date', page: q.page, limit: q.limit,
        }),
        pool.query(`SELECT ex."category", sum(ex."amount")::float8 AS "total", count(*)::int AS "n" ${sm.from} WHERE ${sm.where} GROUP BY 1 ORDER BY 2 DESC`, sp.list),
    ]);
    return { ...result, summary: { byCategory: cats, total: cats.reduce((n, c) => n + c.total, 0), entries: cats.reduce((n, c) => n + c.n, 0) } };
}

/** Reports & Analytics: a month of each mess, and six months of what it cost. */
async function messReport(req, { school, allowed, q }) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(q.month || ''));
    const now = new Date();
    const first = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
    const next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
    const six = new Date(first.getFullYear(), first.getMonth() - 5, 1);

    const p = params();
    const $school = p.$(school); const scope = messScope(allowed, p); const pick = eq('x."_id"', q.mess, p, '::uuid');
    const $first = p.$(first); const $next = p.$(next);
    const { rows: perMess } = await pool.query(
        `SELECT x."_id", x."name", x."capacity", mm."n" AS "members",
                at."served", at."skipped", at."onLeave", at."guests", ex."total"::float8 AS "expenses"
           FROM ${T(HostelMess)} x
           LEFT JOIN LATERAL (SELECT count(*)::int AS "n" FROM ${T(HostelMessMember)} m WHERE m."mess" = x."_id" AND m."status" = 'active') mm ON true
           LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE a."status" = 'taken')::int AS "served",
                                     count(*) FILTER (WHERE a."status" = 'skipped')::int AS "skipped",
                                     count(*) FILTER (WHERE a."status" = 'on_leave')::int AS "onLeave",
                                     COALESCE(sum(a."guestCount"), 0)::int AS "guests"
                                FROM ${T(HostelMessAttendance)} a WHERE a."mess" = x."_id" AND a."date" >= ${$first} AND a."date" < ${$next}) at ON true
           LEFT JOIN LATERAL (SELECT COALESCE(sum(e."amount"), 0) AS "total" FROM ${T(HostelMessExpense)} e
                               WHERE e."mess" = x."_id" AND e."date" >= ${$first} AND e."date" < ${$next}) ex ON true
          WHERE x."school" = ${$school} AND x."isActive"${scope}${pick}
          ORDER BY lower(x."name")`,
        p.list,
    );
    perMess.forEach((r) => {
        r.meals = r.served + r.guests;
        r.attendancePct = share(r.served, r.served + r.skipped, 0);
        r.costPerMeal = r.meals ? Math.round((r.expenses / r.meals) * 100) / 100 : null;
    });

    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const sub = (extra) => { const s = params(); const s1 = s.$(school); const sc = messScope(allowed, s); const pk = eq('x."_id"', q.mess, s, '::uuid');
        return { s, where: `x."school" = ${s1} AND x."isActive"${sc}${pk}`, ...extra(s) }; };
    const c = sub((s) => ({ a: s.$(first), b: s.$(next) }));
    const tr = sub((s) => ({ a: s.$(six), b: s.$(next), z: s.$(zone) }));
    const mt = sub((s) => ({ a: s.$(six), b: s.$(next), z: s.$(zone) }));
    const pf = sub(() => ({}));
    const [{ rows: cats }, { rows: spend }, { rows: meals }, { rows: prefs }] = await Promise.all([
        pool.query(`SELECT e."category", sum(e."amount")::float8 AS "total" FROM ${T(HostelMessExpense)} e JOIN ${T(HostelMess)} x ON x."_id" = e."mess"
                     WHERE ${c.where} AND e."date" >= ${c.a} AND e."date" < ${c.b} GROUP BY 1 ORDER BY 2 DESC`, c.s.list),
        pool.query(`SELECT to_char(e."date" AT TIME ZONE ${tr.z}, 'YYYY-MM') AS "ym", sum(e."amount")::float8 AS "total"
                      FROM ${T(HostelMessExpense)} e JOIN ${T(HostelMess)} x ON x."_id" = e."mess"
                     WHERE ${tr.where} AND e."date" >= ${tr.a} AND e."date" < ${tr.b} GROUP BY 1`, tr.s.list),
        pool.query(`SELECT to_char(a."date" AT TIME ZONE ${mt.z}, 'YYYY-MM') AS "ym",
                           (count(*) FILTER (WHERE a."status" = 'taken') + COALESCE(sum(a."guestCount"), 0))::int AS "meals"
                      FROM ${T(HostelMessAttendance)} a JOIN ${T(HostelMess)} x ON x."_id" = a."mess"
                     WHERE ${mt.where} AND a."date" >= ${mt.a} AND a."date" < ${mt.b} GROUP BY 1`, mt.s.list),
        pool.query(`SELECT mb."foodPreference", count(*)::int AS "n" FROM ${T(HostelMessMember)} mb JOIN ${T(HostelMess)} x ON x."_id" = mb."mess"
                     WHERE ${pf.where} AND mb."status" = 'active' GROUP BY 1 ORDER BY 2 DESC`, pf.s.list),
    ]);
    const spendBy = Object.fromEntries(spend.map((r) => [r.ym, r.total]));
    const mealsBy = Object.fromEntries(meals.map((r) => [r.ym, r.meals]));
    const trend = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(first.getFullYear(), first.getMonth() - i, 1);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        trend.push({ key: ym, year: d.getFullYear(), month: d.getMonth() + 1, expenses: spendBy[ym] || 0, meals: mealsBy[ym] || 0 });
    }
    const tot = perMess.reduce((t, r) => ({ members: t.members + r.members, meals: t.meals + r.meals, served: t.served + r.served,
        skipped: t.skipped + r.skipped, expenses: t.expenses + r.expenses }), { members: 0, meals: 0, served: 0, skipped: 0, expenses: 0 });
    return {
        month: `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`,
        messes: perMess, byCategory: cats, trend, preferences: prefs,
        totals: { ...tot, attendancePct: share(tot.served, tot.served + tot.skipped, 0), costPerMeal: tot.meals ? Math.round((tot.expenses / tot.meals) * 100) / 100 : null },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Fees
 *
 *  One set of figures for all six views, and they add up: every rupee billed is
 *  either kept (collected), still owed (outstanding) or handed back (refunded).
 *  "Collected" is therefore what was paid LESS what was refunded — a deposit
 *  returned to a family is not money the hostel collected.
 * ═════════════════════════════════════════════════════════════════════════════ */
const FEE_TYPES = ['admission', 'monthly', 'quarterly', 'annual', 'mess', 'laundry', 'electricity',
    'maintenance', 'security_deposit', 'fine', 'late_fee', 'other'];
const FEE_STATUSES = ['pending', 'partial', 'paid', 'overdue', 'cancelled', 'refunded'];
const PAY_MODES = ['cash', 'cheque', 'online', 'upi', 'card', 'bank_transfer'];
/** The month an invoice bills for: its period, else the month it falls due. */
const billedYm = (zone) => `CASE WHEN (x."period"->>'year') ~ '^[0-9]{4}$' AND (x."period"->>'month') ~ '^[0-9]{1,2}$'
        THEN (x."period"->>'year') || '-' || lpad(x."period"->>'month', 2, '0')
        ELSE to_char(COALESCE(x."dueDate", x."createdAt") AT TIME ZONE ${zone}, 'YYYY-MM') END`;
const ymOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const BALANCE = `GREATEST(COALESCE(x."netAmount", 0) - COALESCE(x."paidAmount", 0), 0)`;
const OWED = `x."status" IN ${UNPAID}`;

/** An invoice's student, and the room the invoice was raised against (else where they live now). */
const invoiceFrom = `FROM ${T(HostelFeeInvoice)} x
        ${studentJoin('st', 'x."student"')}
        LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
        LEFT JOIN ${TBL.allocations} ia ON ia."_id" = x."allocation"
        ${currentPlaceJoin('cp', 'x."student"')}
        ${placeJoin('p', { building: 'COALESCE(ia."building", cp."building")', room: 'COALESCE(ia."room", cp."room")', bed: 'COALESCE(ia."bed", cp."bed")' })}`;
const INVOICE_COLS = `x."_id", x."invoiceNumber", x."feeType", x."period", x."amount"::float8 AS "amount", x."discount"::float8 AS "discount",
        x."discountReason", x."lateFee"::float8 AS "lateFee", x."netAmount"::float8 AS "netAmount", x."paidAmount"::float8 AS "paidAmount",
        x."refundedAmount"::float8 AS "refundedAmount", (${BALANCE})::float8 AS "balance", x."dueDate", x."status", x."isRefundable",
        x."refundedAt", x."refundReference", x."payments", x."refunds", x."remarks", x."createdAt",
        h."_id" AS "hostelId", h."name" AS "hostelName", ${placeCols('p')}, ${studentCols('st')}`;

async function feeTiles(school, allowed) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const p = params();
    const where = `x."school" = ${p.$(school)} AND x."status" <> 'cancelled'${inScope('x."hostel"', allowed, p)}`;
    const ym = billedYm(p.$(zone));
    const now = p.$(ymOf(monthStart(0))); const prev = p.$(ymOf(monthStart(1)));
    const { rows: [t] } = await pool.query(
        `SELECT COALESCE(sum(x."netAmount"), 0)::float8 AS "billed",
                COALESCE(sum(x."paidAmount"), 0)::float8 AS "paid",
                COALESCE(sum(x."refundedAmount"), 0)::float8 AS "refunded",
                COALESCE(sum(${BALANCE}) FILTER (WHERE ${OWED}), 0)::float8 AS "outstanding",
                COALESCE(sum(x."netAmount") FILTER (WHERE ${ym} = ${now}), 0)::float8 AS "billedNow",
                COALESCE(sum(x."netAmount") FILTER (WHERE ${ym} = ${prev}), 0)::float8 AS "billedPrev",
                count(*)::int AS "invoices", count(*) FILTER (WHERE ${OWED})::int AS "owing",
                count(*) FILTER (WHERE x."status" = 'overdue')::int AS "overdue"
           FROM ${T(HostelFeeInvoice)} x WHERE ${where}`,
        p.list,
    );
    const collected = Math.max(0, t.paid - t.refunded);
    return {
        billed: t.billed, collected, outstanding: t.outstanding, refunded: t.refunded,
        invoices: t.invoices, owing: t.owing, overdue: t.overdue,
        billedPct: t.billedPrev ? Math.round(((t.billedNow - t.billedPrev) / t.billedPrev) * 100) : null,
        collectedPct: share(collected, t.billed), outstandingPct: share(t.outstanding, t.billed), refundedPct: share(t.refunded, t.billed),
    };
}

/** Filters every invoice view shares. `dateCol` is what the date range means on that view. */
function invoiceFilters(q, p, dateCol = 'COALESCE(x."dueDate", x."createdAt")') {
    return search(['st."name"', 'stp."rollNumber"', 'stp."admissionNumber"', 'x."invoiceNumber"'], q.search, p)
        + eq('x."hostel"', q.hostel, p, '::uuid') + eq('stp."currentClass"', q.class, p, '::uuid')
        + eq('x."student"', q.student, p, '::uuid') + eq('x."academicYear"', q.academicYear, p, '::uuid')
        + (FEE_TYPES.includes(q.feeType) ? eq('x."feeType"', q.feeType, p) : '')
        + between(dateCol, q.from, q.to, p);
}

async function fees(req, { school, allowed, q }) {
    const p = params();
    let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
    // One invoice by its id — what the drawer asks for, whatever list it was opened from.
    where += /^[0-9a-f-]{36}$/i.test(String(q.id || '')) ? eq('x."_id"', q.id, p, '::uuid') : invoiceFilters(q, p);
    if (FEE_STATUSES.includes(q.status)) where += eq('x."status"', q.status, p);
    if (q.discounted === '1') where += ` AND x."discount" > 0`;
    const [result, tiles] = await Promise.all([
        board({
            p, from: invoiceFrom, where, select: INVOICE_COLS,
            sorts: { due: 'COALESCE(x."dueDate", x."createdAt")', created: 'x."createdAt"', amount: 'x."netAmount"', student: 'lower(st."name")' },
            sort: q.sort, dir: q.dir, fallback: 'created', page: q.page, limit: q.limit,
        }),
        feeTiles(school, allowed),
    ]);
    return { ...result, tiles };
}

/** What is still owed, oldest debt first, and how old it is. */
const OUTSTANDING_TABS = {
    all: 'true',
    overdue: `x."dueDate" IS NOT NULL AND x."dueDate" < now()`,
    upcoming: `x."dueDate" IS NULL OR x."dueDate" >= now()`,
    partial: `x."paidAmount" > 0`,
};
async function feeOutstanding(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)} AND ${OWED}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) where += invoiceFilters(q, p);
        return where;
    };
    const p = params(); const where = build(p, true);
    const ap = params(); const all = build(ap, false);
    const [result, { rows: [age] }] = await Promise.all([
        board({
            p, from: invoiceFrom, where, tabs: OUTSTANDING_TABS, tab: q.tab,
            select: `${INVOICE_COLS}, GREATEST(0, floor(extract(epoch FROM (now() - x."dueDate")) / 86400))::int AS "daysOverdue"`,
            sorts: { due: 'x."dueDate"', balance: BALANCE, student: 'lower(st."name")' },
            sort: q.sort, dir: q.dir || 'asc', fallback: 'due', page: q.page, limit: q.limit,
        }),
        pool.query(
            `SELECT COALESCE(sum(${BALANCE}), 0)::float8 AS "total", count(DISTINCT x."student")::int AS "students",
                    COALESCE(sum(${BALANCE}) FILTER (WHERE x."dueDate" IS NULL OR x."dueDate" >= now()), 0)::float8 AS "notDue",
                    COALESCE(sum(${BALANCE}) FILTER (WHERE x."dueDate" < now() AND x."dueDate" >= now() - interval '30 days'), 0)::float8 AS "d30",
                    COALESCE(sum(${BALANCE}) FILTER (WHERE x."dueDate" < now() - interval '30 days' AND x."dueDate" >= now() - interval '60 days'), 0)::float8 AS "d60",
                    COALESCE(sum(${BALANCE}) FILTER (WHERE x."dueDate" < now() - interval '60 days'), 0)::float8 AS "older"
               FROM ${T(HostelFeeInvoice)} x WHERE ${all}`,
            ap.list,
        ),
    ]);
    return { ...result, summary: age };
}

/** Money handed back: every invoice with a refund on it. */
async function feeRefunds(req, { school, allowed, q }) {
    const p = params();
    const where = `x."school" = ${p.$(school)} AND COALESCE(x."refundedAmount", 0) > 0${inScope('x."hostel"', allowed, p)}`
        + invoiceFilters(q, p, 'COALESCE(x."refundedAt", x."updatedAt")');
    const sp = params();
    const all = `x."school" = ${sp.$(school)} AND COALESCE(x."refundedAmount", 0) > 0${inScope('x."hostel"', allowed, sp)}`;
    const [result, { rows: [sum] }] = await Promise.all([
        board({
            p, from: invoiceFrom, where, select: INVOICE_COLS,
            sorts: { at: 'COALESCE(x."refundedAt", x."updatedAt")' }, sort: 'at', dir: q.dir, page: q.page, limit: q.limit,
        }),
        pool.query(`SELECT COALESCE(sum(x."refundedAmount"), 0)::float8 AS "total", count(*)::int AS "invoices",
                           COALESCE(sum(x."refundedAmount") FILTER (WHERE x."feeType" = 'security_deposit'), 0)::float8 AS "deposits"
                      FROM ${T(HostelFeeInvoice)} x WHERE ${all}`, sp.list),
    ]);
    return { ...result, summary: sum };
}

/**
 * Every payment received — one row per payment, not per invoice, because an
 * invoice paid in three instalments is three receipts.
 */
const PAYMENTS = `CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x."payments") = 'array' THEN x."payments" ELSE '[]'::jsonb END) pay`;
const PAID_AT = `(CASE WHEN (pay->>'paidAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (pay->>'paidAt')::timestamptz END)`;
const PAID_AMOUNT = `(CASE WHEN (pay->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (pay->>'amount')::float8 ELSE 0 END)`;
async function feeCollections(req, { school, allowed, q }) {
    const build = (p, rowsOnly) => {
        let where = `x."school" = ${p.$(school)} AND x."status" <> 'cancelled'${inScope('x."hostel"', allowed, p)}`
            + eq('x."hostel"', q.hostel, p, '::uuid') + between(PAID_AT, q.from, q.to, p);
        if (rowsOnly) {
            where += search(['st."name"', 'stp."rollNumber"', 'x."invoiceNumber"', `pay->>'receiptNumber'`, `pay->>'reference'`], q.search, p)
                + (PAY_MODES.includes(q.mode) ? ` AND pay->>'mode' = ${p.$(q.mode)}` : '')
                + (FEE_TYPES.includes(q.feeType) ? eq('x."feeType"', q.feeType, p) : '');
        }
        return where;
    };
    // A counter payment names its cashier; an online one names whoever paid it.
    const from = `${invoiceFrom} ${PAYMENTS} LEFT JOIN ${TBL.users} rb ON rb."_id"::text = pay->>'receivedBy'
        LEFT JOIN ${TBL.users} payer ON payer."_id"::text = pay->>'paidBy'`;
    const p = params(); const where = build(p, true);
    const sp = params(); const sw = build(sp, false);
    const [result, { rows: modes }] = await Promise.all([
        board({
            p, from, where,
            select: `(x."_id"::text || ':' || COALESCE(pay->>'_id', pay->>'receiptNumber', '')) AS "_id", x."_id" AS "invoiceId",
                     x."invoiceNumber", x."feeType", x."period", ${PAID_AMOUNT} AS "amount", pay->>'mode' AS "mode",
                     pay->>'reference' AS "reference", pay->>'receiptNumber' AS "receiptNumber", pay->>'note' AS "note",
                     ${PAID_AT} AS "paidAt", rb."name" AS "receivedByName", payer."name" AS "paidByName",
                     h."name" AS "hostelName", ${placeCols('p')}, ${studentCols('st')}`,
            sorts: { at: PAID_AT, amount: PAID_AMOUNT }, sort: q.sort, dir: q.dir, fallback: 'at', page: q.page, limit: q.limit,
        }),
        pool.query(`SELECT COALESCE(pay->>'mode', 'cash') AS "mode", sum(${PAID_AMOUNT})::float8 AS "total", count(*)::int AS "n"
                      ${from} WHERE ${sw} GROUP BY 1 ORDER BY 2 DESC`, sp.list),
    ]);
    return { ...result, summary: { byMode: modes, total: modes.reduce((n, m) => n + m.total, 0), receipts: modes.reduce((n, m) => n + m.n, 0) } };
}

/** The four figures on their own — the Fees screen shows them over every one of its views. */
async function feeSummary(req, { school, allowed }) {
    return { tiles: await feeTiles(school, allowed) };
}

/** The fee plans, each with what it has billed — also what the Rate Cards view is drawn from. */
async function feePlans(req, { school, allowed, q }) {
    const p = params();
    let where = `x."school" = ${p.$(school)} AND x."isActive"`;
    if (allowed !== null) where += ` AND (x."hostel" IS NULL OR x."hostel" = ANY(${p.$(allowed.map(String))}::uuid[]))`;
    where += search(['x."name"', 'x."description"'], q.search, p) + eq('x."hostel"', q.hostel, p, '::uuid')
        + (FEE_TYPES.includes(q.feeType) ? eq('x."feeType"', q.feeType, p) : '')
        + (['flat', 'room_type'].includes(q.basis) ? eq('x."basis"', q.basis, p) : '');
    const from = `FROM ${T(HostelFeePlan)} x
        LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
        LEFT JOIN LATERAL (SELECT count(*)::int AS "n", COALESCE(sum(i."netAmount"), 0)::float8 AS "billed", max(i."createdAt") AS "last"
                             FROM ${T(HostelFeeInvoice)} i WHERE i."feePlan" = x."_id" AND i."status" <> 'cancelled') inv ON true`;
    return board({
        p, from, where,
        select: `x."_id", x."name", x."feeType", x."basis", x."amount"::float8 AS "amount", x."roomTypeRates", x."frequency", x."dueDayOfMonth",
                 x."isRefundable", x."description", x."status", x."hostel" AS "hostelId", h."name" AS "hostelName",
                 CASE WHEN x."appliesTo" IN ('teacher', 'both') THEN x."appliesTo" ELSE 'student' END AS "appliesTo",
                 inv."n" AS "invoices", inv."billed", inv."last" AS "lastBilledAt"`,
        sorts: { name: 'lower(x."name")' }, sort: 'name', dir: 'asc', page: q.page, limit: q.limit || 100,
    });
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Complaints
 * ═════════════════════════════════════════════════════════════════════════════ */
const COMPLAINT_CATS = ['room', 'mess', 'cleaning', 'security', 'maintenance', 'staff', 'food', 'facilities', 'internet', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const COMPLAINT_LIVE = `x."status" NOT IN ('resolved', 'closed', 'rejected')`;
/** Past its SLA and still not dealt with. */
const COMPLAINT_OVERDUE = `(x."dueAt" IS NOT NULL AND x."dueAt" < now() AND ${COMPLAINT_LIVE})`;
const COMPLAINT_TABS = {
    all: 'true',
    open: `x."status" IN ('open', 'assigned')`,
    progress: `x."status" = 'in_progress'`,
    // Dealt with — whether or not the student has signed it off yet.
    resolved: `x."status" IN ('resolved', 'closed')`,
    reopened: `x."status" = 'reopened'`,
    closed: `x."status" = 'closed'`,
    rejected: `x."status" = 'rejected'`,
};

async function complaints(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['x."ticketNumber"', 'x."subject"', 'x."description"', 'st."name"', 'stp."rollNumber"'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid') + eq('x."student"', q.student, p, '::uuid') + eq('x."assignedTo"', q.assignedTo, p, '::uuid')
                + (COMPLAINT_CATS.includes(q.category) ? eq('x."category"', q.category, p) : '')
                + (PRIORITIES.includes(q.priority) ? eq('x."priority"', q.priority, p) : '')
                + between('x."createdAt"', q.from, q.to, p);
            if (q.status === 'overdue') where += ` AND ${COMPLAINT_OVERDUE}`;
            else if (q.status === 'escalated') where += ` AND x."escalationLevel" > 0`;
            else if (COMPLAINT_TABS[q.status] && q.status !== 'all') where += ` AND (${COMPLAINT_TABS[q.status]})`;
        }
        const from = `FROM ${T(HostelComplaint)} x
            ${studentJoin('st', 'x."student"')}
            LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
            LEFT JOIN ${TBL.rooms} rm ON rm."_id" = x."room"
            LEFT JOIN ${TBL.buildings} bl ON bl."_id" = rm."building"
            LEFT JOIN ${TBL.users} au ON au."_id" = x."assignedTo"
            LEFT JOIN ${TBL.users} rb ON rb."_id" = x."raisedBy"`;
        return { from, where };
    };
    const p = params(); const { from, where } = build(p, true);
    const tp = params(); const t = build(tp, false);
    const dp = params(); const d = build(dp, false);
    const [result, tiles, delta] = await Promise.all([
        board({
            p, from, where, tabs: COMPLAINT_TABS, tab: q.tab,
            select: `x."_id", x."ticketNumber", x."category", x."priority", x."subject", x."description", x."status", x."createdAt", x."dueAt",
                     x."resolutionDate", x."escalationLevel", x."reopenCount", x."rating", x."raisedByRole", ${COMPLAINT_OVERDUE} AS "overdue",
                     h."_id" AS "hostelId", h."name" AS "hostelName", rm."roomNumber", bl."code" AS "buildingCode", bl."name" AS "buildingName",
                     au."_id" AS "assignedId", au."name" AS "assignedName", au."profileImage" AS "assignedPhoto",
                     rb."name" AS "raisedByName", ${studentCols('st')}`,
            sorts: { created: 'x."createdAt"', due: 'x."dueAt"', priority: `array_position(ARRAY['urgent','high','medium','low'], x."priority")` },
            sort: q.sort, dir: q.dir, fallback: 'created', page: q.page, limit: q.limit,
        }),
        counts(tp, t.from, t.where, { total: 'true', resolved: COMPLAINT_TABS.resolved, progress: COMPLAINT_TABS.progress,
            overdue: COMPLAINT_OVERDUE, reopened: COMPLAINT_TABS.reopened }),
        monthDelta(dp, d.from, d.where, 'x."createdAt"'),
    ]);
    return {
        ...result,
        tiles: {
            ...tiles, delta,
            resolvedPct: share(tiles.resolved, tiles.total), progressPct: share(tiles.progress, tiles.total),
            overduePct: share(tiles.overdue, tiles.total), reopenedPct: share(tiles.reopened, tiles.total),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Maintenance
 *
 *  A work order is listed under ONE state, so the tabs add up to the total:
 *  done, cancelled, late, being worked on, booked for a later day, or open.
 * ═════════════════════════════════════════════════════════════════════════════ */
const MAINT_CATS = ['electrical', 'plumbing', 'furniture', 'fan', 'ac', 'internet', 'cleaning', 'room', 'bathroom', 'common_area', 'other'];
const MAINT_TYPES = ['corrective', 'preventive', 'scheduled'];
const maintState = (today) => `CASE
        WHEN x."status" = 'completed'                                      THEN 'completed'
        WHEN x."status" = 'cancelled'                                      THEN 'cancelled'
        WHEN x."scheduledDate" IS NOT NULL AND x."scheduledDate" < ${today} THEN 'overdue'
        WHEN x."status" IN ('in_progress', 'on_hold')                      THEN 'progress'
        WHEN x."maintenanceType" IN ('preventive', 'scheduled') AND x."scheduledDate" IS NOT NULL THEN 'scheduled'
        ELSE 'open'
    END`;

async function maintenance(req, { school, allowed, q }) {
    const today = dayRange().start;
    const build = (p, filtered) => {
        const STATE = maintState(p.$(today));
        let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['x."requestNumber"', 'x."title"', 'x."description"', 'ast."name"', 'rm."roomNumber"', 'x."technicianName"', 'x."vendorName"'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid') + eq('x."asset"', q.asset, p, '::uuid') + eq('x."room"', q.room, p, '::uuid')
                + (MAINT_CATS.includes(q.category) ? eq('x."category"', q.category, p) : '')
                + (MAINT_TYPES.includes(q.type) ? eq('x."maintenanceType"', q.type, p) : '')
                + (PRIORITIES.includes(q.priority) ? eq('x."priority"', q.priority, p) : '')
                + between('COALESCE(x."scheduledDate", x."createdAt")', q.from, q.to, p);
            if (['open', 'progress', 'completed', 'overdue', 'scheduled', 'cancelled'].includes(q.status)) where += ` AND (${STATE}) = ${p.$(q.status)}`;
        }
        const from = `FROM ${T(HostelMaintenance)} x
            LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
            LEFT JOIN ${TBL.rooms} rm ON rm."_id" = x."room"
            LEFT JOIN ${TBL.buildings} bl ON bl."_id" = COALESCE(x."building", rm."building")
            LEFT JOIN ${TBL.floors} fl ON fl."_id" = COALESCE(x."floor", rm."floor")
            LEFT JOIN ${T(HostelAsset)} ast ON ast."_id" = x."asset"
            LEFT JOIN ${TBL.users} tu ON tu."_id" = x."technician"
            LEFT JOIN ${T(HostelComplaint)} cp ON cp."_id" = x."complaint"`;
        const tabs = { all: 'true', open: `(${STATE}) = 'open'`, progress: `(${STATE}) = 'progress'`, completed: `(${STATE}) = 'completed'`,
            overdue: `(${STATE}) = 'overdue'`, scheduled: `(${STATE}) = 'scheduled'` };
        return { from, where, tabs, STATE };
    };
    const p = params(); const b = build(p, true);
    const tp = params(); const t = build(tp, false);
    // The month-on-month count never mentions a state, so it must not carry the
    // date the state is judged by: node-pg refuses a parameter nothing refers to.
    const dp = params();
    const d = { from: `FROM ${T(HostelMaintenance)} x`, where: `x."school" = ${dp.$(school)}${inScope('x."hostel"', allowed, dp)}` };
    const [result, tiles, delta] = await Promise.all([
        board({
            p, from: b.from, where: b.where, tabs: b.tabs, tab: q.tab,
            select: `x."_id", x."requestNumber", x."category", x."maintenanceType", x."priority", x."title", x."description", x."status",
                     x."scheduledDate", x."recurEveryDays", x."startedAt", x."completedAt", x."createdAt", x."estimatedCost"::float8 AS "estimatedCost",
                     x."actualCost"::float8 AS "actualCost", x."resolution", x."technicianName", x."vendorName", x."updates", x."attachments",
                     (${b.STATE}) AS "state", COALESCE(tu."name", NULLIF(x."technicianName", ''), NULLIF(x."vendorName", '')) AS "assignedName",
                     tu."profileImage" AS "assignedPhoto", h."_id" AS "hostelId", h."name" AS "hostelName",
                     rm."_id" AS "roomId", rm."roomNumber", bl."code" AS "buildingCode", bl."name" AS "buildingName", fl."name" AS "floorName",
                     ast."_id" AS "assetId", ast."name" AS "assetName", cp."ticketNumber" AS "complaintNumber"`,
            sorts: { created: 'x."createdAt"', due: 'x."scheduledDate"' },
            sort: q.sort, dir: q.dir, fallback: q.tab === 'scheduled' ? 'due' : 'created', page: q.page, limit: q.limit,
        }),
        counts(tp, t.from, t.where, { total: 'true', completed: t.tabs.completed, progress: t.tabs.progress, overdue: t.tabs.overdue,
            scheduled: t.tabs.scheduled, open: t.tabs.open }),
        monthDelta(dp, d.from, d.where, 'x."createdAt"'),
    ]);
    return {
        ...result,
        tiles: {
            ...tiles, delta,
            completedPct: share(tiles.completed, tiles.total), progressPct: share(tiles.progress, tiles.total),
            overduePct: share(tiles.overdue, tiles.total), scheduledPct: share(tiles.scheduled, tiles.total),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Assets
 * ═════════════════════════════════════════════════════════════════════════════ */
const ASSET_CATS = ['bed', 'mattress', 'table', 'chair', 'cupboard', 'fan', 'ac', 'electronics', 'fire_safety', 'kitchen', 'other'];
const ASSET_CONDITIONS = ['new', 'good', 'fair', 'damaged', 'scrapped'];
/**
 * Where an asset stands: written off, in the workshop, broken, in use (in a
 * room or out with a student), or sitting unassigned in store.
 */
const ASSET_STATE = `CASE
        WHEN x."status" IN ('replaced', 'disposed')                          THEN 'retired'
        WHEN x."status" = 'under_repair'                                     THEN 'maintenance'
        WHEN x."status" = 'damaged' OR x."condition" IN ('damaged', 'scrapped') THEN 'damaged'
        WHEN x."status" = 'issued' OR (x."status" = 'in_room' AND x."room" IS NOT NULL) THEN 'allocated'
        ELSE 'unassigned'
    END`;
const ASSET_TABS = {
    all: 'true', allocated: `(${ASSET_STATE}) = 'allocated'`, unassigned: `(${ASSET_STATE}) = 'unassigned'`,
    maintenance: `(${ASSET_STATE}) = 'maintenance'`, damaged: `(${ASSET_STATE}) = 'damaged'`, retired: `(${ASSET_STATE}) = 'retired'`,
};

async function assets(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['x."name"', 'x."assetCode"', 'x."remarks"', 'rm."roomNumber"', 'h."name"', 'iu."name"'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid') + eq('x."room"', q.room, p, '::uuid')
                + (ASSET_CATS.includes(q.category) ? eq('x."category"', q.category, p) : '')
                + (ASSET_CONDITIONS.includes(q.condition) ? eq('x."condition"', q.condition, p) : '');
            if (ASSET_TABS[q.status] && q.status !== 'all') where += ` AND (${ASSET_TABS[q.status]})`;
            if (q.code) where += ` AND (upper(x."assetCode") = upper(${p.$(String(q.code).trim())}) OR x."_id"::text = ${p.$(String(q.code).trim().replace(/^HA:/i, ''))})`;
            if (q.linked === '1') where += ` AND x."inventoryAsset" IS NOT NULL`;
        }
        const from = `FROM ${T(HostelAsset)} x
            LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
            LEFT JOIN ${TBL.rooms} rm ON rm."_id" = x."room"
            LEFT JOIN ${TBL.buildings} bl ON bl."_id" = COALESCE(x."building", rm."building")
            LEFT JOIN ${TBL.users} iu ON iu."_id" = x."issuedTo"
            LEFT JOIN LATERAL (SELECT count(*)::int AS "n" FROM ${TBL.allocations} al WHERE al."room" = x."room" AND al."status" = 'active') oc ON true
            LEFT JOIN LATERAL (SELECT COALESCE(m."completedAt", m."scheduledDate", m."createdAt") AS "at",
                                      COALESCE(NULLIF(m."title", ''), m."description") AS "note", m."status"
                                 FROM ${T(HostelMaintenance)} m WHERE m."asset" = x."_id" AND m."status" <> 'cancelled'
                                ORDER BY m."createdAt" DESC LIMIT 1) lm ON true`;
        return { from, where };
    };
    const p = params(); const { from, where } = build(p, true);
    const tp = params(); const t = build(tp, false);
    const month = tp.$(monthStart(0));
    const [result, { rows: [tiles] }] = await Promise.all([
        board({
            p, from, where, tabs: ASSET_TABS, tab: q.tab,
            select: `x."_id", x."name", x."assetCode", x."category", x."quantity", x."condition", x."status", x."remarks", x."damageNote",
                     x."damageCharge"::float8 AS "damageCharge", x."issuedAt", x."returnedAt", x."createdAt", (x."inventoryAsset" IS NOT NULL) AS "linked",
                     (${ASSET_STATE}) AS "state", x."hostel" AS "hostelId", h."name" AS "hostelName", x."room" AS "roomId", rm."roomNumber",
                     bl."code" AS "buildingCode", bl."name" AS "buildingName", oc."n" AS "roomStudents",
                     iu."_id" AS "issuedToId", iu."name" AS "issuedToName", lm."at" AS "lastMaintenanceAt", lm."note" AS "lastMaintenanceNote",
                     lm."status" AS "lastMaintenanceStatus"`,
            sorts: { name: 'lower(x."name"), x."assetCode"', created: 'x."createdAt"' },
            sort: q.sort, dir: q.dir || 'asc', fallback: 'name', page: q.page, limit: q.limit,
        }),
        pool.query(
            `SELECT count(*)::int AS "total",
                    ${['allocated', 'unassigned', 'maintenance', 'damaged', 'retired'].map((k) => `count(*) FILTER (WHERE ${ASSET_TABS[k]})::int AS "${k}"`).join(', ')},
                    count(*) FILTER (WHERE x."createdAt" >= ${month})::int AS "added"
               ${t.from} WHERE ${t.where}`,
            tp.list,
        ),
    ]);
    return {
        ...result,
        tiles: {
            ...tiles,
            allocatedPct: share(tiles.allocated, tiles.total), maintenancePct: share(tiles.maintenance, tiles.total),
            damagedPct: share(tiles.damaged, tiles.total), unassignedPct: share(tiles.unassigned, tiles.total),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Incidents, Medical & Emergency
 *
 *  Every record is ONE kind, so the tabs add up to the total: an emergency
 *  (a whole-hostel event, anything critical, or a case that needed an
 *  ambulance), else a medical case, else an incident.
 * ═════════════════════════════════════════════════════════════════════════════ */
const INCIDENT_TYPES = ['misconduct', 'fighting', 'theft', 'property_damage', 'security', 'medical_emergency', 'emergency', 'rule_violation', 'other'];
const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const INCIDENT_KIND = `CASE
        WHEN x."incidentType" = 'emergency' OR x."severity" = 'critical'
             OR x."medicalCategory" = 'ambulance' OR COALESCE(x."transportArranged", false) THEN 'emergency'
        WHEN x."incidentType" = 'medical_emergency'                                          THEN 'medical'
        ELSE 'incident'
    END`;
const INCIDENT_TABS = {
    all: 'true', incidents: `(${INCIDENT_KIND}) = 'incident'`, medical: `(${INCIDENT_KIND}) = 'medical'`, emergency: `(${INCIDENT_KIND}) = 'emergency'`,
};
/** The four stages the screen speaks of, over the model's five. */
const INCIDENT_STAGE = {
    open: `x."status" = 'reported'`,
    progress: `x."status" IN ('investigating', 'action_taken')`,
    resolved: `x."status" = 'resolved'`,
    closed: `x."status" = 'closed'`,
};

async function incidents(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['x."incidentNumber"', 'x."title"', 'x."description"', 'x."location"', 'st."name"', 'stp."rollNumber"', 'stp."admissionNumber"'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid') + eq('x."student"', q.student, p, '::uuid')
                + (INCIDENT_TYPES.includes(q.type) ? eq('x."incidentType"', q.type, p) : '')
                + (INCIDENT_SEVERITIES.includes(q.severity) ? eq('x."severity"', q.severity, p) : '')
                + between('x."date"', q.from, q.to, p);
            if (INCIDENT_STAGE[q.status]) where += ` AND ${INCIDENT_STAGE[q.status]}`;
            if (q.subject === 'student') where += ` AND x."student" IS NOT NULL`;
            else if (q.subject === 'hostel') where += ` AND x."student" IS NULL`;
        }
        const from = `FROM ${T(HostelIncident)} x
            ${studentJoin('st', 'x."student"')}
            LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
            LEFT JOIN ${TBL.rooms} rm ON rm."_id" = x."room"
            LEFT JOIN ${TBL.buildings} bl ON bl."_id" = rm."building"
            LEFT JOIN ${TBL.users} ou ON ou."_id" = x."assignedOfficer"`;
        return { from, where };
    };
    const p = params(); const { from, where } = build(p, true);
    const tp = params(); const t = build(tp, false);
    const dp = params(); const d = build(dp, false);
    const [result, tiles, delta] = await Promise.all([
        board({
            p, from, where, tabs: INCIDENT_TABS, tab: q.tab,
            select: `x."_id", x."incidentNumber", x."incidentType", x."severity", x."status", x."date", x."time", x."location", x."title", x."description",
                     x."medicalCategory", x."treatmentGiven", x."hospitalName", x."actionTaken", x."parentNotifiedAt", x."resolvedAt", x."createdAt",
                     (${INCIDENT_KIND}) AS "kind", h."_id" AS "hostelId", h."name" AS "hostelName",
                     rm."_id" AS "roomId", rm."roomNumber", bl."code" AS "buildingCode", bl."name" AS "buildingName",
                     ou."name" AS "officerName", x."reportedByName", ${studentCols('st')}`,
            sorts: { date: 'x."date"', created: 'x."createdAt"', severity: `array_position(ARRAY['critical','high','medium','low'], x."severity")` },
            sort: q.sort, dir: q.dir, fallback: 'date', page: q.page, limit: q.limit,
        }),
        counts(tp, t.from, t.where, { total: 'true', medical: INCIDENT_TABS.medical, emergency: INCIDENT_TABS.emergency,
            progress: INCIDENT_STAGE.progress, open: INCIDENT_STAGE.open, resolved: `(${INCIDENT_STAGE.resolved} OR ${INCIDENT_STAGE.closed})` }),
        monthDelta(dp, d.from, d.where, 'x."date"'),
    ]);
    return {
        ...result,
        tiles: {
            ...tiles, delta,
            medicalPct: share(tiles.medical, tiles.total), progressPct: share(tiles.progress, tiles.total),
            resolvedPct: share(tiles.resolved, tiles.total),
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Discipline
 *
 *  An action is a warning, a fine or an escalation (everything past a fine:
 *  the warden, the parents, the principal, a suspension). A repeat offender is
 *  a STUDENT with more than one action, so that tab lists students — see
 *  disciplineOffenders — and its count is theirs.
 * ═════════════════════════════════════════════════════════════════════════════ */
const DISC_ACTIONS = ['verbal_warning', 'written_warning', 'fine', 'parent_notification', 'warden_action', 'principal_escalation', 'suspension', 'expulsion'];
const DISC_SEVERITIES = ['minor', 'moderate', 'major'];
const DISC_STATUSES = ['issued', 'acknowledged', 'served', 'revoked'];
const DISC_VIOLATIONS = ['curfew', 'ragging', 'substance', 'property_damage', 'misbehaviour', 'unauthorized_absence', 'visitor_rule', 'mess_rule', 'other'];
const DISC_GROUP = `CASE
        WHEN x."actionType" IN ('verbal_warning', 'written_warning') THEN 'warning'
        WHEN x."actionType" = 'fine'                                THEN 'fine'
        ELSE 'escalation'
    END`;
const DISC_TABS = {
    all: 'true', warnings: `(${DISC_GROUP}) = 'warning'`, fines: `(${DISC_GROUP}) = 'fine'`, escalations: `(${DISC_GROUP}) = 'escalation'`,
};

function disciplineScope(p, { school, allowed, q }, filtered) {
    let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
    if (filtered) {
        where += search(['x."actionNumber"', 'x."violation"', 'x."description"', 'st."name"', 'stp."rollNumber"', 'stp."admissionNumber"', 'inc."incidentNumber"'], q.search, p)
            + eq('x."hostel"', q.hostel, p, '::uuid') + eq('x."student"', q.student, p, '::uuid')
            + (DISC_ACTIONS.includes(q.action) ? eq('x."actionType"', q.action, p) : '')
            + (DISC_VIOLATIONS.includes(q.violation) ? eq('x."violationType"', q.violation, p) : '')
            + (DISC_SEVERITIES.includes(q.severity) ? eq('x."severity"', q.severity, p) : '')
            + (DISC_STATUSES.includes(q.status) ? eq('x."status"', q.status, p) : '')
            + between('x."date"', q.from, q.to, p);
    }
    const from = `FROM ${T(HostelDiscipline)} x
        ${studentJoin('st', 'x."student"')}
        ${currentPlaceJoin('cp', 'x."student"')}
        LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
        LEFT JOIN ${TBL.rooms} rm ON rm."_id" = cp."room"
        LEFT JOIN ${TBL.buildings} bl ON bl."_id" = rm."building"
        LEFT JOIN ${T(HostelIncident)} inc ON inc."_id" = x."incident"`;
    return { from, where };
}

/** Students with more than one action, over a scope. */
const OFFENDERS = (from, where) => `SELECT x."student" ${from} WHERE ${where} GROUP BY x."student" HAVING count(*) > 1`;

async function discipline(req, ctx) {
    const { q } = ctx;
    const p = params(); const { from, where } = disciplineScope(p, ctx, true);
    const op = params(); const o = disciplineScope(op, ctx, true);
    const tp = params(); const t = disciplineScope(tp, ctx, false);
    const dp = params(); const d = disciplineScope(dp, ctx, false);
    const rp = params(); const r = disciplineScope(rp, ctx, false);
    const [result, { rows: [offended] }, tiles, delta, { rows: [whole] }] = await Promise.all([
        board({
            p, from, where, tabs: DISC_TABS, tab: q.tab,
            select: `x."_id", x."actionNumber", x."violation", x."violationType", x."actionType", x."severity", x."status", x."date", x."createdAt",
                     x."description", x."fineAmount"::float8 AS "fineAmount", x."fineInvoice", x."suspensionFrom", x."suspensionTo",
                     x."priorCount", x."isRepeatOffence", x."parentNotified", x."issuedByName", x."remarks",
                     (${DISC_GROUP}) AS "group", h."_id" AS "hostelId", h."name" AS "hostelName",
                     rm."roomNumber", bl."code" AS "buildingCode", bl."name" AS "buildingName",
                     inc."_id" AS "incidentId", inc."incidentNumber", ${studentCols('st')}`,
            sorts: { date: 'x."date"', created: 'x."createdAt"', severity: `array_position(ARRAY['major','moderate','minor'], x."severity")` },
            sort: q.sort, dir: q.dir, fallback: 'date', page: q.page, limit: q.limit,
        }),
        pool.query(`SELECT count(*)::int AS "n" FROM (${OFFENDERS(o.from, o.where)}) s`, op.list),
        counts(tp, t.from, t.where, { total: 'true', resolved: `x."status" = 'served'`, review: `x."status" = 'acknowledged'`,
            pending: `x."status" = 'issued'`, revoked: `x."status" = 'revoked'` }),
        monthDelta(dp, d.from, d.where, 'x."date"'),
        pool.query(`SELECT (SELECT count(*) FROM (${OFFENDERS(r.from, r.where)}) s)::int AS "offenders",
                           count(DISTINCT x."student")::int AS "students" ${r.from} WHERE ${r.where}`, rp.list),
    ]);
    return {
        ...result,
        tabs: { ...result.tabs, repeat: offended?.n || 0 },
        tiles: {
            ...tiles, delta, offenders: whole?.offenders || 0, students: whole?.students || 0,
            resolvedPct: share(tiles.resolved, tiles.total), reviewPct: share(tiles.review, tiles.total),
            offendersPct: share(whole?.offenders, whole?.students),
        },
    };
}

/** One row per repeat offender: how many actions, the fines, the latest. */
async function disciplineOffenders(req, ctx) {
    const { q } = ctx;
    const p = params(); const { from, where } = disciplineScope(p, ctx, true);
    const lim = Math.max(1, Math.min(500, Number(q.limit) || 10));
    const at = Math.max(1, Number(q.page) || 1);
    p.list.push(lim, (at - 1) * lim);
    const { rows } = await pool.query(
        `WITH a AS (SELECT x.*, (${DISC_GROUP}) AS "group", x."student" AS "sid", st."name" AS "sname", st."profileImage" AS "sphoto",
                           stp."rollNumber" AS "sroll", stp."admissionNumber" AS "sadm", stc."className" AS "sclass", sts."sectionName" AS "ssection",
                           h."name" AS "hname", rm."roomNumber" AS "rnum", bl."code" AS "bcode", bl."name" AS "bname"
                      ${from} WHERE ${where})
         SELECT "sid" AS "studentId", max("sname") AS "studentName", max("sphoto") AS "studentPhoto", max("sroll") AS "studentRoll",
                max("sadm") AS "studentAdmissionNo", max("sclass") AS "studentClass", max("ssection") AS "studentSection",
                max("hname") AS "hostelName", max("rnum") AS "roomNumber", max("bcode") AS "buildingCode", max("bname") AS "buildingName",
                count(*)::int AS "actions",
                count(*) FILTER (WHERE "group" = 'warning')::int AS "warnings",
                count(*) FILTER (WHERE "group" = 'fine')::int AS "fines",
                count(*) FILTER (WHERE "group" = 'escalation')::int AS "escalations",
                count(*) FILTER (WHERE "status" IN ('issued', 'acknowledged'))::int AS "open",
                COALESCE(sum("fineAmount"), 0)::float8 AS "fineTotal",
                (array_agg("severity" ORDER BY array_position(ARRAY['major','moderate','minor'], "severity")))[1] AS "severity",
                (array_agg("violation" ORDER BY "date" DESC))[1] AS "lastViolation",
                max("date") AS "lastDate", min("date") AS "firstDate",
                count(*) OVER ()::int AS "__total"
           FROM a GROUP BY "sid" HAVING count(*) > 1
          ORDER BY count(*) DESC, max("date") DESC
          LIMIT $${p.list.length - 1} OFFSET $${p.list.length}`,
        p.list,
    );
    const total = rows[0]?.__total ?? 0;
    return { tab: 'repeat', rows: rows.map(({ __total, ...r }) => r), total, page: at, limit: lim, pages: Math.max(1, Math.ceil(total / lim)) };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Documents
 *
 *  A document is held by a student, a member of staff (through their hostel
 *  post), or the hostel itself — one of the three, so those tabs add up.
 *  "Expiring soon" is anything valid that lapses within 30 days; it cuts across
 *  the holders, as the screen's own tab.
 * ═════════════════════════════════════════════════════════════════════════════ */
const DOC_TYPES = ['admission', 'academic', 'id_proof', 'photo', 'medical', 'parent_authorization', 'undertaking',
    'agreement', 'fee_receipt', 'outpass', 'incident', 'complaint', 'other'];
const DOC_HOLDER = `CASE WHEN x."student" IS NOT NULL THEN 'student'
        WHEN x."entityType" = 'HostelStaffAssignment' THEN 'staff' ELSE 'hostel' END`;
const docExpiry = (today, soon) => `CASE
        WHEN x."expiryDate" IS NULL      THEN 'none'
        WHEN x."expiryDate" < ${today}   THEN 'expired'
        WHEN x."expiryDate" < ${soon}    THEN 'expiring'
        ELSE 'valid'
    END`;

async function documents(req, { school, allowed, q }) {
    const today = dayRange().start;
    const soon = new Date(today.getTime() + 31 * 864e5);
    const build = (p, filtered) => {
        const EXPIRY = docExpiry(p.$(today), p.$(soon));
        let where = `x."school" = ${p.$(school)} AND x."isActive"${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['x."title"', 'x."originalName"', 'x."description"', 'st."name"', 'stp."rollNumber"', 'stp."admissionNumber"', 'su."name"', 'x."_id"::text'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid') + eq('x."student"', q.student, p, '::uuid')
                + (DOC_TYPES.includes(q.type) ? eq('x."docType"', q.type, p) : '')
                + (['pending', 'verified', 'rejected'].includes(q.status) ? eq('x."verificationStatus"', q.status, p) : '')
                + between('x."createdAt"', q.from, q.to, p);
            if (['expired', 'expiring', 'valid', 'none'].includes(q.expiry)) where += ` AND (${EXPIRY}) = ${p.$(q.expiry)}`;
        }
        const from = `FROM ${T(HostelDocument)} x
            ${studentJoin('st', 'x."student"')}
            ${currentPlaceJoin('cp', 'x."student"')}
            LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"
            LEFT JOIN ${TBL.rooms} rm ON rm."_id" = cp."room"
            LEFT JOIN ${TBL.buildings} bl ON bl."_id" = rm."building"
            LEFT JOIN ${T(HostelStaffAssignment)} sa ON x."entityType" = 'HostelStaffAssignment' AND sa."_id" = x."entityId"
            LEFT JOIN ${TBL.users} su ON su."_id" = sa."staff"
            LEFT JOIN ${TBL.users} up ON up."_id" = x."uploadedBy"
            LEFT JOIN LATERAL (SELECT a."role" FROM ${T(HostelStaffAssignment)} a
                                WHERE a."staff" = x."uploadedBy" AND a."school" = x."school"
                                ORDER BY (a."status" = 'active') DESC, a."createdAt" DESC LIMIT 1) upr ON true`;
        const tabs = { all: 'true', student: `(${DOC_HOLDER}) = 'student'`, hostel: `(${DOC_HOLDER}) = 'hostel'`,
            staff: `(${DOC_HOLDER}) = 'staff'`, expiring: `(${EXPIRY}) = 'expiring'` };
        return { from, where, tabs, EXPIRY };
    };
    const p = params(); const b = build(p, true);
    const tp = params(); const t = build(tp, false);
    const dp = params();
    const d = { from: `FROM ${T(HostelDocument)} x`, where: `x."school" = ${dp.$(school)} AND x."isActive"${inScope('x."hostel"', allowed, dp)}` };
    const yp = params();
    const [result, tiles, delta, { rows: byType }] = await Promise.all([
        board({
            p, from: b.from, where: b.where, tabs: b.tabs, tab: q.tab,
            select: `x."_id", x."title", x."description", x."docType", x."originalName", x."storedName", x."mimeType", x."fileSize",
                     x."verificationStatus", x."verifiedAt", x."verificationRemark", x."expiryDate", x."version", x."entityType", x."entityId",
                     x."createdAt", x."uploaderRole", (${DOC_HOLDER}) AS "holder", (${b.EXPIRY}) AS "expiry",
                     h."_id" AS "hostelId", h."name" AS "hostelName", rm."roomNumber", bl."code" AS "buildingCode", bl."name" AS "buildingName",
                     su."_id" AS "staffId", su."name" AS "staffName", sa."role" AS "staffRole",
                     up."name" AS "uploadedByName", upr."role" AS "uploadedByPost", ${studentCols('st')}`,
            sorts: { created: 'x."createdAt"', expiry: 'x."expiryDate"', title: 'lower(x."title")' },
            sort: q.sort, dir: q.dir, fallback: q.tab === 'expiring' ? 'expiry' : 'created', page: q.page, limit: q.limit,
        }),
        counts(tp, t.from, t.where, { total: 'true', verified: `x."verificationStatus" = 'verified'`, pending: `x."verificationStatus" = 'pending'`,
            rejected: `x."verificationStatus" = 'rejected'`, expiring: t.tabs.expiring, expired: `(${t.EXPIRY}) = 'expired'` }),
        monthDelta(dp, d.from, d.where, 'x."createdAt"'),
        pool.query(`SELECT x."docType" AS "type", count(*)::int AS "n",
                           count(*) FILTER (WHERE x."verificationStatus" = 'pending')::int AS "pending"
                      FROM ${T(HostelDocument)} x
                     WHERE x."school" = ${yp.$(school)} AND x."isActive"${inScope('x."hostel"', allowed, yp)}
                     GROUP BY 1 ORDER BY 2 DESC`, yp.list),
    ]);
    if (q.tab === 'expiring' && !q.sort) result.rows.reverse();      // soonest first
    return {
        ...result,
        tiles: {
            ...tiles, delta,
            verifiedPct: share(tiles.verified, tiles.total), pendingPct: share(tiles.pending, tiles.total),
            expiringPct: share(tiles.expiring, tiles.total), byType,
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Announcements
 *
 *  A notice covers `hostels` ([] = the whole school), so a warden sees the ones
 *  wholly inside their own hostels. 'sending' lasts a moment and is counted
 *  with Scheduled, where it came from.
 * ═════════════════════════════════════════════════════════════════════════════ */
const ANN_CATS = ['general', 'mess', 'maintenance', 'medical', 'discipline', 'leave', 'documents', 'safety', 'fees', 'events', 'other'];
const ANN_AUDIENCES = ['residents', 'new_residents', 'parents', 'residents_and_parents', 'staff'];
const ANN_TABS = {
    all: 'true', published: `x."status" = 'published'`, scheduled: `x."status" IN ('scheduled', 'sending')`,
    drafts: `x."status" = 'draft'`, archived: `x."status" = 'archived'`,
};
const ANN_COVERS = `(CASE WHEN jsonb_typeof(x."hostels") = 'array' THEN x."hostels" ELSE '[]'::jsonb END)`;
const annScope = (allowed, p) => (allowed === null ? ''
    : ` AND jsonb_array_length(${ANN_COVERS}) > 0
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${ANN_COVERS}) e WHERE e <> ALL(${p.$(allowed.map(String))}::text[]))`);
const ANN_AT = `COALESCE(x."publishedAt", x."scheduledAt", x."createdAt")`;

async function announcements(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)}${annScope(allowed, p)}`;
        if (filtered) {
            where += search(['x."title"', 'x."message"'], q.search, p)
                + (ANN_CATS.includes(q.category) ? eq('x."category"', q.category, p) : '')
                + (ANN_AUDIENCES.includes(q.audience) ? eq('x."audience"', q.audience, p) : '')
                + between(ANN_AT, q.from, q.to, p);
            // A hostel's notices include the school-wide ones, which reach it too.
            if (q.hostel) where += ` AND (${ANN_COVERS} ? ${p.$(String(q.hostel))} OR jsonb_array_length(${ANN_COVERS}) = 0)`;
            if (ANN_TABS[q.status] && q.status !== 'all') where += ` AND (${ANN_TABS[q.status]})`;
        }
        const from = `FROM ${T(HostelAnnouncement)} x LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"`;
        return { from, where };
    };
    const p = params(); const { from, where } = build(p, true);
    const tp = params(); const t = build(tp, false);
    const dp = params(); const d = build(dp, false);
    const cp = params(); const c = build(cp, false);
    const mp = params(); const m = build(mp, false);
    const since = mp.$(monthStart(5));
    const [result, tiles, delta, { rows: [split] }, { rows: months }] = await Promise.all([
        board({
            p, from, where, tabs: ANN_TABS, tab: q.tab,
            select: `x."_id", x."title", x."message", x."category", x."audience", x."status", x."scheduledAt", x."publishedAt", x."recipients",
                     x."sendEmail", x."urgent", x."attachments", x."createdByName", x."publishedByName", x."lastError", x."archivedFrom",
                     x."createdAt", x."updatedAt", x."hostel" AS "hostelId", h."name" AS "hostelName",
                     jsonb_array_length(${ANN_COVERS}) AS "hostelCount"`,
            sorts: { created: 'x."createdAt"', at: ANN_AT, title: 'lower(x."title")' },
            sort: q.sort, dir: q.dir, fallback: 'created', page: q.page, limit: q.limit,
        }),
        counts(tp, t.from, t.where, { total: 'true', published: ANN_TABS.published, scheduled: ANN_TABS.scheduled,
            drafts: ANN_TABS.drafts, archived: ANN_TABS.archived, urgent: `x."urgent" AND x."status" = 'published'` }),
        monthDelta(dp, d.from, d.where, 'x."createdAt"'),
        // What the "View Reports" drawer draws: reach, and the notices by category and audience.
        pool.query(`SELECT
              (SELECT COALESCE(sum(x."recipients"), 0) ${c.from} WHERE ${c.where} AND x."publishedAt" IS NOT NULL)::int AS "reached",
              (SELECT COALESCE(jsonb_object_agg(k."key", k."n"), '{}'::jsonb)
                 FROM (SELECT x."category" AS "key", count(*)::int AS "n" ${c.from} WHERE ${c.where} GROUP BY 1) k) AS "byCategory",
              (SELECT COALESCE(jsonb_object_agg(k."key", k."n"), '{}'::jsonb)
                 FROM (SELECT x."audience" AS "key", count(*)::int AS "n" ${c.from} WHERE ${c.where} GROUP BY 1) k) AS "byAudience"`, cp.list),
        pool.query(`SELECT date_trunc('month', x."publishedAt") AS "month", count(*)::int AS "sent", COALESCE(sum(x."recipients"), 0)::int AS "reached"
                      ${m.from} WHERE ${m.where} AND x."publishedAt" >= ${since}
                     GROUP BY 1 ORDER BY 1`, mp.list),
    ]);
    return {
        ...result,
        tiles: {
            ...tiles, delta,
            publishedPct: share(tiles.published, tiles.total), scheduledPct: share(tiles.scheduled, tiles.total),
            draftsPct: share(tiles.drafts, tiles.total),
            reached: split?.reached || 0, byCategory: split?.byCategory || {}, byAudience: split?.byAudience || {}, months,
        },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Activity log
 *
 *  Append-only and never pruned. A row names its entity only by type and id,
 *  so the name the screen prints ("Room 201", "Complaint #C0012", a student)
 *  is looked up here — for the page of rows only, never the whole log.
 * ═════════════════════════════════════════════════════════════════════════════ */
/** One subquery per entity type, each returning the thing's everyday name. */
const ENTITY_NAME = () => {
    const by = (Model, col) => `(SELECT ${col} FROM ${T(Model)} e WHERE e."_id" = x."entityId")`;
    const person = (Model, col) => `(SELECT u."name" FROM ${T(Model)} e JOIN ${TBL.users} u ON u."_id" = e.${col} WHERE e."_id" = x."entityId")`;
    const pairs = [
        ['Hostel', by(require('../models/Hostel'), 'e."name"')], ['HostelBuilding', by(HostelBuilding, 'e."name"')],
        ['HostelFloor', by(HostelFloor, 'e."name"')], ['HostelRoom', `(SELECT e."roomNumber" FROM ${TBL.rooms} e WHERE e."_id" = x."entityId")`],
        ['HostelBed', by(HostelBed, `'Bed ' || e."bedNumber"`)], ['HostelAdmission', by(HostelAdmission, 'e."applicationNumber"')],
        ['HostelAllocation', person(HostelAllocation, '"student"')], ['HostelLeave', by(HostelLeave, 'e."leaveNumber"')],
        ['HostelOutpass', by(HostelOutpass, 'e."outpassNumber"')], ['HostelVisitor', by(HostelVisitor, 'e."visitorName"')],
        ['HostelStaffAssignment', person(HostelStaffAssignment, '"staff"')], ['HostelMess', by(HostelMess, 'e."name"')],
        ['HostelFeePlan', by(HostelFeePlan, 'e."name"')], ['HostelFeeInvoice', by(HostelFeeInvoice, `'Invoice #' || e."invoiceNumber"`)],
        ['HostelComplaint', by(HostelComplaint, `'Complaint #' || e."ticketNumber"`)], ['HostelMaintenance', by(HostelMaintenance, `'Work Order ' || e."requestNumber"`)],
        ['HostelAsset', by(HostelAsset, `e."name" || COALESCE(' · ' || NULLIF(e."assetCode", ''), '')`)], ['HostelIncident', by(HostelIncident, 'e."incidentNumber"')],
        ['HostelDiscipline', by(HostelDiscipline, 'e."actionNumber"')], ['HostelDocument', by(HostelDocument, 'e."title"')],
        ['HostelAnnouncement', by(HostelAnnouncement, 'e."title"')], ['HostelSettings', `'Hostel settings'`],
    ];
    return `CASE x."entityType" ${pairs.map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(' ')} END`;
};
const AUDIT_ACTIONS = ['create', 'update', 'delete', 'approve', 'reject', 'assign', 'allocate', 'transfer', 'release', 'cancel',
    'payment', 'refund', 'discount', 'fine', 'export', 'announce', 'archive', 'restore', 'upload', 'verify'];

async function audit(req, { school, allowed, q }) {
    const build = (p, filtered) => {
        let where = `x."school" = ${p.$(school)}${inScope('x."hostel"', allowed, p)}`;
        if (filtered) {
            where += search(['x."description"', 'x."userName"', 'x."entityType"'], q.search, p)
                + eq('x."hostel"', q.hostel, p, '::uuid') + eq('x."user"', q.user, p, '::uuid')
                + eq('x."entityType"', q.entity, p) + eq('x."actionType"', q.action, p)
                + between('x."createdAt"', q.from, q.to, p);
        }
        return { from: `FROM ${T(HostelAuditLog)} x LEFT JOIN ${TBL.users} u ON u."_id" = x."user" LEFT JOIN ${TBL.hostels} h ON h."_id" = x."hostel"`, where };
    };
    const p = params(); const { from, where } = build(p, true);
    const tp = params(); const t = build(tp, false);
    const dp = params(); const d = build(dp, false);
    const op = params(); const o = build(op, false);
    const since = tp.$(new Date(Date.now() - 30 * 864e5));
    const [result, { rows: [tiles] }, delta, opts] = await Promise.all([
        board({
            p, from, where,
            select: `x."_id", x."createdAt", x."actionType", x."entityType", x."entityId", x."description", x."before", x."after", x."meta",
                     x."ip", x."userAgent", x."role", COALESCE(NULLIF(x."userName", ''), u."name", 'System') AS "userName",
                     u."profileImage" AS "userPhoto", h."name" AS "hostelName", (${ENTITY_NAME()}) AS "entityName"`,
            sorts: { created: 'x."createdAt"' }, sort: 'created', dir: q.dir === 'asc' ? 'asc' : 'desc', fallback: 'created',
            page: q.page, limit: q.limit,
        }),
        pool.query(`SELECT count(*)::int AS "total", count(DISTINCT x."user") FILTER (WHERE x."createdAt" >= ${since})::int AS "admins",
                           count(DISTINCT x."entityType")::int AS "entities", min(x."createdAt") AS "oldest"
                      ${t.from} WHERE ${t.where}`, tp.list),
        monthDelta(dp, d.from, d.where, 'x."createdAt"'),
        pool.query(`SELECT (SELECT COALESCE(jsonb_agg(k ORDER BY n DESC), '[]'::jsonb) FROM (SELECT x."entityType" AS k, count(*) AS n ${o.from} WHERE ${o.where} GROUP BY 1) a) AS "entities",
                           (SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM (SELECT DISTINCT x."actionType" AS k ${o.from} WHERE ${o.where}) b) AS "actions",
                           (SELECT COALESCE(jsonb_agg(jsonb_build_object('value', id, 'label', name) ORDER BY name), '[]'::jsonb)
                              FROM (SELECT DISTINCT x."user"::text AS id, COALESCE(NULLIF(x."userName", ''), u."name", 'System') AS name
                                      ${o.from} WHERE ${o.where} AND x."user" IS NOT NULL) c) AS "users"`, op.list),
    ]);
    const o2 = opts.rows[0] || {};
    return {
        ...result,
        tiles: {
            ...tiles, delta,
            days: tiles.oldest ? Math.max(1, Math.ceil((Date.now() - new Date(tiles.oldest)) / 864e5)) : 0,
            topEntities: (o2.entities || []).slice(0, 3),
        },
        options: { entities: o2.entities || [], actions: [...new Set([...(o2.actions || []), ...AUDIT_ACTIONS])].sort(), users: o2.users || [] },
    };
}

/* ═════════════════════════════════════════════════════════════════════════════
 *  Dispatch
 * ═════════════════════════════════════════════════════════════════════════════ */
const BOARDS = {
    hostels, structure, rooms, occupancy, admissions, allocations, 'allocation-history': allocationHistory,
    attendance, 'attendance-history': attendanceHistory, leave, outpass, visitors, movements, staff,
    mess, 'mess-members': messMembers, 'mess-attendance': messAttendance, 'mess-expenses': messExpenses, 'mess-report': messReport,
    fees, 'fee-summary': feeSummary, 'fee-outstanding': feeOutstanding, 'fee-refunds': feeRefunds,
    'fee-collections': feeCollections, 'fee-plans': feePlans,
    complaints, maintenance, assets, incidents, discipline, 'discipline-offenders': disciplineOffenders, documents, announcements,
    // Loaded when first asked for: the reports read the state expressions this file exports.
    reports: (req, ctx) => require('./hostelReports.controller').report(req, ctx),
    audit,
};

exports.board = async (req, res) => {
    try {
        const fn = BOARDS[req.params.screen];
        if (!fn) return bad(res, `Unknown board '${req.params.screen}'`, 404);
        const allowed = await visibleHostelIds(req);
        ok(res, await fn(req, { school: req.schoolId, allowed, q: req.query || {} }));
    } catch (e) { fail(res, e); }
};

exports._boards = BOARDS;      // the tests call them directly
// The state expressions the Reports screen counts by, so its figures are the
// list screens' figures.
exports._sql = {
    maintState, INCIDENT_KIND, DISC_GROUP, COMPLAINT_OVERDUE, BALANCE, OWED, UNPAID,
    PAYMENTS, PAID_AT, PAID_AMOUNT, VISIT_AT,
};
exports._pool = pool;
