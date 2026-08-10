'use strict';
const InventoryCategory        = require('../models/InventoryCategory');
const InventoryVendor          = require('../models/InventoryVendor');
const InventoryWarehouse       = require('../models/InventoryWarehouse');
const InventoryDepartment      = require('../models/InventoryDepartment');
const InventoryItem            = require('../models/InventoryItem');
const InventoryStock           = require('../models/InventoryStock');
const InventoryStockTransaction = require('../models/InventoryStockTransaction');
const PurchaseRequest          = require('../models/PurchaseRequest');
const PurchaseOrder            = require('../models/PurchaseOrder');
const InventoryIssue           = require('../models/InventoryIssue');
const InventoryAsset           = require('../models/InventoryAsset');
const InventoryAuditLog        = require('../models/InventoryAuditLog');
const { notify }               = require('../services/notifyService');

// ── Helpers ─────────────────────────────────────────────────────────────────

const ok  = (res, data)          => res.json({ success: true, data });
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const err = (res, e)             => res.status(500).json({ success: false, message: e.message });

async function logAudit(req, actionType, entityType, entityId, description, meta) {
    try {
        await InventoryAuditLog.create({
            school: req.schoolId, user: req.userId, role: req.userRole,
            actionType, entityType, entityId, description, meta,
        });
    } catch { /* non-critical */ }
}

// Sequential document number: PREFIX-YYMM-#### scoped per school.
async function nextNumber(Model, schoolId, prefix) {
    const d  = new Date();
    const ym = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const count = await Model.countDocuments({ school: schoolId });
    return `${prefix}-${ym}-${String(count + 1).padStart(4, '0')}`;
}

// Apply a signed stock delta and record an immutable ledger entry.
async function applyStockMovement(req, {
    item, warehouse, type, quantity, unitCost = 0,
    refType = '', refId = null, note = '',
    batchNumber = '', serialNumbers = [], expiryDate = null,
}) {
    let stock = await InventoryStock.findOne({ school: req.schoolId, item, warehouse });
    if (!stock) stock = new InventoryStock({ school: req.schoolId, item, warehouse, quantity: 0, reserved: 0 });

    const before = stock.quantity || 0;
    stock.quantity = Math.max(0, before + quantity);

    // Weighted-average cost on inbound purchase movements.
    if (quantity > 0 && unitCost > 0) {
        const prevVal = before * (stock.avgCost || 0);
        stock.avgCost = stock.quantity > 0 ? (prevVal + quantity * unitCost) / stock.quantity : unitCost;
    }
    await stock.save();

    await InventoryStockTransaction.create({
        school: req.schoolId, item, warehouse, type, quantity,
        balanceAfter: stock.quantity, unitCost, refType, refId, note,
        batchNumber, serialNumbers, expiryDate, performedBy: req.userId,
    });
    return stock;
}

// ── Dashboard (spec §1) ──────────────────────────────────────────────────────

