'use strict';
/**
 * Demo data for the Inventory module, shaped like the Sep 2026 redesign's
 * mockups — the same items, vendors, stores, orders and assets they show.
 *
 * It exists so the twelve screens can be checked against those mockups with
 * realistic data, and so a fresh school has something to look at. It is NOT
 * part of the app: nothing calls it, and it only touches one school.
 *
 *   node scripts/seedInventoryDemo.js --school admin@test.com
 *   node scripts/seedInventoryDemo.js --school admin@test.com --reset
 *
 * `--reset` deletes every inventory row for that school first, so running it
 * twice cannot double the data. Without it, the script refuses to run on a
 * school that already has items, rather than mixing demo rows into real ones.
 */
require('dotenv').config();
const db = require('../db/orm');

const School = require('../models/School');
const User = require('../models/User');
const AcademicYear = require('../models/AcademicYear');
const Category = require('../models/InventoryCategory');
const Warehouse = require('../models/InventoryWarehouse');
const Vendor = require('../models/InventoryVendor');
const Department = require('../models/InventoryDepartment');
const Budget = require('../models/InventoryBudget');
const Item = require('../models/InventoryItem');
const Stock = require('../models/InventoryStock');
const Txn = require('../models/InventoryStockTransaction');
const Request = require('../models/PurchaseRequest');
const Order = require('../models/PurchaseOrder');
const Issue = require('../models/InventoryIssue');
const Asset = require('../models/InventoryAsset');
const Log = require('../models/InventoryAuditLog');

const DAY = 86400000;
const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * DAY);
const daysOn = (n) => new Date(now.getTime() + n * DAY);
const pick = (arr, i) => arr[i % arr.length];

const args = process.argv.slice(2);
const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};

/* ── The data, straight off the mockups ─────────────────────────────────── */

const CATEGORIES = [
    ['Stationery', 'Notebooks, pens, files, registers and paper.', 'book'],
    ['Teaching Aids', 'Chalk, markers, charts and classroom aids.', 'bulb'],
    ['IT Supplies', 'Cartridges, cables, drives and small IT consumables.', 'laptop'],
    ['Laboratory', 'Science and lab instruments and chemicals.', 'flask'],
    ['Safety', 'Gloves, goggles, aprons and protective equipment.', 'shield'],
    ['Sports & Games', 'Indoor and outdoor sports items.', 'ball'],
    ['Audio Visual', 'Projectors, speakers, microphones, screens and other audio visual equipment used in classrooms and events.', 'monitor'],
    ['Computers & IT', 'Laptops, desktops, accessories and networking.', 'monitor'],
    ['Furniture', 'Tables, chairs, cupboards and fittings.', 'briefcase'],
    ['Lab Equipment', 'Microscopes, refrigerators and lab machinery.', 'flask'],
    ['Transport', 'Bus parts, tools and maintenance items.', 'bus'],
    ['Uniform', 'Student uniforms and accessories.', 'shirt'],
    ['Cleaning & Housekeeping', 'Cleaning materials and supplies.', 'broom'],
    ['Medical & First Aid', 'First aid kits, medicines and health supplies.', 'medical'],
];

const WAREHOUSES = [
    ['Main Store', 'WH-001', 'main', 'Primary inventory warehouse', 'Main Campus, Kolkata', 10000, true],
    ['Science Lab Store', 'WH-002', 'department', 'Store for lab equipment and chemicals', 'Science Block', 2000, true],
    ['Sports Store', 'WH-003', 'department', 'Sports and games equipment', 'Sports Complex', 1500, true],
    ['Library Store', 'WH-004', 'department', 'Books, stationery and library items', 'Library Block', 3000, true],
    ['Transport Store', 'WH-005', 'department', 'Vehicle parts and maintenance items', 'Transport Yard', 2000, true],
    ['Old Store', 'WH-006', 'secondary', 'Deprecated warehouse (not in use)', 'Old Block', 1000, false],
];

