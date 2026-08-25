/**
 * Tests for src/commands/scan.js — the `scan` noun's nine command adapters.
 *
 * The adapters own three things and nothing else: what flags a verb accepts,
 * whether the check can run at all, and how the delegate's result becomes an
 * ADR 0006 envelope. Everything here tests one of those three, and the exit-code
 * assertions are the point of the file: 1 and 3 are deliberately distinct, so a
 * check that never ran must never reach a caller as an empty result.
 *
 * The delegates are replaced with one-line stand-ins in a sandbox root. That is
 * not mocking for its own sake — it is the only way to drive a real child
 * process through every exit path without a network, a browser, or a scan that
 * writes to the pipeline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { noun, commands } from '../../src/commands/scan.js';
import { EXIT } from '../../src/core/flags.js';

/** ADR 0003's scan rows, after the renames recorded in src/commands/scan.js. */
const VERBS = ['run', 'ats-full', 'hn', 'interamt', 'extract', 'liveness', 'discover', 'validate-portals', 'verify-portals'];

const sandboxes = [];
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'scan-cmd-'));
  sandboxes.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a stand-in delegate that runs `body` with `args` already in scope.
 *
 * Stand-ins set `process.exitCode` rather than calling exit: tests/run-all.mjs
 * greps discovered suites for that call and refuses to import a file
 * containing it, even inside a string.
 */
function fakeDelegate(root, name, body) {
  // `name` is repo-relative, so a delegate under src/scripts/ needs its parent.
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), `const args = process.argv.slice(2);\n${body}\n`, 'utf-8');
}

/** Every envelope must satisfy the ADR 0006 shape, whatever produced it. */
function assertEnvelope(result, command) {
  const env = result.envelope;
  assert.deepEqual(Object.keys(env).sort(), ['command', 'data', 'errors', 'ok', 'warnings']);
  assert.equal(env.command, command);
  assert.equal(typeof env.ok, 'boolean');
  assert.equal(typeof env.data, 'object');
  assert.ok(Array.isArray(env.warnings));
  assert.ok(Array.isArray(env.errors));
  // The invariant the whole contract rests on: the exit code and `ok` can never
  // disagree, and a failure always says why.
  assert.equal(env.ok, result.exitCode === EXIT.OK, `ok must track exit code (${command}, exit ${result.exitCode})`);
  if (!env.ok) assert.ok(env.errors.length > 0, 'a failed envelope must carry an error');
  else assert.equal(env.errors.length, 0);
}

// ── module shape ─────────────────────────────────────────────────────

test('exports the scan noun with every ADR 0003 row', () => {
  assert.equal(noun, 'scan');
  assert.deepEqual(Object.keys(commands).sort(), [...VERBS].sort());
});

test('every verb exposes run, help and flags', () => {
  for (const verb of VERBS) {
    const cmd = commands[verb];
    assert.equal(typeof cmd.run, 'function', verb);
    assert.equal(typeof cmd.help, 'string', verb);
    assert.equal(typeof cmd.flags, 'object', verb);
    assert.equal(typeof cmd.description, 'string', verb);
  }
});

// ── --help and --json, required of every command ─────────────────────

test('--help documents the command, both implicit flags and all five exit codes', () => {
  for (const verb of VERBS) {
    const res = commands[verb].run(['--help']);
    assert.equal(res.exitCode, EXIT.OK, verb);
    assertEnvelope(res, `scan ${verb}`);
    assert.equal(res.text, res.envelope.data.help, verb);
    for (const needle of ['Usage:', '--json', '--help', 'Exit codes:', 'could not verify']) {
      assert.ok(res.text.includes(needle), `${verb} --help is missing "${needle}"`);
    }
    assert.ok(res.text.includes(`career-ops scan ${verb}`), `${verb} --help does not name itself`);
  }
});

test('--help works with no other input, even where the verb requires an operand', () => {
  // parseFlags checks positional arity after --help, so `scan extract --help`
  // prints help rather than complaining about the URL it was never given.
  const res = commands.extract.run(['--help']);
  assert.equal(res.exitCode, EXIT.OK);
});

