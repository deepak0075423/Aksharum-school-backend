'use strict';
/**
 * The admission workflow — what an application can move to, when, and by whom.
 *
 * Two catalogues, both fixed in code because the engine has to understand
 * them: STAGES (the steps of the process) and STATUSES (where an application
 * stands, each belonging to a stage). What a school configures is DATA over
 * those catalogues (settings.workflow): which optional stages run, the order
 * of the movable ones, labels, who handles a stage, deadlines and reminders,
 * the checks that must pass before an application may enter it, and whether
 * entering it needs an administrator's approval. Nothing a school writes is
 * ever executed.
 *
 * What configuration cannot do:
 *   - reach a status that belongs to its own action — an offer is issued by
 *     issuing an offer, a seat confirmed by confirming it (seat, fee and
 *     document checks), a student created by the conversion — never by
 *     typing a status (`system` below);
 *   - move an application backwards except along the "send back" paths
 *     (incomplete, documents) or an administrator's explicit reopen;
 *   - leave a closed application except by that reopen.
 */

const STAGES = [
    { key: 'enquiry',               label: 'Enquiry',                    optional: true,  defaultOn: true },
    { key: 'registration',          label: 'Registration',               optional: false },
    { key: 'draft',                 label: 'Application Draft',          optional: false },
    { key: 'submitted',             label: 'Application Submitted',      optional: false },
    { key: 'document_verification', label: 'Document Verification',      optional: true,  defaultOn: true,  movable: true },
    { key: 'eligibility',           label: 'Eligibility Check',          optional: true,  defaultOn: true,  movable: true },
    { key: 'exam',                  label: 'Entrance Examination',       optional: true,  defaultOn: true,  movable: true },
    { key: 'interview',             label: 'Interview',                  optional: true,  defaultOn: false, movable: true },
    { key: 'evaluation',            label: 'Evaluation',                 optional: true,  defaultOn: true },
    { key: 'selection',             label: 'Selection',                  optional: false },
    { key: 'offer',                 label: 'Offer',                      optional: true,  defaultOn: true },
    { key: 'fee_payment',           label: 'Fee Payment',                optional: true,  defaultOn: true },
    { key: 'confirmation',          label: 'Admission Confirmation',     optional: false },
    { key: 'activation',            label: 'Student Account Activation', optional: false },
];
const STAGE_KEYS = STAGES.map((s) => s.key);
const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));
const MOVABLE = STAGES.filter((s) => s.movable).map((s) => s.key);

/**
 *   stage      the stage it belongs to (null: closes the application wherever it is)
 *   system     set only by its own action, never by the transition endpoint
 *   closed     the application is finished; only a reopen leaves it
 *   reopenable an administrator may reopen it (back to Under Review)
 *   sendBack   allowed even though its stage is earlier than the current one
 *   applicant  how the family's tracking page words it
 */
