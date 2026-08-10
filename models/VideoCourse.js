const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  VideoCourse — the highest-level container: a structured programme made of
//  ordered sections that each hold playlists and/or standalone videos
//  (VideoCourseItem). Supports completion tracking and optional certificates.
// ─────────────────────────────────────────────────────────────────────────────
const VideoCourseSchema = new db.Schema({
    scope:  { type: String, enum: ['master', 'school'], default: 'master', index: true },
    school: { type: db.Types.UUID, ref: 'School', default: null, index: true },

    title:       { type: String, required: true, trim: true },
    slug:        { type: String, default: '' },
    description: { type: String, default: '' },
    thumbnailUrl:{ type: String, default: '' },

    difficulty:           { type: String, enum: ['beginner', 'intermediate', 'advanced'], default: 'beginner' },
    estimatedDurationMin: { type: Number, default: 0 },
    itemCount:            { type: Number, default: 0 },

    certificateEnabled: { type: Boolean, default: false },
    passPercent:        { type: Number, default: 80 }, // min completion % to earn certificate

    status:   { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },

    isDeleted: { type: Boolean, default: false, index: true },
}, { timestamps: true });

VideoCourseSchema.index({ scope: 1, status: 1 });
VideoCourseSchema.index({ school: 1, status: 1 });

module.exports = db.model('VideoCourse', VideoCourseSchema);