exports.getDashboard = async (req, res) => {
    try {
        const school = req.schoolId;
        const now = new Date();
        const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        // Per-item aggregated on-hand quantity + reorder level.
        const stockAgg = await InventoryStock.aggregate([
            { $match: { school } },
            { $lookup: { from: 'inventoryitems', localField: 'item', foreignField: '_id', as: 'itm' } },
            { $unwind: '$itm' },
            { $group: {
                _id: '$item',
                name: { $first: '$itm.name' },
                itemCode: { $first: '$itm.itemCode' },
                reorderLevel: { $first: '$itm.reorderLevel' },
                purchasePrice: { $first: '$itm.purchasePrice' },
                qty: { $sum: '$quantity' },
                value: { $sum: { $multiply: ['$quantity', { $ifNull: ['$avgCost', 0] }] } },
            } },
        ]);

        const lowStock = stockAgg.filter(s => s.reorderLevel > 0 && s.qty > 0 && s.qty <= s.reorderLevel);
        const outOfStock = stockAgg.filter(s => s.qty <= 0);
        const stockValue = stockAgg.reduce((sum, s) => sum + (s.value || (s.qty * (s.purchasePrice || 0))), 0);

        const [
            totalItems, totalAssets, totalVendors,
            pendingRequests, pendingPOs, itemsUnderRepair,
            departments, recentTx, recentPOs,
        ] = await Promise.all([
            InventoryItem.countDocuments({ school, isActive: true }),
            InventoryAsset.countDocuments({ school, status: { $ne: 'disposed' } }),
            InventoryVendor.countDocuments({ school, isActive: true }),
            PurchaseRequest.countDocuments({ school, status: 'pending' }),
            PurchaseOrder.countDocuments({ school, status: { $in: ['ordered', 'partially_received'] } }),
            InventoryAsset.countDocuments({ school, status: 'under_repair' }),
            InventoryDepartment.find({ school, isActive: true }).lean(),
            InventoryStockTransaction.find({ school }).sort({ createdAt: -1 }).limit(8)
                .populate('item', 'name itemCode').populate('warehouse', 'name').populate('performedBy', 'name').lean(),
            PurchaseOrder.find({ school }).sort({ createdAt: -1 }).limit(6).populate('vendor', 'name').lean(),
        ]);

        // Expiring products — batches with an expiry date inside the next 30 days.
        const expiringAgg = await InventoryStockTransaction.distinct('item', {
            school, expiryDate: { $ne: null, $gte: now, $lte: in30 },
        });

        // Monthly purchase trend (last 6 months of PO grand totals).
        const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
        const trendAgg = await PurchaseOrder.aggregate([
            { $match: { school, createdAt: { $gte: sixMonthsAgo } } },
            { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
            { $sort: { '_id.y': 1, '_id.m': 1 } },
        ]);
        const monthlyTrends = trendAgg.map(t => ({ year: t._id.y, month: t._id.m, total: t.total, count: t.count }));

        // Top consumed items (by issued quantity).
        const consumedAgg = await InventoryStockTransaction.aggregate([
            { $match: { school, type: 'issue' } },
            { $group: { _id: '$item', consumed: { $sum: { $abs: '$quantity' } } } },
            { $sort: { consumed: -1 } }, { $limit: 5 },
            { $lookup: { from: 'inventoryitems', localField: '_id', foreignField: '_id', as: 'itm' } },
            { $unwind: '$itm' },
            { $project: { _id: 1, consumed: 1, name: '$itm.name', itemCode: '$itm.itemCode' } },
        ]);

        // AI recommendations — simple heuristic reorder suggestions from low stock.
        const aiRecommendations = lowStock.slice(0, 6).map(s => ({
            item: s._id, name: s.name, itemCode: s.itemCode,
            current: s.qty, reorderLevel: s.reorderLevel,
            suggestedQty: Math.max(s.reorderLevel * 2 - s.qty, s.reorderLevel),
            message: `${s.name} is low (${s.qty}/${s.reorderLevel}). Suggest reordering ${Math.max(s.reorderLevel * 2 - s.qty, s.reorderLevel)} ${''}units.`,
        }));

        ok(res, {
            totalItems,
            totalAssets,
            totalVendors,
            stockValue: Math.round(stockValue),
            pendingRequests,
            pendingPOs,
            goodsAwaitingReceipt: pendingPOs,
            lowStockCount: lowStock.length,
            outOfStockCount: outOfStock.length,
            expiringCount: expiringAgg.length,
            itemsUnderRepair,
            lowStock: lowStock.slice(0, 8),
            departmentBudgets: departments.map(d => ({
                _id: d._id, name: d.name,
                annualBudget: d.annualBudget, usedBudget: d.usedBudget,
                remaining: (d.annualBudget || 0) - (d.usedBudget || 0),
                utilization: d.annualBudget ? Math.round((d.usedBudget / d.annualBudget) * 100) : 0,
            })),
            recentTransactions: recentTx,
            recentPurchaseOrders: recentPOs,
            monthlyTrends,
            topConsumed: consumedAgg,
            aiRecommendations,
        });
    } catch (e) { err(res, e); }
};

// ── Meta (dropdown sources for forms) ─────────────────────────────────────────

exports.getMeta = async (req, res) => {
    try {
        const school = req.schoolId;
        const [categories, vendors, warehouses, departments, items] = await Promise.all([
            InventoryCategory.find({ school, isActive: true }).select('name parent').sort({ name: 1 }).lean(),
            InventoryVendor.find({ school, isActive: true }).select('name').sort({ name: 1 }).lean(),
            InventoryWarehouse.find({ school, isActive: true }).select('name campus').sort({ name: 1 }).lean(),
            InventoryDepartment.find({ school, isActive: true }).select('name annualBudget usedBudget').sort({ name: 1 }).lean(),
            InventoryItem.find({ school, isActive: true }).select('name itemCode unit purchasePrice').sort({ name: 1 }).lean(),
        ]);
        ok(res, { categories, vendors, warehouses, departments, items });
    } catch (e) { err(res, e); }
};

// ── Categories (spec §2) ──────────────────────────────────────────────────────

exports.getCategories = async (req, res) => {
    try {
        const cats = await InventoryCategory.find({ school: req.schoolId })
            .populate('parent', 'name').sort({ name: 1 }).lean();
        ok(res, cats);
    } catch (e) { err(res, e); }
};

exports.createCategory = async (req, res) => {
    try {
        const { name, parent, description } = req.body;
        if (!name) return bad(res, 'Name is required');
        const cat = await InventoryCategory.create({
            school: req.schoolId, name, parent: parent || null, description, createdBy: req.userId,
        });
        await logAudit(req, 'CATEGORY_CREATED', 'InventoryCategory', cat._id, `Category "${name}" created`);
        ok(res, cat);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A category with this name already exists');
        err(res, e);
    }
};

exports.updateCategory = async (req, res) => {
    try {
        const { name, parent, description, isActive } = req.body;
        const cat = await InventoryCategory.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            { name, parent: parent || null, description, ...(isActive !== undefined && { isActive }) },
            { new: true });
        if (!cat) return bad(res, 'Category not found', 404);
        await logAudit(req, 'CATEGORY_UPDATED', 'InventoryCategory', cat._id, `Category "${cat.name}" updated`);
        ok(res, cat);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A category with this name already exists');
        err(res, e);
    }
};

exports.deleteCategory = async (req, res) => {
    try {
        const inUse = await InventoryItem.countDocuments({ school: req.schoolId, category: req.params.id });
        if (inUse) return bad(res, `Cannot delete — ${inUse} item(s) use this category`);
        const cat = await InventoryCategory.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!cat) return bad(res, 'Category not found', 404);
        await logAudit(req, 'CATEGORY_DELETED', 'InventoryCategory', cat._id, `Category "${cat.name}" deleted`);
        ok(res, { deleted: true });
    } catch (e) { err(res, e); }
};

// ── Vendors (spec §4) ─────────────────────────────────────────────────────────

exports.getVendors = async (req, res) => {
    try {
        const vendors = await InventoryVendor.find({ school: req.schoolId }).sort({ name: 1 }).lean();
        ok(res, vendors);
    } catch (e) { err(res, e); }
};

exports.createVendor = async (req, res) => {
    try {
        if (!req.body.name) return bad(res, 'Company name is required');
        const vendor = await InventoryVendor.create({ ...req.body, school: req.schoolId, createdBy: req.userId });
        await logAudit(req, 'VENDOR_CREATED', 'InventoryVendor', vendor._id, `Vendor "${vendor.name}" created`);
        ok(res, vendor);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A vendor with this name already exists');
        err(res, e);
    }
};

