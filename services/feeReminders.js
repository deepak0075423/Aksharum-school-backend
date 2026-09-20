'use strict';
/**
 * Chasing unpaid fees — by hand from the office, and on a timetable.
 *
 * Both routes end in the same place: `send()`. It works out what a family
 * owes, writes the reminder to the log, and only then notifies. The log is
 * the point. Without it the office cannot tell whether a parent was chased
 * yesterday, and the hourly sweep would chase them again on every tick.
 *
 * What the sweep sends is decided per MONTH, not per balance: a family is
 * given notice before a month falls due, told on the day, and nudged a few
 * days later if it is still unpaid. Each of those is one reminder, once, ever
 * — enforced by a partial unique index on FeeReminderLog and by a read here.
 *
 * Nothing sends itself until a school switches it on. This writes to real
 * parents.
 */
const pool = require('../db/pool');
const FeeSettings = require('../models/FeeSettings');
const FeeReminderLog = require('../models/FeeReminderLog');
const AcademicYear = require('../models/AcademicYear');
const User = require('../models/User');
const { notify, withParents } = require('./notifyService');

const T = (M) => `"${M.tableName}"`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Today where the school is, as 'YYYY-MM-DD'. */
function localDay(d = new Date()) {
    const tz = process.env.APP_TIMEZONE || 'Asia/Kolkata';
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
/** The hour of the day where the school is, 0–23. */
function localHour(d = new Date()) {
    const tz = process.env.APP_TIMEZONE || 'Asia/Kolkata';
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(d));
}
/** 'YYYY-MM-DD' shifted by whole days, without touching the clock. */
function shiftDay(day, n) {
    const [y, m, d] = String(day).split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
}

const list = (v) => (Array.isArray(v) ? v : []).map(Number).filter(n => Number.isFinite(n) && n > 0 && n <= 90);

/**
 * What the settings ask for, cleaned up. `beforeDays`/`afterDays` are days,
 * de-duplicated and sorted, because "3, 3, 7" is one reminder at 3 and one
 * at 7.
 */
function plan(settings) {
    const a = settings?.autoReminders || {};
    return {
        enabled: a.enabled === true,
        beforeDays: [...new Set(list(a.beforeDays))].sort((x, y) => x - y),
        onDueDay: a.onDueDay !== false,
        afterDays: [...new Set(list(a.afterDays))].sort((x, y) => x - y),
        minAmount: Math.max(0, Number(a.minAmount) || 0),
        emailParents: a.emailParents !== false,
        sendHour: Math.min(23, Math.max(0, Number.isFinite(Number(a.sendHour)) ? Number(a.sendHour) : 9)),
    };
}

/**
 * Send one reminder and record it. Returns false when it was already sent —
 * the caller counts, it does not have to think.
 *
 * `monthKey` null means "the balance as a whole", which is what a reminder
 * sent by hand from the office is about.
 */
async function send({ schoolId, student, year, amount, kind, monthKey = null, monthLabel = '', note = '',
    auto = false, sentBy = null, sender = null, senderRole = 'school_admin', emailParents = true, sym = '₹' }) {
    const day = localDay();
    if (auto) {
        const already = await FeeReminderLog.findOne({
            school: schoolId, student: student._id, academicYear: year._id, monthKey, kind,
        }).select('_id').lean();
        if (already) return false;
    }

    // The log is written first. A reminder that was sent but not recorded
    // would be sent again on the next tick; one recorded but not delivered is
    // merely a reminder the family did not get, which the office can repeat.
    let logged;
    try {
        logged = await FeeReminderLog.create({
            school: schoolId, student: student._id, academicYear: year._id,
            kind, monthKey, amount: r2(amount), sentOn: day,
            channel: emailParents ? 'app+email' : 'app', auto, sentBy,
        });
    } catch (e) {
        // The unique index caught a duplicate the read above raced past.
        if (/duplicate key|unique/i.test(e.message || '')) return false;
        throw e;
    }

    const money = `${sym}${r2(amount).toLocaleString('en-IN')}`;
    const when = monthLabel ? ` for ${monthLabel}` : '';
    const title = kind.startsWith('after') ? '⚠️ Fee overdue'
        : kind.startsWith('before') ? '🔔 Fee due soon'
            : kind === 'due' ? '🔔 Fee due today' : '🔔 Fee reminder';
    const lead = kind.startsWith('after')
        ? `${money}${when} is overdue for ${student.name}.`
        : kind === 'due'
            ? `${money}${when} is due today for ${student.name}.`
            : kind.startsWith('before')
                ? `${money}${when} falls due shortly for ${student.name}.`
                : `${money} is due for ${student.name} (${year.yearName}).`;

    withParents([student._id]).then(targets => notify({
        school: schoolId, sender, senderRole,
        title,
        body: `${lead}${note ? `\n${note}` : ''}\nYou can pay online from the fees page, or at the school office.`,
        recipients: targets,
        email: emailParents,
        link: { type: 'fees.mine' },
    })).catch(() => {});
    return logged;
}

