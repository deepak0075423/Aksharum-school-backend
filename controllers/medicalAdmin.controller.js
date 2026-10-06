'use strict';
/**
 * Medical Room — the medical staff's API (Oct 2026). The school admin and any
 * teacher whose designation grants Medical admin (a nurse) reach it; the
 * route guard decides that (allowModuleAdmin('medical')).
 *
 * Thin by design: every rule is in a service — medicalCase (the room),
 * medicalHealth (the record), medicalMeds (medicines), medicalEquipment,
 * medicalBoard / medicalRead / medicalReports / medicalAlerts (reads). Reading
 * a student's record, history, emergency profile or a file is audited here.
 */
const pool = require('../db/pool');
const MedicalFirstAid = require('../models/MedicalFirstAid');
const MedicalChangeRequest = require('../models/MedicalChangeRequest');
const { handle, upload } = require('../utils/medicalHandler');
const { uploadMedicalDoc } = require('../middleware/upload');
const board = require('../services/medicalBoard');
const read = require('../services/medicalRead');
const cases = require('../services/medicalCase');
const health = require('../services/medicalHealth');
const meds = require('../services/medicalMeds');
const equipment = require('../services/medicalEquipment');
const reports = require('../services/medicalReports');
const alertsSvc = require('../services/medicalAlerts');
const searchSvc = require('../services/medicalSearch');
const settingsSvc = require('../services/medicalSettings');
const access = require('../services/medicalAccess');
const audit = require('../services/medicalAudit');
const files = require('../services/medicalFiles');
const R = require('../services/medicalRules');
const care = require('../services/medicalCare');
const safety = require('../services/medicalSafety');
const urgent = require('../services/medicalUrgent');
const vitals = require('../services/medicalVitals');
const limits = require('../services/medicalRestrictions');
const staffHealth = require('../services/medicalStaffHealth');
const consent = require('../services/medicalConsent');
const places = require('../services/medicalPlaces');
const safeguarding = require('../services/medicalSafeguarding');
const stepUp = require('../services/medicalStepUp');
const retention = require('../services/medicalRetention');

const { notFound, isUuid } = R;
const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);

/* ── Dashboard, boards, search, alerts ────────────────────────────────────── */

exports.overview = handle((req) => board.overview(req));

exports.board = handle(async (req) => {
    const out = await board.listBoard(req, req.params.screen, req.query);
    if (!out) notFound('Screen');
    return out;
});

exports.search = handle((req) => searchSvc.search(req, req.query.q));
exports.alerts = handle((req) => alertsSvc.alerts(req));
exports.room = handle((req) => board.room(req));

/** Everything the forms and filters offer: lists, classes, beds, stock. */
exports.meta = handle(async (req) => {
    const S = String(req.schoolId);
    const s = await settingsSvc.get(req.schoolId);
    const today = R.todayStr();
    const [years, classes, sections, beds, items] = await Promise.all([
        run(`SELECT "_id", "yearName", "startDate", "endDate", "status" FROM "academicyears" WHERE "school" = $1 ORDER BY "startDate" DESC`, [S]),
        run(`SELECT c."_id", c."className", c."classNumber", c."academicYear" FROM "classes" c JOIN "academicyears" y ON y."_id" = c."academicYear"
              WHERE c."school" = $1 AND y."status" = 'active' ORDER BY c."classNumber" NULLS LAST, c."className"`, [S]),
        run(`SELECT cs."_id", cs."sectionName", cs."class" FROM "classsections" cs JOIN "academicyears" y ON y."_id" = cs."academicYear"
              WHERE cs."school" = $1 AND y."status" = 'active' ORDER BY cs."sectionName"`, [S]),
        run(`SELECT "_id", "label", "kind", "status" FROM "medicalbeds" WHERE "school" = $1 AND "isActive" IS NOT FALSE ORDER BY "sortOrder", "label"`, [S]),
        run(`SELECT i."_id", i."name", i."kind", i."strength", i."unit", i."form", i."category", i."prescriptionOnly", i."minStock",
                    COALESCE((SELECT SUM(b."quantity") FROM "medicalbatches" b WHERE b."item" = i."_id" AND b."status" = 'active'
                       AND (b."expiryDate" IS NULL OR (b."expiryDate" AT TIME ZONE 'UTC')::date >= $2::date)), 0)::float8 AS usable
               FROM "medicalitems" i WHERE i."school" = $1 AND i."isActive" IS NOT FALSE ORDER BY i."kind", i."name"`, [S, today]),
    ]);
    return {
        today,
        settings: s,
        years,
        classes: classes.map((c) => ({ ...c, sections: sections.filter((x) => String(x.class) === String(c._id)) })),
        beds,
        // Where stock is kept, and the rooms (a school with more than one).
        places: (await places.places(req)).places.map((p) => ({ _id: p._id, name: p.name, kind: p.kind, isMain: p.isMain })),
        // Bus routes, for a route's set of emergency cards (none when the school has no transport).
        routes: await run(`SELECT "_id", "name" FROM "transportroutes" WHERE "school" = $1 AND "isActive" IS NOT FALSE ORDER BY "name"`, [S]).catch(() => []),
        medicines: items.filter((i) => i.kind === 'medicine'),
        supplies: items.filter((i) => i.kind === 'supply'),
        vocab: {
            visitStatus: R.VISIT_STATUS, requestStatus: R.REQUEST_STATUS, urgency: R.URGENCY,
            incidentType: R.INCIDENT_TYPE, incidentSeverity: R.INCIDENT_SEVERITY, incidentStatus: R.INCIDENT_STATUS,
            allergyCategory: R.ALLERGY_CATEGORY, allergySeverity: R.ALLERGY_SEVERITY,
            conditionType: R.CONDITION_TYPE, conditionSeverity: R.CONDITION_SEVERITY, conditionStatus: R.CONDITION_STATUS,
            doseStatus: R.DOSE_STATUS, planFrequency: R.PLAN_FREQUENCY, planStatus: R.PLAN_STATUS,
            vaccinationStatus: R.VACCINATION_STATUS, checkupType: R.CHECKUP_TYPE, checkupOutcome: R.CHECKUP_OUTCOME,
            docType: R.DOC_TYPE, docVisibility: R.DOC_VISIBILITY, bedStatus: R.BED_STATUS, bedKind: R.BED_KIND,
            equipType: R.EQUIP_TYPE, equipStatus: R.EQUIP_STATUS, equipCondition: R.EQUIP_CONDITION, moveType: R.MOVE_TYPE,
            bloodGroups: R.BLOOD_GROUPS, changeKind: R.CHANGE_KIND,
        },
    };
});

