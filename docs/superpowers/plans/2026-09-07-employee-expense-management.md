# Employee Expense Management System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a secure, backward-compatible Employee Expense Management System in the BCCI Bharuch portal enabling employees to submit expense claims with PDF/image receipts and administrators to review, manually approve, manage employees, and generate reports.

**Architecture:** Approach A (Dedicated Modular Endpoints & Native Tab Integration). Dedicated API routes (`api/employee-auth.js`, `api/employees.js`, `api/expenses.js`) backed by Upstash Redis with one-record-per-key pattern and sorted sets. Document payloads stored separately under `bcci:expense:doc:<id>`. Client frontend seamlessly integrated into `index.html`, `js/app.js`, and `js/store.js` using existing design tokens and UI patterns.

**Tech Stack:** Node.js 18+ (ESM), Upstash Redis (`@upstash/redis`), Vanilla JavaScript (ES6+), CSS3 custom properties, Font Awesome 6.

**Spec:** [`docs/superpowers/specs/2026-09-07-employee-expense-management-design.md`](file:///Users/surajpatel/documents/BCCI/docs/superpowers/specs/2026-09-07-employee-expense-management-design.md)

## Global Constraints

- NON-NEGOTIABLE RULE #1: DO NOT break, remove, overwrite, redesign, or regress any existing functionality.
- Existing membership applications, applicant authentication, event registration, enquiries, digital membership cards, QR codes, and existing admin views must continue working without regression.
- Every existing test in `npm test` must continue to pass with 0 failures.
- CRITICAL AMOUNT RULE: The system must never auto-populate claimed amount as approved amount. Admin must manually enter approved amount ($0 \le \text{approvedAmount} \le \text{claimedAmount}$).
- Soft delete / deactivation: Never delete historical expense records when an employee is deactivated.
- Security: Server-side role authorization for all employee and admin actions. Employees cannot view or alter other employees' claims or access admin APIs.
- Uploaded receipts: Support PDF, JPG/JPEG, PNG up to 1.5MB as base64 data URIs.

---

### Task 1: Validation & Type Schema Helpers (`api/_lib/validation.js`)

**Files:**
- Create: `api/_lib/validation.js`
- Test: `tests/validation.test.mjs`

**Interfaces:**
- Produces:
  - `validateEmployeeInput(data: object): { ok: boolean, errors: string[], value: object }`
  - `validateExpenseInput(data: object): { ok: boolean, errors: string[], value: object }`
  - `validateReviewInput(data: object, claimedAmount: number): { ok: boolean, errors: string[], value: object }`
  - `EXPENSE_CATEGORIES: string[]`
  - `EXPENSE_STATUSES: object`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/validation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEmployeeInput,
  validateExpenseInput,
  validateReviewInput,
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
} from '../api/_lib/validation.js';

test('EXPENSE_CATEGORIES includes standard business categories', () => {
  assert.ok(EXPENSE_CATEGORIES.includes('Travel'));
  assert.ok(EXPENSE_CATEGORIES.includes('Food'));
  assert.ok(EXPENSE_CATEGORIES.includes('Lodging'));
  assert.ok(EXPENSE_CATEGORIES.includes('Supplies'));
});

test('validateEmployeeInput enforces required fields and formats', () => {
  const invalid = validateEmployeeInput({});
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length >= 3);

  const valid = validateEmployeeInput({
    name: 'Rajesh Parmar',
    employeeId: 'bcci-e101',
    username: 'rajesh.p',
    password: 'Password123!',
    email: 'rajesh@example.com',
    status: 'active',
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.employeeId, 'BCCI-E101');
  assert.equal(valid.value.username, 'rajesh.p');
});

