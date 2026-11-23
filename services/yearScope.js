'use strict';
/**
 * THE academic year a read is about — one rule for every module (Nov 2026).
 *
 * Every screen shows one academic year's data. Which year:
 *
 *   1. the one the screen asks for by name — `?academicYear=` / `?year=` /
 *      `?yearId=` (an id, or `all` for every year) — the screen's own picker;
 *   2. else the year the person is LOOKING AT — the `X-Academic-Year` header
 *      the web and the phone send from the year switcher in their header;
 *   3. else the school's active year (else the year today falls in, else the
 *      newest one).
 *
 * Only reads look at another year. The header is honoured on GET requests and
 * nowhere else, so a write never lands in a past year because somebody was
 * looking at one: writes go where they always went — the active year, or the
 * year their own date falls in.
 *
 * Two kinds of record, two ways to scope them:
 *
 *   rows that carry the year   (classes, sections, exams, fee structures …)
 *       → `scope.id`, `scope.idSql()`, `scope.match()`
 *   rows that carry a date     (trips, purchase orders, visits, payments …)
 *       → `scope.between()`, `scope.sql()`, `scope.has()`
 *
 * A dated row belongs to the year whose term it falls in — and so that no row
 * is ever in nobody's year, a year owns every day from its start date up to
 * the next year's start date: the earliest year reaches back to the beginning
 * and the latest has no end (the rule the notification mailbox already used).
 *
 * A school with no academic year at all sees everything rather than nothing.
 */
const { AsyncLocalStorage } = require('async_hooks');
const pool = require('../db/pool');
const { yearOrderSql, newestYear } = require('../utils/listOrder');
const { zoneOf, dayStartIn } = require('./schoolClock');
const rules = require('./yearRules');

const als = new AsyncLocalStorage();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADER = 'x-academic-year';
const PARAMS = ['academicYear', 'yearId', 'academicYearId', 'year'];
const SWITCHER_ROLES = new Set(['school_admin', 'teacher']);

/** What a request's own year parameter says: an id, 'all', 'current' — else ''. */
function askedBy(req) {
    for (const p of PARAMS) {
        const v = req.query?.[p];
        if (typeof v !== 'string') continue;
        const t = v.trim();
        if (UUID.test(t) || t === 'all' || t === 'current') return t;
    }
    return '';
}

/**
 * Remembers, for the length of one request, the year the person is looking at.
 * Mounted once on /api (server.js) ahead of every router. `on` is true for
 * reads only: nothing a write looks up is narrowed to a year behind its back.
 */
function middleware(req, _res, next) {
    const read = req.method === 'GET';
    const header = read ? String(req.get(HEADER) || '').trim() : '';
    const picked = UUID.test(header) ? header : '';
    const asked = read ? askedBy(req) : '';
    const view = asked || picked;
    // `view`   — the year this request's reads are narrowed to (its own year
    //            parameter first, else the switcher's);
    // `picked` — the switcher's year alone: the one that stands in for the
    //            active year in what this request reads (see `source` below).
    als.run({ on: read, view: view || null, asked: asked || null, picked: picked || null, scope: null, standIn: null, schoolId: null, req }, next);
}

const store = () => als.getStore() || null;
/** The year id (or 'all') this request asked to look at, or null. */
const viewing = () => store()?.view || null;

// The school's years, A–Z. Read on nearly every request, so kept for a few
// seconds; a write to the years (class.controller) drops the entry at once in
// this process, and another worker catches up within the TTL.
const TTL_MS = 5000;
const cache = new Map();          // schoolId → { at, list }

async function yearsOf(schoolId) {
    const key = String(schoolId || '');
    if (!key) return [];
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.list;
    const { rows } = await pool.query(
        `SELECT "_id", "yearName", "status", "startDate", "endDate" FROM "academicyears"
          WHERE "school" = $1 ORDER BY ${yearOrderSql()}`,
        [key],
    );
    const list = rows.map((r) => ({ ...r, _id: String(r._id) }));
    cache.set(key, { at: Date.now(), list });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return list;
}

/** A write changed the school's years: the next read must see it. */
function forget(schoolId) {
    cache.delete(String(schoolId || ''));
    const s = store();
    if (s) s.scope = null;
}

