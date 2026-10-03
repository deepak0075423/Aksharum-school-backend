'use strict';
/**
 * A school's Results settings, read and checked in one place (Oct 2026):
 *
 *   grading       the scale a percentage becomes a grade on — standard A+–F,
 *                 CBSE's 9-point A1–E2, a five-point A–E, or the school's own
 *   exam types    the built-in three, renamed if the school likes, and its own
 *                 ("Half Yearly", "Pre-Board") — each BEHAVES as one of the
 *                 three kinds, and only a Final-kind type can promote
 *   report cards  the co-scholastic areas and their grades, and what a report
 *                 card shows
 *   reminders     when teachers are reminded about marks still to enter
 *
 * Nothing else in the module may decide a grade: services/resultExams, the
 * class tests, the overall result, the review and the report card all grade
 * through gradeFor / overallGrade here, with the school's scale.
 *
 * The grade rule holds on every scale: a grade never contradicts the result
 * beside it. Each band says whether it is a passing grade; a student who did
 * not pass gets the highest failing grade, and one who did is never given a
 * failing one — however the percentage falls against the school's pass mark.
 */
const pool = require('../db/pool');
const ResultSettings = require('../models/ResultSettings');
const FormalExam = require('../models/FormalExam');
const clock = require('./schoolClock');
const { patch } = require('../db/patch');

class SettingsError extends Error {
    constructor(message) { super(message); this.status = 400; }
}
const bad = (message) => { throw new SettingsError(message); };

/* ── Grading scales ───────────────────────────────────────────────────────── */

const band = (grade, min, point, pass = true) => ({ grade, min, point, pass });
const PRESETS = {
    standard: {
        label: 'Standard (A+ to F)',
        bands: [band('A+', 90, null), band('A', 80, null), band('B+', 70, null), band('B', 60, null), band('C', 50, null), band('D', 40, null), band('F', 0, null, false)],
    },
    cbse9: {
        label: 'CBSE 9-point (A1 to E2)',
        bands: [band('A1', 91, 10), band('A2', 81, 9), band('B1', 71, 8), band('B2', 61, 7), band('C1', 51, 6), band('C2', 41, 5), band('D', 33, 4),
            band('E1', 21, 0, false), band('E2', 0, 0, false)],
    },
    five: {
        label: 'Five-point (A to E)',
        bands: [band('A', 80, null), band('B', 60, null), band('C', 45, null), band('D', 33, null), band('E', 0, null, false)],
    },
};
const DEFAULT_SCALE = { preset: 'standard', label: PRESETS.standard.label, bands: PRESETS.standard.bands };

/**
 * A custom scale, checked: 2 to 12 bands, each a short unique grade with a
 * minimum percentage, highest first, the lowest starting at 0; every passing
 * grade above every failing one, and at least one of each.
 */
function checkBands(raw) {
    if (!Array.isArray(raw)) bad('Give the grading scale as a list of grades');
    if (raw.length < 2 || raw.length > 12) bad('A grading scale has between 2 and 12 grades');
    const bands = raw.map((b, i) => {
        const grade = String(b?.grade ?? '').trim();
        if (!grade) bad(`Grade ${i + 1} has no name`);
        if (grade.length > 6) bad(`"${grade}" is too long for a grade (6 characters at most)`);
        if (grade.toUpperCase() === 'AB') bad('"AB" is kept for an absent paper — choose another grade name');
        const min = Number(b?.min);
        if (!Number.isFinite(min) || min < 0 || min > 100) bad(`${grade}: the lowest percentage must be between 0 and 100`);
        const point = b?.point === null || b?.point === undefined || b?.point === '' ? null : Number(b.point);
        if (point !== null && (!Number.isFinite(point) || point < 0 || point > 10)) bad(`${grade}: a grade point is between 0 and 10`);
        return { grade, min: Math.round(min * 100) / 100, point, pass: b?.pass !== false };
    }).sort((a, b) => b.min - a.min);
    const names = new Set(bands.map((b) => b.grade.toUpperCase()));
    if (names.size !== bands.length) bad('Two grades have the same name');
    if (new Set(bands.map((b) => b.min)).size !== bands.length) bad('Two grades start at the same percentage');
    if (bands[bands.length - 1].min !== 0) bad('The lowest grade must start at 0%');
    if (!bands.some((b) => b.pass)) bad('At least one grade must be a passing grade');
    if (!bands.some((b) => !b.pass)) bad('At least one grade must be a failing grade — the grade for a paper that is not passed');
    const lowestPass = Math.min(...bands.filter((b) => b.pass).map((b) => b.min));
    if (bands.some((b) => !b.pass && b.min > lowestPass)) bad('Every passing grade must be above every failing grade');
    return bands;
}

