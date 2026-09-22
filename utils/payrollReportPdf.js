'use strict';
/**
 * A generic table report as a PDF — used by every payroll report, so a school
 * downloading "Deductions" and "Salary Register" gets two documents that look
 * like they came from the same office.
 *
 * Landscape A4, because a salary register has one column per pay component and
 * portrait would truncate the columns that matter. Column widths are shared out
 * by content weight rather than evenly: an employee name needs room and a
 * two-digit day count does not.
 */
const PDFDocument = require('pdfkit');
const { schoolLogoPath } = require('./schoolLogoFile');

const C = {
    ink: '#1E293B', muted: '#64748B', line: '#CBD5E1', soft: '#F1F5F9',
    head: '#1E3A5F', accent: '#4F46E5', alt: '#F8FAFC', white: '#FFFFFF',
};

const INR = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function renderReportPdf(res, { filename, title, period, school, columns, rows, summary }) {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 36, bottom: 40, left: 32, right: 32 }, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'report.pdf'}"`);
    doc.pipe(res);

    const L = doc.page.margins.left;
    const W = doc.page.width - L - doc.page.margins.right;

    // Weight each column by how wide its content tends to be, then scale to fit.
    const weights = columns.map((c) => {
        if (c.align === 'right') return 1;
        const longest = rows.reduce((m, r) => Math.max(m, String(r[c.key] ?? '').length), String(c.label).length);
        return Math.max(1, Math.min(3, longest / 9));
    });
    const totalWeight = weights.reduce((s, w) => s + w, 0) || 1;
    const widths = weights.map(w => (w / totalWeight) * W);

    const drawHeader = () => {
        doc.rect(0, 0, doc.page.width, 74).fill(C.head);
        let x = L;
        const logo = schoolLogoPath(school);
        if (logo) {
            try { doc.image(logo, x, 16, { fit: [42, 42] }); x += 52; } catch { /* a missing logo must not break the report */ }
        }
        doc.fillColor(C.white).font('Helvetica-Bold').fontSize(14).text(school?.name || 'School', x, 18, { width: W - (x - L) });
        doc.font('Helvetica').fontSize(9).fillColor('#C7D2FE').text(school?.address || '', x, 36, { width: W - (x - L), height: 22 });
        doc.font('Helvetica-Bold').fontSize(12).fillColor(C.white)
            .text(title, L, 18, { width: W, align: 'right' });
        doc.font('Helvetica').fontSize(9).fillColor('#C7D2FE')
            .text(period || '', L, 36, { width: W, align: 'right' });
        doc.fillColor(C.ink);
    };

    const drawColumnHeads = (y) => {
        doc.rect(L, y, W, 20).fill(C.soft);
        let x = L;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.ink);
        columns.forEach((c, i) => {
            doc.text(String(c.label), x + 4, y + 6.5, { width: widths[i] - 8, align: c.align === 'right' ? 'right' : 'left', lineBreak: false, ellipsis: true });
            x += widths[i];
        });
        doc.moveTo(L, y + 20).lineTo(L + W, y + 20).strokeColor(C.line).lineWidth(0.6).stroke();
        return y + 20;
    };

    drawHeader();
    let y = 86;
    y = drawColumnHeads(y);

    const rowH = 17;
    doc.font('Helvetica').fontSize(7.5);
    rows.forEach((r, idx) => {
        if (y + rowH > doc.page.height - doc.page.margins.bottom - 30) {
            doc.addPage();
            drawHeader();
            y = drawColumnHeads(86);
            doc.font('Helvetica').fontSize(7.5);
        }
        if (idx % 2 === 1) doc.rect(L, y, W, rowH).fill(C.alt);
        let x = L;
        columns.forEach((c, i) => {
            const raw = r[c.key];
            const text = c.money ? INR(raw) : (raw === null || raw === undefined ? '' : String(raw));
            doc.fillColor(C.ink).text(text, x + 4, y + 5, { width: widths[i] - 8, align: c.align === 'right' ? 'right' : 'left', lineBreak: false, ellipsis: true });
            x += widths[i];
        });
        y += rowH;
    });

    // Totals band.
    if (summary) {
        if (y + 34 > doc.page.height - doc.page.margins.bottom) { doc.addPage(); drawHeader(); y = 86; }
        y += 6;
        doc.rect(L, y, W, 26).fill(C.accent);
        doc.fillColor(C.white).font('Helvetica-Bold').fontSize(9);
        const parts = [
            `Employees: ${summary.employees ?? 0}`,
            `Gross: ${INR(summary.gross)}`,
            `Deductions: ${INR(summary.deductions)}`,
            `Net: ${INR(summary.net)}`,
        ];
        doc.text(parts.join('     ·     '), L + 10, y + 8, { width: W - 20 });
        y += 26;
    }

    // Footer on every page.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.font('Helvetica').fontSize(7).fillColor(C.muted)
            .text(`Generated ${new Date().toLocaleString('en-IN')}`, L, doc.page.height - 28, { width: W / 2 })
            .text(`Page ${i + 1} of ${range.count}`, L + W / 2, doc.page.height - 28, { width: W / 2, align: 'right' });
    }

    doc.end();
}

module.exports = { renderReportPdf };
