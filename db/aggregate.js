'use strict';
// In-memory aggregation pipeline. School-scale data: fetch matching rows via
// SQL for the leading $match, then run the remaining stages in JS.

const registry = require('./registry');

function getPathValue(doc, path) {
    const segs = path.split('.');
    let cur = doc;
    for (const s of segs) {
        if (cur == null) return undefined;
        if (Array.isArray(cur)) {
            cur = cur.map((el) => (el == null ? undefined : el[s])).filter((v) => v !== undefined);
            if (cur.length === 0) return undefined;
        } else {
            cur = cur[s];
        }
    }
    return cur;
}

function toDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'string' || typeof v === 'number') return new Date(v);
    return null;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function evalExpr(expr, doc) {
    if (expr == null) return expr;
    if (typeof expr === 'string') {
        if (expr.startsWith('$$')) return undefined;
        if (expr.startsWith('$')) return getPathValue(doc, expr.slice(1));
        return expr;
    }
    if (typeof expr !== 'object') return expr;
    if (expr instanceof Date) return expr;
    if (Array.isArray(expr)) return expr.map((e) => evalExpr(e, doc));

    const keys = Object.keys(expr);
    if (keys.length === 1 && keys[0].startsWith('$')) {
        const op = keys[0];
        const arg = expr[op];
        const ev = (x) => evalExpr(x, doc);
        switch (op) {
            case '$sum': { const v = ev(arg); return Array.isArray(v) ? v.reduce((s, x) => s + num(x), 0) : num(v); }
            case '$avg': { const v = ev(arg); if (!Array.isArray(v) || !v.length) return null; return v.reduce((s, x) => s + num(x), 0) / v.length; }
            case '$min': { const v = ev(arg); return Array.isArray(v) ? v.reduce((m, x) => (m == null || x < m ? x : m), null) : v; }
            case '$max': { const v = ev(arg); return Array.isArray(v) ? v.reduce((m, x) => (m == null || x > m ? x : m), null) : v; }
            case '$multiply': return ev(arg).reduce((p, x) => p * num(x), 1);
            case '$divide': { const [a, b] = ev(arg); return num(b) === 0 ? null : num(a) / num(b); }
            case '$subtract': {
                const x = evalExpr(arg[0], doc); const y = evalExpr(arg[1], doc);
                if (x instanceof Date && y instanceof Date) return x - y;
                if (x instanceof Date) return new Date(x.getTime() - num(y));
                return num(x) - num(y); }
            case '$add': { const vals = ev(arg); if (vals.some((v) => v instanceof Date)) { let ms = 0; let base = null; for (const v of vals) { if (v instanceof Date) base = v.getTime(); else ms += num(v); } return new Date(base + ms); } return vals.reduce((s, x) => s + num(x), 0); }
            case '$cond': {
                if (Array.isArray(arg)) return ev(arg[0]) ? ev(arg[1]) : ev(arg[2]);
                return ev(arg.if) ? ev(arg.then) : ev(arg.else);
            }
            case '$ifNull': { const [a, b] = [evalExpr(arg[0], doc), evalExpr(arg[1], doc)]; return a == null ? b : a; }
            case '$arrayElemAt': { const [arr, i] = [evalExpr(arg[0], doc), num(evalExpr(arg[1], doc))]; if (!Array.isArray(arr)) return null; return i < 0 ? arr[arr.length + i] : arr[i]; }
            case '$size': { const v = ev(arg); return Array.isArray(v) ? v.length : 0; }
            case '$round': { const [v, p] = Array.isArray(arg) ? ev(arg) : [ev(arg), 0]; const f = 10 ** num(p); return Math.round(num(v) * f) / f; }
            case '$toDouble': return num(ev(arg));
            case '$toInt': return Math.trunc(num(ev(arg)));
            case '$abs': return Math.abs(num(ev(arg)));
            case '$concat': { const vals = ev(arg); return vals.some((v) => v == null) ? null : vals.map(String).join(''); }
            case '$toUpper': { const v = ev(arg); return v == null ? '' : String(v).toUpperCase(); }
            case '$toLower': { const v = ev(arg); return v == null ? '' : String(v).toLowerCase(); }
            case '$year': { const d = toDate(ev(arg)); return d ? d.getUTCFullYear() : null; }
            case '$month': { const d = toDate(ev(arg)); return d ? d.getUTCMonth() + 1 : null; }
            case '$dayOfMonth': { const d = toDate(ev(arg)); return d ? d.getUTCDate() : null; }
            case '$hour': { const d = toDate(ev(arg)); return d ? d.getUTCHours() : null; }
            case '$dateToString': {
                const d = toDate(evalExpr(arg.date, doc));
                if (!d) return null;
                const fmt = arg.format || '%Y-%m-%d';
                const pad = (n, w = 2) => String(n).padStart(w, '0');
                return fmt
                    .replace(/%Y/g, String(d.getUTCFullYear()))
                    .replace(/%m/g, pad(d.getUTCMonth() + 1))
                    .replace(/%d/g, pad(d.getUTCDate()))
                    .replace(/%H/g, pad(d.getUTCHours()))
                    .replace(/%M/g, pad(d.getUTCMinutes()))
                    .replace(/%S/g, pad(d.getUTCSeconds()));
            }
            case '$eq': { const [a, b] = ev(arg); return looseEq(a, b); }
            case '$ne': { const [a, b] = ev(arg); return !looseEq(a, b); }
            case '$gt': { const [a, b] = ev(arg); return cmpVals(a, b) > 0; }
            case '$gte': { const [a, b] = ev(arg); return cmpVals(a, b) >= 0; }
            case '$lt': { const [a, b] = ev(arg); return cmpVals(a, b) < 0; }
            case '$lte': { const [a, b] = ev(arg); return cmpVals(a, b) <= 0; }
            case '$and': return ev(arg).every(Boolean);
            case '$or': return ev(arg).some(Boolean);
            case '$not': { const v = Array.isArray(arg) ? ev(arg[0]) : ev(arg); return !v; }
            case '$in': { const [v, arr] = ev(arg); return Array.isArray(arr) && arr.some((x) => looseEq(x, v)); }
            case '$literal': return arg;
            default: return undefined;
        }
    }
    // object construction
    const out = {};
    for (const [k, v] of Object.entries(expr)) out[k] = evalExpr(v, doc);
    return out;
}

