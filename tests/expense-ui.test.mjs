// tests/expense-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html includes unified sign-in tabs for admin and employee', () => {
  assert.ok(HTML.includes('id="signinTabAdmin"'), 'Missing #signinTabAdmin');
  assert.ok(HTML.includes('id="signinTabEmployee"'), 'Missing #signinTabEmployee');
  assert.ok(HTML.includes('id="formAdminSignIn"'), 'Missing #formAdminSignIn');
  assert.ok(HTML.includes('id="pageAdminLoginForm"'), 'Missing #pageAdminLoginForm');
  assert.ok(HTML.includes('id="formEmployeeSignIn"'), 'Missing #formEmployeeSignIn');
  assert.ok(HTML.includes('id="empUsernameInput"'), 'Missing #empUsernameInput');
  assert.ok(HTML.includes('id="empPasswordInput"'), 'Missing #empPasswordInput');
  assert.ok(HTML.includes('id="btnEmpSignIn"'), 'Missing #btnEmpSignIn');
});

test('index.html includes #view-employee section with auth gate, portal, and form', () => {
  assert.ok(HTML.includes('id="view-employee"'), 'Missing #view-employee');
  assert.ok(HTML.includes('id="employeeAuthGate"'), 'Missing #employeeAuthGate');
  assert.ok(HTML.includes('id="employeePortalContent"'), 'Missing #employeePortalContent');
  assert.ok(HTML.includes('id="employeeNameDisplay"'), 'Missing #employeeNameDisplay');
  assert.ok(HTML.includes('id="employeeIdBadge"'), 'Missing #employeeIdBadge');
  assert.ok(HTML.includes('id="btnEmployeeSignOut"'), 'Missing #btnEmployeeSignOut');
  
  // KPI Metrics
  assert.ok(HTML.includes('id="metricEmpClaimed"'), 'Missing #metricEmpClaimed');
  assert.ok(HTML.includes('id="metricEmpApproved"'), 'Missing #metricEmpApproved');
  assert.ok(HTML.includes('id="metricEmpPending"'), 'Missing #metricEmpPending');
  assert.ok(HTML.includes('id="metricEmpRejected"'), 'Missing #metricEmpRejected');

  // Expense Form
  assert.ok(HTML.includes('id="employeeExpenseForm"'), 'Missing #employeeExpenseForm');
  assert.ok(HTML.includes('id="expenseClaimedAmountInput"'), 'Missing #expenseClaimedAmountInput');
  assert.ok(HTML.includes('id="expenseDateInput"'), 'Missing #expenseDateInput');
  assert.ok(HTML.includes('id="expenseCategorySelect"'), 'Missing #expenseCategorySelect');
  assert.ok(HTML.includes('id="expenseDescriptionInput"'), 'Missing #expenseDescriptionInput');
  assert.ok(HTML.includes('id="expenseReceiptDropzone"'), 'Missing #expenseReceiptDropzone');
  assert.ok(HTML.includes('id="expenseReceiptInput"'), 'Missing #expenseReceiptInput');
  assert.ok(HTML.includes('id="expenseReceiptPlaceholder"'), 'Missing #expenseReceiptPlaceholder');
  assert.ok(HTML.includes('id="expenseReceiptPreview"'), 'Missing #expenseReceiptPreview');
  assert.ok(HTML.includes('id="expenseReceiptFileName"'), 'Missing #expenseReceiptFileName');
  assert.ok(HTML.includes('id="removeExpenseReceiptBtn"'), 'Missing #removeExpenseReceiptBtn');
  assert.ok(HTML.includes('id="btnSubmitExpense"'), 'Missing #btnSubmitExpense');

  // History table and mobile cards
  assert.ok(HTML.includes('id="employeeExpensesTable"'), 'Missing #employeeExpensesTable');
  assert.ok(HTML.includes('id="employeeExpensesBody"'), 'Missing #employeeExpensesBody');
  assert.ok(HTML.includes('id="employeeExpensesCards"'), 'Missing #employeeExpensesCards');
});

