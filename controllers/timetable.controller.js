'use strict';
const Timetable            = require('../models/Timetable');
const TimetableEntry       = require('../models/TimetableEntry');
const ClassSection         = require('../models/ClassSection');
const Class                = require('../models/Class');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const School               = require('../models/School');
// One resolver for "does this section teach on Saturday" — utils/timetableDays.js
// explains why the school flag and the section flag used to disagree.
const { daysForSection, syncSectionsToSchoolSaturday } = require('../utils/timetableDays');
// The same rules the solver enforces, applied to hand edits.
const { validateManualEntries } = require('../services/manualTimetableRules');

const ok  = (res, d, s = 200) => res.status(s).json({ success: true,  data: d });
const err = (res, e, s = 500) => res.status(s).json({ success: false, message: e.message || e });

/* ── helpers ─────────────────────────────────────────────────────────────── */
const getActiveYear = async (schoolId) => {
    const AcademicYear = require('../models/AcademicYear');
    return AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
};

// Resolve year: prefer explicit yearId, fall back to active year
const resolveYear = async (schoolId, yearId) => {
    const AcademicYear = require('../models/AcademicYear');
    if (yearId) return AcademicYear.findOne({ _id: yearId, school: schoolId }).lean();
    return AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
};

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN
══════════════════════════════════════════════════════════════════════════ */

exports.adminManageTimetable = async (req, res) => {
    try {
        const School = require('../models/School');
        const year   = await resolveYear(req.schoolId, req.query.yearId);
        const [ttYear, school, allYears] = await Promise.all([
            Timetable.findOne({ section: req.params.sectionId, academicYear: year?._id }).lean(),
            School.findById(req.schoolId).select('leaveSettings').lean(),
            require('../models/AcademicYear').find({ school: req.schoolId }).sort({ createdAt: -1 }).lean(),
        ]);
        // Only fall back to any-year timetable when no yearId was explicitly requested
        const tt = ttYear || (!req.query.yearId ? await Timetable.findOne({ section: req.params.sectionId }).lean() : null);
        const ls = school?.leaveSettings || {};
        ok(res, {
            ...(tt || {}),
            saturdayConfig: {
                working:  ls.saturdayWorking  !== false,
                mode:     ls.saturdayMode     || 'all',
                halfDay:  !!ls.saturdayHalfDay,
            },
            years:          allYears,
            selectedYearId: year?._id || null,
        });
    } catch (e) { err(res, e); }
};

exports.adminSaveTimetableStructure = async (req, res) => {
    try {
        const { schoolStartTime, schoolEndTime, periods, periodsStructure,
                totalPeriods, lunchTimeTotalInMinutes, lunchAfterPeriod, openOnSaturday } = req.body;

        // Support two modes:
        // 1. Manual mode: client sends periodsStructure / periods array directly
        // 2. Auto-calc mode: client sends timing params and we calculate
        let computedPeriods = periods || periodsStructure;

        if (!computedPeriods && schoolStartTime && schoolEndTime && totalPeriods) {
            // Auto-calculate period slots
            const parseTime = t => { const [h, m] = t.split(':'); return parseInt(h) * 60 + parseInt(m); };
            const formatTime = m => `${Math.floor(m / 60).toString().padStart(2, '0')}:${Math.floor(m % 60).toString().padStart(2, '0')}`;

            const lunchMins  = parseInt(lunchTimeTotalInMinutes) || 30;
            const lunchAfter = parseInt(lunchAfterPeriod)        || 4;
            const nPeriods   = parseInt(totalPeriods)            || 8;
            let   startMin   = parseTime(schoolStartTime);
            const endMin     = parseTime(schoolEndTime);
            const totalAvail = endMin - startMin - lunchMins;
            const periodLen  = Math.floor(totalAvail / nPeriods);
            const remainder  = totalAvail % nPeriods;

            computedPeriods = [];
            let pCount = 1;
            for (let i = 1; i <= nPeriods + 1; i++) {
                if (i - 1 === lunchAfter) {
                    computedPeriods.push({ periodNumber: 0, startTime: formatTime(startMin), endTime: formatTime(startMin + lunchMins), isRecess: true, recessName: 'Lunch' });
                    startMin += lunchMins;
                }
                if (pCount <= nPeriods) {
                    const pDur = periodLen + (pCount === nPeriods ? remainder : 0);
                    computedPeriods.push({ periodNumber: pCount, startTime: formatTime(startMin), endTime: formatTime(startMin + pDur), isRecess: false, recessName: 'Period' });
                    startMin += pDur;
                    pCount++;
                }
            }
        }

        // Bring EVERY section back in step with the school setting, not just this
        // one: per-section drift is exactly what hid Saturday before.
        {
            const School = require('../models/School');
            const school = await School.findById(req.schoolId).select('leaveSettings').lean();
            await syncSectionsToSchoolSaturday(req.schoolId, school);
        }

        const year = await resolveYear(req.schoolId, req.body.yearId);
        const tt = await Timetable.findOneAndUpdate(
            { section: req.params.sectionId, academicYear: year?._id },
            {
                $set: {
                    schoolStartTime:  schoolStartTime || '',
                    schoolEndTime:    schoolEndTime   || '',
                    periodsStructure: computedPeriods || [],
                    academicYear:     year?._id,
                },
                $setOnInsert: {
                    section:   req.params.sectionId,
                    createdBy: req.userId,
                },
            },
            { upsert: true, new: true }
        );
        ok(res, tt);
    } catch (e) { err(res, e); }
};

