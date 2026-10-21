'use strict';
/**
 * The life of an application, from the applicant's first draft to the
 * office's decisions.
 *
 * Every status change goes through move(): it asks the workflow whether the
 * move is allowed (services/admission/workflow.js), writes it with a
 * compare-and-set on the status the caller saw — two people acting on the
 * same application cannot both win — records it in the history, and tells
 * the applicant once it is committed.
 *
 * Form versions: a draft is answered on the version that was current when it
 * was started. When the school publishes a newer version and its policy is
 * "migrate" (the default), the draft moves to it the next time it is opened:
 * answers the new version still asks for are carried over, the rest are kept
 * aside (retiredData) — never lost — and the applicant sees which questions
 * are new. A submitted application keeps its version for good, so a question
 * made mandatory later never invalidates it; if the office needs the answer
 * it sends the application back as incomplete.
 */
const pool = require('../../db/pool');
const { patch } = require('../../db/patch');
const { withTransaction, buildInsert } = require('../dbTx');
const AdmissionApplication = require('../../models/AdmissionApplication');
const AdmissionRound = require('../../models/AdmissionRound');
const AdmissionForm = require('../../models/AdmissionForm');
const AdmissionFormVersion = require('../../models/AdmissionFormVersion');
const AcademicYear = require('../../models/AcademicYear');
const Class = require('../../models/Class');
const School = require('../../models/School');
const User = require('../../models/User');
const workflow = require('./workflow');
const formEngine = require('./formEngine');
const documents = require('./documents');
const settingsSvc = require('./settings');
const counters = require('./counters');
const events = require('./events');
const notify = require('./notify');
const { refuse, isId, str } = require('./util');

const T = `"${AdmissionApplication.tableName}"`;
const EDITABLE = ['draft', 'incomplete'];

// ── Forms ────────────────────────────────────────────────────────────────────

/** The published form version an application in this round/class is answered on. */
async function formFor(round, classId) {
    const cls = (round.classes || []).find((c) => String(c.class) === String(classId));
    const formId = cls?.form || round.form;
    if (!formId) return null;
    const form = await AdmissionForm.findOne({ _id: formId, school: round.school, isActive: true }).lean();
    if (!form?.currentVersion) return null;
    const version = await AdmissionFormVersion.findById(form.currentVersion).lean();
    return version ? { form, version } : null;
}

async function schemaOf(app) {
    if (!app.formVersion) return { sections: [] };
    const v = await AdmissionFormVersion.findById(app.formVersion).select('schema').lean();
    return v?.schema || { sections: [] };
}

// ── Rounds ───────────────────────────────────────────────────────────────────

/** Is the round taking applications for this class right now? Returns the reason it is not, or null. */
function roundClosedReason(round, classId, now = new Date()) {
    if (!round || round.status !== 'open') return 'Applications for this round are closed';
    if (round.opensAt && new Date(round.opensAt) > now) return `Applications open on ${new Date(round.opensAt).toDateString()}`;
    if (round.closesAt && new Date(round.closesAt) < now) return 'The last date for applications has passed';
    const cls = (round.classes || []).find((c) => String(c.class) === String(classId));
    if (!cls) return 'This class is not part of the round';
    if (cls.isOpen === false) return 'Applications for this class are closed';
    return null;
}

const feeOf = (round, classId, kind) => {
    const cls = (round.classes || []).find((c) => String(c.class) === String(classId));
    const own = kind === 'application' ? cls?.applicationFee : cls?.admissionFee;
    const base = kind === 'application' ? round.applicationFee : round.admissionFee;
    return Math.max(0, Number(own ?? base) || 0);
};

// ── The applicant's side ─────────────────────────────────────────────────────

