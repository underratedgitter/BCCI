// Board portal: profiles, sign-in codes, meetings, QR attendance, the
// secretary's overrides and the Excel register, through the real route.
//
//   node tests/board.test.mjs                          # mock Upstash

import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { startMockRedis } from './mock-redis.mjs';
import { startMockSmtp } from './smtp-server.mjs';

const redis = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = redis.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 't';

const smtp = await startMockSmtp();
Object.assign(process.env, {
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false',
  SMTP_USER: 'portal@bccibharuch.in', SMTP_PASS: 'pw', EMAIL_FROM: 'BCCI <portal@bccibharuch.in>',
  ALLOWED_ORIGIN: 'https://bccibharuch.in',
});

const board = (await import('../api/board.js')).default;
const { kv, KEYS } = await import('../api/_lib/kv.js');
const lib = await import('../api/_lib/board.js');

let pass = 0, fail = 0;
const ck = (n, c, d = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d ? ' — ' + d : ''))); };
const sec = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

const ADMIN = 'board-test-admin-token';
await kv.set(KEYS.adminSession(ADMIN), 'secretariat@bccibharuch.in', { ex: 3600 });

/** Calls the route the way Vercel and server.js do. */
async function call(action, { method = 'POST', body, token, query = {}, ip = '203.0.113.10' } = {}) {
  const req = {
    method,
    query: { action, ...query },
    body: method === 'POST' ? (body || {}) : undefined,
    headers: { 'x-forwarded-for': ip, 'user-agent': 'board-test', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  };
  const out = { status: 200, json: null, headers: {}, body: null };
  const res = {
    statusCode: 200,
    headersSent: false,
    status(c) { out.status = c; this.statusCode = c; return this; },
    json(d) { out.json = d; return this; },
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; return this; },
    end(b) { out.status = this.statusCode; out.body = b; return this; },
  };
  await board(req, res);
  return out;
}

const waitMail = async (n, ms = 3000) => {
  const t0 = Date.now();
  while (smtp.received.length < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 30));
  return smtp.received.length >= n;
};

/** The open meeting's PIN, as the projector shows it (null when none is open). */
async function openPin() {
  try {
    return await lib.getMeetingPin((await lib.resolveOpenMeeting()).id);
  } catch {
    return null;
  }
}

async function signIn(email) {
  await kv.del(`bcci:rl:board:code:addr:${email}`);
  const r = await call('request-code', { body: { email } });
  const code = await kv.get(KEYS.boardOtp(email));
  const v = await call('verify-code', { body: { email, code: String(code) } });
  return { r, v, token: v.json?.session?.token };
}

/** Reads one file out of an .xlsx (a zip) without a library. */
function unzipEntry(buf, name) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const size = buf.readUInt32LE(p + 20), local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entry === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      return inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
    }
    p += 46 + nameLen + extra + comment;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════
sec('Board profiles');

let r = await call('members', { method: 'GET' });
ck('member list needs the superadmin', r.status === 401);

r = await call('member-save', { token: ADMIN, body: { name: 'A', designation: 'President', email: 'asha@example.com', mobile: '9825012345' } });
ck('a too-short name is refused', r.status === 400 && /name/i.test(r.json?.error));
r = await call('member-save', { token: ADMIN, body: { name: 'Asha Patel', designation: 'President', email: 'not-an-email', mobile: '9825012345' } });
ck('an invalid email is refused', r.status === 400 && /email/i.test(r.json?.error));
r = await call('member-save', { token: ADMIN, body: { name: 'Asha Patel', designation: 'President', email: 'asha@example.com', mobile: '12345' } });
ck('an invalid mobile is refused', r.status === 400 && /mobile/i.test(r.json?.error));

const mailsBefore = smtp.received.length;
const asha = await call('member-save', { token: ADMIN, body: { name: 'Asha Patel', designation: 'President', email: 'Asha@Example.com', mobile: '+91 98250 12345', company: 'Patel Chem' } });
ck('superadmin creates a profile → 201', asha.status === 201 && asha.json?.member?.id === 'BM-1', JSON.stringify(asha.json));
ck('email is stored lower-case and mobile as 10 digits', asha.json?.member?.email === 'asha@example.com' && asha.json?.member?.mobile === '9825012345');
await waitMail(mailsBefore + 1);
ck('the new member gets a welcome email', asha.json?.welcomeSent === true && smtp.received.at(-1)?.to.includes('asha@example.com'));
ck('the welcome email points at the portal', /bccibharuch\.in\/board/.test(smtp.received.at(-1)?.body || ''));

const bharat = await call('member-save', { token: ADMIN, body: { name: 'Bharat Shah', designation: 'Hon. Treasurer', email: 'bharat@example.com', mobile: '9825012346' } });
const chirag = await call('member-save', { token: ADMIN, body: { name: 'Chirag Desai', designation: 'Hon. Secretary', email: 'chirag@example.com', mobile: '9825012347' } });
ck('each profile gets its own id', bharat.json?.member?.id === 'BM-2' && chirag.json?.member?.id === 'BM-3');

r = await call('member-save', { token: ADMIN, body: { name: 'Asha Again', designation: 'Director', email: 'ASHA@example.com', mobile: '9825012348' } });
ck('a second profile with the same email is refused (409)', r.status === 409 && r.json?.code === 'email_taken');

r = await call('member-save', { token: ADMIN, body: { id: 'BM-2', name: 'Bharat Shah', designation: 'Hon. Treasurer', email: 'bharat.shah@example.com', mobile: '9825012346' } });
ck('a profile can change its email', r.status === 200 && r.json?.member?.email === 'bharat.shah@example.com' && r.json?.created === false);
const dina = await call('member-save', { token: ADMIN, body: { name: 'Dina Mehta', designation: 'Director', email: 'bharat@example.com', mobile: '9825012349' } });
ck('the old email is free again afterwards', dina.status === 201, JSON.stringify(dina.json));

r = await call('members', { method: 'GET', token: ADMIN });
ck('superadmin sees every profile in order', r.json?.members?.map((m) => m.id).join() === 'BM-1,BM-2,BM-3,BM-4', JSON.stringify(r.json?.members?.map((m) => m.id)));

// ════════════════════════════════════════════════════════════════════
sec('Signing in with an emailed code');

let mails = smtp.received.length;
r = await call('request-code', { body: { email: 'stranger@example.com' } });
ck('an unknown email gets the same answer', r.status === 200 && /If this email belongs/.test(r.json?.message));
await new Promise((res) => setTimeout(res, 150));
ck('…and no email is sent to it', smtp.received.length === mails);

r = await call('request-code', { body: { email: 'asha@example.com' } });
await waitMail(mails + 1);
const code = String(await kv.get(KEYS.boardOtp('asha@example.com')));
ck('a board member is emailed a 6-digit code', r.status === 200 && /^\d{6}$/.test(code) && (smtp.received.at(-1)?.body || '').includes(code));
r = await call('request-code', { body: { email: 'asha@example.com' } });
ck('asking again within a minute is rate-limited', r.status === 429);

