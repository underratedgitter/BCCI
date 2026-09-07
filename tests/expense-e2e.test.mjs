// tests/expense-e2e.test.mjs
// Comprehensive End-to-End Workflow Verification, Security Isolation & Regression Test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockRedis } from './mock-redis.mjs';

const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const { redis } = await import('../api/_lib/redis.js');
const employeesHandler = (await import('../api/employees.js')).default;
const expensesHandler = (await import('../api/expenses.js')).default;
const employeeAuthHandler = (await import('../api/employee-auth.js')).default;
const adminStatsHandler = (await import('../api/admin-stats.js')).default;

test.after(() => {
  mock.server.close();
});

const ADMIN_TOKEN = 'e2e-admin-token-expense-mgt';
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

const SAMPLE_PDF = 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDM';
let priyaToken = null;
let rahulToken = null;
let expenseId = null;

test('1. Full Lifecycle: Provisioning, Authentication, Claim Submission, Receipt Fetch & Partial Review', async () => {
  // 1.1 Admin creates Priya Sharma
  const createEmpReq = mockReq('POST', {
    token: ADMIN_TOKEN,
    body: {
      name: 'Priya Sharma',
      employeeId: 'BCCI-E999',
      username: 'priya.s',
      password: 'StrongPassword999!',
      email: 'priya@example.com',
      status: 'active',
    },
  });
  const createEmpRes = mockRes();
  await employeesHandler(createEmpReq, createEmpRes);
  assert.equal(createEmpRes.statusCode, 201, 'Admin must be able to create an employee');
  assert.equal(createEmpRes.body.employee.employeeId, 'BCCI-E999');
  assert.equal(createEmpRes.body.employee.username, 'priya.s');
  assert.equal(createEmpRes.body.employee.status, 'active');

  // 1.2 Priya logs in via POST /api/employee-auth
  const loginReq = mockReq('POST', {
    body: { action: 'login', username: 'priya.s', password: 'StrongPassword999!' },
  });
  const loginRes = mockRes();
  await employeeAuthHandler(loginReq, loginRes);
  assert.equal(loginRes.statusCode, 200, 'Employee login must succeed with correct credentials');
  assert.equal(loginRes.body.success, true);
  priyaToken = loginRes.body.session.token;
  assert.ok(priyaToken, 'Session token must be returned');
  assert.equal(loginRes.body.session.employeeId, 'BCCI-E999');

  // 1.3 Priya submits expense claim with receipt
  const submitReq = mockReq('POST', {
    token: priyaToken,
    body: {
      claimedAmount: 1200,
      expenseDate: '2026-09-06',
      category: 'Supplies',
      description: 'Office stationery and presentation materials',
      docData: SAMPLE_PDF,
      docName: 'stationery_bill.pdf',
    },
  });
  const submitRes = mockRes();
  await expensesHandler(submitReq, submitRes);
  assert.equal(submitRes.statusCode, 201, 'Expense submission should succeed');
  assert.equal(submitRes.body.expense.status, 'Pending Approval', 'Initial status must be Pending Approval');
  assert.equal(submitRes.body.expense.claimedAmount, 1200);
  assert.equal(submitRes.body.expense.employeeId, 'BCCI-E999');
  expenseId = submitRes.body.expense.id;
  assert.ok(expenseId, 'Expense ID should be present');

  // 1.4 Priya verifies claim in her own expense list
  const listReq = mockReq('GET', { token: priyaToken });
  const listRes = mockRes();
  await expensesHandler(listReq, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.expenses.length, 1);
  assert.equal(listRes.body.expenses[0].id, expenseId);
  assert.equal(listRes.body.expenses[0].status, 'Pending Approval');

  // 1.5 Priya can fetch her own document
  const priyaDocReq = mockReq('GET', { token: priyaToken, query: { id: expenseId, document: '1' } });
  const priyaDocRes = mockRes();
  await expensesHandler(priyaDocReq, priyaDocRes);
  assert.equal(priyaDocRes.statusCode, 200);
  assert.equal(priyaDocRes.body.document.docData, SAMPLE_PDF);
  assert.equal(priyaDocRes.body.document.fileName, 'stationery_bill.pdf');

  // 1.6 Admin fetches claim document
  const adminDocReq = mockReq('GET', { token: ADMIN_TOKEN, query: { id: expenseId, document: '1' } });
  const adminDocRes = mockRes();
  await expensesHandler(adminDocReq, adminDocRes);
  assert.equal(adminDocRes.statusCode, 200, 'Admin must be able to fetch receipt document');
  assert.ok(adminDocRes.body.document);
  assert.equal(adminDocRes.body.document.docData, SAMPLE_PDF);
  assert.equal(adminDocRes.body.document.fileName, 'stationery_bill.pdf');

  // 1.7 Admin reviews claim, partially approving ₹1000 (out of ₹1200) with remark
  const reviewReq = mockReq('PATCH', {
    token: ADMIN_TOKEN,
    body: {
      id: expenseId,
      decision: 'partially_approve',
      approvedAmount: 1000,
      remark: 'Approved ₹1000, ₹200 excluded for non-reimbursable personal item',
    },
  });
  const reviewRes = mockRes();
  await expensesHandler(reviewReq, reviewRes);
  assert.equal(reviewRes.statusCode, 200, 'Admin partial approval should succeed');
  assert.equal(reviewRes.body.expense.status, 'Partially Approved');
  assert.equal(reviewRes.body.expense.approvedAmount, 1000);
  assert.equal(reviewRes.body.expense.reviewedBy, 'admin@bccibharuch.in');
  assert.equal(reviewRes.body.expense.adminRemark, 'Approved ₹1000, ₹200 excluded for non-reimbursable personal item');

  // 1.8 Priya checks updated status and approved amount
  const checkReq = mockReq('GET', { token: priyaToken });
  const checkRes = mockRes();
  await expensesHandler(checkReq, checkRes);
  assert.equal(checkRes.statusCode, 200);
  assert.equal(checkRes.body.expenses.length, 1);
  assert.equal(checkRes.body.expenses[0].status, 'Partially Approved');
  assert.equal(checkRes.body.expenses[0].approvedAmount, 1000);
});

