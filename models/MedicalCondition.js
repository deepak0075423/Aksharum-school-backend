const db = require('../db/orm');

/**
 * A medical condition a student lives with — asthma, diabetes, epilepsy, a
 * heart condition, a vision or hearing problem. A severe or critical one is a
 * critical medical alert. Same history rules as MedicalAllergy: resolve,
 * archive, never erase.
 */
const MedicalConditionSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    condition: { type: String, required: true, trim: true },
    type: {
        type: String,
        enum: ['asthma', 'diabetes', 'epilepsy', 'heart', 'vision', 'hearing', 'orthopedic', 'chronic', 'other'],
        default: 'other',
    },
    severity: { type: String, enum: ['mild', 'moderate', 'severe', 'critical'], default: 'mild' },
    chronic:  { type: Boolean, default: false },
    diagnosedOn: { type: Date, default: null },
    treatment:             { type: String, default: '', trim: true },
    medication:            { type: String, default: '', trim: true },
    doctor:                { type: String, default: '', trim: true },
    emergencyInstructions: { type: String, default: '', trim: true },
    parentNote:            { type: String, default: '', trim: true },
    documents:             { type: [db.Types.UUID], default: [] },
    // Whether the student's own teachers see it beside their alerts. On for
    // anything a teacher must act on; the medical room can keep a sensitive
    // record to itself (services/medicalRules.defaultShare).
    shareWithTeachers: { type: Boolean, default: true },

    status:     { type: String, enum: ['active', 'managed', 'resolved'], default: 'active' },
    source:     { type: String, enum: ['staff', 'parent'], default: 'staff' },
    verified:   { type: Boolean, default: true },
    verifiedBy: { type: db.Types.UUID, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalConditionSchema.index({ school: 1, student: 1 });
MedicalConditionSchema.index({ school: 1, type: 1 });

module.exports = db.model('MedicalCondition', MedicalConditionSchema);
