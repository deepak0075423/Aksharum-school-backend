'use strict';
/**
 * Where a notification takes you.
 * ───────────────────────────────
 * A notification is written once but read by people on different screens: the
 * same "leave approved" row belongs on the teacher's own leave list and, for an
 * admin, in the requests queue — and neither web path matches the mobile one.
 * So notifications do NOT store a URL. They store a *destination*:
 *
 *     link: { type: 'leave.mine', entityId: '<uuid>', params: { … } }
 *
 * and this module turns that into a path per platform, for the role of whoever
 * is looking. One table, consulted by the inbox API, the socket payload, the
 * notification emails and the /n/:id redirect, so a route only ever moves in
 * one place.
 *
 * `resolve()` always returns a destination. A notification with no link — a
 * plain broadcast an admin typed by hand — points at the reader's own
 * notification list, opened on that notification. Every notification is
 * clickable; none of them dead-ends.
 */

// Role buckets. `default` catches any role a type does not name, which is what
// keeps a new role from producing dead links.
const ROUTES = {
    // ── Leave ────────────────────────────────────────────────────────────────
    'leave.mine': {
        teacher:      { web: '/teacher/leave?tab=my-leaves', mobile: '/modules/leave' },
        school_admin: { web: '/admin/leave?tab=requests',    mobile: '/modules/admin/leave' },
    },
    'leave.approvals': {
        school_admin: { web: '/admin/leave?tab=requests',    mobile: '/modules/admin/leave' },
        // A teacher only reaches an approvals queue by designation; the tab is
        // hidden for everyone else and the page falls back to their own list.
        teacher:      { web: '/teacher/leave?tab=approvals', mobile: '/modules/leave-approvals' },
    },

    // ── Comp off (lives inside the leave module) ─────────────────────────────
    'compoff.mine': {
        teacher:      { web: '/teacher/leave?tab=compoff',  mobile: '/modules/comp-off' },
        school_admin: { web: '/admin/leave?tab=compoff',    mobile: '/modules/admin/comp-off' },
    },
    'compoff.approvals': {
        school_admin: { web: '/admin/leave?tab=compoff',            mobile: '/modules/admin/comp-off' },
        teacher:      { web: '/teacher/leave?tab=compoff-approvals', mobile: '/modules/comp-off' },
    },

    // ── Attendance ───────────────────────────────────────────────────────────
    'attendance.mine': {
        teacher:      { web: '/teacher/attendance?tab=mine',          mobile: '/modules/teacher-attendance?tab=mine' },
        school_admin: { web: '/admin/attendance?tab=my-attendance',   mobile: '/modules/admin/attendance?tab=mine' },
        student:      { web: '/student/attendance',                   mobile: '/modules/attendance' },
        parent:       { web: '/parent/child-attendance',              mobile: '/modules/attendance' },
    },
    'attendance.regularizations': {
        school_admin: { web: '/admin/attendance?tab=requests',  mobile: '/modules/admin/attendance?tab=requests' },
        teacher:      { web: '/teacher/attendance?tab=mine',    mobile: '/modules/teacher-attendance?tab=mine' },
    },
    'attendance.corrections': {
        teacher:      { web: '/teacher/attendance?tab=correct', mobile: '/modules/teacher-attendance?tab=corrections' },
        school_admin: { web: '/admin/attendance?tab=requests',  mobile: '/modules/admin/attendance?tab=requests' },
    },
    'attendance.student': {
        student:      { web: '/student/attendance',      mobile: '/modules/attendance' },
        parent:       { web: '/parent/child-attendance', mobile: '/modules/attendance' },
        teacher:      { web: '/teacher/attendance',      mobile: '/modules/teacher-attendance?tab=corrections' },
        school_admin: { web: '/admin/attendance',        mobile: '/modules/admin/attendance?tab=requests' },
    },

    // ── Fees ─────────────────────────────────────────────────────────────────
    'fees.mine': {
        student:      { web: '/student/fees',        mobile: '/modules/fees' },
        parent:       { web: '/parent/child-fees',   mobile: '/modules/fees' },
        school_admin: { web: '/admin/fees/payments', mobile: '/modules/admin/fees-payments' },
        teacher:      { web: '/admin/fees/payments', mobile: '/modules/admin/fees-payments' },
    },
    'fees.payments': {
        school_admin: { web: '/admin/fees/payments', mobile: '/modules/admin/fees-payments' },
        teacher:      { web: '/admin/fees/payments', mobile: '/modules/admin/fees-payments' },
        student:      { web: '/student/fees',        mobile: '/modules/fees' },
        parent:       { web: '/parent/child-fees',   mobile: '/modules/fees' },
    },

    // ── Payroll ──────────────────────────────────────────────────────────────
    'payroll.payslips': {
        teacher:      { web: '/teacher/payroll/payslips', mobile: '/modules/teacher-payroll' },
        school_admin: { web: '/admin/payroll/runs',       mobile: '/modules/admin/payroll-runs' },
    },

    // ── Library ──────────────────────────────────────────────────────────────
    'library.mybooks': {
        student:      { web: '/student/library/my-books', mobile: '/modules/library' },
        teacher:      { web: '/teacher/library/my-books', mobile: '/modules/library' },
        parent:       { web: '/parent/dashboard',         mobile: '/modules/library-parent' },
        school_admin: { web: '/admin/library/circulation', mobile: '/modules/library-admin/circulation' },
    },
    'library.myfines': {
        student:      { web: '/student/library/my-fines', mobile: '/modules/library' },
        teacher:      { web: '/teacher/library/my-fines', mobile: '/modules/library' },
        parent:       { web: '/parent/dashboard',         mobile: '/modules/library-parent' },
        school_admin: { web: '/admin/library/fines',      mobile: '/modules/library-admin/fines' },
    },
    'library.reservations': {
        student:      { web: '/student/library/my-books',  mobile: '/modules/library' },
        teacher:      { web: '/teacher/library/my-books',  mobile: '/modules/library' },
        parent:       { web: '/parent/dashboard',          mobile: '/modules/library-parent' },
        school_admin: { web: '/admin/library/reservations', mobile: '/modules/library-admin/reservations' },
    },
    // The earlier spelling of 'library.manage.circulation' below, which nothing
    // writes any more. Kept registered so a notification stored under it before
    // the rename still opens where it meant to instead of falling back to the
    // reader's inbox.
    'library.circulation': {
        school_admin: { web: '/admin/library/circulation',   mobile: '/modules/library-admin/circulation' },
        teacher:      { web: '/teacher/manage-library/circulation', mobile: '/modules/library-admin/circulation' },
    },

    // Staff-side destinations. A librarian is also a borrower, so the member
    // types above send a teacher to their OWN books and fines — which is wrong
    // for a notice about somebody else's loan. These are the desk's versions.
    'library.manage.circulation': {
        school_admin: { web: '/admin/library/circulation',           mobile: '/modules/library-admin/circulation' },
        teacher:      { web: '/teacher/manage-library/circulation',  mobile: '/modules/library-admin/circulation' },
    },
    'library.manage.reservations': {
        school_admin: { web: '/admin/library/reservations',          mobile: '/modules/library-admin/reservations' },
        teacher:      { web: '/teacher/manage-library/reservations', mobile: '/modules/library-admin/reservations' },
    },
    'library.manage.fines': {
        school_admin: { web: '/admin/library/fines',                 mobile: '/modules/library-admin/fines' },
        teacher:      { web: '/teacher/manage-library/fines',        mobile: '/modules/library-admin/fines' },
    },

    // ── Exams & results ──────────────────────────────────────────────────────
    'results.mine': {
        student:      { web: '/student/results',  mobile: '/modules/results' },
        parent:       { web: '/parent/results',   mobile: '/modules/results' },
        teacher:      { web: '/teacher/results',  mobile: '/modules/results' },
        school_admin: { web: '/admin/results',    mobile: '/modules/admin/results' },
    },
    'results.marks': {
        teacher:      { web: '/teacher/results', mobile: '/modules/results' },
        school_admin: { web: '/admin/results',   mobile: '/modules/admin/results' },
    },

    // ── Timetable ────────────────────────────────────────────────────────────
    'timetable': {
        teacher:      { web: '/teacher/timetable',  mobile: '/modules/timetable' },
        student:      { web: '/student/timetable',  mobile: '/modules/timetable' },
        parent:       { web: '/parent/child-class', mobile: '/modules/child-class' },
        school_admin: { web: '/admin/timetable',    mobile: '/modules/admin/timetable' },
    },
    'timetable.section': {
        school_admin: { web: '/admin/sections/{sectionId}', mobile: '/modules/admin/section-detail?id={sectionId}' },
        teacher:      { web: '/teacher/timetable',          mobile: '/modules/timetable' },
        student:      { web: '/student/timetable',          mobile: '/modules/timetable' },
        parent:       { web: '/parent/child-class',         mobile: '/modules/child-class' },
    },
    'substitutions': {
        teacher:      { web: '/teacher/substitutions',           mobile: '/modules/my-substitutions' },
        school_admin: { web: '/admin/timetable/substitutions',   mobile: '/modules/admin/substitutions' },
    },

    // ── Holidays ─────────────────────────────────────────────────────────────
    'holidays': {
        school_admin: { web: '/admin/holidays',   mobile: '/modules/admin/holidays' },
        teacher:      { web: '/teacher/holidays', mobile: '/modules/holidays' },
        student:      { web: '/student/holidays', mobile: '/modules/holidays' },
        parent:       { web: '/parent/holidays',  mobile: '/modules/holidays' },
    },

    // ── Inventory ────────────────────────────────────────────────────────────
    'inventory.requests': {
        school_admin: { web: '/admin/inventory/requests',   mobile: '/modules/admin/inventory' },
        teacher:      { web: '/teacher/inventory/requests', mobile: '/modules/inventory-requests' },
    },
    'inventory.issues': {
        school_admin: { web: '/admin/inventory/issues',     mobile: '/modules/admin/inventory' },
        teacher:      { web: '/teacher/inventory/requests', mobile: '/modules/inventory-requests' },
    },

    // ── Transport ────────────────────────────────────────────────────────────
    'transport.mine': {
        student:      { web: '/student/transport',        mobile: '/modules/transport' },
        parent:       { web: '/parent/transport/details', mobile: '/modules/transport-parent' },
        school_admin: { web: '/admin/transport/assignments', mobile: '/modules/admin/transport' },
        teacher:      { web: '/admin/transport/assignments', mobile: '/modules/admin/transport' },
    },
    'transport.requests': {
        student:      { web: '/student/transport',         mobile: '/modules/transport' },
        parent:       { web: '/parent/transport/requests', mobile: '/modules/transport-parent' },
        school_admin: { web: '/admin/transport/requests',  mobile: '/modules/admin/transport' },
        teacher:      { web: '/admin/transport/requests',  mobile: '/modules/admin/transport' },
    },

    // ── Hostel ───────────────────────────────────────────────────────────────
    'hostel': {
        student:      { web: '/student/hostel',       mobile: '/modules/hostel' },
        parent:       { web: '/parent/hostel',        mobile: '/modules/hostel-parent' },
        teacher:      { web: '/admin/hostel/dashboard', mobile: '/modules/admin/hostel' },
        school_admin: { web: '/admin/hostel/dashboard', mobile: '/modules/admin/hostel' },
    },

    // ── Video library ────────────────────────────────────────────────────────
    'video.item': {
        student:      { web: '/student/videos/{id}',  mobile: '/modules/video-player?id={id}' },
        parent:       { web: '/parent/dashboard',     mobile: '/modules/videos' },
        teacher:      { web: '/teacher/videos/catalog', mobile: '/modules/teacher-videos' },
        school_admin: { web: '/admin/videos/browse',  mobile: '/modules/admin-videos' },
    },
    'video.list': {
        student:      { web: '/student/videos',         mobile: '/modules/videos' },
        parent:       { web: '/parent/dashboard',       mobile: '/modules/videos' },
        teacher:      { web: '/teacher/videos/catalog', mobile: '/modules/teacher-videos' },
        school_admin: { web: '/admin/videos/browse',    mobile: '/modules/admin-videos' },
    },
    'video.mine': {
        teacher:      { web: '/teacher/videos/catalog', mobile: '/modules/teacher-videos' },
        school_admin: { web: '/admin/videos/browse',    mobile: '/modules/admin-videos' },
    },
    'video.approvals': {
        school_admin: { web: '/admin/videos/approvals', mobile: '/modules/admin-videos' },
        teacher:      { web: '/teacher/videos/catalog', mobile: '/modules/teacher-videos' },
    },

    // ── Teacher feedback ─────────────────────────────────────────────────────
    'feedback.pending': {
        student:      { web: '/student/feedback',         mobile: '/modules/feedback' },
        teacher:      { web: '/teacher/feedback/dashboard', mobile: '/modules/teacher-feedback' },
        school_admin: { web: '/admin/feedback/campaigns',  mobile: '/modules/admin/feedback' },
    },
    'feedback.form': {
        student:      { web: '/student/feedback/{id}',    mobile: '/modules/feedback-form?id={id}' },
        parent:       { web: '/parent/dashboard',         mobile: '/(tabs)' },
        teacher:      { web: '/teacher/feedback/dashboard', mobile: '/modules/teacher-feedback' },
        school_admin: { web: '/admin/feedback/campaigns',  mobile: '/modules/admin/feedback' },
    },
    'feedback.campaign': {
        school_admin: { web: '/admin/feedback/campaigns/{id}', mobile: '/modules/admin/feedback' },
        teacher:      { web: '/teacher/feedback/dashboard',    mobile: '/modules/teacher-feedback' },
        student:      { web: '/student/feedback',              mobile: '/modules/feedback' },
    },

    // ── Class / section ──────────────────────────────────────────────────────
    'section': {
        school_admin: { web: '/admin/sections/{id}', mobile: '/modules/admin/section-detail?id={id}' },
        teacher:      { web: '/teacher/my-section',  mobile: '/modules/my-section' },
        student:      { web: '/student/my-class',    mobile: '/modules/my-class' },
        parent:       { web: '/parent/child-class',  mobile: '/modules/child-class' },
    },
};

