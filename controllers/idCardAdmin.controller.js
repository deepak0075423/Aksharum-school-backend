'use strict';
/**
 * The ID Card module's office surface (Oct 2026) — /admin/id-cards/*, for the
 * school administrator and any teacher whose designation administers ID cards
 * (allowModuleAdmin('idCard')). Every rule lives in services/idCard*; this
 * file only reads the request and translates RuleError into a status.
 *
 *   GET  overview                       the dashboard
 *   GET  list?kind=&year=&tab=&q=…       a list of holders with their cards
 *   GET  cards/:id                       one card: view, timeline, history, what can be done
 *   POST generate/preview | generate     issue cards (students of a year, teachers, staff, parents)
 *   POST cards/:id/regenerate|report|replace|block|activate|cancel
 *   POST print                           a PDF of the chosen cards (marks them printed)
 *   GET  cards/:id/pdf                   one card's PDF (marks it printed)
 *   GET  lookup?q=                       the verification desk
 *   GET  activity                        the school's trail
 *   GET  templates | PUT templates/:kind | POST templates/:kind/apply
 *   GET  settings  | PUT settings | POST settings/:image | DELETE settings/:image
 */
const pool = require('../db/pool');
const IdCard = require('../models/IdCard');
const service = require('../services/idCardService');
const board = require('../services/idCardBoard');
const views = require('../services/idCardViews');
const design = require('../services/idCardDesign');
const data = require('../services/idCardData');
const rules = require('../services/idCardRules');
const { renderIdCards, pdfName } = require('../utils/idCardPdf');

const ctxOf = (req) => ({ schoolId: req.schoolId, userId: req.userId, userRole: req.userRole });

const handle = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (e) {
        if (e instanceof rules.RuleError) return res.status(e.status).json({ success: false, message: e.message, ...(e.extra || {}) });
        console.error('[id cards]', e);
        return res.status(500).json({ success: false, message: e.message || 'Something went wrong' });
    }
};
const ok = (res, data, extra) => res.json({ success: true, data, ...(extra || {}) });

/* ── Reads ───────────────────────────────────────────────────────────────── */

exports.overview = handle(async (req, res) => ok(res, await board.overview(req.schoolId)));
exports.list = handle(async (req, res) => ok(res, await board.list(req.schoolId, req.query)));
exports.card = handle(async (req, res) => ok(res, await board.cardDetail(req.schoolId, req.params.id)));
exports.holder = handle(async (req, res) => ok(res, await board.holderDetail(req.schoolId, req.params.id, req.query.kind)));
exports.activity = handle(async (req, res) => ok(res, await board.activity(req.schoolId, {
    limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)), includeScans: req.query.scans === '1',
})));
exports.lookup = handle(async (req, res) => ok(res, await views.lookup(ctxOf(req), req.query.q)));

/* ── Issuing ─────────────────────────────────────────────────────────────── */

const issueBody = (b = {}) => ({
    kind: b.kind,
    yearId: b.yearId || b.academicYear || null,
    holderIds: Array.isArray(b.holderIds) ? b.holderIds.map(String) : undefined,
    scope: b.scope && typeof b.scope === 'object' ? {
        classIds: Array.isArray(b.scope.classIds) ? b.scope.classIds.map(String) : [],
        sectionIds: Array.isArray(b.scope.sectionIds) ? b.scope.sectionIds.map(String) : [],
    } : undefined,
    notify: b.notify !== false,
});

exports.preview = handle(async (req, res) => ok(res, await service.preview(ctxOf(req), issueBody(req.body))));
exports.generate = handle(async (req, res) => {
    const out = await service.issue(ctxOf(req), issueBody(req.body));
    ok(res, out, { message: out.issued ? `${out.issued} card${out.issued === 1 ? '' : 's'} issued` : 'No new cards were needed' });
});

/* ── One card ────────────────────────────────────────────────────────────── */

exports.regenerate = handle(async (req, res) => {
    const out = await service.regenerate(ctxOf(req), req.params.id, { note: req.body?.note });
    ok(res, { mode: out.mode, card: String(out.card._id), changes: out.changes || [] }, {
        message: out.mode === 'refreshed' ? 'Card updated with the latest details' : `New card ${out.card.number} issued — the old card no longer verifies`,
    });
});
exports.report = handle(async (req, res) => {
    const b = req.body || {};
    const out = await service.report(ctxOf(req), req.params.id, { status: b.status, note: b.note, replace: b.replace !== false });
    ok(res, { card: String(out.card._id), replacement: out.replacement ? String(out.replacement._id) : null }, {
        message: out.replacement ? `Marked ${b.status} — replacement ${out.replacement.number} issued` : `Card marked ${b.status}`,
    });
});
exports.replace = handle(async (req, res) => {
    const out = await service.replace(ctxOf(req), req.params.id, { note: req.body?.note });
    ok(res, { card: String(out.card._id), replacement: String(out.replacement._id) }, { message: `Replacement ${out.replacement.number} issued` });
});
exports.block = handle(async (req, res) => {
    await service.block(ctxOf(req), req.params.id, { reason: req.body?.reason });
    ok(res, { card: req.params.id }, { message: 'Card blocked — it no longer verifies' });
});
exports.activate = handle(async (req, res) => {
    await service.activate(ctxOf(req), req.params.id, { note: req.body?.note });
    ok(res, { card: req.params.id }, { message: 'Card activated' });
});
exports.cancel = handle(async (req, res) => {
    await service.cancel(ctxOf(req), req.params.id, { reason: req.body?.reason });
    ok(res, { card: req.params.id }, { message: 'Card cancelled' });
});

