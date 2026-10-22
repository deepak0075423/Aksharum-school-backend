'use strict';
/**
 * The admission module's API — four audiences, four guards:
 *
 *   /public/portals/:slug/…   anyone; the school is the one behind the address.
 *                             Account endpoints are rate limited per address.
 *   /portal/…                 a signed-in applicant (role guest) — their own
 *                             applications at the school behind their session.
 *                             middleware/auth lets a guest session reach this
 *                             prefix and nothing else in the app.
 *   /admin/…                  admission administrators: school admins, and
 *                             teachers whose designation grants admin on the
 *                             module (allowModuleAdmin). Marking routes also let
 *                             an exam's assigned evaluators in — checked per exam.
 *   /staff/…                  teachers with access to the module: their duties.
 */
const express = require('express');
const router = express.Router();
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const { allowModuleAdmin, requireModule } = require('../../middleware/moduleAccess');
const { rateLimit } = require('../../middleware/rateLimit');
const { uploadAdmissionDoc } = require('../../middleware/upload');
const access = require('../../services/admission/access');
const pub = require('../../controllers/admissionPublic.controller');
const portal = require('../../controllers/admissionPortal.controller');
const admin = require('../../controllers/admissionAdmin.controller');
const applications = require('../../controllers/admissionApplications.controller');
const exam = require('../../controllers/admissionExam.controller');
const sel = require('../../controllers/admissionSelection.controller');
const staff = require('../../controllers/admissionStaff.controller');
const priv = require('../../controllers/admissionPrivacy.controller');
const delivery = require('../../controllers/admissionDelivery.controller');
const quota = require('../../controllers/admissionQuota.controller');
const booking = require('../../controllers/admissionBooking.controller');
const appeal = require('../../controllers/admissionAppeal.controller');
const ops = require('../../controllers/admissionOps.controller');
const group = require('../../controllers/admissionGroup.controller');
const digi = require('../../controllers/admissionDigilocker.controller');
const enrol = require('../../controllers/admissionEnrolment.controller');

// ── Public ───────────────────────────────────────────────────────────────────
// The sign-in surface of a portal: tight per address, like /api/auth.
const accountLimiter = rateLimit({ prefix: 'adm-account', windowSec: Number(process.env.RL_ADMISSION_WINDOW) || 60, max: Number(process.env.RL_ADMISSION_MAX) || 20 });
const enquiryLimiter = rateLimit({ prefix: 'adm-enquiry', windowSec: 3600, max: 10 });
const P = '/public/portals/:slug';
// "Not a robot" on the forms a script would abuse — when the server has a provider (services/admission/captcha).
const human = require('../../services/admission/captcha').required;
router.get(P, access.publicPortal, pub.portal);
router.post(`${P}/register`, accountLimiter, access.publicPortal, human, pub.register);
router.post(`${P}/register/resend`, accountLimiter, access.publicPortal, pub.resend);
router.post(`${P}/register/verify`, accountLimiter, access.publicPortal, pub.verify);
router.post(`${P}/login`, accountLimiter, access.publicPortal, pub.login);
router.post(`${P}/forgot-password`, accountLimiter, access.publicPortal, human, pub.forgot);
router.post(`${P}/reset-password`, accountLimiter, access.publicPortal, pub.reset);
router.post(`${P}/enquiries`, enquiryLimiter, access.publicPortal, human, pub.enquiry);
router.get(`${P}/lotteries/:listId`, access.publicPortal, pub.lottery);
router.get(`${P}/visits`, access.publicPortal, booking.publicVisits);
// The portal installed on a home screen: its manifest and icon (controllers/admissionPublic).
router.get(`${P}/manifest.webmanifest`, access.publicPortal, pub.manifest);
router.get(`${P}/icon.svg`, access.publicPortal, pub.icon);
// A group of schools' page — app.aksharum.com/g/<slug> (controllers/admissionGroup).
router.get('/public/groups/:slug', rateLimit({ prefix: 'adm-group', windowSec: 60, max: 60 }), group.publicGroup);
// DigiLocker sends the family's browser back here (services/admission/digilocker.js) — identified by its state, not a session.
router.get('/digilocker/callback', rateLimit({ prefix: 'adm-digilocker', windowSec: 60, max: 30 }), digi.callback);
// A mail provider's bounce and complaint reports — signed, not signed in (controllers/admissionDelivery).
router.post('/webhooks/email-events', rateLimit({ prefix: 'adm-webhook', windowSec: 60, max: 120 }), delivery.webhook);
// PIN code → state and district, for the application form's address (services/pincodes.js).
router.get('/public/pincodes/:pincode', rateLimit({ prefix: 'adm-pin', windowSec: 60, max: 40 }), pub.pincode);

