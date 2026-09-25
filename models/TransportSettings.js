const db = require('../db/orm');

// Per-school transport configuration. One doc per school; every tab of the
// admin Settings screen writes into this one record.
//
// The original file held only the notification/geofence/document flags the
// first build needed. The Sep 2026 redesign's Settings screen has eleven tabs,
// and a switch that is drawn but not read is worse than no switch at all, so
// every field below is consumed somewhere: the name of the consumer is on the
// line. Anything the module cannot honour yet is NOT in this schema.
const TransportSettingsSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, unique: true, index: true },

    // ── General ──────────────────────────────────────────────────────────────
    // Transport's own contact details — printed on invoices and shown to
    // parents, and deliberately separate from the school's front-office ones.
    contactEmail: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    officeAddress: { type: String, default: '' },
    schoolLatitude: { type: Number, default: null },
    schoolLongitude: { type: Number, default: null },
    timezone: { type: String, default: 'Asia/Kolkata' },
    currency: { type: String, default: 'INR' },
    academicYear: { type: db.Types.UUID, ref: 'AcademicYear', default: null },
    distanceUnit: { type: String, enum: ['km', 'mi'], default: 'km' },   // every distance the UI prints
    timeFormat: { type: String, enum: ['12h', '24h'], default: '12h' },  // every clock the UI prints
    allowParentTracking: { type: Boolean, default: true },               // portal: live map on/off
    autoAssignStudents: { type: Boolean, default: false },               // assignment: nearest-stop suggestion

    // ── Routes ───────────────────────────────────────────────────────────────
    defaultGeofenceRadiusM: { type: Number, default: 150 },   // new route's geofenceRadiusM
    geofenceRadiusM: { type: Number, default: 150 },          // live map: inside/outside test
    deviationAlertM: { type: Number, default: 500 },          // live map: route-deviation alert
    maxStopsPerRoute: { type: Number, default: 25 },          // route editor validation
    stopDwellMinutes: { type: Number, default: 2 },           // ETA maths between stops
    averageSpeedKmph: { type: Number, default: 25 },          // ETA maths when GPS has no speed
    requireStopCoordinates: { type: Boolean, default: false }, // route editor validation

    // ── Vehicles ─────────────────────────────────────────────────────────────
    maxStudentsPerBus: { type: Number, default: 60 },         // assignment capacity check
    allowOverbooking: { type: Boolean, default: false },      // assignment capacity check
    documentReminderDays: { type: Number, default: 30 },      // renewals widgets + alerts
    serviceDueDays: { type: Number, default: 7 },             // maintenance "due soon"
    serviceIntervalKm: { type: Number, default: 5000 },       // maintenance next-due odometer
    lowMileageThreshold: { type: Number, default: 4 },        // fuel alert: km/l floor
    fuelSpikePct: { type: Number, default: 20 },              // fuel alert: % over vehicle average
    missingFuelEntryDays: { type: Number, default: 7 },       // fuel alert: silent vehicle

    // ── Drivers & crew ───────────────────────────────────────────────────────
    licenceReminderDays: { type: Number, default: 30 },       // staff document status
    requirePoliceVerification: { type: Boolean, default: true },
    requireMedicalCertificate: { type: Boolean, default: true },
    maxTripsPerDriverPerDay: { type: Number, default: 4 },    // trip scheduling guard
    driverAppEnabled: { type: Boolean, default: false },      // exposes the driver console

    // ── Trips ────────────────────────────────────────────────────────────────
    autoGenerateTrips: { type: Boolean, default: false },     // nightly sweep in server.js
    generateDaysAhead: { type: Number, default: 1 },
    skipWeekends: { type: Boolean, default: true },
    skipHolidays: { type: Boolean, default: true },
    requireTripApproval: { type: Boolean, default: false },   // trip must be approved before start
    earlyArrivalBufferMin: { type: Number, default: 5 },      // on-time window, early side
    delayThresholdMin: { type: Number, default: 10 },         // on-time window, late side ("Late Arrival")
    attendanceMethods: {
        type: [String],
        enum: ['rfid', 'qr', 'manual', 'face', 'biometric'],
        default: ['manual', 'qr'],
    },
    autoMarkAbsentAfterMin: { type: Number, default: 0 },     // 0 = never

    // ── Fees & billing ───────────────────────────────────────────────────────
    invoiceDueDay: { type: Number, default: 10 },             // day of month invoices fall due
    autoGenerateInvoices: { type: Boolean, default: false },  // monthly sweep in server.js
    invoicePrefix: { type: String, default: 'TF' },
    lateFeePerDay: { type: Number, default: 0 },              // applied when a plan has none
    lateFeeGraceDays: { type: Number, default: 0 },
    siblingDiscountPct: { type: Number, default: 0 },
    reminderDaysBeforeDue: { type: Number, default: 3 },
    stopServiceOnNonPayment: { type: Boolean, default: false },

    // ── Notifications (spec §19) ─────────────────────────────────────────────
    notifyOnTripStart: { type: Boolean, default: false },
    notifyOnBoard: { type: Boolean, default: true },
    notifyOnDrop: { type: Boolean, default: true },
    notifyOnReachSchool: { type: Boolean, default: true },
    notifyOnDelay: { type: Boolean, default: true },
    notifyOnIncident: { type: Boolean, default: true },
    notifyOnMaintenanceDue: { type: Boolean, default: true },
    notifyOnInvoice: { type: Boolean, default: true },
    channels: {
        sms: { type: Boolean, default: false },
        email: { type: Boolean, default: true },
        whatsapp: { type: Boolean, default: false },
        push: { type: Boolean, default: true },
    },

    // ── Integrations / tracking ──────────────────────────────────────────────
    trackingIntervalSec: { type: Number, default: 30 },       // live map poll + device push rate
    showLiveLocationToParents: { type: Boolean, default: true },
    showEtaToParents: { type: Boolean, default: true },
    storeLocationHistory: { type: Boolean, default: true },
    locationRetentionDays: { type: Number, default: 180 },    // trail pruning
    gpsProvider: { type: String, default: '' },               // free text; no vendor is wired
    // A real street map by default — a drawn grid with no streets on it is not
    // a map, and picking a place on one is guesswork. OpenFreeMap serves
    // OpenStreetMap data as vector tiles with no key and no usage limit;
    // 'builtin' is the opt-out for a school that would rather send no
    // coordinates to anyone.
    mapProvider: { type: String, enum: ['openfreemap', 'builtin', 'osm', 'google'], default: 'openfreemap' },
    mapApiKey: { type: String, default: '' },

    // ── User access ──────────────────────────────────────────────────────────
    // Which roles may see which part of the module. Enforced by the portal
    // controller, not decoration.
    parentCanRaiseRequest: { type: Boolean, default: true },
    parentCanRaiseComplaint: { type: Boolean, default: true },
    studentCanViewRoute: { type: Boolean, default: true },
    teacherCanViewTrips: { type: Boolean, default: false },

    // ── Appearance ───────────────────────────────────────────────────────────
    moduleName: { type: String, default: 'Transport' },       // rail + header wording
    primaryColor: { type: String, default: '#4f46e5' },       // module accent
    showInMainMenu: { type: Boolean, default: true },

    // ── Data & backup ────────────────────────────────────────────────────────
    lastBackupAt: { type: Date, default: null },
    autoBackup: { type: Boolean, default: false },
    backupFrequency: { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'weekly' },
}, { timestamps: true });

module.exports = db.model('TransportSettings', TransportSettingsSchema);
