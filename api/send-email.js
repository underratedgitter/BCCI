// api/send-email.js
// Vercel Serverless Function — BCCI Bharuch Unified Email Dispatcher
// Handles ALL notification types with professional HTML templates
// Uses Resend API (primary) with Nodemailer SMTP fallback (production-ready)

import { Redis } from '@upstash/redis';
import nodemailer from 'nodemailer';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Email Templates ──────────────────────────────────────────────

const TEMPLATES = {
  // 1. User submits application → User receives confirmation
  application_submitted: (data) => ({
    subject: `Application Received — BCCI Membership (${data.appId})`,
    html: `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#FFF;border-radius:12px;overflow:hidden;border:1px solid #D4AF37;max-width:560px;">
  <tr><td style="background:#0F2C59;padding:24px 32px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#D4AF37;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Bharuch Chamber of Commerce &amp; Industry</p>
    <h1 style="margin:6px 0 0;font-size:20px;color:#FFF;font-weight:800;">Membership Application Received</h1>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="margin:0 0 8px;font-size:15px;color:#1E293B;">Dear <strong>${data.repName}</strong>,</p>
    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
      Thank you for applying for Institutional Membership with BCCI. We have successfully received your application.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:16px;margin-bottom:20px;">
      <tr><td style="padding:4px 0;font-size:13px;color:#475569;"><strong>Application ID:</strong> <span style="color:#0F2C59;font-family:monospace;font-weight:700;">${data.appId}</span></td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#475569;"><strong>Company:</strong> ${data.company}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#475569;"><strong>Representative:</strong> ${data.repName}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#475569;"><strong>Sector:</strong> ${data.sector || 'N/A'}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#475569;"><strong>Date:</strong> ${data.date}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#D97706;font-weight:700;">Status: ⏳ PENDING ADMIN APPROVAL</td></tr>
    </table>
    <p style="margin:0 0 16px;font-size:13px;color:#64748B;line-height:1.6;">
      Your application is now under review by the BCCI Secretariat Board. You will receive an email once a decision is made.
    </p>
    <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px;font-size:12px;color:#1E3E62;">
      <strong>Need help?</strong> Contact us at admin@bccibharuch.in or +91 7861906384
    </div>
  </td></tr>
  <tr><td style="background:#F8FAFC;padding:16px 32px;text-align:center;border-top:1px solid #E2E8F0;">
    <p style="margin:0;font-size:11px;color:#94A3B8;">BCCI Bharuch • Station Road, Bharuch – 392001</p>
  </td></tr>
</table></td></tr></table>
</body></html>`
  }),

  // 2. New application → Admin receives notification
  admin_new_application: (data) => ({
    subject: `[ACTION REQUIRED] New BCCI Application: ${data.company} (${data.appId})`,
    html: `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#FFF;border-radius:12px;overflow:hidden;border:1px solid #DC2626;max-width:560px;">
  <tr><td style="background:#DC2626;padding:20px 32px;text-align:center;">
    <h1 style="margin:0;font-size:18px;color:#FFF;font-weight:800;">🔔 New Membership Application</h1>
    <p style="margin:4px 0 0;font-size:12px;color:#FCA5A5;">Requires Admin Review & Approval</p>
  </td></tr>
  <tr><td style="padding:24px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:16px;margin-bottom:16px;">
      <tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>App ID:</strong> <span style="color:#DC2626;font-family:monospace;font-weight:700;">${data.appId}</span></td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>Company:</strong> ${data.company}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>Representative:</strong> ${data.repName} (${data.repDesignation})</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>Email:</strong> ${data.email}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>Phone:</strong> ${data.phone}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>Sector:</strong> ${data.sector}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>Scale:</strong> ${data.enterpriseType} • ${data.legalStatus}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>GSTIN:</strong> ${data.gstNo}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>PAN:</strong> ${data.panNo}</td></tr>
      ${data.paymentRef ? `<tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>UTR Ref:</strong> ${data.paymentRef}</td></tr>` : ''}
      <tr><td style="padding:4px 0;font-size:13px;color:#1E293B;"><strong>Submitted:</strong> ${data.date}</td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#64748B;line-height:1.6;">
      Sign in to the <strong>Admin Portal</strong> to review, approve, or decline this application.
    </p>
  </td></tr>
  <tr><td style="background:#F8FAFC;padding:16px 32px;text-align:center;border-top:1px solid #E2E8F0;">
    <p style="margin:0;font-size:11px;color:#94A3B8;">BCCI Admin Portal • Automated Notification</p>
  </td></tr>
</table></td></tr></table>
</body></html>`
  }),

  // 3. Admin approves → User receives approval + digital card
  application_approved: (data) => ({
    subject: `🎉 Membership Approved — BCCI Bharuch (${data.appId})`,
    html: `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#FFF;border-radius:12px;overflow:hidden;border:1px solid #059669;max-width:560px;">
  <tr><td style="background:#059669;padding:24px 32px;text-align:center;">
    <h1 style="margin:0;font-size:22px;color:#FFF;font-weight:800;">✅ Membership Approved!</h1>
    <p style="margin:4px 0 0;font-size:12px;color:#A7F3D0;">Welcome to BCCI Bharuch</p>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="margin:0 0 8px;font-size:15px;color:#1E293B;">Dear <strong>${data.repName}</strong>,</p>
    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
      Congratulations! Your application for BCCI Institutional Membership has been <strong style="color:#059669;">APPROVED</strong> by the Secretariat Board.
    </p>

    <!-- Digital Membership Card -->
    <div style="background:linear-gradient(135deg,#0F2C59,#1E3E62);border-radius:12px;padding:20px;color:#FFF;border:2px solid #D4AF37;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#94A3B8;">Institutional Member</div>
          <div style="font-size:14px;font-weight:800;color:#FFD700;margin-top:2px;">BHARUCH CHAMBER OF COMMERCE &amp; INDUSTRY</div>
        </div>
        <div style="background:rgba(255,215,0,0.15);border:1px solid #FFD700;color:#FFD700;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;">⭐ OFFICIAL</div>
      </div>
      <div style="font-size:16px;font-weight:700;color:#FFF;margin-bottom:4px;">${data.company}</div>
      <div style="font-size:12px;color:#93C5FD;margin-bottom:12px;">Rep: ${data.repName}</div>
      <table width="100%" style="font-size:11px;">
        <tr>
          <td style="padding:4px 0;color:#94A3B8;">Member ID</td>
          <td style="padding:4px 0;color:#94A3B8;">Valid Until</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-weight:700;font-family:monospace;color:#FFD700;">${data.appId}</td>
          <td style="padding:4px 0;font-weight:700;color:#6EE7B7;">${data.validUntil}</td>
        </tr>
      </table>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0FDF4;border:1px solid #A7F3D0;border-radius:8px;padding:12px;margin-bottom:16px;">
      <tr><td style="font-size:13px;color:#166534;line-height:1.6;">
        <strong>Your membership is now ACTIVE.</strong><br>
        You are entitled to all BCCI member privileges including Certificate of Origin, Trade Facilitation, Policy Advocacy, and more.
      </td></tr>
    </table>

    <p style="margin:0;font-size:13px;color:#64748B;line-height:1.6;">
      Please save this email for your records. You can view your digital membership card by signing in to the BCCI Portal.
    </p>
  </td></tr>
  <tr><td style="background:#F0FDF4;padding:16px 32px;text-align:center;border-top:1px solid #A7F3D0;">
    <p style="margin:0;font-size:11px;color:#94A3B8;">BCCI Bharuch • Welcome to Asia's Largest Industrial Hub</p>
  </td></tr>
</table></td></tr></table>
</body></html>`
  }),

  // 4. Admin declines → User receives decline notification
  application_declined: (data) => ({
    subject: `Application Update — BCCI Bharuch (${data.appId})`,
    html: `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#FFF;border-radius:12px;overflow:hidden;border:1px solid #E2E8F0;max-width:560px;">
  <tr><td style="background:#64748B;padding:24px 32px;text-align:center;">
    <h1 style="margin:0;font-size:18px;color:#FFF;font-weight:800;">Application Update</h1>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="margin:0 0 8px;font-size:15px;color:#1E293B;">Dear <strong>${data.repName}</strong>,</p>
    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
      After careful review by the BCCI Secretariat Board, we regret to inform you that your membership application could not be approved at this time.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:16px;margin-bottom:20px;">
      <tr><td style="padding:4px 0;font-size:13px;color:#475569;"><strong>Application ID:</strong> <span style="font-family:monospace;">${data.appId}</span></td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#475569;"><strong>Company:</strong> ${data.company}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#DC2626;font-weight:700;">Status: ❌ NOT APPROVED</td></tr>
    </table>
    ${data.reason ? `
    <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px;margin-bottom:16px;">
      <p style="margin:0;font-size:13px;color:#991B1B;"><strong>Reason:</strong> ${data.reason}</p>
    </div>
    ` : ''}
    <p style="margin:0 0 16px;font-size:13px;color:#64748B;line-height:1.6;">
      If you believe this decision was made in error, or if you would like to reapply with updated documentation, please contact the BCCI Secretariat.
    </p>
    <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px;font-size:12px;color:#1E3E62;">
      <strong>Contact:</strong> admin@bccibharuch.in | +91 7861906384
    </div>
  </td></tr>
  <tr><td style="background:#F8FAFC;padding:16px 32px;text-align:center;border-top:1px solid #E2E8F0;">
    <p style="margin:0;font-size:11px;color:#94A3B8;">BCCI Bharuch • Station Road, Bharuch – 392001</p>
  </td></tr>
</table></td></tr></table>
</body></html>`
  }),

  // 5. Renewal reminder → User receives before expiry
  renewal_reminder: (data) => ({
    subject: `⚠️ Membership Renewal Due — BCCI Bharuch (${data.appId})`,
    html: `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#FFF;border-radius:12px;overflow:hidden;border:1px solid #F59E0B;max-width:560px;">
  <tr><td style="background:#F59E0B;padding:24px 32px;text-align:center;">
    <h1 style="margin:0;font-size:18px;color:#FFF;font-weight:800;">⚠️ Membership Renewal Reminder</h1>
    <p style="margin:4px 0 0;font-size:12px;color:#FEF3C7;">Your BCCI membership is expiring soon</p>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="margin:0 0 8px;font-size:15px;color:#1E293B;">Dear <strong>${data.repName}</strong>,</p>
    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
      Your BCCI Institutional Membership is expiring in <strong style="color:#DC2626;">${data.daysLeft} day${data.daysLeft !== 1 ? 's' : ''}</strong>. Please renew to continue enjoying member privileges.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FEF3C7;border:1px solid #FDE68A;border-radius:8px;padding:16px;margin-bottom:20px;">
      <tr><td style="padding:4px 0;font-size:13px;color:#92400E;"><strong>Company:</strong> ${data.company}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#92400E;"><strong>Member ID:</strong> <span style="font-family:monospace;">${data.appId}</span></td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#DC2626;font-weight:700;">Expires: ${data.validUntil}</td></tr>
    </table>

    <!-- Payment QR -->
    <div style="text-align:center;margin-bottom:20px;">
      <p style="font-size:13px;color:#475569;margin-bottom:8px;"><strong>Scan to Pay Renewal Fee</strong></p>
      <div style="display:inline-block;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px;">
        <p style="margin:0 0 4px;font-size:12px;color:#0F2C59;font-weight:700;">M/S. BHARUCH CHAMBER OF COMMERCE AND INDUSTRY</p>
        <p style="margin:0;font-size:11px;color:#0284C7;font-weight:700;">UPI: 7861906384.eazypay@icici</p>
        <p style="margin:4px 0 0;font-size:10px;color:#94A3B8;">ICICI Bank • GPay, PhonePe, Paytm, BHIM</p>
      </div>
    </div>

    <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px;font-size:12px;color:#1E3E62;margin-bottom:16px;">
      <strong>How to Renew:</strong><br>
      1. Scan the QR code above and pay the annual renewal fee<br>
      2. Sign in to the BCCI Portal → My Profile → Annual Renewal<br>
      3. Enter your UTR/Transaction reference number
    </div>

    <p style="margin:0;font-size:13px;color:#64748B;line-height:1.6;">
      If you do not renew, your membership privileges will be suspended after the expiry date.
    </p>
  </td></tr>
  <tr><td style="background:#FEF3C7;padding:16px 32px;text-align:center;border-top:1px solid #FDE68A;">
    <p style="margin:0;font-size:11px;color:#92400E;">BCCI Bharuch • Membership Renewal Department</p>
  </td></tr>
</table></td></tr></table>
</body></html>`
  }),
};

