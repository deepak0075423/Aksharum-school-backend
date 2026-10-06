'use strict';
/**
 * Medical Room reports (Oct 2026). Twenty reports in three groups, each
 * answering ONE shape so the screen is one table, one chart and one export:
 *
 *   { kind, title, subtitle, columns: [{ key, label, type }], rows,
 *     summary: [{ label, value, tone }], chart: { type, data: [{ label, value }] } | null }
 *
 * Filters (all optional): year (an academic year — its dates), from, to,
 * classId, sectionId, category, status, days. A report about students lists
 * active students in their current class.
 */
const pool = require('../db/pool');
const settingsSvc = require('./medicalSettings');
const read = require('./medicalRead');
const { STUDENT_SELECT, STUDENT_JOIN, withClass, params, localDay, storedDay } = require('./medicalBoard');
const R = require('./medicalRules');

const { todayStr, isUuid, addDays, refuse } = R;
const run = (sql, list) => pool.query(sql, list).then((r) => r.rows);
const MAX = 5000;

const CATALOGUE = [
    { group: 'Students', kind: 'history', title: 'Medical history', about: 'Every visit, incident, first aid and medicine in the period' },
    { group: 'Students', kind: 'allergies', title: 'Students with allergies', about: 'Allergens, severity and what to do' },
    { group: 'Students', kind: 'conditions', title: 'Students with medical conditions', about: 'Current conditions and their care' },
    { group: 'Students', kind: 'medication', title: 'Students taking medication', about: 'Medication plans in force, and doses given' },
    { group: 'Students', kind: 'blood_groups', title: 'Blood group report', about: 'Every student\'s blood group, and who has none recorded' },
    { group: 'Students', kind: 'vaccinations', title: 'Vaccination report', about: 'Given, due soon and overdue doses' },
    { group: 'Students', kind: 'checkups', title: 'Health checkup report', about: 'Checkup results, outcomes and follow-ups' },
    { group: 'Students', kind: 'growth', title: 'Growth (WHO charts)', about: 'Each student\'s latest height and weight against the WHO growth charts' },
    { group: 'Students', kind: 'vaccine_coverage', title: 'Vaccination schedule coverage', about: 'How many students have had each dose of the school\'s schedule' },
    { group: 'Students', kind: 'specialist_referrals', title: 'Specialist referrals', about: 'Students sent on to a specialist, and what came back' },
    { group: 'Medical Room', kind: 'daily_visits', title: 'Daily visits', about: 'Visits per day and how they ended' },
    { group: 'Medical Room', kind: 'monthly_visits', title: 'Monthly visits', about: 'Visits per month and how they ended' },
    { group: 'Medical Room', kind: 'incidents', title: 'Medical incidents', about: 'Incidents by type, severity and place' },
    { group: 'Medical Room', kind: 'first_aid', title: 'First-aid usage', about: 'First aid given and the supplies it used' },
    { group: 'Medical Room', kind: 'sent_home', title: 'Students sent home', about: 'Every student sent home from the room' },
    { group: 'Medical Room', kind: 'referrals', title: 'Hospital referrals', about: 'Referrals from visits and incidents' },
    { group: 'Medical Room', kind: 'campaigns', title: 'Health campaigns', about: 'Each campaign\'s coverage — given, absent, declined' },
    { group: 'Medical Room', kind: 'outbreaks', title: 'Outbreak watch', about: 'Clusters of illness the watch found, and what was done' },
    { group: 'Inventory', kind: 'current_stock', title: 'Current stock', about: 'Every medicine and supply on hand' },
    { group: 'Inventory', kind: 'low_stock', title: 'Low stock', about: 'Items at or below their minimum' },
    { group: 'Inventory', kind: 'expired', title: 'Expired medicines', about: 'Batches past their date — on the shelf or written off' },
    { group: 'Inventory', kind: 'expiring', title: 'Expiring medicines', about: 'Batches that expire soon' },
    { group: 'Inventory', kind: 'medicine_consumption', title: 'Medicine consumption', about: 'What was given and taken out, per medicine' },
    { group: 'Inventory', kind: 'first_aid_consumption', title: 'First-aid consumption', about: 'Supplies used, per item' },
    { group: 'Inventory', kind: 'movements', title: 'Inventory movement', about: 'Every movement in the stock ledger' },
];

const col = (key, label, type = 'text') => ({ key, label, type });
const STUDENT_COLS = [col('studentName', 'Student'), col('admissionNumber', 'Admission No.'), col('classLabel', 'Class')];

/** The date window: an academic year, narrowed by from/to; defaults to the last 30 days where a period matters. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A chart bar's name: '21 Sep' for a day, 'Sep 2026' for a month. */
const periodLabel = (period, unit) => {
    const [y, m, d] = String(period || '').split('-');
    if (!y || !m) return String(period || '');
    return unit === 'day' ? `${d} ${MONTHS[Number(m) - 1]}` : `${MONTHS[Number(m) - 1]} ${y}`;
};

async function windowOf(schoolId, f, { defaultDays = 30 } = {}) {
    let from = /^\d{4}-\d{2}-\d{2}$/.test(f.from || '') ? f.from : '';
    let to = /^\d{4}-\d{2}-\d{2}$/.test(f.to || '') ? f.to : '';
    const yr = await read.yearRange(schoolId, f.year);
    if (yr) { from = from && from > yr.from ? from : yr.from; to = to && to < yr.to ? to : yr.to; }
    if (!from && defaultDays) from = addDays(todayStr(), -(defaultDays - 1));
    if (!to) to = todayStr();
    if (from > to) refuse('The start date is after the end date');
    return { from, to, year: yr?.name || '' };
}

function classFilter(where, $, f) {
    if (isUuid(f.sectionId)) where.push(`sp."currentSection" = ${$(f.sectionId)}::uuid`);
    else if (isUuid(f.classId)) where.push(`COALESCE(cs."class", sp."currentClass") = ${$(f.classId)}::uuid`);
}

const label = (map, k) => R.labelOf(map, k);

const REPORTS = {};

