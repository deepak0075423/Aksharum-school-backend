'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Library reporting.
//
//  The questions a librarian is actually asked each term: what is out and late,
//  what gets borrowed, what never moves, what one member has had, what the
//  collection is worth, what the shelves should hold, what the fines did, and
//  how the library was used month by month.
//
//  One registry (REPORTS, at the foot of this file) describes every one of them
//  — its name, the controls it takes and the columns it answers on — and the
//  index endpoint hands that to the client. A report added here appears on the
//  web panel and in the app without either of them being edited.
//
//  Two rules hold across all of them:
//
//   • Rows carry values, not sentences. A date is a date and a fine is a
//     number, so the client can right-align the money, colour the overdue days
//     and print a rupee sign, and the spreadsheet gets numbers Excel can sum.
//     The column list is the single description of what a row holds, which is
//     what makes one table able to render eight different reports.
//
//   • Filtering and paging happen in SQL. The footer's "1 to 10 of 214" is the
//     real count of what was asked for, and `?format=xlsx` exports everything
//     the filters matched rather than the page that happens to be on screen.
// ─────────────────────────────────────────────────────────────────────────────
const XLSX = require('xlsx');
const pool = require('../db/pool');

const LibraryBook     = require('../models/LibraryBook');
const LibraryBookCopy = require('../models/LibraryBookCopy');
const LibraryIssuance = require('../models/LibraryIssuance');
const LibraryFine     = require('../models/LibraryFine');
const User            = require('../models/User');
const StudentProfile  = require('../models/StudentProfile');
const Class           = require('../models/Class');
const ClassSection    = require('../models/ClassSection');
const { notify }      = require('../services/notifyService');
const {
    sweepOverdue, ACTIVE_ISSUANCE, BORROWER_ROLES, borrowerAudience, audit, fmtLibDate,
} = require('../services/libraryRules');

const T = {
    book: `"${LibraryBook.tableName}"`,
    copy: `"${LibraryBookCopy.tableName}"`,
    iss:  `"${LibraryIssuance.tableName}"`,
    fine: `"${LibraryFine.tableName}"`,
    user: `"${User.tableName}"`,
    prof: `"${StudentProfile.tableName}"`,
    cls:  `"${Class.tableName}"`,
    sec:  `"${ClassSection.tableName}"`,
};

// ── Request plumbing ─────────────────────────────────────────────────────────

const EXPORT_CAP = 5000;

const wantsXlsx = (req) => String(req.query.format || '').toLowerCase() === 'xlsx';

function paging(query) {
    const page  = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(200, Math.max(1, Math.floor(Number(query.limit) || 10)));
    return { page, limit, offset: (page - 1) * limit };
}

/**
 * The optional date window. `to` covers the whole of its day: a range ending on
 * the 30th that stopped at midnight would drop everything that happened on it.
 */
function window_(query) {
    const parse = (v, end) => {
        if (!v) return null;
        const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : v);
        return Number.isNaN(d.getTime()) ? null : d;
    };
    return { from: parse(query.from, false), to: parse(query.to, true) };
}

