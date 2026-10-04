'use strict';
/**
 * The office's reads (Oct 2026): the four lists, the dashboard, one card.
 *
 * A list is people, not cards — "who should carry a card, and where does
 * theirs stand" — so a student with no card yet is a row (Pending) and a
 * student who left mid-year but has a card for the year is still one (marked
 * so). Each row carries its holder's LATEST card for the year (or ever, for
 * the persistent kinds) and, when that card is still in use, the fields where
 * it no longer matches what a card issued today would say.
 *
 * Rows are assembled in memory: one SQL read of the holders, one of the cards.
 * At a school's scale (a few thousand people) that is milliseconds, and it
 * means the drift check is the same code that builds a card — it cannot
 * disagree with what "Reissue" would print.
 */
const pool = require('../db/pool');
const IdCard = require('../models/IdCard');
const IdCardLog = require('../models/IdCardLog');
const User = require('../models/User');
const Class = require('../models/Class');
const ClassSection = require('../models/ClassSection');
const design = require('./idCardDesign');
const data = require('./idCardData');
const rules = require('./idCardRules');
const views = require('./idCardViews');

const CARDS = `"${IdCard.tableName}"`;
const LOGS = `"${IdCardLog.tableName}"`;
const USERS = `"${User.tableName}"`;

/** All cards of a kind (and year), newest first. */
async function cardsOf(schoolId, kind, yearId = null) {
    const { rows } = await pool.query(`
        SELECT * FROM ${CARDS}
         WHERE "school" = $1::uuid AND "kind" = $2 AND ($3::uuid IS NULL OR "academicYear" = $3::uuid)
         ORDER BY "issuedAt" DESC`, [String(schoolId), kind, yearId ? String(yearId) : null]);
    return rows;
}

/** The second line under a holder's name in a list. */
function lineOf(kind, row) {
    if (kind === 'student') {
        const cls = [row.className, row.sectionName].filter(Boolean).join(' – ');
        return [cls || 'No class yet', row.rollNumber ? `Roll ${row.rollNumber}` : ''].filter(Boolean).join(' · ');
    }
    if (kind === 'parent') {
        const kids = (row.children || []).map((c) => c.name).join(', ');
        return [row.relationship, kids ? `of ${kids}` : 'No children linked'].filter(Boolean).join(' ');
    }
    return [row.designation, row.department].filter(Boolean).join(' · ') || (kind === 'teacher' ? 'Teacher' : 'Staff');
}

const codeOf = (kind, row, card) => (kind === 'student' ? row.admissionNumber
    : kind === 'parent' ? (card?.snapshot?.holderCode || '')
        : row.employeeId) || '';

/**
 * The rows of one list. `year` (students) is a year from yearContext.
 * → [{ _id, name, photo, isActive, inScope, code, line, classId, sectionId,
 *      card, state, changes, needsReissue, noPhoto }]
 */
