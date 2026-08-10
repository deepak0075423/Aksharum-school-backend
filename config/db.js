const fs = require('fs');
const path = require('path');
const orm = require('../db/orm');

const connectDB = async () => {
    try {
        await orm.connect();
        // Register every model, then sync tables/indexes.
        const modelsDir = path.join(__dirname, '../models');
        for (const file of fs.readdirSync(modelsDir)) {
            if (file.endsWith('.js')) require(path.join(modelsDir, file));
        }
        await orm.syncAll();
        console.log('PostgreSQL connected, schema synced');
    } catch (err) {
        console.error('PostgreSQL connection error:', err.message);
        process.exit(1);
    }
};

module.exports = connectDB;
