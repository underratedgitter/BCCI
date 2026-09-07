# BCCI Bharuch — Employee Expense Management System Design Specification

- **Date:** 2026-09-07
- **Author:** Antigravity Engineering
- **Status:** Approved / In Review
- **Target Release:** BCCI Bharuch Portal v5.1.0

---

## 1. Executive Summary & Context

The **Bharuch Chamber of Commerce & Industry (BCCI)** membership portal manages public trade services, member registration with OTP and document verification, secretariat application review, and digital membership cards.

This document specifies the integration of an **Employee Expense Management System** into the existing BCCI application. The system enables employees to securely submit business expense claims with receipt documents (PDF, JPG, PNG), track reimbursement statuses, and view final approved amounts and remarks. It provides administrators with a centralized expense review workflow, document inspection, manual approval amount overrides, employee account administration (including soft deactivation), and period reporting.

### NON-NEGOTIABLE RULE #1: Preserve Existing Functionality
Under no circumstances should existing membership applications, applicant authentication, event registration, enquiries, digital membership cards, QR codes, or existing admin portal views be broken, redesigned, or regressed. All additions are modular, backward-compatible, and use the existing application conventions.

---

## 2. Architectural Blueprint

### 2.1 Technology Stack & Conventions
* **Frontend:** Vanilla ES6+ JavaScript, CSS3 with existing CSS custom properties (Navy `#0F2C59`, Gold `#D4AF37`, Slate `#F8FAFC`, Border `#E2E8F0`), Font Awesome 6 icons, modal dialogs, and toasts.
* **Backend:** Node.js ESM (`type: module`), serverless-ready for Vercel functions (`api/*.js`) and standalone Node server (`server.js`).
* **Database:** Upstash Redis with one-record-per-key pattern and sorted-set indices (`zadd`, `zrange`, `mget`).
* **Authentication:** Opaque session tokens stored in Redis with fixed TTLs. Password hashing using `scryptSync` with 16-byte random salts via `api/_lib/accounts.js`.
* **Type Safety & Validation:** Runtime schema validators with JSDoc TypeScript definitions (`@typedef`) following Matt Pocock / TypeScript principles (defense-in-depth, zero unsafe `any`, strict input boundary checks).

---

## 3. Data Model & Storage Layout

### 3.1 Redis Key Layout
All keys follow the established `bcci:` prefix pattern in `api/_lib/redis.js`:

| Key | Type | Description |
|---|---|---|
| `bcci:emp:<id>` | Hash / JSON string | Employee master record |
| `bcci:emp_username:<username>` | String | Maps lowercase username -> employee internal `<id>` |
| `bcci:emp_code:<employeeId>` | String | Maps uppercase employee ID -> employee internal `<id>` |
| `bcci:emp_index` | Sorted Set | All employee IDs scored by `createdAt` timestamp |
| `bcci:employee_session:<token>` | JSON string | Active employee session `{ employeeId, username, name, email }` (24h TTL) |
| `bcci:expense:<id>` | Hash / JSON string | Expense claim metadata and review record |
| `bcci:expense:doc:<id>` | JSON string | Base64 data URI and document metadata (max 1.5MB) |
| `bcci:expense_index` | Sorted Set | All expense IDs scored by `submittedAt` timestamp |
| `bcci:expense_emp:<employeeId>` | Sorted Set | Expense IDs for a specific employee scored by `submittedAt` timestamp |

### 3.2 Schemas

#### Employee Schema
```typescript
interface Employee {
  id: string;             // Internal UUID (e.g. "EMP-UUID")
  employeeId: string;     // Business code (e.g. "BCCI-E101", unique, uppercase)
  name: string;           // Full name (e.g. "Rajesh Parmar")
  username: string;       // Unique login handle (lowercase, alphanumeric)
  email: string | null;   // Contact email (optional, validated format)
  passwordHash: string;   // scrypt hash (64 bytes hex)
  salt: string;           // scrypt salt (16 bytes hex)
  status: 'active' | 'inactive'; // Account status (soft-delete flag)
  createdAt: string;      // ISO 8601 timestamp
  updatedAt: string;      // ISO 8601 timestamp
}
```

