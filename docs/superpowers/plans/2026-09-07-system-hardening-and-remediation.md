# System Hardening & Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate 13 security, concurrency, session lifecycle, routing, dashboard contract, accessibility, responsive, and infrastructure issues discovered in the BCCI portal audit.

**Architecture:** Harden server-side file signature validation and static routing, enforce atomic Redis concurrency controls, ensure employee session lifecycle security, align dashboard API/UI contracts, fix mobile and accessibility defects, upgrade to Node 22 LTS, and build a browser regression test suite.

**Tech Stack:** Node.js 22 LTS, Upstash Redis, Nodemailer, Vanilla JS (ES Modules), CSS3, Chrome Headless / CDP.

**Spec:** `docs/superpowers/specs/2026-09-07-system-hardening-and-remediation-design.md`

## Global Constraints
- Do not introduce external frontend frameworks (keep vanilla JS and CSS).
- Preserve existing comments and docstrings unrelated to modified code.
- Every API endpoint modification must retain backwards compatibility where expected.
- All tests must run offline with local mock Redis and mock SMTP servers.

---

### Task 1: Server-Side File-Signature Validation, Receipt Isolation & CSP Scoping (Issues 1 & 7)

**Files:**
- Modify: `api/_lib/validation.js`
- Modify: `api/applications.js`
- Modify: `api/_lib/security.js`
- Modify: `vercel.json`
- Modify: `js/app.js`
- Test: `tests/validation.test.mjs`
- Test: `tests/expense-ui.test.mjs`

**Interfaces:**
- Produces: `validateFileSignature(base64Data, allowedMimes)` in `api/_lib/validation.js`
- Consumes: Magic bytes for PDF (`%PDF-`), PNG (`\x89PNG\r\n\x1a\n`), JPEG (`\xff\xd8\xff`), WEBP (`RIFF....WEBP`)

- [ ] **Step 1: Write unit tests for magic byte file signature validation and date validation**
Add tests to `tests/validation.test.mjs` verifying:
1. Valid PDF, PNG, JPEG, WEBP base64 payloads pass `validateFileSignature`.
2. Spoofed files (e.g. text/html or corrupted headers with image MIME) fail.
3. Invalid calendar dates (e.g. `2026-02-31`) fail `validateExpenseInput`.
4. Zero or negative amounts fail `validateExpenseInput`.

- [ ] **Step 2: Run test to verify it fails**
Run: `node tests/validation.test.mjs`
Expected: FAIL due to missing signature checks.

- [ ] **Step 3: Implement `validateFileSignature` and calendar date checks**
Update `api/_lib/validation.js`:
- Add `validateFileSignature(base64Data, allowedMimes)`.
- Decode first 32 bytes from base64 and compare against magic signatures.
- Validate calendar date in `validateExpenseInput` checking `Date.UTC(y, m-1, d)` matches input numbers.
- Reject amounts `<= 0`.

- [ ] **Step 4: Wire signature validation in `api/applications.js` and `api/expenses.js`**
- In `api/applications.js`, validate `body.paymentProof` using `validateFileSignature` if present.
- In `api/_lib/validation.js`, call `validateFileSignature` inside `validateExpenseInput`.

- [ ] **Step 5: Isolate receipt rendering in `js/app.js` and adjust CSP**
- In `js/app.js` (`openReceiptViewer`), set `sandbox="allow-downloads allow-popups"` on the preview iframe without `allow-scripts` or `allow-same-origin`.
- In `api/_lib/security.js` and `vercel.json`, update `frame-src 'none'` to `frame-src 'self' blob: data:`.

- [ ] **Step 6: Run tests and verify they pass**
Run: `node tests/validation.test.mjs && node tests/expense-ui.test.mjs`
Expected: PASS

---

### Task 2: Standalone Path Normalization & Root Asset Paths (Issue 2)

**Files:**
- Modify: `server.js`
- Modify: `index.html`
- Test: `tests/e2e.test.mjs`

