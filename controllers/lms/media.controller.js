'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Video Learning — the bytes.
//
//  These routes carry no session token: a <video> element cannot send one.
//  What they carry instead is a playback token in the address
//  (services/lms/playbackToken), and every single request — each range of a
//  file, each playlist — is checked again: the token must be genuine and in
//  date, and for a student its watch session must still be open and recently
//  heard from. Take a release down and the very next range request is refused.
//
//  Nothing here ever redirects to, or reveals, a permanent storage address.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const { M } = require('../../services/lms/common');
const tracking = require('../../services/lms/tracking');
const providers = require('../../services/lms/providers');
const settings = require('../../services/lms/settings');

const refuse = (res, status = 403) => res.status(status).json({ success: false, code: 'PLAYBACK_DENIED', message: 'This video link is no longer valid. Open the video again.' });
const noStore = (res) => { res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); };

/** GET /api/video/stream/:token — a locally stored video, with Range support. */
exports.stream = async (req, res) => {
    try {
        const found = await tracking.resolvePlayback(req.params.token);
        if (!found) return refuse(res);
        const provider = providers.get(found.video.provider);
        if (typeof provider.fileFor !== 'function') return refuse(res, 404);
        const file = await provider.fileFor(found.video);
        if (!file) return refuse(res, 404);
        noStore(res);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', 'inline');
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        let start = 0; let end = file.size - 1;
        if (range) {
            if (range[1] === '' && range[2] !== '') start = Math.max(0, file.size - Number(range[2]));
            else { start = Number(range[1]); if (range[2] !== '') end = Math.min(end, Number(range[2])); }
            if (!(start <= end) || start >= file.size) { res.setHeader('Content-Range', `bytes */${file.size}`); return res.status(416).end(); }
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
        }
        res.setHeader('Content-Length', end - start + 1);
        if (req.method === 'HEAD') return res.end();
        const rs = fs.createReadStream(file.path, { start, end });
        rs.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
        req.on('close', () => rs.destroy());
        return rs.pipe(res);
    } catch (e) {
        console.error('[video] stream failed:', e.message);
        return res.headersSent ? res.end() : res.status(500).json({ success: false, message: 'The video could not be played' });
    }
};

/** GET /api/video/hls/:token/<playlist>.m3u8 — an HLS playlist, rewritten for this viewer. */
exports.hls = async (req, res) => {
    try {
        const found = await tracking.resolvePlayback(req.params.token);
        if (!found || found.video.playbackType !== 'hls') return refuse(res);
        const rel = (Array.isArray(req.params.path) ? req.params.path : [req.params.path]).join('/');
        const { provider, cfg } = await providers.ready(found.video.provider);
        if (typeof provider.hlsPlaylist !== 'function') return refuse(res, 404);
        const { playbackUrlSeconds } = await settings.platform();
        const ttlSec = Math.max(playbackUrlSeconds, Math.round((found.video.durationSec || 0) * 1.5) + 300);
        const text = await provider.hlsPlaylist(found.video, rel, { ttlSec }, cfg);
        if (text === null) return refuse(res, 404);
        noStore(res);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(text);
    } catch (e) {
        console.error('[video] playlist failed:', e.message);
        return res.status(e.status || 500).json({ success: false, message: 'The video could not be played' });
    }
};

/** GET /api/video/media/thumb/:id — the thumbnail processing made for a video (a picture, not the video). */
exports.thumb = async (req, res) => {
    try {
        const video = await M.video.findById(req.params.id, 'provider thumbnailKey thumbnailUrl').lean().catch(() => null);
        if (!video || !video.thumbnailKey) return res.status(404).end();
        const provider = providers.get(video.provider);
        if (typeof provider.thumbnailUrl !== 'function') return res.status(404).end();
        const url = provider.thumbnailUrl(video, await providers.config(video.provider));
        if (!url) return res.status(404).end();
        res.setHeader('Cache-Control', 'private, max-age=1800');
        return res.redirect(302, url);
    } catch { return res.status(404).end(); }
};
