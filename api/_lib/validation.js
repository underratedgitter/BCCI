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