/** The running year: the one marked active, else the one today falls in, else the newest. */
function runningYear(years, now = Date.now()) {
    // Two rows can be marked active (the screen keeps it to one, the table does
    // not insist): the newer one runs, as My Section already reads it.
    return newestYear(years.filter((y) => y.status === 'active'))
        || years.find((y) => y.startDate && y.endDate
            && new Date(y.startDate).getTime() <= now && now <= new Date(y.endDate).getTime() + 86399999)
        || newestYear(years)
        || null;
}

/**
 * The id of the school's running year as it really is — never the year a
 * switcher is showing. For a write that records which year it happened in
 * (a notification is stamped with the year it was sent in).
 */
async function runningYearId(schoolId) {
    if (!schoolId) return null;
    try { return runningYear(await yearsOf(schoolId))?._id || null; } catch { return null; }
}

/** [from, to) for one year among its school's — see the header comment. */
function windowOf(year, years, zone) {
    if (!year) return { from: null, to: null };
    const dated = years.filter((y) => y.startDate)
        .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
    const at = dated.findIndex((y) => String(y._id) === String(year._id));
    if (at < 0) return { from: null, to: null };
    return {
        from: at > 0 ? dayStartIn(dated[at].startDate, zone) : null,
        to: at < dated.length - 1 ? dayStartIn(dated[at + 1].startDate, zone) : null,
    };
}

const dayKey = (d) => {
    if (!d) return null;
    const x = new Date(d);
    return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
};

const shape = (y) => (y ? {
    _id: String(y._id), yearName: y.yearName, name: y.yearName, status: y.status,
    startDate: y.startDate, endDate: y.endDate, current: y.status === 'active',
} : null);

function build({ schoolId, years, year, all }) {
    const zone = zoneOf(schoolId);
    const active = runningYear(years);
    const { from, to } = all ? { from: null, to: null } : windowOf(year, years, zone);
    const id = !all && year ? String(year._id) : null;

    /**
     * " AND <col> >= $n AND <col> < $m" for a timestamp column (or '' when
     * nothing narrows). `params` is the statement's parameter array — the two
     * instants are pushed onto it — or a `$(value) → "$n"` function.
     */
    const sql = (col, params, { lead = ' AND ' } = {}) => {
        const push = typeof params === 'function' ? params : (v) => { params.push(v); return `$${params.length}`; };
        const parts = [];
        if (from) parts.push(`${col} >= ${push(from)}::timestamptz`);
        if (to)   parts.push(`${col} < ${push(to)}::timestamptz`);
        return parts.length ? `${lead}${parts.join(' AND ')}` : '';
    };
    /** The same for a column holding a calendar day (a `date`, or a day stored at UTC midnight). */
    const sqlDay = (col, params, { lead = ' AND ' } = {}) => {
        const push = typeof params === 'function' ? params : (v) => { params.push(v); return `$${params.length}`; };
        const parts = [];
        const lo = from && dayKey(year.startDate);
        const nextStart = to && years.filter((y) => y.startDate && new Date(y.startDate) > new Date(year.startDate))
            .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0];
        if (lo) parts.push(`(${col})::date >= ${push(lo)}::date`);
        if (nextStart) parts.push(`(${col})::date < ${push(dayKey(nextStart.startDate))}::date`);
        return parts.length ? `${lead}${parts.join(' AND ')}` : '';
    };
    /** " AND <col> = $n" for a column holding the year's id; `orNull` keeps rows filed before the column existed. */
    const idSql = (col, params, { lead = ' AND ', orNull = false } = {}) => {
        if (!id) return '';
        const push = typeof params === 'function' ? params : (v) => { params.push(v); return `$${params.length}`; };
        const p = push(id);
        return `${lead}${orNull ? `(${col} = ${p}::uuid OR ${col} IS NULL)` : `${col} = ${p}::uuid`}`;
    };
    /** A find() condition on a date field: `{}` or `{ field: { $gte, $lt } }`. */
    const between = (field) => {
        const cond = {};
        if (from) cond.$gte = from;
        if (to)   cond.$lt = to;
        return Object.keys(cond).length ? { [field]: cond } : {};
    };
    /** A find() condition on a field holding the year's id. */
    const match = (field = 'academicYear', { orNull = false } = {}) => {
        if (!id) return {};
        return { [field]: orNull ? { $in: [id, null] } : id };
    };
    /**
     * A find() condition for rows that name their year in `idField` and, when
     * they name none (written before the column existed), are dated by
     * `dateField`. `{}` when nothing narrows. Merge with `filter.$and = [cond]`
     * or Object.assign when the filter has no `$or` of its own.
     */
    const owns = (idField = 'academicYear', dateField = null) => {
        if (!id) return {};
        if (!dateField) return { [idField]: id };
        return { $or: [{ [idField]: id }, { [idField]: null, ...between(dateField) }] };
    };
    /** Is this date in the year? */
    const has = (date) => {
        if (!from && !to) return true;
        if (!date) return false;
        const t = new Date(date).getTime();
        if (Number.isNaN(t)) return false;
        return (!from || t >= from.getTime()) && (!to || t < to.getTime());
    };
    /** Is this (month 1–12, year) one of the year's months? */
    const hasMonth = (month, yr) => {
        if (!from && !to) return true;
        const first = Date.UTC(Number(yr), Number(month) - 1, 15);
        return (!from || first >= from.getTime() - 15 * 86400000) && (!to || first < to.getTime());
    };

    return {
        schoolId: String(schoolId || ''),
        all: !!all,
        year: all ? null : year,
        id,
        name: all ? 'all' : (year?.yearName || null),
        active,
        activeId: active ? String(active._id) : null,
        /** true when the screen shows the year the school is running (writes make sense here). */
        isRunning: !all && !!year && !!active && String(year._id) === String(active._id),
        years,
        from, to,
        fromDay: from && year ? dayKey(year.startDate) : null,
        sql, sqlDay, idSql, between, match, owns, has, hasMonth,
        /** For a response: the year shown and the list a picker offers. */
        out: () => ({
            academicYear: all ? { _id: 'all', yearName: 'All years', name: 'All years' } : shape(year),
            academicYears: years.map(shape),
        }),
    };
}