async function createDraft(req, portal, { roundId, classId, source = '' }) {
    const schoolId = portal.school._id;
    if (!isId(String(roundId || '')) || !isId(String(classId || ''))) refuse('Choose a round and a class');
    const round = await AdmissionRound.findOne({ _id: roundId, school: schoolId }).lean();
    if (!round) refuse('Admission round not found', 404);
    const closed = roundClosedReason(round, classId);
    if (closed) refuse(closed, 409);
    const found = await formFor(round, classId);
    if (!found) refuse('The application form for this class is not published yet — please check back soon', 409);

    const settings = portal.settings;
    const limit = Number(round.maxApplicationsPerApplicant) || settings.applications.maxPerApplicant;
    const { rows: mine } = await pool.query(
        `SELECT "status", "class" FROM ${T} WHERE "school" = $1 AND "applicant" = $2 AND "round" = $3`,
        [String(schoolId), String(req.userId), String(roundId)]);
    const live = mine.filter((a) => !['withdrawn', 'cancelled'].includes(a.status));
    if (live.length >= limit) refuse(`You can make at most ${limit} application${limit === 1 ? '' : 's'} in this round`, 409, { code: 'APPLICATION_LIMIT' });
    if (!settings.applications.allowReapplyAfterRejection
        && mine.some((a) => String(a.class) === String(classId) && ['rejected', 'ineligible'].includes(a.status))) {
        refuse('An application for this class in this round was not successful, and the school does not accept a second one', 409, { code: 'NO_REAPPLY' });
    }

    const schema = found.version.schema;
    const defaults = {};
    for (const f of formEngine.allFields(schema)) if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
    const appFee = feeOf(round, classId, 'application');
    // Where the family came from: the link they applied from, else the one they registered from.
    let from = str(source, 60);
    if (!from) from = (await pool.query(`SELECT "source" FROM "admissionapplicants" WHERE "user" = $1 LIMIT 1`, [String(req.userId)])).rows[0]?.source || '';
    const { sql, params } = buildInsert(AdmissionApplication, {
        school: schoolId, round: round._id, academicYear: round.academicYear, class: classId, applicant: req.userId,
        form: found.form._id, formVersion: found.version._id, formVersionNo: found.version.version,
        status: 'draft', stage: 'draft', statusChangedAt: new Date(), lastActivityAt: new Date(),
        data: defaults, applicationFeeAmount: appFee, applicationFeeStatus: appFee > 0 ? 'due' : 'not_required',
        source: str(from, 60), createdBy: req.userId,
    });
    const { rows: [app] } = await pool.query(sql, params);
    events.recordQuietly(schoolId, { application: app._id, by: req, type: 'status', action: 'created', to: 'draft', message: 'Application started', visibility: 'applicant' });
    return app;
}

/**
 * Open a draft for editing: on the school's "migrate" policy, a draft on an
 * older form version moves to the current one. Returns { app, schema, migration }.
 */
async function openForEdit(req, app) {
    let schema = await schemaOf(app);
    if (!EDITABLE.includes(app.status) || app.status !== 'draft' || !app.form) return { app, schema, migration: null };
    const settings = await settingsSvc.getSettings(app.school);
    if (settings.applications.draftMigration !== 'migrate') return { app, schema, migration: null };
    const form = await AdmissionForm.findById(app.form).select('currentVersion').lean();
    if (!form?.currentVersion || String(form.currentVersion) === String(app.formVersion)) return { app, schema, migration: null };
    const next = await AdmissionFormVersion.findById(form.currentVersion).lean();
    if (!next) return { app, schema, migration: null };

    const moved = formEngine.migrateAnswers(schema, next.schema, app.data || {});
    const oldKeys = new Set(formEngine.allFields(schema).map((f) => f.key));
    const added = formEngine.allFields(next.schema).filter((f) => !oldKeys.has(f.key) && f.type !== 'info').map((f) => f.label || f.key);
    const updated = await patch(AdmissionApplication, app._id, {
        formVersion: next._id, formVersionNo: next.version, data: moved.data,
        retiredData: { ...(app.retiredData || {}), ...moved.retired },
    }, { where: { status: 'draft', formVersion: app.formVersion } });
    if (!updated) return { app, schema, migration: null };
    events.recordQuietly(app.school, {
        application: app._id, by: req, type: 'form', action: 'migrated', from: String(app.formVersionNo || ''), to: String(next.version),
        message: `Draft moved to version ${next.version} of the form`, meta: { retired: Object.keys(moved.retired), added },
    });
    return { app: updated, schema: next.schema, migration: { from: app.formVersionNo, to: next.version, added, retired: Object.keys(moved.retired).length } };
}

