/**
 * Tests for src/commands/system.js — the `career-ops system` adapters.
 *
 * No child process is ever spawned: every case injects `ctx.exec`, so the
 * canned exit code and stdout ARE the fixture. That is the point — what is
 * under test is the translation from a script's exit code to ADR 0006's, not
 * the scripts themselves.
 *
 * The load-bearing assertions are the exit-3 ones. Several backing scripts
 * report a clean pass for a check that never ran — `src/scripts/fix-slugs.mjs` exits 0
 * printing "nothing to fix" when portals.yml is absent, `src/scripts/sync-pdf-flags.mjs`
 * exits 2 for a missing tracker, `src/scripts/plugin-audit.mjs` exits 2 when the audit
 * throws. ADR 0006 makes 1 and 3 distinct precisely so those cannot be
 * confused with a finding, and each translation is pinned below by the exit
 * code the script produces today.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { noun, commands } from '../../src/commands/system.js';
import { EXIT } from '../../src/core/flags.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Every backing script a row can resolve, so resolveScript finds them all. */
const SCRIPTS = [
  'doctor.mjs',
  'update-system.mjs',
  'src/scripts/check-table-freshness.mjs',
  'src/scripts/fix-slugs.mjs',
  'src/scripts/generate-latex.mjs',
  'src/scripts/plugin-audit.mjs',
  'src/scripts/plugins.mjs',
  'src/scripts/sync-pdf-flags.mjs',
  'src/scripts/validate-plugin-registry.mjs',
  'src/scripts/validate-system-paths-coverage.mjs',
  'src/scripts/validate-untrusted-content-coverage.mjs',
];

const sandboxes = [];

/**
 * A throwaway checkout whose every preflight input is present, so a test that
 * cares about one missing input can remove just that one.
 *
 * @returns {string} Absolute path to the sandbox root.
 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'system-cmd-'));
  sandboxes.push(root);
  for (const script of SCRIPTS) {
    // SCRIPTS names are repo-relative, so the src/scripts/ parents have to exist.
    mkdirSync(dirname(join(root, script)), { recursive: true });
    writeFileSync(join(root, script), '// stub\n');
  }
  mkdirSync(join(root, 'templates'));
  mkdirSync(join(root, 'plugins-registry'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'applications.md'), '# Applications Tracker\n');
  writeFileSync(join(root, 'AGENTS.md'), '## Untrusted External Content (CRITICAL)\n');
  writeFileSync(join(root, 'portals.yml'), 'companies: []\n');
  return root;
}

process.on('exit', () => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

/**
 * An executor that never spawns.
 *
 * @param {{code?: number, stdout?: string, stderr?: string, failure?: string}} result
 * @returns {Function} exec, with `.calls` recording every invocation.
 */