r = await call('verify-code', { body: { email: 'asha@example.com', code: code === '111111' ? '222222' : '111111' } });
ck('a wrong code is refused', r.status === 400);
r = await call('verify-code', { body: { email: 'asha@example.com', code } });
const ashaToken = r.json?.session?.token;
ck('the right code signs in', r.status === 200 && typeof ashaToken === 'string' && ashaToken.length === 64 && r.json?.member?.id === 'BM-1');
ck('the session lasts 30 days', Math.abs(r.json?.session?.expiresAt - Date.now() - 30 * 86400e3) < 60e3, String(r.json?.session?.expiresAt - Date.now()));
const ashaStored = await kv.get(KEYS.boardSession(ashaToken));
ck('the session records when it was issued', Math.abs((typeof ashaStored === 'string' ? JSON.parse(ashaStored) : ashaStored)?.issuedAt - Date.now()) < 60e3);
r = await call('verify-code', { body: { email: 'asha@example.com', code } });
ck('a code works only once', r.status === 400);

await kv.del('bcci:rl:board:code:addr:chirag@example.com');
await call('request-code', { body: { email: 'chirag@example.com' } });
let last;
for (let i = 0; i < 6; i++) last = await call('verify-code', { body: { email: 'chirag@example.com', code: '000000' } });
ck('six wrong guesses lock the code out', last.status === 429);

r = await call('me', { method: 'GET', token: ashaToken });
ck('a signed-in member sees their own profile', r.status === 200 && r.json?.member?.name === 'Asha Patel' && r.json?.member?.email === 'asha@example.com');
r = await call('members', { method: 'GET', token: ashaToken });
ck('a board session is not a superadmin session', r.status === 401);
r = await call('me', { method: 'GET', token: ADMIN });
ck('a superadmin session is not a board session', r.status === 401);

// ════════════════════════════════════════════════════════════════════
sec('Session lifetime: 30 idle days, renewed on use, 90 days at most');

const DAY_S = 86400;
const near = (a, b, tol = 120) => Math.abs(a - b) <= tol;
const ASHA = { memberId: 'BM-1', email: 'asha@example.com' };
/** Plants a session with the given value and TTL, uses it once, reads it back. */
async function useSession(value, ttlSec) {
  const t = crypto.randomBytes(32).toString('hex');
  await kv.set(KEYS.boardSession(t), value, { ex: ttlSec });
  const res = await call('me', { method: 'GET', token: t });
  const raw = await kv.get(KEYS.boardSession(t));
  return {
    res,
    ttl: await kv.ttl(KEYS.boardSession(t)),
    stored: typeof raw === 'string' ? JSON.parse(raw) : raw,
    header: Number(res.headers['x-session-expires-in']),
  };
}

let u = await useSession({ ...ASHA, issuedAt: Date.now() - 10 * DAY_S * 1000 }, 20 * DAY_S);
ck('with more than half the window left, use does not renew', u.res.status === 200 && near(u.ttl, 20 * DAY_S), `ttl ${u.ttl}`);
ck('each signed-in reply reports the time left', near(u.header, 20 * DAY_S), `header ${u.header}`);
ck('the lifetime header is exposed to cross-origin callers', u.res.headers['access-control-expose-headers'] === 'X-Session-Expires-In', String(u.res.headers['access-control-expose-headers']));

u = await useSession({ ...ASHA, issuedAt: Date.now() - 20 * DAY_S * 1000 }, 10 * DAY_S);
ck('with less than half left, use renews to a full 30 days', u.res.status === 200 && near(u.ttl, 30 * DAY_S), `ttl ${u.ttl}`);
ck('the reply reports the renewed lifetime', near(u.header, 30 * DAY_S), `header ${u.header}`);

u = await useSession({ ...ASHA, issuedAt: Date.now() - 80 * DAY_S * 1000 }, 5 * DAY_S);
ck('renewal stops at 90 days from sign-in', u.res.status === 200 && near(u.ttl, 10 * DAY_S) && near(u.header, 10 * DAY_S), `ttl ${u.ttl}, header ${u.header}`);

u = await useSession({ ...ASHA, issuedAt: Date.now() - 91 * DAY_S * 1000 }, 5 * DAY_S);
ck('a session past 90 days is refused and deleted', u.res.status === 401 && u.res.json?.code === 'signed_out' && u.ttl === -2, `status ${u.res.status}, ttl ${u.ttl}`);

u = await useSession(ASHA, 170 * DAY_S);
ck('a 180-day session from before the change drops to 30 days on use',
  u.res.status === 200 && near(u.ttl, 30 * DAY_S) && near(u.header, 30 * DAY_S), `ttl ${u.ttl}, header ${u.header}`);
ck('and is stamped with the sign-in date its TTL implies (10 days ago)',
  Math.abs(u.stored?.issuedAt - (Date.now() - 10 * DAY_S * 1000)) < 300e3, String(u.stored?.issuedAt));

u = await useSession(ASHA, 110 * DAY_S);
ck('an old session issued 70 days ago gets only the 20 days left under the ceiling', u.res.status === 200 && near(u.ttl, 20 * DAY_S), `ttl ${u.ttl}`);

u = await useSession(ASHA, 80 * DAY_S);
ck('an old session issued 100 days ago is refused', u.res.status === 401 && u.ttl === -2, `status ${u.res.status}, ttl ${u.ttl}`);

// A sign-out landing between the TTL read and the renewal: the session is
// gone, so the request must not report a renewed lifetime for it.
{
  const t = crypto.randomBytes(32).toString('hex');
  const key = KEYS.boardSession(t);
  await kv.set(key, { ...ASHA, issuedAt: Date.now() - 20 * DAY_S * 1000 }, { ex: 10 * DAY_S });
  // Upstash's client is a Proxy, so the delete goes in through the mock's
  // command hook rather than by wrapping kv.expire.
  const hook = (cmd) => {
    if (String(cmd[0]).toUpperCase() === 'EXPIRE' && cmd[1] === key) redis.store.delete(key);
  };
  redis.beforeCommand.push(hook);
  try {
    r = await call('me', { method: 'GET', token: t });
  } finally {
    redis.beforeCommand.splice(redis.beforeCommand.indexOf(hook), 1);
  }
  ck('a session signed out mid-renewal is refused, not reported as renewed',
    r.status === 401 && r.headers['x-session-expires-in'] === undefined && (await kv.get(key)) === null, `status ${r.status}`);
}

r = await call('me', { method: 'GET', token: crypto.randomBytes(32).toString('hex') });
ck('a refused session gets no lifetime header', r.status === 401 && r.headers['x-session-expires-in'] === undefined);

// ════════════════════════════════════════════════════════════════════
sec('Meetings and the live QR');

