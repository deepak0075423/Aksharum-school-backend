'use strict';
/**
 * A student's health record (Oct 2026): the medical profile, allergies,
 * conditions, vaccinations, health checkups, documents — and the parents'
 * proposed updates that feed them. The one writer of all of these.
 *
 * Nothing here erases history. A record that no longer applies is resolved;
 * one entered by mistake is archived with who and why; every change is in the
 * medical audit log (services/medicalAudit) with what it was before.
 *
 * Two facts are not kept here: the blood group and the emergency contact live
 * on StudentProfile (the admission form's), and saveProfile writes them there.
 */
const fs = require('fs');
const path = require('path');
const { patch } = require('../db/patch');
const { newId } = require('../db/schema');
const MedicalProfile = require('../models/MedicalProfile');
const MedicalAllergy = require('../models/MedicalAllergy');
const MedicalCondition = require('../models/MedicalCondition');
const MedicalVaccination = require('../models/MedicalVaccination');
const MedicalCheckup = require('../models/MedicalCheckup');
const MedicalDocument = require('../models/MedicalDocument');
const MedicalChangeRequest = require('../models/MedicalChangeRequest');
const StudentProfile = require('../models/StudentProfile');
const audit = require('./medicalAudit');
const tell = require('./medicalNotify');
// Who sees a child's emergency card is told when it changes (services/medicalNeedToKnow) — required late: it reads through medicalRead.
const ntk = () => require('./medicalNeedToKnow');
const CARD_KINDS = ['allergy', 'condition', 'rescue_med', 'care_plan'];
const access = require('./medicalAccess');
const settingsSvc = require('./medicalSettings');
const { isPhone, normalizePhone } = require('../utils/validators');
const R = require('./medicalRules');

const { refuse, notFound, str, num, bool, oneOf, isUuid, toDay, dayStr, dayLabel, todayStr } = R;
const who = (req) => req.user?.name || '';
const plainOf = (row) => (row && typeof row.toObject === 'function' ? row.toObject() : row);
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'medical-docs');

function phone(v, label) {
    const p = str(v, 30);
    if (p && !isPhone(p)) refuse(`${label} must be a valid 10-digit mobile number`);
    return normalizePhone(p);
}

/* ── Profile ──────────────────────────────────────────────────────────────── */

async function profileOf(schoolId, studentId) {
    return MedicalProfile.findOne({ school: schoolId, student: studentId }).lean();
}

/**
 * Save the profile. Blood group and emergency contact go to StudentProfile.
 * `privateNotes` only from medical staff (the controller strips it otherwise).
 */
async function saveProfile(req, studentId, body = {}) {
    const student = await access.assertStudent(req.schoolId, studentId, { current: true });
    const card = await ntk().cardBefore(req, student._id);
    const before = (await profileOf(req.schoolId, student._id)) || {};
    const set = {};
    if (body.heightCm !== undefined || body.weightKg !== undefined) {
        const h = body.heightCm === undefined ? before.heightCm : num(body.heightCm);
        const w = body.weightKg === undefined ? before.weightKg : num(body.weightKg);
        if (h !== null && h !== undefined && (h < 40 || h > 230)) refuse('Height must be in centimetres (40–230)');
        if (w !== null && w !== undefined && (w < 5 || w > 250)) refuse('Weight must be in kilograms (5–250)');
        if (h !== before.heightCm || w !== before.weightKg) {
            set.heightCm = h ?? null; set.weightKg = w ?? null;
            set.measuredOn = toDay(body.measuredOn) || toDay(todayStr()); set.measuredBy = 'profile';
        }
    }
    if (body.dietaryRestrictions !== undefined) set.dietaryRestrictions = str(body.dietaryRestrictions, 600);
    if (body.instructions !== undefined) set.instructions = str(body.instructions, 1200);
    if (body.doctor !== undefined) {
        set.doctor = { name: str(body.doctor?.name, 120), phone: phone(body.doctor?.phone, 'The doctor\'s phone'), clinic: str(body.doctor?.clinic, 160) };
    }
    if (body.hospital !== undefined) {
        set.hospital = { name: str(body.hospital?.name, 160), phone: phone(body.hospital?.phone, 'The hospital\'s phone'), address: str(body.hospital?.address, 300) };
    }
    if (body.alternateContact !== undefined) {
        set.alternateContact = { name: str(body.alternateContact?.name, 120), phone: phone(body.alternateContact?.phone, 'The alternate contact\'s phone'), relation: str(body.alternateContact?.relation, 60) };
    }
    if (body.emergencyMedication !== undefined) {
        const em = body.emergencyMedication || {};
        set.emergencyMedication = {
            required: bool(em.required), name: str(em.name, 120), location: str(em.location, 160), instructions: str(em.instructions, 600),
        };
        if (set.emergencyMedication.required && !set.emergencyMedication.name) refuse('Name the emergency medication');
    }
    if (body.privateNotes !== undefined) set.privateNotes = str(body.privateNotes, 4000);
    if (bool(body.reviewed)) { set.reviewedAt = new Date(); set.reviewedBy = req.userId; }

    // The two facts StudentProfile owns.
    const spSet = {};
    if (body.bloodGroup !== undefined) {
        const bg = str(body.bloodGroup, 4).toUpperCase();
        if (bg && !R.BLOOD_GROUPS.includes(bg)) refuse(`Blood group must be one of ${R.BLOOD_GROUPS.join(', ')}`);
        spSet.bloodGroup = bg;
    }
    if (body.emergencyContact !== undefined) {
        const ec = body.emergencyContact || {};
        spSet.emergencyContactName = str(ec.name, 120);
        spSet.emergencyContactPhone = phone(ec.phone, 'The emergency contact\'s phone');
        spSet.emergencyContactRelation = str(ec.relation, 60);
    }

    const sp = Object.keys(spSet).length ? await StudentProfile.findOne({ user: student._id, school: req.schoolId }).lean() : null;
    const changes = [...audit.diff(before, set), ...audit.diff(sp || {}, spSet)];
    if (!changes.length && !set.reviewedAt) return getProfileRow(req.schoolId, student._id);

    if (Object.keys(spSet).length) {
        if (!sp) refuse('This student has no admission record to hold the blood group and emergency contact');
        await patch(StudentProfile, sp._id, spSet, { touch: false });
    }
    if (Object.keys(set).length) {
        if (before._id) await patch(MedicalProfile, before._id, { ...set, updatedBy: req.userId });
        else {
            try { await MedicalProfile.create({ school: req.schoolId, student: student._id, ...set, updatedBy: req.userId }); }
            catch { const again = await profileOf(req.schoolId, student._id); if (again) await patch(MedicalProfile, again._id, { ...set, updatedBy: req.userId }); }
        }
    }
    ntk().cardAfter(req, card);
    audit.log(req, { action: changes.length ? 'updated' : 'reviewed', entity: 'profile', student: student._id, summary: changes.length ? `Medical profile of ${student.name} updated` : `Medical profile of ${student.name} reviewed`, changes });
    return getProfileRow(req.schoolId, student._id);
}

