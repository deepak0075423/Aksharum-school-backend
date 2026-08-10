'use strict';
// Per-model Document class factory (active-record style row wrapper).

const { deepPlain, applyDefaults } = require('./schema');

function buildDocumentClass(model) {
    const parsed = model.schema.parsed();

    class Document {
        constructor(data = {}, opts = {}) {
            const fromDb = !!opts.fromDb;
            Object.defineProperty(this, '$isNew', { value: !fromDb, writable: true, enumerable: false, configurable: true });
            const src = (data && typeof data.toObject === 'function') ? data.toObject() : data;
            if (fromDb) {
                Object.assign(this, src);
            } else {
                const plain = {};
                for (const [k, v] of Object.entries(src || {})) {
                    if (v === undefined) continue;
                    plain[k] = v;
                }
                applyDefaults(parsed, plain);
                Object.assign(this, plain);
            }
        }

        get isNew() { return this.$isNew; }

        async save() {
            await model._saveDoc(this);
            return this;
        }

        toObject() {
            const out = {};
            for (const [k, v] of Object.entries(this)) out[k] = deepPlain(v);
            return out;
        }

        toJSON() {
            const out = this.toObject();
            if (parsed.jsonVirtuals) {
                for (const name of Object.keys(parsed.virtuals)) {
                    const v = parsed.virtuals[name];
                    if (v.getter) {
                        try { out[name] = v.getter.call(this); } catch (_e) { /* ignore */ }
                    }
                }
                out.id = String(this._id);
            }
            return out;
        }

        async populate(pathOrSpec, select) {
            await model._populate([this], normalizeDocPopulate(pathOrSpec, select));
            return this;
        }

        markModified() { /* no-op: full-row writes */ }

        async deleteOne() {
            return model.deleteOne({ _id: this._id });
        }

        // legacy alias
        async remove() { return this.deleteOne(); }

        get id() { return this._id == null ? this._id : String(this._id); }
    }

    // schema instance methods
    for (const [name, fn] of Object.entries(parsed.methods || {})) {
        Document.prototype[name] = fn;
    }
    // virtual getters/setters (non-enumerable, prototype level)
    for (const [name, v] of Object.entries(parsed.virtuals || {})) {
        Object.defineProperty(Document.prototype, name, {
            get: v.getter || undefined,
            set: v.setter || undefined,
            enumerable: false,
            configurable: true,
        });
    }

    Object.defineProperty(Document, 'name', { value: `${model.modelName}Document` });
    return Document;
}

function normalizeDocPopulate(pathOrSpec, select) {
    if (typeof pathOrSpec === 'string' && select !== undefined) {
        return [{ path: pathOrSpec, select }];
    }
    return pathOrSpec;
}

module.exports = { buildDocumentClass };
