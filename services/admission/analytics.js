'use strict';
/**
 * The admission dashboard's figures — every one an aggregate computed in
 * Postgres over the school's own rows, never a list sent to the browser to
 * count. Filters: academic year, round, class, campus (the round's), status
 * and a date range on when the application was started.
 */
const pool = require('../../db/pool');
const seats = require('./seats');
const workflow = require('./workflow');
const { isId } = require('./util');

/** The WHERE clause every application query shares. `a` is admissionapplications. */
function scope(schoolId, f = {}) {
    const params = [String(schoolId)];
    const where = ['a."school" = $1'];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (isId(String(f.academicYear || ''))) add('a."academicYear" = ?', String(f.academicYear));
    if (isId(String(f.round || ''))) add('a."round" = ?', String(f.round));
    if (isId(String(f.class || ''))) add('a."class" = ?', String(f.class));
    if (f.campus) add(`EXISTS (SELECT 1 FROM "admissionrounds" r WHERE r."_id" = a."round" AND r."campus" = ?)`, String(f.campus));
    if (f.status && workflow.STATUSES[f.status]) add('a."status" = ?', String(f.status));
    if (f.from && !Number.isNaN(new Date(f.from).getTime())) add('a."createdAt" >= ?', new Date(f.from));
    if (f.to && !Number.isNaN(new Date(f.to).getTime())) add('a."createdAt" < ?', new Date(new Date(f.to).getTime() + 86400000));
    return { where: where.join(' AND '), params };
}

const UNDER_VERIFICATION = ['submitted', 'under_review', 'documents_pending', 'documents_rejected'];
const SELECTED_ON = ['selected', 'offer_issued', 'accepted', 'payment_pending', 'confirmed', 'enrolled'];

