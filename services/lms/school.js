'use strict';
/**
 * Video Learning — a school's own set-up (School Admin).
 *
 *   1. the board the school follows this academic year      (LmsSchoolConfig)
 *   2. for each of its classes, the subjects it follows —
 *      each tied to one of the school's own subjects         (LmsSchoolSubject)
 *   3. for each subject, the books — for the whole class or
 *      for chosen sections                                   (LmsBookAssignment)
 *
 * A school never copies or edits a book; it only says which ones it follows.
 * What is missing from the library is asked for (LmsRequest).
 *
 * Every function takes the school from the signed-in user. A class, section,
 * subject or year named in a request is looked up INSIDE that school, so an
 * id belonging to another school is simply not found.
 */
const fs = require('fs');
const path = require('path');
const {
    q, M, T, bad, notFound, conflict, str, id, idOrNull, int, oneOf, classLevel, levelLabel, like, paging,
} = require('./common');
const { withTransaction } = require('../dbTx');
const notices = require('./notices');

const one = async (sql, params) => (await q(sql, params))[0] || null;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const OPEN = ['pending', 'under_review', 'approved', 'in_progress'];
const NEXT = {
    pending: ['under_review', 'approved', 'rejected'],
    under_review: ['approved', 'rejected'],
    approved: ['in_progress', 'completed', 'rejected'],
    in_progress: ['completed', 'rejected'],
    rejected: [], completed: [],
};
const REQUEST_DIR = path.join(__dirname, '..', '..', 'uploads', 'lms-requests');

// ── Reading the set-up ───────────────────────────────────────────────────────

async function yearOf(schoolId, yearId) {
    const years = await q(`SELECT "_id", "yearName", "status", "startDate" FROM ${T.year} WHERE "school" = $1 ORDER BY "startDate"`, [schoolId]);
    const year = yearId
        ? years.find((y) => String(y._id) === String(yearId))
        : (years.filter((y) => y.status === 'active').sort((a, b) => new Date(b.startDate) - new Date(a.startDate))[0] || years[years.length - 1]);
    if (yearId && !year) throw notFound('Academic year');
    return { years, year: year || null };
}

/**
 * Everything the set-up screen shows for one academic year: the board, and
 * each class with its sections, the subjects it follows and the books
 * assigned — plus what it could still choose from.
 */
