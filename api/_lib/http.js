// api/_lib/http.js
// CORS, session verification, rate limiting and HTML escaping.

import crypto from 'crypto';
import { kv, KEYS, withRetry } from './kv.js';

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
  const email = await withRetry(() => kv.get(KEYS.adminSession(token)));
  return email || null;
}

/** Returns the applicant's verified email, or null. */
export async function getApplicantSession(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const raw = await withRetry(() => kv.get(KEYS.applicantSession(token)));
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

  // No catch here: treating a lookup error as "no account" would accept a
  // session that a password reset should have revoked. Let it fail closed.
  const accountRaw = await withRetry(() => kv.get(KEYS.account(cleanEmail)));
  if (accountRaw) {
    let account;
    try {
      account = typeof accountRaw === 'string' ? JSON.parse(accountRaw) : accountRaw;
    } catch (err) {
      // A corrupt account row must not 500 every request; it cannot vouch
      // for the session either, so fail closed.
      console.error(`[session] unreadable account record for ${cleanEmail}:`, err.message);
      return null;
    }
    if (account?.passwordUpdatedAt) {
      const pwdUpdatedMs = Date.parse(account.passwordUpdatedAt);
      const issuedMs = typeof issuedAt === 'number' ? issuedAt : (issuedAt ? Date.parse(issuedAt) : NaN);
      if (!Number.isFinite(issuedMs) || issuedMs < pwdUpdatedMs) {
        await kv.del(KEYS.applicantSession(token)).catch(() => {});
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

// ── Rate limiting ──────────────────────────────────────────────────

/**
 * The address the nearest proxy saw. Vercel and Caddy replace
 * X-Forwarded-For, so it holds one entry; a proxy that appends instead (nginx's
 * $proxy_add_x_forwarded_for) leaves client-supplied entries in front, so only
 * the last one — written by our own proxy — can be trusted.
 */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) {
    const hops = fwd.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Fixed-window limiter. Returns { ok, retryAfter }.
 * The TTL is set only when the counter has no window of its own, so neither a
 * repeated attempt nor a refunded one can extend (slide) the window.
 */
export async function rateLimit(key, { max, windowSec }) {
  const k = `bcci:rl:${key}`;
  // One attempt only: INCR is not idempotent, so retrying one that was applied
  // but answered slowly would count a single request twice.
  const count = await withRetry(() => kv.incr(k), 1);
  if (count === 1) {
    // The TTL belongs to the window, not to the first request: a counter that a
    // refund took back to 0 keeps its original deadline, so counting back up to
    // 1 must not restart (slide) the window.
    const ttl = await withRetry(() => kv.ttl(k), 1).catch(() => -1);
    if (ttl < 0) await withRetry(() => kv.expire(k, windowSec)).catch(() => {});
    return { ok: true, remaining: max - 1 };
  }
  if (count > max) {
    let ttl = await kv.ttl(k);
    // A counter left without a TTL (e.g. a crash between INCR and EXPIRE) would
    // otherwise block this key forever — repair it before reporting the wait.
    if (ttl <= 0) {
      await withRetry(() => kv.expire(k, windowSec)).catch(() => {});
      ttl = windowSec;
    }
    return { ok: false, retryAfter: ttl };
  }
  return { ok: true, remaining: max - count };
}

/**
 * Gives back one attempt counted by rateLimit, for limiters meant to count
 * failures only (sign-in): the request is counted up front so parallel
 * guesses cannot slip past, then refunded once it turns out to be legitimate.
 * Best effort — a failed refund only leaves the stricter count in place.
 */
export async function refundRateLimit(key) {
  const k = `bcci:rl:${key}`;
  try {
    const left = await withRetry(() => kv.decr(k), 1);
    // DECR creates the key when the request it refunds was never counted (or its
    // window already ended), and such a key has no TTL of its own: leaving it
    // would hold the key below zero forever. At zero or below it goes.
    if (Number(left) <= 0 && (await withRetry(() => kv.ttl(k), 1).catch(() => -2)) < 0) {
      await withRetry(() => kv.del(k), 1).catch(() => {});
    }
  } catch (err) {
    console.warn(`[rateLimit] refund failed for ${key}:`, err?.message || err);
  }
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
 * An error carrying a 4xx status is a deliberate refusal: its message goes back
 * as is. `statusCode` is the storage layer's spelling (a duplicate application);
 * `status` is what BoardError and PlanError carry.
 */
export function withErrorHandling(name, handler) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      const status = Number(err?.statusCode ?? err?.status);
      if (Number.isInteger(status) && status >= 400 && status < 500 && !res.headersSent) {
        return res.status(status).json({ success: false, error: err.message });
      }
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
