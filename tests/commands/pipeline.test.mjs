/**
 * Tests for src/commands/pipeline.js — the `pipeline` noun's command adapters.
 *
 * Two layers, deliberately:
 *
 *   1. Injected-spawn tests pin the TRANSLATION — which delegate output becomes
 *      which exit code and which envelope. These are the rules the adapter owns,
 *      so they are tested without a child process.
 *   2. Real end-to-end tests pin the CONTRACT the translation depends on: that
 *      verify-pipeline.mjs still emits the ✅/⚠️/❌ vocabulary and the
 *      "Pipeline Health" tally, and that agent-inbox.mjs still prints
 *      "Queued:" / "Resolved #n:". If either script's output changes, layer 1
 *      keeps passing and layer 2 fails — which is the point. A parser tested
 *      only against its own fixtures is a parser that cannot notice drift.
 *
 * The end-to-end tests are hermetic: CAREER_OPS_TRACKER, CAREER_OPS_REPORTS and
 * CAREER_OPS_INBOX are all pointed into a temp directory, so nothing here reads
 * or writes the checkout's own tracker, reports or queue.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pipeline, { noun, commands } from '../../src/commands/pipeline.js';
import { EXIT } from '../../src/core/flags.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const VERBS = ['verify', 'inbox-add', 'inbox-list', 'inbox-resolve'];

/** A temp dir removed when the process ends, without a cleanup hook per test. */
const temps = [];
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `pipeline-${label}-`));
  temps.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of temps) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Assert the ADR 0006 envelope shape and its two invariants. */
function assertEnvelope(env, command) {
  assert.equal(typeof env, 'object', 'envelope is an object');
  assert.deepEqual(
    Object.keys(env).sort(),
    ['command', 'data', 'errors', 'ok', 'warnings'],
    'envelope has exactly the ADR 0006 keys',
  );
  assert.equal(env.command, command);
  assert.equal(typeof env.ok, 'boolean');
  assert.equal(typeof env.data, 'object');
  assert.ok(Array.isArray(env.warnings));
  assert.ok(Array.isArray(env.errors));
  for (const e of env.errors) {
    assert.equal(typeof e.code, 'string');
    assert.equal(typeof e.message, 'string');
  }
  // The invariant the whole contract rests on: a failure always says why, and a
  // success never carries an error.
  if (env.ok === false) assert.ok(env.errors.length > 0, 'a failed envelope carries at least one error');
  else assert.equal(env.errors.length, 0, 'a successful envelope carries no errors');
  // Every envelope must survive the round trip an agent will actually do.
  assert.deepEqual(JSON.parse(JSON.stringify(env)), env, 'envelope is JSON-round-trippable');
}

/** A spawn stand-in returning a canned child result. */
const spawnReturning = (result) => () => ({ status: 0, stdout: '', stderr: '', signal: null, ...result });

/** Context for the injected-spawn tests: the real root (so the delegate scripts
 *  are found on disk) with a fake child. */
const withSpawn = (result, extra = {}) => ({ root: ROOT, spawn: spawnReturning(result), ...extra });

// ── module surface ───────────────────────────────────────────────────

test('exports the noun and one entry per command', () => {
  assert.equal(noun, 'pipeline');
  assert.equal(pipeline.noun, 'pipeline');
  assert.deepEqual(Object.keys(commands).sort(), [...VERBS].sort());
  for (const verb of VERBS) {
    const cmd = commands[verb];
    assert.equal(typeof cmd.run, 'function', `${verb}.run is a function`);
    assert.equal(typeof cmd.help, 'string', `${verb}.help is rendered text`);
    assert.equal(typeof cmd.flags, 'object', `${verb}.flags is a map`);
  }
});

// ── --help, on every command ─────────────────────────────────────────

test('--help prints usage and the exit-code table, and exits 0', async () => {
  for (const verb of VERBS) {
    const r = await commands[verb].run(['--help'], { root: ROOT });
    assert.equal(r.exitCode, EXIT.OK, `${verb} --help exits 0`);
    assert.match(r.text, /^Usage: career-ops pipeline /m, `${verb} --help shows its usage line`);
    assert.match(r.text, /Exit codes:/, `${verb} --help documents exit codes`);
    assert.match(r.text, /3 {2}could not verify/, `${verb} --help documents code 3`);
    assertEnvelope(r.envelope, `pipeline ${verb}`);
    assert.equal(r.envelope.ok, true);
    assert.ok(r.envelope.data.help.length > 0);
  }
});

