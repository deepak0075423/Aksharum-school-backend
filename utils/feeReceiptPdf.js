const PDFDocument = require('pdfkit');

const C = {
    headerBg:  '#1B4F72',
    primary:   '#2471A3',
    lightBg:   '#EBF5FB',
    white:     '#FFFFFF',
    textDark:  '#1A252F',
    textMuted: '#5D6D7E',
    border:    '#AED6F1',
    credit:    '#1E8449',
    debit:     '#C0392B',
    netBg:     '#1B4F72',
    netText:   '#F9E79F',
    altRow:    '#F4F6F7',
};

const INR = (n, sym = '₹') =>
    sym + ' ' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function generateReceiptPDF(res, payment, school, settings, filename) {
    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
        bufferPages: true,
        autoFirstPage: true,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'receipt.pdf'}"`);
    doc.pipe(res);
    _drawReceipt(doc, payment, school, settings);
    doc.end();
}

function _drawReceipt(doc, payment, school, settings) {
    const sym     = settings?.currencySymbol || '₹';
    const ML = 50, MR = 50;
    const W  = doc.page.width;
    const tableX = ML - 10;
    const tableW = W - ML - MR + 20;

    // ── Header ────────────────────────────────────────────────
    doc.rect(tableX, 30, tableW, 80).fill(C.headerBg);
    const schoolName = school?.name || (payment.schoolSnapshot?.name) || 'School';
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.white)
       .text(schoolName, tableX, 40, { width: tableW, align: 'center' });

    const headerText = settings?.receipt?.header || '';
    if (headerText) {
        doc.font('Helvetica').fontSize(9).fillColor('#AED6F1')
           .text(headerText, tableX, 64, { width: tableW, align: 'center' });
    }

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#AED6F1')
       .text('FEE RECEIPT', tableX, headerText ? 76 : 68, { width: tableW, align: 'center' });

    let y = 125;

    // ── Receipt meta ──────────────────────────────────────────
    doc.rect(tableX, y, tableW, 1).fill(C.border);
    y += 8;

    const metaLeft  = [
        ['Receipt No.', payment.receiptNumber || '—'],
        ['Date',        _fmtDate(payment.paymentDate)],
        ['Mode',        (payment.paymentMode || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())],
    ];
    const metaRight = [
        ['Student',     payment.student?.name || payment.studentSnapshot?.name || '—'],
        ['Status',      payment.paymentStatus || 'completed'],
        ['Ref. No.',    payment.transactionRef || payment.receiptNumber || '—'],
    ];

    doc.font('Helvetica').fontSize(9);
    metaLeft.forEach(([label, val], i) => {
        const ry = y + i * 18;
        doc.fillColor(C.textMuted).text(label + ':', tableX + 5, ry, { width: 80, align: 'right' });
        doc.fillColor(C.textDark).font('Helvetica-Bold').text(val, tableX + 90, ry, { width: tableW / 2 - 100 });
        doc.font('Helvetica');
    });
    metaRight.forEach(([label, val], i) => {
        const ry = y + i * 18;
        const lx = tableX + tableW / 2;
        doc.fillColor(C.textMuted).text(label + ':', lx, ry, { width: 70, align: 'right' });
        doc.fillColor(C.textDark).font('Helvetica-Bold').text(val, lx + 76, ry, { width: tableW / 2 - 80 });
        doc.font('Helvetica');
    });

    y += metaLeft.length * 18 + 12;
    doc.rect(tableX, y, tableW, 1).fill(C.border);
    y += 12;

    // ── Fee breakdown table ────────────────────────────────────
    const colW  = [tableW * 0.55, tableW * 0.45];
    const rowH  = 22;

    // Header row
    doc.rect(tableX, y, tableW, rowH).fill(C.primary);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.white);
    doc.text('Description', tableX + 8, y + 7, { width: colW[0] - 8 });
    doc.text('Amount', tableX + colW[0], y + 7, { width: colW[1] - 8, align: 'right' });
    y += rowH;

    const lines = payment.lines && payment.lines.length ? payment.lines : [{ feeName: 'Fee Payment', amount: payment.amount }];
    lines.forEach((line, idx) => {
        if (idx % 2 === 0) doc.rect(tableX, y, tableW, rowH).fill(C.altRow);
        doc.font('Helvetica').fontSize(9).fillColor(C.textDark);
        doc.text(line.feeName || 'Fee', tableX + 8, y + 7, { width: colW[0] - 8 });
        doc.fillColor(C.textDark).text(INR(line.amount, sym), tableX + colW[0], y + 7, { width: colW[1] - 8, align: 'right' });
        y += rowH;
    });

    // Total row
    doc.rect(tableX, y, tableW, rowH + 4).fill(C.netBg);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.netText);
    doc.text('TOTAL PAID', tableX + 8, y + 8, { width: colW[0] - 8 });
    doc.text(INR(payment.amount, sym), tableX + colW[0], y + 8, { width: colW[1] - 8, align: 'right' });
    y += rowH + 4 + 16;

    // Remarks
    if (payment.remarks) {
        doc.font('Helvetica').fontSize(9).fillColor(C.textMuted)
           .text(`Remarks: ${payment.remarks}`, tableX + 5, y);
        y += 16;
    }

    // Footer
    const footerText = settings?.receipt?.footer || 'Thank you for your payment. This is a computer-generated receipt.';
    const customNote  = settings?.receipt?.customNotes || '';
    y += 10;
    doc.rect(tableX, y, tableW, 1).fill(C.border);
    y += 10;
    doc.font('Helvetica').fontSize(8).fillColor(C.textMuted)
       .text(footerText, tableX, y, { width: tableW, align: 'center' });
    if (customNote) {
        y += 14;
        doc.text(customNote, tableX, y, { width: tableW, align: 'center' });
    }

    // Collected by signature area
    y += 40;
    doc.rect(tableX + tableW - 120, y, 115, 1).fill(C.textMuted);
    doc.font('Helvetica').fontSize(8).fillColor(C.textMuted)
       .text('Authorised Signature', tableX + tableW - 120, y + 4, { width: 115, align: 'center' });
}

function _fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

module.exports = { generateReceiptPDF };