function scaleFrom(row) {
    const preset = row?.gradePreset || 'standard';
    if (preset === 'custom') {
        try {
            const bands = checkBands(row.gradeBands);
            return { preset, label: 'Custom', bands };
        } catch { return DEFAULT_SCALE; }
    }
    const p = PRESETS[preset] || PRESETS.standard;
    return { preset: PRESETS[preset] ? preset : 'standard', label: p.label, bands: p.bands };
}

const bandFor = (scale, pct) => (scale || DEFAULT_SCALE).bands.find((b) => pct >= b.min) || (scale || DEFAULT_SCALE).bands.at(-1);
const lowestPass = (scale) => (scale || DEFAULT_SCALE).bands.filter((b) => b.pass).at(-1);
const highestFail = (scale) => (scale || DEFAULT_SCALE).bands.find((b) => !b.pass);

/**
 * A paper's grade. Absent is AB; a paper not passed gets a failing grade (the
 * highest one, when its percentage would have been a pass); a paper passed is
 * never given a failing grade (the lowest passing one, when its percentage
 * would have been a fail).
 */
function gradeFor(marks, max, passed, absent = false, scale = DEFAULT_SCALE) {
    if (absent) return 'AB';
    const b = bandFor(scale, max > 0 ? (marks / max) * 100 : 0);
    if (passed && !b.pass) return lowestPass(scale).grade;
    if (!passed && b.pass) return highestFail(scale).grade;
    return b.grade;
}
/**
 * A whole result's grade: the band its percentage falls in — never a failing
 * one for a student who passed. A student who failed a subject keeps the band
 * of their percentage: the result beside it says they did not pass.
 */
function overallGrade(pct, passed, scale = DEFAULT_SCALE) {
    const b = bandFor(scale, pct);
    return passed && !b.pass ? lowestPass(scale).grade : b.grade;
}
/** A grade's point on the scale, or null (no points on this scale, or a grade it does not have). */
const pointOf = (scale, grade) => (scale || DEFAULT_SCALE).bands.find((b) => b.grade === grade)?.point ?? null;
const hasPoints = (scale) => (scale || DEFAULT_SCALE).bands.some((b) => b.point !== null && b.point !== undefined);
/** The scale as screens list it: each grade with the range of percentages it covers. */
const scaleRows = (scale) => (scale || DEFAULT_SCALE).bands.map((b, i, all) => ({
    grade: b.grade, from: b.min, to: i === 0 ? 100 : Math.max(b.min, all[i - 1].min - (Number.isInteger(all[i - 1].min) ? 1 : 0.01)),
    point: b.point ?? null, pass: b.pass,
}));

/* ── Exam types ───────────────────────────────────────────────────────────── */

const KINDS = { UNIT_TEST: 'Unit Test', MID_TERM: 'Mid Term', FINAL: 'Final' };
const BUILT_IN = Object.entries(KINDS).map(([key, label]) => ({ key, label, kind: key, builtIn: true, active: true }));

/** The built-in three (with the school's labels) followed by the school's own. */
function typesFrom(row) {
    const saved = Array.isArray(row?.examTypes) ? row.examTypes : [];
    const byKey = new Map(saved.map((t) => [String(t?.key || ''), t]));
    const builtIn = BUILT_IN.map((t) => {
        const s = byKey.get(t.key);
        return { ...t, label: String(s?.label || t.label).trim() || t.label, active: s?.active !== false };
    });
    const own = saved
        .filter((t) => t && !KINDS[t.key] && KINDS[t.kind] && String(t.label || '').trim())
        .map((t) => ({ key: String(t.key), label: String(t.label).trim(), kind: t.kind, builtIn: false, active: t.active !== false }));
    return [...builtIn, ...own];
}

