const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  Video — the single source of truth in the Master Video Library.
//  A video is stored ONCE and reused across thousands of schools via mappings
//  (VideoTaxonomy) and per-school enablement (SchoolVideo). We never duplicate
//  the underlying media; "Duplicate Video" clones metadata into a new version.
//
//  scope:
//    'master' → uploaded by a Super Admin, global, school = null.
//    'school' → added by a school teacher/admin (YouTube/Vimeo only), scoped
//               to one school, goes through the approval workflow.
// ─────────────────────────────────────────────────────────────────────────────
const VideoSchema = new db.Schema({
    scope:  { type: String, enum: ['master', 'school'], default: 'master', index: true },
    school: { type: db.Types.UUID, ref: 'School', default: null, index: true },

    // ── Identity ──────────────────────────────────────────────────────────────
    title:            { type: String, required: true, trim: true },
    slug:             { type: String, default: '', index: true },   // SEO slug, unique per scope (enforced in controller)
    shortDescription: { type: String, default: '' },
    longDescription:  { type: String, default: '' },

    // ── Source & media ──────────────────────────────────────────────────────────
    source:    { type: String, enum: ['s3', 'youtube', 'vimeo'], required: true, index: true },
    sourceUrl: { type: String, default: '' },   // youtube/vimeo watch url or external url
    providerId:{ type: String, default: '' },   // youtube video id / vimeo id (parsed)
    s3Bucket:  { type: String, default: '' },
    s3Key:     { type: String, default: '' },   // object key when source = s3
    renditions:{ type: [db.Types.JSON], default: [] }, // [{ quality:'720p', key, url, sizeBytes }]

    thumbnailUrl: { type: String, default: '' },
    thumbnailKey: { type: String, default: '' },

    durationSec:          { type: Number, default: 0 },
    estimatedStudyTimeMin:{ type: Number, default: 0 },

    // ── Pedagogy / classification ───────────────────────────────────────────────
    difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced'], default: 'beginner' },
    category:   {
        type: String,
        enum: [
            'concept_explanation', 'revision', 'animation', 'practical', 'experiment',
            'homework', 'assignment', 'activity', 'quiz', 'sample_paper',
            'previous_year_questions', 'olympiad', 'neet', 'jee', 'motivational',
            'career_guidance', 'lab_session', 'teacher_recording', 'live_class_recording',
        ],
        default: 'concept_explanation',
        index: true,
    },
    // Primary language/medium are denormalized for quick display/filter; the full
    // multi-value mapping lives in VideoTaxonomy (a video may serve many languages).
    language: { type: String, default: 'English' },
    medium:   { type: String, default: 'English' },

    learningOutcome: { type: String, default: '' },
    teacherNotes:    { type: String, default: '' },
    keywords:        { type: [String], default: [] },
    tags:            { type: [String], default: [] },

    transcript:      { type: String, default: '' },
    hasClosedCaption:{ type: Boolean, default: false },

    // ── Delivery / playback policy ──────────────────────────────────────────────
    downloadAllowed: { type: Boolean, default: false },
    streamingQuality:{ type: String, enum: ['auto', '360p', '480p', '720p', '1080p', '4k'], default: 'auto' },
    watermarkEnabled:{ type: Boolean, default: true },

    // ── Lifecycle ───────────────────────────────────────────────────────────────
    visibility: { type: String, enum: ['public', 'restricted', 'private'], default: 'restricted' },
    status:     { type: String, enum: ['draft', 'scheduled', 'published', 'archived'], default: 'draft', index: true },

    approvalStatus: { type: String, enum: ['not_required', 'pending', 'approved', 'rejected'], default: 'not_required', index: true },
    approvedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    approvedAt:     { type: Date, default: null },
    rejectionReason:{ type: String, default: '' },

    publishedAt: { type: Date, default: null },
    scheduledAt: { type: Date, default: null },
    expiryAt:    { type: Date, default: null },

    featured:      { type: Boolean, default: false, index: true },
    trending:      { type: Boolean, default: false },
    trendingScore: { type: Number, default: 0 },

    // ── Denormalized counters (kept in sync on interaction/progress events) ──────
    viewsCount:      { type: Number, default: 0 },
    uniqueViewsCount:{ type: Number, default: 0 },
    likesCount:      { type: Number, default: 0 },
    dislikesCount:   { type: Number, default: 0 },
    avgWatchPercent: { type: Number, default: 0 },

    // ── Versioning & provenance ─────────────────────────────────────────────────
    version:        { type: Number, default: 1 },
    originalVideoId:{ type: db.Types.UUID, ref: 'Video', default: null }, // set on Duplicate
    createdBy:      { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:      { type: db.Types.UUID, ref: 'User', default: null },

    // ── Soft delete ─────────────────────────────────────────────────────────────
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

// Full-text-ish search over title/keywords via $text → ILIKE (ORM maps text idx).
VideoSchema.index({ title: 'text' });
VideoSchema.index({ scope: 1, status: 1 });
VideoSchema.index({ status: 1, publishedAt: 1 });   // scheduler + published lists
VideoSchema.index({ school: 1, approvalStatus: 1 }); // school approval queue

module.exports = db.model('Video', VideoSchema);