r = await call('meeting-save', { token: ADMIN, body: { title: 'Board meeting', date: '2026-08-15', time: '25:00' } });
ck('an impossible start time is refused', r.status === 400);
r = await call('meeting-save', { token: ADMIN, body: { title: 'Board meeting', date: '2026-02-31', time: '10:00' } });
ck('a date the calendar does not have (31 Feb) is refused', r.status === 400 && /real date/.test(r.json?.error || ''), JSON.stringify(r.json));
r = await call('meeting-save', { token: ADMIN, body: { title: 'Board meeting', date: '2026-02-29', time: '10:00' } });
ck('29 Feb in a non-leap year is refused', r.status === 400);
ck('29 Feb in a leap year is accepted by the validator', !lib.validateMeetingFields({ title: 'Leap day', date: '2028-02-29', time: '10:00' }, { str: (v, n) => String(v ?? '').trim().slice(0, n) }).error);
const m1 = await call('meeting-save', { token: ADMIN, body: { title: 'Board meeting', date: '2026-08-15', time: '10:00', venue: 'BCCI Hall' } });
const m2 = await call('meeting-save', { token: ADMIN, body: { title: 'AGM preparation', date: '2026-08-30', time: '17:30' } });
ck('superadmin schedules meetings', m1.status === 201 && m1.json?.meeting?.id === 'MTG-1' && m2.json?.meeting?.id === 'MTG-2');
ck('no secret ever leaves the server', m1.json?.meeting?.secret === undefined && m2.json?.meeting?.secret === undefined);

const { token: bharatToken } = await signIn('bharat.shah@example.com');
const { token: chiragToken } = await signIn('chirag@example.com');
const { token: dinaToken } = await signIn('bharat@example.com');
ck('other members sign in', [bharatToken, chiragToken, dinaToken].every((t) => typeof t === 'string'));

r = await call('attend', { token: ashaToken, body: { pin: await openPin() } });
ck('attendance before the meeting opens is refused', r.status === 409 && r.json?.code === 'not_open');
r = await call('live', { method: 'GET', token: ADMIN, query: { id: 'MTG-1' } });
ck('the projector has nothing to show before opening', r.status === 409);

r = await call('meeting-open', { token: ADMIN, body: { id: 'MTG-1' } });
ck('superadmin opens attendance', r.status === 200 && r.json?.meeting?.status === 'open');
let live = await call('live', { method: 'GET', token: ADMIN, query: { id: 'MTG-1' } });
ck('the projector no longer returns a rotating code', live.json?.code === undefined && live.json?.refreshInMs === undefined, JSON.stringify(live.json));
ck('the projector sees the roster count', live.json?.counts?.roster === 4 && live.json?.counts?.present === 0, JSON.stringify(live.json?.counts));

r = await call('attend', { token: ashaToken, body: { pin: await openPin() } });
ck('scanning the live QR marks the member present', r.status === 200 && r.json?.alreadyMarked === false && !!r.json?.at, JSON.stringify(r.json));
r = await call('attend', { token: ashaToken, body: { pin: await openPin() } });
ck('scanning twice says already marked, not twice', r.status === 200 && r.json?.alreadyMarked === true);
r = await call('attend', { body: {} });
ck('scanning while signed out is refused', r.status === 401 && r.json?.code === 'signed_out');
r = await call('names', { body: { pin: await openPin(), meetingId: 'MTG-9', code: 'STALE', deviceId: 'legacy-' + crypto.randomUUID() } });
ck('a legacy meeting/code in the body is ignored; the open meeting wins', r.status === 200 && r.json?.meeting?.id === 'MTG-1', JSON.stringify(r.json));

r = await call('meeting-open', { token: ADMIN, body: { id: 'MTG-2' } });
ck('opening a second meeting while one is open is refused', r.status === 409 && r.json?.code === 'another_open', JSON.stringify(r.json));

live = await call('live', { method: 'GET', token: ADMIN, query: { id: 'MTG-1' } });
ck('the projector shows who is in, with designation', live.json?.counts?.present === 1 && live.json?.present?.[0]?.name === 'Asha Patel' && live.json?.present?.[0]?.designation === 'President');
ck('the projector list carries no contact details', live.json?.present?.[0]?.email === undefined && live.json?.present?.[0]?.mobile === undefined);

// ════════════════════════════════════════════════════════════════════
sec("The secretary's overrides and closing");

r = await call('mark', { token: ADMIN, body: { meetingId: 'MTG-1', memberId: 'BM-2', status: 'leave' } });
ck('an override without a reason is refused', r.status === 400 && r.json?.code === 'reason_required');
r = await call('mark', { token: ADMIN, body: { meetingId: 'MTG-1', memberId: 'BM-2', status: 'leave', reason: 'Travelling, informed in advance' } });
ck('superadmin grants leave with a reason', r.status === 200 && r.json?.record?.status === 'leave' && r.json?.record?.history?.length === 1);

{
  // A concurrent writer holds this record's lock: the override must refuse
  // rather than write a history that could drop the other writer's entry.
  const { acquireLock, releaseLock } = await import('../api/_lib/records.js');
  const lockName = `attendance:${KEYS.boardAttendance('MTG-1', 'BM-2')}`;
  const held = await acquireLock(lockName, 30);
  r = await call('mark', { token: ADMIN, body: { meetingId: 'MTG-1', memberId: 'BM-2', status: 'absent', reason: 'Written while locked' } });
  await releaseLock(lockName, held);
  ck('an override that cannot get the record lock → 409 busy', r.status === 409 && r.json?.code === 'busy', JSON.stringify(r.json));
  const kept = await kv.get(KEYS.boardAttendance('MTG-1', 'BM-2'));
  const keptRecord = typeof kept === 'string' ? JSON.parse(kept) : kept;
  ck('and the record keeps its leave mark and single history entry', keptRecord?.status === 'leave' && keptRecord?.history?.length === 1, JSON.stringify(keptRecord));
}

r = await call('member-status', { token: ADMIN, body: { id: 'BM-3', status: 'inactive' } });
ck('superadmin deactivates a profile', r.status === 200 && r.json?.member?.status === 'inactive');
r = await call('me', { method: 'GET', token: chiragToken });
ck("a deactivated member's session stops working at once", r.status === 401);
r = await call('mark', { token: ADMIN, body: { meetingId: 'MTG-1', memberId: 'BM-3', status: 'present', reason: 'test' } });
ck('a deactivated member cannot be marked at an open meeting', r.status === 409 && r.json?.code === 'not_on_roster');

