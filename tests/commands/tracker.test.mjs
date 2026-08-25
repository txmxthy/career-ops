/**
 * tests/commands/tracker.test.mjs — the `career-ops tracker` command adapters.
 *
 * These are contract tests for ADR 0006, not behaviour tests for the scripts
 * the adapters delegate to. What is pinned here is the part the adapters own:
 * the flag surface, the result envelope, the exit codes, and — the one that
 * matters most — that a check which could not RUN is reported as exit 3 with
 * `ok: false`, never as a clean empty result.
 *
 * Every case runs against a sandbox root, so nothing here reads or writes the
 * real tracker. Delegation is exercised against stub scripts rather than the
 * real ones: what is under test is the translation layer, and a stub is the
 * only way to drive an exit code the real script produces only under a
 * condition (a lock timeout, an ambiguous company) that cannot be staged
 * hermetically.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { noun, commands } from '../../src/commands/tracker.js';
import { EXIT } from '../../src/core/flags.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── sandbox ─────────────────────────────────────────────────────────

const sandboxes = [];

/**
 * A throwaway repo root. `tracker: true` gives it data/applications.md, so a
 * command's preflight passes; without it every tracker command must report
 * "could not verify".
 */
function sandbox({ tracker = false, pipeline = false, scripts = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-tracker-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const trackerPath = join(dir, 'data', 'applications.md');
  const pipelinePath = join(dir, 'data', 'pipeline.md');
  if (tracker) {
    writeFileSync(trackerPath, [
      '# Applications Tracker',
      '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '',
    ].join('\n'));
  }
  if (pipeline) writeFileSync(pipelinePath, '# Pipeline\n\n## Pendientes\n');
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(dir, name), body);
  return { dir, trackerPath, pipelinePath };
}

/** A context whose tracker/pipeline paths are pinned, so an ambient
 *  CAREER_OPS_TRACKER on the developer's machine cannot reach these cases. */
function ctxFor(box, extraEnv = {}) {
  return {
    rootDir: box.dir,
    env: {
      ...process.env,
      CAREER_OPS_TRACKER: box.trackerPath,
      CAREER_OPS_PIPELINE: box.pipelinePath,
      ...extraEnv,
    },
  };
}

/** A stub root script that prints what it is told and exits how it is told.
 *  It sets `process.exitCode` rather than calling the exit function: test-all
 *  refuses to import a discovered suite whose SOURCE contains that call, since
 *  discovered suites run in-process and one would kill the whole run. */
const stub = (stdout = '', code = 0, stderr = '') => [
  `process.stdout.write(${JSON.stringify(stdout)});`,
  `process.stderr.write(${JSON.stringify(stderr)});`,
  `process.exitCode = Number(process.env.STUB_EXIT ?? ${code});`,
].join('\n');

process.on('exit', () => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

// ── the envelope contract ───────────────────────────────────────────

/**
 * Assert the ADR 0006 envelope invariants, including the two the whole
 * contract rests on: a failure carries at least one error, and a success
 * carries none.
 */
function assertEnvelope(res, { verb }) {
  const e = res.envelope;
  assert.ok(e && typeof e === 'object', `${verb}: no envelope`);
  assert.deepEqual(Object.keys(e).sort(), ['command', 'data', 'errors', 'ok', 'warnings']);
  assert.equal(typeof e.ok, 'boolean');
  assert.equal(e.command, `tracker ${verb}`);
  assert.ok(e.data && typeof e.data === 'object');
  assert.ok(Array.isArray(e.warnings));
  assert.ok(Array.isArray(e.errors));
  assert.equal(e.ok, res.code === EXIT.OK, `${verb}: ok must agree with the exit code`);
  if (e.ok) assert.equal(e.errors.length, 0, `${verb}: a success carried errors`);
  else assert.ok(e.errors.length > 0, `${verb}: a failure carried no error`);
  // It must survive the trip an agent actually makes it take.
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e);
}

const VERBS = [
  'add-entry', 'archive-posting', 'dedup', 'merge', 'normalize-statuses',
  'reconcile', 'reserve-report-num', 'set-status', 'normalize-link',
  'sync-check', 'index', 'query', 'history', 'export', 'delete',
];

// ── 1. module shape ─────────────────────────────────────────────────