// Paying a fee by a signed link, without signing in (services/admission/payLink.js).
const payLinkLimiter = rateLimit({ prefix: 'adm-paylink', windowSec: 60, max: 30 });
router.get(`${P}/pay/:token`, payLinkLimiter, access.publicPortal, pub.payLink);
router.post(`${P}/pay/:token/order`, payLinkLimiter, access.publicPortal, pub.payLinkOrder);
router.post(`${P}/pay/:token/verify`, payLinkLimiter, access.publicPortal, pub.payLinkVerify);
router.get(`${P}/pay/:token/receipt/:paymentId`, payLinkLimiter, access.publicPortal, pub.payLinkReceipt);
// The school's cookie policy, and each answer to its banner (controllers/cookiePolicy).
const cookies = require('../../controllers/cookiePolicy.controller');
const consentLimiter = rateLimit({ prefix: 'cookie-consent', windowSec: 3600, max: 60 });
router.get(`${P}/cookie-policy`, access.publicPortal, cookies.portalPolicy);
router.post(`${P}/cookie-consent`, consentLimiter, access.publicPortal, cookies.portalConsent);

// ── The applicant ────────────────────────────────────────────────────────────
const guest = [verifyToken, requireRole('guest'), access.guestPortal];
router.get('/portal/me', guest, portal.me);
router.get('/portal/rounds', guest, portal.rounds);
router.get('/portal/updates', guest, portal.updates);
router.get('/portal/applications', guest, portal.list);
router.post('/portal/applications', guest, portal.create);
router.get('/portal/applications/:id', guest, portal.detail);
router.put('/portal/applications/:id', guest, portal.save);
router.delete('/portal/applications/:id', guest, portal.discard);
router.post('/portal/applications/:id/submit', guest, portal.submit);
router.post('/portal/applications/:id/withdraw', guest, portal.withdraw);
router.post('/portal/applications/:id/documents', guest, uploadAdmissionDoc.single('file'), portal.upload);
router.delete('/portal/applications/:id/documents/:docId', guest, portal.removeDocument);
// Times a family books itself: an exam or interview time, and campus visits (controllers/admissionBooking).
router.get('/portal/applications/:id/exams/:examId/slots', guest, booking.examSlotsForFamily);
router.post('/portal/applications/:id/exams/:examId/slot', guest, booking.chooseExamSlot);
router.get('/portal/applications/:id/exams/:examId/calendar.ics', guest, booking.examCalendar);
router.get('/portal/visits', guest, booking.familyVisits);
router.post('/portal/visits/:slotId/book', guest, booking.bookVisit);
router.post('/portal/visit-bookings/:bookingId/cancel', guest, booking.cancelVisitBooking);
router.get('/portal/visit-bookings/:bookingId/calendar.ics', guest, booking.visitCalendar);
// Re-checks of results and appeals against decisions (controllers/admissionAppeal).
router.get('/portal/applications/:id/digilocker', guest, digi.view);
router.post('/portal/applications/:id/digilocker/start', guest, digi.start);
router.post('/portal/applications/:id/digilocker/import', guest, digi.importFile);
router.get('/portal/group', guest, group.familyGroup);
router.put('/portal/group/preferences', guest, group.setPreferences);
router.get('/portal/applications/:id/appeals', guest, appeal.familyList);
router.post('/portal/applications/:id/appeals', guest, appeal.file);
router.post('/portal/applications/:id/appeals/:appealId/withdraw', guest, appeal.withdraw);
router.get('/portal/applications/:id/documents/:docId/file', guest, portal.documentFile);
router.post('/portal/applications/:id/pay', guest, portal.payOrder);
router.post('/portal/applications/:id/pay-link', guest, accountLimiter, portal.payLink);
router.post('/portal/applications/:id/pay/verify', guest, portal.payVerify);
router.post('/portal/applications/:id/payments/:paymentId/reconcile', guest, portal.payReconcile);
router.get('/portal/applications/:id/payments/:paymentId/receipt', guest, portal.receipt);
router.post('/portal/applications/:id/offer/respond', guest, portal.respondOffer);
router.get('/portal/applications/:id/lists', guest, portal.lists);
router.get('/portal/applications/:id/acknowledgement.pdf', guest, portal.acknowledgement);
router.get('/portal/applications/:id/exams/:examId/admit-card.pdf', guest, portal.admitCard);
router.get('/portal/applications/:id/exams/:examId/scorecard.pdf', guest, portal.scorecard);
router.get('/portal/applications/:id/offer-letter.pdf', guest, portal.offerLetter);
router.post('/portal/applications/:id/exams/:examId/start', guest, portal.startExam);
router.get('/portal/applications/:id/attempts/:attemptId', guest, portal.attempt);
router.put('/portal/applications/:id/attempts/:attemptId/answers', guest, portal.saveAnswers);
router.post('/portal/applications/:id/attempts/:attemptId/submit', guest, portal.submitExam);
router.post('/portal/applications/:id/attempts/:attemptId/violation', guest, portal.violation);
router.post('/portal/applications/:id/attempts/:attemptId/next-section', guest, portal.nextSection);
// The family's own information: requests, a copy of everything, agreeing to a changed notice.
router.get('/portal/privacy', guest, priv.mine);
router.get('/portal/privacy/export', guest, priv.exportMine);
router.post('/portal/privacy/requests', guest, priv.createRequest);
router.post('/portal/consent', guest, priv.consent);