test('every command answers --json even when it declares no flags', async () => {
  for (const verb of VERBS) {
    assert.match(commands[verb].help, /--json/, `${verb} --help documents --json`);
    const r = await commands[verb].run(['--help', '--json'], { root: ROOT });
    assert.equal(r.json, true, `${verb} honours --json`);
    assertEnvelope(r.envelope, `pipeline ${verb}`);
  }
});

test('--help is answered without ever reaching the delegate', async () => {
  // A spawn that throws proves the help path does no work: if --help spawned,
  // this would blow up rather than return.
  const explode = () => { throw new Error('the delegate must not be spawned for --help'); };
  for (const verb of VERBS) {
    const r = await commands[verb].run(['--help'], { root: ROOT, spawn: explode });
    assert.equal(r.exitCode, EXIT.OK);
  }
});

// ── usage errors are 2, not 1 ────────────────────────────────────────

test('an unknown flag is a usage error (2), not a finding (1)', async () => {
  for (const verb of VERBS) {
    const r = await commands[verb].run(['--bogus'], { root: ROOT });
    assert.equal(r.exitCode, EXIT.USAGE, `${verb} --bogus exits 2`);
    assertEnvelope(r.envelope, `pipeline ${verb}`);
    assert.equal(r.envelope.ok, false);
    assert.deepEqual(r.envelope.errors.map((e) => e.code), ['unknown-flag']);
    assert.match(r.text, /Usage: /, 'the usage error shows how to correct it');
  }
});

test('inbox-add without a request is a usage error, not an empty queue write', async () => {
  const r = await commands['inbox-add'].run([], { root: ROOT });
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.envelope.ok, false);
  assert.deepEqual(r.envelope.errors.map((e) => e.code), ['missing-positional']);
});

test('inbox-resolve takes exactly one item number', async () => {
  const r = await commands['inbox-resolve'].run(['1', '2'], { root: ROOT });
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.deepEqual(r.envelope.errors.map((e) => e.code), ['unexpected-positional']);
});

// ── could-not-run is 3 on every command ──────────────────────────────

test('a missing delegate is could-not-verify (3), never an empty pass', async () => {
  const empty = tempDir('no-delegate');
  const argv = { verify: [], 'inbox-add': ['do a thing'], 'inbox-list': [], 'inbox-resolve': ['1'] };
  for (const verb of VERBS) {
    const r = await commands[verb].run(argv[verb], { root: empty, cwd: empty, env: {} });
    assert.equal(r.exitCode, EXIT.UNVERIFIED, `${verb} exits 3 when its delegate is missing`);
    assertEnvelope(r.envelope, `pipeline ${verb}`);
    assert.equal(r.envelope.ok, false, `${verb} reports ok:false`);
    assert.deepEqual(r.envelope.errors.map((e) => e.code), ['could-not-verify']);
    assert.match(r.envelope.errors[0].message, /^could not verify: /);
    assert.deepEqual(r.envelope.data, {}, 'no results are invented for a check that did not run');
  }
});

test('a delegate that fails to start is could-not-verify, not a clean run', async () => {
  const r = await commands.verify.run([], {
    root: ROOT,
    spawn: () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }),
  });
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.equal(r.envelope.ok, false);
  assert.match(r.envelope.errors[0].message, /ENOENT/);
});

test('a delegate killed on a timeout is could-not-verify, not a pass', async () => {
  // status is null when the child dies on a signal. Read as "not 1", it looks
  // like success — which is how a timed-out health check reports green.
  const r = await commands.verify.run([], {
    root: ROOT,
    spawn: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),
  });
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.equal(r.envelope.ok, false);
  assert.match(r.envelope.errors[0].message, /SIGTERM/);
});

// ── verify: output translation ───────────────────────────────────────

