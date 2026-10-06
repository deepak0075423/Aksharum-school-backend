'use strict';
/**
 * Reading a medical file (Oct 2026). See services/medicalFiles for who may.
 *
 *   GET /api/medical/files/:id            with a login. ?link=1 answers with a
 *                                         ten-minute signed link instead of the
 *                                         file, for a preview frame; ?download=1
 *                                         sends it as an attachment
 *   GET /api/medical/file/:id?exp&sig     the signed link itself
 *
 * Every opening is in the medical audit log.
 */
const files = require('../services/medicalFiles');
const audit = require('../services/medicalAudit');
const MedicalDocument = require('../models/MedicalDocument');
const { handle } = require('../utils/medicalHandler');

exports.authed = handle(async (req, res) => {
    const { doc } = await files.readable(req, req.params.id);
    const download = req.query.download === '1';
    // A download is its own entry (views are de-duplicated); with ?link=1 it is
    // recorded when the link is asked for, because the signed link has no login.
    if (download) audit.log(req, { action: 'downloaded', entity: 'document', entityId: doc._id, student: doc.student, summary: `Downloaded document “${doc.title}”` });
    else audit.viewed(req, { entity: 'document', entityId: doc._id, student: doc.student, summary: `Opened document “${doc.title}”` });
    if (req.query.link === '1') return { url: files.signedPath(doc._id), title: doc.title, mime: doc.mime, expiresInMinutes: files.LINK_MINUTES };
    // Waited for, so the envelope in medicalHandler sees the response is sent.
    await files.send(res, doc, { download });
    return undefined;
});

exports.signed = async (req, res) => {
    try {
        if (!files.checkSig(req.params.id, req.query.exp, req.query.sig)) {
            return res.status(403).json({ success: false, message: 'This link has expired — open the document again from the Medical Room' });
        }
        const doc = await MedicalDocument.findOne({ _id: req.params.id }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'File not found' });
        return await files.send(res, doc, { download: req.query.download === '1' });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
};
