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
const XLSX                = require('xlsx');
const { notify, withParents } = require('../services/notifyService');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getActiveYear(schoolId) {
    return AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
}

async function getOrCreateSettings(schoolId) {
    let s = await FeeSettings.findOne({ school: schoolId }).lean();
    if (!s) s = (await FeeSettings.create({ school: schoolId })).toObject();
    return s;
}

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
        const { name } = req.body;
        if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name is required' });
        const cat = await FeeCategory.create({ school: req.schoolId, name: name.trim() });
        res.status(201).json({ success: true, data: cat });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, message: 'Category already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.updateFeeCategory = async (req, res) => {
    try {
        const { name } = req.body;
        const cat = await FeeCategory.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            { name: name.trim() },
            { new: true }
        ).lean();
        if (!cat) return res.status(404).json({ success: false, message: 'Category not found' });
        res.json({ success: true, data: cat });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleFeeCategory = async (req, res) => {
    try {
        const cat = await FeeCategory.findOne({ _id: req.params.id, school: req.schoolId });
        if (!cat) return res.status(404).json({ success: false, message: 'Category not found' });
        cat.isActive = !cat.isActive;
        await cat.save();
        res.json({ success: true, data: cat });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Fee Heads ─────────────────────────────────────────────────────────────────

exports.getFeeHeads = async (req, res) => {
    try {
        const { isActive } = req.query;
        const filter = { school: req.schoolId };
        if (isActive !== undefined) filter.isActive = isActive !== 'false';

        const heads = await FeeHead.find(filter)
            .populate('category', 'name')
            .sort({ name: 1 })
            .lean();
        res.json({ success: true, data: heads });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createFeeHead = async (req, res) => {
    try {
        const { name, categoryId, type, defaultAmount, description } = req.body;
        if (!name?.trim() || !type) return res.status(400).json({ success: false, message: 'name and type are required' });

        const head = await FeeHead.create({
            school: req.schoolId, name: name.trim(), category: categoryId || null,
            type, defaultAmount: Number(defaultAmount) || 0, description: description || '',
            createdBy: req.userId,
        });
        res.status(201).json({ success: true, data: head });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, message: 'Fee head already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.updateFeeHead = async (req, res) => {
    try {
        const { name, categoryId, type, defaultAmount, description } = req.body;
        const update = {};
        if (name          !== undefined) update.name          = name.trim();
        if (categoryId    !== undefined) update.category      = categoryId || null;
        if (type          !== undefined) update.type          = type;
        if (defaultAmount !== undefined) update.defaultAmount = Number(defaultAmount);
        if (description   !== undefined) update.description   = description;

        const head = await FeeHead.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, update, { new: true }).lean();
        if (!head) return res.status(404).json({ success: false, message: 'Fee head not found' });
        res.json({ success: true, data: head });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleFeeHead = async (req, res) => {
    try {
        const h = await FeeHead.findOne({ _id: req.params.id, school: req.schoolId });
        if (!h) return res.status(404).json({ success: false, message: 'Fee head not found' });
        h.isActive = !h.isActive;
        await h.save();
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
        const { name, level, classId, sectionId, dueDay, items, academicYearId } = req.body;
        if (!name?.trim() || !level) return res.status(400).json({ success: false, message: 'name and level are required' });

        const ay = academicYearId ? { _id: academicYearId } : await getActiveYear(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const processedItems = (items || []).map(i => ({ feeHead: i.feeHead, amount: Number(i.amount) || 0, isActive: true }));
        const totalAmount = processedItems.reduce((s, i) => s + i.amount, 0);

        const structure = await FeeStructure.create({
            school: req.schoolId, academicYear: ay._id, name: name.trim(), level,
            class: classId || null, section: sectionId || null,
            dueDay: dueDay || null, items: processedItems, totalAmount,
            createdBy: req.userId,
        });
        res.status(201).json({ success: true, data: structure });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

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
        const { name, dueDay, items } = req.body;
        const s = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId });
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });

        if (name !== undefined) s.name = name.trim();
        if (dueDay !== undefined) s.dueDay = dueDay;
        if (items !== undefined) {
            s.items = items.map(i => ({ feeHead: i.feeHead, amount: Number(i.amount), isActive: i.isActive !== false }));
            s.totalAmount = s.items.reduce((sum, i) => sum + (i.isActive ? i.amount : 0), 0);
        }
        await s.save();
        res.json({ success: true, data: s });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleFeeStructure = async (req, res) => {
    try {
        const s = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId });
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });
        s.isActive = !s.isActive;
        await s.save();
        res.json({ success: true, data: s });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.generateFeeDemand = async (req, res) => {
    try {
        const structure = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('items.feeHead', 'name')
            .lean();
        if (!structure) return res.status(404).json({ success: false, message: 'Structure not found' });

        const ay = await AcademicYear.findById(structure.academicYear).lean();
        if (!ay) return res.status(400).json({ success: false, message: 'Academic year not found' });

        // Find students in target class/section
        let studentIds = [];
        if (structure.level === 'section' && structure.section) {
            const section = await ClassSection.findById(structure.section).lean();
            studentIds = section?.enrolledStudents || [];
        } else if (structure.level === 'class' && structure.class) {
            const sections = await ClassSection.find({ class: structure.class, school: req.schoolId }).lean();
            studentIds = sections.flatMap(s => s.enrolledStudents || []);
        }

        if (!studentIds.length) return res.json({ success: true, message: 'No students to generate demand for', generated: 0 });
        studentIds = [...new Set(studentIds.map(String))];

        // Two batched lookups replace two round trips per student
        const [existingAssignments, chargedRows] = await Promise.all([
            StudentFeeAssignment.find({ school: req.schoolId, student: { $in: studentIds }, academicYear: structure.academicYear })
                .select('student').lean(),
            FeeLedger.find({ school: req.schoolId, student: { $in: studentIds }, academicYear: structure.academicYear, referenceType: 'FeeStructure', referenceId: structure._id, category: 'fee_charged' })
                .select('student').lean(),
        ]);
        const hasAssignment  = new Set(existingAssignments.map(a => String(a.student)));
        const alreadyCharged = new Set(chargedRows.map(r => String(r.student)));

        const newAssignments = studentIds
            .filter(id => !hasAssignment.has(id))
            .map(id => ({
                school: req.schoolId, student: id, academicYear: structure.academicYear,
                feeStructure: structure._id, totalAmount: structure.totalAmount, createdBy: req.userId,
            }));
        if (newAssignments.length) await StudentFeeAssignment.insertMany(newAssignments);

        let generated = 0;
        for (const studentId of studentIds) {
            if (alreadyCharged.has(studentId)) continue;
            // Running balance is inherently per-student sequential — keep as-is
            const running = await computeRunningBalance(req.schoolId, studentId, structure.academicYear, structure.totalAmount);
            await FeeLedger.create({
                school: req.schoolId, student: studentId, academicYear: structure.academicYear,
                entryType: 'debit', category: 'fee_charged', amount: structure.totalAmount,
                description: `Fee demand: ${structure.name}`,
                referenceType: 'FeeStructure', referenceId: structure._id,
                runningBalance: running, createdBy: req.userId,
            });
            generated++;
        }
        await FeeStructure.updateOne({ _id: structure._id }, { demandGeneratedAt: new Date() });
        res.json({ success: true, generated });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.addFeeHeadToStructure = async (req, res) => {
    try {
        const { feeHead, amount } = req.body;
        if (!feeHead || amount === undefined) return res.status(400).json({ success: false, message: 'feeHead and amount are required' });

        const s = await FeeStructure.findOne({ _id: req.params.id, school: req.schoolId });
        if (!s) return res.status(404).json({ success: false, message: 'Structure not found' });

        s.items.push({ feeHead, amount: Number(amount), isActive: true });
        s.totalAmount = s.items.reduce((sum, i) => sum + (i.isActive ? i.amount : 0), 0);
        await s.save();
        res.json({ success: true, data: s });
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

exports.createFineRule = async (req, res) => {
    try {
        const { name, fineType, flatAmount, perDayAmount, gracePeriodDays, maxCap, applicableCategories } = req.body;
        if (!name?.trim() || !fineType) return res.status(400).json({ success: false, message: 'name and fineType are required' });

        const rule = await FineRule.create({
            school: req.schoolId, name: name.trim(), fineType,
            flatAmount: Number(flatAmount) || 0, perDayAmount: Number(perDayAmount) || 0,
            gracePeriodDays: Number(gracePeriodDays) || 0, maxCap: Number(maxCap) || 0,
            applicableCategories: applicableCategories || [], createdBy: req.userId,
        });
        res.status(201).json({ success: true, data: rule });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, message: 'Fine rule already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.updateFineRule = async (req, res) => {
    try {
        const rule = await FineRule.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, req.body, { new: true }).lean();
        if (!rule) return res.status(404).json({ success: false, message: 'Fine rule not found' });
        res.json({ success: true, data: rule });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleFineRule = async (req, res) => {
    try {
        const r = await FineRule.findOne({ _id: req.params.id, school: req.schoolId });
        if (!r) return res.status(404).json({ success: false, message: 'Fine rule not found' });
        r.isActive = !r.isActive;
        await r.save();
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

exports.createConcession = async (req, res) => {
    try {
        const { name, concessionType, value, applicableTo, applicableHeads, description } = req.body;
        if (!name?.trim() || !concessionType || value === undefined) return res.status(400).json({ success: false, message: 'name, concessionType and value are required' });

        const c = await FeeConcession.create({
            school: req.schoolId, name: name.trim(), concessionType, value: Number(value),
            applicableTo: applicableTo || 'all', applicableHeads: applicableHeads || [],
            description: description || '', createdBy: req.userId,
        });
        res.status(201).json({ success: true, data: c });
    } catch (e) {
        if (e.code === 11000) return res.status(400).json({ success: false, message: 'Concession already exists' });
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.updateConcession = async (req, res) => {
    try {
        const c = await FeeConcession.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, req.body, { new: true }).lean();
        if (!c) return res.status(404).json({ success: false, message: 'Concession not found' });
        res.json({ success: true, data: c });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.toggleConcession = async (req, res) => {
    try {
        const c = await FeeConcession.findOne({ _id: req.params.id, school: req.schoolId });
        if (!c) return res.status(404).json({ success: false, message: 'Concession not found' });
        c.isActive = !c.isActive;
        await c.save();
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

exports.assignStudentConcession = async (req, res) => {
    try {
        const { concessionId, validFrom, validTo, remarks } = req.body;
        const ay = await getActiveYear(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const sc = await StudentConcession.create({
            school: req.schoolId, student: req.params.studentId, academicYear: ay._id,
            concession: concessionId, validFrom: validFrom ? new Date(validFrom) : null,
            validTo: validTo ? new Date(validTo) : null, remarks: remarks || '',
            approvedBy: req.userId, createdBy: req.userId,
        });
        res.status(201).json({ success: true, data: sc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.removeStudentConcession = async (req, res) => {
    try {
        const sc = await StudentConcession.findOneAndDelete({ _id: req.params.concessionId, school: req.schoolId });
        if (!sc) return res.status(404).json({ success: false, message: 'Concession not found' });
        res.json({ success: true });
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

exports.recordPayment = async (req, res) => {
    try {
        const { studentId, amount, paymentMode, lines, transactionRef, remarks, paymentDate } = req.body;
        if (!studentId || !amount || !paymentMode) return res.status(400).json({ success: false, message: 'studentId, amount and paymentMode are required' });

        const ay = await getActiveYear(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const school   = await School.findById(req.schoolId).lean();
        const student  = await User.findById(studentId).lean();
        const receiptNumber = await nextReceiptNumber(req.schoolId);

        const payment = await FeePayment.create({
            school: req.schoolId, student: studentId, academicYear: ay._id,
            receiptNumber, amount: Number(amount), lines: lines || [],
            paymentMode, paymentStatus: 'completed', transactionRef: transactionRef || '',
            gateway: 'manual', collectedBy: req.userId, remarks: remarks || '',
            paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
            schoolSnapshot: { name: school?.name, address: school?.address },
            studentSnapshot: { name: student?.name, rollNumber: student?.rollNumber, email: student?.email },
        });

        // Ledger credit entry
        const running = await computeRunningBalance(req.schoolId, studentId, ay._id, -Number(amount));
        const ledger  = await FeeLedger.create({
            school: req.schoolId, student: studentId, academicYear: ay._id,
            entryType: 'credit', category: 'payment', amount: Number(amount),
            description: `Payment received — ${receiptNumber}`,
            referenceType: 'FeePayment', referenceId: payment._id,
            runningBalance: running, createdBy: req.userId,
        });
        await FeePayment.updateOne({ _id: payment._id }, { ledgerEntry: ledger._id });

        withParents([studentId]).then(targets => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '💰 Fee payment received',
            body: `Payment of ₹${Number(amount).toLocaleString('en-IN')} received for ${student?.name || 'student'}.\nReceipt: ${receiptNumber} (${paymentMode})`,
            recipients: targets,
            email: true,
        })).catch(() => {});

        res.status(201).json({ success: true, data: payment });
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

        withParents([payment.student]).then(targets => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '✅ Fee payment approved',
            body: `Your payment of ₹${payment.amount.toLocaleString('en-IN')} has been approved.\nReceipt: ${receiptNumber}`,
            recipients: targets,
            email: true,
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
        withParents([payment.student]).then(targets => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '❌ Fee payment rejected',
            body: `Your payment of ₹${payment.amount.toLocaleString('en-IN')} was rejected. Please contact the school office.`,
            recipients: targets,
            email: true,
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

exports.updateSettings = async (req, res) => {
    try {
        const { currency, currencySymbol, receipt, receiptPrefix, roundingRule } = req.body;

        const update = { createdBy: req.userId };
        if (currency       !== undefined) update.currency       = currency;
        if (currencySymbol !== undefined) update.currencySymbol = currencySymbol;
        if (receipt        !== undefined) update.receipt        = receipt;
        if (receiptPrefix  !== undefined) update.receiptPrefix  = String(receiptPrefix).trim().toUpperCase() || 'REC';
        if (roundingRule   !== undefined) {
            if (!['none', 'round', 'ceil', 'floor'].includes(roundingRule))
                return res.status(400).json({ success: false, message: 'Choose a valid rounding rule' });
            update.roundingRule = roundingRule;
        }

        const settings = await FeeSettings.findOneAndUpdate({ school: req.schoolId }, update, { upsert: true, new: true }).lean();
        res.json({ success: true, data: settings });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

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
