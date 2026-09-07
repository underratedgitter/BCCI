# BCCI Portal System Hardening & Audit Remediation Design

**Date:** 2026-09-07  
**Status:** Approved  
**Scope:** Remediation of 13 audit findings across backend security, API concurrency, session lifecycle, routing, dashboard contracts, accessibility, responsive UI, Node LTS migration, and regression testing.

---

## 1. Executive Summary & Goals
A comprehensive audit (`docs/audits/2026-09-07-evidence.json`) identified 13 critical findings spanning security, concurrency, session management, UI reliability, accessibility, and outdated infrastructure. This document specifies the architectural solution for each finding to ensure full compliance, robust isolation, and long-term maintainability.

---

## 2. Component Architecture & Detailed Solutions

### Issue 1 & Issue 7: File Validation, Isolated Receipt Rendering & CSP Hardening
- **Server-Side Magic Byte Validation:**
  - Create `validateFileSignature(base64Data, claimedMime)` in `api/_lib/validation.js`.
  - Extract base64 payload and decode the first 32 bytes to inspect magic headers:
    - **PDF:** `%PDF-` (`0x25 0x50 0x44 0x46`)
    - **PNG:** `\x89PNG\r\n\x1a\n` (`0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A`)
    - **JPEG:** `\xFF\xD8\xFF`
    - **WEBP:** `RIFF` at offset 0 (`0x52 0x49 0x46 0x46`) and `WEBP` at offset 8 (`0x57 0x45 0x42 0x50`)
  - Reject any payload whose magic bytes do not match the declared MIME type or allowed formats.
  - Enforce calendar date validation in `validateExpenseInput` (reject rolled-over dates like `2026-02-31`).
  - Wire signature validation into `validateExpenseInput` (`api/expenses.js`) and `api/applications.js` (`paymentProof`).
- **Isolated Receipt Rendering:**
  - In `js/app.js` (`openReceiptViewer`), render an isolated metadata card displaying document name, type, size, and a download link.
  - If previewing in an iframe, enforce strict isolation: `sandbox="allow-downloads allow-popups"`.
  - Do NOT include `allow-scripts` or `allow-same-origin`, guaranteeing the framed content runs in a sandboxed unique origin with no access to parent DOM, cookies, `localStorage`, or API endpoints.
- **CSP Adjustment:**
  - In `api/_lib/security.js` and `vercel.json`, update `frame-src` from `'none'` to `'self' blob: data:` specifically to permit sandboxed PDF/image rendering without weakening other directives (`object-src 'none'`, `script-src`, `base-uri 'none'`).

### Issue 2: Standalone Path Normalization & Asset Link Resolution
- **Standalone Path Traversal Prevention:**
  - In `server.js`, validate requested static file paths by verifying that:
    1. No `..` segments exist in decoded pathname segments.
    2. The resolved target `path.resolve(ROOT, segments.join(path.sep))` strictly begins with `path.resolve(ROOT, segments[0]) + path.sep`.
  - Reject any traversal attempts (`/css/..%2fpackage.json`, `/assets/..%2fapi/...`, `/js/..%2f...`) with HTTP 403 / 404.
- **Root-Relative Asset URLs:**
  - In `index.html`, add leading slashes to all local stylesheet, script, and image references (`/css/styles.css`, `/js/app.js`, `/assets/...`) or provide `<base href="/">`.
  - This ensures deep paths like `/verify/:id` and `/card/:id` load resources correctly without returning SPA HTML for scripts.

### Issue 3: Atomic Redis Operations & Concurrency Control
- **Atomic Event Registration:**
  - Implement atomic capacity checking and registration in `api/_lib/redis.js` using a Redis Lua script or atomic key operations.
  - Check current count against capacity and ensure email has not already registered in a single atomic step before updating attendee records and incrementing `registeredCount`.
  - Redact confidential meeting links (`venue`) in `GET /api/events` for paid/online events unless the requester is an authorized admin or verified registrant.
- **Atomic OTP Consumption:**
  - Update `api/verify-otp.js` and `api/applicant-auth.js` to consume OTP tokens atomically via `GETDEL` (falling back to atomic Lua script or single-use claim key).
  - Add `GETDEL` support to `tests/mock-redis.mjs` for local test parity.
- **Atomic Application Creation:**
  - In `api/_lib/redis.js` (`putApplication`) and `api/applications.js`, use `SET KEYS.appByEmail(email) record.id NX` to claim the unique email index atomically.
  - If `SET NX` returns null, abort application creation and return HTTP 409 Conflict.
- **Concurrent Legacy Migration:**
  - In `api/_lib/redis.js` (`migrateLegacy`), if migration is already running (`claimed === false`), wait for the migration to finish (polling with exponential backoff up to 2 seconds) instead of immediately returning empty data.

### Issue 4: Employee Session Invalidation on Deactivation
- **Session Revalidation on Every Request:**
  - In `getEmployeeSession` (`api/_lib/http.js`) and `api/employee-auth.js`, fetch the current employee record using `session.employeeId`.
  - If the employee does not exist or `emp.status !== 'active'`, immediately delete `bcci:employee_session:${token}` and return HTTP 401/403.
- **Immediate Token Revocation on Deactivation:**
  - In `api/employees.js` (`PATCH /api/employees`), when setting status to `'inactive'`, revoke all active sessions for that employee in Redis.

