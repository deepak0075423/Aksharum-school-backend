const db = require('../db/orm');

const AcademicYearSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    yearName: {
        type: String,
        required: true,
        trim: true,
    },
    startDate: {
        type: Date,
        required: true,
    },
    endDate: {
        type: Date,
        required: true,
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'archived'],
        default: 'active',
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Unique: one year name per school
AcademicYearSchema.index({ school: 1, yearName: 1 }, { unique: true });

module.exports = db.model('AcademicYear', AcademicYearSchema);
