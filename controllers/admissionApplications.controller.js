'use strict';
/**
 * The admission office's work on applications: the list, one application in
 * full, moving it through the workflow, notes and assignment, documents, and
 * money taken at the counter. Admission administrators only (the routes);
 * sensitive answers are shown to them, never to assigned staff (see the staff
 * controller).
 */
const pool = require('../db/pool');
const AdmissionDocument = require('../models/AdmissionDocument');
const AdmissionDocumentType = require('../models/AdmissionDocumentType');
const access = require('../services/admission/access');
const apps = require('../services/admission/applications');
const documents = require('../services/admission/documents');
const payments = require('../services/admission/payments');
const receipts = require('../services/admission/receipts');
const selection = require('../services/admission/selection');
const events = require('../services/admission/events');
const formEngine = require('../services/admission/formEngine');
const workflow = require('../services/admission/workflow');
const settingsSvc = require('../services/admission/settings');
const fmt = require('../services/admission/format');
const exportsSvc = require('../services/admission/exports');
const notify = require('../services/admission/notify');
const pdf = require('../services/admission/pdf');
const { handler, refuse, isId, str, ids } = require('../services/admission/util');

const TAG = 'admission applications';

// ── The list ─────────────────────────────────────────────────────────────────

const SORTS = {
    submitted: 'a."submittedAt" DESC NULLS LAST', oldest: 'a."submittedAt" ASC NULLS LAST', created: 'a."createdAt" DESC',
    name: 'lower(a."studentName") ASC', number: 'a."applicationNumber" ASC', updated: 'a."updatedAt" DESC', status: 'a."statusChangedAt" ASC NULLS LAST',
};

