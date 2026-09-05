'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Teacher designations and the module access they grant.
//
//  Scope: a school_admin manages their own school (req.schoolId); a super_admin
//  manages any school by passing it in the route (/schools/:schoolId/...) or as
//  ?schoolId=. resolveSchool() below is the only place that decides, so every
//  handler works for both callers.
//
//  The matrix a client renders lists ONLY the modules the school has enabled;
//  levels configured for a module that is currently disabled are kept in the row
//  (never pruned) and reported separately, so re-enabling the module restores
//  them untouched.
// ─────────────────────────────────────────────────────────────────────────────
const XLSX        = require('xlsx');
const Designation = require('../models/Designation');
const School      = require('../models/School');
const User        = require('../models/User');
const TeacherProfile = require('../models/TeacherProfile');
const svc         = require('../services/designationService');
const { MODULES } = require('../config/modules');

const jsonOk  = (res, data, status = 200) => res.status(status).json({ success: true, data });
const jsonErr = (res, err, status = 500)  => res.status(status).json({ success: false, message: err.message || err });
const bad     = (res, message)            => res.status(400).json({ success: false, message });

// Which school this request is about, or null when the caller may not touch it.
async function resolveSchool(req, res) {
    if (req.userRole === 'super_admin') {
        const schoolId = req.params.schoolId || req.query.schoolId;
        if (!schoolId) { bad(res, 'schoolId is required'); return null; }
        const school = await School.findById(schoolId).select('_id name').lean();
        if (!school) { res.status(404).json({ success: false, message: 'School not found' }); return null; }
        return school._id;
    }
    if (!req.schoolId) { res.status(400).json({ success: false, message: 'No school on this account' }); return null; }
    return req.schoolId;
}

const nameTaken = async (schoolId, name, exceptId = null) => {
    const rows = await Designation.find({ school: schoolId }).select('_id name').lean();
    const wanted = String(name).trim().toLowerCase();
    return rows.some((r) => r.name.trim().toLowerCase() === wanted && String(r._id) !== String(exceptId));
};

// ── Read ─────────────────────────────────────────────────────────────────────

// GET /designations/matrix — everything a management screen needs in one call.
exports.getMatrix = async (req, res) => {
    try {
        const schoolId = await resolveSchool(req, res);
        if (!schoolId) return;

        const { designations, moduleFlags } = await svc.listWithPermissions(schoolId);
        const modules = MODULES.map((m) => ({
            key: m.key,
            label: m.label,
            icon: m.icon,
            description: m.description,
            adminCapable: m.adminCapable,
            enabled: !!moduleFlags[m.key],
        }));
        jsonOk(res, {
            designations,
            modules,                                            // every module, with its school-level state
            enabledModules: modules.filter((m) => m.enabled).map((m) => m.key),
            levels: svc.LEVELS,
        });
    } catch (err) { jsonErr(res, err); }
};

// ── Write ────────────────────────────────────────────────────────────────────

exports.create = async (req, res) => {
    try {
        const schoolId = await resolveSchool(req, res);
        if (!schoolId) return;

        const name = String(req.body.name || '').trim();
        if (!name) return bad(res, 'Designation name is required');
        if (name.length > 60) return bad(res, 'Designation name must be 60 characters or fewer');
        await svc.ensureSeeded(schoolId, req.userId);
        if (await nameTaken(schoolId, name)) return bad(res, `"${name}" already exists`);

        // No permissions posted → sensible starting point rather than a locked-out row.
        const permissions = req.body.permissions
            ? svc.sanitizePermissions(req.body.permissions)
            : svc.defaultPermissionsFor(name);

        const description = String(req.body.description || '').trim();
        if (description.length > 160) return bad(res, 'Description must be 160 characters or fewer');

        const row = await Designation.create({
            school: schoolId,
            name,
            description: description || svc.defaultDescriptionFor(name),
            permissions,
            isActive: req.body.isActive === undefined ? true : !!req.body.isActive,
            createdBy: req.userId || null,
        });
        await svc.invalidate(schoolId);
        await svc.syncSchoolNames(schoolId);
        jsonOk(res, {
            _id: row._id, name: row.name, description: row.description, permissions, isActive: row.isActive,
        }, 201);
    } catch (err) { jsonErr(res, err); }
};