async function setup(schoolId, yearId = null) {
    const { years, year } = await yearOf(schoolId, yearId ? id(yearId, 'Academic year') : null);
    const boards = await q(`SELECT "_id", "name", "code", "classLevels" FROM ${T.board} WHERE "isActive" ORDER BY lower("name")`, []);
    if (!year) return { years, year: null, boards, config: null, classes: [] };
    const config = await one(`
        SELECT c."_id", c."board", b."name" AS "boardName", b."code" AS "boardCode", b."classLevels", b."isActive" AS "boardActive"
          FROM ${T.schoolConfig} c JOIN ${T.board} b ON b."_id" = c."board" WHERE c."school" = $1 AND c."academicYear" = $2`, [schoolId, year._id]);
    const [classes, sections, ownSubjects, followed, assignments, mapped] = await Promise.all([
        q(`SELECT "_id", "className", "classNumber" FROM ${T.class} WHERE "school" = $1 AND "academicYear" = $2 AND "status" <> 'archived' ORDER BY "classNumber"`, [schoolId, year._id]),
        q(`SELECT "_id", "class", "sectionName" FROM ${T.section} WHERE "school" = $1 AND "academicYear" = $2 AND "status" <> 'archived' ORDER BY "sectionName"`, [schoolId, year._id]),
        q(`SELECT cs."class", s."_id", s."subjectName", s."subjectCode"
             FROM ${T.classSubject} cs JOIN ${T.schoolSubjectRow} s ON s."_id" = cs."subject" AND s."school" = $1
             JOIN ${T.class} c ON c."_id" = cs."class" AND c."school" = $1 AND c."academicYear" = $2
            ORDER BY lower(s."subjectName")`, [schoolId, year._id]),
        q(`SELECT x."_id", x."class", x."lmsSubject", x."schoolSubject", ls."name", ls."code", ss."subjectName" AS "schoolSubjectName"
             FROM ${T.schoolSubject} x JOIN ${T.subject} ls ON ls."_id" = x."lmsSubject"
             LEFT JOIN ${T.schoolSubjectRow} ss ON ss."_id" = x."schoolSubject"
            WHERE x."school" = $1 AND x."academicYear" = $2 ORDER BY lower(ls."name")`, [schoolId, year._id]),
        q(`SELECT a."_id", a."class", a."section", a."lmsSubject", a."book", a."startedAt",
                  k."title", k."publisher", k."edition", k."coverUrl", k."status" AS "bookStatus",
                  (SELECT count(*) FROM ${T.chapter} c WHERE c."book" = k."_id" AND c."status" = 'active')::int AS "chapterCount",
                  (SELECT count(*) FROM ${T.chapterVideo} cv WHERE cv."book" = k."_id" AND cv."isActive")::int AS "videoCount"
             FROM ${T.assignment} a JOIN ${T.book} k ON k."_id" = a."book"
            WHERE a."school" = $1 AND a."academicYear" = $2 AND a."status" = 'active' ORDER BY lower(k."title")`, [schoolId, year._id]),
        config ? q(`
            SELECT m."classLevel", s."_id", s."name", s."code",
                   (SELECT count(*) FROM ${T.book} k WHERE k."board" = m."board" AND k."classLevel" = m."classLevel" AND k."subject" = s."_id" AND k."status" = 'active')::int AS "bookCount"
              FROM ${T.subjectMap} m JOIN ${T.subject} s ON s."_id" = m."subject" AND s."status" = 'active'
             WHERE m."board" = $1 ORDER BY lower(s."name")`, [config.board]) : [],
    ]);
    const same = (a, b) => String(a) === String(b);
    return {
        years, year, boards, config,
        classes: classes.map((c) => {
            const secs = sections.filter((s) => same(s.class, c._id));
            const inBoard = !!config && (config.classLevels || []).includes(c.classNumber);
            return {
                ...c, sections: secs, inBoard,
                ownSubjects: ownSubjects.filter((s) => same(s.class, c._id)).map(({ class: _c, ...s }) => s),
                availableSubjects: inBoard ? mapped.filter((m) => m.classLevel === c.classNumber) : [],
                subjects: followed.filter((f) => same(f.class, c._id)).map((f) => {
                    const books = new Map();
                    for (const a of assignments.filter((x) => same(x.class, c._id) && same(x.lmsSubject, f.lmsSubject))) {
                        if (!books.has(String(a.book))) {
                            books.set(String(a.book), { book: a.book, title: a.title, publisher: a.publisher, edition: a.edition, coverUrl: a.coverUrl, bookStatus: a.bookStatus,
                                chapterCount: a.chapterCount, videoCount: a.videoCount, allSections: false, sections: [] });
                        }
                        const b = books.get(String(a.book));
                        if (a.section) b.sections.push(a.section); else b.allSections = true;
                    }
                    return { ...f, books: [...books.values()] };
                }),
            };
        }),
    };
}

// ── Step 1: the board ────────────────────────────────────────────────────────

/**
 * Say which board the school follows in a year. Changing it once subjects and
 * books are chosen ends those assignments (they belong to the old board) —
 * so that needs `confirm: true`. Nothing a student watched is touched.
 */
