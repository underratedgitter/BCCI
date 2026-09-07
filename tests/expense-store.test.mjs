// tests/expense-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../js/store.js';

// Setup browser globals for test environment
const storageMap = new Map();
globalThis.localStorage = {
  getItem(k) { return storageMap.get(k) ?? null; },
  setItem(k, v) { storageMap.set(k, String(v)); },
  removeItem(k) { storageMap.delete(k); },
  clear() { storageMap.clear(); },
};

// Mock fetch environment
let lastRequest = null;
let mockResponse = { status: 200, body: {} };

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  lastRequest = {
    url,
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body ? JSON.parse(opts.body) : null,
  };

  return {
    ok: mockResponse.status >= 200 && mockResponse.status < 300,
    status: mockResponse.status,
    headers: { get: () => 'application/json' },
    async json() { return mockResponse.body; },
    async text() { return JSON.stringify(mockResponse.body); },
  };
};

test.after(() => {
  globalThis.fetch = origFetch;
});

// ── 1. Session Management ─────────────────────────────────────────────

test('Store manages employee session correctly', () => {
  localStorage.clear();
  const store = new Store();
  assert.equal(store.isEmployeeAuthed(), false);
  assert.equal(store.getEmployeeSession(), null);

  const sampleSession = {
    token: 'test-token-123',
    employeeId: 'BCCI-E501',
    name: 'Test Employee',
    username: 'test.emp',
    expiresIn: 86400,
  };

  store.setEmployeeSession(sampleSession);
  assert.equal(store.isEmployeeAuthed(), true);
  assert.equal(store.getEmployeeSession().employeeId, 'BCCI-E501');
  assert.equal(store.getEmployeeSession().token, 'test-token-123');

  store.forgetEmployeeSession();
  assert.equal(store.isEmployeeAuthed(), false);
  assert.equal(store.getEmployeeSession(), null);
});

test('Store clears expired employee session on read', () => {
  localStorage.clear();
  const store = new Store();

  const expiredSession = {
    token: 'expired-token',
    employeeId: 'BCCI-E502',
    name: 'Expired Emp',
    expiresIn: -10, // already expired
  };

  store.setEmployeeSession(expiredSession);
  assert.equal(store.getEmployeeSession(), null);
  assert.equal(store.isEmployeeAuthed(), false);
});

// ── 2. apiCall with auth: "employee" ──────────────────────────────────

test('apiCall attaches Bearer token when auth: "employee"', async () => {
  localStorage.clear();
  const store = new Store();
  store.setEmployeeSession({
    token: 'emp-jwt-token-xyz',
    employeeId: 'BCCI-E503',
    name: 'Auth Emp',
    expiresIn: 3600,
  });

  mockResponse = { status: 200, body: { success: true } };
  await store.apiCall('/api/test-endpoint', { auth: 'employee' });

  assert.equal(lastRequest.headers['Authorization'], 'Bearer emp-jwt-token-xyz');
});

test('apiCall clears employee session on 401 response', async () => {
  localStorage.clear();
  const store = new Store();
  store.setEmployeeSession({
    token: 'revoked-token',
    employeeId: 'BCCI-E504',
    name: 'Revoked Emp',
    expiresIn: 3600,
  });

  mockResponse = { status: 401, body: { success: false, error: 'Session expired' } };

  await assert.rejects(async () => {
    await store.apiCall('/api/protected', { auth: 'employee' });
  }, (err) => {
    assert.equal(err.status, 401);
    return true;
  });

  assert.equal(store.isEmployeeAuthed(), false);
  assert.equal(store.getEmployeeSession(), null);
});

// ── 3. Employee Auth API Methods ──────────────────────────────────────

test('employeeLogin sets session on success', async () => {
  localStorage.clear();
  const store = new Store();

  mockResponse = {
    status: 200,
    body: {
      success: true,
      session: {
        token: 'login-token-777',
        employeeId: 'BCCI-E505',
        name: 'Login Emp',
        username: 'login.emp',
        expiresIn: 86400,
      },
    },
  };

  const res = await store.employeeLogin('login.emp', 'ValidPassword123');
  assert.equal(lastRequest.url, '/api/employee-auth');
  assert.equal(lastRequest.method, 'POST');
  assert.deepEqual(lastRequest.body, { action: 'login', username: 'login.emp', password: 'ValidPassword123' });

  assert.equal(res.success, true);
  assert.equal(res.session.employeeId, 'BCCI-E505');
  assert.equal(store.isEmployeeAuthed(), true);
  assert.equal(store.getEmployeeSession().token, 'login-token-777');
});

