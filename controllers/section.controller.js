'use strict';
const ClassSection        = require('../models/ClassSection');
const ClassAnnouncement   = require('../models/ClassAnnouncement');
const ClassMonitor        = require('../models/ClassMonitor');
const StudentProfile      = require('../models/StudentProfile');
const { notify, withParents } = require('../services/notifyService');
const { ownSections, NOT_ASSIGNED } = require('../services/teacherOwnSections');

const ok  = (res, d, s=200) => res.status(s).json({ success: true, data: d });
const err = (res, e, s=500) => res.status(s).json({ success: false, message: e.message||e });

// Batch helpers for the payload below.
const byId     = (rows) => Object.fromEntries((rows || []).map((r) => [String(r._id), r]));
const uniqFind = (Model, ids, select) => {
    const list = [...new Set((ids || []).map((v) => (v == null ? '' : String(v))).filter(Boolean))];
    return list.length ? Model.find({ _id: { $in: list } }).select(select).lean() : Promise.resolve([]);
};

/**
 * GET /teacher/my-section — everything the My Section page shows, in one call:
 * the section this teacher is class teacher of, the ones they cover as vice,
 * the sections they take a subject in, and their own section's monitors and
 * announcements.
 *
 * Only for a class teacher or vice class teacher this year: anyone else gets
 * 403 MY_SECTION_NOT_ASSIGNED. Their subject classes are still listed here for
 * those who do qualify.
 *
 * Classes repeat every academic year — this school has four rows called
 * "Class 1" — and only the ACTIVE year is this teacher's current work, so
 * everything here is filtered to it. Last year's Class 1 is not a section they
 * take attendance for or post announcements to, and showing it next to the
 * live one made the page read as though they held twice as many classes as
 * they do. When the school has no active year there is nothing to filter by,
 * so the unfiltered set stands rather than an empty page.
 *
 * The section also keeps its populated `class` object, because the documents
 * page and the mobile notification screen read `section.class.className`.
 */
