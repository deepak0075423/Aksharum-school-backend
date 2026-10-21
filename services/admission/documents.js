'use strict';
/**
 * Admission documents: what an application must carry, uploads, reviews, and
 * opening the files.
 *
 * An upload is checked three ways before it is kept — its extension against
 * the document type's allowed formats, its size against the type's limit,
 * and its CONTENT against what it claims to be (a file named .pdf has to
 * start like a PDF) — and stored under a random name in a folder the static
 * server never serves. Files are opened only through the admission API,
 * after the loader has proved the application is the caller's (applicant) or
 * their school's (staff).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../../db/pool');
const AdmissionDocument = require('../../models/AdmissionDocument');
const AdmissionDocumentType = require('../../models/AdmissionDocumentType');
const AdmissionApplication = require('../../models/AdmissionApplication');
const { withTransaction, buildInsert } = require('../dbTx');
const { patch } = require('../../db/patch');
const formEngine = require('./formEngine');
const events = require('./events');
const { refuse, isId } = require('./util');

// Files live on this server's disk or in a private bucket — services/admission/fileStore.js.
const fileStore = require('./fileStore');
const ROOT = fileStore.ROOT;
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT_KINDS = { pdf: 'pdf', jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' };

/** What the bytes actually are: 'pdf' | 'jpeg' | 'png' | 'webp' | null. */
function sniff(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
    return null;
}

const EDITABLE_BEFORE_SUBMIT = ['draft', 'incomplete'];
const OPEN_FOR_DOCUMENTS = ['draft', 'incomplete', 'submitted', 'under_review', 'documents_pending', 'documents_rejected', 'verified', 'eligible',
    'exam_scheduled', 'exam_completed', 'interview_scheduled', 'interview_completed', 'evaluated', 'selected', 'waitlisted', 'offer_issued', 'accepted', 'payment_pending'];

// ── Which documents an application needs ─────────────────────────────────────

/** Active document types of a school, keyed by key. */
async function typesOf(schoolId) {
    const rows = await AdmissionDocumentType.find({ school: schoolId, isActive: true }).sort({ order: 1, name: 1 }).lean();
    return new Map(rows.map((r) => [r.key, r]));
}

const appliesTo = (type, app) =>
    (!type.appliesTo?.classes?.length || type.appliesTo.classes.map(String).includes(String(app.class)))
    && (!type.appliesTo?.rounds?.length || type.appliesTo.rounds.map(String).includes(String(app.round)));

/**
 * The document types this application asks for: those the form asks for
 * (given the answers so far) and those the school requires for its class and
 * round. [{ type, required, fromForm, fieldKey, label }]
 */
function requirements(app, schema, types) {
    const out = new Map();
    for (const f of formEngine.fileFields(schema, app.data || {}, { classId: app.class, roundId: app.round })) {
        const type = types.get(f.docType);
        if (!type) continue;
        out.set(type.key, { type, required: !!f.required, fromForm: true, fieldKey: f.key, label: f.label || type.name });
    }
    for (const type of types.values()) {
        if (!type.required || !appliesTo(type, app) || out.has(type.key)) continue;
        out.set(type.key, { type, required: true, fromForm: false, fieldKey: '', label: type.name });
    }
    return [...out.values()];
}

/** The current file of each document type on an application. */
async function currentDocs(applicationId, q = null) {
    const run = q || ((s, p) => pool.query(s, p));
    const { rows } = await run(
        `SELECT * FROM "${AdmissionDocument.tableName}" WHERE "application" = $1 AND "current" ORDER BY "createdAt"`, [String(applicationId)]);
    return rows;
}

/**
 * Counts that drive the workflow and the list's document column:
 * { required, uploaded, missing, verified, unverified, rejected, underReview, status }.
 */
function summarize(reqs, docs) {
    const byKey = new Map(docs.map((d) => [d.docKey, d]));
    const s = { required: 0, uploaded: 0, missing: 0, verified: 0, unverified: 0, rejected: 0, underReview: 0 };
    for (const r of reqs) {
        const d = byKey.get(r.type.key);
        if (r.required) s.required += 1;
        if (!d) { if (r.required) s.missing += 1; continue; }
        s.uploaded += 1;
        if (['rejected', 'resubmission_required'].includes(d.status)) s.rejected += 1;
        if (d.status === 'verified') s.verified += 1;
        if (['uploaded', 'under_review'].includes(d.status)) s.underReview += 1;
        if (r.required && r.type.verification && d.status !== 'verified') s.unverified += 1;
    }
    s.unverified += s.missing;
    s.status = !reqs.length ? 'none'
        : s.rejected ? 'rejected'
        : s.missing ? 'missing'
        : s.unverified ? 'under_review'
        : 'verified';
    return s;
}

