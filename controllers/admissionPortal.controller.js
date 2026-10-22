'use strict';
/**
 * The signed-in applicant's API (role `guest`). Every handler reaches only the
 * caller's own applications at the school behind their session
 * (access.ownApplication: id + school + applicant in one query) — an id from
 * another family, or another school, is simply "not found".
 */
const pool = require('../db/pool');
const AdmissionRound = require('../models/AdmissionRound');
const AdmissionExam = require('../models/AdmissionExam');
const AdmissionAttempt = require('../models/AdmissionAttempt');
const AdmissionCandidate = require('../models/AdmissionCandidate');
const access = require('../services/admission/access');
const apps = require('../services/admission/applications');
const documents = require('../services/admission/documents');
const payments = require('../services/admission/payments');
const receipts = require('../services/admission/receipts');
const exams = require('../services/admission/exams');
const selection = require('../services/admission/selection');
const events = require('../services/admission/events');
const formEngine = require('../services/admission/formEngine');
const workflow = require('../services/admission/workflow');
const { signInNote } = require('../services/admission/conversion');
const pdf = require('../services/admission/pdf');
const { handler, refuse, isId } = require('../services/admission/util');

const TAG = 'admission portal';

/** The application as its family sees it — none of the office's own fields. */
function familyView(app) {
    const meta = workflow.STATUSES[app.status] || {};
    return {
        _id: app._id, applicationNumber: app.applicationNumber, status: app.status, statusLabel: meta.label || app.status,
        statusText: meta.applicant || meta.label || app.status, statusTone: meta.tone || 'gray', stage: app.stage,
        round: app.round, class: app.class, academicYear: app.academicYear, formVersionNo: app.formVersionNo,
        data: app.data || {}, studentName: app.studentName, submittedAt: app.submittedAt, createdAt: app.createdAt, updatedAt: app.updatedAt,
        applicationFeeAmount: app.applicationFeeAmount, applicationFeeStatus: app.applicationFeeStatus,
        admissionFeeAmount: app.admissionFeeAmount, admissionFeeStatus: app.admissionFeeStatus,
        docStatus: app.docStatus, offerStatus: app.offerStatus,
        selection: app.selection ? { listName: app.selection.listName, decision: app.selection.decision, rank: app.selection.rank, waitPosition: app.selection.waitPosition } : null,
        admissionNumber: app.admissionNumber || '', reason: workflow.isClosed(app.status) ? app.closedReason || '' : '',
        signInNote: app.status === 'enrolled' ? signInNote(app.conversion) : '',
        quota: app.quota ? { key: app.quota, status: app.quotaStatus, note: app.quotaStatus === 'rejected' ? app.quotaNote : '', externalRef: app.externalRef || '' } : null,
    };
}

const portalSummary = (portal) => ({
    slug: portal.slug, schoolName: portal.school.name, title: portal.settings.portal.title, theme: portal.settings.portal.theme,
    status: portal.settings.portal.status, help: portal.settings.portal.help, contact: portal.settings.portal.contact,
    // Whether families book campus visits here (the phone app shows the way in only then).
    visits: !!portal.settings.visits?.enabled,
    // The portal's own web address — what the phone app opens for an applicant.
    url: `${String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/${portal.slug}`,
});