test('2. Security & Privilege Boundaries: Role Enforcement, Horizontal Isolation & Validation Rules', async () => {
  // 2.1 Priya cannot call admin review endpoint (fails with 401)
  const unauthReviewReq = mockReq('PATCH', {
    token: priyaToken,
    body: { id: expenseId, decision: 'approve', approvedAmount: 1200 },
  });
  const unauthReviewRes = mockRes();
  await expensesHandler(unauthReviewReq, unauthReviewRes);
  assert.equal(unauthReviewRes.statusCode, 401, 'Employee token must be rejected by admin review route');

  // 2.2 Priya cannot create other employees (fails with 401)
  const unauthCreateReq = mockReq('POST', {
    token: priyaToken,
    body: {
      name: 'Rogue Employee',
      employeeId: 'BCCI-E997',
      username: 'rogue.e',
      password: 'StrongPassword997!',
    },
  });
  const unauthCreateRes = mockRes();
  await employeesHandler(unauthCreateReq, unauthCreateRes);
  assert.equal(unauthCreateRes.statusCode, 401, 'Employee token cannot access admin employee creation');

  // 2.3 Horizontal isolation: Setup second employee Rahul Kapoor
  const createRahulReq = mockReq('POST', {
    token: ADMIN_TOKEN,
    body: {
      name: 'Rahul Kapoor',
      employeeId: 'BCCI-E998',
      username: 'rahul.k',
      password: 'StrongPassword998!',
      status: 'active',
    },
  });
  const createRahulRes = mockRes();
  await employeesHandler(createRahulReq, createRahulRes);
  assert.equal(createRahulRes.statusCode, 201);

  const rahulLoginReq = mockReq('POST', {
    body: { action: 'login', username: 'rahul.k', password: 'StrongPassword998!' },
  });
  const rahulLoginRes = mockRes();
  await employeeAuthHandler(rahulLoginReq, rahulLoginRes);
  assert.equal(rahulLoginRes.statusCode, 200);
  rahulToken = rahulLoginRes.body.session.token;
  assert.ok(rahulToken);

  // Rahul cannot see Priya's claim in GET /api/expenses
  const rahulListReq = mockReq('GET', { token: rahulToken });
  const rahulListRes = mockRes();
  await expensesHandler(rahulListReq, rahulListRes);
  assert.equal(rahulListRes.statusCode, 200);
  assert.equal(rahulListRes.body.expenses.length, 0, "Rahul cannot see Priya's submitted expense claims");

  // Rahul cannot fetch Priya's document (returns 403 Forbidden)
  const rahulDocReq = mockReq('GET', { token: rahulToken, query: { id: expenseId, document: '1' } });
  const rahulDocRes = mockRes();
  await expensesHandler(rahulDocReq, rahulDocRes);
  assert.equal(rahulDocRes.statusCode, 403, "Rahul cannot fetch another employee's receipt document");
  assert.equal(rahulDocRes.body.error, 'Unauthorized to view this document.');

  // 2.4 Admin cannot approve amount greater than claimed (₹1500 > ₹1200 rejected with 400)
  const overApprovalReq = mockReq('PATCH', {
    token: ADMIN_TOKEN,
    body: { id: expenseId, decision: 'approve', approvedAmount: 1500 },
  });
  const overApprovalRes = mockRes();
  await expensesHandler(overApprovalReq, overApprovalRes);
  assert.equal(overApprovalRes.statusCode, 400, 'Approved amount > claimed amount must be rejected');

  // 2.5 Approval amount cannot be negative, zero, non-numeric, or equal on partial approval
  const negativeReq = mockReq('PATCH', {
    token: ADMIN_TOKEN,
    body: { id: expenseId, decision: 'partially_approve', approvedAmount: -200 },
  });
  const negativeRes = mockRes();
  await expensesHandler(negativeReq, negativeRes);
  assert.equal(negativeRes.statusCode, 400, 'Negative approved amount must be rejected');

  const zeroPartialReq = mockReq('PATCH', {
    token: ADMIN_TOKEN,
    body: { id: expenseId, decision: 'partially_approve', approvedAmount: 0 },
  });
  const zeroPartialRes = mockRes();
  await expensesHandler(zeroPartialReq, zeroPartialRes);
  assert.equal(zeroPartialRes.statusCode, 400, 'Zero approved amount for partial approval must be rejected');

  const invalidTypeReq = mockReq('PATCH', {
    token: ADMIN_TOKEN,
    body: { id: expenseId, decision: 'approve', approvedAmount: 'not-a-number' },
  });
  const invalidTypeRes = mockRes();
  await expensesHandler(invalidTypeReq, invalidTypeRes);
  assert.equal(invalidTypeRes.statusCode, 400, 'Non-numeric approved amount must be rejected');
});