const keyFrom = (label) => String(label || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'TYPE';

/** The label an exam is shown under: its own type's, as stored on it. */
const typeLabelOf = (exam) => (exam?.typeLabel && String(exam.typeLabel).trim()) || KINDS[exam?.examType] || exam?.examType || '';
/** The type an exam was created as — its own key, or (before types) its kind. */
const typeKeyOf = (exam) => (exam?.typeKey && String(exam.typeKey).trim()) || exam?.examType || '';

/* ── Report cards ─────────────────────────────────────────────────────────── */

const DEFAULT_AREAS = [
    { key: 'WORK_EDUCATION', label: 'Work Education' },
    { key: 'ART_EDUCATION', label: 'Art Education' },
    { key: 'HEALTH_PE', label: 'Health & Physical Education' },
    { key: 'DISCIPLINE', label: 'Discipline' },
];
const DEFAULT_CO_GRADES = ['A', 'B', 'C'];

function areasFrom(row) {
    const list = Array.isArray(row?.coScholastic) ? row.coScholastic : null;
    if (!list) return DEFAULT_AREAS;
    return list.filter((a) => a && String(a.label || '').trim()).map((a) => ({ key: String(a.key), label: String(a.label).trim() }));
}
const coGradesFrom = (row) => (Array.isArray(row?.coScholasticGrades) && row.coScholasticGrades.length ? row.coScholasticGrades.map(String) : DEFAULT_CO_GRADES);

/* ── Classes on a scale of their own ──────────────────────────────────────── */

/**
 * [{ from, to, preset, label, bands }] — classes numbered from..to grade on
 * this scale instead of the school's (primary on five points, secondary on
 * CBSE's nine, say). A rule whose custom bands no longer check is dropped.
 */
function classScalesFrom(row) {
    const list = Array.isArray(row?.classScales) ? row.classScales : [];
    const out = [];
    for (const r of list) {
        const from = Number(r?.from); const to = Number(r?.to);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) continue;
        const preset = String(r?.preset || 'standard');
        let scale;
        if (preset === 'custom') {
            try { scale = { preset, label: 'Custom', bands: checkBands(r.bands) }; } catch { continue; }
        } else if (PRESETS[preset]) {
            scale = { preset, label: PRESETS[preset].label, bands: PRESETS[preset].bands };
        } else continue;
        out.push({ from, to, ...scale });
    }
    return out.sort((a, b) => a.from - b.from);
}
/** The scale class `classNumber` grades on, under these settings. */
function scaleForClass(conf, classNumber) {
    const n = Number(classNumber);
    const rule = Number.isFinite(n) ? (conf?.classScales || []).find((r) => n >= r.from && n <= r.to) : null;
    return rule ? { preset: rule.preset, label: rule.label, bands: rule.bands } : (conf?.scale || DEFAULT_SCALE);
}

/* ── Terms, and how the year adds up ──────────────────────────────────────── */

/** [{ key, label, weight }] — weight null when the school weighs terms equally. */
function termsFrom(row) {
    const list = Array.isArray(row?.terms) ? row.terms : [];
    return list.filter((t) => t && String(t.label || '').trim() && t.key)
        .map((t) => ({ key: String(t.key), label: String(t.label).trim(), weight: Number.isFinite(Number(t.weight)) && t.weight !== null && t.weight !== '' ? Number(t.weight) : null }));
}

const OVERALL_METHODS = ['marks', 'weighted'];
const PASS_RULES = ['every', 'aggregate'];
const CLASS_TEST = 'CLASS_TEST';
/**
 * How the year's overall result is worked out. 'marks' — the counted exams'
 * marks added up, passed by passing every one (what the module always did).
 * 'weighted' — each part (an exam type, or class tests) a share of every
 * subject: the best N of its exams if the school says so, averaged.
 */
