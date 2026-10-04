'use strict';
/**
 * Every write the ID Card module makes (Oct 2026). Controllers only translate.
 *
 *   issue        new cards for students of a year / teachers / staff / parents
 *   regenerate   bring a card up to date: in place while the office has never
 *                printed it, else a reissue (the old card stops verifying)
 *   report       lost or damaged — optionally with the replacement at once
 *   replace      the replacement for a card reported lost or damaged earlier
 *   block / activate / cancel
 *   markPrinted  the office printed or downloaded these cards
 *   applyDesign  give cards in use the template's current look
 *
 * The rules that are never bent:
 *   · one card in force per holder — per holder and year for a student — held
 *     by an advisory lock here and by the partial unique index ux_idcards_live;
 *   · a card is never edited into something else once it has been printed: a
 *     new card is issued and the old one says what became of it;
 *   · a student card is only ever issued for a year that has not ended, and
 *     always says that year's class, section and roll — never today's.
 */
const crypto = require('crypto');
const pool = require('../db/pool');
const { patch } = require('../db/patch');
const { withTransaction, lock, buildInsert } = require('./dbTx');
const { newId } = require('../db/schema');
const IdCard = require('../models/IdCard');
const IdCardLog = require('../models/IdCardLog');
const IdCardCounter = require('../models/IdCardCounter');
const notifyService = require('./notifyService');
const { parentsOf } = require('./parentChildren');
const design = require('./idCardDesign');
const data = require('./idCardData');
const rules = require('./idCardRules');

const { fail, RuleError } = rules;
const CARDS = `"${IdCard.tableName}"`;
const COUNTERS = `"${IdCardCounter.tableName}"`;
const KINDS = design.KINDS;
const CHUNK = 100;

/* ── Numbers and codes ───────────────────────────────────────────────────── */

// No 0/O, 1/I: a code may be read out over the phone.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(length = 10) {
    let s = '';
    for (let i = 0; i < length; i += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    return s;
}

const pad = (n, w) => String(n).padStart(w, '0');

/**
 * `n` consecutive card numbers for a kind and series — "ST2627-00042" — taken
 * in one upsert, and never below a number already in the table (a school whose
 * cards were imported or seeded keeps counting from where they end).
 */
async function nextNumbers(q, schoolId, kind, series, n) {
    const prefix = `${rules.PREFIX[kind]}${series}-`;
    const { rows } = await q(`
        WITH hi AS (
            SELECT COALESCE(MAX(NULLIF(substring("number" from '-(\\d+)$'), '')::int), 0) AS h
              FROM ${CARDS} WHERE "school" = $2::uuid AND "number" LIKE $6
        )
        INSERT INTO ${COUNTERS} ("_id", "school", "kind", "series", "value", "createdAt", "updatedAt")
        VALUES ($1::uuid, $2::uuid, $3, $4, (SELECT h FROM hi) + $5, now(), now())
        ON CONFLICT ("school", "kind", "series") DO UPDATE
           SET "value" = GREATEST(${COUNTERS}."value", (SELECT h FROM hi)) + $5, "updatedAt" = now()
        RETURNING "value"`, [newId(), String(schoolId), kind, series, n, `${prefix}%`]);
    const last = Number(rows[0].value);
    const width = kind === 'student' || kind === 'parent' ? 5 : 4;
    return Array.from({ length: n }, (_, i) => `${prefix}${pad(last - n + 1 + i, width)}`);
}

