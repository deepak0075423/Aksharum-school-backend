'use strict';
const crypto    = require('crypto');
const AcademicYear         = require('../models/AcademicYear');
const FeeLedger            = require('../models/FeeLedger');
const FeePayment           = require('../models/FeePayment');
const FeeSettings          = require('../models/FeeSettings');
const StudentConcession    = require('../models/StudentConcession');
const FineRule             = require('../models/FineRule');
const StudentProfile       = require('../models/StudentProfile');
const FeeStructure         = require('../models/FeeStructure');
const StudentFeeAssignment = require('../models/StudentFeeAssignment');
const User                 = require('../models/User');
const School               = require('../models/School');
const { generateReceiptPDF } = require('../utils/feeReceiptPdf');

async function getActiveAcademicYear(schoolId) {
    return AcademicYear.findOne({ school: schoolId, status: 'active' });
}

// Parents may only act on students linked to them
async function assertParentChild(parentUserId, childId, schoolId) {
    const sp = await StudentProfile.findOne({ user: childId, parent: parentUserId, school: schoolId }).select('_id').lean();
    return !!sp;
}

async function resolveFeeItems(studentId, academicYearId, schoolId) {
    const sfa = await StudentFeeAssignment.findOne({
        school: schoolId, student: studentId, academicYear: academicYearId, isActive: true,
    }).populate({ path: 'feeStructure', populate: { path: 'items.feeHead' } })
      .populate('customItems.feeHead');

    if (sfa) {
        if (sfa.useCustom) {
            return {
                level: 'student_custom', sourceType: 'StudentFeeAssignment',
                items: sfa.customItems.map(i => ({
                    feeHeadId: i.feeHead?._id, feeName: i.feeName || i.feeHead?.name || '',
                    category: i.feeHead?.category || 'custom',
                    amount: i.amount, dueDate: i.dueDate, installmentLabel: i.installmentLabel,
                })),
            };
        }
        if (sfa.feeStructure) {
            return _structureItems(sfa.feeStructure, 'student_structure');
        }
    }

    const sp = await StudentProfile.findOne({ user: studentId, school: schoolId })
        .populate({ path: 'currentSection', populate: { path: 'class' } });

    if (sp && sp.currentSection) {
        const sectionStruct = await FeeStructure.findOne({
            school: schoolId, academicYear: academicYearId,
            level: 'section', section: sp.currentSection._id, isActive: true,
        }).populate('items.feeHead');
        if (sectionStruct) return _structureItems(sectionStruct, 'section');

        const classId = sp.currentSection.class?._id || sp.currentSection.class;
        if (classId) {
            const classStruct = await FeeStructure.findOne({
                school: schoolId, academicYear: academicYearId,
                level: 'class', class: classId, isActive: true,
            }).populate('items.feeHead');
            if (classStruct) return _structureItems(classStruct, 'class');
        }
    }
    return null;
}

function _structureItems(struct, level) {
    return {
        level, sourceType: 'FeeStructure', structureId: struct._id, structureName: struct.name,
        dueDay: struct.dueDay || null,
        items: (struct.items || []).filter(i => i.isActive).map(i => ({
            feeHeadId: i.feeHead?._id, feeName: i.feeHead?.name || '',
            category: i.feeHead?.category?.name || (typeof i.feeHead?.category === 'string' ? i.feeHead?.category : ''),
            type: i.feeHead?.type || 'recurring',
            amount: i.amount,
        })),
    };
}

function calcFineAmount(dueDay, fineRule) {
    if (!fineRule || !fineRule.isActive || !dueDay) return 0;
    const now = new Date();
    const dueDate = new Date(now.getFullYear(), now.getMonth(), dueDay);
    const graceDue = new Date(dueDate.getTime() + (fineRule.gracePeriodDays || 0) * 86400000);
    if (now <= graceDue) return 0;
    const daysLate = Math.max(1, Math.floor((now - graceDue) / 86400000));
    let fine = fineRule.fineType === 'flat' ? fineRule.flatAmount : fineRule.perDayAmount * daysLate;
    if (fineRule.maxCap > 0) fine = Math.min(fine, fineRule.maxCap);
    return Math.round(fine * 100) / 100;
}