async function getProfileRow(schoolId, studentId) {
    return (await profileOf(schoolId, studentId)) || { student: String(studentId), school: String(schoolId) };
}

/* ── Allergies & conditions ───────────────────────────────────────────────── */

const KINDS = {
    allergy:   { Model: MedicalAllergy, label: 'Allergy', name: (r) => r.allergen },
    condition: { Model: MedicalCondition, label: 'Medical condition', name: (r) => r.condition },
    vaccination: { Model: MedicalVaccination, label: 'Vaccination', name: (r) => `${r.vaccine}${r.dose ? ` (${r.dose})` : ''}` },
    checkup:   { Model: MedicalCheckup, label: 'Health checkup', name: (r) => R.CHECKUP_TYPE[r.type] || 'Checkup' },
    document:  { Model: MedicalDocument, label: 'Document', name: (r) => r.title },
    // Archived and restored like the rest; edited through services/medicalCare.
    rescue_med: { Model: require('../models/MedicalRescueMed'), label: 'Rescue medicine', name: (r) => r.name },
    care_plan:  { Model: require('../models/MedicalCarePlan'), label: 'Care plan', name: (r) => r.title },
    restriction: { Model: require('../models/MedicalRestriction'), label: 'Restriction', name: (r) => r.teacherText },
};

async function findRecord(req, kind, id) {
    const k = KINDS[kind];
    if (!k || !isUuid(id)) notFound('Record');
    const row = await k.Model.findOne({ _id: id, school: req.schoolId }).lean();
    if (!row) notFound(k.label);
    return row;
}

async function linkedDocs(req, studentId, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter(isUuid).map(String))];
    if (!list.length) return [];
    const docs = await MedicalDocument.find({ _id: { $in: list }, school: req.schoolId, student: studentId, archivedAt: null }).select('_id').lean();
    return docs.map((d) => String(d._id));
}

function allergyFields(body, prev = {}) {
    const out = {};
    if (body.allergen !== undefined) out.allergen = str(body.allergen, 120);
    if (body.category !== undefined) out.category = oneOf(body.category, R.ALLERGY_CATEGORY, prev.category || 'other');
    if (body.severity !== undefined) out.severity = oneOf(body.severity, R.ALLERGY_SEVERITY, prev.severity || 'mild');
    for (const k of ['reaction', 'emergencyInstructions', 'medication', 'doctor', 'parentNote']) if (body[k] !== undefined) out[k] = str(body[k], 800);
    if (body.shareWithTeachers !== undefined) out.shareWithTeachers = bool(body.shareWithTeachers);
    return out;
}

function conditionFields(body, prev = {}) {
    const out = {};
    if (body.condition !== undefined) out.condition = str(body.condition, 120);
    if (body.type !== undefined) out.type = oneOf(body.type, R.CONDITION_TYPE, prev.type || 'other');
    if (body.severity !== undefined) out.severity = oneOf(body.severity, R.CONDITION_SEVERITY, prev.severity || 'mild');
    if (body.chronic !== undefined) out.chronic = bool(body.chronic);
    if (body.diagnosedOn !== undefined) {
        out.diagnosedOn = toDay(body.diagnosedOn);
        if (out.diagnosedOn && dayStr(out.diagnosedOn) > todayStr()) refuse('The diagnosis date is in the future');
    }
    for (const k of ['treatment', 'medication', 'doctor', 'emergencyInstructions', 'parentNote']) if (body[k] !== undefined) out[k] = str(body[k], 800);
    if (body.shareWithTeachers !== undefined) out.shareWithTeachers = bool(body.shareWithTeachers);
    if (body.status !== undefined) out.status = oneOf(body.status, R.CONDITION_STATUS, prev.status || 'active');
    return out;
}

/**
 * addRecord(req, 'allergy' | 'condition', studentId, body, { source, verified })
 * A parent's record (approved through a change request) is `source: 'parent'`.
 */
async function addHealthRecord(req, kind, studentId, body, { source = 'staff', verified = true } = {}) {
    const student = await access.assertStudent(req.schoolId, studentId, { current: true });
    const card = await ntk().cardBefore(req, student._id);
    const fields = kind === 'allergy' ? allergyFields(body) : conditionFields(body);
    if (kind === 'allergy' && !fields.allergen) refuse('Name what the student is allergic to');
    if (kind === 'condition' && !fields.condition) {
        fields.condition = R.CONDITION_TYPE[fields.type] && fields.type !== 'other' ? R.CONDITION_TYPE[fields.type] : '';
        if (!fields.condition) refuse('Name the condition');
    }
    const Model = KINDS[kind].Model;
    // The same allergen twice is almost always the same fact entered twice.
    const nameKey = kind === 'allergy' ? 'allergen' : 'condition';
    const dup = await Model.find({ school: req.schoolId, student: student._id, archivedAt: null }).select(`${nameKey} status`).lean();
    if (dup.some((d) => String(d[nameKey]).toLowerCase() === fields[nameKey].toLowerCase() && d.status !== 'resolved')) {
        refuse(`${student.name} already has ${fields[nameKey]} on record — edit that one instead`, 409, 'MEDICAL_DUPLICATE');
    }
    if (fields.shareWithTeachers === undefined) fields.shareWithTeachers = R.defaultShare(kind, { severity: fields.severity || 'mild', type: fields.type });
    const row = plainOf(await Model.create({
        school: req.schoolId, student: student._id, ...fields,
        documents: await linkedDocs(req, student._id, body.documents),
        status: kind === 'condition' ? (fields.status || 'active') : 'active',
        source, verified, verifiedBy: verified ? req.userId : null, verifiedAt: verified ? new Date() : null,
        createdBy: req.userId, updatedBy: req.userId,
    }));
    audit.log(req, { action: 'created', entity: kind, entityId: row._id, student: student._id, summary: `${KINDS[kind].label} added for ${student.name}: ${KINDS[kind].name(row)}${source === 'parent' ? ' (from a parent)' : ''}` });
    ntk().cardAfter(req, card);
    return row;
}

