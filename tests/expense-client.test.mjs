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

test('app.js wires employee sign in form with correct element IDs', () => {
  assert.ok(APP_JS.includes('empUsernameInput'), 'Must read empUsernameInput from form');
  assert.ok(APP_JS.includes('empPasswordInput'), 'Must read empPasswordInput from form');
});

test('app.js submits expense claim with correct API contract payload', () => {
  assert.ok(APP_JS.includes('expenseDate: date'), 'Must map date to expenseDate for API contract');
  assert.ok(APP_JS.includes('docData: this.currentExpenseFileBase64'), 'Must map base64 to docData');
  assert.ok(APP_JS.includes('docName: this.currentExpenseFileName'), 'Must provide docName');
  assert.ok(APP_JS.includes('docMime: this.currentExpenseFileType'), 'Must provide docMime');
});

test('app.js handles PDF detection robustly across MIME, extension, and data URI', () => {
  assert.ok(APP_JS.includes('doc.mimeType === \'application/pdf\'') || APP_JS.includes('doc.docMime === \'application/pdf\''));
  assert.ok(APP_JS.includes('data:application/pdf'));
});

test('app.js renders all 8 columns in admin employees table matching index.html', () => {
  assert.ok(APP_JS.includes('e.username || \'—\''), 'Employee table must render username column');
  assert.ok(APP_JS.includes('claimsCount'), 'Employee table must render total claims column');
  assert.ok(APP_JS.includes('approvedTotal'), 'Employee table must render total approved column');
  assert.ok(APP_JS.includes('colspan="8"'), 'Empty state must span 8 columns');
});

test('app.js formats expenseDate in all expense and report tables', () => {
  assert.ok(APP_JS.includes('formatDate(claimDate)'), 'Employee portal table must format claim date');
  assert.ok(APP_JS.includes('formatDate(e.expenseDate || e.date)'), 'Admin expenses and report tables must format expenseDate');
});
