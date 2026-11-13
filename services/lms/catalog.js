'use strict';
/**
 * Video Learning — the central content library (Super Admin).
 *
 *     Board → Class → Subject → Book → Chapter → Videos
 *
 * The library belongs to no school. Videos are assets of their own
 * (LmsVideo) and reach a chapter through a mapping (LmsChapterVideo), so one
 * uploaded file serves any number of chapters of any number of books.
 *
 * The rule that runs through this file: content a school uses, a teacher has
 * released or a student has watched is switched off or archived — never
 * deleted. Each `remove…` checks, and the foreign keys in db/migrate.js hold
 * the same line underneath.
 */
const {
    q, M, T, bad, notFound, conflict, str, id, idOrNull, int, oneOf, classLevel, levelLabel, like, paging,
} = require('./common');
const providers = require('./providers');

const one = async (sql, params) => (await q(sql, params))[0] || null;
const exists = async (sql, params) => (await q(`SELECT EXISTS(${sql}) AS x`, params))[0].x;
const uniqLevels = (list) => [...new Set((Array.isArray(list) ? list : []).map((v) => classLevel(v)))].sort((a, b) => a - b);

// ═════════════════════════════════════════════════════════════════════════════
//  Boards
// ═════════════════════════════════════════════════════════════════════════════

async function listBoards({ search = '', status = '' } = {}) {
    const params = [];
    const where = [];
    if (search) { params.push(like(search)); where.push(`(b."name" ILIKE $${params.length} OR b."code" ILIKE $${params.length})`); }
    if (status === 'active') where.push('b."isActive"');
    if (status === 'inactive') where.push('NOT b."isActive"');
    return q(`
        SELECT b.*,
               (SELECT count(DISTINCT m."subject") FROM ${T.subjectMap} m WHERE m."board" = b."_id")::int AS "subjectCount",
               (SELECT count(*) FROM ${T.book} k WHERE k."board" = b."_id" AND k."status" <> 'archived')::int AS "bookCount",
               (SELECT count(DISTINCT c."school") FROM ${T.schoolConfig} c WHERE c."board" = b."_id")::int AS "schoolCount"
          FROM ${T.board} b
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY b."isActive" DESC, lower(b."name")`, params);
}

function boardFields(body) {
    const name = str(body.name, 120);
    const code = str(body.code, 20).toUpperCase();
    if (name.length < 2) throw bad('Board name is required');
    if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(code)) throw bad('Board code is 2 to 20 letters or digits, for example WBBSE');
    return { name, code, description: str(body.description, 1000), classLevels: uniqLevels(body.classLevels) };
}

async function createBoard(body, userId) {
    const f = boardFields(body);
    if (await M.board.findOne({ code: f.code }).lean()) throw conflict(`A board with the code ${f.code} already exists`);
    return M.board.create({ ...f, isActive: body.isActive !== false, createdBy: userId, updatedBy: userId });
}

async function updateBoard(boardId, body, userId) {
    const board = await M.board.findById(id(boardId)).lean();
    if (!board) throw notFound('Board');
    const f = boardFields({ ...board, ...body });
    if (f.code !== board.code && await M.board.findOne({ code: f.code }).lean()) throw conflict(`A board with the code ${f.code} already exists`);
    // A class that books or subjects are filed under cannot be taken off the board.
    const dropped = (board.classLevels || []).filter((n) => !f.classLevels.includes(n));
    if (dropped.length) {
        const used = await q(`
            SELECT DISTINCT "classLevel" AS n FROM ${T.book} WHERE "board" = $1 AND "classLevel" = ANY($2::float8[])
            UNION SELECT DISTINCT "classLevel" FROM ${T.subjectMap} WHERE "board" = $1 AND "classLevel" = ANY($2::float8[])`, [board._id, dropped]);
        if (used.length) throw conflict(`${used.map((r) => levelLabel(r.n)).join(', ')} still ${used.length === 1 ? 'has' : 'have'} subjects or books on this board and cannot be removed from it`);
    }
    await M.board.updateOne({ _id: board._id }, { $set: { ...f, updatedBy: userId } });
    return M.board.findById(board._id).lean();
}

async function setBoardActive(boardId, active, userId) {
    const board = await M.board.findById(id(boardId)).lean();
    if (!board) throw notFound('Board');
    await M.board.updateOne({ _id: board._id }, { $set: { isActive: !!active, updatedBy: userId } });
    return { ...board, isActive: !!active };
}

async function removeBoard(boardId) {
    const board = await M.board.findById(id(boardId)).lean();
    if (!board) throw notFound('Board');
    const used = await one(`
        SELECT (SELECT count(*) FROM ${T.book} WHERE "board" = $1)::int AS books,
               (SELECT count(*) FROM ${T.schoolConfig} WHERE "board" = $1)::int AS schools`, [board._id]);
    if (used.books || used.schools) throw conflict(`${board.name} has ${used.books} book(s) and is followed by ${used.schools} school set-up(s). Deactivate it instead.`, 'IN_USE');
    await M.subjectMap.deleteMany({ board: board._id });
    await M.board.deleteOne({ _id: board._id });
    return board;
}

