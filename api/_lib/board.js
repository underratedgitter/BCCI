// api/_lib/board.js
// Board members, board meetings and meeting attendance.
//
// Built on kv (Upstash Redis). The data is small: a few dozen profiles and a
// couple of meetings a month.
//
// Every record has its own key. Read-modify-write paths are serialized and
// commits are fenced against expired lock holders:
//   - ids come from INCR counters (BM-1, BM-2…; MTG-1…), and listing is an
//     MGET of 1..counter;
//   - an email index and its profile commit together under the member lock;
//   - attendance writes share the meeting-status lock with closing, so late
//     scans cannot change a closed register or overwrite another mark.
//
// Attendance uses one permanent QR code (/board?attend=live) — printed on a
// sticker or shown on the projector. It is "live" only while a meeting is
// open: opening a meeting activates it, closing stops it immediately, and
// only one meeting can be open at a time so the QR is never ambiguous.
//
// Because the QR never changes, it proves nothing about being in the room.
// That proof is the meeting PIN: four digits made when attendance opens,
// shown only in the room (projector, whiteboard, read out). Every mark
// needs it. Wrong guesses are capped per meeting; past the cap the PIN locks
// until the secretary makes a new one, so it cannot be guessed from outside.

import crypto from 'node:crypto';
import { kv, KEYS, withRetry } from './kv.js';
import { acquireLock, releaseLock, fencedWrite } from './records.js';

const MEMBER_STATUS = ['active', 'inactive'];
const ATTENDANCE_STATUS = ['present', 'leave', 'absent'];

/** A failure the caller should show the person, with an HTTP status. */
export class BoardError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const nowIso = () => new Date().toISOString();

async function listByCounter(seqKey, keyFor, prefix) {
  const count = Number(await withRetry(() => kv.get(seqKey))) || 0;
  if (!count) return [];
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
  const records = [];
  // Chunks keep each MGET (one HTTP call on Upstash) a sensible size.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const values = await withRetry(() => kv.mget(...chunk.map(keyFor)));
    values.forEach((v) => v && records.push(typeof v === 'string' ? JSON.parse(v) : v));
  }
  return records;
}

const idNumber = (id) => Number(String(id).split('-').pop()) || 0;

// ── Members ────────────────────────────────────────────────────────

