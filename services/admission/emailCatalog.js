'use strict';
/**
 * Every email the admission module sends, the placeholders each may use, and
 * the platform's default wording. A school edits the wording per event
 * (AdmissionEmailTemplate); what an event IS — when it fires, who it goes
 * to, which values it can show — is fixed here.
 *
 *   required   cannot be switched off (sign-up and password codes)
 *   needs      placeholders the wording must keep ({{otp}} in a code email)
 */

const P = (label, link = false) => ({ label, link });

const COMMON = {
    school_name: P('School name'),
    applicant_name: P('Applicant (account holder) name'),
    portal_link: P('Admission portal link', true),
    login_link: P('Portal sign-in link', true),
    support_email: P('Admission office email'),
    support_phone: P('Admission office phone'),
};
const APPLICATION = {
    student_name: P('Student name'),
    application_number: P('Application number'),
    applying_class: P('Class applied for'),
    academic_year: P('Academic year'),
    round_name: P('Admission round'),
    application_link: P('Link to the application', true),
    status: P('Application status'),
};
const EXAM = {
    exam_name: P('Exam name'), exam_date: P('Exam date'), exam_time: P('Exam time'), exam_mode: P('Online / offline / interview'),
    exam_venue: P('Venue'), reporting_time: P('Reporting time'), exam_duration: P('Duration'), roll_number: P('Roll number'),
    admit_card_link: P('Admit card link', true), exam_link: P('Link to take / view the exam', true),
};
const LIST = { list_name: P('List name'), selection_list: P('Selection list'), rank: P('Rank'), waitlist_position: P('Waiting-list position') };
const OFFER = {
    offer_deadline: P('Accept the offer by'), admission_deadline: P('Admission deadline'),
    fee_amount: P('Admission fee'), payment_deadline: P('Pay the fee by'), offer_link: P('Link to respond to the offer', true),
};
const VISIT = { visit_title: P('Visit'), visit_date: P('Visit date'), visit_time: P('Visit time'), visit_location: P('Where to come'), visit_people: P('People coming') };
const PAYMENT = { receipt_number: P('Receipt number'), amount_paid: P('Amount paid'), payment_date: P('Payment date'), payment_for: P('What was paid for'), receipt_link: P('Receipt link', true) };