function listFilters(req) {
    const q = req.query;
    const params = [String(req.schoolId)];
    const where = ['a."school" = $1'];
    const add = (sql, v) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (q.q) {
        const term = `%${String(q.q).trim().toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
        add(`(lower(a."applicationNumber") LIKE ? OR lower(a."studentName") LIKE ? OR lower(a."guardianName") LIKE ? OR a."guardianPhone" LIKE ? OR lower(a."guardianEmail") LIKE ? OR lower(u."email") LIKE ?)`, term);
    }
    if (q.status) {
        const list = String(q.status).split(',').filter((s) => workflow.STATUSES[s]);
        if (list.length) add('a."status" = ANY(?::text[])', list);
    }
    if (q.stage && workflow.STAGE_BY_KEY[q.stage]) add('a."stage" = ?', String(q.stage));
    if (q.view === 'active') where.push(`a."status" NOT IN ('draft', 'withdrawn', 'cancelled', 'rejected', 'ineligible', 'declined', 'enrolled')`);
    if (q.view === 'submitted') where.push('a."submittedAt" IS NOT NULL');
    if (q.view === 'closed') where.push(`a."status" IN ('withdrawn', 'cancelled', 'rejected', 'ineligible', 'declined')`);
    for (const [k, col] of [['round', 'round'], ['class', 'class'], ['academicYear', 'academicYear'], ['assignedTo', 'assignedTo']]) {
        if (q[k] && isId(String(q[k]))) add(`a."${col}" = ?`, String(q[k]));
    }
    if (q.assignedTo === 'none') where.push('a."assignedTo" IS NULL');
    if (q.docStatus) add('a."docStatus" = ?', String(q.docStatus));
    if (q.fee === 'application_due') where.push(`a."applicationFeeStatus" = 'due'`);
    if (q.fee === 'admission_due') where.push(`a."admissionFeeStatus" = 'due'`);
    if (q.duplicates === '1') where.push(`jsonb_array_length(COALESCE(a."flags"->'duplicateOf', '[]'::jsonb)) > 0`);
    if (q.pending === '1') where.push('a."pendingTransition" IS NOT NULL');
    if (q.from && !Number.isNaN(new Date(q.from).getTime())) add('a."submittedAt" >= ?', new Date(q.from));
    if (q.to && !Number.isNaN(new Date(q.to).getTime())) add('a."submittedAt" < ?', new Date(new Date(q.to).getTime() + 86400000));
    if (q.source) add('a."source" = ?', String(q.source));
    return { where: where.join(' AND '), params };
}

const LIST_SELECT = `a."_id", a."applicationNumber", a."studentName", a."studentDob", a."studentGender", a."status", a."stage", a."submittedAt", a."createdAt", a."updatedAt",
    a."statusChangedAt", a."guardianName", a."guardianPhone", a."guardianEmail", a."docStatus", a."applicationFeeStatus", a."admissionFeeStatus", a."offerStatus",
    a."selection", a."assignedTo", a."pendingTransition", a."flags", a."source", a."admissionNumber", a."round", a."class", a."academicYear", a."formVersion", a."data",
    c."className", r."name" AS "roundName", y."yearName", u."email" AS "applicantEmail", u."name" AS "applicantName", s."name" AS "assignedName"`;
const LIST_FROM = `FROM "admissionapplications" a
    LEFT JOIN "classes" c ON c."_id" = a."class" LEFT JOIN "admissionrounds" r ON r."_id" = a."round"
    LEFT JOIN "academicyears" y ON y."_id" = a."academicYear" LEFT JOIN "users" u ON u."_id" = a."applicant"
    LEFT JOIN "users" s ON s."_id" = a."assignedTo"`;

exports.list = handler(async (req, res) => {
    const f = listFilters(req);
    const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 25));
    const page = Math.max(1, Number(req.query.page) || 1);
    const order = SORTS[req.query.sort] || SORTS.submitted;
    const [{ rows }, { rows: [c] }, { rows: facets }] = await Promise.all([
        pool.query(`SELECT ${LIST_SELECT} ${LIST_FROM} WHERE ${f.where} ORDER BY ${order}, a."_id" LIMIT ${limit} OFFSET ${(page - 1) * limit}`, f.params),
        pool.query(`SELECT COUNT(*)::int AS n ${LIST_FROM} WHERE ${f.where}`, f.params),
        pool.query(`SELECT a."status", COUNT(*)::int AS n FROM "admissionapplications" a WHERE a."school" = $1 GROUP BY a."status"`, [String(req.schoolId)]),
    ]);
    res.json({
        success: true,
        data: rows.map(({ data, formVersion, ...r }) => ({
            ...r, statusLabel: workflow.STATUSES[r.status]?.label || r.status, statusTone: workflow.STATUSES[r.status]?.tone || 'gray',
            duplicates: (r.flags?.duplicateOf || []).length,
        })),
        total: c.n, page, pages: Math.max(1, Math.ceil(c.n / limit)),
        facets: Object.fromEntries(facets.map((x) => [x.status, x.n])),
    });
}, TAG);

exports.exportList = handler(async (req, res) => {
    require('../services/admission/privacy').logAccess(req, { action: 'export', detail: `Applications export (${String(req.query.format || 'xlsx')})${req.query.answers === '0' ? ' without answers' : ''}` });
    const f = listFilters(req);
    const { rows } = await pool.query(`SELECT ${LIST_SELECT} ${LIST_FROM} WHERE ${f.where} ORDER BY ${SORTS[req.query.sort] || SORTS.submitted} LIMIT 20000`, f.params);
    const format = ['csv', 'xlsx', 'pdf'].includes(req.query.format) ? req.query.format : 'xlsx';
    const stamp = new Date().toISOString().slice(0, 10);
    events.recordQuietly(req.schoolId, { by: req, type: 'export', action: 'applications', message: `Exported ${rows.length} application(s) as ${format.toUpperCase()}` });
    if (format === 'pdf') {
        const school = req.portal?.school || (await pool.query(`SELECT "name", "logo" FROM "schools" WHERE "_id" = $1`, [String(req.schoolId)])).rows[0];
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="applications-${stamp}.pdf"`);
        doc.pipe(res);
        doc.font('Helvetica-Bold').fontSize(14).text(pdf.safe(`${school?.name || ''} — Applications (${rows.length})`));
        doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(`Exported ${new Date().toLocaleString('en-IN')}`).fillColor('#000');
        doc.moveDown(0.5);
        const cols = [['applicationNumber', 'Application', 90], ['studentName', 'Student', 150], ['className', 'Class', 70], ['statusLabel', 'Status', 90], ['guardianPhone', 'Contact', 80], ['docStatus', 'Documents', 70], ['submitted', 'Submitted', 90], ['roundName', 'Round', 120]];
        const head = () => { let x = 30; const y = doc.y; doc.font('Helvetica-Bold').fontSize(8); cols.forEach(([, l, w]) => { doc.text(l, x, y, { width: w - 4 }); x += w; }); doc.moveDown(0.4); };
        head();
        for (const r of rows) {
            if (doc.y > doc.page.height - 50) { doc.addPage(); head(); }
            let x = 30; const y = doc.y; doc.font('Helvetica').fontSize(8);
            const v = { ...r, statusLabel: workflow.STATUSES[r.status]?.label || r.status, submitted: r.submittedAt ? new Date(r.submittedAt).toLocaleDateString('en-IN') : '' };
            cols.forEach(([k, , w]) => { doc.text(pdf.safe(v[k] ?? ''), x, y, { width: w - 4, lineBreak: false, ellipsis: true }); x += w; });
            doc.moveDown(0.3);
        }
        doc.end();
        return undefined;
    }
    const { header, body } = await exportsSvc.rowsFor(rows.map((r) => ({ ...r, statusLabel: workflow.STATUSES[r.status]?.label })), { includeSensitive: true, withAnswers: req.query.answers !== '0' });
    return exportsSvc.send(res, { filename: `applications-${stamp}`, sheet: 'Applications', header, body, format });
}, TAG);

