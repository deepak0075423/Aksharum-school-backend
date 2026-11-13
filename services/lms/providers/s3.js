'use strict';
/**
 * Video Learning provider — a PRIVATE S3 bucket, delivered through CloudFront,
 * optionally transcoded to HLS by AWS MediaConvert. Also speaks to the
 * S3-compatible stores (R2, Spaces, MinIO) through the same signer the
 * admission module uses (services/storage/s3) — no AWS SDK.
 *
 *   upload     the browser PUTs the file straight to the bucket with a
 *              pre-signed address good for one hour; no credential ever
 *              reaches it, and the file never passes through this server
 *   process    MediaConvert configured: an HLS ladder (720p / 480p / 360p) and
 *              a thumbnail are made, and the job is polled until it finishes.
 *              Not configured: the uploaded file itself is what is played.
 *   playback   never the bucket's own address. A file gets a signed address
 *              that expires in minutes — CloudFront's when a key pair is set,
 *              S3's own otherwise. HLS playlists are served by the API and
 *              rewritten per viewer (services/lms/hls), each segment signed.
 *
 * Settings (stored, or the environment variable in brackets — which wins):
 *   bucket [VIDEO_S3_BUCKET]   region [VIDEO_S3_REGION]   prefix [VIDEO_S3_PREFIX]
 *   endpoint [VIDEO_S3_ENDPOINT]   forcePathStyle [VIDEO_S3_FORCE_PATH_STYLE]
 *   cdnDomain [VIDEO_CF_DOMAIN]   cdnKeyPairId [VIDEO_CF_KEY_PAIR_ID]
 *   mediaConvertRoleArn [VIDEO_MC_ROLE_ARN]   mediaConvertEndpoint [VIDEO_MC_ENDPOINT]
 *   mediaConvertQueue [VIDEO_MC_QUEUE]
 * Secrets (sealed when stored; never returned by any API):
 *   accessKeyId [VIDEO_S3_ACCESS_KEY_ID]   secretAccessKey [VIDEO_S3_SECRET_ACCESS_KEY]
 *   cdnPrivateKey [VIDEO_CF_PRIVATE_KEY]  (the CloudFront key pair's private key, PEM)
 *
 * The bucket must block all public access. See docs/video-learning.md for the
 * IAM policy, the CORS rule the upload needs, and the CloudFront set-up.
 */
const crypto = require('crypto');
const path = require('path').posix;
const s3 = require('../../storage/s3');
const { sniff, mp4Duration } = require('../mediaProbe');
const { rewriteManifest } = require('../hls');