const verifyStdout = (lines, errs, warns) => [
  '',
  '📊 Checking 3 entries in applications.md',
  '',
  ...lines,
  '',
  '='.repeat(50),
  `📊 Pipeline Health: ${errs} errors, ${warns} warnings`,
  errs === 0 && warns === 0 ? '🟢 Pipeline is clean!' : errs === 0 ? '🟡 Pipeline OK with warnings' : '🔴 Pipeline has errors — fix before proceeding',
  '',
].join('\n');

test('verify: a clean run is ok with the checks it passed', async () => {
  const stdout = verifyStdout(['✅ All statuses are canonical', '✅ No exact duplicates found'], 0, 0);
  const r = await commands.verify.run([], withSpawn({ status: 0, stdout }));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r.envelope, 'pipeline verify');
  assert.equal(r.envelope.ok, true);
  assert.equal(r.envelope.data.entries, 3);
  assert.deepEqual(r.envelope.data.passed, ['All statuses are canonical', 'No exact duplicates found']);
  assert.deepEqual(r.envelope.data.counts, { errors: 0, warnings: 0 });
  assert.equal(r.text, stdout, 'prose mode passes the delegate output through unchanged');
});

test('verify: findings become envelope errors and exit 1', async () => {
  const stdout = verifyStdout([
    '❌ #12: Non-canonical status "pendiente"',
    '⚠️  Possible duplicates: #3, #9 (Acme — SRE)',
    '✅ All report links valid',
  ], 1, 1);
  const r = await commands.verify.run([], withSpawn({ status: 1, stdout }));
  assert.equal(r.exitCode, EXIT.FAILED, 'a real negative finding is 1, not 3');
  assertEnvelope(r.envelope, 'pipeline verify');
  assert.equal(r.envelope.ok, false);
  assert.deepEqual(r.envelope.errors, [
    { code: 'pipeline-check-failed', message: '#12: Non-canonical status "pendiente"' },
  ]);
  assert.deepEqual(r.envelope.warnings, ['Possible duplicates: #3, #9 (Acme — SRE)']);
  assert.deepEqual(r.envelope.data.counts, { errors: 1, warnings: 1 });
});

test('verify: warnings alone stay ok, and stay visible', async () => {
  const stdout = verifyStdout(['⚠️  2 pending TSVs in tracker-additions/ (not merged)', '✅ All scores valid'], 0, 1);
  const r = await commands.verify.run([], withSpawn({ status: 0, stdout }));
  assert.equal(r.exitCode, EXIT.OK);
  assert.equal(r.envelope.ok, true);
  assert.deepEqual(r.envelope.warnings, ['2 pending TSVs in tracker-additions/ (not merged)']);
});

test('verify: a glyph inside a message is not counted as a second finding', async () => {
  // The anchor matters: an unanchored search would find the ⚠️ inside this
  // company name and report a warning the delegate never raised, which then
  // disagrees with the tally and reports the whole run unverified.
  const stdout = verifyStdout(['✅ Via channels consistent — company "⚠️ Ltd" is fine'], 0, 0);
  const r = await commands.verify.run([], withSpawn({ status: 0, stdout }));
  assert.equal(r.exitCode, EXIT.OK);
  assert.deepEqual(r.envelope.warnings, []);
});

test('verify: the fresh-setup early exit is 3, not a clean pipeline', async () => {
  // verify-pipeline.mjs prints this and exits 0. Fourteen checks were skipped;
  // reporting that as a pass is the "nothing found" conflation ADR 0006 bans.
  const stdout = '\n📊 No applications.md found. This is normal for a fresh setup.\n   The file will be created when you evaluate your first offer.\n\n';
  const r = await commands.verify.run([], withSpawn({ status: 0, stdout }));
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.equal(r.envelope.ok, false);
  assert.deepEqual(r.envelope.errors.map((e) => e.code), ['could-not-verify']);
  assert.match(r.envelope.errors[0].message, /none of the pipeline checks could run/);
});

test('verify: exit 1 with no findings is unverified, not a silent pass', async () => {
  // What a crash looks like: node unwinds, exit 1, nothing on stdout. Trusting
  // the glyphs alone would report zero errors; trusting the status alone would
  // report a failure with nothing to show for it.
  const r = await commands.verify.run([], withSpawn({ status: 1, stdout: '', stderr: 'TypeError: x is not a function' }));
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.equal(r.envelope.ok, false);
  assert.match(r.envelope.errors[0].message, /TypeError/);
});