exports.adminAssignPeriods = async (req, res) => {
    try {
        const year   = await resolveYear(req.schoolId, req.query.yearId);
        const ttYear = year ? await Timetable.findOne({ section: req.params.sectionId, academicYear: year._id }).lean() : null;
        const tt     = ttYear || (!req.query.yearId ? await Timetable.findOne({ section: req.params.sectionId }).lean() : null);
        if (!tt) return ok(res, []);

        const entries = await TimetableEntry.find({ timetable: tt._id })
            .populate('subject', 'subjectName')
            .populate('teacher', 'name email')
            .populate('additionalSubjects.subject', 'subjectName')
            .populate('additionalSubjects.teacher', 'name email')
            .populate('mergedSections', 'sectionName')
            .lean();

        ok(res, entries);
    } catch (e) { err(res, e); }
};

/**
 * Turn the merges drawn in the grid into merge groups the generator honours.
 *
 * Scoped to this section: a group is created or refreshed for every subject this
 * section merges, and groups it has walked away from are dropped. Other
 * sections' merges are left alone — this save speaks only for this section.
 */
async function syncManualMerges({ schoolId, academicYear, sectionId, rows, userId }) {
    const TimetableMergeGroup = require('../models/TimetableMergeGroup');
    if (!academicYear) return;

    // subject -> the full set of sections sitting together for it
    const wanted = new Map();
    for (const r of rows) {
        const partners = (r.mergedSections || []).map(String).filter(Boolean);
        if (!partners.length) continue;
        const key = String(r.subject);
        const members = new Set([...(wanted.get(key) || []), String(sectionId), ...partners]);
        wanted.set(key, members);
    }

    const existing = await TimetableMergeGroup.find({
        school: schoolId, academicYear, source: 'manual',
    }).lean();

    for (const [subject, members] of wanted) {
        const sections = [...members];
        const match = existing.find((g) => String(g.subject) === subject
            && (g.sections || []).map(String).includes(String(sectionId)));
        if (match) {
            await TimetableMergeGroup.updateOne({ _id: match._id }, { $set: { sections, isActive: true } });
        } else {
            await TimetableMergeGroup.create({
                school: schoolId, academicYear, subject, sections,
                source: 'manual', isActive: true, createdBy: userId,
            });
        }
    }

    // Merges this section no longer draws are no longer merges.
    const stale = existing.filter((g) => (g.sections || []).map(String).includes(String(sectionId))
        && !wanted.has(String(g.subject)));
    if (stale.length) {
        await TimetableMergeGroup.deleteMany({ _id: { $in: stale.map((g) => g._id) } });
    }
}

exports.adminSaveEntries = async (req, res) => {
    try {
        const { sectionId } = req.params;

        const year = await resolveYear(req.schoolId, req.body.yearId);
        let tt = await Timetable.findOne({ section: sectionId, academicYear: year?._id });
        if (!tt) {
            // fallback: find any timetable for this section to copy structure
            const existing = await Timetable.findOne({ section: sectionId }).lean();
            tt = await Timetable.create({
                section:          sectionId,
                academicYear:     year?._id,
                createdBy:        req.userId,
                schoolStartTime:  existing?.schoolStartTime  || '08:00',
                schoolEndTime:    existing?.schoolEndTime    || '15:00',
                periodsStructure: existing?.periodsStructure?.length
                    ? existing.periodsStructure
                    : Array.from({ length: 8 }, (_, i) => ({
                        periodNumber: i + 1, startTime: '', endTime: '', isRecess: false,
                      })),
            });
        }

        const entries = Array.isArray(req.body) ? req.body : req.body.entries || [];
        const force   = req.body.force === true || req.body.force === 'true';

        // What is on record now. The grid posts subject + teacher only, so the
        // room and the version this slot was published from have to be carried
        // across or a hand edit silently strips the generator's work from the
        // whole section.
        const current = await TimetableEntry.find({ timetable: tt._id }).lean();
        const carryBySlot = new Map(current.map(e => [`${e.dayOfWeek}#${e.periodNumber}`, e]));

        const toInsert = entries
            .filter(e => e.subject)
            .map(e => {
                const prior = carryBySlot.get(`${e.dayOfWeek}#${e.periodNumber}`);
                // The room follows the slot, but only while the slot still holds
                // the same subject — reassign the period and its old room is not
                // automatically the right one.
                const keepRoom = prior && String(prior.subject) === String(e.subject);
                return {
                    timetable:          tt._id,
                    dayOfWeek:          e.dayOfWeek,
                    periodNumber:       e.periodNumber,
                    subject:            e.subject,
                    teacher:            e.teacher    || null,
                    room:               e.room !== undefined ? (e.room || null) : (keepRoom ? prior.room || null : null),
                    sourceVersion:      prior?.sourceVersion || null,
                    isManual:           true,
                    additionalSubjects: (e.additionalSubjects || []).filter(a => a.subject),
                    mergedSections:     (e.mergedSections     || []).filter(Boolean),
                };
            });

        const problems = await validateManualEntries({
            schoolId: req.schoolId, timetable: tt, sectionId, rows: toInsert,
        });
        // `fatal` is never overridable — the grid could not hold it and the unique
        // index would reject the write regardless of what the admin insists on.
        const fatal    = problems.filter(p => p.severity === 'fatal');
        const blocking = problems.filter(p => p.severity === 'error');
        if (fatal.length) {
            return res.status(409).json({
                success: false,
                message: fatal.length === 1 ? fatal[0].message : `${fatal.length} periods cannot be placed as laid out`,
                data: { conflicts: problems, blocked: true, overridable: false },
            });
        }
        if (blocking.length && !force) {
            return res.status(409).json({
                success: false,
                message: `${blocking.length} conflict(s) would break this timetable`,
                data: { conflicts: problems, blocked: true, overridable: true },
            });
        }

        await TimetableEntry.deleteMany({ timetable: tt._id });
        if (toInsert.length) await TimetableEntry.insertMany(toInsert);
        const conflicts = problems;

        // A period merged by hand used to live only in this row, so the next
        // generation run knew nothing about it and pulled the sections apart
        // again. Recording it as a merge group is what makes it stick.
        await syncManualMerges({
            schoolId: req.schoolId, academicYear: tt.academicYear,
            sectionId, rows: toInsert, userId: req.userId,
        });

        // Notify the section's students + assigned teachers about the update
        setImmediate(async () => {
            try {
                const ClassSection = require('../models/ClassSection');
                const { notify } = require('../services/notifyService');
                const sec = await ClassSection.findById(sectionId)
                    .populate('class', 'className').select('sectionName class enrolledStudents').lean();
                if (!sec) return;
                const label      = `${sec.class?.className || ''} ${sec.sectionName || ''}`.trim();
                const teacherIds = [...new Set(toInsert.map(e => e.teacher?.toString()).filter(Boolean))];
                notify({
                    school: req.schoolId, sender: req.userId, senderRole: req.userRole,
                    title: '🗓️ Timetable updated',
                    body: `The timetable for ${label || 'your section'} has been updated. Check the new schedule.`,
                    recipients: [...(sec.enrolledStudents || []), ...teacherIds],
                    link: { type: 'timetable.section', params: { sectionId: String(sec._id) } },
                });
            } catch (e) { console.error('[timetable-notif]', e.message); }
        });

        ok(res, { saved: toInsert.length, conflicts, forced: force && blocking.length > 0, timetableId: tt._id });
    } catch (e) { err(res, e); }
};

