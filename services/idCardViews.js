'use strict';
/**
 * How an ID card is handed to a screen, and the reads that are not the
 * office's (Oct 2026):
 *
 *   cardView      one card as every client draws it — the frozen snapshot and
 *                 design, the status as it stands today, the QR inline
 *   holderCards   a holder's own cards: the one in force first, then history
 *   familyCards   a parent's own card and every child's, at every school the
 *                 person is a parent at
 *   verify        what a QR scan proves — public, and only what the card prints
 *   lookup        the same answer at the office's verification desk
 */
const QRCode = require('qrcode');
const pool = require('../db/pool');
const School = require('../models/School');
const User = require('../models/User');
const IdCard = require('../models/IdCard');
const design = require('./idCardDesign');
const rules = require('./idCardRules');
const { childrenAcrossSchools } = require('./parentChildren');
const schoolClock = require('./schoolClock');

const CARDS = `"${IdCard.tableName}"`;
const FRONTEND = () => String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
const verifyUrl = (code) => `${FRONTEND()}/verify/id/${code}`;

const qrCache = new Map();
/** The QR as SVG markup — small enough to send with the card, so it draws offline too. */
async function qrSvg(code) {
    if (qrCache.has(code)) return qrCache.get(code);
    const svg = await QRCode.toString(verifyUrl(code), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    if (qrCache.size > 2000) qrCache.clear();
    qrCache.set(code, svg);
    return svg;
}

/** Sort key: the card in force first, then newest year, then newest issue. */
const RANK = { active: 0, blocked: 1, generated: 2, expired: 3, reissued: 4, lost: 4, damaged: 4, cancelled: 5 };

/**
 * One card, ready to draw. `photoSource` (where the holder's photo came from)
 * stays on the server; `snapshot.photo` is the card's own copy.
 */
async function cardView(card, yc, { qr = true } = {}) {
    const status = rules.effectiveStatus(card, yc);
    const year = card.kind === 'student' ? yc?.byId?.get(String(card.academicYear || '')) : null;
    const { photoSource, ...snapshot } = card.snapshot || {};
    return {
        _id: String(card._id),
        kind: card.kind,
        holder: String(card.holder),
        number: card.number,
        code: card.code,
        status,
        stored: card.status,
        statusLabel: rules.STATUS_LABEL[status] || status,
        statusReason: card.statusReason || '',
        statusAt: card.statusAt || null,
        academicYear: card.kind === 'student'
            ? { _id: card.academicYear ? String(card.academicYear) : null, yearName: year?.yearName || snapshot.yearName || '', phase: year?.phase || 'past' }
            : null,
        reissueNo: Number(card.reissueNo) || 0,
        reissueReason: card.reissueReason || '',
        replaces: card.replaces ? String(card.replaces) : null,
        replacedBy: card.replacedBy ? String(card.replacedBy) : null,
        issuedAt: card.issuedAt,
        validFrom: card.validFrom || null,
        validUntil: card.validUntil || null,
        refreshedAt: card.refreshedAt || null,
        printedAt: card.printedAt || null,
        printCount: Number(card.printCount) || 0,
        verifiedAt: card.verifiedAt || null,
        verifyCount: Number(card.verifyCount) || 0,
        inForce: status === 'active',
        snapshot,
        design: design.cardDesign(card.kind, card.design),
        verifyUrl: verifyUrl(card.code),
        qrSvg: qr ? await qrSvg(card.code) : null,
    };
}

function sortViews(views) {
    return views.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)
        || String(b.snapshot?.yearStart || '').localeCompare(String(a.snapshot?.yearStart || ''))
        || new Date(b.issuedAt) - new Date(a.issuedAt));
}

/**
 * A holder's own cards, newest first, and which of them is the one to show:
 *   current   the card in force (or blocked — still theirs, and they should see why)
 *   upcoming  a student card issued ahead for next year
 *   pending   a student in the current year with no card for it yet
 */