function overallFrom(row) {
    const o = row?.overallRule && typeof row.overallRule === 'object' ? row.overallRule : {};
    const method = OVERALL_METHODS.includes(o.method) ? o.method : 'marks';
    const parts = (Array.isArray(o.parts) ? o.parts : [])
        .filter((p) => p && p.source && Number(p.weight) > 0)
        .map((p) => ({ source: String(p.source), weight: Number(p.weight), best: Number.isInteger(Number(p.best)) && Number(p.best) > 0 ? Number(p.best) : null }));
    const passRule = PASS_RULES.includes(o.passRule) ? o.passRule : 'every';
    const passPercent = Number.isFinite(Number(o.passPercent)) && o.passPercent !== null && o.passPercent !== '' ? Number(o.passPercent) : 33;
    return { method: method === 'weighted' && parts.length ? 'weighted' : 'marks', parts, passRule, passPercent };
}

const remarkBankFrom = (row) => (Array.isArray(row?.remarkBank) ? row.remarkBank : [])
    .map((r) => String(typeof r === 'string' ? r : r?.text || '').trim()).filter(Boolean);

/* ── Reading and writing ──────────────────────────────────────────────────── */

async function rowOf(schoolId) {
    let row = await ResultSettings.findOne({ school: schoolId }).lean();
    if (!row) {
        try {
            await ResultSettings.create({ school: schoolId });
        } catch (e) {
            if (e.code !== 11000) throw e;   // two first reads at once: the other made it
        }
        row = await ResultSettings.findOne({ school: schoolId }).lean();
    }
    return row || {};
}

const intOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Everything the module reads, with every default applied. */
function shape(row, schoolId = null) {
    const scale = scaleFrom(row);
    const classScales = classScalesFrom(row);
    const zone = clock.zoneOf(schoolId);
    return {
        scale,
        scaleRows: scaleRows(scale),
        classScales: classScales.map((r) => ({ ...r, rows: scaleRows(r) })),
        presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, rows: scaleRows({ bands: p.bands }) })),
        examTypes: typesFrom(row),
        kinds: Object.entries(KINDS).map(([value, label]) => ({ value, label })),
        coScholastic: areasFrom(row),
        coScholasticGrades: coGradesFrom(row),
        terms: termsFrom(row),
        overall: overallFrom(row),
        noDetentionUpTo: intOrNull(row?.noDetentionUpTo),
        reExamMaxSubjects: intOrNull(row?.reExamMaxSubjects) || null,
        recheckDays: Math.max(0, intOrNull(row?.recheckDays) || 0),
        distinctionPercent: intOrNull(row?.distinctionPercent) ?? 75,
        remarkBank: remarkBankFrom(row),
        marksDueDays: intOrNull(row?.marksDueDays),
        officeReminders: row?.officeReminders !== false,
        timezone: zone,
        report: {
            showAttendance: row?.reportShowAttendance !== false,
            showRank: row?.reportShowRank !== false,
            showGradePoints: typeof row?.reportShowGradePoints === 'boolean' ? row.reportShowGradePoints : hasPoints(scale),
            footer: row?.reportFooter || '',
            principalTitle: row?.principalTitle || 'Principal',
            showClassFigures: row?.reportShowClassFigures === true,
            showSubjectRemarks: row?.reportShowSubjectRemarks !== false,
            principalSignature: row?.principalSignature || '',
            schoolSeal: row?.schoolSeal || '',
        },
        reminders: {
            enabled: row?.remindersEnabled !== false,
            afterDays: Number.isFinite(Number(row?.reminderAfterDays)) ? Number(row.reminderAfterDays) : 2,
            repeatDays: Number.isFinite(Number(row?.reminderRepeatDays)) ? Number(row.reminderRepeatDays) : 2,
        },
        updatedAt: row?.updatedAt || null,
    };
}

async function get(schoolId) {
    return shape(await rowOf(schoolId), schoolId);
}
/** The school's scale — or, given a class number, the scale that class grades on. */
const scaleOf = async (schoolId, classNumber) => scaleForClass(await get(schoolId), classNumber);
const typesOf = async (schoolId) => (await get(schoolId)).examTypes;

