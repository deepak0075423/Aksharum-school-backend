'use strict';
/**
 * Bringing records in from a spreadsheet (Oct 2026) — for a school starting
 * the Medical Room with years of paper or Excel behind it.
 *
 *   allergies     admission_number, allergen, category, severity, reaction, emergency_instructions
 *   conditions    admission_number, condition, type, severity, medication, emergency_instructions
 *   vaccinations  admission_number, vaccine, dose, given_on, provider
 *   measurements  admission_number, measured_on, height_cm, weight_kg
 *
 * `preview` reads the CSV and says, row by row, what would happen — the
 * student it matched, what is wrong, what is already on record — and writes
 * nothing. `commit` reads it again and writes the good rows through the
 * Medical Room's own writers (allergies, conditions, vaccinations) or, for a
 * measurement, a completed BMI checkup — so a growth chart starts from the
 * school's history. Families are not messaged for imported history; the desk
 * is told once at the end; the import is one entry in the audit (and each
 * record carries who brought it in).
 */
const pool = require('../db/pool');
const MedicalCheckup = require('../models/MedicalCheckup');
const audit = require('./medicalAudit');
const R = require('./medicalRules');

const { refuse, str } = R;
const MAX_ROWS = 2000;

const KINDS = {
    allergies: { label: 'Allergies', columns: ['admission_number', 'allergen', 'category', 'severity', 'reaction', 'emergency_instructions'], required: ['admission_number', 'allergen'] },
    conditions: { label: 'Medical conditions', columns: ['admission_number', 'condition', 'type', 'severity', 'medication', 'emergency_instructions'], required: ['admission_number', 'condition'] },
    vaccinations: { label: 'Vaccinations', columns: ['admission_number', 'vaccine', 'dose', 'given_on', 'provider'], required: ['admission_number', 'vaccine', 'given_on'] },
    measurements: { label: 'Height and weight', columns: ['admission_number', 'measured_on', 'height_cm', 'weight_kg'], required: ['admission_number', 'measured_on'] },
};

/** CSV text → rows of cells: quotes, doubled quotes, commas and line breaks inside quotes, CRLF, a BOM. */
function parseCsv(text) {
    const s = String(text || '').replace(/^﻿/, '');
    const rows = []; let row = []; let cell = ''; let quoted = false;
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (quoted) {
            if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 1; }
            else if (ch === '"') quoted = false;
            else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && s[i + 1] === '\n') i += 1;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const key = (h) => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const SYN = {
    severity: { 'life threatening': 'life_threatening', 'life-threatening': 'life_threatening', anaphylaxis: 'life_threatening', high: 'severe', low: 'mild', medium: 'moderate' },
    category: { drug: 'medicine', medication: 'medicine', environment: 'environmental', bee: 'insect' },
};
function pick(map, raw, kind, fallback) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v) return { value: fallback, guessed: false };
    const syn = SYN[kind]?.[v] || v.replace(/[\s-]+/g, '_');
    if (Object.prototype.hasOwnProperty.call(map, syn)) return { value: syn, guessed: false };
    const byLabel = Object.entries(map).find(([, l]) => String(typeof l === 'string' ? l : l.label).toLowerCase() === v);
    if (byLabel) return { value: byLabel[0], guessed: false };
    return { value: fallback, guessed: true };
}
/** YYYY-MM-DD, DD/MM/YYYY or DD-MM-YYYY (India's way round) → 'YYYY-MM-DD', or ''. */
function dateOf(raw) {
    const v = String(raw || '').trim();
    let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    let y; let mo; let d;
    if (m) { [, y, mo, d] = m; } else {
        m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
        if (!m) return '';
        [, d, mo, y] = m;
    }
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const t = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? '' : iso;
}

