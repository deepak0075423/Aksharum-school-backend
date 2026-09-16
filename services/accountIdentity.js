'use strict';
/**
 * One person, one sign-in, many places.
 *
 * A `User` row is NOT a person — it is one person's MEMBERSHIP of one school in
 * one role. That is what every other table in this app already assumes: marks,
 * attendance, leave, library issues, chat, timetable periods and module
 * permissions all hang off a user id that belongs to exactly one school. Nothing
 * about that changes here, and it is why a teacher who leaves keeps their
 * history — the row stays, it is only switched off.
 *
 * What is new is that several such rows can belong to the SAME person, and the
 * thing that says so is the email address. A teacher at two schools has two
 * rows; a teacher who is also a parent has two rows; a parent with children at
 * three schools has three. Sign-in resolves the address to every row it opens
 * and lets the person pick which one they are using right now — and switch later
 * without signing out.
 *
 * Credentials therefore belong to the ADDRESS, not to any one row. Every row
 * sharing an address carries the same password hash and the same isFirstLogin
 * flag, because they are one person's one password. Writes go through
 * setCredentials() so the group can never drift apart, and sign-in still
 * compares the supplied password against each row it is about to open, so a row
 * that somehow holds a different hash simply does not open. The password is the
 * key to a door, never a list of doors handed out on trust.
 *
 * Super admin is deliberately outside all of this: a platform account is not a
 * membership of a school and is never linked to one (see linkTarget).
 */
const bcrypt    = require('bcryptjs');
const pool      = require('../db/pool');
const User      = require('../models/User');
const School    = require('../models/School');
const authCache = require('./../utils/authCache');

const U = `"${User.tableName}"`;
const S = `"${School.tableName}"`;

// Every membership behind one address, with just enough of the school attached
// to draw a chooser. Ordered so the chooser reads the same way every time.
const MEMBERSHIPS_SQL = `
    SELECT u."_id", u."name", u."email", u."password", u."role", u."school",
           u."isActive", u."isFirstLogin", u."profileImage", u."otp", u."otpExpiry",
           s."name" AS "schoolName", s."logo" AS "schoolLogo", s."code" AS "schoolCode",
           s."isActive" AS "schoolIsActive"
      FROM ${U} u
      LEFT JOIN ${S} s ON s."_id" = u."school"
     WHERE u."email" = $1
     ORDER BY CASE u."role"
                WHEN 'super_admin'  THEN 0
                WHEN 'school_admin' THEN 1
                WHEN 'teacher'      THEN 2
                WHEN 'parent'       THEN 3
                ELSE 4
              END,
              s."name" NULLS FIRST, u."_id"`;

const normEmail = (email) => String(email ?? '').trim().toLowerCase();

/** Every membership row for an address, credentials included. Internal use. */
async function membershipsByEmail(email) {
    const address = normEmail(email);
    if (!address) return [];
    const { rows } = await pool.query(MEMBERSHIPS_SQL, [address]);
    return rows;
}

/**
 * The rows this password actually opens.
 *
 * Rows in one group share a hash, so this is normally a single bcrypt call — the
 * distinct hashes are what get compared, not the rows. A row holding some other
 * hash (only reachable through data that predates setCredentials) is left shut
 * rather than opened on the strength of a sibling's password.
 */
async function openedBy(rows, password) {
    const hashes = [...new Set(rows.map((r) => r.password).filter(Boolean))];
    const opened = new Set();
    for (const hash of hashes) {
        if (await bcrypt.compare(String(password ?? ''), hash)) opened.add(hash);
    }
    return rows.filter((r) => opened.has(r.password));
}

/**
 * Split rows into the ones that can be signed into and the ones that cannot,
 * keeping the reason — a person whose only teacher post was switched off needs
 * to be told that, not shown an empty chooser.
 */
function partition(rows) {
    const open = [];
    const blocked = [];
    for (const row of rows) {
        if (!row.isActive) {
            blocked.push({ row, code: 'ACCOUNT_DISABLED', reason: row.schoolName
                ? `Your access to ${row.schoolName} has been switched off.`
                : 'Account disabled' });
        } else if (row.role !== 'super_admin' && row.school && row.schoolIsActive === false) {
            blocked.push({ row, code: 'SCHOOL_INACTIVE', reason: row.role === 'school_admin'
                ? `${row.schoolName || 'Your school'} has been deactivated. Please contact support.`
                : `${row.schoolName || 'Your school'} is currently inactive. Please contact your school administrator.` });
        } else {
            open.push(row);
        }
    }
    return { open, blocked };
}

