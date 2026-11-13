const db = require('../db/orm');

// Background work for a video (services/lms/jobs): checking the uploaded file,
// reading its length, making streaming formats and a thumbnail where the
// provider can. A job is claimed before it is run, so two servers never do it
// twice; one that fails is tried again later, up to `maxAttempts`.
const LmsJobSchema = new db.Schema({
    type:        { type: String, enum: ['process_video'], required: true },
    video:       { type: db.Types.UUID, ref: 'LmsVideo', required: true, index: true },
    status:      { type: String, enum: ['queued', 'running', 'waiting', 'done', 'failed'], default: 'queued', index: true },
    attempts:    { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    runAfter:    { type: Date, default: Date.now },
    lockedAt:    { type: Date, default: null },
    externalId:  { type: String, default: '' },
    lastError:   { type: String, default: '' },
    result:      { type: db.Types.JSON, default: {} },
}, { timestamps: true });

LmsJobSchema.index({ status: 1, runAfter: 1 });

module.exports = db.model('LmsJob', LmsJobSchema);
