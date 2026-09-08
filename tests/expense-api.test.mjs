// tests/expense-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockRedis } from './mock-redis.mjs';

const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const { redis } = await import('../api/_lib/redis.js');
const expensesHandler = (await import('../api/expenses.js')).default;
const adminStatsHandler = (await import('../api/admin-stats.js')).default;
const { saveEmployee } = await import('../api/_lib/expenses.js');

test.after(() => {
  mock.server.close();
});

// Setup test employee sessions
const EMP_A_TOKEN = 'token-emp-a';
await redis.set(`bcci:employee_session:${EMP_A_TOKEN}`, JSON.stringify({
  employeeId: 'BCCI-E601',
  name: 'Emp A',
  username: 'emp.a',
}));

const EMP_B_TOKEN = 'token-emp-b';
await redis.set(`bcci:employee_session:${EMP_B_TOKEN}`, JSON.stringify({
  employeeId: 'BCCI-E602',
  name: 'Emp B',
  username: 'emp.b',
}));

const ADMIN_TOKEN = 'admin-test-token-expenses';
await redis.set(`admin:${ADMIN_TOKEN}`, 'admin@bccibharuch.in');

function mockReq(method, { token, body, query } = {}) {
  return {
    method,
    headers: {
      host: 'localhost',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

test('Employee can submit expense claim with document', async () => {
  const req = mockReq('POST', {
    token: EMP_A_TOKEN,
    body: {
      claimedAmount: 1450,
      expenseDate: '2026-09-04',
      category: 'Lodging',
      description: 'Hotel stay during regional commerce conference',
      docData: 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDM',
      docName: 'hotel_invoice.pdf',
    },
  });
  const res = mockRes();
  await expensesHandler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.expense.status, 'Pending Approval');
  assert.equal(res.body.expense.claimedAmount, 1450);
});

test('POST /api/expenses validates inputs and rejects unauthorized submission', async () => {
  // Unauthenticated
  const unauthReq = mockReq('POST', {
    body: { claimedAmount: 500, expenseDate: '2026-09-04', category: 'Food', description: 'Lunch' },
  });
  const unauthRes = mockRes();
  await expensesHandler(unauthReq, unauthRes);
  assert.equal(unauthRes.statusCode, 401);

  // Invalid claimedAmount (<= 0)
  const badReq = mockReq('POST', {
    token: EMP_A_TOKEN,
    body: { claimedAmount: -50, expenseDate: '2026-09-04', category: 'Food', description: 'Lunch' },
  });
  const badRes = mockRes();
  await expensesHandler(badReq, badRes);
  assert.equal(badRes.statusCode, 400);
});

test('Employee isolation: Emp B cannot see Emp A claims', async () => {
  const req = mockReq('GET', { token: EMP_B_TOKEN });
  const res = mockRes();
  await expensesHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.expenses.every(e => e.employeeId === 'BCCI-E602'));
});

test('Admin can review, partially approve, and inspect document', async () => {
  // First submit an expense as Emp A
  const submitReq = mockReq('POST', {
    token: EMP_A_TOKEN,
    body: {
      claimedAmount: 2000,
      expenseDate: '2026-09-05',
      category: 'Travel',
      description: 'Cab charges',
      docData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    },
  });
  const submitRes = mockRes();
  await expensesHandler(submitReq, submitRes);
  const expenseId = submitRes.body.expense.id;

  // Admin inspects document
  const docReq = mockReq('GET', { token: ADMIN_TOKEN, query: { id: expenseId, document: '1' } });
  const docRes = mockRes();
  await expensesHandler(docReq, docRes);
  assert.equal(docRes.statusCode, 200);
  assert.ok(docRes.body.document.docData.startsWith('data:image/png'));

  // Another employee (Emp B) cannot view Emp A's document (403)
  const forbiddenDocReq = mockReq('GET', { token: EMP_B_TOKEN, query: { id: expenseId, document: '1' } });
  const forbiddenDocRes = mockRes();
  await expensesHandler(forbiddenDocReq, forbiddenDocRes);
  assert.equal(forbiddenDocRes.statusCode, 403);

  // Owner employee (Emp A) CAN view their own document (200)
  const ownerDocReq = mockReq('GET', { token: EMP_A_TOKEN, query: { id: expenseId, document: '1' } });
  const ownerDocRes = mockRes();
  await expensesHandler(ownerDocReq, ownerDocRes);
  assert.equal(ownerDocRes.statusCode, 200);

  // Admin partially approves
  const reviewReq = mockReq('PATCH', {
    token: ADMIN_TOKEN,
    body: {
      id: expenseId,
      decision: 'partially_approve',
      approvedAmount: 1600,
      remark: 'Exceeded standard daily cab ceiling',
    },
  });
  const reviewRes = mockRes();
  await expensesHandler(reviewReq, reviewRes);
  assert.equal(reviewRes.statusCode, 200);
  assert.equal(reviewRes.body.expense.status, 'Partially Approved');
  assert.equal(reviewRes.body.expense.approvedAmount, 1600);
  assert.equal(reviewRes.body.expense.adminRemark, 'Exceeded standard daily cab ceiling');
  assert.equal(reviewRes.body.expense.reviewedBy, 'admin@bccibharuch.in');
});

test('PATCH /api/expenses rejects non-admin, non-existent, and invalid amount claims', async () => {
  // Non-admin attempt
  const nonAdminReq = mockReq('PATCH', {
    token: EMP_A_TOKEN,
    body: { id: 'EXP-123', decision: 'approve', approvedAmount: 500 },
  });
  const nonAdminRes = mockRes();
  await expensesHandler(nonAdminReq, nonAdminRes);
  assert.equal(nonAdminRes.statusCode, 401);

  // Submit claim for boundary checks
  const sReq = mockReq('POST', {
    token: EMP_A_TOKEN,
    body: {
      claimedAmount: 1000,
      expenseDate: '2026-09-06',
      category: 'Supplies',
      description: 'Office stationery supplies',
      docData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    },
  });
  const sRes = mockRes();
  await expensesHandler(sReq, sRes);
  assert.equal(sRes.statusCode, 201);
  const expId = sRes.body.expense.id;

  // approvedAmount > claimedAmount should fail (400)
  const excessReq = mockReq('PATCH', {
    token: ADMIN_TOKEN,
    body: { id: expId, decision: 'approve', approvedAmount: 1500, remark: 'Overpaying' },
  });
  const excessRes = mockRes();
  await expensesHandler(excessReq, excessRes);
  assert.equal(excessRes.statusCode, 400);

  // Rejection without remark should fail (400)
  const noRemarkReq = mockReq('PATCH', {
    token: ADMIN_TOKEN,
    body: { id: expId, decision: 'reject', remark: '' },
  });
  const noRemarkRes = mockRes();
  await expensesHandler(noRemarkReq, noRemarkRes);
  assert.equal(noRemarkRes.statusCode, 400);
});

test('Admin stats response includes expenses summary without breaking existing stats', async () => {
  const req = mockReq('GET', { token: ADMIN_TOKEN });
  const res = mockRes();
  await adminStatsHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.applications !== undefined);
  assert.ok(res.body.expenses !== undefined);
  assert.ok(res.body.expenses.totalExpenses >= 1);
});

test('SEC-09: Expense submission endpoint enforces rate limiting after burst', async () => {
  const ip = '198.51.100.222';
  let lastStatus = 200;
  for (let i = 0; i < 35; i++) {
    const req = {
      method: 'POST',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${EMP_A_TOKEN}`,
        'x-forwarded-for': ip,
      },
      body: {
        claimedAmount: 100,
        expenseDate: '2026-03-15',
        category: 'Travel',
        description: `Rate limit test ${i}`,
      },
    };
    const res = mockRes();
    await expensesHandler(req, res);
    lastStatus = res.statusCode;
    if (res.statusCode === 429) break;
  }
  assert.equal(lastStatus, 429, 'Excessive submissions must be rate-limited with 429');
});
