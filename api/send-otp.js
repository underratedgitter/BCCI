import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

async function sendEmailViaSMTP({ to, subject, html }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: {
      user: process.env.SMTP_USER || process.env.GMAIL_USER,
      pass: process.env.SMTP_PASS || process.env.GMAIL_PASS,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER || process.env.GMAIL_USER,
    to,
    subject,
    html,
  });
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://bccibharuch.in';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const otp = generateOTP();

  try {
    // Store OTP with same key format as verify-otp.js
    await redis.set(`bcci:otp:${normalizedEmail}`, otp, { ex: 600 });

    // Send OTP via SMTP
    const smtpUser = process.env.SMTP_USER || process.env.GMAIL_USER;
    const smtpPass = process.env.SMTP_PASS || process.env.GMAIL_PASS;
    
    if (smtpUser && smtpPass) {
      await sendEmailViaSMTP({
        to: normalizedEmail,
        subject: 'Your BCCI Verification Code',
        html: `
          <div style="font-family:Arial,sans-serif;text-align:center;padding:40px;background:#F1F5F9;">
            <div style="max-width:400px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;border:1px solid #E2E8F0;">
              <h2 style="color:#0F2C59;margin-bottom:8px;">BCCI Membership Verification</h2>
              <p style="color:#64748B;font-size:14px;margin-bottom:24px;">Enter this code to verify your email</p>
              <div style="font-size:36px;font-weight:bold;letter-spacing:12px;color:#0F2C59;background:#F8FAFC;padding:16px;border-radius:8px;border:2px dashed #D4AF37;">${otp}</div>
              <p style="color:#94A3B8;font-size:12px;margin-top:24px;">This code expires in 10 minutes.</p>
              <p style="color:#94A3B8;font-size:11px;margin-top:8px;">If you didn't request this, please ignore this email.</p>
            </div>
          </div>
        `
      });
      console.log(`[OTP] Sent to ${normalizedEmail} via SMTP`);
    } else {
      console.warn('[OTP] No SMTP configured — OTP:', otp);
    }

    res.status(200).json({ 
      success: true, 
      message: 'OTP sent to your email',
      dev_otp: process.env.NODE_ENV !== 'production' ? otp : undefined 
    });
  } catch (e) {
    console.error('[Send OTP Error]', e.message);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
}
