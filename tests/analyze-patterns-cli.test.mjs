/**
 * Characterisation of analyze-patterns.mjs's CLI surface across its move onto
 * src/core/{store,flags}.js.
 *
 * The script has no exports, so its inputs — where the tracker comes from and
 * how the two numeric flags are read — are only observable through argv and
 * stdout. Both changed deliberately and are pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'analyze-patterns.mjs');

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | Via |',
  '|---|------|---------|------|-------|--------|-----|',
  '| 1 | 2026-01-05 | Acme | Engineer | 8 | applied | linkedin.com |',
  '| 2 | 2026-01-06 | Beta | Engineer | 7 | rejected | linkedin.com |',
  '| 3 | 2026-01-07 | Gamma | Engineer | 9 | interview | greenhouse.io |',
  '',
].join('\n');

let dir;
const trackerPath = () => {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'co-apx-'));
    writeFileSync(join(dir, 'applications.md'), TRACKER);
  }
  return join(dir, 'applications.md');
};
process.on('exit', () => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// Returns stdout regardless of the exit code: "not enough data" is a
// non-zero exit that still prints the line under test.
function run(args, env = {}) {
  const opts = {
    cwd: ROOT, encoding: 'utf-8', timeout: 30000,
    env: { ...process.env, CAREER_OPS_TRACKER: trackerPath(), ...env },
  };
  try {
    return execFileSync(process.execPath, [SCRIPT, ...args], opts);
  } catch (err) {
    if (err.stdout == null) throw err;
    return err.stdout;
  }
}

test('DELIBERATE: CAREER_OPS_TRACKER selects the tracker', () => {
  // The path was joined onto the script directory, so the override every other
  // tracker reader honours was silently ignored here and the report described
  // a different workspace's data.
  // Three rows in the fixture, against the default threshold of five.
  assert.match(run(['--summary']), /Not enough data: 3\/5/);
});

test('--min-threshold is honoured in the space-separated form', () => {
  assert.match(run(['--summary', '--min-threshold', '9']), /Not enough data: 3\/9/);
});

test('DELIBERATE: --min-threshold is honoured in the = form', () => {
  // `indexOf('--min-threshold')` cannot see `--min-threshold=9`, so the value
  // was dropped and the default of 5 was used without a word (audit A4).
  assert.match(run(['--summary', '--min-threshold=9']), /Not enough data: 3\/9/);
});

test('a non-numeric --min-threshold falls back to the default of 5', () => {
  assert.match(run(['--summary', '--min-threshold', 'abc']), /Not enough data: 3\/5/);
});

test('an absent --min-threshold uses the default of 5', () => {
  assert.match(run(['--summary']), /Not enough data: 3\/5/);
});

test('DELIBERATE: a value flag left without an operand falls back to its default', () => {
  // `--min-threshold --summary` used to read '--summary' as the threshold.
  // parseInt made that NaN and so the default already applied here; the flag
  // that follows is now also left intact for its own reader.
  assert.match(run(['--min-threshold', '--summary']), /Not enough data: 3\/5/);
});

test('--self-test still passes', () => {
  assert.match(run(['--self-test']), /self-test OK/);
});
