'use strict';
const AcademicYear   = require('../models/AcademicYear');
const Class          = require('../models/Class');
const ClassSection   = require('../models/ClassSection');
const StudentProfile = require('../models/StudentProfile');
const User           = require('../models/User');
const Chat           = require('../models/Chat');
const ChatMember     = require('../models/ChatMember');
const { isDate }     = require('../utils/validators');
const { syncSectionChatGroup } = require('../services/sectionChatService');

const ok  = (res, data, status = 200) => res.status(status).json({ success: true, data });
const err = (res, e, status = 500)    => res.status(status).json({ success: false, message: e.message || e });

// Two academic years of the same school may not cover overlapping dates —
// every "current year" lookup in the app assumes a single year per date.
async function findOverlappingYear(schoolId, startDate, endDate, excludeId = null) {
    const filter = {
        school: schoolId,
        startDate: { $lte: new Date(endDate) },
        endDate:   { $gte: new Date(startDate) },
    };
    if (excludeId) filter._id = { $ne: excludeId };
    return AcademicYear.findOne(filter).lean();
}

// Alphabetical, but digit-aware so "Class 2" sorts before "Class 10"
const byName = (key) => (a, b) =>
    String(a[key] || '').localeCompare(String(b[key] || ''), 'en', { numeric: true, sensitivity: 'base' });

