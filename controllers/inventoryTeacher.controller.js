'use strict';
const InventoryItem       = require('../models/InventoryItem');
const InventoryStock      = require('../models/InventoryStock');
const InventoryDepartment = require('../models/InventoryDepartment');
const InventoryCategory   = require('../models/InventoryCategory');
const PurchaseRequest     = require('../models/PurchaseRequest');
const InventoryAuditLog   = require('../models/InventoryAuditLog');
const { notify, schoolAdminIds } = require('../services/notifyService');
const budgets = require('../services/inventoryBudget');
const { nextNumber } = require('../services/inventoryNumber');

const num = (v)                  => (Number.isFinite(+v) ? +v : 0);
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

// Dropdown sources a teacher needs to raise a request.
exports.getMeta = async (req, res) => {
    try {
        const [items, departments, stock] = await Promise.all([
            InventoryItem.find({ school: req.schoolId, isActive: true })
                .select('name itemCode unit purchasePrice reorderLevel image category').sort({ name: 1 }).lean(),
            InventoryDepartment.find({ school: req.schoolId, isActive: true }).select('name').sort({ name: 1 }).lean(),
            InventoryStock.find({ school: req.schoolId }).select('item quantity reserved').lean(),
        ]);
        // What is on the shelf, so the form can say "there are 40 of these
        // already" before a teacher asks for more. It carried no stock at all
        // before, so its chip read zero for every item in the school.
        const held = new Map();
        for (const s of stock) {
            const k = String(s.item);
            const cur = held.get(k) || { onHand: 0, reserved: 0 };
            cur.onHand += num(s.quantity);
            cur.reserved += num(s.reserved);
            held.set(k, cur);
        }
        ok(res, {
            items: items.map(i => {
                const h = held.get(String(i._id)) || { onHand: 0, reserved: 0 };
                return {
                    ...i, _id: String(i._id),
                    onHand: h.onHand, reserved: h.reserved,
                    available: Math.max(0, h.onHand - h.reserved),
                };
            }),
            departments,
        });
    } catch (e) { err(res, e); }
};

/**
 * The teacher's own request list, shaped the way the admin screens are.
 *
 * `getMyRequests` hands back raw rows: no counts, no filtering, no search. The
 * portal drew a bare table from them because there was nothing else to draw.
 * This is the same read model the admin board uses, narrowed to one person.
 */
