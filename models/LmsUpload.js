const db = require('../db/orm');

// One attempt at uploading a video file. `chunked` uploads (local disk) arrive
// in numbered parts, any of which may be sent again; `direct` uploads go from
// the browser straight to the provider with a short-lived signed address.
const LmsUploadSchema = new db.Schema({
    video:      { type: db.Types.UUID, ref: 'LmsVideo', required: true, index: true },
    provider:   { type: String, required: true },
    mode:       { type: String, enum: ['chunked', 'direct'], required: true },
    filename:   { type: String, default: '' },
    mimeType:   { type: String, default: '' },
    sizeBytes:  { type: Number, default: 0 },
    chunkSize:  { type: Number, default: 0 },
    totalChunks:    { type: Number, default: 0 },
    receivedChunks: { type: [Number], default: [] },
    storageKey: { type: String, default: '' },
    clientDurationSec: { type: Number, default: 0 },   // read from the file by the uploader's browser
    status:     { type: String, enum: ['open', 'completed', 'aborted', 'failed'], default: 'open', index: true },
    error:      { type: String, default: '' },
    expiresAt:  { type: Date, default: null },
    createdBy:  { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('LmsUpload', LmsUploadSchema);
