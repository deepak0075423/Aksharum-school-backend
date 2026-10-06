'use strict';
/**
 * Need to know (Oct 2026): who, beyond a child's own class and subject
 * teachers, must see the child's CRITICAL CARD — and for how long.
 *
 *   covering      a substitute teacher: the sections they cover TODAY
 *   invigilating  an invigilator: the students seated in their rooms on a
 *                 published exam-day plan, TODAY
 *   bus           bus crew (driver, backup driver, attendant): the riders of
 *                 their routes, while they crew them
 *   hostel        hostel staff (warden, assistant warden, caretaker, floor
 *                 supervisor, security): the residents of the hostel, building
 *                 or floor they are assigned to, while assigned
 *   mess          mess staff: the residents' FOOD allergies and diets only
 *
 * The critical card is the least that keeps a child safe: severe allergies
 * and severe conditions the room shares with teachers, rescue medicines and
 * where they are kept, care-plan steps; bus and hostel staff also the people
 * to call. Never the rest of the record. Every opening is audited.
 */
const pool = require('../db/pool');
const R = require('./medicalRules');
const read = require('./medicalRead');

const q = async (sql, params) => (await pool.query(sql, params)).rows;
const S = (v) => String(v);

/** The students of some sections: enrolled, or with the section as their current one. */
async function studentsOfSections(schoolId, sectionIds) {
    if (!sectionIds.length) return [];
    const rows = await q(
        `WITH secs AS (SELECT unnest($2::text[]) AS id)
         SELECT DISTINCT x."student" FROM (
             SELECT e.id AS "student" FROM "classsections" cs
              CROSS JOIN LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(cs."enrolledStudents") = 'array' THEN cs."enrolledStudents" ELSE '[]'::jsonb END) AS e(id)
              WHERE cs."_id"::text IN (SELECT id FROM secs)
             UNION
             SELECT sp."user"::text FROM "studentprofiles" sp WHERE sp."currentSection"::text IN (SELECT id FROM secs)
         ) x JOIN "users" u ON u."_id"::text = x."student" AND u."school" = $1 AND u."role" = 'student' AND u."isActive" IS NOT FALSE`,
        [S(schoolId), sectionIds],
    );
    return rows.map((r) => r.student);
}

const HOSTEL_ROLE = {
    warden: 'Warden', assistant_warden: 'Assistant warden', caretaker: 'Caretaker', security: 'Security',
    floor_supervisor: 'Floor supervisor', housekeeping: 'Housekeeping', maintenance: 'Maintenance', mess_staff: 'Mess',
};
// Who in a hostel looks after the children themselves (housekeeping and maintenance do not).
const CARE_ROLES = ['warden', 'assistant_warden', 'caretaker', 'security', 'floor_supervisor'];

/**
 * The groups a staff member sees beyond their own classes, each:
 *   { key, label, sub, until, students: [ids], contacts: bool, foodOnly: bool }
 */