function calcConcessionAmount(items, concessions) {
    let total = 0;
    for (const sc of concessions) {
        const c = sc.concession || sc;
        if (!c || !c.isActive) continue;
        for (const item of items) {
            const applicable = c.applicableTo === 'all' ||
                (c.applicableTo === 'specific_heads' && c.applicableHeads &&
                 c.applicableHeads.some(h => h.toString() === (item.feeHeadId || '').toString()));
            if (!applicable) continue;
            const amt = c.concessionType === 'percentage'
                ? (item.amount * c.value / 100) : Math.min(c.value, item.amount);
            total += amt;
        }
    }
    return Math.round(total * 100) / 100;
}

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

// Build a month-wise fee-book schedule with payment status per month.
// Returns array of month objects with payStatus: 'paid'|'partial'|'due'|'upcoming'
async function buildMonthlySchedule(resolved, studentId, academicYearId, schoolId, creditPool = 0) {
    if (!resolved || !resolved.structureId) return [];

    const structure = await FeeStructure.findById(resolved.structureId).populate('items.feeHead');
    if (!structure) return [];

    let startDate = structure.demandStartedAt;

    if (!startDate) {
        const earliest = academicYearId
            ? await FeeLedger.findOne({ school: schoolId, student: studentId, academicYear: academicYearId, category: 'fee_charged' }).sort({ createdAt: 1 }).select('createdAt')
            : null;
        if (earliest) {
            startDate = new Date(earliest.createdAt.getFullYear(), earliest.createdAt.getMonth(), 1);
        } else {
            const now = new Date();
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        }
    }

    const sy = startDate.getFullYear(), sm = startDate.getMonth();
    const now = new Date();
    const todayMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const totalMonths = 12;

    const newEntries = await FeeLedger.find({
        school: schoolId, student: studentId, academicYear: academicYearId,
        category: 'fee_charged', feeItemId: { $ne: null },
    }).select('feeItemId feePeriod amount createdAt');
    const chargedSet = new Set(newEntries.map(e => `${e.feeItemId}-${e.feePeriod}`));

    const oldEntries = await FeeLedger.find({
        school: schoolId, student: studentId, academicYear: academicYearId,
        category: 'fee_charged', feeItemId: null,
        referenceType: 'FeeStructure', referenceId: structure._id,
    }).select('createdAt');
    const generatedMonthsLegacy = new Set(oldEntries.map(e => {
        const d = new Date(e.createdAt);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }));

    const activeItems = (structure.items || []).filter(i => i.isActive && i.feeHead);
    const scheduleMap = new Map();

    for (let m = 0; m < totalMonths; m++) {
        const chargeDate = new Date(sy, sm + m, 1);
        const monthKey = `${chargeDate.getFullYear()}-${String(chargeDate.getMonth() + 1).padStart(2, '0')}`;
        const isFuture = chargeDate > todayMonthStart;
        const isCurrentMonth = chargeDate.getTime() === todayMonthStart.getTime();

        for (const item of activeItems) {
            const feeType = item.feeHead.type || 'recurring';
            let periodNum = null;

            if      (feeType === 'one_time')    { if (m === 0) periodNum = 0; }
            else if (feeType === 'recurring')   { periodNum = m; }
            else if (feeType === 'quarterly')   { if (m % 3 === 0) periodNum = m / 3; }
            else if (feeType === 'half_yearly') { if (m % 6 === 0) periodNum = m / 6; }

            if (periodNum === null) continue;

            const isGenerated = chargedSet.has(`${item._id}-${periodNum}`)
                             || generatedMonthsLegacy.has(monthKey);

            if (!scheduleMap.has(monthKey)) {
                scheduleMap.set(monthKey, {
                    monthKey, isFuture, isCurrentMonth,
                    monthLabel: `${MONTH_NAMES[chargeDate.getMonth()]} ${chargeDate.getFullYear()}`,
                    items: [], chargedAmount: 0, totalAmount: 0,
                    payStatus: 'upcoming', amountPaid: 0, amountDue: 0,
                });
            }
            const slot = scheduleMap.get(monthKey);
            slot.items.push({ name: item.feeHead.name, type: feeType, amount: item.amount, isGenerated });
            slot.totalAmount += item.amount;
            if (isGenerated) slot.chargedAmount += item.amount;
        }
    }

    const schedule = [...scheduleMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, v]) => v);

    // Distribute payments across generated months chronologically
    let pool = Math.max(0, creditPool);
    for (const month of schedule) {
        if (month.chargedAmount === 0) {
            month.payStatus = 'upcoming';
            month.amountDue = month.totalAmount;
            month.amountPaid = 0;
            continue;
        }
        const due = month.chargedAmount;
        if (pool >= due) {
            month.payStatus = 'paid';
            month.amountPaid = due;
            month.amountDue = 0;
            pool -= due;
        } else if (pool > 0) {
            month.payStatus = 'partial';
            month.amountPaid = Math.round(pool * 100) / 100;
            month.amountDue = Math.round((due - pool) * 100) / 100;
            pool = 0;
        } else {
            month.payStatus = month.isFuture ? 'upcoming' : 'due';
            month.amountPaid = 0;
            month.amountDue = due;
        }
    }

    return schedule;
}

