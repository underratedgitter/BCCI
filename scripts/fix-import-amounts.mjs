#!/usr/bin/env node
/**
 * Correct the paid amount on members imported by import-members.mjs, per the
 * Secretariat's fee sheet. The importer set the fee from the MSME category, which
 * does not match what members actually paid.
 *
 *   node scripts/fix-import-amounts.mjs --data <fixes.json>                                # dry run
 *   node --env-file=.env.local scripts/fix-import-amounts.mjs --data <fixes.json> --apply
 *
 * fixes.json: [{ "id": "BCCI-...", "company": "Elegant Enterprise", "paid": 1000 }, ...]
 * "paid": null clears the paid amount (no payment recorded). Records are matched by
 * ID, and the company name must also match, so a wrong ID changes nothing.
 *
 * Only records created by the importer (importedAt set) are touched, and only
 * paymentAmount, totalFee (when a payment is recorded) and importNotes change. It
 * writes straight to storage through updateApplication, which sends no email.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const MISMATCH_NOTE = /^Amount paid per sheet is .*; portal fee for ".*" is \d+\.$/;

async function main() {
  const { values } = parseArgs({ options: { data: { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!values.data) fail('Usage: fix-import-amounts.mjs --data <fixes.json> [--apply]');
  const fixes = JSON.parse(readFileSync(values.data, 'utf8'));
  if (!Array.isArray(fixes) || !fixes.length) fail('Data file must be a non-empty JSON array.');
  for (const f of fixes) {
    if (!/^BCCI-\d+-[0-9a-f]{7,8}$/.test(f.id || '')) fail(`Invalid record ID: ${f.id}`);
    if (f.paid !== null && !(Number.isInteger(f.paid) && f.paid > 0)) fail(`Invalid amount ${f.paid} for ${f.company}`);
  }

  const { initStorage, getApplication, updateApplication, STORAGE_BACKEND } = await import('../api/_lib/records.js');
  console.log(`${values.apply ? 'APPLY: writing changes' : 'DRY RUN: nothing will be written'} (storage: ${STORAGE_BACKEND})\n`);
  await initStorage();

  const today = new Date().toISOString().slice(0, 10);
  const counts = { changed: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const f of fixes) {
    try {
      const app = await getApplication(f.id);
      if (!app) { counts.skipped++; console.log(`NOT FOUND ${f.company}: ${f.id}`); continue; }
      if (norm(app.company) !== norm(f.company)) { counts.skipped++; console.log(`MISMATCH  ${f.id} is "${app.company}", expected "${f.company}"`); continue; }
      if (!app.importedAt) { counts.skipped++; console.log(`SKIP      ${f.company}: not created by the importer`); continue; }

      const paid = f.paid === null ? '' : String(f.paid);
      const fee = f.paid === null ? app.totalFee : f.paid;
      if (String(app.paymentAmount ?? '') === paid && Number(app.totalFee) === Number(fee)) {
        counts.unchanged++; console.log(`OK        ${f.company}: already correct`); continue;
      }
      const label = f.paid === null ? 'no payment recorded' : `paid ₹${f.paid}`;
      console.log(`${values.apply ? 'UPDATE   ' : 'WOULD SET'} ${f.company.padEnd(38)} paid=${app.paymentAmount || '-'} fee=${app.totalFee}  ->  paid=${paid || '-'} fee=${fee}`);
      if (!values.apply) { counts.changed++; continue; }
      await updateApplication(f.id, (rec) => ({
        ...rec,
        paymentAmount: paid,
        totalFee: fee,
        importNotes: [
          ...(rec.importNotes || []).filter((n) => !MISMATCH_NOTE.test(n)),
          `Corrected to ${label} per the Secretariat fee sheet on ${today}.`,
        ],
      }));
      counts.changed++;
    } catch (err) {
      counts.failed++;
      console.error(`FAIL      ${f.company}: ${err.message}`);
    }
  }
  console.log(`\n${values.apply ? 'Updated' : 'Would update'}: ${counts.changed}, already correct: ${counts.unchanged}, ` +
    `skipped: ${counts.skipped}, failed: ${counts.failed}`);
  if (counts.failed) process.exit(1);
}

await main();
