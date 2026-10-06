'use strict';
/**
 * The Medical Room's read models (Oct 2026): the dashboard, and one board per
 * list screen — all in SQL, paged in the database.
 *
 * Every board answers the same shape, so the screens share one table:
 *
 *   { tab, tabs: [{ key, label, count }], rows, total, page, limit, pages }
 *
 * Tab counts honour the filters (search, class, dates …) but not the tab
 * itself, so the tabs always add up to "All" for what is being looked at.
 * "Today", "due" and "expiring" are worked out from the school's calendar at
 * read time — nothing calendar-shaped is stored (services/medicalRules).
 */
const pool = require('../db/pool');
const access = require('./medicalAccess');
const settingsSvc = require('./medicalSettings');
const meds = require('./medicalMeds');
const R = require('./medicalRules');

const { todayStr, addDays, isUuid, ZONE } = R;
const run = (sql, params) => pool.query(sql, params).then((r) => r.rows);

/**
 * Keep only the parameters a statement uses, renumbered from $1. Postgres
 * refuses a parameter it never sees ("could not determine data type"), and a
 * board's count and page queries each use a different part of one list.
 */
function compact(sql, list) {
    const order = [];
    const seen = new Map();
    const text = sql.replace(/\$(\d+)\b/g, (m, n) => {
        if (!seen.has(n)) { seen.set(n, order.length + 1); order.push(list[Number(n) - 1]); }
        return `$${seen.get(n)}`;
    });
    return [text, order];
}

/** Parameters, numbered as they are added: `$(value)` → "$3". */
function params(initial = []) {
    const list = [...initial];
    const $ = (v) => { list.push(v); return `$${list.length}`; };
    return { list, $ };
}

