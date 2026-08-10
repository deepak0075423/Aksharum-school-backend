'use strict';
// Model factory: builds a Model class backed by a Postgres table.

const crypto = require('crypto');
const pool = require('./pool');
const registry = require('./registry');
const { Query } = require('./query');
const { buildDocumentClass } = require('./document');
const { populateDocs } = require('./populate');
const { runPipeline } = require('./aggregate');
const { whereClause, orderClause, qi, resolvePath, buildSelectColumns } = require('./filter');
const { applyUpdate, equalityFields, setPath } = require('./update');
const {
    newId, pluralize, pgType, toColumnValue, reviveRow,
} = require('./schema');

function deepCopy(v) {
    if (v == null) return v;
    if (v instanceof Date) return new Date(v);
    if (Array.isArray(v)) return v.map(deepCopy);
    if (typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) out[k] = deepCopy(x);
        return out;
    }
    return v;
}

function hash8(s) {
    return crypto.createHash('md5').update(s).digest('hex').slice(0, 8);
}

let trgmReady = null;
async function ensureTrgmExtension(run) {
    if (trgmReady) return trgmReady;
    trgmReady = run('CREATE EXTENSION IF NOT EXISTS pg_trgm')
        .then(() => true)
        .catch((e) => { console.warn(`[db] pg_trgm unavailable, substring search will use seq scans: ${e.message}`); return false; });
    return trgmReady;
}

