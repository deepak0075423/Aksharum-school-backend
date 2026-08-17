const db = require('../db/orm');

// A saved questionnaire (spec §3 "Templates"). Creating a campaign from a
// template copies the question list in; the template itself is never referenced
// afterwards, so editing a template cannot disturb a running campaign.
const FeedbackTemplateSchema = new db.Schema({
    school: {
        type: db.Types.UUID,
        ref: 'School',
        required: true,
    },
    name: {
        type: String,
        required: true,
        trim: true,
    },
    description: {
        type: String,
        default: '',
        trim: true,
    },
    feedbackType: {
        type: String,
        enum: ['student_teacher', 'parent_teacher'],
        default: 'student_teacher',
    },
    // [{ question, displayOrder, isRequired }]
    questions: {
        type: db.Types.JSON,
        default: [],
    },
    instructions: {
        type: String,
        default: '',
        trim: true,
    },
    // The seeded "Standard Teacher Evaluation" template; kept flagged so the
    // seeder is idempotent and the UI can mark it.
    isDefault: {
        type: Boolean,
        default: false,
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active',
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

FeedbackTemplateSchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = db.model('FeedbackTemplate', FeedbackTemplateSchema);
