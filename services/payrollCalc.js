'use strict';
/**
 * The payroll engine — the ONE place a salary is computed.
 *
 * Every screen that shows a number (a run's entries, a structure preview, the
 * teacher's own CTC breakdown) calls in here, so the figure an admin approves
 * is the figure the teacher was shown and the figure the payslip prints.
 *
 * ── What the engine does that the old one did not ───────────────────────────
 *
 * 1. It reads the employee's CTC. The previous computeSalaryBreakdown() took
 *    `monthlyCtc` and used it only if a component happened to name 'CTC' as
 *    its percentage base — which no structure built through the UI ever did.
 *    Two employees on one structure were therefore paid identically however
 *    far apart their CTC. Here, `percentageOf: 'CTC'` and `calculationType:
 *    'balance'` make CTC the anchor, and a structure with a balance component
 *    pays out exactly the CTC.
 *
 * 2. It separates employer cost from gross. PF/ESI/gratuity paid BY the school
 *    sit inside CTC but are not earnings and are not deducted. Mixing them in
 *    either direction misstates both the payslip and the school's cost.
 *
 * 3. It pro-rates per component, not on the gross total. An allowance flagged
 *    `proRated: false` (a fixed reimbursement, professional tax) survives a
 *    short month, and a percentage deduction recomputes against the reduced
 *    base — so PF on a half month is half, which is what PF actually is.
 *
 * 4. It honours statutory limits: `wageCeiling` caps the base a percentage is
 *    taken of (PF's ₹15,000 wage), `capAmount` caps the resulting amount,
 *    `minAmount` floors it.
 *
 * ── Order of resolution ─────────────────────────────────────────────────────
 * Components resolve in `order`. A percentage may only name a component that
 * resolved before it; naming one that has not yet resolved gives a base of 0
 * rather than throwing, because a mis-ordered structure must not be able to
 * stop a payroll run.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2  = (n) => Math.round(num(n) * 100) / 100;

/** Round to the nearest `step` rupees (step 0 or 1 means "to the paisa"/"to the rupee"). */
function roundAmount(n, step = 1) {
    const v = num(n);
    if (!step || step <= 0) return r2(v);
    if (step === 1) return Math.round(v);
    return Math.round(v / step) * step;
}

/**
 * The divisor for a day's pay.
 *
 * 'fixed'    the classic 26-day month, whatever the calendar says
 * 'calendar' the days the month actually has
 * 'school'   calendar days minus weekly offs and school-wide holidays
 *
 * Never returns less than 1: a school whose settings make every day a holiday
 * must not divide a salary by zero.
 */
async function workingDaysFor(schoolId, year, month, settings) {
    const basis = settings?.workingDaysBasis || 'fixed';
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    if (basis === 'fixed') return Math.max(1, Math.round(num(settings?.fixedWorkingDays) || 26));
    if (basis === 'calendar') return daysInMonth;

    const offs = new Set((settings?.weeklyOffs || [0]).map(Number));
    let working = 0;
    const dayKeys = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(Date.UTC(year, month - 1, d));
        if (offs.has(date.getUTCDay())) continue;
        working++;
        dayKeys.push(date);
    }
    try {
        const Holiday = require('../models/Holiday');
        const from = new Date(Date.UTC(year, month - 1, 1));
        const to   = new Date(Date.UTC(year, month - 1, daysInMonth, 23, 59, 59, 999));
        const hols = await Holiday.find({
            school: schoolId, startDate: { $lte: to }, endDate: { $gte: from },
        }).select('startDate endDate applicability').lean();
        const off = new Set();
        for (const h of hols) {
            if ((h.applicability?.scope || 'all') !== 'all') continue;   // class holidays are not staff holidays
            for (const d of dayKeys) {
                if (d >= new Date(h.startDate) && d <= new Date(new Date(h.endDate).setUTCHours(23, 59, 59, 999))) {
                    off.add(d.getUTCDate());
                }
            }
        }
        working -= off.size;
    } catch (err) {
        // The Holiday module may be off, or the table may not exist yet. A
        // holiday lookup must never be the reason a payroll run cannot run.
        console.warn('[payrollCalc] holiday lookup skipped:', err.message);
    }
    return Math.max(1, working);
}

/**
 * Resolve every component of a structure once.
 *
 * @param pre  the FULL-month amounts from a first pass, used to hold a balance
 *             component steady while the rest of the sheet shrinks. Omitted on
 *             the first pass itself.
 */
