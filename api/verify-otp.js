// api/verify-otp.js
// Vercel Serverless Function — BCCI Bharuch OTP Verification
// Checks submitted OTP against value stored in Vercel KV

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_ATTEMPTS = 5; // lockout after 5 wrong attempts

export default async function handler(req, res) {
  // ── CORS Headers ────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  // ── Input Validation ────────────────────────────────────────────────
  const { email, code, name } = req.body || {};

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ success: false, error: 'Email is required.' });
  }
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ success: false, error: 'Verification code is required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const submittedCode = code.trim();

  // ── Check Lockout ────────────────────────────────────────────────────
  const attemptsKey = `bcci:attempts:${normalizedEmail}`;
  const attempts = parseInt(await redis.get(attemptsKey) || '0', 10);

  if (attempts >= MAX_ATTEMPTS) {
    return res.status(429).json({
      success: false,
      error: 'Too many incorrect attempts. Please request a new verification code.'
    });
  }

  // ── Fetch Stored OTP ─────────────────────────────────────────────────
  const otpKey = `bcci:otp:${normalizedEmail}`;
  const storedOtp = await redis.get(otpKey);

  if (!storedOtp) {
    return res.status(400).json({
      success: false,
      error: 'Verification code has expired or was not found. Please request a new code.'
    });
  }

  // ── Verify OTP ───────────────────────────────────────────────────────
  if (submittedCode !== String(storedOtp)) {
    // Increment failed attempts
    const newAttempts = attempts + 1;
    await redis.set(attemptsKey, newAttempts.toString(), { ex: 600 });

    const remaining = MAX_ATTEMPTS - newAttempts;
    return res.status(400).json({
      success: false,
      error: remaining > 0
        ? `Invalid code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Too many incorrect attempts. Please request a new verification code.'
    });
  }

  // ── Success — clean up KV ────────────────────────────────────────────
  await redis.del(otpKey);
  await redis.del(attemptsKey);
  await redis.del(`bcci:ratelimit:${normalizedEmail}`);

  console.log(`[BCCI OTP] Verified for ${normalizedEmail}`);

  return res.status(200).json({
    success: true,
    message: 'Verification successful.',
    session: {
      email: normalizedEmail,
      name: (name || '').trim() || normalizedEmail.split('@')[0],
      authenticatedAt: new Date().toISOString(),
      authMethod: 'email_otp'
    }
  });
}