const dmy = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const overlapMessage = (clash) =>
    `These dates overlap academic year "${clash.yearName}" (${dmy(clash.startDate)} – ${dmy(clash.endDate)}). Academic years cannot overlap.`;

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

        const label = (yearName || name).trim();
        const dupName = await AcademicYear.findOne({ school: req.schoolId, yearName: label }).lean();
        if (dupName) return err(res, `Academic year "${label}" already exists.`, 400);

        const clash = await findOverlappingYear(req.schoolId, startDate, endDate);
        if (clash) return err(res, overlapMessage(clash), 400);

        const year = await AcademicYear.create({
            yearName: label,
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

        const current = await AcademicYear.findOne({ _id: req.params.id, school: req.schoolId }).lean();
        if (!current) return err(res, 'Academic year not found', 404);

        const newStart = startDate || current.startDate;
        const newEnd   = endDate   || current.endDate;
        if (new Date(newEnd) <= new Date(newStart)) return err(res, 'End date must be after start date', 400);

        const label = (yearName || name || '').trim();
        if (label && label !== current.yearName) {
            const dupName = await AcademicYear.findOne({ school: req.schoolId, yearName: label }).lean();
            if (dupName) return err(res, `Academic year "${label}" already exists.`, 400);
        }

        const clash = await findOverlappingYear(req.schoolId, newStart, newEnd, req.params.id);
        if (clash) return err(res, overlapMessage(clash), 400);

        const update = { startDate: newStart, endDate: newEnd };
        if (label) update.yearName = label;
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
        const classes = (await Class.find(filter)
            .populate('academicYear', 'yearName status')
            .lean())
            .sort(byName('className'));
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
        const rawNum = classNumber ?? level;
        if (rawNum !== undefined && rawNum !== null && rawNum !== '' && (Number.isNaN(Number(rawNum)) || Number(rawNum) < 0))
            return err(res, 'Class number must be a non-negative number', 400);
        let yearId = academicYear;
        if (!yearId) {
            const active = await AcademicYear.findOne({ school: req.schoolId, status: 'active' });
            if (!active) return err(res, { message: 'No active academic year. Please set one first.' }, 400);
            yearId = active._id;
        }

        const label = (className || name).trim();
        // classNumber is part of a unique index (school + year + number). Blank
        // grades used to all collapse onto 0 and collide — derive it from the
        // class name instead, and fall back to the next free number.
        let num = (rawNum === undefined || rawNum === null || rawNum === '') ? null : Number(rawNum);
        if (num === null) {
            const digits = label.match(/\d+/);
            num = digits ? Number(digits[0]) : null;
        }

        const yearDoc  = await AcademicYear.findById(yearId).lean();
        const siblings = await Class.find({ school: req.schoolId, academicYear: yearId }, 'className classNumber').lean();
        const yearLabel = yearDoc?.yearName ? ` in ${yearDoc.yearName}` : '';

        const dupName = siblings.find(c => c.className.trim().toLowerCase() === label.toLowerCase());
        if (dupName) return err(res, { message: `Class "${label}" already exists${yearLabel}.` }, 400);

        if (num === null) {
            const used = new Set(siblings.map(c => Number(c.classNumber)));
            num = 0;
            while (used.has(num)) num++;
        } else {
            const dupNum = siblings.find(c => Number(c.classNumber) === num);
            if (dupNum) return err(res, { message: `Grade / level ${num} is already used by class "${dupNum.className}"${yearLabel}. Pick a different grade.` }, 400);
        }

        const cls = await Class.create({
            className: label,
            classNumber: num,
            academicYear: yearId,
            school: req.schoolId,
        });
        ok(res, cls, 201);
    } catch (e) {
        if (e.code === 11000) return err(res, { message: 'A class with this name or grade already exists in this academic year.' }, 400);
        err(res, e, 400);
    }
};
exports.getClassDetail = async (req, res) => {
    try {
        const cls = await Class.findById(req.params.classId).lean();
        const sections = (await ClassSection.find({ class: req.params.classId }).lean())
            .sort(byName('sectionName'));
        ok(res, { class: cls, sections });
    } catch (e) { err(res, e); }
};
exports.updateClass = async (req, res) => {
    try {
        const { name, className, status } = req.body;
        const cls = await Class.findOne({ _id: req.params.classId, school: req.schoolId }).lean();
        if (!cls) return err(res, { message: 'Class not found' }, 404);

        const update = {};
        const label  = (className || name || '').trim();
        if (label) {
            const siblings = await Class.find(
                { school: req.schoolId, academicYear: cls.academicYear, _id: { $ne: cls._id } },
                'className',
            ).lean();
            if (siblings.some(c => c.className.trim().toLowerCase() === label.toLowerCase()))
                return err(res, { message: `Class "${label}" already exists in this academic year.` }, 400);
            update.className = label;
        }
        if (status && ['active', 'inactive', 'archived'].includes(status)) update.status = status;
        if (!Object.keys(update).length) return err(res, { message: 'Nothing to update' }, 400);

        const updated = await Class.findByIdAndUpdate(req.params.classId, update, { new: true }).lean();
        ok(res, updated);
    } catch (e) {
        if (e.code === 11000) return err(res, { message: 'A class with this name already exists in this academic year.' }, 400);
        err(res, e, 400);
    }
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

        // Section names are stored uppercase — compare on the same footing so the
        // form gets a readable message instead of a raw unique-index violation.
        const label = (sectionName || name).trim().toUpperCase();
        const dup = await ClassSection.findOne({ class: req.params.classId, sectionName: label }).lean();
        if (dup) return err(res, { message: `Section "${label}" already exists in ${cls?.className || 'this class'}.` }, 400);

        const section = await ClassSection.create({
            sectionName: label,
            maxStudents: maxStudents || capacity || 40,
            class: req.params.classId,
            academicYear: cls?.academicYear,
            school: req.schoolId,
        });
        ok(res, section, 201);
    } catch (e) {
        if (e.code === 11000) return err(res, { message: `Section "${(req.body.sectionName || req.body.name || '').trim().toUpperCase()}" already exists in this class.` }, 400);
        err(res, e, 400);
    }
};
// Teacher picker for a section: flags who already holds a class-teacher post in
// the same academic year so the form can grey them out before submitting.
exports.getSectionTeacherOptions = async (req, res) => {
    try {
        const section = await ClassSection.findOne({ _id: req.params.sectionId, school: req.schoolId }).lean();
        if (!section) return err(res, { message: 'Section not found' }, 404);

        const [teachers, taken] = await Promise.all([
            User.find({ school: req.schoolId, role: 'teacher', isActive: true }, 'name email').sort({ name: 1 }).lean(),
            ClassSection.find(
                { school: req.schoolId, academicYear: section.academicYear, classTeacher: { $ne: null } },
                'classTeacher sectionName class',
            ).lean(),
        ]);

        const classes   = await Class.find({ _id: { $in: taken.map(t => t.class) } }, 'className').lean();
        const classById = Object.fromEntries(classes.map(c => [String(c._id), c.className]));
        const takenBy   = new Map(taken.map(t => [String(t.classTeacher), {
            sectionId: String(t._id),
            label:     `${classById[String(t.class)] || 'Class'} – ${t.sectionName}`,
        }]));

        ok(res, {
            classTeacher:      section.classTeacher      ? String(section.classTeacher)      : null,
            substituteTeacher: section.substituteTeacher ? String(section.substituteTeacher) : null,
            teachers: teachers.map(t => {
                const held = takenBy.get(String(t._id));
                return {
                    ...t,
                    // null when free, or the class/section they already lead
                    classTeacherOf: held && held.sectionId !== String(section._id) ? held.label : null,
                };
            }),
        });
    } catch (e) { err(res, e); }
};

