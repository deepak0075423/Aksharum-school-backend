'use strict';
// Translate the query-operator filter syntax ($eq/$in/$gte/…) into parameterized SQL WHERE clauses.

const { isUuid, extractId } = require('./schema');

const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;

function jsonPathExpr(col, segs, asText) {
    const path = `'{${segs.map((s) => String(s).replace(/'/g, "''")).join(',')}}'`;
    return `${col} ${asText ? '#>>' : '#>'} ${path}`;
}

// Resolve a dot path against the schema.
// -> { mode: 'column'|'json'|'array'|'unknown', ... }
function resolvePath(parsed, path) {
    const segs = path.split('.');
    const root = segs[0];
    const meta = parsed.fields[root];
    if (path === '_id') return { mode: 'column', name: '_id', kind: 'id' };
    if (!meta) return { mode: 'unknown' };

    const scalarKinds = ['string', 'number', 'boolean', 'date', 'id'];
    if (scalarKinds.includes(meta.kind)) {
        return { mode: 'column', name: root, kind: meta.kind };
    }
    // JSONB root
    const rest = segs.slice(1);
    if (meta.array) {
        return { mode: 'array', name: root, meta, rest };
    }
    // walk children to find the leaf meta (arrays nested inside objects)
    let leaf = meta;
    let consumed = [];
    for (const seg of rest) {
        const next = leaf && leaf.children ? leaf.children[seg] : (leaf && leaf.kind === 'mixed' ? null : null);
        consumed.push(seg);
        leaf = next || { kind: 'mixed' };
        if (leaf.array) {
            // object path leading into a nested array of subdocs
            const remaining = rest.slice(consumed.length);
            return { mode: 'array', name: root, meta: leaf, rest: remaining, prefix: consumed };
        }
    }
    return { mode: 'json', name: root, segs: rest, leaf };
}

function leafKindOf(meta, segs) {
    let leaf = meta && meta.elem ? meta.elem : meta;
    for (const seg of segs || []) {
        leaf = leaf && leaf.children ? (leaf.children[seg] || { kind: 'mixed' }) : { kind: 'mixed' };
        if (leaf.elem) leaf = leaf.elem;
    }
    return leaf ? leaf.kind : 'mixed';
}

function isOperatorObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) &&
           !(v instanceof RegExp) && Object.keys(v).length > 0 &&
           Object.keys(v).every((k) => k.startsWith('$'));
}

// ── typed scalar condition builders ─────────────────────────────────────────

function castParam(params, kind, v) {
    if (kind === 'id') {
        const id = extractId(v);
        if (!isUuid(id)) return null;
        params.push(id);
        return `$${params.length}::uuid`;
    }
    if (kind === 'date') {
        params.push(v instanceof Date ? v : new Date(v));
        return `$${params.length}::timestamptz`;
    }
    if (kind === 'number') { params.push(Number(v)); return `$${params.length}::float8`; }
    if (kind === 'boolean') { params.push(Boolean(v)); return `$${params.length}::boolean`; }
    params.push(typeof v === 'string' ? v : String(v));
    return `$${params.length}::text`;
}

function columnCond(params, colExpr, kind, val) {
    if (val === null || val === undefined) return `${colExpr} IS NULL`;
    if (val instanceof RegExp) return regexCond(params, colExpr, val.source, val.flags);
    if (isOperatorObject(val)) return opsCond(params, colExpr, kind, val, false);
    const p = castParam(params, kind, val);
    if (p === null) return '(1=0)';
    return `${colExpr} = ${p}`;
}

function regexCond(params, expr, source, flags) {
    params.push(source);
    const op = (flags || '').includes('i') ? '~*' : '~';
    return `${expr} ${op} $${params.length}`;
}

function inCond(params, colExpr, kind, values, negate) {
    const vals = Array.isArray(values) ? values : [values];
    const hasNull = vals.some((v) => v == null);
    let nonNull = vals.filter((v) => v != null);
    let arrType = 'text[]';
    if (kind === 'id') {
        nonNull = nonNull.map(extractId).filter(isUuid);
        arrType = 'uuid[]';
    } else if (kind === 'number') { nonNull = nonNull.map(Number); arrType = 'float8[]'; }
    else if (kind === 'date') { nonNull = nonNull.map((v) => (v instanceof Date ? v : new Date(v)).toISOString()); arrType = 'timestamptz[]'; }
    else if (kind === 'boolean') { nonNull = nonNull.map(Boolean); arrType = 'boolean[]'; }
    else { nonNull = nonNull.map((v) => String(v)); }

    let core;
    if (nonNull.length === 0) core = '(1=0)';
    else {
        params.push(nonNull);
        core = `${colExpr} = ANY($${params.length}::${arrType})`;
    }
    if (!negate) {
        return hasNull ? `(${colExpr} IS NULL OR ${core})` : core;
    }
    // $nin
    if (hasNull) return `(${colExpr} IS NOT NULL AND NOT ${core})`;
    return `(${colExpr} IS NULL OR NOT ${core})`;
}

