'use strict';
/**
 * What happens in admissions because time passed, not because anyone clicked:
 *
 *   every minute   online attempts whose time is up are submitted; lists and
 *                  results booked for publication are published; offers past
 *                  their response or payment date lapse (and the waiting list
 *                  moves up); exams whose time is over are closed; online
 *                  payments nobody came back from are checked with the
 *                  gateway, and refunds it has not settled are followed up;
 *                  emails waiting in the queue, or due another try, go out
 *   every 10 min   admit cards that became available, exam reminders,
 *                  admission-fee reminders (before the date, and once after
 *                  it for an instalment), an offer about to lapse, a draft
 *                  not submitted with the round about to close, documents
 *                  still owed near their date; a daily note to the people
 *                  handling a workflow stage about applications that have
 *                  waited past its deadline, and a daily summary for the
 *                  office (after 9 in the morning, the school's time)
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
const { dayKey } = require('./util');

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
    try { out.closed = await exams.completeDue(); } catch (e) { console.error('[Admission] exam closing:', e.message); }
    try { out.payments = (await require('./payments').reconcileOpen()).paid; } catch (e) { console.error('[Admission] payment check:', e.message); }
    try { out.refunds = (await require('./payments').followRefunds()).checked; } catch (e) { console.error('[Admission] refund follow-up:', e.message); }
    try { out.mail = await require('./mailer').drain(); } catch (e) { console.error('[Admission] mail queue:', e.message); }
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
    // The school's own day, and not before nine in the morning: by the UTC date
    // it went out at half past five.
    if (new Date().getHours() < 9) return 0;
    const today = dayKey(new Date());
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
    const today = dayKey(new Date());
    if (await counters.advance(schoolId, `retention:${today}`) !== 1) return 0;
    const r = await require('./privacy').runRetention(schoolId, settings);
    return (r.erased || 0) + (r.drafts || 0);
}

/** A draft still not submitted with its round about to close: the family is told once. */
async function draftReminders(schoolId, settings) {
    const days = Number(settings.email.reminders?.draftDaysBefore) || 0;
    if (!days) return 0;
    const { rows } = await pool.query(
        `SELECT a.*, r."closesAt" FROM "admissionapplications" a
           JOIN "admissionrounds" r ON r."_id" = a."round" AND r."status" = 'open' AND r."closesAt" IS NOT NULL AND r."closesAt" > now() AND r."closesAt" <= now() + make_interval(days => $2)
          WHERE a."school" = $1 AND a."status" = 'draft' AND a."submittedAt" IS NULL AND a."createdAt" < now() - interval '12 hours'
            AND (a."flags"->>'draftRemindedAt') IS NULL
          LIMIT 200`, [schoolId, days]);
    let n = 0;
    for (const app of rows) {
        const claimed = await pool.query(
            `UPDATE "admissionapplications" SET "flags" = COALESCE("flags", '{}'::jsonb) || jsonb_build_object('draftRemindedAt', now()::text)
              WHERE "_id" = $1 AND "status" = 'draft' AND ("flags"->>'draftRemindedAt') IS NULL RETURNING "_id"`, [app._id]);
        if (!claimed.rowCount) continue;
        notify.toApplicant(app, 'draft_reminder', { closing_date: fmt.fmtDate(app.closesAt) });
        n += 1;
    }
    return n;
}

/**
 * Documents still owed, near their date — a type's own "days after
 * submission", else the round's document date (both were stored and shown,
 * and nothing ever came of them). The family is told once, with the list.
 */