r = await call('meeting-close', { token: ADMIN, body: { id: 'MTG-1' } });
ck('superadmin closes the meeting', r.status === 200 && r.json?.meeting?.status === 'closed' && r.json?.meeting?.roster?.join() === 'BM-1,BM-2,BM-4', JSON.stringify(r.json?.meeting?.roster));
r = await call('attend', { token: dinaToken, body: { pin: await openPin() } });
ck('scanning after closing is refused', r.status === 409 && r.json?.code === 'not_open');
r = await call('mark', { token: ADMIN, body: { meetingId: 'MTG-1', memberId: 'BM-4', status: 'present', reason: 'Late correction' } });
ck('the secretary cannot rewrite a closed register', r.status === 409 && r.json?.code === 'not_open', JSON.stringify(r.json));
r = await call('mark', { token: ADMIN, body: { meetingId: 'MTG-2', memberId: 'BM-1', status: 'leave', reason: 'Travelling, informed in advance' } });
ck('nor mark anyone at a meeting that has not opened', r.status === 409 && r.json?.code === 'not_open', JSON.stringify(r.json));
r = await call('meeting', { method: 'GET', token: ADMIN, query: { id: 'MTG-1' } });
const statuses = Object.fromEntries((r.json?.rows || []).map((x) => [x.memberId, x.status]));
ck('the meeting record shows present, leave and absent', statuses['BM-1'] === 'present' && statuses['BM-2'] === 'leave' && statuses['BM-4'] === 'absent', JSON.stringify(statuses));
ck('counts add up', r.json?.counts?.present === 1 && r.json?.counts?.leave === 1 && r.json?.counts?.absent === 1 && r.json?.counts?.roster === 3);

r = await call('member-status', { token: ADMIN, body: { id: 'BM-3', status: 'active' } });
r = await call('meeting', { method: 'GET', token: ADMIN, query: { id: 'MTG-1' } });
ck("reactivating someone later does not rewrite a closed meeting's roster", r.json?.rows?.length === 3);

// ════════════════════════════════════════════════════════════════════
sec('Many members scanning at once');

await call('meeting-open', { token: ADMIN, body: { id: 'MTG-2' } });
const extra = [];
for (let i = 0; i < 6; i++) {
  const m = await call('member-save', { token: ADMIN, body: { name: `Director ${i}`, designation: 'Director', email: `director${i}@example.com`, mobile: `98250200${String(i).padStart(2, '0')}` } });
  extra.push((await signIn(m.json.member.email)).token);
}
live = await call('live', { method: 'GET', token: ADMIN, query: { id: 'MTG-2' } });
const burstPin = await openPin();
const burst = await Promise.all([bharatToken, dinaToken, ...extra].map((t, i) =>
  call('attend', { token: t, ip: `203.0.113.${50 + i}`, body: { pin: burstPin } })));
ck('eight members scanning in the same instant are all recorded', burst.every((x) => x.status === 200 && x.json?.alreadyMarked === false), burst.map((x) => x.status).join());
const repeat = await Promise.all(Array.from({ length: 8 }, () => call('attend', { token: bharatToken, body: { pin: burstPin } })));
ck('one member double-tapping eight times is recorded once', repeat.every((x) => x.status === 200 && x.json?.alreadyMarked === true));
live = await call('live', { method: 'GET', token: ADMIN, query: { id: 'MTG-2' } });
ck('the projector counts all eight', live.json?.counts?.present === 8, JSON.stringify(live.json?.counts));
await call('meeting-close', { token: ADMIN, body: { id: 'MTG-2' } });

const m3 = await call('meeting-save', { token: ADMIN, body: { title: 'Created by mistake', date: '2026-09-01', time: '11:00' } });
r = await call('meeting-delete', { token: ADMIN, body: { id: 'MTG-1' } });
ck('a meeting with attendance cannot be deleted', r.status === 409);
r = await call('meeting-delete', { token: ADMIN, body: { id: m3.json.meeting.id } });
ck('an empty meeting can be deleted', r.status === 200);
r = await call('meetings', { method: 'GET', token: ADMIN });
ck('deleted meetings disappear; the rest list newest first with counts',
  r.json?.meetings?.map((m) => m.id).join() === 'MTG-2,MTG-1' && r.json.meetings[1].presentCount === 1 && r.json.meetings[1].rosterCount === 3,
  JSON.stringify(r.json?.meetings?.map((m) => [m.id, m.presentCount, m.rosterCount])));

// ════════════════════════════════════════════════════════════════════
sec("A member's own history");

r = await call('me', { method: 'GET', token: ashaToken });
const items = Object.fromEntries((r.json?.items || []).map((i) => [i.meeting.id, i.status]));
ck('shows present at the first meeting and absent at the second', items['MTG-1'] === 'present' && items['MTG-2'] === 'absent', JSON.stringify(items));
ck('shows attended 1 of 2 (50%)', r.json?.stats?.held === 2 && r.json?.stats?.attended === 1 && r.json?.stats?.rate === 0.5, JSON.stringify(r.json?.stats));

// ════════════════════════════════════════════════════════════════════
sec('The Excel register');

