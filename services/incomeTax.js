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
 * A starting point, matching the regime most schools put their staff on.
 * `upTo: null` is the top, open-ended slab. Every figure here is a default a
 * school is expected to review — see the header.
 */
const DEFAULT_SLABS = [
    { upTo: 300000,  rate: 0 },
    { upTo: 700000,  rate: 5 },
    { upTo: 1000000, rate: 10 },
    { upTo: 1200000, rate: 15 },
    { upTo: 1500000, rate: 20 },
    { upTo: null,    rate: 30 },
];

const DEFAULTS = {
    slabs: DEFAULT_SLABS,
    standardDeduction: 75000,
    cessPercent: 4,
    // Section 87A: no tax at all below this taxable income.
    rebateUpTo: 700000,
    rebateMax: 25000,
};

/** The tax configuration a school is actually using, with every gap filled. */
function config(settings) {
    const t = settings?.tax || {};
    const slabs = Array.isArray(t.slabs) && t.slabs.length ? t.slabs : DEFAULTS.slabs;
    return {
        regime: t.regime || 'none',
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

/**
 * Tax on one year's taxable income, slab by slab, with the rebate and the cess.
 * Returns the working as well as the total, because a Form 16 has to show it.
 */
function annualTax(taxableIncome, settings) {
    const cfg = config(settings);
    const income = Math.max(0, r2(taxableIncome));
    const bands = [];
    let base = 0, floor = 0;

    for (const slab of cfg.slabs) {
        const ceiling = slab.upTo === null ? Infinity : slab.upTo;
        if (income <= floor) break;
        const inBand = Math.min(income, ceiling) - floor;
        if (inBand > 0) {
            const tax = r2((inBand * slab.rate) / 100);
            base += tax;
            bands.push({
                from: floor,
                to: ceiling === Infinity ? null : ceiling,
                rate: slab.rate,
                amount: r2(inBand),
                tax,
            });
        }
        floor = ceiling;
        if (floor === Infinity) break;
    }
    base = r2(base);

    // Section 87A: a rebate that wipes out the tax entirely below a threshold.
    const rebate = income <= cfg.rebateUpTo ? Math.min(base, cfg.rebateMax) : 0;
    const afterRebate = r2(Math.max(0, base - rebate));
    const cess = r2((afterRebate * cfg.cessPercent) / 100);

    return {
        taxableIncome: income,
        bands,
        baseTax: base,
        rebate: r2(rebate),
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
 */
function monthlyTds({ taxablePaidToDate, taxableThisMonth, tdsPaidToDate, monthsRemaining, settings }) {
    const cfg = config(settings);
    if (cfg.regime === 'none') return { amount: 0, projection: null };

    const left = Math.max(1, Math.round(num(monthsRemaining)));
    const projectedAnnual = r2(
        num(taxablePaidToDate) + num(taxableThisMonth) * left);
    const taxable = Math.max(0, r2(projectedAnnual - cfg.standardDeduction));
    const tax = annualTax(taxable, settings);
    const stillToCollect = Math.max(0, r2(tax.total - num(tdsPaidToDate)));
    const amount = r2(stillToCollect / left);

    return {
        amount,
        projection: {
            projectedAnnual,
            standardDeduction: cfg.standardDeduction,
            taxableIncome: taxable,
            annualTax: tax.total,
            alreadyDeducted: r2(tdsPaidToDate),
            monthsRemaining: left,
            bands: tax.bands,
            rebate: tax.rebate,
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

module.exports = { DEFAULT_SLABS, DEFAULTS, config, annualTax, monthlyTds, taxableEarnings };
