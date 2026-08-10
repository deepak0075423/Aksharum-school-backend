const db = require('../db/orm');

const FeeStructureItemSchema = new db.Schema({
    feeHead: { type: db.Types.UUID, ref: 'FeeHead', required: true },
    amount:  { type: Number, required: true, min: 0 },
    isActive: { type: Boolean, default: true },
}, { _id: true });

const FeeStructureSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    name:         { type: String, required: true, trim: true },
    level:        { type: String, enum: ['class', 'section'], required: true },
    class:        { type: db.Types.UUID, ref: 'Class', default: null },
    section:      { type: db.Types.UUID, ref: 'ClassSection', default: null },
    dueDay:       { type: Number, min: 1, max: 31, default: null },
    items:        [FeeStructureItemSchema],
    totalAmount:  { type: Number, default: 0 },
    itemsHash:         { type: String, default: '' },
    demandGeneratedAt: { type: Date, default: null },
    demandStartedAt:   { type: Date, default: null },
    isActive:     { type: Boolean, default: true },
    createdBy:    { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

FeeStructureSchema.index({ school: 1, academicYear: 1, level: 1, class: 1 });
FeeStructureSchema.index({ school: 1, academicYear: 1, level: 1, section: 1 });
FeeStructureSchema.index({ school: 1, academicYear: 1, isActive: 1 });

module.exports = db.model('FeeStructure', FeeStructureSchema);