function resolvePass(structure, { monthlyCtc, overrideMap, factor, employmentFactor = 1, step, pre }) {
    const resolved = { CTC: monthlyCtc, Ctc: monthlyCtc, ctc: monthlyCtc };
    const rows = [];
    const comps = [...(structure.components || [])]
        .filter(c => c && c.isActive !== false)
        .sort((a, b) => num(a.order) - num(b.order));

    let takenFromCtc = 0;   // earnings + employer cost resolved so far, at FULL value
    const balanceRows = [];

    for (const comp of comps) {
        const name = String(comp.name || '').trim();
        if (!name) continue;
        const hasOverride = Object.prototype.hasOwnProperty.call(overrideMap, name);
        const proRated = comp.proRated !== false;
        let amount = 0;
        let full = 0;
        // A percentage taken of another component reads a base that has ALREADY
        // been pro-rated, so applying the factor again would halve it twice.
        let baseIsPreProrated = false;

        if (hasOverride) {
            full = num(overrideMap[name]);
        } else if (comp.calculationType === 'fixed') {
            full = num(comp.value);
        } else if (comp.calculationType === 'balance') {
            // Held from the full pass so loss of pay cannot be absorbed by the
            // residual and quietly cancel itself out.
            full = pre ? num(pre[name]) : null;   // null → filled in after the loop
        } else {
            const key = String(comp.percentageOf || '').trim();
            const isCtc = /^ctc$/i.test(key);
            let base = isCtc ? monthlyCtc : num(resolved[key]);
            baseIsPreProrated = !isCtc;
            if (num(comp.wageCeiling) > 0) base = Math.min(base, num(comp.wageCeiling));
            full = (num(comp.percentage) / 100) * base;
        }

        if (full === null) {
            // Balance on the first pass: park it and settle up once the rest is in.
            balanceRows.push({ comp, name, proRated, index: rows.length });
            rows.push({ comp, name, amount: 0, full: 0, proRated, baseIsPreProrated, pending: true });
            continue;
        }

        if (num(comp.capAmount) > 0) full = Math.min(full, num(comp.capAmount));
        if (num(comp.minAmount) > 0) full = Math.max(full, num(comp.minAmount));

        // The loss-of-pay fraction is opt-in per component; the employment
        // fraction is not — see the header of computePay(). Neither is applied
        // to a base that was already reduced, or it would count twice.
        amount = baseIsPreProrated ? full : full * (proRated ? factor : 1) * employmentFactor;
        full   = roundAmount(full * (baseIsPreProrated ? 1 : employmentFactor), step);
        amount = roundAmount(amount, step);

        resolved[name] = amount;
        if (comp.type !== 'deduction') takenFromCtc += full;
        rows.push({ comp, name, amount, full, proRated, baseIsPreProrated });
    }

    // Settle the residual: whatever is left of monthly CTC once every other
    // earning and employer cost is taken. Split evenly if a structure declares
    // more than one, so a mis-built structure still adds up.
    if (balanceRows.length) {
        const left = Math.max(0, monthlyCtc - takenFromCtc);
        const each = roundAmount(left / balanceRows.length, step);
        for (const b of balanceRows) {
            const row = rows[b.index];
            row.full = roundAmount(each * employmentFactor, step);
            row.amount = roundAmount(each * (b.proRated ? factor : 1) * employmentFactor, step);
            row.pending = false;
            resolved[b.name] = row.amount;
        }
    }

    return { rows, resolved };
}

/**
 * Compute one employee's month.
 *
 * ── Two different kinds of short month ──────────────────────────────────────
 * `notEmployedDays` are the working days the person was not on the payroll at
 * all — they joined on the 20th, or left on the 3rd. `lopDays` are days they
 * were employed for but are not being paid for.
 *
 * They are NOT the same and they do not prorate the same way. A component
 * flagged `proRated: false` (a flat conveyance allowance, professional tax)
 * survives a month shortened by unpaid leave — that is what the flag is for.
 * Nothing survives non-employment: you cannot draw a full month's allowance for
 * a month you were only on the books for two days of. So the employment
 * fraction is applied to EVERY line, and the loss-of-pay fraction only to the
 * lines that opted into it.
 *
 * @param {object}  structure        a SalaryStructure (lean is fine)
 * @param {number}  annualCtc        the CTC in force for THIS pay month
 * @param {array}   overrides        [{ componentName, value }] — a per-employee fixed amount
 * @param {number}  lopDays          unpaid days inside the employment window
 * @param {number}  notEmployedDays  working days outside the employment window
 * @param {number}  workingDays      the run's divisor
 * @param {number}  units            units worked, for rate-paid staff
 * @param {number}  arrears/bonus/otherDeductions  one-off adjustments on the entry
 */