const EVENTS = {
    email_otp: {
        label: 'Email verification code', group: 'Account', required: true, needs: ['otp'],
        description: 'Sent when someone creates an applicant account, with the code that verifies their email.',
        placeholders: { ...COMMON, otp: P('The 6-digit code'), otp_expiry_minutes: P('Minutes the code is valid') },
        subject: '{{otp}} is your {{school_name}} verification code',
        body: `Hello {{applicant_name}},

Use this code to verify your email and finish creating your admission account with **{{school_name}}**:

# {{otp}}

The code is valid for {{otp_expiry_minutes}} minutes. If you did not ask for it, you can ignore this email.`,
    },
    guest_registration: {
        label: 'Welcome — account created', group: 'Account',
        description: 'Sent once the email is verified and the applicant account is ready.',
        placeholders: { ...COMMON },
        subject: 'Welcome to {{school_name}} admissions',
        body: `Hello {{applicant_name}},

Your admission account with **{{school_name}}** is ready. You can now start an application, save it as you go, upload documents and follow every step from your dashboard.

[[Go to my dashboard|{{portal_link}}]]

Questions? Write to {{support_email}} or call {{support_phone}}.`,
    },
    password_reset: {
        label: 'Password reset code', group: 'Account', required: true, needs: ['otp'],
        description: 'Sent when an applicant asks to reset their password.',
        placeholders: { ...COMMON, otp: P('The 6-digit code'), otp_expiry_minutes: P('Minutes the code is valid') },
        subject: '{{otp}} is your {{school_name}} password reset code',
        body: `Hello {{applicant_name}},

Use this code to reset your password:

# {{otp}}

The code is valid for {{otp_expiry_minutes}} minutes. If you did not ask to reset your password, ignore this email — your password stays the same.`,
    },
    application_submitted: {
        label: 'Application submitted', group: 'Application',
        description: 'Sent when an application is submitted.',
        placeholders: { ...COMMON, ...APPLICATION },
        subject: 'Application {{application_number}} received — {{student_name}}',
        body: `Hello {{applicant_name}},

Thank you for applying to **{{school_name}}**. We have received the application for **{{student_name}}** for {{applying_class}} ({{academic_year}}).

- Application number: **{{application_number}}**
- Round: {{round_name}}

You can follow its progress at any time.

[[View application|{{application_link}}]]`,
    },
    application_incomplete: {
        label: 'Application incomplete', group: 'Application',
        description: 'Sent when the office sends an application back for more information.',
        placeholders: { ...COMMON, ...APPLICATION, remarks: P('What the office asked for') },
        subject: 'Action needed on application {{application_number}}',
        body: `Hello {{applicant_name}},

The admission office needs a little more information on the application for **{{student_name}}** ({{application_number}}):

> {{remarks}}

Please update the application and submit it again.

[[Update application|{{application_link}}]]`,
    },
    document_rejected: {
        label: 'Document rejected', group: 'Documents',
        description: 'Sent when a document is rejected or needs to be uploaded again.',
        placeholders: { ...COMMON, ...APPLICATION, document_name: P('Document'), rejection_reason: P('Reason') },
        subject: 'Please upload {{document_name}} again — {{application_number}}',
        body: `Hello {{applicant_name}},

We could not accept the **{{document_name}}** uploaded for {{student_name}}.

> {{rejection_reason}}

Please upload a new copy from the application page.

[[Upload again|{{application_link}}]]`,
    },
    documents_verified: {
        label: 'Documents verified', group: 'Documents',
        description: 'Sent when every required document on an application has been verified.',
        placeholders: { ...COMMON, ...APPLICATION },
        subject: 'Documents verified — {{application_number}}',
        body: `Hello {{applicant_name}},

All the documents for **{{student_name}}**'s application ({{application_number}}) have been verified. We will be in touch about the next step.

[[View application|{{application_link}}]]`,
    },
    exam_scheduled: {
        label: 'Exam scheduled', group: 'Examinations',
        description: 'Sent when an applicant is scheduled for an entrance exam.',
        placeholders: { ...COMMON, ...APPLICATION, ...EXAM },
        subject: '{{exam_name}} on {{exam_date}} — {{student_name}}',
        body: `Hello {{applicant_name}},

**{{student_name}}** is scheduled for the **{{exam_name}}**.

- Date: {{exam_date}}
- Time: {{exam_time}}
- Mode: {{exam_mode}}
- Venue: {{exam_venue}}
- Reporting time: {{reporting_time}}
- Roll number: {{roll_number}}

[[View exam details|{{exam_link}}]]`,
    },
    exam_reminder: {
        label: 'Exam reminder', group: 'Examinations',
        description: 'Sent before an exam, at the time set under Settings → Email.',
        placeholders: { ...COMMON, ...APPLICATION, ...EXAM },
        subject: 'Reminder: {{exam_name}} on {{exam_date}}',
        body: `Hello {{applicant_name}},

A reminder that **{{student_name}}**'s **{{exam_name}}** is on {{exam_date}} at {{exam_time}} ({{exam_mode}}).

{{exam_venue}}

[[View exam details|{{exam_link}}]]`,
    },
    admit_card_available: {
        label: 'Admit card available', group: 'Examinations',
        description: 'Sent when admit cards for an offline exam can be downloaded.',
        placeholders: { ...COMMON, ...APPLICATION, ...EXAM },
        subject: 'Admit card ready — {{exam_name}}',
        body: `Hello {{applicant_name}},

The admit card for **{{student_name}}** (roll number {{roll_number}}) for the **{{exam_name}}** is ready. Please print it and bring it on {{exam_date}}.

[[Download admit card|{{admit_card_link}}]]`,
    },
    online_exam_instructions: {
        label: 'Online exam instructions', group: 'Examinations',
        description: 'Sent to applicants scheduled for an online exam.',
        placeholders: { ...COMMON, ...APPLICATION, ...EXAM },
        subject: 'How to take the {{exam_name}} online',
        body: `Hello {{applicant_name}},

**{{student_name}}** will take the **{{exam_name}}** online.

1. Sign in to the admission portal on {{exam_date}} at {{exam_time}}.
2. Open the application and choose **Start exam**.
3. You will have {{exam_duration}}. Answers are saved as you go and the exam is submitted when the time ends.

Use a laptop or desktop with a steady internet connection.

[[Open the exam page|{{exam_link}}]]`,
    },
    interview_scheduled: {
        label: 'Interview scheduled', group: 'Examinations',
        description: 'Sent when an interview is scheduled.',
        placeholders: { ...COMMON, ...APPLICATION, ...EXAM },
        subject: 'Interview on {{exam_date}} — {{student_name}}',
        body: `Hello {{applicant_name}},

We would like to meet **{{student_name}}** and family for an interview.

- Date: {{exam_date}}
- Time: {{exam_time}}
- Venue: {{exam_venue}}

[[View details|{{exam_link}}]]`,
    },
    slot_choose: {
        label: 'Choose an exam or interview time', group: 'Examinations',
        description: 'Sent when an applicant is added to an exam or interview whose times families choose themselves.',
        placeholders: { ...COMMON, ...APPLICATION, ...EXAM },
        subject: 'Choose a time for {{exam_name}} — {{student_name}}',
        body: `Hello {{applicant_name}},

**{{student_name}}** has a place in **{{exam_name}}**. Please choose the time that suits you from the application page — the earlier you choose, the more times there are.

[[Choose a time|{{exam_link}}]]`,
    },
    slot_booked: {
        label: 'Exam or interview time booked', group: 'Examinations',
        description: 'Sent when a family (or the office) books or moves its exam or interview time.',
        placeholders: { ...COMMON, ...APPLICATION, ...EXAM },
        subject: '{{exam_name}}: {{exam_date}}, {{exam_time}}',
        body: `Hello {{applicant_name}},

The time for **{{exam_name}}** is booked:

- Date: {{exam_date}}
- Time: {{exam_time}}
- Venue: {{exam_venue}}

You can add it to your calendar from the application page.

[[View details|{{exam_link}}]]`,
    },
    result_published: {
        label: 'Exam result published', group: 'Results',
        description: 'Sent when the school publishes exam results.',
        placeholders: { ...COMMON, ...APPLICATION, exam_name: P('Exam name'), result_link: P('Link to the result', true), result_summary: P('Result in a line (pass / fail)') },
        subject: 'Result published — {{exam_name}}',
        body: `Hello {{applicant_name}},

The result of the **{{exam_name}}** for {{student_name}} has been published.

[[View result|{{result_link}}]]`,
    },
    first_list_selection: {
        label: 'Selected — first list', group: 'Selection',
        description: 'Sent to applicants selected in a round\'s first list.',
        placeholders: { ...COMMON, ...APPLICATION, ...LIST, ...OFFER },
        subject: 'Congratulations — {{student_name}} is selected',
        body: `Hello {{applicant_name}},

We are pleased to tell you that **{{student_name}}** has been selected for {{applying_class}} in our **{{list_name}}**.

Please accept the offer by **{{offer_deadline}}** to keep the seat.

[[Respond to the offer|{{offer_link}}]]`,
    },
    second_list_selection: {
        label: 'Selected — second list', group: 'Selection',
        description: 'Sent to applicants selected in a round\'s second list.',
        placeholders: { ...COMMON, ...APPLICATION, ...LIST, ...OFFER },
        subject: 'Good news — {{student_name}} is selected in the second list',
        body: `Hello {{applicant_name}},

**{{student_name}}** has been selected for {{applying_class}} in our **{{list_name}}**.

Please accept the offer by **{{offer_deadline}}** to keep the seat.

[[Respond to the offer|{{offer_link}}]]`,
    },
    next_list_selection: {
        label: 'Selected — later lists', group: 'Selection',
        description: 'Sent to applicants selected in the third list or later, or from the waiting list.',
        placeholders: { ...COMMON, ...APPLICATION, ...LIST, ...OFFER },
        subject: 'A seat is available — {{student_name}}',
        body: `Hello {{applicant_name}},

A seat in {{applying_class}} is now available for **{{student_name}}** ({{list_name}}).

Please accept the offer by **{{offer_deadline}}** to keep it.

[[Respond to the offer|{{offer_link}}]]`,
    },
    waiting_list: {
        label: 'Waiting list', group: 'Selection',
        description: 'Sent to applicants placed on a waiting list.',
        placeholders: { ...COMMON, ...APPLICATION, ...LIST },
        subject: '{{student_name}} is on the waiting list',
        body: `Hello {{applicant_name}},

**{{student_name}}** is on the waiting list for {{applying_class}} — position **{{waitlist_position}}** in the {{list_name}}.

We will write to you as soon as a seat becomes available.

[[View application|{{application_link}}]]`,
    },
    admission_offer: {
        label: 'Admission offer', group: 'Selection',
        description: 'Sent when the office issues an offer outside a published list.',
        placeholders: { ...COMMON, ...APPLICATION, ...OFFER },
        subject: 'Admission offer for {{student_name}}',
        body: `Hello {{applicant_name}},

We are happy to offer **{{student_name}}** admission to {{applying_class}} for {{academic_year}}.

Please accept by **{{offer_deadline}}**. The admission fee of {{fee_amount}} is due by {{payment_deadline}}.

[[Respond to the offer|{{offer_link}}]]`,
    },
    payment_reminder: {
        label: 'Payment reminder', group: 'Payments',
        description: 'Sent before the admission fee is due, at the time set under Settings → Email.',
        placeholders: { ...COMMON, ...APPLICATION, ...OFFER },
        subject: 'Admission fee due by {{payment_deadline}} — {{student_name}}',
        body: `Hello {{applicant_name}},

A reminder that the admission fee of **{{fee_amount}}** for {{student_name}} is due by **{{payment_deadline}}**. The seat is confirmed once it is paid.

[[Pay now|{{application_link}}]]`,
    },
    payment_receipt: {
        label: 'Payment receipt', group: 'Payments',
        description: 'Sent when a payment is received — online or at the office.',
        placeholders: { ...COMMON, ...APPLICATION, ...PAYMENT },
        subject: 'Payment received — receipt {{receipt_number}}',
        body: `Hello {{applicant_name}},

We have received **{{amount_paid}}** towards the {{payment_for}} for {{student_name}} on {{payment_date}}.

- Receipt number: **{{receipt_number}}**

[[Download receipt|{{receipt_link}}]]`,
    },
    admission_confirmed: {
        label: 'Admission confirmed', group: 'Admission',
        description: 'Sent when the school confirms the admission.',
        placeholders: { ...COMMON, ...APPLICATION },
        subject: 'Admission confirmed — welcome, {{student_name}}!',
        body: `Hello {{applicant_name}},

**{{student_name}}**'s admission to {{applying_class}} for {{academic_year}} is confirmed. Welcome to {{school_name}}!

We will send the student and parent sign-in details shortly.

[[View application|{{application_link}}]]`,
    },
    enrollment_complete: {
        label: 'Student accounts ready', group: 'Admission',
        description: 'Sent when the student and parent accounts have been created.',
        placeholders: { ...COMMON, ...APPLICATION, admission_number: P('Admission number'), student_login_email: P('Student sign-in email'), parent_login_email: P('Parent sign-in email'), sign_in_note: P('How the student and parent sign in (what was actually sent)') },
        subject: '{{student_name}} is enrolled — admission number {{admission_number}}',
        body: `Hello {{applicant_name}},

**{{student_name}}** is now enrolled at {{school_name}} with admission number **{{admission_number}}**.

- Student sign-in: {{student_login_email}}
- Parent sign-in: {{parent_login_email}}

{{sign_in_note}}`,
    },
    admission_cancelled: {
        label: 'Admission withdrawn or cancelled', group: 'Admission',
        description: 'Sent when an application or admission is withdrawn or cancelled.',
        placeholders: { ...COMMON, ...APPLICATION, reason: P('Reason') },
        subject: 'Application {{application_number}} — {{status}}',
        body: `Hello {{applicant_name}},

The application for **{{student_name}}** ({{application_number}}) is now **{{status}}**.

{{reason}}

If you think this is a mistake, please contact the admission office at {{support_email}}.`,
    },
    application_rejected: {
        label: 'Application not successful', group: 'Application',
        description: 'Sent when an application is rejected or found ineligible.',
        placeholders: { ...COMMON, ...APPLICATION, reason: P('Reason') },
        subject: 'Your application to {{school_name}}',
        body: `Hello {{applicant_name}},

Thank you for your interest in {{school_name}}. We are sorry that we are unable to offer **{{student_name}}** a place in {{applying_class}} this time.

{{reason}}

We wish {{student_name}} every success.`,
    },
    data_request_received: {
        label: 'Privacy request received', group: 'Account',
        description: 'Sent when a family asks to see, correct or erase its information, withdraws consent or raises a grievance.',
        placeholders: { ...COMMON, request_number: P('Request number'), request_kind: P('What was asked for'), due_date: P('Answer due by') },
        subject: 'We have your request {{request_number}}',
        body: `Hello {{applicant_name}},

We have received your request **{{request_number}}**: {{request_kind}}.

The admission office will answer by **{{due_date}}**. You can follow it under "Your data" on the [admission portal]({{portal_link}}).`,
    },
    data_request_closed: {
        label: 'Privacy request answered', group: 'Account',
        description: 'Sent when the admission office completes or declines a privacy request.',
        placeholders: { ...COMMON, request_number: P('Request number'), request_kind: P('What was asked for'), request_outcome: P('Completed or declined'), remarks: P('The office\'s answer') },
        subject: 'Your request {{request_number}} has been {{request_outcome}}',
        body: `Hello {{applicant_name}},

Your request **{{request_number}}** ({{request_kind}}) has been **{{request_outcome}}**.

{{remarks}}

If you are not satisfied with this answer, you may raise it with the Data Protection Board of India.`,
    },
    payment_refunded: {
        label: 'Money refunded', group: 'Payments',
        description: 'Sent when the office refunds money on a payment.',
        placeholders: { ...COMMON, ...APPLICATION, amount_refunded: P('Amount refunded'), receipt_number: P('Receipt it was paid on'), refund_reason: P('Why'), payment_for: P('What was paid for') },
        subject: '{{amount_refunded}} refunded — {{application_number}}',
        body: `Hello {{applicant_name}},

We have refunded **{{amount_refunded}}** paid towards the {{payment_for}} (receipt {{receipt_number}}).

Reason: {{refund_reason}}

A refund to a card or bank account can take 5–7 working days to appear.`,
    },
    payment_link: {
        label: 'A link to pay', group: 'Payments',
        description: 'Sent when the office sends a family a link to pay a fee without signing in.',
        placeholders: { ...COMMON, ...APPLICATION, fee_amount: P('Amount due'), payment_for: P('What is to be paid'), pay_link: P('The payment link', true), link_expiry: P('The link works until') },
        subject: 'Pay the {{payment_for}} for {{student_name}}',
        body: `Hello {{applicant_name}},

**{{fee_amount}}** is due towards the {{payment_for}} for {{student_name}} ({{application_number}}).

[[Pay now|{{pay_link}}]]

The link works until {{link_expiry}}.`,
    },
    appeal_received: {
        label: 'Appeal received', group: 'Appeals',
        description: 'Sent when a family asks for a re-check of a result or appeals a decision.',
        placeholders: { ...COMMON, ...APPLICATION, appeal_number: P('Appeal number'), appeal_kind: P('What was asked for'), due_date: P('The school answers by'), exam_name: P('Exam (for a re-check)') },
        subject: 'We have your appeal {{appeal_number}}',
        body: `Hello {{applicant_name}},

We have received your {{appeal_kind}} for **{{student_name}}** ({{application_number}}) — number **{{appeal_number}}**.

The school will answer by {{due_date}}. You can follow it on the application page.

[[View application|{{application_link}}]]`,
    },
    appeal_decided: {
        label: 'Appeal answered', group: 'Appeals', required: true,
        description: 'Sent when the school answers an appeal or a re-check.',
        placeholders: { ...COMMON, ...APPLICATION, appeal_number: P('Appeal number'), appeal_outcome: P('Upheld / not upheld'), appeal_decision: P('The school\'s answer') },
        subject: 'Your appeal {{appeal_number}} has been answered',
        body: `Hello {{applicant_name}},

The school has answered appeal **{{appeal_number}}** for {{student_name}}: it is **{{appeal_outcome}}**.

{{appeal_decision}}

[[View application|{{application_link}}]]`,
    },
    visit_booked: {
        label: 'Campus visit booked', group: 'Visits',
        description: 'Sent when a family books a campus visit.',
        placeholders: { ...COMMON, ...VISIT },
        subject: 'Your visit on {{visit_date}}',
        body: `Hello {{applicant_name}},

Thank you for booking a visit to **{{school_name}}**.

- {{visit_title}}: {{visit_date}}, {{visit_time}}
- Where: {{visit_location}}
- People: {{visit_people}}

If your plans change, you can cancel from the admission portal.

[[Open the portal|{{portal_link}}]]`,
    },
    visit_reminder: {
        label: 'Campus visit reminder', group: 'Visits',
        description: 'Sent before a booked visit, as many hours before as the school sets.',
        placeholders: { ...COMMON, ...VISIT },
        subject: 'See you on {{visit_date}}',
        body: `Hello {{applicant_name}},

A reminder of your visit to **{{school_name}}**: {{visit_title}}, {{visit_date}} at {{visit_time}}.

Where: {{visit_location}}`,
    },
    visit_cancelled: {
        label: 'Campus visit cancelled by the school', group: 'Visits', required: true,
        description: 'Sent to every family booked on a visit time the school cancels.',
        placeholders: { ...COMMON, ...VISIT, reason: P('Why it was cancelled') },
        subject: 'Your visit on {{visit_date}} is cancelled',
        body: `Hello {{applicant_name}},

We are sorry — the visit on **{{visit_date}} at {{visit_time}}** has been cancelled.

Reason: {{reason}}

Please choose another time on the admission portal.

[[Choose another time|{{portal_link}}]]`,
    },
    status_update: {
        label: 'Status update', group: 'Application', defaultOff: true,
        description: 'Sent for other status changes, when switched on.',
        placeholders: { ...COMMON, ...APPLICATION, remarks: P('Note from the office') },
        subject: 'Update on application {{application_number}}',
        body: `Hello {{applicant_name}},

The application for **{{student_name}}** is now: **{{status}}**.

{{remarks}}

[[View application|{{application_link}}]]`,
    },
};

