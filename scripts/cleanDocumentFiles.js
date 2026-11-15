'use strict';
/**
 * Files left behind in uploads/documents — the Documents module's folder.
 *
 * Until Nov 2026 nothing ever took a file off the disk: deleting a document,
 * replacing an attachment, replacing a submission and every refused upload all
 * left theirs behind. New ones are cleaned up as they happen
 * (services/documentAccess.removeUnreferenced); this is for what had already
 * piled up.
 *
 * A file is "left behind" when no document, earlier version, comment,
 * submission or Video Learning asset names it. Those are MOVED, not deleted —
 * to removed-uploads/documents/<date>/ beside the uploads folder, which the
 * server does not serve — so a file moved by mistake can simply be put back.
 * Delete that folder once you are satisfied.
 *
 *   node scripts/cleanDocumentFiles.js            list what would be moved
 *   node scripts/cleanDocumentFiles.js --apply    move them
 *   --hours=24                                    leave anything newer alone
 *                                                 (an upload may be mid-save)
 */
require('dotenv').config({ quiet: true });
const fs   = require('fs');
const path = require('path');
const pool = require('../db/pool');

const APPLY  = process.argv.includes('--apply');
const HOURS  = Number((process.argv.find((a) => a.startsWith('--hours=')) || '').split('=')[1]) || 24;
const FOLDER = path.join(__dirname, '..', 'uploads', 'documents');
const TABLES = ['documents', 'documentversions', 'documentcomments', 'assignmentsubmissions'];

const size = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

async function referenced() {
    const names = new Set();
    for (const table of TABLES) {
        const { rows } = await pool.query(
            `SELECT DISTINCT f->>'storedName' AS name
               FROM "${table}" t
               CROSS JOIN LATERAL jsonb_array_elements(
                     CASE WHEN jsonb_typeof(t."files") = 'array' THEN t."files" ELSE '[]'::jsonb END) f
              WHERE COALESCE(f->>'storedName', '') <> ''`,
        );
        rows.forEach((r) => names.add(r.name));
    }
    // Video Learning assets of the old module were stored here too.
    const videos = await pool.query(`SELECT "fileUrl" FROM "videoassets" WHERE "fileUrl" IS NOT NULL`).catch(() => ({ rows: [] }));
    videos.rows.forEach((r) => names.add(path.basename(String(r.fileUrl).split('?')[0])));
    return names;
}

(async () => {
    if (!fs.existsSync(FOLDER)) { console.log('There is no uploads/documents folder here.'); return; }
    const keep   = await referenced();
    const cutoff = Date.now() - HOURS * 3600 * 1000;

    const left = [];
    let recent = 0;
    for (const name of fs.readdirSync(FOLDER)) {
        if (name.startsWith('.') || keep.has(name)) continue;
        const stat = fs.statSync(path.join(FOLDER, name));
        if (!stat.isFile()) continue;
        if (stat.mtimeMs > cutoff) { recent += 1; continue; }
        left.push({ name, bytes: stat.size, at: stat.mtime });
    }

    const total = left.reduce((n, f) => n + f.bytes, 0);
    console.log(`${keep.size} files are in use. ${left.length} are left behind (${size(total)})`
        + (recent ? `, and ${recent} newer than ${HOURS} hours were left alone.` : '.'));
    left.forEach((f) => console.log(`  ${f.name}  ${size(f.bytes)}  ${f.at.toISOString().slice(0, 10)}`));
    if (!left.length) return;

    if (!APPLY) { console.log('\nNothing was moved. Run again with --apply to move them.'); return; }

    const dest = path.join(__dirname, '..', 'removed-uploads', 'documents', new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dest, { recursive: true });
    let moved = 0;
    for (const f of left) {
        try { fs.renameSync(path.join(FOLDER, f.name), path.join(dest, f.name)); moved += 1; }
        catch (e) { console.warn(`  could not move ${f.name}: ${e.message}`); }
    }
    console.log(`\nMoved ${moved} file${moved === 1 ? '' : 's'} to ${dest}`);
    console.log('They are not served from there. Put one back by moving it into uploads/documents; delete the folder when you are sure.');
})()
    .catch((e) => { console.error('Failed:', e.message); process.exitCode = 1; })
    .finally(() => pool.end().catch(() => {}));
