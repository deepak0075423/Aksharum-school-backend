const db = require('../db/orm');

const SubjectSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    subjectName: {
        type: String,
        required: true,
        trim: true,
    },
    subjectCode: {
        type: String,
        default: null,
        trim: true,
        uppercase: true,
    },
    type: {
        type: String,
        enum: ['theory', 'practical', 'elective'],
        default: 'theory',
    },
    description: {
        type: String,
        default: '',
    },
    teachers: [{
        type: db.Types.UUID,
        ref: 'User',
    }],
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Unique subject code per school, sparse so subjects with no code don't conflict
SubjectSchema.index({ school: 1, subjectCode: 1 }, { unique: true, sparse: true });

module.exports = db.model('Subject', SubjectSchema);
