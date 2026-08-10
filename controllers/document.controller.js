'use strict';

const Document             = require('../models/Document');
const AssignmentSubmission = require('../models/AssignmentSubmission');
const StudentProfile       = require('../models/StudentProfile');
const ParentProfile        = require('../models/ParentProfile');
const ClassSection         = require('../models/ClassSection');
const Class                = require('../models/Class');
const SectionSubjectTeacher= require('../models/SectionSubjectTeacher');

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFileObjects(files) {
    return (files || []).map(f => ({
        originalName: f.originalname,
        storedName:   f.filename,
        filePath:     f.path,
        mimeType:     f.mimetype,
        fileSize:     f.size,
    }));
}

async function canStudentViewDocument(doc, studentId, schoolId) {
    const { targetType, targetSections, targetClasses, targetUsers } = doc;

    if (targetType === 'whole_school') return true;
    if (targetType === 'all_teachers') return false;
    if (targetType === 'specific_teachers') return false;

    const profile = await StudentProfile.findOne({ user: studentId }).lean();
    if (!profile?.currentSection) return false;

    const sectionId = profile.currentSection.toString();

    if (targetType === 'class_sections') {
        const studentSec = await ClassSection.findById(sectionId).lean();
        if (!studentSec) return false;
        const studentClass = await Class.findById(studentSec.class).lean();
        if (!studentClass) return false;
        const sameClasses = await Class.find({ school: schoolId, classNumber: studentClass.classNumber }).distinct('_id');
        const sameSections = await ClassSection.find({ class: { $in: sameClasses }, sectionName: studentSec.sectionName, school: schoolId }).distinct('_id');
        const sameSectionStrs = sameSections.map(id => id.toString());
        return (targetSections || []).some(id => sameSectionStrs.includes(id.toString()));
    }
    if (targetType === 'class') {
        const section = await ClassSection.findById(sectionId).lean();
        if (!section?.class) return false;
        const classDoc = await Class.findById(section.class).lean();
        if (!classDoc) return false;
        const allClassIds = await Class.find({ school: classDoc.school, classNumber: classDoc.classNumber }).distinct('_id');
        const allClassStrs = allClassIds.map(id => id.toString());
        return (targetClasses || []).some(id => allClassStrs.includes(id.toString()));
    }
    return false;
}

// ── Admin: Documents ──────────────────────────────────────────────────────────

