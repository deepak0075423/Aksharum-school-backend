const db = require('../db/orm');

// A hostel accommodation application (spec §8).
//
// Deliberately NOT a student record: `student` points at the existing User and
// every personal detail (DOB, blood group, parents) is read from StudentProfile.
// What lives here is only what is specific to this application.
const HostelAdmissionSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    applicationNumber: { type: String, default: '' },          // HA-YYMM-####

    student: { type: db.Types.UUID, ref: 'User', required: true, index: true },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', required: true, index: true },
    hostel: { type: db.Types.UUID, ref: 'Hostel', required: true, index: true },
    preferredRoomType: {
        type: String,
        enum: ['single', 'double', 'triple', 'four_bed', 'dormitory', 'custom', ''],
        default: '',
    },

    admissionDate: { type: Date, default: Date.now },
    joiningDate: { type: Date, default: null },
    expectedLeavingDate: { type: Date, default: null },
    reason: { type: String, default: '' },

    // Guardian & emergency contact default from StudentProfile at apply time and
    // are snapshotted here, because the hostel needs the number that was given
    // for THIS stay even if the family later edits the student record.
    guardianName: { type: String, default: '' },
    guardianPhone: { type: String, default: '' },
    guardianRelation: { type: String, default: '' },
    emergencyContactName: { type: String, default: '' },
    emergencyContactPhone: { type: String, default: '' },
    emergencyContactRelation: { type: String, default: '' },

    medicalInfo: { type: String, default: '' },
    specialRequirements: { type: String, default: '' },
    remarks: { type: String, default: '' },

    status: {
        type: String,
        enum: ['draft', 'applied', 'pending_approval', 'approved', 'rejected', 'waitlisted', 'cancelled', 'completed'],
        default: 'applied',
    },
    appliedBy: { type: db.Types.UUID, ref: 'User', default: null },
    appliedAt: { type: Date, default: Date.now },
    reviewedBy: { type: db.Types.UUID, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    decisionRemark: { type: String, default: '' },
    waitlistPosition: { type: Number, default: 0 },

    // Set once the approved application is turned into a bed allocation.
    allocation: { type: db.Types.UUID, ref: 'HostelAllocation', default: null },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelAdmissionSchema.index({ school: 1, status: 1, createdAt: -1 });
HostelAdmissionSchema.index({ school: 1, student: 1, academicYear: 1 });
HostelAdmissionSchema.index({ school: 1, hostel: 1, status: 1 });
// One live application per student per year — a rejected/cancelled one does not
// block re-applying, which is why the constraint is partial.
HostelAdmissionSchema.index(
    { student: 1, academicYear: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: ['draft', 'applied', 'pending_approval', 'approved'] } },
        name: 'unique_open_hostel_admission',
    },
);

module.exports = db.model('HostelAdmission', HostelAdmissionSchema);
