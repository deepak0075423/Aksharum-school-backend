# School Management System

A full-featured, multi-tenant school management application built with **Node.js**, **Express**, and **PostgreSQL**. It supports multiple schools on a single instance, with per-school module toggles controlled by a Super Admin.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [User Roles](#user-roles)
- [Module System](#module-system)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
- [Environment Variables](#environment-variables)
- [Database Setup](#database-setup)
- [Running the App](#running-the-app)
- [First Login Flow](#first-login-flow)
- [Default Credentials](#default-credentials)

---

## Features

| Module | Description |
|---|---|
| **Multi-School** | Single instance hosts multiple schools; each school is isolated |
| **User Management** | Create/manage school admins, teachers, students, and parents |
| **Attendance** | Daily student attendance, teacher attendance, corrections & regularization |
| **Timetable** | Class-wise timetable builder with section/subject/teacher assignment |
| **Results & Assessments** | Formal exam results, class test marks, multi-level approval workflow |
| **Aptitude Exams** | Online timed exams with anti-cheat, analytics, and approval workflow |
| **Holiday Management** | School holiday calendar with CSV import/export, notifications, and audit log |
| **Notifications** | Real-time notifications via SSE, bell icon, browser push, and email |
| **Reports** | Downloadable PDF/XLSX reports for results and attendance |
| **Profile Management** | Profile images, qualification, contact details for all roles |
| **Dashboard Calendar** | Mini monthly calendar on every dashboard with upcoming holidays |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (CommonJS) |
| Framework | Express 5 |
| Database | PostgreSQL (via the `pg` driver + in-house data mapper in `db/`) |
| Cache / Pub-Sub | Redis (auth cache, rate limiting, chat pub/sub) |
| Auth | JWT access + refresh tokens (magic login links) |
| Email | Nodemailer (SMTP / Gmail) |
| File Uploads | Multer |
| Import/Export | xlsx (Excel), PDFKit (PDF) |
| Password Hashing | bcryptjs |
| Dev Server | nodemon |

---

## User Roles

```
super_admin
    └── Creates and manages schools + school admins
        └── school_admin
                └── Creates teachers, students, parents; manages all school data
                    ├── teacher      — Classroom management, attendance, marks entry
                    ├── student      — Views own timetable, results, attendance
                    └── parent       — Views child's results, attendance, holidays
```

Each role has a dedicated dashboard, route group, and navigation menu. Module access is gated per-school by the super admin.

---

## Module System

Every school starts with **all modules disabled**. The super admin enables them individually per school via **Super Admin → Module Permissions**.

| Module Key | What it unlocks |
|---|---|
| `attendance` | Attendance marking, correction, analytics |
| `notification` | Bell icon, real-time SSE notifications, email alerts |
| `aptitudeExam` | Online exam builder and proctoring |
| `result` | Formal exam & class test results with approval workflow |
| `timetable` | Timetable builder and viewer |
| `holiday` | Holiday calendar, import/export, dashboard widget |

---

## Project Structure

```
school-2.0/
├── app.js                  # Express app setup, middleware, routes
├── server.js               # HTTP server entry point
├── .env                    # Environment variables (create from .env.example)
│
├── config/
│   ├── db.js               # PostgreSQL connection + schema sync
│   └── mailer.js           # Nodemailer transporter
│
├── controllers/            # Business logic (one file per role/module)
│   ├── adminController.js
│   ├── teacherController.js
│   ├── studentController.js
│   ├── parentController.js
│   ├── superAdminController.js
│   ├── holidayController.js
│   ├── attendanceController.js
│   ├── timetableController.js
│   └── ...
│
├── middleware/
│   ├── auth.js             # isAuthenticated, requireRole, loadUser
│   ├── requireModule.js    # Per-school module gate
│   ├── upload.js           # Multer (images)
│   └── uploadCsv.js        # Multer (CSV/XLSX)
│
├── models/                 # Schema definitions (PostgreSQL-backed)
│   ├── User.js
│   ├── School.js           # Includes modules feature flags
│   ├── Holiday.js
│   ├── Attendance.js
│   ├── Timetable.js
│   ├── FormalExam.js
│   └── ...
│
├── routes/                 # Express routers (one per role)
│   ├── auth.js
│   ├── admin.js
│   ├── teacher.js
│   ├── student.js
│   ├── parent.js
│   ├── superAdmin.js
│   ├── profile.js
│   └── notifications.js
│
├── views/                  # EJS templates
│   ├── layouts/main.ejs    # Base layout (sidebar, topbar, notifications)
│   ├── partials/           # Shared partials (dashboard-calendar, etc.)
│   ├── admin/
│   ├── teacher/
│   ├── student/
│   ├── parent/
│   ├── superAdmin/
│   └── auth/
│
├── public/
│   ├── css/style.css
│   ├── js/main.js
│   └── images/
│
├── utils/
│   ├── generatePassword.js
│   ├── sendEmail.js
│   └── sseClients.js       # Server-sent events for real-time notifications
│
└── scripts/
    └── seed.js             # Creates the initial Super Admin account
```

---

## Prerequisites

Make sure the following are installed on your machine:

| Tool | Minimum Version | Download |
|---|---|---|
| Node.js | v18.x or later | https://nodejs.org |
| npm | v9.x or later | Included with Node.js |
| PostgreSQL | v14.x or later | https://www.postgresql.org/download/ |
| Redis | v6.x or later | https://redis.io/download |
| Git | Any recent version | https://git-scm.com |

> A managed PostgreSQL instance (RDS, Cloud SQL, Supabase, etc.) can be used instead of a local installation — just point `DATABASE_URL` at it. See [Database Setup](#database-setup).

---

## Installation & Setup

### 1. Clone the repository

```bash
git clone https://github.com/your-username/school-management-system.git
cd school-management-system
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create the environment file

Copy the example below into a new file named `.env` in the project root:

```bash
cp .env.example .env   # if the example file exists, otherwise create manually
```

Then edit `.env` with your own values — see [Environment Variables](#environment-variables) for details.

### 4. Set up the database

See [Database Setup](#database-setup) below.

### 5. Seed the Super Admin account

```bash
npm run seed
```

This creates the first super admin account. You will see the credentials printed in the terminal.

### 6. Start the server

```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

The app will be available at **http://localhost:3000** (or whatever `PORT` you set in `.env`).

---

## Environment Variables

Create a `.env` file in the project root with the following keys:

```env
# ── Server ─────────────────────────────────────────────────
PORT=5000
APP_URL=http://localhost:3000
APP_NAME=School Management System

# ── PostgreSQL ─────────────────────────────────────────────
# Local Postgres
DATABASE_URL=postgres://erp_user:password@localhost:5432/aksharum_erp

# OR a managed instance (replace with your connection string)
# DATABASE_URL=postgres://user:pass@your-db-host:5432/aksharum_erp

# ── Redis (cache / rate limiting / chat pub-sub) ───────────
REDIS_URL=redis://localhost:6379

# ── JWT ────────────────────────────────────────────────────
# Use long, random strings in production (min 32 characters)
JWT_SECRET=change_this_to_a_long_random_string
JWT_REFRESH_SECRET=change_this_to_another_long_random_string

# ── Email / SMTP ───────────────────────────────────────────
# Gmail example (requires an App Password — not your login password)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_gmail@gmail.com
SMTP_PASS=your_16_char_app_password
EMAIL_FROM=School Management <your_gmail@gmail.com>
```

### Generating a Gmail App Password

1. Go to your Google Account → **Security**
2. Enable **2-Step Verification** (required)
3. Go to **Security → App Passwords**
4. Select app: **Mail**, device: **Other** → name it "School App"
5. Copy the 16-character password into `SMTP_PASS`

### Generating secure secrets

```bash
# Linux / macOS
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Run twice — once for JWT_SECRET, once for JWT_REFRESH_SECRET
```

---

## Database Setup

### Option A — Local PostgreSQL

1. **Install PostgreSQL** from https://www.postgresql.org/download/

2. **Start the PostgreSQL service:**

   ```bash
   # macOS (Homebrew)
   brew services start postgresql

   # Ubuntu / Debian
   sudo systemctl start postgresql
   sudo systemctl enable postgresql   # auto-start on boot

   # Windows
   # PostgreSQL runs as a Windows Service automatically after installation
   ```

3. **Create the database, role, and required extension:**

   ```bash
   sudo -u postgres psql <<'SQL'
   CREATE ROLE erp_user WITH LOGIN PASSWORD 'password';
   CREATE DATABASE aksharum_erp OWNER erp_user;
   \c aksharum_erp
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   GRANT ALL ON SCHEMA public TO erp_user;
   SQL
   ```

4. Set `DATABASE_URL=postgres://erp_user:password@localhost:5432/aksharum_erp` in your `.env`.

   > All tables and indexes are created automatically on first boot (`config/db.js` → `orm.syncAll()` runs `CREATE TABLE IF NOT EXISTS` for every model) — no manual migrations needed.

### Option B — Managed PostgreSQL (Cloud)

1. Provision a PostgreSQL instance on your provider (RDS, Cloud SQL, Supabase, Neon, etc.).
2. Create a database (e.g. `aksharum_erp`) and a user with read/write access.
3. Enable the `pg_trgm` extension on that database (`CREATE EXTENSION IF NOT EXISTS pg_trgm;`).
4. Allow your server's IP in the instance's network/firewall rules.
5. Copy the connection string into your `.env`:

   ```env
   DATABASE_URL=postgres://myuser:mypassword@your-db-host:5432/aksharum_erp
   ```

---

## Running the App

| Command | Description |
|---|---|
| `npm run dev` | Start with nodemon (development, auto-restart) |
| `npm start` | Start with plain Node.js (production) |
| `npm run seed` | Create the Super Admin account (run once) |

---

## First Login Flow

```
1. Run:  npm run seed
         → Prints email & temporary password

2. Open: http://localhost:3000/auth/login
         → Log in with the seeded credentials

3. You are redirected to /auth/reset-password
         → Set a new permanent password (required on first login)

4. As Super Admin you can now:
         a. Create a School  (Super Admin → Schools → Add School)
         b. Create a School Admin for that school
         c. Enable modules for that school (Super Admin → Module Permissions)

5. Log in as School Admin to:
         a. Create Teachers, Students, Parents
         b. Set up Classes, Sections, Subjects, Academic Years
         c. Manage Holidays, Timetable, Results, Exams (if modules are enabled)
```

---

## Default Credentials

After running `npm run seed`:

| Field | Value |
|---|---|
| Email | `admin@aksharum.com` |
| Password | `05102001DP@` |
| Role | Super Admin |

> **You will be forced to change this password on first login.**
> All other users (school admins, teachers, students, parents) are created through the application UI by the super admin or school admin. They receive a system-generated password via email and must also reset it on first login.

---

## Key URLs

| URL | Description |
|---|---|
| `GET /` | Redirects to login or role dashboard |
| `GET /auth/login` | Login page |
| `GET /super-admin/dashboard` | Super Admin dashboard |
| `GET /admin/dashboard` | School Admin dashboard |
| `GET /teacher/dashboard` | Teacher dashboard |
| `GET /student/dashboard` | Student dashboard |
| `GET /parent/dashboard` | Parent dashboard |
| `GET /super-admin/permissions` | Enable/disable per-school modules |
| `GET /admin/holidays` | Holiday management (requires holiday module) |
| `GET /notifications/sse` | Server-sent events stream for real-time notifications |

---

## Notes

- **Auth** is stateless (JWT access + refresh tokens); Redis is used for the auth cache, rate limiting, and chat pub/sub.
- **File uploads** (profile images, CSV imports) are stored in `public/uploads/`. Ensure this directory is writable.
- The seed script is **idempotent** — running it again when a super admin already exists will print the existing email and exit without making changes.
- All passwords are hashed with **bcrypt** (12 salt rounds). Plain-text passwords are never stored.
