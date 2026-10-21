'use strict';
/**
 * The admission lottery (Oct 2026) — a random draw anyone can check.
 *
 *   input     the applications in the draw, sorted by application number,
 *             each with its priority points (0 for a plain lottery):
 *             "APP202700012:0\nAPP202700015:10\n…"
 *   inputHash SHA-256 of that text — fixes who is in the draw
 *   nonce     a random value the server made when the list was created; only
 *             its SHA-256 (the commitment) is shown before the draw, so nobody
 *             — not the office either — can work out an order in advance
 *   phrase    words or numbers given out loud at the draw (by the witnesses)
 *   seed      SHA-256("aksharum-lottery-v1|<list id>|<nonce>|<phrase>|<inputHash>")
 *   key       HMAC-SHA256(seed, application number), per application
 *   order     most points first; within the same points, the smaller key first
 *
 * Each key depends only on the seed and that application's own number, so the
 * result can be recomputed from the published record line by line
 * (scripts/verifyLottery.js does exactly that). A draw is made once: the list
 * records it and refuses a second.
 */
const crypto = require('crypto');

const ALGORITHM = 'aksharum-lottery-v1';

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

const newNonce = () => crypto.randomBytes(16).toString('hex');
const commitmentOf = (nonce) => sha256(nonce);

/** The phrase as it is hashed: spaces collapsed, case kept. */
const normalPhrase = (phrase) => String(phrase || '').trim().replace(/\s+/g, ' ');

function inputText(lines) {
    return [...lines]
        .map((l) => ({ n: String(l.applicationNumber), p: Number(l.points) || 0 }))
        .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
        .map((l) => `${l.n}:${l.p}`)
        .join('\n');
}

const inputHash = (lines) => sha256(inputText(lines));

function seedOf({ listId, nonce, phrase, inputHash: ih }) {
    return sha256(`${ALGORITHM}|${listId}|${nonce}|${normalPhrase(phrase)}|${ih}`);
}

const keyOf = (seed, applicationNumber) => crypto.createHmac('sha256', seed).update(String(applicationNumber), 'utf8').digest('hex');

/** Lines in draw order, each with its key and 1-based draw number. */
function order(lines, seed) {
    return lines
        .map((l) => ({ ...l, points: Number(l.points) || 0, key: keyOf(seed, l.applicationNumber) }))
        .sort((a, b) => (b.points - a.points) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((l, i) => ({ ...l, drawNo: i + 1 }));
}

/** Everything a draw needs, from the list and its pool. */
function draw({ listId, nonce, phrase, lines }) {
    const ih = inputHash(lines);
    const seed = seedOf({ listId, nonce, phrase, inputHash: ih });
    return { algorithm: ALGORITHM, inputHash: ih, seed, ordered: order(lines, seed) };
}

/**
 * Recompute a recorded draw. `record` is what the list keeps (input, phrase,
 * nonce, commitment, inputHash, seed); `ranks` maps application number to the
 * draw number the list shows. Returns { ok, problems }.
 */
function verify(listId, record, ranks) {
    const problems = [];
    if (!record) return { ok: false, problems: ['There is no draw to check'] };
    if (commitmentOf(record.nonce) !== record.commitment) problems.push('The revealed value does not match the commitment shown before the draw');
    const lines = (record.input || []).map(([applicationNumber, points]) => ({ applicationNumber, points }));
    const ih = inputHash(lines);
    if (ih !== record.inputHash) problems.push('The list of applications in the draw does not match its fingerprint');
    const seed = seedOf({ listId, nonce: record.nonce, phrase: record.phrase, inputHash: ih });
    if (seed !== record.seed) problems.push('The seed does not follow from the phrase and the commitment');
    const ordered = order(lines, seed);
    let mismatched = 0;
    for (const l of ordered) {
        const shown = ranks.get(String(l.applicationNumber));
        if (shown !== undefined && Number(shown) !== l.drawNo) mismatched += 1;
    }
    if (mismatched) problems.push(`${mismatched} draw number(s) differ from the recomputed order`);
    return { ok: !problems.length, problems, checked: ordered.length };
}

module.exports = { ALGORITHM, sha256, newNonce, commitmentOf, normalPhrase, inputText, inputHash, seedOf, keyOf, order, draw, verify };