test('validateExpenseInput validates claimedAmount and document format', () => {
  const invalid = validateExpenseInput({ claimedAmount: -50 });
  assert.equal(invalid.ok, false);

  const valid = validateExpenseInput({
    claimedAmount: '1250.50',
    expenseDate: '2026-09-01',
    category: 'Travel',
    description: 'Taxi to industrial estate client meeting',
    docData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    docName: 'receipt.png',
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.claimedAmount, 1250.50);
});

test('validateReviewInput enforces Critical Amount Rule (approved <= claimed, non-negative)', () => {
  const overClaimed = validateReviewInput({
    decision: 'approve',
    approvedAmount: 1500,
  }, 1000);
  assert.equal(overClaimed.ok, false);

  const negative = validateReviewInput({
    decision: 'approve',
    approvedAmount: -10,
  }, 1000);
  assert.equal(negative.ok, false);

  const rejectNeedsRemark = validateReviewInput({
    decision: 'reject',
    approvedAmount: 0,
    remark: '',
  }, 1000);
  assert.equal(rejectNeedsRemark.ok, false);

  const validPartial = validateReviewInput({
    decision: 'partially_approve',
    approvedAmount: 750,
    remark: 'Approved hotel room excluding minibar charges',
  }, 1000);
  assert.equal(validPartial.ok, true);
  assert.equal(validPartial.value.status, 'Partially Approved');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/validation.test.mjs`
Expected: FAIL with Cannot find module `../api/_lib/validation.js`

- [ ] **Step 3: Write minimal implementation**

```javascript
// api/_lib/validation.js
// Runtime validation and schema definitions for Employee Expense Management.

export const EXPENSE_CATEGORIES = [
  'Travel',
  'Food',
  'Lodging',
  'Supplies',
  'Transport',
  'Client Entertainment',
  'Miscellaneous',
];

export const EXPENSE_STATUSES = {
  PENDING: 'Pending Approval',
  APPROVED: 'Approved',
  PARTIALLY_APPROVED: 'Partially Approved',
  REJECTED: 'Rejected',
};

const MAX_DOC_SIZE_BYTES = 1.5 * 1024 * 1024; // 1.5MB base64

export function validateEmployeeInput(data = {}) {
  const errors = [];
  const name = String(data.name || '').trim().slice(0, 120);
  const employeeId = String(data.employeeId || '').trim().toUpperCase().slice(0, 30);
  const username = String(data.username || '').trim().toLowerCase().slice(0, 50);
  const password = typeof data.password === 'string' ? data.password : '';
  const email = String(data.email || '').trim().toLowerCase().slice(0, 254);
  const status = data.status === 'inactive' ? 'inactive' : 'active';

  if (!name || name.length < 2) errors.push('Employee full name is required (min 2 characters).');
  if (!employeeId || !/^[A-Z0-9_-]{2,30}$/.test(employeeId)) {
    errors.push('Employee ID is required (alphanumeric, hyphens/underscores, 2-30 characters).');
  }
  if (!username || !/^[a-z0-9._-]{3,50}$/.test(username)) {
    errors.push('Username is required (alphanumeric, dots/underscores, 3-50 characters).');
  }
  if (data.isUpdate) {
    if (password && password.length < 8) errors.push('Password must be at least 8 characters long.');
  } else {
    if (!password || password.length < 8) errors.push('Password is required and must be at least 8 characters long.');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('A valid email address is required.');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: { name, employeeId, username, password, email: email || null, status },
  };
}

export function validateExpenseInput(data = {}) {
  const errors = [];
  const claimedAmountNum = Number(data.claimedAmount);
  if (isNaN(claimedAmountNum) || claimedAmountNum <= 0 || claimedAmountNum > 10000000) {
    errors.push('Claimed amount must be a positive number greater than ₹0 and up to ₹1,00,00,000.');
  }
  const claimedAmount = Math.round(claimedAmountNum * 100) / 100;

  const expenseDate = String(data.expenseDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) {
    errors.push('Valid expense date (YYYY-MM-DD) is required.');
  } else {
    const d = new Date(expenseDate);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (isNaN(d.getTime()) || d > today) {
      errors.push('Expense date cannot be in the future.');
    }
  }

  const category = String(data.category || '').trim();
  if (!EXPENSE_CATEGORIES.includes(category)) {
    errors.push(`Category must be one of: ${EXPENSE_CATEGORIES.join(', ')}.`);
  }

  const description = String(data.description || '').trim().slice(0, 1000);
  if (!description || description.length < 3) {
    errors.push('Description/purpose is required (min 3 characters).');
  }

  const docData = typeof data.docData === 'string' ? data.docData.trim() : '';
  const docName = String(data.docName || '').trim().slice(0, 150) || 'receipt';
  let docMime = '';

  if (!docData) {
    errors.push('A bill or receipt document (PDF, PNG, or JPEG) is required.');
  } else {
    const match = docData.match(/^data:(application\/pdf|image\/(png|jpe?g|webp));base64,/);
    if (!match) {
      errors.push('Uploaded document must be a PDF or image file (PNG, JPG, WEBP).');
    } else {
      docMime = match[1];
      if (docData.length > MAX_DOC_SIZE_BYTES * 1.37) { // Base64 encoding overhead
        errors.push('Uploaded document exceeds maximum size limit of 1.5MB.');
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      claimedAmount,
      expenseDate,
      category,
      description,
      docData,
      docName,
      docMime,
    },
  };
}

export function validateReviewInput(data = {}, claimedAmount = 0) {
  const errors = [];
  const decision = String(data.decision || '').toLowerCase().trim();
  const rawApproved = data.approvedAmount;
  let approvedAmount = 0;
  const remark = String(data.remark || '').trim().slice(0, 1000);

  if (!['approve', 'partially_approve', 'reject'].includes(decision)) {
    errors.push('Decision must be "approve", "partially_approve", or "reject".');
  }

  if (decision === 'reject') {
    approvedAmount = 0;
    if (!remark || remark.length < 3) {
      errors.push('A remark or reason is required when rejecting an expense claim.');
    }
  } else {
    const approvedNum = Number(rawApproved);
    if (isNaN(approvedNum) || approvedNum < 0) {
      errors.push('Approved amount must be a valid non-negative number.');
    } else if (approvedNum > claimedAmount) {
      errors.push(`Approved amount (₹${approvedNum}) cannot exceed the claimed amount (₹${claimedAmount}).`);
    } else {
      approvedAmount = Math.round(approvedNum * 100) / 100;
      if (decision === 'approve' && approvedAmount <= 0) {
        errors.push('Approved amount must be greater than ₹0 for approval.');
      }
    }
  }

  let status = EXPENSE_STATUSES.PENDING;
  if (decision === 'reject') {
    status = EXPENSE_STATUSES.REJECTED;
  } else if (approvedAmount === claimedAmount) {
    status = EXPENSE_STATUSES.APPROVED;
  } else if (approvedAmount > 0 && approvedAmount < claimedAmount) {
    status = EXPENSE_STATUSES.PARTIALLY_APPROVED;
  }

  return {
    ok: errors.length === 0,
    errors,
    value: { decision, approvedAmount, remark: remark || null, status },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/validation.test.mjs`
Expected: PASS (4 tests passed)

- [ ] **Step 5: Commit**

```bash
git add api/_lib/validation.js tests/validation.test.mjs
git commit -m "feat(expenses): add runtime validation and schema definitions"
```

---

### Task 2: Employee & Expense Storage Layer (`api/_lib/expenses.js`)

**Files:**
- Create: `api/_lib/expenses.js`
- Test: `tests/expense-data.test.mjs`

**Interfaces:**
- Consumes: `redis`, `withRetry` from `api/_lib/redis.js`, `hashPassword` from `api/_lib/accounts.js`, `validation.js`
- Produces:
  - `saveEmployee(empData)`
  - `getEmployeeById(id)`
  - `getEmployeeByUsername(username)`
  - `getEmployeeByCode(code)`
  - `listEmployees()`
  - `updateEmployeeStatus(id, status)`
  - `saveExpense(expenseData, docData)`
  - `getExpense(id)`
  - `getExpenseDoc(id)`
  - `listExpenses(filter)`
  - `updateExpenseReview(id, reviewData)`
  - `getEmployeeExpenseStats(employeeId)`
  - `getExpenseSummaryMetrics()`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/expense-data.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveEmployee,
  getEmployeeByUsername,
  getEmployeeByCode,
  listEmployees,
  updateEmployeeStatus,
  saveExpense,
  getExpense,
  getExpenseDoc,
  listExpenses,
  updateExpenseReview,
  getEmployeeExpenseStats,
  getExpenseSummaryMetrics,
} from '../api/_lib/expenses.js';

test('Employee persistence and unique lookup', async () => {
  const emp = await saveEmployee({
    name: 'Anil Mehta',
    employeeId: 'BCCI-E901',
    username: 'anil.mehta',
    password: 'SecurePassword123!',
    email: 'anil@example.com',
    status: 'active',
  });
  assert.ok(emp.id);
  assert.equal(emp.employeeId, 'BCCI-E901');

  const byUser = await getEmployeeByUsername('anil.mehta');
  assert.equal(byUser.employeeId, 'BCCI-E901');

  const byCode = await getEmployeeByCode('BCCI-E901');
  assert.equal(byCode.username, 'anil.mehta');

  const updated = await updateEmployeeStatus(emp.id, 'inactive');
  assert.equal(updated.status, 'inactive');
});

test('Expense claim creation and document separation', async () => {
  const expense = await saveExpense({
    employeeId: 'BCCI-E901',
    employeeName: 'Anil Mehta',
    expenseDate: '2026-09-02',
    category: 'Food',
    description: 'Business lunch with industrial delegates',
    claimedAmount: 850,
    docData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    docName: 'lunch_bill.png',
    docMime: 'image/png',
  });

  assert.ok(expense.id.startsWith('EXP-'));
  assert.equal(expense.status, 'Pending Approval');
  assert.equal(expense.approvedAmount, null);
  assert.equal(expense.claimedAmount, 850);

  const doc = await getExpenseDoc(expense.id);
  assert.ok(doc.docData.startsWith('data:image/png;base64,'));

  const list = await listExpenses({ employeeId: 'BCCI-E901' });
  assert.ok(list.some(e => e.id === expense.id));
  // Verify document is NOT present in list item to keep listing lightweight
  assert.equal(list.find(e => e.id === expense.id).docData, undefined);
});

test('Admin review updates status, approved amount, and audit trail', async () => {
  const expense = await saveExpense({
    employeeId: 'BCCI-E901',
    employeeName: 'Anil Mehta',
    expenseDate: '2026-09-03',
    category: 'Travel',
    description: 'Train tickets to Ahmedabad',
    claimedAmount: 600,
    docData: 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDM',
    docName: 'ticket.pdf',
    docMime: 'application/pdf',
  });

  const reviewed = await updateExpenseReview(expense.id, {
    approvedAmount: 500,
    status: 'Partially Approved',
    reviewedBy: 'admin@bccibharuch.in',
    adminRemark: 'Approved 2nd class sleeper fare as per travel policy',
  });

  assert.equal(reviewed.status, 'Partially Approved');
  assert.equal(reviewed.approvedAmount, 500);
  assert.equal(reviewed.reviewedBy, 'admin@bccibharuch.in');

  const stats = await getEmployeeExpenseStats('BCCI-E901');
  assert.ok(stats.totalClaims >= 2);
  assert.ok(stats.approvedAmount >= 500);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/expense-data.test.mjs`
Expected: FAIL with Cannot find module `../api/_lib/expenses.js`

- [ ] **Step 3: Write minimal implementation**

```javascript
// api/_lib/expenses.js
// Persistence operations for employees and expense management in Upstash Redis.

import crypto from 'node:crypto';
import { redis, withRetry } from './redis.js';
import { hashPassword } from './accounts.js';
import { EXPENSE_STATUSES } from './validation.js';

export const EXP_KEYS = {
  emp: (id) => `bcci:emp:${id}`,
  empUsername: (username) => `bcci:emp_username:${String(username).trim().toLowerCase()}`,
  empCode: (code) => `bcci:emp_code:${String(code).trim().toUpperCase()}`,
  empIndex: 'bcci:emp_index',
  empSession: (token) => `bcci:employee_session:${token}`,

  expense: (id) => `bcci:expense:${id}`,
  expenseDoc: (id) => `bcci:expense:doc:${id}`,
  expenseIndex: 'bcci:expense_index',
  expenseEmp: (empId) => `bcci:expense_emp:${String(empId).trim().toUpperCase()}`,
};

export async function saveEmployee(data) {
  const username = String(data.username).trim().toLowerCase();
  const employeeId = String(data.employeeId).trim().toUpperCase();
  const now = new Date().toISOString();

  const id = data.id || `EMP-${crypto.randomUUID()}`;
  const { hash, salt } = data.password ? hashPassword(data.password) : { hash: data.passwordHash, salt: data.salt };

  const record = {
    id,
    employeeId,
    name: String(data.name).trim(),
    username,
    email: data.email ? String(data.email).trim().toLowerCase() : null,
    passwordHash: hash,
    salt,
    status: data.status === 'inactive' ? 'inactive' : 'active',
    createdAt: data.createdAt || now,
    updatedAt: now,
  };

  await withRetry(async () => {
    await redis.set(EXP_KEYS.emp(id), record);
    await redis.set(EXP_KEYS.empUsername(username), id);
    await redis.set(EXP_KEYS.empCode(employeeId), id);
    const score = Date.parse(record.createdAt) || Date.now();
    await redis.zadd(EXP_KEYS.empIndex, { score, member: id });
  });

  return record;
}

export async function getEmployeeById(id) {
  if (!id) return null;
  return withRetry(async () => {
    const raw = await redis.get(EXP_KEYS.emp(id));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  });
}

export async function getEmployeeByUsername(username) {
  if (!username) return null;
  return withRetry(async () => {
    const id = await redis.get(EXP_KEYS.empUsername(username));
    if (!id) return null;
    return getEmployeeById(id);
  });
}

export async function getEmployeeByCode(code) {
  if (!code) return null;
  return withRetry(async () => {
    const id = await redis.get(EXP_KEYS.empCode(code));
    if (!id) return null;
    return getEmployeeById(id);
  });
}

export async function listEmployees() {
  return withRetry(async () => {
    const ids = await redis.zrange(EXP_KEYS.empIndex, 0, -1);
    if (!ids || !ids.length) return [];
    const rawList = await redis.mget(...ids.map(EXP_KEYS.emp));
    return rawList.filter(Boolean).map(r => (typeof r === 'string' ? JSON.parse(r) : r));
  });
}

export async function updateEmployeeStatus(id, status) {
  return withRetry(async () => {
    const emp = await getEmployeeById(id);
    if (!emp) return null;
    emp.status = status === 'inactive' ? 'inactive' : 'active';
    emp.updatedAt = new Date().toISOString();
    await redis.set(EXP_KEYS.emp(id), emp);
    return emp;
  });
}

export async function saveExpense(data) {
  const now = new Date().toISOString();
  const id = `EXP-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const employeeId = String(data.employeeId).trim().toUpperCase();

  const record = {
    id,
    employeeId,
    employeeName: String(data.employeeName || '').trim(),
    expenseDate: String(data.expenseDate),
    category: String(data.category),
    description: String(data.description),
    claimedAmount: Number(data.claimedAmount),
    approvedAmount: null,
    status: EXPENSE_STATUSES.PENDING,
    hasDoc: Boolean(data.docData),
    docName: String(data.docName || 'receipt'),
    docMime: String(data.docMime || 'application/octet-stream'),
    docSize: data.docData ? Buffer.byteLength(data.docData, 'utf8') : 0,
    submittedAt: now,
    reviewedAt: null,
    reviewedBy: null,
    adminRemark: null,
  };

  await withRetry(async () => {
    await redis.set(EXP_KEYS.expense(id), record);
    if (data.docData) {
      await redis.set(EXP_KEYS.expenseDoc(id), {
        expenseId: id,
        docData: data.docData,
        mimeType: record.docMime,
        fileName: record.docName,
        fileSize: record.docSize,
      });
    }
    const score = Date.parse(record.submittedAt) || Date.now();
    await redis.zadd(EXP_KEYS.expenseIndex, { score, member: id });
    await redis.zadd(EXP_KEYS.expenseEmp(employeeId), { score, member: id });
  });

  return record;
}

export async function getExpense(id) {
  if (!id) return null;
  return withRetry(async () => {
    const raw = await redis.get(EXP_KEYS.expense(id));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  });
}

export async function getExpenseDoc(id) {
  if (!id) return null;
  return withRetry(async () => {
    const raw = await redis.get(EXP_KEYS.expenseDoc(id));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  });
}

export async function listExpenses({ employeeId, month, year, status, category, limit = 500, offset = 0 } = {}) {
  return withRetry(async () => {
    const key = employeeId ? EXP_KEYS.expenseEmp(employeeId) : EXP_KEYS.expenseIndex;
    const ids = await redis.zrange(key, offset, offset + limit - 1, { rev: true });
    if (!ids || !ids.length) return [];

    const rawList = await redis.mget(...ids.map(EXP_KEYS.expense));
    let expenses = rawList.filter(Boolean).map(r => (typeof r === 'string' ? JSON.parse(r) : r));

    if (status) {
      expenses = expenses.filter(e => String(e.status).toLowerCase() === String(status).toLowerCase());
    }
    if (category) {
      expenses = expenses.filter(e => e.category === category);
    }
    if (year) {
      expenses = expenses.filter(e => {
        const d = new Date(e.expenseDate || e.submittedAt);
        return d.getFullYear() === Number(year);
      });
    }
    if (month) {
      expenses = expenses.filter(e => {
        const d = new Date(e.expenseDate || e.submittedAt);
        return d.getMonth() + 1 === Number(month);
      });
    }

    return expenses;
  });
}

export async function updateExpenseReview(id, { approvedAmount, status, reviewedBy, adminRemark }) {
  return withRetry(async () => {
    const current = await getExpense(id);
    if (!current) return null;

    const next = {
      ...current,
      approvedAmount: Number(approvedAmount) || 0,
      status,
      reviewedBy: String(reviewedBy || ''),
      reviewedAt: new Date().toISOString(),
      adminRemark: adminRemark ? String(adminRemark) : null,
    };

    await redis.set(EXP_KEYS.expense(id), next);
    return next;
  });
}

export async function getEmployeeExpenseStats(employeeId) {
  const claims = await listExpenses({ employeeId, limit: 1000 });
  let claimedAmount = 0;
  let approvedAmount = 0;
  let rejectedAmount = 0;
  let pendingAmount = 0;

  for (const c of claims) {
    claimedAmount += Number(c.claimedAmount) || 0;
    if (c.status === EXPENSE_STATUSES.APPROVED || c.status === EXPENSE_STATUSES.PARTIALLY_APPROVED) {
      approvedAmount += Number(c.approvedAmount) || 0;
    } else if (c.status === EXPENSE_STATUSES.REJECTED) {
      rejectedAmount += Number(c.claimedAmount) || 0;
    } else {
      pendingAmount += Number(c.claimedAmount) || 0;
    }
  }

  return {
    totalClaims: claims.length,
    claimedAmount: Math.round(claimedAmount * 100) / 100,
    approvedAmount: Math.round(approvedAmount * 100) / 100,
    rejectedAmount: Math.round(rejectedAmount * 100) / 100,
    pendingAmount: Math.round(pendingAmount * 100) / 100,
  };
}

export async function getExpenseSummaryMetrics() {
  const expenses = await listExpenses({ limit: 5000 });
  const employees = await listEmployees();

  let totalClaimed = 0;
  let totalApproved = 0;
  let pendingApprovals = 0;
  let rejectedExpenses = 0;

  for (const e of expenses) {
    totalClaimed += Number(e.claimedAmount) || 0;
    if (e.status === EXPENSE_STATUSES.APPROVED || e.status === EXPENSE_STATUSES.PARTIALLY_APPROVED) {
      totalApproved += Number(e.approvedAmount) || 0;
    } else if (e.status === EXPENSE_STATUSES.PENDING) {
      pendingApprovals++;
    } else if (e.status === EXPENSE_STATUSES.REJECTED) {
      rejectedExpenses++;
    }
  }

  return {
    totalExpenses: expenses.length,
    totalClaimed: Math.round(totalClaimed * 100) / 100,
    totalApproved: Math.round(totalApproved * 100) / 100,
    pendingApprovals,
    rejectedExpenses,
    totalEmployees: employees.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/expense-data.test.mjs`
Expected: PASS (3 tests passed)

- [ ] **Step 5: Commit**

```bash
git add api/_lib/expenses.js tests/expense-data.test.mjs
git commit -m "feat(expenses): add Redis storage and index layer for employees and expenses"
```

---

### Task 3: Employee Authentication Endpoint & Session Verification (`api/employee-auth.js` & `api/_lib/http.js`)

**Files:**
- Modify: `api/_lib/http.js`
- Create: `api/employee-auth.js`
- Test: `tests/employee-auth.test.mjs`

**Interfaces:**
- In `api/_lib/http.js`:
  - `getEmployeeSession(req): Promise<object|null>`
  - `requireEmployee(req, res): Promise<object|null>`
- In `api/employee-auth.js`:
  - `POST`: login
  - `DELETE`: logout
  - `GET`: me (validate session)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/employee-auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveEmployee } from '../api/_lib/expenses.js';
import employeeAuthHandler from '../api/employee-auth.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/employee-auth.test.mjs`
Expected: FAIL with Cannot find module `../api/employee-auth.js`

- [ ] **Step 3: Write minimal implementation**

In `api/_lib/http.js`:
Add exports `getEmployeeSession` and `requireEmployee`:
```javascript
export async function getEmployeeSession(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const raw = await withRetry(() => redis.get(`bcci:employee_session:${token}`));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function requireEmployee(req, res) {
  const session = await getEmployeeSession(req);
  if (!session || !session.employeeId) {
    res.status(401).json({ success: false, error: 'Employee authentication required.' });
    return null;
  }
  return session;
}
```

Create `api/employee-auth.js`:
```javascript
// api/employee-auth.js
// Employee login, logout, and session check.

import crypto from 'node:crypto';
import { redis, withRetry } from './_lib/redis.js';
import { verifyPassword } from './_lib/accounts.js';
import { getEmployeeByUsername, EXP_KEYS } from './_lib/expenses.js';
import {
  applyCors,
  handlePreflight,
  bearerToken,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  withErrorHandling,
} from './_lib/http.js';

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── Logout ───────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const token = bearerToken(req);
    if (token) await redis.del(EXP_KEYS.empSession(token)).catch(() => {});
    return res.status(200).json({ success: true, message: 'Signed out successfully.' });
  }

  // ── Session Check ────────────────────────────────────────────────
  if (req.method === 'GET') {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ success: false, error: 'No token provided.' });
    const raw = await redis.get(EXP_KEYS.empSession(token));
    if (!raw) return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
    const session = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json({ success: true, session });
  }

  // ── Login ────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  const username = str(req.body?.username, 50).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required.' });
  }

  const ip = clientIp(req);
  const ipLimit = await rateLimit(`emplogin:ip:${ip}`, { max: 10, windowSec: 900 });
  if (!ipLimit.ok) {
    return tooManyRequests(res, ipLimit.retryAfter, 'Too many login attempts. Please try again later.');
  }

  const userLimit = await rateLimit(`emplogin:user:${username}`, { max: 10, windowSec: 900 });
  if (!userLimit.ok) {
    return tooManyRequests(res, userLimit.retryAfter, 'Too many login attempts for this user. Please try again later.');
  }

  const emp = await getEmployeeByUsername(username);
  if (!emp || !verifyPassword(password, emp.passwordHash, emp.salt)) {
    return res.status(401).json({ success: false, error: 'Invalid username or password.' });
  }

  if (emp.status === 'inactive') {
    return res.status(403).json({
      success: false,
      error: 'Your employee account has been deactivated. Please contact administration.',
    });
  }

  const token = crypto.randomUUID();
  const session = {
    token,
    id: emp.id,
    employeeId: emp.employeeId,
    name: emp.name,
    username: emp.username,
    email: emp.email,
    authenticatedAt: new Date().toISOString(),
    expiresIn: SESSION_TTL_SECONDS,
  };

  await withRetry(() =>
    redis.set(EXP_KEYS.empSession(token), session, { ex: SESSION_TTL_SECONDS })
  );

  return res.status(200).json({ success: true, session });
}

export default withErrorHandling('EmployeeAuth', handler);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/employee-auth.test.mjs`
Expected: PASS (3 tests passed)

- [ ] **Step 5: Commit**

```bash
git add api/_lib/http.js api/employee-auth.js tests/employee-auth.test.mjs
git commit -m "feat(expenses): add employee auth and session verification"
```

---

### Task 4: Admin Employee Management API (`api/employees.js`)

**Files:**
- Create: `api/employees.js`
- Test: `tests/employees-api.test.mjs`

**Interfaces:**
- Protected: Admin only (`requireAdmin`)
- `GET`: Lists all employees with `totalClaims` and `totalApprovedAmount`. If `?id=<id>` provided, returns full dossier + history.
- `POST`: Creates new employee with uniqueness validation on `username` and `employeeId`.
- `PATCH`: Soft delete / deactivation (`status: 'active' | 'inactive'`).

- [ ] **Step 1: Write the failing test**

```javascript
// tests/employees-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import employeesHandler from '../api/employees.js';
import { redis } from '../api/_lib/redis.js';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/employees-api.test.mjs`
Expected: FAIL with Cannot find module `../api/employees.js`

- [ ] **Step 3: Write minimal implementation**

Create `api/employees.js`:
```javascript
// api/employees.js
// Admin management of BCCI employees (add, list, deactivate, inspect history).

import {
  saveEmployee,
  listEmployees,
  getEmployeeByCode,
  getEmployeeByUsername,
  updateEmployeeStatus,
  getEmployeeExpenseStats,
  listExpenses,
} from './_lib/expenses.js';
import { validateEmployeeInput } from './_lib/validation.js';
import {
  applyCors,
  handlePreflight,
  requireAdmin,
  str,
  withErrorHandling,
} from './_lib/http.js';

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PATCH, OPTIONS');
  if (handlePreflight(req, res)) return;

  const adminEmail = await requireAdmin(req, res);
  if (!adminEmail) return;

  // ── GET ──────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const targetCode = str(req.query?.id, 30).toUpperCase();
    if (targetCode) {
      const emp = await getEmployeeByCode(targetCode);
      if (!emp) return res.status(404).json({ success: false, error: 'Employee not found.' });
      const stats = await getEmployeeExpenseStats(targetCode);
      const history = await listExpenses({ employeeId: targetCode, limit: 1000 });
      return res.status(200).json({
        success: true,
        employee: {
          id: emp.id,
          employeeId: emp.employeeId,
          name: emp.name,
          username: emp.username,
          email: emp.email,
          status: emp.status,
          createdAt: emp.createdAt,
          updatedAt: emp.updatedAt,
          stats,
          history,
        },
      });
    }

    const employees = await listEmployees();
    const enriched = await Promise.all(
      employees.map(async (e) => {
        const stats = await getEmployeeExpenseStats(e.employeeId);
        return {
          id: e.id,
          employeeId: e.employeeId,
          name: e.name,
          username: e.username,
          email: e.email,
          status: e.status,
          createdAt: e.createdAt,
          totalClaims: stats.totalClaims,
          totalApprovedAmount: stats.approvedAmount,
        };
      })
    );

    return res.status(200).json({ success: true, employees: enriched, total: enriched.length });
  }

  // ── POST ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const validation = validateEmployeeInput(req.body || {});
    if (!validation.ok) {
      return res.status(400).json({ success: false, errors: validation.errors, error: validation.errors[0] });
    }

    const { name, employeeId, username, password, email, status } = validation.value;

    const existingCode = await getEmployeeByCode(employeeId);
    if (existingCode) {
      return res.status(409).json({ success: false, error: `Employee ID "${employeeId}" is already assigned.` });
    }

    const existingUser = await getEmployeeByUsername(username);
    if (existingUser) {
      return res.status(409).json({ success: false, error: `Username "${username}" is already taken.` });
    }

    const created = await saveEmployee({ name, employeeId, username, password, email, status });
    return res.status(201).json({
      success: true,
      message: 'Employee created successfully.',
      employee: {
        id: created.id,
        employeeId: created.employeeId,
        name: created.name,
        username: created.username,
        email: created.email,
        status: created.status,
        createdAt: created.createdAt,
      },
    });
  }

  // ── PATCH ────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const employeeId = str(req.body?.employeeId || req.body?.id, 30).toUpperCase();
    const targetStatus = req.body?.status === 'inactive' ? 'inactive' : 'active';

    const emp = await getEmployeeByCode(employeeId);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found.' });

    const updated = await updateEmployeeStatus(emp.id, targetStatus);
    return res.status(200).json({
      success: true,
      message: `Employee status updated to ${targetStatus}.`,
      employee: {
        id: updated.id,
        employeeId: updated.employeeId,
        name: updated.name,
        username: updated.username,
        status: updated.status,
        updatedAt: updated.updatedAt,
      },
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
}

export default withErrorHandling('EmployeesAPI', handler);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/employees-api.test.mjs`
Expected: PASS (3 tests passed)

- [ ] **Step 5: Commit**

```bash
git add api/employees.js tests/employees-api.test.mjs
git commit -m "feat(expenses): add admin employee management API"
```

---

### Task 5: Expenses API (`api/expenses.js`) & Admin Stats Integration (`api/admin-stats.js`)

**Files:**
- Create: `api/expenses.js`
- Modify: `api/admin-stats.js`
- Test: `tests/expense-api.test.mjs`

**Interfaces:**
- `POST /api/expenses`: Employee submits claim
- `GET /api/expenses`: Employee lists own claims; Admin lists with filters
- `GET /api/expenses?id=<id>&document=1`: Secure document fetch
- `PATCH /api/expenses`: Admin reviews claim ($0 \le \text{approved} \le \text{claimed}$)
- `GET /api/admin-stats`: Returns enriched expense metrics

- [ ] **Step 1: Write the failing test**

```javascript
// tests/expense-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import expensesHandler from '../api/expenses.js';
import adminStatsHandler from '../api/admin-stats.js';
import { redis } from '../api/_lib/redis.js';
import { saveEmployee } from '../api/_lib/expenses.js';

// Setup test employee session
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/expense-api.test.mjs`
Expected: FAIL with Cannot find module `../api/expenses.js`

- [ ] **Step 3: Write minimal implementation**

Create `api/expenses.js`:
```javascript
// api/expenses.js
// Expense management API: submit (employee), list (employee/admin), review (admin).

import {
  saveExpense,
  getExpense,
  getExpenseDoc,
  listExpenses,
  updateExpenseReview,
} from './_lib/expenses.js';
import { validateExpenseInput, validateReviewInput } from './_lib/validation.js';
import {
  applyCors,
  handlePreflight,
  getAdminSession,
  getEmployeeSession,
  requireEmployee,
  requireAdmin,
  str,
  withErrorHandling,
} from './_lib/http.js';

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PATCH, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── GET ──────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const adminEmail = await getAdminSession(req);
    const empSession = await getEmployeeSession(req);

    if (!adminEmail && !empSession) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    // Single document fetch
    if (req.query?.document === '1' || req.query?.document === 'true') {
      const id = str(req.query?.id, 50);
      if (!id) return res.status(400).json({ success: false, error: 'Expense ID required.' });

      const expense = await getExpense(id);
      if (!expense) return res.status(404).json({ success: false, error: 'Expense not found.' });

      // Authorization: Admin or owner employee
      const isOwner = empSession && empSession.employeeId === expense.employeeId;
      if (!adminEmail && !isOwner) {
        return res.status(403).json({ success: false, error: 'Unauthorized to view this document.' });
      }

      const doc = await getExpenseDoc(id);
      if (!doc) return res.status(404).json({ success: false, error: 'No document on file.' });
      return res.status(200).json({ success: true, document: doc });
    }

    // Listing
    if (adminEmail) {
      const expenses = await listExpenses({
        employeeId: req.query?.employeeId ? str(req.query.employeeId, 30).toUpperCase() : undefined,
        month: req.query?.month ? Number(req.query.month) : undefined,
        year: req.query?.year ? Number(req.query.year) : undefined,
        status: req.query?.status ? str(req.query.status, 30) : undefined,
        category: req.query?.category ? str(req.query.category, 50) : undefined,
      });

      let totalClaimed = 0;
      let totalApproved = 0;
      let totalPending = 0;
      let totalRejected = 0;

      for (const e of expenses) {
        totalClaimed += Number(e.claimedAmount) || 0;
        if (e.status === 'Approved' || e.status === 'Partially Approved') {
          totalApproved += Number(e.approvedAmount) || 0;
        } else if (e.status === 'Rejected') {
          totalRejected += Number(e.claimedAmount) || 0;
        } else {
          totalPending += Number(e.claimedAmount) || 0;
        }
      }

      return res.status(200).json({
        success: true,
        expenses,
        total: expenses.length,
        aggregates: {
          totalClaimed: Math.round(totalClaimed * 100) / 100,
          totalApproved: Math.round(totalApproved * 100) / 100,
          totalPending: Math.round(totalPending * 100) / 100,
          totalRejected: Math.round(totalRejected * 100) / 100,
        },
      });
    }

    // Employee sees only their own expenses
    const expenses = await listExpenses({ employeeId: empSession.employeeId });
    return res.status(200).json({ success: true, expenses, total: expenses.length });
  }

  // ── POST ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const empSession = await requireEmployee(req, res);
    if (!empSession) return;

    const validation = validateExpenseInput(req.body || {});
    if (!validation.ok) {
      return res.status(400).json({ success: false, errors: validation.errors, error: validation.errors[0] });
    }

    const { claimedAmount, expenseDate, category, description, docData, docName, docMime } = validation.value;

    const saved = await saveExpense({
      employeeId: empSession.employeeId,
      employeeName: empSession.name,
      claimedAmount,
      expenseDate,
      category,
      description,
      docData,
      docName,
      docMime,
    });

    return res.status(201).json({
      success: true,
      message: 'Expense claim submitted successfully. Status is Pending Approval.',
      expense: saved,
    });
  }

  // ── PATCH ────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const adminEmail = await requireAdmin(req, res);
    if (!adminEmail) return;

    const id = str(req.body?.id, 50);
    if (!id) return res.status(400).json({ success: false, error: 'Expense ID is required.' });

    const target = await getExpense(id);
    if (!target) return res.status(404).json({ success: false, error: 'Expense not found.' });

    const validation = validateReviewInput(req.body || {}, target.claimedAmount);
    if (!validation.ok) {
      return res.status(400).json({ success: false, errors: validation.errors, error: validation.errors[0] });
    }

    const { approvedAmount, status, remark } = validation.value;

    const updated = await updateExpenseReview(id, {
      approvedAmount,
      status,
      reviewedBy: adminEmail,
      adminRemark: remark,
    });

    return res.status(200).json({
      success: true,
      message: `Expense claim updated to ${status}.`,
      expense: updated,
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
}

export default withErrorHandling('ExpensesAPI', handler);
```

Modify `api/admin-stats.js` to add expense metrics:
```javascript
// In api/admin-stats.js:
import { getExpenseSummaryMetrics } from './_lib/expenses.js';

// Inside handler:
const [applications, enquiries, expenses] = await Promise.all([
  countApplications(),
  countEnquiries(),
  getExpenseSummaryMetrics(),
]);

return res.status(200).json({
  applications,
  enquiries,
  expenses,
  checkedAt: new Date().toISOString(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/expense-api.test.mjs`
Expected: PASS (4 tests passed)

- [ ] **Step 5: Commit**

```bash
git add api/expenses.js api/admin-stats.js tests/expense-api.test.mjs
git commit -m "feat(expenses): add expenses submission, review API, and admin stats integration"
```

---

### Task 6: Client Data Store Extensions (`js/store.js`)

**Files:**
- Modify: `js/store.js`
- Test: `tests/expense-store.test.mjs`

**Interfaces:**
- Produces in `Store`:
  - `getEmployeeSession()`, `setEmployeeSession(session)`, `forgetEmployeeSession()`, `isEmployeeAuthed()`
  - `employeeLogin(username, password)`
  - `employeeLogout()`
  - `submitExpense(expenseData)`
  - `getEmployeeExpenses()`
  - `getExpenseDocument(id)`
  - `getAdminExpenses(filters)`
  - `reviewExpense(id, reviewData)`
  - `getAdminEmployees()`
  - `getEmployeeDetails(employeeId)`
  - `createEmployee(employeeData)`
  - `updateEmployeeStatus(employeeId, status)`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/expense-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../js/store.js';

// Setup browser globals for test environment
global.localStorage = {
  _data: {},
  getItem(k) { return this._data[k] || null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
  clear() { this._data = {}; },
};

test('Store manages employee session correctly', () => {
  const store = new Store();
  assert.equal(store.isEmployeeAuthed(), false);

  const sampleSession = {
    token: 'test-token',
    employeeId: 'BCCI-E501',
    name: 'Test Employee',
    username: 'test.emp',
    expiresIn: 86400,
  };

  store.setEmployeeSession(sampleSession);
  assert.equal(store.isEmployeeAuthed(), true);
  assert.equal(store.getEmployeeSession().employeeId, 'BCCI-E501');

  store.forgetEmployeeSession();
  assert.equal(store.isEmployeeAuthed(), false);
  assert.equal(store.getEmployeeSession(), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/expense-store.test.mjs`
Expected: FAIL with `store.isEmployeeAuthed is not a function`

- [ ] **Step 3: Write minimal implementation**

In `js/store.js`:
Add `EMPLOYEE_SESSION: 'bcci_employee_session'` to `STORAGE_KEYS`.
Support `auth === 'employee'` in `apiCall`.
Add methods for employee authentication, expense claims, admin employee management, and reports.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/expense-store.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add js/store.js tests/expense-store.test.mjs
git commit -m "feat(expenses): add employee session and expense client methods to Store"
```

---

### Task 7: HTML Markup & Styling for Employee & Admin Views (`index.html`)

**Files:**
- Modify: `index.html`
- Modify: `css/style.css`
- Test: `tests/expense-ui.test.mjs`

**Interfaces:**
- Unified Sign-In tab toggle: `#signinTabAdmin` & `#signinTabEmployee`, `#formAdminSignIn` & `#formEmployeeSignIn`
- New view section: `#view-employee` (`.view-page`, `style="display: none;"`)
- New admin tabs in `#view-admin`:
  - Menu items: `[data-tab="expenses"]`, `[data-tab="employees"]`, `[data-tab="expense-reports"]`
  - Panes: `#tab-expenses`, `#tab-employees`, `#tab-expense-reports`
  - Metrics: `#metricExpensesTotal`, `#metricExpensesClaimed`, `#metricExpensesApproved`, `#metricExpensesPending`, `#metricExpensesEmployees`
- Modals: `#expenseReviewModal`, `#addEmployeeModal`, `#employeeHistoryModal`, `#receiptViewModal`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/expense-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html includes unified sign-in tabs for admin and employee', () => {
  assert.ok(HTML.includes('id="signinTabAdmin"'));
  assert.ok(HTML.includes('id="signinTabEmployee"'));
  assert.ok(HTML.includes('id="formEmployeeSignIn"'));
});

test('index.html includes #view-employee section with form and history table', () => {
  assert.ok(HTML.includes('id="view-employee"'));
  assert.ok(HTML.includes('id="employeeExpenseForm"'));
  assert.ok(HTML.includes('id="expenseReceiptInput"'));
  assert.ok(HTML.includes('id="employeeExpensesBody"'));
});

test('index.html includes admin tabs for expenses, employees, and reports', () => {
  assert.ok(HTML.includes('data-tab="expenses"'));
  assert.ok(HTML.includes('data-tab="employees"'));
  assert.ok(HTML.includes('data-tab="expense-reports"'));
  assert.ok(HTML.includes('id="tab-expenses"'));
  assert.ok(HTML.includes('id="tab-employees"'));
  assert.ok(HTML.includes('id="tab-expense-reports"'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/expense-ui.test.mjs`
Expected: FAIL with missing elements

- [ ] **Step 3: Write minimal implementation**

In `index.html`:
1. In `#view-signin`: Add tab toggle between Secretariat Sign In and Employee Sign In.
2. Add `<div id="view-employee" class="view-page" style="display: none;">` with:
   - `#employeeAuthGate`
   - `#employeePortalContent`:
     - Employee header with ID badge, name, sign-out button
     - KPI cards (Claimed, Approved, Pending, Rejected)
     - Expense submission card with inputs and drag-and-drop dropzone
     - "My Submitted Expenses" table and mobile cards
3. In `#view-admin`:
   - Add sidebar menu items `expenses`, `employees`, `expense-reports`
   - Add metrics cards for expenses
   - Add panes `#tab-expenses`, `#tab-employees`, `#tab-expense-reports`
   - Add Review Modal, Add Employee Modal, Employee History Modal, and Receipt Viewer Modal.
In `css/style.css`:
Add styles for employee banner, status badges, dropzones, and document preview modals reusing existing design variables.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/expense-ui.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add index.html css/style.css tests/expense-ui.test.mjs
git commit -m "feat(expenses): add markup and styling for employee and admin expense views"
```

---

### Task 8: Client Application Logic (`js/app.js`)

**Files:**
- Modify: `js/app.js`
- Test: `tests/expense-client.test.mjs`

**Interfaces:**
- Add `'employee'` to `VIEW_PATHS` and `PAGE_TITLES`
- Wire up:
  - Unified sign-in tab switching
  - Employee sign-in and sign-out handlers
  - Employee dashboard rendering and claim submission
  - Drag-and-drop file upload with preview (PDF badge or image thumbnail)
  - Admin tab switching to `expenses`, `employees`, `expense-reports`
  - Admin expense review modal with document preview and manual approval validation
  - Admin employee management (+ Add Employee, Deactivate confirmation, View History)
  - Admin monthly reporting filters

- [ ] **Step 1: Write the failing test**

```javascript
// tests/expense-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP_JS = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('app.js includes employee in VIEW_PATHS and PAGE_TITLES', () => {
  assert.ok(/employee:\s*['"]\/employee['"]/.test(APP_JS));
  assert.ok(/employee:\s*['"][^'"]*Employee Expense Portal/.test(APP_JS));
});

test('app.js contains reviewExpense and handleApproveExpense handlers', () => {
  assert.ok(APP_JS.includes('renderEmployeePortal'));
  assert.ok(APP_JS.includes('handleReviewExpense'));
  assert.ok(APP_JS.includes('handleAddEmployee'));
  assert.ok(APP_JS.includes('renderMonthlyExpenseReports'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/expense-client.test.mjs`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

In `js/app.js`:
- Add route mappings:
  ```javascript
  employee: '/employee',
  ```
  ```javascript
  employee: 'Employee Expense Portal — BCCI Bharuch',
  ```
- Implement:
  - `setupUnifiedSignInTabs()`
  - `handleEmployeeSignIn()` / `handleEmployeeSignOut()`
  - `renderEmployeePortal()`
  - `setupExpenseFileUploadHandlers()`
  - `handleExpenseSubmit()`
  - `renderAdminExpensesTab()`
  - `openExpenseReviewModal(id)`
  - `handleReviewDecision(id, decision)`
  - `renderAdminEmployeesTab()`
  - `openAddEmployeeModal()` / `handleCreateEmployee()`
  - `openEmployeeHistoryModal(employeeId)`
  - `handleToggleEmployeeStatus(employeeId)`
  - `renderMonthlyExpenseReports()`
  - Document viewing helper: `openReceiptViewer(expenseId)` supporting lightbox image and interactive PDF preview + "Open in New Tab".

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/expense-client.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add js/app.js tests/expense-client.test.mjs
git commit -m "feat(expenses): wire client routing, submission, review, and report logic"
```

---

### Task 9: End-to-End Workflow Verification, Security Isolation & Regression Testing

**Files:**
- Create: `tests/expense-e2e.test.mjs`
- Modify: `package.json`

**Interfaces:**
- End-to-End test walking the entire workflow:
  1. Admin adds Employee
  2. Employee logs in
  3. Employee submits expense with receipt document
  4. Employee checks status (Pending Approval)
  5. Admin views claim & inspects document
  6. Admin partially approves claim (₹1000 claimed -> ₹800 approved) with remark
  7. Employee views updated status and approved amount
  8. Security tests: Employee B cannot access Employee A claim or document; Employee cannot call admin review or employee creation APIs; Client cannot approve higher than claimed amount
  9. Admin views employee history and monthly totals
  10. Admin soft-deactivates employee; employee login rejected; historical expenses preserved
- Full regression check running `npm test` verifying 0 regressions in any existing suite.

- [ ] **Step 1: Write the end-to-end integration test**

```javascript
// tests/expense-e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { redis } from '../api/_lib/redis.js';
import employeeAuthHandler from '../api/employee-auth.js';
import employeesHandler from '../api/employees.js';
import expensesHandler from '../api/expenses.js';

// Complete end-to-end workflow verification
test('Complete Employee Expense Management lifecycle and security checks', async () => {
  const ADMIN_TOKEN = 'e2e-admin-token';
  await redis.set(`admin:${ADMIN_TOKEN}`, 'admin@bccibharuch.in');

  const mockRes = () => {
    return {
      statusCode: 200,
      headers: {},
      body: null,
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k] = v; return this; },
      json(b) { this.body = b; return this; },
      end() { return this; },
    };
  };

  // 1. Admin creates Employee
  const createEmpReq = {
    method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: {
      name: 'Priya Sharma',
      employeeId: 'BCCI-E999',
      username: 'priya.s',
      password: 'StrongPassword999!',
      email: 'priya@example.com',
      status: 'active',
    },
  };
  const createEmpRes = mockRes();
  await employeesHandler(createEmpReq, createEmpRes);
  assert.equal(createEmpRes.statusCode, 201);

  // 2. Employee Priya logs in
  const loginReq = {
    method: 'POST',
    headers: { host: 'localhost' },
    body: { action: 'login', username: 'priya.s', password: 'StrongPassword999!' },
  };
  const loginRes = mockRes();
  await employeeAuthHandler(loginReq, loginRes);
  assert.equal(loginRes.statusCode, 200);
  const priyaToken = loginRes.body.session.token;
  assert.ok(priyaToken);

  // 3. Priya submits expense
  const submitReq = {
    method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${priyaToken}` },
    body: {
      claimedAmount: 1200,
      expenseDate: '2026-09-06',
      category: 'Supplies',
      description: 'Office stationery and presentation materials',
      docData: 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDM',
      docName: 'stationery_bill.pdf',
    },
  };
  const submitRes = mockRes();
  await expensesHandler(submitReq, submitRes);
  assert.equal(submitRes.statusCode, 201);
  const expenseId = submitRes.body.expense.id;
  assert.equal(submitRes.body.expense.status, 'Pending Approval');

  // 4. Admin reviews and inspects document
  const docReq = {
    method: 'GET',
    headers: { host: 'localhost', authorization: `Bearer ${ADMIN_TOKEN}` },
    query: { id: expenseId, document: '1' },
  };
  const docRes = mockRes();
  await expensesHandler(docReq, docRes);
  assert.equal(docRes.statusCode, 200);
  assert.ok(docRes.body.document.docData);

  // 5. Admin partially approves (Claimed ₹1200 -> Approved ₹1000)
  const reviewReq = {
    method: 'PATCH',
    headers: { host: 'localhost', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: {
      id: expenseId,
      decision: 'partially_approve',
      approvedAmount: 1000,
      remark: 'Approved ₹1000, ₹200 excluded for non-reimbursable personal item',
    },
  };
  const reviewRes = mockRes();
  await expensesHandler(reviewReq, reviewRes);
  assert.equal(reviewRes.statusCode, 200);
  assert.equal(reviewRes.body.expense.status, 'Partially Approved');
  assert.equal(reviewRes.body.expense.approvedAmount, 1000);

  // 6. Security Check: Priya cannot call admin review
  const unauthorizedReviewReq = {
    method: 'PATCH',
    headers: { host: 'localhost', authorization: `Bearer ${priyaToken}` },
    body: { id: expenseId, decision: 'approve', approvedAmount: 1200 },
  };
  const unauthorizedReviewRes = mockRes();
  await expensesHandler(unauthorizedReviewReq, unauthorizedReviewRes);
  assert.equal(unauthorizedReviewRes.statusCode, 401);

  // 7. Security Check: Admin cannot approve amount greater than claimed
  const overApprovalReq = {
    method: 'PATCH',
    headers: { host: 'localhost', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: { id: expenseId, decision: 'approve', approvedAmount: 1500 },
  };
  const overApprovalRes = mockRes();
  await expensesHandler(overApprovalReq, overApprovalRes);
  assert.equal(overApprovalRes.statusCode, 400);

  // 8. Admin soft-deactivates Priya
  const deactivateReq = {
    method: 'PATCH',
    headers: { host: 'localhost', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: { employeeId: 'BCCI-E999', status: 'inactive' },
  };
  const deactivateRes = mockRes();
  await employeesHandler(deactivateReq, deactivateRes);
  assert.equal(deactivateRes.statusCode, 200);

  // 9. Priya cannot log in anymore
  const blockedLoginRes = mockRes();
  await employeeAuthHandler(loginReq, blockedLoginRes);
  assert.equal(blockedLoginRes.statusCode, 403);

  // 10. Historical expenses remain intact and accessible to Admin
  const historyReq = {
    method: 'GET',
    headers: { host: 'localhost', authorization: `Bearer ${ADMIN_TOKEN}` },
    query: { id: 'BCCI-E999' },
  };
  const historyRes = mockRes();
  await employeesHandler(historyReq, historyRes);
  assert.equal(historyRes.statusCode, 200);
  assert.equal(historyRes.body.employee.status, 'inactive');
  assert.equal(historyRes.body.employee.stats.totalClaims, 1);
  assert.equal(historyRes.body.employee.stats.approvedAmount, 1000);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node tests/expense-e2e.test.mjs`
Expected: PASS

- [ ] **Step 3: Update `package.json` test scripts**

Update `package.json` `"test"` and `"test:expenses"` scripts:
```json
"test:expenses": "node tests/validation.test.mjs && node tests/expense-data.test.mjs && node tests/employee-auth.test.mjs && node tests/employees-api.test.mjs && node tests/expense-api.test.mjs && node tests/expense-store.test.mjs && node tests/expense-ui.test.mjs && node tests/expense-client.test.mjs && node tests/expense-e2e.test.mjs",
"test": "node tests/e2e.test.mjs && node tests/api.test.mjs && node tests/data.test.mjs && node tests/client.test.mjs && node tests/smtp-config.test.mjs && node tests/purge.test.mjs && node tests/applicant-auth.test.mjs && node tests/events-redis.test.mjs && node tests/events-api.test.mjs && npm run test:expenses"
```

- [ ] **Step 4: Run full regression test suite**

Run: `npm test`
Expected: All existing tests + all new expense tests PASS (0 failures)

- [ ] **Step 5: Commit**

```bash
git add tests/expense-e2e.test.mjs package.json
git commit -m "test(expenses): add comprehensive E2E tests and update test suite"
```
