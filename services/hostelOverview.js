'use strict';
/**
 * The Hostel dashboard's figures, in SQL (Sep 2026 redesign).
 *
 * The old dashboard counted through the ORM, which is fine for "how many rooms"
 * but got three things wrong that only show once a school actually runs its
 * hostel:
 *
 *   · Attendance counted RECORDS, and a student is marked once per session — a
 *     hostel taking a morning and a night roll call showed every resident as
 *     present twice. It now counts students, each by their latest roll call of
 *     the day.
 *   · Billed was bucketed by when an invoice was CREATED, so a term's invoices
 *     generated in one sitting all landed in one month, and "collected" was the
 *     paid amount of those same invoices rather than the money received in the
 *     month. Billed now follows the billing period; collected follows the date
 *     on each payment.
 *   · "Available" included beds the allocation engine refuses to use — a bed in
 *     a room under maintenance, or in a hostel that is not active. A bed is now
 *     counted under the state the engine would act on (see BED_STATE).
 *
 * Month and day boundaries come from the process zone, which config/timezone.js
 * pins to the school's, and every SQL bucket is given that zone explicitly — so
 * the figures do not depend on the database session's zone, which in
 * production is UTC.
 */
const pool = require('../db/pool');
const Hostel = require('../models/Hostel');
const HostelBuilding = require('../models/HostelBuilding');
const HostelFloor = require('../models/HostelFloor');
const HostelRoom = require('../models/HostelRoom');
const HostelBed = require('../models/HostelBed');
const HostelAllocation = require('../models/HostelAllocation');
const HostelAttendance = require('../models/HostelAttendance');
const HostelFeeInvoice = require('../models/HostelFeeInvoice');
const HostelIncident = require('../models/HostelIncident');
const HostelAuditLog = require('../models/HostelAuditLog');
const AcademicYear = require('../models/AcademicYear');
const User = require('../models/User');
const { MONTHS, dayRange } = require('./hostelService');

const T = (Model) => `"${Model.tableName}"`;

/** The zone this process reads the clock in, read at call time. */
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * `AND <col> = ANY(<ids>)` when the caller is limited to some hostels, nothing
 * when they may see all of them. `ids` is null for "every hostel".
 */
function scoped(col, ids, params) {
    if (ids === null || ids === undefined) return '';
    params.push(ids.map(String));
    return ` AND ${col} = ANY($${params.length}::uuid[])`;
}

/* ── Hostels in scope ─────────────────────────────────────────────────────── */

/**
 * The active hostels the caller may see, by name. `allowed` is what
 * visibleHostelIds() returned: null for every hostel, else the ids a warden holds.
 */
async function hostelsInScope(schoolId, allowed) {
    const params = [String(schoolId)];
    const { rows } = await pool.query(
        `SELECT "_id", "name", "code", "status" FROM ${T(Hostel)}
          WHERE "school" = $1 AND "isActive"${scoped('"_id"', allowed, params)}
          ORDER BY lower("name")`,
        params,
    );
    return rows.map((r) => ({ _id: String(r._id), name: r.name, code: r.code || '', status: r.status }));
}

/** Buildings, floors and rooms that are in use, under the given hostels. */
async function structureCounts(schoolId, ids) {
    const params = [String(schoolId)];
    const inScope = scoped('"hostel"', ids, params);
    const { rows: [r] } = await pool.query(
        `SELECT (SELECT count(*) FROM ${T(HostelBuilding)} WHERE "school" = $1 AND "isActive"${inScope})::int AS "buildings",
                (SELECT count(*) FROM ${T(HostelFloor)}    WHERE "school" = $1 AND "isActive"${inScope})::int AS "floors",
                (SELECT count(*) FROM ${T(HostelRoom)}     WHERE "school" = $1 AND "isActive"${inScope})::int AS "rooms"`,
        params,
    );
    return { buildings: r.buildings, floors: r.floors, rooms: r.rooms };
}

/* ── Beds ─────────────────────────────────────────────────────────────────── */

/**
 * The state a bed is counted under — the one the allocation engine would act on
 * (services/hostelAllocation.js → validateAllocation), not just its own field:
 *
 *   occupied     someone lives in it, whatever else is true
 *   out          not capacity at all: the bed is taken out of service, its room
 *                is inactive, or its hostel is not active (under construction,
 *                closed) — the engine refuses every one of these
 *   maintenance  the bed, or the whole room, is under repair
 *   reserved     held by hand
 *   available    a bed the engine would actually give to a student
 *
 * "Total beds" is the four that are capacity; `out` is reported on its own so
 * the four tiles always add up to the total and their shares to 100%.
 */