async function rowsFor(schoolId, kind, yc, year) {
    let holders;
    if (kind === 'student') holders = await data.studentsOfYear(schoolId, year._id);
    else if (kind === 'parent') holders = await data.parents(schoolId);
    else holders = (await data.employees(schoolId)).filter((r) => r.kind === kind);

    const cards = await cardsOf(schoolId, kind, kind === 'student' ? year._id : null);
    const latest = new Map();
    for (const c of cards) if (!latest.has(String(c.holder))) latest.set(String(c.holder), c);

    const byId = new Map(holders.map((h) => [h._id, { row: h, inScope: true }]));
    // People with a card here who are not (or no longer) in the list's scope:
    // a student who left the year, an employee now on the other list.
    const missing = [...latest.keys()].filter((id) => !byId.has(id));
    if (missing.length) {
        let others;
        if (kind === 'student') others = await data.studentsById(schoolId, missing);
        else if (kind === 'parent') others = await data.parents(schoolId, { holderIds: missing });
        else others = await data.employees(schoolId, { holderIds: missing });
        for (const o of others) byId.set(o._id, { row: o, inScope: false });
        // Holders whose account no longer exists at all still have a card row.
        for (const id of missing) {
            if (!byId.has(id)) byId.set(id, { row: { _id: id, name: latest.get(id).snapshot?.name || 'Removed account', isActive: false, photoSource: '' }, inScope: false, removed: true });
        }
    }

    const open = kind !== 'student' || year.phase !== 'past';
    const out = [];
    for (const [id, { row, inScope, removed }] of byId) {
        const card = latest.get(id) || null;
        const status = card ? rules.effectiveStatus(card, yc) : (open ? 'pending' : 'none');
        let changes = [];
        if (card && inScope && rules.isActionable(card, yc)) {
            const live = data.snapshotOf(kind, row, { year, parentId: card.snapshot?.holderCode });
            changes = data.diff(kind, card.snapshot, live, design.cardDesign(kind, card.design));
        }
        // A teacher now classed as staff (or the other way): the card's title is wrong.
        if (card && !inScope && !removed && (kind === 'teacher' || kind === 'staff') && row.kind && row.kind !== kind && rules.isActionable(card, yc)) {
            changes.push({ key: 'kind', label: 'Card type', was: rules.KIND_TITLE[kind], now: rules.KIND_TITLE[row.kind] });
        }
        const unreplaced = card && ['lost', 'damaged'].includes(card.status) && !card.replacedBy && open && row.isActive !== false;
        out.push({
            _id: id,
            name: row.name || card?.snapshot?.name || '',
            photo: row.photoSource || card?.snapshot?.photo || '',
            isActive: row.isActive !== false,
            inScope,
            removed: !!removed,
            code: codeOf(kind, row, card),
            line: inScope ? lineOf(kind, row) : (card ? lineOf(kind, card.snapshot || {}) : ''),
            classId: row.classId || null,
            className: row.className || card?.snapshot?.className || '',
            sectionId: row.sectionId || null,
            sectionName: row.sectionName || card?.snapshot?.sectionName || '',
            classNumber: row.classNumber ?? card?.snapshot?.classNumber ?? null,
            rollNumber: row.rollNumber || '',
            card: card ? {
                _id: String(card._id), number: card.number, status, stored: card.status,
                statusLabel: rules.STATUS_LABEL[status], statusReason: card.statusReason || '',
                issuedAt: card.issuedAt, printedAt: card.printedAt || null, printCount: Number(card.printCount) || 0,
                reissueNo: Number(card.reissueNo) || 0, replacedBy: card.replacedBy ? String(card.replacedBy) : null,
                yearName: card.snapshot?.yearName || '',
            } : null,
            state: status,
            changes,
            needsReissue: changes.length > 0 || !!unreplaced,
            leftWithCard: !!card && rules.LIVE.includes(card.status) && (row.isActive === false || removed),
            noPhoto: !data.photoExists(row.photoSource),
            noCode: !codeOf(kind, row, card) && kind !== 'parent',
        });
    }
    return out;
}

const TABS = ['all', 'pending', 'active', 'generated', 'blocked', 'lost', 'attention', 'unprinted', 'expired', 'cancelled'];

function inTab(r, tab) {
    switch (tab) {
        case 'all': return true;
        case 'pending': return r.state === 'pending' && r.isActive && r.inScope;
        case 'active': return r.state === 'active';
        case 'generated': return r.state === 'generated';
        case 'blocked': return r.state === 'blocked';
        case 'lost': return r.state === 'lost' || r.state === 'damaged';
        case 'attention': return r.needsReissue || r.leftWithCard;
        case 'unprinted': return !!r.card && !r.card.printedAt && ['active', 'generated', 'blocked'].includes(r.state);
        case 'expired': return r.state === 'expired';
        case 'cancelled': return r.state === 'cancelled' || r.state === 'reissued';
        default: return true;
    }
}