async function setBoard(schoolId, body, userId) {
    const { year } = await yearOf(schoolId, id(body.academicYear, 'Academic year'));
    const board = await M.board.findById(id(body.board, 'Board')).lean();
    if (!board || !board.isActive) throw notFound('Board');
    const existing = await M.schoolConfig.findOne({ school: schoolId, academicYear: year._id }).lean();
    if (existing && String(existing.board) === String(board._id)) return { changed: false };
    if (!existing) {
        await M.schoolConfig.create({ school: schoolId, academicYear: year._id, board: board._id, configuredBy: userId, updatedBy: userId });
        return { changed: true, ended: 0 };
    }
    const live = await one(`
        SELECT (SELECT count(*) FROM ${T.assignment} WHERE "school" = $1 AND "academicYear" = $2 AND "status" = 'active')::int AS books,
               (SELECT count(*) FROM ${T.schoolSubject} WHERE "school" = $1 AND "academicYear" = $2)::int AS subjects`, [schoolId, year._id]);
    if ((live.books || live.subjects) && body.confirm !== true) {
        throw conflict(`Changing the board removes this year's ${live.subjects} subject selection(s) and ends ${live.books} book assignment(s), because they belong to the current board. Students keep what they have watched.`, 'CONFIRM_BOARD_CHANGE', { subjects: live.subjects, books: live.books });
    }
    await withTransaction(async (tx) => {
        await tx(`UPDATE ${T.assignment} SET "status" = 'ended', "endedAt" = now(), "endedBy" = $3, "updatedAt" = now()
                   WHERE "school" = $1 AND "academicYear" = $2 AND "status" = 'active'`, [schoolId, year._id, userId]);
        await tx(`DELETE FROM ${T.schoolSubject} WHERE "school" = $1 AND "academicYear" = $2`, [schoolId, year._id]);
        await tx(`UPDATE ${T.schoolConfig} SET "board" = $3, "updatedBy" = $4, "updatedAt" = now() WHERE "school" = $1 AND "academicYear" = $2`, [schoolId, year._id, board._id, userId]);
    });
    return { changed: true, ended: live.books };
}

// ── Step 2: the subjects of a class ──────────────────────────────────────────

async function classOf(schoolId, classId) {
    const cls = await one(`SELECT "_id", "className", "classNumber", "academicYear" FROM ${T.class} WHERE "_id" = $1 AND "school" = $2`, [id(classId, 'Class'), schoolId]);
    if (!cls) throw notFound('Class');
    const config = await M.schoolConfig.findOne({ school: schoolId, academicYear: cls.academicYear }).lean();
    if (!config) throw bad('Choose the board your school follows this year first');
    return { cls, config };
}

/**
 * Set the subjects a class follows: [{ lmsSubject, schoolSubject }]. Each
 * central subject is tied to one of the class's OWN subjects — that is how
 * the right teachers get the right books. A subject whose books are assigned
 * cannot be dropped until those assignments are ended.
 */