exports.adminGetDocuments = async (req, res) => {
    try {
        const { category, isArchived, page = 1, limit = 20, search } = req.query;
        const filter = { school: req.schoolId };
        if (category)              filter.category   = category;
        if (isArchived !== undefined) filter.isArchived = isArchived === 'true';
        else filter.isArchived = false;
        if (search) filter.title = { $regex: search, $options: 'i' };

        const [docs, total] = await Promise.all([
            Document.find(filter)
                .populate('uploadedBy', 'name email')
                .populate('targetClasses', 'className classNumber')
                .populate('targetSections', 'sectionName')
                .sort({ createdAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            Document.countDocuments(filter),
        ]);
        res.json({ success: true, data: docs, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminUpload = async (req, res) => {
    try {
        const { title, description, category, targetType, targetClasses, targetSections,
                targetUsers, isAssignment, dueDate, allowSubmission, marksEnabled, totalMarks, tags } = req.body;

        if (!title?.trim())  return res.status(400).json({ success: false, message: 'Title is required' });
        if (!category)       return res.status(400).json({ success: false, message: 'Category is required' });
        if (!targetType)     return res.status(400).json({ success: false, message: 'Target type is required' });

        const files = buildFileObjects(req.files);

        const doc = await Document.create({
            school: req.schoolId,
            title:  title.trim(),
            description: description || '',
            category,
            files,
            uploadedBy:   req.userId,
            uploaderRole: 'school_admin',
            targetType,
            targetClasses:  JSON.parse(targetClasses  || '[]'),
            targetSections: JSON.parse(targetSections || '[]'),
            targetUsers:    JSON.parse(targetUsers    || '[]'),
            tags: JSON.parse(tags || '[]'),
            isAssignment:    !!isAssignment,
            dueDate:         dueDate ? new Date(dueDate) : null,
            allowSubmission: isAssignment ? allowSubmission !== false : false,
            marksEnabled:    !!marksEnabled,
            totalMarks:      marksEnabled ? Number(totalMarks) : null,
        });
        res.status(201).json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminGetDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminEditDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        const { title, description, category, targetType, targetClasses, targetSections,
                targetUsers, dueDate, marksEnabled, totalMarks, tags } = req.body;

        if (title !== undefined)      doc.title       = title.trim();
        if (description !== undefined)doc.description = description;
        if (category !== undefined)   doc.category    = category;
        if (targetType !== undefined) doc.targetType  = targetType;
        if (targetClasses  !== undefined) doc.targetClasses  = JSON.parse(targetClasses);
        if (targetSections !== undefined) doc.targetSections = JSON.parse(targetSections);
        if (targetUsers    !== undefined) doc.targetUsers    = JSON.parse(targetUsers);
        if (tags !== undefined) doc.tags = JSON.parse(tags);
        if (dueDate !== undefined)    doc.dueDate     = dueDate ? new Date(dueDate) : null;
        if (marksEnabled !== undefined) doc.marksEnabled = !!marksEnabled;
        if (totalMarks !== undefined) doc.totalMarks  = Number(totalMarks);

        if (req.files?.length) {
            doc.files = buildFileObjects(req.files);
            doc.currentVersion = (doc.currentVersion || 1) + 1;
        }
        await doc.save();
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminDeleteDocument = async (req, res) => {
    try {
        const doc = await Document.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        await AssignmentSubmission.deleteMany({ document: doc._id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminArchiveDocument = async (req, res) => {
    try {
        const doc = await Document.findOneAndUpdate(
            { _id: req.params.id, school: req.schoolId },
            { isArchived: true },
            { new: true }
        ).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminBulkArchive = async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids?.length) return res.status(400).json({ success: false, message: 'ids are required' });
        await Document.updateMany({ _id: { $in: ids }, school: req.schoolId }, { isArchived: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminBulkDelete = async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids?.length) return res.status(400).json({ success: false, message: 'ids are required' });
        await Document.deleteMany({ _id: { $in: ids }, school: req.schoolId });
        await AssignmentSubmission.deleteMany({ document: { $in: ids } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminGetAuditLog = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const [docs, total] = await Promise.all([
            Document.find({ school: req.schoolId })
                .populate('uploadedBy', 'name email')
                .sort({ updatedAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            Document.countDocuments({ school: req.schoolId }),
        ]);
        res.json({ success: true, data: docs, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.adminRestoreVersion = async (req, res) => {
    // Version history not tracked separately; return document as-is
    try {
        const doc = await Document.findOne({ _id: req.params.docId, school: req.schoolId }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Teacher: Documents ────────────────────────────────────────────────────────

exports.teacherGetDocuments = async (req, res) => {
    try {
        const { category, isArchived, page = 1, limit = 20 } = req.query;

        // Teacher sees: documents they uploaded OR targeted at them / their section
        const mySections = await SectionSubjectTeacher.find({ teacher: req.userId }).distinct('section');

        const filter = {
            school: req.schoolId,
            isArchived: isArchived === 'true' ? true : false,
            $or: [
                { uploadedBy: req.userId },
                { targetType: 'all_teachers' },
                { targetType: 'whole_school' },
                { targetType: 'specific_teachers', targetUsers: req.userId },
                { targetType: 'class_sections', targetSections: { $in: mySections } },
            ],
        };
        if (category) filter.category = category;

        const [docs, total] = await Promise.all([
            Document.find(filter)
                .populate('uploadedBy', 'name')
                .sort({ createdAt: -1 })
                .skip((+page - 1) * +limit)
                .limit(+limit)
                .lean(),
            Document.countDocuments(filter),
        ]);
        res.json({ success: true, data: docs, total, page: +page, pages: Math.ceil(total / +limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherUpload = async (req, res) => {
    try {
        const { title, description, category, sectionId, isAssignment, dueDate,
                allowSubmission, marksEnabled, totalMarks, tags } = req.body;

        if (!title?.trim())  return res.status(400).json({ success: false, message: 'Title is required' });
        if (!category)       return res.status(400).json({ success: false, message: 'Category is required' });
        if (!sectionId)      return res.status(400).json({ success: false, message: 'sectionId is required' });

        const files = buildFileObjects(req.files);

        const doc = await Document.create({
            school: req.schoolId,
            title:  title.trim(),
            description: description || '',
            category,
            files,
            uploadedBy:   req.userId,
            uploaderRole: 'teacher',
            targetType:   'class_sections',
            targetSections: [sectionId],
            tags: JSON.parse(tags || '[]'),
            isAssignment:    !!isAssignment,
            dueDate:         dueDate ? new Date(dueDate) : null,
            allowSubmission: isAssignment ? allowSubmission !== false : false,
            marksEnabled:    !!marksEnabled,
            totalMarks:      marksEnabled ? Number(totalMarks) : null,
        });
        res.status(201).json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherEditDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, uploadedBy: req.userId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        const { title, description, dueDate, marksEnabled, totalMarks } = req.body;
        if (title !== undefined)      doc.title       = title.trim();
        if (description !== undefined)doc.description = description;
        if (dueDate !== undefined)    doc.dueDate     = dueDate ? new Date(dueDate) : null;
        if (marksEnabled !== undefined) doc.marksEnabled = !!marksEnabled;
        if (totalMarks !== undefined) doc.totalMarks  = Number(totalMarks);
        if (req.files?.length) {
            doc.files = buildFileObjects(req.files);
            doc.currentVersion = (doc.currentVersion || 1) + 1;
        }
        await doc.save();
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherDeleteDocument = async (req, res) => {
    try {
        const doc = await Document.findOneAndDelete({ _id: req.params.id, school: req.schoolId, uploadedBy: req.userId });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        await AssignmentSubmission.deleteMany({ document: doc._id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherGetSubmissions = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, uploadedBy: req.userId }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        const submissions = await AssignmentSubmission.find({ document: doc._id })
            .populate('student', 'name rollNumber email')
            .sort({ submittedAt: -1 })
            .lean();
        res.json({ success: true, data: submissions });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.teacherReviewSubmission = async (req, res) => {
    try {
        const { marks, feedback } = req.body;
        const sub = await AssignmentSubmission.findOne({ _id: req.params.submissionId, school: req.schoolId });
        if (!sub) return res.status(404).json({ success: false, message: 'Submission not found' });

        sub.marks      = marks !== undefined ? Number(marks) : sub.marks;
        sub.feedback   = feedback || sub.feedback;
        sub.reviewedBy = req.userId;
        sub.reviewedAt = new Date();
        await sub.save();
        res.json({ success: true, data: sub });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Student: Documents ────────────────────────────────────────────────────────

exports.studentGetDocuments = async (req, res) => {
    try {
        const { category } = req.query;
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [], _debug: 'no currentSection' });

        const section = await ClassSection.findById(profile.currentSection).lean();

        const orConditions = [{ targetType: 'whole_school' }];

        if (section) {
            const classDoc = await Class.findById(section.class).lean();
            if (classDoc) {
                const sameClasses = await Class.find({ school: req.schoolId, classNumber: classDoc.classNumber }).distinct('_id');
                orConditions.push({ targetType: 'class', targetClasses: { $in: sameClasses } });

                const sameSections = await ClassSection.find({ class: { $in: sameClasses }, sectionName: section.sectionName, school: req.schoolId }).distinct('_id');
                orConditions.push({ targetType: 'class_sections', targetSections: { $in: sameSections } });
            }
        }

        const filter = { school: req.schoolId, isArchived: false, $or: orConditions };
        if (category) filter.category = category;

        const docs = await Document.find(filter)
            .populate('uploadedBy', 'name')
            .populate('targetClasses', 'classNumber className')
            .populate('targetSections', 'sectionName')
            .sort({ createdAt: -1 })
            .lean();

        // Attach submission status for assignments
        const assignmentIds = docs.filter(d => d.isAssignment).map(d => d._id);
        const submissions   = await AssignmentSubmission.find({ student: req.userId, document: { $in: assignmentIds } }).lean();
        const subMap        = Object.fromEntries(submissions.map(s => [s.document.toString(), s]));

        const data = docs.map(d => ({
            ...d,
            mySubmission: d.isAssignment ? (subMap[d._id.toString()] || null) : undefined,
        }));
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.studentGetDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, isArchived: false })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        const canView = await canStudentViewDocument(doc, req.userId, req.schoolId);
        if (!canView) return res.status(403).json({ success: false, message: 'Access denied' });

        let mySubmission = null;
        if (doc.isAssignment) {
            mySubmission = await AssignmentSubmission.findOne({ document: doc._id, student: req.userId }).lean();
        }
        res.json({ success: true, data: { ...doc, mySubmission } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.studentSubmitAssignment = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, isAssignment: true, allowSubmission: true }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Assignment not found or submissions not allowed' });

        if (doc.dueDate && new Date() > new Date(doc.dueDate)) {
            const files = buildFileObjects(req.files);
            const profile = await StudentProfile.findOne({ user: req.userId }).lean();
            const sub = await AssignmentSubmission.findOneAndUpdate(
                { document: doc._id, student: req.userId },
                { $set: { files, status: 'late', submittedAt: new Date(), section: profile?.currentSection || null, school: req.schoolId } },
                { upsert: true, new: true }
            ).lean();
            return res.json({ success: true, data: sub, message: 'Submitted late' });
        }

        const files   = buildFileObjects(req.files);
        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        const sub     = await AssignmentSubmission.findOneAndUpdate(
            { document: doc._id, student: req.userId },
            { $set: { files, status: 'submitted', submittedAt: new Date(), section: profile?.currentSection || null, school: req.schoolId } },
            { upsert: true, new: true }
        ).lean();
        res.json({ success: true, data: sub });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Parent: documents visible to child ───────────────────────────────────────
exports.parentGetDocuments = async (req, res) => {
    try {
        const parent  = await ParentProfile.findOne({ user: req.userId }).lean();
        const childId = parent?.children?.[0] || parent?.student;
        if (!childId) return res.json({ success: true, data: [] });

        const profile = await StudentProfile.findOne({ user: childId }).lean();
        if (!profile?.currentSection) return res.json({ success: true, data: [] });

        const section = await ClassSection.findById(profile.currentSection).lean();

        const parentOrConds = [{ targetType: 'whole_school' }];

        if (section) {
            const classDoc = await Class.findById(section.class).lean();
            if (classDoc) {
                const sameClasses = await Class.find({ school: req.schoolId, classNumber: classDoc.classNumber }).distinct('_id');
                parentOrConds.push({ targetType: 'class', targetClasses: { $in: sameClasses } });

                const sameSections = await ClassSection.find({ class: { $in: sameClasses }, sectionName: section.sectionName, school: req.schoolId }).distinct('_id');
                parentOrConds.push({ targetType: 'class_sections', targetSections: { $in: sameSections } });
            }
        }

        const docs = await Document.find({
            school: req.schoolId,
            isArchived: false,
            $or: parentOrConds,
        })
            .populate('uploadedBy', 'name')
            .sort({ createdAt: -1 })
            .lean();

        res.json({ success: true, data: docs });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.parentGetDocument = async (req, res) => {
    try {
        const doc = await Document.findOne({ _id: req.params.id, school: req.schoolId, isArchived: false })
            .populate('uploadedBy', 'name')
            .lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