const SORTS = {
    name: (a, b) => a.name.localeCompare(b.name),
    class: (a, b) => (Number(a.classNumber ?? 999) - Number(b.classNumber ?? 999))
        || String(a.sectionName).localeCompare(String(b.sectionName))
        || (Number(a.rollNumber) || 9999) - (Number(b.rollNumber) || 9999)
        || a.name.localeCompare(b.name),
    issued: (a, b) => new Date(b.card?.issuedAt || 0) - new Date(a.card?.issuedAt || 0) || a.name.localeCompare(b.name),
};

/** The class and section pickers for a year — every class of it, even an empty one. */
async function classOptions(schoolId, yearId) {
    const { rows } = await pool.query(`
        SELECT c."_id"::text AS "classId", c."className", c."classNumber",
               s."_id"::text AS "sectionId", s."sectionName"
          FROM "${Class.tableName}" c
          LEFT JOIN "${ClassSection.tableName}" s ON s."class" = c."_id"
         WHERE c."school" = $1::uuid AND c."academicYear" = $2::uuid
         ORDER BY c."classNumber", s."sectionName"`, [String(schoolId), String(yearId)]);
    const byClass = new Map();
    for (const r of rows) {
        if (!byClass.has(r.classId)) byClass.set(r.classId, { _id: r.classId, className: r.className, classNumber: r.classNumber, sections: [] });
        if (r.sectionId) byClass.get(r.classId).sections.push({ _id: r.sectionId, sectionName: r.sectionName });
    }
    return [...byClass.values()];
}

const yearBrief = (y) => (y ? { _id: y._id, yearName: y.yearName, phase: y.phase, startDate: y.startDate, endDate: y.endDate } : null);

/**
 * GET /admin/id-cards/list?kind=&year=&tab=&q=&classId=&sectionId=&sort=&page=&limit=
 */
async function list(schoolId, query = {}) {
    const kind = design.KINDS.includes(query.kind) ? query.kind : 'student';
    const yc = await rules.yearContext(schoolId);
    let year = null;
    if (kind === 'student') {
        year = (query.year && yc.byId.get(String(query.year))) || yc.current || yc.years[yc.years.length - 1] || null;
        if (!year) {
            return { kind, year: null, years: [], rows: [], total: 0, page: 1, pages: 1, limit: 20, counts: {}, classes: [], noYear: true };
        }
    }
    let rows = await rowsFor(schoolId, kind, yc, year);

    // Search, class and section narrow everything, tab counts included.
    const q = String(query.q || '').trim().toLowerCase();
    if (q) {
        rows = rows.filter((r) => r.name.toLowerCase().includes(q) || String(r.code).toLowerCase().includes(q)
            || String(r.card?.number || '').toLowerCase().includes(q) || String(r.line).toLowerCase().includes(q));
    }
    if (kind === 'student' && query.classId) rows = rows.filter((r) => String(r.classId) === String(query.classId));
    if (kind === 'student' && query.sectionId) rows = rows.filter((r) => String(r.sectionId) === String(query.sectionId));

    const counts = Object.fromEntries(TABS.map((t) => [t, rows.filter((r) => inTab(r, t)).length]));
    const tab = TABS.includes(query.tab) ? query.tab : 'all';
    rows = rows.filter((r) => inTab(r, tab));
    rows.sort(SORTS[query.sort] || (kind === 'student' ? SORTS.class : SORTS.name));

    const limit = Math.min(100, Math.max(5, Number(query.limit) || 20));
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(pages, Math.max(1, Number(query.page) || 1));
    return {
        kind,
        year: yearBrief(year),
        years: kind === 'student' ? [...yc.years].reverse().map(yearBrief) : [],
        canIssue: kind !== 'student' || rules.canIssueFor(year),
        rows: rows.slice((page - 1) * limit, page * limit),
        // Every id on every page — "select all N" in the bulk bar.
        ids: rows.map((r) => ({ _id: r._id, card: r.card?._id || null, state: r.state })),
        total, page, pages, limit, counts,
        classes: kind === 'student' ? await classOptions(schoolId, year._id) : [],
    };
}