async function groupsFor(schoolId, userId, today = R.todayStr()) {
    const out = [];
    const sid = S(schoolId); const uid = S(userId);

    // A substitute: today's covers.
    const covers = await q(
        `SELECT sa."section"::text AS section, min(sa."periodNumber") AS first, count(*)::int AS periods,
                min(c."className") AS "className", min(cs."sectionName") AS "sectionName"
           FROM "substituteassignments" sa
           LEFT JOIN "classsections" cs ON cs."_id" = sa."section" LEFT JOIN "classes" c ON c."_id" = cs."class"
          WHERE sa."school" = $1 AND sa."substituteTeacher"::text = $2 AND sa."status" = 'assigned'
            AND (sa."date" AT TIME ZONE 'UTC')::date = $3::date
          GROUP BY sa."section"`,
        [sid, uid, today],
    ).catch(() => []);
    if (covers.length) {
        out.push({
            key: 'covering', label: 'Covering today',
            sub: covers.map((c) => `${[c.className, c.sectionName].filter(Boolean).join(' ')} (${c.periods} period${c.periods === 1 ? '' : 's'})`).join(', '),
            until: today, students: await studentsOfSections(schoolId, covers.map((c) => c.section)), contacts: false, foodOnly: false,
        });
    }

    // An invigilator: today's published exam-day plan.
    const [plan] = await q(
        `SELECT "sittings" FROM "examdayplans" WHERE "school" = $1 AND ("date" AT TIME ZONE 'UTC')::date = $2::date AND "publishedAt" IS NOT NULL LIMIT 1`,
        [sid, today],
    ).catch(() => []);
    if (plan) {
        const seated = new Set();
        const rooms = [];
        for (const sit of plan.sittings || []) {
            for (const room of sit.rooms || []) {
                if (!(room.invigilators || []).some((i) => S(i.teacher) === uid)) continue;
                rooms.push(`${room.roomName || room.roomNumber || 'Room'}${sit.startTime ? ` at ${sit.startTime}` : ''}`);
                for (const seat of room.seats || []) if (seat.student) seated.add(S(seat.student));
            }
        }
        if (seated.size) out.push({ key: 'invigilating', label: 'Invigilating today', sub: rooms.join(', '), until: today, students: [...seated], contacts: false, foodOnly: false });
    }

    // Bus crew: the routes they drive or attend.
    const crew = await q(
        `SELECT ts."_id"::text AS id, ts."assignedVehicle"::text AS vehicle FROM "transportstaffs" ts
          WHERE ts."school" = $1 AND ts."user"::text = $2 AND ts."isActive" IS NOT FALSE`,
        [sid, uid],
    ).catch(() => []);
    if (crew.length) {
        const ids = crew.map((c) => c.id);
        const vehicles = crew.map((c) => c.vehicle).filter(Boolean);
        const routes = await q(
            `SELECT r."_id"::text AS id, r."name", r."routeCode", r."shift" FROM "transportroutes" r
              WHERE r."school" = $1 AND r."isActive" IS NOT FALSE AND COALESCE(r."status", 'active') IN ('active', 'maintenance')
                AND (r."driver"::text = ANY($2::text[]) OR r."backupDriver"::text = ANY($2::text[]) OR r."attendant"::text = ANY($2::text[])
                     OR r."vehicle"::text = ANY($3::text[]))`,
            [sid, ids, vehicles],
        ).catch(() => []);
        if (routes.length) {
            const riders = await q(
                `SELECT DISTINCT ta."student"::text AS student FROM "transportassignments" ta
                  JOIN "users" u ON u."_id" = ta."student" AND u."role" = 'student' AND u."isActive" IS NOT FALSE
                  WHERE ta."school" = $1 AND ta."route"::text = ANY($2::text[]) AND ta."status" = 'active'`,
                [sid, routes.map((r) => r.id)],
            );
            if (riders.length) {
                out.push({
                    key: 'bus', label: 'On my bus', sub: routes.map((r) => `${r.name}${r.routeCode ? ` (${r.routeCode})` : ''}`).join(', '),
                    until: null, students: riders.map((r) => r.student), contacts: true, foodOnly: false,
                });
            }
        }
    }

    // Hostel staff: the residents of where they are posted.
    const posts = await q(
        `SELECT a."hostel"::text AS hostel, a."building"::text AS building, a."floor"::text AS floor, a."role", h."name" AS "hostelName"
           FROM "hostelstaffassignments" a LEFT JOIN "hostels" h ON h."_id" = a."hostel"
          WHERE a."school" = $1 AND a."staff"::text = $2 AND a."status" = 'active' AND a."isActive" IS NOT FALSE
            AND (a."fromDate" IS NULL OR (a."fromDate" AT TIME ZONE 'UTC')::date <= $3::date)
            AND (a."toDate" IS NULL OR (a."toDate" AT TIME ZONE 'UTC')::date >= $3::date)`,
        [sid, uid, today],
    ).catch(() => []);
    for (const kind of ['hostel', 'mess']) {
        const mine = posts.filter((p) => (kind === 'mess' ? p.role === 'mess_staff' : CARE_ROLES.includes(p.role)));
        if (!mine.length) continue;
        const residents = new Set();
        for (const p of mine) {
            const rows = await q(
                `SELECT DISTINCT al."student"::text AS student FROM "hostelallocations" al
                  JOIN "users" u ON u."_id" = al."student" AND u."role" = 'student' AND u."isActive" IS NOT FALSE
                  WHERE al."school" = $1 AND al."hostel"::text = $2 AND al."status" = 'active' AND COALESCE(al."residentType", 'student') = 'student'
                    ${p.building ? 'AND al."building"::text = $3' : ''} ${p.floor ? `AND al."floor"::text = $${p.building ? 4 : 3}` : ''}`,
                [sid, p.hostel, ...(p.building ? [p.building] : []), ...(p.floor ? [p.floor] : [])],
            );
            rows.forEach((r) => residents.add(r.student));
        }
        if (!residents.size) continue;
        out.push(kind === 'mess'
            ? { key: 'mess', label: 'Mess — food allergies and diets', sub: [...new Set(mine.map((p) => p.hostelName).filter(Boolean))].join(', '), until: null, students: [...residents], contacts: false, foodOnly: true }
            : { key: 'hostel', label: 'In my hostel', sub: [...new Set(mine.map((p) => `${p.hostelName || 'Hostel'} — ${HOSTEL_ROLE[p.role] || p.role}`))].join(', '), until: null, students: [...residents], contacts: true, foodOnly: false });
    }
    return out;
}

