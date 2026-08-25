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
const { rollNumberTaken } = require('../utils/rollNumbers');
const { capacityError, seatsFor, seatsOf } = require('../utils/sectionCapacity');
const { setStudentSection, syncCounts }   = require('../utils/sectionMembership');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Subject               = require('../models/Subject');
const School                = require('../models/School');
const { schoolWorksSaturday } = require('../utils/timetableDays');

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
// ── Section shuffle ───────────────────────────────────────────────────────────
/**
 * POST /admin/classes/:classId/shuffle-sections
 * Redistributes every student of the class across its sections at random,
 * respecting each section's capacity. Blocked once the class is locked;
 * moving individual students by hand keeps working either way.
 */
/**
 * Everything both the shuffle and its preview need: the class, its sections,
 * who is being redistributed and whether they fit. Shared so the dialog can
 * never promise something the shuffle would then refuse.
 */
async function gatherShuffle(req) {
    const cls = await Class.findOne({ _id: req.params.classId, school: req.schoolId }).lean();
    if (!cls) return { error: { message: 'Class not found' }, status: 404 };

    const sections = (await ClassSection.find({ class: cls._id, school: req.schoolId }).lean())
        .sort(byName('sectionName'));

    // Everyone in the class: already in a section, or admitted to the class
    // but not placed yet.
    const enrolled = sections.flatMap(s => (s.enrolledStudents || []).map(String));
    const unplaced = await StudentProfile.find(
        { school: req.schoolId, currentClass: cls._id, currentSection: null }, 'user',
    ).lean();
    const studentIds = [...new Set([...enrolled, ...unplaced.map(p => String(p.user))])];
    const capacity = sections.reduce((sum, s) => sum + (s.maxStudents || 0), 0);

    // Ordered by how the admin should act on them.
    let blocked = null;
    if (cls.sectionShuffle?.lockedAt)
        blocked = `Sections for ${cls.className} are locked for this academic year. Move students individually instead.`;
    else if (sections.length < 2)
        blocked = 'Add at least two sections before shuffling.';
    else if (!studentIds.length)
        blocked = 'This class has no students to shuffle.';
    else if (studentIds.length > capacity)
        blocked = `${studentIds.length} students do not fit in ${capacity} seats across ${sections.length} sections. `
                + `Raise a section's capacity by at least ${studentIds.length - capacity} before shuffling.`;

    return { cls, sections, studentIds, capacity, blocked };
}

/**
 * GET /admin/classes/:classId/shuffle-preview
 * What the confirm dialog shows before anything is moved: how many students
 * would be redistributed, how many seats exist across the sections, and the
 * reason when the answer is that it cannot be done.
 */
exports.shufflePreview = async (req, res) => {
    try {
        const g = await gatherShuffle(req);
        if (g.error) return err(res, g.error, g.status);
        ok(res, {
            className: g.cls.className,
            students: g.studentIds.length,
            capacity: g.capacity,
            shortfall: Math.max(0, g.studentIds.length - g.capacity),
            sectionCount: g.sections.length,
            sections: g.sections.map(s => ({
                _id: String(s._id),
                sectionName: s.sectionName,
                maxStudents: s.maxStudents || 0,
                currentCount: (s.enrolledStudents || []).length,
            })),
            locked: !!g.cls.sectionShuffle?.lockedAt,
            canShuffle: !g.blocked,
            reason: g.blocked || '',
        });
    } catch (e) { err(res, e); }
};

