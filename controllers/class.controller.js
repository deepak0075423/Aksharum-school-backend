'use strict';
const AcademicYear   = require('../models/AcademicYear');
const Class          = require('../models/Class');
const ClassSection   = require('../models/ClassSection');
const StudentProfile = require('../models/StudentProfile');
const User           = require('../models/User');
const { isDate }     = require('../utils/validators');

const ok  = (res, data, status = 200) => res.status(status).json({ success: true, data });
const err = (res, e, status = 500)    => res.status(status).json({ success: false, message: e.message || e });

// Academic Years
exports.getAcademicYears = async (req, res) => {
    try {
        const years = await AcademicYear.find({ school: req.schoolId }).sort({ startDate: -1 }).lean();
        ok(res, years);
    } catch (e) { err(res, e); }
};
exports.createAcademicYear = async (req, res) => {
    try {
        const { name, yearName, startDate, endDate } = req.body;
        if (!(yearName || name)?.trim()) return err(res, 'Year name is required', 400);
        if (!startDate || !isDate(startDate)) return err(res, 'A valid start date is required', 400);
        if (!endDate   || !isDate(endDate))   return err(res, 'A valid end date is required', 400);
        if (new Date(endDate) <= new Date(startDate)) return err(res, 'End date must be after start date', 400);
        const year = await AcademicYear.create({
            yearName: yearName || name,
            startDate, endDate,
            status: 'inactive',
            school: req.schoolId,
        });
        ok(res, year, 201);
    } catch (e) { err(res, e, 400); }
};
exports.updateAcademicYear = async (req, res) => {
    try {
        const { name, yearName, startDate, endDate } = req.body;
        if (startDate && !isDate(startDate)) return err(res, 'Start date is invalid', 400);
        if (endDate   && !isDate(endDate))   return err(res, 'End date is invalid', 400);
        if (startDate && endDate && new Date(endDate) <= new Date(startDate)) return err(res, 'End date must be after start date', 400);
        const update = { startDate, endDate };
        if (yearName || name) update.yearName = yearName || name;
        const year = await AcademicYear.findByIdAndUpdate(req.params.id, update, { new: true });
        ok(res, year);
    } catch (e) { err(res, e, 400); }
};
exports.deleteAcademicYear = async (req, res) => {
    try {
        await AcademicYear.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
exports.setActiveAcademicYear = async (req, res) => {
    try {
        await AcademicYear.updateMany({ school: req.schoolId }, { $set: { status: 'inactive' } });
        const year = await AcademicYear.findByIdAndUpdate(
            req.params.id, { $set: { status: 'active' } }, { new: true }
        );
        ok(res, year);
    } catch (e) { err(res, e); }
};

// Classes
exports.getClasses = async (req, res) => {
    try {
        const filter = { school: req.schoolId };
        if (req.query.academicYear === 'all') {
            // no year filter — show all academic years
        } else if (req.query.academicYear) {
            filter.academicYear = req.query.academicYear;
        } else {
            // default: active academic year only
            const active = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
            if (active) filter.academicYear = active._id;
        }
        const classes = await Class.find(filter)
            .populate('academicYear', 'yearName status')
            .sort({ classNumber: 1 })
            .lean();
        const classIds = classes.map(c => c._id);
        const sections = await ClassSection.find({ class: { $in: classIds } }, 'class enrolledStudents').lean();
        const secMap = {};
        sections.forEach(s => {
            const id = s.class.toString();
            secMap[id] = (secMap[id] || { count: 0, students: 0 });
            secMap[id].count++;
            secMap[id].students += (s.enrolledStudents || []).length;
        });
        ok(res, classes.map(c => ({
            ...c,
            sectionCount: secMap[c._id.toString()]?.count || 0,
            studentCount: secMap[c._id.toString()]?.students || 0,
        })));
    } catch (e) { err(res, e); }
};
exports.createClass = async (req, res) => {
    try {
        const { name, className, classNumber, level, academicYear } = req.body;
        if (!(className || name)?.trim()) return err(res, 'Class name is required', 400);
        const num = classNumber ?? level;
        if (num !== undefined && num !== null && num !== '' && (Number.isNaN(Number(num)) || Number(num) < 0))
            return err(res, 'Class number must be a non-negative number', 400);
        let yearId = academicYear;
        if (!yearId) {
            const active = await AcademicYear.findOne({ school: req.schoolId, status: 'active' });
            if (!active) return err(res, { message: 'No active academic year. Please set one first.' }, 400);
            yearId = active._id;
        }
        const cls = await Class.create({
            className: className || name,
            classNumber: classNumber ?? level ?? 0,
            academicYear: yearId,
            school: req.schoolId,
        });
        ok(res, cls, 201);
    } catch (e) { err(res, e, 400); }
};
exports.getClassDetail = async (req, res) => {
    try {
        const cls = await Class.findById(req.params.classId).lean();
        const sections = await ClassSection.find({ class: req.params.classId }).lean();
        ok(res, { class: cls, sections });
    } catch (e) { err(res, e); }
};
exports.deleteClass = async (req, res) => {
    try {
        await Class.findByIdAndDelete(req.params.classId);
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
exports.autoAssignStudents = async (req, res) => {
    try {
        // Determine target academic year
        let targetYearId = req.body.academicYear || req.query.academicYear;
        if (!targetYearId) {
            const active = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
            if (!active) return err(res, { message: 'No active academic year found. Please set one first.' }, 400);
            targetYearId = active._id.toString();
        } else {
            targetYearId = targetYearId.toString();
        }

        // ── Target year sections ────────────────────────────────────────────
        const targetSections = await ClassSection.find(
            { school: req.schoolId, academicYear: targetYearId },
            '_id sectionName class enrolledStudents'
        ).lean();
        if (!targetSections.length) return ok(res, { assigned: 0, skipped: 0, sections: 0 });

        // Build lookup: "classname||sectionname" → targetSection
        const targetClassIds = [...new Set(targetSections.map(s => s.class?.toString()).filter(Boolean))];
        const targetClasses  = await Class.find({ _id: { $in: targetClassIds } }, '_id className').lean();
        const targetClassNameMap = Object.fromEntries(
            targetClasses.map(c => [c._id.toString(), c.className.trim().toLowerCase()])
        );
        const targetLookup = {};
        targetSections.forEach(s => {
            const cn  = targetClassNameMap[s.class?.toString()] || '';
            const key = `${cn}||${s.sectionName.trim().toLowerCase()}`;
            targetLookup[key] = s;
        });

        // Build enrolled set for target year; clean stale IDs
        let targetEnrolledSet = new Set(
            targetSections.flatMap(s => s.enrolledStudents.map(id => id.toString()))
        );
        if (targetEnrolledSet.size) {
            const realUsers = await User.find({ _id: { $in: [...targetEnrolledSet] } }, '_id').lean();
            const realSet   = new Set(realUsers.map(u => u._id.toString()));
            const staleIds  = [...targetEnrolledSet].filter(id => !realSet.has(id));
            if (staleIds.length) {
                await ClassSection.updateMany(
                    { school: req.schoolId, academicYear: targetYearId },
                    { $pull: { enrolledStudents: { $in: staleIds } } }
                );
                staleIds.forEach(id => targetEnrolledSet.delete(id));
            }
        }

        // ── All sections in school (source for name-matching) ───────────────
        const allSections = await ClassSection.find({ school: req.schoolId }, '_id sectionName class').lean();
        const allSectionIds = allSections.map(s => s._id);

        const allClassIds = [...new Set(allSections.map(s => s.class?.toString()).filter(Boolean))];
        const allClasses  = await Class.find({ _id: { $in: allClassIds } }, '_id className').lean();
        const allClassNameMap = Object.fromEntries(
            allClasses.map(c => [c._id.toString(), c.className.trim().toLowerCase()])
        );

        // sectionId → "classname||sectionname" key
        const sectionKeyMap = {};
        allSections.forEach(s => {
            const cn = allClassNameMap[s.class?.toString()] || '';
            sectionKeyMap[s._id.toString()] = `${cn}||${s.sectionName.trim().toLowerCase()}`;
        });

        // ── Student profiles ────────────────────────────────────────────────
        const profiles = await StudentProfile.find(
            { currentSection: { $in: allSectionIds } },
            'user currentSection'
        ).lean();

        // Remove orphaned profiles (student user deleted)
        const profileUserIds = profiles.map(p => p.user);
        const realStudents   = await User.find({ _id: { $in: profileUserIds }, role: 'student' }, '_id').lean();
        const realStudentSet = new Set(realStudents.map(u => u._id.toString()));

        const orphanedIds = profiles.filter(p => !realStudentSet.has(p.user.toString())).map(p => p._id);
        if (orphanedIds.length) await StudentProfile.deleteMany({ _id: { $in: orphanedIds } });

        const validProfiles = profiles.filter(p => realStudentSet.has(p.user.toString()));

        // ── Match each student to a section in the target year ──────────────
        // Matching is by "className||sectionName" — works across years as long as names match
        const sectionAddMap = {};
        let skipped = 0;

        validProfiles.forEach(p => {
            const userId = p.user.toString();

            // Already enrolled in target year → skip
            if (targetEnrolledSet.has(userId)) { skipped++; return; }

            // Find the target-year section with the same class+section name
            const key           = sectionKeyMap[p.currentSection.toString()];
            const targetSection = key && targetLookup[key];
            if (!targetSection) return; // No matching section in target year

            const sid = targetSection._id.toString();
            if (!sectionAddMap[sid]) sectionAddMap[sid] = [];
            sectionAddMap[sid].push(p.user);
        });

        const bulkOps = Object.entries(sectionAddMap).map(([sectionId, userIds]) => ({
            updateOne: {
                filter: { _id: sectionId },
                update: { $addToSet: { enrolledStudents: { $each: userIds } } },
            },
        }));
        if (bulkOps.length) await ClassSection.bulkWrite(bulkOps);

        // Point each promoted student's profile at their new section
        for (const [sectionId, userIds] of Object.entries(sectionAddMap)) {
            await StudentProfile.updateMany(
                { user: { $in: userIds } },
                { $set: { currentSection: sectionId } }
            );
        }

        const assigned = Object.values(sectionAddMap).reduce((sum, arr) => sum + arr.length, 0);

        // Recalculate currentCount for target year sections
        const allUpdated = await ClassSection.find(
            { school: req.schoolId, academicYear: targetYearId },
            '_id enrolledStudents'
        ).lean();
        const countOps = allUpdated.map(s => ({
            updateOne: { filter: { _id: s._id }, update: { $set: { currentCount: s.enrolledStudents.length } } },
        }));
        if (countOps.length) await ClassSection.bulkWrite(countOps);

        ok(res, { assigned, skipped, sections: bulkOps.length });
    } catch (e) { err(res, e); }
};

// Sections
exports.createSection = async (req, res) => {
    try {
        const cls = await Class.findById(req.params.classId).lean();
        const { name, sectionName, capacity, maxStudents } = req.body;
        if (!(sectionName || name)?.trim()) return err(res, 'Section name is required', 400);
        const cap = maxStudents || capacity;
        if (cap !== undefined && cap !== null && cap !== '' && (Number.isNaN(Number(cap)) || Number(cap) < 1))
            return err(res, 'Capacity must be a positive number', 400);
        const section = await ClassSection.create({
            sectionName: sectionName || name,
            maxStudents: maxStudents || capacity || 40,
            class: req.params.classId,
            academicYear: cls?.academicYear,
            school: req.schoolId,
        });
        ok(res, section, 201);
    } catch (e) {
        if (e.code === 11000) return err(res, { message: `Section "${req.body.sectionName || req.body.name}" already exists in this class.` }, 400);
        err(res, e, 400);
    }
};
exports.getSectionDetail = async (req, res) => {
    try {
        const section = await ClassSection.findById(req.params.sectionId)
            .populate('classTeacher',     'name email phone')
            .populate('substituteTeacher','name email phone')
            .populate('enrolledStudents', 'name email')
            .lean();

        // Enrich enrolled students with roll number + gender from StudentProfile
        const enrolled = section?.enrolledStudents || [];
        if (enrolled.length) {
            const profiles = await StudentProfile.find(
                { user: { $in: enrolled.map(s => s._id) } },
                'user rollNumber gender admissionNumber',
            ).lean();
            const pMap = {};
            profiles.forEach(p => { pMap[p.user.toString()] = p; });
            section.enrolledStudents = enrolled.map(s => ({
                ...s,
                rollNumber:      pMap[s._id.toString()]?.rollNumber || '',
                admissionNumber: pMap[s._id.toString()]?.admissionNumber || '',
                gender:          pMap[s._id.toString()]?.gender || '',
            }));
        }

        ok(res, section);
    } catch (e) { err(res, e); }
};
exports.assignStudentToSection = async (req, res) => {
    try {
        const { studentId } = req.body;
        if (!studentId) return err(res, { message: 'studentId is required' }, 400);

        const section = await ClassSection.findById(req.params.sectionId).lean();
        if (!section) return err(res, { message: 'Section not found' }, 404);

        // Check if already enrolled in another section for the same academic year
        const alreadyIn = await ClassSection.findOne({
            academicYear: section.academicYear,
            enrolledStudents: studentId,
            _id: { $ne: section._id },
        }).lean();
        if (alreadyIn) return err(res, { message: `Student is already enrolled in section "${alreadyIn.sectionName}". Remove them first.` }, 400);

        await ClassSection.findByIdAndUpdate(req.params.sectionId, {
            $addToSet: { enrolledStudents: studentId },
            $inc: { currentCount: 1 },
        });
        // Keep the student's profile in sync — every read path (my-class,
        // timetable, admin list, parent views) resolves class via currentSection.
        await StudentProfile.updateOne(
            { user: studentId, school: req.schoolId },
            { $set: { currentSection: req.params.sectionId } }
        );
        ok(res, { message: 'Student enrolled' });
    } catch (e) { err(res, e); }
};
exports.removeStudentFromSection = async (req, res) => {
    try {
        const { studentId } = req.body;
        if (!studentId) return err(res, { message: 'studentId is required' }, 400);
        const section = await ClassSection.findByIdAndUpdate(
            req.params.sectionId,
            { $pull: { enrolledStudents: studentId }, $inc: { currentCount: -1 } },
            { new: true }
        );
        if (section && section.currentCount < 0) {
            await ClassSection.findByIdAndUpdate(req.params.sectionId, { $set: { currentCount: 0 } });
        }
        await StudentProfile.updateOne(
            { user: studentId, currentSection: req.params.sectionId },
            { $set: { currentSection: null } }
        );
        ok(res, { message: 'Student removed' });
    } catch (e) { err(res, e); }
};
exports.updateSectionTeacher = async (req, res) => {
    try {
        const update = {};
        if (req.body.teacherId     !== undefined) update.classTeacher      = req.body.teacherId     || null;
        if (req.body.viceTeacherId !== undefined) update.substituteTeacher = req.body.viceTeacherId || null;
        const section = await ClassSection.findByIdAndUpdate(req.params.sectionId, update, { new: true })
            .populate('classTeacher',     'name email phone')
            .populate('substituteTeacher','name email phone');
        ok(res, section);
    } catch (e) { err(res, e); }
};
exports.updateSectionCapacity = async (req, res) => {
    try {
        const section = await ClassSection.findByIdAndUpdate(
            req.params.sectionId, { capacity: req.body.capacity }, { new: true }
        );
        ok(res, section);
    } catch (e) { err(res, e); }
};
exports.deleteSection = async (req, res) => {
    try {
        await ClassSection.findByIdAndDelete(req.params.sectionId);
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