function computePay({
    structure,
    annualCtc = 0,
    overrides = [],
    lopDays = 0,
    notEmployedDays = 0,
    workingDays = 26,
    units = 0,
    arrears = 0,
    bonus = 0,
    otherDeductions = 0,
    roundTo = 1,
} = {}) {
    const step = num(roundTo) || 1;
    const wd = Math.max(1, num(workingDays) || 26);
    const byRate = structure?.payBasis === 'rate';

    // Rate-paid staff are paid for the units they worked, so a loss-of-pay day
    // would charge them twice for the same absence.
    const notEmployed = byRate ? 0 : Math.max(0, Math.min(wd, num(notEmployedDays)));
    const employedDays = r2(wd - notEmployed);
    const lop = byRate ? 0 : Math.max(0, Math.min(employedDays, num(lopDays)));
    const paidDays = r2(employedDays - lop);
    const employmentFactor = wd > 0 ? employedDays / wd : 1;
    const factor = employedDays > 0 ? (employedDays - lop) / employedDays : 0;

    /**
     * Nobody was employed for a single day of this month, or every day of it
     * was unpaid. Charging a flat professional tax against no pay produced a
     * NEGATIVE payslip; a month with nothing earned has nothing deducted.
     */
    if (!byRate && paidDays <= 0) {
        return zeroMonth({ wd, notEmployed, lop, annualCtc, step, arrears, bonus, otherDeductions });
    }

    const monthlyCtc = byRate
        ? roundAmount(num(units) * num(structure?.rate), step)
        : roundAmount(num(annualCtc) / 12, step);

    const overrideMap = Object.fromEntries(
        (overrides || []).filter(o => o && o.componentName).map(o => [String(o.componentName).trim(), num(o.value)])
    );

    const struct = withFallbackEarning(structure, byRate);

    // Pass one at full pay fixes the residual and gives every line its
    // "for a whole month" figure; pass two applies the short month.
    const first  = resolvePass(struct, { monthlyCtc, overrideMap, factor: 1, step });
    const fullBy = Object.fromEntries(first.rows.map(r => [r.name, r.full]));
    const second = (lop > 0 || employmentFactor < 1)
        ? resolvePass(struct, { monthlyCtc, overrideMap, factor, employmentFactor, step, pre: fullBy })
        : first;

    const earnings = [], deductions = [], employerContributions = [];
    for (const row of second.rows) {
        const line = {
            name: row.name,
            code: String(row.comp.code || '').trim(),
            amount: row.amount,
            fullAmount: fullBy[row.name] ?? row.full,
        };
        if (row.comp.type === 'deduction') deductions.push(line);
        else if (row.comp.type === 'employer') employerContributions.push(line);
        else earnings.push(line);
    }

    const sum = (list, key = 'amount') => roundAmount(list.reduce((s, x) => s + num(x[key]), 0), step === 1 ? 0.01 : step);

    const grossSalary     = sum(earnings);
    const grossFull       = sum(earnings, 'fullAmount');
    const totalDeductions = sum(deductions);
    const employerCost    = sum(employerContributions);
    const lopAmount       = roundAmount(Math.max(0, grossFull - grossSalary), step);

    /**
     * Net never goes below zero. A recovery bigger than the month's pay is a
     * real thing — an advance, an overpayment being clawed back — but the
     * answer is to carry the remainder to next month, not to hand somebody a
     * payslip that says they owe the school money. `unrecovered` is what could
     * not be taken this month, so the caller can carry or refuse it.
     */
    const rawNet = grossSalary - totalDeductions + num(arrears) + num(bonus) - num(otherDeductions);
    const netSalary   = roundAmount(Math.max(0, rawNet), step);
    const unrecovered = roundAmount(Math.max(0, -rawNet), step);

    const monthlyCost = roundAmount(grossFull + sum(employerContributions, 'fullAmount'), step);
    return {
        earnings, deductions, employerContributions,
        grossSalary, grossFull, totalDeductions, employerCost,
        lopDays: lop, lopAmount, notEmployedDays: notEmployed,
        workingDays: wd, employedDays, paidDays,
        monthlyCtc, annualCtc: byRate ? roundAmount(monthlyCtc * 12, step) : num(annualCtc),
        arrears: num(arrears), bonus: num(bonus), otherDeductions: num(otherDeductions),
        netSalary, unrecovered,
        // CTC really costs gross + employer contributions. A structure whose
        // fixed components add up to more than the CTC overflows silently
        // otherwise — the balance component floors at zero and cannot absorb a
        // negative remainder — so the gap is reported and the caller decides.
        monthlyCost,
        ctcGap: roundAmount(monthlyCtc - monthlyCost, step),
        overpaysCtc: !byRate && monthlyCost - monthlyCtc > 1,
    };
}