// Where a role's plain notification list lives. This is the universal fallback:
// a notification with no destination of its own still opens — on itself.
const INBOX = {
    super_admin:  { web: '/super-admin/notifications', mobile: '/(tabs)/notifications' },
    school_admin: { web: '/admin/notifications',       mobile: '/(tabs)/notifications' },
    teacher:      { web: '/teacher/notifications',     mobile: '/(tabs)/notifications' },
    student:      { web: '/student/notifications',     mobile: '/(tabs)/notifications' },
    parent:       { web: '/parent/notifications',      mobile: '/(tabs)/notifications' },
};

/** `/admin/sections/{id}` + { id } → `/admin/sections/abc`. */
function fill(template, values) {
    return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
        (values[key] == null ? whole : encodeURIComponent(String(values[key]))));
}

/** Adds `key=value` to a path that may or may not already carry a query. */
function withParam(path, key, value) {
    if (!value) return path;
    const [base, hash = ''] = String(path).split('#');
    const joined = `${base}${base.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
    return hash ? `${joined}#${hash}` : joined;
}

/**
 * Turn a stored link into the paths this reader should follow.
 *
 * @param {Object} link       { type, entityId, params } as stored on the Notification
 * @param {String} role       the *reader's* role, not the sender's
 * @param {String} receiptId  their receipt, so the fallback can open the notification itself
 * @returns {{ type, entityId, web, mobile, resolved }}
 *          `resolved` is false when this is the inbox fallback rather than a
 *          destination the sender chose.
 */
