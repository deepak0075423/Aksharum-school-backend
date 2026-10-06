'use strict';
/**
 * The Medical Room's watchman (Oct 2026) — run from server.js every quarter
 * hour on the primary worker, and safe to run twice.
 *
 *   doses        today's scheduled doses are generated; ones never recorded
 *                are marked missed after the school's window
 *   stock        low stock, batches expiring soon, batches past their date
 *   equipment    maintenance falling due
 *   documents    medical documents about to expire
 *   vaccinations a family is told once when a dose falls due soon, and once
 *                when it becomes overdue
 *   digests      once a day, the staff hear how many follow-ups and
 *                vaccinations are waiting
 *   programmes   the outbreak watch; the vaccination schedule's reminders;
 *                referral reminders; a health campaign's day
 *
 * Every staff alert is announced ONCE: it is claimed in MedicalAlert behind a
 * unique (school, kind, subject) index before anyone is told, and the row is
 * deleted when the condition clears — so a problem that comes back is
 * announced again, and one that persists is not repeated every sweep.
 */
const pool = require('../db/pool');
const { newId } = require('../db/schema');
const settingsSvc = require('./medicalSettings');
const meds = require('./medicalMeds');
const tell = require('./medicalNotify');
const R = require('./medicalRules');

const run = (sql, p) => pool.query(sql, p).then((r) => r.rows);
const storedDay = (col) => `(${col} AT TIME ZONE 'UTC')::date`;
// Where the stock of an item is looked after: medicines on Medicines, first-aid supplies on Inventory.
const stockLink = (kind) => (kind === 'supply' ? 'medical.supplies' : 'medical.stock');

/** Claim an alert; true when this sweep is the first to see it. */
async function claim(school, kind, subject, level = 'warning', meta = {}) {
    const { rowCount } = await pool.query(
        `INSERT INTO "medicalalerts" ("_id","school","kind","subject","level","meta","notifiedAt")
         VALUES ($1,$2,$3,$4,$5,$6, now()) ON CONFLICT ("school","kind","subject") DO NOTHING`,
        [newId(), String(school), kind, String(subject), level, JSON.stringify(meta)],
    );
    return rowCount > 0;
}

/** Forget alerts of `kind` whose subject is no longer in `current`. */
async function clearOthers(school, kind, current) {
    await pool.query(
        `DELETE FROM "medicalalerts" WHERE "school" = $1 AND "kind" = $2 AND NOT ("subject" = ANY($3::text[]))`,
        [String(school), kind, [...current].map(String)],
    );
}

async function sweepStock(school, s, staff, today) {
    // Measured on what can be GIVEN: stock past its date is on the shelf but
    // cannot be used, so it does not hold an item above its minimum.
    const items = await run(
        `SELECT i."_id"::text AS id, i."name", i."strength", i."unit", i."minStock", i."kind",
                COALESCE((SELECT SUM(b."quantity") FROM "medicalbatches" b WHERE b."item" = i."_id" AND b."status" = 'active'
                    AND (b."expiryDate" IS NULL OR ${storedDay('b."expiryDate"')} >= $2::date)), 0)::float8 AS usable
           FROM "medicalitems" i WHERE i."school" = $1 AND i."isActive" IS NOT FALSE AND i."minStock" > 0`,
        [String(school), today],
    );
    const low = items.filter((i) => i.usable <= i.minStock);
    await clearOthers(school, 'low_stock', low.map((i) => i.id));
    for (const i of low) {
        if (!(await claim(school, 'low_stock', i.id, i.usable <= 0 ? 'critical' : 'warning', { usable: i.usable }))) continue;
        tell.system(school, {
            to: staff, setting: 'staffLowStock', link: { type: stockLink(i.kind), params: { tab: 'low' } },
            title: i.usable <= 0 ? `Out of stock: ${i.name}` : `Low stock: ${i.name}`,
            body: i.usable <= 0
                ? `${i.name}${i.strength ? ` ${i.strength}` : ''} has run out (minimum ${i.minStock} ${i.unit}). Receive new stock before it is needed.`
                : `${i.name}${i.strength ? ` ${i.strength}` : ''} is down to ${i.usable} ${i.unit} (minimum ${i.minStock}).`,
        });
    }

    const batches = await run(
        `SELECT b."_id"::text AS id, b."batchNumber", b."quantity", b."expiryDate", i."name", i."strength", i."unit", i."kind",
                (${storedDay('b."expiryDate"')} - $2::date)::int AS "daysLeft"
           FROM "medicalbatches" b JOIN "medicalitems" i ON i."_id" = b."item"
          WHERE b."school" = $1 AND b."status" = 'active' AND b."quantity" > 0 AND b."expiryDate" IS NOT NULL
            AND ${storedDay('b."expiryDate"')} <= $2::date + $3::int`,
        [String(school), today, s.expiryAlertDays],
    );
    const expired = batches.filter((b) => b.daysLeft < 0);
    const expiring = batches.filter((b) => b.daysLeft >= 0);
    await clearOthers(school, 'expired', expired.map((b) => b.id));
    await clearOthers(school, 'expiring', expiring.map((b) => b.id));
    for (const b of expired) {
        if (!(await claim(school, 'expired', b.id, 'critical'))) continue;
        tell.system(school, {
            to: staff, setting: 'staffExpiry', link: { type: stockLink(b.kind), params: { tab: 'expired' } }, priority: 'high',
            title: `Expired: ${b.name}${b.batchNumber ? ` (batch ${b.batchNumber})` : ''}`,
            body: `${b.quantity} ${b.unit} of ${b.name}${b.strength ? ` ${b.strength}` : ''} passed its expiry date on ${R.dayLabel(b.expiryDate)}. Take it off the shelf and write it off.`,
        });
    }
    for (const b of expiring) {
        if (!(await claim(school, 'expiring', b.id, 'warning'))) continue;
        tell.system(school, {
            to: staff, setting: 'staffExpiry', link: { type: stockLink(b.kind), params: { tab: 'expiring' } },
            title: `Expiring soon: ${b.name}`,
            body: `${b.quantity} ${b.unit} of ${b.name}${b.batchNumber ? ` (batch ${b.batchNumber})` : ''} expire${b.daysLeft === 0 ? 's today' : ` in ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'}`} (${R.dayLabel(b.expiryDate)}).`,
        });
    }
}