exports.shuffleSections = async (req, res) => {
    try {
        const g = await gatherShuffle(req);
        if (g.error) return err(res, g.error, g.status);
        // Re-checked here, not just in the dialog: the preview is a courtesy,
        // this is the rule.
        if (g.blocked) return err(res, { message: g.blocked }, 400);
        const { cls, sections, studentIds } = g;

        // Fisher–Yates, then deal round-robin so sections stay balanced
        const pool = [...studentIds];
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const buckets = sections.map(s => ({ section: s, students: [] }));
        let cursor = 0;
        for (const studentId of pool) {
            // Skip sections that are already at capacity
            let placed = false;
            for (let step = 0; step < buckets.length && !placed; step++) {
                const b = buckets[(cursor + step) % buckets.length];
                if (b.students.length < (b.section.maxStudents || 0)) {
                    b.students.push(studentId);
                    cursor = (cursor + step + 1) % buckets.length;
                    placed = true;
                }
            }
            if (!placed) return err(res, { message: 'Could not place every student — check section capacities.' }, 400);
        }

        // Rewrite rosters, profiles and headcounts
        for (const { section, students } of buckets) {
            await ClassSection.findByIdAndUpdate(section._id, {
                $set: {
                    enrolledStudents: students,
                    currentCount: students.length,
                    // Roll numbers are per section, so a reshuffle invalidates
                    // them — the admin re-runs "Assign Roll Numbers" after this.
                    rollNumbersAssignedAt: null,
                },
            });
            if (students.length) {
                await StudentProfile.updateMany(
                    { user: { $in: students } },
                    { $set: { currentSection: section._id, currentClass: cls._id, rollNumber: '' } },
                );
            }
        }

        const shuffledAt = new Date();
        await Class.findByIdAndUpdate(cls._id, { $set: { 'sectionShuffle.shuffledAt': shuffledAt } });

        ok(res, {
            shuffledAt,
            students: studentIds.length,
            sections: buckets.map(b => ({ _id: b.section._id, sectionName: b.section.sectionName, count: b.students.length })),
        });
    } catch (e) { err(res, e); }
};

