'use strict';
/**
 * The school's vaccination schedule (Oct 2026): which doses a child of each
 * age should have had, worked out from the date of birth and the vaccination
 * records — never stored — with exemptions counted apart.
 *
 * A school starts from a template and may change it:
 *   uip  the Government of India's Universal Immunization Programme, the
 *        school-age doses: DPT booster 2 at 5–6 years, Td at 10 and 16 years
 *   iap  the Indian Academy of Pediatrics' schedule, the school-age doses:
 *        DTaP/DTwP booster 2 and MMR 3 at 4–6 years, Tdap at 10–12 years,
 *        HPV (two doses, 9–14 years), influenza every year up to 5 years
 * The templates are a starting point for the school's doctor to check, and
 * the screen says so. Nothing is sent to families until the school turns the
 * reminders on.
 *
 * An entry: { key, vaccine, dose, from, to, sex, after, afterMonths,
 *             graceMonths, everyMonths, alsoCounts }
 *   from / to      age in months when the dose falls due / becomes overdue
 *   after          the key of the dose this one follows (HPV dose 2), due
 *                  `afterMonths` after it and overdue `graceMonths` later
 *   everyMonths    a dose that recurs (influenza every 12 months)
 *   alsoCounts     other vaccines that satisfy it (a Tdap counts as a Td)
 *
 * A record counts towards the LATEST dose of its vaccine whose window has
 * opened by the age it was given at (a year's leeway), so a Td at 16 counts
 * as the 16-year dose, not as a late 10-year one.
 */
const pool = require('../db/pool');
const MedicalVaccineExemption = require('../models/MedicalVaccineExemption');
const settingsSvc = require('./medicalSettings');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const { patch } = require('../db/patch');
const growth = require('./medicalGrowth');
const R = require('./medicalRules');
const { classOrderSql, sectionOrderSql } = require('../utils/listOrder');

const { refuse, str, num, isUuid, todayStr, dayStr, dayLabel, toDay, addDays } = R;
const S = (v) => String(v);

const TEMPLATES = {
    uip: {
        label: 'Universal Immunization Programme (Government of India)',
        entries: [
            { key: 'dpt_b2', vaccine: 'DTaP / DPT', dose: 'Booster 2', from: 60, to: 84 },
            { key: 'td_10', vaccine: 'Td booster', dose: '10 years', from: 120, to: 144, alsoCounts: ['Tdap'] },
            { key: 'td_16', vaccine: 'Td booster', dose: '16 years', from: 192, to: 216, alsoCounts: ['Tdap'] },
        ],
    },
    iap: {
        label: 'Indian Academy of Pediatrics (IAP) schedule',
        entries: [
            { key: 'dtp_b2', vaccine: 'DTaP / DPT', dose: 'Booster 2', from: 48, to: 84 },
            { key: 'mmr_3', vaccine: 'MMR', dose: 'Dose 3', from: 48, to: 84 },
            { key: 'tdap', vaccine: 'Tdap', dose: '10–12 years', from: 120, to: 156 },
            { key: 'hpv_1', vaccine: 'HPV', dose: 'Dose 1', from: 108, to: 180, sex: 'female' },
            { key: 'hpv_2', vaccine: 'HPV', dose: 'Dose 2', from: 108, to: 240, sex: 'female', after: 'hpv_1', afterMonths: 6, graceMonths: 6 },
            { key: 'flu', vaccine: 'Influenza', dose: 'Every year', from: 24, to: 60, everyMonths: 12 },
        ],
    },
};

const EXEMPT_REASON = {
    medical:   'Medical reason',
    immune:    'Already immune',
    religious: 'Religious or personal belief',
    declined:  'Family declined',
    other:     'Other',
};

const STATUS = {
    done:      { label: 'Given',      tone: 'green' },
    exempt:    { label: 'Exempt',     tone: 'slate' },
    due:       { label: 'Due now',    tone: 'amber' },
    due_soon:  { label: 'Due soon',   tone: 'sky' },
    overdue:   { label: 'Overdue',    tone: 'red' },
    no_record: { label: 'No record',  tone: 'slate' },
    later:     { label: 'Later',      tone: 'slate' },
};