/**
 * The scope for a school. `asked` is what the caller's own parameter said
 * (an id, 'all', 'current', a year name) — pass nothing to follow the year
 * being looked at.
 */
async function resolve(schoolId, asked) {
    const years = await yearsOf(schoolId);
    const byId = (v) => years.find((y) => String(y._id) === String(v));
    const want = String(asked ?? '').trim();

    const pick = (v) => {
        if (!v) return undefined;
        if (v === 'all') return { all: true };
        if (v === 'current' || v === 'active') return { year: runningYear(years) };
        const hit = UUID.test(v) ? byId(v) : years.find((y) => y.yearName === v);
        return hit ? { year: hit } : undefined;
    };

    const chosen = pick(want) || pick(viewing()) || { year: runningYear(years) };
    return build({ schoolId, years, year: chosen.year || null, all: !!chosen.all });
}

/**
 * `{ academicYear: <the year in view> }` to spread into a find() where the code
 * means "this year's" (a teacher's own section, this year's classes) — `{}`
 * for a school with no academic year, so nothing is hidden there.
 */
async function thisYear(schoolId, field = 'academicYear') {
    const y = await current(schoolId);
    return y ? { [field]: String(y._id) } : {};
}

/** The year the header's switcher is on for this read (an id), or null — never a screen's own parameter. */
const picked = () => { const s = store(); return s && s.on && !s.off ? s.picked || null : null; };

/** The scope for a request: its own year parameter, else the year being looked at. */
function of(req, { params = PARAMS } = {}) {
    let asked;
    for (const p of params) {
        const v = req.query?.[p];
        if (typeof v === 'string' && v.trim()) { asked = v.trim(); break; }
    }
    return resolve(req.schoolId, asked);
}

/**
 * The year row a read should use where the code used to ask for "the active
 * year": the year being looked at when there is one, else the active year.
 * Null when the school has none (or the person is looking at all years).
 */
async function current(schoolId) {
    const s = await resolve(schoolId);
    return s.year || s.active || null;
}