function createModel(name, schema) {
    const parsed = schema.parsed();
    const tableName = pluralize(name);
    const T = qi(tableName);

    const model = {
        modelName: name,
        schema,
        tableName,
        Document: null,
    };

    async function run(sql, params) {
        try {
            return await pool.query(sql, params);
        } catch (e) {
            if (e && e.code === '23505') {
                e.code = 11000; // normalized duplicate-key code checked by controllers
                e.keyPattern = { [e.constraint || 'unique']: 1 };
            }
            throw e;
        }
    }

    model._rawFind = async function (filter, opts = {}) {
        const params = [];
        const where = whereClause(parsed, filter, params);
        const order = orderClause(parsed, opts.sort);
        const cols = opts.select ? buildSelectColumns(parsed, opts.select) : null;
        const selectList = cols ? cols.map(qi).join(', ') : '*';
        let sql = `SELECT ${selectList} FROM ${T} WHERE ${where}${order}`;
        if (opts.limit != null && Number.isFinite(Number(opts.limit))) sql += ` LIMIT ${Number(opts.limit)}`;
        if (opts.skip != null && Number(opts.skip) > 0) sql += ` OFFSET ${Number(opts.skip)}`;
        const { rows } = await run(sql, params);
        for (const r of rows) reviveRow(parsed, r);
        return rows;
    };

    model._count = async function (filter) {
        const params = [];
        const where = whereClause(parsed, filter, params);
        const { rows } = await run(`SELECT COUNT(*)::int AS c FROM ${T} WHERE ${where}`, params);
        return rows[0].c;
    };

    model._distinct = async function (field, filter) {
        const r = resolvePath(parsed, field);
        if (r.mode === 'column') {
            const params = [];
            const where = whereClause(parsed, filter, params);
            const { rows } = await run(`SELECT DISTINCT ${qi(r.name)} AS v FROM ${T} WHERE ${where} AND ${qi(r.name)} IS NOT NULL`, params);
            return rows.map((x) => x.v);
        }
        const rows = await model._rawFind(filter, {});
        const seen = new Set();
        const out = [];
        const segs = field.split('.');
        const collect = (node, i) => {
            if (node == null) return;
            if (Array.isArray(node)) { node.forEach((el) => collect(el, i)); return; }
            if (i === segs.length) {
                const k = JSON.stringify(node);
                if (!seen.has(k)) { seen.add(k); out.push(node); }
                return;
            }
            if (typeof node === 'object') collect(node[segs[i]], i + 1);
        };
        for (const row of rows) collect(row, 0);
        return out;
    };

    model._saveDoc = async function (doc) {
        for (const fn of parsed.preSave) await fn.call(doc);
        const isNew = doc.$isNew !== false;
        if (parsed.fields.updatedAt && parsed.fields.updatedAt._ts) doc.updatedAt = new Date();
        if (isNew && parsed.fields.createdAt && parsed.fields.createdAt._ts && doc.createdAt == null) doc.createdAt = new Date();
        if (!doc._id) doc._id = newId();

        const cols = [];
        const vals = [];
        const params = [];
        for (const [fname, meta] of Object.entries(parsed.fields)) {
            if (doc[fname] === undefined) continue;
            const v = toColumnValue(meta, doc[fname]);
            // reflect normalized scalars (trim/lowercase/Date casts) on the doc
            if (meta.kind === 'string' || meta.kind === 'date' || meta.kind === 'number' || meta.kind === 'id') {
                doc[fname] = v;
            }
            cols.push(qi(fname));
            if (meta.kind === 'json' || meta.kind === 'mixed') {
                params.push(v == null ? null : JSON.stringify(v));
                vals.push(`$${params.length}::jsonb`);
            } else {
                params.push(v);
                vals.push(`$${params.length}`);
            }
        }

        if (isNew) {
            params.push(String(doc._id));
            const sql = `INSERT INTO ${T} (${['"_id"', ...cols].join(', ')}) VALUES (${[`$${params.length}::uuid`, ...vals].join(', ')})`;
            await run(sql, params);
            doc.$isNew = false;
        } else {
            if (!cols.length) return doc;
            const sets = cols.map((c, i) => `${c} = ${vals[i]}`);
            params.push(String(doc._id));
            const sql = `UPDATE ${T} SET ${sets.join(', ')} WHERE "_id" = $${params.length}::uuid`;
            await run(sql, params);
        }
        return doc;
    };

    model._findOneAndUpdate = async function (filter, update, options = {}) {
        const rows = await model._rawFind(filter, { sort: options.sort, limit: 1 });
        if (rows.length) {
            const before = options.new === false ? deepCopy(rows[0]) : null;
            const doc = new model.Document(rows[0], { fromDb: true });
            applyUpdate(doc, update || {});
            await doc.save();
            return options.new === false ? before : doc.toObject();
        }
        if (!options.upsert) return null;
        const base = equalityFields(filter);
        const doc = new model.Document(base, {});
        applyUpdate(doc, update || {});
        if (update && update.$setOnInsert) {
            for (const [p, v] of Object.entries(update.$setOnInsert)) setPath(doc, p, v);
        }
        await doc.save();
        return options.new === false ? null : doc.toObject();
    };

    model._findOneAndDelete = async function (filter, opts = {}) {
        const rows = await model._rawFind(filter, { sort: opts.sort, limit: 1 });
        if (!rows.length) return null;
        await run(`DELETE FROM ${T} WHERE "_id" = $1::uuid`, [String(rows[0]._id)]);
        return rows[0];
    };

    model._populate = (docs, specs) => populateDocs(model, docs, specs);

    // ── the exported Model class (constructible: new Model(doc)) ──────────────
    const Model = buildDocumentClass(model);
    model.Document = Model;

    Model.modelName = name;
    Model.tableName = tableName;
    Model.collection = { name: tableName };
    Model.schema = schema;
    Model._rawFind = model._rawFind;

    Model.find = (filter, projection) => new Query(model, 'find', filter, { projection });
    Model.findOne = (filter, projection) => new Query(model, 'findOne', filter, { projection });
    Model.findById = (id, projection) => new Query(model, 'findOne', { _id: id == null ? '__null__' : id }, { projection });
    Model.countDocuments = (filter) => new Query(model, 'count', filter);
    Model.estimatedDocumentCount = () => new Query(model, 'count', {});
    Model.distinct = (field, filter) => new Query(model, 'distinct', filter, { fieldName: field });
    Model.exists = async (filter) => {
        const rows = await model._rawFind(filter, { limit: 1 });
        return rows.length ? { _id: rows[0]._id } : null;
    };

    Model.create = async function (data, opts) {
        if (Array.isArray(data)) {
            const out = [];
            for (const d of data) out.push(await Model.create(d, opts));
            return out;
        }
        const doc = new Model(data, {});
        await doc.save();
        return doc;
    };

    Model.insertMany = async function (arr, opts) {
        const out = [];
        for (const d of (arr || [])) out.push(await Model.create(d, opts));
        return out;
    };

    Model.findOneAndUpdate = (filter, update, options) => new Query(model, 'findOneAndUpdate', filter, { update, options });
    Model.findByIdAndUpdate = (id, update, options) => new Query(model, 'findOneAndUpdate', { _id: id == null ? '__null__' : id }, { update, options });
    Model.findOneAndDelete = (filter, options) => new Query(model, 'findOneAndDelete', filter, { options });
    Model.findByIdAndDelete = (id, options) => new Query(model, 'findOneAndDelete', { _id: id == null ? '__null__' : id }, { options });
    Model.findByIdAndRemove = Model.findByIdAndDelete;

    Model.updateOne = async function (filter, update, options = {}) {
        const rows = await model._rawFind(filter, { limit: 1 });
        if (!rows.length) {
            if (options.upsert) {
                const res = await model._findOneAndUpdate(filter, update, { upsert: true, new: true });
                return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: res ? res._id : null };
            }
            return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
        }
        const doc = new Model(rows[0], { fromDb: true });
        applyUpdate(doc, update || {});
        await doc.save();
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    };

    Model.updateMany = async function (filter, update, options = {}) {
        const rows = await model._rawFind(filter, {});
        if (!rows.length && options.upsert) {
            await model._findOneAndUpdate(filter, update, { upsert: true, new: true });
            return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        for (const row of rows) {
            const doc = new Model(row, { fromDb: true });
            applyUpdate(doc, update || {});
            await doc.save();
        }
        return { acknowledged: true, matchedCount: rows.length, modifiedCount: rows.length };
    };

    Model.deleteOne = async function (filter) {
        const params = [];
        const where = whereClause(parsed, filter, params);
        const res = await run(`DELETE FROM ${T} WHERE "_id" IN (SELECT "_id" FROM ${T} WHERE ${where} LIMIT 1)`, params);
        return { acknowledged: true, deletedCount: res.rowCount };
    };

    Model.deleteMany = async function (filter) {
        const params = [];
        const where = whereClause(parsed, filter, params);
        const res = await run(`DELETE FROM ${T} WHERE ${where}`, params);
        return { acknowledged: true, deletedCount: res.rowCount };
    };

    Model.aggregate = function (pipeline) {
        const p = runPipeline(model, pipeline);
        p.exec = () => p;
        return p;
    };

    Model.bulkWrite = async function (ops) {
        let modified = 0; let inserted = 0; let deleted = 0;
        for (const op of (ops || [])) {
            if (op.updateOne) {
                const r = await Model.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: !!op.updateOne.upsert });
                modified += r.modifiedCount || 0;
            } else if (op.updateMany) {
                const r = await Model.updateMany(op.updateMany.filter, op.updateMany.update, { upsert: !!op.updateMany.upsert });
                modified += r.modifiedCount || 0;
            } else if (op.insertOne) {
                await Model.create(op.insertOne.document); inserted++;
            } else if (op.deleteOne) {
                const r = await Model.deleteOne(op.deleteOne.filter); deleted += r.deletedCount;
            } else if (op.deleteMany) {
                const r = await Model.deleteMany(op.deleteMany.filter); deleted += r.deletedCount;
            }
        }
        return { ok: 1, modifiedCount: modified, insertedCount: inserted, deletedCount: deleted };
    };

    Model.hydrate = (row) => new Model(row, { fromDb: true });
    Model.watch = () => ({ on() {}, close() {} });
    Model.populate = async (docs, specs) => { await populateDocs(model, Array.isArray(docs) ? docs : [docs], specs); return docs; };
    Model.syncIndexes = async () => Model.ensureTable();

    // ── DDL ─────────────────────────────────────────────────────────────────
    Model.ensureTable = async function () {
        const colDefs = ['"_id" uuid PRIMARY KEY'];
        for (const [fname, meta] of Object.entries(parsed.fields)) {
            colDefs.push(`${qi(fname)} ${pgType(meta)}`);
        }
        await run(`CREATE TABLE IF NOT EXISTS ${T} (${colDefs.join(', ')})`);

        const { rows: existing } = await run(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
            [tableName],
        );
        const have = new Set(existing.map((r) => r.column_name));
        for (const [fname, meta] of Object.entries(parsed.fields)) {
            if (!have.has(fname)) {
                await run(`ALTER TABLE ${T} ADD COLUMN ${qi(fname)} ${pgType(meta)}`);
            }
        }

        // single-field unique / index options
        for (const [fname, meta] of Object.entries(parsed.fields)) {
            try {
                if (meta.unique) {
                    await run(`CREATE UNIQUE INDEX IF NOT EXISTS ${qi(`ux_${tableName}_${fname}`.slice(0, 60))} ON ${T} (${qi(fname)})`);
                } else if (meta.singleIndex) {
                    await run(`CREATE INDEX IF NOT EXISTS ${qi(`ix_${tableName}_${fname}`.slice(0, 60))} ON ${T} (${qi(fname)})`);
                }
            } catch (e) {
                console.warn(`[db] index on ${tableName}.${fname} skipped: ${e.message}`);
            }
        }

        // Auto-index every top-level ref (UUID) column and the createdAt
        // timestamp. Ref columns are exactly what populate() and virtually
        // every WHERE/filter in this app key on (school, user, teacher,
        // student, class, section, parent, ...); createdAt backs the default
        // "-createdAt" sort used across list/dashboard endpoints. Purely
        // additive DDL — no behavior change, just query-plan speedups.
        for (const [fname, meta] of Object.entries(parsed.fields)) {
            if (meta.unique || meta.singleIndex) continue; // already indexed above
            const wantsAutoIndex = meta.kind === 'id' || (meta.kind === 'date' && meta._ts === true && fname === 'createdAt');
            if (!wantsAutoIndex) continue;
            try {
                await run(`CREATE INDEX IF NOT EXISTS ${qi(`ix_${tableName}_${fname}`.slice(0, 60))} ON ${T} (${qi(fname)})`);
            } catch (e) {
                console.warn(`[db] auto-index on ${tableName}.${fname} skipped: ${e.message}`);
            }
        }

        // Trigram GIN indexes on name/email — these are exactly the columns
        // hit by the `{name: /search/i}` / `$or` substring search used across
        // every admin list page. A plain B-tree can't accelerate `~*`/ILIKE
        // substring matches; a trigram index can.
        if (parsed.fields.name?.kind === 'string' || parsed.fields.email?.kind === 'string') {
            const trgmOk = await ensureTrgmExtension(run);
            if (trgmOk) {
                for (const fname of ['name', 'email']) {
                    if (parsed.fields[fname]?.kind !== 'string') continue;
                    try {
                        await run(`CREATE INDEX IF NOT EXISTS ${qi(`ix_${tableName}_${fname}_trgm`.slice(0, 60))} ON ${T} USING GIN (${qi(fname)} gin_trgm_ops)`);
                    } catch (e) {
                        console.warn(`[db] trigram index on ${tableName}.${fname} skipped: ${e.message}`);
                    }
                }
            }
        }

        // schema.index(...) definitions
        for (const { fields: f, opts } of parsed.indexes) {
            const entries = Object.entries(f).filter(([, v]) => v !== 'text');
            if (!entries.length) continue;
            const exprs = [];
            let skip = false;
            for (const [path] of entries) {
                const r = resolvePath(parsed, path);
                if (r.mode === 'column') exprs.push(qi(r.name));
                else if (r.mode === 'json') exprs.push(`((${qi(r.name)} #>> '{${r.segs.join(',')}}'))`);
                else { skip = true; break; }
            }
            if (skip || !exprs.length) continue;
            const unique = opts && opts.unique;
            const idxName = `${unique ? 'ux' : 'ix'}_${tableName}_${hash8(JSON.stringify(f))}`;
            try {
                await run(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${qi(idxName)} ON ${T} (${exprs.join(', ')})`);
            } catch (e) {
                console.warn(`[db] index ${idxName} on ${tableName} skipped: ${e.message}`);
            }
        }
    };

    // internal aliases used by the Document class
    model.deleteOne = (...args) => Model.deleteOne(...args);

    registry.register(name, Model);
    return Model;
}

module.exports = { createModel };