/* ── Dashboard ───────────────────────────────────────────────────────────── */

const tally = (rows) => ({
    holders: rows.filter((r) => r.inScope && r.isActive).length,
    issued: rows.filter((r) => ['active', 'generated', 'blocked'].includes(r.state)).length,
    active: rows.filter((r) => r.state === 'active').length,
    generated: rows.filter((r) => r.state === 'generated').length,
    pending: rows.filter((r) => inTab(r, 'pending')).length,
    blocked: rows.filter((r) => r.state === 'blocked').length,
    lost: rows.filter((r) => (r.state === 'lost' || r.state === 'damaged') && !r.card?.replacedBy).length,
    reissue: rows.filter((r) => r.needsReissue).length,
    left: rows.filter((r) => r.leftWithCard).length,
    unprinted: rows.filter((r) => inTab(r, 'unprinted')).length,
    noPhoto: rows.filter((r) => r.state === 'pending' && r.noPhoto && r.isActive && r.inScope).length,
    noCode: rows.filter((r) => r.state === 'pending' && r.noCode && r.isActive && r.inScope).length,
});

/** GET /admin/id-cards/overview */
async function overview(schoolId) {
    const yc = await rules.yearContext(schoolId);
    const [students, nextStudents, teachers, staff, parents] = await Promise.all([
        yc.current ? rowsFor(schoolId, 'student', yc, yc.current) : [],
        yc.next ? rowsFor(schoolId, 'student', yc, yc.next) : [],
        rowsFor(schoolId, 'teacher', yc, null),
        rowsFor(schoolId, 'staff', yc, null),
        rowsFor(schoolId, 'parent', yc, null),
    ]);
    const pastYears = yc.years.filter((y) => y.phase === 'past').map((y) => y._id);
    const { rows: [exp] } = await pool.query(`
        SELECT COUNT(*)::int AS "expired", COUNT(DISTINCT "academicYear")::int AS "years"
          FROM ${CARDS} WHERE "school" = $1::uuid AND "kind" = 'student' AND "status" = 'active' AND "academicYear" = ANY($2::uuid[])`,
    [String(schoolId), pastYears]);
    const { rows: [all] } = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE "kind" = 'student')::int AS "students",
               COUNT(*)::int AS "total",
               COUNT(*) FILTER (WHERE "issuedAt" > now() - interval '30 days')::int AS "lastMonth"
          FROM ${CARDS} WHERE "school" = $1::uuid`, [String(schoolId)]);

    const s = tally(students);
    const n = tally(nextStudents);
    const t = tally(teachers);
    const f = tally(staff);
    const p = tally(parents);

    // One line per thing the office should look at, worded for its count.
    const attention = [];
    const who = { student: 'student', teacher: 'teacher', staff: 'staff', parent: 'parent' };
    const many = { student: 'students', teacher: 'teachers', staff: 'staff', parent: 'parents' };
    const add = (key, kind, count, tab) => {
        if (!count) return;
        const one = count === 1;
        let text;
        if (key === 'reissue') {
            text = kind === 'parent'
                ? `${one ? 'parent card no longer matches' : 'parent cards no longer match'} the parent's record (children or details changed)`
                : `${who[kind]} ${one ? 'card no longer matches' : 'cards no longer match'} the ${kind === 'staff' ? 'employee' : who[kind]}'s details`;
        } else if (key === 'lost') {
            text = `${who[kind]} ${one ? 'card was' : 'cards were'} reported lost or damaged and not replaced`;
        } else if (key === 'left') {
            text = one ? `${who[kind]} who has left still holds a card in force` : `${many[kind]} who have left still hold a card in force`;
        } else if (key === 'noPhoto') {
            text = `${one ? 'student waiting for a card has' : 'students waiting for a card have'} no photo on record`;
        } else {
            text = `${one ? `${who[kind]} waiting for a card has` : `${many[kind]} waiting for a card have`} no employee ID`;
        }
        attention.push({ key, kind, count, text, tab });
    };
    add('reissue', 'student', students.filter((r) => r.changes.length).length, 'attention');
    add('reissue', 'teacher', teachers.filter((r) => r.changes.length).length, 'attention');
    add('reissue', 'staff', staff.filter((r) => r.changes.length).length, 'attention');
    add('reissue', 'parent', parents.filter((r) => r.changes.length).length, 'attention');
    add('lost', 'student', s.lost, 'lost');
    add('lost', 'teacher', t.lost, 'lost');
    add('lost', 'staff', f.lost, 'lost');
    add('lost', 'parent', p.lost, 'lost');
    add('left', 'student', s.left, 'attention');
    add('left', 'teacher', t.left, 'attention');
    add('left', 'staff', f.left, 'attention');
    add('left', 'parent', p.left, 'attention');
    add('noPhoto', 'student', s.noPhoto, 'pending');
    add('noCode', 'teacher', t.noCode, 'pending');
    add('noCode', 'staff', f.noCode, 'pending');

    const { rows: recent } = await pool.query(`
        SELECT c."_id"::text AS "_id", c."kind", c."number", c."issuedAt", c."reissueNo", c."status",
               c."academicYear"::text AS "academicYear", c."snapshot"->>'name' AS "name", c."snapshot"->>'photo' AS "photo",
               c."snapshot"->>'className' AS "className", c."snapshot"->>'sectionName' AS "sectionName",
               c."snapshot"->>'designation' AS "designation", c."snapshot"->>'relationship' AS "relationship",
               c."snapshot"->>'yearName' AS "yearName", u."name" AS "issuedBy"
          FROM ${CARDS} c LEFT JOIN ${USERS} u ON u."_id" = c."issuedBy"
         WHERE c."school" = $1::uuid ORDER BY c."issuedAt" DESC LIMIT 8`, [String(schoolId)]);

    // Which classes still need cards: every class and section of the year, even
    // an empty one, with how many of its students hold a card.
    const byClass = yc.current ? (await classOptions(schoolId, yc.current._id)).map((c) => {
        const sections = c.sections.map((sec) => {
            const rows = students.filter((r) => r.inScope && r.isActive && String(r.sectionId) === String(sec._id));
            return { _id: sec._id, sectionName: sec.sectionName, total: rows.length, issued: rows.filter((r) => ['active', 'generated', 'blocked'].includes(r.state)).length, pending: rows.filter((r) => r.state === 'pending').length };
        });
        const loose = students.filter((r) => r.inScope && r.isActive && String(r.classId) === String(c._id) && !r.sectionId);
        if (loose.length) sections.push({ _id: null, sectionName: '', total: loose.length, issued: loose.filter((r) => ['active', 'generated', 'blocked'].includes(r.state)).length, pending: loose.filter((r) => r.state === 'pending').length });
        const sum = (k) => sections.reduce((a, x) => a + x[k], 0);
        return { _id: c._id, className: c.className, classNumber: c.classNumber, total: sum('total'), issued: sum('issued'), pending: sum('pending'), sections };
    }) : [];

    return {
        year: yearBrief(yc.current),
        next: yearBrief(yc.next),
        byClass,
        students: s,
        nextStudents: yc.next ? n : null,
        teachers: t,
        staff: f,
        parents: p,
        expired: exp?.expired || 0,
        expiredYears: exp?.years || 0,
        totals: all || { students: 0, total: 0, lastMonth: 0 },
        attention,
        recent: recent.map((r) => ({
            ...r,
            status: rules.effectiveStatus({ kind: r.kind, status: r.status, academicYear: r.academicYear }, yc),
            line: r.kind === 'student' ? [r.className, r.sectionName].filter(Boolean).join(' – ')
                : r.kind === 'parent' ? r.relationship : r.designation,
        })),
        activity: await activity(schoolId, { limit: 10 }),
    };
}