exports.updateVendor = async (req, res) => {
    try {
        const vendor = await InventoryVendor.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            { ...req.body, school: req.schoolId }, { new: true });
        if (!vendor) return bad(res, 'Vendor not found', 404);
        await logAudit(req, 'VENDOR_UPDATED', 'InventoryVendor', vendor._id, `Vendor "${vendor.name}" updated`);
        ok(res, vendor);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A vendor with this name already exists');
        err(res, e);
    }
};

exports.deleteVendor = async (req, res) => {
    try {
        const inUse = await PurchaseOrder.countDocuments({ school: req.schoolId, vendor: req.params.id });
        if (inUse) return bad(res, `Cannot delete — vendor has ${inUse} purchase order(s)`);
        const vendor = await InventoryVendor.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!vendor) return bad(res, 'Vendor not found', 404);
        await logAudit(req, 'VENDOR_DELETED', 'InventoryVendor', vendor._id, `Vendor "${vendor.name}" deleted`);
        ok(res, { deleted: true });
    } catch (e) { err(res, e); }
};

// ── Warehouses (spec §12) ─────────────────────────────────────────────────────

exports.getWarehouses = async (req, res) => {
    try {
        const whs = await InventoryWarehouse.find({ school: req.schoolId })
            .populate('manager', 'name').sort({ campus: 1, name: 1 }).lean();
        ok(res, whs);
    } catch (e) { err(res, e); }
};

exports.createWarehouse = async (req, res) => {
    try {
        if (!req.body.name) return bad(res, 'Warehouse name is required');
        const wh = await InventoryWarehouse.create({
            ...req.body, manager: req.body.manager || null, school: req.schoolId, createdBy: req.userId,
        });
        await logAudit(req, 'WAREHOUSE_CREATED', 'InventoryWarehouse', wh._id, `Warehouse "${wh.name}" created`);
        ok(res, wh);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A warehouse with this name already exists on this campus');
        err(res, e);
    }
};

exports.updateWarehouse = async (req, res) => {
    try {
        const wh = await InventoryWarehouse.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            { ...req.body, manager: req.body.manager || null }, { new: true });
        if (!wh) return bad(res, 'Warehouse not found', 404);
        await logAudit(req, 'WAREHOUSE_UPDATED', 'InventoryWarehouse', wh._id, `Warehouse "${wh.name}" updated`);
        ok(res, wh);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A warehouse with this name already exists on this campus');
        err(res, e);
    }
};

exports.deleteWarehouse = async (req, res) => {
    try {
        const hasStock = await InventoryStock.countDocuments({ school: req.schoolId, warehouse: req.params.id, quantity: { $gt: 0 } });
        if (hasStock) return bad(res, 'Cannot delete — warehouse still holds stock');
        const wh = await InventoryWarehouse.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!wh) return bad(res, 'Warehouse not found', 404);
        await logAudit(req, 'WAREHOUSE_DELETED', 'InventoryWarehouse', wh._id, `Warehouse "${wh.name}" deleted`);
        ok(res, { deleted: true });
    } catch (e) { err(res, e); }
};

// ── Departments & Budget (spec §6) ────────────────────────────────────────────

exports.getDepartments = async (req, res) => {
    try {
        const depts = await InventoryDepartment.find({ school: req.schoolId }).sort({ name: 1 }).lean();
        ok(res, depts.map(d => ({ ...d, remaining: (d.annualBudget || 0) - (d.usedBudget || 0) })));
    } catch (e) { err(res, e); }
};

exports.createDepartment = async (req, res) => {
    try {
        if (!req.body.name) return bad(res, 'Department name is required');
        const dept = await InventoryDepartment.create({ ...req.body, school: req.schoolId, createdBy: req.userId });
        await logAudit(req, 'DEPARTMENT_CREATED', 'InventoryDepartment', dept._id, `Department "${dept.name}" created`);
        ok(res, dept);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A department with this name already exists');
        err(res, e);
    }
};

exports.updateDepartment = async (req, res) => {
    try {
        // usedBudget is system-managed — never accept it from the client.
        const { usedBudget, ...rest } = req.body;
        const dept = await InventoryDepartment.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId }, rest, { new: true });
        if (!dept) return bad(res, 'Department not found', 404);
        await logAudit(req, 'DEPARTMENT_UPDATED', 'InventoryDepartment', dept._id, `Department "${dept.name}" updated`);
        ok(res, dept);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A department with this name already exists');
        err(res, e);
    }
};

exports.deleteDepartment = async (req, res) => {
    try {
        const dept = await InventoryDepartment.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!dept) return bad(res, 'Department not found', 404);
        await logAudit(req, 'DEPARTMENT_DELETED', 'InventoryDepartment', dept._id, `Department "${dept.name}" deleted`);
        ok(res, { deleted: true });
    } catch (e) { err(res, e); }
};

// ── Item Master (spec §3) ─────────────────────────────────────────────────────

