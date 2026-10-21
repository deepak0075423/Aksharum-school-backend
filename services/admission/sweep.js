'use strict';
/**
 * What happens in admissions because time passed, not because anyone clicked:
 *
 *   every minute   online attempts whose time is up are submitted; lists and
 *                  results booked for publication are published; offers past
 *                  their response or payment date lapse (and the waiting list
 *                  moves up)
 *   every 10 min   admit cards that became available, exam reminders,
 *                  admission-fee reminders, and a daily note to the people
 *                  handling a workflow stage about applications that have
 *                  waited past its deadline
 *
 * Every step claims its row before acting (a status compare-and-set, a stamp,
 * or a dated counter), so a restart or two servers never act twice. The read
 * paths run the same checks (an attempt past its deadline is submitted by the
 * next request that touches it), so a stopped sweep degrades rather than breaks.
 */
const pool = require('../../db/pool');
const { patch } = require('../../db/patch');
const exams = require('./exams');
const selection = require('./selection');
const settingsSvc = require('./settings');
const counters = require('./counters');
const workflow = require('./workflow');
const notify = require('./notify');
const fmt = require('./format');

async function schoolsWithAdmissions() {
    const { rows } = await pool.query(`SELECT "_id" FROM "schools" WHERE ("modules"->>'admission')::boolean IS TRUE AND "isActive" IS NOT FALSE`);
    return rows.map((r) => String(r._id));
}

async function minute() {
    const out = { submitted: 0, lists: 0, results: 0, expired: 0 };
    try { out.submitted = await exams.autoSubmitDue(); } catch (e) { console.error('[Admission] auto-submit:', e.message); }
    try { out.lists = await selection.publishDue(); } catch (e) { console.error('[Admission] scheduled lists:', e.message); }
    try { out.results = await exams.publishDue(); } catch (e) { console.error('[Admission] scheduled results:', e.message); }
    try { out.expired = await selection.expireDue(); } catch (e) { console.error('[Admission] offer expiry:', e.message); }
    return out;
}

async function examReminders(schoolId, settings) {
    const hours = Number(settings.email.reminders?.examHoursBefore) || 0;
    if (!hours) return 0;
    const { rows } = await pool.query(
        `SELECT c."_id" AS "candidateId", c."rollNumber", c."slot", e.*, a."_id" AS "appId"
           FROM "admissioncandidates" c
           JOIN "admissionexams" e ON e."_id" = c."exam" AND e."status" = 'scheduled'
           JOIN "admissionapplications" a ON a."_id" = c."application" AND a."status" NOT IN ('withdrawn', 'cancelled')
          WHERE c."school" = $1 AND c."status" = 'scheduled' AND c."remindedAt" IS NULL
            AND COALESCE(c."slot", e."startsAt") > now() AND COALESCE(c."slot", e."startsAt") <= now() + make_interval(hours => $2)
          LIMIT 200`, [schoolId, hours]);
    let n = 0;
    for (const r of rows) {
        const claimed = await pool.query(`UPDATE "admissioncandidates" SET "remindedAt" = now() WHERE "_id" = $1 AND "remindedAt" IS NULL RETURNING "_id"`, [r.candidateId]);
        if (!claimed.rowCount) continue;
        const { rows: [app] } = await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [r.appId]);
        notify.toApplicant(app, 'exam_reminder', exams.examValues(r, { rollNumber: r.rollNumber, slot: r.slot }));
        n += 1;
    }
    return n;
}

/**
 * Admit cards that can now be downloaded — at once, or from the release time
 * the exam set — each family told once, before the exam (written exams and
 * interviews; an online exam has no admit card).
 */
