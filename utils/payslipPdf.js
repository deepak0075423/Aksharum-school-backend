const path = require('path');
const PDFDocument = require('pdfkit');
const { schoolLogoPath } = require('./schoolLogoFile');

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

/**
 * The fonts.
 *
 * PDFKit's built-in Helvetica has no rupee sign: every "₹" on a payslip came
 * out as "¹", on every amount, on a document people hand to banks. The
 * school's own typeface (already shipped for the ID cards) has the glyph, so
 * the payslip and the payroll reports are set in it.
 */
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONTS = { 'Pay': '400', 'Pay-Semi': '600', 'Pay-Bold': '700' };
/**
 * The text face is the Latin subset, which stops short of the rupee sign; the
 * sign lives in the same typeface's extended subset, which has no letters. So
 * two files per weight: one for the words and figures, one for that one glyph,
 * and money() below sets an amount with both.
 *
 * In running sentences amounts are written "Rs." — a sentence cannot switch
 * font half-way without being laid out by hand.
 */
function registerPayFonts(doc) {
    const F = { regular: 'Helvetica', semi: 'Helvetica-Bold', bold: 'Helvetica-Bold', glyph: null, rupee: 'Rs. ' };
    try {
        for (const [key, weight] of Object.entries(FONTS)) {
            doc.registerFont(key, path.join(FONT_DIR, `PlusJakartaSans-${weight}.woff`));
        }
        Object.assign(F, { regular: 'Pay', semi: 'Pay-Semi', bold: 'Pay-Bold' });
    } catch { return F; }
    try {
        const glyph = {};
        for (const [key, weight] of Object.entries(FONTS)) {
            doc.registerFont(`${key}-Rupee`, path.join(FONT_DIR, `PlusJakartaSans-Rupee-${weight}.woff`));
            glyph[key] = `${key}-Rupee`;
        }
        F.glyph = glyph;
    } catch { /* no glyph file: money() writes "Rs." instead of the wrong sign */ }
    return F;
}

const amount = (n, digits = 2) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: 2 });

/**
 * Set one amount with a real rupee sign, inside the box [x, x + width].
 * `prefix` is anything that goes before the sign ("− ").
 */
function money(doc, F, value, x, y, width, { font, size = 8, color = '#1E293B', align = 'right', prefix = '', digits = 2 } = {}) {
    const face = font || F.regular;
    const figures = amount(value, digits);
    doc.fontSize(size).fillColor(color);
    if (!F.glyph || !F.glyph[face]) {
        doc.font(face).text(`${prefix}Rs. ${figures}`, x, y, { width, align, lineBreak: false });
        return;
    }
    doc.font(face);
    const lead = prefix ? doc.widthOfString(prefix) : 0;
    const body = doc.widthOfString(figures);
    doc.font(F.glyph[face]);
    const sign = doc.widthOfString('₹');
    const total = lead + sign + body;
    const start = align === 'right' ? x + width - total : align === 'center' ? x + (width - total) / 2 : x;
    if (prefix) doc.font(face).text(prefix, start, y, { lineBreak: false });
    doc.font(F.glyph[face]).text('₹', start + lead, y, { lineBreak: false });
    doc.font(face).text(figures, start + lead + sign, y, { lineBreak: false });
}

/** "XXXX 4521" — enough to confirm the account, and nothing more. */
const _mask = (v) => {
    const raw = String(v || '').replace(/\s+/g, '');
    if (!raw) return '';
    return raw.length <= 4 ? 'X'.repeat(raw.length) : `XXXX ${raw.slice(-4)}`;
};

const MONTH_NAMES = [
    '', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

const DEFAULT_NOTE = 'This is a computer generated payslip and does not require a signature.';

/**
 * @param opts.note      the footer line from Payroll settings
 * @param opts.password  locks the file; the reader types it to open the PDF
 */
function newDoc(opts = {}) {
    return new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
        bufferPages: true,
        autoFirstPage: true,
        ...(opts.password ? {
            userPassword: String(opts.password),
            ownerPassword: `${opts.password}-${Date.now()}`,
            permissions: { printing: 'highResolution', copying: true },
        } : {}),
    });
}

// `school` is optional — passed so the header can carry the school's own logo
// (the payslip snapshot only stores text fields).
function generatePayslipPDF(res, payslip, filename, school = null, opts = {}) {
    const doc = newDoc(opts);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'payslip.pdf'}"`);
    doc.pipe(res);
    _drawPayslip(doc, payslip, school, opts);
    doc.end();
}