/** POST /admin/classes/:classId/lock-sections — freeze shuffling for this year */
exports.lockSectionShuffle = async (req, res) => {
    try {
        const cls = await Class.findOne({ _id: req.params.classId, school: req.schoolId }).lean();
        if (!cls) return err(res, { message: 'Class not found' }, 404);
        if (cls.sectionShuffle?.lockedAt) return err(res, { message: 'Sections are already locked for this class.' }, 400);
        if (!cls.sectionShuffle?.shuffledAt)
            return err(res, { message: 'Shuffle the sections before locking them.' }, 400);

        const lockedAt = new Date();
        await Class.findByIdAndUpdate(cls._id, {
            $set: { 'sectionShuffle.lockedAt': lockedAt, 'sectionShuffle.lockedBy': req.userId },
        });
        ok(res, { lockedAt });
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

        // Point each promoted student's profile at their new section — and at
        // the class that section belongs to. Writing only the section left
        // promoted students recorded against last year's class, which is what
        // the shuffle and the section picker read.
        const promotedInto = await ClassSection.find(
            { _id: { $in: Object.keys(sectionAddMap) } }, '_id class',
        ).lean();
        const classOfSection = new Map(promotedInto.map(s => [String(s._id), s.class]));
        for (const [sectionId, userIds] of Object.entries(sectionAddMap)) {
            const set = { currentSection: sectionId };
            const cls = classOfSection.get(String(sectionId));
            if (cls) set.currentClass = cls;
            await StudentProfile.updateMany({ user: { $in: userIds } }, { $set: set });
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

        // Born in step with the school's week, so a new section is usable
        // immediately instead of waiting on a School Settings save.
        const school = await School.findById(req.schoolId).select('leaveSettings').lean();

        const section = await ClassSection.create({
            sectionName: label,
            maxStudents: maxStudents || capacity || 40,
            class: req.params.classId,
            academicYear: cls?.academicYear,
            school: req.schoolId,
            openOnSaturday: schoolWorksSaturday(school),
        });
        ok(res, section, 201);
    } catch (e) {
        if (e.code === 11000) return err(res, { message: `Section "${(req.body.sectionName || req.body.name || '').trim().toUpperCase()}" already exists in this class.` }, 400);
        err(res, e, 400);
    }
};
// Teacher picker for a section: flags who already holds a class-teacher post in
// the same academic year so the form can grey them out before submitting.
/**
 * What each teacher already carries this academic year: how many sections they
 * teach each subject in, and the total across all of them.
 *
 * The subject-teacher dropdown used to show bare names, so an admin adding one
 * more class to someone had no way of knowing they already had eight. Keyed by
 * teacher id: { total, bySubject: [{ subject, subjectName, sections }] },
 * heaviest subject first.
 */
async function teachingLoadByTeacher(schoolId, academicYearId) {
    const sections = await ClassSection.find(
        { school: schoolId, ...(academicYearId ? { academicYear: academicYearId } : {}) }, '_id',
    ).lean();
    if (!sections.length) return {};

    const rows = await SectionSubjectTeacher.find({ section: { $in: sections.map(s => s._id) } })
        .select('teacher subject section').lean();
    if (!rows.length) return {};

    const subjectIds = [...new Set(rows.map(r => String(r.subject)))];
    const subjects   = await Subject.find({ _id: { $in: subjectIds } }, 'subjectName').lean();
    const nameOf     = Object.fromEntries(subjects.map(s => [String(s._id), s.subjectName]));

    // teacher -> subject -> set of sections. A teacher can hold the same
    // subject in several sections, and that is exactly the count wanted.
    const perTeacher = new Map();
    for (const r of rows) {
        const t = String(r.teacher);
        if (!perTeacher.has(t)) perTeacher.set(t, new Map());
        const bySubject = perTeacher.get(t);
        const sub = String(r.subject);
        if (!bySubject.has(sub)) bySubject.set(sub, new Set());
        bySubject.get(sub).add(String(r.section));
    }

    const out = {};
    for (const [teacherId, bySubject] of perTeacher) {
        const list = [...bySubject.entries()]
            .map(([subject, secs]) => ({ subject, subjectName: nameOf[subject] || 'Subject', sections: secs.size }))
            .sort((a, b) => b.sections - a.sections || a.subjectName.localeCompare(b.subjectName));
        out[teacherId] = { total: list.reduce((n, x) => n + x.sections, 0), bySubject: list };
    }
    return out;
}

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
            load: await teachingLoadByTeacher(req.schoolId, section.academicYear),
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
            section.enrolledStudents = enrolled
                .map(s => ({
                    ...s,
                    rollNumber:      pMap[s._id.toString()]?.rollNumber || '',
                    admissionNumber: pMap[s._id.toString()]?.admissionNumber || '',
                    gender:          pMap[s._id.toString()]?.gender || '',
                }))
                // Roll-number order; students without one sort last, by name
                .sort((a, b) => {
                    if (!a.rollNumber && !b.rollNumber) return byName('name')(a, b);
                    if (!a.rollNumber) return 1;
                    if (!b.rollNumber) return -1;
                    return byName('rollNumber')(a, b);
                });
        }

        ok(res, section);
    } catch (e) { err(res, e); }
};
// ── Roll numbers ──────────────────────────────────────────────────────────────

/** POST /admin/sections/:sectionId/assign-roll-numbers — one-time bulk numbering */
exports.assignRollNumbers = async (req, res) => {
    try {
        const section = await ClassSection.findOne({ _id: req.params.sectionId, school: req.schoolId }).lean();
        if (!section) return err(res, { message: 'Section not found' }, 404);
        if (section.rollNumbersAssignedAt)
            return err(res, { message: 'Roll numbers have already been assigned for this section. Edit individual roll numbers instead.' }, 400);

        const ids = (section.enrolledStudents || []).map(String);
        if (!ids.length) return err(res, { message: 'Enrol students in this section first.' }, 400);

        const students = await User.find({ _id: { $in: ids } }, 'name').lean();
        students.sort((a, b) =>
            String(a.name || '').localeCompare(String(b.name || ''), 'en', { numeric: true, sensitivity: 'base' }));

        // Sequential 1..N in alphabetical name order
        for (let i = 0; i < students.length; i++) {
            await StudentProfile.updateOne(
                { user: students[i]._id },
                { $set: { rollNumber: String(i + 1) } },
            );
        }
        await ClassSection.findByIdAndUpdate(section._id, { rollNumbersAssignedAt: new Date() });

        ok(res, {
            assigned: students.length,
            assignedAt: new Date(),
            students: students.map((s, i) => ({ _id: s._id, name: s.name, rollNumber: String(i + 1) })),
        });
    } catch (e) { err(res, e); }
};

