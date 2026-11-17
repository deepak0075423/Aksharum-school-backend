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
    return r2(Math.round(v / step) * step);
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
 * Price ONE line, given everything that resolved before it.
 *
 * `st` carries two views of every line already priced:
 *   actual   what is being paid
 *   whole    what the days on the payroll are worth before unpaid leave
 * A percentage of another line reads `actual` when it follows loss of pay and
 * `whole` when the component is flagged `proRated: false` — the flag used to
 * be ignored on these lines because the base had already been reduced.
 */
function priceLine(comp, name, st, { monthlyCtc, overrideMap, factor, employmentFactor, step, pre }) {
    const proRated = comp.proRated !== false;
    const hasOverride = Object.prototype.hasOwnProperty.call(overrideMap, name);
    const limits = (v) => {
        let out = v;
        if (num(comp.capAmount) > 0) out = Math.min(out, num(comp.capAmount));
        if (num(comp.minAmount) > 0) out = Math.max(out, num(comp.minAmount));
        return out;
    };
    const ceiling = (b) => (num(comp.wageCeiling) > 0 ? Math.min(b, num(comp.wageCeiling)) : b);
    // "Applies only up to" is an eligibility test, not a cap: ESI is owed on
    // the whole wage while it is at or under the limit and not at all above.
    const outOfRange = (monthBase) => num(comp.applyUpTo) > 0 && monthBase > num(comp.applyUpTo) + 0.5;

    let whole = 0, amount = 0;
    const key = String(comp.percentageOf || '').trim();
    const viaLine = !hasOverride && comp.calculationType === 'percentage' && !/^ctc$/i.test(key);

    if (!viaLine) {
        let month = 0;
        if (hasOverride) month = num(overrideMap[name]);
        else if (comp.calculationType === 'fixed') month = num(comp.value);
        else if (comp.calculationType === 'balance') month = pre ? num(pre[name]) : 0;
        else month = outOfRange(monthlyCtc) ? null : (num(comp.percentage) / 100) * ceiling(monthlyCtc);
        month = month === null ? 0 : limits(month);
        whole  = month * employmentFactor;
        amount = month * (proRated ? factor : 1) * employmentFactor;
    } else {
        const gross = /^gross$/i.test(key);
        const baseWhole  = gross ? st.grossWhole  : num(st.whole[key]);
        const baseActual = gross ? st.grossActual : num(st.actual[key]);
        const monthBase  = employmentFactor > 0 ? baseWhole / employmentFactor : baseWhole;
        if (!outOfRange(monthBase)) {
            const pct = num(comp.percentage) / 100;
            whole  = limits(pct * ceiling(baseWhole));
            amount = limits(pct * ceiling(proRated ? baseActual : baseWhole));
        }
    }
    return { comp, name, proRated, amount: roundAmount(amount, step), full: roundAmount(whole, step) };
}

/**
 * Resolve every component of a structure once.
 *
 * A balance component cannot be priced until everything else that draws on CTC
 * is known — and anything that takes a percentage OF the balance (TDS on a
 * consolidated pay, ESI on gross) cannot be priced until the balance is. Those
 * lines used to read a base of zero: the built-in Contract template deducted no
 * TDS at all on a full month. They now wait, the balance is settled, and then
 * they are priced in their own order.
 *
 * @param pre  the FULL-month amounts from a first pass, used to hold a balance
 *             component steady while the rest of the sheet shrinks. Omitted on
 *             the first pass itself.
 */
