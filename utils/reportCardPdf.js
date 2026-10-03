'use strict';
/**
 * Report cards as a PDF (Oct 2026) — the card the web prints
 * (school-frontend pages/results/reportCards/ReportCardSheet.jsx), drawn from
 * the same data (services/reportCard), one A4 page a student whenever it fits.
 * The phone shares this file; it never draws a report card of its own, so
 * what a family forwards is what the school issued.
 *
 * The page is measured before it is drawn. A full card — fourteen subjects
 * across six exams, ten co-scholastic areas, a long remark — used to run off
 * the page: the marks were cut to "87…", the promotion line split from its box
 * onto a second page and the signatures fell onto a third. Now the rows and
 * type shrink (within reason) to keep one page; a card that still cannot fit
 * carries on to a second page cleanly, with its header repeated, and the
 * signatures always sit at the foot of its last page. A cell that is too
 * narrow drops "/max" before it ever truncates a mark.
 */
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { schoolLogoPath } = require('./schoolLogoFile');

const C = {
    ink: '#14183A', muted: '#5A6284', faint: '#8A93AD', line: '#D9DEEA', band: '#F1F3FA', soft: '#F9FAFE',
    primary: '#4038D0', pass: '#15803D', fail: '#C0262D', overallBg: '#F7F7FF', overallLine: '#D6D4F7', promoBg: '#ECFAF0',
    held: '#FDECEC', heldInk: '#9B1C1C',
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A stored day (UTC midnight of the day meant), by its own parts. */
const fmtDay = (d) => {
    const x = d ? new Date(d) : null;
    return x && !Number.isNaN(x.getTime()) ? `${String(x.getUTCDate()).padStart(2, '0')} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}` : '';
};
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const classLine = (r) => [r?.className, r?.sectionName].filter(Boolean).join(' – ') || '—';

const PAGE_W = 595.28; const PAGE_H = 841.89;
const L = 36; const W = PAGE_W - 72; const TOP = 30; const BOTTOM = PAGE_H - 24;
/** Sizes to try, roomiest first: row height, body type, table header height. */
const METRICS = [
    { rowH: 15, font: 8.5, small: 7.5, hdr: 30 },
    { rowH: 13.5, font: 8, small: 7, hdr: 28 },
    { rowH: 12, font: 7.5, small: 6.8, hdr: 27 },
    { rowH: 11, font: 7, small: 6.5, hdr: 26 },
];

/** Write `cards` to the response, one card after another. */
function renderReportCards(res, { frame, cards, family = false, filename = 'report-card.pdf' }) {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 }, autoFirstPage: false });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\- ]+/g, '_')}"`);
    doc.pipe(res);
    build(doc, frame, cards, family);
    doc.end();
}

/** The same, as a Buffer — for sending by email. */
function renderReportCardsBuffer({ frame, cards, family = false }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 }, autoFirstPage: false });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        try { build(doc, frame, cards, family); doc.end(); } catch (e) { reject(e); }
    });
}

function build(doc, frame, cards, family) {
    if (!cards.length) {
        doc.addPage();
        doc.font('Helvetica').fontSize(12).fillColor(C.muted).text('There are no report cards to print.', L, 60, { lineBreak: false });
        return;
    }
    // Each card prints the scale it is graded on — its class's — not the school's default.
    cards.forEach((card) => drawCard(doc, card.scale ? { ...frame, scale: card.scale, showGradePoints: !!card.showGradePoints } : frame, card, family));
}

/** The text, shortened with "…" until it fits the width in the current font. */
function fit(doc, text, width) {
    let t = String(text ?? '');
    if (doc.widthOfString(t) <= width) return t;
    while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
}

function cell(doc, text, x, y, w, h, { bold = false, size = 8.5, color = C.ink, align = 'center', bg = null } = {}) {
    if (bg) doc.rect(x, y, w, h).fill(bg);
    doc.rect(x, y, w, h).lineWidth(0.6).strokeColor(C.line).stroke();
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
    doc.text(fit(doc, text, w - 6), x + 3, y + (h - size) / 2 - 0.5, { width: w - 6, align, lineBreak: false });
}