/** PUT /admin/sections/:sectionId/students/:studentId/roll-number */
exports.updateStudentRollNumber = async (req, res) => {
    try {
        const rollNumber = String(req.body.rollNumber ?? '').trim();
        const { sectionId, studentId } = req.params;

        const section = await ClassSection.findOne({ _id: sectionId, school: req.schoolId }).lean();
        if (!section) return err(res, { message: 'Section not found' }, 404);
        if (!(section.enrolledStudents || []).map(String).includes(String(studentId)))
            return err(res, { message: 'That student is not enrolled in this section' }, 400);

        if (rollNumber) {
            const takenBy = await rollNumberTaken(sectionId, rollNumber, studentId);
            if (takenBy) return err(res, { message: `Roll number ${rollNumber} is already used by ${takenBy} in this section.` }, 400);
        }

        // Writing to StudentProfile is what every other screen reads, so the
        // change shows up on the student record too — not just here.
        await StudentProfile.updateOne(
            { user: studentId, school: req.schoolId },
            { $set: { rollNumber } },
            { upsert: true },
        );
        ok(res, { student: studentId, rollNumber });
    } catch (e) { err(res, e); }
};

/**
 * GET /admin/sections/:sectionId/assignable-students
 * The pool the "add students" picker draws from. Everyone already on this
 * section's roster is left out — they are not a choice to make — and everyone
 * held by another section this academic year comes back flagged, with where
 * they are, so the picker can explain itself instead of silently hiding them.
 */
exports.getAssignableStudents = async (req, res) => {
    try {
        const { search = '', limit = 100 } = req.query;

        const section = await ClassSection.findOne({ _id: req.params.sectionId, school: req.schoolId }).lean();
        if (!section) return err(res, { message: 'Section not found' }, 404);

        const alreadyHere = new Set((section.enrolledStudents || []).map(String));

        // Who this academic year's other sections are holding, and which one.
        const siblings = await ClassSection.find(
            { school: req.schoolId, academicYear: section.academicYear, _id: { $ne: section._id } },
            '_id sectionName class enrolledStudents',
        ).lean();
        const classNames = {};
        if (siblings.length) {
            const classes = await Class.find({ _id: { $in: [...new Set(siblings.map(s => String(s.class)))] } }, 'className').lean();
            classes.forEach(c => { classNames[String(c._id)] = c.className; });
        }
        const heldBy = new Map();
        for (const sib of siblings) {
            const where = `${classNames[String(sib.class)] || 'Another class'} – ${sib.sectionName}`;
            for (const id of sib.enrolledStudents || []) heldBy.set(String(id), where);
        }

        const filter = { school: String(req.schoolId), role: 'student', isActive: { $ne: false } };
        if (String(search).trim()) {
            const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [{ name: rx }, { email: rx }];
        }

        // The roster is excluded here rather than after the limit, so a section
        // with many students still fills a full page of actual candidates.
        const users = await User.find(filter, 'name email profileImage').lean();
        const candidates = users
            .filter(u => !alreadyHere.has(String(u._id)))
            .sort(byName('name'));

        const profiles = candidates.length
            ? await StudentProfile.find(
                { user: { $in: candidates.map(u => u._id) } },
                'user rollNumber gender admissionNumber currentClass currentSection',
            ).lean()
            : [];
        const pMap = {};
        profiles.forEach(p => { pMap[String(p.user)] = p; });

        const sameClass = String(section.class);
        const rows = candidates.map(u => {
            const p    = pMap[String(u._id)] || {};
            const held = heldBy.get(String(u._id)) || null;
            return {
                _id:             u._id,
                name:            u.name,
                email:           u.email,
                admissionNumber: p.admissionNumber || '',
                rollNumber:      p.rollNumber || '',
                gender:          p.gender || '',
                enrolledIn:      held,
                assignable:      !held,
                reason:          held ? `Already in ${held}` : '',
                // Students admitted to this class but never placed are the ones
                // the admin is nearly always looking for — surfaced first below.
                sameClass:       !held && String(p.currentClass || '') === sameClass,
            };
        });

        // Unplaced students of this very class, then other free students, then
        // the ones another section is holding.
        const rank = (r) => (r.sameClass ? 0 : r.assignable ? 1 : 2);
        rows.sort((a, b) => rank(a) - rank(b) || byName('name')(a, b));

        const capped    = rows.slice(0, Math.max(1, Number(limit) || 100));
        const { free, capacity, occupied } = seatsFor(section);

        ok(res, {
            students:  capped,
            total:     rows.length,
            truncated: rows.length > capped.length,
            seats:     { capacity, occupied, free: capacity ? free : null },
        });
    } catch (e) { err(res, e); }
};

