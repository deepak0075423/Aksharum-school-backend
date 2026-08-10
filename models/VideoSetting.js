const db = require('../db/orm');

// Per-school configuration for the Video Learning module (one row per school).
const VideoSettingSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, unique: true },

    enableMasterLibrary: { type: Boolean, default: true },  // school may browse & enable master videos
    defaultVisibility:   { type: String, enum: ['school', 'class', 'section'], default: 'school' },

    teacherUploadEnabled:         { type: Boolean, default: true },
    teacherUploadRequiresApproval:{ type: Boolean, default: true },
    allowedTeacherSources:        { type: [String], default: ['youtube', 'vimeo'] },

    allowStudentDownload:   { type: Boolean, default: false },
    allowStudentSharing:    { type: Boolean, default: false },
    allowPlaybackSpeed:     { type: Boolean, default: true },

    watermarkEnabled: { type: Boolean, default: true },
    watermarkText:    { type: String, default: '' },  // defaults to student name + id at play time
    antiScreenRecordingHint: { type: Boolean, default: true },

    notifyOnAssign:   { type: Boolean, default: true },
    notifyByEmail:    { type: Boolean, default: false },
}, { timestamps: true });

module.exports = db.model('VideoSetting', VideoSettingSchema);
