'use strict';
// Schema definition layer for the PostgreSQL data mapper.
// Top-level scalar/ref fields become typed columns; nested objects, arrays and
// JSON fields become JSONB. Row ids are UUIDs stored as plain strings.

const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const newId = () => crypto.randomUUID();
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// Column type tokens exposed as Schema.Types.* (e.g. Types.UUID, Types.JSON).
function UuidType(v) { return v == null ? v : String(v); }
UuidType.schemaName = 'UUID';
const JsonType = { schemaName: 'JSON' };
const Types = { UUID: UuidType, JSON: JsonType, String, Number, Boolean, Date };

function isTypeToken(t) {
    return t === String || t === Number || t === Boolean || t === Date ||
           t === UuidType || t === JsonType || t === Object || t === Array ||
           t === Buffer;
}

class Schema {
    constructor(def, options = {}) {
        this.def = def;
        this.options = options || {};
        this.methods = {};
        this.statics = {};
        this._indexes = [];
        this._preSave = [];
        this._virtuals = {};
        this._parsedCache = null;
    }
    index(fields, opts = {}) { this._indexes.push({ fields, opts }); return this; }
    pre(event, fn) { if (event === 'save') this._preSave.push(fn); return this; }
    post() { return this; }
    plugin() { return this; }
    virtual(name) {
        const v = { getter: null, setter: null };
        this._virtuals[name] = v;
        const builder = {
            get(fn) { v.getter = fn; return builder; },
            set(fn) { v.setter = fn; return builder; },
        };
        return builder;
    }
    set(k, v) { this.options[k] = v; return this; }
    get(k) { return this.options[k]; }
    parsed() {
        if (!this._parsedCache) this._parsedCache = parseSchema(this);
        return this._parsedCache;
    }
}
Schema.Types = Types;

// ── Parsing ──────────────────────────────────────────────────────────────────
// meta: { kind, ref?, array?, elem?, children?, idFalse?, default?, enum?,
//         required?, unique?, sparse?, lowercase?, trim?, singleIndex?, hasDates? }

function parseType(t) {
    if (t === String) return { kind: 'string' };
    if (t === Number) return { kind: 'number' };
    if (t === Boolean) return { kind: 'boolean' };
    if (t === Date) return { kind: 'date' };
    if (t === UuidType) return { kind: 'id' };
    if (t === JsonType || t === Object || t === Buffer) return { kind: 'mixed' };
    if (t === Array) return { kind: 'json', array: true, elem: { kind: 'mixed' } };
    if (Array.isArray(t)) {
        if (t.length === 0) return { kind: 'json', array: true, elem: { kind: 'mixed' } };
        return { kind: 'json', array: true, elem: parseFieldDef(t[0]) };
    }
    if (t instanceof Schema) {
        const sub = parseChildren(t.def);
        return { kind: 'json', children: sub.children, idFalse: t.options && t.options._id === false, hasDates: sub.hasDates };
    }
    if (t && typeof t === 'object') return null; // caller decides (options form vs nested)
    return { kind: 'mixed' };
}

function parseFieldDef(def) {
    // direct type token / array / sub-schema
    const direct = parseType(def);
    if (direct) return direct;

    // def is a plain object: options form ({type: X, ...}) or nested subdocument
    if ('type' in def && (isTypeToken(def.type) || Array.isArray(def.type) || def.type instanceof Schema)) {
        const meta = parseType(def.type) || { kind: 'mixed' };
        if (def.ref) meta.ref = def.ref;
        if (meta.array && meta.elem && meta.elem.kind === 'id' && !meta.elem.ref && def.ref) meta.elem.ref = def.ref;
        for (const k of ['default', 'enum', 'required', 'unique', 'sparse', 'lowercase', 'trim']) {
            if (def[k] !== undefined) meta[k] = def[k];
        }
        if (def.index === true) meta.singleIndex = true;
        return meta;
    }
    // nested subdocument object
    const sub = parseChildren(def);
    return { kind: 'json', children: sub.children, idFalse: def._id === false, hasDates: sub.hasDates };
}

