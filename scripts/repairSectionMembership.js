'use strict';
/**
 * A student's section is recorded twice — on their profile (currentSection /
 * currentClass) and on ClassSection.enrolledStudents — and until
 * utils/sectionMembership existed, the student intake form wrote only the
 * first. Records created before that can disagree: a student whose own record
 * says Class 8-A while 5-A still holds them, or who is on no roster at all.
 *
 * This reports the disagreements and, with --fix, repairs them. The profile
 * wins: it is what the student's own record and every parent view show.
 *
 *   node scripts/repairSectionMembership.js          # report only
 *   node scripts/repairSectionMembership.js --fix    # repair
 */
const orm = require('../db/orm');

const FIX = process.argv.includes('--fix');

(async () => {
    await orm.connect();
    const ClassSection   = require('../models/ClassSection');
    const StudentProfile = require('../models/StudentProfile');
    const { setStudentSection, syncCounts } = require('../utils/sectionMembership');

    const sections = await ClassSection.find({}, '_id sectionName school class enrolledStudents currentCount').lean();
    const sectionById = new Map(sections.map(s => [String(s._id), s]));

    const rosterOf = new Map();   // studentId -> [sectionId]
    const countDrift = [];
    for (const s of sections) {
        const roster = (s.enrolledStudents || []).map(String);
        if ((s.currentCount ?? 0) !== roster.length) countDrift.push(s);
        for (const id of roster) rosterOf.set(id, [...(rosterOf.get(id) || []), String(s._id)]);
    }

    const profiles = await StudentProfile.find({}, 'user school currentClass currentSection').lean();
    const problems = [];

    for (const p of profiles) {
        const uid    = String(p.user);
        const inRoster = rosterOf.get(uid) || [];
        const claims = p.currentSection ? String(p.currentSection) : null;
        const section = claims ? sectionById.get(claims) : null;

        if (claims && !section) {
            problems.push({ uid, kind: 'section no longer exists', p, action: 'unenrol' });
        } else if (claims && !inRoster.includes(claims)) {
            problems.push({ uid, kind: `profile says ${claims.slice(0, 8)}, rosters say ${inRoster.map(i => i.slice(0, 8)).join(',') || 'none'}`, p, action: 'place' });
        } else if (!claims && inRoster.length) {
            problems.push({ uid, kind: `on ${inRoster.length} roster(s) but profile says no section`, p, action: 'place-from-roster', inRoster });
        } else if (inRoster.length > 1) {
            problems.push({ uid, kind: `in ${inRoster.length} sections at once`, p, action: 'place' });
        } else if (claims && section && !p.currentClass) {
            problems.push({ uid, kind: 'section recorded without its class', p, action: 'place' });
        }
    }

    console.log(`${sections.length} sections, ${profiles.length} student profiles`);
    console.log(`${countDrift.length} headcount(s) out of step with their roster`);
    console.log(`${problems.length} student(s) whose profile and roster disagree`);
    for (const x of problems) console.log(`  ${x.uid.slice(0, 8)} — ${x.kind}`);

    if (!problems.length && !countDrift.length) {
        console.log('\nNothing to repair.');
        process.exit(0);
    }
    if (!FIX) {
        console.log('\nRe-run with --fix to repair. Nothing has been changed.');
        process.exit(0);
    }

    for (const x of problems) {
        const target = x.action === 'place-from-roster'
            ? x.inRoster[0]
            : (x.action === 'unenrol' ? null : (x.p.currentSection ? String(x.p.currentSection) : null));
        await setStudentSection({
            studentId: x.uid,
            sectionId: target,
            schoolId:  x.p.school,
        });
        console.log(`  repaired ${x.uid.slice(0, 8)} → ${target ? target.slice(0, 8) : 'no section'}`);
    }
    await syncCounts(countDrift.map(s => s._id));
    console.log(`\nRepaired ${problems.length} student(s) and ${countDrift.length} headcount(s).`);
    process.exit(0);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
