// Pins how SMTP settings resolve, so a working mail setup keeps working.
//
// The old code hardcoded secure:true and never read EMAIL_FROM. These cases
// lock in the behaviour for existing configurations and document the two
// deliberate changes.

import { resolveSmtpConfig } from '../api/_lib/email.js';

let pass = 0, fail = 0;
const ck = (n, c, d = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d ? ` — ${d}` : ''))); };
const sec = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

sec('Existing configurations resolve exactly as before');

let c = resolveSmtpConfig({ SMTP_USER: 'p@bcci.in', SMTP_PASS: 'pw' });
ck('no host/port set → smtp.gmail.com:465, implicit TLS', c.host === 'smtp.gmail.com' && c.port === 465 && c.secure === true, JSON.stringify(c));

c = resolveSmtpConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'p@bcci.in', SMTP_PASS: 'pw' });
ck('explicit 465 → secure true (unchanged)', c.secure === true);

c = resolveSmtpConfig({ GMAIL_USER: 'p@gmail.com', GMAIL_PASS: 'app-pw' });
ck('legacy GMAIL_USER / GMAIL_PASS still honoured', c.user === 'p@gmail.com' && c.pass === 'app-pw' && c.configured);

c = resolveSmtpConfig({ SMTP_USER: 'p@bcci.in', SMTP_PASS: 'pw' });
ck('From falls back to the authenticated account', c.from === '"BCCI Bharuch Portal" <p@bcci.in>', c.from);

c = resolveSmtpConfig({ SMTP_USER: 'p@bcci.in', SMTP_PASS: 'pw', SMTP_FROM: 'BCCI <x@bcci.in>' });
ck('SMTP_FROM still wins over the default', c.from === 'BCCI <x@bcci.in>', c.from);

sec('Port 465 = SSL, port 587 = TLS/STARTTLS');

c = resolveSmtpConfig({ SMTP_PORT: '465', SMTP_USER: 'p@bcci.in', SMTP_PASS: 'pw' });
ck('465 → implicit TLS (SSL) from the first byte', c.secure === true && c.requireTLS === false, JSON.stringify(c));

c = resolveSmtpConfig({ SMTP_PORT: '587', SMTP_USER: 'p@bcci.in', SMTP_PASS: 'pw' });
ck('587 → plaintext connect, STARTTLS upgrade', c.secure === false, `secure=${c.secure}`);
ck('587 → the upgrade is REQUIRED, not opportunistic', c.requireTLS === true, `requireTLS=${c.requireTLS}`);

c = resolveSmtpConfig({ SMTP_PORT: '25', SMTP_USER: 'p@bcci.in', SMTP_PASS: 'pw' });
ck('25 → secure false, STARTTLS still required', c.secure === false && c.requireTLS === true);

c = resolveSmtpConfig({ SMTP_PORT: '587', SMTP_SECURE: 'true', SMTP_USER: 'p@bcci.in', SMTP_PASS: 'pw' });
ck('SMTP_SECURE overrides the port-derived default', c.secure === true && c.requireTLS === false);

sec('Credentials are never sent in the clear');

for (const port of ['587', '25', '2525']) {
  c = resolveSmtpConfig({ SMTP_HOST: 'smtp.provider.com', SMTP_PORT: port, SMTP_USER: 'p@bcci.in', SMTP_PASS: 'pw' });
  ck(`remote port ${port} refuses to send without TLS`, c.requireTLS === true, `requireTLS=${c.requireTLS}`);
}

c = resolveSmtpConfig({ SMTP_HOST: 'localhost', SMTP_PORT: '25' });
ck('a local MTA needs no credentials', c.configured === true, JSON.stringify(c));
ck('a local MTA is exempt from requireTLS', c.requireTLS === false, 'would break a local relay');

c = resolveSmtpConfig({ SMTP_HOST: 'smtp.provider.com' });
ck('a remote host without credentials is not configured', c.configured === false);

sec('Changed: EMAIL_FROM is now read (it never was before)');

c = resolveSmtpConfig({ SMTP_USER: 'p@gmail.com', SMTP_PASS: 'pw', EMAIL_FROM: 'BCCI <noreply@bccibharuch.in>' });
ck('EMAIL_FROM takes precedence', c.from === 'BCCI <noreply@bccibharuch.in>', c.from);

c = resolveSmtpConfig({ SMTP_USER: 'p@gmail.com', SMTP_PASS: 'pw', EMAIL_FROM: 'A <a@x.com>', SMTP_FROM: 'B <b@y.com>' });
ck('EMAIL_FROM beats SMTP_FROM', c.from === 'A <a@x.com>', c.from);

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
if (fail) process.exit(1);
