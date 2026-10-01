'use strict';
/**
 * The Hostel admin screens' read models, in SQL — the shared layer.
 *
 * Every redesigned list screen draws the same four things: figure tiles over
 * the whole of the caller's hostels, a row of tabs each carrying a count, a
 * filter bar, and one page of a table. The old list endpoints could not give
 * the screens those: they paged BEFORE they searched (a search for a name on
 * page 3 came back empty and the total stayed the unfiltered one), they had no
 * class, roll or bed on a row, and no counts at all. So each screen gets a
 * "board" (controllers/hostelBoards.controller.js) built from these pieces:
 *
 *   · tiles   count the caller's whole scope — a filter narrows the rows but
 *             never the tiles, which describe the hostel, not the search;
 *   · tabs    count what the filters leave, each under its own condition, in
 *             ONE query (count(*) FILTER …), so a tab's number is exactly the
 *             rows that tab shows;
 *   · rows    the chosen tab's page, with `count(*) OVER ()` riding along
 *             rather than costing a second scan.
 *
 * Day and month boundaries are computed in the process zone (config/timezone)
 * and passed in as instants, so nothing depends on the database session zone.
 */
const pool = require('../db/pool');
const User = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const TeacherProfile = require('../models/TeacherProfile');
const Class = require('../models/Class');
const ClassSection = require('../models/ClassSection');
const Hostel = require('../models/Hostel');
const HostelBuilding = require('../models/HostelBuilding');
const HostelFloor = require('../models/HostelFloor');
const HostelRoom = require('../models/HostelRoom');
const HostelBed = require('../models/HostelBed');
const HostelAllocation = require('../models/HostelAllocation');
const { dayRange } = require('./hostelService');

const T = (Model) => `"${Model.tableName}"`;
const TBL = {
    users: T(User), profiles: T(StudentProfile), staffProfiles: T(TeacherProfile), classes: T(Class), sections: T(ClassSection),
    hostels: T(Hostel), buildings: T(HostelBuilding), floors: T(HostelFloor),
    rooms: T(HostelRoom), beds: T(HostelBed), allocations: T(HostelAllocation),
};

const num = (v, d = 0) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));

/** Positional parameters, accumulated as the SQL is built. */
function params() {
    const list = [];
    const $ = (v) => { list.push(v); return `$${list.length}`; };
    return { list, $ };
}

/* ── Clauses ──────────────────────────────────────────────────────────────── */

/** Only the hostels the caller may see. `allowed` is null for every hostel. */
const inScope = (col, allowed, p) => (allowed === null || allowed === undefined
    ? '' : ` AND ${col} = ANY(${p.$(allowed.map(String))}::uuid[])`);

/** `col = value` when a value was asked for. UUID columns need `::uuid`. */
const eq = (col, v, p, cast = '') => (v === undefined || v === null || v === '' ? ''
    : ` AND ${col} = ${p.$(String(v))}${cast}`);

/** `col = ANY(values)` for a list, e.g. several statuses under one tab. */
const any = (col, values, p) => ` AND ${col} = ANY(${p.$(values)}::text[])`;

