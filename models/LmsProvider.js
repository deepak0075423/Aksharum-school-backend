const db = require('../db/orm');

// ─────────────────────────────────────────────────────────────────────────────
//  Video Learning — how one storage / streaming provider is set up.
//
//  settings   what is safe to show: bucket, region, CDN domain, key-pair id …
//  secrets    access keys, the CloudFront private key, the Vimeo token — each
//             value sealed (AES-256-GCM, services/lms/secrets) before it is
//             stored. No API ever returns one; the screens are told only
//             whether it is set. An environment variable of the same purpose
//             wins over a stored value (docs/video-learning.md).
// ─────────────────────────────────────────────────────────────────────────────
const LmsProviderSchema = new db.Schema({
    provider:  { type: String, enum: ['local', 's3', 'vimeo', 'youtube'], required: true, unique: true },
    enabled:   { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },     // where a new file upload goes
    settings:  { type: db.Types.JSON, default: {} },
    secrets:   { type: db.Types.JSON, default: {} },
    lastCheckedAt:    { type: Date, default: null },
    lastCheckOk:      { type: Boolean, default: null },
    lastCheckMessage: { type: String, default: '' },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('LmsProvider', LmsProviderSchema);
