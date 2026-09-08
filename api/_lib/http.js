// api/_lib/http.js
// CORS, session verification, rate limiting and HTML escaping.

import crypto from 'crypto';
import { redis, KEYS, withRetry } from './redis.js';

// ── CORS ───────────────────────────────────────────────────────────

/**
 * Allowed browser origins. ALLOWED_ORIGIN may hold a comma-separated list.
 * Same-origin requests (which the portal itself makes) send no Origin header
 * at all, so they never depend on this.
 */
function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGIN || 'https://bccibharuch.in';
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

export function applyCors(req, res, methods = 'GET, POST, OPTIONS') {
  const list = allowedOrigins();
  const origin = req.headers.origin;

  // Echo the origin only when it is on the allow-list; never reflect blindly.
  if (origin && list.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', list[0]);
  }

  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
}

/** Handles the preflight. Returns true when the request is finished. */
export function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// ── Sessions ───────────────────────────────────────────────────────

export function bearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

/** Returns the admin's email, or null. */
export async function getAdminSession(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const email = await withRetry(() => redis.get(KEYS.adminSession(token)));
  return email || null;
}

/** Returns the applicant's verified email, or null. */
export async function getApplicantSession(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const raw = await withRetry(() => redis.get(KEYS.applicantSession(token)));
  if (!raw) return null;

  let email = null;
  let issuedAt = null;
  if (typeof raw === 'object' && raw !== null) {
    email = raw.email;
    issuedAt = raw.issuedAt;
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.email) {
        email = parsed.email;
        issuedAt = parsed.issuedAt;
      } else {
        email = raw;
      }
    } catch {
      email = raw;
    }
  }
  if (!email) return null;
  const cleanEmail = String(email).toLowerCase();

  const accountRaw = await redis.get(KEYS.account(cleanEmail)).catch(() => null);
  if (accountRaw) {
    const account = typeof accountRaw === 'string' ? JSON.parse(accountRaw) : accountRaw;
    if (account?.passwordUpdatedAt) {
      const pwdUpdatedMs = Date.parse(account.passwordUpdatedAt);
      const issuedMs = typeof issuedAt === 'number' ? issuedAt : (issuedAt ? Date.parse(issuedAt) : NaN);
      if (!Number.isFinite(issuedMs) || issuedMs < pwdUpdatedMs) {
        await redis.del(KEYS.applicantSession(token)).catch(() => {});
        return null;
      }
    }
  }

  return cleanEmail;
}

/** Writes a 401 and returns null when there is no valid admin session. */
export async function requireAdmin(req, res) {
  const email = await getAdminSession(req);
  if (!email) {
    res.status(401).json({ success: false, error: 'Admin authentication required.' });
    return null;
  }
  return email;
}

/** Returns the employee session object, or null. */
export async function getEmployeeSession(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const raw = await withRetry(() => redis.get(`bcci:employee_session:${token}`));
  if (!raw) return null;
  const session = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!session || !session.employeeId) return null;

  // Revalidate employee status in database
  let emp = null;
  if (session.id) {
    const rawEmp = await withRetry(() => redis.get(`bcci:emp:${session.id}`));
    if (rawEmp) emp = typeof rawEmp === 'string' ? JSON.parse(rawEmp) : rawEmp;
  }
  if (!emp && session.employeeId) {
    const empId = await withRetry(() => redis.get(`bcci:emp_code:${session.employeeId.toUpperCase()}`));
    if (empId) {
      const rawEmp = await withRetry(() => redis.get(`bcci:emp:${empId}`));
      if (rawEmp) emp = typeof rawEmp === 'string' ? JSON.parse(rawEmp) : rawEmp;
    }
  }

  if (emp && emp.status === 'inactive') {
    await redis.del(`bcci:employee_session:${token}`).catch(() => {});
    return null;
  }

  return session;
}

/** Writes a 401 and returns null when there is no valid employee session. */
export async function requireEmployee(req, res) {
  const session = await getEmployeeSession(req);
  if (!session || !session.employeeId) {
    res.status(401).json({ success: false, error: 'Employee authentication required.' });
    return null;
  }
  return session;
}

// ── Rate limiting ──────────────────────────────────────────────────

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Fixed-window limiter. Returns { ok, retryAfter }.
 * The TTL is set only when the counter is created, so repeated attempts can
 * never extend their own window.
 */
export async function rateLimit(key, { max, windowSec }) {
  const k = `bcci:rl:${key}`;
  const count = await withRetry(() => redis.incr(k));
  if (count === 1) {
    await redis.expire(k, windowSec);
    return { ok: true, remaining: max - 1 };
  }
  if (count > max) {
    const ttl = await redis.ttl(k);
    return { ok: false, retryAfter: ttl > 0 ? ttl : windowSec };
  }
  return { ok: true, remaining: max - count };
}

export function tooManyRequests(res, retryAfter, message) {
  res.setHeader('Retry-After', String(retryAfter || 60));
  return res.status(429).json({
    success: false,
    error: message || `Too many requests. Try again in ${retryAfter} seconds.`,
  });
}

// ── Constant-time secret comparison ────────────────────────────────

/**
 * Hashes both sides to a fixed 32 bytes before comparing, so the comparison
 * cannot leak the length of the expected secret through an early return.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ── Escaping ───────────────────────────────────────────────────────

/** Escapes a value for interpolation into an HTML email template. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Body helpers ───────────────────────────────────────────────────

/** Trims a string field and caps its length. */
export function str(value, maxLen = 500) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maxLen);
}

export const isEmail = (v) =>
  typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) && v.length <= 254;

/**
 * Normalises an Indian mobile number to 10 digits, stripping +91, 91, or leading 0 prefixes.
 */
export function cleanPhone(value) {
  if (value === null || value === undefined) return '';
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

// ── Error handling ─────────────────────────────────────────────────

/**
 * Wraps a handler so an unexpected throw becomes a clean 500 with a
 * correlation id in the logs, rather than a raw stack trace to the client.
 */
export function withErrorHandling(name, handler) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      const ref = crypto.randomBytes(4).toString('hex');
      console.error(`[${name}] ref=${ref}`, err?.stack || err?.message || err);
      if (res.headersSent) return;
      return res.status(500).json({
        success: false,
        error: 'Something went wrong on our side. Please try again.',
        ref,
      });
    }
  };
}
