'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Remove structure rows whose parent was deleted.
//
//  deleteClass and deleteSection used to delete only their own row, leaving
//  sections pointing at a class that no longer exists, subject-teacher rows on
//  those sections, and class-subject links on the same dead classes. They are
//  invisible rather than harmless: every year-scoped query reaches a section
//  through its class, so an assignment on an orphaned section reads as "not used
//  this year" while the row is still sitting there.
//
//  Both delete paths now cascade, so this is a one-off for what they left.
//
//    node scripts/cleanOrphanStructure.js          # report only
//    node scripts/cleanOrphanStructure.js --apply  # delete them
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const Class                 = require('../models/Class');
const ClassSection          = require('../models/ClassSection');
const ClassSubject          = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Subject               = require('../models/Subject');

(async () => {
    const apply = process.argv.includes('--apply');

    const liveClassIds = new Set((await Class.find({}).select('_id').lean()).map((c) => String(c._id)));
    const sections     = await ClassSection.find({}).select('_id class sectionName').lean();
    const orphanSecs   = sections.filter((s) => !liveClassIds.has(String(s.class)));
    const orphanSecIds = new Set(orphanSecs.map((s) => String(s._id)));

    const liveSecIds = new Set(sections.filter((s) => liveClassIds.has(String(s.class))).map((s) => String(s._id)));
    const sst        = await SectionSubjectTeacher.find({}).select('_id section subject').lean();
    const orphanSST  = sst.filter((r) => !liveSecIds.has(String(r.section)));

    const links       = await ClassSubject.find({}).select('_id class subject').lean();
    const orphanLinks = links.filter((l) => !liveClassIds.has(String(l.class)));

    const subjectName = new Map((await Subject.find({}).select('subjectName').lean())
        .map((s) => [String(s._id), s.subjectName]));

    console.log('Orphaned rows (parent deleted, child left behind):');
    console.log(`  sections whose class is gone       : ${orphanSecs.length} of ${sections.length}`);
    console.log(`  subject-teacher rows unreachable   : ${orphanSST.length} of ${sst.length}`);
    console.log(`  class-subject links whose class gone: ${orphanLinks.length} of ${links.length}`);

    const bySubject = {};
    for (const r of orphanSST) {
        const n = subjectName.get(String(r.subject)) || '(deleted subject)';
        bySubject[n] = (bySubject[n] || 0) + 1;
    }
    if (Object.keys(bySubject).length) {
        console.log('  the unreachable assignments are for:');
        for (const [n, c] of Object.entries(bySubject)) console.log(`    ${n} x${c}`);
    }

    if (!apply) {
        console.log('\nReport only. Re-run with --apply to delete them.');
        process.exit(0);
    }

    for (const r of orphanSST)   await SectionSubjectTeacher.findByIdAndDelete(r._id);
    for (const l of orphanLinks) await ClassSubject.findByIdAndDelete(l._id);
    for (const s of orphanSecs)  await ClassSection.findByIdAndDelete(s._id);
    console.log(`\nDeleted ${orphanSST.length} assignment(s), ${orphanLinks.length} link(s), ${orphanSecs.length} section(s).`);
    process.exit(0);
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
