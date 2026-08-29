import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
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

    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'BCCI Bharuch <onboarding@resend.dev>',
          to: normalizedEmail,
          subject: 'Your BCCI Verification Code',
          html: `<div style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>BCCI Membership Verification</h2>
            <p>Your verification code is:</p>
            <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#1a56db;margin:20px 0">${otp}</div>
            <p style="color:#666">This code expires in 10 minutes.</p>
          </div>`
        })
      });
    }

    res.status(200).json({ success: true, message: 'OTP sent to your email', dev_otp: process.env.NODE_ENV !== 'production' ? otp : undefined });
  } catch (e) {
    console.error('[Send OTP Error]', e.message);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
}
