'use strict';
/**
 * Clearing the bell must not erase the record.
 *
 *   node server.js &
 *   node scripts/testNotificationClear.js
 *
 * Two surfaces read the same receipts with different meanings:
 *
 *   /notifications/inbox  the bell — what is still waiting to be acknowledged.
 *                         "Clear all" empties it.
 *   /notifications/all    the notifications page — everything ever received.
 *                         Clearing the bell must leave it untouched.
 *
 * The distinction lives in NotificationReceipt.isCleared: /inbox filters on it,
 * /all ignores it. Nothing is deleted either way.
 */
require('dotenv').config({ quiet: true });
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const connectDB = require('../config/db');
const School = require('../models/School');
const User = require('../models/User');
const Notification = require('../models/Notification');
const NotificationReceipt = require('../models/NotificationReceipt');

let passed = 0, failed = 0;
const results = [];
const check = (n, c, d = '') => { if (c) { passed++; results.push(`  ✅ ${n}`); } else { failed++; results.push(`  ❌ ${n}${d ? ` — ${d}` : ''}`); } };
const section = (t) => results.push(`\n▸ ${t}`);

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
const TAG = `nctest_${Date.now()}`;
const sid = (v) => String(v?._id ?? v);
const token = (u) => jwt.sign({ userId: sid(u), role: u.role, schoolId: sid(u.school) }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function call(method, path, { as } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(as)}` },
    });
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, body: j, data: j?.data, unread: j?.unread, count: j?.count };
}
const GET = (p, o) => call('GET', p, o);
const POST = (p, o) => call('POST', p, o);
const DEL = (p, o) => call('DELETE', p, o);

(async () => {
    await connectDB();
    if (!(await fetch(`http://localhost:${process.env.PORT || 5000}/health`).catch(() => null))?.ok) {
        console.error('Server is not running.'); process.exit(1);
    }

    const school = await School.create({ name: `${TAG} School`, code: 'NCT', modules: { notification: true } });
    const teacher = await User.create({
        name: `${TAG} Teacher`, email: `${TAG}.t@x.test`, role: 'teacher', school: sid(school),
        password: await bcrypt.hash('x', 4), isFirstLogin: false, isActive: true,
    });
    teacher.school = school;

    const notifIds = [];
    try {
        section('Three notifications arrive');
        for (let i = 1; i <= 3; i++) {
            const n = await Notification.create({
                school: sid(school), title: `${TAG} Notice ${i}`, body: `Body ${i}`,
                sender: sid(teacher), targetType: 'all_teachers',
            });
            notifIds.push(sid(n));
            await NotificationReceipt.create({ notification: sid(n), recipient: sid(teacher), isRead: false, isCleared: false });
        }
        const bell0 = await GET('/notifications/inbox', { as: teacher });
        const page0 = await GET('/notifications/all', { as: teacher });
        check('the bell shows all three', (bell0.data || []).length === 3, `${(bell0.data || []).length}`);
        check('the page shows all three', (page0.data || []).length === 3, `${(page0.data || []).length}`);
        check('the unread count is three', (await GET('/notifications/unread-count', { as: teacher })).count === 3);

        section('Clear all — the bell empties, the page does not');
        const cleared = await POST('/notifications/clear-all', { as: teacher });
        check('clear-all succeeds', cleared.status === 200);

        const bell1 = await GET('/notifications/inbox', { as: teacher });
        check('the bell is now empty', (bell1.data || []).length === 0, `${(bell1.data || []).length}`);
        check('the badge count is zero', (await GET('/notifications/unread-count', { as: teacher })).count === 0);

        const page1 = await GET('/notifications/all', { as: teacher });
        check('the notifications page still shows all three', (page1.data || []).length === 3,
            `${(page1.data || []).length}`);
        check('their titles are intact',
            (page1.data || []).every((r) => /Notice [123]/.test(r.notification?.title || '')));

        section('Nothing was deleted — the receipts are only flagged');
        const rows = await NotificationReceipt.find({ recipient: sid(teacher) }).lean();
        check('all three receipts still exist in the database', rows.length === 3, `${rows.length}`);
        check('each is flagged cleared, not removed', rows.every((r) => r.isCleared === true));
        check('the notifications themselves survive',
            (await Notification.countDocuments({ _id: { $in: notifIds } })) === 3);

        section('Dismissing one behaves the same way');
        // Undo the clear so there is something in the bell again.
        await NotificationReceipt.updateMany({ recipient: sid(teacher) }, { isCleared: false });
        const bell2 = await GET('/notifications/inbox', { as: teacher });
        check('the bell refills once the flag is lifted', (bell2.data || []).length === 3);

        const one = bell2.data[0]._id;
        check('dismissing one succeeds', (await DEL(`/notifications/${one}`, { as: teacher })).status === 200);
        const bell3 = await GET('/notifications/inbox', { as: teacher });
        const page3 = await GET('/notifications/all', { as: teacher });
        check('the bell drops that one', (bell3.data || []).length === 2, `${(bell3.data || []).length}`);
        check('the page still shows all three', (page3.data || []).length === 3, `${(page3.data || []).length}`);

        section('One person clearing does not affect another');
        const other = await User.create({
            name: `${TAG} Other`, email: `${TAG}.o@x.test`, role: 'teacher', school: sid(school),
            password: await bcrypt.hash('x', 4), isFirstLogin: false, isActive: true,
        });
        other.school = school;
        await NotificationReceipt.create({ notification: notifIds[0], recipient: sid(other), isRead: false, isCleared: false });
        await POST('/notifications/clear-all', { as: teacher });
        const otherBell = await GET('/notifications/inbox', { as: other });
        check("the other person's bell is untouched", (otherBell.data || []).length === 1,
            `${(otherBell.data || []).length}`);
        await User.findByIdAndDelete(sid(other));
    } finally {
        await NotificationReceipt.deleteMany({ notification: { $in: notifIds } }).catch(() => {});
        await Notification.deleteMany({ _id: { $in: notifIds } }).catch(() => {});
        await User.deleteMany({ email: { $regex: TAG } }).catch(() => {});
        await School.findByIdAndDelete(sid(school)).catch(() => {});
    }

    console.log(results.join('\n'));
    console.log(`\n${'─'.repeat(60)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(60)}`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
