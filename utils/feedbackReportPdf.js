'use strict';
// PDF renderer for the feedback reports (spec §18). Deliberately generic: it
// draws whatever {columns, rows} buildReport() produced, so a new report type
// needs no change here.
//
// The privacy rule survives the export — a row whose aggregate was withheld
// arrives with avgRating null and note "Insufficient responses", and that is
// exactly what gets printed.
const PDFDocument = require('pdfkit');
const { schoolLogoPath } = require('./schoolLogoFile');

const C = {
    headerBg:  '#1E3A5F',
    primary:   '#4F46E5',
    lightBg:   '#F0F4F8',
    white:     '#FFFFFF',
    textDark:  '#1E293B',
    textMuted: '#64748B',
    border:    '#CBD5E1',
    altRow:    '#F8FAFC',
    good:      '#16A34A',
    warn:      '#D97706',
    bad:       '#DC2626',
};

const PAGE = { size: 'A4', marginX: 36, top: 36, bottom: 40 };

function ratingColor(v) {
    if (v == null) return C.textMuted;
    if (v >= 4) return C.good;
    if (v >= 3) return C.warn;
    return C.bad;
}

function cellText(row, col) {
    const v = row[col.key];
    if (v === null || v === undefined || v === '') return col.key === 'avgRating' ? '—' : '';
    if (col.key === 'avgRating') return Number(v).toFixed(1);
    if (col.key === 'responseRate') return `${v}%`;
    return String(v);
}

function buildFeedbackReportPDF(res, { report, school, filename }) {
    const doc = new PDFDocument({ size: PAGE.size, margin: PAGE.marginX, bufferPages: true });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'feedback_report.pdf'}"`);
    doc.pipe(res);

    const W = doc.page.width - PAGE.marginX * 2;
    const X = PAGE.marginX;

    // ── Header band ─────────────────────────────────────────────────────────
    doc.rect(X, PAGE.top, W, 62).fill(C.headerBg);
    const logo = schoolLogoPath(school);
    if (logo) {
        try { doc.image(logo, X + 12, PAGE.top + 8, { fit: [46, 46] }); } catch { /* unreadable logo */ }
    }
    doc.font('Helvetica-Bold').fontSize(16).fillColor(C.white)
        .text(school?.name || 'School', X, PAGE.top + 12, { width: W, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#93C5FD')
        .text(report.title.toUpperCase(), X, PAGE.top + 33, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#BFDBFE')
        .text(`Generated ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`,
            X, PAGE.top + 47, { width: W, align: 'center' });

    let y = PAGE.top + 76;

    // ── Scope strip ─────────────────────────────────────────────────────────
    const names = report.meta?.campaignNames || [];
    const scope = names.length
        ? `${report.meta.campaigns} campaign(s): ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4} more` : ''}`
        : 'No campaigns matched the selected filters.';
    doc.rect(X, y, W, 26).fill(C.lightBg).stroke(C.border);
    doc.font('Helvetica').fontSize(8).fillColor(C.textMuted)
        .text(scope, X + 10, y + 9, { width: W - 20 });
    y += 38;

    if (!report.rows.length) {
        doc.font('Helvetica').fontSize(11).fillColor(C.textMuted)
            .text('No data for the selected filters.', X, y + 20, { width: W, align: 'center' });
        doc.end();
        return;
    }

    // ── Column geometry ─────────────────────────────────────────────────────
    // The first column is the label and gets the slack; numeric columns are
    // fixed-width so the table stays readable regardless of report type.
    const numericKeys = new Set(['assigned', 'responses', 'pending', 'responseRate', 'avgRating', 'teachers']);
    const cols = report.columns;
    const fixed = cols.map((c, i) => (i === 0 ? null : numericKeys.has(c.key) ? 52 : 74));
    const usedFixed = fixed.reduce((s, v) => s + (v || 0), 0);
    const widths = fixed.map((v) => (v == null ? Math.max(90, W - usedFixed) : v));

    const drawHeader = () => {
        doc.rect(X, y, W, 20).fill(C.primary);
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.white);
        let cx = X;
        cols.forEach((c, i) => {
            doc.text(c.label.toUpperCase(), cx + 5, y + 6.5, {
                width: widths[i] - 8, align: i === 0 ? 'left' : 'center', ellipsis: true, lineBreak: false,
            });
            cx += widths[i];
        });
        y += 20;
    };

    drawHeader();

    const rowH = 17;
    report.rows.forEach((row, i) => {
        if (y + rowH > doc.page.height - PAGE.bottom) {
            doc.addPage();
            y = PAGE.top;
            drawHeader();
        }
        doc.rect(X, y, W, rowH).fill(i % 2 === 0 ? C.white : C.altRow);
        doc.moveTo(X, y).lineTo(X + W, y).strokeColor(C.border).lineWidth(0.3).stroke();

        let cx = X;
        cols.forEach((c, ci) => {
            const isRating = c.key === 'avgRating';
            doc.font(isRating ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5)
                .fillColor(isRating ? ratingColor(row[c.key]) : C.textDark)
                .text(cellText(row, c), cx + 5, y + 5, {
                    width: widths[ci] - 8, align: ci === 0 ? 'left' : 'center', ellipsis: true, lineBreak: false,
                });
            cx += widths[ci];
        });
        y += rowH;
    });

    doc.rect(X, y, W, 0.8).fill(C.border);
    y += 10;
    doc.font('Helvetica-Oblique').fontSize(7).fillColor(C.textMuted)
        .text('Rows marked "Insufficient responses" are withheld to protect respondent anonymity. Feedback is collected anonymously and individual responses are never identifiable.',
            X, y, { width: W });

    // Page numbers
    const range = doc.bufferedPageRange();
    for (let p = 0; p < range.count; p += 1) {
        doc.switchToPage(range.start + p);
        doc.font('Helvetica').fontSize(7).fillColor(C.textMuted)
            .text(`Page ${p + 1} of ${range.count}`, X, doc.page.height - 26, { width: W, align: 'center' });
    }

    doc.end();
}

module.exports = { buildFeedbackReportPDF };