/** A board opened up: its classes, each with the subjects mapped to it and how many books they have. */
async function boardDetail(boardId) {
    const board = await M.board.findById(id(boardId)).lean();
    if (!board) throw notFound('Board');
    const rows = await q(`
        SELECT m."classLevel", s."_id" AS "subject", s."name", s."code", s."status",
               (SELECT count(*) FROM ${T.book} k WHERE k."board" = m."board" AND k."classLevel" = m."classLevel" AND k."subject" = s."_id" AND k."status" <> 'archived')::int AS "bookCount"
          FROM ${T.subjectMap} m JOIN ${T.subject} s ON s."_id" = m."subject"
         WHERE m."board" = $1 ORDER BY m."classLevel", lower(s."name")`, [board._id]);
    const classes = (board.classLevels || []).slice().sort((a, b) => a - b).map((n) => ({
        classLevel: n, label: levelLabel(n), subjects: rows.filter((r) => r.classLevel === n),
    }));
    return { ...board, classes };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Subjects and where they are taught
// ═════════════════════════════════════════════════════════════════════════════

async function listSubjects({ search = '', status = '', board = '', classLevel: level = '' } = {}) {
    const params = [];
    const where = [];
    if (search) { params.push(like(search)); where.push(`(s."name" ILIKE $${params.length} OR s."code" ILIKE $${params.length})`); }
    if (status) { params.push(oneOf(status, ['active', 'inactive'], 'Status')); where.push(`s."status" = $${params.length}`); }
    if (board || level !== '') {
        const cond = [];
        if (board) { params.push(id(board, 'Board')); cond.push(`m."board" = $${params.length}`); }
        if (level !== '') { params.push(classLevel(level)); cond.push(`m."classLevel" = $${params.length}`); }
        where.push(`EXISTS (SELECT 1 FROM ${T.subjectMap} m WHERE m."subject" = s."_id" AND ${cond.join(' AND ')})`);
    }
    return q(`
        SELECT s.*,
               (SELECT count(*) FROM ${T.book} k WHERE k."subject" = s."_id" AND k."status" <> 'archived')::int AS "bookCount",
               COALESCE((SELECT json_agg(json_build_object('board', x."board", 'boardName', x."name", 'boardCode', x."code", 'classLevels', x.levels) ORDER BY x."name")
                           FROM (SELECT m."board", b."name", b."code", array_agg(m."classLevel" ORDER BY m."classLevel") AS levels
                                   FROM ${T.subjectMap} m JOIN ${T.board} b ON b."_id" = m."board"
                                  WHERE m."subject" = s."_id" GROUP BY m."board", b."name", b."code") x), '[]'::json) AS "mappings"
          FROM ${T.subject} s
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY (s."status" = 'active') DESC, lower(s."name")`, params);
}

function subjectFields(body) {
    const name = str(body.name, 120);
    const code = str(body.code, 20).toUpperCase();
    if (name.length < 2) throw bad('Subject name is required');
    if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(code)) throw bad('Subject code is 2 to 20 letters or digits, for example HIN');
    return { name, code, description: str(body.description, 1000), language: str(body.language, 40) || 'English' };
}

/**
 * Replace where a subject is taught. `mappings` = [{ board, classLevels: [9, 10] }].
 * A board and class that already has books of this subject cannot be dropped.
 */
async function setSubjectMappings(subjectId, mappings, userId) {
    const subject = await M.subject.findById(id(subjectId)).lean();
    if (!subject) throw notFound('Subject');
    const want = new Map();     // "board|level" → { board, classLevel }
    for (const m of Array.isArray(mappings) ? mappings : []) {
        const boardId = id(m.board, 'Board');
        const board = await M.board.findById(boardId).lean();
        if (!board) throw notFound('Board');
        for (const n of uniqLevels(m.classLevels)) {
            if (!(board.classLevels || []).includes(n)) throw bad(`${board.name} does not have ${levelLabel(n)}. Add the class to the board first.`);
            want.set(`${boardId}|${n}`, { board: boardId, classLevel: n });
        }
    }
    const have = await M.subjectMap.find({ subject: subject._id }).lean();
    const dropping = have.filter((h) => !want.has(`${h.board}|${h.classLevel}`));
    for (const h of dropping) {
        if (await exists(`SELECT 1 FROM ${T.book} WHERE "board" = $1 AND "classLevel" = $2 AND "subject" = $3`, [h.board, h.classLevel, subject._id])) {
            const b = await M.board.findById(h.board).lean();
            throw conflict(`${subject.name} has books for ${b?.name || 'this board'} ${levelLabel(h.classLevel)} and cannot be unmapped from it`, 'IN_USE');
        }
    }
    if (dropping.length) await M.subjectMap.deleteMany({ _id: { $in: dropping.map((h) => h._id) } });
    const haveKeys = new Set(have.map((h) => `${h.board}|${h.classLevel}`));
    const adding = [...want.entries()].filter(([k]) => !haveKeys.has(k)).map(([, v]) => ({ ...v, subject: subject._id, createdBy: userId }));
    if (adding.length) await M.subjectMap.insertMany(adding, { ordered: false }).catch((e) => { if (e.code !== 11000) throw e; });
    return (await listSubjects({ search: subject.code })).find((s) => String(s._id) === String(subject._id));
}