REPORTS.history = async (S, f) => {
    const w = await windowOf(S, f);
    const p = params([S, w.from, w.to]);
    const where = [];
    classFilter(where, p.$, f);
    if (isUuid(f.student)) where.push(`u."_id" = ${p.$(f.student)}::uuid`);
    const extra = where.length ? ` AND ${where.join(' AND ')}` : '';
    const rows = await run(`
        SELECT * FROM (
          SELECT v."arrivedAt" AS at, 'Visit' AS kind, v."number" AS ref, v."reason" AS title,
                 concat_ws(' · ', NULLIF(v."treatment", ''), NULLIF(v."firstAid", '')) AS details, v."status" AS status, ${STUDENT_SELECT}
            FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')}
           WHERE v."school" = $1 AND v."archivedAt" IS NULL AND ${localDay('v."arrivedAt"')} BETWEEN $2::date AND $3::date${extra}
          UNION ALL
          SELECT i."occurredAt", 'Incident', i."number", i."description", concat_ws(' · ', NULLIF(i."injury", ''), NULLIF(i."firstAid", '')), i."severity", ${STUDENT_SELECT}
            FROM "medicalincidents" i ${STUDENT_JOIN('i."student"')}
           WHERE i."school" = $1 AND i."archivedAt" IS NULL AND ${localDay('i."occurredAt"')} BETWEEN $2::date AND $3::date${extra}
          UNION ALL
          SELECT fa."at", 'First aid', '', fa."reason", fa."treatment", 'given', ${STUDENT_SELECT}
            FROM "medicalfirstaids" fa ${STUDENT_JOIN('fa."student"')}
           WHERE fa."school" = $1 AND fa."archivedAt" IS NULL AND fa."visit" IS NULL AND ${localDay('fa."at"')} BETWEEN $2::date AND $3::date${extra}
          UNION ALL
          SELECT COALESCE(d."givenAt", d."scheduledFor"), 'Medicine', '', d."medicineName", d."dosage", d."status", ${STUDENT_SELECT}
            FROM "medicationdoses" d ${STUDENT_JOIN('d."student"')}
           WHERE d."school" = $1 AND d."status" IN ('given','missed','refused') AND ${localDay('COALESCE(d."givenAt", d."scheduledFor")')} BETWEEN $2::date AND $3::date${extra}
          UNION ALL
          SELECT k."checkedOn", 'Checkup', '', k."type", concat_ws(' · ', NULLIF(k."findings", ''), NULLIF(k."recommendations", '')), COALESCE(NULLIF(k."outcome", ''), 'completed'), ${STUDENT_SELECT}
            FROM "medicalcheckups" k ${STUDENT_JOIN('k."student"')}
           WHERE k."school" = $1 AND k."archivedAt" IS NULL AND k."status" = 'completed' AND ${storedDay('k."checkedOn"')} BETWEEN $2::date AND $3::date${extra}
          UNION ALL
          SELECT vc."givenOn", 'Vaccination', '', vc."vaccine", vc."dose", 'completed', ${STUDENT_SELECT}
            FROM "medicalvaccinations" vc ${STUDENT_JOIN('vc."student"')}
           WHERE vc."school" = $1 AND vc."archivedAt" IS NULL AND vc."givenOn" IS NOT NULL AND ${storedDay('vc."givenOn"')} BETWEEN $2::date AND $3::date${extra}
        ) h ORDER BY h.at DESC LIMIT ${MAX}`, p.list);
    const counts = {};
    for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}${w.year ? ` · ${w.year}` : ''}`,
        columns: [col('at', 'Date', 'datetime'), col('kind', 'Type'), col('ref', 'No.'), ...STUDENT_COLS, col('title', 'Record'), col('details', 'Details'), col('status', 'Status', 'status')],
        rows: rows.map((r) => ({ ...withClass(r), title: r.kind === 'Checkup' ? label(R.CHECKUP_TYPE, r.title) : r.title })),
        summary: Object.entries(counts).map(([k, v]) => ({ label: k === 'First aid' ? 'First aid' : `${k}s`, value: v })),
        chart: { type: 'bar', data: Object.entries(counts).map(([k, v]) => ({ label: k, value: v })) },
    };
};

REPORTS.allergies = async (S, f) => {
    const p = params([S]);
    const where = ['a."school" = $1', 'a."archivedAt" IS NULL', `a."status" <> 'resolved'`, 'u."isActive" IS NOT FALSE'];
    classFilter(where, p.$, f);
    if (R.ALLERGY_CATEGORY[f.category]) where.push(`a."category" = ${p.$(f.category)}`);
    if (R.ALLERGY_SEVERITY[f.status]) where.push(`a."severity" = ${p.$(f.status)}`);
    const rows = await run(`SELECT a.*, ${STUDENT_SELECT} FROM "medicalallergies" a ${STUDENT_JOIN('a."student"')} WHERE ${where.join(' AND ')}
        ORDER BY c."classNumber" NULLS LAST, c."className" NULLS LAST, cs."sectionName" NULLS LAST, u."name" LIMIT ${MAX}`, p.list);
    const bySev = {};
    for (const r of rows) bySev[r.severity] = (bySev[r.severity] || 0) + 1;
    return {
        columns: [...STUDENT_COLS, col('allergen', 'Allergy'), col('category', 'Type'), col('severity', 'Severity', 'status'), col('reaction', 'Reaction'), col('emergencyInstructions', 'Emergency instructions'), col('medication', 'Medication')],
        rows: rows.map((r) => ({ ...withClass(r), category: label(R.ALLERGY_CATEGORY, r.category) })),
        summary: [{ label: 'Students', value: new Set(rows.map((r) => String(r.student))).size }, { label: 'Allergies', value: rows.length },
            { label: 'Severe or life-threatening', value: (bySev.severe || 0) + (bySev.life_threatening || 0), tone: 'red' }],
        chart: { type: 'bar', data: Object.keys(R.ALLERGY_SEVERITY).map((k) => ({ label: label(R.ALLERGY_SEVERITY, k), value: bySev[k] || 0, tone: R.ALLERGY_SEVERITY[k].tone })) },
    };
};

REPORTS.conditions = async (S, f) => {
    const p = params([S]);
    const where = ['mc."school" = $1', 'mc."archivedAt" IS NULL', `mc."status" <> 'resolved'`, 'u."isActive" IS NOT FALSE'];
    classFilter(where, p.$, f);
    if (R.CONDITION_TYPE[f.category]) where.push(`mc."type" = ${p.$(f.category)}`);
    if (R.CONDITION_SEVERITY[f.status]) where.push(`mc."severity" = ${p.$(f.status)}`);
    const rows = await run(`SELECT mc.*, ${STUDENT_SELECT} FROM "medicalconditions" mc ${STUDENT_JOIN('mc."student"')} WHERE ${where.join(' AND ')}
        ORDER BY c."classNumber" NULLS LAST, c."className" NULLS LAST, cs."sectionName" NULLS LAST, u."name" LIMIT ${MAX}`, p.list);
    const byType = {};
    for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
    return {
        columns: [...STUDENT_COLS, col('condition', 'Condition'), col('typeLabel', 'Type'), col('severity', 'Severity', 'status'), col('chronicLabel', 'Chronic'), col('treatment', 'Treatment'), col('medication', 'Medication'), col('emergencyInstructions', 'Emergency instructions')],
        rows: rows.map((r) => ({ ...withClass(r), typeLabel: label(R.CONDITION_TYPE, r.type), chronicLabel: r.chronic ? 'Yes' : '' })),
        summary: [{ label: 'Students', value: new Set(rows.map((r) => String(r.student))).size }, { label: 'Conditions', value: rows.length },
            { label: 'Severe or critical', value: rows.filter((r) => R.SEVERE_CONDITION.includes(r.severity)).length, tone: 'red' }, { label: 'Chronic', value: rows.filter((r) => r.chronic).length }],
        chart: { type: 'bar', data: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: label(R.CONDITION_TYPE, k), value: v })) },
    };
};

REPORTS.medication = async (S, f) => {
    const w = await windowOf(S, f);
    const p = params([S, w.from, w.to]);
    const where = ['pl."school" = $1', 'u."isActive" IS NOT FALSE'];
    classFilter(where, p.$, f);
    if (R.PLAN_STATUS[f.status]) where.push(`pl."status" = ${p.$(f.status)}`);
    else where.push(`pl."status" IN ('active','paused')`);
    const rows = await run(`SELECT pl.*, ${STUDENT_SELECT},
            (SELECT count(*)::int FROM "medicationdoses" d WHERE d."plan" = pl."_id" AND d."status" = 'given' AND ${localDay('d."givenAt"')} BETWEEN $2::date AND $3::date) AS given,
            (SELECT count(*)::int FROM "medicationdoses" d WHERE d."plan" = pl."_id" AND d."status" IN ('missed','refused') AND ${localDay('d."scheduledFor"')} BETWEEN $2::date AND $3::date) AS "notGiven"
          FROM "medicationplans" pl ${STUDENT_JOIN('pl."student"')} WHERE ${where.join(' AND ')} ORDER BY u."name" LIMIT ${MAX}`, p.list);
    return {
        subtitle: `Doses counted ${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [...STUDENT_COLS, col('medicineName', 'Medicine'), col('dosage', 'Dosage'), col('schedule', 'When'), col('startDate', 'From', 'date'), col('endDate', 'Until', 'date'), col('sourceLabel', 'Supplied by'), col('authorized', 'Parent authorised'), col('given', 'Doses given', 'number'), col('notGiven', 'Missed / refused', 'number'), col('status', 'Status', 'status')],
        rows: rows.map((r) => ({ ...withClass(r), schedule: r.frequency === 'as_needed' ? 'As needed' : (r.times || []).join(', '), sourceLabel: r.source === 'parent' ? 'Family' : 'School stock', authorized: r.parentAuthorization?.authorized ? 'Yes' : 'No' })),
        summary: [{ label: 'Students on medication', value: new Set(rows.map((r) => String(r.student))).size }, { label: 'Plans', value: rows.length },
            { label: 'Doses given', value: rows.reduce((n, r) => n + r.given, 0), tone: 'green' }, { label: 'Missed or refused', value: rows.reduce((n, r) => n + r.notGiven, 0), tone: 'red' }],
        chart: null,
    };
};

