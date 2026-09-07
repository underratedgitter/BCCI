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
  data = data || {};
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

/**
 * Validate that a base64 data URI has magic bytes matching the declared MIME type.
 * Supports PDF, PNG, JPEG, WEBP.
 * @param {string} dataUri - Data URI string, e.g. "data:image/png;base64,..."
 * @param {string[]} [allowedMimes] - Allowed MIME types.
 * @returns {{ ok: boolean, mime?: string, error?: string }}
 */
export function validateFileSignature(dataUri, allowedMimes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp']) {
  if (!dataUri || typeof dataUri !== 'string') {
    return { ok: false, error: 'No file data provided.' };
  }
  const match = dataUri.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    return { ok: false, error: 'Invalid data URI format. Expected base64 encoding.' };
  }
  let mime = match[1].toLowerCase();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  const base64Content = match[2];

  if (allowedMimes && allowedMimes.length) {
    const normAllowed = allowedMimes.map((m) => (m.toLowerCase() === 'image/jpg' ? 'image/jpeg' : m.toLowerCase()));
    if (!normAllowed.includes(mime)) {
      return { ok: false, error: `File type "${mime}" is not permitted.` };
    }
  }

  // Decode first 32 bytes
  let headerBuf;
  try {
    const rawHeader = base64Content.slice(0, 64);
    headerBuf = Buffer.from(rawHeader, 'base64');
  } catch {
    return { ok: false, error: 'Failed to decode base64 file data.' };
  }

  if (headerBuf.length < 4) {
    return { ok: false, error: 'File content is too small or truncated.' };
  }

  // Check magic bytes
  // PDF: %PDF- (0x25 0x50 0x44 0x46)
  const isPdf = headerBuf.length >= 4 &&
    headerBuf[0] === 0x25 && headerBuf[1] === 0x50 && headerBuf[2] === 0x44 && headerBuf[3] === 0x46;

  // PNG: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
  const isPng = headerBuf.length >= 8 &&
    headerBuf[0] === 0x89 && headerBuf[1] === 0x50 && headerBuf[2] === 0x4E && headerBuf[3] === 0x47 &&
    headerBuf[4] === 0x0D && headerBuf[5] === 0x0A && headerBuf[6] === 0x1A && headerBuf[7] === 0x0A;

  // JPEG: 0xFF 0xD8 0xFF
  const isJpg = headerBuf.length >= 3 &&
    headerBuf[0] === 0xFF && headerBuf[1] === 0xD8 && headerBuf[2] === 0xFF;

  // WEBP: RIFF at 0..3 and WEBP at 8..11
  const isWebp = headerBuf.length >= 12 &&
    headerBuf[0] === 0x52 && headerBuf[1] === 0x49 && headerBuf[2] === 0x46 && headerBuf[3] === 0x46 && // RIFF
    headerBuf[8] === 0x57 && headerBuf[9] === 0x45 && headerBuf[10] === 0x42 && headerBuf[11] === 0x50; // WEBP

  if (mime === 'application/pdf' && !isPdf) {
    return { ok: false, error: 'File signature does not match claimed PDF document.' };
  }
  if (mime === 'image/png' && !isPng) {
    return { ok: false, error: 'File signature does not match claimed PNG image.' };
  }
  if (mime === 'image/jpeg' && !isJpg) {
    return { ok: false, error: 'File signature does not match claimed JPEG image.' };
  }
  if (mime === 'image/webp' && !isWebp) {
    return { ok: false, error: 'File signature does not match claimed WEBP image.' };
  }

  if (!isPdf && !isPng && !isJpg && !isWebp) {
    return { ok: false, error: 'Unrecognized file signature. Only valid PDF, PNG, JPG, or WEBP files are allowed.' };
  }

  return { ok: true, mime };
}

export function validateExpenseInput(data = {}) {
  data = data || {};
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
    const [y, m, dNum] = expenseDate.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, dNum));
    if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== dNum) {
      errors.push('Expense date is not a valid calendar date.');
    } else {
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      if (d > today) {
        errors.push('Expense date cannot be in the future.');
      }
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
    const sigCheck = validateFileSignature(docData);
    if (!sigCheck.ok) {
      errors.push(sigCheck.error || 'Uploaded document content does not match its file signature or is corrupted.');
    } else {
      docMime = sigCheck.mime;
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
  data = data || {};
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
      if (['approve', 'partially_approve'].includes(decision) && approvedAmount <= 0) {
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
