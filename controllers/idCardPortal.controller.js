'use strict';
/**
 * ID cards as their holders see them (Oct 2026), and the public QR check.
 *
 *   student   GET /student/id-cards          my cards: the one in force, then every year's
 *             GET /student/id-cards/:id/pdf  one of them, to keep or print
 *   teacher   GET /teacher/id-cards          (teachers and every other employee)
 *             GET /teacher/id-cards/:id/pdf
 *   parent    GET /parent/id-cards           my card, and each child's cards
 *             GET /parent/id-cards/:id/pdf   mine, or one of my children's (at any of their schools)
 *   public    GET /public/id-card/:code      what a scanned QR proves
 *             GET /public/id-card/:code/qr.svg | qr.png
 */
const QRCode = require('qrcode');
const IdCard = require('../models/IdCard');
const views = require('../services/idCardViews');
const rules = require('../services/idCardRules');
const service = require('../services/idCardService');
const { childrenAcrossSchools } = require('../services/parentChildren');
const { renderIdCards, pdfName } = require('../utils/idCardPdf');

const handle = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (e) {
        if (e instanceof rules.RuleError) return res.status(e.status).json({ success: false, message: e.message });
        console.error('[id cards]', e);
        return res.status(500).json({ success: false, message: e.message || 'Something went wrong' });
    }
};

exports.studentCards = handle(async (req, res) => {
    res.json({ success: true, data: { ...await views.holderCards(req.schoolId, req.userId, ['student']), school: await views.schoolBrief(req.schoolId) } });
});

exports.teacherCards = handle(async (req, res) => {
    res.json({ success: true, data: { ...await views.holderCards(req.schoolId, req.userId, ['teacher', 'staff']), school: await views.schoolBrief(req.schoolId) } });
});

exports.parentCards = handle(async (req, res) => {
    res.json({ success: true, data: { ...await views.familyCards(req.schoolId, req.userId), school: await views.schoolBrief(req.schoolId) } });
});

/** The PDF of a card this person may hold: their own, or (a parent) a child's. */
async function sendPdf(req, res, allowed) {
    const card = await IdCard.findById(req.params.id).lean();
    if (!card || !(await allowed(card))) return res.status(404).json({ success: false, message: 'Card not found' });
    const yc = await rules.yearContext(card.school);
    await service.noteDownload({ schoolId: card.school, userId: req.userId, userRole: req.userRole }, card).catch(() => {});
    return renderIdCards(res, {
        cards: [{ ...card, effective: rules.effectiveStatus(card, yc) }],
        layout: req.query.layout === 'sheet' ? 'sheet' : 'card',
        sides: 'both',
        filename: pdfName(card),
    });
}

const own = (req) => async (card) => String(card.holder) === String(req.userId) && String(card.school) === String(req.schoolId);

exports.studentPdf = handle(async (req, res) => sendPdf(req, res, async (c) => c.kind === 'student' && own(req)(c)));
exports.teacherPdf = handle(async (req, res) => sendPdf(req, res, async (c) => (c.kind === 'teacher' || c.kind === 'staff') && own(req)(c)));
exports.parentPdf = handle(async (req, res) => sendPdf(req, res, async (c) => {
    if (c.kind === 'parent') return own(req)(c);
    if (c.kind !== 'student') return false;
    const kids = await childrenAcrossSchools(req.userId, req.schoolId);
    return kids.some((k) => String(k._id) === String(c.holder) && String(k.schoolId) === String(c.school) && k.modules?.idCard);
}));

/* ── Public ──────────────────────────────────────────────────────────────── */

exports.verify = handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await views.verify(req.params.code) });
});

/** The QR as an image, for a card on screen — only for a code that exists. */
async function qrImage(req, res, type) {
    try {
        const code = String(req.params.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{6,20}$/.test(code)) return res.status(404).end();
        if (!(await IdCard.findOne({ code }).select('_id').lean())) return res.status(404).end();
        res.set('Cache-Control', 'public, max-age=86400');
        if (type === 'png') {
            res.set('Content-Type', 'image/png');
            return res.send(await QRCode.toBuffer(views.verifyUrl(code), { type: 'png', margin: 1, scale: 8, errorCorrectionLevel: 'M' }));
        }
        res.set('Content-Type', 'image/svg+xml');
        return res.send(await views.qrSvg(code));
    } catch (e) {
        console.error('[id card] QR failed:', e.message);
        return res.status(500).end();
    }
}
exports.qrSvg = (req, res) => qrImage(req, res, 'svg');
exports.qrPng = (req, res) => qrImage(req, res, 'png');
