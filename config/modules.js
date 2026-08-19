'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Canonical module registry.
//
//  Every per-school feature flag on School.modules is described exactly once
//  here, so the four /{role}/modules endpoints, the designation permission
//  matrix (web + mobile) and the middleware all agree on the key set.
//
//  adminCapable — whether the module has an administrative surface a teacher
//  could be promoted into. `chat` has none (it is peer-to-peer), so its
//  designation permission is limited to access / no access.
// ─────────────────────────────────────────────────────────────────────────────

const MODULES = [
    { key: 'attendance',   label: 'Attendance',       icon: '✅', adminCapable: true,  description: 'Student & staff attendance, corrections and regularization' },
    { key: 'timetable',    label: 'Timetable',        icon: '🕐', adminCapable: true,  description: 'Period schedules, generation and publishing' },
    { key: 'result',       label: 'Results',          icon: '📊', adminCapable: true,  description: 'Formal exams, marks entry and report cards' },
    { key: 'aptitudeExam', label: 'Aptitude Exams',   icon: '📝', adminCapable: true,  description: 'Timed MCQ exams, approval workflow and analytics' },
    { key: 'fees',         label: 'Fees',             icon: '💰', adminCapable: true,  description: 'Fee structures, payments, receipts and reports' },
    { key: 'payroll',      label: 'Payroll',          icon: '💵', adminCapable: true,  description: 'Salary structures, payroll runs and payslips' },
    { key: 'library',      label: 'Library',          icon: '📖', adminCapable: true,  description: 'Catalogue, circulation, reservations and fines' },
    { key: 'inventory',    label: 'Inventory',        icon: '📦', adminCapable: true,  description: 'Stock, assets, purchase requests and orders' },
    { key: 'transport',    label: 'Transport',        icon: '🚌', adminCapable: true,  description: 'Fleet, routes, trips, tracking and transport fees' },
    { key: 'hostel',       label: 'Hostel',           icon: '🏨', adminCapable: true,  description: 'Hostels, rooms, beds, admissions, mess, outpass and hostel fees' },
    { key: 'videoLibrary', label: 'Video Learning',   icon: '🎬', adminCapable: true,  description: 'Video library, assignments and approvals' },
    { key: 'feedback',     label: 'Teacher Feedback', icon: '⭐', adminCapable: true,  description: 'Feedback campaigns, school-wide analytics and reports' },
    { key: 'leave',        label: 'Leave',            icon: '🏖️', adminCapable: true,  description: 'Leave applications, policies, balances and comp off' },
    { key: 'document',     label: 'Documents',        icon: '📁', adminCapable: true,  description: 'Document sharing and submissions' },
    { key: 'holiday',      label: 'Holidays',         icon: '🎉', adminCapable: true,  description: 'Holiday calendar' },
    { key: 'notification', label: 'Notifications',    icon: '🔔', adminCapable: true,  description: 'In-app alerts and announcements' },
    { key: 'employeeDirectory', label: 'Employee Directory', icon: '🗂️', adminCapable: true,  description: 'Staff directory assembled from existing employee records' },
    { key: 'chat',         label: 'Chat',             icon: '💬', adminCapable: false, description: 'Real-time messaging' },
];

const MODULE_KEYS = MODULES.map((m) => m.key);
const MODULE_BY_KEY = Object.fromEntries(MODULES.map((m) => [m.key, m]));

const isModuleKey = (k) => Object.prototype.hasOwnProperty.call(MODULE_BY_KEY, k);
const isAdminCapable = (k) => !!MODULE_BY_KEY[k]?.adminCapable;

// Normalised {key: boolean} view of School.modules — always every key, so
// callers never have to distinguish "false" from "absent".
function schoolModuleFlags(school) {
    const m = school?.modules || {};
    const out = {};
    for (const key of MODULE_KEYS) out[key] = !!m[key];
    return out;
}

module.exports = { MODULES, MODULE_KEYS, MODULE_BY_KEY, isModuleKey, isAdminCapable, schoolModuleFlags };