test('3. Soft Deactivation & Historical Retention: Deactivation, Login Lockout & Dossier Audit', async () => {
  // 3.1 Admin deactivates Priya
  const deactivateReq = mockReq('PATCH', {
    token: ADMIN_TOKEN,
    body: { employeeId: 'BCCI-E999', status: 'inactive' },
  });
  const deactivateRes = mockRes();
  await employeesHandler(deactivateReq, deactivateRes);
  assert.equal(deactivateRes.statusCode, 200, 'Admin can update employee status to inactive');
  assert.equal(deactivateRes.body.employee.status, 'inactive');

  // 3.2 Priya login attempt returns 403 Forbidden
  const blockedLoginReq = mockReq('POST', {
    body: { action: 'login', username: 'priya.s', password: 'StrongPassword999!' },
  });
  const blockedLoginRes = mockRes();
  await employeeAuthHandler(blockedLoginReq, blockedLoginRes);
  assert.equal(blockedLoginRes.statusCode, 403, 'Deactivated employee login must return 403');
  assert.match(blockedLoginRes.body.error, /deactivated/i);

  // 3.3 Admin inspects Priya employee dossier
  const dossierReq = mockReq('GET', {
    token: ADMIN_TOKEN,
    query: { id: 'BCCI-E999' },
  });
  const dossierRes = mockRes();
  await employeesHandler(dossierReq, dossierRes);
  assert.equal(dossierRes.statusCode, 200, 'Admin must be able to inspect employee dossier');
  assert.equal(dossierRes.body.employee.employeeId, 'BCCI-E999');
  assert.equal(dossierRes.body.employee.status, 'inactive');
  assert.equal(dossierRes.body.employee.stats.totalClaims, 1);
  assert.equal(dossierRes.body.employee.stats.approvedAmount, 1000);
  assert.equal(dossierRes.body.employee.stats.pendingAmount, 0);
  assert.ok(Array.isArray(dossierRes.body.employee.history), 'Historical claims list must be retained');
  assert.equal(dossierRes.body.employee.history.length, 1);
  assert.equal(dossierRes.body.employee.history[0].id, expenseId);
  assert.equal(dossierRes.body.employee.history[0].status, 'Partially Approved');
  assert.equal(dossierRes.body.employee.history[0].claimedAmount, 1200);
  assert.equal(dossierRes.body.employee.history[0].approvedAmount, 1000);

  // 3.4 Admin reactivates Priya and verifies login is restored
  const reactivateReq = mockReq('PATCH', {
    token: ADMIN_TOKEN,
    body: { employeeId: 'BCCI-E999', status: 'active' },
  });
  const reactivateRes = mockRes();
  await employeesHandler(reactivateReq, reactivateRes);
  assert.equal(reactivateRes.statusCode, 200);
  assert.equal(reactivateRes.body.employee.status, 'active');

  const restoredLoginReq = mockReq('POST', {
    body: { action: 'login', username: 'priya.s', password: 'StrongPassword999!' },
  });
  const restoredLoginRes = mockRes();
  await employeeAuthHandler(restoredLoginReq, restoredLoginRes);
  assert.equal(restoredLoginRes.statusCode, 200, 'Reactivated employee can successfully log in');
  assert.equal(restoredLoginRes.body.success, true);
});

