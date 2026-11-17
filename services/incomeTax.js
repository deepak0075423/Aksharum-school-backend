'use strict';
/**
 * Income tax on salary, and the monthly TDS that follows from it.
 *
 * ── Why the slabs are data, not code ────────────────────────────────────────
 * Rates, the standard deduction and the rebate change with every budget, and a
 * school on last year's software must not silently deduct last year's tax. The
 * whole table lives in PayrollSettings where a school can correct it the day a
 * budget lands, and DEFAULT_SLABS below is a starting point to be checked
 * against the current Finance Act — not an authority on it.
 *
 * ── Why TDS is computed here and not in payrollCalc ─────────────────────────
 * Every other component is a function of one month. TDS is not: it is the
 * year's tax, minus what has already been deducted, spread over the months that
 * are left. That needs the employee's year to date, which only the run engine
 * has. payrollCalc stays a pure per-month function; this file is given the
 * year's context and hands back one number.
 *
 * The module deducts nothing unless a school turns a regime on. Quietly
 * starting to withhold tax from salaries because the software was upgraded
 * would be the worst possible default.
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2  = (n) => Math.round(num(n) * 100) / 100;

/**
 * Starting points, one per regime. `upTo: null` is the top, open-ended slab.
 * Every figure here is a default a school is expected to review — see the
 * header. The new-regime table is the one in force since the 2025 budget
 * (nil to ₹4 lakh, a rebate that clears the tax up to ₹12 lakh); the previous
 * defaults were the 2024-25 table and under-withheld nobody but over-withheld
 * everybody between ₹7 and ₹12 lakh.
 */
const NEW_SLABS = [
    { upTo: 400000,  rate: 0 },
    { upTo: 800000,  rate: 5 },
    { upTo: 1200000, rate: 10 },
    { upTo: 1600000, rate: 15 },
    { upTo: 2000000, rate: 20 },
    { upTo: 2400000, rate: 25 },
    { upTo: null,    rate: 30 },
];
const OLD_SLABS = [
    { upTo: 250000,  rate: 0 },
    { upTo: 500000,  rate: 5 },
    { upTo: 1000000, rate: 20 },
    { upTo: null,    rate: 30 },
];

/**
 * "Old" used to be a label on the new regime's numbers. It now has its own
 * table, its own standard deduction and rebate, and — the thing that makes it
 * the old regime at all — it takes off what the employee has declared (80C,
 * 80D, HRA exemption …), recorded per person on their salary assignment.
 *
 * Marginal relief belongs to the new regime only: just above the rebate limit
 * the tax may not exceed the income above it. Without it, ₹100 of extra pay
 * cost ₹20,000 of tax.
 */
const DEFAULTS_BY_REGIME = {
    new: { slabs: NEW_SLABS, standardDeduction: 75000, cessPercent: 4, rebateUpTo: 1200000, rebateMax: 60000, marginalRelief: true },
    old: { slabs: OLD_SLABS, standardDeduction: 50000, cessPercent: 4, rebateUpTo: 500000,  rebateMax: 12500, marginalRelief: false },
};
const DEFAULT_SLABS = NEW_SLABS;
const DEFAULTS = DEFAULTS_BY_REGIME.new;

/** The tax configuration a school is actually using, with every gap filled. */
function config(settings) {
    const t = settings?.tax || {};
    const DEFAULTS = DEFAULTS_BY_REGIME[t.regime === 'old' ? 'old' : 'new'];
    const slabs = Array.isArray(t.slabs) && t.slabs.length ? t.slabs : DEFAULTS.slabs;
    return {
        regime: t.regime || 'none',
        marginalRelief: t.marginalRelief === undefined ? DEFAULTS.marginalRelief : !!t.marginalRelief,
        slabs: [...slabs]
            .map(s => ({ upTo: s.upTo === null || s.upTo === undefined || s.upTo === '' ? null : num(s.upTo), rate: num(s.rate) }))
            // An open-ended slab has to be last or everything above it is free.
            .sort((a, b) => (a.upTo === null ? 1 : b.upTo === null ? -1 : a.upTo - b.upTo)),
        standardDeduction: t.standardDeduction === undefined ? DEFAULTS.standardDeduction : num(t.standardDeduction),
        cessPercent: t.cessPercent === undefined ? DEFAULTS.cessPercent : num(t.cessPercent),
        rebateUpTo: t.rebateUpTo === undefined ? DEFAULTS.rebateUpTo : num(t.rebateUpTo),
        rebateMax: t.rebateMax === undefined ? DEFAULTS.rebateMax : num(t.rebateMax),
    };
}

