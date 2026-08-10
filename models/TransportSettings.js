const db = require('../db/orm');

// Per-school transport configuration (multi-timezone, notification prefs,
// attendance methods, geofencing, document reminders). One doc per school.
const TransportSettingsSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, unique: true, index: true },

    timezone: { type: String, default: 'Asia/Kolkata' },
    currency: { type: String, default: 'INR' },

    attendanceMethods: {
        type: [String],
        enum: ['rfid', 'qr', 'manual', 'face', 'biometric'],
        default: ['manual', 'qr'],
    },

    // Notification toggles (spec §19).
    notifyOnBoard: { type: Boolean, default: true },
    notifyOnDrop: { type: Boolean, default: true },
    notifyOnReachSchool: { type: Boolean, default: true },
    notifyOnDelay: { type: Boolean, default: true },
    notifyOnTripStart: { type: Boolean, default: false },
    delayThresholdMin: { type: Number, default: 10 },

    // Geofencing / route deviation (spec §9).
    geofenceRadiusM: { type: Number, default: 150 },
    deviationAlertM: { type: Number, default: 500 },

    // Document expiry reminders (spec §21).
    documentReminderDays: { type: Number, default: 30 },

    // Channels (SMS/Email/WhatsApp/Push) — integration flags (spec §25).
    channels: {
        sms: { type: Boolean, default: false },
        email: { type: Boolean, default: true },
        whatsapp: { type: Boolean, default: false },
        push: { type: Boolean, default: true },
    },
}, { timestamps: true });

module.exports = db.model('TransportSettings', TransportSettingsSchema);
