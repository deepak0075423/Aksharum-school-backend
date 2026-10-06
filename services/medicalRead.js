'use strict';
/**
 * One student's medical record, as each reader is allowed to see it (Oct 2026).
 *
 *   staffRecord      the medical staff: everything, private notes included
 *   emergencyProfile the one-screen card for an emergency — staff, and the
 *                    student's own teachers when the school allows it
 *   teacherSlice     a teacher: the alerts the room shares with teachers and
 *                    the instructions that go with them — nothing else
 *   familyRecord     the student or a parent: their own record, without the
 *                    staff's private notes or staff-only documents
 *   history          the timeline: visits, incidents, first aid, medicines,
 *                    referrals, checkups, vaccinations, documents, follow-ups
 *                    — merged and filtered, never rewritten
 *
 * Whether the caller may see THIS student is decided before these are called
 * (controllers + services/medicalAccess). These decide what of it they see.
 */
const pool = require('../db/pool');
const access = require('./medicalAccess');
const settingsSvc = require('./medicalSettings');
const R = require('./medicalRules');

const { dayStr, dayLabel, todayStr, isUuid, str } = R;

const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const S = (v) => String(v);

/* ── Pieces ───────────────────────────────────────────────────────────────── */

async function contactsOf(schoolId, studentId) {
    const [sp] = await q(
        `SELECT "emergencyContactName", "emergencyContactPhone", "emergencyContactRelation", "parent"::text AS "parent", "bloodGroup"
           FROM "studentprofiles" WHERE "user" = $1 AND "school" = $2 LIMIT 1`,
        [S(studentId), S(schoolId)],
    );
    const parents = await q(
        `SELECT pp."father", pp."mother", pp."guardian", pp."relationship", u."name", u."phone", u."email"
           FROM "parentprofiles" pp JOIN "users" u ON u."_id" = pp."user" AND u."role" = 'parent' AND u."school" = $2
          WHERE pp."school" = $2 AND (pp."children" @> to_jsonb($1::text) OR pp."user"::text = $3)`,
        [S(studentId), S(schoolId), sp?.parent || ''],
    );
    const out = [];
    const seen = new Set();
    const add = (c) => {
        const phone = String(c.phone || '').replace(/[^\d+]/g, '');
        if (!c.name && !phone) return;
        const key = phone || c.name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(c);
    };
    for (const p of parents) {
        if (p.father?.name || p.father?.phone) add({ kind: 'parent', name: p.father.name, relation: 'Father', phone: p.father.phone || (p.relationship === 'Father' ? p.phone : ''), email: p.father.email || '' });
        if (p.mother?.name || p.mother?.phone) add({ kind: 'parent', name: p.mother.name, relation: 'Mother', phone: p.mother.phone || (p.relationship === 'Mother' ? p.phone : ''), email: p.mother.email || '' });
        if (p.guardian?.name) add({ kind: 'parent', name: p.guardian.name, relation: p.guardian.relation || 'Guardian', phone: p.guardian.phone, email: p.guardian.email || '' });
        add({ kind: 'parent', name: p.name, relation: p.relationship || 'Parent', phone: p.phone, email: p.email || '' });
    }
    if (sp?.emergencyContactName || sp?.emergencyContactPhone) {
        add({ kind: 'emergency', name: sp.emergencyContactName, relation: sp.emergencyContactRelation || 'Emergency contact', phone: sp.emergencyContactPhone });
    }
    return {
        contacts: out,
        emergencyContact: { name: sp?.emergencyContactName || '', phone: sp?.emergencyContactPhone || '', relation: sp?.emergencyContactRelation || '' },
        bloodGroup: sp?.bloodGroup || '',
    };
}

async function healthRows(schoolId, studentId) {
    const [profile] = await q(`SELECT * FROM "medicalprofiles" WHERE "school" = $1 AND "student" = $2 LIMIT 1`, [S(schoolId), S(studentId)]);
    const allergies = await q(`SELECT * FROM "medicalallergies" WHERE "school" = $1 AND "student" = $2 ORDER BY "archivedAt" NULLS FIRST, "createdAt" DESC`, [S(schoolId), S(studentId)]);
    const conditions = await q(`SELECT * FROM "medicalconditions" WHERE "school" = $1 AND "student" = $2 ORDER BY "archivedAt" NULLS FIRST, "createdAt" DESC`, [S(schoolId), S(studentId)]);
    // itemStock is what can be GIVEN: units past their date are on the shelf but not usable.
    const plans = await q(
        `SELECT p.*, i."name" AS "itemName", i."unit" AS "itemUnit",
                COALESCE((SELECT SUM(b."quantity") FROM "medicalbatches" b WHERE b."item" = i."_id" AND b."status" = 'active'
                    AND (b."expiryDate" IS NULL OR (b."expiryDate" AT TIME ZONE 'UTC')::date >= $3::date)), 0)::float8 AS "itemStock"
           FROM "medicationplans" p LEFT JOIN "medicalitems" i ON i."_id" = p."item"
          WHERE p."school" = $1 AND p."student" = $2 ORDER BY CASE p."status" WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, p."createdAt" DESC`,
        [S(schoolId), S(studentId), todayStr()],
    );
    // Rescue medicines and care plans in force (services/medicalCare).
    const care = (await require('./medicalCare').careFor(schoolId, [studentId])).get(S(studentId)) || { rescueMeds: [], carePlans: [] };
    return { profile: profile || null, allergies, conditions, plans, rescueMeds: care.rescueMeds, carePlans: care.carePlans };
}

