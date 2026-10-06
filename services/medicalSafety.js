'use strict';
/**
 * The checks made before any medicine is given (Oct 2026) — from a plan, as
 * needed, inside a visit, or a scheduled dose recorded as given.
 *
 *   allergy    the medicine (its name, generic name or drug class) matches an
 *              allergy on the child's record — a penicillin allergy stops
 *              amoxicillin; a cephalosporin after a penicillin allergy is a
 *              warning (cross-reaction is possible, not certain)
 *   interval   the same medicine (same generic, or the same class — Crocin and
 *              Dolo are both paracetamol) was given too recently
 *   daily_max  it has already been given as often as it may be in 24 hours
 *
 * A BLOCK stops the dose until someone gives a reason to go ahead
 * (`override: { reason }`) — then the dose carries the checks it overrode, the
 * audit log says who, and an allergy override is sent to the medical staff.
 * A WARNING is shown and does not stop anything.
 *
 * The gap and the daily maximum come from the plan, then the stock item, then
 * the medicine's class (paracetamol: 4 h and 4 a day; ibuprofen and other
 * NSAIDs: 6 h and 3 a day). A medicine with none of these is only checked for
 * being given twice within the hour.
 */
const pool = require('../db/pool');
const { str, refuse, instantLabel } = require('./medicalRules');

/* ── Drug classes ─────────────────────────────────────────────────────────── */

// Generic names and the brands a school is likely to stock. A brand that
// combines two drugs is in both classes (Combiflam: ibuprofen + paracetamol).
const CLASSES = {
    paracetamol:   { label: 'paracetamol', terms: ['paracetamol', 'acetaminophen', 'crocin', 'calpol', 'dolo', 'tylenol', 'pacimol', 'combiflam', 'sumo'], minHours: 4, maxPerDay: 4 },
    nsaid:         { label: 'an NSAID (ibuprofen family)', terms: ['nsaid', 'ibuprofen', 'brufen', 'combiflam', 'diclofenac', 'voveran', 'aspirin', 'disprin', 'acetylsalicylic', 'naproxen', 'mefenamic', 'meftal', 'ketorolac', 'nimesulide', 'aceclofenac', 'sumo'], minHours: 6, maxPerDay: 3 },
    penicillin:    { label: 'a penicillin', terms: ['penicillin', 'amoxicillin', 'amoxycillin', 'ampicillin', 'cloxacillin', 'flucloxacillin', 'piperacillin', 'augmentin', 'amoxiclav', 'novamox'] },
    cephalosporin: { label: 'a cephalosporin', terms: ['cephalosporin', 'cefixime', 'cephalexin', 'cefalexin', 'cefuroxime', 'ceftriaxone', 'cefadroxil', 'cefpodoxime', 'cefdinir', 'taxim', 'zifi'] },
    sulfa:         { label: 'a sulfa drug', terms: ['sulfa', 'sulpha', 'sulfonamide', 'sulphonamide', 'sulfamethoxazole', 'cotrimoxazole', 'co-trimoxazole', 'septran', 'bactrim', 'sulfadiazine'] },
    macrolide:     { label: 'a macrolide', terms: ['macrolide', 'azithromycin', 'azithral', 'azee', 'erythromycin', 'clarithromycin'] },
    opioid:        { label: 'an opioid', terms: ['opioid', 'codeine', 'tramadol', 'morphine'] },
};
// Allergic to the first: the second is a caution, not a refusal.
const CROSS = { penicillin: ['cephalosporin'] };

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
// A term matches the start of a word: "Dolo650" is dolo, "Augmentin 625" augmentin.
const hasWord = (text, term) => norm(text).includes(` ${norm(term).trim()}`);

function classesOf(text) {
    const out = new Set();
    for (const [key, c] of Object.entries(CLASSES)) {
        if (c.terms.some((term) => hasWord(text, term))) out.add(key);
    }
    return out;
}

/** The words of an allergen that could name a medicine (not "allergy", "drugs" …). */
const NOISE = new Set(['allergy', 'allergic', 'to', 'drug', 'drugs', 'medicine', 'medicines', 'tablet', 'tablets', 'syrup', 'mg', 'ml', 'and', 'or', 'the', 'of', 'all', 'group']);
function words(text) {
    return norm(text).trim().split(' ').filter((w) => w.length >= 4 && !NOISE.has(w) && !/^\d+$/.test(w));
}

