const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  Video Learning — one video ASSET in the central library. The file (or the
//  Vimeo / YouTube video) exists once here and is mapped to any number of
//  chapters of any number of books (LmsChapterVideo); it is never stored on a
//  book or a chapter, and never uploaded twice.
//
//  provider         who stores and streams it (services/lms/providers)
//  storageKey       the uploaded source object — private, never sent to a browser
//  playbackKey      what the player is given a signed address for: the HLS
//                   master playlist once processed, else the file itself
//  processingStatus draft → uploading → queued → processing → ready | failed
//                   Only a `ready`, active video can be mapped to a chapter.
//  protection       'strict' content may not use YouTube (its player cannot
//                   keep a video from being shared or opened elsewhere)
// ─────────────────────────────────────────────────────────────────────────────
const LmsVideoSchema = new db.Schema({
    title:        { type: String, required: true, trim: true, trgm: true },
    description:  { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' },

    provider:        { type: String, enum: ['local', 's3', 'vimeo', 'youtube'], required: true, index: true },
    providerAssetId: { type: String, default: '' },     // Vimeo / YouTube video id
    storageKey:      { type: String, default: '' },
    playbackKey:     { type: String, default: '' },
    playbackType:    { type: String, enum: ['file', 'hls', 'embed'], default: 'file' },
    thumbnailKey:    { type: String, default: '' },

    durationSec: { type: Number, default: 0 },
    language:    { type: String, default: 'English', trim: true },
    subject:     { type: db.Types.UUID, ref: 'LmsSubject', default: null, index: true },
    tags:        { type: [String], default: [] },
    protection:  { type: String, enum: ['standard', 'strict'], default: 'strict' },

    processingStatus: { type: String, enum: ['draft', 'uploading', 'queued', 'processing', 'ready', 'failed'], default: 'draft', index: true },
    processingError:  { type: String, default: '' },
    processingJobId:  { type: String, default: '' },    // the provider's own job id (MediaConvert)

    originalFilename: { type: String, default: '' },
    mimeType:         { type: String, default: '' },
    sizeBytes:        { type: Number, default: 0 },
    uploadedAt:       { type: Date, default: null },

    isActive:  { type: Boolean, default: true, index: true },
    // The row in the retired `videos` table this was copied from (db/migrate.js).
    legacyVideoId: { type: db.Types.UUID, default: null },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('LmsVideo', LmsVideoSchema);