/** The contacts with the profile's alternate contact added — unless it is someone already listed. */
function withAlternate(contacts, alt) {
    const phone = String(alt?.phone || '').replace(/[^\d+]/g, '');
    if (!alt?.name && !phone) return contacts;
    if (phone && contacts.some((c) => String(c.phone || '').replace(/[^\d+]/g, '') === phone)) return contacts;
    return [...contacts, { kind: 'alternate', name: alt.name, relation: alt.relation || 'Alternate contact', phone: alt.phone }];
}

function withBmi(profile) {
    if (!profile) return null;
    return { ...profile, bmi: R.bmi(profile.heightCm, profile.weightKg) };
}

const decorateVaccination = (v, today, dueDays) => ({ ...v, state: R.vaccinationStatus(v, today, dueDays) });

/* ── Staff ────────────────────────────────────────────────────────────────── */

async function staffRecord(req, studentId) {
    const student = await access.assertStudent(req.schoolId, studentId);
    const settings = await settingsSvc.get(req.schoolId);
    const today = todayStr();
    const [contacts, health, code, vaccinations, checkups, documents, counts, lastVisit, openVisit, changes, care] = await Promise.all([
        contactsOf(req.schoolId, student._id),
        healthRows(req.schoolId, student._id),
        access.studentCode(req.schoolId, student._id),
        q(`SELECT * FROM "medicalvaccinations" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL ORDER BY COALESCE("givenOn", "dueOn") DESC NULLS LAST`, [S(req.schoolId), S(student._id)]),
        q(`SELECT * FROM "medicalcheckups" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL ORDER BY COALESCE("checkedOn", "scheduledOn") DESC NULLS LAST LIMIT 60`, [S(req.schoolId), S(student._id)]),
        q(`SELECT "_id","type","title","documentDate","expiresOn","mime","size","visibility","status","remarks","linkKind","linkId","uploadedByName","uploadedByRole","createdAt","archivedAt","archiveReason","originalName"
             FROM "medicaldocuments" WHERE "school" = $1 AND "student" = $2 ORDER BY "createdAt" DESC`, [S(req.schoolId), S(student._id)]),
        q(`SELECT
             (SELECT count(*)::int FROM "medicalvisits" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL) AS visits,
             (SELECT count(*)::int FROM "medicalincidents" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL) AS incidents,
             (SELECT count(*)::int FROM "medicalfirstaids" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL) AS "firstAid",
             (SELECT count(*)::int FROM "medicationdoses" WHERE "school" = $1 AND "student" = $2 AND "status" = 'given') AS doses`, [S(req.schoolId), S(student._id)]),
        q(`SELECT "_id","number","arrivedAt","reason","status" FROM "medicalvisits" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL ORDER BY "arrivedAt" DESC LIMIT 1`, [S(req.schoolId), S(student._id)]),
        q(`SELECT "_id","number","arrivedAt","reason","status" FROM "medicalvisits" WHERE "school" = $1 AND "student" = $2 AND "status" IN ('in_room','observation','emergency') AND "archivedAt" IS NULL LIMIT 1`, [S(req.schoolId), S(student._id)]),
        q(`SELECT * FROM "medicalchangerequests" WHERE "school" = $1 AND "student" = $2 ORDER BY "createdAt" DESC LIMIT 30`, [S(req.schoolId), S(student._id)]),
        require('./medicalCare').allFor(req.schoolId, student._id),
    ]);
    const limits = require('./medicalRestrictions');
    const [restrictions, exclusions] = await Promise.all([
        q(`SELECT * FROM "medicalrestrictions" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL ORDER BY "startsOn" DESC LIMIT 40`, [S(req.schoolId), S(student._id)]),
        q(`SELECT * FROM "medicalexclusions" WHERE "school" = $1 AND "student" = $2 ORDER BY "createdAt" DESC LIMIT 20`, [S(req.schoolId), S(student._id)]),
    ]);
    const consentSvc = require('./medicalConsent');
    const consent = await consentSvc.forStudent(req.schoolId, student._id);
    const live = (r) => !r.archivedAt;
    // Health programmes: the WHO growth chart, the school's vaccination schedule, referrals, campaigns.
    const [growth, schedule, referrals, campaigns] = await Promise.all([
        require('./medicalGrowth').forStudent(req.schoolId, student),
        require('./medicalSchedule').forStudent(req.schoolId, student, settings),
        require('./medicalReferrals').forStudent(req.schoolId, student._id),
        require('./medicalCampaigns').forFamily(req.schoolId, student._id),
    ]);
    return {
        growth, schedule, referrals, campaigns,
        consent, consentYear: await consentSvc.currentYear(req.schoolId), otcCategories: consentSvc.otcCategories(settings),
        restrictions: restrictions.map((x) => ({ ...x, state: limits.restrictionState(x, today) })),
        exclusions,
        student: { ...student, code, age: R.ageYears(student.dob) },
        bloodGroup: contacts.bloodGroup,
        emergencyContact: contacts.emergencyContact,
        contacts: withAlternate(contacts.contacts, health.profile?.alternateContact),
        profile: withBmi(health.profile),
        alerts: R.alertsFor({ allergies: health.allergies, conditions: health.conditions, profile: health.profile, plans: health.plans, rescueMeds: health.rescueMeds, carePlans: health.carePlans }),
        allergies: health.allergies,
        conditions: health.conditions,
        plans: health.plans,
        rescueMeds: care.rescueMeds,
        carePlans: care.carePlans,
        vaccinations: vaccinations.map((v) => decorateVaccination(v, today, settings.vaccinationDueDays)),
        checkups,
        documents,
        counts: counts[0],
        lastVisit: lastVisit[0] || null,
        openVisit: openVisit[0] || null,
        changes,
        summary: {
            allergies: health.allergies.filter(live).filter((a) => a.status !== 'resolved').length,
            conditions: health.conditions.filter(live).filter((c) => c.status !== 'resolved').length,
            medications: health.plans.filter((p) => p.status === 'active').length,
            pendingChanges: changes.filter((c) => c.status === 'pending').length,
        },
    };
}