exports.getItems = async (req, res) => {
    try {
        const { search, category, page = 1, limit = 50 } = req.query;
        const q = { school: req.schoolId };
        if (category) q.category = category;
        if (search) q.$or = [
            { name: new RegExp(search, 'i') },
            { itemCode: new RegExp(search, 'i') },
            { barcode: new RegExp(search, 'i') },
        ];
        const skip = (Number(page) - 1) * Number(limit);
        const [items, total] = await Promise.all([
            InventoryItem.find(q).populate('category', 'name').populate('warehouse', 'name')
                .sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
            InventoryItem.countDocuments(q),
        ]);

        // Attach total on-hand quantity per item.
        const ids = items.map(i => i._id);
        const stockMap = {};
        if (ids.length) {
            const agg = await InventoryStock.aggregate([
                { $match: { school: req.schoolId, item: { $in: ids } } },
                { $group: { _id: '$item', qty: { $sum: '$quantity' }, reserved: { $sum: '$reserved' } } },
            ]);
            agg.forEach(a => { stockMap[a._id] = a; });
        }
        ok(res, {
            items: items.map(i => ({
                ...i,
                onHand: stockMap[i._id]?.qty || 0,
                reserved: stockMap[i._id]?.reserved || 0,
            })),
            total, page: Number(page), pages: Math.ceil(total / Number(limit)),
        });
    } catch (e) { err(res, e); }
};

exports.getItem = async (req, res) => {
    try {
        const item = await InventoryItem.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('category', 'name').populate('warehouse', 'name').lean();
        if (!item) return bad(res, 'Item not found', 404);
        const [stock, transactions] = await Promise.all([
            InventoryStock.find({ school: req.schoolId, item: item._id }).populate('warehouse', 'name campus').lean(),
            InventoryStockTransaction.find({ school: req.schoolId, item: item._id })
                .sort({ createdAt: -1 }).limit(20).populate('warehouse', 'name').populate('performedBy', 'name').lean(),
        ]);
        ok(res, { ...item, stock: stock.map(s => ({ ...s, available: Math.max(0, s.quantity - s.reserved) })), transactions });
    } catch (e) { err(res, e); }
};

exports.createItem = async (req, res) => {
    try {
        const body = { ...req.body, school: req.schoolId, createdBy: req.userId };
        if (!body.name) return bad(res, 'Item name is required');
        if (!body.itemCode) body.itemCode = await nextNumber(InventoryItem, req.schoolId, 'ITM');
        ['category', 'warehouse'].forEach(k => { if (!body[k]) body[k] = null; });
        const item = await InventoryItem.create(body);
        await logAudit(req, 'ITEM_CREATED', 'InventoryItem', item._id, `Item "${item.name}" (${item.itemCode}) created`);
        ok(res, item);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'An item with this code already exists');
        err(res, e);
    }
};

exports.updateItem = async (req, res) => {
    try {
        const body = { ...req.body };
        delete body.school; delete body.createdBy;
        ['category', 'warehouse'].forEach(k => { if (k in body && !body[k]) body[k] = null; });
        const item = await InventoryItem.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId }, body, { new: true });
        if (!item) return bad(res, 'Item not found', 404);
        await logAudit(req, 'ITEM_UPDATED', 'InventoryItem', item._id, `Item "${item.name}" updated`);
        ok(res, item);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'An item with this code already exists');
        err(res, e);
    }
};

exports.deleteItem = async (req, res) => {
    try {
        const hasStock = await InventoryStock.countDocuments({ school: req.schoolId, item: req.params.id, quantity: { $gt: 0 } });
        if (hasStock) return bad(res, 'Cannot delete — item still has stock. Adjust stock to zero first.');
        const item = await InventoryItem.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!item) return bad(res, 'Item not found', 404);
        await logAudit(req, 'ITEM_DELETED', 'InventoryItem', item._id, `Item "${item.name}" deleted`);
        ok(res, { deleted: true });
    } catch (e) { err(res, e); }
};

// ── Stock (spec §13) ──────────────────────────────────────────────────────────

exports.getStock = async (req, res) => {
    try {
        const { warehouse, lowOnly } = req.query;
        const q = { school: req.schoolId };
        if (warehouse) q.warehouse = warehouse;
        const rows = await InventoryStock.find(q)
            .populate('item', 'name itemCode unit reorderLevel')
            .populate('warehouse', 'name campus')
            .sort({ updatedAt: -1 }).lean();
        let data = rows
            .filter(r => r.item)
            .map(r => ({
                ...r,
                available: Math.max(0, r.quantity - r.reserved),
                low: r.item.reorderLevel > 0 && r.quantity <= r.item.reorderLevel,
            }));
        if (lowOnly === 'true') data = data.filter(r => r.low);
        ok(res, data);
    } catch (e) { err(res, e); }
};

