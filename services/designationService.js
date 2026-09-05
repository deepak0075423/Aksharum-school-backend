'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Designation-based module access control.
//
//  The hierarchy is strictly:
//
//      School module enablement  →  Designation permission  →  User access
//
//  A designation can never grant access to a module the Super Admin has
//  disabled for the school: the school flag is AND-ed in at resolution time
//  (see gate()). Disabling a module therefore revokes it for every designation
//  and every user instantly, while leaving the configured level stored — so
//  re-enabling the module reapplies exactly what was configured before.
//
//  Only teachers are designation-driven. school_admin is administrative on every
//  enabled module by definition, super_admin sits above schools entirely, and
//  students/parents get normal access to whatever their school has enabled.
// ─────────────────────────────────────────────────────────────────────────────
const School         = require('../models/School');
const Designation    = require('../models/Designation');
const TeacherProfile = require('../models/TeacherProfile');
const User           = require('../models/User');
const { MODULE_KEYS, isModuleKey, isAdminCapable, schoolModuleFlags } = require('../config/modules');
const { getCacheRedis } = require('../config/cacheRedis');

const ADMIN = 'admin';
const USER  = 'user';
const NONE  = 'none';
const LEVELS = [NONE, USER, ADMIN];
const RANK = { none: 0, user: 1, admin: 2 };

// Designations that carried hard-coded administrative privileges before this
// module existed. They seed the matrix and act as the fallback for any
// designation that has no row yet, so upgrading an existing school changes
// nobody's access until an admin edits the matrix.
const LEGACY_ADMIN_GRANTS = {
    'librarian':        ['library'],
    'principal':        ['feedback'],
    'vice principal':   ['feedback'],
    'headmaster':       ['feedback'],
    'headmistress':     ['feedback'],
};

const DEFAULT_DESIGNATIONS = ['Teacher', 'Class Teacher', 'Librarian', 'Principal', 'Vice Principal'];

// A starting line for the designations a school is likely to have, so the list
// reads as sentences the first time it is opened rather than as bare names. Only
// ever a default: an admin edits it and this is never consulted again.
const DEFAULT_DESCRIPTIONS = {
    'teacher':          'General teacher access for academic activities',
    'class teacher':    'Handles class management and student records',
    'librarian':        'Manages library books and records',
    'principal':        'Full access to academic and administrative functions',
    'vice principal':   'Assists principal with academic and administrative tasks',
    'headmaster':       'Full access to academic and administrative functions',
    'headmistress':     'Full access to academic and administrative functions',
    'accountant':       'Manages fees, payroll and financial records',
    'admin':            'Administrative access across enabled modules',
    'counsellor':       'Supports student wellbeing and guidance',
    'counselor':        'Supports student wellbeing and guidance',
    'coordinator':      'Coordinates academics across classes and sections',
    'warden':           'Manages hostel admissions, rooms and mess',
    'lab assistant':    'Supports laboratory equipment and practicals',
    'sports teacher':   'Runs physical education and sports activities',
    'receptionist':     'Front desk, visitors and enquiries',
};

const defaultDescriptionFor = (name) => DEFAULT_DESCRIPTIONS[key(name)] || '';

const norm = (name) => String(name || '').trim();
const key  = (name) => norm(name).toLowerCase();

// ── Permission maps ──────────────────────────────────────────────────────────

const emptyPermissions = () => Object.fromEntries(MODULE_KEYS.map((k) => [k, NONE]));

// Normalise anything stored / posted into a complete, valid {key: level} map.
// Unknown keys are dropped; missing keys default to 'none'; 'admin' on a module
// with no administrative surface is downgraded to 'user'.
function sanitizePermissions(raw) {
    const out = emptyPermissions();
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
        if (!isModuleKey(k)) continue;
        const level = String(v || '').toLowerCase();
        if (!LEVELS.includes(level)) continue;
        out[k] = (level === ADMIN && !isAdminCapable(k)) ? USER : level;
    }
    return out;
}