const truthy = (v) => v === true || /^(1|true|yes)$/i.test(String(v || ''));
const prefixOf = (cfg) => { const p = String(cfg.prefix || 'video-learning').replace(/^\/+|\/+$/g, ''); return p ? `${p}/` : ''; };
const conn = (cfg) => ({ bucket: cfg.bucket, region: cfg.region || 'ap-south-1', endpoint: String(cfg.endpoint || '').replace(/\/+$/, ''), pathStyle: truthy(cfg.forcePathStyle) });
const pem = (v) => String(v || '').replace(/\\n/g, '\n').trim();
const cdnReady = (cfg) => !!(cfg.cdnDomain && cfg.cdnKeyPairId && cfg.cdnPrivateKey);
const convertReady = (cfg) => !!cfg.mediaConvertRoleArn;
const cdnHost = (cfg) => String(cfg.cdnDomain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const encodeKey = (key) => String(key).split('/').map((seg) => s3.encode(seg)).join('/');

async function call(cfg, method, key, { headers = {}, body = null } = {}) {
    const c = conn(cfg);
    const url = s3.objectUrl(c, key);
    const signed = s3.sign({ method, url, headers, body: body || '', region: c.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
    const { _debug, host, ...send } = signed;
    return fetch(url, { method, headers: send, body: body || undefined });
}

async function stat(cfg, key) {
    const r = await call(cfg, 'HEAD', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`The bucket refused the request (HTTP ${r.status})`);
    return { size: Number(r.headers.get('content-length')) || 0 };
}

const readerFor = (cfg, key) => async (offset, length) => {
    const r = await call(cfg, 'GET', key, { headers: { range: `bytes=${offset}-${offset + length - 1}` } });
    if (!r.ok) throw new Error(`The bucket refused a read (HTTP ${r.status})`);
    return Buffer.from(await r.arrayBuffer());
};

async function getText(cfg, key) {
    const r = await call(cfg, 'GET', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`The bucket refused a read (HTTP ${r.status})`);
    return r.text();
}

// ── Signed addresses ─────────────────────────────────────────────────────────

/** CloudFront's own base64: + → -, = → _, / → ~ */
const cfB64 = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

/**
 * The query string that makes a CloudFront address valid until `expiresEpoch`
 * (a custom policy, signed with the key pair's private key). `resource` may
 * end in * — one signature then covers every segment under a folder.
 */
function cloudFrontQuery(cfg, resource, expiresEpoch) {
    const policy = JSON.stringify({ Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': expiresEpoch } } }] });
    const signature = crypto.createSign('RSA-SHA1').update(policy).sign(pem(cfg.cdnPrivateKey));
    return `Policy=${cfB64(Buffer.from(policy))}&Signature=${cfB64(signature)}&Key-Pair-Id=${encodeURIComponent(cfg.cdnKeyPairId)}`;
}

/** A short-lived address for one object: CloudFront's when a key pair is set, S3's own otherwise. */
function signedUrl(cfg, key, ttlSec) {
    if (cdnReady(cfg)) {
        const url = `https://${cdnHost(cfg)}/${encodeKey(key)}`;
        return `${url}?${cloudFrontQuery(cfg, url, Math.floor(Date.now() / 1000) + ttlSec)}`;
    }
    const c = conn(cfg);
    return s3.presign({ method: 'GET', url: s3.objectUrl(c, key), expires: ttlSec, region: c.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
}

// ── MediaConvert ─────────────────────────────────────────────────────────────

const convertBase = (cfg) => String(cfg.mediaConvertEndpoint || `https://mediaconvert.${conn(cfg).region}.amazonaws.com`).replace(/\/+$/, '');

async function convertCall(cfg, method, pathname, body) {
    const url = `${convertBase(cfg)}${pathname}`;
    const payload = body ? JSON.stringify(body) : '';
    const signed = s3.sign({
        method, url, headers: body ? { 'content-type': 'application/json' } : {}, body: payload,
        region: conn(cfg).region, service: 'mediaconvert', accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
    });
    const { _debug, host, ...send } = signed;
    const r = await fetch(url, { method, headers: send, body: payload || undefined });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw new Error(`MediaConvert answered HTTP ${r.status}: ${(json?.message || json?.Message || text || '').slice(0, 200)}`);
    return json;
}

const rung = (height, maxBitrate) => ({
    NameModifier: `_${height}`,
    ContainerSettings: { Container: 'M3U8' },
    VideoDescription: {
        Height: height,
        CodecSettings: { Codec: 'H_264', H264Settings: { RateControlMode: 'QVBR', MaxBitrate: maxBitrate, QvbrSettings: { QvbrQualityLevel: 7 }, SceneChangeDetect: 'TRANSITION_DETECTION' } },
    },
    AudioDescriptions: [{ CodecSettings: { Codec: 'AAC', AacSettings: { Bitrate: 96000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48000 } } }],
});

/** The job that turns the uploaded file into an HLS ladder and one thumbnail. Exported for the tests. */
function convertJob(cfg, video) {
    const bucket = conn(cfg).bucket;
    const base = `${prefixOf(cfg)}${video._id}`;
    return {
        Role: cfg.mediaConvertRoleArn,
        ...(cfg.mediaConvertQueue ? { Queue: cfg.mediaConvertQueue } : {}),
        UserMetadata: { lmsVideo: String(video._id) },
        Settings: {
            Inputs: [{
                FileInput: `s3://${bucket}/${video.storageKey}`,
                AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
                VideoSelector: {},
                TimecodeSource: 'ZEROBASED',
            }],
            OutputGroups: [
                {
                    Name: 'HLS',
                    OutputGroupSettings: { Type: 'HLS_GROUP_SETTINGS', HlsGroupSettings: { SegmentLength: 6, MinSegmentLength: 0, Destination: `s3://${bucket}/${base}/hls/master` } },
                    Outputs: [rung(720, 3000000), rung(480, 1500000), rung(360, 800000)],
                },
                {
                    Name: 'Thumbnail',
                    OutputGroupSettings: { Type: 'FILE_GROUP_SETTINGS', FileGroupSettings: { Destination: `s3://${bucket}/${base}/thumb/thumb` } },
                    Outputs: [{
                        ContainerSettings: { Container: 'RAW' },
                        VideoDescription: { Width: 640, CodecSettings: { Codec: 'FRAME_CAPTURE', FrameCaptureSettings: { FramerateNumerator: 1, FramerateDenominator: 10, MaxCaptures: 1, Quality: 80 } } },
                    }],
                },
            ],
        },
    };
}

module.exports = {
    name: 's3',
    label: 'Amazon S3 + CloudFront',
    kind: 'file',
    uploadMode: 'direct',
    settingsFields: [
        { key: 'bucket', label: 'Bucket', env: 'VIDEO_S3_BUCKET', required: true, help: 'A private bucket — block all public access.' },
        { key: 'region', label: 'Region', env: 'VIDEO_S3_REGION', placeholder: 'ap-south-1' },
        { key: 'prefix', label: 'Folder inside the bucket', env: 'VIDEO_S3_PREFIX', placeholder: 'video-learning' },
        { key: 'endpoint', label: 'Endpoint (S3-compatible stores only)', env: 'VIDEO_S3_ENDPOINT', placeholder: 'https://<account>.r2.cloudflarestorage.com' },
        { key: 'forcePathStyle', label: 'Path-style addresses (MinIO and most self-hosted stores)', env: 'VIDEO_S3_FORCE_PATH_STYLE', type: 'boolean' },
        { key: 'cdnDomain', label: 'CloudFront domain', env: 'VIDEO_CF_DOMAIN', placeholder: 'd111111abcdef8.cloudfront.net', help: 'The distribution in front of the bucket, restricted to signed requests.' },
        { key: 'cdnKeyPairId', label: 'CloudFront key pair id', env: 'VIDEO_CF_KEY_PAIR_ID', placeholder: 'K2JCJMDEHXQW5F' },
        { key: 'mediaConvertRoleArn', label: 'MediaConvert role ARN', env: 'VIDEO_MC_ROLE_ARN', help: 'Set it to have uploads transcoded to HLS. Left empty, the uploaded file is streamed as it is.' },
        { key: 'mediaConvertEndpoint', label: 'MediaConvert endpoint', env: 'VIDEO_MC_ENDPOINT', placeholder: 'Leave empty for the region\'s own' },
        { key: 'mediaConvertQueue', label: 'MediaConvert queue ARN', env: 'VIDEO_MC_QUEUE', placeholder: 'Leave empty for the default queue' },
    ],
    secretFields: [
        { key: 'accessKeyId', label: 'Access key id', env: 'VIDEO_S3_ACCESS_KEY_ID', required: true },
        { key: 'secretAccessKey', label: 'Secret access key', env: 'VIDEO_S3_SECRET_ACCESS_KEY', required: true },
        { key: 'cdnPrivateKey', label: 'CloudFront private key (PEM)', env: 'VIDEO_CF_PRIVATE_KEY', multiline: true },
    ],

    status(cfg) {
        const missing = [];
        if (!cfg.bucket) missing.push('Bucket');
        if (!cfg.accessKeyId) missing.push('Access key id');
        if (!cfg.secretAccessKey) missing.push('Secret access key');
        const cdnParts = [cfg.cdnDomain, cfg.cdnKeyPairId, cfg.cdnPrivateKey].filter(Boolean).length;
        const notes = [];
        if (cdnParts === 3) notes.push('Playback goes through CloudFront with signed addresses.');
        else if (cdnParts === 0) notes.push('No CloudFront key pair is set: playback uses signed addresses on the bucket itself. Add CloudFront for delivery at scale.');
        else { missing.push('CloudFront domain, key pair id and private key (all three, or none)'); }
        notes.push(convertReady(cfg) ? 'Uploads are transcoded to HLS by MediaConvert.' : 'MediaConvert is not set: the uploaded file is streamed as it is (no HLS).');
        return { configured: missing.length === 0, missing, notes };
    },

    /** Write, find and remove a tiny object — proves the keys, the bucket and the region. */
    async check(cfg) {
        const key = `${prefixOf(cfg)}.aksharum-check-${Date.now()}`;
        try {
            const put = await call(cfg, 'PUT', key, { body: Buffer.from('ok'), headers: { 'content-type': 'text/plain' } });
            if (!put.ok) return { ok: false, message: `The bucket refused a write (HTTP ${put.status}). Check the keys, the bucket name and the region.` };
            const found = await stat(cfg, key);
            await call(cfg, 'DELETE', key).catch(() => {});
            if (!found) return { ok: false, message: 'A file written to the bucket could not be read back' };
            if (cdnReady(cfg)) {
                try { cloudFrontQuery(cfg, `https://${cdnHost(cfg)}/x`, Math.floor(Date.now() / 1000) + 60); }
                catch { return { ok: false, message: 'The bucket works, but the CloudFront private key is not a valid PEM key' }; }
            }
            return { ok: true, message: `Connected to bucket ${cfg.bucket}${cdnReady(cfg) ? ', CloudFront signing ready' : ''}${convertReady(cfg) ? ', MediaConvert set' : ''}` };
        } catch (e) { return { ok: false, message: `The bucket could not be reached: ${e.message}` }; }
    },

    keyFor(video, filename, cfg) {
        const ext = (path.extname(filename || '').toLowerCase().match(/^\.[a-z0-9]{2,5}$/) || ['.mp4'])[0];
        return `${prefixOf(cfg)}${video._id}/source-${Date.now()}${ext}`;
    },

    /** Where the browser sends the file: a pre-signed PUT, good for an hour. */
    async createUpload(upload, cfg) {
        const c = conn(cfg);
        const headers = { 'content-type': upload.mimeType || 'video/mp4' };
        const url = s3.presign({ method: 'PUT', url: s3.objectUrl(c, upload.storageKey), expires: 3600, headers, region: c.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
        return { mode: 'direct', direct: { method: 'PUT', url, headers: { 'Content-Type': headers['content-type'] }, expiresIn: 3600 } };
    },

    /** The upload is complete when the object is really there, at the size declared. */
    async completeUpload(upload, cfg) {
        const found = await stat(cfg, upload.storageKey);
        if (!found) throw new Error('The file has not reached the bucket — upload it again');
        if (upload.sizeBytes && found.size !== upload.sizeBytes) throw new Error(`The file arrived incomplete (${found.size} of ${upload.sizeBytes} bytes) — upload it again`);
        return { sizeBytes: found.size };
    },
    async abortUpload(upload, cfg) { await call(cfg, 'DELETE', upload.storageKey).catch(() => {}); },

    stat: (key, cfg) => stat(cfg, key),

    async process(video, { clientDurationSec = 0 } = {}, cfg) {
        const info = await stat(cfg, video.storageKey);
        if (!info) return { state: 'failed', error: 'The uploaded file is not in the bucket — upload it again' };
        const read = readerFor(cfg, video.storageKey);
        const type = sniff(await read(0, 16));
        if (!type) return { state: 'failed', error: 'The file is not an MP4, MOV or WebM video' };
        let durationSec = type === 'mp4' ? await mp4Duration(read, info.size).catch(() => null) : null;
        if (!durationSec && clientDurationSec > 0) durationSec = clientDurationSec;

        if (convertReady(cfg)) {
            const res = await convertCall(cfg, 'POST', '/2017-08-29/jobs', convertJob(cfg, video));
            const jobId = res?.job?.id || res?.Job?.Id;
            if (!jobId) throw new Error('MediaConvert accepted the job but returned no id');
            return { state: 'waiting', externalId: jobId, patch: { sizeBytes: info.size, ...(durationSec ? { durationSec } : {}) } };
        }
        if (!durationSec) return { state: 'failed', error: 'The video\'s length could not be read from the file — enter it on the video and process again' };
        return { state: 'ready', patch: { durationSec, sizeBytes: info.size, playbackKey: video.storageKey, playbackType: 'file' } };
    },

    /** Ask MediaConvert how the job is doing. */
    async poll(video, job, cfg) {
        const res = await convertCall(cfg, 'GET', `/2017-08-29/jobs/${encodeURIComponent(job.externalId)}`);
        const j = res?.job || res?.Job || {};
        const status = String(j.status || j.Status || '').toUpperCase();
        if (status === 'COMPLETE') {
            const base = `${prefixOf(cfg)}${video._id}`;
            const groups = j.outputGroupDetails || j.OutputGroupDetails || [];
            const ms = groups.flatMap((g) => g.outputDetails || g.OutputDetails || []).map((o) => o.durationInMs || o.DurationInMs).find(Boolean);
            const thumbKey = `${base}/thumb/thumb.0000000.jpg`;
            const hasThumb = await stat(cfg, thumbKey).catch(() => null);
            const durationSec = ms ? Math.round(ms / 10) / 100 : video.durationSec;
            if (!durationSec) return { state: 'failed', error: 'The video was transcoded but its length is unknown — enter it on the video and process again' };
            return { state: 'ready', patch: { playbackKey: `${base}/hls/master.m3u8`, playbackType: 'hls', durationSec, ...(hasThumb ? { thumbnailKey: thumbKey } : {}) } };
        }
        if (status === 'ERROR' || status === 'CANCELED') return { state: 'failed', error: `MediaConvert: ${j.errorMessage || j.ErrorMessage || status.toLowerCase()}` };
        return { state: 'waiting', externalId: job.externalId };
    },

    async playback(video, { token, ttlSec }, cfg) {
        if (video.playbackType === 'hls') return { type: 'hls', path: `/video/hls/${token}/master.m3u8` };
        return { type: 'file', url: signedUrl(cfg, video.playbackKey || video.storageKey, ttlSec), expiresIn: ttlSec };
    },

    /**
     * One HLS playlist of the video, rewritten for this viewer: other playlists
     * stay relative (they come back through the API), segments are signed and
     * go straight to the CDN. `rel` is the playlist's path inside the video's
     * HLS folder. Returns null when there is no such playlist.
     */
    async hlsPlaylist(video, rel, { ttlSec }, cfg) {
        const root = path.dirname(video.playbackKey);                     // …/<video>/hls
        const key = path.normalize(path.join(root, rel));
        if (!key.startsWith(`${root}/`) || !/\.m3u8$/i.test(key)) return null;
        const text = await getText(cfg, key);
        if (text === null) return null;
        const baseDir = path.dirname(rel) === '.' ? '' : path.dirname(rel);
        const depth = baseDir ? baseDir.split('/').length : 0;
        let wildcard = null;
        if (cdnReady(cfg)) {
            // One signature for every segment of this video.
            wildcard = cloudFrontQuery(cfg, `https://${cdnHost(cfg)}/${encodeKey(root)}/*`, Math.floor(Date.now() / 1000) + ttlSec);
        }
        const signSegment = (segRel) => {
            const segKey = `${root}/${segRel}`;
            return wildcard ? `https://${cdnHost(cfg)}/${encodeKey(segKey)}?${wildcard}` : signedUrl(cfg, segKey, ttlSec);
        };
        // Another playlist: relative to THIS one, so the player asks the API again.
        const playlistUrl = (plRel) => `${'../'.repeat(depth)}${plRel.split('/').map(encodeURIComponent).join('/')}`;
        return rewriteManifest(text, baseDir, signSegment, playlistUrl);
    },

    /** A signed address for the thumbnail MediaConvert made, or null. */
    thumbnailUrl(video, cfg) { return video.thumbnailKey ? signedUrl(cfg, video.thumbnailKey, 3600) : null; },

    async remove(video, cfg) {
        // The source file; transcoded segments are left to the bucket's lifecycle rule (docs).
        if (video.storageKey) await call(cfg, 'DELETE', video.storageKey).catch(() => {});
    },

    // for the tests
    _cloudFrontQuery: cloudFrontQuery, _convertJob: convertJob, _signedUrl: signedUrl,
};
