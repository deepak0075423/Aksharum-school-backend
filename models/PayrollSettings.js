const db = require('../db/orm');

/**
 * One row per school. Everything the payroll engine used to hard-code.
 *
 * The working-days basis matters most: the old engine divided by a literal 26
 * whatever the month, so a February loss-of-pay day cost the same as a March
 * one and neither matched the school's own calendar.
 */
const PayrollSettingsSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, unique: true },

    /**
     * 'fixed'    — always `fixedWorkingDays` (the classic 26-day month)
     * 'calendar' — the number of days in the month
     * 'school'   — days in the month minus Sundays, other configured weekly
     *              offs and school holidays (reads the Holiday module when the
     *              school has it on, and falls back to 'calendar' when it does not)
     */
    workingDaysBasis:  { type: String, enum: ['fixed', 'calendar', 'school'], default: 'fixed' },
    fixedWorkingDays:  { type: Number, default: 26 },
    weeklyOffs:        { type: [Number], default: [0] },   // 0 = Sunday … 6 = Saturday

    // Day of the following month salaries are paid on, used for "due in N days".
    payDay:            { type: Number, default: 1, min: 1, max: 28 },
    // Month the financial year starts in — April in India. Drives Form 16/YTD.
    financialYearStartMonth: { type: Number, default: 4, min: 1, max: 12 },

    // Rounding applied to every computed line and to the net.
    roundTo:           { type: Number, default: 1 },

    // Take loss-of-pay days from approved unpaid leave automatically.
    useLeaveForLop:    { type: Boolean, default: true },
    /**
     * Also count days the staff register marks Absent with no leave behind
     * them. Off by default: a school that does not keep staff attendance
     * carefully would start docking pay for gaps in its own record-keeping, and
     * that is a decision to make deliberately rather than inherit.
     *
     * A Half-Day counts as half a day's loss.
     */
    useAttendanceForLop: { type: Boolean, default: false },
    // Email + notify every employee when a run is published.
    notifyOnPublish:   { type: Boolean, default: true },
    // Require the approve step, or let a reviewed run publish directly.
    requireApproval:   { type: Boolean, default: true },
    /**
     * The person who processed a run may not be the one who approves it.
     *
     * On by default: a four-step workflow one person can walk end to end is
     * decoration, not control, and this module moves money. A school where
     * exactly one account has payroll-admin access is let through regardless —
     * there is literally nobody else to ask, and locking payroll would be worse
     * than the risk it prevents.
     */
    separateApprover:  { type: Boolean, default: true },

    /**
     * Income tax. `regime: 'none'` — the default — deducts nothing: a software
     * upgrade must never quietly start withholding tax from salaries. A school
     * that turns it on owns the slab table, because rates change with every
     * budget and last year's numbers are wrong numbers.
     *
     *   { regime, slabs: [{ upTo, rate }], standardDeduction, cessPercent,
     *     rebateUpTo, rebateMax }
     *
     * See services/incomeTax.js.
     */
    tax:               { type: db.Types.JSON, default: null },

    /**
     * The month does not open itself unless a school asks it to, and nothing
     * automatic ever gets past `draft` — see services/payrollSweep.js.
     */
    autoOpenRun:       { type: Boolean, default: false },
    autoOpenDay:       { type: Number, default: 25, min: 1, max: 28 },
    remindBeforePayDay: { type: Boolean, default: false },
    remindDaysBefore:  { type: Number, default: 3, min: 1, max: 15 },
    // The month a reminder last went out for, so an hourly sweep sends one
    // reminder and not twenty-four.
    lastReminderFor:   { type: String, default: '' },

    payslipPrefix:     { type: String, default: 'PS', trim: true },
    /**
     * The highest payslip number issued per year: { "2026": 42 }.
     *
     * Counting existing rows is not enough — reversing a publish DELETES the
     * payslips it wrote, which would drop the count and hand the same numbers
     * out again to a possibly different set of employees. A payslip number is a
     * financial reference; it only ever goes up.
     */
    payslipSeq:        { type: db.Types.JSON, default: null },
    // Printed at the foot of every payslip.
    payslipNote:       { type: String, default: 'This is a computer generated payslip and does not require a signature.' },

    // Bank file for salary transfer.
    bankName:          { type: String, default: '', trim: true },
    bankAccountNumber: { type: String, default: '', trim: true },
    bankIfsc:          { type: String, default: '', trim: true },

    updatedBy:         { type: db.Types.UUID, ref: 'User' },
}, { timestamps: true });

module.exports = db.model('PayrollSettings', PayrollSettingsSchema);