function parseChildren(defObj) {
    const children = {};
    let hasDates = false;
    for (const [k, v] of Object.entries(defObj)) {
        if (k === '_id') continue; // `_id: false` marker handled by caller
        const meta = parseFieldDef(v);
        children[k] = meta;
        if (metaHasDates(meta)) hasDates = true;
    }
    return { children, hasDates };
}

function metaHasDates(meta) {
    if (!meta) return false;
    if (meta.kind === 'date') return true;
    if (meta.hasDates) return true;
    if (meta.elem && metaHasDates(meta.elem)) return true;
    if (meta.children) return Object.values(meta.children).some(metaHasDates);
    return false;
}

function parseSchema(schema) {
    const fields = {};
    for (const [name, def] of Object.entries(schema.def)) {
        if (name === '_id') continue;
        fields[name] = parseFieldDef(def);
    }
    if (schema.options.timestamps) {
        if (!fields.createdAt) fields.createdAt = { kind: 'date', _auto: 'created' };
        if (!fields.updatedAt) fields.updatedAt = { kind: 'date', _auto: 'updated' };
        fields.createdAt._ts = true;
        fields.updatedAt._ts = schema.options.timestamps ? true : undefined;
    }

    // ref paths for populate: 'a' -> 'Model', 'a.b' -> 'Model' (arrays are transparent)
    const refPaths = {};
    const walkRefs = (meta, prefix) => {
        if (!meta) return;
        if (meta.kind === 'id' && meta.ref) refPaths[prefix] = meta.ref;
        if (meta.array && meta.elem) {
            if (meta.elem.kind === 'id' && (meta.elem.ref || meta.ref)) refPaths[prefix] = meta.elem.ref || meta.ref;
            walkRefs(meta.elem, prefix); // subdoc arrays: path stays the same
        }
        if (meta.children) {
            for (const [k, m] of Object.entries(meta.children)) {
                walkRefs(m, prefix ? `${prefix}.${k}` : k);
            }
        }
        if (meta.elem && meta.elem.children) {
            for (const [k, m] of Object.entries(meta.elem.children)) {
                walkRefs(m, prefix ? `${prefix}.${k}` : k);
            }
        }
    };
    for (const [name, meta] of Object.entries(fields)) walkRefs(meta, name);

    // text index fields (for $text -> ILIKE)
    const textFields = [];
    for (const { fields: f } of schema._indexes) {
        for (const [k, v] of Object.entries(f)) if (v === 'text') textFields.push(k);
    }

    return {
        fields,
        refPaths,
        textFields,
        indexes: schema._indexes,
        preSave: schema._preSave,
        virtuals: schema._virtuals,
        methods: schema.methods,
        statics: schema.statics,
        options: schema.options,
        jsonVirtuals: !!(schema.options.toJSON && schema.options.toJSON.virtuals),
    };
}

// ── Value casting: JS -> row (write) and row -> JS (read) ────────────────────

function extractId(v) {
    if (v == null) return null;
    if (typeof v === 'object') {
        if (v._id !== undefined) return String(v._id);
        return String(v);
    }
    return String(v);
}

function deepPlain(v) {
    if (v == null) return v;
    if (v instanceof Date) return v;
    if (Array.isArray(v)) return v.map(deepPlain);
    if (typeof v === 'object') {
        if (typeof v.toObject === 'function') return v.toObject();
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            if (typeof val === 'function' || val === undefined) continue;
            out[k] = deepPlain(val);
        }
        return out;
    }
    return v;
}

// Cast a JSONB-bound value according to meta (extract ids from populated docs,
// assign subdocument _ids, keep Dates so JSON.stringify makes ISO strings).
function castJsonValue(meta, v) {
    if (v == null) return v;
    if (meta && meta.kind === 'id') return extractId(v);
    if (meta && meta.kind === 'date') return v instanceof Date ? v : new Date(v);
    if (meta && meta.array) {
        const arr = Array.isArray(v) ? v : [v];
        return arr.map((el) => {
            let out = castJsonValue(meta.elem, el);
            // auto _id for embedded subdocument array elements
            if (out && typeof out === 'object' && !Array.isArray(out) && !(out instanceof Date) &&
                meta.elem && meta.elem.children && !meta.elem.idFalse) {
                if (!out._id) out = { _id: newId(), ...out };
            }
            return out;
        });
    }
    if (meta && meta.children && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            if (val === undefined || typeof val === 'function') continue;
            out[k] = castJsonValue(meta.children[k], val);
        }
        // apply defaults to embedded subdocument fields
        for (const [k, m] of Object.entries(meta.children)) {
            if (out[k] === undefined && m && m.default !== undefined) {
                const d = typeof m.default === 'function' ? m.default() : m.default;
                out[k] = castJsonValue(m, d != null && typeof d === 'object' ? JSON.parse(JSON.stringify(d)) : d);
            }
        }
        return out;
    }
    return deepPlain(v);
}