// ── Email Sending Logic ──────────────────────────────────────────

async function sendViaResend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY || localStorage?.getItem?.('bcci_resend_api_key') || '';
  if (!apiKey) return false;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'BCCI Bharuch <onboarding@resend.dev>',
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`[Resend] Email sent to ${to}:`, data.id);
      return true;
    }

    const err = await response.json();
    console.warn('[Resend] Failed:', err);
    return false;
  } catch (err) {
    console.warn('[Resend] Network error:', err.message);
    return false;
  }
}

async function sendViaSMTP({ to, subject, html }) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return false;

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });

    await transporter.sendMail({
      from: `"BCCI Bharuch Portal" <${process.env.GMAIL_USER}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
    });

    console.log(`[SMTP] Email sent to ${to}`);
    return true;
  } catch (err) {
    console.error('[SMTP] Error:', err.message);
    return false;
  }
}

async function dispatchEmail({ to, subject, html }) {
  // Try Resend first, fallback to SMTP
  const resendOk = await sendViaResend({ to, subject, html });
  if (resendOk) return { provider: 'resend', success: true };

  const smtpOk = await sendViaSMTP({ to, subject, html });
  if (smtpOk) return { provider: 'smtp', success: true };

  return { provider: 'none', success: false };
}

// ── Main Handler ─────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', corsHeaders['Access-Control-Allow-Origin']);
  res.setHeader('Access-Control-Allow-Methods', corsHeaders['Access-Control-Allow-Methods']);
  res.setHeader('Access-Control-Allow-Headers', corsHeaders['Access-Control-Allow-Headers']);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  try {
    const { type, to, data } = req.body || {};

    if (!type || !TEMPLATES[type]) {
      return res.status(400).json({
        success: false,
        error: `Invalid email type. Valid types: ${Object.keys(TEMPLATES).join(', ')}`
      });
    }

    if (!to) {
      return res.status(400).json({ success: false, error: 'Recipient email is required.' });
    }

    if (!data) {
      return res.status(400).json({ success: false, error: 'Email data is required.' });
    }

    // Generate email content from template
    const template = TEMPLATES[type](data);

    // Dispatch email
    const result = await dispatchEmail({
      to,
      subject: template.subject,
      html: template.html,
    });

    // Log to Redis for audit trail
    const logKey = 'bcci:email_log';
    const logEntry = {
      id: `EMAIL-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      type,
      to: Array.isArray(to) ? to : [to],
      subject: template.subject,
      success: result.success,
      provider: result.provider,
      sentAt: new Date().toISOString(),
    };

    try {
      const logs = (await redis.get(logKey)) || [];
      logs.unshift(logEntry);
      await redis.set(logKey, logs.slice(0, 500)); // Keep last 500 logs
    } catch (err) {
      console.warn('[Email Log] Failed to write to Redis:', err.message);
    }

    if (result.success) {
      console.log(`[BCCI Email] ${type} sent to ${to} via ${result.provider}`);
      return res.status(200).json({
        success: true,
        message: `Email sent successfully via ${result.provider}.`,
        emailId: logEntry.id,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: 'Failed to send email. All providers unavailable.',
      });
    }

  } catch (err) {
    console.error('[BCCI Send Email API Error]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error.',
    });
  }
}