async function holderCards(schoolId, holderId, kinds) {
    const yc = await rules.yearContext(schoolId);
    const { rows } = await pool.query(`
        SELECT * FROM ${CARDS} WHERE "school" = $1::uuid AND "holder" = $2::uuid AND "kind" = ANY($3::text[])
         ORDER BY "issuedAt" DESC`, [String(schoolId), String(holderId), kinds]);
    const views = sortViews(await Promise.all(rows.map((c) => cardView(c, yc))));
    const current = views.find((v) => v.status === 'active' || v.status === 'blocked') || null;
    const upcoming = views.find((v) => v.status === 'generated') || null;
    let pending = null;
    if (kinds.includes('student') && yc.current && !(current && current.academicYear?._id === yc.current._id)) {
        const inYear = await require('./idCardData').studentsOfYear(schoolId, yc.current._id, { holderIds: [holderId] });
        if (inYear.length) pending = { yearName: yc.current.yearName };
    }
    return { current, upcoming, pending, cards: views };
}

/** A school as a card's reader sees it named. */
async function schoolBrief(schoolId) {
    const s = await School.findById(schoolId).select('name city state logo modules').lean();
    return s ? { _id: String(s._id), name: s.name, place: [s.city, s.state].filter(Boolean).join(', '), logo: design.logoPath(s.logo), idCardOn: !!s.modules?.idCard } : null;
}

/**
 * Everything a parent sees: their own card at this school, and each child's
 * cards at whichever school the child is at (a parent can hold posts at more
 * than one — services/parentChildren.childrenAcrossSchools decides which).
 * A child whose school has the module switched off is listed with that said.
 */
async function familyCards(schoolId, parentUserId) {
    const [mine, kids] = await Promise.all([
        holderCards(schoolId, parentUserId, ['parent']),
        childrenAcrossSchools(parentUserId, schoolId),
    ]);
    const children = [];
    for (const k of kids) {
        const on = !!k.modules?.idCard;
        const cards = on ? await holderCards(k.schoolId, k._id, ['student']) : { current: null, upcoming: null, pending: null, cards: [] };
        const photo = await User.findById(k._id).select('profileImage').lean();
        children.push({
            _id: k._id, name: k.name, className: k.className, sectionName: k.sectionName,
            photo: photo?.profileImage || '',
            schoolId: k.schoolId, schoolName: k.schoolName,
            otherSchool: String(k.schoolId) !== String(schoolId),
            idCardOn: on,
            ...cards,
        });
    }
    return { mine, children };
}

/* ── Verification ────────────────────────────────────────────────────────── */

