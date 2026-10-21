'use strict';
/**
 * Writing the admission module's history (AdmissionEvent) — the application
 * timeline and the audit log in one. Every service that changes something
 * calls record(); inside a transaction it is given the transaction's query
 * function, so the history and the change commit together or not at all.
 */
const pool = require('../../db/pool');
const AdmissionEvent = require('../../models/AdmissionEvent');
const { buildInsert } = require('../dbTx');

/** Who did it, from a request or a plain { _id, name, role }. */
function actorOf(who) {
    if (!who) return { actor: null, actorRole: 'system', actorName: 'System' };
    if (who.user || who.userId) {
        return { actor: who.userId || who.user?._id || null, actorRole: who.userRole || who.user?.role || 'system', actorName: who.user?.name || '' };
    }
    return { actor: who._id || null, actorRole: who.role || 'system', actorName: who.name || '' };
}

/**
 * record(schoolId, { application, by, type, action, from, to, message, visibility, meta }, q)
 * `by` is the request (or a user) behind the change; omitted, it is the system.
 */
async function record(schoolId, entry, q = null) {
    const row = {
        school: schoolId,
        application: entry.application || null,
        ...actorOf(entry.by),
        type: entry.type,
        action: entry.action || '',
        from: entry.from || '',
        to: entry.to || '',
        message: String(entry.message || '').slice(0, 2000),
        visibility: entry.visibility === 'applicant' ? 'applicant' : 'internal',
        meta: entry.meta || null,
        createdAt: new Date(),
    };
    const { sql, params } = buildInsert(AdmissionEvent, row);
    const run = q || ((s, p) => pool.query(s, p));
    await run(sql, params);
}

/** record() that never fails the caller — for history written after the fact. */
function recordQuietly(schoolId, entry) {
    record(schoolId, entry).catch((e) => console.error('[admission event]', e.message));
}

/** An application's timeline, newest first; `applicantView` keeps only what the family may see. */
async function timeline(schoolId, applicationId, { applicantView = false, limit = 200 } = {}) {
    const { rows } = await pool.query(
        `SELECT "_id", "type", "action", "from", "to", "message", "visibility", "actorName", "actorRole", "meta", "createdAt"
           FROM "${AdmissionEvent.tableName}"
          WHERE "school" = $1 AND "application" = $2 ${applicantView ? `AND "visibility" = 'applicant'` : ''}
          ORDER BY "createdAt" DESC LIMIT ${Math.min(500, Number(limit) || 200)}`,
        [String(schoolId), String(applicationId)],
    );
    return applicantView
        ? rows.map((r) => ({ _id: r._id, type: r.type, action: r.action, to: r.to, message: r.message, createdAt: r.createdAt, by: ['guest', 'system'].includes(r.actorRole) ? r.actorRole : 'school' }))
        : rows;
}

module.exports = { record, recordQuietly, timeline, actorOf };