// Aggregate everything the fee-book screen needs for one student
async function buildFeeBook(schoolId, studentId) {
    const ay = await getActiveAcademicYear(schoolId);

    const [allLedgerEntries, payments, concessions, fineRules, settings] = await Promise.all([
        FeeLedger.find({ school: schoolId, student: studentId, academicYear: ay?._id }).sort({ createdAt: -1 }).lean(),
        FeePayment.find({ school: schoolId, student: studentId, academicYear: ay?._id }).sort({ paymentDate: -1 }).lean(),
        StudentConcession.find({ school: schoolId, student: studentId, academicYear: ay?._id, isActive: true })
            .populate('concession').lean(),
        FineRule.find({ school: schoolId, isActive: true }).lean(),
        FeeSettings.findOne({ school: schoolId }).lean(),
    ]);

    const resolved      = await resolveFeeItems(studentId, ay?._id, schoolId);
    const balance       = allLedgerEntries.length ? allLedgerEntries[0].runningBalance : 0;
    const totalCharged  = allLedgerEntries.filter(e => e.entryType === 'debit'  && e.category === 'fee_charged').reduce((s, e) => s + e.amount, 0);
    const totalPaid     = allLedgerEntries.filter(e => e.entryType === 'credit' && e.category === 'payment').reduce((s, e) => s + e.amount, 0);
    const totalConcession   = calcConcessionAmount(resolved?.items || [], concessions);
    const fineAmt           = resolved && fineRules.length ? calcFineAmount(resolved.dueDay || null, fineRules[0]) : 0;
    const ledgerConcessions = allLedgerEntries.filter(e => e.entryType === 'credit' && e.category === 'concession').reduce((s, e) => s + e.amount, 0);
    const monthlySchedule   = await buildMonthlySchedule(resolved, studentId, ay?._id, schoolId, totalPaid + ledgerConcessions);

    const dueTotal = monthlySchedule.filter(m => m.payStatus === 'due' || m.payStatus === 'partial').reduce((s, m) => s + m.amountDue, 0);
    const gateway  = settings?.onlinePaymentEnabled && settings?.paymentGateway !== 'none'
        ? settings.paymentGateway : 'none';

    return {
        activeYear: ay ? { _id: ay._id, yearName: ay.yearName } : null,
        resolved, balance, totalCharged, totalPaid, totalConcession, fineAmt,
        monthlySchedule, dueTotal,
        suggestedAmount: dueTotal > 0 ? dueTotal : (balance > 0 ? balance : 0),
        concessions,
        payments,
        gateway,
        razorpayKeyId:        gateway === 'razorpay' ? settings?.razorpayKeyId        : '',
        stripePublishableKey: gateway === 'stripe'   ? settings?.stripePublishableKey : '',
        currency:       settings?.currency       || 'INR',
        currencySymbol: settings?.currencySymbol || '₹',
    };
}