function fakeExec(result = {}) {
  const exec = async (script, argv, opts) => {
    exec.calls.push({ script, argv, opts });
    if (typeof result === 'function') return result(script, argv, opts);
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  exec.calls = [];
  return exec;
}

/** Fails the test if it is ever reached — for paths that must not spawn. */
function neverExec() {
  return fakeExec(() => {
    assert.fail('a child process was spawned on a path that must not spawn one');
  });
}

/** The ADR 0006 envelope invariants, asserted on every result in this file. */
function assertEnvelope(env, { command, exitCode }) {
  assert.equal(typeof env, 'object');
  assert.equal(env.command, command);
  assert.equal(typeof env.ok, 'boolean');
  assert.equal(env.ok, exitCode === EXIT.OK, 'ok must agree with the exit code');
  assert.equal(typeof env.data, 'object');
  assert.ok(Array.isArray(env.warnings));
  assert.ok(Array.isArray(env.errors));
  if (env.ok) assert.equal(env.errors.length, 0, 'a successful result cannot carry errors');
  else assert.ok(env.errors.length > 0, 'a failure must say why — an empty failure is the banned "nothing found"');
  assert.deepEqual(JSON.parse(JSON.stringify(env)), env, 'the envelope must survive a JSON round trip');
}

/** Run a command and assert the envelope invariants before returning it. */
async function invoke(verb, argv, ctx) {
  const res = await commands[verb].run(argv, ctx);
  assert.ok(Number.isInteger(res.exitCode), `${verb} must return an integer exit code`);
  assert.equal(typeof res.text, 'string', `${verb} must return text for the facade to print`);
  assert.equal(typeof res.json, 'boolean', `${verb} must tell the facade which renderer to use`);
  assertEnvelope(res.envelope, { command: `system ${verb}`, exitCode: res.exitCode });
  return res;
}

const VERBS = Object.keys(commands);

// ── shape ───────────────────────────────────────────────────────────

test('the noun is `system` and every command exports run, help and flags', () => {
  assert.equal(noun, 'system');
  assert.ok(VERBS.length > 0);
  for (const verb of VERBS) {
    assert.equal(typeof commands[verb].run, 'function', `${verb}.run`);
    assert.equal(typeof commands[verb].help, 'function', `${verb}.help`);
    assert.equal(typeof commands[verb].flags, 'object', `${verb}.flags`);
  }
});

test('the ADR 0003 verbs that stuttered against the noun are renamed', () => {
  // update-system → update, validate-system-paths-coverage → validate-path-coverage,
  // validate-untrusted-content-coverage → validate-untrusted-coverage.
  for (const old of ['update-system', 'validate-system-paths-coverage', 'validate-untrusted-content-coverage']) {
    assert.ok(!(old in commands), `${old} should have been renamed, not shipped`);
  }
  for (const kept of ['update', 'validate-path-coverage', 'validate-untrusted-coverage']) {
    assert.ok(kept in commands, `${kept} is missing`);
  }
});

// ── --help ──────────────────────────────────────────────────────────

test('every command documents itself, --json and --help, and the exit codes', () => {
  for (const verb of VERBS) {
    const help = commands[verb].help();
    assert.match(help, /^\S/, `${verb}: help must not start blank`);
    assert.match(help, /Usage: career-ops system /, `${verb}: help must name the command`);
    assert.match(help, /--json/, `${verb}: ADR 0006 requires --json on every command`);
    assert.match(help, /--help/, `${verb}: help must list --help`);
    assert.match(help, /Exit codes:/, `${verb}: a caller reading a status needs the table`);
    assert.match(help, /3 {2}could not verify/, `${verb}: exit 3 must be documented`);
  }
});

test('--help exits 0 with the help in the envelope and spawns nothing', async () => {
  for (const verb of VERBS) {
    const res = await invoke(verb, ['--help'], { root: sandbox(), exec: neverExec() });
    assert.equal(res.exitCode, EXIT.OK, `${verb} --help`);
    assert.equal(res.envelope.data.help, commands[verb].help());
    assert.equal(res.text, commands[verb].help());
  }
});

test('--help is honoured for a command whose required positional is absent', async () => {
  // flags.js checks arity after --help, so `generate-latex --help` prints help
  // rather than complaining about the file it was never given.
  const res = await invoke('generate-latex', ['--help'], { root: sandbox(), exec: neverExec() });
  assert.equal(res.exitCode, EXIT.OK);
});

// ── --json envelope ─────────────────────────────────────────────────

test('the facade is told which renderer the caller asked for', async () => {
  const root = sandbox();
  const prose = await invoke('validate-untrusted-coverage', [], { root, exec: fakeExec({ code: 0, stdout: 'ok\n' }) });
  assert.equal(prose.json, false);
  const json = await invoke('validate-untrusted-coverage', ['--json'], { root, exec: fakeExec({ code: 0, stdout: 'ok\n' }) });
  assert.equal(json.json, true);
  // Including on a usage error, so a --json caller never gets prose back.
  const bad = await invoke('validate-untrusted-coverage', ['--json', '--nope'], { root, exec: neverExec() });
  assert.equal(bad.exitCode, EXIT.USAGE);
  assert.equal(bad.json, true);
});

test('--json emits a valid envelope on a clean run', async () => {
  const res = await invoke('validate-untrusted-coverage', ['--json'], {
    root: sandbox(),
    exec: fakeExec({ code: 0, stdout: '✓ every ingesting mode references the directive\n' }),
  });
  assert.equal(res.exitCode, EXIT.OK);
  assert.equal(res.envelope.ok, true);
  assert.equal(res.envelope.command, 'system validate-untrusted-coverage');
  assert.match(res.envelope.data.output, /every ingesting mode/);
});

test('a command whose script emits JSON puts the parsed body in data, not a string', async () => {
  const report = { today: '2026-08-25', tablesScanned: 4, rowsChecked: 40, findings: [] };
  const res = await invoke('check-table-freshness', ['--json'], {
    root: sandbox(),
    exec: fakeExec({ code: 0, stdout: JSON.stringify(report) }),
  });
  assert.equal(res.exitCode, EXIT.OK);
  assert.deepEqual(res.envelope.data, report);
});

test('stderr on an otherwise-clean run becomes warnings rather than silence', async () => {
  // The tech-debt entry ADR 0006 cites is a watcher that swallowed stderr and
  // reported success. Warnings are how a passing run still says what it saw.
  const res = await invoke('plugins', ['list'], {
    root: sandbox(),
    exec: fakeExec({ code: 0, stdout: 'no plugins installed\n', stderr: 'config/plugins.yml is unreadable\n' }),
  });
  assert.equal(res.exitCode, EXIT.OK);
  assert.deepEqual(res.envelope.warnings, ['config/plugins.yml is unreadable']);
});

// ── usage errors are 2, and never reach the child ───────────────────

test('an unknown flag is exit 2 with the flag named, and spawns nothing', async () => {
  const res = await invoke('doctor', ['--stricct'], { root: sandbox(), exec: neverExec() });
  assert.equal(res.exitCode, EXIT.USAGE);
  assert.equal(res.envelope.errors[0].code, 'unknown-flag');
  assert.equal(res.envelope.errors[0].flag, '--stricct');
});

test('a value flag left without an operand is exit 2, not a silent default', async () => {
  // doctor.mjs's #3087: `--target --json` diagnosed a directory named "--json".
  const res = await invoke('doctor', ['--target', '--json'], { root: sandbox(), exec: neverExec() });
  assert.equal(res.exitCode, EXIT.USAGE);
  assert.equal(res.envelope.errors[0].code, 'missing-value');
});

test('an unknown subcommand is exit 2, so the child exit 1 always means a real abort', async () => {
  const res = await invoke('update', ['aply'], { root: sandbox(), exec: neverExec() });
  assert.equal(res.exitCode, EXIT.USAGE);
  assert.equal(res.envelope.errors[0].code, 'unknown-action');
  assert.match(res.envelope.errors[0].message, /check, apply, rollback, dismiss/);
});

test('a malformed --today is exit 2, not the exit 1 the script would give it', async () => {
  const res = await invoke('check-table-freshness', ['--today', '25-08-2026'], {
    root: sandbox(),
    exec: neverExec(),
  });
  assert.equal(res.exitCode, EXIT.USAGE);
  assert.equal(res.envelope.errors[0].flag, '--today');
});

test('a non-integer --max-age-months is exit 2', async () => {
  const res = await invoke('check-table-freshness', ['--max-age-months', '6.5'], {
    root: sandbox(),
    exec: neverExec(),
  });
  assert.equal(res.exitCode, EXIT.USAGE);
  assert.equal(res.envelope.errors[0].flag, '--max-age-months');
});

// ── exit 3: could not run ───────────────────────────────────────────

test('a missing backing script is could-not-verify, not a clean pass', async () => {
  const root = sandbox();
  rmSync(join(root, 'doctor.mjs'));
  const res = await invoke('doctor', [], { root, exec: neverExec() });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.equal(res.envelope.ok, false);
  assert.equal(res.envelope.errors[0].code, 'could-not-verify');
  assert.match(res.envelope.errors[0].message, /could not verify: doctor\.mjs is not in/);
});

test('fix-slugs without a portals file is exit 3, where the script exits 0', async () => {
  // src/scripts/fix-slugs.mjs prints "no portals file at … — nothing to fix" and returns
  // normally. That is a check that never ran, reported as clean.
  const root = sandbox();
  rmSync(join(root, 'portals.yml'));
  const res = await invoke('fix-slugs', ['--json'], { root, exec: neverExec() });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.equal(res.envelope.ok, false);
  assert.match(res.envelope.errors[0].message, /no portals file at .*portals\.yml — nothing was checked/);
});

test('check-table-freshness with no templates/ is exit 3, not zero tables at exit 0', async () => {
  const root = sandbox();
  rmSync(join(root, 'templates'), { recursive: true });
  const res = await invoke('check-table-freshness', ['--json'], { root, exec: neverExec() });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /no jurisdiction tables to scan/);
});

