'use strict';
/**
 * The Medical Room's printed documents (Oct 2026) — what each one gathers
 * before services/medicalPdf draws it:
 *
 *   incident     one medical incident, for the file or the principal
 *   handover     a child leaving for hospital: identity, allergies,
 *                conditions, today's readings and medicines, the care plan,
 *                who to call — on one page for the doctor
 *   annual       the year's health card, one page per student (a family's own
 *                child, or a whole section for the office to hand out)
 *   cardSet      emergency cards for a class, a bus route or a trip's chosen
 *                students — the teacher in charge carries them
 *
 * Every print is in the medical audit: who, what and how many.
 */
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const access = require('./medicalAccess');
const audit = require('./medicalAudit');
const read = require('./medicalRead');
const settingsSvc = require('./medicalSettings');
const pdf = require('./medicalPdf');
const R = require('./medicalRules');

const { refuse, isUuid, todayStr, dayStr } = R;
const S = (v) => String(v);
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const MAX_SET = 200;
const DOCS_DIR = path.join(__dirname, '..', 'uploads', 'student-docs');

const schoolOf = async (schoolId) => (await q(`SELECT "name", "logo" FROM "schools" WHERE "_id" = $1`, [S(schoolId)]))[0] || null;

/** A student's photo on disk (the student-docs folder only), for a printed card. */
function photoPath(p) {
    const m = String(p || '').match(/^\/uploads\/student-docs\/([^/\\]+)$/);
    if (!m) return null;
    const file = path.join(DOCS_DIR, m[1]);
    return file.startsWith(DOCS_DIR) && fs.existsSync(file) ? file : null;
}

async function incident(req, res, id) {
    const i = await require('./medicalCase').findIncident(req, id);
    const card = await access.studentCard(req.schoolId, i.student);
    const e = await read.emergencyProfile(req.schoolId, i.student);
    audit.log(req, { action: 'printed', entity: 'incident', entityId: id, student: i.student, summary: `Incident report ${i.number} printed` });
    await pdf.incidentReport(res, {
        school: await schoolOf(req.schoolId), incident: i, student: card, by: req.user?.name || '',
        typeLabel: R.labelOf(R.INCIDENT_TYPE, i.type), statusLabel: R.labelOf(R.INCIDENT_STATUS, i.status),
        alerts: (e.alerts || []).filter((a) => a.level === 'critical').map((a) => a.label).slice(0, 4),
    });
}

async function handover(req, res, visitId) {
    const v = await require('./medicalCase').findVisit(req, visitId);
    const card = await read.emergencyProfile(req.schoolId, v.student);
    const doses = await q(
        `SELECT "medicineName", "dosage", "givenAt", "givenByName" FROM "medicationdoses"
          WHERE "school" = $1 AND "student" = $2 AND "status" = 'given' AND ("givenAt" AT TIME ZONE '${R.ZONE}')::date = $3::date ORDER BY "givenAt"`,
        [S(req.schoolId), S(v.student), todayStr()]);
    const s = await settingsSvc.get(req.schoolId);
    audit.log(req, { action: 'printed', entity: 'visit', entityId: visitId, student: v.student, summary: `Hospital handover printed for ${v.number}` });
    await pdf.handover(res, { school: await schoolOf(req.schoolId), visit: v, card, doses, by: req.user?.name || '', room: { name: s.roomName, phone: s.roomPhone } });
}

/** The academic year asked for, or the one running today. */
async function yearOf(schoolId, yearId) {
    if (isUuid(yearId)) { const y = await read.yearRange(schoolId, yearId); if (y) return y; }
    const today = todayStr();
    const [y] = await q(`SELECT "startDate","endDate","yearName" FROM "academicyears" WHERE "school" = $1
        ORDER BY ("startDate" AT TIME ZONE 'UTC')::date <= $2::date AND ("endDate" AT TIME ZONE 'UTC')::date >= $2::date DESC, "startDate" DESC LIMIT 1`, [S(schoolId), today]);
    return y ? { from: dayStr(y.startDate), to: dayStr(y.endDate), name: y.yearName } : { from: R.addDays(today, -365), to: today, name: '' };
}