/** A mark as it fits: "87.5/100*", else "87.5*" — never a cut-off figure. */
function markText(doc, data, width) {
    if (!data) return '—';
    if (data.gradeOnly) return '—';
    if (data.absent) return 'AB';
    const star = data.grace ? '*' : '';
    const full = `${data.marks}/${data.max}${star}`;
    return doc.widthOfString(full) <= width ? full : `${data.marks}${star}`;
}

/** Height a block of wrapped text takes at a size. */
const heightOf = (doc, text, size, width, bold = false) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).heightOfString(String(text || ' '), { width });

function drawQr(doc, url, x, y, size) {
    try {
        const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
        const n = qr.modules.size;
        const cellSize = size / n;
        doc.save();
        doc.rect(x - 2, y - 2, size + 4, size + 4).fill('#FFFFFF');
        for (let r = 0; r < n; r += 1) {
            for (let c = 0; c < n; c += 1) {
                if (qr.modules.data[r * n + c]) doc.rect(x + c * cellSize, y + r * cellSize, cellSize + 0.05, cellSize + 0.05);
            }
        }
        doc.fill('#111111');
        doc.restore();
        return true;
    } catch {
        return false;
    }
}

/**
 * The card's blocks and how tall each is at metrics `m`, so the page can be
 * planned before anything is drawn.
 */
function plan(doc, frame, c, m) {
    const many = c.exams.length > 1;
    const o = c.overall;
    const cols = [...c.exams, ...(many && o ? [{ overall: true }] : [])];
    const subjectRemarks = frame.showSubjectRemarks !== false ? c.subjects.filter((s) => s.remarks) : [];
    const footRows = 2 + 1 + (frame.showRank && (c.exams.some((e) => e.rank) || o?.rank) ? 1 : 0);
    const notes = (c.subjects.some((s) => s.cells.some((x) => x?.grace)) ? 1 : 0) + (c.basis === 'all' && c.exams.length > 1 ? 1 : 0);
    const table = cols.length ? m.hdr + 8 + (c.subjects.length + footRows) * m.rowH + (notes ? 14 : 0) + 18 : 52;
    const co = c.coScholastic.length ? 16 + c.coScholastic.length * 14 : 0;
    const att = c.attendance ? 16 + 28 + (c.attendance.total ? 12 : 0) : 0;
    const remarksText = c.remarks || (c.complete ? '' : "The class teacher's remarks are given with the final results.");
    return {
        cols, many, subjectRemarks, remarksText,
        heights: {
            header: 128 + (c.withheld ? 24 : 0),
            who: 65,
            table,
            overall: o ? 42 : 0,
            coAtt: Math.max(co, att) ? Math.max(co, att) + 10 : 0,
            remarks: 18 + Math.max(36, heightOf(doc, remarksText, 9, W - 16) + 14) + 8,
            subjectRemarks: subjectRemarks.length ? 18 + subjectRemarks.reduce((h, s) => h + heightOf(doc, `${s.subjectName}: ${s.remarks}`, m.font, W - 8) + 3, 0) + 6 : 0,
            promotion: c.promotion ? 26 : 0,
            scale: (frame.scale || []).length ? 16 : 0,
            foot: 48 + (frame.footer ? 18 : 0),
        },
    };
}