exports.getMySection = async (req, res) => {
    try {
        const User         = require('../models/User');
        const Class        = require('../models/Class');
        const Subject      = require('../models/Subject');
        const AcademicYear = require('../models/AcademicYear');
        const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

        const me = String(req.userId);
        // This year only (see services/teacherOwnSections). Applied before
        // anything is shaped, so the panels, the counts and the announcements
        // all agree on the same set.
        const [{ sections: mine, activeYear }, links] = await Promise.all([
            ownSections(req.schoolId, req.userId),
            SectionSubjectTeacher.find({ teacher: req.userId }).lean(),
        ]);

        // The page belongs to the class teacher and the vice class teacher. A
        // teacher who only takes a subject somewhere is refused here as well as
        // in the menu, so typing the URL gets nothing either.
        if (!mine.length) {
            return res.status(403).json({ success: false, ...NOT_ASSIGNED });
        }

        // A subject link carries no school of its own, so the section it points
        // at is re-read school-scoped rather than trusted.
        const ownIds  = new Set(mine.map((s) => String(s._id)));
        const linkIds = [...new Set(links.map((l) => String(l.section)).filter((id) => id && !ownIds.has(id)))];
        const extra   = linkIds.length
            ? await ClassSection.find({ _id: { $in: linkIds }, school: req.schoolId }).lean()
            : [];

        const thisYearOnly = (rows) => (activeYear
            ? rows.filter((s) => String(s.academicYear) === String(activeYear._id))
            : rows);
        const all = [...mine, ...thisYearOnly(extra)];

        const [classes, years, subjects] = await Promise.all([
            uniqFind(Class,        all.map((s) => s.class),        'className classNumber'),
            uniqFind(AcademicYear, all.map((s) => s.academicYear), 'yearName'),
            uniqFind(Subject,      links.map((l) => l.subject),    'subjectName'),
        ]);
        const cMap = byId(classes);
        const yMap = byId(years);
        const sMap = byId(subjects);
        const thisYear = activeYear ? String(activeYear._id) : '';

        const shape = (sec) => {
            const cls  = cMap[String(sec.class)] || null;
            const year = yMap[String(sec.academicYear)] || null;
            return {
                _id:           sec._id,
                sectionName:   sec.sectionName,
                className:     cls ? cls.className : '',
                classNumber:   cls ? cls.classNumber : null,
                class:         cls,
                yearName:      year ? year.yearName : '',
                isCurrentYear: !!thisYear && String(sec.academicYear) === thisYear,
                studentCount:  (sec.enrolledStudents || []).length,
                maxStudents:   sec.maxStudents == null ? null : sec.maxStudents,
            };
        };
        const order = (a, b) => (Number(b.isCurrentYear) - Number(a.isCurrentYear))
            || ((a.classNumber == null ? 999 : a.classNumber) - (b.classNumber == null ? 999 : b.classNumber))
            || String(a.sectionName).localeCompare(String(b.sectionName));

        const classTeacherOf = mine.filter((s) => String(s.classTeacher) === me).map(shape).sort(order);
        const viceOf         = mine
            .filter((s) => String(s.substituteTeacher) === me && String(s.classTeacher) !== me)
            .map(shape).sort(order);

        const secMap = byId(all);
        const seen   = new Set();
        const subjectClasses = links
            .map((l) => {
                const sec = secMap[String(l.section)];
                if (!sec) return null;                          // another school's, or another year's
                const key = String(l.section) + ':' + String(l.subject);
                if (seen.has(key)) return null;                 // same subject twice over
                seen.add(key);
                const sub = sMap[String(l.subject)];
                return { ...shape(sec), subject: sub ? sub.subjectName : 'Subject' };
            })
            .filter(Boolean)
            .sort((a, b) => order(a, b) || String(a.subject).localeCompare(String(b.subject)));

        // The own-section panels follow the section they are class teacher of;
        // a vice-only teacher still gets the section they actually cover.
        const primary = classTeacherOf[0] || viceOf[0] || null;

        let monitors = [], announcements = [];
        if (primary) {
            const [monitorRows, anns] = await Promise.all([
                ClassMonitor.find({ section: primary._id, status: 'active' }).lean(),
                ClassAnnouncement.find({ section: primary._id }).sort({ createdAt: -1 }).lean(),
            ]);
            const monIds  = monitorRows.map((m) => String(m.student)).filter(Boolean);
            const monUser = byId(monIds.length
                ? await User.find({ _id: { $in: monIds } }).select('name').lean() : []);
            monitors = monitorRows.map((m) => ({
                _id:  m._id,
                name: (monUser[String(m.student)] || {}).name || 'Student',
            }));
            announcements = anns;
        }

        ok(res, {
            section: primary,
            role:    classTeacherOf.length ? 'classTeacher' : (viceOf.length ? 'vice' : null),
            // Anyone attached to a section may post to it — a vice class
            // teacher covering the class and a subject teacher with something
            // to tell them both have a reason to. Taking one down is the
            // narrower right (author, or the class teacher), which the
            // announcement rows decide per row.
            canPost: !!primary,
            classTeacherOf, viceOf, subjectClasses,
            monitors, announcements,
            currentYear: activeYear ? activeYear.yearName : '',
        });
    } catch (e) { err(res, e); }
};

/**
 * Every section this teacher is attached to this year, and how.
 *
 * A teacher reaches a section three ways — class teacher, vice class teacher,
 * subject teacher — and every per-section action below authorizes against this
 * one list rather than re-deriving the rule. `role` is the strongest of the
 * three, because a class teacher who also takes a subject there is still the
 * class teacher.
 *
 * Year-filtered to match getMySection: last year's Class 1 is not a section
 * anyone posts to or marks attendance for. A school with no active year cannot
 * be filtered by one, so the unfiltered set stands.
 */