/* ── Teacher availability API ────────────────────────────────────────────── */
exports.getTeachersBySubject = async (req, res) => {
    try {
        const User    = require('../models/User');
        const { subjectId, day, period, timetableId, sectionId } = req.query;

        let potentialTeachers = [];

        // Prefer section-specific assignments
        if (sectionId) {
            const assignments = await SectionSubjectTeacher.find({ section: sectionId, subject: subjectId })
                .populate({ path: 'teacher', select: 'name email isActive' }).lean();
            potentialTeachers = assignments.map(a => a.teacher).filter(t => t && t.isActive !== false);
        }

        if (potentialTeachers.length === 0) {
            const records = await SectionSubjectTeacher.find({ subject: subjectId })
                .populate({ path: 'teacher', select: 'name email isActive' }).lean();
            const seen = new Set();
            potentialTeachers = records.map(r => r.teacher).filter(t => t && t.isActive !== false && !seen.has(String(t._id)) && seen.add(String(t._id)));
        }

        if (potentialTeachers.length === 0) {
            potentialTeachers = await User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('name email').lean();
        }

        // Filter by availability for the requested day+period
        let availableTeachers = potentialTeachers;
        if (day && period) {
            // Resolve which timetable to exclude (always exclude the current section's own timetable)
            let excludeTtId = timetableId || null;
            if (!excludeTtId && sectionId) {
                const sectionTt = await Timetable.findOne({ section: sectionId }).select('_id').lean();
                excludeTtId = sectionTt?._id || null;
            }

            const conflictQuery = {
                teacher:      { $in: potentialTeachers.map(t => t._id) },
                dayOfWeek:    day,
                periodNumber: parseInt(period),
            };
            if (excludeTtId) conflictQuery.timetable = { $ne: excludeTtId };

            const busy = await TimetableEntry.find(conflictQuery).select('teacher').lean();
            const busyIds = new Set(busy.map(b => String(b.teacher)));
            availableTeachers = potentialTeachers.filter(t => !busyIds.has(String(t._id)));
        }
        ok(res, availableTeachers);
    } catch (e) { err(res, e); }
};

/* ══════════════════════════════════════════════════════════════════════════
   PDF DOWNLOADS
══════════════════════════════════════════════════════════════════════════ */

exports.adminDownloadSectionTimetable = async (req, res) => {
    try {
        const School  = require('../models/School');
        const { sectionId } = req.params;

        const section = await ClassSection.findById(sectionId).populate('class').populate('academicYear').lean();
        if (!section) return res.status(404).send('Section not found.');

        const dlYear = await resolveYear(req.schoolId, req.query.yearId);
        const tt = dlYear
            ? await Timetable.findOne({ section: sectionId, academicYear: dlYear._id }).lean()
              || await Timetable.findOne({ section: sectionId }).lean()
            : await Timetable.findOne({ section: sectionId }).lean();
        if (!tt) return res.status(404).send('No timetable configured for this section.');

        const entries = await TimetableEntry.find({ timetable: tt._id })
            .populate('subject', 'subjectName').populate('teacher', 'name')
            .populate('additionalSubjects.subject', 'subjectName')
            .populate('additionalSubjects.teacher', 'name')
            .populate('mergedSections', 'sectionName')
            .lean();

        const school = await School.findById(req.schoolId).lean();
        const days   = daysForSection(section, school);

        const { generateTimetablePDF } = require('../utils/timetablePdf');

        generateTimetablePDF(res, [{
            className:   section.class?.className || 'Class',
            sectionName: section.sectionName,
            yearName:    section.academicYear?.yearName || '',
            timetable:   tt,
            entries,
            days,
        }], school, `timetable-${section.class?.className}-${section.sectionName}.pdf`);
    } catch (e) {
        console.error(e);
        res.status(500).send('Failed to generate timetable PDF.');
    }
};