async function admitCards(schoolId) {
    const { rows } = await pool.query(
        `SELECT c."_id" AS "candidateId", c."rollNumber", c."slot", e.*, a."_id" AS "appId"
           FROM "admissioncandidates" c
           JOIN "admissionexams" e ON e."_id" = c."exam" AND e."status" = 'scheduled' AND e."mode" <> 'online'
                AND (e."admitCard"->>'enabled')::boolean IS TRUE
                AND ((e."admitCard"->>'releaseAt') IS NULL OR (e."admitCard"->>'releaseAt')::timestamptz <= now())
           JOIN "admissionapplications" a ON a."_id" = c."application" AND a."status" NOT IN ('withdrawn', 'cancelled')
          WHERE c."school" = $1 AND c."status" = 'scheduled' AND c."admitNotifiedAt" IS NULL
            AND COALESCE(c."slot", e."startsAt") > now()
          LIMIT 200`, [schoolId]);
    let n = 0;
    for (const r of rows) {
        const claimed = await pool.query(`UPDATE "admissioncandidates" SET "admitNotifiedAt" = now() WHERE "_id" = $1 AND "admitNotifiedAt" IS NULL RETURNING "_id"`, [r.candidateId]);
        if (!claimed.rowCount) continue;
        const { rows: [app] } = await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [r.appId]);
        notify.toApplicant(app, 'admit_card_available', exams.examValues(r, { rollNumber: r.rollNumber, slot: r.slot }));
        n += 1;
    }
    return n;
}

async function paymentReminders(schoolId, settings) {
    const days = Number(settings.email.reminders?.paymentDaysBefore) || 0;
    if (!days) return 0;
    const { rows } = await pool.query(
        `SELECT o.*, a."_id" AS "appId" FROM "admissionoffers" o
           JOIN "admissionapplications" a ON a."_id" = o."application" AND a."admissionFeeStatus" = 'due'
          WHERE o."school" = $1 AND o."status" = 'accepted' AND o."remindedAt" IS NULL AND o."feeDueAt" IS NOT NULL
            AND o."feeDueAt" > now() AND o."feeDueAt" <= now() + make_interval(days => $2)
            AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(o."schedule") = 'array' THEN o."schedule" END), 0) < 2
          LIMIT 200`, [schoolId, days]);
    let n = 0;
    for (const o of rows) {
        const claimed = await patch(require('../../models/AdmissionOffer'), o._id, { remindedAt: new Date() }, { where: { remindedAt: null }, touch: false });
        if (!claimed) continue;
        const { rows: [app] } = await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [o.appId]);
        notify.toApplicant(app, 'payment_reminder', { fee_amount: fmt.money(o.feeAmount), payment_deadline: fmt.fmtDate(o.feeDueAt), offer_deadline: fmt.fmtDate(o.respondBy), admission_deadline: fmt.fmtDate(o.feeDueAt) });
        n += 1;
    }
    // Instalment plans: each instalment still owed, once, the same number of days before it falls due.
    const { rows: plans } = await pool.query(
        `SELECT o."_id", o."schedule", o."application" FROM "admissionoffers" o
           JOIN "admissionapplications" a ON a."_id" = o."application" AND a."admissionFeeStatus" = 'due'
          WHERE o."school" = $1 AND o."status" IN ('accepted', 'confirmed') AND jsonb_typeof(o."schedule") = 'array' AND jsonb_array_length(o."schedule") > 1
          LIMIT 200`, [schoolId]);
    for (const o of plans) {
        const { rows: [app] } = await pool.query(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [o.application]);
        const plan = await require('./payments').scheduleOf(app);
        for (const part of plan || []) {
            if (part.owing <= 0 || !part.dueAt) continue;
            const due = new Date(part.dueAt).getTime();
            if (due <= Date.now() || due > Date.now() + days * 86400000) continue;
            const { rowCount } = await pool.query(
                `UPDATE "admissionoffers" SET "schedule" = jsonb_set("schedule", ARRAY[$2::text, 'remindedAt'], to_jsonb(now()::text))
                  WHERE "_id" = $1 AND ("schedule" -> $3::int ->> 'remindedAt') IS NULL`, [o._id, String(part.index), part.index]);
            if (!rowCount) continue;
            notify.toApplicant(app, 'payment_reminder', {
                fee_amount: fmt.money(part.owing), payment_deadline: fmt.fmtDate(part.dueAt), admission_deadline: fmt.fmtDate(part.dueAt), offer_deadline: fmt.fmtDate(part.dueAt),
            });
            n += 1;
        }
    }
    return n;
}

