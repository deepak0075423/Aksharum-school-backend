'use strict';
const Timetable            = require('../models/Timetable');
const TimetableEntry       = require('../models/TimetableEntry');
const ClassSection         = require('../models/ClassSection');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const School               = require('../models/School');
// One resolver for "does this section teach on Saturday" — utils/timetableDays.js
// explains why the school flag and the section flag used to disagree.
const { daysForSection, syncSectionsToSchoolSaturday } = require('../utils/timetableDays');

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
        const toInsert = entries
            .filter(e => e.subject)
            .map(e => ({
                timetable:          tt._id,
                dayOfWeek:          e.dayOfWeek,
                periodNumber:       e.periodNumber,
                subject:            e.subject,
                teacher:            e.teacher    || null,
                additionalSubjects: (e.additionalSubjects || []).filter(a => a.subject),
                mergedSections:     (e.mergedSections     || []).filter(Boolean),
            }));

        // Teacher conflict check across other sections in same academic year
        const conflicts = [];
        const teacherEntries = toInsert.filter(e => e.teacher);
        if (teacherEntries.length > 0) {
            const sibling    = await Timetable.find({ _id: { $ne: tt._id }, academicYear: tt.academicYear }).select('_id section').lean();
            const siblingIds = sibling.map(s => s._id);
            if (siblingIds.length > 0) {
                const existing = await TimetableEntry.find({
                    timetable: { $in: siblingIds },
                    teacher:   { $in: teacherEntries.map(e => e.teacher) },
                }).populate('timetable', 'section').populate('teacher', 'name').lean();

                teacherEntries.forEach(e => {
                    const clash = existing.find(x =>
                        String(x.teacher?._id || x.teacher) === String(e.teacher) &&
                        x.dayOfWeek   === e.dayOfWeek &&
                        x.periodNumber === e.periodNumber
                    );
                    if (clash) {
                        conflicts.push({
                            teacher:         clash.teacher?.name,
                            dayOfWeek:       e.dayOfWeek,
                            periodNumber:    e.periodNumber,
                            conflictSection: clash.timetable?.section,
                        });
                    }
                });
            }
        }

        await TimetableEntry.deleteMany({ timetable: tt._id });
        if (toInsert.length) await TimetableEntry.insertMany(toInsert);

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
                });
            } catch (e) { console.error('[timetable-notif]', e.message); }
        });

        ok(res, { saved: toInsert.length, conflicts, timetableId: tt._id });
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
        });
    } catch (e) { err(res, e); }
};

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

exports.teacherClassTimetable = async (req, res) => {
    try {
        const AcademicYear = require('../models/AcademicYear');
        const activeYear   = await AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean();

        // Find ALL sections where this teacher is class teacher or substitute
        const allSections = await ClassSection.find({
            school: req.schoolId,
            $or: [
                { classTeacher:      req.userId },
                { substituteTeacher: req.userId },
            ],
        }).populate('class').lean();

        if (!allSections.length) return ok(res, { section: null, timetable: null, entries: [], days: [] });

        // Pick the section that has a timetable — prefer active year, fallback to any.
        // One batched lookup per phase instead of one Timetable.findOne per section.
        let section = null;
        let tt      = null;
        const sectionIds = allSections.map((s) => s._id);

        if (activeYear) {
            const tts = await Timetable.find({ section: { $in: sectionIds }, academicYear: activeYear._id }).lean();
            const bySection = new Map(tts.map((t) => [String(t.section), t]));
            for (const sec of allSections) {
                const found = bySection.get(String(sec._id));
                if (found) { section = sec; tt = found; break; }
            }
        }
        if (!tt) {
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
                .lean();
        }

        const school = await School.findById(req.schoolId).select('leaveSettings').lean();
        const days   = daysForSection(section, school);

        const role = String(section.classTeacher || '') === String(req.userId)
            ? 'Class Teacher'
            : 'Substitute Teacher';

        ok(res, {
            section: {
                _id:         section._id,
                sectionName: section.sectionName,
                className:   section.class?.className || '',
                role,
            },
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
                .lean();
        }

        const school = await School.findById(req.schoolId).select('leaveSettings').lean();
        const days   = daysForSection(effectiveSection, school);

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
