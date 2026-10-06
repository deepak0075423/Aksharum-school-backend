'use strict';
/**
 * Private uploads (Oct 2026).
 *
 * These folders used to be served to anyone who had the address — no login:
 *
 *   student-docs     admission papers: Aadhaar, birth, caste, medical and
 *                    disability certificates, TC (and guardians' Aadhaar/PAN)
 *   staff-docs       staff identity papers, joining / experience letters
 *   leave-docs       leave and comp-off attachments (sick-leave certificates)
 *   attendance-docs  attendance-correction attachments
 *   documents        the Documents module's files, comments, assignment
 *                    submissions, and Video Learning assets
 *
 * Now a file there is served only to a signed-in reader whom the rule for its
 * folder allows. The reader is named by a FILE TOKEN — a 12-hour JWT from
 * GET /api/auth/file-token, sent as the `aks_ft` cookie (the web app sets it,
 * so every <img>, link and frame keeps working), as `?ft=` (the phone app adds
 * it) or as an ordinary `Authorization: Bearer` session token. File tokens are
 * signed with a key derived from JWT_SECRET, so one can never pass as a session.
 *
 * A profile photo stays public — avatars are drawn on every list — but only a
 * file that IS someone's photo: users.profileImage, a student's photoFile or a
 * guardian's. Every other file in the folder needs the token.
 *
 * Who may read (super admins always; everyone else only inside their school):
 *   student-docs     school admins, the student, the student's parents
 *                    (a guardian's paper: the guardian too)
 *   staff-docs       school admins, the staff member, Employee Directory admins
 *   leave-docs       school admins, the applicant, leave admins and the
 *                    designations the leave type's policy lets approve
 *   attendance-docs  school admins, attendance admins, the student and their
 *                    parents, the section's class and vice class teacher
 *   documents        anyone signed in at the school the file belongs to (the
 *                    Documents module decides who is shown the link); a Video
 *                    Learning asset, anyone signed in
 */
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const FOLDERS = ['student-docs', 'staff-docs', 'leave-docs', 'attendance-docs', 'documents'];
const PHOTO_FOLDERS = new Set(['student-docs', 'staff-docs']);
const IMAGE = /\.(jpe?g|png|gif|webp|svg|heic|heif|avif)$/i;
const TOKEN_HOURS = 12;
const COOKIE = 'aks_ft';
const UPLOADS = path.join(__dirname, '..', 'uploads');

const q = async (sql, params) => (await pool.query(sql, params)).rows;

/* ── File tokens ─────────────────────────────────────────────────────────── */

const secret = () => crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('aksharum:file-access:v1').digest('hex');

/** A token naming this reader, for files only. */
function issueToken(user) {
    const sid = user.school?._id || user.school || null;
    const token = jwt.sign(
        { uid: String(user._id), role: user.role, sid: sid ? String(sid) : null, purpose: 'files' },
        secret(),
        { expiresIn: `${TOKEN_HOURS}h` },
    );
    return { token, expiresIn: TOKEN_HOURS * 3600, cookie: COOKIE };
}

function readFileToken(token) {
    try {
        const d = jwt.verify(String(token), secret());
        return d.purpose === 'files' ? { uid: d.uid, role: d.role, sid: d.sid } : null;
    } catch { return null; }
}

function readSessionToken(token) {
    try {
        const d = jwt.verify(String(token), process.env.JWT_SECRET);
        if (d.purpose) return null;   // not a session (see middleware/auth)
        return d.userId ? { uid: String(d.userId) } : null;
    } catch { return null; }
}

function cookieOf(req, name) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
        }
    }
    return null;
}

/* ── The reader ──────────────────────────────────────────────────────────── */

const viewerCache = new Map();   // uid → { v, until }
async function loadViewer(uid) {
    const hit = viewerCache.get(uid);
    if (hit && hit.until > Date.now()) return hit.v;
    const [u] = await q(
        `SELECT u."_id"::text AS uid, u."role", u."school"::text AS sid, u."isActive", s."isActive" AS "schoolActive"
           FROM "users" u LEFT JOIN "schools" s ON s."_id" = u."school" WHERE u."_id"::text = $1 LIMIT 1`,
        [uid],
    );
    const v = u && u.isActive !== false && (u.role === 'super_admin' || u.schoolActive !== false)
        ? { uid: u.uid, role: u.role, sid: u.sid } : null;
    viewerCache.set(uid, { v, until: Date.now() + 60 * 1000 });
    return v;
}

/** The signed-in reader of a request for a file, or null. */
async function viewerOf(req) {
    const auth = req.headers.authorization || '';
    const named = (auth.startsWith('Bearer ') && (readFileToken(auth.slice(7)) || readSessionToken(auth.slice(7))))
        || (req.query?.ft && readFileToken(req.query.ft))
        || (cookieOf(req, COOKIE) && readFileToken(cookieOf(req, COOKIE)));
    if (!named?.uid) return null;
    // Whatever the token says, the account decides: a deactivated user, or a
    // switched-off school, reads nothing more.
    return loadViewer(named.uid);
}