test('every verb answers --json with a valid envelope', () => {
  const root = sandbox();
  for (const verb of VERBS) {
    const res = commands[verb].run(['--json', '--help'], { root });
    assertEnvelope(res, `scan ${verb}`);
  }
});

test('an unknown flag is a usage error on every verb, not a failed check', () => {
  const root = sandbox();
  for (const verb of VERBS) {
    const res = commands[verb].run(['--not-a-flag'], { root });
    assert.equal(res.exitCode, EXIT.USAGE, verb);
    assertEnvelope(res, `scan ${verb}`);
    assert.equal(res.envelope.errors[0].code, 'unknown-flag', verb);
  }
});

// ── could not verify: exit 3, never an empty exit 0 ──────────────────

test('a missing delegate is could-not-verify, not a failed check', () => {
  const root = sandbox();
  for (const verb of VERBS) {
    const res = commands[verb].run(['--json', ...(verb === 'extract' ? ['https://example.com/j'] : []), ...(verb === 'liveness' ? ['https://example.com/j'] : []), ...(verb === 'discover' ? ['Stripe'] : [])], { root });
    assert.equal(res.exitCode, EXIT.UNVERIFIED, verb);
    assert.equal(res.envelope.ok, false, verb);
    assert.match(res.envelope.errors[0].message, /could not verify/, verb);
    assert.equal(res.envelope.errors[0].code, 'could-not-verify', verb);
  }
});

test('verify-portals reports exit 3 for a missing portals file and never spawns the delegate', () => {
  // Deliberate divergence: verify-portals.mjs prints "nothing to verify" and
  // exits 0. A file that is not there is a check that did not run, so the CLI
  // says 3 (ADR 0006 — the shim keeps the old code, the CLI does not inherit
  // the inconsistency). The frozen script itself is untouched.
  const root = sandbox();
  // A real marker write, so a delegate that DID run would be visible: an
  // import that throws would leave the file absent and pass the check for the
  // wrong reason.
  fakeDelegate(root, 'verify-portals.mjs', `import { writeFileSync as w } from 'node:fs';\nw('spawned', 'yes');`);
  const res = commands['verify-portals'].run(['--json'], { root });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.equal(res.envelope.ok, false);
  assert.match(res.envelope.errors[0].message, /no portals file at/);
  assert.equal(existsSync(path.join(root, 'spawned')), false, 'the delegate must not run when its input is absent');
});

test('validate-portals reports exit 3 for a missing portals file', () => {
  const root = sandbox();
  fakeDelegate(root, 'src/scripts/validate-portals.mjs', '');
  const res = commands['validate-portals'].run(['--json'], { root });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /no portals file at/);
});

test('liveness reports exit 3 for a --file that is not there', () => {
  const root = sandbox();
  fakeDelegate(root, 'src/scripts/check-liveness.mjs', '');
  const res = commands.liveness.run(['--json', '--file=nope.txt'], { root });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /URL list not found/);
});

test('discover reports exit 3 for an --in file that is not there', () => {
  const root = sandbox();
  fakeDelegate(root, 'src/scripts/discover-ats.mjs', '');
  const res = commands.discover.run(['--json', '--in=missing.yml'], { root });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /input file not found/);
});

test('a machine-readable verb that exits 0 without JSON is could-not-verify', () => {
  // The exact "reported success having produced nothing" shape ADR 0006 exists
  // to remove: a clean exit is not evidence the check ran.
  const root = sandbox();
  fakeDelegate(root, 'src/scripts/browser-extract.mjs', `console.log('all good');`);
  const res = commands.extract.run(['--json', 'https://example.com/jobs/1'], { root });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.equal(res.envelope.ok, false);
  assert.match(res.envelope.errors[0].message, /without a JSON result/);
});

