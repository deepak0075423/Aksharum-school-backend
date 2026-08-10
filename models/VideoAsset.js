const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  VideoAsset — companion files attached to a video: subtitles, PDF notes,
//  worksheets, assignments, question banks, transcripts and generic resources.
//  Thumbnails live on the Video record itself; larger downloadable artefacts
//  live here so a video can have any number of them in any language.
// ─────────────────────────────────────────────────────────────────────────────
const VideoAssetSchema = new db.Schema({
    video: { type: db.Types.UUID, ref: 'Video', required: true, index: true },
    kind: {
        type: String,
        enum: [
            'subtitle', 'caption', 'notes', 'worksheet', 'assignment',
            'question_bank', 'transcript', 'resource', 'thumbnail',
        ],
        required: true,
        index: true,
    },
    title:    { type: String, default: '' },
    language: { type: String, default: '' },   // for subtitles/captions ("en", "hi")

    source:   { type: String, enum: ['s3', 'local', 'external'], default: 'local' },
    fileUrl:  { type: String, default: '' },
    fileKey:  { type: String, default: '' },   // s3 object key
    mimeType: { type: String, default: '' },
    sizeBytes:{ type: Number, default: 0 },

    isActive:   { type: Boolean, default: true },
    uploadedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

VideoAssetSchema.index({ video: 1, kind: 1 });

module.exports = db.model('VideoAsset', VideoAssetSchema);
