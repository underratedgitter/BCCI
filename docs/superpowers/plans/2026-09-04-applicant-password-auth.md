# Applicant Password Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement email + password authentication for BCCI portal applicants, with first-time email OTP verification, password creation, forgot password recovery via email OTP, and legacy member support.

**Architecture:** Add a secure credential subsystem in `api/_lib/accounts.js` using Node.js built-in `scrypt` hashing with 16-byte random salts and `timingSafeEqual`. Introduce `api/applicant-auth.js` for handling `login`, `register`, `forgot-password-request`, and `reset-password` actions. Upgrade client data store in `js/store.js` and update `index.html` / `js/app.js` with a unified sign-in card supporting Sign In, First-Time Register, and Forgot Password modes.

**Tech Stack:** Node.js (>= 18.0.0), Upstash Redis, Nodemailer, Vanilla JS (ES Modules), HTML5/CSS3.

**Spec:** [`docs/superpowers/specs/2026-09-04-applicant-password-auth-design.md`](docs/superpowers/specs/2026-09-04-applicant-password-auth-design.md)

## Global Constraints
- Node.js runtime >= 18.0.0.
- Zero new npm dependencies; use standard library `node:crypto` for all password hashing and validation.
- Password hashing must use `scryptSync` with a 16-byte random salt and 64-byte key length.
- Password comparison must use `crypto.timingSafeEqual` to avoid timing side-channels.
- Passwords must be at least 8 characters long.
- Keep all existing 209 test assertions across the 6 existing test suites passing without regression.

---

### Task 1: Account & Password Utilities (`api/_lib/accounts.js` & `api/_lib/redis.js`)

**Files:**
- Modify: `api/_lib/redis.js`
- Create: `api/_lib/accounts.js`
- Test: `tests/applicant-auth.test.mjs`

**Interfaces:**
- Produces:
  - `KEYS.account(email)`: returns `bcci:account:<email>`
  - `KEYS.otpReset(email)`: returns `bcci:otp:reset:<email>`
  - `hashPassword(password, salt)`: returns `{ hash: string, salt: string }`
  - `verifyPassword(password, storedHash, salt)`: returns `boolean`
  - `getAccount(email)`: returns `{ email, passwordHash, salt, createdAt, updatedAt } | null`
  - `saveAccount(email, password)`: returns saved account object

- [ ] **Step 1: Write the failing test for password hashing and account storage**

```javascript
// tests/applicant-auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../api/_lib/accounts.js';

test('hashPassword produces distinct salts and hashes', () => {
  const h1 = hashPassword('SuperSecret123');
  const h2 = hashPassword('SuperSecret123');
  assert.notEqual(h1.salt, h2.salt);
  assert.notEqual(h1.hash, h2.hash);
  assert.equal(verifyPassword('SuperSecret123', h1.hash, h1.salt), true);
  assert.equal(verifyPassword('WrongPassword', h1.hash, h1.salt), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/applicant-auth.test.mjs`
Expected: FAIL with "Cannot find module '../api/_lib/accounts.js'"

- [ ] **Step 3: Update `api/_lib/redis.js` with account and reset OTP keys**

Add to `KEYS` in `api/_lib/redis.js`:
```javascript
  account: (email) => `bcci:account:${String(email).trim().toLowerCase()}`,
  otpReset: (email) => `bcci:otp:reset:${String(email).trim().toLowerCase()}`,
```

- [ ] **Step 4: Implement `api/_lib/accounts.js`**