/** Permanent parent IDs ("PAR10245"), kept across every card the parent is ever issued. */
async function nextParentIds(q, schoolId, n) {
    const { rows } = await q(`
        WITH hi AS (
            SELECT COALESCE(MAX(NULLIF(substring("snapshot"->>'holderCode' from '^PAR(\\d+)$'), '')::int) - 10000, 0) AS h
              FROM ${CARDS} WHERE "school" = $2::uuid AND "kind" = 'parent'
        )
        INSERT INTO ${COUNTERS} ("_id", "school", "kind", "series", "value", "createdAt", "updatedAt")
        VALUES ($1::uuid, $2::uuid, 'parentId', 'all', GREATEST((SELECT h FROM hi), 0) + $3, now(), now())
        ON CONFLICT ("school", "kind", "series") DO UPDATE
           SET "value" = GREATEST(${COUNTERS}."value", (SELECT h FROM hi)) + $3, "updatedAt" = now()
        RETURNING "value"`, [newId(), String(schoolId), n]);
    const last = Number(rows[0].value);
    return Array.from({ length: n }, (_, i) => `PAR${10000 + last - n + 1 + i}`);
}

/* ── The trail ───────────────────────────────────────────────────────────── */

function logRow(ctx, card, action, note = '', meta = {}) {
    return {
        school: ctx.schoolId, card: card?._id || null, holder: card?.holder || null, kind: card?.kind || '',
        action, note: String(note || '').slice(0, 500), by: ctx.userId || null, byRole: ctx.userRole || '', meta,
    };
}

async function writeLogs(q, rows) {
    for (const r of rows) {
        const { sql, params } = buildInsert(IdCardLog, r);
        await q(sql, params);
    }
}

async function log(ctx, card, action, note, meta) {
    await writeLogs((sql, params) => pool.query(sql, params), [logRow(ctx, card, action, note, meta)]);
}

/* ── Holders ─────────────────────────────────────────────────────────────── */

/** The live rows of who a kind of card is for — the ones asked for, or the scope. */
async function holderRows(schoolId, kind, year, { holderIds, scope } = {}) {
    if (kind === 'student') {
        let rows = await data.studentsOfYear(schoolId, year._id, { holderIds });
        const classIds = (scope?.classIds || []).map(String);
        const sectionIds = (scope?.sectionIds || []).map(String);
        if (classIds.length || sectionIds.length) {
            rows = rows.filter((r) => classIds.includes(String(r.classId)) || sectionIds.includes(String(r.sectionId)));
        }
        return rows;
    }
    if (kind === 'parent') return data.parents(schoolId, { holderIds });
    return (await data.employees(schoolId, { holderIds })).filter((r) => r.kind === kind);
}

/** One holder's live row, or null when they are no longer someone this card is for. */
async function holderRow(schoolId, card, ctxYears) {
    const year = card.kind === 'student' ? ctxYears.byId.get(String(card.academicYear)) : null;
    if (card.kind === 'student' && !year) return null;
    const rows = card.kind === 'student'
        ? await data.studentsOfYear(schoolId, year._id, { holderIds: [card.holder] })
        : card.kind === 'parent'
            ? await data.parents(schoolId, { holderIds: [card.holder] })
            : await data.employees(schoolId, { holderIds: [card.holder] });
    return rows[0] || null;
}

/** The parent IDs already given, by parent — a reissue keeps the parent's ID. */
async function knownParentIds(schoolId, holderIds) {
    if (!holderIds.length) return new Map();
    const { rows } = await pool.query(`
        SELECT DISTINCT ON ("holder") "holder"::text AS "holder", "snapshot"->>'holderCode' AS "code"
          FROM ${CARDS}
         WHERE "school" = $1::uuid AND "kind" = 'parent' AND "holder" = ANY($2::uuid[])
           AND COALESCE("snapshot"->>'holderCode', '') <> ''
         ORDER BY "holder", "issuedAt" ASC`, [String(schoolId), holderIds]);
    return new Map(rows.map((r) => [r.holder, r.code]));
}

/* ── Issuing ─────────────────────────────────────────────────────────────── */

/**
 * The one place a card row is born. `items`: [{ row, replaces?, oldStatus?,
 * expect?, status?, statusReason?, reissueReason? }] — `replaces` is the card
 * this one takes over from; `oldStatus` what that card becomes (lost, damaged,
 * reissued — or nothing, when it already says); `expect` the statuses it must
 * still have, so two offices acting at once cannot both replace it.
 *
 * Returns { cards, skipped: [{ holder, name, reason }] }.
 */