/** ILIKE takes % and _ as wildcards, so a member searching for "A_1" means it. */
const like = (q) => `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Collects WHERE clauses and their parameters together, so a filter is one line
 * instead of a clause here and a push there. `$?` is filled in with the number
 * the value actually landed on; a blank value adds nothing at all.
 */
function conditions(base, values) {
    const clauses = [...base];
    return {
        add(sql, value) {
            if (value === undefined || value === null || value === '') return;
            values.push(value);
            clauses.push(sql.replace(/\$\?/g, `$${values.length}`));
        },
        raw(sql) { if (sql) clauses.push(sql); },
        sql: () => clauses.join(' AND '),
    };
}

const num   = (v) => Number(v ?? 0);
const money = (v) => Math.round(Number(v ?? 0) * 100) / 100;
const day   = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const text  = (v) => (v == null ? '' : String(v));
const list  = (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : text(v));

/**
 * An id from the query string, or nothing. Postgres refuses a malformed uuid
 * with an error rather than an empty result, so an id out of a stale bookmark
 * would come back as a 500 instead of "no rows".
 */
const uuid = (v) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''))
    ? String(v)
    : '');

/** Strips the bookkeeping column the window function added. */
const clean = (row) => { const { _total, ...rest } = row; return rest; };

// ── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Sends the rows as JSON, or as a spreadsheet when `?format=xlsx`.
 *
 * Both come off the same column list, so the sheet's headings, its order and
 * its values are the table's — including the columns the table folds into
 * another cell (a book's ISBN, a member's class), which a spreadsheet wants as
 * columns of their own.
 */
function deliver(req, res, report, { rows, total, page, limit, summary = [], extra = {} }) {
    if (!wantsXlsx(req)) {
        return res.json({
            success: true,
            data: rows,
            columns: report.columns,
            summary,
            total,
            page,
            pages: Math.max(1, Math.ceil(total / limit)),
            limit,
            ...extra,
        });
    }

    const flat = (value, column) => {
        if (value == null || value === '') return '';
        if (column.type === 'money' || column.type === 'num' || column.type === 'days') return Number(value);
        if (column.type === 'date') return day(value);
        return String(value);
    };
    const sheet = rows.length
        ? XLSX.utils.json_to_sheet(rows.map((r) => {
            const out = {};
            for (const c of report.columns) out[c.label] = flat(r[c.key], c);
            return out;
        }))
        // json_to_sheet([]) writes a sheet with no headings at all, which opens
        // as a blank file with no clue what was asked for.
        : XLSX.utils.aoa_to_sheet([report.columns.map((c) => c.label)]);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, report.name.slice(0, 31));
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="${report.key}_${stamp}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
}

const fail = (res, e) => res.status(500).json({ success: false, message: e.message });

// A summary figure above the table. `type` is the same vocabulary the columns
// use, so one renderer formats both.
const stat = (label, value, type = 'num', caption = '') => ({ label, value, type, caption });

// ── Column shorthands ────────────────────────────────────────────────────────
//
//  `inline: true` means the value belongs to the cell before it — an ISBN under
//  a title, a class under a member's name — so the table draws it there and the
//  spreadsheet still gets a column of its own.

const col = (key, label, type = 'text', rest = {}) => ({ key, label, type, ...rest });

// ── Shared SQL fragments ─────────────────────────────────────────────────────

// Class and section live on the student's profile, not on the loan or the fine,
// so every people-shaped report reaches them the same way. Teachers have no
// profile row here, which is why all three joins are LEFT.
const BORROWER_JOIN = (userAlias) => `
    LEFT JOIN ${T.prof} sp ON sp."user" = ${userAlias}."_id"
    LEFT JOIN ${T.cls}  cl ON cl."_id"  = sp."currentClass"
    LEFT JOIN ${T.sec}  cs ON cs."_id"  = sp."currentSection"`;

const CLASS_LABEL = `NULLIF(trim(concat_ws(' ', cl."className", cs."sectionName")), '')`;

/** What a fine row still owes, once waivers and part payments are taken off. */
const OUTSTANDING = `GREATEST(0, f."amount" - COALESCE(f."waivedAmount", 0) - COALESCE(f."paidAmount", 0))`;

// A book's authors, as something a search can be run over. The column is jsonb,
// not a Postgres array, so array_to_string refuses it — and
// jsonb_array_elements_text would throw on any row where it is null or a bare
// string rather than a list. Casting the whole value to text searches every
// name in it and cannot fail on a row shaped unexpectedly.
const AUTHORS_TEXT = `COALESCE(b."authors"::text, '')`;

// ═════════════════════════════════════════════════════════════════════════════
//  The reports
// ═════════════════════════════════════════════════════════════════════════════

// ── Overdue register ─────────────────────────────────────────────────────────
// The list the librarian works from: who has what, how late, and what it owes.
exports.overdueRegister = async (req, res) => {
    try {
        const report = byKey('overdue');
        await sweepOverdue(req.schoolId);

        const { page, limit, offset } = paging(req.query);
        const values = [String(req.schoolId), ACTIVE_ISSUANCE];
        const w = conditions(['i."school" = $1', 'i."status" = ANY($2::text[])', 'i."dueDate" < now()'], values);

        w.add('sp."currentClass" = $?::uuid', uuid(req.query.classId));
        w.add('sp."currentSection" = $?::uuid', uuid(req.query.sectionId));
        w.add('u."role" = $?', BORROWER_ROLES.includes(req.query.role) ? req.query.role : '');
        w.add(
            '(u."name" ILIKE $? OR b."title" ILIKE $? OR b."isbn" ILIKE $? OR c."uniqueCode" ILIKE $?)',
            req.query.q ? like(req.query.q) : '',
        );
        // Lateness buckets rather than a status filter: everything on this
        // report is overdue, so "status" would filter nothing. How late it is
        // is the thing that decides who gets chased first.
        const LATE = {
            week:  '(CURRENT_DATE - i."dueDate"::date) BETWEEN 1 AND 7',
            month: '(CURRENT_DATE - i."dueDate"::date) BETWEEN 8 AND 30',
            long:  '(CURRENT_DATE - i."dueDate"::date) > 30',
        };
        w.raw(LATE[req.query.lateness]);

        const FROM = `
              FROM ${T.iss}  i
              JOIN ${T.user} u ON u."_id" = i."issuedTo"
              JOIN ${T.book} b ON b."_id" = i."book"
              JOIN ${T.copy} c ON c."_id" = i."bookCopy"
              ${BORROWER_JOIN('u')}
              LEFT JOIN LATERAL (
                  SELECT COALESCE(sum(${OUTSTANDING}), 0)::float AS "owed"
                    FROM ${T.fine} f
                   WHERE f."issuance" = i."_id" AND f."status" <> 'waived'
              ) fn ON true
             WHERE ${w.sql()}`;

        const rowLimit = wantsXlsx(req) ? EXPORT_CAP : limit;
        const { rows } = await pool.query(
            `SELECT i."_id",
                    u."name"        AS "member",
                    u."role"        AS "role",
                    ${CLASS_LABEL}  AS "class",
                    b."title"       AS "book",
                    b."isbn"        AS "isbn",
                    c."uniqueCode"  AS "copy",
                    i."issueDate"   AS "issued",
                    i."dueDate"     AS "due",
                    GREATEST(0, (CURRENT_DATE - i."dueDate"::date))::int AS "daysLate",
                    fn."owed"       AS "fine",
                    i."status"      AS "status",
                    (count(*) OVER ())::int AS "_total"
                    ${FROM}
             ORDER BY i."dueDate" ASC
             LIMIT ${rowLimit} ${wantsXlsx(req) ? '' : `OFFSET ${offset}`}`,
            values,
        );

        const { rows: agg } = await pool.query(
            `SELECT count(*)::int AS "loans",
                    COALESCE(sum(fn."owed"), 0)::float AS "owed",
                    COALESCE(max(CURRENT_DATE - i."dueDate"::date), 0)::int AS "worst",
                    count(DISTINCT i."issuedTo")::int AS "members"
                    ${FROM}`,
            values,
        );
        const a = agg[0] || {};

        deliver(req, res, report, {
            rows: rows.map((r) => ({
                ...clean(r),
                issued: day(r.issued), due: day(r.due),
                fine: money(r.fine), daysLate: num(r.daysLate),
                class: text(r.class), isbn: text(r.isbn),
            })),
            total: num(a.loans), page, limit,
            summary: [
                stat('Books overdue', num(a.loans), 'num', 'Out past the due date'),
                stat('Members holding them', num(a.members), 'num'),
                stat('Fines outstanding', money(a.owed), 'money', 'Charged and unpaid'),
                stat('Longest overdue', num(a.worst), 'days', 'Days past the due date'),
            ],
        });
    } catch (e) { fail(res, e); }
};

// ── Most borrowed ────────────────────────────────────────────────────────────
// What the collection is actually for. Loans per copy is the figure that
// decides the next purchase: forty loans across twenty copies is a quiet book.
exports.mostBorrowed = async (req, res) => {
    try {
        const report = byKey('popular');
        const { page, limit, offset } = paging(req.query);
        const { from, to } = window_(req.query);

        const values = [String(req.schoolId), from, to];
        const w = conditions([
            'b."school" = $1',
            '($2::timestamptz IS NULL OR i."issueDate" >= $2)',
            '($3::timestamptz IS NULL OR i."issueDate" <= $3)',
        ], values);
        w.add('b."category" = $?', req.query.category);
        w.add('u."role" = $?', BORROWER_ROLES.includes(req.query.role) ? req.query.role : '');
        w.add(
            `(b."title" ILIKE $? OR b."isbn" ILIKE $? OR ${AUTHORS_TEXT} ILIKE $?)`,
            req.query.q ? like(req.query.q) : '',
        );

        const FROM = `
              FROM ${T.book} b
              JOIN ${T.iss}  i ON i."book" = b."_id"
              JOIN ${T.user} u ON u."_id" = i."issuedTo"
             WHERE ${w.sql()}`;
        const GROUP = `GROUP BY b."_id", b."title", b."isbn", b."authors", b."category", b."totalCopies"`;

        const rowLimit = wantsXlsx(req) ? EXPORT_CAP : limit;
        const { rows } = await pool.query(
            `SELECT b."_id",
                    b."title"    AS "book",
                    b."isbn"     AS "isbn",
                    b."authors"  AS "authors",
                    b."category" AS "category",
                    count(i."_id")::int              AS "loans",
                    count(DISTINCT i."issuedTo")::int AS "readers",
                    b."totalCopies"                  AS "copies",
                    -- Both sides cast to numeric: totalCopies is stored as a
                    -- float, and round(double precision, int) is not a function
                    -- Postgres has — the two-argument round is numeric only.
                    CASE WHEN COALESCE(b."totalCopies", 0) > 0
                         THEN round(count(i."_id")::numeric / b."totalCopies"::numeric, 2)::float
                         ELSE count(i."_id")::float END AS "perCopy",
                    max(i."issueDate") AS "lastLoan",
                    (count(*) OVER ())::int AS "_total"
                    ${FROM}
             ${GROUP}
             ORDER BY count(i."_id") DESC, b."title" ASC
             LIMIT ${rowLimit} ${wantsXlsx(req) ? '' : `OFFSET ${offset}`}`,
            values,
        );

        const { rows: agg } = await pool.query(
            `SELECT count(*)::int AS "loans",
                    count(DISTINCT i."book")::int AS "titles",
                    count(DISTINCT i."issuedTo")::int AS "readers"
                    ${FROM}`,
            values,
        );
        const a = agg[0] || {};

        deliver(req, res, report, {
            rows: rows.map((r) => ({
                ...clean(r),
                authors: list(r.authors), category: text(r.category), isbn: text(r.isbn),
                loans: num(r.loans), readers: num(r.readers), copies: num(r.copies),
                perCopy: num(r.perCopy), lastLoan: day(r.lastLoan),
            })),
            // Rows are grouped by title, so the count of titles borrowed *is*
            // the number of rows this report has.
            total: num(a.titles), page, limit,
            summary: [
                stat('Loans in this window', num(a.loans), 'num'),
                stat('Titles borrowed', num(a.titles), 'num', 'At least one loan'),
                stat('Members borrowing', num(a.readers), 'num'),
            ],
        });
    } catch (e) { fail(res, e); }
};

// ── Dead stock ───────────────────────────────────────────────────────────────
// Books that have not moved since `?since` (a year back by default). What a
// librarian weeds, and what stops the next purchase repeating a mistake — so it
// carries what the idle copies cost as well as how long they have sat there.
exports.deadStock = async (req, res) => {
    try {
        const report = byKey('dead');
        const { page, limit, offset } = paging(req.query);
        const parsed = req.query.since ? new Date(`${req.query.since}T00:00:00.000Z`) : null;
        const since = parsed && !Number.isNaN(parsed.getTime())
            ? parsed
            : new Date(Date.now() - 365 * 86400000);

        const values = [String(req.schoolId), since];
        const w = conditions(['b."school" = $1'], values);
        w.add('b."category" = $?', req.query.category);
        w.add(
            `(b."title" ILIKE $? OR b."isbn" ILIKE $? OR ${AUTHORS_TEXT} ILIKE $?)`,
            req.query.q ? like(req.query.q) : '',
        );

        const FROM = `
              FROM ${T.book} b
              LEFT JOIN ${T.iss} i ON i."book" = b."_id"
              LEFT JOIN LATERAL (
                  SELECT COALESCE(sum(c."cost"), 0)::float AS "value"
                    FROM ${T.copy} c WHERE c."book" = b."_id"
              ) cv ON true
             WHERE ${w.sql()}`;
        const GROUP  = `GROUP BY b."_id", b."title", b."isbn", b."category", b."totalCopies", cv."value"`;
        const HAVING = `HAVING max(i."issueDate") IS NULL OR max(i."issueDate") < $2`;

        const rowLimit = wantsXlsx(req) ? EXPORT_CAP : limit;
        const { rows } = await pool.query(
            `SELECT b."_id",
                    b."title"    AS "book",
                    b."isbn"     AS "isbn",
                    b."category" AS "category",
                    b."totalCopies"     AS "copies",
                    cv."value"          AS "value",
                    count(i."_id")::int AS "loansEver",
                    max(i."issueDate")  AS "lastLoan",
                    (count(*) OVER ())::int AS "_total"
                    ${FROM}
             ${GROUP} ${HAVING}
             ORDER BY max(i."issueDate") ASC NULLS FIRST, b."title" ASC
             LIMIT ${rowLimit} ${wantsXlsx(req) ? '' : `OFFSET ${offset}`}`,
            values,
        );

        // The HAVING lands on groups, so the totals come off the same grouped
        // set rather than from counting loans again.
        const { rows: agg } = await pool.query(
            `SELECT count(*)::int AS "titles",
                    COALESCE(sum("copies"), 0)::int  AS "copies",
                    COALESCE(sum("value"), 0)::float AS "value",
                    count(*) FILTER (WHERE "lastLoan" IS NULL)::int AS "never"
               FROM (
                 SELECT b."totalCopies" AS "copies", cv."value" AS "value", max(i."issueDate") AS "lastLoan"
                    ${FROM}
                 ${GROUP} ${HAVING}
               ) q`,
            values,
        );
        const a = agg[0] || {};

        deliver(req, res, report, {
            rows: rows.map((r) => ({
                ...clean(r),
                isbn: text(r.isbn), category: text(r.category),
                copies: num(r.copies), value: money(r.value),
                loansEver: num(r.loansEver), lastLoan: day(r.lastLoan),
            })),
            total: num(a.titles), page, limit,
            summary: [
                stat('Titles not moving', num(a.titles), 'num', `No loan since ${day(since)}`),
                stat('Never borrowed', num(a.never), 'num', 'Not once since it was catalogued'),
                stat('Copies on the shelf', num(a.copies), 'num'),
                stat('Value tied up', money(a.value), 'money', 'What those copies cost'),
            ],
            extra: { since: day(since) },
        });
    } catch (e) { fail(res, e); }
};

// ── One member's history ─────────────────────────────────────────────────────
exports.memberHistory = async (req, res) => {
    try {
        const report = byKey('member');
        const userId = uuid(req.query.userId);
        if (!userId) return res.status(400).json({ success: false, message: 'Pick a member first' });

        const { page, limit, offset } = paging(req.query);
        const { from, to } = window_(req.query);

        const { rows: who } = await pool.query(
            `SELECT u."_id", u."name", u."role", u."email", u."profileImage", ${CLASS_LABEL} AS "class"
               FROM ${T.user} u ${BORROWER_JOIN('u')}
              WHERE u."_id" = $1::uuid AND u."school" = $2::uuid
              LIMIT 1`,
            [String(userId), String(req.schoolId)],
        );
        if (!who.length) return res.status(404).json({ success: false, message: 'Member not found in this school' });

        const values = [String(req.schoolId), String(userId), from, to];
        const w = conditions([
            'i."school" = $1',
            'i."issuedTo" = $2::uuid',
            '($3::timestamptz IS NULL OR i."issueDate" >= $3)',
            '($4::timestamptz IS NULL OR i."issueDate" <= $4)',
        ], values);
        if (req.query.status === 'out')       w.raw(`i."status" = ANY('{issued,overdue}'::text[])`);
        else if (req.query.status === 'late') w.raw(`i."status" = 'overdue'`);
        else w.add('i."status" = $?', ['issued', 'returned', 'lost'].includes(req.query.status) ? req.query.status : '');
        w.add('(b."title" ILIKE $? OR b."isbn" ILIKE $? OR c."uniqueCode" ILIKE $?)', req.query.q ? like(req.query.q) : '');

        const FROM = `
              FROM ${T.iss}  i
              JOIN ${T.book} b ON b."_id" = i."book"
              JOIN ${T.copy} c ON c."_id" = i."bookCopy"
              LEFT JOIN LATERAL (
                  SELECT COALESCE(sum(f."amount"), 0)::float AS "charged",
                         COALESCE(sum(${OUTSTANDING}), 0)::float AS "owed"
                    FROM ${T.fine} f WHERE f."issuance" = i."_id"
              ) fn ON true
             WHERE ${w.sql()}`;

        const rowLimit = wantsXlsx(req) ? EXPORT_CAP : limit;
        const { rows } = await pool.query(
            `SELECT i."_id",
                    b."title"      AS "book",
                    b."isbn"       AS "isbn",
                    c."uniqueCode" AS "copy",
                    i."issueDate"  AS "issued",
                    i."dueDate"    AS "due",
                    i."returnDate" AS "returned",
                    i."renewalCount" AS "renewals",
                    GREATEST(0, COALESCE(i."returnDate", now())::date - i."dueDate"::date)::int AS "daysLate",
                    fn."charged"   AS "fine",
                    i."status"     AS "status",
                    (count(*) OVER ())::int AS "_total"
                    ${FROM}
             ORDER BY i."issueDate" DESC
             LIMIT ${rowLimit} ${wantsXlsx(req) ? '' : `OFFSET ${offset}`}`,
            values,
        );

        const { rows: agg } = await pool.query(
            `SELECT count(*)::int AS "loans",
                    count(*) FILTER (WHERE i."status" = ANY('{issued,overdue}'::text[]))::int AS "out",
                    count(*) FILTER (WHERE i."status" = 'overdue')::int AS "late",
                    COALESCE(sum(fn."charged"), 0)::float AS "charged",
                    COALESCE(sum(fn."owed"), 0)::float    AS "owed"
                    ${FROM}`,
            values,
        );
        const a = agg[0] || {};
        const member = who[0];

        deliver(req, res, report, {
            rows: rows.map((r) => ({
                ...clean(r),
                isbn: text(r.isbn),
                issued: day(r.issued), due: day(r.due), returned: day(r.returned),
                renewals: num(r.renewals), daysLate: num(r.daysLate), fine: money(r.fine),
            })),
            total: num(a.loans), page, limit,
            summary: [
                stat('Loans on record', num(a.loans), 'num'),
                stat('Still out', num(a.out), 'num', `${num(a.late)} of them overdue`),
                stat('Fines charged', money(a.charged), 'money'),
                stat('Still owed', money(a.owed), 'money', 'Unpaid, after any waiver'),
            ],
            extra: {
                member: {
                    _id: member._id, name: member.name, role: member.role,
                    email: member.email, photo: member.profileImage || '', class: text(member.class),
                },
            },
        });
    } catch (e) { fail(res, e); }
};

// ── Accession register ───────────────────────────────────────────────────────
// The standing record of what the library owns and what it was paid for, in
// accession-number order. This is the report an auditor asks for by name.
exports.accessionRegister = async (req, res) => {
    try {
        const report = byKey('accession');
        const { page, limit, offset } = paging(req.query);
        const { from, to } = window_(req.query);

        const values = [String(req.schoolId), from, to];
        const w = conditions([
            'c."school" = $1',
            '($2::timestamptz IS NULL OR c."acquisitionDate" >= $2)',
            '($3::timestamptz IS NULL OR c."acquisitionDate" <= $3)',
        ], values);
        if (req.query.status === 'written_off') w.raw('c."writtenOffAt" IS NOT NULL');
        else w.add('c."status" = $?', ['available', 'processing', 'issued', 'reserved', 'lost', 'damaged'].includes(req.query.status) ? req.query.status : '');
        w.add('c."vendor" = $?', req.query.vendor);
        w.add(
            '(b."title" ILIKE $? OR b."isbn" ILIKE $? OR c."uniqueCode" ILIKE $? OR c."billNumber" ILIKE $?)',
            req.query.q ? like(req.query.q) : '',
        );

        const FROM = `
              FROM ${T.copy} c
              JOIN ${T.book} b ON b."_id" = c."book"
             WHERE ${w.sql()}`;

        const rowLimit = wantsXlsx(req) ? EXPORT_CAP : limit;
        const { rows } = await pool.query(
            `SELECT c."_id",
                    c."uniqueCode"      AS "accession",
                    b."title"           AS "book",
                    b."isbn"            AS "isbn",
                    b."publisher"       AS "publisher",
                    c."acquisitionDate" AS "acquired",
                    c."vendor"          AS "vendor",
                    c."billNumber"      AS "bill",
                    c."cost"            AS "cost",
                    c."status"          AS "status",
                    c."condition"       AS "condition",
                    c."rackLocation"    AS "rack",
                    c."writtenOffAt"    AS "writtenOff",
                    (count(*) OVER ())::int AS "_total"
                    ${FROM}
             ORDER BY c."uniqueCode" ASC
             LIMIT ${rowLimit} ${wantsXlsx(req) ? '' : `OFFSET ${offset}`}`,
            values,
        );

        const { rows: agg } = await pool.query(
            `SELECT count(*)::int AS "copies",
                    COALESCE(sum(c."cost"), 0)::float AS "value",
                    count(*) FILTER (WHERE c."writtenOffAt" IS NOT NULL)::int AS "written",
                    count(*) FILTER (WHERE c."status" = 'lost')::int AS "lost"
                    ${FROM}`,
            values,
        );
        const a = agg[0] || {};

        deliver(req, res, report, {
            rows: rows.map((r) => ({
                ...clean(r),
                isbn: text(r.isbn), publisher: text(r.publisher), vendor: text(r.vendor),
                bill: text(r.bill), rack: text(r.rack), cost: money(r.cost),
                acquired: day(r.acquired), writtenOff: day(r.writtenOff),
            })),
            total: num(a.copies), page, limit,
            summary: [
                stat('Copies on the register', num(a.copies), 'num'),
                stat('Value acquired', money(a.value), 'money', 'What these copies cost'),
                stat('Reported lost', num(a.lost), 'num'),
                stat('Written off', num(a.written), 'num', 'Off the register'),
            ],
        });
    } catch (e) { fail(res, e); }
};

// ── Stock take ───────────────────────────────────────────────────────────────
// Where every copy should be, so a physical count can be reconciled against it.
// Anything not 'available' is expected to be off the shelf, and the row says
// where it went.
exports.stockTake = async (req, res) => {
    try {
        const report = byKey('stock');
        const { page, limit, offset } = paging(req.query);

        const values = [String(req.schoolId), ACTIVE_ISSUANCE];
        const w = conditions(['c."school" = $1'], values);
        if (req.query.rack === '_none') w.raw(`COALESCE(c."rackLocation", '') = ''`);
        else w.add('c."rackLocation" = $?', req.query.rack);
        w.add('c."status" = $?', ['available', 'processing', 'issued', 'reserved', 'lost', 'damaged'].includes(req.query.status) ? req.query.status : '');
        w.add(
            '(b."title" ILIKE $? OR b."isbn" ILIKE $? OR c."uniqueCode" ILIKE $? OR u."name" ILIKE $?)',
            req.query.q ? like(req.query.q) : '',
        );

        const FROM = `
              FROM ${T.copy} c
              JOIN ${T.book} b ON b."_id" = c."book"
              LEFT JOIN ${T.iss}  i ON i."bookCopy" = c."_id" AND i."status" = ANY($2::text[])
              LEFT JOIN ${T.user} u ON u."_id" = i."issuedTo"
             WHERE ${w.sql()}`;

        const rowLimit = wantsXlsx(req) ? EXPORT_CAP : limit;
        const { rows } = await pool.query(
            `SELECT c."_id",
                    COALESCE(NULLIF(c."rackLocation", ''), '(unshelved)') AS "rack",
                    c."uniqueCode" AS "copy",
                    b."title"      AS "book",
                    b."isbn"       AS "isbn",
                    c."status"     AS "status",
                    c."condition"  AS "condition",
                    CASE WHEN c."status" = 'available' THEN 'On the shelf' ELSE 'Off the shelf' END AS "expected",
                    u."name"       AS "heldBy",
                    i."dueDate"    AS "due",
                    (count(*) OVER ())::int AS "_total"
                    ${FROM}
             ORDER BY c."rackLocation" ASC NULLS LAST, c."uniqueCode" ASC
             LIMIT ${rowLimit} ${wantsXlsx(req) ? '' : `OFFSET ${offset}`}`,
            values,
        );

        const { rows: agg } = await pool.query(
            `SELECT count(*)::int AS "copies",
                    count(*) FILTER (WHERE c."status" = 'available')::int AS "shelf",
                    count(*) FILTER (WHERE c."status" = 'issued')::int    AS "out",
                    count(*) FILTER (WHERE c."status" IN ('lost', 'damaged'))::int AS "gone"
                    ${FROM}`,
            values,
        );
        const a = agg[0] || {};

        deliver(req, res, report, {
            rows: rows.map((r) => ({
                ...clean(r),
                isbn: text(r.isbn), heldBy: text(r.heldBy), due: day(r.due),
            })),
            total: num(a.copies), page, limit,
            summary: [
                stat('Copies to account for', num(a.copies), 'num'),
                stat('Expected on the shelf', num(a.shelf), 'num', 'Count these'),
                stat('Out on loan', num(a.out), 'num', 'Expected to be missing'),
                stat('Lost or damaged', num(a.gone), 'num', 'Off the shelf for good'),
            ],
        });
    } catch (e) { fail(res, e); }
};

// ── Fine ledger ──────────────────────────────────────────────────────────────
exports.fineLedger = async (req, res) => {
    try {
        const report = byKey('fines');
        const { page, limit, offset } = paging(req.query);
        const { from, to } = window_(req.query);

        const values = [String(req.schoolId), from, to];
        const w = conditions([
            'f."school" = $1',
            '($2::timestamptz IS NULL OR f."createdAt" >= $2)',
            '($3::timestamptz IS NULL OR f."createdAt" <= $3)',
        ], values);
        w.add('f."status" = $?', ['pending', 'paid', 'waived'].includes(req.query.status) ? req.query.status : '');
        w.add('f."fineType" = $?', ['late_return', 'lost', 'damaged'].includes(req.query.fineType) ? req.query.fineType : '');
        w.add('u."role" = $?', BORROWER_ROLES.includes(req.query.role) ? req.query.role : '');
        w.add('sp."currentClass" = $?::uuid', uuid(req.query.classId));
        w.add('sp."currentSection" = $?::uuid', uuid(req.query.sectionId));
        w.add(
            '(u."name" ILIKE $? OR f."receiptNumber" ILIKE $? OR b."title" ILIKE $?)',
            req.query.q ? like(req.query.q) : '',
        );

        const FROM = `
              FROM ${T.fine} f
              JOIN ${T.user} u ON u."_id" = f."user"
              LEFT JOIN ${T.iss}  i ON i."_id" = f."issuance"
              LEFT JOIN ${T.book} b ON b."_id" = i."book"
              ${BORROWER_JOIN('u')}
             WHERE ${w.sql()}`;

        const rowLimit = wantsXlsx(req) ? EXPORT_CAP : limit;
        const { rows } = await pool.query(
            `SELECT f."_id",
                    u."name"       AS "member",
                    u."role"       AS "role",
                    ${CLASS_LABEL} AS "class",
                    b."title"      AS "book",
                    f."fineType"   AS "type",
                    f."amount"     AS "charged",
                    COALESCE(f."waivedAmount", 0) AS "waived",
                    COALESCE(f."paidAmount", 0)   AS "collected",
                    ${OUTSTANDING} AS "outstanding",
                    f."status"     AS "status",
                    f."daysOverdue" AS "daysLate",
                    f."createdAt"  AS "raised",
                    f."paidAt"     AS "paid",
                    f."receiptNumber" AS "receipt",
                    f."waiverReason"  AS "reason",
                    (count(*) OVER ())::int AS "_total"
                    ${FROM}
             ORDER BY f."createdAt" DESC
             LIMIT ${rowLimit} ${wantsXlsx(req) ? '' : `OFFSET ${offset}`}`,
            values,
        );

        // Summed from the arithmetic, so a part-waived fine reports both halves.
        const { rows: agg } = await pool.query(
            `SELECT count(*)::int AS "fines",
                    COALESCE(sum(f."amount"), 0)::float AS "charged",
                    COALESCE(sum(COALESCE(f."paidAmount", 0)), 0)::float   AS "collected",
                    COALESCE(sum(COALESCE(f."waivedAmount", 0)), 0)::float AS "waived",
                    COALESCE(sum(${OUTSTANDING}), 0)::float AS "outstanding"
                    ${FROM}`,
            values,
        );
        const a = agg[0] || {};

        deliver(req, res, report, {
            rows: rows.map((r) => ({
                ...clean(r),
                class: text(r.class), book: text(r.book), receipt: text(r.receipt), reason: text(r.reason),
                charged: money(r.charged), waived: money(r.waived),
                collected: money(r.collected), outstanding: money(r.outstanding),
                daysLate: num(r.daysLate), raised: day(r.raised), paid: day(r.paid),
            })),
            total: num(a.fines), page, limit,
            summary: [
                stat('Fines raised', num(a.fines), 'num'),
                stat('Charged', money(a.charged), 'money'),
                stat('Collected', money(a.collected), 'money', 'Cash and online'),
                stat('Waived', money(a.waived), 'money'),
                stat('Still outstanding', money(a.outstanding), 'money'),
            ],
        });
    } catch (e) { fail(res, e); }
};

// ── Usage statistics ─────────────────────────────────────────────────────────
//
//  The library term by term rather than book by book: how many loans went out,
//  how many came back, how many people used it, and what the fines did.
//
//  Loans, returns and fines are dated by three different columns, so they are
//  poured into one stream of events first and grouped once. Counting them in
//  three separate queries and stitching the periods together in Node is the
//  same thing done less reliably — a period with returns but no loans falls out
//  of the join and the month silently disappears.
exports.usageStatistics = async (req, res) => {
    try {
        const report = byKey('usage');
        const { page, limit, offset } = paging(req.query);
        const { from, to } = window_(req.query);
        const grain = req.query.grain === 'week' ? 'week' : 'month';
        const role  = BORROWER_ROLES.includes(req.query.role) ? req.query.role : null;

        // Twelve periods back by default, so the page opens on a real series
        // instead of everything the library has ever done.
        const start = from || new Date(Date.now() - (grain === 'week' ? 12 * 7 : 365) * 86400000);
        const end   = to   || new Date();
        const values = [String(req.schoolId), start, end, grain, role];

        const EVENTS = `
            WITH ev AS (
                SELECT date_trunc($4, i."issueDate" AT TIME ZONE 'UTC') AS "p",
                       1 AS "loan", 0 AS "ret", i."issuedTo" AS "who",
                       0::float AS "charged", 0::float AS "collected"
                  FROM ${T.iss} i JOIN ${T.user} u ON u."_id" = i."issuedTo"
                 WHERE i."school" = $1 AND i."issueDate" BETWEEN $2 AND $3
                   AND ($5::text IS NULL OR u."role" = $5)
                UNION ALL
                SELECT date_trunc($4, i."returnDate" AT TIME ZONE 'UTC'), 0, 1, NULL,
                       0::float, 0::float
                  FROM ${T.iss} i JOIN ${T.user} u ON u."_id" = i."issuedTo"
                 WHERE i."school" = $1 AND i."returnDate" IS NOT NULL
                   AND i."returnDate" BETWEEN $2 AND $3
                   AND ($5::text IS NULL OR u."role" = $5)
                UNION ALL
                SELECT date_trunc($4, f."createdAt" AT TIME ZONE 'UTC'), 0, 0, NULL,
                       f."amount"::float, 0::float
                  FROM ${T.fine} f JOIN ${T.user} u ON u."_id" = f."user"
                 WHERE f."school" = $1 AND f."createdAt" BETWEEN $2 AND $3
                   AND ($5::text IS NULL OR u."role" = $5)
                UNION ALL
                SELECT date_trunc($4, f."paidAt" AT TIME ZONE 'UTC'), 0, 0, NULL,
                       0::float, COALESCE(f."paidAmount", 0)::float
                  FROM ${T.fine} f JOIN ${T.user} u ON u."_id" = f."user"
                 WHERE f."school" = $1 AND f."paidAt" IS NOT NULL
                   AND f."paidAt" BETWEEN $2 AND $3
                   AND ($5::text IS NULL OR u."role" = $5)
            )`;

        const rowLimit = wantsXlsx(req) ? EXPORT_CAP : limit;
        const { rows } = await pool.query(
            `${EVENTS}
             SELECT to_char("p", 'YYYY-MM-DD') AS "at",
                    sum("loan")::int AS "loans",
                    sum("ret")::int  AS "returns",
                    count(DISTINCT "who")::int AS "readers",
                    sum("charged")::float   AS "charged",
                    sum("collected")::float AS "collected",
                    (count(*) OVER ())::int AS "_total"
               FROM ev
              GROUP BY "p"
              ORDER BY "p" DESC
              LIMIT ${rowLimit} ${wantsXlsx(req) ? '' : `OFFSET ${offset}`}`,
            values,
        );

        const { rows: agg } = await pool.query(
            `${EVENTS}
             SELECT count(DISTINCT "p")::int AS "periods",
                    sum("loan")::int AS "loans",
                    sum("ret")::int  AS "returns",
                    count(DISTINCT "who")::int AS "readers",
                    sum("collected")::float AS "collected"
               FROM ev`,
            values,
        );
        const a = agg[0] || {};

        // The periods are cut in UTC and come back as `YYYY-MM-DD` text, never
        // as a timestamp — the whole module dates things in UTC, and a month
        // boundary re-read in the server's local zone lands in the month before
        // it. That is how "Aug 2026" reported itself as July.
        const label = (at) => {
            const d = new Date(`${at}T00:00:00Z`);
            return grain === 'week'
                ? `Week of ${d.toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short' })}`
                : d.toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'short', year: 'numeric' });
        };

        deliver(req, res, report, {
            rows: rows.map((r) => ({
                _id: r.at,
                period: label(r.at),
                starting: r.at,
                loans: num(r.loans),
                returns: num(r.returns),
                readers: num(r.readers),
                charged: money(r.charged),
                collected: money(r.collected),
            })),
            total: num(a.periods), page, limit,
            summary: [
                stat('Loans', num(a.loans), 'num', 'Books issued in this window'),
                stat('Returns', num(a.returns), 'num'),
                stat('Members who borrowed', num(a.readers), 'num'),
                stat('Fines collected', money(a.collected), 'money'),
            ],
            extra: { from: day(start), to: day(end), grain },
        });
    } catch (e) { fail(res, e); }
};

