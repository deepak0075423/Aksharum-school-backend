const PDFDocument = require('pdfkit');

// ── Palette ────────────────────────────────────────────────────
const HEADER_BG  = '#E8EEF4';
const RECESS_BG  = '#FEF9C3';
const CELL_BG    = '#FFFFFF';
const BORDER     = '#94A3B8';
const TEXT_DARK  = '#1E293B';
const TEXT_MUTED = '#64748B';
const PRIMARY    = '#3B82F6';
const RECESS_TXT = '#92400E';

/**
 * Stream a multi-page PDF to `res`.
 *
 * @param {import('express').Response} res
 * @param {Array}  pages      - array of page-data objects (see _drawPage)
 * @param {string} schoolName
 * @param {string} filename   - suggested download filename
 */
function generateTimetablePDF(res, pages, schoolName, filename) {
    const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margins: { top: 30, bottom: 30, left: 30, right: 30 },
        bufferPages: true,
        autoFirstPage: false
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'timetable.pdf'}"`);
    doc.pipe(res);

    pages.forEach(page => {
        doc.addPage();
        _drawPage(doc, page, schoolName);
    });

    doc.end();
}

// ── Draw one page ──────────────────────────────────────────────
function _drawPage(doc, data, schoolName) {
    const { className, sectionName, yearName, timetable, entries, days } = data;
    if (!timetable || !timetable.periodsStructure || !timetable.periodsStructure.length) return;

    const W = doc.page.width;
    const H = doc.page.height;
    const ML = 30, MR = 30, MT = 30, MB = 30;
    const contentW = W - ML - MR;

    // ── Header ────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(14).fillColor(TEXT_DARK)
       .text(schoolName || 'School', ML, MT, { width: contentW, align: 'center' });

    doc.font('Helvetica-Bold').fontSize(11).fillColor(PRIMARY)
       .text(`${className} \u2013 Section ${sectionName}`, ML, MT + 19, { width: contentW, align: 'center' });

    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED)
       .text(
           `Academic Year: ${yearName}   |   School Timings: ${timetable.schoolStartTime} \u2013 ${timetable.schoolEndTime}`,
           ML, MT + 35, { width: contentW, align: 'center' }
       );

    const lineY = MT + 50;
    doc.moveTo(ML, lineY).lineTo(ML + contentW, lineY)
       .strokeColor(BORDER).lineWidth(0.5).stroke();

    // ── Table geometry ────────────────────────────────────────
    const tableTop    = lineY + 7;
    const tableH      = H - MB - tableTop;
    const HDR_ROW_H   = 40;
    const DAY_ROW_H   = (tableH - HDR_ROW_H) / days.length;

    const periods   = timetable.periodsStructure;
    const DAY_COL_W = 62;
    const RECESS_W  = 40;
    const recessCnt = periods.filter(p => p.isRecess).length;
    const periodCnt = periods.filter(p => !p.isRecess).length;
    const PER_COL_W = (contentW - DAY_COL_W - recessCnt * RECESS_W) / periodCnt;

    // ── Header row ────────────────────────────────────────────
    let x = ML;
    _cell(doc, x, tableTop, DAY_COL_W, HDR_ROW_H, {
        text: 'Day / Time', bold: true, bg: HEADER_BG, fontSize: 8
    });
    x += DAY_COL_W;

    periods.forEach(p => {
        const cw = p.isRecess ? RECESS_W : PER_COL_W;
        if (p.isRecess) {
            _cell(doc, x, tableTop, cw, HDR_ROW_H, {
                text: 'Break', bold: true, bg: RECESS_BG, fontSize: 7
            });
        } else {
            _cell(doc, x, tableTop, cw, HDR_ROW_H, {
                text: `P${p.periodNumber}`,
                sub: `${p.startTime}\n${p.endTime}`,
                bold: true,
                bg: HEADER_BG,
                fontSize: 8
            });
        }
        x += cw;
    });

    // ── Data rows ─────────────────────────────────────────────
    days.forEach((day, di) => {
        const y = tableTop + HDR_ROW_H + di * DAY_ROW_H;
        x = ML;

        _cell(doc, x, y, DAY_COL_W, DAY_ROW_H, {
            text: day, bold: true, bg: HEADER_BG, fontSize: 8
        });
        x += DAY_COL_W;

        periods.forEach(p => {
            const cw = p.isRecess ? RECESS_W : PER_COL_W;
            if (p.isRecess) {
                _cell(doc, x, y, cw, DAY_ROW_H, {
                    text: p.recessName || 'Lunch',
                    bg: RECESS_BG,
                    color: RECESS_TXT,
                    fontSize: 7
                });
            } else {
                const e = entries.find(
                    en => en.dayOfWeek === day && en.periodNumber === p.periodNumber
                );
                if (e) {
                    const extras = (e.additionalSubjects || [])
                        .filter(a => a.subject)
                        .map(a => ({ text: a.subject?.subjectName || '', sub: a.teacher?.name || '' }));
                    _cell(doc, x, y, cw, DAY_ROW_H, {
                        text: e.subject?.subjectName || '\u2014',
                        sub: e.teacher?.name || '',
                        extras,
                        bold: true,
                        bg: CELL_BG,
                        color: PRIMARY,
                        subColor: TEXT_MUTED,
                        fontSize: 7.5
                    });
                } else {
                    _cell(doc, x, y, cw, DAY_ROW_H, {
                        text: '\u2014',
                        bg: CELL_BG,
                        color: TEXT_MUTED,
                        fontSize: 8
                    });
                }
            }
            x += cw;
        });
    });
}