async function issueCards(ctx, kind, year, items, { note = '', notify = true } = {}) {
    const schoolId = ctx.schoolId;
    const ident = await design.identityOf(schoolId);
    const look = design.composeDesign(kind, await design.templateOf(schoolId, kind), ident);
    const yearKey = year ? String(year._id) : '';
    const series = kind === 'student' ? rules.yearCode(year) : String(new Date().getFullYear());

    // Parents keep one ID for life.
    let parentIds = new Map();
    if (kind === 'parent') parentIds = await knownParentIds(schoolId, items.map((i) => i.row._id));

    const issued = [];
    const skipped = [];
    for (let at = 0; at < items.length; at += CHUNK) {
        const chunk = items.slice(at, at + CHUNK).map((it) => ({ ...it, id: newId() }));
        // Photos are copied before the transaction (file work does not belong
        // inside one) and dropped again for any row that does not make it.
        await Promise.all(chunk.map(async (it) => { it.photo = await data.copyPhoto(schoolId, it.id, it.row.photoSource); }));
        let made = [];
        try {
            made = await withTransaction(async (q) => {
                await lock(q, `idcard:${schoolId}:${kind}`);
                // Who has a card in force already — read under the lock.
                const { rows: live } = await q(`
                    SELECT "holder"::text AS "holder" FROM ${CARDS}
                     WHERE "school" = $1::uuid AND "kind" = $2 AND COALESCE("academicYear"::text, '') = $3
                       AND "status" IN ('active', 'blocked') AND "holder" = ANY($4::uuid[])`,
                [String(schoolId), kind, yearKey, chunk.map((c) => c.row._id)]);
                const hasLive = new Set(live.map((r) => r.holder));

                const go = [];
                for (const it of chunk) {
                    if (it.replaces) {
                        // Take the old card out of service first, if it is the one asked about still.
                        const set = { replacedBy: it.id };
                        if (it.oldStatus) Object.assign(set, { status: it.oldStatus, statusReason: it.oldReason || note || '', statusAt: new Date(), statusBy: ctx.userId || null });
                        const ok = await patch(IdCard, it.replaces._id, set, { where: { status: it.expect, replacedBy: null }, q });
                        if (!ok) { skipped.push({ holder: it.row._id, name: it.row.name, reason: 'The card changed while this was being done — open it again' }); continue; }
                        hasLive.delete(String(it.row._id));
                    }
                    if (hasLive.has(String(it.row._id))) { skipped.push({ holder: it.row._id, name: it.row.name, reason: 'Already has a card' }); continue; }
                    go.push(it);
                    hasLive.add(String(it.row._id));
                }
                if (!go.length) return [];

                const numbers = await nextNumbers(q, schoolId, kind, series, go.length);
                const fresh = kind === 'parent' ? go.filter((it) => !parentIds.get(String(it.row._id))) : [];
                const newIds = fresh.length ? await nextParentIds(q, schoolId, fresh.length) : [];
                fresh.forEach((it, i) => parentIds.set(String(it.row._id), newIds[i]));

                const now = new Date();
                const rows = [];
                const logs = [];
                go.forEach((it, i) => {
                    const snap = data.snapshotOf(kind, it.row, { year, parentId: parentIds.get(String(it.row._id)) });
                    const doc = {
                        _id: it.id, school: schoolId, kind, holder: it.row._id, academicYear: year?._id || null,
                        number: numbers[i], code: newCode(),
                        status: it.status || 'active', statusReason: it.statusReason || '', statusAt: now, statusBy: ctx.userId || null,
                        replaces: it.replaces?._id || null,
                        reissueNo: it.replaces ? (Number(it.replaces.reissueNo) || 0) + 1 : 0,
                        reissueReason: it.reissueReason || '',
                        snapshot: { ...snap, photo: it.photo || '' },
                        design: look,
                        validFrom: year?.startDate || null, validUntil: year?.endDate || null,
                        issuedAt: now, issuedBy: ctx.userId || null, createdAt: now,
                    };
                    rows.push(doc);
                    logs.push(logRow(ctx, doc, it.replaces ? 'reissued' : 'issued', it.replaces ? (it.note || note) : note,
                        it.replaces ? { replaces: it.replaces.number, reason: it.reissueReason } : {}));
                    if (it.replaces) {
                        logs.push(logRow(ctx, it.replaces, it.oldStatus || 'replaced', it.note || note, { replacedBy: numbers[i] }));
                    }
                });
                for (const doc of rows) {
                    const { sql, params } = buildInsert(IdCard, doc);
                    await q(sql, params);
                }
                await writeLogs(q, logs);
                return rows;
            });
        } catch (e) {
            await Promise.all(chunk.map((it) => data.dropPhoto(it.photo)));
            if (e.code === '23505') fail(409, 'Another card was issued for one of these people at the same moment — refresh and try again');
            throw e;
        }
        const madeIds = new Set(made.map((r) => String(r._id)));
        await Promise.all(chunk.filter((it) => !madeIds.has(String(it.id))).map((it) => data.dropPhoto(it.photo)));
        issued.push(...made);
    }

    if (notify && issued.length) tellHolders(ctx, kind, year, issued).catch(() => {});
    return { cards: issued, skipped };
}

