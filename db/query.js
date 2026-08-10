'use strict';
// Chainable, awaitable query object over a Postgres table.

const { populateDocs, pruneSelect } = require('./populate');

class Query {
    constructor(model, kind, filter, extra = {}) {
        this.model = model;
        this.kind = kind;              // find | findOne | findOneAndUpdate | findOneAndDelete | count | distinct
        this.filter = filter || {};
        this.update = extra.update;
        this.options = extra.options || {};
        this.fieldName = extra.fieldName;
        this._sort = extra.sort || null;
        this._limit = null;
        this._skip = null;
        this._select = extra.projection || null;
        this._populate = [];
        this._lean = false;
    }

    sort(s) { this._sort = s; return this; }
    limit(n) { this._limit = Number(n); return this; }
    skip(n) { this._skip = Number(n); return this; }
    select(s) { this._select = s; return this; }
    lean(v = true) { this._lean = !!v; return this; }
    session() { return this; }
    setOptions(o) { Object.assign(this.options, o || {}); return this; }
    populate(pathOrSpec, select) {
        if (typeof pathOrSpec === 'string' && select !== undefined) {
            this._populate.push({ path: pathOrSpec, select });
        } else if (pathOrSpec) {
            this._populate.push(pathOrSpec);
        }
        return this;
    }
    countDocuments() { this.kind = 'count'; return this; }
    distinct(field) { this.kind = 'distinct'; this.fieldName = field; return this; }

    exec() { return this._run(); }
    then(res, rej) { return this._run().then(res, rej); }
    catch(fn) { return this._run().catch(fn); }
    finally(fn) { return this._run().finally(fn); }

    async _finishRows(rows) {
        if (this._populate.length) await populateDocs(this.model, rows, this._populate);
        if (this._select) for (const r of rows) pruneSelect(r, this._select);
        if (this._lean) return rows;
        return rows.map((r) => new this.model.Document(r, { fromDb: true }));
    }

    async _finishRow(row) {
        if (!row) return null;
        const [out] = await this._finishRows([row]);
        return out;
    }

    async _run() {
        if (this._promise) return this._promise;
        this._promise = this._execute();
        return this._promise;
    }

    async _execute() {
        const m = this.model;
        switch (this.kind) {
            case 'find': {
                // Only push the projection to SQL when nothing downstream needs the
                // full row: populate() may need ref columns not in the select list.
                const select = this._populate.length ? null : this._select;
                const rows = await m._rawFind(this.filter, { sort: this._sort, limit: this._limit, skip: this._skip, select });
                return this._finishRows(rows);
            }
            case 'findOne': {
                const select = this._populate.length ? null : this._select;
                const rows = await m._rawFind(this.filter, { sort: this._sort, limit: 1, skip: this._skip, select });
                return this._finishRow(rows[0] || null);
            }
            case 'findOneAndUpdate': {
                const row = await m._findOneAndUpdate(this.filter, this.update, { ...this.options, sort: this._sort });
                return this._finishRow(row);
            }
            case 'findOneAndDelete': {
                const row = await m._findOneAndDelete(this.filter, { sort: this._sort });
                return this._finishRow(row);
            }
            case 'count':
                return m._count(this.filter);
            case 'distinct':
                return m._distinct(this.fieldName, this.filter);
            default:
                throw new Error(`Unsupported query kind: ${this.kind}`);
        }
    }
}

module.exports = { Query };
