const db = require('../db/orm');

const ClassSubjectSchema = new db.Schema({
    class: {
        type: db.Types.UUID,
        ref: 'Class',
        required: true,
    },
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// A subject can only be assigned once per class
ClassSubjectSchema.index({ class: 1, subject: 1 }, { unique: true });

module.exports = db.model('ClassSubject', ClassSubjectSchema);