const CHECKUP_LINE = (r = {}) => [
    r.heightCm && `${r.heightCm} cm`, r.weightKg && `${r.weightKg} kg`, r.visionLeft || r.visionRight ? `vision L ${r.visionLeft || '—'} R ${r.visionRight || '—'}` : '',
    r.hearingLeft || r.hearingRight ? `hearing L ${r.hearingLeft || '—'} R ${r.hearingRight || '—'}` : '', r.dental ? `dental: ${r.dental}` : '',
    r.bpSystolic ? `BP ${r.bpSystolic}/${r.bpDiastolic || '—'}` : '',
].filter(Boolean).join(' · ');

async function annualCardOf(schoolId, card, year, settings) {
    const sid = S(card._id);
    const p = [S(schoolId), sid, year.from, year.to];
    const inYear = (col) => `(${col} AT TIME ZONE 'UTC')::date BETWEEN $3::date AND $4::date`;
    const [checkups, vaccinations, counts, health, referrals, campaigns, growth, schedule, blood] = await Promise.all([
        q(`SELECT "type","checkedOn","results","outcome","findings" FROM "medicalcheckups" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND "status" = 'completed' AND ${inYear('"checkedOn"')} ORDER BY "checkedOn"`, p),
        q(`SELECT "vaccine","dose","givenOn" FROM "medicalvaccinations" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND "givenOn" IS NOT NULL AND ${inYear('"givenOn"')} ORDER BY "givenOn"`, p),
        q(`SELECT (SELECT count(*)::int FROM "medicalvisits" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND ("arrivedAt" AT TIME ZONE '${R.ZONE}')::date BETWEEN $3::date AND $4::date) AS visits,
                  (SELECT count(*)::int FROM "medicalvisits" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND "status" IN ('sent_home') AND ("arrivedAt" AT TIME ZONE '${R.ZONE}')::date BETWEEN $3::date AND $4::date) AS "sentHome",
                  (SELECT count(*)::int FROM "medicalincidents" WHERE "school" = $1 AND "student" = $2 AND "archivedAt" IS NULL AND ("occurredAt" AT TIME ZONE '${R.ZONE}')::date BETWEEN $3::date AND $4::date) AS incidents`, p),
        read.healthRows(schoolId, sid),
        q(`SELECT * FROM "medicalreferrals" WHERE "school" = $1 AND "student" = $2 AND "status" <> 'cancelled' AND ("createdAt" AT TIME ZONE '${R.ZONE}')::date BETWEEN $3::date AND $4::date ORDER BY "createdAt"`, p),
        q(`SELECT c."title", c."startOn", c."kind", e."outcome" FROM "medicalcampaignentries" e JOIN "medicalcampaigns" c ON c."_id" = e."campaign"
            WHERE e."student" = $2 AND c."school" = $1 AND c."status" IN ('announced','closed') AND ${inYear('c."startOn"')} ORDER BY c."startOn"`, p),
        require('./medicalGrowth').forStudent(schoolId, card),
        require('./medicalSchedule').forStudent(schoolId, card, settings),
        q(`SELECT "bloodGroup" FROM "studentprofiles" WHERE "user" = $1`, [sid]),
    ]);
    const live = (r) => !r.archivedAt && r.status !== 'resolved';
    const refs = require('./medicalReferrals');
    const camp = require('./medicalCampaigns');
    const latest = growth.latest && growth.latest.on >= year.from && growth.latest.on <= year.to ? growth.latest : null;
    return {
        student: card, bloodGroup: blood[0]?.bloodGroup || '',
        growth: latest ? { latest } : null,
        checkups: checkups.map((k) => ({ ...k, typeLabel: R.labelOf(R.CHECKUP_TYPE, k.type), line: CHECKUP_LINE(k.results), outcomeLabel: k.outcome ? R.labelOf(R.CHECKUP_OUTCOME, k.outcome) : '' })),
        vaccinations,
        scheduleDue: (schedule.entries || []).filter((e) => ['due', 'overdue'].includes(e.status)),
        allergies: health.allergies.filter(live), conditions: health.conditions.filter(live),
        ...counts[0],
        referrals: referrals.map((r) => refs.decorate(r)),
        campaigns: campaigns.map((c) => ({ ...c, outcomeLabel: c.outcome ? (c.outcome === 'given' ? (camp.KIND[c.kind]?.done || 'Given') : camp.OUTCOME[c.outcome]?.label) : '' })),
    };
}