// What a brand-new designation gets: normal access everywhere, plus the
// administrative grants its name historically implied.
function defaultPermissionsFor(name) {
    const out = Object.fromEntries(MODULE_KEYS.map((k) => [k, USER]));
    for (const mod of (LEGACY_ADMIN_GRANTS[key(name)] || [])) out[mod] = ADMIN;
    return out;
}

// Fallback for a designation with no row: preserve pre-module behaviour.
const legacyPermissionsFor = (name) => defaultPermissionsFor(name);

// AND the school's module flags over a designation's configured levels.
function gate(permissions, moduleFlags) {
    const out = emptyPermissions();
    for (const k of MODULE_KEYS) out[k] = moduleFlags[k] ? (permissions[k] || NONE) : NONE;
    return out;
}

// ── School snapshot (module flags + every designation's stored map) ───────────

const CACHE_TTL = Number(process.env.DESIGNATION_CACHE_TTL) || 60; // seconds
const cacheKey = (schoolId) => `desig:school:${schoolId}`;

async function loadSnapshot(schoolId) {
    const [school, rows] = await Promise.all([
        School.findById(schoolId).select('modules designations').lean(),
        Designation.find({ school: schoolId }).select('name permissions isActive').lean(),
    ]);
    const byName = {};
    for (const row of rows) {
        byName[key(row.name)] = {
            name: row.name,
            isActive: row.isActive !== false,
            permissions: sanitizePermissions(row.permissions),
        };
    }
    return {
        moduleFlags: schoolModuleFlags(school),
        designations: byName,
        configured: rows.length > 0,
    };
}

async function getSnapshot(schoolId) {
    if (!schoolId) return null;
    const redis = getCacheRedis();
    if (redis) {
        try {
            const raw = await redis.get(cacheKey(schoolId));
            if (raw) return JSON.parse(raw);
        } catch { /* fall through to DB */ }
    }
    const snapshot = await loadSnapshot(schoolId);
    if (redis) {
        try { await redis.set(cacheKey(schoolId), JSON.stringify(snapshot), 'EX', CACHE_TTL); }
        catch { /* best effort */ }
    }
    return snapshot;
}

// Called whenever a designation is written OR the Super Admin toggles a school's
// modules — both change what every teacher of that school may reach.
async function invalidate(schoolId) {
    const redis = getCacheRedis();
    if (!redis || !schoolId) return;
    try { await redis.del(cacheKey(schoolId)); } catch { /* best effort */ }
}

// ── Resolution ───────────────────────────────────────────────────────────────

// Effective permissions for one designation name, school flags already applied.
function resolveFromSnapshot(snapshot, designationName) {
    if (!snapshot) return { permissions: emptyPermissions(), source: 'no-school' };
    const row = snapshot.designations[key(designationName)];
    if (!row) {
        return {
            permissions: gate(legacyPermissionsFor(designationName), snapshot.moduleFlags),
            source: 'legacy',
        };
    }
    if (!row.isActive) {
        return { permissions: gate(emptyPermissions(), snapshot.moduleFlags), source: 'inactive' };
    }
    return { permissions: gate(row.permissions, snapshot.moduleFlags), source: 'designation' };
}

async function resolveDesignation(schoolId, designationName) {
    const snapshot = await getSnapshot(schoolId);
    return resolveFromSnapshot(snapshot, designationName);
}

const perRequest = new WeakMap();   // req → designation name promise
const userKey = (userId) => `desig:user:${userId}`;

// The designation name on a teacher's profile. This is read on every
// module-guarded request, so it is cached twice: per request (several guards on
// one route resolve once) and in Redis (so the common case costs no DB query).
// Reassignments call invalidateUser(); the TTL bounds anything that slips past.
async function loadTeacherDesignation(userId) {
    const redis = getCacheRedis();
    if (redis) {
        try {
            const hit = await redis.get(userKey(userId));
            if (hit !== null) return hit;
        } catch { /* fall through to DB */ }
    }
    const p = await TeacherProfile.findOne({ user: userId }).select('designation').lean().catch(() => null);
    const name = p?.designation || '';
    if (redis) {
        try { await redis.set(userKey(userId), name, 'EX', CACHE_TTL); } catch { /* best effort */ }
    }
    return name;
}

