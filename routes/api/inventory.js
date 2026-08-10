'use strict';
const express       = require('express');
const router        = express.Router();
const inv           = require('../../controllers/inventory.controller');
const invTeacher    = require('../../controllers/inventoryTeacher.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const requireModule = require('../../middleware/requireModule');

const adminGuard   = [verifyToken, requirePasswordReset, requireRole('school_admin'), requireModule('inventory')];
const teacherGuard = [verifyToken, requirePasswordReset, requireRole('teacher'),      requireModule('inventory')];

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
router.post('/admin/orders/:id/receive', adminGuard, inv.receivePurchaseOrder);
router.post('/admin/orders/:id/cancel',  adminGuard, inv.cancelPurchaseOrder);

// Issue / Return
router.get('/admin/issues',             adminGuard, inv.getIssues);
router.post('/admin/issues',            adminGuard, inv.createIssue);
router.post('/admin/issues/:id/return', adminGuard, inv.returnIssue);

// Assets & Repairs
router.get('/admin/assets',           adminGuard, inv.getAssets);
router.get('/admin/assets/:id',       adminGuard, inv.getAsset);
router.post('/admin/assets',          adminGuard, inv.createAsset);
router.put('/admin/assets/:id',       adminGuard, inv.updateAsset);
router.delete('/admin/assets/:id',    adminGuard, inv.deleteAsset);
router.post('/admin/assets/:id/repairs',              adminGuard, inv.addRepair);
router.put('/admin/assets/:id/repairs/:repairId',     adminGuard, inv.updateRepair);

// Audit log
router.get('/admin/audit', adminGuard, inv.getAuditLog);

// ── Teacher ─────────────────────────────────────────────────────────────────
router.get('/teacher/meta',           teacherGuard, invTeacher.getMeta);
router.get('/teacher/requests',       teacherGuard, invTeacher.getMyRequests);
router.get('/teacher/requests/:id',   teacherGuard, invTeacher.getMyRequest);
router.post('/teacher/requests',      teacherGuard, invTeacher.createRequest);
router.post('/teacher/requests/:id/cancel', teacherGuard, invTeacher.cancelRequest);

module.exports = router;