test('a delegate killed by a signal is could-not-verify, not a failure', () => {
  const root = sandbox();
  fakeDelegate(root, 'scan.mjs', `process.kill(process.pid, 'SIGKILL');`);
  const res = commands.run.run(['--json'], { root });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /killed by SIGKILL/);
});

// ── delegate exit codes ──────────────────────────────────────────────

test('a delegate exiting 0 is exit 0 and ok', () => {
  const root = sandbox();
  fakeDelegate(root, 'scan.mjs', `console.log('2 new postings');`);
  const res = commands.run.run(['--json'], { root });
  assert.equal(res.exitCode, EXIT.OK);
  assertEnvelope(res, 'scan run');
  assert.equal(res.envelope.data.output.trim(), '2 new postings');
  assert.equal(res.envelope.data.delegate, 'scan.mjs');
});

test('a delegate exiting non-zero is a failed check, with its stderr named', () => {
  const root = sandbox();
  fakeDelegate(root, 'scan.mjs', `console.error('Fatal: portal returned 500'); process.exitCode = 7;`);
  const res = commands.run.run(['--json'], { root });
  assert.equal(res.exitCode, EXIT.FAILED);
  assertEnvelope(res, 'scan run');
  assert.equal(res.envelope.errors[0].code, 'delegate-failed');
  assert.match(res.envelope.errors[0].message, /exited 7/);
  assert.match(res.envelope.errors[0].message, /portal returned 500/);
});

test('the delegate under src/ wins over the root filename', () => {
  // ADR 0005 step 5 moved the unfrozen scripts into src/. A same-named leftover
  // at the root must not shadow the one the spec names.
  const root = sandbox();
  fakeDelegate(root, 'scan-hn.mjs', `console.log('root'); process.exitCode = 1;`);
  fakeDelegate(root, 'src/scripts/scan-hn.mjs', `console.log('moved');`);
  const res = commands.hn.run(['--json'], { root });
  assert.equal(res.exitCode, EXIT.OK);
  assert.equal(res.envelope.data.output.trim(), 'moved');
});

test('a delegate that resolves to the running script is a config error, not a fork bomb', () => {
  const root = sandbox();
  fakeDelegate(root, 'scan.mjs', '');
  const res = commands.run.run(['--json'], { root, entry: path.join(root, 'scan.mjs') });
  assert.equal(res.exitCode, EXIT.CONFIG);
  assert.equal(res.envelope.errors[0].code, 'self-delegation');
});

// ── flag mapping ─────────────────────────────────────────────────────

test('flags reach the delegate in the form it reads', () => {
  const root = sandbox();
  fakeDelegate(root, 'scan.mjs', `console.log(JSON.stringify(args));`);
  const res = commands.run.run(['--json', '--dry-run', '--company', 'Acme Corp', '--since=7'], { root });
  assert.equal(res.exitCode, EXIT.OK);
  const argv = JSON.parse(res.envelope.data.output);
  assert.deepEqual(argv, ['--dry-run', '--company=Acme Corp', '--since=7']);
});

test('--throttle-ms is the CLI spelling of the delegate\'s --throttle=<ms>', () => {
  // src/core/flags.js has no optional-value flag type, and `--throttle` is
  // bare-or-`=ms` in the delegate. Splitting it is the only way to keep both
  // forms reachable; the frozen script's own argv is unchanged.
  const root = sandbox();
  fakeDelegate(root, 'scan.mjs', `console.log(JSON.stringify(args));`);
  const bare = commands.run.run(['--json', '--verify', '--throttle'], { root });
  assert.deepEqual(JSON.parse(bare.envelope.data.output), ['--verify', '--throttle']);
  const ms = commands.run.run(['--json', '--verify', '--throttle-ms', '8000'], { root });
  assert.deepEqual(JSON.parse(ms.envelope.data.output), ['--verify', '--throttle=8000']);
});

