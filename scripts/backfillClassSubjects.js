'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Derive the missing "this class teaches this subject" links.
//
//  ClassSubject and SectionSubjectTeacher describe the same fact at different
//  grains — the class teaches a subject, and who teaches it in a given section.
//  Assigning a teacher to a section implies the first, but nothing ever wrote
//  it: no screen on either platform posts to the class-level endpoint. So
//  ClassSubject stayed empty while assignments piled up, and the three things
//  that READ it — the parent portal's subject list, the timetable generator, and
//  the year-structure import — saw nothing.
//
//  The assign paths now write the link as they go. This fills in the history.
//
//    node scripts/backfillClassSubjects.js          # report only
//    node scripts/backfillClassSubjects.js --apply  # create the missing links
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const Class                 = require('../models/Class');
const ClassSection          = require('../models/ClassSection');
const ClassSubject          = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Subject               = require('../models/Subject');
const AcademicYear          = require('../models/AcademicYear');

(async () => {
    const apply = process.argv.includes('--apply');

    const classes  = await Class.find({}).select('className academicYear').lean();
    const classById = new Map(classes.map((c) => [String(c._id), c]));
    const years    = new Map((await AcademicYear.find({}).select('yearName').lean())
        .map((y) => [String(y._id), y.yearName]));
    const subjects = new Map((await Subject.find({}).select('subjectName').lean())
        .map((s) => [String(s._id), s.subjectName]));

    // Only sections whose class still exists — an orphan has no class to link to.
    const sections   = await ClassSection.find({}).select('class').lean();
    const sectionCls = new Map(sections
        .filter((s) => classById.has(String(s.class)))
        .map((s) => [String(s._id), String(s.class)]));

    const existing = new Set((await ClassSubject.find({}).select('class subject').lean())
        .map((l) => `${String(l.class)}#${String(l.subject)}`));

    // class#subject pairs implied by the assignments that exist.
    const wanted = new Map();
    for (const r of await SectionSubjectTeacher.find({}).select('section subject').lean()) {
        const clsId = sectionCls.get(String(r.section));
        if (!clsId || !r.subject || !subjects.has(String(r.subject))) continue;
        wanted.set(`${clsId}#${String(r.subject)}`, { class: clsId, subject: String(r.subject) });
    }

    const missing = [...wanted.values()].filter((w) => !existing.has(`${w.class}#${w.subject}`));

    console.log(`Class-subject links implied by existing assignments: ${wanted.size}`);
    console.log(`  already on record : ${wanted.size - missing.length}`);
    console.log(`  missing           : ${missing.length}`);
    for (const m of missing) {
        const c = classById.get(m.class);
        console.log(`    ${c?.className || '?'} (${years.get(String(c?.academicYear)) || '?'}) — ${subjects.get(m.subject)}`);
    }

    if (!apply) {
        console.log('\nReport only. Re-run with --apply to create them.');
        process.exit(0);
    }

    for (const m of missing) await ClassSubject.create({ class: m.class, subject: m.subject });
    console.log(`\nCreated ${missing.length} link(s).`);
    process.exit(0);
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