test('sync-pdf-flags without a tracker is exit 3, where the script exits 2', async () => {
  const root = sandbox();
  rmSync(join(root, 'data'), { recursive: true });
  const res = await invoke('sync-pdf-flags', ['--json'], { root, env: {}, exec: neverExec() });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /no tracker at .* — no rows were read/);
});

test('validate-path-coverage outside a git checkout is exit 3', async () => {
  const root = sandbox();
  rmSync(join(root, '.git'), { recursive: true });
  const res = await invoke('validate-path-coverage', ['--json'], { root, exec: neverExec() });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /not a git checkout/);
});

test('validate-path-coverage without update-system.mjs is exit 3', async () => {
  const root = sandbox();
  rmSync(join(root, 'update-system.mjs'));
  const res = await invoke('validate-path-coverage', [], { root, exec: neverExec() });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /path manifests cannot be read/);
});

test('validate-untrusted-coverage without AGENTS.md is exit 3', async () => {
  const root = sandbox();
  rmSync(join(root, 'AGENTS.md'));
  const res = await invoke('validate-untrusted-coverage', [], { root, exec: neverExec() });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /canonical directive is unavailable/);
});

test('validate-plugin-registry without a registry is exit 3', async () => {
  const root = sandbox();
  rmSync(join(root, 'plugins-registry'), { recursive: true });
  const res = await invoke('validate-plugin-registry', [], { root, exec: neverExec() });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /no registry at/);
});

