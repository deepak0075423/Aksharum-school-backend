'use strict';
/**
 * Payslips — the admin's download, and everything the employee's own two
 * screens need (Sep 2026 redesign).
 *
 * The employee side is framed by the FINANCIAL year, not the calendar year: a
 * payslip's reason for existing is tax and proof of income, and both are
 * reckoned April to March here. Payslips are stored by calendar month and year,
 * so a financial year spans two of them — the range is resolved below rather
 * than left to each caller to get wrong.
 */
const Payslip     = require('../models/Payslip');
const PayrollRun  = require('../models/PayrollRun');
const School      = require('../models/School');
const User        = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');
const { generatePayslipPDF } = require('../utils/payslipPdf');
const admin = require('./payrollAdmin.controller');

const MONTH_NAMES = [
    '', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2  = (n) => Math.round(num(n) * 100) / 100;
const fail = (res, e) => {
    console.error('[Payslip]', e);
    res.status(500).json({ success: false, message: 'Something went wrong on our side. Please try again.' });
};
const trim = (s) => String(s ?? '').trim();
const pdfOpts = async (schoolId) => ({ note: (await admin.settingsFor(schoolId)).payslipNote || '' });

/**
 * The financial year that contains {month, year}, as the pair of calendar
 * years it spans plus the label a person would write.
 *
 *   startMonth 4, Sep 2026  ->  { from: {y:2026,m:4}, to: {y:2027,m:3}, label: '2026-27' }
 *   startMonth 1, Sep 2026  ->  { from: {y:2026,m:1}, to: {y:2026,m:12}, label: '2026' }
 */
function financialYear(startMonth, month, year) {
    const s = Math.min(12, Math.max(1, num(startMonth) || 4));
    const startYear = month >= s ? year : year - 1;
    const endYear = s === 1 ? startYear : startYear + 1;
    const endMonth = s === 1 ? 12 : s - 1;
    return {
        startMonth: s, startYear, endYear, endMonth,
        label: s === 1 ? String(startYear) : `${startYear}-${String(endYear).slice(-2)}`,
        from: { year: startYear, month: s },
        to: { year: endYear, month: endMonth },
    };
}
/** Is {month, year} inside this financial year? */
const inFy = (fy, month, year) =>
    (year > fy.from.year || (year === fy.from.year && month >= fy.from.month)) &&
    (year < fy.to.year || (year === fy.to.year && month <= fy.to.month));

// ── Admin: download one payslip ──────────────────────────────────────────────

exports.adminDownloadPayslip = async (req, res) => {
    try {
        const payslip = await Payslip.findOne({ _id: req.params.id, school: req.schoolId });
        if (!payslip) return res.status(404).json({ success: false, message: 'Payslip not found' });

        const name     = payslip.employeeSnapshot?.name?.replace(/\s+/g, '_') || 'employee';
        const filename = `payslip_${name}_${MONTH_NAMES[payslip.month]}_${payslip.year}.pdf`;
        const school   = await School.findById(req.schoolId).select('name logo').lean();
        generatePayslipPDF(res, payslip, filename, school, await pdfOpts(req.schoolId));
    } catch (e) { fail(res, e); }
};

// ── Employee: my payslips ────────────────────────────────────────────────────

const shapeSlip = (p) => ({
    _id: p._id,
    slipNo: p.slipNo || '',
    month: p.month, year: p.year,
    period: `${MONTHS_SHORT[p.month]} ${p.year}`,
    periodLong: `${MONTH_NAMES[p.month]} ${p.year}`,
    grossSalary: r2(p.grossSalary), totalDeductions: r2(p.totalDeductions), netSalary: r2(p.netSalary),
    workingDays: num(p.workingDays), paidDays: num(p.paidDays),
    lopDays: num(p.lopDays), lopAmount: r2(p.lopAmount),
    arrears: r2(p.arrears), bonus: r2(p.bonus), otherDeductions: r2(p.otherDeductions),
    reimbursement: r2(p.reimbursement), advanceRecovery: r2(p.advanceRecovery),
    settlementAmount: r2(p.settlementAmount), tds: r2(p.tds),
    paidOn: p.paidOn || null, paymentRef: p.paymentRef || '',
    employerCost: r2(p.employerCost),
    paymentMode: p.employeeSnapshot?.paymentMode || 'bank_transfer',
    generatedAt: p.generatedAt || p.createdAt,
});

exports.getMyPayslips = async (req, res) => {
    try {
        const settings = await admin.settingsFor(req.schoolId);
        const now = new Date();

        // Every payslip this person has, so the year picker can only offer
        // years that actually have one — a dropdown of empty years is a dead end.
        const all = await Payslip.find({ employee: req.userId, school: req.schoolId })
            .sort({ year: -1, month: -1 }).lean();

        const fys = [];
        const seen = new Set();
        for (const p of all) {
            const fy = financialYear(settings.financialYearStartMonth, p.month, p.year);
            if (!seen.has(fy.label)) { seen.add(fy.label); fys.push(fy); }
        }
        const current = financialYear(settings.financialYearStartMonth, now.getMonth() + 1, now.getFullYear());
        if (!seen.has(current.label)) fys.unshift(current);

        const asked = String(req.query.year || '').trim();
        const fy = fys.find(f => f.label === asked) || fys[0] || current;
        const slips = all.filter(p => inFy(fy, p.month, p.year));

        const sum = (key) => r2(slips.reduce((s, p) => s + num(p[key]), 0));
        res.json({
            success: true,
            data: slips.map(shapeSlip),
            summary: {
                count: slips.length,
                gross: sum('grossSalary'),
                deductions: sum('totalDeductions'),
                net: sum('netSalary'),
                lopDays: r2(slips.reduce((s, p) => s + num(p.lopDays), 0)),
                // What the school spent on this person, gross plus employer cost.
                cost: r2(sum('grossSalary') + sum('employerCost')),
            },
            financialYear: { label: fy.label, from: fy.from, to: fy.to },
            years: fys.map(f => f.label),
        });
    } catch (e) { fail(res, e); }
};

exports.getPayslipDetail = async (req, res) => {
    try {
        const payslip = await Payslip.findOne({ _id: req.params.id, employee: req.userId, school: req.schoolId }).lean();
        if (!payslip) return res.status(404).json({ success: false, message: 'Payslip not found' });
        const settings = await admin.settingsFor(req.schoolId);
        res.json({
            success: true,
            data: {
                ...payslip,
                ...shapeSlip(payslip),
                earnings: payslip.earnings || [],
                deductions: payslip.deductions || [],
                employerContributions: payslip.employerContributions || [],
                note: settings.payslipNote || '',
            },
        });
    } catch (e) { fail(res, e); }
};

exports.downloadPayslip = async (req, res) => {
    try {
        const payslip = await Payslip.findOne({ _id: req.params.id, employee: req.userId, school: req.schoolId });
        if (!payslip) return res.status(404).json({ success: false, message: 'Payslip not found' });

        const filename = `payslip_${MONTH_NAMES[payslip.month]}_${payslip.year}.pdf`;
        const school   = await School.findById(req.schoolId).select('name logo').lean();
        generatePayslipPDF(res, payslip, filename, school, await pdfOpts(req.schoolId));
    } catch (e) { fail(res, e); }
};

/** The financial year a request is asking about ("2026-27" or "2026"), else the current one. */
function askedFy(settings, asked) {
    const now = new Date();
    const text = trim(asked);
    return text && /^\d{4}(-\d{2})?$/.test(text)
        ? financialYear(settings.financialYearStartMonth, settings.financialYearStartMonth, Number(text.slice(0, 4)))
        : financialYear(settings.financialYearStartMonth, now.getMonth() + 1, now.getFullYear());
}

/**
 * A year's salary on one page — the thing people are actually asked for when a
 * landlord or a bank wants proof of income.
 *
 * Built from the PAYSLIPS, and from nothing else. It used to be built from the
 * admin report engine, which reads payroll entries through their runs, and
 * that went wrong in two ways an employee could see:
 *
 *   • a month still in draft appeared on the statement, with its figures, as
 *     though it had been paid — and so did a month held back;
 *   • runs are read through the academic year in view, so a statement for any
 *     OTHER financial year came back "no payslips issued", always.
 *
 * A payslip exists only for money that was issued, and is not year-scoped.
 */
exports.downloadMyStatement = async (req, res) => {
    try {
        const settings = await admin.settingsFor(req.schoolId);
        const fy = askedFy(settings, req.query.year);
        const slips = (await Payslip.find({ employee: req.userId, school: req.schoolId })
            .sort({ year: 1, month: 1 }).lean()).filter(p => inFy(fy, p.month, p.year));
        if (!slips.length) {
            return res.status(400).json({ success: false, message: `No payslips have been issued for ${fy.label} yet.` });
        }

        const [school, user, profile] = await Promise.all([
            School.findById(req.schoolId).select('name address email phone logo').lean(),
            User.findById(req.userId).select('name').lean(),
            TeacherProfile.findOne({ user: req.userId, school: req.schoolId }).select('employeeId designation panNumber').lean(),
        ]);
        const rows = slips.map(p => ({
            period: `${MONTHS_SHORT[p.month]} ${p.year}`,
            slipNo: p.slipNo || '',
            paidDays: num(p.paidDays), lopDays: num(p.lopDays),
            gross: r2(p.grossSalary), deductions: r2(p.totalDeductions),
            // Everything else that moved the net, as one signed figure.
            other: r2(num(p.arrears) + num(p.bonus) + num(p.reimbursement) + num(p.settlementAmount)
                - num(p.otherDeductions) - num(p.advanceRecovery)),
            net: r2(p.netSalary),
        }));
        const { renderReportPdf } = require('../utils/payrollReportPdf');
        renderReportPdf(res, {
            filename: `salary_statement_${fy.label}.pdf`,
            title: 'Salary Statement',
            period: `Financial Year ${fy.label}`,
            school,
            lines: [
                `${user?.name || ''}${profile?.employeeId ? `  ·  ${profile.employeeId}` : ''}${profile?.designation ? `  ·  ${profile.designation}` : ''}`,
                profile?.panNumber ? `PAN ${String(profile.panNumber).toUpperCase()}` : '',
            ],
            columns: [
                { key: 'period', label: 'Period' },
                { key: 'slipNo', label: 'Payslip' },
                { key: 'paidDays', label: 'Paid Days', align: 'right' },
                { key: 'lopDays', label: 'LOP Days', align: 'right' },
                { key: 'gross', label: 'Gross Pay', align: 'right', money: true },
                { key: 'deductions', label: 'Deductions', align: 'right', money: true },
                { key: 'other', label: 'Other Pay / Recoveries', align: 'right', money: true },
                { key: 'net', label: 'Net Pay', align: 'right', money: true },
            ],
            rows,
            summary: {
                employees: 1,
                gross: r2(rows.reduce((s, r) => s + r.gross, 0)),
                deductions: r2(rows.reduce((s, r) => s + r.deductions, 0)),
                net: r2(rows.reduce((s, r) => s + r.net, 0)),
            },
            footnote: 'Only months for which a payslip has been issued are listed.',
        });
    } catch (e) { fail(res, e); }
};

// ── Employee: my tax ─────────────────────────────────────────────────────────

/**
 * My own year for tax: what was paid, what was taxable, how the tax is worked
 * out and what has been withheld. An employee had no way to see any of this —
 * TDS simply appeared on the payslip — and no way to get the annual statement
 * the school could print for itself.
 */
exports.getMyTax = async (req, res) => {
    try {
        const settings = await admin.settingsFor(req.schoolId);
        const fy = askedFy(settings, req.query.year);
        // Reads runs, so it must not follow the academic year in view.
        const built = await require('../services/yearScope').allYears(() => admin.taxStatement(req.schoolId, req.userId, fy.from.year));
        if (!built) return res.json({ success: true, data: { hasData: false, financialYear: fy.label } });
        res.json({
            success: true,
            data: {
                hasData: true, financialYear: fy.label, regime: built.regime,
                rows: built.rows, monthly: built.monthly, summary: built.summary,
            },
        });
    } catch (e) { fail(res, e); }
};

exports.downloadMyTaxStatement = async (req, res) => {
    try {
        const settings = await admin.settingsFor(req.schoolId);
        const fy = askedFy(settings, req.query.year);
        const built = await require('../services/yearScope').allYears(() => admin.taxStatement(req.schoolId, req.userId, fy.from.year));
        if (!built) return res.status(400).json({ success: false, message: `No payslips have been issued for ${fy.label} yet.` });
        const school = await School.findById(req.schoolId).select('name address email phone logo').lean();
        const { renderReportPdf } = require('../utils/payrollReportPdf');
        renderReportPdf(res, {
            filename: `tax_statement_${fy.label}.pdf`,
            title: built.title, period: built.periodLabel, school,
            lines: [
                `${built.employee.name}${built.employee.empCode ? `  ·  ${built.employee.empCode}` : ''}${built.employee.pan ? `  ·  PAN ${built.employee.pan}` : ''}`,
                [built.employer.tan ? `Employer TAN ${built.employer.tan}` : '', built.employer.pan ? `Employer PAN ${built.employer.pan}` : ''].filter(Boolean).join('  ·  '),
            ],
            columns: built.columns, rows: built.rows, summary: null,
            footnote: 'This is the school’s statement of salary paid and tax deducted. The Form 16 certificate itself is issued through the Income Tax Department’s TRACES portal.',
        });
    } catch (e) { fail(res, e); }
};

// ── Employee: my claims and advances ─────────────────────────────────────────

const SalaryClaim   = require('../models/SalaryClaim');
const SalaryAdvance = require('../models/SalaryAdvance');

const shapeMyClaim = (c) => ({
    _id: c._id, category: c.category || 'Other', amount: r2(c.amount),
    description: c.description || '', claimedOn: c.claimedOn, status: c.status,
    decisionNote: c.decisionNote || '', paidOn: c.paidOn || null,
});

/**
 * Expense claims were something the office typed in on a person's behalf: an
 * employee could neither submit one nor see what had become of it. They can
 * now do both — a claim they submit waits as `pending` for the office.
 */
exports.getMyClaims = async (req, res) => {
    try {
        const { allYears } = require('../services/yearScope');
        // Their own money, whichever year is in view.
        const [claims, advances] = await allYears(() => Promise.all([
            SalaryClaim.find({ employee: req.userId, school: req.schoolId }).sort({ claimedOn: -1 }).limit(100).lean(),
            SalaryAdvance.find({ employee: req.userId, school: req.schoolId, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).limit(50).lean(),
        ]));
        res.json({
            success: true,
            data: {
                claims: claims.map(shapeMyClaim),
                advances: advances.map(a => ({
                    _id: a._id, kind: a.kind, amount: r2(a.amount), recovered: r2(a.recovered),
                    outstanding: r2(Math.max(0, num(a.amount) - num(a.recovered))),
                    instalments: num(a.instalments), instalmentAmount: r2(a.instalmentAmount),
                    status: a.status, reason: a.reason || '',
                    startLabel: `${MONTHS_SHORT[num(a.startMonth)] || ''} ${a.startYear}`,
                    history: (a.history || []).map(h => ({ label: `${MONTHS_SHORT[num(h.month)] || ''} ${h.year}`, amount: r2(h.amount) })),
                })),
                categories: ['Travel', 'Teaching materials', 'Phone / internet', 'Training', 'Medical', 'Other'],
            },
        });
    } catch (e) { fail(res, e); }
};

exports.createMyClaim = async (req, res) => {
    try {
        const b = req.body || {};
        const amount = num(b.amount);
        if (!(amount > 0)) return res.status(400).json({ success: false, message: 'Enter the amount you spent' });
        if (amount > 500000) return res.status(400).json({ success: false, message: 'That is more than a claim can be raised for here. Speak to the accounts office.' });
        const description = trim(b.description).slice(0, 500);
        if (description.length < 3) return res.status(400).json({ success: false, message: 'Say what the expense was for' });
        const when = b.claimedOn && /^\d{4}-\d{2}-\d{2}$/.test(String(b.claimedOn)) ? new Date(`${b.claimedOn}T00:00:00Z`) : new Date();
        if (when.getTime() > Date.now() + 86400000) return res.status(400).json({ success: false, message: 'The expense date cannot be in the future' });

        const claim = await SalaryClaim.create({
            employee: req.userId, school: req.schoolId,
            category: trim(b.category).slice(0, 60) || 'Other',
            amount, description, claimedOn: when, status: 'pending',
        });
        // Whoever runs payroll hears about it; the amount stays off the notice.
        try {
            const { notify } = require('../services/notifyService');
            const ids = (await require('../services/designationService').moduleAdminIds(req.schoolId, 'payroll'))
                .filter(id => String(id) !== String(req.userId));
            const me = await User.findById(req.userId).select('name').lean();
            if (ids.length) {
                notify({
                    school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                    title: '🧾 Expense claim submitted',
                    body: `${me?.name || 'An employee'} submitted a ${claim.category} claim for approval.`,
                    recipients: ids, link: { type: 'payroll.runs' },
                });
            }
        } catch (err) { console.warn('[Payslip] claim notice skipped:', err.message); }
        res.status(201).json({ success: true, data: shapeMyClaim(claim.toObject ? claim.toObject() : claim) });
    } catch (e) { fail(res, e); }
};

/** Withdraw my own claim — only while nobody has decided it. */
exports.deleteMyClaim = async (req, res) => {
    try {
        const claim = await SalaryClaim.findOne({ _id: req.params.id, employee: req.userId, school: req.schoolId }).lean();
        if (!claim) return res.status(404).json({ success: false, message: 'Claim not found' });
        if (claim.status !== 'pending') return res.status(400).json({ success: false, message: `This claim has already been ${claim.status} and cannot be withdrawn.` });
        await SalaryClaim.deleteOne({ _id: claim._id });
        res.json({ success: true, data: { _id: claim._id } });
    } catch (e) { fail(res, e); }
};
