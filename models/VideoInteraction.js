const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  VideoInteraction — student engagement records: like / dislike / bookmark /
//  favorite / watch-later / share / report / timestamped note.
//
//  Toggle types (like, dislike, favorite, watch_later) keep a single active row
//  per (user, video, type) — enforced in the controller. Multi types (bookmark,
//  note, report, share) may have many rows per video.
// ─────────────────────────────────────────────────────────────────────────────
const VideoInteractionSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', default: null, index: true },
    user:   { type: db.Types.UUID, ref: 'User', required: true, index: true },
    video:  { type: db.Types.UUID, ref: 'Video', required: true, index: true },

    type: {
        type: String,
        enum: ['like', 'dislike', 'bookmark', 'favorite', 'watch_later', 'note', 'report', 'share'],
        required: true,
        index: true,
    },
    active:       { type: Boolean, default: true }, // toggle state for like/favorite/etc.
    timestampSec: { type: Number, default: 0 },     // for bookmark/note position
    note:         { type: String, default: '' },

    reportReason: { type: String, default: '' },
    reportStatus: { type: String, enum: ['', 'open', 'reviewed', 'dismissed', 'actioned'], default: '' },
}, { timestamps: true });

VideoInteractionSchema.index({ user: 1, video: 1, type: 1 });
VideoInteractionSchema.index({ video: 1, type: 1, active: 1 });

module.exports = db.model('VideoInteraction', VideoInteractionSchema);