async function setClassSubjects(schoolId, classId, list, userId) {
    const { cls, config } = await classOf(schoolId, classId);
    const want = new Map();
    const usedOwn = new Set();
    for (const row of Array.isArray(list) ? list : []) {
        const lmsSubject = id(row.lmsSubject, 'Subject');
        const schoolSubject = id(row.schoolSubject, 'Your subject');
        if (want.has(lmsSubject)) throw bad('A subject is listed twice');
        if (usedOwn.has(schoolSubject)) throw bad('One of your subjects is tied to two library subjects — each needs its own');
        usedOwn.add(schoolSubject);
        want.set(lmsSubject, schoolSubject);
    }
    if (want.size) {
        const mapped = await q(`SELECT m."subject" FROM ${T.subjectMap} m JOIN ${T.subject} s ON s."_id" = m."subject" AND s."status" = 'active'
                                 WHERE m."board" = $1 AND m."classLevel" = $2 AND m."subject" = ANY($3::uuid[])`, [config.board, cls.classNumber, [...want.keys()]]);
        if (mapped.length !== want.size) throw bad(`One of those subjects is not offered for ${cls.className} on your board`);
        const own = await q(`SELECT cs."subject" FROM ${T.classSubject} cs JOIN ${T.schoolSubjectRow} s ON s."_id" = cs."subject" AND s."school" = $2
                              WHERE cs."class" = $1 AND cs."subject" = ANY($3::uuid[])`, [cls._id, schoolId, [...want.values()]]);
        if (own.length !== want.size) throw bad(`Each library subject must be tied to a subject ${cls.className} already has (Academics › Classes › Subjects)`);
    }
    const have = await M.schoolSubject.find({ class: cls._id }).lean();
    for (const h of have.filter((x) => !want.has(String(x.lmsSubject)))) {
        const n = await M.assignment.countDocuments({ class: cls._id, lmsSubject: h.lmsSubject, status: 'active' });
        if (n) {
            const s = await M.subject.findById(h.lmsSubject, 'name').lean();
            throw conflict(`${s?.name || 'A subject'} has ${n} book assignment(s) in ${cls.className}. Remove its books first.`, 'IN_USE');
        }
        await M.schoolSubject.deleteOne({ _id: h._id });
    }
    for (const [lmsSubject, schoolSubject] of want) {
        const cur = have.find((h) => String(h.lmsSubject) === lmsSubject);
        if (!cur) {
            await M.schoolSubject.create({ school: schoolId, academicYear: cls.academicYear, class: cls._id, classLevel: cls.classNumber, lmsSubject, schoolSubject, createdBy: userId });
        } else if (String(cur.schoolSubject) !== schoolSubject) {
            await M.schoolSubject.updateOne({ _id: cur._id }, { $set: { schoolSubject } });
            // The books already assigned follow the subject to its new teachers.
            await M.assignment.updateMany({ class: cls._id, lmsSubject, status: 'active' }, { $set: { schoolSubject } });
        }
    }
    return { class: cls._id, subjects: want.size };
}

// ── Step 3: the books of a subject ───────────────────────────────────────────

/** The library's books a class may choose for a subject (its board, its level, live books only). */
async function availableBooks(schoolId, classId, lmsSubjectId) {
    const { cls, config } = await classOf(schoolId, classId);
    return q(`
        SELECT k."_id", k."title", k."publisher", k."author", k."edition", k."publicationYear", k."language", k."coverUrl", k."description",
               (SELECT count(*) FROM ${T.chapter} c WHERE c."book" = k."_id" AND c."status" = 'active')::int AS "chapterCount",
               (SELECT count(*) FROM ${T.chapterVideo} cv WHERE cv."book" = k."_id" AND cv."isActive")::int AS "videoCount"
          FROM ${T.book} k
         WHERE k."board" = $1 AND k."classLevel" = $2 AND k."subject" = $3 AND k."status" = 'active'
         ORDER BY k."displayOrder", lower(k."title")`, [config.board, cls.classNumber, id(lmsSubjectId, 'Subject')]);
}

/**
 * Say who follows a book in a class: `sections: 'all'` (the whole class),
 * a list of section ids, or [] / 'none' to stop following it.
 *
 * The assignment rows are brought in line with that — the ones no longer
 * wanted are ENDED (kept as history), the new ones added — all or nothing.
 */
