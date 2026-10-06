'use strict';
/**
 * Who may open a medical file, and how it reaches them (Oct 2026).
 *
 * The files live in uploads/medical-docs, which server.js refuses to serve.
 * They are read through the API:
 *
 *   GET /api/medical/files/:id          with a login — this decides
 *   GET /api/medical/file/:id?exp&sig   a ten-minute link the API handed to
 *                                       someone it had already checked (an
 *                                       <img> or <iframe> cannot send a login)
 *
 * May read:
 *   medical staff   every file of the school
 *   a parent        their child's files shared with the family, and their own uploads
 *   a student       their own files shared with the family (if the school allows),
 *                   and their own uploads
 *   a teacher       none — prescriptions and reports are not theirs to see
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MedicalDocument = require('../models/MedicalDocument');
const designations = require('./designationService');
const access = require('./medicalAccess');
const settingsSvc = require('./medicalSettings');
const { notFound, isUuid } = require('./medicalRules');

const DIR = path.join(__dirname, '..', 'uploads', 'medical-docs');
const LINK_MINUTES = 10;
const SAFE_TYPES = {
    'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const secret = () => String(process.env.JWT_SECRET || 'medical-files');
const sig = (id, exp) => crypto.createHmac('sha256', secret()).update(`medical:${id}|${exp}`).digest('hex').slice(0, 40);

function signedPath(id) {
    const exp = Date.now() + LINK_MINUTES * 60000;
    return `/medical/file/${encodeURIComponent(String(id))}?exp=${exp}&sig=${sig(String(id), exp)}`;
}

function checkSig(id, exp, given) {
    const until = Number(exp);
    if (!isUuid(id) || !Number.isFinite(until) || until < Date.now()) return false;
    const want = Buffer.from(sig(String(id), until));
    const got = Buffer.from(String(given || ''));
    return want.length === got.length && crypto.timingSafeEqual(want, got);
}

async function isStaff(req) {
    if (req.userRole === 'school_admin') return true;
    if (req.userRole !== 'teacher') return false;
    return designations.isModuleAdmin(req, 'medical');
}

/** The document, if this caller may read it — else "not found" (never "forbidden"). */
async function readable(req, id) {
    if (!isUuid(id)) notFound('File');
    const doc = await MedicalDocument.findOne({ _id: id, school: req.schoolId }).lean();
    if (!doc) notFound('File');
    if (await isStaff(req)) return { doc, staff: true };
    if (doc.archivedAt) notFound('File');
    const own = String(doc.uploadedBy) === String(req.userId);
    if (req.userRole === 'parent' || req.userRole === 'student') {
        const ids = await access.familyIds(req);
        if (!ids.includes(String(doc.student))) notFound('File');
        if (req.userRole === 'student') {
            const s = await settingsSvc.get(req.schoolId);
            if (!s.studentAccess || !s.studentDocuments) notFound('File');
        }
        if (own || (doc.visibility === 'family' && doc.status !== 'rejected')) return { doc, staff: false };
    }
    return notFound('File');
}

/**
 * Stream the file. Returns a promise that settles once the response is done —
 * sendFile works asynchronously, and a caller that returned straight away let
 * the JSON envelope of controllers/medicalHandler answer first: the reader got
 * `{"success":true,"data":null}` labelled as a PDF instead of the document.
 */
function send(res, doc, { download = false } = {}) {
    const file = path.join(DIR, path.basename(doc.storedName));
    if (!fs.existsSync(file)) return Promise.resolve(res.status(404).json({ success: false, message: 'The file is missing from storage' }));
    const type = SAFE_TYPES[doc.mime] ? doc.mime : 'application/octet-stream';
    const ext = SAFE_TYPES[type] || path.extname(doc.storedName).slice(1) || 'bin';
    const base = String(doc.title || 'medical-document').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'medical-document';
    const inline = !download && (type === 'application/pdf' || type.startsWith('image/'));
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${base}.${ext}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    // Only PDFs, images and Word files are ever served as themselves (anything
    // else goes out as an attachment), so no page can run script from here.
    // A PDF gets no CSP: a sandboxed one will not open in Chrome's viewer.
    if (type !== 'application/pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    return new Promise((resolve) => {
        res.sendFile(file, (err) => {
            if (err && !res.headersSent) res.status(err.statusCode || 500).json({ success: false, message: 'The file could not be sent' });
            resolve();
        });
    });
}

module.exports = { DIR, signedPath, checkSig, readable, send, isStaff, LINK_MINUTES };