```javascript
// api/_lib/accounts.js
import crypto from 'crypto';
import { redis, KEYS, withRetry } from './redis.js';

export function hashPassword(password, existingSalt = null) {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(candidatePassword, storedHash, salt) {
  if (!candidatePassword || !storedHash || !salt) return false;
  const candidateHash = crypto.scryptSync(candidatePassword, salt, 64).toString('hex');
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function getAccount(email) {
  if (!email) return null;
  const key = KEYS.account(email);
  return withRetry(async () => {
    return await redis.get(key);
  });
}

export async function saveAccount(email, password) {
  const cleanEmail = String(email).trim().toLowerCase();
  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();
  const current = await getAccount(cleanEmail);
  const account = {
    email: cleanEmail,
    passwordHash: hash,
    salt,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  };
  await withRetry(async () => {
    await redis.set(KEYS.account(cleanEmail), account);
  });
  return account;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node tests/applicant-auth.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add api/_lib/redis.js api/_lib/accounts.js tests/applicant-auth.test.mjs
git commit -m "feat(auth): add password hashing and account persistence helpers"
```

---

### Task 2: Backend Auth Endpoint (`api/applicant-auth.js`)

**Files:**
- Create: `api/applicant-auth.js`
- Modify: `package.json`
- Test: `tests/applicant-auth.test.mjs`

**Interfaces:**
- Consumes: `api/_lib/accounts.js`, `api/_lib/redis.js`, `api/_lib/http.js`, `api/_lib/email.js`
- Produces: `POST /api/applicant-auth` with actions:
  - `login` -> `{ success: true, session }` or `{ success: false, code: "PASSWORD_NOT_SET" }`
  - `register` -> `{ success: true, session }`
  - `forgot-password-request` -> `{ success: true, message }`
  - `reset-password` -> `{ success: true, session }`

- [ ] **Step 1: Expand `tests/applicant-auth.test.mjs` to test all 4 API actions**

Add tests using mock redis and handlers to verify:
1. `action: "login"` with wrong credentials (401).
2. `action: "login"` when no password is set for the email (`PASSWORD_NOT_SET` code).
3. `action: "register"` with valid OTP and password creates account and returns 201 + session.
4. `action: "login"` with newly registered credentials returns 200 + session.
5. `action: "forgot-password-request"` dispatches OTP code.
6. `action: "reset-password"` verifies reset OTP and updates password.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/applicant-auth.test.mjs`
Expected: FAIL with "Cannot find module '../api/applicant-auth.js'"

- [ ] **Step 3: Implement `api/applicant-auth.js`**

Handle CORS, method check (`POST`), input parsing, rate limiting, and all 4 actions cleanly wrapped in `withErrorHandling('ApplicantAuth', handler)`.

- [ ] **Step 4: Update `package.json` test scripts**

Include `node tests/applicant-auth.test.mjs` in the `npm test` script.

- [ ] **Step 5: Run tests to verify all pass**

Run: `npm test`
Expected: All 7 suites pass with 0 failures.

- [ ] **Step 6: Commit**

```bash
git add api/applicant-auth.js package.json tests/applicant-auth.test.mjs
git commit -m "feat(api): add applicant-auth endpoint for login, register and reset"
```

---

### Task 3: Client Store Integration (`js/store.js`)

**Files:**
- Modify: `js/store.js`
- Test: `tests/client.test.mjs`

**Interfaces:**
- Consumes: `POST /api/applicant-auth`
- Produces:
  - `store.applicantLogin(email, password)`
  - `store.applicantRegister(email, code, password)`
  - `store.applicantForgotPasswordRequest(email)`
  - `store.applicantResetPassword(email, code, newPassword)`

- [ ] **Step 1: Write tests in `tests/client.test.mjs` for store auth methods**

Add unit tests verifying that store methods invoke `/api/applicant-auth` with the correct payloads and persist session tokens in storage.

- [ ] **Step 2: Run tests to verify failure**

Run: `node tests/client.test.mjs`
Expected: FAIL (methods not defined on Store)

- [ ] **Step 3: Implement store methods in `js/store.js`**

Add `applicantLogin`, `applicantRegister`, `applicantForgotPasswordRequest`, and `applicantResetPassword` to `Store` class.

- [ ] **Step 4: Run tests to verify pass**

Run: `node tests/client.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add js/store.js tests/client.test.mjs
git commit -m "feat(store): add applicant auth methods to Store"
```

---

### Task 4: Frontend UI Redesign (`index.html` & `css/styles.css`)

**Files:**
- Modify: `index.html:680-745`
- Modify: `css/styles.css`
- Test: `tests/client.test.mjs`

**Interfaces:**
- Updates `#view-membership` gate cards:
  - `#authCardSignIn`: Email + Password input, Password Visibility Toggle, "Sign In" button, "First time? Register with OTP" link, "Forgot password?" link, and `#passwordNotSetAlert` banner.
  - `#authCardRegister`: Email input, "Send Code" button, OTP input, Password input, Confirm Password input, "Verify & Register" button, "Back to Sign In" link.
  - `#authCardForgot`: Email input, "Send Reset Code" button, OTP input, New Password input, Confirm New Password input, "Reset Password" button, "Back to Sign In" link.

