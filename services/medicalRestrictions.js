'use strict';
/**
 * Limits and time off (Oct 2026).
 *
 * Restrictions — what a student must not do, or needs, for a while: no PE
 * after a sprain, extra water, toilet breaks, a seat near the door. Teachers
 * see only the instruction (`teacherText`), never the reason; the family and
 * the medical staff see both.
 *
 * Exclusions — off school until it is safe to come back. Each rule gives the
 * earliest return (hours or days from when the clock starts) and whether a
 * doctor's fitness certificate is needed; a school can change both, or switch
 * a rule off, in its settings (`exclusionRules`). The medical staff clear the
 * child; returning earlier than the rule, or without the certificate it asks
 * for, needs a reason. Class teachers hear "away until …", never the illness.
 */
const pool = require('../db/pool');
const { patch } = require('../db/patch');
const MedicalRestriction = require('../models/MedicalRestriction');
const MedicalExclusion = require('../models/MedicalExclusion');
const settingsSvc = require('./medicalSettings');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
const R = require('./medicalRules');

const { refuse, notFound, str, num, oneOf, bool, isUuid, toDay, toInstant, todayStr, dayLabel, instantLabel } = R;
const S = (v) => String(v);
const who = (req) => req.user?.name || '';
const plain = (row) => (row && typeof row.toObject === 'function' ? row.toObject() : row);

/* ── Restrictions ─────────────────────────────────────────────────────────── */

const RESTRICTION_KIND = {
    no_pe:         { label: 'No PE', text: 'No PE or games — may watch' },
    no_sports:     { label: 'No sports', text: 'No sports, matches or rough play' },
    no_outdoor:    { label: 'Indoors at break', text: 'Stays indoors at break times' },
    no_stairs:     { label: 'Avoid stairs', text: 'Avoid stairs — ground floor or the lift' },
    extra_water:   { label: 'Water in class', text: 'Allow a water bottle and drinks in class' },
    toilet_access: { label: 'Toilet access', text: 'Allow toilet visits without asking' },
    rest_breaks:   { label: 'Rest breaks', text: 'Allow rest breaks when needed' },
    seating:       { label: 'Seating', text: 'Seat near the door' },
    diet:          { label: 'Food', text: 'Light food only' },
    screen:        { label: 'Screen time', text: 'Limit screen time and reading; rest if headachy' },
    other:         { label: 'Other', text: '' },
};

/** upcoming | active | ended, for a day. */
function restrictionState(r, today = todayStr()) {
    if (r.archivedAt || r.endedAt) return 'ended';
    const start = R.dayStr(r.startsOn);
    const end = r.endsOn ? R.dayStr(r.endsOn) : null;
    if (start > today) return 'upcoming';
    if (end && end < today) return 'ended';
    return 'active';
}

function restrictionFields(body, { partial = false, prev = null } = {}) {
    const out = {};
    if (!partial || body.kind !== undefined) out.kind = oneOf(body.kind, RESTRICTION_KIND, prev?.kind || 'other');
    const kind = out.kind || prev?.kind || 'other';
    if (!partial || body.teacherText !== undefined) {
        out.teacherText = str(body.teacherText, 200) || RESTRICTION_KIND[kind].text;
        if (!out.teacherText) refuse('Say what teachers should do — e.g. "No PE, may watch"');
    }
    if (!partial || body.reason !== undefined) out.reason = str(body.reason, 300);
    if (!partial || body.startsOn !== undefined) out.startsOn = toDay(body.startsOn) || toDay(todayStr());
    if (!partial || body.endsOn !== undefined) out.endsOn = body.endsOn ? toDay(body.endsOn) : null;
    const start = out.startsOn || prev?.startsOn;
    const end = out.endsOn !== undefined ? out.endsOn : prev?.endsOn;
    if (end && start && R.dayStr(end) < R.dayStr(start)) refuse('The last day is before the first');
    if (end && R.daysBetween(R.dayStr(start), R.dayStr(end)) > 366) refuse('A restriction runs for at most a year — set a review date');
    return out;
}

