// api/_lib/redis.js
// Shared Upstash Redis client + record store.
//
// Records are stored one-per-key with a sorted-set index instead of a single
// JSON blob, so two concurrent writers can never clobber each other and a
// status lookup no longer downloads every application in the database.
//
// Legacy blobs (bcci:applications / bcci:enquiries) are migrated lazily on
// first access. The old key is left in place as a backup.

import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';
import { summarizeApplication, newTicketId, applyCheckIn } from './record-fields.js';
import { KEYS, withRetry } from './keys.js';
import { emailIntentOps } from './email-intent.js';

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export { KEYS, withRetry };

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

// A cold start's migration is a handful of writes, so a couple of seconds is
// ample; the wait is bounded so a request can never spin on it.
const MIGRATION_POLL_MS = 50;
const MIGRATION_POLLS = 40;
const MIGRATION_CLAIM_TTL_SECONDS = 300;

/**
 * Waits for a concurrent cold start's migration to finish.
 * Returns true when this caller took the claim over (the other one released it,
 * e.g. after a failure, or its lease ran out) and must run the migration
 * itself; false when the migration is done. Throws a retryable 503 when neither
 * happens within the bounded wait, so a request never spins forever.
 */
async function waitForMigration(markerKey) {
  for (let i = 0; i < MIGRATION_POLLS; i++) {
    await new Promise((r) => setTimeout(r, MIGRATION_POLL_MS));
    const status = await redis.get(markerKey);
    if (status === 'done') return false;
    // No claim at all means the migration is unfinished (the other cold start
    // released it or crashed): take it over rather than serve a list as if it
    // were complete.
    if (!status && (await redis.set(markerKey, 'running', { nx: true, ex: MIGRATION_CLAIM_TTL_SECONDS }))) {
      return true;
    }
  }
  // Still running after the wait: answering now would show an empty or partial
  // list as if it were the whole one. withRetry tries again; then the caller
  // gets a 503 and can retry.
  throw Object.assign(new Error('Records are being upgraded. Please try again in a moment.'), { statusCode: 503 });
}

