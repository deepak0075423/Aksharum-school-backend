'use strict';
/**
 * How each kind of record belongs to an academic year (Nov 2026).
 *
 * One line per model. A read made while a request has a year in view — every
 * list, tile, chart and report — is narrowed by the model's rule without the
 * screen saying so (services/yearScope.js explains when, and when not).
 *
 *   at      the date field the record is dated by (several = the first one set)
 *   open    statuses that mean "still in hand": such a record stays visible in
 *           every later year until it is closed, so unpaid invoices, pending
 *           requests and residents still in their beds do not disappear from
 *           the work queue the day the year turns
 *   id      the field naming the record's year, when it has one (a record that
 *           names none falls back to `at` / `months`)
 *   months  [monthField, yearField] for records kept by calendar month
 *
 * NOT listed, on purpose — these are not "a year's data":
 *   masters      people, designations, vehicles, routes, rooms and beds, items,
 *                vendors, books, fee heads, leave types, templates, settings
 *   current state stock on hand, bed status, live vehicle positions, alerts
 *   rows already tied to a year by what they hang from: classes, sections,
 *                subjects, timetables, enrolments, attendance registers (a
 *                section belongs to one year), exams and results, fee
 *                structures, ledgers and payments (the fees screens name their
 *                year), leave requests and balances, holidays, documents
 *   chat         a conversation is not a year's record
 *
 * Adding a module: list its dated records here; write nothing in its screens.
 */

const AUDIT = { at: 'createdAt' };