async function sweepEquipment(school, s, staff, today) {
    const due = await run(
        `SELECT "_id"::text AS id, "name", "serialNumber", "nextMaintenanceOn", (${storedDay('"nextMaintenanceOn"')} - $2::date)::int AS "daysLeft"
           FROM "medicalequipments" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" NOT IN ('retired')
            AND "nextMaintenanceOn" IS NOT NULL AND ${storedDay('"nextMaintenanceOn"')} <= $2::date + $3::int`,
        [String(school), today, s.maintenanceDueDays],
    );
    // The subject carries the due date, so the next service is announced in its turn.
    const keys = due.map((e) => `${e.id}:${R.dayStr(e.nextMaintenanceOn)}`);
    await clearOthers(school, 'maintenance', keys);
    for (const e of due) {
        if (!(await claim(school, 'maintenance', `${e.id}:${R.dayStr(e.nextMaintenanceOn)}`))) continue;
        tell.system(school, {
            to: staff, setting: 'staffMaintenance', link: { type: 'medical.equipment', params: { tab: 'due' } },
            title: `${e.daysLeft < 0 ? 'Maintenance overdue' : 'Maintenance due'}: ${e.name}`,
            body: `${e.name}${e.serialNumber ? ` (${e.serialNumber})` : ''} is due for maintenance on ${R.dayLabel(e.nextMaintenanceOn)}.`,
        });
    }
}

async function sweepDocuments(school, s, staff, today) {
    const docs = await run(
        `SELECT d."_id"::text AS id, d."title", d."expiresOn", u."name" AS student
           FROM "medicaldocuments" d JOIN "users" u ON u."_id" = d."student" AND u."isActive" IS NOT FALSE
          WHERE d."school" = $1 AND d."archivedAt" IS NULL AND d."expiresOn" IS NOT NULL AND d."expiryNotifiedAt" IS NULL
            AND ${storedDay('d."expiresOn"')} <= $2::date + $3::int`,
        [String(school), today, s.documentExpiryDays],
    );
    for (const d of docs) {
        // Stamped first: the stamp is the claim, so two sweeps cannot both tell.
        const { rowCount } = await pool.query(`UPDATE "medicaldocuments" SET "expiryNotifiedAt" = now() WHERE "_id" = $1 AND "expiryNotifiedAt" IS NULL`, [d.id]);
        if (!rowCount) continue;
        tell.system(school, {
            to: staff, setting: 'staffExpiry', link: { type: 'medical.documents', params: { tab: 'expiring' } },
            title: `Medical document expiring: ${d.student}`,
            body: `“${d.title}” for ${d.student} ${R.dayStr(d.expiresOn) < today ? 'expired' : 'expires'} on ${R.dayLabel(d.expiresOn)}. Ask the family for a current one.`,
        });
    }
}