REPORTS.blood_groups = async (S, f) => {
    const p = params([S]);
    const where = ['u."school" = $1', `u."role" = 'student'`, 'u."isActive" IS NOT FALSE'];
    classFilter(where, p.$, f);
    if (R.BLOOD_GROUPS.includes(String(f.category || '').toUpperCase())) where.push(`upper(sp."bloodGroup") = ${p.$(String(f.category).toUpperCase())}`);
    if (f.status === 'missing') where.push(`COALESCE(sp."bloodGroup", '') = ''`);
    const rows = await run(`SELECT u."_id" AS student, ${STUDENT_SELECT}, sp."bloodGroup" FROM "users" u
          LEFT JOIN "studentprofiles" sp ON sp."user" = u."_id" LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
          LEFT JOIN "classes" c ON c."_id" = COALESCE(cs."class", sp."currentClass")
         WHERE ${where.join(' AND ')} ORDER BY c."classNumber" NULLS LAST, c."className" NULLS LAST, cs."sectionName" NULLS LAST, u."name" LIMIT ${MAX}`, p.list);
    const by = {};
    for (const r of rows) { const g = String(r.bloodGroup || '').toUpperCase() || 'Not recorded'; by[g] = (by[g] || 0) + 1; }
    return {
        columns: [...STUDENT_COLS, col('bloodGroup', 'Blood group')],
        rows: rows.map((r) => ({ ...withClass(r), bloodGroup: r.bloodGroup || 'Not recorded' })),
        summary: [{ label: 'Students', value: rows.length }, { label: 'Not recorded', value: by['Not recorded'] || 0, tone: 'amber' }],
        chart: { type: 'bar', data: [...R.BLOOD_GROUPS, 'Not recorded'].map((g) => ({ label: g, value: by[g] || 0 })) },
    };
};

REPORTS.vaccinations = async (S, f, s) => {
    const today = todayStr();
    const p = params([S, today, s.vaccinationDueDays]);
    const state = `(CASE WHEN v."givenOn" IS NOT NULL THEN 'completed' WHEN v."dueOn" IS NULL THEN 'pending'
        WHEN ${storedDay('v."dueOn"')} < $2::date THEN 'overdue' WHEN ${storedDay('v."dueOn"')} <= $2::date + $3::int THEN 'due_soon' ELSE 'pending' END)`;
    const where = ['v."school" = $1', 'v."archivedAt" IS NULL', 'u."isActive" IS NOT FALSE'];
    classFilter(where, p.$, f);
    if (f.category) where.push(`v."vaccine" ILIKE ${p.$(`%${String(f.category).slice(0, 60)}%`)}`);
    if (R.VACCINATION_STATUS[f.status]) where.push(`${state} = ${p.$(f.status)}`);
    const rows = await run(`SELECT v.*, ${state} AS state, ${STUDENT_SELECT} FROM "medicalvaccinations" v ${STUDENT_JOIN('v."student"')}
        WHERE ${where.join(' AND ')} ORDER BY u."name", COALESCE(v."givenOn", v."dueOn") LIMIT ${MAX}`, p.list);
    const by = {};
    for (const r of rows) by[r.state] = (by[r.state] || 0) + 1;
    return {
        columns: [...STUDENT_COLS, col('vaccine', 'Vaccine'), col('dose', 'Dose'), col('givenOn', 'Given on', 'day'), col('dueOn', 'Due on', 'day'), col('provider', 'Hospital / clinic'), col('state', 'Status', 'status')],
        rows: rows.map(withClass),
        summary: Object.keys(R.VACCINATION_STATUS).map((k) => ({ label: label(R.VACCINATION_STATUS, k), value: by[k] || 0, tone: R.VACCINATION_STATUS[k].tone })),
        chart: { type: 'pie', data: Object.keys(R.VACCINATION_STATUS).map((k) => ({ label: label(R.VACCINATION_STATUS, k), value: by[k] || 0, tone: R.VACCINATION_STATUS[k].tone })) },
    };
};

REPORTS.checkups = async (S, f) => {
    const w = await windowOf(S, f, { defaultDays: 365 });
    const p = params([S, w.from, w.to]);
    const where = ['k."school" = $1', 'k."archivedAt" IS NULL', `k."status" = 'completed'`, `${storedDay('k."checkedOn"')} BETWEEN $2::date AND $3::date`];
    classFilter(where, p.$, f);
    if (R.CHECKUP_TYPE[f.category]) where.push(`k."type" = ${p.$(f.category)}`);
    if (R.CHECKUP_OUTCOME[f.status]) where.push(`k."outcome" = ${p.$(f.status)}`);
    const rows = await run(`SELECT k.*, ${STUDENT_SELECT} FROM "medicalcheckups" k ${STUDENT_JOIN('k."student"')} WHERE ${where.join(' AND ')}
        ORDER BY k."checkedOn" DESC, u."name" LIMIT ${MAX}`, p.list);
    const by = {};
    for (const r of rows) by[r.outcome || 'normal'] = (by[r.outcome || 'normal'] || 0) + 1;
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [...STUDENT_COLS, col('checkedOn', 'Date', 'day'), col('typeLabel', 'Checkup'), col('heightCm', 'Height (cm)', 'number'), col('weightKg', 'Weight (kg)', 'number'), col('bmi', 'BMI', 'number'), col('bp', 'BP'), col('vision', 'Vision L / R'), col('outcome', 'Outcome', 'status'), col('findings', 'Findings'), col('professional', 'Checked by')],
        rows: rows.map((r) => {
            const x = r.results || {};
            return { ...withClass(r), typeLabel: label(R.CHECKUP_TYPE, r.type), heightCm: x.heightCm ?? '', weightKg: x.weightKg ?? '', bmi: x.bmi ?? '', bp: x.bpSystolic ? `${x.bpSystolic}/${x.bpDiastolic || '—'}` : '', vision: x.visionLeft || x.visionRight ? `${x.visionLeft || '—'} / ${x.visionRight || '—'}` : '' };
        }),
        summary: [{ label: 'Checkups', value: rows.length }, ...Object.keys(R.CHECKUP_OUTCOME).map((k) => ({ label: label(R.CHECKUP_OUTCOME, k), value: by[k] || 0, tone: R.CHECKUP_OUTCOME[k].tone }))],
        chart: { type: 'bar', data: Object.keys(R.CHECKUP_OUTCOME).map((k) => ({ label: label(R.CHECKUP_OUTCOME, k), value: by[k] || 0, tone: R.CHECKUP_OUTCOME[k].tone })) },
    };
};

