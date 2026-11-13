# Video Learning — operations and deployment

Rebuilt in November 2026 as a central, book-based library shared by every school:

```
Education board → Class → Subject → Book → Chapter → Videos
```

The **Super Admin** maintains the library. A **school** chooses its board, its subjects and the books each section follows. A **teacher** releases a whole book, a chapter or a single video to their own sections. A **student** watches what has been released to them in a controlled player, and the server keeps the record of watching.

---

## 1. Where the code is

| Part | Location |
|---|---|
| Models (21 tables, all `Lms*`) | `models/Lms*.js` |
| Indexes, foreign keys, one-time data copy | `db/migrate.js` → `lmsSteps()`, `ONCE` |
| Services | `services/lms/` |
| Storage providers | `services/lms/providers/` (`local`, `s3`, `embeds` = Vimeo + YouTube, `index` = registry) |
| Controllers | `controllers/lms/` (`central`, `school`, `teacher`, `student`, `media`) |
| Routes | `routes/api/video.js` (mounted at `/api/video`) |
| Background clock | `services/lms/sweep.js`, started in `server.js` on the primary worker |
| Tests | `tests/video/` — `npm run test:video` |
| Web pages | `school-frontend/src/pages/videos/{central,school,teacher,student,player}` |
| Web API | `school-frontend/src/api/video.api.js` |
| Phone screens | `Nexora-Hives/app/modules/{videos,video-book,video-chapter,video-player,teacher-videos,admin-videos}.tsx` |

### Services

| File | Responsibility |
|---|---|
| `common.js` | query helper, table names, request reading, `handle()` error mapping, paging, audit writer, cache with change counters |
| `catalog.js` | boards, subjects and their board/class mappings, books, editions, chapters, video assets, chapter↔video mappings |
| `uploads.js` | chunked and direct uploads, resume, completion check |
| `jobs.js` | background processing of uploaded videos (claimed rows, retries) |
| `providers/*` | storage and playback per provider |
| `school.js` | a school's board, subjects, book assignments; book and chapter requests |
| `access.js` | who may see / release / watch what — the single definition of "released" |
| `releases.js` | teacher releases: create, edit, unpublish, publish, revoke, re-release |
| `tracking.js` | playback authorisation, watch sessions, heartbeats, completion |
| `student.js` | the student's screens (read-model) |
| `analytics.js` | teacher, school and platform reports; Excel/PDF exports |
| `notices.js` | notifications through `services/notifyService`, de-duplicated |
| `settings.js` | platform and per-school settings |
| `secrets.js` | AES-256-GCM sealing of provider credentials |
| `playbackToken.js` | the signed token inside a playback address |
| `hls.js` | per-viewer rewriting of HLS playlists |
| `mediaProbe.js` | reads a video's type and length from the file itself |
| `legacy.js` | one-time copy of the old flat library's videos |
| `sweep.js` | the module's clock |

---

## 2. Data model

