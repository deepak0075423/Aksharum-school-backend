'use strict';
/**
 * Whether a section teaches on Saturday — resolved in ONE place.
 *
 * Two flags decide this and they were being read inconsistently:
 *
 *   School.leaveSettings.saturdayWorking — set by the admin in School Settings.
 *   ClassSection.openOnSaturday          — defaults to false, and was only ever
 *                                          written as a side effect of saving a
 *                                          section's period structure.
 *
 * A section whose structure had never been saved through that one screen
 * therefore read as "closed on Saturday" even when the school works Saturdays.
 * The generator skipped Saturday for it, so no Saturday entries existed, so the
 * teacher view (which shows Saturday only when entries exist) hid the column,
 * and the student and PDF paths — which tested the section flag directly — hid
 * it too. One default, four screens with no Saturday.
 *
 * The readers also disagreed about what the flag meant: the PDF and student
 * paths used `if (section.openOnSaturday)` (undefined ⇒ closed) while the
 * generator used `section.openOnSaturday !== false` (undefined ⇒ open).
 *
 * The school setting is the source of truth. The section flag is an override,
 * and only an explicit `false` closes a section the school otherwise opens.
 */

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Does the school work Saturdays at all? Absent settings mean yes. */
const schoolWorksSaturday = (school) => school?.leaveSettings?.saturdayWorking !== false;

/** Does THIS section work Saturdays? The school decides; the section may opt out. */
const sectionWorksSaturday = (section, school) =>
    schoolWorksSaturday(school) && section?.openOnSaturday !== false;

/**
 * The days a section teaches, in week order.
 *
 * @param {object}   section  ClassSection (may be null — then only the school decides)
 * @param {object}   school   School with leaveSettings
 * @param {string[]} [configured]  TimetableConfig.workingDays, when the school has one
 */
function daysForSection(section, school, configured) {
    const base = (Array.isArray(configured) && configured.length)
        ? DAYS.filter((d) => configured.includes(d))
        : DAYS.slice(0, 5).concat(schoolWorksSaturday(school) ? ['Saturday'] : []);
    return base.filter((d) => (d === 'Saturday' ? sectionWorksSaturday(section, school) : true));
}

/**
 * Bring every section's flag back in line with the school setting.
 *
 * Called whenever School.leaveSettings changes, and by the backfill script. The
 * flag carries no independent information today — nothing but this sync has ever
 * written it — so re-deriving it is safe and stops the two from drifting again.
 *
 * @returns {Promise<number>} sections updated
 */
async function syncSectionsToSchoolSaturday(schoolId, school) {
    const ClassSection = require('../models/ClassSection');
    const open = schoolWorksSaturday(school);
    const stale = await ClassSection.find({ school: schoolId, openOnSaturday: !open }).select('_id').lean();
    if (!stale.length) return 0;
    await ClassSection.updateMany(
        { _id: { $in: stale.map((s) => s._id) } },
        { $set: { openOnSaturday: open } },
    );
    return stale.length;
}

module.exports = { DAYS, schoolWorksSaturday, sectionWorksSaturday, daysForSection, syncSectionsToSchoolSaturday };
