const db = require('../db/orm');

// One entry in a course outline. Items are grouped into named sections
// (sectionTitle/sectionSequence) and ordered within them (sequence). An item is
// either a whole playlist or a single video.
const VideoCourseItemSchema = new db.Schema({
    course:          { type: db.Types.UUID, ref: 'VideoCourse', required: true, index: true },
    sectionTitle:    { type: String, default: 'Section 1' },
    sectionSequence: { type: Number, default: 0 },

    itemType: { type: String, enum: ['playlist', 'video'], required: true },
    playlist: { type: db.Types.UUID, ref: 'VideoPlaylist', default: null },
    video:    { type: db.Types.UUID, ref: 'Video', default: null },

    sequence:    { type: Number, default: 0 },
    isMandatory: { type: Boolean, default: true },
}, { timestamps: true });

VideoCourseItemSchema.index({ course: 1, sectionSequence: 1, sequence: 1 });

module.exports = db.model('VideoCourseItem', VideoCourseItemSchema);
