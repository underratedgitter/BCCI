// api/_lib/redis.js
// Shared Upstash Redis client + record store.
//
// Records are stored one-per-key with a sorted-set index instead of a single
// JSON blob, so two concurrent writers can never clobber each other and a
// status lookup no longer downloads every application in the database.
//
// Legacy blobs (bcci:applications / bcci:enquiries) are migrated lazily on
// first access. The old key is left in place as a backup.

import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── Key layout ─────────────────────────────────────────────────────
export const KEYS = {
  app: (id) => `bcci:app:${id}`,
  appIndex: 'bcci:app_index',
  appByEmail: (email) => `bcci:app_email:${String(email).trim().toLowerCase()}`,
  appLegacy: 'bcci:applications',

  enq: (id) => `bcci:enq:${id}`,
  enqIndex: 'bcci:enq_index',
  enqLegacy: 'bcci:enquiries',

  adminSession: (token) => `admin:${token}`,
  applicantSession: (token) => `applicant:${token}`,

  account: (email) => `bcci:account:${String(email).trim().toLowerCase()}`,
  otpReset: (email) => `bcci:otp:reset:${String(email).trim().toLowerCase()}`,

  migrated: (what) => `bcci:migrated:${what}`,
};

/**
 * Retry a Redis operation a couple of times before giving up. Upstash is a
 * network hop; a single transient failure should not surface as a 500 to an
 * applicant who is halfway through a form.
 */
export async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 120 * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

/** Redis is reachable and responding. Used by /api/health. */
export async function ping() {
  const probe = `bcci:health:${Date.now()}`;
  await redis.set(probe, '1', { ex: 10 });
  const v = await redis.get(probe);
  await redis.del(probe).catch(() => {});
  return v === '1' || v === 1;
}

// ── Status normalisation ───────────────────────────────────────────
// Historic rows were written as 'pending' (lowercase) while every reader
// compares against 'Pending'. Everything funnels through here so the two can
// never drift apart again.

export const STATUS = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export function normalizeStatus(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'approved') return STATUS.APPROVED;
  if (s === 'rejected' || s === 'declined') return STATUS.REJECTED;
  return STATUS.PENDING;
}

function normalizeApplication(app) {
  if (!app || typeof app !== 'object') return null;
  return { ...app, status: normalizeStatus(app.status) };
}

function timeOf(record) {
  const t = Date.parse(record?.submittedAt || '');
  return Number.isFinite(t) ? t : Date.now();
}

// ── One-time migration from the legacy single-blob layout ──────────

async function migrateLegacy({ legacyKey, indexKey, recordKey, emailKey, marker }) {
  const done = await redis.get(KEYS.migrated(marker));
  if (done) return;

  // Claim the migration so two concurrent cold starts don't both run it.
  const claimed = await redis.set(KEYS.migrated(marker), 'running', {
    nx: true,
    ex: 300,
  });
  if (!claimed) return;

  try {
    const legacy = (await redis.get(legacyKey)) || [];
    if (Array.isArray(legacy) && legacy.length) {
      for (const raw of legacy) {
        const record = emailKey ? normalizeApplication(raw) : raw;
        if (!record?.id) continue;
        await redis.set(recordKey(record.id), record);
        await redis.zadd(indexKey, { score: timeOf(record), member: record.id });
        if (emailKey && record.email) {
          await redis.set(emailKey(record.email), record.id);
        }
      }
      console.log(`[Migration] ${marker}: moved ${legacy.length} records to per-record keys`);
    }
    await redis.set(KEYS.migrated(marker), 'done');
  } catch (err) {
    // Release the claim so the next request can retry.
    await redis.del(KEYS.migrated(marker)).catch(() => {});
    throw err;
  }
}

const ensureAppsMigrated = () =>
  migrateLegacy({
    legacyKey: KEYS.appLegacy,
    indexKey: KEYS.appIndex,
    recordKey: KEYS.app,
    emailKey: KEYS.appByEmail,
    marker: 'applications',
  });