async function assignBook(schoolId, body, userId) {
    const { cls, config } = await classOf(schoolId, body.class);
    const book = await M.book.findById(id(body.book, 'Book')).lean();
    if (!book) throw notFound('Book');
    const none = body.sections === 'none' || (Array.isArray(body.sections) && !body.sections.length);
    if (!none) {
        if (String(book.board) !== String(config.board) || book.classLevel !== cls.classNumber) throw bad(`${book.title} is not a book for ${cls.className} on your board`);
        if (book.status !== 'active') throw bad(`${book.title} is no longer offered by the library`);
    }
    const followed = await M.schoolSubject.findOne({ class: cls._id, lmsSubject: book.subject }).lean();
    if (!followed && !none) throw bad(`Select the book's subject for ${cls.className} first`);

    const all = body.sections === 'all';
    let wanted = [];
    if (!all && !none) {
        wanted = [...new Set((Array.isArray(body.sections) ? body.sections : []).map((s) => id(s, 'Section')))];
        const found = await q(`SELECT "_id" FROM ${T.section} WHERE "class" = $1 AND "school" = $2 AND "_id" = ANY($3::uuid[])`, [cls._id, schoolId, wanted]);
        if (found.length !== wanted.length) throw bad(`One of those sections is not a section of ${cls.className}`);
    }
    return withTransaction(async (tx) => {
        await tx('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`lms-assign:${cls._id}:${book._id}`]);
        const { rows: live } = await tx(`SELECT "_id", "section" FROM ${T.assignment} WHERE "class" = $1 AND "book" = $2 AND "status" = 'active'`, [cls._id, book._id]);
        const keep = (a) => (all ? a.section === null : wanted.includes(String(a.section)));
        const ending = live.filter((a) => !keep(a)).map((a) => a._id);
        if (ending.length) {
            await tx(`UPDATE ${T.assignment} SET "status" = 'ended', "endedAt" = now(), "endedBy" = $2, "updatedAt" = now() WHERE "_id" = ANY($1::uuid[])`, [ending, userId]);
        }
        const have = new Set(live.filter(keep).map((a) => String(a.section)));
        const adding = all ? (have.has('null') ? [] : [null]) : wanted.filter((s) => !have.has(s));
        for (const section of adding) {
            await tx(`
                INSERT INTO ${T.assignment} ("_id", "school", "academicYear", "class", "section", "lmsSubject", "schoolSubject", "book", "status", "startedAt", "assignedBy", "createdAt", "updatedAt")
                VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'active', now(), $8, now(), now())`,
            [schoolId, cls.academicYear, cls._id, section, book.subject, followed.schoolSubject, book._id, userId]);
        }
        return { book: book._id, title: book.title, class: cls._id, className: cls.className, added: adding.length, ended: ending.length, scope: none ? 'none' : all ? 'all' : 'sections' };
    });
}

/** What a class or section has followed over time — live and ended. */
async function assignmentHistory(schoolId, query) {
    const pg = paging(query, { def: 25 });
    const params = [schoolId];
    const where = ['a."school" = $1'];
    if (query.academicYear) { params.push(id(query.academicYear, 'Academic year')); where.push(`a."academicYear" = $${params.length}`); }
    if (query.class) { params.push(id(query.class, 'Class')); where.push(`a."class" = $${params.length}`); }
    if (query.status) { params.push(oneOf(query.status, ['active', 'ended'], 'Status')); where.push(`a."status" = $${params.length}`); }
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${T.assignment} a WHERE ${where.join(' AND ')}`, params);
    const rows = await q(`
        SELECT a."_id", a."status", a."startedAt", a."endedAt", k."title" AS "bookTitle", k."publisher", ls."name" AS "subjectName",
               c."className", cs."sectionName", ub."name" AS "assignedByName", ue."name" AS "endedByName"
          FROM ${T.assignment} a JOIN ${T.book} k ON k."_id" = a."book" JOIN ${T.subject} ls ON ls."_id" = a."lmsSubject"
          JOIN ${T.class} c ON c."_id" = a."class" LEFT JOIN ${T.section} cs ON cs."_id" = a."section"
          LEFT JOIN ${T.user} ub ON ub."_id" = a."assignedBy" LEFT JOIN ${T.user} ue ON ue."_id" = a."endedBy"
         WHERE ${where.join(' AND ')} ORDER BY a."startedAt" DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, params);
    return { rows, total: n, pg };
}

// ── Requests ─────────────────────────────────────────────────────────────────