test('employeeLogin handles invalid credentials without saving session', async () => {
  localStorage.clear();
  const store = new Store();

  mockResponse = {
    status: 401,
    body: { success: false, error: 'Invalid username or password.' },
  };

  const res = await store.employeeLogin('login.emp', 'WrongPassword');
  assert.equal(res.success, false);
  assert.equal(res.error, 'Invalid username or password.');
  assert.equal(store.isEmployeeAuthed(), false);
});

test('employeeLogout calls DELETE /api/employee-auth and forgets session', async () => {
  localStorage.clear();
  const store = new Store();
  store.setEmployeeSession({
    token: 'logout-token',
    employeeId: 'BCCI-E506',
    name: 'Logout Emp',
    expiresIn: 3600,
  });

  mockResponse = { status: 200, body: { success: true, message: 'Signed out successfully.' } };

  const res = await store.employeeLogout();
  assert.equal(lastRequest.url, '/api/employee-auth');
  assert.equal(lastRequest.method, 'DELETE');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer logout-token');

  assert.equal(res.success, true);
  assert.equal(store.isEmployeeAuthed(), false);
  assert.equal(store.getEmployeeSession(), null);
});

test('getEmployeeProfile calls GET /api/employee-auth with auth: "employee"', async () => {
  localStorage.clear();
  const store = new Store();
  store.setEmployeeSession({
    token: 'profile-token',
    employeeId: 'BCCI-E507',
    name: 'Profile Emp',
    username: 'profile.emp',
    expiresIn: 3600,
  });

  mockResponse = {
    status: 200,
    body: {
      success: true,
      session: {
        token: 'profile-token',
        employeeId: 'BCCI-E507',
        name: 'Profile Emp',
        username: 'profile.emp',
      },
    },
  };

  const profile = await store.getEmployeeProfile();
  assert.equal(lastRequest.url, '/api/employee-auth');
  assert.equal(lastRequest.method, 'GET');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer profile-token');
  assert.equal(profile.employeeId, 'BCCI-E507');
});

// ── 4. Expense API Methods ────────────────────────────────────────────

test('submitExpense calls POST /api/expenses with auth: "employee"', async () => {
  localStorage.clear();
  const store = new Store();
  store.setEmployeeSession({
    token: 'emp-submit-token',
    employeeId: 'BCCI-E508',
    name: 'Submit Emp',
    expiresIn: 3600,
  });

  const expensePayload = {
    claimedAmount: 1250,
    expenseDate: '2026-09-07',
    category: 'Travel & Conveyance',
    description: 'Travel to Dahej industrial area for inspection',
    docData: 'data:application/pdf;base64,JVBERi0xLjQK...',
    docName: 'rail_ticket.pdf',
    docMime: 'application/pdf',
  };

  mockResponse = {
    status: 201,
    body: {
      success: true,
      message: 'Expense claim submitted successfully. Status is Pending Approval.',
      expense: { id: 'EXP-101', ...expensePayload, status: 'Pending Approval' },
    },
  };

  const res = await store.submitExpense(expensePayload);
  assert.equal(lastRequest.url, '/api/expenses');
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer emp-submit-token');
  assert.deepEqual(lastRequest.body, expensePayload);

  assert.equal(res.id, 'EXP-101');
  assert.equal(res.claimedAmount, 1250);
});

test('getEmployeeExpenses calls GET /api/expenses with auth: "employee"', async () => {
  localStorage.clear();
  const store = new Store();
  store.setEmployeeSession({
    token: 'emp-list-token',
    employeeId: 'BCCI-E509',
    name: 'List Emp',
    expiresIn: 3600,
  });

  mockResponse = {
    status: 200,
    body: {
      success: true,
      expenses: [
        { id: 'EXP-101', claimedAmount: 500, status: 'Pending Approval' },
        { id: 'EXP-102', claimedAmount: 1200, status: 'Approved', approvedAmount: 1200 },
      ],
      total: 2,
    },
  };

  const list = await store.getEmployeeExpenses();
  assert.equal(lastRequest.url, '/api/expenses');
  assert.equal(lastRequest.method, 'GET');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer emp-list-token');

  assert.ok(Array.isArray(list));
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'EXP-101');
  assert.equal(list.total, 2);
});