async function updateHealthRecord(req, kind, id, body) {
    const row = await findRecord(req, kind, id);
    if (row.archivedAt) refuse('This record is archived — restore it first');
    const fields = kind === 'allergy' ? allergyFields(body, row) : conditionFields(body, row);
    if (kind === 'allergy' && fields.allergen === '') refuse('The allergen cannot be empty');
    if (kind === 'condition' && fields.condition === '') refuse('The condition cannot be empty');
    if (body.documents !== undefined) fields.documents = await linkedDocs(req, row.student, body.documents);
    if (kind === 'allergy' && body.status !== undefined) fields.status = body.status === 'resolved' ? 'resolved' : 'active';
    const changes = audit.diff(row, fields);
    if (!changes.length) return row;
    const card = await ntk().cardBefore(req, row.student);
    const out = await patch(KINDS[kind].Model, id, { ...fields, updatedBy: req.userId }, { where: { school: req.schoolId } });
    audit.log(req, { action: fields.status && fields.status !== row.status ? `marked_${fields.status}` : 'updated', entity: kind, entityId: id, student: row.student, summary: `${KINDS[kind].label} ${KINDS[kind].name(row)} updated`, changes });
    ntk().cardAfter(req, card);
    return out;
}

async function verifyRecord(req, kind, id) {
    // A document is checked by reviewing it (it has a status, not a "verified"
    // flag); a checkup is the medical room's own record and has nothing to verify.
    if (kind === 'document') return reviewDocument(req, id, { status: 'verified' });
    if (kind === 'checkup') refuse('A checkup is recorded by the Medical Room — there is nothing to verify');
    if (kind === 'rescue_med' || kind === 'care_plan' || kind === 'restriction') refuse('This is the Medical Room\'s own record — there is nothing to verify');
    const row = await findRecord(req, kind, id);
    if (row.verified) refuse('This record is already verified');
    const card = CARD_KINDS.includes(kind) ? await ntk().cardBefore(req, row.student) : null;
    const out = await patch(KINDS[kind].Model, id, { verified: true, verifiedBy: req.userId, verifiedAt: new Date() }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'verified', entity: kind, entityId: id, student: row.student, summary: `${KINDS[kind].label} ${KINDS[kind].name(row)} verified` });
    ntk().cardAfter(req, card);
    return out;
}

/** Archive (never delete). Confirmed by the screen, and the reason is kept. */
async function archiveRecord(req, kind, id, body = {}) {
    const row = await findRecord(req, kind, id);
    if (row.archivedAt) refuse('This record is already archived');
    const reason = str(body.reason, 300);
    if (!reason) refuse('Say why this record is being archived');
    const card = CARD_KINDS.includes(kind) ? await ntk().cardBefore(req, row.student) : null;
    const out = await patch(KINDS[kind].Model, id, { archivedAt: new Date(), archivedBy: req.userId, archiveReason: reason }, { where: { school: req.schoolId, archivedAt: null } });
    audit.log(req, { action: 'archived', entity: kind, entityId: id, student: row.student, summary: `${KINDS[kind].label} ${KINDS[kind].name(row)} archived — ${reason}` });
    ntk().cardAfter(req, card);
    return out;
}

async function restoreRecord(req, kind, id) {
    const row = await findRecord(req, kind, id);
    if (!row.archivedAt) refuse('This record is not archived');
    const card = CARD_KINDS.includes(kind) ? await ntk().cardBefore(req, row.student) : null;
    const out = await patch(KINDS[kind].Model, id, { archivedAt: null, archivedBy: null, archiveReason: '' }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'restored', entity: kind, entityId: id, student: row.student, summary: `${KINDS[kind].label} ${KINDS[kind].name(row)} restored` });
    ntk().cardAfter(req, card);
    return out;
}

/* ── Vaccinations ─────────────────────────────────────────────────────────── */

function vaccinationFields(body, prev = {}) {
    const out = {};
    if (body.vaccine !== undefined) out.vaccine = str(body.vaccine, 120);
    if (body.dose !== undefined) out.dose = str(body.dose, 60);
    for (const k of ['givenOn', 'dueOn', 'nextDueOn']) if (body[k] !== undefined) out[k] = toDay(body[k]);
    for (const k of ['provider', 'doctor', 'lotNumber', 'remarks']) if (body[k] !== undefined) out[k] = str(body[k], 300);
    const given = out.givenOn !== undefined ? out.givenOn : prev.givenOn;
    if (given && dayStr(given) > todayStr()) refuse('A vaccine cannot be given on a future date — record it as due instead');
    if (out.nextDueOn && given && dayStr(out.nextDueOn) <= dayStr(given)) refuse('The next dose must be due after this one was given');
    return out;
}

async function addVaccination(req, studentId, body, { source = 'staff', verified = true } = {}) {
    const student = await access.assertStudent(req.schoolId, studentId, { current: true });
    const f = vaccinationFields(body);
    if (!f.vaccine) refuse('Name the vaccine');
    if (!f.givenOn && !f.dueOn) refuse('Give the date it was given, or the date it is due');
    if (body.certificate) {
        const docs = await linkedDocs(req, student._id, [body.certificate]);
        if (!docs.length) refuse('That certificate is not one of this student\'s documents');
        f.certificate = docs[0];
    }
    const base = { school: req.schoolId, student: student._id, source, verified, verifiedBy: verified ? req.userId : null, verifiedAt: verified ? new Date() : null, createdBy: req.userId, updatedBy: req.userId };
    const row = plainOf(await MedicalVaccination.create({ ...base, ...f, dueOn: f.givenOn ? (f.dueOn || null) : f.dueOn }));
    audit.log(req, { action: 'created', entity: 'vaccination', entityId: row._id, student: student._id, summary: `${f.vaccine}${f.dose ? ` ${f.dose}` : ''} ${f.givenOn ? `given on ${dayLabel(f.givenOn)}` : `due on ${dayLabel(f.dueOn)}`} — ${student.name}` });
    if (f.givenOn && f.nextDueOn) await scheduleNextDose(req, row, base);
    return row;
}

/** A dose given with a next date: the next dose becomes a pending row of its own. */
async function scheduleNextDose(req, given, base) {
    const exists = await MedicalVaccination.findOne({ school: req.schoolId, student: given.student, vaccine: given.vaccine, givenOn: null, archivedAt: null }).lean();
    if (exists) return null;
    const m = String(given.dose || '').match(/(\d+)/);
    const dose = m ? given.dose.replace(m[1], String(Number(m[1]) + 1)) : 'Next dose';
    const row = plainOf(await MedicalVaccination.create({ ...base, vaccine: given.vaccine, dose, dueOn: given.nextDueOn, provider: given.provider || '' }));
    audit.log(req, { action: 'created', entity: 'vaccination', entityId: row._id, student: given.student, summary: `${given.vaccine} ${dose} scheduled for ${dayLabel(given.nextDueOn)}` });
    return row;
}

