'use strict';
/**
 * A parent's children, as student User ids.
 *
 * The link has two sources of truth and they drift: the parent's own
 * `children` list (what the dashboard's child picker is built from) and each
 * student profile's `parent` pointer. Both are read, then re-read as users
 * scoped to this school and the student role, so a stale id on either side
 * cannot reach a stranger or another school.
 *
 * Returned sorted by name — the order every child switch shows them in.
 */
const ParentProfile  = require('../models/ParentProfile');
const StudentProfile = require('../models/StudentProfile');
const User           = require('../models/User');

async function childrenOf(parentUserId, schoolId, fields = 'name') {
    const [parent, owned] = await Promise.all([
        ParentProfile.findOne({ user: parentUserId }).lean(),
        StudentProfile.find({ parent: parentUserId, school: schoolId }).select('user').lean(),
    ]);
    const listed = parent?.children?.length ? parent.children : (parent?.student ? [parent.student] : []);
    const ids = [...new Set([...listed, ...owned.map((p) => p.user)].filter(Boolean).map(String))];
    if (!ids.length) return [];

    const kids = await User.find({ _id: { $in: ids }, role: 'student', school: schoolId }).select(fields).lean();
    return kids.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

module.exports = { childrenOf };