async function findRestriction(req, id) {
    if (!isUuid(id)) notFound('Restriction');
    const r = await MedicalRestriction.findOne({ _id: id, school: req.schoolId }).lean();
    if (!r) notFound('Restriction');
    return r;
}

const until = (r) => (r.endsOn ? `until ${dayLabel(r.endsOn)}` : 'until further notice');

async function addRestriction(req, studentId, body = {}) {
    const student = await access.assertStudent(req.schoolId, studentId);
    const f = restrictionFields(body);
    let visit = null;
    if (body.visit) {
        if (!isUuid(body.visit)) refuse('That visit is not valid');
        const v = await pool.query(`SELECT "_id" FROM "medicalvisits" WHERE "_id" = $1 AND "school" = $2 AND "student" = $3`, [S(body.visit), S(req.schoolId), S(student._id)]);
        if (!v.rows.length) refuse('That visit is about another student');
        visit = S(body.visit);
    }
    const row = plain(await MedicalRestriction.create({ school: req.schoolId, student: student._id, visit, ...f, createdBy: req.userId, createdByName: who(req) }));
    audit.log(req, { action: 'created', entity: 'restriction', entityId: row._id, student: student._id, summary: `${student.name}: ${row.teacherText} — ${until(row)}${row.reason ? ` (${row.reason})` : ''}` });
    const when = `${R.dayStr(row.startsOn) > todayStr() ? `From ${dayLabel(row.startsOn)}, ` : ''}${until(row)}`;
    // Teachers: the instruction only.
    tell.toTeachers(req, {
        studentId: student._id, setting: 'teacherClassAlert',
        title: `${student.name}: ${row.teacherText}`,
        body: `${when.charAt(0).toUpperCase()}${when.slice(1)} — from the Medical Room.`,
    });
    tell.toParents(req, student._id, {
        title: `At school: ${row.teacherText}`,
        body: `The Medical Room has asked ${student.name}'s teachers: ${row.teacherText.charAt(0).toLowerCase()}${row.teacherText.slice(1)} — ${when}${row.reason ? ` (${row.reason})` : ''}.`,
        setting: 'parentVisit', tab: 'overview',
    });
    // The student too — what the teachers see, in the same words, never the reason. Only when the
    // school lets students open their Medical Room page, behind the students' switch.
    const s = await require('./medicalSettings').get(req.schoolId);
    if (s.studentAccess !== false && s.notify?.studentReminders !== false) {
        tell.system(req.schoolId, {
            to: [S(student._id)], link: { type: 'medical.child', params: { child: S(student._id), tab: 'overview' } },
            title: `From the Medical Room: ${row.teacherText}`,
            body: `${row.teacherText} — ${when}. Your teachers know.`,
            i18n: { key: 'restriction_student', vars: { text: row.teacherText, until: row.endsOn ? dayLabel(row.endsOn) : '' } },
        });
    }
    return row;
}

async function updateRestriction(req, id, body = {}) {
    const r = await findRestriction(req, id);
    if (r.endedAt || r.archivedAt) refuse('This restriction has ended');
    const set = restrictionFields(body, { partial: true, prev: r });
    const changes = audit.diff(r, set);
    if (!changes.length) return r;
    const row = await patch(MedicalRestriction, id, set, { where: { school: req.schoolId } });
    audit.log(req, { action: 'updated', entity: 'restriction', entityId: id, student: r.student, summary: `Restriction changed: ${row.teacherText} — ${until(row)}`, changes });
    return row;
}