// ── Chasing the overdue list ─────────────────────────────────────────────────
//
//  The register's whole point is the next action, and until now that action
//  lived outside the software: the librarian read the list and went looking for
//  people. This sends the one message the list implies, to the borrower and —
//  for a student — to their parents, exactly the audience the automatic overdue
//  notice goes to.
exports.remindOverdue = async (req, res) => {
    try {
        const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(uuid).filter(Boolean))].slice(0, 200);
        if (!ids.length) return res.status(400).json({ success: false, message: 'Pick at least one overdue loan first' });

        const loans = await LibraryIssuance.find({
            _id: { $in: ids }, school: req.schoolId, status: { $in: ACTIVE_ISSUANCE },
        }).populate('book', 'title').lean();

        const now = Date.now();
        let sent = 0;
        const skipped = [];

        for (const loan of loans) {
            // A loan that came back, or was renewed past its due date between
            // the page loading and the button being pressed, is not overdue any
            // more — telling its borrower otherwise is worse than saying nothing.
            if (!loan.dueDate || new Date(loan.dueDate).getTime() >= now) {
                skipped.push({ title: loan.book?.title || 'A book', reason: 'no longer overdue' });
                continue;
            }
            const days = Math.max(1, Math.ceil((now - new Date(loan.dueDate).getTime()) / 86400000));
            notify({
                school: req.schoolId,
                sender: req.user._id,
                senderRole: req.user.role,
                title: '📕 Please return your library book',
                body: `"${loan.book?.title || 'A library book'}" was due on ${fmtLibDate(loan.dueDate)}`
                    + ` and is ${days} day${days === 1 ? '' : 's'} overdue. Please return it at the library counter.`,
                recipients: await borrowerAudience(loan),
                link: { type: 'library.mybooks', entityId: loan._id },
            });
            audit(req.schoolId, req.user._id, req.user.role, 'OVERDUE_REMINDER_SENT', 'Issuance', loan._id, null, {
                dueDate: loan.dueDate, daysLate: days,
            });
            sent += 1;
        }

        const missing = ids.length - loans.length;
        if (missing > 0) skipped.push({ title: `${missing} loan${missing === 1 ? '' : 's'}`, reason: 'already closed' });

        res.json({ success: true, sent, skipped });
    } catch (e) { fail(res, e); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  The registry
// ═════════════════════════════════════════════════════════════════════════════

// The controls a report takes. `source` names a list the index endpoint sends
// alongside (classes, categories, racks, vendors) rather than one hardcoded in
// the client, where it would drift from the data the moment a shelf is renamed.
const F = {
    // `preset` is the window the report opens on. A report is asked over a
    // period that suits it — a month of fines, a year of accessions — and the
    // client should not have to carry a table of which is which.
    range:     (preset = 'last90') => ({ key: 'range', type: 'daterange', label: 'Period', preset }),
    since:     { key: 'since',    type: 'date',      label: 'Not borrowed since', preset: 'year' },
    member:    { key: 'userId',   type: 'member',    label: 'Member', required: true },
    search:    (placeholder) => ({ key: 'q', type: 'search', label: 'Search', placeholder }),
    class:     { key: 'classId',  type: 'select', label: 'Class',       all: 'All classes',   source: 'classes' },
    category:  { key: 'category', type: 'select', label: 'Category',    all: 'All categories', source: 'categories' },
    rack:      { key: 'rack',     type: 'select', label: 'Rack',        all: 'All racks',      source: 'racks' },
    vendor:    { key: 'vendor',   type: 'select', label: 'Vendor',      all: 'All vendors',    source: 'vendors' },
    role: {
        key: 'role', type: 'select', label: 'Member type', all: 'All member types',
        options: [{ value: 'student', label: 'Students' }, { value: 'teacher', label: 'Teachers' }],
    },
    lateness: {
        key: 'lateness', type: 'select', label: 'How late', all: 'Any lateness',
        options: [
            { value: 'week',  label: '1–7 days late' },
            { value: 'month', label: '8–30 days late' },
            { value: 'long',  label: 'Over 30 days late' },
        ],
    },
    copyStatus: {
        key: 'status', type: 'select', label: 'Status', all: 'All statuses',
        options: [
            { value: 'available',  label: 'Available' },
            { value: 'issued',     label: 'Issued out' },
            { value: 'processing', label: 'Being processed' },
            { value: 'reserved',  label: 'Reserved' },
            { value: 'lost',      label: 'Lost' },
            { value: 'damaged',   label: 'Damaged' },
        ],
    },
    // The accession register is the one place a written-off copy is still a
    // row, so it is the one place that can be asked for.
    accessionStatus: {
        key: 'status', type: 'select', label: 'Status', all: 'All statuses',
        options: [
            { value: 'available',   label: 'Available' },
            { value: 'issued',      label: 'Issued out' },
            { value: 'processing',  label: 'Being processed' },
            { value: 'reserved',    label: 'Reserved' },
            { value: 'lost',        label: 'Lost' },
            { value: 'damaged',     label: 'Damaged' },
            { value: 'written_off', label: 'Written off' },
        ],
    },
    loanStatus: {
        key: 'status', type: 'select', label: 'Status', all: 'All statuses',
        options: [
            { value: 'out',      label: 'Still out' },
            { value: 'late',     label: 'Overdue' },
            { value: 'returned', label: 'Returned' },
            { value: 'lost',     label: 'Lost' },
        ],
    },
    fineStatus: {
        key: 'status', type: 'select', label: 'Status', all: 'All statuses',
        options: [
            { value: 'pending', label: 'Unpaid' },
            { value: 'paid',    label: 'Paid' },
            { value: 'waived',  label: 'Waived' },
        ],
    },
    fineType: {
        key: 'fineType', type: 'select', label: 'Reason', all: 'All reasons',
        options: [
            { value: 'late_return', label: 'Late return' },
            { value: 'lost',        label: 'Lost book' },
            { value: 'damaged',     label: 'Damaged book' },
        ],
    },
    grain: {
        key: 'grain', type: 'select', label: 'Grouped by', all: '', defaultValue: 'month',
        options: [{ value: 'month', label: 'By month' }, { value: 'week', label: 'By week' }],
    },
};

const REPORTS = [
    {
        key: 'overdue',
        name: 'Overdue Register',
        blurb: 'Books that are not yet returned and are past their due date.',
        icon: 'clock', tone: 'pink', path: '/library/reports/overdue',
        // The only report with something to do to a row, so the only one the
        // page draws a selection column and an action for.
        action: 'remind',
        filters: [F.class, F.role, F.lateness, F.search('Search by member or book…')],
        columns: [
            col('member', 'Member', 'person', { sub: 'class' }),
            col('class',  'Class',  'text',   { inline: true }),
            col('role',   'Role',   'role'),
            col('book',   'Book',   'title',  { sub: 'isbn' }),
            col('isbn',   'ISBN',   'text',   { inline: true }),
            col('copy',   'Copy',   'code'),
            col('issued', 'Issued on', 'date'),
            col('due',    'Due date',  'date'),
            col('daysLate', 'Days late', 'days', { align: 'right' }),
            col('fine',   'Fine',   'money',  { align: 'right' }),
            col('status', 'Status', 'status'),
        ],
    },
    {
        key: 'popular',
        name: 'Most Borrowed',
        blurb: 'The titles doing the work — and how hard each copy is working.',
        icon: 'trending', tone: 'indigo', path: '/library/reports/popular',
        filters: [F.range('last90'), F.category, F.role, F.search('Search by title, author or ISBN…')],
        columns: [
            col('book',    'Book',      'title', { sub: 'isbn' }),
            col('isbn',    'ISBN',      'text',  { inline: true }),
            col('authors', 'Author(s)', 'text'),
            col('category','Category',  'chip',  { empty: 'Uncategorised' }),
            col('loans',   'Loans',     'num',   { align: 'right' }),
            col('readers', 'Members',   'num',   { align: 'right' }),
            col('copies',  'Copies',    'num',   { align: 'right' }),
            col('perCopy', 'Loans per copy', 'num', { align: 'right', decimals: 2 }),
            col('lastLoan','Last borrowed', 'date'),
        ],
    },
    {
        key: 'dead',
        name: 'Dead Stock',
        blurb: 'Shelf space earning nothing — titles with no loan since the date you set.',
        icon: 'package', tone: 'amber', path: '/library/reports/dead-stock',
        filters: [F.since, F.category, F.search('Search by title, author or ISBN…')],
        columns: [
            col('book',     'Book',     'title', { sub: 'isbn' }),
            col('isbn',     'ISBN',     'text',  { inline: true }),
            col('category', 'Category', 'chip',  { empty: 'Uncategorised' }),
            col('copies',   'Copies',   'num',   { align: 'right' }),
            col('value',    'Value',    'money', { align: 'right' }),
            col('loansEver','Loans ever','num',  { align: 'right' }),
            col('lastLoan', 'Last borrowed', 'date', { empty: 'Never' }),
        ],
    },
    {
        key: 'member',
        name: 'Member History',
        blurb: 'Everything one member has borrowed, returned and been charged.',
        icon: 'user', tone: 'blue', path: '/library/reports/member',
        filters: [F.member, F.range('all'), F.loanStatus, F.search('Search by book or copy code…')],
        columns: [
            col('book',   'Book', 'title', { sub: 'isbn' }),
            col('isbn',   'ISBN', 'text',  { inline: true }),
            col('copy',   'Copy', 'code'),
            col('issued', 'Issued on', 'date'),
            col('due',    'Due date',  'date'),
            col('returned','Returned', 'date', { empty: 'Still out' }),
            col('renewals','Renewals', 'num',  { align: 'right' }),
            col('daysLate','Days late','days', { align: 'right' }),
            col('fine',   'Fine',      'money',{ align: 'right' }),
            col('status', 'Status',    'status'),
        ],
    },
    {
        key: 'accession',
        name: 'Accession Register',
        blurb: 'What the library owns and what it was paid for, in accession order.',
        icon: 'fileCheck', tone: 'teal', path: '/library/reports/accession',
        filters: [F.range('last365'), F.accessionStatus, F.vendor, F.search('Search by title, accession or bill no…')],
        columns: [
            col('accession','Accession no', 'code'),
            col('book',     'Book',      'title', { sub: 'isbn' }),
            col('isbn',     'ISBN',      'text',  { inline: true }),
            col('publisher','Publisher', 'text'),
            col('acquired', 'Acquired',  'date'),
            col('vendor',   'Vendor',    'text'),
            col('bill',     'Bill no',   'text'),
            col('cost',     'Cost',      'money', { align: 'right' }),
            col('status',   'Status',    'status'),
            col('condition','Condition', 'chip'),
            col('rack',     'Rack',      'text'),
            col('writtenOff','Written off','date', { empty: 'In use' }),
        ],
    },
    {
        key: 'stock',
        name: 'Stock Take',
        blurb: 'Where every copy should be, to count the shelves against.',
        icon: 'layers', tone: 'purple', path: '/library/reports/stock-take',
        filters: [F.rack, F.copyStatus, F.search('Search by title, copy code or member…')],
        columns: [
            col('rack',    'Rack',   'text'),
            col('copy',    'Copy code', 'code'),
            col('book',    'Book',   'title', { sub: 'isbn' }),
            col('isbn',    'ISBN',   'text',  { inline: true }),
            col('status',  'Status', 'status'),
            col('condition','Condition','chip'),
            col('expected','Expected', 'text'),
            col('heldBy',  'Held by', 'person', { empty: '—' }),
            col('due',     'Due back','date',   { empty: '—' }),
        ],
    },
    {
        key: 'fines',
        name: 'Fine Ledger',
        blurb: 'Every fine raised, what was collected, waived and still owed.',
        icon: 'banknote', tone: 'green', path: '/library/reports/fines',
        filters: [F.range('last90'), F.class, F.role, F.fineStatus, F.fineType, F.search('Search by member, book or receipt…')],
        columns: [
            col('member', 'Member', 'person', { sub: 'class' }),
            col('class',  'Class',  'text',   { inline: true }),
            col('role',   'Role',   'role'),
            col('book',   'Book',   'text',   { empty: '—' }),
            col('type',   'Reason', 'chip'),
            col('charged','Charged','money',  { align: 'right' }),
            col('waived', 'Waived', 'money',  { align: 'right' }),
            col('collected','Collected','money', { align: 'right' }),
            col('outstanding','Outstanding','money', { align: 'right' }),
            col('status', 'Status', 'status'),
            col('daysLate','Days late','days',{ align: 'right' }),
            col('raised', 'Raised', 'date'),
            col('paid',   'Paid',   'date', { empty: '—' }),
            col('receipt','Receipt','code',  { inline: true }),
            col('reason', 'Waiver reason', 'text', { inline: true }),
        ],
    },
    {
        key: 'usage',
        name: 'Usage Statistics',
        blurb: 'The library period by period — loans, returns, readers and fines.',
        icon: 'chart', tone: 'indigo', path: '/library/reports/usage',
        filters: [F.range('last365'), F.grain, F.role],
        columns: [
            col('period',   'Period',  'text'),
            col('loans',    'Loans',   'num', { align: 'right' }),
            col('returns',  'Returns', 'num', { align: 'right' }),
            col('readers',  'Members', 'num', { align: 'right' }),
            col('charged',  'Fines charged',  'money', { align: 'right' }),
            col('collected','Fines collected','money', { align: 'right' }),
        ],
    },
];

const byKey = (key) => REPORTS.find((r) => r.key === key);

// ── Index ────────────────────────────────────────────────────────────────────
//
//  Everything the reports screen needs to draw itself: the reports, the figures
//  above them, and the option lists their filters offer.
exports.index = async (req, res) => {
    try {
        const [stats, options] = await Promise.all([headline(req.schoolId), filterOptions(req.schoolId)]);
        res.json({ success: true, data: REPORTS, stats, options });
    } catch (e) { fail(res, e); }
};

/**
 * The four figures across the top, each against the month before it.
 *
 * "Books issued" is a live count — what is out of the building right now — with
 * the month's lending underneath it; the other three are activity inside the
 * window. Everything is one round trip.
 */
const PERIOD_DAYS = 30;
async function headline(schoolId) {
    const now  = Date.now();
    const from = new Date(now - PERIOD_DAYS * 86400000);
    const prev = new Date(now - 2 * PERIOD_DAYS * 86400000);

    const { rows } = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM ${T.book} WHERE "school" = $1)                       AS "books",
           (SELECT count(*)::int FROM ${T.book} WHERE "school" = $1 AND "createdAt" >= $2) AS "booksNew",
           (SELECT count(*)::int FROM ${T.book} WHERE "school" = $1
              AND "createdAt" >= $3 AND "createdAt" < $2)                                  AS "booksPrev",
           (SELECT count(*)::int FROM ${T.iss}  WHERE "school" = $1
              AND "status" = ANY($4::text[]))                                              AS "out",
           (SELECT count(*)::int FROM ${T.iss}  WHERE "school" = $1 AND "issueDate" >= $2) AS "loans",
           (SELECT count(*)::int FROM ${T.iss}  WHERE "school" = $1
              AND "issueDate" >= $3 AND "issueDate" < $2)                                  AS "loansPrev",
           (SELECT count(DISTINCT "issuedTo")::int FROM ${T.iss} WHERE "school" = $1
              AND "issueDate" >= $2)                                                       AS "readers",
           (SELECT count(DISTINCT "issuedTo")::int FROM ${T.iss} WHERE "school" = $1
              AND "issueDate" >= $3 AND "issueDate" < $2)                                  AS "readersPrev",
           (SELECT COALESCE(sum("paidAmount"), 0)::float FROM ${T.fine} WHERE "school" = $1
              AND "paidAt" >= $2)                                                          AS "collected",
           (SELECT COALESCE(sum("paidAmount"), 0)::float FROM ${T.fine} WHERE "school" = $1
              AND "paidAt" >= $3 AND "paidAt" < $2)                                        AS "collectedPrev",
           (SELECT count(*)::int FROM ${T.iss} WHERE "school" = $1
              AND "status" = ANY($4::text[]) AND "dueDate" < now())                        AS "overdue"`,
        [String(schoolId), from, prev, ACTIVE_ISSUANCE],
    );
    const r = rows[0] || {};
    return {
        periodDays: PERIOD_DAYS,
        books: num(r.books), booksNew: num(r.booksNew), booksPrev: num(r.booksPrev),
        out: num(r.out), loans: num(r.loans), loansPrev: num(r.loansPrev),
        readers: num(r.readers), readersPrev: num(r.readersPrev),
        collected: money(r.collected), collectedPrev: money(r.collectedPrev),
        overdue: num(r.overdue),
    };
}

/**
 * The lists behind the filter dropdowns, read from the data rather than
 * hardcoded: a category exists because a book is in it, a rack because a copy
 * sits on it. Every one is a small DISTINCT over an indexed, school-scoped set.
 */
async function filterOptions(schoolId) {
    const id = String(schoolId);
    const [classes, categories, racks, vendors] = await Promise.all([
        pool.query(
            `SELECT c."_id", c."className", c."classNumber"
               FROM ${T.cls} c WHERE c."school" = $1
              ORDER BY c."classNumber" ASC NULLS LAST, c."className" ASC`, [id]),
        pool.query(
            `SELECT DISTINCT "category" AS v FROM ${T.book}
              WHERE "school" = $1 AND COALESCE("category", '') <> '' ORDER BY 1`, [id]),
        pool.query(
            `SELECT DISTINCT "rackLocation" AS v FROM ${T.copy}
              WHERE "school" = $1 AND COALESCE("rackLocation", '') <> '' ORDER BY 1`, [id]),
        pool.query(
            `SELECT DISTINCT "vendor" AS v FROM ${T.copy}
              WHERE "school" = $1 AND COALESCE("vendor", '') <> '' ORDER BY 1`, [id]),
    ]);

    // Classes repeat across academic years, and a filter offering "Class VIII"
    // three times is three ways to ask the same question. Keep the first.
    const seen = new Set();
    return {
        classes: classes.rows
            .filter((c) => !seen.has(c.className) && seen.add(c.className))
            .map((c) => ({ value: String(c._id), label: c.className })),
        categories: categories.rows.map((r) => ({ value: r.v, label: r.v })),
        racks: [
            ...racks.rows.map((r) => ({ value: r.v, label: r.v })),
            { value: '_none', label: '(unshelved)' },
        ],
        vendors: vendors.rows.map((r) => ({ value: r.v, label: r.v })),
    };
}
