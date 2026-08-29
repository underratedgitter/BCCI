#!/usr/bin/env node
/**
 * Checks the mail setup against your real SMTP server.
 *
 *   node --env-file=.env.local scripts/test-mail.mjs
 *   node --env-file=.env.local scripts/test-mail.mjs you@example.com
 *
 * With no address it resolves the config, opens a connection and
 * authenticates — without sending anything. With an address it also sends one
 * real message of each template so you can see how they land.
 */

import { verifyTransport, sendEmail, TEMPLATES, resolveSmtpConfig } from '../api/_lib/email.js';

const recipient = process.argv[2];

const mask = (v) => (v ? v.slice(0, 2) + '•'.repeat(Math.max(4, v.length - 2)) : '(not set)');
const show = (label, value, note = '') =>
  console.log(`  ${label.padEnd(22)} ${value}${note ? `   ${note}` : ''}`);

console.log('\nSMTP configuration');
console.log('──────────────────');

// Read from the app's own resolver, so this reports what actually gets used.
const { host, port, secure, user, pass, from } = resolveSmtpConfig();

show('host', host, process.env.SMTP_HOST ? '' : '(default)');
show('port', String(port), process.env.SMTP_PORT ? '' : '(default)');
show('secure (implicit TLS)', String(secure), process.env.SMTP_SECURE ? '' : `(derived from port ${port})`);
show('user', user || '(not set)');
show('pass', mask(pass));
show('From header', from);

// ── The one behaviour change worth checking ──────────────────────────
// EMAIL_FROM was documented in .env.example but never read by the old code,
// which always sent as SMTP_FROM or the authenticated user. It is honoured
// now, so a mismatched value can start being rejected or silently rewritten.
if (process.env.EMAIL_FROM && user) {
  const fromDomain = (from.match(/@([^>\s]+)/) || [])[1];
  const userDomain = user.split('@')[1];
  if (fromDomain && userDomain && fromDomain.toLowerCase() !== userDomain.toLowerCase()) {
    console.log('\n  ⚠  EMAIL_FROM is on a different domain than the SMTP account.');
    console.log(`     sending as   ${fromDomain}`);
    console.log(`     authenticated as ${userDomain}`);
    console.log('     Most providers reject or rewrite this unless the address is a');
    console.log('     verified sender/alias. If mail worked before and stops now,');
    console.log('     unset EMAIL_FROM to fall back to the authenticated account.');
  }
}

// ── Templates render ─────────────────────────────────────────────────
console.log('\nTemplates');
console.log('─────────');
const sample = {
  appId: 'BCCI-TEST-0001', company: 'Sunrise Chemicals Pvt Ltd', repName: 'Priya Shah',
  repDesignation: 'Director', email: 'priya@example.com', phone: '9825012345',
  sector: 'Chemicals', enterpriseType: 'Medium', legalStatus: 'Private Limited',
  gstNo: '24AABCS1234F1Z5', panNo: 'AABCS1234F', paymentRef: 'UPI/428193042818',
  date: new Date().toLocaleDateString('en-IN'), validUntil: '29 August 2027',
  daysLeft: 3, reason: 'Sample reason',
};
for (const name of Object.keys(TEMPLATES)) {
  try {
    const { subject, html } = TEMPLATES[name](sample);
    console.log(`  ok   ${name.padEnd(24)} ${subject.slice(0, 52)}`);
    if (!html.includes('</html>')) console.log(`       ⚠  ${name} looks truncated`);
  } catch (err) {
    console.log(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

// ── Connection ───────────────────────────────────────────────────────
console.log('\nConnection');
console.log('──────────');
const result = await verifyTransport();
if (!result.ok) {
  console.log(`  FAILED: ${result.error}\n`);
  console.log('  Common causes:');
  console.log('   • Gmail needs an App Password, not the account password');
  console.log('   • Port 587 or 25 needs SMTP_SECURE=false (STARTTLS)');
  console.log('   • Port 465 needs SMTP_SECURE=true');
  console.log('   • A firewall blocking outbound SMTP from this machine\n');
  process.exit(1);
}
console.log('  connected and authenticated\n');

if (!recipient) {
  console.log('Pass an address to send real test messages:');
  console.log('  node --env-file=.env.local scripts/test-mail.mjs you@example.com\n');
  process.exit(process.exitCode || 0);
}

// ── Real send ────────────────────────────────────────────────────────
console.log(`Sending to ${recipient}`);
console.log('─'.repeat(12 + recipient.length));
let sent = 0, failed = 0;
for (const name of Object.keys(TEMPLATES)) {
  const r = await sendEmail({ type: name, to: recipient, data: sample });
  if (r.success) { sent++; console.log(`  sent   ${name}`); }
  else { failed++; console.log(`  FAILED ${name}: ${r.error}`); }
}

console.log(`\n${sent} sent, ${failed} failed`);
console.log('Check the inbox — and the spam folder, which is where an unverified');
console.log('From address usually ends up.\n');
process.exit(failed ? 1 : 0);
