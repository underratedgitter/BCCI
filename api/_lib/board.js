// api/_lib/board.js
// Board members, board meetings and meeting attendance.
//
// Built on kv (Upstash Redis). The data is small: a few dozen profiles and a
// couple of meetings a month.
//
// Every record has its own key, and no read-modify-write is shared between
// people acting at the same time:
//   - ids come from INCR counters (BM-1, BM-2…; MTG-1…), and listing is an
//     MGET of 1..counter;
//   - an email belongs to one profile through SET NX on its email key;
//   - each attendance mark is its own key, written with SET NX, so fifteen
//     members scanning in the same second cannot overwrite one another.
//
// Attendance uses one permanent QR code (/board?attend=live) — printed on a
// sticker or shown on the projector. It is "live" only while a meeting is
// open: opening a meeting activates it, closing stops it immediately, and
// only one meeting can be open at a time so the QR is never ambiguous.

import crypto from 'node:crypto';
import { kv, KEYS, withRetry } from './kv.js';
import { acquireLock, releaseLock, fencedWrite } from './records.js';

const MEMBER_STATUS = ['active', 'inactive'];
export const ATTENDANCE_STATUS = ['present', 'leave', 'absent'];

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

/** Claims an email for a profile; false when another profile holds it. */
async function claimEmail(email, id) {
  const key = KEYS.boardMemberByEmail(email);
  if (await withRetry(() => kv.set(key, id, { nx: true }))) return true;
  const holder = String(await withRetry(() => kv.get(key)) || '');
  if (holder === id) return true;
  const holderProfile = holder ? await getMember(holder) : null;
  if (holderProfile && holderProfile.email === email) return false;
  // A claim left by a write that never completed: take it over.
  await withRetry(() => kv.set(key, id));
  return true;
}

/**
 * Creates a profile, or updates one when `fields.id` is given.
 * `fields` must already be validated (see validateMemberFields).
 */
export async function saveMember(fields, { by = 'admin' } = {}) {
  if (fields.id) {
    const existing = await getMember(fields.id);
    if (!existing) throw new BoardError(404, 'Board member not found.', 'not_found');
    if (fields.email !== existing.email && !(await claimEmail(fields.email, existing.id))) {
      throw new BoardError(409, 'Another board member already uses this email address.', 'email_taken');
    }
    const updated = { ...existing, ...fields, id: existing.id, status: existing.status, updatedAt: nowIso(), updatedBy: by };
    await withRetry(() => kv.set(KEYS.boardMember(existing.id), updated));
    if (fields.email !== existing.email) {
      const oldKey = KEYS.boardMemberByEmail(existing.email);
      if (String(await kv.get(oldKey) || '') === existing.id) await kv.del(oldKey);
    }
    return { member: updated, created: false };
  }

  // Checked first so a refused duplicate does not use up a member number;
  // the claim below is still what guarantees uniqueness under a race.
  if (await getMemberByEmail(fields.email)) {
    throw new BoardError(409, 'A board member with this email address already exists.', 'email_taken');
  }
  const id = `BM-${await withRetry(() => kv.incr(KEYS.boardMemberSeq))}`;
  if (!(await claimEmail(fields.email, id))) {
    throw new BoardError(409, 'A board member with this email address already exists.', 'email_taken');
  }
  const member = { ...fields, id, status: 'active', createdAt: nowIso(), createdBy: by };
  await withRetry(() => kv.set(KEYS.boardMember(id), member));
  return { member, created: true };
}

export async function setMemberStatus(id, status, { by = 'admin' } = {}) {
  if (!MEMBER_STATUS.includes(status)) throw new BoardError(400, 'Status must be active or inactive.', 'invalid');
  const member = await getMember(id);
  if (!member) throw new BoardError(404, 'Board member not found.', 'not_found');
  const updated = { ...member, status, updatedAt: nowIso(), updatedBy: by };
  await withRetry(() => kv.set(KEYS.boardMember(id), updated));
  return updated;
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
    const existing = await getMeeting(fields.id);
    if (!existing) throw new BoardError(404, 'Meeting not found.', 'not_found');
    if (existing.status === 'closed') throw new BoardError(409, 'A closed meeting cannot be edited. Reopen it first.', 'closed');
    const updated = { ...existing, ...fields, id: existing.id, updatedAt: nowIso(), updatedBy: by };
    await withRetry(() => kv.set(KEYS.boardMeeting(existing.id), updated));
    return updated;
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

export async function setMeetingStatus(id, action, { by = 'admin' } = {}) {
  const meeting = await getMeeting(id);
  if (!meeting) throw new BoardError(404, 'Meeting not found.', 'not_found');
  const at = nowIso();
  let updated;
  if (action === 'open') {
    if (meeting.status === 'closed') throw new BoardError(409, 'This meeting is closed. Reopen it to take attendance again.', 'closed');
    // The sticker QR resolves to "the open meeting", so there must be only one.
    const openOthers = (await listMeetings()).filter((m) => m.id !== id && m.status === 'open');
    if (openOthers.length) {
      throw new BoardError(409, `Close attendance for "${openOthers[0].title}" before opening another meeting.`, 'another_open');
    }
    updated = { ...meeting, status: 'open', openedAt: meeting.openedAt || at, openedBy: meeting.openedBy || by };
  } else if (action === 'close') {
    if (meeting.status !== 'open') throw new BoardError(409, 'Only a meeting that is taking attendance can be closed.', 'not_open');
    // Freeze who belonged, so a later profile change never rewrites history.
    const { roster } = await rosterAndMarks(meeting, await listMembers());
    updated = { ...meeting, status: 'closed', roster: roster.map((m) => m.id), closedAt: at, closedBy: by };
  } else if (action === 'reopen') {
    if (meeting.status !== 'closed') throw new BoardError(409, 'Only a closed meeting can be reopened.', 'not_closed');
    // Same one-open rule as opening: the live QR must stay unambiguous.
    const openOthers = (await listMeetings()).filter((m) => m.id !== id && m.status === 'open');
    if (openOthers.length) {
      throw new BoardError(409, `Close attendance for "${openOthers[0].title}" before reopening this meeting.`, 'another_open');
    }
    // The roster stays frozen: reopening corrects marks, it does not let a
    // profile change since the meeting rewrite who belonged.
    updated = { ...meeting, status: 'open', reopenedAt: at, reopenedBy: by };
  } else {
    throw new BoardError(400, 'Unknown meeting action.', 'invalid');
  }
  await withRetry(() => kv.set(KEYS.boardMeeting(id), updated));
  return updated;
}

/** Removes a meeting created by mistake; refused once anyone has been marked. */
export async function deleteMeeting(id, { by = 'admin' } = {}) {
  const meeting = await getMeeting(id);
  if (!meeting) throw new BoardError(404, 'Meeting not found.', 'not_found');
  const members = await listMembers();
  const marks = await attendanceFor(id, members.map((m) => m.id));
  if (marks.size) throw new BoardError(409, 'Attendance has been recorded for this meeting, so it cannot be deleted.', 'has_attendance');
  await withRetry(() => kv.set(KEYS.boardMeeting(id), { ...meeting, deleted: true, deletedAt: nowIso(), deletedBy: by }));
}

// ── The live (sticker) QR target ───────────────────────────────────

/**
 * The meeting the permanent QR (/board?attend=live) points at right now:
 * the open meeting. There is at most one because opening is refused while
 * another is open; the openedAt tie-break only covers pre-change data.
 */
export async function resolveOpenMeeting() {
  const open = (await listMeetings()).filter((m) => m.status === 'open');
  if (!open.length) {
    throw new BoardError(409, 'Attendance is not open right now. The secretary opens attendance before each meeting.', 'not_open');
  }
  open.sort((a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || '')));
  return open[0];
}