/* ── Emergency profile ────────────────────────────────────────────────────── */

async function emergencyProfile(schoolId, studentId, { forTeacher = false } = {}) {
    const student = await access.assertStudent(schoolId, studentId);
    const settings = await settingsSvc.get(schoolId);
    const [contacts, health] = await Promise.all([contactsOf(schoolId, student._id), healthRows(schoolId, student._id)]);
    const shared = (r) => !r.archivedAt && r.status !== 'resolved' && (!forTeacher || r.shareWithTeachers !== false);
    const allergies = health.allergies.filter(shared).map((a) => ({
        _id: a._id, allergen: a.allergen, category: a.category, severity: a.severity, reaction: a.reaction,
        emergencyInstructions: a.emergencyInstructions, medication: a.medication, critical: R.SEVERE_ALLERGY.includes(a.severity),
    })).sort((a, b) => Number(b.critical) - Number(a.critical));
    const conditions = health.conditions.filter(shared).map((c) => ({
        _id: c._id, condition: c.condition, type: c.type, severity: c.severity, emergencyInstructions: c.emergencyInstructions,
        medication: c.medication, critical: R.SEVERE_CONDITION.includes(c.severity),
    })).sort((a, b) => Number(b.critical) - Number(a.critical));
    const p = health.profile || {};
    const today = todayStr();
    return {
        student: { _id: student._id, name: student.name, photo: student.photo, classLabel: student.classLabel, admissionNumber: student.admissionNumber, dob: student.dob, age: R.ageYears(student.dob), gender: student.gender },
        bloodGroup: contacts.bloodGroup,
        allergies,
        conditions,
        // What to reach for, and where it is; what to do, step by step.
        rescueMeds: health.rescueMeds.map((r) => ({
            _id: r._id, kind: r.kind, name: r.name, dose: r.dose, quantity: r.quantity, expiresOn: r.expiresOn,
            locations: r.locations || [], selfCarry: !!r.selfCarry, instructions: r.instructions,
            expired: !!(R.dayStr(r.expiresOn) && R.dayStr(r.expiresOn) < today),
        })),
        carePlans: health.carePlans.map((c) => ({
            _id: c._id, kind: c.kind, title: c.title, signs: c.signs || [], steps: c.steps || [], ambulanceWhen: c.ambulanceWhen,
            afterCare: c.afterCare, doctorName: c.doctorName, doctorSignedOn: c.doctorSignedOn, reviewDue: c.reviewDue,
        })),
        emergencyMedication: p.emergencyMedication?.required && !health.rescueMeds.length ? p.emergencyMedication : null,
        instructions: p.instructions || '',
        contacts: withAlternate(contacts.contacts, p.alternateContact),
        doctor: p.doctor || null,
        hospital: p.hospital || null,
        room: { name: settings.roomName, phone: settings.roomPhone, location: settings.roomLocation },
        alerts: R.alertsFor({ allergies: health.allergies, conditions: health.conditions, profile: health.profile, plans: [], rescueMeds: health.rescueMeds, carePlans: health.carePlans }, { forTeacher }),
        generatedAt: new Date(),
    };
}

/* ── Teacher ──────────────────────────────────────────────────────────────── */

/**
 * The alerts of many students at once, the teacher's way: only records the
 * room shares with teachers, no medicines but the emergency one.
 */
