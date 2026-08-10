// One-time repair: point StudentProfile.currentSection at the section whose
// enrolledStudents array contains the student, wherever the profile has none.
// Idempotent — safe to run multiple times.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const orm = require('../db/orm');
const ClassSection = require('../models/ClassSection');
const StudentProfile = require('../models/StudentProfile');

(async () => {
    try {
        await orm.connect();
        const sections = await ClassSection.find({}).select('_id sectionName enrolledStudents').lean();
        let updated = 0;
        for (const sec of sections) {
            for (const studentUserId of (sec.enrolledStudents || [])) {
                const r = await StudentProfile.updateOne(
                    { user: studentUserId, currentSection: null },
                    { $set: { currentSection: sec._id } }
                );
                updated += r.modifiedCount || 0;
            }
        }
        console.log(`syncCurrentSection: ${updated} profile(s) updated across ${sections.length} section(s)`);

        // Repair ParentProfile.children from StudentProfile.parent links
        // (manual student creation never wrote these until now).
        const ParentProfile = require('../models/ParentProfile');
        const linked = await StudentProfile.find({ parent: { $ne: null } }).select('user parent school').lean();
        let parentLinks = 0;
        for (const sp of linked) {
            const r = await ParentProfile.findOneAndUpdate(
                { user: sp.parent },
                { $setOnInsert: { school: sp.school }, $addToSet: { children: sp.user } },
                { upsert: true, new: true }
            );
            if (r) parentLinks++;
        }
        console.log(`syncCurrentSection: ${parentLinks} parent link(s) ensured`);
        await orm.disconnect();
        process.exit(0);
    } catch (e) {
        console.error('syncCurrentSection failed:', e.message);
        process.exit(1);
    }
})();