exports.getTransactions = async (req, res) => {
    try {
        const { item, warehouse, type, page = 1, limit = 50 } = req.query;
        const q = { school: req.schoolId };
        if (item) q.item = item;
        if (warehouse) q.warehouse = warehouse;
        if (type) q.type = type;
        const skip = (Number(page) - 1) * Number(limit);
        const [txns, total] = await Promise.all([
            InventoryStockTransaction.find(q)
                .populate('item', 'name itemCode').populate('warehouse', 'name').populate('performedBy', 'name')
                .sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
            InventoryStockTransaction.countDocuments(q),
        ]);
        ok(res, { txns, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
    } catch (e) { err(res, e); }
};

// Manual stock adjustment / in / out / damage / scrap.
exports.adjustStock = async (req, res) => {
    try {
        const { item, warehouse, type, quantity, unitCost, note, batchNumber, serialNumbers, expiryDate } = req.body;
        if (!item || !warehouse) return bad(res, 'Item and warehouse are required');
        const qty = Number(quantity);
        if (!qty || qty <= 0) return bad(res, 'Quantity must be a positive number');

        // Inbound types add; outbound types subtract.
        const inbound = ['purchase', 'return', 'transfer_in', 'adjustment'];
        const outbound = ['issue', 'damage', 'scrap', 'transfer_out'];
        let signed;
        if (type === 'adjustment') {
            // adjustment is a signed set: accept sign from client via `direction`
            signed = req.body.direction === 'out' ? -Math.abs(qty) : Math.abs(qty);
        } else if (inbound.includes(type)) signed = Math.abs(qty);
        else if (outbound.includes(type)) signed = -Math.abs(qty);
        else return bad(res, 'Invalid transaction type');

        if (signed < 0) {
            const stock = await InventoryStock.findOne({ school: req.schoolId, item, warehouse });
            const available = stock ? Math.max(0, stock.quantity - stock.reserved) : 0;
            if (available < Math.abs(signed)) return bad(res, `Insufficient available stock (${available})`);
        }

        const stock = await applyStockMovement(req, {
            item, warehouse, type, quantity: signed, unitCost: Number(unitCost) || 0,
            note, refType: 'manual', batchNumber, serialNumbers, expiryDate: expiryDate || null,
        });
        await logAudit(req, 'STOCK_ADJUSTED', 'InventoryStock', stock._id,
            `Stock ${type} of ${Math.abs(signed)} for item`, { item, warehouse, type, quantity: signed });
        ok(res, stock);
    } catch (e) { err(res, e); }
};

// Transfer stock between two warehouses (two ledger entries).
exports.transferStock = async (req, res) => {
    try {
        const { item, fromWarehouse, toWarehouse, quantity, note } = req.body;
        if (!item || !fromWarehouse || !toWarehouse) return bad(res, 'Item and both warehouses are required');
        if (fromWarehouse === toWarehouse) return bad(res, 'Source and destination must differ');
        const qty = Math.abs(Number(quantity));
        if (!qty) return bad(res, 'Quantity must be positive');

        const src = await InventoryStock.findOne({ school: req.schoolId, item, warehouse: fromWarehouse });
        const available = src ? Math.max(0, src.quantity - src.reserved) : 0;
        if (available < qty) return bad(res, `Insufficient stock at source (${available})`);

        await applyStockMovement(req, { item, warehouse: fromWarehouse, type: 'transfer_out', quantity: -qty, note, refType: 'transfer' });
        await applyStockMovement(req, { item, warehouse: toWarehouse, type: 'transfer_in', quantity: qty, unitCost: src?.avgCost || 0, note, refType: 'transfer' });
        await logAudit(req, 'STOCK_TRANSFERRED', 'InventoryItem', item, `Transferred ${qty} units between warehouses`);
        ok(res, { transferred: qty });
    } catch (e) { err(res, e); }
};

// ── Purchase Requests (spec §5) — admin side ──────────────────────────────────

exports.getPurchaseRequests = async (req, res) => {
    try {
        const { status } = req.query;
        const q = { school: req.schoolId };
        if (status) q.status = status;
        const prs = await PurchaseRequest.find(q)
            .populate('requestedBy', 'name').populate('department', 'name annualBudget usedBudget')
            .sort({ createdAt: -1 }).lean();
        ok(res, prs);
    } catch (e) { err(res, e); }
};

exports.getPurchaseRequest = async (req, res) => {
    try {
        const pr = await PurchaseRequest.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('requestedBy', 'name email').populate('department', 'name annualBudget usedBudget')
            .populate('items.item', 'name itemCode').populate('approvals.actor', 'name')
            .populate('purchaseOrder', 'poNumber status').lean();
        if (!pr) return bad(res, 'Request not found', 404);
        ok(res, pr);
    } catch (e) { err(res, e); }
};

// Approver acts on a request. Records a signed step and, on final approval,
// marks the request approved so a PO can be created.
exports.actOnRequest = async (req, res) => {
    try {
        const { action, stage, comment, signature } = req.body;
        const valid = ['approved', 'rejected', 'changes_requested', 'forwarded', 'hold'];
        if (!valid.includes(action)) return bad(res, 'Invalid action');

        const pr = await PurchaseRequest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!pr) return bad(res, 'Request not found', 404);
        if (['approved', 'rejected', 'converted', 'cancelled', 'fulfilled_from_stock'].includes(pr.status))
            return bad(res, `Request is already ${pr.status}`);

        pr.approvals.push({
            stage: stage || req.userRole, action, actor: req.userId,
            comment: comment || '', signature: signature || '', actedAt: new Date(),
        });
        if (action === 'approved') pr.status = 'approved';
        else if (action === 'rejected') pr.status = 'rejected';
        // forwarded / hold / changes_requested keep it pending

        await pr.save();
        await logAudit(req, `PR_${action.toUpperCase()}`, 'PurchaseRequest', pr._id,
            `Request ${pr.requestNumber} ${action}`);
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: `📦 Purchase request ${action.replace('_', ' ')}`,
            body: `Your purchase request ${pr.requestNumber} has been ${action.replace('_', ' ')}.${comment ? `\nComment: ${comment}` : ''}`,
            recipients: [pr.requestedBy],
        });
        ok(res, pr);
    } catch (e) { err(res, e); }
};

// Fulfil an approved/pending request directly from existing stock (spec §5 hint).
exports.fulfilFromStock = async (req, res) => {
    try {
        const pr = await PurchaseRequest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!pr) return bad(res, 'Request not found', 404);
        pr.status = 'fulfilled_from_stock';
        pr.approvals.push({ stage: req.userRole, action: 'approved', actor: req.userId, comment: 'Fulfilled from existing stock', actedAt: new Date() });
        await pr.save();
        await logAudit(req, 'PR_FULFILLED_FROM_STOCK', 'PurchaseRequest', pr._id, `Request ${pr.requestNumber} fulfilled from stock`);
        ok(res, pr);
    } catch (e) { err(res, e); }
};

// ── Purchase Orders (spec §9) ─────────────────────────────────────────────────

