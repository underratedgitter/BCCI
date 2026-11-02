// api/board.js
// The board portal and its administration, one route with an `action`.
//
// Board members (their own session, from an emailed sign-in code):
//   POST request-code, verify-code, attend, sign-out      GET me
// Anyone who scanned the attendance QR (no session):
//   POST names, mark-name
// Superadmin (the existing admin session):
//   GET  members, meetings, meeting, live, register
//   POST member-save, member-status, member-welcome, meeting-save,
//        meeting-open, meeting-close, meeting-reopen, meeting-delete, mark
//
// A board session lives under its own key prefix, so it can never be used
// as an admin session or an applicant session, and the reverse.

import crypto from 'node:crypto';
import { kv, KEYS, withRetry } from './_lib/kv.js';
import {
  applyCors,
  handlePreflight,
  bearerToken,
  getAdminSession,
  rateLimit,
  tooManyRequests,
  clientIp,
  safeEqual,
  str,
  isEmail,
  cleanPhone,
  withErrorHandling,
} from './_lib/http.js';
import { sendEmailWithin } from './_lib/email.js';
import {
  BoardError,
  listMembers,
  getMember,
  getMemberByEmail,
  saveMember,
  setMemberStatus,
  validateMemberFields,
  listMeetings,
  getMeeting,
  saveMeeting,
  validateMeetingFields,
  setMeetingStatus,
  deleteMeeting,
  resolveOpenMeeting,
  markBySelf,
  openNameMarking,
  markByName,
  markBySecretary,
  meetingDetail,
  memberHistory,
  publicMeeting,
  rosterAndMarks,
} from './_lib/board.js';
import { buildRegister } from './_lib/board-register.js';

const OTP_TTL_SECONDS = 600;
const OTP_MAX_TRIES = 5;
// A session lapses after 30 idle days and renews itself on use, but never
// outlives 90 days from sign-in, so a stolen token cannot be kept alive.
const SESSION_TTL_SECONDS = 30 * 24 * 3600;
const SESSION_MAX_AGE_SECONDS = 90 * 24 * 3600;
// What sessions issued before the ceiling existed were given.
const LEGACY_SESSION_TTL_SECONDS = 180 * 24 * 3600;

const profileView = (m) => ({
  id: m.id, name: m.name, designation: m.designation, email: m.email, mobile: m.mobile, company: m.company || '',
});

/**
 * Renews a live session once less than half its idle window is left, clamped
 * to the 90-day ceiling. Returns the seconds it has left, or 0 when it has
 * ended. Renewal uses EXPIRE, which cannot recreate a key that a concurrent
 * sign-out just deleted.
 */
async function slideSession(key, session, now = Date.now()) {
  const ttl = await withRetry(() => kv.ttl(key));
  if (ttl === -2) return 0;
  if (ttl === -1) {
    // Every session is written with an expiry; one without is not ours.
    await kv.del(key).catch(() => {});
    return 0;
  }

  // Sessions from before the ceiling carry no issuedAt; their 180-day TTL
  // says when they were issued.
  const legacy = !Number.isFinite(session.issuedAt);
  const issuedAt = legacy ? now - Math.max(0, LEGACY_SESSION_TTL_SECONDS - ttl) * 1000 : session.issuedAt;
  const ceilingIn = Math.floor((issuedAt + SESSION_MAX_AGE_SECONDS * 1000 - now) / 1000);
  if (ceilingIn <= 0) {
    await kv.del(key).catch(() => {});
    return 0;
  }

  const target = Math.min(SESSION_TTL_SECONDS, ceilingIn);
  if (legacy) {
    await withRetry(() => kv.set(key, { ...session, issuedAt }, { ex: target }));
    return target;
  }
  if (ttl !== target && (ttl > target || ttl < SESSION_TTL_SECONDS / 2)) {
    // 0 means the key went between TTL and EXPIRE: a sign-out won the race.
    const renewed = await withRetry(() => kv.expire(key, target));
    return Number(renewed) > 0 ? target : 0;
  }
  return ttl;
}

/** The signed-in board member, or null. Deactivating a profile ends its sessions. */
async function boardSession(req) {
  const token = bearerToken(req);
  if (!token || token.length < 32) return null;
  const key = KEYS.boardSession(token);
  const raw = await withRetry(() => kv.get(key));
  const session = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!session?.memberId) return null;
  const member = await getMember(session.memberId);
  if (!member || member.status !== 'active' || member.email !== session.email) return null;
  const expiresIn = await slideSession(key, session);
  if (!expiresIn) return null;
  return { member, token, expiresIn };
}

