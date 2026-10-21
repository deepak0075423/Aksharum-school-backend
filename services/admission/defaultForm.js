'use strict';
/**
 * The form and document types a school starts from. Everything here can be
 * changed, hidden or removed in the form builder — it is a starting point,
 * not a requirement. Sensitive questions (Aadhaar, religion, category,
 * income, health) are optional and marked sensitive, so only admission
 * administrators see the answers.
 */

const { STATES_AND_UTS } = require('../../utils/indiaStates');

const BOARDS = ['CBSE', 'ICSE', 'State Board', 'IB', 'Cambridge (IGCSE)', 'NIOS', 'Other'];
const opts = (list) => list.map((v) => ({ value: v, label: v }));
const yesNo = opts(['Yes', 'No']);
const INCOME = opts(['Below 2.5 lakh', '2.5 to 5 lakh', '5 to 10 lakh', '10 to 20 lakh', 'Above 20 lakh', 'Prefer not to say']);

const parentBlock = (who, label, { required }) => [
    { key: `${who}Name`, type: 'text', label: `${label}'s full name`, required, width: 'half', mapTo: `${who}.name`, validation: { kind: 'name', maxLength: 80 } },
    { key: `${who}Phone`, type: 'phone', label: `${label}'s mobile number`, required, width: 'half', mapTo: `${who}.phone` },
    { key: `${who}Email`, type: 'email', label: `${label}'s email`, width: 'half', mapTo: `${who}.email` },
    { key: `${who}Occupation`, type: 'text', label: 'Occupation', width: 'half', mapTo: `${who}.occupation`, validation: { kind: 'title', maxLength: 80 } },
    { key: `${who}Qualification`, type: 'text', label: 'Highest qualification', width: 'half', mapTo: `${who}.qualification`, validation: { kind: 'title', maxLength: 80 } },
    { key: `${who}Income`, type: 'select', label: 'Annual income', width: 'half', sensitive: true, mapTo: `${who}.annualIncome`, options: INCOME },
];

const atPrevious = { mode: 'all', rules: [{ field: 'attendedPreviousSchool', op: 'eq', value: 'Yes' }] };