const BED_STATE = `
    CASE
        WHEN b."status" = 'occupied'                                     THEN 'occupied'
        WHEN b."status" = 'inactive' OR NOT COALESCE(r."isActive", false)
             OR r."status" = 'inactive' OR h."status" <> 'active'        THEN 'out'
        WHEN b."status" = 'maintenance' OR r."status" = 'maintenance'    THEN 'maintenance'
        WHEN b."status" = 'reserved'                                     THEN 'reserved'
        ELSE 'available'
    END`;

const blankBeds = () => ({ total: 0, occupied: 0, available: 0, reserved: 0, maintenance: 0, out: 0 });

async function bedCounts(schoolId, ids) {
    const params = [String(schoolId)];
    const { rows } = await pool.query(
        `SELECT b."hostel", ${BED_STATE} AS "state", count(*)::int AS "n"
           FROM ${T(HostelBed)} b
           JOIN ${T(Hostel)} h ON h."_id" = b."hostel"
           LEFT JOIN ${T(HostelRoom)} r ON r."_id" = b."room"
          WHERE b."school" = $1 AND b."isActive"${scoped('b."hostel"', ids, params)}
          GROUP BY 1, 2`,
        params,
    );
    const all = blankBeds();
    const byHostel = {};
    for (const { hostel, state, n } of rows) {
        const h = (byHostel[hostel] ||= blankBeds());
        h[state] += n; all[state] += n;
        if (state !== 'out') { h.total += n; all.total += n; }
    }
    return { ...all, byHostel };
}

/* ── Residents ────────────────────────────────────────────────────────────── */

const blankResidence = () => ({ inside: 0, outside: 0, onLeave: 0, total: 0 });
const PRESENCE_KEY = { in: 'inside', out: 'outside', on_leave: 'onLeave' };

/** Where the students with a bed are right now, per hostel. */
async function residence(schoolId, ids) {
    const params = [String(schoolId)];
    const { rows } = await pool.query(
        `SELECT "hostel", COALESCE("presence", 'in') AS "presence", count(*)::int AS "n"
           FROM ${T(HostelAllocation)}
          WHERE "school" = $1 AND "status" = 'active'${scoped('"hostel"', ids, params)}
          GROUP BY 1, 2`,
        params,
    );
    const all = blankResidence();
    const byHostel = {};
    for (const { hostel, presence, n } of rows) {
        const key = PRESENCE_KEY[presence] || 'inside';
        const h = (byHostel[hostel] ||= blankResidence());
        h[key] += n; h.total += n; all[key] += n; all.total += n;
    }
    return { ...all, byHostel };
}

/** How many of the residents are staff — they are counted as residents, not called at roll call. */
async function staffResidents(schoolId, ids) {
    const params = [String(schoolId)];
    const { rows: [r] } = await pool.query(
        `SELECT count(*)::int AS "n" FROM ${T(HostelAllocation)}
          WHERE "school" = $1 AND "status" = 'active' AND "residentType" = 'teacher'${scoped('"hostel"', ids, params)}`, params);
    return r.n;
}

/* ── Attendance ───────────────────────────────────────────────────────────── */

/**
 * The order of a day's roll calls, so "latest" means the latest in the day
 * rather than the one somebody happened to type in last.
 */
const SESSION_RANK = `CASE a."session" WHEN 'morning' THEN 1 WHEN 'roll_call' THEN 2
                                       WHEN 'evening' THEN 3 WHEN 'night' THEN 4 ELSE 0 END`;

/**
 * One day's attendance, counted in STUDENTS: each student under the status of
 * their latest roll call that day. `day` is 'today' or 'yesterday'.
 *
 * `expected` is how many students hold a bed in these hostels now, which is
 * the roll the percentages are taken against — so an unfinished roll call reads
 * as a low figure rather than "100% present" out of the ten marked so far.
 */
