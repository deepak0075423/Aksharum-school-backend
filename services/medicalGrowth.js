'use strict';
/**
 * Growth against the WHO charts (Oct 2026): a height and weight become a
 * z-score, a percentile and a plain-words band for BMI-for-age, height-for-age
 * and (up to 10 years) weight-for-age.
 *
 *   2 to 5 years   WHO Child Growth Standards (2006)
 *   5 to 19 years  WHO Growth Reference (2007)
 *
 * The LMS numbers are WHO's own tables (assets/growth/who-growth.json — its
 * `source` says where each came from). The method is WHO's: L, M and S are
 * read between whole months by straight-line interpolation; weight and BMI
 * beyond ±3 SD are measured in the fixed SD-distance WHO uses there (their
 * curves skew); a z-score past WHO's plausibility limits is reported as
 * "check this measurement" rather than as a finding.
 *
 * Nothing here is stored — a corrected date of birth or measurement corrects
 * every chart at once.
 */
const pool = require('../db/pool');
const R = require('./medicalRules');
const DATA = require('../assets/growth/who-growth.json');

const DAYS_PER_MONTH = 30.4375;
const CENTILES = [3, 15, 50, 85, 97];
// z for the 3rd, 15th, 50th, 85th and 97th percentiles.
const Z_OF = { 3: -1.880794, 15: -1.036433, 50: 0, 85: 1.036433, 97: 1.880794 };

const INDICATORS = {
    bmi:    { label: 'BMI-for-age', unit: 'kg/m²', adjust: true, implausible: (z) => Math.abs(z) > 5 },
    height: { label: 'Height-for-age', unit: 'cm', adjust: false, implausible: (z) => Math.abs(z) > 6 },
    weight: { label: 'Weight-for-age', unit: 'kg', adjust: true, implausible: (z) => z < -6 || z > 5 },
};

/** 1 (male) or 2 (female) — WHO's coding — or null when the record does not say. */
function sexOf(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (['1', 'm', 'male', 'boy'].includes(s)) return 1;
    if (['2', 'f', 'female', 'girl'].includes(s)) return 2;
    return null;
}

/** Age in months (WHO: days ÷ 30.4375) on a day. */
function ageMonths(dob, on = R.todayStr()) {
    const a = R.dayStr(dob); const b = R.dayStr(on);
    if (!a || !b) return null;
    const days = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
    return days < 0 ? null : days / DAYS_PER_MONTH;
}

/** L, M, S for an indicator at an age (months), or null outside the tables. */
function lms(indicator, sex, age) {
    const t = DATA[indicator]?.[String(sex)];
    if (!t || age === null || age === undefined || Number.isNaN(age)) return null;
    const first = t[0][0]; const last = t[t.length - 1][0];
    if (age < first || age > last) return null;
    const lo = Math.floor(age);
    const a = t[lo - first]; const b = t[Math.min(lo + 1, last) - first];
    if (!a || !b || a[0] !== lo) return null;
    const f = age - lo;
    return { L: a[1] + (b[1] - a[1]) * f, M: a[2] + (b[2] - a[2]) * f, S: a[3] + (b[3] - a[3]) * f };
}

/** The measurement at z standard deviations. */
function valueAt({ L, M, S }, z) {
    return Math.abs(L) < 1e-7 ? M * Math.exp(S * z) : M * (1 + L * S * z) ** (1 / L);
}

function zscore(y, p, adjust) {
    let z = Math.abs(p.L) < 1e-7 ? Math.log(y / p.M) / p.S : ((y / p.M) ** p.L - 1) / (p.L * p.S);
    if (adjust && z > 3) {
        const sd3 = valueAt(p, 3); const sd2 = valueAt(p, 2);
        z = 3 + (y - sd3) / (sd3 - sd2);
    } else if (adjust && z < -3) {
        const sd3 = valueAt(p, -3); const sd2 = valueAt(p, -2);
        z = -3 + (y - sd3) / (sd2 - sd3);
    }
    return z;
}