test('4. Administrative Reporting & Dashboard Metrics', async () => {
  // 4.1 Filtered expenses query with aggregates
  const filterReq = mockReq('GET', {
    token: ADMIN_TOKEN,
    query: { employeeId: 'BCCI-E999', month: '9', year: '2026' },
  });
  const filterRes = mockRes();
  await expensesHandler(filterReq, filterRes);
  assert.equal(filterRes.statusCode, 200);
  assert.equal(filterRes.body.total, 1);
  assert.equal(filterRes.body.aggregates.totalClaimed, 1200);
  assert.equal(filterRes.body.aggregates.totalApproved, 1000);
  assert.equal(filterRes.body.aggregates.totalPending, 0);

  // 4.2 Dashboard stats counter includes expense summary metrics
  const statsReq = mockReq('GET', { token: ADMIN_TOKEN });
  const statsRes = mockRes();
  await adminStatsHandler(statsReq, statsRes);
  assert.equal(statsRes.statusCode, 200);
  assert.ok(statsRes.body.expenses, 'Admin stats response must contain expenses summary');
  assert.equal(statsRes.body.expenses.totalExpenses, 1);
  assert.equal(statsRes.body.expenses.totalApproved, 1000);
  assert.equal(statsRes.body.expenses.pendingApprovals, 0);
});