/** Annual health cards: one student (staff or their family), or a section (staff). */
async function annual(req, res, { studentIds, yearId, label }) {
    const ids = [...new Set(studentIds.map(S))].slice(0, MAX_SET);
    if (!ids.length) refuse('Nobody to print');
    const year = await yearOf(req.schoolId, yearId);
    const s = await settingsSvc.get(req.schoolId);
    const cards = await access.studentCards(req.schoolId, ids);
    const list = [];
    for (const id of ids) { const c = cards.get(id); if (c) list.push(await annualCardOf(req.schoolId, c, year, s)); }
    list.sort((a, b) => String(a.student.classLabel).localeCompare(String(b.student.classLabel)) || String(a.student.name).localeCompare(String(b.student.name)));
    audit.log(req, { action: 'printed', entity: 'annual_card', student: list.length === 1 ? list[0].student._id : null, summary: `Annual health card${list.length === 1 ? ` of ${list[0].student.name}` : `s for ${list.length} students (${label || 'a list'})`} printed — ${year.name}` });
    await pdf.annualCards(res, { school: await schoolOf(req.schoolId), year, cards: list, by: req.user?.name || '', label });
}

/** The students of a section, of a bus route, or a hand-picked list — current students only. */
async function studentsFor(schoolId, body) {
    if (isUuid(body.sectionId)) {
        const rows = await q(`SELECT u."_id"::text AS id FROM "users" u JOIN "studentprofiles" sp ON sp."user" = u."_id"
            WHERE u."school" = $1 AND u."role" = 'student' AND u."isActive" IS NOT FALSE AND sp."currentSection" = $2 ORDER BY u."name"`, [S(schoolId), body.sectionId]);
        const [sec] = await q(`SELECT c."className", cs."sectionName" FROM "classsections" cs LEFT JOIN "classes" c ON c."_id" = cs."class" WHERE cs."_id" = $1 AND cs."school" = $2`, [body.sectionId, S(schoolId)]);
        if (!sec) refuse('Section not found', 404, 'MEDICAL_NOT_FOUND');
        return { ids: rows.map((r) => r.id), label: [sec.className, sec.sectionName].filter(Boolean).join(' – ') };
    }
    if (isUuid(body.routeId)) {
        const [route] = await q(`SELECT "name" FROM "transportroutes" WHERE "_id" = $1 AND "school" = $2`, [body.routeId, S(schoolId)]);
        if (!route) refuse('Route not found', 404, 'MEDICAL_NOT_FOUND');
        const rows = await q(`SELECT ta."student"::text AS id FROM "transportassignments" ta JOIN "users" u ON u."_id" = ta."student" AND u."role" = 'student' AND u."isActive" IS NOT FALSE
            WHERE ta."school" = $1 AND ta."route" = $2 AND ta."status" = 'active' AND COALESCE(ta."personType", 'student') = 'student' ORDER BY u."name"`, [S(schoolId), body.routeId]);
        return { ids: rows.map((r) => r.id), label: `Bus route ${route.name}` };
    }
    const ids = (Array.isArray(body.students) ? body.students : []).map(S).filter(isUuid);
    if (!ids.length) refuse('Choose a class, a bus route or the students');
    if (ids.length > MAX_SET) refuse(`Print at most ${MAX_SET} cards at a time`);
    return { ids, label: R.str(body.title, 80) || 'Chosen students' };
}

