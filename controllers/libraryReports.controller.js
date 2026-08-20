'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Library reporting.
//
//  The questions a librarian is actually asked each term: what is out and late,
//  what gets borrowed, what never moves, what one member has had, what the
//  collection is worth, and what the shelves should hold. Each is one grouped
//  SQL query rather than rows pulled into Node and counted there.
//
//  Every report answers on the same contract — `?format=xlsx` returns the same
//  rows as a spreadsheet, so nothing has to be re-derived for an export.
// ─────────────────────────────────────────────────────────────────────────────
const XLSX = require('xlsx');
const pool = require('../db/pool');

const LibraryBook     = require('../models/LibraryBook');
const LibraryBookCopy = require('../models/LibraryBookCopy');
const LibraryIssuance = require('../models/LibraryIssuance');
const LibraryFine     = require('../models/LibraryFine');
const User            = require('../models/User');
const { sweepOverdue, ACTIVE_ISSUANCE } = require('../services/libraryRules');

const T = {
    book: () => `"${LibraryBook.tableName}"`,
    copy: () => `"${LibraryBookCopy.tableName}"`,
    iss:  () => `"${LibraryIssuance.tableName}"`,
    fine: () => `"${LibraryFine.tableName}"`,
    user: () => `"${User.tableName}"`,
};

/** Clamps a caller-supplied row cap; a report is for reading, not for dumping. */
const cap = (v, dflt = 100, max = 1000) =>
    Math.min(max, Math.max(1, Math.floor(Number(v) || dflt)));

/** Optional inclusive date window from the query string. */
function window_(query) {
    const from = query.from ? new Date(query.from) : null;
    const to   = query.to   ? new Date(query.to)   : null;
    return {
        from: from && !Number.isNaN(from.getTime()) ? from : null,
        to:   to   && !Number.isNaN(to.getTime())   ? to   : null,
    };
}

/**
 * Sends `rows` as JSON, or as a spreadsheet when `?format=xlsx`. Column order
 * follows the first row, so the SELECT decides the sheet layout.
 */
