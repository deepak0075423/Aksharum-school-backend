const db = require('../db/orm');

// Configurable question categories (Teaching Quality, Communication, …).
// Categories are never hard-deleted once historical feedback references them —
// the controller flips `status` to 'archived' instead (spec §13, rule 14).
const FeedbackCategorySchema = new db.Schema({
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
    // Short key used by the seeded defaults so re-seeding is idempotent.
    slug: {
        type: String,
        default: '',
        trim: true,
    },
    displayOrder: {
        type: Number,
        default: 0,
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
}, { timestamps: true });

// One category name per school; the seeded slug is likewise unique per school.
FeedbackCategorySchema.index({ school: 1, name: 1 }, { unique: true });
FeedbackCategorySchema.index({ school: 1, status: 1, displayOrder: 1 });

module.exports = db.model('FeedbackCategory', FeedbackCategorySchema);