const flag = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
const whole = (v, lo, hi, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) bad(`${what} must be a whole number from ${lo} to ${hi}`);
    return n;
};

/**
 * Change the settings. Only what the body names changes. Renaming an exam
 * type renames it on every exam of that type; a type some exam uses cannot be
 * removed — only switched off, which keeps it off the Create Exam form.
 */
/** What a settings column is called on the Activity page. */
const SETTING_NAMES = {
    gradePreset: 'grading scale', gradeBands: 'grading scale', examTypes: 'exam types', coScholastic: 'co-scholastic areas',
    coScholasticGrades: 'co-scholastic grades', reportShowAttendance: 'report card', reportShowRank: 'report card',
    reportShowGradePoints: 'report card', reportShowClassFigures: 'report card', reportShowSubjectRemarks: 'report card',
    reportFooter: 'report card footer', principalTitle: 'signature title', principalSignature: 'signature', schoolSeal: 'school seal',
    remindersEnabled: 'reminders', reminderAfterDays: 'reminders', reminderRepeatDays: 'reminders', officeReminders: 'office reminders',
    classScales: 'class scales', terms: 'terms', overallRule: 'how the year adds up', noDetentionUpTo: 'no-detention classes',
    reExamMaxSubjects: 're-exam limit', recheckDays: 're-check window', distinctionPercent: 'distinction line',
    remarkBank: 'remark bank', marksDueDays: 'marks due days',
};