test('generate-latex with a missing input file is exit 3', async () => {
  const res = await invoke('generate-latex', ['cv.tex'], { root: sandbox(), exec: neverExec() });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /nothing was compiled/);
});

test('plugin-audit on a missing directory is exit 3', async () => {
  const res = await invoke('plugin-audit', ['plugins/nope'], { root: sandbox(), exec: neverExec() });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /nothing was audited/);
});

test('a child that cannot be started is exit 3, not exit 1', async () => {
  const res = await invoke('plugins', [], {
    root: sandbox(),
    exec: fakeExec({ code: null, failure: 'spawn ENOENT' }),
  });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /spawn ENOENT/);
});

test('a child that ran out of time is exit 3', async () => {
  const res = await invoke('fix-slugs', [], {
    root: sandbox(),
    exec: fakeExec({ code: null, failure: 'src/scripts/fix-slugs.mjs did not finish within 300000ms' }),
  });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /did not finish within/);
});

test('an unreachable network is exit 3, never exit 1', async () => {
  const res = await invoke('update', ['check'], {
    root: sandbox(),
    exec: fakeExec({ code: 1, stderr: "fatal: unable to access 'https://github.com/…': Could not resolve host: github.com\n" }),
  });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.equal(res.envelope.ok, false);
});

test('a JSON-emitting script that printed prose instead is exit 3, not empty data', async () => {
  // Reporting `data: {}` at ok:true here is exactly the unperformed-check
  // failure mode: the caller cannot tell it from a clean scan.
  const res = await invoke('check-table-freshness', ['--json'], {
    root: sandbox(),
    exec: fakeExec({ code: 0, stdout: 'Scanning templates…\n' }),
  });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /was not valid JSON/);
});

test('a JSON-emitting script that printed nothing is exit 3', async () => {
  const res = await invoke('check-table-freshness', ['--json'], {
    root: sandbox(),
    exec: fakeExec({ code: 0, stdout: '' }),
  });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /no output to read/);
});

// ── exit-code translation ───────────────────────────────────────────

