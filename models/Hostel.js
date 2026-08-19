const db = require('../db/orm');

// A hostel building complex (spec §4). Multiple hostels per school are supported;
// every downstream entity (building → floor → room → bed) hangs off this row and
// carries `school` too, so tenant isolation never depends on a join.
const HostelSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },
    campus: { type: String, default: '' },

    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },      // auto HL-YYMM-#### when blank
    hostelType: { type: String, enum: ['boys', 'girls', 'staff', 'other'], default: 'boys' },
    // Gender restriction enforced at allocation time. 'any' switches the check off.
    gender: { type: String, enum: ['male', 'female', 'co_ed', 'any'], default: 'male' },

    address: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    pincode: { type: String, default: '' },
    contactNumber: { type: String, default: '' },
    email: { type: String, default: '', lowercase: true, trim: true },

    // Declared capacity. The live figure is always counted from beds — this is
    // the admin's intended ceiling, checked before admissions are approved.
    capacity: { type: Number, default: 0 },

    // Existing employees (User, role teacher/school_admin). No staff master here.
    warden: { type: db.Types.UUID, ref: 'User', default: null },
    assistantWarden: { type: db.Types.UUID, ref: 'User', default: null },

    description: { type: String, default: '' },
    facilities: { type: [String], default: [] },             // wifi, laundry, gym…
    rules: { type: [String], default: [] },

    entryTime: { type: String, default: '' },                // "06:00"
    exitTime: { type: String, default: '' },                 // "21:00"
    curfewTime: { type: String, default: '' },               // "22:00"

    photos: { type: [String], default: [] },                 // uploads/hostel-docs filenames
    status: { type: String, enum: ['active', 'inactive', 'under_construction'], default: 'active' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

HostelSchema.index({ school: 1, code: 1 }, { unique: true });
HostelSchema.index({ school: 1, status: 1 });
HostelSchema.index({ school: 1, isActive: 1 });

module.exports = db.model('Hostel', HostelSchema);