const ensureEnquiriesMigrated = () =>
  migrateLegacy({
    legacyKey: KEYS.enqLegacy,
    indexKey: KEYS.enqIndex,
    recordKey: KEYS.enq,
    emailKey: null,
    marker: 'enquiries',
  });

// ── Applications ───────────────────────────────────────────────────

/** Newest-first page of applications. */
export async function listApplications({ limit = 500, offset = 0 } = {}) {
  return withRetry(async () => {
    await ensureAppsMigrated();
    const ids = await redis.zrange(KEYS.appIndex, offset, offset + limit - 1, {
      rev: true,
    });
    if (!ids || !ids.length) return [];
    const records = await redis.mget(...ids.map(KEYS.app));
    return records.filter(Boolean).map(normalizeApplication);
  });
}

export async function countApplications() {
  await ensureAppsMigrated();
  return (await redis.zcard(KEYS.appIndex)) || 0;
}

export async function getApplication(id) {
  if (!id) return null;
  return withRetry(async () => {
    await ensureAppsMigrated();
    return normalizeApplication(await redis.get(KEYS.app(id)));
  });
}

export async function getApplicationByEmail(email) {
  if (!email) return null;
  return withRetry(async () => {
    await ensureAppsMigrated();
    const id = await redis.get(KEYS.appByEmail(email));
    if (!id) return null;
    return normalizeApplication(await redis.get(KEYS.app(id)));
  });
}

export async function putApplication(app) {
  const record = normalizeApplication(app);
  return withRetry(async () => {
    await redis.set(KEYS.app(record.id), record);
    await redis.zadd(KEYS.appIndex, { score: timeOf(record), member: record.id });
    if (record.email) await redis.set(KEYS.appByEmail(record.email), record.id);
    return record;
  });
}

/**
 * Read-modify-write a single application. Because each record lives under its
 * own key, this only races with concurrent edits to the *same* application —
 * not with every other write in the system.
 */
export async function updateApplication(id, mutate) {
  return withRetry(async () => {
    await ensureAppsMigrated();
    const current = normalizeApplication(await redis.get(KEYS.app(id)));
    if (!current) return null;
    const next = normalizeApplication(mutate({ ...current }));
    await redis.set(KEYS.app(id), next);
    if (next.email) await redis.set(KEYS.appByEmail(next.email), next.id);
    return next;
  });
}

// ── Enquiries ──────────────────────────────────────────────────────

export async function listEnquiries({ limit = 500, offset = 0 } = {}) {
  return withRetry(async () => {
    await ensureEnquiriesMigrated();
    const ids = await redis.zrange(KEYS.enqIndex, offset, offset + limit - 1, {
      rev: true,
    });
    if (!ids || !ids.length) return [];
    const records = await redis.mget(...ids.map(KEYS.enq));
    return records.filter(Boolean);
  });
}

export async function countEnquiries() {
  await ensureEnquiriesMigrated();
  return (await redis.zcard(KEYS.enqIndex)) || 0;
}

export async function putEnquiry(enquiry) {
  return withRetry(async () => {
    await redis.set(KEYS.enq(enquiry.id), enquiry);
    await redis.zadd(KEYS.enqIndex, {
      score: timeOf(enquiry),
      member: enquiry.id,
    });
    return enquiry;
  });
}

/** Drop enquiries beyond the newest `keep`, so the index cannot grow forever. */
export async function trimEnquiries(keep = 1000) {
  const total = (await redis.zcard(KEYS.enqIndex)) || 0;
  if (total <= keep) return 0;
  const stale = await redis.zrange(KEYS.enqIndex, 0, total - keep - 1);
  if (!stale || !stale.length) return 0;
  await redis.del(...stale.map(KEYS.enq));
  await redis.zrem(KEYS.enqIndex, ...stale);
  return stale.length;
}
