'use strict';
/**
 * The Medical Room's audit trail (Oct 2026): who created, changed, archived,
 * uploaded, administered — and who LOOKED. Medical information is sensitive,
 * so reading a student's profile, history, emergency profile or a file is
 * recorded as well as writing to it.
 *
 * Fire-and-forget: a failure to write the trail is logged, never allowed to
 * fail the action it describes. Views are de-duplicated — one row per reader,
 * student and kind of view in ten minutes — so paging through a profile does
 * not bury the writes.
 */
const MedicalAuditLog = require('../models/MedicalAuditLog');
const pool = require('../db/pool');
const R = require('./medicalRules');

// Fields whose content is never copied into the trail: that they changed is
// recorded, what they say is not.
const SECRET = new Set(['privateNotes']);

const actorOf = (req) => ({
    actor: req?.userId || null,
    actorName: req?.user?.name || '',
    actorRole: req?.userRole || 'system',
});

function write(req, entry) {
    const row = {
        school: req.schoolId,
        ...actorOf(req),
        ip: String(req?.ip || '').slice(0, 64),
        userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300),
        createdAt: new Date(),
        ...entry,
    };
    return MedicalAuditLog.create(row).catch((e) => console.error('[medical] audit write failed:', e.message));
}

/**
 * log(req, { action, entity, entityId, student, summary, changes })
 * `changes` may be the output of diff() below.
 */
function log(req, { action, entity = '', entityId = null, student = null, summary = '', changes = [] }) {
    if (!req?.schoolId) return Promise.resolve();
    // Every write the trail records is also a nudge to the open desk screens
    // to read again — the nudge names the kind of record, never its contents.
    if (action !== 'viewed') require('./medicalLive').changed(req, entity, { action, id: entityId ? String(entityId) : null, urgent: action === 'break_glass' });
    return write(req, {
        action, entity, entityId: entityId ? String(entityId) : null,
        student: student ? String(student) : null, summary: String(summary || '').slice(0, 500),
        changes: Array.isArray(changes) ? changes.slice(0, 60) : [],
    });
}

/** A view, recorded at most once per reader, student and `entity` in ten minutes. */
async function viewed(req, { entity, entityId = null, student = null, summary = '' }) {
    if (!req?.schoolId || !req?.userId) return;
    try {
        const { rows } = await pool.query(
            `SELECT 1 FROM "${MedicalAuditLog.tableName}"
              WHERE "school" = $1 AND "actor" = $2 AND "action" = 'viewed' AND "entity" = $3
                AND "student" IS NOT DISTINCT FROM $4::uuid
                AND "entityId" IS NOT DISTINCT FROM $5::uuid
                AND "createdAt" > now() - interval '10 minutes'
              LIMIT 1`,
            [String(req.schoolId), String(req.userId), entity, student ? String(student) : null, entityId ? String(entityId) : null],
        );
        if (rows.length) return;
        await log(req, { action: 'viewed', entity, entityId, student, summary });
        // An unusual number of students' records in an hour is the admins' business at once.
        if (student) require('./medicalAccessReview').watch(req);
    } catch (e) { console.error('[medical] audit view failed:', e.message); }
}

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2}))?$/;
const MIDNIGHT = /T00:00:00(\.0+)?(Z|\+00:?00)$/;
const words = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

/** A value as the trail shows it: days and times in words, an object as
 *  "height cm 156, weight kg 42" — never JSON nobody can read. */
const show = (v) => {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date) v = v.toISOString();
    if (typeof v === 'string' && ISO.test(v)) return v.length === 10 || MIDNIGHT.test(v) ? R.dayLabel(v) : R.instantLabel(v);
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (Array.isArray(v)) return v.map(show).filter(Boolean).join('; ').slice(0, 200);
    if (typeof v === 'object') {
        return Object.entries(v)
            .map(([k, x]) => { const s = show(x); return s ? `${words(k)} ${s}` : ''; })
            .filter(Boolean).join(', ').slice(0, 200);
    }
    return String(v).slice(0, 200);
};

/** [{ field, from, to }] for the fields of `fields` that changed between two plain objects. */
function diff(before = {}, after = {}, fields = Object.keys(after || {})) {
    const out = [];
    for (const f of fields) {
        const a = before?.[f]; const b = after?.[f];
        if (b === undefined) continue;
        if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
        out.push(SECRET.has(f) ? { field: f, from: '(hidden)', to: '(changed)' } : { field: f, from: show(a), to: show(b) });
    }
    return out;
}

module.exports = { log, viewed, diff };