function looseEq(a, b) {
    if (a instanceof Date || b instanceof Date) {
        const da = toDate(a); const db = toDate(b);
        return da && db ? da.getTime() === db.getTime() : a === b;
    }
    if (a == null && b == null) return true;
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return String(a) === String(b);
}

function cmpVals(a, b) {
    if (a instanceof Date || b instanceof Date) {
        const da = toDate(a); const db = toDate(b);
        if (da && db) return da - db;
    }
    if (typeof a === 'number' || typeof b === 'number') return num(a) - num(b);
    return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
}

// JS $match (used for non-leading $match stages)
function jsMatch(doc, filter) {
    for (const [key, val] of Object.entries(filter || {})) {
        if (key === '$or') { if (!val.some((f) => jsMatch(doc, f))) return false; continue; }
        if (key === '$and') { if (!val.every((f) => jsMatch(doc, f))) return false; continue; }
        if (key === '$nor') { if (val.some((f) => jsMatch(doc, f))) return false; continue; }
        if (key === '$expr') { if (!evalExpr(val, doc)) return false; continue; }
        const cur = getPathValue(doc, key);
        if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date) && !(val instanceof RegExp) &&
            Object.keys(val).length && Object.keys(val).every((k) => k.startsWith('$'))) {
            for (const [op, arg] of Object.entries(val)) {
                switch (op) {
                    case '$eq': if (!matchesEq(cur, arg)) return false; break;
                    case '$ne': if (matchesEq(cur, arg)) return false; break;
                    case '$gt': if (!(cmpVals(cur, arg) > 0)) return false; break;
                    case '$gte': if (!(cmpVals(cur, arg) >= 0)) return false; break;
                    case '$lt': if (!(cmpVals(cur, arg) < 0)) return false; break;
                    case '$lte': if (!(cmpVals(cur, arg) <= 0)) return false; break;
                    case '$in': if (!(arg || []).some((x) => matchesEq(cur, x))) return false; break;
                    case '$nin': if ((arg || []).some((x) => matchesEq(cur, x))) return false; break;
                    case '$exists': if ((cur !== undefined) !== !!arg) return false; break;
                    case '$regex': { const re = arg instanceof RegExp ? arg : new RegExp(arg, val.$options || ''); if (typeof cur !== 'string' || !re.test(cur)) return false; break; }
                    case '$options': break;
                    default: break;
                }
            }
            continue;
        }
        if (!matchesEq(cur, val)) return false;
    }
    return true;
}