async function endRestriction(req, id, body = {}) {
    const r = await findRestriction(req, id);
    if (r.endedAt) refuse('This restriction has already ended');
    const note = str(body.note, 300);
    const row = await patch(MedicalRestriction, id, { endedAt: new Date(), endedBy: req.userId, endedByName: who(req), endNote: note }, { where: { school: req.schoolId, endedAt: null } });
    if (!row) refuse('This restriction changed a moment ago — reload', 409, 'MEDICAL_STALE');
    audit.log(req, { action: 'ended', entity: 'restriction', entityId: id, student: r.student, summary: `Restriction ended early: ${r.teacherText}${note ? ` — ${note}` : ''}` });
    const card = await access.studentCard(req.schoolId, r.student);
    tell.toTeachers(req, {
        studentId: r.student, setting: 'teacherClassAlert',
        title: `${card?.name || 'A student'}: no longer needed`,
        body: `“${r.teacherText}” no longer applies — from the Medical Room.`,
    });
    // The family and the student were told when it began — they hear it is over.
    const name = card?.name || 'your child';
    tell.toParents(req, r.student, {
        title: `At school: “${r.teacherText}” — no longer needed`,
        body: `The Medical Room has told ${name}'s teachers that “${r.teacherText}” no longer applies.`,
        setting: 'parentVisit', tab: 'overview',
        i18n: { key: 'restriction_ended', vars: { name, text: r.teacherText } },
    }).catch((e) => console.error('[medical] restriction notice failed:', e.message));
    const s = await require('./medicalSettings').get(req.schoolId);
    if (s.studentAccess !== false && s.notify?.studentReminders !== false) {
        tell.system(req.schoolId, {
            to: [S(r.student)], link: { type: 'medical.child', params: { child: S(r.student), tab: 'overview' } },
            title: `From the Medical Room: “${r.teacherText}” no longer applies`,
            body: `“${r.teacherText}” is over — your teachers know.`,
        });
    }
    return row;
}

/** Restrictions in force today (and those starting soon) for some students: [{ ...row, state }]. */
async function restrictionsFor(schoolId, studentIds, { withReason = false, days = 7 } = {}) {
    const ids = [...new Set((studentIds || []).map(S).filter(isUuid))];
    if (!ids.length) return [];
    const today = todayStr();
    const { rows } = await pool.query(
        `SELECT "_id"::text AS "_id", "student"::text AS "student", "kind", "teacherText", "reason", "startsOn", "endsOn", "endedAt", "createdByName", "createdAt"
           FROM "medicalrestrictions"
          WHERE "school" = $1 AND "student" = ANY($2::uuid[]) AND "archivedAt" IS NULL AND "endedAt" IS NULL
            AND ("endsOn" IS NULL OR ("endsOn" AT TIME ZONE 'UTC')::date >= $3::date)
            AND ("startsOn" AT TIME ZONE 'UTC')::date <= $3::date + $4::int
          ORDER BY "startsOn"`,
        [S(schoolId), ids, today, days],
    );
    return rows.map((r) => {
        const out = { ...r, state: restrictionState(r, today), kindLabel: RESTRICTION_KIND[r.kind]?.label || 'Other' };
        if (!withReason) delete out.reason;
        return out;
    });
}

/* ── Exclusions ───────────────────────────────────────────────────────────── */

const EXCLUSION_RULES = {
    fever:          { label: 'Fever', hours: 24, needsCertificate: false, text: 'Back when there has been no fever for 24 hours without fever medicine.' },
    vomiting:       { label: 'Vomiting or diarrhoea', hours: 48, needsCertificate: false, text: 'Back 48 hours after the last episode of vomiting or diarrhoea.' },
    flu:            { label: 'Flu-like illness', hours: 24, needsCertificate: false, text: 'Back when well and with no fever for 24 hours.' },
    conjunctivitis: { label: 'Conjunctivitis (eye flu)', hours: 24, needsCertificate: false, text: 'Back 24 hours after treatment started, when the eyes are no longer discharging.' },
    chickenpox:     { label: 'Chickenpox', days: 5, needsCertificate: false, text: 'At least 5 days from when the rash appeared, and until every blister has crusted over.' },
    measles:        { label: 'Measles', days: 4, needsCertificate: false, text: 'Back 4 days after the rash appeared.' },
    mumps:          { label: 'Mumps', days: 5, needsCertificate: false, text: 'Back 5 days after the swelling started.' },
    rubella:        { label: 'Rubella (German measles)', days: 5, needsCertificate: false, text: 'Back 5 days after the rash appeared.' },
    hand_foot_mouth: { label: 'Hand, foot and mouth disease', hours: 0, needsCertificate: false, text: 'Back when well and the blisters have dried.' },
    impetigo:       { label: 'Impetigo', hours: 48, needsCertificate: false, text: 'Back 48 hours after starting antibiotics, or when the sores have crusted over.' },
    scabies:        { label: 'Scabies', hours: 24, needsCertificate: false, text: 'Back after the first treatment (24 hours).' },
    scarlet_fever:  { label: 'Scarlet fever', hours: 24, needsCertificate: false, text: 'Back 24 hours after starting antibiotics.' },
    hepatitis_a:    { label: 'Hepatitis A / jaundice', days: 7, needsCertificate: true, text: 'Back 7 days after the jaundice started, with a doctor\'s fitness certificate.' },
    typhoid:        { label: 'Typhoid', hours: 0, needsCertificate: true, text: 'Back when a doctor certifies the child fit for school.' },
    covid:          { label: 'COVID-19', hours: 24, needsCertificate: false, text: 'Back when well and with no fever for 24 hours, or as the school\'s current policy says.' },
    other:          { label: 'Other illness', hours: 0, needsCertificate: false, text: 'Back on the date the Medical Room gives.' },
};