const like = (s) => `%${String(s).trim().slice(0, 80).replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
const localDay = (col) => `(${col} AT TIME ZONE '${ZONE}')::date`;
const storedDay = (col) => `(${col} AT TIME ZONE 'UTC')::date`;
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/** The student columns every board shows, and the joins that give them. */
const STUDENT_SELECT = `u."_id"::text AS "studentId", u."name" AS "studentName", u."profileImage" AS "studentPhoto", sp."admissionNumber", sp."rollNumber",
    c."className", cs."sectionName", sp."currentSection"::text AS "sectionId", COALESCE(cs."class", sp."currentClass")::text AS "classId"`;
const STUDENT_JOIN = (col) => `JOIN "users" u ON u."_id" = ${col}
    LEFT JOIN "studentprofiles" sp ON sp."user" = ${col}
    LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
    LEFT JOIN "classes" c ON c."_id" = COALESCE(cs."class", sp."currentClass")`;

/** Search / class / section filters on the student of a row. */
function studentFilters(where, $, f, { extraSearch = [] } = {}) {
    if (f.q && String(f.q).trim()) {
        const p = $(like(f.q));
        where.push(`(u."name" ILIKE ${p} OR sp."admissionNumber" ILIKE ${p}${extraSearch.map((col) => ` OR ${col} ILIKE ${p}`).join('')})`);
    }
    if (isUuid(f.sectionId)) where.push(`sp."currentSection" = ${$(f.sectionId)}::uuid`);
    else if (isUuid(f.classId)) where.push(`COALESCE(cs."class", sp."currentClass") = ${$(f.classId)}::uuid`);
    if (isUuid(f.student)) where.push(`u."_id" = ${$(f.student)}::uuid`);
}

function dateFilters(where, $, f, col, { day = false } = {}) {
    const d = day ? storedDay(col) : localDay(col);
    if (isDay(f.from)) where.push(`${d} >= ${$(f.from)}::date`);
    if (isDay(f.to)) where.push(`${d} <= ${$(f.to)}::date`);
}

const withClass = (r) => ({ ...r, classLabel: [r.className, r.sectionName].filter(Boolean).join(' – ') });

/**
 * One board: the counts per tab over the filtered set, then the page of the
 * chosen tab. `tabs` is [[key, label, sqlCondition]], the first being the
 * default; a condition of `TRUE` is "all".
 */
async function board({ from, where, p, tabs, tab, select, order, page = 1, limit = 20, map = withClass }) {
    const chosen = tabs.find((t) => t[0] === tab) || tabs[0];
    const base = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countSql = `SELECT ${tabs.map(([key, , cond]) => `count(*) FILTER (WHERE ${cond})::int AS "${key}"`).join(', ')} FROM ${from} ${base}`;
    const lim = Math.min(200, Math.max(1, Number(limit) || 20));
    const pg = Math.max(1, Number(page) || 1);
    const rowSql = `SELECT ${select}, count(*) OVER ()::int AS "__total" FROM ${from} ${base ? `${base} AND` : 'WHERE'} (${chosen[2]})
                    ORDER BY ${typeof order === 'function' ? order(chosen[0]) : order} LIMIT ${lim} OFFSET ${(pg - 1) * lim}`;
    const [counts, rows] = await Promise.all([run(...compact(countSql, p.list)), run(...compact(rowSql, p.list))]);
    const total = rows[0]?.__total || 0;
    return {
        tab: chosen[0],
        tabs: tabs.map(([key, label]) => ({ key, label, count: counts[0]?.[key] || 0 })),
        rows: rows.map(({ __total, ...r }) => map(r)),
        total, page: pg, limit: lim, pages: Math.max(1, Math.ceil(total / lim)),
    };
}

/* ── Dashboard ────────────────────────────────────────────────────────────── */

/** Usable / expiring / expired quantities per item, as a lateral join on `i`. */
const BATCH_LATERAL = (todayP, alertP) => `LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(b."quantity") FILTER (WHERE b."expiryDate" IS NULL OR ${storedDay('b."expiryDate"')} >= ${todayP}::date), 0)::float8 AS usable,
           COALESCE(SUM(b."quantity") FILTER (WHERE b."expiryDate" IS NOT NULL AND ${storedDay('b."expiryDate"')} >= ${todayP}::date
                                                AND ${storedDay('b."expiryDate"')} <= ${todayP}::date + ${alertP}::int), 0)::float8 AS expiring,
           COALESCE(SUM(b."quantity") FILTER (WHERE b."expiryDate" IS NOT NULL AND ${storedDay('b."expiryDate"')} < ${todayP}::date), 0)::float8 AS expired,
           MIN(b."expiryDate") FILTER (WHERE b."expiryDate" IS NOT NULL AND ${storedDay('b."expiryDate"')} >= ${todayP}::date) AS "nextExpiry",
           count(*)::int AS batches
      FROM "medicalbatches" b WHERE b."item" = i."_id" AND b."status" = 'active' AND b."quantity" > 0) bt ON true`;

async function overview(req) {
    const S = String(req.schoolId);
    const s = await settingsSvc.get(req.schoolId);
    const today = todayStr();
    await meds.ensureDoses(req.schoolId, today).catch(() => 0);

    const [figures] = await run(
        `SELECT
           (SELECT count(*)::int FROM "medicalvisits" WHERE "school" = $1 AND "archivedAt" IS NULL AND ${localDay('"arrivedAt"')} = $2::date) AS "todayVisits",
           (SELECT count(*)::int FROM "medicalvisits" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" IN ('in_room','observation','emergency')) AS "inRoom",
           (SELECT count(*)::int FROM "medicalvisits" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" = 'emergency') AS "emergencyNow",
           (SELECT count(*)::int FROM "medicalincidents" WHERE "school" = $1 AND "archivedAt" IS NULL AND ${localDay('"occurredAt"')} = $2::date) AS "todayIncidents",
           ((SELECT count(*) FROM "medicalvisits" WHERE "school" = $1 AND "archivedAt" IS NULL AND "emergency" IS TRUE AND ${localDay('"arrivedAt"')} = $2::date)
            + (SELECT count(*) FROM "medicalincidents" WHERE "school" = $1 AND "archivedAt" IS NULL AND "severity" = 'critical' AND "visit" IS NULL AND ${localDay('"occurredAt"')} = $2::date))::int AS "emergencies",
           (SELECT count(DISTINCT x.s)::int FROM (
               SELECT "student" AS s FROM "medicalallergies" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" <> 'resolved' AND "severity" IN ('severe','life_threatening')
               UNION SELECT "student" FROM "medicalconditions" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" <> 'resolved' AND "severity" IN ('severe','critical')
               UNION SELECT "student" FROM "medicalprofiles" WHERE "school" = $1 AND ("emergencyMedication"->>'required')::boolean IS TRUE
           ) x JOIN "users" u ON u."_id" = x.s AND u."isActive" IS NOT FALSE) AS "withAlerts",
           (SELECT count(DISTINCT a."student")::int FROM "medicalallergies" a JOIN "users" u ON u."_id" = a."student" AND u."isActive" IS NOT FALSE
              WHERE a."school" = $1 AND a."archivedAt" IS NULL AND a."status" <> 'resolved') AS "withAllergies",
           (SELECT count(DISTINCT c."student")::int FROM "medicalconditions" c JOIN "users" u ON u."_id" = c."student" AND u."isActive" IS NOT FALSE
              WHERE c."school" = $1 AND c."archivedAt" IS NULL AND c."status" <> 'resolved') AS "withConditions",
           (SELECT count(DISTINCT p."student")::int FROM "medicationplans" p JOIN "users" u ON u."_id" = p."student" AND u."isActive" IS NOT FALSE
              WHERE p."school" = $1 AND p."status" = 'active' AND ${storedDay('p."startDate"')} <= $2::date
                AND (p."endDate" IS NULL OR ${storedDay('p."endDate"')} >= $2::date)) AS "onMedication",
           ((SELECT count(*) FROM "medicalvisits" WHERE "school" = $1 AND "archivedAt" IS NULL AND "followUp"->>'status' = 'pending')
            + (SELECT count(*) FROM "medicalincidents" WHERE "school" = $1 AND "archivedAt" IS NULL AND "followUp"->>'status' = 'pending')
            + (SELECT count(*) FROM "medicalcheckups" WHERE "school" = $1 AND "archivedAt" IS NULL AND "followUp"->>'status' = 'pending'))::int AS "pendingFollowUps",
           ((SELECT count(*) FROM "medicalvisits" WHERE "school" = $1 AND "archivedAt" IS NULL AND "followUp"->>'status' = 'pending' AND COALESCE((("followUp"->>'on')::timestamptz AT TIME ZONE 'UTC')::date, $2::date) <= $2::date)
            + (SELECT count(*) FROM "medicalincidents" WHERE "school" = $1 AND "archivedAt" IS NULL AND "followUp"->>'status' = 'pending' AND COALESCE((("followUp"->>'on')::timestamptz AT TIME ZONE 'UTC')::date, $2::date) <= $2::date)
            + (SELECT count(*) FROM "medicalcheckups" WHERE "school" = $1 AND "archivedAt" IS NULL AND "followUp"->>'status' = 'pending' AND COALESCE((("followUp"->>'on')::timestamptz AT TIME ZONE 'UTC')::date, $2::date) <= $2::date))::int AS "followUpsDue",
           (SELECT count(*)::int FROM "medicalcheckups" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" = 'scheduled' AND ${storedDay('"scheduledOn"')} >= $2::date) AS "upcomingCheckups",
           (SELECT count(*)::int FROM "medicalrequests" WHERE "school" = $1 AND "status" IN ('requested','accepted')) AS "pendingRequests",
           (SELECT count(*)::int FROM "medicalurgentnotices" WHERE "school" = $1 AND "status" IN ('open','escalated')) AS "familiesWaiting",
           (SELECT count(*)::int FROM "medicalurgentnotices" WHERE "school" = $1 AND "status" = 'escalated') AS "familiesNotReached",
           (SELECT count(*)::int FROM "medicalchangerequests" WHERE "school" = $1 AND "status" = 'pending') AS "pendingChanges",
           (SELECT count(*)::int FROM "medicationdoses" WHERE "school" = $1 AND ${localDay('"scheduledFor"')} = $2::date AND "status" = 'scheduled') AS "dosesDue",
           (SELECT count(*)::int FROM "medicationdoses" WHERE "school" = $1 AND ${localDay('"scheduledFor"')} = $2::date AND "status" = 'scheduled' AND "scheduledFor" < now()) AS "dosesOverdue",
           (SELECT count(*)::int FROM "medicationdoses" WHERE "school" = $1 AND "status" = 'given' AND ${localDay('"givenAt"')} = $2::date) AS "dosesGiven",
           (SELECT count(*)::int FROM "medicalvaccinations" v JOIN "users" u ON u."_id" = v."student" AND u."isActive" IS NOT FALSE
              WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."givenOn" IS NULL AND v."dueOn" IS NOT NULL AND ${storedDay('v."dueOn"')} < $2::date) AS "vaccinationsOverdue",
           (SELECT count(*)::int FROM "medicalvaccinations" v JOIN "users" u ON u."_id" = v."student" AND u."isActive" IS NOT FALSE
              WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."givenOn" IS NULL AND v."dueOn" IS NOT NULL
                AND ${storedDay('v."dueOn"')} >= $2::date AND ${storedDay('v."dueOn"')} <= $2::date + $3::int) AS "vaccinationsDue",
           (SELECT count(*)::int FROM "medicalequipments" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" <> 'retired'
              AND "nextMaintenanceOn" IS NOT NULL AND ${storedDay('"nextMaintenanceOn"')} <= $2::date + $4::int) AS "maintenanceDue",
           (SELECT count(*)::int FROM "medicalbeds" WHERE "school" = $1 AND "isActive" IS NOT FALSE) AS "beds",
           (SELECT count(*)::int FROM "medicalbeds" WHERE "school" = $1 AND "isActive" IS NOT FALSE AND "status" = 'occupied') AS "bedsOccupied",
           (SELECT count(*)::int FROM "medicalbeds" WHERE "school" = $1 AND "isActive" IS NOT FALSE AND "status" = 'available') AS "bedsFree"`,
        [S, today, s.vaccinationDueDays, s.maintenanceDueDays],
    );

    const [stock] = await run(
        `SELECT count(*) FILTER (WHERE i."minStock" > 0 AND bt.usable <= i."minStock")::int AS "lowStock",
                count(*) FILTER (WHERE bt.usable <= 0)::int AS "outOfStock",
                count(*) FILTER (WHERE bt.expiring > 0)::int AS "expiringItems",
                count(*) FILTER (WHERE bt.expired > 0)::int AS "expiredItems",
                count(*) FILTER (WHERE i."kind" = 'medicine')::int AS "medicines",
                count(*) FILTER (WHERE i."kind" = 'supply')::int AS "supplies"
           FROM "medicalitems" i ${BATCH_LATERAL('$2', '$3')}
          WHERE i."school" = $1 AND i."isActive" IS NOT FALSE`,
        [S, today, s.expiryAlertDays],
    );
    const studentTotal = await access.schoolStudentCount(req.schoolId);

    const [requests, active, recentVisits, recentIncidents, lowItems, expiringBatches, sessions, byDay, reasons, outcomes, incidentTypes, doses] = await Promise.all([
        run(`SELECT r."_id", r."number", r."reason", r."symptoms", r."location", r."urgency", r."status", r."createdAt", r."requestedByName", ${STUDENT_SELECT}
               FROM "medicalrequests" r ${STUDENT_JOIN('r."student"')}
              WHERE r."school" = $1 AND r."status" IN ('requested','accepted')
              ORDER BY CASE r."urgency" WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, r."createdAt" ASC LIMIT 8`, [S]),
        run(`SELECT v."_id", v."number", v."reason", v."status", v."arrivedAt", v."handledByName", v."vitals", b."label" AS "bedLabel", ${STUDENT_SELECT}
               FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')} LEFT JOIN "medicalbeds" b ON b."_id" = v."bed"
              WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."status" IN ('in_room','observation','emergency')
              ORDER BY CASE v."status" WHEN 'emergency' THEN 0 ELSE 1 END, v."arrivedAt" ASC LIMIT 12`, [S]),
        run(`SELECT v."_id", v."number", v."reason", v."status", v."arrivedAt", v."emergency", v."handledByName", ${STUDENT_SELECT}
               FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')}
              WHERE v."school" = $1 AND v."archivedAt" IS NULL ORDER BY v."arrivedAt" DESC LIMIT 8`, [S]),
        run(`SELECT i."_id", i."number", i."type", i."severity", i."status", i."occurredAt", i."location", i."injury", ${STUDENT_SELECT}
               FROM "medicalincidents" i ${STUDENT_JOIN('i."student"')}
              WHERE i."school" = $1 AND i."archivedAt" IS NULL ORDER BY i."occurredAt" DESC LIMIT 6`, [S]),
        run(`SELECT i."_id", i."name", i."kind", i."unit", i."minStock", i."strength", bt.usable
               FROM "medicalitems" i ${BATCH_LATERAL('$2', '$3')}
              WHERE i."school" = $1 AND i."isActive" IS NOT FALSE AND i."minStock" > 0 AND bt.usable <= i."minStock"
              ORDER BY (bt.usable / NULLIF(i."minStock", 0)) ASC, i."name" LIMIT 6`, [S, today, s.expiryAlertDays]),
        run(`SELECT b."_id", b."batchNumber", b."quantity", b."expiryDate", i."_id" AS "item", i."name", i."unit", i."kind",
                    (${storedDay('b."expiryDate"')} - $2::date)::int AS "daysLeft"
               FROM "medicalbatches" b JOIN "medicalitems" i ON i."_id" = b."item"
              WHERE b."school" = $1 AND b."status" = 'active' AND b."quantity" > 0 AND b."expiryDate" IS NOT NULL
                AND ${storedDay('b."expiryDate"')} <= $2::date + $3::int
              ORDER BY b."expiryDate" ASC LIMIT 6`, [S, today, s.expiryAlertDays]),
        run(`SELECT "sessionId", MIN("sessionName") AS "sessionName", MIN("type") AS "type", MIN("scheduledOn") AS "scheduledOn", count(*)::int AS students
               FROM "medicalcheckups" WHERE "school" = $1 AND "archivedAt" IS NULL AND "status" = 'scheduled' AND ${storedDay('"scheduledOn"')} >= $2::date
              GROUP BY "sessionId" ORDER BY MIN("scheduledOn") ASC LIMIT 5`, [S, today]),
        run(`SELECT to_char(d, 'YYYY-MM-DD') AS day,
                    (SELECT count(*)::int FROM "medicalvisits" v WHERE v."school" = $1 AND v."archivedAt" IS NULL AND ${localDay('v."arrivedAt"')} = d) AS visits,
                    (SELECT count(*)::int FROM "medicalincidents" i WHERE i."school" = $1 AND i."archivedAt" IS NULL AND ${localDay('i."occurredAt"')} = d) AS incidents
               FROM generate_series($2::date - 13, $2::date, interval '1 day') AS g(d0), LATERAL (SELECT g.d0::date AS d) x
              ORDER BY d`, [S, today]),
        run(`SELECT "reason" AS label, count(*)::int AS n FROM "medicalvisits"
              WHERE "school" = $1 AND "archivedAt" IS NULL AND ${localDay('"arrivedAt"')} >= $2::date - 29
              GROUP BY "reason" ORDER BY n DESC, "reason" LIMIT 6`, [S, today]),
        run(`SELECT "status" AS key, count(*)::int AS n FROM "medicalvisits"
              WHERE "school" = $1 AND "archivedAt" IS NULL AND ${localDay('"arrivedAt"')} >= $2::date - 29
              GROUP BY "status"`, [S, today]),
        run(`SELECT "type" AS key, count(*)::int AS n FROM "medicalincidents"
              WHERE "school" = $1 AND "archivedAt" IS NULL AND ${localDay('"occurredAt"')} >= $2::date - 89
              GROUP BY "type" ORDER BY n DESC`, [S, today]),
        run(`SELECT d."_id", d."medicineName", d."dosage", d."scheduledFor", d."status", ${STUDENT_SELECT}
               FROM "medicationdoses" d ${STUDENT_JOIN('d."student"')}
              WHERE d."school" = $1 AND d."status" = 'scheduled' AND ${localDay('d."scheduledFor"')} = $2::date
              ORDER BY d."scheduledFor" ASC LIMIT 8`, [S, today]),
    ]);

    // Health programmes: what is waiting on the staff.
    const [programmes] = await run(`SELECT
        (SELECT count(*)::int FROM "medicaloutbreaks" WHERE "school" = $1 AND "status" <> 'closed') AS "openOutbreaks",
        (SELECT count(*)::int FROM "medicalillnessreports" WHERE "school" = $1 AND "status" = 'new') AS "newIllness",
        (SELECT count(*)::int FROM "medicalrequests" WHERE "school" = $1 AND "source" = 'hostel' AND "status" = 'requested') AS "hostelWaiting",
        (SELECT count(*)::int FROM "medicalreferrals" WHERE "school" = $1 AND "status" = 'seen') AS "referralsToReview",
        (SELECT count(*)::int FROM "medicalreferrals" WHERE "school" = $1 AND "status" IN ('waiting','booked') AND "dueBy" IS NOT NULL AND ${storedDay('"dueBy"')} < $2::date) AS "referralsOverdue",
        (SELECT count(*)::int FROM "medicalcampaigns" WHERE "school" = $1 AND "status" = 'announced' AND ${storedDay('"startOn"')} <= $2::date
            AND ${storedDay('COALESCE("mopUpOn","endOn","startOn")')} >= $2::date) AS "campaignsToday"`, [S, today]);
    const outbreaks = programmes.openOutbreaks ? await run(`SELECT "_id"::text AS "_id", "number", "label", "scope", "status", "lastCaseAt",
            (SELECT count(DISTINCT c->>'student')::int FROM jsonb_array_elements(COALESCE("cases",'[]'::jsonb)) c) AS "caseCount"
          FROM "medicaloutbreaks" WHERE "school" = $1 AND "status" <> 'closed' ORDER BY "lastCaseAt" DESC NULLS LAST LIMIT 4`, [S]) : [];

    return {
        today,
        programmes: { ...programmes, outbreaks },
        settings: { roomName: s.roomName, hasBeds: s.hasBeds, expiryAlertDays: s.expiryAlertDays, vaccinationDueDays: s.vaccinationDueDays },
        figures: { ...figures, ...stock, totalStudents: studentTotal },
        requests: requests.map(withClass),
        active: active.map((v) => ({ ...withClass(v), flags: R.vitalFlags(v.vitals || {}) })),
        recentVisits: recentVisits.map(withClass),
        recentIncidents: recentIncidents.map(withClass),
        lowItems,
        expiringBatches,
        sessions,
        doses: doses.map(withClass),
        charts: {
            byDay,
            reasons,
            outcomes: outcomes.map((o) => ({ ...o, label: R.VISIT_STATUS[o.key]?.label || o.key, tone: R.VISIT_STATUS[o.key]?.tone })),
            incidentTypes: incidentTypes.map((t) => ({ ...t, label: R.INCIDENT_TYPE[t.key] || t.key })),
        },
    };
}

/* ── Boards ───────────────────────────────────────────────────────────────── */

const BOARDS = {};

BOARDS.requests = (S, f) => {
    const p = params([S]);
    const where = ['r."school" = $1'];
    studentFilters(where, p.$, f, { extraSearch: ['r."number"', 'r."reason"', 'r."requestedByName"'] });
    dateFilters(where, p.$, f, 'r."createdAt"');
    if (R.URGENCY[f.urgency]) where.push(`r."urgency" = ${p.$(f.urgency)}`);
    return board({
        from: `"medicalrequests" r ${STUDENT_JOIN('r."student"')} LEFT JOIN "medicalvisits" v ON v."_id" = r."visit"`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['open', 'Open', `r."status" IN ('requested','accepted','arrived','treatment')`],
            ['waiting', 'Waiting', `r."status" IN ('requested','accepted')`],
            ['completed', 'Completed', `r."status" IN ('returned','sent_home','referred','closed')`],
            ['cancelled', 'Cancelled', `r."status" = 'cancelled'`],
            ['all', 'All', 'TRUE'],
        ],
        select: `r."_id", r."number", r."reason", r."symptoms", r."location", r."urgency", r."remarks", r."escortedBy", r."status", r."createdAt",
                 r."acceptedAt", r."arrivedAt", r."closedAt", r."cancelReason", r."outcomeNote", r."requestedByName", r."history",
                 r."visit"::text AS "visit", v."number" AS "visitNumber", v."status" AS "visitStatus", ${STUDENT_SELECT}`,
        order: (tab) => (tab === 'open' || tab === 'waiting'
            ? `CASE r."status" WHEN 'requested' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, CASE r."urgency" WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, r."createdAt" ASC`
            : 'r."createdAt" DESC'),
    });
};

BOARDS.visits = (S, f, s, today) => {
    const p = params([S]);
    const where = ['v."school" = $1', f.archived === '1' ? 'v."archivedAt" IS NOT NULL' : 'v."archivedAt" IS NULL'];
    studentFilters(where, p.$, f, { extraSearch: ['v."number"', 'v."reason"'] });
    dateFilters(where, p.$, f, 'v."arrivedAt"');
    if (R.VISIT_STATUS[f.status]) where.push(`v."status" = ${p.$(f.status)}`);
    if (f.reason) where.push(`v."reason" ILIKE ${p.$(like(f.reason))}`);
    if (f.emergency === '1') where.push('v."emergency" IS TRUE');
    const t = p.$(today);
    return board({
        from: `"medicalvisits" v ${STUDENT_JOIN('v."student"')} LEFT JOIN "medicalbeds" b ON b."_id" = v."bed"`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['today', 'Today', `${localDay('v."arrivedAt"')} = ${t}::date`],
            ['in_room', 'In the Room', `v."status" IN ('in_room','observation','emergency')`],
            ['follow_up', 'Follow-up', `v."followUp"->>'status' = 'pending'`],
            ['referred', 'Referred', `v."status" = 'referred' OR (v."referral"->>'referred')::boolean IS TRUE`],
            ['sent_home', 'Sent Home', `v."status" = 'sent_home'`],
            ['closed', 'Closed', `v."status" = 'closed'`],
            ['all', 'All', 'TRUE'],
        ],
        select: `v."_id", v."number", v."arrivedAt", v."reason", v."symptoms", v."status", v."emergency", v."handledByName", v."vitals",
                 v."treatment", v."medicines", v."followUp", v."referral", v."departedAt", v."parentContacted", v."archivedAt", v."archiveReason",
                 v."request"::text AS "request", b."label" AS "bedLabel", ${STUDENT_SELECT}`,
        order: (tab) => (tab === 'in_room' ? `CASE v."status" WHEN 'emergency' THEN 0 ELSE 1 END, v."arrivedAt" ASC` : 'v."arrivedAt" DESC'),
        map: (r) => ({ ...withClass(r), followUpState: R.followUpState(r.followUp, today), flags: R.vitalFlags(r.vitals || {}) }),
    });
};

BOARDS.incidents = (S, f, s, today) => {
    const p = params([S]);
    const where = ['i."school" = $1', f.archived === '1' ? 'i."archivedAt" IS NOT NULL' : 'i."archivedAt" IS NULL'];
    studentFilters(where, p.$, f, { extraSearch: ['i."number"', 'i."description"', 'i."location"'] });
    dateFilters(where, p.$, f, 'i."occurredAt"');
    if (R.INCIDENT_TYPE[f.type]) where.push(`i."type" = ${p.$(f.type)}`);
    if (R.INCIDENT_SEVERITY[f.severity]) where.push(`i."severity" = ${p.$(f.severity)}`);
    if (f.location) where.push(`i."location" ILIKE ${p.$(like(f.location))}`);
    return board({
        from: `"medicalincidents" i ${STUDENT_JOIN('i."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['open', 'Open', `i."status" IN ('reported','in_progress')`],
            ['serious', 'Serious & Critical', `i."severity" IN ('serious','critical')`],
            ['follow_up', 'Follow-up', `i."followUp"->>'status' = 'pending'`],
            ['resolved', 'Resolved', `i."status" = 'resolved'`],
            ['closed', 'Closed', `i."status" = 'closed'`],
            ['all', 'All', 'TRUE'],
        ],
        select: `i."_id", i."number", i."occurredAt", i."location", i."type", i."description", i."injury", i."bodyPart", i."severity", i."status",
                 i."firstAid", i."reportedByName", i."reportedByRole", i."parentNotified", i."referral", i."followUp", i."documents",
                 i."visit"::text AS "visit", i."archivedAt", ${STUDENT_SELECT}`,
        order: 'i."occurredAt" DESC',
        map: (r) => ({ ...withClass(r), followUpState: R.followUpState(r.followUp, today) }),
    });
};

BOARDS.firstaid = (S, f, s, today) => {
    const p = params([S]);
    const where = ['fa."school" = $1', 'fa."archivedAt" IS NULL'];
    studentFilters(where, p.$, f, { extraSearch: ['fa."reason"', 'fa."treatment"'] });
    dateFilters(where, p.$, f, 'fa."at"');
    const t = p.$(today);
    return board({
        from: `"medicalfirstaids" fa ${STUDENT_JOIN('fa."student"')} LEFT JOIN "medicalvisits" v ON v."_id" = fa."visit" LEFT JOIN "medicalincidents" mi ON mi."_id" = fa."incident"`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['all', 'All', 'TRUE'],
            ['today', 'Today', `${localDay('fa."at"')} = ${t}::date`],
            ['week', 'Last 7 days', `${localDay('fa."at"')} >= ${t}::date - 6`],
            ['supplies', 'Used supplies', `jsonb_array_length(COALESCE(fa."supplies", '[]'::jsonb)) > 0`],
        ],
        select: `fa."_id", fa."at", fa."reason", fa."injury", fa."treatment", fa."supplies", fa."givenByName", fa."remarks",
                 fa."visit"::text AS "visit", v."number" AS "visitNumber", fa."incident"::text AS "incident", mi."number" AS "incidentNumber", ${STUDENT_SELECT}`,
        order: 'fa."at" DESC',
    });
};