async function visitsBy(S, f, unit) {
    const w = await windowOf(S, f, { defaultDays: unit === 'day' ? 30 : 365 });
    const p = params([S, w.from, w.to]);
    const where = [];
    classFilter(where, p.$, f);
    const extra = where.length ? ` AND ${where.join(' AND ')}` : '';
    const bucket = unit === 'day' ? `to_char(${localDay('v."arrivedAt"')}, 'YYYY-MM-DD')` : `to_char(${localDay('v."arrivedAt"')}, 'YYYY-MM')`;
    const ibucket = unit === 'day' ? `to_char(${localDay('i."occurredAt"')}, 'YYYY-MM-DD')` : `to_char(${localDay('i."occurredAt"')}, 'YYYY-MM')`;
    const rows = await run(`
        WITH v AS (
          SELECT ${bucket} AS period, count(*)::int AS visits,
                 count(*) FILTER (WHERE v."status" = 'returned')::int AS returned,
                 count(*) FILTER (WHERE v."status" = 'sent_home')::int AS "sentHome",
                 count(*) FILTER (WHERE v."status" = 'referred')::int AS referred,
                 count(*) FILTER (WHERE v."emergency" IS TRUE)::int AS emergencies,
                 count(DISTINCT v."student")::int AS students
            FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')}
           WHERE v."school" = $1 AND v."archivedAt" IS NULL AND ${localDay('v."arrivedAt"')} BETWEEN $2::date AND $3::date${extra}
           GROUP BY 1),
        i AS (
          SELECT ${ibucket} AS period, count(*)::int AS incidents
            FROM "medicalincidents" i ${STUDENT_JOIN('i."student"')}
           WHERE i."school" = $1 AND i."archivedAt" IS NULL AND ${localDay('i."occurredAt"')} BETWEEN $2::date AND $3::date${extra}
           GROUP BY 1)
        SELECT COALESCE(v.period, i.period) AS period, COALESCE(v.visits, 0) AS visits, COALESCE(v.students, 0) AS students,
               COALESCE(v.returned, 0) AS returned, COALESCE(v."sentHome", 0) AS "sentHome", COALESCE(v.referred, 0) AS referred,
               COALESCE(v.emergencies, 0) AS emergencies, COALESCE(i.incidents, 0) AS incidents
          FROM v FULL JOIN i ON i.period = v.period ORDER BY 1 DESC`, p.list);
    const sum = (k) => rows.reduce((n, r) => n + Number(r[k] || 0), 0);
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('period', unit === 'day' ? 'Day' : 'Month', unit === 'day' ? 'day' : 'month'), col('visits', 'Visits', 'number'), col('students', 'Students', 'number'), col('returned', 'Returned to class', 'number'), col('sentHome', 'Sent home', 'number'), col('referred', 'Referred', 'number'), col('emergencies', 'Emergencies', 'number'), col('incidents', 'Incidents', 'number')],
        rows,
        summary: [{ label: 'Visits', value: sum('visits') }, { label: 'Returned to class', value: sum('returned'), tone: 'green' }, { label: 'Sent home', value: sum('sentHome'), tone: 'orange' }, { label: 'Referred', value: sum('referred'), tone: 'rose' }, { label: 'Incidents', value: sum('incidents'), tone: 'amber' }],
        chart: { type: 'bar', data: [...rows].reverse().map((r) => ({ label: periodLabel(r.period, unit), value: r.visits })) },
    };
}
REPORTS.daily_visits = (S, f) => visitsBy(S, f, 'day');
REPORTS.monthly_visits = (S, f) => visitsBy(S, f, 'month');

REPORTS.incidents = async (S, f) => {
    const w = await windowOf(S, f, { defaultDays: 90 });
    const p = params([S, w.from, w.to]);
    const where = ['i."school" = $1', 'i."archivedAt" IS NULL', `${localDay('i."occurredAt"')} BETWEEN $2::date AND $3::date`];
    classFilter(where, p.$, f);
    if (R.INCIDENT_TYPE[f.category]) where.push(`i."type" = ${p.$(f.category)}`);
    if (R.INCIDENT_SEVERITY[f.status]) where.push(`i."severity" = ${p.$(f.status)}`);
    const rows = await run(`SELECT i.*, ${STUDENT_SELECT} FROM "medicalincidents" i ${STUDENT_JOIN('i."student"')} WHERE ${where.join(' AND ')}
        ORDER BY i."occurredAt" DESC LIMIT ${MAX}`, p.list);
    const byType = {}; const bySev = {};
    for (const r of rows) { byType[r.type] = (byType[r.type] || 0) + 1; bySev[r.severity] = (bySev[r.severity] || 0) + 1; }
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('occurredAt', 'When', 'datetime'), col('number', 'No.'), ...STUDENT_COLS, col('typeLabel', 'Type'), col('severity', 'Severity', 'status'), col('location', 'Location'), col('injury', 'Injury'), col('firstAid', 'First aid'), col('parentInformed', 'Parents told'), col('status', 'Status', 'status')],
        rows: rows.map((r) => ({ ...withClass(r), typeLabel: label(R.INCIDENT_TYPE, r.type), parentInformed: r.parentNotified ? 'Yes' : 'No' })),
        summary: [{ label: 'Incidents', value: rows.length }, ...Object.keys(R.INCIDENT_SEVERITY).map((k) => ({ label: label(R.INCIDENT_SEVERITY, k), value: bySev[k] || 0, tone: R.INCIDENT_SEVERITY[k].tone }))],
        chart: { type: 'bar', data: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: label(R.INCIDENT_TYPE, k), value: v })) },
    };
};

REPORTS.first_aid = async (S, f) => {
    const w = await windowOf(S, f);
    const p = params([S, w.from, w.to]);
    const where = ['fa."school" = $1', 'fa."archivedAt" IS NULL', `${localDay('fa."at"')} BETWEEN $2::date AND $3::date`];
    classFilter(where, p.$, f);
    const rows = await run(`SELECT fa.*, ${STUDENT_SELECT} FROM "medicalfirstaids" fa ${STUDENT_JOIN('fa."student"')} WHERE ${where.join(' AND ')}
        ORDER BY fa."at" DESC LIMIT ${MAX}`, p.list);
    const used = {};
    for (const r of rows) for (const sup of r.supplies || []) used[sup.name] = (used[sup.name] || 0) + Number(sup.quantity || 0);
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('at', 'When', 'datetime'), ...STUDENT_COLS, col('reason', 'Reason'), col('injury', 'Injury / symptoms'), col('treatment', 'First aid given'), col('suppliesText', 'Supplies used'), col('givenByName', 'Given by')],
        rows: rows.map((r) => ({ ...withClass(r), suppliesText: (r.supplies || []).map((x) => `${x.quantity} ${x.unit || ''} ${x.name}`.replace(/\s+/g, ' ')).join(', ') })),
        summary: [{ label: 'First-aid records', value: rows.length }, { label: 'Students helped', value: new Set(rows.map((r) => String(r.student))).size }, { label: 'Supply items used', value: Object.keys(used).length }],
        chart: { type: 'bar', data: Object.entries(used).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ label: k, value: v })) },
    };
};

