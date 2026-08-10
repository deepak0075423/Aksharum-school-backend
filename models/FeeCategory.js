const db = require('../db/orm');

const FeeCategorySchema = new db.Schema({
    school:   { type: db.Types.UUID, ref: 'School', required: true },
    name:     { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
}, { timestamps: true });

FeeCategorySchema.index({ school: 1, name: 1 }, { unique: true });
FeeCategorySchema.index({ school: 1, isActive: 1 });

module.exports = db.model('FeeCategory', FeeCategorySchema);
