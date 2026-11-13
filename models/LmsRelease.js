const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  A teacher opening content to the students of ONE section.
//
//  level    book     every chapter of the book and every video in them
//           chapter  every video of one chapter
//           video    one video of one chapter (`chapterVideo`) and nothing else
//  audience all      the section, whoever is in it on the day they look
//           selected the students listed in `students`
//
//  status   scheduled   releaseAt is ahead
//           active      open (until `expiresAt`, when there is one)
//           expired     its expiry passed
//           unpublished the teacher took it down; may be published again
//           revoked     access withdrawn for good
//
//  Access is decided from releaseAt / expiresAt at the moment of asking
//  (services/lms/access), so a scheduled release opens on time whether or not
//  the sweep has got to it; the sweep moves the status and tells the students.
//  Rows are never deleted, and taking a release down never touches what its
//  students had already watched (LmsProgress).
// ─────────────────────────────────────────────────────────────────────────────
const LmsReleaseSchema = new db.Schema({
    school:        { type: db.Types.UUID, ref: 'School', required: true, index: true },
    academicYear:  { type: db.Types.UUID, ref: 'AcademicYear', required: true, index: true },
    class:         { type: db.Types.UUID, ref: 'Class', required: true },
    section:       { type: db.Types.UUID, ref: 'ClassSection', required: true, index: true },
    schoolSubject: { type: db.Types.UUID, ref: 'Subject', required: true },
    lmsSubject:    { type: db.Types.UUID, ref: 'LmsSubject', required: true },
    assignment:    { type: db.Types.UUID, ref: 'LmsBookAssignment', required: true, index: true },
    book:          { type: db.Types.UUID, ref: 'LmsBook', required: true, index: true },

    level:        { type: String, enum: ['book', 'chapter', 'video'], required: true },
    chapter:      { type: db.Types.UUID, ref: 'LmsChapter', default: null, index: true },
    chapterVideo: { type: db.Types.UUID, ref: 'LmsChapterVideo', default: null, index: true },
    video:        { type: db.Types.UUID, ref: 'LmsVideo', default: null },

    audience: { type: String, enum: ['all', 'selected'], default: 'all' },
    students: { type: [db.Types.UUID], default: [] },

    releaseAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    status:    { type: String, enum: ['scheduled', 'active', 'expired', 'unpublished', 'revoked'], default: 'active', index: true },
    note:      { type: String, default: '' },

    availableNotifiedAt: { type: Date, default: null },
    unpublishedAt: { type: Date, default: null },
    revokedAt:     { type: Date, default: null },
    revokedBy:     { type: db.Types.UUID, ref: 'User', default: null },
    revokeReason:  { type: String, default: '' },
    reReleaseOf:   { type: db.Types.UUID, ref: 'LmsRelease', default: null },

    createdBy: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

LmsReleaseSchema.index({ section: 1, status: 1, releaseAt: 1 });
LmsReleaseSchema.index({ status: 1, releaseAt: 1 });

module.exports = db.model('LmsRelease', LmsReleaseSchema);
