// tests/employees-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockRedis } from './mock-redis.mjs';

const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const { redis } = await import('../api/_lib/redis.js');
const employeesHandler = (await import('../api/employees.js')).default;

test.after(() => {
  mock.server.close();
});

// Setup admin session token
const ADMIN_TOKEN = 'admin-test-token-employees';
await redis.set(`admin:${ADMIN_TOKEN}`, 'admin@bccibharuch.in');

function mockReq(method, { body, query, auth = true } = {}) {
  return {
    method,
    headers: {
      host: 'localhost',
      ...(auth ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
    },
    body: body || {},
    query: query || {},
  };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

test('POST /api/employees rejects unauthenticated request', async () => {
  const req = mockReq('POST', { auth: false });
  const res = mockRes();
  await employeesHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('POST /api/employees creates employee and rejects duplicates', async () => {
  const req = mockReq('POST', {
    body: {
      name: 'Kiran Desai',
      employeeId: 'BCCI-E701',
      username: 'kiran.d',
      password: 'Password701!',
      email: 'kiran@example.com',
    },
  });
  const res = mockRes();
  await employeesHandler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.employee.employeeId, 'BCCI-E701');

  // Duplicate employeeId
  const dupCodeReq = mockReq('POST', {
    body: {
      name: 'Duplicate Code',
      employeeId: 'BCCI-E701',
      username: 'another.u',
      password: 'Password701!',
    },
  });
  const dupCodeRes = mockRes();
  await employeesHandler(dupCodeReq, dupCodeRes);
  assert.equal(dupCodeRes.statusCode, 409);

  // Duplicate username
  const dupUserReq = mockReq('POST', {
    body: {
      name: 'Duplicate Username',
      employeeId: 'BCCI-E702',
      username: 'kiran.d',
      password: 'Password701!',
    },
  });
  const dupUserRes = mockRes();
  await employeesHandler(dupUserReq, dupUserRes);
  assert.equal(dupUserRes.statusCode, 409);
});

test('PATCH /api/employees toggles status without deleting history', async () => {
  const req = mockReq('PATCH', {
    body: {
      employeeId: 'BCCI-E701',
      status: 'inactive',
    },
  });
  const res = mockRes();
  await employeesHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.employee.status, 'inactive');

  // GET single employee with history/stats
  const getReq = mockReq('GET', { query: { id: 'BCCI-E701' } });
  const getRes = mockRes();
  await employeesHandler(getReq, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.employee.employeeId, 'BCCI-E701');
  assert.equal(getRes.body.employee.status, 'inactive');
  assert.ok(Array.isArray(getRes.body.employee.history));
  assert.ok(getRes.body.employee.stats);

  // GET all employees listing
  const listReq = mockReq('GET');
  const listRes = mockRes();
  await employeesHandler(listReq, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.ok(Array.isArray(listRes.body.employees));
  const found = listRes.body.employees.find((e) => e.employeeId === 'BCCI-E701');
  assert.ok(found);
  assert.equal(found.status, 'inactive');
});

test('SEC-10: Concurrent employee creation with identical ID/username handles race condition atomically', async () => {
  const req1 = mockReq('POST', {
    body: {
      name: 'Racer One',
      employeeId: 'BCCI-RACE-01',
      username: 'racer.unique',
      password: 'Password999!',
    },
  });
  const res1 = mockRes();

  const req2 = mockReq('POST', {
    body: {
      name: 'Racer Two',
      employeeId: 'BCCI-RACE-01',
      username: 'racer.unique',
      password: 'Password999!',
    },
  });
  const res2 = mockRes();

  await Promise.all([
    employeesHandler(req1, res1),
    employeesHandler(req2, res2),
  ]);

  const statuses = [res1.statusCode, res2.statusCode].sort();
  assert.deepEqual(statuses, [201, 409], 'Exactly one employee creation must succeed, the second must be rejected with 409');
});
