'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('admission — applicant accounts', () => {
    let s; let portal;
    before(async () => {
        await H.startServer();
        s = await H.makeSchool('Auth');
        portal = await H.openPortal(s);
    });
    after(() => H.finish());

    it('serves the public portal by its address, and nothing at an unknown one', async () => {
        const r = await H.api('GET', `/admission/public/portals/${portal.slug}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.data.portal.status, 'open');
        assert.ok(!JSON.stringify(r.body).includes('smtp'), 'no school credentials on the public page');
        assert.equal((await H.api('GET', '/admission/public/portals/no-such-portal-xyz')).status, 404);
    });

    it('registers only after the emailed code is verified, then signs in', async () => {
        const email = `new-${H.rand()}@family.test`;
        const r = await H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'Kiran Rao', email, phone: '9876500001', password: 'Secret123', consent: true } });
        assert.equal(r.status, 200);
        const before = await H.q(`SELECT 1 FROM "users" WHERE "email" = $1`, [email]);
        assert.equal(before.length, 0, 'no account exists before the code is verified');
        const code = await H.lastCode(s.id, email);
        assert.match(code, /^\d{6}$/);
        const v = await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email, code } });
        assert.equal(v.status, 200);
        assert.equal(v.body.status, 'created');
        assert.equal(v.body.user.role, 'guest');
        const stored = await H.q(`SELECT "codeHash" FROM "admissionotps" WHERE "email" = $1`, [email]);
        assert.ok(stored.every((x) => !x.codeHash.includes(code)), 'only a hash of the code is stored');
        const login = await H.api('POST', `/admission/public/portals/${portal.slug}/login`, { body: { email, password: 'Secret123' } });
        assert.equal(login.status, 200);
        assert.ok(login.body.token);
    });

    it('refuses a wrong code, counts the tries, and locks the code after the limit', async () => {
        const email = `wrong-${H.rand()}@family.test`;
        await H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'Meera Iyer', email, phone: '9876500002', password: 'Secret123', consent: true } });
        const code = await H.lastCode(s.id, email);
        const wrong = code === '000000' ? '111111' : '000000';
        const a = await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email, code: wrong } });
        assert.equal(a.status, 400);
        assert.equal(a.body.code, 'OTP_WRONG');
        await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email, code: wrong } });
        const c = await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email, code: wrong } });
        assert.equal(c.body.code, 'OTP_LOCKED');
        // The right code no longer works once locked.
        const d = await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email, code } });
        assert.equal(d.status, 400);
    });

    it('refuses an expired code', async () => {
        const email = `late-${H.rand()}@family.test`;
        await H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'Late Comer', email, phone: '9876500003', password: 'Secret123', consent: true } });
        const code = await H.lastCode(s.id, email);
        await H.q(`UPDATE "admissionotps" SET "expiresAt" = now() - interval '1 minute' WHERE "email" = $1`, [email]);
        const r = await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email, code } });
        assert.equal(r.status, 400);
        assert.equal(r.body.code, 'OTP_EXPIRED');
    });

    it('enforces the resend cooldown and invalidates the previous code', async () => {
        const email = `resend-${H.rand()}@family.test`;
        await H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'Re Send', email, phone: '9876500004', password: 'Secret123', consent: true } });
        const first = await H.lastCode(s.id, email);
        const r = await H.api('POST', `/admission/public/portals/${portal.slug}/register/resend`, { body: { email } });
        assert.equal(r.status, 429);
        assert.equal(r.body.code, 'OTP_COOLDOWN');
        // Past the cooldown, a new code replaces the old one.
        await H.q(`UPDATE "admissionotps" SET "createdAt" = now() - interval '5 minutes' WHERE "email" = $1`, [email]);
        const again = await H.api('POST', `/admission/public/portals/${portal.slug}/register/resend`, { body: { email } });
        assert.equal(again.status, 200);
        const second = await H.lastCode(s.id, email);
        if (first !== second) {
            const old = await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email, code: first } });
            assert.equal(old.status, 400, 'the earlier code stopped working');
        }
        const ok = await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email, code: second } });
        assert.equal(ok.status, 200);
    });

    it('answers registration and forgot-password identically whether or not the address has an account', async () => {
        const existing = await H.registerGuest(s, portal.slug);
        const fresh = `nobody-${H.rand()}@family.test`;
        const a = await H.api('POST', `/admission/public/portals/${portal.slug}/forgot-password`, { body: { email: existing.email } });
        const b = await H.api('POST', `/admission/public/portals/${portal.slug}/forgot-password`, { body: { email: fresh } });
        assert.equal(a.status, b.status);
        assert.equal(a.body.message.replace(existing.email, 'X'), b.body.message.replace(fresh, 'X'));
        // A second registration of an existing applicant also just "sends a code"; the code reveals it.
        // (Past the resend cooldown, which any address — with an account or not — waits out the same way.)
        await H.q(`UPDATE "admissionotps" SET "createdAt" = now() - interval '5 minutes' WHERE "email" = $1`, [existing.email]);
        const r = await H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'Anita Sharma', email: existing.email, phone: '9876543210', password: 'Another123', consent: true } });
        assert.equal(r.status, 200);
        const code = await H.lastCode(s.id, existing.email);
        const v = await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email: existing.email, code } });
        assert.equal(v.body.status, 'exists');
        assert.ok(!v.body.token, 'no session from a duplicate registration');
        const n = await H.q(`SELECT COUNT(*)::int AS n FROM "users" WHERE "email" = $1 AND "role" = 'guest'`, [existing.email]);
        assert.equal(n[0].n, 1);
    });

    it('resets a password with an emailed code', async () => {
        const g = await H.registerGuest(s, portal.slug);
        await H.api('POST', `/admission/public/portals/${portal.slug}/forgot-password`, { body: { email: g.email } });
        const code = await H.lastCode(s.id, g.email, 'password_reset');
        const bad = await H.api('POST', `/admission/public/portals/${portal.slug}/reset-password`, { body: { email: g.email, code, password: 'short' } });
        assert.equal(bad.status, 400);
        const r = await H.api('POST', `/admission/public/portals/${portal.slug}/reset-password`, { body: { email: g.email, code, password: 'NewPass456' } });
        assert.equal(r.status, 200);
        assert.equal((await H.api('POST', `/admission/public/portals/${portal.slug}/login`, { body: { email: g.email, password: 'Applicant123' } })).status, 401);
        assert.equal((await H.api('POST', `/admission/public/portals/${portal.slug}/login`, { body: { email: g.email, password: 'NewPass456' } })).status, 200);
    });

    it('keeps an applicant session out of everything but the applicant API', async () => {
        const g = await H.registerGuest(s, portal.slug);
        assert.equal((await H.api('GET', '/admission/portal/me', { token: g.token })).status, 200);
        assert.equal((await H.api('GET', '/auth/me', { token: g.token })).status, 200);
        for (const url of ['/student/dashboard', '/parent/dashboard', '/admin/students', '/notifications/inbox', '/chat/chats', '/profile', '/auth/file-token', '/admission/admin/bootstrap', '/admission/staff/duties']) {
            const r = await H.api('GET', url, { token: g.token });
            assert.ok([401, 403].includes(r.status), `${url} answered ${r.status}`);
        }
        const me = await H.api('GET', '/auth/me', { token: g.token });
        assert.ok(!('password' in me.body.user), 'no password hash');
        assert.ok(!JSON.stringify(me.body.user.school || {}).includes('razorpayKeySecret'));
    });

    it('needs a session for the applicant API and an administrator for the office API', async () => {
        assert.equal((await H.api('GET', '/admission/portal/applications')).status, 401);
        assert.equal((await H.api('GET', '/admission/admin/applications')).status, 401);
        const teacher = await H.api('GET', '/admission/admin/applications', { token: s.teacherToken });
        assert.equal(teacher.status, 403, 'a teacher without admin on admissions is refused');
        assert.equal((await H.api('GET', '/admission/staff/duties', { token: s.teacherToken })).status, 200);
    });

    it('lets an address that already signs in join without changing its password', async () => {
        // A parent account the school already has, with its own password.
        const email = `parent-existing-${H.rand()}@family.test`;
        const bcrypt = require('bcryptjs');
        await H.insert('users', { _id: H.uuid(), name: 'Existing Parent', email, password: await bcrypt.hash('ParentPass1', 4), role: 'parent', school: s.id, isFirstLogin: false, isActive: true, createdAt: new Date() });
        await H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'Existing Parent', email, phone: '9876500005', password: 'Different99', consent: true } });
        const code = await H.lastCode(s.id, email);
        const v = await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email, code } });
        assert.equal(v.status, 200);
        assert.equal(v.body.status, 'linked');
        assert.ok(!v.body.token, 'a different password does not open the existing sign-in');
        assert.equal((await H.api('POST', `/admission/public/portals/${portal.slug}/login`, { body: { email, password: 'ParentPass1' } })).status, 200);
        assert.equal((await H.api('POST', `/admission/public/portals/${portal.slug}/login`, { body: { email, password: 'Different99' } })).status, 401);
    });

    it('refuses a student\'s address and a closed portal', async () => {
        const email = `student-${H.rand()}@family.test`;
        await H.insert('users', { _id: H.uuid(), name: 'A Student', email, password: 'x', role: 'student', school: s.id, isFirstLogin: false, isActive: true, createdAt: new Date() });
        await H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'A Student', email, phone: '9876500006', password: 'Secret123', consent: true } });
        const v = await H.api('POST', `/admission/public/portals/${portal.slug}/register/verify`, { body: { email, code: await H.lastCode(s.id, email) } });
        assert.equal(v.status, 400);
        assert.equal(v.body.code, 'STUDENT_EMAIL');
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { portal: { status: 'closed' } } });
        const r = await H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body: { name: 'Too Late', email: `late2-${H.rand()}@family.test`, phone: '9876500007', password: 'Secret123', consent: true } });
        assert.equal(r.status, 403);
        await H.api('PUT', '/admission/admin/settings', { token: s.adminToken, body: { portal: { status: 'open' } } });
    });

    it('validates registration input on the server', async () => {
        const bad = [
            { name: 'R2D2', email: 'a@b.test', phone: '9876500008', password: 'Secret123', consent: true },
            { name: 'Good Name', email: 'not-an-email', phone: '9876500008', password: 'Secret123', consent: true },
            { name: 'Good Name', email: 'x@y.test', phone: '12345', password: 'Secret123', consent: true },
            { name: 'Good Name', email: 'x@y.test', phone: '9876500008', password: 'abc', consent: true },
            { name: 'Good Name', email: 'x@y.test', phone: '9876500008', password: 'Secret123', consent: false },
            { name: '<script>alert(1)</script>', email: 'x@y.test', phone: '9876500008', password: 'Secret123', consent: true },
        ];
        for (const body of bad) {
            const r = await H.api('POST', `/admission/public/portals/${portal.slug}/register`, { body });
            assert.equal(r.status, 400, JSON.stringify(body));
        }
    });
});