test('sync-pdf-flags exits 3 for the codes the script uses for lock and tracker failures', async () => {
  const root = sandbox();
  // 2 = no tracker / read failure, 4 = lock timeout, 1 = lock or write failure.
  for (const code of [1, 2, 4]) {
    const res = await invoke('sync-pdf-flags', [], {
      root,
      env: {},
      exec: fakeExec({ code, stderr: '❌ Cannot acquire tracker lock\n' }),
    });
    assert.equal(res.exitCode, EXIT.UNVERIFIED, `child exit ${code} must map to 3, not a finding`);
  }
});

test('sync-pdf-flags reports an error body at exit 0 as could-not-verify', async () => {
  const res = await invoke('sync-pdf-flags', ['--json'], {
    root: sandbox(),
    env: {},
    exec: fakeExec({ code: 0, stdout: JSON.stringify({ error: 'No tracker found', code: 'no-tracker' }) }),
  });
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
});

test('sync-pdf-flags passes --json through and reports a real sync as ok', async () => {
  const exec = fakeExec({ code: 0, stdout: JSON.stringify({ updated: 3, unchanged: 11, dryRun: false }) });
  const res = await invoke('sync-pdf-flags', ['--json'], { root: sandbox(), env: {}, exec });
  assert.equal(res.exitCode, EXIT.OK);
  assert.deepEqual(exec.calls[0].argv, ['--json']);
  assert.equal(res.envelope.data.updated, 3);
});

test('plugin-audit separates a finding (1) from an audit that threw (2)', async () => {
  const root = sandbox();
  mkdirSync(join(root, 'plugins-local'));
  const finding = await invoke('plugin-audit', ['plugins-local'], {
    root,
    exec: fakeExec({ code: 1, stdout: '✗ index.mjs: direct global fetch()\n' }),
  });
  assert.equal(finding.exitCode, EXIT.FAILED);
  assert.equal(finding.envelope.errors[0].code, 'check-failed');

  const threw = await invoke('plugin-audit', ['plugins-local'], {
    root,
    exec: fakeExec({ code: 2, stderr: 'audit failed: EACCES\n' }),
  });
  assert.equal(threw.exitCode, EXIT.UNVERIFIED);
});

test('a missing LaTeX engine is exit 4 (environment), not a document finding', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'cv.tex'), '\\documentclass{article}\n');
  const res = await invoke('generate-latex', ['cv.tex'], {
    root,
    exec: fakeExec({
      code: 1,
      stdout: JSON.stringify({ valid: true, compiled: false, compileError: 'No LaTeX engine found. Install tectonic (brew install tectonic) or pdflatex.' }),
    }),
  });
  assert.equal(res.exitCode, EXIT.CONFIG);
  assert.equal(res.envelope.errors[0].code, 'environment');
});

test('an invalid document is exit 1 — the check ran and found something', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'cv.tex'), '\\documentclass{article}\n');
  const res = await invoke('generate-latex', ['cv.tex'], {
    root,
    exec: fakeExec({ code: 1, stdout: JSON.stringify({ valid: false, compiled: false, errors: ['unresolved placeholder'] }) }),
  });
  assert.equal(res.exitCode, EXIT.FAILED);
  assert.equal(res.envelope.ok, false);
  assert.equal(res.envelope.data.valid, false);
});

test('validate-path-coverage separates orphan files (1) from a manifest it could not read (3)', async () => {
  const root = sandbox();
  const orphans = await invoke('validate-path-coverage', [], {
    root,
    exec: fakeExec({ code: 1, stdout: 'ORPHAN: notes.md\n' }),
  });
  assert.equal(orphans.exitCode, EXIT.FAILED);

  const unreadable = await invoke('validate-path-coverage', [], {
    root,
    exec: fakeExec({ code: 1, stderr: 'FAIL: SYSTEM_PATHS or USER_PATHS not found in update-system.mjs\n' }),
  });
  assert.equal(unreadable.exitCode, EXIT.UNVERIFIED);
});