/** What a medicine is called, every way: { text, generic, classes }. */
function describe({ medicineName = '', item = null }) {
    const text = [medicineName, item?.name, item?.genericName, item?.category].filter(Boolean).join(' ');
    return { text, name: medicineName || item?.name || '', generic: norm(item?.genericName || '').trim(), classes: classesOf(text) };
}

/* ── Allergy ──────────────────────────────────────────────────────────────── */

function allergyProblems(allergies, med) {
    const blocks = [];
    const warnings = [];
    const medText = norm(med.text);
    for (const a of allergies) {
        if (a.archivedAt || a.status === 'resolved') continue;
        const allergen = String(a.allergen || '');
        const label = `${allergen}${a.severity ? ` (${String(a.severity).replace('_', '-')})` : ''}`;
        const aClasses = classesOf(allergen);
        // "Peanuts" on the record still catches "Peanut oil".
        const direct = words(allergen).some((w) => medText.includes(` ${w}`) || (w.length > 4 && w.endsWith('s') && medText.includes(` ${w.slice(0, -1)}`)));
        const sameClass = [...aClasses].find((c) => med.classes.has(c));
        if (direct || sameClass) {
            const why = sameClass && !direct ? ` — it is ${CLASSES[sameClass].label}` : '';
            // A food or environmental allergy that happens to share a word is worth a look, not a stop.
            if (a.category === 'medicine' || a.category === 'other' || sameClass) {
                blocks.push({ code: 'allergy', message: `Allergy on record: ${label}${why}` });
            } else {
                warnings.push({ code: 'allergy_word', message: `Check: the record lists an allergy to ${label}` });
            }
            continue;
        }
        for (const c of aClasses) {
            const cross = (CROSS[c] || []).find((x) => med.classes.has(x));
            if (cross) warnings.push({ code: 'allergy_cross', message: `Allergy to ${label}: ${CLASSES[cross].label} can cross-react — check with the doctor` });
        }
    }
    return { blocks, warnings };
}

/* ── Interval and daily maximum ───────────────────────────────────────────── */

/**
 * Doses of the same medicine given in the last 24 hours: the same stock item
 * or plan, the same generic, the same timed class (paracetamol, NSAIDs), or —
 * for a medicine nobody can place — the same name.
 */
async function recentSame(schoolId, studentId, med, { excludeDose = null, itemId = null, planId = null } = {}) {
    const { rows } = await pool.query(
        `SELECT d."_id"::text AS id, d."medicineName", d."dosage", d."givenAt", d."givenByName",
                d."item"::text AS item, d."plan"::text AS plan,
                i."name" AS "itemName", i."genericName", i."category"
           FROM "medicationdoses" d LEFT JOIN "medicalitems" i ON i."_id" = d."item"
          WHERE d."school" = $1 AND d."student" = $2 AND d."status" = 'given'
            AND d."givenAt" > now() - interval '24 hours'
            ${excludeDose ? 'AND d."_id"::text <> $3' : ''}
          ORDER BY d."givenAt" DESC`,
        excludeDose ? [String(schoolId), String(studentId), String(excludeDose)] : [String(schoolId), String(studentId)],
    );
    const myName = norm(med.name).trim();
    return rows.filter((r) => {
        if (itemId && r.item === String(itemId)) return true;
        if (planId && r.plan === String(planId)) return true;
        const other = describe({ medicineName: r.medicineName, item: r.itemName ? { name: r.itemName, genericName: r.genericName, category: r.category } : null });
        if (med.generic && other.generic && med.generic === other.generic) return true;
        if ([...med.classes].some((c) => other.classes.has(c) && CLASSES[c].minHours)) return true;
        return !!myName && norm(r.medicineName).trim() === myName;
    });
}

/**
 * The rule that applies: the plan's, else the stock item's, else the class's
 * (the longest gap and the smallest daily number of the classes it is in).
 */
function limitsFor(med, { plan = null, item = null }) {
    const first = (k) => [plan?.[k], item?.[k]].map((v) => (v === null || v === undefined || v === '' ? NaN : Number(v)))
        .find((n) => Number.isFinite(n) && n > 0) ?? null;
    const cls = [...med.classes].map((c) => CLASSES[c]);
    const gaps = cls.map((c) => c.minHours).filter((n) => n > 0);
    const maxes = cls.map((c) => c.maxPerDay).filter((n) => n > 0);
    return {
        minHours: first('minHoursBetween') ?? (gaps.length ? Math.max(...gaps) : null),
        maxPerDay: first('maxPerDay') ?? (maxes.length ? Math.min(...maxes) : null),
    };
}