const STATUSES = {
    draft:               { stage: 'draft',                 label: 'Draft',               tone: 'gray',   system: true,  applicant: 'Draft — not submitted yet' },
    submitted:           { stage: 'submitted',             label: 'Submitted',           tone: 'blue',   system: true,  applicant: 'Submitted — waiting for review' },
    incomplete:          { stage: 'submitted',             label: 'Incomplete',          tone: 'amber',  sendBack: true, applicant: 'More information needed — please update and resubmit' },
    under_review:        { stage: 'document_verification', label: 'Under Review',        tone: 'blue',   sendBack: true, applicant: 'Under review' },
    documents_pending:   { stage: 'document_verification', label: 'Documents Pending',   tone: 'amber',  sendBack: true, applicant: 'Documents pending — please upload the documents asked for' },
    documents_rejected:  { stage: 'document_verification', label: 'Documents Rejected',  tone: 'red',    sendBack: true, applicant: 'A document was not accepted — please upload it again' },
    verified:            { stage: 'document_verification', label: 'Verified',            tone: 'green',  applicant: 'Documents verified' },
    eligible:            { stage: 'eligibility',           label: 'Eligible',            tone: 'green',  applicant: 'Eligible' },
    ineligible:          { stage: 'eligibility',           label: 'Ineligible',          tone: 'red',    closed: true, reopenable: true, applicant: 'Not eligible for this class' },
    exam_scheduled:      { stage: 'exam',                  label: 'Exam Scheduled',      tone: 'indigo', system: true,  applicant: 'Entrance exam scheduled' },
    exam_completed:      { stage: 'exam',                  label: 'Exam Completed',      tone: 'indigo', applicant: 'Entrance exam completed' },
    interview_scheduled: { stage: 'interview',             label: 'Interview Scheduled', tone: 'indigo', applicant: 'Interview scheduled' },
    interview_completed: { stage: 'interview',             label: 'Interview Completed', tone: 'indigo', applicant: 'Interview completed' },
    evaluated:           { stage: 'evaluation',            label: 'Evaluated',           tone: 'violet', applicant: 'Evaluation complete' },
    selected:            { stage: 'selection',             label: 'Selected',            tone: 'green',  applicant: 'Selected' },
    waitlisted:          { stage: 'selection',             label: 'Waitlisted',          tone: 'amber',  applicant: 'On the waiting list' },
    rejected:            { stage: 'selection',             label: 'Rejected',            tone: 'red',    closed: true, reopenable: true, applicant: 'Not selected' },
    offer_issued:        { stage: 'offer',                 label: 'Offer Issued',        tone: 'teal',   system: true,  applicant: 'Admission offered' },
    accepted:            { stage: 'offer',                 label: 'Accepted',            tone: 'green',  system: true,  applicant: 'Offer accepted' },
    declined:            { stage: 'offer',                 label: 'Declined',            tone: 'gray',   system: true, closed: true, applicant: 'Offer declined' },
    offer_expired:       { stage: 'offer',                 label: 'Offer Expired',       tone: 'gray',   system: true, reopenable: true, applicant: 'Offer expired' },
    payment_pending:     { stage: 'fee_payment',           label: 'Payment Pending',     tone: 'amber',  system: true,  applicant: 'Admission fee due' },
    confirmed:           { stage: 'confirmation',          label: 'Confirmed',           tone: 'green',  system: true,  applicant: 'Admission confirmed' },
    enrolled:            { stage: 'activation',            label: 'Enrolled',            tone: 'green',  system: true, closed: true, applicant: 'Enrolled — welcome to the school' },
    withdrawn:           { stage: null,                    label: 'Withdrawn',           tone: 'gray',   closed: true, applicant: 'Withdrawn' },
    cancelled:           { stage: null,                    label: 'Cancelled',           tone: 'gray',   closed: true, reopenable: true, applicant: 'Cancelled by the school' },
};
const STATUS_KEYS = Object.keys(STATUSES);

/** Checks a stage can require before an application enters it. */
const CHECKS = {
    documents_uploaded:   'Every required document is uploaded',
    documents_verified:   'Every required document is verified',
    application_fee_paid: 'Application fee paid or waived',
    exam_completed:       'Every scheduled exam is completed',
    results_approved:     'Every exam result is approved',
    offer_accepted:       'The offer is accepted',
    admission_fee_paid:   'Admission fee paid or waived',
};
const CHECK_KEYS = Object.keys(CHECKS);

/** The same checks, said as what is wrong when one fails (a list of blockers). */
const CHECK_PROBLEMS = {
    documents_uploaded:   'A required document has not been uploaded',
    documents_verified:   'A required document is not verified',
    application_fee_paid: 'The application fee is not paid or waived',
    exam_completed:       'A scheduled exam has not been taken yet',
    results_approved:     'An exam result has not been approved yet',
    offer_accepted:       'The offer has not been accepted',
    admission_fee_paid:   'The admission fee is not paid or waived',
};

// Email sent when an application ARRIVES at a status by a manual move.
// Actions that set their own status send their own (submission, offers, lists…).
const STATUS_EMAIL = {
    incomplete:          'application_incomplete',
    documents_rejected:  'document_rejected',
    verified:            'documents_verified',
    interview_scheduled: 'interview_scheduled',
    waitlisted:          'waiting_list',
    rejected:            'application_rejected',
    ineligible:          'application_rejected',
    cancelled:           'admission_cancelled',
    withdrawn:           'admission_cancelled',
    selected:            'status_update',
    eligible:            'status_update',
    evaluated:           'status_update',
    under_review:        'status_update',
    documents_pending:   'status_update',
};

// ── Configuration ────────────────────────────────────────────────────────────

/** The stage list a school starts with. */
function defaultStages() {
    return STAGES.map((s, i) => ({
        key: s.key,
        enabled: s.optional ? !!s.defaultOn : true,
        label: s.label,
        order: i,
        assignees: [],
        deadlineDays: null,
        reminderDays: null,
        // No offer on a result nobody has approved yet (with no exam, nothing to wait for).
        requiredChecks: s.key === 'offer' ? ['results_approved'] : s.key === 'confirmation' ? ['admission_fee_paid'] : [],
        requiresApproval: ['selection', 'confirmation'].includes(s.key),
    }));
}