#### Expense Schema
```typescript
type ExpenseStatus = 'Pending Approval' | 'Approved' | 'Partially Approved' | 'Rejected';

interface Expense {
  id: string;             // Unique ID (e.g. "EXP-20260907-XXXX")
  employeeId: string;     // Foreign key -> Employee.employeeId
  employeeName: string;   // Snapshot of employee name at submission
  expenseDate: string;    // YYYY-MM-DD (cannot be future date)
  category: 'Travel' | 'Food' | 'Lodging' | 'Supplies' | 'Transport' | 'Client Entertainment' | 'Miscellaneous';
  description: string;    // Purpose / detailed notes (up to 1000 chars)
  claimedAmount: number;  // Positive monetary value entered by employee
  approvedAmount: number | null; // Final approved amount (null while pending, 0 if rejected)
  status: ExpenseStatus;  // Current status
  hasDoc: boolean;        // True if receipt document attached
  docMime: string;        // 'application/pdf' | 'image/png' | 'image/jpeg'
  docName: string;        // Sanitized original filename
  docSize: number;        // File size in bytes (capped at 1.5MB)
  submittedAt: string;    // ISO 8601 timestamp
  reviewedAt: string | null; // ISO 8601 timestamp of review
  reviewedBy: string | null; // Admin username/email who reviewed
  adminRemark: string | null;// Feedback, approval notes, or rejection reason
}

interface ExpenseDocument {
  expenseId: string;      // Foreign key -> Expense.id
  docData: string;        // Data URI: "data:<mime>;base64,<encoded>"
  mimeType: string;       // 'application/pdf' | 'image/png' | 'image/jpeg'
  fileName: string;       // Original filename
  fileSize: number;       // Size in bytes
}
```

---

## 4. Backend APIs & Role-Based Authorization

### 4.1 Authentication & Session Helper (`api/_lib/http.js` & `api/_lib/security.js`)
* Add `getEmployeeSession(req)`: Reads `Authorization: Bearer <token>`, looks up `bcci:employee_session:<token>`, returns employee payload or `null`.
* Add `requireEmployee(req, res)`: Returns employee session or halts with 401.

### 4.2 API Route Specifications

#### A. Employee Authentication (`api/employee-auth.js`)
* `POST { action: 'login', username, password }`:
  * Validates credentials against `bcci:emp_username:<username>`.
  * Verifies `status === 'active'`. If inactive, returns `403 Forbidden` (`"Your account has been deactivated. Please contact administration."`).
  * Rate limited to 10 attempts per 15 minutes per IP/username.
  * Generates random UUID session token, stores in `bcci:employee_session:<token>` (TTL 24 hours).
  * Returns `{ success: true, session: { token, employeeId, name, username } }`.
* `DELETE`:
  * Invalidate active session token.
* `GET`:
  * Returns `{ success: true, employee }` for active token.

#### B. Employee Management (`api/employees.js`) — Admin Only
* `GET /api/employees`:
  * Protected by `requireAdmin`.
  * Returns all employees from `bcci:emp_index`.
  * Enriched with summary aggregations: `totalClaims`, `totalApprovedAmount`.
* `GET /api/employees?id=<employeeId>`:
  * Returns single employee details along with their complete historical claims list and totals (`totalClaims`, `claimedAmount`, `approvedAmount`, `rejectedAmount`, `pendingAmount`).
* `POST /api/employees`:
  * Protected by `requireAdmin`.
  * Body: `{ name, employeeId, username, password, email, status }`.
  * Validates:
    * `username`: alphanumeric/hyphens/underscores, 3–30 chars, lowercase, unique.
    * `employeeId`: alphanumeric/hyphens, 2–20 chars, uppercase, unique.
    * `password`: min 8 chars.
  * Hashes password via `hashPassword(password)`.
  * Saves to `bcci:emp:<id>`, sets index and lookup keys.
* `PATCH /api/employees`:
  * Protected by `requireAdmin`.
  * Body: `{ id, status }`.
  * Soft-delete toggle (`active` / `inactive`). **Never deletes historical expense records.**

#### C. Expenses Management (`api/expenses.js`)
* `POST /api/expenses`:
  * Protected by `requireEmployee`.
  * Body: `{ claimedAmount, expenseDate, category, description, docData, docName, docMime }`.
  * Validations:
    * `claimedAmount`: positive finite number, <= 10,000,000, rounded to 2 decimal places.
    * `expenseDate`: valid ISO date string <= current date.
    * `category`: one of allowed enum values.
    * `description`: required, max 1000 chars.
    * `docData`: required base64 data URI matching PDF or JPEG/PNG, payload size <= 1.5MB.
  * Creates expense record with status `'Pending Approval'`, `approvedAmount = null`.
  * Stores document in `bcci:expense:doc:<id>`.
  * Adds to `bcci:expense_index` and `bcci:expense_emp:<employeeId>`.
