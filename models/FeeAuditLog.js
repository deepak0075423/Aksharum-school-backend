const db = require('../db/orm');

const FeeAuditLogSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    user: { type: db.Types.UUID, ref: 'User', default: null },
    role: { type: String, default: '' },
    actionType: { type: String, required: true },
    entityType: {
        type: String,
        enum: ['FeeHead', 'FeeStructure', 'StudentFeeAssignment', 'FineRule', 'FeeConcession',
               'StudentConcession', 'FeePayment', 'FeeSettings', 'FeeLedger'],
        default: null,
    },
    entityId: { type: db.Types.UUID, default: null },
    oldValue: { type: db.Types.JSON, default: null },
    newValue: { type: db.Types.JSON, default: null },
    timestamp: { type: Date, default: Date.now, immutable: true },
});

FeeAuditLogSchema.index({ school: 1, timestamp: -1 });
FeeAuditLogSchema.index({ school: 1, actionType: 1 });
FeeAuditLogSchema.index({ school: 1, entityType: 1, entityId: 1 });

module.exports = db.model('FeeAuditLog', FeeAuditLogSchema);