/** Recompute and store an application's document state; returns the summary. */
async function refresh(app, schema, q = null) {
    const types = await typesOf(app.school);
    const docs = await currentDocs(app._id, q);
    const s = summarize(requirements(app, schema, types), docs);
    if (s.status !== app.docStatus) await patch(AdmissionApplication, app._id, { docStatus: s.status }, { q, touch: false });
    return s;
}

// ── Uploading ────────────────────────────────────────────────────────────────

function discard(file) {
    if (file?.key) fileStore.remove(file.key);
    else if (file?.path) fs.promises.unlink(file.path).catch(() => {});
}

/**
 * Keep an uploaded file as the current document of `docKey` on `app`.
 * `who`: { req, applicant: bool }. Returns the stored row.
 */
async function upload(app, docKey, file, { req, applicant = false, schema }) {
    try {
        if (!file) refuse('Choose a file to upload', 400, { field: 'file' });
        const types = await typesOf(app.school);
        const type = types.get(String(docKey || ''));
        if (!type) refuse('That document type is not asked for', 400, { field: 'docType' });
        const reqs = requirements(app, schema, types);
        const wanted = reqs.find((r) => r.type.key === type.key);
        // An applicant uploads what the application asks for; the office may
        // add any active type (a paper handed in at the counter).
        if (applicant && !wanted) refuse('This application does not ask for that document', 400, { field: 'docType' });
        if (!OPEN_FOR_DOCUMENTS.includes(app.status)) refuse('Documents can no longer be changed on this application', 409);

        const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
        const accept = (type.accept?.length ? type.accept : ['pdf', 'jpg', 'jpeg', 'png']).map((x) => String(x).toLowerCase());
        if (!accept.includes(ext)) refuse(`${type.name}: upload ${accept.map((x) => x.toUpperCase()).join(', ')}`, 400, { field: 'file' });
        const maxBytes = Math.max(1, Number(type.maxSizeMB) || 5) * 1024 * 1024;
        if (file.size > maxBytes) refuse(`${type.name}: the file must be at most ${type.maxSizeMB} MB`, 400, { field: 'file' });
        const fd = await fs.promises.open(file.path, 'r');
        const head = Buffer.alloc(16);
        await fd.read(head, 0, 16, 0);
        await fd.close();
        if (sniff(head) !== EXT_KINDS[ext]) refuse(`${type.name}: the file is not a real ${ext.toUpperCase()} — it may be damaged or renamed`, 400, { field: 'file' });

        // Replacing a file the office has already decided on.
        const docs = await currentDocs(app._id);
        const previous = docs.find((d) => d.docKey === type.key);
        if (applicant && previous) {
            if (previous.status === 'verified') refuse(`${type.name} is already verified — contact the admission office to change it`, 409);
            const afterSubmit = !EDITABLE_BEFORE_SUBMIT.includes(app.status);
            if (afterSubmit && !['rejected', 'resubmission_required'].includes(previous.status)) {
                refuse(`${type.name} is being reviewed — you can upload it again if the office asks for it`, 409);
            }
            if (afterSubmit && (!type.allowResubmission || (previous.version || 1) > (Number(type.maxResubmissions) || 3))) {
                refuse(`${type.name} cannot be uploaded again — please contact the admission office`, 409);
            }
        }

        // Virus scan (services/admission/virusScan.js), when the server has a scanner.
        const scan = await require('./virusScan').scanFile(file.path);
        if (scan.status === 'infected') {
            events.recordQuietly(app.school, { application: app._id, by: req, type: 'document', action: 'infected', message: `${type.name}: an upload was refused — the virus scanner found ${scan.signature}` });
            refuse(`${type.name}: the virus scanner found something harmful in this file, so it was not kept. Please upload a clean copy.`, 422, { code: 'FILE_INFECTED', field: 'file' });
        }
        if (scan.status === 'unavailable' && require('./virusScan').config().required) {
            refuse('Files cannot be checked for viruses just now — please try again in a few minutes', 503, { code: 'SCANNER_UNAVAILABLE' });
        }

        const sha256 = crypto.createHash('sha256').update(await fs.promises.readFile(file.path)).digest('hex');
        const stored = `${crypto.randomUUID()}.${ext}`;
        const key = `${app.school}/${stored}`;
        await fileStore.save(file.path, key, MIME[ext]);

        const isResubmission = previous && ['rejected', 'resubmission_required'].includes(previous.status);
        // From here the file is in place; if the row cannot be written, it goes.
        const original = file;
        file = { key };
        const row = await withTransaction(async (q) => {
            if (previous) {
                await q(`UPDATE "${AdmissionDocument.tableName}" SET "current" = false, "status" = CASE WHEN "status" IN ('uploaded', 'under_review') THEN 'replaced' ELSE "status" END, "updatedAt" = now() WHERE "_id" = $1`, [previous._id]);
            }
            const { sql, params } = buildInsert(AdmissionDocument, {
                school: app.school, application: app._id, applicant: app.applicant, docType: type._id, docKey: type.key,
                fieldKey: wanted?.fieldKey || '', file: key, originalName: String(original.originalname || '').slice(0, 200),
                mime: MIME[ext], size: original.size, sha256, status: EDITABLE_BEFORE_SUBMIT.includes(app.status) ? 'uploaded' : 'under_review',
                scanStatus: scan.status, scannedAt: scan.status === 'off' ? null : new Date(),
                version: (previous?.version || 0) + 1, current: true, uploadedBy: req.userId,
                history: [{ status: 'uploaded', by: String(req.userId), at: new Date(), note: isResubmission ? 'Uploaded again' : '' }],
            });
            const { rows } = await q(sql, params);
            await events.record(app.school, {
                application: app._id, by: req, type: 'document', action: isResubmission ? 'resubmitted' : 'uploaded',
                message: `${type.name} ${isResubmission ? 'uploaded again' : 'uploaded'}`, visibility: 'applicant',
                meta: { docKey: type.key, version: (previous?.version || 0) + 1 },
            }, q);
            return rows[0];
        });
        return { row, type, resubmitted: !!isResubmission };
    } catch (e) {
        discard(file);
        throw e;
    }
}