const REQUEST_SELECT = `
    SELECT r.*, s."name" AS "schoolName", b."name" AS "boardLabel", ls."name" AS "subjectLabel", k."title" AS "bookTitle",
           u."name" AS "requestedByName", rv."name" AS "reviewedByName",
           (SELECT count(DISTINCT o."school") FROM ${T.request} o WHERE o."subjectKey" = r."subjectKey" AND o."subjectKey" <> ''
                AND o."status" IN ('pending', 'under_review', 'approved', 'in_progress'))::int AS "schoolsAsking"
      FROM ${T.request} r JOIN ${T.school} s ON s."_id" = r."school"
      LEFT JOIN ${T.board} b ON b."_id" = r."board" LEFT JOIN ${T.subject} ls ON ls."_id" = r."subject"
      LEFT JOIN ${T.book} k ON k."_id" = r."book"
      LEFT JOIN ${T.user} u ON u."_id" = r."requestedBy" LEFT JOIN ${T.user} rv ON rv."_id" = r."reviewedBy"`;

const publicRequest = (r) => {
    const { attachmentFile, dedupeKey, subjectKey, ...rest } = r;
    return { ...rest, hasAttachment: !!attachmentFile, classLabel: r.classLevel === null || r.classLevel === undefined ? '' : levelLabel(r.classLevel),
        boardName: r.boardLabel || r.boardName, subjectName: r.subjectLabel || r.subjectName };
};

const dropFile = (file) => { if (file?.path) fs.promises.unlink(file.path).catch(() => {}); };