/** The rules as this school has them (its changes over the defaults; switched-off rules left out). */
function rulesFor(settings) {
    const over = settings?.exclusionRules || {};
    const out = {};
    for (const [k, base] of Object.entries(EXCLUSION_RULES)) {
        const o = over[k] || {};
        if (o.off && k !== 'other') continue;
        out[k] = { ...base, hours: o.hours ?? base.hours ?? 0, days: o.days ?? base.days ?? 0, needsCertificate: o.needsCertificate ?? base.needsCertificate };
        if (o.hours != null || o.days != null) out[k].text = o.text || base.text;
    }
    return out;
}

/** Checked overrides for the settings screen: { key: { hours, days, needsCertificate, off } }. */
function cleanRules(raw) {
    if (!raw || typeof raw !== 'object') refuse('Return-to-school rules must be a set of rules');
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!EXCLUSION_RULES[k] || !v || typeof v !== 'object') continue;
        const o = {};
        if (v.hours !== undefined && v.hours !== null && v.hours !== '') { const n = num(v.hours); if (n === null || n < 0 || n > 336 || !Number.isInteger(n)) refuse(`${EXCLUSION_RULES[k].label}: hours must be a whole number from 0 to 336`); o.hours = n; }
        if (v.days !== undefined && v.days !== null && v.days !== '') { const n = num(v.days); if (n === null || n < 0 || n > 30 || !Number.isInteger(n)) refuse(`${EXCLUSION_RULES[k].label}: days must be a whole number from 0 to 30`); o.days = n; }
        if (v.needsCertificate !== undefined) o.needsCertificate = bool(v.needsCertificate);
        if (v.off !== undefined && k !== 'other') o.off = bool(v.off);
        if (Object.keys(o).length) out[k] = o;
    }
    return out;
}

function earliestOf(rule, from, until = null) {
    if (until) return until;
    const ms = ((rule.days || 0) * 24 + (rule.hours || 0)) * 3600000;
    if (!ms) return rule.needsCertificate ? null : new Date(from);
    return new Date(new Date(from).getTime() + ms);
}

async function findExclusion(req, id) {
    if (!isUuid(id)) notFound('Return-to-school record');
    const e = await MedicalExclusion.findOne({ _id: id, school: req.schoolId }).lean();
    if (!e) notFound('Return-to-school record');
    return e;
}

const returnLine = (e) => (e.earliestReturn ? `from ${instantLabel(e.earliestReturn)}` : 'when a doctor certifies them fit');

/**
 * Off school: body { rule, from?, until? (other), note, visit? }.
 * One open exclusion per student: a second one replaces the first's dates.
 */
