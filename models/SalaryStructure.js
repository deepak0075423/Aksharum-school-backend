const db = require('../db/orm');

const ComponentSchema = new db.Schema({
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['earning', 'deduction'], required: true },
    calculationType: { type: String, enum: ['fixed', 'percentage'], required: true },
    value: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    percentageOf: { type: String, default: 'Basic Salary', trim: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
}, { _id: true });

const SalaryStructureSchema = new db.Schema({
    name: { type: String, required: true, trim: true },
    school: { type: db.Types.UUID, ref: 'School', required: true },
    description: { type: String, default: '' },
    components: [ComponentSchema],
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

SalaryStructureSchema.index({ school: 1, isActive: 1 });
SalaryStructureSchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = db.model('SalaryStructure', SalaryStructureSchema);