test('an expired jurisdiction table is exit 1 with the findings kept in data', async () => {
  const report = {
    today: '2026-08-25',
    tablesScanned: 2,
    rowsChecked: 9,
    findings: [{ type: 'expired', file: 'agency-licensing.yml', jurisdiction: 'CA' }],
  };
  const res = await invoke('check-table-freshness', ['--json'], {
    root: sandbox(),
    exec: fakeExec({ code: 1, stdout: JSON.stringify(report) }),
  });
  assert.equal(res.exitCode, EXIT.FAILED);
  assert.equal(res.envelope.ok, false);
  assert.equal(res.envelope.data.findings.length, 1, 'a failure must still carry what it found');
});

// ── argv the adapters build ─────────────────────────────────────────

test('check-table-freshness asks the script for prose or JSON as the caller did', async () => {
  const root = sandbox();
  const prose = fakeExec({ code: 0, stdout: 'table  jurisdiction  status\n' });
  await invoke('check-table-freshness', [], { root, exec: prose });
  assert.deepEqual(prose.calls[0].argv, ['--summary'], 'without --json the script must be asked for its table');

  const json = fakeExec({ code: 0, stdout: '{"findings":[]}' });
  await invoke('check-table-freshness', ['--json', '--max-age-months', '6'], { root, exec: json });
  assert.deepEqual(json.calls[0].argv, ['--max-age-months', '6']);
});

test('update defaults to check and forwards --force only when given', async () => {
  const root = sandbox();
  const bare = fakeExec({ code: 0, stdout: '{"status":"up-to-date"}' });
  await invoke('update', [], { root, exec: bare });
  assert.deepEqual(bare.calls[0].argv, ['check']);

  const forced = fakeExec({ code: 0, stdout: 'applied\n' });
  await invoke('update', ['apply', '--force'], { root, exec: forced });
  assert.deepEqual(forced.calls[0].argv, ['apply', '--force']);
});

test('doctor --json runs the diagnostic and adds the onboarding state beside it', async () => {
  // The verdict is the diagnostic's exit code. `doctor.mjs --json` is a
  // different report — the frozen onboarding state (public-surface.md §2 row
  // 5) — so it is added to data, never substituted for the run.
  const state = { onboardingNeeded: false, missing: [], warnings: [] };
  const exec = fakeExec((script, argv) =>
    argv.includes('--json')
      ? { code: 0, stdout: JSON.stringify(state), stderr: '' }
      : { code: 0, stdout: '✓ Node v22\n✓ Dependencies installed\n', stderr: '' });
  const res = await invoke('doctor', ['--json', '--target', '/elsewhere'], { root: sandbox(), exec });

  assert.equal(res.exitCode, EXIT.OK);
  assert.equal(exec.calls.length, 2, 'the diagnostic and the state are two different reports');
  assert.deepEqual(exec.calls[0].argv, ['--target', '/elsewhere']);
  assert.deepEqual(exec.calls[1].argv, ['--target', '/elsewhere', '--json'],
    'the state must describe the same checkout the diagnostic ran on');
  assert.deepEqual(res.envelope.data.onboarding, state);
  assert.match(res.envelope.data.output, /Node v22/);
});

test('doctor without --json runs only the diagnostic', async () => {
  const exec = fakeExec({ code: 0, stdout: '✓ Node v22\n' });
  await invoke('doctor', [], { root: sandbox(), exec });
  assert.equal(exec.calls.length, 1);
});

test('doctor reports failing checks as exit 1 and keeps the state fetch a warning', async () => {
  const exec = fakeExec((script, argv) =>
    argv.includes('--json')
      ? { code: 1, stdout: '', stderr: 'doctor.mjs failed: ENOENT\n' }
      : { code: 1, stdout: '✗ cv.md missing\n', stderr: '' });
  const res = await invoke('doctor', ['--json'], { root: sandbox(), exec });
  assert.equal(res.exitCode, EXIT.FAILED);
  assert.equal(res.envelope.ok, false);
  assert.ok(res.envelope.warnings.some((w) => /state unavailable/.test(w)),
    'a failed state fetch is a warning, not silence');
});

