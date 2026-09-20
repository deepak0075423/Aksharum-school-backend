'use strict';
/**
 * The fees module's history. Every change the office makes to a fee head,
 * category, structure, concession, fine rule or the settings writes one row
 * here, and the History tabs, the concessions' Recent Activity panel and the
 * Settings → Audit Logs tab all read it back.
 *
 * The FeeAuditLog table existed from the start but nothing ever wrote to it,
 * so there was no history to show. Writing is fire-and-forget: a lost audit row
 * must never fail the change it describes.
 */
const FeeAuditLog = require('../models/FeeAuditLog');

// Fields not worth recording as "changed" — bookkeeping the ORM moves itself.
const NOISE = new Set(['_id', 'school', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', '__v', 'itemsHash']);

const plain = (v) => {
    if (v == null) return v;
    if (typeof v.toObject === 'function') v = v.toObject();
    return JSON.parse(JSON.stringify(v));
};

/** The keys whose value differs between two versions of a record. */
function changedKeys(before, after) {
    const a = plain(before) || {};
    const b = plain(after) || {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter(k => !NOISE.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/**
 * Record one change. `action` is a short verb phrase key ('created', 'updated',
 * 'activated', 'deactivated', 'archived', 'assigned', 'unassigned', 'reset', …).
 */
function logFeeAudit(req, { action, entityType, entityId = null, before = null, after = null, note = '' }) {
    const oldValue = before ? plain(before) : null;
    let newValue = after ? plain(after) : null;
    if (action === 'updated' && before && after) {
        const keys = changedKeys(before, after);
        if (!keys.length) return Promise.resolve(null); // a save that changed nothing is not history
        newValue = { ...newValue, _changed: keys };
    }
    if (note) newValue = { ...(newValue || {}), _note: note };
    return FeeAuditLog.create({
        school: req.schoolId,
        user: req.userId || null,
        role: req.userRole || '',
        actionType: action,
        entityType,
        entityId: entityId ? String(entityId) : null,
        oldValue,
        newValue,
    }).catch((e) => { console.error('[FeeAudit] write failed:', e.message); return null; });
}

module.exports = { logFeeAudit, changedKeys };
