'use strict';
const Subject             = require('../models/Subject');
const ClassSubject        = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

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
        const sst = await SectionSubjectTeacher.create({ section: req.params.sectionId, ...req.body });
        ok(res, sst, 201);
    } catch (e) { err(res, e, 400); }
};
exports.removeSectionSubject = async (req, res) => {
    try {
        await SectionSubjectTeacher.deleteOne({ section: req.params.sectionId, subject: req.params.subjectId });
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
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