test('plugins forwards the action, its arguments and the flags in order', async () => {
  const exec = fakeExec({ code: 0, stdout: 'ran\n' });
  await invoke('plugins', ['run', 'apify', 'search', '--dry-run'], { root: sandbox(), exec });
  assert.deepEqual(exec.calls[0].argv, ['run', 'apify', 'search', '--dry-run']);
});

test('plugins passes a flag-shaped payload through after --', async () => {
  const exec = fakeExec({ code: 0, stdout: 'ran\n' });
  await invoke('plugins', ['run', 'apify', 'search', '--', '--not-a-flag'], { root: sandbox(), exec });
  assert.deepEqual(exec.calls[0].argv, ['run', 'apify', 'search', '--not-a-flag']);
});

test('fix-slugs is read-only unless --fix is given', async () => {
  const root = sandbox();
  const dry = fakeExec({ code: 0, stdout: 'No resolvable slug fixes found — nothing to do.\n' });
  await invoke('fix-slugs', [], { root, exec: dry });
  assert.deepEqual(dry.calls[0].argv, [], 'no --fix means the script writes nothing');

  const write = fakeExec({ code: 0, stdout: 'Fixed 2 entries\n' });
  await invoke('fix-slugs', ['--fix'], { root, exec: write });
  assert.deepEqual(write.calls[0].argv, ['--fix']);
});

test('every command runs the child in the checkout it was pointed at', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'cv.tex'), '\\documentclass{article}\n');
  mkdirSync(join(root, 'plugins-local'));
  const argvFor = {
    'generate-latex': ['cv.tex'],
    'plugin-audit': ['plugins-local'],
  };
  for (const verb of VERBS) {
    const exec = fakeExec({ code: 0, stdout: '{}' });
    await invoke(verb, argvFor[verb] || [], { root, env: {}, exec });
    assert.equal(exec.calls[0].opts.cwd, root, `${verb} must run in the target checkout`);
    assert.ok(exec.calls[0].script.startsWith(root), `${verb} must run the target checkout's script`);
    assert.ok(exec.calls[0].opts.timeoutMs > 0, `${verb} must bound the child`);
  }
});

// ── purity ──────────────────────────────────────────────────────────

test('the adapters print nothing and exit nothing', () => {
  // ADR 0006: a command file "parses nothing and prints nothing". The facade
  // owns stdout and the process status; a console.log here would double-print
  // under --json and corrupt the envelope a caller is piping.
  //
  // Comments are stripped first: the header discusses the backing scripts
  // exiting at module top level, and a doc comment naming the thing is not
  // the thing. (tests/run-all.mjs greps discovered suites for the same call, so
  // the literal must not appear here either.)
  const code = readFileSync(join(ROOT, 'src/commands/system.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /console\./);
  assert.doesNotMatch(code, /process\.exit/);
  assert.doesNotMatch(code, /process\.argv/);
  // process.execPath and process.env are the executor's business; nothing else
  // in the file may touch the process.
  assert.equal((code.match(/process\./g) || []).length, 2);
});

test('no command reports ok:true with a non-zero exit, whatever the child does', async () => {
  const root = sandbox();
  writeFileSync(join(root, 'cv.tex'), '\\documentclass{article}\n');
  mkdirSync(join(root, 'plugins-local'));
  const argvFor = {
    'generate-latex': ['cv.tex'],
    'plugin-audit': ['plugins-local'],
  };
  const childResults = [
    { code: 0, stdout: '{}' },
    { code: 1, stdout: '{}', stderr: 'failed\n' },
    { code: 2, stdout: '{}', stderr: 'usage\n' },
    { code: 4, stdout: '{}', stderr: 'lock timeout\n' },
    { code: null, failure: 'spawn ENOENT' },
  ];
  for (const verb of VERBS) {
    for (const result of childResults) {
      const res = await invoke(verb, argvFor[verb] || [], { root, env: {}, exec: fakeExec(result) });
      // assertEnvelope already ties ok to the exit code; this pins the range.
      assert.ok([EXIT.OK, EXIT.FAILED, EXIT.USAGE, EXIT.UNVERIFIED, EXIT.CONFIG].includes(res.exitCode),
        `${verb} returned an undocumented exit code ${res.exitCode}`);
    }
  }
});
