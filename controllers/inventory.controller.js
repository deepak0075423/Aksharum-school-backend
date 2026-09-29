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
const InventoryBudget          = require('../models/InventoryBudget');
const { notify }               = require('../services/notifyService');
const stockService             = require('../services/inventoryStock');
const budgets                  = require('../services/inventoryBudget');
const { nextNumber: nextDocNumber } = require('../services/inventoryNumber');

// ── Helpers ─────────────────────────────────────────────────────────────────

const ok  = (res, data)          => res.json({ success: true, data });
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const err = (res, e)             => res.status(500).json({ success: false, message: e.message });
const num = (v)                  => (Number.isFinite(+v) ? +v : 0);

// Deletions, cancellations, rejections and write-offs are the lines an auditor
// looks for first, so they are flagged as they are written rather than being
// pattern-matched out of the action name later.
const CRITICAL_ACTION = /DELETE|CANCEL|REJECT|SCRAP|WRITE_OFF|DISPOS|LOST|BUDGET/i;

// The machine the action came from. Behind a proxy the socket address is the
// proxy's, so the forwarded header wins when the platform sets one.
function clientIp(req) {
    const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    const raw = fwd || req.ip || req.socket?.remoteAddress || '';
    return raw.replace(/^::ffff:/, '');
}

async function logAudit(req, actionType, entityType, entityId, description, meta, referenceCode = '') {
    try {
        await InventoryAuditLog.create({
            school: req.schoolId, user: req.userId, role: req.userRole,
            actionType, entityType, entityId, description, meta,
            referenceCode: referenceCode || (meta && (meta.code || meta.reference)) || '',
            ip: clientIp(req),
            critical: CRITICAL_ACTION.test(actionType),
        });
    } catch { /* non-critical */ }
}

/**
 * Apply a signed stock delta and record an immutable ledger entry.
 *
 * The arithmetic, the floor and the ledger row all happen inside one database
 * transaction now — see services/inventoryStock.js for why. Pass `q` to join a
 * transaction already in progress.
 */
const applyStockMovement = (req, movement, q) => stockService.move(req, movement, q);

/** A movement that would go below zero is the user's problem, not a 500. */
const stockErr = (res, e) => (
    e?.code === 'INSUFFICIENT_STOCK' ? bad(res, e.message) : err(res, e)
);

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
            departmentBudgets: await budgets.byDepartment(school),
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
            InventoryDepartment.find({ school, isActive: true }).select('name').sort({ name: 1 }).lean(),
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
        const { name, parent, description, icon, color, defaultUnit, defaultGst, defaultHsnCode, defaultWarehouse } = req.body;
        if (!name) return bad(res, 'Name is required');
        const cat = await InventoryCategory.create({
            school: req.schoolId, name, parent: parent || null, description,
            icon: icon || 'box', color: color || '',
            defaultUnit: defaultUnit || '', defaultGst: Number(defaultGst) || 0,
            defaultHsnCode: defaultHsnCode || '', defaultWarehouse: defaultWarehouse || null,
            createdBy: req.userId,
        });
        await logAudit(req, 'CATEGORY_CREATED', 'InventoryCategory', cat._id, `Added new category ${name}`, null, name);
        ok(res, cat);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A category with this name already exists');
        err(res, e);
    }
};

exports.updateCategory = async (req, res) => {
    try {
        const { name, parent, description, isActive, icon, color, defaultUnit, defaultGst, defaultHsnCode, defaultWarehouse } = req.body;
        // A category cannot be its own parent, and a parent cannot be one of its
        // own descendants — either makes the roll-up on the Categories screen
        // recurse forever.
        if (parent && String(parent) === String(req.params.id)) return bad(res, 'A category cannot be its own parent');
        if (parent) {
            let walk = parent, guard = 0;
            while (walk && guard++ < 20) {
                if (String(walk) === String(req.params.id)) return bad(res, 'That would make the category a parent of itself');
                const up = await InventoryCategory.findOne({ _id: walk, school: req.schoolId }).select('parent').lean();
                walk = up?.parent || null;
            }
        }
        const cat = await InventoryCategory.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            {
                name, parent: parent || null, description,
                ...(isActive !== undefined && { isActive }),
                ...(icon !== undefined && { icon }),
                ...(color !== undefined && { color }),
                ...(defaultUnit !== undefined && { defaultUnit }),
                ...(defaultGst !== undefined && { defaultGst: Number(defaultGst) || 0 }),
                ...(defaultHsnCode !== undefined && { defaultHsnCode }),
                ...(defaultWarehouse !== undefined && { defaultWarehouse: defaultWarehouse || null }),
            },
            { new: true });
        if (!cat) return bad(res, 'Category not found', 404);
        await logAudit(req, 'CATEGORY_UPDATED', 'InventoryCategory', cat._id, `Updated category ${cat.name}`, null, cat.name);
        ok(res, cat);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A category with this name already exists');
        err(res, e);
    }
};

