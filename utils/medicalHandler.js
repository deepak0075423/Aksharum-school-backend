'use strict';
/**
 * The Medical Room's controllers answer through this: a handler returns its
 * data (or throws), and the envelope, the status and the error code are
 * decided once. A MedicalError (services/medicalRules) carries its own status
 * and code; anything else is a 500 that says what went wrong.
 */
const { MedicalError } = require('../services/medicalRules');

const handle = (fn) => async (req, res) => {
    try {
        const data = await fn(req, res);
        // A handler that streamed its own answer (a PDF) has finished it already.
        if (!res.headersSent && !res.writableEnded) res.json({ success: true, data: data === undefined ? null : data });
    } catch (e) {
        if (res.headersSent) return;
        if (e instanceof MedicalError) {
            const { status, code, message, name, stack, ...extra } = e;
            return res.status(status).json({ success: false, code, message, ...extra });
        }
        if (e?.name === 'MulterError' || /Upload a PDF|Unsupported file type/.test(e?.message || '')) {
            return res.status(400).json({ success: false, code: 'MEDICAL_UPLOAD', message: e.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 10 MB' : e.message });
        }
        console.error('[medical]', req.method, req.originalUrl, e);
        return res.status(500).json({ success: false, message: e?.message || 'Something went wrong' });
    }
};

/** Run a multer middleware inside a handler, so its errors arrive as answers. */
const upload = (mw) => (req, res) => new Promise((resolve, reject) => mw(req, res, (err) => (err ? reject(err) : resolve())));

module.exports = { handle, upload };