// ── Attendance ─────────────────────────────────────────────────────

/** A board member marking themselves present by scanning the live QR. */
export async function markBySelf(meeting, member, { userAgent = '' } = {}) {
  // The route resolves the open meeting; this re-check covers the moment
  // between resolving and writing.
  if (meeting.status !== 'open') {
    throw new BoardError(409, meeting.status === 'closed' ? 'Attendance for this meeting has closed.' : 'Attendance for this meeting has not opened yet.', 'not_open');
  }
  if (member.status !== 'active') throw new BoardError(403, 'Your board profile is not active.', 'inactive');
  // A reopened meeting keeps the roster it closed with.
  if (Array.isArray(meeting.roster) && !meeting.roster.includes(member.id)) {
    throw new BoardError(403, 'You are not on the board for this meeting.', 'not_on_roster');
  }

  const key = KEYS.boardAttendance(meeting.id, member.id);
  const at = nowIso();
  const entry = { status: 'present', at, method: 'qr', by: member.email };
  const record = { meetingId: meeting.id, memberId: member.id, status: 'present', at, method: 'qr', userAgent: String(userAgent).slice(0, 160), history: [entry] };

  if (await withRetry(() => kv.set(key, record, { nx: true }))) return { meeting, record, alreadyMarked: false };

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
    await fencedWrite(lockName, lock, [['set', key, upgraded]]);
    return { meeting, record: upgraded, alreadyMarked: false };
  } finally {
    await releaseLock(lockName, lock);
  }
}

// ── Mark by name (no sign-in) ──────────────────────────────────────
// Scan the live QR, tap your name. A 5-minute single-use pass covers
// picking the name after the scan. Each name can be marked once per
// meeting, and each phone can mark only one name.

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
 * After a scan: the names to choose from, and a pass to mark one of them.
 * Only names are returned (no email or phone). When this phone has already
 * marked someone at this meeting, says who, and issues no pass.
 */
export async function openNameMarking(deviceId) {
  requireDeviceId(deviceId);
  const meeting = await resolveOpenMeeting();
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
  await withRetry(() => kv.set(KEYS.boardNamePass(pass), { meetingId: meeting.id, device: deviceHash(deviceId) }, { ex: NAME_PASS_TTL_SECONDS }));
  return { meeting: view, members, pass, markedByThisPhone: null };
}

/** Marks one name present with a pass from openNameMarking. */
export async function markByName(pass, memberId, deviceId, { userAgent = '' } = {}) {
  requireDeviceId(deviceId);
  const passKey = KEYS.boardNamePass(String(pass || ''));
  const rawPass = /^[A-Za-z0-9_-]{32}$/.test(String(pass || '')) ? await withRetry(() => kv.get(passKey)) : null;
  const passData = typeof rawPass === 'string' ? JSON.parse(rawPass) : rawPass;
  const device = deviceHash(deviceId);
  // A pass is tied to the phone that scanned, so it cannot be forwarded.
  if (!passData?.meetingId || passData.device !== device) {
    throw new BoardError(410, 'This page has expired. Scan the code on the screen again.', 'expired');
  }

  const meeting = await openMeetingFor(passData.meetingId);
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
    written = await withRetry(() => kv.set(KEYS.boardAttendance(meeting.id, member.id), record, { nx: true }));
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
    await fencedWrite(lockName, lock, [['set', key, record]]);
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
  return { meeting: publicMeeting(meeting), rows, counts: countRows(rows) };
}

export function countRows(rows) {
  const counts = { roster: rows.length, present: 0, leave: 0, absent: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

/** A meeting without its QR secret, for anything sent to a browser. */
export function publicMeeting(m) {
  const { secret, ...rest } = m;
  return rest;
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
