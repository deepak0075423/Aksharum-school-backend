'use strict';
/**
 * ID cards as PDF (Oct 2026) — the file every "Download" and "Print" in the
 * module hands over.
 *
 * Drawn at true size: a CR80 card, 85.60 × 53.98 mm, the size of every PVC
 * card printer and every lanyard holder. Two page layouts:
 *
 *   card    one card face per page, the page the size of the card — what a
 *           PVC card printer takes, and what a holder downloads to keep
 *   sheet   A4, nine portrait cards (or ten landscape) per page, with crop
 *           marks; with both sides, every page of fronts is followed by its
 *           backs mirrored left-to-right, so a duplex print (long-edge flip)
 *           lands each back behind its own front
 *
 * The face is laid out in "u" — one hundredth of the card's width — exactly
 * as the screen draws it (school-frontend pages/idcards/IdCardFace.jsx), so a
 * downloaded card looks like the card on screen. Type is Plus Jakarta Sans,
 * embedded, as on screen. A card that is not in force (expired, blocked,
 * lost, replaced, cancelled) prints with a stamp across it saying so.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { cardDesign } = require('../services/idCardDesign');
const { uploadFile } = require('../services/idCardData');
const { zoneOf } = require('../services/schoolClock');

const MM = 72 / 25.4;
const CR80 = { long: 85.6, short: 53.98 };
const RADIUS_MM = 3.18;
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONTS = { R: 400, S: 600, B: 700, X: 800 };
const INK = '#0f172a';
const MUTED = '#64748b';
const SOFT = '#94a3b8';
const FRONTEND = () => String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');

const STAMP = {
    expired: 'EXPIRED', blocked: 'BLOCKED', lost: 'REPORTED LOST', damaged: 'DAMAGED',
    reissued: 'REPLACED', cancelled: 'CANCELLED', generated: '',
};
const KIND_TITLE = { student: 'STUDENT', teacher: 'TEACHER', staff: 'STAFF', parent: 'PARENT' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ── Small helpers ───────────────────────────────────────────────────────── */