async function sweepVaccinations(school, s, today) {
    const rows = await run(
        `SELECT v."_id"::text AS id, v."student"::text AS student, v."vaccine", v."dose", v."dueOn", v."remindedAt", v."overdueAt", u."name"
           FROM "medicalvaccinations" v JOIN "users" u ON u."_id" = v."student" AND u."isActive" IS NOT FALSE
          WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."givenOn" IS NULL AND v."dueOn" IS NOT NULL
            AND ${storedDay('v."dueOn"')} <= $2::date + $3::int
            AND (v."remindedAt" IS NULL OR (v."overdueAt" IS NULL AND ${storedDay('v."dueOn"')} < $2::date))`,
        [String(school), today, s.vaccinationDueDays],
    );
    for (const v of rows) {
        const overdue = R.dayStr(v.dueOn) < today;
        // The stamp is the claim: whichever sweep stamps it first is the one that tells.
        const { rowCount } = await pool.query(overdue
            ? `UPDATE "medicalvaccinations" SET "overdueAt" = now(), "remindedAt" = COALESCE("remindedAt", now()) WHERE "_id" = $1 AND "overdueAt" IS NULL`
            : `UPDATE "medicalvaccinations" SET "remindedAt" = now() WHERE "_id" = $1 AND "remindedAt" IS NULL`, [v.id]);
        if (!rowCount) continue;
        const parents = await tell.parentIds(v.student);
        tell.system(school, {
            to: parents, setting: 'parentVaccinationDue',
            link: { type: 'medical.child', params: { child: v.student, tab: 'vaccinations' } },
            title: overdue ? `Vaccination overdue — ${v.name}` : `Vaccination due — ${v.name}`,
            body: `${v.name}'s ${v.vaccine}${v.dose ? ` (${v.dose})` : ''} ${overdue ? 'was' : 'is'} due on ${R.dayLabel(v.dueOn)}. Once it is given, please send the certificate to the school's Medical Room.`,
            i18n: { key: overdue ? 'vaccination_overdue' : 'vaccination_due', vars: { name: v.name, vaccine: v.vaccine, dose: v.dose, due: R.dayLabel(v.dueOn) } },
        });
    }
}

/** Once a day: what is waiting, for the staff. */
async function digest(school, s, staff, today) {
    if (!(await claim(school, 'digest', today, 'info'))) return;
    await pool.query(`DELETE FROM "medicalalerts" WHERE "school" = $1 AND "kind" = 'digest' AND "subject" <> $2`, [String(school), today]);
    const [f] = await run(
        `SELECT
           ((SELECT count(*) FROM "medicalvisits" WHERE "school" = $1 AND "archivedAt" IS NULL AND "followUp"->>'status' = 'pending'
                AND COALESCE((("followUp"->>'on')::timestamptz AT TIME ZONE 'UTC')::date, $2::date) <= $2::date)
          + (SELECT count(*) FROM "medicalincidents" WHERE "school" = $1 AND "archivedAt" IS NULL AND "followUp"->>'status' = 'pending'
                AND COALESCE((("followUp"->>'on')::timestamptz AT TIME ZONE 'UTC')::date, $2::date) <= $2::date)
          + (SELECT count(*) FROM "medicalcheckups" WHERE "school" = $1 AND "archivedAt" IS NULL AND "followUp"->>'status' = 'pending'
                AND COALESCE((("followUp"->>'on')::timestamptz AT TIME ZONE 'UTC')::date, $2::date) <= $2::date))::int AS "followUps",
           (SELECT count(*)::int FROM "medicalvaccinations" v JOIN "users" u ON u."_id" = v."student" AND u."isActive" IS NOT FALSE
             WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."givenOn" IS NULL AND v."dueOn" IS NOT NULL AND ${storedDay('v."dueOn"')} < $2::date) AS overdue,
           (SELECT count(*)::int FROM "medicalvaccinations" v JOIN "users" u ON u."_id" = v."student" AND u."isActive" IS NOT FALSE
             WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."givenOn" IS NULL AND v."dueOn" IS NOT NULL
               AND ${storedDay('v."dueOn"')} >= $2::date AND ${storedDay('v."dueOn"')} <= $2::date + 7) AS "dueWeek"`,
        [String(school), today],
    );
    if (f.followUps > 0) {
        tell.system(school, {
            to: staff, setting: 'staffFollowUp', link: { type: 'medical.followups' },
            title: `${f.followUps} medical follow-up${f.followUps === 1 ? '' : 's'} due`,
            body: `${f.followUps} follow-up${f.followUps === 1 ? ' is' : 's are'} due today or overdue in the Medical Room.`,
        });
    }
    if (f.overdue > 0 || f.dueWeek > 0) {
        tell.system(school, {
            to: staff, setting: 'staffVaccinationDue', link: { type: 'medical.vaccinations' },
            title: 'Vaccinations due',
            body: `${f.dueWeek} vaccination${f.dueWeek === 1 ? '' : 's'} due this week${f.overdue ? `, ${f.overdue} overdue` : ''}.`,
        });
    }
}