async function updateVaccination(req, id, body) {
    const row = await findRecord(req, 'vaccination', id);
    if (row.archivedAt) refuse('This record is archived');
    const f = vaccinationFields(body, row);
    if (f.vaccine === '') refuse('The vaccine cannot be empty');
    if (body.certificate !== undefined) {
        f.certificate = body.certificate ? (await linkedDocs(req, row.student, [body.certificate]))[0] || null : null;
    }
    const changes = audit.diff(row, f);
    if (!changes.length) return row;
    const out = await patch(MedicalVaccination, id, { ...f, updatedBy: req.userId }, { where: { school: req.schoolId } });
    audit.log(req, { action: 'updated', entity: 'vaccination', entityId: id, student: row.student, summary: `${row.vaccine} updated`, changes });
    if (!row.givenOn && out.givenOn && out.nextDueOn) await scheduleNextDose(req, out, { school: req.schoolId, student: row.student, source: 'staff', verified: true, verifiedBy: req.userId, verifiedAt: new Date(), createdBy: req.userId, updatedBy: req.userId });
    return out;
}

/** A pending dose given: `{ givenOn, provider, doctor, lotNumber, nextDueOn, remarks, certificate }`. */
async function markVaccinationGiven(req, id, body) {
    const row = await findRecord(req, 'vaccination', id);
    if (row.givenOn) refuse('This dose is already recorded as given');
    return updateVaccination(req, id, { ...body, givenOn: body.givenOn || todayStr() });
}

/* ── Health checkups ──────────────────────────────────────────────────────── */

function resultsOf(raw = {}) {
    const r = {};
    for (const k of ['heightCm', 'weightKg', 'bpSystolic', 'bpDiastolic', 'pulse']) {
        const n = num(raw[k]);
        if (n !== null) r[k] = n;
    }
    if (r.heightCm !== undefined && (r.heightCm < 40 || r.heightCm > 230)) refuse('Height must be in centimetres (40–230)');
    if (r.weightKg !== undefined && (r.weightKg < 5 || r.weightKg > 250)) refuse('Weight must be in kilograms (5–250)');
    for (const k of ['visionLeft', 'visionRight', 'colourVision', 'hearingLeft', 'hearingRight', 'dental', 'general']) {
        const s = str(raw[k], 200);
        if (s) r[k] = s;
    }
    const b = R.bmi(r.heightCm, r.weightKg);
    if (b !== null) r.bmi = b;
    return r;
}

function checkupFields(body, prev = {}) {
    const out = {};
    if (body.type !== undefined) out.type = oneOf(body.type, R.CHECKUP_TYPE, prev.type || 'general');
    if (body.professional !== undefined) out.professional = str(body.professional, 120);
    if (body.results !== undefined) out.results = resultsOf(body.results);
    if (body.outcome !== undefined) out.outcome = oneOf(body.outcome, R.CHECKUP_OUTCOME, '');
    for (const k of ['findings', 'observations', 'recommendations']) if (body[k] !== undefined) out[k] = str(body[k], 1500);
    if (body.checkedOn !== undefined) {
        out.checkedOn = toDay(body.checkedOn);
        if (out.checkedOn && dayStr(out.checkedOn) > todayStr()) refuse('A checkup cannot be recorded for a future date — schedule it instead');
    }
    if (body.followUp !== undefined) {
        const fu = body.followUp || {};
        out.followUp = bool(fu.required)
            ? { required: true, on: toDay(fu.on), note: str(fu.note, 300), status: prev.followUp?.status && prev.followUp.status !== '' ? prev.followUp.status : 'pending', doneAt: prev.followUp?.doneAt || null, doneBy: prev.followUp?.doneBy || null, outcome: prev.followUp?.outcome || '' }
            : { required: false, on: null, note: '', status: '', doneAt: null, doneBy: null, outcome: '' };
    }
    return out;
}

/** Height and weight from a checkup become the profile's latest — unless the profile has a newer reading. */
async function noteMeasurements(req, studentId, checkedOn, results) {
    if (results?.heightCm === undefined && results?.weightKg === undefined) return;
    const p = await profileOf(req.schoolId, studentId);
    if (p?.measuredOn && dayStr(p.measuredOn) > dayStr(checkedOn)) return;
    const set = { measuredOn: checkedOn, measuredBy: 'checkup' };
    if (results.heightCm !== undefined) set.heightCm = results.heightCm;
    if (results.weightKg !== undefined) set.weightKg = results.weightKg;
    if (p) await patch(MedicalProfile, p._id, set);
    else await MedicalProfile.create({ school: req.schoolId, student: studentId, ...set }).catch(() => {});
}

async function afterCheckup(req, row, student) {
    await noteMeasurements(req, row.student, row.checkedOn, row.results);
    const name = student?.name || (await access.studentCard(req.schoolId, row.student))?.name || 'Your child';
    const outcome = row.outcome ? ` Result: ${R.CHECKUP_OUTCOME[row.outcome].label.toLowerCase()}.` : '';
    tell.toParents(req, row.student, {
        title: `Health checkup completed — ${name}`,
        body: `${name} had a ${R.CHECKUP_TYPE[row.type].toLowerCase()} checkup at school on ${dayLabel(row.checkedOn)}.${outcome}${row.recommendations ? ` Recommendation: ${row.recommendations}` : ''}`,
        setting: 'parentCheckup', tab: 'checkups',
        i18n: { key: 'checkup_done', vars: { name, type: row.type, date: dayLabel(row.checkedOn), outcome: row.outcome, recommendation: row.recommendations } },
    });
    // A screening that found something refers the child to a specialist — followed until the family answers
    // (services/medicalReferrals). That notice says what to do, so the follow-up one is not sent as well.
    const referral = row.outcome === 'referred' ? await require('./medicalReferrals').fromCheckup(req, row, student) : null;
    if (row.followUp?.required && !referral) {
        tell.toParents(req, row.student, {
            title: 'Medical follow-up needed',
            body: `After ${name}'s ${R.CHECKUP_TYPE[row.type].toLowerCase()} checkup, a follow-up is needed${row.followUp.on ? ` by ${dayLabel(row.followUp.on)}` : ''}${row.followUp.note ? `: ${row.followUp.note}` : ''}.`,
            setting: 'parentFollowUp', tab: 'checkups',
        });
    }
}

async function addCheckup(req, studentId, body) {
    const student = await access.assertStudent(req.schoolId, studentId, { current: true });
    if (body.status === 'scheduled') return (await scheduleCheckups(req, { ...body, students: [student._id] }))[0];
    const f = checkupFields({ type: 'general', ...body, checkedOn: body.checkedOn || todayStr() });
    if (!f.results || !Object.keys(f.results).length) {
        if (!f.findings && !f.observations) refuse('Record the results or the findings of the checkup');
    }
    const row = plainOf(await MedicalCheckup.create({
        school: req.schoolId, student: student._id, status: 'completed', ...f,
        sessionId: str(body.sessionId, 60), sessionName: str(body.sessionName, 120),
        documents: await linkedDocs(req, student._id, body.documents), createdBy: req.userId, updatedBy: req.userId,
    }));
    audit.log(req, { action: 'created', entity: 'checkup', entityId: row._id, student: student._id, summary: `${R.CHECKUP_TYPE[row.type]} checkup recorded for ${student.name}` });
    await afterCheckup(req, row, student);
    return row;
}