exports.deleteCategory = async (req, res) => {
    try {
        // Items, sub-categories, assets and budgets all point at a category.
        // Only the first was checked, so deleting one could orphan the rest.
        const [inUse, kids, assets, budgeted] = await Promise.all([
            InventoryItem.countDocuments({ school: req.schoolId, category: req.params.id }),
            InventoryCategory.countDocuments({ school: req.schoolId, parent: req.params.id }),
            InventoryAsset.countDocuments({ school: req.schoolId, category: req.params.id }),
            InventoryBudget.countDocuments({ school: req.schoolId, category: req.params.id }),
        ]);
        if (inUse) return bad(res, `Cannot delete — ${inUse} item(s) use this category`);
        if (kids) return bad(res, `Cannot delete — it has ${kids} sub-categor${kids === 1 ? 'y' : 'ies'}. Move or delete those first.`);
        if (assets) return bad(res, `Cannot delete — ${assets} asset(s) use this category`);
        if (budgeted) return bad(res, `Cannot delete — ${budgeted} budget(s) are scoped to this category`);
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
        await logAudit(req, 'VENDOR_CREATED', 'InventoryVendor', vendor._id, `Added new vendor ${vendor.name}`, null, vendor.name);
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
        await logAudit(req, 'VENDOR_UPDATED', 'InventoryVendor', vendor._id, `Updated vendor ${vendor.name}`, null, vendor.name);
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
        // Every store is listed by a short code. One is generated when nobody
        // types one, so the column is never blank.
        let code = String(req.body.code || '').trim();
        if (!code) {
            const n = await InventoryWarehouse.countDocuments({ school: req.schoolId });
            code = `WH-${String(n + 1).padStart(3, '0')}`;
        }
        const wh = await InventoryWarehouse.create({
            ...req.body, code, manager: req.body.manager || null, school: req.schoolId, createdBy: req.userId,
        });
        await logAudit(req, 'WAREHOUSE_CREATED', 'InventoryWarehouse', wh._id, `Added new warehouse ${wh.name}`, null, wh.code);
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
        await logAudit(req, 'WAREHOUSE_UPDATED', 'InventoryWarehouse', wh._id, `Updated warehouse ${wh.name}`, null, wh.code);
        ok(res, wh);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'A warehouse with this name already exists on this campus');
        err(res, e);
    }
};

exports.deleteWarehouse = async (req, res) => {
    try {
        const [hasStock, homeTo, expecting] = await Promise.all([
            InventoryStock.countDocuments({ school: req.schoolId, warehouse: req.params.id, quantity: { $gt: 0 } }),
            InventoryItem.countDocuments({ school: req.schoolId, warehouse: req.params.id }),
            PurchaseOrder.countDocuments({
                school: req.schoolId, warehouse: req.params.id,
                status: { $in: ['draft', 'pending_approval', 'approved', 'ordered', 'in_transit', 'partially_received'] },
            }),
        ]);
        if (hasStock) return bad(res, 'Cannot delete — warehouse still holds stock');
        if (homeTo) return bad(res, `Cannot delete — ${homeTo} item(s) use it as their default store`);
        if (expecting) return bad(res, `Cannot delete — ${expecting} open purchase order(s) are due to be received here`);
        // An empty stock row is still a row pointing at this store.
        await InventoryStock.deleteMany({ school: req.schoolId, warehouse: req.params.id });
        const wh = await InventoryWarehouse.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!wh) return bad(res, 'Warehouse not found', 404);
        await logAudit(req, 'WAREHOUSE_DELETED', 'InventoryWarehouse', wh._id, `Warehouse "${wh.name}" deleted`);
        ok(res, { deleted: true });
    } catch (e) { err(res, e); }
};

// ── Departments & Budget (spec §6) ────────────────────────────────────────────

