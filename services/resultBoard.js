'use strict';
/**
 * The admin Results screens' read models, in SQL.
 *
 * The old list was `FormalExam.find().populate()` over one page: it could say
 * an exam's title and status and nothing else — not how many students sit it,
 * not how far marks entry has got, not which exams are waiting on the office.
 * Those are what the screen exists to answer, and each needs a join the ORM
 * would have to do in JavaScript (db/aggregate.js loads whole tables to join
 * them), so they are written here as SQL instead:
 *
 *   · overview   the four tiles, over the whole school — a filter narrows the
 *                table, never the tiles, which describe the school;
 *   · list       one page of exams with everything a row prints, plus a count
 *                for every tab under the filters in force, in one statement
 *                each (count(*) FILTER …, count(*) OVER ());
 *   · detail     one exam: its subjects with who teaches them and how far
 *                each sheet has got, its history, and its results in summary;
 *   · analytics  published results, summed every way the analytics page asks.
 *
 * STAGE is the SQL twin of resultExams.stageOf and is built from the same
 * table, so a status can never sit under a different tab here than there.
 * Every exam is in exactly one stage, which is what makes the tabs add up.
 *
 * "Today" is the school's day (config/timezone), handed in as a parameter —
 * nothing here depends on the database session's zone.
 */
const pool = require('../db/pool');
const TZ = require('../config/timezone');
const { isUuid } = require('../db/schema');
const FormalExam = require('../models/FormalExam');
const ExamMarksSheet = require('../models/ExamMarksSheet');
const FormalResult = require('../models/FormalResult');
const ClassSection = require('../models/ClassSection');
const Class = require('../models/Class');
const ClassSubject = require('../models/ClassSubject');
const AcademicYear = require('../models/AcademicYear');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const StudentProfile = require('../models/StudentProfile');
const Subject = require('../models/Subject');
const User = require('../models/User');
const { STATUS_LABELS, STAGES, MARKS_OPEN, optionsOf, offeredByClass, releaseAt, released, todayOf } = require('./resultExams');
const schoolClock = require('./schoolClock');
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const settings = require('./resultSettings');

/**
 * Grades as a screen lists them, for a distribution: the school's scale, best
 * first, then any grade found in the data that the scale no longer has (the
 * school changed scales; results keep the grades they were published with).
 */
function gradeList(scale, found = []) {
    const rows = settings.scaleRows(scale);
    const known = new Set(rows.map((r) => r.grade));
    const extra = [...new Set(found.filter((g) => g && !known.has(g) && g !== 'AB'))].sort();
    return [...rows.map((r) => ({ grade: r.grade, from: r.from, to: r.to, pass: r.pass })), ...extra.map((g) => ({ grade: g, from: null, to: null, pass: null }))];
}
/** The school's exam types, for a filter: every one, switched off or not — old exams have them. */
const typeOptions = (types) => types.map((t) => ({ value: t.key, label: t.label, kind: t.kind, active: t.active }));
const promotion = require('./resultPromotion');
const { yearOrderSql, classOrderSql, sectionOrderSql, naturalSql, newestYear } = require('../utils/listOrder');

const t = (Model) => `"${Model.tableName}"`;
const T = {
    exams: t(FormalExam), sheets: t(ExamMarksSheet), results: t(FormalResult),
    sections: t(ClassSection), classes: t(Class), classSubjects: t(ClassSubject), years: t(AcademicYear),
    sst: t(SectionSubjectTeacher), profiles: t(StudentProfile), subjects: t(Subject), users: t(User),
};

