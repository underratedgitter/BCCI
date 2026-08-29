#!/usr/bin/env node
/**
 * Local debugging sandbox.
 *
 *   node scripts/dev-sandbox.mjs
 *
 * Boots the real server against an in-memory Redis and a local SMTP catcher,
 * so nothing touches production and no credentials are needed. Every email the
 * app sends is printed here instead of being delivered, including OTP codes —
 * which means you can sign in and walk the whole flow offline.
 *
 * Seeded with sample applications so the admin panel has something in it.
 */

import { startMockRedis } from '../tests/mock-redis.mjs';
import { startMockSmtp } from '../tests/smtp-server.mjs';

const ADMIN_EMAIL = 'admin@bccibharuch.in';
const ADMIN_PASSWORD = 'sandbox-admin-password';

const redisMock = await startMockRedis();
const smtp = await startMockSmtp();

process.env.UPSTASH_REDIS_REST_URL = redisMock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'sandbox';
process.env.ADMIN_EMAILS = ADMIN_EMAIL;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.INTERNAL_API_SECRET = 'sandbox-internal-secret';
process.env.ALLOWED_ORIGIN = 'http://localhost:3000';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.port);
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'sandbox@bccibharuch.in';
process.env.SMTP_PASS = 'sandbox';
process.env.EMAIL_FROM = `BCCI Bharuch <${ADMIN_EMAIL}>`;
process.env.PORT = process.env.PORT || '3000';

// ── Seed data, so the admin panel is not empty ─────────────────────
const { putApplication, putEnquiry } = await import('../api/_lib/redis.js');

const samples = [
  { company: 'Sunrise Chemicals Pvt Ltd', repName: 'Priya Shah', email: 'priya@sunrise.example', status: 'Pending', enterpriseType: 'Medium' },
  { company: 'Narmada Textiles', repName: 'Amit Desai', email: 'amit@narmada.example', status: 'Approved', enterpriseType: 'Small' },
  { company: 'Ankleshwar Polymers LLP', repName: 'Rina Patel', email: 'rina@polymers.example', status: 'Pending', enterpriseType: 'Micro' },
];

for (const [i, s] of samples.entries()) {
  await putApplication({
    id: `BCCI-SANDBOX-${1000 + i}`,
    ...s,
    repDesignation: 'Director',
    phone: `98250123${10 + i}`,
    businessServices: 'Chemicals & Petrochemicals',
    legalStatus: 'Private Limited',
    annualTurnover: '5-10 Cr',
    employees: String(20 + i * 15),
    gstNo: `24AABCS123${i}F1Z5`,
    panNo: `AABCS123${i}F`,
    district: 'Bharuch',
    address: `Plot ${40 + i}, GIDC Estate, Ankleshwar`,
    pincode: '393002',
    paymentRef: `UPI/4281930428${i}`,
    renewalYears: 1,
    submittedAt: new Date(Date.now() - i * 86400000).toISOString(),
    ...(s.status === 'Approved' ? { approvedAt: new Date(Date.now() - 2 * 86400000).toISOString() } : {}),
  });
}

await putEnquiry({
  id: 'ENQ-SANDBOX-1',
  name: 'Vikram Joshi',
  email: 'vikram@example.com',
  phone: '9898123456',
  company: 'Joshi Traders',
  subject: 'Certificate of Origin',
  message: 'How long does a CoO take to issue?',
  membershipType: 'None',
  submittedAt: new Date().toISOString(),
});

// ── Print every email the app tries to send ────────────────────────
let seen = 0;
setInterval(() => {
  while (seen < smtp.received.length) {
    const mail = smtp.received[seen++];
    const otp = (mail.raw.match(/letter-spacing:12px[^>]*>(\d{6})</) || [])[1];
    console.log('\n  ┌─ EMAIL ─────────────────────────────────────────');
    console.log(`  │ to:      ${mail.to.join(', ')}`);
    console.log(`  │ subject: ${mail.subject}`);
    if (otp) console.log(`  │ CODE:    ${otp}   ← paste this to sign in`);
    console.log('  └─────────────────────────────────────────────────');
  }
}, 400).unref();

// ── Boot the real server ───────────────────────────────────────────
await import('../server.js');

const port = process.env.PORT;
setTimeout(() => {
  console.log(`
  ╭──────────────────────────────────────────────────────────╮
  │  SANDBOX — nothing here touches production               │
  ╰──────────────────────────────────────────────────────────╯

    Site        http://localhost:${port}
    Admin       http://localhost:${port}/admin
    Health      http://localhost:${port}/api/health

    Admin sign-in
      username  ${ADMIN_EMAIL}
      password  ${ADMIN_PASSWORD}

    Seeded      3 applications (2 pending, 1 approved), 1 enquiry
    Email       captured and printed here, never delivered.
                Sign in with any address — the OTP appears above.

    Ctrl+C to stop. All data is in memory and vanishes on exit.
`);
}, 300);