test('verify: exit 0 with a finding on stdout is unverified', async () => {
  const stdout = verifyStdout(['❌ #4: Invalid score format: ""'], 1, 0);
  const r = await commands.verify.run([], withSpawn({ status: 0, stdout }));
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.match(r.envelope.errors[0].message, /exit 0 with 1 error line/);
});

test('verify: a tally that disagrees with the lines is unverified', async () => {
  // The delegate counted three warnings and printed one. Reporting one would be
  // reporting a result for a run that is not internally consistent.
  const stdout = verifyStdout(['⚠️  Orphan report — no tracker row references #7: reports/007-x-2026-01-01.md'], 0, 3);
  const r = await commands.verify.run([], withSpawn({ status: 0, stdout }));
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.match(r.envelope.errors[0].message, /summary says 0 errors \/ 3 warnings but 0 \/ 1 were reported/);
});

test('verify: silence at exit 0 is unverified, not a clean pipeline', async () => {
  const r = await commands.verify.run([], withSpawn({ status: 0, stdout: '' }));
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.equal(r.envelope.ok, false);
  assert.match(r.envelope.errors[0].message, /no check lines at all/);
});

// ── inbox: output translation ────────────────────────────────────────

test('inbox-add: a confirmed append is ok with what was queued', async () => {
  const r = await commands['inbox-add'].run(['evaluate', 'https://acme.test/jobs/42'], withSpawn({ status: 0, stdout: 'Queued: evaluate https://acme.test/jobs/42\n' }));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r.envelope, 'pipeline inbox-add');
  assert.equal(r.envelope.data.queued, 'evaluate https://acme.test/jobs/42');
});

test('inbox-add: exit 0 without a confirmation is unverified', async () => {
  const r = await commands['inbox-add'].run(['x'], withSpawn({ status: 0, stdout: '' }));
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.match(r.envelope.errors[0].message, /may not be queued/);
});

test('inbox-add: a lock timeout is could-not-run, not a failed request', async () => {
  const r = await commands['inbox-add'].run(['x'], withSpawn({ status: 1, stdout: '', stderr: 'LockTimeoutError: timed out after 30000ms' }));
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.match(r.envelope.errors[0].message, /LockTimeoutError/);
});

test("inbox-add: the delegate's own arity failure is translated to a usage error", async () => {
  const r = await commands['inbox-add'].run(['x'], withSpawn({ status: 1, stderr: 'agent-inbox.mjs: add needs a request, e.g. node agent-inbox.mjs add "evaluate https://..."\n' }));
  assert.equal(r.exitCode, EXIT.USAGE, 'ADR 0006 gives usage errors 2; the delegate exits 1');
  assert.equal(r.envelope.ok, false);
});

test('inbox-list: items are parsed out of the rendered list', async () => {
  const inbox = join(tempDir('list'), 'agent-inbox.md');
  writeFileSync(inbox, '# Agent Inbox\n');
  const stdout = ' 1. [ ] 2026-08-24 10:00 — evaluate https://acme.test/jobs/42\n 2. [x] 2026-08-23 09:00 — draft a follow-up for #7 → result: sent\n';
  const r = await commands['inbox-list'].run(['--all'], withSpawn({ status: 0, stdout }, { cwd: dirname(inbox), env: { CAREER_OPS_INBOX: inbox } }));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r.envelope, 'pipeline inbox-list');
  assert.equal(r.envelope.data.all, true);
  assert.equal(r.envelope.data.exists, true);
  assert.deepEqual(r.envelope.data.items, [
    { n: 1, done: false, text: '2026-08-24 10:00 — evaluate https://acme.test/jobs/42' },
    { n: 2, done: true, text: '2026-08-23 09:00 — draft a follow-up for #7 → result: sent' },
  ]);
  assert.deepEqual(r.envelope.warnings, []);
});