// ── Administrators ───────────────────────────────────────────────────────────
const A = [verifyToken, requirePasswordReset, allowModuleAdmin('admission')];
// Marking: administrators, or the exam's own evaluators (checked per exam).
const M = [verifyToken, requirePasswordReset, requireRole('school_admin', 'teacher'), requireModule('admission')];

router.get('/admin/bootstrap', A, admin.bootstrap);
router.get('/admin/staff', A, admin.staff);
router.put('/admin/settings', A, admin.saveSettings);
router.get('/admin/settings/slug-check', A, admin.slugCheck);
router.put('/admin/settings/slug', A, admin.saveSlug);
router.get('/admin/settings/number-preview', A, admin.numberPreview);
router.get('/admin/workflow', A, admin.workflow);
router.put('/admin/workflow', A, admin.saveWorkflow);

router.get('/admin/rounds', A, admin.rounds);
router.post('/admin/rounds', A, admin.createRound);
router.put('/admin/rounds/:id', A, admin.updateRound);
router.post('/admin/rounds/:id/status', A, admin.roundStatus);
router.delete('/admin/rounds/:id', A, admin.deleteRound);
router.get('/admin/rounds/:id/seats', A, admin.roundSeats);
// Quotas: seat pools, releasing unfilled seats, the state's RTE allotments, the reimbursement register.
router.get('/admin/rounds/:id/pools', A, quota.pools);
router.post('/admin/rounds/:id/quotas/release', A, quota.release);
router.post('/admin/rounds/:id/rte-allotments', A, quota.importAllotments);
router.get('/admin/rte/register', A, quota.register);
router.patch('/admin/rte/register/:id', A, quota.updateClaim);
router.patch('/admin/applications/:id/quota', A, quota.setQuota);