exports.requestBoard = async (req, res) => {
    try {
        const school = req.schoolId;
        const { search = '', status = '', tab = 'all', from = '', to = '', page = 1, limit = 10 } = req.query;
        const all = await PurchaseRequest.find({ school, requestedBy: req.userId })
            .populate('department', 'name')
            .populate('purchaseOrder', 'poNumber status')
            .sort({ createdAt: -1 }).lean();

        // The screen shows each request by its FIRST line — a thumbnail, the
        // item's name and how many lines there are. That needs the master rows
        // those lines point at, and their categories for the fallback icon.
        const lineIds = [...new Set(all.flatMap(r => (r.items || []).map(l => l.item)).filter(Boolean).map(String))];
        const [lineItems, cats] = await Promise.all([
            lineIds.length
                ? InventoryItem.find({ school, _id: { $in: lineIds } }).select('name image category unit').lean()
                : [],
            InventoryCategory.find({ school }).select('name icon').lean(),
        ]);
        const itemById = new Map(lineItems.map(i => [String(i._id), i]));
        const catById = new Map(cats.map(c => [String(c._id), c]));

        const rx = (q) => new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const shaped = all.map(r => {
            const first = (r.items || [])[0];
            const firstItem = first?.item ? itemById.get(String(first.item)) : null;
            return {
            _id: String(r._id),
            requestNumber: r.requestNumber,
            // What the row leads with: the first line, and how many there are.
            lead: {
                name: first?.itemName || 'No items',
                image: firstItem?.image || '',
                icon: catById.get(String(firstItem?.category || ''))?.icon || 'box',
            },
            reason: r.reason || '',
            priority: r.priority || 'normal',
            department: r.department ? { _id: String(r.department._id), name: r.department.name } : null,
            lines: (r.items || []).length,
            items: (r.items || []).map(l => ({
                itemName: l.itemName, quantity: num(l.quantity),
                unit: l.unit || 'Nos', estimatedPrice: num(l.estimatedPrice),
            })),
            estimatedTotal: num(r.estimatedTotal),
            status: r.status,
            purchaseOrder: r.purchaseOrder ? { poNumber: r.purchaseOrder.poNumber, status: r.purchaseOrder.status } : null,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt || r.createdAt,
            // What the approvers said, which is the only reason to open one of these.
            approvals: (r.approvals || []).map(a => ({
                stage: a.stage, action: a.action, comment: a.comment || '', actedAt: a.actedAt,
            })),
            checks: r.checks || {},
            };
        });

        // The tiles count everything, not just the page or the current filter —
        // "3 awaiting approval" has to mean three, whatever is typed in the box.
        const TABS = {
            all: null,
            pending: ['pending'],
            approved: ['approved', 'converted', 'fulfilled_from_stock'],
            rejected: ['rejected', 'cancelled'],
            // A teacher's request is created submitted — the model never writes
            // `draft`. The tab exists because the screen shows it; it counts
            // honestly, which means it counts nothing.
            draft: ['draft'],
        };
        const countIn = (keys) => (keys ? shaped.filter(r => keys.includes(r.status)).length : shaped.length);
        const tabs = Object.fromEntries(Object.keys(TABS).map(k => [k, countIn(TABS[k])]));
        const tiles = {
            total: tabs.all,
            pending: tabs.pending,
            approved: tabs.approved,
            rejected: tabs.rejected,
            value: shaped.reduce((t, r) => t + r.estimatedTotal, 0),
        };

        let rows = shaped;
        if (TABS[tab]) rows = rows.filter(r => TABS[tab].includes(r.status));
        if (status) rows = rows.filter(r => r.status === status);
        if (from) { const d = new Date(`${from}T00:00:00`); rows = rows.filter(r => new Date(r.createdAt) >= d); }
        if (to) { const d = new Date(`${to}T23:59:59`); rows = rows.filter(r => new Date(r.createdAt) <= d); }
        if (search) {
            rows = rows.filter(r => rx(search).test(
                `${r.requestNumber} ${r.reason} ${r.department?.name || ''} ${r.items.map(i => i.itemName).join(' ')}`));
        }

        const total = rows.length;
        const lim = Math.max(1, Math.min(100, Number(limit) || 10));
        const pg = Math.max(1, Number(page) || 1);
        ok(res, {
            tiles, tabs, rows: rows.slice((pg - 1) * lim, pg * lim),
            total, page: pg, pages: Math.max(1, Math.ceil(total / lim)),
        });
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
            // EVERY line, not any line — the admin path has always meant it
            // this way, and an approver reading "in stock" on a request whose
            // second item is not is being misled.
            stockAvailable = normalized.every(i => !i.item || (avail[String(i.item)] || 0) >= i.quantity);
        }

        // Budget check — the same service a purchase order is measured
        // against, so the flag an approver sees means what the block will do.
        const check = await budgets.checkSpend(req.schoolId, {
            department, items: normalized, total: estimatedTotal,
        });
        const budgetOk = !check.blocked;

        // Duplicate check — a recent pending request by the same user for the same items.
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const names = normalized.map(i => i.itemName.toLowerCase());
        const recent = await PurchaseRequest.find({
            school: req.schoolId, requestedBy: req.userId, status: 'pending', createdAt: { $gte: since },
        }).select('items.itemName').lean();
        const possibleDuplicate = recent.some(r => r.items.some(it => names.includes((it.itemName || '').toLowerCase())));

        const requestNumber = await nextNumber(req.schoolId, 'request');
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
            link: { type: 'inventory.requests', entityId: pr._id },
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