/**
 * Book a checkup for students ahead: a list of ids, or a whole section/class.
 * body: { students?, sectionId?, classId?, type, scheduledOn, sessionName, professional }
 */
async function scheduleCheckups(req, body) {
    const type = oneOf(body.type, R.CHECKUP_TYPE, 'general');
    const on = toDay(body.scheduledOn);
    if (!on) refuse('Choose the date of the checkup');
    if (dayStr(on) < todayStr()) refuse('A checkup is scheduled for today or later — record a past one with its results');
    let ids = Array.isArray(body.students) ? body.students.filter(isUuid).map(String) : [];
    if (!ids.length && (isUuid(body.sectionId) || isUuid(body.classId))) {
        const { rows } = await require('../db/pool').query(
            `SELECT DISTINCT sp."user"::text AS id FROM "studentprofiles" sp
               JOIN "users" u ON u."_id" = sp."user" AND u."isActive" IS NOT FALSE AND u."role" = 'student'
               LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
              WHERE sp."school" = $1 AND (($2::uuid IS NOT NULL AND sp."currentSection" = $2::uuid)
                 OR ($2::uuid IS NULL AND $3::uuid IS NOT NULL AND COALESCE(cs."class", sp."currentClass") = $3::uuid))`,
            [String(req.schoolId), isUuid(body.sectionId) ? body.sectionId : null, isUuid(body.classId) ? body.classId : null],
        );
        ids = rows.map((r) => r.id);
    }
    if (!ids.length) refuse('Choose the students, a section or a class');
    if (ids.length > 400) refuse('Schedule at most 400 students at a time');
    const cards = await access.studentCards(req.schoolId, ids);
    const valid = ids.filter((id) => cards.has(id));
    if (!valid.length) refuse('None of those students were found');
    const sessionId = newId();
    const sessionName = str(body.sessionName, 120) || `${R.CHECKUP_TYPE[type]} checkup`;
    const rows = await MedicalCheckup.insertMany(valid.map((sid) => ({
        school: req.schoolId, student: sid, type, status: 'scheduled', scheduledOn: on, checkedOn: null,
        professional: str(body.professional, 120), sessionId, sessionName, results: {}, createdBy: req.userId, updatedBy: req.userId,
    })));
    audit.log(req, { action: 'scheduled', entity: 'checkup', entityId: null, summary: `${sessionName} scheduled for ${valid.length} student${valid.length === 1 ? '' : 's'} on ${dayLabel(on)}` });
    // Each family hears the day — one at a time, after the answer (a class is up to 400 notices).
    setImmediate(async () => {
        for (const sid of valid) {
            const name = cards.get(sid)?.name || 'your child';
            try {
                await tell.toParents(req, sid, {
                    title: `Health checkup on ${dayLabel(on)} — ${name}`,
                    body: `The Medical Room has a ${R.CHECKUP_TYPE[type].toLowerCase()} checkup for ${name} at school on ${dayLabel(on)} (${sessionName}). You will hear the results.`,
                    setting: 'parentCheckup', tab: 'checkups',
                    i18n: { key: 'checkup_scheduled', vars: { name, type, date: dayLabel(on) } },
                });
            } catch (e) { console.error('[medical] checkup notice failed:', e.message); }
        }
    });
    return (rows || []).map(plainOf);
}

/** Results for a scheduled checkup, or a correction of a completed one. */
async function recordCheckup(req, id, body) {
    const row = await findRecord(req, 'checkup', id);
    if (row.archivedAt) refuse('This checkup is archived');
    if (row.status === 'cancelled') refuse('This checkup was cancelled');
    const f = checkupFields({ ...body, checkedOn: body.checkedOn || (row.status === 'scheduled' ? todayStr() : undefined) }, row);
    if (row.status === 'scheduled') {
        if ((!f.results || !Object.keys(f.results).length) && !f.findings && !f.observations) refuse('Record the results or the findings');
        f.status = 'completed';
    }
    if (body.documents !== undefined) f.documents = await linkedDocs(req, row.student, body.documents);
    const changes = audit.diff(row, f);
    if (!changes.length) return row;
    const out = await patch(MedicalCheckup, id, { ...f, updatedBy: req.userId }, { where: { school: req.schoolId, status: row.status } });
    if (!out) refuse('This checkup changed a moment ago — reload', 409, 'MEDICAL_STALE');
    audit.log(req, { action: row.status === 'scheduled' ? 'completed' : 'updated', entity: 'checkup', entityId: id, student: row.student, summary: `${R.CHECKUP_TYPE[out.type]} checkup ${row.status === 'scheduled' ? 'completed' : 'updated'}`, changes });
    if (row.status === 'scheduled') await afterCheckup(req, out);
    else {
        await noteMeasurements(req, out.student, out.checkedOn, out.results);
        if (out.outcome === 'referred' && row.outcome !== 'referred') await require('./medicalReferrals').fromCheckup(req, out, null);
    }
    return out;
}

/**
 * A class sheet: many results at once. rows: [{ id, results, outcome, findings, absent }].
 * A row marked absent stays scheduled.
 */
async function saveCheckupSheet(req, body) {
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 400) : [];
    if (!rows.length) refuse('There is nothing to save');
    let saved = 0; const failed = [];
    for (const r of rows) {
        if (!r || r.absent || !isUuid(r.id)) continue;
        const filled = r.results && Object.values(r.results).some((v) => v !== '' && v !== null && v !== undefined);
        if (!filled && !str(r.findings)) continue;
        try {
            await recordCheckup(req, r.id, { results: r.results, outcome: r.outcome, findings: r.findings, checkedOn: body.checkedOn, professional: body.professional ?? undefined });
            saved += 1;
        } catch (e) { failed.push({ id: r.id, message: e.message }); }
    }
    return { saved, failed };
}

async function cancelCheckup(req, id, body = {}) {
    const row = await findRecord(req, 'checkup', id);
    if (row.status !== 'scheduled') refuse('Only a scheduled checkup can be cancelled');
    const reason = str(body.reason, 300);
    const out = await patch(MedicalCheckup, id, { status: 'cancelled', findings: reason, updatedBy: req.userId }, { where: { school: req.schoolId, status: 'scheduled' } });
    audit.log(req, { action: 'cancelled', entity: 'checkup', entityId: id, student: row.student, summary: `Scheduled ${R.CHECKUP_TYPE[row.type].toLowerCase()} checkup cancelled${reason ? ` — ${reason}` : ''}` });
    if (out) {
        const card = await access.studentCard(req.schoolId, row.student);
        const name = card?.name || 'your child';
        tell.toParents(req, row.student, {
            title: `Health checkup cancelled — ${name}`,
            body: `The ${R.CHECKUP_TYPE[row.type].toLowerCase()} checkup for ${name} on ${dayLabel(row.scheduledOn)} has been cancelled${reason ? `: ${reason}` : ''}.`,
            setting: 'parentCheckup', tab: 'checkups',
            i18n: { key: 'checkup_cancelled', vars: { name, type: row.type, date: dayLabel(row.scheduledOn) } },
        }).catch((e) => console.error('[medical] checkup notice failed:', e.message));
    }
    return out;
}