router.get('/admin/forms', A, admin.forms);
router.post('/admin/forms', A, admin.createForm);
router.get('/admin/forms/:id', A, admin.form);
router.put('/admin/forms/:id', A, admin.updateForm);
router.delete('/admin/forms/:id', A, admin.deleteForm);
router.put('/admin/forms/:id/draft', A, admin.saveDraft);
router.post('/admin/forms/:id/publish', A, admin.publishForm);
router.post('/admin/forms/:id/discard-draft', A, admin.discardDraft);
router.post('/admin/forms/:id/duplicate', A, admin.duplicateForm);
router.post('/admin/forms/:id/test', A, admin.testForm);
router.get('/admin/forms/:id/versions/:versionId', A, admin.version);

router.get('/admin/document-types', A, admin.docTypes);
router.post('/admin/document-types', A, admin.createDocType);
router.put('/admin/document-types/order', A, admin.orderDocTypes);
router.put('/admin/document-types/:id', A, admin.updateDocType);
router.delete('/admin/document-types/:id', A, admin.deleteDocType);

router.get('/admin/emails', A, admin.emails);
router.get('/admin/email-logs', A, admin.emailLogs);
router.post('/admin/email-logs/:id/retry', A, admin.retryEmail);
router.put('/admin/emails/:event', A, admin.saveEmail);
router.post('/admin/emails/:event/preview', A, admin.previewEmail);
router.post('/admin/emails/:event/test', A, admin.testEmail);
router.put('/admin/emails/:event/enabled', A, admin.toggleEmail);
router.get('/admin/emails/:event/versions', A, admin.emailVersions);
router.post('/admin/emails/:event/restore', A, admin.restoreEmail);
router.post('/admin/emails/:event/reset', A, admin.resetEmail);
router.get('/admin/email-suppressions', A, delivery.suppressions);
router.post('/admin/email-suppressions', A, delivery.addSuppression);
router.delete('/admin/email-suppressions/:id', A, delivery.removeSuppression);
router.get('/admin/email-domain-check', A, delivery.domainCheck);

// Enquiries as the office works them — owners, follow-ups, a log of contacts — and what sources cost (controllers/admissionCrm).
const crm = require('../../controllers/admissionCrm.controller');
router.get('/admin/enquiries', A, crm.list);
router.post('/admin/enquiries', A, crm.create);
router.patch('/admin/enquiries/:id', A, crm.update);
router.post('/admin/enquiries/:id/interactions', A, crm.interaction);
router.get('/admin/sources', A, crm.sources);
router.put('/admin/sources', A, crm.setSpend);
router.get('/admin/applicants', A, admin.applicants);
router.patch('/admin/applicants/:userId', A, admin.setApplicantActive);
router.get('/admin/analytics', A, admin.analytics);
router.get('/admin/audit', A, admin.audit);

