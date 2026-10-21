'use strict';
/**
 * Where admission documents live (Oct 2026): the server's own disk (the
 * default), or a private S3-compatible bucket — the second is what lets the
 * API run on more than one server, or be redeployed without a persistent
 * volume, without families' documents going missing.
 *
 *   ADMISSION_STORAGE=s3   plus the S3_* settings in services/storage/s3.js
 *
 * Keys are the document's `file` column ("<school id>/<uuid>.<ext>"), the same
 * on disk and in the bucket, so scripts/admissionFilesToS3.js can move a
 * school's existing files across without touching a row. Files are always
 * served through the API's own checks — the bucket is never public.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const s3 = require('../storage/s3');

const ROOT = path.join(__dirname, '..', '..', 'uploads', 'admission-docs');

const driver = () => (String(process.env.ADMISSION_STORAGE || '').toLowerCase() === 's3' && s3.config().ready ? 's3' : 'local');

function localPath(key) {
    const abs = path.join(ROOT, String(key));
    if (!abs.startsWith(ROOT + path.sep)) throw Object.assign(new Error('Bad file key'), { status: 404, expose: true });
    return abs;
}

/** Keep the uploaded temp file at `key`. The temp file is gone afterwards either way. */
async function save(tempPath, key, contentType) {
    if (driver() === 's3') {
        try { await s3.putObject(key, await fs.promises.readFile(tempPath), contentType); } finally { fs.promises.unlink(tempPath).catch(() => {}); }
        return;
    }
    const target = localPath(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    try {
        await fs.promises.rename(tempPath, target);
    } catch (e) {
        // A temp file on another disk (/tmp on its own filesystem) cannot be renamed across.
        if (e.code !== 'EXDEV') throw e;
        await fs.promises.copyFile(tempPath, target);
        await fs.promises.unlink(tempPath).catch(() => {});
    }
}

async function remove(key) {
    if (!key) return;
    try {
        if (driver() === 's3') await s3.deleteObject(key);
        else await fs.promises.unlink(localPath(key));
    } catch (e) { if (e.code !== 'ENOENT') console.error('[admission files] remove:', e.message); }
}

/** The whole file, for embedding (a photo on an admit card) — null when missing. */
async function readBuffer(key) {
    if (!key) return null;
    if (driver() === 's3') return s3.getBuffer(key).catch(() => null);
    return fs.promises.readFile(localPath(key)).catch(() => null);
}

/** Copy the file out to a path on this server (the student record's own folder). */
async function copyToFile(key, target) {
    if (driver() === 's3') {
        const buf = await s3.getBuffer(key);
        if (!buf) throw new Error('The document file is missing from storage');
        await fs.promises.writeFile(target, buf);
        return;
    }
    await fs.promises.copyFile(localPath(key), target);
}

/** Send the file in a response whose headers the caller has set. */
async function pipeTo(res, key) {
    if (driver() === 's3') {
        const obj = await s3.getObject(key).catch(() => null);
        if (!obj) { if (!res.headersSent) res.status(404).json({ success: false, message: 'File not found' }); return; }
        if (obj.size) res.set('Content-Length', String(obj.size));
        Readable.fromWeb(obj.body).on('error', () => res.destroy()).pipe(res);
        return;
    }
    const abs = localPath(key);
    res.sendFile(abs, { dotfiles: 'deny' }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ success: false, message: 'File not found' });
    });
}

module.exports = { ROOT, driver, localPath, save, remove, readBuffer, copyToFile, pipeTo };
