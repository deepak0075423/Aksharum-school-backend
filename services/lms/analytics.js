'use strict';
/**
 * Video Learning — reports.
 *
 * Every figure comes from one question, asked in one piece of SQL (`expected`):
 * "which students were given which videos" — a section's roster today, crossed
 * with what its live releases open — joined to what each student has actually
 * watched (LmsProgress). Counting from what was GIVEN is what makes "not
 * started" a real number rather than an absence of rows.
 *
 * It is grouped in Postgres and paged before it reaches a browser; nothing
 * here loads a school's students or watch history into memory.
 *
 *   teacher   only the sections and subjects they teach — the scope is part of
 *             the query, not a filter the caller may leave off
 *   school    the whole school, for its admins
 *   central   platform-wide totals, for the Super Admin
 */
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const { q, T, bad, forbidden, notFound, id, idOrNull, dateOrNull, like, paging, cached, levelLabel } = require('./common');
const access = require('./access');

const one = async (sql, params) => (await q(sql, params))[0] || null;
const ROSTER = `CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(cs."enrolledStudents") = 'array' THEN cs."enrolledStudents" ELSE '[]'::jsonb END) AS e(sid)`;

/**
 * The WITH clause every report starts from.
 *   exp  one row per (student, chapter video) that a live release gives them
 *   j    the same, with that student's progress beside it (null when untouched)
 * `pairs` = the teacher's (section, subject) pairs; omitted for a school-wide report.
 */
function expected(schoolId, filters = {}, pairs = null) {
    const params = [schoolId];
    const where = [`r."school" = $1`, access.LIVE, access.stillAssigned];
    if (pairs) {
        params.push(pairs.map((p) => p.section), pairs.map((p) => p.schoolSubject));
        where.push(`EXISTS (SELECT 1 FROM unnest($2::uuid[], $3::uuid[]) AS tp(s, j) WHERE tp.s = r."section" AND tp.j = r."schoolSubject")`);
    }
    const add = (value, sql, label) => { const v = idOrNull(value, label); if (v) { params.push(v); where.push(sql.replace('?', `$${params.length}`)); } };
    add(filters.academicYear, `r."academicYear" = ?`, 'Academic year');
    add(filters.class, `r."class" = ?`, 'Class');
    add(filters.section, `r."section" = ?`, 'Section');
    add(filters.subject, `r."schoolSubject" = ?`, 'Subject');
    add(filters.book, `r."book" = ?`, 'Book');
    add(filters.chapter, `ch."_id" = ?`, 'Chapter');
    add(filters.video, `cv."_id" = ?`, 'Video');
    add(filters.student, `e.sid = ?::text`, 'Student');
    const from = dateOrNull(filters.from, 'From date');
    const to = dateOrNull(filters.to, 'To date');
    if (from) { params.push(from); where.push(`r."releaseAt" >= $${params.length}`); }
    if (to) { params.push(new Date(to.getTime() + 86400000)); where.push(`r."releaseAt" < $${params.length}`); }
    const sql = `
        WITH exp AS (
            SELECT DISTINCT r."academicYear", r."class", r."section", r."schoolSubject", e.sid AS student,
                   cv."_id" AS cv, cv."chapter", cv."book", cv."video", cv."displayOrder", v."durationSec"
              FROM ${T.release} r
              ${access.itemsJoin}
              JOIN ${T.section} cs ON cs."_id" = r."section"
              ${ROSTER}
              JOIN ${T.user} su ON su."_id"::text = e.sid AND su."role" = 'student' AND su."isActive" IS NOT FALSE
             WHERE ${where.join(' AND ')} AND (r."audience" = 'all' OR r."students" ? e.sid)
        ), j AS (
            SELECT x.*, p."status" AS pstatus, COALESCE(p."watchedPercent", 0) AS pct, COALESCE(p."watchedSeconds", 0) AS secs,
                   p."lastWatchedAt", p."firstWatchedAt", p."completedAt", COALESCE(p."sessionsCount", 0) AS sessions
              FROM exp x LEFT JOIN ${T.progress} p ON p."student"::text = x.student AND p."chapterVideo" = x.cv AND p."academicYear" = x."academicYear"
        ), per_student AS (
            SELECT student, section, count(*)::int AS total, count(*) FILTER (WHERE pstatus = 'completed')::int AS done,
                   count(*) FILTER (WHERE secs > 0)::int AS started, round(avg(CASE WHEN pstatus = 'completed' THEN 100 ELSE pct END))::int AS percent,
                   round(sum(secs))::int AS secs, max("lastWatchedAt") AS last
              FROM j GROUP BY student, section
        )`;
    return { sql, params };
}

