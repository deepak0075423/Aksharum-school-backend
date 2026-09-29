'use strict';
const express       = require('express');
const router        = express.Router();
const inv           = require('../../controllers/inventory.controller');
const invAdmin      = require('../../controllers/inventoryAdmin.controller');
const invTeacher    = require('../../controllers/inventoryTeacher.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');
const { allowModuleAdmin } = require('../../middleware/moduleAccess');

const adminGuard   = [verifyToken, requirePasswordReset, allowModuleAdmin('inventory')];
const teacherGuard = [verifyToken, requirePasswordReset, requireRole('teacher'),      requireModule('inventory')];

// ── Admin: the redesigned screens ───────────────────────────────────────────
//
// One endpoint per screen (Sep 2026). Each returns the tiles, charts, filter
// options and page of rows that screen draws, already joined — see
// controllers/inventoryAdmin.controller.js. The per-collection endpoints below
// are still the write side and still serve the teacher portal.
router.get('/admin/overview',            adminGuard, invAdmin.overview);
router.get('/admin/item-board',          adminGuard, invAdmin.itemBoard);
router.get('/admin/item-board/:id',      adminGuard, invAdmin.itemDetail);
router.get('/admin/ledger-board',        adminGuard, invAdmin.ledgerBoard);
router.get('/admin/stock-board',         adminGuard, invAdmin.stockBoard);
router.get('/admin/request-board',       adminGuard, invAdmin.requestBoard);
router.get('/admin/order-board',         adminGuard, invAdmin.orderBoard);
router.get('/admin/issue-board',         adminGuard, invAdmin.issueBoard);
router.get('/admin/asset-board',         adminGuard, invAdmin.assetBoard);
router.get('/admin/vendor-board',        adminGuard, invAdmin.vendorBoard);
router.get('/admin/vendor-board/:id',    adminGuard, invAdmin.vendorDetail);
router.get('/admin/category-board',      adminGuard, invAdmin.categoryBoard);
router.get('/admin/category-board/:id',  adminGuard, invAdmin.categoryDetail);
router.get('/admin/warehouse-board',     adminGuard, invAdmin.warehouseBoard);
router.get('/admin/warehouse-board/:id', adminGuard, invAdmin.warehouseDetail);
router.get('/admin/budget-board',        adminGuard, invAdmin.budgetBoard);
router.get('/admin/budget-board/:id',    adminGuard, invAdmin.budgetDetail);
router.get('/admin/activity-board',      adminGuard, invAdmin.activityBoard);
router.get('/admin/activity-board/:id',  adminGuard, invAdmin.activityDetail);
router.get('/admin/activity-export',     adminGuard, invAdmin.activityExport);
router.get('/admin/form-meta',           adminGuard, invAdmin.formMeta);

// Budgets are their own master (models/InventoryBudget.js); departments below
// remain the master the requests and orders are raised against.
router.post('/admin/budgets',        adminGuard, invAdmin.createBudget);
router.put('/admin/budgets/:id',     adminGuard, invAdmin.updateBudget);
router.delete('/admin/budgets/:id',  adminGuard, invAdmin.deleteBudget);

router.post('/admin/orders/:id/approve',  adminGuard, invAdmin.approveOrder);
router.post('/admin/orders/:id/dispatch', adminGuard, invAdmin.dispatchOrder);
router.post('/admin/requests',            adminGuard, invAdmin.createRequest);
router.post('/admin/items/bulk',          adminGuard, invAdmin.bulkItems);
router.post('/admin/items/reorder',       adminGuard, invAdmin.reorderItem);
router.post('/admin/assets/:id/state',    adminGuard, invAdmin.setAssetState);

// ── Admin ───────────────────────────────────────────────────────────────────
router.get('/admin/dashboard', adminGuard, inv.getDashboard);
router.get('/admin/meta',      adminGuard, inv.getMeta);

// Master data — Categories
router.get('/admin/categories',        adminGuard, inv.getCategories);
router.post('/admin/categories',       adminGuard, inv.createCategory);
router.put('/admin/categories/:id',    adminGuard, inv.updateCategory);
router.delete('/admin/categories/:id', adminGuard, inv.deleteCategory);

// Master data — Vendors
router.get('/admin/vendors',        adminGuard, inv.getVendors);
router.post('/admin/vendors',       adminGuard, inv.createVendor);
router.put('/admin/vendors/:id',    adminGuard, inv.updateVendor);
router.delete('/admin/vendors/:id', adminGuard, inv.deleteVendor);

// Master data — Warehouses
router.get('/admin/warehouses',        adminGuard, inv.getWarehouses);
router.post('/admin/warehouses',       adminGuard, inv.createWarehouse);
router.put('/admin/warehouses/:id',    adminGuard, inv.updateWarehouse);
router.delete('/admin/warehouses/:id', adminGuard, inv.deleteWarehouse);

