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

// The Documents module: what a school shares and what students hand in. A
// phone photographs homework as HEIC or WebP as often as JPEG, so those are
// taken too. What a file really is gets checked after the upload
// (services/documentAccess.checkUploads) — this reads the name alone.
const DOCUMENT_TYPES = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
const sharedDocFilter = (req, file, cb) => {
    const ok = new RegExp(`\\.(${DOCUMENT_TYPES.join('|')})$`, 'i').test(file.originalname);
    cb(ok ? null : new Error(`${file.originalname} cannot be attached — use a PDF, a Word, Excel or PowerPoint file, a text file or a photo`), ok);
};

// What a student hands in for an assignment is a PDF and nothing else (Nov
// 2026) — one kind of file every teacher can open, mark and print the same
// way. A teacher's or the office's own attachments still take every kind
// above. Read off the name here; checkUploads then checks it really IS a PDF.
const submissionFilter = (req, file, cb) => {
    const ok = /\.pdf$/i.test(file.originalname);
    cb(ok ? null : Object.assign(new Error(`${file.originalname} is not a PDF — assignments are handed in as PDF files only`), { status: 400, code: 'NOT_PDF' }), ok);
};

const excelFilter = (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only Excel/CSV files allowed'), ok);
};

const chatFilter = (req, file, cb) => {
    const ok = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|jpg|jpeg|png|gif|webp|mp3|mp4|zip)$/i.test(file.originalname);
    cb(ok ? null : new Error('Unsupported file type'), ok);
};

// Video media for the old flat video module (retired Nov 2026 — Video Learning
// uploads now go through services/lms/uploads). Kept so nothing that imports
// it breaks.
const videoFilter = (req, file, cb) => {
    const ok = /\.(mp4|webm|mov|m4v|ogg)$/i.test(file.originalname) || /^video\//.test(file.mimetype);
    cb(ok ? null : new Error('Only video files are allowed (MP4, WebM, MOV)'), ok);
};