// ── Models that say how their rows belong to a year ──────────────────────────
//
// A model names its rule once — schema.set('yearScope', rule) — and every
// find / count / distinct / aggregate a READ makes on it is narrowed to the
// year in view (db/model.js asks `narrow` below). So a module's lists, tiles,
// charts and reports cannot disagree about the year: none of them states it.
//
//   { at: 'date' }                    an event: the day it happened
//   { span: ['fromDate', 'toDate'] }  something that lasts: shown in every year
//                                     it overlaps (no end date = still running)
//   { id: 'academicYear' }            the row names its year
//   { id: 'academicYear', else: … }   …and rows that name none fall back to a rule
//   { months: ['month', 'year'] }     a calendar month (payroll)
//
// Not narrowed, ever: a read by `_id` (opening one record must work whatever
// year is in view), anything a write looks up, background jobs, and anything
// inside `allYears(() => …)` — for the few reads that are about every year
// (dues carried forward, "has this ever happened").

/** Called by the sign-in guard once the school is known: works the scope out for this request. */
async function enter(schoolId, role) {
    const s = store();
    if (!s || !schoolId) return null;
    s.schoolId = String(schoolId);
    // The switcher belongs to the people who work with records. Students,
    // parents and applicants always read the school's current year, whatever
    // header a shared browser tab still carries.
    if (role && !SWITCHER_ROLES.has(role)) { s.picked = null; s.view = s.asked || null; }
    s.role = role || null;
    if (!s.on) return null;
    try {
        s.scope = await resolve(schoolId);
        // The switcher is on a year other than the running one: that year
        // stands in for it in this request's reads.
        const years = s.scope.years;
        const real = years.find((y) => y.status === 'active') || null;
        const chosen = s.picked && years.find((y) => String(y._id) === s.picked);
        s.standIn = chosen && (!real || String(real._id) !== String(chosen._id)) ? String(chosen._id) : null;
    } catch { s.scope = null; s.standIn = null; }
    return s.scope;
}

/**
 * Is this request opening ONE record (its address carries an id)? Then its
 * reads are not narrowed: a record opened from a link or a notification shows
 * all of itself — its lines, its history — whatever year is in view. Lists and
 * boards (no id in the address) are what follow the year.
 */
function opensOneRecord(s) {
    const p = s.req?.params;
    if (!p) return false;
    for (const v of Object.values(p)) if (typeof v === 'string' && UUID.test(v)) return true;
    return false;
}

/** The scope in force for this request's reads, or null (a write, a job, one record, all years, no years). */
function now() {
    const s = store();
    if (!s || !s.on || s.off || !s.scope) return null;
    if (opensOneRecord(s)) return null;
    const sc = s.scope;
    if (sc.all || !sc.year) return null;
    return sc;
}

/** Run `fn` with no year narrowing — for reads that are about every year. */
function allYears(fn) {
    const s = store();
    // Awaited INSIDE the run: a query object only reads when it is awaited, and
    // must do so here, not back in the caller's own year.
    return als.run({ ...(s || {}), off: true }, async () => await fn());
}

const monthIndex = (d) => d.getUTCFullYear() * 12 + d.getUTCMonth();
const list = (v) => (Array.isArray(v) ? v : [v]);
const all = (parts) => { const p = parts.filter(Boolean); return !p.length ? null : p.length === 1 ? p[0] : { $and: p }; };

/** "the first of these date fields that is set" compared with a bound. */
function dateCond(fields, op, bound) {
    const f = list(fields);
    const alts = f.map((field, i) => all([...f.slice(0, i).map((prev) => ({ [prev]: null })), { [field]: { [op]: bound } }]));
    return alts.length === 1 ? alts[0] : { $or: alts };
}

/** The dated part of a rule (at / span / months) as a find() condition, or null. */
function datedCondition(rule, sc) {
    if (rule.at) {
        return all([sc.from && dateCond(rule.at, '$gte', sc.from), sc.to && dateCond(rule.at, '$lt', sc.to)]);
    }
    if (rule.span) {
        const [start, end] = rule.span;
        return all([
            sc.to && dateCond(start, '$lt', sc.to),
            sc.from && { $or: [{ [end]: null }, { [end]: { $gte: sc.from } }] },
        ]);
    }
    if (rule.months) {
        const [m, y] = rule.months;
        const parts = [];
        if (sc.from) {
            // The month the year starts in belongs to it.
            const d = new Date(sc.from.getTime() + 12 * 3600 * 1000);
            const yy = d.getUTCFullYear(), mm = d.getUTCMonth() + 1;
            parts.push({ $or: [{ [y]: { $gt: yy } }, { [y]: yy, [m]: { $gte: mm } }] });
        }
        if (sc.to) {
            const d = new Date(sc.to.getTime() + 12 * 3600 * 1000);
            const yy = d.getUTCFullYear(), mm = d.getUTCMonth() + 1;
            parts.push({ $or: [{ [y]: { $lt: yy } }, { [y]: yy, [m]: { $lt: mm } }] });
        }
        return all(parts);
    }
    return null;
}