async function teacherAlerts(schoolId, studentIds) {
    const ids = [...studentIds].map(S);
    if (!ids.length) return new Map();
    const [allergies, conditions, profiles] = await Promise.all([
        q(`SELECT * FROM "medicalallergies" WHERE "school" = $1 AND "student"::text = ANY($2::text[]) AND "archivedAt" IS NULL AND "status" <> 'resolved' AND "shareWithTeachers" IS NOT FALSE`, [S(schoolId), ids]),
        q(`SELECT * FROM "medicalconditions" WHERE "school" = $1 AND "student"::text = ANY($2::text[]) AND "archivedAt" IS NULL AND "status" <> 'resolved' AND "shareWithTeachers" IS NOT FALSE`, [S(schoolId), ids]),
        q(`SELECT "student"::text AS "student", "emergencyMedication", "instructions" FROM "medicalprofiles" WHERE "school" = $1 AND "student"::text = ANY($2::text[])`, [S(schoolId), ids]),
    ]);
    const care = await require('./medicalCare').careFor(schoolId, ids);
    const by = new Map();
    const bucket = (sid) => { if (!by.has(sid)) by.set(sid, { allergies: [], conditions: [], profile: null, rescueMeds: [], carePlans: [] }); return by.get(sid); };
    for (const a of allergies) bucket(S(a.student)).allergies.push(a);
    for (const c of conditions) bucket(S(c.student)).conditions.push(c);
    for (const p of profiles) bucket(p.student).profile = p;
    for (const [sid, c] of care) {
        if (!c.rescueMeds.length && !c.carePlans.length) continue;
        Object.assign(bucket(sid), { rescueMeds: c.rescueMeds, carePlans: c.carePlans });
    }
    // A parent who asked that teachers see only what safety needs: the critical alerts.
    const limited = await require('./medicalConsent').teacherLimited(schoolId, [...by.keys()]);
    const out = new Map();
    for (const [sid, d] of by) {
        let alerts = R.alertsFor(d, { forTeacher: true });
        if (limited.has(sid)) alerts = alerts.filter((a) => a.level === 'critical');
        if (alerts.length) out.set(sid, { alerts, instructions: limited.has(sid) ? '' : d.profile?.instructions || '' });
    }
    return out;
}

/* ── Family ───────────────────────────────────────────────────────────────── */

