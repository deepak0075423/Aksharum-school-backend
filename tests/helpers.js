'use strict';
/**
 * A scratch school, created for one test file and deleted afterwards.
 *
 * Run them with `npm test`. That passes `--test-force-exit` because the app's
 * own modules open long-lived handles when they are required — a Redis client,
 * a mail transporter's timer — and the test runner otherwise waits for those
 * rather than for the tests. `teardown()` closes the connection pool, which is
 * the one this code owns.
 *
 * There is no separate test database configured, so the tests run against the
 * development one — but never against its data. Everything a test touches
 * belongs to a school it created and owns, identified by a name nothing else
 * uses, and the teardown deletes every inventory row for it. A test that
 * crashes leaves one scratch school behind; `npm test` cleans up stragglers on
 * the way in, so the next run starts clean either way.
 */
require('dotenv').config();
const db = require('../db/orm');
const { query, end } = require('../db/pool');

const School = require('../models/School');
const User = require('../models/User');
const Category = require('../models/InventoryCategory');
const Warehouse = require('../models/InventoryWarehouse');
const Department = require('../models/InventoryDepartment');
const Vendor = require('../models/InventoryVendor');
const Item = require('../models/InventoryItem');

const SCRATCH = 'ZZ Test Scratch School';

/** Tables the teardown clears, children before parents. */
const INVENTORY_TABLES = [
    'inventorystocktransactions', 'inventorystocks', 'inventoryissues',
    'purchaseorders', 'purchaserequests', 'inventoryassets', 'inventoryitems',
    'inventorybudgets', 'inventorycounters', 'inventoryalerts', 'inventoryauditlogs',
    'inventorycategories', 'inventorywarehouses', 'inventoryvendors', 'inventorydepartments',
];

/**
 * Every hostel table, for the hostel tests' scratch school. Deleting by school
 * is safe because nothing outside the scratch school is ever touched.
 */
const HOSTEL_TABLES = [
    'hostelattendances', 'hostelallocationhistories', 'hostelallocations', 'hosteladmissions',
    'hosteltransferrequests', 'hostelpaymentorders', 'hostelcounters', 'feeledgers', 'parentprofiles', 'hostelfeeinvoices', 'hostelfeeplans', 'hostelincidents', 'hosteldisciplines', 'hostelleaves',
    'hosteloutpasses', 'hostelmovements', 'hostelvisitors', 'hostelcomplaints', 'hostelmaintenances',
    'hostelassets', 'hosteldocuments', 'hostelmessattendances', 'hostelmessexpenses', 'hostelmessmembers',
    'hostelmenus', 'hostelmesses', 'hostelstaffassignments', 'hostelauditlogs', 'hostelsettingses', 'hostelannouncements',
    'notificationreceipts', 'notifications',
    'hostelbeds', 'hostelrooms', 'hostelfloors', 'hostelbuildings', 'hostels', 'academicyears',
];

/** Give the ORM time to create any table a model needs before the first query. */
async function ready() {
    for (let i = 0; i < 40; i++) {
        try { await query('SELECT 1'); return; } catch { await new Promise(r => setTimeout(r, 250)); }
    }
    throw new Error('database never became reachable');
}

/** Remove any scratch school left behind by a run that crashed. */
async function sweepStragglers() {
    const { rows } = await query('SELECT "_id" FROM "schools" WHERE "name" = $1', [SCRATCH]);
    for (const r of rows) await destroy(r._id);
}

/**
 * A school with the master data every inventory test needs: two stores, two
 * categories, a department, a vendor and one item with a reorder level.
 */
async function makeSchool({ reorderLevel = 10 } = {}) {
    await ready();
    const school = await School.create({
        name: SCRATCH, email: `zz-scratch-${Date.now()}@test.invalid`,
        isActive: true, modules: { inventory: true },
    });
    const id = String(school._id);

    const admin = await User.create({
        school: id, name: 'ZZ Scratch Admin', role: 'school_admin',
        email: `zz-admin-${Date.now()}@test.invalid`, password: 'x', isActive: true,
    });

    const [main, lab] = await Promise.all([
        Warehouse.create({ school: id, name: 'Main Store', code: 'MAIN', isActive: true, capacity: 1000, lowCapacityAt: 80 }),
        Warehouse.create({ school: id, name: 'Lab Store', code: 'LAB', isActive: true }),
    ]);
    const [stationery, laboratory] = await Promise.all([
        Category.create({ school: id, name: 'Stationery', code: 'STA', isActive: true }),
        Category.create({ school: id, name: 'Laboratory', code: 'LAB', isActive: true }),
    ]);
    const dept = await Department.create({ school: id, name: 'Science', code: 'SCI', isActive: true });
    const vendor = await Vendor.create({ school: id, name: 'ZZ Supplies', isActive: true });
    const item = await Item.create({
        school: id, name: 'Test Widget', itemCode: 'ZZ-001', unit: 'Nos',
        category: String(stationery._id), warehouse: String(main._id),
        purchasePrice: 100, reorderLevel, isActive: true,
    });

    // `ctx` is what the stock service and the controllers take in place of a
    // request: they only ever read these two fields off it.
    return {
        id, ctx: { schoolId: id, userId: String(admin._id), userRole: 'school_admin' },
        admin, main, lab, stationery, laboratory, dept, vendor, item,
    };
}

/** Everything this school ever had, gone. */
async function destroy(schoolId) {
    if (!schoolId) return;
    for (const t of [...INVENTORY_TABLES, ...HOSTEL_TABLES]) {
        await query(`DELETE FROM "${t}" WHERE "school" = $1`, [String(schoolId)]).catch(() => {});
    }
    await query('DELETE FROM "users" WHERE "school" = $1', [String(schoolId)]).catch(() => {});
    await query('DELETE FROM "schools" WHERE "_id" = $1', [String(schoolId)]).catch(() => {});
}

/** The balance and the ledger, for an assertion that they agree. */
async function balances(schoolId) {
    const { rows } = await query(`
        SELECT i."name", s."quantity"::numeric AS "balance", COALESCE(s."reserved", 0)::numeric AS "reserved",
               COALESCE(t.sum, 0)::numeric AS "ledger"
          FROM "inventorystocks" s
          JOIN "inventoryitems" i ON i."_id" = s."item"
          LEFT JOIN (SELECT "item", "warehouse", SUM("quantity") sum
                       FROM "inventorystocktransactions" GROUP BY 1, 2) t
            ON t."item" = s."item" AND t."warehouse" = s."warehouse"
         WHERE s."school" = $1`, [String(schoolId)]);
    return rows.map(r => ({
        name: r.name, balance: Number(r.balance), reserved: Number(r.reserved), ledger: Number(r.ledger),
    }));
}

/**
 * Tear the scratch school down and let the process exit.
 *
 * `node --test` runs each file in its own process and waits for the event loop
 * to drain; an open connection pool keeps it alive for the pool's idle timeout,
 * which turns a one-second suite into a thirty-second one.
 */
async function teardown(schoolId) {
    await destroy(schoolId);
    await end().catch(() => {});
}

module.exports = { SCRATCH, makeSchool, destroy, teardown, sweepStragglers, balances, ready, db };