/**
 * A rule as a find() condition for the scope, or null when it narrows nothing.
 *
 *   the year's rows   = rows naming the year (`id`)  — or, naming none, dated in it
 *   plus what is open = rows still in an `open` status that began before the
 *                       year ended: an unpaid invoice, an unanswered complaint
 *                       or a resident still in their bed does not vanish from
 *                       the work in hand because the year turned
 */
function conditionFor(rule, sc) {
    if (!rule || !sc) return null;
    const dated = datedCondition(rule, sc);
    let base;
    if (rule.id) {
        if (rule.orNull && !dated) base = { [rule.id]: { $in: [sc.id, null] } };
        else if (rule.at || rule.span || rule.months) {
            base = { $or: [{ [rule.id]: sc.id }, all([{ [rule.id]: null }, dated])] };
        } else base = { [rule.id]: sc.id };
    } else base = dated;
    if (!base) return null;
    if (!rule.open || !rule.at) return base;
    const still = all([
        { [rule.statusField || 'status']: { $in: rule.open } },
        sc.to && dateCond(rule.at, '$lt', sc.to),
    ]);
    return { $or: [base, still] };
}

/** db/model.js: the filter a read should really run with. */
function narrow(rule, filter) {
    const sc = now();
    if (!sc) return filter;
    if (filter && Object.prototype.hasOwnProperty.call(filter, '_id')) return filter;
    // A read for another school (a platform screen) is none of this school's years.
    if (filter && filter.school != null && typeof filter.school !== 'object'
        && String(filter.school?._id || filter.school) !== sc.schoolId) return filter;
    const cond = conditionFor(rule, sc);
    if (!cond) return filter;
    return filter && Object.keys(filter).length ? { $and: [filter, cond] } : cond;
}

// The same rules as SQL, for the screens that write their own statements. The
// two instants are our own Date values, written as literals so a statement's
// numbered parameters are left alone.
const lit = (d) => `'${new Date(d).toISOString()}'::timestamptz`;
const qi = (n) => `"${String(n).replace(/"/g, '""')}"`;

function sqlFor(rule, sc, a = '') {
    if (!rule || !sc) return '';
    const col = (f) => `${a ? `${a}.` : ''}${qi(f)}`;
    const first = (fields) => { const f = list(fields).map(col); return f.length === 1 ? f[0] : `COALESCE(${f.join(', ')})`; };
    const and = (parts) => { const p = parts.filter(Boolean); return p.length ? `(${p.join(' AND ')})` : ''; };

    let dated = '';
    if (rule.at) {
        dated = and([sc.from && `${first(rule.at)} >= ${lit(sc.from)}`, sc.to && `${first(rule.at)} < ${lit(sc.to)}`]);
    } else if (rule.span) {
        const [start, end] = rule.span;
        dated = and([sc.to && `${first(start)} < ${lit(sc.to)}`, sc.from && `(${col(end)} IS NULL OR ${col(end)} >= ${lit(sc.from)})`]);
    } else if (rule.months) {
        const [m, y] = rule.months;
        const idx = `(${col(y)}::int * 12 + ${col(m)}::int - 1)`;
        dated = and([
            sc.from && `${idx} >= ${monthIndex(new Date(sc.from.getTime() + 12 * 3600 * 1000))}`,
            sc.to && `${idx} < ${monthIndex(new Date(sc.to.getTime() + 12 * 3600 * 1000))}`,
        ]);
    }

    let base;
    if (rule.id) {
        const mine = `${col(rule.id)} = '${sc.id}'::uuid`;
        if (rule.orNull && !dated) base = `(${mine} OR ${col(rule.id)} IS NULL)`;
        else if (rule.at || rule.span || rule.months) base = `(${mine} OR (${col(rule.id)} IS NULL${dated ? ` AND ${dated}` : ''}))`;
        else base = mine;
    } else base = dated;
    if (!base) return '';
    if (!rule.open || !rule.at) return base;
    const openList = rule.open.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
    const still = and([`${col(rule.statusField || 'status')} IN (${openList})`, sc.to && `${first(rule.at)} < ${lit(sc.to)}`]);
    return `(${base} OR ${still})`;
}