const uploadProfile  = multer({ storage: diskStorage('profiles'),  fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadDocument = multer({ storage: diskStorage('documents'), fileFilter: sharedDocFilter, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadSubmission = multer({ storage: diskStorage('documents'), fileFilter: submissionFilter, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadExcel    = multer({ storage: multer.memoryStorage(),   fileFilter: excelFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadImage    = multer({ storage: diskStorage('images'),    fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadLeaveDoc = multer({ storage: diskStorage('leave-docs'), fileFilter: docFilter,  limits: { fileSize: 5 * 1024 * 1024 } });
const uploadCsv      = multer({ storage: multer.memoryStorage(),   fileFilter: excelFilter, limits: { fileSize: 2 * 1024 * 1024 } });
const uploadChat     = multer({ storage: diskStorage('chat'),      fileFilter: chatFilter,  limits: { fileSize: 10 * 1024 * 1024 } });
const uploadVideo    = multer({ storage: diskStorage('videos'),    fileFilter: videoFilter, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2 GB

// Staff paperwork: Aadhaar / PAN scans, experience, resignation & joining letters
// Identity and record scans — Aadhaar, PAN, certificates, letters — for staff
// and students: a PDF or a photo, nothing else (Nov 2026). They are reviewed on
// screen (Verification draws <img>/<iframe>), and docFilter let an Excel sheet
// or a Word file into the Aadhaar slot. Leave, hostel and attendance papers
// keep docFilter.
const SCAN_TYPES = /\.(pdf|jpe?g|png)$/i;
const scanFilter = (req, file, cb) => {
    const ok = SCAN_TYPES.test(file.originalname || '');
    cb(ok ? null : Object.assign(
        new Error(`${file.originalname} cannot be uploaded — use a PDF or an image (JPG or PNG)`),
        { status: 400, code: 'BAD_FILE_TYPE' },
    ), ok);
};

const uploadStaffDoc = multer({ storage: diskStorage('staff-docs'), fileFilter: scanFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// Admission paperwork: the student's own certificates plus the parents' /
// guardian's Aadhaar, PAN and passport photos.
//
// A PHOTO slot (the student's, and each parent's) takes a picture only (Nov
// 2026): a PDF in it became the student's profile picture, and every list then
// asked the browser to draw a PDF as an image — blocked cross-origin (CORB), a
// broken avatar. A document is refused by its name; the phone app's image
// picker may send a picture with no precise type, so the type alone decides
// nothing unless it says image.
const PHOTO_FIELD = /^(photo|fatherPhoto|motherPhoto|guardianPhoto)$/;
const studentDocFilter = (req, file, cb) => {
    if (!PHOTO_FIELD.test(file.fieldname)) return scanFilter(req, file, cb);
    const named = /\.(jpe?g|png|webp)$/i.test(file.originalname);
    const typed = /^image\//.test(file.mimetype || '');
    const document = /\.(pdf|docx?|xlsx?|pptx?|txt)$/i.test(file.originalname);
    const ok = !document && (named || typed);
    cb(ok ? null : Object.assign(new Error('A photo must be a picture — upload a JPG, PNG or WebP image, not a document.'), { status: 400 }), ok);
};
const uploadStudentDoc = multer({ storage: diskStorage('student-docs'), fileFilter: studentDocFilter, limits: { fileSize: 5 * 1024 * 1024 } });

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

// Admission papers uploaded from the public admission portal — birth
// certificates, report cards, photos. Saved under uploads/admission-docs,
// which server.js does NOT serve: they are streamed by the admission API after
// an ownership check, and their content is checked against the type they claim
// (services/admission/documents.js). The per-document-type size and format
// limits are applied there too; this is the ceiling.
const admissionFilter = (req, file, cb) => {
    const ok = /\.(pdf|jpg|jpeg|png|webp)$/i.test(file.originalname);
    cb(ok ? null : Object.assign(new Error('Upload a PDF or a photo (JPG, PNG, WebP)'), { status: 400 }), ok);
};
const uploadAdmissionDoc = multer({ storage: diskStorage('admission-docs'), fileFilter: admissionFilter, limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

// Video Learning pictures — book covers, chapter and video thumbnails. Public
// (uploads/lms-images): they are drawn on every card. No SVG: it can carry script.
const lmsImageFilter = (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|webp)$/i.test(file.originalname) && /^image\/(jpeg|png|webp)$/.test(file.mimetype);
    cb(ok ? null : Object.assign(new Error('Upload a JPG, PNG or WebP picture'), { status: 400 }), ok);
};
const uploadLmsImage = multer({ storage: diskStorage('lms-images'), fileFilter: lmsImageFilter, limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

// What a school attaches to a book request — a photo of the cover, a book
// list. Saved under uploads/lms-requests, which server.js does NOT serve: read
// through /api/video after a check that the reader may see the request.
const lmsRequestFilter = (req, file, cb) => {
    const ok = /\.(pdf|jpg|jpeg|png|webp)$/i.test(file.originalname);
    cb(ok ? null : Object.assign(new Error('Attach a PDF or a photo (JPG, PNG, WebP)'), { status: 400 }), ok);
};
const uploadLmsRequestDoc = multer({ storage: diskStorage('lms-requests'), fileFilter: lmsRequestFilter, limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

// Aptitude exam pictures — a screenshot of a question, a diagram, a picture as
// an option (Nov 2026). Public (uploads/exam-images) because every paper draws
// them, but each is named by a random UUID, so an address cannot be guessed
// before the exam hands it out. No SVG: a drawing can carry script. The name
// is the server's own — the questions refuse any picture address that is not
// one of these (services/aptitudeExam.checkQuestion).
const examImageStorage = multer.diskStorage({
    destination(req, file, cb) {
        const dir = path.join(__dirname, '..', 'uploads', 'exam-images');
        ensureDir(dir);
        cb(null, dir);
    },
    filename(req, file, cb) {
        const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[file.mimetype]
            || (path.extname(file.originalname || '').toLowerCase().match(/^\.(png|jpe?g|webp|gif)$/)?.[0] ?? '.png');
        cb(null, `${require('crypto').randomUUID()}${ext}`);
    },
});
const examImageFilter = (req, file, cb) => {
    // A pasted screenshot arrives as "image.png" or with no name at all — the type decides.
    const ok = /^image\/(png|jpeg|webp|gif)$/.test(file.mimetype || '')
        && !/\.(svg|svgz|html?|js)$/i.test(file.originalname || '');
    cb(ok ? null : Object.assign(new Error('Upload a picture — PNG, JPG, WebP or GIF'), { status: 400 }), ok);
};
const uploadExamImage = multer({ storage: examImageStorage, fileFilter: examImageFilter, limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

/**
 * A multipart form's text fields only exist once multer has read it, so the
 * rules server.js applies to every other body — phone numbers
 * (middleware/phoneFields), English text without markup (middleware/
 * textSafety) — are applied here, straight after. A refusal goes on as a 400
 * error — some handlers run these by hand and wait on next() — and takes the
 * files it brought with it.
 */
/**
 * A file the upload would not take is the sender's to fix, not a server
 * fault: it used to go out as a 500 with multer's own words ("File too
 * large"), which every screen showed as an error in the app.
 */
const UPLOAD_WORDS = {
    LIMIT_FILE_SIZE: 'One of the files is too large to attach',
    LIMIT_FILE_COUNT: 'Too many files were attached',
    LIMIT_UNEXPECTED_FILE: 'Too many files were attached',
    LIMIT_PART_COUNT: 'Too much was attached',
    LIMIT_FIELD_VALUE: 'One of the fields is too long',
};
function uploadRefusal(err) {
    if (!err || err.status) return err;
    if (err instanceof multer.MulterError) {
        err.message = UPLOAD_WORDS[err.code] || err.message;
        err.status = 400;
        err.code = err.code || 'UPLOAD_REFUSED';
    } else if (/unsupported file type|cannot be attached|only .* (allowed|files)|upload a |attach a /i.test(err.message || '')) {
        // The file filters above refuse with a plain Error.
        err.status = 400;
        err.code = 'UNSUPPORTED_FILE';
    }
    return err;
}

const withPhoneCheck = (instance) => {
    for (const kind of ['single', 'array', 'fields', 'none', 'any']) {
        const make = instance[kind].bind(instance);
        instance[kind] = (...args) => {
            const read = make(...args);
            return (req, res, next) => read(req, res, (err) => {
                if (err) return next(uploadRefusal(err));
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
[uploadProfile, uploadDocument, uploadSubmission, uploadExcel, uploadImage, uploadLeaveDoc, uploadCsv, uploadChat, uploadVideo,
    uploadStaffDoc, uploadStudentDoc, uploadHostelDoc, uploadAttendanceDoc, uploadMedicalDoc, uploadAdmissionDoc, uploadLmsImage, uploadLmsRequestDoc, uploadExamImage].forEach(withPhoneCheck);

module.exports = { DOCUMENT_TYPES, uploadExamImage, uploadSubmission, uploadLmsImage, uploadLmsRequestDoc, uploadAdmissionDoc, uploadMedicalDoc, uploadAttendanceDoc, uploadProfile, uploadDocument, uploadExcel, uploadImage, uploadLeaveDoc, uploadCsv, uploadChat, uploadVideo, uploadStaffDoc, uploadStudentDoc, uploadHostelDoc };