exports.adminDownloadAllTimetables = async (req, res) => {
    try {
        const AcademicYear = require('../models/AcademicYear');
        const School       = require('../models/School');
        const { generateTimetablePDF, generateMessagePDF } = require('../utils/timetablePdf');

        let selectedYear;
        if (req.query.year) {
            selectedYear = await AcademicYear.findOne({ _id: req.query.year, school: req.schoolId }).lean();
        }
        if (!selectedYear) {
            selectedYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        }
        if (!selectedYear) return res.status(404).send('No academic year found.');

        const timetables = await Timetable.find({ academicYear: selectedYear._id })
            .populate({ path: 'section', populate: { path: 'class' } }).lean();

        if (!timetables.length) {
            return generateMessagePDF(res, `No timetables configured for ${selectedYear.yearName}.`,
                `all-timetables-${selectedYear.yearName}.pdf`);
        }

        timetables.sort((a, b) => {
            const ca = a.section?.class?.className || '';
            const cb = b.section?.class?.className || '';
            const cmp = ca.localeCompare(cb, undefined, { numeric: true });
            return cmp !== 0 ? cmp : (a.section?.sectionName || '').localeCompare(b.section?.sectionName || '');
        });

        const school = await School.findById(req.schoolId).lean();
        const pages = await Promise.all(timetables.map(async tt => {
            const section = tt.section;
            if (!section) return null;
            const entries = await TimetableEntry.find({ timetable: tt._id })
                .populate('subject', 'subjectName').populate('teacher', 'name')
                .populate('additionalSubjects.subject', 'subjectName')
                .populate('additionalSubjects.teacher', 'name')
                // Sections sharing this lesson, so every view can say who is in the room.
                .populate('mergedSections', 'sectionName')
                .lean();
            const days = daysForSection(section, school);
            return {
                className:   section.class?.className || 'Class',
                sectionName: section.sectionName,
                yearName:    selectedYear.yearName,
                timetable:   tt,
                entries,
                days,
            };
        }));

        const validPages = pages.filter(Boolean);
        if (!validPages.length) {
            return generateMessagePDF(res, `No timetable data found for ${selectedYear.yearName}.`,
                `all-timetables-${selectedYear.yearName}.pdf`);
        }

        generateTimetablePDF(res, validPages, school,
            `all-timetables-${selectedYear.yearName}.pdf`);
    } catch (e) {
        console.error(e);
        res.status(500).send('Failed to generate timetables PDF.');
    }
};

/* ══════════════════════════════════════════════════════════════════════════
   TEACHER
══════════════════════════════════════════════════════════════════════════ */

exports.teacherViewTimetable = async (req, res) => {
    try {
        const User         = require('../models/User');
        const AcademicYear = require('../models/AcademicYear');

        // Support ?teacherId=xxx to look up another teacher
        const targetId = req.query.teacherId || req.userId;

        const teacher = await User.findOne({ _id: targetId, school: req.schoolId, role: 'teacher' }).select('name email').lean();
        if (!teacher) return err(res, 'Teacher not found', 404);

        // Year filter
        let selectedYear;
        if (req.query.yearId) {
            selectedYear = await AcademicYear.findOne({ _id: req.query.yearId, school: req.schoolId }).lean();
        }
        if (!selectedYear) {
            selectedYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        }

        const allYears     = await AcademicYear.find({ school: req.schoolId }).sort({ createdAt: -1 }).lean();
        const allTeachers  = await User.find({ school: req.schoolId, role: 'teacher', isActive: true }).select('name').lean();

        let entries = [];
        let periodsStructure = [];

        if (selectedYear) {
            const timetables = await Timetable.find({ academicYear: selectedYear._id }).lean();
            const ttIds      = timetables.map(t => t._id);

            entries = await TimetableEntry.find({
                timetable: { $in: ttIds },
                $or: [
                    { teacher: teacher._id },
                    { 'additionalSubjects.teacher': teacher._id },
                ],
            })
                .populate('subject', 'subjectName')
                .populate('additionalSubjects.subject', 'subjectName')
                .populate({
                    path: 'timetable',
                    select: 'section periodsStructure schoolStartTime schoolEndTime',
                    populate: { path: 'section', select: 'sectionName class openOnSaturday', populate: { path: 'class', select: 'className' } },
                })
                .lean();

            // Use periodsStructure from the first referenced timetable
            const refTT = entries.length
                ? timetables.find(t => String(t._id) === String(entries[0].timetable?._id)) || timetables[0]
                : timetables[0];
            if (refTT?.periodsStructure?.length) periodsStructure = refTT.periodsStructure;
        }

        // Driven by the school's week, not by whether this teacher happens to
        // have a Saturday class — the old test hid the column for everyone
        // whenever generation had skipped Saturday in the first place.
        const school = await School.findById(req.schoolId).select('leaveSettings').lean();
        const days   = daysForSection(null, school);

        ok(res, {
            teacher,
            entries: entries.map(e => {
                // When teacher is an additional-subject teacher, show that subject instead
                let subject = e.subject;
                if (String(e.teacher || '') !== String(teacher._id)) {
                    const addSub = (e.additionalSubjects || []).find(
                        a => String(a.teacher || '') === String(teacher._id)
                    );
                    if (addSub) subject = addSub.subject;
                }
                return {
                    _id:          e._id,
                    dayOfWeek:    e.dayOfWeek,
                    periodNumber: e.periodNumber,
                    subject,
                    className:    e.timetable?.section?.class?.className || '',
                    sectionName:  e.timetable?.section?.sectionName      || '',
                };
            }),
            periodsStructure,
            days,
            selectedYearId: selectedYear?._id || null,
            years:          allYears,
            allTeachers,
            // Cover this week, both directions: periods this teacher is taking
            // for somebody else, and their own periods somebody else is taking.
            // Only for the teacher's OWN week — looking up a colleague's
            // timetable is a planning view, not a duty roster.
            ...(String(teacher._id) === String(req.userId)
                ? await teacherCoverWeek(req.schoolId, teacher._id, req.query.week)
                : { coverDuties: [], handedOver: [], week: null }),
        });
    } catch (e) { err(res, e); }
};