function computePoTotals(items = [], discount = 0) {
    let subTotal = 0, taxTotal = 0;
    for (const it of items) {
        const line = (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0);
        subTotal += line;
        taxTotal += line * ((Number(it.gst) || 0) / 100);
    }
    const grandTotal = Math.max(0, subTotal + taxTotal - (Number(discount) || 0));
    return { subTotal: Math.round(subTotal * 100) / 100, taxTotal: Math.round(taxTotal * 100) / 100, grandTotal: Math.round(grandTotal * 100) / 100 };
}

exports.getPurchaseOrders = async (req, res) => {
    try {
        const { status } = req.query;
        const q = { school: req.schoolId };
        if (status) q.status = status;
        const pos = await PurchaseOrder.find(q)
            .populate('vendor', 'name').populate('department', 'name').populate('warehouse', 'name')
            .sort({ createdAt: -1 }).lean();
        ok(res, pos);
    } catch (e) { err(res, e); }
};

exports.getPurchaseOrder = async (req, res) => {
    try {
        const po = await PurchaseOrder.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('vendor').populate('department', 'name').populate('warehouse', 'name campus')
            .populate('items.item', 'name itemCode unit').populate('purchaseRequest', 'requestNumber').lean();
        if (!po) return bad(res, 'Purchase order not found', 404);
        ok(res, po);
    } catch (e) { err(res, e); }
};

exports.createPurchaseOrder = async (req, res) => {
    try {
        const { vendor, items, department, warehouse, discount, deliveryAddress, terms, expectedDelivery, signature, purchaseRequest } = req.body;
        if (!vendor) return bad(res, 'Vendor is required');
        if (!items || !items.length) return bad(res, 'At least one item is required');

        const totals = computePoTotals(items, discount);

        // Budget check (spec §6) — block if department budget is insufficient.
        if (department) {
            const dept = await InventoryDepartment.findOne({ _id: department, school: req.schoolId });
            if (dept && dept.annualBudget > 0) {
                const remaining = dept.annualBudget - dept.usedBudget;
                if (totals.grandTotal > remaining)
                    return bad(res, `Purchase blocked — cost ₹${totals.grandTotal} exceeds remaining budget ₹${remaining}`);
            }
        }

        const poNumber = await nextNumber(PurchaseOrder, req.schoolId, 'PO');
        const po = await PurchaseOrder.create({
            school: req.schoolId, poNumber, vendor,
            department: department || null, warehouse: warehouse || null,
            purchaseRequest: purchaseRequest || null,
            items, discount: Number(discount) || 0, ...totals,
            deliveryAddress: deliveryAddress || '', terms: terms || '',
            expectedDelivery: expectedDelivery || null, signature: signature || '',
            createdBy: req.userId,
        });

        // Consume department budget on order.
        if (department) {
            await InventoryDepartment.updateOne(
                { _id: department, school: req.schoolId },
                { $inc: { usedBudget: totals.grandTotal } });
        }
        // Link back to the originating request.
        if (purchaseRequest) {
            await PurchaseRequest.updateOne(
                { _id: purchaseRequest, school: req.schoolId },
                { status: 'converted', purchaseOrder: po._id });
        }
        // Bump vendor order count.
        await InventoryVendor.updateOne({ _id: vendor, school: req.schoolId }, { $inc: { 'performance.totalOrders': 1 } });

        await logAudit(req, 'PO_CREATED', 'PurchaseOrder', po._id, `PO ${poNumber} created (₹${totals.grandTotal})`);
        ok(res, po);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'Duplicate PO number, please retry');
        err(res, e);
    }
};

// Goods Received Note (spec §11): receive quantities → increase stock.
exports.receivePurchaseOrder = async (req, res) => {
    try {
        const { lines, invoice } = req.body; // lines: [{ itemId(POItem._id), receivedQty, batchNumber, serialNumbers, expiryDate }]
        const po = await PurchaseOrder.findOne({ _id: req.params.id, school: req.schoolId });
        if (!po) return bad(res, 'Purchase order not found', 404);
        if (po.status === 'received') return bad(res, 'Purchase order already fully received');
        if (!po.warehouse) return bad(res, 'Set a receiving warehouse on the PO first');
        if (!lines || !lines.length) return bad(res, 'No receipt lines provided');

        for (const line of lines) {
            const poItem = po.items.id(line.itemId);
            if (!poItem) continue;
            const recv = Math.max(0, Number(line.receivedQty) || 0);
            if (!recv) continue;
            const remaining = poItem.quantity - poItem.receivedQty;
            const applied = Math.min(recv, remaining);
            if (applied <= 0) continue;
            poItem.receivedQty += applied;

            // Only items that exist in the master affect stock.
            if (poItem.item) {
                await applyStockMovement(req, {
                    item: poItem.item, warehouse: po.warehouse, type: 'purchase',
                    quantity: applied, unitCost: poItem.unitPrice || 0,
                    refType: 'PurchaseOrder', refId: po._id,
                    batchNumber: line.batchNumber || '', serialNumbers: line.serialNumbers || [],
                    expiryDate: line.expiryDate || null,
                    note: `GRN for ${po.poNumber}`,
                });
            }
        }

        const fullyReceived = po.items.every(i => i.receivedQty >= i.quantity);
        po.status = fullyReceived ? 'received' : 'partially_received';
        if (fullyReceived) po.receivedAt = new Date();
        if (invoice) po.invoice = { ...po.invoice, ...invoice };
        await po.save();

        // Vendor performance: mark on-time / delayed when fully received.
        if (fullyReceived) {
            const onTime = !po.expectedDelivery || po.receivedAt <= new Date(po.expectedDelivery);
            const days = Math.max(0, Math.round((po.receivedAt - po.createdAt) / 86400000));
            const v = await InventoryVendor.findOne({ _id: po.vendor, school: req.schoolId });
            if (v) {
                if (onTime) v.performance.onTimeDeliveries += 1; else v.performance.delayedDeliveries += 1;
                const totalDeliv = v.performance.onTimeDeliveries + v.performance.delayedDeliveries;
                v.performance.avgDeliveryDays = Math.round(((v.performance.avgDeliveryDays * (totalDeliv - 1)) + days) / totalDeliv);
                v.performance.rating = totalDeliv ? Math.round((v.performance.onTimeDeliveries / totalDeliv) * 5 * 10) / 10 : 0;
                await v.save();
            }
        }

        await logAudit(req, 'PO_RECEIVED', 'PurchaseOrder', po._id, `Goods received for ${po.poNumber} (${po.status})`);
        ok(res, po);
    } catch (e) { err(res, e); }
};

