'use strict';
/**
 * Phone numbers stored before Oct 2026 as they were typed — "+91 98765 43210",
 * "098765-43210", "98765 43210" — rewritten as the ten digits every phone
 * field now holds (utils/validators normalizePhone; scripts/normalizePhones.js
 * by hand, db/migrate.js once on the first boot of a server that has it).
 *
 * Only a value that BECOMES a valid 10-digit mobile number is changed, so the
 * rewrite only ever drops spaces, dashes, brackets, +91 or a leading 0. A
 * landline ("+91 20 2543 1100"), a number with an extension, or anything else
 * is left exactly as it is — counted, and asked for again the next time its
 * form is saved. Snapshots kept as history (payslips, printed ID cards, call
 * logs) are not touched. Safe to run any number of times.
 *
 * At boot the server is already answering while this runs, so a row is only
 * written if it still holds the value that was read; one saved meanwhile went
 * through the new rule anyway, and is left alone (counted in `skipped`).
 */
const pool = require('../db/pool');
const { normalizePhone, isPhone } = require('../utils/validators');

// [table, column, key] — `key` when the number sits inside a jsonb column.
const FIELDS = [
    ['users', 'phone'],
    ['schools', 'phone'],
    ['studentprofiles', 'emergencyContactPhone'],
    ['studentprofiles', 'previousSchoolContact'],
    ['teacherprofiles', 'emergencyContactPhone'],
    ['teacherprofiles', 'alternatePhone'],
    ['parentprofiles', 'father', 'phone'],
    ['parentprofiles', 'mother', 'phone'],
    ['parentprofiles', 'guardian', 'phone'],
    ['parentprofiles', 'emergencyContact'],
    ['hostels', 'contactNumber'],
    ['hosteladmissions', 'guardianPhone'],
    ['hosteladmissions', 'emergencyContactPhone'],
    ['hostelleaves', 'guardianPhone'],
    ['hosteloutpasses', 'guardianPhone'],
    ['hostelvisitors', 'mobile'],
    ['hostelmesses', 'vendorContact'],
    ['idcardsettingses', 'phone'],
    ['inventoryvendors', 'phone'],
    ['inventorywarehouses', 'phone'],
    ['medicalcareplans', 'doctorPhone'],
    ['medicalprofiles', 'doctor', 'phone'],
    ['medicalprofiles', 'hospital', 'phone'],
    ['medicalprofiles', 'alternateContact', 'phone'],
    ['medicalsettingses', 'roomPhone'],
    ['medicalstaffhealths', 'emergencyContact', 'phone'],
    ['medicalstaffhealths', 'doctor', 'phone'],
    ['medicalvisits', 'collection', 'phone'],
    ['transportsettingses', 'contactPhone'],
    ['transportstaffs', 'phone'],
    ['transportstaffs', 'emergencyContact', 'phone'],
];

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function normalizeStoredPhones({ apply = false } = {}) {
    const { rows: cols } = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`,
    );
    const has = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    const fields = [];
    const total = { scanned: 0, changed: 0, skipped: 0, leftAlone: 0 };
    for (const [table, column, key] of FIELDS) {
        if (!has.has(`${table}.${column}`)) continue;       // a module this database has never created
        const read = key ? `${q(column)}->>'${key}'` : q(column);
        // Already ten digits: nothing to look at.
        const { rows } = await pool.query(
            `SELECT "_id", ${read} AS "v" FROM ${q(table)} WHERE COALESCE(${read}, '') <> '' AND ${read} !~ '^[6-9][0-9]{9}$'`,
        );
        const out = { field: key ? `${table}.${column}.${key}` : `${table}.${column}`, scanned: rows.length, changed: 0, skipped: 0, leftAlone: 0, samples: [], left: [] };
        for (const row of rows) {
            const next = normalizePhone(row.v);
            if (next === row.v || !isPhone(next)) {
                out.leftAlone += 1;
                if (out.left.length < 3) out.left.push(row.v);
                continue;
            }
            if (apply) {
                const set = key ? `${q(column)} = jsonb_set(${q(column)}, '{${key}}', to_jsonb($2::text))` : `${q(column)} = $2`;
                const res = await pool.query(`UPDATE ${q(table)} SET ${set} WHERE "_id" = $1 AND ${read} = $3`, [row._id, next, row.v]);
                if (!res.rowCount) { out.skipped += 1; continue; }
            }
            out.changed += 1;
            if (out.samples.length < 3) out.samples.push(`${row.v} → ${next}`);
        }
        for (const k of Object.keys(total)) total[k] += out[k];
        if (out.scanned) fields.push(out);
    }
    return { ...total, fields };
}

module.exports = { normalizeStoredPhones, FIELDS };
