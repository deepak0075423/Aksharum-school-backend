const db = require('../db/orm');

// An incident report (spec §22). Also carries the medical/emergency events of
// spec §21 under the 'medical_emergency' type, so one timeline covers everything
// that happened to a resident. Clinical baseline data (blood group, allergies,
// medical certificates) is read from StudentProfile and never copied here.
const HostelIncidentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    room: { type: db.Types.UUID, ref: 'HostelRoom', default: null },

    incidentNumber: { type: String, default: '' },             // HI-YYMM-####
    // Primary subject; `involvedStudents` covers everyone else in the event.
    student: { type: db.Types.UUID, ref: 'User', default: null, index: true },
    involvedStudents: { type: [db.Types.UUID], ref: 'User', default: [] },

    incidentType: {
        type: String,
        enum: ['misconduct', 'fighting', 'theft', 'property_damage', 'security',
               'medical_emergency', 'rule_violation', 'other'],
        default: 'other',
    },
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'low' },
    date: { type: Date, required: true, default: Date.now },
    time: { type: String, default: '' },                       // "22:40"
    location: { type: String, default: '' },
    description: { type: String, required: true },
    witnesses: { type: [String], default: [] },

    reportedBy: { type: db.Types.UUID, ref: 'User', default: null },
    reportedByName: { type: String, default: '' },
    assignedOfficer: { type: db.Types.UUID, ref: 'User', default: null },
    actionTaken: { type: String, default: '' },
    attachments: { type: [String], default: [] },

    // ── Medical / emergency detail (spec §21) ───────────────────────────────
    // Populated only for medical incidents; the fields are inert otherwise.
    medicalCategory: {
        type: String,
        enum: ['first_aid', 'doctor_visit', 'hospital_visit', 'ambulance', 'medication', ''],
        default: '',
    },
    treatmentGiven: { type: String, default: '' },
    hospitalName: { type: String, default: '' },
    doctorName: { type: String, default: '' },
    transportArranged: { type: Boolean, default: false },
    parentNotifiedAt: { type: Date, default: null },

    status: {
        type: String,
        enum: ['reported', 'investigating', 'action_taken', 'resolved', 'closed'],
        default: 'reported',
    },
    resolvedAt: { type: Date, default: null },
}, { timestamps: true });

HostelIncidentSchema.index({ school: 1, status: 1, date: -1 });
HostelIncidentSchema.index({ school: 1, hostel: 1, date: -1 });
HostelIncidentSchema.index({ school: 1, student: 1, date: -1 });
HostelIncidentSchema.index({ school: 1, incidentType: 1, date: -1 });

module.exports = db.model('HostelIncident', HostelIncidentSchema);
