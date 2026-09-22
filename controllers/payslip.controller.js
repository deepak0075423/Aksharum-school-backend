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
    res.status(500).json({ success: false, message: e.message || 'Something went wrong' });
};

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
        generatePayslipPDF(res, payslip, filename, school);
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
        generatePayslipPDF(res, payslip, filename, school);
    } catch (e) { fail(res, e); }
};

/**
 * A year's salary on one page — the thing people are actually asked for when a
 * landlord or a bank wants proof of income, and which previously did not exist
 * at any level of the module.
 *
 * Built from the same report engine the admin screen uses, scoped to the
 * caller, so the two can never disagree about what a year came to.
 */
exports.downloadMyStatement = async (req, res) => {
    try {
        const settings = await admin.settingsFor(req.schoolId);
        const now = new Date();
        const asked = String(req.query.year || '').trim();
        const fy = asked && /^\d{4}(-\d{2})?$/.test(asked)
            ? financialYear(settings.financialYearStartMonth, settings.financialYearStartMonth, Number(asked.slice(0, 4)))
            : financialYear(settings.financialYearStartMonth, now.getMonth() + 1, now.getFullYear());

        // The report engine works a calendar year at a time; a financial year
        // spans two, so both are built and the months outside it dropped.
        const parts = await Promise.all(
            [...new Set([fy.from.year, fy.to.year])].map(y =>
                admin.buildReport(req.schoolId, { type: 'employee', year: y, employeeId: String(req.userId) })));
        const built = parts[0];
        const rows = parts.flatMap(b => b.rows).filter(r => {
            const [mon, yr] = String(r.period).split(' ');
            const m = MONTHS_SHORT.indexOf(mon);
            return m > 0 && inFy(fy, m, Number(yr));
        });
        if (!rows.length) {
            return res.status(400).json({ success: false, message: `No payslips have been issued for ${fy.label} yet.` });
        }

        const [school, user, profile] = await Promise.all([
            School.findById(req.schoolId).select('name address email phone logo').lean(),
            User.findById(req.userId).select('name').lean(),
            TeacherProfile.findOne({ user: req.userId, school: req.schoolId }).select('employeeId designation').lean(),
        ]);
        const summary = {
            employees: 1,
            gross: r2(rows.reduce((s, r) => s + num(r.gross), 0)),
            deductions: r2(rows.reduce((s, r) => s + num(r.deductions), 0)),
            net: r2(rows.reduce((s, r) => s + num(r.net), 0)),
        };
        const { renderReportPdf } = require('../utils/payrollReportPdf');
        renderReportPdf(res, {
            filename: `salary_statement_${fy.label}.pdf`,
            title: `Salary Statement — ${user?.name || ''}${profile?.employeeId ? ` (${profile.employeeId})` : ''}`,
            period: `Financial Year ${fy.label}`,
            school, columns: built.columns, rows, summary,
        });
    } catch (e) { fail(res, e); }
};
