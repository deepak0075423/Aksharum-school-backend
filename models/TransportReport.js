const db = require('../db/orm');

// A generated or scheduled transport report (the Reports screen).
//
// Two things live in one table because they are the same thing at different
// times: a row with `schedule.frequency` set is a standing instruction, and
// each time it fires it writes a row with `generatedAt` set. The screen shows
// the first list as "Scheduled Reports" and the second as "Recent Reports".
const TransportReportSchema = new db.Schema({
    school: { type: db.Types.UUID, ref: 'School', required: true, index: true },

    name: { type: String, required: true, trim: true },
    // Must match a key in reportBuilders (transportAdmin.controller.js) or the
    // report cannot be built — validated on create.
    reportType: {
        type: String,
        enum: ['trip_summary', 'route_performance', 'vehicle_utilization', 'fuel_consumption',
               'maintenance', 'incident', 'student_transport', 'fees_revenue', 'compliance'],
        required: true,
    },
    category: {
        type: String,
        enum: ['trips', 'fuel', 'maintenance', 'incidents', 'students', 'finance', 'compliance'],
        default: 'trips',
    },
    format: { type: String, enum: ['pdf', 'excel', 'csv'], default: 'pdf' },

    // The window the report covered / will cover.
    range: {
        preset: { type: String, default: 'last_30_days' },   // last_7_days | this_month | custom …
        from: { type: Date, default: null },
        to: { type: Date, default: null },
    },
    filters: { type: db.Types.JSON, default: {} },           // route / vehicle / status …

    // Set on a standing instruction only.
    schedule: {
        frequency: { type: String, enum: ['', 'daily', 'weekly', 'monthly'], default: '' },
        weekday: { type: Number, default: 1 },               // 0=Sun … 6=Sat (weekly)
        dayOfMonth: { type: Number, default: 1 },            // (monthly)
        recipients: { type: [String], default: [] },         // email addresses
        lastRunAt: { type: Date, default: null },
        nextRunAt: { type: Date, default: null },
    },
    status: { type: String, enum: ['active', 'paused', 'completed', 'failed', 'running'], default: 'completed' },

    // Set on a generated run only.
    generatedAt: { type: Date, default: null },
    generatedBy: { type: db.Types.UUID, ref: 'User', default: null },
    rowCount: { type: Number, default: 0 },
    // The rendered file is not kept on disk: a report is rebuilt from live data
    // on download, so an old link can never serve stale figures.
    summary: { type: db.Types.JSON, default: {} },
}, { timestamps: true });

TransportReportSchema.index({ school: 1, createdAt: -1 });

module.exports = db.model('TransportReport', TransportReportSchema);