async function addExclusion(req, studentId, body = {}, { visit = null, quiet = false } = {}) {
    const student = await access.assertStudent(req.schoolId, studentId);
    const settings = await settingsSvc.get(req.schoolId);
    const rules = rulesFor(settings);
    const rule = rules[body.rule];
    if (!rule) refuse('Choose why the student must stay off school');
    const from = toInstant(body.from) || new Date();
    if (from > new Date(Date.now() + 5 * 60000)) refuse('The start is in the future');
    let untilAt = null;
    if (body.rule === 'other') {
        // A day on its own is the start of that day on the school's clock.
        const u = String(body.until || '');
        untilAt = /^\d{4}-\d{2}-\d{2}$/.test(u) ? new Date(`${u}T00:00:00`) : toInstant(body.until);
        if (!untilAt && !bool(body.needsCertificate)) refuse('Give the date the student can come back');
        if (untilAt && untilAt < from) refuse('The return date is before the start');
    }
    const needsCertificate = body.rule === 'other' ? bool(body.needsCertificate) : rule.needsCertificate;
    const fields = {
        rule: body.rule, label: rule.label, text: body.rule === 'other' ? (str(body.note, 300) || rule.text) : rule.text,
        from, earliestReturn: earliestOf({ ...rule, needsCertificate }, from, untilAt), needsCertificate, note: str(body.note, 300),
        visit: visit || (isUuid(body.visit) ? S(body.visit) : null),
    };
    const open = await MedicalExclusion.findOne({ school: req.schoolId, student: student._id, status: 'excluded' }).lean();
    const row = open
        ? await patch(MedicalExclusion, open._id, fields, { where: { school: req.schoolId, status: 'excluded' } })
        : plain(await MedicalExclusion.create({ school: req.schoolId, student: student._id, ...fields, status: 'excluded', createdBy: req.userId, createdByName: who(req) }));
    audit.log(req, { action: open ? 'updated' : 'created', entity: 'exclusion', entityId: row._id, student: student._id, summary: `${student.name} off school (${rule.label}) — back ${returnLine(row)}${needsCertificate ? ', with a fitness certificate' : ''}` });
    if (!quiet) {
        tell.toParents(req, student._id, {
            title: `When ${student.name} can come back to school`,
            body: `${student.name} must stay off school (${rule.label.toLowerCase()}): ${row.text} Earliest return: ${row.earliestReturn ? instantLabel(row.earliestReturn) : 'when a doctor certifies them fit'}.${needsCertificate ? ' Please upload a doctor\'s fitness certificate in the app before they return.' : ''}`,
            setting: 'parentSentHome', urgent: false, tab: 'overview',
        });
    }
    // Class teachers: away until — never the illness.
    tell.toTeachers(req, {
        studentId: student._id, setting: 'teacherClassAlert',
        title: `${student.name} is off school`,
        body: `${student.name} is away for health reasons, back ${row.earliestReturn ? `no earlier than ${instantLabel(row.earliestReturn)}` : 'when cleared by the Medical Room'}.`,
    });
    return row;
}

/** Cleared to come back. Earlier than the rule, or without the certificate it asks for, needs a reason. */
async function clearExclusion(req, id, body = {}) {
    const e = await findExclusion(req, id);
    if (e.status !== 'excluded') refuse(`This is already ${e.status}`);
    const override = str(body.override, 300);
    if (e.needsCertificate && !e.certificateDoc && !override) {
        refuse('A fitness certificate is needed and none has been uploaded — give a reason to clear without it', 409, 'MEDICAL_NEEDS_CERTIFICATE');
    }
    if (e.earliestReturn && new Date(e.earliestReturn) > new Date() && !override) {
        refuse(`The rule says not before ${instantLabel(e.earliestReturn)} — give a reason to clear earlier`, 409, 'MEDICAL_TOO_EARLY');
    }
    const note = str(body.note, 300);
    const row = await patch(MedicalExclusion, id, {
        status: 'cleared', clearedAt: new Date(), clearedBy: req.userId, clearedByName: who(req), clearNote: [note, override && `Cleared early / without certificate: ${override}`].filter(Boolean).join(' — '),
    }, { where: { school: req.schoolId, status: 'excluded' } });
    if (!row) refuse('This changed a moment ago — reload', 409, 'MEDICAL_STALE');
    audit.log(req, { action: override ? 'cleared_override' : 'cleared', entity: 'exclusion', entityId: id, student: e.student, summary: `Cleared to return (${e.label})${override ? ` — ${override}` : ''}${note ? ` — ${note}` : ''}` });
    const card = await access.studentCard(req.schoolId, e.student);
    tell.toTeachers(req, { studentId: e.student, setting: 'teacherClassAlert', title: `${card?.name || 'A student'} can come back to school`, body: `${card?.name || 'The student'} has been cleared by the Medical Room.` });
    tell.toParents(req, e.student, { title: `${card?.name || 'Your child'} can come back to school`, body: `The Medical Room has cleared ${card?.name || 'your child'} to return.${note ? ` ${note}` : ''}`, setting: 'parentSentHome', tab: 'overview' });
    return row;
}