// Names a family or an older record may use for the same vaccine.
const SYNONYMS = {
    dtapdpt: ['dtap', 'dpt', 'dtwp', 'dtp', 'dtapdpt', 'dtwpdtap', 'dtapdtwp', 'dptbooster'],
    tdbooster: ['td', 'tdbooster', 'tdvaccine', 'tetanusdiphtheria'],
    tdap: ['tdap'],
    mmr: ['mmr', 'measlesmumpsrubella'],
    hpv: ['hpv', 'humanpapillomavirus', 'gardasil', 'cervarix', 'cecolin'],
    influenza: ['influenza', 'flu', 'fluvaccine', 'influenzavaccine'],
    typhoid: ['typhoid', 'tcv', 'typhoidconjugate'],
    varicellachickenpox: ['varicella', 'chickenpox', 'varicellachickenpox'],
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const namesFor = (vaccine) => { const n = norm(vaccine); return new Set([n, ...(SYNONYMS[n] || [])]); };

const monthsLabel = (m) => (m % 12 === 0 ? `${m / 12} years` : `${Math.floor(m / 12)} y ${m % 12} m`);

/** The school's entries, checked; [] when the schedule is off. */
function entriesOf(settings) {
    const sch = settings?.vaccineSchedule || {};
    const list = Array.isArray(sch.entries) && sch.entries.length ? sch.entries
        : (TEMPLATES[sch.programme]?.entries || []);
    return list.map(clean).filter(Boolean);
}

function clean(e) {
    if (!e || typeof e !== 'object') return null;
    const key = str(e.key, 40).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const vaccine = str(e.vaccine, 80);
    const from = Math.round(num(e.from) ?? -1); const to = Math.round(num(e.to) ?? -1);
    if (!key || !vaccine || from < 0 || from > 228 || to <= from || to > 240) return null;
    const out = { key, vaccine, dose: str(e.dose, 40), from, to, sex: ['male', 'female'].includes(e.sex) ? e.sex : '' };
    if (e.after) { out.after = str(e.after, 40); out.afterMonths = Math.min(60, Math.max(1, Math.round(num(e.afterMonths) || 6))); out.graceMonths = Math.min(60, Math.max(1, Math.round(num(e.graceMonths) || 6))); }
    if (num(e.everyMonths)) out.everyMonths = Math.min(36, Math.max(6, Math.round(num(e.everyMonths))));
    if (Array.isArray(e.alsoCounts)) out.alsoCounts = e.alsoCounts.map((x) => str(x, 80)).filter(Boolean).slice(0, 5);
    out.label = `${vaccine}${out.dose ? ` — ${out.dose}` : ''}`;
    out.window = out.after ? `${out.afterMonths} months after ${out.after.replace(/_/g, ' ')}`
        : out.everyMonths ? `every ${out.everyMonths} months, ${monthsLabel(from)} to ${monthsLabel(to)}`
            : `${monthsLabel(from)} to ${monthsLabel(to)}`;
    return out;
}

/** Validate a schedule from the Settings screen. */
function validate(raw) {
    if (raw === null || raw === undefined) return {};
    if (typeof raw !== 'object') refuse('The vaccination schedule is not in the right shape');
    const programme = ['uip', 'iap', 'custom', ''].includes(raw.programme) ? raw.programme : '';
    const entries = [];
    if (Array.isArray(raw.entries)) {
        if (raw.entries.length > 30) refuse('A schedule can hold at most 30 doses');
        const keys = new Set();
        for (const e of raw.entries) {
            const c = clean(e);
            if (!c) refuse(`Check the dose "${str(e?.vaccine, 40) || 'unnamed'}": it needs a vaccine and an age range (from before to, up to 20 years)`);
            if (keys.has(c.key)) refuse(`Two doses share the key "${c.key}"`);
            keys.add(c.key);
            entries.push(c);
        }
        for (const e of entries) if (e.after && !keys.has(e.after)) refuse(`"${e.label}" follows a dose that is not on the schedule`);
    }
    return { programme, remind: !!raw.remind, entries: entries.map(({ label, window, ...e }) => e) };
}

/**
 * Each entry's status for one student.
 * student: { dob, gender }; records: given doses [{ vaccine, givenOn, verified }];
 * exemptions: active [{ vaccine, entryKey, reason, until }]
 */
function statusFor(student, entries, records, exemptions, today = todayStr(), dueDays = 30) {
    const age = growth.ageMonths(student.dob, today);
    const sex = growth.sexOf(student.gender);
    const out = [];
    if (age === null) return entries.map((e) => ({ ...e, status: 'unknown', statusLabel: 'Date of birth missing', tone: 'slate' }));
    const given = records.filter((r) => r.givenOn).map((r) => ({ ...r, n: norm(r.vaccine), day: dayStr(r.givenOn), atAge: growth.ageMonths(student.dob, r.givenOn) }))
        .sort((a, b) => (a.day < b.day ? -1 : 1));
    // Which record counts for which entry — per vaccine, latest opened window first.
    const taken = new Map();   // entry key → record
    const used = new Set();
    const matches = (e, r) => namesFor(e.vaccine).has(r.n) || (e.alsoCounts || []).some((x) => namesFor(x).has(r.n));
    for (const r of given) {
        const open = entries.filter((e) => !e.everyMonths && !taken.has(e.key) && matches(e, r)).filter((e) => {
            if (e.after) { const prev = taken.get(e.after); return prev && r.day >= addDays(prev.day, Math.round((e.afterMonths - 1) * 30.4)); }
            return r.atAge !== null && r.atAge >= e.from - 12;
        }).sort((a, b) => b.from - a.from || (a.after ? 1 : 0) - (b.after ? 1 : 0));
        // A dose that follows another wins over a fresh start of the same vaccine.
        const pick = open.find((e) => e.after) || open[0];
        if (pick && !used.has(r)) { taken.set(pick.key, r); used.add(r); }
    }
    for (const e of entries) {
        const base = { key: e.key, vaccine: e.vaccine, dose: e.dose, label: e.label, window: e.window };
        if (e.sex && sex && ((e.sex === 'male') !== (sex === 1))) continue;   // not for this child
        if (e.sex && !sex) { out.push({ ...base, status: 'unknown', statusLabel: 'Sex not recorded', tone: 'slate' }); continue; }
        const ex = exemptions.find((x) => namesFor(x.vaccine).has(norm(e.vaccine)) && (!x.entryKey || x.entryKey === e.key));
        let status; let dueOn = null; let record = null;
        if (e.everyMonths) {
            const last = given.filter((r) => matches(e, r)).pop();
            const fresh = last && last.day > addDays(today, -Math.round(e.everyMonths * 30.4));
            if (age < e.from) { status = 'later'; dueOn = addMonths(student.dob, e.from); }
            else if (age > e.to) { if (!fresh) continue; status = 'done'; record = last; }
            else if (fresh) { status = 'done'; record = last; dueOn = addMonths(last.day, e.everyMonths); }
            else { status = 'due'; dueOn = today; }
        } else if (taken.has(e.key)) { status = 'done'; record = taken.get(e.key); }
        else if (e.after) {
            const prev = taken.get(e.after);
            if (!prev) { if (age > e.to) continue; status = 'later'; }
            else {
                dueOn = addMonths(prev.day, e.afterMonths);
                const overdueOn = addMonths(prev.day, e.afterMonths + e.graceMonths);
                status = today >= overdueOn ? 'overdue' : today >= dueOn ? 'due' : dayStr(dueOn) <= addDays(today, dueDays) ? 'due_soon' : 'later';
            }
        } else {
            dueOn = addMonths(student.dob, e.from);
            const overdueOn = addMonths(student.dob, e.to);
            if (age >= e.to + 36) status = 'no_record';
            else if (today >= overdueOn) status = 'overdue';
            else if (age >= e.from) status = 'due';
            else status = dueOn <= addDays(today, dueDays) ? 'due_soon' : 'later';
        }
        if (ex && status !== 'done') {
            out.push({ ...base, status: 'exempt', statusLabel: `Exempt — ${EXEMPT_REASON[ex.reason] || ex.reason}`, tone: 'slate', exemption: ex._id ? S(ex._id) : null, exemptReason: ex.reason, dueOn });
            continue;
        }
        out.push({
            ...base, status, statusLabel: STATUS[status].label, tone: STATUS[status].tone, dueOn: dueOn ? dayStr(dueOn) : null,
            givenOn: record ? record.day : null, record: record?._id ? S(record._id) : null, unverified: record ? record.verified === false : false,
        });
    }
    return out;
}

function addMonths(day, months) {
    const d = new Date(`${dayStr(day)}T00:00:00Z`);
    const whole = Math.floor(months);
    d.setUTCMonth(d.getUTCMonth() + whole);
    return dayStr(d);
}

const activeExemptions = async (schoolId, studentIds, today = todayStr()) => (await pool.query(
    `SELECT "_id"::text AS "_id", "student"::text AS "student", "vaccine", "entryKey", "reason", "note", "until", "document"::text AS "document",
            "recordedByName", "createdAt"
       FROM "medicalvaccineexemptions"
      WHERE "school" = $1 AND "archivedAt" IS NULL AND ("until" IS NULL OR ("until" AT TIME ZONE 'UTC')::date >= $3::date)
        ${studentIds ? 'AND "student" = ANY($2::uuid[])' : 'AND $2::text IS NULL'}`,
    [S(schoolId), studentIds ? studentIds.map(S) : null, today],
)).rows;

const givenRecords = async (schoolId, studentIds) => (await pool.query(
    `SELECT "_id"::text AS "_id", "student"::text AS "student", "vaccine", "dose", "givenOn", "verified"
       FROM "medicalvaccinations"
      WHERE "school" = $1 AND "archivedAt" IS NULL AND "givenOn" IS NOT NULL
        ${studentIds ? 'AND "student" = ANY($2::uuid[])' : 'AND $2::text IS NULL'}`,
    [S(schoolId), studentIds ? studentIds.map(S) : null],
)).rows;

/** One student's schedule — for their record (staff) or the family's page. */
async function forStudent(schoolId, student, settings = null) {
    const s = settings || await settingsSvc.get(schoolId);
    const entries = entriesOf(s);
    if (!entries.length) return { on: false, entries: [], exemptions: [] };
    const [records, exemptions] = await Promise.all([givenRecords(schoolId, [student._id]), activeExemptions(schoolId, [student._id])]);
    return {
        on: true,
        programme: s.vaccineSchedule?.programme || 'custom',
        programmeLabel: TEMPLATES[s.vaccineSchedule?.programme]?.label || 'The school\'s schedule',
        entries: statusFor(student, entries, records, exemptions, todayStr(), s.vaccinationDueDays),
        exemptions: exemptions.map((x) => ({ ...x, reasonLabel: EXEMPT_REASON[x.reason] || x.reason })),
    };
}

/** Every current student of a class/section (or the school) with what the schedule needs. */
async function students(schoolId, f = {}) {
    const p = [S(schoolId)];
    let where = '';
    if (isUuid(f.sectionId)) { p.push(f.sectionId); where = `AND sp."currentSection" = $${p.length}::uuid`; }
    else if (isUuid(f.classId)) { p.push(f.classId); where = `AND COALESCE(cs."class", sp."currentClass") = $${p.length}::uuid`; }
    return (await pool.query(
        `SELECT u."_id"::text AS "_id", u."name", sp."admissionNumber", sp."dob", sp."gender",
                sp."currentSection"::text AS "sectionId", COALESCE(cs."class", sp."currentClass")::text AS "classId",
                c."className", cs."sectionName"
           FROM "users" u
           JOIN "studentprofiles" sp ON sp."user" = u."_id"
           LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
           LEFT JOIN "classes" c ON c."_id" = COALESCE(cs."class", sp."currentClass")
          WHERE u."school" = $1 AND u."role" = 'student' AND u."isActive" IS NOT FALSE ${where}
          ORDER BY ${classOrderSql('c')}, ${sectionOrderSql('cs')}, u."name"`, p,
    )).rows.map((r) => ({ ...r, classLabel: [r.className, r.sectionName].filter(Boolean).join(' – ') }));
}

/**
 * Coverage: per dose, how many students it applies to and where they stand;
 * and, for one dose, the students in a chosen status.
 */
async function coverage(req, f = {}) {
    const s = await settingsSvc.get(req.schoolId);
    const entries = entriesOf(s);
    if (!entries.length) return { on: false, entries: [], rows: [], templates: templateList() };
    const list = await students(req.schoolId, f);
    const ids = list.map((x) => x._id);
    const [records, exemptions] = await Promise.all([givenRecords(req.schoolId, null), activeExemptions(req.schoolId, null)]);
    const recBy = group(records); const exBy = group(exemptions);
    const today = todayStr();
    const per = new Map(entries.map((e) => [e.key, { key: e.key, label: e.label, window: e.window, applies: 0, done: 0, exempt: 0, due: 0, due_soon: 0, overdue: 0, no_record: 0, later: 0, unknown: 0 }]));
    const chosen = per.has(f.entry) ? f.entry : entries[0].key;
    const want = STATUS[f.status] || f.status === 'unknown' ? f.status : '';
    const rows = [];
    let noDob = 0;
    for (const st of list) {
        if (!st.dob) noDob += 1;
        const res = statusFor(st, entries, recBy.get(st._id) || [], exBy.get(st._id) || [], today, s.vaccinationDueDays);
        for (const r of res) {
            const c = per.get(r.key);
            c[r.status] = (c[r.status] || 0) + 1;
            if (r.status !== 'later') c.applies += 1;
            if (r.key === chosen && r.status !== 'later' && (!want || r.status === want)) {
                rows.push({ studentId: st._id, studentName: st.name, admissionNumber: st.admissionNumber, classLabel: st.classLabel, dob: st.dob, ...r });
            }
        }
    }
    const summary = [...per.values()].map((c) => {
        const base = c.applies - c.exempt;
        return { ...c, coverage: base > 0 ? Math.round((c.done / base) * 1000) / 10 : null };
    });
    const ORDER = { overdue: 0, due: 1, due_soon: 2, no_record: 3, unknown: 4, exempt: 5, done: 6 };
    rows.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || String(a.classLabel).localeCompare(String(b.classLabel)) || a.studentName.localeCompare(b.studentName));
    void ids;
    return {
        on: true, programme: s.vaccineSchedule?.programme || 'custom', remind: !!s.vaccineSchedule?.remind,
        entries: summary, entry: chosen, status: want, rows: rows.slice(0, 1000), total: rows.length, students: list.length, noDob,
        templates: templateList(),
    };
}

