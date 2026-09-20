const db = require('../db/orm');

const FeeStructureItemSchema = new db.Schema({
    feeHead: { type: db.Types.UUID, ref: 'FeeHead', required: true },
    amount:  { type: Number, required: true, min: 0 },
    isActive: { type: Boolean, default: true },
    // The months this head is charged in, 'YYYY-MM', both inside the
    // structure's academic year. Monthly heads charge every month of the
    // window, quarterly every third month from the start, half-yearly every
    // sixth; one-time and yearly heads charge once, in startMonth.
    startMonth: { type: String, default: null },
    endMonth:   { type: String, default: null },
}, { _id: true });

const FeeStructureSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true },
    name:         { type: String, required: true, trim: true },
    level:        { type: String, enum: ['class', 'section'], required: true },
    class:        { type: db.Types.UUID, ref: 'Class', default: null },
    section:      { type: db.Types.UUID, ref: 'ClassSection', default: null },
    dueDay:       { type: Number, min: 1, max: 31, default: null },
    // The first month this structure charges. Until then it is "upcoming" and
    // the fee book's month-by-month schedule starts here rather than at the
    // month the demand happened to be generated.
    effectiveFrom: { type: Date, default: null },
    description:  { type: String, default: '' },
    items:        [FeeStructureItemSchema],
    totalAmount:  { type: Number, default: 0 },
    itemsHash:         { type: String, default: '' },
    demandGeneratedAt: { type: Date, default: null },
    demandStartedAt:   { type: Date, default: null },
    // Set when demand is generated month by month (Sep 2026 engine). Only
    // these structures are visited by the monthly charging sweep; one
    // generated earlier as a single lump waits for the office to generate again.
    periodicSince:     { type: Date, default: null },
    // When it was last switched off, and the months it was not charging in —
    // so switching it back on does not silently bill the gap.
    deactivatedAt:     { type: Date, default: null },
    skippedMonths:     { type: [String], default: () => [] },
    isActive:     { type: Boolean, default: true },
    createdBy:    { type: db.Types.UUID, ref: 'User' },
    updatedBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

FeeStructureSchema.index({ school: 1, academicYear: 1, level: 1, class: 1 });
FeeStructureSchema.index({ school: 1, academicYear: 1, level: 1, section: 1 });
FeeStructureSchema.index({ school: 1, academicYear: 1, isActive: 1 });

module.exports = db.model('FeeStructure', FeeStructureSchema);
