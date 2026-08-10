const db = require('../db/orm');

const FineRuleSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    name: { type: String, required: true, trim: true },
    fineType: { type: String, enum: ['flat', 'per_day'], required: true },
    flatAmount: { type: Number, default: 0, min: 0 },
    perDayAmount: { type: Number, default: 0, min: 0 },
    gracePeriodDays: { type: Number, default: 0, min: 0 },
    maxCap: { type: Number, default: 0, min: 0 }, // 0 = no cap
    // empty array or ['all'] = applies to all fee heads; otherwise specific categories
    applicableCategories: [{ type: String }],
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

FineRuleSchema.index({ school: 1, isActive: 1 });
FineRuleSchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = db.model('FineRule', FineRuleSchema);