**Interfaces:**
- Produces: Normalized static path resolution in `server.js` preventing directory traversal outside `ROOT/dir`.

- [ ] **Step 1: Add failing test for path traversal in `tests/e2e.test.mjs`**
Add requests for:
- `/css/..%2fpackage.json` -> must return 403 or 404 (not 200).
- `/assets/..%2fapi/admin-auth.js` -> must return 403 or 404.
- `/js/..%2f.env.example` -> must return 403 or 404.

- [ ] **Step 2: Run test to verify it fails**
Run: `node tests/e2e.test.mjs`
Expected: FAIL with status 200 returned instead of 403/404.

- [ ] **Step 3: Implement path normalization in `server.js`**
In `server.js`:
- Validate decoded `pathname` segments: reject if any segment equals `'..'`.
- Compute `targetDir = path.resolve(ROOT, segments[0])`.
- Compute `full = path.resolve(ROOT, segments.join(path.sep))`.
- Ensure `full.startsWith(targetDir + path.sep)`. If not, reject with 403/404.

- [ ] **Step 4: Update relative asset links in `index.html`**
Update stylesheet, script, and icon URLs to root-relative paths (`/css/...`, `/js/...`, `/assets/...`) or add `<base href="/" />`.

- [ ] **Step 5: Run tests and verify they pass**
Run: `node tests/e2e.test.mjs`
Expected: PASS

---

### Task 3: Atomic Event Registration, OTP Consumption & Application Creation (Issue 3)

**Files:**
- Modify: `tests/mock-redis.mjs`
- Modify: `api/_lib/redis.js`
- Modify: `api/events.js`
- Modify: `api/verify-otp.js`
- Modify: `api/applicant-auth.js`
- Modify: `api/applications.js`
- Test: `tests/events-api.test.mjs`
- Test: `tests/applicant-auth.test.mjs`

**Interfaces:**
- Produces: Atomic `registerForEvent` and `putApplication` with uniqueness constraint in `api/_lib/redis.js`.
- Produces: Atomic OTP consumption in `verify-otp.js` and `applicant-auth.js`.

- [ ] **Step 1: Add `GETDEL` support to `tests/mock-redis.mjs`**
Add `GETDEL` command to `tests/mock-redis.mjs` so `redis.getdel(key)` retrieves and atomically deletes the key.

- [ ] **Step 2: Add concurrency tests for OTP, events, and applications**
- In `tests/applicant-auth.test.mjs`, test parallel OTP verification (only 1 can succeed).
- In `tests/events-api.test.mjs`, test parallel registrations at capacity limit.

- [ ] **Step 3: Implement atomic OTP consumption**
In `api/verify-otp.js` and `api/applicant-auth.js`:
- Use `await redis.getdel(key)` (or single-use claim lock) to retrieve and consume the OTP atomically in one call.

- [ ] **Step 4: Implement atomic event registration and confidential link protection**
In `api/_lib/redis.js`:
- Ensure capacity checking, attendee duplicate checking, and registration update occur atomically with a lock or atomic transaction.
In `api/events.js`:
- Redact `venue` link for paid/online events in public `GET /api/events` unless authenticated admin.

- [ ] **Step 5: Implement atomic application creation**
In `api/_lib/redis.js` (`putApplication`):
- Atomically claim `KEYS.appByEmail(email)` using `SET NX`.
- If already claimed, fail or return existing record.

- [ ] **Step 6: Fix concurrent legacy migration wait**
In `api/_lib/redis.js` (`migrateLegacy`):
- If `claimed === null`, poll `KEYS.migrated(marker)` until status is `'done'` (with timeout) rather than returning empty immediately.

- [ ] **Step 7: Run tests to verify they pass**
Run: `node tests/events-api.test.mjs && node tests/applicant-auth.test.mjs && node tests/api.test.mjs`
Expected: PASS

---