/* ── Students and their record ────────────────────────────────────────────── */

exports.students = handle((req) => access.searchStudents(req.schoolId, req.query.q, { limit: Number(req.query.limit) || 20 }));

exports.student = handle(async (req) => {
    const out = await read.staffRecord(req, req.params.id);
    audit.viewed(req, { entity: 'profile', student: req.params.id, summary: `Opened the medical profile of ${out.student.name}` });
    return out;
});

exports.history = handle(async (req) => {
    const card = await access.assertStudent(req.schoolId, req.params.id);
    const out = await read.history(req.schoolId, card._id, { ...req.query, audience: 'staff' });
    audit.viewed(req, { entity: 'history', student: card._id, summary: `Opened the medical history of ${card.name}` });
    return { student: card, ...out };
});

exports.emergency = handle(async (req) => {
    const out = await read.emergencyProfile(req.schoolId, req.params.id);
    audit.viewed(req, { entity: 'emergency_profile', student: req.params.id, summary: `Opened the emergency profile of ${out.student.name}` });
    return out;
});

exports.saveProfile = handle((req) => health.saveProfile(req, req.params.id, req.body || {}));

/* Allergies, conditions, vaccinations, checkups, documents: one shape each. */
exports.addAllergy = handle((req) => health.addHealthRecord(req, 'allergy', req.params.id, req.body || {}));
exports.addCondition = handle((req) => health.addHealthRecord(req, 'condition', req.params.id, req.body || {}));
exports.updateAllergy = handle((req) => health.updateHealthRecord(req, 'allergy', req.params.id, req.body || {}));
exports.updateCondition = handle((req) => health.updateHealthRecord(req, 'condition', req.params.id, req.body || {}));

const RECORD_KINDS = {
    allergies: 'allergy', conditions: 'condition', vaccinations: 'vaccination', checkups: 'checkup', documents: 'document',
    'rescue-meds': 'rescue_med', 'care-plans': 'care_plan', restrictions: 'restriction',
};
const kindOf = (req) => RECORD_KINDS[req.params.kind] || notFound('Record');
exports.verifyRecord = handle((req) => health.verifyRecord(req, kindOf(req), req.params.id));
exports.archiveRecord = handle((req) => health.archiveRecord(req, kindOf(req), req.params.id, req.body || {}));
exports.restoreRecord = handle((req) => health.restoreRecord(req, kindOf(req), req.params.id));

exports.addVaccination = handle((req) => health.addVaccination(req, req.params.id, req.body || {}));
exports.updateVaccination = handle((req) => health.updateVaccination(req, req.params.id, req.body || {}));
exports.vaccinationGiven = handle((req) => health.markVaccinationGiven(req, req.params.id, req.body || {}));

exports.addCheckup = handle((req) => health.addCheckup(req, req.params.id, req.body || {}));
exports.scheduleCheckups = handle((req) => health.scheduleCheckups(req, req.body || {}));
exports.recordCheckup = handle((req) => health.recordCheckup(req, req.params.id, req.body || {}));
exports.checkupSheet = handle((req) => health.saveCheckupSheet(req, req.body || {}));
exports.cancelCheckup = handle((req) => health.cancelCheckup(req, req.params.id, req.body || {}));
exports.checkupSession = handle(async (req) => {
    const rows = await run(
        `SELECT k."_id", k."type", k."status", k."scheduledOn", k."checkedOn", k."results", k."outcome", k."findings", k."sessionName", k."professional",
                ${board.STUDENT_SELECT}, k."student"::text AS student
           FROM "medicalcheckups" k ${board.STUDENT_JOIN('k."student"')}
          WHERE k."school" = $1 AND k."sessionId" = $2 AND k."archivedAt" IS NULL AND k."status" <> 'cancelled'
          ORDER BY c."classNumber" NULLS LAST, c."className", cs."sectionName", sp."rollNumber" NULLS LAST, u."name"`,
        [String(req.schoolId), String(req.params.sessionId)],
    );
    if (!rows.length) notFound('Checkup session');
    return { sessionId: req.params.sessionId, sessionName: rows[0].sessionName, type: rows[0].type, scheduledOn: rows[0].scheduledOn, rows: rows.map(board.withClass) };
});

exports.uploadDocument = handle(async (req, res) => {
    await upload(uploadMedicalDoc.single('file'))(req, res);
    return health.addDocument(req, req.params.id, req.body || {}, req.file);
});
exports.updateDocument = handle((req) => health.updateDocument(req, req.params.id, req.body || {}));
exports.reviewDocument = handle((req) => health.reviewDocument(req, req.params.id, req.body || {}));

/* ── Requests ─────────────────────────────────────────────────────────────── */

exports.acceptRequest = handle((req) => cases.acceptRequest(req, req.params.id, req.body || {}));
exports.arriveRequest = handle((req) => cases.arriveRequest(req, req.params.id, req.body || {}));
exports.cancelRequest = handle((req) => cases.cancelRequest(req, req.params.id, req.body || {}));

/* ── Visits ───────────────────────────────────────────────────────────────── */

