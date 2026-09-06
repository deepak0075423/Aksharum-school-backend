'use strict';
/**
 * Report — and optionally clear — one academic year's curriculum, i.e. the
 * ClassSubject rows saying "this class teaches this subject".
 *
 * Written for the years that got a curriculum they were never asked for: until
 * this was fixed, importing a year's SUBJECT LIST also copied the source year's
 * class↔subject links onto whichever classes the target year already had, so
 * subjects showed as "in use" in a year nobody had built a curriculum for.
 *
 * A link backed by a subject-teacher assignment in that class is never removed.
 * Those two tables describe the same fact at different grains and the assignment
 * is the stronger statement — dropping the link under it would leave a teacher
 * assigned to a subject the class is no longer marked as teaching.
 *
 * Nothing else references a ClassSubject row by id, so a link removed here can
 * be added back from the class's own screen.
 *
 *   node scripts/clearYearCurriculum.js                     # every year, with counts
 *   node scripts/clearYearCurriculum.js --year 2025-26      # what would go, in detail
 *   node scripts/clearYearCurriculum.js --year 2025-26 --apply
 */
require('dotenv').config();

const AcademicYear          = require('../models/AcademicYear');
const Class                 = require('../models/Class');
const ClassSection          = require('../models/ClassSection');
const ClassSubject          = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Subject               = require('../models/Subject');

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : process.argv[i + 1];
};
const APPLY  = process.argv.includes('--apply');
const WANTED = arg('year');

const linksOf = async (yearId) => {
    const classes = await Class.find({ academicYear: yearId }).select('className').lean();
    if (!classes.length) return { classes: [], links: [] };
    const links = await ClassSubject.find({ class: { $in: classes.map((c) => c._id) } }).lean();
    return { classes, links };
};

(async () => {
    const years = await AcademicYear.find({}).lean();
    if (!years.length) { console.log('No academic years on record.'); process.exit(0); }

    // ── No --year: just say where curriculum rows are, so the right one can be picked
    if (!WANTED) {
        console.log('Curriculum (class ↔ subject links) per academic year:\n');
        for (const y of years.sort((a, b) => String(a.yearName).localeCompare(String(b.yearName)))) {
            const { classes, links } = await linksOf(y._id);
            console.log(`  ${y.yearName.padEnd(12)} ${String(y.status).padEnd(9)} `
                + `${String(classes.length).padStart(3)} class(es)  ${String(links.length).padStart(4)} link(s)  ${y._id}`);
        }
        console.log('\nRe-run with --year <yearName or id> to see one year in detail.');
        process.exit(0);
    }

    const year = years.find((y) => String(y._id) === WANTED || String(y.yearName) === WANTED);
    if (!year) {
        console.error(`No academic year matches "${WANTED}". Run without --year to list them.`);
        process.exit(1);
    }

    const { classes, links } = await linksOf(year._id);
    if (!links.length) {
        console.log(`${year.yearName} has no curriculum links — nothing to clear.`);
        process.exit(0);
    }

    // An assignment pins its link. Keyed on class+subject, which is the grain
    // the link is stored at.
    const sections = await ClassSection.find({ class: { $in: classes.map((c) => c._id) } })
        .select('class').lean();
    const sst = sections.length
        ? await SectionSubjectTeacher.find({ section: { $in: sections.map((s) => s._id) } })
            .select('section subject').lean()
        : [];
    const classOfSection = new Map(sections.map((s) => [String(s._id), String(s.class)]));
    const pinned = new Set(sst.map((r) => `${classOfSection.get(String(r.section))}#${String(r.subject)}`));

    const classById   = new Map(classes.map((c) => [String(c._id), c]));
    const subjectById = new Map((await Subject.find({ academicYear: year._id })
        .select('subjectName').lean()).map((s) => [String(s._id), s]));

    const removable = [], kept = [];
    for (const l of links) {
        (pinned.has(`${String(l.class)}#${String(l.subject)}`) ? kept : removable).push(l);
    }

    const label = (l) => `${classById.get(String(l.class))?.className || 'Class ?'}`
        + ` – ${subjectById.get(String(l.subject))?.subjectName || 'subject ?'}`;

    console.log(`${year.yearName}: ${links.length} curriculum link(s) across ${classes.length} class(es)\n`);
    if (kept.length) {
        console.log(`  KEPT — a subject teacher is assigned for these (${kept.length}):`);
        for (const l of kept) console.log(`    ${label(l)}`);
        console.log('');
    }
    console.log(`  ${APPLY ? 'REMOVING' : 'WOULD REMOVE'} (${removable.length}):`);
    for (const l of removable) console.log(`    ${label(l)}`);

    if (!removable.length) { console.log('\nNothing to remove.'); process.exit(0); }

    if (APPLY) {
        for (const l of removable) await ClassSubject.deleteOne({ _id: l._id });
        console.log(`\nRemoved ${removable.length} link(s) from ${year.yearName}.`);
    } else {
        console.log(`\nDry run — re-run with --apply to remove these ${removable.length} link(s).`);
    }
    process.exit(0);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