/** "Your ID card is ready" — to the holders, and to a student's parents. */
async function tellHolders(ctx, kind, year, cards) {
    const s = await design.settingsOf(ctx.schoolId);
    if (!s.notifyOnIssue) return;
    const link = { type: 'idcards.mine' };
    const holders = cards.map((c) => String(c.holder));
    if (kind === 'student') {
        const yearName = year?.yearName ? ` for ${year.yearName}` : '';
        notifyService.notify({
            school: ctx.schoolId, sender: ctx.userId, senderRole: ctx.userRole, link, recipients: holders,
            title: `🪪 Your ID card${yearName} is ready`,
            body: 'Open My ID Card to see it, download it or print it.',
        });
        const byStudent = await parentsOf(holders, ctx.schoolId);
        const parentIds = [...new Set([...byStudent.values()].flat())];
        if (parentIds.length) {
            notifyService.notify({
                school: ctx.schoolId, sender: ctx.userId, senderRole: ctx.userRole, link, recipients: parentIds,
                title: `🪪 Your child's ID card${yearName} is ready`,
                body: 'Open ID Cards to see it, download it or print it.',
            });
        }
        return;
    }
    notifyService.notify({
        school: ctx.schoolId, sender: ctx.userId, senderRole: ctx.userRole, link, recipients: holders,
        title: kind === 'parent' ? '🪪 Your parent ID card is ready' : '🪪 Your ID card is ready',
        body: kind === 'parent' ? 'Open ID Cards to see it, download it or print it.' : 'Open My ID Card to see it, download it or print it.',
    });
}

function checkKind(kind) {
    if (!KINDS.includes(kind)) fail(400, 'Choose student, teacher, staff or parent cards');
}

/** The year a student card is being issued for — one of this school's, and not over. */
async function issuableYear(schoolId, yearId, ctxYears = null) {
    const yc = ctxYears || await rules.yearContext(schoolId);
    const year = yearId ? yc.byId.get(String(yearId)) : yc.current;
    if (!year) fail(400, yearId ? 'That academic year is not one of this school\'s' : 'Set an academic year as current first — student cards belong to a year');
    if (!rules.canIssueFor(year)) fail(409, `${year.yearName} has ended — cards are only issued for the current year or one to come. Its cards stay on record as they were.`);
    return year;
}

/**
 * Who a run would issue to, and who it would pass over and why — what the
 * Generate dialog shows before anything is written.
 */