// ── Board member actions ───────────────────────────────────────────

async function requestCode(req, res) {
  const email = str(req.body?.email, 254).toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ success: false, error: 'Enter the email address your board profile uses.' });

  const perAddress = await rateLimit(`board:code:addr:${email}`, { max: 1, windowSec: 60 });
  if (!perAddress.ok) return tooManyRequests(res, perAddress.retryAfter, 'A code was just sent. Wait a minute before asking for another.');
  const daily = await rateLimit(`board:code:addr:daily:${email}`, { max: 10, windowSec: 86400 });
  if (!daily.ok) return tooManyRequests(res, daily.retryAfter, 'Too many codes requested for this address today.');
  const perIp = await rateLimit(`board:code:ip:${clientIp(req)}`, { max: 20, windowSec: 3600 });
  if (!perIp.ok) return tooManyRequests(res, perIp.retryAfter, 'Too many sign-in attempts from this network. Try again later.');

  // The same answer whether or not the address is on the board, so the form
  // cannot be used to find out who is.
  const sent = { success: true, message: 'If this email belongs to a board member, a sign-in code is on its way. Check the spelling if nothing arrives.' };
  const member = await getMemberByEmail(email);
  if (!member || member.status !== 'active') return res.status(200).json(sent);

  const code = crypto.randomInt(100000, 1000000).toString();
  await withRetry(() => kv.set(KEYS.boardOtp(email), code, { ex: OTP_TTL_SECONDS }));
  await kv.del(KEYS.boardOtpTries(email), KEYS.boardOtpClaim(email)).catch(() => {});
  const mail = await sendEmailWithin({ type: 'board_signin_code', to: email, data: { code, name: member.name } });
  if (!mail.success) {
    await kv.del(KEYS.boardOtp(email)).catch(() => {});
    console.warn('[Board] sign-in code email failed:', mail.error);
    return res.status(502).json({ success: false, error: 'We could not send the sign-in email. Please try again in a moment.' });
  }
  return res.status(200).json(sent);
}