// ── One application ──────────────────────────────────────────────────────────

/** Everything the office sees about an application. `restricted` hides sensitive answers and internal notes. */
async function detailFor(req, app, { restricted = false } = {}) {
    const schema = await apps.schemaOf(app);
    const settings = await settingsSvc.getSettings(app.school);
    const flow = workflow.compile(settings.workflow);
    const isAdmin = !restricted && await access.isAdmin(req);
    const facts = await apps.factsFor(app, schema);
    const [types, docs, info, fees, timeline, offers, candidates, dups, entries] = await Promise.all([
        documents.typesOf(app.school), documents.currentDocs(app._id),
        pool.query(`SELECT c."className", y."yearName", r."name" AS "roundName", u."name" AS "applicantName", u."email" AS "applicantEmail", u."phone" AS "applicantPhone", s."name" AS "assignedName"
                      FROM "admissionapplications" a LEFT JOIN "classes" c ON c."_id" = a."class" LEFT JOIN "academicyears" y ON y."_id" = a."academicYear"
                      LEFT JOIN "admissionrounds" r ON r."_id" = a."round" LEFT JOIN "users" u ON u."_id" = a."applicant" LEFT JOIN "users" s ON s."_id" = a."assignedTo"
                     WHERE a."_id" = $1`, [String(app._id)]).then((r) => r.rows[0] || {}),
        payments.summary(app),
        events.timeline(app.school, app._id, { applicantView: false }),
        pool.query(`SELECT * FROM "admissionoffers" WHERE "application" = $1 ORDER BY "issuedAt" DESC`, [String(app._id)]).then((r) => r.rows),
        pool.query(`SELECT c."_id", c."rollNumber", c."status", c."slot", c."room", e."_id" AS "examId", e."name", e."mode", e."startsAt", e."resultsStatus",
                           r."total", r."percentage", r."grade", r."passed", r."absent", r."status" AS "resultStatus", r."marks", r."remarks"
                      FROM "admissioncandidates" c JOIN "admissionexams" e ON e."_id" = c."exam"
                      LEFT JOIN "admissionresults" r ON r."exam" = c."exam" AND r."application" = c."application"
                     WHERE c."application" = $1 ORDER BY e."startsAt"`, [String(app._id)]).then((r) => r.rows),
        app.flags?.duplicateOf?.length ? apps.duplicates(app) : Promise.resolve([]),
        pool.query(`SELECT e."rank", e."decision", e."waitPosition", e."score", e."manual", e."reason", l."name", l."listNo", l."status"
                      FROM "admissionlistentries" e JOIN "admissionlists" l ON l."_id" = e."list" WHERE e."application" = $1 ORDER BY l."listNo"`, [String(app._id)]).then((r) => r.rows),
    ]);
    const reqs = documents.requirements(app, schema, types);
    const moves = workflow.options(app, { flow, isAdmin, actorId: req.userId, facts, withReasons: true });
    const blockers = ['accepted', 'payment_pending', 'selected'].includes(app.status) ? await selection.confirmationBlockers(app, settings) : [];
    const visibleTimeline = restricted ? timeline.filter((t) => t.visibility === 'applicant' || t.type === 'status') : timeline;
    // Aadhaar numbers leave the server masked; an administrator reveals one on purpose (logged).
    const shown = formEngine.maskData(schema, app.data || {});
    return {
        application: {
            ...app, data: restricted ? Object.fromEntries(Object.entries(shown.data).filter(([k]) => !formEngine.allFields(schema).find((f) => f.key === k && f.sensitive))) : shown.data,
            maskedFields: restricted ? [] : shown.masked,
            retiredData: restricted ? undefined : app.retiredData,
            statusLabel: workflow.STATUSES[app.status]?.label || app.status, statusTone: workflow.STATUSES[app.status]?.tone || 'gray',
            ...info,
        },
        schema: restricted ? formEngine.withoutSensitive(schema) : schema,
        answers: formEngine.answerRows(schema, app.data, { includeSensitive: !restricted, scope: { classId: app.class, roundId: app.round } }),
        documents: {
            requirements: reqs.map((r) => ({ key: r.type.key, name: r.type.name, required: r.required, verification: r.type.verification, gate: r.type.gate, rejectionReasons: r.type.rejectionReasons || [], sensitive: r.type.sensitive })),
            files: docs.filter((d) => !restricted || !types.get(d.docKey)?.sensitive),
            summary: facts.docs,
            history: restricted ? [] : (await pool.query(`SELECT "_id", "docKey", "status", "version", "originalName", "rejectionReason", "createdAt", "reviewedAt" FROM "admissiondocuments" WHERE "application" = $1 AND NOT "current" ORDER BY "createdAt" DESC`, [String(app._id)])).rows,
        },
        fees, timeline: visibleTimeline, offers, exams: candidates, lists: entries, duplicates: dups,
        workflow: {
            moves, stage: flow.stage(app.stage), stages: flow.stages.filter((s) => s.enabled).map((s) => ({ key: s.key, label: s.label })),
            pending: app.pendingTransition, facts: { docs: facts.docs, exams: facts.exams, results: facts.results },
        },
        confirmation: { blockers, ready: ['accepted', 'payment_pending', 'selected'].includes(app.status) && !blockers.length },
        permissions: { isAdmin, canSeeSensitive: isAdmin, canReveal: isAdmin && !app.erasedAt },
        // The class's quotas, for putting the application in one (services/admission/quotas).
        quotas: (await require('../services/admission/quotas').classOf(app.round, app.class)).quotas.map((q) => ({ key: q.key, name: q.name, kind: q.kind, feeRule: q.feeRule })),
        waivers: settings.fees.waivers,
    };
}
exports._detailFor = detailFor;