exports.update = async (req, res) => {
    try {
        const schoolId = await resolveSchool(req, res);
        if (!schoolId) return;

        const row = await Designation.findById(req.params.id).lean();
        if (!row || String(row.school) !== String(schoolId)) {
            return res.status(404).json({ success: false, message: 'Designation not found' });
        }

        const update = {};
        let renamed = 0;

        if (req.body.name !== undefined) {
            const name = String(req.body.name).trim();
            if (!name) return bad(res, 'Designation name is required');
            if (name.length > 60) return bad(res, 'Designation name must be 60 characters or fewer');
            if (await nameTaken(schoolId, name, row._id)) return bad(res, `"${name}" already exists`);
            if (name !== row.name) {
                update.name = name;
                // TeacherProfile.designation stores the name, so the rename has to
                // follow through or every teacher holding it loses its permissions.
                renamed = await svc.renameProfiles(schoolId, row.name, name);
            }
        }
        if (req.body.description !== undefined) {
            const description = String(req.body.description).trim();
            if (description.length > 160) return bad(res, 'Description must be 160 characters or fewer');
            update.description = description;
        }
        if (req.body.permissions !== undefined) {
            // Merged over what is stored, so a client that only knows about the
            // school's currently-enabled modules cannot wipe the levels held for
            // a module that is temporarily disabled.
            update.permissions = svc.sanitizePermissions({
                ...svc.sanitizePermissions(row.permissions),
                ...req.body.permissions,
            });
        }
        if (req.body.isActive !== undefined) update.isActive = !!req.body.isActive;

        if (Object.keys(update).length) await Designation.findByIdAndUpdate(row._id, { $set: update });
        await svc.invalidate(schoolId);
        await svc.syncSchoolNames(schoolId);

        jsonOk(res, {
            _id: row._id,
            name: update.name ?? row.name,
            description: update.description ?? (row.description || ''),
            permissions: update.permissions ?? svc.sanitizePermissions(row.permissions),
            isActive: update.isActive ?? (row.isActive !== false),
            teachersRenamed: renamed,
        });
    } catch (err) { jsonErr(res, err); }
};

// Bulk save of the whole matrix — one request per screen-save instead of one per
// designation, which keeps the cache invalidation to a single round.
exports.updateMatrix = async (req, res) => {
    try {
        const schoolId = await resolveSchool(req, res);
        if (!schoolId) return;

        const items = Array.isArray(req.body.designations) ? req.body.designations : null;
        if (!items) return bad(res, 'designations must be an array');

        const rows = await Designation.find({ school: schoolId }).lean();
        const byId = new Map(rows.map((r) => [String(r._id), r]));
        let saved = 0;

        for (const item of items) {
            const row = byId.get(String(item._id));
            if (!row) continue;
            const merged = svc.sanitizePermissions({
                ...svc.sanitizePermissions(row.permissions),
                ...(item.permissions || {}),
            });
            const update = { permissions: merged };
            if (item.isActive !== undefined) update.isActive = !!item.isActive;
            await Designation.findByIdAndUpdate(row._id, { $set: update });
            saved += 1;
        }
        await svc.invalidate(schoolId);
        jsonOk(res, { saved });
    } catch (err) { jsonErr(res, err); }
};

exports.remove = async (req, res) => {
    try {
        const schoolId = await resolveSchool(req, res);
        if (!schoolId) return;

        const row = await findScoped(req, res, schoolId);
        if (!row) return;

        // Deleting a designation that teachers still hold would silently drop them
        // to the legacy fallback permissions, so it is refused. The blocking
        // teachers travel back with the error — the client shows them straight
        // away and offers the same list as a spreadsheet, no second request.
        const teachers = await loadTeachers(schoolId, row.name);
        if (teachers.length > 0) {
            const n = teachers.length;
            return res.status(400).json({
                success: false,
                code: 'DESIGNATION_IN_USE',
                message: `Cannot delete "${row.name}" — ${n} teacher${n === 1 ? '' : 's'} still ${n === 1 ? 'has' : 'have'} this designation. Reassign ${n === 1 ? 'them' : 'them all'} to another designation first.`,
                designation: row.name,
                teacherCount: n,
                teachers,
            });
        }
        const remaining = await Designation.countDocuments({ school: schoolId });
        if (remaining <= 1) return bad(res, 'At least one designation is required');

        await Designation.findByIdAndDelete(row._id);
        await svc.invalidate(schoolId);
        await svc.syncSchoolNames(schoolId);
        jsonOk(res, { deleted: true });
    } catch (err) { jsonErr(res, err); }
};

