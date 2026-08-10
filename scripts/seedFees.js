/**
 * seedFees.js — Seed default fee heads, fine rules, and concession templates for a school.
 * Usage: node scripts/seedFees.js <schoolId>
 */
require('dotenv').config();
const db = require('../db/orm');

const FeeHead       = require('../models/FeeHead');
const FineRule      = require('../models/FineRule');
const FeeConcession = require('../models/FeeConcession');
const FeeSettings   = require('../models/FeeSettings');

const schoolId = process.argv[2];

if (!schoolId) {
    console.error('Usage: node scripts/seedFees.js <schoolId>');
    process.exit(1);
}

async function main() {
    await db.connect();
    console.log('[seedFees] Connected. Seeding school:', schoolId);

    // ── Fee Heads ────────────────────────────────────────────────────────────
    const defaultHeads = [
        { name: 'Tuition Fee',     category: 'tuition',   type: 'recurring', defaultAmount: 3000 },
        { name: 'Transport Fee',   category: 'transport',  type: 'recurring', defaultAmount: 1500 },
        { name: 'Admission Fee',   category: 'admission',  type: 'one_time',  defaultAmount: 5000 },
        { name: 'Exam Fee',        category: 'exam',       type: 'one_time',  defaultAmount: 500  },
        { name: 'Library Fee',     category: 'library',    type: 'recurring', defaultAmount: 200  },
        { name: 'Sports Fee',      category: 'sports',     type: 'recurring', defaultAmount: 300  },
        { name: 'Development Fee', category: 'custom',     type: 'one_time',  defaultAmount: 1000 },
        { name: 'Annual Fund',     category: 'custom',     type: 'one_time',  defaultAmount: 500  },
    ];

    for (const head of defaultHeads) {
        try {
            await FeeHead.updateOne({ school: schoolId, name: head.name }, { $setOnInsert: { ...head, school: schoolId } }, { upsert: true });
            console.log(`  ✓ FeeHead: ${head.name}`);
        } catch (e) { console.log(`  ✗ FeeHead: ${head.name} —`, e.message); }
    }

    // ── Fine Rules ───────────────────────────────────────────────────────────
    const defaultFines = [
        { name: 'Monthly Late Fee', fineType: 'per_day', perDayAmount: 10, gracePeriodDays: 5, maxCap: 200 },
        { name: 'Annual Late Fine', fineType: 'flat',    flatAmount: 100,  gracePeriodDays: 10, maxCap: 0  },
    ];

    for (const fine of defaultFines) {
        try {
            await FineRule.updateOne({ school: schoolId, name: fine.name }, { $setOnInsert: { ...fine, school: schoolId } }, { upsert: true });
            console.log(`  ✓ FineRule: ${fine.name}`);
        } catch (e) { console.log(`  ✗ FineRule: ${fine.name} —`, e.message); }
    }

    // ── Concession Templates ─────────────────────────────────────────────────
    const defaultConcessions = [
        { name: 'Staff Ward Concession',  concessionType: 'percentage', value: 50, applicableTo: 'all' },
        { name: 'Merit Scholarship',      concessionType: 'percentage', value: 25, applicableTo: 'all' },
        { name: 'Sibling Discount',       concessionType: 'percentage', value: 10, applicableTo: 'all' },
        { name: 'BPL Concession',         concessionType: 'percentage', value: 100, applicableTo: 'all' },
        { name: 'Fixed Tuition Waiver',   concessionType: 'fixed',      value: 500, applicableTo: 'all' },
    ];

    for (const conc of defaultConcessions) {
        try {
            await FeeConcession.updateOne({ school: schoolId, name: conc.name }, { $setOnInsert: { ...conc, school: schoolId } }, { upsert: true });
            console.log(`  ✓ Concession: ${conc.name}`);
        } catch (e) { console.log(`  ✗ Concession: ${conc.name} —`, e.message); }
    }

    // ── Fee Settings ─────────────────────────────────────────────────────────
    await FeeSettings.updateOne(
        { school: schoolId },
        { $setOnInsert: { school: schoolId, receiptPrefix: 'REC', currency: 'INR', currencySymbol: '₹' } },
        { upsert: true }
    );
    console.log('  ✓ FeeSettings initialized');

    await db.disconnect();
    console.log('[seedFees] Done.');
}

main().catch(err => { console.error('[seedFees] Fatal:', err); process.exit(1); });