exports.detail = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await detailFor(req, app) });
}, TAG);

exports.pdf = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const schema = await apps.schemaOf(app);
    const types = await documents.typesOf(app.school);
    const docs = await documents.currentDocs(app._id);
    const { rows: [info] } = await pool.query(
        `SELECT c."className", y."yearName", r."name" AS "roundName", u."name" AS "applicantName" FROM "admissionapplications" a
           LEFT JOIN "classes" c ON c."_id" = a."class" LEFT JOIN "academicyears" y ON y."_id" = a."academicYear"
           LEFT JOIN "admissionrounds" r ON r."_id" = a."round" LEFT JOIN "users" u ON u."_id" = a."applicant" WHERE a."_id" = $1`, [String(app._id)]);
    const school = (await pool.query(`SELECT "name", "logo" FROM "schools" WHERE "_id" = $1`, [String(req.schoolId)])).rows[0];
    const settings = await settingsSvc.getSettings(app.school);
    const pays = (await pool.query(`SELECT * FROM "admissionpayments" WHERE "application" = $1 AND "status" = 'paid' ORDER BY "paidAt"`, [String(app._id)])).rows;
    await pdf.applicationPdf(res, {
        school, theme: settings.portal.theme?.primary, ...info, app: { ...app, statusLabel: workflow.STATUSES[app.status]?.label || app.status },
        answers: formEngine.answerRows(schema, app.data, { includeSensitive: true, scope: { classId: app.class, roundId: app.round } }),
        documents: docs.map((d) => ({ name: types.get(d.docKey)?.name || d.docKey, status: d.status.replace('_', ' '), reviewedAt: d.reviewedAt })),
        payments: pays,
    });
}, TAG);

