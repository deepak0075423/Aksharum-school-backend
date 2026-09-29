const db = require('../db/orm');

const POItemSchema = new db.Schema({
    item: { type: db.Types.UUID, ref: 'InventoryItem', default: null },
    itemName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unit: { type: String, default: 'Nos' },
    unitPrice: { type: Number, default: 0 },
    gst: { type: Number, default: 0 },              // percentage
    // Filled progressively as goods are received (GRN, spec §11).
    receivedQty: { type: Number, default: 0 },
}, { _id: true });

const PurchaseOrderSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    poNumber: { type: String, required: true },
    vendor: { type: db.Types.UUID, ref: 'InventoryVendor', required: true },
    department: { type: db.Types.UUID, ref: 'InventoryDepartment', default: null },
    budget: { type: db.Types.UUID, ref: 'InventoryBudget', default: null },
    purchaseRequest: { type: db.Types.UUID, ref: 'PurchaseRequest', default: null },
    warehouse: { type: db.Types.UUID, ref: 'InventoryWarehouse', default: null }, // receiving store

    items: [POItemSchema],
    discount: { type: Number, default: 0 },         // flat amount
    subTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    deliveryAddress: { type: String, default: '' },
    terms: { type: String, default: '' },
    expectedDelivery: { type: Date, default: null },
    signature: { type: String, default: '' },

    // The full life of an order, as the Purchase Orders screen tabs it:
    //   pending_approval → approved → in_transit → partially_received/received
    // `ordered` is what the pre-redesign code wrote for every new PO and is
    // kept so old rows still read — it means "approved and placed", and the
    // In Transit tab counts it alongside `in_transit`.
    status: {
        type: String,
        enum: ['draft', 'pending_approval', 'approved', 'ordered', 'in_transit', 'partially_received', 'received', 'cancelled'],
        default: 'pending_approval',
    },
    approvedBy: { type: db.Types.UUID, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    dispatchedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },
    // Invoice details (may be captured via OCR-assisted entry, spec §10).
    invoice: {
        number: { type: String, default: '' },
        date: { type: Date, default: null },
        amount: { type: Number, default: 0 },
        fileUrl: { type: String, default: '' },
    },
    createdBy: { type: db.Types.UUID, ref: 'User' },
    receivedAt: { type: Date, default: null },
}, { timestamps: true });

PurchaseOrderSchema.index({ school: 1, createdAt: -1 });
PurchaseOrderSchema.index({ school: 1, poNumber: 1 }, { unique: true });
PurchaseOrderSchema.index({ school: 1, status: 1 });
PurchaseOrderSchema.index({ school: 1, vendor: 1 });

module.exports = db.model('PurchaseOrder', PurchaseOrderSchema);