const EVENT_KEYS = Object.keys(EVENTS);

/** Values the template editor previews with. */
function sampleValues(school = {}) {
    return {
        school_name: school.name || 'Green Valley School',
        applicant_name: 'Anita Sharma', student_name: 'Riya Sharma', application_number: 'APP202700042',
        applying_class: 'Class 1', academic_year: '2027-28', round_name: 'Main Admissions', status: 'Under Review',
        portal_link: 'https://app.aksharum.com/green-valley', login_link: 'https://app.aksharum.com/green-valley/login',
        application_link: 'https://app.aksharum.com/green-valley/applications/sample',
        support_email: 'admissions@school.example', support_phone: '9876543210',
        otp: '482913', otp_expiry_minutes: '10', remarks: 'Please add the father\'s occupation.',
        document_name: 'Birth certificate', rejection_reason: 'The date of birth is not readable.',
        exam_name: 'Entrance Test', exam_date: 'Saturday, 13 March 2027', exam_time: '10:00 AM', exam_mode: 'Offline',
        exam_venue: 'Main Hall, Green Valley School', reporting_time: '9:30 AM', exam_duration: '60 minutes', roll_number: 'R270017',
        admit_card_link: 'https://app.aksharum.com/green-valley/applications/sample', exam_link: 'https://app.aksharum.com/green-valley/applications/sample',
        result_link: 'https://app.aksharum.com/green-valley/applications/sample', result_summary: 'Passed',
        list_name: 'First List', selection_list: 'First List', rank: '7', waitlist_position: '3',
        offer_deadline: '20 March 2027', admission_deadline: '27 March 2027', fee_amount: '₹25,000', payment_deadline: '27 March 2027',
        offer_link: 'https://app.aksharum.com/green-valley/applications/sample',
        receipt_number: 'ADR202700008', amount_paid: '₹500', payment_date: '2 March 2027', payment_for: 'application fee',
        receipt_link: 'https://app.aksharum.com/green-valley/applications/sample',
        admission_number: 'GVS20270031', student_login_email: 'riya.sharma@example.com', parent_login_email: 'anita.sharma@example.com',
        sign_in_note: 'Sign-in details for the student and parent accounts have been emailed.',
        reason: 'The class is full for this year.',
        request_number: 'DPR20270004', request_kind: 'A copy of my information', due_date: '14 March 2027', request_outcome: 'completed',
        amount_refunded: '₹500', refund_reason: 'Paid twice', pay_link: 'https://app.aksharum.com/green-valley/pay/sample', link_expiry: '20 March 2027',
        appeal_number: 'APL20270003', appeal_kind: 're-check of a result', appeal_outcome: 'upheld', appeal_decision: 'The answer sheet was checked again; two marks had not been added.',
        visit_title: 'Campus tour', visit_date: 'Saturday, 6 March 2027', visit_time: '10:30 AM', visit_location: 'Main gate, Green Valley School', visit_people: '3',
    };
}

module.exports = { EVENTS, EVENT_KEYS, sampleValues, COMMON };
