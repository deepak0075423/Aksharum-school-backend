'use strict';
const Subject             = require('../models/Subject');
const ClassSubject        = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Class               = require('../models/Class');
const ClassSection        = require('../models/ClassSection');
const { syncSectionChatGroup } = require('../services/sectionChatService');
const { inactiveTeacherError } = require('../utils/activeTeacher');

const ok  = (res, d, s=200) => res.status(s).json({ success: true, data: d });
const err = (res, e, s=500) => res.status(s).json({ success: false, message: e.message||e });

exports.getSubjects = async (req, res) => {
    try {
        const subjects = await Subject.find({ school: req.schoolId })
            .populate('teachers', 'name email')
            .lean();
        ok(res, subjects);
    } catch (e) { err(res, e); }
};
exports.createSubject = async (req, res) => {
    try {
        const { name, subjectName, code, subjectCode, type, description, teachers } = req.body;
        if (!(subjectName || name)?.trim()) return err(res, 'Subject name is required', 400);
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