// ── Teachers holding a designation ───────────────────────────────────────────
// Used three ways: the list screen, the Excel export, and the error payload when
// a delete is refused because the designation is still assigned. Orphaned
// profiles (user deleted, profile left behind) are dropped — they are not people
// and must not block a delete, which is the same rule
// designationService.countTeachers applies.
const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

async function loadTeachers(schoolId, designationName) {
    const profiles = await TeacherProfile.find({ school: schoolId, designation: designationName })
        .select('user employeeId department gender joiningDate phone subjects classes').lean();
    if (!profiles.length) return [];

    const users = await User.find({ _id: { $in: profiles.map((p) => String(p.user)) } })
        .select('name email phone isActive').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));

    return profiles
        .filter((p) => byId.has(String(p.user)))
        .map((p) => {
            const u = byId.get(String(p.user));
            return {
                _id: String(p.user),
                employeeId: p.employeeId || '',
                name: u.name || '',
                email: u.email || '',
                phone: u.phone || p.phone || '',
                department: p.department || '',
                gender: p.gender || '',
                joiningDate: fmtDate(p.joiningDate),
                subjects: Array.isArray(p.subjects) ? p.subjects.join(', ') : '',
                classes: Array.isArray(p.classes) ? p.classes.join(', ') : '',
                isActive: u.isActive !== false,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

// The designation, checked against the caller's scope.
async function findScoped(req, res, schoolId) {
    const row = await Designation.findById(req.params.id).lean();
    if (!row || String(row.school) !== String(schoolId)) {
        res.status(404).json({ success: false, message: 'Designation not found' });
        return null;
    }
    return row;
}

// GET /designations/:id/teachers — who inherits this designation's permissions.
exports.getTeachers = async (req, res) => {
    try {
        const schoolId = await resolveSchool(req, res);
        if (!schoolId) return;
        const row = await findScoped(req, res, schoolId);
        if (!row) return;

        const teachers = await loadTeachers(schoolId, row.name);
        jsonOk(res, { designation: row.name, teacherCount: teachers.length, teachers });
    } catch (err) { jsonErr(res, err); }
};

// GET /designations/:id/teachers/export — the same list as an .xlsx, so an admin
// refused a delete can take the list away and reassign from it.
exports.exportTeachers = async (req, res) => {
    try {
        const schoolId = await resolveSchool(req, res);
        if (!schoolId) return;
        const row = await findScoped(req, res, schoolId);
        if (!row) return;

        const teachers = await loadTeachers(schoolId, row.name);
        const headers = [
            'Employee ID', 'Teacher Name', 'Email', 'Phone', 'Designation',
            'Department', 'Gender', 'Joining Date', 'Subjects', 'Classes', 'Status',
        ];
        const rows = teachers.map((t) => [
            t.employeeId, t.name, t.email, t.phone, row.name,
            t.department, t.gender, t.joiningDate, t.subjects, t.classes,
            t.isActive ? 'Active' : 'Inactive',
        ]);

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
        // Phone numbers must stay text or Excel eats the leading zero / goes scientific.
        rows.forEach((_, i) => {
            const cell = XLSX.utils.encode_cell({ r: i + 1, c: 3 });
            if (ws[cell]) { ws[cell].t = 's'; ws[cell].z = '@'; }
        });
        ws['!cols'] = [
            { wch: 14 }, { wch: 24 }, { wch: 30 }, { wch: 15 }, { wch: 18 },
            { wch: 18 }, { wch: 10 }, { wch: 14 }, { wch: 26 }, { wch: 20 }, { wch: 10 },
        ];
        XLSX.utils.book_append_sheet(wb, ws, 'Teachers');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        const safe = row.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'designation';
        res.setHeader('Content-Disposition', `attachment; filename="${safe}-teachers.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) { jsonErr(res, err); }
};