const STATUS_SQL = `(CASE WHEN ps.started = 0 THEN 'not_started' WHEN ps.done = ps.total THEN 'completed' ELSE 'in_progress' END)`;

/** Totals, and completion chapter by chapter and book by book. */
async function summary(schoolId, filters, pairs) {
    const { sql, params } = expected(schoolId, filters, pairs);
    const row = await one(`${sql}
        SELECT
          (SELECT json_build_object(
                'studentsWithContent', count(*), 'started', count(*) FILTER (WHERE started > 0),
                'completed', count(*) FILTER (WHERE done = total), 'inProgress', count(*) FILTER (WHERE started > 0 AND done < total),
                'notStarted', count(*) FILTER (WHERE started = 0), 'watchSeconds', COALESCE(sum(secs), 0)) FROM per_student) AS students,
          (SELECT json_build_object('releasedVideos', count(DISTINCT cv), 'releasedChapters', count(DISTINCT chapter), 'books', count(DISTINCT book),
                'pairs', count(*), 'pairsCompleted', count(*) FILTER (WHERE pstatus = 'completed')) FROM j) AS content,
          (SELECT COALESCE(json_agg(x ORDER BY x."bookTitle", x."chapterNumber"), '[]'::json) FROM (
                SELECT j.chapter, ch."title", ch."chapterNumber", j.book, k."title" AS "bookTitle", count(DISTINCT j.cv)::int AS videos, count(DISTINCT j.student)::int AS students,
                       count(*)::int AS total, count(*) FILTER (WHERE j.pstatus = 'completed')::int AS completed,
                       round(avg(CASE WHEN j.pstatus = 'completed' THEN 100 ELSE j.pct END))::int AS percent
                  FROM j JOIN ${T.chapter} ch ON ch."_id" = j.chapter JOIN ${T.book} k ON k."_id" = j.book
                 GROUP BY j.chapter, ch."title", ch."chapterNumber", j.book, k."title") x) AS chapters,
          (SELECT COALESCE(json_agg(x ORDER BY x."title"), '[]'::json) FROM (
                SELECT j.book, k."title", count(DISTINCT j.cv)::int AS videos, count(DISTINCT j.student)::int AS students,
                       count(*)::int AS total, count(*) FILTER (WHERE j.pstatus = 'completed')::int AS completed,
                       round(avg(CASE WHEN j.pstatus = 'completed' THEN 100 ELSE j.pct END))::int AS percent
                  FROM j JOIN ${T.book} k ON k."_id" = j.book GROUP BY j.book, k."title") x) AS books`, params);
    return row;
}

