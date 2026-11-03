#!/usr/bin/env node
// Guards the hand-written cache-busting versions (`app.js?v=5.0.30`).
//
// Browsers keep /js and /css files for a week, so a file that changes without
// its `?v=` changing reaches nobody until their cache expires — phones keep
// running the old code against the new server. This happened twice in a row,
// so it is now checked instead of remembered.
//
//   node scripts/asset-versions.mjs            # check (the test suite runs this)
//   node scripts/asset-versions.mjs --update   # after bumping, record the new state
//
// The record (tests/asset-versions.json) holds each versioned file's version
// and content hash. A changed file whose version did not change fails.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RECORD = path.join(ROOT, 'tests', 'asset-versions.json');
const REF = /([A-Za-z0-9_./-]+\.(?:js|css|webp|jpe?g|png|svg))\?v=([A-Za-z0-9._-]+)/g;

/** Every file that can reference a versioned file. */
function sources() {
  const list = ['index.html'];
  for (const dir of ['js', 'css']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (/\.(js|css)$/.test(f)) list.push(`${dir}/${f}`);
    }
  }
  return list;
}

/** `./dom.js` inside js/board-portal.js → js/dom.js; `/js/app.js` → js/app.js. */
function resolve(from, ref) {
  if (ref.startsWith('/')) return ref.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), ref));
}

/** Hash without line-ending noise, so a Windows checkout agrees with Linux. */
function hashOf(file) {
  const text = /\.(js|css)$/.test(file)
    ? fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
    : fs.readFileSync(path.join(ROOT, file));
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** The current state: each versioned file, its version(s) and hash. */
export function scan() {
  const refs = new Map();
  for (const from of sources()) {
    const text = fs.readFileSync(path.join(ROOT, from), 'utf8');
    for (const [, ref, version] of text.matchAll(REF)) {
      const file = resolve(from, ref);
      if (!refs.has(file)) refs.set(file, { versions: new Map() });
      const seen = refs.get(file).versions;
      if (!seen.has(version)) seen.set(version, []);
      seen.get(version).push(from);
    }
  }
  return refs;
}

/** Problems with the current state, as human-readable lines (empty when fine). */
export function check() {
  const problems = [];
  const record = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : {};
  const refs = scan();
  for (const [file, { versions }] of [...refs].sort()) {
    if (!fs.existsSync(path.join(ROOT, file))) {
      problems.push(`${file} is referenced but does not exist`);
      continue;
    }
    if (versions.size > 1) {
      const where = [...versions].map(([v, from]) => `?v=${v} in ${from.join(', ')}`).join('; ');
      problems.push(`${file} is loaded with different versions (${where}); use one`);
      continue;
    }
    const [version] = versions.keys();
    const hash = hashOf(file);
    const known = record[file];
    if (!known) {
      problems.push(`${file} is new to the version record; run \`npm run versions:update\``);
    } else if (known.sha256 !== hash && known.version === version) {
      problems.push(`${file} changed but is still loaded as ?v=${version}; bump its ?v= where it is loaded, then run \`npm run versions:update\``);
    } else if (known.sha256 !== hash || known.version !== version) {
      problems.push(`${file}: the version record is out of date; run \`npm run versions:update\``);
    }
  }
  for (const file of Object.keys(record)) {
    if (!refs.has(file)) problems.push(`${file} is in the version record but no longer loaded; run \`npm run versions:update\``);
  }
  return problems;
}

/** Writes the record from the current state. Refuses while versions disagree. */
export function update() {
  const record = {};
  for (const [file, { versions }] of [...scan()].sort()) {
    if (versions.size > 1) throw new Error(`${file} is loaded with different versions; use one first`);
    record[file] = { version: [...versions.keys()][0], sha256: hashOf(file) };
  }
  fs.writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--update')) {
    // Updating must not paper over a forgotten bump: check first.
    const forgotten = check().filter((p) => p.includes('changed but is still loaded'));
    if (forgotten.length && !process.argv.includes('--force')) {
      for (const p of forgotten) console.error(`  ✗ ${p}`);
      console.error('\nBump those versions first (or pass --force if the change cannot affect browsers).');
      process.exit(1);
    }
    const record = update();
    console.log(`Recorded ${Object.keys(record).length} versioned files in tests/asset-versions.json`);
  } else {
    const problems = check();
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.log(problems.length ? `\n${problems.length} problem(s)` : 'asset versions OK');
    process.exit(problems.length ? 1 : 0);
  }
}