/**
 * The critical card of each student: Map(id → { alerts, instructions, contacts?, diet? }).
 * `foodOnly`: food allergies (every severity — the kitchen must know a mild
 * one too) and the diet, nothing else.
 */
async function cardsFor(schoolId, studentIds, { contacts = false, foodOnly = false } = {}) {
    const ids = [...new Set(studentIds.map(S))];
    const out = new Map();
    if (!ids.length) return out;
    if (foodOnly) {
        const [allergies, profiles] = await Promise.all([
            q(`SELECT "student"::text AS student, "allergen", "severity", "reaction", "emergencyInstructions" FROM "medicalallergies"
                WHERE "school" = $1 AND "student"::text = ANY($2::text[]) AND "archivedAt" IS NULL AND "status" <> 'resolved' AND "category" = 'food'`, [S(schoolId), ids]),
            q(`SELECT "student"::text AS student, "dietaryRestrictions" FROM "medicalprofiles"
                WHERE "school" = $1 AND "student"::text = ANY($2::text[]) AND COALESCE("dietaryRestrictions", '') <> ''`, [S(schoolId), ids]),
        ]);
        for (const a of allergies) {
            if (!out.has(a.student)) out.set(a.student, { alerts: [], diet: '' });
            out.get(a.student).alerts.push({
                level: R.SEVERE_ALLERGY.includes(a.severity) ? 'critical' : 'warning', kind: 'allergy',
                label: `${R.SEVERE_ALLERGY.includes(a.severity) ? 'Severe food allergy' : 'Food allergy'}: ${a.allergen}`,
                severity: a.severity, detail: a.reaction || '', instructions: a.emergencyInstructions || '', medication: '',
            });
        }
        for (const p of profiles) {
            if (!out.has(p.student)) out.set(p.student, { alerts: [], diet: '' });
            out.get(p.student).diet = p.dietaryRestrictions;
        }
        return out;
    }
    const alerts = await read.teacherAlerts(schoolId, ids);
    for (const [sid, a] of alerts) {
        const critical = a.alerts.filter((x) => x.level === 'critical');
        if (critical.length) out.set(sid, { alerts: critical, instructions: a.instructions || '' });
    }
    if (contacts && out.size) {
        for (const sid of out.keys()) {
            const c = await read.contactsOf(schoolId, sid);
            out.get(sid).contacts = (c.contacts || []).filter((x) => x.phone).slice(0, 4).map((x) => ({ name: x.name, relation: x.relation, phone: x.phone }));
        }
    }
    return out;
}