router.get('/admin/applications', A, applications.list);
router.get('/admin/applications/export', A, applications.exportList);
router.post('/admin/applications/bulk', A, applications.bulk);
router.get('/admin/applications/:id', A, applications.detail);
router.get('/admin/applications/:id/application.pdf', A, applications.pdf);
router.post('/admin/applications/:id/transition', A, applications.transition);
router.post('/admin/applications/:id/approval', A, applications.decidePending);
router.patch('/admin/applications/:id/assign', A, applications.assign);
router.post('/admin/applications/:id/notes', A, applications.addNote);
router.put('/admin/applications/:id/answers', A, applications.correct);
router.get('/admin/applications/:id/duplicates', A, applications.duplicates);
router.post('/admin/applications/:id/duplicates/clear', A, applications.clearDuplicate);
router.post('/admin/applications/:id/documents', A, uploadAdmissionDoc.single('file'), applications.uploadOnBehalf);
router.post('/admin/applications/:id/payments', A, applications.recordPayment);
router.post('/admin/applications/:id/payments/:paymentId/void', A, applications.voidPayment);
router.post('/admin/applications/:id/payments/:paymentId/refund', A, applications.refund);
router.post('/admin/applications/:id/pay-link', A, applications.payLink);
router.get('/admin/applications/:id/payments/:paymentId/receipt', A, applications.receipt);
router.post('/admin/applications/:id/waivers', A, applications.addWaiver);
router.post('/admin/applications/:id/waivers/remove', A, applications.removeWaiver);
router.post('/admin/applications/:id/offer', A, sel.manualOffer);
router.post('/admin/applications/:id/offer/withdraw', A, sel.withdrawOffer);
router.post('/admin/applications/:id/offer/extend', A, sel.extendOffer);
router.post('/admin/applications/:id/offer/respond', A, sel.respondOnBehalf);
router.get('/admin/applications/:id/confirmation', A, sel.confirmation);
router.post('/admin/applications/:id/confirm', A, sel.confirm);
router.get('/admin/applications/:id/conversion', A, sel.conversionPreview);
router.post('/admin/applications/:id/convert', A, sel.convert);
router.post('/admin/applications/:id/activate', A, sel.activate);

// Data protection: requests, retention, the access log; legal hold and Aadhaar reveal per application.
router.get('/admin/privacy/requests', A, priv.requests);
router.patch('/admin/privacy/requests/:id', A, priv.answer);
router.post('/admin/privacy/requests/:id/erase', A, priv.erase);
router.get('/admin/privacy/retention', A, priv.retention);
router.post('/admin/privacy/retention/run', A, priv.runRetention);
router.get('/admin/privacy/access-log', A, priv.accessLog);
router.post('/admin/applications/:id/legal-hold', A, priv.legalHold);
router.post('/admin/applications/:id/reveal', A, priv.reveal);

router.get('/admin/documents', A, applications.documentQueue);
router.post('/admin/documents/:docId/review', A, applications.reviewDocument);
router.get('/admin/documents/:docId/file', A, applications.documentFile);
router.get('/admin/payments', A, applications.payments);

