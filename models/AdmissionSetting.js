const db = require('../db/orm');

/**
 * One row per school: how its admission portal looks and how its admission
 * process runs. Every block below is validated JSON (services/admission/
 * settings.js owns the shape and the defaults), so a school's configuration is
 * data the engine reads — never code it runs.
 *
 *   slug        the portal's address — app.aksharum.com/<slug>. Unique across
 *               the platform (partial unique index in db/migrate.js); blank
 *               until the school picks one.
 *   portal      branding, landing content, contact, notices, privacy text
 *   numbering   application / receipt / admit-card / offer number templates
 *   security    OTP expiry, resend cooldown and attempts, inside platform limits
 *   applications  limits, reapplying, fee timing, draft migration policy
 *   workflow    which stages run, in what order, who handles them
 *   selection   merit defaults, waiting-list promotion, offer validity
 *   fees        waiver categories, receipt note
 *   conversion  what "Confirm admission" creates and when accounts open
 *   email       reply-to, reminder timings
 *   compliance  the RTE Act's bar on screening: which classes it covers, or why it does not apply
 *   privacy     retention periods, the privacy contact, how fast data requests are answered
 *   visits      campus visits families book from the portal
 *   appeals     re-checks of results and appeals against decisions: windows and answer time
 *   digilocker  whether families may fetch documents from DigiLocker, and whether those are verified at once
 */
const AdmissionSettingSchema = new db.Schema({
    school:       { type: db.Types.UUID, ref: 'School', required: true, unique: true },
    slug:         { type: String, trim: true, lowercase: true, default: '' },
    portal:       { type: db.Types.JSON, default: () => ({}) },
    numbering:    { type: db.Types.JSON, default: () => ({}) },
    security:     { type: db.Types.JSON, default: () => ({}) },
    applications: { type: db.Types.JSON, default: () => ({}) },
    workflow:     { type: db.Types.JSON, default: () => ({}) },
    selection:    { type: db.Types.JSON, default: () => ({}) },
    fees:         { type: db.Types.JSON, default: () => ({}) },
    conversion:   { type: db.Types.JSON, default: () => ({}) },
    email:        { type: db.Types.JSON, default: () => ({}) },
    compliance:   { type: db.Types.JSON, default: () => ({}) },
    privacy:      { type: db.Types.JSON, default: () => ({}) },
    visits:       { type: db.Types.JSON, default: () => ({}) },
    appeals:      { type: db.Types.JSON, default: () => ({}) },
    digilocker:   { type: db.Types.JSON, default: () => ({}) },
    updatedBy:    { type: db.Types.UUID, ref: 'User', default: null },
}, { timestamps: true });

module.exports = db.model('AdmissionSetting', AdmissionSettingSchema);
