'use strict';
/**
 * How ID cards look, and what they say about the school (Oct 2026).
 *
 * Two layers, both one row per school and both created on first read:
 *
 *   IdCardTemplate  per kind of card — layout, colours, photo shape, where the
 *                   QR goes, which optional fields print, the note on the back.
 *   IdCardSettings  per school — the name, tagline, logo and contact lines
 *                   every card prints, the signatory, and the module's rules.
 *
 * A card copies both when it is issued (`composeDesign`), so it is drawn the
 * same way forever after — on screen (web IdCardFace), in the PDF
 * (utils/idCardPdf) and on the phone — whatever the school edits later.
 *
 * Everything an office can send is validated here: unknown keys are dropped,
 * colours must be #rrggbb, and only the fields a kind has can be switched.
 */
const School = require('../models/School');
const IdCardTemplate = require('../models/IdCardTemplate');
const IdCardSettings = require('../models/IdCardSettings');

const KINDS = ['student', 'teacher', 'staff', 'parent'];
const KIND_LABEL = { student: 'Student', teacher: 'Teacher', staff: 'Staff', parent: 'Parent' };

/**
 * The optional fields of each kind, in the order they print. `side` is where a
 * field goes — the front carries what identifies, the back what helps someone
 * who found the card. What is always printed (name, photo, class and section,
 * designation, relationship, academic year, card number, QR) is not listed:
 * it cannot be switched off.
 */
const FIELDS = {
    student: [
        { key: 'admissionNo',    label: 'Admission No.',     side: 'front', on: true },
        { key: 'rollNo',         label: 'Roll No.',          side: 'front', on: true },
        { key: 'dob',            label: 'Date of Birth',     side: 'front', on: true },
        { key: 'bloodGroup',     label: 'Blood Group',       side: 'front', on: true },
        { key: 'parentName',     label: "Parent's Name",     side: 'back',  on: false },
        { key: 'emergencyPhone', label: 'Emergency Contact', side: 'back',  on: false },
        { key: 'address',        label: 'Home Address',      side: 'back',  on: false },
    ],
    teacher: [
        { key: 'employeeId',     label: 'Employee ID',       side: 'front', on: true },
        { key: 'department',     label: 'Department',        side: 'front', on: true },
        { key: 'bloodGroup',     label: 'Blood Group',       side: 'front', on: true },
        { key: 'dob',            label: 'Date of Birth',     side: 'front', on: false },
        { key: 'joiningDate',    label: 'Joined',            side: 'front', on: false },
        { key: 'phone',          label: 'Phone',             side: 'back',  on: false },
        { key: 'emergencyPhone', label: 'Emergency Contact', side: 'back',  on: false },
    ],
    parent: [
        { key: 'parentId',       label: 'Parent ID',         side: 'front', on: true },
        { key: 'children',       label: 'Children',          side: 'front', on: true },
        { key: 'phone',          label: 'Phone',             side: 'front', on: true },
    ],
};
FIELDS.staff = FIELDS.teacher;

/** School colours an office picks from; a custom #rrggbb is accepted too. */
const PRIMARY_PRESETS = [
    { key: 'navy',     label: 'Navy',     hex: '#1b2a5e' },
    { key: 'royal',    label: 'Royal',    hex: '#1e3a8a' },
    { key: 'maroon',   label: 'Maroon',   hex: '#6b1d2a' },
    { key: 'forest',   label: 'Forest',   hex: '#14432f' },
    { key: 'teal',     label: 'Teal',     hex: '#0f4c5c' },
    { key: 'plum',     label: 'Plum',     hex: '#3f1d5c' },
    { key: 'charcoal', label: 'Charcoal', hex: '#262b36' },
];
/** The colour that says which kind of card it is — the ribbon and the stripe. */
const ACCENT_PRESETS = [
    { key: 'blue',    label: 'Blue',    hex: '#2563eb' },
    { key: 'emerald', label: 'Emerald', hex: '#059669' },
    { key: 'amber',   label: 'Amber',   hex: '#d97706' },
    { key: 'violet',  label: 'Violet',  hex: '#7c3aed' },
    { key: 'rose',    label: 'Rose',    hex: '#e11d48' },
    { key: 'gold',    label: 'Gold',    hex: '#c99a2e' },
    { key: 'cyan',    label: 'Cyan',    hex: '#0891b2' },
];
const DEFAULT_ACCENT = { student: '#2563eb', teacher: '#059669', staff: '#d97706', parent: '#7c3aed' };