async function visitDetail(req, id) {
    const v = await cases.findVisit(req, id);
    const [student, doses, firstAid, request, incident, bed, documentList] = await Promise.all([
        access.studentCard(req.schoolId, v.student),
        run(`SELECT "_id","medicineName","dosage","quantity","status","givenAt","givenByName","note","batches" FROM "medicationdoses" WHERE "visit" = $1 ORDER BY "createdAt"`, [String(v._id)]),
        v.firstAidRecord ? MedicalFirstAid.findOne({ _id: v.firstAidRecord }).lean() : null,
        v.request ? run(`SELECT "_id","number","reason","requestedByName","urgency","location","createdAt" FROM "medicalrequests" WHERE "_id" = $1`, [String(v.request)]).then((r) => r[0] || null) : null,
        v.incident ? run(`SELECT "_id","number","type","severity","occurredAt","location" FROM "medicalincidents" WHERE "_id" = $1`, [String(v.incident)]).then((r) => r[0] || null) : null,
        v.bed ? run(`SELECT "_id","label" FROM "medicalbeds" WHERE "_id" = $1`, [String(v.bed)]).then((r) => r[0] || null) : null,
        // Photos and papers attached to this visit (an injury photo, a hospital letter).
        run(`SELECT "_id","type","title","visibility","mime","uploadedByName","createdAt" FROM "medicaldocuments"
              WHERE "school" = $1 AND "linkKind" = 'visit' AND "linkId" = $2 AND "archivedAt" IS NULL ORDER BY "createdAt"`, [String(req.schoolId), String(v._id)]),
    ]);
    const alerts = R.alertsFor(await read.healthRows(req.schoolId, v.student));
    return {
        ...v, student, doses, firstAidInfo: firstAid, requestInfo: request, incidentInfo: incident, bedInfo: bed, alerts, documentList,
        flags: R.vitalFlags(v.vitals || {}, { age: R.ageYears(student?.dob) }), followUpState: R.followUpState(v.followUp),
        // The protocols the reason and symptoms point to, best first.
        protocolSuggestions: require('../services/medicalProtocols').suggest(v.reason, v.symptoms),
        recheckDue: !!v.nextCheckAt && new Date(v.nextCheckAt).getTime() <= Date.now(),
    };
}

exports.createVisit = handle((req) => cases.createVisit(req, req.body || {}));
exports.visit = handle(async (req) => {
    const out = await visitDetail(req, req.params.id);
    audit.viewed(req, { entity: 'visit', entityId: out._id, student: out.student?._id, summary: `Opened visit ${out.number}` });
    return out;
});
exports.updateVisit = handle(async (req) => { await cases.updateVisit(req, req.params.id, req.body || {}); return visitDetail(req, req.params.id); });
exports.visitStatus = handle(async (req) => { await cases.setVisitStatus(req, req.params.id, req.body || {}); return visitDetail(req, req.params.id); });
exports.reopenVisit = handle((req) => cases.reopenVisit(req, req.params.id, req.body || {}));
exports.contactParent = handle((req) => cases.contactParent(req, req.params.id, req.body || {}));
exports.visitBed = handle((req) => cases.moveBed(req, req.params.id, req.body || {}));

/* ── Incidents ────────────────────────────────────────────────────────────── */

exports.createIncident = handle((req) => cases.createIncident(req, req.body || {}));
exports.incident = handle(async (req) => {
    const i = await cases.findIncident(req, req.params.id);
    const [student, documents, visit, firstAid] = await Promise.all([
        access.studentCard(req.schoolId, i.student),
        (i.documents || []).length ? run(`SELECT "_id","title","type","mime","size","createdAt","uploadedByName","archivedAt" FROM "medicaldocuments" WHERE "_id"::text = ANY($1::text[])`, [i.documents.map(String)]) : [],
        i.visit ? run(`SELECT "_id","number","status","arrivedAt" FROM "medicalvisits" WHERE "_id" = $1`, [String(i.visit)]).then((r) => r[0] || null) : null,
        run(`SELECT "_id","at","treatment","supplies","givenByName" FROM "medicalfirstaids" WHERE "incident" = $1 AND "archivedAt" IS NULL ORDER BY "at"`, [String(i._id)]),
    ]);
    audit.viewed(req, { entity: 'incident', entityId: i._id, student: i.student, summary: `Opened incident ${i.number}` });
    return { ...i, student, documentList: documents, visitInfo: visit, firstAidList: firstAid, followUpState: R.followUpState(i.followUp) };
});
exports.updateIncident = handle((req) => cases.updateIncident(req, req.params.id, req.body || {}));
exports.incidentStatus = handle((req) => cases.setIncidentStatus(req, req.params.id, req.body || {}));
exports.notifyIncident = handle((req) => cases.notifyIncidentParents(req, req.params.id, req.body || {}));
exports.treatIncident = handle((req) => cases.treatIncident(req, req.params.id, req.body || {}));

/* ── First aid, follow-ups, archive ───────────────────────────────────────── */

exports.recordFirstAid = handle((req) => cases.recordFirstAid(req, req.body || {}));
exports.firstAid = handle(async (req) => {
    if (!isUuid(req.params.id)) notFound('First-aid record');
    const fa = await MedicalFirstAid.findOne({ _id: req.params.id, school: req.schoolId }).lean();
    if (!fa) notFound('First-aid record');
    return { ...fa, student: await access.studentCard(req.schoolId, fa.student) };
});
exports.followUp = handle((req) => cases.completeFollowUp(req, req.params.kind, req.params.id, req.body || {}));

const CASE_KINDS = { visits: 'visit', incidents: 'incident', 'first-aid': 'first_aid' };
exports.archiveCase = handle((req) => cases.archive(req, CASE_KINDS[req.params.kind] || notFound('Record'), req.params.id, req.body || {}));
exports.restoreCase = handle((req) => cases.restore(req, CASE_KINDS[req.params.kind] || notFound('Record'), req.params.id));

/* ── Medicines, supplies, stock ───────────────────────────────────────────── */

