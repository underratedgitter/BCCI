// api/_lib/email.js
// Templates and delivery for every notification the portal sends.
//
// Sending lives on the server and is triggered by the route that performs the
// action. The browser never chooses a recipient — /api/send-email used to be
// public and unauthenticated, which made it an open relay running on BCCI's
// own sender reputation.

import nodemailer from 'nodemailer';
import { redis } from './redis.js';
import { esc } from './http.js';

const LOG_KEY = 'bcci:email_log';
const SUPPORT_EMAIL = 'admin@bccibharuch.in';
const SUPPORT_PHONE = '+91 7861906384';

// ── Shared chrome ──────────────────────────────────────────────────

const shell = ({ accent, heading, sub, body, footer }) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#FFF;border-radius:12px;overflow:hidden;border:1px solid ${accent};max-width:560px;">
  <tr><td style="background:${accent};padding:24px 32px;text-align:center;">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,.75);font-weight:700;letter-spacing:2px;text-transform:uppercase;">Bharuch Chamber of Commerce &amp; Industry</p>
    <h1 style="margin:6px 0 0;font-size:20px;color:#FFF;font-weight:800;">${heading}</h1>
    ${sub ? `<p style="margin:4px 0 0;font-size:12px;color:rgba(255,255,255,.8);">${sub}</p>` : ''}
  </td></tr>
  <tr><td style="padding:32px;">${body}</td></tr>
  <tr><td style="background:#F8FAFC;padding:16px 32px;text-align:center;border-top:1px solid #E2E8F0;">
    <p style="margin:0;font-size:11px;color:#94A3B8;">${footer || 'BCCI Bharuch • Station Road, Bharuch – 392001'}</p>
  </td></tr>
</table></td></tr></table>
</body></html>`;

const row = (label, value, color = '#475569') =>
  `<tr><td style="padding:4px 0;font-size:13px;color:${color};"><strong>${esc(label)}:</strong> ${esc(value || 'N/A')}</td></tr>`;

const panel = (rows, bg = '#F8FAFC', border = '#E2E8F0') =>
  `<table width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border:1px solid ${border};border-radius:8px;padding:16px;margin-bottom:20px;">${rows}</table>`;

const helpBox = `<div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px;font-size:12px;color:#1E3E62;">
  <strong>Need help?</strong> Contact us at ${SUPPORT_EMAIL} or ${SUPPORT_PHONE}
</div>`;

// ── Templates ──────────────────────────────────────────────────────
// Every interpolation goes through esc(). These templates render attacker-
// influenced text (company names, rejection reasons) into HTML that lands in
// someone's inbox from a trusted sender.