// ── "The active year" while another year is being looked at ─────────────────
//
// Most of the app finds its year by asking for the one whose status is
// 'active' — a hundred-odd lookups across every module. When the year switcher
// is on another year, a READ sees that year as the active one (and the real
// one as inactive), so all of those lookups answer with the year in view and
// no module needs to know there is a switcher. The stored row is not touched,
// writes never see it, and the two screens that are ABOUT the years themselves
// (Academic Years, the switcher's own list) read the real statuses through
// `allYears`.

/** The id standing in for the active year in this request's reads, or null. */
function standIn() {
    const s = store();
    return s && s.on && !s.off && s.standIn ? s.standIn : null;
}

/** A year's status as this request should read it — for hand-written SQL. `alias` is the academicyears alias. */
function yearStatus(alias = '') {
    const col = `${alias ? `${alias}.` : ''}"status"`;
    const id = `${alias ? `${alias}.` : ''}"_id"`;
    const as = standIn();
    if (!as) return col;
    return `(CASE WHEN ${id} = '${as}'::uuid THEN 'active' WHEN ${col} = 'active' THEN 'inactive' ELSE ${col} END)`;
}

/** The academicyears table as this request should read it (see above) — or null for the plain table. */
function yearsSource() {
    const as = standIn();
    if (!as) return null;
    return `(SELECT "_id", "school", "yearName", "startDate", "endDate", "createdBy", "createdAt",
                    ${yearStatus()} AS "status" FROM "academicyears")`;
}

/**
 * A student's class, section and roll number while another year is in view.
 *
 * The profile carries a pointer to the ACTIVE year's placement
 * (services/enrollment.js), and a great many reads go by it — "the students of
 * this section", a child's class on a parent's card. While the switcher is on
 * another year those reads see that year's placement instead: the profile row
 * with its three pointer columns taken from the student's enrolment row for the
 * year in view (a student with no row in that year keeps the stored pointer).
 * `columns` is every column of the table; null = read the table itself.
 */
const POINTER = { currentClass: 'class', currentSection: 'section', rollNumber: 'rollNumber' };
const MARK = '/*year-in-view*/';
const FAMILY_ROLES = new Set(['student', 'parent']);

/**
 * The running year's id when this read is a student's or a parent's — the
 * people whose own screens must never show another year's class as this
 * year's. (Staff keep the stored pointer: the office has to see where an
 * unplaced student was last, to place them.)
 */
function familyYear() {
    const s = store();
    if (!s || !s.on || s.off || !FAMILY_ROLES.has(s.role)) return null;
    const real = s.scope?.years?.find((y) => y.status === 'active');
    return real ? String(real._id) : null;
}

/**
 * The student profiles as this request should read them — or null for the
 * table itself. `columns` is every column of the table.
 *
 *   another year in view (staff)  the three pointer columns come from the
 *        student's enrolment row for that year (no row there = the stored pointer)
 *   a student or a parent         the pointer is shown only when it IS this
 *        year's placement. A student not yet placed in the running year has
 *        no class this year — so their own screens say so instead of going on
 *        showing last year's class, classmates, registers and results under
 *        this year's name.
 */
function profilesSource(columns) {
    const as = standIn();
    if (as) {
        const cols = columns.map((c) => (POINTER[c]
            ? `CASE WHEN e."_id" IS NOT NULL THEN e.${qi(POINTER[c])} ELSE sp.${qi(c)} END AS ${qi(c)}`
            : `sp.${qi(c)}`));
        return `(SELECT ${MARK} ${cols.join(', ')}
               FROM "studentprofiles" sp
               LEFT JOIN "studentenrollments" e ON e."student" = sp."user" AND e."academicYear" = '${as}'::uuid)`;
    }
    const mine = familyYear();
    if (mine) {
        const cols = columns.map((c) => (POINTER[c]
            ? `CASE WHEN yc."academicYear" = '${mine}'::uuid THEN sp.${qi(c)} END AS ${qi(c)}`
            : `sp.${qi(c)}`));
        return `(SELECT ${MARK} ${cols.join(', ')}
               FROM "studentprofiles" sp
               LEFT JOIN "classes" yc ON yc."_id" = sp."currentClass")`;
    }
    return null;
}