exports.cancelPurchaseOrder = async (req, res) => {
    try {
        const po = await PurchaseOrder.findOne({ _id: req.params.id, school: req.schoolId });
        if (!po) return bad(res, 'Purchase order not found', 404);
        if (po.status === 'received') return bad(res, 'Cannot cancel a fully received PO');
        po.status = 'cancelled';
        await po.save();
        // Release reserved budget.
        if (po.department) {
            await InventoryDepartment.updateOne({ _id: po.department, school: req.schoolId }, { $inc: { usedBudget: -po.grandTotal } });
        }
        await logAudit(req, 'PO_CANCELLED', 'PurchaseOrder', po._id, `PO ${po.poNumber} cancelled`);
        ok(res, po);
    } catch (e) { err(res, e); }
};

// ── Issue / Return (spec §14 & §15) ───────────────────────────────────────────

exports.getIssues = async (req, res) => {
    try {
        const { status } = req.query;
        const q = { school: req.schoolId };
        if (status) q.status = status;
        const issues = await InventoryIssue.find(q)
            .populate('item', 'name itemCode unit').populate('warehouse', 'name')
            .populate('issuedToUser', 'name').populate('department', 'name')
            .sort({ createdAt: -1 }).lean();
        ok(res, issues);
    } catch (e) { err(res, e); }
};

exports.createIssue = async (req, res) => {
    try {
        const { item, warehouse, quantity, issuedToUser, issuedToName, department, expectedReturn, conditionOut, signature, note } = req.body;
        if (!item || !warehouse) return bad(res, 'Item and warehouse are required');
        const qty = Math.abs(Number(quantity));
        if (!qty) return bad(res, 'Quantity must be positive');

        const stock = await InventoryStock.findOne({ school: req.schoolId, item, warehouse });
        const available = stock ? Math.max(0, stock.quantity - stock.reserved) : 0;
        if (available < qty) return bad(res, `Insufficient available stock (${available})`);

        const issueNumber = await nextNumber(InventoryIssue, req.schoolId, 'ISS');
        const issue = await InventoryIssue.create({
            school: req.schoolId, issueNumber, item, warehouse, quantity: qty,
            issuedToUser: issuedToUser || null, issuedToName: issuedToName || '',
            department: department || null, expectedReturn: expectedReturn || null,
            conditionOut: conditionOut || 'Good', signature: signature || '', note: note || '',
            issuedBy: req.userId,
        });

        await applyStockMovement(req, {
            item, warehouse, type: 'issue', quantity: -qty,
            refType: 'InventoryIssue', refId: issue._id,
            note: `Issued via ${issueNumber}`,
        });
        await logAudit(req, 'ITEM_ISSUED', 'InventoryIssue', issue._id, `Issued ${qty} units (${issueNumber})`);
        if (issuedToUser) {
            InventoryItem.findById(item).select('name').lean().then(it => notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '📦 Inventory item issued to you',
                body: `${qty} × ${it?.name || 'item'} issued to you (${issueNumber}).${expectedReturn ? ` Expected return: ${new Date(expectedReturn).toLocaleDateString('en-IN')}.` : ''}`,
                recipients: [issuedToUser],
            })).catch(() => {});
        }
        ok(res, issue);
    } catch (e) { err(res, e); }
};

exports.returnIssue = async (req, res) => {
    try {
        const { returnQty, condition, restock } = req.body;
        const issue = await InventoryIssue.findOne({ _id: req.params.id, school: req.schoolId });
        if (!issue) return bad(res, 'Issue not found', 404);
        if (issue.status === 'returned') return bad(res, 'Already fully returned');

        const outstanding = issue.quantity - issue.returnedQty;
        const rq = Math.min(Math.abs(Number(returnQty) || outstanding), outstanding);
        if (rq <= 0) return bad(res, 'Nothing to return');

        issue.returnedQty += rq;
        issue.returnedAt = new Date();
        issue.returnCondition = condition || 'good';
        issue.status = issue.returnedQty >= issue.quantity ? 'returned' : 'partially_returned';
        await issue.save();

        // Good / repair_needed items go back to stock; lost/damaged optionally not.
        const backToStock = restock !== false && ['good', 'repair_needed', ''].includes(condition || 'good');
        if (backToStock) {
            await applyStockMovement(req, {
                item: issue.item, warehouse: issue.warehouse, type: 'return', quantity: rq,
                refType: 'InventoryIssue', refId: issue._id, note: `Return for ${issue.issueNumber}`,
            });
        } else if (condition === 'damaged' || condition === 'lost') {
            // Record the loss against the warehouse for the audit trail (no stock add).
            await applyStockMovement(req, {
                item: issue.item, warehouse: issue.warehouse, type: 'return', quantity: rq,
                refType: 'InventoryIssue', refId: issue._id, note: `Returned ${condition}`,
            });
            await applyStockMovement(req, {
                item: issue.item, warehouse: issue.warehouse, type: condition === 'lost' ? 'scrap' : 'damage', quantity: -rq,
                refType: 'InventoryIssue', refId: issue._id, note: `Written off (${condition})`,
            });
        }
        await logAudit(req, 'ITEM_RETURNED', 'InventoryIssue', issue._id, `Returned ${rq} units (${issue.issueNumber}, ${condition || 'good'})`);
        ok(res, issue);
    } catch (e) { err(res, e); }
};

