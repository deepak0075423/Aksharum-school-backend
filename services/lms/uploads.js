'use strict';
/**
 * Video Learning — getting a video file into storage.
 *
 *   1. init      the file's name, size and type are checked; the video's
 *                provider says how the bytes travel:
 *                  chunked  numbered parts sent to this API (local disk) —
 *                           a part that fails is simply sent again, and
 *                           /status says which have arrived, so an upload
 *                           interrupted half-way resumes instead of restarting
 *                  direct   one pre-signed PUT straight to the bucket (S3)
 *   2. complete  the provider confirms the whole file is really there, at the
 *                size declared; only then is the video queued for processing
 *                (services/lms/jobs). Nothing is ever marked uploaded on the
 *                browser's word alone.
 *
 * A video becomes mappable only when processing ends in `ready`.
 */
const path = require('path');
const { q, M, T, bad, notFound, conflict, str, id } = require('./common');
const providers = require('./providers');
const settings = require('./settings');
const jobs = require('./jobs');

const EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm'];
const EXPIRES_HOURS = 24;

async function openUpload(uploadId) {
    const up = await M.upload.findById(id(uploadId, 'Upload')).lean();
    if (!up) throw notFound('Upload');
    if (up.status !== 'open') throw conflict(`This upload is ${up.status}. Start a new one.`, 'UPLOAD_CLOSED');
    if (up.expiresAt && new Date(up.expiresAt) < new Date()) {
        await M.upload.updateOne({ _id: up._id }, { $set: { status: 'aborted', error: 'Expired' } });
        throw conflict('This upload has expired. Start a new one.', 'UPLOAD_EXPIRED');
    }
    return up;
}

async function init(videoId, body, userId) {
    const video = await M.video.findById(id(videoId)).lean();
    if (!video) throw notFound('Video');
    const { provider, cfg } = await providers.ready(video.provider);
    if (provider.kind !== 'file') throw bad(`A ${provider.label} video is linked by its address — it has no file to upload`);
    if (!['draft', 'uploading', 'failed'].includes(video.processingStatus)) {
        throw conflict('This video already has its file. To use a different file, add a new video.', 'ALREADY_UPLOADED');
    }
    const filename = path.basename(str(body.filename, 200));
    const ext = path.extname(filename).toLowerCase();
    if (!EXTENSIONS.includes(ext)) throw bad(`Upload an MP4, M4V, MOV or WebM file (this one is "${ext || 'unknown'}")`, 'BAD_FILE_TYPE');
    const mimeType = str(body.mimeType, 80).toLowerCase() || 'video/mp4';
    if (!/^video\/[a-z0-9.+-]+$/.test(mimeType) && mimeType !== 'application/octet-stream') throw bad('The file is not a video', 'BAD_FILE_TYPE');
    const sizeBytes = Number(body.sizeBytes);
    const { maxUploadMb } = await settings.platform();
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw bad('The file is empty');
    if (sizeBytes > maxUploadMb * 1024 * 1024) throw bad(`The file is larger than the ${maxUploadMb} MB limit`, 'FILE_TOO_LARGE');
    const clientDurationSec = Number(body.durationSec) > 0 && Number(body.durationSec) < 6 * 3600 ? Math.round(Number(body.durationSec) * 100) / 100 : 0;

    // One upload at a time per video: an earlier attempt is closed and its parts dropped.
    for (const old of await M.upload.find({ video: video._id, status: 'open' }).lean()) {
        await provider.abortUpload(old, cfg).catch(() => {});
        await M.upload.updateOne({ _id: old._id }, { $set: { status: 'aborted', error: 'Replaced by a new upload' } });
    }

    const chunkSize = provider.uploadMode === 'chunked' ? provider.chunkSize : 0;
    const upload = await M.upload.create({
        video: video._id, provider: provider.name, mode: provider.uploadMode, filename, mimeType, sizeBytes,
        chunkSize, totalChunks: chunkSize ? Math.ceil(sizeBytes / chunkSize) : 0, receivedChunks: [],
        storageKey: provider.keyFor(video, filename, cfg), clientDurationSec,
        status: 'open', expiresAt: new Date(Date.now() + EXPIRES_HOURS * 3600 * 1000), createdBy: userId,
    });
    const target = await provider.createUpload(upload.toObject ? upload.toObject() : upload, cfg);
    await M.video.updateOne({ _id: video._id }, { $set: { processingStatus: 'uploading', processingError: '', originalFilename: filename, mimeType, updatedBy: userId } });
    return {
        uploadId: upload._id, mode: upload.mode, chunkSize, totalChunks: upload.totalChunks,
        direct: target.direct || null, expiresAt: upload.expiresAt,
    };
}