* `GET /api/expenses`:
  * If **Admin**:
    * Accepts query filters: `employeeId`, `month` (1–12), `year` (YYYY), `status`, `category`.
    * Returns filtered expenses and summary aggregates (`totalClaimed`, `totalApproved`, `totalPending`, `totalRejected`).
  * If **Employee**:
    * Strictly filters expenses by the authenticated employee's `employeeId`.
    * Blocks access to any other employee's expenses.
* `GET /api/expenses?id=<id>&document=1`:
  * Checks authorization: Caller must be Admin OR the employee who submitted the claim.
  * Returns `{ success: true, document: { docData, mimeType, fileName } }`.
* `PATCH /api/expenses`:
  * Protected by `requireAdmin`.
  * Body: `{ id, action: 'review', decision, approvedAmount, remark }`.
  * **CRITICAL AMOUNT RULE ENFORCEMENT**:
    * The server validates `approvedAmount`:
      * Must be a valid numeric value >= 0.
      * Cannot exceed `claimedAmount`.
      * Cannot be negative.
    * If `decision === 'approve'`:
      * If `approvedAmount === claimedAmount`: status set to `'Approved'`.
      * If `0 < approvedAmount < claimedAmount`: status set to `'Partially Approved'`.
    * If `decision === 'reject'`:
      * `approvedAmount` forced to `0`.
      * Status set to `'Rejected'`.
      * `remark` is required (minimum 3 characters).
    * Audit trail fields set: `reviewedAt = new Date().toISOString()`, `reviewedBy = adminEmail`, `adminRemark = remark`.

#### D. Admin Dashboard Stats Enhancement (`api/admin-stats.js`)
* Extends response with:
  ```json
  "expenses": {
    "totalExpenses": 42,
    "totalClaimed": 125000,
    "totalApproved": 112500,
    "pendingApprovals": 3,
    "rejectedExpenses": 2,
    "totalEmployees": 8
  }
  ```
  Existing `applications` and `enquiries` metrics remain unchanged.

---

## 5. Frontend Integration & User Interface

### 5.1 Unified Sign-In (`/signin`)
* Add tabbed toggle on sign-in card:
  * `[ Secretariat Admin ]` | `[ Employee Login ]`
  * Tab state persists during session. Secretariat login retains all existing behavior, rate limits, and shortcuts (`Ctrl+Shift+A`).
  * Employee form asks for **Username** and **Password**. On success, redirects to `/employee`.

### 5.2 Employee Portal (`/employee`)
* Route added to `VIEW_PATHS` and `PAGE_TITLES`.
* Unauthenticated state shows Employee Login form.
* Authenticated state displays:
  1. **Employee Banner:** Employee Name, Badge with Employee ID, and "Sign Out" button.
  2. **Employee KPI Metrics:** Total Claimed, Total Approved, Pending Claims, Rejected Claims.
  3. **Add Expense Claim Card:**
     * Form inputs: Claimed Amount (with ₹ prefix), Date (defaults to today), Category dropdown, Description textarea.
     * Upload Dropzone: Drag-and-drop or click-to-upload. Validates PDF/JPG/PNG up to 1.5MB. Instant preview with thumbnail (image) or PDF badge, file size, and remove button.
     * Status indicator upon submission: "Claim submitted — Status: Pending Approval".
  4. **My Submitted Expenses List:**
     * Desktop table & mobile cards.
     * Displays: Expense ID, Date, Category, Description, Claimed Amount, Approved Amount, Status Badge, Admin Remark, View Receipt button.
     * View Receipt modal with lightbox or embedded PDF and "Open in New Tab" link.

### 5.3 Admin Portal Integrations (`/admin`)
* **Admin Navigation Sidebar:**
  * Add 3 new tabs below existing tabs:
    * `Expense Management` (icon: `fa-receipt`, data-tab: `expenses`)
    * `Employee Management` (icon: `fa-users-cog`, data-tab: `employees`)
    * `Monthly Reports` (icon: `fa-chart-line`, data-tab: `expense-reports`)
* **Admin Metrics Bar:**
  * Add metric cards for Expenses (Total Expenses, Claimed ₹, Approved ₹, Pending Approvals, Total Employees). Clicking navigates directly to the relevant tab.
* **Tab 1: Expense Management (`#tab-expenses`):**
  * Filter controls: Status dropdown (All, Pending, Approved, Partially Approved, Rejected), Employee dropdown, Category dropdown.
  * Table & mobile cards displaying all expense claims with action button "Review Claim".
  * **Review Claim Modal:**
    * Left/Top: Complete dossier of the claim and document viewer (image lightbox or interactive PDF viewer + "Open in New Tab").
    * Right/Bottom: Review form.
      * Input: **Approved Amount (₹)**. Empty by default; admin must explicitly enter approved amount.
      * Input: **Admin Remarks / Explanation**.
      * Buttons: **Approve Claim**, **Partially Approve**, **Reject Claim**.