const ACTION_LABEL = {
    issued: 'Issued', reissued: 'Reissued', refreshed: 'Details updated', printed: 'Printed', downloaded: 'Downloaded',
    blocked: 'Blocked', activated: 'Activated', cancelled: 'Cancelled', lost: 'Reported lost', damaged: 'Reported damaged',
    replaced: 'Replaced', verified: 'Verified at the desk', scanned: 'QR scanned', design_applied: 'Design applied to cards in use',
    template_saved: 'Template saved', settings_saved: 'Settings saved',
};

/** The school's trail, newest first (scans left out: they are counted on the card). */
async function activity(schoolId, { limit = 20, card = null, includeScans = false } = {}) {
    const { rows } = await pool.query(`
        SELECT l."_id"::text AS "_id", l."action", l."note", l."kind", l."meta", l."createdAt", l."byRole",
               l."card"::text AS "card", u."name" AS "by",
               c."number", c."snapshot"->>'name' AS "holderName"
          FROM ${LOGS} l
          LEFT JOIN ${USERS} u ON u."_id" = l."by"
          LEFT JOIN ${CARDS} c ON c."_id" = l."card"
         WHERE l."school" = $1::uuid AND ($2::uuid IS NULL OR l."card" = $2::uuid)
           AND ($3::boolean OR l."action" <> 'scanned')
         ORDER BY l."createdAt" DESC LIMIT $4`, [String(schoolId), card ? String(card) : null, !!includeScans, limit]);
    return rows.map((r) => ({ ...r, label: ACTION_LABEL[r.action] || r.action }));
}

