'use strict';
/**
 * Medical Room — the student's and the parent's API (Oct 2026).
 *
 * A student sees their own record (as much of it as the school allows); a
 * parent sees their own children's and can send updates — an allergy, a
 * condition, a contact, the family doctor, a document — which wait for the
 * medical room's approval, and can authorise a medication plan the room has
 * set up. Every other child is "not found".
 */
const fs = require('fs');
const { handle, upload } = require('../utils/medicalHandler');
const { uploadMedicalDoc } = require('../middleware/upload');
const { childCards } = require('../services/parentChildren');
const access = require('../services/medicalAccess');
const read = require('../services/medicalRead');
const settingsSvc = require('../services/medicalSettings');
const health = require('../services/medicalHealth');
const meds = require('../services/medicalMeds');
const audit = require('../services/medicalAudit');
const R = require('../services/medicalRules');

const { refuse } = R;

exports.children = handle(async (req) => {
    if (req.userRole !== 'parent') return [];
    return childCards(req.userId, req.schoolId);
});

exports.record = handle(async (req) => {
    const id = await access.familyChild(req, req.query.child);
    const out = await read.familyRecord(req, id);
    audit.viewed(req, { entity: 'profile', student: id, summary: `${req.userRole === 'parent' ? 'Parent' : 'Student'} opened the medical record of ${out.student.name}` });
    return out;
});

/**
 * The kinds of history entry a student may see — the same switches that shape
 * their record (medicalRead.familyRecord). Without this the timeline handed a
 * student every visit, incident, medicine and document the school had chosen
 * to keep from them. A parent sees every kind.
 */
function familyKinds(role, s) {
    if (role !== 'student') return null;
    const kinds = ['record'];
    if (s.studentVisits) kinds.push('visit', 'incident', 'first_aid', 'referral', 'follow_up', 'hostel');
    if (s.studentCheckups) kinds.push('checkup');
    if (s.studentVaccinations) kinds.push('vaccination');
    if (s.studentDocuments) kinds.push('document');
    return kinds;   // never 'medicine': the record keeps a student's medicines with their parents
}

exports.history = handle(async (req) => {
    const id = await access.familyChild(req, req.query.child);
    const s = await settingsSvc.get(req.schoolId);
    if (req.userRole === 'student' && !s.studentAccess) refuse('Your school shares medical information with parents only', 403, 'MEDICAL_STUDENT_OFF');
    const out = await read.history(req.schoolId, id, { ...req.query, audience: 'family', allow: familyKinds(req.userRole, s) });
    audit.viewed(req, { entity: 'history', student: id, summary: `${req.userRole === 'parent' ? 'Parent' : 'Student'} opened the medical history` });
    return out;
});

exports.emergency = handle(async (req) => {
    const id = await access.familyChild(req, req.query.child);
    const out = await read.emergencyProfile(req.schoolId, id);
    audit.viewed(req, { entity: 'emergency_profile', student: id, summary: `Parent opened the emergency card of ${out.student.name}` });
    return out;
});

exports.submitUpdate = handle(async (req, res) => {
    if (req.userRole !== 'parent') refuse('Only a parent can send updates', 403, 'MEDICAL_PARENT_ONLY');
    await upload(uploadMedicalDoc.single('file'))(req, res);
    let id;
    try {
        id = await access.familyChild(req, req.body?.student);
    } catch (e) {
        // Refused before it reached the service: the file multer wrote must not stay behind.
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
        throw e;
    }
    return health.submitChange(req, id, req.body || {}, req.file || null);
});

exports.withdrawUpdate = handle((req) => health.withdrawChange(req, req.params.id));

/** A parent gives the consent a medication plan is waiting for. */
exports.authorizePlan = handle(async (req) => {
    const plan = await meds.findPlan(req, req.params.id);
    await access.familyChild(req, String(plan.student));
    if (plan.parentAuthorization?.authorized) refuse('This medicine is already authorised');
    if (!req.body?.confirm) refuse('Confirm that you authorise the school to give this medicine');
    return meds.authorizePlan(req, req.params.id, { by: req.user?.name || 'Parent' });
});

/** This year's medical consent, given in the app. body: { child, emergencyTreatment, otc, … signedName } */
exports.giveConsent = handle(async (req) => {
    const consent = require('../services/medicalConsent');
    const child = await access.familyChild(req, req.body?.child);
    await consent.give(req, child, req.body || {});
    return consent.forStudent(req.schoolId, child).then((c) => (c ? (({ history, givenBy, ...rest }) => rest)(c) : null));
});
exports.withdrawConsent = handle((req) => require('../services/medicalConsent').withdraw(req, req.params.id, req.body || {}));