function opsCond(params, colExpr, kind, ops, isJsonText) {
    const parts = [];
    const cmp = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' };
    for (const [op, v] of Object.entries(ops)) {
        if (op === '$options') continue;
        if (op === '$eq') parts.push(columnCond(params, colExpr, kind, v));
        else if (op === '$ne') {
            if (v == null) parts.push(`${colExpr} IS NOT NULL`);
            else {
                const p = castParam(params, kind, v);
                parts.push(p === null ? '(1=1)' : `${colExpr} IS DISTINCT FROM ${p}`);
            }
        } else if (cmp[op]) {
            const p = castParam(params, kind, v);
            parts.push(p === null ? '(1=0)' : `${colExpr} ${cmp[op]} ${p}`);
        } else if (op === '$in') parts.push(inCond(params, colExpr, kind, v, false));
        else if (op === '$nin') parts.push(inCond(params, colExpr, kind, v, true));
        else if (op === '$regex') {
            const src = v instanceof RegExp ? v.source : String(v);
            const flags = v instanceof RegExp ? v.flags : (ops.$options || '');
            parts.push(regexCond(params, colExpr, src, flags));
        } else if (op === '$exists') parts.push(v ? `${colExpr} IS NOT NULL` : `${colExpr} IS NULL`);
        else if (op === '$type') parts.push('(1=1)');
        else if (op === '$not') {
            const inner = isOperatorObject(v)
                ? opsCond(params, colExpr, kind, v, isJsonText)
                : columnCond(params, colExpr, kind, v);
            parts.push(`(${colExpr} IS NULL OR NOT (${inner}))`);
        } else parts.push('(1=1)');
    }
    return parts.length ? parts.map((p) => `(${p})`).join(' AND ') : 'TRUE';
}

// ── JSONB path conditions ───────────────────────────────────────────────────

function jsonCond(params, col, segs, leafKind, val) {
    const textExpr = segs.length ? jsonPathExpr(col, segs, true) : `(${col} #>> '{}')`;
    const jsonExpr = segs.length ? jsonPathExpr(col, segs, false) : col;

    if (val === null || val === undefined) return `${textExpr} IS NULL`;
    if (val instanceof RegExp) return regexCond(params, textExpr, val.source, val.flags);
    if (isOperatorObject(val)) return jsonOpsCond(params, col, segs, leafKind, val);

    if (val instanceof Date) {
        params.push(val.toISOString());
        return `${textExpr} = $${params.length}`;
    }
    if (typeof val === 'object') {
        params.push(JSON.stringify(val));
        return `${jsonExpr} = $${params.length}::jsonb`;
    }
    params.push(JSON.stringify(val));
    return `${jsonExpr} = $${params.length}::jsonb`;
}

function jsonOpsCond(params, col, segs, leafKind, ops) {
    const textExpr = segs.length ? jsonPathExpr(col, segs, true) : `(${col} #>> '{}')`;
    const jsonExpr = segs.length ? jsonPathExpr(col, segs, false) : col;
    const cmp = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' };
    const parts = [];
    for (const [op, v] of Object.entries(ops)) {
        if (op === '$options') continue;
        if (op === '$eq') parts.push(jsonCond(params, col, segs, leafKind, v));
        else if (op === '$ne') {
            if (v == null) parts.push(`${textExpr} IS NOT NULL`);
            else { params.push(JSON.stringify(v instanceof Date ? v : v)); parts.push(`(${jsonExpr} IS NULL OR ${jsonExpr} <> $${params.length}::jsonb)`); }
        } else if (cmp[op]) {
            if (typeof v === 'number' || leafKind === 'number') {
                params.push(Number(v));
                parts.push(`(${textExpr})::numeric ${cmp[op]} $${params.length}`);
            } else if (v instanceof Date || leafKind === 'date') {
                params.push((v instanceof Date ? v : new Date(v)).toISOString());
                parts.push(`${textExpr} ${cmp[op]} $${params.length}`);
            } else {
                params.push(String(v));
                parts.push(`${textExpr} ${cmp[op]} $${params.length}`);
            }
        } else if (op === '$in') {
            const vals = (Array.isArray(v) ? v : [v]);
            const hasNull = vals.some((x) => x == null);
            const nonNull = vals.filter((x) => x != null).map((x) => JSON.stringify(x instanceof Date ? x.toISOString() : x));
            let core = '(1=0)';
            if (nonNull.length) {
                params.push(nonNull);
                core = `${jsonExpr} = ANY($${params.length}::jsonb[])`;
            }
            parts.push(hasNull ? `(${textExpr} IS NULL OR ${core})` : core);
        } else if (op === '$nin') {
            const vals = (Array.isArray(v) ? v : [v]).filter((x) => x != null).map((x) => JSON.stringify(x));
            if (!vals.length) parts.push('(1=1)');
            else {
                params.push(vals);
                parts.push(`(${jsonExpr} IS NULL OR NOT ${jsonExpr} = ANY($${params.length}::jsonb[]))`);
            }
        } else if (op === '$regex') {
            const src = v instanceof RegExp ? v.source : String(v);
            const flags = v instanceof RegExp ? v.flags : (ops.$options || '');
            parts.push(regexCond(params, textExpr, src, flags));
        } else if (op === '$exists') parts.push(v ? `${textExpr} IS NOT NULL` : `${textExpr} IS NULL`);
        else parts.push('(1=1)');
    }
    return parts.length ? parts.map((p) => `(${p})`).join(' AND ') : 'TRUE';
}