/**
 * One teacher's substitution week, in both directions.
 *
 * Gated on the school's `showInTeacherTimetable` switch like every other cover
 * overlay — a school that keeps covers off the timetable gets empty lists here
 * rather than a screen that contradicts its own settings.
 */
async function teacherCoverWeek(schoolId, teacherId, weekOf) {
    const SubstituteAssignment = require('../models/SubstituteAssignment');
    const SubstituteSettings   = require('../models/SubstituteSettings');
    const { from, to } = weekBounds(weekOf);
    const week = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };

    const settings = await SubstituteSettings.findOne({ school: schoolId }).lean();
    if (settings && settings.showInTeacherTimetable === false) {
        return { coverDuties: [], handedOver: [], week };
    }

    const rows = await SubstituteAssignment.find({
        school: schoolId,
        status: { $in: ['uncovered', 'assigned'] },
        date: { $gte: from, $lte: to },
        $or: [{ substituteTeacher: teacherId }, { originalTeacher: teacherId }],
    }).populate('subject', 'subjectName')
        .populate('substituteTeacher', 'name').populate('originalTeacher', 'name')
        .populate('section', 'sectionName class').lean();

    const classIds = [...new Set(rows.map((r) => r.section && r.section.class).filter(Boolean).map(String))];
    const classes = classIds.length
        ? await Class.find({ _id: { $in: classIds } }).select('className').lean() : [];
    const className = new Map(classes.map((c) => [String(c._id), c.className]));

    const shape = (r) => ({
        _id: r._id,
        date: new Date(r.date).toISOString().slice(0, 10),
        dayOfWeek: r.dayOfWeek,
        periodNumber: r.periodNumber,
        startTime: r.startTime || '',
        endTime: r.endTime || '',
        subject: r.subject?.subjectName || '',
        sectionLabel: r.section
            ? `${className.get(String(r.section.class)) || 'Class'} – ${r.section.sectionName}`
            : '',
        originalTeacher: r.originalTeacher?.name || '',
        substituteTeacher: r.substituteTeacher?.name || '',
        status: r.status,
        remarks: r.remarks || '',
    });

    const mine = (id) => String(id && id._id ? id._id : id) === String(teacherId);
    return {
        coverDuties: rows.filter((r) => mine(r.substituteTeacher)).map(shape)
            .sort((a, b) => a.date.localeCompare(b.date) || a.periodNumber - b.periodNumber),
        handedOver: rows.filter((r) => mine(r.originalTeacher)).map(shape)
            .sort((a, b) => a.date.localeCompare(b.date) || a.periodNumber - b.periodNumber),
        week,
    };
}

exports.teacherDownloadTimetable = async (req, res) => {
    try {
        const User         = require('../models/User');
        const School       = require('../models/School');
        const AcademicYear = require('../models/AcademicYear');

        const teacher = await User.findOne({ _id: req.userId, school: req.schoolId, role: 'teacher' }).lean();
        if (!teacher) return res.status(404).send('Teacher not found.');

        const activeYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        if (!activeYear) return res.status(404).send('No active academic year.');

        const timetables = await Timetable.find({ academicYear: activeYear._id }).lean();
        const ttIds      = timetables.map(t => t._id);
        const rawEntries = await TimetableEntry.find({
            timetable: { $in: ttIds },
            $or: [
                { teacher: teacher._id },
                { 'additionalSubjects.teacher': teacher._id },
            ],
        })
            .populate('subject', 'subjectName')
            .populate('additionalSubjects.subject', 'subjectName')
            .populate({ path: 'timetable', populate: { path: 'section', populate: { path: 'class' } } })
            .lean();

        if (!rawEntries.length) return res.status(404).send('No timetable entries found for the active academic year.');

        // Remap subject + set teacher.name = "ClassName – Sec X" for PDF subtitle
        const entries = rawEntries.map(e => {
            let subject = e.subject;
            if (String(e.teacher || '') !== String(teacher._id)) {
                const addSub = (e.additionalSubjects || []).find(
                    a => String(a.teacher || '') === String(teacher._id)
                );
                if (addSub) subject = addSub.subject;
            }
            const cn = e.timetable?.section?.class?.className || '';
            const sn = e.timetable?.section?.sectionName      || '';
            return {
                ...e,
                subject,
                teacher: { name: cn && sn ? `${cn} – Sec ${sn}` : cn || sn },
            };
        });

        const firstTTId  = String(entries[0].timetable?._id);
        const refTT      = timetables.find(t => String(t._id) === firstTTId) || timetables[0];
        const teacherTT  = {
            periodsStructure: refTT?.periodsStructure || [],
            schoolStartTime:  refTT?.schoolStartTime  || '',
            schoolEndTime:    refTT?.schoolEndTime     || '',
        };

        const school = await School.findById(req.schoolId).lean();
        // The week comes from the school's settings, not from whether this
        // teacher happens to have a Saturday class.
        const days   = daysForSection(null, school);
        const { generateTimetablePDF } = require('../utils/timetablePdf');

        generateTimetablePDF(res, [{
            className:   teacher.name,
            sectionName: 'Schedule',
            yearName:    activeYear.yearName,
            timetable:   teacherTT,
            entries,
            days,
        }], school, 'my-timetable.pdf');
    } catch (e) {
        console.error(e);
        res.status(500).send('Failed to generate timetable PDF.');
    }
};

