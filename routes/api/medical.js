'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  /api/medical — the Medical Room (Oct 2026).
//
//  Guards, all starting with verifyToken + requirePasswordReset:
//    staff    the school admin, or a teacher whose designation grants ADMIN on
//             'medical' (a nurse) — the whole room and every student's record
//    teacher  any teacher with access to the module: send a student, report an
//             incident, the alerts of their own sections (controllers decide)
//    student  their own record, as far as the school allows
//    parent   their own children's records, and their updates
//    member   anyone with access to the module — the file route, which then
//             decides per file (services/medicalFiles)
//
//  A module the school has switched off is refused by every guard.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const a = require('../../controllers/medicalAdmin.controller');
const t = require('../../controllers/medicalTeacher.controller');
const f = require('../../controllers/medicalFamily.controller');
const files = require('../../controllers/medicalFiles.controller');
const { verifyToken, requireRole, requirePasswordReset } = require('../../middleware/auth');
const { allowModuleAdmin, requireModule } = require('../../middleware/moduleAccess');

// The module guards let a caller with no school through (the super admin sits
// above per-school switches) — but every record here belongs to a school, so
// without one there is nothing to answer, only queries that fail.
const inSchool = (req, res, next) => (req.schoolId ? next()
    : res.status(403).json({ success: false, code: 'MEDICAL_NO_SCHOOL', message: 'Open the Medical Room from a school account' }));

// The medical staff, and (when the school asks for it) a code confirmed in the last 12 hours.
const staffNoStepUp = [verifyToken, requirePasswordReset, inSchool, allowModuleAdmin('medical')];
const staff   = [...staffNoStepUp, require('../../services/medicalStepUp').guard];
const teacher = [verifyToken, requirePasswordReset, requireRole('teacher'), requireModule('medical')];
const student = [verifyToken, requirePasswordReset, requireRole('student'), requireModule('medical')];
const parent  = [verifyToken, requirePasswordReset, requireRole('parent'), requireModule('medical')];
const family  = [verifyToken, requirePasswordReset, requireRole('student', 'parent'), requireModule('medical')];
const member  = [verifyToken, requirePasswordReset, inSchool, requireModule('medical')];

// ══ MEDICAL STAFF ═════════════════════════════════════════════════════════════

router.get('/admin/overview',          staff, a.overview);
router.get('/admin/meta',              staff, a.meta);
router.get('/admin/board/:screen',     staff, a.board);
router.get('/admin/search',            staff, a.search);
router.get('/admin/alerts',            staff, a.alerts);
router.get('/admin/room',              staff, a.room);

// Students and their health record
router.get ('/admin/students',                    staff, a.students);
router.get ('/admin/students/:id',                staff, a.student);
router.get ('/admin/students/:id/history',        staff, a.history);
router.get ('/admin/students/:id/emergency',      staff, a.emergency);
router.get ('/admin/students/:id/documents',      staff, a.studentDocuments);
router.put ('/admin/students/:id/profile',        staff, a.saveProfile);
router.post('/admin/students/:id/allergies',      staff, a.addAllergy);
router.post('/admin/students/:id/conditions',     staff, a.addCondition);
router.post('/admin/students/:id/vaccinations',   staff, a.addVaccination);
router.post('/admin/students/:id/checkups',       staff, a.addCheckup);
router.post('/admin/students/:id/documents',      staff, a.uploadDocument);
// Before a medicine is given: the checks, and what was given lately (services/medicalSafety).
router.get ('/admin/students/:id/recent-doses',   staff, a.recentDoses);
router.post('/admin/safety/check',                staff, a.safetyCheck);
// Rescue medicines and emergency care plans (services/medicalCare); archived through /admin/records/:kind.
router.post('/admin/students/:id/rescue-meds',    staff, a.addRescue);
router.put ('/admin/rescue-meds/:id',             staff, a.updateRescue);
router.post('/admin/rescue-meds/:id/check',       staff, a.checkRescue);
router.get ('/admin/care-plans/templates',        staff, a.carePlanTemplates);
router.post('/admin/students/:id/care-plans',     staff, a.addCarePlan);
router.put ('/admin/care-plans/:id',              staff, a.updateCarePlan);