/** Whether a staff member may open this student's card through one of their groups today. */
async function canSee(schoolId, userId, studentId) {
    const groups = await groupsFor(schoolId, userId);
    return groups.some((g) => !g.foodOnly && g.students.includes(S(studentId)));
}

/* ── Telling them (Oct 2026) ──────────────────────────────────────────────── */

/**
 * Who sees this child's card beyond the medical staff: the class and vice
 * class teacher, the crew of the child's bus, the hostel staff where the
 * child lives — and, for food, the mess staff there. User ids.
 */
async function whoSees(schoolId, studentId, today = R.todayStr()) {
    const sid = S(schoolId); const st = S(studentId);
    const tell = require('./medicalNotify');
    const card = new Set((await tell.classTeacherIds(schoolId, studentId)).map(S));
    const crew = await q(
        `SELECT DISTINCT ts."user"::text AS id FROM "transportassignments" ta
           JOIN "transportroutes" r ON r."_id" = ta."route" AND r."isActive" IS NOT FALSE
           JOIN "transportstaffs" ts ON ts."school" = $1 AND ts."isActive" IS NOT FALSE AND ts."user" IS NOT NULL
                AND (ts."_id" IN (r."driver", r."backupDriver", r."attendant") OR (r."vehicle" IS NOT NULL AND ts."assignedVehicle" = r."vehicle"))
          WHERE ta."school" = $1 AND ta."student"::text = $2 AND ta."status" = 'active'`,
        [sid, st],
    ).catch(() => []);
    crew.forEach((r) => card.add(r.id));
    const posted = await q(
        `SELECT DISTINCT a."staff"::text AS id, a."role" FROM "hostelallocations" al
           JOIN "hostelstaffassignments" a ON a."school" = al."school" AND a."hostel" = al."hostel" AND a."status" = 'active' AND a."isActive" IS NOT FALSE
                AND (a."building" IS NULL OR a."building" = al."building") AND (a."floor" IS NULL OR a."floor" = al."floor")
                AND (a."fromDate" IS NULL OR (a."fromDate" AT TIME ZONE 'UTC')::date <= $3::date)
                AND (a."toDate" IS NULL OR (a."toDate" AT TIME ZONE 'UTC')::date >= $3::date)
          WHERE al."school" = $1 AND al."student"::text = $2 AND al."status" = 'active' AND COALESCE(al."residentType", 'student') = 'student'`,
        [sid, st, today],
    ).catch(() => []);
    posted.filter((r) => CARE_ROLES.includes(r.role)).forEach((r) => card.add(r.id));
    const food = new Set(posted.filter((r) => r.role === 'mess_staff').map((r) => r.id));
    return { card: [...card], food: [...food] };
}

const keyOf = (c) => (c ? JSON.stringify([(c.alerts || []).map((a) => [a.kind, a.label, a.severity || '', a.detail || '', a.instructions || '', a.medication || '']).sort(), c.instructions || '', c.diet || '']) : '');

/** What the card says now — compared after a change. Null when it cannot be read (then nobody is told). */
async function cardBefore(req, studentId) {
    try {
        const [card, food] = await Promise.all([cardsFor(req.schoolId, [studentId]), cardsFor(req.schoolId, [studentId], { foodOnly: true })]);
        return { student: S(studentId), card: keyOf(card.get(S(studentId))), food: keyOf(food.get(S(studentId))) };
    } catch (e) { console.error('[medical] card snapshot failed:', e.message); return null; }
}

const lastTold = new Map();
/**
 * After a change: when the emergency card (or the food card) now says
 * something else, the people who see it are told — live, never the details
 * ("open it to read it"). Several changes within ten minutes: told once.
 * Behind teacherNeedToKnow. Never holds up the change.
 */
