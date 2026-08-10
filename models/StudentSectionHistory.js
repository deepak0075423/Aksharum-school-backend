const db = require('../db/orm');

const StudentSectionHistorySchema = new db.Schema({
    student: {
        type: db.Types.UUID,
        ref: 'User',
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
        required: true,
    },
    transferDate: {
        type: Date,
        default: Date.now,
    },
    transferReason: {
        type: String,
        default: '',
    },
    transferredBy: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
});

module.exports = db.model('StudentSectionHistory', StudentSectionHistorySchema);
