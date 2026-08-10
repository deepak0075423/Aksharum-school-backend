'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  videoStorage — pluggable storage/streaming abstraction for the Video module.
//
//  The spec calls for Amazon S3 with signed URLs, but this repo currently ships
//  local disk uploads (multer) and has no AWS SDK installed. This service hides
//  that behind ONE interface so the controllers never change:
//
//     getUploadTarget()  → where a Super Admin's S3 upload should go
//     getPlaybackUrl()   → a short-lived, authorized URL the player can use
//     parseProvider()    → normalize a YouTube/Vimeo link into {source, id, url}
//     getEmbedUrl()      → privacy-friendly embed URL for youtube/vimeo
//
//  DRIVER selection (env VIDEO_STORAGE_DRIVER):
//    's3'    → presigned PUT for upload + presigned GET for playback
//              (requires @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner and
//               AWS_* / VIDEO_S3_BUCKET env). Lazily required so the app still
//               boots without the SDK.
//    'local' → (default) files served from /uploads with a signed token query
//              string validated by the streaming route. No third-party deps.
//
//  Swapping to a real CDN (CloudFront signed URLs) is a drop-in replacement of
//  getPlaybackUrl() only.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const DRIVER   = process.env.VIDEO_STORAGE_DRIVER || 'local';
const S3_BUCKET= process.env.VIDEO_S3_BUCKET || '';
const S3_REGION= process.env.AWS_REGION || 'ap-south-1';
const CDN_BASE = process.env.VIDEO_CDN_BASE || '';           // e.g. https://cdn.school.app
const URL_TTL  = Number(process.env.VIDEO_URL_TTL || 3600);  // signed-url lifetime (seconds)
const SIGN_SECRET = process.env.VIDEO_SIGN_SECRET || process.env.JWT_SECRET || 'video-dev-secret';

// ── Provider parsing ──────────────────────────────────────────────────────────
const YT_RE = [
    /youtu\.be\/([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/watch\?v=([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/,
];
const VIMEO_RE = [
    /vimeo\.com\/(\d{5,})/,
    /player\.vimeo\.com\/video\/(\d{5,})/,
];

// Turn a raw pasted link into { source, providerId, sourceUrl } or throw.
function parseProvider(rawUrl) {
    const url = String(rawUrl || '').trim();
    for (const re of YT_RE) {
        const m = url.match(re);
        if (m) return { source: 'youtube', providerId: m[1], sourceUrl: url };
    }
    for (const re of VIMEO_RE) {
        const m = url.match(re);
        if (m) return { source: 'vimeo', providerId: m[1], sourceUrl: url };
    }
    return null;
}

// Privacy-enhanced embed URL used by the player iframe.
function getEmbedUrl(video) {
    if (video.source === 'youtube') {
        return `https://www.youtube-nocookie.com/embed/${video.providerId}?rel=0&modestbranding=1`;
    }
    if (video.source === 'vimeo') {
        return `https://player.vimeo.com/video/${video.providerId}?dnt=1`;
    }
    return '';
}

// ── Signed tokens (local driver) ──────────────────────────────────────────────
// HMAC(videoId|userId|exp) so a playback URL is bound to one user + video and
// expires. The streaming route re-computes and compares before serving bytes.
function signLocal({ key, userId, videoId }) {
    const exp = Math.floor(Date.now() / 1000) + URL_TTL;
    const payload = `${videoId}|${userId}|${exp}`;
    const sig = crypto.createHmac('sha256', SIGN_SECRET).update(payload).digest('hex');
    return { exp, sig };
}
function verifyLocal({ userId, videoId, exp, sig }) {
    if (!exp || !sig) return false;
    if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
    const expected = crypto.createHmac('sha256', SIGN_SECRET)
        .update(`${videoId}|${userId}|${exp}`).digest('hex');
    // constant-time compare
    const a = Buffer.from(String(sig)); const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── S3 (lazy) ─────────────────────────────────────────────────────────────────
let _s3 = null, _presign = null, _cmds = null;
function loadS3() {
    if (_s3) return true;
    try {
        const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
        const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
        _s3 = new S3Client({ region: S3_REGION });
        _cmds = { GetObjectCommand, PutObjectCommand };
        _presign = getSignedUrl;
        return true;
    } catch {
        return false; // SDK not installed — caller falls back / errors clearly
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Presigned PUT for a Super Admin S3 upload (returns { uploadUrl, key, bucket }).
async function getUploadTarget({ filename, contentType }) {
    const key = `videos/${new Date().getFullYear()}/${crypto.randomUUID()}-${(filename || 'video.mp4').replace(/[^\w.\-]/g, '_')}`;
    if (DRIVER === 's3' && loadS3()) {
        const cmd = new _cmds.PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType || 'video/mp4' });
        const uploadUrl = await _presign(_s3, cmd, { expiresIn: URL_TTL });
        return { driver: 's3', bucket: S3_BUCKET, key, uploadUrl };
    }
    // local driver: the multipart upload route stores to /uploads/videos and sets s3Key=key
    return { driver: 'local', bucket: '', key, uploadUrl: null };
}

// A short-lived, per-user authorized playback URL for an S3/local video.
// YouTube/Vimeo return their embed URL (authorization is enforced upstream).
async function getPlaybackUrl(video, user) {
    if (video.source === 'youtube' || video.source === 'vimeo') {
        return { type: 'embed', url: getEmbedUrl(video), expiresIn: 0 };
    }
    // s3 / local file
    if (DRIVER === 's3' && video.s3Key && loadS3()) {
        const cmd = new _cmds.GetObjectCommand({ Bucket: video.s3Bucket || S3_BUCKET, Key: video.s3Key });
        const url = await _presign(_s3, cmd, { expiresIn: URL_TTL });
        return { type: 'file', url, expiresIn: URL_TTL };
    }
    // local: build a signed streaming URL the /stream route validates
    const { exp, sig } = signLocal({ key: video.s3Key, userId: String(user._id), videoId: String(video._id) });
    const base = CDN_BASE || '';
    const url = `${base}/api/video/student/stream/${video._id}?exp=${exp}&sig=${sig}`;
    return { type: 'file', url, expiresIn: URL_TTL };
}

module.exports = {
    DRIVER, S3_BUCKET, URL_TTL,
    parseProvider, getEmbedUrl,
    getUploadTarget, getPlaybackUrl,
    signLocal, verifyLocal,
};