function matchesEq(cur, val) {
    if (Array.isArray(cur) && !Array.isArray(val)) return cur.some((x) => looseEq(x, val));
    if (val instanceof RegExp) return typeof cur === 'string' && val.test(cur);
    return looseEq(cur, val);
}

async function runPipeline(model, pipeline) {
    let rows;
    let stages = [...(pipeline || [])];

    if (stages.length && stages[0] && stages[0].$match && !hasExprDeep(stages[0].$match)) {
        rows = await model._rawFind(stages[0].$match, {});
        stages = stages.slice(1);
    } else {
        rows = await model._rawFind({}, {});
    }

    for (const stage of stages) {
        const op = Object.keys(stage)[0];
        const arg = stage[op];
        switch (op) {
            case '$match':
                rows = rows.filter((r) => jsMatch(r, arg));
                break;
            case '$group': {
                const groups = new Map();
                for (const r of rows) {
                    const key = evalExpr(arg._id, r);
                    const keyStr = JSON.stringify(key === undefined ? null : key);
                    if (!groups.has(keyStr)) groups.set(keyStr, { key, rows: [] });
                    groups.get(keyStr).rows.push(r);
                }
                const out = [];
                for (const { key, rows: grp } of groups.values()) {
                    const g = { _id: key === undefined ? null : key };
                    for (const [field, acc] of Object.entries(arg)) {
                        if (field === '_id') continue;
                        const accOp = Object.keys(acc)[0];
                        const accArg = acc[accOp];
                        switch (accOp) {
                            case '$sum': g[field] = grp.reduce((s, r) => s + num(evalExpr(accArg, r)), 0); break;
                            case '$avg': g[field] = grp.length ? grp.reduce((s, r) => s + num(evalExpr(accArg, r)), 0) / grp.length : null; break;
                            case '$min': g[field] = grp.reduce((m, r) => { const v = evalExpr(accArg, r); return m == null || cmpVals(v, m) < 0 ? v : m; }, null); break;
                            case '$max': g[field] = grp.reduce((m, r) => { const v = evalExpr(accArg, r); return m == null || cmpVals(v, m) > 0 ? v : m; }, null); break;
                            case '$first': g[field] = grp.length ? evalExpr(accArg, grp[0]) : null; break;
                            case '$last': g[field] = grp.length ? evalExpr(accArg, grp[grp.length - 1]) : null; break;
                            case '$push': g[field] = grp.map((r) => evalExpr(accArg, r)); break;
                            case '$addToSet': { const seen = new Set(); const outArr = []; for (const r of grp) { const v = evalExpr(accArg, r); const k = JSON.stringify(v); if (!seen.has(k)) { seen.add(k); outArr.push(v); } } g[field] = outArr; break; }
                            case '$count': g[field] = grp.length; break;
                            default: g[field] = null;
                        }
                    }
                    out.push(g);
                }
                rows = out;
                break;
            }
            case '$lookup': {
                const Target = registry.byTable(arg.from);
                const localField = arg.localField;
                const foreignField = arg.foreignField;
                const as = arg.as;
                if (!Target) { for (const r of rows) r[as] = []; break; }
                const localVals = new Set();
                for (const r of rows) {
                    const v = getPathValue(r, localField);
                    if (Array.isArray(v)) v.forEach((x) => x != null && localVals.add(String(x)));
                    else if (v != null) localVals.add(String(v));
                }
                let foreign = [];
                if (localVals.size) {
                    if (foreignField === '_id') {
                        foreign = await Target._rawFind({ _id: { $in: [...localVals] } }, {});
                    } else {
                        foreign = await Target._rawFind({}, {});
                        foreign = foreign.filter((f) => {
                            const fv = getPathValue(f, foreignField);
                            if (Array.isArray(fv)) return fv.some((x) => localVals.has(String(x)));
                            return fv != null && localVals.has(String(fv));
                        });
                    }
                }
                const index = new Map();
                for (const f of foreign) {
                    const fv = getPathValue(f, foreignField);
                    const keys = Array.isArray(fv) ? fv : [fv];
                    for (const k of keys) {
                        const ks = String(k);
                        if (!index.has(ks)) index.set(ks, []);
                        index.get(ks).push(f);
                    }
                }
                for (const r of rows) {
                    const v = getPathValue(r, localField);
                    const keys = Array.isArray(v) ? v : [v];
                    const acc = [];
                    const seen = new Set();
                    for (const k of keys) {
                        for (const f of (index.get(String(k)) || [])) {
                            const idk = String(f._id);
                            if (!seen.has(idk)) { seen.add(idk); acc.push(f); }
                        }
                    }
                    r[as] = acc;
                }
                break;
            }
            case '$unwind': {
                const spec = typeof arg === 'string' ? { path: arg } : arg;
                const path = spec.path.slice(1);
                const keep = !!spec.preserveNullAndEmptyArrays;
                const out = [];
                for (const r of rows) {
                    const v = getPathValue(r, path);
                    if (Array.isArray(v) && v.length) {
                        for (const el of v) {
                            const clone = { ...r };
                            setShallowPath(clone, path, el);
                            out.push(clone);
                        }
                    } else if (keep) {
                        out.push(r);
                    }
                }
                rows = out;
                break;
            }
            case '$project': {
                const hasInclusion = Object.entries(arg).some(([k, v]) => k !== '_id' && (v === 1 || v === true || (typeof v === 'object' || typeof v === 'string')));
                rows = rows.map((r) => {
                    let out;
                    if (hasInclusion) {
                        out = {};
                        if (arg._id === undefined || arg._id === 1 || arg._id === true) out._id = r._id;
                        for (const [k, v] of Object.entries(arg)) {
                            if (k === '_id') continue;
                            if (v === 0 || v === false) continue;
                            if (v === 1 || v === true) { const val = getPathValue(r, k); if (val !== undefined) setShallowPath(out, k, val); }
                            else out[k] = evalExpr(v, r);
                        }
                    } else {
                        out = { ...r };
                        for (const [k, v] of Object.entries(arg)) if (v === 0 || v === false) delete out[k];
                    }
                    return out;
                });
                break;
            }
            case '$addFields':
            case '$set': {
                rows = rows.map((r) => {
                    const out = { ...r };
                    for (const [k, v] of Object.entries(arg)) out[k] = evalExpr(v, r);
                    return out;
                });
                break;
            }
            case '$sort': {
                const keys = Object.entries(arg);
                rows = [...rows].sort((a, b) => {
                    for (const [k, dir] of keys) {
                        const c = cmpVals(getPathValue(a, k), getPathValue(b, k));
                        if (c !== 0) return dir === -1 ? -c : c;
                    }
                    return 0;
                });
                break;
            }
            case '$limit': rows = rows.slice(0, num(arg)); break;
            case '$skip': rows = rows.slice(num(arg)); break;
            case '$count': rows = [{ [arg]: rows.length }]; break;
            case '$facet': {
                const out = {};
                for (const [name, sub] of Object.entries(arg)) {
                    out[name] = await runSubPipeline(rows, sub);
                }
                rows = [out];
                break;
            }
            default:
                break;
        }
    }
    return rows;
}

function setShallowPath(obj, path, val) {
    const segs = path.split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        cur[s] = (cur[s] != null && typeof cur[s] === 'object') ? { ...cur[s] } : {};
        cur = cur[s];
    }
    cur[segs[segs.length - 1]] = val;
}

function hasExprDeep(obj) {
    if (obj == null || typeof obj !== 'object') return false;
    for (const [k, v] of Object.entries(obj)) {
        if (k === '$expr') return true;
        if (typeof v === 'object' && hasExprDeep(v)) return true;
    }
    return false;
}

async function runSubPipeline(rows, stages) {
    const fake = {
        _rawFind: async (filter) => rows
            .filter((r) => jsMatch(r, filter || {}))
            .map((r) => ({ ...r })),
    };
    return runPipeline(fake, stages);
}

module.exports = { runPipeline, jsMatch, evalExpr };
