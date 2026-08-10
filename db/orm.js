'use strict';
// PostgreSQL data mapper — the single entry point every model imports.
// Exposes Schema/model plus connection helpers over the pg connection pool.

const pool = require('./pool');
const registry = require('./registry');
const { createModel } = require('./model');
const { Schema, Types, isUuid, newId } = require('./schema');

const orm = {
    Schema,
    Types,

    model(name, schema) {
        if (!schema) {
            const existing = registry.get(name);
            if (!existing) throw new Error(`Model "${name}" is not registered`);
            return existing;
        }
        const existing = registry.get(name);
        if (existing) return existing;
        return createModel(name, schema);
    },

    get models() { return registry.models; },

    isValidId: (v) => isUuid(String(v)),

    async connect() {
        await pool.query('SELECT 1');
        return orm;
    },

    async disconnect() { await pool.end(); },

    async syncAll() {
        for (const Model of registry.all()) {
            await Model.ensureTable();
        }
    },

    connection: {
        get readyState() { return 1; },
        host: 'postgresql',
        close: () => pool.end(),
    },

    set() { /* global ORM options: no-op */ },
    newId,
};

module.exports = orm;
