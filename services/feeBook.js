'use strict';
/**
 * One student's fee book: which months they are charged in, what is paid,
 * what is still owed.
 *
 * It is built from BOTH sides and they have to agree:
 *   • the plan — the structure's heads and their month windows
 *     (services/feeSchedule), which says what is still to come;
 *   • the ledger — every charge actually posted, which says what is owed.
 *
 * Anything on the ledger that the plan no longer explains still appears:
 * a head removed from the structure, a head switched off, a student moved to
 * another structure, an old single-lump demand. Otherwise the months would
 * add up to less than the balance and the fee book would quietly understate
 * what a family owes.
 *
 * A charge can be cancelled (a credit carrying the same head + period, posted
 * when a structure is switched off and its unpaid charges are dropped); the
 * month then shows it as cancelled and nobody is asked to pay it.
 *
 * Credits are spent oldest first: other charges (fines, hostel invoices)
 * first, then months in order. Whatever is left over covers months still to
 * come — that is what paying in advance buys. Money submitted but not yet
 * approved is held separately, so a family is not asked to pay the same
 * month twice while the office checks.
 */
const FeeStructure = require('../models/FeeStructure');
const S = require('./feeSchedule');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const keyOf = (structureId, itemId, period) => `${structureId}:${itemId}:${period}`;

/** Is this ledger row a charge from a fee structure? */
const isStructureCharge = (e) => e.entryType === 'debit' && e.category === 'fee_charged' && e.referenceType === 'FeeStructure';
/** …and its cancellation: a credit that names the same head and period. */
const isCancellation = (e) => e.entryType === 'credit' && e.category === 'adjustment' && e.referenceType === 'FeeStructure';

/**
 * @param {object} o
 * @param {string} o.studentId
 * @param {object} o.year            the academic year row
 * @param {Array}  o.ledger          every ledger row for this student-year
 * @param {string} o.primaryStructureId  the structure the student is on now (may be null)
 * @param {string} o.fromMonth       the month this student joined that structure ('YYYY-MM' or null)
 * @param {number} o.pendingTotal    payments submitted and awaiting approval
 */
