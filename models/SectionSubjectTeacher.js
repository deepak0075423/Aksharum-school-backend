const db = require('../db/orm');

const SectionSubjectTeacherSchema = new db.Schema({
    section: {
        type: db.Types.UUID,
        ref: 'ClassSection',
        required: true,
    },
    subject: {
        type: db.Types.UUID,
        ref: 'Subject',
        required: true,
    },
    teacher: {
        type: db.Types.UUID,
        ref: 'User',
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// One teacher entry per section+subject+teacher combination
SectionSubjectTeacherSchema.index({ section: 1, subject: 1, teacher: 1 }, { unique: true });

module.exports = db.model('SectionSubjectTeacher', SectionSubjectTeacherSchema);
