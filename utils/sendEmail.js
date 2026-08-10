const transporter = require('../config/mailer');
const { sendSchoolMail, emailHeaderHtml, getMailContext } = require('./schoolMailer');

const sendWelcomeEmail = async ({ to, name, email, tempPassword, role, schoolName }) => {
  const loginUrl = `${process.env.APP_URL}/auth/login`;
  const roleLabel = {
    super_admin: 'Super Admin',
    school_admin: 'School Admin',
    teacher: 'Teacher',
    student: 'Student',
    parent: 'Parent',
  }[role] || role;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Welcome to ${process.env.APP_NAME}</title>
<style>
  body { margin:0; padding:0; background:#0f1117; font-family:'Segoe UI',sans-serif; }
  .wrapper { max-width:600px; margin:40px auto; background:#1a1d2e; border-radius:16px; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,0.5); }
  .header { background:linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding:40px 32px; text-align:center; }
  .header h1 { margin:0; color:#fff; font-size:28px; font-weight:700; letter-spacing:-0.5px; }
  .header p { margin:8px 0 0; color:rgba(255,255,255,0.8); font-size:14px; }
  .body { padding:36px 32px; }
  .greeting { color:#e2e8f0; font-size:18px; margin-bottom:24px; }
  .badge { display:inline-block; background:rgba(79,70,229,0.2); color:#a5b4fc; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:600; letter-spacing:0.5px; margin-bottom:20px; }
  .cred-box { background:#0f1117; border:1px solid rgba(255,255,255,0.1); border-radius:12px; padding:24px; margin:20px 0; }
  .cred-row { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.06); }
  .cred-row:last-child { border-bottom:none; }
  .cred-label { color:#94a3b8; font-size:13px; }
  .cred-value { color:#e2e8f0; font-size:14px; font-weight:600; font-family:monospace; }
  .login-btn { display:block; text-align:center; background:linear-gradient(135deg, #4f46e5, #7c3aed); color:#fff; text-decoration:none; padding:14px 32px; border-radius:10px; font-size:15px; font-weight:600; margin:28px 0; }
  .warning { background:rgba(245,158,11,0.1); border-left:4px solid #f59e0b; border-radius:0 8px 8px 0; padding:14px 18px; color:#fbbf24; font-size:13px; margin-bottom:20px; }
  .steps { color:#94a3b8; font-size:13px; line-height:1.8; }
  .steps ol { padding-left:20px; margin:12px 0; }
  .footer { background:#0f1117; padding:24px 32px; text-align:center; }
  .footer p { color:#475569; font-size:12px; margin:0; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>🎓 ${process.env.APP_NAME}</h1>
    <p>${schoolName || 'Welcome to the platform'}</p>
  </div>
  <div class="body">
    <div class="badge">${roleLabel}</div>
    <div class="greeting">Hello, <strong style="color:#a5b4fc">${name}</strong>! 👋</div>
    <p style="color:#94a3b8; font-size:14px; margin-bottom:20px;">Your account has been successfully created. Here are your login credentials:</p>
    
    <div class="cred-box">
      <div class="cred-row">
        <span class="cred-label">📧 Email / Username</span>
        <span class="cred-value">${email}</span>
      </div>
      <div class="cred-row">
        <span class="cred-label">🔑 Temporary Password</span>
        <span class="cred-value">${tempPassword}</span>
      </div>
      ${schoolName ? `<div class="cred-row"><span class="cred-label">🏫 School</span><span class="cred-value">${schoolName}</span></div>` : ''}
      <div class="cred-row">
        <span class="cred-label">👤 Role</span>
        <span class="cred-value">${roleLabel}</span>
      </div>
    </div>

    <div class="warning">
      ⚠️ <strong>Security Notice:</strong> You will be required to set a new password on your first login. Please do not share your temporary password with anyone.
    </div>

    <a href="${loginUrl}" class="login-btn">🚀 Login to Your Dashboard</a>

    <div class="steps">
      <strong style="color:#e2e8f0;">First Login Instructions:</strong>
      <ol>
        <li>Click the login button above or visit: <span style="color:#a5b4fc">${loginUrl}</span></li>
        <li>Enter your email and temporary password</li>
        <li>Create a new secure password</li>
        <li>Access your ${roleLabel} dashboard</li>
      </ol>
    </div>
  </div>
  <div class="footer">
    <p>© ${new Date().getFullYear()} ${process.env.APP_NAME} — This is an automated message, please do not reply.</p>
  </div>
</div>
</body>
</html>
  `;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject: `Welcome to ${process.env.APP_NAME} — Your Login Credentials`,
      html,
    });
    console.log(`📧 Welcome email sent to ${to}`);
  } catch (err) {
    console.error(`❌ Email failed for ${to}:`, err.message);
  }
};

const sendOtpEmail = async ({ to, name, otp }) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Password Reset OTP</title>
<style>
  body { margin:0; padding:0; background:#f0f4ff; font-family:'Segoe UI',sans-serif; }
  .wrapper { max-width:520px; margin:40px auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 8px 40px rgba(79,70,229,0.12); }
  .header { background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%); padding:36px 32px; text-align:center; }
  .header h1 { margin:0; color:#fff; font-size:24px; font-weight:700; }
  .header p { margin:8px 0 0; color:rgba(255,255,255,0.8); font-size:13px; }
  .body { padding:36px 32px; }
  .greeting { color:#374151; font-size:16px; margin-bottom:24px; }
  .otp-box { background:#eef2ff; border:2px dashed #c7d2fe; border-radius:12px; padding:28px; text-align:center; margin:20px 0; }
  .otp-code { font-size:42px; font-weight:900; letter-spacing:10px; color:#4f46e5; font-family:monospace; }
  .otp-label { font-size:13px; color:#6b7280; margin-top:8px; }
  .warning { background:#fffbeb; border-left:4px solid #f59e0b; border-radius:0 8px 8px 0; padding:14px 18px; color:#92400e; font-size:13px; margin:20px 0; }
  .footer { background:#f9fafb; border-top:1px solid #e5e7eb; padding:20px 32px; text-align:center; }
  .footer p { color:#9ca3af; font-size:12px; margin:0; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>🎓 ${process.env.APP_NAME}</h1>
    <p>Password Reset Request</p>
  </div>
  <div class="body">
    <div class="greeting">Hello, <strong>${name}</strong>! 👋</div>
    <p style="color:#4b5563; font-size:14px;">We received a request to reset your password. Use the OTP below to verify your identity. This code is valid for <strong>10 minutes</strong>.</p>
    <div class="otp-box">
      <div class="otp-code">${otp}</div>
      <div class="otp-label">One-Time Password (OTP)</div>
    </div>
    <div class="warning">
      ⏱️ <strong>This OTP expires in 10 minutes.</strong><br/>
      If you didn't request a password reset, you can safely ignore this email.
    </div>
    <p style="color:#6b7280; font-size:13px;">For security, never share this OTP with anyone. Our team will never ask for it.</p>
  </div>
  <div class="footer">
    <p>© ${new Date().getFullYear()} ${process.env.APP_NAME} — Automated security email.</p>
  </div>
</div>
</body>
</html>
    `;
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject: `${otp} is your ${process.env.APP_NAME} password reset OTP`,
      html,
    });
    console.log(`📧 OTP email sent to ${to}`);
  } catch (err) {
    console.error(`❌ OTP email failed for ${to}:`, err.message);
    throw err; // OTP emails are fatal — surface the error
  }
};

/* ─────────────────────────────────────────────
   ATTENDANCE NOTIFICATION — sent to parents
─────────────────────────────────────────────── */
const sendAttendanceNotification = async ({ to, parentName, studentName, date, status, schoolName, schoolId = null }) => {
    const { school } = await getMailContext(schoolId).catch(() => ({ school: null }));
    const isPresent = status === 'Present';
    const isLate = status === 'Late';
    const statusColor = isPresent ? '#10b981' : isLate ? '#f59e0b' : '#ef4444';
    const statusBg = isPresent ? '#d1fae5' : isLate ? '#fef3c7' : '#fee2e2';
    const statusIcon = isPresent ? '✅' : isLate ? '⏰' : '❌';
    const message = isPresent
        ? `Your child is marked <strong>present</strong> today.`
        : isLate
        ? `Your child is marked as <strong>late</strong> today.`
        : `Your child is marked <strong>absent</strong> today.`;

    const formattedDate = new Date(date).toLocaleDateString('en-IN', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Attendance Update — ${process.env.APP_NAME}</title>
<style>
  body { margin:0; padding:0; background:#f0f4ff; font-family:'Segoe UI',sans-serif; }
  .wrapper { max-width:520px; margin:40px auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 8px 40px rgba(79,70,229,0.12); }
  .header { background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%); padding:36px 32px; text-align:center; }
  .header h1 { margin:0; color:#fff; font-size:24px; font-weight:700; }
  .header p { margin:8px 0 0; color:rgba(255,255,255,0.8); font-size:13px; }
  .body { padding:36px 32px; }
  .status-box { border-radius:12px; padding:24px; text-align:center; margin:20px 0; background:${statusBg}; border:2px solid ${statusColor}; }
  .status-icon { font-size:48px; margin-bottom:8px; }
  .status-text { font-size:18px; font-weight:700; color:${statusColor}; }
  .info-row { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #e5e7eb; font-size:14px; }
  .info-row:last-child { border-bottom:none; }
  .info-label { color:#6b7280; }
  .info-value { color:#111827; font-weight:600; }
  .footer { background:#f9fafb; border-top:1px solid #e5e7eb; padding:20px 32px; text-align:center; }
  .footer p { color:#9ca3af; font-size:12px; margin:0; }
</style>
</head>
<body>
<div class="wrapper">
  ${emailHeaderHtml(school, schoolName || 'Attendance Notification')}
  <div class="body">
    <p style="color:#374151; font-size:15px; margin-bottom:20px;">Dear <strong>${parentName}</strong>,</p>
    <div class="status-box">
      <div class="status-icon">${statusIcon}</div>
      <div class="status-text">${status.toUpperCase()}</div>
      <p style="margin:8px 0 0; color:#374151; font-size:14px;">${message}</p>
    </div>
    <div style="border:1px solid #e5e7eb; border-radius:10px; padding:16px; margin-top:16px;">
      <div class="info-row">
        <span class="info-label">🎒 Student</span>
        <span class="info-value">${studentName}</span>
      </div>
      <div class="info-row">
        <span class="info-label">📅 Date</span>
        <span class="info-value">${formattedDate}</span>
      </div>
      <div class="info-row">
        <span class="info-label">🏫 School</span>
        <span class="info-value">${schoolName || 'Your School'}</span>
      </div>
    </div>
    <p style="color:#6b7280; font-size:12px; margin-top:20px;">If you believe this is incorrect, please contact the class teacher or submit a correction request through the parent portal.</p>
  </div>
  <div class="footer">
    <p>© ${new Date().getFullYear()} ${process.env.APP_NAME} — Automated attendance notification.</p>
  </div>
</div>
</body>
</html>`;

    await sendSchoolMail(schoolId, {
        to,
        subject: `${statusIcon} Attendance Update: ${studentName} is ${status} — ${formattedDate}`,
        html,
        fromName: schoolName || undefined,
    });
};

/* ─────────────────────────────────────────────
   NOTIFICATION EMAIL — sent to any recipient
─────────────────────────────────────────────── */
const sendNotificationEmail = async ({ to, recipientName, title, body, senderRole, schoolId = null }) => {
    const roleLabel = {
        super_admin:  'Super Admin',
        school_admin: 'School Admin',
        teacher:      'Teacher',
    }[senderRole] || 'School';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <style>
    body { margin:0; padding:0; background:#f1f5f9; font-family:'Segoe UI',Arial,sans-serif; }
    .wrapper { max-width:560px; margin:32px auto; }
    .header { background:linear-gradient(135deg,#3b82f6,#6366f1); border-radius:14px 14px 0 0; padding:28px 32px; text-align:center; color:#fff; }
    .header h1 { margin:0 0 4px; font-size:22px; }
    .header p  { margin:0; font-size:13px; opacity:.85; }
    .body { background:#fff; padding:32px; border-radius:0 0 14px 14px; }
    .title-box { background:#f8fafc; border-left:4px solid #3b82f6; border-radius:0 8px 8px 0; padding:14px 18px; margin-bottom:20px; }
    .title-box h2 { margin:0 0 4px; color:#1e293b; font-size:17px; }
    .title-box .from { font-size:12px; color:#64748b; }
    .message-body { color:#374151; font-size:14px; line-height:1.7; white-space:pre-line; }
    .footer { text-align:center; margin-top:24px; font-size:11px; color:#94a3b8; }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>🎓 ${process.env.APP_NAME || 'Aksharum'}</h1>
    <p>You have a new notification</p>
  </div>
  <div class="body">
    <p style="color:#374151;font-size:15px;margin-bottom:20px;">
      Dear <strong>${recipientName}</strong>,
    </p>
    <div class="title-box">
      <h2>${title}</h2>
      <div class="from">From: ${roleLabel}</div>
    </div>
    <div class="message-body">${body}</div>
    <div class="footer">
      This is an automated notification from ${process.env.APP_NAME || 'Aksharum'}.<br/>
      Please do not reply to this email.
    </div>
  </div>
</div>
</body>
</html>`;

    await sendSchoolMail(schoolId, {
        to,
        subject: `[Notification] ${title}`,
        html,
        rethrow: true,
    });
};

module.exports = { sendWelcomeEmail, sendOtpEmail, sendAttendanceNotification, sendNotificationEmail };
