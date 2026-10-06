const db = require('../db/orm');

/**
 * A health checkup of one student — general, vision, dental, hearing,
 * height/weight/BMI, blood pressure or a physical examination.
 *
 * `status: 'scheduled'` is a checkup booked ahead (a dental camp for Class VI
 * on the 15th), `completed` one with results. A checkup run for a whole class
 * shares a `sessionId`/`sessionName`, so the screens can show it as one camp.
 * Height and weight recorded here become the profile's latest measurements.
 */
const MedicalCheckupSchema = new db.Schema({
    school:  { type: db.Types.UUID, ref: 'School', required: true },
    student: { type: db.Types.UUID, ref: 'User', required: true },

    type: {
        type: String,
        enum: ['general', 'vision', 'dental', 'hearing', 'height', 'weight', 'bmi', 'bp', 'physical'],
        default: 'general',
    },
    status:      { type: String, enum: ['scheduled', 'completed', 'cancelled'], default: 'completed' },
    scheduledOn: { type: Date, default: null },
    checkedOn:   { type: Date, default: null },
    professional: { type: String, default: '', trim: true },
    sessionId:   { type: String, default: '' },
    sessionName: { type: String, default: '', trim: true },

    // { heightCm, weightKg, bmi, bpSystolic, bpDiastolic, pulse, visionLeft,
    //   visionRight, colourVision, hearingLeft, hearingRight, dental }
    results: { type: Object, default: {} },
    outcome: { type: String, enum: ['', 'normal', 'attention', 'referred'], default: '' },
    findings:        { type: String, default: '', trim: true },
    observations:    { type: String, default: '', trim: true },
    recommendations: { type: String, default: '', trim: true },
    followUp: {
        required: { type: Boolean, default: false },
        on:       { type: Date, default: null },
        note:     { type: String, default: '' },
        status:   { type: String, default: '' },
        doneAt:   { type: Date, default: null },
        doneBy:   { type: db.Types.UUID, ref: 'User', default: null },
        outcome:  { type: String, default: '' },
    },
    documents: { type: [db.Types.UUID], default: [] },

    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
    updatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    archivedAt:    { type: Date, default: null },
    archivedBy:    { type: db.Types.UUID, ref: 'User', default: null },
    archiveReason: { type: String, default: '' },
}, { timestamps: true });

MedicalCheckupSchema.index({ school: 1, student: 1 });
MedicalCheckupSchema.index({ school: 1, status: 1, scheduledOn: 1 });
MedicalCheckupSchema.index({ school: 1, checkedOn: -1 });

module.exports = db.model('MedicalCheckup', MedicalCheckupSchema);
