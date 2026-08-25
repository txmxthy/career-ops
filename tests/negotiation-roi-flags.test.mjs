/**
 * Characterisation of src/scripts/negotiation-roi.mjs's flag reading, taken as it moved
 * from src/lib/cli-flags.mjs onto src/core/flags.js.
 *
 * The file already states the contract it wants: "Argument validation runs
 * before any filesystem/live-data requirement, so a malformed flag fails fast
 * with a clear error rather than being masked by an unrelated 'story-bank.md
 * not found' message." One shape defeated it — `--wage --summary` handed the
 * flag itself over as the wage, so `hasFlag && flagValue === undefined` never
 * fired and the run died on the missing story bank instead. ADR 0004 #6 closes
 * exactly that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'src/scripts/negotiation-roi.mjs');

function run(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 20_000,
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return r;
}

test('--self-test still passes', () => {
  assert.equal(run('--self-test').status, 0);
});

test('a value flag with nothing after it is a usage error', () => {
  const r = run('--wage');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Error: --wage requires a value\./);
});

test('--occurrences with nothing after it is a usage error', () => {
  const r = run('--occurrences');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Error: --occurrences requires a value\./);
});

// The change. Was: '--summary' became the wage, validation passed, and the run
// failed on whichever user-layer file was missing first.
test('a value flag does not swallow the following flag as its value', () => {
  const r = run('--wage', '--summary');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Error: --wage requires a value\./);
  assert.doesNotMatch(r.stderr, /story-bank/, 'the flag error must not be masked by a missing-file error');
});

test('--occurrences does not swallow the following flag either', () => {
  const r = run('--occurrences', '--wage', '50');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Error: --occurrences requires a value\./);
});

// Unchanged: the `=` form carries its own operand, so an empty one is not a
// missing one here. flagValue returns '', which is not undefined, and the run
// proceeds to the user-layer file checks exactly as before.
test('--wage= keeps its existing behaviour', () => {
  const r = run('--wage=');
  assert.doesNotMatch(r.stderr, /--wage requires a value/);
});