export const TEMPLATES = {
  application_submitted: (d) => ({
    subject: `Application Received — BCCI Membership (${d.appId})`,
    html: shell({
      accent: '#0F2C59',
      heading: 'Membership Application Received',
      body: `
        <p style="margin:0 0 8px;font-size:15px;color:#1E293B;">Dear <strong>${esc(d.repName)}</strong>,</p>
        <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
          Thank you for applying for Institutional Membership with BCCI. We have received your application.
        </p>
        ${panel(
          row('Application ID', d.appId, '#0F2C59') +
          row('Company', d.company) +
          row('Representative', d.repName) +
          row('Sector', d.sector) +
          row('Date', d.date) +
          `<tr><td style="padding:4px 0;font-size:13px;color:#D97706;font-weight:700;">Status: PENDING ADMIN APPROVAL</td></tr>`
        )}
        <p style="margin:0 0 16px;font-size:13px;color:#64748B;line-height:1.6;">
          Your application is now under review by the BCCI Secretariat Board. You will receive an email once a decision is made.
        </p>
        ${helpBox}`,
    }),
  }),

  admin_new_application: (d) => ({
    subject: `[ACTION REQUIRED] New BCCI Application: ${d.company} (${d.appId})`,
    html: shell({
      accent: '#DC2626',
      heading: 'New Membership Application',
      sub: 'Requires admin review and approval',
      footer: 'BCCI Admin Portal • Automated Notification',
      body: `
        ${panel(
          row('App ID', d.appId, '#1E293B') +
          row('Company', d.company, '#1E293B') +
          row('Representative', `${d.repName || ''} (${d.repDesignation || 'Delegate'})`, '#1E293B') +
          row('Email', d.email, '#1E293B') +
          row('Phone', d.phone, '#1E293B') +
          row('Sector', d.sector, '#1E293B') +
          row('Scale', `${d.enterpriseType || 'N/A'} • ${d.legalStatus || 'N/A'}`, '#1E293B') +
          row('GSTIN', d.gstNo, '#1E293B') +
          row('PAN', d.panNo, '#1E293B') +
          (d.paymentRef ? row('UTR Ref', d.paymentRef, '#1E293B') : '') +
          row('Submitted', d.date, '#1E293B'),
          '#FEF2F2',
          '#FECACA'
        )}
        <p style="margin:0;font-size:13px;color:#64748B;line-height:1.6;">
          Sign in to the <strong>Admin Portal</strong> to review, approve, or decline this application.
        </p>`,
    }),
  }),

  application_approved: (d) => ({
    subject: `Membership Approved — BCCI Bharuch (${d.appId})`,
    html: shell({
      accent: '#059669',
      heading: 'Membership Approved',
      sub: 'Welcome to BCCI Bharuch',
      footer: 'BCCI Bharuch • Station Road, Bharuch – 392001',
      body: `
        <p style="margin:0 0 8px;font-size:15px;color:#1E293B;">Dear <strong>${esc(d.repName)}</strong>,</p>
        <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
          Congratulations — your application for BCCI Institutional Membership has been
          <strong style="color:#059669;">APPROVED</strong> by the Secretariat Board.
        </p>
        <div style="background:#0F2C59;border-radius:12px;padding:20px;color:#FFF;border:2px solid #D4AF37;margin-bottom:20px;">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#94A3B8;">Institutional Member</div>
          <div style="font-size:14px;font-weight:800;color:#FFD700;margin:2px 0 12px;">BHARUCH CHAMBER OF COMMERCE &amp; INDUSTRY</div>
          <div style="font-size:16px;font-weight:700;color:#FFF;margin-bottom:4px;">${esc(d.company)}</div>
          <div style="font-size:12px;color:#93C5FD;margin-bottom:12px;">Rep: ${esc(d.repName)}</div>
          <table width="100%" style="font-size:11px;">
            <tr><td style="padding:4px 0;color:#94A3B8;">Member ID</td><td style="padding:4px 0;color:#94A3B8;">Valid Until</td></tr>
            <tr>
              <td style="padding:4px 0;font-weight:700;font-family:monospace;color:#FFD700;">${esc(d.appId)}</td>
              <td style="padding:4px 0;font-weight:700;color:#6EE7B7;">${esc(d.validUntil)}</td>
            </tr>
          </table>
        </div>
        ${panel(
          `<tr><td style="font-size:13px;color:#166534;line-height:1.6;">
            <strong>Your membership is now active.</strong><br>
            You are entitled to all BCCI member privileges including Certificate of Origin, Trade Facilitation, and Policy Advocacy.
          </td></tr>`,
          '#F0FDF4',
          '#A7F3D0'
        )}
        <p style="margin:0;font-size:13px;color:#64748B;line-height:1.6;">
          Sign in to the BCCI Portal to view and download your digital membership card.
        </p>`,
    }),
  }),

  application_declined: (d) => ({
    subject: `Application Update — BCCI Bharuch (${d.appId})`,
    html: shell({
      accent: '#64748B',
      heading: 'Application Update',
      body: `
        <p style="margin:0 0 8px;font-size:15px;color:#1E293B;">Dear <strong>${esc(d.repName)}</strong>,</p>
        <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
          After review by the BCCI Secretariat Board, your membership application could not be approved at this time.
        </p>
        ${panel(
          row('Application ID', d.appId) +
          row('Company', d.company) +
          `<tr><td style="padding:4px 0;font-size:13px;color:#DC2626;font-weight:700;">Status: NOT APPROVED</td></tr>`
        )}
        ${d.reason ? `<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px;margin-bottom:16px;">
          <p style="margin:0;font-size:13px;color:#991B1B;"><strong>Reason:</strong> ${esc(d.reason)}</p>
        </div>` : ''}
        <p style="margin:0 0 16px;font-size:13px;color:#64748B;line-height:1.6;">
          If you would like to reapply with updated documentation, please contact the BCCI Secretariat.
        </p>
        ${helpBox}`,
    }),
  }),

  renewal_reminder: (d) => ({
    subject: `Membership Renewal Due — BCCI Bharuch (${d.appId})`,
    html: shell({
      accent: '#B45309',
      heading: 'Membership Renewal Reminder',
      sub: 'Your BCCI membership is expiring soon',
      footer: 'BCCI Bharuch • Membership Renewal Department',
      body: `
        <p style="margin:0 0 8px;font-size:15px;color:#1E293B;">Dear <strong>${esc(d.repName)}</strong>,</p>
        <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
          Your BCCI Institutional Membership expires in
          <strong style="color:#DC2626;">${esc(d.daysLeft)} day${Number(d.daysLeft) === 1 ? '' : 's'}</strong>.
          Please renew to continue enjoying member privileges.
        </p>
        ${panel(
          row('Company', d.company, '#92400E') +
          row('Member ID', d.appId, '#92400E') +
          `<tr><td style="padding:4px 0;font-size:13px;color:#DC2626;font-weight:700;">Expires: ${esc(d.validUntil)}</td></tr>`,
          '#FEF3C7',
          '#FDE68A'
        )}
        <div style="text-align:center;margin-bottom:20px;">
          <p style="font-size:13px;color:#475569;margin-bottom:8px;"><strong>Scan to pay the renewal fee</strong></p>
          <div style="display:inline-block;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px;">
            <p style="margin:0 0 4px;font-size:12px;color:#0F2C59;font-weight:700;">M/S. BHARUCH CHAMBER OF COMMERCE AND INDUSTRY</p>
            <p style="margin:0;font-size:11px;color:#0284C7;font-weight:700;">UPI: 7861906384.eazypay@icici</p>
            <p style="margin:4px 0 0;font-size:10px;color:#94A3B8;">ICICI Bank • GPay, PhonePe, Paytm, BHIM</p>
          </div>
        </div>
        <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px;font-size:12px;color:#1E3E62;">
          <strong>How to renew:</strong><br>
          1. Pay the annual renewal fee using the UPI ID above<br>
          2. Sign in to the BCCI Portal → My Profile → Annual Renewal<br>
          3. Enter your UTR / transaction reference number
        </div>`,
    }),
  }),
};