export async function listMembers() {
  const members = await listByCounter(KEYS.boardMemberSeq, KEYS.boardMember, 'BM');
  return members.sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

export async function getMember(id) {
  if (!/^BM-\d{1,6}$/.test(String(id || ''))) return null;
  const raw = await withRetry(() => kv.get(KEYS.boardMember(id)));
  return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
}

export async function getMemberByEmail(email) {
  const id = await withRetry(() => kv.get(KEYS.boardMemberByEmail(email)));
  if (!id) return null;
  const member = await getMember(String(id));
  // The email key may outlive a profile write that failed half-way.
  return member && member.email === String(email).trim().toLowerCase() ? member : null;
}

const MEMBER_LOCK = 'board:members';

async function withMemberLock(fn) {
  const lock = await acquireLock(MEMBER_LOCK);
  if (!lock) throw new BoardError(409, 'Another profile change is in progress. Try again in a moment.', 'busy');
  try { return await fn(lock); }
  finally { await releaseLock(MEMBER_LOCK, lock); }
}

/** Called under MEMBER_LOCK; the email index and profile commit together. */
async function requireAvailableEmail(email, id) {
  const holder = await getMemberByEmail(email);
  if (holder && holder.id !== id) {
    throw new BoardError(409, 'Another board member already uses this email address.', 'email_taken');
  }
}

/**
 * Creates a profile, or updates one when `fields.id` is given.
 * `fields` must already be validated (see validateMemberFields).
 */
export async function saveMember(fields, { by = 'admin' } = {}) {
  return withMemberLock((lock) => saveMemberLocked(fields, by, lock));
}

async function saveMemberLocked(fields, by, lock) {
  if (fields.id) {
    const existing = await getMember(fields.id);
    if (!existing) throw new BoardError(404, 'Board member not found.', 'not_found');
    await requireAvailableEmail(fields.email, existing.id);
    const updated = { ...existing, ...fields, id: existing.id, status: existing.status, updatedAt: nowIso(), updatedBy: by };
    const ops = [['set', KEYS.boardMember(existing.id), updated], ['set', KEYS.boardMemberByEmail(fields.email), existing.id]];
    if (fields.email !== existing.email) {
      const oldKey = KEYS.boardMemberByEmail(existing.email);
      if (String(await withRetry(() => kv.get(oldKey)) || '') === existing.id) ops.push(['del', oldKey]);
    }
    await fencedWrite(MEMBER_LOCK, lock, ops);
    return { member: updated, created: false };
  }

  await requireAvailableEmail(fields.email);
  const id = `BM-${await withRetry(() => kv.incr(KEYS.boardMemberSeq), 1)}`;
  const member = { ...fields, id, status: 'active', createdAt: nowIso(), createdBy: by };
  await fencedWrite(MEMBER_LOCK, lock, [
    ['set', KEYS.boardMember(id), member], ['set', KEYS.boardMemberByEmail(fields.email), id],
  ]);
  return { member, created: true };
}

export async function setMemberStatus(id, status, { by = 'admin' } = {}) {
  if (!MEMBER_STATUS.includes(status)) throw new BoardError(400, 'Status must be active or inactive.', 'invalid');
  return withMemberLock(async (lock) => {
    const member = await getMember(id);
    if (!member) throw new BoardError(404, 'Board member not found.', 'not_found');
    const updated = { ...member, status, updatedAt: nowIso(), updatedBy: by };
    await fencedWrite(MEMBER_LOCK, lock, [['set', KEYS.boardMember(id), updated]]);
    return updated;
  });
}

/**
 * Validates and normalises a profile from a request body. Returns
 * { fields } or { error }.
 */
export function validateMemberFields(body, { cleanPhone, isEmail, str }) {
  const fields = {
    name: str(body.name, 120),
    designation: str(body.designation, 80),
    email: str(body.email, 254).toLowerCase(),
    mobile: cleanPhone(body.mobile),
    company: str(body.company, 200),
  };
  if (body.id) fields.id = str(body.id, 20);
  if (fields.name.length < 2) return { error: 'Full name is required (at least 2 characters).' };
  if (fields.designation.length < 2) return { error: 'Designation is required, e.g. President or Hon. Treasurer.' };
  if (!isEmail(fields.email)) return { error: 'A valid email address is required. Board members sign in with it.' };
  if (!/^[6-9]\d{9}$/.test(fields.mobile)) return { error: 'A valid 10-digit Indian mobile number is required.' };
  return { fields };
}

// ── Meetings ───────────────────────────────────────────────────────

export async function listMeetings() {
  const meetings = await listByCounter(KEYS.boardMeetingSeq, KEYS.boardMeeting, 'MTG');
  return meetings.filter((m) => !m.deleted).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
}

export async function getMeeting(id) {
  if (!/^MTG-\d{1,6}$/.test(String(id || ''))) return null;
  const raw = await withRetry(() => kv.get(KEYS.boardMeeting(id)));
  const meeting = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  return meeting && !meeting.deleted ? meeting : null;
}

export function validateMeetingFields(body, { str }) {
  const fields = {
    title: str(body.title, 160),
    date: str(body.date, 10),
    time: str(body.time, 5),
    venue: str(body.venue, 200),
  };
  if (body.id) fields.id = str(body.id, 20);
  if (fields.title.length < 3) return { error: 'Meeting title is required (at least 3 characters).' };
  // Date.parse rolls 2026-02-31 over to 3 March; only a date that survives
  // the round trip is real.
  const [y, mo, d] = fields.date.split('-').map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date) || day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
    return { error: 'Meeting date must be a real date (YYYY-MM-DD).' };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(fields.time)) return { error: 'Meeting start time is required (HH:MM).' };
  return { fields };
}

export async function saveMeeting(fields, { by = 'admin' } = {}) {
  if (fields.id) {
    // Under the status lock: an edit written from a copy read before an
    // open or close would otherwise put the old status back.
    return withMeetingLock(async (lock) => {
      const existing = await getMeeting(fields.id);
      if (!existing) throw new BoardError(404, 'Meeting not found.', 'not_found');
      if (existing.status === 'closed') throw new BoardError(409, 'A closed meeting cannot be edited. Reopen it first.', 'closed');
      const updated = { ...existing, ...fields, id: existing.id, updatedAt: nowIso(), updatedBy: by };
      await fencedWrite(MEETING_LOCK, lock, [['set', KEYS.boardMeeting(existing.id), updated]]);
      return updated;
    });
  }
  const id = `MTG-${await withRetry(() => kv.incr(KEYS.boardMeetingSeq))}`;
  const meeting = {
    ...fields,
    id,
    status: 'scheduled',
    roster: null,
    createdAt: nowIso(),
    createdBy: by,
  };
  await withRetry(() => kv.set(KEYS.boardMeeting(id), meeting));
  return meeting;
}

export async function attendanceFor(meetingId, memberIds) {
  if (!memberIds.length) return new Map();
  const values = await withRetry(() => kv.mget(...memberIds.map((id) => KEYS.boardAttendance(meetingId, id))));
  const map = new Map();
  values.forEach((v, i) => v && map.set(memberIds[i], typeof v === 'string' ? JSON.parse(v) : v));
  return map;
}

