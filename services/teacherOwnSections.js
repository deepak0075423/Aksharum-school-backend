'use strict';
/**
 * The sections a teacher is attached to in the current academic year, and how.
 *
 * My Section is the page of a teacher who has a section to look at:
 *
 *   • the class teacher or vice class teacher of one — their OWN sections
 *     (`ownSections`), which is where the register, the monitors and the class
 *     board live; or
 *   • a subject teacher in one — the subject is assigned to that section with
 *     them as its teacher (a SectionSubjectTeacher row; `taughtSections`).
 *
 * A teacher attached to nothing this year has no page. Three places ask the
 * question and all three ask here, so they cannot disagree about who gets in:
 *
 *   • GET /teacher/my-section refuses anyone attached to nothing;
 *   • the module payload (`hasMySection`) hides the menu entry, the dashboard
 *     tile and the web route;
 *   • the teacher dashboard's section card (own sections only — it is the card
 *     of "my class"), which links to the page.
 *
 * From 17 Sep to 2 Oct 2026 the page was for class and vice class teachers
 * only and a subject-only teacher was refused. The school asked for that, then
 * asked for this: a teacher who takes Mathematics in 7-A wants to see 7-A.
 *
 * Only the ACTIVE year counts, as everywhere in section.controller. Classes
 * repeat every year, and a teacher who was class teacher of last year's Class 1
 * does not run a class this year. A school with no active year has nothing to
 * filter by, so every section stands.
 *
 * "The active year" is read as every year marked active. The Academic Years
 * screen keeps it to one, but that is two writes rather than a constraint, and
 * a school left with two used to have whichever the database returned first
 * decide who ran a class — so a class teacher could lose the page with nothing
 * about them having changed. A section in ANY active year counts.
 *
 * The answer is read from the tables on every call and never cached here:
 * making a teacher class teacher takes effect on their very next request. What
 * keeps an already-open session in step is services/accessChanged.
 */
const ClassSection = require('../models/ClassSection');
const AcademicYear = require('../models/AcademicYear');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');

/**
 * The school's active years, newest first, and the test "is this section in
 * one of them". With no active year the test passes everything.
 */
async function currentYears(schoolId) {
    const years = schoolId
        ? await AcademicYear.find({ school: schoolId, status: 'active' }).sort({ startDate: -1 }).lean()
        : [];
    const ids = new Set(years.map((y) => String(y._id)));
    return {
        years,
        // The one whose name the screens show; the newest when there are two.
        activeYear: years[0] || null,
        isCurrent: (section) => !ids.size || ids.has(String(section?.academicYear)),
        // Whether there is a year to be "this year" at all — false means the
        // filter is off, which is not the same as every section being current.
        hasYear: ids.size > 0,
        inYear: (section) => ids.has(String(section?.academicYear)),
    };
}

async function ownSections(schoolId, userId) {
    if (!schoolId || !userId) return { sections: [], activeYear: null, current: await currentYears(null) };
    const [rows, current] = await Promise.all([
        ClassSection.find({
            school: schoolId,
            $or: [{ classTeacher: userId }, { substituteTeacher: userId }],
        }).lean(),
        currentYears(schoolId),
    ]);
    return { sections: rows.filter(current.isCurrent), activeYear: current.activeYear, current };
}

/** The one a teacher means by "my class": the class they teach first, then one they cover as vice. */
function primarySection(sections, userId) {
    const me = String(userId);
    return sections.find((s) => String(s.classTeacher) === me)
        || sections.find((s) => String(s.substituteTeacher) === me)
        || null;
}

/**
 * The sections a teacher takes a subject in this year, with the links that say
 * which subject. Includes any of their own sections they also teach in.
 *
 * A subject link carries no school of its own, so the section it points at is
 * re-read school-scoped rather than trusted — a link left pointing at another
 * school's section, or at another year's, is simply not counted.
 *
 * `current` is ownSections' reading of "this year", passed along so the two
 * cannot be asked a moment apart and disagree.
 */
async function taughtSections(schoolId, userId, current) {
    if (!schoolId || !userId) return { links: [], sections: [] };
    const links = await SectionSubjectTeacher.find({ teacher: userId }).lean();
    const ids = [...new Set(links.map((l) => String(l.section)).filter(Boolean))];
    if (!ids.length) return { links, sections: [] };
    const [rows, years] = await Promise.all([
        ClassSection.find({ _id: { $in: ids }, school: schoolId }).lean(),
        current || currentYears(schoolId),
    ]);
    return { links, sections: rows.filter(years.isCurrent) };
}

/** Whether there is anything for the page to show: a section they run, or one they teach in. */
async function hasMySection(schoolId, userId) {
    const { sections, current } = await ownSections(schoolId, userId);
    if (sections.length) return true;
    return (await taughtSections(schoolId, userId, current)).sections.length > 0;
}

const NOT_ASSIGNED = {
    code:    'MY_SECTION_NOT_ASSIGNED',
    message: 'My Section opens once you are class teacher, vice class teacher or subject teacher of a section',
};

module.exports = { ownSections, taughtSections, currentYears, primarySection, hasMySection, NOT_ASSIGNED };