function cardAfter(req, before) {
    if (!before || req.quietLive) return;
    setImmediate(async () => {
        try {
            const after = await cardBefore(req, before.student);
            if (!after) return;
            const cardChanged = after.card !== before.card;
            const foodChanged = after.food !== before.food;
            if (!cardChanged && !foodChanged) return;
            const s = await require('./medicalSettings').get(req.schoolId);
            if (s.notify?.teacherNeedToKnow === false) return;
            const key = `${S(req.schoolId)}:${before.student}`;
            if ((lastTold.get(key) || 0) > Date.now() - 600000) return;
            lastTold.set(key, Date.now());
            if (lastTold.size > 5000) lastTold.clear();
            const who = await whoSees(req.schoolId, before.student);
            const st = await require('./medicalAccess').studentCard(req.schoolId, before.student);
            const name = st?.name || 'A student';
            const cls = st?.classLabel ? ` (${st.classLabel})` : '';
            const tell = require('./medicalNotify');
            const link = { type: 'medical.mine', params: { tab: 'alerts' } };
            if (cardChanged && who.card.length) {
                await tell.send(req, {
                    to: who.card, link,
                    title: `Emergency card updated — ${name}`,
                    body: after.card
                        ? `${name}${cls}: the Medical Room has changed what is on the emergency card. Open it to read it — the details are never in a notice.`
                        : `${name}${cls} no longer has an emergency card.`,
                });
            }
            if (foodChanged && who.food.length) {
                await tell.send(req, {
                    to: who.food, link,
                    title: `Food allergy or diet updated — ${name}`,
                    body: `${name}${cls}: the Medical Room has changed the food allergies or the diet the mess must know. Open the Medical Room page to read it.`,
                });
            }
        } catch (e) { console.error('[medical] card notice failed:', e.message); }
    });
}

/**
 * Each morning (from the sweep, after 7 am): a teacher covering a class or
 * invigilating today hears how many children there have an emergency card.
 * Told again only when their groups for the day change (a new cover).
 */
async function morningNotes(schoolId, claim, today = R.todayStr()) {
    const s = await require('./medicalSettings').get(schoolId);
    if (s.notify?.teacherNeedToKnow === false) return 0;
    const sid = S(schoolId);
    const subs = await q(
        `SELECT DISTINCT sa."substituteTeacher"::text AS id FROM "substituteassignments" sa
          WHERE sa."school" = $1 AND sa."status" = 'assigned' AND sa."substituteTeacher" IS NOT NULL AND (sa."date" AT TIME ZONE 'UTC')::date = $2::date`,
        [sid, today],
    ).catch(() => []);
    const [plan] = await q(`SELECT "sittings" FROM "examdayplans" WHERE "school" = $1 AND ("date" AT TIME ZONE 'UTC')::date = $2::date AND "publishedAt" IS NOT NULL LIMIT 1`, [sid, today]).catch(() => []);
    const people = new Set(subs.map((r) => r.id));
    for (const sit of plan?.sittings || []) for (const room of sit.rooms || []) for (const i of room.invigilators || []) if (i.teacher) people.add(S(i.teacher));
    let told = 0;
    const tell = require('./medicalNotify');
    for (const uid of people) {
        try {
            const groups = (await groupsFor(schoolId, uid, today)).filter((g) => g.key === 'covering' || g.key === 'invigilating');
            const lines = [];
            for (const g of groups) {
                const n = (await cardsFor(schoolId, g.students)).size;
                if (n) lines.push(`${g.label} — ${g.sub}: ${n} child${n === 1 ? '' : 'ren'} with an emergency card`);
            }
            if (!lines.length) continue;
            const subject = `${uid}:${today}:${require('crypto').createHash('md5').update(lines.join('|')).digest('hex').slice(0, 12)}`;
            if (!(await claim(schoolId, 'ntk_today', subject, 'info'))) continue;
            told += 1;
            await tell.system(schoolId, {
                to: [uid], link: { type: 'medical.mine', params: { tab: 'alerts' } },
                title: 'Emergency cards in your groups today',
                body: `${lines.join('; ')}. Open the Medical Room page to read the cards before you start.`,
            });
        } catch (e) { console.error('[medical] morning note failed:', e.message); }
    }
    return told;
}

module.exports = { groupsFor, cardsFor, canSee, studentsOfSections, HOSTEL_ROLE, whoSees, cardBefore, cardAfter, morningNotes };
