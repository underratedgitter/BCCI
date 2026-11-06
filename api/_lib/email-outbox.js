import { kv } from './kv.js';
import { acquireLock, releaseLock, fencedWrite } from './records.js';
import { sendEmail } from './email.js';
import { OUTBOX_INDEX, outboxKey } from './email-intent.js';
import { KEYS } from './keys.js';

const MAX_ATTEMPTS = 5;

export async function listEmailIntents(limit = 50, { runnableOnly = false } = {}) {
  const size = Math.max(0, Math.min(100, Math.trunc(Number(limit) || 0)));
  if (!size) return [];
  const result = [];
  // Page before filtering: old exhausted entries must not starve later mail.
  for (let offset = 0; result.length < size; offset += 50) {
    const ids = await kv.zrange(OUTBOX_INDEX, offset, offset + 49);
    if (!ids.length) break;
    const items = (await kv.mget(...ids.map(outboxKey))).filter(Boolean);
    result.push(...items.filter((item) => !runnableOnly || ['pending', 'sending'].includes(item.status)));
    if (ids.length < 50) break;
  }
  return result.slice(0, size);
}

// The lease exceeds SMTP's connection/greeting/socket deadlines. A durable
// sending claim is written BEFORE SMTP, so a crash does not lose the intent.
// Delivery is at-least-once: SMTP acceptance followed by a crash before the
// sent write is intrinsically ambiguous and may duplicate on a later retry.
//
// Never throws: every caller has already committed the business write that
// queued the email, so a delivery or storage failure is reported as
// { success: false, error } and retried later from the index.
export async function deliverEmailIntent(id, { force = false, send = sendEmail, now = Date.now } = {}) {
  if (!id) return null;
  const lockName = `email-outbox:${id}`;
  let token = null;
  try {
    token = await acquireLock(lockName, 120, 1, 0);
    if (!token) return { success: false, pending: true };
    const item = await kv.get(outboxKey(id));
    if (!item) return null;
    if (item.status === 'sent') return { success: true, alreadySent: true };
    if (item.status === 'cancelled') return { success: false, cancelled: true };
    // Don't replay an old approval after a later rejection, or a ticket for a
    // removed attendee. This check does not serialize SMTP with future edits.
    const context = item.message.context;
    let obsolete = false;
    if (context?.applicationId) {
      const app = await kv.get(KEYS.app(context.applicationId));
      obsolete = !app || app[context.field] !== id
        || (context.status && app.status !== context.status)
        || (context.renewalStatus && app.renewalStatus !== context.renewalStatus);
    } else if (context?.eventId) {
      const attendees = await kv.get(KEYS.eventAttendees(context.eventId));
      obsolete = !Array.isArray(attendees) || !attendees.some(a => a.ticketId === context.ticketId && a.ticketEmailId === id);
    }
    if (obsolete) {
      await fencedWrite(lockName, token, [
        ['set', outboxKey(id), { ...item, status: 'cancelled' }], ['zrem', OUTBOX_INDEX, id],
      ]);
      return { success: false, cancelled: true };
    }
    if (!force && (item.status === 'failed' || item.nextAttemptAt > now())) {
      return { success: false, pending: item.status !== 'failed', exhausted: item.status === 'failed' };
    }
    const claimed = { ...item, status: 'sending', attempts: item.attempts + 1, nextAttemptAt: now() + 120_000 };
    await fencedWrite(lockName, token, [
      ['set', outboxKey(id), claimed], ['zadd', OUTBOX_INDEX, claimed.nextAttemptAt, id],
    ]);
    let result;
    try { result = await send(item.message); }
    catch { result = { success: false, error: 'Email delivery threw an exception' }; }
    const status = result.success ? 'sent' : claimed.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    const next = { ...claimed, status, lastAttemptAt: now(),
      nextAttemptAt: now() + Math.min(3_600_000, 30_000 * 2 ** (claimed.attempts - 1)) };
    if (result.success) next.sentAt = now();
    else next.lastError = String(result.error || 'Email delivery failed').slice(0, 500);
    await fencedWrite(lockName, token, [
      ['set', outboxKey(id), next],
      ...(result.success ? [['zrem', OUTBOX_INDEX, id]] : [['zadd', OUTBOX_INDEX, next.nextAttemptAt, id]]),
    ]);
    if (!result.success) console.warn(`[Email outbox] ${id}: attempt ${next.attempts}, ${status}`);
    return { success: !!result.success, pending: status === 'pending', exhausted: status === 'failed' };
  } catch (err) {
    // A storage failure, a lapsed lock or an unexpected crash here must not be
    // turned into a failed business action: the intent stays in the index (the
    // lease below releases) and the retry surface reports the message.
    console.warn(`[Email outbox] ${id}: delivery attempt did not complete:`, err?.message || err);
    return { success: false, error: String(err?.message || err || 'Email delivery failed') };
  } finally {
    await releaseLock(lockName, token);
  }
}
