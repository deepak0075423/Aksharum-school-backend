'use strict';
// Apply update operators ($set/$inc/$push/…) to a document (fetch-modify-write model).

const { newId } = require('./schema');

function getPath(obj, path) {
    const segs = path.split('.');
    let cur = obj;
    for (const s of segs) {
        if (cur == null) return undefined;
        cur = cur[s];
    }
    return cur;
}

function setPath(obj, path, value) {
    const segs = path.split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        if (cur[s] == null || typeof cur[s] !== 'object') {
            cur[s] = /^\d+$/.test(segs[i + 1]) ? [] : {};
        }
        cur = cur[s];
    }
    cur[segs[segs.length - 1]] = value;
}

function deletePath(obj, path) {
    const segs = path.split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        cur = cur ? cur[segs[i]] : undefined;
        if (cur == null) return;
    }
    if (cur && typeof cur === 'object') delete cur[segs[segs.length - 1]];
}

function valueEquals(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a === 'object' && typeof b === 'object') {
        if (a._id != null && b._id != null) return String(a._id) === String(b._id);
        return JSON.stringify(a) === JSON.stringify(b);
    }
    return String(a) === String(b);
}

// $pull condition matcher (subset of query semantics, evaluated in JS)
function pullMatches(el, cond) {
    if (cond === null || typeof cond !== 'object' || cond instanceof Date || Array.isArray(cond)) {
        return valueEquals(el, cond);
    }
    const keys = Object.keys(cond);
    if (keys.every((k) => k.startsWith('$'))) {
        // operators applied to the element itself
        return matchOps(el, cond);
    }
    // partial object match
    return keys.every((k) => {
        const v = cond[k];
        const cur = getPath(el, k);
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) &&
            Object.keys(v).every((x) => x.startsWith('$'))) {
            return matchOps(cur, v);
        }
        return valueEquals(cur, v);
    });
}

function matchOps(val, ops) {
    for (const [op, arg] of Object.entries(ops)) {
        switch (op) {
            case '$in': if (!(arg || []).some((x) => valueEquals(val, x))) return false; break;
            case '$nin': if ((arg || []).some((x) => valueEquals(val, x))) return false; break;
            case '$ne': if (valueEquals(val, arg)) return false; break;
            case '$eq': if (!valueEquals(val, arg)) return false; break;
            case '$gt': if (!(val > arg)) return false; break;
            case '$gte': if (!(val >= arg)) return false; break;
            case '$lt': if (!(val < arg)) return false; break;
            case '$lte': if (!(val <= arg)) return false; break;
            case '$exists': if ((val !== undefined) !== !!arg) return false; break;
            default: break;
        }
    }
    return true;
}

function ensureSubdocId(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !v._id) {
        return { _id: newId(), ...v };
    }
    return v;
}

// Applies `update` to `doc` (a Document instance or plain object). Returns doc.
function applyUpdate(doc, update) {
    if (!update || typeof update !== 'object') return doc;
    const hasOps = Object.keys(update).some((k) => k.startsWith('$'));
    const plainSet = hasOps ? (update.$set || {}) : update;

    for (const [path, v] of Object.entries(plainSet)) {
        if (path.startsWith('$')) continue;
        setPath(doc, path, v);
    }
    if (!hasOps) return doc;

    if (update.$unset) {
        for (const path of Object.keys(update.$unset)) deletePath(doc, path);
    }
    if (update.$inc) {
        for (const [path, amt] of Object.entries(update.$inc)) {
            const cur = Number(getPath(doc, path)) || 0;
            setPath(doc, path, cur + Number(amt));
        }
    }
    if (update.$push) {
        for (const [path, spec] of Object.entries(update.$push)) {
            let arr = getPath(doc, path);
            if (!Array.isArray(arr)) { arr = []; setPath(doc, path, arr); }
            if (spec !== null && typeof spec === 'object' && !Array.isArray(spec) && spec.$each !== undefined) {
                for (const el of spec.$each) arr.push(ensureSubdocId(el));
                if (spec.$slice !== undefined) {
                    const n = Number(spec.$slice);
                    const sliced = n >= 0 ? arr.slice(0, n) : arr.slice(n);
                    arr.length = 0; arr.push(...sliced);
                }
            } else {
                arr.push(ensureSubdocId(spec));
            }
        }
    }
    if (update.$addToSet) {
        for (const [path, spec] of Object.entries(update.$addToSet)) {
            let arr = getPath(doc, path);
            if (!Array.isArray(arr)) { arr = []; setPath(doc, path, arr); }
            const items = (spec !== null && typeof spec === 'object' && !Array.isArray(spec) && spec.$each !== undefined) ? spec.$each : [spec];
            for (const el of items) {
                if (!arr.some((x) => valueEquals(x, el))) arr.push(ensureSubdocId(el));
            }
        }
    }
    if (update.$pull) {
        for (const [path, cond] of Object.entries(update.$pull)) {
            const arr = getPath(doc, path);
            if (!Array.isArray(arr)) continue;
            const kept = arr.filter((el) => !pullMatches(el, cond));
            arr.length = 0; arr.push(...kept);
        }
    }
    if (update.$pullAll) {
        for (const [path, vals] of Object.entries(update.$pullAll)) {
            const arr = getPath(doc, path);
            if (!Array.isArray(arr)) continue;
            const kept = arr.filter((el) => !(vals || []).some((v) => valueEquals(el, v)));
            arr.length = 0; arr.push(...kept);
        }
    }
    if (update.$min) {
        for (const [path, v] of Object.entries(update.$min)) {
            const cur = getPath(doc, path);
            if (cur === undefined || v < cur) setPath(doc, path, v);
        }
    }
    if (update.$max) {
        for (const [path, v] of Object.entries(update.$max)) {
            const cur = getPath(doc, path);
            if (cur === undefined || v > cur) setPath(doc, path, v);
        }
    }
    return doc;
}

// Extract plain equality fields from a filter (for upsert inserts)
function equalityFields(filter) {
    const out = {};
    for (const [k, v] of Object.entries(filter || {})) {
        if (k.startsWith('$')) continue;
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp)) {
            if (v.$eq !== undefined) out[k] = v.$eq;
            continue;
        }
        if (k.includes('.')) { setPath(out, k, v); continue; }
        out[k] = v;
    }
    return out;
}

module.exports = { applyUpdate, equalityFields, getPath, setPath };
