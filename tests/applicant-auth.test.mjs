// tests/applicant-auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockRedis } from './mock-redis.mjs';

const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

process.env.ALLOWED_ORIGIN = 'https://bccibharuch.in';
process.env.SMTP_TRANSPORT = 'json';

const { hashPassword, verifyPassword, getAccount, saveAccount } = await import('../api/_lib/accounts.js');
const { redis, KEYS } = await import('../api/_lib/redis.js');
const applicantAuth = (await import('../api/applicant-auth.js')).default;

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.done = true; return this; },
    end(o) { this.body = o ?? this.body; this.done = true; return this; },
    get headersSent() { return false; },
  };
  return res;
}

async function call(handler, { method = 'POST', body, query = {}, token, origin, ip = '203.0.113.10' } = {}) {
  const req = {
    method,
    body,
    query,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
      'x-forwarded-for': ip,
    },
    socket: { remoteAddress: ip },
  };
  const res = mockRes();
  await handler(req, res);
  return res;
}

test.after(() => {
  mock.server.close();
});

test('hashPassword produces distinct salts and hashes', () => {
  const h1 = hashPassword('SuperSecret123');
  const h2 = hashPassword('SuperSecret123');
  assert.notEqual(h1.salt, h2.salt);
  assert.notEqual(h1.hash, h2.hash);
  assert.equal(verifyPassword('SuperSecret123', h1.hash, h1.salt), true);
  assert.equal(verifyPassword('WrongPassword', h1.hash, h1.salt), false);
});

test('hashPassword supports reusing salt', () => {
  const h1 = hashPassword('SuperSecret123');
  const h2 = hashPassword('SuperSecret123', h1.salt);
  assert.equal(h1.salt, h2.salt);
  assert.equal(h1.hash, h2.hash);
});

test('verifyPassword handles invalid or missing inputs defensively', () => {
  assert.equal(verifyPassword('', 'hash', 'salt'), false);
  assert.equal(verifyPassword('pass', '', 'salt'), false);
  assert.equal(verifyPassword('pass', 'hash', ''), false);
  assert.equal(verifyPassword(null, 'hash', 'salt'), false);
  assert.equal(verifyPassword('pass', null, 'salt'), false);
  assert.equal(verifyPassword('pass', 'hash', null), false);
  assert.equal(verifyPassword('pass', 'short', 'salt'), false);
  assert.equal(verifyPassword(123, 'hash', 'salt'), false);
});

test('KEYS.account and KEYS.otpReset format email keys correctly', () => {
  assert.equal(KEYS.account('  Test@Example.COM '), 'bcci:account:test@example.com');
  assert.equal(KEYS.otpReset(' Test@Example.COM '), 'bcci:otp:reset:test@example.com');
});

test('saveAccount and getAccount persist and retrieve accounts', async () => {
  const saved = await saveAccount('User@Example.com ', 'SuperSecret123');
  assert.equal(saved.email, 'user@example.com');
  assert.ok(saved.passwordHash);
  assert.ok(saved.salt);
  assert.ok(saved.createdAt);
  assert.ok(saved.updatedAt);

  const retrieved = await getAccount('user@example.com');
  assert.ok(retrieved);
  assert.equal(retrieved.email, 'user@example.com');
  assert.equal(retrieved.passwordHash, saved.passwordHash);
  assert.equal(retrieved.salt, saved.salt);
  assert.equal(retrieved.createdAt, saved.createdAt);
  assert.equal(retrieved.updatedAt, saved.updatedAt);
  assert.equal(verifyPassword('SuperSecret123', retrieved.passwordHash, retrieved.salt), true);
});

test('saveAccount updates existing account preserving createdAt', async () => {
  const first = await saveAccount('preserve@example.com', 'InitialPassword1');
  assert.ok(first.createdAt);

  // Wait 1ms so timestamp differs
  await new Promise((r) => setTimeout(r, 5));
  const updated = await saveAccount('preserve@example.com', 'UpdatedPassword2');
  assert.equal(updated.email, 'preserve@example.com');
  assert.equal(updated.createdAt, first.createdAt);
  assert.notEqual(updated.passwordHash, first.passwordHash);
  assert.equal(verifyPassword('UpdatedPassword2', updated.passwordHash, updated.salt), true);
  assert.equal(verifyPassword('InitialPassword1', updated.passwordHash, updated.salt), false);
});

test('getAccount returns null for non-existent or empty email', async () => {
  assert.equal(await getAccount('missing@example.com'), null);
  assert.equal(await getAccount(''), null);
  assert.equal(await getAccount(null), null);
  assert.equal(await getAccount(undefined), null);
});

test('applicant-auth rejects non-POST methods with 405', async () => {
  const res = await call(applicantAuth, { method: 'GET' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.success, false);
});

test('applicant-auth responds to OPTIONS preflight with 204', async () => {
  const res = await call(applicantAuth, { method: 'OPTIONS' });
  assert.equal(res.statusCode, 204);
});

test('applicant-auth rejects unknown action with 400', async () => {
  const res = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'unknown-action', email: 'test@example.com' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('action "login": returns 400 with PASSWORD_NOT_SET when account has no password set', async () => {
  const res = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'login', email: 'nopassword@example.com', password: 'AnyPassword123' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'PASSWORD_NOT_SET');
  assert.match(res.body.error, /No password set/i);
});

test('action "login": returns 401 on wrong credentials', async () => {
  await saveAccount('existing@example.com', 'CorrectPassword123');

  const res = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'login', email: 'existing@example.com', password: 'WrongPassword456' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /Invalid email or password/i);
});

test('action "register": rejects short passwords (< 8 chars) or missing OTP', async () => {
  const resShort = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'register', email: 'regtest@example.com', code: '123456', password: 'short' },
  });
  assert.equal(resShort.statusCode, 400);
  assert.equal(resShort.body.success, false);
  assert.match(resShort.error || resShort.body.error, /8 characters/i);

  const resNoCode = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'register', email: 'regtest@example.com', password: 'ValidPassword123' },
  });
  assert.equal(resNoCode.statusCode, 400);
  assert.equal(resNoCode.body.success, false);
});