BOARDS.profiles = (S, f, s, today) => {
    const p = params([S]);
    const where = ['u."school" = $1', `u."role" = 'student'`, 'u."isActive" IS NOT FALSE'];
    studentFilters(where, p.$, f);
    if (R.BLOOD_GROUPS.includes(String(f.bloodGroup || '').toUpperCase())) where.push(`upper(sp."bloodGroup") = ${p.$(String(f.bloodGroup).toUpperCase())}`);
    const t = p.$(today);
    return board({
        from: `"users" u
          LEFT JOIN "studentprofiles" sp ON sp."user" = u."_id"
          LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
          LEFT JOIN "classes" c ON c."_id" = COALESCE(cs."class", sp."currentClass")
          LEFT JOIN "medicalprofiles" mp ON mp."student" = u."_id" AND mp."school" = $1
          LEFT JOIN LATERAL (SELECT count(*)::int AS n,
                                    count(*) FILTER (WHERE a."severity" IN ('severe','life_threatening'))::int AS severe,
                                    string_agg(a."allergen", ', ' ORDER BY a."severity" DESC) AS names
                               FROM "medicalallergies" a WHERE a."student" = u."_id" AND a."school" = $1 AND a."archivedAt" IS NULL AND a."status" <> 'resolved') al ON true
          LEFT JOIN LATERAL (SELECT count(*)::int AS n,
                                    count(*) FILTER (WHERE mc."severity" IN ('severe','critical'))::int AS severe,
                                    count(*) FILTER (WHERE mc."chronic" IS TRUE)::int AS chronic,
                                    string_agg(mc."condition", ', ') AS names
                               FROM "medicalconditions" mc WHERE mc."student" = u."_id" AND mc."school" = $1 AND mc."archivedAt" IS NULL AND mc."status" <> 'resolved') co ON true
          LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM "medicationplans" pl WHERE pl."student" = u."_id" AND pl."school" = $1 AND pl."status" = 'active'
                                AND (pl."endDate" IS NULL OR ${storedDay('pl."endDate"')} >= ${t}::date)) pl ON true
          LEFT JOIN LATERAL (SELECT max(v."arrivedAt") AS at, count(*)::int AS n FROM "medicalvisits" v WHERE v."student" = u."_id" AND v."school" = $1 AND v."archivedAt" IS NULL) vi ON true`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['all', 'All Students', 'TRUE'],
            ['alerts', 'Medical Alerts', `(al.severe > 0 OR co.severe > 0 OR (mp."emergencyMedication"->>'required')::boolean IS TRUE)`],
            ['allergies', 'Allergies', 'al.n > 0'],
            ['conditions', 'Conditions', 'co.n > 0'],
            ['medication', 'On Medication', 'pl.n > 0'],
            ['incomplete', 'Missing Details', `(COALESCE(sp."bloodGroup", '') = '' OR mp."_id" IS NULL)`],
        ],
        select: `u."_id"::text AS "_id", ${STUDENT_SELECT}, sp."bloodGroup", sp."dob", sp."gender",
                 al.n AS "allergyCount", al.severe AS "severeAllergies", al.names AS "allergyNames",
                 co.n AS "conditionCount", co.severe AS "severeConditions", co.chronic AS "chronicConditions", co.names AS "conditionNames",
                 pl.n AS "planCount", vi.at AS "lastVisit", vi.n AS "visitCount",
                 (mp."emergencyMedication"->>'required')::boolean IS TRUE AS "emergencyMedication", mp."_id" IS NOT NULL AS "hasProfile",
                 mp."heightCm", mp."weightKg", mp."updatedAt" AS "profileUpdatedAt"`,
        order: (tab) => (tab === 'alerts' ? '(al.severe + co.severe) DESC, u."name"' : 'c."classNumber" NULLS LAST, c."className" NULLS LAST, cs."sectionName" NULLS LAST, u."name"'),
        map: (r) => ({ ...withClass(r), critical: r.severeAllergies > 0 || r.severeConditions > 0 || r.emergencyMedication, bmi: R.bmi(r.heightCm, r.weightKg) }),
    });
};

