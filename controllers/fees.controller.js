'use strict';
const FeeCategory         = require('../models/FeeCategory');
const FeeHead             = require('../models/FeeHead');
const FeeStructure        = require('../models/FeeStructure');
const FineRule            = require('../models/FineRule');
const FeeConcession       = require('../models/FeeConcession');
const StudentFeeAssignment= require('../models/StudentFeeAssignment');
const StudentConcession   = require('../models/StudentConcession');
const FeePayment          = require('../models/FeePayment');
const FeeLedger           = require('../models/FeeLedger');
const FeeSettings         = require('../models/FeeSettings');
const AcademicYear        = require('../models/AcademicYear');
const ClassSection        = require('../models/ClassSection');
const User                = require('../models/User');
const StudentProfile      = require('../models/StudentProfile');
const School              = require('../models/School');
const ReceiptTemplate = require('../models/ReceiptTemplate');
const ParentProfile   = require('../models/ParentProfile');
const { renderReceipt, defaultTemplate } = require('../services/receiptRenderer');
const Class               = require('../models/Class');
const { notify, withParents } = require('../services/notifyService');
const { logFeeAudit }     = require('../services/feeAudit');
const { applyStudentConcessions, reverseStudentConcession } = require('../services/feeConcessions');
const charging = require('../services/feeCharging');
const { postDueCharges, legacyStart } = charging;
const Sched = require('../services/feeSchedule');
const { isUuid }          = require('../db/schema');
const pool                = require('../db/pool');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getActiveYear(schoolId) {
    return AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
}

async function getOrCreateSettings(schoolId) {
    let s = await FeeSettings.findOne({ school: schoolId }).lean();
    if (!s) s = (await FeeSettings.create({ school: schoolId })).toObject();
    return withDefaults(s);
}

/**
 * A settings row written before a setting existed reads that column as null.
 * Fill every null from the model's own defaults — nested groups key by key —
 * so a screen never sees a switch that is neither on nor off.
 */
function withDefaults(s) {
    const d = new FeeSettings({ school: s.school }).toObject();
    const out = { ...s };
    for (const [k, v] of Object.entries(d)) {
        if (k === '_id') continue;
        if (out[k] == null) { out[k] = v; continue; }
        if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && typeof out[k] === 'object' && !Array.isArray(out[k])) {
            out[k] = { ...v, ...Object.fromEntries(Object.entries(out[k]).filter(([, x]) => x != null)) };
        }
    }
    return out;
}

const HEAD_TYPES      = ['recurring', 'one_time', 'quarterly', 'half_yearly', 'yearly'];
const AMOUNT_TYPES    = ['fixed', 'variable'];
const ELIGIBILITY     = ['selected', 'all', 'siblings', 'staff_children', 'female', 'alumni_children', 'new_admissions'];
const FINE_APPLIES_TO = ['all', 'classes', 'transport', 'hostel'];
const PAY_MODES       = ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'dd', 'online'];