/**
 * Who belongs to a meeting, and their marks. Frozen when the meeting closes;
 * until then, the active board plus anyone already marked, so a profile
 * deactivated mid-meeting cannot take its mark with it.
 */
export async function rosterAndMarks(meeting, members) {
  if (Array.isArray(meeting.roster)) {
    const byId = new Map(members.map((m) => [m.id, m]));
    const roster = meeting.roster.map((id) => byId.get(id)).filter(Boolean);
    return { roster, marks: await attendanceFor(meeting.id, roster.map((m) => m.id)) };
  }
  const marks = await attendanceFor(meeting.id, members.map((m) => m.id));
  return { roster: members.filter((m) => m.status === 'active' || marks.has(m.id)), marks };
}

// ── Meeting status and the one open meeting ───────────────────────
// The permanent QR means "the meeting taking attendance", so at most one
// meeting may be open. Every change to a meeting's status (open, close,
// reopen, edit, delete) runs under one lock, and the meeting record and the
// open-meeting pointer are written together while that lock is held, so two
// secretaries pressing "Open" on two meetings at once cannot both win.

const MEETING_LOCK = 'board:meetings';

async function withMeetingLock(fn) {
  const lock = await acquireLock(MEETING_LOCK);
  if (!lock) throw new BoardError(409, 'Another change to a meeting is in progress. Try again in a moment.', 'busy');
  try {
    return await fn(lock);
  } finally {
    await releaseLock(MEETING_LOCK, lock);
  }
}

/**
 * Meetings opened before the pointer existed: find the open one, once, and
 * point at it. Call only while holding the meeting lock.
 */
async function indexOpenMeetingOnce(lock) {
  if (await withRetry(() => kv.get(KEYS.boardOpenMeetingIndexed))) return;
  const open = (await listMeetings())
    .filter((m) => m.status === 'open')
    .sort((a, b) => String(b.reopenedAt || b.openedAt || '').localeCompare(String(a.reopenedAt || a.openedAt || '')));
  const ops = [['set', KEYS.boardOpenMeetingIndexed, '1']];
  if (open[0]) ops.unshift(['set', KEYS.boardOpenMeeting, open[0].id]);
  await fencedWrite(MEETING_LOCK, lock, ops);
}

/** The id the open-meeting pointer holds, or null. */
async function openMeetingId() {
  const id = await withRetry(() => kv.get(KEYS.boardOpenMeeting));
  if (id) return String(id);
  if (await withRetry(() => kv.get(KEYS.boardOpenMeetingIndexed))) return null;
  // First scan after this change: index under the lock (once), then read again.
  await withMeetingLock((lock) => indexOpenMeetingOnce(lock));
  const after = await withRetry(() => kv.get(KEYS.boardOpenMeeting));
  return after ? String(after) : null;
}

/** Throws another_open when a meeting other than `id` is taking attendance. Lock held. */
async function refuseIfAnotherOpen(id, lock, verb) {
  await indexOpenMeetingOnce(lock);
  const openId = await withRetry(() => kv.get(KEYS.boardOpenMeeting));
  if (!openId || String(openId) === id) return;
  const other = await getMeeting(String(openId));
  // A pointer left at a meeting that is no longer open is simply replaced.
  if (other?.status === 'open') {
    throw new BoardError(409, `Close attendance for "${other.title}" before ${verb} this meeting.`, 'another_open');
  }
}

