'use strict';
const InventoryItem       = require('../models/InventoryItem');
const InventoryStock      = require('../models/InventoryStock');
const InventoryDepartment = require('../models/InventoryDepartment');
const PurchaseRequest     = require('../models/PurchaseRequest');
const InventoryAuditLog   = require('../models/InventoryAuditLog');
const { notify, schoolAdminIds } = require('../services/notifyService');

const ok  = (res, data)          => res.json({ success: true, data });
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const err = (res, e)             => res.status(500).json({ success: false, message: e.message });

async function logAudit(req, actionType, entityId, description) {
    try {
        await InventoryAuditLog.create({
            school: req.schoolId, user: req.userId, role: req.userRole,
            actionType, entityType: 'PurchaseRequest', entityId, description,
        });
    } catch { /* non-critical */ }
}

async function nextNumber(schoolId) {
    const d  = new Date();
    const ym = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const count = await PurchaseRequest.countDocuments({ school: schoolId });
    return `PR-${ym}-${String(count + 1).padStart(4, '0')}`;
}

// Dropdown sources a teacher needs to raise a request.
exports.getMeta = async (req, res) => {
    try {
        const [items, departments] = await Promise.all([
            InventoryItem.find({ school: req.schoolId, isActive: true }).select('name itemCode unit purchasePrice').sort({ name: 1 }).lean(),
            InventoryDepartment.find({ school: req.schoolId, isActive: true }).select('name').sort({ name: 1 }).lean(),
        ]);
        ok(res, { items, departments });
    } catch (e) { err(res, e); }
};

exports.getMyRequests = async (req, res) => {
    try {
        const prs = await PurchaseRequest.find({ school: req.schoolId, requestedBy: req.userId })
            .populate('department', 'name').populate('purchaseOrder', 'poNumber status')
            .sort({ createdAt: -1 }).lean();
        ok(res, prs);
    } catch (e) { err(res, e); }
};

exports.getMyRequest = async (req, res) => {
    try {
        const pr = await PurchaseRequest.findOne({ _id: req.params.id, school: req.schoolId, requestedBy: req.userId })
            .populate('department', 'name').populate('items.item', 'name itemCode')
            .populate('approvals.actor', 'name').populate('purchaseOrder', 'poNumber status').lean();
        if (!pr) return bad(res, 'Request not found', 404);
        ok(res, pr);
    } catch (e) { err(res, e); }
};

exports.createRequest = async (req, res) => {
    try {
        const { items, department, reason, priority } = req.body;
        if (!items || !items.length) return bad(res, 'Add at least one item');

        const normalized = items
            .filter(i => i.itemName && Number(i.quantity) > 0)
            .map(i => ({
                item: i.item || null,
                itemName: i.itemName,
                quantity: Number(i.quantity),
                unit: i.unit || 'Nos',
                estimatedPrice: Number(i.estimatedPrice) || 0,
            }));
        if (!normalized.length) return bad(res, 'Add at least one valid item');

        const estimatedTotal = normalized.reduce((s, i) => s + i.quantity * i.estimatedPrice, 0);

        // ── System pre-checks (spec §5) ──────────────────────────────
        // Stock availability for any linked master items.
        const linkedIds = normalized.filter(i => i.item).map(i => i.item);
        let stockAvailable = false;
        if (linkedIds.length) {
            const agg = await InventoryStock.aggregate([
                { $match: { school: req.schoolId, item: { $in: linkedIds } } },
                { $group: { _id: '$item', qty: { $sum: '$quantity' }, reserved: { $sum: '$reserved' } } },
            ]);
            const avail = Object.fromEntries(agg.map(a => [String(a._id), a.qty - a.reserved]));
            stockAvailable = normalized.some(i => i.item && (avail[String(i.item)] || 0) >= i.quantity);
        }

        // Budget check.
        let budgetOk = true;
        if (department) {
            const dept = await InventoryDepartment.findOne({ _id: department, school: req.schoolId }).lean();
            if (dept && dept.annualBudget > 0) budgetOk = estimatedTotal <= (dept.annualBudget - dept.usedBudget);
        }

        // Duplicate check — a recent pending request by the same user for the same items.
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const names = normalized.map(i => i.itemName.toLowerCase());
        const recent = await PurchaseRequest.find({
            school: req.schoolId, requestedBy: req.userId, status: 'pending', createdAt: { $gte: since },
        }).select('items.itemName').lean();
        const possibleDuplicate = recent.some(r => r.items.some(it => names.includes((it.itemName || '').toLowerCase())));

        const requestNumber = await nextNumber(req.schoolId);
        const pr = await PurchaseRequest.create({
            school: req.schoolId, requestNumber, requestedBy: req.userId,
            department: department || null, reason: reason || '', priority: priority || 'normal',
            items: normalized, estimatedTotal,
            status: 'pending',
            checks: { stockAvailable, budgetOk, possibleDuplicate },
        });
        await logAudit(req, 'PR_CREATED', pr._id, `Purchase request ${requestNumber} created`);
        schoolAdminIds(req.schoolId).then(admins => notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📦 New purchase request',
            body: `${req.user?.name || 'A teacher'} raised ${requestNumber} (${normalized.length} item${normalized.length === 1 ? '' : 's'}, est. ₹${estimatedTotal.toLocaleString('en-IN')}).${reason ? `\nReason: ${reason}` : ''}`,
            recipients: admins,
        })).catch(() => {});
        ok(res, pr);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'Duplicate request number, please retry');
        err(res, e);
    }
};

exports.cancelRequest = async (req, res) => {
    try {
        const pr = await PurchaseRequest.findOne({ _id: req.params.id, school: req.schoolId, requestedBy: req.userId });
        if (!pr) return bad(res, 'Request not found', 404);
        if (pr.status !== 'pending') return bad(res, `Cannot cancel a ${pr.status} request`);
        pr.status = 'cancelled';
        await pr.save();
        await logAudit(req, 'PR_CANCELLED', pr._id, `Purchase request ${pr.requestNumber} cancelled by requester`);
        ok(res, pr);
    } catch (e) { err(res, e); }
};