// ── Assets & Repairs (spec §16 & §17) ─────────────────────────────────────────

exports.getAssets = async (req, res) => {
    try {
        const { status, search } = req.query;
        const q = { school: req.schoolId };
        if (status) q.status = status;
        if (search) q.$or = [{ name: new RegExp(search, 'i') }, { assetCode: new RegExp(search, 'i') }, { serialNumber: new RegExp(search, 'i') }];
        const assets = await InventoryAsset.find(q)
            .populate('assignedTo', 'name').populate('warehouse', 'name').populate('item', 'name itemCode')
            .sort({ createdAt: -1 }).lean();
        ok(res, assets);
    } catch (e) { err(res, e); }
};

exports.getAsset = async (req, res) => {
    try {
        const asset = await InventoryAsset.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('assignedTo', 'name email').populate('warehouse', 'name campus')
            .populate('item', 'name itemCode').populate('repairs.reportedBy', 'name').lean();
        if (!asset) return bad(res, 'Asset not found', 404);
        ok(res, asset);
    } catch (e) { err(res, e); }
};

exports.createAsset = async (req, res) => {
    try {
        const body = { ...req.body, school: req.schoolId, createdBy: req.userId };
        if (!body.name) return bad(res, 'Asset name is required');
        if (!body.assetCode) body.assetCode = await nextNumber(InventoryAsset, req.schoolId, 'AST');
        ['item', 'warehouse', 'assignedTo'].forEach(k => { if (!body[k]) body[k] = null; });
        if (body.assignedTo) body.status = 'assigned';
        const asset = await InventoryAsset.create(body);
        await logAudit(req, 'ASSET_CREATED', 'InventoryAsset', asset._id, `Asset "${asset.name}" (${asset.assetCode}) created`);
        ok(res, asset);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'An asset with this code already exists');
        err(res, e);
    }
};

exports.updateAsset = async (req, res) => {
    try {
        const body = { ...req.body };
        delete body.school; delete body.createdBy; delete body.repairs;
        ['item', 'warehouse', 'assignedTo'].forEach(k => { if (k in body && !body[k]) body[k] = null; });
        const asset = await InventoryAsset.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, body, { new: true });
        if (!asset) return bad(res, 'Asset not found', 404);
        await logAudit(req, 'ASSET_UPDATED', 'InventoryAsset', asset._id, `Asset "${asset.name}" updated`);
        ok(res, asset);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'An asset with this code already exists');
        err(res, e);
    }
};

exports.deleteAsset = async (req, res) => {
    try {
        const asset = await InventoryAsset.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!asset) return bad(res, 'Asset not found', 404);
        await logAudit(req, 'ASSET_DELETED', 'InventoryAsset', asset._id, `Asset "${asset.name}" deleted`);
        ok(res, { deleted: true });
    } catch (e) { err(res, e); }
};

// Log a repair complaint / progress on an asset.
exports.addRepair = async (req, res) => {
    try {
        const { complaint, technician, note } = req.body;
        if (!complaint) return bad(res, 'Complaint is required');
        const asset = await InventoryAsset.findOne({ _id: req.params.id, school: req.schoolId });
        if (!asset) return bad(res, 'Asset not found', 404);
        asset.repairs.push({ complaint, technician: technician || '', note: note || '', reportedBy: req.userId, status: technician ? 'assigned' : 'reported' });
        asset.status = 'under_repair';
        await asset.save();
        await logAudit(req, 'REPAIR_LOGGED', 'InventoryAsset', asset._id, `Repair logged for "${asset.name}"`);
        ok(res, asset);
    } catch (e) { err(res, e); }
};

exports.updateRepair = async (req, res) => {
    try {
        const { status, technician, cost, note } = req.body;
        const asset = await InventoryAsset.findOne({ _id: req.params.id, school: req.schoolId });
        if (!asset) return bad(res, 'Asset not found', 404);
        const repair = asset.repairs.id(req.params.repairId);
        if (!repair) return bad(res, 'Repair record not found', 404);
        if (status) repair.status = status;
        if (technician !== undefined) repair.technician = technician;
        if (cost !== undefined) repair.cost = Number(cost) || 0;
        if (note !== undefined) repair.note = note;
        if (status === 'completed' || status === 'returned') {
            repair.completedAt = new Date();
            // If no other open repairs, return the asset to service.
            const stillOpen = asset.repairs.some(r => !['completed', 'returned'].includes(r.status));
            if (!stillOpen) asset.status = asset.assignedTo ? 'assigned' : 'in_store';
        }
        await asset.save();
        await logAudit(req, 'REPAIR_UPDATED', 'InventoryAsset', asset._id, `Repair updated for "${asset.name}" → ${status || repair.status}`);
        ok(res, asset);
    } catch (e) { err(res, e); }
};

// ── Audit / Activity Log (spec §24) ───────────────────────────────────────────

exports.getAuditLog = async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const [logs, total] = await Promise.all([
            InventoryAuditLog.find({ school: req.schoolId })
                .populate('user', 'name').sort({ timestamp: -1 }).skip(skip).limit(Number(limit)).lean(),
            InventoryAuditLog.countDocuments({ school: req.schoolId }),
        ]);
        ok(res, { logs, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
    } catch (e) { err(res, e); }
};