* **Tab 2: Employee Management (`#tab-employees`):**
  * Top bar with **+ Add Employee** button.
  * Modal: Add Employee form (Name, Employee ID, Username, Password, Email, Status).
  * Table of employees: ID, Name, Username, Contact, Status (Active/Inactive badge), Total Claims, Total Approved ₹, Added Date, Actions.
  * Action: **View History**: Modal showing complete expense history, totals, and approved amounts for that employee.
  * Action: **Deactivate / Activate**: Confirmation dialog preserving historical data.
* **Tab 3: Monthly Reporting (`#tab-expense-reports`):**
  * Filters: Month, Year, Employee, Category, Status.
  * Period KPIs: Total Claims, Total Claimed Amount, Total Approved Amount, Total Rejected Amount, Total Pending Amount.
  * Itemized breakdown table and CSV export.

---

## 6. Security, Authorization & Error Handling

1. **Horizontal Privilege Escalation Prevention:**
   * An employee's request to `/api/expenses` strictly evaluates the employee ID bound to their session token in Redis. The client cannot forge or pass an arbitrary employee ID to read or alter others' expenses.
2. **Vertical Privilege Escalation Prevention:**
   * All approval endpoints (`PATCH /api/expenses`) and employee management endpoints (`/api/employees`) enforce `requireAdmin`. Any employee attempt to call admin endpoints returns `401 Unauthorized`.
3. **Document Security:**
   * Documents stored in `bcci:expense:doc:<id>` are never publicly accessible. Fetching a document requires a valid session belonging to an Admin or the owning Employee.
4. **Input Sanitization & Validation:**
   * Text inputs sanitized with `esc()` and length-capped with `str()`.
   * Amounts verified as finite positive numbers; decimals rounded to 2 places.
   * File uploads checked for MIME type and signature (`data:application/pdf`, `data:image/jpeg`, `data:image/png`).
5. **Session Safety:**
   * Sessions use cryptographically secure 128-bit random tokens (`crypto.randomUUID()`).
   * Stored in Redis with automatic expiration.

---

## 7. Testing & Regression Strategy

1. **Unit & Data Layer Tests (`tests/expense-data.test.mjs`):**
   * Password hashing & verification for employees.
   * Employee creation, duplicate prevention (username & employeeId), status update.
   * Expense submission, indexing, status transition, document persistence.
   * Aggregations (monthly totals, employee totals).
2. **API Endpoint Tests (`tests/expense-api.test.mjs`):**
   * Employee login (success, wrong password, inactive account, rate limiting).
   * Employee expense submission (valid submission, invalid amount, missing receipt, large receipt).
   * Employee authorization isolation (Employee A cannot view Employee B's expenses).
   * Admin expense review (full approval, partial approval, rejection, validation that approved <= claimed).
   * Admin employee management (add employee, duplicate checks, soft deactivation).
   * Admin monthly reporting filters.
3. **Frontend Integration Tests (`tests/expense-client.test.mjs`):**
   * UI components rendering in `index.html`.
   * Store methods for employee auth, expense submission, admin review.
   * Navigation routes `/employee` and tab switching.
4. **Full Regression Suite:**
   * Execute `npm test` verifying all existing 18+ tests in `e2e.test.mjs`, `api.test.mjs`, `data.test.mjs`, `client.test.mjs`, `applicant-auth.test.mjs`, `events-*.test.mjs`, `purge.test.mjs` continue to pass with 0 failures.

---

## 8. Implementation Steps Sequence
1. Create validation & helper modules: `api/_lib/validation.js` and `api/_lib/expenses.js`.
2. Implement backend APIs: `api/employee-auth.js`, `api/employees.js`, `api/expenses.js`, update `api/admin-stats.js`.
3. Add data & API test suites: `tests/expense-data.test.mjs` and `tests/expense-api.test.mjs`.
4. Update client store: `js/store.js` with employee auth and expense methods.
5. Update UI markup: `index.html` with unified sign-in tabs, `#view-employee`, and admin tabs (`#tab-expenses`, `#tab-employees`, `#tab-expense-reports`).
6. Update application logic: `js/app.js` with routing, event handlers, file dropzone, reviews, modals, and reports.
7. Run all tests and regression verification.
