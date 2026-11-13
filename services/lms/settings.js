'use strict';
/**
 * Video Learning settings — the platform's (set by the Super Admin) and each
 * school's own. Stored values are laid over these defaults, so a setting
 * added later has a value for everyone at once.
 */
const { M, bad } = require('./common');

const PLATFORM_DEFAULTS = {
    completionThresholdPercent: 90,   // a video counts as completed once this much is genuinely watched
    heartbeatSeconds: 15,             // how often a player reports while playing
    sessionIdleSeconds: 180,          // a session with no heartbeat for this long is closed
    maxUploadMb: 2048,                // the largest video file accepted
    heartbeatRetentionDays: 30,       // raw heartbeats are pruned after this; totals are kept
    playbackUrlSeconds: 300,          // life of a signed CDN address for one file
};
const PLATFORM_LIMITS = {
    completionThresholdPercent: [50, 100], heartbeatSeconds: [5, 60], sessionIdleSeconds: [60, 1800],
    maxUploadMb: [10, 5120], heartbeatRetentionDays: [1, 365], playbackUrlSeconds: [60, 3600],
};
const SCHOOL_DEFAULTS = {
    notifyTeacherOnVideoComplete: true,
    notifyTeacherOnChapterComplete: true,
    reminderAfterDays: 3,             // remind students who have not started; 0 = never
};

let platformCache = null;
let platformAt = 0;

async function platform() {
    if (platformCache && Date.now() - platformAt < 30000) return platformCache;
    const row = await M.setting.findOne({ key: 'platform' }).lean();
    platformCache = { ...PLATFORM_DEFAULTS, ...(row?.values || {}) };
    platformAt = Date.now();
    return platformCache;
}

async function savePlatform(values, userId) {
    const next = { ...(await platform()) };
    for (const [k, [min, max]] of Object.entries(PLATFORM_LIMITS)) {
        if (values[k] === undefined || values[k] === null || values[k] === '') continue;
        const n = Number(values[k]);
        if (!Number.isInteger(n) || n < min || n > max) throw bad(`${k} must be a whole number from ${min} to ${max}`);
        next[k] = n;
    }
    await M.setting.findOneAndUpdate({ key: 'platform' }, { $set: { values: next, updatedBy: userId, school: null } }, { upsert: true });
    platformCache = null;
    return next;
}

async function school(schoolId) {
    const row = await M.setting.findOne({ key: String(schoolId) }).lean();
    return { ...SCHOOL_DEFAULTS, ...(row?.values || {}) };
}

async function saveSchool(schoolId, values, userId) {
    const next = { ...(await school(schoolId)) };
    for (const k of ['notifyTeacherOnVideoComplete', 'notifyTeacherOnChapterComplete']) {
        if (values[k] !== undefined) next[k] = !!values[k];
    }
    if (values.reminderAfterDays !== undefined && values.reminderAfterDays !== '') {
        const n = Number(values.reminderAfterDays);
        if (!Number.isInteger(n) || n < 0 || n > 60) throw bad('Reminder days must be a whole number from 0 to 60');
        next.reminderAfterDays = n;
    }
    await M.setting.findOneAndUpdate({ key: String(schoolId) }, { $set: { values: next, updatedBy: userId, school: schoolId } }, { upsert: true });
    return next;
}

module.exports = { platform, savePlatform, school, saveSchool, PLATFORM_DEFAULTS, PLATFORM_LIMITS, SCHOOL_DEFAULTS };