async function documentReminders(schoolId, settings) {
    const days = Number(settings.email.reminders?.documentsDaysBefore) || 0;
    if (!days) return 0;
    const documents = require('./documents');
    const types = await documents.typesOf(schoolId);
    const own = [...new Set([...types.values()].map((t) => Number(t.deadlineDays) || 0).filter(Boolean))];
    const { rows } = await pool.query(
        `SELECT a.*, r."documentDeadline" FROM "admissionapplications" a JOIN "admissionrounds" r ON r."_id" = a."round"
          WHERE a."school" = $1 AND a."docStatus" IN ('missing', 'rejected') AND a."submittedAt" IS NOT NULL
            AND a."status" IN ('submitted', 'under_review', 'documents_pending', 'documents_rejected', 'verified', 'eligible', 'exam_scheduled', 'exam_completed',
                               'interview_scheduled', 'interview_completed', 'evaluated', 'selected', 'waitlisted', 'offer_issued', 'accepted', 'payment_pending')
            AND (a."flags"->>'docsRemindedAt') IS NULL
            AND ((r."documentDeadline" > now() AND r."documentDeadline" <= now() + make_interval(days => $2))
                 OR EXISTS (SELECT 1 FROM unnest($3::int[]) d WHERE a."submittedAt" + make_interval(days => d) > now() AND a."submittedAt" + make_interval(days => d) <= now() + make_interval(days => $2)))
          LIMIT 200`, [schoolId, days, own]);
    let n = 0;
    const apps = require('./applications');
    for (const app of rows) {
        const schema = await apps.schemaOf(app);
        const reqs = documents.requirements(app, schema, types);
        const have = new Map((await documents.currentDocs(app._id)).map((d) => [d.docKey, d]));
        const due = documents.dueDates(app, reqs, { documentDeadline: app.documentDeadline });
        const owed = reqs.filter((r) => r.required && (!have.get(r.type.key) || ['rejected', 'resubmission_required'].includes(have.get(r.type.key).status)))
            .map((r) => ({ name: r.type.name, at: due.get(r.type.key) }))
            .filter((x) => x.at && x.at.getTime() > Date.now() && x.at.getTime() <= Date.now() + days * 86400000);
        if (!owed.length) continue;
        const claimed = await pool.query(
            `UPDATE "admissionapplications" SET "flags" = COALESCE("flags", '{}'::jsonb) || jsonb_build_object('docsRemindedAt', now()::text)
              WHERE "_id" = $1 AND ("flags"->>'docsRemindedAt') IS NULL RETURNING "_id"`, [app._id]);
        if (!claimed.rowCount) continue;
        const first = owed.reduce((a, b) => (a.at < b.at ? a : b));
        notify.toApplicant(app, 'documents_reminder', { document_name: owed.map((x) => x.name).join(', '), documents_deadline: fmt.fmtDate(first.at) });
        n += 1;
    }
    return n;
}

/**
 * Once a day, after nine: what is waiting for the admission office — new
 * applications since yesterday, approvals, appeals and privacy requests near
 * or past their date, documents past theirs. One note for the administrators;
 * nothing is sent on a day with nothing in it.
 */
async function officeDigest(schoolId) {
    if (new Date().getHours() < 9) return 0;
    const { rows: [c] } = await pool.query(
        `SELECT
            (SELECT COUNT(*) FROM "admissionapplications" WHERE "school" = $1 AND "submittedAt" > now() - interval '24 hours')::int AS "new",
            (SELECT COUNT(*) FROM "admissionapplications" WHERE "school" = $1 AND "pendingTransition" IS NOT NULL)::int AS approvals,
            (SELECT COUNT(*) FROM "admissionlists" WHERE "school" = $1 AND "status" = 'pending_approval')::int AS lists,
            (SELECT COUNT(*) FROM "admissionexams" WHERE "school" = $1 AND "resultsStatus" = 'submitted')::int AS results,
            (SELECT COUNT(*) FROM "admissionappeals" WHERE "school" = $1 AND "status" IN ('open', 'in_review') AND "dueAt" < now() + interval '2 days')::int AS appeals,
            (SELECT COUNT(*) FROM "admissiondatarequests" WHERE "school" = $1 AND "status" IN ('open', 'in_progress') AND "dueAt" < now() + interval '5 days')::int AS privacy,
            (SELECT COUNT(*) FROM "admissionpayments" WHERE "school" = $1 AND "status" = 'paid' AND "clearance" = 'pending' AND "paidAt" < now() - interval '5 days')::int AS cheques,
            (SELECT COUNT(*) FROM "admissionapplications" a JOIN "admissionrounds" r ON r."_id" = a."round"
              WHERE a."school" = $1 AND a."docStatus" IN ('missing', 'rejected') AND a."submittedAt" IS NOT NULL AND r."documentDeadline" < now()
                AND a."status" NOT IN ('draft', 'withdrawn', 'cancelled', 'rejected', 'ineligible', 'declined', 'enrolled', 'offer_expired'))::int AS documents`,
        [schoolId]);
    const lines = [
        c.new && `${c.new} new application${c.new === 1 ? '' : 's'} since yesterday`,
        c.approvals && `${c.approvals} move${c.approvals === 1 ? '' : 's'} waiting for approval`,
        c.lists && `${c.lists} selection list${c.lists === 1 ? '' : 's'} waiting for approval`,
        c.results && `${c.results} set${c.results === 1 ? '' : 's'} of results waiting for approval`,
        c.appeals && `${c.appeals} appeal${c.appeals === 1 ? '' : 's'} due within two days or overdue`,
        c.privacy && `${c.privacy} privacy request${c.privacy === 1 ? '' : 's'} due within five days or overdue`,
        c.cheques && `${c.cheques} cheque${c.cheques === 1 ? '' : 's'} not marked cleared after five days`,
        c.documents && `${c.documents} application${c.documents === 1 ? '' : 's'} with documents past the round's date`,
    ].filter(Boolean);
    if (!lines.length) return 0;
    if (await counters.advance(schoolId, `office-digest:${dayKey(new Date())}`) !== 1) return 0;
    require('./staffAlerts').toAdmins(schoolId, { title: 'Admissions today', body: `${lines.join('; ')}.`, link: { type: 'admission.applications' } });
    return 1;
}