/**
 * A month nobody was paid for: every line zero, nothing deducted, and the days
 * still stated so the payslip explains itself.
 */
function zeroMonth({ wd, notEmployed, lop, annualCtc, step, arrears, bonus, otherDeductions }) {
    const rawNet = num(arrears) + num(bonus) - num(otherDeductions);
    return {
        earnings: [], deductions: [], employerContributions: [],
        grossSalary: 0, grossFull: 0, totalDeductions: 0, employerCost: 0,
        lopDays: lop, lopAmount: 0, notEmployedDays: notEmployed,
        workingDays: wd, employedDays: r2(wd - notEmployed), paidDays: 0,
        monthlyCtc: roundAmount(num(annualCtc) / 12, step),
        annualCtc: num(annualCtc),
        arrears: num(arrears), bonus: num(bonus), otherDeductions: num(otherDeductions),
        netSalary: roundAmount(Math.max(0, rawNet), step),
        unrecovered: roundAmount(Math.max(0, -rawNet), step),
        monthlyCost: 0, ctcGap: 0, overpaysCtc: false,
        zeroPay: true,
    };
}

/**
 * A structure with no earning at all would pay nothing however large the CTC,
 * which reads as a broken payroll rather than as a broken structure. Give it
 * one residual earning so the money goes somewhere visible and the admin can
 * see, on the preview, that the structure needs components.
 */
function withFallbackEarning(structure, byRate) {
    const comps = (structure?.components || []).filter(c => c && c.isActive !== false);
    const hasEarning = comps.some(c => c.type === 'earning');
    if (hasEarning) return structure;
    return {
        ...structure,
        components: [
            ...comps,
            {
                name: byRate ? 'Consolidated Pay' : 'Basic Salary',
                code: byRate ? 'CONS' : 'BASIC',
                type: 'earning',
                calculationType: 'balance',
                order: -1,
                isActive: true,
                proRated: true,
            },
        ],
    };
}

/**
 * The starter structures a school gets on first use. Not written anywhere
 * automatically — the Structures screen offers them, because an empty payroll
 * module with no way to see what a good structure looks like is where every
 * hand-built, non-adding-up structure came from.
 */