/* ── One card ────────────────────────────────────────────────────────────── */

/** What the office may do to a card now. */
function abilities(card, yc, holderActive) {
    const actionable = rules.isActionable(card, yc);
    const lostOpen = ['lost', 'damaged'].includes(card.status) && !card.replacedBy
        && (card.kind !== 'student' || yc.byId.get(String(card.academicYear))?.phase !== 'past');
    return {
        regenerate: actionable,
        refreshInPlace: actionable && !card.printedAt,
        report: actionable,
        replace: lostOpen && holderActive,
        block: actionable && card.status === 'active',
        activate: actionable && card.status === 'blocked',
        cancel: actionable,
        print: true,
    };
}

/** GET /admin/id-cards/cards/:id */
async function cardDetail(schoolId, cardId) {
    const card = await IdCard.findOne({ _id: cardId, school: schoolId }).lean();
    if (!card) rules.fail(404, 'Card not found');
    const yc = await rules.yearContext(schoolId);
    const svc = require('./idCardService');
    const [view, row, history, timeline, people] = await Promise.all([
        views.cardView(card, yc),
        svc.holderRow(schoolId, card, yc).catch(() => null),
        pool.query(`SELECT * FROM ${CARDS} WHERE "school" = $1::uuid AND "holder" = $2::uuid AND "kind" = $3 ORDER BY "issuedAt" DESC`,
            [String(schoolId), String(card.holder), card.kind]).then((r) => r.rows),
        activity(schoolId, { card: card._id, limit: 100, includeScans: true }),
        pool.query(`SELECT "_id"::text AS "_id", "name" FROM ${USERS} WHERE "_id" = ANY($1::uuid[])`,
            [[card.issuedBy, card.statusBy].filter(Boolean).map(String)]).then((r) => new Map(r.rows.map((u) => [u._id, u.name]))),
    ]);
    const holderUser = await User.findById(card.holder).select('name isActive').lean();
    const year = card.kind === 'student' ? yc.byId.get(String(card.academicYear)) : null;
    let changes = [];
    if (row && rules.isActionable(card, yc)) {
        const live = data.snapshotOf(card.kind, row, { year, parentId: card.snapshot?.holderCode });
        changes = data.diff(card.kind, card.snapshot, live, design.cardDesign(card.kind, card.design));
        if ((card.kind === 'teacher' || card.kind === 'staff') && row.kind && row.kind !== card.kind) {
            changes.push({ key: 'kind', label: 'Card type', was: rules.KIND_TITLE[card.kind], now: rules.KIND_TITLE[row.kind] });
        }
    }
    const holderActive = !!holderUser && holderUser.isActive !== false;
    return {
        card: view,
        issuedBy: people.get(String(card.issuedBy)) || '',
        statusBy: people.get(String(card.statusBy)) || '',
        holder: {
            _id: String(card.holder),
            name: holderUser?.name || card.snapshot?.name || '',
            isActive: holderActive,
            removed: !holderUser,
            inScope: !!row,
            now: row ? lineOf(card.kind, row) : '',
        },
        changes,
        can: abilities(card, yc, holderActive && !!row),
        history: history.map((c) => {
            const st = rules.effectiveStatus(c, yc);
            return {
                _id: String(c._id), number: c.number, status: st, statusLabel: rules.STATUS_LABEL[st],
                yearName: c.snapshot?.yearName || '', issuedAt: c.issuedAt, reissueNo: Number(c.reissueNo) || 0,
                reissueReason: c.reissueReason || '', current: String(c._id) === String(card._id),
                line: lineOf(c.kind, c.snapshot || {}),
            };
        }),
        timeline,
    };
}