/** What each row would do. Writes nothing. */
async function preview(req, { kind, csv } = {}) {
    const def = KINDS[kind];
    if (!def) refuse('Choose what the file holds');
    const all = parseCsv(csv);
    if (all.length < 2) refuse('The file needs a header row and at least one row');
    const header = all[0].map(key);
    const missing = def.required.filter((c) => !header.includes(c));
    if (missing.length) refuse(`The file has no ${missing.map((c) => `"${c}"`).join(', ')} column — download the template`);
    const body = all.slice(1);
    if (body.length > MAX_ROWS) refuse(`At most ${MAX_ROWS} rows at a time — split the file`);
    const get = (cells, c) => str(cells[header.indexOf(c)] ?? '', 600);
    const adms = [...new Set(body.map((r) => get(r, 'admission_number').toUpperCase()).filter(Boolean))];
    const { rows: found } = adms.length ? await pool.query(
        `SELECT upper(sp."admissionNumber") AS adm, u."_id"::text AS id, u."name", u."isActive" FROM "studentprofiles" sp JOIN "users" u ON u."_id" = sp."user"
          WHERE sp."school" = $1 AND upper(sp."admissionNumber") = ANY($2::text[])`, [String(req.schoolId), adms]) : { rows: [] };
    const byAdm = new Map(found.map((f) => [f.adm, f]));
    // What is already on record, so a second run of the same file adds nothing twice.
    const ids = found.map((f) => f.id);
    const existing = new Set();
    if (ids.length && kind === 'allergies') (await pool.query(`SELECT "student"::text AS s, lower("allergen") AS n FROM "medicalallergies" WHERE "school" = $1 AND "student" = ANY($2::uuid[]) AND "archivedAt" IS NULL`, [String(req.schoolId), ids])).rows.forEach((x) => existing.add(`${x.s}|${x.n}`));
    if (ids.length && kind === 'conditions') (await pool.query(`SELECT "student"::text AS s, lower("condition") AS n FROM "medicalconditions" WHERE "school" = $1 AND "student" = ANY($2::uuid[]) AND "archivedAt" IS NULL`, [String(req.schoolId), ids])).rows.forEach((x) => existing.add(`${x.s}|${x.n}`));
    if (ids.length && kind === 'vaccinations') (await pool.query(`SELECT "student"::text AS s, lower("vaccine") || '|' || to_char("givenOn", 'YYYY-MM-DD') AS n FROM "medicalvaccinations" WHERE "school" = $1 AND "student" = ANY($2::uuid[]) AND "archivedAt" IS NULL AND "givenOn" IS NOT NULL`, [String(req.schoolId), ids])).rows.forEach((x) => existing.add(`${x.s}|${x.n}`));
    if (ids.length && kind === 'measurements') (await pool.query(`SELECT "student"::text AS s, to_char("checkedOn", 'YYYY-MM-DD') AS n FROM "medicalcheckups" WHERE "school" = $1 AND "student" = ANY($2::uuid[]) AND "archivedAt" IS NULL AND "status" = 'completed' AND "type" = 'bmi'`, [String(req.schoolId), ids])).rows.forEach((x) => existing.add(`${x.s}|${x.n}`));
    const inFile = new Set();
    const rows = body.map((cells, i) => {
        const out = { line: i + 2, errors: [], warnings: [], values: {} };
        const adm = get(cells, 'admission_number');
        const st = byAdm.get(adm.toUpperCase());
        out.admissionNumber = adm;
        if (!adm) out.errors.push('No admission number');
        else if (!st) out.errors.push(`No student has admission number ${adm}`);
        else if (st.isActive === false) out.errors.push(`${st.name} has left the school`);
        else { out.student = st.id; out.studentName = st.name; }
        const v = out.values;
        let dupKey = '';
        if (kind === 'allergies') {
            v.allergen = get(cells, 'allergen');
            if (!v.allergen) out.errors.push('No allergen');
            const c = pick(R.ALLERGY_CATEGORY, get(cells, 'category'), 'category', 'other'); v.category = c.value; if (c.guessed) out.warnings.push(`Kind "${get(cells, 'category')}" not known — taken as Other`);
            const sv = pick(R.ALLERGY_SEVERITY, get(cells, 'severity'), 'severity', 'moderate'); v.severity = sv.value; if (sv.guessed || !get(cells, 'severity')) out.warnings.push(get(cells, 'severity') ? `Severity "${get(cells, 'severity')}" not known — taken as Moderate` : 'No severity — taken as Moderate');
            v.reaction = get(cells, 'reaction'); v.emergencyInstructions = get(cells, 'emergency_instructions');
            dupKey = v.allergen.toLowerCase();
        } else if (kind === 'conditions') {
            v.condition = get(cells, 'condition');
            if (!v.condition) out.errors.push('No condition');
            const t = pick(R.CONDITION_TYPE, get(cells, 'type'), 'type', 'other'); v.type = t.value;
            const sv = pick(R.CONDITION_SEVERITY, get(cells, 'severity'), 'severity', 'mild'); v.severity = sv.value; if (sv.guessed) out.warnings.push(`Severity "${get(cells, 'severity')}" not known — taken as Mild`);
            v.medication = get(cells, 'medication'); v.emergencyInstructions = get(cells, 'emergency_instructions');
            dupKey = v.condition.toLowerCase();
        } else if (kind === 'vaccinations') {
            v.vaccine = get(cells, 'vaccine'); v.dose = get(cells, 'dose'); v.provider = get(cells, 'provider');
            v.givenOn = dateOf(get(cells, 'given_on'));
            if (!v.vaccine) out.errors.push('No vaccine');
            if (!v.givenOn) out.errors.push(`Date "${get(cells, 'given_on')}" not understood — use YYYY-MM-DD or DD/MM/YYYY`);
            else if (v.givenOn > R.todayStr()) out.errors.push('The date is in the future');
            dupKey = `${v.vaccine.toLowerCase()}|${v.givenOn}`;
        } else {
            v.measuredOn = dateOf(get(cells, 'measured_on'));
            v.heightCm = get(cells, 'height_cm') === '' ? null : Number(get(cells, 'height_cm'));
            v.weightKg = get(cells, 'weight_kg') === '' ? null : Number(get(cells, 'weight_kg'));
            if (!v.measuredOn) out.errors.push(`Date "${get(cells, 'measured_on')}" not understood — use YYYY-MM-DD or DD/MM/YYYY`);
            else if (v.measuredOn > R.todayStr()) out.errors.push('The date is in the future');
            if (v.heightCm === null && v.weightKg === null) out.errors.push('No height or weight');
            if (v.heightCm !== null && (!Number.isFinite(v.heightCm) || v.heightCm < 40 || v.heightCm > 230)) out.errors.push('Height must be in centimetres (40–230)');
            if (v.weightKg !== null && (!Number.isFinite(v.weightKg) || v.weightKg < 5 || v.weightKg > 250)) out.errors.push('Weight must be in kilograms (5–250)');
            dupKey = v.measuredOn;
        }
        if (out.student && !out.errors.length) {
            const k = `${out.student}|${dupKey}`;
            if (existing.has(k)) out.skip = 'Already on record';
            else if (inFile.has(k)) out.skip = 'Twice in this file';
            inFile.add(k);
        }
        out.ok = !out.errors.length && !out.skip;
        return out;
    });
    return {
        kind, label: def.label, columns: def.columns, rows,
        counts: { rows: rows.length, ok: rows.filter((r) => r.ok).length, errors: rows.filter((r) => r.errors.length).length, skipped: rows.filter((r) => r.skip).length },
    };
}

