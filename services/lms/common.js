'use strict';
/**
 * Video Learning — what every service and controller of the module shares:
 * the query helper, table names, the error a handler may throw, paging, and
 * the audit writer.
 */
const pool = require('../../db/pool');
const { isUuid } = require('../../db/schema');
const { CLASS_LEVELS, levelOf } = require('../../utils/classLevels');

const q = async (sql, params) => (await pool.query(sql, params)).rows;

// Table names, read from the models so a rename can never leave SQL behind.
const M = {
    board: require('../../models/LmsBoard'), subject: require('../../models/LmsSubject'),
    subjectMap: require('../../models/LmsSubjectMap'), book: require('../../models/LmsBook'),
    chapter: require('../../models/LmsChapter'), video: require('../../models/LmsVideo'),
    chapterVideo: require('../../models/LmsChapterVideo'), provider: require('../../models/LmsProvider'),
    setting: require('../../models/LmsSetting'), upload: require('../../models/LmsUpload'),
    job: require('../../models/LmsJob'), schoolConfig: require('../../models/LmsSchoolConfig'),
    schoolSubject: require('../../models/LmsSchoolSubject'), assignment: require('../../models/LmsBookAssignment'),
    request: require('../../models/LmsRequest'), release: require('../../models/LmsRelease'),
    progress: require('../../models/LmsProgress'), session: require('../../models/LmsWatchSession'),
    heartbeat: require('../../models/LmsHeartbeat'), audit: require('../../models/LmsAudit'),
    notice: require('../../models/LmsNotice'),
    school: require('../../models/School'), user: require('../../models/User'),
    year: require('../../models/AcademicYear'), class: require('../../models/Class'),
    section: require('../../models/ClassSection'), schoolSubjectRow: require('../../models/Subject'),
    classSubject: require('../../models/ClassSubject'), sectionTeacher: require('../../models/SectionSubjectTeacher'),
    studentProfile: require('../../models/StudentProfile'),
};
const T = Object.fromEntries(Object.entries(M).map(([k, model]) => [k, `"${model.tableName}"`]));

/** An error a handler throws to answer with a status and a message. */
class HttpError extends Error {
    constructor(status, message, code = undefined, extra = undefined) {
        super(message);
        this.status = status; this.code = code; this.extra = extra;
    }
}
const bad       = (message, code, extra) => new HttpError(400, message, code, extra);
const forbidden = (message = 'You do not have access to this', code = 'FORBIDDEN') => new HttpError(403, message, code);
const notFound  = (what = 'Record') => new HttpError(404, `${what} not found`, 'NOT_FOUND');
const conflict  = (message, code = 'CONFLICT', extra) => new HttpError(409, message, code, extra);

const ok = (res, data, extra) => res.json({ success: true, data, ...(extra || {}) });
const created = (res, data, extra) => res.status(201).json({ success: true, data, ...(extra || {}) });

/**
 * Wrap a handler: an HttpError becomes its status, a broken unique rule a 409,
 * a row something still points at a 409, anything else a logged 500.
 */
const handle = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (e) {
        if (res.headersSent) return undefined;
        if (e instanceof HttpError) {
            return res.status(e.status).json({ success: false, message: e.message, ...(e.code ? { code: e.code } : {}), ...(e.extra || {}) });
        }
        if (e.code === '23505' || e.code === 11000) return res.status(409).json({ success: false, code: 'DUPLICATE', message: 'This already exists' });
        if (e.code === '23503') return res.status(409).json({ success: false, code: 'IN_USE', message: 'This is in use and cannot be removed' });
        if (e.code === '22P02') return res.status(400).json({ success: false, message: 'That id is not valid' });
        console.error('[video]', e);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
};