async function familyRecord(req, studentId) {
    const settings = await settingsSvc.get(req.schoolId);
    const isStudent = req.userRole === 'student';
    if (isStudent && !settings.studentAccess) {
        const { refuse } = R;
        refuse('Your school shares medical information with parents only', 403, 'MEDICAL_STUDENT_OFF');
    }
    const student = await access.assertStudent(req.schoolId, studentId);
    const today = todayStr();
    const show = {
        visits: !isStudent || settings.studentVisits,
        checkups: !isStudent || settings.studentCheckups,
        vaccinations: !isStudent || settings.studentVaccinations,
        documents: !isStudent || settings.studentDocuments,
        incidents: !isStudent || settings.studentVisits,
        medicines: !isStudent,
        updates: !isStudent && settings.parentUpdates,
    };
    const [contacts, health, vaccinations, checkups, documents, visits, incidents, doses, changes] = await Promise.all([
        contactsOf(req.schoolId, student._id),
        healthRows(req.schoolId, student._id),
        show.vaccinations ? q(`SELECT "_id","vaccine","dose","givenOn","dueOn","nextDueOn","provider","doctor","remarks","certificate","source","verified" FROM "medicalvaccinations" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL ORDER BY COALESCE("givenOn","dueOn") DESC NULLS LAST`, [S(req.schoolId), S(student._id)]) : [],
        show.checkups ? q(`SELECT "_id","type","status","scheduledOn","checkedOn","professional","sessionName","results","outcome","findings","recommendations","followUp" FROM "medicalcheckups" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND "status" <> 'cancelled' ORDER BY COALESCE("checkedOn","scheduledOn") DESC NULLS LAST LIMIT 60`, [S(req.schoolId), S(student._id)]) : [],
        show.documents ? q(`SELECT "_id","type","title","documentDate","expiresOn","mime","size","status","remarks","uploadedByName","uploadedByRole","createdAt","uploadedBy"::text AS "uploadedBy"
             FROM "medicaldocuments" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL
              AND ("visibility" = 'family' OR "uploadedBy" = $3) ORDER BY "createdAt" DESC`, [S(req.schoolId), S(student._id), S(req.userId)]) : [],
        show.visits ? q(`SELECT "_id","number","arrivedAt","reason","symptoms","treatment","firstAid","medicines","restAdvised","restMinutes","status","departedAt","referral","followUp","parentContacted","vitals"
             FROM "medicalvisits" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL ORDER BY "arrivedAt" DESC LIMIT 100`, [S(req.schoolId), S(student._id)]) : [],
        show.incidents ? q(`SELECT "_id","number","occurredAt","location","type","description","injury","bodyPart","severity","firstAid","status","referral","followUp"
             FROM "medicalincidents" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL ORDER BY "occurredAt" DESC LIMIT 100`, [S(req.schoolId), S(student._id)]) : [],
        show.medicines ? q(`SELECT "_id","medicineName","dosage","status","scheduledFor","givenAt","givenByName","note","source"
             FROM "medicationdoses" WHERE "school" = $1 AND "student" = $2 AND "status" IN ('given','refused','missed') ORDER BY COALESCE("givenAt","scheduledFor") DESC LIMIT 100`, [S(req.schoolId), S(student._id)]) : [],
        show.updates ? q(`SELECT "_id","kind","action","payload","note","status","reviewNote","reviewedByName","reviewedAt","createdAt","target"::text AS "target","document"::text AS "document"
             FROM "medicalchangerequests" WHERE "school" = $1 AND "student" = $2 ORDER BY "createdAt" DESC LIMIT 50`, [S(req.schoolId), S(student._id)]) : [],
    ]);
    const live = (r) => !r.archivedAt;
    const strip = (r) => { const { privateNotes, createdBy, updatedBy, verifiedBy, archivedBy, ...rest } = r; return rest; };
    const p = health.profile;
    const profile = p ? withBmi({
        heightCm: p.heightCm, weightKg: p.weightKg, measuredOn: p.measuredOn, dietaryRestrictions: p.dietaryRestrictions,
        doctor: p.doctor, hospital: p.hospital, alternateContact: p.alternateContact, instructions: p.instructions,
        emergencyMedication: p.emergencyMedication, updatedAt: p.updatedAt,
    }) : null;
    return {
        student: { _id: student._id, name: student.name, photo: student.photo, classLabel: student.classLabel, admissionNumber: student.admissionNumber, rollNumber: student.rollNumber, dob: student.dob, age: R.ageYears(student.dob), gender: student.gender },
        show,
        bloodGroup: contacts.bloodGroup,
        emergencyContact: contacts.emergencyContact,
        contacts: withAlternate(contacts.contacts, p?.alternateContact),
        profile,
        alerts: R.alertsFor({ allergies: health.allergies, conditions: health.conditions, profile: p, plans: isStudent ? [] : health.plans, rescueMeds: health.rescueMeds, carePlans: health.carePlans }),
        // Kept at school, and what to do in an episode — a parent confirms each plan.
        rescueMeds: health.rescueMeds.map((r) => ({
            _id: r._id, kind: r.kind, name: r.name, dose: r.dose, quantity: r.quantity, expiresOn: r.expiresOn,
            locations: r.locations || [], selfCarry: !!r.selfCarry, instructions: r.instructions, lastCheckedAt: r.lastCheckedAt,
        })),
        carePlans: health.carePlans.map((c) => ({
            _id: c._id, kind: c.kind, title: c.title, triggers: c.triggers, signs: c.signs || [], steps: c.steps || [],
            ambulanceWhen: c.ambulanceWhen, afterCare: c.afterCare, doctorName: c.doctorName, doctorSignedOn: c.doctorSignedOn,
            reviewDue: c.reviewDue, parentConfirmedAt: c.parentConfirmedAt, parentConfirmedName: c.parentConfirmedName,
        })),
        allergies: health.allergies.filter(live).map(strip),
        conditions: health.conditions.filter(live).map(strip),
        plans: isStudent ? [] : health.plans.filter((x) => ['active', 'paused'].includes(x.status)).map((x) => ({
            _id: x._id, medicineName: x.medicineName, dosage: x.dosage, frequency: x.frequency, times: x.times, startDate: x.startDate,
            endDate: x.endDate, instructions: x.instructions, status: x.status, statusNote: x.statusNote, source: x.source,
            authorized: !!x.parentAuthorization?.authorized,
        })),
        vaccinations: vaccinations.map((v) => decorateVaccination(v, today, settings.vaccinationDueDays)),
        checkups,
        documents,
        visits,
        incidents,
        doses,
        changes,
        room: { name: settings.roomName, phone: settings.roomPhone, hours: settings.roomHours, location: settings.roomLocation },
        // Urgent news the school is waiting for a parent to answer.
        urgent: isStudent ? [] : await require('./medicalUrgent').forFamily(req.schoolId, student._id),
        // What teachers have been asked to do, and when the child can come back.
        restrictions: await require('./medicalRestrictions').restrictionsFor(req.schoolId, [student._id], { withReason: true, days: 14 }),
        exclusions: await require('./medicalRestrictions').exclusionsFor(req.schoolId, [student._id], { withDetail: true }),
        // This year's consent: what the parents allow (a student sees it, a parent gives it).
        consent: await require('./medicalConsent').forStudent(req.schoolId, student._id).then((c) => (c ? (({ history, givenBy, ...rest }) => rest)(c) : null)),
        consentYear: await require('./medicalConsent').currentYear(req.schoolId),
        otcCategories: require('./medicalConsent').otcCategories(settings),
        canUpdate: !isStudent && settings.parentUpdates,
        needsApproval: settings.parentUpdatesNeedApproval,
        // Health programmes: growth (with the checkups), the vaccination schedule, specialist
        // referrals, campaigns, the illnesses the family reported, health notices for the class.
        growth: show.checkups ? await require('./medicalGrowth').forStudent(req.schoolId, student) : null,
        schedule: show.vaccinations ? await require('./medicalSchedule').forStudent(req.schoolId, student, settings) : null,
        referrals: show.checkups ? await require('./medicalReferrals').forStudent(req.schoolId, student._id, { family: true }) : [],
        campaigns: await require('./medicalCampaigns').forFamily(req.schoolId, student._id),
        illnessReports: isStudent ? [] : await require('./medicalOutbreak').familyReports(req.schoolId, student._id),
        notices: await require('./medicalOutbreak').noticesFor(req.schoolId, student._id),
        symptoms: require('./medicalOutbreak').SYMPTOMS,
        // The language the room writes to this parent in, and the school's (services/medicalLang).
        noticeLanguage: isStudent ? null : {
            mine: (await q(`SELECT "medicalLanguage" FROM "parentprofiles" WHERE "user" = $1`, [S(req.userId)]))[0]?.medicalLanguage || '',
            school: settings.noticeLanguage || 'en',
        },
    };
}