// ── array field conditions (JSONB arrays) ───────────────────────────────────

let elemAlias = 0;
function arrayCond(params, colName, arrMeta, restSegs, val, prefixSegs) {
    const col = qi(colName);
    const base = (prefixSegs && prefixSegs.length) ? jsonPathExpr(col, prefixSegs, false) : col;
    const alias = `__e${++elemAlias % 1000}`;
    const elemMeta = arrMeta.elem || { kind: 'mixed' };

    // whole-array equality
    if (Array.isArray(val)) {
        params.push(JSON.stringify(val));
        return `${base} = $${params.length}::jsonb`;
    }
    if (isOperatorObject(val)) {
        if (val.$size !== undefined) {
            params.push(Number(val.$size));
            return `jsonb_array_length(CASE WHEN jsonb_typeof(${base}) = 'array' THEN ${base} ELSE '[]'::jsonb END) = $${params.length}`;
        }
        if (val.$elemMatch !== undefined) {
            const inner = elemConds(params, alias, elemMeta, restSegs, val.$elemMatch);
            return existsExpr(base, alias, inner);
        }
        if (val.$all !== undefined) {
            const conds = (val.$all || []).map((v) => {
                const inner = elemConds(params, alias, elemMeta, restSegs, v);
                return existsExpr(base, alias, inner);
            });
            return conds.length ? conds.map((c) => `(${c})`).join(' AND ') : 'TRUE';
        }
        // operators applied to elements ($in etc.)
        const inner = elemOpsConds(params, alias, elemMeta, restSegs, val);
        return existsExpr(base, alias, inner);
    }
    if (val === null) {
        return `(${base} IS NULL OR jsonb_array_length(COALESCE(${base}, '[]'::jsonb)) = 0)`;
    }
    const inner = elemConds(params, alias, elemMeta, restSegs, val);
    return existsExpr(base, alias, inner);
}

function existsExpr(base, alias, innerCond) {
    return `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${base}) = 'array' THEN ${base} ELSE '[]'::jsonb END) AS ${alias}(v) WHERE ${innerCond})`;
}

// condition on one array element (alias.v), possibly at a deeper path
function elemConds(params, alias, elemMeta, restSegs, val) {
    const leafKind = leafKindOf({ elem: elemMeta }, restSegs);
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date) && !(val instanceof RegExp) && !isOperatorObject(val)) {
        // partial subdocument match: every key matches
        const parts = Object.entries(val).map(([k, v]) => {
            const segs = restSegs.concat(k.split('.'));
            return elemPathCond(params, alias, segs, leafKindOf({ elem: elemMeta }, segs), v);
        });
        return parts.length ? parts.map((p) => `(${p})`).join(' AND ') : 'TRUE';
    }
    if (isOperatorObject(val)) return elemOpsConds(params, alias, elemMeta, restSegs, val);
    return elemPathCond(params, alias, restSegs, leafKind, val);
}

function elemOpsConds(params, alias, elemMeta, restSegs, ops) {
    const leafKind = leafKindOf({ elem: elemMeta }, restSegs);
    const col = `${alias}.v`;
    return jsonOpsCond(params, col, restSegs, leafKind, ops);
}

function elemPathCond(params, alias, segs, leafKind, val) {
    return jsonCond(params, `${alias}.v`, segs, leafKind, val);
}

// ── main entry ──────────────────────────────────────────────────────────────

