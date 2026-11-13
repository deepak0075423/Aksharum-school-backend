'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const s3 = require('../../services/storage/s3');
const s3Provider = require('../../services/lms/providers/s3');
const { vimeo, youtube, isoDuration } = require('../../services/lms/providers/embeds');
const { rewriteManifest, resolveInside } = require('../../services/lms/hls');
const { sniff, mp4Duration } = require('../../services/lms/mediaProbe');
const token = require('../../services/lms/playbackToken');
const secrets = require('../../services/lms/secrets');

/** The parts of the module that need no server and no database. */
describe('video learning — signing, playlists and file reading', () => {
    it('a pre-signed S3 address matches the example AWS publishes', () => {
        const url = s3.presign({
            method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', expires: 86400, region: 'us-east-1',
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z'),
        });
        assert.ok(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'), url);
        assert.ok(!url.includes('wJalrXUtnFEMI'), 'the secret is never in the address');
    });

    it('a CloudFront signed address verifies against the key pair, and carries its expiry', () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const cfg = { cdnDomain: 'd1.cloudfront.net', cdnKeyPairId: 'KTEST', cdnPrivateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }) };
        const p = new URLSearchParams(s3Provider._cloudFrontQuery(cfg, 'https://d1.cloudfront.net/v/*', 1900000000));
        const un = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
        assert.equal(crypto.createVerify('RSA-SHA1').update(un(p.get('Policy'))).verify(publicKey, un(p.get('Signature'))), true);
        const policy = JSON.parse(un(p.get('Policy')).toString());
        assert.equal(policy.Statement[0].Condition.DateLessThan['AWS:EpochTime'], 1900000000);
        assert.equal(p.get('Key-Pair-Id'), 'KTEST');
        const url = s3Provider._signedUrl({ ...cfg, bucket: 'b' }, 'video-learning/x/source.mp4', 300);
        assert.ok(url.startsWith('https://d1.cloudfront.net/video-learning/x/source.mp4?Policy='));
    });

    it('without CloudFront, playback uses a short-lived signed address on the bucket — never a bare one', () => {
        const url = s3Provider._signedUrl({ bucket: 'lessons', region: 'ap-south-1', accessKeyId: 'AK', secretAccessKey: 'SK' }, 'video-learning/x/source.mp4', 300);
        assert.ok(url.includes('X-Amz-Expires=300') && url.includes('X-Amz-Signature='));
    });

    it('the provider says what is missing rather than pretending to be ready', () => {
        assert.deepEqual(s3Provider.status({}).configured, false);
        assert.ok(s3Provider.status({}).missing.includes('Bucket'));
        const half = s3Provider.status({ bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', cdnDomain: 'd.cloudfront.net' });
        assert.equal(half.configured, false, 'a CloudFront domain without its key pair is not a working set-up');
        assert.equal(s3Provider.status({ bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }).configured, true);
    });

    it('the MediaConvert job reads the private source and writes HLS and a thumbnail beside it', () => {
        const job = s3Provider._convertJob({ bucket: 'lessons', prefix: 'vl', mediaConvertRoleArn: 'arn:aws:iam::1:role/mc' }, { _id: 'vid-1', storageKey: 'vl/vid-1/source.mp4' });
        assert.equal(job.Role, 'arn:aws:iam::1:role/mc');
        assert.equal(job.Settings.Inputs[0].FileInput, 's3://lessons/vl/vid-1/source.mp4');
        assert.equal(job.Settings.OutputGroups[0].OutputGroupSettings.HlsGroupSettings.Destination, 's3://lessons/vl/vid-1/hls/master');
        assert.equal(job.Settings.OutputGroups[0].Outputs.length, 3);
    });

    it('a playlist is rewritten per viewer: segments signed, other playlists kept relative, nothing outside the video', () => {
        const out = rewriteManifest(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=3000000', 'master_720.m3u8', '#EXT-X-KEY:METHOD=AES-128,URI="enc.key"',
            'master_720_00001.ts', '../../another-video/secret.ts', 'https://evil.example/x.ts', '/etc/passwd'].join('\n'), '', (r) => `SIGNED:${r}`, (r) => `PLAYLIST:${r}`).split('\n');
        assert.equal(out[2], 'PLAYLIST:master_720.m3u8');
        assert.equal(out[3], '#EXT-X-KEY:METHOD=AES-128,URI="SIGNED:enc.key"');
        assert.equal(out[4], 'SIGNED:master_720_00001.ts');
        assert.ok(out.slice(5).every((l) => l.startsWith('# removed')), 'addresses that leave the video are dropped');
        assert.equal(resolveInside('a/b', '../c.ts'), 'a/c.ts');
        assert.equal(resolveInside('', '../c.ts'), null);
        assert.equal(resolveInside('', '%2e%2e/c.ts'), null);
    });

    it('a video\'s type and length are read from the file itself', async () => {
        const H = require('./helpers');
        const file = H.mp4(754.5, 200000);
        const readAt = async (o, l) => file.subarray(o, o + l);
        assert.equal(sniff(file.subarray(0, 16)), 'mp4');
        assert.equal(await mp4Duration(readAt, file.length), 754.5);
        assert.equal(sniff(Buffer.from('<html><script>alert(1)</script></html>')), null, 'a renamed web page is not a video');
        assert.equal(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), 'webm');
        assert.equal(await mp4Duration(async () => Buffer.alloc(16), 16), null);
    });

    it('a playback token cannot be altered or used past its time', () => {
        const t = token.sign({ kind: 'watch', vid: 'v1', uid: 'u1', sid: 's1' }, 60);
        assert.equal(token.verify(t).sid, 's1');
        const [body, sig] = t.split('.');
        const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), vid: 'v2' })).toString('base64url');
        assert.equal(token.verify(`${forged}.${sig}`), null);
        assert.equal(token.verify(`${body}.${sig.slice(0, -2)}xx`), null);
        assert.equal(token.verify('nonsense'), null);
        const old = Buffer.from(JSON.stringify({ kind: 'watch', vid: 'v1', uid: 'u1', sid: 's1', exp: 1 })).toString('base64url');
        assert.equal(token.verify(`${old}.${sig}`), null);
    });

    it('a stored credential is sealed, and a damaged one opens as nothing', () => {
        const sealed = secrets.seal('wJalrXUtnFEMI/SECRET');
        assert.ok(!sealed.includes('SECRET'));
        assert.equal(secrets.open(sealed), 'wJalrXUtnFEMI/SECRET');
        assert.equal(secrets.open(`${sealed.slice(0, -3)}abc`), '');
        assert.equal(secrets.open(''), '');
    });

    it('Vimeo and YouTube addresses are read to their ids', () => {
        assert.equal(youtube.parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ');
        assert.equal(youtube.parse('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
        assert.equal(youtube.parse('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
        assert.equal(youtube.parse('https://example.com/watch?v=dQw4w9WgXcQ'), null);
        assert.equal(vimeo.parse('https://vimeo.com/123456789'), '123456789');
        assert.equal(vimeo.parse('https://vimeo.com/123456789/abcdef0123'), '123456789:abcdef0123');
        assert.equal(vimeo.parse('https://player.vimeo.com/video/123456789?h=abcdef0123'), '123456789:abcdef0123');
        assert.equal(vimeo.parse('not a video'), null);
        assert.equal(isoDuration('PT1H2M3S'), 3723);
    });
});