### Issue 5: Idempotent Renewals & Payment Verification
- **Idempotency Tracking:**
  - In `api/applications.js` (`action === 'renew'`), validate that `paymentRef` is at least 6 alphanumeric characters and does not match the initial application `paymentRef`.
  - Store renewal transactions in `app.renewals = [ { paymentRef, renewedAt, years } ]`.
  - If a renewal request with an existing `paymentRef` is received, return HTTP 200 with the existing application state without incrementing `renewalYears` again.

### Issue 6: Employee Browser Login Exception
- **Form Reference Correction:**
  - In `js/app.js` (`setupUnifiedSignInTabs`), target the actual form element `<form id="empSignInForm">` for event listeners and reset calls:
    ```js
    const form = document.getElementById('empSignInForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      ...
      form.reset();
    });
    ```

### Issue 8: Dashboard Contract Alignment & Employee Filters
- **Metrics Contract Alignment:**
  - In `js/app.js` (`renderAdminPortal`), map metrics from `stats.expenses`:
    - `stats.expenses.totalExpenses` -> `metricExpensesTotal`
    - `stats.expenses.totalClaimed` -> `metricExpensesClaimed`
    - `stats.expenses.totalApproved` -> `metricExpensesApproved`
    - `stats.expenses.pendingApprovals` -> `metricExpensesPending`
    - `stats.expenses.totalEmployees` -> `metricExpensesEmployees`
- **Dynamic Employee Filter Population:**
  - On admin portal render, query `this.store.getAdminEmployees()` and populate `#adminExpenseFilterEmp` and `#reportEmpSelect` with options (`<option value="${e.employeeId}">${e.name} (${e.employeeId})</option>`).

### Issue 9: Report Pagination After Filtering
- **Order of Operations in `listExpenses`:**
  - In `api/_lib/expenses.js`, retrieve all relevant record IDs, fetch/filter records by `status`, `category`, `year`, and `month` *first*, and only then apply `offset` and `limit` slicing.

### Issue 10: UI Submission Locks & Network Error Handling
- **Submission Locks:**
  - On submit for expense claims, application forms, event registrations, and employee additions, disable the primary submit button and display a loading spinner (`<i class="fas fa-spinner fa-spin"></i> Submitting...`).
  - Re-enable the button in a `finally` block.
- **Visible Error Handling:**
  - Wrap all API submission promises in `try/catch` blocks.
  - Display explicit error messages using `this.showToast(err.message, 'error')` on network failures or API rejections.
  - Clear sensitive draft storage on user logout.

### Issue 11: Responsive Layouts & Accessibility (WCAG Compliance)
- **Responsive Layout & Overflow:**
  - Replace fixed-width styles in `css/styles.css` and `css/style.css` with fluid containers (`max-width: 100%`, `box-sizing: border-box`, `overflow-x: hidden`).
  - Ensure admin sidebar, menu, and metrics grid stack vertically on viewports `<= 768px` and `<= 375px`.
- **Mobile Tables:**
  - Provide horizontal scroll containers and mobile card list views for report and employee history tables.
- **Labels & Form Accessibility:**
  - Add explicit `<label for="...">` and `aria-label` attributes to `input[name="subject"]`, `select[name="membershipType"]`, `#paymentProofInput`, and all filter selects.
  - Synchronize `role="tab"`, `aria-selected`, and `aria-controls` on auth tabs.
- **Color Contrast:**
  - Update `.top-bar-badge` to `#e2b540` on dark navy.
  - Update `.stat-label`, `#tabAuthRegister`, `.auth-security-footer`, and metric card titles/hints to dark slate `#334155` / `#1E293B` to ensure contrast >= 4.5:1.
- **Modal Focus & Escape:**
  - Implement a focus trap utility in `js/app.js` that focuses the modal on open, confines Tab navigation within the modal, and restores focus upon `Escape` or close.

### Issue 12: Node 22 LTS Modernization & Asynchronous Hashing
- **Node LTS & Dependency Upgrades:**
  - Update `Dockerfile` to `FROM node:22-alpine`.
  - Update `.github/workflows/tests.yml` to Node `22`.
  - Update `package.json` engines to `"node": ">=22.0.0"`.
  - Update `@upstash/redis` to `^1.38.4` and `nodemailer` to latest patch/minor.
- **Asynchronous Password Hashing:**
  - Migrate `scryptSync` in `api/_lib/accounts.js` to asynchronous `crypto.scrypt` using `util.promisify(crypto.scrypt)`.

### Issue 13: Browser-Based Regression Tests
- **Automated Chrome Headless Regression Suite:**
  - Add `tests/browser-regression.test.mjs` running against local mock servers and Chrome headless at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` via WebSocket / DevTools Protocol or puppeteer-core.
  - Test suites:
    1. Authentication: employee login, session persistence, logout.
    2. File uploads: valid PDF/images accepted, invalid/malformed signatures rejected.
    3. Concurrency: atomic OTP consumption, concurrent event registrations without overbooking.
    4. Account deactivation: active sessions immediately rejected upon status change.
    5. Reports & Filters: filter-before-pagination and employee dropdown population.
    6. Responsive & Overflow: verify zero horizontal page overflow at 768px and 375px.
    7. Accessibility: verify ARIA tab states, form labels, and contrast compliance.