test('inbox-list: an empty queue and a missing queue are different answers', async () => {
  const dir = tempDir('list-missing');
  const stdout = 'No pending items.\n';
  const ctx = { cwd: dir, env: { CAREER_OPS_INBOX: join(dir, 'agent-inbox.md') } };

  const missing = await commands['inbox-list'].run([], withSpawn({ status: 0, stdout }, ctx));
  assert.equal(missing.exitCode, EXIT.OK, 'listing did run, so this is not a code 3');
  assert.equal(missing.envelope.data.exists, false);
  assert.deepEqual(missing.envelope.data.items, []);
  assert.equal(missing.envelope.warnings.length, 1);
  assert.match(missing.envelope.warnings[0], /no queue file at /);

  writeFileSync(join(dir, 'agent-inbox.md'), '# Agent Inbox\n');
  const empty = await commands['inbox-list'].run([], withSpawn({ status: 0, stdout }, ctx));
  assert.equal(empty.envelope.data.exists, true);
  assert.deepEqual(empty.envelope.data.items, []);
  assert.deepEqual(empty.envelope.warnings, [], 'an empty queue is not a warning');
});

test('inbox-resolve: no queue file is 3; an out-of-range item is 1', async () => {
  const dir = tempDir('resolve');
  const inbox = join(dir, 'agent-inbox.md');
  const ctx = { cwd: dir, env: { CAREER_OPS_INBOX: inbox } };

  // The delegate reports both of these as "no pending item #1 (0 pending)",
  // exit 1. They are not the same state.
  const noFile = await commands['inbox-resolve'].run(['1'], withSpawn({ status: 1, stderr: 'agent-inbox.mjs: no pending item #1 (0 pending)\n' }, ctx));
  assert.equal(noFile.exitCode, EXIT.UNVERIFIED);
  assert.equal(noFile.envelope.ok, false);
  assert.deepEqual(noFile.envelope.errors.map((e) => e.code), ['could-not-verify']);

  writeFileSync(inbox, '# Agent Inbox\n\n- [ ] 2026-08-24 10:00 — one thing\n');
  const outOfRange = await commands['inbox-resolve'].run(['9'], withSpawn({ status: 1, stderr: 'agent-inbox.mjs: no pending item #9 (1 pending)\n' }, ctx));
  assert.equal(outOfRange.exitCode, EXIT.FAILED, 'the queue exists, so this ran and failed');
  assert.deepEqual(outOfRange.envelope.errors.map((e) => e.code), ['no-such-item']);
});

test('inbox-resolve: --result is forwarded and echoed back', async () => {
  const dir = tempDir('resolve-ok');
  const inbox = join(dir, 'agent-inbox.md');
  writeFileSync(inbox, '# Agent Inbox\n\n- [ ] 2026-08-24 10:00 — one thing\n');
  let seen = null;
  const r = await commands['inbox-resolve'].run(['1', '--result', 'scored 4.3 — report 012'], {
    root: ROOT,
    cwd: dir,
    env: { CAREER_OPS_INBOX: inbox },
    spawn: (_node, args) => { seen = args; return { status: 0, stdout: 'Resolved #1: 2026-08-24 10:00 — one thing\n', stderr: '' }; },
  });
  assert.equal(r.exitCode, EXIT.OK);
  assert.deepEqual(seen.slice(1), ['resolve', '1', '--result', 'scored 4.3 — report 012']);
  assert.equal(r.envelope.data.resolved, 1);
  assert.equal(r.envelope.data.result, 'scored 4.3 — report 012');
});

// ── end-to-end: the delegate output contract these parsers depend on ──

