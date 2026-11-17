'use strict';
/**
 * The payroll month does not open itself, and nobody is told it is due.
 *
 * Every other deadline in this ERP has something watching it; payroll — the one
 * with a date people plan their own money around — had nothing. This sweep does
 * two small, safe things, both of which a school can switch off:
 *
 *   1. Opens the month's run as a DRAFT on the configured day. It never
 *      reviews, approves or publishes: a draft is a pile of figures nobody has
 *      agreed to, which is exactly what an automatic step should produce.
 *   2. Reminds whoever can approve, once, when the pay day is close and the
 *      month is still not published.
 *
 * Both are idempotent per month: the run is created only if one does not exist,
 * and the reminder records the month it last went out for.
 */
const School          = require('../models/School');
const PayrollRun      = require('../models/PayrollRun');
const PayrollSettings = require('../models/PayrollSettings');
const User            = require('../models/User');
const { schoolModuleFlags } = require('../config/modules');
const { notify } = require('../services/notifyService');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const MONTHS = require('./payrollCalc').MONTHS;

/** Schools with payroll switched on and the sweep enabled. */
async function schoolsToSweep() {
    const schools = await School.find({}).select('_id modules').lean();
    const on = schools.filter(s => schoolModuleFlags(s).payroll).map(s => String(s._id));
    if (!on.length) return [];
    const settings = await PayrollSettings.find({ school: { $in: on } }).lean();
    const byId = new Map(settings.map(x => [String(x.school), x]));
    return on.filter(id => {
        const s = byId.get(id);
        return s && (s.autoOpenRun === true || s.remindBeforePayDay === true);
    });
}

/**
 * The month a run should exist for right now: the CURRENT calendar month.
 * November's payroll is opened late in November and paid early in December.
 * (The comment here used to say "the month that has ended", which is not what
 * the code did and not what the pay day setting means.)
 */
function dueMonth(today = new Date()) {
    const d = new Date(today.getFullYear(), today.getMonth(), 1);
    return { month: d.getMonth() + 1, year: d.getFullYear() };
}
const monthBefore = ({ month, year }) => (month > 1 ? { month: month - 1, year } : { month: 12, year: year - 1 });
const stampOf = ({ month, year }) => `${year}-${String(month).padStart(2, '0')}`;
const payDateOf = ({ month, year }, payDay) => new Date(month === 12 ? year + 1 : year, month === 12 ? 0 : month, payDay);

/**
 * Who hears about payroll: everyone who can run it — school admins AND the
 * teachers whose designation makes them payroll administrators (an accountant
 * is usually one of those, and was never told anything).
 *
 * notify() needs a sender and refuses to send without one; the sweep passed
 * none, so not one of these reminders had ever actually gone out. The first
 * school admin stands in, and is kept on the recipient list.
 */
async function audience(schoolId) {
    const admins = await User.find({ school: schoolId, role: 'school_admin', isActive: true }).select('_id').lean();
    let ids = admins.map(a => String(a._id));
    try {
        const more = await require('./designationService').moduleAdminIds(schoolId, 'payroll');
        ids = [...new Set([...ids, ...more.map(String)])];
    } catch { /* school admins alone will do */ }
    return { sender: admins[0]?._id || ids[0] || null, recipients: ids };
}

