const db = require('../db/orm');

// A visitor registration + gate pass (spec §13). The same row carries the
// approval, the pass and the entry/exit stamps, so a visit is one auditable
// object rather than three loosely-linked ones.
const HostelVisitorSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },

    passNumber: { type: String, default: '' },                 // VP-YYMMDD-####
    visitorName: { type: String, required: true, trim: true },
    mobile: { type: String, default: '' },
    relationship: { type: String, default: '' },
    purpose: { type: String, default: '' },
    visitorCount: { type: Number, default: 1 },

    idProofType: { type: String, enum: ['aadhaar', 'pan', 'driving_license', 'voter_id', 'passport', 'other', ''], default: '' },
    idProofNumber: { type: String, default: '' },
    photo: { type: String, default: '' },                      // uploads/hostel-docs filename

    scheduledAt: { type: Date, default: null },
    entryTime: { type: Date, default: null },
    exitTime: { type: Date, default: null },

    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'checked_in', 'checked_out', 'cancelled', 'blocked'],
        default: 'pending',
    },
    approvedBy: { type: db.Types.UUID, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
    remarks: { type: String, default: '' },

    // Standing lists (spec §13): authorised visitors skip approval, restricted
    // ones are refused at the gate. Both are per student.
    listType: { type: String, enum: ['none', 'authorized', 'restricted'], default: 'none' },
    isTemplate: { type: Boolean, default: false },             // a list entry, not a visit
    qrToken: { type: String, default: '' },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelVisitorSchema.index({ school: 1, status: 1, createdAt: -1 });
HostelVisitorSchema.index({ school: 1, student: 1, createdAt: -1 });
HostelVisitorSchema.index({ school: 1, hostel: 1, isTemplate: 1, listType: 1 });
HostelVisitorSchema.index({ qrToken: 1 });

module.exports = db.model('HostelVisitor', HostelVisitorSchema);