r = await call('register', { method: 'GET' });
ck('the register needs the superadmin', r.status === 401);
r = await call('register', { method: 'GET', token: ADMIN });
ck('superadmin downloads an .xlsx file', r.status === 200 && /spreadsheetml/.test(r.headers['content-type']) && /attachment; filename="BCCI_Board_Attendance_Register_/.test(r.headers['content-disposition']) && Buffer.isBuffer(r.body) && r.body.subarray(0, 2).toString() === 'PK');
const sheet1 = unzipEntry(r.body, 'xl/worksheets/sheet1.xml') || '';
const workbook = unzipEntry(r.body, 'xl/workbook.xml') || '';
ck('it has the Board Register, Meetings and Scan Log sheets', /name="Board Register"/.test(workbook) && /name="Meetings"/.test(workbook) && /name="Scan Log"/.test(workbook));
ck('both meetings are columns, oldest first', sheet1.indexOf('15 Aug 2026') > 0 && sheet1.indexOf('15 Aug 2026') < sheet1.indexOf('30 Aug 2026'));
const ashaRow = sheet1.split('<row ').find((x) => x.includes('Asha Patel')) || '';
ck("Asha's row: P at the first meeting, A at the second, 50%", />P</.test(ashaRow) && />A</.test(ashaRow) && /<v>0.5<\/v>/.test(ashaRow), ashaRow.slice(0, 300));
const bharatRow = sheet1.split('<row ').find((x) => x.includes('Bharat Shah')) || '';
ck("Bharat's row: L then P", bharatRow.indexOf('>L<') > 0 && bharatRow.indexOf('>L<') < bharatRow.indexOf('>P<'));
const scanLog = unzipEntry(r.body, 'xl/worksheets/sheet3.xml') || '';
ck('the scan log records the leave reason and who granted it', scanLog.includes('Travelling, informed in advance') && scanLog.includes('secretariat@bccibharuch.in'));

r = await call('sign-out', { token: ashaToken });
r = await call('me', { method: 'GET', token: ashaToken });
ck('signing out ends the session', r.status === 401);

// ════════════════════════════════════════════════════════════════════
sec('Mark by name: scan, tap your name, one response per phone');
{
  const PHONE_A = 'phone-a-' + crypto.randomUUID();
  const PHONE_B = 'phone-b-' + crypto.randomUUID();
  const PHONE_C = 'phone-c-' + crypto.randomUUID();
  const PHONE_D = 'phone-d-' + crypto.randomUUID();
  const esha = (await call('member-save', { token: ADMIN, body: { name: 'Esha Name', designation: 'Director', email: 'esha.name@example.com', mobile: '9825012361' } })).json?.member;
  const farid = (await call('member-save', { token: ADMIN, body: { name: 'Farid Name', designation: 'Director', email: 'farid.name@example.com', mobile: '9825012362' } })).json?.member;
  const gita = (await call('member-save', { token: ADMIN, body: { name: 'Gita Former', designation: 'Director', email: 'gita.former@example.com', mobile: '9825012363' } })).json?.member;
  await call('member-status', { token: ADMIN, body: { id: gita.id, status: 'inactive' } });
  const saved = await call('meeting-save', { token: ADMIN, body: { title: 'Name-tap meeting', date: '2026-09-10', time: '11:00' } });
  const mtg = saved.json?.meeting?.id;
  r = await call('names', { body: { pin: await openPin(), deviceId: PHONE_A } });
  ck('names before the meeting opens → 409 not_open', r.status === 409 && r.json?.code === 'not_open', JSON.stringify(r.json));
  await call('meeting-open', { token: ADMIN, body: { id: mtg } });

  r = await call('names', { body: { pin: await openPin(), deviceId: 'short' } });
  ck('a request without a usable phone id is refused', r.status === 400 && r.json?.code === 'no_device');

  r = await call('names', { body: { pin: await openPin(), deviceId: PHONE_A } });
  const names = (r.json?.members || []).map((m) => m.name);
  ck('a scan lists the active board, alphabetically, with a pass', r.status === 200 && typeof r.json?.pass === 'string'
    && names.includes('Esha Name') && names.includes('Farid Name') && !names.includes('Gita Former') && names.join() === [...names].sort((a, b) => a.localeCompare(b)).join(), JSON.stringify(names));
  ck('the list carries names only, no contact details', JSON.stringify(r.json?.members || []).match(/@|98250/) === null);
  const passA1 = r.json?.pass;
  const passA2 = (await call('names', { body: { pin: await openPin(), deviceId: PHONE_A } })).json?.pass;

  r = await call('mark-name', { body: { pass: passA1, memberId: esha.id, deviceId: PHONE_B } });
  ck('a pass only works on the phone that scanned', r.status === 410 && r.json?.code === 'expired');
  r = await call('mark-name', { body: { pass: passA1, memberId: esha.id, deviceId: PHONE_A } });
  ck('tapping a name marks it present', r.status === 200 && r.json?.member?.name === 'Esha Name');
  const rec = await kv.get(KEYS.boardAttendance(mtg, esha.id));
  const record = typeof rec === 'string' ? JSON.parse(rec) : rec;
  ck('the mark is recorded as by name, with the phone', record?.status === 'present' && record?.method === 'name' && /^[0-9a-f]{8}$/.test(record?.device || ''), JSON.stringify(record));
  r = await call('mark-name', { body: { pass: passA1, memberId: farid.id, deviceId: PHONE_A } });
  ck('a used pass cannot be used again', r.status === 410);
  r = await call('mark-name', { body: { pass: passA2, memberId: farid.id, deviceId: PHONE_A } });
  ck('one phone, one response: a second name from the same phone is refused', r.status === 409 && r.json?.code === 'device_used' && /Esha Name/.test(r.json?.error || ''), JSON.stringify(r.json));
  r = await call('names', { body: { pin: await openPin(), deviceId: PHONE_A } });
  ck('scanning again on that phone says who it marked, with no pass', r.status === 200 && r.json?.pass === null && r.json?.markedByThisPhone === 'Esha Name');
  ck('and shows that name as marked', r.json?.members?.find((m) => m.name === 'Esha Name')?.marked === true);

  const passB = (await call('names', { body: { pin: await openPin(), deviceId: PHONE_B } })).json?.pass;
  r = await call('mark-name', { body: { pass: passB, memberId: esha.id, deviceId: PHONE_B } });
  ck('one response per name: a name already marked is refused', r.status === 409 && r.json?.code === 'already_marked');
  r = await call('mark-name', { body: { pass: passB, memberId: farid.id, deviceId: PHONE_B } });
  ck('…without using up that phone, which can still mark its own name', r.status === 200 && r.json?.member?.name === 'Farid Name', JSON.stringify(r.json));

  // A secretary's leave mark is never overwritten by a tap.
  await call('mark', { token: ADMIN, body: { meetingId: mtg, memberId: 'BM-2', status: 'leave', reason: 'Informed in advance' } });
  const passC = (await call('names', { body: { pin: await openPin(), deviceId: PHONE_C } })).json?.pass;
  r = await call('mark-name', { body: { pass: passC, memberId: 'BM-2', deviceId: PHONE_C } });
  const bm2 = await kv.get(KEYS.boardAttendance(mtg, 'BM-2'));
  ck('a name the secretary marked on leave cannot be tapped present', r.status === 409 && (typeof bm2 === 'string' ? JSON.parse(bm2) : bm2)?.status === 'leave');
  r = await call('mark-name', { body: { pass: passC, memberId: gita.id, deviceId: PHONE_C } });
  ck('an inactive profile cannot be tapped', r.status === 404 && r.json?.code === 'not_on_roster');

  // Two passes taken before either is used: still only one response.
  const passD1 = (await call('names', { body: { pin: await openPin(), deviceId: PHONE_D } })).json?.pass;
  const passD2 = (await call('names', { body: { pin: await openPin(), deviceId: PHONE_D } })).json?.pass;
  const [d1, d2] = await Promise.all([
    call('mark-name', { body: { pass: passD1, memberId: 'BM-1', deviceId: PHONE_D } }),
    call('mark-name', { body: { pass: passD2, memberId: 'BM-4', deviceId: PHONE_D } }),
  ]);
  ck('two taps at once from one phone: exactly one is accepted', [d1.status, d2.status].filter((x) => x === 200).length === 1 && [d1.status, d2.status].includes(409), `${d1.status} ${d2.status}`);

  await call('meeting-close', { token: ADMIN, body: { id: mtg } });
  r = await call('names', { body: { pin: await openPin(), deviceId: PHONE_C } });
  ck('after closing, the name list is refused', r.status === 409 && r.json?.code === 'not_open');
  r = await call('meeting', { method: 'GET', token: ADMIN, query: { id: mtg } });
  ck('the secretary sees the name-tap marks', r.json?.rows?.filter((x) => x.method === 'name').length === 3, JSON.stringify(r.json?.rows?.map((x) => [x.memberId, x.status, x.method])));
}

// ════════════════════════════════════════════════════════════════════
sec('Mark by name: a failed write leaves the phone free to try again');
{
  const PHONE = 'phone-e-' + crypto.randomUUID();
  const hana = (await call('member-save', { token: ADMIN, body: { name: 'Hana Retry', designation: 'Director', email: 'hana.retry@example.com', mobile: '9825012364' } })).json?.member;
  const mtg = (await call('meeting-save', { token: ADMIN, body: { title: 'Outage meeting', date: '2026-09-12', time: '11:00' } })).json?.meeting?.id;
  await call('meeting-open', { token: ADMIN, body: { id: mtg } });
  const passKey = (await call('names', { body: { pin: await openPin(), deviceId: PHONE } })).json?.pass;

  const markKey = KEYS.boardAttendance(mtg, hana.id);
  redis.failKeys.add(markKey);
  let failed = false;
  try {
    r = await call('mark-name', { body: { pass: passKey, memberId: hana.id, deviceId: PHONE } });
    failed = r.status >= 500;
  } catch {
    failed = true;
  }
  redis.failKeys.delete(markKey);
  ck('a storage failure on the mark is an error, not a success', failed);

  r = await call('names', { body: { pin: await openPin(), deviceId: PHONE } });
  ck('…and the phone is not left claiming a name it never marked', r.status === 200 && r.json?.markedByThisPhone === null && typeof r.json?.pass === 'string', JSON.stringify(r.json));
  r = await call('mark-name', { body: { pass: r.json?.pass, memberId: hana.id, deviceId: PHONE } });
  ck('…so the same phone can mark the name once storage is back', r.status === 200 && r.json?.member?.name === 'Hana Retry', JSON.stringify(r.json));
  await call('meeting-close', { token: ADMIN, body: { id: mtg } });
}

// ════════════════════════════════════════════════════════════════════
sec('Reopening a meeting keeps the roster it closed with');
{
  const ivan = (await call('member-save', { token: ADMIN, body: { name: 'Ivan Leaving', designation: 'Director', email: 'ivan.leaving@example.com', mobile: '9825012365' } })).json?.member;
  const mtg = (await call('meeting-save', { token: ADMIN, body: { title: 'Reopen meeting', date: '2026-09-14', time: '11:00' } })).json?.meeting?.id;
  await call('meeting-open', { token: ADMIN, body: { id: mtg } });
  await call('meeting-close', { token: ADMIN, body: { id: mtg } });
  const before = (await call('meeting', { method: 'GET', token: ADMIN, query: { id: mtg } })).json?.rows?.map((x) => x.memberId) || [];

  await call('member-status', { token: ADMIN, body: { id: ivan.id, status: 'inactive' } });
  const jaya = (await call('member-save', { token: ADMIN, body: { name: 'Jaya Joined', designation: 'Director', email: 'jaya.joined@example.com', mobile: '9825012366' } })).json?.member;
  r = await call('meeting-reopen', { token: ADMIN, body: { id: mtg } });
  ck('a closed meeting reopens', r.status === 200 && r.json?.meeting?.status === 'open', JSON.stringify(r.json));
  const reopened = (await call('meeting', { method: 'GET', token: ADMIN, query: { id: mtg } })).json?.rows?.map((x) => x.memberId) || [];
  ck('someone absent and since deactivated stays on the reopened register', before.includes(ivan.id) && reopened.includes(ivan.id), JSON.stringify(reopened));
  ck('someone added after the meeting is not added to it', !reopened.includes(jaya.id));
  const { token: jayaToken } = await signIn(jaya.email);
  r = await call('attend', { token: jayaToken, body: { pin: await openPin() } });
  ck('…and cannot scan into it while it is reopened', r.status === 403 && r.json?.code === 'not_on_roster', JSON.stringify(r.json));
  ck('…so no mark is written for them', !(await kv.get(KEYS.boardAttendance(mtg, jaya.id))));
  r = await call('mark', { token: ADMIN, body: { meetingId: mtg, memberId: ivan.id, status: 'leave', reason: 'Correcting the record' } });
  ck('the secretary can still correct that member on the reopened meeting', r.status === 200 && r.json?.record?.status === 'leave', JSON.stringify(r.json));
  await call('meeting-close', { token: ADMIN, body: { id: mtg } });
  const closedAgain = (await call('meeting', { method: 'GET', token: ADMIN, query: { id: mtg } })).json?.rows?.map((x) => x.memberId) || [];
  ck('closing again keeps the same roster', closedAgain.join() === before.join(), `${closedAgain} vs ${before}`);
}

// ════════════════════════════════════════════════════════════════════
sec('The meeting PIN: the permanent QR alone marks no one');
{
  const PHONE = 'phone-pin-' + crypto.randomUUID();
  const kira = (await call('member-save', { token: ADMIN, body: { name: 'Kira Pin', designation: 'Director', email: 'kira.pin@example.com', mobile: '9825012367' } })).json?.member;
  const { token: kiraToken } = await signIn(kira.email);
  const mtg = (await call('meeting-save', { token: ADMIN, body: { title: 'PIN meeting', date: '2026-09-16', time: '11:00' } })).json?.meeting?.id;
  r = await call('meeting-open', { token: ADMIN, body: { id: mtg } });
  const pin = r.json?.meeting?.pin;
  ck('opening attendance makes a 4-digit PIN for the secretary', /^\d{4}$/.test(pin || ''), JSON.stringify(r.json?.meeting));
  const wrong = pin === '0000' ? '1111' : '0000';

  live = await call('live', { method: 'GET', token: ADMIN, query: { id: mtg } });
  ck('the projector gets the PIN to show', live.json?.meeting?.pin === pin && live.json?.pinLocked === false, JSON.stringify(live.json));
  r = await call('meetings', { method: 'GET', token: ADMIN });
  ck('the meetings list shows the PIN of the open meeting only', r.json?.meetings?.find((m) => m.id === mtg)?.pin === pin
    && r.json.meetings.filter((m) => m.id !== mtg).every((m) => m.pin === null), JSON.stringify(r.json?.meetings?.map((m) => [m.id, m.pin])));

  r = await call('names', { ip: '198.51.100.1', body: { deviceId: PHONE } });
  ck('names without a PIN → 400 pin_required, no pass', r.status === 400 && r.json?.code === 'pin_required' && r.json?.pass === undefined, JSON.stringify(r.json));
  r = await call('names', { ip: '198.51.100.1', body: { deviceId: PHONE, pin: wrong } });
  ck('names with a wrong PIN → 403 pin_wrong, no pass', r.status === 403 && r.json?.code === 'pin_wrong' && r.json?.pass === undefined, JSON.stringify(r.json));
  r = await call('names', { ip: '198.51.100.1', body: { deviceId: PHONE, pin } });
  ck('names with the right PIN gives the list and a pass', r.status === 200 && typeof r.json?.pass === 'string', JSON.stringify(r.json));
  ck('…and never the PIN itself', !JSON.stringify(r.json).includes(`"pin"`));

  r = await call('attend', { token: kiraToken, ip: '198.51.100.2', body: {} });
  ck('a signed-in scan without the PIN is refused', r.status === 400 && r.json?.code === 'pin_required', JSON.stringify(r.json));
  r = await call('attend', { token: kiraToken, ip: '198.51.100.2', body: { pin: wrong } });
  ck('a signed-in scan with a wrong PIN is refused', r.status === 403 && r.json?.code === 'pin_wrong');
  ck('…and writes no mark', !(await kv.get(KEYS.boardAttendance(mtg, kira.id))));
  r = await call('me', { method: 'GET', token: kiraToken });
  ck("a member's own history never carries the PIN", r.status === 200 && !JSON.stringify(r.json).includes(`"pin"`), JSON.stringify(r.json?.items?.[0]));
  r = await call('attend', { token: kiraToken, ip: '198.51.100.2', body: { pin } });
  ck('a signed-in scan with the PIN marks the member present', r.status === 200 && r.json?.alreadyMarked === false, JSON.stringify(r.json));

  // One network address: ten wrong PINs, then it waits. Right PINs never count.
  const IP = '198.51.100.3';
  for (let i = 0; i < 9; i++) await call('names', { ip: IP, body: { deviceId: PHONE, pin: wrong } });
  r = await call('names', { ip: IP, body: { deviceId: PHONE, pin } });
  ck('right PINs from a busy network are not held back by its wrong ones', r.status === 200, JSON.stringify(r.json));
  r = await call('names', { ip: IP, body: { deviceId: PHONE, pin: wrong } });
  ck('the tenth wrong PIN from one address is still checked', r.status === 403);
  r = await call('names', { ip: IP, body: { deviceId: PHONE, pin: wrong } });
  ck('the eleventh is rate-limited (429)', r.status === 429, JSON.stringify(r.json));
  r = await call('names', { ip: IP, body: { deviceId: PHONE } });
  ck('…while a missing PIN still gets the plain "enter the PIN" answer', r.status === 400 && r.json?.code === 'pin_required');

  // The meeting's own cap, across many addresses (a script rotating IPs).
  // 1 + 1 + 10 wrong so far; 18 more from fresh addresses reach 30.
  for (let i = 0; i < 18; i++) r = await call('names', { ip: `192.0.2.${i + 1}`, body: { deviceId: PHONE, pin: wrong } });
  ck('the 30th wrong PIN at a meeting locks its PIN', r.status === 423 && r.json?.code === 'pin_locked', JSON.stringify(r.json));
  r = await call('names', { ip: '192.0.2.200', body: { deviceId: PHONE, pin } });
  ck('…after which even the right PIN is refused', r.status === 423 && r.json?.code === 'pin_locked');
  r = await call('attend', { token: kiraToken, ip: '192.0.2.201', body: { pin } });
  ck('…for signed-in scans too', r.status === 423);
  live = await call('live', { method: 'GET', token: ADMIN, query: { id: mtg } });
  ck('the projector is told the PIN locked', live.json?.pinLocked === true, JSON.stringify(live.json));

  r = await call('meeting-pin', { body: { id: mtg } });
  ck('a new PIN needs the superadmin', r.status === 401);
  r = await call('meeting-pin', { token: ADMIN, body: { id: mtg } });
  const pin2 = r.json?.meeting?.pin;
  ck('the secretary makes a new PIN', r.status === 200 && /^\d{4}$/.test(pin2 || ''), JSON.stringify(r.json));
  live = await call('live', { method: 'GET', token: ADMIN, query: { id: mtg } });
  ck('…which unlocks attendance', live.json?.pinLocked === false && live.json?.meeting?.pin === pin2);
  r = await call('names', { ip: '192.0.2.202', body: { deviceId: PHONE, pin: pin2 } });
  ck('…and works', r.status === 200 && typeof r.json?.pass === 'string', JSON.stringify(r.json));
  if (pin2 !== pin) {
    r = await call('names', { ip: '192.0.2.203', body: { deviceId: PHONE, pin } });
    ck('the old PIN stops working', r.status === 403 && r.json?.code === 'pin_wrong');
  }

  r = await call('meeting-close', { token: ADMIN, body: { id: mtg } });
  ck('closing clears the PIN', r.status === 200 && r.json?.meeting?.pin === null && (await kv.get(KEYS.boardMeetingPin(mtg))) === null);
  ck('…and the meeting record never stored it', (await kv.get(KEYS.boardMeeting(mtg)))?.pin === undefined);
  r = await call('meeting-pin', { token: ADMIN, body: { id: mtg } });
  ck('a closed meeting has no PIN to change', r.status === 409 && r.json?.code === 'not_open');
  r = await call('meeting-reopen', { token: ADMIN, body: { id: mtg } });
  ck('reopening makes a fresh PIN', r.status === 200 && /^\d{4}$/.test(r.json?.meeting?.pin || ''), JSON.stringify(r.json?.meeting));
  await call('meeting-close', { token: ADMIN, body: { id: mtg } });

  // A meeting left open from before PINs existed has none: fail closed.
  const legacy = (await call('meeting-save', { token: ADMIN, body: { title: 'Legacy open meeting', date: '2026-09-18', time: '11:00' } })).json?.meeting?.id;
  const stored = await kv.get(KEYS.boardMeeting(legacy));
  await kv.set(KEYS.boardMeeting(legacy), { ...(typeof stored === 'string' ? JSON.parse(stored) : stored), status: 'open', openedAt: new Date().toISOString() });
  // …and from before the open-meeting pointer: it must be found by the one-time index.
  await kv.del(KEYS.boardOpenMeeting, KEYS.boardOpenMeetingIndexed);
  r = await call('names', { ip: '192.0.2.204', body: { deviceId: PHONE, pin: '1234' } });
  ck('a meeting opened before PINs existed refuses every mark (pin_locked)', r.status === 423 && r.json?.code === 'pin_locked', JSON.stringify(r.json));
  r = await call('meeting-pin', { token: ADMIN, body: { id: legacy } });
  const legacyPin = r.json?.meeting?.pin;
  r = await call('names', { ip: '192.0.2.205', body: { deviceId: PHONE, pin: legacyPin } });
  ck('…until the secretary makes it a PIN', r.status === 200, JSON.stringify(r.json));
  await call('meeting-close', { token: ADMIN, body: { id: legacy } });

  // "New PIN" and "Close attendance" pressed at the same moment: the close
  // must win, never be undone by the PIN change.
  const raced = (await call('meeting-save', { token: ADMIN, body: { title: 'Race meeting', date: '2026-09-20', time: '11:00' } })).json?.meeting?.id;
  await call('meeting-open', { token: ADMIN, body: { id: raced } });
  const [closeRes, pinRes] = await Promise.all([
    call('meeting-close', { token: ADMIN, body: { id: raced } }),
    call('meeting-pin', { token: ADMIN, body: { id: raced } }),
  ]);
  const after = await kv.get(KEYS.boardMeeting(raced));
  ck('a New PIN racing a close never reopens the meeting', closeRes.status === 200 && (typeof after === 'string' ? JSON.parse(after) : after)?.status === 'closed',
    `${closeRes.status} ${pinRes.status} ${JSON.stringify(after)}`);
  r = await call('names', { ip: '192.0.2.206', body: { deviceId: PHONE, pin: pinRes.json?.meeting?.pin || '1234' } });
  ck('…and any PIN it made marks no one at the closed meeting', r.status === 409 && r.json?.code === 'not_open', JSON.stringify(r.json));
}

// ════════════════════════════════════════════════════════════════════
sec('One open meeting, even when two are opened at once');
{
  const a = (await call('meeting-save', { token: ADMIN, body: { title: 'Race A', date: '2026-09-22', time: '10:00' } })).json?.meeting?.id;
  const b = (await call('meeting-save', { token: ADMIN, body: { title: 'Race B', date: '2026-09-22', time: '11:00' } })).json?.meeting?.id;
  const [ra, rb] = await Promise.all([
    call('meeting-open', { token: ADMIN, body: { id: a } }),
    call('meeting-open', { token: ADMIN, body: { id: b } }),
  ]);
  const opened = [ra, rb].filter((x) => x.status === 200);
  ck('two meetings opened in the same instant: exactly one opens', opened.length === 1
    && [ra, rb].some((x) => x.status === 409 && ['another_open', 'busy'].includes(x.json?.code)), `${ra.status}/${ra.json?.code} ${rb.status}/${rb.json?.code}`);
  const winner = opened[0]?.json?.meeting?.id;
  const loser = winner === a ? b : a;
  const loserRec = await kv.get(KEYS.boardMeeting(loser));
  ck('…the other stays scheduled', (typeof loserRec === 'string' ? JSON.parse(loserRec) : loserRec)?.status === 'scheduled');
  ck('…and the pointer names the one that opened', String(await kv.get(KEYS.boardOpenMeeting)) === winner);
  r = await call('names', { ip: '192.0.2.210', body: { deviceId: 'phone-race-' + crypto.randomUUID(), pin: await openPin() } });
  ck('…which is the meeting the QR resolves to', r.status === 200 && r.json?.meeting?.id === winner, JSON.stringify(r.json?.meeting));

  // An edit of the scheduled meeting racing the close of the open one keeps both.
  const [edit, close] = await Promise.all([
    call('meeting-save', { token: ADMIN, body: { id: loser, title: 'Race renamed', date: '2026-09-22', time: '12:00' } }),
    call('meeting-close', { token: ADMIN, body: { id: winner } }),
  ]);
  const winRec = await kv.get(KEYS.boardMeeting(winner));
  ck('an edit and a close at the same moment both apply', edit.status === 200 && close.status === 200
    && (typeof winRec === 'string' ? JSON.parse(winRec) : winRec)?.status === 'closed', `${edit.status} ${close.status}`);
  ck('closing clears the pointer', (await kv.get(KEYS.boardOpenMeeting)) === null);
  r = await call('names', { ip: '192.0.2.211', body: { deviceId: 'phone-race-' + crypto.randomUUID(), pin: '1234' } });
  ck('…so the QR marks no one', r.status === 409 && r.json?.code === 'not_open');

  // Deleting an open meeting (nobody marked yet) frees the QR.
  await call('meeting-open', { token: ADMIN, body: { id: loser } });
  r = await call('meeting-delete', { token: ADMIN, body: { id: loser } });
  ck('an open meeting with no marks can be deleted', r.status === 200, JSON.stringify(r.json));
  ck('…and the pointer and its PIN go with it', (await kv.get(KEYS.boardOpenMeeting)) === null && (await kv.get(KEYS.boardMeetingPin(loser))) === null);
  r = await call('meeting-open', { token: ADMIN, body: { id: winner } });
  ck('a closed meeting still cannot be opened (only reopened)', r.status === 409 && r.json?.code === 'closed');

  // A stale pointer (meeting closed outside this code path) does not block opening.
  const c = (await call('meeting-save', { token: ADMIN, body: { title: 'Race C', date: '2026-09-23', time: '10:00' } })).json?.meeting?.id;
  await kv.set(KEYS.boardOpenMeeting, winner);
  r = await call('meeting-open', { token: ADMIN, body: { id: c } });
  ck('a pointer left at a closed meeting is replaced, not obeyed', r.status === 200 && String(await kv.get(KEYS.boardOpenMeeting)) === c, JSON.stringify(r.json));
  await call('meeting-close', { token: ADMIN, body: { id: c } });
}

sec('Published roster reconciliation (admin only)');
{
  r = await call('members', { method: 'GET', token: ADMIN });
  ck('admin sees the 15 published names without inventing portal accounts', r.status === 200 && r.json?.websiteRoster?.length === 15);
  ck('Mahesh is flagged when no portal profile exists', r.json.websiteRoster.some((w) => w.name === 'DR. MAHESH R. VASHI' && w.portalId === null));
  ck('Jigar stays unpublished', !r.json.websiteRoster.some((w) => /jigar/i.test(w.name)));
  const { member } = await lib.saveMember({ name: 'Mahesh R Vashi', designation: 'CSR & Skill Development', email: 'mahesh-test@example.com', mobile: '9825012345', company: '' });
  r = await call('members', { method: 'GET', token: ADMIN });
  let match = r.json.websiteRoster.find((w) => w.name === 'DR. MAHESH R. VASHI');
  ck('titles, dots, case and spacing do not cause a false missing-profile warning', match?.portalId === member.id && match?.portalStatus === 'active');
  ck('reconciliation contains no email or mobile', !('email' in match) && !('mobile' in match));
  await lib.setMemberStatus(member.id, 'inactive');
  r = await call('members', { method: 'GET', token: ADMIN });
  match = r.json.websiteRoster.find((w) => w.name === 'DR. MAHESH R. VASHI');
  ck('inactive portal profiles are distinguished from missing profiles', match?.portalId === member.id && match?.portalStatus === 'inactive');
  const urjit = await lib.saveMember({ name: 'Urjit Patel', designation: 'Event Management & Exhibitions', email: 'urjit-test@example.com', mobile: '9825012345', company: '' });
  r = await call('members', { method: 'GET', token: ADMIN });
  ck('Urjit’s expanded public name still matches his existing short portal name',
    r.json.websiteRoster.some((w) => w.name === 'MR. URJIT BHUPENDRABHAI PATEL' && w.portalId === urjit.member.id));
  r = await call('members', { method: 'GET' });
  ck('reconciliation remains admin-only', r.status === 401 && !r.json?.websiteRoster);
}

console.log(`${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
smtp.server.close();
redis.server.close();
process.exit(fail ? 1 : 0);
