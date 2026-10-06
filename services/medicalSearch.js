'use strict';
/**
 * One search box for the whole Medical Room (Oct 2026) — medical staff only.
 *
 * "Aarav", "APS2016001", "8 B", "asthma", "peanut", "O-", "paracetamol",
 * "MI-2610-0003": each kind of record is asked in turn, and the answers come
 * back grouped, so a nurse can type what they know and land on the record.
 */
const pool = require('../db/pool');
const access = require('./medicalAccess');
const { STUDENT_SELECT, STUDENT_JOIN, withClass } = require('./medicalBoard');
const R = require('./medicalRules');

const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const PER = 8;

/** "O+", "o positive", "B -ve", "AB neg" → the blood group, or null. */
function bloodOf(term) {
    const t = String(term).toUpperCase().replace(/\s+/g, '')
        .replace(/POSITIVE|POS|\+VE|VE\+/, '+').replace(/NEGATIVE|NEG|-VE|VE-/, '-');
    return R.BLOOD_GROUPS.includes(t) ? t : null;
}

async function search(req, q) {
    const term = String(q || '').trim().slice(0, 80);
    if (term.length < 2) return { term, groups: [], total: 0 };
    const S = String(req.schoolId);
    const pat = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const blood = bloodOf(term);

    const [students, byBlood, conditions, allergies, medicines, incidents, visits, requests] = await Promise.all([
        access.searchStudents(req.schoolId, term, { limit: PER }),
        blood ? run(`SELECT u."_id"::text AS "_id", u."name", u."profileImage" AS photo, sp."admissionNumber", c."className", cs."sectionName", sp."bloodGroup"
                   FROM "users" u JOIN "studentprofiles" sp ON sp."user" = u."_id"
                   LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection" LEFT JOIN "classes" c ON c."_id" = COALESCE(cs."class", sp."currentClass")
                  WHERE u."school" = $1 AND u."role" = 'student' AND u."isActive" IS NOT FALSE AND upper(sp."bloodGroup") = $2
                  ORDER BY u."name" LIMIT 40`, [S, blood]) : [],
        run(`SELECT mc."_id", mc."condition", mc."type", mc."severity", mc."status", mc."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalconditions" mc ${STUDENT_JOIN('mc."student"')}
              WHERE mc."school" = $1 AND mc."archivedAt" IS NULL AND u."isActive" IS NOT FALSE AND (mc."condition" ILIKE $2 OR mc."type" ILIKE $2)
              ORDER BY u."name" LIMIT ${PER}`, [S, pat]),
        run(`SELECT a."_id", a."allergen", a."category", a."severity", a."status", a."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalallergies" a ${STUDENT_JOIN('a."student"')}
              WHERE a."school" = $1 AND a."archivedAt" IS NULL AND u."isActive" IS NOT FALSE AND (a."allergen" ILIKE $2 OR a."category" ILIKE $2)
              ORDER BY u."name" LIMIT ${PER}`, [S, pat]),
        run(`SELECT "_id", "name", "genericName", "strength", "kind", "stock", "unit", "category", "isActive"
               FROM "medicalitems" WHERE "school" = $1 AND ("name" ILIKE $2 OR "genericName" ILIKE $2 OR "category" ILIKE $2)
              ORDER BY "isActive" DESC, "name" LIMIT ${PER}`, [S, pat]),
        run(`SELECT i."_id", i."number", i."type", i."severity", i."status", i."occurredAt", i."location", i."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalincidents" i ${STUDENT_JOIN('i."student"')}
              WHERE i."school" = $1 AND i."archivedAt" IS NULL AND (i."number" ILIKE $2 OR i."description" ILIKE $2 OR i."location" ILIKE $2 OR u."name" ILIKE $2)
              ORDER BY i."occurredAt" DESC LIMIT ${PER}`, [S, pat]),
        run(`SELECT v."_id", v."number", v."reason", v."status", v."arrivedAt", v."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')}
              WHERE v."school" = $1 AND v."archivedAt" IS NULL AND (v."number" ILIKE $2 OR v."reason" ILIKE $2 OR v."symptoms" ILIKE $2)
              ORDER BY v."arrivedAt" DESC LIMIT ${PER}`, [S, pat]),
        run(`SELECT r."_id", r."number", r."reason", r."status", r."createdAt", r."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalrequests" r ${STUDENT_JOIN('r."student"')}
              WHERE r."school" = $1 AND r."number" ILIKE $2 ORDER BY r."createdAt" DESC LIMIT ${PER}`, [S, pat]),
    ]);

    const groups = [
        { key: 'students', label: 'Students', items: students.map((s) => ({ id: s._id, kind: 'student', title: s.name, sub: [s.classLabel, s.admissionNumber].filter(Boolean).join(' · '), photo: s.photo, student: s._id })) },
        { key: 'blood', label: blood ? `Blood group ${blood}` : 'Blood group', items: byBlood.map((s) => ({ id: s._id, kind: 'student', title: s.name, sub: [[s.className, s.sectionName].filter(Boolean).join(' – '), s.admissionNumber].filter(Boolean).join(' · '), photo: s.photo, student: s._id, badge: { label: s.bloodGroup, tone: 'red' } })) },
        { key: 'conditions', label: 'Medical conditions', items: conditions.map((c) => ({ id: c._id, kind: 'condition', title: `${c.condition} — ${c.studentName}`, sub: withClass(c).classLabel, student: c.student, badge: { label: R.CONDITION_SEVERITY[c.severity].label, tone: R.CONDITION_SEVERITY[c.severity].tone } })) },
        { key: 'allergies', label: 'Allergies', items: allergies.map((a) => ({ id: a._id, kind: 'allergy', title: `${a.allergen} — ${a.studentName}`, sub: withClass(a).classLabel, student: a.student, badge: { label: R.ALLERGY_SEVERITY[a.severity].label, tone: R.ALLERGY_SEVERITY[a.severity].tone } })) },
        { key: 'medicines', label: 'Medicines & supplies', items: medicines.map((m) => ({ id: m._id, kind: m.kind, title: `${m.name}${m.strength ? ` ${m.strength}` : ''}`, sub: [m.genericName, m.category, `${m.stock} ${m.unit} on hand`].filter(Boolean).join(' · '), badge: m.isActive ? null : { label: 'Archived', tone: 'gray' } })) },
        { key: 'incidents', label: 'Incidents', items: incidents.map((i) => ({ id: i._id, kind: 'incident', title: `${i.number} · ${R.INCIDENT_TYPE[i.type]} — ${i.studentName}`, sub: [i.location, R.instantLabel(i.occurredAt)].filter(Boolean).join(' · '), student: i.student, badge: { label: R.INCIDENT_SEVERITY[i.severity].label, tone: R.INCIDENT_SEVERITY[i.severity].tone } })) },
        { key: 'visits', label: 'Visits', items: visits.map((v) => ({ id: v._id, kind: 'visit', title: `${v.number} · ${v.reason} — ${v.studentName}`, sub: R.instantLabel(v.arrivedAt), student: v.student, badge: { label: R.VISIT_STATUS[v.status].label, tone: R.VISIT_STATUS[v.status].tone } })) },
        { key: 'requests', label: 'Requests', items: requests.map((r) => ({ id: r._id, kind: 'request', title: `${r.number} · ${r.reason} — ${r.studentName}`, sub: R.instantLabel(r.createdAt), student: r.student, badge: { label: R.REQUEST_STATUS[r.status].label, tone: R.REQUEST_STATUS[r.status].tone } })) },
    ].filter((g) => g.items.length);
    return { term, groups, total: groups.reduce((n, g) => n + g.items.length, 0) };
}

module.exports = { search };
