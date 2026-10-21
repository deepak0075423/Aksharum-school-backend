'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./helpers');
const s3 = require('../../services/storage/s3');

/**
 * Admission documents in a private S3-compatible bucket
 * (ADMISSION_STORAGE=s3): the signer matches AWS's own published examples,
 * and every document path — upload, open, remove, copy into the student record,
 * erase — works against a bucket that checks each request's signature.
 */
const KEY = 'AKIATESTADMISSION';
const SECRET = 'test/secret/for/the/fake/bucket';

function fakeBucket() {
    const objects = new Map();
    const refused = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const auth = String(req.headers.authorization || '');
            const m = auth.match(/Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/);
            const when = String(req.headers['x-amz-date'] || '');
            const url = `http://${req.headers.host}${req.url}`;
            let ok = false;
            if (m && m[1] === KEY) {
                const signedNames = m[4].split(';').filter((n) => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(n));
                const headers = Object.fromEntries(signedNames.map((n) => [n, req.headers[n]]));
                const date = new Date(`${when.slice(0, 4)}-${when.slice(4, 6)}-${when.slice(6, 8)}T${when.slice(9, 11)}:${when.slice(11, 13)}:${when.slice(13, 15)}Z`);
                const expect = s3.sign({ method: req.method, url, headers, payloadHash: req.headers['x-amz-content-sha256'], region: m[3], accessKeyId: KEY, secretAccessKey: SECRET, date });
                const hashOk = req.headers['x-amz-content-sha256'] === crypto.createHash('sha256').update(body).digest('hex');
                ok = expect._debug.signature === m[5] && hashOk;
            }
            if (!ok) { refused.push(`${req.method} ${req.url}`); res.writeHead(403); return res.end('SignatureDoesNotMatch'); }
            const key = decodeURIComponent(new URL(url).pathname).replace(/^\/adm-test\//, '');
            if (req.method === 'PUT') { objects.set(key, { body, type: req.headers['content-type'] }); res.writeHead(200); return res.end(); }
            const o = objects.get(key);
            if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
            if (!o) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'content-type': o.type || 'application/octet-stream', 'content-length': o.body.length });
            return res.end(req.method === 'HEAD' ? undefined : o.body);
        });
    });
    return { server, objects, refused };
}