test('liveness keeps --file space-separated, because the delegate reads it positionally', () => {
  const root = sandbox();
  writeFileSync(path.join(root, 'urls.txt'), 'https://example.com/j\n', 'utf-8');
  fakeDelegate(root, 'src/scripts/check-liveness.mjs', `console.log(JSON.stringify(args));`);
  const res = commands.liveness.run(['--json', '--no-fallback', '--file', 'urls.txt'], { root });
  assert.deepEqual(JSON.parse(res.envelope.data.output), ['--file', 'urls.txt', '--no-fallback']);
});

test('liveness rejects --file together with URL arguments', () => {
  const root = sandbox();
  fakeDelegate(root, 'src/scripts/check-liveness.mjs', '');
  const res = commands.liveness.run(['--file=urls.txt', 'https://example.com/j'], { root });
  assert.equal(res.exitCode, EXIT.USAGE);
  assert.equal(res.envelope.errors[0].code, 'invalid-arguments');
});

test('positional company names are forwarded to discover', () => {
  const root = sandbox();
  fakeDelegate(root, 'src/scripts/discover-ats.mjs', `console.log(JSON.stringify({ argv: args }));`);
  const res = commands.discover.run(['--json', '--vendors=gh,ashby', 'Stripe', 'Ramp'], { root });
  assert.equal(res.exitCode, EXIT.OK);
  assert.deepEqual(res.envelope.data.result.argv, ['--vendors=gh,ashby', 'Stripe', 'Ramp']);
});

test('discover with --summary falls back to prose, since the delegate stops emitting JSON', () => {
  const root = sandbox();
  fakeDelegate(root, 'src/scripts/discover-ats.mjs', `console.log('| Stripe | greenhouse |');`);
  const res = commands.discover.run(['--json', '--summary', 'Stripe'], { root });
  assert.equal(res.exitCode, EXIT.OK);
  assert.match(res.envelope.data.output, /Stripe/);
});

// ── scan ats-full: degraded is not empty ─────────────────────────────

test('ats-full forwards --json and returns the delegate result as data', () => {
  const root = sandbox();
  fakeDelegate(root, 'scan-ats-full.mjs', `
    if (!args.includes('--json')) { console.error('no --json'); process.exitCode = 9; }
    else console.log(JSON.stringify({ datasetStatus: 'ok', postingsKept: 4, capHit: false, argv: args }));`);
  const res = commands['ats-full'].run(['--json', '--since=7'], { root });
  assert.equal(res.exitCode, EXIT.OK);
  assertEnvelope(res, 'scan ats-full');
  assert.equal(res.envelope.data.result.postingsKept, 4);
  assert.deepEqual(res.envelope.data.result.argv, ['--since=7', '--json']);
});

test('ats-full turns an unreachable dataset into exit 3, not a clean empty scan', () => {
  // scan-ats-full.mjs exits 0 with zero postings when no company list was
  // reachable and no cache existed. That is the "nothing found" reading of a
  // check that never ran, and it is precisely what ADR 0006 forbids.
  const root = sandbox();
  fakeDelegate(root, 'scan-ats-full.mjs', `console.log(JSON.stringify({ datasetStatus: 'empty', postingsKept: 0 }));`);
  const res = commands['ats-full'].run(['--json'], { root });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.equal(res.envelope.ok, false);
  assert.match(res.envelope.errors[0].message, /did not run/);
  // The partial result is kept: could-not-verify is not could-not-say-anything.
  assert.equal(res.envelope.data.result.datasetStatus, 'empty');
});

test('ats-full reports a degraded-but-real sweep as a warning, still exit 0', () => {
  const root = sandbox();
  fakeDelegate(root, 'scan-ats-full.mjs', `console.log(JSON.stringify({ datasetStatus: 'stale', stoppedByOutage: true, capHit: true, postingsKept: 2 }));`);
  const res = commands['ats-full'].run(['--json'], { root });
  assert.equal(res.exitCode, EXIT.OK);
  assertEnvelope(res, 'scan ats-full');
  assert.equal(res.envelope.warnings.length, 3);
  assert.match(res.envelope.warnings.join(' '), /expired cache/);
  assert.match(res.envelope.warnings.join(' '), /--resume/);
});