function teacherDesignation(req) {
    if (!req) return Promise.resolve('');
    if (!perRequest.has(req)) {
        perRequest.set(req, loadTeacherDesignation(req.userId).catch(() => ''));
    }
    return perRequest.get(req);
}

// Call after writing TeacherProfile.designation for a user.
async function invalidateUser(userId) {
    const redis = getCacheRedis();
    if (!redis || userId == null) return;
    try { await redis.del(userKey(userId)); } catch { /* best effort */ }
}

async function invalidateUsers(userIds) {
    const redis = getCacheRedis();
    if (!redis || !Array.isArray(userIds) || !userIds.length) return;
    try { await redis.del(...userIds.map(userKey)); } catch { /* best effort */ }
}

// Effective access for the user behind a request, for every module.
//   super_admin  — no school: administrative everywhere
//   school_admin — administrative on every module the school has enabled
//   teacher      — its designation's configured levels, school-gated
//   student/parent — normal access on every module the school has enabled
async function resolveRequestAccess(req) {
    const role = req.userRole;
    if (role === 'super_admin') {
        return {
            role,
            moduleFlags: Object.fromEntries(MODULE_KEYS.map((k) => [k, true])),
            permissions: Object.fromEntries(MODULE_KEYS.map((k) => [k, ADMIN])),
            designation: '',
            source: 'super-admin',
        };
    }
    const snapshot = await getSnapshot(req.schoolId);
    const moduleFlags = snapshot?.moduleFlags || schoolModuleFlags(null);

    if (role === 'teacher') {
        const designation = await teacherDesignation(req);
        const { permissions, source } = resolveFromSnapshot(snapshot, designation);
        return { role, moduleFlags, permissions, designation, source };
    }
    const level = role === 'school_admin' ? ADMIN : USER;
    return {
        role,
        moduleFlags,
        permissions: Object.fromEntries(MODULE_KEYS.map((k) => [k, moduleFlags[k] ? level : NONE])),
        designation: '',
        source: role,
    };
}

// Attaches (and memoises) the resolved access on the request so middleware and
// controllers downstream share one resolution.
async function requestAccess(req) {
    if (!req._moduleAccess) req._moduleAccess = resolveRequestAccess(req);
    return req._moduleAccess;
}

const meets = (level, required) => RANK[level || NONE] >= RANK[required || USER];

// ── Management (CRUD used by the designation controller) ─────────────────────

// Seeds one row per name in School.designations the first time a school opens
// the matrix, so existing schools arrive with their current list intact and
// their legacy privileges preserved.
async function ensureSeeded(schoolId, createdBy = null) {
    const existing = await Designation.countDocuments({ school: schoolId });
    if (existing > 0) return false;

    const school = await School.findById(schoolId).select('designations').lean();
    const names = (school?.designations?.length ? school.designations : DEFAULT_DESIGNATIONS)
        .map(norm).filter(Boolean);

    const seen = new Set();
    for (const name of names) {
        if (seen.has(key(name))) continue;
        seen.add(key(name));
        await Designation.create({
            school: schoolId,
            name,
            description: defaultDescriptionFor(name),
            permissions: defaultPermissionsFor(name),
            isActive: true,
            createdBy,
        });
    }
    await invalidate(schoolId);
    return true;
}