exports.getDepartments = async (req, res) => {
    try {
        // Allocations live on InventoryBudget now, so they are summed rather
        // than read off the department.
        const [depts, rolled] = await Promise.all([
            InventoryDepartment.find({ school: req.schoolId }).sort({ name: 1 }).lean(),
            budgets.byDepartment(req.schoolId),
        ]);
        const byId = new Map(rolled.map(r => [String(r._id), r]));
        ok(res, depts.map(d => ({ ...d, ...(byId.get(String(d._id)) || {}) })));
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
        // Allocations are not a department field any more.
        const { usedBudget, annualBudget, ...rest } = req.body;
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
        // This had no guard at all: deleting a department orphaned every
        // request, order and budget that pointed at it.
        const [reqs, orders, budgeted] = await Promise.all([
            PurchaseRequest.countDocuments({ school: req.schoolId, department: req.params.id }),
            PurchaseOrder.countDocuments({ school: req.schoolId, department: req.params.id }),
            InventoryBudget.countDocuments({ school: req.schoolId, department: req.params.id }),
        ]);
        if (reqs) return bad(res, `Cannot delete — ${reqs} request(s) belong to this department. Deactivate it instead.`);
        if (orders) return bad(res, `Cannot delete — ${orders} purchase order(s) belong to this department. Deactivate it instead.`);
        if (budgeted) return bad(res, `Cannot delete — ${budgeted} budget(s) are scoped to this department`);
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
        if (!body.itemCode) body.itemCode = await nextDocNumber(req.schoolId, 'item');
        ['category', 'warehouse'].forEach(k => { if (!body[k]) body[k] = null; });
        const item = await InventoryItem.create(body);
        await logAudit(req, 'ITEM_CREATED', 'InventoryItem', item._id, `Added new item ${item.name}`, null, item.itemCode);
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
        await logAudit(req, 'ITEM_UPDATED', 'InventoryItem', item._id, `Updated item ${item.name}`, null, item.itemCode);
        ok(res, item);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'An item with this code already exists');
        err(res, e);
    }
};

exports.deleteItem = async (req, res) => {
    try {
        const [hasStock, onOrder, out, asAsset] = await Promise.all([
            InventoryStock.countDocuments({ school: req.schoolId, item: req.params.id, quantity: { $gt: 0 } }),
            PurchaseOrder.countDocuments({
                school: req.schoolId, 'items.item': req.params.id,
                status: { $in: ['draft', 'pending_approval', 'approved', 'ordered', 'in_transit', 'partially_received'] },
            }),
            InventoryIssue.countDocuments({ school: req.schoolId, item: req.params.id, status: { $ne: 'returned' } }),
            InventoryAsset.countDocuments({ school: req.schoolId, item: req.params.id }),
        ]);
        if (hasStock) return bad(res, 'Cannot delete — item still has stock. Adjust stock to zero first.');
        if (onOrder) return bad(res, `Cannot delete — it is on ${onOrder} open purchase order(s)`);
        if (out) return bad(res, `Cannot delete — ${out} issue(s) of it are still outstanding`);
        if (asAsset) return bad(res, `Cannot delete — ${asAsset} asset(s) are tracked against it`);
        const item = await InventoryItem.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!item) return bad(res, 'Item not found', 404);
        await logAudit(req, 'ITEM_DELETED', 'InventoryItem', item._id, `Deleted item ${item.name}`, null, item.itemCode);
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

        // Which way each kind of movement goes. `adjustment` and `audit` are
        // corrections, so they take their sign from the caller — a physical
        // count can come out either side of what the system held.
        const inbound = ['purchase', 'return', 'transfer_in'];
        const outbound = ['issue', 'damage', 'scrap', 'transfer_out'];
        const signedByCaller = ['adjustment', 'audit'];
        let signed;
        if (signedByCaller.includes(type)) signed = req.body.direction === 'out' ? -Math.abs(qty) : Math.abs(qty);
        else if (inbound.includes(type)) signed = Math.abs(qty);
        else if (outbound.includes(type)) signed = -Math.abs(qty);
        else return bad(res, 'Invalid transaction type');

        // No pre-check: the movement itself refuses to go below zero, inside
        // the transaction, which a read-then-write check never could.
        const stock = await applyStockMovement(req, {
            item, warehouse, type, quantity: signed, unitCost: Number(unitCost) || 0,
            note, refType: 'manual', batchNumber, serialNumbers, expiryDate: expiryDate || null,
        });
        await logAudit(req, 'STOCK_ADJUSTED', 'InventoryStock', stock._id,
            `Stock ${type} of ${Math.abs(signed)} for item`, { item, warehouse, type, quantity: signed });
        ok(res, stock);
    } catch (e) { stockErr(res, e); }
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

        // Both legs in ONE transaction. Separately, a failure on the way in
        // left the units destroyed: out of the source and into nowhere.
        await stockService.moveAll(req, [
            { item, warehouse: fromWarehouse, type: 'transfer_out', quantity: -qty, note, refType: 'transfer' },
            { item, warehouse: toWarehouse, type: 'transfer_in', quantity: qty, unitCost: src?.avgCost || 0, note, refType: 'transfer' },
        ]);
        await logAudit(req, 'STOCK_TRANSFERRED', 'InventoryItem', item, `Transferred ${qty} units between warehouses`);
        ok(res, { transferred: qty });
    } catch (e) { stockErr(res, e); }
};