/**
 * GET /admin/id-cards/holders/:id?kind= — everyone's card history, including
 * someone with no card in force (a promoted student still waiting for this
 * year's): who they are now, and every card they were ever issued.
 */
async function holderDetail(schoolId, holderId, kind) {
    if (!design.KINDS.includes(kind)) rules.fail(400, 'Choose student, teacher, staff or parent');
    const user = await User.findOne({ _id: holderId, school: schoolId }).select('name isActive profileImage role').lean();
    if (!user) rules.fail(404, 'Person not found');
    const yc = await rules.yearContext(schoolId);
    const { rows } = await pool.query(`SELECT * FROM ${CARDS} WHERE "school" = $1::uuid AND "holder" = $2::uuid AND "kind" = $3 ORDER BY "issuedAt" DESC`,
        [String(schoolId), String(holderId), kind]);
    let row = null;
    if (kind === 'student') row = yc.current ? (await data.studentsOfYear(schoolId, yc.current._id, { holderIds: [holderId] }))[0] || null : null;
    else if (kind === 'parent') row = (await data.parents(schoolId, { holderIds: [holderId] }))[0] || null;
    else row = (await data.employees(schoolId, { holderIds: [holderId] }))[0] || null;
    return {
        holder: {
            _id: String(holderId), name: user.name, isActive: user.isActive !== false,
            photo: row?.photoSource || user.profileImage || '',
            now: row ? lineOf(kind, row) : '',
            code: row ? codeOf(kind, row, rows[0]) : (rows[0]?.snapshot?.holderCode || ''),
            noPhoto: row ? !data.photoExists(row.photoSource) : true,
        },
        year: yearBrief(yc.current),
        cards: rows.map((c) => {
            const st = rules.effectiveStatus(c, yc);
            return {
                _id: String(c._id), number: c.number, status: st, statusLabel: rules.STATUS_LABEL[st],
                yearName: c.snapshot?.yearName || '', issuedAt: c.issuedAt, reissueNo: Number(c.reissueNo) || 0,
                reissueReason: c.reissueReason || '', line: lineOf(c.kind, c.snapshot || {}),
            };
        }),
    };
}

module.exports = { list, overview, cardDetail, holderDetail, activity, rowsFor, classOptions, ACTION_LABEL, TABS };
