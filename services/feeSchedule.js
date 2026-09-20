'use strict';
/**
 * When each fee head of a structure is charged.
 *
 * A structure belongs to one academic year, and each head on it carries a
 * window of months, 'YYYY-MM' to 'YYYY-MM', that must sit inside that year —
 * the office picks when a monthly/quarterly/half-yearly head starts and the
 * last month it runs, and the last month can never pass the year's last day.
 * Inside the window:
 *
 *   monthly (recurring)  every month
 *   quarterly            the start month and every third month after it
 *   half-yearly          the start month and every sixth month after it
 *   yearly / one-time    once, in the start month
 *
 * Each charge is a "period": its index within the head (0, 1, 2 …) is what
 * the ledger stores as feePeriod, so a period is charged at most once.
 *
 * Pure — no database. Month keys are local calendar months (config/timezone
 * pins the process zone to the school's).
 */

const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const STEP = { recurring: 1, quarterly: 3, half_yearly: 6, yearly: 0, one_time: 0 };

const isMonthKey = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const monthKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; };
/** Local midnight on the 1st of the month. */
const monthStart = (key) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
const addMonths = (key, n) => monthKey(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + n, 1));
const monthLabel = (key) => `${FULL[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const isPeriodic = (type) => (STEP[type] || 0) > 0;

/** The first and last month of an academic year, and every month between. */
function yearBounds(year) {
    const first = monthKey(year.startDate);
    const last = monthKey(year.endDate);
    const months = [];
    for (let k = first, i = 0; k <= last && i < 36; k = addMonths(k, 1), i++) months.push(k);
    return { first, last, months };
}

/**
 * The window a head is charged in. An item saved before windows existed
 * starts at `fallbackStart` (the month its structure first charged) and runs
 * to the year's end.
 */
function windowFor(item, type, bounds, fallbackStart = null) {
    let start = isMonthKey(item.startMonth) ? item.startMonth : (isMonthKey(fallbackStart) ? fallbackStart : bounds.first);
    if (start < bounds.first) start = bounds.first;
    let end = isMonthKey(item.endMonth) ? item.endMonth : bounds.last;
    if (end > bounds.last) end = bounds.last;
    if (!isPeriodic(type)) end = start;
    return { start, end };
}

/** Every charge a head makes: [{ period, month, label, start }]. */
function periodsFor(item, type, bounds, fallbackStart = null) {
    const { start, end } = windowFor(item, type, bounds, fallbackStart);
    const step = STEP[type] || 0;
    if (!step) return [{ period: 0, month: start, label: monthLabel(start), start: monthStart(start) }];
    const out = [];
    for (let k = start, i = 0; k <= end && i < 36; k = addMonths(k, step), i++) {
        const prefix = type === 'quarterly' ? `Quarter ${i + 1} · ` : type === 'half_yearly' ? `Half ${i + 1} · ` : '';
        out.push({ period: i, month: k, label: `${prefix}${monthLabel(k)}`, start: monthStart(k) });
    }
    return out;
}

/**
 * Check one item's window against its year. Returns an error sentence or
 * null. `name` is the head's name, for the message.
 */
function checkWindow(item, type, bounds, name) {
    const s = item.startMonth, e = item.endMonth;
    if (s != null && s !== '' && !isMonthKey(s)) return `Choose the month ${name} starts`;
    if (e != null && e !== '' && !isMonthKey(e)) return `Choose the last month of ${name}`;
    if (isMonthKey(s) && s < bounds.first) return `${name} cannot start before the academic year does (${monthLabel(bounds.first)})`;
    if (isMonthKey(s) && s > bounds.last) return `${name} cannot start after the academic year ends (${monthLabel(bounds.last)})`;
    if (isPeriodic(type)) {
        if (isMonthKey(e) && e > bounds.last) return `${name} cannot run past the last month of the academic year (${monthLabel(bounds.last)})`;
        if (isMonthKey(e) && isMonthKey(s) && e < s) return `${name} ends before it starts`;
    }
    return null;
}

/** What a set of items charges over the whole year. */
function annualTotal(items, typeOf, bounds, fallbackStart = null) {
    return (items || []).filter(i => i.isActive !== false).reduce((sum, i) => {
        const type = typeOf(i.feeHead) || 'recurring';
        return sum + (Number(i.amount) || 0) * periodsFor(i, type, bounds, fallbackStart).length;
    }, 0);
}

module.exports = {
    STEP, FULL, isMonthKey, monthKey, monthStart, addMonths, monthLabel, isPeriodic,
    yearBounds, windowFor, periodsFor, checkWindow, annualTotal,
};
