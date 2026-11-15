# Admission module — operations guide

For whoever deploys and runs Aksharum. It lists what the admission module
includes, every setting it reads and what happens while each is unset, where a
school's own admin switches things on, the background jobs and health card,
and what to do with a data-protection request or a breach.

Nothing here is needed for the module to work: with no optional setting at
all, email goes through the school's SMTP (or the platform's), files stay on
this server's disk, and every optional provider below shows itself as "off"
rather than pretending to work.

---

## 1. What the module includes

The base module (October 2026) is each school's admission portal at
`/<school>`, applicant accounts, configurable application forms, document
checks, entrance exams and interviews, merit and waiting lists, offers, fee
payment and enrolment into the ERP. The points below were added on top of it,
grouped as they were planned. Families hear from the school by email and on
the portal; the module sends no text messages or WhatsApp.

### Must-have

- **RTE compliance.** For the classes the RTE Act's no-screening rule covers,
  the module refuses entrance tests, interviews and merit lists, and fills the
  seats by lottery instead. Anyone can check a lottery: a fingerprint of its
  secret is shown before the draw and the secret is published after it, and
  the public page `/<school>/lottery/<list>` (or
  `node scripts/verifyLottery.js`) repeats the draw. Set in Admissions →
  Settings → *Compliance*; switching the rule off is recorded with the admin's
  name.
- **Data protection (DPDP Act 2023 and Rules 2025).** On the portal's *Your
  data* page a family downloads everything held about them, or asks for a
  correction or erasure, withdraws consent or raises a grievance; the office
  answers under Admissions → *Privacy* within the school's set time. Aadhaar
  numbers are masked and every reveal is logged, as is every export.
  Unsuccessful applications, old drafts and enquiries are erased after the
  school's retention periods unless they are on legal hold. When the privacy
  notice changes, families agree to the new one before they continue.
- **Cookie policy, set by each school.** School settings → *Privacy &
  cookies*: the banner's title and text, the policy's sections, which optional
  cookie types exist (preferences, analytics, marketing), a list of what is
  stored, an optional Google Analytics 4 or Meta Pixel ID (an ID, never a
  script), a contact email and how long a visitor's choice lasts. Visitors get
  a banner on the school's portal and the policy at `/<school>/cookies`;
  optional tags load only after they agree, and only on public portal pages.
  When the school changes what visitors agree to, the banner asks again.
- **Ready for production.** Documents can be kept in a private S3 bucket, with
  a script to move existing files. The admission tests run before every
  deploy, and a failure stops it. Addresses that bounce or complain go on a
  do-not-send list, and the sending domain's SPF, DKIM, DMARC and MX records
  are checked. `/health/ready` for load balancers, and a super-admin check of
  the visitor address the server sees behind the proxy.

### Should-have

- **Quotas.** Seats per class in a round for RTE (25%) and the school's own
  categories (staff, sibling and so on), each with its own lists and
  lotteries; unfilled quota seats can be released to general seats. RTE
  allotments are imported from the government's list (CSV), and the
  reimbursement register is kept under Admissions → *RTE seats*. Quotas are
  set in Admissions → *Rounds*.
- **Fees.** Refunds, through the gateway for online payments or recorded as
  paid back offline (a refund the gateway refuses stays shown as refused).
  Instalment plans per round, with the seat confirmed on the first instalment
  or only on the full amount, and a reminder before each instalment.
  Concessions for a quota are applied automatically. Payment links the office
  sends a family are signed and work for seven days (`/<school>/pay/…`).
- **Indian form fields.** A State list; the PIN code fills in the state and
  district where they are known (the PIN directory, then India Post, then a
  state guess); PEN (11 digits), APAAR ID (12), the previous school's UDISE
  code (11), TC number and date. All are checked on the server and carried
  into the student record at enrolment. The ERP's own address forms use the
  same PIN lookup.
- **Booking.** Families choose their exam or interview time from the office's
  slots (each with a capacity, a cut-off for changes and a limit on how often
  a booking can change), and book campus visits at `/<school>/visit`. Each
  booking comes with a calendar file (.ics) and a reminder. Slots are set in
  Admissions → Exams → *Times families choose*, visits in Admissions →
  *Visits*.