test('getExpenseDocument calls GET /api/expenses?id=...&document=1 with employee or admin auth', async () => {
  localStorage.clear();
  const store = new Store();

  // 1) As Employee
  store.setEmployeeSession({
    token: 'emp-doc-token',
    employeeId: 'BCCI-E510',
    expiresIn: 3600,
  });

  mockResponse = {
    status: 200,
    body: {
      success: true,
      document: { expenseId: 'EXP-103', docData: 'data:image/png;base64,...', fileName: 'bill.png' },
    },
  };

  let doc = await store.getExpenseDocument('EXP-103');
  assert.equal(lastRequest.url, '/api/expenses?id=EXP-103&document=1');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer emp-doc-token');
  assert.equal(doc.expenseId, 'EXP-103');

  // 2) As Admin
  store.forgetEmployeeSession();
  localStorage.setItem('bcci_admin_session', JSON.stringify({
    token: 'admin-doc-token',
    email: 'admin@bccibharuch.in',
    expiresAt: Date.now() + 3600000,
  }));

  doc = await store.getExpenseDocument('EXP-104');
  assert.equal(lastRequest.url, '/api/expenses?id=EXP-104&document=1');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer admin-doc-token');
  assert.equal(doc.expenseId, 'EXP-103');
});

test('getAdminExpenses calls GET /api/expenses with filters and auth: "admin"', async () => {
  localStorage.clear();
  const store = new Store();
  localStorage.setItem('bcci_admin_session', JSON.stringify({
    token: 'admin-expenses-token',
    email: 'admin@bccibharuch.in',
    expiresAt: Date.now() + 3600000,
  }));

  mockResponse = {
    status: 200,
    body: {
      success: true,
      expenses: [
        { id: 'EXP-105', claimedAmount: 1500, status: 'Pending Approval' },
      ],
      total: 1,
      aggregates: {
        totalClaimed: 1500,
        totalApproved: 0,
        totalPending: 1500,
        totalRejected: 0,
      },
    },
  };

  const res = await store.getAdminExpenses({ status: 'Pending Approval', month: 9, year: 2026 });
  assert.ok(lastRequest.url.startsWith('/api/expenses?'));
  assert.ok(lastRequest.url.includes('status=Pending+Approval') || lastRequest.url.includes('status=Pending%20Approval'));
  assert.ok(lastRequest.url.includes('month=9'));
  assert.ok(lastRequest.url.includes('year=2026'));
  assert.equal(lastRequest.headers['Authorization'], 'Bearer admin-expenses-token');

  assert.ok(Array.isArray(res));
  assert.equal(res.length, 1);
  assert.equal(res.aggregates.totalClaimed, 1500);
});

test('reviewExpense calls PATCH /api/expenses with body and auth: "admin"', async () => {
  localStorage.clear();
  const store = new Store();
  localStorage.setItem('bcci_admin_session', JSON.stringify({
    token: 'admin-review-token',
    email: 'admin@bccibharuch.in',
    expiresAt: Date.now() + 3600000,
  }));

  mockResponse = {
    status: 200,
    body: {
      success: true,
      message: 'Expense claim updated to Partially Approved.',
      expense: {
        id: 'EXP-106',
        status: 'Partially Approved',
        approvedAmount: 800,
        adminRemark: 'Approved per policy limits',
      },
    },
  };

  const res = await store.reviewExpense('EXP-106', {
    decision: 'partially_approve',
    approvedAmount: 800,
    remark: 'Approved per policy limits',
  });

  assert.equal(lastRequest.url, '/api/expenses');
  assert.equal(lastRequest.method, 'PATCH');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer admin-review-token');
  assert.deepEqual(lastRequest.body, {
    id: 'EXP-106',
    decision: 'partially_approve',
    approvedAmount: 800,
    remark: 'Approved per policy limits',
  });

  assert.equal(res.id, 'EXP-106');
  assert.equal(res.status, 'Partially Approved');
  assert.equal(res.approvedAmount, 800);
});

// ── 5. Employee Admin API Methods ─────────────────────────────────────