REPORTS.sent_home = async (S, f) => {
    const w = await windowOf(S, f);
    const p = params([S, w.from, w.to]);
    const where = ['v."school" = $1', 'v."archivedAt" IS NULL', `(v."status" = 'sent_home' OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v."history", '[]'::jsonb)) h WHERE h->>'status' = 'sent_home'))`, `${localDay('v."arrivedAt"')} BETWEEN $2::date AND $3::date`];
    classFilter(where, p.$, f);
    const rows = await run(`SELECT v.*, ${STUDENT_SELECT} FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')} WHERE ${where.join(' AND ')}
        ORDER BY v."arrivedAt" DESC LIMIT ${MAX}`, p.list);
    const reasons = {};
    for (const r of rows) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('arrivedAt', 'Arrived', 'datetime'), col('number', 'Visit'), ...STUDENT_COLS, col('reason', 'Reason'), col('treatment', 'Treatment'), col('departedAt', 'Left', 'datetime'), col('parent', 'Parent contacted'), col('handledByName', 'Seen by')],
        rows: rows.map((r) => ({ ...withClass(r), parent: r.parentContacted ? 'Yes' : 'No' })),
        summary: [{ label: 'Students sent home', value: rows.length, tone: 'orange' }, { label: 'Parent contacted', value: rows.filter((r) => r.parentContacted).length }],
        chart: { type: 'bar', data: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ label: k, value: v })) },
    };
};

REPORTS.referrals = async (S, f) => {
    const w = await windowOf(S, f, { defaultDays: 90 });
    const p = params([S, w.from, w.to]);
    const where = [];
    classFilter(where, p.$, f);
    const extra = where.length ? ` AND ${where.join(' AND ')}` : '';
    const rows = await run(`
        SELECT * FROM (
          SELECT COALESCE((v."referral"->>'at')::timestamptz, v."departedAt", v."arrivedAt") AS at, 'Visit' AS source, v."number",
                 v."referral"->>'hospital' AS hospital, COALESCE(NULLIF(v."referral"->>'reason', ''), v."reason") AS reason,
                 v."referral"->>'transport' AS transport, v."referral"->>'accompaniedBy' AS "accompaniedBy", ${STUDENT_SELECT}
            FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')}
           WHERE v."school" = $1 AND v."archivedAt" IS NULL AND (v."referral"->>'referred')::boolean IS TRUE
             AND ${localDay('v."arrivedAt"')} BETWEEN $2::date AND $3::date${extra}
          UNION ALL
          SELECT COALESCE((i."referral"->>'at')::timestamptz, i."occurredAt"), 'Incident', i."number", i."referral"->>'hospital',
                 COALESCE(NULLIF(i."referral"->>'reason', ''), i."description"), i."referral"->>'transport', i."referral"->>'accompaniedBy', ${STUDENT_SELECT}
            FROM "medicalincidents" i ${STUDENT_JOIN('i."student"')}
           WHERE i."school" = $1 AND i."archivedAt" IS NULL AND (i."referral"->>'referred')::boolean IS TRUE AND i."visit" IS NULL
             AND ${localDay('i."occurredAt"')} BETWEEN $2::date AND $3::date${extra}
        ) x ORDER BY x.at DESC LIMIT ${MAX}`, p.list);
    const by = {};
    for (const r of rows) by[r.hospital || 'Not named'] = (by[r.hospital || 'Not named'] || 0) + 1;
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('at', 'When', 'datetime'), col('source', 'From'), col('number', 'No.'), ...STUDENT_COLS, col('hospital', 'Hospital'), col('reason', 'Reason'), col('transport', 'Transport'), col('accompaniedBy', 'Accompanied by')],
        rows: rows.map(withClass),
        summary: [{ label: 'Referrals', value: rows.length, tone: 'rose' }, { label: 'Hospitals', value: Object.keys(by).length }],
        chart: { type: 'bar', data: Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v })) },
    };
};

async function itemRows(S, f, s, extraWhere = '') {
    const today = todayStr();
    const p = params([S, today, s.expiryAlertDays]);
    const where = ['i."school" = $1', 'i."isActive" IS NOT FALSE'];
    if (f.kind === 'medicine' || f.kind === 'supply') where.push(`i."kind" = ${p.$(f.kind)}`);
    if (f.category) where.push(`i."category" = ${p.$(String(f.category))}`);
    if (extraWhere) where.push(extraWhere);
    return run(`SELECT i.*, bt.usable, bt.expiring, bt.expired, bt."nextExpiry", bt.batches, bt.value
          FROM "medicalitems" i
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(b."quantity") FILTER (WHERE b."expiryDate" IS NULL OR ${storedDay('b."expiryDate"')} >= $2::date), 0)::float8 AS usable,
                   COALESCE(SUM(b."quantity") FILTER (WHERE b."expiryDate" IS NOT NULL AND ${storedDay('b."expiryDate"')} >= $2::date AND ${storedDay('b."expiryDate"')} <= $2::date + $3::int), 0)::float8 AS expiring,
                   COALESCE(SUM(b."quantity") FILTER (WHERE b."expiryDate" IS NOT NULL AND ${storedDay('b."expiryDate"')} < $2::date), 0)::float8 AS expired,
                   MIN(b."expiryDate") FILTER (WHERE b."expiryDate" IS NOT NULL AND ${storedDay('b."expiryDate"')} >= $2::date) AS "nextExpiry",
                   count(*)::int AS batches, COALESCE(SUM(b."quantity" * b."unitCost"), 0)::float8 AS value
              FROM "medicalbatches" b WHERE b."item" = i."_id" AND b."status" = 'active' AND b."quantity" > 0) bt ON true
         WHERE ${where.join(' AND ')} ORDER BY i."kind", i."name" LIMIT ${MAX}`, p.list);
}

const stockState = (r) => (r.usable <= 0 ? 'out' : (r.minStock > 0 && r.usable <= r.minStock ? 'low' : 'ok'));
const STOCK_STATUS = { out: { label: 'Out of stock', tone: 'red' }, low: { label: 'Low stock', tone: 'amber' }, ok: { label: 'In stock', tone: 'green' } };

REPORTS.current_stock = async (S, f, s) => {
    const rows = await itemRows(S, f, s);
    const by = { ok: 0, low: 0, out: 0 };
    for (const r of rows) by[stockState(r)] += 1;
    return {
        columns: [col('name', 'Item'), col('kindLabel', 'Kind'), col('category', 'Category'), col('unit', 'Unit'), col('stock', 'On hand', 'number'), col('usable', 'Usable', 'number'), col('expired', 'Expired on shelf', 'number'), col('minStock', 'Minimum', 'number'), col('nextExpiry', 'Next expiry', 'day'), col('value', 'Value', 'money'), col('state', 'Status', 'status')],
        rows: rows.map((r) => ({ ...r, name: `${r.name}${r.strength ? ` ${r.strength}` : ''}`, kindLabel: r.kind === 'medicine' ? 'Medicine' : 'First-aid supply', state: stockState(r) })),
        summary: [{ label: 'Items', value: rows.length }, { label: 'In stock', value: by.ok, tone: 'green' }, { label: 'Low', value: by.low, tone: 'amber' }, { label: 'Out of stock', value: by.out, tone: 'red' },
            { label: 'Stock value', value: Math.round(rows.reduce((n, r) => n + Number(r.value || 0), 0)), money: true }],
        chart: { type: 'pie', data: Object.entries(by).map(([k, v]) => ({ label: STOCK_STATUS[k].label, value: v, tone: STOCK_STATUS[k].tone })) },
        statusMap: STOCK_STATUS,
    };
};