router.put ('/admin/allergies/:id',               staff, a.updateAllergy);
router.put ('/admin/conditions/:id',              staff, a.updateCondition);
router.put ('/admin/vaccinations/:id',            staff, a.updateVaccination);
router.post('/admin/vaccinations/:id/given',      staff, a.vaccinationGiven);
router.post('/admin/checkups/schedule',           staff, a.scheduleCheckups);
router.post('/admin/checkups/sheet',              staff, a.checkupSheet);
router.get ('/admin/checkups/sessions/:sessionId', staff, a.checkupSession);
router.put ('/admin/checkups/:id',                staff, a.recordCheckup);
router.post('/admin/checkups/:id/cancel',         staff, a.cancelCheckup);
router.put ('/admin/documents/:id',               staff, a.updateDocument);
router.post('/admin/documents/:id/review',        staff, a.reviewDocument);
router.get ('/admin/documents/:id/link',          staff, a.fileLink);
// allergies | conditions | vaccinations | checkups | documents
router.post('/admin/records/:kind/:id/verify',    staff, a.verifyRecord);
router.post('/admin/records/:kind/:id/archive',   staff, a.archiveRecord);
router.post('/admin/records/:kind/:id/restore',   staff, a.restoreRecord);

// The room: requests → visits → outcome
router.post('/admin/requests/:id/accept',         staff, a.acceptRequest);
router.post('/admin/requests/:id/arrive',         staff, a.arriveRequest);
router.post('/admin/requests/:id/cancel',         staff, a.cancelRequest);
router.post('/admin/visits',                      staff, a.createVisit);
router.get ('/admin/visits/:id',                  staff, a.visit);
router.put ('/admin/visits/:id',                  staff, a.updateVisit);
router.post('/admin/visits/:id/status',           staff, a.visitStatus);
// Sent home: the people on record who may collect the student, and who did.
router.get ('/admin/visits/:id/collectors',       staff, a.collectors);
router.post('/admin/visits/:id/collection',       staff, a.recordCollection);
router.post('/admin/visits/:id/reopen',           staff, a.reopenVisit);
router.post('/admin/visits/:id/contact-parent',   staff, a.contactParent);
router.get ('/admin/care-library',                staff, a.careLibrary);
router.post('/admin/visits/:id/readings',         staff, a.addReading);
router.post('/admin/visits/:id/readings/:rid/strike', staff, a.strikeReading);
router.post('/admin/visits/:id/triage',           staff, a.setTriage);
router.post('/admin/visits/:id/protocol',         staff, a.setProtocol);
router.put ('/admin/visits/:id/injuries',         staff, a.visitInjuries);
router.put ('/admin/incidents/:id/injuries',      staff, a.incidentInjuries);
router.get ('/admin/exclusion-rules',             staff, a.exclusionRules);
router.post('/admin/students/:id/restrictions',   staff, a.addRestriction);
router.put ('/admin/restrictions/:id',            staff, a.updateRestriction);
router.post('/admin/restrictions/:id/end',        staff, a.endRestriction);
router.post('/admin/students/:id/exclusions',     staff, a.addExclusion);
router.post('/admin/exclusions/:id/clear',        staff, a.clearExclusion);
router.post('/admin/exclusions/:id/cancel',       staff, a.cancelExclusion);
router.post('/admin/exclusions/:id/certificate',  staff, a.exclusionCertificate);
router.post('/admin/students/:id/consent',        staff, a.recordConsent);
router.post('/admin/consents/:id/withdraw',       staff, a.withdrawConsent);
router.post('/admin/consents/request',            staff, a.requestConsent);
router.post('/admin/plans/:id/supply',            staff, a.planSupply);
router.post('/admin/items/:id/count',             staff, a.countItem);
router.get ('/admin/items/:id/counts',            staff, a.itemCounts);
router.get ('/admin/places',                      staff, a.places);
router.post('/admin/places',                      staff, a.addPlace);
router.put ('/admin/places/:id',                  staff, a.updatePlace);
router.post('/admin/places/:id/check',            staff, a.checkPlace);
router.get ('/admin/places/:id/stock',            staff, a.placeStock);
router.post('/admin/stock/transfer',              staff, a.transferStock);
router.get ('/admin/reorder',                     staff, a.reorder);
router.post('/admin/reorder/purchase-request',    staff, a.reorderRequest);
router.get ('/admin/costs',                       staff, a.costs);
router.get ('/admin/disposals',                   staff, a.disposals);
router.post('/admin/disposals/:id/dispose',       staff, a.dispose);
router.get ('/admin/fridge',                      staff, a.fridge);
router.post('/admin/fridge',                      staff, a.logFridge);
router.post('/admin/step-up/send',                staffNoStepUp, a.stepUpSend);
router.post('/admin/step-up/verify',              staffNoStepUp, a.stepUpVerify);
router.get ('/admin/access-review',               staff, a.accessReview);
router.get ('/admin/students/:id/summary.pdf',    staff, a.healthSummary);
router.get ('/admin/retention',                   staff, a.retentionDue);
router.post('/admin/students/:id/legal-hold',     staff, a.legalHold);
router.post('/admin/students/:id/purge',          staff, a.purgeRecord);
router.get ('/admin/data-requests',               staff, a.dataRequests);
router.post('/admin/data-requests/:id/respond',   staff, a.respondDataRequest);
// Programmes: growth, the vaccination schedule, referrals, campaigns, the outbreak watch.
router.get ('/admin/students/:id/growth',         staff, a.growth);
router.post('/admin/growth/assess',               staff, a.growthAssess);
router.get ('/admin/students/:id/schedule',       staff, a.studentSchedule);
router.post('/admin/students/:id/exemptions',     staff, a.addExemption);
router.post('/admin/exemptions/:id/end',          staff, a.endExemption);
router.get ('/admin/vaccine-coverage',            staff, a.vaccineCoverage);
router.post('/admin/vaccine-coverage/ask',        staff, a.vaccineAskFamilies);
router.get ('/admin/referrals',                   staff, a.referrals);
router.post('/admin/referrals',                   staff, a.createReferral);
router.get ('/admin/referrals/:id',               staff, a.referral);
router.post('/admin/referrals/:id/act',           staff, a.referralAct);
router.get ('/admin/referrals/:id/letter.pdf',    staff, a.referralLetter);
router.get ('/admin/campaigns',                   staff, a.campaigns);
router.post('/admin/campaigns',                   staff, a.createCampaign);
router.get ('/admin/campaigns/:id',               staff, a.campaign);
router.put ('/admin/campaigns/:id',               staff, a.updateCampaign);
router.post('/admin/campaigns/:id/record',        staff, a.campaignRecord);
router.post('/admin/campaigns/:id/mark-rest',     staff, a.campaignMarkRest);
router.post('/admin/campaigns/:id/:action',       staff, a.campaignAct);
router.get ('/admin/outbreaks',                   staff, a.outbreaks);
router.get ('/admin/outbreaks/:id',               staff, a.outbreak);
router.post('/admin/outbreaks/:id/act',           staff, a.outbreakAct);
router.get ('/admin/outbreaks/:id/notice-draft',  staff, a.outbreakNoticeDraft);
router.post('/admin/outbreaks/:id/notice',        staff, a.outbreakNotice);
router.get ('/admin/illness-reports',             staff, a.illnessReports);
router.post('/admin/illness-reports/:id/seen',    staff, a.illnessSeen);
// Records from a spreadsheet; the start of a new year.
router.get ('/admin/import/template/:kind',       staff, a.importTemplate);
router.post('/admin/import/preview',              staff, a.importPreview);
router.post('/admin/import/commit',               staff, a.importCommit);
router.get ('/admin/rollover',                    staff, a.rollover);
router.post('/admin/rollover/:key',               staff, a.rolloverAct);
// Emergency cards for the nurse's phone, offline (encrypted there, expiring).
router.get ('/admin/offline-cards',               staff, a.offlineCards);
// Printed documents.
router.get ('/admin/incidents/:id/report.pdf',    staff, a.incidentPdf);
router.get ('/admin/visits/:id/handover.pdf',     staff, a.handoverPdf);
router.get ('/admin/students/:id/annual.pdf',     staff, a.annualPdf);
router.get ('/admin/annual-cards.pdf',            staff, a.annualSetPdf);
router.post('/admin/emergency-cards.pdf',         staff, a.cardSetPdf);
// A scanned ID card (or a typed number) → the student; the walk-in kiosk at the door.
router.get ('/admin/resolve',                     staff, a.resolveStudent);
router.get ('/admin/kiosk/meta',                  staff, a.kioskMeta);
router.post('/admin/kiosk/walk-in',               staff, a.kioskWalkIn);
router.get ('/admin/staff-health',                staff, a.staffVisitsBoard);
router.get ('/admin/staff-health/search',         staff, a.searchStaffPatients);
router.get ('/admin/staff-health/:id',            staff, a.staffHealthCard);
router.put ('/admin/staff-health/:id',            staff, a.saveStaffHealth);
router.post('/admin/staff-visits',                staff, a.addStaffVisit);
router.put ('/admin/staff-visits/:id',            staff, a.updateStaffVisit);
router.post('/admin/staff-visits/:id/archive',    staff, a.archiveStaffVisit);
// Safeguarding: any member of staff raises a concern; only the leads read the log.
router.get ('/safeguarding/me',                   member, a.sgMe);
router.post('/safeguarding/concerns',             member, a.sgRaise);
router.get ('/safeguarding/mine',                 member, a.sgMine);
router.get ('/safeguarding/log',                  member, a.sgLog);
router.get ('/safeguarding/concerns/:id',         member, a.sgDetail);
router.post('/safeguarding/concerns/:id/note',    member, a.sgNote);
router.post('/safeguarding/concerns/:id/status',  member, a.sgStatus);
// A member of staff's own health record.
router.get ('/me/health',                         member, a.myHealth);
router.put ('/me/health',                         member, a.saveMyHealth);
router.get ('/admin/urgent',                      staff, a.urgentList);
router.post('/admin/urgent/:id/attempt',          staff, a.urgentAttempt);
router.post('/admin/urgent/:id/acknowledge',      staff, a.urgentAcknowledge);
router.post('/admin/urgent/:id/close',            staff, a.urgentClose);
router.post('/admin/visits/:id/bed',              staff, a.visitBed);
router.post('/admin/incidents',                   staff, a.createIncident);
router.get ('/admin/incidents/:id',               staff, a.incident);
router.put ('/admin/incidents/:id',               staff, a.updateIncident);
router.post('/admin/incidents/:id/status',        staff, a.incidentStatus);
router.post('/admin/incidents/:id/notify-parents', staff, a.notifyIncident);
router.post('/admin/incidents/:id/treat',         staff, a.treatIncident);
router.post('/admin/first-aid',                   staff, a.recordFirstAid);
router.get ('/admin/first-aid/:id',               staff, a.firstAid);
router.post('/admin/follow-ups/:kind/:id',        staff, a.followUp);
// visits | incidents | first-aid — archived with a reason, never deleted
router.post('/admin/cases/:kind/:id/archive',     staff, a.archiveCase);
router.post('/admin/cases/:kind/:id/restore',     staff, a.restoreCase);