BOARDS.allergies = (S, f) => {
    const p = params([S]);
    const where = ['a."school" = $1', f.archived === '1' ? 'a."archivedAt" IS NOT NULL' : 'a."archivedAt" IS NULL', 'u."isActive" IS NOT FALSE'];
    studentFilters(where, p.$, f, { extraSearch: ['a."allergen"', 'a."reaction"'] });
    if (R.ALLERGY_SEVERITY[f.severity]) where.push(`a."severity" = ${p.$(f.severity)}`);
    if (f.status === 'resolved' || f.status === 'active') where.push(`a."status" = ${p.$(f.status)}`);
    if (f.unverified === '1') where.push('a."verified" IS NOT TRUE');
    return board({
        from: `"medicalallergies" a ${STUDENT_JOIN('a."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['all', 'All', 'TRUE'],
            ['severe', 'Severe', `a."severity" IN ('severe','life_threatening')`],
            ...Object.entries(R.ALLERGY_CATEGORY).map(([k, label]) => [k, label, `a."category" = '${k}'`]),
        ],
        select: `a.*, a."_id"::text AS "_id", ${STUDENT_SELECT}`,
        order: `CASE a."severity" WHEN 'life_threatening' THEN 0 WHEN 'severe' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, u."name"`,
    });
};

BOARDS.conditions = (S, f) => {
    const p = params([S]);
    const where = ['mc."school" = $1', f.archived === '1' ? 'mc."archivedAt" IS NOT NULL' : 'mc."archivedAt" IS NULL', 'u."isActive" IS NOT FALSE'];
    studentFilters(where, p.$, f, { extraSearch: ['mc."condition"'] });
    if (R.CONDITION_TYPE[f.type]) where.push(`mc."type" = ${p.$(f.type)}`);
    if (R.CONDITION_SEVERITY[f.severity]) where.push(`mc."severity" = ${p.$(f.severity)}`);
    if (f.unverified === '1') where.push('mc."verified" IS NOT TRUE');
    return board({
        from: `"medicalconditions" mc ${STUDENT_JOIN('mc."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['current', 'Current', `mc."status" IN ('active','managed')`],
            ['critical', 'Severe & Critical', `mc."severity" IN ('severe','critical') AND mc."status" <> 'resolved'`],
            ['chronic', 'Chronic', `mc."chronic" IS TRUE AND mc."status" <> 'resolved'`],
            ['resolved', 'Resolved', `mc."status" = 'resolved'`],
            ['all', 'All', 'TRUE'],
        ],
        select: `mc.*, mc."_id"::text AS "_id", ${STUDENT_SELECT}`,
        order: `CASE mc."severity" WHEN 'critical' THEN 0 WHEN 'severe' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, u."name"`,
    });
};

// Emergency care plans — which are waiting for a parent, which are past review.
BOARDS.careplans = (S, f, s, today) => {
    const p = params([S, today]);
    const where = ['cp."school" = $1', f.archived === '1' ? 'cp."archivedAt" IS NOT NULL' : 'cp."archivedAt" IS NULL', 'u."isActive" IS NOT FALSE'];
    studentFilters(where, p.$, f, { extraSearch: ['cp."title"'] });
    if (['anaphylaxis', 'asthma', 'seizure', 'diabetes', 'cardiac', 'other'].includes(f.kind)) where.push(`cp."kind" = ${p.$(f.kind)}`);
    return board({
        from: `"medicalcareplans" cp ${STUDENT_JOIN('cp."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['active', 'In use', `cp."status" = 'active'`],
            ['unconfirmed', 'Waiting for the parent', `cp."status" = 'active' AND cp."parentConfirmedAt" IS NULL`],
            ['review', 'Review due', `cp."status" = 'active' AND cp."reviewDue" IS NOT NULL AND ${storedDay('cp."reviewDue"')} <= $2::date`],
            ['draft', 'Drafts', `cp."status" = 'draft'`],
            ['all', 'All', 'TRUE'],
        ],
        select: `cp.*, cp."_id"::text AS "_id", ${STUDENT_SELECT}`,
        order: `u."name", cp."title"`,
    });
};

// Restrictions — what teachers have been asked to do, in force, coming up and finished.
BOARDS.restrictions = (S, f, s, today) => {
    const p = params([S, today]);
    const where = ['rs."school" = $1', f.archived === '1' ? 'rs."archivedAt" IS NOT NULL' : 'rs."archivedAt" IS NULL', 'u."isActive" IS NOT FALSE'];
    studentFilters(where, p.$, f, { extraSearch: ['rs."teacherText"', 'rs."reason"'] });
    const start = storedDay('rs."startsOn"'); const end = storedDay('rs."endsOn"');
    const running = `rs."endedAt" IS NULL AND ${start} <= $2::date AND (rs."endsOn" IS NULL OR ${end} >= $2::date)`;
    return board({
        from: `"medicalrestrictions" rs ${STUDENT_JOIN('rs."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['active', 'In force', running],
            ['upcoming', 'Starting soon', `rs."endedAt" IS NULL AND ${start} > $2::date`],
            ['open', 'No end date', `${running} AND rs."endsOn" IS NULL`],
            ['ended', 'Ended', `(rs."endedAt" IS NOT NULL OR (rs."endsOn" IS NOT NULL AND ${end} < $2::date))`],
            ['all', 'All', 'TRUE'],
        ],
        select: `rs.*, rs."_id"::text AS "_id", ${STUDENT_SELECT}`,
        order: `rs."startsOn" DESC, u."name"`,
    });
};

// This year's parental consent: who has answered, who has not.
BOARDS.consents = async (S, f) => {
    const year = await require('./medicalConsent').currentYear(S);
    const p = params([S]);
    const y = p.$(year?._id || null);
    const where = ['u."school" = $1', `u."role" = 'student'`, 'u."isActive" IS NOT FALSE'];
    studentFilters(where, p.$, f);
    return board({
        from: `"users" u LEFT JOIN "studentprofiles" sp ON sp."user" = u."_id"
               LEFT JOIN "classsections" cs ON cs."_id" = sp."currentSection"
               LEFT JOIN "classes" c ON c."_id" = COALESCE(cs."class", sp."currentClass")
               LEFT JOIN "medicalconsents" mc ON mc."student" = u."_id" AND mc."school" = $1 AND mc."academicYear" IS NOT DISTINCT FROM ${y}::uuid`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['missing', 'Not answered', `(mc."_id" IS NULL OR mc."status" = 'requested')`],
            ['given', 'Given', `mc."status" = 'given'`],
            ['no_otc', 'Given — no everyday medicines', `mc."status" = 'given' AND jsonb_array_length(COALESCE(mc."otc", '[]'::jsonb)) = 0`],
            ['withdrawn', 'Withdrawn', `mc."status" = 'withdrawn'`],
            ['all', 'All', 'TRUE'],
        ],
        select: `${STUDENT_SELECT}, mc."_id"::text AS "consentId", mc."status" AS "consentStatus", mc."otc", mc."emergencyTreatment", mc."shareWithTeachers",
                 mc."injuryPhotos", mc."selfCarry", mc."signedName", mc."givenAt", mc."onPaper", mc."requestedAt", ${y}::text AS "yearId"`,
        order: `u."name"`,
    });
};

// Off school until it is safe to come back.
BOARDS.exclusions = (S, f, s, today) => {
    const p = params([S, today]);
    const where = ['ex."school" = $1', 'u."isActive" IS NOT FALSE'];
    studentFilters(where, p.$, f, { extraSearch: ['ex."label"'] });
    return board({
        from: `"medicalexclusions" ex ${STUDENT_JOIN('ex."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['away', 'Off school', `ex."status" = 'excluded'`],
            ['ready', 'Can come back', `ex."status" = 'excluded' AND (ex."earliestReturn" IS NULL OR ex."earliestReturn" <= now()) AND (NOT ex."needsCertificate" OR ex."certificateDoc" IS NOT NULL)`],
            ['certificate', 'Certificate needed', `ex."status" = 'excluded' AND ex."needsCertificate" AND ex."certificateDoc" IS NULL`],
            ['cleared', 'Cleared', `ex."status" = 'cleared'`],
            ['all', 'All', 'TRUE'],
        ],
        select: `ex.*, ex."_id"::text AS "_id", ex."certificateDoc"::text AS "certificateDoc", ${STUDENT_SELECT}`,
        order: `CASE ex."status" WHEN 'excluded' THEN 0 ELSE 1 END, ex."earliestReturn" ASC NULLS LAST, u."name"`,
    });
};

// Rescue medicines — the ones running out of date, and the ones nobody has looked at lately.
BOARDS.rescuemeds = (S, f, s, today) => {
    const p = params([S, today]);
    const where = ['rm."school" = $1', f.archived === '1' ? 'rm."archivedAt" IS NOT NULL' : 'rm."archivedAt" IS NULL', 'u."isActive" IS NOT FALSE'];
    studentFilters(where, p.$, f, { extraSearch: ['rm."name"'] });
    if (['auto_injector', 'inhaler', 'glucagon', 'seizure', 'antihistamine', 'glucose', 'other'].includes(f.kind)) where.push(`rm."kind" = ${p.$(f.kind)}`);
    const exp = storedDay('rm."expiresOn"');
    return board({
        from: `"medicalrescuemeds" rm ${STUDENT_JOIN('rm."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['active', 'In use', `rm."status" = 'active'`],
            ['expiring', 'Expiring in 30 days', `rm."status" = 'active' AND rm."expiresOn" IS NOT NULL AND ${exp} >= $2::date AND ${exp} <= $2::date + 30`],
            ['expired', 'Expired', `rm."status" = 'active' AND rm."expiresOn" IS NOT NULL AND ${exp} < $2::date`],
            ['unchecked', 'Not checked in 90 days', `rm."status" = 'active' AND (rm."lastCheckedAt" IS NULL OR rm."lastCheckedAt" < now() - interval '90 days')`],
            ['all', 'All', 'TRUE'],
        ],
        select: `rm.*, rm."_id"::text AS "_id", ${STUDENT_SELECT}`,
        order: `rm."expiresOn" ASC NULLS LAST, u."name"`,
    });
};

BOARDS.plans = (S, f, s, today) => {
    const p = params([S]);
    const where = ['pl."school" = $1'];
    studentFilters(where, p.$, f, { extraSearch: ['pl."medicineName"'] });
    if (f.source === 'school' || f.source === 'parent') where.push(`pl."source" = ${p.$(f.source)}`);
    return board({
        from: `"medicationplans" pl ${STUDENT_JOIN('pl."student"')} LEFT JOIN "medicalitems" it ON it."_id" = pl."item"`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['active', 'Active', `pl."status" = 'active'`],
            ['paused', 'Waiting / Paused', `pl."status" = 'paused'`],
            ['completed', 'Completed', `pl."status" = 'completed'`],
            ['cancelled', 'Cancelled', `pl."status" = 'cancelled'`],
            ['all', 'All', 'TRUE'],
        ],
        // itemStock: what can be GIVEN — units past their date stay on the shelf but are not usable.
        select: `pl.*, pl."_id"::text AS "_id", it."name" AS "itemName", it."unit" AS "itemUnit",
                 COALESCE((SELECT SUM(bb."quantity") FROM "medicalbatches" bb WHERE bb."item" = it."_id" AND bb."status" = 'active'
                     AND (bb."expiryDate" IS NULL OR ${storedDay('bb."expiryDate"')} >= ${p.$(today)}::date)), 0)::float8 AS "itemStock", ${STUDENT_SELECT}`,
        order: 'u."name", pl."createdAt" DESC',
    });
};

BOARDS.doses = (S, f, s, today) => {
    const p = params([S]);
    const where = ['d."school" = $1', `d."status" <> 'scheduled'`];
    studentFilters(where, p.$, f, { extraSearch: ['d."medicineName"'] });
    dateFilters(where, p.$, f, 'COALESCE(d."givenAt", d."scheduledFor", d."createdAt")');
    if (f.medicine) where.push(`d."medicineName" ILIKE ${p.$(like(f.medicine))}`);
    return board({
        from: `"medicationdoses" d ${STUDENT_JOIN('d."student"')} LEFT JOIN "medicalvisits" v ON v."_id" = d."visit"`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['all', 'All', 'TRUE'],
            ['given', 'Given', `d."status" = 'given'`],
            ['missed', 'Missed', `d."status" = 'missed'`],
            ['refused', 'Refused', `d."status" = 'refused'`],
            ['cancelled', 'Cancelled', `d."status" = 'cancelled'`],
        ],
        select: `d."_id", d."medicineName", d."dosage", d."quantity", d."status", d."scheduledFor", d."givenAt", d."givenByName", d."note", d."source",
                 d."plan"::text AS "plan", d."visit"::text AS "visit", v."number" AS "visitNumber", d."updatedAt", ${STUDENT_SELECT}`,
        order: 'COALESCE(d."givenAt", d."scheduledFor", d."createdAt") DESC',
    });
};