/**
 * Bring a stored stage list to the full, valid shape: every stage present
 * exactly once, fixed stages always on, the movable block reordered only
 * among itself, numbers in range, only known checks.
 */
function normalizeStages(input) {
    const given = new Map((Array.isArray(input) ? input : []).filter((s) => s && STAGE_BY_KEY[s.key]).map((s) => [s.key, s]));
    const defaults = defaultStages();
    const movableOrder = MOVABLE
        .map((key) => ({ key, order: Number.isFinite(Number(given.get(key)?.order)) ? Number(given.get(key).order) : STAGE_KEYS.indexOf(key) }))
        .sort((a, b) => a.order - b.order)
        .map((x) => x.key);
    // The fixed skeleton, with the movable block in the school's order.
    const sequence = [];
    let placed = false;
    for (const key of STAGE_KEYS) {
        if (MOVABLE.includes(key)) {
            if (!placed) { sequence.push(...movableOrder); placed = true; }
            continue;
        }
        sequence.push(key);
    }
    return sequence.map((key, i) => {
        const base = defaults.find((d) => d.key === key);
        const g = given.get(key) || {};
        const meta = STAGE_BY_KEY[key];
        const label = typeof g.label === 'string' && g.label.trim() ? g.label.trim().slice(0, 60) : base.label;
        return {
            key,
            enabled: meta.optional ? (g.enabled === undefined ? base.enabled : !!g.enabled) : true,
            label,
            order: i,
            assignees: [...new Set((Array.isArray(g.assignees) ? g.assignees : base.assignees).map(String))].slice(0, 50),
            deadlineDays: Number.isFinite(Number(g.deadlineDays)) && Number(g.deadlineDays) > 0 ? Math.min(365, Math.round(Number(g.deadlineDays))) : null,
            reminderDays: Number.isFinite(Number(g.reminderDays)) && Number(g.reminderDays) > 0 ? Math.min(60, Math.round(Number(g.reminderDays))) : null,
            requiredChecks: [...new Set((Array.isArray(g.requiredChecks) ? g.requiredChecks : base.requiredChecks).filter((c) => CHECK_KEYS.includes(c)))],
            requiresApproval: g.requiresApproval === undefined ? base.requiresApproval : !!g.requiresApproval,
        };
    });
}

/** The engine's view of a school's configuration. */
function compile(workflowSettings) {
    const stages = normalizeStages(workflowSettings?.stages);
    const rank = new Map(stages.map((s, i) => [s.key, i]));
    const byKey = new Map(stages.map((s) => [s.key, s]));
    return {
        stages,
        enabled: (key) => key == null || !!byKey.get(key)?.enabled,
        rank: (key) => (key == null ? -1 : rank.get(key)),
        stage: (key) => byKey.get(key) || null,
        labelOf: (statusKey) => STATUSES[statusKey]?.label || statusKey,
    };
}

const isClosed = (status) => !!STATUSES[status]?.closed;
const stageOf = (status) => STATUSES[status]?.stage || null;

// ── Deciding a move ──────────────────────────────────────────────────────────

/**
 * May `app` move to `to`?
 *
 * ctx: { flow (compile()), isAdmin, actorId, facts (factsFor), system, reopen }
 * Returns { ok: true, needsApproval } or { ok: false, reason }.
 */