export async function setMeetingStatus(id, action, { by = 'admin' } = {}) {
  if (!['open', 'close', 'reopen'].includes(action)) throw new BoardError(400, 'Unknown meeting action.', 'invalid');
  return withMeetingLock(async (lock) => {
    // Read inside the lock, so the status acted on is the current one.
    const meeting = await getMeeting(id);
    if (!meeting) throw new BoardError(404, 'Meeting not found.', 'not_found');
    const at = nowIso();
    let updated;
    if (action === 'open') {
      if (meeting.status === 'closed') throw new BoardError(409, 'This meeting is closed. Reopen it to take attendance again.', 'closed');
      await refuseIfAnotherOpen(id, lock, 'opening');
      // Opening an already open meeting again keeps the PIN people are using.
      if (meeting.status !== 'open' || !(await getMeetingPin(id))) await setNewPin(id, lock);
      updated = { ...meeting, status: 'open', openedAt: meeting.openedAt || at, openedBy: meeting.openedBy || by };
    } else if (action === 'close') {
      if (meeting.status !== 'open') throw new BoardError(409, 'Only a meeting that is taking attendance can be closed.', 'not_open');
      // Freeze who belonged, so a later profile change never rewrites history.
      const { roster } = await rosterAndMarks(meeting, await listMembers());
      updated = { ...meeting, status: 'closed', roster: roster.map((m) => m.id), closedAt: at, closedBy: by };
    } else {
      if (meeting.status !== 'closed') throw new BoardError(409, 'Only a closed meeting can be reopened.', 'not_closed');
      await refuseIfAnotherOpen(id, lock, 'reopening');
      // The roster stays frozen: reopening corrects marks, it does not let a
      // profile change since the meeting rewrite who belonged.
      // A fresh PIN: the one from the meeting itself may have been seen outside.
      await setNewPin(id, lock);
      updated = { ...meeting, status: 'open', reopenedAt: at, reopenedBy: by };
    }
    // The PIN is written before a meeting opens (an open meeting always has
    // one); the record and the pointer change together.
    const ops = [['set', KEYS.boardMeeting(id), updated]];
    if (updated.status === 'open') ops.push(['set', KEYS.boardOpenMeeting, id]);
    else if (String(await withRetry(() => kv.get(KEYS.boardOpenMeeting))) === id) ops.push(['del', KEYS.boardOpenMeeting]);
    if (action === 'close') ops.push(['del', KEYS.boardMeetingPin(id)], ['del', KEYS.boardPinVersion(id)], ['del', KEYS.boardPinFails(id)]);
    await fencedWrite(MEETING_LOCK, lock, ops);
    return updated;
  });
}

/** Removes a meeting created by mistake; refused once anyone has been marked. */
export async function deleteMeeting(id, { by = 'admin' } = {}) {
  await withMeetingLock(async (lock) => {
    const meeting = await getMeeting(id);
    if (!meeting) throw new BoardError(404, 'Meeting not found.', 'not_found');
    const members = await listMembers();
    const marks = await attendanceFor(id, members.map((m) => m.id));
    if (marks.size) throw new BoardError(409, 'Attendance has been recorded for this meeting, so it cannot be deleted.', 'has_attendance');
    const ops = [['set', KEYS.boardMeeting(id), { ...meeting, deleted: true, deletedAt: nowIso(), deletedBy: by }]];
    if (String(await withRetry(() => kv.get(KEYS.boardOpenMeeting))) === id) ops.push(['del', KEYS.boardOpenMeeting]);
    await fencedWrite(MEETING_LOCK, lock, ops);
  });
  await kv.del(KEYS.boardMeetingPin(id), KEYS.boardPinVersion(id), KEYS.boardPinFails(id)).catch(() => {});
}

// ── The live (sticker) QR target ───────────────────────────────────

/**
 * The meeting the permanent QR (/board?attend=live) points at right now:
 * the open meeting, found through the pointer in two reads rather than by
 * reading every meeting ever held.
 */
export async function resolveOpenMeeting() {
  const id = await openMeetingId();
  const meeting = id ? await getMeeting(id) : null;
  if (!meeting || meeting.status !== 'open') {
    throw new BoardError(409, 'Attendance is not open right now. The secretary opens attendance before each meeting.', 'not_open');
  }
  return meeting;
}

// ── The meeting PIN ────────────────────────────────────────────────

const PIN_LENGTH = 4;
/** Wrong PINs one meeting accepts before its PIN locks: 30 of 10,000 is a 0.3% chance per PIN. */
const PIN_MAX_FAILS = 30;
const PIN_FAILS_TTL_SECONDS = 24 * 3600;
const PIN_FORMAT = /^\d{4}$/;