const VAC_STATE = (today, days) => `(CASE WHEN v."givenOn" IS NOT NULL THEN 'completed' WHEN v."dueOn" IS NULL THEN 'pending'
    WHEN ${storedDay('v."dueOn"')} < ${today}::date THEN 'overdue' WHEN ${storedDay('v."dueOn"')} <= ${today}::date + ${days}::int THEN 'due_soon' ELSE 'pending' END)`;

BOARDS.vaccinations = (S, f, s, today) => {
    const p = params([S]);
    const where = ['v."school" = $1', 'v."archivedAt" IS NULL', 'u."isActive" IS NOT FALSE'];
    studentFilters(where, p.$, f, { extraSearch: ['v."vaccine"'] });
    if (f.vaccine) where.push(`v."vaccine" ILIKE ${p.$(like(f.vaccine))}`);
    const state = VAC_STATE(p.$(today), p.$(s.vaccinationDueDays));
    return board({
        from: `"medicalvaccinations" v ${STUDENT_JOIN('v."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['due_soon', 'Due Soon', `${state} = 'due_soon'`],
            ['overdue', 'Overdue', `${state} = 'overdue'`],
            ['pending', 'Pending', `${state} = 'pending'`],
            ['completed', 'Completed', `${state} = 'completed'`],
            ['all', 'All', 'TRUE'],
        ],
        select: `v.*, v."_id"::text AS "_id", ${state} AS "state", ${STUDENT_SELECT}`,
        order: (tab) => (tab === 'completed' ? 'v."givenOn" DESC' : 'COALESCE(v."dueOn", v."givenOn") ASC NULLS LAST, u."name"'),
    });
};

BOARDS.checkups = (S, f, s, today) => {
    const p = params([S]);
    const where = ['k."school" = $1', 'k."archivedAt" IS NULL', `k."status" <> 'cancelled'`];
    studentFilters(where, p.$, f, { extraSearch: ['k."sessionName"', 'k."findings"'] });
    if (R.CHECKUP_TYPE[f.type]) where.push(`k."type" = ${p.$(f.type)}`);
    if (f.sessionId) where.push(`k."sessionId" = ${p.$(String(f.sessionId))}`);
    dateFilters(where, p.$, f, 'COALESCE(k."checkedOn", k."scheduledOn")', { day: true });
    const t = p.$(today);
    return board({
        from: `"medicalcheckups" k ${STUDENT_JOIN('k."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['completed', 'Completed', `k."status" = 'completed'`],
            ['scheduled', 'Scheduled', `k."status" = 'scheduled'`],
            ['attention', 'Needs Attention', `k."outcome" IN ('attention','referred')`],
            ['follow_up', 'Follow-up', `k."followUp"->>'status' = 'pending'`],
            ['all', 'All', 'TRUE'],
        ],
        select: `k.*, k."_id"::text AS "_id", (k."status" = 'scheduled' AND ${storedDay('k."scheduledOn"')} < ${t}::date) AS "missedDate", ${STUDENT_SELECT}`,
        order: (tab) => (tab === 'scheduled' ? 'k."scheduledOn" ASC, c."classNumber" NULLS LAST, c."className", cs."sectionName", u."name"' : 'COALESCE(k."checkedOn", k."scheduledOn") DESC, u."name"'),
        map: (r) => ({ ...withClass(r), followUpState: R.followUpState(r.followUp, today) }),
    });
};

BOARDS.documents = (S, f, s, today) => {
    const p = params([S]);
    const where = ['d."school" = $1', f.archived === '1' ? 'd."archivedAt" IS NOT NULL' : 'd."archivedAt" IS NULL'];
    studentFilters(where, p.$, f, { extraSearch: ['d."title"'] });
    if (R.DOC_TYPE[f.type]) where.push(`d."type" = ${p.$(f.type)}`);
    if (R.DOC_VISIBILITY[f.visibility]) where.push(`d."visibility" = ${p.$(f.visibility)}`);
    const t = p.$(today);
    const days = p.$(s.documentExpiryDays);
    return board({
        from: `"medicaldocuments" d ${STUDENT_JOIN('d."student"')}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['all', 'All', 'TRUE'],
            ['pending', 'Waiting for Review', `d."status" = 'pending'`],
            ['expiring', 'Expiring', `d."expiresOn" IS NOT NULL AND ${storedDay('d."expiresOn"')} <= ${t}::date + ${days}::int`],
            ['family', 'Shared with Family', `d."visibility" = 'family'`],
            ['staff', 'Staff Only', `d."visibility" IN ('staff','confidential')`],
        ],
        select: `d."_id", d."type", d."title", d."documentDate", d."expiresOn", d."mime", d."size", d."visibility", d."status", d."remarks",
                 d."linkKind", d."linkId"::text AS "linkId", d."uploadedByName", d."uploadedByRole", d."createdAt", d."archivedAt", d."archiveReason",
                 d."originalName", (d."expiresOn" IS NOT NULL AND ${storedDay('d."expiresOn"')} < ${t}::date) AS "expired", ${STUDENT_SELECT}`,
        order: (tab) => (tab === 'expiring' ? 'd."expiresOn" ASC' : 'd."createdAt" DESC'),
    });
};

BOARDS.items = (S, f, s, today) => {
    const p = params([S]);
    const kind = f.kind === 'supply' ? 'supply' : 'medicine';
    const where = ['i."school" = $1', `i."kind" = ${p.$(kind)}`];
    if (f.q) { const k = p.$(like(f.q)); where.push(`(i."name" ILIKE ${k} OR i."genericName" ILIKE ${k} OR i."category" ILIKE ${k})`); }
    if (f.category) where.push(`i."category" = ${p.$(String(f.category))}`);
    const t = p.$(today);
    const a = p.$(s.expiryAlertDays);
    return board({
        from: `"medicalitems" i ${BATCH_LATERAL(t, a)}`,
        where, p, tab: f.tab, page: f.page, limit: f.limit, map: (r) => r,
        tabs: [
            ['all', 'All', 'i."isActive" IS NOT FALSE'],
            ['low', 'Low Stock', `i."isActive" IS NOT FALSE AND i."minStock" > 0 AND bt.usable <= i."minStock"`],
            ['out', 'Out of Stock', `i."isActive" IS NOT FALSE AND bt.usable <= 0`],
            ['expiring', 'Expiring Soon', `i."isActive" IS NOT FALSE AND bt.expiring > 0`],
            ['expired', 'Expired Stock', `i."isActive" IS NOT FALSE AND bt.expired > 0`],
            ['archived', 'Archived', `i."isActive" IS FALSE`],
        ],
        select: `i."_id", i."kind", i."name", i."genericName", i."category", i."form", i."strength", i."unit", i."supplier", i."storageLocation",
                 i."minStock", i."prescriptionOnly", i."stock", i."remarks", i."isActive", i."updatedAt",
                 bt.usable, bt.expiring, bt.expired, bt."nextExpiry", bt.batches`,
        order: (tab) => (tab === 'low' ? '(bt.usable / NULLIF(i."minStock", 0)) ASC NULLS LAST, i."name"' : tab === 'expiring' ? 'bt."nextExpiry" ASC NULLS LAST' : 'i."name"'),
    });
};

BOARDS.batches = (S, f, s, today) => {
    const p = params([S]);
    const where = ['b."school" = $1'];
    if (f.kind === 'medicine' || f.kind === 'supply') where.push(`i."kind" = ${p.$(f.kind)}`);
    if (isUuid(f.item)) where.push(`b."item" = ${p.$(f.item)}::uuid`);
    if (f.q) { const k = p.$(like(f.q)); where.push(`(i."name" ILIKE ${k} OR b."batchNumber" ILIKE ${k})`); }
    const t = p.$(today);
    const a = p.$(s.expiryAlertDays);
    return board({
        from: `"medicalbatches" b JOIN "medicalitems" i ON i."_id" = b."item"`,
        where, p, tab: f.tab, page: f.page, limit: f.limit, map: (r) => ({ ...r, state: R.batchState(r, today, s.expiryAlertDays) }),
        tabs: [
            ['expiring', 'Expiring Soon', `b."status" = 'active' AND b."quantity" > 0 AND b."expiryDate" IS NOT NULL AND ${storedDay('b."expiryDate"')} >= ${t}::date AND ${storedDay('b."expiryDate"')} <= ${t}::date + ${a}::int`],
            ['expired', 'Expired (on shelf)', `b."status" = 'active' AND b."quantity" > 0 AND b."expiryDate" IS NOT NULL AND ${storedDay('b."expiryDate"')} < ${t}::date`],
            ['active', 'In Stock', `b."status" = 'active' AND b."quantity" > 0`],
            ['written_off', 'Written Off', `b."status" IN ('expired','damaged','disposed')`],
            ['all', 'All', 'TRUE'],
        ],
        select: `b."_id", b."item"::text AS "item", b."batchNumber", b."quantity", b."received", b."unitCost", b."supplier", b."purchaseDate",
                 b."expiryDate", b."status", b."note", b."createdAt", i."name", i."kind", i."unit", i."strength",
                 (${storedDay('b."expiryDate"')} - ${t}::date)::int AS "daysLeft"`,
        order: (tab) => (tab === 'written_off' ? 'b."updatedAt" DESC' : 'b."expiryDate" ASC NULLS LAST, i."name"'),
    });
};

BOARDS.moves = (S, f) => {
    const p = params([S]);
    const where = ['m."school" = $1'];
    if (f.kind === 'medicine' || f.kind === 'supply') where.push(`m."kind" = ${p.$(f.kind)}`);
    if (isUuid(f.item)) where.push(`m."item" = ${p.$(f.item)}::uuid`);
    if (f.q) { const k = p.$(like(f.q)); where.push(`(i."name" ILIKE ${k} OR m."reason" ILIKE ${k} OR su."name" ILIKE ${k} OR b."batchNumber" ILIKE ${k})`); }
    dateFilters(where, p.$, f, 'm."createdAt"');
    return board({
        from: `"medicalstockmoves" m JOIN "medicalitems" i ON i."_id" = m."item" LEFT JOIN "medicalbatches" b ON b."_id" = m."batch" LEFT JOIN "users" su ON su."_id" = m."student"`,
        where, p, tab: f.tab, page: f.page, limit: f.limit, map: (r) => r,
        tabs: [
            ['all', 'All', 'TRUE'],
            ['in', 'Stock In', `m."type" IN ('stock_in','returned')`],
            ['used', 'Used', `m."type" IN ('administered','first_aid')`],
            ['out', 'Stock Out', `m."type" = 'stock_out'`],
            ['adjust', 'Adjustments', `m."type" = 'adjustment'`],
            ['written_off', 'Written Off', `m."type" IN ('expired','damaged','disposed')`],
        ],
        select: `m."_id", m."type", m."quantity", m."itemBalance", m."batchBalance", m."reason", m."refKind", m."refId"::text AS "refId", m."byName", m."createdAt",
                 m."kind", i."_id"::text AS "item", i."name", i."unit", i."strength", b."batchNumber", su."name" AS "studentName", m."student"::text AS "student"`,
        order: 'm."createdAt" DESC',
    });
};

BOARDS.equipment = (S, f, s, today) => {
    const p = params([S]);
    const where = ['e."school" = $1'];
    if (f.q) { const k = p.$(like(f.q)); where.push(`(e."name" ILIKE ${k} OR e."serialNumber" ILIKE ${k} OR e."location" ILIKE ${k})`); }
    if (R.EQUIP_TYPE[f.type]) where.push(`e."type" = ${p.$(f.type)}`);
    if (R.EQUIP_CONDITION[f.condition]) where.push(`e."condition" = ${p.$(f.condition)}`);
    const t = p.$(today);
    const d = p.$(s.maintenanceDueDays);
    return board({
        from: `"medicalequipments" e`,
        where, p, tab: f.tab, page: f.page, limit: f.limit, map: (r) => r,
        tabs: [
            ['all', 'All', `e."archivedAt" IS NULL AND e."status" <> 'retired'`],
            ['due', 'Maintenance Due', `e."archivedAt" IS NULL AND e."status" <> 'retired' AND e."nextMaintenanceOn" IS NOT NULL AND ${storedDay('e."nextMaintenanceOn"')} <= ${t}::date + ${d}::int`],
            ['available', 'Available', `e."archivedAt" IS NULL AND e."status" = 'available'`],
            ['in_use', 'In Use', `e."archivedAt" IS NULL AND e."status" = 'in_use'`],
            ['maintenance', 'Under Maintenance', `e."archivedAt" IS NULL AND e."status" = 'under_maintenance'`],
            ['out', 'Out of Service', `e."archivedAt" IS NULL AND e."status" = 'out_of_service'`],
            ['retired', 'Retired', `(e."status" = 'retired' OR e."archivedAt" IS NOT NULL)`],
        ],
        select: `e.*, e."_id"::text AS "_id", (e."nextMaintenanceOn" IS NOT NULL AND ${storedDay('e."nextMaintenanceOn"')} < ${t}::date) AS "maintenanceOverdue",
                 (${storedDay('e."nextMaintenanceOn"')} - ${t}::date)::int AS "daysToMaintenance"`,
        order: (tab) => (tab === 'due' ? 'e."nextMaintenanceOn" ASC' : 'e."name"'),
    });
};

BOARDS.changes = (S, f) => {
    const p = params([S]);
    const where = ['cr."school" = $1'];
    studentFilters(where, p.$, f, { extraSearch: ['cr."submittedByName"'] });
    if (R.CHANGE_KIND[f.kind]) where.push(`cr."kind" = ${p.$(f.kind)}`);
    return board({
        from: `"medicalchangerequests" cr ${STUDENT_JOIN('cr."student"')} LEFT JOIN "medicaldocuments" d ON d."_id" = cr."document"`,
        where, p, tab: f.tab, page: f.page, limit: f.limit,
        tabs: [
            ['pending', 'Waiting', `cr."status" = 'pending'`],
            ['approved', 'Approved', `cr."status" = 'approved'`],
            ['rejected', 'Not Accepted', `cr."status" = 'rejected'`],
            ['withdrawn', 'Withdrawn', `cr."status" = 'withdrawn'`],
            ['all', 'All', 'TRUE'],
        ],
        select: `cr."_id", cr."kind", cr."action", cr."payload", cr."note", cr."status", cr."reviewNote", cr."reviewedByName", cr."reviewedAt",
                 cr."createdAt", cr."submittedByName", cr."target"::text AS "target", cr."document"::text AS "document", d."title" AS "documentTitle",
                 d."mime" AS "documentMime", ${STUDENT_SELECT}, cr."student"::text AS "student"`,
        order: (tab) => (tab === 'pending' ? 'cr."createdAt" ASC' : 'cr."createdAt" DESC'),
    });
};

BOARDS.audit = (S, f) => {
    const p = params([S]);
    // Safeguarding is the leads' own record: its trail is kept, never listed here.
    const where = ['l."school" = $1', `l."entity" <> 'safeguarding'`];
    if (f.q) { const k = p.$(like(f.q)); where.push(`(l."actorName" ILIKE ${k} OR l."summary" ILIKE ${k} OR su."name" ILIKE ${k})`); }
    if (isUuid(f.student)) where.push(`l."student" = ${p.$(f.student)}::uuid`);
    if (isUuid(f.actor)) where.push(`l."actor" = ${p.$(f.actor)}::uuid`);
    if (f.entity) where.push(`l."entity" = ${p.$(String(f.entity).slice(0, 40))}`);
    dateFilters(where, p.$, f, 'l."createdAt"');
    return board({
        from: `"medicalauditlogs" l LEFT JOIN "users" su ON su."_id" = l."student"`,
        where, p, tab: f.tab, page: f.page, limit: f.limit || 30, map: (r) => r,
        tabs: [
            ['all', 'All Activity', 'TRUE'],
            ['changes', 'Changes', `l."action" <> 'viewed'`],
            ['views', 'Record Views', `l."action" = 'viewed'`],
            ['emergency', 'Emergency Access', `l."entity" = 'emergency_profile'`],
            ['documents', 'Documents', `l."entity" = 'document'`],
            ['medicines', 'Medicines', `l."entity" IN ('dose','medication_plan','medicine','supply','batch')`],
        ],
        select: `l."_id", l."action", l."entity", l."entityId"::text AS "entityId", l."summary", l."changes", l."actorName", l."actorRole",
                 l."createdAt", l."ip", su."name" AS "studentName", l."student"::text AS "student"`,
        order: 'l."createdAt" DESC',
    });
};

async function listBoard(req, screen, query = {}) {
    const fn = BOARDS[screen];
    if (!fn) return null;
    const s = await settingsSvc.get(req.schoolId);
    return fn(String(req.schoolId), query, s, todayStr());
}

/* ── The room, live ───────────────────────────────────────────────────────── */

async function room(req) {
    const S = String(req.schoolId);
    const today = todayStr();
    // One room of several (?room=<place>): its visits and beds; the main room also has those with no place.
    const roomId = isUuid(req.query?.room) ? String(req.query.room) : null;
    let main = false;
    if (roomId) {
        const [p] = await run(`SELECT "isMain" FROM "medicallocations" WHERE "_id" = $1 AND "school" = $2`, [roomId, S]);
        main = !!p?.isMain;
    }
    const inRoom = (col) => (roomId ? ` AND (${col} = '${roomId}'::uuid${main ? ` OR ${col} IS NULL` : ''})` : '');
    const [active, beds, todayList, awaiting] = await Promise.all([
        run(`SELECT v."_id", v."number", v."reason", v."symptoms", v."status", v."arrivedAt", v."handledByName", v."vitals", v."treatment",
                    v."restAdvised", v."restMinutes", v."bed"::text AS "bed", v."bedIn", b."label" AS "bedLabel", v."medicines", v."parentContacted",
                    v."triage", v."protocol"->>'key' AS "protocolKey", v."nextCheckAt", jsonb_array_length(COALESCE(v."readings", '[]'::jsonb)) AS "readingCount",
                    v."request"::text AS "request", ${STUDENT_SELECT}, v."student"::text AS "student"
               FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')} LEFT JOIN "medicalbeds" b ON b."_id" = v."bed"
              WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."status" IN ('in_room','observation','emergency')${inRoom('v."location"')}
              ORDER BY CASE v."status" WHEN 'emergency' THEN 0 ELSE 1 END,
                       CASE v."triage"->>'level' WHEN 'red' THEN 0 WHEN 'orange' THEN 1 WHEN 'yellow' THEN 2 WHEN 'green' THEN 3 WHEN 'blue' THEN 4 ELSE 3 END,
                       CASE v."status" WHEN 'observation' THEN 0 ELSE 1 END, v."arrivedAt" ASC`, [S]),
        run(`SELECT b."_id", b."label", b."kind", b."status", b."since", b."note", b."sortOrder", b."visit"::text AS "visit",
                    v."number" AS "visitNumber", v."reason", v."bedIn", v."status" AS "visitStatus", u."name" AS "studentName", u."profileImage" AS "studentPhoto"
               FROM "medicalbeds" b LEFT JOIN "medicalvisits" v ON v."_id" = b."visit" LEFT JOIN "users" u ON u."_id" = v."student"
              WHERE b."school" = $1 AND b."isActive" IS NOT FALSE${inRoom('b."location"')} ORDER BY b."sortOrder", b."label"`, [S]),
        run(`SELECT v."status", count(*)::int AS n FROM "medicalvisits" v
              WHERE v."school" = $1 AND v."archivedAt" IS NULL AND ${localDay('v."arrivedAt"')} = $2::date GROUP BY v."status"`, [S, today]),
        // Sent home and still waiting at school: nobody has been recorded as collecting them.
        run(`SELECT v."_id", v."number", v."reason", v."status", v."arrivedAt", v."departedAt", v."parentContacted", v."parentContactNote",
                    ${STUDENT_SELECT}, v."student"::text AS "student"
               FROM "medicalvisits" v ${STUDENT_JOIN('v."student"')}
              WHERE v."school" = $1 AND v."archivedAt" IS NULL AND v."status" = 'sent_home'
                AND (v."collection" IS NULL OR v."collection"->>'at' IS NULL)
                AND v."departedAt" > now() - interval '18 hours'
              ORDER BY v."departedAt" ASC`, [S]),
    ]);
    const counts = Object.fromEntries(todayList.map((r) => [r.status, r.n]));
    const now = Date.now();
    return {
        active: active.map((v) => ({
            ...withClass(v), flags: R.vitalFlags(v.vitals || {}),
            recheckDue: !!v.nextCheckAt && new Date(v.nextCheckAt).getTime() <= now,
        })),
        awaiting: awaiting.map(withClass),
        beds,
        today: {
            total: todayList.reduce((n, r) => n + r.n, 0),
            returned: counts.returned || 0, sentHome: counts.sent_home || 0, referred: counts.referred || 0, closed: counts.closed || 0,
        },
    };
}

/* ── Today's medication round ─────────────────────────────────────────────── */

async function administration(req, day = todayStr()) {
    const S = String(req.schoolId);
    const d = isDay(day) ? day : todayStr();
    if (d >= addDays(todayStr(), -1)) await meds.ensureDoses(req.schoolId, d);
    const doses = await run(
        `SELECT dd."_id", dd."medicineName", dd."dosage", dd."quantity", dd."scheduledFor", dd."status", dd."givenAt", dd."givenByName", dd."note",
                dd."plan"::text AS "plan", pl."instructions", pl."route", pl."source", pl."item"::text AS "item", it."unit" AS "itemUnit",
                COALESCE((SELECT SUM(b."quantity") FROM "medicalbatches" b WHERE b."item" = it."_id" AND b."status" = 'active'
                    AND (b."expiryDate" IS NULL OR ${storedDay('b."expiryDate"')} >= $3::date)), 0)::float8 AS "itemStock",
                ${STUDENT_SELECT}, dd."student"::text AS "student"
           FROM "medicationdoses" dd ${STUDENT_JOIN('dd."student"')}
           LEFT JOIN "medicationplans" pl ON pl."_id" = dd."plan" LEFT JOIN "medicalitems" it ON it."_id" = pl."item"
          WHERE dd."school" = $1 AND dd."scheduledFor" IS NOT NULL AND ${localDay('dd."scheduledFor"')} = $2::date
          ORDER BY dd."scheduledFor" ASC, u."name"`,
        [S, d, todayStr()],
    );
    const asNeeded = await run(
        `SELECT pl."_id", pl."medicineName", pl."dosage", pl."instructions", pl."source", pl."quantityPerDose", ${STUDENT_SELECT}, pl."student"::text AS "student"
           FROM "medicationplans" pl ${STUDENT_JOIN('pl."student"')}
          WHERE pl."school" = $1 AND pl."status" = 'active' AND pl."frequency" = 'as_needed'
            AND ${storedDay('pl."startDate"')} <= $2::date AND (pl."endDate" IS NULL OR ${storedDay('pl."endDate"')} >= $2::date)
          ORDER BY u."name"`,
        [S, d],
    );
    const counts = { scheduled: 0, given: 0, missed: 0, refused: 0, cancelled: 0, overdue: 0 };
    const now = Date.now();
    for (const x of doses) {
        counts[x.status] = (counts[x.status] || 0) + 1;
        if (x.status === 'scheduled' && new Date(x.scheduledFor).getTime() < now) counts.overdue += 1;
    }
    return { day: d, doses: doses.map(withClass), asNeeded: asNeeded.map(withClass), counts };
}

module.exports = { overview, listBoard, room, administration, BOARDS, STUDENT_SELECT, STUDENT_JOIN, withClass, params, like, localDay, storedDay, board };
