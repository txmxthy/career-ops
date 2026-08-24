/**
 * Characterisation of tracker-sync-check.mjs's argv reading and its two file
 * loaders, taken as they moved onto src/core/flags.js and src/core/store.js.
 *
 * The `--apps-file` reader was an `args.indexOf()` lookup, so it could not see
 * the `--flag=value` form at all: `--apps-file=/tmp/x.md` fell through to the
 * install's own tracker and the run reported on a file the caller never named,
 * at exit 0. That is #2401/#2402's defect, one script further on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'tracker-sync-check.mjs');

const APPS = '| # | Company | Role | Status |\n| --- | --- | --- | --- |\n| 1 | Acme | Dev | applied |\n';
const INTERVIEWS = '| Company | Role | Status |\n| --- | --- | --- |\n| Acme | Dev | offer |\n';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-check-'));
  writeFileSync(join(dir, 'apps.md'), APPS);
  writeFileSync(join(dir, 'interviews.md'), INTERVIEWS);
  return dir;
}

function run(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 20_000,
    env: { ...process.env, CAREER_OPS_TRACKER: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return r;
}

/** Rows the run actually compared — 1 when it read the fixture, 0 when it did not. */
function rowsChecked(stdout) {
  return JSON.parse(stdout).summary.total;
}

test('--flag value reads the file it names', () => {
  const dir = fixture();
  const r = run('--apps-file', join(dir, 'apps.md'), '--interviews-file', join(dir, 'interviews.md'));
  assert.equal(r.status, 0);
  assert.equal(rowsChecked(r.stdout), 1);
});

// The change. Was: the value was invisible, both defaults were used, and the
// run reported on the install's own tracker without saying so.
test('--flag=value reads the file it names', () => {
  const dir = fixture();
  const r = run(`--apps-file=${join(dir, 'apps.md')}`, `--interviews-file=${join(dir, 'interviews.md')}`);
  assert.equal(r.status, 0);
  assert.equal(rowsChecked(r.stdout), 1);
});

// ADR 0004 #6 is pinned at the module level in tests/core/flags.test.mjs; what
// matters here is only that the fallback path still works.
test('a trailing value flag with nothing after it falls back to the default', () => {
  const r = run('--apps-file');
  assert.equal(r.status, 0);
});

// ── Missing-file contract (ADR 0004 #7: empty on absent, throw on unreadable) ──

test('an absent file is an empty read, not an error', () => {
  const dir = fixture();
  const r = run(`--apps-file=${join(dir, 'nope.md')}`, `--interviews-file=${join(dir, 'interviews.md')}`);
  assert.equal(r.status, 0);
  assert.equal(rowsChecked(r.stdout), 1, 'the interviews row is still compared, against no tracker');
});

test('both files absent is an empty report, not a crash', () => {
  const dir = fixture();
  const r = run(`--apps-file=${join(dir, 'a.md')}`, `--interviews-file=${join(dir, 'b.md')}`);
  assert.equal(r.status, 0);
  assert.equal(rowsChecked(r.stdout), 0);
});

// The change. Was: existsSync() answers false for a file behind a directory
// this process cannot traverse, so an unreadable tracker read as an empty one
// and the run reported "0 rows" for a check it had not performed (ADR 0006).
test('an unreadable file is reported, not silently read as empty', { skip: process.getuid?.() === 0 }, () => {
  const dir = fixture();
  const walled = join(dir, 'walled');
  mkdirSync(walled);
  writeFileSync(join(walled, 'apps.md'), APPS);
  chmodSync(walled, 0o000);
  try {
    const r = run(`--apps-file=${join(walled, 'apps.md')}`, `--interviews-file=${join(dir, 'interviews.md')}`);
    assert.notEqual(r.status, 0, 'an unperformed read must not exit 0');
    assert.match(r.stderr, /EACCES|permission denied/i);
  } finally {
    chmodSync(walled, 0o700);
  }
});