// ── Purchase Requests (spec §5) — admin side ──────────────────────────────────

exports.getPurchaseRequests = async (req, res) => {
    try {
        const { status } = req.query;
        const q = { school: req.schoolId };
        if (status) q.status = status;
        const prs = await PurchaseRequest.find(q)
            .populate('requestedBy', 'name').populate('department', 'name')
            .sort({ createdAt: -1 }).lean();
        ok(res, prs);
    } catch (e) { err(res, e); }
};

exports.getPurchaseRequest = async (req, res) => {
    try {
        const pr = await PurchaseRequest.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('requestedBy', 'name email').populate('department', 'name')
            .populate('items.item', 'name itemCode').populate('approvals.actor', 'name')
            .populate('purchaseOrder', 'poNumber status').lean();
        if (!pr) return bad(res, 'Request not found', 404);
        ok(res, pr);
    } catch (e) { err(res, e); }
};

/**
 * Where each line of a request would come from, for the lines that name a
 * master item. Free-text lines ("3 whiteboards, any brand") have nothing to
 * hold — they exist precisely because the item is not in the catalogue yet.
 */
async function plannedHolds(req, pr) {
    const lines = (pr.items || []).filter(l => l.item && Number(l.quantity) > 0);
    if (!lines.length) return [];
    const items = await InventoryItem.find({ school: req.schoolId, _id: { $in: lines.map(l => l.item) } })
        .select('warehouse').lean();
    const byId = new Map(items.map(i => [String(i._id), i]));
    const holds = [];
    for (const l of lines) {
        const warehouse = byId.get(String(l.item))?.warehouse;
        if (!warehouse) continue;              // no default store — nothing to hold against
        holds.push({ item: String(l.item), warehouse: String(warehouse), quantity: Number(l.quantity) });
    }
    return holds;
}

/** Give back whatever this request is holding, and forget it. */
async function releaseHolds(req, pr) {
    if (!(pr.reservations || []).length) return;
    await stockService.releaseAll(req, pr.reservations);
    pr.reservations = [];
    if (typeof pr.save === 'function') await pr.save().catch(() => {});
}

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

        // ── Holding the stock an approval promises ───────────────────────
        // Approving a request that can be met from the shelf is a promise. Up
        // to now nothing backed it: the goods stayed fully available and the
        // next request could take them, so the first approval quietly lost.
        // The lines that name a master item are now held at the store they
        // would come from until the request leaves the approved state.
        if (action === 'approved') {
            const holds = await plannedHolds(req, pr);
            if (holds.length) {
                try {
                    await stockService.reserveAll(req, holds);
                    pr.reservations = holds;
                } catch (e) {
                    // Not enough free stock to promise. Say so instead of
                    // approving something that cannot be honoured — the
                    // approver can still order it in through a purchase order.
                    if (e.code === 'INSUFFICIENT_STOCK') return stockErr(res, e);
                    throw e;
                }
            }
        } else if (action === 'rejected') {
            await releaseHolds(req, pr);
        }

        try {
            await pr.save();
        } catch (e) {
            // The hold is taken in the stock table and the record of it lives on
            // the request. If the request cannot be saved, nothing knows about
            // the hold any more, so it would sit there for ever making stock
            // unavailable to everybody. Give it back before giving up.
            if ((pr.reservations || []).length) await stockService.releaseAll(req, pr.reservations).catch(() => {});
            throw e;
        }
        await logAudit(req, `PR_${action.toUpperCase()}`, 'PurchaseRequest', pr._id,
            `${action.replace(/_/g, ' ')} request ${pr.requestNumber}`, { comment: comment || '' }, pr.requestNumber);
        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: `📦 Purchase request ${action.replace('_', ' ')}`,
            body: `Your purchase request ${pr.requestNumber} has been ${action.replace('_', ' ')}.${comment ? `\nComment: ${comment}` : ''}`,
            recipients: [pr.requestedBy],
            link: { type: 'inventory.requests', entityId: pr._id },
        });
        ok(res, pr);
    } catch (e) { err(res, e); }
};

// Fulfil an approved/pending request directly from existing stock (spec §5 hint).
/**
 * Meet an approved request out of what is already on the shelf.
 *
 * This used to flip the status and stop. No issue record, no ledger entry, no
 * decrement — the items were still in stock as far as the system knew and
 * nobody was on the hook for them. It now does what the button says: issues
 * every line to whoever raised the request, out of the store the caller names
 * (or each item's default store), and only then marks the request fulfilled.
 */
