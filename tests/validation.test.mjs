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

test('validateEmployeeInput handles update scenarios and edge cases', () => {
  // Update without new password should succeed
  const updateValid = validateEmployeeInput({
    name: 'Rajesh Parmar',
    employeeId: 'BCCI-E101',
    username: 'rajesh.p',
    isUpdate: true,
  });
  assert.equal(updateValid.ok, true);
  assert.equal(updateValid.value.password, '');

  // Update with short password should fail
  const updateShortPass = validateEmployeeInput({
    name: 'Rajesh Parmar',
    employeeId: 'BCCI-E101',
    username: 'rajesh.p',
    password: '123',
    isUpdate: true,
  });
  assert.equal(updateShortPass.ok, false);

  // Invalid email format should fail
  const invalidEmail = validateEmployeeInput({
    name: 'Rajesh Parmar',
    employeeId: 'BCCI-E101',
    username: 'rajesh.p',
    password: 'Password123!',
    email: 'not-an-email',
  });
  assert.equal(invalidEmail.ok, false);
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

test('validateExpenseInput handles edge cases for dates, categories, and documents', () => {
  // Future date
  const future = validateExpenseInput({
    claimedAmount: 100,
    expenseDate: '2099-01-01',
    category: 'Food',
    description: 'Dinner',
    docData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  });
  assert.equal(future.ok, false);

  // Invalid category
  const badCategory = validateExpenseInput({
    claimedAmount: 100,
    expenseDate: '2026-09-01',
    category: 'Cryptocurrency',
    description: 'Invalid category test',
    docData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  });
  assert.equal(badCategory.ok, false);

  // Short description
  const shortDesc = validateExpenseInput({
    claimedAmount: 100,
    expenseDate: '2026-09-01',
    category: 'Food',
    description: 'No',
    docData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  });
  assert.equal(shortDesc.ok, false);

  // Invalid doc format
  const badDoc = validateExpenseInput({
    claimedAmount: 100,
    expenseDate: '2026-09-01',
    category: 'Food',
    description: 'Dinner with client',
    docData: 'data:text/plain;base64,aGVsbG8=',
  });
  assert.equal(badDoc.ok, false);

  // Exceeds max amount
  const tooLarge = validateExpenseInput({
    claimedAmount: 999999999,
    expenseDate: '2026-09-01',
    category: 'Food',
    description: 'Dinner with client',
    docData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  });
  assert.equal(tooLarge.ok, false);
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

  // Full approval
  const fullApprove = validateReviewInput({
    decision: 'approve',
    approvedAmount: 1000,
    remark: 'All receipts verified',
  }, 1000);
  assert.equal(fullApprove.ok, true);
  assert.equal(fullApprove.value.status, 'Approved');

  // Full rejection with remark
  const fullReject = validateReviewInput({
    decision: 'reject',
    remark: 'Duplicate receipt submission',
  }, 1000);
  assert.equal(fullReject.ok, true);
  assert.equal(fullReject.value.status, 'Rejected');
  assert.equal(fullReject.value.approvedAmount, 0);

  // Invalid decision
  const badDecision = validateReviewInput({
    decision: 'maybe',
  }, 1000);
  assert.equal(badDecision.ok, false);

  // Partially approve with 0 amount must fail
  const partialZero = validateReviewInput({
    decision: 'partially_approve',
    approvedAmount: 0,
    remark: 'Approved nothing',
  }, 1000);
  assert.equal(partialZero.ok, false);
});

test('validation functions handle null input gracefully without throwing', () => {
  const emp = validateEmployeeInput(null);
  assert.equal(emp.ok, false);
  assert.ok(emp.errors.length > 0);

  const exp = validateExpenseInput(null);
  assert.equal(exp.ok, false);
  assert.ok(exp.errors.length > 0);

  const rev = validateReviewInput(null);
  assert.equal(rev.ok, false);
  assert.ok(rev.errors.length > 0);
});