exports.me = handler(async (req, res) => {
    const { rows: [profile] } = await pool.query(`SELECT "phone", "verifiedAt", "consentVersion", "lastLoginAt" FROM "admissionapplicants" WHERE "user" = $1`, [String(req.userId)]);
    const { rows: [counts] } = await pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE "status" = 'draft')::int AS drafts FROM "admissionapplications" WHERE "school" = $1 AND "applicant" = $2`,
        [String(req.schoolId), String(req.userId)]);
    res.json({ success: true, data: { user: { _id: req.user._id, name: req.user.name, email: req.user.email, phone: req.user.phone }, profile: profile || null, counts, portal: portalSummary(req.portal) } });
}, TAG);

/** The rounds and classes this applicant may apply to now. */
exports.rounds = handler(async (req, res) => {
    const rounds = await AdmissionRound.find({ school: req.schoolId, status: 'open' }).lean();
    const classIds = [...new Set(rounds.flatMap((r) => (r.classes || []).map((c) => String(c.class))))];
    const { rows: classes } = classIds.length ? await pool.query(`SELECT "_id", "className", "classNumber" FROM "classes" WHERE "_id" = ANY($1::uuid[])`, [classIds]) : { rows: [] };
    const byId = new Map(classes.map((c) => [String(c._id), c]));
    const out = [];
    for (const r of rounds) {
        const list = [];
        for (const c of r.classes || []) {
            const closed = apps.roundClosedReason(r, c.class);
            const form = await apps.formFor(r, c.class);
            list.push({
                _id: String(c.class), className: byId.get(String(c.class))?.className || 'Class', classNumber: byId.get(String(c.class))?.classNumber ?? null,
                applicationFee: apps.feeOf(r, c.class, 'application'), eligibility: c.eligibility || null,
                available: !closed && !!form, reason: closed || (!form ? 'The application form is not published yet' : null),
            });
        }
        list.sort((a, b) => (a.classNumber ?? 999) - (b.classNumber ?? 999));
        out.push({ _id: r._id, name: r.name, description: r.description, opensAt: r.opensAt, closesAt: r.closesAt, campus: r.campus, classes: list });
    }
    res.json({ success: true, data: out });
}, TAG);

exports.list = handler(async (req, res) => {
    const { rows } = await pool.query(
        `SELECT a.*, c."className", r."name" AS "roundName", y."yearName"
           FROM "admissionapplications" a
           LEFT JOIN "classes" c ON c."_id" = a."class" LEFT JOIN "admissionrounds" r ON r."_id" = a."round" LEFT JOIN "academicyears" y ON y."_id" = a."academicYear"
          WHERE a."school" = $1 AND a."applicant" = $2 ORDER BY a."createdAt" DESC`, [String(req.schoolId), String(req.userId)]);
    res.json({ success: true, data: rows.map((a) => ({ ...familyView(a), className: a.className, roundName: a.roundName, yearName: a.yearName })) });
}, TAG);

exports.create = handler(async (req, res) => {
    const app = await apps.createDraft(req, req.portal, { roundId: req.body?.round, classId: req.body?.class, source: req.body?.source });
    res.status(201).json({ success: true, data: familyView(app) });
}, TAG);

/** One application, everything the family's tracking page shows. */
exports.detail = handler(async (req, res) => {
    let app = await access.ownApplication(req, req.params.id);
    const opened = await apps.openForEdit(req, app);
    app = opened.app;
    const schema = opened.schema;
    const [types, docs, round, info, fees, timeline, gateway] = await Promise.all([
        documents.typesOf(app.school), documents.currentDocs(app._id), AdmissionRound.findById(app.round).lean(),
        pool.query(`SELECT c."className", y."yearName" FROM "classes" c, "academicyears" y WHERE c."_id" = $1 AND y."_id" = $2`, [String(app.class), String(app.academicYear)]).then((r) => r.rows[0] || {}),
        payments.summary(app), events.timeline(app.school, app._id, { applicantView: true }), payments.gatewayInfo(app.school),
    ]);
    const reqs = documents.requirements(app, schema, types);
    const docSummary = documents.summarize(reqs, docs);

    // Exams the applicant is scheduled for, with what they may do now.
    const { rows: cands } = await pool.query(
        `SELECT c."_id", c."exam", c."rollNumber", c."status", c."slot", c."slotId", c."slotChanges", c."room" FROM "admissioncandidates" c
           JOIN "admissionexams" e ON e."_id" = c."exam" AND e."status" IN ('scheduled', 'completed')
          WHERE c."application" = $1 AND c."status" <> 'withdrawn'`, [String(app._id)]);
    const examRows = [];
    for (const c of cands) {
        const exam = await AdmissionExam.findById(c.exam).lean();
        const attempts = await AdmissionAttempt.find({ exam: exam._id, application: app._id }).select('status attemptNo startedAt submittedAt deadlineAt').sort({ attemptNo: -1 }).lean();
        const result = await pool.query(`SELECT * FROM "admissionresults" WHERE "exam" = $1 AND "application" = $2`, [String(exam._id), String(app._id)]).then((r) => r.rows[0]);
        const now = new Date();
        const open = attempts.find((a) => a.status === 'in_progress');
        const used = attempts.filter((a) => a.status !== 'void').length;
        examRows.push({
            candidateId: c._id, examId: exam._id, name: exam.name, mode: exam.mode, rollNumber: c.rollNumber, status: c.status,
            startsAt: c.slot || exam.startsAt, endsAt: exam.endsAt, durationMinutes: exam.durationMinutes, reportingTime: exam.reportingTime,
            venue: exam.mode === 'online' ? null : exam.venue, room: c.room || exam.venue?.room || '', instructions: exam.instructions, requiredItems: exam.requiredItems,
            // No admit card before a time is chosen, where the family chooses it — the card would show the wrong time.
            admitCard: exam.admitCard?.enabled && exam.mode !== 'online' && (!exam.admitCard.releaseAt || new Date(exam.admitCard.releaseAt) <= now) && !(exam.booking?.enabled && !c.slotId && !c.slot),
            admitCardFrom: exam.admitCard?.enabled ? exam.admitCard.releaseAt : null,
            online: exam.mode === 'online' ? {
                opensAt: exam.startsAt, closesAt: exam.endsAt, attemptsAllowed: exam.settings?.attemptsAllowed || 1, attemptsUsed: used,
                canStart: exam.status === 'scheduled' && new Date(exam.startsAt) <= now && new Date(exam.endsAt) > now && (!!open || used < (exam.settings?.attemptsAllowed || 1)) && !workflow.isClosed(app.status),
                inProgress: open ? { _id: open._id, deadlineAt: open.deadlineAt } : null,
                submitted: attempts.some((a) => ['submitted', 'auto_submitted'].includes(a.status)),
            } : null,
            result: exams.publishedView(exam, result),
            // Times to choose from, when the school lets families choose (services/admission/slots.js).
            booking: exam.status === 'scheduled' ? await require('../services/admission/slots').familyView(exam, c) : null,
            needsTime: !!exam.booking?.enabled && !c.slotId && !c.slot && exam.status === 'scheduled',
        });
    }
    const offer = await selection.liveOffer(app._id) || (await pool.query(`SELECT * FROM "admissionoffers" WHERE "application" = $1 ORDER BY "issuedAt" DESC LIMIT 1`, [String(app._id)])).rows[0] || null;
    const settings = req.portal.settings;
    const view = familyView(app);
    if (view.quota) {
        const def = (round?.classes || []).find((c) => String(c.class) === String(app.class))?.quotas?.find((q) => q.key === app.quota);
        view.quota.name = def?.name || 'A quota';
    }
    res.json({
        success: true,
        data: {
            application: view,
            schema,
            migration: opened.migration,
            className: info.className, yearName: info.yearName,
            round: round ? { _id: round._id, name: round.name, closesAt: round.closesAt, documentDeadline: round.documentDeadline } : null,
            editable: apps.EDITABLE.includes(app.status),
            canWithdraw: settings.applications.allowWithdraw && !workflow.isClosed(app.status) && app.status !== 'enrolled',
            canDelete: app.status === 'draft' && !app.submittedAt,
            feeBeforeSubmit: settings.applications.applicationFeeTiming === 'before_submit',
            documents: {
                requirements: reqs.map((r) => ({ key: r.type.key, name: r.type.name, description: r.type.description, required: r.required, fromForm: r.fromForm, fieldKey: r.fieldKey, accept: r.type.accept, maxSizeMB: r.type.maxSizeMB })),
                files: docs.map((d) => ({ _id: d._id, docKey: d.docKey, originalName: d.originalName, size: d.size, mime: d.mime, status: d.status, version: d.version, rejectionReason: d.rejectionReason, createdAt: d.createdAt, reviewedAt: d.reviewedAt })),
                summary: docSummary,
            },
            fees: {
                ...fees,
                // A refund the gateway refused stays the office's to sort out; the family sees what is on its way or done.
                refunds: (fees.refunds || []).filter((r) => r.status !== 'failed').map((r) => ({ _id: r._id, amount: r.amount, status: r.status, receiptNumber: r.receiptNumber, reason: r.reason, createdAt: r.createdAt, processedAt: r.processedAt })),
                online: !!gateway.enabled, gateway: gateway.enabled ? { provider: gateway.provider, keyId: gateway.keyId, currency: gateway.currency } : null,
            },
            timeline,
            exams: examRows,
            offer: offer ? {
                _id: offer._id, offerNumber: offer.offerNumber, status: offer.status, issuedAt: offer.issuedAt, respondBy: offer.respondBy, feeAmount: offer.feeAmount, feeDueAt: offer.feeDueAt,
                canRespond: offer.status === 'issued' && settings.selection.allowApplicantResponse && (!offer.respondBy || new Date(offer.respondBy) > new Date()),
            } : null,
            declaration: settings.portal.declaration,
        },
    });
}, TAG);

exports.save = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const r = await apps.saveDraft(req, app, req.body?.data);
    res.json({ success: true, data: familyView(r.app), errors: r.errors });
}, TAG);

exports.submit = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const saved = req.body?.data ? (await apps.saveDraft(req, app, req.body.data)).app : app;
    const row = await apps.submit(req, saved);
    res.json({ success: true, data: familyView(row), message: `Application submitted — your number is ${row.applicationNumber}` });
}, TAG);

exports.withdraw = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const row = await apps.withdraw(req, app, req.body?.reason);
    res.json({ success: true, data: familyView(row) });
}, TAG);

exports.discard = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    res.json({ success: true, data: await apps.discardDraft(req, app) });
}, TAG);

// ── Documents ────────────────────────────────────────────────────────────────

exports.upload = handler(async (req, res) => {
    let app;
    try { app = await access.ownApplication(req, req.params.id); } catch (e) { if (req.file?.path) require('fs').promises.unlink(req.file.path).catch(() => {}); throw e; }
    const schema = await apps.schemaOf(app);
    const r = await documents.upload(app, req.body?.docType, req.file, { req, applicant: true, schema });
    // A document sent again after a rejection goes back for review.
    if (r.resubmitted && app.status === 'documents_rejected') {
        const docs = await documents.currentDocs(app._id);
        if (!docs.some((d) => ['rejected', 'resubmission_required'].includes(d.status))) {
            await apps.move(req, app, 'under_review', { system: true, quiet: true }).catch(() => {});
        }
    }
    await documents.refresh({ ...app }, schema);
    res.status(201).json({ success: true, data: { _id: r.row._id, docKey: r.row.docKey, status: r.row.status, originalName: r.row.originalName, version: r.row.version } });
}, TAG);

exports.removeDocument = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    await documents.remove(app, req.params.docId, req);
    await documents.refresh(app, await apps.schemaOf(app));
    res.json({ success: true });
}, TAG);

exports.documentFile = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    if (!isId(String(req.params.docId))) refuse('Document not found', 404);
    const { rows: [doc] } = await pool.query(`SELECT * FROM "admissiondocuments" WHERE "_id" = $1 AND "application" = $2 AND "school" = $3`, [String(req.params.docId), String(app._id), String(app.school)]);
    if (!doc) refuse('Document not found', 404);
    documents.send(res, doc, { download: req.query.download === '1' });
}, TAG);

// ── Payments ─────────────────────────────────────────────────────────────────

exports.payOrder = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    res.json({ success: true, data: await payments.createOrder(req, app, req.body?.kind, { part: req.body?.part === 'instalment' ? 'instalment' : 'all' }) });
}, TAG);

/**
 * A link to pay this family's own fee in a browser (Oct 2026) — the phone app
 * has no card checkout of its own, so it opens the portal's pay page with this.
 * Same rules as paying here (payments.payableKind, something due, the gateway
 * on); the link lasts an hour and pays only this fee of this application.
 */
exports.payLink = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const kind = req.body?.kind;
    payments.payableKind(app, kind);
    const b = await payments.balance(app, kind);
    if (b.due <= 0) refuse('Nothing is due', 409, { code: 'NOTHING_DUE' });
    const resolved = await require('../services/paymentGateway').resolveGateway(app.school, 'admission');
    if (!resolved.ok) refuse('Online payment is not set up at this school — please pay at the school office', 409, { code: 'GATEWAY_UNAVAILABLE' });
    const settings = req.portal?.settings || await require('../services/admission/settings').getSettings(app.school);
    const { token, expiresAt } = require('../services/admission/payLink').make(app, kind, 1 / 24);
    const url = `${String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/${settings.slug}/pay/${token}`;
    res.status(201).json({ success: true, data: { url, expiresAt, due: b.due } });
}, TAG);

exports.payVerify = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const b = req.body || {};
    const row = await payments.verifyOnline(req, app, { orderId: b.razorpay_order_id || b.orderId, paymentId: b.razorpay_payment_id || b.paymentId, signature: b.razorpay_signature || b.signature });
    res.json({ success: true, data: { receiptNumber: row.receiptNumber, amount: row.amount, status: row.status, _id: row._id } });
}, TAG);

exports.payReconcile = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const row = await payments.reconcile(req, app, req.params.paymentId);
    res.json({ success: true, data: { receiptNumber: row.receiptNumber, status: row.status } });
}, TAG);

exports.receipt = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    await receipts.send(req, res, app, req.params.paymentId);
}, TAG);

// ── Offer ────────────────────────────────────────────────────────────────────

exports.respondOffer = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const accept = req.body?.accept === true;
    if (!accept && !String(req.body?.note || '').trim()) refuse('Please tell the school why you are declining', 400, { field: 'note' });
    const row = await selection.respond(req, app, accept, req.body?.note, { byApplicant: true });
    // The family ticked "withdraw my applications at the other branches" when accepting (services/admission/groups.js).
    const withdrawn = accept && req.body?.withdrawOthers === true ? await require('../services/admission/groups').withdrawSiblings(req, row) : 0;
    res.json({ success: true, data: { ...familyView(row), withdrawnElsewhere: withdrawn } });
}, TAG);

/** The published selection lists of the applicant's class and round, as the school chose to show them. */
exports.lists = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const { rows: lists } = await pool.query(
        `SELECT "_id", "name", "listNo", "kind", "method", "visibility", "publishedAt", "acceptanceDeadline", ("draw" IS NOT NULL) AS "drawn" FROM "admissionlists"
          WHERE "school" = $1 AND "round" = $2 AND "class" = $3 AND "status" IN ('published', 'closed') ORDER BY "listNo"`,
        [String(app.school), String(app.round), String(app.class)]);
    const out = [];
    for (const l of lists) {
        // A lottery's draw numbers are public by nature — the draw record lists them all.
        const lotteryList = l.method === 'lottery' || l.method === 'points_lottery';
        const vis = lotteryList ? { ...(l.visibility || {}), showRank: true } : (l.visibility || {});
        const { rows: lines } = await pool.query(
            `SELECT e."rank", e."decision", e."waitPosition", e."score", e."application", a."applicationNumber", a."studentName"
               FROM "admissionlistentries" e JOIN "admissionapplications" a ON a."_id" = e."application"
              WHERE e."list" = $1 AND e."decision" IN ('selected', 'waitlisted') ORDER BY e."decision", e."rank"`, [l._id]);
        // A family's own line — in a lottery, even when the draw did not reach it.
        let own = lines.find((x) => String(x.application) === String(app._id));
        if (!own && lotteryList) {
            const { rows: [o] } = await pool.query(`SELECT "rank", "decision", "waitPosition", "score", "application" FROM "admissionlistentries" WHERE "list" = $1 AND "application" = $2 AND "rank" IS NOT NULL`, [l._id, String(app._id)]);
            own = o || null;
        }
        out.push({
            _id: l._id, name: l.name, listNo: l.listNo, publishedAt: l.publishedAt, acceptanceDeadline: l.acceptanceDeadline,
            method: l.method || 'merit', drawUrl: lotteryList && l.drawn ? `/${req.portal.slug}/lottery/${l._id}` : '',
            mine: own ? { rank: vis.showRank ? own.rank : null, decision: own.decision, waitPosition: own.waitPosition, score: vis.showScore || lotteryList ? own.score : null } : null,
            lines: lines.map((x) => ({
                applicationNumber: x.applicationNumber, decision: x.decision, waitPosition: x.waitPosition,
                rank: vis.showRank ? x.rank : null, score: vis.showScore ? x.score : null, name: vis.showNames ? x.studentName : null,
                mine: String(x.application) === String(app._id),
            })),
        });
    }
    res.json({ success: true, data: out });
}, TAG);

// ── Documents to download ────────────────────────────────────────────────────

async function pdfContext(req, app) {
    const { rows: [info] } = await pool.query(
        `SELECT c."className", y."yearName", r."name" AS "roundName", u."name" AS "applicantName"
           FROM "admissionapplications" a LEFT JOIN "classes" c ON c."_id" = a."class" LEFT JOIN "academicyears" y ON y."_id" = a."academicYear"
           LEFT JOIN "admissionrounds" r ON r."_id" = a."round" LEFT JOIN "users" u ON u."_id" = a."applicant" WHERE a."_id" = $1`, [String(app._id)]);
    return { school: req.portal.school, theme: req.portal.settings.portal.theme?.primary, ...info };
}

exports.acknowledgement = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    if (!app.submittedAt) refuse('Submit the application to download its acknowledgement', 409);
    const ctx = await pdfContext(req, app);
    const schema = await apps.schemaOf(app);
    const types = await documents.typesOf(app.school);
    const docs = await documents.currentDocs(app._id);
    await pdf.acknowledgement(res, {
        ...ctx, app: { ...app, statusLabel: workflow.STATUSES[app.status]?.label || app.status },
        answers: formEngine.answerRows(schema, app.data, { includeSensitive: true, scope: { classId: app.class, roundId: app.round } }),
        documents: docs.map((d) => ({ name: types.get(d.docKey)?.name || d.docKey, originalName: d.originalName, status: d.status.replace('_', ' ') })),
    });
}, TAG);

exports.admitCard = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    if (!isId(String(req.params.examId))) refuse('Exam not found', 404);
    const exam = await AdmissionExam.findOne({ _id: req.params.examId, school: app.school }).lean();
    const cand = exam ? await AdmissionCandidate.findOne({ exam: exam._id, application: app._id }).lean() : null;
    if (!exam || !cand || cand.status === 'withdrawn') refuse('You are not scheduled for this exam', 404);
    if (!exam.admitCard?.enabled || exam.mode === 'online') refuse('This exam has no admit card', 404);
    if (exam.admitCard.releaseAt && new Date(exam.admitCard.releaseAt) > new Date()) refuse(`The admit card can be downloaded from ${new Date(exam.admitCard.releaseAt).toDateString()}`, 409);
    if (exam.booking?.enabled && !cand.slotId && !cand.slot) refuse('Choose a time first — the admit card shows it', 409, { code: 'CHOOSE_TIME' });
    const ctx = await pdfContext(req, app);
    const photo = (await documents.currentDocs(app._id)).find((d) => d.docKey === 'photo');
    await pdf.admitCard(res, {
        ...ctx, app, exam, candidate: cand,
        photo: photo && /\.(jpe?g|png)$/i.test(photo.file) ? await require('../services/admission/fileStore').readBuffer(photo.file) : null,
        venueText: [exam.venue?.name, exam.venue?.room, exam.venue?.address].filter(Boolean).join(', '),
    });
}, TAG);

exports.scorecard = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    if (!isId(String(req.params.examId))) refuse('Exam not found', 404);
    const exam = await AdmissionExam.findOne({ _id: req.params.examId, school: app.school }).lean();
    const result = exam ? (await pool.query(`SELECT * FROM "admissionresults" WHERE "exam" = $1 AND "application" = $2`, [String(exam._id), String(app._id)])).rows[0] : null;
    const view = exam && result ? exams.publishedView(exam, result) : null;
    if (!view) refuse('No published result yet', 404);
    const ctx = await pdfContext(req, app);
    await pdf.scorecard(res, { ...ctx, app, result: view });
}, TAG);

exports.offerLetter = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const { rows: [offer] } = await pool.query(`SELECT * FROM "admissionoffers" WHERE "application" = $1 AND "status" IN ('issued', 'accepted', 'confirmed') ORDER BY "issuedAt" DESC LIMIT 1`, [String(app._id)]);
    if (!offer) refuse('There is no offer on this application', 404);
    const ctx = await pdfContext(req, app);
    await pdf.offerLetter(res, { ...ctx, app, offer });
}, TAG);

// ── The online exam ──────────────────────────────────────────────────────────

async function examFor(req, app, examId) {
    if (!isId(String(examId || ''))) refuse('Exam not found', 404);
    const exam = await AdmissionExam.findOne({ _id: examId, school: app.school }).lean();
    if (!exam) refuse('Exam not found', 404);
    const cand = await AdmissionCandidate.findOne({ exam: exam._id, application: app._id }).lean();
    if (!cand || cand.status === 'withdrawn') refuse('You are not scheduled for this exam', 403);
    return { exam, cand };
}

async function ownAttempt(req, app, attemptId) {
    if (!isId(String(attemptId || ''))) refuse('Attempt not found', 404);
    const att = await AdmissionAttempt.findOne({ _id: attemptId, application: app._id, school: app.school }).lean();
    if (!att) refuse('Attempt not found', 404);
    return att;
}

exports.startExam = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const { exam, cand } = await examFor(req, app, req.params.examId);
    const attempt = await exams.startAttempt(req, exam, app, cand);
    res.json({ success: true, data: await exams.attemptView(exam, attempt) });
}, TAG);

exports.attempt = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    let att = await ownAttempt(req, app, req.params.attemptId);
    const exam = await AdmissionExam.findById(att.exam).lean();
    att = await exams.finishIfDue(req, exam, att);
    res.json({ success: true, data: await exams.attemptView(exam, att) });
}, TAG);

exports.saveAnswers = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const att = await ownAttempt(req, app, req.params.attemptId);
    const exam = await AdmissionExam.findById(att.exam).lean();
    res.json({ success: true, data: await exams.saveAnswers(req, exam, att, { answers: req.body?.answers, seq: req.body?.seq }) });
}, TAG);

exports.submitExam = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const att = await ownAttempt(req, app, req.params.attemptId);
    const exam = await AdmissionExam.findById(att.exam).lean();
    const row = await exams.submitAttempt(req, exam, att, { answers: req.body?.answers, seq: req.body?.seq });
    res.json({ success: true, data: await exams.attemptView(exam, row) });
}, TAG);

/** Done with the open timed section before its time: the next one opens now. */
exports.nextSection = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const att = await ownAttempt(req, app, req.params.attemptId);
    const exam = await AdmissionExam.findById(att.exam).lean();
    const row = await exams.nextSection(req, exam, att);
    res.json({ success: true, data: await exams.attemptView(exam, row) });
}, TAG);

exports.violation = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    const att = await ownAttempt(req, app, req.params.attemptId);
    await exams.recordViolation(att, req.body?.type);
    res.json({ success: true });
}, TAG);

// ── Updates across the applicant's applications ──────────────────────────────

exports.updates = handler(async (req, res) => {
    const { rows } = await pool.query(
        `SELECT e."_id", e."application", e."type", e."action", e."to", e."message", e."createdAt", a."applicationNumber", a."studentName"
           FROM "admissionevents" e JOIN "admissionapplications" a ON a."_id" = e."application"
          WHERE e."school" = $1 AND a."applicant" = $2 AND e."visibility" = 'applicant'
          ORDER BY e."createdAt" DESC LIMIT 60`, [String(req.schoolId), String(req.userId)]);
    res.json({ success: true, data: rows });
}, TAG);