async function buildSchedule({ year, ledger = [], primaryStructureId = null, fromMonth = null, pendingTotal = 0 }) {
    const charges = ledger.filter(isStructureCharge);
    const cancels = ledger.filter(isCancellation);

    // Net charge per head-period, and the cancelled part of it.
    const net = new Map();      // key → { charged, cancelled }
    const lumps = [];           // old single-amount demands, which name no head
    for (const e of charges) {
        if (!e.feeItemId) { lumps.push(e); continue; }
        const k = keyOf(e.referenceId, e.feeItemId, Number(e.feePeriod) || 0);
        const cur = net.get(k) || { charged: 0, cancelled: 0, row: e };
        cur.charged = r2(cur.charged + e.amount);
        net.set(k, cur);
    }
    for (const e of cancels) {
        if (!e.feeItemId) continue;
        const k = keyOf(e.referenceId, e.feeItemId, Number(e.feePeriod) || 0);
        const cur = net.get(k);
        if (cur) cur.cancelled = r2(cur.cancelled + e.amount);
    }

    const months = new Map();
    const monthSlot = (key) => {
        if (!months.has(key)) {
            months.set(key, {
                monthKey: key, monthLabel: S.monthLabel(key), items: [],
                chargedAmount: 0, cancelledAmount: 0, totalAmount: 0,
                amountPaid: 0, amountDue: 0, awaiting: 0, payable: 0,
                payStatus: 'upcoming', inAdvance: false, isFuture: false, isCurrentMonth: false,
            });
        }
        return months.get(key);
    };
    const seen = new Set();

    // ── The plan: the structure the student is on now.
    const structure = primaryStructureId ? await FeeStructure.findById(primaryStructureId).lean() : null;
    if (structure) {
        const { structurePeriods } = require('./feeCharging');
        const { items } = await structurePeriods(structure, { year });
        const stopped = structure.isActive === false;
        const lumpForThis = lumps.filter(l => String(l.referenceId) === String(structure._id));
        const firstMonth = items.map(i => i.window.start).sort()[0] || null;
        for (const { item, head, periods } of items) {
            for (const p of periods) {
                const k = keyOf(structure._id, item._id, p.period);
                const row = net.get(k);
                const charged = !!row;
                // A lump demand stands for the first period of every head.
                const inLump = !charged && p.period === 0 && lumpForThis.length > 0;
                if (inLump) { seen.add(k); continue; }   // shown as the lump itself, below
                // Months that are not charged only show while the structure is
                // running, this student has joined it, and it was not paused.
                if (!charged) {
                    if (stopped) continue;
                    if (fromMonth && p.month < fromMonth) continue;
                    if ((structure.skippedMonths || []).includes(p.month)) continue;
                }
                seen.add(k);
                const amount = charged ? r2(row.charged - row.cancelled) : r2(item.amount);
                const slot = monthSlot(p.month);
                slot.items.push({
                    name: head.name, type: head.type || 'recurring', label: p.label, amount,
                    isGenerated: charged, cancelled: charged && row.cancelled > 0 && amount <= 0.004,
                    structureId: String(structure._id), feeItemId: String(item._id), period: p.period,
                });
                slot.totalAmount = r2(slot.totalAmount + amount);
                if (charged) {
                    slot.chargedAmount = r2(slot.chargedAmount + amount);
                    slot.cancelledAmount = r2(slot.cancelledAmount + row.cancelled);
                }
            }
        }
        // The old lump: one entry, in the month the structure starts charging.
        for (const l of lumpForThis) {
            const month = firstMonth || S.monthKey(l.createdAt);
            const slot = monthSlot(month);
            slot.items.push({ name: 'All fee heads (charged together)', type: 'one_time', amount: r2(l.amount), isGenerated: true, cancelled: false, structureId: String(structure._id), lump: true });
            slot.totalAmount = r2(slot.totalAmount + l.amount);
            slot.chargedAmount = r2(slot.chargedAmount + l.amount);
        }
    }

    // ── The ledger: charges the plan above does not explain — a head taken
    // off the structure, a head switched off, a structure the student has
    // been moved off, or a lump from one of those.
    for (const [k, row] of net) {
        if (seen.has(k)) continue;
        const e = row.row;
        const month = S.monthKey(e.periodStart || e.createdAt);
        const amount = r2(row.charged - row.cancelled);
        const slot = monthSlot(month);
        slot.items.push({
            name: e.feeHeadName || e.description || 'Fee', type: 'other', label: e.periodLabel || '', amount,
            isGenerated: true, cancelled: row.cancelled > 0 && amount <= 0.004, past: true,
            structureId: String(e.referenceId), feeItemId: String(e.feeItemId), period: Number(e.feePeriod) || 0,
        });
        slot.totalAmount = r2(slot.totalAmount + amount);
        slot.chargedAmount = r2(slot.chargedAmount + amount);
        slot.cancelledAmount = r2(slot.cancelledAmount + row.cancelled);
    }
    for (const l of lumps) {
        if (structure && String(l.referenceId) === String(structure._id)) continue;
        const slot = monthSlot(S.monthKey(l.createdAt));
        slot.items.push({ name: l.description || 'Fee demand', type: 'other', amount: r2(l.amount), isGenerated: true, cancelled: false, past: true, structureId: String(l.referenceId), lump: true });
        slot.totalAmount = r2(slot.totalAmount + l.amount);
        slot.chargedAmount = r2(slot.chargedAmount + l.amount);
    }

    // ── Money.
    const sum = (rows) => r2(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0));
    const credits = sum(ledger.filter(e => e.entryType === 'credit' && !isCancellation(e)));
    const chargeTotal = sum(charges);
    const otherDebits = r2(sum(ledger.filter(e => e.entryType === 'debit')) - chargeTotal);
    // A cancelled charge is owed by nobody: both sides of it are left out.
    const otherDue = Math.max(0, r2(otherDebits - credits));
    let pool = Math.max(0, r2(credits - otherDebits));

    const now = new Date();
    const thisMonth = S.monthKey(now);
    const schedule = [...months.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
    let waiting = Math.max(0, r2(pendingTotal));
    for (const m of schedule) {
        m.isFuture = m.monthKey > thisMonth;
        m.isCurrentMonth = m.monthKey === thisMonth;
        const paid = Math.min(pool, m.totalAmount);
        pool = r2(pool - paid);
        m.amountPaid = r2(paid);
        m.amountDue = r2(m.totalAmount - paid);
        // Then money that is submitted but not yet approved.
        const held = Math.min(waiting, m.amountDue);
        waiting = r2(waiting - held);
        m.awaiting = r2(held);
        m.payable = r2(m.amountDue - held);
        m.inAdvance = paid > 0 && m.chargedAmount < m.totalAmount;
        if (m.totalAmount <= 0.004 && m.cancelledAmount > 0) m.payStatus = 'cancelled';
        else if (m.amountDue <= 0.004) m.payStatus = 'paid';
        else if (m.awaiting >= m.amountDue - 0.004) m.payStatus = 'awaiting';
        else if (paid > 0 || m.awaiting > 0) m.payStatus = 'partial';
        else m.payStatus = m.chargedAmount > 0 ? 'due' : 'upcoming';
    }
    // Owed right now: other charges plus every charged month not settled.
    const dueTotal = r2(otherDue + schedule.reduce((s, m) => s + Math.min(m.amountDue, m.chargedAmount), 0));
    return { months: schedule, otherDue, dueTotal, advance: pool, pendingTotal: r2(pendingTotal) };
}

