'use strict';
/**
 * Rewrite phone numbers stored as they were typed ("+91 98765 43210") as the
 * ten digits every phone field now holds. Only values that become a valid
 * 10-digit mobile number change; landlines, extensions and anything else are
 * listed and left alone.
 *
 *   node scripts/normalizePhones.js            report what would change
 *   node scripts/normalizePhones.js --apply    change it
 *
 * The work is services/phoneBackfill — which a server also runs ONCE by
 * itself, on its first boot with this code (db/migrate.js, ledger table
 * "datamigrations"), so a deploy needs no step by hand; this script stays for
 * a look first, and to list the numbers that need a person to correct them.
 */
require('dotenv').config({ quiet: true });
require('../config/timezone');
const pool = require('../db/pool');
const { normalizeStoredPhones } = require('../services/phoneBackfill');

const apply = process.argv.slice(2).includes('--apply');

(async () => {
    try {
        const r = await normalizeStoredPhones({ apply });
        console.log(`${apply ? 'Rewrote' : 'Would rewrite'} ${r.changed} of ${r.scanned} phone numbers not yet stored as ten digits.`);
        for (const f of r.fields) {
            console.log(`  ${f.field.padEnd(46)} ${String(f.changed).padStart(5)} ${apply ? 'rewritten' : 'to rewrite'}${f.leftAlone ? `, ${f.leftAlone} left as they are` : ''}`);
            f.samples.forEach((s) => console.log(`      e.g. ${s}`));
            f.left.forEach((s) => console.log(`      left: ${s}`));
        }
        if (r.skipped) console.log(`  ${r.skipped} saved by someone while this ran (stored by the new rule already)`);
        if (r.leftAlone) console.log(`${r.leftAlone} are not 10-digit mobile numbers (a landline, an extension, a typo): they stay as they are, and their forms ask for a mobile number the next time they are saved.`);
        if (!apply && r.changed) console.log('Run again with --apply to change them.');
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await pool.end().catch(() => {});
        process.exit(process.exitCode || 0);
    }
})();
