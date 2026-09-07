// api/employee-auth.js
// Employee login, logout, and session check.

import crypto from 'node:crypto';
import { redis, withRetry } from './_lib/redis.js';
import { verifyPassword } from './_lib/accounts.js';
import { getEmployeeByUsername, EXP_KEYS } from './_lib/expenses.js';
import {
  applyCors,
  handlePreflight,
  bearerToken,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  withErrorHandling,
} from './_lib/http.js';

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── Logout ───────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const token = bearerToken(req);
    if (token) await redis.del(EXP_KEYS.empSession(token)).catch(() => {});
    return res.status(200).json({ success: true, message: 'Signed out successfully.' });
  }

  // ── Session Check ────────────────────────────────────────────────
  if (req.method === 'GET') {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ success: false, error: 'No token provided.' });
    const raw = await redis.get(EXP_KEYS.empSession(token));
    if (!raw) return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
    const session = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json({ success: true, session });
  }

  // ── Login ────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  const username = str(req.body?.username, 50).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required.' });
  }

  const ip = clientIp(req);
  const ipLimit = await rateLimit(`emplogin:ip:${ip}`, { max: 10, windowSec: 900 });
  if (!ipLimit.ok) {
    return tooManyRequests(res, ipLimit.retryAfter, 'Too many login attempts. Please try again later.');
  }

  const userLimit = await rateLimit(`emplogin:user:${username}`, { max: 10, windowSec: 900 });
  if (!userLimit.ok) {
    return tooManyRequests(res, userLimit.retryAfter, 'Too many login attempts for this user. Please try again later.');
  }

  const emp = await getEmployeeByUsername(username);
  if (!emp || !verifyPassword(password, emp.passwordHash, emp.salt)) {
    return res.status(401).json({ success: false, error: 'Invalid username or password.' });
  }

  if (emp.status === 'inactive') {
    return res.status(403).json({
      success: false,
      error: 'Your employee account has been deactivated. Please contact administration.',
    });
  }

  const token = crypto.randomUUID();
  const session = {
    token,
    id: emp.id,
    employeeId: emp.employeeId,
    name: emp.name,
    username: emp.username,
    email: emp.email,
    authenticatedAt: new Date().toISOString(),
    expiresIn: SESSION_TTL_SECONDS,
  };

  await withRetry(() =>
    redis.set(EXP_KEYS.empSession(token), session, { ex: SESSION_TTL_SECONDS })
  );

  return res.status(200).json({ success: true, session });
}

export default withErrorHandling('EmployeeAuth', handler);
