'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  A deactivated teacher must not be assignable to anything.
//
//  Every picker that offers teachers now asks the list endpoint for active ones
//  only, but a filtered dropdown is a courtesy, not a rule: a stale tab, a
//  cached page or a direct API call all still post whatever id they hold. This
//  is the rule, run on the write itself.
//
//  Returns the message to refuse with, or null when every id is fine. Blank ids
//  pass — "no teacher" is a valid thing to save.
// ─────────────────────────────────────────────────────────────────────────────
const User = require('../models/User');

async function inactiveTeacherError(ids, schoolId) {
    const wanted = (Array.isArray(ids) ? ids : [ids])
        .map((v) => (v == null ? '' : String(v._id ?? v)))
        .filter(Boolean);
    if (!wanted.length) return null;

    const found = await User.find({ _id: { $in: wanted }, school: schoolId, role: 'teacher' })
        .select('name isActive').lean();

    const missing = wanted.filter((id) => !found.some((u) => String(u._id) === id));
    if (missing.length) return 'That teacher was not found in this school';

    const inactive = found.filter((u) => u.isActive === false);
    if (!inactive.length) return null;
    return inactive.length === 1
        ? `${inactive[0].name} is deactivated and cannot be assigned. Reactivate the account first.`
        : `${inactive.map((u) => u.name).join(', ')} are deactivated and cannot be assigned.`;
}

module.exports = { inactiveTeacherError };
