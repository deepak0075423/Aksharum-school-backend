'use strict';
const Subject             = require('../models/Subject');
const ClassSubject        = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Class               = require('../models/Class');
const ClassSection        = require('../models/ClassSection');
const AcademicYear        = require('../models/AcademicYear');
const { syncSectionChatGroup } = require('../services/sectionChatService');
const { inactiveTeacherError } = require('../utils/activeTeacher');

// `meta` rides alongside `data` in the envelope — useFetch on the client hands
// the whole envelope back as `meta`, so a caller can read counts without them
// having to be smuggled into the array.
const ok  = (res, d, s=200, meta=null) => res.status(s).json({ success: true, data: d, ...(meta || {}) });
const err = (res, e, s=500) => res.status(s).json({ success: false, message: e.message||e });

/**
 * One year's subjects.
 *
 * A Subject belongs to a single academic year, so this always filters by one.
 * `?academicYear=<id>` names it; without the parameter the school's ACTIVE year
 * is used, which is what every dropdown in the app wants — a timetable or an
 * exam is being built for the year the school is actually in.
 *
 * Passing the year explicitly also attaches a `usage` block per subject saying
 * where it is used that year, which is what lets the Subjects screen separate
 * "in use" from "not used yet". Dropdowns do not need that and do not pay for it.
 */