const group = (rows) => {
    const m = new Map();
    for (const r of rows) { const k = S(r.student); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
};

const templateList = () => Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, entries: t.entries.map(clean) }));

/* ── Exemptions ───────────────────────────────────────────────────────────── */

async function addExemption(req, studentId, body = {}) {
    const student = await access.assertStudent(req.schoolId, studentId, { current: true });
    const vaccine = str(body.vaccine, 80);
    if (!vaccine) refuse('Choose the vaccine');
    const reason = Object.prototype.hasOwnProperty.call(EXEMPT_REASON, body.reason) ? body.reason : null;
    if (!reason) refuse('Choose why the student is exempt');
    const note = str(body.note, 1000);
    if (['medical', 'other'].includes(reason) && note.length < 5) refuse('Say what the reason is');
    const until = body.until ? toDay(body.until) : null;
    if (body.until && !until) refuse('The end date is not a date');
    if (until && dayStr(until) < todayStr()) refuse('The end date has passed');
    let document = null;
    if (isUuid(body.document)) {
        const { rows } = await pool.query(`SELECT "_id" FROM "medicaldocuments" WHERE "_id" = $1 AND "school" = $2 AND "student" = $3`, [body.document, S(req.schoolId), S(student._id)]);
        if (!rows[0]) refuse('That document is not on this student\'s record');
        document = body.document;
    }
    const row = await MedicalVaccineExemption.create({
        school: req.schoolId, student: student._id, vaccine, entryKey: str(body.entryKey, 40), reason, note, until, document,
        recordedBy: req.userId, recordedByName: req.user?.name || '',
    });
    audit.log(req, { action: 'exempted', entity: 'vaccination', entityId: row._id, student: student._id, summary: `${student.name} exempted from ${vaccine} — ${EXEMPT_REASON[reason]}` });
    return row.toObject ? row.toObject() : row;
}