/**
 * A section's own weekly timetable, for a teacher attached to that section.
 *
 * Attached means any of the three roles, not just the two that own the
 * section: a subject teacher asking "when do I have them, and what else does
 * this class have that day" is asking about the section's timetable, and
 * refusing them left the My Section page with a button that could not work.
 *
 * `?section=` names which one. Without it the pick is unchanged — the first
 * section of theirs that actually has a timetable, preferring the active year
 * — because that is what "My Class" has always meant here.
 */
exports.teacherClassTimetable = async (req, res) => {
    try {
        const AcademicYear = require('../models/AcademicYear');
        const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
        const activeYear   = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();

        // Every section this teacher is attached to: class teacher or vice on
        // the section itself, or holding a subject in it.
        const [own, links] = await Promise.all([
            ClassSection.find({
                school: req.schoolId,
                $or: [
                    { classTeacher:      req.userId },
                    { substituteTeacher: req.userId },
                ],
            }).populate('class').lean(),
            SectionSubjectTeacher.find({ teacher: req.userId }).select('section').lean(),
        ]);
        const ownIds  = new Set(own.map((s) => String(s._id)));
        const linkIds = [...new Set(links.map((l) => String(l.section)).filter((id) => id && !ownIds.has(id)))];
        // Re-read school-scoped: a subject link carries no school of its own.
        const extra = linkIds.length
            ? await ClassSection.find({ _id: { $in: linkIds }, school: req.schoolId }).populate('class').lean()
            : [];

        // This year's sections. Classes repeat every year — a teacher who has
        // taken Class 1 – A four years running holds four rows with the same
        // name — so without this the picker is a list of identical labels
        // pointing at four different grids. A teacher whose only attachment is
        // to an older year still gets it rather than an empty page.
        const attached = [...own, ...extra];
        const thisYear = activeYear
            ? attached.filter((s) => String(s.academicYear) === String(activeYear._id))
            : attached;
        const allSections = thisYear.length ? thisYear : attached;

        const roleOf = (sec) => (String(sec.classTeacher || '') === String(req.userId) ? 'Class Teacher'
            : String(sec.substituteTeacher || '') === String(req.userId) ? 'Vice Class Teacher'
                : 'Subject Teacher');
        const listed = allSections.map((sec) => ({
            _id:         sec._id,
            sectionName: sec.sectionName,
            className:   sec.class?.className || '',
            role:        roleOf(sec),
        }));

        if (!allSections.length) {
            return ok(res, { section: null, sections: [], timetable: null, entries: [], days: [] });
        }

        let section = null;
        let tt      = null;
        const sectionIds = allSections.map((s) => s._id);

        // Asked for one by name: it must be one of theirs, and it is shown even
        // when it has no timetable yet — "not built" is the honest answer, not
        // somebody else's grid.
        const wanted = req.query.section || req.query.sectionId;
        if (wanted) {
            section = allSections.find((s) => String(s._id) === String(wanted)) || null;
            if (!section) {
                return err(res, 'You are not attached to that section', 403);
            }
            tt = (activeYear && await Timetable.findOne({ section: section._id, academicYear: activeYear._id }).lean())
                || await Timetable.findOne({ section: section._id }).lean();
        }

        // Otherwise pick the section that has a timetable — prefer active year,
        // fallback to any. One batched lookup per phase instead of one
        // Timetable.findOne per section.
        if (!section && activeYear) {
            const tts = await Timetable.find({ section: { $in: sectionIds }, academicYear: activeYear._id }).lean();
            const bySection = new Map(tts.map((t) => [String(t.section), t]));
            for (const sec of allSections) {
                const found = bySection.get(String(sec._id));
                if (found) { section = sec; tt = found; break; }
            }
        }
        if (!section && !tt) {
            const tts = await Timetable.find({ section: { $in: sectionIds } }).lean();
            const bySection = new Map(tts.map((t) => [String(t.section), t]));
            for (const sec of allSections) {
                const found = bySection.get(String(sec._id));
                if (found) { section = sec; tt = found; break; }
            }
        }
        if (!section) section = allSections[0];

        let entries = [];
        if (tt) {
            entries = await TimetableEntry.find({ timetable: tt._id })
                .populate('subject', 'subjectName')
                .populate('teacher', 'name')
                .populate('additionalSubjects.subject', 'subjectName')
                .populate('additionalSubjects.teacher', 'name')
                // Sections sharing this lesson, so every view can say who is in the room.
                .populate('mergedSections', 'sectionName')
                .lean();
        }

        const school = await School.findById(req.schoolId).select('leaveSettings').lean();
        const days   = daysForSection(section, school);

        ok(res, {
            section: {
                _id:         section._id,
                sectionName: section.sectionName,
                className:   section.class?.className || '',
                role:        roleOf(section),
            },
            // Every section they could switch to, so the page can offer the
            // choice rather than only ever showing the one it guessed.
            sections: listed,
            timetable: tt,
            entries,
            days,
        });
    } catch (e) { err(res, e); }
};

