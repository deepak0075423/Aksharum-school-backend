const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  VideoPlaylist — an ordered collection of videos. Master playlists (scope
//  'master', school null) are curated by Super Admins and reused everywhere;
//  school playlists (scope 'school') are built by a school's admins/teachers.
//  Board/class/subject targeting is stored in VideoTaxonomy (entityType
//  'playlist'). Ordered membership lives in VideoPlaylistItem.
// ─────────────────────────────────────────────────────────────────────────────
const VideoPlaylistSchema = new db.Schema({
    scope:  { type: String, enum: ['master', 'school'], default: 'master', index: true },
    school: { type: db.Types.UUID, ref: 'School', default: null, index: true },

    title:       { type: String, required: true, trim: true },
    slug:        { type: String, default: '' },
    description: { type: String, default: '' },
    thumbnailUrl:{ type: String, default: '' },

    estimatedDurationMin: { type: Number, default: 0 }, // denormalized from items
    videoCount:           { type: Number, default: 0 },

    status:   { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true },
    isPinned: { type: Boolean, default: false },

    // A teacher a school assigns to own/curate this playlist (optional).
    teacherAssigned: { type: db.Types.UUID, ref: 'User', default: null },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },

    isDeleted: { type: Boolean, default: false, index: true },
}, { timestamps: true });

VideoPlaylistSchema.index({ scope: 1, status: 1 });
VideoPlaylistSchema.index({ school: 1, status: 1 });

module.exports = db.model('VideoPlaylist', VideoPlaylistSchema);
