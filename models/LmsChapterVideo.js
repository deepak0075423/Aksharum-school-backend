const db = require('../db/orm');

// Chapter ↔ video. This row — not the video — is what a teacher releases and a
// student watches, so the same video in two books is two rows with their own
// order, their own releases and their own progress.
const LmsChapterVideoSchema = new db.Schema({
    chapter:      { type: db.Types.UUID, ref: 'LmsChapter', required: true, index: true },
    book:         { type: db.Types.UUID, ref: 'LmsBook', required: true, index: true },   // the chapter's book, kept beside it for joins
    video:        { type: db.Types.UUID, ref: 'LmsVideo', required: true, index: true },
    displayOrder: { type: Number, default: 0 },
    isActive:     { type: Boolean, default: true },
    createdBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

LmsChapterVideoSchema.index({ chapter: 1, video: 1 }, { unique: true });

module.exports = db.model('LmsChapterVideo', LmsChapterVideoSchema);
