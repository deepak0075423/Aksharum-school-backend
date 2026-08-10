'use strict';
// Populate engine: batch-fetch referenced rows and stitch them in place.

const registry = require('./registry');
const { isUuid } = require('./schema');

// Normalize populate args into [{ path, select, populate, model }]
function normalizePopulate(args) {
    const specs = [];
    const pushSpec = (s) => {
        if (!s) return;
        if (typeof s === 'string') {
            for (const p of s.split(/\s+/).filter(Boolean)) specs.push({ path: p });
        } else if (Array.isArray(s)) {
            s.forEach(pushSpec);
        } else if (typeof s === 'object' && s.path) {
            specs.push({
                path: s.path,
                select: s.select,
                populate: s.populate,
                model: s.model,
                options: s.options,
            });
        }
    };
    pushSpec(args);
    return specs;
}

// Collect { parent, key, val } sites for a dot path, flattening arrays.
function collectSites(docs, segs) {
    const sites = [];
    const walk = (node, i) => {
        if (node == null) return;
        if (Array.isArray(node)) { for (const el of node) walk(el, i); return; }
        if (typeof node !== 'object') return;
        const key = segs[i];
        if (i === segs.length - 1) {
            if (node[key] !== undefined) sites.push({ parent: node, key });
            return;
        }
        walk(node[key], i + 1);
    };
    for (const d of docs) walk(d, 0);
    return sites;
}

function idOf(v) {
    if (v == null) return null;
    if (typeof v === 'object') return v._id != null ? String(v._id) : null;
    return String(v);
}

async function populateDocs(model, docs, specsRaw) {
    const specs = normalizePopulate(specsRaw);
    if (!specs.length || !docs.length) return docs;
    const parsed = model.schema.parsed();

    for (const spec of specs) {
        const segs = String(spec.path).split('.');
        const targetName = parsed.refPaths[spec.path] || spec.model;
        const Target = targetName ? registry.get(targetName) : null;
        if (!Target) continue;

        const sites = collectSites(docs, segs);
        if (!sites.length) continue;

        const ids = new Set();
        for (const { parent, key } of sites) {
            const val = parent[key];
            if (Array.isArray(val)) {
                for (const v of val) { const id = idOf(v); if (id && isUuid(id)) ids.add(id); }
            } else {
                const id = idOf(val);
                if (id && isUuid(id)) ids.add(id);
            }
        }

        let map = new Map();
        if (ids.size) {
            const rows = await Target._rawFind({ _id: { $in: [...ids] } }, {});
            if (spec.populate) await populateDocs(Target, rows, spec.populate);
            if (spec.select) for (const r of rows) pruneSelect(r, spec.select);
            map = new Map(rows.map((r) => [String(r._id), r]));
        }

        for (const { parent, key } of sites) {
            const val = parent[key];
            if (Array.isArray(val)) {
                parent[key] = val
                    .map((v) => {
                        const id = idOf(v);
                        return id ? (map.get(id) || null) : (v && typeof v === 'object' ? v : null);
                    })
                    .filter((v) => v !== null);
            } else {
                const id = idOf(val);
                if (id) parent[key] = map.get(id) || null;
            }
        }
    }
    return docs;
}

// Apply a projection ('a b -c' or {a:1}) to a plain object, in place.
function pruneSelect(obj, select) {
    if (!obj || !select) return obj;
    let include = [];
    let exclude = [];
    if (typeof select === 'string') {
        for (const tok of select.split(/\s+/).filter(Boolean)) {
            if (tok.startsWith('-')) exclude.push(tok.slice(1));
            else if (tok.startsWith('+')) include.push(tok.slice(1));
            else include.push(tok);
        }
    } else if (typeof select === 'object') {
        for (const [k, v] of Object.entries(select)) {
            if (v) include.push(k); else exclude.push(k);
        }
    }
    if (include.length) {
        const keepRoots = new Set(include.map((p) => p.split('.')[0]));
        keepRoots.add('_id');
        for (const k of Object.keys(obj)) {
            if (!keepRoots.has(k)) delete obj[k];
        }
    }
    for (const path of exclude) {
        if (path === '_id') { delete obj._id; continue; }
        const segs = path.split('.');
        let cur = obj;
        for (let i = 0; i < segs.length - 1 && cur; i++) cur = cur[segs[i]];
        if (cur && typeof cur === 'object') delete cur[segs[segs.length - 1]];
    }
    return obj;
}

module.exports = { populateDocs, normalizePopulate, pruneSelect };