// ── Reading a request ────────────────────────────────────────────────────────
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const id = (v, label = 'Id') => {
    const s = String(v ?? '').trim();
    if (!isUuid(s)) throw bad(`${label} is not valid`);
    return s;
};
const idOrNull = (v, label) => (v === null || v === undefined || v === '' ? null : id(v, label));
const int = (v, label, { min = -Infinity, max = Infinity, optional = false } = {}) => {
    if (v === null || v === undefined || v === '') {
        if (optional) return null;
        throw bad(`${label} is required`);
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number${Number.isFinite(min) ? ` from ${min}` : ''}${Number.isFinite(max) ? ` to ${max}` : ''}`);
    return n;
};
const oneOf = (v, list, label) => {
    if (!list.includes(v)) throw bad(`${label} must be one of: ${list.join(', ')}`);
    return v;
};
const dateOrNull = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw bad(`${label} is not a valid date`);
    return d;
};
const classLevel = (v, label = 'Class') => {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || !levelOf(n)) throw bad(`${label} must be one of the standard classes`);
    return n;
};
const levelLabel = (n) => levelOf(n)?.label || `Class ${n}`;

/** page / limit from a query string, capped. */
function paging(query, { max = 100, def = 20 } = {}) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(max, Math.max(1, parseInt(query.limit, 10) || def));
    return { page, limit, offset: (page - 1) * limit };
}
const paged = (res, rows, total, { page, limit }, extra) => res.json({
    success: true, data: rows, total: Number(total) || 0, page, limit,
    pages: Math.max(1, Math.ceil((Number(total) || 0) / limit)), ...(extra || {}),
});
/** ILIKE pattern for a search box, with the wildcard characters taken literally. */
const like = (term) => `%${String(term || '').trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const ipOf = (req) => req?.ip || req?.socket?.remoteAddress || '';

// ── Cached figures ───────────────────────────────────────────────────────────
// Report figures are cached briefly in Redis. Each scope — the central library,
// or one school — has a generation number that every change in it bumps, and
// the number is part of the cache key: a figure computed before a change is
// never served after it. Watching (heartbeats) does not bump it; those figures
// simply age out with their short TTL.
const redis = () => { try { return require('../../config/cacheRedis').getCacheRedis(); } catch { return null; } };

async function bump(scope) {
    const r = redis();
    if (r) await r.incr(`lms:gen:${scope || 'central'}`).catch(() => {});
}

/** Cache a computed value for a short while (Redis; computed afresh when Redis is away). */
async function cached(key, ttlSec, compute, scopes = ['central']) {
    const r = redis();
    let full = `lms:${key}`;
    if (r) {
        try {
            const gens = await r.mget(...scopes.map((s) => `lms:gen:${s}`));
            full = `lms:${scopes.map((s, i) => `${s}.${gens[i] || 0}`).join(':')}:${key}`;
            const hit = await r.get(full);
            if (hit) return JSON.parse(hit);
        } catch { /* compute */ }
    }
    const value = await compute();
    if (r) r.set(full, JSON.stringify(value), 'EX', ttlSec).catch(() => {});
    return value;
}

/** One line of the module's history. Never throws — a failed audit must not fail the action. */
async function audit(req, action, entityType, entityId, summary = '', meta = {}, school = undefined) {
    const where = school === undefined ? (req?.schoolId || null) : school;
    try {
        await M.audit.create({
            school: where,
            actor: req?.userId || null, actorRole: req?.userRole || 'system',
            action, entityType, entityId: entityId || null, summary: String(summary).slice(0, 500), meta, ip: ipOf(req),
        });
    } catch (e) { console.error('[video] audit failed:', e.message); }
    // Every audited change is a change to that scope's figures. The platform
    // overview counts every school, so it moves with all of them; a library
    // change shows in every school's figures too.
    await bump('central');
    if (where) await bump(String(where)); else await bump('library');
}

module.exports = {
    q, pool, M, T, HttpError, bad, forbidden, notFound, conflict, ok, created, handle,
    str, id, idOrNull, int, oneOf, dateOrNull, classLevel, levelLabel, CLASS_LEVELS, isUuid,
    paging, paged, like, ipOf, audit, cached, bump,
};
