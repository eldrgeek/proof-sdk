#!/usr/bin/env node
// Runs every scripts/*-check.mjs in sequence against this worktree. One PASS/FAIL line per check.
// A check fails on non-zero exit, a terminating signal, or a ^FAIL line in its output (some checks
// have been wrong about process.exit). Do not pipe these scripts in a shell: pipes hide exit codes.
//
// Usage: node scripts/check-all.mjs [--scripts-dir dir] [--verbose] [--timeout-ms N]
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const verbose = process.argv.includes('--verbose');
const scriptsDir = path.resolve(arg('--scripts-dir') || path.join(root, 'scripts'));
const timeoutMs = Number(arg('--timeout-ms') ?? process.env.CHECK_ALL_TIMEOUT_MS ?? 0) || undefined;

const names = readdirSync(scriptsDir)
  .filter((name) => name.endsWith('-check.mjs'))
  .sort((a, b) => a.localeCompare(b));

if (names.length === 0) {
  console.error(`check-all: no *-check.mjs in ${scriptsDir}`);
  process.exit(2);
}

const failLine = /(?:^|\n)FAIL /m;
let failed = 0;

for (const name of names) {
  const script = path.join(scriptsDir, name);
  const label = name.replace(/\.mjs$/, '');
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (verbose) process.stdout.write(output);

  const exitCode = result.status;
  const signal = result.signal;
  const markedFail = failLine.test(output);
  const ok = exitCode === 0 && !signal && !markedFail;

  if (ok) {
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    const parts = [];
    if (signal) parts.push(`signal ${signal}`);
    else if (exitCode !== 0) parts.push(`exit ${exitCode ?? 'null'}`);
    if (markedFail) parts.push('FAIL marker');
    if (result.error?.message) parts.push(result.error.message);
    console.log(`FAIL ${label} (${parts.join(', ') || 'unknown'})`);
  }
}

if (failed) {
  console.error(`check-all: ${failed}/${names.length} checks failed`);
  process.exit(1);
}
console.log(`check-all: ${names.length}/${names.length} checks passed`);
process.exit(0);