describe('admission — documents in an S3-compatible bucket', () => {
    let bucket; let s; let portal; let round;
    before(async () => {
        bucket = fakeBucket();
        await new Promise((r) => bucket.server.listen(0, '127.0.0.1', r));
        await H.startServer({
            ADMISSION_STORAGE: 's3', S3_BUCKET: 'adm-test', S3_REGION: 'ap-south-1', S3_ACCESS_KEY_ID: KEY, S3_SECRET_ACCESS_KEY: SECRET,
            S3_ENDPOINT: `http://127.0.0.1:${bucket.server.address().port}`, S3_FORCE_PATH_STYLE: '1',
        });
        s = await H.makeSchool('Bucket');
        portal = await H.openPortal(s);
        round = await H.makeRound(s, portal.form, { seats1: 5, admissionFee: 100 });
    });
    after(async () => { await H.finish(); bucket.server.close(); });

    it('signs exactly as AWS documents it (GET and PUT examples)', () => {
        const base = { region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') };
        const get = s3.sign({ ...base, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: s3.EMPTY_HASH });
        assert.equal(get._debug.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
        const put = s3.sign({ ...base, method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test$file.text', headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, body: 'Welcome to Amazon S3.' });
        assert.equal(put._debug.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
    });

    it('keeps an upload in the bucket, never on the server, and serves it back through the API', async () => {
        const g = await H.registerGuest(s, portal.slug);
        const c = (await H.api('POST', '/admission/portal/applications', { token: g.token, body: { round: round._id, class: s.classes[0]._id } })).body.data;
        const up = await H.uploadDoc(g.token, c._id, 'photo');
        assert.equal(up.status, 201, JSON.stringify(up.body));
        const [doc] = await H.q(`SELECT "file" FROM "admissiondocuments" WHERE "_id" = $1`, [up.body.data._id]);
        assert.ok(bucket.objects.has(doc.file), 'in the bucket');
        assert.ok(!fs.existsSync(path.join(__dirname, '..', '..', 'uploads', 'admission-docs', doc.file)), 'not on the disk');
        const back = await H.api('GET', `/admission/portal/applications/${c._id}/documents/${up.body.data._id}/file`, { token: g.token });
        assert.equal(back.status, 200);
        assert.ok(Buffer.compare(back.body, H.FILES.png) === 0, 'the same bytes');
        assert.equal(back.headers.get('cache-control'), 'private, no-store');
        const gone = await H.api('DELETE', `/admission/portal/applications/${c._id}/documents/${up.body.data._id}`, { token: g.token });
        assert.equal(gone.status, 200);
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(!bucket.objects.has(doc.file), 'removed from the bucket too');
        assert.deepEqual(bucket.refused, [], 'every request was correctly signed');
    });

    it('copies verified documents from the bucket into the new student\'s record, and erasure empties the bucket', async () => {
        const g = await H.registerGuest(s, portal.slug);
        const a = await H.submittedApplication(s, g, round, { answers: { studentName: 'Yamini Das', studentDob: '2021-09-09' } });
        await H.verifyAllDocs(s, a._id);
        const keys = (await H.q(`SELECT "file" FROM "admissiondocuments" WHERE "application" = $1`, [a._id])).map((d) => d.file);
        assert.ok(keys.length === 3 && keys.every((k) => bucket.objects.has(k)));
        const step = async (url, body, want) => { const r = await H.api('POST', url, { token: s.adminToken, body }); assert.equal(r.status, want, `${url}: ${JSON.stringify(r.body)}`); };
        await step(`/admission/admin/applications/${a._id}/offer`, {}, 201);
        await step(`/admission/admin/applications/${a._id}/offer/respond`, { accept: true, note: 'Accepted at the counter' }, 200);
        await step(`/admission/admin/applications/${a._id}/payments`, { kind: 'admission_fee', amount: 100, mode: 'cash' }, 201);
        await step(`/admission/admin/applications/${a._id}/confirm`, undefined, 200);
        const conv = await H.api('POST', `/admission/admin/applications/${a._id}/convert`, { token: s.adminToken, body: { studentEmail: `kid-${H.rand()}@kids.test`, parent: { mode: 'new', relation: 'Mother', name: 'Rina Das', email: `rina-${H.rand()}@family.test`, phone: '9811100099' } } });
        assert.equal(conv.status, 200, JSON.stringify(conv.body));
        const [profile] = await H.q(`SELECT "photoFile", "birthCertificateFile" FROM "studentprofiles" WHERE "user" = $1`, [conv.body.data.studentUser]);
        const copied = [profile.photoFile, profile.birthCertificateFile];
        assert.ok(copied.every(Boolean), `both mapped documents copied: ${JSON.stringify(profile)}`);
        for (const name of copied) {
            const file = path.join(__dirname, '..', '..', 'uploads', 'student-docs', name);
            assert.ok(fs.existsSync(file), `${name} is in the student record`);
            assert.ok(Buffer.compare(fs.readFileSync(file), H.FILES.png) === 0, 'with the bytes that were in the bucket');
        }
        // A rejected application's files leave the bucket when it is erased.
        const g2 = await H.registerGuest(s, portal.slug);
        const b = await H.submittedApplication(s, g2, round, { answers: { studentName: 'Zubin Kohli', studentDob: '2021-10-10' } });
        const bKeys = (await H.q(`SELECT "file" FROM "admissiondocuments" WHERE "application" = $1`, [b._id])).map((d) => d.file);
        await H.api('POST', `/admission/admin/applications/${b._id}/transition`, { token: s.adminToken, body: { to: 'rejected', remarks: 'Seats full' } });
        const req = await H.api('POST', '/admission/portal/privacy/requests', { token: g2.token, body: { kind: 'erasure' } });
        assert.equal((await H.api('POST', `/admission/admin/privacy/requests/${req.body.data._id}/erase`, { token: s.adminToken })).body.data.erased, 1);
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(bKeys.every((k) => !bucket.objects.has(k)), 'the erased application\'s files are gone from the bucket');
        assert.deepEqual(bucket.refused, []);
    });
});
