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
    // Section shuffle state. A Class row belongs to exactly one academic year,
    // so locking here locks that class for that year only.
    sectionShuffle: {
        shuffledAt: { type: Date, default: null },
        lockedAt:   { type: Date, default: null },
        lockedBy:   { type: db.Types.UUID, ref: 'User', default: null },
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

// Listed by class number, then name, unless a query sorts them itself
// (utils/listOrder). A list spanning several years comes year by year.
ClassSchema.set('defaultOrder', `(SELECT y."startDate" FROM "academicyears" y WHERE y."_id" = "classes"."academicYear") NULLS LAST, ${require('../utils/listOrder').classOrderSql()}`);

module.exports = db.model('Class', ClassSchema);