exports.getSubjects = async (req, res) => {
    try {
        const yearId = req.query.academicYear;
        const year = yearId
            ? await AcademicYear.findOne({ _id: yearId, school: req.schoolId }).lean()
            : await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        if (yearId && !year) return err(res, 'Academic year not found', 404);

        // No year at all (a school mid-setup) can only mean "everything", or the
        // subject screen would be empty with no way to explain itself.
        const filter = { school: req.schoolId, ...(year ? { academicYear: year._id } : {}) };
        const subjects = await Subject.find(filter)
            .populate('teachers', 'name email')
            .lean();

        if (!yearId) return ok(res, subjects);

        const classes  = await Class.find({ school: req.schoolId, academicYear: year._id })
            .select('className classNumber').lean();
        const sections = classes.length
            ? await ClassSection.find({ class: { $in: classes.map((c) => c._id) } })
                .select('sectionName class').lean()
            : [];
        const [links, assignments] = await Promise.all([
            classes.length
                ? ClassSubject.find({ class: { $in: classes.map((c) => c._id) } }).select('class subject').lean()
                : [],
            sections.length
                ? SectionSubjectTeacher.find({ section: { $in: sections.map((x) => x._id) } })
                    .select('section subject teacher').lean()
                : [],
        ]);

        const classById   = new Map(classes.map((c) => [String(c._id), c]));
        const sectionById = new Map(sections.map((x) => [String(x._id), x]));

        // subjectId -> { class labels, section labels, teacher ids }
        const usage = new Map();
        const slot = (sid) => {
            const k = String(sid);
            if (!usage.has(k)) usage.set(k, { classes: new Set(), sections: new Set(), teachers: new Set() });
            return usage.get(k);
        };
        for (const l of links) {
            const c = classById.get(String(l.class));
            if (c) slot(l.subject).classes.add(c.className);
        }
        for (const a of assignments) {
            const sec = sectionById.get(String(a.section));
            if (!sec) continue;
            const c = classById.get(String(sec.class));
            const u = slot(a.subject);
            if (c) u.classes.add(c.className);
            u.sections.add(`${c?.className || 'Class'} – ${sec.sectionName}`);
            if (a.teacher) u.teachers.add(String(a.teacher));
        }

        const withUsage = subjects.map((s) => {
            const u = usage.get(String(s._id));
            return {
                ...s,
                usage: {
                    inUse:        !!u,
                    classes:      u ? [...u.classes].sort() : [],
                    sections:     u ? [...u.sections].sort() : [],
                    classCount:   u ? u.classes.size : 0,
                    sectionCount: u ? u.sections.size : 0,
                    teacherCount: u ? u.teachers.size : 0,
                },
            };
        });

        ok(res, withUsage, 200, {
            academicYear: { _id: String(year._id), yearName: year.yearName },
            inUse:    withUsage.filter((s) => s.usage.inUse).length,
            notInUse: withUsage.filter((s) => !s.usage.inUse).length,
        });
    } catch (e) { err(res, e); }
};
exports.createSubject = async (req, res) => {
    try {
        const { name, subjectName, code, subjectCode, type, description, teachers } = req.body;
        if (!(subjectName || name)?.trim()) return err(res, 'Subject name is required', 400);
        // A subject is created INTO a year — the one the screen is showing, or
        // the active one when the caller does not say.
        let yearId = req.body.academicYear;
        if (yearId) {
            const y = await AcademicYear.findOne({ _id: yearId, school: req.schoolId }).lean();
            if (!y) return err(res, 'Academic year not found', 404);
        } else {
            const active = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
            if (!active) return err(res, 'No active academic year. Please set one first.', 400);
            yearId = active._id;
        }
        if (type && !['theory', 'practical', 'elective'].includes(type)) return err(res, 'Subject type must be theory, practical or elective', 400);
        // A deactivated teacher cannot be listed against a subject.
        const inactive = await inactiveTeacherError(teachers, req.schoolId);
        if (inactive) return err(res, inactive, 400);
        const s = await Subject.create({
            subjectName: subjectName || name,
            subjectCode: subjectCode || code || null,
            type:        type || 'theory',
            description: description || '',
            teachers:    Array.isArray(teachers) ? teachers : [],
            school:      req.schoolId,
            academicYear: yearId,
        });
        const populated = await s.populate('teachers', 'name email');
        ok(res, populated, 201);
    } catch (e) { err(res, e, 400); }
};
exports.updateSubject = async (req, res) => {
    try {
        const { name, subjectName, code, subjectCode, type, description, teachers } = req.body;
        const update = {};
        if (subjectName || name)           update.subjectName = subjectName || name;
        if (subjectCode || code)           update.subjectCode = subjectCode || code;
        if (type)                          update.type        = type;
        if (description !== undefined)     update.description = description;
        if (Array.isArray(teachers))       update.teachers    = teachers;
        if (update.teachers) {
            const inactive = await inactiveTeacherError(update.teachers, req.schoolId);
            if (inactive) return err(res, inactive, 400);
        }
        const s = await Subject.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, update, { new: true })
            .populate('teachers', 'name email');
        if (!s) return err(res, 'Subject not found', 404);
        ok(res, s);
    } catch (e) { err(res, e, 400); }
};
exports.deleteSubject = async (req, res) => {
    try {
        await Subject.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
exports.getClassSubjects = async (req, res) => {
    try {
        const subjects = await ClassSubject.find({ class: req.params.classId }).populate('subject').lean();
        ok(res, subjects);
    } catch (e) { err(res, e); }
};
exports.assignSubjectToClass = async (req, res) => {
    try {
        const cs = await ClassSubject.create({ class: req.params.classId, ...req.body });
        ok(res, cs, 201);
    } catch (e) { err(res, e, 400); }
};
exports.removeSubjectFromClass = async (req, res) => {
    try {
        await ClassSubject.deleteOne({ class: req.params.classId, subject: req.body.subjectId });
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
/**
 * Make sure "this class teaches this subject" is on record.
 *
 * Two tables describe the same fact at different grains: ClassSubject says the
 * CLASS teaches a subject, SectionSubjectTeacher says who teaches it in a given
 * SECTION. Assigning a teacher to a section obviously implies the first, but
 * nothing ever wrote it — no screen on either platform posts to the class-level
 * endpoint — so ClassSubject sat empty while assignments piled up.
 *
 * That is not cosmetic. The parent portal reads a child's subject list from
 * ClassSubject alone (parent.controller), the timetable generator folds it in
 * alongside the section rows, and the year-structure import copies it. All three
 * were reading a table nothing filled.
 *
 * So the link is written here, as a consequence of the assignment. Idempotent:
 * the pair is unique, and an existing link is left alone.
 */
async function ensureClassSubject(sectionId, subjectId) {
    if (!sectionId || !subjectId) return;
    const section = await ClassSection.findById(sectionId).select('class').lean();
    if (!section?.class) return;
    const exists = await ClassSubject.findOne({ class: section.class, subject: subjectId }).lean();
    if (!exists) await ClassSubject.create({ class: section.class, subject: subjectId });
}

exports.getSectionSubjectTeachers = async (req, res) => {
    try {
        const sst = await SectionSubjectTeacher.find({ section: req.params.sectionId })
            .populate('subject teacher').lean();
        ok(res, sst);
    } catch (e) { err(res, e); }
};
exports.assignSubjectTeacher = async (req, res) => {
    try {
        // The picker leaves deactivated teachers out; this is what a stale tab
        // or a direct call hits.
        const inactive = await inactiveTeacherError(req.body.teacher, req.schoolId);
        if (inactive) return err(res, inactive, 400);
        const sst = await SectionSubjectTeacher.create({ section: req.params.sectionId, ...req.body });
        // The class teaches this subject — record that too, or the parent portal
        // and the year import never learn about it. See ensureClassSubject.
        await ensureClassSubject(req.params.sectionId, req.body.subject);
        // Subject teachers belong to the section's teacher group chat
        syncSectionChatGroup(req.params.sectionId, req.schoolId, req.userId).catch(() => {});
        ok(res, sst, 201);
    } catch (e) { err(res, e, 400); }
};
// ─────────────────────────────────────────────────────────────────────────────
//  One subject + teacher onto SEVERAL sections of the same class.
//
//  Hindi in Class 5 is almost never Hindi in section A alone — it is A, B, C and
//  D, and doing that a section at a time is the same four-field form four times.
//  This takes the sections as a list and writes them in one action.
//
//  Additive like the rest of the setup tooling: a section that already has this
//  exact subject-and-teacher pairing is reported as already done rather than
//  failing the call, so a partly-finished class can be topped up by re-running
//  with every section ticked.
//
//  Sections must all belong to `classId` — the screen only offers siblings, and
//  the server holds that line so a hand-made call cannot fan a subject out
//  across unrelated classes.
// ─────────────────────────────────────────────────────────────────────────────
exports.assignSubjectToSections = async (req, res) => {
    try {
        const { subject, teacher, sectionIds, preview } = req.body;

        const cls = await Class.findOne({ _id: req.params.classId, school: req.schoolId }).lean();
        if (!cls) return err(res, 'Class not found', 404);
        if (!subject) return err(res, 'Pick a subject', 400);
        if (!teacher) return err(res, 'Pick a teacher', 400);

        const wanted = Array.isArray(sectionIds) ? [...new Set(sectionIds.map(String))] : [];
        if (!wanted.length) return err(res, 'Pick at least one section', 400);

        const subjectDoc = await Subject.findOne({ _id: subject, school: req.schoolId }).select('subjectName').lean();
        if (!subjectDoc) return err(res, 'Subject not found', 404);

        // A deactivated teacher cannot be assigned anywhere — same rule the
        // single-section path enforces.
        const inactive = await inactiveTeacherError(teacher, req.schoolId);
        if (inactive) return err(res, inactive, 400);

        const siblings = await ClassSection.find({ class: cls._id, school: req.schoolId })
            .select('sectionName').lean();
        const byId = new Map(siblings.map((x) => [String(x._id), x]));
        const stray = wanted.filter((sid) => !byId.has(sid));
        if (stray.length) return err(res, `Those sections are not in ${cls.className}`, 400);

        const already = await SectionSubjectTeacher.find({
            section: { $in: wanted }, subject, teacher,
        }).select('section').lean();
        const doneIds = new Set(already.map((r) => String(r.section)));

        const toCreate = wanted.filter((sid) => !doneIds.has(sid));
        const payload = {
            classId:     String(cls._id),
            className:   cls.className,
            subjectName: subjectDoc.subjectName,
            toCreate:    toCreate.map((sid) => byId.get(sid).sectionName),
            alreadyDone: wanted.filter((sid) => doneIds.has(sid)).map((sid) => byId.get(sid).sectionName),
        };
        if (preview) return ok(res, { ...payload, preview: true });

        for (const sid of toCreate) {
            await SectionSubjectTeacher.create({ section: sid, subject, teacher });
            await ensureClassSubject(sid, subject);
        }
        // Subject teachers belong to each section's teacher group chat.
        for (const sid of toCreate) {
            syncSectionChatGroup(sid, req.schoolId, req.userId).catch(() => {});
        }

        ok(res, { ...payload, preview: false, created: toCreate.length }, 201);
    } catch (e) {
        if (e.code === 11000) return err(res, 'That teacher is already assigned to this subject in one of those sections.', 400);
        err(res, e, 400);
    }
};

exports.removeSectionSubject = async (req, res) => {
    try {
        await SectionSubjectTeacher.deleteOne({ section: req.params.sectionId, subject: req.params.subjectId });
        syncSectionChatGroup(req.params.sectionId, req.schoolId, req.userId).catch(() => {});
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
exports.removeSectionSubjectTeacher = async (req, res) => {
    try {
        await SectionSubjectTeacher.deleteOne({
            section: req.params.sectionId,
            subject: req.params.subjectId,
            teacher: req.params.teacherId,
        });
        syncSectionChatGroup(req.params.sectionId, req.schoolId, req.userId).catch(() => {});
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