const bad  = (res, message) => res.status(400).json({ success: false, message });
const num  = (v) => (v === '' || v == null ? NaN : Number(v));
const dayOrNull = (v) => {
    if (!v) return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T00:00:00` : v);
    return Number.isNaN(d.getTime()) ? null : d;
};
const idList = (v) => [...new Set((Array.isArray(v) ? v : []).map(String).filter(isUuid))];

async function nextReceiptNumber(schoolId) {
    const settings = await FeeSettings.findOneAndUpdate(
        { school: schoolId },
        { $inc: { lastReceiptNumber: 1 } },
        { upsert: true, new: true }
    );
    const prefix = settings.receiptPrefix || 'REC';
    return `${prefix}-${String(settings.lastReceiptNumber).padStart(6, '0')}`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

exports.getDashboard = async (req, res) => {
    try {
        const ay = await getActiveYear(req.schoolId);
        const [totalStudents, totalPayments, pendingDues, recentPayments] = await Promise.all([
            User.countDocuments({ school: req.schoolId, role: 'student', isActive: true }),
            FeePayment.aggregate([
                { $match: { school: req.schoolId, paymentStatus: 'completed', ...(ay ? { academicYear: ay._id } : {}) } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
            ]),
            FeeLedger.aggregate([
                { $match: { school: req.schoolId, ...(ay ? { academicYear: ay._id } : {}) } },
                { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$entryType', 'debit'] }, '$amount', { $multiply: ['$amount', -1] }] } } } },
            ]),
            FeePayment.find({ school: req.schoolId })
                .populate('student', 'name rollNumber')
                .sort({ paymentDate: -1 })
                .limit(10)
                .lean(),
        ]);

        res.json({ success: true, data: {
            totalStudents,
            totalCollected: totalPayments[0]?.total || 0,
            totalTransactions: totalPayments[0]?.count || 0,
            pendingDues: pendingDues[0]?.total || 0,
            recentPayments,
        }});
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Fee Categories ────────────────────────────────────────────────────────────

exports.getFeeCategories = async (req, res) => {
    try {
        const cats = await FeeCategory.find({ school: req.schoolId }).sort({ name: 1 }).lean();
        res.json({ success: true, data: cats });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createFeeCategory = async (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name is required' });
        const taken = await FeeCategory.find({ school: req.schoolId }).select('name').lean();
        if (taken.some(c => c.name.toLowerCase() === name.trim().toLowerCase()))
            return bad(res, 'A category with this name already exists');
        const cat = await FeeCategory.create({
            school: req.schoolId, name: name.trim(), description: String(description || '').trim(),
            isActive: req.body.isActive !== false, createdBy: req.userId,
        });
        logFeeAudit(req, { action: 'created', entityType: 'FeeCategory', entityId: cat._id, after: cat });
        res.status(201).json({ success: true, data: cat });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, message: 'Category already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.updateFeeCategory = async (req, res) => {
    try {
        const { name, description } = req.body;
        const before = await FeeCategory.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return res.status(404).json({ success: false, message: 'Category not found' });
        const update = { updatedBy: req.userId };
        if (name !== undefined) {
            if (!String(name).trim()) return bad(res, 'Name is required');
            const taken = await FeeCategory.find({ school: req.schoolId, _id: { $ne: before._id } }).select('name').lean();
            if (taken.some(c => c.name.toLowerCase() === String(name).trim().toLowerCase()))
                return bad(res, 'A category with this name already exists');
            update.name = String(name).trim();
        }
        if (description !== undefined) update.description = String(description || '').trim();
        const cat = await FeeCategory.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, update, { new: true }).lean();
        logFeeAudit(req, { action: 'updated', entityType: 'FeeCategory', entityId: cat._id, before, after: cat });
        res.json({ success: true, data: cat });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleFeeCategory = async (req, res) => {
    try {
        const cat = await FeeCategory.findOne({ _id: req.params.id, school: req.schoolId });
        if (!cat) return res.status(404).json({ success: false, message: 'Category not found' });
        cat.isActive = !cat.isActive;
        cat.updatedBy = req.userId;
        await cat.save();
        // A category is a grouping, not a charge: switching it off keeps it
        // out of new fee heads but never stops the heads already in it. The
        // count goes back so the screen can say exactly that.
        const heads = await FeeHead.countDocuments({ school: req.schoolId, category: cat._id, isActive: true, isArchived: { $ne: true } });
        logFeeAudit(req, { action: cat.isActive ? 'activated' : 'deactivated', entityType: 'FeeCategory', entityId: cat._id, after: { name: cat.name, isActive: cat.isActive, activeHeads: heads } });
        res.json({ success: true, data: { ...cat.toObject(), activeHeads: heads } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Fee Heads ─────────────────────────────────────────────────────────────────

exports.getFeeHeads = async (req, res) => {
    try {
        const { isActive, includeArchived } = req.query;
        const filter = { school: req.schoolId };
        if (isActive !== undefined) filter.isActive = isActive !== 'false';
        // Archived heads leave every picker; the Fee Heads screen asks for them.
        if (includeArchived !== 'true') filter.isArchived = { $ne: true };

        const heads = await FeeHead.find(filter)
            .populate('category', 'name')
            .sort({ name: 1 })
            .lean();
        res.json({ success: true, data: heads });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createFeeHead = async (req, res) => {
    try {
        const { name, categoryId, type, defaultAmount, description, amountType } = req.body;
        if (!name?.trim() || !type) return res.status(400).json({ success: false, message: 'name and type are required' });
        if (!HEAD_TYPES.includes(type)) return bad(res, 'Choose how often this fee is charged');
        if (amountType !== undefined && !AMOUNT_TYPES.includes(amountType)) return bad(res, 'Choose fixed or variable');
        const amt = defaultAmount === undefined || defaultAmount === '' ? 0 : num(defaultAmount);
        if (!Number.isFinite(amt) || amt < 0) return bad(res, 'Enter a default amount of 0 or more');
        const cat = categoryId ? await FeeCategory.findOne({ _id: categoryId, school: req.schoolId }).lean() : null;
        if (categoryId && !cat) return bad(res, 'That category does not exist');
        if (cat && cat.isActive === false) return bad(res, `"${cat.name}" is switched off — switch it on, or pick another category`);

        const head = await FeeHead.create({
            school: req.schoolId, name: name.trim(), category: categoryId || null,
            type, amountType: amountType || 'fixed', defaultAmount: amt, description: description || '',
            isActive: req.body.isActive !== false, createdBy: req.userId,
        });
        logFeeAudit(req, { action: 'created', entityType: 'FeeHead', entityId: head._id, after: head });
        res.status(201).json({ success: true, data: head });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, message: 'Fee head already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.updateFeeHead = async (req, res) => {
    try {
        const { name, categoryId, type, defaultAmount, description, amountType } = req.body;
        const before = await FeeHead.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return res.status(404).json({ success: false, message: 'Fee head not found' });
        const update = { updatedBy: req.userId };
        if (name !== undefined) {
            if (!String(name).trim()) return bad(res, 'Name is required');
            update.name = String(name).trim();
        }
        if (categoryId !== undefined && String(categoryId || '') !== String(before.category || '')) {
            const cat = categoryId ? await FeeCategory.findOne({ _id: categoryId, school: req.schoolId }).lean() : null;
            if (categoryId && !cat) return bad(res, 'That category does not exist');
            // Moving a head INTO a switched-off category is refused; a head
            // already sitting in one can still be edited.
            if (cat && cat.isActive === false) return bad(res, `"${cat.name}" is switched off — switch it on, or pick another category`);
            update.category = categoryId || null;
        } else if (categoryId !== undefined) update.category = categoryId || null;
        if (type !== undefined && type !== before.type) {
            if (!HEAD_TYPES.includes(type)) return bad(res, 'Choose how often this fee is charged');
            // Charges are numbered by period within the head's frequency —
            // monthly period 3 is July, quarterly period 3 is January. Change
            // the frequency after charging and every later charge would land
            // on the wrong month, or be posted twice.
            const { rows } = await pool.query(
                `SELECT COUNT(*) AS n FROM "${FeeLedger.tableName}" l
                   JOIN "${FeeStructure.tableName}" fs ON fs."_id" = l."referenceId"
                  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fs."items") = 'array' THEN fs."items" ELSE '[]'::jsonb END) it
                  WHERE l."school" = $1 AND l."referenceType" = 'FeeStructure' AND l."category" = 'fee_charged'
                    AND l."feeItemId" IS NOT NULL AND (it->>'_id') = l."feeItemId"::text AND (it->>'feeHead') = $2`,
                [String(req.schoolId), String(before._id)]);
            if (Number(rows[0]?.n) > 0) return bad(res, `"${before.name}" has already charged students as a ${(FREQ_WORD[before.type] || before.type)} fee. Add a new fee head for the new frequency instead — changing it would move or repeat charges already on their accounts.`);
            update.type = type;
        } else if (type !== undefined) update.type = type;
        if (amountType !== undefined) {
            if (!AMOUNT_TYPES.includes(amountType)) return bad(res, 'Choose fixed or variable');
            update.amountType = amountType;
        }
        if (defaultAmount !== undefined) {
            const amt = num(defaultAmount);
            if (!Number.isFinite(amt) || amt < 0) return bad(res, 'Enter a default amount of 0 or more');
            update.defaultAmount = amt;
        }
        if (description !== undefined) update.description = description;
        if (req.body.isActive !== undefined) update.isActive = !!req.body.isActive;

        const head = await FeeHead.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, update, { new: true }).lean();
        logFeeAudit(req, { action: 'updated', entityType: 'FeeHead', entityId: head._id, before, after: head });
        res.json({ success: true, data: head });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Structures that would charge this head if it were on, and how far each has
 * charged. Used both to warn before switching a head off and to catch the
 * charging up when it comes back on.
 */
async function headStructures(schoolId, headId, { onlyPeriodic = false } = {}) {
    const { rows } = await pool.query(
        `SELECT DISTINCT fs."_id" FROM "${FeeStructure.tableName}" fs
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fs."items") = 'array' THEN fs."items" ELSE '[]'::jsonb END) it
          WHERE fs."school" = $1 AND fs."isActive" IS NOT FALSE
            AND COALESCE((it->>'isActive')::boolean, true) AND (it->>'feeHead') = $2
            ${onlyPeriodic ? 'AND fs."periodicSince" IS NOT NULL' : ''}`,
        [String(schoolId), String(headId)]);
    return FeeStructure.find({ _id: { $in: rows.map(r => r._id) } }).lean();
}

/** What switching this fee head off would touch — read by the dialog. */
exports.feeHeadImpact = async (req, res) => {
    try {
        const h = await FeeHead.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!h) return res.status(404).json({ success: false, message: 'Fee head not found' });
        const structures = await headStructures(req.schoolId, h._id);
        const { rows } = await pool.query(
            `SELECT COUNT(DISTINCT l."student") AS students, COALESCE(SUM(l."amount"), 0) AS charged,
                    to_char(MAX(COALESCE(l."periodStart", l."createdAt")), 'YYYY-MM') AS through
               FROM "${FeeLedger.tableName}" l
               JOIN "${FeeStructure.tableName}" fs ON fs."_id" = l."referenceId"
              CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fs."items") = 'array' THEN fs."items" ELSE '[]'::jsonb END) it
              WHERE l."school" = $1 AND l."referenceType" = 'FeeStructure' AND l."category" = 'fee_charged'
                AND l."feeItemId" IS NOT NULL AND (it->>'_id') = l."feeItemId"::text AND (it->>'feeHead') = $2`,
            [String(req.schoolId), String(h._id)]);
        // What it still charges this year, across the structures that use it.
        let toCome = 0, monthsToCome = 0;
        const now = Sched.monthKey(new Date());
        for (const st of structures) {
            const { items } = await charging.structurePeriods({ ...st, items: (st.items || []).map(i => ({ ...i, isActive: true })) });
            for (const { item, head, periods } of items) {
                if (String(head._id || item.feeHead) !== String(h._id) && String(item.feeHead) !== String(h._id)) continue;
                const ahead = periods.filter(p => p.month > now);
                toCome += ahead.length * (Number(item.amount) || 0);
                monthsToCome = Math.max(monthsToCome, ahead.length);
            }
        }
        res.json({ success: true, data: {
            isActive: h.isActive !== false, isArchived: !!h.isArchived,
            deactivatedAt: h.deactivatedAt || null, missedMonths: missedMonths(h),
            structures: structures.map(s => s.name),
            students: Number(rows[0]?.students) || 0,
            charged: Math.round((Number(rows[0]?.charged) || 0) * 100) / 100,
            chargedThrough: rows[0]?.through || null,
            toCome: Math.round(toCome * 100) / 100, monthsToCome,
        } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Switch a fee head off or on. Off means off: it stops charging in every
 * structure that carries it, the same meaning "off" has for a structure, and
 * it cannot be added to a new one. What it charged before stays on the
 * accounts it charged. Back on, the months it was off for are never billed
 * unless `catchUp` says to.
 */
exports.toggleFeeHead = async (req, res) => {
    try {
        const h = await FeeHead.findOne({ _id: req.params.id, school: req.schoolId });
        if (!h) return res.status(404).json({ success: false, message: 'Fee head not found' });
        if (h.isArchived) return bad(res, 'Restore this fee head before switching it on');
        const turningOff = h.isActive !== false;
        const out = { isActive: !turningOff };

        if (turningOff) {
            h.isActive = false;
            h.deactivatedAt = new Date();
        } else {
            const missed = missedMonths(h.toObject());
            if (missed.length && !req.body?.catchUp) {
                h.skippedMonths = [...new Set([...(h.skippedMonths || []), ...missed])];
                out.skipped = missed;
            }
            h.isActive = true;
            h.deactivatedAt = null;
        }
        h.updatedBy = req.userId;
        await h.save();

        if (!turningOff) {
            // Bring the structures that carry it up to this month now, rather
            // than leaving it to the hourly sweep.
            const structures = await headStructures(req.schoolId, h._id, { onlyPeriodic: true });
            let students = 0, amount = 0, entries = 0;
            for (const st of structures) {
                const r = await charging.chargeStructureNow({ schoolId: req.schoolId, structure: st, userId: req.userId });
                students = Math.max(students, r.students); amount += r.amount; entries += r.entries;
            }
            out.charged = { students, amount: Math.round(amount * 100) / 100, entries };
        }
        logFeeAudit(req, { action: h.isActive ? 'activated' : 'deactivated', entityType: 'FeeHead', entityId: h._id,
            after: { name: h.name, ...out } });
        res.json({ success: true, data: { ...h.toObject(), ...out } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// Archive takes a head out of every picker for good; restore brings it back
// switched off. Structures and ledger rows that already name it are untouched —
// last year's receipts must still say what was charged.
exports.archiveFeeHead = async (req, res) => {
    try {
        const h = await FeeHead.findOne({ _id: req.params.id, school: req.schoolId });
        if (!h) return res.status(404).json({ success: false, message: 'Fee head not found' });
        const archive = req.body?.archive !== false;
        if (archive) {
            const { rows } = await pool.query(
                `SELECT fs."name" FROM "${FeeStructure.tableName}" fs
                  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fs."items") = 'array' THEN fs."items" ELSE '[]'::jsonb END) it
                  WHERE fs."school" = $1 AND fs."isActive" IS NOT FALSE
                    AND COALESCE((it->>'isActive')::boolean, true) AND (it->>'feeHead') = $2
                  LIMIT 5`,
                [String(req.schoolId), String(req.params.id)]);
            if (rows.length) return bad(res, `Still charged by ${rows.length === 1 ? '' : rows.length + ' structures, including '}"${rows[0].name}". Take it off ${rows.length === 1 ? 'that structure' : 'those structures'} first, or just switch it off so it stays out of new ones.`);
        }
        h.isArchived = archive;
        h.archivedAt = archive ? new Date() : null;
        h.isActive = false;
        h.updatedBy = req.userId;
        await h.save();
        logFeeAudit(req, { action: archive ? 'archived' : 'restored', entityType: 'FeeHead', entityId: h._id, after: h });
        res.json({ success: true, data: h });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Fee Structures ────────────────────────────────────────────────────────────

exports.getFeeStructures = async (req, res) => {
    try {
        const { academicYearId } = req.query;
        const ay = academicYearId
            ? { _id: academicYearId }
            : await getActiveYear(req.schoolId);

        const structures = await FeeStructure.find({ school: req.schoolId, academicYear: ay?._id })
            .populate('class',        'className classNumber')
            .populate('section',      'sectionName')
            .populate('academicYear', 'yearName')
            .sort({ name: 1 })
            .lean();
        res.json({ success: true, data: structures });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createFeeStructure = async (req, res) => {
    try {
        const { name, level, classId, sectionId, dueDay, items, academicYearId, effectiveFrom, description } = req.body;
        if (!name?.trim() || !level) return res.status(400).json({ success: false, message: 'name and level are required' });

        const ay = academicYearId
            ? await AcademicYear.findOne({ _id: academicYearId, school: req.schoolId }).lean()
            : await getActiveYear(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: academicYearId ? 'That academic year does not exist' : 'No active academic year' });

        const eff = dayOrNull(effectiveFrom);
        const checked = await checkStructureInput(req.schoolId, ay, eff ? Sched.monthKey(eff) : null, { level, classId, sectionId, dueDay, items });
        if (checked.error) return bad(res, checked.error);

        const structure = await FeeStructure.create({
            school: req.schoolId, academicYear: ay._id, name: name.trim(), level,
            class: checked.classId, section: checked.sectionId,
            dueDay: checked.dueDay, items: checked.items, totalAmount: checked.total,
            effectiveFrom: eff, description: String(description || '').trim(),
            isActive: req.body.isActive !== false,
            createdBy: req.userId,
        });
        logFeeAudit(req, { action: 'created', entityType: 'FeeStructure', entityId: structure._id, after: structure });
        res.status(201).json({ success: true, data: structure });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * One place that decides whether a structure's target and items make sense.
 * A section-level structure is still pinned to its class (the resolver reads
 * the class to fall back on), so the class is taken from the section.
 *
 * Every item carries the months it is charged in (services/feeSchedule): a
 * start month and — for monthly, quarterly and half-yearly heads — a last
 * month, both inside `year`; the last month can never pass the year's last
 * day. A window left blank runs from `defaultStart` (else the year's first
 * month) to the year's last month, and is stored explicitly. `locked` maps
 * item ids to the start month they have already charged from: once a period
 * is on the ledger, moving the start would renumber every period after it.
 */
async function checkStructureInput(schoolId, year, defaultStart, { level, classId, sectionId, dueDay, items }, locked = null) {
    if (!['class', 'section'].includes(level)) return { error: 'Choose whether this is for a whole class or one section' };
    let cls = null, sec = null;
    if (level === 'section') {
        if (!sectionId) return { error: 'Choose a section' };
        sec = await ClassSection.findOne({ _id: sectionId, school: schoolId }).lean();
        if (!sec) return { error: 'That section does not exist' };
        cls = sec.class;
    } else {
        if (!classId) return { error: 'Choose a class' };
        const c = await Class.findOne({ _id: classId, school: schoolId }).lean();
        if (!c) return { error: 'That class does not exist' };
        cls = c._id;
    }
    let day = null;
    if (dueDay !== undefined && dueDay !== null && dueDay !== '') {
        day = Math.round(num(dueDay));
        if (!Number.isFinite(day) || day < 1 || day > 31) return { error: 'The due day must be between 1 and 31' };
    }
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { error: 'Add at least one fee head' };
    const bounds = Sched.yearBounds(year);
    let start0 = Sched.isMonthKey(defaultStart) ? defaultStart : bounds.first;
    if (start0 < bounds.first || start0 > bounds.last) start0 = bounds.first;
    const headIds = idList(list.map(i => i.feeHead));
    const heads = await FeeHead.find({ _id: { $in: headIds }, school: schoolId }).select('_id name type amountType defaultAmount isActive isArchived').lean();
    const byId = new Map(heads.map(h => [String(h._id), h]));
    const seen = new Set();
    const out = [];
    for (const i of list) {
        const h = byId.get(String(i.feeHead));
        if (!h) return { error: 'One of the fee heads does not exist' };
        if (seen.has(String(h._id))) return { error: 'A fee head appears twice' };
        seen.add(String(h._id));
        // A head that is switched off charges nothing, so it cannot be ADDED
        // to a structure. One already on the structure stays put — otherwise
        // switching a head off would make its structures uneditable.
        const isNew = !(i._id && isUuid(String(i._id)));
        if (isNew && (h.isArchived || h.isActive === false)) {
            return { error: `"${h.name}" is switched off, so it would charge nothing. Switch it on first, or pick another fee head.` };
        }
        // A fixed head always charges its own amount; only a variable head is priced here.
        const amount = h.amountType === 'fixed' && i.amount === undefined ? h.defaultAmount : num(i.amount);
        if (!Number.isFinite(amount) || amount < 0) return { error: 'Every fee head needs an amount of 0 or more' };
        const bad = Sched.checkWindow(i, h.type, bounds, h.name);
        if (bad) return { error: bad };
        const startMonth = Sched.isMonthKey(i.startMonth) ? i.startMonth : start0;
        const endMonth = Sched.isPeriodic(h.type) ? (Sched.isMonthKey(i.endMonth) ? i.endMonth : bounds.last) : startMonth;
        if (endMonth < startMonth) return { error: `${h.name} ends before it starts` };
        const id = i._id && isUuid(String(i._id)) ? String(i._id) : null;
        if (id && locked && locked.has(id) && locked.get(id) !== startMonth) {
            return { error: `${h.name} has already been charged from ${Sched.monthLabel(locked.get(id))} — its start month cannot move now. Change its last month or amount instead.` };
        }
        out.push({ ...(id ? { _id: id } : {}), feeHead: h._id, amount, isActive: i.isActive !== false, startMonth, endMonth });
    }
    const typeOf = (hid) => byId.get(String(hid))?.type;
    const total = Sched.annualTotal(out, typeOf, bounds);
    return { classId: cls, sectionId: sec?._id || null, dueDay: day, items: out, total };
}

exports.getFeeStructureDetail = async (req, res) => {
    try {
        const s = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('items.feeHead', 'name type')
            .populate('class',   'className')
            .populate('section', 'sectionName')
            .lean();
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });
        res.json({ success: true, data: s });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateFeeStructure = async (req, res) => {
    try {
        const { name, dueDay, items, effectiveFrom, description } = req.body;
        const s = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId });
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });
        const before = s.toObject();

        if (name !== undefined) {
            if (!String(name).trim()) return bad(res, 'Name is required');
            s.name = String(name).trim();
        }
        // Who a structure is for can move until it has charged anyone; after
        // that the demand already on the ledger would be for the wrong group.
        const retarget = ['level', 'classId', 'sectionId'].some(k => req.body[k] !== undefined);
        const year = await AcademicYear.findById(s.academicYear).lean();
        if (!year) return bad(res, 'This structure\'s academic year no longer exists');
        // Items saved before windows existed start where the structure first
        // charged; once anything is charged, a head's start month is fixed.
        const fallback = await legacyStart(s.toObject());
        // Only month-by-month charges are numbered by period; a structure
        // charged as one lump (before Sep 2026) can still move its start —
        // the lump stands for the first period wherever that falls.
        let locked = null;
        if (s.periodicSince) {
            const bounds = Sched.yearBounds(year);
            locked = new Map((s.items || []).map(i => [String(i._id), Sched.windowFor(i, null, bounds, fallback).start]));
        }
        // A head appears at most once in a structure, so the head IS the
        // item's identity. A caller that sends items without their ids (the
        // mobile app, an import) would otherwise add a second copy of every
        // head and leave the charged originals behind, switched off.
        const idByHead = new Map((s.items || []).map(i => [String(i.feeHead?._id || i.feeHead), String(i._id)]));
        const withIds = items === undefined ? null : items.map(i => (
            i && !i._id && idByHead.has(String(i.feeHead)) ? { ...i, _id: idByHead.get(String(i.feeHead)) } : i));

        const checked = await checkStructureInput(req.schoolId, year, fallback || (s.effectiveFrom ? Sched.monthKey(s.effectiveFrom) : null), {
            level:     req.body.level     ?? s.level,
            classId:   req.body.classId   ?? s.class,
            sectionId: req.body.sectionId ?? s.section,
            dueDay:    dueDay !== undefined ? dueDay : s.dueDay,
            items:     withIds || (s.items || []).map(i => ({ _id: i._id, feeHead: i.feeHead, amount: i.amount, isActive: i.isActive, startMonth: i.startMonth, endMonth: i.endMonth })),
        }, locked);
        if (checked.error) return bad(res, checked.error);

        // A head that has charged somebody is never dropped: its charges are
        // on students' accounts and the fee book has to keep explaining them.
        // Taking it off the structure switches it off instead.
        const chargedItems = await chargedItemMonths(req.schoolId, s._id);
        const notes = [];
        if (chargedItems.size) {
            const keptIds = new Set(checked.items.map(i => String(i._id || '')));
            for (const old of (s.items || [])) {
                const info = chargedItems.get(String(old._id));
                if (!info || keptIds.has(String(old._id))) continue;
                checked.items.push({ _id: old._id, feeHead: old.feeHead, amount: old.amount, isActive: false,
                    startMonth: old.startMonth, endMonth: old.endMonth });
                notes.push('A fee head that has already charged students was switched off rather than removed — its charges stay on their accounts.');
            }
            for (const it of checked.items) {
                const info = chargedItems.get(String(it._id || ''));
                if (!info || it.isActive === false) continue;
                if (it.endMonth && it.endMonth < info.lastMonth) {
                    const head = await FeeHead.findById(it.feeHead).select('name').lean();
                    return bad(res, `${head?.name || 'That fee head'} has already been charged up to ${Sched.monthLabel(info.lastMonth)} — its last month cannot be earlier.`);
                }
            }
        }
        if (retarget) {
            const moved = String(checked.classId || '') !== String(s.class || '') || String(checked.sectionId || '') !== String(s.section || '') || (req.body.level ?? s.level) !== s.level;
            if (moved && s.demandGeneratedAt) return bad(res, 'Fees have already been charged from this structure — create a new one for a different class or section');
            s.level = req.body.level ?? s.level;
            s.class = checked.classId;
            s.section = checked.sectionId;
        }
        s.dueDay = checked.dueDay;
        s.items = checked.items;
        s.totalAmount = checked.total;
        if (effectiveFrom !== undefined) s.effectiveFrom = dayOrNull(effectiveFrom);
        if (description !== undefined) s.description = String(description || '').trim();
        if (req.body.isActive !== undefined) s.isActive = !!req.body.isActive;
        s.updatedBy = req.userId;
        await s.save();
        logFeeAudit(req, { action: 'updated', entityType: 'FeeStructure', entityId: s._id, before, after: s });
        res.json({ success: true, data: s, notes: [...new Set(notes)] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/** Per fee head of a structure: how many charges it has posted, and up to which month. */
async function chargedItemMonths(schoolId, structureId) {
    const { rows } = await pool.query(
        `SELECT l."feeItemId" AS id, COUNT(*) AS n, MAX(COALESCE(l."periodStart", l."createdAt")) AS last
           FROM "${FeeLedger.tableName}" l
          WHERE l."school" = $1 AND l."referenceType" = 'FeeStructure' AND l."referenceId" = $2
            AND l."category" = 'fee_charged' AND l."feeItemId" IS NOT NULL
          GROUP BY 1`,
        [String(schoolId), String(structureId)]);
    return new Map(rows.map(r => [String(r.id), { count: Number(r.n) || 0, lastMonth: Sched.monthKey(r.last) }]));
}

/** What switching this structure off would affect — read by the dialog. */
exports.structureImpact = async (req, res) => {
    try {
        const st = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!st) return res.status(404).json({ success: false, message: 'Structure not found' });
        const impact = await charging.structureImpact(req.schoolId, st);
        const missed = missedMonths(st);
        res.json({ success: true, data: { ...impact, isActive: st.isActive !== false, periodic: !!st.periodicSince,
            deactivatedAt: st.deactivatedAt || null, missedMonths: missed } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/** The months between a structure being switched off and now. */
function missedMonths(st) {
    if (!st.deactivatedAt) return [];
    const from = Sched.monthKey(st.deactivatedAt);
    const now = Sched.monthKey(new Date());
    const out = [];
    for (let k = from, i = 0; k < now && i < 24; k = Sched.addMonths(k, 1), i++) out.push(k);
    return out;
}

/**
 * Switch a structure off or on.
 *
 * Off: it charges nothing more — the sweep skips it and demand cannot be
 * generated — but what it has already charged stays owed, because that money
 * was really billed. `cancelUnpaid` drops the part nobody has paid yet, as a
 * cancellation against each charge, so the fee book shows those months
 * cancelled instead of owing.
 *
 * On: the months it was off are NOT billed retrospectively unless `catchUp`
 * says so; otherwise they are remembered as skipped and charging resumes
 * with the current month, which is charged straight away rather than waiting
 * for the next sweep.
 */
exports.toggleFeeStructure = async (req, res) => {
    try {
        const s = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId });
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });
        const turningOff = s.isActive !== false;
        const out = { isActive: !turningOff };

        if (turningOff) {
            s.isActive = false;
            s.deactivatedAt = new Date();
            s.updatedBy = req.userId;
            await s.save();
            if (req.body?.cancelUnpaid) {
                const c = await charging.cancelUnpaidCharges({ schoolId: req.schoolId, structure: s.toObject(), userId: req.userId });
                out.cancelled = c;
            }
        } else {
            const missed = missedMonths(s.toObject());
            if (missed.length && !req.body?.catchUp) {
                // Remember the gap, so the sweep does not bill it later.
                s.skippedMonths = [...new Set([...(s.skippedMonths || []), ...missed])];
                out.skipped = missed;
            }
            s.isActive = true;
            s.deactivatedAt = null;
            s.updatedBy = req.userId;
            await s.save();
            if (s.periodicSince) {
                // Bring everyone up to the current month now, not in an hour.
                out.charged = await charging.chargeStructureNow({ schoolId: req.schoolId, structure: s.toObject(), userId: req.userId });
            }
        }
        logFeeAudit(req, { action: turningOff ? 'deactivated' : 'activated', entityType: 'FeeStructure', entityId: s._id,
            after: { name: s.name, ...out } });
        res.json({ success: true, data: { ...s.toObject(), ...out } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Delete a structure — only while it has charged nobody. Once a charge is on
 * a student's ledger the structure is the record of what they were billed
 * for, so it is switched off instead.
 */
exports.deleteFeeStructure = async (req, res) => {
    try {
        const s = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });
        const charged = await FeeLedger.countDocuments({ school: req.schoolId, referenceType: 'FeeStructure', referenceId: s._id, category: 'fee_charged' });
        if (charged) return bad(res, 'This structure has already charged students, so it cannot be deleted. Switch it off instead — what it charged stays on their accounts.');
        await StudentFeeAssignment.deleteMany({ school: req.schoolId, feeStructure: s._id });
        await FeeStructure.deleteOne({ _id: s._id });
        logFeeAudit(req, { action: 'deleted', entityType: 'FeeStructure', entityId: s._id, before: s });
        res.json({ success: true, data: { deleted: true } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * The students a structure charges: everyone in its section, or in any section
 * of its class, read from BOTH places membership is recorded — the profile's
 * section pointer and the section's enrolledStudents. The fee resolver reads
 * the profile, so a student present only there used to be charged by nobody.
 */
async function structureStudents(schoolId, structure) {
    const where = structure.level === 'section'
        ? `cs."_id" = $2`
        : `cs."class" = $2`;
    const target = structure.level === 'section' ? structure.section : structure.class;
    if (!target) return [];
    const { rows } = await pool.query(
        `WITH secs AS (
             SELECT cs."_id", cs."enrolledStudents" FROM "${ClassSection.tableName}" cs
              WHERE cs."school" = $1 AND ${where}
         ), members AS (
             SELECT sp."user" AS id FROM "${StudentProfile.tableName}" sp JOIN secs ON secs."_id" = sp."currentSection"
             UNION
             SELECT e.id::uuid FROM secs
              CROSS JOIN LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(secs."enrolledStudents") = 'array' THEN secs."enrolledStudents" ELSE '[]'::jsonb END) AS e(id)
              WHERE e.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         )
         SELECT DISTINCT m.id FROM members m
           JOIN "${User.tableName}" u ON u."_id" = m.id
          WHERE u."school" = $1 AND u."role" = 'student' AND u."isActive" IS NOT FALSE`,
        [String(schoolId), String(target)],
    );
    return rows.map(r => String(r.id));
}

/**
 * Charge a structure's students everything that has fallen due so far — one
 * ledger row per head per period (services/feeCharging) — and from then on
 * the hourly sweep charges each new month as it arrives. Run again, it picks
 * up students who joined the class since; nothing is ever charged twice.
 *
 * A student is charged by ONE structure. Anyone already on another structure
 * that is still running is left alone (the fee book resolves to that one), as
 * is anyone whose section has its own structure when this is a class-wide
 * one. `newFrom: 'current'` starts students new to this structure at this
 * month instead of the structure's first month — a mid-year admission should
 * not be billed for the months before they arrived.
 */
exports.generateFeeDemand = async (req, res) => {
    try {
        const structure = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!structure) return res.status(404).json({ success: false, message: 'Structure not found' });
        if (!structure.isActive) return bad(res, 'Switch this structure on before charging from it');
        if (!(structure.items || []).some(i => i.isActive !== false && Number(i.amount) > 0)) return bad(res, 'This structure charges nothing — add fee heads with amounts first');

        const ay = await AcademicYear.findById(structure.academicYear).lean();
        if (!ay) return res.status(400).json({ success: false, message: 'Academic year not found' });

        const roster = await structureStudents(req.schoolId, structure);
        if (!roster.length) return res.json({ success: true, message: 'No students to generate demand for', generated: 0 });

        // Sections of this class that run their own structure: the fee book
        // resolves those students to it, so this one must not charge them.
        let ownSection = new Set();
        if (structure.level === 'class') {
            const sectionStructures = await FeeStructure.find({
                school: req.schoolId, academicYear: structure.academicYear, level: 'section', isActive: true,
            }).select('section').lean();
            const ids = sectionStructures.map(x => String(x.section)).filter(Boolean);
            if (ids.length) {
                const { rows } = await pool.query(
                    `SELECT sp."user" AS id FROM "${StudentProfile.tableName}" sp
                      WHERE sp."school" = $1 AND sp."currentSection" = ANY($2::uuid[])`,
                    [String(req.schoolId), ids]);
                ownSection = new Set(rows.map(r => String(r.id)));
            }
        }

        const assignments = await StudentFeeAssignment.find({
            school: req.schoolId, student: { $in: roster }, academicYear: structure.academicYear,
        }).lean();
        const byStudent = new Map(assignments.map(a => [String(a.student), a]));
        const otherIds = [...new Set(assignments.map(a => String(a.feeStructure || '')).filter(id => id && id !== String(structure._id)))];
        const others = otherIds.length ? await FeeStructure.find({ _id: { $in: otherIds } }).select('isActive name').lean() : [];
        const otherActive = new Map(others.map(o => [String(o._id), o.isActive !== false]));

        const thisMonth = Sched.monthKey(new Date());
        const fromMonth = req.body?.newFrom === 'current' ? thisMonth : null;
        const charge = [];
        const skipped = { otherStructure: 0, sectionStructure: 0 };
        const fresh = [];
        for (const id of roster) {
            if (ownSection.has(id)) { skipped.sectionStructure++; continue; }
            const a = byStudent.get(id);
            if (a && String(a.feeStructure || '') === String(structure._id)) { charge.push(id); continue; }
            if (a && a.feeStructure && otherActive.get(String(a.feeStructure))) { skipped.otherStructure++; continue; }
            // No structure of their own, or one that has been switched off.
            fresh.push(id);
            charge.push(id);
        }
        for (const id of fresh) {
            const a = byStudent.get(id);
            if (a) await StudentFeeAssignment.updateOne({ _id: a._id }, { feeStructure: structure._id, totalAmount: structure.totalAmount, fromMonth });
            else await StudentFeeAssignment.create({
                school: req.schoolId, student: id, academicYear: structure.academicYear,
                feeStructure: structure._id, totalAmount: structure.totalAmount, fromMonth, createdBy: req.userId,
            });
        }
        if (!charge.length) {
            return res.json({ success: true, generated: 0, skipped, newStudents: 0,
                message: skipped.otherStructure || skipped.sectionStructure
                    ? 'Every student here is charged by another structure'
                    : 'No students to generate demand for' });
        }

        const out = await postDueCharges({ schoolId: req.schoolId, structure, studentIds: charge, userId: req.userId });
        const starts = (structure.items || []).map(i => i.startMonth).filter(Sched.isMonthKey).sort();
        await FeeStructure.updateOne({ _id: structure._id }, {
            demandGeneratedAt: new Date(),
            demandStartedAt: structure.demandStartedAt || (starts[0] ? Sched.monthStart(starts[0]) : new Date()),
            periodicSince: structure.periodicSince || new Date(),
        });
        logFeeAudit(req, { action: 'demand_generated', entityType: 'FeeStructure', entityId: structure._id,
            after: { generated: out.students, entries: out.entries, amount: out.amount, concession: out.concession, skipped, newStudents: fresh.length } });
        res.json({
            success: true, generated: out.students, entries: out.entries, amount: out.amount, concession: out.concession,
            skipped, newStudents: fresh.length,
            message: out.students ? undefined : 'Everyone here is already charged up to this month',
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Add one head to a structure. It used to push straight onto the array — no
 * school check on the head (so another school's head could be attached), no
 * charging window, and a total added up as if every head charged once. It now
 * goes through the same rule every other edit does.
 */
exports.addFeeHeadToStructure = async (req, res) => {
    try {
        const { feeHead, amount, startMonth, endMonth } = req.body;
        if (!feeHead || amount === undefined) return bad(res, 'Choose a fee head and an amount');

        const s = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId });
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });
        const year = await AcademicYear.findById(s.academicYear).lean();
        if (!year) return bad(res, 'That structure has no academic year');
        if ((s.items || []).some(i => String(i.feeHead) === String(feeHead)))
            return bad(res, 'That fee head is already on this structure');

        const fallback = await charging.legacyStart(s.toObject());
        const checked = await checkStructureInput(req.schoolId, year, fallback || (s.effectiveFrom ? Sched.monthKey(s.effectiveFrom) : null), {
            level: s.level, classId: s.class, sectionId: s.section, dueDay: s.dueDay,
            items: [
                ...(s.items || []).map(i => ({ _id: i._id, feeHead: i.feeHead, amount: i.amount, isActive: i.isActive, startMonth: i.startMonth, endMonth: i.endMonth })),
                { feeHead, amount, startMonth, endMonth },
            ],
        });
        if (checked.error) return bad(res, checked.error);
        s.items = checked.items;
        s.totalAmount = checked.totalAmount;
        s.updatedBy = req.userId;
        await s.save();
        logFeeAudit(req, { action: 'updated', entityType: 'FeeStructure', entityId: s._id, after: { name: s.name, addedHead: String(feeHead) } });
        res.json({ success: true, data: s.toObject() });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

async function computeRunningBalance(schoolId, studentId, academicYearId, newDebit = 0) {
    const agg = await FeeLedger.aggregate([
        { $match: { school: schoolId, student: studentId, academicYear: academicYearId } },
        { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$entryType', 'debit'] }, '$amount', { $multiply: ['$amount', -1] }] } } } },
    ]);
    return (agg[0]?.total || 0) + newDebit;
}

// ── Fine Rules ────────────────────────────────────────────────────────────────

exports.getFineRules = async (req, res) => {
    try {
        const rules = await FineRule.find({ school: req.schoolId }).sort({ name: 1 }).lean();
        res.json({ success: true, data: rules });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * The fields a fine rule may be written with, checked. `partial` allows a
 * subset (an edit); a create must name its type and amount.
 */
async function fineRuleFields(schoolId, body, partial = false) {
    const out = {};
    if (body.name !== undefined || !partial) {
        if (!String(body.name || '').trim()) return { error: 'Name is required' };
        out.name = String(body.name).trim();
    }
    if (body.ruleType !== undefined) {
        if (!['late_payment', 'other'].includes(body.ruleType)) return { error: 'Choose late payment or other fine' };
        out.ruleType = body.ruleType;
    }
    if (body.fineType !== undefined || !partial) {
        if (!['flat', 'per_day'].includes(body.fineType)) return { error: 'Choose a fixed amount or an amount per day' };
        out.fineType = body.fineType;
    }
    for (const k of ['flatAmount', 'perDayAmount', 'gracePeriodDays', 'maxCap']) {
        if (body[k] === undefined) continue;
        const n = body[k] === '' ? 0 : num(body[k]);
        if (!Number.isFinite(n) || n < 0) return { error: 'Amounts and days must be 0 or more' };
        out[k] = n;
    }
    const kind = out.fineType ?? body._currentFineType;
    if (kind === 'flat' && out.flatAmount !== undefined && !(out.flatAmount > 0)) return { error: 'Enter the fine amount' };
    if (kind === 'per_day' && out.perDayAmount !== undefined && !(out.perDayAmount > 0)) return { error: 'Enter the amount charged per day' };
    if (!partial && kind === 'flat' && !(out.flatAmount > 0)) return { error: 'Enter the fine amount' };
    if (!partial && kind === 'per_day' && !(out.perDayAmount > 0)) return { error: 'Enter the amount charged per day' };
    if (body.appliesTo !== undefined) {
        if (!FINE_APPLIES_TO.includes(body.appliesTo)) return { error: 'Choose who the rule applies to' };
        out.appliesTo = body.appliesTo;
    }
    if (body.classes !== undefined) {
        const ids = idList(body.classes);
        const found = ids.length ? await Class.find({ _id: { $in: ids }, school: schoolId }).select('_id').lean() : [];
        out.classes = found.map(c => c._id);
    }
    if ((out.appliesTo ?? body._currentAppliesTo) === 'classes' && body.classes !== undefined && !(out.classes || []).length)
        return { error: 'Pick the classes this rule applies to' };
    if (body.applicableCategories !== undefined) out.applicableCategories = (body.applicableCategories || []).map(String);
    if (body.description !== undefined) out.description = String(body.description || '').trim();
    if (body.isActive !== undefined) out.isActive = !!body.isActive;
    return { fields: out };
}

exports.createFineRule = async (req, res) => {
    try {
        const { fields, error } = await fineRuleFields(req.schoolId, req.body);
        if (error) return bad(res, error);
        const taken = await FineRule.find({ school: req.schoolId }).select('name').lean();
        if (taken.some(r => r.name.toLowerCase() === fields.name.toLowerCase())) return bad(res, 'A fine rule with this name already exists');
        const rule = await FineRule.create({ school: req.schoolId, ruleType: 'late_payment', appliesTo: 'all', ...fields, createdBy: req.userId });
        logFeeAudit(req, { action: 'created', entityType: 'FineRule', entityId: rule._id, after: rule });
        res.status(201).json({ success: true, data: rule });
    } catch (e) {
        if (e.code === 11000 || e.code === '23505') return res.status(400).json({ success: false, message: 'Fine rule already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.updateFineRule = async (req, res) => {
    try {
        const before = await FineRule.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return res.status(404).json({ success: false, message: 'Fine rule not found' });
        // Only these fields — this handler used to write the request body
        // straight onto the row, school and all.
        const { fields, error } = await fineRuleFields(req.schoolId,
            { ...req.body, _currentFineType: before.fineType, _currentAppliesTo: before.appliesTo }, true);
        if (error) return bad(res, error);
        if (fields.name && fields.name.toLowerCase() !== before.name.toLowerCase()) {
            const taken = await FineRule.find({ school: req.schoolId, _id: { $ne: before._id } }).select('name').lean();
            if (taken.some(r => r.name.toLowerCase() === fields.name.toLowerCase())) return bad(res, 'A fine rule with this name already exists');
        }
        const rule = await FineRule.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { ...fields, updatedBy: req.userId }, { new: true }).lean();
        logFeeAudit(req, { action: 'updated', entityType: 'FineRule', entityId: rule._id, before, after: rule });
        res.json({ success: true, data: rule });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleFineRule = async (req, res) => {
    try {
        const r = await FineRule.findOne({ _id: req.params.id, school: req.schoolId });
        if (!r) return res.status(404).json({ success: false, message: 'Fine rule not found' });
        r.isActive = !r.isActive;
        r.updatedBy = req.userId;
        await r.save();
        logFeeAudit(req, { action: r.isActive ? 'activated' : 'deactivated', entityType: 'FineRule', entityId: r._id, after: r });
        res.json({ success: true, data: r });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Concessions ───────────────────────────────────────────────────────────────

exports.getConcessions = async (req, res) => {
    try {
        const cons = await FeeConcession.find({ school: req.schoolId }).sort({ name: 1 }).lean();
        res.json({ success: true, data: cons });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

async function concessionFields(schoolId, body, partial = false) {
    const out = {};
    if (body.name !== undefined || !partial) {
        if (!String(body.name || '').trim()) return { error: 'Name is required' };
        out.name = String(body.name).trim();
    }
    if (body.concessionType !== undefined || !partial) {
        if (!['percentage', 'fixed'].includes(body.concessionType)) return { error: 'Choose a percentage or a fixed amount' };
        out.concessionType = body.concessionType;
    }
    if (body.value !== undefined || !partial) {
        const v = num(body.value);
        if (!Number.isFinite(v) || v <= 0) return { error: 'Enter the discount' };
        const type = out.concessionType ?? body._currentType;
        if (type === 'percentage' && v > 100) return { error: 'A percentage cannot be more than 100' };
        out.value = v;
    }
    if (body.applicableTo !== undefined) {
        if (!['all', 'specific_heads'].includes(body.applicableTo)) return { error: 'Choose which fee heads it covers' };
        out.applicableTo = body.applicableTo;
    }
    if (body.applicableHeads !== undefined) {
        const ids = idList(body.applicableHeads);
        const found = ids.length ? await FeeHead.find({ _id: { $in: ids }, school: schoolId }).select('_id').lean() : [];
        out.applicableHeads = found.map(h => h._id);
    }
    if ((out.applicableTo ?? body._currentApplicableTo) === 'specific_heads' && body.applicableHeads !== undefined && !(out.applicableHeads || []).length)
        return { error: 'Pick the fee heads this concession covers' };
    if (body.eligibility !== undefined) {
        if (!ELIGIBILITY.includes(body.eligibility)) return { error: 'Choose who this concession is for' };
        out.eligibility = body.eligibility;
    }
    if (body.validFrom !== undefined) out.validFrom = dayOrNull(body.validFrom);
    if (body.validTo !== undefined) out.validTo = dayOrNull(body.validTo);
    const from = out.validFrom !== undefined ? out.validFrom : body._currentFrom;
    const to   = out.validTo   !== undefined ? out.validTo   : body._currentTo;
    if (from && to && new Date(to) < new Date(from)) return { error: 'The end date is before the start date' };
    if (body.description !== undefined) out.description = String(body.description || '').trim();
    if (body.isActive !== undefined) out.isActive = !!body.isActive;
    return { fields: out };
}

exports.createConcession = async (req, res) => {
    try {
        const { fields, error } = await concessionFields(req.schoolId, req.body);
        if (error) return bad(res, error);
        const taken = await FeeConcession.find({ school: req.schoolId }).select('name').lean();
        if (taken.some(c => c.name.toLowerCase() === fields.name.toLowerCase())) return bad(res, 'A concession with this name already exists');
        const c = await FeeConcession.create({ school: req.schoolId, applicableTo: 'all', ...fields, createdBy: req.userId });
        logFeeAudit(req, { action: 'created', entityType: 'FeeConcession', entityId: c._id, after: c });
        res.status(201).json({ success: true, data: c });
    } catch (e) {
        if (e.code === 11000 || e.code === '23505') return res.status(400).json({ success: false, message: 'Concession already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.updateConcession = async (req, res) => {
    try {
        const before = await FeeConcession.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!before) return res.status(404).json({ success: false, message: 'Concession not found' });
        // Whitelisted — this used to write the request body straight onto the row.
        const { fields, error } = await concessionFields(req.schoolId, {
            ...req.body, _currentType: before.concessionType, _currentApplicableTo: before.applicableTo,
            _currentFrom: before.validFrom, _currentTo: before.validTo,
        }, true);
        if (error) return bad(res, error);
        if (fields.name && fields.name.toLowerCase() !== before.name.toLowerCase()) {
            const taken = await FeeConcession.find({ school: req.schoolId, _id: { $ne: before._id } }).select('name').lean();
            if (taken.some(c => c.name.toLowerCase() === fields.name.toLowerCase())) return bad(res, 'A concession with this name already exists');
        }
        const c = await FeeConcession.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, { ...fields, updatedBy: req.userId }, { new: true }).lean();
        logFeeAudit(req, { action: 'updated', entityType: 'FeeConcession', entityId: c._id, before, after: c });
        res.json({ success: true, data: c });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleConcession = async (req, res) => {
    try {
        const c = await FeeConcession.findOne({ _id: req.params.id, school: req.schoolId });
        if (!c) return res.status(404).json({ success: false, message: 'Concession not found' });
        c.isActive = !c.isActive;
        c.updatedBy = req.userId;
        await c.save();
        logFeeAudit(req, { action: c.isActive ? 'activated' : 'deactivated', entityType: 'FeeConcession', entityId: c._id, after: c });
        res.json({ success: true, data: c });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Student Fees ──────────────────────────────────────────────────────────────

exports.getStudentFees = async (req, res) => {
    try {
        const { q, search, page = 1, limit = 20 } = req.query;
        const term = q || search;
        const ay = await getActiveYear(req.schoolId);

        const userFilter = { school: req.schoolId, role: 'student', isActive: true };
        if (term) userFilter.$or = [{ name: { $regex: term, $options: 'i' } }, { email: { $regex: term, $options: 'i' } }];

        const [students, total] = await Promise.all([
            User.find(userFilter).select('name email rollNumber').sort({ name: 1 }).skip((+page - 1) * +limit).limit(+limit).lean(),
            User.countDocuments(userFilter),
        ]);

        const studentIds = students.map(s => s._id);
        const [assignments, payments, profiles] = await Promise.all([
            StudentFeeAssignment.find({ school: req.schoolId, student: { $in: studentIds }, academicYear: ay?._id }).lean(),
            FeePayment.aggregate([
                { $match: { school: req.schoolId, student: { $in: studentIds }, paymentStatus: 'completed', academicYear: ay?._id } },
                { $group: { _id: '$student', paid: { $sum: '$amount' } } },
            ]),
            StudentProfile.find({ user: { $in: studentIds }, school: req.schoolId })
                .select('user currentSection rollNumber')
                .populate({ path: 'currentSection', select: 'sectionName class', populate: { path: 'class', select: 'className' } })
                .lean(),
        ]);

        const assignMap = Object.fromEntries(assignments.map(a => [a.student.toString(), a]));
        const paidMap   = Object.fromEntries(payments.map(p => [p._id.toString(), p.paid]));
        const profMap   = Object.fromEntries(profiles.map(p => [p.user.toString(), p]));

        const data = students.map(s => {
            const asgn  = assignMap[s._id.toString()];
            const prof  = profMap[s._id.toString()];
            const total = asgn?.totalAmount || 0;
            const paid  = paidMap[s._id.toString()] || 0;
            const due   = total - paid;
            const status = total === 0 ? 'unpaid'
                : due <= 0 ? 'paid'
                : paid > 0 ? 'partial'
                : 'unpaid';
            return {
                _id: s._id,
                student: {
                    _id: s._id,
                    name: s.name,
                    email: s.email,
                    rollNumber: prof?.rollNumber || s.rollNumber || '',
                    class:   prof?.currentSection?.class ? { name: prof.currentSection.class.className } : null,
                    section: prof?.currentSection ? { name: prof.currentSection.sectionName } : null,
                },
                totalAmount: total,
                paidAmount:  paid,
                dueAmount:   due,
                status,
            };
        });
        res.json({ success: true, data, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getStudentFeeDetail = async (req, res) => {
    try {
        const ay = await getActiveYear(req.schoolId);
        const student = await User.findOne({ _id: req.params.studentId, school: req.schoolId }).lean();
        if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

        const [assignment, concessions, payments] = await Promise.all([
            StudentFeeAssignment.findOne({ school: req.schoolId, student: req.params.studentId, academicYear: ay?._id })
                .populate('feeStructure').lean(),
            StudentConcession.find({ school: req.schoolId, student: req.params.studentId, academicYear: ay?._id, isActive: true })
                .populate('concession').lean(),
            FeePayment.find({ school: req.schoolId, student: req.params.studentId }).sort({ paymentDate: -1 }).lean(),
        ]);

        const paid = payments.filter(p => p.paymentStatus === 'completed').reduce((s, p) => s + p.amount, 0);
        res.json({ success: true, data: { student, assignment, concessions, payments, paid, balance: (assignment?.totalAmount || 0) - paid } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getStudentLedger = async (req, res) => {
    try {
        const ay = await getActiveYear(req.schoolId);
        const entries = await FeeLedger.find({ school: req.schoolId, student: req.params.studentId, academicYear: ay?._id })
            .sort({ createdAt: -1 })
            .lean();
        res.json({ success: true, data: entries });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Give one concession to a set of students for the active year, applying it
 * to whatever they have already been charged. Shared by the per-student
 * drawer and the concession's bulk "assign" dialog. Students who already hold
 * it are skipped, not doubled.
 */
async function assignConcessionTo(req, concessionId, studentIds, { validFrom, validTo, remarks } = {}) {
    const ay = await getActiveYear(req.schoolId);
    if (!ay) return { error: 'No active academic year' };
    const c = await FeeConcession.findOne({ _id: concessionId, school: req.schoolId }).lean();
    if (!c) return { error: 'That concession does not exist' };
    if (!c.isActive) return { error: 'Switch this concession on before assigning it' };
    const ids = idList(studentIds);
    if (!ids.length) return { error: 'Choose at least one student' };
    const students = await User.find({ _id: { $in: ids }, school: req.schoolId, role: 'student' }).select('_id').lean();
    const valid = students.map(u => String(u._id));
    const held = await StudentConcession.find({ school: req.schoolId, academicYear: ay._id, concession: c._id, student: { $in: valid }, isActive: true }).select('student').lean();
    const skip = new Set(held.map(h => String(h.student)));

    let assigned = 0, credited = 0;
    for (const studentId of valid) {
        if (skip.has(studentId)) continue;
        const sc = await StudentConcession.create({
            school: req.schoolId, student: studentId, academicYear: ay._id, concession: c._id,
            validFrom: dayOrNull(validFrom), validTo: dayOrNull(validTo), remarks: remarks || '',
            approvedBy: req.userId, createdBy: req.userId,
        });
        credited += await applyStudentConcessions({ schoolId: req.schoolId, studentId, academicYearId: ay._id, userId: req.userId });
        assigned++;
        void sc;
    }
    if (assigned) {
        logFeeAudit(req, { action: 'assigned', entityType: 'FeeConcession', entityId: c._id,
            after: { students: assigned, credited: Math.round(credited * 100) / 100 } });
    }
    return { assigned, skipped: skip.size, notFound: ids.length - valid.length, credited: Math.round(credited * 100) / 100 };
}
exports.assignConcessionTo = assignConcessionTo;

exports.assignStudentConcession = async (req, res) => {
    try {
        const { concessionId, validFrom, validTo, remarks } = req.body;
        const out = await assignConcessionTo(req, concessionId, [req.params.studentId], { validFrom, validTo, remarks });
        if (out.error) return bad(res, out.error);
        if (!out.assigned) return bad(res, out.skipped ? 'This student already has this concession' : 'Student not found');
        res.status(201).json({ success: true, data: out });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.removeStudentConcession = async (req, res) => {
    try {
        const sc = await StudentConcession.findOne({ _id: req.params.concessionId, school: req.schoolId, student: req.params.studentId });
        if (!sc) return res.status(404).json({ success: false, message: 'Concession not found' });
        if (!sc.isActive) return res.json({ success: true });
        // Kept, switched off: the ledger rows it wrote still point at it.
        const reversed = await reverseStudentConcession(sc, req.userId);
        sc.isActive = false;
        await sc.save();
        logFeeAudit(req, { action: 'unassigned', entityType: 'FeeConcession', entityId: sc.concession,
            after: { student: sc.student, reversed } });
        res.json({ success: true, data: { reversed } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Payments ──────────────────────────────────────────────────────────────────

exports.getPayments = async (req, res) => {
    try {
        const { studentId, paymentStatus, paymentMode, page = 1, limit = 20 } = req.query;
        const filter = { school: req.schoolId };
        if (studentId)     filter.student       = studentId;
        if (paymentStatus) filter.paymentStatus = paymentStatus;
        if (paymentMode)   filter.paymentMode   = paymentMode;

        const [payments, total] = await Promise.all([
            FeePayment.find(filter)
                .populate('student',     'name email rollNumber')
                .populate('collectedBy', 'name')
                .sort({ paymentDate: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            FeePayment.countDocuments(filter),
        ]);
        res.json({ success: true, data: payments, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

const FREQ_WORD = { recurring: 'monthly', quarterly: 'quarterly', half_yearly: 'half-yearly', yearly: 'yearly', one_time: 'one-time' };

const MODE_LABEL = { cash: 'Cash', card: 'Card', upi: 'UPI', bank_transfer: 'Net banking', cheque: 'Cheque', dd: 'Demand draft', online: 'Online' };

exports.recordPayment = async (req, res) => {
    try {
        const { studentId, paymentMode, lines, feeHeadId, transactionRef, remarks, paymentDate, months } = req.body;
        let { amount } = req.body;
        if (!studentId || (!amount && !(Array.isArray(months) && months.length)) || !paymentMode) return res.status(400).json({ success: false, message: 'studentId, amount and paymentMode are required' });
        if (!isUuid(String(studentId))) return bad(res, 'Choose a student');
        // Paying months: the amount is what those months come to, worked out
        // here by the same rule the family's own fee book uses.
        let monthLines = null;
        if (Array.isArray(months) && months.length) {
            if (!(await User.findOne({ _id: studentId, school: req.schoolId, role: 'student' }).select('_id').lean())) return res.status(404).json({ success: false, message: 'Student not found' });
            const pay = await require('./feesStudent.controller').paymentFor(req.schoolId, studentId, { months });
            if (pay.error) return bad(res, pay.error);
            amount = pay.amount;
            monthLines = pay.lines;
        }
        const amt = Math.round(num(amount) * 100) / 100;
        if (!Number.isFinite(amt) || amt <= 0) return bad(res, 'Enter an amount above 0');
        if (!PAY_MODES.includes(paymentMode)) return bad(res, 'Choose a payment mode');

        const settings = await getOrCreateSettings(req.schoolId);
        const accepted = Array.isArray(settings.acceptedModes) && settings.acceptedModes.length ? settings.acceptedModes : PAY_MODES;
        if (paymentMode !== 'online' && !accepted.includes(paymentMode))
            return bad(res, `${MODE_LABEL[paymentMode]} payments are switched off in Fees → Settings → Payment Settings`);
        if (settings.minPaymentAmount > 0 && amt < settings.minPaymentAmount)
            return bad(res, `The smallest payment the office takes is ${settings.currencySymbol || '₹'}${settings.minPaymentAmount}`);
        const when = paymentDate ? dayOrNull(paymentDate) : new Date();
        if (!when) return bad(res, 'Enter a valid payment date');
        if (when > new Date(Date.now() + 60 * 1000)) return bad(res, 'The payment date cannot be in the future');

        const ay = await getActiveYear(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        // The student must belong to THIS school — this used to accept any id.
        const student = await User.findOne({ _id: studentId, school: req.schoolId, role: 'student' }).lean();
        if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

        if (settings.allowPartialPayments === false) {
            const owed = await computeRunningBalance(req.schoolId, studentId, ay._id, 0);
            if (owed > 0 && amt + 0.004 < owed)
                return bad(res, `Part payments are switched off — collect the full ${settings.currencySymbol || '₹'}${owed.toLocaleString('en-IN')} outstanding`);
        }

        let payLines = monthLines || (Array.isArray(lines) && lines.length ? lines : null);
        if (!payLines) {
            const head = feeHeadId && isUuid(String(feeHeadId))
                ? await FeeHead.findOne({ _id: feeHeadId, school: req.schoolId }).select('name').lean() : null;
            payLines = [{ feeHead: head?._id || null, feeName: head?.name || 'Fee Payment', amount: amt }];
        }

        const [school, profile] = await Promise.all([
            School.findById(req.schoolId).lean(),
            StudentProfile.findOne({ user: studentId, school: req.schoolId })
                .select('admissionNumber rollNumber currentSection')
                .populate({ path: 'currentSection', select: 'sectionName class', populate: { path: 'class', select: 'className classNumber' } })
                .lean(),
        ]);
        const receiptNumber = await nextReceiptNumber(req.schoolId);

        const payment = await FeePayment.create({
            school: req.schoolId, student: studentId, academicYear: ay._id,
            receiptNumber, amount: amt, lines: payLines,
            months: monthLines && Array.isArray(months) && months.length ? months.map(String) : null,
            paymentMode, paymentStatus: 'completed', transactionRef: transactionRef || '',
            gateway: 'manual', collectedBy: req.userId, remarks: remarks || '',
            paymentDate: when,
            schoolSnapshot: { name: school?.name, address: school?.address },
            studentSnapshot: {
                name: student?.name, email: student?.email,
                rollNumber: profile?.rollNumber || student?.rollNumber,
                admissionNumber: profile?.admissionNumber || '',
                className: profile?.currentSection?.class?.className || '',
                section: profile?.currentSection?.sectionName || '',
            },
        });

        // Ledger credit entry
        const running = await computeRunningBalance(req.schoolId, studentId, ay._id, -amt);
        const ledger  = await FeeLedger.create({
            school: req.schoolId, student: studentId, academicYear: ay._id,
            entryType: 'credit', category: 'payment', amount: amt,
            description: `Payment received — ${receiptNumber}`,
            referenceType: 'FeePayment', referenceId: payment._id,
            runningBalance: running, createdBy: req.userId,
        });
        await FeePayment.updateOne({ _id: payment._id }, { ledgerEntry: ledger._id });

        if (settings.notifications?.paymentReceived !== false) {
            withParents([studentId]).then(targets => notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '💰 Fee payment received',
                body: `Payment of ₹${amt.toLocaleString('en-IN')} received for ${student?.name || 'student'}.\nReceipt: ${receiptNumber} (${MODE_LABEL[paymentMode] || paymentMode})`,
                recipients: targets,
                email: settings.notifications?.emailParents !== false,
                link: { type: 'fees.mine', entityId: payment._id },
            })).catch(() => {});
        }

        res.status(201).json({ success: true, data: { ...payment.toObject?.() ?? payment, ledgerEntry: ledger._id } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.approvePayment = async (req, res) => {
    try {
        const payment = await FeePayment.findOne({ _id: req.params.id, school: req.schoolId });
        if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
        if (payment.paymentStatus !== 'pending')
            return res.status(400).json({ success: false, message: 'Only pending payments can be approved' });

        const ay            = await getActiveYear(req.schoolId);
        const academicYear  = payment.academicYear || ay?._id;
        const receiptNumber = await nextReceiptNumber(req.schoolId);
        const running       = await computeRunningBalance(req.schoolId, payment.student, academicYear, -payment.amount);

        const ledger = await FeeLedger.create({
            school: req.schoolId, student: payment.student, academicYear,
            entryType: 'credit', category: 'payment', amount: payment.amount,
            description: `Payment received — ${receiptNumber}`,
            referenceType: 'FeePayment', referenceId: payment._id,
            runningBalance: running, createdBy: req.userId,
        });

        payment.paymentStatus = 'completed';
        payment.receiptNumber = receiptNumber;
        payment.ledgerEntry   = ledger._id;
        payment.collectedBy   = req.userId;
        await payment.save();
        logFeeAudit(req, { action: 'approved', entityType: 'FeePayment', entityId: payment._id, after: { amount: payment.amount, receiptNumber } });

        const noticeCfg = (await getOrCreateSettings(req.schoolId)).notifications || {};
        if (noticeCfg.paymentDecision !== false) withParents([payment.student]).then(targets => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '✅ Fee payment approved',
            body: `Your payment of ₹${payment.amount.toLocaleString('en-IN')} has been approved.\nReceipt: ${receiptNumber}`,
            recipients: targets,
            email: noticeCfg.emailParents !== false,
            link: { type: 'fees.mine', entityId: payment._id },
        })).catch(() => {});

        res.json({ success: true, data: payment.toObject() });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.rejectPayment = async (req, res) => {
    try {
        const payment = await FeePayment.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId, paymentStatus: 'pending' },
            { paymentStatus: 'failed' },
            { new: true }
        ).lean();
        if (!payment) return res.status(404).json({ success: false, message: 'Pending payment not found' });
        logFeeAudit(req, { action: 'rejected', entityType: 'FeePayment', entityId: payment._id, after: { amount: payment.amount, student: payment.student } });
        const noticeCfg = (await getOrCreateSettings(req.schoolId)).notifications || {};
        if (noticeCfg.paymentDecision !== false) withParents([payment.student]).then(targets => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '❌ Fee payment rejected',
            body: `Your payment of ₹${payment.amount.toLocaleString('en-IN')} was rejected. Please contact the school office.`,
            recipients: targets,
            email: noticeCfg.emailParents !== false,
            link: { type: 'fees.mine', entityId: payment._id },
        })).catch(() => {});
        res.json({ success: true, data: payment });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getPaymentReceipt = async (req, res) => {
    try {
        const payment = await FeePayment.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('student', 'name email rollNumber')
            .populate('collectedBy','name')
            .lean();
        if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
        res.json({ success: true, data: payment });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.downloadReceipt = async (req, res) => {
    try {
        const payment = await FeePayment.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });

        // A parent or student may only open their own receipt.
        if (['student', 'parent'].includes(req.userRole)) {
            const allowed = req.userRole === 'student'
                ? String(payment.student) === String(req.userId)
                : ((await ParentProfile.findOne({ user: req.userId, school: req.schoolId }).lean())?.children || [])
                    .map(String).includes(String(payment.student));
            if (!allowed) return res.status(403).json({ success: false, message: 'This receipt belongs to someone else' });
        }

        const mode = payment.paymentMode === 'online' ? 'online' : 'offline';
        const [school, template] = await Promise.all([
            School.findById(req.schoolId).select('name address logo').lean(),
            ReceiptTemplate.findOne({ school: req.schoolId, module: 'fees', paymentMode: mode }).lean(),
        ]);

        const st = payment.studentSnapshot || {};
        const settings = await getOrCreateSettings(req.schoolId);
        const origin = `${req.protocol}://${req.get('host')}`;

        // Rendered from the school's chosen design — this used to be a .txt
        // file, which is not something anyone can hand to a parent.
        const html = renderReceipt({
            module: 'fees',
            number: payment.receiptNumber || '',
            date: payment.paymentDate || payment.createdAt,
            paidBy: st.name || '',
            paidByDetailLabel: 'Class',
            paidByDetail: [st.className, st.section].filter(Boolean).join(' · ') || st.rollNumber || '',
            title: 'Fee receipt',
            paymentMode: mode,
            offlineModeLabel: payment.paymentMode || 'Cash',
            reference: payment.gatewayPaymentId || payment.transactionId || '',
            lines: (payment.lines || []).map(l => ({ label: l.feeName, amount: l.amount })),
            total: payment.amount || 0,
            currencySymbol: settings?.currencySymbol || '₹',
        }, template || defaultTemplate('fees', mode), {
            school: school && {
                name: school.name,
                address: school.address,
                logoUrl: school.logo ? (/^https?:/.test(school.logo) ? school.logo : `${origin}${school.logo}`) : '',
            },
        });

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Ledger ────────────────────────────────────────────────────────────────────

