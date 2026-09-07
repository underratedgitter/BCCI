// tests/expense-data.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockRedis } from './mock-redis.mjs';

const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const {
  saveEmployee,
  getEmployeeById,
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
} = await import('../api/_lib/expenses.js');

test.after(() => {
  mock.server.close();
});

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

  const byId = await getEmployeeById(emp.id);
  assert.equal(byId.id, emp.id);

  const byUser = await getEmployeeByUsername('anil.mehta');
  assert.equal(byUser.employeeId, 'BCCI-E901');

  const byCode = await getEmployeeByCode('BCCI-E901');
  assert.equal(byCode.username, 'anil.mehta');

  const employees = await listEmployees();
  assert.ok(employees.some((e) => e.id === emp.id));

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

  const fetched = await getExpense(expense.id);
  assert.equal(fetched.id, expense.id);

  const doc = await getExpenseDoc(expense.id);
  assert.ok(doc.docData.startsWith('data:image/png;base64,'));

  const list = await listExpenses({ employeeId: 'BCCI-E901' });
  assert.ok(list.some((e) => e.id === expense.id));
  // Verify document is NOT present in list item to keep listing lightweight
  assert.equal(list.find((e) => e.id === expense.id).docData, undefined);

  const byCategory = await listExpenses({ category: 'Food' });
  assert.ok(byCategory.some((e) => e.id === expense.id));

  const byYear = await listExpenses({ year: 2026 });
  assert.ok(byYear.some((e) => e.id === expense.id));
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

  const metrics = await getExpenseSummaryMetrics();
  assert.ok(metrics.totalExpenses >= 2);
  assert.ok(metrics.totalClaimed >= 1450);
  assert.ok(metrics.totalApproved >= 500);
  assert.ok(metrics.totalEmployees >= 1);
});