function fieldCond(parsed, params, path, val) {
    const r = resolvePath(parsed, path);
    if (r.mode === 'unknown') {
        return (val == null) ? 'TRUE' : '(1=0)';
    }
    if (r.mode === 'column') {
        return columnCond(params, qi(r.name), r.kind, val);
    }
    if (r.mode === 'array') {
        return arrayCond(params, r.name, r.meta, r.rest || [], val, r.prefix);
    }
    // json object path
    const leafKind = r.leaf ? r.leaf.kind : 'mixed';
    return jsonCond(params, qi(r.name), r.segs, leafKind, val);
}

function whereClause(parsed, filter, params) {
    if (!filter || typeof filter !== 'object' || Object.keys(filter).length === 0) return 'TRUE';
    const parts = [];
    for (const [key, val] of Object.entries(filter)) {
        if (val === undefined) continue;
        if (key === '$or' || key === '$and' || key === '$nor') {
            const subs = (val || []).map((f) => `(${whereClause(parsed, f, params)})`);
            if (!subs.length) continue;
            if (key === '$or') parts.push(`(${subs.join(' OR ')})`);
            else if (key === '$and') parts.push(`(${subs.join(' AND ')})`);
            else parts.push(`(NOT (${subs.join(' OR ')}))`);
        } else if (key === '$text') {
            const q = val && val.$search ? String(val.$search) : '';
            const fields = parsed.textFields.length ? parsed.textFields : [];
            if (!q || !fields.length) { parts.push('TRUE'); continue; }
            params.push(`%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
            const n = params.length;
            parts.push(`(${fields.map((f) => `${qi(f)} ILIKE $${n}`).join(' OR ')})`);
        } else if (key.startsWith('$')) {
            parts.push('TRUE');
        } else {
            parts.push(fieldCond(parsed, params, key, val));
        }
    }
    return parts.length ? parts.join(' AND ') : 'TRUE';
}

// ── ORDER BY ────────────────────────────────────────────────────────────────

function normalizeSort(sort) {
    if (!sort) return [];
    if (typeof sort === 'string') {
        return sort.split(/\s+/).filter(Boolean).map((s) => (
            s.startsWith('-') ? [s.slice(1), -1] : [s, 1]
        ));
    }
    return Object.entries(sort).map(([k, v]) => [k, (v === -1 || v === '-1' || v === 'desc' || v === 'descending') ? -1 : 1]);
}

function orderClause(parsed, sort) {
    const norm = normalizeSort(sort);
    if (!norm.length) return '';
    const parts = [];
    for (const [path, dir] of norm) {
        const r = resolvePath(parsed, path);
        const d = dir === -1 ? 'DESC' : 'ASC';
        if (r.mode === 'column') parts.push(`${qi(r.name)} ${d}`);
        else if (r.mode === 'json') {
            const expr = jsonPathExpr(qi(r.name), r.segs, true);
            const kind = r.leaf ? r.leaf.kind : 'mixed';
            parts.push(kind === 'number' ? `(${expr})::numeric ${d}` : `${expr} ${d}`);
        }
        // unknown/array sort keys are skipped
    }
    return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
}

// Translate a projection select spec into a concrete SQL column list,
// or null when the spec can't be pushed down safely (mixed include/exclude,
// a dotted/nested path, or explicit `_id` exclusion) — callers fall back to
// `SELECT *` and prune in JS exactly as before. Purely an I/O optimization:
// the JS-side pruneSelect() still runs afterward and is idempotent, so a
// bug here degrades to "no smaller resultset", never wrong data.
function buildSelectColumns(parsed, select) {
    if (!select) return null;
    let include = [];
    let exclude = [];
    if (typeof select === 'string') {
        for (const tok of select.split(/\s+/).filter(Boolean)) {
            if (tok.startsWith('-')) exclude.push(tok.slice(1));
            else if (tok.startsWith('+')) include.push(tok.slice(1));
            else include.push(tok);
        }
    } else if (typeof select === 'object' && !Array.isArray(select)) {
        for (const [k, v] of Object.entries(select)) {
            if (v) include.push(k); else exclude.push(k);
        }
    } else {
        return null;
    }
    if (include.length && exclude.length) return null;
    if ([...include, ...exclude].some((p) => p.includes('.') || p === '_id')) return null;

    const allFields = Object.keys(parsed.fields);
    let cols;
    if (include.length) cols = include.filter((f) => allFields.includes(f));
    else if (exclude.length) { const ex = new Set(exclude); cols = allFields.filter((f) => !ex.has(f)); }
    else return null;

    return ['_id', ...cols];
}

module.exports = { whereClause, orderClause, normalizeSort, qi, resolvePath, buildSelectColumns };
