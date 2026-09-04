// tests/applicant-auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockRedis } from './mock-redis.mjs';

const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const { hashPassword, verifyPassword, getAccount, saveAccount } = await import('../api/_lib/accounts.js');
const { KEYS } = await import('../api/_lib/redis.js');

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
