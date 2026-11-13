'use strict';
/**
 * Video Learning provider — the server's own disk.
 *
 * Files live under uploads/lms-videos, a folder server.js refuses to serve:
 * the only way to a video is /api/video/stream/<token> (controllers/lms/media),
 * which checks the token and the watch session behind it on every request.
 *
 * Needs no credentials, so it works out of the box — on ONE server. Behind a
 * load balancer the disk is not shared between instances; use S3 there.
 * Uploads arrive in numbered chunks, any of which may be sent again.
 */
const fs = require('fs');
const path = require('path');
const { sniff, mp4Duration } = require('../mediaProbe');

const ROOT = path.join(__dirname, '..', '..', '..', 'uploads', 'lms-videos');
const PARTS = path.join(ROOT, '.parts');
const CHUNK = 5 * 1024 * 1024;

/** The absolute path of a storage key — refused if it would leave the folder. */
function pathOf(key) {
    const full = path.resolve(ROOT, String(key || ''));
    if (!key || !full.startsWith(ROOT + path.sep) || full.startsWith(PARTS)) throw new Error('Bad storage key');
    return full;
}

async function stat(key) {
    try { const s = await fs.promises.stat(pathOf(key)); return s.isFile() ? { size: s.size } : null; } catch { return null; }
}

function readerFor(key) {
    const file = pathOf(key);
    return async (offset, length) => {
        const fh = await fs.promises.open(file, 'r');
        try {
            const buf = Buffer.alloc(length);
            const { bytesRead } = await fh.read(buf, 0, length, offset);
            return buf.subarray(0, bytesRead);
        } finally { await fh.close(); }
    };
}

const partDir = (uploadId) => path.join(PARTS, String(uploadId).replace(/[^a-f0-9-]/gi, ''));

module.exports = {
    name: 'local',
    label: 'Server disk',
    kind: 'file',
    uploadMode: 'chunked',
    chunkSize: CHUNK,
    settingsFields: [],
    secretFields: [],
    ROOT,

    status() { return { configured: true, missing: [], notes: ['Files are kept on this server and streamed through the API. Suitable for one server; use S3 with a CDN when there are several.'] }; },

    async check() {
        const probe = path.join(ROOT, `.check-${process.pid}`);
        try {
            await fs.promises.mkdir(ROOT, { recursive: true });
            await fs.promises.writeFile(probe, 'ok');
            await fs.promises.unlink(probe);
            return { ok: true, message: 'The video folder can be written to' };
        } catch (e) { return { ok: false, message: `The video folder cannot be written to: ${e.code || e.message}` }; }
    },

    keyFor(video, filename) {
        const ext = (path.extname(filename || '').toLowerCase().match(/^\.[a-z0-9]{2,5}$/) || ['.mp4'])[0];
        return `${video._id}/source-${Date.now()}${ext}`;
    },

    async createUpload() { return { mode: 'chunked', chunkSize: CHUNK }; },

    /** Store one chunk. Writing the same chunk again replaces it — a retry is safe. */
    async writeChunk(upload, index, buffer) {
        const dir = partDir(upload._id);
        await fs.promises.mkdir(dir, { recursive: true });
        const tmp = path.join(dir, `${index}.tmp-${process.pid}`);
        await fs.promises.writeFile(tmp, buffer);
        await fs.promises.rename(tmp, path.join(dir, String(index)));
    },

    /** Join the chunks into the file. Throws when one is missing or the size is not what was declared. */
    async completeUpload(upload) {
        const dir = partDir(upload._id);
        const target = pathOf(upload.storageKey);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.joining`;
        const out = fs.createWriteStream(tmp);
        try {
            for (let i = 0; i < upload.totalChunks; i++) {
                const part = path.join(dir, String(i));
                if (!fs.existsSync(part)) throw new Error(`Part ${i + 1} of ${upload.totalChunks} did not arrive — upload it again`);
                await new Promise((resolve, reject) => {
                    const rs = fs.createReadStream(part);
                    rs.on('error', reject); rs.on('end', resolve);
                    rs.pipe(out, { end: false });
                });
            }
            await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
        } catch (e) {
            out.destroy();
            await fs.promises.unlink(tmp).catch(() => {});
            throw e;
        }
        const { size } = await fs.promises.stat(tmp);
        if (upload.sizeBytes && size !== upload.sizeBytes) {
            await fs.promises.unlink(tmp).catch(() => {});
            throw new Error(`The file arrived incomplete (${size} of ${upload.sizeBytes} bytes) — upload it again`);
        }
        await fs.promises.rename(tmp, target);
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        return { sizeBytes: size };
    },

    async abortUpload(upload) {
        await fs.promises.rm(partDir(upload._id), { recursive: true, force: true }).catch(() => {});
    },

    stat,

    /** Check the stored file and read its length. No transcoding: the file is streamed as it is. */
    async process(video, { clientDurationSec = 0 } = {}) {
        const info = await stat(video.storageKey);
        if (!info) return { state: 'failed', error: 'The uploaded file is not on the server — upload it again' };
        const read = readerFor(video.storageKey);
        const type = sniff(await read(0, 16));
        if (!type) return { state: 'failed', error: 'The file is not an MP4, MOV or WebM video' };
        let durationSec = type === 'mp4' ? await mp4Duration(read, info.size).catch(() => null) : null;
        if (!durationSec && clientDurationSec > 0) durationSec = clientDurationSec;
        if (!durationSec) return { state: 'failed', error: 'The video\'s length could not be read from the file — enter it on the video and process again' };
        return { state: 'ready', patch: { durationSec, sizeBytes: info.size, playbackKey: video.storageKey, playbackType: 'file' } };
    },

    async playback(video, { token }) {
        return { type: 'file', path: `/video/stream/${token}` };
    },

    /** What the streaming route needs to send bytes: the file's path, size and type. */
    async fileFor(video) {
        const key = video.playbackKey || video.storageKey;
        const info = await stat(key);
        if (!info) return null;
        const ext = path.extname(key).toLowerCase();
        const type = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
        return { path: pathOf(key), size: info.size, contentType: type };
    },

    async remove(video) {
        if (!video?._id) return;
        await fs.promises.rm(path.join(ROOT, String(video._id).replace(/[^a-f0-9-]/gi, '')), { recursive: true, force: true }).catch(() => {});
    },
};