test('exports the noun and one entry per ADR 0003 tracker row', () => {
  assert.equal(noun, 'tracker');
  assert.deepEqual(Object.keys(commands).sort(), [...VERBS].sort());
  for (const [verb, cmd] of Object.entries(commands)) {
    assert.equal(typeof cmd.run, 'function', `${verb}: no run()`);
    assert.equal(typeof cmd.help, 'string', `${verb}: no help`);
    assert.ok(cmd.flags && typeof cmd.flags === 'object', `${verb}: no flags`);
  }
});

test('the adapters print nothing and exit nothing themselves', () => {
  // ADR 0006: a command file "parses nothing and prints nothing". A console
  // call or a process.exit here would make the commands untestable as
  // functions and would put rendering back inside the adapter.
  const src = readFileSync(join(ROOT, 'src/commands/tracker.js'), 'utf-8');
  assert.doesNotMatch(src, /console\./);
  assert.doesNotMatch(src, /process\.exit\(/);
});

// ── 2. --help and --json, on every command without exception ────────

test('--help works on every command, with no tracker present', () => {
  // Ordering matters: help must not depend on the input the command needs.
  const box = sandbox();
  for (const verb of VERBS) {
    const res = commands[verb].run(['--help'], ctxFor(box));
    assert.equal(res.code, EXIT.OK, `${verb}: --help did not exit 0`);
    assertEnvelope(res, { verb });
    assert.match(res.stdout, /Usage:/, `${verb}: no usage block`);
    assert.match(res.stdout, /Exit codes:/, `${verb}: no exit-code table`);
    assert.match(res.stdout, /--json/, `${verb}: --help does not document --json`);
    assert.equal(res.envelope.data.help, commands[verb].help);
  }
});

test('--json is accepted by every command and yields a valid envelope', () => {
  const box = sandbox();
  for (const verb of VERBS) {
    const res = commands[verb].run(['--json', '--help'], ctxFor(box));
    assert.equal(res.code, EXIT.OK, `${verb}: --json --help did not exit 0`);
    assertEnvelope(res, { verb });
  }
});

test('a flag error is reported even when --help is present', () => {
  // parseFlags collects flag errors before honouring --help, so a typo is
  // named rather than silently exiting 0 having never looked at it.
  const res = commands.dedup.run(['--help', '--bogus'], ctxFor(sandbox()));
  assert.equal(res.code, EXIT.USAGE);
  assertEnvelope(res, { verb: 'dedup' });
  assert.equal(res.envelope.errors[0].code, 'unknown-flag');
});

// ── 3. exit code 2 — usage ──────────────────────────────────────────

test('an unknown flag is a usage error on every command', () => {
  const box = sandbox({ tracker: true });
  for (const verb of VERBS) {
    const res = commands[verb].run(['--not-a-flag'], ctxFor(box));
    assert.equal(res.code, EXIT.USAGE, `${verb}: unknown flag did not exit 2`);
    assertEnvelope(res, { verb });
    assert.match(res.stderr, /unrecognized flag/, `${verb}: the typo was not named`);
  }
});

test('a missing required selector is a usage error, not a failed check', () => {
  const box = sandbox({ tracker: true });
  const cases = [
    ['delete', [], /--num requires a value/],
    ['history', [], /--id requires a value/],
    ['add-entry', [], /payload path or --stdin/],
    ['archive-posting', [], /URL or --pipeline/],
    ['set-status', [], /expected at least 1/],
    ['normalize-link', [], /expected at least 1/],
    ['reserve-report-num', ['--gc', '--count', '2'], /pick one of/],
    ['archive-posting', ['--pipeline', '--report', '3'], /cannot be combined/],
  ];
  for (const [verb, argv, message] of cases) {
    const res = commands[verb].run(argv, ctxFor(box));
    assert.equal(res.code, EXIT.USAGE, `${verb} ${argv.join(' ')}: expected exit 2`);
    assertEnvelope(res, { verb });
    assert.match(res.stderr, message);
    assert.match(res.stderr, /Usage:/, `${verb}: a usage error should show the usage`);
  }
});

test('a value flag given no operand is reported, never defaulted away', () => {
  // ADR 0004 #6: `--company --dry-run` must not read '--dry-run' as a company.
  const res = commands['archive-posting'].run(
    ['https://example.test/job/1', '--company', '--dry-run'],
    ctxFor(sandbox({ tracker: true })),
  );
  assert.equal(res.code, EXIT.USAGE);
  assert.match(res.stderr, /--company requires a value/);
});

// ── 4. exit code 3 — could not verify ───────────────────────────────

const NEEDS_TRACKER = [
  'dedup', 'normalize-statuses', 'set-status', 'normalize-link',
  'sync-check', 'index', 'query', 'history', 'export', 'delete',
];

const ARGV_FOR = {
  'set-status': ['acme', 'Applied'],
  'normalize-link': ['[042](reports/042.md)'],
  history: ['--id', '7'],
  delete: ['--num', '7'],
};

test('a missing tracker is exit 3 with ok:false, never a clean empty result', () => {
  // dedup-tracker.mjs:268 and normalize-statuses.mjs:113 both print "Nothing
  // to dedup/normalize" and exit 0 here. That is the ADR 0006 anti-pattern:
  // a mis-pointed CAREER_OPS_TRACKER is indistinguishable from a clean run.
  // The sandbox also contains no scripts at all, so a case that reached the
  // delegation would surface as a different code — the preflight is doing
  // the work, not the child.
  const box = sandbox();
  for (const verb of NEEDS_TRACKER) {
    const res = commands[verb].run(ARGV_FOR[verb] || [], ctxFor(box));
    assert.equal(res.code, EXIT.UNVERIFIED, `${verb}: expected exit 3`);
    assertEnvelope(res, { verb });
    assert.equal(res.envelope.ok, false);
    assert.equal(res.envelope.errors[0].code, 'could-not-verify');
    assert.match(res.envelope.errors[0].message, /^could not verify: no tracker at /);
  }
});

test('the could-not-run envelope survives --json', () => {
  const res = commands.dedup.run(['--json'], ctxFor(sandbox()));
  assert.equal(res.code, EXIT.UNVERIFIED);
  const parsed = JSON.parse(JSON.stringify(res.envelope));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, 'tracker dedup');
  assert.ok(parsed.errors.length > 0, 'a check that could not run must carry an error');
});