const VENDORS = [
    ['S.K. Stationery', 'Stationery', 'Suresh Kumar', '+91 98765 43210', 'skstationery@gmail.com', '12 Park Street', 'Kolkata', 'West Bengal', '700016', '19ABCDE1234F1Z5', 'ABCDE1234F', '30 Days', false, 'Stationery & Office Supplies'],
    ['ABC Educational Supplies', 'Books', 'Anita Sharma', '+91 98760 12345', 'sales@abcedu.in', '5 College Row', 'Kolkata', 'West Bengal', '700073', '19BBCDE1234F1Z5', 'BBCDE1234F', '45 Days', false, 'Books & Learning Material'],
    ['Lab Care Pvt Ltd', 'Lab Equipment', 'Dr. Mehta', '+91 98712 34567', 'care@labcare.co.in', '88 Industrial Area', 'Delhi', 'Delhi', '110020', '07CBCDE1234F1Z5', 'CBCDE1234F', '30 Days', false, 'Laboratory Equipment & Chemicals'],
    ['TechEdu Solutions', 'IT Equipment', 'Rohit Verma', '+91 98123 45678', 'hello@techedu.in', '22 Residency Road', 'Bangalore', 'Karnataka', '560025', '29DBCDE1234F1Z5', 'DBCDE1234F', 'Advance', true, 'Classroom Technology'],
    ['Classroom Store', 'Furniture', 'Neha Kapoor', '+91 98765 67890', 'orders@classroomstore.in', '7 Gariahat Road', 'Kolkata', 'West Bengal', '700019', '19EBCDE1234F1Z5', 'EBCDE1234F', '30 Days', false, 'School Furniture'],
    ['Om Paper Mart', 'Stationery', 'Manoj Yadav', '+91 98987 65432', 'ompaper@gmail.com', '41 Burrabazar', 'Kolkata', 'West Bengal', '700007', '19FBCDE1234F1Z5', 'FBCDE1234F', '15 Days', false, 'Paper & Printing'],
    ['Metro Electronics', 'Audio Visual', 'Kavita Singh', '+91 98734 56789', 'metro@electronics.in', '9 Lamington Road', 'Mumbai', 'Maharashtra', '400007', '27GBCDE1234F1Z5', 'GBCDE1234F', '30 Days', false, 'Audio Visual Systems'],
    ['Global Labs', 'Lab Equipment', 'Arjun Das', '+91 98222 33444', 'contact@globallabs.in', '14 Anna Salai', 'Chennai', 'Tamil Nadu', '600002', '33HBCDE1234F1Z5', 'HBCDE1234F', '45 Days', true, 'Scientific Instruments'],
];

const DEPARTMENTS = ['Science', 'Administration', 'Primary', 'IT Department', 'Sports', 'Library', 'Transport', 'Mathematics'];

// name, code, category, unit, price, gst, reorder, store index, [qty per store], description
const ITEMS = [
    ['A4 Sheet (White)', 'PAP-001', 'Stationery', 'Ream', 200, 12, 50, 0, [12], '70 GSM, Standard size'],
    ['Whiteboard Marker', 'WB-001', 'Teaching Aids', 'Piece', 150, 18, 20, 0, [5], 'Black, Refillable'],
    ['Notebook (Single Line)', 'NB-001', 'Stationery', 'Piece', 50, 12, 50, 0, [96], '200 pages'],
    ['Chalk (White)', 'CHK-001', 'Teaching Aids', 'Box', 20, 5, 30, 0, [80], 'Dustless'],
    ['Printer Ink (Black)', 'INK-001', 'IT Supplies', 'Piece', 960, 18, 5, 0, [0], 'HP 680'],
    ['Lab Chemicals Set', 'LAB-010', 'Laboratory', 'Set', 3000, 18, 15, 1, [8], 'Grade 8 Practical Kit'],
    ['Science Lab Gloves', 'LAB-023', 'Safety', 'Box', 348, 12, 50, 1, [25], 'Medium, Nitrile'],
    ['Projector Lamp', 'IT-006', 'IT Supplies', 'Piece', 9250, 18, 3, 0, [2], 'Epson EB-X06'],
    ['First Aid Kit', 'MED-004', 'Medical & First Aid', 'Set', 850, 12, 6, 0, [9], 'Wall-mounted, 32 items'],
    ['AA Battery Pack', 'ELC-012', 'IT Supplies', 'Packet', 180, 18, 25, 0, [6], 'Pack of 4, alkaline'],
    ['Sports Net (Football)', 'SP-021', 'Sports & Games', 'Piece', 3100, 12, 2, 2, [4], 'Nylon, full size'],
    ['Math Lab Kit', 'LAB-001', 'Laboratory', 'Set', 2400, 18, 4, 1, [7], 'Geometry and measurement'],
    ['Duster (Whiteboard)', 'DUS-003', 'Teaching Aids', 'Piece', 90, 12, 20, 0, [34], 'Magnetic'],
    ['Register (Attendance)', 'REG-002', 'Stationery', 'Piece', 140, 12, 15, 3, [22], '100 pages, hard bound'],
    ['Floor Cleaner', 'CLN-005', 'Cleaning & Housekeeping', 'Litre', 120, 18, 20, 0, [48], 'Concentrate, 5L'],
    ['Student Uniform (Shirt)', 'UNI-010', 'Uniform', 'Piece', 420, 5, 40, 3, [60], 'White, sizes 26–40'],
];

