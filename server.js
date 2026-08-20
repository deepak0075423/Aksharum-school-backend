'use strict';
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = require('crypto').webcrypto;
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const path     = require('path');
const connectDB = require('./config/db');
const { isPrimaryWorker } = require('./utils/primaryWorker');
const { rateLimit } = require('./middleware/rateLimit');

connectDB();

const app = express();

// Disable ETag so API responses always return 200 (never 304 from cache)
app.set('etag', false);

// ── Security & Parsing ────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
// app.use(cors({
//     origin: process.env.FRONTEND_URL || 'http://localhost:3000',
//     credentials: true,
//     methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//     allowedHeaders: ['Content-Type', 'Authorization'],
// }));
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8081',
  'http://13.50.231.82:3000/',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {

    // allow requests with no origin
    // (mobile apps, postman, curl)
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },

  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));

// No-cache for all /api routes — prevents stale responses after schema changes
app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust the reverse proxy so req.ip / X-Forwarded-For reflect the real client
// (nginx / load balancer sits in front in production).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);

// ── Rate limiting (Redis-backed, shared across cluster workers; fails open) ────
// Generous global guard against a single abusive client / retry storm, plus a
// tighter bucket on auth endpoints to blunt credential-stuffing. All env-tunable.
app.use('/api', rateLimit({
    prefix: 'api',
    windowSec: Number(process.env.RL_API_WINDOW) || 60,
    max:       Number(process.env.RL_API_MAX)    || 1200,
}));
// Tighter bucket on the brute-forceable, UNauthenticated surface only (login /
// OTP / password-reset / magic-link). Deliberately excludes /refresh and /me —
// those scale with user count and would false-positive for a whole school behind
// one NAT'd office IP; they ride the generous global limiter above.
const authLimiter = rateLimit({
    prefix: 'auth',
    windowSec: Number(process.env.RL_AUTH_WINDOW) || 60,
    max:       Number(process.env.RL_AUTH_MAX)    || 60,
});
for (const p of ['/api/auth/login', '/api/auth/forgot-password', '/api/auth/verify-otp', '/api/auth/new-password', '/api/auth/magic']) {
    app.use(p, authLimiter);
}