async function plan(ctx, { kind, yearId, holderIds, scope }) {
    checkKind(kind);
    const yc = await rules.yearContext(ctx.schoolId);
    const year = kind === 'student' ? await issuableYear(ctx.schoolId, yearId, yc) : null;
    const settings = await design.settingsOf(ctx.schoolId);
    const rows = await holderRows(ctx.schoolId, kind, year, { holderIds, scope });
    const { rows: live } = await pool.query(`
        SELECT "holder"::text AS "holder" FROM ${CARDS}
         WHERE "school" = $1::uuid AND "kind" = $2 AND COALESCE("academicYear"::text, '') = $3 AND "status" IN ('active', 'blocked')`,
    [String(ctx.schoolId), kind, year ? String(year._id) : '']);
    const hasLive = new Set(live.map((r) => r.holder));

    const out = { kind, year: year ? { _id: year._id, yearName: year.yearName, phase: year.phase } : null, total: rows.length, issue: [], skipped: [], noPhoto: [], noCode: [] };
    for (const r of rows) {
        const hasPhoto = data.photoExists(r.photoSource);
        if (!r.isActive) { out.skipped.push({ holder: r._id, name: r.name, reason: 'Account is switched off' }); continue; }
        if (hasLive.has(r._id)) { out.skipped.push({ holder: r._id, name: r.name, reason: 'Already has a card' }); continue; }
        if (!hasPhoto && settings.requirePhoto) { out.skipped.push({ holder: r._id, name: r.name, reason: 'No photo on record' }); continue; }
        out.issue.push(r);
        if (!hasPhoto) out.noPhoto.push({ holder: r._id, name: r.name });
        if (kind === 'student' && !r.admissionNumber) out.noCode.push({ holder: r._id, name: r.name });
        if ((kind === 'teacher' || kind === 'staff') && !r.employeeId) out.noCode.push({ holder: r._id, name: r.name });
    }
    return { out, year, rows: out.issue };
}

async function preview(ctx, body) {
    const { out } = await plan(ctx, body);
    const brief = (list) => list.slice(0, 50).map((x) => ({ holder: x.holder || x._id, name: x.name, reason: x.reason }));
    return {
        kind: out.kind, year: out.year, total: out.total,
        toIssue: out.issue.length,
        skipped: brief(out.skipped), skippedCount: out.skipped.length,
        noPhoto: brief(out.noPhoto), noPhotoCount: out.noPhoto.length,
        noCode: brief(out.noCode), noCodeCount: out.noCode.length,
        requirePhoto: (await design.settingsOf(ctx.schoolId)).requirePhoto,
    };
}

/** Issue cards: to everyone in scope who has none yet. */
async function issue(ctx, body) {
    const { out, year, rows } = await plan(ctx, body);
    if (!rows.length) {
        return { issued: 0, cards: [], skipped: out.skipped.slice(0, 50), skippedCount: out.skipped.length };
    }
    // A card reported lost or damaged and never replaced: this card is its replacement.
    const { rows: open } = await pool.query(`
        SELECT DISTINCT ON ("holder") * FROM ${CARDS}
         WHERE "school" = $1::uuid AND "kind" = $2 AND COALESCE("academicYear"::text, '') = $3
           AND "status" IN ('lost', 'damaged') AND "replacedBy" IS NULL AND "holder" = ANY($4::uuid[])
         ORDER BY "holder", "issuedAt" DESC`,
    [String(ctx.schoolId), body.kind, year ? String(year._id) : '', rows.map((r) => r._id)]);
    const openOf = new Map(open.map((c) => [String(c.holder), c]));
    const items = rows.map((row) => {
        const prev = openOf.get(String(row._id));
        return prev ? { row, replaces: prev, expect: [prev.status], reissueReason: prev.status } : { row };
    });
    const res = await issueCards(ctx, body.kind, year, items, { notify: body.notify !== false });
    const skipped = [...out.skipped, ...res.skipped];
    return {
        issued: res.cards.length,
        cards: res.cards.map((c) => ({ _id: c._id, number: c.number, holder: c.holder, name: c.snapshot?.name })),
        skipped: skipped.slice(0, 50), skippedCount: skipped.length,
    };
}