/** What a chooser is allowed to know about a membership. Never the hash. */
const publicShape = (row) => ({
    id:     String(row._id),
    name:   row.name,
    email:  row.email,
    role:   row.role,
    school: row.school
        ? { _id: String(row.school), name: row.schoolName, logo: row.schoolLogo, code: row.schoolCode }
        : null,
});

/**
 * The other places this person can switch to from the row they are signed in as.
 *
 * Reachability is decided by the same three things sign-in decides it by — same
 * address, live membership, live school — plus the password hash matching the
 * row the current session was opened with. Without that last check, switching
 * would be a way into a row whose password the session never proved.
 */
async function switchTargets(currentRow) {
    const rows = await membershipsByEmail(currentRow.email);
    const { open } = partition(rows);
    return open
        .filter((r) => r.password && r.password === currentRow.password)
        .map((r) => ({ ...publicShape(r), current: String(r._id) === String(currentRow._id) }));
}

/**
 * Write a password (and first-login state) for the whole address at once.
 *
 * One person, one password: a teacher who is also a parent does not get two.
 * Every row's cached auth entry is dropped so the change is immediate rather
 * than TTL-delayed.
 */
async function setCredentials(email, { passwordHash, isFirstLogin, extra = {} } = {}) {
    const address = normEmail(email);
    if (!address) return [];
    const sets = [];
    const params = [address];
    if (passwordHash) { params.push(passwordHash); sets.push(`"password" = $${params.length}`); }
    if (isFirstLogin !== undefined) { params.push(!!isFirstLogin); sets.push(`"isFirstLogin" = $${params.length}`); }
    for (const [col, value] of Object.entries(extra)) {
        params.push(value);
        sets.push(`${JSON.stringify(col)} = $${params.length}`);
    }
    if (!sets.length) return [];
    const { rows } = await pool.query(
        `UPDATE ${U} SET ${sets.join(', ')} WHERE "email" = $1 RETURNING "_id"`,
        params,
    );
    const ids = rows.map((r) => String(r._id));
    if (ids.length) await authCache.invalidateMany(ids);
    return ids;
}

/**
 * The address behind a live password-reset token.
 *
 * Every row of an identity carries the same token, so this reads one of them
 * back purely to learn whose address it is — the reset itself is then applied to
 * the whole address, not to the row that happened to be returned.
 */