- **Appeals and re-checks.** Within the school's windows a family can ask for
  a result to be re-checked or appeal a decision, and the office answers
  within the set number of days. An upheld re-check corrects and republishes
  the result; an upheld appeal reopens the application. Admissions →
  *Appeals*.
- **Accessibility.** Dialogs keep keyboard focus inside and close with Escape,
  every form label belongs to its field, and colours meet the contrast rules.
  An automated WCAG 2.1 AA check (axe) of 16 portal pages finds no serious or
  critical problem.
- **Day-to-day running.** The health card on Admissions → *Dashboard*
  (section 4), a "not a robot" check on public forms, virus scanning of every
  upload, and large exports prepared in the background, kept for a day, with
  each download logged.
- **Safer default.** In a round with exams, offers wait until the results are
  approved.

### Could-have

- **Enquiry follow-up.** Each enquiry has an owner, a priority and a next
  follow-up date, with a reminder to the owner. A contact log records calls,
  emails, visits and messages staff sent from their own phones; the office
  enters walk-ins; an enquiry links itself to the family when they register.
  *Sources & spend* gives the cost per application and per admission for each
  source. Admissions → *Enquiries*.
- **Groups of schools.** One page for several branches at `/g/<group>`. A
  family sees its applications across the branches and ranks them, and
  accepting one offer can withdraw the others (the family ticks which). The
  office can move an application to another branch with its answers and
  documents. The platform sets groups up (Super admin → *Admission groups*);
  each school chooses whether it is listed (Admissions → *Branches*).
- **DigiLocker.** Families fetch issued documents straight from DigiLocker.
  Fetched files go through the same checks as uploads and show who issued
  them, and the DigiLocker account's date of birth is compared with the
  student's. Whether they count as verified is each school's choice (off by
  default).
- **Exam engine.** Timed sections taken in order; questions drawn per
  candidate from a larger set; extra time for a candidate, with the reason
  recorded; a retake rule (latest, best or average attempt); negative marking.
  Signals such as leaving the exam tab are kept as evidence for the office and
  never decide anything by themselves.
- **Bulk enrolment and forecast.** Enrol up to 50 confirmed applicants at
  once, into suggested sections that keep classes balanced; each enrolment is
  safe to repeat. A forecast from the school's last three years of offers says
  how many more offers each class needs. Admissions → *Enrolment*.