/** The standard normal distribution (Abramowitz & Stegun 7.1.26; error < 1.5e-7). */
function phi(z) {
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

const ordinal = (n) => {
    const v = Math.round(n);
    const s = (v % 100 >= 11 && v % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
    return `${v}${s}`;
};

function centileLabel(c) {
    if (c < 0.1) return 'below the 0.1th percentile';
    if (c > 99.9) return 'above the 99.9th percentile';
    if (c < 1) return `${c.toFixed(1)}th percentile`;
    return `${ordinal(c)} percentile`;
}

/** WHO's words for where a z-score falls. [key, label, tone] */
function band(indicator, z, under5) {
    if (indicator === 'bmi') {
        if (under5) {
            if (z < -3) return ['severe_wasting', 'Severe wasting', 'red'];
            if (z < -2) return ['wasting', 'Wasting', 'amber'];
            if (z <= 1) return ['healthy', 'Healthy weight', 'green'];
            if (z <= 2) return ['risk_overweight', 'At risk of overweight', 'amber'];
            if (z <= 3) return ['overweight', 'Overweight', 'amber'];
            return ['obese', 'Obese', 'red'];
        }
        if (z < -3) return ['severe_thinness', 'Severe thinness', 'red'];
        if (z < -2) return ['thinness', 'Thinness', 'amber'];
        if (z <= 1) return ['healthy', 'Healthy weight', 'green'];
        if (z <= 2) return ['overweight', 'Overweight', 'amber'];
        return ['obese', 'Obese', 'red'];
    }
    if (indicator === 'height') {
        if (z < -3) return ['severe_stunting', 'Severely short for age', 'red'];
        if (z < -2) return ['stunting', 'Short for age', 'amber'];
        if (z > 3) return ['very_tall', 'Very tall for age', 'amber'];
        return ['normal', 'Normal height for age', 'green'];
    }
    if (z < -3) return ['severe_underweight', 'Severely underweight', 'red'];
    if (z < -2) return ['underweight', 'Underweight', 'amber'];
    if (z > 2) return ['heavy', 'Heavy for age — see BMI', 'amber'];
    return ['normal', 'Normal weight for age', 'green'];
}

/** Bands that a school nurse should act on (a referral is suggested). */
const CONCERN = new Set(['severe_thinness', 'severe_wasting', 'obese', 'severe_stunting', 'severe_underweight']);
const WATCH = new Set(['thinness', 'wasting', 'overweight', 'risk_overweight', 'stunting', 'underweight', 'very_tall', 'heavy']);

function indicator(key, y, sex, age) {
    const p = lms(key, sex, age);
    if (!p || !(y > 0)) return null;
    const def = INDICATORS[key];
    const z = zscore(y, p, def.adjust);
    if (!Number.isFinite(z)) return null;
    if (def.implausible(z)) {
        return { key, label: def.label, value: y, unit: def.unit, z: Math.round(z * 100) / 100, centile: null, centileLabel: '', band: 'check', bandLabel: 'Check this measurement', tone: 'slate', implausible: true, concern: false };
    }
    const c = Math.round(phi(z) * 1000) / 10;
    const [b, bl, tone] = band(key, z, age < 61);
    return {
        key, label: def.label, value: y, unit: def.unit, z: Math.round(z * 100) / 100, centile: c, centileLabel: centileLabel(phi(z) * 100),
        band: b, bandLabel: bl, tone, implausible: false, concern: CONCERN.has(b), watch: WATCH.has(b),
    };
}

/**
 * assess({ sex, dob, on, heightCm, weightKg })
 * → { on, ageMonths, ageLabel, reference, bmi, indicators: { bmi, height, weight }, note }
 */
function assess({ sex, dob, on = R.todayStr(), heightCm, weightKg }) {
    const h = Number(heightCm) > 0 ? Number(heightCm) : null;
    const w = Number(weightKg) > 0 ? Number(weightKg) : null;
    const out = {
        on: R.dayStr(on), heightCm: h, weightKg: w,
        bmi: h && w ? Math.round((w / ((h / 100) ** 2)) * 10) / 10 : null,
        ageMonths: null, ageLabel: '', reference: '', indicators: {}, note: '', concern: false,
    };
    if (!dob) { out.note = 'Add the date of birth to compare with the WHO growth charts'; return out; }
    const age = ageMonths(dob, on);
    if (age === null) { out.note = 'The measurement is dated before the date of birth'; return out; }
    out.ageMonths = Math.round(age * 10) / 10;
    out.ageLabel = `${Math.floor(age / 12)} y ${Math.floor(age % 12)} m`;
    const sx = sexOf(sex);
    if (!sx) { out.note = 'Add whether the student is a boy or a girl to compare with the WHO growth charts'; return out; }
    if (age < 24 || age > 228) { out.note = 'The WHO charts used here cover 2 to 19 years'; return out; }
    out.reference = age < 61 ? 'WHO Child Growth Standards (2006)' : 'WHO Growth Reference (2007)';
    const bmi = out.bmi ? indicator('bmi', out.bmi, sx, age) : null;
    const height = h ? indicator('height', h, sx, age) : null;
    const weight = w && age <= 120 ? indicator('weight', w, sx, age) : null;
    out.indicators = { ...(bmi ? { bmi } : {}), ...(height ? { height } : {}), ...(weight ? { weight } : {}) };
    out.concern = Object.values(out.indicators).some((x) => x.concern);
    return out;
}

/** The 3rd–97th percentile curves of an indicator, month by month, for a chart. */
function curves(key, sex, fromMonths, toMonths) {
    const sx = sexOf(sex);
    const t = DATA[key]?.[String(sx)];
    if (!t) return null;
    const first = t[0][0]; const last = t[t.length - 1][0];
    const from = Math.max(first, Math.floor(fromMonths)); const to = Math.min(last, Math.ceil(toMonths));
    const rows = [];
    for (let m = from; m <= to; m += 1) {
        const p = lms(key, sx, m);
        if (p) rows.push([m, ...CENTILES.map((c) => Math.round(valueAt(p, Z_OF[c]) * 10) / 10)]);
    }
    return { key, label: INDICATORS[key].label, unit: INDICATORS[key].unit, centiles: CENTILES, rows };
}

/**
 * A student's measurements over time — their checkups and the profile's
 * latest — each assessed; one point per day.
 */
async function seriesOf(schoolId, student) {
    const [checkups, profiles] = await Promise.all([
        pool.query(
            `SELECT "_id"::text AS id, "checkedOn" AS on, "results" FROM "medicalcheckups"
              WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND "status" = 'completed' AND "checkedOn" IS NOT NULL
                AND (("results"->>'heightCm') IS NOT NULL OR ("results"->>'weightKg') IS NOT NULL)
              ORDER BY "checkedOn"`, [String(schoolId), String(student._id)]).then((r) => r.rows),
        pool.query(`SELECT "heightCm","weightKg","measuredOn" FROM "medicalprofiles" WHERE "school" = $1 AND "student" = $2 LIMIT 1`,
            [String(schoolId), String(student._id)]).then((r) => r.rows),
    ]);
    const byDay = new Map();
    for (const c of checkups) {
        const day = R.dayStr(c.on);
        const prev = byDay.get(day) || {};
        byDay.set(day, { on: day, heightCm: Number(c.results?.heightCm) || prev.heightCm || null, weightKg: Number(c.results?.weightKg) || prev.weightKg || null, source: 'checkup', checkup: c.id });
    }
    const p = profiles[0];
    if (p && (p.heightCm || p.weightKg)) {
        const day = p.measuredOn ? R.dayStr(p.measuredOn) : R.todayStr();
        if (!byDay.has(day)) byDay.set(day, { on: day, heightCm: Number(p.heightCm) || null, weightKg: Number(p.weightKg) || null, source: 'profile' });
    }
    return [...byDay.values()].sort((a, b) => (a.on < b.on ? -1 : 1))
        .map((m) => ({ ...m, ...assess({ sex: student.gender, dob: student.dob, on: m.on, heightCm: m.heightCm, weightKg: m.weightKg }) }));
}

/** Everything a growth panel needs: the points, the latest, and the curves around them. */
async function forStudent(schoolId, student) {
    const points = await seriesOf(schoolId, student);
    const sx = sexOf(student.gender);
    const latest = points.length ? points[points.length - 1] : null;
    const ages = points.map((p) => p.ageMonths).filter((a) => a !== null && a >= 24 && a <= 228);
    const nowAge = ageMonths(student.dob, R.todayStr());
    let from = ages.length ? Math.min(...ages) : nowAge; let to = ages.length ? Math.max(...ages) : nowAge;
    if (from !== null && to !== null) { from = Math.max(24, Math.floor((from - 12) / 12) * 12); to = Math.min(228, Math.ceil((to + 12) / 12) * 12); }
    const chartable = !!(sx && student.dob && from !== null && to !== null && to > from);
    return {
        sex: sx === 1 ? 'male' : sx === 2 ? 'female' : null,
        dob: student.dob || null,
        note: !student.dob ? 'Add the date of birth to compare with the WHO growth charts'
            : !sx ? 'Add whether the student is a boy or a girl to compare with the WHO growth charts' : '',
        points,
        latest,
        curves: chartable ? { bmi: curves('bmi', sx, from, to), height: curves('height', sx, from, to) } : null,
        source: 'WHO Child Growth Standards (2006, under 5) and WHO Growth Reference (2007, 5–19 years)',
    };
}

module.exports = { assess, curves, forStudent, seriesOf, ageMonths, sexOf, lms, zscore, phi, CONCERN, WATCH, INDICATORS };
