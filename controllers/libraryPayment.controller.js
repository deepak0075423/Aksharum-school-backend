'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Paying a library fine, and the receipt that follows.
//
//  Two audiences reach this: the member who owes the fine, and a parent paying
//  on a child's behalf. Both go through the same three steps — see what is
//  owed, open an order, confirm it — and both can pull the receipt afterwards,
//  whether the fine was settled online or handed over at the counter.
//
//  Nothing here trusts an amount from the client. The order is opened for the
//  fines named, priced from the database, and the payment is only recorded once
//  the gateway signature checks out.
// ─────────────────────────────────────────────────────────────────────────────
const LibraryFine     = require('../models/LibraryFine');
const LibraryIssuance = require('../models/LibraryIssuance');
const LibraryBook     = require('../models/LibraryBook');
const LibraryAuditLog = require('../models/LibraryAuditLog');
const School          = require('../models/School');
const User            = require('../models/User');
const StudentProfile  = require('../models/StudentProfile');
const ParentProfile   = require('../models/ParentProfile');
const ReceiptTemplate = require('../models/ReceiptTemplate');

const paymentGateway = require('../services/paymentGateway');
const { renderReceipt, defaultTemplate } = require('../services/receiptRenderer');
const { nextFineReceiptNumber, borrowerAudience, outstandingOf, fineStatusFor } = require('../services/libraryRules');
const { notify } = require('../services/notifyService');

const FINE_LABEL = { late_return: 'Late return', lost: 'Lost book', damaged: 'Damaged book' };

/**
 * Whose fines the caller may see or settle. A member may act for themselves; a
 * parent only for a child on their own profile — checked here rather than
 * trusted from the request.
 */
async function resolveSubject(req) {
    const asked = req.query.userId || req.body?.userId;
    if (req.userRole !== 'parent') {
        if (asked && String(asked) !== String(req.userId))
            return { ok: false, status: 403, message: 'You can only pay your own fines' };
        return { ok: true, userId: req.userId };
    }

    const parent = await ParentProfile.findOne({ user: req.userId, school: req.schoolId }).lean();
    const children = (parent?.children || []).map(String);
    if (!children.length) return { ok: false, status: 404, message: 'No child is linked to this account' };

    const target = asked ? String(asked) : children[0];
    if (!children.includes(target))
        return { ok: false, status: 403, message: 'That student is not linked to your account' };
    return { ok: true, userId: target, onBehalf: true };
}

/** A fine as a receipt line — what it was for, not just its type. */
async function describeFines(fines) {
    const issuanceIds = fines.map(f => f.issuance).filter(Boolean);
    const issuances = issuanceIds.length
        ? await LibraryIssuance.find({ _id: { $in: issuanceIds } }).select('book dueDate').lean()
        : [];
    const books = issuances.length
        ? await LibraryBook.find({ _id: { $in: issuances.map(i => i.book) } }).select('title').lean()
        : [];
    const titleOf = Object.fromEntries(books.map(b => [String(b._id), b.title]));
    const bookOf  = Object.fromEntries(issuances.map(i => [String(i._id), titleOf[String(i.book)] || '']));

    return fines.map(f => {
        const title = bookOf[String(f.issuance)] || '';
        const days  = f.fineType === 'late_return' && f.daysOverdue ? ` (${f.daysOverdue} day${f.daysOverdue === 1 ? '' : 's'})` : '';
        const waived = Number(f.waivedAmount || 0);
        return {
            label: `${FINE_LABEL[f.fineType] || f.fineType}${title ? ` — "${title}"` : ''}${days}`
                + (waived > 0 ? ` — ₹${waived} waived` : ''),
            // What was actually settled, so the receipt totals to the money paid.
            amount: waived > 0 ? Math.max(0, Number(f.amount || 0) - waived) : (f.amount || 0),
        };
    });
}

// ── What is owed ─────────────────────────────────────────────────────────────