async function migrateLegacy({ legacyKey, indexKey, recordKey, emailKey, marker }) {
  const markerKey = KEYS.migrated(marker);
  const status = await redis.get(markerKey);
  if (status === 'done') return;

  // Claim the migration so two concurrent cold starts don't both run it.
  let claimed = !status && (await redis.set(markerKey, 'running', { nx: true, ex: MIGRATION_CLAIM_TTL_SECONDS }));
  if (!claimed) {
    // Another cold start holds the claim ('running'), or it was released before
    // finishing: wait for it, taking the claim over if it is released.
    claimed = await waitForMigration(markerKey);
    if (!claimed) return;
  }

  try {
    const legacy = (await redis.get(legacyKey)) || [];
    if (Array.isArray(legacy) && legacy.length) {
      for (const raw of legacy) {
        const record = emailKey ? normalizeApplication(raw) : raw;
        if (!record?.id) continue;
        // Never overwrite: a record already under its own key is newer than
        // the legacy copy (this runs again if the marker is ever deleted).
        await redis.set(recordKey(record.id), record, { nx: true });
        // The index entry and the email lookup are idempotent, so they are
        // written even when the record already existed: a marker deleted
        // mid-migration must still end with a complete index.
        await redis.zadd(indexKey, { score: timeOf(record), member: record.id });
        // Nor take an email over from an application filed since.
        if (emailKey && record.email) {
          await redis.set(emailKey(record.email), record.id, { nx: true });
        }
      }
      console.log(`[Migration] ${marker}: moved ${legacy.length} records to per-record keys`);
    }
    await redis.set(markerKey, 'done');
  } catch (err) {
    // Release the claim so the next request can retry.
    await redis.del(markerKey).catch(() => {});
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

/**
 * Newest-first page of applications with document fields reduced to a
 * '[document]' marker. Reads the summary keys, so it never downloads the
 * scans; records written before summaries existed are backfilled once.
 */
export async function listApplicationSummaries({ limit = 500, offset = 0 } = {}) {
  return withRetry(async () => {
    await ensureAppsMigrated();
    const ids = await redis.zrange(KEYS.appIndex, offset, offset + limit - 1, {
      rev: true,
    });
    if (!ids || !ids.length) return [];
    const summaries = await redis.mget(...ids.map(KEYS.appSummary));

    const missing = ids.flatMap((id, i) => (summaries[i] ? [] : [i]));
    for (let c = 0; c < missing.length; c += BACKFILL_CHUNK) {
      await backfillSummaries(ids, summaries, missing.slice(c, c + BACKFILL_CHUNK));
    }
    return summaries.filter(Boolean).map(normalizeApplication);
  });
}

// Full records carry the scans, so the one-time backfill reads them a few
// at a time to bound memory, and writes each chunk in one request.
const BACKFILL_CHUNK = 50;

async function backfillSummaries(ids, summaries, positions) {
  const full = await redis.mget(...positions.map((i) => KEYS.app(ids[i])));
  const pipe = redis.pipeline();
  let writes = 0;
  positions.forEach((pos, j) => {
    const record = normalizeApplication(full[j]);
    if (!record) return;
    // Match by index position, not the stored id, which old records may lack.
    const summary = summarizeApplication({ ...record, id: record.id || ids[pos] });
    summaries[pos] = summary;
    // NX: never overwrite a summary a concurrent update wrote after our read.
    pipe.set(KEYS.appSummary(ids[pos]), summary, { nx: true });
    writes++;
  });
  if (writes) await pipe.exec();
}

/** Status counts and the newest few applications for the admin dashboard. */
export async function getApplicationStats({ recent = 5 } = {}) {
  const total = await countApplications();
  const apps = total > 0 ? await listApplicationSummaries({ limit: total }) : [];
  const count = (status) => apps.filter((a) => a.status === status).length;
  return {
    total,
    pending: count(STATUS.PENDING),
    approved: count(STATUS.APPROVED),
    rejected: count(STATUS.REJECTED),
    recent: apps.slice(0, recent),
  };
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

// ── The email lookup index ─────────────────────────────────────────
// bcci:app_email:<address> holds the id of the one application filed under that
// address. It is claimed with NX and never taken from a record that exists.

/**
 * Points the email lookup key for `email` at `id`, atomically.
 * Returns { ok: true, created } when the key now belongs to `id` — `created` is
 * true only when this call is what put it there, the one case a caller may
 * delete it again — and { ok: false, holder } when another application holds it
 * (`holder` is null when it could not be read: momentarily contended).
 */
async function claimEmailIndex(email, id) {
  const key = KEYS.appByEmail(email);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await redis.set(key, id, { nx: true })) return { ok: true, created: true };
    const holder = await redis.get(key);
    // Released between the two calls: try the claim again.
    if (holder == null) continue;
    // Ours already, e.g. when withRetry re-runs after a slow first attempt.
    if (String(holder) === String(id)) return { ok: true, created: false };
    // Another id holds the key. That is only a stale claim — a crash between
    // the claim and the record write — when its record was never written.
    if (await redis.exists(KEYS.app(String(holder)))) return { ok: false, holder: String(holder) };
    // Withdraw the stale claim, but only while it still holds that same id.
    if (String((await redis.get(key)) ?? '') === String(holder)) await redis.del(key);
  }
  // Still contended after several tries and the holder is gone each time: the
  // address is free but not for us yet. null tells the caller to say so.
  const holder = await redis.get(key);
  return { ok: false, holder: holder == null ? null : String(holder) };
}

export async function putApplication(app) {
  const record = normalizeApplication(app);
  return withRetry(async () => {
    // Claimed before anything is written, and atomically: two filings for the
    // same address can never both believe they own it.
    let emailIndexCreated = false;
    if (record.email) {
      const claim = await claimEmailIndex(record.email, record.id);
      if (!claim.ok) {
        const err = new Error(claim.holder
          ? `An application for this email already exists (${claim.holder}).`
          : 'This email address is being claimed by another submission. Please try again in a moment.');
        err.statusCode = 409;
        throw err;
      }
      emailIndexCreated = claim.created;
    }
    try {
      // One transaction, so the list summary can never disagree with the record.
      await redis
        .multi()
        .set(KEYS.app(record.id), record)
        .set(KEYS.appSummary(record.id), summarizeApplication(record))
        .zadd(KEYS.appIndex, { score: timeOf(record), member: record.id })
        .exec();
    } catch (err) {
      // Withdraw only the lookup this call created for this record: another
      // application's claim, or a key merely found pointing here, must survive.
      if (emailIndexCreated) await redis.del(KEYS.appByEmail(record.email)).catch(() => {});
      throw err;
    }
    return record;
  });
}

/**
 * Keeps the email lookup index in step after an edit. Best effort: the record
 * is the source of truth and has already been committed, so a lookup that
 * cannot be updated is reported, never turned into a failed edit.
 */
async function syncApplicationEmailIndex(id, current, next) {
  const oldEmail = String(current?.email || '').trim();
  const newEmail = String(next?.email || '').trim();
  if (newEmail) {
    const claim = await claimEmailIndex(newEmail, id);
    // Another application still uses this address: keep the old lookup rather
    // than leave this record unreachable by email.
    if (!claim.ok) {
      console.warn(`[Applications] ${id}: the email lookup for ${newEmail} is held by ${claim.holder || 'another submission'}; keeping ${oldEmail || 'its previous one'}`);
      return;
    }
  }
  if (oldEmail && oldEmail.toLowerCase() !== newEmail.toLowerCase()) {
    const oldKey = KEYS.appByEmail(oldEmail);
    // Only drop the old address while it still points at this record.
    if (String((await redis.get(oldKey)) ?? '') === String(id)) await redis.del(oldKey);
  }
}

/**
 * Read-modify-write a single application. Because each record lives under its
 * own key, this only races with concurrent edits to the *same* application —
 * and a per-id lock serializes those, so two admins acting at once can't
 * clobber each other.
 */
export async function updateApplication(id, mutate, notificationFor = null) {
  return withRetry(async () => {
    await ensureAppsMigrated();
    const lockName = `application:${id}`;
    const lock = await acquireLock(lockName);
    // Writing without the lock could overwrite a concurrent edit; refuse instead.
    if (!lock) {
      throw Object.assign(new Error('This application is being updated by someone else. Please try again.'), { statusCode: 409 });
    }
    try {
      const current = normalizeApplication(await redis.get(KEYS.app(id)));
      if (!current) return null;
      const next = normalizeApplication(mutate({ ...current }));
      // One atomic, lock-checked write, so the list summary can never disagree
      // with the record and a lapsed lock cannot overwrite a newer edit.
      const ops = [
        ['set', KEYS.app(id), next],
        ['set', KEYS.appSummary(id), summarizeApplication(next)],
      ];
      if (notificationFor) {
        const intent = notificationFor(next, current);
        if (intent) ops.push(...emailIntentOps(intent.id, intent.message));
      }
      // A resubmission moves submittedAt; keep the list order in step. Records
      // without a usable date keep their slot rather than jumping to the top.
      const submitted = Date.parse(next.submittedAt || '');
      if (Number.isFinite(submitted)) ops.push(['zadd', KEYS.appIndex, submitted, id]);
      await fencedWrite(lockName, lock, ops);
      // The email lookup follows the record it points at, so it is written after
      // the commit: it is claimed with NX (never taken from another application)
      // and the old address is dropped when the email changed.
      await syncApplicationEmailIndex(id, current, next).catch((err) => {
        console.warn(`[Applications] ${id}: the email lookup was not updated:`, err?.message || err);
      });
      return next;
    } finally {
      await releaseLock(lockName, lock);
    }
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

// ── Events ─────────────────────────────────────────────────────────

export async function getEvent(id) {
  if (!id) return null;
  return withRetry(async () => {
    const data = await redis.get(KEYS.event(id));
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data;
  });
}

export async function putEvent(event) {
  if (!event || !event.id) throw new Error('Event must have an ID');
  const record = {
    ...event,
    registeredCount: Number(event.registeredCount) || 0,
    updatedAt: new Date().toISOString(),
  };
  return withRetry(async () => {
    await redis.set(KEYS.event(record.id), record);
    const t = Date.parse(record.date || record.createdAt || '') || Date.now();
    await redis.zadd(KEYS.eventIndex, { score: t, member: record.id });
    return record;
  });
}

export async function listEvents({ limit = 100, offset = 0 } = {}) {
  return withRetry(async () => {
    const ids = await redis.zrange(KEYS.eventIndex, offset, offset + limit - 1, {
      rev: true,
    });
    if (!ids || !ids.length) return [];
    const records = await redis.mget(...ids.map(KEYS.event));
    return records.filter(Boolean).map(r => (typeof r === 'string' ? JSON.parse(r) : r));
  });
}

export async function deleteEvent(id) {
  if (!id) return false;
  return withRetry(async () => {
    // Registration, payment confirmation and check-in hold this lock while
    // they read and write the event back; deleting without it let one of
    // them recreate the event just deleted.
    const lockToken = await acquireLock(`eventreg:${id}`);
    if (!lockToken) {
      throw Object.assign(new Error('This event is being updated. Try deleting it again in a moment.'), { statusCode: 409 });
    }
    try {
      await fencedWrite(`eventreg:${id}`, lockToken, [
        ['del', KEYS.event(id)],
        ['del', KEYS.eventAttendees(id)],
        ['zrem', KEYS.eventIndex, id],
      ]);
      return true;
    } finally {
      await releaseLock(`eventreg:${id}`, lockToken);
    }
  });
}

// ── Membership plans (admin-added tiers; built-ins live in code) ───

/** Admin-added membership plans, oldest first. */
export async function listCustomPlans() {
  return withRetry(async () => {
    const ids = await redis.zrange(KEYS.planIndex, 0, -1);
    if (!ids || !ids.length) return [];
    const records = await redis.mget(...ids.map(KEYS.plan));
    return records.filter(Boolean).map(r => (typeof r === 'string' ? JSON.parse(r) : r));
  });
}

// Serializes plan adds, so the cap below is checked against a count nobody can
// change until this insert has finished.
const PLAN_LOCK = 'membership-plans';

/**
 * Stores a new plan together with its index entry.
 * Returns { ok: true } when it was written, { ok: false, reason: 'duplicate' }
 * when the id is taken, and { ok: false, reason: 'limit' } when `max` plans
 * already exist. The cap and the write happen under one lock, so two admins
 * adding a tier at the same moment cannot overshoot it.
 */
export async function insertCustomPlan(plan, { max = Infinity } = {}) {
  if (!plan || !plan.id) throw new Error('Membership plan must have an ID');
  return withRetry(async () => {
    const lock = await acquireLock(PLAN_LOCK);
    if (!lock) {
      throw Object.assign(new Error('Membership types are being updated. Please try again in a moment.'), { statusCode: 409 });
    }
    try {
      // NX makes the id (a slug of the name) the uniqueness guarantee, so two
      // admins adding the same tier at once cannot both succeed.
      const created = await redis.set(KEYS.plan(plan.id), plan, { nx: true });
      if (!created) {
        // A retried attempt whose first write landed is this same plan, not a clash.
        const stored = await redis.get(KEYS.plan(plan.id));
        return stored && stored.createdAt === plan.createdAt ? { ok: true } : { ok: false, reason: 'duplicate' };
      }
      // Under the same lock the claim above was taken with, so the count cannot
      // change between the check and the write: the cap is exact.
      if (Number.isFinite(max) && (await redis.zcard(KEYS.planIndex)) >= max) {
        await redis.del(KEYS.plan(plan.id)).catch(() => {});
        return { ok: false, reason: 'limit' };
      }
      try {
        // The plan and its index entry commit together, so a plan can never be
        // stored without appearing in the list (or the other way round).
        await redis
          .multi()
          .set(KEYS.plan(plan.id), plan)
          .zadd(KEYS.planIndex, { score: Date.parse(plan.createdAt) || Date.now(), member: plan.id })
          .exec();
      } catch (err) {
        // Leave neither half behind, so the next attempt starts clean.
        await redis.del(KEYS.plan(plan.id)).catch(() => {});
        throw err;
      }
      return { ok: true };
    } finally {
      await releaseLock(PLAN_LOCK, lock);
    }
  });
}

/** Removes a plan and its index entry together; false when it did not exist. */
export async function deleteCustomPlan(id) {
  if (!id) return false;
  return withRetry(async () => {
    // Both halves go in one transaction, so no listing can keep serving a plan
    // whose record is gone.
    const [removed] = await redis.multi().del(KEYS.plan(id)).zrem(KEYS.planIndex, id).exec();
    return Number(removed) > 0;
  });
}

export async function getEventAttendees(id) {
  if (!id) return [];
  return withRetry(async () => {
    const attendees = await redis.get(KEYS.eventAttendees(id));
    if (!attendees) return [];
    return Array.isArray(attendees) ? attendees : (typeof attendees === 'string' ? JSON.parse(attendees) : []);
  });
}

export async function registerForEvent(id, attendee) {
  if (!id || !attendee || !attendee.email) {
    return { success: false, error: 'Event ID and attendee email are required.' };
  }
  const email = String(attendee.email).trim().toLowerCase();

  return withRetry(async () => {
    const lockToken = await acquireLock(`eventreg:${id}`);
    if (!lockToken) {
      return { success: false, error: 'Registration service is busy. Please try again in a moment.' };
    }

    try {
      const rawEvent = await redis.get(KEYS.event(id));
      if (!rawEvent) {
        return { success: false, error: 'Event not found.' };
      }
      const event = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;

      const capacity = Number(event.capacity) || 0;
      const currentCount = Number(event.registeredCount) || 0;
      if (capacity > 0 && currentCount >= capacity) {
        return { success: false, error: 'This event has reached maximum capacity.' };
      }

      const rawAttendees = await redis.get(KEYS.eventAttendees(id));
      let attendees = [];
      if (rawAttendees) {
        attendees = Array.isArray(rawAttendees) ? rawAttendees : (typeof rawAttendees === 'string' ? JSON.parse(rawAttendees) : []);
      }

      if (attendees.some(a => String(a.email || '').trim().toLowerCase() === email)) {
        return { success: false, error: 'You are already registered for this event.' };
      }

      const isPaid = event.pricingType === 'paid' && Number(event.fee) > 0;
      const initialStatus = isPaid ? 'pending' : 'confirmed';
      const initialPaymentStatus = isPaid ? 'pending_verification' : 'confirmed';

      // Confirmation looks tickets up by ID, so re-draw on a clash.
      const taken = new Set(attendees.map((a) => a.ticketId));
      let ticketId;
      do {
        ticketId = newTicketId(id);
      } while (taken.has(ticketId));
      const newAttendee = {
        ticketId,
        name: String(attendee.name || '').trim(),
        email,
        phone: String(attendee.phone || '').trim(),
        company: String(attendee.company || '').trim() || 'Delegate / Independent',
        paymentRef: String(attendee.paymentRef || '').trim() || null,
        status: initialStatus,
        paymentStatus: initialPaymentStatus,
        registeredAt: new Date().toISOString(),
      };

      attendees.push(newAttendee);
      event.registeredCount = currentCount + 1;

      await fencedWrite(`eventreg:${id}`, lockToken, [
        ['set', KEYS.eventAttendees(id), attendees],
        ['set', KEYS.event(id), event],
      ]);

      return { success: true, event, attendee: newAttendee, ticketId };
    } finally {
      await releaseLock(`eventreg:${id}`, lockToken);
    }
  });
}

export async function confirmEventPayment(id, ticketId, confirmedBy = 'admin') {
  if (!id || !ticketId) {
    return { success: false, error: 'Event ID and ticket ID are required.' };
  }
  return withRetry(async () => {
    const lockToken = await acquireLock(`eventreg:${id}`);
    if (!lockToken) {
      return { success: false, error: 'Event service is busy. Please try again in a moment.' };
    }

    try {
      const rawEvent = await redis.get(KEYS.event(id));
      if (!rawEvent) {
        return { success: false, error: 'Event not found.' };
      }
      const event = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;

      const rawAttendees = await redis.get(KEYS.eventAttendees(id));
      let attendees = [];
      if (rawAttendees) {
        attendees = Array.isArray(rawAttendees) ? rawAttendees : (typeof rawAttendees === 'string' ? JSON.parse(rawAttendees) : []);
      }

      const idx = attendees.findIndex(a => a.ticketId === ticketId);
      if (idx === -1) {
        return { success: false, error: 'Attendee ticket not found.' };
      }

      const alreadyConfirmed = attendees[idx].paymentStatus === 'confirmed' || attendees[idx].status === 'confirmed';

      if (!alreadyConfirmed) {
        attendees[idx] = {
          ...attendees[idx],
          status: 'confirmed',
          paymentStatus: 'confirmed',
          confirmedAt: new Date().toISOString(),
          confirmedBy,
          ticketEmailId: `ticket-${crypto.randomUUID()}`,
        };
        const attendee = attendees[idx];
        await fencedWrite(`eventreg:${id}`, lockToken, [
          ['set', KEYS.eventAttendees(id), attendees],
          ...emailIntentOps(attendee.ticketEmailId, {
            type: 'event_ticket', to: attendee.email,
            context: { eventId: id, ticketId: attendee.ticketId },
            data: {
              ticketId: attendee.ticketId, eventTitle: event.title, date: event.date,
              time: event.time, venue: event.venue, mode: event.mode,
              pricingType: event.pricingType, fee: event.fee, paymentRef: attendee.paymentRef,
              attendeeName: attendee.name, company: attendee.company, phone: attendee.phone, email: attendee.email,
            },
          }),
        ]);
      }

      return {
        success: true,
        event,
        attendee: attendees[idx],
        alreadyConfirmed,
      };
    } finally {
      await releaseLock(`eventreg:${id}`, lockToken);
    }
  });
}

/**
 * Marks an attendee present (or clears a mistaken check-in). Idempotent: a
 * second scan of the same ticket reports the original time instead of
 * overwriting it. A paid ticket whose payment is still unverified is refused
 * with code 'payment_pending' so the desk can settle it first.
 */
export async function setAttendeeCheckIn(id, ticketId, { checkedIn = true, by = 'admin', method = 'scan' } = {}) {
  if (!id || !ticketId) {
    return { success: false, code: 'invalid', error: 'Event ID and ticket ID are required.' };
  }
  return withRetry(async () => {
    const lockToken = await acquireLock(`eventreg:${id}`);
    if (!lockToken) {
      return { success: false, code: 'busy', error: 'Event service is busy. Please try again in a moment.' };
    }

    try {
      const rawEvent = await redis.get(KEYS.event(id));
      if (!rawEvent) {
        return { success: false, code: 'not_found', error: 'Event not found.' };
      }
      const event = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;

      const rawAttendees = await redis.get(KEYS.eventAttendees(id));
      let attendees = [];
      if (rawAttendees) {
        attendees = Array.isArray(rawAttendees) ? rawAttendees : (typeof rawAttendees === 'string' ? JSON.parse(rawAttendees) : []);
      }

      const idx = attendees.findIndex(a => a.ticketId === ticketId);
      if (idx === -1) {
        return { success: false, code: 'not_found', error: 'Attendee ticket not found.' };
      }

      const outcome = applyCheckIn(attendees[idx], { checkedIn, by, method });
      if (!outcome.success) return outcome;
      if (outcome.changed) {
        attendees[idx] = outcome.attendee;
        await fencedWrite(`eventreg:${id}`, lockToken, [['set', KEYS.eventAttendees(id), attendees]]);
      }
      return { ...outcome, event };
    } finally {
      await releaseLock(`eventreg:${id}`, lockToken);
    }
  });
}

/**
 * Removes one attendee (e.g. a fake or duplicate registration) and frees
 * their seat. Returns { success, attendee } or { success: false, error }.
 */
export async function removeEventAttendee(id, ticketId) {
  if (!id || !ticketId) {
    return { success: false, error: 'Event ID and ticket ID are required.' };
  }
  return withRetry(async () => {
    const lockToken = await acquireLock(`eventreg:${id}`);
    if (!lockToken) {
      return { success: false, error: 'Event service is busy. Please try again in a moment.' };
    }

    try {
      const rawEvent = await redis.get(KEYS.event(id));
      if (!rawEvent) {
        return { success: false, error: 'Event not found.' };
      }
      const event = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;

      const rawAttendees = await redis.get(KEYS.eventAttendees(id));
      let attendees = [];
      if (rawAttendees) {
        attendees = Array.isArray(rawAttendees) ? rawAttendees : (typeof rawAttendees === 'string' ? JSON.parse(rawAttendees) : []);
      }

      const idx = attendees.findIndex(a => a.ticketId === ticketId);
      if (idx === -1) {
        return { success: false, error: 'Attendee ticket not found.' };
      }

      const [removed] = attendees.splice(idx, 1);
      event.registeredCount = Math.max(0, (Number(event.registeredCount) || 0) - 1);

      await fencedWrite(`eventreg:${id}`, lockToken, [
        ['set', KEYS.eventAttendees(id), attendees],
        ['set', KEYS.event(id), event],
      ]);

      return { success: true, event, attendee: removed };
    } finally {
      await releaseLock(`eventreg:${id}`, lockToken);
    }
  });
}

// ── Cooperative locks ────────────────────────────────────────────
// Token-checked: release only deletes the key when the token still matches,
// so a slow holder can never delete the next holder's lock after its own
// TTL expired. Returns the token, or null when the lock stayed busy.

// A lock can expire while its holder is still working (a slow or retried
// storage call). Every write made under a lock therefore goes through one
// Lua script that checks the holder's token and applies all the writes
// atomically, or none of them. A holder whose lock lapsed gets a clean 409
// instead of overwriting whoever took the lock next.
const FENCED_WRITE = `-- bcci-fenced-write
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
for i = 2, #KEYS do
  local op = string.sub(ARGV[i], 1, 1)
  local arg = string.sub(ARGV[i], 3)
  if op == 'S' then redis.call('set', KEYS[i], arg)
  elseif op == 'D' then redis.call('del', KEYS[i])
  elseif op == 'Z' then
    local sep = string.find(arg, ':', 1, true)
    redis.call('zadd', KEYS[i], string.sub(arg, 1, sep - 1), string.sub(arg, sep + 1))
  elseif op == 'R' then redis.call('zrem', KEYS[i], arg)
  end
end
return 1`;

/** Encodes a value exactly as the Upstash client does for SET. */
const encodeValue = (v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

/**
 * Applies writes only while `token` still holds the lock `name`.
 * ops: ['set', key, value] | ['del', key] | ['zadd', key, score, member] | ['zrem', key, member]
 * Throws a 409 when the lock has passed to someone else.
 */
export async function fencedWrite(name, token, ops) {
  const keys = [`bcci:lock:${name}`];
  const args = [String(token || '')];
  for (const [op, key, a, b] of ops) {
    keys.push(key);
    if (op === 'set') args.push(`S:${encodeValue(a)}`);
    else if (op === 'del') args.push('D:');
    else if (op === 'zadd') args.push(`Z:${Number(a)}:${b}`);
    else if (op === 'zrem') args.push(`R:${a}`);
    else throw new Error(`fencedWrite: unknown op ${op}`);
  }
  const applied = await redis.eval(FENCED_WRITE, keys, args);
  if (Number(applied) !== 1) {
    throw Object.assign(new Error('This record was being updated at the same time. Please try again.'), { statusCode: 409 });
  }
}

export async function acquireLock(name, ttlSeconds = 15, waits = 25, waitMs = 40) {
  const key = `bcci:lock:${name}`;
  const token = crypto.randomUUID();
  for (let i = 0; i < waits; i++) {
    const ok = await redis.set(key, token, { nx: true, ex: ttlSeconds });
    if (ok) return token;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return null;
}

export async function releaseLock(name, token) {
  // Without the holder's token there is nothing of ours to release; deleting
  // the key would free a lock someone else holds.
  if (!token) return;
  const key = `bcci:lock:${name}`;
  try {
    await redis.eval(
      'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',
      [key],
      [token]
    );
  } catch (err) {
    // The lock's TTL frees it shortly; a blind DEL here could free the next holder's.
    console.warn(`[Lock] release of ${name} failed:`, err?.message || err);
  }
}
