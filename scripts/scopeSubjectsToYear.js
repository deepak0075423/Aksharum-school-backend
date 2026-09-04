'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Give every Subject an academic year.
//
//  Subjects used to belong to the school and be shared by every year. They now
//  belong to ONE year, so each year owns an editable list of its own. This
//  migrates what already exists.
//
//  The rule is: nothing may lose its subject. So for every school, each existing
//  subject is COPIED into every academic year that school has, and the rows that
//  point at a subject — ClassSubject and SectionSubjectTeacher — are re-pointed
//  at the copy belonging to THEIR OWN year. A class in 2027-28 that taught
//  Mathematics still teaches Mathematics afterwards; it just references the
//  2027-28 Mathematics rather than a school-wide one.
//
//  Copying into every year (rather than only the years that reference a subject)
//  keeps the Subjects screen looking exactly as it did — all four subjects, in
//  every year — while making the rows independent from here on.
//
//  Idempotent: a subject that already has a year is left alone, and a year that
//  already has a copy is not given a second one.
//
//    node scripts/scopeSubjectsToYear.js          # report only
//    node scripts/scopeSubjectsToYear.js --apply  # do it
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const Subject               = require('../models/Subject');
const AcademicYear          = require('../models/AcademicYear');
const Class                 = require('../models/Class');
const ClassSection          = require('../models/ClassSection');
const ClassSubject          = require('../models/ClassSubject');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const { getPool }           = require('../db/pool');

const sid = (v) => (v == null ? '' : String(v._id ?? v));

(async () => {
    const apply = process.argv.includes('--apply');
    const pool  = getPool();

    const allSubjects = await Subject.find({}).lean();
    const unscoped    = allSubjects.filter((s) => !s.academicYear);
    const years       = await AcademicYear.find({}).lean();
    const yearsBySchool = new Map();
    for (const y of years) {
        const k = sid(y.school);
        if (!yearsBySchool.has(k)) yearsBySchool.set(k, []);
        yearsBySchool.get(k).push(y);
    }

    console.log(`Subjects: ${allSubjects.length} total, ${unscoped.length} without a year`);
    if (!unscoped.length) console.log('  (nothing to migrate — every subject already has one)');

    // Plan: for each unscoped subject, one row per year of its school.
    const plan = [];
    for (const s of unscoped) {
        const ys = yearsBySchool.get(sid(s.school)) || [];
        if (!ys.length) { console.log(`  ! "${s.subjectName}" has no academic year in its school — leaving it alone`); continue; }
        plan.push({ subject: s, keepIn: ys[0], copyTo: ys.slice(1) });
    }
    const copies = plan.reduce((n, p) => n + p.copyTo.length, 0);
    console.log(`  ${plan.length} subject(s) will be anchored to a year, plus ${copies} copy/copies for the other years`);
    for (const p of plan) {
        console.log(`    ${p.subject.subjectName} -> ${p.keepIn.yearName}` +
            (p.copyTo.length ? `, copied into ${p.copyTo.map((y) => y.yearName).join(', ')}` : ''));
    }

    const links = await ClassSubject.find({}).lean();
    const sst   = await SectionSubjectTeacher.find({}).lean();
    console.log(`  rows to re-point: ${links.length} class-subject link(s), ${sst.length} subject-teacher row(s)`);

    if (!apply) { console.log('\nReport only. Re-run with --apply to migrate.'); process.exit(0); }

    // ── 1. The stale unique index. It keys on (school, subjectCode) and would
    //    reject the very copies this migration exists to create. The model now
    //    declares (school, academicYear, subjectCode); sync creates that one
    //    under a different name and leaves this behind, so drop it by hand.
    //    Matched by the ORM's own "ux_" naming, NOT by "UNIQUE" appearing in the
    //    definition — a PRIMARY KEY's indexdef says UNIQUE too, and dropping
    //    that one is refused by Postgres because a constraint owns it.
    const { rows: stale } = await pool.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname='public' AND tablename='subjects'
            AND indexname LIKE 'ux\\_%' AND indexdef ILIKE '%UNIQUE%'`);
    for (const idx of stale) {
        if (/academicYear/i.test(idx.indexdef)) continue;       // already the new one
        await pool.query(`DROP INDEX IF EXISTS "${idx.indexname}"`);
        console.log(`\ndropped stale unique index ${idx.indexname} — ${idx.indexdef}`);
    }

    // ── 2. Anchor each subject, and copy it into the school's other years.
    //    subjectId -> yearId -> the subject row that serves that year.
    const byYear = new Map();
    for (const p of plan) {
        const key = sid(p.subject._id);
        byYear.set(key, new Map([[sid(p.keepIn._id), sid(p.subject._id)]]));
        await Subject.updateOne({ _id: p.subject._id }, { $set: { academicYear: p.keepIn._id } });

        for (const y of p.copyTo) {
            const already = await Subject.findOne({
                school: p.subject.school, academicYear: y._id, subjectName: p.subject.subjectName,
            }).lean();
            const row = already || await Subject.create({
                school:       p.subject.school,
                academicYear: y._id,
                subjectName:  p.subject.subjectName,
                subjectCode:  p.subject.subjectCode || null,
                type:         p.subject.type || 'theory',
                description:  p.subject.description || '',
                teachers:     p.subject.teachers || [],
            });
            byYear.get(key).set(sid(y._id), sid(row._id));
        }
    }

    // ── 3. Re-point the referencing rows at their own year's copy.
    const classes  = await Class.find({}).select('academicYear').lean();
    const yearOfClass   = new Map(classes.map((c) => [sid(c._id), sid(c.academicYear)]));
    const sections = await ClassSection.find({}).select('class').lean();
    const yearOfSection = new Map(sections.map((s) => [sid(s._id), yearOfClass.get(sid(s.class))]));

    let movedLinks = 0, movedSST = 0;
    for (const l of links) {
        const target = byYear.get(sid(l.subject))?.get(yearOfClass.get(sid(l.class)));
        if (target && target !== sid(l.subject)) {
            await ClassSubject.updateOne({ _id: l._id }, { $set: { subject: target } });
            movedLinks += 1;
        }
    }
    for (const r of sst) {
        const target = byYear.get(sid(r.subject))?.get(yearOfSection.get(sid(r.section)));
        if (target && target !== sid(r.subject)) {
            await SectionSubjectTeacher.updateOne({ _id: r._id }, { $set: { subject: target } });
            movedSST += 1;
        }
    }

    console.log(`\nanchored ${plan.length} subject(s), created ${copies} copy/copies`);
    console.log(`re-pointed ${movedLinks} class-subject link(s) and ${movedSST} subject-teacher row(s)`);
    process.exit(0);
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
