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
// Confirmed and enrolled too (Nov 2026): a transfer certificate, a medical
// form, a caste certificate often arrive after the seat is confirmed — there
// was nowhere to put one.
const OPEN_FOR_DOCUMENTS = ['draft', 'incomplete', 'submitted', 'under_review', 'documents_pending', 'documents_rejected', 'verified', 'eligible',
    'exam_scheduled', 'exam_completed', 'interview_scheduled', 'interview_completed', 'evaluated', 'selected', 'waitlisted', 'offer_issued', 'accepted', 'payment_pending',
    'offer_expired', 'confirmed', 'enrolled'];

// ── What a photo says about where it was taken ───────────────────────────────

const TIFF_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/**
 * A JPEG with the place it was taken removed: the GPS block of its EXIF data
 * is blanked (the entries and the coordinates they point at), and any XMP
 * packet — which repeats the same facts — is dropped. Everything else stays,
 * the orientation above all, so the picture still shows the right way up.
 * A phone photo of a birth certificate otherwise carries the family's home
 * coordinates to everyone who opens it. Returns the same buffer when there is
 * nothing to remove, or when the file is not shaped as expected (left alone).
 */
function stripLocation(buf) {
    try {
        if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
        const keep = [buf.slice(0, 2)];
        let changed = false;
        let i = 2;
        while (i + 4 <= buf.length) {
            if (buf[i] !== 0xff) return changed ? Buffer.concat([...keep, buf.slice(i)]) : buf;
            const marker = buf[i + 1];
            if (marker === 0xda || marker === 0xd9) break;             // image data from here on
            if (marker >= 0xd0 && marker <= 0xd7) { keep.push(buf.slice(i, i + 2)); i += 2; continue; }
            const len = buf.readUInt16BE(i + 2);
            if (len < 2 || i + 2 + len > buf.length) return buf;
            let seg = buf.slice(i, i + 2 + len);
            if (marker === 0xe1) {
                const head = seg.slice(4, 33).toString('latin1');
                if (head.startsWith('http://ns.adobe.com/xap/1.0/') || head.startsWith('http://ns.adobe.com/xmp/extension/')) { changed = true; i += 2 + len; continue; }
                if (head.startsWith('Exif\0\0')) {
                    const copy = Buffer.from(seg);
                    if (blankGps(copy.subarray(10))) { seg = copy; changed = true; }
                }
            }
            keep.push(seg);
            i += 2 + len;
        }
        return changed ? Buffer.concat([...keep, buf.slice(i)]) : buf;
    } catch { return buf; }
}

/** Blank the GPS IFD of a TIFF block in place. True when something was blanked. */
function blankGps(tiff) {
    if (tiff.length < 8) return false;
    const order = tiff.slice(0, 2).toString('latin1');
    if (order !== 'II' && order !== 'MM') return false;
    const le = order === 'II';
    const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    const ifd0 = u32(4);
    if (ifd0 + 2 > tiff.length) return false;
    const n = u16(ifd0);
    let done = false;
    for (let k = 0; k < n; k++) {
        const e = ifd0 + 2 + k * 12;
        if (e + 12 > tiff.length) break;
        if (u16(e) !== 0x8825) continue;
        const gps = u32(e + 8);
        if (gps + 2 > tiff.length) break;
        const count = u16(gps);
        for (let j = 0; j < count; j++) {
            const g = gps + 2 + j * 12;
            if (g + 12 > tiff.length) break;
            const size = (TIFF_SIZE[u16(g + 2)] || 0) * u32(g + 4);
            if (size > 4) { const at = u32(g + 8); if (at + size <= tiff.length) tiff.fill(0, at, at + size); }
            tiff.fill(0, g, g + 12);
        }
        tiff.fill(0, gps, gps + 2);     // an empty GPS block
        done = true;
    }
    return done;
}

