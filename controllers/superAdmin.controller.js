'use strict';
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const XLSX    = require('xlsx');
const School       = require('../models/School');
const User         = require('../models/User');
const TeacherProfile  = require('../models/TeacherProfile');
const StudentProfile  = require('../models/StudentProfile');
const ParentProfile   = require('../models/ParentProfile');
const ClassSection    = require('../models/ClassSection');
const Class           = require('../models/Class');
const AcademicYear    = require('../models/AcademicYear');
const mailer  = require('../config/mailer');
const { sendSchoolMail, emailHeaderHtml, getMailContext } = require('../utils/schoolMailer');
const { validate, passwordError } = require('../utils/validators');
const authCache = require('../utils/authCache');
const { deleteSchoolLogo } = require('../utils/schoolLogoFile');

const generateOTP = () => {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const sendWelcomeEmail = (to, name, email, otp, schoolName = 'Aksharum', schoolId = null) => {
    const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`;
    getMailContext(schoolId).then(({ school }) => {
    const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
      ${emailHeaderHtml(school, `Welcome to ${school?.name || schoolName}!`)}
      <div style="background:#f9fafb;padding:28px 32px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
        <p style="margin-top:0">Hi <strong>${name}</strong>,</p>
        <p>Your account has been created. Use the one-time credentials below to log in for the first time:</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#fff;border-radius:6px;border:1px solid #e5e7eb">
          <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:12px 16px;font-weight:600;width:40%;color:#6b7280">Login URL</td>
            <td style="padding:12px 16px"><a href="${loginUrl}" style="color:#4f46e5">${loginUrl}</a></td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:12px 16px;font-weight:600;color:#6b7280">Email</td>
            <td style="padding:12px 16px">${email}</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;font-weight:600;color:#6b7280">One-Time Password</td>
            <td style="padding:12px 16px;font-family:monospace;font-size:1.1rem;letter-spacing:2px"><strong>${otp}</strong></td>
          </tr>
        </table>
        <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:14px 16px;margin-bottom:20px">
          <strong>⚠️ Action required:</strong> After logging in you will be asked to set a permanent password.
          This one-time password will stop working once you do.
        </div>
        <p style="color:#6b7280;font-size:.88rem;margin-bottom:0">
          Do not share your credentials with anyone.
        </p>
      </div>
    </div>`;
    sendSchoolMail(schoolId, {
        to,
        subject: `Your account is ready — action required`,
        html,
        fromName: school?.name || schoolName,
    });
    }).catch(err => console.error(`[email] welcome failed for ${to}:`, err.message));
};

