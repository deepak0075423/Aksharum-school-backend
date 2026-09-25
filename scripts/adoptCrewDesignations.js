'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  One-off: give every crew designation already in use a Designation row.
//
//  Transport used to mint its own staff accounts (designation Driver, Conductor
//  or Crew Member). Those names were never in the school's designation list, so
//  they resolved through the legacy fallback — USER on every enabled module —
//  and never appeared in the matrix, which is the only place an admin could
//  have tightened them.
//
//  defaultPermissionsFor() now returns a crew-sized map for those names, so the
//  fallback is already safe. This adds the rows so the permissions are VISIBLE:
//  an admin can see what a driver may reach and change it.
//
//  Idempotent — a name that already has a row is left exactly as configured.
//
//      node scripts/adoptCrewDesignations.js [--commit]
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const connect        = require('../config/db');
const Designation    = require('../models/Designation');
const TeacherProfile = require('../models/TeacherProfile');
const School         = require('../models/School');
const svc            = require('../services/designationService');

const CREW = ['driver', 'conductor', 'crew member', 'helper', 'attendant'];
const key  = (n) => String(n || '').trim().toLowerCase();

(async () => {
    const commit = process.argv.includes('--commit');
    await connect();

    const schools = await School.find({}).select('_id name').lean();
    let created = 0;

    for (const school of schools) {
        const [profiles, rows] = await Promise.all([
            TeacherProfile.find({ school: school._id }).select('designation').lean(),
            Designation.find({ school: school._id }).select('name').lean(),
        ]);
        const have = new Set(rows.map((r) => key(r.name)));
        // The name as the profiles actually spell it, so the row matches them.
        const missing = new Map();
        for (const p of profiles) {
            const k = key(p.designation);
            if (CREW.includes(k) && !have.has(k)) missing.set(k, String(p.designation).trim());
        }
        if (!missing.size) continue;

        console.log(`\n${school.name || school._id}`);
        for (const [k, name] of missing) {
            const permissions = svc.defaultPermissionsFor(name);
            const reach = Object.entries(permissions).filter(([, v]) => v !== 'none').map(([m]) => m);
            const held = profiles.filter((p) => key(p.designation) === k).length;
            console.log(`  ${commit ? 'create' : 'would create'} "${name}" — ${held} holder(s), may reach: ${reach.join(', ')}`);
            if (commit) {
                await Designation.create({
                    school: school._id,
                    name,
                    description: svc.defaultDescriptionFor(name),
                    permissions,
                    isActive: true,
                    createdBy: null,
                });
                created += 1;
            }
        }
        if (commit) {
            await svc.invalidate(school._id);
            await svc.syncSchoolNames(school._id);
        }
    }

    console.log(commit ? `\nCreated ${created} designation row(s).` : '\nDry run — pass --commit to write.');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