/**
 * The students a school's automatic reminders are about today, and which
 * reminder each one has earned.
 *
 * The months and what is left on them come from the family's own fee book, so
 * a reminder can never disagree with the screen the family is looking at.
 * That costs a fee book per student who owes, which is why only students with
 * a balance are looked at and why the run is capped.
 */
async function due(schoolId, { today = localDay(), cap = 1000 } = {}) {
    const settings = await FeeSettings.findOne({ school: schoolId }).lean();
    const p = plan(settings);
    if (!p.enabled) return { plan: p, items: [] };

    const year = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    if (!year) return { plan: p, items: [] };

    // Only families that owe something are worth the work.
    const { rows } = await pool.query(
        `SELECT l."student",
                SUM(CASE WHEN l."entryType" = 'debit' THEN l."amount" ELSE -l."amount" END) AS "due"
           FROM ${T(require('../models/FeeLedger'))} l
           JOIN ${T(User)} u ON u."_id" = l."student"
          WHERE l."school" = $1 AND l."academicYear" = $2
            AND u."role" = 'student' AND u."isActive" IS NOT FALSE
          GROUP BY 1 HAVING SUM(CASE WHEN l."entryType" = 'debit' THEN l."amount" ELSE -l."amount" END) > 0.004
          ORDER BY 2 DESC LIMIT $3`,
        [String(schoolId), String(year._id), cap]);
    if (!rows.length) return { plan: p, items: [] };

    const { buildFeeBook } = require('../controllers/feesStudent.controller');
    const students = await User.find({ _id: { $in: rows.map(r => r.student) } }).select('name').lean();
    const nameBy = new Map(students.map(s => [String(s._id), s.name]));

    const items = [];
    for (const row of rows) {
        const studentId = String(row.student);
        const book = await buildFeeBook(schoolId, studentId);
        for (const m of book.monthlySchedule || []) {
            const owed = m.payable != null ? m.payable : m.amountDue;
            // A month already covered by a payment awaiting approval is not
            // chased: the family has done their part.
            if (!(owed > 0.004) || m.payStatus === 'cancelled' || !m.dueDate) continue;
            if (owed < p.minAmount) continue;

            let kind = null;
            if (p.onDueDay && m.dueDate === today) kind = 'due';
            if (!kind) for (const n of p.beforeDays) if (shiftDay(m.dueDate, -n) === today) { kind = `before-${n}`; break; }
            if (!kind) for (const n of p.afterDays) if (shiftDay(m.dueDate, n) === today) { kind = `after-${n}`; break; }
            if (!kind) continue;

            items.push({
                studentId, name: nameBy.get(studentId) || 'Student',
                monthKey: m.monthKey, monthLabel: m.monthLabel, amount: r2(owed), kind, dueDate: m.dueDate,
            });
        }
    }
    return { plan: p, year, items, considered: rows.length, capped: rows.length >= cap };
}

/**
 * One school's automatic run. Sends only in the school's chosen hour, so an
 * hourly tick does not turn into hourly reminders, and never sends anything
 * already logged.
 */
async function runReminderSweep(schoolId, { force = false, today = localDay() } = {}) {
    const settings = await FeeSettings.findOne({ school: schoolId }).lean();
    const p = plan(settings);
    if (!p.enabled) return 0;
    if (!force && localHour() !== p.sendHour) return 0;

    const { items, year } = await due(schoolId, { today });
    if (!items || !items.length) return 0;
    const sym = settings?.currencySymbol || '₹';

    let sent = 0;
    for (const it of items) {
        const done = await send({
            schoolId, student: { _id: it.studentId, name: it.name }, year,
            amount: it.amount, kind: it.kind, monthKey: it.monthKey, monthLabel: it.monthLabel,
            auto: true, emailParents: p.emailParents, sym,
        });
        if (done) sent++;
    }
    return sent;
}

/** Schools that have switched automatic reminders on. */
async function schoolsWithAutoReminders() {
    const { rows } = await pool.query(
        `SELECT "school" FROM ${T(FeeSettings)}
          WHERE ("autoReminders"->>'enabled')::boolean IS TRUE`);
    return rows.map(r => r.school);
}

module.exports = { send, due, plan, runReminderSweep, schoolsWithAutoReminders, localDay, localHour, shiftDay };