/* ── Printing ────────────────────────────────────────────────────────────── */

const LAYOUTS = ['card', 'sheet'];
const SIDES = ['both', 'front', 'back'];

/** Cards of this school, in the order asked for. */
async function cardsById(schoolId, ids) {
    const list = [...new Set((ids || []).map(String))].slice(0, 1000);
    if (!list.length) return [];
    const { rows } = await pool.query(`SELECT * FROM "${IdCard.tableName}" WHERE "school" = $1::uuid AND "_id" = ANY($2::uuid[])`, [String(schoolId), list]);
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    return list.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * POST /admin/id-cards/print { cardIds, layout: card|sheet, sides: both|front|back }
 * A PDF the office prints from. Cards not in force print with a VOID stamp.
 */
exports.print = handle(async (req, res) => {
    const b = req.body || {};
    const cards = await cardsById(req.schoolId, b.cardIds);
    if (!cards.length) return res.status(400).json({ success: false, message: 'Choose the cards to print' });
    const yc = await rules.yearContext(req.schoolId);
    await service.markPrinted(ctxOf(req), cards.filter((c) => rules.effectiveStatus(c, yc) === 'active' || rules.effectiveStatus(c, yc) === 'generated').map((c) => c._id), 'printed');
    renderIdCards(res, {
        cards: cards.map((c) => ({ ...c, effective: rules.effectiveStatus(c, yc) })),
        layout: LAYOUTS.includes(b.layout) ? b.layout : 'sheet',
        sides: SIDES.includes(b.sides) ? b.sides : 'both',
        filename: cards.length === 1 ? pdfName(cards[0]) : `id-cards-${new Date().toISOString().slice(0, 10)}.pdf`,
        cropMarks: b.cropMarks !== false,
    });
});

/** GET /admin/id-cards/cards/:id/pdf?layout=card|sheet — one card, saved by the office. */
exports.cardPdf = handle(async (req, res) => {
    const [card] = await cardsById(req.schoolId, [req.params.id]);
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    const yc = await rules.yearContext(req.schoolId);
    const effective = rules.effectiveStatus(card, yc);
    if (effective === 'active' || effective === 'generated') await service.markPrinted(ctxOf(req), [card._id], 'downloaded');
    renderIdCards(res, {
        cards: [{ ...card, effective }],
        layout: LAYOUTS.includes(req.query.layout) ? req.query.layout : 'card',
        sides: 'both',
        filename: pdfName(card),
    });
});

/* ── Templates ───────────────────────────────────────────────────────────── */

/** A sample holder for each kind's preview — a real one with a photo when the school has one. */
async function samples(schoolId) {
    const yc = await rules.yearContext(schoolId);
    const out = {};
    const pickRow = (rows) => rows.find((r) => r.isActive && data.photoExists(r.photoSource)) || rows.find((r) => r.isActive) || null;
    const [students, emps, parents] = await Promise.all([
        yc.current ? data.studentsOfYear(schoolId, yc.current._id) : [],
        data.employees(schoolId),
        data.parents(schoolId),
    ]);
    const st = pickRow(students);
    const te = pickRow(emps.filter((e) => e.kind === 'teacher'));
    const sf = pickRow(emps.filter((e) => e.kind === 'staff'));
    const pa = pickRow(parents.filter((p) => p.children.length)) || pickRow(parents);
    const asPhoto = (snap) => ({ ...snap, photo: snap.photoSource || '' });
    out.student = st ? asPhoto(data.snapshotOf('student', st, { year: yc.current })) : null;
    out.teacher = te ? asPhoto(data.snapshotOf('teacher', te)) : null;
    out.staff = sf ? asPhoto(data.snapshotOf('staff', sf)) : null;
    out.parent = pa ? asPhoto(data.snapshotOf('parent', pa, { parentId: 'PAR10001' })) : null;
    for (const k of Object.keys(out)) if (out[k]) delete out[k].photoSource;
    return out;
}

exports.templates = handle(async (req, res) => {
    const [templates, ident, sample, counts] = await Promise.all([
        design.templatesOf(req.schoolId),
        design.identityOf(req.schoolId),
        samples(req.schoolId),
        Promise.all(design.KINDS.map((k) => service.liveCount(req.schoolId, k))),
    ]);
    const yc = await rules.yearContext(req.schoolId);
    ok(res, {
        catalogue: design.catalogue(),
        templates,
        identity: ident.identity,
        signatory: ident.signatory,
        samples: sample,
        year: yc.current ? { yearName: yc.current.yearName, startDate: yc.current.startDate, endDate: yc.current.endDate } : null,
        liveCounts: Object.fromEntries(design.KINDS.map((k, i) => [k, counts[i]])),
        sampleQr: await views.qrSvg('SAMPLE0000'),
    });
});

exports.saveTemplate = handle(async (req, res) => {
    const { kind } = req.params;
    if (!design.KINDS.includes(kind)) return res.status(404).json({ success: false, message: 'Unknown card type' });
    const err = design.designError(kind, req.body?.design);
    if (err) return res.status(400).json({ success: false, message: err });
    const saved = await design.saveTemplate(req.schoolId, kind, req.body.design, req.userId);
    await service.log(ctxOf(req), { kind }, 'template_saved');
    ok(res, { design: saved, liveCount: await service.liveCount(req.schoolId, kind) }, { message: `${design.KIND_LABEL[kind]} card design saved` });
});

exports.applyTemplate = handle(async (req, res) => {
    const n = await service.applyDesign(ctxOf(req), req.params.kind);
    ok(res, { count: n }, { message: n ? `${n} card${n === 1 ? '' : 's'} in use now carry the new design` : 'No cards in use to update' });
});

/* ── Settings ────────────────────────────────────────────────────────────── */

async function settingsPayload(schoolId) {
    const [s, ident, counts] = await Promise.all([
        design.settingsOf(schoolId),
        design.identityOf(schoolId),
        Promise.all(design.KINDS.map((k) => service.liveCount(schoolId, k))),
    ]);
    const School = require('../models/School');
    const school = await School.findById(schoolId).select('name email phone address city state website logo').lean();
    return {
        settings: {
            displayName: s.displayName || '', tagline: s.tagline || '', logo: s.logo || '',
            address: s.address || '', phone: s.phone || '', email: s.email || '', website: s.website || '',
            signatoryName: s.signatoryName || '', signatoryTitle: s.signatoryTitle || 'Principal', signature: s.signature || '',
            requirePhoto: s.requirePhoto, verifyShowPhoto: s.verifyShowPhoto, notifyOnIssue: s.notifyOnIssue,
            updatedAt: s.updatedAt || null,
        },
        // What an empty field falls back to — shown as the placeholder.
        school: {
            name: school?.name || '', logo: design.logoPath(school?.logo),
            address: [school?.address, school?.city, school?.state].filter(Boolean).join(', '),
            phone: school?.phone || '', email: school?.email || '', website: school?.website || '',
        },
        identity: ident.identity,
        signatory: ident.signatory,
        liveCount: counts.reduce((a, b) => a + b, 0),
    };
}

exports.settings = handle(async (req, res) => ok(res, await settingsPayload(req.schoolId)));

exports.saveSettings = handle(async (req, res) => {
    const err = design.settingsError(req.body || {});
    if (err) return res.status(400).json({ success: false, message: err });
    await design.saveSettings(req.schoolId, req.body, req.userId);
    await service.log(ctxOf(req), null, 'settings_saved');
    ok(res, await settingsPayload(req.schoolId), { message: 'ID card settings saved' });
});

/** POST /admin/id-cards/settings/:image (logo | signature), multipart field `file`. */
exports.uploadImage = handle(async (req, res) => {
    const { image } = req.params;
    if (!['logo', 'signature'].includes(image)) return res.status(404).json({ success: false, message: 'Unknown image' });
    if (!req.file) return res.status(400).json({ success: false, message: 'Choose an image to upload' });
    // It is printed on every card: the PDF can only embed PNG and JPEG, so
    // nothing else is kept (an SVG would also be served as a live document).
    const head = await require('fs').promises.readFile(req.file.path).then((b) => b.subarray(0, 4)).catch(() => Buffer.alloc(0));
    const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const jpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    if (!png && !jpg) {
        await require('fs').promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ success: false, message: 'Use a PNG or JPEG image — it has to print on the cards' });
    }
    await design.setImage(req.schoolId, image, `/uploads/images/${req.file.filename}`, req.userId);
    await service.log(ctxOf(req), null, 'settings_saved', `${image} uploaded`);
    ok(res, await settingsPayload(req.schoolId), { message: image === 'logo' ? 'Card logo uploaded' : 'Signature uploaded' });
});

exports.removeImage = handle(async (req, res) => {
    const { image } = req.params;
    if (!['logo', 'signature'].includes(image)) return res.status(404).json({ success: false, message: 'Unknown image' });
    await design.setImage(req.schoolId, image, '', req.userId);
    ok(res, await settingsPayload(req.schoolId), { message: image === 'logo' ? 'Card logo removed — the school logo is used' : 'Signature removed' });
});

/** Apply the settings' identity (name, logo, signatory) to every card in use, all kinds. */
exports.applySettings = handle(async (req, res) => {
    let n = 0;
    for (const k of design.KINDS) n += await service.applyDesign(ctxOf(req), k);
    ok(res, { count: n }, { message: n ? `${n} card${n === 1 ? '' : 's'} in use updated` : 'No cards in use to update' });
});