test('a missing pipeline inbox is exit 3, and so is a missing payload', () => {
  const box = sandbox({ tracker: true });
  const noPipeline = commands.reconcile.run([], ctxFor(box));
  assert.equal(noPipeline.code, EXIT.UNVERIFIED);
  assert.match(noPipeline.envelope.errors[0].message, /no pipeline inbox at /);

  const noPayload = commands['add-entry'].run([join(box.dir, 'nope.json')], ctxFor(box));
  assert.equal(noPayload.code, EXIT.UNVERIFIED);
  assert.match(noPayload.envelope.errors[0].message, /no payload at /);
});

test('a script that is not installed is exit 3, not a failed check', () => {
  // node exits 1 on ERR_MODULE_NOT_FOUND, which would otherwise be reported
  // as a real negative finding for work nothing performed.
  const box = sandbox({ tracker: true });
  const res = commands.dedup.run([], ctxFor(box));
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /dedup-tracker\.mjs is not installed at /);
});

// ── 5. delegation and exit-code translation ─────────────────────────

test('a delegated success carries the child JSON as structured data', () => {
  const rows = [{ id: 1, company: 'Acme', status: 'Applied' }];
  const box = sandbox({
    tracker: true,
    scripts: { 'tracker.mjs': stub(`${JSON.stringify(rows)}\n`, 0) },
  });
  const res = commands.query.run(['--json', '--status', 'Applied'], ctxFor(box));
  assert.equal(res.code, EXIT.OK);
  assertEnvelope(res, { verb: 'query' });
  assert.deepEqual(res.envelope.data.result, rows);
  assert.equal(res.envelope.data.exitCode, 0);
});

test('non-JSON child output is kept verbatim rather than re-wrapped', () => {
  const box = sandbox({
    tracker: true,
    scripts: { 'tracker.mjs': stub('| 1 | 2026-08-24 | Acme |\n', 0) },
  });
  const res = commands.query.run([], ctxFor(box));
  assert.equal(res.code, EXIT.OK);
  assert.equal(res.envelope.data.stdout, '| 1 | 2026-08-24 | Acme |\n');
  assert.equal(res.stdout, '| 1 | 2026-08-24 | Acme |\n');
});

test('a delegated failure is exit 1 and names the reason', () => {
  const box = sandbox({
    tracker: true,
    scripts: { 'tracker.mjs': stub('', 1, 'Error: no application with id 7\n') },
  });
  const res = commands.history.run(['--id', '7'], ctxFor(box));
  assert.equal(res.code, EXIT.FAILED);
  assertEnvelope(res, { verb: 'history' });
  assert.equal(res.envelope.errors[0].message, 'Error: no application with id 7');
});

