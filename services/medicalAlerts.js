'use strict';
/**
 * The Medical Alerts screen (Oct 2026) — worked out live from the records,
 * never stored, so an alert disappears the moment its cause is dealt with.
 *
 *   critical  a severe allergy, a severe or critical condition, an emergency
 *             medication — the students staff must know on sight
 *   warning   medicine expiring or expired, low stock, vaccinations overdue,
 *             follow-ups due, medical documents expiring, maintenance due,
 *             parents' updates waiting
 *   info      the last week's completed checkups, vaccinations given, visits closed
 */
const pool = require('../db/pool');
const settingsSvc = require('./medicalSettings');
const { STUDENT_SELECT, STUDENT_JOIN, withClass } = require('./medicalBoard');
const R = require('./medicalRules');

const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const storedDay = (col) => `(${col} AT TIME ZONE 'UTC')::date`;
const localDay = (col) => `(${col} AT TIME ZONE '${R.ZONE}')::date`;
const LIMIT = 60;

async function alerts(req) {
    const S = String(req.schoolId);
    const s = await settingsSvc.get(req.schoolId);
    const today = R.todayStr();
    const [allergies, conditions, emergencyMeds, batches, low, vaccinations, followUps, docs, equipment, changes, checkups, vaccinesGiven, closed, rescue, carePlans, uncounted] = await Promise.all([
        run(`SELECT a."_id", a."allergen", a."severity", a."reaction", a."emergencyInstructions", a."medication", a."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalallergies" a ${STUDENT_JOIN('a."student"')}
              WHERE a."school" = $1 AND a."archivedAt" IS NULL AND a."status" <> 'resolved' AND a."severity" IN ('severe','life_threatening') AND u."isActive" IS NOT FALSE
              ORDER BY CASE a."severity" WHEN 'life_threatening' THEN 0 ELSE 1 END, u."name" LIMIT ${LIMIT}`, [S]),
        run(`SELECT mc."_id", mc."condition", mc."type", mc."severity", mc."emergencyInstructions", mc."medication", mc."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalconditions" mc ${STUDENT_JOIN('mc."student"')}
              WHERE mc."school" = $1 AND mc."archivedAt" IS NULL AND mc."status" <> 'resolved' AND mc."severity" IN ('severe','critical') AND u."isActive" IS NOT FALSE
              ORDER BY CASE mc."severity" WHEN 'critical' THEN 0 ELSE 1 END, u."name" LIMIT ${LIMIT}`, [S]),
        run(`SELECT mp."emergencyMedication", mp."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalprofiles" mp ${STUDENT_JOIN('mp."student"')}
              WHERE mp."school" = $1 AND (mp."emergencyMedication"->>'required')::boolean IS TRUE AND u."isActive" IS NOT FALSE
                AND NOT EXISTS (SELECT 1 FROM "medicalrescuemeds" r WHERE r."student" = mp."student" AND r."archivedAt" IS NULL AND r."status" = 'active')
              ORDER BY u."name" LIMIT ${LIMIT}`, [S]),
        run(`SELECT b."_id", b."batchNumber", b."quantity", b."expiryDate", i."name", i."strength", i."unit", i."_id"::text AS item,
                    (${storedDay('b."expiryDate"')} - $2::date)::int AS "daysLeft", l."name" AS "placeName"
               FROM "medicalbatches" b JOIN "medicalitems" i ON i."_id" = b."item" LEFT JOIN "medicallocations" l ON l."_id" = b."location"
              WHERE b."school" = $1 AND b."status" = 'active' AND b."quantity" > 0 AND b."expiryDate" IS NOT NULL
                AND ${storedDay('b."expiryDate"')} <= $2::date + $3::int ORDER BY b."expiryDate" LIMIT ${LIMIT}`, [S, today, s.expiryAlertDays]),
        run(`SELECT i."_id", i."name", i."strength", i."unit", i."minStock", i."kind",
                    COALESCE((SELECT SUM(b."quantity") FROM "medicalbatches" b WHERE b."item" = i."_id" AND b."status" = 'active'
                        AND (b."expiryDate" IS NULL OR ${storedDay('b."expiryDate"')} >= $2::date)), 0)::float8 AS usable
               FROM "medicalitems" i WHERE i."school" = $1 AND i."isActive" IS NOT FALSE AND i."minStock" > 0`, [S, today]),
        run(`SELECT v."_id", v."vaccine", v."dose", v."dueOn", v."student"::text AS student, (${storedDay('v."dueOn"')} - $2::date)::int AS "daysLeft", ${STUDENT_SELECT}
               FROM "medicalvaccinations" v ${STUDENT_JOIN('v."student"')}
              WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."givenOn" IS NULL AND v."dueOn" IS NOT NULL AND u."isActive" IS NOT FALSE
                AND ${storedDay('v."dueOn"')} <= $2::date + $3::int ORDER BY v."dueOn" LIMIT ${LIMIT}`, [S, today, s.vaccinationDueDays]),
        run(`SELECT * FROM (
               SELECT 'visit' AS kind, v."_id", v."number", v."reason" AS what, v."followUp", v."student"::text AS student, ${STUDENT_SELECT}
                 FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')} WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."followUp"->>'status' = 'pending'
               UNION ALL
               SELECT 'incident', i."_id", i."number", i."description", i."followUp", i."student"::text, ${STUDENT_SELECT}
                 FROM "medicalincidents" i ${STUDENT_JOIN('i."student"')} WHERE i."school" = $1 AND i."archivedAt" IS NULL AND i."followUp"->>'status' = 'pending'
               UNION ALL
               SELECT 'checkup', k."_id", '', k."type", k."followUp", k."student"::text, ${STUDENT_SELECT}
                 FROM "medicalcheckups" k ${STUDENT_JOIN('k."student"')} WHERE k."school" = $1 AND k."archivedAt" IS NULL AND k."followUp"->>'status' = 'pending'
             ) f ORDER BY (f."followUp"->>'on') NULLS FIRST LIMIT ${LIMIT}`, [S]),
        run(`SELECT d."_id", d."title", d."type", d."expiresOn", d."student"::text AS student, (${storedDay('d."expiresOn"')} - $2::date)::int AS "daysLeft", ${STUDENT_SELECT}
               FROM "medicaldocuments" d ${STUDENT_JOIN('d."student"')}
              WHERE d."school" = $1 AND d."archivedAt" IS NULL AND d."expiresOn" IS NOT NULL AND u."isActive" IS NOT FALSE
                AND ${storedDay('d."expiresOn"')} <= $2::date + $3::int ORDER BY d."expiresOn" LIMIT ${LIMIT}`, [S, today, s.documentExpiryDays]),
        run(`SELECT "_id", "name", "serialNumber", "nextMaintenanceOn", (${storedDay('"nextMaintenanceOn"')} - $2::date)::int AS "daysLeft"
               FROM "medicalequipments" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" <> 'retired' AND "nextMaintenanceOn" IS NOT NULL
                AND ${storedDay('"nextMaintenanceOn"')} <= $2::date + $3::int ORDER BY "nextMaintenanceOn" LIMIT ${LIMIT}`, [S, today, s.maintenanceDueDays]),
        run(`SELECT count(*)::int AS n FROM "medicalchangerequests" WHERE "school" = $1 AND "status" = 'pending'`, [S]),
        run(`SELECT k."_id", k."type", k."checkedOn", k."outcome", k."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalcheckups" k ${STUDENT_JOIN('k."student"')}
              WHERE k."school" = $1 AND k."archivedAt" IS NULL AND k."status" = 'completed' AND ${storedDay('k."checkedOn"')} >= $2::date - 7
              ORDER BY k."checkedOn" DESC LIMIT ${LIMIT}`, [S, today]),
        run(`SELECT v."_id", v."vaccine", v."dose", v."givenOn", v."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalvaccinations" v ${STUDENT_JOIN('v."student"')}
              WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."givenOn" IS NOT NULL AND ${storedDay('v."givenOn"')} >= $2::date - 7
              ORDER BY v."givenOn" DESC LIMIT ${LIMIT}`, [S, today]),
        run(`SELECT v."_id", v."number", v."reason", v."closedAt", v."student"::text AS student, ${STUDENT_SELECT}
               FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')}
              WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."status" = 'closed' AND v."closedAt" >= now() - interval '7 days'
              ORDER BY v."closedAt" DESC LIMIT ${LIMIT}`, [S]),
        // Rescue medicines and care plans in force (services/medicalCare).
        run(`SELECT r."_id", r."name", r."locations", r."selfCarry", r."expiresOn", r."student"::text AS student,
                    (${storedDay('r."expiresOn"')} - $2::date)::int AS "daysLeft", ${STUDENT_SELECT}
               FROM "medicalrescuemeds" r ${STUDENT_JOIN('r."student"')}
              WHERE r."school" = $1 AND r."archivedAt" IS NULL AND r."status" = 'active' AND u."isActive" IS NOT FALSE
              ORDER BY u."name" LIMIT ${LIMIT}`, [S, today]),
        run(`SELECT p."_id", p."title", p."steps", p."parentConfirmedAt", p."createdAt", p."reviewDue", p."student"::text AS student,
                    (${storedDay('p."reviewDue"')} - $2::date)::int AS "reviewIn", ${STUDENT_SELECT}
               FROM "medicalcareplans" p ${STUDENT_JOIN('p."student"')}
              WHERE p."school" = $1 AND p."archivedAt" IS NULL AND p."status" = 'active' AND u."isActive" IS NOT FALSE
              ORDER BY u."name" LIMIT ${LIMIT}`, [S, today]),
        // Controlled medicines not counted in the last 7 days.
        run(`SELECT i."_id"::text AS "_id", i."name", i."strength", i."stock", i."unit", (SELECT max(c."at") FROM "medicalstockcounts" c WHERE c."item" = i."_id") AS "lastCount"
               FROM "medicalitems" i
              WHERE i."school" = $1 AND i."isActive" IS NOT FALSE AND i."controlled" = true
                AND NOT EXISTS (SELECT 1 FROM "medicalstockcounts" c WHERE c."item" = i."_id" AND c."at" > now() - interval '7 days')
              ORDER BY i."name" LIMIT ${LIMIT}`, [S]),
    ]);
    const PLACE = { bag: 'school bag', medical_room: 'Medical Room', classroom: 'classroom', bus: 'school bus', staff_room: 'staff room', hostel: 'hostel', sports: 'sports room', other: 'other' };
    const placesOf = (r) => (r.locations || []).map((l) => PLACE[l.place] || l.place).join(', ');

    const critical = [
        ...allergies.map((a) => ({ id: `al:${a._id}`, kind: 'allergy', level: 'critical', title: `Severe allergy — ${a.allergen}`, severity: a.severity, detail: [a.reaction, a.emergencyInstructions && `If exposed: ${a.emergencyInstructions}`, a.medication && `Medication: ${a.medication}`].filter(Boolean).join(' · '), student: withClass(a) })),
        ...conditions.map((c) => ({ id: `co:${c._id}`, kind: 'condition', level: 'critical', title: `${R.CONDITION_SEVERITY[c.severity].label} — ${c.condition}`, severity: c.severity, detail: [c.emergencyInstructions && `In an emergency: ${c.emergencyInstructions}`, c.medication && `Medication: ${c.medication}`].filter(Boolean).join(' · '), student: withClass(c) })),
        ...emergencyMeds.map((m) => ({ id: `em:${m.student}`, kind: 'emergency_medication', level: 'critical', title: `Emergency medication — ${m.emergencyMedication?.name || ''}`.replace(/ — $/, ''), detail: [m.emergencyMedication?.location && `Kept: ${m.emergencyMedication.location}`, m.emergencyMedication?.instructions].filter(Boolean).join(' · '), student: withClass(m) })),
        ...rescue.map((r) => ({ id: `rm:${r._id}`, kind: 'rescue_med', level: 'critical', title: `Emergency medication — ${r.name}`, detail: [placesOf(r) && `Kept: ${placesOf(r)}`, r.selfCarry && 'carried by the student'].filter(Boolean).join(' · '), student: withClass(r) })),
        ...carePlans.map((p) => ({ id: `cp:${p._id}`, kind: 'care_plan', level: 'critical', title: `Care plan — ${p.title}`, detail: (p.steps || []).filter((x) => x.critical).map((x) => x.text).slice(0, 2).join(' → '), student: withClass(p) })),
    ];
    const lowItems = low.filter((i) => i.usable <= i.minStock);
    const warning = [
        ...batches.map((b) => ({ id: `bt:${b._id}`, kind: b.daysLeft < 0 ? 'expired' : 'expiring', level: b.daysLeft < 0 ? 'critical' : 'warning', title: `${b.daysLeft < 0 ? 'Expired' : 'Expiring'} — ${b.name}${b.strength ? ` ${b.strength}` : ''}`, detail: `${b.quantity} ${b.unit}${b.batchNumber ? ` · batch ${b.batchNumber}` : ''}${b.placeName ? ` · at ${b.placeName}` : ''} · ${b.daysLeft < 0 ? `expired ${R.dayLabel(b.expiryDate)}` : b.daysLeft === 0 ? 'expires today' : `expires in ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'}`}`, ref: { kind: 'item', id: b.item } })),
        ...lowItems.map((i) => ({ id: `ls:${i._id}`, kind: 'low_stock', level: i.usable <= 0 ? 'critical' : 'warning', title: `${i.usable <= 0 ? 'Out of stock' : 'Low stock'} — ${i.name}${i.strength ? ` ${i.strength}` : ''}`, detail: `${i.usable} ${i.unit} usable · minimum ${i.minStock}`, ref: { kind: 'item', id: String(i._id), itemKind: i.kind } })),
        ...vaccinations.filter((v) => v.daysLeft < 0).map((v) => ({ id: `vc:${v._id}`, kind: 'vaccination_overdue', level: 'warning', title: `Vaccination overdue — ${v.vaccine}${v.dose ? ` (${v.dose})` : ''}`, detail: `Was due ${R.dayLabel(v.dueOn)}`, student: withClass(v) })),
        ...followUps.map((f) => {
            const state = R.followUpState(f.followUp, today) || 'upcoming';
            return { id: `fu:${f.kind}:${f._id}`, kind: 'follow_up', level: state === 'overdue' || state === 'due' ? 'warning' : 'info', title: `Follow-up ${state === 'overdue' ? 'overdue' : state === 'due' ? 'due today' : 'coming up'}${f.number ? ` — ${f.number}` : ''}`, detail: [f.kind === 'checkup' ? `${R.CHECKUP_TYPE[f.what] || 'Checkup'} checkup` : f.what, f.followUp?.on && `on ${R.dayLabel(f.followUp.on)}`, f.followUp?.note].filter(Boolean).join(' · '), student: withClass(f), ref: { kind: f.kind, id: String(f._id) }, state };
        }),
        ...docs.map((d) => ({ id: `dc:${d._id}`, kind: 'document_expiring', level: 'warning', title: `Document ${d.daysLeft < 0 ? 'expired' : 'expiring'} — ${d.title}`, detail: `${R.DOC_TYPE[d.type] || 'Document'} · ${d.daysLeft < 0 ? 'expired' : 'expires'} ${R.dayLabel(d.expiresOn)}`, student: withClass(d), ref: { kind: 'document', id: String(d._id) } })),
        ...uncounted.map((i) => ({
            id: `ct:${i._id}`, kind: 'count_due', level: 'warning', title: `Count due — ${i.name}${i.strength ? ` ${i.strength}` : ''}`,
            detail: `A controlled medicine · ${i.lastCount ? `last counted ${R.instantLabel(i.lastCount)}` : 'never counted'} · record says ${i.stock} ${i.unit || ''}`, ref: { kind: 'item', id: i._id, itemKind: 'medicine' },
        })),
        ...equipment.map((e) => ({ id: `eq:${e._id}`, kind: 'maintenance', level: 'warning', title: `Maintenance ${e.daysLeft < 0 ? 'overdue' : 'due'} — ${e.name}`, detail: `${e.serialNumber ? `${e.serialNumber} · ` : ''}due ${R.dayLabel(e.nextMaintenanceOn)}`, ref: { kind: 'equipment', id: String(e._id) } })),
        ...rescue.filter((r) => r.expiresOn !== null && r.daysLeft !== null && r.daysLeft <= 30).map((r) => ({
            id: `rx:${r._id}`, kind: r.daysLeft < 0 ? 'rescue_expired' : 'rescue_expiring', level: r.daysLeft < 0 ? 'critical' : 'warning',
            title: `${r.daysLeft < 0 ? 'Rescue medicine expired' : 'Rescue medicine expiring'} — ${r.name}`,
            detail: `${r.daysLeft < 0 ? 'expired' : 'expires'} ${R.dayLabel(r.expiresOn)}${placesOf(r) ? ` · kept: ${placesOf(r)}` : ''}`, student: withClass(r),
        })),
        ...carePlans.filter((p) => p.reviewDue && p.reviewIn !== null && p.reviewIn < 0).map((p) => ({
            id: `cr:${p._id}`, kind: 'care_plan_review', level: 'warning', title: `Care plan past its review — ${p.title}`, detail: `was due ${R.dayLabel(p.reviewDue)}`, student: withClass(p),
        })),
        ...carePlans.filter((p) => !p.parentConfirmedAt && new Date(p.createdAt) < new Date(Date.now() - 7 * 86400000)).map((p) => ({
            id: `cc:${p._id}`, kind: 'care_plan_unconfirmed', level: 'warning', title: `Care plan not confirmed by a parent — ${p.title}`, detail: `written ${R.instantDayLabel(p.createdAt)}`, student: withClass(p),
        })),
        ...(changes[0]?.n ? [{ id: 'changes', kind: 'parent_updates', level: 'warning', title: `${changes[0].n} parent update${changes[0].n === 1 ? '' : 's'} waiting for review`, detail: 'Allergies, conditions, contacts and documents sent by parents' }] : []),
    ];
    const info = [
        ...checkups.map((k) => ({ id: `ck:${k._id}`, kind: 'checkup_completed', level: 'info', title: `${R.CHECKUP_TYPE[k.type]} checkup completed`, detail: [R.dayLabel(k.checkedOn), k.outcome && R.CHECKUP_OUTCOME[k.outcome]?.label].filter(Boolean).join(' · '), student: withClass(k), at: k.checkedOn })),
        ...vaccinesGiven.map((v) => ({ id: `vg:${v._id}`, kind: 'vaccination_completed', level: 'info', title: `Vaccination given — ${v.vaccine}${v.dose ? ` (${v.dose})` : ''}`, detail: R.dayLabel(v.givenOn), student: withClass(v), at: v.givenOn })),
        ...closed.map((v) => ({ id: `vl:${v._id}`, kind: 'visit_closed', level: 'info', title: `Medical visit closed — ${v.number}`, detail: v.reason, student: withClass(v), at: v.closedAt, ref: { kind: 'visit', id: String(v._id) } })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    return {
        critical, warning, info,
        counts: { critical: critical.length + warning.filter((w) => w.level === 'critical').length, warning: warning.filter((w) => w.level === 'warning').length, info: info.length },
    };
}

module.exports = { alerts, localDay };