// Beds
router.post  ('/admin/beds',                      staff, a.createBed);
router.put   ('/admin/beds/:id',                  staff, a.updateBed);
router.delete('/admin/beds/:id',                  staff, a.removeBed);

// Medicines, supplies, stock
router.post('/admin/items',                       staff, a.createItem);
router.get ('/admin/items/by-code',               staff, a.itemByCode);   // before /:id
router.get ('/admin/items/:id',                   staff, a.item);
router.put ('/admin/items/:id',                   staff, a.updateItem);
router.post('/admin/items/:id/archive',           staff, a.archiveItem);
router.post('/admin/items/:id/restore',           staff, a.restoreItem);
router.post('/admin/items/:id/stock-in',          staff, a.stockIn);
router.post('/admin/items/:id/stock-out',         staff, a.stockOut);
router.post('/admin/batches/:id/adjust',          staff, a.adjustBatch);
router.post('/admin/batches/:id/write-off',       staff, a.writeOffBatch);

// Medication administration
router.get ('/admin/administration',              staff, a.administration);
router.post('/admin/plans',                       staff, a.createPlan);
router.get ('/admin/plans/:id',                   staff, a.plan);
router.put ('/admin/plans/:id',                   staff, a.updatePlan);
router.post('/admin/plans/:id/authorize',         staff, a.authorizePlan);
router.post('/admin/plans/:id/status',            staff, a.planStatus);
router.post('/admin/doses/give',                  staff, a.giveDose);
router.post('/admin/doses/:id/record',            staff, a.recordDose);
router.post('/admin/doses/:id/cancel',            staff, a.cancelDose);