const LAYOUTS = ['portrait', 'landscape'];
const PHOTO_SHAPES = ['rounded', 'circle'];
const QR_SIDES = ['back', 'front'];
const PATTERNS = ['guilloche', 'waves', 'plain'];
const NOTE_MAX = 240;

const defaultNote = (kind) => (kind === 'parent'
    ? 'This card identifies a parent of a student of {school}. Please show it when you visit or collect your child. It is not transferable.'
    : 'This card is the property of {school}. It is not transferable. If found, please return it to the school office.');

function defaultDesign(kind) {
    const fields = {};
    for (const f of FIELDS[kind] || []) fields[f.key] = f.on;
    return {
        layout: 'portrait',
        primary: PRIMARY_PRESETS[0].hex,
        accent: DEFAULT_ACCENT[kind] || ACCENT_PRESETS[0].hex,
        pattern: 'guilloche',
        photoShape: 'rounded',
        qrOn: 'back',
        showLogo: true,
        showSignature: true,
        showValidity: true,
        showReturnAddress: true,
        backNote: defaultNote(kind),
        fields,
    };
}

const HEX = /^#[0-9a-f]{6}$/i;
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

/**
 * A complete, valid design for `kind` from whatever was stored or sent: every
 * key present, every value one the renderers understand. Never throws — a bad
 * value falls back to the default — so an old row can always be drawn.
 */
function normalizeDesign(kind, raw) {
    const base = defaultDesign(kind);
    const d = raw && typeof raw === 'object' ? raw : {};
    const fields = { ...base.fields };
    for (const f of FIELDS[kind] || []) {
        if (typeof d.fields?.[f.key] === 'boolean') fields[f.key] = d.fields[f.key];
    }
    return {
        layout: pick(d.layout, LAYOUTS, base.layout),
        primary: HEX.test(String(d.primary || '')) ? String(d.primary).toLowerCase() : base.primary,
        accent: HEX.test(String(d.accent || '')) ? String(d.accent).toLowerCase() : base.accent,
        pattern: pick(d.pattern, PATTERNS, base.pattern),
        photoShape: pick(d.photoShape, PHOTO_SHAPES, base.photoShape),
        qrOn: pick(d.qrOn, QR_SIDES, base.qrOn),
        showLogo: bool(d.showLogo, base.showLogo),
        showSignature: bool(d.showSignature, base.showSignature),
        showValidity: bool(d.showValidity, base.showValidity),
        showReturnAddress: bool(d.showReturnAddress, base.showReturnAddress),
        backNote: typeof d.backNote === 'string' ? d.backNote.trim().slice(0, NOTE_MAX) : base.backNote,
        fields,
    };
}

/**
 * What an office sent, checked strictly: unlike normalizeDesign, a value that
 * is present but wrong is an error to show, not something to quietly replace.
 * Returns the first problem, or '' when the design is acceptable.
 */
function designError(kind, d) {
    if (!d || typeof d !== 'object') return 'Send the design to save';
    if (d.layout !== undefined && !LAYOUTS.includes(d.layout)) return 'Layout must be portrait or landscape';
    if (d.primary !== undefined && !HEX.test(String(d.primary))) return 'The school colour must be a colour like #1b2a5e';
    if (d.accent !== undefined && !HEX.test(String(d.accent))) return 'The card colour must be a colour like #2563eb';
    if (d.pattern !== undefined && !PATTERNS.includes(d.pattern)) return 'Unknown background pattern';
    if (d.photoShape !== undefined && !PHOTO_SHAPES.includes(d.photoShape)) return 'Photo shape must be rounded or circle';
    if (d.qrOn !== undefined && !QR_SIDES.includes(d.qrOn)) return 'The QR code goes on the front or the back';
    if (d.backNote !== undefined && String(d.backNote).length > NOTE_MAX) return `The note on the back can be at most ${NOTE_MAX} characters`;
    if (d.fields !== undefined) {
        if (typeof d.fields !== 'object' || Array.isArray(d.fields)) return 'Fields must be a list of switches';
        const known = new Set((FIELDS[kind] || []).map((f) => f.key));
        for (const [k, v] of Object.entries(d.fields)) {
            if (!known.has(k)) return `A ${KIND_LABEL[kind].toLowerCase()} card has no "${k}" field`;
            if (typeof v !== 'boolean') return 'Each field is on or off';
        }
    }
    return '';
}

