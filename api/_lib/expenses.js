// api/_lib/expenses.js
// Persistence operations for employees and expense management in Upstash Redis.

import crypto from 'node:crypto';
import { redis, withRetry } from './redis.js';
import { hashPassword, hashPasswordAsync } from './accounts.js';
import { EXPENSE_STATUSES } from './validation.js';

export const EXP_KEYS = {
  emp: (id) => `bcci:emp:${id}`,
  empUsername: (username) => `bcci:emp_username:${String(username || '').trim().toLowerCase()}`,
  empCode: (code) => `bcci:emp_code:${String(code || '').trim().toUpperCase()}`,
  empIndex: 'bcci:emp_index',
  empSession: (token) => `bcci:employee_session:${token}`,

  expense: (id) => `bcci:expense:${id}`,
  expenseDoc: (id) => `bcci:expense:doc:${id}`,
  expenseIndex: 'bcci:expense_index',
  expenseEmp: (empId) => `bcci:expense_emp:${String(empId || '').trim().toUpperCase()}`,
};

export async function saveEmployee(data) {
  if (!data) throw new Error('Employee data is required');
  const username = String(data.username || '').trim().toLowerCase();
  const employeeId = String(data.employeeId || '').trim().toUpperCase();
  const now = new Date().toISOString();

  const id = data.id || `EMP-${crypto.randomUUID()}`;
  const { hash, salt } = data.password
    ? await hashPasswordAsync(data.password)
    : { hash: data.passwordHash, salt: data.salt };

  const record = {
    id,
    employeeId,
    name: String(data.name || '').trim(),
    username,
    email: data.email ? String(data.email).trim().toLowerCase() : null,
    passwordHash: hash,
    salt,
    status: data.status === 'inactive' ? 'inactive' : 'active',
    createdAt: data.createdAt || now,
    updatedAt: now,
  };

  await withRetry(async () => {
    const claimedCode = await redis.set(EXP_KEYS.empCode(employeeId), id, { nx: true });
    if (!claimedCode) {
      const err = new Error(`Employee ID "${employeeId}" is already assigned.`);
      err.statusCode = 409;
      throw err;
    }

    const claimedUsername = await redis.set(EXP_KEYS.empUsername(username), id, { nx: true });
    if (!claimedUsername) {
      await redis.del(EXP_KEYS.empCode(employeeId)).catch(() => {});
      const err = new Error(`Username "${username}" is already taken.`);
      err.statusCode = 409;
      throw err;
    }

    try {
      await redis.set(EXP_KEYS.emp(id), record);
      const score = Date.parse(record.createdAt) || Date.now();
      await redis.zadd(EXP_KEYS.empIndex, { score, member: id });
    } catch (err) {
      await redis.del(EXP_KEYS.empCode(employeeId)).catch(() => {});
      await redis.del(EXP_KEYS.empUsername(username)).catch(() => {});
      throw err;
    }
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
    return rawList.filter(Boolean).map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
  });
}

export async function updateEmployeeStatus(id, status) {
  if (!id) return null;
  return withRetry(async () => {
    const emp = await getEmployeeById(id);
    if (!emp) return null;
    emp.status = status === 'inactive' ? 'inactive' : 'active';
    emp.updatedAt = new Date().toISOString();
    await redis.set(EXP_KEYS.emp(id), emp);
    return emp;
  });
}

export async function saveExpense(data, optionalDocData) {
  if (!data) throw new Error('Expense data is required');
  const now = new Date().toISOString();
  const id = `EXP-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const employeeId = String(data.employeeId || '').trim().toUpperCase();
  const docData = optionalDocData !== undefined ? optionalDocData : data.docData;

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
    hasDoc: Boolean(docData),
    docName: String(data.docName || 'receipt'),
    docMime: String(data.docMime || 'application/octet-stream'),
    docSize: docData ? Buffer.byteLength(docData, 'utf8') : 0,
    submittedAt: now,
    reviewedAt: null,
    reviewedBy: null,
    adminRemark: null,
  };

  await withRetry(async () => {
    await redis.set(EXP_KEYS.expense(id), record);
    if (docData) {
      await redis.set(EXP_KEYS.expenseDoc(id), {
        expenseId: id,
        docData,
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
    const ids = await redis.zrange(key, 0, -1, { rev: true });
    if (!ids || !ids.length) return [];

    let expenses = [];
    const batchSize = 200;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batchIds = ids.slice(i, i + batchSize);
      const rawBatch = await redis.mget(...batchIds.map(EXP_KEYS.expense));
      const parsedBatch = rawBatch.filter(Boolean).map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
      expenses.push(...parsedBatch);
    }

    if (status) {
      expenses = expenses.filter((e) => String(e.status).toLowerCase() === String(status).toLowerCase());
    }
    if (category) {
      expenses = expenses.filter((e) => e.category === category);
    }
    if (year) {
      expenses = expenses.filter((e) => {
        const dateStr = String(e.expenseDate || e.submittedAt || '');
        if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
          return Number(dateStr.slice(0, 4)) === Number(year);
        }
        const d = new Date(dateStr);
        return d.getFullYear() === Number(year) || d.getUTCFullYear() === Number(year);
      });
    }
    if (month) {
      expenses = expenses.filter((e) => {
        const dateStr = String(e.expenseDate || e.submittedAt || '');
        if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
          return Number(dateStr.slice(5, 7)) === Number(month);
        }
        const d = new Date(dateStr);
        return d.getMonth() + 1 === Number(month) || d.getUTCMonth() + 1 === Number(month);
      });
    }

    return expenses.slice(offset, offset + limit);
  });
}

export async function updateExpenseReview(id, { approvedAmount, status, reviewedBy, adminRemark }) {
  if (!id) return null;
  return withRetry(async () => {
    const current = await getExpense(id);
    if (!current) return null;

    const next = {
      ...current,
      approvedAmount: approvedAmount !== undefined && approvedAmount !== null ? Number(approvedAmount) : 0,
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