const day = (d) => {
    if (!d) return '';
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return `${String(x.getUTCDate()).padStart(2, '0')} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};
const dob = (s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? day(`${s}T00:00:00Z`) : s || '');
/** An instant (when a card was issued) as the day it was at the school. */
const dayAt = (d, schoolId) => {
    const x = d ? new Date(d) : null;
    if (!x || Number.isNaN(x.getTime())) return '';
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: zoneOf(schoolId), year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
    return day(`${key}T00:00:00Z`);
};

function shade(hex, amount) {
    const n = parseInt(String(hex).slice(1), 16);
    const mix = (c) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
    const r = mix((n >> 16) & 255); const g = mix((n >> 8) & 255); const b = mix(n & 255);
    return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

/** A PNG or JPEG behind an /uploads path — pdfkit draws nothing else. */
function imageOf(cache, p) {
    if (!p) return null;
    if (cache.has(p)) return cache.get(p);
    let buf = null;
    try {
        const file = uploadFile(p);
        if (file && fs.existsSync(file)) {
            const b = fs.readFileSync(file);
            const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
            const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
            if (png || jpg) buf = b;
        }
    } catch { buf = null; }
    cache.set(p, buf);
    return buf;
}

/** The face's lengths, in points, for one orientation. */
function geometry(layout) {
    const portrait = layout !== 'landscape';
    const w = (portrait ? CR80.short : CR80.long) * MM;
    const h = (portrait ? CR80.long : CR80.short) * MM;
    return { portrait, w, h, u: w / 100, r: RADIUS_MM * MM };
}

/* ── Text ────────────────────────────────────────────────────────────────── */

function setFont(doc, f, size) { doc.font(f).fontSize(size); }

/** The largest size from `size` down to `min` at which `str` fits `width` on one line. */
function fitSize(doc, str, f, size, min, width, spacing = 0) {
    let s = size;
    setFont(doc, f, s);
    while (s > min && doc.widthOfString(str, { characterSpacing: spacing * s }) > width) {
        s -= 0.2;
        setFont(doc, f, s);
    }
    return s;
}

/** `str` cut to fit `width`, with an ellipsis when cut. Font must be set. */
function clip(doc, str, width, spacing = 0) {
    const s = String(str || '');
    if (doc.widthOfString(s, { characterSpacing: spacing }) <= width) return s;
    let lo = 0; let hi = s.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (doc.widthOfString(`${s.slice(0, mid).trimEnd()}…`, { characterSpacing: spacing }) <= width) lo = mid; else hi = mid - 1;
    }
    return `${s.slice(0, lo).trimEnd()}…`;
}

/** Words into at most `max` lines of `width`; the last one ellipsised if it overflows. */
function wrap(doc, str, width, max, spacing = 0) {
    const words = String(str || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (let i = 0; i < words.length; i += 1) {
        const next = line ? `${line} ${words[i]}` : words[i];
        if (doc.widthOfString(next, { characterSpacing: spacing }) <= width || !line) {
            line = next;
        } else {
            lines.push(line);
            line = words[i];
            if (lines.length === max - 1) {
                line = words.slice(i).join(' ');
                break;
            }
        }
    }
    if (line) lines.push(line);
    return lines.slice(0, max).map((l, i, all) => (i === all.length - 1 ? clip(doc, l, width, spacing) : l));
}

/** One line of text, its TOP at y. */
function put(doc, str, x, y, { f = 'R', size, color = INK, opacity = 1, width, align = 'left', spacing = 0 }) {
    setFont(doc, f, size);
    doc.fillColor(color, opacity);
    doc.text(String(str), x, y, { width, align, lineBreak: false, characterSpacing: spacing * size });
}

/* ── Shapes ──────────────────────────────────────────────────────────────── */

function gradientFill(doc, x1, y1, x2, y2, from, to) {
    const g = doc.linearGradient(x1, y1, x2, y2);
    g.stop(0, from).stop(1, to);
    return g;
}

/** Fine guilloche / wave lines over a band — the security print every ID card carries. */
function pattern(doc, kind, x, y, w, h, color, opacity, u) {
    if (kind === 'plain') return;
    doc.save();
    doc.rect(x, y, w, h).clip();
    doc.lineWidth(kind === 'waves' ? 0.6 * u : 0.16 * u).strokeColor(color).strokeOpacity(opacity);
    const rows = kind === 'waves' ? 5 : 14;
    const amp = kind === 'waves' ? h / 9 : h / 7;
    for (let i = 0; i < rows; i += 1) {
        const base = y + (h * (i + 0.5)) / rows;
        const phase = (i % 2 ? 0.5 : 0) * (w / 3);
        doc.moveTo(x - w / 3 + phase, base);
        for (let k = -1; k < 4; k += 1) {
            const sx = x + k * (w / 3) + phase;
            doc.bezierCurveTo(sx + w / 12, base - amp, sx + w / 4, base + amp, sx + w / 3, base);
        }
        doc.stroke();
    }
    doc.restore();
}

/** The photo, in its frame — or the holder's initials when there is none. */
function photo(doc, cache, card, look, box, u) {
    const { x, y, w, h } = box;
    const circle = look.photoShape === 'circle';
    const r = circle ? w / 2 : 3 * u;
    const frame = 1.3 * u;
    doc.save();
    // The frame and a soft shadow under it.
    doc.fillColor('#000000', 0.10);
    if (circle) doc.circle(x + w / 2, y + h / 2 + 0.6 * u, w / 2 + frame).fill();
    else doc.roundedRect(x - frame, y - frame + 0.6 * u, w + 2 * frame, h + 2 * frame, r + frame).fill();
    doc.fillColor('#ffffff', 1);
    if (circle) doc.circle(x + w / 2, y + h / 2, w / 2 + frame).fill();
    else doc.roundedRect(x - frame, y - frame, w + 2 * frame, h + 2 * frame, r + frame).fill();
    if (circle) doc.circle(x + w / 2, y + h / 2, w / 2).clip();
    else doc.roundedRect(x, y, w, h, r).clip();
    const img = imageOf(cache, card.snapshot?.photo);
    if (img) {
        try {
            doc.image(img, x, y, { cover: [w, h], align: 'center', valign: 'center' });
        } catch { /* a corrupt file falls through to the initials */ }
    } else {
        doc.rect(x, y, w, h).fill(gradientFill(doc, x, y, x, y + h, shade(look.primary, 0.86), shade(look.primary, 0.74)));
        const s = Math.min(w, h) * 0.34;
        put(doc, initials(card.snapshot?.name), x, y + h / 2 - s * 0.62, { f: 'X', size: s, color: shade(look.primary, 0.25), width: w, align: 'center' });
    }
    doc.restore();
}

/** The QR, as vector squares — sharp at any print size. */
function qr(doc, code, x, y, size) {
    const q = QRCode.create(`${FRONTEND()}/verify/id/${code}`, { errorCorrectionLevel: 'M' });
    const n = q.modules.size;
    const cell = size / n;
    doc.save().fillColor('#000000', 1);
    for (let row = 0; row < n; row += 1) {
        let run = -1;
        for (let col = 0; col <= n; col += 1) {
            const dark = col < n && q.modules.get(row, col);
            if (dark && run < 0) run = col;
            if (!dark && run >= 0) {
                doc.rect(x + run * cell, y + row * cell, (col - run) * cell + 0.05, cell + 0.05);
                run = -1;
            }
        }
    }
    doc.fill();
    doc.restore();
}

/** The logo in its white disc. */
function logo(doc, cache, look, cx, cy, radius) {
    const img = imageOf(cache, look.identity?.logo);
    if (!img) return false;
    doc.save();
    doc.fillColor('#ffffff', 1).circle(cx, cy, radius).fill();
    const inner = radius * 1.32;
    try { doc.image(img, cx - inner / 2, cy - inner / 2, { fit: [inner, inner], align: 'center', valign: 'center' }); } catch { /* skip */ }
    doc.restore();
    return true;
}

/* ── What prints ─────────────────────────────────────────────────────────── */

/** [label, value, full-width?] for the front's grid, in the template's order. */
function frontFields(card, look) {
    const s = card.snapshot || {};
    // cardDesign() fills every field of the kind, so a field prints exactly when it is on.
    const on = (k) => look.fields?.[k] === true;
    const out = [];
    const add = (k, label, value, wide) => { if (on(k) && value) out.push([label, value, !!wide]); };
    if (card.kind === 'student') {
        add('admissionNo', 'Admission No.', s.holderCode);
        add('rollNo', 'Roll No.', s.rollNumber);
        add('dob', 'Date of Birth', dob(s.dob));
        add('bloodGroup', 'Blood Group', s.bloodGroup);
    } else if (card.kind === 'parent') {
        add('parentId', 'Parent ID', s.holderCode);
        add('phone', 'Phone', s.phone);
        add('children', 'Parent of', (s.children || []).map((c) => c.name).join(', '), true);
    } else {
        add('employeeId', 'Employee ID', s.holderCode);
        add('department', 'Department', s.department);
        add('bloodGroup', 'Blood Group', s.bloodGroup);
        add('dob', 'Date of Birth', dob(s.dob));
        add('joiningDate', 'Joined', dob(s.joiningDate));
    }
    return out;
}

/** [label, value] for the back. */
function backFields(card, look) {
    const s = card.snapshot || {};
    const on = (k) => look.fields?.[k] === true;
    const out = [];
    if (card.kind === 'student') {
        if (on('parentName') && s.parentName) out.push(["Parent's Name", s.parentName]);
        if (on('emergencyPhone') && s.emergencyPhone) out.push(['Emergency Contact', s.emergencyPhone]);
        if (on('address') && s.address) out.push(['Home Address', s.address]);
    } else if (card.kind !== 'parent') {
        if (on('phone') && s.phone) out.push(['Phone', s.phone]);
        if (on('emergencyPhone') && s.emergencyPhone) out.push(['Emergency Contact', s.emergencyPhone]);
    }
    return out;
}

/** The line under the name. */
function subLine(card) {
    const s = card.snapshot || {};
    if (card.kind === 'student') return [s.className, s.sectionName].filter(Boolean).join(' – ') || 'Student';
    if (card.kind === 'parent') return s.relationship || 'Parent';
    return s.designation || (card.kind === 'teacher' ? 'Teacher' : 'Staff');
}

/* ── Faces ───────────────────────────────────────────────────────────────── */

function stamp(doc, card, g) {
    const word = STAMP[card.effective] || '';
    if (!word) return;
    const { w, h, u } = g;
    doc.save();
    doc.rotate(-28, { origin: [w / 2, h / 2] });
    setFont(doc, 'X', 9 * u);
    const tw = doc.widthOfString(word, { characterSpacing: 0.08 * 9 * u });
    const bw = tw + 8 * u; const bh = 14 * u;
    doc.lineWidth(0.8 * u).strokeColor('#dc2626').strokeOpacity(0.55)
        .roundedRect(w / 2 - bw / 2, h / 2 - bh / 2, bw, bh, 2 * u).stroke();
    put(doc, word, w / 2 - bw / 2, h / 2 - 9 * u * 0.62, { f: 'X', size: 9 * u, color: '#dc2626', opacity: 0.55, width: bw, align: 'center', spacing: 0.08 });
    doc.restore();
}

function roleStripe(doc, card, look, g, y, height, textSize) {
    const { w, u } = g;
    doc.rect(0, y, w, height).fill(gradientFill(doc, 0, y, w, y, look.accent, shade(look.accent, -0.12)));
    put(doc, KIND_TITLE[card.kind], 0, y + height / 2 - textSize * 0.62, { f: 'X', size: textSize, color: '#ffffff', width: w, align: 'center', spacing: 0.32 });
    if (Number(card.reissueNo) > 0 && ['lost', 'damaged'].includes(card.reissueReason)) {
        const t = card.reissueNo > 1 ? `DUPLICATE ${card.reissueNo}` : 'DUPLICATE';
        put(doc, t, 0, y + height / 2 - 1.7 * u * 0.62, { f: 'B', size: 1.7 * u, color: '#ffffff', opacity: 0.85, width: w - 3 * u, align: 'right', spacing: 0.06 });
    }
}

/**
 * Year chip (students) or the card number (everyone else), with the validity.
 * `k` scales it (the landscape face is shorter); `center` centres it in maxW.
 */
function footerLeft(doc, card, look, g, x, y, maxW, { k = 1, center = false } = {}) {
    const { u } = g;
    const s = card.snapshot || {};
    const align = center ? 'center' : 'left';
    if (card.kind === 'student' && s.yearName) {
        setFont(doc, 'X', 2.7 * k * u);
        const tw = doc.widthOfString(s.yearName);
        const cw = tw + 5 * k * u; const ch = 5.6 * k * u;
        const cx = center ? x + (maxW - cw) / 2 : x;
        doc.lineWidth(0.35 * u).strokeColor(look.accent).strokeOpacity(1).fillColor(shade(look.accent, 0.9), 1);
        doc.roundedRect(cx, y, cw, ch, ch / 2).fillAndStroke();
        put(doc, s.yearName, cx, y + ch / 2 - 2.7 * k * u * 0.6, { f: 'X', size: 2.7 * k * u, color: shade(look.accent, -0.25), width: cw, align: 'center' });
        if (look.showValidity && (card.validUntil || s.yearEnd)) {
            put(doc, `Valid till ${day(card.validUntil || `${s.yearEnd}T00:00:00Z`)}`, x, y + ch + 1.1 * k * u, { f: 'S', size: 2.05 * k * u, color: MUTED, width: maxW, align });
        }
        return;
    }
    put(doc, 'CARD NO.', x, y, { f: 'S', size: 1.9 * k * u, color: MUTED, spacing: 0.08, width: maxW, align });
    put(doc, card.number, x, y + 2.8 * k * u, { f: 'B', size: 2.8 * k * u, color: INK, width: maxW, spacing: 0.02, align });
    if (look.showValidity) put(doc, `Issued ${dayAt(card.issuedAt, card.school)}`, x, y + 6.6 * k * u, { f: 'S', size: 2.05 * k * u, color: MUTED, width: maxW, align });
}

function signature(doc, cache, look, g, x, y, w, { k = 1 } = {}) {
    if (!look.showSignature) return;
    const { u } = g;
    const img = imageOf(cache, look.signatory?.signature);
    if (img) {
        try { doc.image(img, x, y, { fit: [w, 7.2 * k * u], align: 'center', valign: 'bottom' }); } catch { /* skip */ }
    }
    doc.lineWidth(0.22 * u).strokeColor(SOFT).strokeOpacity(1).moveTo(x, y + 8 * k * u).lineTo(x + w, y + 8 * k * u).stroke();
    put(doc, look.signatory?.title || 'Principal', x, y + 9 * k * u, { f: 'S', size: 2.1 * k * u, color: MUTED, width: w, align: 'center' });
}

/** A label over a value. Returns the height used. */
function cell(doc, label, value, x, y, w, g, { wide = false, size = 3.1, labelSize = 2.1, lines = 1 } = {}) {
    const { u } = g;
    put(doc, label.toUpperCase(), x, y, { f: 'S', size: labelSize * u, color: MUTED, width: w, spacing: 0.07 });
    setFont(doc, 'B', size * u);
    const rows = wide || lines > 1 ? wrap(doc, value, w, lines) : [clip(doc, value, w)];
    rows.forEach((line, i) => put(doc, line, x, y + (labelSize + 0.9) * u + i * size * 1.18 * u, { f: 'B', size: size * u, color: INK, width: w }));
    return (labelSize + 0.9) * u + rows.length * size * 1.18 * u;
}

function frontPortrait(doc, cache, card, look, g) {
    const { w, h, u } = g;
    const s = card.snapshot || {};
    // Body pattern.
    pattern(doc, look.pattern, 0, 46 * u, w, 100 * u, look.primary, 0.05, u);
    // Header band with a curved foot.
    doc.save();
    doc.moveTo(0, 0).lineTo(w, 0).lineTo(w, 38 * u).quadraticCurveTo(w / 2, 48 * u, 0, 38 * u).closePath();
    doc.fill(gradientFill(doc, 0, 0, 0, 44 * u, shade(look.primary, 0.08), shade(look.primary, -0.18)));
    doc.moveTo(0, 0).lineTo(w, 0).lineTo(w, 38 * u).quadraticCurveTo(w / 2, 48 * u, 0, 38 * u).closePath().clip();
    pattern(doc, look.pattern, 0, 0, w, 44 * u, '#ffffff', 0.10, u);
    doc.restore();
    // Accent edge under the curve.
    doc.save().lineWidth(0.9 * u).strokeColor(look.accent).strokeOpacity(1)
        .moveTo(0, 38.6 * u).quadraticCurveTo(w / 2, 48.6 * u, w, 38.6 * u).stroke().restore();

    const hasLogo = look.showLogo && logo(doc, cache, look, w / 2, 15.5 * u, 6.4 * u);
    // School name: up to two lines, upper case, shrinking to fit.
    const name = String(look.identity?.name || '').toUpperCase();
    let size = 4.3 * u;
    setFont(doc, 'X', size);
    let lines = wrap(doc, name, 88 * u, 2, 0.02 * size);
    while (lines.length > 1 && size > 3.2 * u && lines.some((l) => l.endsWith('…'))) {
        size -= 0.15 * u; setFont(doc, 'X', size); lines = wrap(doc, name, 88 * u, 2, 0.02 * size);
    }
    let y = hasLogo ? 23.6 * u : (lines.length > 1 ? 11 * u : 14 * u);
    for (const line of lines) {
        put(doc, line, 6 * u, y, { f: 'X', size, color: '#ffffff', width: 88 * u, align: 'center', spacing: 0.02 });
        y += size * 1.14;
    }
    if (look.identity?.tagline) {
        setFont(doc, 'S', 2.4 * u);
        put(doc, clip(doc, look.identity.tagline, 84 * u), 8 * u, y + 0.6 * u, { f: 'S', size: 2.4 * u, color: '#ffffff', opacity: 0.82, width: 84 * u, align: 'center' });
    }

    // Photo.
    const circle = look.photoShape === 'circle';
    const box = circle ? { x: 32 * u, y: 44 * u, w: 36 * u, h: 36 * u } : { x: 33 * u, y: 43 * u, w: 34 * u, h: 41 * u };
    photo(doc, cache, card, look, box, u);

    // Name and the line under it.
    let ny = box.y + box.h + 4.4 * u;
    const nsize = fitSize(doc, s.name || '', 'X', 5.3 * u, 3.6 * u, 88 * u);
    setFont(doc, 'X', nsize);
    put(doc, clip(doc, s.name || '', 88 * u), 6 * u, ny, { f: 'X', size: nsize, color: INK, width: 88 * u, align: 'center' });
    ny += nsize * 1.22;
    put(doc, subLine(card), 6 * u, ny, { f: 'B', size: 3.25 * u, color: shade(look.accent, -0.1), width: 88 * u, align: 'center' });
    ny += 3.25 * u * 1.3 + 2.6 * u;

    // Details: two columns (one beside a QR printed on the front).
    const qrFront = look.qrOn === 'front';
    const fields = frontFields(card, look);
    const colW = qrFront ? 56 * u : 39 * u;
    const cols = qrFront ? 1 : 2;
    let gy = ny;
    let col = 0;
    let rowH = 0;
    const maxY = 132 * u;
    for (const [label, value, wide] of fields) {
        if (wide && col !== 0) { gy += rowH + 1.4 * u; col = 0; rowH = 0; }
        if (gy > maxY - 8 * u) break;
        const x = 9 * u + col * (colW + 4 * u);
        const used = cell(doc, label, value, x, gy, wide ? (qrFront ? colW : 82 * u) : colW, g, { wide, lines: wide ? 2 : 1 });
        rowH = Math.max(rowH, used);
        if (wide || cols === 1 || col === cols - 1) { gy += rowH + 1.4 * u; col = 0; rowH = 0; } else col += 1;
    }
    if (qrFront) {
        doc.save().fillColor('#ffffff', 1).lineWidth(0.25 * u).strokeColor('#e2e8f0')
            .roundedRect(70 * u, ny - 0.5 * u, 22 * u, 22 * u, 1.6 * u).fillAndStroke().restore();
        qr(doc, card.code, 71.5 * u, ny + 1 * u, 19 * u);
    }

    // Footer: year (or card number), and the signature.
    footerLeft(doc, card, look, g, 8 * u, 136 * u, 46 * u);
    signature(doc, cache, look, g, 60 * u, 132.5 * u, 32 * u);
    roleStripe(doc, card, look, g, 150.5 * u, h - 150.5 * u, 3.1 * u);
}

function returnBlock(doc, look, g, x, y, w, { center = true, nameSize = 2.9, textSize = 2.35, addressLines = 2 } = {}) {
    const { u } = g;
    const id = look.identity || {};
    const align = center ? 'center' : 'left';
    let yy = y;
    if (look.showReturnAddress) {
        put(doc, 'IF FOUND, PLEASE RETURN TO', x, yy, { f: 'S', size: 1.9 * u, color: MUTED, width: w, align, spacing: 0.1 });
        yy += 3 * u;
    }
    setFont(doc, 'X', nameSize * u);
    put(doc, clip(doc, id.name || '', w), x, yy, { f: 'X', size: nameSize * u, color: look.primary, width: w, align });
    yy += nameSize * 1.3 * u;
    if (id.address) {
        setFont(doc, 'R', textSize * u);
        for (const line of wrap(doc, id.address, w, addressLines)) {
            put(doc, line, x, yy, { f: 'R', size: textSize * u, color: '#334155', width: w, align });
            yy += textSize * 1.25 * u;
        }
    }
    const contact = [id.phone, id.email || id.website].filter(Boolean).join('  ·  ');
    if (contact) {
        setFont(doc, 'S', textSize * u);
        put(doc, clip(doc, contact, w), x, yy, { f: 'S', size: textSize * u, color: '#334155', width: w, align });
        yy += textSize * 1.3 * u;
    }
    return yy;
}

function backPortrait(doc, cache, card, look, g) {
    const { w, h, u } = g;
    doc.rect(0, 0, w, 20 * u).fill(gradientFill(doc, 0, 0, 0, 20 * u, shade(look.primary, 0.08), shade(look.primary, -0.18)));
    doc.save(); doc.rect(0, 0, w, 20 * u).clip(); pattern(doc, look.pattern, 0, 0, w, 20 * u, '#ffffff', 0.1, u); doc.restore();
    doc.rect(0, 20 * u, w, 0.8 * u).fill(look.accent);
    const sn = String(look.identity?.name || '').toUpperCase();
    const size = fitSize(doc, sn, 'X', 3.1 * u, 2.2 * u, 86 * u, 0.04);
    setFont(doc, 'X', size);
    put(doc, clip(doc, sn, 86 * u, 0.04 * size), 7 * u, 11.2 * u, { f: 'X', size, color: '#ffffff', width: 86 * u, align: 'center', spacing: 0.04 });
    pattern(doc, look.pattern, 0, 22 * u, w, 120 * u, look.primary, 0.035, u);

    let y;
    if (look.qrOn !== 'front') {
        doc.save().fillColor('#ffffff', 1).lineWidth(0.3 * u).strokeColor('#e2e8f0')
            .roundedRect(27 * u, 26 * u, 46 * u, 46 * u, 2.4 * u).fillAndStroke().restore();
        qr(doc, card.code, 30 * u, 29 * u, 40 * u);
        put(doc, 'Scan to verify this card', 0, 74.2 * u, { f: 'S', size: 2.3 * u, color: MUTED, width: w, align: 'center' });
        put(doc, card.number, 0, 77.8 * u, { f: 'X', size: 3.3 * u, color: INK, width: w, align: 'center', spacing: 0.06 });
        y = 85 * u;
    } else {
        put(doc, 'CARD NO.', 0, 30 * u, { f: 'S', size: 2.1 * u, color: MUTED, width: w, align: 'center', spacing: 0.1 });
        put(doc, card.number, 0, 33.5 * u, { f: 'X', size: 4.2 * u, color: INK, width: w, align: 'center', spacing: 0.06 });
        y = 42 * u;
    }
    const extras = backFields(card, look);
    for (const [label, value] of extras) {
        y += cell(doc, label, value, 10 * u, y, 80 * u, g, { size: 2.7, labelSize: 1.9, lines: label === 'Home Address' ? 2 : 1 }) + 1.6 * u;
    }
    if (extras.length) {
        doc.lineWidth(0.2 * u).strokeColor('#e2e8f0').moveTo(10 * u, y).lineTo(90 * u, y).stroke();
        y += 2.6 * u;
    }
    y = returnBlock(doc, look, g, 8 * u, y, 84 * u);
    if (look.backNote) {
        setFont(doc, 'R', 2.1 * u);
        const lines = wrap(doc, look.backNote, 82 * u, 4);
        let ly = Math.max(y + 2 * u, 150.5 * u - lines.length * 2.1 * 1.32 * u - 2 * u);
        for (const line of lines) {
            put(doc, line, 9 * u, ly, { f: 'R', size: 2.1 * u, color: MUTED, width: 82 * u, align: 'center' });
            ly += 2.1 * 1.32 * u;
        }
    }
    doc.rect(0, 154.5 * u, w, h - 154.5 * u).fill(look.accent);
}

function frontLandscape(doc, cache, card, look, g) {
    const { w, h, u } = g;
    const s = card.snapshot || {};
    pattern(doc, look.pattern, 0, 19 * u, w, 38 * u, look.primary, 0.05, u);
    doc.rect(0, 0, w, 18 * u).fill(gradientFill(doc, 0, 0, 0, 18 * u, shade(look.primary, 0.08), shade(look.primary, -0.18)));
    doc.save(); doc.rect(0, 0, w, 18 * u).clip(); pattern(doc, look.pattern, 0, 0, w, 18 * u, '#ffffff', 0.1, u); doc.restore();
    doc.rect(0, 18 * u, w, 0.7 * u).fill(look.accent);
    const hasLogo = look.showLogo && logo(doc, cache, look, 9.5 * u, 9 * u, 5.4 * u);
    const nx = hasLogo ? 17.5 * u : 5 * u;
    const nw = 96 * u - nx;
    const name = String(look.identity?.name || '').toUpperCase();
    let size = 3.5 * u;
    setFont(doc, 'X', size);
    let lines = wrap(doc, name, nw, 2, 0.02 * size);
    while (size > 2.5 * u && lines.some((l) => l.endsWith('…'))) { size -= 0.1 * u; setFont(doc, 'X', size); lines = wrap(doc, name, nw, 2, 0.02 * size); }
    const tag = look.identity?.tagline ? 2.6 * u : 0;
    let y = (18 * u - (lines.length * size * 1.12 + tag)) / 2 + 0.6 * u;
    for (const line of lines) { put(doc, line, nx, y, { f: 'X', size, color: '#ffffff', width: nw, spacing: 0.02 }); y += size * 1.12; }
    if (tag) { setFont(doc, 'S', 1.95 * u); put(doc, clip(doc, look.identity.tagline, nw), nx, y + 0.2 * u, { f: 'S', size: 1.95 * u, color: '#ffffff', opacity: 0.82, width: nw }); }

    const circle = look.photoShape === 'circle';
    const box = circle ? { x: 5 * u, y: 22.6 * u, w: 22 * u, h: 22 * u } : { x: 5.5 * u, y: 22.2 * u, w: 21 * u, h: 25 * u };
    photo(doc, cache, card, look, box, u);

    const tx = 34 * u; const tw = 61 * u;
    const nsize = fitSize(doc, s.name || '', 'X', 4.3 * u, 3 * u, tw);
    setFont(doc, 'X', nsize);
    put(doc, clip(doc, s.name || '', tw), tx, 22.4 * u, { f: 'X', size: nsize, color: INK, width: tw });
    put(doc, subLine(card), tx, 22.4 * u + nsize * 1.2, { f: 'B', size: 2.75 * u, color: shade(look.accent, -0.1), width: tw });

    const qrFront = look.qrOn === 'front';
    const fields = frontFields(card, look);
    const colW = qrFront ? 38 * u : 29 * u;
    const cols = qrFront ? 1 : 2;
    let gy = 32.6 * u; let col = 0; let rowH = 0;
    for (const [label, value, wide] of fields) {
        if (wide && col !== 0) { gy += rowH + 0.8 * u; col = 0; rowH = 0; }
        if (gy > 47 * u) break;
        const x = tx + col * (colW + 3 * u);
        const used = cell(doc, label, value, x, gy, wide ? (qrFront ? colW : tw) : colW, g, { wide, size: 2.55, labelSize: 1.7, lines: 1 });
        rowH = Math.max(rowH, used);
        if (wide || cols === 1 || col === cols - 1) { gy += rowH + 0.8 * u; col = 0; rowH = 0; } else col += 1;
    }
    if (qrFront) {
        doc.save().fillColor('#ffffff', 1).lineWidth(0.22 * u).strokeColor('#e2e8f0').roundedRect(76 * u, 31.5 * u, 19 * u, 19 * u, 1.2 * u).fillAndStroke().restore();
        qr(doc, card.code, 77.3 * u, 32.8 * u, 16.4 * u);
    }
    // Under the photo: the year chip (students) or the card number.
    footerLeft(doc, card, look, g, 3 * u, circle ? 47.6 * u : 49.6 * u, 26 * u, { k: 0.78, center: true });
    if (!qrFront) signature(doc, cache, look, g, 74 * u, 44.4 * u, 21 * u, { k: 0.86 });
    roleStripe(doc, card, look, g, 58.3 * u, h - 58.3 * u, 2.3 * u);
}

function backLandscape(doc, cache, card, look, g) {
    const { w, h, u } = g;
    doc.rect(0, 0, w, 12 * u).fill(gradientFill(doc, 0, 0, 0, 12 * u, shade(look.primary, 0.08), shade(look.primary, -0.18)));
    doc.save(); doc.rect(0, 0, w, 12 * u).clip(); pattern(doc, look.pattern, 0, 0, w, 12 * u, '#ffffff', 0.1, u); doc.restore();
    doc.rect(0, 12 * u, w, 0.6 * u).fill(look.accent);
    const sn = String(look.identity?.name || '').toUpperCase();
    const size = fitSize(doc, sn, 'X', 2.7 * u, 2 * u, 88 * u, 0.04);
    setFont(doc, 'X', size);
    put(doc, clip(doc, sn, 88 * u, 0.04 * size), 6 * u, 6.4 * u - size * 0.5, { f: 'X', size, color: '#ffffff', width: 88 * u, spacing: 0.04 });
    pattern(doc, look.pattern, 0, 13 * u, w, 45 * u, look.primary, 0.035, u);

    let rx = 6 * u; let rw = 88 * u;
    if (look.qrOn !== 'front') {
        doc.save().fillColor('#ffffff', 1).lineWidth(0.25 * u).strokeColor('#e2e8f0').roundedRect(5 * u, 16 * u, 29 * u, 29 * u, 1.8 * u).fillAndStroke().restore();
        qr(doc, card.code, 7 * u, 18 * u, 25 * u);
        put(doc, 'Scan to verify', 5 * u, 46.6 * u, { f: 'S', size: 1.9 * u, color: MUTED, width: 29 * u, align: 'center' });
        setFont(doc, 'X', 2.45 * u);
        put(doc, clip(doc, card.number, 30 * u), 4.5 * u, 49.6 * u, { f: 'X', size: 2.45 * u, color: INK, width: 30 * u, align: 'center', spacing: 0.03 });
        rx = 39 * u; rw = 56 * u;
    }
    let y = 16 * u;
    if (look.qrOn === 'front') {
        put(doc, `CARD NO.  ${card.number}`, rx, y, { f: 'B', size: 2.4 * u, color: INK, width: rw, spacing: 0.04 });
        y += 4.6 * u;
    }
    for (const [label, value] of backFields(card, look)) {
        y += cell(doc, label, value, rx, y, rw, g, { size: 2.3, labelSize: 1.6, lines: 1 }) + 0.9 * u;
    }
    y = returnBlock(doc, look, g, rx, y + 0.6 * u, rw, { center: false, nameSize: 2.5, textSize: 2.0, addressLines: 2 });
    if (look.backNote) {
        setFont(doc, 'R', 1.8 * u);
        const lines = wrap(doc, look.backNote, rw, 3);
        let ly = Math.max(y + 1 * u, 58.6 * u - lines.length * 1.8 * 1.3 * u - 1.2 * u);
        for (const line of lines) { put(doc, line, rx, ly, { f: 'R', size: 1.8 * u, color: MUTED, width: rw }); ly += 1.8 * 1.3 * u; }
    }
    doc.rect(0, 60.06 * u, w, h - 60.06 * u).fill(look.accent);
}

/** One face of one card, its top-left corner at (x, y). */
function drawFace(doc, cache, card, side, x, y) {
    const look = cardDesign(card.kind, card.design);
    const g = geometry(look.layout);
    doc.save();
    doc.translate(x, y);
    doc.roundedRect(0, 0, g.w, g.h, g.r).clip();
    doc.rect(0, 0, g.w, g.h).fill('#ffffff');
    if (side === 'front') {
        if (g.portrait) frontPortrait(doc, cache, card, look, g); else frontLandscape(doc, cache, card, look, g);
        stamp(doc, card, g);
    } else {
        if (g.portrait) backPortrait(doc, cache, card, look, g); else backLandscape(doc, cache, card, look, g);
    }
    doc.restore();
    return g;
}

/* ── Pages ───────────────────────────────────────────────────────────────── */

function cropMarks(doc, x, y, w, h) {
    const len = 2.4 * MM; const off = 0.9 * MM;
    doc.save().lineWidth(0.25).strokeColor('#9aa3b2').strokeOpacity(1);
    for (const [cx, cy, dx, dy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]]) {
        doc.moveTo(cx + dx * off, cy).lineTo(cx + dx * (off + len), cy).stroke();
        doc.moveTo(cx, cy + dy * off).lineTo(cx, cy + dy * (off + len)).stroke();
    }
    doc.restore();
}

function registerFonts(doc) {
    for (const [key, weight] of Object.entries(FONTS)) {
        doc.registerFont(key, path.join(FONT_DIR, `PlusJakartaSans-${weight}.woff`));
    }
}

/**
 * Write the cards to `res` as a PDF.
 *   cards     IdCard rows, each with `effective` (its status as it stands)
 *   layout    'card' | 'sheet'
 *   sides     'both' | 'front' | 'back'
 */
function renderIdCards(res, { cards, layout = 'card', sides = 'both', filename = 'id-cards.pdf', cropMarks: marks = true, inline = false }) {
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: 'ID cards', Author: 'Aksharum' } });
    registerFonts(doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`);
    doc.pipe(res);
    const cache = new Map();
    const faces = sides === 'both' ? ['front', 'back'] : [sides];

    if (layout === 'card') {
        for (const card of cards) {
            const g = geometry(cardDesign(card.kind, card.design).layout);
            for (const side of faces) {
                doc.addPage({ size: [g.w, g.h], margin: 0 });
                drawFace(doc, cache, card, side, 0, 0);
            }
        }
        doc.end();
        return;
    }

    // A4 sheets — portrait and landscape cards each get their own pages.
    const A4 = { w: 210 * MM, h: 297 * MM };
    const groups = [
        cards.filter((c) => cardDesign(c.kind, c.design).layout !== 'landscape'),
        cards.filter((c) => cardDesign(c.kind, c.design).layout === 'landscape'),
    ];
    groups.forEach((group, gi) => {
        if (!group.length) return;
        const g = geometry(gi === 0 ? 'portrait' : 'landscape');
        const cols = gi === 0 ? 3 : 2;
        const rows = gi === 0 ? 3 : 5;
        const gap = (gi === 0 ? 4 : 3) * MM;
        const gridW = cols * g.w + (cols - 1) * gap;
        const gridH = rows * g.h + (rows - 1) * gap;
        const ox = (A4.w - gridW) / 2;
        const oy = (A4.h - gridH) / 2;
        const per = cols * rows;
        for (let at = 0; at < group.length; at += per) {
            const page = group.slice(at, at + per);
            for (const side of faces) {
                doc.addPage({ size: [A4.w, A4.h], margin: 0 });
                page.forEach((card, i) => {
                    const row = Math.floor(i / cols);
                    let col = i % cols;
                    // Backs mirror left-to-right so a long-edge duplex flip lines them up.
                    if (side === 'back' && sides === 'both') col = cols - 1 - col;
                    const x = ox + col * (g.w + gap);
                    const y = oy + row * (g.h + gap);
                    drawFace(doc, cache, card, side, x, y);
                    if (marks) cropMarks(doc, x, y, g.w, g.h);
                });
                put(doc, `${side === 'front' ? 'Fronts' : 'Backs'} · ${page.length} card${page.length === 1 ? '' : 's'} · print at actual size (100%)${side === 'back' && sides === 'both' ? ' · duplex, flip on long edge' : ''}`,
                    0, A4.h - 5 * MM, { f: 'S', size: 6.5, color: SOFT, width: A4.w, align: 'center' });
            }
        }
    });
    doc.end();
}

/** "id-card-aarav-sharma-st2627-00042.pdf" */
function pdfName(card) {
    const who = String(card?.snapshot?.name || 'card').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `id-card-${who}-${String(card?.number || '').toLowerCase()}.pdf`;
}

module.exports = { renderIdCards, pdfName, drawFace, geometry };