/* ══════════════════════════════════════════════════════════════════════════
   STUDENT
══════════════════════════════════════════════════════════════════════════ */

exports.studentViewTimetable = async (req, res) => {
    try {
        const StudentProfile = require('../models/StudentProfile');
        const AcademicYear   = require('../models/AcademicYear');

        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        const sectionId = profile?.currentSection || profile?.section;
        if (!sectionId) return ok(res, { entries: [], timetable: null, section: null });

        const section    = await ClassSection.findById(sectionId).populate('class').populate('academicYear').lean();
        const activeYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();

        let tt = null;
        let effectiveSection = section;

        if (activeYear) {
            tt = await Timetable.findOne({ section: sectionId, academicYear: activeYear._id }).lean();

            // Fallback: match by class name + section name in active year
            if (!tt && section?.class) {
                const candidates = await ClassSection.find({
                    school:       req.schoolId,
                    sectionName:  section.sectionName,
                    academicYear: activeYear._id,
                }).populate('class').lean();

                const match = candidates.find(s => s.class?.className === section.class?.className);
                if (match) {
                    tt = await Timetable.findOne({ section: match._id, academicYear: activeYear._id }).lean();
                    effectiveSection = match;
                }
            }
        }

        let entries = [];
        if (tt) {
            entries = await TimetableEntry.find({ timetable: tt._id })
                .populate('subject', 'subjectName').populate('teacher', 'name')
                .populate('additionalSubjects.subject', 'subjectName')
                .populate('additionalSubjects.teacher', 'name')
                // Sections sharing this lesson, so every view can say who is in the room.
                .populate('mergedSections', 'sectionName')
                .lean();
        }

        const school = await School.findById(req.schoolId).select('leaveSettings').lean();
        const days   = daysForSection(effectiveSection, school);

        // Who is actually taking each period this week. A grid that still shows
        // the regular teacher on a day they are away is wrong in the one way a
        // student would notice.
        const { from, to } = weekBounds(req.query.week);
        const covers = effectiveSection
            ? await coversForSections(req.schoolId, [effectiveSection._id], { from, to })
            : [];

        ok(res, {
            timetable: tt,
            section: {
                _id:         effectiveSection?._id,
                sectionName: effectiveSection?.sectionName,
                className:   effectiveSection?.class?.className || (section?.class?.className),
            },
            entries,
            days,
            activeYear,
            covers,
            week: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        });
    } catch (e) { err(res, e); }
};

exports.studentDownloadTimetable = async (req, res) => {
    try {
        const StudentProfile = require('../models/StudentProfile');
        const AcademicYear   = require('../models/AcademicYear');
        const School         = require('../models/School');

        const profile = await StudentProfile.findOne({ user: req.userId }).lean();
        const sectionId = profile?.currentSection || profile?.section;
        if (!sectionId) return res.status(404).send('You are not assigned to a section.');

        const section    = await ClassSection.findById(sectionId).populate('class').populate('academicYear').lean();
        const activeYear = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();
        if (!activeYear) return res.status(404).send('No active academic year.');

        let tt = await Timetable.findOne({ section: sectionId, academicYear: activeYear._id }).lean();

        if (!tt && section?.class) {
            const candidates = await ClassSection.find({
                school:       req.schoolId,
                sectionName:  section.sectionName,
                academicYear: activeYear._id,
            }).populate('class').lean();
            const match = candidates.find(s => s.class?.className === section.class?.className);
            if (match) tt = await Timetable.findOne({ section: match._id, academicYear: activeYear._id }).lean();
        }

        if (!tt) return res.status(404).send('No timetable configured for your section in the active academic year.');

        const entries = await TimetableEntry.find({ timetable: tt._id })
            .populate('subject', 'subjectName').populate('teacher', 'name')
            .populate('additionalSubjects.subject', 'subjectName')
            .populate('additionalSubjects.teacher', 'name')
            .populate('mergedSections', 'sectionName')
            .lean();

        const school = await School.findById(req.schoolId).lean();
        const days   = daysForSection(section, school);

        const { generateTimetablePDF } = require('../utils/timetablePdf');

        generateTimetablePDF(res, [{
            className:   section?.class?.className || 'Class',
            sectionName: section?.sectionName || '',
            yearName:    activeYear.yearName,
            timetable:   tt,
            entries,
            days,
        }], school, 'my-timetable.pdf');
    } catch (e) {
        console.error(e);
        res.status(500).send('Failed to generate timetable PDF.');
    }
};

/* ══════════════════════════════════════════════════════════════════════════
   PARENT — a child's week
   ──────────────────────────────────────────────────────────────────────────
   Per CHILD, never "the first one". A parent with two children at the school
   has two different timetables, and a screen that silently answers for one of
   them is worse than no screen: it is confidently wrong on alternate days.
   ══════════════════════════════════════════════════════════════════════════ */