/* ── Documents ────────────────────────────────────────────────────────────── */

const LINKABLE = ['allergy', 'condition', 'vaccination', 'checkup', 'visit', 'incident', 'plan', 'request'];

/**
 * Register an uploaded file against a student. `file` is multer's. A parent's
 * upload arrives through a change request (status pending, visibility family).
 */
async function addDocument(req, studentId, body, file, { status = 'verified', source = 'staff' } = {}) {
    if (!file) refuse('Choose a file to upload');
    const drop = () => fs.promises.unlink(file.path).catch(() => {});
    try {
        const student = await access.assertStudent(req.schoolId, studentId, { current: true });
        const type = oneOf(body.type, R.DOC_TYPE, 'other');
        const title = str(body.title, 160) || str(file.originalname, 160);
        const visibility = source === 'parent' ? 'family' : oneOf(body.visibility, R.DOC_VISIBILITY, R.DEFAULT_VISIBILITY[type] || 'family');
        const linkKind = LINKABLE.includes(body.linkKind) ? body.linkKind : '';
        const linkId = linkKind && isUuid(body.linkId) ? body.linkId : null;
        const row = plainOf(await MedicalDocument.create({
            school: req.schoolId, student: student._id, type, title,
            documentDate: toDay(body.documentDate), expiresOn: toDay(body.expiresOn),
            storedName: path.basename(file.filename || file.path), originalName: str(file.originalname, 200),
            mime: str(file.mimetype, 100), size: Number(file.size) || 0, visibility, status, remarks: str(body.remarks, 600),
            linkKind, linkId, uploadedBy: req.userId, uploadedByName: who(req), uploadedByRole: req.userRole,
        }));
        // Attach it to the record it belongs to, so the record lists it.
        if (linkId && ['allergy', 'condition', 'checkup'].includes(linkKind)) {
            const Model = KINDS[linkKind].Model;
            const rec = await Model.findOne({ _id: linkId, school: req.schoolId, student: student._id }).select('documents').lean();
            if (rec) await patch(Model, linkId, { documents: [...new Set([...(rec.documents || []).map(String), String(row._id)])] });
        }
        if (linkId && linkKind === 'incident') {
            const MedicalIncident = require('../models/MedicalIncident');
            const inc = await MedicalIncident.findOne({ _id: linkId, school: req.schoolId, student: student._id }).select('documents').lean();
            if (inc) await patch(MedicalIncident, linkId, { documents: [...new Set([...(inc.documents || []).map(String), String(row._id)])] });
        }
        audit.log(req, { action: 'uploaded', entity: 'document', entityId: row._id, student: student._id, summary: `Uploaded ${R.DOC_TYPE[type].toLowerCase()} “${title}” for ${student.name}` });
        return row;
    } catch (e) { await drop(); throw e; }
}

async function updateDocument(req, id, body) {
    const row = await findRecord(req, 'document', id);
    if (row.archivedAt) refuse('This document is archived');
    const set = {};
    if (body.title !== undefined) { set.title = str(body.title, 160); if (!set.title) refuse('The document needs a name'); }
    if (body.type !== undefined) set.type = oneOf(body.type, R.DOC_TYPE, row.type);
    if (body.visibility !== undefined) set.visibility = oneOf(body.visibility, R.DOC_VISIBILITY, row.visibility);
    if (body.documentDate !== undefined) set.documentDate = toDay(body.documentDate);
    if (body.expiresOn !== undefined) { set.expiresOn = toDay(body.expiresOn); set.expiryNotifiedAt = null; }
    if (body.remarks !== undefined) set.remarks = str(body.remarks, 600);
    const changes = audit.diff(row, set);
    if (!changes.length) return row;
    const out = await patch(MedicalDocument, id, set, { where: { school: req.schoolId } });
    audit.log(req, { action: 'updated', entity: 'document', entityId: id, student: row.student, summary: `Document “${row.title}” updated`, changes });
    return out;
}

async function reviewDocument(req, id, { status, note }) {
    const row = await findRecord(req, 'document', id);
    const next = status === 'rejected' ? 'rejected' : 'verified';
    if (row.status === next) refuse(`This document is already ${next}`);
    const out = await patch(MedicalDocument, id, { status: next, reviewedBy: req.userId, reviewedAt: new Date(), remarks: note ? str(note, 600) : row.remarks }, { where: { school: req.schoolId } });
    audit.log(req, { action: next, entity: 'document', entityId: id, student: row.student, summary: `Document “${row.title}” ${next}${note ? ` — ${str(note, 120)}` : ''}` });
    return out;
}

/* ── Parents' updates ─────────────────────────────────────────────────────── */

/** The fields a parent may propose for each kind — anything else is dropped. */
function cleanPayload(kind, action, raw = {}) {
    if (action === 'remove') return { reason: str(raw.reason, 300) };
    switch (kind) {
    case 'allergy': {
        const f = allergyFields(raw);
        delete f.shareWithTeachers;
        if (action === 'add' && !f.allergen) refuse('Name what your child is allergic to');
        return f;
    }
    case 'condition': {
        const f = conditionFields(raw);
        delete f.shareWithTeachers; delete f.status;
        if (action === 'add' && !f.condition && (!f.type || f.type === 'other')) refuse('Name the condition');
        return f;
    }
    case 'contact': {
        const slot = raw.slot === 'alternate' ? 'alternate' : 'emergency';
        const p = { slot, name: str(raw.name, 120), phone: phone(raw.phone, 'The phone number'), relation: str(raw.relation, 60) };
        if (!p.name || !p.phone) refuse('Give the contact\'s name and phone number');
        return p;
    }
    case 'doctor': {
        const p = { name: str(raw.name, 120), phone: phone(raw.phone, 'The doctor\'s phone'), clinic: str(raw.clinic, 160) };
        if (!p.name) refuse('Give the doctor\'s name');
        return p;
    }
    case 'hospital': {
        const p = { name: str(raw.name, 160), phone: phone(raw.phone, 'The hospital\'s phone'), address: str(raw.address, 300) };
        if (!p.name) refuse('Give the hospital\'s name');
        return p;
    }
    case 'profile': {
        const p = {};
        if (raw.dietaryRestrictions !== undefined) p.dietaryRestrictions = str(raw.dietaryRestrictions, 600);
        if (raw.emergencyMedication !== undefined) {
            const em = raw.emergencyMedication || {};
            p.emergencyMedication = { required: bool(em.required), name: str(em.name, 120), location: str(em.location, 160), instructions: str(em.instructions, 600) };
        }
        if (raw.bloodGroup !== undefined) {
            const bg = str(raw.bloodGroup, 4).toUpperCase();
            if (bg && !R.BLOOD_GROUPS.includes(bg)) refuse(`Blood group must be one of ${R.BLOOD_GROUPS.join(', ')}`);
            p.bloodGroup = bg;
        }
        if (!Object.keys(p).length) refuse('There is nothing to update');
        return p;
    }
    case 'vaccination': {
        const f = vaccinationFields(raw);
        if (!f.vaccine) refuse('Name the vaccine');
        if (!f.givenOn) refuse('Give the date the vaccine was given');
        return f;
    }
    case 'document':
        return { type: oneOf(raw.type, R.DOC_TYPE, 'other'), title: str(raw.title, 160), documentDate: raw.documentDate || null, expiresOn: raw.expiresOn || null, remarks: str(raw.remarks, 600) };
    default:
        return refuse('Unknown kind of update');
    }
}