async function sweepSchool(schoolId) {
    const s = await settingsSvc.get(schoolId);
    const today = R.todayStr();
    await meds.ensureDoses(schoolId, today);
    const missedDoses = await meds.markMissed(schoolId);
    const missed = missedDoses.length;
    const staff = await tell.staffIds(schoolId);
    // Doses nobody recorded in time: the medical staff hear which — one may still have been given and can be recorded late.
    if (missed && s.notify?.staffMedicineRound !== false) {
        try {
            const cards = await require('./medicalAccess').studentCards(schoolId, missedDoses.map((d) => d.student));
            const time = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
            const lines = missedDoses.map((d) => `${cards.get(d.student)?.name || 'A student'} — ${d.medicineName} at ${time(d.scheduledFor)}`);
            await tell.system(schoolId, {
                to: staff, link: { type: 'medical.round' },
                title: `${missed === 1 ? 'A dose was' : `${missed} doses were`} not recorded`,
                body: `${lines.slice(0, 8).join('; ')}${lines.length > 8 ? `; and ${lines.length - 8} more` : ''}. If a dose was given, record it now — otherwise it stays missed.`,
            });
        } catch (e) { console.error('[Medical] missed-dose notice failed:', e.message); }
    }
    await sweepStock(schoolId, s, staff, today);
    await sweepEquipment(schoolId, s, staff, today);
    await sweepDocuments(schoolId, s, staff, today);
    await sweepVaccinations(schoolId, s, today);
    // The digest waits for the working day, not midnight.
    if (new Date().getHours() >= 7) await digest(schoolId, s, staff, today);
    // Rescue medicines running out of date, care plans due for review — each told once.
    if (new Date().getHours() >= 7) {
        try { await require('./medicalCare').sweep(schoolId); } catch (e) { console.error('[Medical] care sweep failed:', e.message); }
    }
    // Students who have left: the day is noted, for the retention period.
    try { await require('./medicalRetention').stampLeavers(schoolId); } catch (e) { console.error('[Medical] leavers failed:', e.message); }
    // Monday morning: last week's access to medical records, to the admins.
    try { await require('./medicalAccessReview').digest(schoolId, claim); } catch (e) { console.error('[Medical] access digest failed:', e.message); }
    // The medicine fridge: no reading by noon on a school day → reminded, once.
    try { await require('./medicalPlaces').sweepFridge(schoolId, staff, claim); } catch (e) { console.error('[Medical] fridge sweep failed:', e.message); }
    // Clusters of the same illness in a section, a class or the school.
    try { await require('./medicalOutbreak').watch(schoolId, s, claim); } catch (e) { console.error('[Medical] outbreak watch failed:', e.message); }
    if (new Date().getHours() >= 7) {
        // Doses of the school's vaccination schedule falling due (when the school sends reminders),
        // specialist referrals the family has not answered, and the day of a health campaign.
        try { await require('./medicalSchedule').remindDue(schoolId, s, claim); } catch (e) { console.error('[Medical] schedule reminders failed:', e.message); }
        try { await require('./medicalReferrals').sweep(schoolId, claim); } catch (e) { console.error('[Medical] referral reminders failed:', e.message); }
        try { await require('./medicalCampaigns').sweep(schoolId, claim); } catch (e) { console.error('[Medical] campaign sweep failed:', e.message); }
        // A teacher covering a class or invigilating today: how many children there have an emergency card.
        try { await require('./medicalNeedToKnow').morningNotes(schoolId, claim); } catch (e) { console.error('[Medical] need-to-know notes failed:', e.message); }
    }
    return { missed };
}

async function schoolsToSweep() {
    const rows = await run(`SELECT "_id"::text AS id FROM "schools" WHERE ("modules"->>'medical')::boolean IS TRUE AND "isActive" IS NOT FALSE`);
    return rows.map((r) => r.id);
}

async function sweepAll() {
    const schools = await schoolsToSweep();
    let missed = 0;
    for (const id of schools) {
        try { missed += (await sweepSchool(id)).missed; } catch (e) { console.error(`[Medical] sweep failed for ${id}:`, e.message); }
    }
    return { schools: schools.length, missed };
}

module.exports = { sweepAll, sweepSchool, schoolsToSweep, claim };
