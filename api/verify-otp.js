// api/verify-otp.js
// Checks a verification code and issues a server-side applicant session.

import crypto from 'crypto';
import { redis, KEYS, withRetry } from './_lib/redis.js';
import {
  applyCors,
  handlePreflight,
  bearerToken,
  rateLimit,
  tooManyRequests,
  safeEqual,
  str,
  isEmail,
  withErrorHandling,
} from './_lib/http.js';

const MAX_ATTEMPTS = 5;
const SESSION_TTL_SECONDS = 24 * 60 * 60;

async function handler(req, res) {
  applyCors(req, res, 'POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // Sign out — invalidate the applicant's session server-side.
  if (req.method === 'DELETE') {
    const token = bearerToken(req);
    if (token) await redis.del(KEYS.applicantSession(token)).catch(() => {});
    return res.status(200).json({ success: true, message: 'Signed out' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  const email = str(req.body?.email, 254).toLowerCase();
  const code = str(req.body?.code, 12);
  const name = str(req.body?.name, 120);

  if (!isEmail(email)) {
    return res.status(400).json({ success: false, error: 'A valid email address is required.' });
  }
  if (!code) {
    return res.status(400).json({ success: false, error: 'Verification code is required.' });
  }

  // The counter's TTL is set only when it is created, so repeated wrong
  // guesses can no longer keep extending their own window.
  const attempt = await rateLimit(`otpverify:${email}`, { max: MAX_ATTEMPTS, windowSec: 600 });
  if (!attempt.ok) {
    // Burn the code as well, so a lockout genuinely forces a new one.
    await redis.del(`bcci:otp:${email}`).catch(() => {});
    return tooManyRequests(res, attempt.retryAfter, 'Too many incorrect attempts. Please request a new verification code.');
  }

  const storedOtp = await withRetry(() => redis.get(`bcci:otp:${email}`));
  if (!storedOtp) {
    return res.status(400).json({
      success: false,
      error: 'That code has expired or was already used. Please request a new one.',
    });
  }

  if (!safeEqual(code, String(storedOtp))) {
    const remaining = Math.max(0, attempt.remaining ?? 0);
    return res.status(400).json({
      success: false,
      error: remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Too many incorrect attempts. Please request a new verification code.',
    });
  }

  // Success — clear the code and the attempt counter.
  await redis.del(`bcci:otp:${email}`).catch(() => {});
  await redis.del(`bcci:rl:otpverify:${email}`).catch(() => {});

  // Issue an opaque server-side token. The old response was an unsigned JSON
  // object the browser simply stored, so anyone could hand-write one in the
  // console and be treated as any member.
  const token = crypto.randomUUID();
  await withRetry(() =>
    redis.set(KEYS.applicantSession(token), email, { ex: SESSION_TTL_SECONDS })
  );

  console.log(`[OTP] verified ${email}`);

  return res.status(200).json({
    success: true,
    message: 'Verification successful.',
    session: {
      token,
      email,
      name: name || email.split('@')[0],
      authenticatedAt: new Date().toISOString(),
      authMethod: 'email_otp',
      expiresIn: SESSION_TTL_SECONDS, // seconds
    },
  });
}

export default withErrorHandling('VerifyOtp', handler);