/** Remove the current file of a type — only before the application is submitted. */
async function remove(app, docId, req) {
    if (!EDITABLE_BEFORE_SUBMIT.includes(app.status)) refuse('Documents on a submitted application cannot be removed', 409);
    if (!isId(String(docId))) refuse('Document not found', 404);
    const { rows } = await pool.query(
        `DELETE FROM "${AdmissionDocument.tableName}" WHERE "_id" = $1 AND "application" = $2 AND "school" = $3 AND "current" RETURNING *`,
        [String(docId), String(app._id), String(app.school)]);
    if (!rows[0]) refuse('Document not found', 404);
    fileStore.remove(rows[0].file);
    events.recordQuietly(app.school, { application: app._id, by: req, type: 'document', action: 'removed', message: `${rows[0].originalName || rows[0].docKey} removed` });
    return rows[0];
}

// ── Reviewing ────────────────────────────────────────────────────────────────

/**
 * Verify, reject or ask again for a document. `reason` is required for the
 * last two and is what the family is told.
 */
async function review(doc, { decision, reason = '', note = '' }, req) {
    const status = { verify: 'verified', reject: 'rejected', resubmit: 'resubmission_required' }[decision];
    if (!status) refuse('Choose verify, reject or ask to upload again');
    if (!doc.current) refuse('A newer copy of this document has been uploaded — review that one', 409);
    const why = String(reason || '').trim().slice(0, 300);
    if (status !== 'verified' && !why) refuse('Say why, so the family knows what to fix', 400, { field: 'reason' });
    const entry = { status, by: String(req.userId), byName: req.user?.name || '', at: new Date(), note: why || String(note || '').slice(0, 300) };
    const updated = await patch(AdmissionDocument, doc._id, {
        status, reviewedBy: req.userId, reviewedAt: new Date(), rejectionReason: status === 'verified' ? '' : why, reviewNote: String(note || '').slice(0, 300),
    }, { where: { current: true }, push: { history: entry } });
    if (!updated) refuse('A newer copy of this document has been uploaded — review that one', 409);
    return updated;
}

// ── Opening a file ───────────────────────────────────────────────────────────

function send(res, doc, { download = false } = {}) {
    if (!doc.file || !path.join(ROOT, doc.file).startsWith(ROOT + path.sep)) return res.status(404).json({ success: false, message: 'File not found' });
    const safeName = String(doc.originalName || `${doc.docKey}.${path.extname(doc.file).slice(1)}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    res.set('Content-Type', doc.mime || 'application/octet-stream');
    res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${safeName}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    return fileStore.pipeTo(res, doc.file);
}

module.exports = { ROOT, sniff, typesOf, requirements, currentDocs, summarize, refresh, upload, remove, review, send, appliesTo, OPEN_FOR_DOCUMENTS };
