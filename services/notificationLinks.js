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
        // A teacher reaches an approvals queue two ways — by designation, or by
        // holding admin on the leave module — and this one queue serves both,
        // because teacherGetApprovals asks canApprove the same question the
        // admin screen does. Everyone else falls back to their own list.
        teacher:      { web: '/teacher/leave?tab=approvals', mobile: '/modules/leave-approvals' },
    },
    // Administrative notices about the module itself — a type deleted, a policy
    // changed, a year closed. Only ever sent to leave administrators, which is
    // why the teacher row points into /admin: a teacher receiving one holds
    // admin on the module, so AdminAreaGuard lets them in.
    'leave.manage': {
        school_admin: { web: '/admin/leave?tab=types', mobile: '/modules/admin/leave-types' },
        teacher:      { web: '/admin/leave?tab=types', mobile: '/modules/admin/leave-types' },
    },
    // A balance moved — allocated, cleared, carried forward, accrued, settled.
    'leave.balance': {
        teacher:      { web: '/teacher/leave?tab=balance',     mobile: '/modules/leave' },
        school_admin: { web: '/admin/leave?tab=allocations',   mobile: '/modules/admin/leave-allocations' },
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

    // Which params the path itself swallowed — the rest are forwarded below.
    const templateKeys = new Set(
        [...String(target.web + target.mobile).matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
    );

    // Most destinations are lists — the leave queue, the regularization
    // requests, the substitutions. Landing on the list is only half the job;
    // `focus` names the row this notification is about so the page can scroll
    // to it and flag it. Skipped when the id is already in the path, because
    // that page is the record.
    if (link.entityId && !/\{id\}/.test(target.web + target.mobile)) {
        web    = withParam(web, 'focus', link.entityId);
        mobile = withParam(mobile, 'focus', link.entityId);
    }

    // Naming the row is not enough when the page opens on a slice that does not
    // contain it. The substitutions board opens on today: a notification about
    // a cover on the 20th lands on a board that will never render that row, and
    // the highlight waits for something that cannot arrive. So any param the
    // path did not consume is forwarded as a query parameter, which is how a
    // notification says *which day, which tab* to open as well as which row.
    // Pages that do not read a given key simply ignore it.
    for (const [key, value] of Object.entries(link.params || {})) {
        if (templateKeys.has(key) || value == null || value === '') continue;
        web    = withParam(web, key, value);
        mobile = withParam(mobile, key, value);
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

// ── What a notification is about, and how much it wants ──────────────────────
/**
 * The same registry, asked two more questions.
 *
 * A reader with two hundred notifications needs to narrow them, and the two
 * things they narrow by are *which part of the school this came from* and *does
 * it want something from me*. Neither was ever stored: a notification carries a
 * destination, and the destination already says both. `leave.approvals` is the
 * leave module, and it is a queue somebody is waiting in.
 *
 * So both are derived from link.type here rather than written by 89 call sites,
 * and the inbox query derives them the same way — moduleSql()/prioritySql()
 * below emit the same mapping as SQL, so filtering and sorting in Postgres can
 * never disagree with what the row displays.
 *
 * `priority` on the Notification overrides the derived value, and is what the
 * admin's own Send dialog writes: a person broadcasting a message knows how
 * urgent it is, and nothing in a hand-typed announcement can tell us.
 */

// The module a link type belongs to. Several types share one: comp off is part
// of leave, substitutions are part of the timetable.
const MODULE_OF = {
    leave: 'leave', compoff: 'leave',
    attendance: 'attendance',
    fees: 'fees',
    payroll: 'payroll',
    library: 'library',
    results: 'results',
    timetable: 'timetable', substitutions: 'timetable',
    holidays: 'calendar',
    inventory: 'inventory',
    transport: 'transport',
    hostel: 'hostel',
    video: 'video',
    feedback: 'feedback',
    section: 'academics',
};

const MODULE_LABELS = {
    leave: 'Leave', attendance: 'Attendance', fees: 'Fees', payroll: 'Payroll',
    library: 'Library', results: 'Results', timetable: 'Timetable',
    calendar: 'Calendar', inventory: 'Inventory', transport: 'Transport',
    hostel: 'Hostel', video: 'Videos', feedback: 'Feedback',
    academics: 'Academics', general: 'General',
};

// Somebody is waiting on the reader, or money is owed. These are the ones that
// should still be visible after a filter down to "High".
const HIGH_TYPES = [
    'leave.approvals', 'compoff.approvals',
    'attendance.regularizations', 'attendance.corrections',
    'inventory.requests', 'transport.requests', 'video.approvals',
    'feedback.pending', 'feedback.form',
    'fees.mine', 'library.myfines', 'library.manage.fines', 'library.fines',
    'substitutions',
];

// Nothing is being asked and nothing has changed for the reader personally —
// the school's calendar moved, a video was published, a timetable was redrawn.
const LOW_TYPES = [
    'holidays', 'section', 'timetable', 'timetable.section',
    'video.list', 'video.item', 'feedback.campaign',
];

const PRIORITIES = ['high', 'medium', 'low'];

/** The module key for a stored link — 'general' when it names no destination. */
function moduleOf(link) {
    const type = (typeof link === 'string' ? link : link?.type) || '';
    if (!type) return 'general';
    return MODULE_OF[type.split('.')[0]] || 'general';
}

/** The module's name as a reader would say it. */
function moduleLabel(key) {
    return MODULE_LABELS[key] || MODULE_LABELS.general;
}

/** Every module a notification can come from, for the inbox's filter. */
const MODULE_OPTIONS = [...new Set(Object.values(MODULE_OF)), 'general']
    .map((key) => ({ value: key, label: moduleLabel(key) }));

/**
 * How loud a notification is, when nobody said.
 * A stored `priority` always wins — see priorityOf().
 */
function derivedPriority(link) {
    const type = (typeof link === 'string' ? link : link?.type) || '';
    if (HIGH_TYPES.includes(type)) return 'high';
    if (!type || LOW_TYPES.includes(type)) return 'low';
    return 'medium';
}

function priorityOf(notification) {
    const stored = notification?.priority;
    if (PRIORITIES.includes(stored)) return stored;
    return derivedPriority(notification?.link);
}

// ── The same two rules, as SQL ───────────────────────────────────────────────
// The inbox pages, filters and sorts in Postgres, so the mapping has to exist
// there too. Generated from the tables above rather than written out a second
// time, so the two cannot drift apart.

const sqlList = (values) => values.map((v) => `'${v}'`).join(', ');

/** SQL expression for the module key of a notification row. `col` is its jsonb link column. */
function moduleSql(col = 'n.link') {
    const whens = Object.entries(MODULE_OF)
        .map(([prefix, key]) => `WHEN '${prefix}' THEN '${key}'`)
        .join(' ');
    return `(CASE split_part(COALESCE(${col}->>'type', ''), '.', 1) ${whens} ELSE 'general' END)`;
}

/** SQL expression for a notification's priority, stored value first. */
function prioritySql(linkCol = 'n.link', priorityCol = 'n.priority') {
    return `(CASE
        WHEN ${priorityCol} IN (${sqlList(PRIORITIES)}) THEN ${priorityCol}
        WHEN COALESCE(${linkCol}->>'type', '') IN (${sqlList(HIGH_TYPES)}) THEN 'high'
        WHEN COALESCE(${linkCol}->>'type', '') IN (${sqlList(LOW_TYPES)}) THEN 'low'
        WHEN COALESCE(${linkCol}->>'type', '') = '' THEN 'low'
        ELSE 'medium' END)`;
}

/** Sorts high above low, for ORDER BY — a text sort would put "low" first. */
function priorityRankSql(linkCol = 'n.link', priorityCol = 'n.priority') {
    return `(CASE ${prioritySql(linkCol, priorityCol)} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END)`;
}

const LINK_TYPES = Object.keys(ROUTES);

module.exports = {
    resolve, normalize, webUrl, receiptUrl, appUrl, LINK_TYPES, ROUTES, INBOX,
    moduleOf, moduleLabel, MODULE_OPTIONS, PRIORITIES, priorityOf, derivedPriority,
    moduleSql, prioritySql, priorityRankSql,
};