exports.fulfilFromStock = async (req, res) => {
    try {
        const pr = await PurchaseRequest.findOne({ _id: req.params.id, school: req.schoolId });
        if (!pr) return bad(res, 'Request not found', 404);
        if (['converted', 'fulfilled_from_stock', 'cancelled', 'rejected'].includes(pr.status)) {
            return bad(res, `That request is already ${pr.status.replace(/_/g, ' ')}`);
        }

        const lines = (pr.items || []).filter(l => l.item && Number(l.quantity) > 0);
        if (!lines.length) return bad(res, 'This request has no master items to issue from stock');

        // Where each line comes from: the store the caller picked, else the
        // item's own default, else refuse rather than guess.
        const chosen = req.body?.warehouse || null;
        const items = await InventoryItem.find({ school: req.schoolId, _id: { $in: lines.map(l => l.item) } })
            .select('name unit warehouse').lean();
        const byId = new Map(items.map(i => [String(i._id), i]));
        const plan = [];
        for (const l of lines) {
            const it = byId.get(String(l.item));
            if (!it) return bad(res, 'One of the requested items no longer exists', 404);
            const warehouse = chosen || it.warehouse;
            if (!warehouse) return bad(res, `${it.name} has no default store — pick one to issue from`);
            plan.push({ line: l, item: it, warehouse });
        }

        // Every line comes out together, or none does. The movement itself
        // refuses to go below zero, so a request that asks for more than is on
        // the shelf fails here rather than half-way through.
        // The request's own hold is released first: it is about to become a
        // real issue, and a movement is not allowed to eat reserved stock.
        await releaseHolds(req, pr);

        const issueNumber = await nextDocNumber(req.schoolId, 'issue');
        const issues = [];
        try {
            for (const p of plan) {
                const issue = await InventoryIssue.create({
                    school: req.schoolId,
                    issueNumber: plan.length > 1 ? `${issueNumber}-${issues.length + 1}` : issueNumber,
                    item: p.item._id, warehouse: p.warehouse, quantity: Number(p.line.quantity),
                    issuedToUser: pr.requestedBy, recipientType: 'staff',
                    department: pr.department || null,
                    returnable: false,
                    conditionOut: 'Good',
                    note: `Fulfilled from stock against ${pr.requestNumber}`,
                    issuedBy: req.userId,
                });
                issues.push(issue);
            }
            await stockService.moveAll(req, plan.map((p, i) => ({
                item: p.item._id, warehouse: p.warehouse, type: 'issue',
                quantity: -Number(p.line.quantity),
                refType: 'InventoryIssue', refId: issues[i]._id,
                note: `Fulfilled ${pr.requestNumber} from stock`,
            })));
        } catch (e) {
            await InventoryIssue.deleteMany({ _id: { $in: issues.map(i => i._id) }, school: req.schoolId }).catch(() => {});
            // Put the hold back: the request is still approved and still owed.
            if ((pr.reservations || []).length) await stockService.reserveAll(req, pr.reservations).catch(() => {});
            return stockErr(res, e);
        }

        pr.status = 'fulfilled_from_stock';
        pr.approvals.push({
            stage: req.userRole, action: 'approved', actor: req.userId,
            comment: `Fulfilled from stock (${issues.map(i => i.issueNumber).join(', ')})`,
            actedAt: new Date(),
        });
        await pr.save();
        await logAudit(req, 'PR_FULFILLED_FROM_STOCK', 'PurchaseRequest', pr._id,
            `Fulfilled request ${pr.requestNumber} from stock`,
            { issues: issues.map(i => i.issueNumber) }, pr.requestNumber);

        notify({
            school: req.schoolId, sender: req.userId, senderRole: req.userRole,
            title: '📦 Your request was met from stock',
            body: `${pr.requestNumber} has been issued to you from existing stock — nothing needed to be ordered.`,
            recipients: [pr.requestedBy],
            link: { type: 'inventory.requests', entityId: pr._id },
        });

        ok(res, { request: pr, issues, message: `Issued ${issues.length} line(s) from stock.` });
    } catch (e) { stockErr(res, e); }
};

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
        const { vendor, items, department, warehouse, discount, deliveryAddress, terms, expectedDelivery, signature, purchaseRequest, budget } = req.body;
        if (!vendor) return bad(res, 'Vendor is required');
        if (!items || !items.length) return bad(res, 'At least one item is required');

        const totals = computePoTotals(items, discount);

        // ── Budget check ──────────────────────────────────────────────────
        // Against InventoryBudget, which is what the Budgets screen shows.
        // It used to check InventoryDepartment.usedBudget, a second running
        // total that nothing on screen displayed and that drifted from the
        // orders it was supposed to be counting. That field is gone; spend is
        // summed from the orders themselves, every time.
        const check = await budgets.checkSpend(req.schoolId, {
            department, budget, items, total: totals.grandTotal,
        });
        if (check.blocked) return bad(res, check.message);

        const poNumber = await nextDocNumber(req.schoolId, 'order');
        const po = await PurchaseOrder.create({
            school: req.schoolId, poNumber, vendor,
            department: department || null, warehouse: warehouse || null,
            purchaseRequest: purchaseRequest || null,
            budget: budget || null,
            items, discount: Number(discount) || 0, ...totals,
            deliveryAddress: deliveryAddress || '', terms: terms || '',
            expectedDelivery: expectedDelivery || null, signature: signature || '',
            createdBy: req.userId,
        });

        // Link back to the originating request.
        if (purchaseRequest) {
            // Ordering it in means it is no longer coming off the shelf.
            const held = await PurchaseRequest.findOne({ _id: purchaseRequest, school: req.schoolId }).select('reservations');
            if (held) await releaseHolds(req, held);
            await PurchaseRequest.updateOne(
                { _id: purchaseRequest, school: req.schoolId },
                { status: 'converted', purchaseOrder: po._id });
        }
        // Bump vendor order count.
        await InventoryVendor.updateOne({ _id: vendor, school: req.schoolId }, { $inc: { 'performance.totalOrders': 1 } });

        await logAudit(req, 'PO_CREATED', 'PurchaseOrder', po._id,
            `Created purchase order ${poNumber}`, { total: totals.grandTotal, items: items.length }, poNumber);
        ok(res, po);
    } catch (e) {
        if (e.code === 11000) return bad(res, 'Duplicate PO number, please retry');
        err(res, e);
    }
};