### Task 4: Employee Session Invalidation, Renewal Idempotency & Login Bug (Issues 4, 5 & 6)

**Files:**
- Modify: `api/_lib/http.js`
- Modify: `api/employee-auth.js`
- Modify: `api/employees.js`
- Modify: `api/applications.js`
- Modify: `api/_lib/accounts.js`
- Modify: `js/app.js`
- Test: `tests/employee-auth.test.mjs`
- Test: `tests/employees-api.test.mjs`
- Test: `tests/api.test.mjs`

**Interfaces:**
- Produces: Active status validation in `getEmployeeSession`.
- Produces: Idempotent renewal handler in `api/applications.js`.

- [ ] **Step 1: Write tests for deactivated session rejection and renewal idempotency**
- In `tests/employee-auth.test.mjs`, test that after employee status is updated to `inactive`, session check returns 401/403.
- In `tests/api.test.mjs`, test that replaying renewal with same `paymentRef` returns 200 with unchanged `renewalYears`.

- [ ] **Step 2: Run tests to verify they fail**
Run: `node tests/employee-auth.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement employee session revalidation and revocation**
- In `api/_lib/http.js` (`getEmployeeSession`), check `emp.status === 'active'`. If inactive, delete session key and return null.
- In `api/employees.js` (`PATCH`), when deactivating employee, delete active session tokens for that employee.

- [ ] **Step 4: Implement renewal idempotency & payment verification**
In `api/applications.js` (`action === 'renew'`):
- Validate `paymentRef` (min 6 chars).
- Track `app.renewals = app.renewals || []`.
- If `paymentRef` was already processed, return existing application without incrementing `renewalYears`.

- [ ] **Step 5: Fix employee login bug in `js/app.js`**
In `js/app.js` (`setupUnifiedSignInTabs`), wire submit listener to `document.getElementById('empSignInForm')` and call `form.reset()`.

- [ ] **Step 6: Convert scrypt to asynchronous scrypt in `api/_lib/accounts.js`**
Replace `scryptSync` with async `crypto.scrypt` using promisify.

- [ ] **Step 7: Run tests to verify they pass**
Run: `node tests/employee-auth.test.mjs && node tests/employees-api.test.mjs && node tests/api.test.mjs`
Expected: PASS

---

### Task 5: Dashboard Contracts, Dynamic Filtering & Report Pagination (Issues 8 & 9)

**Files:**
- Modify: `api/_lib/expenses.js`
- Modify: `js/app.js`
- Test: `tests/expense-data.test.mjs`
- Test: `tests/expense-api.test.mjs`

**Interfaces:**
- Produces: Filter-before-paginate `listExpenses` in `api/_lib/expenses.js`.
- Produces: Correct metric and filter population in `js/app.js`.

- [ ] **Step 1: Write test for filter-before-paginate in `tests/expense-data.test.mjs`**
Test that `listExpenses({ limit: 2, offset: 0, category: 'Supplies' })` returns matching items even if they are not in the first 2 sorted items.

- [ ] **Step 2: Fix `listExpenses` order of operations**
In `api/_lib/expenses.js`:
- Fetch all candidate IDs from index.
- Fetch and filter records by status, category, year, and month.
- Slice filtered results using `offset` and `offset + limit`.

- [ ] **Step 3: Align dashboard metrics and populate employee filters in `js/app.js`**
- In `js/app.js` (`renderAdminPortal`), map:
  - `metricExpensesTotal` <- `stats.expenses.totalExpenses`
  - `metricExpensesClaimed` <- `stats.expenses.totalClaimed`
  - `metricExpensesApproved` <- `stats.expenses.totalApproved`
  - `metricExpensesPending` <- `stats.expenses.pendingApprovals`
  - `metricExpensesEmployees` <- `stats.expenses.totalEmployees`
- On loading admin portal, fetch employees and populate `#adminExpenseFilterEmp` and `#reportEmpSelect`.