// Batches with an expiry date, for the dashboard's Upcoming Expiry card.
const EXPIRING = [
    ['MED-004', 12, 'MED-2026-A'],
    ['LAB-010', 25, 'CHM-2026-B'],
    ['IT-006', 33, 'LMP-2026-C'],
    ['SP-021', 40, 'NET-2026-D'],
];

const ASSETS = [
    ['IT-001', 'Computer (Dell OptiPlex)', 'Computers & IT', 'Computer Lab', 'in_use', 'good', 45000, 900, 200, 'DL7X91QS'],
    ['AUD-002', 'Projector (Epson EB-X06)', 'Audio Visual', 'Smart Class 1', 'under_repair', 'good', 38500, 810, -1, 'EPX06-4412'],
    ['LAB-005', 'Microscope (Olympus)', 'Lab Equipment', 'Science Lab', 'in_use', 'good', 62000, 990, 6, 'OLY-CX23-88'],
    ['FUR-012', 'Lab Table (6 Seater)', 'Furniture', 'Science Lab', 'in_use', 'good', 18000, 930, null, ''],
    ['BUS-001', 'School Bus (Tata)', 'Transport', 'Main Campus', 'out_of_service', 'fair', 1850000, 1150, 31, 'WB02AB1234'],
    ['IT-014', 'Laptop (HP EliteBook)', 'Computers & IT', 'Admin Office', 'in_use', 'good', 78000, 960, 140, 'HP-EB840-07'],
    ['LAB-023', 'Lab Refrigerator', 'Lab Equipment', 'Biology Lab', 'in_use', 'good', 95000, 1060, 23, 'LG-LAB-556'],
    ['OTH-004', 'Smart Board', 'Audio Visual', 'Class 10', 'in_use', 'good', 120000, 860, 230, 'SB-75-0091'],
    ['IT-022', 'Desktop (Lenovo ThinkCentre)', 'Computers & IT', 'Computer Lab', 'in_use', 'good', 41000, 500, 180, 'LN-TC-3321'],
    ['FUR-030', 'Staff Cupboard', 'Furniture', 'Staff Room', 'in_store', 'good', 12500, 420, null, ''],
    ['AUD-009', 'PA System', 'Audio Visual', 'Assembly Hall', 'in_use', 'fair', 56000, 700, 55, 'PA-AH-004'],
    ['LAB-031', 'Centrifuge', 'Lab Equipment', 'Science Lab', 'retired', 'poor', 34000, 1400, null, 'CF-2019-11'],
];

const BUDGETS = [
    ['Science Lab Budget', 'Science', 'Lab Equipment', 200000, 'flask', 'Procurement of laboratory equipment, chemicals and consumables.'],
    ['Computer Lab Budget', 'IT Department', 'Computers & IT', 150000, 'monitor', 'Desktops, peripherals and software for the computer lab.'],
    ['Library Budget', 'Library', 'Stationery', 100000, 'book', 'Books, registers and reading room supplies.'],
    ['Sports Department', 'Sports', 'Sports & Games', 120000, 'ball', 'Equipment and kit for school teams and PE lessons.'],
    ['Transport Budget', 'Transport', 'Transport', 250000, 'bus', 'Bus parts, tools and routine maintenance.'],
    ['Administration', 'Administration', 'Furniture', 100000, 'briefcase', 'Office furniture and administrative supplies.'],
    ['Maintenance Budget', 'Administration', 'Cleaning & Housekeeping', 80000, 'wrench', 'Housekeeping, repairs and upkeep.'],
    ['Uniform Budget', 'Administration', 'Uniform', 100000, 'shirt', 'Uniform stock held for sale to parents.'],
];