/* ── Profile photos stay public ──────────────────────────────────────────── */

const photoCache = new Map();   // folder/name → { ok, until }
async function isPhoto(folder, name) {
    const key = `${folder}/${name}`;
    const hit = photoCache.get(key);
    if (hit && hit.until > Date.now()) return hit.ok;
    const [r] = await q(
        `SELECT (EXISTS (SELECT 1 FROM "users" WHERE "profileImage" LIKE $1)
              OR EXISTS (SELECT 1 FROM "studentprofiles" WHERE "photoFile" = $2)
              OR EXISTS (SELECT 1 FROM "parentprofiles"
                          WHERE "father"->>'photoFile' = $2 OR "mother"->>'photoFile' = $2 OR "guardian"->>'photoFile' = $2)) AS ok`,
        [`%/${folder}/${name}`, name],
    );
    const ok = !!r?.ok;
    photoCache.set(key, { ok, until: Date.now() + (ok ? 10 * 60 * 1000 : 30 * 1000) });
    return ok;
}

/* ── Who owns a file, folder by folder ───────────────────────────────────── */

// The "…File" columns of a profile table, read once — a new upload field is covered without an edit here.
const fileColumns = {};
async function columnsOf(table) {
    if (fileColumns[table]) return fileColumns[table];
    const rows = await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name LIKE '%File' ORDER BY column_name`,
        [table],
    );
    fileColumns[table] = rows.map((r) => r.column_name);
    return fileColumns[table];
}
const GUARDIAN_KEYS = ['aadhaarFrontFile', 'aadhaarBackFile', 'panCardFile', 'photoFile'];

async function parentOf(parentId, studentId) {
    const [r] = await q(
        `SELECT (EXISTS (SELECT 1 FROM "parentprofiles" WHERE "user"::text = $1 AND "children" @> to_jsonb($2::text))
              OR EXISTS (SELECT 1 FROM "studentprofiles" WHERE "user"::text = $2 AND "parent"::text = $1)) AS ok`,
        [parentId, studentId],
    );
    return !!r?.ok;
}

const adminCache = new Map();   // school|module → { ids:Set, until }
async function moduleAdmins(schoolId, moduleKey) {
    const key = `${schoolId}|${moduleKey}`;
    const hit = adminCache.get(key);
    if (hit && hit.until > Date.now()) return hit.ids;
    let ids = new Set();
    try { ids = new Set((await require('./designationService').moduleAdminIds(schoolId, moduleKey)).map(String)); }
    catch (e) { console.error('[privateFiles] module admins:', e.message); }
    adminCache.set(key, { ids, until: Date.now() + 60 * 1000 });
    return ids;
}

const RULES = {
    async 'student-docs'(v, name) {
        const cols = await columnsOf('studentprofiles');
        const students = cols.length ? await q(
            `SELECT "user"::text AS owner, "school"::text AS school FROM "studentprofiles"
              WHERE $1 IN (${cols.map((c) => `"${c}"`).join(', ')})`, [name]) : [];
        const guardians = await q(
            `SELECT "user"::text AS owner, "school"::text AS school,
                    COALESCE("children", '[]'::jsonb) AS children FROM "parentprofiles"
              WHERE $1 IN (${['father', 'mother', 'guardian'].flatMap((g) => GUARDIAN_KEYS.map((k) => `"${g}"->>'${k}'`)).join(', ')})`, [name]);
        for (const s of students) {
            if (v.sid !== s.school) continue;
            if (v.role === 'school_admin' || v.uid === s.owner) return true;
            if (v.role === 'parent' && await parentOf(v.uid, s.owner)) return true;
        }
        for (const g of guardians) {
            if (v.sid !== g.school) continue;
            if (v.role === 'school_admin' || v.uid === g.owner) return true;
        }
        return false;
    },

    async 'staff-docs'(v, name) {
        const cols = await columnsOf('teacherprofiles');
        if (!cols.length) return false;
        const rows = await q(
            `SELECT "user"::text AS owner, "school"::text AS school FROM "teacherprofiles"
              WHERE $1 IN (${cols.map((c) => `"${c}"`).join(', ')})`, [name]);
        for (const r of rows) {
            if (v.sid !== r.school) continue;
            if (v.role === 'school_admin' || v.uid === r.owner) return true;
            if (v.role === 'teacher' && (await moduleAdmins(r.school, 'employeeDirectory')).has(v.uid)) return true;
        }
        return false;
    },

    async 'leave-docs'(v, name) {
        const rows = await q(
            `SELECT "teacher"::text AS owner, "school"::text AS school, "leaveType"::text AS "leaveType", 'leave' AS kind
               FROM "leaveapplications" WHERE "document" = $1 OR "document" LIKE $2
             UNION ALL
             SELECT "teacher"::text, "school"::text, NULL, 'compoff'
               FROM "compoffrequests" WHERE "document" = $1 OR "document" LIKE $2`,
            [name, `%/${name}`],
        );
        for (const r of rows) {
            if (v.sid !== r.school) continue;
            if (v.role === 'school_admin' || v.uid === r.owner) return true;
            if (v.role !== 'teacher') continue;
            if ((await moduleAdmins(r.school, 'leave')).has(v.uid)) return true;
            // The designations this leave type lets sign off see what they are asked to sign off.
            try {
                const lp = require('./leavePolicyService');
                if (r.kind === 'leave' && r.leaveType) {
                    const policy = await lp.getPolicy(r.school, r.leaveType);
                    if (policy && await lp.canApprove(v.uid, v.role, r.school, policy)) return true;
                } else if (r.kind === 'compoff') {
                    const cs = require('./compOffService');
                    const policy = typeof cs.getPolicy === 'function' ? await cs.getPolicy(r.school) : null;
                    if (policy && await cs.canApprove(v.uid, v.role, r.school, policy)) return true;
                }
            } catch (e) { console.error('[privateFiles] leave approver:', e.message); }
        }
        return false;
    },

    async 'attendance-docs'(v, name) {
        const rows = await q(
            `SELECT ac."student"::text AS owner, ac."school"::text AS school,
                    cs."classTeacher"::text AS ct, cs."substituteTeacher"::text AS vt
               FROM "attendancecorrections" ac LEFT JOIN "classsections" cs ON cs."_id" = ac."section"
              WHERE ac."attachments"::text LIKE $1 OR ac."history"::text LIKE $1`,
            [`%${name.replace(/[%_\\]/g, (m) => `\\${m}`)}%`],
        );
        for (const r of rows) {
            if (v.sid !== r.school) continue;
            if (v.role === 'school_admin' || v.uid === r.owner) return true;
            if (v.role === 'parent' && await parentOf(v.uid, r.owner)) return true;
            if (v.role === 'teacher' && (v.uid === r.ct || v.uid === r.vt || (await moduleAdmins(r.school, 'attendance')).has(v.uid))) return true;
        }
        return false;
    },

    async documents(v, name) {
        const pat = `%${name.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
        const rows = await q(
            `SELECT "school"::text AS school FROM "documents" WHERE "files"::text LIKE $1
             UNION ALL SELECT "school"::text FROM "documentversions" WHERE "files"::text LIKE $1
             UNION ALL SELECT "school"::text FROM "documentcomments" WHERE "files"::text LIKE $1
             UNION ALL SELECT "school"::text FROM "assignmentsubmissions" WHERE "files"::text LIKE $1
             UNION ALL SELECT '*' FROM "videoassets" WHERE "fileUrl" LIKE $1`,
            [pat],
        ).catch(() => []);
        return rows.some((r) => r.school === '*' || (r.school && r.school === v.sid));
    },
};