test('set-status CLI_EXIT codes are translated, not inherited', () => {
  // public-surface.md §2 row 4 freezes tracker-utils' CLI_EXIT for the web
  // consumer; ADR 0006 says the shim keeps those codes and the CLI translates.
  //   0 OK -> 0 · 1 USAGE -> 2 · 2 NOT_FOUND -> 1 · 3 AMBIGUOUS -> 1
  //   4 LOCK_TIMEOUT -> 3, because the write never happened.
  const box = sandbox({
    tracker: true,
    scripts: { 'set-status.mjs': stub('', 0, 'set-status: something\n') },
  });
  const expected = [[0, EXIT.OK], [1, EXIT.USAGE], [2, EXIT.FAILED], [3, EXIT.FAILED], [4, EXIT.UNVERIFIED]];
  for (const [childCode, cliCode] of expected) {
    const res = commands['set-status'].run(
      ['acme', 'Applied'],
      ctxFor(box, { STUB_EXIT: String(childCode) }),
    );
    assert.equal(res.code, cliCode, `child exit ${childCode} should map to ${cliCode}`);
    assertEnvelope(res, { verb: 'set-status' });
  }
});

test('a lock timeout reports "could not verify", not a negative finding', () => {
  const box = sandbox({
    tracker: true,
    scripts: { 'set-status.mjs': stub('', 4, 'Cannot acquire tracker lock: timed out\n') },
  });
  const res = commands['set-status'].run(['acme', 'Applied'], ctxFor(box));
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.equal(res.envelope.errors[0].code, 'could-not-verify');
  assert.match(res.envelope.errors[0].message, /could not verify: Cannot acquire tracker lock/);
});

test('the reserved report number is a named field, not an unlabelled blob', () => {
  const box = sandbox({ scripts: { 'reserve-report-num.mjs': stub('042\n', 0) } });
  const res = commands['reserve-report-num'].run(['--count', '1'], ctxFor(box));
  assert.equal(res.code, EXIT.OK);
  assert.equal(res.envelope.data.reserved, '042');
  assert.equal(res.stdout, '042\n');
});

test('flags are forwarded in both spellings and never dropped', () => {
  // `--flag=value` is invisible to indexOf, which is the defect class
  // src/core/flags.js exists to end. Both spellings must reach the child.
  const echo = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));';
  const box = sandbox({ tracker: true, scripts: { 'tracker.mjs': echo } });
  const spaced = commands.query.run(['--company', 'Acme', '--limit', '5'], ctxFor(box));
  const inline = commands.query.run(['--company=Acme', '--limit=5'], ctxFor(box));
  // The stub echoes its argv as JSON, so it arrives already structured.
  assert.deepEqual(spaced.envelope.data.result, ['query', '--company', 'Acme', '--limit', '5']);
  assert.deepEqual(inline.envelope.data.result, spaced.envelope.data.result);
});

test('sync-check turns a mismatch into exit 1 and counts it', () => {
  // tracker-sync-check.mjs exits 0 whether or not it found anything, so the
  // finding is invisible to a caller reading the status.
  const report = { mismatches: [{ company: 'Acme' }], summary: { total: 1, tier1: 1, tier2: 0 } };
  const box = sandbox({
    tracker: true,
    scripts: { 'tracker-sync-check.mjs': stub(`${JSON.stringify(report)}\n`, 0) },
  });
  const res = commands['sync-check'].run(['--json'], ctxFor(box));
  assert.equal(res.code, EXIT.OK);
  assert.equal(res.envelope.data.mismatched, 1);
  assert.deepEqual(res.envelope.data.report, report);
});

// ── 6. the one command that is already argv-free ────────────────────

test('normalize-link is computed in-process, relative to the real tracker', () => {
  // tracker-links.mjs exports one pure function, so there is nothing to spawn.
  // data/applications.md means reports/ is one level up from the tracker.
  const box = sandbox({ tracker: true });
  const res = commands['normalize-link'].run(['[042](reports/042-acme-2026-08-24.md)'], ctxFor(box));
  assert.equal(res.code, EXIT.OK);
  assertEnvelope(res, { verb: 'normalize-link' });
  assert.equal(res.envelope.data.normalized, '[042](../reports/042-acme-2026-08-24.md)');
  assert.equal(res.stdout, '[042](../reports/042-acme-2026-08-24.md)\n');
});

test('normalize-link is idempotent', () => {
  const box = sandbox({ tracker: true });
  const once = commands['normalize-link'].run(['[042](reports/042.md)'], ctxFor(box));
  const twice = commands['normalize-link'].run([once.envelope.data.normalized], ctxFor(box));
  assert.equal(twice.envelope.data.normalized, once.envelope.data.normalized);
});
