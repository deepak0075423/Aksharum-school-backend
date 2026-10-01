'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hostel — read models for the redesigned admin screens (Sep 2026).
//
//  One endpoint per screen, returning what that screen draws and nothing else,
//  beside the CRUD controller (hostel.controller.js), which is untouched. The
//  Nexora-Hives app still reads the older /admin/dashboard, whose shape is kept.
//
//  Mounted behind allowModuleAdmin('hostel'); a warden sees only the hostels
//  they hold (visibleHostelIds), exactly as on every other hostel screen.
// ─────────────────────────────────────────────────────────────────────────────
const { ok, fail, visibleHostelIds, getSettings } = require('../services/hostelService');
const q = require('../services/hostelOverview');

/**
 * GET /hostel/admin/overview — the Dashboard.
 *
 *   ?year=<academic year id>   defaults to the school's current year
 *   ?range=6m|12m|year          the fee chart's window (default 6m)
 *   ?day=today|yesterday        the attendance card (default today)
 *
 * Two scopes, on purpose. The live figures — structure, beds, residents,
 * attendance — cover the ACTIVE hostels the caller may see, because a closed
 * hostel has no capacity and nobody living in it. Money and history — fees,
 * incidents, the activity log — cover every hostel the caller may see, closed or
 * not, because a payment or an incident does not stop having happened.
 *
 * The per-hostel breakdowns (`byHostel`) are what the cards' "All Hostels"
 * pickers switch between, so changing one costs no round trip.
 */
exports.overview = async (req, res) => {
    try {
        const school = req.schoolId;
        const allowed = await visibleHostelIds(req);                  // null → every hostel
        const [hostels, { years, current }] = await Promise.all([
            q.hostelsInScope(school, allowed),
            q.academicYears(school),
        ]);
        const live = hostels.map((h) => h._id);
        const year = years.find((y) => y._id === String(req.query.year || '')) || current;

        const settings = await getSettings(school);
        const [structure, beds, residence, attendance, fees, incidents, activity, staff] = await Promise.all([
            q.structureCounts(school, live),
            q.bedCounts(school, live),
            q.residence(school, live),
            q.attendanceOn(school, live, req.query.day),
            // A teacher in on a posting runs the hostel's day, not its books:
            // no fee figures, and no fee-desk entries in the activity feed.
            req.hostelDuty ? null : q.feeSeries(school, allowed, req.query.range, year),
            q.recentIncidents(school, allowed),
            q.recentActivity(school, allowed, 4, { money: !req.hostelDuty }),
            q.staffResidents(school, live),
        ]);

        ok(res, {
            years,
            year: year ? year._id : null,
            hostels,
            structure: { hostels: hostels.length, ...structure, beds: beds.total },
            beds,
            residence,
            // Percentages are taken against everyone holding a bed, or against
            // those marked if a roll somehow ran past it (a student vacated
            // after being marked) — never over 100%.
            // …and against the people who are CALLED: staff who live in are not on
            // the roll unless the school asks for it, so they are not "expected".
            attendance: { ...attendance, expected: Math.max(residence.total - (settings.rollCallIncludesTeachers ? 0 : staff), attendance.marked) },
            fees,
            incidents,
            activity,
        });
    } catch (e) { fail(res, e); }
};