- **Installable portal and phone app.** Each school's portal installs on a
  phone's home screen with its own name, colours and icon. The Aksharum phone
  app carries the module too:
  - *Families* answer offers (and withdraw their other branches' applications
    on accepting), upload documents from the phone's files or camera, fetch
    them from DigiLocker, choose or change exam and interview times, book
    campus visits, appeal, pay (the gateway's own checkout, opened in the
    phone's browser), and use *Your data*. A changed privacy notice is agreed
    to first. Filling in a new application form and sitting an online exam
    stay on the portal.
  - *The office* (school admin, or a teacher who administers the module) has
    the dashboard and health, applications (status, documents, offers, fees,
    refunds, payment links, quota, legal hold, branches, enrolment),
    documents, exams (candidates, times, extra time, marks, publishing),
    selection lists (the lottery draw and its check), visits, appeals,
    enquiries, enrolment and the forecast, payments, RTE seats, branches,
    privacy and the main settings. Setting up forms, emails, rounds and exam
    questions stays on the web.
  - *Teachers* see their admission duties; the *super admin* manages groups
    of schools; a school admin edits the cookie policy (School settings →
    Privacy & cookies).

### Added in November 2026 (the gap audit)

Flow
- With the **Offer** stage switched off, selection is the seat: the offer is
  recorded as accepted at once and nothing lapses for want of an answer.
- **Withdrawn** and **declined** applications can be reopened by an admission
  administrator (back to Under Review), like rejected and cancelled ones.
- A teacher who is not an admission administrator **asks** to withdraw an
  application; an administrator approves it.
- An **upheld appeal** reopens the application to Under Review and moves it on
  to the stage chosen — only stages the workflow allows are offered. Appeals
  cover cancelled applications and lapsed offers too, and the family can
  attach up to three files. An upheld **re-check of an online exam** corrects
  its score (auto-marked and evaluator's parts).
- **Cancelling an exam** takes its candidates off it, voids sittings in
  progress and returns each application to where it stood before; a cancelled
  exam no longer counts in the checks before Evaluated or an offer. Removing a
  candidate does the same for that application.
- **Publishing a list** writes the list's status and every offer in one
  transaction.
- A list's page shows its own **quota's** seats.
- A draft with a fee paid on it cannot be **deleted** (it is withdrawn and
  refunded instead); unpaid orders go with a deleted draft.
- A family that has paid the admission fee reads "Fee received"; the office is
  told it is ready to confirm, or — with *Confirm by itself once the fee is in*
  (Settings → Enrolling) and no approval on the Confirmation stage — it is
  confirmed automatically.
- **Age rules** of a class (age on a date, born between) are checked when a
  draft is saved (as a warning on the date of birth) and when it is submitted
  (*Check each class's age rule*, Settings → Applications; on by default).
- **Two people** approve lists and results: whoever sent them for approval
  does not approve them (Settings → Selection; a school with one admission
  administrator is let through).
- **Waiting positions** are renumbered when someone is promoted or leaves.
- A result **corrected** after a merit list was built marks an unpublished
  list "needs rebuilding" (it cannot be sent or approved until rebuilt); for a
  published list the office is told.
- A round's **seats** cannot be cut below the seats already held; a changed
  **application fee** reaches drafts not yet paid.
- An **interview panel** of two or more marks one sheet each; the result is the
  average, and results cannot be submitted until every member has marked.
- **Extending an offer** moves the fee date and every instalment by the same
  number of days.
- An approved exam is **closed** to new sittings; an exam becomes Completed by
  itself once its time is over (the minute sweep).
- An online exam is open on **one page at a time**: the page that opened it
  last holds it; another device's saves are refused and noted for the
  evaluator. The list of noticed events is capped at 300.

Money
- Online payments the family's browser never reported are **checked with the
  gateway** by the minute sweep (sooner, then less often, for two days; then
  the order is closed). The family ("Check my payment", also on pay links)
  and the office ("Check with the gateway") can ask at once.
- Gateway **refunds** still pending are followed up; one that never reached the
  gateway is marked failed and the office told.
- **Cheques and drafts** wait to be marked cleared before the admission can be
  confirmed. Cancelling a receipt (a bounced cheque) on a confirmed admission
  returns it to *Payment Pending*.
- The application fee is not taken on a draft whose round has closed.
- **Payments → Needs attention** lists money to give back, uncleared cheques,
  unfinished online payments, unsettled refunds and overdue instalments.
  Instalments past their date are followed up once (family and office).
- Payment **links** can be cancelled (every link sent so far stops working).
- A **refund rule** (Settings → Fees: so many per cent within so many days of
  payment) is shown as a guide in the refund dialog.
- **Enrolment**: a free quota seat (RTE, or a quota with a free fee rule) is
  not put on the fee structure unless ticked; the student record keeps the
  admission date, the quota and whether it is an RTE seat; where the class's
  fee structure charges an admission head, what was paid at admission is
  credited to the student's fee account.

Enrolment
- A child without an email is offered the parent's address with the child's
  name after a "+" (anita+riya@…) — singly and in bulk enrolment.
- Admission numbers are given under one lock shared with the Students screen.
- Documents can be uploaded after confirmation and after enrolment; one
  verified after enrolment is copied to the student record when its field is
  empty.
- Welcome emails are waited for: "emailed" is said only of one the mail server
  accepted. "Activate accounts" can no longer send two passwords.
- The applicant's account becomes the student's only when it has no other
  open application.

Privacy and security
- Sign-up and reset **codes** are deleted after a day.
- **Erasure** also clears payment and refund references, offer notes, the quota
  note and state reference, waiver reasons, panel sheets, extra-time reasons,
  appeal files, closed privacy requests' text, and the applicant's name on
  history lines; a retired account's privacy requests and devices go too.
- Retention also closes **applicant accounts that never applied** (after the
  abandoned-draft period) and, after *enrolledMonths* (default 12), removes
  Aadhaar numbers and sensitive answers from enrolled students' applications.
- A **branch transfer** needs the family's yes on its application page before
  anything is copied to the other school.
- **DigiLocker** connects only when the signed-in owner of the application
  finishes it (the return link no longer connects anything by itself).
- The **restricted staff view** carries no fees, offers, waivers, legal hold,
  quota notes or duplicates.
- A privacy notice edit can be marked **wording only** (no new agreement);
  earlier wordings are kept and listed.
- "Forgot password" answers at once for every address; photos lose their
  **GPS** location (EXIF/XMP) when uploaded; files kept while the virus scanner
  was down are **rescanned** (a harmful one is removed and the family asked
  again); a copy replaced on an unsubmitted draft is deleted; a portal
  **enquiry** records the person's consent.
- Withdrawing consent withdraws the application named (all, if none is).
- Applicants can change their **name, mobile and password** (Your data).

Notifications
- Applicants also get each email's news as a **phone or browser
  notification** (the app now registers applicants' devices).
- Staff are told in the app (bell + device notification) about approvals
  waiting, applications assigned to them, documents uploaded again or late,
  appeals filed, offers answered, online admission fees received, lists and
  results waiting for approval, failed refunds, money to give back, a branch
  move agreed, and a daily summary after 9 am (new applications, approvals,
  appeals and privacy requests near their date, uncleared cheques, documents
  past the round's date).
- New reminders (Settings → Email): an offer about to lapse, a draft not
  submitted before the round closes, documents still owed near their date.
  New email templates: *Offer about to lapse*, *Instalment overdue*,
  *Application not submitted yet*, *Documents still needed*, *RTE seat
  allotment recorded* (sent when allotments are imported).
- Emails go through a **queue**: written down first, sent a few at a time
  (`ADMISSION_MAIL_PARALLEL`, default 3), a failure tried twice more (after 5
  and 20 minutes), and anything a restart left behind picked up by the sweep.
  One-time codes are still sent at once and never written down.
- Document type **gates** are enforced: *at submission* (must be uploaded) and
  *before the exam* (must be verified before a candidate is scheduled), as
  well as *before confirmation*.

Not done in this round
- The portal is still **English only**.
- The phone app still opens the browser for the **form**, the **online exam**
  and the **gateway checkout**.
- Unpaid instalments after enrolment are followed up but **not posted to the
  Fees module's ledger**.

---

## 2. Settings, feature by feature

All are environment variables of `school-backend` (see `.env.example`).
Links the module sends (emails, payment links, the installable portal,
DigiLocker's return) are built on `FRONTEND_URL` — set it to the web app's
public address, without a trailing slash.

### Email

| Setting | Effect |
|---|---|
| `ADMISSION_MAIL_DRIVER=log` | Development and tests only: every email is written to the email log, nothing is sent. Any other value (or unset) sends through SMTP. |
| `ADMISSION_WEBHOOK_SECRET` | Turns on `POST /api/admission/webhooks/email-events` for a mail provider's bounce and complaint reports. The sender signs the raw body with HMAC-SHA256 using this secret and sends the hex digest in the `X-Aksharum-Signature` header (optionally prefixed `sha256=`) — usually from a small relay in front of the mail provider. It also turns on `POST /api/admission/webhooks/email-events/<provider>?key=<the secret>[&school=<school id>]`, which takes the provider's **own** format — `sendgrid`, `ses` (through SNS; the subscription is confirmed automatically), `mailgun`, `postmark`, `brevo` — so it can be pasted into the provider's settings without a relay. Unset: both answer 404. |
| `ADMISSION_MAIL_PARALLEL` | How many admission emails are sent at once from the queue (default 3). |

A school's own SMTP is set in School settings; the module uses it when present.
Admissions → Emails → *Getting delivered* shows the do-not-send list (hard
bounces, complaints, and addresses the mail server refused outright) and checks
the sending domain's SPF, DKIM, DMARC and MX records. "Sent" in the log means
*accepted by the mail server* — not read, and not necessarily delivered.

### Online payments

Set per school in School settings → payment gateway (Razorpay), with the
admission module ticked. Refunds of online payments go through the same
gateway; the gateway's answer is recorded as it comes (a refused refund is
shown as refused). Payment links are signed with a key derived from
`JWT_SECRET` and work for seven days — **changing `JWT_SECRET` invalidates
every link already sent.**

### Where documents are kept

| Setting | Effect |
|---|---|
| unset | `uploads/admission-docs` on this server. Fine for one server with a persistent disk. |
| `ADMISSION_STORAGE=s3` + `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (`S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` for an S3-compatible store) | A private bucket. Needed for more than one API server, or a server without a persistent disk. Files are always served through the API's own checks; the bucket is never public. |

Moving existing files: `node scripts/admissionFilesToS3.js` (dry run), then
`--commit`, then optionally `--commit --delete-local`. Safe to run again.

### Virus scanning of uploads

| Setting | Effect |
|---|---|
| `CLAMAV_HOST` (`CLAMAV_PORT`, default 3310) | Every upload is scanned by ClamAV's daemon (INSTREAM) before it is kept; an infected file is refused and nothing is stored. |
| `CLAMAV_REQUIRED=true` | While clamd cannot be reached, uploads are refused. Otherwise they are kept and marked *not virus-scanned* for the office to see. |
| `CLAMAV_TIMEOUT_MS` | Default 15000. |

A simple way to run clamd: the official `clamav/clamav` container, port 3310.

### "Not a robot" check

| Setting | Effect |
|---|---|
| `CAPTCHA_PROVIDER=turnstile` or `hcaptcha`, `CAPTCHA_SITE_KEY`, `CAPTCHA_SECRET` | The portal asks for the check when creating an account, asking for a password reset, and sending an enquiry. If the provider cannot be reached, the form is refused (a check skipped on failure would be no check). |

Each school can switch it off for its own portal (Admissions → Settings →
*Numbers & security*). If a Content-Security-Policy is ever added to the web
app, allow `challenges.cloudflare.com` (Turnstile) or `js.hcaptcha.com`
(hCaptcha).

### DigiLocker

Needs the platform to be a registered DigiLocker partner (MeriPehchaan).

| Setting | Effect |
|---|---|
| `DIGILOCKER_CLIENT_ID`, `DIGILOCKER_CLIENT_SECRET`, `DIGILOCKER_REDIRECT_URI` | Turns on "Fetch from DigiLocker". The redirect URI registered with DigiLocker must be the API's `/api/admission/digilocker/callback`. |
| `DIGILOCKER_BASE_URL` | Default `https://digilocker.meripehchaan.gov.in/public/oauth2`. |
| `APP_SCHEME` | The phone app's link scheme (its `app.json` "scheme"), default `aksharum`. A DigiLocker connection started in the app returns to `aksharum://…`; one started on the portal returns to the portal. |

A connection lasts thirty minutes; its access token is kept encrypted and
deleted when it ends. Fetched documents go through the upload's own checks
and carry their issuer. Schools choose (Admissions → Settings →
*Applications*) whether to offer it, and whether fetched documents count as
verified — off by default.

### PIN codes

PIN lookups (every address form in the ERP, and the admission form's
auto-fill) read, in order: the PIN directory in the database, India Post's
public lookup, then a state guess from the PIN's first digits where those
digits belong to one state only. To load the directory, download *All India
Pincode Directory* from data.gov.in and run
`node scripts/importPincodes.js <file.csv>` (check), then `--commit`.

### Behind a proxy

`TRUST_PROXY_HOPS` must equal the number of proxies in front of the API
(default 1). Rate limits key on the visitor's address, so a wrong value either
lumps every visitor together or lets one visitor pretend to be many. Check it
from the super-admin account: `GET /api/super-admin/diagnostics/request`
shows the address the server sees.

`RL_ADMISSION_WINDOW` / `RL_ADMISSION_MAX` tune the portal's sign-in limits
(default 20 per address per minute).

---

## 3. What a school's admin switches on

Everything below is per school, in the admission office, with nothing to
deploy:

- **Settings** — portal (address, branding, privacy notice), workflow, forms,
  fees and waivers, numbering, RTE compliance, DigiLocker, the robot check.
- **Privacy & cookies** (School settings) — the cookie banner and policy.
- **Visits** — campus visit times and booking rules.
- **Appeals** — re-check and appeal windows and answer time.
- **Rounds** — seats, quotas, instalment plans.
- **Exams** — timed sections, questions drawn per candidate, retake rule,
  bookable interview times.

Groups of schools (one page for several branches, `/g/<address>`) are set up
by the platform: Super admin → *Admission groups*. Each school then decides
whether it is listed (Admissions → *Branches*).

---

## 4. Background jobs and the health card

The jobs run on the primary worker only (`utils/primaryWorker`):

| Job | Every | Does |
|---|---|---|
| `sweep.minute` | minute | submits online exams whose time is up, publishes scheduled lists and results, lapses unanswered offers, closes exams whose time is over, checks unfinished online payments and pending refunds with the gateway, sends queued emails and retries failed ones |
| `exports.worker` | minute | prepares exports asked for in the background; deletes them after a day |
| `sweep.reminders` | 10 minutes | exam, fee, instalment (before and once after the date), offer-lapse, draft and document reminders, and visit reminders; enquiry follow-ups; stage digests and the office's daily summary (after 9 am); the daily retention purge; deletes day-old sign-up codes; rescans files kept while the virus scanner was down; ends old DigiLocker sessions |

Each run is recorded (`admissionjobruns`, kept seven days). Admissions →
Dashboard → *How it is running* shows when each job last worked, its last
error, the last day's email counts, and which optional services
are on. A job that has not worked for twice its interval shows as **late** —
usually the primary worker is down.

`GET /health/ready` answers 200 only once the database schema is in place;
use it for load-balancer and CI readiness (plain `/health` answers as soon as
the process is up).

---

## 5. Tests and CI

`npm run test:admission` (Postgres and Redis running; it builds and removes
its own scratch schools). `.github/workflows/deploy.yml` runs it against
Postgres 18 and Redis 7 before every deploy; a failure stops the deploy.

---

## 6. Data protection

### Requests from families

Families download everything held about them, and ask for a correction,
erasure, withdrawal of consent or a grievance, from the portal's *Your data*
page. The office answers under Admissions → *Privacy* within the school's set
time (at most 90 days, the longest the DPDP Rules allow for a grievance).
Erasure keeps what the law needs (an admitted student's record, payment
amounts) and removes the rest; an application on legal hold is never erased.

### What is recorded

Every reveal of a masked Aadhaar number, every export and every download of a
background export is in the access log (Admissions → Privacy → *Access log*).
Retention (Privacy → *Retention*) erases unsuccessful applications, old
drafts and enquiries after the school's periods, once a day.

### If personal data is breached

As the rules stood in October 2026 — confirm with counsel at the time:

1. **Contain it.** Rotate the exposed credentials (`JWT_SECRET` signs
   sessions and payment links; S3 keys; SMTP and provider keys). Switch off
   the affected feature if needed.
2. **CERT-In:** a cyber security incident is reported to CERT-In within six
   hours of noticing it (CERT-In Directions of 28 April 2022).
3. **Data Protection Board and families:** under the DPDP Rules 2025 (rule 7),
   each affected family and the Board are told without delay, and the Board
   receives a detailed report within 72 hours of becoming aware — what
   happened, what data, the likely consequences, what is being done.
4. **Find who was affected.** The access log, the email log and each
   application's history show who saw or received what, and when.
5. **Write it down** — what happened, when it was found, what was done.

---

## 7. Taking the module out

`node scripts/admissionRollback.js` reports what it would remove;
`--commit` drops the module's tables (listed in the script) in one
transaction. Students, parents and everything created at enrolment stay —
they are the school's records. Applicant sign-ins and uploaded files go only
with `--remove-applicant-accounts` / `--remove-files`.
