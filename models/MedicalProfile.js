const db = require('../db/orm');

/**
 * A student's medical profile (Medical Room, Oct 2026) — one row per student,
 * created the first time anyone opens or edits it.
 *
 * What is NOT here, on purpose: the blood group and the emergency contact.
 * Both already live on StudentProfile (the admission form collects them, the
 * ID card prints them), so the medical screens read and write them there and
 * there is only ever one answer. Allergies, conditions, vaccinations and the
 * rest are rows of their own, each with its own history.
 *
 * `privateNotes` is the medical staff's own — never sent to a teacher, a
 * student or a parent.
 */
const contact = {
    name:     { type: String, default: '', trim: true },
    phone:    { type: String, default: '', trim: true },
    relation: { type: String, default: '', trim: true },
};

const MedicalProfileSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    // The latest measurements — kept current by health checkups and visits
    // that weigh the student, so the profile always shows the newest reading.
    heightCm:   { type: Number, default: null },
    weightKg:   { type: Number, default: null },
    measuredOn: { type: Date, default: null },
    measuredBy: { type: String, default: '' },   // 'profile' | 'checkup' | 'visit'

    dietaryRestrictions: { type: String, default: '', trim: true },

    doctor:   {
        name:   { type: String, default: '', trim: true },
        phone:  { type: String, default: '', trim: true },
        clinic: { type: String, default: '', trim: true },
    },
    hospital: {
        name:    { type: String, default: '', trim: true },
        phone:   { type: String, default: '', trim: true },
        address: { type: String, default: '', trim: true },
    },
    // A second person to ring when neither parent nor the emergency contact
    // (StudentProfile) answers.
    alternateContact: contact,

    // What anyone looking after the child must know — shown on the emergency
    // profile and, for the child's own teachers, beside their alerts.
    instructions: { type: String, default: '', trim: true },

    // A child who must have a medicine to hand in an emergency — an adrenaline
    // auto-injector, a reliever inhaler, rescue medication for seizures.
    emergencyMedication: {
        required:     { type: Boolean, default: false },
        name:         { type: String, default: '', trim: true },
        location:     { type: String, default: '', trim: true },   // where it is kept
        instructions: { type: String, default: '', trim: true },
    },

    privateNotes: { type: String, default: '' },

    reviewedAt: { type: Date, default: null },
    // Leaving and keeping (services/medicalRetention): when the student was first seen to have
    // left, and a hold that stops the record being purged (a claim, an inquiry).
    leftOn:          { type: Date, default: null },
    legalHold:       { type: Boolean, default: false },
    legalHoldReason: { type: String, default: '' },
    reviewedBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy:  { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

MedicalProfileSchema.index({ school: 1, student: 1 }, { unique: true });

module.exports = db.model('MedicalProfile', MedicalProfileSchema);
