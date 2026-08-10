const db = require('../db/orm');

const StudentPromotionHistorySchema = new db.Schema({
    student: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    oldClass: {
        type: db.Types.UUID,
        ref: 'Class',
        default: null,
    },
    newClass: {
        type: db.Types.UUID,
        ref: 'Class',
        required: true,
    },
    oldSection: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        default: null,
    },
    newSection: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        default: null,
    },
    promotionDate: {
        type: Date,
        default: Date.now,
    },
    promotedBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    academicYear: {
        type: db.Types.UUID,
        ref: 'AcademicYear',
        required: true,
    },
    remarks: {
        type: String,
        default: '',
    },
});

module.exports = db.model('StudentPromotionHistory', StudentPromotionHistorySchema);
