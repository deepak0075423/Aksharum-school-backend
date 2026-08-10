const PDFDocument = require('pdfkit');

const C = {
    headerBg:    '#1E3A5F',
    primary:     '#3B82F6',
    primaryDark: '#1D4ED8',
    lightBg:     '#F0F4F8',
    white:       '#FFFFFF',
    textDark:    '#1E293B',
    textMuted:   '#64748B',
    border:      '#CBD5E1',
    earning:     '#16A34A',
    deduction:   '#DC2626',
    netBg:       '#1D4ED8',
    netText:     '#FBBF24',
    altRow:      '#F8FAFC',
};

const INR = (n) =>
    '₹ ' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MONTH_NAMES = [
    '', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

function generatePayslipPDF(res, payslip, filename) {
    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
        bufferPages: true,
        autoFirstPage: true,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'payslip.pdf'}"`);
    doc.pipe(res);

    _drawPayslip(doc, payslip);
    doc.end();
}

function _drawPayslip(doc, payslip) {
    const ML = 50, MR = 50;
    const W  = doc.page.width;
    const contentW = W - ML - MR;
    const tableX = ML - 10;
    const tableW = contentW + 20;
    const colW   = tableW / 2;

    // ── Header band ──────────────────────────────────────────────
    doc.rect(tableX, 30, tableW, 72).fill(C.headerBg);

    const schoolName = (payslip.schoolSnapshot && payslip.schoolSnapshot.name) || 'School';
    doc.font('Helvetica-Bold').fontSize(18).fillColor(C.white)
       .text(schoolName, tableX, 40, { width: tableW, align: 'center' });

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#93C5FD')
       .text('SALARY SLIP', tableX, 62, { width: tableW, align: 'center' });

    const monthLabel = `${MONTH_NAMES[payslip.month] || ''} ${payslip.year}`;
    doc.font('Helvetica').fontSize(8.5).fillColor('#BFDBFE')
       .text(`For the period: ${monthLabel}`, tableX, 78, { width: tableW, align: 'center' });

    let y = 120;

    // ── Employee details box ──────────────────────────────────────
    doc.rect(tableX, y, tableW, 72).fill(C.lightBg);
    doc.rect(tableX, y, tableW, 72).stroke(C.border).lineWidth(0.5);

    const emp = payslip.employeeSnapshot || {};
    const leftX  = tableX + 12;
    const rightX = tableX + colW + 12;

    _detailCell(doc, leftX,  y + 10, 'EMPLOYEE NAME',  emp.name        || '—');
    _detailCell(doc, rightX, y + 10, 'EMPLOYEE ID',    emp.employeeId  || '—');
    _detailCell(doc, leftX,  y + 40, 'DESIGNATION',    emp.designation || '—');
    _detailCell(doc, rightX, y + 40, 'DEPARTMENT',     emp.department  || '—');

    y += 84;

    // ── Earnings / Deductions table header ────────────────────────
    doc.rect(tableX,        y, colW, 22).fill(C.primary);
    doc.rect(tableX + colW, y, colW, 22).fill(C.primaryDark);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.white)
       .text('EARNINGS',    tableX,        y + 6, { width: colW, align: 'center' })
       .text('DEDUCTIONS',  tableX + colW, y + 6, { width: colW, align: 'center' });

    y += 22;

    const earnings   = payslip.earnings   || [];
    const deductions = payslip.deductions || [];

    // Add LOP to deductions display list
    const dispDeductions = [...deductions];
    if ((payslip.lopDays || 0) > 0) {
        dispDeductions.push({ name: `LOP (${payslip.lopDays} days)`, amount: payslip.lopAmount || 0 });
    }

    const maxRows = Math.max(earnings.length, dispDeductions.length);

    for (let i = 0; i < maxRows; i++) {
        const bg = i % 2 === 0 ? C.white : C.altRow;
        const rowH = 18;
        doc.rect(tableX, y, tableW, rowH).fill(bg);
        doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(C.border).lineWidth(0.3).stroke();
        doc.moveTo(tableX + colW, y).lineTo(tableX + colW, y + rowH).strokeColor(C.border).lineWidth(0.3).stroke();

        if (earnings[i]) {
            doc.font('Helvetica').fontSize(8).fillColor(C.textDark)
               .text(earnings[i].name, tableX + 8, y + 5, { width: colW * 0.6 - 8 });
            doc.font('Helvetica-Bold').fontSize(8).fillColor(C.earning)
               .text(INR(earnings[i].amount), tableX + colW * 0.6, y + 5, { width: colW * 0.4 - 8, align: 'right' });
        }

        if (dispDeductions[i]) {
            doc.font('Helvetica').fontSize(8).fillColor(C.textDark)
               .text(dispDeductions[i].name, tableX + colW + 8, y + 5, { width: colW * 0.6 - 8 });
            doc.font('Helvetica-Bold').fontSize(8).fillColor(C.deduction)
               .text(INR(dispDeductions[i].amount), tableX + colW + colW * 0.6, y + 5, { width: colW * 0.4 - 8, align: 'right' });
        }

        y += rowH;
    }

    // ── Totals row ────────────────────────────────────────────────
    doc.rect(tableX, y, tableW, 24).fill('#EFF6FF');
    doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.moveTo(tableX + colW, y).lineTo(tableX + colW, y + 24).strokeColor(C.border).lineWidth(0.5).stroke();

    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.textDark)
       .text('Gross Earnings', tableX + 8, y + 7, { width: colW * 0.6 - 8 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.earning)
       .text(INR(payslip.grossSalary), tableX + colW * 0.6, y + 7, { width: colW * 0.4 - 8, align: 'right' });

    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.textDark)
       .text('Total Deductions', tableX + colW + 8, y + 7, { width: colW * 0.6 - 8 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.deduction)
       .text(INR(payslip.totalDeductions), tableX + colW + colW * 0.6, y + 7, { width: colW * 0.4 - 8, align: 'right' });

    y += 32;

    // ── Net salary band ───────────────────────────────────────────
    doc.rect(tableX, y, tableW, 38).fill(C.netBg);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.white)
       .text('NET SALARY', tableX + 16, y + 12);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(C.netText)
       .text(INR(payslip.netSalary), tableX + tableW - 180, y + 12, { width: 172, align: 'right' });

    y += 54;

    // ── Extras row (arrears / bonus) if present ───────────────────
    if ((payslip.arrears || 0) > 0 || (payslip.bonus || 0) > 0) {
        doc.rect(tableX, y, tableW, 20).fill(C.lightBg);
        doc.font('Helvetica').fontSize(8).fillColor(C.textMuted)
           .text(
               `Arrears: ${INR(payslip.arrears)}   |   Bonus: ${INR(payslip.bonus)}`,
               tableX, y + 6, { width: tableW, align: 'center' }
           );
        y += 26;
    }

    y += 10;

    // ── Footer ────────────────────────────────────────────────────
    doc.rect(tableX, y, tableW, 1).fill(C.border);
    y += 8;
    const genDate = payslip.generatedAt
        ? new Date(payslip.generatedAt).toLocaleDateString('en-IN')
        : new Date().toLocaleDateString('en-IN');

    doc.font('Helvetica').fontSize(7.5).fillColor(C.textMuted)
       .text(
           `Generated on: ${genDate}   |   This is a computer-generated payslip and does not require a signature.`,
           tableX, y, { width: tableW, align: 'center' }
       );
}

function _detailCell(doc, x, y, label, value) {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.textMuted).text(label, x, y);
    doc.font('Helvetica').fontSize(9.5).fillColor(C.textDark).text(value, x, y + 11);
}

module.exports = { generatePayslipPDF };