async function byResetToken(token) {
    if (!token) return null;
    const { rows } = await pool.query(
        `SELECT "_id", "email", "name" FROM ${U}
          WHERE "resetToken" = $1 AND "resetTokenExpiry" > now() LIMIT 1`,
        [String(token)],
    );
    return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Adding someone to a school
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_LABEL = {
    super_admin:  'platform administrator',
    school_admin: 'school administrator',
    teacher:      'teacher',
    student:      'student',
    parent:       'parent',
};

// Roles a person may hold in more than one place, or alongside each other. A
// student account is deliberately not one of them: schools routinely enter a
// parent's address on a child's admission form, and silently folding the child's
// account into the parent's sign-in would hand the child the parent's access.
const LINKABLE = new Set(['school_admin', 'teacher', 'parent']);

/**
 * Decide what creating `role` at `schoolId` for this address means.
 *
 *   mode 'create'  no account uses the address — make one, with a fresh password
 *   mode 'reuse'   this person already holds exactly this post here — use it
 *   mode 'link'    they have an account elsewhere — add a membership that shares
 *                  its credentials, and do not touch or reveal the password
 *   mode 'error'   the address cannot take this membership; `message` says why
 *
 * The rows are read straight from the database rather than trusted from a
 * caller, so two schools racing to add the same person cannot both decide
 * 'create' — the unique index on (email, school, role) settles that.
 */
async function linkTarget(email, { schoolId, role }) {
    const address = normEmail(email);
    if (!address) return { mode: 'error', message: 'An email address is required' };

    const rows = await membershipsByEmail(address);
    if (!rows.length) return { mode: 'create', address, rows: [] };

    const sameHere = rows.find((r) =>
        r.role === role && String(r.school || '') === String(schoolId || ''));
    if (sameHere) return { mode: 'reuse', address, row: sameHere, rows };

    if (rows.some((r) => r.role === 'super_admin')) {
        return { mode: 'error', message: `${address} belongs to a platform administrator account and cannot be added to a school` };
    }
    // A student account is never part of a shared sign-in, in either direction.
    if (role === 'student' || rows.some((r) => r.role === 'student')) {
        const held = rows.find((r) => r.role === 'student') ? 'student' : role;
        return {
            mode: 'error',
            message: role === 'student'
                ? `${address} is already registered — a student needs an email address of their own`
                : `${address} belongs to a ${ROLE_LABEL[held]} account — use a different address`,
        };
    }
    if (!LINKABLE.has(role)) {
        return { mode: 'error', message: `${address} is already registered` };
    }
    // Same school, different role (a teacher who is also a parent here), or the
    // same role at another school — both are one person with one sign-in.
    const donor = rows.find((r) => r.password) || rows[0];
    return { mode: 'link', address, donor, rows };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Staff work at one school at a time
//
//  A person can be a parent at as many schools as their children attend, but
//  they are EMPLOYED at one school at a time. So among the staff posts behind an
//  address — teacher and school admin — only those at a single school may be
//  active; every staff post anywhere else is inactive. Teacher and admin at the
//  SAME school are one job and are not in conflict.
//
//  Nothing is switched off on another school's behalf. When a school adds (or
//  re-activates) someone who is still active at another school, the new post is
//  created inactive, or the activation is refused, and it is that other school
//  which has to let them go first. One school's office must never be able to cut
//  off a person's access at a school it does not run.
//
//  The row is what counts, not its school: a post left active at a school that
//  has since been deactivated still holds the person until it is marked inactive
//  (the platform admin can do that when the school's own office cannot).
// ─────────────────────────────────────────────────────────────────────────────

const STAFF_ROLES = new Set(['teacher', 'school_admin']);
const isStaffRole = (role) => STAFF_ROLES.has(role);

/**
 * The live staff post this address holds at a school other than `schoolId`,
 * or null. `exceptUserId` leaves out the row being changed.
 */
async function activeStaffElsewhere(email, schoolId, { exceptUserId = null, rows = null } = {}) {
    const all = rows || await membershipsByEmail(email);
    return all.find((r) =>
        isStaffRole(r.role)
        && r.isActive
        && String(r.school || '') !== String(schoolId || '')
        && String(r._id) !== String(exceptUserId || '')) || null;
}

/**
 * Why this staff post may not be active right now, or null when it may.
 *
 * `audience` decides how much is said: a school's own office is told only that
 * the person is active at "another school" — which school employs them is not
 * this office's business — while the platform admin is told which one.
 */
async function staffActivationBlock({ email, role, schoolId, userId = null, name = '' }, { audience = 'school' } = {}) {
    if (!isStaffRole(role)) return null;
    const other = await activeStaffElsewhere(email, schoolId, { exceptUserId: userId });
    if (!other) return null;
    const who   = name || 'This person';
    const post  = ROLE_LABEL[other.role] || other.role;
    const where = audience === 'platform' ? (other.schoolName || 'another school') : 'another school';
    return `${who} is currently active as a ${post} at ${where}. A person can work at only one school at a time — they must be marked inactive there before they can be active here.`;
}

/**
 * The credential columns a newly linked membership must be created with, so the
 * person keeps the one password they already have.
 */
const inheritedCredentials = (donor) => ({
    password:     donor.password,
    isFirstLogin: donor.isFirstLogin,
});

/**
 * Give someone a post at a school — creating their sign-in, or adding to the
 * one they already have. The single place a User row is created from.
 *
 * `body.password` is the one-time password the caller generated; it is used only
 * when a brand-new account is made. When the address already signs in, the new
 * row inherits those credentials untouched — the person keeps one password, and
 * the office adding them never learns or resets it.
 *
 * Returns { user, linked, reused, inactive }:
 *   linked    the row joined an existing sign-in — send the "added to a school"
 *             note, never a one-time password
 *   reused    the post already existed; nothing was created
 *   inactive  a staff post created switched off, because the person is still
 *             active staff at another school (see staffActivationBlock);
 *             `inactiveReason` is the message for the office that added them
 *
 * Throws with `status` 400 and a message fit to show when the address cannot
 * take the post.
 */
async function createMembership(body, { role, school }) {
    const address = normEmail(body.email);
    const link = await linkTarget(address, { schoolId: school, role });
    if (link.mode === 'error') {
        const err = new Error(link.message);
        err.status = 400;
        throw err;
    }
    if (link.mode === 'reuse') {
        return { user: await User.findById(link.row._id), linked: false, reused: true };
    }
    const credentials = link.mode === 'link'
        ? inheritedCredentials(link.donor)
        : { password: await bcrypt.hash(body.password, 12), isFirstLogin: true };
    // Still employed somewhere else: the record is made, but switched off until
    // that school marks them inactive and this one activates them.
    const busyElsewhere = isStaffRole(role)
        ? await activeStaffElsewhere(address, school, { rows: link.rows })
        : null;
    const user = await User.create({
        ...body, email: address, role, school, ...credentials,
        isActive: !busyElsewhere,
    });
    return {
        user,
        linked:   link.mode === 'link',
        reused:   false,
        inactive: !!busyElsewhere,
        inactiveReason: busyElsewhere
            ? `${body.name || 'This person'} is currently active at another school, so they have been added here as inactive. They can be activated once that school marks them inactive.`
            : null,
    };
}

/**
 * Does this address reach past `schoolId`?
 *
 * A school administrator may reset the password of someone who exists only in
 * their own school. Once the same sign-in also opens another school, that
 * password is no longer theirs to set — it would hand them the other school's
 * access too. Those people change their own password, or use Forgot password.
 */
async function reachesBeyond(email, schoolId) {
    const rows = await membershipsByEmail(email);
    return rows.some((r) => String(r.school || '') !== String(schoolId || ''));
}

/** Is this address in use by any membership other than `exceptUserId`? */
async function addressTaken(email, exceptUserId = null) {
    const rows = await membershipsByEmail(email);
    return rows.some((r) => String(r._id) !== String(exceptUserId || ''));
}

/**
 * May this school's office edit the sign-in on this row?
 *
 * Name, phone and everything else about a membership belong to the school that
 * created it. The ADDRESS and the PASSWORD do not: they are the person's, and
 * the same pair may open a post at a school this administrator has nothing to do
 * with. So:
 *
 *   · setting a password is refused once the address reaches another school —
 *     the new password would work there too, handing one school's office access
 *     to another's. Those people change their own, or use Forgot password.
 *   · changing the address is refused for the same reason, and refused outright
 *     when the new one is already in use — an address that could be pointed at
 *     an existing sign-in would be a way to graft a row onto someone else's.
 *
 * Returns the refusal to show, or null when the edit may go ahead.
 */
async function guardAccountEdit(row, { email, password, schoolId } = {}) {
    const changingEmail = email !== undefined && normEmail(email) && normEmail(email) !== normEmail(row.email);
    if (!changingEmail && !password) return null;

    const shared = await reachesBeyond(row.email, schoolId);
    if (password && shared) {
        return `${row.name || 'This person'} also uses ${row.email} at another school on the platform, so their password is not yours to set. Ask them to change it from their profile, or to use “Forgot password”.`;
    }
    if (changingEmail) {
        if (shared) {
            return `${row.email} is also used to sign in at another school on the platform, so it cannot be changed from here. Ask them to contact support.`;
        }
        if (await addressTaken(email, row._id)) {
            return 'Email already registered';
        }
    }
    return null;
}

/** Is this address already a membership of this school in this role? */
async function existsAt(email, { schoolId, role }) {
    const rows = await membershipsByEmail(email);
    return rows.some((r) => r.role === role && String(r.school || '') === String(schoolId || ''));
}

module.exports = {
    normEmail,
    membershipsByEmail,
    openedBy,
    partition,
    publicShape,
    switchTargets,
    setCredentials,
    byResetToken,
    linkTarget,
    inheritedCredentials,
    createMembership,
    isStaffRole,
    activeStaffElsewhere,
    staffActivationBlock,
    reachesBeyond,
    addressTaken,
    guardAccountEdit,
    existsAt,
    ROLE_LABEL,
    LINKABLE,
};