async function tenMinutes() {
    const out = { admit: 0, exam: 0, payment: 0, digests: 0, erased: 0, visits: 0, offers: 0, drafts: 0, documents: 0, overdue: 0 };
    for (const schoolId of await schoolsWithAdmissions()) {
        try {
            const settings = await settingsSvc.getSettings(schoolId);
            out.admit += await admitCards(schoolId);
            out.exam += await examReminders(schoolId, settings);
            out.payment += await paymentReminders(schoolId, settings);
            out.digests += await stageDigests(schoolId, settings);
            out.digests += await officeDigest(schoolId);
            out.offers += await selection.lapseWarnings(schoolId, settings);
            out.drafts += await draftReminders(schoolId, settings);
            out.documents += await documentReminders(schoolId, settings);
            out.overdue += await require('./payments').instalmentsOverdue(schoolId);
            out.erased += await retention(schoolId, settings);
            out.visits += await require('./visits').reminders(schoolId, settings);
            out.followUps = (out.followUps || 0) + await require('./crm').followUpReminders(schoolId);
        } catch (e) { console.error(`[Admission] reminders for ${schoolId}:`, e.message); }
    }
    // DigiLocker connections past their thirty minutes lose their tokens.
    await require('./digilocker').expire().catch((e) => console.error('[Admission] digilocker expiry:', e.message));
    // Sign-up codes a day old; files the virus scanner could not check when they came in.
    out.codes = await require('./privacy').purgeCodes().catch((e) => { console.error('[Admission] code purge:', e.message); return 0; });
    out.rescanned = await require('./documents').rescanPending().catch((e) => { console.error('[Admission] rescan:', e.message); return 0; });
    return out;
}

function start() {
    const runs = require('./jobRuns');
    const fast = async () => {
        const r = await runs.record('sweep.minute', minute);
        await runs.record('exports.worker', () => require('./exportJobs').sweep());
        if (r.submitted || r.lists || r.results || r.expired || r.closed || r.payments) {
            console.log(`[Admission] sweep: ${r.submitted} attempt(s) submitted, ${r.lists} list(s) and ${r.results} result set(s) published, ${r.expired} offer(s) lapsed, ${r.closed || 0} exam(s) closed, ${r.payments || 0} payment(s) confirmed with the gateway`);
        }
    };
    const slow = async () => {
        const r = await runs.record('sweep.reminders', tenMinutes);
        await runs.prune();
        if (r.admit || r.exam || r.payment || r.digests || r.visits || r.offers || r.drafts || r.documents || r.overdue) {
            console.log(`[Admission] reminders: ${r.admit} admit card, ${r.exam} exam, ${r.payment} payment, ${r.offers} offer, ${r.drafts} draft, ${r.documents} document, ${r.overdue} overdue instalment, ${r.visits} visit, ${r.digests} digest(s)`);
        }
        if (r.erased) console.log(`[Admission] retention: ${r.erased} application(s) erased or old drafts deleted`);
    };
    setTimeout(fast, 35 * 1000);
    setInterval(fast, 60 * 1000);
    setTimeout(slow, 120 * 1000);
    setInterval(slow, 10 * 60 * 1000);
}

module.exports = { start, minute, tenMinutes, admitCards, examReminders, paymentReminders, stageDigests, retention, draftReminders, documentReminders, officeDigest };
