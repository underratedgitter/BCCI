#!/usr/bin/env node
// `npm run check` — parses every JavaScript file the project ships.
//
// The shell loop this replaces (`for f in …; do node --check "$f"; done`) is a
// POSIX-only construct in package.json, so `npm run check` did not work in
// cmd.exe or PowerShell. The loop lives here instead, and it also covers the
// files the old list missed: server.js, scripts/*.mjs and tests/*.mjs.
//
//   node scripts/check-syntax.mjs     # exits 1 with the first broken file

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Every .js/.mjs file under dir, one level deep (there is no nesting here). */
function filesIn(dir, extension) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => path.posix.join(dir, name));
}

const TARGETS = [
  'server.js',
  ...filesIn('api', '.js'),
  ...filesIn('api/_lib', '.js'),
  ...filesIn('js', '.js'),
  ...filesIn('scripts', '.mjs'),
  ...filesIn('tests', '.mjs'),
];

let failed = 0;
for (const file of TARGETS) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
  if (result.status === 0) continue;
  failed++;
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  console.error(`  ✗ ${file}`);
  if (output) console.error(output.split('\n').map((line) => `    ${line}`).join('\n'));
}

if (failed) {
  console.error(`\n${failed} file${failed === 1 ? '' : 's'} failed to parse (${TARGETS.length} checked)`);
  process.exit(1);
}
console.log(`syntax OK (${TARGETS.length} files)`);
