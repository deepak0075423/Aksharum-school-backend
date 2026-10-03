'use strict';
/**
 * Write only the named columns of one row, in one SQL statement.
 *
 * The ORM's save(), updateOne() and findOneAndUpdate() all read a row and then
 * write EVERY column back from that copy. Two writers that overlap therefore
 * undo each other: an office edit that started before a teacher's last marks
 * sheet arrived wrote the exam's old status back over "every subject is in",
 * and the history entry that step had appended vanished with it.
 *
 * patch() writes nothing it was not given, can refuse to write unless the row
 * still says what the caller read (`where` — compare-and-set), appends to a
 * JSON array column without reading it (`push`), and hands back the row as it
 * now is, or null when no row matched.
 *
 *   patch(Model, id, { status: 'SUBMITTED' }, {
 *       where: { status: ['MARKS_PENDING', 'REOPENED'], archivedAt: null },
 *       push:  { auditLog: entry },
 *       q,                       // a transaction's query function (optional)
 *   })
 */
const pool = require('./pool');
const { toColumnValue, reviveRow } = require('./schema');

const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;
const JSONISH = new Set(['json', 'mixed']);

function fieldsOf(Model) {
    const parsed = Model.schema.parsed();
    return { parsed, fields: parsed.fields };
}

/** `"col" = $n` for one value, typed the way the ORM writes it. */
function bindValue(meta, value, params) {
    const v = toColumnValue(meta, value);
    if (JSONISH.has(meta.kind) || !meta.kind) {
        params.push(v == null ? null : JSON.stringify(v));
        return `$${params.length}::jsonb`;
    }
    params.push(v);
    if (meta.kind === 'id') return `$${params.length}::uuid`;
    return `$${params.length}`;
}

/** One guard: equality, membership in a list, or IS NULL / IS NOT NULL. */
function guard(name, meta, want, params) {
    const col = qi(name);
    if (want === null) return `${col} IS NULL`;
    if (want && typeof want === 'object' && !Array.isArray(want) && want.$ne === null) return `${col} IS NOT NULL`;
    if (Array.isArray(want)) {
        params.push(want.map((w) => (w == null ? null : String(w))));
        const cast = meta?.kind === 'id' ? 'uuid[]' : 'text[]';
        return `${col}${meta?.kind === 'id' ? '' : '::text'} = ANY($${params.length}::${cast})`;
    }
    if (meta?.kind === 'id') { params.push(String(want)); return `${col} = $${params.length}::uuid`; }
    if (meta?.kind === 'number') { params.push(Number(want)); return `${col} = $${params.length}`; }
    if (meta?.kind === 'boolean') { params.push(!!want); return `${col} = $${params.length}`; }
    if (meta?.kind === 'date') { params.push(want instanceof Date ? want : new Date(want)); return `${col} = $${params.length}`; }
    params.push(String(want));
    return `${col}::text = $${params.length}`;
}

async function patch(Model, id, set = {}, { where = {}, push = {}, q = null, touch = true } = {}) {
    const { parsed, fields } = fieldsOf(Model);
    const params = [String(id)];
    const sets = [];
    for (const [name, value] of Object.entries(set || {})) {
        if (value === undefined) continue;
        const meta = fields[name];
        if (!meta) throw new Error(`patch: ${Model.modelName} has no field "${name}"`);
        sets.push(`${qi(name)} = ${bindValue(meta, value, params)}`);
    }
    for (const [name, entries] of Object.entries(push || {})) {
        if (entries === undefined || entries === null) continue;
        const meta = fields[name];
        if (!meta) throw new Error(`patch: ${Model.modelName} has no field "${name}"`);
        const list = Array.isArray(entries) ? entries : [entries];
        if (!list.length) continue;
        params.push(JSON.stringify(list));
        sets.push(`${qi(name)} = (CASE WHEN jsonb_typeof(${qi(name)}) = 'array' THEN ${qi(name)} ELSE '[]'::jsonb END) || $${params.length}::jsonb`);
    }
    if (touch && fields.updatedAt && set.updatedAt === undefined) sets.push(`"updatedAt" = now()`);
    if (!sets.length) throw new Error('patch: nothing to write');

    const guards = [`"_id" = $1::uuid`];
    for (const [name, want] of Object.entries(where || {})) {
        if (want === undefined) continue;
        guards.push(guard(name, fields[name], want, params));
    }
    const run = q || ((sql, p) => pool.query(sql, p));
    const res = await run(
        `UPDATE "${Model.tableName}" SET ${sets.join(', ')} WHERE ${guards.join(' AND ')} RETURNING *`, params);
    const row = res.rows[0] || null;
    if (row) reviveRow(parsed, row);
    return row;
}

/**
 * Insert a new row — the ORM's create(), but through `q` when given, so it
 * can be one step of a transaction (several exams created together, or none).
 * `data` gets the model's defaults, exactly as new Model(data) would.
 */
async function insert(Model, data, { q = null } = {}) {
    const { parsed, fields } = fieldsOf(Model);
    const doc = data instanceof Model ? data : new Model(data);
    for (const fn of parsed.preSave || []) await fn.call(doc);
    if (!doc._id) doc._id = require('./schema').newId();
    if (fields.createdAt && doc.createdAt == null) doc.createdAt = new Date();
    if (fields.updatedAt && doc.updatedAt == null) doc.updatedAt = new Date();
    const cols = ['"_id"']; const vals = ['$1::uuid']; const params = [String(doc._id)];
    for (const [name, meta] of Object.entries(fields)) {
        if (doc[name] === undefined) continue;
        cols.push(qi(name));
        vals.push(bindValue(meta, doc[name], params));
    }
    const run = q || ((sql, p) => pool.query(sql, p));
    await run(`INSERT INTO "${Model.tableName}" (${cols.join(', ')}) VALUES (${vals.join(', ')})`, params);
    doc.$isNew = false;
    return doc;
}

module.exports = { patch, insert };