// Cast one top-level field for column storage.
function toColumnValue(meta, v) {
    if (v === undefined) return null;
    if (meta.kind === 'string') {
        if (v == null) return null;
        let s = String(v);
        if (meta.trim) s = s.trim();
        if (meta.lowercase) s = s.toLowerCase();
        return s;
    }
    if (meta.kind === 'number') return v == null ? null : Number(v);
    if (meta.kind === 'boolean') return v == null ? null : Boolean(v);
    if (meta.kind === 'date') {
        if (v == null) return null;
        return v instanceof Date ? v : new Date(v);
    }
    if (meta.kind === 'id') {
        const id = extractId(v);
        return id === null ? null : id;
    }
    // json / mixed / arrays -> JSONB (stringified by caller)
    const plain = meta.kind === 'mixed' ? deepPlain(v) : castJsonValue(meta, v);
    return plain === undefined ? null : plain;
}

// Revive ISO date strings inside JSONB values back to Date objects.
function reviveJsonValue(meta, v) {
    if (v == null || !meta) return v;
    if (meta.kind === 'date') {
        return (typeof v === 'string' || typeof v === 'number') ? new Date(v) : v;
    }
    if (meta.array && Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) v[i] = reviveJsonValue(meta.elem, v[i]);
        return v;
    }
    if (meta.children && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, m] of Object.entries(meta.children)) {
            if (v[k] !== undefined) v[k] = reviveJsonValue(m, v[k]);
        }
        return v;
    }
    return v;
}

function reviveRow(parsed, row) {
    if (!row) return row;
    for (const [name, meta] of Object.entries(parsed.fields)) {
        const v = row[name];
        if (v == null) continue;
        if (meta.kind === 'json' && metaHasDates(meta)) reviveJsonValue(meta, v);
        if (meta.kind === 'number' && typeof v === 'string') row[name] = Number(v);
    }
    return row;
}

function defaultForMeta(meta) {
    if (meta.default !== undefined) {
        const d = meta.default;
        let val = (typeof d === 'function') ? d() : d;
        if (val !== null && typeof val === 'object' && !(val instanceof Date)) val = JSON.parse(JSON.stringify(val));
        if (meta.kind === 'date' && typeof val === 'number') val = new Date(val);
        return val;
    }
    if (meta.array) return [];
    if (meta.children) {
        // materialize nested objects from their child defaults
        const out = {};
        for (const [k, m] of Object.entries(meta.children)) {
            const v = defaultForMeta(m);
            if (v !== undefined) out[k] = v;
        }
        return out;
    }
    return undefined;
}

function applyDefaults(parsed, obj) {
    for (const [name, meta] of Object.entries(parsed.fields)) {
        if (obj[name] !== undefined) continue;
        if (meta._auto) continue; // timestamps handled at save
        const val = defaultForMeta(meta);
        if (val !== undefined) obj[name] = val;
    }
    return obj;
}

const PG_TYPE = {
    string: 'text', number: 'double precision', boolean: 'boolean',
    date: 'timestamptz', id: 'uuid', json: 'jsonb', mixed: 'jsonb',
};
function pgType(meta) { return PG_TYPE[meta.kind] || 'jsonb'; }

function pluralize(name) {
    const n = name.toLowerCase();
    if (/[^aeiou]y$/.test(n)) return n.slice(0, -1) + 'ies';
    if (/(s|x|z|ch|sh)$/.test(n)) return n + 'es';
    return n + 's';
}

module.exports = {
    Schema, Types, newId, isUuid, extractId, deepPlain,
    toColumnValue, castJsonValue, reviveRow, reviveJsonValue, applyDefaults,
    pgType, pluralize, metaHasDates,
};
