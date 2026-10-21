'use strict';
/**
 * A small S3 client (Oct 2026): AWS Signature Version 4 over fetch, enough to
 * put, get, check and delete one object. It speaks to AWS S3 and to the
 * S3-compatible stores (Cloudflare R2, DigitalOcean Spaces, MinIO, Backblaze
 * B2) — no SDK, so no new dependency.
 *
 *   S3_BUCKET              the bucket (kept private: no public access)
 *   S3_REGION              e.g. ap-south-1 (R2: auto)
 *   S3_ACCESS_KEY_ID       \ an IAM user / API token allowed s3:GetObject,
 *   S3_SECRET_ACCESS_KEY   / s3:PutObject and s3:DeleteObject on the bucket
 *   S3_ENDPOINT            optional: https://<account>.r2.cloudflarestorage.com, http://minio:9000 …
 *   S3_FORCE_PATH_STYLE    optional: 1 for MinIO and most self-hosted stores
 *
 * The signer is checked against AWS's own published examples
 * (tests/admission/storage.test.js).
 */
const crypto = require('crypto');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const EMPTY_HASH = sha256('');

/** RFC 3986 encoding, as SigV4 wants it; '/' kept in paths. */
function encode(str, keepSlash = false) {
    return encodeURIComponent(str)
        .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(keepSlash ? /%2F/g : /(?!)/g, '/');
}

const amzDate = (d) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

/**
 * Sign a request. `headers` is a plain object (any case); returns the headers
 * to send, with x-amz-date, x-amz-content-sha256 and Authorization added.
 */
function sign({ method, url, headers = {}, body = '', payloadHash = null, region, service = 's3', accessKeyId, secretAccessKey, date = new Date() }) {
    const u = new URL(url);
    const when = amzDate(date);
    const day = when.slice(0, 8);
    const hash = payloadHash || sha256(body || '');
    const all = { ...headers, host: u.host, 'x-amz-date': when, 'x-amz-content-sha256': hash };
    const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
    const names = Object.keys(lower).sort();
    const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
    const signedHeaders = names.join(';');
    const query = [...u.searchParams.entries()].map(([k, v]) => [encode(k), encode(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
    const path = u.pathname.split('/').map((seg) => encode(decodeURIComponent(seg))).join('/') || '/';
    const canonicalRequest = [method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, hash].join('\n');
    const scope = `${day}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', when, scope, sha256(canonicalRequest)].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
    const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
    return {
        ...all,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        _debug: { canonicalRequest, stringToSign, signature },
    };
}

function config() {
    const c = {
        bucket: process.env.S3_BUCKET || '', region: process.env.S3_REGION || 'us-east-1',
        accessKeyId: process.env.S3_ACCESS_KEY_ID || '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
        endpoint: (process.env.S3_ENDPOINT || '').replace(/\/+$/, ''), pathStyle: /^(1|true|yes)$/i.test(process.env.S3_FORCE_PATH_STYLE || ''),
    };
    c.ready = !!(c.bucket && c.accessKeyId && c.secretAccessKey);
    return c;
}

function objectUrl(c, key) {
    const k = String(key).split('/').map((s) => encode(s)).join('/');
    if (c.endpoint) return c.pathStyle ? `${c.endpoint}/${c.bucket}/${k}` : `${c.endpoint.replace('://', `://${c.bucket}.`)}/${k}`;
    return `https://${c.bucket}.s3.${c.region}.amazonaws.com/${k}`;
}

async function request(method, key, { body = null, headers = {} } = {}) {
    const c = config();
    if (!c.ready) throw new Error('S3 storage is not configured (S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)');
    const url = objectUrl(c, key);
    const signed = sign({ method, url, headers, body: body || '', region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey });
    const { _debug, host, ...send } = signed;
    return fetch(url, { method, headers: send, body: body || undefined });
}

async function putObject(key, buffer, contentType = 'application/octet-stream') {
    const r = await request('PUT', key, { body: buffer, headers: { 'content-type': contentType } });
    if (!r.ok) throw new Error(`S3 put failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/** The object's body as a web ReadableStream, or null when it is not there. */
async function getObject(key) {
    const r = await request('GET', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 get failed: HTTP ${r.status}`);
    return { body: r.body, size: Number(r.headers.get('content-length')) || null, contentType: r.headers.get('content-type') || '' };
}

async function getBuffer(key) {
    const r = await request('GET', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 get failed: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
}

async function headObject(key) {
    const r = await request('HEAD', key);
    return r.ok;
}

async function deleteObject(key) {
    const r = await request('DELETE', key);
    if (!r.ok && r.status !== 404) throw new Error(`S3 delete failed: HTTP ${r.status}`);
}

module.exports = { sign, encode, config, objectUrl, putObject, getObject, getBuffer, headObject, deleteObject, EMPTY_HASH };