async function verifyCode(req, res) {
  const email = str(req.body?.email, 254).toLowerCase();
  const code = str(req.body?.code, 10).replace(/\s/g, '');
  if (!isEmail(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ success: false, error: 'Enter your email and the 6-digit code from the email.' });
  }

  const triesKey = KEYS.boardOtpTries(email);
  const tries = await withRetry(() => kv.incr(triesKey), 1); // not idempotent: never re-run
  if (tries === 1) await kv.expire(triesKey, OTP_TTL_SECONDS);
  if (tries > OTP_MAX_TRIES) {
    await kv.del(KEYS.boardOtp(email)).catch(() => {});
    return res.status(429).json({ success: false, error: 'Too many wrong codes. Ask for a new code.' });
  }

  const stored = await withRetry(() => kv.get(KEYS.boardOtp(email)));
  if (!stored) return res.status(400).json({ success: false, error: 'This code has expired. Ask for a new one.' });
  if (!safeEqual(code, String(stored))) {
    return res.status(400).json({ success: false, error: 'That code is not right. Use the latest email and try again.' });
  }
  // Two taps on "Sign in" race here; only one becomes a session.
  if (!(await kv.set(KEYS.boardOtpClaim(email), '1', { nx: true, ex: 60 }))) {
    return res.status(409).json({ success: false, error: 'This code was just used. Ask for a new one if you are not signed in.' });
  }
  await kv.del(KEYS.boardOtp(email), triesKey).catch(() => {});

  const member = await getMemberByEmail(email);
  if (!member || member.status !== 'active') {
    return res.status(403).json({ success: false, error: 'This board profile is not active. Contact the BCCI Secretariat.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const session = { memberId: member.id, email: member.email, issuedAt: Date.now() };
  await withRetry(() => kv.set(KEYS.boardSession(token), session, { ex: SESSION_TTL_SECONDS }));
  console.log(`[Board] ${member.id} signed in`);
  return res.status(200).json({
    success: true,
    session: { token, expiresIn: SESSION_TTL_SECONDS, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 },
    member: profileView(member),
  });
}

async function me(req, res, { member }) {
  const history = await memberHistory(member);
  return res.status(200).json({ success: true, member: profileView(member), ...history });
}

async function attend(req, res, { member }) {
  const limit = await rateLimit(`board:attend:${member.id}`, { max: 20, windowSec: 60 });
  if (!limit.ok) return tooManyRequests(res, limit.retryAfter, 'Too many scans. Wait a moment and scan again.');
  const meeting = await resolveOpenMeeting();
  const { record, alreadyMarked } = await markBySelf(meeting, member, { userAgent: req.headers['user-agent'] });
  if (!alreadyMarked) console.log(`[Board] ${member.id} present at ${meeting.id}`);
  return res.status(200).json({
    success: true,
    alreadyMarked,
    at: record.at,
    meeting: { id: meeting.id, title: meeting.title, date: meeting.date, time: meeting.time, venue: meeting.venue || '' },
  });
}

async function signOut(req, res, { token }) {
  await kv.del(KEYS.boardSession(token)).catch(() => {});
  return res.status(200).json({ success: true });
}

// ── Mark by name (no sign-in) ──────────────────────────────────────

async function nameList(req, res) {
  const limit = await rateLimit(`board:names:ip:${clientIp(req)}`, { max: 60, windowSec: 60 });
  if (!limit.ok) return tooManyRequests(res, limit.retryAfter, 'Too many scans. Wait a moment and scan again.');
  const result = await openNameMarking(str(req.body?.deviceId, 64));
  return res.status(200).json({ success: true, ...result });
}

async function markName(req, res) {
  const ip = clientIp(req);
  const limit = await rateLimit(`board:markname:ip:${ip}`, { max: 60, windowSec: 60 });
  if (!limit.ok) return tooManyRequests(res, limit.retryAfter, 'Too many attempts. Wait a moment and try again.');
  const result = await markByName(str(req.body?.pass, 64), str(req.body?.memberId, 20), str(req.body?.deviceId, 64), { userAgent: req.headers['user-agent'] });
  console.log(`[Board] ${result.member.id} present at ${result.meeting.id} (by name)`);
  return res.status(200).json({ success: true, ...result });
}

// ── Superadmin actions ─────────────────────────────────────────────

const deps = { cleanPhone, isEmail, str };

async function sendWelcome(member) {
  const mail = await sendEmailWithin({
    type: 'board_welcome',
    to: member.email,
    data: { name: member.name, designation: member.designation, email: member.email },
  });
  if (!mail.success) console.warn(`[Board] welcome email to ${member.id} failed:`, mail.error);
  return mail.success;
}

const admin = {
  async members(req, res) {
    return res.status(200).json({ success: true, members: await listMembers() });
  },

  async 'member-save'(req, res, { adminEmail }) {
    const { fields, error } = validateMemberFields(req.body || {}, deps);
    if (error) return res.status(400).json({ success: false, error });
    const { member, created } = await saveMember(fields, { by: adminEmail });
    const welcomeSent = created ? await sendWelcome(member) : null;
    console.log(`[Board] ${created ? 'created' : 'updated'} ${member.id} by ${adminEmail}`);
    return res.status(created ? 201 : 200).json({ success: true, member, created, welcomeSent });
  },

  async 'member-status'(req, res, { adminEmail }) {
    const member = await setMemberStatus(str(req.body?.id, 20), str(req.body?.status, 10), { by: adminEmail });
    return res.status(200).json({ success: true, member });
  },

  async 'member-welcome'(req, res) {
    const member = await getMember(str(req.body?.id, 20));
    if (!member) throw new BoardError(404, 'Board member not found.', 'not_found');
    const sent = await sendWelcome(member);
    return res.status(sent ? 200 : 502).json({ success: sent, error: sent ? undefined : 'The welcome email could not be sent.' });
  },

  async meetings(req, res) {
    const [meetings, members] = await Promise.all([listMeetings(), listMembers()]);
    const withCounts = [];
    for (const m of meetings) {
      const { roster, marks } = await rosterAndMarks(m, members);
      const present = [...marks.values()].filter((r) => r.status === 'present' && roster.some((p) => p.id === r.memberId)).length;
      withCounts.push({ ...publicMeeting(m), rosterCount: roster.length, presentCount: present });
    }
    return res.status(200).json({ success: true, meetings: withCounts });
  },

  async 'meeting-save'(req, res, { adminEmail }) {
    const { fields, error } = validateMeetingFields(req.body || {}, deps);
    if (error) return res.status(400).json({ success: false, error });
    const meeting = await saveMeeting(fields, { by: adminEmail });
    return res.status(fields.id ? 200 : 201).json({ success: true, meeting: publicMeeting(meeting) });
  },

  async 'meeting-open'(req, res, { adminEmail }) {
    return res.status(200).json({ success: true, meeting: publicMeeting(await setMeetingStatus(str(req.body?.id, 20), 'open', { by: adminEmail })) });
  },
  async 'meeting-close'(req, res, { adminEmail }) {
    return res.status(200).json({ success: true, meeting: publicMeeting(await setMeetingStatus(str(req.body?.id, 20), 'close', { by: adminEmail })) });
  },
  async 'meeting-reopen'(req, res, { adminEmail }) {
    return res.status(200).json({ success: true, meeting: publicMeeting(await setMeetingStatus(str(req.body?.id, 20), 'reopen', { by: adminEmail })) });
  },
  async 'meeting-delete'(req, res, { adminEmail }) {
    await deleteMeeting(str(req.body?.id, 20), { by: adminEmail });
    return res.status(200).json({ success: true });
  },

  async meeting(req, res) {
    return res.status(200).json({ success: true, ...(await meetingDetail(str(req.query?.id, 20))) });
  },

  /** What the projector shows: the live QR is static, and who is in so far. */
  async live(req, res) {
    const meeting = await getMeeting(str(req.query?.id, 20));
    if (!meeting) throw new BoardError(404, 'Meeting not found.', 'not_found');
    if (meeting.status !== 'open') throw new BoardError(409, 'Attendance is not open for this meeting.', 'not_open');
    const { rows, counts } = await meetingDetail(meeting.id);
    const present = rows
      .filter((r) => r.status === 'present')
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .map(({ memberId, name, designation, at, method }) => ({ memberId, name, designation, at, method }));
    return res.status(200).json({ success: true, meeting: publicMeeting(meeting), present, counts });
  },

  async mark(req, res, { adminEmail }) {
    const { record, member } = await markBySecretary(
      str(req.body?.meetingId, 20), str(req.body?.memberId, 20), str(req.body?.status, 10), str(req.body?.reason, 300),
      { by: adminEmail }
    );
    console.log(`[Board] ${adminEmail} marked ${member.id} ${record.status} at ${record.meetingId}`);
    return res.status(200).json({ success: true, record });
  },

  async register(req, res) {
    const { buffer, filename } = await buildRegister();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    return res.end(buffer);
  },
};

const ADMIN_GET = new Set(['members', 'meetings', 'meeting', 'live', 'register']);
const member = { 'request-code': requestCode, 'verify-code': verifyCode, names: nameList, 'mark-name': markName };
const signedIn = { me, attend, 'sign-out': signOut };
const SIGNED_IN_GET = new Set(['me']);

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (handlePreflight(req, res)) return;

  const action = str(req.query?.action || req.body?.action, 40);
  const isGet = req.method === 'GET';
  if (!isGet && req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed.' });

  try {
    if (Object.hasOwn(member, action)) {
      if (isGet) return res.status(405).json({ success: false, error: 'Use POST.' });
      return await member[action](req, res);
    }

    if (Object.hasOwn(signedIn, action)) {
      if (isGet !== SIGNED_IN_GET.has(action)) return res.status(405).json({ success: false, error: 'Method not allowed.' });
      const session = await boardSession(req);
      if (!session) return res.status(401).json({ success: false, code: 'signed_out', error: 'Please sign in to the Board Portal again.' });
      // The browser keeps its own copy of the expiry; this keeps it in step
      // with renewals so an active member is not signed out at day 30.
      res.setHeader('X-Session-Expires-In', String(session.expiresIn));
      res.setHeader('Access-Control-Expose-Headers', 'X-Session-Expires-In');
      return await signedIn[action](req, res, session);
    }

    if (Object.hasOwn(admin, action)) {
      if (isGet !== ADMIN_GET.has(action)) return res.status(405).json({ success: false, error: 'Method not allowed.' });
      const adminEmail = await getAdminSession(req);
      if (!adminEmail) return res.status(401).json({ success: false, error: 'Unauthorized' });
      return await admin[action](req, res, { adminEmail });
    }

    return res.status(400).json({ success: false, error: 'Unknown board action.' });
  } catch (err) {
    if (err instanceof BoardError) {
      return res.status(err.status).json({ success: false, code: err.code, error: err.message });
    }
    throw err;
  }
}

export default withErrorHandling('Board', handler);