exports.transition = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const b = req.body || {};
    const r = await apps.move(req, app, String(b.to || ''), { remarks: b.remarks, note: b.note, reason: b.reason, reopen: b.reopen === true });
    res.json({ success: true, data: r.pending ? { pending: true } : { status: r.status }, message: r.pending ? 'Sent for approval' : `Moved to ${workflow.STATUSES[r.status]?.label}` });
}, TAG);

exports.decidePending = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const row = await apps.decidePending(req, app, req.body?.approve === true, str(req.body?.note, 300));
    res.json({ success: true, data: { status: row.status } });
}, TAG);

/** One action over many applications; each succeeds or fails on its own. */
exports.bulk = handler(async (req, res) => {
    const list = ids(req.body?.ids).slice(0, 200);
    if (!list.length) refuse('Choose applications first');
    const action = req.body?.action;
    const results = { done: 0, failed: [] };
    for (const id of list) {
        try {
            const app = await access.schoolApplication(req, id);
            if (action === 'transition') await apps.move(req, app, String(req.body.to || ''), { remarks: req.body.remarks, note: req.body.note });
            else if (action === 'assign') await apps.assign(req, app, req.body.userId || null);
            else refuse('Unknown action');
            results.done += 1;
        } catch (e) {
            results.failed.push({ id, message: e.expose || e.status ? e.message : 'Failed' });
        }
    }
    events.recordQuietly(req.schoolId, { by: req, type: 'bulk', action, message: `Bulk ${action}: ${results.done} done, ${results.failed.length} not` });
    res.json({ success: true, data: results });
}, TAG);

exports.assign = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const row = await apps.assign(req, app, req.body?.userId || null);
    res.json({ success: true, data: { assignedTo: row.assignedTo } });
}, TAG);

exports.addNote = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await apps.addNote(req, app, req.body?.text) });
}, TAG);

exports.correct = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const row = await apps.correctAnswers(req, app, req.body?.data, req.body?.reason);
    res.json({ success: true, data: { _id: row._id } });
}, TAG);

exports.duplicates = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await apps.duplicates(app) });
}, TAG);

exports.clearDuplicate = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const { patch } = require('../db/patch');
    await patch(require('../models/AdmissionApplication'), app._id, { flags: { ...(app.flags || {}), duplicateOf: [], duplicateCleared: { by: String(req.userId), at: new Date() } } }, { touch: false });
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'note', action: 'duplicate_cleared', message: 'Duplicate warning reviewed and cleared' });
    res.json({ success: true });
}, TAG);

// ── Documents ────────────────────────────────────────────────────────────────

async function documentOf(req, docId) {
    if (!isId(String(docId || ''))) refuse('Document not found', 404);
    const { rows: [doc] } = await pool.query(`SELECT * FROM "admissiondocuments" WHERE "_id" = $1 AND "school" = $2`, [String(docId), String(req.schoolId)]);
    if (!doc) refuse('Document not found', 404);
    return doc;
}
exports._documentOf = documentOf;