async function sweepSchool(schoolId) {
    const settings = await PayrollSettings.findOne({ school: schoolId }).lean();
    if (!settings) return 0;

    const today = new Date();
    const day0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const current = dueMonth(today);
    const { month, year } = current;
    const existing = await PayrollRun.findOne({ school: schoolId, year, month }).lean();
    const payDay = Math.min(28, Math.max(1, num(settings.payDay) || 1));
    let did = 0;

    // ── 1. Open the month ────────────────────────────────────────────────────
    // On or after the configured day, as a DRAFT and nothing more.
    const openOn = Math.min(28, Math.max(1, num(settings.autoOpenDay) || 25));
    if (settings.autoOpenRun === true && !existing && today.getDate() >= openOn) {
        const admin = require('../controllers/payrollAdmin.controller');
        let run = null;
        try {
            const workingDays = await require('./payrollCalc').workingDaysFor(schoolId, year, month, settings);
            run = await PayrollRun.create({
                school: schoolId, month, year,
                runName: `${MONTHS[month - 1]} ${year} Payroll`,
                status: 'draft', workingDays,
                payDate: new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, payDay)),
                processedAt: new Date(),
                notes: 'Opened automatically',
            });
            const { count } = await admin.computeRunEntries(schoolId, run, settings, {});
            console.log(`[Payroll] opened ${MONTHS[month - 1]} ${year} for school ${schoolId} — ${count} employees`);
            did += 1;
        } catch (err) {
            console.error('[Payroll] auto-open failed:', err.message);
            // An empty draft with nothing to say for itself is worse than a
            // run that admits it failed and can be recomputed.
            if (run) {
                await PayrollRun.updateOne({ _id: run._id }, {
                    status: 'failed',
                    failureReason: 'The month was opened automatically but its entries could not be computed. Check the salary structures and assignments, then recompute.',
                }).catch(() => null);
            }
        }
    }

    if (settings.remindBeforePayDay !== true) return did;
    const { sender, recipients } = await audience(schoolId);
    if (!sender || !recipients.length) return did;
    const send = (title, body) => notify({
        school: schoolId, sender, senderRole: 'system', includeSender: true,
        title, body, recipients, email: true, link: { type: 'payroll.runs' },
    });

    // ── 2. Remind, once, when pay day is close ───────────────────────────────
    {
        const daysToPay = Math.round((payDateOf(current, payDay) - day0) / 86400000);
        const lead = Math.max(1, num(settings.remindDaysBefore) || 3);
        const run = existing || await PayrollRun.findOne({ school: schoolId, year, month }).lean();
        if ((!run || run.status !== 'published') && daysToPay <= lead && daysToPay >= 0 && settings.lastReminderFor !== stampOf(current)) {
            const when = daysToPay === 0 ? 'today' : `in ${daysToPay} day${daysToPay === 1 ? '' : 's'}`;
            send('⏰ Payroll is due', run
                ? `${MONTHS[month - 1]} ${year} payroll is ${run.status} and pay day is ${when}. It has not been published yet.`
                : `${MONTHS[month - 1]} ${year} payroll has not been created and pay day is ${when}.`);
            await PayrollSettings.updateOne({ school: schoolId }, { lastReminderFor: stampOf(current) });
            did += 1;
        }
    }

    // ── 3. Say so when pay day has PASSED ────────────────────────────────────
    // The pay day for a month falls in the month after it, and by then
    // "the current month" has moved on — so the old overdue branch looked at a
    // month whose pay day was always still ahead, and could never fire. It is
    // the month BEFORE this one whose pay day can be behind us.
    {
        const last = monthBefore(current);
        const overdueBy = Math.round((day0 - payDateOf(last, payDay)) / 86400000);
        if (overdueBy >= 1 && overdueBy <= 10 && settings.lastOverdueFor !== stampOf(last)) {
            const run = await PayrollRun.findOne({ school: schoolId, year: last.year, month: last.month }).lean();
            // A school that never ran that month at all (payroll switched on
            // since) is not overdue for it.
            const everRan = run || await PayrollRun.countDocuments({ school: schoolId });
            if (everRan && (!run || !['published', 'cancelled'].includes(run.status))) {
                send('⚠️ Payroll is overdue', run
                    ? `${MONTHS[last.month - 1]} ${last.year} payroll is still ${run.status}, ${overdueBy} day${overdueBy === 1 ? '' : 's'} after pay day.`
                    : `${MONTHS[last.month - 1]} ${last.year} payroll was never created, and pay day was ${overdueBy} day${overdueBy === 1 ? '' : 's'} ago.`);
                did += 1;
            }
            await PayrollSettings.updateOne({ school: schoolId }, { lastOverdueFor: stampOf(last) });
        }
    }
    return did;
}

module.exports = { schoolsToSweep, sweepSchool, dueMonth };