async function attachedSections(req) {
    const AcademicYear = require('../models/AcademicYear');
    const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

    const [own, links, activeYear] = await Promise.all([
        ClassSection.find({
            school: req.schoolId,
            $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
        }).lean(),
        SectionSubjectTeacher.find({ teacher: req.userId }).select('section').lean(),
        AcademicYear.findOne({ school: req.schoolId, status: 'active' }).lean(),
    ]);

    const ownIds  = new Set(own.map((s) => String(s._id)));
    const linkIds = [...new Set(links.map((l) => String(l.section)).filter((id) => id && !ownIds.has(id)))];
    const extra   = linkIds.length
        // Re-read school-scoped: a subject link carries no school of its own.
        ? await ClassSection.find({ _id: { $in: linkIds }, school: req.schoolId }).lean()
        : [];

    const me = String(req.userId);
    const rows = [...own, ...extra]
        .filter((s) => !activeYear || String(s.academicYear) === String(activeYear._id))
        .map((s) => ({
            ...s,
            role: String(s.classTeacher) === me ? 'classTeacher'
                : String(s.substituteTeacher) === me ? 'vice'
                    : 'subject',
        }));
    return rows;
}

/**
 * The section a per-section action is aimed at.
 *
 * `section` in the query or body names it and is checked against what the
 * teacher actually holds — never trusted. Without it the caller means "my
 * own class", which is the section they are class teacher of, then the one
 * they cover as vice, then anything else they are attached to.
 */
function pickSection(rows, wanted, allowed = null) {
    const usable = allowed ? rows.filter((s) => allowed.includes(s.role)) : rows;
    if (wanted) return usable.find((s) => String(s._id) === String(wanted)) || null;
    return usable.find((s) => s.role === 'classTeacher')
        || usable.find((s) => s.role === 'vice')
        || usable[0]
        || null;
}

/** How a section is named back to the client: "Class 4 (Section A)". */
async function labelSections(req, rows) {
    const Class = require('../models/Class');
    const classes = await uniqFind(Class, rows.map((s) => s.class), 'className classNumber');
    const cMap = byId(classes);
    return rows.map((s) => {
        const c = cMap[String(s.class)] || null;
        const cls = c?.className || (c?.classNumber != null ? `Class ${c.classNumber}` : 'Class');
        return {
            _id: String(s._id),
            sectionName: s.sectionName,
            className: c?.className || '',
            classNumber: c?.classNumber ?? null,
            role: s.role,
            label: `${cls} (Section ${s.sectionName})`,
        };
    });
}

/**
 * The model's text column is `message`. The web form posted `body`, which has
 * no column — the row saved with a title and no text at all, and the student's
 * class page then rendered an announcement with an empty body. Accept every
 * name the callers use and write the one the schema actually has.
 *
 * `section` says which class is being told. Anyone attached to a section may
 * post to it — a vice class teacher covering the class and a subject teacher
 * who has to tell them about tomorrow's practical both have something to say
 * — and without it the teacher's own class is meant, which is what every
 * caller before this parameter existed meant.
 */
exports.createAnnouncement = async (req, res) => {
    try {
        const title   = String(req.body.title || '').trim();
        const message = String(req.body.message || req.body.content || req.body.body || '').trim();
        if (!title && !message) return err(res, 'Announcement text is required', 400);

        const rows    = await attachedSections(req);
        const wanted  = req.body.section || req.body.sectionId;
        const target  = pickSection(rows, wanted);
        // With no section there is nothing to post to, and a sectionless
        // announcement belongs to every class and to none.
        if (!target) {
            return err(res, wanted
                ? 'You are not attached to that section'
                : 'You are not attached to any section', 403);
        }
        const ann = await ClassAnnouncement.create({
            section:   target._id,
            createdBy: req.userId,
            title:     title || message.slice(0, 80),
            message:   message || title,
            status:    'active',
        });

        // An announcement nobody is told about is a note in a drawer. It goes
        // to the students of the section and their parents — both see it on
        // their class page, which is where the 'section' link type lands them —
        // and to the class teacher when somebody else posted to their board.
        const [label] = await labelSections(req, [target]);
        const students = await studentsOfSection(target);
        const recipients = await withParents(students);
        if (target.classTeacher && String(target.classTeacher) !== String(req.userId)) {
            recipients.push(String(target.classTeacher));
        }
        notify({
            school:     req.schoolId,
            sender:     req.userId,
            senderRole: req.userRole || 'teacher',
            title:      `📣 ${ann.title}`,
            body:       `${ann.message}\n\nPosted to ${label?.label || 'your class'} by ${req.user?.name || 'your teacher'}.`,
            recipients,
            link:       { type: 'section', entityId: target._id },
        });

        ok(res, { ...ann, notified: recipients.length }, 201);
    } catch (e) { err(res, e); }
};

