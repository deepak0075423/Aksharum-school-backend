'use strict';
/**
 * Check an admission lottery from its public record (Oct 2026).
 *
 *   node scripts/verifyLottery.js <draw.json | https://api…/admission/public/portals/<slug>/lotteries/<list id>>
 *
 * The record is what the portal's draw page shows (GET …/lotteries/:listId).
 * This recomputes, from that alone, the fingerprint of who was in the draw,
 * the seed, every application's key and the order — and says whether the
 * published draw numbers follow. It needs nothing from the school's database.
 */
const fs = require('fs');
const lottery = require('../services/admission/lottery');

async function load(src) {
    if (/^https?:\/\//i.test(src)) {
        const r = await fetch(src);
        if (!r.ok) throw new Error(`Could not fetch the record: HTTP ${r.status}`);
        return (await r.json()).data;
    }
    const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
    return raw.data || raw;
}

(async () => {
    const src = process.argv[2];
    if (!src) { console.error('Usage: node scripts/verifyLottery.js <draw.json | url>'); process.exit(2); }
    const rec = await load(src);
    const d = rec.draw || {};
    const record = {
        nonce: d.nonce, commitment: d.commitment, phrase: d.phrase, inputHash: d.inputHash, seed: d.seed,
        input: (rec.entries || []).map((e) => [e.applicationNumber, e.points]),
    };
    const ranks = new Map((rec.entries || []).map((e) => [String(e.applicationNumber), e.drawNo]));
    const result = lottery.verify(String(rec._id), record, ranks);
    console.log(`${rec.name} — ${rec.className || ''} (${rec.roundName || ''})`);
    console.log(`Algorithm ${d.algorithm}; ${result.checked} applications; phrase "${d.phrase}"`);
    if (result.ok) console.log('VERIFIED: the published order follows from the commitment, the phrase and the list of applications.');
    else { console.log('NOT VERIFIED:'); for (const p of result.problems) console.log(` - ${p}`); }
    process.exit(result.ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(2); });
