const db = require('../db/orm');

/**
 * A phone or a browser that shows its person's notifications as the operating
 * system's own — in the tray, on the lock screen — even when the app is closed
 * (Oct 2026; services/pushService):
 *
 *   expo  the phone app's Expo push token (Expo's push service hands it to
 *         Firebase on Android and to Apple on iPhones)
 *   web   a browser's Web Push subscription — { endpoint, keys } — shown by
 *         school-frontend/public/push-sw.js
 *
 * One row per device: `key` is the token or the endpoint, and the device
 * belongs to whoever signed in on it last. Signing out removes it; a device
 * the push service says no longer exists is forgotten.
 */
const PushDeviceSchema = new db.Schema({
    user:   { type: db.Types.UUID, ref: 'User', required: true },
    school: { type: db.Types.UUID, ref: 'School', default: null },
    kind:   { type: String, enum: ['expo', 'web'], required: true },
    key:    { type: String, required: true },          // the Expo token, or the Web Push endpoint
    subscription: { type: Object, default: null },     // web: { endpoint, keys: { p256dh, auth } }
    platform:   { type: String, default: '' },          // ios | android | web
    deviceName: { type: String, default: '', trim: true },
    appVersion: { type: String, default: '', trim: true },
    lastSeenAt: { type: Date, default: null },
    lastError:  { type: String, default: '' },
}, { timestamps: true });

PushDeviceSchema.index({ key: 1 }, { unique: true });
PushDeviceSchema.index({ user: 1 });

module.exports = db.model('PushDevice', PushDeviceSchema);