exports.createItem = handle((req) => meds.createItem(req, req.body || {}));
exports.item = handle(async (req) => {
    const item = await meds.findItem(req.schoolId, req.params.id);
    const s = await settingsSvc.get(req.schoolId);
    const today = R.todayStr();
    const [batches, moves, plans] = await Promise.all([
        run(`SELECT * FROM "medicalbatches" WHERE "item" = $1 ORDER BY CASE "status" WHEN 'active' THEN 0 ELSE 1 END, "expiryDate" NULLS LAST, "createdAt"`, [String(item._id)]),
        run(`SELECT m.*, su."name" AS "studentName", b."batchNumber" FROM "medicalstockmoves" m
               LEFT JOIN "users" su ON su."_id" = m."student" LEFT JOIN "medicalbatches" b ON b."_id" = m."batch"
              WHERE m."item" = $1 ORDER BY m."createdAt" DESC LIMIT 60`, [String(item._id)]),
        run(`SELECT p."_id", p."medicineName", p."dosage", p."status", u."name" AS "studentName" FROM "medicationplans" p JOIN "users" u ON u."_id" = p."student"
              WHERE p."item" = $1 AND p."status" IN ('active','paused') ORDER BY u."name"`, [String(item._id)]),
    ]);
    const decorated = batches.map((b) => ({ ...b, state: R.batchState(b, today, s.expiryAlertDays) }));
    const usable = decorated.filter((b) => b.state === 'active' || b.state === 'expiring').reduce((n, b) => n + Number(b.quantity), 0);
    const counts = await run(`SELECT *, "_id"::text AS "_id" FROM "medicalstockcounts" WHERE "item" = $1 ORDER BY "at" DESC LIMIT 10`, [String(item._id)]);
    return { ...item, usable: Math.round(usable * 100) / 100, batches: decorated, moves, plans, counts };
});
exports.updateItem = handle((req) => meds.updateItem(req, req.params.id, req.body || {}));
exports.archiveItem = handle((req) => meds.setItemActive(req, req.params.id, false));
exports.restoreItem = handle((req) => meds.setItemActive(req, req.params.id, true));
exports.stockIn = handle((req) => meds.stockIn(req, req.params.id, req.body || {}));
exports.stockOut = handle((req) => meds.stockOut(req, req.params.id, req.body || {}));
exports.adjustBatch = handle((req) => meds.adjustBatch(req, req.params.id, req.body || {}));
exports.writeOffBatch = handle((req) => meds.writeOffBatch(req, req.params.id, req.body || {}));

/* ── Medication plans and doses ───────────────────────────────────────────── */

exports.administration = handle((req) => board.administration(req, req.query.day));
exports.createPlan = handle((req) => meds.createPlan(req, req.body || {}));
exports.plan = handle(async (req) => {
    const plan = await meds.findPlan(req, req.params.id);
    const [student, doses, prescription] = await Promise.all([
        access.studentCard(req.schoolId, plan.student),
        run(`SELECT "_id","scheduledFor","givenAt","status","givenByName","note","quantity","source" FROM "medicationdoses" WHERE "plan" = $1
              ORDER BY COALESCE("scheduledFor","givenAt") DESC LIMIT 120`, [String(plan._id)]),
        plan.prescription ? run(`SELECT "_id","title","mime","type" FROM "medicaldocuments" WHERE "_id" = $1`, [String(plan.prescription)]).then((r) => r[0] || null) : null,
    ]);
    return { ...plan, student, doses, prescriptionDoc: prescription, supply: await meds.supplyOf(plan) };
});
exports.updatePlan = handle((req) => meds.updatePlan(req, req.params.id, req.body || {}));
exports.authorizePlan = handle((req) => meds.authorizePlan(req, req.params.id, req.body || {}));
exports.planStatus = handle((req) => meds.setPlanStatus(req, req.params.id, req.body?.status, req.body?.note));
exports.recordDose = handle((req) => meds.recordDose(req, req.params.id, req.body || {}));
exports.cancelDose = handle((req) => meds.cancelDose(req, req.params.id, req.body || {}));
exports.giveDose = handle(async (req) => {
    await access.assertStudent(req.schoolId, req.body?.student);
    return meds.giveDose(req, req.body || {});
});

/* ── Beds ─────────────────────────────────────────────────────────────────── */

exports.createBed = handle((req) => cases.saveBed(req, null, req.body || {}));
exports.updateBed = handle((req) => cases.saveBed(req, req.params.id, req.body || {}));
exports.removeBed = handle((req) => cases.removeBed(req, req.params.id));

/* ── Equipment ────────────────────────────────────────────────────────────── */

exports.createEquipment = handle((req) => equipment.create(req, req.body || {}));
exports.equipment = handle((req) => equipment.find(req, req.params.id));
exports.updateEquipment = handle((req) => equipment.update(req, req.params.id, req.body || {}));
exports.maintainEquipment = handle((req) => equipment.maintain(req, req.params.id, req.body || {}));
exports.archiveEquipment = handle((req) => equipment.archive(req, req.params.id, req.body || {}));

/* ── Parents' updates ─────────────────────────────────────────────────────── */

exports.change = handle(async (req) => {
    if (!isUuid(req.params.id)) notFound('Update');
    const cr = await MedicalChangeRequest.findOne({ _id: req.params.id, school: req.schoolId }).lean();
    if (!cr) notFound('Update');
    const [student, current, document] = await Promise.all([
        access.studentCard(req.schoolId, cr.student),
        cr.target && health.KINDS[cr.kind] ? health.KINDS[cr.kind].Model.findOne({ _id: cr.target }).lean() : null,
        cr.document ? run(`SELECT "_id","title","mime","type","status" FROM "medicaldocuments" WHERE "_id" = $1`, [String(cr.document)]).then((r) => r[0] || null) : null,
    ]);
    let profile = null;
    if (['contact', 'doctor', 'hospital', 'profile'].includes(cr.kind)) {
        const rec = await read.staffRecord(req, cr.student);
        profile = { emergencyContact: rec.emergencyContact, alternateContact: rec.profile?.alternateContact, doctor: rec.profile?.doctor, hospital: rec.profile?.hospital, dietaryRestrictions: rec.profile?.dietaryRestrictions, emergencyMedication: rec.profile?.emergencyMedication, bloodGroup: rec.bloodGroup };
    }
    return { ...cr, student, current, profile, documentInfo: document };
});
exports.reviewChange = handle((req) => health.reviewChange(req, req.params.id, req.body || {}));

