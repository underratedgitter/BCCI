// api/send-otp.js
// Vercel Serverless Function — BCCI Bharuch OTP Email Dispatch
// Stack: Nodemailer (Gmail SMTP) + Vercel KV (Redis)

import nodemailer from 'nodemailer';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const OTP_EXPIRY_SECONDS = 600;       // 10 minutes
const RATE_LIMIT_SECONDS = 60;        // 1 OTP per email per 60 seconds
const MAX_ATTEMPTS = 5;               // max wrong attempts before lockout

export default async function handler(req, res) {
  // ── CORS Headers ────────────────────────────────────────────────────
  const origin = process.env.ALLOWED_ORIGIN || 'https://bccibharuch.in';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  // ── Input Validation ────────────────────────────────────────────────
  const { email, name } = req.body || {};

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ success: false, error: 'A valid email address is required.' });
  }
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ success: false, error: 'Representative name is required (min 2 characters).' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    return res.status(400).json({ success: false, error: 'Invalid email address format.' });
  }

  // ── Rate Limiting ────────────────────────────────────────────────────
  const rateLimitKey = `bcci:ratelimit:${normalizedEmail}`;
  const lastSent = await redis.get(rateLimitKey);
  if (lastSent) {
    return res.status(429).json({
      success: false,
      error: `Please wait ${RATE_LIMIT_SECONDS} seconds before requesting a new code.`
    });
  }

  // ── Generate OTP ─────────────────────────────────────────────────────
  const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit

  // ── Store OTP in Vercel KV ───────────────────────────────────────────
  const otpKey = `bcci:otp:${normalizedEmail}`;
  const attemptsKey = `bcci:attempts:${normalizedEmail}`;

  await redis.set(otpKey, otp, { ex: OTP_EXPIRY_SECONDS });
  await redis.set(rateLimitKey, '1', { ex: RATE_LIMIT_SECONDS });
  await redis.del(attemptsKey); // reset any previous failed attempts

  // ── Email HTML Template ──────────────────────────────────────────────
  const htmlBody = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #D4AF37;max-width:560px;">
        <!-- Header -->
        <tr>
          <td style="background:#0F2C59;padding:24px 32px;text-align:center;">
            <p style="margin:0;font-size:11px;color:#D4AF37;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Bharuch Chamber of Commerce &amp; Industry</p>
            <h1 style="margin:6px 0 0 0;font-size:20px;color:#FFFFFF;font-weight:800;">Membership Portal</h1>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 8px 0;font-size:15px;color:#1E293B;">Dear <strong>${name.trim()}</strong>,</p>
            <p style="margin:0 0 24px 0;font-size:14px;color:#475569;line-height:1.6;">
              Your one-time verification code for the <strong>BCCI Bharuch Membership Portal</strong> is:
            </p>
            <!-- OTP Box -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center">
                  <div style="display:inline-block;background:#F8FAFC;border:2px dashed #D4AF37;border-radius:12px;padding:20px 40px;margin:0 auto;">
                    <span style="font-size:42px;font-weight:900;font-family:monospace;color:#0F2C59;letter-spacing:10px;">${otp}</span>
                  </div>
                </td>
              </tr>
            </table>
            <p style="margin:20px 0 0 0;font-size:13px;color:#64748B;text-align:center;">
              ⏱ This code expires in <strong>10 minutes</strong>. Do not share it with anyone.
            </p>
            <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;">
            <p style="margin:0;font-size:12px;color:#94A3B8;line-height:1.6;">
              If you did not request this code, you can safely ignore this email.<br>
              This is an automated message from the BCCI Bharuch Membership Portal.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#F8FAFC;padding:16px 32px;text-align:center;border-top:1px solid #E2E8F0;">
            <p style="margin:0;font-size:11px;color:#94A3B8;">
              BCCI Bharuch &bull; City Center, Station Road, Bharuch – 392001<br>
              admin@bccibharuch.in &bull; +91 7861906384
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // ── Try Resend first, fallback to Gmail SMTP ─────────────────────────
  let emailSent = false;
  let provider = 'none';

  // 1. Try Resend API
  const resendApiKey = process.env.RESEND_API_KEY || '';
  if (resendApiKey) {
    try {
      const resendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'BCCI Bharuch <onboarding@resend.dev>',
          to: normalizedEmail,
          subject: `Your BCCI Bharuch Verification Code: ${otp}`,
          html: htmlBody,
        }),
      });
      if (resendResp.ok) {
        const resendData = await resendResp.json();
        console.log(`[Resend OTP] Sent to ${normalizedEmail}:`, resendData.id);
        emailSent = true;
        provider = 'resend';
      } else {
        let errBody;
        try { errBody = await resendResp.json(); } catch { errBody = await resendResp.text(); }
        console.warn(`[Resend OTP] Failed (${resendResp.status}):`, errBody);
      }
    } catch (err) {
      console.warn('[Resend OTP] Network error:', err.message);
    }
  }

  // 2. Fallback: Gmail SMTP
  if (!emailSent && process.env.GMAIL_USER && process.env.GMAIL_PASS) {
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
        to: normalizedEmail,
        subject: `Your BCCI Bharuch Verification Code: ${otp}`,
        html: htmlBody,
        text: `Your BCCI Bharuch verification code is: ${otp}\nThis code expires in 10 minutes. Do not share it with anyone.`,
      });

      console.log(`[SMTP OTP] Sent to ${normalizedEmail}`);
      emailSent = true;
      provider = 'smtp';
    } catch (err) {
      console.error('[SMTP OTP] Error:', err.message);
    }
  }

  if (emailSent) {
    return res.status(200).json({
      success: true,
      message: `Verification code sent to ${normalizedEmail}. Check your inbox.`,
      provider,
    });
  } else {
    // Clean up KV so user can retry immediately
    await redis.del(otpKey);
    await redis.del(rateLimitKey);
    return res.status(500).json({
      success: false,
      error: 'Failed to send email. All providers unavailable. Please try again later.'
    });
  }
}