function drawCard(doc, frame, c, family) {
    // The roomiest sizes that fit one page — or, failing all, two pages.
    let m = METRICS[METRICS.length - 1];
    let p = plan(doc, frame, c, m);
    for (const metrics of METRICS) {
        const tryPlan = plan(doc, frame, c, metrics);
        const total = Object.values(tryPlan.heights).reduce((a, b) => a + b, 0);
        if (TOP + total <= BOTTOM) { m = metrics; p = tryPlan; break; }
    }
    const room = () => BOTTOM - p.heights.foot;   // where the signatures begin
    doc.addPage();
    let y = drawHeader(doc, frame, c, family, TOP);
    y = drawWho(doc, c, y);
    y = drawTable(doc, frame, c, p, m, y);
    if (c.overall) y = drawOverall(doc, frame, c, y);

    // Whatever does not fit above the signatures goes on to the next page, whole.
    const next = (h) => {
        if (y + h <= room()) return;
        drawContinued(doc, frame, c);
        y = TOP + 30;
    };
    if (p.heights.coAtt) { next(p.heights.coAtt); y = drawCoAtt(doc, c, y); }
    next(p.heights.remarks); y = drawRemarks(doc, c, p, y);
    if (p.heights.subjectRemarks) { next(p.heights.subjectRemarks); y = drawSubjectRemarks(doc, p, m, y); }
    if (c.promotion) { next(p.heights.promotion); y = drawPromotion(doc, c, y); }
    if (p.heights.scale) { next(p.heights.scale); y = drawScale(doc, frame, y); }
    drawFoot(doc, frame, y);
}

function drawContinued(doc, frame, c) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.muted)
        .text(`${String(frame.school?.name || '').toUpperCase()} · REPORT CARD (CONTINUED) · ${c.student.name}`, L, TOP, { width: W, align: 'center', lineBreak: false });
    doc.moveTo(L, TOP + 16).lineTo(L + W, TOP + 16).lineWidth(0.8).strokeColor(C.line).stroke();
}

function drawHeader(doc, frame, c, family, y0) {
    const school = frame.school || {};
    let y = y0;
    const logo = schoolLogoPath(school);
    if (logo) {
        try { doc.image(logo, L, y, { fit: [50, 50] }); } catch { /* an unreadable image: the name alone */ }
    }
    // The card's own check: scan to see the school issued exactly this.
    const qr = c.verification?.url;
    if (qr && drawQr(doc, qr, L + W - 50, y, 50)) {
        doc.font('Helvetica').fontSize(5.5).fillColor(C.muted).text(`Verify: ${c.verification.code}`, L + W - 64, y + 53, { width: 78, align: 'center', lineBreak: false });
    }
    const textW = W - 130;
    doc.font('Helvetica-Bold').fontSize(16).fillColor(C.ink).text(fit(doc, String(school.name || '').toUpperCase(), textW), L + 65, y + 2, { width: textW, align: 'center', lineBreak: false });
    y += 22;
    if (school.address) { doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(fit(doc, school.address, textW), L + 65, y, { width: textW, align: 'center', lineBreak: false }); y += 12; }
    const meta = [school.board, school.code ? `School code ${school.code}` : '', school.phone, school.email].filter(Boolean).join('  ·  ');
    if (meta) { doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(fit(doc, meta, textW), L + 65, y, { width: textW, align: 'center', lineBreak: false }); y += 11; }
    y = Math.max(y, y0 + 62) + 6;
    doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1.6).strokeColor('#1E2452').stroke();
    y += 10;

    const title = family && !c.complete ? 'PROGRESS REPORT' : 'REPORT CARD';
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(C.primary).text(title, L, y, { width: W, align: 'center', characterSpacing: 2, lineBreak: false });
    y += 16;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.muted)
        .text(`Academic Year ${frame.year?.yearName || ''}${c.termLabel ? ` · ${c.termLabel}` : ''}`, L, y, { width: W, align: 'center', lineBreak: false });
    y += 18;
    if (c.withheld) {
        doc.rect(L, y, W, 18).fill(C.held);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.heldInk)
            .text(fit(doc, `Result withheld${c.withheld.reason ? ` — ${c.withheld.reason}` : ''}`, W - 16), L + 8, y + 5, { width: W - 16, lineBreak: false });
        y += 24;
    }
    return y;
}

