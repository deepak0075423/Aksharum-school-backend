const db = require('../db/orm');

const FeeConcessionSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true },
    name: { type: String, required: true, trim: true },
    concessionType: { type: String, enum: ['percentage', 'fixed'], required: true },
    value: { type: Number, required: true, min: 0 },
    applicableTo: { type: String, enum: ['all', 'specific_heads'], default: 'all' },
    applicableHeads: [{ type: db.Types.UUID, ref: 'FeeHead' }],
    description: { type: String, default: '' },
    // Who the scheme is meant for. It picks the students the assign dialog
    // offers; a concession still only reaches a student once it is assigned.
    eligibility: {
        type: String,
        enum: ['selected', 'all', 'siblings', 'staff_children', 'female', 'alumni_children', 'new_admissions'],
        default: 'selected',
    },
    // The window the scheme runs in. Before validFrom it is "upcoming", after
    // validTo it has lapsed and reads as inactive.
    validFrom: { type: Date, default: null },
    validTo:   { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User' },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

FeeConcessionSchema.index({ school: 1, isActive: 1 });
FeeConcessionSchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = db.model('FeeConcession', FeeConcessionSchema);
