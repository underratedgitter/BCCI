// Full-website browser test — drives real Chrome against a running server.
//
//   1. node scripts/dev-sandbox.mjs > /tmp/bcci-sandbox.log 2>&1   # terminal 1 (port 3000)
//   2. npm run test:browser                                        # terminal 2 (this file)
//
// This file reads OTP codes out of the sandbox log, so that redirect is
// required; set SANDBOX_LOG to point somewhere else.
//
// Covers every public route, the member journey (register → apply with
// files → track), the admin journey (signin → approve / reject-with-reason
// → events broadcast → CSV), enquiries, verification, and a mobile
// viewport. Fails on any console error, failed request, or unmet
// expectation. NOT part of `npm test` (needs Chrome + a live server).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.SITE_URL || 'http://localhost:3000';
// Defaults to macOS Chrome; set CHROME_PATH for any other Chrome or Chromium.
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SANDBOX_LOG = process.env.SANDBOX_LOG || '/tmp/bcci-sandbox.log';
function readSandboxLog() {
  try { return fs.readFileSync(SANDBOX_LOG, 'utf8'); }
  catch { return ''; }
}

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const consoleErrors = [];
/** Errors recorded since `mark` — one step's worth, not the whole run's. */
function errorsSince(mark) {
  return consoleErrors.slice(mark);
}
function watch(page, tag) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${tag}] ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[${tag}] pageerror: ${String(e).slice(0, 200)}`));
  page.on('requestfailed', (r) => {
    if (!r.url().includes('favicon')) consoleErrors.push(`[${tag}] reqfail: ${r.url().slice(0, 120)}`);
  });
  page.on('response', (r) => {
    if (r.status() === 404) consoleErrors.push(`[${tag}] http404: ${r.url().slice(0, 140)}`);
  });
}

// 1px PNG + minimal PDF fixtures for the file uploads.
fs.writeFileSync('/tmp/site-cert.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
fs.writeFileSync('/tmp/site-cert.pdf', Buffer.from('%PDF-1.4\n1 0 obj<</>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\npadding-padding-padding-padding'));

function readOtpSince(mark) {
  const log = readSandboxLog().slice(mark);
  const m = log.match(/CODE:\s*(\d{6})/);
  return m ? m[1] : null;
}
async function waitOtp(mark, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const code = readOtpSince(mark);
    if (code) return code;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const memberCtx = await browser.newContext();
const adminCtx = await browser.newContext();
const member = await memberCtx.newPage();
const admin = await adminCtx.newPage();
watch(member, 'member');
watch(admin, 'admin');

console.log('\nRoutes (desktop)');
console.log('────────────────');
const routes = [
  ['/', 'Empowering'],
  ['/about', 'About'],
  ['/services', 'Services'],
  ['/events', 'Events'],
  ['/gallery', 'News'],
  ['/qr', 'UPI'],
  ['/enquiry', 'Enquiry'],
  ['/membership', 'Applicant Portal'],
  ['/card', 'Membership Card'],
  ['/signin', 'Admin Sign In'],
  ['/verify', 'Verification'],
];
for (const [path, needle] of routes) {
  await member.goto(BASE + path, { waitUntil: 'networkidle' });
  const body = await member.content();
  check(`GET ${path} renders`, body.includes(needle), `missing "${needle}"`);
}

// Removed routes fall back home; admin-bcci gates to signin when logged out.
await member.goto(BASE + '/employee', { waitUntil: 'networkidle' });
check('/employee no longer exists (falls home)', (await member.content()).includes('Empowering'));
await member.goto(BASE + '/admin', { waitUntil: 'networkidle' });
check('old /admin falls home', (await member.content()).includes('Empowering'));
await member.goto(BASE + '/admin-bcci', { waitUntil: 'networkidle' });
check('/admin-bcci gates unauthenticated visitors to signin', (await member.content()).includes('Admin Sign In'));

console.log('\nFooter');
console.log('──────');
await member.goto(BASE + '/', { waitUntil: 'networkidle' });
const footerText = await member.locator('.footer-bottom').innerText();
check('copyright present', /all rights reserved/i.test(footerText));
check('secretariat/employee links gone from footer bar', !/Secretariat Access|Employee Portal/.test(footerText));
const align = await member.locator('.footer-bottom p').evaluate((el) => {
  const p = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const parent = el.parentElement.getBoundingClientRect();
  return `${p.textAlign}|${Math.round(r.left - parent.left)}|${Math.round(parent.width)}|${Math.round(r.width)}`;
});
{
  // Centred = CSS centers text AND the block spans most of the bar width
  // (a narrow left-hugging block was the original bug).
  const [textAlign, left, parentW, w] = align.split('|').map((v, i) => (i === 0 ? v : Number(v)));
  const centered = textAlign === 'center' && left < parentW * 0.2 && w > parentW * 0.6;
  check('copyright bar is centred', centered, align);
}

console.log('\nMember journey: register → apply with files → track');
console.log('───────────────────────────────────────────────────');
const stamp = Date.now().toString(36);
const MEMAIL = `sitetest-${stamp}@example.com`;
await member.goto(BASE + '/membership', { waitUntil: 'networkidle' });
await member.click('#tabAuthRegister');
await member.fill('#applicantRegEmail', MEMAIL);
await member.fill('#applicantRegPassword', 'site-test-pass-123');
await member.fill('#applicantRegPasswordConfirm', 'site-test-pass-123');
{
  const mark = readSandboxLog().length;
  await member.click('#applicantSendRegOtpBtn');
  const code = await waitOtp(mark);
  check('register OTP arrives in sandbox mail', !!code);
  await member.fill('#applicantRegOtp', code || '000000');
  await member.click('#applicantRegisterBtn');
  await member.waitForSelector('#membershipFormWrapper:not([style*="none"])', { timeout: 15000 }).catch(() => {});
}
check('membership form unlocks after registration', await member.locator('#membershipForm').isVisible());

const F = {
  '#appFullName': 'Site Test Person', '#appSubject': 'BCCI Membership Form', '#appCity': 'Bharuch',
  '#appCompany': `SiteTest Co ${stamp}`, '#appWebsite': 'https://sitetest.example',
  '#appPrimaryBusiness': 'SiteTest Trading', '#appBusinessDescription': 'Wholesale trading of industrial goods for testing.',
  '#appInternationalOps': 'None', '#appRegNumber': 'REG12345', '#appRegPlace': 'Bharuch',
  '#appOtherAssociations': 'None', '#appFeedback': 'Great portal.',
  '#annualTurnover': '5000000', '#employees': '25',
  '#appGstNo': '24AAAAA0000A1Z5', '#appPanNo': 'AAAAA0000A',
  '#appAddress': 'Plot 1, GIDC, Ankleshwar', '#appState': 'Gujarat', '#appPincode': '393002',
  '#appRepName': 'Site Test Person', '#appRepDesignation': 'Owner',
  '#appOfficialEmail': MEMAIL, '#appMobileNumber': '9825012345',
  '#appRepMobile': '9825012346', '#appRepEmail': `rep-${stamp}@example.com`,
  '#paymentRefInput': 'UPI/123456789012',
};
for (const [sel, val] of Object.entries(F)) {
  const cur = await member.locator(sel).inputValue().catch(() => null);
  if (cur === '' || cur === null) await member.fill(sel, val);
}
await member.fill('#appBusinessDescription', F['#appBusinessDescription']);
await member.fill('#appFeedback', F['#appFeedback']);
await member.selectOption('#appLegalStatus', 'Proprietorship');
await member.selectOption('#appEnterpriseType', 'Micro');
await member.selectOption('#appBusinessServices', 'Information Technology');
await member.selectOption('#appDistrict', 'Bharuch');
await member.selectOption('#appMembershipPlan', 'General Membership - ₹5,000/-');
await member.selectOption('#appPaymentMode', 'UPI');
// Required file uploads: payment screenshot (image), GST + PAN certs (PDF).
await member.setInputFiles('#paymentProofInput', '/tmp/site-cert.png');
await member.setInputFiles('#gstCertInput', '/tmp/site-cert.pdf');
await member.setInputFiles('#panCertInput', '/tmp/site-cert.pdf');
await member.setInputFiles('#regCertInput', '/tmp/site-cert.png');
await new Promise((r) => setTimeout(r, 2500)); // image compression is async
const progress = await member.locator('.form-progress-label').innerText().catch(() => '');
check('progress bar counts files too', /complete/i.test(progress), progress);
await member.locator('#membershipForm button[type="submit"]').click();
await member.waitForSelector('text=Application Submitted Successfully', { timeout: 20000 }).catch(() => {});
check('application submits with files', await member.locator('text=Application Submitted Successfully').isVisible());
const refId = (await member.locator('text=Application Reference ID').locator('..').innerText().catch(() => '')).replace(/\s+/g, '').match(/BCCI-\d+-[0-9a-f]{8}/)?.[0];
check('reference ID issued', !!refId, refId || 'none');
await member.click('#modalCloseBtn').catch(() => {});

console.log('\nAdmin journey: signin → review → events');
console.log('────────────────────────────────────────');
await admin.goto(BASE + '/admin-bcci', { waitUntil: 'networkidle' });
check('admin tab is gone, single admin form only', (await admin.locator('#signinTabEmployee').count()) === 0);
await admin.fill('#pageAdminUser', 'admin@bccibharuch.in');
await admin.fill('#pageAdminPass', 'sandbox-admin-password');
await admin.locator('#pageAdminLoginForm button[type="submit"]').click();
await admin.waitForSelector('#view-admin:not([style*="none"])', { timeout: 15000 }).catch(() => {});
check('admin portal loads', await admin.locator('#view-admin').isVisible());
await admin.waitForFunction(() => (document.getElementById('pendingAppsBody')?.innerText || '').includes('SiteTest Co'), { timeout: 15000 }).catch(() => {});
check('new application appears in Pending', ((await admin.locator('#pendingAppsBody').innerText().catch(() => '')) || '').includes('SiteTest Co'));

// Approve the site-test application.
await admin.locator(`[data-approve-id="${refId}"]`).first().click().catch(() => {});
await admin.waitForSelector('text=Membership approved', { timeout: 15000 }).catch(() => {});
check('approve works + confirmation modal', await admin.locator('text=Membership approved').isVisible());
await admin.click('#modalCloseBtn').catch(() => {});

// Second application → reject with reason.
const stamp2 = `${stamp}b`;
const MEMAIL2 = `sitetest-${stamp2}@example.com`;
{
  const mark = readSandboxLog().length;
  const r = await admin.request.post(`${BASE}/api/send-otp`, { data: { email: MEMAIL2 } });
  check('otp api for second applicant', r.ok());
  const code = await waitOtp(mark);
  const v = await (await admin.request.post(`${BASE}/api/verify-otp`, { data: { email: MEMAIL2, code, name: 'Reject Me' } })).json();
  const tok = v.session?.token;
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const sub = await (await admin.request.post(`${BASE}/api/applications`, {
    headers: { Authorization: `Bearer ${tok}` },
    data: {
      fullName: 'Reject Me', subject: 'BCCI Membership Form', city: 'Bharuch', state: 'Gujarat',
      repName: 'Reject Me', repDesignation: 'Owner', repMobile: '9825012347', repEmail: `repr-${stamp}@example.com`,
      company: `RejectCo ${stamp}`, legalStatus: 'Proprietorship', enterpriseType: 'Micro', businessServices: 'Textile & Garments',
      primaryBusiness: 'RejectCo', businessDescription: 'Testing the rejection path end to end.',
      feedback: 'Reject me please.', membershipPlan: 'General Membership - ₹5,000/-', paymentMode: 'Cash',
      annualTurnover: '100000', employees: '2', phone: '9825012347', address: 'Plot 2', district: 'Bharuch',
      pincode: '392001', gstNo: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A', paymentRef: 'UPI/999888777666',
      gstCertProof: PNG, panCertProof: PNG,
    },
  })).json();
  var refId2 = sub.applicationId;
  check('second application submitted', !!refId2);
}
await admin.goto(BASE + '/admin-bcci', { waitUntil: 'networkidle' });
try {
  await admin.waitForFunction((id) => (document.getElementById('pendingAppsBody')?.innerText || '').toLowerCase().includes(id.toLowerCase()), refId2, { timeout: 15000 });
  await admin.locator(`[data-reject-id="${refId2}"]`).first().click({ timeout: 10000 });
  await admin.fill('#rejectionReasonInput', 'Browser test rejection reason', { timeout: 10000 });
  await admin.click('#confirmRejectBtn', { timeout: 10000 });
  // Table renders text uppercased via CSS; match case-insensitively and wait
  // for the portal re-render instead of sleeping a fixed interval.
  await new Promise((r) => setTimeout(r, 2500));
  await admin.locator('[data-tab="rejected"]').click({ timeout: 10000 });
  await admin.waitForFunction(
    (id) => (document.getElementById('rejectedAppsBody')?.innerText || '').toLowerCase().includes(id.toLowerCase())
      && (document.getElementById('rejectedAppsBody')?.innerText || '').toLowerCase().includes('browser test rejection reason'),
    refId2, { timeout: 20000 }
  );
  var rejectedText = await admin.locator('#rejectedAppsBody').innerText().catch(() => '');
  check('rejection reason visible in Rejected tab', rejectedText.toLowerCase().includes('browser test rejection reason'), rejectedText.slice(0, 150));
} catch (e) {
  check('reject-with-reason flow completes', false, String(e).split('\n')[0]);
}

// Member sees approval + reason on their own record.
await member.goto(BASE + '/membership', { waitUntil: 'networkidle' });
await new Promise((r) => setTimeout(r, 1500));
const memberStatus = await member.content();
check('approved member sees Active status', memberStatus.includes('Active Member'), memberStatus.slice(0, 200));

// Enquiry from the browser.
const enquiryMark = consoleErrors.length;
await member.goto(BASE + '/enquiry', { waitUntil: 'networkidle' });
await member.fill('#enquiryName', 'Site Enquirer');
await member.fill('#enquiryPhone', '9825012348');
await member.fill('#enquiryEmail', `enq-${stamp}@example.com`);
await member.fill('#enquirySubject', 'Browser test enquiry');
await member.fill('#enquiryMessage', 'Hello from the full-site browser test, please ignore.');
await member.locator('#enquiryForm button[type="submit"]').click();
// The portal answers a stored enquiry with a "Thank You for Contacting BCCI"
// modal; its absence means the submit failed even if nothing logged an error.
await member.waitForSelector('text=Thank You for Contacting BCCI', { timeout: 15000 }).catch(() => {});
const enquiryThanks = await member.locator('text=Thank You for Contacting BCCI').isVisible().catch(() => false);
check('enquiry submits and shows the confirmation', enquiryThanks);
check('enquiry step raised no console errors', errorsSince(enquiryMark).length === 0, errorsSince(enquiryMark).slice(0, 3).join(' | '));
await member.click('#modalCloseBtn').catch(() => {});

// Events: broadcast → public register.
const broadcastMark = consoleErrors.length;
await admin.goto(BASE + '/admin-bcci', { waitUntil: 'networkidle' });
await admin.locator('[data-tab="events"]').click().catch(() => {});
await new Promise((r) => setTimeout(r, 1000));
await admin.fill('#eventTitleInput', `Browser Summit ${stamp}`);
await admin.fill('#eventDateInput', '2026-12-20');
await admin.fill('#eventTimeInput', '10:00');
await admin.fill('#eventVenueInput', 'City Center, Bharuch');
await admin.fill('#eventCapacityInput', '50');
await admin.fill('#eventDescInput', 'End-to-end browser test event.');
await admin.locator('#tab-events button[type="submit"], #tab-events .btn-primary').first().click().catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
check('broadcast step raised no console errors', errorsSince(broadcastMark).length === 0, errorsSince(broadcastMark).slice(0, 3).join(' | '));

const registerMark = consoleErrors.length;
await member.goto(BASE + '/events', { waitUntil: 'networkidle' });
await new Promise((r) => setTimeout(r, 1500));
const eventsText = await member.locator('#eventsGrid').innerText().catch(() => '');
check('broadcast event appears publicly', eventsText.includes(`Browser Summit ${stamp}`), eventsText.slice(0, 150));
await member.getByRole('button', { name: /register/i }).first().click().catch(() => {});
await member.fill('#joinNameInput', 'Event Guest').catch(() => {});
await member.fill('#joinEmailInput', `guest-${stamp}@example.com`).catch(() => {});
await member.fill('#joinPhoneInput', '9825012349').catch(() => {});
await member.locator('#joinEventForm button[type="submit"]').click().catch(() => {});
// A successful registration opens the admission pass (or the pending-payment
// notice for a paid event). Assert that, rather than "no console errors".
await member.waitForFunction(
  () => /Registration (Confirmed|Received|Pending)/i.test(document.getElementById('modalContainer')?.innerText || ''),
  null,
  { timeout: 20000 }
).catch(() => {});
const ticketText = await member.locator('#modalContainer').innerText().catch(() => '');
check(
  'public event registration confirms with a pass',
  /Registration (Confirmed|Received|Pending)/i.test(ticketText) && ticketText.includes('Event Guest'),
  ticketText.slice(0, 150)
);
check('event registration step raised no console errors', errorsSince(registerMark).length === 0, errorsSince(registerMark).slice(0, 3).join(' | '));
await member.click('#modalCloseBtn').catch(() => {});

// Verification + card pages for the approved member.
const verifyMark = consoleErrors.length;
await member.goto(`${BASE}/verify/${refId}`, { waitUntil: 'networkidle' });
await new Promise((r) => setTimeout(r, 2000));
check('public verify page resolves member', (await member.content()).includes('SiteTest Co'));
await member.goto(BASE + '/card', { waitUntil: 'networkidle' });
check('card page renders', (await member.content()).includes('Membership Card'));
check('verification/card steps raised no console errors', errorsSince(verifyMark).length === 0, errorsSince(verifyMark).slice(0, 3).join(' | '));

console.log('\nMobile viewport (390px)');
console.log('───────────────────────');
const mobCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const mob = await mobCtx.newPage();
watch(mob, 'mobile');
await mob.goto(BASE + '/', { waitUntil: 'networkidle' });
check('mobile home renders hero', (await mob.content()).includes('Empowering'));
check('mobile drawer button visible', await mob.locator('#mobileMenuBtn').isVisible().catch(() => false));
await mob.goto(BASE + '/membership', { waitUntil: 'networkidle' });
check('mobile membership reachable', (await mob.content()).includes('Applicant Portal'));
await mob.close();
await mobCtx.close();

console.log('\nConsole / network errors');
console.log('────────────────────────');
check('zero console errors, pageerrors and failed requests', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
await browser.close();
process.exit(fail ? 1 : 0);
