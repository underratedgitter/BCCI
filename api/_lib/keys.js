// api/_lib/keys.js
// Key names and the storage retry helper. Kept apart from redis.js so code
// that only needs a key name does not construct an Upstash client.

// ── Key layout ─────────────────────────────────────────────────────
export const KEYS = {
  app: (id) => `bcci:app:${id}`,
  appSummary: (id) => `bcci:app_summary:${id}`,
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

  event: (id) => `bcci:event:${id}`,
  eventIndex: 'bcci:event_index',
  eventAttendees: (id) => `bcci:event_attendees:${id}`,

  plan: (id) => `bcci:plan:${id}`,
  planIndex: 'bcci:plan_index',

  migrated: (what) => `bcci:migrated:${what}`,

  boardMemberSeq: 'bcci:board:seq:member',
  boardMember: (id) => `bcci:board:member:${id}`,
  boardMemberByEmail: (email) => `bcci:board:member_email:${String(email).trim().toLowerCase()}`,
  boardMeetingSeq: 'bcci:board:seq:meeting',
  boardMeeting: (id) => `bcci:board:meeting:${id}`,
  boardAttendance: (meetingId, memberId) => `bcci:board:att:${meetingId}:${memberId}`,
  boardSession: (token) => `board:${token}`,
  // Mark-by-name: a short pass issued when the projector QR is scanned, and
  // which name each phone (a hashed device id) has marked at a meeting.
  boardPinFails: (meetingId) => `bcci:board:pin_fails:${meetingId}`,
  boardNamePass: (token) => `bcci:board:name_pass:${token}`,
  boardDeviceMark: (meetingId, deviceHash) => `bcci:board:device:${meetingId}:${deviceHash}`,
  boardOtp: (email) => `bcci:board:otp:${String(email).trim().toLowerCase()}`,
  boardOtpTries: (email) => `bcci:board:otp_tries:${String(email).trim().toLowerCase()}`,
  boardOtpClaim: (email) => `bcci:board:otp_claim:${String(email).trim().toLowerCase()}`,
};

// A storage call that hangs must fail fast: without a deadline, one slow
// Upstash hop holds the request for the client's full patience. Retries then stack on top of it.
const STORAGE_TIMEOUT_MS = Number(process.env.STORAGE_TIMEOUT_MS || 8000);

function withTimeout(run, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`storage call exceeded ${ms}ms`), { code: 'STORAGE_TIMEOUT' })),
      ms
    );
  });
  const attempt = Promise.resolve().then(run);
  // If the deadline wins the race, the still-pending attempt must not surface
  // later as an unhandled rejection.
  attempt.catch(() => {});
  return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Retry a storage operation a couple of times before giving up. Upstash is
 * a network hop; a single transient failure should not surface
 * as a 500 to an applicant who is halfway through a form. Each attempt is
 * bounded by STORAGE_TIMEOUT_MS so a hung backend fails fast instead of
 * holding the request open. A deliberate 4xx refusal (a busy lock, a
 * duplicate) is an answer, not a transient failure, so it is not retried.
 */
export async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn, STORAGE_TIMEOUT_MS);
    } catch (err) {
      const status = Number(err?.statusCode);
      if (status >= 400 && status < 500) throw err;
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 120 * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}
