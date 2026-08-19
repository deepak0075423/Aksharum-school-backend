const db = require('../db/orm');

// A student's mess enrolment plus their dietary profile (spec §15).
// Allergy information is hostel-operational (the kitchen needs it daily); the
// student's clinical medical record stays on StudentProfile and is not copied.
const HostelMessMemberSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    mess: { type: db.Types.UUID, ref: 'HostelMess', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', default: null },
    allocation: { type: db.Types.UUID, ref: 'HostelAllocation', default: null },

    foodPreference: { type: String, enum: ['veg', 'non_veg', 'vegan', 'jain', 'eggetarian', 'other'], default: 'veg' },
    allergies: { type: [String], default: [] },
    dietaryNotes: { type: String, default: '' },
    mealPlan: { type: String, enum: ['full', 'breakfast_only', 'lunch_dinner', 'custom'], default: 'full' },

    fromDate: { type: Date, default: Date.now },
    toDate: { type: Date, default: null },
    status: { type: String, enum: ['active', 'suspended', 'ended'], default: 'active' },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelMessMemberSchema.index({ school: 1, mess: 1, status: 1 });
HostelMessMemberSchema.index(
    { student: 1 },
    { unique: true, partialFilterExpression: { status: 'active' }, name: 'unique_active_mess_membership' },
);

module.exports = db.model('HostelMessMember', HostelMessMemberSchema);