test('end-to-end: verify against a real tracker parses, and does not report 3', async () => {
  const dir = tempDir('verify-e2e');
  const tracker = join(dir, 'applications.md');
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(tracker, [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-08-01 | Acme | SRE | 4.20/5 | applied | ✅ | — | — |',
    '| 2 | 2026-08-02 | Globex | Data Engineer | 3.80/5 | evaluated | — | — | — |',
    '',
  ].join('\n'));

  const r = await commands.verify.run([], {
    root: ROOT,
    cwd: dir,
    env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_REPORTS: join(dir, 'reports') },
  });

  // The assertion that matters is structural: whatever the checkout's own state
  // makes of this tracker, the adapter could READ the result. A 3 here means
  // verify-pipeline.mjs's output vocabulary has moved and the parser above is
  // now blind — which is exactly what this test exists to catch.
  assert.notEqual(r.exitCode, EXIT.UNVERIFIED, `verify could not read its own delegate's output: ${JSON.stringify(r.envelope.errors)}`);
  assert.ok([EXIT.OK, EXIT.FAILED].includes(r.exitCode), `unexpected exit ${r.exitCode}`);
  assertEnvelope(r.envelope, 'pipeline verify');
  assert.equal(r.envelope.data.entries, 2, 'the tracker row count is read back');
  assert.ok(r.envelope.data.passed.length > 0, 'at least one check reported a pass');
  assert.equal(r.envelope.ok, r.envelope.errors.length === 0);
  assert.equal(r.envelope.data.counts.errors, r.envelope.errors.length);
  assert.equal(r.envelope.data.counts.warnings, r.envelope.warnings.length);
});

test('end-to-end: a fresh setup with no tracker is 3, not a green pipeline', async () => {
  const dir = tempDir('verify-fresh');
  mkdirSync(join(dir, 'reports'), { recursive: true });
  const r = await commands.verify.run([], {
    root: ROOT,
    cwd: dir,
    env: { ...process.env, CAREER_OPS_TRACKER: join(dir, 'nope.md'), CAREER_OPS_REPORTS: join(dir, 'reports') },
  });
  assert.equal(r.exitCode, EXIT.UNVERIFIED, 'the delegate exits 0 here; the adapter must not inherit that');
  assert.equal(r.envelope.ok, false);
  assert.deepEqual(r.envelope.errors.map((e) => e.code), ['could-not-verify']);
});

test('end-to-end: add, list and resolve round-trip against the real queue', async () => {
  const dir = tempDir('inbox-e2e');
  const inbox = join(dir, 'agent-inbox.md');
  const ctx = { root: ROOT, cwd: dir, env: { ...process.env, CAREER_OPS_INBOX: inbox } };

  const before = await commands['inbox-list'].run([], ctx);
  assert.equal(before.exitCode, EXIT.OK);
  assert.equal(before.envelope.data.exists, false, 'no queue file before the first add');

  const added = await commands['inbox-add'].run(['evaluate', 'https://acme.test/jobs/42'], ctx);
  assert.equal(added.exitCode, EXIT.OK, JSON.stringify(added.envelope.errors));
  assert.equal(added.envelope.data.queued, 'evaluate https://acme.test/jobs/42');

  const listed = await commands['inbox-list'].run(['--json'], ctx);
  assert.equal(listed.exitCode, EXIT.OK);
  assert.equal(listed.json, true);
  assert.equal(listed.envelope.data.exists, true);
  assert.equal(listed.envelope.data.items.length, 1);
  assert.match(listed.envelope.data.items[0].text, /evaluate https:\/\/acme\.test\/jobs\/42$/);
  assert.equal(listed.envelope.data.items[0].done, false);

  const resolved = await commands['inbox-resolve'].run(['1', '--result', 'scored 4.3'], ctx);
  assert.equal(resolved.exitCode, EXIT.OK, JSON.stringify(resolved.envelope.errors));
  assert.equal(resolved.envelope.data.resolved, 1);
  assert.match(readFileSync(inbox, 'utf8'), /- \[x\] .* → result: scored 4\.3/);

  const pending = await commands['inbox-list'].run([], ctx);
  assert.deepEqual(pending.envelope.data.items, [], 'the resolved item is no longer pending');
  const all = await commands['inbox-list'].run(['--all'], ctx);
  assert.equal(all.envelope.data.items.length, 1);
  assert.equal(all.envelope.data.items[0].done, true);
});

test('end-to-end: resolving against a queue that does not exist is 3', async () => {
  const dir = tempDir('inbox-e2e-missing');
  const r = await commands['inbox-resolve'].run(['1'], {
    root: ROOT,
    cwd: dir,
    env: { ...process.env, CAREER_OPS_INBOX: join(dir, 'agent-inbox.md') },
  });
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.equal(r.envelope.ok, false);
  assert.match(r.envelope.errors[0].message, /nothing to resolve against/);
});