/** Apply an approved update through the same writers the staff use. Returns the record's id. */
async function applyChange(req, cr, { verified = false } = {}) {
    const p = cr.payload || {};
    const sid = cr.student;
    switch (cr.kind) {
    case 'allergy':
    case 'condition':
        if (cr.action === 'add') return (await addHealthRecord(req, cr.kind, sid, { ...p, documents: cr.document ? [cr.document] : [] }, { source: 'parent', verified }))._id;
        if (cr.action === 'update') { await updateHealthRecord(req, cr.kind, cr.target, p); return cr.target; }
        if (cr.action === 'remove') {
            if (cr.kind === 'allergy') await updateHealthRecord(req, 'allergy', cr.target, { status: 'resolved', parentNote: p.reason || 'Reported by a parent as no longer applying' });
            else await updateHealthRecord(req, 'condition', cr.target, { status: 'resolved', parentNote: p.reason || 'Reported by a parent as resolved' });
            return cr.target;
        }
        break;
    case 'contact':
        if (p.slot === 'alternate') await saveProfile(req, sid, { alternateContact: { name: p.name, phone: p.phone, relation: p.relation } });
        else await saveProfile(req, sid, { emergencyContact: { name: p.name, phone: p.phone, relation: p.relation } });
        return null;
    case 'doctor':
        await saveProfile(req, sid, { doctor: p });
        return null;
    case 'hospital':
        await saveProfile(req, sid, { hospital: p });
        return null;
    case 'profile':
        await saveProfile(req, sid, p);
        return null;
    case 'vaccination':
        return (await addVaccination(req, sid, { ...p, certificate: cr.document || undefined }, { source: 'parent', verified }))._id;
    case 'document':
        if (cr.document) await reviewDocument(req, cr.document, { status: 'verified' });
        return cr.document;
    default:
        break;
    }
    return null;
}

/**
 * The fields of a proposed change that really differ from what is on record.
 * A form shows every field, and a field the parent never touched still carries
 * whatever the form started with — "moderate" was quietly downgrading a
 * life-threatening allergy, and an untouched switch was turning off a child's
 * emergency medication. Only what differs is kept.
 */
const withArticle = (w) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;

function onlyChanges(payload, current = {}) {
    const day = (v) => (v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) ? dayStr(v) : null);
    const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
        const cur = current[k];
        if (k === 'emergencyMedication') {
            const a = cur || {};
            const b = v || {};
            if (!!a.required !== !!b.required || ['name', 'location', 'instructions'].some((f) => text(a[f]) !== text(b[f]))) out[k] = v;
            continue;
        }
        const was = day(cur) ?? text(cur);
        const now = day(v) ?? text(v);
        if (was !== now) out[k] = v;
    }
    return out;
}

async function submitChange(req, studentId, body, file = null) {
    // Refused before the file is registered: the upload must not stay on disk.
    const drop = () => (file?.path ? fs.promises.unlink(file.path).catch(() => {}) : null);
    let settings; let kind; let action; let student; let target = null; let payload; let rec = null;
    try {
        settings = await settingsSvc.get(req.schoolId);
        if (!settings.parentUpdates) refuse('Your school is not taking medical updates online — please contact the Medical Room', 403, 'MEDICAL_UPDATES_OFF');
        kind = oneOf(body.kind, R.CHANGE_KIND, null);
        if (!kind) refuse('Choose what you are updating');
        action = oneOf(body.action, { add: 1, update: 1, remove: 1 }, 'add');
        if (action !== 'add' && !['allergy', 'condition'].includes(kind)) refuse('That update can only be added');
        student = await access.assertStudent(req.schoolId, studentId, { current: true });
        if (action !== 'add') {
            rec = await findRecord(req, kind, body.target);
            if (String(rec.student) !== String(student._id) || rec.archivedAt) notFound(KINDS[kind].label);
            target = String(rec._id);
        }
        let raw = body.payload;
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
        payload = cleanPayload(kind, action, raw || {});
        if (action === 'update') {
            payload = onlyChanges(payload, rec);
            if (!Object.keys(payload).length) refuse('Nothing has changed — change what is different on the record');
        }
        if (kind === 'profile') {
            const prof = (await profileOf(req.schoolId, student._id)) || {};
            const sp = await StudentProfile.findOne({ user: student._id, school: req.schoolId }).select('bloodGroup').lean();
            payload = onlyChanges(payload, { dietaryRestrictions: prof.dietaryRestrictions, emergencyMedication: prof.emergencyMedication, bloodGroup: sp?.bloodGroup });
            if (!Object.keys(payload).length) refuse('Nothing has changed in the medical profile');
        }
        if (kind === 'document' && !file) refuse('Choose the file to upload');
        const open = await MedicalChangeRequest.countDocuments({ school: req.schoolId, student: student._id, status: 'pending' });
        if (open >= 20) refuse('There are already 20 updates waiting for the Medical Room — please wait for them to be reviewed');
    } catch (e) { await drop(); throw e; }

    let documentId = null;
    if (file) {
        const doc = await addDocument(req, student._id, { ...payload, type: payload.type || (kind === 'vaccination' ? 'vaccination_certificate' : 'other'), title: payload.title || `${R.CHANGE_KIND[kind]} — from parent`, linkKind: '' }, file, { status: 'pending', source: 'parent' });
        documentId = String(doc._id);
    }
    const row = plainOf(await MedicalChangeRequest.create({
        school: req.schoolId, student: student._id, submittedBy: req.userId, submittedByName: who(req),
        kind, action, target, payload, note: str(body.note, 600), document: documentId, status: 'pending',
    }));
    audit.log(req, { action: 'submitted', entity: 'change_request', entityId: row._id, student: student._id, summary: `${who(req)} sent an update: ${R.CHANGE_KIND[kind]} (${action}) for ${student.name}` });

    // A change to a severe allergy or condition, or to the emergency medication, is urgent news for the room.
    const sensitive = (rec && (R.SEVERE_ALLERGY.includes(rec.severity) || R.SEVERE_CONDITION.includes(rec.severity)))
        || ['severe', 'life_threatening', 'critical'].includes(payload.severity) || payload.emergencyMedication !== undefined;
    if (!settings.parentUpdatesNeedApproval) {
        try {
            const resultId = await applyChange(req, row, { verified: false });
            const done = await patch(MedicalChangeRequest, row._id, { status: 'approved', reviewedByName: 'Applied automatically', reviewedAt: new Date(), result: resultId || null });
            // Applied without a review — so the room is told, every time. It used
            // not to be: a parent could retire a life-threatening allergy unseen.
            tell.toStaff(req, {
                title: `${sensitive ? 'Check this · ' : ''}A parent changed ${student.name}'s medical record`,
                body: `${who(req)} ${action === 'add' ? 'added' : action === 'remove' ? 'marked as no longer applying' : 'changed'} ${kind === 'profile' ? 'the medical profile' : withArticle(R.CHANGE_KIND[kind].toLowerCase())} for ${student.name}. It was applied automatically — check it under Parent Updates.`,
                setting: 'staffParentUpdates', link: { type: 'medical.changes', entityId: String(row._id) }, urgent: sensitive,
            });
            return done;
        } catch (e) {
            // It could not be applied (the record changed meanwhile): it waits for review like any other update.
            console.error('[medical] automatic update failed, left for review:', e.message);
        }
    }
    tell.toStaff(req, {
        title: `Medical update from a parent — ${student.name}`,
        body: `${who(req)} sent ${action === 'add' ? `a new ${R.CHANGE_KIND[kind].toLowerCase()}` : `${action === 'remove' ? 'a removal of' : 'a change to'} ${withArticle(R.CHANGE_KIND[kind].toLowerCase())}`} for ${student.name}. It is waiting for review.`,
        setting: 'staffParentUpdates', link: { type: 'medical.changes', entityId: String(row._id) },
    });
    return row;
}

