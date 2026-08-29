// api/admin-auth.js
// Admin sign-in / sign-out. Issues an opaque session token stored in Redis.

import crypto from 'crypto';
import { redis, KEYS, withRetry } from './_lib/redis.js';
import {
  applyCors,
  handlePreflight,
  bearerToken,
  safeEqual,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  withErrorHandling,
} from './_lib/http.js';

const SESSION_TTL_SECONDS = 8 * 60 * 60;

async function handler(req, res) {
  applyCors(req, res, 'POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── Sign out ─────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const token = bearerToken(req);
    if (token) await redis.del(KEYS.adminSession(token)).catch(() => {});
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

  // Brute-force protection: the admin password is a single shared secret, so
  // an unlimited guess rate against it is the whole attack.
  const ip = clientIp(req);
  const byIp = await rateLimit(`adminlogin:ip:${ip}`, { max: 10, windowSec: 900 });
  if (!byIp.ok) {
    return tooManyRequests(res, byIp.retryAfter, 'Too many sign-in attempts. Please try again later.');
  }
  const byUser = await rateLimit(`adminlogin:user:${email}`, { max: 10, windowSec: 900 });
  if (!byUser.ok) {
    return tooManyRequests(res, byUser.retryAfter, 'Too many sign-in attempts. Please try again later.');
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

  const token = crypto.randomUUID();
  await withRetry(() =>
    redis.set(KEYS.adminSession(token), email, { ex: SESSION_TTL_SECONDS })
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