const hoursAgo = (at) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
    return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''} ago`;
};

/* ── The check ────────────────────────────────────────────────────────────── */

/**
 * check(schoolId, studentId, { medicineName, item, plan, excludeDose })
 * → { blocks: [{code, message}], warnings: [...], recent: [{ name, dosage, at, by }] }
 */
async function check(schoolId, studentId, { medicineName = '', item = null, plan = null, excludeDose = null } = {}) {
    const med = describe({ medicineName: medicineName || plan?.medicineName || '', item });
    const { rows: allergies } = await pool.query(
        `SELECT "allergen", "category", "severity", "status", "archivedAt" FROM "medicalallergies"
          WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND COALESCE("status", 'active') <> 'resolved'`,
        [String(schoolId), String(studentId)],
    );
    const { blocks, warnings } = allergyProblems(allergies, med);
    // An everyday medicine from the school's stock: did the parents agree to its kind this year?
    if (!plan && item) {
        const settings = await require('./medicalSettings').get(schoolId);
        const c = await require('./medicalConsent').doseCheck(schoolId, studentId, item, settings);
        if (c) (c.block ? blocks : warnings).push({ code: c.code, message: c.message });
    }

    const recent = await recentSame(schoolId, studentId, med, { excludeDose, itemId: item?._id, planId: plan?._id });
    const { minHours, maxPerDay } = limitsFor(med, { plan, item });
    const name = medicineName || plan?.medicineName || item?.name || 'This medicine';
    if (recent.length) {
        const last = recent[0];
        const gapH = (Date.now() - new Date(last.givenAt).getTime()) / 3600000;
        if (minHours && gapH < minHours) {
            blocks.push({ code: 'interval', message: `${last.medicineName} was given ${hoursAgo(last.givenAt)} (${instantLabel(last.givenAt)}) — at least ${minHours} h must pass between doses` });
        } else if (!minHours && gapH < 1) {
            warnings.push({ code: 'repeat', message: `${last.medicineName} was given ${hoursAgo(last.givenAt)}` });
        }
        if (maxPerDay && recent.length >= maxPerDay) {
            blocks.push({ code: 'daily_max', message: `${name} has been given ${recent.length} time${recent.length === 1 ? '' : 's'} in the last 24 hours — the most allowed is ${maxPerDay}` });
        }
    }
    return {
        blocks, warnings,
        limits: { minHours, maxPerDay },
        recent: recent.map((r) => ({ id: r.id, name: r.medicineName, dosage: r.dosage, at: r.givenAt, by: r.givenByName })),
    };
}

/**
 * Stop a dose that fails a check, unless `override.reason` says why it goes
 * ahead. Returns the overrides to store on the dose (empty when none).
 */
async function enforce(req, studentId, ctx, override) {
    const out = await check(req.schoolId, studentId, ctx);
    if (!out.blocks.length) return { overrides: [], warnings: out.warnings };
    const reason = str(override?.reason, 300);
    if (!reason) {
        refuse(out.blocks.map((b) => b.message).join('. '), 409, 'MEDICAL_SAFETY', { problems: out.blocks, warnings: out.warnings, recent: out.recent });
    }
    const at = new Date();
    return {
        overrides: out.blocks.map((b) => ({ ...b, reason, by: String(req.userId), byName: req.user?.name || '', at })),
        warnings: out.warnings,
    };
}

/** Every dose given to a student in the last `hours` (default 24), newest first — for the give screens. */
async function recentDoses(schoolId, studentId, hours = 24) {
    const h = Math.min(Math.max(Number(hours) || 24, 1), 168);
    const { rows } = await pool.query(
        `SELECT d."_id"::text AS id, d."medicineName", d."dosage", d."quantity", d."givenAt", d."givenByName", d."source",
                d."safetyOverrides", i."genericName"
           FROM "medicationdoses" d LEFT JOIN "medicalitems" i ON i."_id" = d."item"
          WHERE d."school" = $1 AND d."student" = $2 AND d."status" = 'given' AND d."givenAt" > now() - make_interval(hours => $3::int)
          ORDER BY d."givenAt" DESC LIMIT 50`,
        [String(schoolId), String(studentId), h],
    );
    return rows;
}

module.exports = { CLASSES, classesOf, describe, check, enforce, recentDoses, allergyProblems };