// Equipment
router.post('/admin/equipment',                   staff, a.createEquipment);
router.get ('/admin/equipment/:id',               staff, a.equipment);
router.put ('/admin/equipment/:id',               staff, a.updateEquipment);
router.post('/admin/equipment/:id/maintenance',   staff, a.maintainEquipment);
router.post('/admin/equipment/:id/archive',       staff, a.archiveEquipment);

// Parents' updates
router.get ('/admin/changes/:id',                 staff, a.change);
router.post('/admin/changes/:id/review',          staff, a.reviewChange);

// Reports and settings
router.get('/admin/reports',                      staff, a.reportCatalogue);
router.get('/admin/reports/:kind',                staff, a.report);
router.get('/admin/settings',                     staff, a.settings);
router.put('/admin/settings',                     staff, a.saveSettings);

// ══ TEACHER ═══════════════════════════════════════════════════════════════════

router.get ('/teacher/meta',                      teacher, t.meta);
router.get ('/teacher/overview',                  teacher, t.overview);
router.get ('/teacher/students',                  teacher, t.students);
router.get ('/teacher/requests',                  teacher, t.requests);
router.post('/teacher/requests',                  teacher, t.createRequest);
router.post('/teacher/requests/:id/cancel',       teacher, t.cancelRequest);
router.get ('/teacher/alerts',                    teacher, t.alerts);
router.get ('/teacher/students/:id/emergency',    teacher, t.emergency);
// In an emergency, any child's card — with a reason; audited, and the room is told.
router.post('/teacher/emergency-access',          teacher, t.emergencyAccess);
router.get ('/teacher/incidents',                 teacher, t.incidents);
router.post('/teacher/incidents',                 teacher, t.createIncident);