/** The child's health summary as a PDF — for the family's own records, or the next school. */
exports.healthSummary = handle(async (req, res) => {
    const child = await access.familyChild(req, req.query.child);
    const rec = await read.familyRecord(req, child);
    const pool = require('../db/pool');
    const [school] = (await pool.query(`SELECT "name", "logo" FROM "schools" WHERE "_id" = $1`, [String(req.schoolId)])).rows;
    audit.log(req, { action: 'downloaded', entity: 'summary', student: child, summary: `${req.user?.name || 'A parent'} downloaded the health summary` });
    await require('../services/medicalPdf').healthSummary(res, { school, record: rec, generatedBy: req.user?.name || '' });
});
/** A request about the record: a copy, a correction, erasure. */
exports.dataRequest = handle((req) => require('../services/medicalRetention').request(req, req.body || {}));
exports.dataRequests = handle((req) => require('../services/medicalRetention').familyRequests(req, req.query.child));

/** The family uploads the doctor's fitness certificate a return to school needs. */
exports.exclusionCertificate = handle(async (req, res) => {
    const { upload } = require('../utils/medicalHandler');
    const { uploadMedicalDoc } = require('../middleware/upload');
    await upload(uploadMedicalDoc.single('file'))(req, res);
    if (!req.file) refuse('Choose the certificate to upload');
    return require('../services/medicalRestrictions').attachCertificate(req, req.params.id, req.file);
});

/** A parent answers urgent news: "on my way, 20 minutes". */
exports.acknowledgeUrgent = handle(async (req) => {
    if (req.userRole !== 'parent') refuse('Only a parent can answer this', 403, 'MEDICAL_PARENT_ONLY');
    const urgent = require('../services/medicalUrgent');
    const row = await urgent.acknowledge(req, req.params.id, req.body || {});
    return urgent.forFamily(req.schoolId, row.student);
});

/** A parent has read the care plan and agrees with it. */
exports.confirmCarePlan = handle(async (req) => {
    const care = require('../services/medicalCare');
    const plan = await care.findCarePlan(req, req.params.id);
    await access.familyChild(req, String(plan.student));
    return care.confirmCarePlan(req, req.params.id);
});

/* ── Programmes: referrals, campaigns, an illness at home ─────────────────── */

/** The family answers a referral: an appointment, what the doctor said (with the report), or no. */
exports.answerReferral = handle(async (req, res) => {
    const { upload } = require('../utils/medicalHandler');
    const { uploadMedicalDoc } = require('../middleware/upload');
    if (String(req.headers['content-type'] || '').startsWith('multipart/')) await upload(uploadMedicalDoc.single('file'))(req, res);
    return require('../services/medicalReferrals').familyAnswer(req, req.params.id, req.body || {}, req.file || null);
});
/** The referral letter, to take to the specialist. */
exports.referralLetter = handle(async (req, res) => {
    const referrals = require('../services/medicalReferrals');
    const r = await referrals.find(req, req.params.id);
    await access.familyChild(req, String(r.student));
    if (r.status === 'cancelled') refuse('This referral was cancelled', 404, 'MEDICAL_NOT_FOUND');
    await require('./medicalAdmin.controller').sendReferralLetter(req, res, r);
});
exports.answerCampaign = handle((req) => require('../services/medicalCampaigns').familyAnswer(req, req.body || {}));
exports.reportIllness = handle((req) => require('../services/medicalOutbreak').reportIllness(req, req.body || {}));
exports.withdrawIllness = handle((req) => require('../services/medicalOutbreak').withdrawIllness(req, req.params.id));

/** The year's health card of one's own child (or one's own, for a student the school shares checkups with). */
exports.annualPdf = handle(async (req, res) => {
    const child = await access.familyChild(req, req.query.child);
    if (req.userRole === 'student') {
        const s = await settingsSvc.get(req.schoolId);
        if (!s.studentAccess || !s.studentCheckups) refuse('Your school shares this with parents', 403, 'MEDICAL_STUDENT_OFF');
    }
    await require('../services/medicalDocuments').annual(req, res, { studentIds: [child], yearId: req.query.year });
});

/** The language the Medical Room writes to this parent in: '' (the school's choice), 'en' or 'hi'. */
exports.setLanguage = handle(async (req) => {
    if (req.userRole !== 'parent') refuse('Only a parent sets this', 403, 'MEDICAL_PARENT_ONLY');
    const language = ['en', 'hi'].includes(req.body?.language) ? req.body.language : '';
    const pool = require('../db/pool');
    const { rowCount } = await pool.query(`UPDATE "parentprofiles" SET "medicalLanguage" = $2 WHERE "user" = $1`, [String(req.userId), language]);
    if (!rowCount) refuse('Your parent profile was not found', 404, 'MEDICAL_NOT_FOUND');
    audit.log(req, { action: 'language_set', entity: 'family', summary: `Medical Room messages: ${language === 'hi' ? 'Hindi' : language === 'en' ? 'English' : "the school's choice"}` });
    return { language };
});