test('index.html includes admin tabs for expenses, employees, and reports', () => {
  assert.ok(HTML.includes('data-tab="expenses"'), 'Missing data-tab="expenses"');
  assert.ok(HTML.includes('data-tab="employees"'), 'Missing data-tab="employees"');
  assert.ok(HTML.includes('data-tab="expense-reports"'), 'Missing data-tab="expense-reports"');
  
  assert.ok(HTML.includes('id="tab-expenses"'), 'Missing #tab-expenses');
  assert.ok(HTML.includes('id="tab-employees"'), 'Missing #tab-employees');
  assert.ok(HTML.includes('id="tab-expense-reports"'), 'Missing #tab-expense-reports');

  // Admin Expense Metrics
  assert.ok(HTML.includes('id="metricExpensesTotal"'), 'Missing #metricExpensesTotal');
  assert.ok(HTML.includes('id="metricExpensesClaimed"'), 'Missing #metricExpensesClaimed');
  assert.ok(HTML.includes('id="metricExpensesApproved"'), 'Missing #metricExpensesApproved');
  assert.ok(HTML.includes('id="metricExpensesPending"'), 'Missing #metricExpensesPending');
  assert.ok(HTML.includes('id="metricExpensesEmployees"'), 'Missing #metricExpensesEmployees');

  // Tab contents
  assert.ok(HTML.includes('id="adminExpensesBody"'), 'Missing #adminExpensesBody');
  assert.ok(HTML.includes('id="adminExpensesCards"'), 'Missing #adminExpensesCards');
  assert.ok(HTML.includes('id="btnAddEmployee"'), 'Missing #btnAddEmployee');
  assert.ok(HTML.includes('id="adminEmployeesBody"'), 'Missing #adminEmployeesBody');
  assert.ok(HTML.includes('id="adminEmployeesCards"'), 'Missing #adminEmployeesCards');

  // Reports
  assert.ok(HTML.includes('id="reportTotalClaims"'), 'Missing #reportTotalClaims');
  assert.ok(HTML.includes('id="reportClaimedAmount"'), 'Missing #reportClaimedAmount');
  assert.ok(HTML.includes('id="reportApprovedAmount"'), 'Missing #reportApprovedAmount');
  assert.ok(HTML.includes('id="reportRejectedAmount"'), 'Missing #reportRejectedAmount');
  assert.ok(HTML.includes('id="reportPendingAmount"'), 'Missing #reportPendingAmount');
  assert.ok(HTML.includes('id="reportsTableBody"'), 'Missing #reportsTableBody');
});

test('index.html includes modals for review, add employee, history, and receipt view', () => {
  // Review modal
  assert.ok(HTML.includes('id="expenseReviewModal"'), 'Missing #expenseReviewModal');
  assert.ok(HTML.includes('id="reviewApprovedAmountInput"'), 'Missing #reviewApprovedAmountInput');
  assert.ok(HTML.includes('id="reviewAdminRemarkInput"'), 'Missing #reviewAdminRemarkInput');
  assert.ok(HTML.includes('id="btnReviewApprove"'), 'Missing #btnReviewApprove');
  assert.ok(HTML.includes('id="btnReviewPartial"'), 'Missing #btnReviewPartial');
  assert.ok(HTML.includes('id="btnReviewReject"'), 'Missing #btnReviewReject');

  // Add employee modal
  assert.ok(HTML.includes('id="addEmployeeModal"'), 'Missing #addEmployeeModal');
  assert.ok(HTML.includes('id="addEmployeeForm"'), 'Missing #addEmployeeForm');
  assert.ok(HTML.includes('id="addEmpNameInput"'), 'Missing #addEmpNameInput');
  assert.ok(HTML.includes('id="addEmpIdInput"'), 'Missing #addEmpIdInput');
  assert.ok(HTML.includes('id="addEmpUsernameInput"'), 'Missing #addEmpUsernameInput');
  assert.ok(HTML.includes('id="addEmpPasswordInput"'), 'Missing #addEmpPasswordInput');
  assert.ok(HTML.includes('id="addEmpEmailInput"'), 'Missing #addEmpEmailInput');
  assert.ok(HTML.includes('id="addEmpStatusSelect"'), 'Missing #addEmpStatusSelect');

  // Employee history modal
  assert.ok(HTML.includes('id="employeeHistoryModal"'), 'Missing #employeeHistoryModal');
  assert.ok(HTML.includes('id="empHistoryTableBody"'), 'Missing #empHistoryTableBody');

  // Receipt view modal
  assert.ok(HTML.includes('id="receiptViewModal"'), 'Missing #receiptViewModal');
});

test('index.html includes Employee Portal link in footer', () => {
  assert.ok(
    HTML.includes('href="/employee"') && HTML.includes('data-view-nav="employee"'),
    'Missing Employee Portal link in footer'
  );
});

test('css/style.css exists and defines core styles for expense components', () => {
  const cssPath = new URL('../css/style.css', import.meta.url);
  assert.ok(fs.existsSync(cssPath), 'css/style.css must exist');
  const CSS = fs.readFileSync(cssPath, 'utf8');
  assert.ok(CSS.includes('.expense-dropzone') || CSS.includes('dropzone'), 'Missing dropzone style in css/style.css');
  assert.ok(CSS.includes('.badge') || CSS.includes('status'), 'Missing badge/status style in css/style.css');
});