/** Save what the applicant has written so far — nothing is required yet. */
async function saveDraft(req, app, input) {
    if (!EDITABLE.includes(app.status)) refuse('This application has been submitted and cannot be edited', 409, { code: 'NOT_EDITABLE' });
    const schema = await schemaOf(app);
    const incoming = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    // Merge: a key sent empty clears that answer; keys not sent stay.
    const merged = { ...(app.data || {}) };
    for (const [k, v] of Object.entries(incoming)) {
        if (v === null || v === '' || (Array.isArray(v) && !v.length)) delete merged[k];
        else merged[k] = v;
    }
    const r = formEngine.validateAnswers(schema, merged, { classId: app.class, roundId: app.round, partial: true });
    // A draft keeps every answer that is valid; an invalid one is reported, and
    // its previous good value (if any) stays.
    const data = { ...r.data };
    for (const key of Object.keys(r.errors)) if (app.data?.[key] !== undefined) data[key] = app.data[key];
    const summary = formEngine.summaryOf(schema, data);
    const updated = await patch(AdmissionApplication, app._id, { data, ...summary, lastActivityAt: new Date() }, { where: { status: app.status } });
    if (!updated) refuse('This application changed while you were editing — refresh to continue', 409);
    await documents.refresh(updated, schema);
    return { app: updated, errors: r.errors };
}

/** The application's duplicates: same child (name + date of birth), or same family contact and date of birth, this year. */
async function duplicates(app) {
    if (!app.studentName && !app.guardianPhone) return [];
    const { rows } = await pool.query(
        `SELECT a."_id", a."applicationNumber", a."studentName", a."status", a."class", a."submittedAt"
           FROM ${T} a
          WHERE a."school" = $1 AND a."academicYear" = $2 AND a."_id" <> $3 AND a."status" NOT IN ('draft', 'withdrawn', 'cancelled')
            AND (
              (a."studentDob" = $4 AND lower(btrim(a."studentName")) = lower(btrim($5)) AND $5 <> '')
              OR (a."studentDob" = $4 AND a."guardianPhone" = $6 AND $6 <> '')
              OR (a."guardianEmail" = $7 AND $7 <> '' AND lower(btrim(a."studentName")) = lower(btrim($5)) AND $5 <> '')
            )
          ORDER BY a."submittedAt" DESC NULLS LAST LIMIT 10`,
        [String(app.school), String(app.academicYear), String(app._id), app.studentDob, app.studentName || '', app.guardianPhone || '', app.guardianEmail || '']);
    return rows;
}

/** Submit (or resubmit) — every rule checked on the server. */
async function submit(req, app) {
    if (!EDITABLE.includes(app.status)) refuse('This application has already been submitted', 409, { code: 'ALREADY_SUBMITTED' });
    const settings = await settingsSvc.getSettings(app.school);
    const round = await AdmissionRound.findById(app.round).lean();
    if (app.status === 'draft') {
        const closed = roundClosedReason(round, app.class);
        if (closed) refuse(closed, 409, { code: 'ROUND_CLOSED' });
    }
    const schema = await schemaOf(app);
    const types = await documents.typesOf(app.school);
    const docs = await documents.currentDocs(app._id);
    const have = Object.fromEntries(docs.map((d) => [d.docKey, true]));
    const requireDocs = settings.applications.requireDocumentsAtSubmit;
    const r = formEngine.validateAnswers(schema, app.data || {}, {
        classId: app.class, roundId: app.round, partial: false,
        docs: requireDocs ? have : new Proxy({}, { get: () => true }),
    });
    if (requireDocs) {
        for (const req2 of documents.requirements({ ...app, data: r.data }, schema, types)) {
            if (req2.required && !have[req2.type.key] && !req2.fromForm) {
                r.errors[`doc:${req2.type.key}`] = `${req2.type.name} — upload the document`;
            }
        }
    }
    const errorKeys = Object.keys(r.errors);
    if (errorKeys.length) refuse(r.errors[errorKeys[0]], 400, { code: 'FORM_INVALID', errors: errorKeys.map((k) => ({ path: k, message: r.errors[k] })) });
    if (settings.applications.applicationFeeTiming === 'before_submit' && app.applicationFeeStatus === 'due' && app.applicationFeeAmount > 0) {
        refuse('Please pay the application fee before submitting', 402, { code: 'FEE_DUE' });
    }

    const summary = formEngine.summaryOf(schema, r.data);
    const first = !app.applicationNumber;
    const school = await School.findById(app.school).select('name code').lean();
    const year = await AcademicYear.findById(app.academicYear).select('startDate yearName').lean();
    const cls = await Class.findById(app.class).select('className classNumber').lean();
    const flow = workflow.compile(settings.workflow);
    const decision = workflow.canMove(app, 'submitted', { flow, system: true });
    if (!decision.ok) refuse(decision.reason, 409);

    const updated = await withTransaction(async (q) => {
        const number = first
            ? await counters.nextNumber(app.school, 'application', settings.numbering.application, {
                school, classDoc: cls, year: year?.startDate ? new Date(year.startDate).getFullYear() : null,
            }, q)
            : app.applicationNumber;
        const row = await patch(AdmissionApplication, app._id, {
            data: r.data, ...summary, applicationNumber: number, status: 'submitted', stage: 'submitted',
            statusChangedAt: new Date(), lastActivityAt: new Date(),
            submittedAt: app.submittedAt || new Date(), lastSubmittedAt: new Date(),
        }, { where: { status: app.status }, q });
        if (!row) refuse('This application changed while you were submitting — refresh and try again', 409);
        await events.record(app.school, {
            application: app._id, by: req, type: 'status', action: first ? 'submitted' : 'resubmitted', from: app.status, to: 'submitted',
            message: first ? `Application submitted — number ${number}` : 'Application updated and submitted again', visibility: 'applicant',
        }, q);
        return row;
    });

    // Duplicates are flagged for the office, never decided automatically.
    if (settings.applications.duplicateCheck) {
        const dups = await duplicates(updated).catch(() => []);
        if (dups.length) {
            await patch(AdmissionApplication, updated._id, { flags: { ...(updated.flags || {}), duplicateOf: dups.map((d) => String(d._id)) } }, { touch: false });
            events.recordQuietly(app.school, { application: app._id, type: 'system', action: 'duplicate_warning', message: `Looks like ${dups.length} other application(s): ${dups.map((d) => d.applicationNumber).join(', ')}` });
        }
    }
    await documents.refresh(updated, schema);
    // A quota the answers claim (a staff ward, a sibling) — for the office to verify.
    await require('./quotas').claimOnSubmit(updated).catch((e) => console.error('[admission] quota claim:', e.message));
    // Moved here from another branch of the group: submitting it finishes the move (services/admission/groups.js).
    if (updated.transferFrom) await require('./groups').completeTransfer(req, updated).catch((e) => console.error('[admission] transfer:', e.message));
    notify.toApplicant(updated, 'application_submitted');
    return updated;
}