/** Once a day per stage: who handles it hears about applications waiting past its deadline. */
async function stageDigests(schoolId, settings) {
    const flow = workflow.compile(settings.workflow);
    const today = new Date().toISOString().slice(0, 10);
    let sent = 0;
    for (const stage of flow.stages.filter((s) => s.enabled && s.deadlineDays)) {
        const statuses = Object.entries(workflow.STATUSES).filter(([, m]) => m.stage === stage.key && !m.closed).map(([k]) => k);
        if (!statuses.length) continue;
        const { rows: [c] } = await pool.query(
            `SELECT COUNT(*)::int AS n FROM "admissionapplications" WHERE "school" = $1 AND "status" = ANY($2::text[])
               AND COALESCE("statusChangedAt", "updatedAt") < now() - make_interval(days => $3)`, [schoolId, statuses, stage.deadlineDays]);
        if (!c.n) continue;
        // One a day per stage, whichever server gets there first.
        if (await counters.advance(schoolId, `digest:${stage.key}:${today}`) !== 1) continue;
        const admins = await require('../designationService').moduleAdminIds(schoolId, 'admission');
        const recipients = [...new Set([...(stage.assignees || []), ...admins].map(String))];
        if (!recipients.length) continue;
        require('../notifyService').notify({
            school: schoolId, sender: recipients[0], senderRole: 'system', recipients, includeSender: true,
            title: `${c.n} application${c.n === 1 ? '' : 's'} waiting in ${stage.label}`,
            body: `${c.n} application${c.n === 1 ? ' has' : 's have'} been in ${stage.label} for more than ${stage.deadlineDays} day${stage.deadlineDays === 1 ? '' : 's'}.`,
            link: { type: 'admission.applications', params: { stage: stage.key } },
        });
        sent += 1;
    }
    return sent;
}

/** The school's retention periods (services/admission/privacy.js) — once a day, whichever server gets there first. */
async function retention(schoolId, settings) {
    if (!settings.privacy?.retention?.enabled) return 0;
    const today = new Date().toISOString().slice(0, 10);
    if (await counters.advance(schoolId, `retention:${today}`) !== 1) return 0;
    const r = await require('./privacy').runRetention(schoolId, settings);
    return (r.erased || 0) + (r.drafts || 0);
}

async function tenMinutes() {
    const out = { admit: 0, exam: 0, payment: 0, digests: 0, erased: 0, visits: 0 };
    for (const schoolId of await schoolsWithAdmissions()) {
        try {
            const settings = await settingsSvc.getSettings(schoolId);
            out.admit += await admitCards(schoolId);
            out.exam += await examReminders(schoolId, settings);
            out.payment += await paymentReminders(schoolId, settings);
            out.digests += await stageDigests(schoolId, settings);
            out.erased += await retention(schoolId, settings);
            out.visits += await require('./visits').reminders(schoolId, settings);
            out.followUps = (out.followUps || 0) + await require('./crm').followUpReminders(schoolId);
        } catch (e) { console.error(`[Admission] reminders for ${schoolId}:`, e.message); }
    }
    // DigiLocker connections past their thirty minutes lose their tokens.
    await require('./digilocker').expire().catch((e) => console.error('[Admission] digilocker expiry:', e.message));
    return out;
}

function start() {
    const runs = require('./jobRuns');
    const fast = async () => {
        const r = await runs.record('sweep.minute', minute);
        await runs.record('exports.worker', () => require('./exportJobs').sweep());
        if (r.submitted || r.lists || r.results || r.expired) {
            console.log(`[Admission] sweep: ${r.submitted} attempt(s) submitted, ${r.lists} list(s) and ${r.results} result set(s) published, ${r.expired} offer(s) lapsed`);
        }
    };
    const slow = async () => {
        const r = await runs.record('sweep.reminders', tenMinutes);
        await runs.prune();
        if (r.admit || r.exam || r.payment || r.digests || r.visits) console.log(`[Admission] reminders: ${r.admit} admit card, ${r.exam} exam, ${r.payment} payment, ${r.visits} visit, ${r.digests} stage digest(s)`);
        if (r.erased) console.log(`[Admission] retention: ${r.erased} application(s) erased or old drafts deleted`);
    };
    setTimeout(fast, 35 * 1000);
    setInterval(fast, 60 * 1000);
    setTimeout(slow, 120 * 1000);
    setInterval(slow, 10 * 60 * 1000);
}

module.exports = { start, minute, tenMinutes, admitCards, examReminders, paymentReminders, stageDigests, retention };
