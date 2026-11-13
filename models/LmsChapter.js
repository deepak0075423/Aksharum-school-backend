const db = require('../db/orm');

// A chapter of ONE book. Each book has its own chapter list; a chapter may have
// no videos yet — they are mapped later (LmsChapterVideo).
const LmsChapterSchema = new db.Schema({
    book:             { type: db.Types.UUID, ref: 'LmsBook', required: true, index: true },
    title:            { type: String, required: true, trim: true },
    chapterNumber:    { type: Number, required: true },
    description:      { type: String, default: '' },
    thumbnailUrl:     { type: String, default: '' },
    estimatedMinutes: { type: Number, default: 0 },
    displayOrder:     { type: Number, default: 0 },
    status:           { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    createdBy:        { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:        { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

LmsChapterSchema.index({ book: 1, chapterNumber: 1 }, { unique: true });
LmsChapterSchema.index({ book: 1, displayOrder: 1 });

module.exports = db.model('LmsChapter', LmsChapterSchema);