/** File a request for a book or a chapter the library lacks. */
async function createRequest(schoolId, body, file, user) {
    try {
        const type = oneOf(body.type, ['book', 'chapter'], 'Request type');
        const doc = { school: schoolId, type, status: 'pending', comments: str(body.comments, 2000), requestedBy: user._id,
            history: [{ status: 'pending', at: new Date(), by: user._id, note: '' }] };
        if (type === 'book') {
            doc.board = idOrNull(body.board, 'Board');
            doc.boardName = str(body.boardName, 120);
            if (doc.board) { const b = await M.board.findById(doc.board, 'name').lean(); if (!b) throw notFound('Board'); doc.boardName = b.name; }
            if (!doc.boardName) throw bad('Say which board the book is for');
            doc.classLevel = classLevel(body.classLevel);
            doc.subject = idOrNull(body.subject, 'Subject');
            doc.subjectName = str(body.subjectName, 120);
            if (doc.subject) { const s = await M.subject.findById(doc.subject, 'name').lean(); if (!s) throw notFound('Subject'); doc.subjectName = s.name; }
            if (!doc.subjectName) throw bad('Say which subject the book is for');
            doc.title = str(body.title, 200);
            if (doc.title.length < 2) throw bad('Book title is required');
            doc.publisher = str(body.publisher, 150); doc.author = str(body.author, 200); doc.edition = str(body.edition, 60);
            doc.publicationYear = int(body.publicationYear, 'Publication year', { min: 1900, max: new Date().getFullYear() + 1, optional: true });
            // Already in the library? Then it is a book to select, not to request.
            if (doc.board && doc.subject) {
                const there = await one(`
                    SELECT "_id", "title" FROM ${T.book} WHERE "board" = $1 AND "classLevel" = $2 AND "subject" = $3 AND "status" = 'active'
                       AND lower(btrim("title")) = lower($4) AND ($5 = '' OR lower(btrim("publisher")) = lower($5)) LIMIT 1`,
                [doc.board, doc.classLevel, doc.subject, doc.title, doc.publisher]);
                if (there) throw conflict(`"${there.title}" is already in the library — select it under Setup instead of requesting it.`, 'ALREADY_AVAILABLE', { book: there._id });
            }
            doc.subjectKey = ['book', norm(doc.boardName), doc.classLevel, norm(doc.subjectName), norm(doc.title), norm(doc.publisher), norm(doc.edition)].join('|');
        } else {
            const book = await M.book.findById(id(body.book, 'Book')).lean();
            if (!book || book.status === 'inactive') throw notFound('Book');
            doc.book = book._id; doc.board = book.board; doc.classLevel = book.classLevel; doc.subject = book.subject; doc.title = book.title;
            doc.chapterNumber = int(body.chapterNumber, 'Chapter number', { min: 1, max: 999, optional: true });
            doc.chapterName = str(body.chapterName, 200);
            doc.topic = str(body.topic, 1000);
            if (!doc.chapterName && !doc.topic) throw bad('Say which chapter or topic is missing');
            if (doc.chapterNumber) {
                const ch = await one(`
                    SELECT c."title", (SELECT count(*) FROM ${T.chapterVideo} cv JOIN ${T.video} v ON v."_id" = cv."video" AND v."isActive" AND v."processingStatus" = 'ready'
                                        WHERE cv."chapter" = c."_id" AND cv."isActive")::int AS videos
                      FROM ${T.chapter} c WHERE c."book" = $1 AND c."chapterNumber" = $2 AND c."status" = 'active'`, [book._id, doc.chapterNumber]);
                if (ch && ch.videos > 0 && !doc.topic) {
                    throw conflict(`Chapter ${doc.chapterNumber} "${ch.title}" is already in this book with ${ch.videos} video(s). If a topic in it is missing, describe the topic.`, 'ALREADY_AVAILABLE');
                }
            }
            doc.subjectKey = ['chapter', book._id, doc.chapterNumber ?? '', norm(doc.chapterName), norm(doc.topic).slice(0, 80)].join('|');
        }
        doc.dedupeKey = doc.subjectKey;
        if (file) { doc.attachmentFile = file.filename; doc.attachmentName = str(file.originalname, 200); }

        const dup = await one(`SELECT "_id", "status" FROM ${T.request} WHERE "school" = $1 AND "dedupeKey" = $2 AND "status" = ANY($3::text[])`, [schoolId, doc.dedupeKey, OPEN]);
        if (dup) throw conflict('Your school has already asked for this, and the request is still open.', 'DUPLICATE_REQUEST', { request: dup._id, status: dup.status });
        let created;
        try { created = await M.request.create(doc); }
        catch (e) { if (e.code === 11000 || e.code === '23505') throw conflict('Your school has already asked for this, and the request is still open.', 'DUPLICATE_REQUEST'); throw e; }
        const school = await one(`SELECT "name" FROM ${T.school} WHERE "_id" = $1`, [schoolId]);
        notices.requestFiled(created, school?.name, user).catch(() => {});
        return getRequest(created._id, schoolId);
    } catch (e) { dropFile(file); throw e; }
}