/** The section a student sits in, plus the timetable that section actually runs. */
async function sectionWeekFor(studentUserId, schoolId) {
    const StudentProfile = require('../models/StudentProfile');
    const AcademicYear   = require('../models/AcademicYear');

    const profile = await StudentProfile.findOne({ user: studentUserId, school: schoolId }).lean();
    const sectionId = profile?.currentSection || profile?.section;
    if (!sectionId) return { section: null, timetable: null, entries: [], activeYear: null };

    const [section, activeYear] = await Promise.all([
        ClassSection.findById(sectionId).populate('class').lean(),
        AcademicYear.findOne({ school: schoolId, status: 'active' }).lean(),
    ]);

    let tt = null;
    let effective = section;
    if (activeYear) {
        tt = await Timetable.findOne({ section: sectionId, academicYear: activeYear._id }).lean();
        // The student's profile can still point at last year's section row. Match
        // the same class + section name inside the active year rather than
        // reporting "no timetable" at the start of every session.
        if (!tt && section?.class) {
            const candidates = await ClassSection.find({
                school: schoolId, sectionName: section.sectionName, academicYear: activeYear._id,
            }).populate('class').lean();
            const match = candidates.find((s) => s.class?.className === section.class?.className);
            if (match) {
                tt = await Timetable.findOne({ section: match._id, academicYear: activeYear._id }).lean();
                effective = match;
            }
        }
    }

    const entries = tt
        ? await TimetableEntry.find({ timetable: tt._id })
            .populate('subject', 'subjectName').populate('teacher', 'name')
            .populate('additionalSubjects.subject', 'subjectName')
            .populate('additionalSubjects.teacher', 'name')
            .populate('mergedSections', 'sectionName')
            .lean()
        : [];

    return { section: effective, timetable: tt, entries, activeYear };
}

/**
 * Covers affecting a set of sections over a date range, as the viewer's grid
 * wants them: keyed by day and period.
 *
 * Gated on the school's own `showInTeacherTimetable` switch, so a school that
 * would rather keep covers off the timetable gets a plain week everywhere.
 */
async function coversForSections(schoolId, sectionIds, { from, to }) {
    if (!sectionIds.length) return [];
    const SubstituteAssignment = require('../models/SubstituteAssignment');
    const SubstituteSettings   = require('../models/SubstituteSettings');

    const settings = await SubstituteSettings.findOne({ school: schoolId }).lean();
    if (settings && settings.showInTeacherTimetable === false) return [];

    const rows = await SubstituteAssignment.find({
        school: schoolId,
        section: { $in: sectionIds },
        status: { $in: ['uncovered', 'assigned'] },
        date: { $gte: from, $lte: to },
    }).populate('substituteTeacher', 'name').populate('originalTeacher', 'name')
        .populate('subject', 'subjectName').lean();

    return rows.map((r) => ({
        _id: r._id,
        date: new Date(r.date).toISOString().slice(0, 10),
        dayOfWeek: r.dayOfWeek,
        periodNumber: r.periodNumber,
        section: String(r.section),
        subject: r.subject?.subjectName || '',
        originalTeacher: r.originalTeacher?.name || '',
        substituteTeacher: r.substituteTeacher?.name || '',
        status: r.status,
        reason: r.reason,
    }));
}

/** Monday..Sunday of the week a date falls in, at UTC midnight. */
function weekBounds(dateLike) {
    const d = new Date(dateLike || Date.now());
    d.setUTCHours(0, 0, 0, 0);
    const from = new Date(d);
    from.setUTCDate(from.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 6);
    return { from, to };
}

exports.parentViewTimetable = async (req, res) => {
    try {
        const { childCards } = require('../services/parentChildren');
        const children = await childCards(req.userId, req.schoolId);
        if (!children.length) {
            return ok(res, { children: [], child: null, section: null, timetable: null, entries: [], days: [] });
        }

        // An unknown or missing ?child= falls back to the first child rather
        // than erroring — but the payload always names which child it answered
        // for, so the screen can never show one child's week under another's name.
        const wanted = String(req.query.child || '');
        const child = children.find((c) => c._id === wanted) || children[0];

        const { section, timetable, entries, activeYear } =
            await sectionWeekFor(child._id, req.schoolId);

        const school = await School.findById(req.schoolId).select('name leaveSettings').lean();
        const days   = daysForSection(section, school);
        const { from, to } = weekBounds(req.query.week);
        const covers = section
            ? await coversForSections(req.schoolId, [section._id], { from, to })
            : [];

        ok(res, {
            children,
            child,
            section: section ? {
                _id: section._id,
                sectionName: section.sectionName,
                className: section.class?.className || '',
            } : null,
            timetable,
            entries,
            days,
            activeYear,
            covers,
            week: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        });
    } catch (e) { err(res, e); }
};

exports.parentDownloadTimetable = async (req, res) => {
    try {
        const { childCards } = require('../services/parentChildren');
        const children = await childCards(req.userId, req.schoolId);
        if (!children.length) return res.status(404).send('No child is linked to this account.');

        const wanted = String(req.query.child || '');
        const child = children.find((c) => c._id === wanted) || children[0];

        const { section, timetable, entries, activeYear } =
            await sectionWeekFor(child._id, req.schoolId);
        if (!timetable) return res.status(404).send(`No timetable is set up for ${child.name}'s class yet.`);

        const school = await School.findById(req.schoolId).lean();
        const days   = daysForSection(section, school);
        const { generateTimetablePDF } = require('../utils/timetablePdf');

        generateTimetablePDF(res, [{
            className:   section?.class?.className || 'Class',
            sectionName: section?.sectionName || '',
            yearName:    activeYear?.yearName || '',
            timetable,
            entries,
            days,
        }], school, `${String(child.name).replace(/\s+/g, '-').toLowerCase()}-timetable.pdf`);
    } catch (e) {
        console.error(e);
        res.status(500).send('Failed to generate the timetable PDF.');
    }
};

/** Shared by the student and teacher views so all three read one implementation. */
exports._sectionWeekFor = sectionWeekFor;
exports._coversForSections = coversForSections;
exports._weekBounds = weekBounds;
