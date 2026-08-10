'use strict';
// Central registry of models so populate/$lookup can resolve refs without circular requires.

const models = {};        // modelName -> Model
const byTableName = {};   // table name -> Model

function register(name, model) {
    models[name] = model;
    byTableName[model.tableName] = model;
}

function get(name) { return models[name] || null; }
function byTable(table) { return byTableName[table] || null; }
function all() { return Object.values(models); }

module.exports = { register, get, byTable, all, models };
