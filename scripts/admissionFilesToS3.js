'use strict';
/**
 * Move admission documents from this server's disk into the S3 bucket
 * (Oct 2026) — before switching ADMISSION_STORAGE=s3 on.
 *
 *   node scripts/admissionFilesToS3.js            what would be copied (nothing changes)
 *   node scripts/admissionFilesToS3.js --commit   copy every file the bucket lacks
 *   … --commit --delete-local                     and remove each local copy once the bucket has it
 *
 * Needs the S3_* settings (services/storage/s3.js). Keys stay the documents'
 * own `file` values, so no row changes. Safe to run again: a file already in
 * the bucket is skipped. Without --delete-local the disk copies stay, so the
 * switch can be undone by unsetting ADMISSION_STORAGE.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const s3 = require('../services/storage/s3');
const { ROOT } = require('../services/admission/fileStore');

const args = new Set(process.argv.slice(2));
const commit = args.has('--commit');
const deleteLocal = args.has('--delete-local');

(async () => {
    const c = s3.config();
    if (!c.ready) { console.error('Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (and S3_REGION / S3_ENDPOINT) first.'); process.exit(2); }
    const { rows } = await pool.query(`SELECT "file", "mime" FROM "admissiondocuments" WHERE "file" <> '' ORDER BY "createdAt"`);
    const out = { files: rows.length, missingLocally: 0, alreadyInBucket: 0, copied: 0, deleted: 0, failed: 0 };
    for (const r of rows) {
        const local = path.join(ROOT, r.file);
        if (!local.startsWith(ROOT + path.sep) || !fs.existsSync(local)) { out.missingLocally += 1; continue; }
        try {
            if (await s3.headObject(r.file)) {
                out.alreadyInBucket += 1;
            } else if (commit) {
                await s3.putObject(r.file, await fs.promises.readFile(local), r.mime || 'application/octet-stream');
                out.copied += 1;
            } else {
                out.copied += 1;   // would copy
            }
            if (commit && deleteLocal && await s3.headObject(r.file)) { await fs.promises.unlink(local); out.deleted += 1; }
        } catch (e) {
            out.failed += 1;
            console.error(`  ${r.file}: ${e.message}`);
        }
    }
    console.log(`${commit ? 'Copied to' : 'Would copy to'} s3://${c.bucket}:`, out);
    await pool.end();
    process.exit(out.failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