/**
 * Who will actually see an announcement posted to this section.
 *
 * A student belongs to a section by either route — the profile's
 * `currentSection` pointer or the section's own `enrolledStudents` roster — and
 * the two are not always in step, which is why services/classView.js reads the
 * pointer first and falls back to the roster. This is that rule run backwards,
 * so the people notified are exactly the people whose class page will carry it:
 * a student on the roster whose pointer has since moved to another section is
 * left out, and one with no profile row at all is kept.
 */
async function studentsOfSection(section) {
    const StudentProfile = require('../models/StudentProfile');
    const roster = [...new Set((section.enrolledStudents || []).map(String))];

    const profiles = await StudentProfile.find({
        $or: [
            { currentSection: section._id },
            ...(roster.length ? [{ user: { $in: roster } }] : []),
        ],
    }).select('user currentSection').lean();

    const seen = new Set(profiles.map((p) => String(p.user)));
    const ids = new Set(profiles
        .filter((p) => !p.currentSection || String(p.currentSection) === String(section._id))
        .map((p) => String(p.user)));
    for (const id of roster) if (!seen.has(id)) ids.add(id);
    return [...ids];
}

/**
 * Announcements have no school field, so the section is what authorizes the
 * delete — without one the filter used to collapse to the id alone, which
 * would reach another section's row.
 *
 * Now that three kinds of teacher can post, the rule for taking one down is
 * that you wrote it, or it is on the board of a class you are the class
 * teacher of. A subject teacher must not be able to clear the class teacher's
 * notices off the class page.
 */