REPORTS.low_stock = async (S, f, s) => {
    const rows = (await itemRows(S, f, s)).filter((r) => r.minStock > 0 && r.usable <= r.minStock);
    return {
        columns: [col('name', 'Item'), col('kindLabel', 'Kind'), col('category', 'Category'), col('usable', 'Usable', 'number'), col('minStock', 'Minimum', 'number'), col('short', 'Short by', 'number'), col('supplier', 'Supplier'), col('state', 'Status', 'status')],
        rows: rows.map((r) => ({ ...r, name: `${r.name}${r.strength ? ` ${r.strength}` : ''}`, kindLabel: r.kind === 'medicine' ? 'Medicine' : 'First-aid supply', short: Math.max(0, Number(r.minStock) - Number(r.usable)), state: stockState(r) })),
        summary: [{ label: 'Items low', value: rows.filter((r) => r.usable > 0).length, tone: 'amber' }, { label: 'Out of stock', value: rows.filter((r) => r.usable <= 0).length, tone: 'red' }],
        chart: null,
        statusMap: STOCK_STATUS,
    };
};

REPORTS.expired = async (S, f) => {
    const w = await windowOf(S, f, { defaultDays: 365 });
    const today = todayStr();
    const p = params([S, today, w.from, w.to]);
    const where = ['b."school" = $1', `((b."status" = 'active' AND b."quantity" > 0 AND b."expiryDate" IS NOT NULL AND ${storedDay('b."expiryDate"')} < $2::date)
        OR (b."status" = 'expired' AND ${localDay('b."updatedAt"')} BETWEEN $3::date AND $4::date))`];
    if (f.kind === 'medicine' || f.kind === 'supply') where.push(`i."kind" = ${p.$(f.kind)}`);
    const rows = await run(`SELECT b.*, i."name", i."unit", i."kind", i."strength",
            (SELECT -SUM(m."quantity") FROM "medicalstockmoves" m WHERE m."batch" = b."_id" AND m."type" = 'expired')::float8 AS "writtenOff"
          FROM "medicalbatches" b JOIN "medicalitems" i ON i."_id" = b."item" WHERE ${where.join(' AND ')} ORDER BY b."expiryDate" LIMIT ${MAX}`, p.list);
    return {
        subtitle: `On the shelf now, and written off ${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('name', 'Item'), col('batchNumber', 'Batch'), col('expiryDate', 'Expired on', 'day'), col('onShelf', 'Still on shelf', 'number'), col('writtenOff', 'Written off', 'number'), col('unit', 'Unit'), col('state', 'Status', 'status')],
        rows: rows.map((r) => ({ ...r, name: `${r.name}${r.strength ? ` ${r.strength}` : ''}`, onShelf: r.status === 'active' ? r.quantity : 0, writtenOff: r.writtenOff || 0, state: r.status === 'active' ? 'on_shelf' : 'written_off' })),
        summary: [{ label: 'Expired batches on the shelf', value: rows.filter((r) => r.status === 'active').length, tone: 'red' }, { label: 'Written off', value: rows.filter((r) => r.status === 'expired').length }],
        chart: null,
        statusMap: { on_shelf: { label: 'On the shelf — remove', tone: 'red' }, written_off: { label: 'Written off', tone: 'slate' } },
    };
};

REPORTS.expiring = async (S, f, s) => {
    const today = todayStr();
    const days = Math.min(365, Math.max(1, Number(f.days) || s.expiryAlertDays));
    const p = params([S, today, days]);
    const where = ['b."school" = $1', `b."status" = 'active'`, 'b."quantity" > 0', 'b."expiryDate" IS NOT NULL', `${storedDay('b."expiryDate"')} >= $2::date`, `${storedDay('b."expiryDate"')} <= $2::date + $3::int`];
    if (f.kind === 'medicine' || f.kind === 'supply') where.push(`i."kind" = ${p.$(f.kind)}`);
    const rows = await run(`SELECT b.*, i."name", i."unit", i."kind", i."strength", (${storedDay('b."expiryDate"')} - $2::date)::int AS "daysLeft"
          FROM "medicalbatches" b JOIN "medicalitems" i ON i."_id" = b."item" WHERE ${where.join(' AND ')} ORDER BY b."expiryDate" LIMIT ${MAX}`, p.list);
    return {
        subtitle: `Expiring within ${days} days`,
        columns: [col('name', 'Item'), col('batchNumber', 'Batch'), col('expiryDate', 'Expires on', 'day'), col('daysLeft', 'Days left', 'number'), col('quantity', 'Quantity', 'number'), col('unit', 'Unit'), col('supplier', 'Supplier')],
        rows: rows.map((r) => ({ ...r, name: `${r.name}${r.strength ? ` ${r.strength}` : ''}` })),
        summary: [{ label: 'Batches', value: rows.length, tone: 'amber' }, { label: 'Within 30 days', value: rows.filter((r) => r.daysLeft <= 30).length, tone: 'red' }],
        chart: null,
    };
};

async function consumption(S, f, kind) {
    const w = await windowOf(S, f);
    const p = params([S, w.from, w.to, kind]);
    // A dose cancelled after it was given put its units back ('returned', refKind
    // 'dose'): it was never given, so it comes off what was administered.
    const rows = await run(`SELECT i."_id", i."name", i."strength", i."unit", i."category",
            (COALESCE(-SUM(m."quantity") FILTER (WHERE m."type" = 'administered'), 0)
             - COALESCE(SUM(m."quantity") FILTER (WHERE m."type" = 'returned' AND m."refKind" = 'dose'), 0))::float8 AS administered,
            COALESCE(-SUM(m."quantity") FILTER (WHERE m."type" = 'first_aid'), 0)::float8 AS "firstAid",
            COALESCE(-SUM(m."quantity") FILTER (WHERE m."type" = 'stock_out'), 0)::float8 AS "stockOut",
            COALESCE(-SUM(m."quantity") FILTER (WHERE m."type" IN ('expired','damaged','disposed')), 0)::float8 AS "writtenOff",
            COALESCE(SUM(m."quantity") FILTER (WHERE m."type" = 'stock_in'), 0)::float8 AS received,
            count(DISTINCT m."student")::int AS students, i."stock"
          FROM "medicalitems" i
          LEFT JOIN "medicalstockmoves" m ON m."item" = i."_id" AND ${localDay('m."createdAt"')} BETWEEN $2::date AND $3::date
         WHERE i."school" = $1 AND i."kind" = $4
         GROUP BY i."_id" HAVING count(m."_id") > 0
         ORDER BY COALESCE(-SUM(m."quantity") FILTER (WHERE m."type" IN ('administered','first_aid','stock_out')), 0) DESC, i."name" LIMIT ${MAX}`, p.list);
    const used = (r) => Number(r.administered) + Number(r.firstAid) + Number(r.stockOut);
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('name', 'Item'), col('category', 'Category'), col('unit', 'Unit'), ...(kind === 'medicine' ? [col('administered', 'Given to students', 'number')] : [col('firstAid', 'Used in first aid', 'number')]),
            col('stockOut', 'Taken out', 'number'), col('writtenOff', 'Written off', 'number'), col('received', 'Received', 'number'), col('students', 'Students', 'number'), col('stock', 'On hand now', 'number')],
        rows: rows.map((r) => ({ ...r, name: `${r.name}${r.strength ? ` ${r.strength}` : ''}` })),
        summary: [{ label: 'Items used', value: rows.filter((r) => used(r) > 0).length }, { label: 'Units used', value: Math.round(rows.reduce((n, r) => n + used(r), 0)) }, { label: 'Units received', value: Math.round(rows.reduce((n, r) => n + Number(r.received), 0)), tone: 'green' }],
        chart: { type: 'bar', data: rows.filter((r) => used(r) > 0).sort((a, b) => used(b) - used(a)).slice(0, 10).map((r) => ({ label: r.name, value: used(r) })) },
    };
}
REPORTS.medicine_consumption = (S, f) => consumption(S, f, 'medicine');
REPORTS.first_aid_consumption = (S, f) => consumption(S, f, 'supply');

REPORTS.movements = async (S, f) => {
    const w = await windowOf(S, f);
    const p = params([S, w.from, w.to]);
    const where = ['m."school" = $1', `${localDay('m."createdAt"')} BETWEEN $2::date AND $3::date`];
    if (f.kind === 'medicine' || f.kind === 'supply') where.push(`m."kind" = ${p.$(f.kind)}`);
    if (R.MOVE_TYPE[f.status]) where.push(`m."type" = ${p.$(f.status)}`);
    const rows = await run(`SELECT m.*, i."name", i."unit", i."strength", b."batchNumber", su."name" AS "studentName"
          FROM "medicalstockmoves" m JOIN "medicalitems" i ON i."_id" = m."item" LEFT JOIN "medicalbatches" b ON b."_id" = m."batch"
          LEFT JOIN "users" su ON su."_id" = m."student" WHERE ${where.join(' AND ')} ORDER BY m."createdAt" DESC LIMIT ${MAX}`, p.list);
    const by = {};
    for (const r of rows) by[r.type] = (by[r.type] || 0) + 1;
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('createdAt', 'When', 'datetime'), col('name', 'Item'), col('batchNumber', 'Batch'), col('type', 'Movement', 'status'), col('quantity', 'Quantity', 'signed'), col('itemBalance', 'Balance after', 'number'), col('studentName', 'Student'), col('reason', 'Reason'), col('byName', 'By')],
        rows: rows.map((r) => ({ ...r, name: `${r.name}${r.strength ? ` ${r.strength}` : ''}` })),
        summary: [{ label: 'Movements', value: rows.length }, ...Object.entries(by).map(([k, v]) => ({ label: label(R.MOVE_TYPE, k), value: v, tone: R.MOVE_TYPE[k]?.tone }))],
        chart: null,
    };
};

/* ── Health programmes ────────────────────────────────────────────────────── */

const BANDS = {
    severe_thinness: { label: 'Severe thinness', tone: 'red' }, thinness: { label: 'Thinness', tone: 'amber' },
    severe_wasting: { label: 'Severe wasting', tone: 'red' }, wasting: { label: 'Wasting', tone: 'amber' },
    healthy: { label: 'Healthy weight', tone: 'green' }, risk_overweight: { label: 'At risk of overweight', tone: 'amber' },
    overweight: { label: 'Overweight', tone: 'amber' }, obese: { label: 'Obese', tone: 'red' },
    severe_stunting: { label: 'Severely short for age', tone: 'red' }, stunting: { label: 'Short for age', tone: 'amber' },
    very_tall: { label: 'Very tall for age', tone: 'amber' }, normal: { label: 'Normal', tone: 'green' },
    check: { label: 'Check the measurement', tone: 'slate' }, none: { label: 'Not assessed', tone: 'slate' },
};

REPORTS.growth = async (S, f) => {
    const growth = require('./medicalGrowth');
    const p = params([S]);
    const where = ['u."school" = $1', `u."role" = 'student'`, 'u."isActive" IS NOT FALSE'];
    classFilter(where, p.$, f);
    const rows = await run(`SELECT mp."heightCm", mp."weightKg", mp."measuredOn", sp."dob", sp."gender", ${STUDENT_SELECT}
        FROM "users" u LEFT JOIN "studentprofiles" sp ON sp."user" = u."_id"
        LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
        LEFT JOIN "classes" c ON c."_id" = COALESCE(cs."class", sp."currentClass")
        LEFT JOIN "medicalprofiles" mp ON mp."student" = u."_id" AND mp."school" = $1
        WHERE ${where.join(' AND ')} ORDER BY c."className" NULLS LAST, cs."sectionName" NULLS LAST, u."name" LIMIT ${MAX}`, p.list);
    const by = {};
    const out = rows.map((r) => {
        const fresh = r.measuredOn && new Date(r.measuredOn) > new Date(Date.now() - 548 * 86400000);
        const a = fresh && (r.heightCm || r.weightKg) ? growth.assess({ sex: r.gender, dob: r.dob, on: r.measuredOn, heightCm: r.heightCm, weightKg: r.weightKg }) : null;
        const b = a?.indicators?.bmi; const h = a?.indicators?.height;
        const band = b?.band || 'none';
        by[band] = (by[band] || 0) + 1;
        return {
            ...withClass(r), measuredOn: fresh ? r.measuredOn : null, bmi: a?.bmi ?? null,
            bmiCentile: b && !b.implausible ? b.centile : null, bmiBand: band,
            heightCentile: h && !h.implausible ? h.centile : null, heightBand: h?.band || 'none',
            note: !fresh ? 'No measurement in the last 18 months' : (a?.note || ''),
        };
    });
    const order = ['severe_thinness', 'severe_wasting', 'thinness', 'wasting', 'healthy', 'risk_overweight', 'overweight', 'obese', 'check', 'none'];
    return {
        subtitle: 'WHO Child Growth Standards (under 5) and WHO Growth Reference 2007 (5–19 years) · the latest measurement in the last 18 months',
        columns: [...STUDENT_COLS, col('measuredOn', 'Measured', 'day'), col('heightCm', 'Height (cm)', 'number'), col('weightKg', 'Weight (kg)', 'number'), col('bmi', 'BMI', 'number'),
            col('bmiCentile', 'BMI percentile', 'number'), col('bmiBand', 'BMI-for-age', 'status'), col('heightCentile', 'Height percentile', 'number'), col('heightBand', 'Height-for-age', 'status'), col('note', 'Note')],
        rows: out, statusMap: BANDS,
        summary: order.filter((k) => by[k]).map((k) => ({ label: BANDS[k].label, value: by[k], tone: BANDS[k].tone })),
        chart: { type: 'bar', data: order.filter((k) => by[k] && k !== 'none').map((k) => ({ label: BANDS[k].label, value: by[k], tone: BANDS[k].tone })) },
    };
};

REPORTS.vaccine_coverage = async (S, f) => {
    const cov = await require('./medicalSchedule').coverage({ schoolId: S }, { classId: f.classId, sectionId: f.sectionId });
    if (!cov.on) return { subtitle: 'The school has not chosen a vaccination schedule — Settings → Programmes', columns: [col('label', 'Dose')], rows: [], summary: [], chart: null };
    return {
        subtitle: `${cov.students} current student${cov.students === 1 ? '' : 's'}${cov.noDob ? ` · ${cov.noDob} without a date of birth` : ''}`,
        columns: [col('label', 'Dose'), col('window', 'When'), col('applies', 'Students it applies to', 'number'), col('done', 'Given', 'number'), col('exempt', 'Exempt', 'number'),
            col('due', 'Due now', 'number'), col('overdue', 'Overdue', 'number'), col('no_record', 'No record', 'number'), col('coverage', 'Coverage %', 'number')],
        rows: cov.entries,
        summary: [{ label: 'Doses on the schedule', value: cov.entries.length }, { label: 'Overdue', value: cov.entries.reduce((n, e) => n + e.overdue, 0), tone: 'red' }, { label: 'Due now', value: cov.entries.reduce((n, e) => n + e.due, 0), tone: 'amber' }],
        chart: { type: 'bar', data: cov.entries.map((e) => ({ label: e.label, value: e.coverage || 0, tone: (e.coverage ?? 0) >= 90 ? 'green' : (e.coverage ?? 0) >= 70 ? 'amber' : 'red' })) },
    };
};

REPORTS.specialist_referrals = async (S, f) => {
    const ref = require('./medicalReferrals');
    const w = await windowOf(S, f, { defaultDays: 365 });
    const p = params([S, w.from, w.to]);
    const where = ['rf."school" = $1', `rf."status" <> 'cancelled'`, `${localDay('rf."createdAt"')} BETWEEN $2::date AND $3::date`];
    classFilter(where, p.$, f);
    const rows = (await run(`SELECT rf.*, ${STUDENT_SELECT} FROM "medicalreferrals" rf ${STUDENT_JOIN('rf."student"')} WHERE ${where.join(' AND ')} ORDER BY rf."createdAt" DESC LIMIT ${MAX}`, p.list))
        .map((r) => { const d = ref.decorate(r); return { ...withClass(d), specialty: d.specialtyLabel, state: d.overdue ? 'overdue' : d.status, seenOn: d.outcome?.seenOn || null, diagnosis: d.outcome?.diagnosis || '' }; });
    const statusMap = { ...ref.STATUS, overdue: { label: 'Overdue', tone: 'red' } };
    const by = {};
    for (const r of rows) by[r.state] = (by[r.state] || 0) + 1;
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('number', 'No.'), ...STUDENT_COLS, col('specialty', 'Referred to'), col('reason', 'Why'), col('createdAt', 'Raised', 'date'), col('dueBy', 'To be seen by', 'day'), col('state', 'Status', 'status'), col('seenOn', 'Seen on', 'day'), col('diagnosis', 'What the specialist found')],
        rows, statusMap,
        summary: Object.keys(statusMap).filter((k) => by[k]).map((k) => ({ label: statusMap[k].label, value: by[k], tone: statusMap[k].tone })),
        chart: { type: 'bar', data: Object.keys(statusMap).filter((k) => by[k]).map((k) => ({ label: statusMap[k].label, value: by[k], tone: statusMap[k].tone })) },
    };
};

REPORTS.campaigns = async (S, f) => {
    const camp = require('./medicalCampaigns');
    const w = await windowOf(S, f, { defaultDays: 365 });
    const rows = await run(`SELECT c.*,
            (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id") AS students,
            (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id" AND e."outcome" = 'given') AS given,
            (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id" AND e."outcome" = 'absent') AS absent,
            (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id" AND e."outcome" = 'refused') AS refused,
            (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id" AND e."outcome" = 'excluded') AS excluded,
            (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id" AND e."consent" = 'no') AS declined,
            (SELECT count(*)::int FROM "medicalcampaignentries" e WHERE e."campaign" = c."_id" AND e."consent" = 'yes') AS agreed
        FROM "medicalcampaigns" c WHERE c."school" = $1 AND c."status" IN ('announced','closed') AND ${storedDay('c."startOn"')} BETWEEN $2::date AND $3::date
        ORDER BY c."startOn" DESC LIMIT ${MAX}`, [S, w.from, w.to]);
    const out = rows.map((r) => {
        const d = camp.decorate(r);
        const eligible = r.consent === 'opt_in' ? r.agreed : r.students - r.declined;
        return { ...d, kind: d.kindLabel, state: d.phase, eligible, coverage: eligible ? Math.round((r.given / eligible) * 1000) / 10 : null };
    });
    const statusMap = { upcoming: { label: 'Coming up', tone: 'sky' }, running: { label: 'On now', tone: 'green' }, past: { label: 'Finished', tone: 'amber' }, closed: { label: 'Closed', tone: 'slate' } };
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('number', 'No.'), col('title', 'Campaign'), col('kind', 'Kind'), col('startOn', 'Day', 'day'), col('students', 'Students', 'number'), col('eligible', 'Could take part', 'number'), col('given', 'Given / done', 'number'),
            col('absent', 'Absent', 'number'), col('declined', 'Family said no', 'number'), col('excluded', 'Medical reason', 'number'), col('coverage', 'Coverage %', 'number'), col('state', 'Status', 'status')],
        rows: out, statusMap,
        summary: [{ label: 'Campaigns', value: out.length }, { label: 'Given / done', value: out.reduce((n, r) => n + r.given, 0), tone: 'green' }, { label: 'Absent', value: out.reduce((n, r) => n + r.absent, 0), tone: 'amber' }],
        chart: { type: 'bar', data: out.slice(0, 12).map((r) => ({ label: r.title, value: r.coverage || 0, tone: (r.coverage ?? 0) >= 90 ? 'green' : 'amber' })) },
    };
};

REPORTS.outbreaks = async (S, f) => {
    const w = await windowOf(S, f, { defaultDays: 365 });
    const rows = await run(`SELECT o.*, jsonb_array_length(COALESCE(o."notices",'[]'::jsonb))::int AS "noticeCount",
            (SELECT count(DISTINCT c->>'student')::int FROM jsonb_array_elements(COALESCE(o."cases",'[]'::jsonb)) c) AS "caseCount"
        FROM "medicaloutbreaks" o WHERE o."school" = $1 AND ${localDay('o."firstCaseAt"')} BETWEEN $2::date AND $3::date ORDER BY o."firstCaseAt" DESC LIMIT ${MAX}`, [S, w.from, w.to]);
    const statusMap = require('./medicalOutbreak').STATUS;
    return {
        subtitle: `${R.dayLabel(w.from)} to ${R.dayLabel(w.to)}`,
        columns: [col('number', 'No.'), col('label', 'Illness'), col('where', 'Where'), col('firstCaseAt', 'First case', 'date'), col('lastCaseAt', 'Last case', 'date'), col('caseCount', 'Children', 'number'),
            col('status', 'Status', 'status'), col('noticeCount', 'Notices sent', 'number'), col('reportedTo', 'Reported to')],
        rows: rows.map((r) => ({ ...r, where: r.scope?.label || '', reportedTo: r.reported?.to ? `${r.reported.to} (${R.dayLabel(r.reported.on)})` : '' })),
        statusMap,
        summary: [{ label: 'Outbreaks', value: rows.length }, { label: 'Confirmed', value: rows.filter((r) => r.status === 'confirmed' || r.confirmedAt).length, tone: 'red' }, { label: 'Children', value: rows.reduce((n, r) => n + r.caseCount, 0) }],
        chart: null,
    };
};

async function report(req, kind, query = {}) {
    const meta = CATALOGUE.find((c) => c.kind === kind);
    if (!meta) refuse('Unknown report', 404, 'MEDICAL_NOT_FOUND');
    const s = await settingsSvc.get(req.schoolId);
    const out = await REPORTS[kind](String(req.schoolId), query, s);
    return { kind, group: meta.group, title: meta.title, about: meta.about, generatedAt: new Date(), ...out, truncated: (out.rows || []).length >= MAX };
}

module.exports = { report, CATALOGUE };
