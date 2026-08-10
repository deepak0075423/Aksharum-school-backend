const db = require('../db/orm');

// Accident / breakdown / safety incident report (spec §17).
const TransportIncidentSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    incidentCode: { type: String, default: '' },             // INC-YYMM-####
    vehicle: { type: db.Types.UUID, ref: 'Vehicle', default: null },
    trip: { type: db.Types.UUID, ref: 'TransportTrip', default: null },
    driver: { type: db.Types.UUID, ref: 'TransportStaff', default: null },

    date: { type: Date, default: Date.now },
    type: { type: String, enum: ['accident', 'breakdown', 'medical', 'safety', 'fire', 'other'], default: 'accident' },
    severity: { type: String, enum: ['minor', 'major', 'critical'], default: 'minor' },

    location: {
        address: { type: String, default: '' },
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
    },
    description: { type: String, required: true },
    studentsInvolved: [{
        student: { type: db.Types.UUID, ref: 'User' },
        note: { type: String, default: '' },
    }],
    photos: { type: [String], default: [] },

    insuranceClaim: {
        claimNumber: { type: String, default: '' },
        status: { type: String, enum: ['none', 'filed', 'approved', 'rejected', 'settled'], default: 'none' },
        amount: { type: Number, default: 0 },
    },
    policeReport: {
        filed: { type: Boolean, default: false },
        firNumber: { type: String, default: '' },
        station: { type: String, default: '' },
    },
    repairCost: { type: Number, default: 0 },
    actionsTaken: { type: String, default: '' },

    status: { type: String, enum: ['reported', 'investigating', 'resolved', 'closed'], default: 'reported' },
    reportedBy: { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

TransportIncidentSchema.index({ school: 1, status: 1, date: -1 });
TransportIncidentSchema.index({ school: 1, vehicle: 1 });

module.exports = db.model('TransportIncident', TransportIncidentSchema);