function defaultSchema() {
    return {
        sections: [
            {
                key: 'student', title: 'Student details', description: 'As written on the birth certificate.',
                fields: [
                    { key: 'studentName', type: 'text', label: "Student's full name", required: true, width: 'full', mapTo: 'student.name', validation: { kind: 'name', minLength: 2, maxLength: 80 } },
                    { key: 'studentDob', type: 'date', label: 'Date of birth', required: true, width: 'half', mapTo: 'student.dob', validation: { maxDate: 'today' } },
                    { key: 'studentGender', type: 'radio', label: 'Gender', required: true, width: 'half', mapTo: 'student.gender', options: opts(['Male', 'Female', 'Other']) },
                    { key: 'bloodGroup', type: 'select', label: 'Blood group', width: 'half', mapTo: 'student.bloodGroup', options: opts(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Not known']) },
                    { key: 'nationality', type: 'text', label: 'Nationality', width: 'half', mapTo: 'student.nationality', defaultValue: 'Indian', validation: { kind: 'letters', maxLength: 40 } },
                    { key: 'religion', type: 'text', label: 'Religion', width: 'half', sensitive: true, mapTo: 'student.religion', help: 'Optional.', validation: { kind: 'letters', maxLength: 40 } },
                    { key: 'category', type: 'select', label: 'Category', width: 'half', sensitive: true, mapTo: 'student.category', help: 'Optional — asked only where a reservation applies.', options: opts(['General', 'OBC', 'SC', 'ST', 'EWS', 'Other']) },
                    { key: 'aadhaarNumber', type: 'text', label: "Student's Aadhaar number", width: 'half', sensitive: true, mapTo: 'student.aadhaarNumber', help: 'Optional. 12 digits.', validation: { kind: 'aadhaar', maxLength: 12 } },
                    { key: 'apaarId', type: 'text', label: 'APAAR ID', width: 'half', mapTo: 'student.apaar', help: 'Optional. The 12-digit student ID, if the child has one.', validation: { kind: 'apaar', maxLength: 12 } },
                    { key: 'penNumber', type: 'text', label: 'PEN (Permanent Education Number)', width: 'half', mapTo: 'student.pen', help: 'Optional. 11 digits, from the previous school.', validation: { kind: 'pen', maxLength: 11 } },
                ],
            },
            { key: 'father', title: "Father's details", description: '', fields: parentBlock('father', 'Father', { required: true }) },
            { key: 'mother', title: "Mother's details", description: '', fields: parentBlock('mother', 'Mother', { required: true }) },
            {
                key: 'guardian', title: 'Guardian & primary contact', description: 'Who the school should contact first about this application.',
                fields: [
                    { key: 'primaryContact', type: 'radio', label: 'Primary contact', required: true, mapTo: 'contact.primary', options: opts(['Father', 'Mother', 'Guardian']) },
                    { key: 'guardianName', type: 'text', label: "Guardian's full name", required: true, width: 'half', mapTo: 'guardian.name', validation: { kind: 'name', maxLength: 80 }, visibleIf: { mode: 'all', rules: [{ field: 'primaryContact', op: 'eq', value: 'Guardian' }] } },
                    { key: 'guardianRelation', type: 'text', label: 'Relation to the student', required: true, width: 'half', mapTo: 'guardian.relation', validation: { kind: 'letters', maxLength: 40 }, visibleIf: { mode: 'all', rules: [{ field: 'primaryContact', op: 'eq', value: 'Guardian' }] } },
                    { key: 'guardianPhone', type: 'phone', label: "Guardian's mobile number", required: true, width: 'half', mapTo: 'guardian.phone', visibleIf: { mode: 'all', rules: [{ field: 'primaryContact', op: 'eq', value: 'Guardian' }] } },
                    { key: 'guardianEmail', type: 'email', label: "Guardian's email", width: 'half', mapTo: 'guardian.email', visibleIf: { mode: 'all', rules: [{ field: 'primaryContact', op: 'eq', value: 'Guardian' }] } },
                    { key: 'emergencyName', type: 'text', label: 'Emergency contact name', width: 'half', mapTo: 'emergency.name', validation: { kind: 'name', maxLength: 80 } },
                    { key: 'emergencyContactPhone', type: 'phone', label: 'Emergency contact mobile', width: 'half', mapTo: 'emergency.phone' },
                    { key: 'emergencyRelation', type: 'text', label: 'Emergency contact relation', width: 'half', mapTo: 'emergency.relation', validation: { kind: 'letters', maxLength: 40 } },
                ],
            },
            {
                key: 'address', title: 'Address', description: '',
                fields: [
                    { key: 'addressLine', type: 'textarea', label: 'Current address', required: true, mapTo: 'address.line', validation: { maxLength: 300 } },
                    { key: 'pincode', type: 'text', label: 'PIN code', required: true, width: 'half', mapTo: 'address.pincode', help: 'The city and state fill themselves in.', validation: { kind: 'pincode', maxLength: 6 } },
                    { key: 'city', type: 'text', label: 'City / town', required: true, width: 'half', mapTo: 'address.city', validation: { kind: 'place', maxLength: 60 } },
                    { key: 'state', type: 'select', label: 'State / union territory', required: true, width: 'half', mapTo: 'address.state', options: opts(STATES_AND_UTS) },
                    { key: 'sameAsCurrent', type: 'checkbox', label: 'Permanent address is the same as the current address', mapTo: 'permanent.sameAsCurrent', defaultValue: true },
                    { key: 'permanentAddress', type: 'textarea', label: 'Permanent address', required: true, mapTo: 'permanent.line', validation: { maxLength: 300 }, visibleIf: { mode: 'all', rules: [{ field: 'sameAsCurrent', op: 'not_checked' }] } },
                ],
            },
            {
                key: 'previous_school', title: 'Previous school', description: '',
                fields: [
                    { key: 'attendedPreviousSchool', type: 'radio', label: 'Has the student attended a school before?', required: true, mapTo: 'previous.attended', options: yesNo },
                    { key: 'previousSchoolName', type: 'text', label: 'Name of the school', required: true, width: 'half', mapTo: 'previous.name', validation: { kind: 'title', maxLength: 120 }, visibleIf: atPrevious },
                    { key: 'previousBoard', type: 'select', label: 'Board', width: 'half', mapTo: 'previous.board', options: opts(BOARDS), visibleIf: atPrevious },
                    { key: 'previousClass', type: 'text', label: 'Last class attended', width: 'half', mapTo: 'previous.class', validation: { kind: 'title', maxLength: 40 }, visibleIf: atPrevious },
                    { key: 'previousYear', type: 'text', label: 'Academic year', width: 'half', placeholder: '2025-26', mapTo: 'previous.year', validation: { kind: 'code', maxLength: 9 }, visibleIf: atPrevious },
                    { key: 'previousCity', type: 'text', label: 'City', width: 'half', mapTo: 'previous.city', validation: { kind: 'place', maxLength: 60 }, visibleIf: atPrevious },
                    { key: 'previousUdise', type: 'text', label: 'UDISE+ code of the school', width: 'half', mapTo: 'previous.udise', help: 'Optional. 11 digits — on the transfer certificate or the school\'s board.', validation: { kind: 'udise', maxLength: 11 }, visibleIf: atPrevious },
                    { key: 'tcNumber', type: 'text', label: 'Transfer certificate number', width: 'half', mapTo: 'previous.tcNumber', help: 'If you already have it.', validation: { kind: 'code', maxLength: 40 }, visibleIf: atPrevious },
                    { key: 'tcDate', type: 'date', label: 'Transfer certificate date', width: 'half', mapTo: 'previous.tcDate', validation: { maxDate: 'today' }, visibleIf: atPrevious },
                ],
            },
            {
                key: 'medical', title: 'Health', description: 'Shared only with the school\'s admission office and, after admission, the Medical Room.',
                fields: [
                    { key: 'allergies', type: 'textarea', label: 'Allergies', sensitive: true, mapTo: 'medical.allergies', placeholder: 'For example: peanuts — severe', validation: { maxLength: 600 } },
                    { key: 'conditions', type: 'textarea', label: 'Medical conditions', sensitive: true, mapTo: 'medical.conditions', placeholder: 'For example: asthma', validation: { maxLength: 600 } },
                    { key: 'medicines', type: 'textarea', label: 'Medicines taken regularly', sensitive: true, mapTo: 'medical.medicines', validation: { maxLength: 600 } },
                    { key: 'doctorName', type: 'text', label: 'Family doctor', width: 'half', mapTo: 'medical.doctorName', validation: { kind: 'name', maxLength: 80 } },
                    { key: 'doctorPhone', type: 'phone', label: "Doctor's mobile", width: 'half', mapTo: 'medical.doctorPhone' },
                    { key: 'dietary', type: 'text', label: 'Dietary needs', mapTo: 'medical.dietary', validation: { maxLength: 200 } },
                ],
            },
            {
                key: 'sibling', title: 'Siblings', description: '',
                fields: [
                    { key: 'siblingStudying', type: 'radio', label: 'Does a brother or sister study at this school?', required: true, mapTo: 'sibling.studying', options: yesNo },
                    { key: 'siblingName', type: 'text', label: "Sibling's name", required: true, width: 'half', mapTo: 'sibling.name', validation: { kind: 'name', maxLength: 80 }, visibleIf: { mode: 'all', rules: [{ field: 'siblingStudying', op: 'eq', value: 'Yes' }] } },
                    { key: 'siblingAdmissionNumber', type: 'text', label: "Sibling's admission number", width: 'half', mapTo: 'sibling.admissionNumber', validation: { kind: 'code', maxLength: 30 }, visibleIf: { mode: 'all', rules: [{ field: 'siblingStudying', op: 'eq', value: 'Yes' }] } },
                ],
            },
            {
                key: 'transport', title: 'Transport', description: '',
                fields: [
                    { key: 'needsTransport', type: 'checkbox', label: 'The student will need school transport', mapTo: 'transport.required' },
                    { key: 'transportAddress', type: 'textarea', label: 'Pickup address', required: true, mapTo: 'transport.address', validation: { maxLength: 300 }, visibleIf: { mode: 'all', rules: [{ field: 'needsTransport', op: 'checked' }] } },
                ],
            },
            {
                key: 'hostel', title: 'Hostel', description: '',
                fields: [
                    { key: 'needsHostel', type: 'checkbox', label: 'The student will need a hostel place', mapTo: 'hostel.required' },
                    { key: 'hostelNotes', type: 'textarea', label: 'Anything the hostel should know', mapTo: 'hostel.notes', validation: { maxLength: 400 }, visibleIf: { mode: 'all', rules: [{ field: 'needsHostel', op: 'checked' }] } },
                ],
            },
            {
                key: 'documents', title: 'Documents', description: 'PDF, JPG or PNG. Clear scans or photos of the originals.',
                fields: [
                    { key: 'photoUpload', type: 'file', label: 'Passport-size photo of the student', required: true, docType: 'photo' },
                    { key: 'birthCertificateUpload', type: 'file', label: 'Birth certificate', required: true, docType: 'birth_certificate' },
                    { key: 'addressProofUpload', type: 'file', label: 'Address proof', required: true, docType: 'address_proof' },
                    { key: 'reportCardUpload', type: 'file', label: 'Last report card', required: true, docType: 'report_card', visibleIf: atPrevious },
                    { key: 'transferCertificateUpload', type: 'file', label: 'Transfer certificate', docType: 'transfer_certificate', help: 'Can be given later if not issued yet.', visibleIf: atPrevious },
                    { key: 'aadhaarUpload', type: 'file', label: "Student's Aadhaar card", docType: 'aadhaar', sensitive: true, help: 'Optional.' },
                ],
            },
            {
                key: 'declarations', title: 'Declaration', description: '',
                fields: [
                    { key: 'declarationTrue', type: 'declaration', label: 'Declaration', required: true, text: 'I declare that the information given in this application is true and complete to the best of my knowledge, and I understand that admission may be cancelled if any of it is found to be incorrect.' },
                    { key: 'consentData', type: 'declaration', label: 'Consent', required: true, text: 'I agree that the school may use the information and documents in this application to process the admission, as described in its privacy notice.' },
                ],
            },
        ],
    };
}

/** The document types the default form refers to. */
const DEFAULT_DOC_TYPES = [
    { key: 'photo', name: 'Passport-size photo', description: 'A recent colour photo of the student on a plain background.', accept: ['jpg', 'jpeg', 'png'], maxSizeMB: 2, required: true, gate: 'before_confirmation', mapsTo: 'photoFile', rejectionReasons: ['Photo is not clear', 'Face is not fully visible', 'Not a recent photo'] },
    { key: 'birth_certificate', name: 'Birth certificate', description: 'Issued by the municipal authority.', accept: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5, required: true, gate: 'before_confirmation', mapsTo: 'birthCertificateFile', rejectionReasons: ['Document is not readable', 'Name or date of birth does not match the application', 'Not an official certificate'] },
    { key: 'address_proof', name: 'Address proof', description: 'Utility bill, rent agreement, passport or a parent\'s Aadhaar card.', accept: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5, required: true, gate: 'before_confirmation', mapsTo: '', rejectionReasons: ['Document is not readable', 'Address does not match the application', 'Document has expired'] },
    { key: 'report_card', name: 'Last report card', description: 'The most recent report card from the previous school.', accept: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5, required: false, gate: 'before_confirmation', mapsTo: '', rejectionReasons: ['Document is not readable', 'Not the latest report card'] },
    { key: 'transfer_certificate', name: 'Transfer certificate', description: 'Issued by the previous school.', accept: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5, required: false, gate: 'before_confirmation', mapsTo: 'tcFile', rejectionReasons: ['Document is not readable', 'Not signed or stamped by the previous school'] },
    { key: 'aadhaar', name: "Student's Aadhaar card", description: 'Optional.', accept: ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMB: 5, required: false, gate: 'none', mapsTo: 'aadhaarFrontFile', sensitive: true, rejectionReasons: ['Document is not readable', 'Number does not match the application'] },
];

/** StudentProfile file fields a document type may become on enrolment. */
const STUDENT_FILE_FIELDS = {
    photoFile: 'Student photo', birthCertificateFile: 'Birth certificate', aadhaarFrontFile: 'Aadhaar (front)', aadhaarBackFile: 'Aadhaar (back)',
    casteCertificateFile: 'Caste certificate', disabilityCertificateFile: 'Disability certificate', medicalCertificateFile: 'Medical certificate',
    tcFile: 'Transfer certificate', migrationCertificateFile: 'Migration certificate',
};

module.exports = { defaultSchema, DEFAULT_DOC_TYPES, STUDENT_FILE_FIELDS, BOARDS };