/** Review a document; the application's own status follows. */
async function reviewDocument(req, doc, body) {
    const updated = await documents.review(doc, { decision: body.decision, reason: body.reason, note: body.note }, req);
    const app = await access.schoolApplication(req, doc.application);
    const type = await AdmissionDocumentType.findById(doc.docType).lean();
    const name = type?.name || doc.docKey;
    const schema = await apps.schemaOf(app);
    const summary = await documents.refresh(app, schema);
    events.recordQuietly(app.school, {
        application: app._id, by: req, type: 'document', action: updated.status,
        message: updated.status === 'verified' ? `${name} verified` : `${name} ${updated.status === 'rejected' ? 'not accepted' : 'needs to be uploaded again'} — ${updated.rejectionReason}`,
        visibility: 'applicant',
    });
    const settings = await settingsSvc.getSettings(app.school);
    const flow = workflow.compile(settings.workflow);
    const inDocStage = ['submitted', 'under_review', 'documents_pending', 'documents_rejected'].includes(app.status);
    if (updated.status !== 'verified') {
        notify.toApplicant(app, 'document_rejected', { document_name: name, rejection_reason: updated.rejectionReason });
        if (inDocStage && app.status !== 'documents_rejected' && flow.enabled('document_verification')) {
            await apps.move(req, app, 'documents_rejected', { system: true, quiet: true, remarks: `${name}: ${updated.rejectionReason}` }).catch(() => {});
        }
    } else if (summary.unverified === 0 && summary.rejected === 0 && inDocStage && flow.enabled('document_verification')) {
        // Every required paper is in order: the application is verified.
        const moved = await apps.move(req, app, 'verified', { system: true, quiet: true }).catch(() => null);
        if (moved) notify.toApplicant(moved, 'documents_verified');
    } else if (app.status === 'documents_rejected' && summary.rejected === 0) {
        await apps.move(req, app, 'under_review', { system: true, quiet: true }).catch(() => {});
    }
    return updated;
}
exports._reviewDocument = reviewDocument;

exports.reviewDocument = handler(async (req, res) => {
    const doc = await documentOf(req, req.params.docId);
    res.json({ success: true, data: await reviewDocument(req, doc, req.body || {}) });
}, TAG);

exports.documentFile = handler(async (req, res) => {
    const doc = await documentOf(req, req.params.docId);
    documents.send(res, doc, { download: req.query.download === '1' });
}, TAG);

/** The verification queue: current documents waiting for a decision. */
exports.documentQueue = handler(async (req, res) => {
    const status = ['uploaded', 'under_review', 'rejected', 'resubmission_required', 'verified'].includes(req.query.status) ? [req.query.status] : ['uploaded', 'under_review'];
    const params = [String(req.schoolId), status];
    let extra = '';
    if (req.query.docKey) { params.push(String(req.query.docKey)); extra += ` AND d."docKey" = $${params.length}`; }
    if (req.query.round && isId(String(req.query.round))) { params.push(String(req.query.round)); extra += ` AND a."round" = $${params.length}`; }
    const limit = Math.min(100, Number(req.query.limit) || 30);
    const offset = (Math.max(1, Number(req.query.page) || 1) - 1) * limit;
    const sql = `FROM "admissiondocuments" d JOIN "admissionapplications" a ON a."_id" = d."application" AND a."status" <> 'draft'
                 LEFT JOIN "admissiondocumenttypes" t ON t."_id" = d."docType" LEFT JOIN "classes" c ON c."_id" = a."class"
                WHERE d."school" = $1 AND d."current" AND d."status" = ANY($2::text[])${extra}`;
    const [{ rows }, { rows: [cnt] }] = await Promise.all([
        pool.query(`SELECT d."_id", d."docKey", d."status", d."originalName", d."mime", d."size", d."version", d."createdAt", d."rejectionReason",
                           t."name" AS "typeName", t."rejectionReasons", t."sensitive", a."_id" AS "applicationId", a."applicationNumber", a."studentName", c."className"
                    ${sql} ORDER BY d."createdAt" ASC LIMIT ${limit} OFFSET ${offset}`, params),
        pool.query(`SELECT COUNT(*)::int AS n ${sql}`, params),
    ]);
    res.json({ success: true, data: rows, total: cnt.n });
}, TAG);

/** The office adds a document on the family's behalf (a paper handed in at the counter). */
exports.uploadOnBehalf = handler(async (req, res) => {
    let app;
    try { app = await access.schoolApplication(req, req.params.id); } catch (e) { if (req.file?.path) require('fs').promises.unlink(req.file.path).catch(() => {}); throw e; }
    const schema = await apps.schemaOf(app);
    const r = await documents.upload(app, req.body?.docType, req.file, { req, applicant: false, schema });
    await documents.refresh(app, schema);
    res.status(201).json({ success: true, data: r.row });
}, TAG);

// ── Payments at the counter ──────────────────────────────────────────────────

exports.recordPayment = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.status(201).json({ success: true, data: await payments.recordOffline(req, app, req.body || {}) });
}, TAG);

