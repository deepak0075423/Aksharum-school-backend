const db = require('../db/orm');
const bcrypt = require('bcryptjs');

const UserSchema = new db.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
    },
    password: {
        type: String,
        required: true,
    },
    role: {
        type: String,
        enum: ['super_admin', 'school_admin', 'teacher', 'student', 'parent'],
        required: true,
    },
    school: {
        type: db.Types.UUID,
        ref: 'School',
        default: null,
    },
    phone: {
        type: String,
        default: '',
    },
    profileImage: {
        type: String,
        default: '',
    },
    profileIcon: {
        type: String,
        default: '',
    },
    isFirstLogin: {
        type: Boolean,
        default: true,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    // Presence — refreshed by the client heartbeat; "online" = within ~60s
    lastSeenAt: {
        type: Date,
        default: null,
    },
    createdBy: {
        type: db.Types.UUID,
        ref: 'User',
        default: null,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    // Password reset OTP
    otp: {
        type: String,
        default: null,
    },
    otpExpiry: {
        type: Date,
        default: null,
    },
    // One-time magic login token
    loginToken: {
        type: String,
        default: null,
    },
    loginTokenExpiry: {
        type: Date,
        default: null,
    },
});


// Compare passwords
UserSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// Every admin list page (Students/Teachers/Admins) filters {school, role}
UserSchema.index({ school: 1, role: 1 });

module.exports = db.model('User', UserSchema);