- [ ] **Step 1: Write static DOM assertions in `tests/client.test.mjs`**

Verify that `index.html` contains:
- Password input with toggle button.
- Mode switching elements for Register and Forgot Password.
- Proper accessibility attributes (`aria-label`, `autocomplete`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/client.test.mjs`
Expected: FAIL

- [ ] **Step 3: Update `index.html` and `css/styles.css`**

Add the markup and styles for the unified auth card with smooth transitions between modes.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/client.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add index.html css/styles.css tests/client.test.mjs
git commit -m "feat(ui): update membership auth UI with sign-in, register, and forgot-password cards"
```

---

### Task 5: Client Application Logic & Event Wiring (`js/app.js`)

**Files:**
- Modify: `js/app.js`
- Test: `tests/client.test.mjs` and `tests/e2e.test.mjs`

**Interfaces:**
- Implements:
  - Mode toggles: `showAuthMode('signin' | 'register' | 'forgot')`
  - Password visibility toggle handlers
  - Sign-in form submission with error handling & legacy prompt
  - Registration form OTP request and submission
  - Forgot password OTP request and reset submission
  - Auto-fill email across modes when toggling

- [ ] **Step 1: Write DOM event and interaction tests in `tests/client.test.mjs`**

Test switching between modes, toggling password visibility, and handling the `PASSWORD_NOT_SET` feedback.

- [ ] **Step 2: Implement handlers in `js/app.js`**

Wire `setupApplicantAuthHandlers()` to:
1. Handle Sign In: call `this.store.applicantLogin(email, password)`. If `PASSWORD_NOT_SET` is returned, show the friendly notification banner with a button to switch to OTP registration.
2. Handle Register: request OTP via `send-otp`, then call `this.store.applicantRegister(email, code, password)`.
3. Handle Forgot Password: call `this.store.applicantForgotPasswordRequest(email)`, then call `this.store.applicantResetPassword(email, code, newPassword)`.
4. Refresh badges and transition to the application view or membership card on successful auth.

- [ ] **Step 3: Run client tests and E2E tests**

Run: `node tests/client.test.mjs && node tests/e2e.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add js/app.js tests/client.test.mjs tests/e2e.test.mjs
git commit -m "feat(client): implement applicant auth modes and event handlers"
```

---

### Task 6: Full Verification & Regression Testing

**Files:**
- Test: `tests/*.test.mjs`

- [ ] **Step 1: Run syntax check**

Run: `npm run check`
Expected: `syntax OK`

- [ ] **Step 2: Run complete test suite**

Run: `npm test`
Expected: All 7 suites pass (100% assertions green).

- [ ] **Step 3: Verify with local sandbox**

Run a sanity check with `node scripts/dev-sandbox.mjs` to ensure the app boots cleanly and logs are healthy.

- [ ] **Step 4: Final commit and cleanup**

```bash
git status
git commit --allow-empty -m "chore(auth): complete applicant password authentication verification"
```
