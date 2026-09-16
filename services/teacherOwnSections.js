'use strict';
/**
 * The sections a teacher runs, as class teacher or vice class teacher, in the
 * current academic year.
 *
 * This is the whole rule behind My Section: a teacher who only takes a subject
 * in a class does not get the page. Three places ask the question and all three
 * ask here, so they cannot disagree about who gets in:
 *
 *   • GET /teacher/my-section refuses anyone this returns nothing for;
 *   • the module payload (`hasMySection`) hides the menu entry, the dashboard
 *     tile and the web route;
 *   • the teacher dashboard's section card, which links to the page.
 *
 * Only the ACTIVE year counts, as everywhere in section.controller. Classes
 * repeat every year, and a teacher who was class teacher of last year's Class 1
 * does not run a class this year. A school with no active year has nothing to
 * filter by, so every section stands.
 */
const ClassSection = require('../models/ClassSection');
const AcademicYear = require('../models/AcademicYear');

async function ownSections(schoolId, userId) {
    if (!schoolId || !userId) return { sections: [], activeYear: null };
    const [rows, activeYear] = await Promise.all([
        ClassSection.find({
            school: schoolId,
            $or: [{ classTeacher: userId }, { substituteTeacher: userId }],
        }).lean(),
        AcademicYear.findOne({ school: schoolId, status: 'active' }).lean(),
    ]);
    const sections = activeYear
        ? rows.filter((s) => String(s.academicYear) === String(activeYear._id))
        : rows;
    return { sections, activeYear };
}

/** The one a teacher means by "my class": the class they teach first, then one they cover as vice. */
function primarySection(sections, userId) {
    const me = String(userId);
    return sections.find((s) => String(s.classTeacher) === me)
        || sections.find((s) => String(s.substituteTeacher) === me)
        || null;
}

async function hasMySection(schoolId, userId) {
    const { sections } = await ownSections(schoolId, userId);
    return sections.length > 0;
}

const NOT_ASSIGNED = {
    code:    'MY_SECTION_NOT_ASSIGNED',
    message: 'My Section is available to class teachers and vice class teachers only',
};

module.exports = { ownSections, primarySection, hasMySection, NOT_ASSIGNED };