const TEMPLATES = {
    teaching: {
        name: 'Teaching Staff', type: 'teaching',
        description: 'For all teaching faculty',
        components: [
            { name: 'Basic Salary',      code: 'BASIC', type: 'earning',   calculationType: 'percentage', percentage: 50, percentageOf: 'CTC', order: 1 },
            { name: 'House Rent Allowance', code: 'HRA', type: 'earning',  calculationType: 'percentage', percentage: 40, percentageOf: 'Basic Salary', order: 2 },
            { name: 'Dearness Allowance', code: 'DA',   type: 'earning',   calculationType: 'percentage', percentage: 15, percentageOf: 'Basic Salary', order: 3 },
            { name: 'Conveyance Allowance', code: 'CONV', type: 'earning', calculationType: 'fixed', value: 1600, order: 4, proRated: false },
            { name: 'Special Allowance', code: 'SPL',   type: 'earning',   calculationType: 'balance',    order: 5 },
            { name: 'Provident Fund',    code: 'PF',    type: 'deduction', calculationType: 'percentage', percentage: 12, percentageOf: 'Basic Salary', wageCeiling: 15000, order: 6 },
            { name: 'Professional Tax',  code: 'PT',    type: 'deduction', calculationType: 'fixed', value: 200, order: 7, proRated: false },
            { name: 'Employer PF',       code: 'EPF',   type: 'employer',  calculationType: 'percentage', percentage: 12, percentageOf: 'Basic Salary', wageCeiling: 15000, order: 8 },
        ],
    },
    non_teaching: {
        name: 'Non-Teaching Staff', type: 'non_teaching',
        description: 'Administrative and support staff',
        components: [
            { name: 'Basic Salary',     code: 'BASIC', type: 'earning',   calculationType: 'percentage', percentage: 50, percentageOf: 'CTC', order: 1 },
            { name: 'House Rent Allowance', code: 'HRA', type: 'earning', calculationType: 'percentage', percentage: 30, percentageOf: 'Basic Salary', order: 2 },
            { name: 'Special Allowance', code: 'SPL',  type: 'earning',   calculationType: 'balance',    order: 3 },
            { name: 'Provident Fund',   code: 'PF',    type: 'deduction', calculationType: 'percentage', percentage: 12, percentageOf: 'Basic Salary', wageCeiling: 15000, order: 4 },
            { name: 'Professional Tax', code: 'PT',    type: 'deduction', calculationType: 'fixed', value: 200, order: 5, proRated: false },
            { name: 'Employer PF',      code: 'EPF',   type: 'employer',  calculationType: 'percentage', percentage: 12, percentageOf: 'Basic Salary', wageCeiling: 15000, order: 6 },
        ],
    },
    administration: {
        name: 'Administrative Staff', type: 'administration',
        description: 'Management and admin roles',
        components: [
            { name: 'Basic Salary',     code: 'BASIC', type: 'earning',   calculationType: 'percentage', percentage: 55, percentageOf: 'CTC', order: 1 },
            { name: 'House Rent Allowance', code: 'HRA', type: 'earning', calculationType: 'percentage', percentage: 40, percentageOf: 'Basic Salary', order: 2 },
            { name: 'Special Allowance', code: 'SPL',  type: 'earning',   calculationType: 'balance',    order: 3 },
            { name: 'Provident Fund',   code: 'PF',    type: 'deduction', calculationType: 'percentage', percentage: 12, percentageOf: 'Basic Salary', wageCeiling: 15000, order: 4 },
            { name: 'Professional Tax', code: 'PT',    type: 'deduction', calculationType: 'fixed', value: 200, order: 5, proRated: false },
            { name: 'Employer PF',      code: 'EPF',   type: 'employer',  calculationType: 'percentage', percentage: 12, percentageOf: 'Basic Salary', wageCeiling: 15000, order: 6 },
        ],
    },
    contract: {
        name: 'Contract Staff', type: 'contract',
        description: 'Contract and temporary staff',
        components: [
            { name: 'Consolidated Pay', code: 'CONS', type: 'earning',   calculationType: 'balance', order: 1 },
            { name: 'TDS',              code: 'TDS',  type: 'deduction', calculationType: 'percentage', percentage: 10, percentageOf: 'Consolidated Pay', order: 2 },
        ],
    },
    part_time: {
        name: 'Part-Time Faculty', type: 'teaching',
        description: 'Guest and part-time teachers',
        payBasis: 'rate', rate: 800, rateUnit: 'class',
        components: [
            { name: 'Class Fee', code: 'FEE', type: 'earning', calculationType: 'balance', order: 1 },
        ],
    },
};

/** The component names a school already uses, for the "component library" picker. */
const COMMON_COMPONENTS = [
    { name: 'Basic Salary', code: 'BASIC', type: 'earning', calculationType: 'percentage', percentage: 50, percentageOf: 'CTC' },
    { name: 'House Rent Allowance', code: 'HRA', type: 'earning', calculationType: 'percentage', percentage: 40, percentageOf: 'Basic Salary' },
    { name: 'Dearness Allowance', code: 'DA', type: 'earning', calculationType: 'percentage', percentage: 15, percentageOf: 'Basic Salary' },
    { name: 'Conveyance Allowance', code: 'CONV', type: 'earning', calculationType: 'fixed', value: 1600, proRated: false },
    { name: 'Medical Allowance', code: 'MED', type: 'earning', calculationType: 'fixed', value: 1250, proRated: false },
    { name: 'Special Allowance', code: 'SPL', type: 'earning', calculationType: 'balance' },
    { name: 'Provident Fund', code: 'PF', type: 'deduction', calculationType: 'percentage', percentage: 12, percentageOf: 'Basic Salary', wageCeiling: 15000 },
    { name: 'ESI', code: 'ESI', type: 'deduction', calculationType: 'percentage', percentage: 0.75, percentageOf: 'Basic Salary', wageCeiling: 21000 },
    { name: 'Professional Tax', code: 'PT', type: 'deduction', calculationType: 'fixed', value: 200, proRated: false },
    { name: 'TDS', code: 'TDS', type: 'deduction', calculationType: 'fixed', value: 0 },
    { name: 'Employer PF', code: 'EPF', type: 'employer', calculationType: 'percentage', percentage: 12, percentageOf: 'Basic Salary', wageCeiling: 15000 },
    { name: 'Employer ESI', code: 'EESI', type: 'employer', calculationType: 'percentage', percentage: 3.25, percentageOf: 'Basic Salary', wageCeiling: 21000 },
    { name: 'Gratuity', code: 'GRAT', type: 'employer', calculationType: 'percentage', percentage: 4.81, percentageOf: 'Basic Salary' },
];

module.exports = {
    MONTHS, computePay, workingDaysFor, roundAmount, TEMPLATES, COMMON_COMPONENTS,
};