/** ILIKE over several columns, with the user's wildcards escaped. */
function search(cols, s, p) {
    const q = String(s || '').trim();
    if (!q) return '';
    const x = p.$(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    return ` AND (${cols.map((c) => `${c} ILIKE ${x}`).join(' OR ')})`;
}

/** A day range on a timestamp column, inclusive of the whole `to` day. */
function between(col, from, to, p) {
    let s = '';
    if (from && !Number.isNaN(new Date(from).getTime())) s += ` AND ${col} >= ${p.$(dayRange(from).start)}`;
    if (to && !Number.isNaN(new Date(to).getTime())) s += ` AND ${col} < ${p.$(dayRange(to).end)}`;
    return s;
}

/** A SQL string literal for a value we control (never a request value). */
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
/** `col IN ('a','b')` for constants. */
const inList = (col, values) => `${col} IN (${values.map(lit).join(', ')})`;

/* ── Joins ────────────────────────────────────────────────────────────────── */

/**
 * A resident's name, photo, admission and roll number, class and section.
 * The profile is taken LATERAL … LIMIT 1 so a person with two profile rows can
 * never double a row of the board.
 *
 * A resident may be a member of staff. They have no student profile, so the
 * same columns carry their employee id (for the admission number) and their
 * designation (for the class), and `…Kind` says which they are — read from
 * the account's role, so it is right for rows older than `residentType`.
 */
function studentJoin(a, col) {
    return `
        LEFT JOIN ${TBL.users} ${a} ON ${a}."_id" = ${col}
        LEFT JOIN LATERAL (SELECT "admissionNumber", "rollNumber", "currentClass", "currentSection", "gender"
                             FROM ${TBL.profiles} WHERE "user" = ${col}
                            ORDER BY "createdAt" DESC NULLS LAST LIMIT 1) ${a}p ON true
        LEFT JOIN ${TBL.classes} ${a}c ON ${a}c."_id" = ${a}p."currentClass"
        LEFT JOIN ${TBL.sections} ${a}s ON ${a}s."_id" = ${a}p."currentSection"
        LEFT JOIN LATERAL (SELECT "employeeId", "designation", "department", "gender"
                             FROM ${TBL.staffProfiles} WHERE "user" = ${col} LIMIT 1) ${a}t ON ${a}."role" = 'teacher'`;
}
const studentCols = (a, prefix = 'student') => `
        ${a}."_id" AS "${prefix}Id", ${a}."name" AS "${prefix}Name", ${a}."profileImage" AS "${prefix}Photo",
        COALESCE(${a}p."admissionNumber", ${a}t."employeeId") AS "${prefix}AdmissionNo", ${a}p."rollNumber" AS "${prefix}Roll",
        COALESCE(${a}c."className", NULLIF(${a}t."designation", '')) AS "${prefix}Class", ${a}s."sectionName" AS "${prefix}Section",
        CASE WHEN ${a}."role" = 'teacher' THEN 'teacher' ELSE 'student' END AS "${prefix}Kind"`;

/**
 * Where a student lives now — building, room and bed — through their active
 * allocation, for the rows (a visitor, a complaint) that do not carry one.
 */
function currentPlaceJoin(a, studentCol) {
    return `
        LEFT JOIN LATERAL (SELECT al."room", al."bed", al."building", al."floor", al."presence", al."_id" AS "allocationId"
                             FROM ${TBL.allocations} al
                            WHERE al."student" = ${studentCol} AND al."status" = 'active'
                            ORDER BY al."createdAt" DESC LIMIT 1) ${a} ON true`;
}

/** Building / room / bed labels for a row that has those ids (directly or via a join). */
function placeJoin(a, { building, room, bed }) {
    return `
        LEFT JOIN ${TBL.buildings} ${a}b ON ${a}b."_id" = ${building}
        LEFT JOIN ${TBL.rooms} ${a}r ON ${a}r."_id" = ${room}
        LEFT JOIN ${TBL.beds} ${a}d ON ${a}d."_id" = ${bed}`;
}
const placeCols = (a) => `
        ${a}b."name" AS "buildingName", ${a}b."code" AS "buildingCode",
        ${a}r."roomNumber" AS "roomNumber", ${a}r."code" AS "roomCode", ${a}r."roomType" AS "roomType",
        ${a}d."bedNumber" AS "bedNumber", ${a}d."code" AS "bedCode"`;

/* ── Running a board ──────────────────────────────────────────────────────── */

/**
 * Counts per condition over one FROM/WHERE, in a single scan.
 * `conds` maps a key to a SQL boolean; returns { key: n }.
 */
async function counts(p, from, where, conds) {
    const keys = Object.keys(conds);
    if (!keys.length) return {};
    const { rows: [r] } = await pool.query(
        `SELECT ${keys.map((k) => `count(*) FILTER (WHERE ${conds[k]})::int AS "${k}"`).join(', ')}
           ${from} WHERE ${where}`,
        p.list,
    );
    return r || Object.fromEntries(keys.map((k) => [k, 0]));
}

/**
 * The tab counts (filters applied, tab not) and the chosen tab's page.
 *
 *   from, where   the board's FROM … and its WHERE (scope + filters)
 *   tabs          { key: SQL condition } — 'all' should be 'true'
 *   tab           the tab asked for (unknown → the first)
 *   select        the row columns
 *   sorts         { key: SQL expression } — whitelisted, never the raw param
 */
async function board({ p, from, where, tabs = { all: 'true' }, tab, select, sorts = {}, sort, dir, fallback, page, limit }) {
    const keys = Object.keys(tabs);
    const chosen = keys.includes(tab) ? tab : keys[0];
    const lim = Math.max(1, Math.min(5000, num(limit, 10) || 10));
    const at = Math.max(1, num(page, 1) || 1);
    const order = sorts[sort] || sorts[fallback] || Object.values(sorts)[0] || '1';
    const way = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const rowParams = [...p.list, lim, (at - 1) * lim];
    const [tabCounts, rows] = await Promise.all([
        counts(p, from, where, tabs),
        pool.query(
            `SELECT ${select}, count(*) OVER ()::int AS "__total"
               ${from} WHERE ${where} AND (${tabs[chosen]})
              ORDER BY ${order} ${way} NULLS LAST
              LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
            rowParams,
        ),
    ]);
    const total = rows.rows[0]?.__total ?? 0;
    return {
        tab: chosen,
        tabs: tabCounts,
        rows: rows.rows.map(({ __total, ...r }) => r),
        total,
        page: at,
        limit: lim,
        pages: Math.max(1, Math.ceil(total / lim)),
    };
}

/* ── Figures ──────────────────────────────────────────────────────────────── */

/** Start of the month `offset` months back, in the app's zone. */
const monthStart = (offset = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() - offset, 1);
};

/**
 * "+12% from last month": this month's new rows against last month's, by a
 * timestamp column. null when last month had none — a percentage of nothing
 * is not a trend.
 */
async function monthDelta(p, from, where, col) {
    const a = p.$(monthStart(0)); const b = p.$(monthStart(1));
    const { rows: [r] } = await pool.query(
        `SELECT count(*) FILTER (WHERE ${col} >= ${a})::int AS "now",
                count(*) FILTER (WHERE ${col} >= ${b} AND ${col} < ${a})::int AS "prev"
           ${from} WHERE ${where}`,
        p.list,
    );
    const now = r?.now || 0; const prev = r?.prev || 0;
    return { thisMonth: now, lastMonth: prev, pct: prev ? Math.round(((now - prev) / prev) * 100) : null };
}

/** Whole-number share of a total, one decimal when small — "8.3%". */
const share = (part, whole, dp = 1) => {
    const w = num(whole); const v = num(part);
    if (!w) return 0;
    const f = 10 ** dp;
    return Math.round((v / w) * 100 * f) / f;
};

module.exports = {
    TBL, T, num, params, inScope, eq, any, search, between, lit, inList,
    studentJoin, studentCols, currentPlaceJoin, placeJoin, placeCols,
    counts, board, monthStart, monthDelta, share,
};
