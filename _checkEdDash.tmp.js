// Calls the real getDashboard handler with a stubbed school_admin request, so
// the new overview fields are checked against live data, not assumed.
require('dotenv').config();
const db = require('./db/orm');
const School = require('./models/School');
const User   = require('./models/User');
const ctrl   = require('./controllers/employeeDirectory.controller');

(async () => {
  await db.connect();
  const school = await School.findOne({}).select('_id name').lean();
  const admin  = await User.findOne({ school: school._id, role: 'school_admin' }).select('_id').lean();

  const req = { schoolId: String(school._id), userId: String(admin._id), userRole: 'school_admin', query: {} };
  const res = {
    status() { return this; },
    json(body) {
      const d = body.data || body;
      console.log('academicYear     :', d.academicYear, '| starts', d.academicYearStart);
      console.log('totals           :', JSON.stringify(d.totals));
      console.log('growthPct        :', d.growthPct);
      console.log('completionBuckets:', JSON.stringify(d.completionBuckets),
                  '| sums to', Object.values(d.completionBuckets).reduce((a, b) => a + b, 0),
                  '| employees', d.totals.employees);
      console.log('byDepartment     :', JSON.stringify(d.byDepartment));
      console.log('recentEmployees  :');
      for (const e of d.recentEmployees) {
        console.log(`   ${String(e.name).padEnd(14)} ${String(e.designation || '—').padEnd(16)}`
          + `${String(e.department || '—').padEnd(14)} ${String(e.joiningDate).slice(0, 10)}  ${e.employmentStatus}`);
      }
    },
  };
  await ctrl.getDashboard(req, res);
  await db.disconnect();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