// ── STUDENT: My Fees (fee book) ───────────────────────────────────────────────

exports.getMyFees = async (req, res) => {
    try {
        const data = await buildFeeBook(req.schoolId, req.userId);
        res.json({ success: true, data });
    } catch (err) {
        console.error('[Fees] getMyFees:', err);
        res.status(500).json({ success: false, message: 'Failed to load your fees' });
    }
};

exports.getMyLedger = async (req, res) => {
    try {
        const ay = await getActiveAcademicYear(req.schoolId);
        const entries = await FeeLedger.find({ school: req.schoolId, student: req.userId, academicYear: ay?._id })
            .sort({ createdAt: -1 }).lean();
        const balance = entries.length ? entries[0].runningBalance : 0;
        res.json({ success: true, data: { entries, balance } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load ledger' });
    }
};

exports.getMyPayments = async (req, res) => {
    try {
        const ay = await getActiveAcademicYear(req.schoolId);
        const payments = await FeePayment.find({ school: req.schoolId, student: req.userId, academicYear: ay?._id })
            .sort({ paymentDate: -1 }).lean();
        res.json({ success: true, data: payments });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load payments' });
    }
};

exports.getMyReceipt = async (req, res) => {
    try {
        const payment = await FeePayment.findOne({
            _id: req.params.id, student: req.userId, school: req.schoolId,
        }).populate('student', 'name email').populate('lines.feeHead', 'name').lean();
        if (!payment) return res.status(404).json({ success: false, message: 'Receipt not found' });
        const settings = await FeeSettings.findOne({ school: req.schoolId }).lean();
        res.json({ success: true, data: { payment, settings } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load receipt' });
    }
};

exports.downloadMyReceipt = async (req, res) => {
    try {
        const payment = await FeePayment.findOne({
            _id: req.params.id, student: req.userId, school: req.schoolId,
        }).populate('student', 'name email').populate('lines.feeHead', 'name');
        if (!payment) return res.status(404).json({ success: false, message: 'Receipt not found' });
        const settings = await FeeSettings.findOne({ school: req.schoolId });
        const school   = await School.findById(req.schoolId);
        generateReceiptPDF(res, payment, school, settings, `receipt-${payment.receiptNumber}.pdf`);
    } catch (err) {
        console.error('[Fees] downloadMyReceipt:', err);
        res.status(500).json({ success: false, message: 'Download failed' });
    }
};

// ── helpers ──────────────────────────────────────────────────────────────────

async function getOrCreateReceiptNumber(schoolId) {
    const settings = await FeeSettings.findOneAndUpdate(
        { school: schoolId },
        { $inc: { lastReceiptNumber: 1 } },
        { new: true, upsert: true }
    );
    return `${settings.receiptPrefix || 'REC'}-${String(settings.lastReceiptNumber).padStart(6, '0')}`;
}

async function recordCompletedPayment({ schoolId, studentId, academicYearId, amount, paymentMode,
    gateway, gatewayOrderId, gatewayPaymentId, transactionRef, remarks, collectedBy, studentName, schoolName }) {

    const receiptNumber = await getOrCreateReceiptNumber(schoolId);
    const prevLedger = await FeeLedger.findOne(
        { school: schoolId, student: studentId, academicYear: academicYearId },
        { runningBalance: 1 }, { sort: { createdAt: -1 } }
    );
    const prevBalance = prevLedger?.runningBalance || 0;

    const payment = await FeePayment.create({
        school: schoolId, student: studentId, academicYear: academicYearId,
        receiptNumber, amount,
        lines: [{ feeName: 'Fee Payment', amount }],
        paymentMode, paymentStatus: 'completed',
        gateway: gateway || 'manual',
        gatewayOrderId: gatewayOrderId || '',
        gatewayPaymentId: gatewayPaymentId || '',
        transactionRef: transactionRef || gatewayPaymentId || '',
        remarks: remarks || '',
        paymentDate: new Date(),
        collectedBy: collectedBy || null,
        idempotencyKey: `gw-${schoolId}-${studentId}-${Date.now()}`,
        schoolSnapshot: { name: schoolName },
        studentSnapshot: { name: studentName, id: studentId },
    });

    const ledgerEntry = await FeeLedger.create({
        school: schoolId, student: studentId, academicYear: academicYearId,
        entryType: 'credit', category: 'payment', amount,
        description: `Payment received — Receipt ${receiptNumber}`,
        referenceType: 'FeePayment', referenceId: payment._id,
        runningBalance: Math.round((prevBalance - amount) * 100) / 100,
        createdBy: collectedBy || studentId,
    });

    payment.ledgerEntry = ledgerEntry._id;
    await payment.save();
    return payment;
}

// ── STUDENT: Pay Now ─────────────────────────────────────────────────────────

exports.getPayNow = async (req, res) => {
    try {
        const data = await buildFeeBook(req.schoolId, req.userId);
        if (!data.activeYear) return res.status(400).json({ success: false, message: 'No active academic year' });
        res.json({ success: true, data });
    } catch (err) {
        console.error('[Fees] getPayNow:', err);
        res.status(500).json({ success: false, message: 'Failed to load payment info' });
    }
};

// Offline / manual payment submission — goes to admin for verification
exports.payNow = async (req, res) => {
    try {
        const { amount, paymentMode, transactionRef, paymentDate, remarks } = req.body;
        const ay = await getActiveAcademicYear(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const payAmt = parseFloat(amount);
        if (!payAmt || payAmt <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

        const payment = await FeePayment.create({
            school: req.schoolId, student: req.userId, academicYear: ay._id,
            amount: payAmt, lines: [{ feeName: 'Fee Payment', amount: payAmt }],
            paymentMode: paymentMode || 'cash', paymentStatus: 'pending',
            transactionRef: transactionRef || '', remarks: remarks || '',
            paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
            idempotencyKey: `student-${req.schoolId}-${req.userId}-${Date.now()}`,
            schoolSnapshot: { name: req.user?.school?.name || '' },
            studentSnapshot: { name: req.user?.name || '', id: req.userId },
        });

        res.status(201).json({
            success: true,
            message: 'Payment submitted for verification. Admin will confirm shortly.',
            data: payment,
        });
    } catch (err) {
        console.error('[Fees] payNow:', err);
        res.status(500).json({ success: false, message: err.message || 'Payment submission failed' });
    }
};

// ── Razorpay: create order ───────────────────────────────────────────────────

async function createRazorpayOrderFor(schoolId, studentId, amount, receiptPrefix) {
    const payAmt = parseFloat(amount);
    if (!payAmt || payAmt <= 0) return { error: 'Invalid amount' };

    const settings = await FeeSettings.findOne({ school: schoolId });
    if (!settings?.razorpayKeyId || !settings?.razorpayKeySecret)
        return { error: 'Razorpay not configured.' };

    const Razorpay = require('razorpay');
    const rzp = new Razorpay({ key_id: settings.razorpayKeyId, key_secret: settings.razorpayKeySecret });

    const ay = await getActiveAcademicYear(schoolId);
    const order = await rzp.orders.create({
        amount: Math.round(payAmt * 100),
        currency: settings.currency || 'INR',
        receipt: `${receiptPrefix}-${studentId.toString().slice(-8)}-${Date.now().toString().slice(-8)}`,
        notes: { schoolId: schoolId.toString(), studentId: studentId.toString(), academicYearId: ay?._id?.toString() },
    });
    return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: settings.razorpayKeyId };
}

exports.createRazorpayOrder = async (req, res) => {
    try {
        const result = await createRazorpayOrderFor(req.schoolId, req.userId, req.body.amount, 'F');
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('[Fees] createRazorpayOrder:', err);
        res.status(500).json({ success: false, message: err.error?.description || err.message || 'Order creation failed' });
    }
};

async function verifyRazorpayAndRecord({ schoolId, studentId, body, schoolName }) {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount, remarks } = body;

    const settings = await FeeSettings.findOne({ school: schoolId });
    if (!settings?.razorpayKeySecret) throw new Error('Gateway not configured.');

    const expectedSig = crypto.createHmac('sha256', settings.razorpayKeySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');
    if (expectedSig !== razorpay_signature) throw new Error('Payment verification failed. Please contact admin.');

    const ay      = await getActiveAcademicYear(schoolId);
    const student = await User.findById(studentId).select('name');

    return recordCompletedPayment({
        schoolId, studentId, academicYearId: ay._id,
        amount: parseFloat(amount),
        paymentMode: 'online', gateway: 'razorpay',
        gatewayOrderId: razorpay_order_id,
        gatewayPaymentId: razorpay_payment_id,
        remarks,
        collectedBy: null,
        studentName: student?.name || '', schoolName: schoolName || '',
    });
}

exports.verifyRazorpay = async (req, res) => {
    try {
        const payment = await verifyRazorpayAndRecord({
            schoolId: req.schoolId, studentId: req.userId, body: req.body,
            schoolName: req.user?.school?.name,
        });
        res.json({ success: true, data: { paymentId: payment._id, receiptNumber: payment.receiptNumber } });
    } catch (err) {
        console.error('[Fees] verifyRazorpay:', err);
        res.status(400).json({ success: false, message: err.error?.description || err.message || 'Verification failed' });
    }
};

// ── Stripe: create PaymentIntent ─────────────────────────────────────────────

async function createStripeIntentFor(schoolId, studentId, amount, extraMeta = {}) {
    const payAmt = parseFloat(amount);
    if (!payAmt || payAmt <= 0) return { error: 'Invalid amount' };

    const settings = await FeeSettings.findOne({ school: schoolId });
    if (!settings?.stripeSecretKey) return { error: 'Stripe not configured.' };

    const stripe = require('stripe')(settings.stripeSecretKey);
    const ay = await getActiveAcademicYear(schoolId);
    const intent = await stripe.paymentIntents.create({
        amount: Math.round(payAmt * 100),
        currency: (settings.currency || 'INR').toLowerCase(),
        metadata: { schoolId: schoolId.toString(), studentId: studentId.toString(), academicYearId: ay?._id?.toString(), ...extraMeta },
    });
    return { clientSecret: intent.client_secret, publishableKey: settings.stripePublishableKey };
}

exports.createStripeIntent = async (req, res) => {
    try {
        const result = await createStripeIntentFor(req.schoolId, req.userId, req.body.amount);
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('[Fees] createStripeIntent:', err);
        res.status(500).json({ success: false, message: err.message || err.raw?.message || 'Intent creation failed' });
    }
};

async function verifyStripeAndRecord({ schoolId, studentId, body, schoolName }) {
    const { paymentIntentId, amount, remarks } = body;

    const settings = await FeeSettings.findOne({ school: schoolId });
    if (!settings?.stripeSecretKey) throw new Error('Gateway not configured.');

    const stripe = require('stripe')(settings.stripeSecretKey);
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (intent.status !== 'succeeded') throw new Error(`Payment not completed. Status: ${intent.status}`);

    const ay      = await getActiveAcademicYear(schoolId);
    const student = await User.findById(studentId).select('name');

    return recordCompletedPayment({
        schoolId, studentId, academicYearId: ay._id,
        amount: parseFloat(amount),
        paymentMode: 'online', gateway: 'stripe',
        gatewayPaymentId: paymentIntentId,
        remarks,
        collectedBy: null,
        studentName: student?.name || '', schoolName: schoolName || '',
    });
}

exports.verifyStripe = async (req, res) => {
    try {
        const payment = await verifyStripeAndRecord({
            schoolId: req.schoolId, studentId: req.userId, body: req.body,
            schoolName: req.user?.school?.name,
        });
        res.json({ success: true, data: { paymentId: payment._id, receiptNumber: payment.receiptNumber } });
    } catch (err) {
        console.error('[Fees] verifyStripe:', err);
        res.status(400).json({ success: false, message: err.message || 'Verification failed' });
    }
};

// ── PARENT: children & child fees ────────────────────────────────────────────

exports.getParentFeesRedirect = async (req, res) => {
    try {
        const children = await StudentProfile.find({ parent: req.userId, school: req.schoolId })
            .populate('user', '_id name').lean();
        const valid = children.filter(c => c.user).map(c => ({ _id: c.user._id, name: c.user.name }));
        res.json({ success: true, data: valid });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load children' });
    }
};

exports.getParentChildFees = async (req, res) => {
    try {
        const { childId } = req.params;
        if (!await assertParentChild(req.userId, childId, req.schoolId))
            return res.status(403).json({ success: false, message: 'Not your child' });

        const student = await User.findOne({ _id: childId, school: req.schoolId, role: 'student' }).select('name').lean();
        if (!student) return res.status(404).json({ success: false, message: 'Child not found' });

        const data = await buildFeeBook(req.schoolId, childId);
        res.json({ success: true, data: { ...data, child: student } });
    } catch (err) {
        console.error('[Fees] getParentChildFees:', err);
        res.status(500).json({ success: false, message: 'Failed to load fees' });
    }
};

exports.getParentPayNow = async (req, res) => {
    try {
        const { childId } = req.params;
        if (!await assertParentChild(req.userId, childId, req.schoolId))
            return res.status(403).json({ success: false, message: 'Not your child' });

        const data = await buildFeeBook(req.schoolId, childId);
        if (!data.activeYear) return res.status(400).json({ success: false, message: 'No active academic year' });
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load payment info' });
    }
};

exports.postParentPayNow = async (req, res) => {
    try {
        const { childId } = req.params;
        if (!await assertParentChild(req.userId, childId, req.schoolId))
            return res.status(403).json({ success: false, message: 'Not your child' });

        const { amount, paymentMode, transactionRef, paymentDate, remarks } = req.body;
        const ay = await getActiveAcademicYear(req.schoolId);
        if (!ay) return res.status(400).json({ success: false, message: 'No active academic year' });

        const payAmt = parseFloat(amount);
        if (!payAmt || payAmt <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

        const student = await User.findOne({ _id: childId, school: req.schoolId, role: 'student' }).select('name');
        if (!student) return res.status(404).json({ success: false, message: 'Child not found' });

        const payment = await FeePayment.create({
            school: req.schoolId, student: childId, academicYear: ay._id,
            amount: payAmt, lines: [{ feeName: 'Fee Payment', amount: payAmt }],
            paymentMode: paymentMode || 'cash', paymentStatus: 'pending',
            transactionRef: transactionRef || '', remarks: remarks || '',
            paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
            idempotencyKey: `parent-${req.schoolId}-${childId}-${Date.now()}`,
            schoolSnapshot: { name: req.user?.school?.name || '' },
            studentSnapshot: { name: student.name, id: childId },
        });

        res.status(201).json({
            success: true,
            message: `Payment for ${student.name} submitted. Admin will verify shortly.`,
            data: payment,
        });
    } catch (err) {
        console.error('[Fees] postParentPayNow:', err);
        res.status(500).json({ success: false, message: err.message || 'Payment submission failed' });
    }
};

exports.parentCreateRazorpayOrder = async (req, res) => {
    try {
        const { childId } = req.params;
        if (!await assertParentChild(req.userId, childId, req.schoolId))
            return res.status(403).json({ success: false, message: 'Not your child' });

        const result = await createRazorpayOrderFor(req.schoolId, childId, req.body.amount, 'P');
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('[Fees] parentCreateRazorpayOrder:', err);
        res.status(500).json({ success: false, message: err.error?.description || err.message || 'Order creation failed' });
    }
};

exports.parentVerifyRazorpay = async (req, res) => {
    try {
        const { childId } = req.params;
        if (!await assertParentChild(req.userId, childId, req.schoolId))
            return res.status(403).json({ success: false, message: 'Not your child' });

        const payment = await verifyRazorpayAndRecord({
            schoolId: req.schoolId, studentId: childId, body: req.body,
            schoolName: req.user?.school?.name,
        });
        res.json({ success: true, data: { paymentId: payment._id, receiptNumber: payment.receiptNumber } });
    } catch (err) {
        console.error('[Fees] parentVerifyRazorpay:', err);
        res.status(400).json({ success: false, message: err.error?.description || err.message || 'Verification failed' });
    }
};

exports.parentCreateStripeIntent = async (req, res) => {
    try {
        const { childId } = req.params;
        if (!await assertParentChild(req.userId, childId, req.schoolId))
            return res.status(403).json({ success: false, message: 'Not your child' });

        const result = await createStripeIntentFor(req.schoolId, childId, req.body.amount, { paidBy: 'parent' });
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('[Fees] parentCreateStripeIntent:', err);
        res.status(500).json({ success: false, message: err.message || err.raw?.message || 'Intent creation failed' });
    }
};

exports.parentVerifyStripe = async (req, res) => {
    try {
        const { childId } = req.params;
        if (!await assertParentChild(req.userId, childId, req.schoolId))
            return res.status(403).json({ success: false, message: 'Not your child' });

        const payment = await verifyStripeAndRecord({
            schoolId: req.schoolId, studentId: childId, body: req.body,
            schoolName: req.user?.school?.name,
        });
        res.json({ success: true, data: { paymentId: payment._id, receiptNumber: payment.receiptNumber } });
    } catch (err) {
        console.error('[Fees] parentVerifyStripe:', err);
        res.status(400).json({ success: false, message: err.message || 'Verification failed' });
    }
};

exports.getParentPaymentReceipt = async (req, res) => {
    try {
        const { childId, paymentId } = req.params;
        if (!await assertParentChild(req.userId, childId, req.schoolId))
            return res.status(403).json({ success: false, message: 'Not your child' });

        const payment = await FeePayment.findOne({
            _id: paymentId, student: childId, school: req.schoolId,
        }).populate('student', 'name email').populate('lines.feeHead', 'name').lean();
        if (!payment) return res.status(404).json({ success: false, message: 'Receipt not found' });
        const settings = await FeeSettings.findOne({ school: req.schoolId }).lean();
        res.json({ success: true, data: { payment, settings } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load receipt' });
    }
};

exports.downloadParentReceipt = async (req, res) => {
    try {
        const { childId, paymentId } = req.params;
        if (!await assertParentChild(req.userId, childId, req.schoolId))
            return res.status(403).json({ success: false, message: 'Not your child' });

        const payment = await FeePayment.findOne({
            _id: paymentId, student: childId, school: req.schoolId,
        }).populate('student', 'name email').populate('lines.feeHead', 'name');
        if (!payment) return res.status(404).json({ success: false, message: 'Receipt not found' });
        const settings = await FeeSettings.findOne({ school: req.schoolId });
        const school   = await School.findById(req.schoolId);
        generateReceiptPDF(res, payment, school, settings, `receipt-${payment.receiptNumber}.pdf`);
    } catch (err) {
        console.error('[Fees] downloadParentReceipt:', err);
        res.status(500).json({ success: false, message: 'Download failed' });
    }
};