// ── Static Files (uploads) ────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/api/auth'));
app.use('/api/super-admin',   require('./routes/api/superAdmin'));
app.use('/api/admin',         require('./routes/api/admin'));
app.use('/api/teacher',       require('./routes/api/teacher'));
app.use('/api/student',       require('./routes/api/student'));
app.use('/api/parent',        require('./routes/api/parent'));
app.use('/api/fees',          require('./routes/api/fees'));
app.use('/api/payroll',       require('./routes/api/payroll'));
app.use('/api/library',       require('./routes/api/library'));
app.use('/api/inventory',     require('./routes/api/inventory'));
app.use('/api/transport',     require('./routes/api/transport'));
app.use('/api/hostel',        require('./routes/api/hostel'));
app.use('/api/video',         require('./routes/api/video'));
app.use('/api/feedback',      require('./routes/api/feedback'));
app.use('/api/analytics',     require('./routes/api/analytics'));
app.use('/api/employee-directory', require('./routes/api/employeeDirectory'));
app.use('/api/chat',          require('./routes/api/chat'));
app.use('/api/notifications', require('./routes/api/notifications'));
app.use('/api/profile',       require('./routes/api/profile'));
app.use('/internal',          require('./routes/api/internal'));

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || 500;
    res.status(status).json({
        success: false,
        message: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ── Background singletons ─────────────────────────────────────────────────────
// Under PM2 cluster mode these must run on ONE worker only (see utils/primaryWorker).
// The chat broker is a Redis consumer — N subscribers would each process every
// message (N-fold duplicates); the accrual timer would fire N times. Guarding
// both here is what makes multi-worker cluster mode safe.
if (isPrimaryWorker) {
    // ── Chat broker (Redis pub/sub ⇄ WebSocket Gateway) ──────────────────────
    require('./services/chatBrokerService').init();

    // ── Monthly Leave Accrual Scheduler ──────────────────────────────────────
    (function scheduleMonthlyAccrual() {
    const School     = require('./models/School');
    const { runMonthlyAccrualForSchool } = require('./controllers/leave.controller');
    let lastRunMonth = '';

    setInterval(async () => {
        const now        = new Date();
        const thisMonth  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        if (lastRunMonth === thisMonth) return;
        lastRunMonth = thisMonth;
        try {
            const schools = await School.find({ 'modules.leave': true }).select('_id').lean();
            let total = 0;
            for (const s of schools) total += await runMonthlyAccrualForSchool(s._id);
            if (total > 0) console.log(`[Leave] Monthly accrual: ${total} balance(s) updated across ${schools.length} school(s)`);
        } catch (err) {
            console.error('[Leave] Monthly accrual error:', err.message);
        }
    }, 60 * 60 * 1000); // check every hour; fires for real on 1st of each month
    }());

    // ── Comp Off expiry clock ────────────────────────────────────────────────
    // Lapses comp off that outlived its validity window and sends the
    // "expiring soon" nudge. Both steps are idempotent — an expired lot has no
    // remaining days to expire twice, and a notified request carries a
    // expiryNotifiedAt stamp — so a restart mid-sweep changes nothing.
    (function scheduleCompOffExpiry() {
        const School = require('./models/School');
        const compOff = require('./services/compOffService');
        const tick = async () => {
            try {
                const schools = await School.find({ 'modules.leave': true }).select('_id').lean();
                let expired = 0, notified = 0;
                for (const s of schools) {
                    const a = await compOff.runExpirySweep(s._id);
                    const b = await compOff.runExpiryNotifications(s._id);
                    expired  += a.expired  || 0;
                    notified += b.notified || 0;
                }
                if (expired || notified) {
                    console.log(`[CompOff] expiry: ${expired} day(s) lapsed, ${notified} reminder(s) sent across ${schools.length} school(s)`);
                }
            } catch (err) { console.error('[CompOff] expiry sweep error:', err.message); }
        };
        setTimeout(tick, 60 * 1000);          // once shortly after boot
        setInterval(tick, 6 * 60 * 60 * 1000); // then every 6 hours
    }());

    // ── Feedback campaign clock ───────────────────────────────────────────────
    // Flips scheduled campaigns live on their start date, closes them when the
    // window ends, and fires the reminder / closing-soon nudges. Every step is
    // idempotent by date+state, so a restart mid-sweep changes nothing.
    (function scheduleFeedbackCampaigns() {
        const { runCampaignSchedule } = require('./controllers/feedback.controller');
        const tick = async () => {
            try {
                const r = await runCampaignSchedule();
                if (r.activated || r.closed || r.reminded || r.closingSoon) {
                    console.log(`[Feedback] campaigns: ${r.activated} activated, ${r.closed} closed, ${r.reminded} reminded, ${r.closingSoon} closing-soon`);
                }
            } catch (err) { console.error('[Feedback] campaign schedule error:', err.message); }
        };
        setTimeout(tick, 30 * 1000);          // once shortly after boot
        setInterval(tick, 30 * 60 * 1000);    // then every 30 minutes
    }());

    // ── Hostel overdue & SLA clock ────────────────────────────────────────────
    // Flips outpasses/leaves whose return time has passed to 'overdue' and
    // escalates complaints that breached their SLA. Both steps are idempotent
    // (an overdue row is already overdue; an escalated complaint has its due
    // date pushed with the level), so a restart mid-sweep changes nothing.
    (function scheduleHostelSweep() {
        const School = require('./models/School');
        const hostel = require('./controllers/hostel.controller');
        const tick = async () => {
            try {
                const schools = await School.find({ 'modules.hostel': true }).select('_id').lean();
                let overdue = 0;
                for (const s of schools) {
                    const r = await hostel.sweepOverdue(s._id);
                    overdue += (r.outpasses || 0) + (r.leaves || 0);
                }
                if (overdue > 0) console.log(`[Hostel] overdue sweep: ${overdue} record(s) across ${schools.length} school(s)`);
            } catch (err) { console.error('[Hostel] overdue sweep error:', err.message); }
        };
        setTimeout(tick, 90 * 1000);           // once shortly after boot
        setInterval(tick, 30 * 60 * 1000);     // then every 30 minutes
    }());

    // ── Library clock ─────────────────────────────────────────────────────────
    // Two things in the library happen because time passed, not because anyone
    // clicked: a loan falls overdue and an uncollected hold lapses. Both used to
    // wait for someone to open a library page, which made fines observer-
    // dependent and left a no-show's hold blocking a copy indefinitely — and
    // made due-date reminders impossible, since no library code ran before the
    // due date. Every step is idempotent (an overdue loan is already overdue, a
    // reminder carries the due date it was sent for), so a restart mid-sweep
    // changes nothing. The read paths still run the same sweeps, so a stopped
    // worker degrades rather than breaks.
    (function scheduleLibrarySweep() {
        const School = require('./models/School');
        const library = require('./services/libraryRules');
        let lastPrune = '';
        const tick = async () => {
            try {
                const schools = await School.find({ 'modules.library': true }).select('_id').lean();
                let overdue = 0, lapsed = 0, nudged = 0;
                for (const s of schools) {
                    const r = await library.runLibrarySweep(s._id);
                    overdue += r.overdue; lapsed += r.lapsed; nudged += r.nudged;
                }
                if (overdue || lapsed || nudged) {
                    console.log(`[Library] sweep: ${overdue} overdue, ${lapsed} hold(s) lapsed, ${nudged} reminder(s) across ${schools.length} school(s)`);
                }

                // Audit retention, once a day rather than every tick.
                const today = new Date().toISOString().slice(0, 10);
                if (lastPrune !== today) {
                    lastPrune = today;
                    let pruned = 0;
                    for (const s of schools) pruned += await library.pruneAuditLog(s._id);
                    if (pruned) console.log(`[Library] audit retention: ${pruned} row(s) pruned`);
                }
            } catch (err) { console.error('[Library] sweep error:', err.message); }
        };
        setTimeout(tick, 100 * 1000);          // once shortly after boot
        setInterval(tick, 30 * 60 * 1000);     // then every 30 minutes
    }());

    // ── Video scheduled-publish worker ────────────────────────────────────────
    // Flips master videos from 'scheduled' → 'published' once scheduledAt passes.
    (function scheduleVideoPublisher() {
        const Video = require('./models/Video');
        setInterval(async () => {
            try {
                const due = await Video.find(
                    { status: 'scheduled', scheduledAt: { $lte: new Date() }, isDeleted: false }, '_id',
                ).lean();
                if (due.length) {
                    await Video.updateMany(
                        { _id: { $in: due.map((v) => v._id) } },
                        { $set: { status: 'published', publishedAt: new Date(), scheduledAt: null } },
                    );
                    console.log(`[Video] Auto-published ${due.length} scheduled video(s)`);
                }
            } catch (err) { console.error('[Video] scheduled-publish error:', err.message); }
        }, 60 * 1000); // check every minute
    }());
}