/* ── Runner ─────────────────────────────────────────────────────────────── */

async function main() {
    const who = flag('school');
    const reset = !!flag('reset');
    if (!who) {
        console.error('Say which school: --school <admin email | school id>');
        process.exit(1);
    }

    await db.connect();
    await db.syncAll();

    let schoolId = null;
    let actor = null;
    if (/^[0-9a-f-]{36}$/i.test(String(who))) {
        schoolId = who;
        actor = await User.findOne({ school: schoolId, role: 'school_admin' }).lean();
    } else {
        actor = await User.findOne({ email: String(who).toLowerCase(), role: 'school_admin' }).lean();
        schoolId = actor?.school;
    }
    if (!schoolId) { console.error(`No school found for "${who}"`); process.exit(1); }
    const school = await School.findOne({ _id: schoolId }).lean();
    console.log(`School: ${school?.name || schoolId}`);

    const MODELS = [Txn, Stock, Issue, Order, Request, Asset, Item, Budget, Department, Vendor, Warehouse, Category, Log];
    if (reset) {
        for (const M of MODELS) {
            const r = await M.deleteMany({ school: schoolId });
            console.log(`  cleared ${M.modelName}: ${r?.deletedCount ?? 0}`);
        }
    } else {
        const existing = await Item.countDocuments({ school: schoolId });
        if (existing) {
            console.error(`That school already has ${existing} items. Re-run with --reset to replace them.`);
            process.exit(1);
        }
    }

    const year = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
    const staff = await User.find({ school: schoolId, role: { $in: ['teacher', 'school_admin'] } })
        .select('name role').limit(12).lean();
    const people = staff.length ? staff : [actor].filter(Boolean);
    const by = actor?._id || null;

    // ── Masters ──────────────────────────────────────────────────────────
    const cats = {};
    for (const [name, description, icon] of CATEGORIES) {
        const c = await Category.create({ school: schoolId, name, description, icon, createdBy: by });
        cats[name] = c;
    }
    const whs = [];
    for (const [name, code, type, description, location, capacity, isActive] of WAREHOUSES) {
        whs.push(await Warehouse.create({
            school: schoolId, name, code, type, description, location, capacity, isActive,
            campus: 'Main Campus', contactPerson: 'Store In-charge', createdBy: by,
        }));
    }
    const vendors = [];
    for (const [name, vendorCategory, contactPerson, phone, email, address, city, state, pincode, gstNumber, pan, paymentTerms, preferred, tagline] of VENDORS) {
        vendors.push(await Vendor.create({
            school: schoolId, name, vendorCategory, contactPerson, phone, email, address, city, state,
            pincode, gstNumber, pan, paymentTerms, preferred, tagline, isActive: name !== 'Metro Electronics',
            createdBy: by,
        }));
    }
    const depts = {};
    for (const name of DEPARTMENTS) {
        depts[name] = await Department.create({
            school: schoolId, name, financialYear: year?.yearName || '', annualBudget: 0, createdBy: by,
        });
    }
    console.log(`  masters: ${CATEGORIES.length} categories, ${whs.length} stores, ${vendors.length} vendors, ${DEPARTMENTS.length} departments`);

    // ── Items, stock and a six-month ledger ──────────────────────────────
    const items = {};
    for (const [name, itemCode, catName, unit, purchasePrice, gst, reorderLevel, whIdx, qtys, description] of ITEMS) {
        const it = await Item.create({
            school: schoolId, name, itemCode, description, unit, purchasePrice, gst, reorderLevel,
            category: cats[catName]?._id || null, warehouse: whs[whIdx]?._id || null,
            hasExpiry: ['MED-004', 'LAB-010'].includes(itemCode),
            trackBatch: ['MED-004', 'LAB-010', 'IT-006'].includes(itemCode),
            createdBy: by, createdAt: daysAgo(120 + Math.floor(Math.random() * 200)),
        });
        items[itemCode] = it;

        // ── The ledger defines the balance, not the other way round ──────
        // The stock row used to be written first and a plausible-looking
        // history written beside it, which did not add up — and every figure
        // the Stock screen reconstructs from the ledger (the six-month trend,
        // every "from last month") silently drifted from the balance it was
        // supposed to explain. The events are built first, walked forward, and
        // the row is whatever they come to.
        const qty = qtys[0];
        const events = [{
            type: 'adjustment', quantity: qty, at: daysAgo(200),
            note: 'Opening balance', cost: purchasePrice,
        }];
        for (let m = 5; m >= 0; m--) {
            const out = Math.round(qty * (0.10 + Math.random() * 0.12)) || 1;
            const inn = Math.round(out * (0.9 + Math.random() * 0.5)) || 1;
            events.push({ type: 'purchase', quantity: inn, at: daysAgo(m * 30 + 20), cost: purchasePrice });
            events.push({ type: 'issue', quantity: -out, at: daysAgo(m * 30 + 8) });
        }
        if (['MED-004', 'LAB-010', 'IT-006', 'SP-021'].includes(itemCode)) {
            const [, days, batch] = EXPIRING.find(e => e[0] === itemCode) || [];
            if (batch) {
                events.push({
                    type: 'purchase', quantity: 4, at: daysAgo(30), cost: purchasePrice,
                    batch, expiry: daysOn(days),
                });
            }
        }
        events.sort((a, b) => a.at - b.at);

        let running = 0;
        for (const ev of events) {
            // A movement may not take the balance below zero — the same rule
            // the running system enforces, so the demo data is data the app
            // could actually have produced.
            const applied = Math.max(ev.quantity, -running);
            if (!applied) continue;
            running += applied;
            await Txn.create({
                school: schoolId, item: it._id, warehouse: whs[whIdx]._id,
                type: ev.type, quantity: applied, balanceAfter: running,
                unitCost: applied > 0 ? (ev.cost || 0) : 0,
                batchNumber: ev.batch || '', expiryDate: ev.expiry || null,
                note: ev.note || (applied > 0 ? 'Stock received' : 'Issued for classroom use'),
                performedBy: by, createdAt: ev.at,
            });
        }

        await Stock.create({
            school: schoolId, item: it._id, warehouse: whs[whIdx]._id,
            quantity: running, reserved: 0, avgCost: purchasePrice,
        });
    }
    console.log(`  items: ${ITEMS.length}, with stock and a six-month ledger`);

    // ── Budgets ──────────────────────────────────────────────────────────
    const budgets = [];
    for (const [name, deptName, catName, allocated, icon, description] of BUDGETS) {
        const abbr = deptName.replace(/[^A-Za-z ]/g, '').split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase();
        budgets.push(await Budget.create({
            school: schoolId, name, code: `BUD-${abbr}-${now.getFullYear()}`,
            scope: 'both', department: depts[deptName]?._id || null, category: cats[catName]?._id || null,
            academicYear: year?._id || null,
            periodStart: new Date(now.getFullYear(), 3, 1), periodEnd: new Date(now.getFullYear() + 1, 2, 31),
            allocated, icon, description, createdBy: by,
        }));
    }
    console.log(`  budgets: ${budgets.length}`);

    // ── Purchase orders ──────────────────────────────────────────────────
    const PO_PLAN = [
        [18, 'S.K. Stationery', 'Administration', ['PAP-001', 'NB-001', 'REG-002', 'CHK-001', 'DUS-003'], 'pending_approval', 4],
        [17, 'ABC Educational Supplies', 'Library', ['NB-001', 'REG-002', 'UNI-010'], 'approved', 6],
        [16, 'Lab Care Pvt Ltd', 'Science', ['LAB-010', 'LAB-001', 'LAB-023'], 'in_transit', 1],
        [15, 'TechEdu Solutions', 'IT Department', ['INK-001', 'IT-006', 'ELC-012'], 'received', 8],
        [14, 'Classroom Store', 'Administration', ['DUS-003', 'CHK-001'], 'pending_approval', -2],
        [13, 'Om Paper Mart', 'Administration', ['PAP-001', 'NB-001'], 'approved', -4],
        [12, 'Metro Electronics', 'IT Department', ['IT-006', 'ELC-012'], 'in_transit', -6],
        [11, 'Global Labs', 'Science', ['LAB-010', 'LAB-023'], 'cancelled', -8],
        [10, 'S.K. Stationery', 'Primary', ['CHK-001', 'DUS-003'], 'received', -20],
        [9, 'TechEdu Solutions', 'IT Department', ['INK-001'], 'received', -42],
        [8, 'Classroom Store', 'Sports', ['SP-021'], 'received', -55],
        [7, 'Om Paper Mart', 'Administration', ['PAP-001'], 'received', -70],
    ];
    const orders = [];
    let poSeq = 0;
    for (const [n, vendorName, deptName, codes, status, dueOffset] of PO_PLAN) {
        const vendor = vendors.find(v => v.name === vendorName);
        const lines = codes.map((code, i) => {
            const it = items[code];
            return {
                item: it._id, itemName: it.name, quantity: 5 + i * 3, unit: it.unit,
                unitPrice: it.purchasePrice, gst: it.gst,
                receivedQty: status === 'received' ? 5 + i * 3 : 0,
            };
        });
        const subTotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
        const taxTotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice * (l.gst / 100), 0);
        const created = daysAgo(5 + poSeq * 6);
        const budget = budgets.find(b => String(b.department) === String(depts[deptName]?._id));
        orders.push(await Order.create({
            school: schoolId, poNumber: `PO-${now.getFullYear()}-${String(n).padStart(3, '0')}`,
            vendor: vendor._id, department: depts[deptName]?._id || null, budget: budget?._id || null,
            warehouse: whs[0]._id, items: lines,
            subTotal: Math.round(subTotal), taxTotal: Math.round(taxTotal),
            grandTotal: Math.round(subTotal + taxTotal), discount: 0,
            expectedDelivery: daysOn(dueOffset), status,
            approvedAt: ['approved', 'in_transit', 'received'].includes(status) ? daysAgo(4 + poSeq * 6) : null,
            approvedBy: ['approved', 'in_transit', 'received'].includes(status) ? by : null,
            receivedAt: status === 'received' ? daysAgo(1 + poSeq * 5) : null,
            invoice: status === 'received'
                ? { number: `INV-${n}${now.getFullYear()}`, date: daysAgo(poSeq * 5), amount: Math.round(subTotal + taxTotal) }
                : {},
            terms: 'Payment 30 days from delivery. Damaged goods to be replaced within 7 days.',
            deliveryAddress: school?.address || 'Main Campus',
            createdBy: by, createdAt: created,
        }));
        poSeq++;
    }
    console.log(`  purchase orders: ${orders.length}`);

    // ── Requests ─────────────────────────────────────────────────────────
    const REQ_PLAN = [
        [18, 'WB-001', 'Primary', 10, 'Classroom use', 'pending'],
        [17, 'PAP-001', 'Administration', 5, 'Office documents', 'pending'],
        [16, 'LAB-010', 'Science', 2, 'Lab practicals', 'approved'],
        [15, 'LAB-023', 'Science', 10, 'Lab safety', 'approved'],
        [14, 'IT-006', 'IT Department', 1, 'Projector maintenance', 'rejected'],
        [13, 'NB-001', 'Primary', 20, 'Classroom use', 'converted'],
        [12, 'CHK-001', 'Primary', 15, 'Regular use', 'approved'],
        [11, 'INK-001', 'Administration', 2, 'Printer maintenance', 'converted'],
    ];
    let rqSeq = 0;
    for (const [n, code, deptName, quantity, reason, status] of REQ_PLAN) {
        const it = items[code];
        const person = pick(people, rqSeq);
        await Request.create({
            school: schoolId, requestNumber: `REQ-${now.getFullYear()}-${String(n).padStart(3, '0')}`,
            requestedBy: person?._id || by, department: depts[deptName]?._id || null,
            reason, priority: status === 'pending' ? 'high' : 'normal',
            items: [{ item: it._id, itemName: it.name, quantity, unit: it.unit, estimatedPrice: it.purchasePrice }],
            estimatedTotal: quantity * it.purchasePrice,
            status,
            approvals: status === 'pending'
                ? [{ stage: 'Inventory Admin', action: 'pending' }]
                : [{
                    stage: 'Inventory Admin',
                    action: status === 'rejected' ? 'rejected' : 'approved',
                    actor: by, actedAt: daysAgo(2 + rqSeq * 2),
                    comment: status === 'rejected' ? 'Already covered by an open purchase order.' : 'Approved for this term.',
                }],
            checks: { stockAvailable: quantity <= 5, budgetOk: true, possibleDuplicate: false },
            createdAt: daysAgo(5 + rqSeq * 2),
        });
        rqSeq++;
    }
    console.log(`  requests: ${REQ_PLAN.length}`);

    // ── Issues and returns ───────────────────────────────────────────────
    const ISSUE_PLAN = [
        ['LAB-010', 1, 'Science', 'student', 'Rohan Mehta', 'Class 8A', 5, 'Good', true, 0],
        ['IT-006', 1, 'IT Department', 'staff', 'IT Department', '', 5, 'Good', true, 1],
        ['LAB-023', 5, 'Science', 'teacher', null, '', 3, 'Good', true, 0],
        ['PAP-001', 2, 'Administration', 'teacher', null, '', 8, 'Good', true, 1],
        ['WB-001', 10, 'Primary', 'class', 'Class 5B', 'Class 5B', 2, 'Used', true, 0],
        ['NB-001', 12, 'Primary', 'student', 'Ananya Das', 'Class 5B', -4, 'Good', true, 0],
        ['CHK-001', 10, 'Mathematics', 'department', 'Mathematics Dept', '', 6, 'Good', true, 1],
        ['INK-001', 2, 'Administration', 'staff', 'IT Department', '', 7, 'Good', true, 0],
        ['DUS-003', 6, 'Primary', 'teacher', null, '', null, 'Good', false, 0],
        ['CLN-005', 10, 'Administration', 'department', 'Housekeeping', '', null, 'Good', false, 0],
    ];
    let isSeq = 0;
    for (const [code, quantity, deptName, recipientType, name, classLabel, dueIn, conditionOut, returnable, returns] of ISSUE_PLAN) {
        const it = items[code];
        const person = ['teacher', 'staff'].includes(recipientType) && !name ? pick(people, isSeq) : null;
        const issueNumber = `IR-${now.getFullYear()}-${String(24 - isSeq).padStart(3, '0')}`;
        const issueDate = daysAgo(4 + isSeq * 2);
        const rets = [];
        let returnedQty = 0;
        for (let r = 0; r < returns; r++) {
            const qty = Math.max(1, Math.floor(quantity / (returns + 1)));
            returnedQty += qty;
            rets.push({
                returnNumber: `${issueNumber}-R${String(r + 1).padStart(2, '0')}`,
                quantity: qty, condition: r === 0 ? 'good' : 'partially_used',
                restocked: true, returnedAt: daysAgo(1 + isSeq), receivedBy: by, note: '',
            });
        }
        await Issue.create({
            school: schoolId, issueNumber, item: it._id, warehouse: it.warehouse, quantity,
            issuedToUser: person?._id || null,
            issuedToName: name || person?.name || '',
            recipientType, classLabel,
            department: depts[deptName]?._id || null,
            issueDate, expectedReturn: returnable && dueIn != null ? daysOn(dueIn) : null,
            conditionOut, returnable,
            returns: rets, returnedQty,
            returnedAt: rets.length ? rets[rets.length - 1].returnedAt : null,
            returnCondition: rets.length ? rets[rets.length - 1].condition : '',
            status: returnedQty >= quantity ? 'returned' : returnedQty ? 'partially_returned' : 'issued',
            issuedBy: by, createdAt: issueDate,
        });
        isSeq++;
    }
    console.log(`  issues: ${ISSUE_PLAN.length}`);

    // ── Assets ───────────────────────────────────────────────────────────
    for (const [assetCode, name, catName, location, status, condition, purchaseCost, boughtDaysAgo, serviceInDays, serialNumber] of ASSETS) {
        const holder = ['in_use'].includes(status) ? pick(people, assetCode.length) : null;
        await Asset.create({
            school: schoolId, assetCode, name, serialNumber,
            category: cats[catName]?._id || null,
            warehouse: whs[0]._id, location,
            purchaseDate: daysAgo(boughtDaysAgo), purchaseCost,
            currentValue: Math.round(purchaseCost * 0.88),
            warrantyExpiry: daysOn(serviceInDays == null ? 400 : serviceInDays + 12),
            amcExpiry: serviceInDays == null ? null : daysOn(serviceInDays + 16),
            insuranceExpiry: assetCode === 'BUS-001' ? daysOn(31) : null,
            nextMaintenance: serviceInDays == null ? null : daysOn(serviceInDays),
            status, condition,
            assignedTo: holder?._id || null, assignedName: holder?.name || '',
            repairs: status === 'under_repair'
                ? [{ complaint: 'Lamp flickers after 20 minutes', status: 'in_progress', reportedAt: daysAgo(6), cost: 2400 }]
                : [],
            createdBy: by, createdAt: daysAgo(boughtDaysAgo),
        });
    }
    console.log(`  assets: ${ASSETS.length}`);

    // ── Activity log ─────────────────────────────────────────────────────
    const LOG_PLAN = [
        ['PO_CREATED', 'PurchaseOrder', 'Created purchase order PO-2026-018 for S.K. Stationery', 'PO-2026-018', '192.168.1.24'],
        ['ITEM_ISSUED', 'InventoryIssue', 'Issued 5 Science Lab Gloves to Science Department', 'IR-2026-022', '192.168.1.31'],
        ['ASSET_UPDATED', 'InventoryAsset', 'Updated asset details Projector (Epson EB-X06)', 'AUD-002', '192.168.1.28'],
        ['ITEM_CREATED', 'InventoryItem', 'Added new item Student Uniform (Shirt)', 'UNI-010', '192.168.1.27'],
        ['STOCK_ADJUSTED', 'InventoryStockTransaction', 'Updated stock quantity +50 units (Lab Chemicals Set)', 'LAB-010', '192.168.1.26'],
        ['REQUEST_CREATED', 'PurchaseRequest', 'Created new request REQ-2026-018', 'REQ-2026-018', '192.168.1.31'],
        ['ITEM_RETURNED', 'InventoryIssue', 'Returned 2 Printer Ink from IT Department', 'IR-2026-017-R01', '192.168.1.28'],
        ['VENDOR_CREATED', 'InventoryVendor', 'Added new vendor Global Labs', 'Global Labs', '192.168.1.19'],
        ['BUDGET_UPDATED', 'InventoryBudget', 'Updated budget allocation Science Lab Budget', 'BUD-SCI-2026', '192.168.1.24'],
        ['ITEM_DELETED', 'InventoryItem', 'Deleted item Old Whiteboard (OBD)', 'ITM-018', '192.168.1.27'],
        ['PO_APPROVED', 'PurchaseOrder', 'Approved purchase order PO-2026-017', 'PO-2026-017', '192.168.1.24'],
        ['PO_RECEIVED', 'PurchaseOrder', 'Goods received for PO-2026-015', 'PO-2026-015', '192.168.1.26'],
        ['WAREHOUSE_CREATED', 'InventoryWarehouse', 'Added new warehouse Transport Store', 'WH-005', '192.168.1.19'],
        ['CATEGORY_UPDATED', 'InventoryCategory', 'Updated category Audio Visual', 'Audio Visual', '192.168.1.31'],
        ['PR_REJECTED', 'PurchaseRequest', 'Rejected request REQ-2026-014', 'REQ-2026-014', '192.168.1.24'],
    ];
    const CRITICAL = /DELETE|CANCEL|REJECT|SCRAP|DISPOS|LOST|BUDGET/i;
    let lgSeq = 0;
    // Three months of history, so the tiles' month-on-month deltas are real.
    for (let d = 0; d < 90; d++) {
        const perDay = d === 0 ? 14 : d < 3 ? 6 : d < 30 ? 3 : 1;
        for (let k = 0; k < perDay; k++) {
            const [actionType, entityType, description, referenceCode, ip] = pick(LOG_PLAN, lgSeq + k);
            const person = pick(people, lgSeq + k);
            await Log.create({
                school: schoolId, user: person?._id || by, role: person?.role || 'school_admin',
                actionType, entityType, description, referenceCode, ip,
                critical: CRITICAL.test(actionType),
                meta: { seeded: true },
                timestamp: new Date(daysAgo(d).getTime() - k * 37 * 60000),
            });
            lgSeq++;
        }
    }
    console.log(`  activity log: ${lgSeq} entries across 90 days`);

    console.log('\nDone.');
    await db.disconnect();
}

main().catch(async (e) => {
    console.error(e);
    try { await db.disconnect(); } catch { /* already closed */ }
    process.exit(1);
});