async function attendanceOn(schoolId, ids, day = 'today') {
    const when = new Date();
    if (day === 'yesterday') when.setDate(when.getDate() - 1);
    const { start, end } = dayRange(when);

    const params = [String(schoolId), start, end];
    const inScope = scoped('a."hostel"', ids, params);
    const { rows } = await pool.query(
        `SELECT t."status", count(*)::int AS "n"
           FROM (SELECT DISTINCT ON (a."student") a."student", a."status"
                   FROM ${T(HostelAttendance)} a
                  WHERE a."school" = $1 AND a."date" >= $2 AND a."date" < $3${inScope}
                  ORDER BY a."student", ${SESSION_RANK} DESC, a."markedAt" DESC NULLS LAST) t
          GROUP BY 1`,
        params,
    );
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    return {
        day: day === 'yesterday' ? 'yesterday' : 'today',
        date: start,
        present: by.present || 0,
        absent: by.absent || 0,
        late: by.late || 0,
        excused: by.excused || 0,
        onLeave: by.on_leave || 0,
        marked: rows.reduce((s, r) => s + r.n, 0),
    };
}

/* ── Fees ─────────────────────────────────────────────────────────────────── */

const monthOf = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthsBetween = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());

const FEE_RANGES = ['6m', '12m', 'year'];

/**
 * The months a fee chart covers.
 *
 *   '6m' / '12m'  the months up to this one — or, when the chosen academic year
 *                 is already over, up to its last month; for a year that has
 *                 not begun, its first months
 *   'year'        the chosen academic year from its first month, at most twelve
 */
function feeWindow(range, year, now = new Date()) {
    const current = monthOf(now);
    const ys = year?.startDate ? monthOf(new Date(year.startDate)) : null;
    const ye = year?.endDate ? monthOf(new Date(year.endDate)) : null;

    let first; let count;
    if (range === 'year' && ys) {
        count = Math.max(1, Math.min(12, ye ? monthsBetween(ys, ye) + 1 : 12));
        first = ys;
    } else {
        count = range === '6m' ? 6 : 12;          // 'year' with no year to follow: twelve
        let last = current;
        if (ye && last > ye) last = ye;
        if (ys && last < ys) last = addMonths(ys, count - 1);
        first = addMonths(last, -(count - 1));
    }
    const months = Array.from({ length: count }, (_, i) => addMonths(first, i));
    return { months, from: months[0], to: addMonths(months[months.length - 1], 1) };
}

/** A timestamp column or JSON field, as 'YYYY-MM' in the school's zone. */
const ym = (expr, tzParam) => `to_char(${expr} AT TIME ZONE ${tzParam}, 'YYYY-MM')`;

/**
 * Billed and collected per month.
 *
 * Billed: an invoice's net amount, in its billing month — `period` when the
 * invoice carries one, else its due date, else the day it was raised.
 * Collected: every payment, in the month it was received. Cancelled invoices
 * count towards neither.
 */
async function feeSeries(schoolId, allowed, asked, year) {
    const range = FEE_RANGES.includes(asked) ? asked : '6m';
    const win = feeWindow(range, year);
    const keys = win.months.map(keyOf);

    const billedParams = [String(schoolId), keys, zone()];
    const billedScope = scoped('i."hostel"', allowed, billedParams);
    const paidParams = [String(schoolId), win.from, win.to, zone()];
    const paidScope = scoped('i."hostel"', allowed, paidParams);

    const [billed, paid] = await Promise.all([
        pool.query(
            `SELECT t."ym", sum(t."amount")::float8 AS "amount"
               FROM (SELECT COALESCE(i."netAmount", 0) AS "amount",
                            CASE WHEN (i."period"->>'year') ~ '^[0-9]{4}$'
                                      AND (i."period"->>'month') ~ '^[0-9]{1,2}$'
                                 THEN (i."period"->>'year') || '-' || lpad(i."period"->>'month', 2, '0')
                                 ELSE ${ym('COALESCE(i."dueDate", i."createdAt")', '$3')}
                            END AS "ym"
                       FROM ${T(HostelFeeInvoice)} i
                      WHERE i."school" = $1 AND i."status" <> 'cancelled'${billedScope}) t
              WHERE t."ym" = ANY($2::text[])
              GROUP BY 1`,
            billedParams,
        ),
        // The casts sit inside CASE because Postgres does not promise to test
        // the regex before it casts — one hand-edited payment would otherwise
        // fail the whole dashboard.
        pool.query(
            `SELECT ${ym('t."at"', '$4')} AS "ym", sum(t."amount")::float8 AS "amount"
               FROM (SELECT CASE WHEN (p->>'paidAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                                 THEN (p->>'paidAt')::timestamptz END AS "at",
                            CASE WHEN (p->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                                 THEN (p->>'amount')::float8 ELSE 0 END AS "amount"
                       FROM ${T(HostelFeeInvoice)} i
                      CROSS JOIN LATERAL jsonb_array_elements(
                            CASE WHEN jsonb_typeof(i."payments") = 'array' THEN i."payments" ELSE '[]'::jsonb END) p
                      WHERE i."school" = $1 AND i."status" <> 'cancelled'${paidScope}) t
              WHERE t."at" >= $2 AND t."at" < $3
              GROUP BY 1`,
            paidParams,
        ),
    ]);

    const billedBy = Object.fromEntries(billed.rows.map((r) => [r.ym, Number(r.amount) || 0]));
    const paidBy = Object.fromEntries(paid.rows.map((r) => [r.ym, Number(r.amount) || 0]));
    const months = win.months.map((m) => {
        const k = keyOf(m);
        return {
            key: k, label: MONTHS[m.getMonth()], year: m.getFullYear(),
            billed: round2(billedBy[k] || 0), collected: round2(paidBy[k] || 0),
        };
    });
    return {
        range,
        from: win.from,
        months,
        billed: round2(months.reduce((s, m) => s + m.billed, 0)),
        collected: round2(months.reduce((s, m) => s + m.collected, 0)),
    };
}