/* ── One card ────────────────────────────────────────────────────────────── */

async function loadCard(ctx, cardId) {
    const card = await IdCard.findOne({ _id: cardId, school: ctx.schoolId }).lean();
    if (!card) fail(404, 'Card not found');
    return card;
}

function mustBeActionable(card, yc) {
    if (rules.TERMINAL.includes(card.status)) fail(409, `This card is ${rules.STATUS_LABEL[card.status].toLowerCase()} — it can no longer be changed`);
    if (!rules.isActionable(card, yc)) fail(409, 'This card\'s academic year has ended — it stays on record exactly as it was issued');
}

/**
 * Bring a card's details up to date. Never printed by the office → the same
 * card (number and QR kept) says the new details. Printed → a new card is
 * issued and the old one is marked reissued, so the copy in someone's pocket
 * stops verifying as current.
 */
async function regenerate(ctx, cardId, { note = '' } = {}) {
    const yc = await rules.yearContext(ctx.schoolId);
    const card = await loadCard(ctx, cardId);
    mustBeActionable(card, yc);
    const row = await holderRow(ctx.schoolId, card, yc);
    if (!row) {
        fail(409, card.kind === 'student'
            ? `${card.snapshot?.name || 'This student'} is no longer in ${yc.byId.get(String(card.academicYear))?.yearName || 'that year'} — the card cannot be brought up to date. Cancel it instead.`
            : 'This person is no longer on the school\'s records — cancel the card instead');
    }
    if ((card.kind === 'teacher' || card.kind === 'staff') && row.kind !== card.kind) {
        fail(409, `${row.name} is now ${row.kind === 'teacher' ? 'teaching' : 'non-teaching'} staff — issue a ${row.kind} card from ${row.kind === 'teacher' ? 'Teacher' : 'Staff'} ID Cards and cancel this one`);
    }
    const year = card.kind === 'student' ? yc.byId.get(String(card.academicYear)) : null;

    if (!card.printedAt) {
        const ident = await design.identityOf(ctx.schoolId);
        const look = design.composeDesign(card.kind, await design.templateOf(ctx.schoolId, card.kind), ident);
        const snap = data.snapshotOf(card.kind, row, { year, parentId: card.snapshot?.holderCode });
        const changes = data.diff(card.kind, card.snapshot, snap, design.cardDesign(card.kind, card.design));
        const oldPhoto = card.snapshot?.photo || '';
        const photo = await data.copyPhoto(ctx.schoolId, `${card._id}-${Date.now().toString(36)}`, row.photoSource);
        const done = await patch(IdCard, card._id, { snapshot: { ...snap, photo }, design: look, refreshedAt: new Date() }, { where: { status: card.status, printedAt: null } });
        if (!done) { await data.dropPhoto(photo); fail(409, 'The card changed while this was being done — open it again'); }
        if (oldPhoto && oldPhoto !== photo) await data.dropPhoto(oldPhoto);
        await log(ctx, card, 'refreshed', note, { changes });
        return { mode: 'refreshed', card: await IdCard.findById(card._id).lean(), changes };
    }

    const res = await issueCards(ctx, card.kind, year, [{
        row, replaces: card, expect: [card.status], oldStatus: 'reissued', oldReason: note || 'Details changed',
        reissueReason: 'details', note,
        // A block is never lifted by reissuing: the new card carries it.
        status: card.status === 'blocked' ? 'blocked' : 'active', statusReason: card.status === 'blocked' ? card.statusReason : '',
    }], { note });
    if (!res.cards.length) fail(409, res.skipped[0]?.reason || 'The card could not be reissued');
    return { mode: 'reissued', card: res.cards[0], replaced: card._id };
}