/**
 * The same for hand-written SELECTs (db/pool.js runs every statement past
 * this): while another year is in view, a statement that reads
 * "studentprofiles" reads the profiles as above, so a class shown beside a
 * student's name is the class of the year on screen in every module — not in
 * the ORM's reads alone. Untouched: every statement when no other year is in
 * view, anything that is not a SELECT, and a statement already rewritten.
 */
const SQL_WORDS = new Set(['where', 'on', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'group', 'order', 'limit', 'union', 'using', 'natural', 'window', 'having', 'offset', 'for']);
let profileColumns = null;
function rewriteProfiles(text) {
    if (!(standIn() || familyYear()) || text.includes(MARK) || !/^\s*(SELECT|WITH)\b/i.test(text)) return text;
    if (/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/i.test(text)) return text;
    if (!profileColumns) {
        const fields = require('../models/StudentProfile').schema.parsed().fields;
        profileColumns = ['_id', ...Object.keys(fields).filter((f) => f !== '_id')];
    }
    const src = profilesSource(profileColumns);
    if (!src) return text;
    return text.replace(/((?:FROM|JOIN)\s+)"studentprofiles"(\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/g, (m, lead, tail, alias) => {
        const named = alias && !SQL_WORDS.has(alias.toLowerCase());
        return named ? `${lead}${src}${tail}` : `${lead}${src} AS "studentprofiles"${tail || ''}`;
    });
}

const ruleOf = (Model) => (typeof Model === 'string' ? null : Model?.schema?.get?.('yearScope') || rules[Model?.modelName] || null);
const tableOf = (Model) => (typeof Model === 'string' ? Model : Model?.tableName || Model?.collection?.name);

/**
 * A model's table for a FROM / JOIN in a hand-written list or board: the plain
 * table name, or — when a year is in view and the model has a rule — the
 * year's rows of it as a sub-select. Use the plain name where one record is
 * opened by its id.
 *     FROM ${ys.table(HostelOutpass)} o
 */
function table(Model, rule = ruleOf(Model)) {
    const name = qi(tableOf(Model));
    const sc = now();
    const where = sc ? sqlFor(rule, sc) : '';
    return where ? `(SELECT * FROM ${name} WHERE ${where})` : name;
}

/**
 * A model's rule as a condition on an alias already in the statement:
 *     WHERE o."school" = $1 ${ys.and(HostelOutpass, 'o')}
 */
function and(Model, alias = '', { lead = ' AND ', rule = ruleOf(Model) } = {}) {
    const sc = now();
    const where = sc ? sqlFor(rule, sc, alias) : '';
    return where ? `${lead}${where}` : '';
}

/**
 * " AND <expr> in the year in view" for a hand-written list, where `expr` is a
 * timestamp expression already in the statement ('' when nothing narrows):
 *     WHERE a."school" = $1 ${ys.within('a."date"')}
 */
function within(expr, { lead = ' AND ' } = {}) {
    const sc = now();
    if (!sc) return '';
    const parts = [];
    if (sc.from) parts.push(`${expr} >= ${lit(sc.from)}`);
    if (sc.to)   parts.push(`${expr} < ${lit(sc.to)}`);
    return parts.length ? `${lead}${parts.join(' AND ')}` : '';
}

/** " AND <expr> = the year in view's id" for a hand-written list ('' when no year is in view). */
function isYear(expr, { lead = ' AND ', orNull = false } = {}) {
    const sc = now();
    if (!sc?.id) return '';
    return `${lead}${orNull ? `(${expr} = '${sc.id}'::uuid OR ${expr} IS NULL)` : `${expr} = '${sc.id}'::uuid`}`;
}

module.exports = {
    within, isYear, thisYear,
    middleware, enter, now, allYears, narrow, table, and, conditionFor, sqlFor, ruleOf,
    standIn, familyYear, yearStatus, yearsSource, profilesSource, rewriteProfiles, picked,
    of, resolve, current, yearsOf, runningYear, runningYearId, windowOf, viewing, forget, shape, askedBy, HEADER,
};
