const db = require('../db/orm');

const ParentProfileSchema = new db.Schema({
    user: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    // Full details for each guardian. The login account belongs to whichever of
    // them `relationship` names; the others are contact records only.
    father: {
        name:       { type: String, default: '' },
        email:      { type: String, default: '' },
        phone:      { type: String, default: '' },
        occupation: { type: String, default: '' },
    },
    mother: {
        name:       { type: String, default: '' },
        email:      { type: String, default: '' },
        phone:      { type: String, default: '' },
        occupation: { type: String, default: '' },
    },
    guardian: {
        name:       { type: String, default: '' },
        email:      { type: String, default: '' },
        phone:      { type: String, default: '' },
        occupation: { type: String, default: '' },
    },
    // Kept in sync with the blocks above — the mobile profile screens read these
    fatherOccupation: {
        type: String,
        default: '',
    },
    motherOccupation: {
        type: String,
        default: '',
    },
    guardianOccupation: {
        type: String,
        default: '',
    },
    emergencyContact: {
        type: String,
        default: '',
    },
    annualIncome: {
        type: String,
        default: '',
    },
    relationship: {
        type: String,
        enum: ['Father', 'Mother', 'Guardian'],
        default: 'Guardian',
    },
    children: [
        {
            type: db.Types.UUID,
            ref: 'User',
        },
    ],
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = db.model('ParentProfile', ParentProfileSchema);
