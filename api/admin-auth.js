// api/admin-auth.js
// Admin sign-in / sign-out. Issues an opaque session token stored in Redis.

import crypto from 'crypto';
import { kv, KEYS, withRetry } from './_lib/kv.js';
import {
  applyCors,
  handlePreflight,
  bearerToken,
  safeEqual,
  rateLimit,
  refundRateLimit,
  tooManyRequests,
  clientIp,
  str,
  withErrorHandling,
} from './_lib/http.js';

const SESSION_TTL_SECONDS = 8 * 60 * 60;

// Wrong sign-ins are counted per network address *and* per address+username,
// so an attacker on one network cannot lock the real administrator out. The
// per-username ceiling is only a backstop against a distributed campaign, so
// it is far looser than anything a person would reach.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_SECONDS = 900;
const LOGIN_USERNAME_CEILING = 100;

// scrypt is deliberately expensive; hashing a megabyte-long password would
// cost seconds of CPU per attempt, so an over-long one is refused first. The
// value is never trimmed — spaces are legitimate password characters.
const MAX_PASSWORD_LENGTH = 200;

async function handler(req, res) {
  applyCors(req, res, 'POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── Sign out ─────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const token = bearerToken(req);
    if (token) await kv.del(KEYS.adminSession(token)).catch(() => {});
    return res.status(200).json({ success: true, message: 'Signed out' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = str(req.body?.username, 254).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  // Refused before the limits, so an over-long password cannot use up another
  // administrator's allowance — and before safeEqual hashes it.
  if (password.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.` });
  }

  // Brute-force protection: the admin password is a single shared secret, so
  // an unlimited guess rate against it is the whole attack.
  const ip = clientIp(req);
  const byIp = await rateLimit(`adminlogin:ip:${ip}`, { max: LOGIN_MAX_FAILURES, windowSec: LOGIN_WINDOW_SECONDS });
  if (!byIp.ok) {
    return tooManyRequests(res, byIp.retryAfter, 'Too many sign-in attempts. Please try again later.');
  }
  // Keyed on the username *and* the network: one network cannot lock the real
  // administrator out of their own account.
  const byUser = await rateLimit(`adminlogin:user:${email}:${ip}`, { max: LOGIN_MAX_FAILURES, windowSec: LOGIN_WINDOW_SECONDS });
  if (!byUser.ok) {
    return tooManyRequests(res, byUser.retryAfter, 'Too many sign-in attempts. Please try again later.');
  }
  // Far looser backstop against a distributed guessing campaign.
  const byUsername = await rateLimit(`adminlogin:username:${email}`, { max: LOGIN_USERNAME_CEILING, windowSec: LOGIN_WINDOW_SECONDS });
  if (!byUsername.ok) {
    return tooManyRequests(res, byUsername.retryAfter, 'Too many sign-in attempts for this account. Please try again later.');
  }

  const adminEmails = (process.env.ADMIN_EMAILS || process.env.ADMIN_USERNAME || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmails.length || !adminPassword) {
    console.error('[Admin Auth] ADMIN_EMAILS / ADMIN_PASSWORD are not configured');
    return res.status(503).json({ error: 'Admin sign-in is not configured.' });
  }

  // Evaluate both checks before branching, so a wrong username and a wrong
  // password take the same path.
  const emailOk = adminEmails.includes(email);
  const passwordOk = safeEqual(password, adminPassword);
  if (!emailOk || !passwordOk) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Only failures count toward lockout: a correct password gives the attempt back.
  await Promise.all([
    refundRateLimit(`adminlogin:ip:${ip}`),
    refundRateLimit(`adminlogin:user:${email}:${ip}`),
    refundRateLimit(`adminlogin:username:${email}`),
  ]);

  const token = crypto.randomUUID();
  await withRetry(() =>
    kv.set(KEYS.adminSession(token), email, { ex: SESSION_TTL_SECONDS })
  );

  return res.status(200).json({
    success: true,
    session: {
      token,
      username: email,
      createdAt: new Date().toISOString(),
      expiresIn: SESSION_TTL_SECONDS, // seconds
    },
  });
}

export default withErrorHandling('AdminAuth', handler);
