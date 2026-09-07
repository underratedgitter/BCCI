import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP_JS = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('app.js includes employee in VIEW_PATHS and PAGE_TITLES', () => {
  assert.ok(/employee:\s*['"]\/employee['"]/.test(APP_JS));
  assert.ok(/employee:\s*['"][^'"]*Employee Expense Portal/.test(APP_JS));
});

test('app.js contains reviewExpense and handleAddEmployee handlers', () => {
  assert.ok(APP_JS.includes('renderEmployeePortal'));
  assert.ok(APP_JS.includes('handleReviewExpense'));
  assert.ok(APP_JS.includes('handleAddEmployee'));
  assert.ok(APP_JS.includes('renderMonthlyExpenseReports'));
});