async function endExemption(req, id, body = {}) {
    if (!isUuid(id)) refuse('Exemption not found', 404, 'MEDICAL_NOT_FOUND');
    const why = str(body.reason, 300);
    if (why.length < 3) refuse('Say why the exemption ends');
    const row = await patch(MedicalVaccineExemption, id, { archivedAt: new Date(), archivedBy: req.userId, archiveReason: why }, { where: { school: req.schoolId, archivedAt: null } });
    if (!row) refuse('This exemption has already ended', 409, 'MEDICAL_STALE');
    audit.log(req, { action: 'exemption_ended', entity: 'vaccination', entityId: id, student: row.student, summary: `Exemption from ${row.vaccine} ended — ${why}` });
    return row;
}

/* ── Telling families ─────────────────────────────────────────────────────── */

/** The sweep: a family is told once when a dose of the schedule falls due (when the school has turned reminders on). */
async function remindDue(schoolId, s, claim) {
    if (!s.vaccineSchedule?.remind) return 0;
    const entries = entriesOf(s);
    if (!entries.length) return 0;
    const list = await students(schoolId);
    const [records, exemptions] = await Promise.all([givenRecords(schoolId, null), activeExemptions(schoolId, null)]);
    const recBy = group(records); const exBy = group(exemptions);
    const today = todayStr();
    let told = 0;
    for (const st of list) {
        if (!st.dob) continue;
        for (const r of statusFor(st, entries, recBy.get(st._id) || [], exBy.get(st._id) || [], today, s.vaccinationDueDays)) {
            if (!['due', 'due_soon'].includes(r.status)) continue;
            // Yearly doses are claimed per year, the rest once.
            const subject = `${st._id}:${r.key}${r.dueOn && entries.find((e) => e.key === r.key)?.everyMonths ? `:${today.slice(0, 4)}` : ''}`;
            if (!(await claim(schoolId, 'schedule_due', subject, 'info', { student: st._id, entry: r.key }))) continue;
            const parents = await tell.parentIds(st._id);
            tell.system(schoolId, {
                to: parents, setting: 'parentVaccinationDue',
                link: { type: 'medical.child', params: { child: st._id, tab: 'vaccinations' } },
                title: `Vaccination due — ${st.name}`,
                body: `${st.name}'s ${r.label} ${r.status === 'due' ? 'is due now' : `is due on ${dayLabel(r.dueOn)}`} (school vaccination schedule). Once it is given, please send the certificate to the school's Medical Room.`,
                i18n: { key: 'schedule_due', vars: { name: st.name, label: r.label, now: r.status === 'due', due: r.dueOn ? dayLabel(r.dueOn) : '' } },
            });
            told += 1;
        }
    }
    return told;
}