async function cancelExclusion(req, id, body = {}) {
    const e = await findExclusion(req, id);
    if (e.status !== 'excluded') refuse(`This is already ${e.status}`);
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say why this is cancelled');
    const row = await patch(MedicalExclusion, id, { status: 'cancelled', cancelReason: reason }, { where: { school: req.schoolId, status: 'excluded' } });
    audit.log(req, { action: 'cancelled', entity: 'exclusion', entityId: id, student: e.student, summary: `Off-school record cancelled — ${reason}` });
    return row;
}

/** The family uploads the fitness certificate (multer has stored the file). */
async function attachCertificate(req, id, file) {
    const e = await findExclusion(req, id);
    if (req.userRole === 'parent') await access.familyChild(req, S(e.student));
    if (e.status !== 'excluded') refuse('This is no longer open');
    const health = require('./medicalHealth');
    const card = await access.studentCard(req.schoolId, e.student);
    const doc = await health.addDocument(req, S(e.student), {
        type: 'fitness_certificate', title: `Fitness certificate — ${card?.name || ''}`.trim(), visibility: 'family', linkKind: e.visit ? 'visit' : '', linkId: e.visit || null,
    }, file, { status: req.userRole === 'parent' ? 'pending' : 'verified', source: req.userRole === 'parent' ? 'parent' : 'staff' });
    const row = await patch(MedicalExclusion, id, { certificateDoc: doc._id }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'certificate_uploaded', entity: 'exclusion', entityId: id, student: e.student, summary: `Fitness certificate uploaded for ${card?.name || 'the student'}` });
    if (req.userRole === 'parent') {
        tell.toStaff(req, { title: `Fitness certificate — ${card?.name || 'a student'}`, body: `${who(req)} uploaded a fitness certificate. Check it and clear ${card?.name || 'the student'} to return.`, setting: 'staffParentUpdates' });
    }
    return row;
}

/** Open exclusions (and the last week's cleared ones) for some students. */
async function exclusionsFor(schoolId, studentIds, { withDetail = false } = {}) {
    const ids = [...new Set((studentIds || []).map(S).filter(isUuid))];
    if (!ids.length) return [];
    const { rows } = await pool.query(
        `SELECT "_id"::text AS "_id", "student"::text AS "student", "rule", "label", "text", "from", "earliestReturn", "needsCertificate",
                "certificateDoc"::text AS "certificateDoc", "status", "clearedAt", "clearedByName", "note", "visit"::text AS "visit"
           FROM "medicalexclusions"
          WHERE "school" = $1 AND "student" = ANY($2::uuid[]) AND ("status" = 'excluded' OR ("status" = 'cleared' AND "clearedAt" > now() - interval '7 days'))
          ORDER BY "createdAt" DESC`,
        [S(schoolId), ids],
    );
    return withDetail ? rows : rows.map(({ rule, label, text, note, visit, certificateDoc, needsCertificate, ...r }) => r);
}

module.exports = {
    RESTRICTION_KIND, EXCLUSION_RULES, restrictionState, rulesFor, cleanRules,
    findRestriction, addRestriction, updateRestriction, endRestriction, restrictionsFor,
    findExclusion, addExclusion, clearExclusion, cancelExclusion, attachCertificate, exclusionsFor,
};