// Master data — Departments & budgets
router.get('/admin/departments',        adminGuard, inv.getDepartments);
router.post('/admin/departments',       adminGuard, inv.createDepartment);
router.put('/admin/departments/:id',    adminGuard, inv.updateDepartment);
router.delete('/admin/departments/:id', adminGuard, inv.deleteDepartment);

// Item Master
router.get('/admin/items',        adminGuard, inv.getItems);
router.get('/admin/items/:id',    adminGuard, inv.getItem);
router.post('/admin/items',       adminGuard, inv.createItem);
router.put('/admin/items/:id',    adminGuard, inv.updateItem);
router.delete('/admin/items/:id', adminGuard, inv.deleteItem);

// Bulk import. The CSV is parsed in the browser; these resolve category and
// store names, check codes and write the survivors. `?check=1` changes nothing.
router.get('/admin/items-import/template', adminGuard, invAdmin.itemImportTemplate);
router.post('/admin/items-import',         adminGuard, invAdmin.importItems);

// Stock
router.get('/admin/stock',              adminGuard, inv.getStock);
router.get('/admin/stock/transactions', adminGuard, inv.getTransactions);
router.post('/admin/stock/adjust',      adminGuard, inv.adjustStock);
router.post('/admin/stock/transfer',    adminGuard, inv.transferStock);

// Purchase Requests (admin side)
router.get('/admin/requests',              adminGuard, inv.getPurchaseRequests);
router.get('/admin/requests/:id',          adminGuard, inv.getPurchaseRequest);
router.post('/admin/requests/:id/act',     adminGuard, inv.actOnRequest);
router.post('/admin/requests/:id/fulfil',  adminGuard, inv.fulfilFromStock);

// Purchase Orders
router.get('/admin/orders',             adminGuard, inv.getPurchaseOrders);
router.get('/admin/orders/:id',         adminGuard, inv.getPurchaseOrder);
router.post('/admin/orders',            adminGuard, inv.createPurchaseOrder);
router.put('/admin/orders/:id',         adminGuard, inv.updatePurchaseOrder);
router.post('/admin/orders/:id/receive', adminGuard, inv.receivePurchaseOrder);
router.post('/admin/orders/:id/cancel',  adminGuard, inv.cancelPurchaseOrder);

// Issue / Return
router.get('/admin/issues',             adminGuard, inv.getIssues);
router.post('/admin/issues',            adminGuard, inv.createIssue);
router.post('/admin/issues/:id/return', adminGuard, inv.returnIssue);

// ── Printable documents ─────────────────────────────────────────────────────
// Served as HTML the browser prints or saves as PDF, matching how fee receipts
// are handed out. See services/inventoryDocs.
router.get('/admin/orders/:id/print',  adminGuard, invAdmin.printPurchaseOrder);
router.get('/admin/orders/:id/grn',    adminGuard, invAdmin.printGoodsReceived);
router.get('/admin/issues/:id/slip',   adminGuard, invAdmin.printIssueSlip);

// Assets & Repairs
router.get('/admin/assets',           adminGuard, inv.getAssets);
router.get('/admin/assets/:id',       adminGuard, inv.getAsset);
router.post('/admin/assets',          adminGuard, inv.createAsset);
router.put('/admin/assets/:id',       adminGuard, inv.updateAsset);
router.delete('/admin/assets/:id',    adminGuard, inv.deleteAsset);
router.post('/admin/assets/:id/repairs',              adminGuard, inv.addRepair);
router.put('/admin/assets/:id/repairs/:repairId',     adminGuard, inv.updateRepair);

// Audit log
// ── Reports ─────────────────────────────────────────────────────────────────
// Six reports on one endpoint, each returning the same shape so the screen is
// one table and the export is one function. See inventoryAdmin.controller.
router.get('/admin/reports',       adminGuard, invAdmin.reportMeta);
router.get('/admin/reports/:kind', adminGuard, invAdmin.report);

router.get('/admin/audit', adminGuard, inv.getAuditLog);

// ── Teacher ─────────────────────────────────────────────────────────────────
router.get('/teacher/meta',           teacherGuard, invTeacher.getMeta);
router.get('/teacher/request-board',  teacherGuard, invTeacher.requestBoard);
router.get('/teacher/requests',       teacherGuard, invTeacher.getMyRequests);
router.get('/teacher/requests/:id',   teacherGuard, invTeacher.getMyRequest);
router.post('/teacher/requests',      teacherGuard, invTeacher.createRequest);
router.post('/teacher/requests/:id/cancel', teacherGuard, invTeacher.cancelRequest);

module.exports = router;