/** Slab by slab, before any rebate or cess. */
function slabTax(income, slabs) {
    const bands = [];
    let base = 0, floor = 0;
    for (const slab of slabs) {
        const ceiling = slab.upTo === null ? Infinity : slab.upTo;
        if (income <= floor) break;
        const inBand = Math.min(income, ceiling) - floor;
        if (inBand > 0) {
            const tax = r2((inBand * slab.rate) / 100);
            base += tax;
            bands.push({ from: floor, to: ceiling === Infinity ? null : ceiling, rate: slab.rate, amount: r2(inBand), tax });
        }
        floor = ceiling;
        if (floor === Infinity) break;
    }
    return { base: r2(base), bands };
}

/**
 * Tax on one year's taxable income, slab by slab, with the rebate, marginal
 * relief and the cess. Returns the working as well as the total, because a
 * Form 16 has to show it.
 */
function annualTax(taxableIncome, settings) {
    const cfg = config(settings);
    const income = Math.max(0, r2(taxableIncome));
    const { base, bands } = slabTax(income, cfg.slabs);

    // Section 87A: a rebate that wipes out the tax entirely below a threshold.
    const rebate = income <= cfg.rebateUpTo ? Math.min(base, cfg.rebateMax) : 0;
    let afterRebate = r2(Math.max(0, base - rebate));

    // Marginal relief: just over the threshold, tax is capped at the income
    // above it — but only where the rebate really did clear the tax AT the
    // threshold, or there is no cliff to soften.
    let relief = 0;
    if (cfg.marginalRelief && cfg.rebateUpTo > 0 && income > cfg.rebateUpTo
        && slabTax(cfg.rebateUpTo, cfg.slabs).base <= cfg.rebateMax) {
        const over = r2(income - cfg.rebateUpTo);
        if (afterRebate > over) { relief = r2(afterRebate - over); afterRebate = over; }
    }
    const cess = r2((afterRebate * cfg.cessPercent) / 100);

    return {
        taxableIncome: income,
        bands,
        baseTax: base,
        rebate: r2(rebate),
        marginalRelief: relief,
        cess,
        total: r2(afterRebate + cess),
        config: cfg,
    };
}

/**
 * This month's TDS.
 *
 * The year's tax is worked out on a projection — what has actually been paid so
 * far, plus this month, plus the same again for each month still to come — and
 * what is left to collect is spread over the months that are left. That is how
 * TDS on salary is meant to behave: it self-corrects every month as the real
 * figures replace the projection, and a mid-year raise or a bonus is absorbed
 * over the rest of the year rather than landing in one payslip.
 *
 * @param taxablePaidToDate  taxable earnings already paid this financial year
 * @param taxableThisMonth   taxable earnings in the month being computed
 * @param tdsPaidToDate      TDS already deducted this financial year
 * @param monthsRemaining    months left in the year INCLUDING this one
 * @param oneOffThisMonth    a bonus, arrears, a taxable claim — paid once, so it
 *                           is counted once and NOT projected over the months left
 * @param declared           what the employee has declared for the year (old regime only)
 */
function monthlyTds({ taxablePaidToDate, taxableThisMonth, tdsPaidToDate, monthsRemaining, settings, oneOffThisMonth = 0, declared = 0 }) {
    const cfg = config(settings);
    if (cfg.regime === 'none') return { amount: 0, projection: null };

    const left = Math.max(1, Math.round(num(monthsRemaining)));
    const projectedAnnual = r2(
        num(taxablePaidToDate) + num(taxableThisMonth) * left + num(oneOffThisMonth));
    const declaredOff = cfg.regime === 'old' ? Math.max(0, num(declared)) : 0;
    const taxable = Math.max(0, r2(projectedAnnual - cfg.standardDeduction - declaredOff));
    const tax = annualTax(taxable, settings);
    const stillToCollect = Math.max(0, r2(tax.total - num(tdsPaidToDate)));
    const amount = r2(stillToCollect / left);

    return {
        amount,
        projection: {
            projectedAnnual,
            regime: cfg.regime,
            paidToDate: r2(taxablePaidToDate),
            thisMonth: r2(taxableThisMonth),
            oneOff: r2(oneOffThisMonth),
            standardDeduction: cfg.standardDeduction,
            declared: declaredOff,
            taxableIncome: taxable,
            annualTax: tax.total,
            alreadyDeducted: r2(tdsPaidToDate),
            monthsRemaining: left,
            bands: tax.bands,
            rebate: tax.rebate,
            marginalRelief: tax.marginalRelief,
            cess: tax.cess,
        },
    };
}

/** The taxable part of a month's earnings — components flagged `taxable: false` are out. */
function taxableEarnings(earnings, structure) {
    const flags = new Map((structure?.components || []).map(c => [String(c.name).trim(), c.taxable !== false]));
    return r2((earnings || []).reduce(
        (s, e) => s + (flags.get(String(e.name).trim()) === false ? 0 : num(e.amount)), 0));
}

module.exports = { DEFAULT_SLABS, DEFAULTS, DEFAULTS_BY_REGIME, config, annualTax, monthlyTds, taxableEarnings };