- [ ] **Step 4: Run tests to verify they pass**
Run: `node tests/expense-data.test.mjs && node tests/expense-api.test.mjs`
Expected: PASS

---

### Task 6: UI Submission Locks & Visible Network Error Handling (Issue 10)

**Files:**
- Modify: `js/app.js`
- Modify: `js/store.js`
- Test: `tests/client.test.mjs`

- [ ] **Step 1: Add submission locking to all forms**
In `js/app.js`:
- Add lock guards and button disable states (`btn.disabled = true`, spinner markup) for:
  - `employeeExpenseForm`
  - `empSignInForm`
  - `adminSignInForm`
  - `membershipForm`
  - `eventRegistrationForm`
  - `addEmployeeForm`
  - `reviewExpenseForm`

- [ ] **Step 2: Add visible network error handling**
In `js/app.js`:
- Wrap async calls in `try...catch` blocks.
- Display visible error toasts (`this.showToast(err.message, 'error')`) on failure.
- Ensure draft is cleared on logout.

- [ ] **Step 3: Run client tests**
Run: `node tests/client.test.mjs`
Expected: PASS

---

### Task 7: Responsive Layouts, Accessibility & Contrast (Issue 11)

**Files:**
- Modify: `index.html`
- Modify: `css/styles.css`
- Modify: `css/style.css`
- Modify: `js/app.js`

- [ ] **Step 1: Fix horizontal overflow on mobile viewports**
In `css/styles.css` and `css/style.css`:
- Remove fixed `1451px` widths on admin-sidebar, admin-content, admin-metrics-grid.
- Set `max-width: 100%`, `overflow-x: hidden`, `box-sizing: border-box`.
- Ensure stack layout on `<= 768px` and `<= 375px`.

- [ ] **Step 2: Add mobile table card views / scroll wrappers**
Ensure reports and employee history tables display responsive cards on mobile screens (< 768px).

- [ ] **Step 3: Fix accessibility labels, contrast & ARIA**
- Add `<label for="...">` and `aria-label` to inputs in `index.html`.
- Increase contrast on `.top-bar-badge`, `.stat-label`, `#tabAuthRegister`, `.auth-security-footer`, and metric card labels (contrast >= 4.5:1).
- Synchronize `aria-selected` and `role="tab"` on `#signinTabAdmin` and `#signinTabEmployee`.

- [ ] **Step 4: Implement modal focus trapping and Escape key handling**
Add modal focus trap in `js/app.js` and ensure `Escape` closes the modal cleanly.

---

### Task 8: Node 22 LTS Modernization & Dependency Updates (Issue 12)

**Files:**
- Modify: `Dockerfile`
- Modify: `.github/workflows/tests.yml`
- Modify: `package.json`

- [ ] **Step 1: Update Node version to 22**
- Update `Dockerfile`: `FROM node:22-alpine`.
- Update `.github/workflows/tests.yml`: `node-version: ['22']`.
- Update `package.json`: `"engines": { "node": ">=22.0.0" }`.

- [ ] **Step 2: Update dependencies in package.json**
- Update `@upstash/redis` to `^1.38.4`.
- Run `npm update` and verify `package-lock.json`.

---

### Task 9: Browser Regression Tests & Full System Verification (Issue 13)

**Files:**
- Create: `tests/browser-regression.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Implement browser regression test suite**
Create `tests/browser-regression.test.mjs` using Chrome headless:
1. Employee login via browser without `formEmp.reset` exception.
2. File upload validations (valid accepted, invalid rejected).
3. Concurrent submission handling (OTP single use, event atomic registration).
4. Deactivation session lockout.
5. Report pagination after filtering.
6. Responsive viewports (no overflow at 768px and 375px).
7. Accessibility (ARIA tabs, labels, contrast).

- [ ] **Step 2: Run all test suites**
Run: `npm test && node tests/browser-regression.test.mjs`
Expected: ALL PASS.
