const fs = require('fs');
const path = require('path');
const orm = require('../db/orm');
const { runMigrations } = require('../db/migrate');

const connectDB = async () => {
    try {
        await orm.connect();
        // Register every model, then sync tables/indexes.
        const modelsDir = path.join(__dirname, '../models');
        for (const file of fs.readdirSync(modelsDir)) {
            if (file.endsWith('.js')) require(path.join(modelsDir, file));
        }
        await orm.syncAll();
        // syncAll only ever adds; anything that has to be dropped or rebuilt is
        // named in db/migrate.js and applied here, after the tables exist.
        await runMigrations();
        console.log('PostgreSQL connected, schema synced');
    } catch (err) {
        console.error('PostgreSQL connection error:', err.message);
        process.exit(1);
    }
};

module.exports = connectDB;