exports.getDashboard = async (req, res) => {
    try {
        const [schoolCount, userCount, admins, teachers, students, parents, recentSchools] = await Promise.all([
            School.countDocuments(),
            User.countDocuments(),
            User.countDocuments({ role: 'school_admin' }),
            User.countDocuments({ role: 'teacher' }),
            User.countDocuments({ role: 'student' }),
            User.countDocuments({ role: 'parent' }),
            School.find().sort({ createdAt: -1 }).limit(5).select('name code logo isActive createdAt').lean(),
        ]);
        res.json({ success: true, data: {
            schoolCount, userCount,
            roles: { admins, teachers, students, parents },
            recentSchools,
        }});
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Schools ───────────────────────────────────────────────────────────────────
exports.getSchools = async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '' } = req.query;
        const filter = search ? { name: new RegExp(search, 'i') } : {};
        const [schools, total] = await Promise.all([
            School.find(filter).skip((page - 1) * limit).limit(+limit).lean(),
            School.countDocuments(filter),
        ]);
        res.json({ success: true, data: { data: schools, total, page: +page, pages: Math.ceil(total / limit) } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getSchool = async (req, res) => {
    try {
        const school = await School.findById(req.params.id).lean();
        if (!school) return res.status(404).json({ success: false, message: 'School not found' });
        res.json({ success: true, data: school });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const SCHOOL_BOARDS = ['CBSE', 'ICSE', 'State Board', 'IB', 'Cambridge (IGCSE)', 'NIOS', 'Other'];

const _validateSchool = (body) => {
    const required = { name: 'School Name', code: 'School Code', board: 'School Board', email: 'Email', phone: 'Phone', address: 'Address', city: 'City', state: 'State', country: 'Country' };
    for (const [field, label] of Object.entries(required)) {
        if (!body[field] || !String(body[field]).trim()) return `${label} is required`;
    }
    if (!SCHOOL_BOARDS.includes(body.board)) return 'School Board must be one of: ' + SCHOOL_BOARDS.join(', ');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return 'Valid email is required';
    if (!/^\d{7,15}$/.test(body.phone.replace(/[\s\-+()]/g, ''))) return 'Valid phone number is required';
    if (body.website && !/^https?:\/\/.+\..+/.test(body.website)) return 'Website must be a valid URL starting with http:// or https://';
    if (String(body.name).trim().length < 3) return 'School Name must be at least 3 characters';
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(String(body.code).trim())) return 'School Code must be 2-20 letters, numbers, hyphens or underscores';
    return null;
};

const _buildSchoolData = (body, file) => {
    const data = { ...body };
    // FormData always sends booleans as strings — coerce explicitly
    if (data.isActive !== undefined) data.isActive = data.isActive === 'true' || data.isActive === true;
    const removeLogo = data.removeLogo === 'true' || data.removeLogo === true;
    delete data.removeLogo;              // control flag, not a School field
    if (file)            data.logo = `/uploads/images/${file.filename}`;
    else if (removeLogo) data.logo = '';
    return data;
};

exports.createSchool = async (req, res) => {
    try {
        const err = _validateSchool(req.body);
        if (err) return res.status(400).json({ success: false, message: err });
        const school = await School.create(_buildSchoolData(req.body, req.file));
        res.status(201).json({ success: true, data: school });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.updateSchool = async (req, res) => {
    try {
        const err = _validateSchool(req.body);
        if (err) return res.status(400).json({ success: false, message: err });
        const data = _buildSchoolData(req.body, req.file);
        const previous = data.logo !== undefined
            ? (await School.findById(req.params.id).select('logo').lean())?.logo || null
            : null;
        const school = await School.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
        if (!school) return res.status(404).json({ success: false, message: 'School not found' });
        // Drop the replaced/removed file so uploads/ doesn't collect orphans
        if (previous && previous !== school.logo) deleteSchoolLogo(previous);
        res.json({ success: true, data: school });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.deleteSchool = async (req, res) => {
    try {
        await School.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'School deleted' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Users ─────────────────────────────────────────────────────────────────────
exports.getUsers = async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '', role = '', school = '', status = '', sortBy = 'createdAt', sortDir = '-1' } = req.query;
        const filter = {};
        if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }];
        if (role)   filter.role   = role;
        if (school) filter.school = school;
        if (status === 'active')   filter.isActive = true;
        if (status === 'inactive') filter.isActive = false;
        const sortField = ['name', 'email', 'role', 'createdAt', 'lastLogin'].includes(sortBy) ? sortBy : 'createdAt';
        const sortOrder = +sortDir === 1 ? 1 : -1;
        const [users, total] = await Promise.all([
            User.find(filter).populate('school', 'name').sort({ [sortField]: sortOrder }).skip((page - 1) * limit).limit(+limit).lean(),
            User.countDocuments(filter),
        ]);
        res.json({ success: true, data: { data: users, total, page: +page, pages: Math.ceil(total / limit) } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id).populate('school').lean();
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, data: user });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const USER_ROLES = ['super_admin', 'school_admin', 'teacher', 'student', 'parent'];

exports.createUser = async (req, res) => {
    try {
        const { name, email, role } = req.body;
        const err = validate(req.body, {
            name:  { label: 'Name', required: true, minLen: 2 },
            email: { label: 'Email', required: true, type: 'email' },
            role:  { label: 'Role', required: true, enum: USER_ROLES },
        });
        if (err) return res.status(400).json({ success: false, message: err });
        const school = (req.body.school && req.body.school !== '') ? req.body.school : null;
        if (role !== 'super_admin' && !school)
            return res.status(400).json({ success: false, message: 'School is required for this role' });
        const exists = await User.findOne({ email: email.toLowerCase() });
        if (exists) return res.status(400).json({ success: false, message: 'Email already registered' });
        const otp    = generateOTP();
        const user   = await User.create({
            name,
            email: email.toLowerCase(),
            role,
            password: await bcrypt.hash(otp, 12),
            isFirstLogin: true,
            school: (role !== 'super_admin') ? school : null,
        });
        sendWelcomeEmail(email, name, email, otp, undefined, school);
        res.status(201).json({ success: true, data: user });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.updateUser = async (req, res) => {
    try {
        const { name, role, password } = req.body;
        const err = validate(req.body, {
            name: { label: 'Name', required: true, minLen: 2 },
            role: { label: 'Role', required: true, enum: USER_ROLES },
        });
        if (err) return res.status(400).json({ success: false, message: err });
        const school = (req.body.school && req.body.school !== '') ? req.body.school : null;
        if (role !== 'super_admin' && !school)
            return res.status(400).json({ success: false, message: 'School is required for this role' });
        const update = { name, role, school: (role === 'super_admin') ? null : school };
        if (password) {
            const pwErr = passwordError(password);
            if (pwErr) return res.status(400).json({ success: false, message: pwErr });
            update.password = await bcrypt.hash(password, 12);
        }
        const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        await authCache.invalidate(user._id);
        res.json({ success: true, data: user });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.deleteUser = async (req, res) => {
    try {
        const target = await User.findById(req.params.id).select('_id role').lean();
        if (!target) return res.status(404).json({ success: false, message: 'User not found' });
        if (String(target._id) === String(req.userId))
            return res.status(403).json({ success: false, message: 'You cannot delete your own account' });
        if (target.role === 'super_admin')
            return res.status(403).json({ success: false, message: 'Super admin accounts cannot be deleted' });
        await User.findByIdAndDelete(req.params.id);
        await authCache.invalidate(req.params.id);
        res.json({ success: true, message: 'User deleted' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.toggleUserStatus = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        user.isActive = !user.isActive;
        await user.save();
        await authCache.invalidate(user._id);
        res.json({ success: true, isActive: user.isActive });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.bulkDeleteUsers = async (req, res) => {
    try {
        const ids = req.body.ids || [];
        // Never delete super admins or the requester themselves
        const result = await User.deleteMany({
            _id: { $in: ids, $ne: req.userId },
            role: { $ne: 'super_admin' },
        });
        const deleted = result.deletedCount;
        const skipped = ids.length - deleted;
        await authCache.invalidateMany(ids);
        res.json({
            success: true,
            deleted,
            skipped,
            message: deleted === 0
                ? 'Super admin accounts cannot be deleted'
                : skipped > 0
                    ? `${deleted} user(s) deleted · ${skipped} protected account(s) skipped (super admins cannot be deleted)`
                    : `${deleted} user(s) deleted`,
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const _bulkImport = async (req, res, role) => {
    try {
        const schoolId = req.body.school || req.query.school;
        if (!schoolId) return res.status(400).json({ success: false, message: 'school is required' });
        if (!req.file)  return res.status(400).json({ success: false, message: 'Excel file is required' });

        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

        const created = []; const errors = [];
        for (const row of rows) {
            const name  = String(row.name  || row.Name  || '').trim();
            const email = String(row.email || row.Email || '').trim().toLowerCase();
            if (!name || !email) { errors.push({ email: email || '?', reason: 'name/email missing' }); continue; }
            try {
                const exists = await User.findOne({ email }).lean();
                if (exists) { errors.push({ email, reason: 'Email already registered' }); continue; }
                const otp  = generateOTP();
                const user = await User.create({ name, email, role, school: schoolId, password: await bcrypt.hash(otp, 12), isFirstLogin: true });
                if (role === 'teacher') {
                    const designation = String(row.designation || row.Designation || '').trim();
                    await TeacherProfile.create({ user: user._id, school: schoolId, designation });
                }
                created.push(user._id);
                sendWelcomeEmail(email, name, email, otp, undefined, schoolId);
            } catch (e) { errors.push({ email, reason: e.code === 11000 ? 'Duplicate entry' : e.message }); }
        }
        res.json({ success: true, created: created.length, errors });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.bulkTeachers = (req, res) => _bulkImport(req, res, 'teacher');

exports.bulkStudents = async (req, res) => {
    const schoolId = req.body.school || req.query.school;
    if (!schoolId) return res.status(400).json({ success: false, message: 'school is required' });
    if (!req.file)  return res.status(400).json({ success: false, message: 'Excel file is required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const push = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); if (res.flush) res.flush(); };

    try {
        const school = await School.findById(schoolId).lean();
        const schoolName = school?.name || 'School';

        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

        push({ type: 'total', total: rows.length });

        const activeYear = await AcademicYear.findOne({ school: schoolId, status: 'active' }).lean();
        const classes    = await Class.find({ school: schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}) }).lean();
        const sections   = await ClassSection.find({ school: schoolId, ...(activeYear ? { academicYear: activeYear._id } : {}) }).lean();
        const classMap   = {};
        classes.forEach(c => { classMap[c.className.toLowerCase()] = c; });
        const sectionMap = {};
        sections.forEach(s => { sectionMap[`${s.class.toString()}_${s.sectionName.toLowerCase()}`] = s; });

        let created = 0;
        const errors = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]; const rowNum = i + 2;
            const r = {};
            Object.keys(row).forEach(k => { r[k.trim().toLowerCase()] = String(row[k]).trim(); });

            const name        = r['full name']          || r['name']        || '';
            const email       = (r['email address']     || r['email']       || '').toLowerCase();
            const phone       = r['phone number']        || r['phone']       || '';
            const admNo       = r['admission number']    || r['admissionnumber'] || '';
            const dobRaw      = r['date of birth']       || r['dob']         || '';
            const gender      = r['gender']              || '';
            const bloodGroup  = r['blood group']         || r['bloodgroup']  || '';
            const category    = r['category']            || '';
            const className   = r['class']               || '';
            const sectionName = r['section']             || '';
            const address     = r['address']             || '';
            const parentName  = r['parent full name']    || r['parent name'] || '';
            const parentEmail = (r['parent email']       || '').toLowerCase();
            const parentPhone = r['parent phone number'] || r['parent phone'] || '';

            push({ type: 'processing', current: i + 1, total: rows.length, name: name || `Row ${rowNum}` });

            const missing = [];
            if (!name)        missing.push('Full Name');
            if (!email)       missing.push('Email Address');
            if (!phone)       missing.push('Phone Number');
            if (!admNo)       missing.push('Admission Number');
            if (!dobRaw)      missing.push('Date of Birth');
            if (!gender)      missing.push('Gender');
            if (!bloodGroup)  missing.push('Blood Group');
            if (!category)    missing.push('Category');
            if (!className)   missing.push('Class');
            if (!sectionName) missing.push('Section');
            if (!address)     missing.push('Address');
            if (!parentName)  missing.push('Parent Full Name');
            if (!parentEmail) missing.push('Parent Email');
            if (!parentPhone) missing.push('Parent Phone Number');
            if (missing.length) {
                const reason = `Missing: ${missing.join(', ')}`;
                errors.push({ row: rowNum, name, reason });
                push({ type: 'row_done', row: rowNum, name, success: false, reason });
                continue;
            }

            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                errors.push({ row: rowNum, name, reason: 'Invalid student email' });
                push({ type: 'row_done', row: rowNum, name, success: false, reason: 'Invalid student email' });
                continue;
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail)) {
                errors.push({ row: rowNum, name, reason: 'Invalid parent email' });
                push({ type: 'row_done', row: rowNum, name, success: false, reason: 'Invalid parent email' });
                continue;
            }

            let dob = null;
            const dobParts = dobRaw.replace(/-/g, '/').split('/');
            if (dobParts.length === 3) {
                const [d, m, y] = dobParts;
                dob = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
                if (isNaN(dob.getTime())) dob = null;
            }
            if (!dob) {
                errors.push({ row: rowNum, name, reason: 'Invalid Date of Birth (use dd/mm/yyyy)' });
                push({ type: 'row_done', row: rowNum, name, success: false, reason: 'Invalid Date of Birth (use dd/mm/yyyy)' });
                continue;
            }

            const clasDoc = classMap[className.toLowerCase()];
            if (!clasDoc) {
                const reason = `Class "${className}" not found in active year`;
                errors.push({ row: rowNum, name, reason });
                push({ type: 'row_done', row: rowNum, name, success: false, reason });
                continue;
            }
            const section = sectionMap[`${clasDoc._id.toString()}_${sectionName.toLowerCase()}`];
            if (!section) {
                const reason = `Section "${sectionName}" not found in class "${className}"`;
                errors.push({ row: rowNum, name, reason });
                push({ type: 'row_done', row: rowNum, name, success: false, reason });
                continue;
            }

            const studentExists = await User.findOne({ email }).lean();
            if (studentExists) {
                const reason = `Email "${email}" already registered`;
                errors.push({ row: rowNum, name, reason });
                push({ type: 'row_done', row: rowNum, name, success: false, reason });
                continue;
            }

            let parentUserId = null;
            const existingParent = await User.findOne({ email: parentEmail }).lean();
            if (existingParent) {
                parentUserId = existingParent._id;
                const pp = await ParentProfile.findOne({ user: existingParent._id }).lean();
                if (!pp) await ParentProfile.create({ user: existingParent._id, school: schoolId });
            } else {
                const parentOtp = generateOTP();
                const parentUser = await User.create({ name: parentName, email: parentEmail, phone: parentPhone, role: 'parent', school: schoolId, password: await bcrypt.hash(parentOtp, 12), isFirstLogin: true });
                await ParentProfile.create({ user: parentUser._id, school: schoolId });
                parentUserId = parentUser._id;
                sendWelcomeEmail(parentEmail, parentName, parentEmail, parentOtp, schoolName, schoolId);
            }

            const otp = generateOTP();
            const studentUser = await User.create({ name, email, phone, role: 'student', school: schoolId, password: await bcrypt.hash(otp, 12), isFirstLogin: true });
            await StudentProfile.create({ user: studentUser._id, school: schoolId, admissionNumber: admNo, dob, gender, bloodGroup, category, address, currentSection: section._id, parent: parentUserId });
            await ParentProfile.findOneAndUpdate({ user: parentUserId }, { $addToSet: { children: studentUser._id } });
            sendWelcomeEmail(email, name, email, otp, schoolName, schoolId);

            created++;
            push({ type: 'row_done', row: rowNum, name, success: true });
        }

        push({ type: 'done', created, errors });
        res.end();
    } catch (e) {
        push({ type: 'error', message: e.message });
        res.end();
    }
};

const _studentTemplateBuffer = () => {
    const headers = [
        'Full Name', 'Email Address', 'Phone Number', 'Admission Number',
        'Date of Birth', 'Gender', 'Blood Group', 'Category',
        'Class', 'Section', 'Address',
        'Parent Full Name', 'Parent Email', 'Parent Phone Number',
    ];
    const sample = [
        'Ravi Kumar', 'ravi.kumar@example.com', '9876543210', 'ADM2024001',
        '15/08/2010', 'Male', 'B+', 'General',
        'Class 10', 'A', '123 Main Street, City',
        'Suresh Kumar', 'suresh.kumar@example.com', '9876543200',
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
    [2, 3, 4, 13].forEach(col => {
        const addr = XLSX.utils.encode_cell({ r: 1, c: col });
        if (ws[addr]) { ws[addr].t = 's'; ws[addr].z = '@'; }
    });
    ws['!cols'] = [
        { wch: 20 }, { wch: 28 }, { wch: 15 }, { wch: 16 },
        { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
        { wch: 12 }, { wch: 10 }, { wch: 28 },
        { wch: 20 }, { wch: 28 }, { wch: 18 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Students');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

exports.downloadTeacherTemplate = (req, res) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['name', 'email'],
        ['John Doe', 'john@school.edu'],
    ]), 'Teachers');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=teacher_template.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
};

exports.downloadStudentTemplate = (req, res) => {
    const buf = _studentTemplateBuffer();
    res.setHeader('Content-Disposition', 'attachment; filename=student-template.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
};

exports.generateLoginLink = async (req, res) => {
    try {
        const user = await User.findById(req.params.id).lean();
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        const token   = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await User.findByIdAndUpdate(req.params.id, {
            $set: { loginToken: token, loginTokenExpiry: expires },
        });
        const link = `${process.env.FRONTEND_URL}/auth/magic/${token}`;
        res.json({ success: true, link });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ── Module Permissions ────────────────────────────────────────────────────────
//  The top of the access hierarchy: School module enablement → Designation
//  permission → User access. Turning a module off here revokes it for every
//  designation and every user of that school immediately — the designation rows
//  keep whatever was configured, and resolution AND-s this flag over them, so
//  turning the module back on reapplies those levels untouched.
//  invalidate() drops the cached resolution so the change is not delayed by TTL.
const designationSvc = require('../services/designationService');

exports.getPermissions = async (req, res) => {
    try {
        const schools = await School.find().select('name logo modules designations').lean();
        res.json({ success: true, data: schools });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.updatePermissions = async (req, res) => {
    try {
        const { schoolId, modules } = req.body;
        const school = await School.findByIdAndUpdate(schoolId, { modules }, { new: true });
        await designationSvc.invalidate(schoolId);
        res.json({ success: true, data: school });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.bulkUpdatePermissions = async (req, res) => {
    try {
        const { updates } = req.body;
        await Promise.all(updates.map(({ schoolId, modules }) =>
            School.findByIdAndUpdate(schoolId, { modules }),
        ));
        await Promise.all(updates.map(({ schoolId }) => designationSvc.invalidate(schoolId)));
        res.json({ success: true, message: 'Permissions updated' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
