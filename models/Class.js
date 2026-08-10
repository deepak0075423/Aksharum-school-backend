const db = require('../db/orm');

const ClassSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        required: true,
    },
    classNumber: {
        type: Number,
        required: true,
    },
    className: {
        type: String,
        required: true,
        trim: true,
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

// Unique class number per school per academic year
ClassSchema.index({ school: 1, academicYear: 1, classNumber: 1 }, { unique: true });

module.exports = db.model('Class', ClassSchema);