function canMove(app, to, ctx) {
    const { flow, isAdmin = false, actorId = null, facts = null, system = false, reopen = false } = ctx;
    const from = app.status;
    const toMeta = STATUSES[to];
    const fromMeta = STATUSES[from];
    if (!toMeta) return { ok: false, reason: `"${to}" is not a status` };
    if (from === to) return { ok: false, reason: `The application is already ${toMeta.label.toLowerCase()}` };
    if (toMeta.system && !system) return { ok: false, reason: `${toMeta.label} is set by its own action, not chosen from the list` };

    if (fromMeta?.closed) {
        const reopening = reopen && fromMeta.reopenable && to === 'under_review';
        if (!reopening) return { ok: false, reason: `The application is ${fromMeta.label.toLowerCase()} — reopen it first` };
        if (!isAdmin) return { ok: false, reason: 'Only an admission administrator can reopen an application' };
        return { ok: true, needsApproval: false };
    }
    if (from === 'draft' && !system && !['cancelled', 'withdrawn'].includes(to)) {
        return { ok: false, reason: 'A draft moves on when the applicant submits it' };
    }
    if (to === 'withdrawn' || to === 'cancelled') {
        if (to === 'cancelled' && !isAdmin && !system) return { ok: false, reason: 'Only an admission administrator can cancel an application' };
        return { ok: true, needsApproval: false };
    }
    if (from === 'enrolled') return { ok: false, reason: 'The student is enrolled — changes go through the student record now' };

    const toStage = toMeta.stage;
    if (!flow.enabled(toStage)) return { ok: false, reason: `${flow.stage(toStage)?.label || toStage} is switched off in this school's workflow` };

    const fromRank = flow.rank(fromMeta?.stage);
    const toRank = flow.rank(toStage);
    // An offer that lapsed hands the seat back; the applicant can return to
    // the waiting list or be turned down — the one way back out of Offer.
    const afterLapse = from === 'offer_expired' && ['waitlisted', 'rejected'].includes(to);
    // And the lapse itself: an offer withdrawn, or accepted but its fee not
    // paid in time, falls back from Fee Payment to Offer Expired — only ever
    // as the system's own act (closing the offer), never chosen by a person.
    const lapsing = system && to === 'offer_expired' && ['offer_issued', 'accepted', 'payment_pending'].includes(from);
    const backwards = toRank < fromRank && !afterLapse && !lapsing;
    if (backwards && !(toMeta.sendBack && fromRank <= flow.rank('selection'))) {
        return { ok: false, reason: `An application at ${fromMeta?.label || from} cannot go back to ${toMeta.label}` };
    }

    // Guards that come with the status itself.
    if (facts) {
        if (to === 'verified' && facts.docs.unverified > 0) {
            return { ok: false, reason: `${facts.docs.unverified} required document(s) are not verified yet` };
        }
        if (to === 'documents_rejected' && facts.docs.rejected === 0) {
            return { ok: false, reason: 'No document has been rejected — reject the document first' };
        }
        if (to === 'exam_completed' && facts.exams.scheduled > 0 && facts.exams.pending === facts.exams.scheduled) {
            return { ok: false, reason: 'No scheduled exam has been sat or marked yet' };
        }
        if (to === 'evaluated' && facts.results.unapproved > 0) {
            return { ok: false, reason: `${facts.results.unapproved} exam result(s) still await approval` };
        }
    }

    // Entering a later stage: the checks the school asked for.
    const stageCfg = flow.stage(toStage);
    if (!backwards && stageOf(from) !== toStage && stageCfg?.requiredChecks?.length && facts) {
        const failed = stageCfg.requiredChecks.filter((c) => !checkPasses(c, facts));
        if (failed.length) return { ok: false, reason: `Before ${stageCfg.label}: ${failed.map((c) => CHECKS[c].toLowerCase()).join('; ')}` };
    }
    // Who handles the stage.
    if (stageCfg?.assignees?.length && !isAdmin && !system && actorId && !stageCfg.assignees.includes(String(actorId))) {
        return { ok: false, reason: `${stageCfg.label} is handled by the staff assigned to it` };
    }
    const needsApproval = !!(stageCfg?.requiresApproval && !isAdmin && !system && stageOf(from) !== toStage);
    return { ok: true, needsApproval };
}

function checkPasses(check, facts) {
    switch (check) {
        case 'documents_uploaded':   return facts.docs.missing === 0;
        case 'documents_verified':   return facts.docs.unverified === 0;
        case 'application_fee_paid': return ['paid', 'waived', 'not_required'].includes(facts.app.applicationFeeStatus);
        case 'exam_completed':       return facts.exams.pending === 0;
        case 'results_approved':     return facts.results.unapproved === 0;
        case 'offer_accepted':       return ['accepted', 'confirmed'].includes(facts.app.offerStatus);
        case 'admission_fee_paid':   return ['paid', 'waived', 'not_required'].includes(facts.app.admissionFeeStatus);
        default: return true;
    }
}

/** Statuses a person may pick for this application right now, with why not for the rest. */
function options(app, ctx) {
    return STATUS_KEYS
        .filter((k) => !STATUSES[k].system)
        .map((k) => {
            const r = canMove(app, k, ctx);
            return { status: k, label: STATUSES[k].label, ok: r.ok, needsApproval: !!r.needsApproval, reason: r.ok ? null : r.reason };
        })
        .filter((o) => o.ok || ctx.withReasons);
}

module.exports = {
    STAGES, STAGE_KEYS, STAGE_BY_KEY, MOVABLE, STATUSES, STATUS_KEYS, CHECKS, CHECK_KEYS, CHECK_PROBLEMS, STATUS_EMAIL,
    defaultStages, normalizeStages, compile, canMove, checkPasses, options, isClosed, stageOf,
};
