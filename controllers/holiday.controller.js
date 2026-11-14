'use strict';
const Holiday      = require('../models/Holiday');
const AcademicYear = require('../models/AcademicYear');
const Class        = require('../models/Class');
const XLSX         = require('xlsx');

const School = require('../models/School');
const { sheetTextProblem } = require('../middleware/textSafety');
const { withTransaction, lock } = require('../services/dbTx');

// Legacy slugs kept working alongside the school's own configured list
const LEGACY_TYPES = ['public', 'school_specific', 'optional', 'exam_break'];
const DEFAULT_HOLIDAY_TYPES = ['Public Holiday', 'School Specific', 'Optional Holiday', 'Exam Break'];

async function schoolHolidayTypes(schoolId) {
    const school = await School.findById(schoolId).select('holidayTypes').lean();
    return school?.holidayTypes?.length ? school.holidayTypes : DEFAULT_HOLIDAY_TYPES;
}

async function invalidType(schoolId, type) {
    const value = String(type || '').trim();
    if (!value) return 'Holiday type is required';
    const allowed = await schoolHolidayTypes(schoolId);
    if (allowed.includes(value) || LEGACY_TYPES.includes(value)) return null;
    return `Type must be one of: ${allowed.join(', ')}`;
}

// ── In-app notification after holiday creation ────────────────────────────────
const fmtDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function holidayDateRange(holiday) {
    const sStr = fmtDate(holiday.startDate);
    const eStr = fmtDate(holiday.endDate || holiday.startDate);
    return sStr === eStr ? sStr : `${sStr} – ${eStr}`;
}

// Resolve the users a holiday applies to, based on its applicability scope
async function holidayRecipients(holiday, schoolId) {
    const User  = require('../models/User');
    const scope = holiday.applicability?.scope || 'all';

    if (scope === 'specific_classes') {
        const classIds = (holiday.applicability?.classes || []).map(c => c._id || c);
        if (!classIds.length) return [];
        const ClassSection   = require('../models/ClassSection');
        const StudentProfile = require('../models/StudentProfile');
        const secs       = await ClassSection.find({ class: { $in: classIds }, school: schoolId }, 'enrolledStudents').lean();
        const studentIds = [...new Set(secs.flatMap(s => s.enrolledStudents.map(id => id.toString())))];
        const profiles   = await StudentProfile.find({ user: { $in: studentIds }, parent: { $ne: null } }, 'parent').lean();
        const parentIds  = [...new Set(profiles.map(p => p.parent.toString()))];
        const allIds     = [...new Set([...studentIds, ...parentIds])];
        if (!allIds.length) return [];
        return User.find({ _id: { $in: allIds }, isActive: true }, '_id').lean();
    }

    if (scope === 'specific_departments') {
        const depts = holiday.applicability?.departments || [];
        const roles = [];
        if (depts.includes('teaching_staff')) roles.push('teacher');
        if (depts.includes('admin_staff'))    roles.push('school_admin');
        if (!roles.length) return [];
        return User.find({ school: schoolId, role: { $in: roles }, isActive: true }, '_id').lean();
    }

    return User.find(
        { school: schoolId, role: { $in: ['teacher', 'student', 'parent'] }, isActive: true },
        '_id'
    ).lean();
}

async function sendHolidayNotification(holiday, schoolId, creatorId) {
    try {
        const recipients = await holidayRecipients(holiday, schoolId);
        if (!recipients.length) return;

        const typeLabel = holiday.type.replace(/_/g, ' ');

        const { notify } = require('../services/notifyService');
        notify({
            school:     schoolId,
            sender:     creatorId,
            senderRole: 'school_admin',
            title:      `🎉 Holiday: ${holiday.name}`,
            body:       `A ${typeLabel} holiday "${holiday.name}" has been scheduled on ${holidayDateRange(holiday)}.${holiday.description ? ' ' + holiday.description : ''}`,
            recipients,
            includeSender: true,
            link:       { type: 'holidays', entityId: holiday._id },
        });
    } catch (e) {
        console.error('[holiday-notif]', e.message);
    }
}

// ── In-app notification after a bulk XLSX/CSV import ──────────────────────────
// One summary notification for the whole batch instead of N separate ones, so a
// 30-row sheet doesn't spam every teacher/student/parent with 30 pushes.
const IMPORT_NOTIF_PREVIEW = 8;