// ── Draw one table cell ────────────────────────────────────────
function _cell(doc, x, y, w, h, opts) {
    const {
        text     = '',
        sub      = '',
        extras   = [],   // [{text, sub}] additional subjects
        bold     = false,
        bg       = CELL_BG,
        color    = TEXT_DARK,
        subColor = TEXT_MUTED,
        fontSize = 8
    } = opts;

    // Background + border
    doc.rect(x, y, w, h).fillAndStroke(bg, BORDER);

    const pad  = 3;
    const tw   = w - 2 * pad;
    const lh   = fontSize + 2.5;
    const slh  = Math.max(fontSize - 1, 6) + 2;
    const efs  = Math.max(fontSize - 1, 6);   // extra subject font size
    const elh  = efs + 2.5;
    const eslh = Math.max(efs - 1, 5) + 2;

    const mainLines = String(text).split('\n');
    const subLines  = sub ? String(sub).split('\n') : [];

    // Calculate total height to vertically centre content
    let extraH = 0;
    extras.forEach(ex => {
        extraH += 3; // divider gap
        extraH += String(ex.text || '').split('\n').length * elh;
        if (ex.sub) extraH += String(ex.sub).split('\n').length * eslh;
    });
    const totalH = mainLines.length * lh + subLines.length * slh + extraH;
    let ty = y + (h - totalH) / 2;
    if (ty < y + pad) ty = y + pad;

    // Primary subject text
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(color);
    mainLines.forEach(line => {
        doc.text(line, x + pad, ty, { width: tw, align: 'center', lineBreak: false, ellipsis: true });
        ty += lh;
    });

    // Primary teacher / sub text
    if (subLines.length) {
        doc.font('Helvetica').fontSize(Math.max(fontSize - 1, 6)).fillColor(subColor);
        subLines.forEach(line => {
            doc.text(line, x + pad, ty, { width: tw, align: 'center', lineBreak: false, ellipsis: true });
            ty += slh;
        });
    }

    // Additional subjects
    extras.forEach(ex => {
        ty += 2;
        // Thin divider
        doc.moveTo(x + pad * 2, ty).lineTo(x + w - pad * 2, ty)
           .strokeColor('#CBD5E1').lineWidth(0.3).stroke();
        ty += 2;

        const etLines = String(ex.text || '').split('\n');
        const esLines = ex.sub ? String(ex.sub).split('\n') : [];

        doc.font('Helvetica-Bold').fontSize(efs).fillColor(PRIMARY);
        etLines.forEach(line => {
            if (ty < y + h - pad) {
                doc.text(line, x + pad, ty, { width: tw, align: 'center', lineBreak: false, ellipsis: true });
                ty += elh;
            }
        });

        if (esLines.length) {
            doc.font('Helvetica').fontSize(Math.max(efs - 1, 5)).fillColor(TEXT_MUTED);
            esLines.forEach(line => {
                if (ty < y + h - pad) {
                    doc.text(line, x + pad, ty, { width: tw, align: 'center', lineBreak: false, ellipsis: true });
                    ty += eslh;
                }
            });
        }
    });

    doc.fillColor(TEXT_DARK); // reset
}

/**
 * Stream a single-page PDF containing only a text message.
 * Used when there is no data to render (e.g. no timetables for the year).
 */
function generateMessagePDF(res, message, filename) {
    const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margins: { top: 30, bottom: 30, left: 30, right: 30 },
        autoFirstPage: true
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'timetable.pdf'}"`);
    doc.pipe(res);

    const W = doc.page.width;
    const H = doc.page.height;

    doc.font('Helvetica').fontSize(14).fillColor(TEXT_MUTED)
       .text(message, 0, H / 2 - 20, { width: W, align: 'center' });

    doc.end();
}

module.exports = { generateTimetablePDF, generateMessagePDF };