const decisionCache = new Map();   // uid|folder/name → { ok, until }
async function canRead(viewer, folder, name) {
    if (!viewer) return false;
    if (viewer.role === 'super_admin') return true;
    const key = `${viewer.uid}|${folder}/${name}`;
    const hit = decisionCache.get(key);
    if (hit && hit.until > Date.now()) return hit.ok;
    let ok = false;
    try { ok = !!(await RULES[folder]?.(viewer, name)); }
    catch (e) { console.error(`[privateFiles] ${folder}:`, e.message); ok = false; }
    if (decisionCache.size > 20000) decisionCache.clear();
    decisionCache.set(key, { ok, until: Date.now() + 60 * 1000 });
    return ok;
}

/* ── The guard in front of express.static ────────────────────────────────── */

/**
 * For /uploads/<folder>/<name> in one of FOLDERS: a public photo goes on to
 * express.static; anything else is sent here, privately, or refused.
 * Returns true when it has answered the request.
 */
async function serve(req, res, folder, name) {
    if (!name || name.includes('/') || name.startsWith('.')) {
        res.status(404).json({ success: false, message: 'File not found' });
        return true;
    }
    if (PHOTO_FOLDERS.has(folder) && IMAGE.test(name) && await isPhoto(folder, name)) return false;
    const viewer = await viewerOf(req);
    if (!viewer) {
        res.status(401).json({ success: false, code: 'FILE_SIGN_IN', message: 'Sign in to open this file' });
        return true;
    }
    if (!(await canRead(viewer, folder, name))) {
        res.status(403).json({ success: false, code: 'FILE_FORBIDDEN', message: 'You do not have access to this file' });
        return true;
    }
    const abs = path.join(UPLOADS, folder, name);
    if (!abs.startsWith(path.join(UPLOADS, folder) + path.sep)) {
        res.status(404).json({ success: false, message: 'File not found' });
        return true;
    }
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.sendFile(abs, { dotfiles: 'deny' }, (err) => {
        if (err && !res.headersSent) res.status(err.statusCode === 404 || err.code === 'ENOENT' ? 404 : 500).json({ success: false, message: 'File not found' });
    });
    return true;
}

module.exports = { FOLDERS, COOKIE, TOKEN_HOURS, issueToken, readFileToken, viewerOf, isPhoto, canRead, serve };