/**
 * Change an order that has not been committed yet.
 *
 * There was no way to do this at all: a typo in a quantity, the wrong vendor or
 * a delivery date that moved meant cancelling the order and raising it again
 * under a new number, with the old one left sitting in the list as noise. The
 * screen offered no Edit because the server had nothing to call.
 *
 * Only `draft` and `pending_approval` can be edited. Past that the order has
 * been approved — someone put their name to those figures, a vendor may hold a
 * copy and goods may be on their way — so the honest route is to cancel and
 * raise a new one, which is what the Cancel action is for. The PO number never
 * changes: it is the identity of the document.
 */
exports.updatePurchaseOrder = async (req, res) => {
    try {
        const po = await PurchaseOrder.findOne({ _id: req.params.id, school: req.schoolId });
        if (!po) return bad(res, 'Purchase order not found', 404);
        if (!['draft', 'pending_approval'].includes(po.status)) {
            return bad(res, po.status === 'cancelled'
                ? 'That order was cancelled and cannot be edited'
                : `This order is already ${po.status.replace(/_/g, ' ')}. Cancel it and raise a new one instead.`);
        }

        const { vendor, items, department, warehouse, discount, deliveryAddress, terms, expectedDelivery, signature, budget } = req.body;
        if (vendor !== undefined && !vendor) return bad(res, 'Vendor is required');
        if (items !== undefined && (!Array.isArray(items) || !items.length)) return bad(res, 'At least one item is required');

        const nextItems = items !== undefined ? items : po.items;
        const nextDiscount = discount !== undefined ? Number(discount) || 0 : num(po.discount);
        const totals = computePoTotals(nextItems, nextDiscount);

        // Re-checked against the budget, because the point of an edit is often
        // that the figures changed. This order's own current total is not
        // counted against itself — it is being replaced, not added to.
        const check = await budgets.checkSpend(req.schoolId, {
            department: department !== undefined ? department : po.department,
            budget: budget !== undefined ? budget : po.budget,
            items: nextItems,
            total: totals.grandTotal - num(po.grandTotal),
        });
        if (check.blocked) return bad(res, check.message);

        const before = { total: num(po.grandTotal), vendor: String(po.vendor || ''), lines: (po.items || []).length };
        if (vendor !== undefined) po.vendor = vendor;
        if (items !== undefined) po.items = nextItems;
        if (department !== undefined) po.department = department || null;
        if (warehouse !== undefined) po.warehouse = warehouse || null;
        if (budget !== undefined) po.budget = budget || null;
        if (discount !== undefined) po.discount = nextDiscount;
        if (deliveryAddress !== undefined) po.deliveryAddress = deliveryAddress || '';
        if (terms !== undefined) po.terms = terms || '';
        if (expectedDelivery !== undefined) po.expectedDelivery = expectedDelivery || null;
        if (signature !== undefined) po.signature = signature || '';
        Object.assign(po, totals);
        await po.save();

        await logAudit(req, 'PO_UPDATED', 'PurchaseOrder', po._id,
            `Edited purchase order ${po.poNumber}`,
            { before, after: { total: totals.grandTotal, lines: (po.items || []).length } }, po.poNumber);
        ok(res, po);
    } catch (e) { err(res, e); }
};