async function sendImportedHolidaysNotification(holidays, schoolId, creatorId) {
    try {
        const list = (holidays || []).filter(Boolean);
        if (!list.length) return;
        if (list.length === 1) return sendHolidayNotification(list[0], schoolId, creatorId);

        // Imported rows are always school-wide
        const recipients = await holidayRecipients({ applicability: { scope: 'all' } }, schoolId);
        if (!recipients.length) return;

        const sorted  = [...list].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
        const preview = sorted.slice(0, IMPORT_NOTIF_PREVIEW)
            .map(h => `• ${h.name} — ${holidayDateRange(h)}`)
            .join('\n');
        const rest = sorted.length - IMPORT_NOTIF_PREVIEW;

        const { notify } = require('../services/notifyService');
        notify({
            school:     schoolId,
            sender:     creatorId,
            senderRole: 'school_admin',
            title:      `🎉 ${sorted.length} New Holidays Announced`,
            body:       `The holiday calendar has been updated:\n${preview}${rest > 0 ? `\n…and ${rest} more` : ''}`,
            recipients,
            includeSender: true,
            link:       { type: 'holidays' },
        });
    } catch (e) {
        console.error('[holiday-import-notif]', e.message);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return isNaN(val) ? null : val;
    const d = new Date(val);
    return isNaN(d) ? null : d;
}

/**
 * Which academic year a holiday belongs to.
 *
 * Every holiday used to be written with `academicYear: null`, which made the
 * year filter on the admin screen filter nothing and left the student/parent
 * read path leaning on the null branch of its own year scoping. The year a
 * holiday sits in is a fact about its start date, so it is derived from that —
 * falling back to the running year for a date outside every configured one.
 */
async function yearForDate(schoolId, date) {
    const years = await AcademicYear.find({ school: schoolId }).select('startDate endDate status').lean();
    if (!years.length) return null;
    const t = new Date(date).getTime();
    const containing = years.find(y =>
        y.startDate && y.endDate && t >= new Date(y.startDate).getTime() && t <= new Date(y.endDate).getTime());
    if (containing) return containing._id;
    return years.find(y => y.status === 'active')?._id || null;
}

/**
 * The school's academic years, in order, and which one is "this year" — the
 * one marked active, else the one today falls in (Nov 2026). Every holiday
 * screen opens on this year rather than on all of them.
 */
async function schoolYears(schoolId) {
    const { yearOrderSql } = require('../utils/listOrder');
    const { query } = require('../db/pool');
    const { rows } = await query(
        `SELECT "_id", "yearName", "status", "startDate", "endDate" FROM "academicyears"
          WHERE "school" = $1 ORDER BY ${yearOrderSql()}`,
        [String(schoolId)],
    );
    const now = Date.now();
    const current = rows.find((y) => y.status === 'active')
        || rows.find((y) => y.startDate && y.endDate
            && new Date(y.startDate).getTime() <= now && now <= new Date(y.endDate).getTime())
        || null;
    return {
        years: rows.map((y) => ({ _id: String(y._id), name: y.yearName, status: y.status })),
        currentYear: current ? String(current._id) : null,
    };
}

/**
 * The academicYear filter a read asks for: `year` = 'all' → none; a year id →
 * that year; absent → this year, plus the old rows written before holidays
 * carried a year (they were all this year's).
 */
async function yearFilter(req) {
    const wanted = String(req.query?.year || '');
    if (wanted === 'all') return undefined;
    if (wanted && wanted !== 'current') return wanted;
    const { currentYear } = await schoolYears(req.schoolId);
    return currentYear ? { $in: [currentYear, null] } : undefined;
}

// ── The same holiday is not added twice ──────────────────────────────────────
// Two holidays are the same holiday when they have the same type, the same
// first and last day, and reach some of the same people: a whole-school day
// reaches everyone; two class holidays meet only when they share a class. So
// "Public Holiday, 17 Nov" cannot be entered twice — under any name — while
// Class 5's picnic and Class 8's excursion on one day are two holidays.
const dayKeyOf = (d) => new Date(d).toISOString().slice(0, 10);
const reachOf = (h) => (h?.applicability?.scope === 'specific_classes'
    ? new Set((h.applicability.classes || []).map((c) => String(c?._id || c)))
    : null);                                       // null: the whole school
const reachesSame = (a, b) => !a || !b || [...a].some((x) => b.has(x));
const sameHoliday = (a, b) => a.type === b.type
    && dayKeyOf(a.startDate) === dayKeyOf(b.startDate) && dayKeyOf(a.endDate) === dayKeyOf(b.endDate)
    && reachesSame(reachOf(a), reachOf(b));

/** The holiday already on the calendar that `h` would repeat, or null. */
async function duplicateOf(schoolId, h, ignoreId = null) {
    const day = 86400000;
    const near = await Holiday.find({
        school: schoolId, type: h.type,
        startDate: { $gte: new Date(new Date(h.startDate).getTime() - day), $lte: new Date(new Date(h.startDate).getTime() + day) },
    }).lean();
    return near.find((x) => String(x._id) !== String(ignoreId || '') && sameHoliday(x, h)) || null;
}

const duplicateMessage = (dup) => {
    const one = dayKeyOf(dup.startDate) === dayKeyOf(dup.endDate);
    return `“${dup.name}” is already on the calendar as a ${dup.type} on ${one ? 'this date' : 'these dates'}. `
        + 'A holiday with the same date and type cannot be added again.';
};
const refuseDuplicate = (res, dup) => res.status(409).json({
    success: false, code: 'DUPLICATE_HOLIDAY', message: duplicateMessage(dup), existing: { _id: dup._id, name: dup.name },
});

// ── Admin: list ───────────────────────────────────────────────────────────────
exports.adminGetHolidays = async (req, res) => {
    try {
        const { type, academicYear } = req.query;
        const filter = { school: req.schoolId };
        if (type)         filter.type         = type;
        if (academicYear) filter.academicYear = academicYear;

        const holidays = await Holiday.find(filter)
            .populate('createdBy', 'name')
            .populate('academicYear', 'yearName year label')
            .sort({ startDate: 1 })
            .lean();
        // Every year the school has, and which is this one: the screen opens on
        // this year and can switch to any other, or to all of them.
        res.json({ success: true, data: holidays, ...(await schoolYears(req.schoolId)) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: create ─────────────────────────────────────────────────────────────
exports.adminCreateHoliday = async (req, res) => {
    try {
        const { name, startDate, endDate, type, description, isRecurring, academicYear, applicability } = req.body;

        if (!name?.trim())               return res.status(400).json({ success: false, message: 'Holiday name is required' });
        if (!startDate)                  return res.status(400).json({ success: false, message: 'Start date is required' });
        if (!endDate)                    return res.status(400).json({ success: false, message: 'End date is required' });
        const typeErr = await invalidType(req.schoolId, type);
        if (typeErr) return res.status(400).json({ success: false, message: typeErr });

        const start = new Date(startDate);
        const end   = new Date(endDate);
        if (end < start) return res.status(400).json({ success: false, message: 'End date must be on or after start date' });

        const doc = {
            school:       req.schoolId,
            name:         name.trim(),
            startDate:    start,
            endDate:      end,
            type,
            description:  description?.trim() || '',
            isRecurring:  !!isRecurring,
            academicYear: academicYear || await yearForDate(req.schoolId, start),
            createdBy:    req.userId,
            applicability: {
                // 'specific_departments' was removed from the form; anything
                // else unexpected falls back to school-wide.
                scope:   applicability?.scope === 'specific_classes' ? 'specific_classes' : 'all',
                classes: applicability?.scope === 'specific_classes' ? (applicability?.classes || []) : [],
            },
        };
        // Checked and saved under one lock per school, type and day, so two
        // presses of Save (or two admins) cannot both get the same holiday in.
        const { dup, holiday } = await withTransaction(async (tx) => {
            await lock(tx, `holiday:${req.schoolId}:${type}:${dayKeyOf(start)}`);
            const already = await duplicateOf(req.schoolId, doc);
            return already ? { dup: already } : { holiday: await Holiday.create(doc) };
        });
        if (dup) return refuseDuplicate(res, dup);

        // Fire-and-forget in-app notifications. Back-filling last year's
        // calendar should not ring every phone in the school, so the caller can
        // turn this off; leaving it out keeps the old always-notify behaviour.
        if (req.body.notify !== false) sendHolidayNotification(holiday, req.schoolId, req.userId);

        res.status(201).json({ success: true, data: holiday });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: update ─────────────────────────────────────────────────────────────
exports.adminUpdateHoliday = async (req, res) => {
    try {
        const { name, startDate, endDate, type, description, isRecurring, academicYear, applicability } = req.body;
        const update = { updatedBy: req.userId };

        if (name         !== undefined) update.name         = name.trim();
        if (startDate    !== undefined) update.startDate    = new Date(startDate);
        if (endDate      !== undefined) update.endDate      = new Date(endDate);
        if (description  !== undefined) update.description  = description.trim();
        if (isRecurring  !== undefined) update.isRecurring  = !!isRecurring;
        if (academicYear !== undefined) update.academicYear = academicYear || null;
        if (applicability !== undefined) {
            update.applicability = {
                scope:   applicability.scope === 'specific_classes' ? 'specific_classes' : 'all',
                classes: applicability.classes || [],
            };
        }
        if (type !== undefined) {
            const typeErr = await invalidType(req.schoolId, type);
            if (typeErr) return res.status(400).json({ success: false, message: typeErr });
            update.type = type;
        }

        const current = await Holiday.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!current) return res.status(404).json({ success: false, message: 'Holiday not found' });
        // What it will be once saved — which must not be a holiday already there.
        const next = { ...current, ...update };
        if (new Date(next.endDate) < new Date(next.startDate)) {
            return res.status(400).json({ success: false, message: 'End date must be on or after start date' });
        }
        // Asked only when the edit moves it — its type, its days or who it is
        // for. Renaming one of two look-alikes entered before this rule
        // existed is how they get told apart, and must not be refused.
        const footprint = (h) => [h.type, dayKeyOf(h.startDate), dayKeyOf(h.endDate), ...[...(reachOf(h) || ['all'])].sort()].join('|');
        if (footprint(next) !== footprint(current)) {
            const dup = await duplicateOf(req.schoolId, next, current._id);
            if (dup) return refuseDuplicate(res, dup);
        }

        const holiday = await Holiday.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            update,
            { new: true }
        ).lean();
        if (!holiday) return res.status(404).json({ success: false, message: 'Holiday not found' });
        res.json({ success: true, data: holiday });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: delete ─────────────────────────────────────────────────────────────
exports.adminDeleteHoliday = async (req, res) => {
    try {
        const holiday = await Holiday.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!holiday) return res.status(404).json({ success: false, message: 'Holiday not found' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: import XLSX/CSV ────────────────────────────────────────────────────
exports.adminImportHolidays = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        if (!rows.length) return res.status(400).json({ success: false, message: 'File is empty' });
        const textBad = sheetTextProblem(rows);
        if (textBad) return res.status(400).json({ success: false, message: textBad });

        const docs   = [];
        const errors = [];
        const allowedTypes = await schoolHolidayTypes(req.schoolId);
        const matchType = (raw) =>
            allowedTypes.find(t => t.toLowerCase() === raw.toLowerCase())
            || (LEGACY_TYPES.includes(raw.toLowerCase()) ? raw.toLowerCase() : null);

        rows.forEach((row, i) => {
            const lineNo      = i + 2;
            const name        = (row.name || row.Name || '').toString().trim();
            const rawStart    = row.startDate || row.start_date || row.StartDate || row.date || row.Date;
            const rawEnd      = row.endDate   || row.end_date   || row.EndDate   || rawStart;
            const rawType     = (row.type || row.Type || '').toString().trim();
            const description = (row.description || row.Description || '').toString().trim();

            if (!name)       { errors.push(`Row ${lineNo}: name is required`); return; }
            const startDate = parseDate(rawStart);
            if (!startDate) { errors.push(`Row ${lineNo}: invalid or missing startDate`); return; }
            const endDate = parseDate(rawEnd) || startDate;
            const type    = matchType(rawType) || allowedTypes[0];

            docs.push({
                _line: lineNo,
                school: req.schoolId, name, startDate, endDate, type, description,
                createdBy: req.userId,
                applicability: { scope: 'all', classes: [] },
            });
        });

        // A row that repeats a holiday already on the calendar — or an earlier
        // row of the same file — is left out and said so, like any other row
        // that cannot be imported.
        const fresh = [];
        for (const d of docs) {
            const inFile = fresh.find((x) => sameHoliday(x, d));
            const onCalendar = inFile ? null : await duplicateOf(req.schoolId, d);
            if (inFile || onCalendar) {
                errors.push(`Row ${d._line}: “${d.name}” has the same date and type as “${(inFile || onCalendar).name}”, which is ${inFile ? `row ${inFile._line} of this file` : 'already on the calendar'}`);
            } else fresh.push(d);
        }
        docs.length = 0;
        docs.push(...fresh);
        docs.forEach((d) => { delete d._line; });

        // A preview parses and reports, and writes nothing. It is the same code
        // path as the real import, so what it shows is what will land.
        const preview = req.query.preview === '1' || req.body?.preview === '1' || req.body?.preview === true;
        if (preview) {
            return res.json({
                success: true, preview: true, total: rows.length,
                valid: docs.length, invalid: errors.length,
                rows: docs.slice(0, 50).map(d => ({
                    name: d.name, startDate: d.startDate, endDate: d.endDate,
                    type: d.type, description: d.description,
                })),
                errors: errors.length ? errors : undefined,
            });
        }

        if (!docs.length)
            return res.status(400).json({ success: false, message: 'No valid rows to import', errors });

        for (const d of docs) d.academicYear = await yearForDate(req.schoolId, d.startDate);
        const created = await Holiday.insertMany(docs, { ordered: false });

        // Fire-and-forget in-app notification (pushed live over the WebSocket Gateway)
        if (req.body?.notify !== 'false') {
            sendImportedHolidaysNotification(created.length ? created : docs, req.schoolId, req.userId);
        }

        res.json({ success: true, imported: docs.length, errors: errors.length ? errors : undefined });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: holiday types (school-managed dropdown source) ────────────────────
exports.getHolidayTypes = async (req, res) => {
    try {
        res.json({ success: true, data: await schoolHolidayTypes(req.schoolId) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

/**
 * Rewrite the school's holiday-type list.
 *
 * Two rules the old version did not have.
 *
 * A type can be **renamed**, and the holidays wearing the old name are carried
 * across in the same request — deleting and re-adding used to leave every one
 * of those rows holding a type that no longer exists.
 *
 * A type **in use cannot be removed**. Nothing in the database points a holiday
 * at its type, so removing one silently orphaned however many holidays wore it;
 * the count comes back instead so the caller can say which ones.
 */
exports.updateHolidayTypes = async (req, res) => {
    try {
        let { holidayTypes, renames } = req.body;
        if (!Array.isArray(holidayTypes))
            return res.status(400).json({ success: false, message: 'holidayTypes must be an array' });

        // Trim, drop blanks, de-duplicate case-insensitively
        const seen = new Set();
        holidayTypes = holidayTypes
            .map(t => String(t || '').trim())
            .filter(t => {
                if (!t || seen.has(t.toLowerCase())) return false;
                seen.add(t.toLowerCase());
                return true;
            });
        if (!holidayTypes.length)
            return res.status(400).json({ success: false, message: 'Keep at least one holiday type' });

        const before = await schoolHolidayTypes(req.schoolId);

        // Renames first, so a renamed type is not then read as a removed one.
        const applied = [];
        for (const r of Array.isArray(renames) ? renames : []) {
            const from = String(r?.from || '').trim();
            const to   = String(r?.to || '').trim();
            if (!from || !to || from === to) continue;
            if (!holidayTypes.includes(to)) continue;      // renaming into a type nobody keeps
            if (!before.includes(from)) continue;          // renaming something that was never there
            const { modifiedCount } = await Holiday.updateMany(
                { school: req.schoolId, type: from }, { $set: { type: to } },
            );
            applied.push({ from, to, moved: modifiedCount ?? 0 });
        }

        const kept    = new Set(holidayTypes.map(t => t.toLowerCase()));
        const removed = before.filter(t => !kept.has(t.toLowerCase()));
        if (removed.length) {
            const inUse = [];
            for (const t of removed) {
                const count = await Holiday.countDocuments({ school: req.schoolId, type: t });
                if (count) inUse.push({ type: t, count });
            }
            if (inUse.length) {
                return res.status(409).json({
                    success: false, inUse,
                    message: inUse.map(u => `${u.count} holiday${u.count === 1 ? '' : 's'} still use "${u.type}"`).join('; ')
                        + '. Rename it, or change those holidays first.',
                });
            }
        }

        await School.updateOne({ _id: req.schoolId }, { $set: { holidayTypes } });
        res.json({ success: true, data: holidayTypes, renamed: applied });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: delete several at once ────────────────────────────────────────────
exports.adminBulkDeleteHolidays = async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
        if (!ids.length) return res.status(400).json({ success: false, message: 'Select at least one holiday' });
        // Scoped to the caller's school, so an id from elsewhere deletes nothing.
        const result = await Holiday.deleteMany({ _id: { $in: ids }, school: req.schoolId });
        res.json({ success: true, deleted: result?.deletedCount ?? 0 });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: export XLSX ────────────────────────────────────────────────────────
exports.adminExportHolidays = async (req, res) => {
    try {
        const holidays = await Holiday.find({ school: req.schoolId }).sort({ startDate: 1 }).lean();
        const rows = holidays.map(h => ({
            name:        h.name,
            startDate:   h.startDate?.toISOString().slice(0, 10) || '',
            endDate:     h.endDate?.toISOString().slice(0, 10)   || '',
            type:        h.type,
            description: h.description || '',
        }));
        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Holidays');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="holidays.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: download import template ──────────────────────────────────────────
exports.adminGetImportTemplate = async (req, res) => {
    try {
        // The sample rows wear THIS school's own types. The template used to
        // ship the legacy slugs ('public', 'school_specific'), which imported
        // as a type that is not in the school's list and then showed up as a
        // raw slug on the screen.
        const types = await schoolHolidayTypes(req.schoolId);
        const year  = new Date().getFullYear();
        const sample = [
            { name: 'Diwali',     startDate: `${year}-11-01`, endDate: `${year}-11-03`, type: types[0], description: 'Festival of lights' },
            { name: 'Annual Day', startDate: `${year}-12-15`, endDate: `${year}-12-15`, type: types[1] || types[0], description: 'Annual school celebration' },
            { name: 'Exam Break', startDate: `${year}-10-20`, endDate: `${year}-10-22`, type: types[2] || types[0], description: 'Mid-term exam break' },
        ];
        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(sample);
        XLSX.utils.book_append_sheet(wb, ws, 'Template');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="holiday_import_template.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Admin: audit log ──────────────────────────────────────────────────────────
exports.adminGetAuditLog = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const [holidays, total] = await Promise.all([
            Holiday.find({ school: req.schoolId })
                .populate('createdBy', 'name email')
                .populate('updatedBy', 'name email')
                .sort({ createdAt: -1 })
                .skip((page - 1) * +limit)
                .limit(+limit)
                .lean(),
            Holiday.countDocuments({ school: req.schoolId }),
        ]);
        res.json({ success: true, data: holidays, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

/**
 * Every class one student belongs to, and the name to show for it.
 *
 * Three routes, and they are not always in step: the profile's
 * `currentSection` pointer, the section's own `enrolledStudents` roster, and
 * `currentClass` — admitted to a class but not placed in a section yet, which
 * is still that class's holiday. Scoped to the school, so a stale roster row
 * elsewhere cannot pull in another school's class.
 */
async function studentClasses(userId, schoolId, profile) {
    const ClassSection = require('../models/ClassSection');

    const orConds = [{ enrolledStudents: userId }];
    if (profile?.currentSection) orConds.push({ _id: profile.currentSection });
    const sections = await ClassSection.find({ school: schoolId, $or: orConds }, 'class sectionName').lean();

    const classIds = new Set(sections.map((s) => s.class).filter(Boolean).map(String));
    if (profile?.currentClass) classIds.add(String(profile.currentClass));

    // The name follows the section the profile points at, not whichever row
    // the roster query happened to return first.
    const shown = sections.find((s) => String(s._id) === String(profile?.currentSection || ''))
        || sections.find((s) => s.sectionName) || null;
    const nameId = shown?.class || profile?.currentClass || null;
    const named = nameId ? await Class.findOne({ _id: nameId, school: schoolId }).select('className').lean() : null;

    return {
        classIds: [...classIds],
        className: [named?.className, shown?.sectionName].filter(Boolean).join(' '),
    };
}

// ── Read-only view for teacher / student ──────────────────────────────────────
// Filters by applicability so each role only sees relevant holidays. Parents
// have their own handler below — their answer is per child.
async function getApplicableHolidays(req, res) {
    try {
        const StudentProfile = require('../models/StudentProfile');

        // This academic year unless another is asked for (the admin screen's
        // "Applies to me" follows its year picker).
        const filter = { school: req.schoolId };
        const yr = await yearFilter(req);
        if (yr) filter.academicYear = yr;

        const allHolidays = await Holiday.find(filter).sort({ startDate: 1 }).lean();

        const role = req.userRole;

        const userClassIds = new Set();
        if (role === 'student') {
            const profile = await StudentProfile.findOne({ user: req.userId, school: req.schoolId })
                .select('currentSection currentClass').lean();
            (await studentClasses(req.userId, req.schoolId, profile)).classIds
                .forEach((id) => userClassIds.add(id));
        }
        // Teachers never see class-specific holidays — those are student/parent only

        const visible = allHolidays.filter(h => {
            const scope = h.applicability?.scope || 'all';

            if (scope === 'all') return true;

            if (scope === 'specific_departments') {
                const depts = h.applicability?.departments || [];
                if (role === 'teacher'      && depts.includes('teaching_staff')) return true;
                if (role === 'school_admin' && depts.includes('admin_staff'))    return true;
                return false;
            }

            if (scope === 'specific_classes') {
                if (userClassIds.size === 0) return false;
                const classIds = (h.applicability?.classes || []).map(c => c.toString());
                return classIds.some(id => userClassIds.has(id));
            }

            return true;
        });

        // The school's own type list travels with the holidays. A reader has to
        // name and colour a type the same way the admin screen does, and the
        // types endpoint is admin-only — so teacher and student views used to
        // fall back to a hardcoded list of four that no school actually had.
        res.json({ success: true, data: visible, types: await schoolHolidayTypes(req.schoolId) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
}

exports.adminGetMyHolidays = getApplicableHolidays;
exports.teacherGetHolidays = getApplicableHolidays;
exports.studentGetHolidays = getApplicableHolidays;

/**
 * A parent's holidays, told per child.
 *
 * The old version read `StudentProfile.findOne({ parent })` — **the first child
 * only**. A parent with two children in different classes saw one child's
 * class holidays and none of the other's, with nothing on screen to say a
 * second child existed.
 *
 * Every child is collected, and each holiday says which of them it is for:
 * a school-wide day covers all of them, a class day only the children in that
 * class. The page can then show one child at a time, or all of them together
 * with each day labelled.
 *
 * The child list is read from BOTH links — the parent's own `children` array
 * (which the dashboard and its child picker use) and each student profile's
 * `parent` pointer. They drift; reading only the pointer meant a child the
 * dashboard showed could be missing here, and a filter on `forChildren` then
 * emptied that child's calendar.
 */
exports.parentGetHolidays = async (req, res) => {
    try {
        const StudentProfile   = require('../models/StudentProfile');
        const { childCards }   = require('../services/parentChildren');

        const filter = { school: req.schoolId };
        const yr = await yearFilter(req);   // this academic year by default
        if (yr) filter.academicYear = yr;

        // Name, class and section exactly as every parent page's child switch
        // shows them; the class ids beside them decide which class days apply.
        const cards = await childCards(req.userId, req.schoolId);
        const profiles = cards.length
            ? await StudentProfile.find({ user: { $in: cards.map((c) => c._id) }, school: req.schoolId })
                .select('user currentSection currentClass').lean()
            : [];
        const profileOf = new Map(profiles.map((p) => [String(p.user), p]));

        const children = [];
        for (const c of cards) {
            const { classIds } = await studentClasses(c._id, req.schoolId, profileOf.get(c._id));
            children.push({ ...c, classIds });
        }

        const everyone = children.map((c) => c._id);
        const holidays = await Holiday.find(filter).sort({ startDate: 1 }).lean();

        const visible = [];
        for (const h of holidays) {
            const scope = h.applicability?.scope || 'all';
            if (scope === 'specific_departments') continue;   // staff days; not a parent's business
            if (scope === 'specific_classes') {
                const on = (h.applicability?.classes || []).map(String);
                const who = children.filter((c) => c.classIds.some((id) => on.includes(id))).map((c) => c._id);
                if (who.length) visible.push({ ...h, forChildren: who });
                continue;
            }
            visible.push({ ...h, forChildren: everyone });
        }

        res.json({
            success: true,
            data: visible,
            children: children.map(({ classIds, ...c }) => c),
            types: await schoolHolidayTypes(req.schoolId),
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Teacher: class-specific holidays for their assigned classes ───────────────
// Separate endpoint — shows class-specific holidays for classes the teacher is
// associated with (class teacher, substitute teacher, or subject teacher).
exports.teacherGetClassHolidays = async (req, res) => {
    try {
        const ClassSection          = require('../models/ClassSection');
        const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

        const filter = { school: req.schoolId };
        const yr = await yearFilter(req);   // this academic year by default
        if (yr) filter.academicYear = yr;

        const teacherClassIds = new Set();

        // 1. Class teacher or vice class teacher (substituteTeacher) of a section
        const directSections = await ClassSection.find(
            { $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }] },
            'class'
        ).lean();
        directSections.forEach(s => { if (s.class) teacherClassIds.add(s.class.toString()); });

        // 2. Subject teacher assigned to a section
        const subjectAssignments = await SectionSubjectTeacher.find(
            { teacher: req.userId },
            'section'
        ).lean();
        if (subjectAssignments.length) {
            const secIds = subjectAssignments.map(a => a.section);
            const subjectSections = await ClassSection.find({ _id: { $in: secIds } }, 'class').lean();
            subjectSections.forEach(s => { if (s.class) teacherClassIds.add(s.class.toString()); });
        }

        const types = await schoolHolidayTypes(req.schoolId);
        if (teacherClassIds.size === 0) {
            return res.json({ success: true, data: [], types, classes: [] });
        }

        const classHolidays = await Holiday.find({
            ...filter,
            'applicability.scope': 'specific_classes',
            'applicability.classes': { $in: [...teacherClassIds] },
        })
            .populate('applicability.classes', 'className')
            .sort({ startDate: 1 })
            .lean();

        // Only the teacher's own classes are named, even when a holiday also
        // covers classes they have nothing to do with — the filter above the
        // list offers what they teach, not the whole school.
        const mine = new Set([...teacherClassIds]);
        const rows = await Class.find({ _id: { $in: [...mine] } })
            .select('className classNumber').sort({ classNumber: 1 }).lean();

        // Classes repeat across academic years, so one teacher's sections can
        // point at three different rows all called "Class 1". The filter offers
        // the *name* once, and matches on the name, or picking it would find the
        // holidays hung on one of those rows and quietly miss the others.
        const names = [...new Set(rows.map((c) => c.className).filter(Boolean))];

        res.json({
            success: true,
            data: classHolidays.map((h) => ({
                ...h,
                // Which of the named classes are the reader's own; the rest are
                // other people's and are counted rather than listed.
                myClasses: [...new Set((h.applicability?.classes || [])
                    .filter((c) => mine.has(String(c._id)))
                    .map((c) => c.className)
                    .filter(Boolean))],
            })),
            types,
            classes: names,
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Super admin: cross-school audit ──────────────────────────────────────────
exports.superAdminAuditLog = async (req, res) => {
    try {
        const { schoolId, page = 1, limit = 30 } = req.query;
        const filter = schoolId ? { school: schoolId } : {};
        const [holidays, total] = await Promise.all([
            Holiday.find(filter)
                .populate('school',    'name')
                .populate('createdBy', 'name email')
                .sort({ createdAt: -1 })
                .skip((page - 1) * +limit)
                .limit(+limit)
                .lean(),
            Holiday.countDocuments(filter),
        ]);
        res.json({ success: true, data: holidays, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.superAdminExportAuditCSV = async (req, res) => {
    try {
        const { schoolId } = req.query;
        const filter = schoolId ? { school: schoolId } : {};
        const holidays = await Holiday.find(filter)
            .populate('school',    'name')
            .populate('createdBy', 'name')
            .sort({ createdAt: -1 })
            .lean();
        const rows = holidays.map(h => ({
            school:      h.school?.name    || '',
            name:        h.name,
            startDate:   h.startDate?.toISOString().slice(0, 10) || '',
            endDate:     h.endDate?.toISOString().slice(0, 10)   || '',
            type:        h.type,
            description: h.description || '',
            createdBy:   h.createdBy?.name  || '',
            createdAt:   h.createdAt?.toISOString()              || '',
        }));
        const wb  = XLSX.utils.book_new();
        const ws  = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Holidays');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="holidays_audit.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