async function update(ctx, body = {}) {
    const row = await rowOf(ctx.schoolId);
    const set = {};

    if (body.gradePreset !== undefined) {
        const preset = String(body.gradePreset);
        if (preset !== 'custom' && !PRESETS[preset]) bad('Choose a grading scale');
        set.gradePreset = preset;
        if (preset === 'custom') set.gradeBands = checkBands(body.gradeBands ?? row.gradeBands);
    } else if (body.gradeBands !== undefined && row.gradePreset === 'custom') {
        set.gradeBands = checkBands(body.gradeBands);
    }

    let renamed = [];
    if (body.examTypes !== undefined) {
        if (!Array.isArray(body.examTypes)) bad('Give the exam types as a list');
        const before = typesFrom(row);
        const next = [];
        for (const t of body.examTypes) {
            const label = String(t?.label ?? '').trim();
            if (!label) bad('Every exam type needs a name');
            if (label.length > 40) bad(`"${label}" is too long for an exam type (40 characters at most)`);
            const known = before.find((b) => b.key === t?.key);
            if (known?.builtIn) {
                next.push({ key: known.key, label, kind: known.kind, active: t.active !== false });
                continue;
            }
            const kind = known ? known.kind : t?.kind;
            if (!KINDS[kind]) bad(`Choose what "${label}" counts as: a unit test, a mid-term or a final`);
            let key = known ? known.key : keyFrom(label);
            if (!known) {
                const taken = new Set([...before.map((b) => b.key), ...next.map((n) => n.key)]);
                let k = key; let i = 2;
                while (taken.has(k)) k = `${key}_${i++}`.slice(0, 34);
                key = k;
            }
            next.push({ key, label, kind, active: t.active !== false });
        }
        // The built-in three are always there, whether the list named them or not.
        for (const b of BUILT_IN) {
            if (next.some((n) => n.key === b.key)) continue;
            const was = before.find((x) => x.key === b.key);
            next.unshift({ key: b.key, label: was.label, kind: b.kind, active: was.active });
        }
        // Names are checked once the list is whole: a new "Mid Term" beside the built-in one is two.
        const names = new Set();
        for (const n of next) {
            if (names.has(n.label.toLowerCase())) bad(`Two exam types are called "${n.label}"`);
            names.add(n.label.toLowerCase());
        }
        if (!next.some((n) => n.active)) bad('At least one exam type must stay switched on');
        // A type some exam was created as cannot disappear from under it.
        const removed = before.filter((b) => !b.builtIn && !next.some((n) => n.key === b.key));
        for (const r of removed) {
            const { rows: [u] } = await pool.query(
                `SELECT count(*)::int AS "n" FROM "${FormalExam.tableName}" WHERE "school" = $1::uuid AND "typeKey" = $2`, [String(ctx.schoolId), r.key]);
            if (u.n) bad(`"${r.label}" is used by ${u.n} exam${u.n === 1 ? '' : 's'} — switch it off instead of removing it`);
        }
        renamed = next.filter((n) => { const b = before.find((x) => x.key === n.key); return b && b.label !== n.label; });
        set.examTypes = next;
    }

    if (body.coScholastic !== undefined) {
        if (!Array.isArray(body.coScholastic)) bad('Give the co-scholastic areas as a list');
        if (body.coScholastic.length > 12) bad('At most 12 co-scholastic areas');
        const seen = new Set();
        set.coScholastic = body.coScholastic.map((a) => {
            const label = String(a?.label ?? '').trim();
            if (!label) bad('Every co-scholastic area needs a name');
            if (label.length > 40) bad(`"${label}" is too long (40 characters at most)`);
            if (seen.has(label.toLowerCase())) bad(`Two areas are called "${label}"`);
            seen.add(label.toLowerCase());
            return { key: a?.key ? String(a.key) : keyFrom(label), label };
        });
    }
    if (body.coScholasticGrades !== undefined) {
        const list = (Array.isArray(body.coScholasticGrades) ? body.coScholasticGrades : []).map((g) => String(g).trim()).filter(Boolean);
        if (list.length < 2 || list.length > 8) bad('Give between 2 and 8 co-scholastic grades');
        if (list.some((g) => g.length > 4)) bad('A co-scholastic grade is 4 characters at most');
        if (new Set(list.map((g) => g.toUpperCase())).size !== list.length) bad('Two co-scholastic grades are the same');
        set.coScholasticGrades = list;
    }

    for (const [k, col] of [['showAttendance', 'reportShowAttendance'], ['showRank', 'reportShowRank'], ['showGradePoints', 'reportShowGradePoints'], ['remindersEnabled', 'remindersEnabled']]) {
        const v = flag(body[k] ?? body[col]);
        if (v !== undefined) set[col] = v;
    }
    if (body.reportFooter !== undefined) {
        const s = String(body.reportFooter || '').trim();
        if (s.length > 300) bad('The report card footer is 300 characters at most');
        set.reportFooter = s;
    }
    if (body.principalTitle !== undefined) {
        const s = String(body.principalTitle || '').trim();
        if (!s) bad('Give the title for the head of school\'s signature');
        if (s.length > 40) bad('The signature title is 40 characters at most');
        set.principalTitle = s;
    }
    if (body.reminderAfterDays !== undefined) set.reminderAfterDays = whole(body.reminderAfterDays, 0, 30, 'Days after the exam');
    if (body.reminderRepeatDays !== undefined) set.reminderRepeatDays = whole(body.reminderRepeatDays, 1, 30, 'Days between reminders');

    // ── Oct 2026: classes on their own scale ──────────────────────────────────
    if (body.classScales !== undefined) {
        const list = body.classScales === null ? [] : body.classScales;
        if (!Array.isArray(list)) bad('Give the class scales as a list');
        if (list.length > 10) bad('At most 10 class scales');
        const rules = list.map((r, i) => {
            const from = Number(r?.from); const to = Number(r?.to);
            if (!Number.isInteger(from) || !Number.isInteger(to) || from < -5 || to > 20) bad(`Class scale ${i + 1}: give the classes as whole numbers`);
            if (from > to) bad(`Class scale ${i + 1}: the first class must come before the last`);
            const preset = String(r?.preset || '');
            if (preset !== 'custom' && !PRESETS[preset]) bad(`Class scale ${i + 1}: choose a grading scale`);
            return { from, to, preset, ...(preset === 'custom' ? { bands: checkBands(r.bands) } : {}) };
        }).sort((a, b) => a.from - b.from);
        rules.forEach((r, i) => { if (i && r.from <= rules[i - 1].to) bad('Two class scales cover the same class'); });
        set.classScales = rules;
    }

    // ── Terms ─────────────────────────────────────────────────────────────────
    let termKeys = termsFrom(row).map((t) => t.key);
    if (body.terms !== undefined) {
        const list = body.terms === null ? [] : body.terms;
        if (!Array.isArray(list)) bad('Give the terms as a list');
        if (list.length > 4) bad('At most 4 terms');
        const before = termsFrom(row);
        const seen = new Set();
        const next = list.map((t, i) => {
            const label = String(t?.label ?? '').trim();
            if (!label) bad(`Term ${i + 1} needs a name`);
            if (label.length > 30) bad(`"${label}" is too long for a term (30 characters at most)`);
            if (seen.has(label.toLowerCase())) bad(`Two terms are called "${label}"`);
            seen.add(label.toLowerCase());
            const weight = t?.weight === null || t?.weight === undefined || t?.weight === '' ? null : Number(t.weight);
            if (weight !== null && (!Number.isFinite(weight) || weight <= 0 || weight > 100)) bad(`${label}: a term's weight is between 1 and 100`);
            const known = before.find((b) => b.key === t?.key);
            let key = known ? known.key : keyFrom(label);
            const taken = new Set(list.map((x) => x?.key).filter((k) => k && k !== t?.key));
            let k = key; let n = 2;
            while (taken.has(k)) k = `${key}_${n++}`;
            key = k;
            return { key, label, weight };
        });
        // A term some exam belongs to stays: an exam cannot lose its term from under it.
        for (const b of before) {
            if (next.some((n) => n.key === b.key)) continue;
            const { rows: [u] } = await pool.query(
                `SELECT count(*)::int AS "n" FROM "${FormalExam.tableName}" WHERE "school" = $1::uuid AND "term" = $2`, [String(ctx.schoolId), b.key]);
            if (u.n) bad(`"${b.label}" has ${u.n} exam${u.n === 1 ? '' : 's'} in it — move them to another term first`);
        }
        set.terms = next;
        termKeys = next.map((t) => t.key);
    }

    // ── How the year adds up ──────────────────────────────────────────────────
    if (body.overall !== undefined) {
        const o = body.overall || {};
        const method = String(o.method || 'marks');
        if (!OVERALL_METHODS.includes(method)) bad('Choose how the overall result is worked out');
        const passRule = String(o.passRule || 'every');
        if (!PASS_RULES.includes(passRule)) bad('Choose how a student passes the year');
        const passPercent = o.passPercent === undefined || o.passPercent === null || o.passPercent === '' ? 33 : Number(o.passPercent);
        if (!Number.isFinite(passPercent) || passPercent < 0 || passPercent > 100) bad('The pass percentage is between 0 and 100');
        const types = new Set(typesFrom(set.examTypes ? { examTypes: set.examTypes } : row).map((t) => t.key));
        const parts = (Array.isArray(o.parts) ? o.parts : []).map((p, i) => {
            const source = String(p?.source || '');
            if (source !== CLASS_TEST && !types.has(source)) bad(`Part ${i + 1}: choose an exam type, or class tests`);
            const weight = Number(p?.weight);
            if (!Number.isFinite(weight) || weight <= 0 || weight > 100) bad(`Part ${i + 1}: a weight is between 1 and 100`);
            const best = p?.best === null || p?.best === undefined || p?.best === '' ? null : Number(p.best);
            if (best !== null && (!Number.isInteger(best) || best < 1 || best > 10)) bad(`Part ${i + 1}: "best of" is a whole number from 1 to 10`);
            return { source, weight, best };
        });
        if (new Set(parts.map((p) => p.source)).size !== parts.length) bad('Each part of the overall result can be listed once');
        if (method === 'weighted' && !parts.length) bad('Give at least one part its weight');
        if (parts.length > 8) bad('At most 8 parts');
        set.overallRule = { method, parts, passRule, passPercent };
    }

    for (const [k, lo, hi, what] of [
        ['noDetentionUpTo', -5, 20, 'The no-detention class'], ['reExamMaxSubjects', 0, 20, 'The re-exam subject limit'],
        ['marksDueDays', 0, 60, 'Days for marks to be due'],
    ]) {
        if (body[k] === undefined) continue;
        set[k] = body[k] === null || body[k] === '' ? null : whole(body[k], lo, hi, what);
    }
    if (body.recheckDays !== undefined) set.recheckDays = body.recheckDays === null || body.recheckDays === '' ? 0 : whole(body.recheckDays, 0, 60, 'Days to ask for a re-check');
    if (body.distinctionPercent !== undefined) {
        const v = body.distinctionPercent === null || body.distinctionPercent === '' ? null : Number(body.distinctionPercent);
        if (v !== null && (!Number.isFinite(v) || v <= 0 || v > 100)) bad('A distinction starts between 1% and 100%');
        set.distinctionPercent = v;
    }
    if (body.remarkBank !== undefined) {
        const list = (Array.isArray(body.remarkBank) ? body.remarkBank : []).map((r) => String(typeof r === 'string' ? r : r?.text || '').trim()).filter(Boolean);
        if (list.length > 100) bad('At most 100 remarks in the bank');
        if (list.some((r) => r.length > 300)) bad('A remark is 300 characters at most');
        set.remarkBank = [...new Set(list)];
    }
    for (const [k, col] of [['showClassFigures', 'reportShowClassFigures'], ['showSubjectRemarks', 'reportShowSubjectRemarks'], ['officeReminders', 'officeReminders']]) {
        const v = flag(body[k] ?? body[col]);
        if (v !== undefined) set[col] = v;
    }
    for (const k of ['principalSignature', 'schoolSeal']) {
        if (body[k] === null || body[k] === '') set[k] = '';
    }
    let zoneSet = '';
    if (body.timezone !== undefined) {
        const zone = String(body.timezone || '').trim();
        if (zone && !clock.valid(zone)) bad('Choose a time zone from the list');
        await pool.query(`UPDATE "schools" SET "timezone" = $2 WHERE "_id" = $1::uuid`, [String(ctx.schoolId), zone]);
        clock.setZone(ctx.schoolId, zone);
        zoneSet = zone || 'the server\'s';
    }
    void termKeys;

    const cols = Object.keys(set);
    if (cols.length || zoneSet) {
        // Only the columns asked for — never a stale copy of the rest of the row.
        if (cols.length) await patch(ResultSettings, row._id, { ...set, updatedBy: ctx.userId || null, updatedAt: new Date() });
        // Recorded under Results → Activity: which settings, by whom.
        const what = [...cols.map((k) => SETTING_NAMES[k] || k), ...(zoneSet ? [`time zone (${zoneSet})`] : [])];
        require('../models/ResultAuditLog').create({
            school: ctx.schoolId, user: ctx.userId || null, role: ctx.userRole || '',
            actionType: 'SETTINGS_CHANGED', entityType: 'Settings', entityId: row._id,
            description: `Result settings changed: ${[...new Set(what)].join(', ')}`.slice(0, 500), meta: { keys: cols },
        }).catch((e) => console.error('[results] settings trail failed:', e.message));
    }
    // An exam keeps the label of the type it was created as — renamed with it.
    for (const t of renamed) {
        await pool.query(
            `UPDATE "${FormalExam.tableName}" SET "typeLabel" = $3
              WHERE "school" = $1::uuid AND COALESCE(NULLIF("typeKey", ''), "examType") = $2`,
            [String(ctx.schoolId), t.key, t.label]);
    }
    return get(ctx.schoolId);
}

module.exports = {
    SettingsError, PRESETS, DEFAULT_SCALE, KINDS, BUILT_IN, CLASS_TEST, OVERALL_METHODS, PASS_RULES,
    checkBands, scaleFrom, bandFor, gradeFor, overallGrade, pointOf, hasPoints, scaleRows,
    typesFrom, typeLabelOf, typeKeyOf, keyFrom, scaleForClass, termsFrom, overallFrom,
    get, update, scaleOf, typesOf,
};
