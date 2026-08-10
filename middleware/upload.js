'use strict';
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

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

module.exports = { uploadProfile, uploadDocument, uploadExcel, uploadImage, uploadLeaveDoc, uploadCsv, uploadChat, uploadVideo };