async function createSubject(body, userId) {
    const f = subjectFields(body);
    if (await M.subject.findOne({ code: f.code }).lean()) throw conflict(`A subject with the code ${f.code} already exists — map it to more boards and classes instead of adding it again`);
    const subject = await M.subject.create({ ...f, status: body.status === 'inactive' ? 'inactive' : 'active', createdBy: userId, updatedBy: userId });
    if (Array.isArray(body.mappings)) {
        try { return await setSubjectMappings(subject._id, body.mappings, userId); }
        catch (e) { await M.subject.deleteOne({ _id: subject._id }); throw e; }
    }
    return subject;
}

async function updateSubject(subjectId, body, userId) {
    const subject = await M.subject.findById(id(subjectId)).lean();
    if (!subject) throw notFound('Subject');
    const f = subjectFields({ ...subject, ...body });
    if (f.code !== subject.code && await M.subject.findOne({ code: f.code }).lean()) throw conflict(`A subject with the code ${f.code} already exists`);
    const status = body.status === undefined ? subject.status : oneOf(body.status, ['active', 'inactive'], 'Status');
    await M.subject.updateOne({ _id: subject._id }, { $set: { ...f, status, updatedBy: userId } });
    if (Array.isArray(body.mappings)) return setSubjectMappings(subject._id, body.mappings, userId);
    return M.subject.findById(subject._id).lean();
}