// Goods Received Note (spec §11): receive quantities → increase stock.
exports.receivePurchaseOrder = async (req, res) => {
    try {
        const { lines, invoice } = req.body; // lines: [{ itemId(POItem._id), receivedQty, batchNumber, serialNumbers, expiryDate }]
        const po = await PurchaseOrder.findOne({ _id: req.params.id, school: req.schoolId });
        if (!po) return bad(res, 'Purchase order not found', 404);
        if (po.status === 'received') return bad(res, 'Purchase order already fully received');
        if (po.status === 'cancelled') return bad(res, 'That purchase order was cancelled');
        if (['draft', 'pending_approval'].includes(po.status))
            return bad(res, 'Approve the purchase order before receiving goods against it');
        if (!po.warehouse) return bad(res, 'Set a receiving warehouse on the PO first');
        if (!lines || !lines.length) return bad(res, 'No receipt lines provided');

        // Worked out first, applied as one transaction: a goods receipt that
        // failed on its fourth line used to leave the first three in stock and
        // the order's receivedQty untouched.
        const movements = [];
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
                movements.push({
                    item: poItem.item, warehouse: po.warehouse, type: 'purchase',
                    quantity: applied, unitCost: poItem.unitPrice || 0,
                    refType: 'PurchaseOrder', refId: po._id,
                    batchNumber: line.batchNumber || '', serialNumbers: line.serialNumbers || [],
                    expiryDate: line.expiryDate || null,
                    note: `GRN for ${po.poNumber}`,
                });
            }
        }
        if (movements.length) await stockService.moveAll(req, movements);

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

        await logAudit(req, 'PO_RECEIVED', 'PurchaseOrder', po._id,
            `Goods received for ${po.poNumber}`, { status: po.status }, po.poNumber);
        ok(res, po);
    } catch (e) { stockErr(res, e); }
};

exports.cancelPurchaseOrder = async (req, res) => {
    try {
        const po = await PurchaseOrder.findOne({ _id: req.params.id, school: req.schoolId });
        if (!po) return bad(res, 'Purchase order not found', 404);
        if (po.status === 'received') return bad(res, 'Cannot cancel a fully received PO');
        if (po.status === 'cancelled') return bad(res, 'That purchase order is already cancelled');
        po.status = 'cancelled';
        po.cancelledAt = new Date();
        po.cancelReason = String(req.body?.reason || '').slice(0, 500);
        await po.save();
        await logAudit(req, 'PO_CANCELLED', 'PurchaseOrder', po._id,
            `Cancelled purchase order ${po.poNumber}`, { reason: po.cancelReason }, po.poNumber);
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
        const { item, warehouse, quantity, issuedToUser, issuedToName, department, expectedReturn,
            conditionOut, signature, note, recipientType, classLabel, returnable } = req.body;
        if (!item || !warehouse) return bad(res, 'Item and warehouse are required');
        const qty = Math.abs(Number(quantity));
        if (!qty) return bad(res, 'Quantity must be positive');

        const issueNumber = await nextDocNumber(req.schoolId, 'issue');
        const issue = await InventoryIssue.create({
            school: req.schoolId, issueNumber, item, warehouse, quantity: qty,
            issuedToUser: issuedToUser || null, issuedToName: issuedToName || '',
            department: department || null, expectedReturn: expectedReturn || null,
            recipientType: recipientType || (issuedToUser ? 'staff' : 'department'),
            classLabel: classLabel || '',
            // A consumable never comes back, and counting it as an outstanding
            // return forever is what made "Pending Returns" meaningless.
            returnable: returnable !== false,
            conditionOut: conditionOut || 'Good', signature: signature || '', note: note || '',
            issuedBy: req.userId,
        });

        try {
            await applyStockMovement(req, {
                item, warehouse, type: 'issue', quantity: -qty,
                refType: 'InventoryIssue', refId: issue._id,
                note: `Issued via ${issueNumber}`,
            });
        } catch (e) {
            // The issue document was written first; without this an issue that
            // could not take the stock was still on the books as if it had.
            await InventoryIssue.deleteOne({ _id: issue._id, school: req.schoolId }).catch(() => {});
            throw e;
        }
        await logAudit(req, 'ITEM_ISSUED', 'InventoryIssue', issue._id,
            `Issued ${qty} units`, { quantity: qty }, issueNumber);
        if (issuedToUser) {
            InventoryItem.findById(item).select('name').lean().then(it => notify({
                school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                title: '📦 Inventory item issued to you',
                body: `${qty} × ${it?.name || 'item'} issued to you (${issueNumber}).${expectedReturn ? ` Expected return: ${new Date(expectedReturn).toLocaleDateString('en-IN')}.` : ''}`,
                recipients: [issuedToUser],
                link: { type: 'inventory.issues', entityId: issue._id },
            })).catch(() => {});
        }
        ok(res, issue);
    } catch (e) { stockErr(res, e); }
};