All tables are created by `syncAll()` at boot (the app's usual mechanism). `db/migrate.js` adds what `syncAll()` cannot: partial unique indexes and foreign keys. Every step is idempotent and safe on every boot of every instance. **Nothing existing is dropped or altered.**

### Entities

```
LmsBoard ──< LmsSubjectMap >── LmsSubject
   │  (classLevels: the platform's own class numbers, utils/classLevels)
   └──< LmsBook >── LmsSubject
          │  editionGroup / previousEdition → LmsBook
          └──< LmsChapter ──< LmsChapterVideo >── LmsVideo ──< LmsUpload
                                                        └──< LmsJob
LmsProvider        (one row per provider; secrets sealed)
LmsSetting         ('platform' + one per school)

School ──< LmsSchoolConfig (school, academicYear → board)
       ──< LmsSchoolSubject (class → LmsSubject + the school's own Subject)
       ──< LmsBookAssignment (class, section|null → book; active | ended)
       ──< LmsRequest (book | chapter; status history)

LmsBookAssignment ──< LmsRelease (section; level book|chapter|video; audience; dates; status)
LmsChapterVideo   ──< LmsProgress (student × chapterVideo × academicYear)
LmsProgress       ──< LmsWatchSession ──< LmsHeartbeat
LmsAudit  (history of every change)     LmsNotice (one row per notification sent)
```

**Reused ERP entities, not duplicated:** schools, users, academic years, classes, sections (`ClassSection` and its roster `enrolledStudents`), subjects (`Subject`, `ClassSubject`), teacher ↔ section ↔ subject links (`SectionSubjectTeacher`), student profiles. A library "class" is the platform's class number (−3 Playgroup … 12 Class 12) that every school's `Class.classNumber` already carries — there is no second class master.

### Rules the database enforces (`lmsSteps()` in `db/migrate.js`)

| Rule | How |
|---|---|
| One live assignment of a book per class + section | partial unique index `ux_lmsbookassignments_live` |
| One open request per school for the same thing | partial unique index `ux_lmsrequests_open` |
| No duplicate live book (board, class, subject, title, edition, publisher) | `ux_lmsbooks_identity` |
| One provider takes uploads | `ux_lmsproviders_default` |
| One asset per Vimeo / YouTube video | `ux_lmsvideos_provider_asset` |
| One progress row per student, chapter video and year | unique index on `LmsProgress` |
| A heartbeat counts once | unique `(session, seq)` on `LmsHeartbeat` |
| Content that is used cannot be deleted | 25 foreign keys; books, chapters, mappings and videos referenced by assignments, releases or progress are `RESTRICT` |
| A chapter goes with its book, a heartbeat with its session | `CASCADE` |

References out to schools, users, classes and sections follow the app's existing no-foreign-key convention.

### Archival instead of deletion
- Boards, subjects, books, chapters, videos: **deactivate / archive**. Delete is refused (409 `IN_USE`) once anything uses them.
- Book assignments: **ended**, never deleted (`status`, `endedAt`, `endedBy`) — the history of what each section followed.
- Releases: **unpublished / revoked / expired**, never deleted. Open watch sessions are closed; progress is untouched.
- Chapter↔video mapping that was released or watched: **switched off**, not removed.
- Progress and watch sessions are never deleted. Raw heartbeats are pruned after the retention period; the totals they produced stay.

### The old module
The flat library of July 2026 (`videos`, `videotaxonomies`, `videoassignments`, `videoprogresses`, … ) is **left in place, untouched**. Its master videos are copied once into `lmsvideos` (`ONCE` in `db/migrate.js`, recorded in `datamigrations`). Its routes answer **410** with code `VIDEO_MODULE_UPDATED`; its web routes redirect to the new screens. Student Analytics now reads the new tables.

---

## 3. API (`/api/video`)

All JSON answers are `{ success, data, … }`; lists add `total, page, limit, pages`. Errors: 400 (validation), 401, 403 (`OUT_OF_SCOPE`, `NOT_RELEASED`, `MODULE_DISABLED` …), 404, 409 (`DUPLICATE`, `IN_USE`, `ALREADY_RELEASED`, `CONFIRM_BOARD_CHANGE` …), 410 (retired), 503 (`PROVIDER_NOT_CONFIGURED`).

### Super Admin — `/central` (role `super_admin`)
| Method | Path | |
|---|---|---|
| GET | `/meta`, `/overview`, `/audit` | reference data, platform figures, history |
| POST | `/images` | upload a cover / thumbnail picture |
| GET POST | `/boards` | list (search, status) / create |
| GET PUT DELETE | `/boards/:id` | detail with classes and subjects / edit / delete if unused |
| POST | `/boards/:id/active` | activate / deactivate |
| GET POST | `/subjects` | list (search, board, classLevel, status) / create with mappings |
| PUT DELETE | `/subjects/:id` | edit / delete if unused |
| PUT | `/subjects/:id/mappings` | where the subject is taught |
| GET POST | `/books` | list (board, classLevel, subject, status, search; paged) / create |
| GET PUT DELETE | `/books/:id` | detail (chapters, videos, editions, schools) / edit / delete if unused |
| POST | `/books/:id/status` | active / inactive / archived |
| POST | `/books/:id/editions` | new edition (copies chapters and mappings) |
| POST | `/books/:id/chapters` | add a chapter |
| PUT | `/books/:id/chapters/order` | reorder chapters |
| PUT DELETE | `/chapters/:id` | edit (incl. status) / delete if unused |
| POST | `/chapters/:id/videos` | map videos (ready + active only) |
| PUT | `/chapters/:id/videos/order` | reorder a chapter's videos |
| DELETE | `/mappings/:id` | unmap (switched off instead when used) |
| GET POST | `/videos` | list (search, provider, processingStatus incl. `working`, subject, mapped, mappable, notInChapter) / create |
| POST | `/videos/lookup` | read a Vimeo / YouTube address |
| GET PUT DELETE | `/videos/:id` | detail with mappings / edit / delete if unused |
| POST | `/videos/:id/active` · `/preview` · `/process` | activate · short preview token · process again |
| POST | `/videos/:id/uploads` | start an upload |
| GET | `/uploads/:uploadId` | which parts have arrived (resume) |
| PUT | `/uploads/:uploadId/chunks/:index` | one part (`application/octet-stream`, ≤ 6 MB) |
| POST DELETE | `/uploads/:uploadId/complete` · `/uploads/:uploadId` | finish / cancel |
| GET | `/providers` | providers (never a secret) and playback settings |
| PUT POST | `/providers/:provider` · `/providers/:provider/check` | save · test the connection |
| PUT | `/settings` | completion threshold, heartbeat, timeouts, upload limit, retention |
| GET | `/requests`, `/requests/:id`, `/requests/:id/attachment` | school requests |
| POST | `/requests/:id/status` | move a request on (school is notified) |

### School Admin — `/school` (school admin, or a teacher with admin access to the module)
| Method | Path | |
|---|---|---|
| GET | `/setup?academicYear=` | board, classes, sections, subjects, books |
| PUT | `/board` | `{ academicYear, board, confirm? }` |
| PUT | `/classes/:classId/subjects` | `{ subjects: [{ lmsSubject, schoolSubject }] }` |
| GET | `/classes/:classId/books?subject=` | library books the class may choose |
| PUT | `/books/assignment` | `{ class, book, sections: 'all' | [ids] | 'none' }` |
| GET | `/assignments/history` | live and ended assignments |
| GET POST | `/requests` | list / create (multipart with optional `file`) |
| GET DELETE | `/requests/:id` | detail / withdraw while pending |
| GET | `/requests/:id/attachment` | |
| GET PUT | `/settings` | notification choices, reminder days |
| GET | `/analytics`, `/analytics/students`, `/audit` | school figures, student list, history |

### Teacher — `/teacher`
| Method | Path | |
|---|---|---|
| GET | `/workspace` | the teacher's sections and books |
| GET | `/books/:id?section=` | chapters, videos and what is released, for one section |
| GET | `/sections/:id/students` | roster (to choose students) |
| GET POST | `/releases` | list (`tab=active|scheduled|history`, section, book, level) / create |
| GET PUT | `/releases/:id` | detail with history / edit |
| POST | `/releases/:id/unpublish` · `/publish` · `/revoke` · `/rerelease` | |
| GET | `/analytics`, `/analytics/students`, `/analytics/students/:id` | dashboard, list, one student |
| GET | `/analytics/export?format=xlsx|pdf`, `/analytics/students/:id/export?format=` | |

Release body: `{ book, level: 'book'|'chapter'|'video', chapter?, chapterVideo?, section | sections[], audience: 'all'|'selected', students?, releaseAt?, expiresAt?, note? }`.

### Student — `/student`
| Method | Path | |
|---|---|---|
| GET | `/home`, `/books/:id`, `/chapters/:id`, `/videos/:id`, `/history` | |
| POST | `/watch/:chapterVideoId/authorize` | opens a watch session, returns a playback address |
| POST | `/sessions/:id/heartbeat` | `{ seq, positionSec, state: playing|paused|ended, elapsedSec? }` |
| POST | `/sessions/:id/renew` · `/sessions/:id/end` | |

### The bytes (signed playback token in the address)
`GET|HEAD /stream/:token` (local files, Range supported) · `GET /hls/:token/<playlist>.m3u8` (rewritten per viewer) · `GET /media/thumb/:id`.

---

## 4. Video providers

Configure under **Video Library › Providers**. Credentials typed there are sealed (AES-256-GCM) and never returned; an environment variable of the same purpose wins over a stored value. A provider that is switched off or incomplete makes uploads / playback answer **503 `PROVIDER_NOT_CONFIGURED`** with what is missing — nothing is ever simulated.

| Provider | Use | Upload | Playback |
|---|---|---|---|
| `local` (server disk) | development, a single server | chunked through the API into `uploads/lms-videos` (never served statically) | `/api/video/stream/<token>` |
| `s3` (S3 + CloudFront, optional MediaConvert) | production | browser PUTs straight to the private bucket with a 1-hour pre-signed address | CloudFront signed URL (or S3 pre-signed URL), HLS playlists rewritten per viewer |
| `vimeo` | protected content hosted on Vimeo | linked by address | Vimeo player driven by the app's controls |
| `youtube` | **only** unprotected content | linked by address | YouTube player driven by the app's controls; refused for `strict` videos |

Exactly one file provider takes new uploads (`Use for uploads`). On a fresh install `local` does.

### AWS set-up for `s3`
1. **Bucket** — Block all public access. CORS rule (needed for the browser's direct upload):
   ```json
   [{ "AllowedOrigins": ["https://app.aksharum.com"], "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3000 }]
   ```
   Add a lifecycle rule for `video-learning/*/hls/` if old transcodes should expire.
2. **IAM user** for the app (`VIDEO_S3_ACCESS_KEY_ID` / `VIDEO_S3_SECRET_ACCESS_KEY`):
   `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::<bucket>/video-learning/*`; with MediaConvert also `mediaconvert:CreateJob`, `mediaconvert:GetJob` and `iam:PassRole` on the MediaConvert role.
3. **CloudFront** (recommended) — origin = the bucket with Origin Access Control; **Restrict viewer access: trusted key groups**; create a public key + key group; give the app the key-pair id (`VIDEO_CF_KEY_PAIR_ID`), the private key PEM (`VIDEO_CF_PRIVATE_KEY`) and the domain (`VIDEO_CF_DOMAIN`). Without CloudFront the app uses short-lived S3 pre-signed URLs.
4. **MediaConvert** (optional) — a role MediaConvert can assume with read/write on the bucket (`VIDEO_MC_ROLE_ARN`). With it, uploads become a 720p/480p/360p HLS ladder and a thumbnail; without it the uploaded MP4 is streamed as it is.

### Environment variables (all optional unless using that provider)

| Variable | Purpose |
|---|---|
| `VIDEO_SECRETS_KEY` | key for sealing stored credentials (default: derived from `JWT_SECRET` — **set it in production** so rotating the JWT secret does not orphan stored credentials) |
| `VIDEO_SIGN_SECRET` | key for playback tokens (default: derived from `JWT_SECRET`) |
| `VIDEO_S3_BUCKET`, `VIDEO_S3_REGION`, `VIDEO_S3_PREFIX` | bucket, region (default `ap-south-1`), folder (default `video-learning`) |
| `VIDEO_S3_ACCESS_KEY_ID`, `VIDEO_S3_SECRET_ACCESS_KEY` | credentials |
| `VIDEO_S3_ENDPOINT`, `VIDEO_S3_FORCE_PATH_STYLE` | S3-compatible stores (R2, MinIO …) |
| `VIDEO_CF_DOMAIN`, `VIDEO_CF_KEY_PAIR_ID`, `VIDEO_CF_PRIVATE_KEY` | CloudFront signing (PEM; `\n` escapes accepted) |
| `VIDEO_MC_ROLE_ARN`, `VIDEO_MC_ENDPOINT`, `VIDEO_MC_QUEUE` | MediaConvert |
| `VIDEO_VIMEO_TOKEN` | Vimeo API token (titles, lengths, thumbnails) |
| `VIDEO_YOUTUBE_API_KEY` | YouTube Data API key (lengths) |
| `VIDEO_EMBED_LOOKUP=off` | never call Vimeo/YouTube (offline servers, tests) |
| `RL_VL_BEAT_MAX`, `RL_VL_PLAY_MAX`, `RL_VL_WRITE_MAX` | per-person limits per minute (heartbeats 60, opening videos 30, changes 120) |
| `EXPO_PUBLIC_WEB_URL` (phone app) | web app address the phone opens videos on (default `https://app.aksharum.com`) |

Web app: no new variables. New dependency: `hls.js` (loaded only when a browser cannot play HLS itself).

---

## 5. Deployment

1. Deploy the backend as usual. On first boot `syncAll()` creates the 21 tables, `runMigrations()` adds indexes and keys, and the one-time step copies the old master videos. `/health/ready` turns 200 when that is done.
2. Rebuild and deploy the web app (`npm ci && npm run build` in `school-frontend` — `hls.js` is new).
3. Set `VIDEO_SECRETS_KEY` and, for production video, configure **S3** (section 4) and make it the upload provider. `local` keeps files on one server's disk and is unsuitable behind a load balancer.
4. nginx in front of the API: allow request bodies of at least **6 MB** for `PUT /api/video/central/uploads/*/chunks/*` (`client_max_body_size 8m;`), and do not buffer `/api/video/stream/` (`proxy_buffering off;`) so range requests stream.
5. Turn the module on for a school (Super Admin › Schools › modules: Video Learning) as before.

### Background worker
`services/lms/sweep.js`, started in `server.js` only on the primary worker (`NODE_APP_INSTANCE` unset or `0`):

| Every | Work |
|---|---|
| 15 s | claim and run due video-processing jobs (`FOR UPDATE SKIP LOCKED`, retries with back-off, stuck jobs re-claimed after 15 min) |
| 1 min | open scheduled releases that came due and notify their students; mark expired releases and close their sessions; close idle watch sessions |
| 1 h | reminders for released content not started (school's day count); expire unfinished uploads; prune raw heartbeats |

Access never waits for this clock — a release opens and closes by its own dates the moment a student asks.

---

## 6. Security

- **Backend authorisation on every call.** School, class, section, student and teacher ids in a request are looked up inside the signed-in user's own school and role scope; another school's id is simply "not found". Teachers act only where `SectionSubjectTeacher` says they teach the book's subject; students see only what live releases of their **current** section give them (the roster, re-read on every request).
- **Playback.** No permanent or public address is ever given out. A student receives a signed token bound to a watch session; every byte range and playlist request re-checks the token and that the session is open and recently heard from. Revoking, unpublishing, expiring, a section change or opening the video elsewhere closes the session — the very next request fails. S3 objects are private; CloudFront / S3 URLs expire in minutes; HLS segment URLs are signed per viewer.
- **Tracking is server-side.** The furthest point watched advances only by continuous play the server's own clock can account for (at most wall time since the previous heartbeat, plus a small jitter allowance that cannot accumulate). Duplicate or late heartbeats (same or lower `seq`) count once; paused time and faster playback earn nothing; a forward seek is refused and the player sent back. Completion needs `furthestSec ≥ threshold × length`.
- **Credentials** are sealed at rest, never returned by an API, never written to the audit log; signed URLs are not logged.
- **Uploads** are checked for extension, MIME type, size limit, the declared size on completion, and the file's own signature (MP4/MOV/WebM) before a video can become ready.
- **Rate limits** per person on heartbeats, opening videos and writes; heartbeats and byte ranges are exempt from the global per-address limit so a classroom behind one address is not throttled.
- **Audit**: every change to the library, a school's set-up, requests and releases is in `lmsaudits`.

### What this does not do
No browser-based player can stop screen recording, a camera pointed at the screen, or a determined user capturing the decoded stream. The controls here (no download, no speed change, no forward seek, no picture-in-picture, signed short-lived addresses) raise the effort and keep the **record** honest; they are not copy protection.

**DRM is not implemented.** For studio-grade protection: package the HLS ladder with MediaConvert's SPEKE integration (Widevine + FairPlay + PlayReady) through a licence provider (AWS Elemental partner, PallyCon, EZDRM, Axinom), and swap the web `htmlEngine` for a DRM-capable player (Shaka Player or hls.js with EME configuration) — the provider abstraction already isolates both changes to `providers/s3.js` and `player/RestrictedPlayer.jsx`.

---

## 7. Tests

`npm run test:video` — 70 tests in 6 files, each starting its own API on a free port (`NODE_APP_INSTANCE=1`, no background jobs) and removing its scratch schools, library rows and files at the end. Covers the 23 required scenarios plus tenancy, races (concurrent playback authorisation), caching, retired routes, and that no API answer contains a storage key or credential. `tests/video/units.test.js` checks the S3 signer against AWS's published example, CloudFront signatures against the key pair, playlist rewriting, file probing and token tampering.

---

## 8. Known limits and follow-ups

- **Phone playback.** The phone app has no in-app video player: one that enforces the seek/speed rules needs `expo-video` (or a WebView) and a new native build. Until then the phone shows books, chapters, progress and releases, and *Watch* opens the web player in the browser (sign-in required there once).
- **S3, CloudFront and MediaConvert** are implemented and unit-checked against AWS's published signing examples, but have **not been run against a live AWS account** in this environment. Use *Providers › Check* after configuring; then upload one video and confirm it reaches `ready` and plays.
- **Vimeo/YouTube** lookups were not exercised against the live services here (tests run with `VIDEO_EMBED_LOOKUP=off`).
- **DRM** — see section 6.
- **Parents** have no Video Learning screen (as before).