async function removeSubject(subjectId) {
    const subject = await M.subject.findById(id(subjectId)).lean();
    if (!subject) throw notFound('Subject');
    const used = await one(`
        SELECT (SELECT count(*) FROM ${T.book} WHERE "subject" = $1)::int AS books,
               (SELECT count(*) FROM ${T.schoolSubject} WHERE "lmsSubject" = $1)::int AS schools`, [subject._id]);
    if (used.books || used.schools) throw conflict(`${subject.name} has ${used.books} book(s) and is selected by ${used.schools} class(es). Deactivate it instead.`, 'IN_USE');
    await M.subjectMap.deleteMany({ subject: subject._id });
    await M.subject.deleteOne({ _id: subject._id });
    return subject;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Books
// ═════════════════════════════════════════════════════════════════════════════

const BOOK_SELECT = `
    SELECT k.*, b."name" AS "boardName", b."code" AS "boardCode", s."name" AS "subjectName", s."code" AS "subjectCode",
           (SELECT count(*) FROM ${T.chapter} c WHERE c."book" = k."_id")::int AS "chapterCount",
           (SELECT count(*) FROM ${T.chapterVideo} cv WHERE cv."book" = k."_id" AND cv."isActive")::int AS "videoCount",
           (SELECT count(DISTINCT a."school") FROM ${T.assignment} a WHERE a."book" = k."_id" AND a."status" = 'active')::int AS "schoolCount"
      FROM ${T.book} k JOIN ${T.board} b ON b."_id" = k."board" JOIN ${T.subject} s ON s."_id" = k."subject"`;

function bookWhere(f, params) {
    const where = [];
    if (f.board) { params.push(id(f.board, 'Board')); where.push(`k."board" = $${params.length}`); }
    if (f.classLevel !== undefined && f.classLevel !== '') { params.push(classLevel(f.classLevel)); where.push(`k."classLevel" = $${params.length}`); }
    if (f.subject) { params.push(id(f.subject, 'Subject')); where.push(`k."subject" = $${params.length}`); }
    if (f.status) { params.push(oneOf(f.status, ['active', 'inactive', 'archived'], 'Status')); where.push(`k."status" = $${params.length}`); }
    else if (!f.includeArchived) where.push(`k."status" <> 'archived'`);
    if (f.search) { params.push(like(f.search)); where.push(`(k."title" ILIKE $${params.length} OR k."publisher" ILIKE $${params.length} OR k."author" ILIKE $${params.length} OR k."isbn" ILIKE $${params.length})`); }
    return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

async function listBooks(query) {
    const pg = paging(query);
    const params = [];
    const where = bookWhere(query, params);
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${T.book} k ${where}`, params);
    const rows = await q(`${BOOK_SELECT} ${where}
        ORDER BY lower(b."name"), k."classLevel", lower(s."name"), k."displayOrder", lower(k."title")
        LIMIT ${pg.limit} OFFSET ${pg.offset}`, params);
    const counts = await one(`
        SELECT count(*) FILTER (WHERE "status" = 'active')::int AS active, count(*) FILTER (WHERE "status" = 'inactive')::int AS inactive,
               count(*) FILTER (WHERE "status" = 'archived')::int AS archived, count(*)::int AS total FROM ${T.book}`, []);
    return { rows, total: n, pg, counts };
}

async function bookFields(body) {
    const title = str(body.title, 200);
    if (title.length < 2) throw bad('Book title is required');
    const boardId = id(body.board, 'Board');
    const subjectId = id(body.subject, 'Subject');
    const level = classLevel(body.classLevel);
    const board = await M.board.findById(boardId).lean();
    if (!board) throw notFound('Board');
    if (!(board.classLevels || []).includes(level)) throw bad(`${board.name} does not have ${levelLabel(level)}`);
    const subject = await M.subject.findById(subjectId).lean();
    if (!subject) throw notFound('Subject');
    if (!await M.subjectMap.findOne({ board: boardId, classLevel: level, subject: subjectId }).lean()) {
        throw bad(`${subject.name} is not mapped to ${board.name} ${levelLabel(level)}. Map the subject there first (Subjects).`);
    }
    const isbn = str(body.isbn, 20).replace(/[\s-]/g, '');
    if (isbn && !/^(\d{9}[\dXx]|\d{13})$/.test(isbn)) throw bad('ISBN is 10 or 13 digits');
    const year = int(body.publicationYear, 'Publication year', { min: 1900, max: new Date().getFullYear() + 1, optional: true });
    return {
        title, board: boardId, classLevel: level, subject: subjectId,
        publisher: str(body.publisher, 150), author: str(body.author, 200), isbn, edition: str(body.edition, 60),
        publicationYear: year, language: str(body.language, 40) || subject.language || 'English',
        description: str(body.description, 3000), coverUrl: str(body.coverUrl, 400),
        displayOrder: int(body.displayOrder ?? 0, 'Display order', { min: 0, max: 9999 }),
    };
}

const duplicateBook = () => conflict('This book is already in the library — same board, class, subject, title, edition and publisher. Edit that one, or add it as a new edition.', 'DUPLICATE');

async function createBook(body, userId) {
    const f = await bookFields(body);
    const status = body.status === 'inactive' ? 'inactive' : 'active';
    try {
        const book = await M.book.create({ ...f, status, createdBy: userId, updatedBy: userId });
        await M.book.updateOne({ _id: book._id }, { $set: { editionGroup: book._id } });
        return getBook(book._id);
    } catch (e) { if (e.code === 11000 || e.code === '23505') throw duplicateBook(); throw e; }
}

async function bookInUse(bookId) {
    return one(`
        SELECT (SELECT count(*) FROM ${T.assignment} WHERE "book" = $1)::int AS assignments,
               (SELECT count(DISTINCT "school") FROM ${T.assignment} WHERE "book" = $1 AND "status" = 'active')::int AS schools,
               (SELECT count(*) FROM ${T.release} WHERE "book" = $1)::int AS releases,
               (SELECT count(*) FROM ${T.progress} WHERE "book" = $1)::int AS progress`, [bookId]);
}

async function updateBook(bookId, body, userId) {
    const book = await M.book.findById(id(bookId)).lean();
    if (!book) throw notFound('Book');
    const f = await bookFields({ ...book, ...body });
    const moved = String(f.board) !== String(book.board) || f.classLevel !== book.classLevel || String(f.subject) !== String(book.subject);
    if (moved) {
        const used = await bookInUse(book._id);
        if (used.assignments) throw conflict('Schools follow this book, so its board, class and subject cannot change. Add a new book instead.', 'IN_USE');
    }
    try { await M.book.updateOne({ _id: book._id }, { $set: { ...f, updatedBy: userId } }); }
    catch (e) { if (e.code === 11000 || e.code === '23505') throw duplicateBook(); throw e; }
    return getBook(book._id);
}

/** active ⇄ inactive, or archived (and back). Returns the book and whether it has just become active for the first time. */
async function setBookStatus(bookId, status, userId) {
    oneOf(status, ['active', 'inactive', 'archived'], 'Status');
    const book = await M.book.findById(id(bookId)).lean();
    if (!book) throw notFound('Book');
    try {
        await M.book.updateOne({ _id: book._id }, { $set: { status, archivedAt: status === 'archived' ? new Date() : null, updatedBy: userId } });
    } catch (e) { if (e.code === 11000 || e.code === '23505') throw conflict('Another book with the same title, edition and publisher is already live. Change one of them first.'); throw e; }
    return getBook(book._id);
}

/**
 * A new edition of a book: its details copied into a new book of the same
 * family, optionally with the chapter list and the videos mapped to each
 * chapter (the videos themselves are shared, not copied).
 */
async function newEdition(bookId, body, userId) {
    const src = await M.book.findById(id(bookId)).lean();
    if (!src) throw notFound('Book');
    const edition = str(body.edition, 60);
    if (!edition) throw bad('Say which edition this is, for example "2nd edition" or "2026"');
    if (edition.toLowerCase() === String(src.edition || '').toLowerCase()) throw bad('The new edition needs a different edition name from the one it is made from');
    const f = await bookFields({ ...src, ...body, edition, publicationYear: body.publicationYear ?? src.publicationYear });
    let book;
    try {
        book = await M.book.create({ ...f, status: 'inactive', editionGroup: src.editionGroup || src._id, previousEdition: src._id, createdBy: userId, updatedBy: userId });
    } catch (e) { if (e.code === 11000 || e.code === '23505') throw duplicateBook(); throw e; }
    if (body.copyChapters !== false) {
        const chapters = await M.chapter.find({ book: src._id }).lean();
        for (const ch of chapters) {
            const copy = await M.chapter.create({
                book: book._id, title: ch.title, chapterNumber: ch.chapterNumber, description: ch.description, thumbnailUrl: ch.thumbnailUrl,
                estimatedMinutes: ch.estimatedMinutes, displayOrder: ch.displayOrder, status: ch.status, createdBy: userId, updatedBy: userId,
            });
            if (body.copyVideos !== false) {
                const maps = await M.chapterVideo.find({ chapter: ch._id, isActive: true }).lean();
                if (maps.length) await M.chapterVideo.insertMany(maps.map((m) => ({ chapter: copy._id, book: book._id, video: m.video, displayOrder: m.displayOrder, isActive: true, createdBy: userId })));
            }
        }
    }
    return getBook(book._id);
}

async function removeBook(bookId) {
    const book = await M.book.findById(id(bookId)).lean();
    if (!book) throw notFound('Book');
    const used = await bookInUse(book._id);
    if (used.assignments || used.releases || used.progress) {
        throw conflict(`${book.title} is followed by ${used.schools} school(s) and has ${used.releases} release(s) and ${used.progress} watch record(s). It cannot be deleted — archive it instead.`, 'IN_USE');
    }
    await M.book.deleteOne({ _id: book._id });      // chapters and mappings go with it (CASCADE)
    await M.notice.deleteOne({ key: `book:new:${book._id}` });
    return book;
}

/** A book opened up: details, editions, chapters with their videos, and the schools that follow it. */
async function getBook(bookId) {
    const book = await one(`${BOOK_SELECT} WHERE k."_id" = $1`, [id(bookId)]);
    if (!book) throw notFound('Book');
    const [chapters, videos, editions, schools] = await Promise.all([
        q(`SELECT c.* FROM ${T.chapter} c WHERE c."book" = $1 ORDER BY c."displayOrder", c."chapterNumber"`, [book._id]),
        q(`SELECT cv."_id", cv."chapter", cv."video", cv."displayOrder", cv."isActive",
                  v."title", v."durationSec", v."thumbnailUrl", v."thumbnailKey", v."provider", v."processingStatus", v."isActive" AS "videoActive", v."language"
             FROM ${T.chapterVideo} cv JOIN ${T.video} v ON v."_id" = cv."video"
            WHERE cv."book" = $1 ORDER BY cv."displayOrder", cv."createdAt"`, [book._id]),
        q(`SELECT "_id", "title", "edition", "publicationYear", "status", "previousEdition" FROM ${T.book}
            WHERE "editionGroup" = $1 ORDER BY "publicationYear" NULLS FIRST, "createdAt"`, [book.editionGroup || book._id]),
        q(`SELECT s."_id", s."name", s."code",
                  count(DISTINCT a."class")::int AS "classCount",
                  count(*) FILTER (WHERE a."section" IS NOT NULL)::int AS "sectionAssignments",
                  count(*) FILTER (WHERE a."section" IS NULL)::int AS "classAssignments"
             FROM ${T.assignment} a JOIN ${T.school} s ON s."_id" = a."school"
            WHERE a."book" = $1 AND a."status" = 'active' GROUP BY s."_id", s."name", s."code" ORDER BY lower(s."name")`, [book._id]),
    ]);
    const withThumb = videos.map(thumbOf);
    return {
        ...book, classLabel: levelLabel(book.classLevel), editions, schools,
        chapters: chapters.map((c) => ({ ...c, videos: withThumb.filter((v) => String(v.chapter) === String(c._id)) })),
    };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Chapters
// ═════════════════════════════════════════════════════════════════════════════

function chapterFields(body) {
    const title = str(body.title, 200);
    if (title.length < 2) throw bad('Chapter title is required');
    return {
        title, chapterNumber: int(body.chapterNumber, 'Chapter number', { min: 1, max: 999 }),
        description: str(body.description, 3000), thumbnailUrl: str(body.thumbnailUrl, 400),
        estimatedMinutes: int(body.estimatedMinutes ?? 0, 'Estimated duration', { min: 0, max: 6000 }),
    };
}

async function createChapter(bookId, body, userId) {
    const book = await M.book.findById(id(bookId)).lean();
    if (!book) throw notFound('Book');
    const f = chapterFields(body);
    if (await M.chapter.findOne({ book: book._id, chapterNumber: f.chapterNumber }).lean()) throw conflict(`This book already has a Chapter ${f.chapterNumber}`);
    const [{ next }] = await q(`SELECT COALESCE(max("displayOrder"), 0) + 1 AS next FROM ${T.chapter} WHERE "book" = $1`, [book._id]);
    return M.chapter.create({ ...f, book: book._id, displayOrder: next, status: body.status === 'inactive' ? 'inactive' : 'active', createdBy: userId, updatedBy: userId });
}

async function updateChapter(chapterId, body, userId) {
    const ch = await M.chapter.findById(id(chapterId)).lean();
    if (!ch) throw notFound('Chapter');
    const f = chapterFields({ ...ch, ...body });
    if (f.chapterNumber !== ch.chapterNumber && await M.chapter.findOne({ book: ch.book, chapterNumber: f.chapterNumber }).lean()) throw conflict(`This book already has a Chapter ${f.chapterNumber}`);
    const status = body.status === undefined ? ch.status : oneOf(body.status, ['active', 'inactive'], 'Status');
    await M.chapter.updateOne({ _id: ch._id }, { $set: { ...f, status, updatedBy: userId } });
    return M.chapter.findById(ch._id).lean();
}

/** Put a book's chapters in the order given. Every chapter of the book must be named exactly once. */
async function reorderChapters(bookId, ids) {
    const chapters = await M.chapter.find({ book: id(bookId) }, '_id').lean();
    const have = new Set(chapters.map((c) => String(c._id)));
    const want = (Array.isArray(ids) ? ids : []).map(String);
    if (want.length !== have.size || new Set(want).size !== want.length || !want.every((x) => have.has(x))) throw bad('The order must list every chapter of the book exactly once');
    await q(`UPDATE ${T.chapter} c SET "displayOrder" = o.ord, "updatedAt" = now()
               FROM unnest($1::uuid[]) WITH ORDINALITY AS o(cid, ord) WHERE c."_id" = o.cid AND c."book" = $2`, [want, bookId]);
    return { reordered: want.length };
}

async function removeChapter(chapterId) {
    const ch = await M.chapter.findById(id(chapterId)).lean();
    if (!ch) throw notFound('Chapter');
    const used = await one(`
        SELECT (SELECT count(*) FROM ${T.release} WHERE "chapter" = $1)::int AS releases,
               (SELECT count(*) FROM ${T.progress} WHERE "chapter" = $1)::int AS progress`, [ch._id]);
    if (used.releases || used.progress) throw conflict('Teachers have released this chapter or students have watched it. It cannot be deleted — deactivate it instead.', 'IN_USE');
    await M.chapter.deleteOne({ _id: ch._id });
    return ch;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Video assets
// ═════════════════════════════════════════════════════════════════════════════

/** The address a screen shows a video's thumbnail from: the picture set on it, else the one processing made. */
function thumbOf(v) {
    const { thumbnailKey, ...rest } = v;
    return { ...rest, thumbnailUrl: v.thumbnailUrl || (thumbnailKey ? `/api/video/media/thumb/${v.video || v._id}` : '') };
}

/** A video as an API may return it: never its storage keys. */
function publicVideo(v) {
    if (!v) return v;
    const { storageKey, playbackKey, thumbnailKey, processingJobId, ...rest } = v;
    return { ...rest, hasFile: !!storageKey, thumbnailUrl: v.thumbnailUrl || (thumbnailKey ? `/api/video/media/thumb/${v._id}` : '') };
}

async function listVideos(query) {
    const pg = paging(query);
    const params = [];
    const where = [];
    if (query.search) { params.push(like(query.search)); where.push(`(v."title" ILIKE $${params.length} OR v."description" ILIKE $${params.length} OR v."tags"::text ILIKE $${params.length})`); }
    if (query.provider) { params.push(oneOf(query.provider, Object.keys(providers.PROVIDERS), 'Provider')); where.push(`v."provider" = $${params.length}`); }
    if (query.processingStatus === 'working') where.push(`v."processingStatus" IN ('uploading', 'queued', 'processing')`);
    else if (query.processingStatus) { params.push(oneOf(query.processingStatus, ['draft', 'uploading', 'queued', 'processing', 'ready', 'failed'], 'Processing status')); where.push(`v."processingStatus" = $${params.length}`); }
    if (query.subject) { params.push(id(query.subject, 'Subject')); where.push(`v."subject" = $${params.length}`); }
    if (query.active === 'true') where.push('v."isActive"');
    if (query.active === 'false') where.push('NOT v."isActive"');
    if (query.mapped === 'false') where.push(`NOT EXISTS (SELECT 1 FROM ${T.chapterVideo} cv WHERE cv."video" = v."_id")`);
    if (query.mapped === 'true') where.push(`EXISTS (SELECT 1 FROM ${T.chapterVideo} cv WHERE cv."video" = v."_id")`);
    // What a chapter can take: ready, active, and not already in that chapter.
    if (query.mappable === 'true') where.push(`v."isActive" AND v."processingStatus" = 'ready'`);
    if (query.notInChapter) { params.push(id(query.notInChapter, 'Chapter')); where.push(`NOT EXISTS (SELECT 1 FROM ${T.chapterVideo} cv WHERE cv."video" = v."_id" AND cv."chapter" = $${params.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${T.video} v ${w}`, params);
    const rows = await q(`
        SELECT v.*, s."name" AS "subjectName",
               (SELECT count(*) FROM ${T.chapterVideo} cv WHERE cv."video" = v."_id")::int AS "mappingCount"
          FROM ${T.video} v LEFT JOIN ${T.subject} s ON s."_id" = v."subject"
          ${w} ORDER BY v."createdAt" DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`, params);
    const counts = await one(`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE "processingStatus" = 'ready')::int AS ready,
               count(*) FILTER (WHERE "processingStatus" IN ('uploading', 'queued', 'processing'))::int AS working,
               count(*) FILTER (WHERE "processingStatus" = 'failed')::int AS failed,
               count(*) FILTER (WHERE "processingStatus" = 'draft')::int AS draft FROM ${T.video}`, []);
    return { rows: rows.map(publicVideo), total: n, pg, counts };
}

/** A video opened up: every chapter it is mapped to, and its latest upload and processing job. */
async function getVideo(videoId) {
    const v = await one(`SELECT v.*, s."name" AS "subjectName" FROM ${T.video} v LEFT JOIN ${T.subject} s ON s."_id" = v."subject" WHERE v."_id" = $1`, [id(videoId)]);
    if (!v) throw notFound('Video');
    const [mappings, job, upload] = await Promise.all([
        q(`SELECT cv."_id", cv."isActive", cv."displayOrder", c."_id" AS "chapter", c."title" AS "chapterTitle", c."chapterNumber",
                  k."_id" AS "book", k."title" AS "bookTitle", k."classLevel", k."edition", b."name" AS "boardName", b."code" AS "boardCode", s."name" AS "subjectName"
             FROM ${T.chapterVideo} cv JOIN ${T.chapter} c ON c."_id" = cv."chapter" JOIN ${T.book} k ON k."_id" = cv."book"
             JOIN ${T.board} b ON b."_id" = k."board" JOIN ${T.subject} s ON s."_id" = k."subject"
            WHERE cv."video" = $1 ORDER BY lower(b."name"), k."classLevel", lower(k."title"), c."chapterNumber"`, [v._id]),
        one(`SELECT "status", "attempts", "maxAttempts", "lastError", "updatedAt" FROM ${T.job} WHERE "video" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [v._id]),
        one(`SELECT "_id", "status", "mode", "filename", "sizeBytes", "totalChunks", "receivedChunks", "error" FROM ${T.upload} WHERE "video" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [v._id]),
    ]);
    return { ...publicVideo(v), mappings: mappings.map((m) => ({ ...m, classLabel: levelLabel(m.classLevel) })), job, upload };
}

async function videoFields(body, provider) {
    const title = str(body.title, 200);
    if (title.length < 2) throw bad('Video title is required');
    const protection = body.protection === undefined || body.protection === '' ? (provider === 'youtube' ? 'standard' : 'strict') : oneOf(body.protection, ['standard', 'strict'], 'Protection');
    if (provider === 'youtube' && protection === 'strict') {
        throw bad('YouTube cannot be used for protected content: a YouTube video can be opened, shared and downloaded outside the app. Mark the video as standard, or use Vimeo or an uploaded file.', 'YOUTUBE_NOT_STRICT');
    }
    const subject = idOrNull(body.subject, 'Subject');
    if (subject && !await M.subject.findById(subject).lean()) throw notFound('Subject');
    const tags = [...new Set((Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',')).map((t) => str(t, 40)).filter(Boolean))].slice(0, 20);
    const durationSec = body.durationSec === undefined || body.durationSec === '' || body.durationSec === null ? 0 : Number(body.durationSec);
    if (!Number.isFinite(durationSec) || durationSec < 0 || durationSec > 6 * 3600) throw bad('Video length must be between 1 second and 6 hours');
    return {
        title, description: str(body.description, 3000), thumbnailUrl: str(body.thumbnailUrl, 500),
        language: str(body.language, 40) || 'English', subject, tags, protection, durationSec: Math.round(durationSec * 100) / 100,
    };
}

/** Read a Vimeo / YouTube address for the "add video" form: the id, and what the provider says about it. */
async function lookupEmbed(providerName, input) {
    const { provider, cfg } = await providers.ready(oneOf(providerName, ['vimeo', 'youtube'], 'Provider'));
    const assetId = provider.parse(input);
    if (!assetId) throw bad(`That is not a ${provider.label} video address or id`);
    const meta = await provider.fetchMeta(assetId, cfg).catch(() => ({ found: null }));
    if (meta.found === false) throw bad(`${provider.label} has no video at that address, or it is private`);
    const existing = await M.video.findOne({ provider: provider.name, providerAssetId: assetId }, '_id title').lean();
    return { provider: provider.name, providerAssetId: assetId, checked: meta.found === true, title: meta.title || '', durationSec: meta.durationSec || 0, thumbnailUrl: meta.thumbnailUrl || '', existing };
}

/**
 * Add a video to the library.
 *   vimeo / youtube   linked by its address; ready at once
 *   a file            created as a draft — the upload follows (services/lms/uploads)
 */
async function createVideo(body, userId) {
    const kind = body.provider === 'vimeo' || body.provider === 'youtube' ? body.provider : 'file';
    if (kind === 'file') {
        const { provider } = await providers.uploadTarget();
        const f = await videoFields(body, provider.name);
        const v = await M.video.create({ ...f, provider: provider.name, processingStatus: 'draft', playbackType: 'file', createdBy: userId, updatedBy: userId });
        return getVideo(v._id);
    }
    const { provider, cfg } = await providers.ready(kind);
    const assetId = provider.parse(body.url || body.providerAssetId);
    if (!assetId) throw bad(`That is not a ${provider.label} video address or id`);
    const dup = await M.video.findOne({ provider: provider.name, providerAssetId: assetId }, '_id title').lean();
    if (dup) throw conflict(`This ${provider.label} video is already in the library as "${dup.title}". Map that one to more chapters instead of adding it again.`, 'DUPLICATE', { existing: dup._id });
    const meta = await provider.fetchMeta(assetId, cfg).catch(() => ({ found: null }));
    if (meta.found === false) throw bad(`${provider.label} has no video at that address, or it is private`);
    const f = await videoFields({ ...body, title: body.title || meta.title, durationSec: body.durationSec || meta.durationSec, thumbnailUrl: body.thumbnailUrl || meta.thumbnailUrl }, provider.name);
    if (!f.durationSec) throw bad('Enter the video\'s length — it is needed to track how much of it a student has watched');
    const v = await M.video.create({
        ...f, provider: provider.name, providerAssetId: assetId, playbackType: 'embed', processingStatus: 'ready', uploadedAt: new Date(), createdBy: userId, updatedBy: userId,
    });
    return getVideo(v._id);
}

async function updateVideo(videoId, body, userId) {
    const v = await M.video.findById(id(videoId)).lean();
    if (!v) throw notFound('Video');
    const f = await videoFields({ ...v, ...body }, v.provider);
    if (v.processingStatus === 'ready' && !f.durationSec) throw bad('Enter the video\'s length — it is needed to track how much of it a student has watched');
    // A linked video that was waiting only for its length is ready once it has one.
    const nowReady = v.playbackType === 'embed' && v.processingStatus === 'failed' && f.durationSec > 0;
    await M.video.updateOne({ _id: v._id }, { $set: { ...f, updatedBy: userId, ...(nowReady ? { processingStatus: 'ready', processingError: '' } : {}) } });
    return getVideo(v._id);
}

async function setVideoActive(videoId, active, userId) {
    const v = await M.video.findById(id(videoId)).lean();
    if (!v) throw notFound('Video');
    await M.video.updateOne({ _id: v._id }, { $set: { isActive: !!active, updatedBy: userId } });
    return getVideo(v._id);
}

async function removeVideo(videoId) {
    const v = await M.video.findById(id(videoId)).lean();
    if (!v) throw notFound('Video');
    const used = await one(`
        SELECT (SELECT count(*) FROM ${T.chapterVideo} WHERE "video" = $1)::int AS mappings,
               (SELECT count(*) FROM ${T.progress} WHERE "video" = $1)::int AS progress`, [v._id]);
    if (used.mappings || used.progress) throw conflict(`This video is mapped to ${used.mappings} chapter(s) and has ${used.progress} watch record(s). Remove its mappings first, or deactivate it.`, 'IN_USE');
    await M.video.deleteOne({ _id: v._id });
    try {
        const provider = providers.get(v.provider);
        await provider.remove(v, await providers.config(v.provider));
    } catch (e) { console.error('[video] stored file not removed:', e.message); }
    return v;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Chapter ↔ video mappings
// ═════════════════════════════════════════════════════════════════════════════

/** Map videos to a chapter. Only ready, active videos; one already there is left as it is. */
async function mapVideos(chapterId, videoIds, userId) {
    const ch = await M.chapter.findById(id(chapterId)).lean();
    if (!ch) throw notFound('Chapter');
    const ids = [...new Set((Array.isArray(videoIds) ? videoIds : [videoIds]).filter(Boolean).map((v) => id(v, 'Video')))];
    if (!ids.length) throw bad('Choose at least one video');
    const videos = await M.video.find({ _id: { $in: ids } }, '_id title processingStatus isActive').lean();
    if (videos.length !== ids.length) throw notFound('Video');
    const notReady = videos.find((v) => v.processingStatus !== 'ready');
    if (notReady) throw bad(`"${notReady.title}" is not ready yet (${notReady.processingStatus}). A video can be mapped once its processing has finished.`, 'VIDEO_NOT_READY');
    const off = videos.find((v) => !v.isActive);
    if (off) throw bad(`"${off.title}" is deactivated. Activate it before mapping it.`);
    const have = new Map((await M.chapterVideo.find({ chapter: ch._id }).lean()).map((m) => [String(m.video), m]));
    let [{ next }] = await q(`SELECT COALESCE(max("displayOrder"), 0) + 1 AS next FROM ${T.chapterVideo} WHERE "chapter" = $1`, [ch._id]);
    let added = 0;
    for (const vid of ids) {
        const existing = have.get(String(vid));
        if (existing) {
            if (!existing.isActive) { await M.chapterVideo.updateOne({ _id: existing._id }, { $set: { isActive: true } }); added++; }
            continue;
        }
        await M.chapterVideo.create({ chapter: ch._id, book: ch.book, video: vid, displayOrder: next++, isActive: true, createdBy: userId });
        added++;
    }
    return { added, chapter: ch };
}

/**
 * Take a video out of a chapter. A mapping a teacher has released or a student
 * has watched is kept and switched off — what was watched stays on record.
 */
async function unmapVideo(mappingId) {
    const m = await M.chapterVideo.findById(id(mappingId)).lean();
    if (!m) throw notFound('Mapping');
    const used = await one(`
        SELECT (SELECT count(*) FROM ${T.release} WHERE "chapterVideo" = $1)::int AS releases,
               (SELECT count(*) FROM ${T.progress} WHERE "chapterVideo" = $1)::int AS progress`, [m._id]);
    if (used.releases || used.progress) {
        await M.chapterVideo.updateOne({ _id: m._id }, { $set: { isActive: false } });
        return { removed: false, deactivated: true, mapping: m };
    }
    await M.chapterVideo.deleteOne({ _id: m._id });
    return { removed: true, deactivated: false, mapping: m };
}

async function reorderChapterVideos(chapterId, ids) {
    const maps = await M.chapterVideo.find({ chapter: id(chapterId) }, '_id').lean();
    const have = new Set(maps.map((m) => String(m._id)));
    const want = (Array.isArray(ids) ? ids : []).map(String);
    if (want.length !== have.size || new Set(want).size !== want.length || !want.every((x) => have.has(x))) throw bad('The order must list every video of the chapter exactly once');
    await q(`UPDATE ${T.chapterVideo} cv SET "displayOrder" = o.ord, "updatedAt" = now()
               FROM unnest($1::uuid[]) WITH ORDINALITY AS o(mid, ord) WHERE cv."_id" = o.mid AND cv."chapter" = $2`, [want, chapterId]);
    return { reordered: want.length };
}

module.exports = {
    listBoards, createBoard, updateBoard, setBoardActive, removeBoard, boardDetail,
    listSubjects, createSubject, updateSubject, setSubjectMappings, removeSubject,
    listBooks, createBook, updateBook, setBookStatus, newEdition, removeBook, getBook, bookInUse,
    createChapter, updateChapter, reorderChapters, removeChapter,
    listVideos, getVideo, createVideo, updateVideo, setVideoActive, removeVideo, lookupEmbed, publicVideo, thumbOf,
    mapVideos, unmapVideo, reorderChapterVideos,
};