/**
 * What paying a set of months comes to, and the receipt lines for it. Months
 * are paid oldest first — money settles the oldest charge on the ledger
 * whatever a payment is labelled — so the months asked for must be the
 * earliest unpaid ones. Months already covered by a payment awaiting
 * approval are not offered again.
 */
function monthsPayment(book, months) {
    const wanted = [...new Set((Array.isArray(months) ? months : []).map(String))];
    if (!wanted.length) return { error: 'Choose the months to pay' };
    const unpaid = payableMonths(book.monthlySchedule || book.months || []);
    const prefix = unpaid.slice(0, wanted.length).map(m => m.monthKey);
    if (wanted.some(k => !unpaid.some(m => m.monthKey === k))) {
        return { error: 'One of those months is already paid, cancelled, or waiting for the office to approve a payment' };
    }
    if (prefix.slice().sort().join() !== wanted.slice().sort().join()) {
        return { error: `Pay the earlier months first — ${unpaid[0] ? unpaid[0].monthLabel : 'the first unpaid month'} comes before these` };
    }
    const lines = [];
    if (book.otherDue > 0) lines.push({ feeName: 'Fines & other charges', amount: r2(book.otherDue) });
    for (const m of unpaid.slice(0, wanted.length)) {
        const names = [...new Set(m.items.filter(i => !i.cancelled).map(i => i.name))].join(', ');
        lines.push({ feeName: `${m.monthLabel} — ${names}${m.amountPaid > 0 || m.awaiting > 0 ? ' (balance)' : ''}`, amount: r2(m.payable) });
    }
    return { amount: r2(lines.reduce((s, l) => s + l.amount, 0)), lines };
}

/** The months a payment can still be made against, oldest first. */
const payableMonths = (months = []) => months.filter(m => m.payable > 0.004 && m.payStatus !== 'cancelled');

module.exports = { buildSchedule, monthsPayment, payableMonths, isStructureCharge, isCancellation, keyOf };