async function cardSet(req, res, body = {}) {
    const { ids, label } = await studentsFor(req.schoolId, body);
    if (!ids.length) refuse('Nobody to print — no current students there');
    const cards = [];
    for (const id of ids.slice(0, MAX_SET)) { try { cards.push(await read.emergencyProfile(req.schoolId, id)); } catch { /* left */ } }
    const s = await settingsSvc.get(req.schoolId);
    const title = R.str(body.title, 120) || `Emergency cards — ${label}`;
    const purpose = R.str(body.purpose, 200);
    audit.log(req, { action: 'printed', entity: 'emergency_cards', summary: `Emergency cards printed for ${cards.length} students — ${title}${purpose ? ` (${purpose})` : ''}` });
    await pdf.emergencyCards(res, { school: await schoolOf(req.schoolId), title, cards, by: req.user?.name || '', photoPath, room: { name: s.roomName, phone: s.roomPhone } });
}

module.exports = { incident, handover, annual, cardSet, studentsFor, yearOf, annualCardOf, photoPath };

/**
 * Emergency cards to keep on the nurse's phone for when there is no network
 * (a trip, an outage): every current student with something to know — an
 * allergy, a condition, a care plan, a rescue medicine — compact, no photos.
 * The phone keeps them encrypted (the OS keystore) and deletes them when they
 * expire or the nurse signs out. Every download is in the audit.
 */
const OFFLINE_HOURS = 72;
async function offlineCards(req) {
    const rows = await q(`SELECT DISTINCT x.student::text AS id FROM (
            SELECT "student" FROM "medicalallergies" WHERE "school" = $1 AND "archivedAt" IS NULL AND COALESCE("status", 'active') <> 'resolved'
            UNION SELECT "student" FROM "medicalconditions" WHERE "school" = $1 AND "archivedAt" IS NULL AND COALESCE("status", 'active') <> 'resolved'
            UNION SELECT "student" FROM "medicalcareplans" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" = 'active'
            UNION SELECT "student" FROM "medicalrescuemeds" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" = 'active'
        ) x JOIN "users" u ON u."_id" = x.student AND u."isActive" IS NOT FALSE LIMIT 400`, [S(req.schoolId)]);
    const cards = [];
    for (let i = 0; i < rows.length; i += 20) {
        const part = await Promise.all(rows.slice(i, i + 20).map((r) => read.emergencyProfile(req.schoolId, r.id).catch(() => null)));
        for (const e of part.filter(Boolean)) {
            cards.push({
                student: { _id: e.student._id, name: e.student.name, classLabel: e.student.classLabel, dob: e.student.dob, admissionNumber: e.student.admissionNumber },
                bloodGroup: e.bloodGroup || '',
                allergies: (e.allergies || []).map((a) => ({ allergen: a.allergen, severity: a.severity, reaction: a.reaction, emergencyInstructions: a.emergencyInstructions, critical: a.critical })),
                conditions: (e.conditions || []).map((c) => ({ condition: c.condition, severity: c.severity, emergencyInstructions: c.emergencyInstructions, medication: c.medication, critical: c.critical })),
                carePlans: (e.carePlans || []).map((c) => ({ title: c.title, steps: (c.steps || []).map((x) => ({ text: x.text, critical: !!x.critical })), ambulanceWhen: c.ambulanceWhen })),
                rescueMeds: (e.rescueMeds || []).map((m) => ({ name: m.name, dose: m.dose, selfCarry: m.selfCarry, places: (m.locations || []).map((l) => l.place), expired: m.expired })),
                contacts: (e.contacts || []).filter((c) => c.phone).slice(0, 3).map((c) => ({ name: c.name, relation: c.relation, phone: c.phone })),
                doctor: e.doctor?.name ? { name: e.doctor.name, phone: e.doctor.phone } : null,
            });
        }
    }
    cards.sort((a, b) => String(a.student.classLabel).localeCompare(String(b.student.classLabel)) || a.student.name.localeCompare(b.student.name));
    const s = await settingsSvc.get(req.schoolId);
    await audit.log(req, { action: 'offline_saved', entity: 'emergency_cards', summary: `Emergency cards of ${cards.length} students saved on a phone for offline use (${OFFLINE_HOURS} h)` });
    return { generatedAt: new Date(), expiresAt: new Date(Date.now() + OFFLINE_HOURS * 3600000), hours: OFFLINE_HOURS, room: { name: s.roomName, phone: s.roomPhone }, count: cards.length, cards };
}
module.exports.offlineCards = offlineCards;