/* ── Reports, settings ────────────────────────────────────────────────────── */

exports.reportCatalogue = handle(() => reports.CATALOGUE);
exports.report = handle(async (req) => {
    const out = await reports.report(req, req.params.kind, req.query);
    if (req.query.export === '1') audit.log(req, { action: 'exported', entity: 'report', summary: `Exported the “${out.title}” report (${out.rows.length} rows)` });
    return out;
});

// The settings with what the screen shows beside them.
const withTexts = async (settings) => {
    // The names of the safeguarding leads, for the settings screen.
    const ids = (settings.safeguardingLeads || []).filter(isUuid);
    const leadNames = ids.length ? Object.fromEntries((await run(`SELECT "_id"::text AS id, "name" FROM "users" WHERE "_id" = ANY($1::uuid[])`, [ids])).map((u) => [u.id, u.name])) : {};
    // For the Programmes tab: the vaccination schedule templates and what the outbreak watch looks for by default.
    const { RULES } = require('../services/medicalOutbreak');
    return {
        ...settings, leadNames,
        scheduleTemplates: require('../services/medicalSchedule').templateList(),
        outbreakDefaults: Object.fromEntries(Object.entries(RULES).map(([k, r]) => [k, { label: r.label, cases: r.cases, days: r.days, scope: r.scope, advice: r.advice }])),
    };
};
exports.settings = handle(async (req) => withTexts(await settingsSvc.get(req.schoolId)));
exports.saveSettings = handle(async (req) => {
    const body = { ...(req.body || {}) };
    const cur0 = await settingsSvc.get(req.schoolId);
    // Who checks the medical staff is the school admin's call: the step-up code and the access alert.
    for (const k of ['requireStepUp', 'accessAlertThreshold', 'retentionYears']) {
        if (body[k] === undefined || String(body[k]) === String(cur0[k])) { delete body[k]; continue; }
        if (req.userRole !== 'school_admin') R.refuse('Only a school admin changes how the medical staff are checked', 403, 'MEDICAL_ADMIN_ONLY');
    }
    // Turning the code on: the admin has just received one, so the school's email works.
    if (R.bool(body.requireStepUp) && !cur0.requireStepUp && !require('../services/medicalStepUp').tokenOk(req, req.headers['x-medical-step-up'])) {
        R.refuse('First confirm a code we email you — that shows the school\'s email works before everyone needs it', 409, 'MEDICAL_STEP_UP_PROVE');
    }
    // Only a school admin names the safeguarding leads; a nurse saving the rest sends them back unchanged.
    if (body.safeguardingLeads !== undefined) {
        const sg = require('../services/medicalSafeguarding');
        const cur = (await settingsSvc.get(req.schoolId)).safeguardingLeads || [];
        const same = JSON.stringify([...cur].map(String).sort()) === JSON.stringify([...(Array.isArray(body.safeguardingLeads) ? body.safeguardingLeads : [])].map(String).sort());
        if (same) delete body.safeguardingLeads;
        else if (req.userRole !== 'school_admin') R.refuse('Only a school admin names the safeguarding leads', 403, 'MEDICAL_ADMIN_ONLY');
        else body.safeguardingLeads = await sg.cleanLeads(req.schoolId, body.safeguardingLeads);
    }
    const { settings, changed } = await settingsSvc.save(req.schoolId, body, req.userId);
    if (changed.length) audit.log(req, { action: 'settings_changed', entity: 'settings', summary: `Medical Room settings changed: ${changed.join(', ')}` });
    return withTexts(settings);
});

/* ── Files (link for previews) ────────────────────────────────────────────── */

exports.fileLink = handle(async (req) => {
    const { doc } = await files.readable(req, req.params.id);
    // The signed link itself carries no login, so the download is recorded here, when it is asked for.
    // A download is its own entry — views are de-duplicated, a copy leaving the school is not.
    if (req.query.download === '1') audit.log(req, { action: 'downloaded', entity: 'document', entityId: doc._id, student: doc.student, summary: `Downloaded document “${doc.title}”` });
    else audit.viewed(req, { entity: 'document', entityId: doc._id, student: doc.student, summary: `Opened document “${doc.title}”` });
    return { url: files.signedPath(doc._id), title: doc.title, mime: doc.mime, expiresInMinutes: files.LINK_MINUTES };
});

// Used by the plan form to list a student's prescriptions without loading the whole record.
exports.studentDocuments = handle(async (req) => {
    const card = await access.assertStudent(req.schoolId, req.params.id);
    return run(`SELECT "_id","title","type","mime","createdAt","visibility","status" FROM "medicaldocuments"
                 WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL ORDER BY "createdAt" DESC`, [String(req.schoolId), String(card._id)]);
});

/* ── Before a medicine is given ───────────────────────────────────────────── */

exports.recentDoses = handle(async (req) => {
    await access.assertStudent(req.schoolId, req.params.id);
    return safety.recentDoses(req.schoolId, req.params.id, req.query.hours);
});

/** body: { student, item?, plan?, medicineName?, dose? } → { blocks, warnings, limits, recent } */
exports.safetyCheck = handle(async (req) => {
    const b = req.body || {};
    const student = await access.assertStudent(req.schoolId, b.student);
    const plan = b.plan ? await meds.findPlan(req, b.plan) : null;
    const itemId = b.item || plan?.item;
    const item = itemId ? await meds.findItem(req.schoolId, itemId) : null;
    return safety.check(req.schoolId, student._id, { medicineName: R.str(b.medicineName, 120) || plan?.medicineName || '', item, plan, excludeDose: R.isUuid(b.dose) ? b.dose : null });
});