exports.voidPayment = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await payments.voidPayment(req, app, req.params.paymentId, req.body?.reason) });
}, TAG);

exports.addWaiver = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await payments.applyWaiver(req, app, req.body || {}) });
}, TAG);

exports.removeWaiver = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.json({ success: true, data: await payments.removeWaiver(req, app, req.body || {}) });
}, TAG);

exports.receipt = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    await receipts.send(req, res, app, req.params.paymentId);
}, TAG);

exports.payments = handler(async (req, res) => {
    const params = [String(req.schoolId)];
    let extra = '';
    if (['application_fee', 'admission_fee'].includes(req.query.kind)) { params.push(req.query.kind); extra += ` AND p."kind" = $${params.length}`; }
    if (['paid', 'void', 'failed', 'created'].includes(req.query.status)) { params.push(req.query.status); extra += ` AND p."status" = $${params.length}`; } else extra += ` AND p."status" IN ('paid', 'void')`;
    const limit = Math.min(100, Number(req.query.limit) || 30);
    const offset = (Math.max(1, Number(req.query.page) || 1) - 1) * limit;
    const [{ rows }, { rows: [t] }] = await Promise.all([
        pool.query(`SELECT p."_id", p."kind", p."amount", p."mode", p."status", p."receiptNumber", p."reference", p."paidAt", p."voidReason",
                           a."_id" AS "applicationId", a."applicationNumber", a."studentName",
                           (SELECT COALESCE(SUM(r."amount"), 0)::float8 FROM "admissionrefunds" r WHERE r."payment" = p."_id" AND r."status" IN ('pending', 'processed')) AS "refunded"
                      FROM "admissionpayments" p JOIN "admissionapplications" a ON a."_id" = p."application"
                     WHERE p."school" = $1${extra} ORDER BY p."paidAt" DESC NULLS LAST, p."createdAt" DESC LIMIT ${limit} OFFSET ${offset}`, params),
        pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(p."amount") FILTER (WHERE p."status" = 'paid'), 0)::float8 AS amount,
                           (SELECT COALESCE(SUM(r."amount"), 0)::float8 FROM "admissionrefunds" r JOIN "admissionpayments" p ON p."_id" = r."payment"
                             WHERE r."school" = $1 AND r."status" IN ('pending', 'processed')${extra}) AS refunded
                      FROM "admissionpayments" p WHERE p."school" = $1${extra}`, params),
    ]);
    res.json({ success: true, data: rows, total: t.n, amount: t.amount, refunded: t.refunded });
}, TAG);

// ── Refunds and payment links (Oct 2026) ─────────────────────────────────────

exports.refund = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    res.status(201).json({ success: true, data: await payments.refund(req, app, req.params.paymentId, req.body || {}) });
}, TAG);

exports.payLink = handler(async (req, res) => {
    const app = await access.schoolApplication(req, req.params.id);
    const kind = ['application_fee', 'admission_fee'].includes(req.body?.kind) ? req.body.kind : null;
    if (!kind) refuse('Choose the application fee or the admission fee');
    const b = await payments.balance(app, kind);
    if (b.due <= 0) refuse('Nothing is due on this fee', 409);
    const settings = await settingsSvc.getSettings(app.school);
    if (!settings.slug) refuse('Set the portal\'s address first (Settings → Portal)', 409);
    const { token, expiresAt } = require('../services/admission/payLink').make(app, kind);
    const url = `${String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/${settings.slug}/pay/${token}`;
    if (req.body?.send === true) {
        require('../services/admission/notify').toApplicant(app, 'payment_link', { fee_amount: fmt.money(b.due), payment_for: payments.LABEL[kind], pay_link: url, link_expiry: fmt.fmtDate(expiresAt) });
    }
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'payment', action: 'pay_link', message: `Payment link made for the ${payments.LABEL[kind]} (${fmt.money(b.due)})${req.body?.send === true ? ' and emailed to the family' : ''}` });
    res.status(201).json({ success: true, data: { url, expiresAt } });
}, TAG);

// The list's own filters, for exports prepared in the background (services/admission/exportJobs.js).
exports.listQuery = { listFilters, LIST_SELECT, LIST_FROM, SORTS };
