// api/employee-auth.js
// Employee login, logout, and session check.

import crypto from 'node:crypto';
import { redis, withRetry } from './_lib/redis.js';
import { verifyPassword, verifyPasswordAsync } from './_lib/accounts.js';
import { getEmployeeByUsername, EXP_KEYS } from './_lib/expenses.js';
import {
  applyCors,
  handlePreflight,
  bearerToken,
  getEmployeeSession,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  withErrorHandling,
} from './_lib/http.js';

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Pre-computed dummy salt & hash to ensure constant-time response for absent accounts (SEC-01)
const DUMMY_SALT = '0123456789abcdef0123456789abcdef';
const DUMMY_HASH = '0123456789abcdef'.repeat(8);

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── Logout ───────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const token = bearerToken(req);
    if (token) {
      const raw = await redis.get(EXP_KEYS.empSession(token));
      if (raw) {
        const sess = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (sess?.id) {
          const rawTokens = await redis.get(`bcci:emp_tokens:${sess.id}`);
          const tokens = rawTokens ? (typeof rawTokens === 'string' ? JSON.parse(rawTokens) : rawTokens) : [];
          const remaining = tokens.filter((t) => t !== token);
          if (remaining.length) await redis.set(`bcci:emp_tokens:${sess.id}`, remaining, { ex: SESSION_TTL_SECONDS });
          else await redis.del(`bcci:emp_tokens:${sess.id}`).catch(() => {});
        }
      }
      await redis.del(EXP_KEYS.empSession(token)).catch(() => {});
    }
    return res.status(200).json({ success: true, message: 'Signed out successfully.' });
  }

  // ── Session Check ────────────────────────────────────────────────
  if (req.method === 'GET') {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ success: false, error: 'No token provided.' });
    const session = await getEmployeeSession(req);
    if (!session) return res.status(401).json({ success: false, error: 'Invalid, deactivated, or expired session.' });
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
  if (!emp) {
    await verifyPasswordAsync(password, DUMMY_HASH, DUMMY_SALT).catch(() => false);
    return res.status(401).json({ success: false, error: 'Invalid username or password.' });
  }

  if (!await verifyPasswordAsync(password, emp.passwordHash, emp.salt)) {
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

  await withRetry(async () => {
    await redis.set(EXP_KEYS.empSession(token), session, { ex: SESSION_TTL_SECONDS });
    const rawTokens = await redis.get(`bcci:emp_tokens:${emp.id}`);
    const tokens = rawTokens ? (typeof rawTokens === 'string' ? JSON.parse(rawTokens) : rawTokens) : [];
    tokens.push(token);
    await redis.set(`bcci:emp_tokens:${emp.id}`, tokens, { ex: SESSION_TTL_SECONDS });
  });

  return res.status(200).json({ success: true, session });
}

export default withErrorHandling('EmployeeAuth', handler);