const TABS = ['all', 'draft', 'marks', 'validation', 'published', 'archived'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const share = (part, whole) => (num(whole) ? Math.round((num(part) / num(whole)) * 100) : 0);

/**
 * Positional parameters, gathered as the SQL is built. `tz()` adds the school's
 * zone the first time something asks for it — node-pg refuses a statement that
 * is handed a parameter it never mentions, and not every statement needs it.
 */
function params() {
    const list = [];
    const $ = (v) => { list.push(v); return `$${list.length}`; };
    let zone = null;
    return { list, $, tz: () => (zone || (zone = `${$(TZ)}::text`)) };
}

/* ── Fragments ────────────────────────────────────────────────────────────── */

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
/** A jsonb column as an array, whatever was stored in it. */
const jarr = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;

const STAGE = `(CASE WHEN e."archivedAt" IS NOT NULL THEN 'archived' ${
    Object.entries(STAGES).filter(([k]) => k !== 'draft')
        .map(([k, list]) => `WHEN e."status" IN (${list.map(lit).join(', ')}) THEN ${lit(k)}`).join(' ')
} ELSE 'draft' END)`;

const FROM = `
      FROM ${T.exams} e
      LEFT JOIN ${T.years} y    ON y."_id" = e."academicYear"
      LEFT JOIN ${T.sections} s ON s."_id" = e."section"
      LEFT JOIN ${T.classes} c  ON c."_id" = s."class"`;

/** An entry that says something: marks, or absent. */
const ANSWERED = `((en->>'isAbsent') = 'true' OR (en->>'marksObtained') IS NOT NULL OR COALESCE(en->>'grade', '') <> '')`;

/**
 * What the OFFICE has to do next, if anything — the "Pending Actions" tile and
 * the note under a row's status. Each is a step nobody else can take:
 *
 *   publish   validated, waiting to be published
 *   reopen    rejected; only the office can reopen
 *   validate  submitted, but the section has no class teacher to validate it
 *   open      still a draft after the exam's last day
 *   marks     marks are due for a subject nobody teaches in that section
 */
const attention = (tz) => `(CASE
        WHEN e."archivedAt" IS NOT NULL THEN NULL
        WHEN e."status" = 'CLASS_APPROVED' THEN 'publish'
        WHEN e."status" = 'REJECTED' THEN 'reopen'
        WHEN e."status" = 'SUBMITTED' AND s."classTeacher" IS NULL AND s."substituteTeacher" IS NULL THEN 'validate'
        WHEN e."status" = 'DRAFT' AND (e."endDate" AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE ${tz})::date THEN 'open'
        WHEN e."status" IN (${MARKS_OPEN.map(lit).join(', ')}) AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(${jarr('e."subjects"')}) x
             WHERE NOT EXISTS (SELECT 1 FROM ${T.sst} st WHERE st."section" = e."section" AND st."subject"::text = x->>'subject')
               AND NOT EXISTS (SELECT 1 FROM ${T.sheets} m WHERE m."exam" = e."_id" AND m."subject"::text = x->>'subject' AND m."status" = 'SUBMITTED')
        ) THEN 'marks'
        ELSE NULL END)`;

/** The section's roll, counting only ids that still name a live student account (resultExams.rosterOf). */
const ROSTER = `(SELECT count(*)::int FROM ${T.users} ru
                  WHERE ru."role" = 'student' AND ru."isActive" IS NOT FALSE
                    AND ru."_id" IN (SELECT v::uuid FROM jsonb_array_elements_text(${jarr('s."enrolledStudents"')}) v
                                      WHERE v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))`;

/** How far marks entry has got, counting only sheets of subjects still on the exam. */
const SHEETS = `
      LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE m."status" = 'SUBMITTED')::int AS "submitted",
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(${jarr('m."entries"')}) en WHERE ${ANSWERED}))::int AS "started"
            FROM ${T.sheets} m
           WHERE m."exam" = e."_id"
             AND m."subject"::text IN (SELECT x->>'subject' FROM jsonb_array_elements(${jarr('e."subjects"')}) x)
      ) ms ON true
      LEFT JOIN LATERAL (SELECT count(*)::int AS "n" FROM ${T.results} r WHERE r."exam" = e."_id") rs ON true
      LEFT JOIN ${T.users} ct ON ct."_id" = s."classTeacher"
      LEFT JOIN ${T.users} cb ON cb."_id" = e."createdBy"`;

const columns = (tz) => `
           e."_id", e."title", e."examType", e."typeKey", e."typeLabel", e."code", e."status", e."startDate", e."endDate", e."publishDate",
           e."showInPortal", e."includeInOverall", e."allowGraceMarks", e."grace", e."notifyOnPublish", e."showRank",
           e."promoteOnPass", e."promoteSection", e."failedPlacement", e."promotionState", e."promotionDueAt", e."promotedAt",
           e."finalApprovedAt", e."classApprovedAt", e."archivedAt", e."rejectionReason", e."createdAt",
           COALESCE(e."term", '') AS "term", e."marksDueDate", e."timetableShared", e."school",
           jsonb_array_length(${jarr('e."withheld"')})::int AS "withheldCount",
           e."academicYear" AS "yearId", y."yearName",
           e."section" AS "sectionId", s."sectionName", s."class" AS "classId", c."className", c."classNumber",
           (s."classTeacher" IS NOT NULL OR s."substituteTeacher" IS NOT NULL) AS "hasValidator",
           ct."name" AS "classTeacherName", cb."name" AS "createdByName",
           ${STAGE} AS "stage", ${attention(tz)} AS "attention",
           jsonb_array_length(${jarr('e."subjects"')})::int AS "subjectCount",
           ${ROSTER} AS "roster",
           COALESCE(ms."submitted", 0) AS "sheetsSubmitted", COALESCE(ms."started", 0) AS "sheetsStarted",
           COALESCE(rs."n", 0) AS "resultCount"`;

/**
 * The filters a request may carry. `tab` is the lifecycle tab; "all" means
 * every exam that has not been archived, and the archive is its own tab.
 */
function where(schoolId, q, p, { tab = 'all', status = true } = {}) {
    const w = [`e."school" = ${p.$(String(schoolId))}::uuid`];

    if (tab === 'archived') w.push('e."archivedAt" IS NOT NULL');
    else if (tab === 'all') w.push('e."archivedAt" IS NULL');
    else if (tab) w.push(`${STAGE} = ${p.$(tab)}`);

    if (status && STATUS_LABELS[q.status]) w.push(`e."status" = ${p.$(q.status)}`);

    const year = String(q.academicYear || q.academicYearId || '');
    if (isUuid(year)) w.push(`e."academicYear" = ${p.$(year)}::uuid`);
    else if (year === 'current') w.push(`y."status" = 'active'`);

    // A class is a row per academic year, so across years it is named by its
    // number — "Class 6" in 2026-27 and in 2027-28 are two rows and one filter.
    if (q.classNumber !== undefined && q.classNumber !== '' && Number.isFinite(Number(q.classNumber))) {
        w.push(`c."classNumber" = ${p.$(Number(q.classNumber))}`);
    }
    if (isUuid(String(q.classId || ''))) w.push(`s."class" = ${p.$(String(q.classId))}::uuid`);
    if (isUuid(String(q.sectionId || ''))) w.push(`e."section" = ${p.$(String(q.sectionId))}::uuid`);
    // A type is named by its key — one of the school's own, or a kind for an
    // exam created before the school had types of its own.
    const type = String(q.examType || '').trim();
    if (type && type.length <= 40) w.push(`COALESCE(NULLIF(e."typeKey", ''), e."examType") = ${p.$(type)}`);
    if (isUuid(String(q.examId || ''))) w.push(`e."_id" = ${p.$(String(q.examId))}::uuid`);

    if (q.view === 'attention') w.push(`${attention(p.tz())} IS NOT NULL`);
    else if (q.view === 'progress') w.push(`${STAGE} IN ('marks', 'validation')`);

    const s = String(q.search ?? q.q ?? '').trim();
    if (s) {
        const like = p.$(`%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
        w.push(`(e."title" ILIKE ${like} OR e."code" ILIKE ${like} OR c."className" ILIKE ${like} OR s."sectionName" ILIKE ${like}
                 OR y."yearName" ILIKE ${like} OR concat_ws(' ', c."className", s."sectionName") ILIKE ${like}
                 OR replace(e."examType", '_', ' ') ILIKE ${like} OR e."typeLabel" ILIKE ${like})`);
    }
    return w.join('\n         AND ');
}

/* ── Rows ─────────────────────────────────────────────────────────────────── */

/**
 * When a published exam's results reached (or reach) families: the result date
 * when it came after publishing — a calendar day, returned as stored, which the
 * screens print by its own parts — else the moment of publishing. The result
 * date counts from the school's midnight (resultExams.releaseAt).
 */
function publishedOn(r) {
    if (!r?.finalApprovedAt) return null;
    const at = releaseAt(r);
    return at && at > new Date(r.finalApprovedAt) ? r.publishDate : r.finalApprovedAt;
}

/**
 * What may be done to an exam, decided here so the row menu, the drawer and the
 * bulk bar cannot disagree with each other — or with resultExams, which is
 * what actually enforces each one.
 */
function allowed(r) {
    const live = !r.archived;
    return {
        edit: live && r.status !== 'FINAL_APPROVED',
        delete: r.status === 'DRAFT',
        open: live && r.status === 'DRAFT' && r.subjectCount > 0,
        toDraft: live && r.status === 'MARKS_PENDING' && r.sheetsStarted === 0,
        marks: live && [...MARKS_OPEN, 'SUBMITTED', 'CLASS_APPROVED'].includes(r.status),
        validate: live && r.status === 'SUBMITTED',
        publish: live && r.status === 'CLASS_APPROVED',
        reject: live && ['SUBMITTED', 'CLASS_APPROVED'].includes(r.status),
        reopen: live && ['REJECTED', 'FINAL_APPROVED'].includes(r.status),
        results: r.status === 'FINAL_APPROVED',
        // Published: the name may still be corrected, and the result date
        // moved while the results have not yet reached families.
        rename: live && r.status === 'FINAL_APPROVED',
        resultDate: r.status === 'FINAL_APPROVED' && r.releaseAhead === true,
        archive: live,
        restore: !live,
        // Published: a result held back from a family, and a mark corrected in place.
        withhold: r.status === 'FINAL_APPROVED',
        correct: live && r.status === 'FINAL_APPROVED',
        // A subject's marks sent back to its teacher, from anywhere after mark entry opens.
        returnSubject: live && [...MARKS_OPEN, 'SUBMITTED', 'CLASS_APPROVED', 'REJECTED', 'FINAL_APPROVED'].includes(r.status),
    };
}

function shape(r) {
    const published = r.status === 'FINAL_APPROVED';
    const options = optionsOf(r);
    // Students see a result from the later of "published" and the result date —
    // unless the exam is kept off their portal altogether. The result date is a
    // DAY, which begins at the school's midnight (resultExams.releaseAt).
    const releasedOn = published ? publishedOn(r) : null;
    // Whether the result date is still ahead — said by the server, so no
    // screen has to compare a calendar day with its own clock.
    const releaseAhead = !released(r);
    const subjectCount = num(r.subjectCount);
    const row = {
        _id: r._id,
        title: r.title,
        code: r.code || '',
        examType: r.examType,
        typeKey: settings.typeKeyOf(r),
        examTypeLabel: settings.typeLabelOf(r),
        options,
        status: r.status,
        statusLabel: STATUS_LABELS[r.status] || r.status,
        stage: r.stage,
        archived: !!r.archivedAt,
        archivedAt: r.archivedAt || null,
        startDate: r.startDate,
        endDate: r.endDate,
        publishDate: r.publishDate || null,
        finalApprovedAt: r.finalApprovedAt || null,
        publishedOn: releasedOn,
        releaseAhead,
        resultsVisible: published && options.showInPortal && !releaseAhead,
        term: r.term || '',
        marksDueDate: r.marksDueDate || null,
        // Marks still out after the day they were due (the reminders say so too).
        overdue: !!r.marksDueDate && MARKS_OPEN.includes(r.status) && dayKey(r.marksDueDate) < todayOf(r.school)
            && Math.min(num(r.sheetsSubmitted), subjectCount) < subjectCount,
        timetableShared: r.timetableShared !== false,
        withheldCount: num(r.withheldCount),
        // The nested shapes are what the phone app and the old screen read.
        academicYear: r.yearId ? { _id: r.yearId, yearName: r.yearName } : null,
        section: r.sectionId ? { _id: r.sectionId, sectionName: r.sectionName } : null,
        class: r.classId ? { _id: r.classId, className: r.className, classNumber: r.classNumber } : null,
        yearName: r.yearName || '',
        className: r.className || '',
        sectionName: r.sectionName || '',
        classTeacher: r.classTeacherName || '',
        hasClassTeacher: !!r.hasValidator,
        subjectCount,
        sheetsSubmitted: Math.min(num(r.sheetsSubmitted), subjectCount),
        sheetsStarted: Math.min(num(r.sheetsStarted), subjectCount),
        roster: num(r.roster),
        resultCount: num(r.resultCount),
        // Once published, "students" is who actually has a result.
        students: published && num(r.resultCount) ? num(r.resultCount) : num(r.roster),
        attention: r.attention || null,
        rejectionReason: r.rejectionReason || '',
        // Final exams set to promote: where it has got to (resultPromotion).
        promotion: options.promoteOnPass || r.promotionState
            ? { state: r.promotionState || null, dueAt: r.promotionDueAt || null, at: r.promotedAt || null }
            : null,
        createdAt: r.createdAt,
        createdBy: r.createdByName ? { name: r.createdByName } : null,
    };
    row.can = allowed(row);
    return row;
}

/**
 * GET /admin/results/exams — one page, and a count under every tab.
 *
 * Tab counts honour the search and the filters but not the tab itself (or the
 * status, which only subdivides a tab), so each number is exactly the rows its
 * tab would show.
 */
async function list(schoolId, q = {}) {
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
    const tab = TABS.includes(q.tab) ? q.tab : 'all';

    const p = params();
    const tz = p.tz();
    const rowsSql = `
        SELECT ${columns(tz)}, count(*) OVER ()::int AS "_total"
        ${FROM}${SHEETS}
         WHERE ${where(schoolId, q, p, { tab })}
         ORDER BY e."startDate" DESC NULLS LAST, c."classNumber" NULLS LAST, s."sectionName", e."createdAt" DESC, e."_id"
         LIMIT ${p.$(limit)} OFFSET ${p.$((page - 1) * limit)}`;

    const cp = params();
    const countSql = `
        SELECT count(*) FILTER (WHERE x."stage" <> 'archived')::int AS "all",
               ${TABS.slice(1).map((k) => `count(*) FILTER (WHERE x."stage" = ${lit(k)})::int AS ${JSON.stringify(k)}`).join(',\n               ')}
          FROM (SELECT ${STAGE} AS "stage" ${FROM} WHERE ${where(schoolId, q, cp, { tab: null, status: false })}) x`;

    const [{ rows }, { rows: [tabs] }] = await Promise.all([
        pool.query(rowsSql, p.list), pool.query(countSql, cp.list),
    ]);
    // A page past the end — the last row of the last page was just deleted or
    // archived — comes back empty with nothing to count from, and read as "no
    // exams found" while there were pages of them. Answer with the last page.
    if (!rows.length && page > 1) {
        const tp = params();
        const { rows: [c] } = await pool.query(`SELECT count(*)::int AS "n" ${FROM} WHERE ${where(schoolId, q, tp, { tab })}`, tp.list);
        const last = Math.max(1, Math.ceil(num(c?.n) / limit));
        if (num(c?.n) > 0 && last < page) return list(schoolId, { ...q, page: last });
    }
    const total = rows.length ? rows[0]._total : 0;
    return {
        data: rows.map(shape), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)),
        tab, tabs: tabs || Object.fromEntries(TABS.map((k) => [k, 0])),
    };
}

/* ── Overview: tiles and the filter row's options ─────────────────────────── */

async function overview(schoolId) {
    const p = params();
    const tz = p.tz();
    const school = p.$(String(schoolId));
    const tilesSql = `
        SELECT count(*) FILTER (WHERE x."stage" <> 'archived')::int AS "total",
               count(*) FILTER (WHERE x."stage" = 'published')::int AS "published",
               count(*) FILTER (WHERE x."stage" IN ('marks', 'validation'))::int AS "inProgress",
               count(*) FILTER (WHERE x."stage" = 'marks')::int AS "markEntry",
               count(*) FILTER (WHERE x."stage" = 'validation')::int AS "validation",
               count(*) FILTER (WHERE x."stage" = 'draft')::int AS "drafts",
               count(*) FILTER (WHERE x."stage" = 'archived')::int AS "archived",
               count(*) FILTER (WHERE x."attention" IS NOT NULL)::int AS "pending",
               count(*) FILTER (WHERE x."attention" = 'publish')::int AS "toPublish",
               count(*) FILTER (WHERE x."attention" = 'reopen')::int AS "toReopen",
               count(*) FILTER (WHERE x."attention" = 'validate')::int AS "toValidate",
               count(*) FILTER (WHERE x."attention" = 'open')::int AS "toOpen",
               count(*) FILTER (WHERE x."attention" = 'marks')::int AS "toEnter"
          FROM (SELECT ${STAGE} AS "stage", ${attention(tz)} AS "attention" ${FROM} WHERE e."school" = ${school}::uuid) x`;

    const [{ rows: [tiles] }, { rows: years }, { rows: classes }, conf, { rows: [rc] }] = await Promise.all([
        pool.query(tilesSql, p.list),
        pool.query(`
            SELECT y."_id", y."yearName", y."status",
                   (SELECT count(*)::int FROM ${T.exams} e WHERE e."academicYear" = y."_id" AND e."archivedAt" IS NULL) AS "exams"
              FROM ${T.years} y WHERE y."school" = $1::uuid
             ORDER BY ${yearOrderSql('y')}`, [String(schoolId)]),
        pool.query(`
            SELECT c."classNumber", min(c."className") AS "className"
              FROM ${T.classes} c WHERE c."school" = $1::uuid AND c."classNumber" IS NOT NULL
             GROUP BY c."classNumber" ORDER BY c."classNumber"`, [String(schoolId)]),
        settings.get(schoolId),
        // Families' re-check requests still waiting for an answer.
        pool.query(`SELECT count(*)::int AS "n" FROM "resultrechecks" WHERE "school" = $1::uuid AND "status" = 'open'`, [String(schoolId)])
            .catch(() => ({ rows: [{ n: 0 }] })),
    ]);

    return {
        tiles: { ...tiles, publishedPct: share(tiles.published, tiles.total) },
        rechecksOpen: num(rc?.n),
        years: years.map((y) => ({ _id: y._id, yearName: y.yearName, current: y.status === 'active', exams: num(y.exams) })),
        classes: classes.map((c) => ({ classNumber: num(c.classNumber), className: c.className })),
        examTypes: typeOptions(conf.examTypes),
        statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({
            value, label, stage: Object.keys(STAGES).find((k) => STAGES[k].includes(value)),
        })),
    };
}

/* ── One exam ─────────────────────────────────────────────────────────────── */

const AUDIT_LABELS = {
    CREATED: 'Exam created',
    UPDATED: 'Details edited',
    MARKS_OPENED: 'Mark entry opened',
    BACK_TO_DRAFT: 'Moved back to draft',
    ALL_MARKS_SUBMITTED: 'All marks submitted',
    CLASS_APPROVED: 'Validated by the class teacher',
    VALIDATED_BY_ADMIN: 'Validated by the office',
    FINAL_APPROVED: 'Results published',
    REJECTED: 'Marks rejected by the office',
    CLASS_REJECTED: 'Marks rejected by the class teacher',
    REOPENED: 'Reopened for correction',
    RESULTS_WITHDRAWN: 'Published results withdrawn',
    ARCHIVED: 'Archived',
    RESTORED: 'Restored from the archive',
    OPTIONS_CHANGED: 'Settings changed',
    RENAMED: 'Name or description changed',
    RESULT_DATE_CHANGED: 'Result date changed',
    RE_EXAM: 'Re-exam',
    MARKS_CORRECTED: 'Marks corrected by the office',
    SUBJECT_RETURNED: 'A subject sent back for correction',
    MARK_CORRECTED: 'A published mark corrected',
    RESULTS_WITHHELD: 'Results withheld',
    RESULTS_RELEASED: 'Withheld results released',
    PROMOTION_DECIDED: 'Promotion decided by the office',
};

async function examRow(schoolId, id) {
    if (!isUuid(String(id || ''))) return null;
    const p = params();
    const tz = p.tz();
    const { rows } = await pool.query(`
        SELECT ${columns(tz)}, e."subjects", e."auditLog", e."description", e."promotionStats", e."reExam", e."withheld", e."promotionOverrides", e."gradeBands",
               e."classApprovedBy", e."finalApprovedBy", ca."name" AS "classApprovedByName", fa."name" AS "finalApprovedByName"
        ${FROM}${SHEETS}
          LEFT JOIN ${T.users} ca ON ca."_id" = e."classApprovedBy"
          LEFT JOIN ${T.users} fa ON fa."_id" = e."finalApprovedBy"
         WHERE e."school" = ${p.$(String(schoolId))}::uuid AND e."_id" = ${p.$(String(id))}::uuid`, p.list);
    return rows[0] || null;
}

const namesOf = async (ids) => {
    const list = [...new Set(ids.map(String).filter(isUuid))];
    if (!list.length) return new Map();
    const { rows } = await pool.query(`SELECT "_id", "name" FROM ${T.users} WHERE "_id" = ANY($1::uuid[])`, [list]);
    return new Map(rows.map((r) => [String(r._id), r.name]));
};

async function resultSummary(examId, schoolId, exam = null) {
    const id = String(examId);
    const [{ rows: [s] }, { rows: grades }, { rows: toppers }] = await Promise.all([
        pool.query(`
            SELECT count(*)::int AS "students", count(*) FILTER (WHERE r."isPassed")::int AS "passed",
                   avg(r."percentage") AS "avgPct", max(r."percentage") AS "topPct", min(r."percentage") AS "lowPct"
              FROM ${T.results} r WHERE r."exam" = $1::uuid`, [id]),
        pool.query(`SELECT r."grade", count(*)::int AS "n" FROM ${T.results} r WHERE r."exam" = $1::uuid GROUP BY 1`, [id]),
        pool.query(`
            SELECT u."name", r."percentage", r."totalMarks", r."totalMaxMarks"
              FROM ${T.results} r JOIN ${T.users} u ON u."_id" = r."student"
             WHERE r."exam" = $1::uuid AND r."rank" = 1 ORDER BY u."name" LIMIT 3`, [id]),
    ]);
    if (!s || !s.students) return null;
    const byGrade = new Map(grades.map((g) => [g.grade, g.n]));
    // The exam's own scale: the one it was published on, else its class's.
    const scale = exam?.gradeBands?.bands ? exam.gradeBands : await settings.scaleOf(schoolId, exam?.classNumber);
    return {
        students: s.students,
        passed: s.passed,
        failed: s.students - s.passed,
        passPct: share(s.passed, s.students),
        avgPct: pct1(s.avgPct),
        topPct: pct1(s.topPct),
        lowPct: pct1(s.lowPct),
        grades: gradeList(scale, grades.map((g) => g.grade)).map((g) => ({ grade: g.grade, count: byGrade.get(g.grade) || 0, pass: g.pass })),
        toppers: toppers.map((x) => ({ name: x.name, percentage: num(x.percentage), totalMarks: num(x.totalMarks), totalMaxMarks: num(x.totalMaxMarks) })),
    };
}

/**
 * Each elective subject's takers in a section who are on its roll and active:
 * Map(subject → Set(student)). A subject with no elective roster is not in it.
 */
async function takersBySubject(sectionId) {
    const { rows } = await pool.query(`
        SELECT er."subject"::text AS "subject", array_remove(array_agg(u."_id"::text), NULL) AS "students"
          FROM "electiverosters" er
          LEFT JOIN LATERAL jsonb_array_elements_text(${jarr('er."students"')}) v ON true
          LEFT JOIN ${T.users} u ON u."_id"::text = v AND u."role" = 'student' AND u."isActive" IS NOT FALSE
           AND v IN (SELECT jsonb_array_elements_text(${jarr('s."enrolledStudents"')}) FROM ${T.sections} s WHERE s."_id" = er."section")
         WHERE er."section" = $1::uuid
         GROUP BY 1`, [String(sectionId)]);
    return new Map(rows.map((r) => [r.subject, new Set(r.students || [])]));
}

/**
 * Rank across the whole class (Oct 2026): every published section of the same
 * exam — same year, class, type and name — ranked together on the share of
 * marks. Map("exam:student" → { classRank, classOutOf, sections }).
 */
async function classRanksFor(examIds) {
    const ids = [...new Set((examIds || []).map(String))].filter(isUuid);
    if (!ids.length) return new Map();
    const { rows } = await pool.query(`
        WITH me AS (
            SELECT e."_id", e."school", e."academicYear", s."class", COALESCE(NULLIF(e."typeKey", ''), e."examType") AS "tk", lower(btrim(e."title")) AS "tt"
              FROM ${T.exams} e JOIN ${T.sections} s ON s."_id" = e."section"
             WHERE e."_id" = ANY($1::uuid[])
        ), peers AS (
            SELECT DISTINCT me."_id" AS "for", e."_id" AS "exam"
              FROM me JOIN ${T.exams} e ON e."school" = me."school" AND e."academicYear" = me."academicYear"
                       AND COALESCE(NULLIF(e."typeKey", ''), e."examType") = me."tk" AND lower(btrim(e."title")) = me."tt"
                       AND e."status" = 'FINAL_APPROVED'
              JOIN ${T.sections} s ON s."_id" = e."section" AND s."class" = me."class"
        ), ranked AS (
            SELECT p."for", r."exam", r."student",
                   rank() OVER (PARTITION BY p."for" ORDER BY (r."totalMarks"::numeric / NULLIF(r."totalMaxMarks"::numeric, 0)) DESC NULLS LAST) AS "classRank",
                   count(*) OVER (PARTITION BY p."for") AS "classOutOf"
              FROM peers p JOIN ${T.results} r ON r."exam" = p."exam"
        )
        SELECT "exam"::text AS "exam", "student"::text AS "student", "classRank"::int, "classOutOf"::int
          FROM ranked WHERE "exam" = "for"`, [ids]);
    return new Map(rows.map((r) => [`${r.exam}:${r.student}`, { classRank: r.classRank, classOutOf: r.classOutOf }]));
}

/**
 * GET /admin/results/exams/:id — everything the drawer shows.
 *
 * `subjects[i].subject` is still the populated object and `sheets` is still
 * there, because the phone app's review screen reads both.
 */
async function detail(schoolId, id) {
    const r = await examRow(schoolId, id);
    if (!r) return null;
    const row = shape(r);
    const cfgs = Array.isArray(r.subjects) ? r.subjects : [];
    const subjectIds = cfgs.map((s) => String(s.subject)).filter(isUuid);

    const [{ rows: subs }, { rows: teachers }, { rows: sheets }] = await Promise.all([
        pool.query(`SELECT "_id", "subjectName", "subjectCode", "type" FROM ${T.subjects} WHERE "_id" = ANY($1::uuid[])`, [subjectIds]),
        pool.query(`
            SELECT st."subject", u."_id", u."name"
              FROM ${T.sst} st JOIN ${T.users} u ON u."_id" = st."teacher"
             WHERE st."section" = $1::uuid AND st."subject" = ANY($2::uuid[]) ORDER BY u."name"`, [String(r.sectionId), subjectIds]),
        pool.query(`
            SELECT m."_id", m."subject", m."status", m."submittedAt", m."updatedAt", m."submittedBy", m."auditLog", sb."name" AS "submittedByName",
                   (SELECT count(*)::int FROM jsonb_array_elements(${jarr('m."entries"')}) en WHERE ${ANSWERED}) AS "entered",
                   (SELECT count(*)::int FROM jsonb_array_elements(${jarr('m."entries"')}) en WHERE (en->>'isAbsent') = 'true') AS "absent"
              FROM ${T.sheets} m LEFT JOIN ${T.users} sb ON sb."_id" = m."submittedBy"
             WHERE m."exam" = $1::uuid`, [String(r._id)]),
    ]);
    const subOf = new Map(subs.map((s) => [String(s._id), s]));
    const sheetOf = new Map(sheets.map((s) => [String(s.subject), s]));
    const teachOf = new Map();
    teachers.forEach((x) => {
        const k = String(x.subject);
        if (!teachOf.has(k)) teachOf.set(k, []);
        teachOf.get(k).push({ _id: x._id, name: x.name });
    });
    const takers = await takersBySubject(r.sectionId);
    const late = !!r.marksDueDate && MARKS_OPEN.includes(r.status) && dayKey(r.marksDueDate) < todayOf(schoolId);

    const subjects = cfgs.map((cfg) => {
        const sid = String(cfg.subject);
        const sub = subOf.get(sid);
        const sheet = sheetOf.get(sid);
        // An elective is sat by its roster's students only.
        const total = takers.has(sid) ? takers.get(sid).size : row.roster;
        const status = sheet?.status === 'SUBMITTED' ? 'SUBMITTED' : (sheet && num(sheet.entered) ? 'DRAFT' : 'NOT_STARTED');
        return {
            subject: { _id: sid, subjectName: sub?.subjectName || 'Subject removed', subjectCode: sub?.subjectCode || '', type: sub?.type || '' },
            maxMarks: num(cfg.maxMarks), passingMarks: num(cfg.passingMarks),
            examDate: cfg.examDate || null, startTime: cfg.startTime || '', endTime: cfg.endTime || '', order: num(cfg.order),
            components: Array.isArray(cfg.components) && cfg.components.length ? cfg.components : null,
            gradeOnly: cfg.gradeOnly === true, elective: takers.has(sid),
            teachers: teachOf.get(sid) || [],
            sheet: {
                status, overdue: late && status !== 'SUBMITTED',
                entered: Math.min(num(sheet?.entered), total), absent: num(sheet?.absent), total,
                submittedBy: sheet?.submittedByName || '', submittedAt: sheet?.submittedAt || null, updatedAt: sheet?.updatedAt || null,
                changes: (Array.isArray(sheet?.auditLog) ? sheet.auditLog : []).reduce((n, a) => n + (Array.isArray(a.changes) ? a.changes.length : 0), 0),
            },
        };
    });
    // Results held back from families, and promotions the office decided by hand.
    const held = Array.isArray(r.withheld) ? r.withheld : [];
    const decided = Array.isArray(r.promotionOverrides) ? r.promotionOverrides : [];
    const people = await namesOf([...held.map((w) => w.student), ...decided.map((o) => o.student), ...held.map((w) => w.by), ...decided.map((o) => o.by)]);
    const conf = await settings.get(schoolId);

    // The exam's own history, with each subject's submission slotted in.
    const log = (Array.isArray(r.auditLog) ? r.auditLog : []).map((a, i) => ({ ...a, i, own: 1, label: AUDIT_LABELS[a.action] || a.action }));
    sheets.forEach((s) => (Array.isArray(s.auditLog) ? s.auditLog : []).forEach((a, i) => {
        const name = subOf.get(String(s.subject))?.subjectName || 'A subject';
        const changed = Array.isArray(a.changes) ? a.changes.length : 0;
        if (a.action === 'SUBMITTED' || a.action === 'ADMIN_SUBMITTED') {
            log.push({ ...a, i, own: 0, label: `${name} marks submitted${a.action === 'ADMIN_SUBMITTED' ? ' by the office' : ''}${changed ? ` — ${changed} changed` : ''}` });
        } else if (changed) {
            // A mark changed after it was first given: in the history, whoever changed it.
            log.push({ ...a, i, own: 0, label: `${name}: ${changed} mark${changed === 1 ? '' : 's'} changed${a.action === 'ADMIN_SAVED' ? ' by the office' : ''}` });
        }
    }));
    const who = await namesOf(log.map((a) => a.by).filter(Boolean));
    // Newest first. Steps taken in the same millisecond keep the order they
    // happened in rather than an arbitrary one: a sheet going in comes before
    // the exam moving on because of it, and the exam's own steps stay in the
    // order they were written.
    const timeline = log
        .filter((a) => a.at)
        .sort((a, b) => (new Date(b.at) - new Date(a.at)) || (b.own - a.own) || (b.i - a.i))
        .map((a) => ({ action: a.action, label: a.label, at: a.at, notes: a.notes || '', by: who.get(String(a.by)) || '' }));

    const summary = r.status === 'FINAL_APPROVED' ? await resultSummary(r._id, schoolId, r) : null;
    const promoted = await promotion.summary({
        _id: r._id, school: schoolId, section: r.sectionId, status: r.status, examType: r.examType,
        promoteOnPass: r.promoteOnPass, promoteSection: r.promoteSection, failedPlacement: r.failedPlacement, promotionState: r.promotionState,
        promotionDueAt: r.promotionDueAt, promotedAt: r.promotedAt, promotionStats: r.promotionStats,
    });

    return {
        ...row,
        description: r.description || '',
        subjects,
        // The older review screens read `sheets[i].entries.length` for "N
        // entries"; they get the count without every student's marks riding along.
        sheets: sheets.map((s) => ({
            _id: s._id, subject: { _id: s.subject, subjectName: subOf.get(String(s.subject))?.subjectName || '' },
            status: s.status, submittedBy: s.submittedByName ? { name: s.submittedByName } : null, submittedAt: s.submittedAt,
            entries: { length: num(s.entered) },
        })),
        approvals: {
            classApprovedBy: r.classApprovedByName || '', classApprovedAt: r.classApprovedAt || null,
            finalApprovedBy: r.finalApprovedByName || '', finalApprovedAt: r.finalApprovedAt || null,
        },
        timeline,
        summary,
        promotion: promoted,
        // Re-exams on these results: how many papers have been sat again, and when the next sitting is.
        reExam: r.reExam && typeof r.reExam === 'object'
            ? { entered: Array.isArray(r.reExam.marks) ? r.reExam.marks.length : 0, date: r.reExam.date || null, rule: r.reExam.rule || 'scored' }
            : null,
        termLabel: (conf.terms || []).find((x) => x.key === r.term)?.label || '',
        withheld: held.map((w) => ({ student: String(w.student), name: people.get(String(w.student)) || 'Student', reason: w.reason || '', at: w.at || null, by: people.get(String(w.by)) || '' })),
        promotionDecisions: decided.map((o) => ({ student: String(o.student), name: people.get(String(o.student)) || 'Student', decision: o.decision, reason: o.reason || '', at: o.at || null, by: people.get(String(o.by)) || '' })),
    };
}

/** The section's students with roll and admission numbers, in roll order. */
async function rosterRows(sectionId) {
    const { rows } = await pool.query(`
        SELECT u."_id", u."name", u."isActive", sp."rollNumber", sp."admissionNumber"
          FROM ${T.sections} s
          JOIN ${T.users} u ON u."role" = 'student' AND u."isActive" IS NOT FALSE
           AND u."_id" IN (SELECT v::uuid FROM jsonb_array_elements_text(${jarr('s."enrolledStudents"')}) v
                            WHERE v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          LEFT JOIN LATERAL (SELECT "rollNumber", "admissionNumber" FROM ${T.profiles}
                              WHERE "user" = u."_id" ORDER BY "createdAt" DESC NULLS LAST LIMIT 1) sp ON true
         WHERE s."_id" = $1::uuid
         ORDER BY NULLIF(regexp_replace(COALESCE(sp."rollNumber", ''), '\\D', '', 'g'), '')::bigint NULLS LAST, u."name"`,
    [String(sectionId)]);
    return rows;
}

/**
 * GET /admin/results/exams/:id/marks/:subjectId — one subject's sheet as the
 * office's marks grid: every student on the roll, with whatever has been
 * entered against them.
 */
async function marksSheet(schoolId, id, subjectId) {
    const r = await examRow(schoolId, id);
    if (!r) return null;
    const row = shape(r);
    const cfg = (Array.isArray(r.subjects) ? r.subjects : []).find((s) => String(s.subject) === String(subjectId));
    if (!cfg) return null;

    const [roll, { rows: [sub] }, { rows: [sheet] }, { rows: teachers }, takers, { rows: [cls] }] = await Promise.all([
        rosterRows(r.sectionId),
        pool.query(`SELECT "_id", "subjectName", "subjectCode" FROM ${T.subjects} WHERE "_id" = $1::uuid`, [String(subjectId)]),
        pool.query(`
            SELECT m."status", m."entries", m."submittedAt", m."updatedAt", m."version", sb."name" AS "submittedByName"
              FROM ${T.sheets} m LEFT JOIN ${T.users} sb ON sb."_id" = m."submittedBy"
             WHERE m."exam" = $1::uuid AND m."subject" = $2::uuid`, [String(r._id), String(subjectId)]),
        pool.query(`
            SELECT u."name" FROM ${T.sst} st JOIN ${T.users} u ON u."_id" = st."teacher"
             WHERE st."section" = $1::uuid AND st."subject" = $2::uuid ORDER BY u."name"`, [String(r.sectionId), String(subjectId)]),
        takersBySubject(r.sectionId),
        pool.query(`SELECT c."classNumber" FROM ${T.sections} s JOIN ${T.classes} c ON c."_id" = s."class" WHERE s."_id" = $1::uuid`, [String(r.sectionId)]),
    ]);
    const entries = Array.isArray(sheet?.entries) ? sheet.entries : [];
    const entryOf = new Map(entries.map((e) => [String(e.student), e]));
    // An elective's sheet lists its roster; anyone else's subject lists the roll.
    const own = takers.get(String(subjectId));
    const students = own ? roll.filter((u) => own.has(String(u._id))) : roll;
    const onRoll = new Set(students.map((u) => String(u._id)));
    const rollIds = new Set(roll.map((u) => String(u._id)));
    // Off the roll now — moved section, or left the school — but marked on
    // this sheet: shown, so their marks are seen and kept, and need not be
    // given for the sheet to be submitted.
    const answered = (e) => e && (e.isAbsent || (e.marksObtained !== null && e.marksObtained !== undefined) || String(e.grade || '').trim()
        || (e.parts && Object.values(e.parts).some((v) => v !== null && v !== undefined && v !== '')));
    const offIds = entries.filter((e) => !onRoll.has(String(e.student)) && !rollIds.has(String(e.student)) && answered(e)).map((e) => String(e.student));
    const { rows: off } = offIds.length ? await pool.query(`
        SELECT u."_id", u."name", u."isActive", sp."rollNumber", sp."admissionNumber", cs."sectionName", cc."className"
          FROM ${T.users} u
          LEFT JOIN LATERAL (SELECT "rollNumber", "admissionNumber", "currentSection" FROM ${T.profiles}
                              WHERE "user" = u."_id" ORDER BY "createdAt" DESC NULLS LAST LIMIT 1) sp ON true
          LEFT JOIN ${T.sections} cs ON cs."_id" = sp."currentSection"
          LEFT JOIN ${T.classes} cc ON cc."_id" = cs."class"
         WHERE u."_id" = ANY($1::uuid[]) AND u."school" = $2::uuid`, [offIds, String(schoolId)]) : { rows: [] };
    const conf = await settings.get(schoolId);
    const scale = settings.scaleForClass(conf, cls?.classNumber);
    const shapeStudent = (u, extra = {}) => {
        const e = entryOf.get(String(u._id));
        return {
            _id: u._id, name: u.name, isActive: u.isActive !== false,
            rollNumber: u.rollNumber || '', admissionNumber: u.admissionNumber || '',
            marksObtained: e && e.marksObtained != null ? num(e.marksObtained) : null,
            isAbsent: !!e?.isAbsent, remarks: e?.remarks || '',
            parts: e?.parts && typeof e.parts === 'object' ? e.parts : null, grade: e?.grade || '',
            ...extra,
        };
    };

    return {
        exam: { _id: row._id, title: row.title, status: row.status, statusLabel: row.statusLabel, className: row.className, sectionName: row.sectionName, yearName: row.yearName, archived: row.archived },
        subject: { _id: String(subjectId), subjectName: sub?.subjectName || 'Subject removed', subjectCode: sub?.subjectCode || '' },
        config: {
            maxMarks: num(cfg.maxMarks), passingMarks: num(cfg.passingMarks), examDate: cfg.examDate || null,
            components: Array.isArray(cfg.components) && cfg.components.length ? cfg.components : null,
            gradeOnly: cfg.gradeOnly === true,
            // A graded paper's grades: the class's scale, best first.
            grades: cfg.gradeOnly === true ? settings.scaleRows(scale).map((b) => ({ grade: b.grade, pass: b.pass })) : null,
            elective: !!own,
        },
        teachers: teachers.map((x) => x.name),
        sheet: {
            status: sheet?.status || 'NOT_STARTED', submittedBy: sheet?.submittedByName || '',
            submittedAt: sheet?.submittedAt || null, updatedAt: sheet?.updatedAt || null,
            // Sent back with a save: a save over somebody else's later changes is refused.
            version: num(sheet?.version),
        },
        // Open → the office may save a draft or submit. Correcting → the sheet
        // has gone forward; a change is saved as submitted and must be complete.
        editable: row.can.marks,
        correcting: row.can.marks && !MARKS_OPEN.includes(row.status),
        students: [
            ...students.map((u) => shapeStudent(u)),
            ...off.map((u) => shapeStudent(u, {
                offRoll: true,
                offRollReason: u.isActive === false ? 'Has left the school' : u.className || u.sectionName ? `Now in ${[u.className, u.sectionName].filter(Boolean).join(' – ')}` : 'No longer in this section',
            })),
        ],
    };
}

/**
 * GET /admin/results/exams/:id/result — every student's result, in rank order.
 * Roll numbers come from the student profile: the account row has none, which
 * is why the populated version of this never showed one.
 */
async function results(schoolId, id) {
    const r = await examRow(schoolId, id);
    if (!r) return null;
    const cfgs = Array.isArray(r.subjects) ? r.subjects : [];
    const subjectIds = cfgs.map((s) => String(s.subject)).filter(isUuid);
    const [{ rows }, { rows: subs }, summary] = await Promise.all([
        pool.query(`
            SELECT r."_id", r."student", u."name", sp."rollNumber", sp."admissionNumber", r."subjects",
                   r."totalMarks", r."totalMaxMarks", r."percentage", r."grade", r."rank", r."isPassed"
              FROM ${T.results} r
              JOIN ${T.users} u ON u."_id" = r."student"
              LEFT JOIN LATERAL (SELECT "rollNumber", "admissionNumber" FROM ${T.profiles}
                                  WHERE "user" = r."student" ORDER BY "createdAt" DESC NULLS LAST LIMIT 1) sp ON true
             WHERE r."exam" = $1::uuid
             ORDER BY r."rank", u."name"`, [String(r._id)]),
        pool.query(`SELECT "_id", "subjectName", "subjectCode" FROM ${T.subjects} WHERE "_id" = ANY($1::uuid[])`, [subjectIds]),
        resultSummary(r._id, schoolId, r),
    ]);
    const subOf = new Map(subs.map((s) => [String(s._id), s]));
    const named = (sid) => ({ _id: sid, subjectName: subOf.get(String(sid))?.subjectName || 'Subject removed', subjectCode: subOf.get(String(sid))?.subjectCode || '' });
    const held = new Map((Array.isArray(r.withheld) ? r.withheld : []).map((w) => [String(w.student), w]));
    const classRank = await classRanksFor([r._id]);
    const scale = r.gradeBands?.bands ? r.gradeBands : await settings.scaleOf(schoolId, r.classNumber);
    return {
        exam: shape(r),
        // The grades a graded paper may be given: the exam's scale, best first.
        scale: settings.scaleRows(scale).map((b) => ({ grade: b.grade, pass: b.pass })),
        subjects: cfgs.map((c) => ({
            ...named(String(c.subject)), maxMarks: num(c.maxMarks), passingMarks: num(c.passingMarks),
            components: Array.isArray(c.components) && c.components.length ? c.components : null, gradeOnly: c.gradeOnly === true,
        })),
        summary,
        data: rows.map((x) => {
            const cr = classRank.get(`${r._id}:${x.student}`);
            return {
                _id: x._id,
                student: { _id: x.student, name: x.name, rollNumber: x.rollNumber || '', admissionNumber: x.admissionNumber || '' },
                subjects: (Array.isArray(x.subjects) ? x.subjects : []).map((s) => ({ ...s, subject: named(String(s.subject)) })),
                totalMarks: num(x.totalMarks), totalMaxMarks: num(x.totalMaxMarks), percentage: num(x.percentage),
                grade: x.grade, rank: num(x.rank), isPassed: !!x.isPassed,
                classRank: cr?.classRank || null, classOutOf: cr?.classOutOf || null,
                withheld: held.has(String(x.student)) ? { reason: held.get(String(x.student)).reason || '' } : null,
            };
        }),
    };
}

/* ── The Create Exam form ─────────────────────────────────────────────────── */

/** Years, and each year's classes with their sections — what the form picks from. */
async function formMeta(schoolId) {
    const id = String(schoolId);
    const [{ rows: years }, { rows: sections }] = await Promise.all([
        pool.query(`SELECT "_id", "yearName", "status" FROM ${T.years} WHERE "school" = $1::uuid
                     ORDER BY ${yearOrderSql()}`, [id]),
        pool.query(`
            SELECT s."_id", s."sectionName", s."academicYear", s."class" AS "classId", c."className", c."classNumber",
                   ct."name" AS "classTeacherName", ${ROSTER} AS "students"
              FROM ${T.sections} s
              JOIN ${T.classes} c ON c."_id" = s."class"
              LEFT JOIN ${T.users} ct ON ct."_id" = s."classTeacher"
             WHERE s."school" = $1::uuid AND COALESCE(s."status", 'active') <> 'archived' AND COALESCE(c."status", 'active') <> 'archived'
             ORDER BY ${classOrderSql('c')}, ${sectionOrderSql('s')}`, [id]),
    ]);
    // Where each class goes up to, for the promotion choice on a final exam.
    const [targets, conf] = await Promise.all([promotion.targetsByClass(schoolId), settings.get(schoolId)]);
    const classes = new Map();
    sections.forEach((s) => {
        const k = String(s.classId);
        if (!classes.has(k)) {
            classes.set(k, {
                _id: s.classId, className: s.className, classNumber: num(s.classNumber), academicYear: s.academicYear, sections: [],
                next: promotion.describeTarget(targets.get(k)),
            });
        }
        classes.get(k).sections.push({ _id: s._id, sectionName: s.sectionName, students: num(s.students), classTeacher: s.classTeacherName || '' });
    });
    return {
        years: years.map((y) => ({ _id: y._id, yearName: y.yearName, current: y.status === 'active' })),
        classes: [...classes.values()],
        examTypes: typeOptions(conf.examTypes.filter((t) => t.active)),
        // For an exam being edited whose type has since been switched off.
        allExamTypes: typeOptions(conf.examTypes),
        scale: conf.scaleRows,
        // The school's terms, and how long after an exam its marks are due by default.
        terms: conf.terms.map((t) => ({ key: t.key, label: t.label })),
        marksDueDays: conf.marksDueDays,
    };
}

/**
 * The subjects an exam for these sections can cover — what is linked to their
 * class, plus anything actually being taught in one of them: offeredByClass,
 * the same rule createExams applies when the sections span several classes.
 *
 * Each subject comes with the classes it is offered to and who teaches it
 * where, so the form can say before the exam exists that a subject will be
 * left out of a class, or that a section has nobody to enter its marks.
 * `untaught` counts only sections whose class sits the subject at all.
 */
async function subjectsFor(schoolId, sectionIds) {
    const asked = [...new Set((sectionIds || []).map(String).filter(isUuid))];
    if (!asked.length) return [];
    const { rows: secs } = await pool.query(
        `SELECT "_id", "class" FROM ${T.sections} WHERE "school" = $1::uuid AND "_id" = ANY($2::uuid[])`, [String(schoolId), asked]);
    const ids = secs.map((s) => String(s._id));
    const classOfSection = new Map(secs.map((s) => [String(s._id), String(s.class || '')]));
    const offered = await offeredByClass(ids);
    const classesOf = new Map();
    for (const [cls, subs] of offered) {
        for (const sub of subs) {
            if (!classesOf.has(sub)) classesOf.set(sub, []);
            classesOf.get(sub).push(cls);
        }
    }
    if (!classesOf.size) return [];

    const { rows } = await pool.query(`
        SELECT sub."_id", sub."subjectName", sub."subjectCode", sub."type",
               COALESCE((SELECT jsonb_agg(jsonb_build_object('section', st."section", 'name', u."name") ORDER BY u."name")
                           FROM ${T.sst} st JOIN ${T.users} u ON u."_id" = st."teacher"
                          WHERE st."subject" = sub."_id" AND st."section" = ANY($3::uuid[])), '[]'::jsonb) AS "teachers"
          FROM ${T.subjects} sub
         WHERE sub."school" = $1::uuid AND sub."_id" = ANY($2::uuid[])
         ORDER BY sub."subjectName"`, [String(schoolId), [...classesOf.keys()], ids]);
    return rows.map((s) => {
        const teachers = Array.isArray(s.teachers) ? s.teachers : [];
        const taught = new Set(teachers.map((x) => String(x.section)));
        const classes = classesOf.get(String(s._id)) || [];
        return {
            _id: s._id, subjectName: s.subjectName, subjectCode: s.subjectCode || '', type: s.type || '',
            classes, teachers,
            untaught: ids.filter((id) => classes.includes(classOfSection.get(id)) && !taught.has(id)),
        };
    });
}

/* ── Overall result ───────────────────────────────────────────────────────── */

/**
 * GET /admin/results/overall — the year's overall result: every published
 * exam marked "Include in overall result", added up per student.
 *
 * Marks are summed rather than percentages averaged, so an exam weighs what it
 * is out of — a 500-mark final counts five times a 100-mark unit test, as on a
 * printed report card. A student passes overall by passing every exam counted.
 * Rank is competition rank on percentage within the student's section (their
 * latest, if they moved). Archived exams still count: putting an exam away
 * does not unpublish it.
 */
async function overall(schoolId, q = {}) {
    const id = String(schoolId);
    const [{ rows: years }, { rows: classList }] = await Promise.all([
        pool.query(`SELECT "_id", "yearName", "status", "startDate" FROM ${T.years} WHERE "school" = $1::uuid
                     ORDER BY ${yearOrderSql()}`, [id]),
        pool.query(`SELECT c."classNumber", min(c."className") AS "className" FROM ${T.classes} c
                     WHERE c."school" = $1::uuid AND c."classNumber" IS NOT NULL GROUP BY 1 ORDER BY 1`, [id]),
    ]);
    const year = years.find((y) => String(y._id) === String(q.academicYear || ''))
        || years.find((y) => y.status === 'active') || newestYear(years);
    const filters = {
        years: years.map((y) => ({ _id: y._id, yearName: y.yearName, current: y.status === 'active' })),
        classes: classList.map((c) => ({ classNumber: num(c.classNumber), className: c.className })),
    };
    const empty = { year: null, exams: [], excluded: [], students: [], totals: { students: 0, passed: 0, failed: 0, passPct: null, avgPct: null, topPct: null }, filters };
    if (!year) return empty;

    const scope = { academicYear: String(year._id), classNumber: q.classNumber, sectionId: q.sectionId };
    const counted = `e."status" = 'FINAL_APPROVED' AND e."includeInOverall" IS TRUE`;
    const run = (build) => { const p = params(); const sql = build(p); return pool.query(sql, p.list); };

    const [cycles, perSection, { years: yearsOf, conf }] = await Promise.all([
        // Exams as the office thinks of them — one per title and type, across
        // its sections — counted or not. A published exam left out is listed
        // too: it is the first thing to check when a figure looks wrong.
        run((p) => `
            SELECT min(e."title") AS "title", min(e."examType") AS "examType", min(NULLIF(e."typeLabel", '')) AS "typeLabel",
                   COALESCE(NULLIF(e."typeKey", ''), e."examType") AS "typeKey", min(NULLIF(e."code", '')) AS "code",
                   (e."includeInOverall" IS TRUE) AS "included", min(COALESCE(e."term", '')) AS "term",
                   count(*)::int AS "sections",
                   count(*) FILTER (WHERE e."status" = 'FINAL_APPROVED')::int AS "published",
                   min(e."startDate") AS "startDate"
            ${FROM}
             WHERE ${where(id, scope, p, { tab: null, status: false })}
               AND (e."archivedAt" IS NULL OR e."status" = 'FINAL_APPROVED')
               AND (e."includeInOverall" IS TRUE OR e."status" = 'FINAL_APPROVED')
             GROUP BY lower(btrim(e."title")), COALESCE(NULLIF(e."typeKey", ''), e."examType"), (e."includeInOverall" IS TRUE)
             ORDER BY min(e."startDate") NULLS LAST, 1`),
        run((p) => `
            SELECT e."section", count(*)::int AS "n" ${FROM}
             WHERE ${where(id, scope, p, { tab: null, status: false })} AND ${counted}
             GROUP BY 1`),
        // The one way the year is worked out (services/resultOverall): the
        // school's rule — marks added up, or weighted parts and best-of —
        // with ranks in the section and across the class.
        require('./resultOverall').yearsFor(id, year._id, {
            sectionIds: isUuid(String(q.sectionId || '')) ? [String(q.sectionId)] : null,
            classNumber: q.classNumber !== undefined && q.classNumber !== '' ? q.classNumber : null,
        }),
    ]);

    const outOf = new Map(perSection.rows.map((r) => [String(r.section), num(r.n)]));
    const ids = [...yearsOf.keys()];
    const { rows: people } = ids.length ? await pool.query(`
        SELECT u."_id"::text AS "_id", u."name", sp."rollNumber", sp."admissionNumber"
          FROM ${T.users} u
          LEFT JOIN LATERAL (SELECT "rollNumber", "admissionNumber" FROM ${T.profiles}
                              WHERE "user" = u."_id" ORDER BY "createdAt" DESC NULLS LAST LIMIT 1) sp ON true
         WHERE u."_id" = ANY($1::uuid[])`, [ids]) : { rows: [] };
    const personOf = new Map(people.map((x) => [x._id, x]));
    const rows = ids.map((sid) => {
        const y = yearsOf.get(sid);
        const who = personOf.get(sid) || {};
        return {
            _id: sid, name: who.name || 'Student', rollNumber: who.rollNumber || '', admissionNumber: who.admissionNumber || '',
            sectionId: y.section, className: y.className || '', sectionName: y.sectionName || '', classNumber: y.classNumber,
            exams: y.exams.length, of: outOf.get(String(y.section)) || y.exams.length,
            marks: y.marks, max: y.max,
            pct: pct1(y.percentage), grade: y.grade, passed: !!y.isPassed,
            rank: y.rank, classRank: y.classRank, classOutOf: y.classOutOf, withheld: y.withheld || null,
        };
    }).sort((a, b) => (num(a.classNumber) - num(b.classNumber)) || String(a.sectionName).localeCompare(String(b.sectionName))
        || a.rank - b.rank || a.name.localeCompare(b.name));
    const passed = rows.filter((r) => r.passed).length;
    const pcts = rows.map((r) => r.pct).filter((v) => v !== null);
    const shapeCycle = (c) => ({
        title: c.title, examType: c.examType, typeKey: c.typeKey, examTypeLabel: settings.typeLabelOf(c), code: c.code || '',
        sections: num(c.sections), published: num(c.published), startDate: c.startDate,
        term: c.term || '', termLabel: (conf.terms || []).find((x) => x.key === c.term)?.label || '',
    });
    return {
        year: { _id: year._id, yearName: year.yearName, current: year.status === 'active' },
        exams: cycles.rows.filter((c) => c.included).map(shapeCycle),
        excluded: cycles.rows.filter((c) => !c.included).map(shapeCycle),
        students: rows,
        // How the figures were worked out, for the page to say so.
        rule: { ...conf.overall, terms: conf.terms, partLabels: conf.overall.parts.map((x) => ({
            ...x, label: x.source === settings.CLASS_TEST ? 'Class tests' : settings.typeLabelOf({ typeKey: x.source, typeLabel: (conf.examTypes.find((tp) => tp.key === x.source) || {}).label, examType: x.source }),
        })) },
        totals: {
            students: rows.length, passed, failed: rows.length - passed,
            passPct: rows.length ? share(passed, rows.length) : null,
            avgPct: pcts.length ? pct1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
            topPct: pcts.length ? Math.max(...pcts) : null,
        },
        filters,
    };
}

/* ── Analytics ────────────────────────────────────────────────────────────── */

/**
 * GET /admin/results/analytics — published results, summed.
 *
 * It counts RESULTS (one student in one exam), so a student who sat three
 * exams weighs three times in an average and once in "students assessed".
 * Archived exams are included: putting an exam away does not unpublish it.
 *
 * Averages are taken over the stored percentages in one place per figure, so
 * the same number is never worked out two different ways on one page.
 */
async function analytics(schoolId, q = {}) {
    // "Distinction" is the school's own threshold (Results → Settings), not a fixed 90%.
    const distinction = Number((await settings.get(schoolId)).distinctionPercent) || 75;
    // `exam: false` drops the exam filter (for the picker); `student` joins the
    // account, for the lists that print a name.
    const base = (p, { exam = true, student = false } = {}) => `
          FROM ${T.results} r
          ${student ? `JOIN ${T.users} u ON u."_id" = r."student"` : ''}
          JOIN ${T.exams} e ON e."_id" = r."exam" AND e."status" = 'FINAL_APPROVED'
          LEFT JOIN ${T.years} y    ON y."_id" = e."academicYear"
          LEFT JOIN ${T.sections} s ON s."_id" = e."section"
          LEFT JOIN ${T.classes} c  ON c."_id" = s."class"
         WHERE ${where(schoolId, {
        academicYear: q.academicYear, classNumber: q.classNumber, examType: q.examType, examId: exam ? q.examId : undefined,
    }, p, { tab: null, status: false })}`;
    const run = (build) => { const p = params(); const sql = build(p); return pool.query(sql, p.list); };
    const subjPct = `((x->>'marksObtained')::numeric / NULLIF((x->>'maxMarks')::numeric, 0)) * 100`;
    const sat = `COALESCE(x->>'isAbsent', 'false') <> 'true'`;

    const [kpi, grades, bands, subjects, sections, exams, top, low, options] = await Promise.all([
        run((p) => `
            SELECT count(DISTINCT e."_id")::int AS "exams", count(*)::int AS "results", count(DISTINCT r."student")::int AS "students",
                   count(*) FILTER (WHERE r."isPassed")::int AS "passed",
                   avg(r."percentage") AS "avgPct", max(r."percentage") AS "topPct",
                   count(*) FILTER (WHERE r."percentage" >= ${p.$(distinction)})::int AS "distinctions"
            ${base(p)}`),
        run((p) => `SELECT r."grade", count(*)::int AS "n" ${base(p)} GROUP BY 1`),
        run((p) => `
            SELECT LEAST(floor(r."percentage" / 10)::int, 9) AS "band", count(*)::int AS "n"
            ${base(p)} GROUP BY 1 ORDER BY 1`),
        run((p) => `
            SELECT min(sub."subjectName") AS "subjectName", count(*)::int AS "entries",
                   count(*) FILTER (WHERE ${sat})::int AS "appeared",
                   count(*) FILTER (WHERE (x->>'isPassed') = 'true')::int AS "passed",
                   avg(${subjPct}) FILTER (WHERE ${sat}) AS "avgPct",
                   max(${subjPct}) FILTER (WHERE ${sat}) AS "topPct"
              FROM (SELECT r."subjects" ${base(p)}) rr
              CROSS JOIN LATERAL jsonb_array_elements(${jarr('rr."subjects"')}) x
              JOIN ${T.subjects} sub ON sub."_id"::text = x->>'subject'
             GROUP BY lower(btrim(sub."subjectName"))
             ORDER BY "avgPct" DESC NULLS LAST, 1`),
        run((p) => `
            SELECT e."section" AS "_id", min(c."className") AS "className", min(s."sectionName") AS "sectionName", min(y."yearName") AS "yearName",
                   min(c."classNumber") AS "classNumber",
                   count(DISTINCT e."_id")::int AS "exams", count(DISTINCT r."student")::int AS "students", count(*)::int AS "results",
                   count(*) FILTER (WHERE r."isPassed")::int AS "passed", avg(r."percentage") AS "avgPct", max(r."percentage") AS "topPct"
            ${base(p)}
             GROUP BY e."section"
             ORDER BY ${naturalSql('min(y."yearName")')}, min(c."classNumber") NULLS LAST, ${naturalSql('min(s."sectionName")')}`),
        run((p) => `
            SELECT e."_id", e."title", e."examType", e."typeLabel", e."finalApprovedAt", e."publishDate", e."archivedAt",
                   min(c."className") AS "className", min(s."sectionName") AS "sectionName", min(y."yearName") AS "yearName",
                   count(*)::int AS "students", count(*) FILTER (WHERE r."isPassed")::int AS "passed",
                   avg(r."percentage") AS "avgPct", max(r."percentage") AS "topPct",
                   (SELECT u."name" FROM ${T.results} tr JOIN ${T.users} u ON u."_id" = tr."student"
                     WHERE tr."exam" = e."_id" AND tr."rank" = 1 ORDER BY u."name" LIMIT 1) AS "topper",
                   (SELECT count(*)::int FROM ${T.results} tr WHERE tr."exam" = e."_id" AND tr."rank" = 1) AS "toppers"
            ${base(p)}
             GROUP BY e."_id"
             ORDER BY e."finalApprovedAt" DESC NULLS LAST, e."title"
             LIMIT 200`),
        run((p) => `
            SELECT r."_id", u."name", r."percentage", r."grade", r."rank", r."totalMarks", r."totalMaxMarks",
                   e."title", c."className", s."sectionName"
            ${base(p, { student: true })}
             ORDER BY r."percentage" DESC, u."name" LIMIT 8`),
        run((p) => `
            SELECT r."_id", u."name", r."percentage", r."grade", r."totalMarks", r."totalMaxMarks",
                   e."title", c."className", s."sectionName",
                   (SELECT count(*)::int FROM jsonb_array_elements(${jarr('r."subjects"')}) x WHERE (x->>'isPassed') <> 'true') AS "failedSubjects"
            ${base(p, { student: true })}
               AND NOT r."isPassed"
             ORDER BY r."percentage", u."name" LIMIT 8`),
        // The exam picker lists what the other filters leave, whichever exam is chosen.
        run((p) => `
            SELECT e."_id", e."title", min(c."className") AS "className", min(s."sectionName") AS "sectionName"
            ${base(p, { exam: false })}
             GROUP BY e."_id" ORDER BY e."finalApprovedAt" DESC NULLS LAST, e."title" LIMIT 300`),
    ]);

    const k = kpi.rows[0] || {};
    const gradeN = new Map(grades.rows.map((g) => [g.grade, g.n]));
    const bandN = new Map(bands.rows.map((b) => [num(b.band), b.n]));
    const [{ rows: years }, { rows: classes }, conf] = await Promise.all([
        pool.query(`SELECT "_id", "yearName", "status" FROM ${T.years} WHERE "school" = $1::uuid ORDER BY ${yearOrderSql()}`, [String(schoolId)]),
        pool.query(`SELECT c."classNumber", min(c."className") AS "className" FROM ${T.classes} c
                     WHERE c."school" = $1::uuid AND c."classNumber" IS NOT NULL GROUP BY 1 ORDER BY 1`, [String(schoolId)]),
        settings.get(schoolId),
    ]);

    return {
        kpis: {
            exams: num(k.exams), results: num(k.results), students: num(k.students), passed: num(k.passed),
            failed: num(k.results) - num(k.passed), passPct: num(k.results) ? share(k.passed, k.results) : null,
            avgPct: pct1(k.avgPct), topPct: pct1(k.topPct), distinctions: num(k.distinctions), distinctionPercent: distinction,
        },
        grades: gradeList(conf.scale, grades.rows.map((g) => g.grade))
            .map((g) => ({ ...g, count: gradeN.get(g.grade) || 0, pct: share(gradeN.get(g.grade) || 0, k.results) })),
        // Every band is listed, empty ones included — a gap in a distribution is a finding, not a missing bar.
        bands: Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i === 9 ? 100 : i * 10 + 9, count: bandN.get(i) || 0 })),
        subjects: subjects.rows.map((s) => ({
            subjectName: s.subjectName, entries: num(s.entries), appeared: num(s.appeared), absent: num(s.entries) - num(s.appeared),
            passed: num(s.passed), passPct: num(s.appeared) ? share(s.passed, s.appeared) : null,
            avgPct: pct1(s.avgPct), topPct: pct1(s.topPct),
        })),
        sections: sections.rows.map((s) => ({
            _id: s._id, className: s.className || '', sectionName: s.sectionName || '', yearName: s.yearName || '',
            exams: num(s.exams), students: num(s.students), results: num(s.results),
            passPct: share(s.passed, s.results), avgPct: pct1(s.avgPct), topPct: pct1(s.topPct),
        })),
        exams: exams.rows.map((e) => ({
            _id: e._id, title: e.title, examType: e.examType, examTypeLabel: settings.typeLabelOf(e),
            className: e.className || '', sectionName: e.sectionName || '', yearName: e.yearName || '',
            publishedOn: publishedOn(e), publishDate: e.publishDate || null, archived: !!e.archivedAt,
            students: num(e.students), passed: num(e.passed), passPct: share(e.passed, e.students),
            avgPct: pct1(e.avgPct), topPct: pct1(e.topPct), topper: e.topper || '', toppers: num(e.toppers),
        })),
        top: top.rows.map((x) => ({ ...x, percentage: num(x.percentage), totalMarks: num(x.totalMarks), totalMaxMarks: num(x.totalMaxMarks), rank: num(x.rank) })),
        support: low.rows.map((x) => ({ ...x, percentage: num(x.percentage), totalMarks: num(x.totalMarks), totalMaxMarks: num(x.totalMaxMarks), failedSubjects: num(x.failedSubjects) })),
        filters: {
            years: years.map((y) => ({ _id: y._id, yearName: y.yearName, current: y.status === 'active' })),
            classes: classes.map((c) => ({ classNumber: num(c.classNumber), className: c.className })),
            examTypes: typeOptions(conf.examTypes),
            exams: options.rows.map((e) => ({ _id: e._id, title: e.title, className: e.className || '', sectionName: e.sectionName || '' })),
        },
    };
}

/* ── Merit list ───────────────────────────────────────────────────────────── */

/**
 * GET /admin/results/merit — a class ranked across all its sections (Oct
 * 2026): one exam (every section's results of it, as one list) or the year's
 * overall result. Ranks were only ever within a section, so "who topped Class
 * 10" had no answer on any screen.
 *   q: academicYear, classNumber, exam ('<typeKey>|<title>' or 'overall'), limit
 */
async function meritList(schoolId, q = {}) {
    const id = String(schoolId);
    const [{ rows: years }, { rows: classList }] = await Promise.all([
        pool.query(`SELECT "_id", "yearName", "status", "startDate" FROM ${T.years} WHERE "school" = $1::uuid ORDER BY ${yearOrderSql()}`, [id]),
        pool.query(`SELECT c."classNumber", min(c."className") AS "className" FROM ${T.classes} c
                     WHERE c."school" = $1::uuid AND c."classNumber" IS NOT NULL GROUP BY 1 ORDER BY 1`, [id]),
    ]);
    const year = years.find((y) => String(y._id) === String(q.academicYear || '')) || years.find((y) => y.status === 'active') || newestYear(years);
    const classes = classList.map((c) => ({ classNumber: num(c.classNumber), className: c.className }));
    const filters = { years: years.map((y) => ({ _id: y._id, yearName: y.yearName, current: y.status === 'active' })), classes };
    const cn = q.classNumber !== undefined && q.classNumber !== '' && Number.isFinite(Number(q.classNumber)) ? Number(q.classNumber) : (classes[0]?.classNumber ?? null);
    const { distinctionPercent } = await settings.get(id);
    const base = { year: year ? { _id: year._id, yearName: year.yearName } : null, classNumber: cn, exams: [], exam: null, rows: [], filters, distinctionPercent };
    if (!year || cn === null) return base;

    // The class's published exams, one per name and type across its sections.
    const { rows: cycles } = await pool.query(`
        SELECT COALESCE(NULLIF(e."typeKey", ''), e."examType") AS "typeKey", min(e."title") AS "title", min(NULLIF(e."typeLabel", '')) AS "typeLabel",
               min(e."examType") AS "examType", count(*)::int AS "sections", min(e."startDate") AS "startDate"
          FROM ${T.exams} e JOIN ${T.sections} s ON s."_id" = e."section" JOIN ${T.classes} c ON c."_id" = s."class"
         WHERE e."school" = $1::uuid AND e."academicYear" = $2::uuid AND c."classNumber" = $3 AND e."status" = 'FINAL_APPROVED'
         GROUP BY 1, lower(btrim(e."title")) ORDER BY min(e."startDate") NULLS LAST`, [id, String(year._id), cn]);
    const exams = cycles.map((c) => ({ key: `${c.typeKey}|${c.title}`, title: c.title, examTypeLabel: settings.typeLabelOf(c), sections: num(c.sections) }));
    const pick = String(q.exam || '') || (exams.at(-1)?.key ?? 'overall');
    const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100));
    const out = { ...base, exams, exam: pick };

    if (pick === 'overall') {
        const { years: ys } = await require('./resultOverall').yearsFor(id, year._id, { classNumber: cn });
        const ids = [...ys.keys()];
        const { rows: people } = ids.length ? await pool.query(`
            SELECT u."_id"::text AS "_id", u."name", sp."rollNumber", sp."admissionNumber" FROM ${T.users} u
              LEFT JOIN LATERAL (SELECT "rollNumber", "admissionNumber" FROM ${T.profiles} WHERE "user" = u."_id" ORDER BY "createdAt" DESC NULLS LAST LIMIT 1) sp ON true
             WHERE u."_id" = ANY($1::uuid[])`, [ids]) : { rows: [] };
        const who = new Map(people.map((x) => [x._id, x]));
        out.rows = ids.map((sid) => {
            const y = ys.get(sid);
            return {
                student: { _id: sid, name: who.get(sid)?.name || 'Student', rollNumber: who.get(sid)?.rollNumber || '', admissionNumber: who.get(sid)?.admissionNumber || '' },
                sectionName: y.sectionName || '', marks: y.marks, max: y.max, percentage: y.percentage, grade: y.grade, isPassed: y.isPassed,
                rank: y.classRank, sectionRank: y.rank, withheld: !!y.withheld,
            };
        }).sort((a, b) => a.rank - b.rank || a.student.name.localeCompare(b.student.name)).slice(0, limit);
        out.total = ids.length;
        return out;
    }

    const [typeKey, ...rest] = pick.split('|');
    const title = rest.join('|');
    const { rows } = await pool.query(`
        SELECT r."student"::text AS "student", u."name", sp."rollNumber", sp."admissionNumber", s."sectionName",
               r."totalMarks", r."totalMaxMarks", r."percentage", r."grade", r."isPassed", r."rank" AS "sectionRank",
               rank() OVER (ORDER BY (r."totalMarks"::numeric / NULLIF(r."totalMaxMarks"::numeric, 0)) DESC NULLS LAST)::int AS "rank",
               count(*) OVER ()::int AS "total",
               (${jarr('e."withheld"')} @> jsonb_build_array(jsonb_build_object('student', r."student"::text))) AS "withheld"
          FROM ${T.results} r
          JOIN ${T.exams} e ON e."_id" = r."exam"
          JOIN ${T.sections} s ON s."_id" = e."section" JOIN ${T.classes} c ON c."_id" = s."class"
          JOIN ${T.users} u ON u."_id" = r."student"
          LEFT JOIN LATERAL (SELECT "rollNumber", "admissionNumber" FROM ${T.profiles} WHERE "user" = r."student" ORDER BY "createdAt" DESC NULLS LAST LIMIT 1) sp ON true
         WHERE e."school" = $1::uuid AND e."academicYear" = $2::uuid AND c."classNumber" = $3 AND e."status" = 'FINAL_APPROVED'
           AND COALESCE(NULLIF(e."typeKey", ''), e."examType") = $4 AND lower(btrim(e."title")) = lower(btrim($5))
         ORDER BY "rank", u."name" LIMIT $6`, [id, String(year._id), cn, typeKey, title, limit]);
    out.rows = rows.map((x) => ({
        student: { _id: x.student, name: x.name, rollNumber: x.rollNumber || '', admissionNumber: x.admissionNumber || '' },
        sectionName: x.sectionName || '', marks: num(x.totalMarks), max: num(x.totalMaxMarks), percentage: num(x.percentage),
        grade: x.grade, isPassed: !!x.isPassed, rank: num(x.rank), sectionRank: num(x.sectionRank), withheld: !!x.withheld,
    }));
    out.total = rows[0]?.total || 0;
    return out;
}

module.exports = {
    TABS, STAGE_SQL: STAGE, AUDIT_LABELS, meritList,
    list, overview, detail, marksSheet, results, formMeta, subjectsFor, overall, analytics, shape, allowed,
    rosterRows, takersBySubject, classRanksFor,
    // SQL fragments the teacher's read model (services/resultTeacher) shares.
    SQL: { T, ROSTER, ANSWERED, jarr },
    publishedOn,
};