/** Withdraw an application (the applicant). Gives back any seat it held. */
async function withdraw(req, app, reason = '') {
    const settings = await settingsSvc.getSettings(app.school);
    if (!settings.applications.allowWithdraw) refuse('Applications cannot be withdrawn online — please contact the admission office', 403);
    if (workflow.isClosed(app.status)) refuse('This application is already closed', 409);
    if (app.status === 'enrolled') refuse('The student is enrolled — please contact the school office', 409);
    return move(req, app, 'withdrawn', { reason: str(reason, 300) || 'Withdrawn by the applicant', system: true, actorIsApplicant: true });
}

/** Throw away a draft that was never submitted, with its files. */
async function discardDraft(req, app) {
    if (app.status !== 'draft' || app.submittedAt) refuse('Only a draft that was never submitted can be deleted', 409);
    const docs = await documents.currentDocs(app._id);
    const { rows } = await pool.query(`SELECT "file" FROM "admissiondocuments" WHERE "application" = $1`, [String(app._id)]);
    const del = await pool.query(`DELETE FROM ${T} WHERE "_id" = $1 AND "status" = 'draft' AND "submittedAt" IS NULL AND "applicant" = $2`, [String(app._id), String(req.userId)]);
    if (!del.rowCount) refuse('This draft could not be deleted', 409);
    for (const r of rows) require('./fileStore').remove(r.file);
    return { deleted: true, files: docs.length };
}

// ── Facts the workflow judges by ─────────────────────────────────────────────

