// tests/employee-auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockRedis } from './mock-redis.mjs';

const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const { saveEmployee, updateEmployeeStatus } = await import('../api/_lib/expenses.js');
const employeeAuthHandler = (await import('../api/employee-auth.js')).default;
const employeesHandler = (await import('../api/employees.js')).default;
const { getEmployeeSession, requireEmployee } = await import('../api/_lib/http.js');
const { redis, KEYS } = await import('../api/_lib/redis.js');

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
  return res;
}

test.after(() => {
  mock.server.close();
});

test('Employee login succeeds with correct credentials', async () => {
  await saveEmployee({
    name: 'Bhavik Patel',
    employeeId: 'BCCI-E801',
    username: 'bhavik.p',
    password: 'Password801!',
    status: 'active',
  });

  const req = {
    method: 'POST',
    headers: { host: 'localhost' },
    body: { action: 'login', username: 'bhavik.p', password: 'Password801!' },
  };
  const res = createMockRes();

  await employeeAuthHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.session.token);
  assert.equal(res.body.session.employeeId, 'BCCI-E801');

  // Verify session check (GET) and requireEmployee helper work with this token
  const token = res.body.session.token;
  const getReq = {
    method: 'GET',
    headers: { host: 'localhost', authorization: `Bearer ${token}` },
  };
  const getRes = createMockRes();
  await employeeAuthHandler(getReq, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.session.employeeId, 'BCCI-E801');

  const session = await getEmployeeSession(getReq);
  assert.ok(session);
  assert.equal(session.employeeId, 'BCCI-E801');

  const requiredSession = await requireEmployee(getReq, createMockRes());
  assert.equal(requiredSession.employeeId, 'BCCI-E801');

  // Verify logout (DELETE)
  const delReq = {
    method: 'DELETE',
    headers: { host: 'localhost', authorization: `Bearer ${token}` },
  };
  const delRes = createMockRes();
  await employeeAuthHandler(delReq, delRes);
  assert.equal(delRes.statusCode, 200);
  assert.equal(delRes.body.success, true);

  // After logout, session check should fail
  const postLogoutRes = createMockRes();
  await employeeAuthHandler(getReq, postLogoutRes);
  assert.equal(postLogoutRes.statusCode, 401);
});

test('Employee login fails with incorrect credentials', async () => {
  const req = {
    method: 'POST',
    headers: { host: 'localhost' },
    body: { action: 'login', username: 'bhavik.p', password: 'WrongPassword!' },
  };
  const res = createMockRes();

  await employeeAuthHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
});

test('Deactivated employee is blocked from logging in', async () => {
  await saveEmployee({
    name: 'Deactivated User',
    employeeId: 'BCCI-E802',
    username: 'deactivated.u',
    password: 'Password802!',
    status: 'inactive',
  });

  const req = {
    method: 'POST',
    headers: { host: 'localhost' },
    body: { action: 'login', username: 'deactivated.u', password: 'Password802!' },
  };
  const res = createMockRes();

  await employeeAuthHandler(req, res);
  assert.equal(res.statusCode, 403);
  assert.ok(res.body.error.includes('deactivated'));
});

test('Active session is rejected and revoked when employee is deactivated', async () => {
  await saveEmployee({
    name: 'To Be Deactivated',
    employeeId: 'BCCI-E803',
    username: 'tobedeact.u',
    password: 'Password803!',
    status: 'active',
  });

  // Login while active
  const loginReq = {
    method: 'POST',
    headers: { host: 'localhost' },
    body: { username: 'tobedeact.u', password: 'Password803!' },
  };
  const loginRes = createMockRes();
  await employeeAuthHandler(loginReq, loginRes);
  assert.equal(loginRes.statusCode, 200);
  const token = loginRes.body.session.token;
  assert.ok(token);

  // Verify session works
  const checkReq = {
    method: 'GET',
    headers: { host: 'localhost', authorization: `Bearer ${token}` },
  };
  const checkRes1 = createMockRes();
  await employeeAuthHandler(checkReq, checkRes1);
  assert.equal(checkRes1.statusCode, 200);

  // Admin deactivates employee via PATCH /api/employees
  await redis.set(KEYS.adminSession('admin-tok-deact'), 'admin@bcci.in', { ex: 3600 });
  const patchReq = {
    method: 'PATCH',
    headers: { host: 'localhost', authorization: 'Bearer admin-tok-deact' },
    body: { employeeId: 'BCCI-E803', status: 'inactive' },
  };
  const patchRes = createMockRes();
  await employeesHandler(patchReq, patchRes);
  assert.equal(patchRes.statusCode, 200);

  // Subsequent session check must return 401
  const checkRes2 = createMockRes();
  await employeeAuthHandler(checkReq, checkRes2);
  assert.equal(checkRes2.statusCode, 401);

  // getEmployeeSession must return null
  const sess = await getEmployeeSession(checkReq);
  assert.equal(sess, null);
});