function drawWho(doc, c, y) {
    const who = [
        ['Student', c.student.name], ['Admission No.', c.student.admissionNumber || '—'],
        ['Class & Section', classLine(c.student)], ['Roll No.', c.student.rollNumber || '—'],
        ['Date of Birth', c.student.dob ? fmtDay(c.student.dob) : '—'], ['Parent / Guardian', c.student.parents?.length ? c.student.parents.join(', ') : '—'],
    ];
    const boxH = 3 * 15 + 10;
    doc.rect(L, y, W, boxH).fill(C.soft);
    doc.rect(L, y, W, boxH).lineWidth(0.6).strokeColor(C.line).stroke();
    who.forEach(([k, v], i) => {
        const col = i % 2; const row = Math.floor(i / 2);
        const x = L + 10 + col * (W / 2); const yy = y + 6 + row * 15;
        doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(k, x, yy, { width: 90, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink);
        doc.text(fit(doc, v, W / 2 - 110), x + 92, yy, { width: W / 2 - 110, lineBreak: false });
    });
    return y + boxH + 10;
}

function drawTable(doc, frame, c, p, m, y0) {
    let y = y0;
    const points = !!frame.showGradePoints;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1E2452').text('SCHOLASTIC AREAS', L, y, { characterSpacing: 0.8, lineBreak: false });
    y += 13;
    const o = c.overall;
    const cols = p.cols;
    if (!cols.length) {
        doc.rect(L, y, W, 26).dash(3, { space: 2 }).strokeColor(C.line).stroke().undash();
        doc.font('Helvetica').fontSize(9).fillColor(C.muted).text('No results have been published for this year yet.', L, y + 9, { width: W, align: 'center', lineBreak: false });
        return y + 34;
    }
    const figures = frame.showClassFigures && c.subjects.some((s) => s.classFigures);
    const subjW = Math.max(90, Math.min(140, W * 0.22));
    const figW = figures ? 58 : 0;
    const groupW = (W - subjW - figW) / cols.length;
    // Narrow columns drop the grade point before anything else.
    const withPoints = points && groupW >= 66;
    const parts = withPoints ? [0.46, 0.3, 0.24] : [0.6, 0.4];
    const titleOf = (e) => (e.overall ? (c.method === 'weighted' ? 'Year' : 'Total') : e.title);
    // A long exam name gets a second line rather than being cut off.
    doc.font('Helvetica-Bold').fontSize(m.small);
    const twoLines = cols.some((e) => doc.widthOfString(titleOf(e)) > groupW - 4);
    const hdrH = m.hdr + (twoLines ? 8 : 0);
    const titleH = hdrH - 13;
    doc.font('Helvetica-Bold').fontSize(m.small - 0.5);
    const gradeLabel = doc.widthOfString('Grade') + 6 <= groupW * parts[1] ? 'Grade' : 'Gr.';
    const marksLabel = doc.widthOfString('Marks') + 6 <= groupW * parts[0] ? 'Marks' : 'Mk.';
    const header = () => {
        cell(doc, 'Subject', L, y, subjW, hdrH, { bold: true, align: 'left', bg: C.band, size: m.font });
        cols.forEach((e, i) => {
            const x = L + subjW + i * groupW;
            const title = titleOf(e);
            doc.rect(x, y, groupW, titleH).fill(C.band);
            doc.rect(x, y, groupW, titleH).lineWidth(0.6).strokeColor(C.line).stroke();
            doc.font('Helvetica-Bold').fontSize(m.small).fillColor(C.ink);
            const lineH = doc.currentLineHeight(true);
            const lines = doc.widthOfString(title) > groupW - 4 ? 2 : 1;
            doc.text(title, x + 2, y + Math.max(1, (titleH - lines * lineH) / 2), { width: groupW - 4, align: 'center', height: titleH - 1, ellipsis: true });
            const labels = withPoints ? [marksLabel, gradeLabel, 'GP'] : [marksLabel, gradeLabel];
            let cx = x;
            labels.forEach((lab, j) => { cell(doc, lab, cx, y + titleH, groupW * parts[j], 13, { bold: true, size: m.small - 0.5, bg: C.band }); cx += groupW * parts[j]; });
        });
        if (figures) cell(doc, 'Class avg / high', L + subjW + cols.length * groupW, y, figW, hdrH, { bold: true, size: m.small - 0.5, bg: C.band });
        y += hdrH;
    };
    header();
    const paper = (x, top, data) => {
        let cx = x;
        doc.font('Helvetica').fontSize(m.font);
        const marks = markText(doc, data, groupW * parts[0] - 6);
        const color = !data ? C.faint : data.absent ? C.muted : data.passed === false ? C.fail : C.ink;
        cell(doc, marks, cx, top, groupW * parts[0], m.rowH, { color, size: m.font }); cx += groupW * parts[0];
        cell(doc, !data ? '' : data.absent ? 'AB' : data.grade || '—', cx, top, groupW * parts[1], m.rowH, { bold: true, size: m.font }); cx += groupW * parts[1];
        if (withPoints) cell(doc, !data || data.absent ? '' : data.point ?? '—', cx, top, groupW * parts[2], m.rowH, { size: m.font });
    };
    c.subjects.forEach((s) => {
        // A table longer than the page carries on, header and all.
        if (y + m.rowH > BOTTOM - 20) { drawContinued(doc, frame, c); y = TOP + 30; header(); }
        cell(doc, s.subjectName, L, y, subjW, m.rowH, { bold: true, align: 'left', size: m.font });
        s.cells.forEach((x, i) => paper(L + subjW + i * groupW, y, x));
        if (p.many && o) paper(L + subjW + c.exams.length * groupW, y, s.total ? { marks: s.total.marks ?? `${s.total.percentage}%`, max: s.total.max ?? '', grade: s.total.grade, point: s.total.point, passed: s.total.passed } : s.cells.find(Boolean));
        if (figures) cell(doc, s.classFigures ? `${s.classFigures.avgPct}% / ${s.classFigures.topPct}%` : '—', L + subjW + cols.length * groupW, y, figW, m.rowH, { size: m.small });
        y += m.rowH;
    });
    // Totals, percentage, result, rank.
    cell(doc, 'Total', L, y, subjW, m.rowH, { bold: true, align: 'left', bg: C.soft, size: m.font });
    cols.forEach((e, i) => {
        const t = e.overall ? { marks: o.marks, max: o.max, grade: o.grade, point: o.point, pct: o.percentage } : { marks: e.total, max: e.max, grade: e.grade, point: e.point };
        let cx = L + subjW + i * groupW;
        const text = t.marks === null || t.marks === undefined ? `${t.pct ?? '—'}%` : `${t.marks}/${t.max}`;
        doc.font('Helvetica-Bold').fontSize(m.font);
        cell(doc, doc.widthOfString(text) <= groupW * parts[0] - 6 ? text : (t.marks ?? `${t.pct}%`), cx, y, groupW * parts[0], m.rowH, { bold: true, bg: C.soft, size: m.font }); cx += groupW * parts[0];
        cell(doc, t.grade || '—', cx, y, groupW * parts[1], m.rowH, { bold: true, bg: C.soft, size: m.font }); cx += groupW * parts[1];
        if (withPoints) cell(doc, t.point ?? '—', cx, y, groupW * parts[2], m.rowH, { bg: C.soft, size: m.font });
    });
    if (figures) cell(doc, '', L + subjW + cols.length * groupW, y, figW, m.rowH, { bg: C.soft });
    y += m.rowH;
    const soFar = (passed) => (c.complete ? (passed ? 'Passed' : 'Not passed') : (passed ? 'Passing so far' : 'Not passing so far'));
    const footRow = (label, valueOf, colorOf) => {
        cell(doc, label, L, y, subjW, m.rowH, { bold: true, align: 'left', bg: C.soft, size: m.font });
        cols.forEach((e, i) => cell(doc, valueOf(e), L + subjW + i * groupW, y, groupW, m.rowH, { bold: true, bg: C.soft, color: colorOf ? colorOf(e) : C.ink, size: m.font }));
        if (figures) cell(doc, '', L + subjW + cols.length * groupW, y, figW, m.rowH, { bg: C.soft });
        y += m.rowH;
    };
    footRow('Percentage', (e) => pct(e.overall ? o.percentage : e.percentage));
    footRow('Result', (e) => (e.overall ? soFar(o.isPassed) : e.withheld ? 'Withheld' : e.isPassed ? 'Passed' : 'Not passed'),
        (e) => ((e.overall ? o.isPassed : e.isPassed) ? C.pass : C.fail));
    if (frame.showRank && (c.exams.some((e) => e.rank) || o?.rank)) {
        footRow('Rank', (e) => { const r = e.overall ? o : e; return r.rank ? `${r.rank} of ${r.outOf}` : '—'; });
    }
    y += 4;
    const notes = [];
    if (c.subjects.some((s) => s.cells.some((x) => x?.grace))) notes.push('* Includes grace marks.');
    if (c.basis === 'all' && c.exams.length > 1) notes.push('Every published exam of the year is shown; none is marked to count towards the overall result, so the total adds them all.');
    if (c.method === 'weighted') notes.push('The year is worked out by the school\'s weighting of its assessments, as percentages.');
    if (notes.length) { doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(notes.join('  '), L, y, { width: W, lineBreak: false, ellipsis: true }); y += 14; }
    return y + 4;
}

function drawOverall(doc, frame, c, y) {
    const o = c.overall;
    const points = !!frame.showGradePoints;
    const h = 32;
    doc.rect(L, y, W, h).fill(C.overallBg);
    doc.rect(L, y, W, h).lineWidth(0.6).strokeColor(C.overallLine).stroke();
    const result = c.complete ? (o.isPassed ? 'Passed' : 'Not passed') : (o.isPassed ? 'Passing so far' : 'Not passing so far');
    const items = [
        ...(o.marks !== null && o.marks !== undefined ? [['OVERALL', `${o.marks} / ${o.max}`]] : []), ['PERCENTAGE', pct(o.percentage)],
        ['GRADE', `${o.grade}${points && o.point !== null && o.point !== undefined ? ` (${o.point})` : ''}`], ['RESULT', result],
        ...(frame.showRank && o.rank ? [['RANK IN SECTION', `${o.rank} of ${o.outOf}`]] : []),
        ...(frame.showRank && o.classRank ? [['RANK IN CLASS', `${o.classRank} of ${o.classOutOf}`]] : []),
    ];
    const w = W / items.length;
    items.forEach(([k, v], i) => {
        doc.font('Helvetica').fontSize(6.5).fillColor(C.muted).text(k, L + 10 + i * w, y + 6, { width: w - 12, characterSpacing: 0.5, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(k === 'RESULT' ? (o.isPassed ? C.pass : C.fail) : C.ink);
        doc.text(fit(doc, v, w - 12), L + 10 + i * w, y + 15, { width: w - 12, lineBreak: false });
    });
    return y + h + 10;
}

function drawCoAtt(doc, c, y0) {
    const half = (W - 16) / 2;
    let leftY = y0; let rightY = y0;
    if (c.coScholastic.length) {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1E2452').text('CO-SCHOLASTIC AREAS', L, leftY, { characterSpacing: 0.8, lineBreak: false });
        leftY += 14;
        c.coScholastic.forEach((a) => {
            cell(doc, a.label, L, leftY, half - 54, 14, { align: 'left', size: 8 });
            cell(doc, a.grade || '—', L + half - 54, leftY, 54, 14, { bold: true, size: 8.5 });
            leftY += 14;
        });
    }
    if (c.attendance) {
        const x = c.coScholastic.length ? L + half + 16 : L;
        const w = c.coScholastic.length ? half : W;
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1E2452').text('ATTENDANCE', x, rightY, { characterSpacing: 0.8, lineBreak: false });
        rightY += 14;
        doc.rect(x, rightY, w, 24).lineWidth(0.6).strokeColor(C.line).stroke();
        const a = c.attendance;
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink)
            .text(a.total ? `${a.attended} / ${a.total} days · ${pct(a.percentage)}` : 'No attendance has been marked this year.', x + 8, rightY + 7, { width: w - 16, lineBreak: false });
        rightY += 28;
        if (a.total) {
            doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(`${fmtDay(a.from)} to ${fmtDay(a.to)}. A half day counts as half.`, x, rightY, { width: w, lineBreak: false });
            rightY += 12;
        }
    }
    return Math.max(leftY, rightY) + 10;
}

function drawRemarks(doc, c, p, y0) {
    let y = y0;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1E2452').text("CLASS TEACHER'S REMARKS", L, y, { characterSpacing: 0.8, lineBreak: false });
    y += 14;
    const text = p.remarksText;
    const rh = Math.max(36, heightOf(doc, text || ' ', 9, W - 16) + 14);
    doc.rect(L, y, W, rh).lineWidth(0.6).strokeColor(C.line).stroke();
    doc.font('Helvetica').fontSize(9).fillColor(text === c.remarks ? C.ink : C.muted).text(text, L + 8, y + 7, { width: W - 16 });
    return y + rh + 8;
}

function drawSubjectRemarks(doc, p, m, y0) {
    let y = y0;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1E2452').text("SUBJECT TEACHERS' REMARKS", L, y, { characterSpacing: 0.8, lineBreak: false });
    y += 14;
    p.subjectRemarks.forEach((s) => {
        const h = heightOf(doc, `${s.subjectName}: ${s.remarks}`, m.font, W - 8);
        doc.font('Helvetica-Bold').fontSize(m.font).fillColor(C.ink).text(`${s.subjectName}: `, L + 4, y, { width: W - 8, continued: true })
            .font('Helvetica').fillColor(C.muted).text(s.remarks);
        y += h + 3;
    });
    return y + 6;
}

function drawPromotion(doc, c, y) {
    const kind = c.promotion.kind;
    const text = kind === 'passedOut'
        ? `Passed out of ${classLine(c.promotion)}.`
        : `${kind === 'repeated' ? 'Continues in' : 'Promoted to'} ${classLine(c.promotion)}${c.promotion.yearName ? ` for ${c.promotion.yearName}` : ''}.`;
    doc.rect(L, y, W, 20).fill(C.promoBg);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#14532D').text(text, L + 8, y + 6, { width: W - 16, lineBreak: false });
    return y + 26;
}

function drawScale(doc, frame, y) {
    const points = !!frame.showGradePoints;
    const scale = (frame.scale || []).map((r) => `${r.grade} ${r.from === 0 && r.to < 100 ? `below ${Number.isInteger(r.to) ? r.to + 1 : r.to}%` : `${r.from}–${r.to}%`}${points && r.point !== null && r.point !== undefined ? ` (${r.point})` : ''}`);
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(fit(doc, `Grades: ${scale.join(' · ')} · AB Absent`, W), L, y, { width: W, lineBreak: false });
    return y + 16;
}

/** Signatures — and the head's signature and the school seal, when the school gave them — at the foot. */
function drawFoot(doc, frame, y) {
    const footY = Math.max(y + 30, BOTTOM - (frame.footer ? 34 : 18));
    const sw = (W - 40) / 3;
    const sig = frame.principalSignature ? schoolLogoPath(frame.principalSignature) : null;
    const seal = frame.schoolSeal ? schoolLogoPath(frame.schoolSeal) : null;
    ['Class Teacher', 'Parent / Guardian', frame.principalTitle || 'Principal'].forEach((label, i) => {
        const x = L + i * (sw + 20);
        if (i === 2 && sig) { try { doc.image(sig, x + sw / 2 - 45, footY - 32, { fit: [90, 30], align: 'center', valign: 'bottom' }); } catch { /* unreadable: the line alone */ } }
        if (i === 2 && seal) { try { doc.save(); doc.opacity(0.85); doc.image(seal, x - 52, footY - 44, { fit: [48, 48] }); doc.restore(); } catch { /* unreadable */ } }
        doc.moveTo(x, footY).lineTo(x + sw, footY).lineWidth(0.8).strokeColor('#1E2452').stroke();
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1E2452').text(label, x, footY + 4, { width: sw, align: 'center', lineBreak: false });
    });
    if (frame.footer) {
        doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(fit(doc, frame.footer, W), L, footY + 20, { width: W, align: 'center', lineBreak: false });
    }
}

module.exports = { renderReportCards, renderReportCardsBuffer };
