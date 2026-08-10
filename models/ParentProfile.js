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
