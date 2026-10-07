#!/usr/bin/env node
/**
 * Start imported members' membership year on the date they paid, not the date the
 * Secretariat approved the import. Sets validFrom = submittedAt (the payment date
 * from the Secretariat sheet) on records created by import-members.mjs.
 *
 *   node --env-file=.env.local scripts/set-valid-from.mjs           # dry run
 *   node --env-file=.env.local scripts/set-valid-from.mjs --apply
 *
 * Only imported records without a validFrom are touched, and only validFrom and
 * importNotes change. Writes go through updateApplication, which sends no email.
 */

import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
const { initStorage, listApplicationSummaries, updateApplication, STORAGE_BACKEND } = await import('../api/_lib/records.js');
console.log(`${values.apply ? 'APPLY: writing changes' : 'DRY RUN: nothing will be written'} (storage: ${STORAGE_BACKEND})\n`);
await initStorage();

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
const expiry = (from, years) => {
  const d = new Date(from);
  d.setFullYear(d.getFullYear() + (Number(years) || 1));
  return day(d);
};

const today = new Date().toISOString().slice(0, 10);
const counts = { changed: 0, skipped: 0, failed: 0 };
for (const app of await listApplicationSummaries({ limit: 1000 })) {
  if (!app.importedAt || app.validFrom || !app.submittedAt) { counts.skipped++; continue; }
  const before = expiry(app.approvedAt || app.submittedAt, app.renewalYears);
  const after = expiry(app.submittedAt, app.renewalYears);
  console.log(`${values.apply ? 'UPDATE   ' : 'WOULD SET'} ${String(app.company).padEnd(38)} year from ${day(app.submittedAt)}: expires ${before} -> ${after}`);
  if (!values.apply) { counts.changed++; continue; }
  try {
    await updateApplication(app.id, (rec) => ({
      ...rec,
      validFrom: rec.submittedAt,
      importNotes: [...(rec.importNotes || []), `Membership year set to start on the payment date ${day(rec.submittedAt)} (${today}).`],
    }));
    counts.changed++;
  } catch (err) {
    counts.failed++;
    console.error(`FAIL      ${app.company}: ${err.message}`);
  }
}
console.log(`\n${values.apply ? 'Updated' : 'Would update'}: ${counts.changed}, untouched: ${counts.skipped}, failed: ${counts.failed}`);
if (counts.failed) process.exit(1);