const newPin = () => String(crypto.randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');

/** True for something shaped like a PIN; anything else is not counted as a guess. */
export const isPinShaped = (pin) => PIN_FORMAT.test(String(pin ?? ''));

/** A meeting's current PIN, or null (not open, or opened before PINs existed). */
export async function getMeetingPin(meetingId) {
  const pin = await withRetry(() => kv.get(KEYS.boardMeetingPin(meetingId)));
  return pin == null ? null : String(pin).padStart(PIN_LENGTH, '0');
}

/** Stores a fresh PIN for a meeting, with no wrong guesses against it. */
async function setNewPin(meetingId, lock) {
  const pin = newPin();
  await fencedWrite(MEETING_LOCK, lock, [
    ['set', KEYS.boardMeetingPin(meetingId), pin],
    ['set', KEYS.boardPinVersion(meetingId), crypto.randomUUID()],
    ['del', KEYS.boardPinFails(meetingId)],
  ]);
  return pin;
}

/** Snapshot PIN and generation together; legacy open meetings need no migration. */
async function pinState(meetingId) {
  const [raw, version] = await withRetry(() => kv.mget(KEYS.boardMeetingPin(meetingId), KEYS.boardPinVersion(meetingId)));
  const pin = raw == null ? null : String(raw).padStart(PIN_LENGTH, '0');
  return { pin, version: version ? String(version) : pin ? `legacy:${pin}` : null };
}

async function requirePinProof(meeting, proof) {
  const state = await pinState(meeting.id);
  if (!proof || proof.version !== state.version) {
    throw new BoardError(400, 'The meeting PIN changed. Enter the PIN shown in the room again.', 'pin_required');
  }
  if (await isPinLocked(meeting, state.pin)) throw pinLockedError();
}

async function pinFailures(meetingId) {
  return Number(await withRetry(() => kv.get(KEYS.boardPinFails(meetingId)))) || 0;
}

/** True once a meeting has no usable PIN: too many wrong guesses, or opened before PINs existed. */
export async function isPinLocked(meeting, pin) {
  return !pin || (await pinFailures(meeting.id)) >= PIN_MAX_FAILS;
}

const pinLockedError = () => new BoardError(423, 'The meeting PIN is locked. Ask the secretary to show a new PIN.', 'pin_locked');

/**
 * Throws unless `pin` is this open meeting's PIN. Each wrong PIN counts
 * toward the meeting's cap; a missing or malformed one is refused without
 * counting, so a tap on the sticker before typing costs nothing.
 */
export async function verifyMeetingPin(meeting, pin) {
  const { pin: current, version } = await pinState(meeting.id);
  if (await isPinLocked(meeting, current)) throw pinLockedError();
  const given = String(pin ?? '').trim();
  if (!isPinShaped(given)) {
    throw new BoardError(400, 'Enter the 4-digit meeting PIN shown in the meeting room.', 'pin_required');
  }
  const givenBuf = Buffer.from(given);
  const currentBuf = Buffer.from(String(current ?? ''));
  // timingSafeEqual throws on a length mismatch, so a stored PIN of the wrong
  // shape is a wrong PIN (403), never a 500.
  if (givenBuf.length === currentBuf.length && crypto.timingSafeEqual(givenBuf, currentBuf)) return { version };
  const key = KEYS.boardPinFails(meeting.id);
  // One attempt only: INCR is not idempotent.
  const fails = await withRetry(() => kv.incr(key), 1);
  if (fails === 1) await withRetry(() => kv.expire(key, PIN_FAILS_TTL_SECONDS)).catch(() => {});
  if (fails >= PIN_MAX_FAILS) {
    console.warn(`[Board] PIN locked at ${meeting.id} after ${fails} wrong guesses`);
    throw pinLockedError();
  }
  throw new BoardError(403, 'That PIN is not right. Check the PIN shown in the meeting room.', 'pin_wrong');
}

/**
 * The secretary's "New PIN": replaces the PIN of an open meeting and clears
 * its wrong guesses. Serialized with closing and attendance writes. A new
 * generation invalidates every previously verified PIN and name pass.
 */
export async function rotateMeetingPin(id, { by = 'admin' } = {}) {
  return withMeetingLock(async (lock) => {
    const meeting = await getMeeting(id);
    if (!meeting) throw new BoardError(404, 'Meeting not found.', 'not_found');
    if (meeting.status !== 'open') throw new BoardError(409, 'Only a meeting that is taking attendance has a PIN.', 'not_open');
    const pin = await setNewPin(id, lock);
    console.log(`[Board] ${by} made a new PIN for ${id}`);
    return { meeting, pin };
  });
}

// ── Attendance ─────────────────────────────────────────────────────

/** A board member marking themselves present by scanning the live QR. */
export async function markBySelf(meeting, member, { userAgent = '', proof } = {}) {
  return withMeetingLock((lock) => markBySelfLocked(meeting, member, userAgent, proof, lock));
}

async function markBySelfLocked(meeting, member, userAgent, proof, meetingLock) {
  meeting = await openMeetingFor(meeting.id);
  await requirePinProof(meeting, proof);
  member = await getMember(member.id);
  // The route resolves the open meeting and checks its PIN first.
  if (meeting.status !== 'open') {
    throw new BoardError(409, meeting.status === 'closed' ? 'Attendance for this meeting has closed.' : 'Attendance for this meeting has not opened yet.', 'not_open');
  }
  if (!member || member.status !== 'active') throw new BoardError(403, 'Your board profile is not active.', 'inactive');
  // A reopened meeting keeps the roster it closed with.
  if (Array.isArray(meeting.roster) && !meeting.roster.includes(member.id)) {
    throw new BoardError(403, 'You are not on the board for this meeting.', 'not_on_roster');
  }

  const key = KEYS.boardAttendance(meeting.id, member.id);
  const at = nowIso();
  const entry = { status: 'present', at, method: 'qr', by: member.email };
  const record = { meetingId: meeting.id, memberId: member.id, status: 'present', at, method: 'qr', userAgent: String(userAgent).slice(0, 160), history: [entry] };

  if (!(await withRetry(() => kv.get(key)))) {
    await fencedWrite(MEETING_LOCK, meetingLock, [['set', key, record]]);
    return { meeting, record, alreadyMarked: false };
  }

  // The record already exists. Upgrading it is a read-modify-write, so two
  // writers on this same key (a double tap racing a secretary override) would
  // otherwise drop a history entry — serialize them.
  const lockName = `attendance:${key}`;
  const lock = await acquireLock(lockName);
  // Without the lock a concurrent scan or override could drop a history entry.
  if (!lock) throw new BoardError(409, 'This attendance record is being updated. Try again in a moment.', 'busy');
  try {
    const existing = await withRetry(() => kv.get(key));
    const current = typeof existing === 'string' ? JSON.parse(existing) : existing;
    if (current?.status === 'present') return { meeting, record: current, alreadyMarked: true };
    // Marked on leave or absent by the secretary, but here in the room after all.
    const upgraded = { ...current, ...record, history: [...(current?.history || []), entry] };
    await fencedWrite(MEETING_LOCK, meetingLock, [['set', key, upgraded]]);
    return { meeting, record: upgraded, alreadyMarked: false };
  } finally {
    await releaseLock(lockName, lock);
  }
}

// ── Mark by name (no sign-in) ──────────────────────────────────────
// Scan the live QR, enter the meeting PIN, tap your name. A 5-minute
// single-use pass, issued only for the right PIN, covers picking the name.
// Each name can be marked once per meeting, and each phone can mark only
// one name.

const NAME_PASS_TTL_SECONDS = 5 * 60;
const DEVICE_MARK_TTL_SECONDS = 3 * 24 * 3600;
const DEVICE_ID = /^[A-Za-z0-9-]{20,64}$/;

/** A phone's id, hashed: the raw value never reaches storage. */
const deviceHash = (deviceId) => crypto.createHash('sha256').update(String(deviceId)).digest('hex').slice(0, 24);

function requireDeviceId(deviceId) {
  if (!DEVICE_ID.test(String(deviceId || ''))) {
    throw new BoardError(400, 'This browser could not be identified. Allow site storage and scan again.', 'no_device');
  }
}

async function openMeetingFor(meetingId) {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new BoardError(404, 'This QR code is not for a BCCI board meeting.', 'not_found');
  if (meeting.status !== 'open') {
    throw new BoardError(409, meeting.status === 'closed' ? 'Attendance for this meeting has closed.' : 'Attendance for this meeting has not opened yet.', 'not_open');
  }
  return meeting;
}

/**
 * After a scan and the right PIN (the route checks it against `meeting`,
 * the open meeting): the names to choose from, and a pass to mark one.
 * Only names are returned (no email or phone). When this phone has already
 * marked someone at this meeting, says who, and issues no pass.
 */
export async function openNameMarking(meeting, deviceId, proof) {
  requireDeviceId(deviceId);
  return withMeetingLock(() => openNameMarkingLocked(meeting, deviceId, proof));
}

async function openNameMarkingLocked(meeting, deviceId, proof) {
  meeting = await openMeetingFor(meeting.id);
  await requirePinProof(meeting, proof);
  const { roster, marks } = await rosterAndMarks(meeting, await listMembers());
  const members = roster
    .filter((m) => m.status === 'active')
    .map((m) => ({ id: m.id, name: m.name, marked: marks.has(m.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const view = { id: meeting.id, title: meeting.title, date: meeting.date, time: meeting.time };

  const usedFor = await withRetry(() => kv.get(KEYS.boardDeviceMark(meeting.id, deviceHash(deviceId))));
  if (usedFor) {
    const who = members.find((m) => m.id === String(usedFor));
    return { meeting: view, members, pass: null, markedByThisPhone: who ? who.name : 'a board member' };
  }

  const pass = crypto.randomBytes(24).toString('base64url');
  await withRetry(() => kv.set(KEYS.boardNamePass(pass), { meetingId: meeting.id, device: deviceHash(deviceId), version: proof.version }, { ex: NAME_PASS_TTL_SECONDS }));
  return { meeting: view, members, pass, markedByThisPhone: null };
}

/** Marks one name present with a pass from openNameMarking. */
export async function markByName(pass, memberId, deviceId, { userAgent = '' } = {}) {
  requireDeviceId(deviceId);
  return withMeetingLock((lock) => markByNameLocked(pass, memberId, deviceId, userAgent, lock));
}

async function markByNameLocked(pass, memberId, deviceId, userAgent, meetingLock) {
  const passKey = KEYS.boardNamePass(String(pass || ''));
  const rawPass = /^[A-Za-z0-9_-]{32}$/.test(String(pass || '')) ? await withRetry(() => kv.get(passKey)) : null;
  const passData = typeof rawPass === 'string' ? JSON.parse(rawPass) : rawPass;
  const device = deviceHash(deviceId);
  // A pass is tied to the phone that scanned, so it cannot be forwarded.
  if (!passData?.meetingId || passData.device !== device) {
    throw new BoardError(410, 'This page has expired. Scan the attendance QR again.', 'expired');
  }

  const meeting = await openMeetingFor(passData.meetingId);
  const state = await pinState(meeting.id);
  if (!passData.version || passData.version !== state.version) {
    throw new BoardError(410, 'The meeting PIN changed. Scan the attendance QR and enter the new PIN.', 'expired');
  }
  if (await isPinLocked(meeting, state.pin)) throw pinLockedError();
  const member = await getMember(String(memberId || ''));
  const onRoster = Array.isArray(meeting.roster) ? meeting.roster.includes(member?.id) : member?.status === 'active';
  if (!member || member.status !== 'active' || !onRoster) {
    throw new BoardError(404, 'That name is not on the board for this meeting.', 'not_on_roster');
  }

  // One name per phone: claim this phone for the name first.
  const deviceKey = KEYS.boardDeviceMark(meeting.id, device);
  if (!(await withRetry(() => kv.set(deviceKey, member.id, { nx: true, ex: DEVICE_MARK_TTL_SECONDS })))) {
    const usedFor = await withRetry(() => kv.get(deviceKey));
    const who = String(usedFor) === member.id ? member : await getMember(String(usedFor));
    throw new BoardError(409, `This phone has already marked ${who?.name || 'a board member'} present for this meeting.`, 'device_used');
  }

  // One mark per name: only a new record is written. An existing one (already
  // present, or a leave/absent mark from the secretary) is never overwritten.
  const at = nowIso();
  const entry = { status: 'present', at, method: 'name', by: `phone ${device.slice(0, 8)}` };
  const record = { meetingId: meeting.id, memberId: member.id, status: 'present', at, method: 'name', device: device.slice(0, 8), userAgent: String(userAgent).slice(0, 160), history: [entry] };
  // Give the phone back so its owner can still mark their own name.
  const releasePhone = async () => {
    if (String(await withRetry(() => kv.get(deviceKey))) === member.id) await kv.del(deviceKey);
  };
  let written;
  try {
    const key = KEYS.boardAttendance(meeting.id, member.id);
    written = !(await withRetry(() => kv.get(key)));
    if (written) await fencedWrite(MEETING_LOCK, meetingLock, [['set', key, record]]);
  } catch (err) {
    // Otherwise the phone would claim a name it never marked, for three days.
    await releasePhone().catch((releaseErr) => console.warn('[Board] could not free the phone after a failed mark:', releaseErr.message));
    throw err;
  }
  if (!written) {
    await releasePhone().catch((releaseErr) => console.warn('[Board] could not free the phone after a refused mark:', releaseErr.message));
    throw new BoardError(409, `${member.name} is already marked for this meeting. If that is you, tell the secretary.`, 'already_marked');
  }
  await kv.del(passKey).catch(() => {});
  return { meeting: { id: meeting.id, title: meeting.title }, member: { id: member.id, name: member.name }, at };
}

/** The superadmin setting someone present, on leave or absent, with a reason. */
export async function markBySecretary(meetingId, memberId, status, reason, { by = 'admin' } = {}) {
  if (!ATTENDANCE_STATUS.includes(status)) throw new BoardError(400, 'Status must be present, leave or absent.', 'invalid');
  if (String(reason || '').trim().length < 3) throw new BoardError(400, 'Give a short reason for the record, e.g. "No phone with them".', 'reason_required');
  return withMeetingLock((lock) => markBySecretaryLocked(meetingId, memberId, status, reason, by, lock));
}

async function markBySecretaryLocked(meetingId, memberId, status, reason, by, meetingLock) {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new BoardError(404, 'Meeting not found.', 'not_found');
  // A closed register is frozen (reopen it to correct a mark), and a mark on a
  // meeting that never opened would make that meeting undeletable.
  if (meeting.status !== 'open') {
    throw new BoardError(409, meeting.status === 'closed' ? 'This meeting is closed. Reopen it to change attendance.' : 'Open attendance for this meeting before marking anyone.', 'not_open');
  }
  const member = await getMember(memberId);
  if (!member) throw new BoardError(404, 'Board member not found.', 'not_found');
  const onRoster = Array.isArray(meeting.roster) ? meeting.roster.includes(member.id) : member.status === 'active';
  if (!onRoster) throw new BoardError(409, `${member.name} is not on the board for this meeting.`, 'not_on_roster');

  const key = KEYS.boardAttendance(meeting.id, member.id);
  const at = nowIso();
  const entry = { status, at, method: 'secretary', by, reason: String(reason).trim().slice(0, 300) };
  // Serialize with the QR upgrade path so a concurrent scan and override on the
  // same key cannot lose a history entry.
  const lockName = `attendance:${key}`;
  const lock = await acquireLock(lockName);
  // Without the lock a concurrent scan or override could drop a history entry.
  if (!lock) throw new BoardError(409, 'This attendance record is being updated. Try again in a moment.', 'busy');
  try {
    const existing = await withRetry(() => kv.get(key));
    const current = typeof existing === 'string' ? JSON.parse(existing) : existing;
    const record = {
      meetingId: meeting.id,
      memberId: member.id,
      status,
      at: status === 'present' && current?.status === 'present' ? current.at : at,
      method: 'secretary',
      reason: entry.reason,
      history: [...(current?.history || []), entry],
    };
    await fencedWrite(MEETING_LOCK, meetingLock, [['set', key, record]]);
    return { meeting, member, record };
  } finally {
    await releaseLock(lockName, lock);
  }
}

/** One meeting with each roster member's status, for the superadmin. */
export async function meetingDetail(meetingId) {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new BoardError(404, 'Meeting not found.', 'not_found');
  const { roster, marks } = await rosterAndMarks(meeting, await listMembers());
  const rows = roster.map((m) => {
    const rec = marks.get(m.id);
    return {
      memberId: m.id,
      name: m.name,
      designation: m.designation,
      status: rec?.status || 'absent',
      at: rec?.at || null,
      method: rec?.method || null,
      reason: rec?.reason || null,
      history: rec?.history || [],
    };
  });
  // Admin only (meeting view, projector): includes the PIN.
  return { meeting: await adminMeeting(meeting), rows, counts: countRows(rows) };
}

function countRows(rows) {
  const counts = { roster: rows.length, present: 0, leave: 0, absent: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

// The fields only the secretariat should see on a meeting. Who created it,
// opened it or closed it says nothing to a board member and names an admin.
const ADMIN_ONLY_MEETING_FIELDS = ['secret', 'createdBy', 'updatedBy', 'openedBy', 'closedBy', 'reopenedBy'];

/** A meeting as members see it: without the admin-only fields. The PIN lives in its own key. */
export function publicMeeting(m) {
  const view = { ...m };
  for (const field of ADMIN_ONLY_MEETING_FIELDS) delete view[field];
  return view;
}

/** A meeting as the secretary sees it: with the PIN to show in the room (null unless open). */
export async function adminMeeting(m, pin) {
  const current = m.status !== 'open' ? null : pin !== undefined ? pin : await getMeetingPin(m.id);
  // Only a legacy QR secret stays out of every payload; the admin trail stays.
  const { secret, ...rest } = m;
  return { ...rest, pin: current };
}

/** A board member's own meetings and statuses, for their portal. */
export async function memberHistory(member) {
  const meetings = await listMeetings();
  const started = meetings.filter((m) => m.status !== 'scheduled');
  // One read for this member's marks across every meeting.
  const marks = started.length
    ? await withRetry(() => kv.mget(...started.map((m) => KEYS.boardAttendance(m.id, member.id))))
    : [];
  const markFor = new Map(started.map((m, i) => [m.id, typeof marks[i] === 'string' ? JSON.parse(marks[i]) : marks[i]]));
  const items = [];
  for (const meeting of meetings) {
    if (meeting.status === 'scheduled') {
      items.push({ meeting: publicMeeting(meeting), status: null, at: null });
      continue;
    }
    const rec = markFor.get(meeting.id);
    const onRoster = Array.isArray(meeting.roster) ? meeting.roster.includes(member.id) : member.status === 'active' || Boolean(rec);
    if (!onRoster) continue;
    items.push({ meeting: publicMeeting(meeting), status: rec?.status || 'absent', at: rec?.at || null });
  }
  const held = items.filter((i) => i.meeting.status === 'closed');
  const attended = held.filter((i) => i.status === 'present').length;
  return { items, stats: { held: held.length, attended, rate: held.length ? attended / held.length : null } };
}

/** Everything the attendance register workbook needs, oldest meeting first. */
export async function registerData() {
  const [meetings, members] = await Promise.all([listMeetings(), listMembers()]);
  const held = meetings.filter((m) => m.status !== 'scheduled').sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const columns = [];
  for (const meeting of held) {
    const { roster, marks } = await rosterAndMarks(meeting, members);
    columns.push({ meeting, rosterIds: new Set(roster.map((m) => m.id)), marks });
  }
  return { members, columns };
}