test('action "register": creates account and returns 201 + session on valid OTP', async () => {
  const email = 'newapplicant@example.com';
  // Seed registration OTP in redis
  await redis.set(`bcci:otp:${email}`, '654321', { ex: 600 });

  const res = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'register', email, code: '654321', password: 'SecurePassword123!' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.ok(res.body.session);
  assert.ok(res.body.session.token);
  assert.equal(res.body.session.email, email);
  assert.equal(res.body.session.expiresIn, 86400);

  // OTP key should be cleared after successful registration
  const storedOtp = await redis.get(`bcci:otp:${email}`);
  assert.equal(storedOtp, null);

  // Account should exist in Redis
  const account = await getAccount(email);
  assert.ok(account);
  assert.equal(account.email, email);
  assert.equal(verifyPassword('SecurePassword123!', account.passwordHash, account.salt), true);

  // Session token should exist in Redis
  const sessionUser = await redis.get(KEYS.applicantSession(res.body.session.token));
  assert.equal(sessionUser, email);
});

test('action "login": returns 200 + session with newly registered credentials', async () => {
  const email = 'newapplicant@example.com';
  const res = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'login', email, password: 'SecurePassword123!' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.session);
  assert.ok(res.body.session.token);
  assert.equal(res.body.session.email, email);
  assert.equal(res.body.session.expiresIn, 86400);

  const sessionUser = await redis.get(KEYS.applicantSession(res.body.session.token));
  assert.equal(sessionUser, email);
});

test('action "forgot-password-request": dispatches OTP code and stores in redis', async () => {
  const email = 'forgotpass@example.com';
  await saveAccount(email, 'OldPassword123');

  const res = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'forgot-password-request', email },
    ip: '203.0.113.88',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.match(res.body.message, /sent/i);

  const storedOtp = await redis.get(KEYS.otpReset(email));
  assert.ok(storedOtp);
  assert.match(String(storedOtp), /^\d{6}$/);
});

test('action "reset-password": verifies reset OTP, updates password, and returns session', async () => {
  const email = 'forgotpass@example.com';
  const resetOtp = await redis.get(KEYS.otpReset(email));
  assert.ok(resetOtp);

  // Attempt with wrong OTP first
  const badRes = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'reset-password', email, code: '000000', newPassword: 'BrandNewPassword123!' },
  });
  assert.equal(badRes.statusCode, 400);
  assert.equal(badRes.body.success, false);

  // Attempt with valid OTP
  const res = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'reset-password', email, code: String(resetOtp), newPassword: 'BrandNewPassword123!' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.session);
  assert.equal(res.body.session.email, email);

  // Reset OTP should be cleaned up
  assert.equal(await redis.get(KEYS.otpReset(email)), null);

  // Logging in with new password succeeds
  const loginNew = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'login', email, password: 'BrandNewPassword123!' },
  });
  assert.equal(loginNew.statusCode, 200);
  assert.equal(loginNew.body.success, true);

  // Logging in with old password fails
  const loginOld = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'login', email, password: 'OldPassword123' },
  });
  assert.equal(loginOld.statusCode, 401);
});

test('action "login": enforces rate limiting after 10 attempts', async () => {
  const email = 'ratelimit@example.com';
  const ip = '198.51.100.42';

  for (let i = 0; i < 10; i++) {
    const res = await call(applicantAuth, {
      method: 'POST',
      body: { action: 'login', email, password: 'BadPassword1' },
      ip,
    });
    assert.equal(res.statusCode, 400); // PASSWORD_NOT_SET
  }

  const blockedRes = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'login', email, password: 'BadPassword1' },
    ip,
  });
  assert.equal(blockedRes.statusCode, 429);
  assert.equal(blockedRes.body.success, false);
  assert.match(blockedRes.body.error, /too many/i);
});

test('action "forgot-password-request": enforces 1 request per minute per email rate limit', async () => {
  const email = 'ratelimit-fp@example.com';
  const ip = '198.51.100.99';

  const res1 = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'forgot-password-request', email },
    ip,
  });
  assert.equal(res1.statusCode, 200);

  const res2 = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'forgot-password-request', email },
    ip,
  });
  assert.equal(res2.statusCode, 429);
  assert.equal(res2.body.success, false);
});

test('action "login": returns PASSWORD_NOT_SET for legacy account without passwordHash', async () => {
  const email = 'legacy@example.com';
  // Manually store account object without passwordHash
  await redis.set(KEYS.account(email), { email, createdAt: new Date().toISOString() });

  const res = await call(applicantAuth, {
    method: 'POST',
    body: { action: 'login', email, password: 'SomePassword123' },
    ip: '198.51.100.123',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'PASSWORD_NOT_SET');
});