/* ── Rows ─────────────────────────────────────────────────────────────────── */

/** Every kind's template, created with the defaults the first time it is asked for. */
async function templatesOf(schoolId) {
    const rows = await IdCardTemplate.find({ school: schoolId }).lean();
    const out = {};
    for (const kind of KINDS) {
        const row = rows.find((r) => r.kind === kind);
        out[kind] = {
            kind,
            design: normalizeDesign(kind, row?.design),
            updatedAt: row?.updatedAt || null,
            customised: !!row,
        };
    }
    return out;
}

async function templateOf(schoolId, kind) {
    const row = await IdCardTemplate.findOne({ school: schoolId, kind }).lean();
    return normalizeDesign(kind, row?.design);
}

async function saveTemplate(schoolId, kind, design, userId) {
    const clean = normalizeDesign(kind, design);
    const now = new Date();
    const existing = await IdCardTemplate.findOne({ school: schoolId, kind }).select('_id').lean();
    if (existing) {
        await IdCardTemplate.updateOne({ _id: existing._id }, { $set: { design: clean, updatedBy: userId || null, updatedAt: now } });
    } else {
        try {
            await IdCardTemplate.create({ school: schoolId, kind, design: clean, updatedBy: userId || null, updatedAt: now });
        } catch (e) {
            // Two saves of a brand-new template at once: the other one made the row.
            if (e.code !== 11000 && e.code !== '23505') throw e;
            await IdCardTemplate.updateOne({ school: schoolId, kind }, { $set: { design: clean, updatedBy: userId || null, updatedAt: now } });
        }
    }
    return clean;
}

const SETTINGS_FIELDS = ['displayName', 'tagline', 'address', 'phone', 'email', 'website', 'signatoryName', 'signatoryTitle'];
const RULE_FIELDS = ['requirePhoto', 'verifyShowPhoto', 'notifyOnIssue'];
const TEXT_MAX = { displayName: 90, tagline: 120, address: 200, phone: 40, email: 120, website: 120, signatoryName: 80, signatoryTitle: 60 };

/** The settings row, made on first read. */
async function settingsOf(schoolId) {
    let row = await IdCardSettings.findOne({ school: schoolId }).lean();
    if (!row) {
        try {
            row = (await IdCardSettings.create({ school: schoolId })).toObject();
        } catch (e) {
            if (e.code !== 11000 && e.code !== '23505') throw e;
            row = await IdCardSettings.findOne({ school: schoolId }).lean();
        }
    }
    return {
        ...row,
        signatoryTitle: row.signatoryTitle || 'Principal',
        requirePhoto: row.requirePhoto === true,
        verifyShowPhoto: row.verifyShowPhoto !== false,
        notifyOnIssue: row.notifyOnIssue !== false,
    };
}

/** First problem with a settings save, or ''. */
function settingsError(body) {
    for (const k of SETTINGS_FIELDS) {
        if (body[k] === undefined) continue;
        if (typeof body[k] !== 'string') return 'Settings must be text';
        if (body[k].trim().length > TEXT_MAX[k]) return `That is too long — keep it under ${TEXT_MAX[k]} characters`;
    }
    if (body.email && body.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) return 'That email address does not look right';
    for (const k of RULE_FIELDS) if (body[k] !== undefined && typeof body[k] !== 'boolean') return 'Each rule is on or off';
    return '';
}

