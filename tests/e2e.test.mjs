// Full-stack exercise: the real server.js, the real handlers, a mock Upstash
// and a real SMTP conversation. This is the "does it actually work" test.

import { startMockRedis } from './mock-redis.mjs';
import { startMockSmtp } from './smtp-server.mjs';

const redis = await startMockRedis();
const smtp = await startMockSmtp();

process.env.UPSTASH_REDIS_REST_URL = redis.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.ADMIN_EMAILS = 'secretariat@bccibharuch.in';
process.env.ADMIN_PASSWORD = 'a-long-random-admin-secret';
process.env.INTERNAL_API_SECRET = 'internal-secret-value';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.port);
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'portal@bccibharuch.in';
process.env.SMTP_PASS = 'app-password';
process.env.EMAIL_FROM = 'BCCI Bharuch <portal@bccibharuch.in>';
process.env.PORT = '0';

const server = (await import('../server.js')).default;
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const BASE = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ck = (n, c, d = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d ? ' — ' + d : ''))); };
const sec = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

const req = async (p, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
};
const waitForMail = async (n, ms = 3000) => {
  const t0 = Date.now();
  while (smtp.received.length < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 40));
  return smtp.received.length >= n;
};

// ════════════════════════════════════════════════════════════════════
sec('The server serves the site (no Vercel involved)');

let r = await req('/');
ck('GET / returns the portal', r.status === 200 && r.text.includes('Bharuch Chamber'), `status ${r.status}`);

r = await req('/about');
ck('GET /about resolves via the SPA fallback', r.status === 200 && r.text.includes('<!DOCTYPE html>'), `status ${r.status}`);

r = await req('/css/styles.css');
ck('stylesheet served', r.status === 200 && r.headers.get('content-type').includes('text/css'));

r = await req('/js/app.js');
ck('app module served', r.status === 200 && r.headers.get('content-type').includes('javascript'));

r = await req('/robots.txt');
ck('robots.txt served', r.status === 200);

r = await req('/../package.json');
ck('path traversal blocked', !r.text.includes('"dependencies"'), 'package.json was readable');

r = await req('/server.js');
ck('server source is not served', !r.text.includes('createServer'), 'server.js was readable');

sec('Security headers travel with the app, not with vercel.json');
r = await req('/');
for (const h of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy']) {
  ck(`${h} present`, !!r.headers.get(h), 'missing');
}
ck('CSP allows cdnjs (icons + QR)', (r.headers.get('content-security-policy') || '').includes('cdnjs.cloudflare.com'));
ck('CSP allows Google Fonts', (r.headers.get('content-security-policy') || '').includes('fonts.googleapis.com'));

sec('Health check');
r = await req('/api/health');
ck('/api/health returns JSON, not the SPA', r.json !== null, r.text.slice(0, 60));
ck('reports redis reachable', r.json?.checks?.redis?.reachable === true, JSON.stringify(r.json?.checks?.redis));
ck('reports smtp configured', r.json?.checks?.smtp?.configured === true);
ck('overall status ok', r.json?.status === 'ok', JSON.stringify(r.json?.status));

// ════════════════════════════════════════════════════════════════════
sec('A member signs up — the whole journey');

const MEMBER = 'priya@sunrisechem.example';

r = await req('/api/send-otp', { method: 'POST', body: { email: MEMBER, name: 'Priya Shah' } });
ck('OTP requested', r.status === 200, JSON.stringify(r.json));
ck('a real SMTP message was delivered', await waitForMail(1), `${smtp.received.length} received`);

const otpMail = smtp.received[0];
ck('OTP mail addressed to the applicant', otpMail?.to?.includes(MEMBER), JSON.stringify(otpMail?.to));
ck('OTP mail has the right subject', /verification code/i.test(otpMail?.subject || ''), otpMail?.subject);
const code = JSON.parse(redis.store.get(`bcci:otp:${MEMBER}`));
ck('the 6-digit code is in the email body', otpMail?.raw?.includes(code), 'code not found in message');

r = await req('/api/verify-otp', { method: 'POST', body: { email: MEMBER, code, name: 'Priya Shah' } });
ck('OTP verified, session issued', r.status === 200 && !!r.json?.session?.token, JSON.stringify(r.json));
const memberToken = r.json?.session?.token;

const application = {
  repName: 'Priya Shah', repDesignation: 'Director',
  company: 'Sunrise Chemicals Pvt Ltd', legalStatus: 'Private Limited',
  enterpriseType: 'Medium', businessServices: 'Chemicals & Petrochemicals',
  annualTurnover: '5-10 Cr', employees: '85', cin: 'U24100GJ2015PTC012345',
  phone: '9825012345', address: 'Plot 42, GIDC Estate, Ankleshwar',
  district: 'Bharuch', pincode: '393002',
  gstNo: '24AABCS1234F1Z5', panNo: 'AABCS1234F',
  paymentRef: 'UPI/428193042818',
};