/* ── History ──────────────────────────────────────────────────────────────── */

const HISTORY_KINDS = ['visit', 'incident', 'first_aid', 'medicine', 'referral', 'checkup', 'vaccination', 'document', 'follow_up', 'record', 'hostel'];

async function yearRange(schoolId, yearId) {
    if (!isUuid(yearId)) return null;
    const [y] = await q(`SELECT "startDate","endDate","yearName" FROM "academicyears" WHERE "_id" = $1 AND "school" = $2`, [S(yearId), S(schoolId)]);
    if (!y) return null;
    return { from: dayStr(y.startDate), to: dayStr(y.endDate), name: y.yearName };
}

/**
 * The timeline of one student. opts: { from, to, year, kind, status, audience: 'staff' | 'family', allow, page, limit }.
 * A family timeline carries no private notes and no staff-only documents;
 * `allow` limits the kinds of entry at all (a student sees what the school shares with students).
 */
async function history(schoolId, studentId, opts = {}) {
    const audience = opts.audience === 'family' ? 'family' : 'staff';
    let from = /^\d{4}-\d{2}-\d{2}$/.test(opts.from || '') ? opts.from : '';
    let to = /^\d{4}-\d{2}-\d{2}$/.test(opts.to || '') ? opts.to : '';
    const yr = await yearRange(schoolId, opts.year);
    if (yr) { from = from && from > yr.from ? from : yr.from; to = to && to < yr.to ? to : yr.to; }
    const allowed = Array.isArray(opts.allow) ? HISTORY_KINDS.filter((k) => opts.allow.includes(k)) : HISTORY_KINDS;
    const kinds = opts.kind ? (allowed.includes(opts.kind) ? [opts.kind] : []) : allowed;
    const want = (k) => kinds.includes(k);
    const P = [S(schoolId), S(studentId)];
    const items = [];
    const push = (it) => items.push(it);
    const tz = R.ZONE;
    const inRange = (col) => `${from ? ` AND (${col} AT TIME ZONE '${tz}')::date >= '${from}'::date` : ''}${to ? ` AND (${col} AT TIME ZONE '${tz}')::date <= '${to}'::date` : ''}`;
    const dayRange = (col) => `${from ? ` AND (${col} AT TIME ZONE 'UTC')::date >= '${from}'::date` : ''}${to ? ` AND (${col} AT TIME ZONE 'UTC')::date <= '${to}'::date` : ''}`;

    if (want('visit') || want('referral') || want('follow_up')) {
        const rows = await q(`SELECT * FROM "medicalvisits" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL${inRange('"arrivedAt"')} ORDER BY "arrivedAt" DESC`, P);
        for (const v of rows) {
            if (want('visit')) {
                push({
                    id: `visit:${v._id}`, kind: 'visit', at: v.arrivedAt, ref: { kind: 'visit', id: v._id },
                    title: `Medical Room visit — ${v.reason}`, number: v.number,
                    status: { key: v.status, ...R.VISIT_STATUS[v.status] },
                    lines: [
                        v.symptoms && `Symptoms: ${v.symptoms}`,
                        v.observation && audience === 'staff' && `Observation: ${v.observation}`,
                        v.treatment && `Treatment: ${v.treatment}`,
                        v.firstAid && `First aid: ${v.firstAid}`,
                        (v.medicines || []).length && `Medicines: ${v.medicines.map((m) => `${m.name} (${m.dosage})`).join(', ')}`,
                        v.restAdvised && `Rest advised${v.restMinutes ? ` — ${v.restMinutes} min` : ''}`,
                        v.parentContacted && 'Parent contacted',
                    ].filter(Boolean),
                    by: v.handledByName,
                    emergency: !!v.emergency,
                });
            }
            if (want('referral') && v.referral?.referred) {
                push({ id: `ref:${v._id}`, kind: 'referral', at: v.referral.at || v.departedAt || v.arrivedAt, ref: { kind: 'visit', id: v._id }, title: `Hospital referral — ${v.referral.hospital || 'hospital'}`, status: { key: 'referred', ...R.VISIT_STATUS.referred }, lines: [v.referral.reason, v.referral.transport && `Transport: ${v.referral.transport}`, v.referral.accompaniedBy && `Accompanied by ${v.referral.accompaniedBy}`].filter(Boolean) });
            }
            if (want('follow_up') && v.followUp?.required) {
                const st = v.followUp.status === 'pending' ? R.followUpState(v.followUp) || 'upcoming' : v.followUp.status;
                push({ id: `fu:visit:${v._id}`, kind: 'follow_up', at: v.followUp.doneAt || (v.followUp.on ? new Date(v.followUp.on) : v.arrivedAt), ref: { kind: 'visit', id: v._id }, title: `Follow-up after ${v.number}`, status: { key: st, ...FOLLOW_STATUS[st] }, lines: [v.followUp.note, v.followUp.outcome && `Outcome: ${v.followUp.outcome}`].filter(Boolean) });
            }
        }
    }
    if (want('incident') || want('referral') || want('follow_up')) {
        const rows = await q(`SELECT * FROM "medicalincidents" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL${inRange('"occurredAt"')} ORDER BY "occurredAt" DESC`, P);
        for (const i of rows) {
            if (want('incident')) {
                push({
                    id: `incident:${i._id}`, kind: 'incident', at: i.occurredAt, ref: { kind: 'incident', id: i._id }, number: i.number,
                    title: `${R.INCIDENT_TYPE[i.type]}${i.location ? ` — ${i.location}` : ''}`,
                    status: { key: i.severity, ...R.INCIDENT_SEVERITY[i.severity] },
                    lines: [i.description, i.injury && `Injury: ${i.injury}${i.bodyPart ? ` (${i.bodyPart})` : ''}`, i.firstAid && `First aid: ${i.firstAid}`, i.parentNotified && 'Parents informed'].filter(Boolean),
                    by: i.reportedByName,
                });
            }
            if (want('referral') && i.referral?.referred) {
                push({ id: `ref:i:${i._id}`, kind: 'referral', at: i.referral.at || i.occurredAt, ref: { kind: 'incident', id: i._id }, title: `Hospital referral — ${i.referral.hospital || 'hospital'}`, status: { key: 'referred', ...R.VISIT_STATUS.referred }, lines: [i.referral.reason].filter(Boolean) });
            }
            if (want('follow_up') && i.followUp?.required) {
                const st = i.followUp.status === 'pending' ? R.followUpState(i.followUp) || 'upcoming' : i.followUp.status;
                push({ id: `fu:incident:${i._id}`, kind: 'follow_up', at: i.followUp.doneAt || (i.followUp.on ? new Date(i.followUp.on) : i.occurredAt), ref: { kind: 'incident', id: i._id }, title: `Follow-up after ${i.number}`, status: { key: st, ...FOLLOW_STATUS[st] }, lines: [i.followUp.note, i.followUp.outcome && `Outcome: ${i.followUp.outcome}`].filter(Boolean) });
            }
        }
    }
    if (want('first_aid')) {
        const rows = await q(`SELECT * FROM "medicalfirstaids" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL${inRange('"at"')} ORDER BY "at" DESC`, P);
        for (const f of rows) {
            push({ id: `fa:${f._id}`, kind: 'first_aid', at: f.at, ref: { kind: 'first_aid', id: f._id }, title: `First aid — ${f.reason}`, status: { key: 'given', label: 'First aid', tone: 'violet' }, lines: [f.injury && `Injury: ${f.injury}`, f.treatment, (f.supplies || []).length && `Used: ${f.supplies.map((s) => `${s.quantity} ${s.unit || ''} ${s.name}`.replace(/\s+/g, ' ')).join(', ')}`].filter(Boolean), by: f.givenByName });
        }
    }
    if (want('medicine')) {
        const rows = await q(`SELECT * FROM "medicationdoses" WHERE "school" = $1 AND "student" = $2 AND "status" IN ('given','refused','missed')${inRange('COALESCE("givenAt","scheduledFor")')} ORDER BY COALESCE("givenAt","scheduledFor") DESC`, P);
        for (const d of rows) {
            push({ id: `dose:${d._id}`, kind: 'medicine', at: d.givenAt || d.scheduledFor, ref: { kind: 'dose', id: d._id }, title: `${d.medicineName} — ${d.dosage}`, status: { key: d.status, ...R.DOSE_STATUS[d.status] }, lines: [d.note].filter(Boolean), by: d.givenByName });
        }
    }
    if (want('checkup')) {
        const rows = await q(`SELECT * FROM "medicalcheckups" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND "status" = 'completed'${dayRange('"checkedOn"')} ORDER BY "checkedOn" DESC`, P);
        for (const c of rows) {
            const r = c.results || {};
            push({
                id: `checkup:${c._id}`, kind: 'checkup', at: c.checkedOn, day: true, ref: { kind: 'checkup', id: c._id },
                title: `${R.CHECKUP_TYPE[c.type]} checkup${c.sessionName ? ` — ${c.sessionName}` : ''}`,
                status: c.outcome ? { key: c.outcome, ...R.CHECKUP_OUTCOME[c.outcome] } : { key: 'completed', label: 'Completed', tone: 'green' },
                lines: [
                    [r.heightCm && `Height ${r.heightCm} cm`, r.weightKg && `Weight ${r.weightKg} kg`, r.bmi && `BMI ${r.bmi}`, (r.bpSystolic && r.bpDiastolic) && `BP ${r.bpSystolic}/${r.bpDiastolic}`, (r.visionLeft || r.visionRight) && `Vision L ${r.visionLeft || '—'} · R ${r.visionRight || '—'}`].filter(Boolean).join(' · '),
                    c.findings, c.recommendations && `Recommendation: ${c.recommendations}`,
                ].filter(Boolean),
                by: c.professional,
            });
        }
    }
    if (want('vaccination')) {
        const rows = await q(`SELECT * FROM "medicalvaccinations" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND "givenOn" IS NOT NULL${dayRange('"givenOn"')} ORDER BY "givenOn" DESC`, P);
        for (const v of rows) {
            push({ id: `vac:${v._id}`, kind: 'vaccination', at: v.givenOn, day: true, ref: { kind: 'vaccination', id: v._id }, title: `Vaccination — ${v.vaccine}${v.dose ? ` (${v.dose})` : ''}`, status: { key: 'completed', ...R.VACCINATION_STATUS.completed }, lines: [v.provider && `At ${v.provider}`, v.nextDueOn && `Next dose due ${dayLabel(v.nextDueOn)}`].filter(Boolean), by: v.doctor });
        }
    }
    if (want('document')) {
        const vis = audience === 'family' ? ` AND "visibility" = 'family'` : '';
        const rows = await q(`SELECT * FROM "medicaldocuments" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL${vis}${inRange('"createdAt"')} ORDER BY "createdAt" DESC`, P);
        for (const d of rows) {
            push({ id: `doc:${d._id}`, kind: 'document', at: d.createdAt, ref: { kind: 'document', id: d._id }, title: `${R.DOC_TYPE[d.type]} — ${d.title}`, status: { key: d.status, label: d.status === 'pending' ? 'Waiting for review' : d.status === 'rejected' ? 'Not accepted' : 'On file', tone: d.status === 'pending' ? 'amber' : d.status === 'rejected' ? 'red' : 'slate' }, lines: [d.remarks].filter(Boolean), by: d.uploadedByName });
        }
    }
    if (want('record')) {
        const [al, co] = await Promise.all([
            q(`SELECT * FROM "medicalallergies" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL${inRange('"createdAt"')}`, P),
            q(`SELECT * FROM "medicalconditions" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL${inRange('"createdAt"')}`, P),
        ]);
        for (const a of al) push({ id: `al:${a._id}`, kind: 'record', at: a.createdAt, ref: { kind: 'allergy', id: a._id }, title: `Allergy recorded — ${a.allergen}`, status: { key: a.severity, ...R.ALLERGY_SEVERITY[a.severity] }, lines: [a.reaction].filter(Boolean) });
        for (const c of co) push({ id: `co:${c._id}`, kind: 'record', at: c.createdAt, ref: { kind: 'condition', id: c._id }, title: `Condition recorded — ${c.condition}`, status: { key: c.severity, ...R.CONDITION_SEVERITY[c.severity] }, lines: [c.treatment].filter(Boolean) });
    }
    if (want('hostel')) {
        // Medical events recorded by the hostel (a resident taken ill at night)
        // belong to the same child's history. Read-only here.
        try {
            const rows = await q(`SELECT * FROM "hostelincidents" WHERE "school" = $1 AND "student" = $2 AND "incidentType" = 'medical_emergency'${inRange('"date"')} ORDER BY "date" DESC`, P);
            for (const h of rows) {
                push({ id: `hostel:${h._id}`, kind: 'hostel', at: h.date, ref: { kind: 'hostel', id: h._id }, title: `Hostel — ${h.title || 'Medical incident'}`, status: { key: h.severity, label: h.severity === 'critical' ? 'Critical' : h.severity === 'high' ? 'Serious' : h.severity === 'medium' ? 'Moderate' : 'Minor', tone: h.severity === 'critical' ? 'red' : h.severity === 'high' ? 'orange' : h.severity === 'medium' ? 'amber' : 'green' }, lines: [h.description, h.treatmentGiven && `Treatment: ${h.treatmentGiven}`, h.hospitalName && `Hospital: ${h.hospitalName}`].filter(Boolean), by: h.reportedByName });
            }
        } catch { /* a school without the hostel tables */ }
    }

    let list = items.filter((it) => it.at);
    if (opts.status) list = list.filter((it) => it.status?.key === opts.status);
    list.sort((a, b) => new Date(b.at) - new Date(a.at));
    const limit = Math.min(100, Math.max(5, Number(opts.limit) || 30));
    const page = Math.max(1, Number(opts.page) || 1);
    const counts = {};
    for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
    return {
        items: list.slice((page - 1) * limit, page * limit),
        total: list.length, page, limit, pages: Math.max(1, Math.ceil(list.length / limit)),
        counts, range: { from, to, year: yr?.name || '' },
    };
}

const FOLLOW_STATUS = {
    upcoming: { label: 'Upcoming', tone: 'indigo' },
    due: { label: 'Due today', tone: 'amber' },
    overdue: { label: 'Overdue', tone: 'red' },
    done: { label: 'Done', tone: 'green' },
    cancelled: { label: 'Cancelled', tone: 'gray' },
};

module.exports = { contactsOf, withAlternate, healthRows, staffRecord, emergencyProfile, teacherAlerts, familyRecord, history, yearRange, FOLLOW_STATUS, HISTORY_KINDS, str };