// ── Delivery ───────────────────────────────────────────────────────

let cachedTransport = null;

function getTransport() {
  // Local development / tests: capture messages instead of sending them.
  if (process.env.SMTP_TRANSPORT === 'json') {
    if (!cachedTransport) cachedTransport = nodemailer.createTransport({ jsonTransport: true });
    return cachedTransport;
  }

  const user = process.env.SMTP_USER || process.env.GMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.GMAIL_PASS;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);

  // Port 465 is implicit TLS; 587 and 25 start plaintext and upgrade with
  // STARTTLS. Hardcoding secure:true worked for Gmail on 465 but breaks
  // against a relay on 587 or a local MTA on a VPS.
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : port === 465;

  // A local MTA on the same box needs no credentials.
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if ((!user || !pass) && !isLocal) return null;

  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host,
      port,
      secure,
      ...(user && pass ? { auth: { user, pass } } : {}),
      // Allow a self-signed cert only when explicitly opted in, for a local
      // relay on a VPS. Never relax this for a public provider.
      ...(process.env.SMTP_ALLOW_SELF_SIGNED === 'true'
        ? { tls: { rejectUnauthorized: false } }
        : {}),
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      pool: true,
      maxConnections: 3,
    });
  }
  return cachedTransport;
}

/** Verifies the SMTP connection and credentials without sending anything. */
export async function verifyTransport() {
  const transport = getTransport();
  if (!transport) return { ok: false, error: 'SMTP is not configured' };
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Sends a one-off message that isn't one of the stored templates (e.g. OTP). */
export async function sendRaw({ to, subject, html }) {
  return deliver({ to, subject, html });
}

async function deliver({ to, subject, html }) {
  const transport = getTransport();
  if (!transport) {
    console.warn('[Email] No SMTP credentials configured — skipping send');
    return { success: false, provider: 'none', error: 'SMTP not configured' };
  }

  const user = process.env.SMTP_USER || process.env.GMAIL_USER;
  try {
    await transport.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_FROM || `"BCCI Bharuch Portal" <${user}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
    });
    return { success: true, provider: 'smtp' };
  } catch (err) {
    console.error('[Email] SMTP error:', err.message);
    return { success: false, provider: 'smtp', error: err.message };
  }
}

/**
 * Renders and sends one notification. Never throws — a failed notification
 * must not roll back the action that triggered it.
 */
export async function sendEmail({ type, to, data }) {
  try {
    const build = TEMPLATES[type];
    if (!build) return { success: false, error: `Unknown email type: ${type}` };
    if (!to) return { success: false, error: 'Recipient required' };

    const { subject, html } = build(data || {});
    const result = await deliver({ to, subject, html });

    // Audit trail, capped so it cannot grow without bound.
    try {
      const logs = (await redis.get(LOG_KEY)) || [];
      logs.unshift({
        id: `EMAIL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        to: Array.isArray(to) ? to : [to],
        subject,
        success: result.success,
        provider: result.provider,
        sentAt: new Date().toISOString(),
      });
      await redis.set(LOG_KEY, logs.slice(0, 300));
    } catch (err) {
      console.warn('[Email] audit log write failed:', err.message);
    }

    if (result.success) console.log(`[Email] ${type} sent to ${to}`);
    return result;
  } catch (err) {
    console.error('[Email] unexpected failure:', err.message);
    return { success: false, error: err.message };
  }
}

/** Where admin notifications go. Server-side only. */
export function adminRecipients() {
  const raw = process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || SUPPORT_EMAIL;
  return raw.split(',').map((e) => e.trim()).filter(Boolean);
}