test('getAdminEmployees calls GET /api/employees with auth: "admin"', async () => {
  localStorage.clear();
  const store = new Store();
  localStorage.setItem('bcci_admin_session', JSON.stringify({
    token: 'admin-emp-token',
    email: 'admin@bccibharuch.in',
    expiresAt: Date.now() + 3600000,
  }));

  mockResponse = {
    status: 200,
    body: {
      success: true,
      employees: [
        { id: 'EMP-1', employeeId: 'BCCI-E101', name: 'Alice', status: 'active' },
        { id: 'EMP-2', employeeId: 'BCCI-E102', name: 'Bob', status: 'inactive' },
      ],
      total: 2,
    },
  };

  const list = await store.getAdminEmployees();
  assert.equal(lastRequest.url, '/api/employees');
  assert.equal(lastRequest.method, 'GET');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer admin-emp-token');

  assert.ok(Array.isArray(list));
  assert.equal(list.length, 2);
  assert.equal(list[0].employeeId, 'BCCI-E101');
});

test('getEmployeeDetails calls GET /api/employees?id=... with auth: "admin"', async () => {
  localStorage.clear();
  const store = new Store();
  localStorage.setItem('bcci_admin_session', JSON.stringify({
    token: 'admin-emp-token',
    email: 'admin@bccibharuch.in',
    expiresAt: Date.now() + 3600000,
  }));

  mockResponse = {
    status: 200,
    body: {
      success: true,
      employee: {
        id: 'EMP-1',
        employeeId: 'BCCI-E101',
        name: 'Alice',
        stats: { totalClaims: 5, approvedAmount: 3200 },
        history: [{ id: 'EXP-1' }, { id: 'EXP-2' }],
      },
    },
  };

  const emp = await store.getEmployeeDetails('BCCI-E101');
  assert.equal(lastRequest.url, '/api/employees?id=BCCI-E101');
  assert.equal(lastRequest.method, 'GET');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer admin-emp-token');

  assert.equal(emp.employeeId, 'BCCI-E101');
  assert.equal(emp.stats.totalClaims, 5);
  assert.equal(emp.history.length, 2);
});

test('createEmployee calls POST /api/employees with body and auth: "admin"', async () => {
  localStorage.clear();
  const store = new Store();
  localStorage.setItem('bcci_admin_session', JSON.stringify({
    token: 'admin-emp-token',
    email: 'admin@bccibharuch.in',
    expiresAt: Date.now() + 3600000,
  }));

  const newEmp = {
    name: 'Charlie Dave',
    employeeId: 'BCCI-E103',
    username: 'charlie.d',
    password: 'Password103!',
    email: 'charlie@bccibharuch.in',
  };

  mockResponse = {
    status: 201,
    body: {
      success: true,
      message: 'Employee created successfully.',
      employee: {
        id: 'EMP-3',
        employeeId: 'BCCI-E103',
        name: 'Charlie Dave',
        username: 'charlie.d',
        status: 'active',
      },
    },
  };

  const created = await store.createEmployee(newEmp);
  assert.equal(lastRequest.url, '/api/employees');
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer admin-emp-token');
  assert.deepEqual(lastRequest.body, newEmp);

  assert.equal(created.employeeId, 'BCCI-E103');
  assert.equal(created.status, 'active');
});

test('updateEmployeeStatus calls PATCH /api/employees with body and auth: "admin"', async () => {
  localStorage.clear();
  const store = new Store();
  localStorage.setItem('bcci_admin_session', JSON.stringify({
    token: 'admin-emp-token',
    email: 'admin@bccibharuch.in',
    expiresAt: Date.now() + 3600000,
  }));

  mockResponse = {
    status: 200,
    body: {
      success: true,
      message: 'Employee status updated to inactive.',
      employee: {
        id: 'EMP-3',
        employeeId: 'BCCI-E103',
        status: 'inactive',
      },
    },
  };

  const updated = await store.updateEmployeeStatus('BCCI-E103', 'inactive');
  assert.equal(lastRequest.url, '/api/employees');
  assert.equal(lastRequest.method, 'PATCH');
  assert.equal(lastRequest.headers['Authorization'], 'Bearer admin-emp-token');
  assert.deepEqual(lastRequest.body, { employeeId: 'BCCI-E103', status: 'inactive' });

  assert.equal(updated.employeeId, 'BCCI-E103');
  assert.equal(updated.status, 'inactive');
});