/** From the coverage screen: ask the families of the students in one status for the card or the dose. */
async function askFamilies(req, body = {}) {
    const s = await settingsSvc.get(req.schoolId);
    const entries = entriesOf(s);
    const entry = entries.find((e) => e.key === body.entry);
    if (!entry) refuse('Choose a dose of the schedule');
    const want = ['due', 'overdue', 'no_record'].includes(body.status) ? body.status : null;
    if (!want) refuse('Families are asked about doses that are due, overdue or with no record');
    const cov = await coverage(req, { entry: entry.key, status: want, classId: body.classId, sectionId: body.sectionId });
    const today = todayStr();
    const { claim } = require('./medicalSweep');
    let told = 0;
    for (const r of cov.rows) {
        if (!(await claim(req.schoolId, 'schedule_ask', `${r.studentId}:${entry.key}:${today}`, 'info'))) continue;
        tell.toParents(req, r.studentId, {
            setting: 'parentVaccinationDue', tab: 'vaccinations',
            title: `Vaccination record — ${r.studentName}`,
            body: want === 'no_record'
                ? `The school has no record of ${r.studentName}'s ${entry.label}. If it was given, please send the certificate to the Medical Room.`
                : `${r.studentName}'s ${entry.label} ${want === 'overdue' ? 'is overdue' : 'is due'}. If it has been given, please send the certificate to the Medical Room; if not, please speak to your doctor.`,
        });
        told += 1;
    }
    audit.log(req, { action: 'families_asked', entity: 'vaccination', summary: `${told} famil${told === 1 ? 'y' : 'ies'} asked about ${entry.label} (${STATUS[want].label.toLowerCase()})` });
    return { told, skipped: cov.rows.length - told };
}

module.exports = { TEMPLATES, EXEMPT_REASON, STATUS, entriesOf, validate, statusFor, forStudent, coverage, addExemption, endExemption, remindDue, askFamilies, templateList };