/** One line per student: how much of what they were given they have watched. Paged, searchable, filterable by status. */
async function students(schoolId, filters, pairs, query = {}, { all = false } = {}) {
    const { sql, params } = expected(schoolId, filters, pairs);
    const pg = paging(query, { def: 20, max: 100 });
    const where = [];
    if (query.search) { params.push(like(query.search)); where.push(`(u."name" ILIKE $${params.length} OR sp."admissionNumber"::text ILIKE $${params.length})`); }
    if (query.status) {
        if (!['not_started', 'in_progress', 'completed'].includes(query.status)) throw bad('Status is not valid');
        params.push(query.status); where.push(`${STATUS_SQL} = $${params.length}`);
    }
    const body = `
          FROM per_student ps
          JOIN ${T.user} u ON u."_id"::text = ps.student
          JOIN ${T.section} cs ON cs."_id" = ps.section JOIN ${T.class} c ON c."_id" = cs."class"
          LEFT JOIN ${T.studentProfile} sp ON sp."user" = u."_id"
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const [{ n }] = await q(`${sql} SELECT count(*)::int AS n ${body}`, params);
    const rows = await q(`${sql}
        SELECT u."_id", u."name", sp."rollNumber", sp."admissionNumber", c."className", cs."sectionName", ps.section,
               ps.total AS "videos", ps.done AS "completed", ps.started, ps.percent, ps.secs AS "watchSeconds", ps.last AS "lastWatchedAt", ${STATUS_SQL} AS "status"
        ${body}
         ORDER BY c."classNumber", cs."sectionName", NULLIF(regexp_replace(COALESCE(sp."rollNumber"::text, ''), '[^0-9]', '', 'g'), '')::numeric NULLS LAST, lower(u."name")
         ${all ? 'LIMIT 5000' : `LIMIT ${pg.limit} OFFSET ${pg.offset}`}`, params);
    return { rows, total: n, pg };
}

// ── Teacher ──────────────────────────────────────────────────────────────────

/** The filters a teacher can choose from: their own sections, subjects and books — nothing else exists for them. */
async function teacherFilters(scope) {
    const bookIds = [...new Set(scope.assignments.map((a) => String(a.book)))];
    const books = bookIds.length ? await q(`SELECT "_id", "title" FROM ${T.book} WHERE "_id" = ANY($1::uuid[]) ORDER BY lower("title")`, [bookIds]) : [];
    const uniq = (list, key) => [...new Map(list.map((x) => [String(x[key]), x])).values()];
    return {
        years: uniq(scope.pairs, 'academicYear').map((p) => ({ _id: p.academicYear, name: p.yearName })),
        classes: uniq(scope.pairs, 'class').map((p) => ({ _id: p.class, name: p.className })),
        sections: uniq(scope.pairs, 'section').map((p) => ({ _id: p.section, class: p.class, name: `${p.className} ${p.sectionName}` })),
        subjects: uniq(scope.pairs, 'schoolSubject').map((p) => ({ _id: p.schoolSubject, name: p.subjectName })),
        books: books.map((b) => ({ ...b, sections: scope.assignments.filter((a) => String(a.book) === String(b._id)).map((a) => a.section) })),
    };
}

async function teacherDashboard(user, filters, { fresh = false } = {}) {
    const scope = await access.teacherScope(user);
    const options = await teacherFilters(scope);
    if (!scope.pairs.length) return { options, assignedStudents: 0, students: null, content: null, chapters: [], books: [] };
    const compute = async () => {
        const data = await summary(scope.schoolId, filters, scope.pairs);
        // Everyone on the rosters in view — whether or not anything is released to them yet.
        const sections = scope.pairs.filter((p) => (!filters.section || String(p.section) === String(filters.section))
            && (!filters.class || String(p.class) === String(filters.class)) && (!filters.subject || String(p.schoolSubject) === String(filters.subject))
            && (!filters.academicYear || String(p.academicYear) === String(filters.academicYear))).map((p) => p.section);
        const [{ n }] = await q(`
            SELECT count(DISTINCT e.sid)::int AS n FROM ${T.section} cs ${ROSTER}
              JOIN ${T.user} su ON su."_id"::text = e.sid AND su."role" = 'student' AND su."isActive" IS NOT FALSE
             WHERE cs."_id" = ANY($1::uuid[]) AND cs."school" = $2`, [sections, scope.schoolId]);
        return { assignedStudents: n, ...data };
    };
    const key = `t:${user._id}:${JSON.stringify(filters)}`;
    return { options, ...(fresh ? await compute() : await cached(key, 15, compute, [String(scope.schoolId), 'library'])) };
}

async function teacherStudents(user, filters, query) {
    const scope = await access.teacherScope(user);
    if (!scope.pairs.length) return { rows: [], total: 0, pg: paging(query) };
    return students(scope.schoolId, filters, scope.pairs, query);
}

/** Everything about one student that a teacher of theirs may see — and only for the subjects that teacher takes. */
async function studentReport(user, studentId, filters = {}) {
    const scope = await access.teacherScope(user);
    const sid = id(studentId, 'Student');
    const student = await one(`
        SELECT u."_id", u."name", sp."rollNumber", sp."admissionNumber", cs."_id" AS "section", cs."sectionName", c."className"
          FROM ${T.user} u
          JOIN ${T.section} cs ON cs."school" = u."school" AND cs."enrolledStudents" ? u."_id"::text AND cs."_id" = ANY($3::uuid[])
          JOIN ${T.class} c ON c."_id" = cs."class"
          LEFT JOIN ${T.studentProfile} sp ON sp."user" = u."_id"
         WHERE u."_id" = $1 AND u."school" = $2 AND u."role" = 'student' LIMIT 1`, [sid, scope.schoolId, scope.pairs.map((p) => p.section)]);
    if (!student) throw forbidden('This student is not in a section you teach', 'OUT_OF_SCOPE');
    const { sql, params } = expected(scope.schoolId, { ...filters, student: sid }, scope.pairs);
    const [videos, sessions] = await Promise.all([
        q(`${sql}
            SELECT j.cv AS "chapterVideo", v."title", j."durationSec", ch."title" AS "chapterTitle", ch."chapterNumber", k."_id" AS "book", k."title" AS "bookTitle",
                   (CASE WHEN j.pstatus = 'completed' THEN 'completed' WHEN j.secs > 0 THEN 'in_progress' ELSE 'not_started' END) AS "status",
                   (CASE WHEN j.pstatus = 'completed' THEN 100 ELSE j.pct END) AS "watchedPercent", round(j.secs)::int AS "watchSeconds",
                   j."firstWatchedAt", j."lastWatchedAt", j."completedAt", j.sessions
              FROM j JOIN ${T.video} v ON v."_id" = j.video JOIN ${T.chapter} ch ON ch."_id" = j.chapter JOIN ${T.book} k ON k."_id" = j.book
             ORDER BY lower(k."title"), ch."chapterNumber", j."displayOrder"`, params),
        // The sittings behind those figures — for the subjects this teacher takes only.
        q(`SELECT s."startedAt", s."endedAt", s."lastBeatAt", round(s."creditedSec")::int AS "watchSeconds", s."seekViolations", s."closeReason", s."status",
                  v."title", ch."chapterNumber"
             FROM ${T.session} s JOIN ${T.progress} p ON p."_id" = s."progress" JOIN ${T.video} v ON v."_id" = s."video" LEFT JOIN ${T.chapter} ch ON ch."_id" = s."chapter"
            WHERE s."student" = $1 AND s."school" = $2 AND p."schoolSubject" = ANY($3::uuid[])
            ORDER BY s."startedAt" DESC LIMIT 50`, [sid, scope.schoolId, scope.pairs.map((p) => p.schoolSubject)]),
    ]);
    const books = [...new Map(videos.map((v) => [String(v.book), { _id: v.book, title: v.bookTitle }])).values()];
    const done = videos.filter((v) => v.status === 'completed').length;
    return {
        student, books, videos, sessions,
        totals: {
            assignedBooks: books.length, releasedChapters: new Set(videos.map((v) => `${v.book}|${v.chapterNumber}`)).size, videos: videos.length,
            watched: videos.filter((v) => v.status !== 'not_started').length, notWatched: videos.filter((v) => v.status === 'not_started').length, completed: done,
            percent: videos.length ? Math.round(videos.reduce((n, v) => n + Number(v.watchedPercent || 0), 0) / videos.length) : 0,
            watchSeconds: videos.reduce((n, v) => n + (v.watchSeconds || 0), 0),
            lastWatchedAt: videos.map((v) => v.lastWatchedAt).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null,
            status: !videos.length ? 'nothing_released' : done === videos.length ? 'completed' : videos.some((v) => v.status !== 'not_started') ? 'in_progress' : 'not_started',
        },
    };
}

// ── School and platform ──────────────────────────────────────────────────────

async function schoolOverview(schoolId, filters, { fresh = false } = {}) {
    const compute = async () => {
        const { sql, params } = expected(schoolId, filters, null);
        const [data, sections, setup] = await Promise.all([
            summary(schoolId, filters, null),
            q(`${sql}
                SELECT cs."_id" AS section, c."className", cs."sectionName", count(*)::int AS students,
                       count(*) FILTER (WHERE ps.started > 0)::int AS started, count(*) FILTER (WHERE ps.done = ps.total)::int AS completed,
                       round(avg(ps.percent))::int AS percent, round(sum(ps.secs))::int AS "watchSeconds"
                  FROM per_student ps JOIN ${T.section} cs ON cs."_id" = ps.section JOIN ${T.class} c ON c."_id" = cs."class"
                 GROUP BY cs."_id", c."className", c."classNumber", cs."sectionName" ORDER BY c."classNumber", cs."sectionName"`, params),
            one(`
                SELECT (SELECT count(DISTINCT "class") FROM ${T.schoolSubject} WHERE "school" = $1)::int AS "classesConfigured",
                       (SELECT count(*) FROM ${T.schoolSubject} WHERE "school" = $1)::int AS "subjectsSelected",
                       (SELECT count(DISTINCT "book") FROM ${T.assignment} WHERE "school" = $1 AND "status" = 'active')::int AS "booksFollowed",
                       (SELECT count(*) FROM ${T.release} r WHERE r."school" = $1 AND ${access.LIVE})::int AS "liveReleases",
                       (SELECT count(*) FROM ${T.request} WHERE "school" = $1 AND "status" IN ('pending', 'under_review', 'approved', 'in_progress'))::int AS "openRequests"`, [schoolId]),
        ]);
        return { ...data, sections, setup };
    };
    return fresh ? compute() : cached(`s:${JSON.stringify(filters)}`, 60, compute, [String(schoolId), 'library']);
}

async function centralOverview({ fresh = false } = {}) {
    const compute = async () => {
        const [totals, topBooks, schools, queue, recent] = await Promise.all([
            one(`
                SELECT (SELECT count(*) FROM ${T.board} WHERE "isActive")::int AS boards,
                       (SELECT count(*) FROM ${T.subject} WHERE "status" = 'active')::int AS subjects,
                       (SELECT count(*) FROM ${T.book} WHERE "status" = 'active')::int AS books,
                       (SELECT count(*) FROM ${T.chapter} WHERE "status" = 'active')::int AS chapters,
                       (SELECT count(*) FROM ${T.chapter} c WHERE c."status" = 'active' AND NOT EXISTS (SELECT 1 FROM ${T.chapterVideo} cv WHERE cv."chapter" = c."_id" AND cv."isActive"))::int AS "chaptersWithoutVideos",
                       (SELECT count(*) FROM ${T.video})::int AS videos,
                       (SELECT count(*) FROM ${T.video} WHERE "processingStatus" = 'ready' AND "isActive")::int AS "videosReady",
                       (SELECT count(*) FROM ${T.video} v WHERE NOT EXISTS (SELECT 1 FROM ${T.chapterVideo} cv WHERE cv."video" = v."_id"))::int AS "videosUnmapped",
                       (SELECT count(*) FROM ${T.chapterVideo} WHERE "isActive")::int AS mappings,
                       (SELECT COALESCE(sum("sizeBytes"), 0) FROM ${T.video})::float8 AS "storageBytes",
                       (SELECT count(DISTINCT "school") FROM ${T.assignment} WHERE "status" = 'active')::int AS "schoolsUsing",
                       (SELECT count(*) FROM ${T.release} r WHERE ${access.LIVE})::int AS "liveReleases",
                       (SELECT count(DISTINCT "student") FROM ${T.progress} WHERE "watchedSeconds" > 0)::int AS "studentsWatching",
                       (SELECT COALESCE(sum("watchedSeconds"), 0) FROM ${T.progress})::float8 AS "watchSeconds",
                       (SELECT count(*) FROM ${T.progress} WHERE "status" = 'completed')::int AS "videosCompleted",
                       (SELECT count(*) FROM ${T.request} WHERE "status" = 'pending')::int AS "requestsPending",
                       (SELECT count(*) FROM ${T.request} WHERE "status" IN ('under_review', 'approved', 'in_progress'))::int AS "requestsInHand"`, []),
            q(`SELECT k."_id", k."title", k."classLevel", b."code" AS "boardCode", s."name" AS "subjectName",
                      count(DISTINCT a."school")::int AS schools,
                      (SELECT count(DISTINCT p."student") FROM ${T.progress} p WHERE p."book" = k."_id" AND p."watchedSeconds" > 0)::int AS viewers
                 FROM ${T.book} k JOIN ${T.board} b ON b."_id" = k."board" JOIN ${T.subject} s ON s."_id" = k."subject"
                 LEFT JOIN ${T.assignment} a ON a."book" = k."_id" AND a."status" = 'active'
                WHERE k."status" <> 'archived' GROUP BY k."_id", k."title", k."classLevel", b."code", s."name"
               HAVING count(DISTINCT a."school") > 0 ORDER BY schools DESC, viewers DESC LIMIT 8`, []),
            q(`SELECT s."_id", s."name", b."code" AS "boardCode", count(DISTINCT a."book")::int AS books,
                      (SELECT count(*) FROM ${T.release} r WHERE r."school" = s."_id" AND ${access.LIVE})::int AS "liveReleases",
                      (SELECT count(DISTINCT p."student") FROM ${T.progress} p WHERE p."school" = s."_id" AND p."watchedSeconds" > 0)::int AS viewers
                 FROM ${T.schoolConfig} c JOIN ${T.school} s ON s."_id" = c."school" JOIN ${T.board} b ON b."_id" = c."board"
                 JOIN ${T.year} y ON y."_id" = c."academicYear" AND y."status" = 'active'
                 LEFT JOIN ${T.assignment} a ON a."school" = s."_id" AND a."status" = 'active'
                GROUP BY s."_id", s."name", b."code" ORDER BY books DESC, lower(s."name") LIMIT 12`, []),
            q(`SELECT "_id", "title", "provider", "processingStatus", "processingError", "updatedAt" FROM ${T.video}
                WHERE "processingStatus" IN ('uploading', 'queued', 'processing', 'failed') ORDER BY "updatedAt" DESC LIMIT 8`, []),
            q(`SELECT a."action", a."summary", a."entityType", a."createdAt", u."name" AS "actorName"
                 FROM ${T.audit} a LEFT JOIN ${T.user} u ON u."_id" = a."actor" WHERE a."school" IS NULL ORDER BY a."createdAt" DESC LIMIT 10`, []),
        ]);
        return { totals, topBooks: topBooks.map((b) => ({ ...b, classLabel: levelLabel(b.classLevel) })), schools, queue, recent };
    };
    return fresh ? compute() : cached('central', 60, compute, ['central']);
}

/** The module's history — the central library's, or one school's. Paged. */
async function auditLog(query, schoolId = undefined) {
    const pg = paging(query, { def: 25 });
    const params = [];
    const where = [];
    if (schoolId === null) where.push('a."school" IS NULL');
    else if (schoolId) { params.push(schoolId); where.push(`a."school" = $${params.length}`); }
    if (query.entityType) { params.push(String(query.entityType).slice(0, 40)); where.push(`a."entityType" = $${params.length}`); }
    if (query.entityId) { params.push(id(query.entityId)); where.push(`a."entityId" = $${params.length}`); }
    if (query.search) { params.push(like(query.search)); where.push(`(a."summary" ILIKE $${params.length} OR a."action" ILIKE $${params.length} OR u."name" ILIKE $${params.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM ${T.audit} a LEFT JOIN ${T.user} u ON u."_id" = a."actor"`;
    const [{ n }] = await q(`SELECT count(*)::int AS n ${from} ${w}`, params);
    const rows = await q(`SELECT a."_id", a."action", a."entityType", a."entityId", a."summary", a."meta", a."actorRole", a."createdAt", u."name" AS "actorName"
                            ${from} ${w} ORDER BY a."createdAt" DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, params);
    return { rows, total: n, pg };
}

// ── Exports ──────────────────────────────────────────────────────────────────

const mins = (s) => Math.round((Number(s) || 0) / 60);
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const WORDS = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed', nothing_released: 'Nothing released' };

function xlsx(sheets) {
    const wb = XLSX.utils.book_new();
    for (const [name, rows] of sheets) {
        const ws = XLSX.utils.aoa_to_sheet(rows);
        ws['!cols'] = (rows[0] || []).map((_, i) => ({ wch: Math.min(48, Math.max(10, ...rows.map((r) => String(r[i] ?? '').length + 2))) }));
        XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    }
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** A plain table as a PDF. `widths` are fractions of the page width. */
function pdf(title, subtitle, header, rows, widths) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
        const W = doc.page.width - 72;
        const xs = widths.reduce((acc, w) => [...acc, acc[acc.length - 1] + w * W], [36]);
        const line = (cells, y, bold) => {
            doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
            cells.forEach((c, i) => doc.text(String(c ?? ''), xs[i] + 3, y, { width: widths[i] * W - 6, height: 11, ellipsis: true, lineBreak: false }));
        };
        const head = () => {
            doc.font('Helvetica-Bold').fontSize(14).fillColor('#1e293b').text(title, 36, 32);
            doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(subtitle, 36, 50);
            doc.rect(36, 68, W, 16).fill('#eef2ff'); doc.fillColor('#1e293b');
            line(header, 72, true);
            return 90;
        };
        let y = head();
        rows.forEach((r, i) => {
            if (y > doc.page.height - 50) { doc.addPage(); y = head(); }
            if (i % 2) { doc.rect(36, y - 3, W, 14).fill('#f8fafc'); doc.fillColor('#1e293b'); }
            line(r, y, false);
            y += 14;
        });
        if (!rows.length) doc.font('Helvetica').fontSize(10).fillColor('#64748b').text('Nothing to show for these filters.', 36, y + 6);
        doc.end();
    });
}