exports.returnIssue = async (req, res) => {
    try {
        const { returnQty, condition, restock, note } = req.body;
        const issue = await InventoryIssue.findOne({ _id: req.params.id, school: req.schoolId });
        if (!issue) return bad(res, 'Issue not found', 404);
        if (issue.status === 'returned') return bad(res, 'Already fully returned');

        const outstanding = issue.quantity - issue.returnedQty;
        const rq = Math.min(Math.abs(Number(returnQty) || outstanding), outstanding);
        if (rq <= 0) return bad(res, 'Nothing to return');

        // The condition decides whether the goods come back onto the shelf, so
        // an unrecognised one used to mean neither branch ran: the return was
        // recorded, the issue closed, and the stock never came back — a silent
        // 200 that loses goods. A caller sending "Good" instead of "good" was
        // enough to trigger it. Normalise, then refuse what we do not know.
        const CONDITIONS = ['good', 'used', 'partially_used', 'damaged', 'lost', 'repair_needed'];
        const cond = String(condition || 'good').trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (!CONDITIONS.includes(cond)) {
            return bad(res, `Unknown condition "${condition}" — use one of: ${CONDITIONS.join(', ')}`);
        }
        const writeOff = cond === 'damaged' || cond === 'lost';
        const backToStock = !writeOff && restock !== false;
        // Numbered in sequence within the issue, so two returns against one
        // issue are two rows the Issue / Return screen can tell apart.
        const returnNumber = `${issue.issueNumber}-R${String((issue.returns || []).length + 1).padStart(2, '0')}`;
        issue.returns = [...(issue.returns || []), {
            returnNumber, quantity: rq, condition: cond, restocked: backToStock,
            returnedAt: new Date(), receivedBy: req.userId, note: note || '',
        }];
        issue.returnedQty += rq;
        issue.returnedAt = new Date();
        issue.returnCondition = cond;
        issue.status = issue.returnedQty >= issue.quantity ? 'returned' : 'partially_returned';
        await issue.save();

        // Good / used / repairable items go back to stock; lost and damaged come
        // back and are written straight off again, so the ledger shows both.
        // One transaction, or a failure on the write-off leaves the loss in stock.
        const base = { item: issue.item, warehouse: issue.warehouse, refType: 'InventoryIssue', refId: issue._id };
        if (writeOff) {
            await stockService.moveAll(req, [
                { ...base, type: 'return', quantity: rq, note: `Returned ${cond}` },
                { ...base, type: cond === 'lost' ? 'scrap' : 'damage', quantity: -rq, note: `Written off (${cond})` },
            ]);
        } else if (backToStock) {
            await stockService.moveAll(req, [
                { ...base, type: 'return', quantity: rq, note: `Return for ${issue.issueNumber}` },
            ]);
        } else {
            // The caller explicitly asked not to restock a serviceable return:
            // it left stock on issue and it is not coming back, so it is a
            // write-off like any other and the ledger says so.
            await stockService.moveAll(req, [
                { ...base, type: 'return', quantity: rq, note: `Return for ${issue.issueNumber}` },
                { ...base, type: 'scrap', quantity: -rq, note: 'Returned but not restocked' },
            ]);
        }
        await logAudit(req, 'ITEM_RETURNED', 'InventoryIssue', issue._id,
            `Returned ${rq} units (${cond.replace(/_/g, ' ')})`, { quantity: rq, condition: cond }, returnNumber);
        ok(res, issue);
    } catch (e) { stockErr(res, e); }
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
        if (!body.assetCode) body.assetCode = await nextDocNumber(req.schoolId, 'asset');
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
        const open = await InventoryAsset.findOne({ _id: req.params.id, school: req.schoolId }).select('repairs status').lean();
        if (open && (open.repairs || []).some(r => !['completed', 'returned'].includes(r.status))) {
            return bad(res, 'Cannot delete — this asset has an open repair. Close it first, or retire the asset instead.');
        }
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
