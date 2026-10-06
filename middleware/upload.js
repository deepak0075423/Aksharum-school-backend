'use strict';
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { checkPhoneFields } = require('./phoneFields');
const { checkText, textOptionsFor, textExempt } = require('./textSafety');

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const diskStorage = (folder) => multer.diskStorage({
    destination(req, file, cb) {
        const dir = path.join(__dirname, '..', 'uploads', folder);
        ensureDir(dir);
        cb(null, dir);
    },
    filename(req, file, cb) {
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${unique}${path.extname(file.originalname)}`);
    },
});

const imageFilter = (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.originalname)
            || /^image\//.test(file.mimetype);
    cb(ok ? null : new Error('Only image files are allowed (JPG, PNG, GIF, WebP, SVG)'), ok);
};

const docFilter = (req, file, cb) => {
    const ok = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|jpg|jpeg|png)$/i.test(file.originalname);
    cb(ok ? null : new Error('Unsupported file type'), ok);
};

const excelFilter = (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only Excel/CSV files allowed'), ok);
};

const chatFilter = (req, file, cb) => {
    const ok = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|jpg|jpeg|png|gif|webp|mp3|mp4|zip)$/i.test(file.originalname);
    cb(ok ? null : new Error('Unsupported file type'), ok);
};

// Video media (local S3-driver fallback). Real deployments upload direct-to-S3
// via a presigned PUT (see services/videoStorage.getUploadTarget); this handles
// the local/dev path.
const videoFilter = (req, file, cb) => {
    const ok = /\.(mp4|webm|mov|m4v|ogg)$/i.test(file.originalname) || /^video\//.test(file.mimetype);
    cb(ok ? null : new Error('Only video files are allowed (MP4, WebM, MOV)'), ok);
};

const uploadProfile  = multer({ storage: diskStorage('profiles'),  fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadDocument = multer({ storage: diskStorage('documents'), fileFilter: docFilter,   limits: { fileSize: 10 * 1024 * 1024 } });
const uploadExcel    = multer({ storage: multer.memoryStorage(),   fileFilter: excelFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadImage    = multer({ storage: diskStorage('images'),    fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadLeaveDoc = multer({ storage: diskStorage('leave-docs'), fileFilter: docFilter,  limits: { fileSize: 5 * 1024 * 1024 } });
const uploadCsv      = multer({ storage: multer.memoryStorage(),   fileFilter: excelFilter, limits: { fileSize: 2 * 1024 * 1024 } });
const uploadChat     = multer({ storage: diskStorage('chat'),      fileFilter: chatFilter,  limits: { fileSize: 10 * 1024 * 1024 } });
const uploadVideo    = multer({ storage: diskStorage('videos'),    fileFilter: videoFilter, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2 GB

// Staff paperwork: Aadhaar / PAN scans, experience, resignation & joining letters
const uploadStaffDoc = multer({ storage: diskStorage('staff-docs'), fileFilter: docFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// Admission paperwork: the student's own certificates plus the parents' /
// guardian's Aadhaar, PAN and passport photos.
const uploadStudentDoc = multer({ storage: diskStorage('student-docs'), fileFilter: docFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// Hostel paperwork: admission documents, undertakings, visitor ID proofs and
// photos, incident/complaint attachments.
const uploadHostelDoc = multer({ storage: diskStorage('hostel-docs'), fileFilter: docFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// Evidence for an attendance correction — a medical certificate, a note from home.
const uploadAttendanceDoc = multer({ storage: diskStorage('attendance-docs'), fileFilter: docFilter, limits: { fileSize: 5 * 1024 * 1024, files: 3 } });

// Medical Room files — prescriptions, certificates, reports, injury photos.
// Saved under uploads/medical-docs, which server.js does NOT serve: they are
// read through /api/medical/files (controllers/medicalFiles) after an access
// check. No SVG: a drawing can carry script, and these open in the browser.
const medicalFilter = (req, file, cb) => {
    const ok = /\.(pdf|jpg|jpeg|png|webp|doc|docx)$/i.test(file.originalname);
    cb(ok ? null : new Error('Upload a PDF, a photo (JPG, PNG, WebP) or a Word document'), ok);
};
const uploadMedicalDoc = multer({ storage: diskStorage('medical-docs'), fileFilter: medicalFilter, limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * A multipart form's text fields only exist once multer has read it, so the
 * rules server.js applies to every other body — phone numbers
 * (middleware/phoneFields), English text without markup (middleware/
 * textSafety) — are applied here, straight after. A refusal goes on as a 400
 * error — some handlers run these by hand and wait on next() — and takes the
 * files it brought with it.
 */
const withPhoneCheck = (instance) => {
    for (const kind of ['single', 'array', 'fields', 'none', 'any']) {
        const make = instance[kind].bind(instance);
        instance[kind] = (...args) => {
            const read = make(...args);
            return (req, res, next) => read(req, res, (err) => {
                if (err) return next(err);
                const phoneBad = checkPhoneFields(req.body);
                const textBad = phoneBad ? null : (textExempt(req) ? null : checkText(req.body, textOptionsFor(req)));
                const bad = phoneBad || textBad;
                if (!bad) return next();
                const files = [req.file, ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat())];
                for (const f of files) if (f?.path) fs.promises.unlink(f.path).catch(() => {});
                const refusal = new Error(bad);
                refusal.status = 400;
                refusal.code = phoneBad ? 'INVALID_PHONE' : 'INVALID_TEXT';
                return next(refusal);
            });
        };
    }
    return instance;
};
[uploadProfile, uploadDocument, uploadExcel, uploadImage, uploadLeaveDoc, uploadCsv, uploadChat, uploadVideo,
    uploadStaffDoc, uploadStudentDoc, uploadHostelDoc, uploadAttendanceDoc, uploadMedicalDoc].forEach(withPhoneCheck);

module.exports = { uploadMedicalDoc, uploadAttendanceDoc, uploadProfile, uploadDocument, uploadExcel, uploadImage, uploadLeaveDoc, uploadCsv, uploadChat, uploadVideo, uploadStaffDoc, uploadStudentDoc, uploadHostelDoc };
