# BCCI Applicant Password Authentication, First-Time OTP Registration, and Forgot Password Flow

**Date:** 2026-09-04  
**Status:** Approved  
**Scope:** Membership Portal Applicant Authentication System  

---

## 1. Overview & Objectives

Currently, the BCCI portal authenticates applicants via email OTP verification only. While lightweight, it requires an OTP dispatch on every return visit. This specification introduces:
1. **Email + Password Login** as the primary authentication mechanism for returning members.
2. **First-Time Registration**: New applicants verify their email with an OTP and set their password simultaneously.
3. **Forgot Password Flow**: Members who forget their password can request a one-time reset code via email, verify it, and define a new password.
4. **Legacy Account Support**: Detects existing applicants in the database who do not have a password yet, prompting them to set one via OTP verification.
5. **Zero Additional Dependencies**: Leverages Node.js built-in `node:crypto` (`scrypt`, `timingSafeEqual`, `randomBytes`) and Upstash Redis.
6. **Host Portability & Compatibility**: Full backward compatibility with Vercel and VPS/Docker environments (`server.js`).

---

## 2. Architecture & Data Model

### 2.1 Redis Key Layout
- **Account Key**: `bcci:account:<email>`  
  - `<email>` is trimmed and lowercased.
  - JSON payload:
    ```json
    {
      "email": "member@example.com",
      "passwordHash": "a1b2c3d4...",
      "salt": "e5f6g7h8...",
      "createdAt": "2026-09-04T10:00:00.000Z",
      "updatedAt": "2026-09-04T10:00:00.000Z"
    }
    ```
- **Reset OTP Key**: `bcci:otp:reset:<email>` (TTL: 600 seconds / 10 minutes).
- **Registration OTP Key**: `bcci:otp:<email>` (reused from existing flow, TTL: 600 seconds).
- **Session Keys**: `applicant:<token>` (TTL: 86400 seconds / 24 hours).

### 2.2 Password Hashing & Verification
- **Hashing**: `node:crypto` `scryptSync(password, salt, 64)`.
- **Salt**: `crypto.randomBytes(16).toString('hex')` (32 hex characters).
- **Verification**: Re-compute `scryptSync` on provided candidate password with stored salt, and compare using `crypto.timingSafeEqual()`.
- **Validation**: Passwords must be at least 8 characters long.

---

## 3. Backend Endpoints (`api/applicant-auth.js`)

Supported methods: `POST, OPTIONS`.

### 3.1 `action: "login"`
- **Payload**: `{ action: "login", email, password }`
- **Rate Limits**:
  - Max 10 attempts per 15 minutes per IP (`bcci:rl:applicantlogin:ip:<ip>`).
  - Max 10 attempts per 15 minutes per email (`bcci:rl:applicantlogin:email:<email>`).
- **Flow**:
  1. Validate email format and ensure password is provided.
  2. Check rate limit.
  3. Fetch `bcci:account:<email>`.
  4. If account does not exist or has no `passwordHash`:
     - Check `bcci:app_email:<email>` to see if a legacy application exists.
     - Return HTTP 400 with `{ success: false, code: "PASSWORD_NOT_SET", error: "No password set for this account yet. Please register or reset password using OTP." }`.
  5. Verify candidate password against `passwordHash` and `salt` via timing-safe comparison.
  6. On failure: return HTTP 401 `{ success: false, error: "Invalid email or password." }`.
  7. On success:
     - Generate session token `crypto.randomUUID()`.
     - Store session in Redis `applicant:<token>` with 24h TTL.
     - Return HTTP 200 `{ success: true, session: { token, email, expiresIn: 86400 } }`.

### 3.2 `action: "register"`
- **Payload**: `{ action: "register", email, code, password }`
- **Flow**:
  1. Validate email, OTP code format, and password length (>= 8 chars).
  2. Verify OTP against `bcci:otp:<email>`.
  3. Hash password using `scryptSync` with a fresh 16-byte salt.
  4. Store account in Redis `bcci:account:<email>`.
  5. Delete `bcci:otp:<email>` and related attempt rate limits.
  6. Issue session token `applicant:<token>` (24h TTL).
  7. Return HTTP 201 `{ success: true, message: "Account created successfully.", session: { token, email, expiresIn: 86400 } }`.

### 3.3 `action: "forgot-password-request"`
- **Payload**: `{ action: "forgot-password-request", email }`
- **Flow**:
  1. Validate email.
  2. Rate limit: 1 request per minute per email, max 10/day per email, 20/hr per IP.
  3. Generate 6-digit random code.
  4. Store in Redis `bcci:otp:reset:<email>` (TTL: 600s).
  5. Send email via `sendRaw()` with subject *"BCCI Password Reset Code"*.
  6. Return HTTP 200 `{ success: true, message: "Password reset code sent to your email." }`.

### 3.4 `action: "reset-password"`
- **Payload**: `{ action: "reset-password", email, code, newPassword }`
- **Flow**:
  1. Validate email, code, and new password (>= 8 chars).
  2. Rate limit verification attempts (max 5 attempts before invalidating code).
  3. Verify code against `bcci:otp:reset:<email>`.
  4. Hash new password with fresh salt.
  5. Upsert `bcci:account:<email>`.
  6. Delete `bcci:otp:reset:<email>`.
  7. Issue 24h session token `applicant:<token>`.
  8. Return HTTP 200 `{ success: true, message: "Password reset successful.", session: { token, email, expiresIn: 86400 } }`.

---

## 4. Frontend UI / UX (`index.html`, `js/app.js`, `js/store.js`)

### 4.1 Views in Membership Section (`#view-membership`)
The authentication card renders three clean sub-views:
1. **Sign In Mode (Default)**:
   - Inputs: Business Email, Password (with eye toggle icon).
   - Action: "Sign In" button.
   - Secondary links:
     - *"First time? Register with OTP & set password"*
     - *"Forgot password?"*
   - Inline alert: If `PASSWORD_NOT_SET` is returned, automatically offers to redirect the user to OTP registration/reset.
2. **Register Mode**:
   - Step 1: Business Email input + "Send OTP" button.
   - Step 2: 6-digit OTP input, "Create Password" (min 8 chars), "Confirm Password".
   - Action: "Verify & Create Account" button.
   - Secondary link: *"Already have an account? Sign In"*.
3. **Forgot Password Mode**:
   - Step 1: Business Email input + "Send Reset Code" button.
   - Step 2: 6-digit OTP input, "New Password", "Confirm New Password".
   - Action: "Reset Password & Sign In" button.
   - Secondary link: *"Back to Sign In"*.

### 4.2 Data Store Enhancements (`js/store.js`)
- `applicantLogin(email, password)`
- `applicantRegister(email, code, password)`
- `applicantForgotPasswordRequest(email)`
- `applicantResetPassword(email, code, newPassword)`
- Stores session tokens in `localStorage.setItem('bcci_applicant_session', ...)` maintaining exact schema compatibility with existing app logic.

---

## 5. Testing & Verification Plan

1. **New Automated Suite: `tests/applicant-auth.test.mjs`**:
   - Password hashing and timing-safe equality checks.
   - Login success, bad password failure (401), rate limiting (429).
   - First-time registration with valid and invalid OTP codes.
   - Forgot password request, OTP verification, and password reset.
   - Legacy user scenario (detects existing email without password and prompts appropriately).
2. **Regression Verification**:
   - Run the complete project test suite:
     - `e2e.test.mjs`
     - `api.test.mjs`
     - `data.test.mjs`
     - `client.test.mjs`
     - `smtp-config.test.mjs`
     - `purge.test.mjs`
   - Ensure all 209 original assertions remain green.
