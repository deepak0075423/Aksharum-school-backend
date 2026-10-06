const db = require('../db/orm');

/**
 * The server's own Web Push keys (VAPID), made once and kept here so every
 * server and every restart signs pushes with the same pair — a browser's
 * subscription is tied to the public key it subscribed with. Set
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in the environment to use your own
 * pair instead (services/pushService).
 */
const PushConfigSchema = new db.Schema({
    name:       { type: String, required: true },     // 'vapid'
    publicKey:  { type: String, default: '' },
    privateKey: { type: String, default: '' },
}, { timestamps: true });

PushConfigSchema.index({ name: 1 }, { unique: true });

module.exports = db.model('PushConfig', PushConfigSchema);
