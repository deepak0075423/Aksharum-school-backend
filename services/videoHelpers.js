'use strict';
// Shared helpers for the Video Learning controllers: response shorthands, audit
// logging, and the taxonomy-mapping engine that powers "one video → many
// boards/classes/subjects/…" without duplicating videos.
const VideoTaxonomy = require('../models/VideoTaxonomy');
const VideoAuditLog = require('../models/VideoAuditLog');
const { slugify } = require('./videoAccess');

// ── response shorthands ───────────────────────────────────────────────────────
const ok   = (res, data)            => res.json({ success: true, data });
const bad  = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const fail = (res, e)               => { console.error('[video]', e); return res.status(500).json({ success: false, message: e.message }); };

const DIMENSIONS = ['board', 'grade', 'subject', 'chapter', 'topic', 'subtopic', 'language', 'medium', 'academic_year', 'term', 'section'];

// ── audit ─────────────────────────────────────────────────────────────────────
async function audit(req, actionType, entityType, entityId, description = '', meta = {}) {
    try {
        await VideoAuditLog.create({
            school: req.schoolId || null,
            user:   req.userId || null,
            role:   req.userRole || '',
            actionType, entityType, entityId, description, meta,
            ip: req.headers?.['x-forwarded-for'] || req.ip || '',
        });
    } catch { /* audit is best-effort, never blocks the request */ }
}

// ── taxonomy engine ───────────────────────────────────────────────────────────
// Replace the mappings of one entity for the dimensions present in `mappings`.
// `mappings` shape: { board:['CBSE','ICSE'], grade:['Class 10'], subject:[{value:'Physics',refId}], ... }
// Values may be plain strings or { value, refId, sequence }. Dimensions omitted
// from `mappings` are left untouched (partial update). Pass an empty array to
// clear a dimension.
async function applyTaxonomy(entityType, entityId, mappings = {}) {
    const dims = Object.keys(mappings).filter((d) => DIMENSIONS.includes(d));
    for (const dimension of dims) {
        const raw = mappings[dimension];
        const values = (Array.isArray(raw) ? raw : [raw]).filter((v) => v != null && v !== '');
        // wipe existing for this dimension, then insert the new set
        await VideoTaxonomy.deleteMany({ entityType, entityId, dimension });
        if (!values.length) continue;
        const rows = values.map((v, i) => {
            const value = typeof v === 'object' ? v.value : v;
            return {
                entityType, entityId, dimension,
                value: String(value).trim(),
                valueSlug: slugify(value),
                refId: (typeof v === 'object' && v.refId) ? v.refId : null,
                sequence: (typeof v === 'object' && v.sequence != null) ? v.sequence : i,
            };
        }).filter((r) => r.valueSlug);
        if (rows.length) await VideoTaxonomy.insertMany(rows, { ordered: false }).catch(() => {});
    }
}

// Grouped taxonomy for one entity → { board:[…], subject:[…], … }.
async function getTaxonomy(entityType, entityId) {
    const rows = await VideoTaxonomy.find({ entityType, entityId }).sort({ dimension: 1, sequence: 1 }).lean();
    const out = {};
    for (const r of rows) (out[r.dimension] = out[r.dimension] || []).push({ value: r.value, valueSlug: r.valueSlug, refId: r.refId, sequence: r.sequence });
    return out;
}

// Grouped taxonomy for many entities → Map(entityId → grouped) in one query.
async function getTaxonomyForMany(entityType, ids) {
    if (!ids.length) return new Map();
    const rows = await VideoTaxonomy.find({ entityType, entityId: { $in: ids.map(String) } }).lean();
    const map = new Map();
    for (const r of rows) {
        const key = String(r.entityId);
        if (!map.has(key)) map.set(key, {});
        const g = map.get(key);
        (g[r.dimension] = g[r.dimension] || []).push(r.value);
    }
    return map;
}

// Resolve the set of video ids that satisfy ALL provided taxonomy filters
// (AND across dimensions, OR within a dimension). Returns null when no taxonomy
// filter is supplied (caller then skips the intersection). Returns [] when a
// filter is supplied but nothing matches.
async function resolveVideoIdsByTaxonomy(filters = {}) {
    const active = DIMENSIONS.filter((d) => filters[d]);
    if (!active.length) return null;

    let acc = null;
    for (const dimension of active) {
        const wanted = (Array.isArray(filters[dimension]) ? filters[dimension] : [filters[dimension]]).map(slugify);
        const rows = await VideoTaxonomy.find(
            { entityType: 'video', dimension, valueSlug: { $in: wanted } }, 'entityId',
        ).lean();
        const ids = new Set(rows.map((r) => String(r.entityId)));
        acc = acc === null ? ids : new Set([...acc].filter((x) => ids.has(x)));
        if (!acc.size) return [];
    }
    return [...acc];
}

// Sequential per-scope document code: PREFIX-YYMM-####.
async function nextCode(Model, filter, prefix) {
    const d  = new Date();
    const ym = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const n  = await Model.countDocuments(filter);
    return `${prefix}-${ym}-${String(n + 1).padStart(4, '0')}`;
}

module.exports = {
    ok, bad, fail, DIMENSIONS, audit,
    applyTaxonomy, getTaxonomy, getTaxonomyForMany, resolveVideoIdsByTaxonomy, nextCode,
};