function resolvePass(structure, { monthlyCtc, overrideMap, factor, employmentFactor = 1, step, pre }) {
    const ctx = { monthlyCtc, overrideMap, factor, employmentFactor, step, pre };
    const comps = [...(structure.components || [])]
        .filter(c => c && c.isActive !== false && String(c.name || '').trim())
        .sort((a, b) => num(a.order) - num(b.order));

    const fresh = () => ({ actual: {}, whole: {}, grossActual: 0, grossWhole: 0 });
    const record = (st, row) => {
        st.actual[row.name] = row.amount;
        st.whole[row.name]  = row.full;
        if (row.comp.type === 'earning') { st.grossActual += row.amount; st.grossWhole += row.full; }
    };

    const state = fresh();
    const rows = new Array(comps.length).fill(null);
    const balances = [];           // positions of the residual line(s)
    const waiting  = [];           // positions whose base is not known yet
    const unknown  = new Set();    // names not priced yet
    let unknownEarnings = 0;
    let taken = 0;                 // earnings + employer cost priced so far, at full value

    comps.forEach((comp, i) => {
        const name = String(comp.name).trim();
        const hasOverride = Object.prototype.hasOwnProperty.call(overrideMap, name);
        const park = (list) => { list.push(i); unknown.add(name); if (comp.type === 'earning') unknownEarnings += 1; };

        if (!hasOverride && comp.calculationType === 'balance' && !pre) return park(balances);
        if (!hasOverride && comp.calculationType === 'percentage') {
            const key = String(comp.percentageOf || '').trim();
            if (unknown.has(key) || (/^gross$/i.test(key) && unknownEarnings > 0)) return park(waiting);
        }
        const row = priceLine(comp, name, state, ctx);
        rows[i] = row;
        record(state, row);
        if (comp.type !== 'deduction') taken += row.full;
        return undefined;
    });

    if (balances.length) {
        const left = Math.max(0, monthlyCtc - taken);
        const n = balances.length;
        // Price the residual at `each` and everything that was waiting on it.
        const trial = (each) => {
            const st = { actual: { ...state.actual }, whole: { ...state.whole }, grossActual: state.grossActual, grossWhole: state.grossWhole };
            const out = [];
            let extra = 0;      // what the waiting lines themselves draw from CTC
            for (const i of balances) {
                const comp = comps[i], name = String(comp.name).trim();
                const proRated = comp.proRated !== false;
                const row = {
                    comp, name, proRated,
                    full: roundAmount(each * employmentFactor, step),
                    amount: roundAmount(each * (proRated ? factor : 1) * employmentFactor, step),
                };
                record(st, row); out.push([i, row]);
            }
            for (const i of waiting) {
                const comp = comps[i];
                const row = priceLine(comp, String(comp.name).trim(), st, ctx);
                record(st, row); out.push([i, row]);
                if (comp.type !== 'deduction') extra += row.full;
            }
            return { out, extra };
        };

        let each = left / n;
        // An earning that is itself a share of the residual (rare, but legal)
        // makes the residual depend on itself. Bisect for the figure at which
        // residual + its dependants exactly use up what is left.
        if (trial(each).extra > 0.005) {
            let lo = 0, hi = left / n;
            for (let k = 0; k < 40; k++) {
                const mid = (lo + hi) / 2;
                if (mid * n + trial(mid).extra > left) hi = mid; else lo = mid;
            }
            each = lo;
        }
        for (const [i, row] of trial(roundAmount(each, step)).out) { rows[i] = row; record(state, row); }
    }

    return { rows: rows.filter(Boolean), resolved: state.actual };
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
    { name: 'ESI', code: 'ESI', type: 'deduction', calculationType: 'percentage', percentage: 0.75, percentageOf: 'Gross', applyUpTo: 21000 },
    { name: 'Professional Tax', code: 'PT', type: 'deduction', calculationType: 'fixed', value: 200, proRated: false },
    { name: 'TDS', code: 'TDS', type: 'deduction', calculationType: 'fixed', value: 0 },
    { name: 'Employer PF', code: 'EPF', type: 'employer', calculationType: 'percentage', percentage: 12, percentageOf: 'Basic Salary', wageCeiling: 15000 },
    { name: 'Employer ESI', code: 'EESI', type: 'employer', calculationType: 'percentage', percentage: 3.25, percentageOf: 'Gross', applyUpTo: 21000 },
    { name: 'Gratuity', code: 'GRAT', type: 'employer', calculationType: 'percentage', percentage: 4.81, percentageOf: 'Basic Salary' },
];

module.exports = {
    MONTHS, computePay, workingDaysFor, roundAmount, TEMPLATES, COMMON_COMPONENTS,
};
