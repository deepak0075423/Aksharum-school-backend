const db = require('../db/orm');

const FeeConcessionSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    name: { type: String, required: true, trim: true },
    concessionType: { type: String, enum: ['percentage', 'fixed'], required: true },
    value: { type: Number, required: true, min: 0 },
    applicableTo: { type: String, enum: ['all', 'specific_heads'], default: 'all' },
    applicableHeads: [{ type: db.Types.UUID, ref: 'FeeHead' }],
    description: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

FeeConcessionSchema.index({ school: 1, isActive: 1 });
FeeConcessionSchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = db.model('FeeConcession', FeeConcessionSchema);