// Who holds each designation, keyed by lowercased name, split by the role of the
// holder: { total, teachers, admins }.
//
// Deleting a user leaves their TeacherProfile behind, so the profiles are joined
// back to existing users — otherwise orphaned rows inflate every count and block
// designations from being deleted. The split is by User.role rather than assumed
// from the profile: only teachers carry a profile today, but a designation the
// list reports as held by nobody must say so for the right reason.
async function holderCountsByDesignation(schoolId) {
    const profiles = await TeacherProfile.find({ school: schoolId }).select('designation user').lean();
    if (!profiles.length) return {};
    const users = await User.find({ _id: { $in: profiles.map((p) => String(p.user)) } })
        .select('_id role').lean();
    const roleById = new Map(users.map((u) => [String(u._id), u.role]));

    const counts = {};
    for (const p of profiles) {
        const role = roleById.get(String(p.user));
        if (!role) continue;
        const k = key(p.designation);
        if (!k) continue;
        const bucket = counts[k] || (counts[k] = { total: 0, teachers: 0, admins: 0 });
        bucket.total += 1;
        if (role === 'school_admin' || role === 'super_admin') bucket.admins += 1;
        else bucket.teachers += 1;
    }
    return counts;
}

// The same roll-up as a plain {name: count} map, for callers that only need to
// know whether a designation is still in use.
async function teacherCountsByDesignation(schoolId) {
    const counts = await holderCountsByDesignation(schoolId);
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.total]));
}

// Full matrix for the management screens: every designation with its stored
// levels, its effective (school-gated) levels and how many teachers hold it.
async function listWithPermissions(schoolId) {
    await ensureSeeded(schoolId);
    const [school, rows, counts] = await Promise.all([
        School.findById(schoolId).select('modules').lean(),
        Designation.find({ school: schoolId }).sort('name').lean(),
        holderCountsByDesignation(schoolId),
    ]);
    const moduleFlags = schoolModuleFlags(school);

    const designations = rows.map((r) => {
        const permissions = sanitizePermissions(r.permissions);
        const held = counts[key(r.name)] || { total: 0, teachers: 0, admins: 0 };
        return {
            _id: r._id,
            name: r.name,
            // Rows created before the field existed fall back to the stock line
            // for their name, so the list never shows a column of blanks.
            description: r.description || defaultDescriptionFor(r.name),
            isActive: r.isActive !== false,
            permissions,                                  // as configured
            effectivePermissions: gate(permissions, moduleFlags), // what users get today
            teacherCount: held.teachers,
            adminCount: held.admins,
            holderCount: held.total,
            createdAt: r.createdAt,
        };
    });
    return { designations, moduleFlags };
}

// Renaming has to follow the name through to the teachers holding it, because
// TeacherProfile.designation is the name string.
async function renameProfiles(schoolId, oldName, newName) {
    if (key(oldName) === key(newName)) return 0;
    const profiles = await TeacherProfile.find({ school: schoolId, designation: oldName }).select('_id user').lean();
    for (const p of profiles) {
        await TeacherProfile.findByIdAndUpdate(p._id, { $set: { designation: newName } });
    }
    await invalidateUsers(profiles.map((p) => String(p.user)));
    return profiles.length;
}

async function countTeachers(schoolId, name) {
    const counts = await teacherCountsByDesignation(schoolId);
    return counts[key(name)] || 0;
}

// Keeps the legacy School.designations dropdown source in step with the table,
// so screens that only need the name list keep working unchanged.
async function syncSchoolNames(schoolId) {
    const rows = await Designation.find({ school: schoolId, isActive: true }).sort('name').select('name').lean();
    const names = rows.map((r) => r.name).filter(Boolean);
    if (names.length) await School.findByIdAndUpdate(schoolId, { designations: names });
    return names;
}

module.exports = {
    ADMIN, USER, NONE, LEVELS, RANK, DEFAULT_DESIGNATIONS, CACHE_TTL,
    sanitizePermissions, defaultPermissionsFor, emptyPermissions, gate,
    getSnapshot, invalidate, resolveDesignation, resolveFromSnapshot,
    requestAccess, resolveRequestAccess, meets, teacherDesignation,
    invalidateUser, invalidateUsers,
    ensureSeeded, listWithPermissions, renameProfiles, countTeachers,
    teacherCountsByDesignation, holderCountsByDesignation, syncSchoolNames,
    defaultDescriptionFor,
};