// Section teacher group chat — class teacher + vice class teacher + subject teachers
exports.getSectionChatGroup = async (req, res) => {
    try {
        const chat = await Chat.findOne({
            school: req.schoolId, classSection: req.params.sectionId, type: 'group',
        }).lean();
        if (!chat) return ok(res, null);
        const members = await ChatMember.find({ chat: chat._id, isActive: true })
            .populate('user', 'name email').lean();
        ok(res, { ...chat, members: members.map(m => ({ ...m.user, memberRole: m.role })) });
    } catch (e) { err(res, e); }
};
exports.syncSectionChatGroup = async (req, res) => {
    try {
        const chat = await syncSectionChatGroup(req.params.sectionId, req.schoolId, req.userId);
        if (!chat) return err(res, { message: 'Assign a class teacher, vice class teacher or subject teacher first — a group needs at least one member.' }, 400);
        ok(res, chat, 201);
    } catch (e) { err(res, e); }
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
        const current = await ClassSection.findOne({ _id: req.params.sectionId, school: req.schoolId }).lean();
        if (!current) return err(res, { message: 'Section not found' }, 404);

        const update = {};
        if (req.body.teacherId     !== undefined) update.classTeacher      = req.body.teacherId     || null;
        if (req.body.viceTeacherId !== undefined) update.substituteTeacher = req.body.viceTeacherId || null;

        // Resulting pair after this update (either field may be omitted)
        const nextClassTeacher = update.classTeacher      !== undefined ? update.classTeacher      : current.classTeacher;
        const nextViceTeacher  = update.substituteTeacher !== undefined ? update.substituteTeacher : current.substituteTeacher;

        // A teacher cannot hold both roles in the same section
        if (nextClassTeacher && nextViceTeacher && String(nextClassTeacher) === String(nextViceTeacher))
            return err(res, { message: 'The class teacher and the vice class teacher must be two different teachers.' }, 400);

        // One class teacher post per teacher per academic year. Being vice class
        // teacher elsewhere (or of several sections) stays allowed.
        if (update.classTeacher) {
            const clash = await ClassSection.findOne({
                school:        req.schoolId,
                academicYear:  current.academicYear,
                classTeacher:  update.classTeacher,
                _id:           { $ne: current._id },
            }).lean();
            if (clash) {
                const cls = await Class.findById(clash.class, 'className').lean();
                const where = `${cls?.className || 'another class'} – ${clash.sectionName}`;
                return err(res, { message: `This teacher is already the class teacher of ${where}. A teacher can be class teacher of only one class.` }, 400);
            }
        }

        const section = await ClassSection.findByIdAndUpdate(req.params.sectionId, update, { new: true })
            .populate('classTeacher',     'name email phone')
            .populate('substituteTeacher','name email phone');

        // Keep the section's teacher group chat in step with the new line-up
        syncSectionChatGroup(req.params.sectionId, req.schoolId, req.userId).catch(() => {});

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