async function listRequests(query, schoolId = null) {
    const pg = paging(query);
    const params = [];
    const where = [];
    if (schoolId) { params.push(schoolId); where.push(`r."school" = $${params.length}`); }
    else if (query.school) { params.push(id(query.school, 'School')); where.push(`r."school" = $${params.length}`); }
    if (query.type) { params.push(oneOf(query.type, ['book', 'chapter'], 'Type')); where.push(`r."type" = $${params.length}`); }
    if (query.status === 'open') { params.push(OPEN); where.push(`r."status" = ANY($${params.length}::text[])`); }
    else if (query.status) { params.push(oneOf(query.status, Object.keys(NEXT), 'Status')); where.push(`r."status" = $${params.length}`); }
    if (query.search) { params.push(like(query.search)); where.push(`(r."title" ILIKE $${params.length} OR r."chapterName" ILIKE $${params.length} OR r."publisher" ILIKE $${params.length} OR s."name" ILIKE $${params.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${T.request} r JOIN ${T.school} s ON s."_id" = r."school" ${w}`, params);
    const rows = await q(`${REQUEST_SELECT} ${w} ORDER BY (r."status" = ANY('{pending,under_review,approved,in_progress}'::text[])) DESC, r."createdAt" DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, params);
    const cp = schoolId ? [schoolId] : [];
    const counts = await one(`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE "status" = 'pending')::int AS pending,
               count(*) FILTER (WHERE "status" IN ('under_review', 'approved', 'in_progress'))::int AS "inHand",
               count(*) FILTER (WHERE "status" = 'completed')::int AS completed, count(*) FILTER (WHERE "status" = 'rejected')::int AS rejected
          FROM ${T.request} ${schoolId ? 'WHERE "school" = $1' : ''}`, cp);
    return { rows: rows.map(publicRequest), total: n, pg, counts };
}

/** One request. With `schoolId`, only if it is that school's. */
async function getRequest(requestId, schoolId = null) {
    const r = await one(`${REQUEST_SELECT} WHERE r."_id" = $1`, [id(requestId, 'Request')]);
    if (!r || (schoolId && String(r.school) !== String(schoolId))) throw notFound('Request');
    return publicRequest(r);
}

/** A school takes back a request nobody has picked up yet. */
async function withdrawRequest(requestId, schoolId) {
    const r = await M.request.findOne({ _id: id(requestId, 'Request'), school: schoolId }).lean();
    if (!r) throw notFound('Request');
    if (r.status !== 'pending') throw conflict('This request is already being looked at and cannot be withdrawn');
    await M.request.deleteOne({ _id: r._id });
    if (r.attachmentFile) fs.promises.unlink(path.join(REQUEST_DIR, path.basename(r.attachmentFile))).catch(() => {});
    return { withdrawn: true };
}

/** Super Admin: move a request on. The school is told of every step. */
async function setRequestStatus(requestId, body, actor) {
    const r = await M.request.findById(id(requestId, 'Request')).lean();
    if (!r) throw notFound('Request');
    const status = oneOf(body.status, Object.keys(NEXT), 'Status');
    if (!NEXT[r.status].includes(status)) {
        throw conflict(NEXT[r.status].length ? `A ${r.status.replace('_', ' ')} request can only move to: ${NEXT[r.status].map((s) => s.replace('_', ' ')).join(', ')}` : `This request is ${r.status} and closed`, 'BAD_TRANSITION');
    }
    const note = str(body.note, 1000);
    if (status === 'rejected' && !note) throw bad('Say why the request is not approved — the school is shown this');
    const set = { status, reviewedBy: actor._id, reviewNote: note || r.reviewNote || '' };
    if (body.resolvedBook) { if (!await M.book.findById(id(body.resolvedBook, 'Book'), '_id').lean()) throw notFound('Book'); set.resolvedBook = body.resolvedBook; }
    if (body.resolvedChapter) { if (!await M.chapter.findById(id(body.resolvedChapter, 'Chapter'), '_id').lean()) throw notFound('Chapter'); set.resolvedChapter = body.resolvedChapter; }
    await M.request.updateOne({ _id: r._id }, { $set: set, $push: { history: { status, at: new Date(), by: actor._id, note } } });
    const fresh = await M.request.findById(r._id).lean();
    notices.requestStatus(fresh, actor).catch(() => {});
    return getRequest(r._id);
}

/** The file a school attached, for whoever may read the request. */
async function requestAttachment(requestId, schoolId = null) {
    const r = await M.request.findById(id(requestId, 'Request')).lean();
    if (!r || (schoolId && String(r.school) !== String(schoolId)) || !r.attachmentFile) throw notFound('Attachment');
    const file = path.join(REQUEST_DIR, path.basename(r.attachmentFile));
    if (!fs.existsSync(file)) throw notFound('Attachment');
    return { file, name: r.attachmentName || path.basename(file) };
}

module.exports = {
    setup, setBoard, setClassSubjects, availableBooks, assignBook, assignmentHistory,
    createRequest, listRequests, getRequest, withdrawRequest, setRequestStatus, requestAttachment, NEXT, OPEN, REQUEST_DIR,
};