async function overview(schoolId, f = {}) {
    const s = scope(schoolId, f);
    const q = (sql, p = s.params) => pool.query(sql, p).then((r) => r.rows);
    const sid = String(schoolId);

    const [
        [counts], [guests], [enquiries], [exams], [lists], [fees], [outstanding], byClass, overTime, sources, docBacklog, scoreBuckets,
        examAttendance, listConversion, feeByMonth, docTypes,
    ] = await Promise.all([
        q(`SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE a."status" = 'draft')::int AS drafts,
                  COUNT(*) FILTER (WHERE a."submittedAt" IS NOT NULL)::int AS submitted,
                  COUNT(*) FILTER (WHERE a."status" = 'incomplete')::int AS incomplete,
                  COUNT(*) FILTER (WHERE a."status" = ANY($${s.params.length + 1}::text[]))::int AS "underVerification",
                  COUNT(*) FILTER (WHERE a."status" IN ('verified', 'eligible'))::int AS eligible,
                  COUNT(*) FILTER (WHERE a."status" = 'exam_scheduled')::int AS "examScheduled",
                  COUNT(*) FILTER (WHERE a."status" IN ('exam_completed', 'interview_completed', 'evaluated'))::int AS "examCompleted",
                  COUNT(*) FILTER (WHERE a."status" = ANY($${s.params.length + 2}::text[]))::int AS selected,
                  COUNT(*) FILTER (WHERE a."status" = 'waitlisted')::int AS waitlisted,
                  COUNT(*) FILTER (WHERE a."status" IN ('offer_issued', 'accepted', 'payment_pending'))::int AS "offersOpen",
                  COUNT(*) FILTER (WHERE a."status" IN ('confirmed', 'enrolled'))::int AS confirmed,
                  COUNT(*) FILTER (WHERE a."status" = 'enrolled')::int AS enrolled,
                  COUNT(*) FILTER (WHERE a."status" IN ('rejected', 'ineligible'))::int AS rejected,
                  COUNT(*) FILTER (WHERE a."status" IN ('withdrawn', 'cancelled', 'declined'))::int AS dropped,
                  COUNT(*) FILTER (WHERE a."pendingTransition" IS NOT NULL)::int AS "awaitingApproval",
                  COUNT(*) FILTER (WHERE (a."flags"->'duplicateOf') IS NOT NULL AND jsonb_array_length(a."flags"->'duplicateOf') > 0)::int AS duplicates
             FROM "admissionapplications" a WHERE ${s.where}`, [...s.params, UNDER_VERIFICATION, SELECTED_ON]),
        q(`SELECT COUNT(*)::int AS n FROM "users" u WHERE u."school" = $1 AND u."role" = 'guest'`, [sid]),
        q(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE "status" = 'new')::int AS "open" FROM "admissionenquiries" WHERE "school" = $1`, [sid]),
        q(`SELECT COUNT(*) FILTER (WHERE e."status" = 'scheduled' AND e."startsAt" > now())::int AS upcoming,
                  COUNT(*) FILTER (WHERE e."status" = 'completed' OR (e."status" = 'scheduled' AND COALESCE(e."endsAt", e."startsAt") < now()))::int AS completed,
                  COUNT(*) FILTER (WHERE e."resultsStatus" IN ('in_progress', 'submitted', 'approved'))::int AS "resultsPending"
             FROM "admissionexams" e WHERE e."school" = $1 ${isId(String(f.round || '')) ? 'AND e."round" = $2' : ''}`, isId(String(f.round || '')) ? [sid, String(f.round)] : [sid]),
        q(`SELECT COUNT(*) FILTER (WHERE l."listNo" = 1 AND e."decision" = 'selected')::int AS first,
                  COUNT(*) FILTER (WHERE l."listNo" = 2 AND e."decision" = 'selected')::int AS second,
                  COUNT(*) FILTER (WHERE l."listNo" >= 3 AND e."decision" = 'selected')::int AS later
             FROM "admissionlistentries" e JOIN "admissionlists" l ON l."_id" = e."list" AND l."status" IN ('published', 'closed')
             JOIN "admissionapplications" a ON a."_id" = e."application" WHERE ${s.where}`),
        q(`SELECT COALESCE(SUM(p."amount") FILTER (WHERE p."kind" = 'application_fee'), 0)::float8 AS application,
                  COALESCE(SUM(p."amount") FILTER (WHERE p."kind" = 'admission_fee'), 0)::float8 AS admission,
                  COUNT(*)::int AS payments
             FROM "admissionpayments" p JOIN "admissionapplications" a ON a."_id" = p."application"
            WHERE p."status" = 'paid' AND ${s.where}`),
        q(`SELECT COALESCE(SUM(GREATEST(0, x.fee - x.waived - x.paid)), 0)::float8 AS due, COUNT(*) FILTER (WHERE x.fee - x.waived - x.paid > 0)::int AS families FROM (
             SELECT a."_id", k.kind,
                    CASE k.kind WHEN 'application_fee' THEN a."applicationFeeAmount" ELSE a."admissionFeeAmount" END AS fee,
                    COALESCE((SELECT SUM((w->>'amount')::float8) FROM jsonb_array_elements(COALESCE(a."feeWaivers", '[]'::jsonb)) w WHERE w->>'kind' = k.kind), 0) AS waived,
                    COALESCE((SELECT SUM(p."amount") FROM "admissionpayments" p WHERE p."application" = a."_id" AND p."kind" = k.kind AND p."status" = 'paid'), 0) AS paid
               FROM "admissionapplications" a CROSS JOIN (VALUES ('application_fee'), ('admission_fee')) k(kind)
              WHERE ${s.where} AND a."status" NOT IN ('withdrawn', 'cancelled', 'rejected', 'ineligible', 'declined', 'offer_expired', 'draft')
                AND ((k.kind = 'application_fee' AND a."applicationFeeStatus" = 'due') OR (k.kind = 'admission_fee' AND a."admissionFeeStatus" = 'due'))
           ) x`),
        q(`SELECT a."class", c."className", c."classNumber",
                  COUNT(*)::int AS total, COUNT(*) FILTER (WHERE a."submittedAt" IS NOT NULL)::int AS submitted,
                  COUNT(*) FILTER (WHERE a."status" = ANY($${s.params.length + 1}::text[]))::int AS selected,
                  COUNT(*) FILTER (WHERE a."status" IN ('confirmed', 'enrolled'))::int AS confirmed
             FROM "admissionapplications" a LEFT JOIN "classes" c ON c."_id" = a."class"
            WHERE ${s.where} GROUP BY a."class", c."className", c."classNumber" ORDER BY c."classNumber" NULLS LAST, c."className"`, [...s.params, SELECTED_ON]),
        q(`SELECT to_char(date_trunc('day', a."submittedAt"), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
             FROM "admissionapplications" a WHERE ${s.where} AND a."submittedAt" IS NOT NULL AND a."submittedAt" > now() - interval '90 days'
            GROUP BY 1 ORDER BY 1`),
        q(`SELECT COALESCE(NULLIF(a."source", ''), 'Direct') AS source, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE a."submittedAt" IS NOT NULL)::int AS submitted
             FROM "admissionapplications" a WHERE ${s.where} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
        q(`SELECT COUNT(*) FILTER (WHERE now() - d."createdAt" < interval '2 days')::int AS fresh,
                  COUNT(*) FILTER (WHERE now() - d."createdAt" >= interval '2 days' AND now() - d."createdAt" < interval '7 days')::int AS week,
                  COUNT(*) FILTER (WHERE now() - d."createdAt" >= interval '7 days')::int AS old
             FROM "admissiondocuments" d JOIN "admissionapplications" a ON a."_id" = d."application"
            WHERE d."current" AND d."status" IN ('uploaded', 'under_review') AND a."status" <> 'draft' AND ${s.where}`),
        q(`SELECT width_bucket(LEAST(r."percentage", 99.999), 0, 100, 10) AS bucket, COUNT(*)::int AS n
             FROM "admissionresults" r JOIN "admissionapplications" a ON a."_id" = r."application"
            WHERE r."status" IN ('approved', 'published') AND r."percentage" IS NOT NULL AND NOT r."absent" AND ${s.where}
              ${isId(String(f.exam || '')) ? `AND r."exam" = '${String(f.exam)}'` : ''}
            GROUP BY 1 ORDER BY 1`),
        q(`SELECT e."_id", e."name", e."mode", e."startsAt",
                  COUNT(c."_id") FILTER (WHERE c."status" <> 'withdrawn')::int AS scheduled,
                  COUNT(c."_id") FILTER (WHERE c."status" IN ('present', 'attempted', 'evaluated'))::int AS present,
                  COUNT(c."_id") FILTER (WHERE c."status" = 'absent')::int AS absent,
                  COUNT(r."_id") FILTER (WHERE r."passed" IS TRUE AND r."status" IN ('approved', 'published'))::int AS passed,
                  COUNT(r."_id") FILTER (WHERE r."passed" IS FALSE AND NOT r."absent" AND r."status" IN ('approved', 'published'))::int AS failed
             FROM "admissionexams" e
             LEFT JOIN "admissioncandidates" c ON c."exam" = e."_id"
             LEFT JOIN "admissionresults" r ON r."exam" = e."_id" AND r."application" = c."application"
            WHERE e."school" = $1 AND e."status" <> 'cancelled' ${isId(String(f.round || '')) ? 'AND e."round" = $2' : ''}
            GROUP BY e."_id" ORDER BY e."startsAt" DESC LIMIT 12`, isId(String(f.round || '')) ? [sid, String(f.round)] : [sid]),
        q(`SELECT l."_id", l."name", l."listNo", c."className",
                  COUNT(e."_id") FILTER (WHERE e."decision" = 'selected')::int AS selected,
                  COUNT(e."_id") FILTER (WHERE e."decision" = 'waitlisted')::int AS waitlisted,
                  COUNT(o."_id") FILTER (WHERE o."status" IN ('accepted', 'confirmed'))::int AS accepted,
                  COUNT(o."_id") FILTER (WHERE o."status" = 'confirmed')::int AS confirmed,
                  COUNT(o."_id") FILTER (WHERE o."status" IN ('declined', 'expired', 'withdrawn'))::int AS lapsed,
                  COUNT(e."_id") FILTER (WHERE e."reason" = 'Promoted from the waiting list')::int AS promoted
             FROM "admissionlists" l
             LEFT JOIN "classes" c ON c."_id" = l."class"
             LEFT JOIN "admissionlistentries" e ON e."list" = l."_id"
             LEFT JOIN "admissionoffers" o ON o."_id" = e."offer"
            WHERE l."school" = $1 AND l."status" IN ('published', 'closed') ${isId(String(f.round || '')) ? 'AND l."round" = $2' : ''}
            GROUP BY l."_id", c."className" ORDER BY l."publishedAt" DESC NULLS LAST LIMIT 12`, isId(String(f.round || '')) ? [sid, String(f.round)] : [sid]),
        q(`SELECT to_char(date_trunc('month', p."paidAt"), 'YYYY-MM') AS month,
                  COALESCE(SUM(p."amount") FILTER (WHERE p."kind" = 'application_fee'), 0)::float8 AS application,
                  COALESCE(SUM(p."amount") FILTER (WHERE p."kind" = 'admission_fee'), 0)::float8 AS admission
             FROM "admissionpayments" p JOIN "admissionapplications" a ON a."_id" = p."application"
            WHERE p."status" = 'paid' AND p."paidAt" > now() - interval '12 months' AND ${s.where}
            GROUP BY 1 ORDER BY 1`),
        q(`SELECT t."name", COUNT(*)::int AS n
             FROM "admissiondocuments" d JOIN "admissionapplications" a ON a."_id" = d."application"
             LEFT JOIN "admissiondocumenttypes" t ON t."_id" = d."docType"
            WHERE d."current" AND d."status" IN ('uploaded', 'under_review') AND a."status" <> 'draft' AND ${s.where}
            GROUP BY t."name" ORDER BY 2 DESC LIMIT 8`),
    ]);

    // Seats: every open (or the chosen) round's classes.
    const roundFilter = isId(String(f.round || '')) ? [String(f.round)] : (await q(`SELECT "_id" FROM "admissionrounds" WHERE "school" = $1 AND "status" IN ('open', 'closed') ${isId(String(f.academicYear || '')) ? 'AND "academicYear" = $2' : ''}`, isId(String(f.academicYear || '')) ? [sid, String(f.academicYear)] : [sid])).map((r) => r._id);
    const seatRows = [];
    for (const id of roundFilter.slice(0, 10)) seatRows.push(...(await seats.roundState(id)).map((r) => ({ ...r, round: String(id) })));
    const classNames = new Map(byClass.map((c) => [String(c.class), c.className]));
    if (seatRows.some((r) => !classNames.has(r.class))) {
        const { rows } = await pool.query(`SELECT "_id", "className" FROM "classes" WHERE "_id" = ANY($1::uuid[])`, [seatRows.map((r) => r.class)]);
        rows.forEach((r) => classNames.set(String(r._id), r.className));
    }
    const seatByClass = new Map();
    for (const r of seatRows.filter((x) => !isId(String(f.class || '')) || x.class === String(f.class))) {
        const cur = seatByClass.get(r.class) || { class: r.class, className: classNames.get(r.class) || '', capacity: 0, taken: 0, unlimited: false };
        cur.capacity += r.capacity; cur.taken += r.taken; if (!r.capacity) cur.unlimited = true;
        seatByClass.set(r.class, cur);
    }
    const seatList = [...seatByClass.values()];
    const availableSeats = seatList.filter((x) => !x.unlimited).reduce((sum, x) => sum + Math.max(0, x.capacity - x.taken), 0);

    const funnel = [
        { key: 'enquiries', label: 'Enquiries', n: enquiries.n },
        { key: 'accounts', label: 'Accounts created', n: guests.n },
        { key: 'started', label: 'Applications started', n: counts.total },
        { key: 'submitted', label: 'Submitted', n: counts.submitted },
        { key: 'reviewed', label: 'Verified / eligible', n: counts.eligible + counts.examScheduled + counts.examCompleted + counts.selected + counts.waitlisted },
        { key: 'selected', label: 'Selected', n: counts.selected },
        { key: 'confirmed', label: 'Confirmed', n: counts.confirmed },
        { key: 'enrolled', label: 'Enrolled', n: counts.enrolled },
    ];

    return {
        kpis: {
            guests: guests.n, enquiries: enquiries.n, openEnquiries: enquiries.open,
            ...counts,
            upcomingExams: exams.upcoming, examsCompleted: exams.completed, resultsPending: exams.resultsPending,
            firstList: lists.first, secondList: lists.second, laterLists: lists.later,
            availableSeats, seatsUnlimited: seatList.some((x) => x.unlimited),
            applicationFees: fees.application, admissionFees: fees.admission, payments: fees.payments,
            outstanding: outstanding.due, outstandingFamilies: outstanding.families,
            completionRate: counts.total ? Math.round((counts.submitted / counts.total) * 1000) / 10 : null,
            selectionToConfirmation: counts.selected ? Math.round((counts.confirmed / counts.selected) * 1000) / 10 : null,
        },
        funnel,
        byClass,
        seats: seatList,
        overTime,
        sources,
        docBacklog: { ...docBacklog[0], byType: docTypes },
        scoreDistribution: Array.from({ length: 10 }, (_, i) => ({ band: `${i * 10}–${i * 10 + 10}`, n: scoreBuckets.find((b) => Number(b.bucket) === i + 1)?.n || 0 })),
        examAttendance,
        listConversion,
        feeByMonth,
    };
}

module.exports = { overview, scope };
