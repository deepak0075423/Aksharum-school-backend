'use strict';
/**
 * Admission work for teachers and staff who are not admission administrators
 * (routes: requireModule('admission')): the exams and interviews they are
 * assigned to evaluate, the applications assigned to them, and the document
 * types they review. They see what the work needs and nothing more — no
 * sensitive answers, no internal notes but their own stage's, nothing of
 * applications not assigned to them.
 */
const pool = require('../db/pool');
const AdmissionDocumentType = require('../models/AdmissionDocumentType');
const access = require('../services/admission/access');
const apps = require('../services/admission/applications');
const workflow = require('../services/admission/workflow');
const applicationsCtrl = require('./admissionApplications.controller');
const { handler, refuse, isId } = require('../services/admission/util');

const TAG = 'admission staff';

exports.duties = handler(async (req, res) => {
    const me = String(req.userId);
    const [{ rows: exams }, { rows: assigned }, types] = await Promise.all([
        pool.query(
            `SELECT e."_id", e."name", e."mode", e."startsAt", e."endsAt", e."status", e."resultsStatus", r."name" AS "roundName",
                    (SELECT COUNT(*) FROM "admissioncandidates" c WHERE c."exam" = e."_id" AND c."status" <> 'withdrawn')::int AS candidates,
                    (SELECT COUNT(*) FROM "admissioncandidates" c WHERE c."exam" = e."_id" AND c."status" = 'scheduled')::int AS "notMarked",
                    (SELECT COALESCE(SUM(t."manualPending"), 0) FROM "admissionattempts" t WHERE t."exam" = e."_id")::int AS "toEvaluate"
               FROM "admissionexams" e JOIN "admissionrounds" r ON r."_id" = e."round"
              WHERE e."school" = $1 AND e."status" IN ('scheduled', 'completed')
                AND (e."evaluators" @> to_jsonb($2::text)
                     OR EXISTS (SELECT 1 FROM "admissioncandidates" c WHERE c."exam" = e."_id" AND c."panel" @> to_jsonb($2::text)))
              ORDER BY e."startsAt" DESC`, [String(req.schoolId), me]),
        pool.query(
            `SELECT a."_id", a."applicationNumber", a."studentName", a."status", a."stage", a."submittedAt", a."statusChangedAt", c."className"
               FROM "admissionapplications" a LEFT JOIN "classes" c ON c."_id" = a."class"
              WHERE a."school" = $1 AND a."assignedTo" = $2 AND a."status" NOT IN ('withdrawn', 'cancelled', 'enrolled')
              ORDER BY a."statusChangedAt" ASC NULLS LAST LIMIT 200`, [String(req.schoolId), me]),
        AdmissionDocumentType.find({ school: req.schoolId, isActive: true, reviewers: me }).select('key name').lean(),
    ]);
    let docQueue = 0;
    if (types.length) {
        const { rows: [n] } = await pool.query(
            `SELECT COUNT(*)::int AS n FROM "admissiondocuments" d JOIN "admissionapplications" a ON a."_id" = d."application" AND a."status" <> 'draft'
              WHERE d."school" = $1 AND d."current" AND d."status" IN ('uploaded', 'under_review') AND d."docKey" = ANY($2::text[])`,
            [String(req.schoolId), types.map((t) => t.key)]);
        docQueue = n.n;
    }
    res.json({
        success: true,
        data: {
            exams, applications: assigned.map((a) => ({ ...a, statusLabel: workflow.STATUSES[a.status]?.label || a.status })),
            reviewTypes: types, documentQueue: docQueue, isAdmin: await access.isAdmin(req),
        },
    });
}, TAG);

/** An application assigned to me — what my part of the work needs. */
async function assignedApplication(req, id) {
    const app = await access.schoolApplication(req, id);
    if (String(app.assignedTo || '') !== String(req.userId) && !(await access.isAdmin(req))) refuse('Application not found', 404);
    return app;
}

exports.application = handler(async (req, res) => {
    const app = await assignedApplication(req, req.params.id);
    res.json({ success: true, data: await applicationsCtrl._detailFor(req, app, { restricted: !(await access.isAdmin(req)) }) });
}, TAG);

exports.transition = handler(async (req, res) => {
    const app = await assignedApplication(req, req.params.id);
    const b = req.body || {};
    const r = await apps.move(req, app, String(b.to || ''), { remarks: b.remarks, note: b.note, reason: b.reason });
    res.json({ success: true, data: r.pending ? { pending: true } : { status: r.status }, message: r.pending ? 'Sent to an administrator for approval' : `Moved to ${workflow.STATUSES[r.status]?.label}` });
}, TAG);

exports.note = handler(async (req, res) => {
    const app = await assignedApplication(req, req.params.id);
    res.json({ success: true, data: await apps.addNote(req, app, req.body?.text) });
}, TAG);

/** Documents of the types I review, waiting for a decision. */
exports.documentQueue = handler(async (req, res) => {
    const types = await AdmissionDocumentType.find({ school: req.schoolId, isActive: true, reviewers: String(req.userId) }).select('key').lean();
    if (!types.length && !(await access.isAdmin(req))) return res.json({ success: true, data: [], total: 0 });
    req.query.docKey = req.query.docKey && types.some((t) => t.key === req.query.docKey) ? req.query.docKey : undefined;
    const keys = types.map((t) => t.key);
    const { rows } = await pool.query(
        `SELECT d."_id", d."docKey", d."status", d."originalName", d."mime", d."size", d."version", d."createdAt",
                t."name" AS "typeName", t."rejectionReasons", a."_id" AS "applicationId", a."applicationNumber", a."studentName", c."className"
           FROM "admissiondocuments" d JOIN "admissionapplications" a ON a."_id" = d."application" AND a."status" <> 'draft'
           LEFT JOIN "admissiondocumenttypes" t ON t."_id" = d."docType" LEFT JOIN "classes" c ON c."_id" = a."class"
          WHERE d."school" = $1 AND d."current" AND d."status" IN ('uploaded', 'under_review') AND d."docKey" = ANY($2::text[])
            AND NOT COALESCE(t."sensitive", false)
          ORDER BY d."createdAt" ASC LIMIT 200`, [String(req.schoolId), keys]);
    res.json({ success: true, data: rows, total: rows.length });
}, TAG);

async function reviewableDoc(req, docId) {
    const doc = await applicationsCtrl._documentOf(req, docId);
    if (await access.isAdmin(req)) return doc;
    const type = doc.docType ? await AdmissionDocumentType.findById(doc.docType).lean() : null;
    if (!type || type.sensitive || !(type.reviewers || []).map(String).includes(String(req.userId))) refuse('Document not found', 404);
    return doc;
}

exports.reviewDocument = handler(async (req, res) => {
    const doc = await reviewableDoc(req, req.params.docId);
    res.json({ success: true, data: await applicationsCtrl._reviewDocument(req, doc, req.body || {}) });
}, TAG);

exports.documentFile = handler(async (req, res) => {
    const doc = await reviewableDoc(req, req.params.docId);
    require('../services/admission/documents').send(res, doc, { download: req.query.download === '1' });
}, TAG);