/** One part of a chunked upload. Sending the same part again replaces it. */
async function chunk(uploadId, index, buffer) {
    const up = await openUpload(uploadId);
    if (up.mode !== 'chunked') throw bad('This upload does not take parts');
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= up.totalChunks) throw bad('That part number is out of range');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw bad('The part is empty');
    const expected = i === up.totalChunks - 1 ? up.sizeBytes - up.chunkSize * (up.totalChunks - 1) : up.chunkSize;
    if (buffer.length !== expected) throw bad(`Part ${i + 1} should be ${expected} bytes, and ${buffer.length} arrived — send it again`, 'BAD_CHUNK');
    const { provider } = await providers.ready(up.provider);
    await provider.writeChunk(up, i, buffer);
    const [row] = await q(`
        UPDATE ${T.upload} SET "updatedAt" = now(), "receivedChunks" = (
                SELECT COALESCE(jsonb_agg(DISTINCT x ORDER BY x), '[]'::jsonb)
                  FROM jsonb_array_elements(COALESCE("receivedChunks", '[]'::jsonb) || to_jsonb($2::int)) AS x)
         WHERE "_id" = $1 RETURNING "receivedChunks"`, [up._id, i]);
    return { received: row.receivedChunks.length, totalChunks: up.totalChunks, receivedChunks: row.receivedChunks };
}

async function status(uploadId) {
    const up = await M.upload.findById(id(uploadId, 'Upload')).lean();
    if (!up) throw notFound('Upload');
    return { uploadId: up._id, status: up.status, mode: up.mode, chunkSize: up.chunkSize, totalChunks: up.totalChunks, receivedChunks: up.receivedChunks || [], error: up.error || '' };
}

/** The file is all there: confirm it with the provider, then queue the video for processing. */
async function complete(uploadId, userId) {
    const up = await openUpload(uploadId);
    const { provider, cfg } = await providers.ready(up.provider);
    if (up.mode === 'chunked') {
        const got = new Set(up.receivedChunks || []);
        const missing = [];
        for (let i = 0; i < up.totalChunks; i++) if (!got.has(i)) missing.push(i);
        if (missing.length) throw conflict(`${missing.length} part(s) have not arrived yet — send them and complete again`, 'CHUNKS_MISSING', { missing });
    }
    let done;
    try {
        done = await provider.completeUpload(up, cfg);
    } catch (e) {
        // The file did not arrive whole. The upload stays open so it can be retried.
        throw conflict(e.message, 'UPLOAD_INCOMPLETE');
    }
    await M.upload.updateOne({ _id: up._id }, { $set: { status: 'completed' } });
    await M.video.updateOne({ _id: up.video }, { $set: {
        storageKey: up.storageKey, sizeBytes: done.sizeBytes, uploadedAt: new Date(),
        processingStatus: 'queued', processingError: '', updatedBy: userId,
    } });
    await jobs.enqueue(up.video, { clientDurationSec: up.clientDurationSec || 0 });
    return { videoId: up.video, processingStatus: 'queued' };
}

async function abort(uploadId) {
    const up = await M.upload.findById(id(uploadId, 'Upload')).lean();
    if (!up) throw notFound('Upload');
    if (up.status !== 'open') return { aborted: false };
    const { provider, cfg } = await providers.ready(up.provider).catch(() => ({}));
    if (provider) await provider.abortUpload(up, cfg).catch(() => {});
    await M.upload.updateOne({ _id: up._id }, { $set: { status: 'aborted', error: 'Cancelled' } });
    // Back to a draft, unless a file from an earlier upload is already in place.
    await q(`UPDATE ${T.video} SET "processingStatus" = 'draft', "updatedAt" = now() WHERE "_id" = $1 AND "processingStatus" = 'uploading'`, [up.video]);
    return { aborted: true };
}

/** Uploads nobody finished: closed, and their parts removed. Run by the sweep. */
async function expireStale() {
    const stale = await M.upload.find({ status: 'open', expiresAt: { $lt: new Date() } }).lean();
    for (const up of stale) {
        try {
            const provider = providers.get(up.provider);
            await provider.abortUpload(up, await providers.config(up.provider)).catch(() => {});
        } catch { /* provider gone */ }
        await M.upload.updateOne({ _id: up._id }, { $set: { status: 'aborted', error: 'Expired' } });
        await q(`UPDATE ${T.video} SET "processingStatus" = 'failed', "processingError" = 'The upload was not finished. Upload the file again.', "updatedAt" = now()
                  WHERE "_id" = $1 AND "processingStatus" = 'uploading'`, [up.video]);
    }
    return stale.length;
}

module.exports = { init, chunk, status, complete, abort, expireStale, EXTENSIONS };