module.exports = {
    // ── Transport ────────────────────────────────────────────────────────────
    TransportTrip:        { at: 'date' },
    FuelLog:              { at: 'date' },
    MaintenanceRecord:    { at: ['scheduledDate', 'createdAt'], open: ['scheduled', 'in_progress'] },
    TransportIncident:    { at: ['date', 'createdAt'], open: ['reported', 'investigating'] },
    TransportComplaint:   { at: 'createdAt', open: ['open', 'assigned', 'in_progress'] },
    TransportRequest:     { at: 'createdAt', open: ['pending'] },
    TransportFeeInvoice:  { at: ['dueDate', 'createdAt'], open: ['pending', 'partial', 'overdue'] },
    TransportAssignment:  { at: ['effectiveDate', 'createdAt'], open: ['active', 'suspended'] },
    TransportReport:      { at: ['generatedAt', 'createdAt'], open: ['scheduled'] },
    TransportAuditLog:    AUDIT,

    // ── Inventory ────────────────────────────────────────────────────────────
    PurchaseRequest:           { at: 'createdAt', open: ['pending', 'approved'] },
    PurchaseOrder:             { at: 'createdAt', open: ['draft', 'pending_approval', 'approved', 'ordered', 'in_transit', 'partially_received'] },
    InventoryIssue:            { at: ['issueDate', 'createdAt'], open: ['issued', 'partially_returned'] },
    InventoryStockTransaction: { at: 'createdAt' },
    InventoryBudget:           { id: 'academicYear', span: ['periodStart', 'periodEnd'] },
    InventoryAuditLog:         { at: 'timestamp' },

    // ── Hostel ───────────────────────────────────────────────────────────────
    HostelAdmission:         { id: 'academicYear', at: ['admissionDate', 'appliedAt', 'createdAt'], open: ['applied', 'pending_approval', 'approved', 'waitlisted', 'completed'] },
    HostelAllocation:        { id: 'academicYear', at: ['fromDate', 'createdAt'], open: ['pending', 'active'] },
    HostelAllocationHistory: { at: ['effectiveDate', 'createdAt'] },
    HostelAttendance:        { at: 'date' },
    HostelLeave:             { at: ['fromDate', 'createdAt'], open: ['pending', 'parent_approved', 'approved', 'active', 'overdue'] },
    HostelOutpass:           { at: ['departureDate', 'createdAt'], open: ['pending', 'approved', 'active', 'overdue'] },
    HostelVisitor:           { at: ['scheduledAt', 'entryTime', 'createdAt'], open: ['pending', 'approved', 'checked_in'] },
    HostelComplaint:         { at: 'createdAt', open: ['open', 'assigned', 'in_progress', 'reopened'] },
    HostelIncident:          { at: ['date', 'createdAt'], open: ['reported', 'investigating', 'action_taken'] },
    HostelDiscipline:        { at: ['date', 'createdAt'], open: ['issued'] },
    HostelMaintenance:       { at: 'createdAt', open: ['open', 'assigned', 'in_progress', 'on_hold'] },
    HostelMovement:          { at: ['at', 'createdAt'] },
    HostelFeeInvoice:        { id: 'academicYear', at: ['dueDate', 'createdAt'], open: ['pending', 'partial', 'overdue'] },
    HostelMessAttendance:    { at: 'date' },
    HostelMessExpense:       { at: ['date', 'createdAt'] },
    HostelAnnouncement:      { at: ['publishedAt', 'scheduledAt', 'createdAt'], open: ['draft', 'scheduled', 'sending'] },
    HostelTransferRequest:   { at: 'createdAt', open: ['pending'] },
    HostelAuditLog:          AUDIT,

    // ── Library ──────────────────────────────────────────────────────────────
    LibraryIssuance:    { at: ['issueDate', 'createdAt'], open: ['issued', 'overdue'] },
    LibraryFine:        { at: 'createdAt', open: ['pending'] },
    LibraryReservation: { at: ['reservedAt', 'createdAt'], open: ['pending', 'ready'] },
    LibraryAuditLog:    { at: 'timestamp' },

    // ── Payroll ──────────────────────────────────────────────────────────────
    // A run's entries and payslips are read through their run; an employee's
    // own payslips are kept by FINANCIAL year, with that screen's own picker.
    PayrollRun:      { id: 'academicYear', months: ['month', 'year'] },
    PayrollReport:   { at: ['generatedAt', 'createdAt'] },
    SalaryAdvance:   { at: ['disbursedOn', 'createdAt'], open: ['active'] },
    SalaryClaim:     { at: ['claimedOn', 'createdAt'], open: ['pending', 'approved'] },
    PayrollAuditLog: { at: ['timestamp', 'createdAt'] },

    // ── Feedback ─────────────────────────────────────────────────────────────
    FeedbackCampaign:   { id: 'academicYear', at: ['startDate', 'createdAt'] },
    // An assignment is of its campaign's year (copied on to the row); the date
    // is only the fallback for a row written before the column existed.
    FeedbackAssignment: { id: 'academicYear', at: ['assignedAt', 'createdAt'] },
    FeedbackAuditLog:   AUDIT,

    // ── Staff attendance & leave paperwork ───────────────────────────────────
    TeacherAttendanceRegularization: { at: ['date', 'createdAt'], open: ['Pending'] },
    AttendanceCorrection:            { at: ['date', 'createdAt'], open: ['Pending'] },
    CompOffRequest:                  { at: ['workDate', 'createdAt'], open: ['pending'] },
    SubstituteAssignment:            { id: 'academicYear', at: ['date', 'createdAt'] },

    // ── Medical Room (its boards; reports keep the date range the reader chose) ─
    MedicalVisit:    { at: ['arrivedAt', 'createdAt'], open: ['in_room', 'observation', 'emergency'] },
    MedicalIncident: { at: ['occurredAt', 'createdAt'], open: ['reported', 'in_progress'] },
    MedicalFirstAid: { at: ['at', 'createdAt'] },

    // ── Activity trails ──────────────────────────────────────────────────────
    ActivityLog:       AUDIT,
    FeeAuditLog:       { at: 'timestamp' },
    TimetableAuditLog: AUDIT,
    ResultAuditLog:    AUDIT,
    IdCardLog:         AUDIT,
    MedicalAuditLog:   AUDIT,
};