exports.getSchoolLedger = async (req, res) => {
    try {
        const { category, page = 1, limit = 30 } = req.query;
        const filter = { school: req.schoolId };
        if (category) filter.category = category;

        const [entries, total] = await Promise.all([
            FeeLedger.find(filter)
                .populate('student', 'name rollNumber')
                .sort({ createdAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            FeeLedger.countDocuments(filter),
        ]);
        res.json({ success: true, data: entries, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Reports ───────────────────────────────────────────────────────────────────

exports.getCollectionReport = async (req, res) => {
    try {
        const { fromDate, toDate } = req.query;
        const filter = { school: req.schoolId, paymentStatus: 'completed' };
        if (fromDate || toDate) {
            filter.paymentDate = {};
            if (fromDate) filter.paymentDate.$gte = new Date(fromDate);
            if (toDate)   filter.paymentDate.$lte = new Date(toDate);
        }

        const payments = await FeePayment.find(filter)
            .populate('student', 'name rollNumber email')
            .sort({ paymentDate: -1 })
            .lean();

        const total = payments.reduce((s, p) => s + p.amount, 0);
        res.json({ success: true, data: { payments, total, count: payments.length } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getDuesReport = async (req, res) => {
    try {
        const ay = await getActiveYear(req.schoolId);
        const students = await User.find({ school: req.schoolId, role: 'student', isActive: true })
            .select('name email rollNumber').lean();
        const studentIds = students.map(s => s._id);

        const [assignments, payments] = await Promise.all([
            StudentFeeAssignment.find({ school: req.schoolId, student: { $in: studentIds }, academicYear: ay?._id }).lean(),
            FeePayment.aggregate([
                { $match: { school: req.schoolId, student: { $in: studentIds }, paymentStatus: 'completed' } },
                { $group: { _id: '$student', paid: { $sum: '$amount' } } },
            ]),
        ]);

        const assignMap = Object.fromEntries(assignments.map(a => [a.student.toString(), a]));
        const paidMap   = Object.fromEntries(payments.map(p => [p._id.toString(), p.paid]));

        const data = students.map(s => {
            const total  = assignMap[s._id.toString()]?.totalAmount || 0;
            const paid   = paidMap[s._id.toString()] || 0;
            const due    = total - paid;
            return { ...s, total, paid, due };
        }).filter(s => s.due > 0);

        res.json({ success: true, data, totalDues: data.reduce((s, d) => s + d.due, 0) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getConcessionReport = async (req, res) => {
    try {
        const ay = await getActiveYear(req.schoolId);
        const concessions = await StudentConcession.find({ school: req.schoolId, academicYear: ay?._id, isActive: true })
            .populate('student',   'name email rollNumber')
            .populate('concession','name concessionType value')
            .lean();
        res.json({ success: true, data: concessions });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Settings ──────────────────────────────────────────────────────────────────

// Gateway credentials are no longer part of fees settings — they belong to the
// school (Settings → Payment Gateway), because library fines charge through the
// same merchant account. What remains here is how fees are counted and numbered.

exports.getSettings = async (req, res) => {
    try {
        const settings = await getOrCreateSettings(req.schoolId);
        const school   = await School.findById(req.schoolId).select('paymentGateway').lean();
        res.json({
            success: true,
            data: {
                ...settings,
                // Read-only here, so the screen can say whether online fee
                // payment is live and point at where it is configured.
                onlinePaymentEnabled: !!(school?.paymentGateway?.enabled && school.paymentGateway.modules?.fees),
                paymentGatewayProvider: school?.paymentGateway?.provider || 'none',
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

const BOOL_SETTINGS = ['allowPartialPayments', 'autoGenerateReceipt', 'showPreviousDues', 'includeConcessionInFine', 'autoAdjustAdvance'];
const DISPLAY_KEYS  = ['feeHeadDetails', 'concessionDetails', 'fineDetails', 'previousYearDues'];
const NOTICE_KEYS   = ['paymentReceived', 'paymentDecision', 'emailParents'];

/** Every setting the screen may write, checked. Returns { update } or { error }. */
async function settingsUpdate(schoolId, body, current) {
    const update = {};
    const { currency, currencySymbol, receipt, receiptPrefix, roundingRule } = body;
    if (currency       !== undefined) update.currency       = String(currency || 'INR').trim().toUpperCase().slice(0, 6) || 'INR';
    if (currencySymbol !== undefined) update.currencySymbol = String(currencySymbol || '₹').trim().slice(0, 4) || '₹';
    if (receipt        !== undefined) {
        const r = receipt || {};
        update.receipt = { ...(current.receipt || {}), ...Object.fromEntries(['logo', 'header', 'footer', 'customNotes']
            .filter(k => r[k] !== undefined).map(k => [k, String(r[k] || '').slice(0, 1000)])) };
    }
    if (receiptPrefix  !== undefined) {
        const pre = String(receiptPrefix).trim().toUpperCase();
        if (!/^[A-Z0-9/-]{1,10}$/.test(pre)) return { error: 'The receipt prefix may use letters, digits, / and - (up to 10)' };
        update.receiptPrefix = pre;
    }
    if (roundingRule   !== undefined) {
        if (!['none', 'round', 'ceil', 'floor'].includes(roundingRule)) return { error: 'Choose a valid rounding rule' };
        update.roundingRule = roundingRule;
    }
    if (body.decimalPlaces !== undefined) {
        const d = Number(body.decimalPlaces);
        if (![0, 2].includes(d)) return { error: 'Decimal places must be 0 or 2' };
        update.decimalPlaces = d;
    }
    for (const k of ['collectionStart', 'collectionEnd']) {
        if (body[k] === undefined) continue;
        if (body[k] && !dayOrNull(body[k])) return { error: 'Enter a valid collection date' };
        update[k] = body[k] ? dayOrNull(body[k]) : null;
    }
    const cs = update.collectionStart !== undefined ? update.collectionStart : current.collectionStart;
    const ce = update.collectionEnd   !== undefined ? update.collectionEnd   : current.collectionEnd;
    if (cs && ce && new Date(ce) < new Date(cs)) return { error: 'The collection end date is before the start date' };
    for (const [k, max] of [['defaultDueDays', 365], ['defaultGraceDays', 365], ['minPaymentAmount', 10000000]]) {
        if (body[k] === undefined) continue;
        const n = body[k] === '' ? 0 : num(body[k]);
        if (!Number.isFinite(n) || n < 0 || n > max) return { error: 'Days and amounts must be 0 or more' };
        update[k] = k === 'minPaymentAmount' ? n : Math.round(n);
    }
    if (body.defaultAcademicYear !== undefined) {
        if (body.defaultAcademicYear) {
            const y = await AcademicYear.findOne({ _id: body.defaultAcademicYear, school: schoolId }).select('_id').lean();
            if (!y) return { error: 'That academic year does not exist' };
            update.defaultAcademicYear = y._id;
        } else update.defaultAcademicYear = null;
    }
    for (const k of BOOL_SETTINGS) if (body[k] !== undefined) update[k] = !!body[k];
    if (body.lateFeeCalculation !== undefined) {
        if (!['per_day', 'flat'].includes(body.lateFeeCalculation)) return { error: 'Choose per day or flat' };
        update.lateFeeCalculation = body.lateFeeCalculation;
    }
    if (body.fineAppliesOn !== undefined) {
        if (!['total_due', 'per_head'].includes(body.fineAppliesOn)) return { error: 'Choose what the fine applies on' };
        update.fineAppliesOn = body.fineAppliesOn;
    }
    if (body.display !== undefined) {
        update.display = { ...(current.display || {}) };
        for (const k of DISPLAY_KEYS) if (body.display?.[k] !== undefined) update.display[k] = !!body.display[k];
    }
    if (body.notifications !== undefined) {
        update.notifications = { ...(current.notifications || {}) };
        for (const k of NOTICE_KEYS) if (body.notifications?.[k] !== undefined) update.notifications[k] = !!body.notifications[k];
    }
    if (body.acceptedModes !== undefined) {
        const modes = (Array.isArray(body.acceptedModes) ? body.acceptedModes : []).filter(m => FeeSettings.COUNTER_MODES.includes(m));
        if (!modes.length) return { error: 'Leave at least one payment mode switched on' };
        update.acceptedModes = [...new Set(modes)];
    }
    if (body.autoReminders !== undefined) {
        const a = body.autoReminders || {};
        const cur = current.autoReminders || {};
        const days = (v, label) => {
            const out = [...new Set((Array.isArray(v) ? v : []).map(Number))];
            if (out.some(n => !Number.isInteger(n) || n < 1 || n > 90)) return { error: `${label} must be whole numbers between 1 and 90 days` };
            return { out: out.sort((x, y) => x - y) };
        };
        const next = { ...cur };
        if (a.enabled !== undefined) next.enabled = !!a.enabled;
        if (a.onDueDay !== undefined) next.onDueDay = !!a.onDueDay;
        if (a.emailParents !== undefined) next.emailParents = !!a.emailParents;
        for (const [k, label] of [['beforeDays', 'Days before'], ['afterDays', 'Days after']]) {
            if (a[k] === undefined) continue;
            const r = days(a[k], label);
            if (r.error) return { error: r.error };
            next[k] = r.out;
        }
        if (a.minAmount !== undefined) {
            const n = a.minAmount === '' ? 0 : num(a.minAmount);
            if (!Number.isFinite(n) || n < 0 || n > 10000000) return { error: 'The smallest amount worth chasing must be 0 or more' };
            next.minAmount = n;
        }
        if (a.sendHour !== undefined) {
            const h = Math.round(num(a.sendHour));
            if (!Number.isFinite(h) || h < 0 || h > 23) return { error: 'Choose an hour between 0 and 23' };
            next.sendHour = h;
        }
        // Switching it on with nothing to send would be a switch that does
        // nothing — the commonest way an automatic job quietly never runs.
        if (next.enabled && !next.onDueDay && !(next.beforeDays || []).length && !(next.afterDays || []).length) {
            return { error: 'Choose at least one moment to send at — before the due date, on it, or after it' };
        }
        update.autoReminders = next;
    }
    return { update };
}

exports.updateSettings = async (req, res) => {
    try {
        const current = await getOrCreateSettings(req.schoolId);
        const { update, error } = await settingsUpdate(req.schoolId, req.body || {}, current);
        if (error) return bad(res, error);
        update.updatedBy = req.userId;
        const settings = withDefaults(await FeeSettings.findOneAndUpdate({ school: req.schoolId }, update, { upsert: true, new: true }).lean());
        logFeeAudit(req, { action: 'updated', entityType: 'FeeSettings', entityId: settings._id, before: current, after: settings });
        res.json({ success: true, data: settings });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// Back to the defaults the model declares. Receipt numbering is NOT reset —
// restarting at REC-000001 would print receipt numbers that already exist.
exports.resetSettings = async (req, res) => {
    try {
        const current = await getOrCreateSettings(req.schoolId);
        const fresh = new FeeSettings({ school: req.schoolId }).toObject();
        const keep = new Set(['_id', 'school', 'lastReceiptNumber', 'receiptPrefix', 'createdAt', 'createdBy', 'scheduledReports']);
        const update = Object.fromEntries(Object.entries(fresh).filter(([k]) => !keep.has(k)));
        update.updatedBy = req.userId;
        const settings = await FeeSettings.findOneAndUpdate({ school: req.schoolId }, update, { new: true }).lean();
        logFeeAudit(req, { action: 'reset', entityType: 'FeeSettings', entityId: settings._id, before: current, after: settings });
        res.json({ success: true, data: settings });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getOrCreateSettings = getOrCreateSettings;
exports.getActiveYear = getActiveYear;
exports.PAY_MODES = PAY_MODES;
exports.MODE_LABEL = MODE_LABEL;

// ── Shared JSON API ───────────────────────────────────────────────────────────

exports.getStudentBalance = async (req, res) => {
    try {
        const ay = await getActiveYear(req.schoolId);
        const asgn = await StudentFeeAssignment.findOne({ school: req.schoolId, student: req.params.studentId, academicYear: ay?._id }).lean();
        const paid = await FeePayment.aggregate([
            { $match: { school: req.schoolId, student: req.params.studentId, paymentStatus: 'completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } },
        ]);
        const totalDue = asgn?.totalAmount || 0;
        const totalPaid = paid[0]?.total || 0;
        res.json({ success: true, data: { totalDue, totalPaid, balance: totalDue - totalPaid } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getSectionsByClass = async (req, res) => {
    try {
        const sections = await ClassSection.find({ class: req.params.classId, school: req.schoolId }).lean();
        res.json({ success: true, data: sections });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};


/**
 * Cancel a payment recorded by mistake. The receipt number stays with it —
 * receipts are never reused — and the ledger gets the money back as owed, so
 * the student's months open again. A payment that is still waiting for
 * approval is rejected instead.
 */
exports.voidPayment = async (req, res) => {
    try {
        const payment = await FeePayment.findOne({ _id: req.params.id, school: req.schoolId });
        if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
        if (payment.paymentStatus === 'pending') return bad(res, 'This payment is still waiting for approval — reject it instead');
        if (payment.paymentStatus !== 'completed') return bad(res, 'Only a completed payment can be cancelled');
        const reason = String(req.body?.reason || '').trim().slice(0, 200);
        if (!reason) return bad(res, 'Say why this payment is being cancelled');

        const { appendLedger } = require('../services/feeConcessions');
        await appendLedger({
            school: req.schoolId, student: payment.student, academicYear: payment.academicYear,
            entryType: 'debit', category: 'refund', amount: payment.amount,
            description: `Payment cancelled — ${payment.receiptNumber || 'receipt'} · ${reason}`,
            referenceType: 'FeePayment', referenceId: payment._id, createdBy: req.userId,
        });
        payment.paymentStatus = 'refunded';
        payment.isRefunded = true;
        payment.refundedAt = new Date();
        payment.refundedBy = req.userId;
        payment.voidReason = reason;
        await payment.save();

        const settings = await getOrCreateSettings(req.schoolId);
        if (settings.notifications?.paymentDecision !== false) {
            withParents([payment.student]).then(targets => notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '↩️ Fee payment cancelled',
                body: `The payment of ₹${payment.amount.toLocaleString('en-IN')} (${payment.receiptNumber || 'no receipt'}) has been cancelled by the school office.\nReason: ${reason}`,
                recipients: targets, email: settings.notifications?.emailParents !== false,
                link: { type: 'fees.mine', entityId: payment._id },
            })).catch(() => {});
        }
        logFeeAudit(req, { action: 'cancelled', entityType: 'FeePayment', entityId: payment._id, after: { amount: payment.amount, receiptNumber: payment.receiptNumber, reason } });
        res.json({ success: true, data: payment.toObject() });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/**
 * Move a student onto another fee structure — a class change mid-year, or a
 * correction. What the old structure charged stays on their account (they
 * were billed for those months); the new one charges from `fromMonth`, this
 * month by default, and the old one stops charging them at once.
 */
exports.moveStudentStructure = async (req, res) => {
    try {
        const studentId = req.params.studentId;
        const student = await User.findOne({ _id: studentId, school: req.schoolId, role: 'student' }).select('name').lean();
        if (!student) return res.status(404).json({ success: false, message: 'Student not found' });
        const ay = await getActiveYear(req.schoolId);
        if (!ay) return bad(res, 'No active academic year');
        const structure = isUuid(String(req.body.structureId || ''))
            ? await FeeStructure.findOne({ _id: req.body.structureId, school: req.schoolId, academicYear: ay._id }).lean() : null;
        if (!structure) return bad(res, 'Choose a fee structure from this academic year');
        if (structure.isActive === false) return bad(res, 'That structure is switched off');

        const bounds = Sched.yearBounds(ay);
        let fromMonth = Sched.isMonthKey(req.body.fromMonth) ? req.body.fromMonth : Sched.monthKey(new Date());
        if (fromMonth < bounds.first) fromMonth = bounds.first;
        if (fromMonth > bounds.last) return bad(res, `Choose a month inside ${ay.yearName}`);

        const existing = await StudentFeeAssignment.findOne({ school: req.schoolId, student: studentId, academicYear: ay._id });
        const was = existing?.feeStructure ? await FeeStructure.findById(existing.feeStructure).select('name').lean() : null;
        if (existing) {
            existing.feeStructure = structure._id;
            existing.fromMonth = fromMonth;
            existing.totalAmount = structure.totalAmount;
            existing.useCustom = false;
            existing.isActive = true;
            await existing.save();
        } else {
            await StudentFeeAssignment.create({
                school: req.schoolId, student: studentId, academicYear: ay._id,
                feeStructure: structure._id, fromMonth, totalAmount: structure.totalAmount, createdBy: req.userId,
            });
        }
        const out = structure.periodicSince
            ? await charging.postDueCharges({ schoolId: req.schoolId, structure, studentIds: [studentId], userId: req.userId })
            : { entries: 0, amount: 0 };
        logFeeAudit(req, { action: 'moved', entityType: 'StudentFeeAssignment', entityId: studentId,
            after: { name: student.name, from: was?.name || null, to: structure.name, fromMonth, charged: out.amount } });
        res.json({ success: true, data: { structure: structure.name, fromMonth, charged: out.amount, entries: out.entries, from: was?.name || null } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
