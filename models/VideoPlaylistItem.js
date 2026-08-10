const db = require('../db/orm');

// A single positioned video inside a playlist. Kept as its own table (not an
// embedded array) so millions of memberships stay queryable and a video can sit
// in any number of playlists without rewriting the video record.
const VideoPlaylistItemSchema = new db.Schema({
    playlist: { type: db.Types.UUID, ref: 'VideoPlaylist', required: true, index: true },
    video:    { type: db.Types.UUID, ref: 'Video', required: true, index: true },
    sequence: { type: Number, default: 0 },
    note:     { type: String, default: '' },
    addedBy:  { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

VideoPlaylistItemSchema.index({ playlist: 1, video: 1 }, { unique: true });
VideoPlaylistItemSchema.index({ playlist: 1, sequence: 1 });

module.exports = db.model('VideoPlaylistItem', VideoPlaylistItemSchema);
