#!/usr/bin/env node
/**
 * Deletes membership data from Redis. Destructive and not reversible.
 *
 *   node --env-file=.env.local scripts/purge-data.mjs            # dry run
 *   node --env-file=.env.local scripts/purge-data.mjs --confirm  # actually delete
 *   node --env-file=.env.local scripts/purge-data.mjs --confirm --all
 *
 * Default scope is member data: applications, enquiries, the indexes that
 * point at them, and the legacy blobs. `--all` additionally clears sessions,
 * pending OTPs, rate-limit counters, the email log and the reminder ledger.
 *
 * A dry run is the default on purpose — it prints exactly what would go, and
 * nothing is deleted until you pass --confirm.
 */

import { redis } from '../api/_lib/redis.js';

const confirm = process.argv.includes('--confirm');
const all = process.argv.includes('--all');

const MEMBER_DATA = [
  ['bcci:app:*', 'applications'],
  ['bcci:app_email:*', 'email → application index'],
  ['bcci:app_index', 'application ordering index'],
  ['bcci:enq:*', 'enquiries'],
  ['bcci:enq_index', 'enquiry ordering index'],
  ['bcci:applications', 'legacy applications blob'],
  ['bcci:enquiries', 'legacy enquiries blob'],
  ['bcci:migrated:*', 'migration markers'],
];

const OPERATIONAL = [
  ['admin:*', 'admin sessions'],
  ['applicant:*', 'applicant sessions'],
  ['bcci:otp:*', 'pending OTP codes'],
  ['bcci:rl:*', 'rate-limit counters'],
  ['bcci:attempts:*', 'legacy OTP attempt counters'],
  ['bcci:ratelimit:*', 'legacy rate-limit counters'],
  ['bcci:email_log', 'email audit log'],
  ['bcci:renewal_reminders', 'renewal reminder ledger'],
];

async function keysMatching(pattern) {
  if (!pattern.includes('*')) {
    // A literal key — check it exists rather than scanning.
    const type = await redis.exists(pattern).catch(() => 0);
    return type ? [pattern] : [];
  }
  const found = new Set();
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, { match: pattern, count: 500 });
    (batch || []).forEach((k) => found.add(k));
    cursor = String(next);
  } while (cursor !== '0');
  return [...found];
}

const groups = all ? [...MEMBER_DATA, ...OPERATIONAL] : MEMBER_DATA;

console.log(`\nRedis purge — ${confirm ? 'LIVE' : 'DRY RUN'}`);
console.log('─'.repeat(34));
console.log(`  scope: ${all ? 'member data + operational keys' : 'member data only'}`);
if (!confirm) console.log('  nothing will be deleted without --confirm');
console.log('');

let total = 0;
const plan = [];

for (const [pattern, label] of groups) {
  let keys;
  try {
    keys = await keysMatching(pattern);
  } catch (err) {
    console.error(`  ERROR scanning ${pattern}: ${err.message}`);
    process.exit(1);
  }
  if (!keys.length) continue;
  total += keys.length;
  plan.push([keys, label, pattern]);
  console.log(`  ${String(keys.length).padStart(4)}  ${label}`);
  if (keys.length <= 6) {
    keys.forEach((k) => console.log(`        ${k}`));
  } else {
    keys.slice(0, 3).forEach((k) => console.log(`        ${k}`));
    console.log(`        … and ${keys.length - 3} more`);
  }
}

if (!total) {
  console.log('  nothing to delete — the database is already clean\n');
  process.exit(0);
}

console.log(`\n  ${total} key${total === 1 ? '' : 's'} in total`);

if (!confirm) {
  console.log('\n  Re-run with --confirm to delete these.\n');
  process.exit(0);
}

console.log('\nDeleting…');
let deleted = 0;
for (const [keys, label] of plan) {
  // Chunked, so a large purge cannot exceed the request size limit.
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    await redis.del(...chunk);
    deleted += chunk.length;
  }
  console.log(`  removed ${String(keys.length).padStart(4)}  ${label}`);
}

console.log(`\n  ${deleted} key${deleted === 1 ? '' : 's'} deleted.`);
if (!all) {
  console.log('  Sessions, OTPs and logs were left alone — add --all to clear those too.');
}
console.log('');