/* ── Sent home: collection ────────────────────────────────────────────────── */

exports.collectors = handle(async (req) => {
    const visit = await cases.findVisit(req, req.params.id);
    return cases.collectorsFor(req.schoolId, visit.student);
});
exports.recordCollection = handle(async (req) => {
    await cases.recordCollection(req, req.params.id, req.body || {});
    return visitDetail(req, req.params.id);
});

/* ── Readings, triage, protocols, body map ───────────────────────────────── */

exports.careLibrary = handle(async () => vitals.library());
exports.addReading = handle(async (req) => {
    const out = await vitals.addReading(req, req.params.id, req.body || {});
    return { ...out, visit: await visitDetail(req, req.params.id) };
});
exports.strikeReading = handle(async (req) => {
    await vitals.strikeReading(req, req.params.id, req.params.rid, req.body || {});
    return visitDetail(req, req.params.id);
});
exports.setTriage = handle(async (req) => {
    const out = await vitals.setTriage(req, req.params.id, req.body || {});
    return { ...out, visit: await visitDetail(req, req.params.id) };
});
exports.setProtocol = handle(async (req) => {
    const out = await vitals.setProtocol(req, req.params.id, req.body || {});
    return { ...out, visit: await visitDetail(req, req.params.id) };
});
exports.visitInjuries = handle(async (req) => {
    await vitals.setInjuries(req, 'visit', req.params.id, req.body || {});
    return visitDetail(req, req.params.id);
});
exports.incidentInjuries = handle((req) => vitals.setInjuries(req, 'incident', req.params.id, req.body || {}));

/* ── Restrictions and return to school ────────────────────────────────────── */

exports.exclusionRules = handle(async (req) => {
    const s = await settingsSvc.get(req.schoolId);
    return { rules: limits.rulesFor(s), defaults: limits.EXCLUSION_RULES, overrides: s.exclusionRules || {}, kinds: limits.RESTRICTION_KIND };
});
exports.addRestriction = handle((req) => limits.addRestriction(req, req.params.id, req.body || {}));
exports.updateRestriction = handle((req) => limits.updateRestriction(req, req.params.id, req.body || {}));
exports.endRestriction = handle((req) => limits.endRestriction(req, req.params.id, req.body || {}));
exports.addExclusion = handle((req) => limits.addExclusion(req, req.params.id, req.body || {}));
exports.clearExclusion = handle((req) => limits.clearExclusion(req, req.params.id, req.body || {}));
exports.cancelExclusion = handle((req) => limits.cancelExclusion(req, req.params.id, req.body || {}));
exports.exclusionCertificate = handle(async (req, res) => {
    await upload(uploadMedicalDoc.single('file'))(req, res);
    if (!req.file) R.refuse('Choose the certificate to upload');
    return limits.attachCertificate(req, req.params.id, req.file);
});

/* ── Consent, the family's own medicine, counting the shelf ──────────────── */

exports.recordConsent = handle(async (req) => {
    await consent.give(req, req.params.id, { ...(req.body || {}), onPaper: true });
    return read.staffRecord(req, req.params.id).then((r) => ({ consent: r.consent, consentYear: r.consentYear }));
});
exports.withdrawConsent = handle((req) => consent.withdraw(req, req.params.id, req.body || {}));
exports.requestConsent = handle((req) => consent.request(req, req.body || {}));
exports.planSupply = handle((req) => meds.recordSupply(req, req.params.id, req.body || {}));
exports.countItem = handle((req) => meds.countItem(req, req.params.id, req.body || {}));
exports.itemCounts = handle((req) => meds.counts(req, req.params.id));

/* ── Places, reorder, costs, disposal, the fridge ──────────────────────────── */

exports.places = handle((req) => places.places(req, { all: req.query.all === '1' }));
exports.addPlace = handle((req) => places.addPlace(req, req.body || {}));
exports.updatePlace = handle((req) => places.updatePlace(req, req.params.id, req.body || {}));
exports.checkPlace = handle((req) => places.checkPlace(req, req.params.id, req.body || {}));
exports.placeStock = handle((req) => places.placeStock(req, req.params.id));
exports.transferStock = handle((req) => places.transfer(req, req.body || {}));
exports.reorder = handle((req) => places.reorder(req, req.query || {}));
exports.reorderRequest = handle((req) => places.raisePurchaseRequest(req, req.body || {}));
exports.costs = handle((req) => places.costs(req, req.query || {}));
exports.disposals = handle((req) => places.disposals(req, req.query || {}));
exports.dispose = handle((req) => places.dispose(req, req.params.id, req.body || {}));
exports.fridge = handle((req) => places.tempLogs(req, req.query || {}));
exports.logFridge = handle((req) => places.logTemp(req, req.body || {}));

/* ── Leaving, keeping, the family's requests; the health summary ─────────── */

const adminOnly = (req) => { if (req.userRole !== 'school_admin') R.refuse('Only a school admin may do this', 403, 'MEDICAL_ADMIN_ONLY'); };
exports.healthSummary = handle(async (req, res) => {
    const rec = await read.staffRecord(req, req.params.id);
    const [school] = await run(`SELECT "name", "logo" FROM "schools" WHERE "_id" = $1`, [String(req.schoolId)]);
    audit.log(req, { action: 'downloaded', entity: 'summary', student: rec.student._id, summary: `Downloaded the health summary of ${rec.student.name}` });
    await require('../services/medicalPdf').healthSummary(res, { school, record: rec, generatedBy: req.user?.name || '' });
});
exports.retentionDue = handle((req) => retention.due(req));
exports.legalHold = handle((req) => { adminOnly(req); return retention.hold(req, req.params.id, req.body || {}); });
exports.purgeRecord = handle((req) => { adminOnly(req); return retention.purge(req, req.params.id, req.body || {}); });
exports.dataRequests = handle((req) => retention.requests(req, req.query || {}));
exports.respondDataRequest = handle((req) => retention.respond(req, req.params.id, req.body || {}));