async function saveSettings(schoolId, body, userId) {
    await settingsOf(schoolId);
    const $set = { updatedBy: userId || null, updatedAt: new Date() };
    for (const k of SETTINGS_FIELDS) if (typeof body[k] === 'string') $set[k] = body[k].trim();
    for (const k of RULE_FIELDS) if (typeof body[k] === 'boolean') $set[k] = body[k];
    if (body.logo === '') $set.logo = '';
    if (body.signature === '') $set.signature = '';
    await IdCardSettings.updateOne({ school: schoolId }, { $set });
    return settingsOf(schoolId);
}

async function setImage(schoolId, field, path, userId) {
    if (!['logo', 'signature'].includes(field)) throw new Error('Unknown image');
    await settingsOf(schoolId);
    await IdCardSettings.updateOne({ school: schoolId }, { $set: { [field]: path, updatedBy: userId || null, updatedAt: new Date() } });
    return settingsOf(schoolId);
}

/* ── What a card prints about the school ─────────────────────────────────── */

/** "/uploads/images/x.png" for either way a school logo is stored. */
const logoPath = (logo) => {
    const l = String(logo || '').trim();
    if (!l) return '';
    if (/^https?:\/\//.test(l) || l.startsWith('/uploads')) return l;
    return `/uploads/images/${l.replace(/^\/+/, '')}`;
};

/**
 * The school as its cards print it: each line the office set in Settings, else
 * the school's own record. The address folds the school's city and state in.
 */
async function identityOf(schoolId, settings = null) {
    const [school, s] = await Promise.all([
        School.findById(schoolId).select('name email phone address city state website logo board boardName').lean(),
        settings ? Promise.resolve(settings) : settingsOf(schoolId),
    ]);
    const place = [school?.address, school?.city, school?.state].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
    return {
        identity: {
            name: s.displayName || school?.name || 'School',
            tagline: s.tagline || '',
            logo: logoPath(s.logo) || logoPath(school?.logo),
            address: s.address || place,
            phone: s.phone || school?.phone || '',
            email: s.email || school?.email || '',
            website: s.website || school?.website || '',
        },
        signatory: {
            name: s.signatoryName || '',
            title: s.signatoryTitle || 'Principal',
            signature: s.signature || '',
        },
        settings: s,
    };
}

/** The design a card is issued with: its template, plus the school as it prints. */
function composeDesign(kind, template, ident) {
    const t = normalizeDesign(kind, template);
    return {
        ...t,
        backNote: String(t.backNote || '').replace(/\{school\}/g, ident.identity.name),
        identity: { ...ident.identity },
        signatory: { ...ident.signatory },
    };
}

/** A stored card design made safe to draw (cards issued before a key existed). */
function cardDesign(kind, stored) {
    const d = stored && typeof stored === 'object' ? stored : {};
    return {
        ...normalizeDesign(kind, d),
        backNote: typeof d.backNote === 'string' ? d.backNote : '',
        identity: { name: '', tagline: '', logo: '', address: '', phone: '', email: '', website: '', ...(d.identity || {}) },
        signatory: { name: '', title: 'Principal', signature: '', ...(d.signatory || {}) },
    };
}

/** The catalogue the template editor draws its switches and swatches from. */
function catalogue() {
    return {
        kinds: KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] })),
        fields: FIELDS,
        primaryPresets: PRIMARY_PRESETS,
        accentPresets: ACCENT_PRESETS,
        layouts: LAYOUTS,
        photoShapes: PHOTO_SHAPES,
        qrSides: QR_SIDES,
        patterns: PATTERNS,
        noteMax: NOTE_MAX,
        defaults: Object.fromEntries(KINDS.map((k) => [k, defaultDesign(k)])),
    };
}

module.exports = {
    KINDS, KIND_LABEL, FIELDS, PRIMARY_PRESETS, ACCENT_PRESETS,
    defaultDesign, normalizeDesign, designError, cardDesign, composeDesign, catalogue,
    templatesOf, templateOf, saveTemplate,
    settingsOf, settingsError, saveSettings, setImage, identityOf, logoPath,
};
