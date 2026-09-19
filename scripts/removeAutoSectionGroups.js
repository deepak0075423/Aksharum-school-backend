'use strict';
/**
 * Remove the section staff groups that used to be created automatically
 * ("Class 1 – A Teachers"). Class groups are now made by hand by the class
 * teacher, vice class teacher or subject teachers.
 *
 * Only EMPTY ones are removed — a group anyone has written in is listed and
 * left for a person to decide about.
 *
 *   node scripts/removeAutoSectionGroups.js            # dry run: lists what would go
 *   node scripts/removeAutoSectionGroups.js --apply    # removes them
 */
require('dotenv').config();
const pool = require('../db/pool');

(async () => {
    const apply = process.argv.includes('--apply');
    const { rows } = await pool.query(
        `SELECT c."_id", c."name", s."name" AS "school",
                (SELECT count(*)::int FROM "messages" m WHERE m."chat" = c."_id") AS "messages"
           FROM "chats" c JOIN "schools" s ON s."_id" = c."school"
          WHERE c."type" = 'group' AND c."classSection" IS NOT NULL AND COALESCE(c."kind", '') = ''
          ORDER BY s."name", c."name"`,
    );
    const empty = rows.filter((r) => r.messages === 0);
    const kept = rows.filter((r) => r.messages > 0);

    console.log(`${rows.length} automatic section group(s): ${empty.length} empty, ${kept.length} with messages.`);
    for (const r of kept) console.log(`  keep   ${r.school} · ${r.name} (${r.messages} messages)`);
    for (const r of empty) console.log(`  ${apply ? 'remove' : 'would remove'} ${r.school} · ${r.name}`);

    if (apply && empty.length) {
        const ids = empty.map((r) => r._id);
        await pool.query(`DELETE FROM "messagereceipts" WHERE "chat" = ANY($1::uuid[])`, [ids]);
        await pool.query(`DELETE FROM "chatmembers" WHERE "chat" = ANY($1::uuid[])`, [ids]);
        await pool.query(`DELETE FROM "chats" WHERE "_id" = ANY($1::uuid[])`, [ids]);
        console.log(`Removed ${ids.length}.`);
    } else if (!apply && empty.length) {
        console.log('Dry run — run again with --apply to remove the empty ones.');
    }
    await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
