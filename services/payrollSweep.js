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
 * The month a run should exist for right now: the one that has ENDED. Payroll
 * for September is made in late September or early October, never in August.
 */
function dueMonth(today = new Date()) {
    const d = new Date(today.getFullYear(), today.getMonth(), 1);
    return { month: d.getMonth() + 1, year: d.getFullYear() };
}

async function sweepSchool(schoolId) {
    const settings = await PayrollSettings.findOne({ school: schoolId }).lean();
    if (!settings) return 0;

    const today = new Date();
    const { month, year } = dueMonth(today);
    const existing = await PayrollRun.findOne({ school: schoolId, year, month }).lean();
    let did = 0;

    // ── 1. Open the month ────────────────────────────────────────────────────
    // On or after the configured day of the month, and never for a month that
    // has not finished yet.
    const openOn = Math.min(28, Math.max(1, num(settings.autoOpenDay) || 25));
    if (settings.autoOpenRun === true && !existing && today.getDate() >= openOn) {
        const admin = require('../controllers/payrollAdmin.controller');
        try {
            const workingDays = await require('./payrollCalc').workingDaysFor(schoolId, year, month, settings);
            const payDay = Math.min(28, Math.max(1, num(settings.payDay) || 1));
            const run = await PayrollRun.create({
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
        }
    }

    // ── 2. Remind, once, when pay day is close ───────────────────────────────
    if (settings.remindBeforePayDay === true) {
        const payDay = Math.min(28, Math.max(1, num(settings.payDay) || 1));
        const payDate = new Date(month === 12 ? year + 1 : year, month === 12 ? 0 : month, payDay);
        const daysToPay = Math.round((payDate - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
        const lead = Math.max(1, num(settings.remindDaysBefore) || 3);
        const stamp = `${year}-${String(month).padStart(2, '0')}`;

        const run = existing || await PayrollRun.findOne({ school: schoolId, year, month }).lean();
        const unfinished = !run || run.status !== 'published';

        if (unfinished && daysToPay <= lead && daysToPay >= -7 && settings.lastReminderFor !== stamp) {
            const admins = await User.find({ school: schoolId, role: 'school_admin', isActive: true }).select('_id').lean();
            if (admins.length) {
                await notify({
                    school: schoolId, sender: null, senderRole: 'system',
                    title: '⏰ Payroll is due',
                    body: run
                        ? `${MONTHS[month - 1]} ${year} payroll is ${run.status} and pay day is ${daysToPay < 0 ? `${Math.abs(daysToPay)} days past` : `in ${daysToPay} day${daysToPay === 1 ? '' : 's'}`}. It has not been published yet.`
                        : `${MONTHS[month - 1]} ${year} payroll has not been created and pay day is ${daysToPay < 0 ? `${Math.abs(daysToPay)} days past` : `in ${daysToPay} day${daysToPay === 1 ? '' : 's'}`}.`,
                    recipients: admins.map(a => a._id),
                    email: true,
                    link: { type: 'payroll.runs' },
                });
                await PayrollSettings.updateOne({ school: schoolId }, { lastReminderFor: stamp });
                did += 1;
            }
        }
    }
    return did;
}

module.exports = { schoolsToSweep, sweepSchool, dueMonth };