async function factsFor(app, schema = null) {
    const docs = await documents.refresh(app, schema || await schemaOf(app));
    const { rows: [e] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE c."status" <> 'withdrawn')::int AS scheduled,
                COUNT(*) FILTER (WHERE c."status" = 'scheduled')::int AS pending,
                COUNT(*) FILTER (WHERE c."status" <> 'withdrawn' AND (r."_id" IS NULL OR r."status" NOT IN ('approved', 'published')))::int AS unapproved
           FROM "admissioncandidates" c
           LEFT JOIN "admissionresults" r ON r."exam" = c."exam" AND r."application" = c."application"
          WHERE c."application" = $1`, [String(app._id)]);
    return { app, docs, exams: { scheduled: e.scheduled, pending: e.pending }, results: { unapproved: e.unapproved } };
}

// ── Moving an application ────────────────────────────────────────────────────

const REASON_STATUSES = ['rejected', 'ineligible', 'cancelled', 'withdrawn', 'incomplete', 'documents_pending'];

/**
 * Move `app` to `to`. Staff moves are judged by the workflow; actions that
 * own a status pass `system: true`. Returns the updated application, or
 * { pending: true } when the move now waits for an administrator.
 *
 * opts: { remarks (shown to the family), note (internal), reason, reopen,
 *         system, actorIsApplicant, q (a transaction), after [] (post-commit),
 *         set (extra columns), quiet (no email) }
 */
async function move(req, app, to, opts = {}) {
    const settings = await settingsSvc.getSettings(app.school);
    const flow = workflow.compile(settings.workflow);
    const access = require('./access');
    const isAdmin = opts.system ? true : await access.isAdmin(req);
    const facts = opts.system ? null : await factsFor(app);
    const decision = workflow.canMove(app, to, { flow, isAdmin, actorId: req?.userId, facts, system: !!opts.system, reopen: !!opts.reopen });
    if (!decision.ok) refuse(decision.reason, 409, { code: 'TRANSITION_REFUSED' });
    const remarks = str(opts.remarks, 1000);
    const reason = str(opts.reason, 500);
    if (REASON_STATUSES.includes(to) && !opts.system && !remarks && !reason) {
        refuse('Say why — the family is told', 400, { field: 'remarks' });
    }

    if (decision.needsApproval) {
        const pending = { to, by: String(req.userId), byName: req.user?.name || '', at: new Date(), note: str(opts.note, 500), remarks, reason };
        const row = await patch(AdmissionApplication, app._id, { pendingTransition: pending }, { where: { status: app.status } });
        if (!row) refuse('The application changed — refresh and try again', 409);
        events.recordQuietly(app.school, { application: app._id, by: req, type: 'approval', action: 'requested', from: app.status, to, message: `Asked to move to ${workflow.STATUSES[to].label}${pending.note ? ` — ${pending.note}` : ''}` });
        return { pending: true, application: row };
    }

    const meta = workflow.STATUSES[to];
    const set = {
        status: to, stage: meta.stage || app.stage, statusChangedAt: new Date(), lastActivityAt: new Date(), pendingTransition: null,
        ...(meta.closed ? { closedReason: reason || remarks } : {}),
        ...(opts.reopen ? { closedReason: '' } : {}),
        ...(['selected', 'rejected', 'ineligible', 'waitlisted'].includes(to) ? { decidedAt: new Date() } : {}),
        ...(opts.set || {}),
    };
    const run = async (q) => {
        const row = await patch(AdmissionApplication, app._id, set, { where: { status: app.status }, q });
        if (!row) refuse('The application changed while you were working — refresh and try again', 409, { code: 'STALE' });
        const fromLabel = workflow.STATUSES[app.status]?.label || app.status;
        await events.record(app.school, {
            application: app._id, by: opts.actorIsApplicant ? req : (opts.system && !req ? null : req), type: 'status',
            action: opts.reopen ? 'reopened' : 'moved', from: app.status, to,
            message: `${meta.applicant || meta.label}${remarks ? ` — ${remarks}` : ''}`,
            visibility: 'applicant', meta: { fromLabel, note: str(opts.note, 500) || undefined, reason: reason || undefined },
        }, q);
        if (opts.note) {
            await events.record(app.school, { application: app._id, by: req, type: 'note', action: 'note', message: str(opts.note, 2000) }, q);
        }
        return row;
    };
    const updated = opts.q ? await run(opts.q) : await withTransaction(run);

    const after = async () => {
        // Leaving a seat: a withdrawn or cancelled application gives back what it held.
        if (['withdrawn', 'cancelled'].includes(to)) {
            await require('./selection').releaseFor(updated, { req, reason: reason || remarks || meta.label }).catch((e) => console.error('[admission] release:', e.message));
        }
        const event = workflow.STATUS_EMAIL[to];
        if (event && !opts.quiet) notify.toApplicant(updated, event, { remarks: remarks || reason, reason: reason || remarks, status: meta.label });
    };
    if (opts.after) opts.after.push(after); else await after();
    return updated;
}

/** Approve or turn down a move that was waiting for an administrator. */
async function decidePending(req, app, approve, note = '') {
    const p = app.pendingTransition;
    if (!p?.to) refuse('Nothing is waiting for approval on this application', 409);
    if (!approve) {
        const row = await patch(AdmissionApplication, app._id, { pendingTransition: null }, { where: { status: app.status } });
        events.recordQuietly(app.school, { application: app._id, by: req, type: 'approval', action: 'declined', to: p.to, message: `Move to ${workflow.STATUSES[p.to]?.label || p.to} not approved${note ? ` — ${note}` : ''}` });
        return row;
    }
    if (String(p.by) === String(req.userId) && req.userRole !== 'school_admin') refuse('Someone other than the person who asked has to approve it', 403);
    const row = await move(req, { ...app, pendingTransition: null }, p.to, { remarks: p.remarks, reason: p.reason, note: [p.note, note].filter(Boolean).join(' · ') });
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'approval', action: 'approved', to: p.to, message: `Approved the move to ${workflow.STATUSES[p.to]?.label || p.to} asked for by ${p.byName || 'a colleague'}` });
    return row;
}

async function assign(req, app, userId) {
    let name = '';
    if (userId) {
        if (!isId(String(userId))) refuse('Choose a member of staff');
        const u = await User.findOne({ _id: userId, school: req.schoolId, role: { $in: ['school_admin', 'teacher'] }, isActive: true }).select('name').lean();
        if (!u) refuse('That member of staff was not found', 404);
        name = u.name;
    }
    const row = await patch(AdmissionApplication, app._id, { assignedTo: userId || null });
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'assignment', action: userId ? 'assigned' : 'unassigned', message: userId ? `Assigned to ${name}` : 'Unassigned' });
    return row;
}

async function addNote(req, app, text) {
    const t = str(text, 2000);
    if (!t) refuse('Write the note first', 400, { field: 'text' });
    const { textProblem } = require('../../utils/textRules');
    const bad = textProblem(t, 'The note');
    if (bad) refuse(bad, 400, { field: 'text' });
    await events.record(app.school, { application: app._id, by: req, type: 'note', action: 'note', message: t });
    await patch(AdmissionApplication, app._id, { lastActivityAt: new Date() }, { touch: false });
    return { ok: true };
}

/**
 * The office corrects answers on a submitted application — with a reason,
 * and the before and after kept in the history.
 */
async function correctAnswers(req, app, input, reason) {
    const why = str(reason, 300);
    if (!why) refuse('Say why the answers are being changed', 400, { field: 'reason' });
    if (['draft', 'enrolled'].includes(app.status) || workflow.isClosed(app.status)) refuse('This application cannot be corrected now', 409);
    if (app.erasedAt) refuse('This application\'s personal data has been erased', 409);
    const schema = await schemaOf(app);
    // An Aadhaar number comes to the office masked; sent back unchanged, it is not an answer.
    const ids = new Set(formEngine.allFields(schema).filter(formEngine.isAadhaarField).map((f) => f.key));
    input = Object.fromEntries(Object.entries(input || {}).filter(([k, v]) => !(ids.has(k) && formEngine.MASKED.test(String(v ?? '')))));
    const merged = { ...(app.data || {}), ...(input || {}) };
    const r = formEngine.validateAnswers(schema, merged, { classId: app.class, roundId: app.round, partial: true });
    if (Object.keys(r.errors).length) refuse(Object.values(r.errors)[0], 400, { errors: Object.entries(r.errors).map(([path, message]) => ({ path, message })) });
    const changed = Object.keys(input || {}).filter((k) => JSON.stringify(app.data?.[k]) !== JSON.stringify(r.data[k]));
    if (!changed.length) refuse('Nothing was changed');
    const row = await patch(AdmissionApplication, app._id, { data: r.data, ...formEngine.summaryOf(schema, r.data) }, { where: { status: app.status } });
    if (!row) refuse('The application changed — refresh and try again', 409);
    const sensitive = new Set(formEngine.allFields(schema).filter((f) => f.sensitive).map((f) => f.key));
    await events.record(app.school, {
        application: app._id, by: req, type: 'form', action: 'corrected', message: `Answers corrected (${changed.join(', ')}) — ${why}`,
        meta: { changes: changed.map((k) => ({ key: k, before: sensitive.has(k) ? '(hidden)' : app.data?.[k] ?? null, after: sensitive.has(k) ? '(hidden)' : r.data[k] ?? null })) },
    });
    return row;
}

module.exports = {
    EDITABLE, formFor, schemaOf, roundClosedReason, feeOf,
    createDraft, openForEdit, saveDraft, submit, withdraw, discardDraft, duplicates,
    factsFor, move, decidePending, assign, addNote, correctAnswers,
};