exports.deleteAnnouncement = async (req, res) => {
    try {
        const ann = await ClassAnnouncement.findById(req.params.id).lean();
        if (!ann) return res.json({ success: true });     // already gone

        const rows = await attachedSections(req);
        const mine = rows.find((s) => String(s._id) === String(ann.section));
        if (!mine) return err(res, 'You are not attached to that section', 403);

        const isAuthor = String(ann.createdBy) === String(req.userId);
        if (!isAuthor && mine.role !== 'classTeacher') {
            return err(res, 'Only the author or the class teacher can remove this announcement', 403);
        }
        await ClassAnnouncement.findOneAndDelete({ _id: ann._id, section: mine._id });
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
exports.assignMonitor = async (req, res) => {
    try {
        const mySection = await ClassSection.findOne({ classTeacher: req.userId, school: req.schoolId }).lean();
        if (!mySection) return err(res, 'You are not the class teacher of any section', 403);
        const mon = await ClassMonitor.create({
            section: mySection._id, assignedBy: req.userId, ...req.body,
        });
        ok(res, mon, 201);
    } catch (e) { err(res, e); }
};
exports.removeMonitor = async (req, res) => {
    try {
        // Same trap as deleteAnnouncement: an undefined section would have left
        // the id matching on its own.
        const mySection = await ClassSection.findOne({ classTeacher: req.userId, school: req.schoolId }).lean();
        if (!mySection) return err(res, 'You are not the class teacher of any section', 403);
        await ClassMonitor.findOneAndDelete({ _id: req.params.id, section: mySection._id });
        res.json({ success: true });
    } catch (e) { err(res, e); }
};
// The register handlers (GET /teacher/attendance, POST /teacher/attendance/mark)
// live in teacherAttendance.controller.js, where who may take which register —
// day-wise or subject-wise — is decided by services/attendanceScope.js.

// ── Teacher: all sections I'm attached to (class teacher / substitute / subject) ──
exports.getMySections = async (req, res) => {
    try {
        const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
        const [ownSections, subjectLinks] = await Promise.all([
            ClassSection.find({
                school: req.schoolId,
                $or: [{ classTeacher: req.userId }, { substituteTeacher: req.userId }],
            }).populate('class', 'className').lean(),
            SectionSubjectTeacher.find({ teacher: req.userId })
                .populate({ path: 'section', populate: { path: 'class', select: 'className' } })
                .populate('subject', 'subjectName')
                .lean(),
        ]);

        const map = {};
        ownSections.forEach(sec => {
            map[sec._id.toString()] = {
                _id: sec._id,
                sectionName: sec.sectionName,
                className: sec.class?.className || '',
                studentCount: (sec.enrolledStudents || []).length,
                roles: [String(sec.classTeacher) === String(req.userId) ? 'Class Teacher' : 'Substitute Teacher'],
                subjects: [],
            };
        });
        subjectLinks.forEach(link => {
            const sec = link.section;
            if (!sec?._id) return;
            const id = sec._id.toString();
            if (!map[id]) {
                map[id] = {
                    _id: sec._id,
                    sectionName: sec.sectionName,
                    className: sec.class?.className || '',
                    studentCount: (sec.enrolledStudents || []).length,
                    roles: [],
                    subjects: [],
                };
            }
            if (link.subject?.subjectName && !map[id].subjects.includes(link.subject.subjectName)) {
                map[id].subjects.push(link.subject.subjectName);
            }
            if (!map[id].roles.includes('Subject Teacher')) map[id].roles.push('Subject Teacher');
        });

        ok(res, Object.values(map));
    } catch (e) { err(res, e); }
};

// ── Teacher: detail of one of my sections (with access check) ────────────────
exports.getTeacherSectionDetail = async (req, res) => {
    try {
        const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
        const section = await ClassSection.findOne({ _id: req.params.sectionId, school: req.schoolId })
            .populate('class', 'className classNumber')
            .populate('academicYear', 'yearName')
            .populate('classTeacher', 'name email')
            .populate('substituteTeacher', 'name email')
            .populate('enrolledStudents', 'name email')
            .lean();
        if (!section) return err(res, 'Section not found', 404);

        const isOwn = [section.classTeacher?._id, section.substituteTeacher?._id]
            .some(id => String(id) === String(req.userId));
        const subjectLink = await SectionSubjectTeacher.findOne({ section: section._id, teacher: req.userId }).lean();
        if (!isOwn && !subjectLink) return err(res, 'You are not assigned to this section', 403);

        // Roll numbers for the roster
        const enrolled = section.enrolledStudents || [];
        if (enrolled.length) {
            const profiles = await StudentProfile.find(
                { user: { $in: enrolled.map(s => s._id) } }, 'user rollNumber gender'
            ).lean();
            const pMap = {};
            profiles.forEach(p => { pMap[p.user.toString()] = p; });
            section.enrolledStudents = enrolled.map(s => ({
                ...s,
                rollNumber: pMap[s._id.toString()]?.rollNumber || '',
                gender:     pMap[s._id.toString()]?.gender || '',
            }));
        }

        const subjectTeachers = await SectionSubjectTeacher.find({ section: section._id })
            .populate('subject', 'subjectName').populate('teacher', 'name').lean();
        const announcements = await ClassAnnouncement.find({ section: section._id })
            .sort({ createdAt: -1 }).limit(10).lean();

        ok(res, { section, subjectTeachers, announcements });
    } catch (e) { err(res, e); }
};