/** Lost or damaged. With `replace`, the replacement is issued in the same step. */
async function report(ctx, cardId, { status, note = '', replace = true } = {}) {
    if (!['lost', 'damaged'].includes(status)) fail(400, 'Report the card as lost or damaged');
    const yc = await rules.yearContext(ctx.schoolId);
    const card = await loadCard(ctx, cardId);
    mustBeActionable(card, yc);
    if (!replace) {
        const done = await patch(IdCard, card._id, { status, statusReason: note, statusAt: new Date(), statusBy: ctx.userId || null }, { where: { status: card.status } });
        if (!done) fail(409, 'The card changed while this was being done — open it again');
        await log(ctx, card, status, note);
        return { card: done, replacement: null };
    }
    const row = await holderRow(ctx.schoolId, card, yc);
    if (!row) fail(409, 'This person is no longer on the school\'s records for this card — report it without a replacement');
    if (!row.isActive) fail(409, `${row.name}'s account is switched off — report the card without a replacement`);
    const year = card.kind === 'student' ? yc.byId.get(String(card.academicYear)) : null;
    const res = await issueCards(ctx, card.kind, year, [{
        row, replaces: card, expect: [card.status], oldStatus: status, oldReason: note, reissueReason: status, note,
        status: card.status === 'blocked' ? 'blocked' : 'active', statusReason: card.status === 'blocked' ? card.statusReason : '',
    }], { note });
    if (!res.cards.length) fail(409, res.skipped[0]?.reason || 'The replacement could not be issued');
    return { card: await IdCard.findById(card._id).lean(), replacement: res.cards[0] };
}

/** The replacement for a card reported lost or damaged without one. */
async function replace(ctx, cardId, { note = '' } = {}) {
    const yc = await rules.yearContext(ctx.schoolId);
    const card = await loadCard(ctx, cardId);
    if (!['lost', 'damaged'].includes(card.status)) fail(409, 'Only a card reported lost or damaged is replaced — reissue a card in use instead');
    if (card.replacedBy) fail(409, 'This card has been replaced already');
    if (card.kind === 'student') {
        const y = yc.byId.get(String(card.academicYear));
        if (!y || y.phase === 'past') fail(409, 'This card\'s academic year has ended — there is nothing to replace it for');
    }
    const row = await holderRow(ctx.schoolId, card, yc);
    if (!row || !row.isActive) fail(409, 'This person is no longer someone the card is for');
    const year = card.kind === 'student' ? yc.byId.get(String(card.academicYear)) : null;
    const res = await issueCards(ctx, card.kind, year, [{ row, replaces: card, expect: [card.status], reissueReason: card.status, note }], { note });
    if (!res.cards.length) fail(409, res.skipped[0]?.reason || 'The replacement could not be issued');
    return { card: await IdCard.findById(card._id).lean(), replacement: res.cards[0] };
}

async function block(ctx, cardId, { reason = '' } = {}) {
    if (!String(reason).trim()) fail(400, 'Say why the card is being blocked');
    const yc = await rules.yearContext(ctx.schoolId);
    const card = await loadCard(ctx, cardId);
    mustBeActionable(card, yc);
    if (card.status === 'blocked') fail(409, 'This card is blocked already');
    const done = await patch(IdCard, card._id, { status: 'blocked', statusReason: String(reason).trim(), statusAt: new Date(), statusBy: ctx.userId || null }, { where: { status: 'active' } });
    if (!done) fail(409, 'The card changed while this was being done — open it again');
    await log(ctx, card, 'blocked', reason);
    return done;
}