function deliver(req, res, name, rows, extra = {}) {
    if (String(req.query.format || '').toLowerCase() !== 'xlsx') {
        return res.json({ success: true, data: rows, ...extra });
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="${name}_${stamp}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
}

const num = (v) => Number(v ?? 0);
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');

// ── Overdue register ─────────────────────────────────────────────────────────
// The list the librarian works from: who has what, how late, and what it owes.
exports.overdueRegister = async (req, res) => {
    try {
        await sweepOverdue(req.schoolId);
        const { rows } = await pool.query(
            `SELECT u."name"            AS "member",
                    u."role"            AS "role",
                    b."title"           AS "book",
                    c."uniqueCode"      AS "copy",
                    i."issueDate"       AS "issued",
                    i."dueDate"         AS "due",
                    GREATEST(0, (CURRENT_DATE - i."dueDate"::date))::int AS "daysLate"
               FROM ${T.iss()}  i
               JOIN ${T.user()} u ON u."_id" = i."issuedTo"
               JOIN ${T.book()} b ON b."_id" = i."book"
               JOIN ${T.copy()} c ON c."_id" = i."bookCopy"
              WHERE i."school" = $1 AND i."status" = ANY($2::text[]) AND i."dueDate" < now()
              ORDER BY i."dueDate" ASC
              LIMIT $3`,
            [String(req.schoolId), ACTIVE_ISSUANCE, cap(req.query.limit, 500)],
        );
        const data = rows.map(r => ({
            Member: r.member, Role: r.role, Book: r.book, Copy: r.copy,
            Issued: day(r.issued), Due: day(r.due), 'Days late': num(r.daysLate),
        }));
        deliver(req, res, 'overdue_register', data, { total: data.length });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Most borrowed ────────────────────────────────────────────────────────────
exports.mostBorrowed = async (req, res) => {
    try {
        const { from, to } = window_(req.query);
        const { rows } = await pool.query(
            `SELECT b."title", b."isbn", b."category",
                    count(i."_id")::int AS "loans",
                    b."totalCopies"     AS "copies"
               FROM ${T.book()} b
               JOIN ${T.iss()}  i ON i."book" = b."_id"
              WHERE b."school" = $1
                AND ($2::timestamptz IS NULL OR i."issueDate" >= $2)
                AND ($3::timestamptz IS NULL OR i."issueDate" <= $3)
              GROUP BY b."_id", b."title", b."isbn", b."category", b."totalCopies"
              ORDER BY count(i."_id") DESC, b."title" ASC
              LIMIT $4`,
            [String(req.schoolId), from, to, cap(req.query.limit, 50)],
        );
        const data = rows.map(r => ({
            Title: r.title, ISBN: r.isbn || '', Category: r.category || '',
            Loans: num(r.loans), Copies: num(r.copies),
            'Loans per copy': num(r.copies) ? +(num(r.loans) / num(r.copies)).toFixed(2) : num(r.loans),
        }));
        deliver(req, res, 'most_borrowed', data);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Dead stock ───────────────────────────────────────────────────────────────
// Books that have not moved since `?since` (default a year). What a librarian
// weeds, and what stops the next purchase repeating a mistake.
exports.deadStock = async (req, res) => {
    try {
        const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 365 * 86400000);
        const { rows } = await pool.query(
            `SELECT b."title", b."isbn", b."category", b."totalCopies" AS "copies",
                    max(i."issueDate") AS "lastLoan",
                    count(i."_id")::int AS "loansEver"
               FROM ${T.book()} b
               LEFT JOIN ${T.iss()} i ON i."book" = b."_id"
              WHERE b."school" = $1
              GROUP BY b."_id", b."title", b."isbn", b."category", b."totalCopies"
             HAVING max(i."issueDate") IS NULL OR max(i."issueDate") < $2
              ORDER BY max(i."issueDate") ASC NULLS FIRST, b."title" ASC
              LIMIT $3`,
            [String(req.schoolId), since, cap(req.query.limit, 200)],
        );
        const data = rows.map(r => ({
            Title: r.title, ISBN: r.isbn || '', Category: r.category || '',
            Copies: num(r.copies), 'Loans ever': num(r.loansEver),
            'Last borrowed': r.lastLoan ? day(r.lastLoan) : 'never',
        }));
        deliver(req, res, 'dead_stock', data, { since: day(since) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── One member's history ─────────────────────────────────────────────────────
exports.memberHistory = async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId) return res.status(400).json({ success: false, message: 'Pick a member first' });

        const member = await User.findOne({ _id: userId, school: req.schoolId }).select('name role email').lean();
        if (!member) return res.status(404).json({ success: false, message: 'Member not found in this school' });

        const [{ rows }, fines] = await Promise.all([
            pool.query(
                `SELECT b."title", c."uniqueCode" AS "copy", i."issueDate", i."dueDate",
                        i."returnDate", i."status", i."renewalCount"
                   FROM ${T.iss()}  i
                   JOIN ${T.book()} b ON b."_id" = i."book"
                   JOIN ${T.copy()} c ON c."_id" = i."bookCopy"
                  WHERE i."school" = $1 AND i."issuedTo" = $2
                  ORDER BY i."issueDate" DESC
                  LIMIT $3`,
                [String(req.schoolId), String(userId), cap(req.query.limit, 200)],
            ),
            LibraryFine.find({ school: req.schoolId, user: userId }).select('fineType amount status').lean(),
        ]);

        const data = rows.map(r => ({
            Book: r.title, Copy: r.copy, Issued: day(r.issueDate), Due: day(r.dueDate),
            Returned: r.returnDate ? day(r.returnDate) : '', Status: r.status, Renewals: num(r.renewalCount),
        }));
        deliver(req, res, `member_history`, data, {
            member,
            summary: {
                loans: data.length,
                outstanding: rows.filter(r => ACTIVE_ISSUANCE.includes(r.status)).length,
                finesPending: fines.filter(f => f.status === 'pending').reduce((s, f) => s + (f.amount || 0), 0),
                finesPaid:    fines.filter(f => f.status === 'paid').reduce((s, f) => s + (f.amount || 0), 0),
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Accession register ───────────────────────────────────────────────────────
// The standing record of what the library owns and what it was paid for, in
// accession-number order. This is the report an auditor asks for by name.
exports.accessionRegister = async (req, res) => {
    try {
        const { from, to } = window_(req.query);
        const { rows } = await pool.query(
            `SELECT c."uniqueCode", b."title", b."isbn", b."publisher",
                    c."acquisitionDate", c."vendor", c."billNumber", c."cost",
                    c."status", c."condition", c."rackLocation", c."writtenOffAt"
               FROM ${T.copy()} c
               JOIN ${T.book()} b ON b."_id" = c."book"
              WHERE c."school" = $1
                AND ($2::timestamptz IS NULL OR c."acquisitionDate" >= $2)
                AND ($3::timestamptz IS NULL OR c."acquisitionDate" <= $3)
              ORDER BY c."uniqueCode" ASC
              LIMIT $4`,
            [String(req.schoolId), from, to, cap(req.query.limit, 1000, 5000)],
        );
        const data = rows.map(r => ({
            'Accession no': r.uniqueCode, Title: r.title, ISBN: r.isbn || '',
            Publisher: r.publisher || '', Acquired: day(r.acquisitionDate),
            Vendor: r.vendor || '', 'Bill no': r.billNumber || '', Cost: num(r.cost),
            Status: r.status, Condition: r.condition, Rack: r.rackLocation || '',
            'Written off': r.writtenOffAt ? day(r.writtenOffAt) : '',
        }));
        deliver(req, res, 'accession_register', data, {
            total: data.length,
            value: data.reduce((s, r) => s + r.Cost, 0),
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Stock take ───────────────────────────────────────────────────────────────
// Where every copy should be, so a physical count can be reconciled against it.
// Anything not 'available' is expected to be off the shelf, and the report says
// where it went.
exports.stockTake = async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT c."uniqueCode", b."title", c."rackLocation", c."status",
                    u."name" AS "heldBy", i."dueDate"
               FROM ${T.copy()} c
               JOIN ${T.book()} b ON b."_id" = c."book"
               LEFT JOIN ${T.iss()}  i ON i."bookCopy" = c."_id" AND i."status" = ANY($2::text[])
               LEFT JOIN ${T.user()} u ON u."_id" = i."issuedTo"
              WHERE c."school" = $1
              ORDER BY c."rackLocation" ASC, c."uniqueCode" ASC
              LIMIT $3`,
            [String(req.schoolId), ACTIVE_ISSUANCE, cap(req.query.limit, 1000, 5000)],
        );
        const data = rows.map(r => ({
            Rack: r.rackLocation || '(unshelved)', 'Copy code': r.uniqueCode, Title: r.title,
            Status: r.status,
            'Expected on shelf': r.status === 'available' ? 'yes' : 'no',
            'Held by': r.heldBy || '', Due: r.dueDate ? day(r.dueDate) : '',
        }));
        deliver(req, res, 'stock_take', data, { total: data.length });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Fine ledger ──────────────────────────────────────────────────────────────
exports.fineLedger = async (req, res) => {
    try {
        const { from, to } = window_(req.query);
        const { rows } = await pool.query(
            `SELECT u."name" AS "member", u."role", f."fineType", f."amount",
                    f."status", f."daysOverdue", f."createdAt", f."paidAt", f."waiverReason"
               FROM ${T.fine()} f
               JOIN ${T.user()} u ON u."_id" = f."user"
              WHERE f."school" = $1
                AND ($2::timestamptz IS NULL OR f."createdAt" >= $2)
                AND ($3::timestamptz IS NULL OR f."createdAt" <= $3)
              ORDER BY f."createdAt" DESC
              LIMIT $4`,
            [String(req.schoolId), from, to, cap(req.query.limit, 500, 5000)],
        );
        const data = rows.map(r => ({
            Member: r.member, Role: r.role, Type: r.fineType, Amount: num(r.amount),
            Status: r.status, 'Days late': num(r.daysOverdue),
            Raised: day(r.createdAt), Paid: r.paidAt ? day(r.paidAt) : '',
            'Waiver reason': r.waiverReason || '',
        }));
        const total = (st) => data.filter(r => r.Status === st).reduce((s, r) => s + r.Amount, 0);
        deliver(req, res, 'fine_ledger', data, {
            summary: { pending: total('pending'), paid: total('paid'), waived: total('waived') },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Index ────────────────────────────────────────────────────────────────────
// So a client can build the reports screen from the server's list rather than
// hardcoding it in two places.
exports.index = async (_req, res) => {
    res.json({
        success: true,
        data: [
            { key: 'overdue',   name: 'Overdue register',   path: '/library/reports/overdue',   filters: [] },
            { key: 'popular',   name: 'Most borrowed',      path: '/library/reports/popular',   filters: ['from', 'to'] },
            { key: 'dead',      name: 'Dead stock',         path: '/library/reports/dead-stock', filters: ['since'] },
            { key: 'member',    name: 'Member history',     path: '/library/reports/member',    filters: ['userId'] },
            { key: 'accession', name: 'Accession register', path: '/library/reports/accession', filters: ['from', 'to'] },
            { key: 'stock',     name: 'Stock take',         path: '/library/reports/stock-take', filters: [] },
            { key: 'fines',     name: 'Fine ledger',        path: '/library/reports/fines',     filters: ['from', 'to'] },
        ],
    });
};
