const db = require('../db/orm');
const bcrypt = require('bcryptjs');

const UserSchema = new db.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    // Deliberately NOT unique on its own — see services/accountIdentity.js. One
    // address is one person, and a person can hold several posts: a teacher at
    // two schools, a teacher who is also a parent, a parent with children at
    // three schools. Each of those is a row here; what has to stay unique is the
    // post, not the address (the compound index at the bottom of this file,
    // which leads with `email` and so also serves the lookup that resolves an
    // address to every post behind it).
    email: {
        type: String,
        required: true,
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
    // Password reset: the token exchanged for the OTP above. Held on every row
    // of the address, because a reset is a reset of the person's one password.
    resetToken: {
        type: String,
        default: null,
    },
    resetTokenExpiry: {
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

// One post per person per school. The same address may appear again for another
// role here (teacher + parent) or for the same role elsewhere (a teacher at two
// schools), but never twice for the same role in the same school — that is what
// stops two admins racing to add the same teacher from producing two accounts.
UserSchema.index({ email: 1, school: 1, role: 1 }, { unique: true });

module.exports = db.model('User', UserSchema);