router.get('/admin/exams', A, exam.list);
router.post('/admin/exams', A, exam.create);
router.get('/admin/question-bank', A, exam.bank);
router.post('/admin/question-bank', A, exam.addToBank);
router.put('/admin/questions/:questionId', A, exam.updateQuestion);
router.delete('/admin/questions/:questionId', A, exam.deleteQuestion);
router.get('/admin/exams/:id', A, exam.detail);
router.get('/admin/exams/:id/slots', A, booking.examSlotsForOffice);
router.get('/admin/enrolment/plan', A, enrol.plan);
router.post('/admin/enrolment/bulk', A, enrol.bulk);
router.get('/admin/forecast', A, enrol.forecast);
router.get('/admin/group', A, group.mine);
router.put('/admin/group/listing', A, group.setListed);
router.get('/admin/transfers', A, group.transfers);
router.post('/admin/transfers/:id/decide', A, group.decideTransfer);
router.post('/admin/transfers/:id/cancel', A, group.cancelTransfer);
router.post('/admin/applications/:id/transfer', A, group.offerTransfer);
router.get('/admin/applications/:id/siblings', A, group.siblings);
router.get('/admin/health', A, ops.health);
router.get('/admin/exports', A, ops.exports);
router.post('/admin/exports', A, ops.queueExport);
router.get('/admin/exports/:id/file', A, ops.downloadExport);
router.get('/admin/appeals', A, appeal.officeList);
router.get('/admin/appeals/:id', A, appeal.detail);
router.patch('/admin/appeals/:id/assign', A, appeal.assign);
router.post('/admin/appeals/:id/decide', A, appeal.decide);
router.get('/admin/visits', A, booking.officeVisits);
router.post('/admin/visits', A, booking.openVisits);
router.patch('/admin/visits/:id', A, booking.updateVisit);
router.post('/admin/visits/:id/cancel', A, booking.cancelVisit);
router.get('/admin/visits/:id/bookings', A, booking.visitBookings);
router.patch('/admin/visit-bookings/:bookingId', A, booking.markVisitBooking);
router.put('/admin/exams/:id', A, exam.update);
router.delete('/admin/exams/:id', A, exam.remove);
router.post('/admin/exams/:id/schedule', A, exam.schedule);
router.post('/admin/exams/:id/cancel', A, exam.cancel);
router.post('/admin/exams/:id/questions', A, exam.addQuestion);
router.put('/admin/exams/:id/questions/order', A, exam.orderQuestions);
router.post('/admin/exams/:id/questions/import', A, exam.importQuestions);
router.get('/admin/exams/:id/eligible', A, exam.eligible);
router.post('/admin/exams/:id/candidates', A, exam.assign);
router.patch('/admin/exams/:id/candidates/:candidateId', A, exam.updateCandidate);
router.delete('/admin/exams/:id/candidates/:candidateId', A, exam.removeCandidate);
router.get('/admin/exams/:id/candidates/:candidateId/admit-card.pdf', A, exam.admitCard);
router.post('/admin/exams/:id/results/approve', A, exam.approveResults);
router.post('/admin/exams/:id/results/publish', A, exam.publishResults);
router.post('/admin/results/:resultId/correct', A, exam.correctResult);
router.get('/admin/exams/:id/results/export', A, exam.exportResults);
// Marking — administrators and the exam's evaluators.
router.get('/admin/exams/:id/results', M, exam.results);
router.put('/admin/exams/:id/marks', M, exam.enterMarks);
router.post('/admin/exams/:id/candidates/:candidateId/attendance', M, exam.attendance);
router.post('/admin/exams/:id/results/submit', M, exam.submitResults);
router.get('/admin/attempts/:attemptId', M, exam.attempt);
router.put('/admin/attempts/:attemptId/evaluate', M, exam.evaluate);

router.get('/admin/lists', A, sel.lists);
router.post('/admin/lists', A, sel.create);
router.get('/admin/offers', A, sel.offers);
router.get('/admin/lists/:id', A, sel.detail);
router.put('/admin/lists/:id', A, sel.update);
router.delete('/admin/lists/:id', A, sel.remove);
router.post('/admin/lists/:id/rebuild', A, sel.rebuild);
router.patch('/admin/lists/:id/entries/:entryId', A, sel.decision);
router.post('/admin/lists/:id/submit', A, sel.submit);
router.post('/admin/lists/:id/approve', A, sel.approve);
router.post('/admin/lists/:id/return', A, sel.sendBack);
router.post('/admin/lists/:id/publish', A, sel.publish);
router.post('/admin/lists/:id/close', A, sel.close);
router.post('/admin/lists/:id/draw', A, sel.draw);
router.get('/admin/lists/:id/verify', A, sel.verifyDraw);
router.post('/admin/lists/:id/cancel', A, sel.cancel);
router.get('/admin/lists/:id/export', A, sel.exportList);

// ── Staff (teachers) ─────────────────────────────────────────────────────────
const S = [verifyToken, requirePasswordReset, requireRole('school_admin', 'teacher'), requireModule('admission')];
router.get('/staff/duties', S, staff.duties);
router.get('/staff/applications/:id', S, staff.application);
router.post('/staff/applications/:id/transition', S, staff.transition);
router.post('/staff/applications/:id/notes', S, staff.note);
router.get('/staff/documents', S, staff.documentQueue);
router.post('/staff/documents/:docId/review', S, staff.reviewDocument);
router.get('/staff/documents/:docId/file', S, staff.documentFile);

module.exports = router;