/* ── Confirming it is you; who opened which records ────────────────────────── */

exports.stepUpSend = handle((req) => stepUp.send(req, { force: req.body?.force === true && req.userRole === 'school_admin' }));
exports.stepUpVerify = handle((req) => stepUp.verify(req, req.body || {}));
exports.accessReview = handle(async (req) => {
    if (req.userRole !== 'school_admin') R.refuse('The access review is for the school admins', 403, 'MEDICAL_ADMIN_ONLY');
    return require('../services/medicalAccessReview').review(req, req.query || {});
});

/* ── Safeguarding (any member of staff raises; the leads read) ─────────────── */

exports.sgMe = handle((req) => safeguarding.me(req));
exports.sgRaise = handle((req) => safeguarding.raise(req, req.body || {}));
exports.sgMine = handle((req) => safeguarding.mine(req));
exports.sgLog = handle((req) => safeguarding.log(req, req.query || {}));
exports.sgDetail = handle((req) => safeguarding.detail(req, req.params.id));
exports.sgNote = handle(async (req) => { await safeguarding.addNote(req, req.params.id, req.body || {}); return safeguarding.detail(req, req.params.id); });
exports.sgStatus = handle(async (req) => { await safeguarding.setStatus(req, req.params.id, req.body || {}); return safeguarding.detail(req, req.params.id); });

/* ── Staff as patients ────────────────────────────────────────────────────── */

exports.staffVisitsBoard = handle((req) => staffHealth.board(req, req.query || {}));
exports.searchStaffPatients = handle((req) => staffHealth.searchStaff(req.schoolId, req.query.q));
exports.staffHealthCard = handle(async (req) => {
    const out = await staffHealth.staffCard(req, req.params.id);
    audit.log(req, { action: 'viewed', entity: 'staff_health', entityId: out.health?._id || null, summary: `Opened the staff health record of ${out.staff.name}` });
    return out;
});
exports.saveStaffHealth = handle((req) => staffHealth.saveHealth(req, req.params.id, req.body || {}));
exports.addStaffVisit = handle((req) => staffHealth.addVisit(req, req.body || {}));
exports.updateStaffVisit = handle((req) => staffHealth.updateVisit(req, req.params.id, req.body || {}));
exports.archiveStaffVisit = handle((req) => staffHealth.archiveVisit(req, req.params.id, req.body || {}));
exports.myHealth = handle((req) => staffHealth.mine(req));
exports.saveMyHealth = handle(async (req) => { await staffHealth.saveHealth(req, req.userId, req.body || {}, { self: true }); return staffHealth.mine(req); });

/* ── Urgent news to families: who has been reached ───────────────────────── */

exports.urgentList = handle((req) => urgent.forDesk(req));
exports.urgentAttempt = handle((req) => urgent.attempt(req, req.params.id, req.body || {}));
exports.urgentAcknowledge = handle((req) => urgent.acknowledge(req, req.params.id, req.body || {}));
exports.urgentClose = handle((req) => urgent.close(req, req.params.id, req.body || {}));

/* ── Rescue medicines and care plans ──────────────────────────────────────── */

exports.addRescue = handle((req) => care.addRescue(req, req.params.id, req.body || {}));
exports.updateRescue = handle((req) => care.updateRescue(req, req.params.id, req.body || {}));
exports.checkRescue = handle((req) => care.checkRescue(req, req.params.id, req.body || {}));
exports.carePlanTemplates = handle(async () => ({ kinds: care.CARE_PLAN_KIND, templates: care.TEMPLATES, rescueKinds: care.RESCUE_KIND, places: care.RESCUE_PLACE }));
exports.addCarePlan = handle((req) => care.addCarePlan(req, req.params.id, req.body || {}));
exports.updateCarePlan = handle((req) => care.updateCarePlan(req, req.params.id, req.body || {}));

/* ── Programmes: growth, the vaccination schedule, referrals, campaigns, outbreaks ── */

const growthSvc = require('../services/medicalGrowth');
const scheduleSvc = require('../services/medicalSchedule');
const referralSvc = require('../services/medicalReferrals');
const campaignSvc = require('../services/medicalCampaigns');
const outbreakSvc = require('../services/medicalOutbreak');

exports.growth = handle(async (req) => {
    const card = await access.assertStudent(req.schoolId, req.params.id);
    audit.viewed(req, { entity: 'growth', student: card._id, summary: `Opened the growth chart of ${card.name}` });
    return growthSvc.forStudent(req.schoolId, card);
});
/** What a height and weight mean for this student, before the checkup is saved. */
exports.growthAssess = handle(async (req) => {
    const b = req.body || {};
    const card = await access.assertStudent(req.schoolId, b.student);
    return growthSvc.assess({ sex: card.gender, dob: card.dob, on: b.on || R.todayStr(), heightCm: b.heightCm, weightKg: b.weightKg });
});

exports.studentSchedule = handle(async (req) => {
    const card = await access.assertStudent(req.schoolId, req.params.id);
    return scheduleSvc.forStudent(req.schoolId, card);
});
exports.vaccineCoverage = handle((req) => scheduleSvc.coverage(req, req.query || {}));
exports.vaccineAskFamilies = handle((req) => scheduleSvc.askFamilies(req, req.body || {}));
exports.addExemption = handle((req) => scheduleSvc.addExemption(req, req.params.id, req.body || {}));
exports.endExemption = handle((req) => scheduleSvc.endExemption(req, req.params.id, req.body || {}));