exports.getMyFineSummary = async (req, res) => {
    try {
        const subject = await resolveSubject(req);
        if (!subject.ok) return res.status(subject.status).json({ success: false, message: subject.message });

        const [school, fines] = await Promise.all([
            School.findById(req.schoolId).select('paymentGateway').lean(),
            LibraryFine.find({ school: req.schoolId, user: subject.userId })
                .sort({ createdAt: -1 }).limit(200).lean(),
        ]);

        const pending = fines.filter(f => f.status === 'pending');
        const lines   = await describeFines(pending);
        // A part-waived fine shows what is left to pay, not what was charged.
        const owedOf  = Object.fromEntries(pending.map(f => [String(f._id), outstandingOf(f)]));

        res.json({
            success: true,
            data: {
                pending: pending.map((f, i) => ({
                    ...f,
                    description: lines[i]?.label || '',
                    outstanding: owedOf[String(f._id)] ?? 0,
                })),
                settled: fines.filter(f => f.status !== 'pending'),
                outstanding: pending.reduce((sum, f) => sum + outstandingOf(f), 0),
                // Whether an online payment is even offered, and with what key.
                gateway: paymentGateway.publicGateway(school?.paymentGateway, 'library'),
                payingFor: subject.onBehalf ? subject.userId : null,
            },
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Open an order ────────────────────────────────────────────────────────────

exports.createFineOrder = async (req, res) => {
    try {
        const subject = await resolveSubject(req);
        if (!subject.ok) return res.status(subject.status).json({ success: false, message: subject.message });

        const wanted = Array.isArray(req.body.fineIds) ? req.body.fineIds.map(String) : [];
        const filter = { school: req.schoolId, user: subject.userId, status: 'pending' };
        if (wanted.length) filter._id = { $in: wanted };

        const fines = await LibraryFine.find(filter).lean();
        if (!fines.length) return res.status(400).json({ success: false, message: 'There is nothing outstanding to pay' });

        // Priced from the database, never from the request — and from what is
        // still owed, so a waiver actually reduces what the parent is charged.
        const amount = fines.reduce((sum, f) => sum + outstandingOf(f), 0);
        if (amount <= 0) return res.status(400).json({ success: false, message: 'There is nothing outstanding to pay' });

        const order = await paymentGateway.createOrder(
            req.schoolId, 'library', amount,
            `LIBFINE-${String(subject.userId).slice(-8)}-${Date.now().toString().slice(-8)}`,
        );
        if (order.error) return res.status(400).json({ success: false, message: order.error });

        res.json({
            success: true,
            data: { ...order, fineIds: fines.map(f => String(f._id)), payable: amount },
        });
    } catch (e) {
        console.error('[Library] createFineOrder:', e);
        res.status(500).json({ success: false, message: e.error?.description || e.message || 'Could not start the payment' });
    }
};

// ── Confirm it ───────────────────────────────────────────────────────────────

exports.confirmFinePayment = async (req, res) => {
    try {
        const subject = await resolveSubject(req);
        if (!subject.ok) return res.status(subject.status).json({ success: false, message: subject.message });

        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, fineIds } = req.body;
        const verified = await paymentGateway.verifySignature(req.schoolId, 'library', {
            orderId: razorpay_order_id, paymentId: razorpay_payment_id, signature: razorpay_signature,
        });
        if (!verified.ok) return res.status(400).json({ success: false, message: verified.reason });

        const filter = { school: req.schoolId, user: subject.userId, status: 'pending' };
        if (Array.isArray(fineIds) && fineIds.length) filter._id = { $in: fineIds.map(String) };

        const fines = await LibraryFine.find(filter).lean();
        if (!fines.length) {
            // The signature was good but nothing is outstanding — almost always
            // a double submit. Point at the receipt already issued.
            const already = await LibraryFine.findOne({
                school: req.schoolId, user: subject.userId, gatewayPaymentId: razorpay_payment_id }).lean();
            if (already) return res.json({ success: true, data: { receiptNumber: already.receiptNumber, alreadyRecorded: true } });
            return res.status(400).json({ success: false, message: 'These fines have already been settled' });
        }

        const receiptNumber = await nextFineReceiptNumber(req.schoolId);
        const paidAt = new Date();
        const total  = fines.reduce((sum, f) => sum + outstandingOf(f), 0);

        // Every fine in the order shares the receipt, so one payment produces
        // one document however many fines it cleared.
        for (const f of fines) {
            const owed = outstandingOf(f);
            const settled = { ...f, paidAmount: Number(f.paidAmount || 0) + owed };
            await LibraryFine.updateOne({ _id: f._id, status: 'pending' }, {
                paidAmount: settled.paidAmount,
                status: fineStatusFor(settled),
                paidAt, paymentMode: 'online', receiptNumber,
                gatewayOrderId: razorpay_order_id, gatewayPaymentId: razorpay_payment_id,
                paidBy: req.userId, collectedBy: null,
            });
            await LibraryAuditLog.create({
                school: req.schoolId, user: req.userId, role: req.userRole,
                actionType: 'FINE_PAID', entityType: 'Fine', entityId: f._id,
                oldValue: { status: 'pending' },
                newValue: { status: 'paid', mode: 'online', receiptNumber, payment: razorpay_payment_id },
            }).catch(() => {});
        }

        const payer = await User.findById(subject.userId).select('role').lean();
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '💳 Library fine paid',
            body: `A library fine of ₹${total.toLocaleString('en-IN')} has been paid online.\nReceipt: ${receiptNumber}`,
            recipients: await borrowerAudience({ issuedTo: subject.userId, issuedToRole: payer?.role || '' }),
            includeSender: true,
        });

        res.json({ success: true, data: { receiptNumber, amount: total, count: fines.length } });
    } catch (e) {
        console.error('[Library] confirmFinePayment:', e);
        res.status(500).json({ success: false, message: e.message || 'Could not confirm the payment' });
    }
};

// ── The receipt ──────────────────────────────────────────────────────────────

/**
 * Renders every fine sharing a receipt number as one document. Works for a
 * counter payment as well as an online one — the only difference is which
 * design the school chose for that mode.
 */
exports.getFineReceipt = async (req, res) => {
    try {
        const receiptNumber = String(req.params.receiptNumber || '').trim();
        if (!receiptNumber) return res.status(400).json({ success: false, message: 'Which receipt?' });

        const fines = await LibraryFine.find({ school: req.schoolId, receiptNumber }).lean();
        if (!fines.length) return res.status(404).json({ success: false, message: 'Receipt not found' });

        // A receipt belongs to the person it was issued to — a member sees
        // their own, a parent sees their child's, staff see any.
        const owner = String(fines[0].user);
        if (['student', 'teacher'].includes(req.userRole) && owner !== String(req.userId))
            return res.status(403).json({ success: false, message: 'This receipt belongs to someone else' });
        if (req.userRole === 'parent') {
            const parent = await ParentProfile.findOne({ user: req.userId, school: req.schoolId }).lean();
            if (!(parent?.children || []).map(String).includes(owner))
                return res.status(403).json({ success: false, message: 'This receipt belongs to someone else' });
        }

        const mode = fines[0].paymentMode === 'online' ? 'online' : 'offline';
        const [school, template, member, profile] = await Promise.all([
            School.findById(req.schoolId).select('name address logo').lean(),
            ReceiptTemplate.findOne({ school: req.schoolId, module: 'library', paymentMode: mode }).lean(),
            User.findById(owner).select('name').lean(),
            StudentProfile.findOne({ user: owner }).select('currentClass currentSection admissionNumber')
                .populate('currentClass', 'className classNumber').populate('currentSection', 'sectionName').lean(),
        ]);

        const lines = await describeFines(fines);
        const detail = profile
            ? [profile.currentClass?.className || (profile.currentClass?.classNumber ? `Class ${profile.currentClass.classNumber}` : ''),
               profile.currentSection?.sectionName].filter(Boolean).join(' · ')
            : '';

        const origin = `${req.protocol}://${req.get('host')}`;
        const receipt = {
            module: 'library',
            number: receiptNumber,
            date: fines[0].paidAt || fines[0].updatedAt || fines[0].createdAt,
            paidBy: member?.name || '',
            paidByDetailLabel: profile ? 'Class' : '',
            paidByDetail: detail,
            title: 'Library fine receipt',
            paymentMode: mode,
            offlineModeLabel: 'Cash (at the library)',
            reference: fines[0].gatewayPaymentId || '',
            lines,
            total: fines.reduce((sum, f) => sum + Number(f.paidAmount || 0), 0)
                || fines.reduce((sum, f) => sum + Math.max(0, Number(f.amount || 0) - Number(f.waivedAmount || 0)), 0),
            currencySymbol: '₹',
        };
        const schoolForReceipt = school && {
            name: school.name,
            address: school.address,
            logoUrl: school.logo ? (/^https?:/.test(school.logo) ? school.logo : `${origin}${school.logo}`) : '',
        };

        // The phone has no HTML surface of its own, so it asks for the data and
        // draws the receipt natively. A browser gets the rendered document.
        if (String(req.query.format || '').toLowerCase() === 'json') {
            return res.json({ success: true, data: { ...receipt, school: schoolForReceipt } });
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderReceipt(receipt, template || defaultTemplate('library', mode), { school: schoolForReceipt }));
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

/** Receipts the caller may open, newest first — the "my payments" list. */
exports.listMyReceipts = async (req, res) => {
    try {
        const subject = await resolveSubject(req);
        if (!subject.ok) return res.status(subject.status).json({ success: false, message: subject.message });

        const fines = await LibraryFine.find({
            school: req.schoolId, user: subject.userId, status: 'paid',
            receiptNumber: { $ne: '' },
        }).sort({ paidAt: -1 }).limit(200).lean();

        // One row per receipt, not per fine.
        const byReceipt = new Map();
        for (const f of fines) {
            const key = f.receiptNumber;
            const row = byReceipt.get(key) || {
                receiptNumber: key, paidAt: f.paidAt, paymentMode: f.paymentMode || 'cash',
                reference: f.gatewayPaymentId || '', amount: 0, count: 0,
            };
            row.amount += Number(f.paidAmount || 0) || Math.max(0, Number(f.amount || 0) - Number(f.waivedAmount || 0));
            row.count  += 1;
            byReceipt.set(key, row);
        }
        res.json({ success: true, data: [...byReceipt.values()] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