function resolve(link, role, receiptId = null) {
    const inbox = INBOX[role] || INBOX.student;
    const fallback = {
        type:     link?.type || '',
        entityId: link?.entityId || null,
        web:      withParam(inbox.web, 'receipt', receiptId),
        mobile:   withParam(inbox.mobile, 'receipt', receiptId),
        resolved: false,
    };

    const byRole = link?.type ? ROUTES[link.type] : null;
    if (!byRole) return fallback;

    const target = byRole[role] || byRole.default;
    if (!target) return fallback;

    const values = { id: link.entityId, ...(link.params || {}) };
    // A template that still has an unfilled slot would navigate to a literal
    // "{id}" — better to land on the inbox than on a broken route.
    let web    = fill(target.web, values);
    let mobile = fill(target.mobile, values);
    if (web.includes('{') || mobile.includes('{')) return fallback;

    // Most destinations are lists — the leave queue, the regularization
    // requests, the substitutions. Landing on the list is only half the job;
    // `focus` names the row this notification is about so the page can scroll
    // to it and flag it. Skipped when the id is already in the path, because
    // that page is the record.
    if (link.entityId && !/\{id\}/.test(target.web + target.mobile)) {
        web    = withParam(web, 'focus', link.entityId);
        mobile = withParam(mobile, 'focus', link.entityId);
    }

    return {
        type:     link.type,
        entityId: link.entityId || null,
        web,
        mobile,
        resolved: true,
    };
}

/** Absolute https URL for the web app — what notification emails link to. */
function webUrl(path) {
    const base = String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The one URL that works for every reader and every platform: a web route that
 * looks the receipt up, marks it read and forwards to wherever it belongs. Sent
 * in emails and carried on push payloads, because neither of those knows which
 * device will open it.
 */
function receiptUrl(receiptId) {
    return webUrl(`/n/${receiptId}`);
}

/** Deep link into the installed app for the same receipt. */
function appUrl(receiptId) {
    const scheme = process.env.MOBILE_APP_SCHEME || 'aksharum';
    return `${scheme}://notification/${receiptId}`;
}

/** Normalises whatever a caller passed as `link` into the stored shape. */
function normalize(link) {
    if (!link) return null;
    if (typeof link === 'string') return { type: link, entityId: null, params: null };
    if (!link.type) return null;
    return {
        type:     String(link.type),
        entityId: link.entityId == null ? null : String(link.entityId),
        params:   link.params && Object.keys(link.params).length ? link.params : null,
    };
}

/** Every destination this build knows — used by the link self-test script. */
const LINK_TYPES = Object.keys(ROUTES);

module.exports = { resolve, normalize, webUrl, receiptUrl, appUrl, LINK_TYPES, ROUTES, INBOX };