/**
 * POST /admin/sections/:sectionId/assign-student
 * Enrols one student (`studentId`) or several at once (`studentIds`). Every
 * student is judged on their own — one blocked by another section's roster does
 * not stop the rest — and the response says what happened to each, so the
 * picker can report "4 enrolled, 1 skipped" rather than a single yes/no.
 */
exports.assignStudentToSection = async (req, res) => {
    try {
        const requested = [...new Set(
            (Array.isArray(req.body.studentIds) ? req.body.studentIds : [req.body.studentId])
                .map(id => (id == null ? '' : String(id).trim()))
                .filter(Boolean)
        )];
        if (!requested.length) return err(res, { message: 'studentId is required' }, 400);

        const section = await ClassSection.findById(req.params.sectionId).lean();
        if (!section) return err(res, { message: 'Section not found' }, 404);

        const roster = new Set((section.enrolledStudents || []).map(String));

        // One lookup for the whole batch: who another section already holds.
        const clashes = await ClassSection.find({
            academicYear:     section.academicYear,
            enrolledStudents: { $in: requested },
            _id:              { $ne: section._id },
        }, '_id sectionName enrolledStudents').lean();
        const heldBy = new Map();
        for (const c of clashes) {
            for (const id of c.enrolledStudents || []) {
                if (requested.includes(String(id)) && !heldBy.has(String(id))) heldBy.set(String(id), c.sectionName);
            }
        }

        // Scoped to students of this school: an id that is a teacher, or belongs
        // to another school, is refused as "not found" rather than enrolled —
        // which would also have created a student record for them.
        const names = {};
        (await User.find({ _id: { $in: requested }, role: 'student', school: req.schoolId }, 'name').lean())
            .forEach(u => { names[String(u._id)] = u.name; });

        // Seats are counted once for the batch and spent as students are placed,
        // so adding five to a section with three free seats fills the three and
        // says so — rather than letting all five in past the limit.
        let free = seatsFor(section).free;
        const unlimited = !seatsOf(section);

        // Where the numbering has reached, so a batch continues 12, 13, 14…
        let nextRoll = null;
        if (section.rollNumbersAssignedAt) {
            const peers = (section.enrolledStudents || []).map(String);
            const peerProfiles = peers.length
                ? await StudentProfile.find({ user: { $in: peers } }, 'rollNumber').lean()
                : [];
            nextRoll = peerProfiles.reduce((max, p) => {
                const n = Number(String(p.rollNumber || '').trim());
                return Number.isFinite(n) ? Math.max(max, n) : max;
            }, 0);
        }

        const enrolled = [], skipped = [], failed = [];

        for (const studentId of requested) {
            const name = names[studentId] || 'Student';
            if (!names[studentId]) { failed.push({ _id: studentId, name, reason: 'Student not found' }); continue; }
            if (roster.has(studentId)) { skipped.push({ _id: studentId, name, reason: 'Already in this section' }); continue; }

            const held = heldBy.get(studentId);
            if (held) {
                failed.push({ _id: studentId, name, reason: `Already enrolled in section "${held}" — remove them from it first` });
                continue;
            }
            if (!unlimited && free <= 0) {
                failed.push({ _id: studentId, name, reason: `Section ${section.sectionName} is full` });
                continue;
            }

            roster.add(studentId);
            free -= 1;

            // Once a section has been numbered, a student joining later continues
            // the sequence instead of arriving without a roll number.
            let assignedRoll = null;
            if (nextRoll !== null) {
                const mine = await StudentProfile.findOne({ user: studentId }, 'rollNumber').lean();
                const currentRoll = String(mine?.rollNumber || '').trim();
                const keepExisting = currentRoll && !(await rollNumberTaken(section._id, currentRoll, studentId));
                if (keepExisting) {
                    const n = Number(currentRoll);
                    if (Number.isFinite(n)) nextRoll = Math.max(nextRoll, n);
                } else {
                    nextRoll += 1;
                    assignedRoll = String(nextRoll);
                }
            }

            // Roster and student record are written together — see
            // utils/sectionMembership. It creates the record when the student
            // has none, so enrolling can never leave a student on the class list
            // with their own class and section blank. Headcounts are recomputed
            // once after the loop rather than per student.
            await setStudentSection({
                studentId,
                sectionId:   req.params.sectionId,
                schoolId:    req.schoolId,
                classId:     section.class,
                extra:       assignedRoll ? { rollNumber: assignedRoll } : null,
                deferCounts: true,
            });
            enrolled.push({ _id: studentId, name, rollNumber: assignedRoll });
        }

        if (enrolled.length) await syncCounts([req.params.sectionId]);

        // A single-student call that could not be honoured still reads as an
        // error, the way the picker has always treated it.
        if (requested.length === 1 && failed.length === 1) return err(res, { message: failed[0].reason }, 400);

        const parts = [];
        if (enrolled.length) parts.push(`${enrolled.length} student${enrolled.length === 1 ? '' : 's'} enrolled`);
        if (skipped.length)  parts.push(`${skipped.length} already in this section`);
        if (failed.length)   parts.push(`${failed.length} could not be enrolled`);

        ok(res, {
            message: parts.join(', ') || 'Nothing to do',
            enrolled, skipped, failed,
            // Kept for callers written against the old single-student response
            rollNumber: enrolled.length === 1 ? enrolled[0].rollNumber : null,
        });
    } catch (e) { err(res, e); }
};
exports.removeStudentFromSection = async (req, res) => {
    try {
        const { studentId } = req.body;
        if (!studentId) return err(res, { message: 'studentId is required' }, 400);
        // Roster and profile are two halves of one fact — see
        // utils/sectionMembership. Passing no section unenrols them from every
        // section and recomputes the headcounts from the actual rosters, so the
        // counter cannot drift below zero the way $inc could.
        await setStudentSection({ studentId, sectionId: null, schoolId: req.schoolId });
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
        // The schema field is maxStudents — writing `capacity` silently did nothing
        const cap = Number(req.body.maxStudents ?? req.body.capacity);
        if (!Number.isFinite(cap) || cap < 1)
            return err(res, { message: 'Capacity must be a positive number' }, 400);

        const section = await ClassSection.findOne({ _id: req.params.sectionId, school: req.schoolId }).lean();
        if (!section) return err(res, { message: 'Section not found' }, 404);
        const enrolled = (section.enrolledStudents || []).length;
        if (cap < enrolled)
            return err(res, { message: `${enrolled} students are already enrolled — capacity cannot be below that.` }, 400);

        const updated = await ClassSection.findByIdAndUpdate(
            req.params.sectionId, { maxStudents: cap }, { new: true }
        );
        ok(res, updated);
    } catch (e) { err(res, e); }
};
exports.deleteSection = async (req, res) => {
    try {
        await ClassSection.findByIdAndDelete(req.params.sectionId);
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