const VERDICT = {
    active:    { valid: true,  title: 'Valid ID card',        message: 'This card is in force.' },
    generated: { valid: false, title: 'Not yet in force',     message: 'This card was issued for an academic year that has not begun.' },
    expired:   { valid: false, title: 'Expired',              message: 'This card was for an academic year that is over.' },
    blocked:   { valid: false, title: 'Blocked',              message: 'The school has blocked this card. It is not valid while blocked.' },
    lost:      { valid: false, title: 'Reported lost',        message: 'This card was reported lost and is no longer valid.' },
    damaged:   { valid: false, title: 'Replaced (damaged)',   message: 'This card was reported damaged and has been taken out of use.' },
    reissued:  { valid: false, title: 'Replaced',             message: 'A newer card has been issued in place of this one. This card is no longer valid.' },
    cancelled: { valid: false, title: 'Cancelled',            message: 'The school has cancelled this card.' },
    inactive:  { valid: false, title: 'No longer valid',      message: 'The holder of this card is no longer at the school.' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const spell = (k) => {
    if (!k) return '';
    const [y, m, day] = k.split('-').map(Number);
    return `${String(day).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
};
/** A stored day (UTC midnight of the day meant) — a year's last day. */
const fmtDay = (d) => spell(rules.dayKey(d));
/** An instant — when a card was issued or blocked — as the day it was at the school. */
const fmtAt = (d, schoolId) => {
    const x = d ? new Date(d) : null;
    if (!x || Number.isNaN(x.getTime())) return '';
    return spell(new Intl.DateTimeFormat('en-CA', { timeZone: schoolClock.zoneOf(schoolId), year: 'numeric', month: '2-digit', day: '2-digit' }).format(x));
};

/**
 * The lines a verification shows — the identity the card prints, never what
 * it holds for whoever found it (date of birth, blood group, phone, address).
 */
function publicLines(card) {
    const s = card.snapshot || {};
    if (card.kind === 'student') {
        return [
            ['Student', s.name],
            ['Class', [s.className, s.sectionName].filter(Boolean).join(' – ')],
            ['Academic Year', s.yearName],
            ...(s.holderCode ? [['Admission No.', s.holderCode]] : []),
        ];
    }
    if (card.kind === 'parent') {
        return [
            ['Parent', s.name],
            ...(s.holderCode ? [['Parent ID', s.holderCode]] : []),
            ...(s.relationship ? [['Relationship', s.relationship]] : []),
            ...((s.children || []).length ? [['Parent of', s.children.map((c) => c.name).join(', ')]] : []),
        ];
    }
    return [
        [card.kind === 'teacher' ? 'Teacher' : 'Staff', s.name],
        ...(s.holderCode ? [['Employee ID', s.holderCode]] : []),
        ...(s.designation ? [['Designation', s.designation]] : []),
    ];
}

async function verdictOf(card) {
    const yc = await rules.yearContext(card.school);
    let state = rules.effectiveStatus(card, yc);
    const holder = await User.findById(card.holder).select('isActive').lean();
    if (state === 'active' && (!holder || holder.isActive === false)) state = 'inactive';
    return { state, yc, ...VERDICT[state] };
}

/**
 * GET /public/id-card/:code — what a scanned QR proves. No sign-in: the guard
 * at a gate, a bus conductor, a shopkeeper who found the card.
 */
async function verify(code, { record = true } = {}) {
    const c = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(c)) rules.fail(404, 'No ID card has this code');
    const card = await IdCard.findOne({ code: c }).lean();
    if (!card) rules.fail(404, 'No ID card has this code');
    const [v, school, settings] = await Promise.all([verdictOf(card), schoolBrief(card.school), design.settingsOf(card.school)]);
    if (record) recordScan(card, 'scanned').catch(() => {});
    const year = card.kind === 'student' ? v.yc.byId.get(String(card.academicYear)) : null;
    return {
        code: c,
        valid: v.valid,
        state: v.state,
        title: v.title,
        message: v.message,
        statusSince: card.statusAt && card.status !== 'active' ? fmtAt(card.statusAt, card.school) : '',
        kind: card.kind,
        kindLabel: rules.KIND_TITLE[card.kind],
        name: card.snapshot?.name || '',
        photo: settings.verifyShowPhoto ? (card.snapshot?.photo || '') : '',
        lines: publicLines(card).filter(([, value]) => value),
        number: card.number,
        issuedOn: fmtAt(card.issuedAt, card.school),
        validTill: card.kind === 'student' ? fmtDay(card.validUntil || year?.endDate) : '',
        duplicate: Number(card.reissueNo) || 0,
        school: school ? { name: card.design?.identity?.name || school.name, place: school.place, logo: card.design?.identity?.logo || school.logo } : null,
        checkedAt: new Date(),
    };
}

/**
 * A scan, on the card. The count always moves; the timeline gets a row at
 * most once in ten minutes per card, so a guard re-scanning at the gate does
 * not bury what the office did.
 */
async function recordScan(card, action, ctx = null) {
    const quiet = card.verifiedAt && Date.now() - new Date(card.verifiedAt).getTime() < 10 * 60 * 1000;
    await pool.query(`UPDATE ${CARDS} SET "verifiedAt" = now(), "verifyCount" = COALESCE("verifyCount", 0) + 1 WHERE "_id" = $1::uuid`, [String(card._id)]);
    if (quiet && action === 'scanned') return;
    await require('./idCardService').log(ctx || { schoolId: card.school }, card, action);
}

/**
 * The office's verification desk: a scanned link, a code, or a card number
 * typed off the card. Only this school's cards.
 */
async function lookup(ctx, q) {
    const raw = String(q || '').trim();
    if (!raw) rules.fail(400, 'Scan a card or type its number');
    const fromUrl = raw.match(/\/verify\/id\/([A-Za-z0-9]{6,20})/);
    const token = (fromUrl ? fromUrl[1] : raw).toUpperCase().replace(/\s+/g, '');
    const card = await IdCard.findOne({
        school: ctx.schoolId,
        $or: [{ code: token }, { number: token }],
    }).lean();
    if (!card) rules.fail(404, fromUrl ? 'That QR code is not a card of this school' : `No card of this school has the number or code "${raw}"`);
    const result = await verify(card.code, { record: false });
    await recordScan(card, 'verified', ctx).catch(() => {});
    const yc = await rules.yearContext(ctx.schoolId);
    return { result, card: await cardView(card, yc) };
}

module.exports = { cardView, sortViews, holderCards, familyCards, verify, lookup, qrSvg, verifyUrl, schoolBrief, fmtDay, fmtAt, VERDICT };
