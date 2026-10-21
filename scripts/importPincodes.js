'use strict';
/**
 * Load India Post's "All India Pincode Directory" into the database (Oct 2026),
 * so PIN codes are looked up here first instead of over the internet
 * (services/pincodes.js).
 *
 *   Download the CSV from data.gov.in — "All India Pincode Directory"
 *   (Department of Posts; Government Open Data Licence – India) — then:
 *
 *   node scripts/importPincodes.js <file.csv>            check the file (nothing changes)
 *   node scripts/importPincodes.js <file.csv> --commit   replace the directory with it
 *
 * The columns are found by name, so both published layouts load
 * (officename, pincode, officetype, district | districtname, statename).
 * Rows without a valid six-digit PIN are skipped and counted. The old
 * directory is replaced in one transaction: a failed import leaves it as it was.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');
const pool = require('../db/pool');

const file = process.argv[2];
const commit = process.argv.includes('--commit');

/** One CSV line → its cells (double-quoted cells may hold commas and "" quotes). */
function cells(line) {
    const out = [];
    let cur = ''; let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
}

(async () => {
    if (!file || !fs.existsSync(file)) { console.error('Usage: node scripts/importPincodes.js <All India Pincode Directory .csv> [--commit]'); process.exit(2); }
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    let head = null;
    const rows = [];
    const out = { lines: 0, rows: 0, skipped: 0, pins: 0, states: new Set() };
    for await (const raw of rl) {
        const line = raw.replace(/^﻿/, '');
        if (!line.trim()) continue;
        if (!head) {
            const h = cells(line).map((c) => c.toLowerCase().replace(/[^a-z]/g, ''));
            const at = (...names) => names.map((n) => h.indexOf(n)).find((i) => i >= 0) ?? -1;
            head = { pin: at('pincode'), office: at('officename'), type: at('officetype'), district: at('district', 'districtname'), state: at('statename', 'state') };
            if (head.pin < 0 || head.state < 0) { console.error('The file has no "pincode" / "statename" columns — is it the All India Pincode Directory?'); process.exit(2); }
            continue;
        }
        out.lines += 1;
        const c = cells(line);
        const pin = String(c[head.pin] || '').replace(/\.0+$/, '');
        if (!/^[1-9]\d{5}$/.test(pin)) { out.skipped += 1; continue; }
        const row = {
            pincode: pin, officeName: (c[head.office] || '').slice(0, 120), officeType: (c[head.type] || '').slice(0, 20),
            district: (c[head.district] || '').slice(0, 80), state: (c[head.state] || '').slice(0, 80),
        };
        rows.push(row);
        out.states.add(row.state.toUpperCase());
    }
    out.rows = rows.length;
    out.pins = new Set(rows.map((r) => r.pincode)).size;
    console.log(JSON.stringify({ ...out, states: out.states.size }, null, 2));
    if (!rows.length) { console.error('No usable rows.'); process.exit(1); }
    if (!commit) { console.log('Nothing changed. Run again with --commit to load it.'); await pool.end(); return; }

    // The table is the ORM's (models/PinCode.js); a server that has started once has made it.
    const PinCode = require('../models/PinCode');
    await PinCode.ensureTable();
    const { withTransaction } = require('../services/dbTx');
    try {
        await withTransaction(async (q) => {
            await q('DELETE FROM "pincodes"');
            for (let i = 0; i < rows.length; i += 1000) {
                const part = rows.slice(i, i + 1000);
                const params = [];
                const values = part.map((r) => {
                    params.push(crypto.randomUUID(), r.pincode, r.officeName, r.officeType, r.district, r.state);
                    const n = params.length;
                    return `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n}, now(), now())`;
                });
                await q(`INSERT INTO "pincodes" ("_id", "pincode", "officeName", "officeType", "district", "state", "createdAt", "updatedAt") VALUES ${values.join(', ')}`, params);
            }
        });
        console.log(`Loaded ${rows.length} post offices (${out.pins} PIN codes). Running servers pick it up within ten minutes.`);
    } catch (e) {
        console.error('Nothing changed —', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