async function reviewChange(req, id, body = {}) {
    if (!isUuid(id)) notFound('Update');
    const cr = await MedicalChangeRequest.findOne({ _id: id, school: req.schoolId }).lean();
    if (!cr) notFound('Update');
    if (cr.status !== 'pending') refuse(`This update was already ${cr.status}`, 409, 'MEDICAL_STALE');
    const approve = body.decision === 'approve';
    const note = str(body.note, 600);
    if (!approve && !note) refuse('Say why the update is not accepted — the parent will see it');
    // Claim it first, so two reviewers cannot both apply it.
    const claimed = await patch(MedicalChangeRequest, id, { status: approve ? 'approved' : 'rejected', reviewedBy: req.userId, reviewedByName: who(req), reviewedAt: new Date(), reviewNote: note }, { where: { school: req.schoolId, status: 'pending' } });
    if (!claimed) refuse('Someone else reviewed this update a moment ago', 409, 'MEDICAL_STALE');
    let resultId = null;
    if (approve) {
        try {
            const payload = body.payload ? cleanPayload(cr.kind, cr.action, body.payload) : cr.payload;
            resultId = await applyChange(req, { ...cr, payload }, { verified: bool(body.verified) });
            if (resultId || body.payload) await patch(MedicalChangeRequest, id, { result: resultId || null, payload });
            // The file that came with it (a certificate, a doctor's note) was reviewed with it.
            if (cr.document && cr.kind !== 'document') {
                const doc = await MedicalDocument.findOne({ _id: cr.document, school: req.schoolId }).select('status').lean();
                if (doc?.status === 'pending') await reviewDocument(req, cr.document, { status: 'verified' });
            }
        } catch (e) {
            // Give the claim back: the update is still waiting, and the reviewer sees why it failed.
            await patch(MedicalChangeRequest, id, { status: 'pending', reviewedBy: null, reviewedByName: '', reviewedAt: null, reviewNote: '' });
            throw e;
        }
    } else if (cr.document) {
        await reviewDocument(req, cr.document, { status: 'rejected', note });
    }
    audit.log(req, { action: approve ? 'approved' : 'rejected', entity: 'change_request', entityId: id, student: cr.student, summary: `${R.CHANGE_KIND[cr.kind]} update from ${cr.submittedByName || 'a parent'} ${approve ? 'approved' : 'not accepted'}${note ? ` — ${note}` : ''}` });
    const card = await access.studentCard(req.schoolId, cr.student);
    tell.send(req, {
        to: [String(cr.submittedBy)],
        title: approve ? 'Medical update accepted' : 'Medical update not accepted',
        body: approve
            ? `The Medical Room added your ${R.CHANGE_KIND[cr.kind].toLowerCase()} update to ${card?.name || 'your child'}'s record.${note ? ` ${note}` : ''}`
            : `The Medical Room did not add your ${R.CHANGE_KIND[cr.kind].toLowerCase()} update for ${card?.name || 'your child'}: ${note}`,
        link: { type: 'medical.child', params: { child: String(cr.student), tab: 'updates' } },
    });
    return MedicalChangeRequest.findOne({ _id: id }).lean();
}

async function withdrawChange(req, id) {
    if (!isUuid(id)) notFound('Update');
    const cr = await MedicalChangeRequest.findOne({ _id: id, school: req.schoolId, submittedBy: req.userId }).lean();
    if (!cr) notFound('Update');
    if (cr.status !== 'pending') refuse('Only an update still waiting can be withdrawn');
    const out = await patch(MedicalChangeRequest, id, { status: 'withdrawn' }, { where: { school: req.schoolId, status: 'pending' } });
    if (cr.document) await patch(MedicalDocument, cr.document, { archivedAt: new Date(), archivedBy: req.userId, archiveReason: 'Withdrawn by the parent' });
    audit.log(req, { action: 'withdrawn', entity: 'change_request', entityId: id, student: cr.student, summary: `${R.CHANGE_KIND[cr.kind]} update withdrawn` });
    return out;
}

module.exports = {
    UPLOAD_DIR, KINDS, profileOf, saveProfile, getProfileRow,
    addHealthRecord, updateHealthRecord, verifyRecord, archiveRecord, restoreRecord, findRecord,
    addVaccination, updateVaccination, markVaccinationGiven,
    addCheckup, scheduleCheckups, recordCheckup, saveCheckupSheet, cancelCheckup, noteMeasurements,
    addDocument, updateDocument, reviewDocument,
    submitChange, reviewChange, withdrawChange, cleanPayload,
};