async function stripLocationOfFile(filePath) {
    const before = await fs.promises.readFile(filePath);
    const after = stripLocation(before);
    if (after !== before) await fs.promises.writeFile(filePath, after);
    return after !== before;
}

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

        // A photo taken on a phone says where: that part is removed before the file is kept.
        if (EXT_KINDS[ext] === 'jpeg' && await stripLocationOfFile(file.path).catch(() => false)) file.size = (await fs.promises.stat(file.path)).size;
        const sha256 = crypto.createHash('sha256').update(await fs.promises.readFile(file.path)).digest('hex');
        const stored = `${crypto.randomUUID()}.${ext}`;
        const key = `${app.school}/${stored}`;
        await fileStore.save(file.path, key, MIME[ext]);

        const isResubmission = previous && ['rejected', 'resubmission_required'].includes(previous.status);
        // From here the file is in place; if the row cannot be written, it goes.
        const original = file;
        file = { key };
        // A copy replaced on a draft nobody at the school has seen is not a version
        // worth keeping: it goes, file and all (it used to stay for good).
        const dropPrevious = !!previous && app.status === 'draft' && !app.submittedAt;
        const row = await withTransaction(async (q) => {
            if (previous && dropPrevious) {
                await q(`DELETE FROM "${AdmissionDocument.tableName}" WHERE "_id" = $1`, [previous._id]);
            } else if (previous) {
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
        if (dropPrevious && previous.file) fileStore.remove(previous.file);
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

// ── Gates and deadlines ──────────────────────────────────────────────────────

/**
 * The required documents of `gate` this application is still short of — a
 * type's "must be in by" point: 'submission' (uploaded before the form can be
 * submitted), 'before_exam' (verified before an exam is scheduled),
 * 'before_confirmation' (verified before the seat is confirmed). Returns
 * [{ name, problem }]. The first two used to be stored and never checked.
 */
async function gateProblems(app, gate, { schema = null, types = null, docs = null } = {}) {
    const all = types || await typesOf(app.school);
    if (![...all.values()].some((t) => t.gate === gate)) return [];
    const sch = schema || await require('./applications').schemaOf(app);
    const have = new Map((docs || await currentDocs(app._id)).map((d) => [d.docKey, d]));
    const out = [];
    for (const r of requirements(app, sch, all)) {
        if (r.type.gate !== gate || !r.required) continue;
        const d = have.get(r.type.key);
        if (!d) out.push({ name: r.type.name, problem: 'not uploaded' });
        else if (gate !== 'submission' && r.type.verification && d.status !== 'verified') out.push({ name: r.type.name, problem: 'not verified' });
    }
    return out;
}

/**
 * When each document still owed is due: a type's own "days after submission",
 * else the round's document date. Map(docKey → Date|null).
 */
function dueDates(app, reqs, round) {
    const out = new Map();
    for (const r of reqs) {
        const days = Number(r.type.deadlineDays) || 0;
        const base = app.submittedAt ? new Date(app.submittedAt) : null;
        out.set(r.type.key, days && base ? new Date(base.getTime() + days * 86400000) : (round?.documentDeadline ? new Date(round.documentDeadline) : null));
    }
    return out;
}

// ── Files that are not one of the application's documents ────────────────────

/**
 * Keep a supporting file (an appeal's attachment): PDF or a picture, at most
 * 5 MB, really what its name says, virus-scanned like any document. Returns
 * { file, name, size, mime }.
 */
async function keepLooseFile(app, file, { folder = 'files' } = {}) {
    const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
    if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) refuse('Attach a PDF, JPG or PNG', 400, { field: 'file' });
    if (file.size > 5 * 1024 * 1024) refuse('The file must be at most 5 MB', 400, { field: 'file' });
    const fd = await fs.promises.open(file.path, 'r');
    const head = Buffer.alloc(16);
    await fd.read(head, 0, 16, 0);
    await fd.close();
    if (sniff(head) !== EXT_KINDS[ext]) refuse(`The file is not a real ${ext.toUpperCase()} — it may be damaged or renamed`, 400, { field: 'file' });
    const scan = await require('./virusScan').scanFile(file.path);
    if (scan.status === 'infected') refuse('The virus scanner found something harmful in this file, so it was not kept', 422, { code: 'FILE_INFECTED', field: 'file' });
    if (scan.status === 'unavailable' && require('./virusScan').config().required) refuse('Files cannot be checked for viruses just now — please try again in a few minutes', 503, { code: 'SCANNER_UNAVAILABLE' });
    if (EXT_KINDS[ext] === 'jpeg') await stripLocationOfFile(file.path).catch(() => false);
    const size = (await fs.promises.stat(file.path)).size;
    const key = `${app.school}/${folder}/${crypto.randomUUID()}.${ext}`;
    await fileStore.save(file.path, key, MIME[ext]);
    return { file: key, name: String(file.originalname || `file.${ext}`).slice(0, 200), size, mime: MIME[ext] };
}

// ── Files the scanner could not check ────────────────────────────────────────

/**
 * Documents kept while the virus scanner was unreachable are scanned once it
 * answers again (they used to stay "not scanned" for good). One found harmful
 * is taken out of use: marked rejected so the family uploads a clean copy,
 * and the office is told.
 */
async function rescanPending(limit = 25) {
    const scanner = require('./virusScan');
    if (!scanner.config().enabled) return 0;
    const { rows } = await pool.query(
        `SELECT * FROM "${AdmissionDocument.tableName}" WHERE "scanStatus" = 'unavailable' AND "current" ORDER BY "createdAt" ASC LIMIT $1`, [limit]);
    if (!rows.length) return 0;
    const os = require('os');
    let n = 0;
    for (const d of rows) {
        const tmp = path.join(os.tmpdir(), `adm-rescan-${crypto.randomUUID()}`);
        try {
            await fileStore.copyToFile(d.file, tmp);
            const scan = await scanner.scanFile(tmp);
            if (scan.status === 'unavailable') break;           // still down — try again next time
            if (scan.status === 'clean') {
                await pool.query(`UPDATE "${AdmissionDocument.tableName}" SET "scanStatus" = 'clean', "scannedAt" = now() WHERE "_id" = $1`, [d._id]);
            } else if (scan.status === 'infected') {
                const why = 'The virus scanner found something harmful in this file. Please upload a clean copy.';
                await pool.query(
                    `UPDATE "${AdmissionDocument.tableName}" SET "scanStatus" = 'infected', "scannedAt" = now(), "status" = 'rejected', "rejectionReason" = $2, "reviewedAt" = now(), "updatedAt" = now() WHERE "_id" = $1`, [d._id, why]);
                await fileStore.remove(d.file);
                events.recordQuietly(d.school, { application: d.application, type: 'document', action: 'infected', message: `${d.originalName || d.docKey}: the virus scanner found ${scan.signature} — the file was removed`, visibility: 'internal' });
                const { rows: [app] } = await pool.query(`SELECT * FROM "${AdmissionApplication.tableName}" WHERE "_id" = $1`, [d.application]);
                if (app) {
                    await refresh(app, await require('./applications').schemaOf(app)).catch(() => {});
                    require('./staffAlerts').aboutApplication(app, { title: 'A harmful file was removed', body: `${app.applicationNumber || 'An application'}: ${d.originalName || d.docKey} failed the virus scan and was removed. The family needs to upload it again.` });
                    require('./notify').toApplicant(app, 'document_rejected', { document_name: d.originalName || d.docKey, rejection_reason: why, remarks: why });
                }
            }
            n += 1;
        } catch (e) {
            console.error('[admission] rescan:', e.message);
        } finally { fs.promises.unlink(tmp).catch(() => {}); }
    }
    return n;
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

module.exports = {
    ROOT, sniff, typesOf, requirements, currentDocs, summarize, refresh, upload, remove, review, send, appliesTo, OPEN_FOR_DOCUMENTS,
    stripLocation, gateProblems, dueDates, keepLooseFile, rescanPending,
};