/** Every payslip of a run in one file, a page each. */
function generatePayslipsPDF(res, payslips, filename, school = null, opts = {}) {
    const doc = newDoc(opts);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'payslips.pdf'}"`);
    doc.pipe(res);
    payslips.forEach((slip, i) => {
        if (i > 0) doc.addPage();
        _drawPayslip(doc, slip, school, opts);
    });
    doc.end();
}

function _drawPayslip(doc, payslip, school = null, opts = {}) {
    const F = registerPayFonts(doc);
    const INR = (n) => `Rs. ${amount(n)}`;          // in sentences only — see registerPayFonts()
    const ML = 50, MR = 50;
    const W  = doc.page.width;
    const contentW = W - ML - MR;
    const tableX = ML - 10;
    const tableW = contentW + 20;
    const colW   = tableW / 2;
    const n = (v) => Number(v) || 0;

    // ── Header band ──────────────────────────────────────────────
    doc.rect(tableX, 30, tableW, 72).fill(C.headerBg);
    const schoolName = (payslip.schoolSnapshot && payslip.schoolSnapshot.name) || school?.name || 'School';

    const logo = schoolLogoPath(school);
    if (logo) {
        try { doc.image(logo, tableX + 12, 40, { fit: [52, 52], align: 'left', valign: 'center' }); }
        catch { /* unreadable image — fall back to the name alone */ }
    }
    doc.font(F.bold).fontSize(17).fillColor(C.white)
       .text(schoolName, tableX + 70, 40, { width: tableW - 140, align: 'center', lineBreak: false, ellipsis: true });
    doc.font(F.semi).fontSize(10).fillColor('#93C5FD')
       .text('SALARY SLIP', tableX, 63, { width: tableW, align: 'center' });
    const monthLabel = `${MONTH_NAMES[payslip.month] || ''} ${payslip.year}`;
    const ref = payslip.slipNo ? `  ·  Slip ${payslip.slipNo}` : '';
    doc.font(F.regular).fontSize(8.5).fillColor('#BFDBFE')
       .text(`For the period: ${monthLabel}${ref}`, tableX, 80, { width: tableW, align: 'center' });

    let y = 118;

    // ── Employee details ──────────────────────────────────────────
    // PAN, UAN and the date of joining were snapshotted onto every payslip and
    // printed on none — and they are what a bank or a tax office asks for.
    const emp = payslip.employeeSnapshot || {};
    const boxH = 132;
    doc.rect(tableX, y, tableW, boxH).fill(C.lightBg);
    doc.rect(tableX, y, tableW, boxH).strokeColor(C.border).lineWidth(0.5).stroke();
    const leftX  = tableX + 12;
    const rightX = tableX + colW + 12;
    const cell = (x, yy, label, value) => {
        doc.font(F.semi).fontSize(7).fillColor(C.textMuted).text(label, x, yy);
        doc.font(F.regular).fontSize(9.5).fillColor(C.textDark)
           .text(String(value || '—'), x, yy + 11, { width: colW - 24, lineBreak: false, ellipsis: true });
    };

    const shortDays = n(payslip.lopDays) + n(payslip.notEmployedDays);
    const daysLabel = payslip.workingDays ? `${payslip.paidDays ?? payslip.workingDays} of ${payslip.workingDays}` : '—';
    const whyShort = [
        n(payslip.notEmployedDays) > 0 ? `${payslip.notEmployedDays} not employed` : '',
        n(payslip.lopDays) > 0 ? `${payslip.lopDays} unpaid leave` : '',
    ].filter(Boolean).join(', ');
    const joined = emp.joiningDate ? new Date(emp.joiningDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    const paidBy = emp.bankAccountNumber
        ? `${_mask(emp.bankAccountNumber)}${emp.bankIfsc ? `  ${emp.bankIfsc}` : ''}`
        : (emp.paymentMode === 'cash' ? 'Cash' : emp.paymentMode === 'cheque' ? 'Cheque' : '—');

    cell(leftX,  y + 10,  'EMPLOYEE NAME', emp.name);
    cell(rightX, y + 10,  'EMPLOYEE ID',   emp.employeeId);
    cell(leftX,  y + 40,  'DESIGNATION',   emp.designation);
    cell(rightX, y + 40,  'DEPARTMENT',    emp.department);
    cell(leftX,  y + 70,  'PAN',           emp.panNumber);
    cell(rightX, y + 70,  emp.uanNumber ? 'UAN' : 'DATE OF JOINING', emp.uanNumber || joined);
    cell(leftX,  y + 100, 'PAID DAYS',     shortDays > 0 ? `${daysLabel}  (${whyShort})` : daysLabel);
    cell(rightX, y + 100, 'PAID BY',       paidBy);
    y += boxH + 12;

    // ── Earnings / Deductions ─────────────────────────────────────
    doc.rect(tableX,        y, colW, 22).fill(C.primary);
    doc.rect(tableX + colW, y, colW, 22).fill(C.primaryDark);
    doc.font(F.semi).fontSize(9).fillColor(C.white)
       .text('EARNINGS',   tableX,        y + 6, { width: colW, align: 'center' })
       .text('DEDUCTIONS', tableX + colW, y + 6, { width: colW, align: 'center' });
    y += 22;

    /**
     * Each column lists exactly what its total adds up. The deductions column
     * used to list loss of pay as well — which is not a deduction, the
     * earnings beside it are already the reduced figures — so the column read
     * 1,800 + 200 + 6,385 over a total of 2,000.
     */
    const earnings   = payslip.earnings   || [];
    const deductions = payslip.deductions || [];
    const maxRows = Math.max(earnings.length, deductions.length, 1);
    for (let i = 0; i < maxRows; i++) {
        const rowH = 18;
        doc.rect(tableX, y, tableW, rowH).fill(i % 2 === 0 ? C.white : C.altRow);
        doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(C.border).lineWidth(0.3).stroke();
        doc.moveTo(tableX + colW, y).lineTo(tableX + colW, y + rowH).strokeColor(C.border).lineWidth(0.3).stroke();
        const line = (item, x, colour) => {
            if (!item) return;
            doc.font(F.regular).fontSize(8).fillColor(C.textDark)
               .text(item.name, x + 8, y + 5, { width: colW * 0.6 - 8, lineBreak: false, ellipsis: true });
            money(doc, F, item.amount, x + colW * 0.6, y + 5, colW * 0.4 - 8, { font: F.semi, size: 8, color: colour });
        };
        line(earnings[i], tableX, C.earning);
        line(deductions[i], tableX + colW, C.deduction);
        y += rowH;
    }

    doc.rect(tableX, y, tableW, 24).fill('#EFF6FF');
    doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.moveTo(tableX + colW, y).lineTo(tableX + colW, y + 24).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.font(F.bold).fontSize(9).fillColor(C.textDark).text('Gross Earnings', tableX + 8, y + 7, { width: colW * 0.6 - 8 });
    money(doc, F, payslip.grossSalary, tableX + colW * 0.6, y + 7, colW * 0.4 - 8, { font: F.bold, size: 9, color: C.earning });
    doc.font(F.bold).fontSize(9).fillColor(C.textDark).text('Total Deductions', tableX + colW + 8, y + 7, { width: colW * 0.6 - 8 });
    money(doc, F, payslip.totalDeductions, tableX + colW + colW * 0.6, y + 7, colW * 0.4 - 8, { font: F.bold, size: 9, color: C.deduction });
    y += 30;

    if (n(payslip.lopDays) > 0 && n(payslip.lopAmount) > 0) {
        doc.font(F.regular).fontSize(7.5).fillColor(C.textMuted)
           .text(`Loss of pay for ${payslip.lopDays} day${n(payslip.lopDays) === 1 ? '' : 's'}: ${INR(payslip.lopAmount)} less than a full month. The earnings above are already the reduced figures.`,
               tableX + 8, y, { width: tableW - 16 });
        y += 14;
    }

    /**
     * How the net is arrived at, line by line. Arrears and a bonus were a
     * footnote, and a reimbursement, a settlement and an advance instalment
     * were not printed at all — so the net at the bottom could not be worked
     * out from anything on the page.
     */
    const st = payslip.settlement || {};
    const settlementLabel = [
        n(st.leaveEncashment) > 0 ? `leave encashment ${INR(st.leaveEncashment)}` : '',
        n(st.gratuity) > 0 ? `gratuity ${INR(st.gratuity)}` : '',
    ].filter(Boolean).join(', ');
    const working = [
        ['Arrears', n(payslip.arrears), 1],
        ['Bonus', n(payslip.bonus), 1],
        ['Expenses reimbursed', n(payslip.reimbursement), 1],
        [`Final settlement${settlementLabel ? ` (${settlementLabel})` : ''}`, n(payslip.settlementAmount), 1],
        ['Other deductions', n(payslip.otherDeductions), -1],
        ['Advance / loan recovered', n(payslip.advanceRecovery), -1],
    ].filter(row => row[1] > 0);
    if (working.length) {
        const rows = [
            ['Gross earnings', n(payslip.grossSalary), 1],
            ['Total deductions', n(payslip.totalDeductions), -1],
            ...working,
        ];
        y += 4;
        for (const [label, value, sign] of rows) {
            doc.font(F.regular).fontSize(8.5).fillColor(C.textDark).text(label, tableX + 8, y, { width: tableW * 0.68 });
            money(doc, F, value, tableX + tableW * 0.68, y, tableW * 0.32 - 8,
                { font: F.semi, size: 8.5, color: sign > 0 ? C.textDark : C.deduction, prefix: sign > 0 ? '' : '− ' });
            y += 15;
        }
        y += 4;
    }

    // ── Net salary band ───────────────────────────────────────────
    doc.rect(tableX, y, tableW, 38).fill(C.netBg);
    doc.font(F.bold).fontSize(13).fillColor(C.white).text('NET SALARY', tableX + 16, y + 11);
    money(doc, F, payslip.netSalary, tableX + tableW - 236, y + 10, 220, { font: F.bold, size: 14, color: C.netText });
    y += 48;

    if (payslip.paidOn) {
        doc.font(F.regular).fontSize(8).fillColor(C.textMuted)
           .text(`Paid on ${new Date(payslip.paidOn).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}${payslip.paymentRef ? `  ·  Reference ${payslip.paymentRef}` : ''}`,
               tableX + 8, y, { width: tableW - 16 });
        y += 16;
    }

    /**
     * Employer contributions. Part of CTC, paid by the school, never deducted
     * from the employee — and therefore stated separately and plainly, so
     * nobody reads them as money taken off their pay.
     */
    const employer = payslip.employerContributions || [];
    if (employer.length) {
        doc.rect(tableX, y, tableW, 18).fill('#F1F5F9');
        doc.font(F.semi).fontSize(8).fillColor(C.textDark)
           .text('PAID BY THE SCHOOL ON YOUR BEHALF (not deducted from your salary)', tableX + 8, y + 5);
        y += 20;
        for (const line of employer) {
            doc.font(F.regular).fontSize(8).fillColor(C.textMuted).text(line.name, tableX + 8, y + 2, { width: tableW * 0.6 });
            money(doc, F, line.amount, tableX + tableW * 0.6, y + 2, tableW * 0.4 - 8, { font: F.regular, size: 8, color: C.textDark });
            y += 14;
        }
        y += 6;
    }

    // Why this month's tax is what it is, in one sentence.
    const tw = payslip.taxWorking;
    if (tw && n(payslip.tds) > 0) {
        doc.font(F.regular).fontSize(7.5).fillColor(C.textMuted)
           .text(`Income tax: on a projected taxable income of ${INR(tw.taxableIncome)} for FY ${tw.fy || ''}, the year's tax is ${INR(tw.annualTax)}. ${INR(tw.alreadyDeducted)} had been deducted before this month, and the rest is spread over ${tw.monthsRemaining} month${n(tw.monthsRemaining) === 1 ? '' : 's'}.`,
               tableX + 8, y, { width: tableW - 16 });
        y = doc.y + 6;
    }

    if (payslip.remarks) {
        doc.font(F.regular).fontSize(8).fillColor(C.textMuted)
           .text(`Remarks: ${payslip.remarks}`, tableX + 8, y, { width: tableW - 16 });
        y = doc.y + 6;
    }

    y += 8;

    // ── Footer ────────────────────────────────────────────────────
    doc.rect(tableX, y, tableW, 1).fill(C.border);
    y += 8;
    const genDate = (payslip.generatedAt ? new Date(payslip.generatedAt) : new Date()).toLocaleDateString('en-IN');
    // The footer line is a setting; it used to be ignored and this sentence
    // printed whatever the school had written.
    doc.font(F.regular).fontSize(7.5).fillColor(C.textMuted)
       .text(`Generated on: ${genDate}   |   ${String(opts.note || DEFAULT_NOTE).slice(0, 240)}`,
           tableX, y, { width: tableW, align: 'center' });
}

/**
 * The same payslip, as a Buffer instead of a response — so it can be attached
 * to the email that tells someone it exists, rather than only linked to.
 */
function renderPayslipBuffer(payslip, school = null, opts = {}) {
    return new Promise((resolve, reject) => {
        try {
            const doc = newDoc(opts);
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
            _drawPayslip(doc, payslip, school, opts);
            doc.end();
        } catch (e) { reject(e); }
    });
}

module.exports = { generatePayslipPDF, generatePayslipsPDF, renderPayslipBuffer, registerPayFonts, money };
