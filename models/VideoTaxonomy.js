const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  VideoTaxonomy — the universal mapping (junction) table.
//  This is what makes "one video → many boards / classes / subjects / chapters /
//  topics / languages / mediums / academic-years / terms" work WITHOUT ever
//  duplicating a video. One row per (entity, dimension, value).
//
//  The same table maps videos, playlists AND courses (entityType) so a playlist
//  or course can carry the same board/class/subject targeting as a video.
//
//  `value` is the canonical human label (e.g. "CBSE", "Class 10", "Physics").
//  `valueSlug` is the normalized key used for filtering/joins.
//  `refId` optionally links to a concrete per-school entity (Class/Subject/…)
//  when the mapping is school-specific; it is null for global master taxonomy.
// ─────────────────────────────────────────────────────────────────────────────
const VideoTaxonomySchema = new db.Schema({
    entityType: { type: String, enum: ['video', 'playlist', 'course'], default: 'video', index: true },
    entityId:   { type: db.Types.UUID, required: true, index: true },

    dimension: {
        type: String,
        enum: [
            'board', 'grade', 'subject', 'chapter', 'topic', 'subtopic',
            'language', 'medium', 'academic_year', 'term', 'section',
        ],
        required: true,
        index: true,
    },
    value:     { type: String, required: true, trim: true },
    valueSlug: { type: String, required: true, index: true },
    refId:     { type: db.Types.UUID, default: null }, // Class/Subject/AcademicYear/… when school-scoped
    sequence:  { type: Number, default: 0 },                            // chapter/topic ordering
}, { timestamps: true });

// A given entity may carry a value once per dimension.
VideoTaxonomySchema.index({ entityType: 1, entityId: 1, dimension: 1, valueSlug: 1 }, { unique: true });
// Reverse lookup: "all videos for board=cbse" / "all videos for subject=physics".
VideoTaxonomySchema.index({ dimension: 1, valueSlug: 1, entityType: 1 });

module.exports = db.model('VideoTaxonomy', VideoTaxonomySchema);
