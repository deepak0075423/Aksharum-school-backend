'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const H = require('./helpers');

/**
 * A group of schools: set up by the platform, one page for families, a
 * family's applications across branches in their order of preference,
 * "accept here, withdraw elsewhere" only when the family ticks it, and moving
 * an application to another branch — offered by one, accepted by the other,
 * finished when the family submits it there.
 */
describe('admission — groups of schools', () => {
    let A; let B; let pa; let pb; let ra; let rb; let superToken; let superId; let groupId;
    const email = `family-${Date.now()}@family.test`;

    before(async () => {
        await H.startServer();
        A = await H.makeSchool('Branch-A');
        B = await H.makeSchool('Branch-B');
        pa = await H.openPortal(A);
        pb = await H.openPortal(B);
        ra = await H.makeRound(A, pa.form, { seats1: 5, admissionFee: 0 });
        rb = await H.makeRound(B, pb.form, { seats1: 5, admissionFee: 0 });
        superId = H.uuid();
        await H.insert('users', { _id: superId, name: 'Platform Admin', email: `super-${H.rand()}@platform.test`, password: await bcrypt.hash('Passw0rd!', 4), role: 'super_admin', school: null, isFirstLogin: false, isActive: true, createdAt: new Date() });
        superToken = H.tokenFor({ _id: superId, role: 'super_admin', school: null });
    });
    after(async () => {
        await H.q(`DELETE FROM "admissiontransfers" WHERE "group" = $1`, [groupId]).catch(() => {});
        await H.q(`DELETE FROM "admissiongroups" WHERE "_id" = $1`, [groupId]).catch(() => {});
        await H.q(`DELETE FROM "users" WHERE "_id" = $1`, [superId]).catch(() => {});
        await H.finish();
    });

    it('is set up by the platform — a school in one group only', async () => {
        const slug = `grp-${H.rand()}`;
        assert.equal((await H.api('POST', '/super-admin/admission-groups', { token: A.adminToken, body: { name: 'Sunrise Schools', slug, members: [A.id, B.id] } })).status, 403, 'not a school admin\'s to make');
        assert.equal((await H.api('POST', '/super-admin/admission-groups', { token: superToken, body: { name: 'Sunrise Schools', slug, members: [A.id] } })).status, 400, 'two schools at least');
        const g = await H.api('POST', '/super-admin/admission-groups', { token: superToken, body: { name: 'Sunrise Schools', slug, members: [A.id, B.id], shareStatus: true, intro: 'Two campuses, one family of schools.' } });
        assert.equal(g.status, 201, JSON.stringify(g.body));
        groupId = g.body.data._id;
        assert.equal((await H.api('POST', '/super-admin/admission-groups', { token: superToken, body: { name: 'Other', slug: `o-${H.rand()}`, members: [A.id, B.id] } })).status, 409);
    });

    it('shows families one page of listed branches', async () => {
        const slug = (await H.q(`SELECT "slug" FROM "admissiongroups" WHERE "_id" = $1`, [groupId]))[0].slug;
        let p = (await H.api('GET', `/admission/public/groups/${slug}`)).body.data;
        assert.deepEqual(p.branches.map((b) => b.slug).sort(), [pa.slug, pb.slug].sort());
        assert.equal(p.branches.every((b) => b.accepting), true);
        assert.equal((await H.api('PUT', '/admission/admin/group/listing', { token: B.adminToken, body: { listed: false } })).status, 200);
        p = (await H.api('GET', `/admission/public/groups/${slug}`)).body.data;
        assert.deepEqual(p.branches.map((b) => b.slug), [pa.slug], 'a branch that is not listed is not shown');
        await H.api('PUT', '/admission/admin/group/listing', { token: B.adminToken, body: { listed: true } });
        assert.equal((await H.api('GET', '/admission/public/groups/no-such-group')).status, 404);
    });

    let ga; let gb; let appA; let appB;
    it('puts a family\'s applications across branches in their order — and the office sees it', async () => {
        ga = await H.registerGuest(A, pa.slug, { email });
        gb = await H.registerGuest(B, pb.slug, { email });
        appA = await H.submittedApplication(A, ga, ra, { answers: { studentName: 'Ahaan Sethi', studentDob: '2021-01-21' } });
        appB = await H.submittedApplication(B, gb, rb, { answers: { studentName: 'Ahaan Sethi', studentDob: '2021-01-21' } });
        const view = (await H.api('GET', '/admission/portal/group', { token: ga.token })).body.data;
        assert.equal(view.applications.length, 2);
        assert.equal((await H.api('PUT', '/admission/portal/group/preferences', { token: ga.token, body: { order: [appB._id, appA._id] } })).status, 200);
        const sib = (await H.api('GET', `/admission/admin/applications/${appA._id}/siblings`, { token: A.adminToken })).body.data;
        assert.equal(sib.rank, 2);
        assert.deepEqual(sib.others.map((o) => [o.applicationNumber, o.groupRank]), [[appB.applicationNumber, 1]]);
        assert.equal((await H.api('PUT', '/admission/portal/group/preferences', { token: ga.token, body: { order: [H.uuid()] } })).status, 400, 'only their own');
    });

    it('withdraws the other branch\'s application only when the family ticks it on accepting', async () => {
        await H.verifyAllDocs(A, appA._id);
        assert.equal((await H.api('POST', `/admission/admin/applications/${appA._id}/offer`, { token: A.adminToken, body: {} })).status, 201);
        const r = await H.api('POST', `/admission/portal/applications/${appA._id}/offer/respond`, { token: ga.token, body: { accept: true, withdrawOthers: true } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.data.withdrawnElsewhere, 1);
        const [b] = await H.q(`SELECT "status" FROM "admissionapplications" WHERE "_id" = $1`, [appB._id]);
        assert.equal(b.status, 'withdrawn');
    });

    it('moves an application to another branch: offered, accepted, finished when the family submits there', async () => {
        const g2 = await H.registerGuest(A, pa.slug, { email: `mover-${H.rand()}@family.test` });
        const src = await H.submittedApplication(A, g2, ra, { answers: { studentName: 'Bhavya Nanda', studentDob: '2021-02-12' } });
        const offer = await H.api('POST', `/admission/admin/applications/${src._id}/transfer`, { token: A.adminToken, body: { toSchool: B.id, reason: 'The family moved closer to the B campus' } });
        assert.equal(offer.status, 201, JSON.stringify(offer.body));
        assert.equal((await H.api('POST', `/admission/admin/transfers/${offer.body.data._id}/decide`, { token: A.adminToken, body: { accept: true } })).status, 404, 'only the receiving branch answers');
        const inbox = (await H.api('GET', '/admission/admin/transfers', { token: B.adminToken })).body.data;
        assert.equal(inbox[0].direction, 'in');
        const ok = await H.api('POST', `/admission/admin/transfers/${offer.body.data._id}/decide`, { token: B.adminToken, body: { accept: true, round: rb._id, class: B.classes[0]._id, answer: 'Welcome to campus B' } });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        const draftId = ok.body.data.toApplication;
        const [draft] = await H.q(`SELECT * FROM "admissionapplications" WHERE "_id" = $1`, [draftId]);
        assert.equal(draft.status, 'draft');
        assert.equal(draft.data.studentName, 'Bhavya Nanda', 'answers copied');
        const [docs] = await H.q(`SELECT COUNT(*)::int AS n FROM "admissiondocuments" WHERE "application" = $1`, [draftId]);
        assert.equal(docs.n, 3, 'documents copied');
        // The family signs in at B with the same email and password, agrees to B's notice and submits.
        const [guestB] = await H.q(`SELECT * FROM "users" WHERE "_id" = $1`, [draft.applicant]);
        const tokenB = H.tokenFor(guestB);
        const consent = await H.api('POST', '/admission/portal/consent', { token: tokenB, body: { version: pb.settings.portal.privacyVersion || 1 } });
        assert.equal(consent.status, 200, JSON.stringify(consent.body));
        const sub = await H.api('POST', `/admission/portal/applications/${draftId}/submit`, { token: tokenB, body: {} });
        assert.equal(sub.status, 200, JSON.stringify(sub.body));
        await new Promise((r) => setTimeout(r, 200));
        const [old] = await H.q(`SELECT "status" FROM "admissionapplications" WHERE "_id" = $1`, [src._id]);
        assert.equal(old.status, 'withdrawn', 'the first application is withdrawn when the move is finished');
        const [t] = await H.q(`SELECT "status" FROM "admissiontransfers" WHERE "_id" = $1`, [offer.body.data._id]);
        assert.equal(t.status, 'completed');
    });
});