// ══ STUDENT & PARENT ══════════════════════════════════════════════════════════

router.get ('/student/record',                    student, f.record);
router.get ('/student/history',                   student, f.history);
router.get ('/parent/children',                   parent, f.children);
router.get ('/parent/record',                     parent, f.record);
router.get ('/parent/history',                    parent, f.history);
router.get ('/parent/emergency',                  parent, f.emergency);
router.post('/parent/updates',                    parent, f.submitUpdate);
router.post('/parent/updates/:id/withdraw',       parent, f.withdrawUpdate);
router.post('/parent/plans/:id/authorize',        parent, f.authorizePlan);
router.post('/parent/care-plans/:id/confirm',     parent, f.confirmCarePlan);
router.post('/parent/urgent/:id/ack',             parent, f.acknowledgeUrgent);
router.post('/parent/exclusions/:id/certificate', parent, f.exclusionCertificate);
router.post('/parent/consent',                    parent, f.giveConsent);
router.get ('/parent/summary.pdf',                parent, f.healthSummary);
router.post('/parent/data-requests',              parent, f.dataRequest);
router.get ('/parent/data-requests',              parent, f.dataRequests);
router.post('/parent/consent/:id/withdraw',       parent, f.withdrawConsent);
router.post('/parent/referrals/:id/answer',       parent, f.answerReferral);
router.get ('/family/annual.pdf',                 family, f.annualPdf);
router.post('/parent/language',                   parent, f.setLanguage);
router.get ('/parent/referrals/:id/letter.pdf',   parent, f.referralLetter);
router.post('/parent/campaigns/answer',           parent, f.answerCampaign);
router.post('/parent/illness',                    parent, f.reportIllness);
router.post('/parent/illness/:id/withdraw',       parent, f.withdrawIllness);
router.get ('/family/children',                   family, f.children);

// ══ FILES ═════════════════════════════════════════════════════════════════════

router.get('/files/:id',                          member, files.authed);
router.get('/file/:id',                           files.signed);

module.exports = router;