/** Write the rows that preview says are good. */
async function commit(req, { kind, csv, fileName } = {}) {
    const p = await preview(req, { kind, csv });
    const health = require('./medicalHealth');
    const quiet = req;
    let created = 0; const failed = [];
    // Hundreds of rows would be hundreds of desk refreshes: quiet while writing, one nudge after (the audit entry below).
    req.quietLive = true;
    try {
        for (const r of p.rows.filter((x) => x.ok)) {
            try {
                if (kind === 'allergies' || kind === 'conditions') {
                    await health.addHealthRecord(quiet, kind === 'allergies' ? 'allergy' : 'condition', r.student, { ...r.values, parentNote: 'Imported' });
                } else if (kind === 'vaccinations') {
                    await health.addVaccination(quiet, r.student, { vaccine: r.values.vaccine, dose: r.values.dose, givenOn: r.values.givenOn, provider: r.values.provider, remarks: 'Imported' });
                } else {
                    const results = {};
                    if (r.values.heightCm !== null) results.heightCm = r.values.heightCm;
                    if (r.values.weightKg !== null) results.weightKg = r.values.weightKg;
                    if (results.heightCm && results.weightKg) results.bmi = Math.round((results.weightKg / ((results.heightCm / 100) ** 2)) * 10) / 10;
                    const on = R.toDay(r.values.measuredOn);
                    await MedicalCheckup.create({ school: req.schoolId, student: r.student, type: 'bmi', status: 'completed', checkedOn: on, results, findings: 'Imported', createdBy: req.userId, updatedBy: req.userId });
                    await health.noteMeasurements(quiet, r.student, on, results);
                }
                created += 1;
            } catch (e) { failed.push({ line: r.line, message: e.message }); }
        }
    } finally { req.quietLive = false; }
    await audit.log(req, { action: 'imported', entity: kind, summary: `Imported ${created} ${p.label.toLowerCase()} from ${str(fileName, 120) || 'a CSV file'}${failed.length ? ` (${failed.length} failed)` : ''}${p.counts.skipped ? `, ${p.counts.skipped} already on record` : ''}` });
    return { created, failed, skipped: p.counts.skipped, errors: p.counts.errors };
}

/** The header line (and one example) of each kind's template. */
const TEMPLATES = {
    allergies: 'admission_number,allergen,category,severity,reaction,emergency_instructions\nADM001,Peanuts,food,life_threatening,"Swelling, breathing trouble",Give the auto-injector and call an ambulance\n',
    conditions: 'admission_number,condition,type,severity,medication,emergency_instructions\nADM001,Asthma,asthma,moderate,Salbutamol inhaler,Two puffs; call the nurse if no better in 10 minutes\n',
    vaccinations: 'admission_number,vaccine,dose,given_on,provider\nADM001,MMR,Dose 2,2017-03-15,City Hospital\n',
    measurements: 'admission_number,measured_on,height_cm,weight_kg\nADM001,2026-04-12,138.5,31.2\n',
};

module.exports = { KINDS, TEMPLATES, parseCsv, dateOf, preview, commit };