exports.referrals = handle((req) => referralSvc.board(req, req.query || {}));
exports.createReferral = handle((req) => referralSvc.create(req, req.body || {}));
exports.referral = handle(async (req) => {
    const r = referralSvc.decorate(await referralSvc.find(req, req.params.id));
    const card = await access.studentCard(req.schoolId, r.student);
    audit.viewed(req, { entity: 'referral', entityId: r._id, student: r.student, summary: `Opened referral ${r.number}` });
    return { ...r, studentName: card?.name || '', classLabel: card?.classLabel || '' };
});
exports.referralAct = handle((req) => referralSvc.act(req, req.params.id, req.body || {}));
exports.referralLetter = handle(async (req, res) => {
    const r = await referralSvc.find(req, req.params.id);
    await sendReferralLetter(req, res, r);
});

/** The letter the family takes to the specialist, with a reply slip at the foot. */
async function sendReferralLetter(req, res, r) {
    const card = await access.studentCard(req.schoolId, r.student);
    const [school] = (await pool.query(`SELECT "name", "logo" FROM "schools" WHERE "_id" = $1`, [String(req.schoolId)])).rows;
    const s = await settingsSvc.get(req.schoolId);
    const { rows: allergies } = await pool.query(
        `SELECT "allergen","severity" FROM "medicalallergies" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND COALESCE("status",'active') <> 'resolved'`,
        [String(req.schoolId), String(r.student)]);
    audit.log(req, { action: 'downloaded', entity: 'referral', entityId: r._id, student: r.student, summary: `Referral letter ${r.number} downloaded` });
    await require('../services/medicalPdf').referralLetter(res, {
        school, referral: referralSvc.decorate(r), student: card, allergies,
        room: { name: s.roomName, phone: s.roomPhone }, by: r.createdByName,
    });
}
exports.sendReferralLetter = sendReferralLetter;

exports.campaigns = handle((req) => campaignSvc.list(req, req.query || {}));
exports.createCampaign = handle((req) => campaignSvc.create(req, req.body || {}));
exports.campaign = handle((req) => campaignSvc.detail(req, req.params.id, req.query || {}));
exports.updateCampaign = handle((req) => campaignSvc.update(req, req.params.id, req.body || {}));
exports.campaignAct = handle((req) => {
    const fn = { announce: campaignSvc.announce, cancel: campaignSvc.cancel, close: campaignSvc.close, reopen: campaignSvc.reopen }[req.params.action];
    if (!fn) R.refuse('Unknown action', 404, 'MEDICAL_NOT_FOUND');
    return fn(req, req.params.id, req.body || {});
});
exports.campaignRecord = handle((req) => campaignSvc.record(req, req.params.id, req.body || {}));
exports.campaignMarkRest = handle((req) => campaignSvc.markRest(req, req.params.id, req.body || {}));

exports.outbreaks = handle((req) => outbreakSvc.list(req, req.query || {}));
exports.outbreak = handle((req) => outbreakSvc.detail(req, req.params.id));
exports.outbreakAct = handle((req) => outbreakSvc.act(req, req.params.id, req.body || {}));
exports.outbreakNoticeDraft = handle(async (req) => {
    const o = await outbreakSvc.detail(req, req.params.id);
    return { text: outbreakSvc.noticeDraft(o, req.query.audience || 'section') };
});
exports.outbreakNotice = handle((req) => outbreakSvc.notice(req, req.params.id, req.body || {}));
exports.illnessReports = handle((req) => outbreakSvc.reports(req, req.query || {}));
exports.illnessSeen = handle((req) => outbreakSvc.markSeen(req, req.params.id));

/* ── Finding a student by ID card; the walk-in kiosk ──────────────────────── */

const kioskSvc = require('../services/medicalKiosk');
exports.resolveStudent = handle((req) => kioskSvc.resolve(req, req.query.q));
exports.kioskMeta = handle(async (req) => {
    const s = await settingsSvc.get(req.schoolId);
    return { reasons: kioskSvc.REASONS, room: { name: s.roomName, hours: s.roomHours } };
});
exports.kioskWalkIn = handle((req) => kioskSvc.walkIn(req, req.body || {}));

/* ── Printed documents: incident report, hospital handover, annual cards, emergency card sets ── */

const docsSvc = require('../services/medicalDocuments');
exports.incidentPdf = handle(async (req, res) => { await docsSvc.incident(req, res, req.params.id); });
exports.handoverPdf = handle(async (req, res) => { await docsSvc.handover(req, res, req.params.id); });
exports.annualPdf = handle(async (req, res) => {
    const card = await access.assertStudent(req.schoolId, req.params.id);
    await docsSvc.annual(req, res, { studentIds: [card._id], yearId: req.query.year });
});
exports.annualSetPdf = handle(async (req, res) => {
    const { ids, label } = await docsSvc.studentsFor(req.schoolId, { sectionId: req.query.sectionId });
    await docsSvc.annual(req, res, { studentIds: ids, yearId: req.query.year, label });
});
exports.cardSetPdf = handle(async (req, res) => { await docsSvc.cardSet(req, res, req.body || {}); });

/* ── Import from a spreadsheet; the start of a new year ───────────────────── */

const importSvc = require('../services/medicalImport');
const rolloverSvc = require('../services/medicalRollover');
exports.importTemplate = handle(async (req, res) => {
    const kind = req.params.kind;
    if (!importSvc.TEMPLATES[kind]) R.refuse('Unknown template', 404, 'MEDICAL_NOT_FOUND');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="medical-${kind}-template.csv"`);
    res.end(importSvc.TEMPLATES[kind]);
});
exports.importPreview = handle((req) => importSvc.preview(req, req.body || {}));
exports.importCommit = handle((req) => importSvc.commit(req, req.body || {}));
exports.rollover = handle((req) => rolloverSvc.checklist(req));
exports.rolloverAct = handle((req) => rolloverSvc.act(req, req.params.key));

/** A scanned medicine pack → the item and what is usable (the phone's scanner). */
exports.itemByCode = handle((req) => meds.itemByCode(req, req.query.code));
exports.offlineCards = handle((req) => docsSvc.offlineCards(req));