/** The teacher's class report as a file: one line per student. `format` = xlsx | pdf. */
async function teacherExport(user, filters, format) {
    const scope = await access.teacherScope(user);
    const { rows } = scope.pairs.length ? await students(scope.schoolId, filters, scope.pairs, {}, { all: true }) : { rows: [] };
    const header = ['Roll no', 'Student', 'Class', 'Section', 'Videos released', 'Completed', 'Progress %', 'Watch time (min)', 'Last watched', 'Status'];
    const body = rows.map((r) => [r.rollNumber ?? '', r.name, r.className, r.sectionName, r.videos, r.completed, r.percent, mins(r.watchSeconds), day(r.lastWatchedAt), WORDS[r.status]]);
    const stamp = `Generated ${day(new Date())} by ${user.name || 'teacher'} · ${rows.length} student(s)`;
    if (format === 'pdf') {
        return { buffer: await pdf('Video Learning — class progress', stamp, header, body, [0.07, 0.2, 0.09, 0.07, 0.1, 0.08, 0.08, 0.11, 0.1, 0.1]), type: 'application/pdf', name: 'video-progress.pdf' };
    }
    return { buffer: xlsx([['Class progress', [header, ...body]]]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'video-progress.xlsx' };
}

/** One student's report as a file. */
async function studentExport(user, studentId, format) {
    const r = await studentReport(user, studentId);
    const header = ['Book', 'Chapter', 'Video', 'Length (min)', 'Watched %', 'Watch time (min)', 'Sittings', 'Last watched', 'Status'];
    const body = r.videos.map((v) => [v.bookTitle, `${v.chapterNumber}. ${v.chapterTitle}`, v.title, mins(v.durationSec), Math.round(v.watchedPercent), mins(v.watchSeconds), v.sessions, day(v.lastWatchedAt), WORDS[v.status]]);
    const who = `${r.student.name} · ${r.student.className} ${r.student.sectionName} · ${r.totals.completed} of ${r.totals.videos} videos completed · ${day(new Date())}`;
    const safe = String(r.student.name || 'student').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
    if (format === 'pdf') {
        return { buffer: await pdf('Video Learning — student report', who, header, body, [0.17, 0.17, 0.2, 0.07, 0.07, 0.09, 0.06, 0.09, 0.08]), type: 'application/pdf', name: `video-report-${safe}.pdf` };
    }
    const sessions = [['Started', 'Video', 'Watch time (min)', 'Ended'], ...r.sessions.map((s) => [new Date(s.startedAt).toLocaleString('en-IN'), s.title, mins(s.watchSeconds), s.endedAt ? new Date(s.endedAt).toLocaleString('en-IN') : 'Open'])];
    return { buffer: xlsx([['Videos', [header, ...body]], ['Viewing history', sessions]]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: `video-report-${safe}.xlsx` };
}

module.exports = { teacherDashboard, teacherStudents, studentReport, schoolOverview, students, centralOverview, auditLog, teacherExport, studentExport, expected, summary };