async function activate(ctx, cardId, { note = '' } = {}) {
    const yc = await rules.yearContext(ctx.schoolId);
    const card = await loadCard(ctx, cardId);
    if (card.status !== 'blocked') fail(409, card.status === 'active' ? 'This card is active already' : `A ${rules.STATUS_LABEL[card.status].toLowerCase()} card cannot be activated — issue a new one`);
    mustBeActionable(card, yc);
    const done = await patch(IdCard, card._id, { status: 'active', statusReason: '', statusAt: new Date(), statusBy: ctx.userId || null }, { where: { status: 'blocked' } });
    if (!done) fail(409, 'The card changed while this was being done — open it again');
    await log(ctx, card, 'activated', note);
    return done;
}

async function cancel(ctx, cardId, { reason = '' } = {}) {
    if (!String(reason).trim()) fail(400, 'Say why the card is being cancelled');
    const yc = await rules.yearContext(ctx.schoolId);
    const card = await loadCard(ctx, cardId);
    mustBeActionable(card, yc);
    const done = await patch(IdCard, card._id, { status: 'cancelled', statusReason: String(reason).trim(), statusAt: new Date(), statusBy: ctx.userId || null }, { where: { status: card.status } });
    if (!done) fail(409, 'The card changed while this was being done — open it again');
    await log(ctx, card, 'cancelled', reason);
    return done;
}

/**
 * The office printed (or downloaded) these cards. A printed card is no longer
 * refreshed in place — see regenerate.
 */
async function markPrinted(ctx, cardIds, action = 'printed') {
    const list = [...new Set((cardIds || []).map(String))];
    if (!list.length) return 0;
    const { rows } = await pool.query(`
        UPDATE ${CARDS} SET "printedAt" = now(), "printCount" = COALESCE("printCount", 0) + 1
         WHERE "school" = $1::uuid AND "_id" = ANY($2::uuid[])
        RETURNING "_id", "holder", "kind"`, [String(ctx.schoolId), list]);
    await writeLogs((sql, params) => pool.query(sql, params), rows.map((c) => logRow(ctx, c, action)));
    return rows.length;
}

/** A holder saved their own card (student, parent, teacher) — on the card's timeline only. */
async function noteDownload(ctx, card) {
    await log(ctx, card, 'downloaded', '', { byHolder: true });
}

/**
 * Give the cards in use the template's current look (and the school's current
 * name, logo and signatory). Only cards still in force: a past year's cards and
 * every card no longer in use keep the look they were issued with.
 */
async function applyDesign(ctx, kind) {
    checkKind(kind);
    const yc = await rules.yearContext(ctx.schoolId);
    const ident = await design.identityOf(ctx.schoolId);
    const look = design.composeDesign(kind, await design.templateOf(ctx.schoolId, kind), ident);
    const openYears = yc.years.filter((y) => y.phase !== 'past').map((y) => y._id);
    const { rowCount } = await pool.query(`
        UPDATE ${CARDS} SET "design" = $3::jsonb
         WHERE "school" = $1::uuid AND "kind" = $2 AND "status" IN ('active', 'blocked')
           AND ("kind" <> 'student' OR "academicYear" = ANY($4::uuid[]))`,
    [String(ctx.schoolId), kind, JSON.stringify(look), openYears]);
    await log(ctx, { kind }, 'design_applied', '', { count: rowCount });
    return rowCount;
}

/** How many cards in use a design change would reach. */
async function liveCount(schoolId, kind) {
    const yc = await rules.yearContext(schoolId);
    const openYears = yc.years.filter((y) => y.phase !== 'past').map((y) => y._id);
    const { rows: [r] } = await pool.query(`
        SELECT COUNT(*)::int AS n FROM ${CARDS}
         WHERE "school" = $1::uuid AND "kind" = $2 AND "status" IN ('active', 'blocked')
           AND ("kind" <> 'student' OR "academicYear" = ANY($3::uuid[]))`, [String(schoolId), kind, openYears]);
    return r?.n || 0;
}

module.exports = {
    RuleError, newCode, preview, issue, regenerate, report, replace, block, activate, cancel,
    markPrinted, noteDownload, applyDesign, liveCount, log, loadCard, holderRow,
};