r = await req('/api/applications', { method: 'POST', token: memberToken, body: application });
ck('application submitted', r.status === 201, JSON.stringify(r.json).slice(0, 200));
const appId = r.json?.applicationId;
ck('status is Pending', r.json?.application?.status === 'Pending', r.json?.application?.status);

ck('confirmation + admin alert both sent', await waitForMail(3), `${smtp.received.length} mails total`);
const confirmation = smtp.received.find((m) => m.to?.includes(MEMBER) && /application received/i.test(m.subject));
const adminAlert = smtp.received.find((m) => m.to?.includes('secretariat@bccibharuch.in'));
ck('applicant received a confirmation', !!confirmation, 'not found');
ck('admin received the new-application alert', !!adminAlert, 'not found');
ck('admin alert carries the application ID', adminAlert?.raw?.includes(appId));
ck('admin recipient came from the server, not the browser', adminAlert?.to?.includes('secretariat@bccibharuch.in'));

sec('The data is actually stored');
r = await req('/api/applications', { method: 'POST', token: memberToken, body: application });
ck('duplicate submission refused', r.status === 409, `status ${r.status}`);

r = await req(`/api/applications?email=${encodeURIComponent(MEMBER)}`, { token: memberToken });
const stored = r.json?.application;
ck('member can read their own record', r.status === 200 && stored?.id === appId);
for (const [field, expected] of [
  ['company', application.company], ['repName', application.repName],
  ['gstNo', application.gstNo], ['panNo', application.panNo],
  ['phone', application.phone], ['address', application.address],
  ['cin', application.cin], ['annualTurnover', application.annualTurnover],
  ['paymentRef', application.paymentRef], ['pincode', application.pincode],
]) {
  ck(`${field} persisted correctly`, stored?.[field] === expected, `got ${JSON.stringify(stored?.[field])}`);
}
ck('email recorded from the verified session', stored?.email === MEMBER);
ck('submittedAt is a valid timestamp', !Number.isNaN(Date.parse(stored?.submittedAt || '')));

sec('The secretariat approves it');
r = await req('/api/admin-auth', { method: 'POST', body: { username: 'secretariat@bccibharuch.in', password: 'a-long-random-admin-secret' } });
ck('admin signed in', r.status === 200 && !!r.json?.session?.token);
const adminToken = r.json?.session?.token;

r = await req('/api/applications', { token: adminToken });
ck('the application appears in the admin list', (r.json?.applications || []).some((a) => a.id === appId && a.status === 'Pending'));

const mailsBefore = smtp.received.length;
r = await req('/api/applications', { method: 'PATCH', token: adminToken, body: { id: appId, status: 'Approved' } });
ck('approved', r.status === 200 && r.json?.application?.status === 'Approved', JSON.stringify(r.json).slice(0, 150));
ck('approval email sent', await waitForMail(mailsBefore + 1), 'no mail');
const approval = smtp.received[smtp.received.length - 1];
ck('approval went to the member', approval?.to?.includes(MEMBER));
ck('approval names the company', approval?.raw?.includes('Sunrise Chemicals'));

r = await req('/api/admin-stats', { token: adminToken });
ck('dashboard counts 1 approved', r.json?.stats?.approved === 1, JSON.stringify(r.json?.stats));

sec('A year later, the renewal reminder');
r = await req('/api/applications', { method: 'PATCH', token: memberToken, body: { id: appId, action: 'renew', paymentRef: 'UPI/999' } });
ck('member renews their own membership', r.status === 200 && r.json?.application?.renewalYears === 2);

sec('Enquiries from the public');
r = await req('/api/enquiries', { method: 'POST', body: { name: 'Amit Desai', email: 'amit@example.com', phone: '9898123456', subject: 'Certificate of Origin', message: 'How do I apply for a CoO?' } });
ck('enquiry accepted', r.status === 201, JSON.stringify(r.json).slice(0, 150));
r = await req('/api/enquiries', { token: adminToken });
ck('admin sees the enquiry', (r.json?.enquiries || []).length === 1);
r = await req('/api/enquiries');
ck('the public cannot list enquiries', r.status === 401);

sec('Load: a month of traffic in one burst');
// 30 members a month is the expected volume; fire that at once.
const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: 30 }, (_, i) =>
    req('/api/enquiries', { method: 'POST', body: { name: `Bulk ${i}`, email: `bulk${i}@example.com`, phone: '9800000000', subject: 'Test', message: 'Load check' } })
  )
);
const elapsed = Date.now() - t0;
const created = results.filter((x) => x.status === 201).length;
const limited = results.filter((x) => x.status === 429).length;
ck('all 30 concurrent requests handled', created + limited === 30, `${created} created, ${limited} limited`);
ck('none errored', results.every((x) => x.status === 201 || x.status === 429), results.map(x=>x.status).join(','));
console.log(`         (${elapsed}ms for 30 concurrent submissions)`);

console.log(`\n${'═'.repeat(54)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(54)}`);
console.log(`  ${smtp.received.length} emails delivered over real SMTP during this run\n`);

server.close();
smtp.server.close();
redis.server.close();
process.exit(fail ? 1 : 0);