const round2 = (n) => Math.round(n * 100) / 100;

/* ── Recent lists ─────────────────────────────────────────────────────────── */

async function recentIncidents(schoolId, allowed, limit = 4) {
    const params = [String(schoolId)];
    const inScope = scoped('i."hostel"', allowed, params);
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT i."_id", i."incidentNumber", i."incidentType", i."severity", i."status", i."date",
                u."name" AS "student", h."name" AS "hostel"
           FROM ${T(HostelIncident)} i
           LEFT JOIN ${T(User)} u ON u."_id" = i."student"
           LEFT JOIN ${T(Hostel)} h ON h."_id" = i."hostel"
          WHERE i."school" = $1${inScope}
          ORDER BY i."date" DESC NULLS LAST, i."createdAt" DESC
          LIMIT $${params.length}`,
        params,
    );
    return rows.map((r) => ({
        _id: String(r._id), number: r.incidentNumber || '', type: r.incidentType || 'other',
        severity: r.severity || 'low', status: r.status || '', date: r.date,
        student: r.student || '', hostel: r.hostel || '',
    }));
}

async function recentActivity(schoolId, allowed, limit = 4, { money = true } = {}) {
    const params = [String(schoolId)];
    let inScope = scoped('a."hostel"', allowed, params);
    // The fee desk's entries are left out for someone who does not run it.
    if (!money) inScope += ` AND a."entityType" NOT IN ('HostelFeeInvoice', 'HostelFeePlan', 'HostelPaymentOrder', 'HostelSettings')`;
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT a."_id", a."description", a."actionType", a."entityType", a."createdAt",
                COALESCE(NULLIF(a."userName", ''), u."name", 'System') AS "who"
           FROM ${T(HostelAuditLog)} a
           LEFT JOIN ${T(User)} u ON u."_id" = a."user"
          WHERE a."school" = $1${inScope}
          ORDER BY a."createdAt" DESC
          LIMIT $${params.length}`,
        params,
    );
    return rows.map((r) => ({
        _id: String(r._id), text: r.description || '', who: r.who,
        action: r.actionType || '', entity: r.entityType || '', at: r.createdAt,
    }));
}

/* ── Academic years ───────────────────────────────────────────────────────── */

/**
 * The school's academic years, newest first, and the one the dashboard opens
 * on: the year marked active, else the one today falls in, else the newest.
 */
async function academicYears(schoolId) {
    const { rows } = await pool.query(
        `SELECT "_id", "yearName", "status", "startDate", "endDate" FROM ${T(AcademicYear)}
          WHERE "school" = $1 ORDER BY "startDate" DESC NULLS LAST`,
        [String(schoolId)],
    );
    const years = rows.map((r) => ({
        _id: String(r._id), yearName: r.yearName, status: r.status,
        startDate: r.startDate, endDate: r.endDate,
    }));
    const now = new Date();
    const current = years.find((y) => y.status === 'active')
        || years.find((y) => y.startDate && y.endDate && new Date(y.startDate) <= now && now <= new Date(y.endDate))
        || years[0] || null;
    return { years, current };
}

module.exports = {
    BED_STATE, FEE_RANGES, hostelsInScope, structureCounts, bedCounts, residence,
    attendanceOn, feeWindow, feeSeries, recentIncidents, recentActivity, academicYears,
    staffResidents,
};
