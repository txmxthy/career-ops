/**
 * Tests for src/commands/eval.js — the `career-ops eval` adapters.
 *
 * Three things are pinned here, per ADR 0006: every command answers --help and
 * --json, every envelope satisfies the envelope invariants, and a check that
 * COULD NOT RUN exits 3 with ok:false — never 0 with empty data, and never 1,
 * which is reserved for a real negative finding.
 *
 * No test spawns a real runner. The child process is injected, so the delegated
 * argv is asserted directly and a "could not run" verdict can be proved to
 * spawn nothing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

import evalNoun, { noun, commands } from '../../src/commands/eval.js';

const VERBS = ['golden', 'gemini', 'ollama', 'openai', 'tailor', 'batch-tailor', 'batch-gemini', 'openrouter'];

/** An env with every key the adapters look at cleared, so the host machine's
 *  real .env cannot make a test pass or fail. */
const BARE_ENV = Object.freeze({});

/** A spawn that must never be called — the assertion for "did not run". */
const forbiddenSpawn = () => { throw new assert.AssertionError({ message: 'preflight spawned a child it should have refused' }); };

/**
 * A fake child process that exits with `status` (or dies on `signal`).
 *
 * @param {{status?: number|null, signal?: string|null, stdout?: string, stderr?: string}} opts - Outcome to stage.
 * @returns {{spawnFn: Function, calls: Array}} The injectable spawn and its call log.
 */
function fakeSpawn({ status = 0, signal = null, stdout = '', stderr = '' } = {}) {
  const calls = [];
  const spawnFn = (execPath, args, options) => {
    calls.push({ execPath, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      if (stdout) child.stdout.end(stdout); else child.stdout.end();
      if (stderr) child.stderr.end(stderr); else child.stderr.end();
      setImmediate(() => child.emit('close', status, signal));
    });
    return child;
  };
  return { spawnFn, calls };
}

/** The ADR 0006 envelope invariants, asserted rather than eyeballed. */
function assertEnvelope(env, { command, ok }) {
  assert.equal(typeof env, 'object');
  assert.equal(env.command, command);
  assert.equal(typeof env.ok, 'boolean');
  assert.equal(typeof env.data, 'object');
  assert.ok(Array.isArray(env.warnings), 'warnings must be an array');
  assert.ok(Array.isArray(env.errors), 'errors must be an array');
  if (ok !== undefined) assert.equal(env.ok, ok);
  // A failure must say why; a success must not carry errors. Collapsing either
  // is how an unperformed check gets reported as an empty one.
  if (env.ok === false) assert.ok(env.errors.length > 0, 'a failed envelope must carry at least one error');
  else assert.equal(env.errors.length, 0, 'a successful envelope must not carry errors');
  for (const e of env.errors) {
    assert.equal(typeof e.code, 'string');
    assert.equal(typeof e.message, 'string');
    assert.ok(e.message.length > 0);
  }
}

/** A temp dir removed when the test ends. */
function tempDir(t, prefix = 'eval-cmd-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── shape ───────────────────────────────────────────────────────────

test('exports the eval noun and exactly the taxonomy verbs', () => {
  assert.equal(noun, 'eval');
  assert.equal(evalNoun.noun, 'eval');
  assert.deepEqual(Object.keys(commands).sort(), [...VERBS].sort());
});

test('every command exposes run, help and flags', () => {
  for (const verb of VERBS) {
    const cmd = commands[verb];
    assert.equal(typeof cmd.run, 'function', `${verb}.run`);
    assert.equal(typeof cmd.help, 'string', `${verb}.help`);
    assert.equal(typeof cmd.flags, 'object', `${verb}.flags`);
  }
});

test('every command answers --json and --help, per ADR 0006', async () => {
  for (const verb of VERBS) {
    // src/core/flags.js appends both to every spec, so the contract is proved
    // where a caller meets it: in the help text and in the parse.
    assert.match(commands[verb].help, /^\s+--json\s+Print the JSON result envelope/m, `${verb} help lists --json`);
    assert.match(commands[verb].help, /^\s+-h, --help\s+/m, `${verb} help lists --help`);
    // --json is never itself a usage error, whatever else the command needs.
    const res = await commands[verb].run(['--json'], {
      env: BARE_ENV,
      spawnFn: forbiddenSpawn,
      fetchFn: async () => ({ ok: true }),
    });
    assert.ok(res.envelope.errors.every((e) => e.flag !== '--json'), `${verb} rejected --json`);
  }
});

// ── --help ──────────────────────────────────────────────────────────

test('--help exits 0, prints usage and the exit-code table, and spawns nothing', async () => {
  for (const verb of VERBS) {
    const res = await commands[verb].run(['--help'], { env: BARE_ENV, spawnFn: forbiddenSpawn });
    assert.equal(res.code, 0, `${verb} --help exit code`);
    assertEnvelope(res.envelope, { command: `eval ${verb}`, ok: true });
    assert.match(res.text, /^Usage: career-ops eval /m, `${verb} --help usage line`);
    assert.match(res.text, /Exit codes:/, `${verb} --help exit codes`);
    assert.match(res.text, /could not verify — the check could not run/, `${verb} --help documents code 3`);
    assert.equal(res.envelope.data.help, res.text);
    assert.equal(res.streamed, false);
  }
});

test('--help wins over missing required input, but not over a bad flag', async () => {
  // A bare `tailor --help` must document the command, not complain about the
  // --jd it was never given.
  const help = await commands.tailor.run(['--help'], { env: BARE_ENV, spawnFn: forbiddenSpawn });
  assert.equal(help.code, 0);

  // …and `--help --bogus` reports --bogus rather than exiting 0 having never
  // looked at it (src/core/flags.js orders these deliberately).
  const bogus = await commands.tailor.run(['--help', '--bogus'], { env: BARE_ENV, spawnFn: forbiddenSpawn });
  assert.equal(bogus.code, 2);
  assertEnvelope(bogus.envelope, { command: 'eval tailor', ok: false });
});

// ── --json ──────────────────────────────────────────────────────────

test('--json emits a valid envelope on success, carrying the delegated argv', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ id: 'a', jd: 'x', label: { archetype: 'ic', score: 4 } }));
  const { spawnFn, calls } = fakeSpawn({ status: 0, stdout: '✅ PASS\n' });

  const res = await commands.golden.run(['--json', '--golden', dir], { env: BARE_ENV, spawnFn });

  assert.equal(res.code, 0);
  assertEnvelope(res.envelope, { command: 'eval golden', ok: true });
  assert.equal(res.envelope.data.runner, 'src/scripts/eval-golden.mjs');
  assert.deepEqual(res.envelope.data.argv, ['--replay', '--golden', dir]);
  assert.equal(res.envelope.data.exitCode, 0);
  assert.equal(res.envelope.data.stdout, '✅ PASS\n');
  assert.equal(res.envelope.data.cases, 1);
  assert.equal(calls.length, 1);
  // The envelope must survive a round trip — an agent parses this, not prose.
  assert.deepEqual(JSON.parse(JSON.stringify(res.envelope)), res.envelope);
});

test('--json emits a valid envelope on a could-not-run path', async () => {
  const res = await commands['batch-tailor'].run(
    ['--json'],
    { env: { CAREER_OPS_BATCH_STATE: '/nowhere/batch-state.tsv' }, spawnFn: forbiddenSpawn },
  );
  assert.equal(res.code, 3);
  assertEnvelope(res.envelope, { command: 'eval batch-tailor', ok: false });
  assert.equal(res.envelope.errors[0].code, 'could-not-verify');
  assert.deepEqual(JSON.parse(JSON.stringify(res.envelope)), res.envelope);
});

// ── exit 3: could not run ───────────────────────────────────────────

test('a missing golden-set directory is could-not-verify, not a failed gate', async (t) => {
  const dir = tempDir(t);
  const res = await commands.golden.run(['--golden', join(dir, 'absent')], { env: BARE_ENV, spawnFn: forbiddenSpawn });
  assert.equal(res.code, 3);
  assertEnvelope(res.envelope, { command: 'eval golden', ok: false });
  assert.match(res.envelope.errors[0].message, /^could not verify: golden-set directory not found/);
});

test('an empty golden set is could-not-verify — src/scripts/eval-golden.mjs exits 1 here', async (t) => {
  const dir = tempDir(t);
  const res = await commands.golden.run(['--golden', dir], { env: BARE_ENV, spawnFn: forbiddenSpawn });
  assert.equal(res.code, 3);
  assert.match(res.envelope.errors[0].message, /no golden cases/);
  assert.equal(res.envelope.ok, false);
});

test('a missing JD file is could-not-verify on every evaluator that takes one', async (t) => {
  const dir = tempDir(t);
  const absent = join(dir, 'no-such-jd.txt');
  const cases = [
    ['gemini', ['--file', absent], { GEMINI_API_KEY: 'k' }],
    ['ollama', ['--file', absent], {}],
    ['openai', ['--file', absent], { OPENAI_API_KEY: 'k' }],
  ];
  for (const [verb, argv, env] of cases) {
    const res = await commands[verb].run(argv, {
      env,
      spawnFn: forbiddenSpawn,
      fetchFn: async () => ({ ok: true }),
    });
    assert.equal(res.code, 3, `${verb} exit code`);
    assertEnvelope(res.envelope, { command: `eval ${verb}`, ok: false });
    assert.match(res.envelope.errors[0].message, /could not verify: job description file not found/, verb);
  }
});

test('tailor reports a missing report file as could-not-verify', async (t) => {
  const dir = tempDir(t);
  const jd = join(dir, 'jd.txt');
  writeFileSync(jd, 'a job');
  const res = await commands.tailor.run(
    ['--jd', jd, '--report', join(dir, 'absent.md')],
    { env: { OPENAI_API_KEY: 'k' }, spawnFn: forbiddenSpawn },
  );
  assert.equal(res.code, 3);
  assert.match(res.envelope.errors[0].message, /could not verify: evaluation report not found/);
});

test('an unreachable Ollama is could-not-verify, and nothing is spawned', async (t) => {
  const dir = tempDir(t);
  const jd = join(dir, 'jd.txt');
  writeFileSync(jd, 'a job');
  const res = await commands.ollama.run(['--file', jd], {
    env: BARE_ENV,
    spawnFn: forbiddenSpawn,
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(res.code, 3);
  assertEnvelope(res.envelope, { command: 'eval ollama', ok: false });
  assert.match(res.envelope.errors[0].message, /could not verify: Ollama is not reachable/);
});

test('a missing pipeline is could-not-verify — the runner returns 0 saying "No pipeline.md found."', async () => {
  // The pipeline path is anchored inside the repo, so this asserts the branch
  // by its verdict rather than by moving a real file: with the key absent the
  // config check fires first, so pin that ordering too.
  const noKey = await commands['batch-gemini'].run([], { env: BARE_ENV, spawnFn: forbiddenSpawn });
  assert.equal(noKey.code, 4);
  assertEnvelope(noKey.envelope, { command: 'eval batch-gemini', ok: false });
  assert.equal(noKey.envelope.errors[0].code, 'config-error');

  const { spawnFn } = fakeSpawn({ status: 0 });
  const withKey = await commands['batch-gemini'].run([], { env: { GEMINI_API_KEY: 'k' }, spawnFn, capture: true });
  // This checkout may or may not have a pipeline. Either the pipeline is
  // absent (3, could not verify) or it is present and the run is staged (0 via
  // the fake child). Never a silent success with an empty result, which is
  // what the runner does today.
  assert.ok([0, 3].includes(withKey.code), `unexpected exit ${withKey.code}`);
  if (withKey.code === 3) {
    assert.match(withKey.envelope.errors[0].message, /could not verify: pipeline not found/);
  } else {
    assert.equal(withKey.envelope.ok, true);
    assert.equal(withKey.envelope.data.runner, 'src/scripts/batch-evaluate-gemini.mjs');
  }
});

test('a runner killed by a signal is could-not-verify, not a failure', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ id: 'a', jd: 'x', label: { archetype: 'ic', score: 4 } }));
  const { spawnFn } = fakeSpawn({ status: null, signal: 'SIGKILL' });
  const res = await commands.golden.run(['--golden', dir], { env: BARE_ENV, spawnFn, capture: true });
  assert.equal(res.code, 3);
  assert.match(res.envelope.errors[0].message, /killed by SIGKILL/);
});

test('a runner that will not start is could-not-verify', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ id: 'a', jd: 'x', label: { archetype: 'ic', score: 4 } }));
  const spawnFn = () => { throw new Error('EACCES'); };
  const res = await commands.golden.run(['--golden', dir], { env: BARE_ENV, spawnFn, capture: true });
  assert.equal(res.code, 3);
  assertEnvelope(res.envelope, { command: 'eval golden', ok: false });
  assert.match(res.envelope.errors[0].message, /could not start eval-golden\.mjs/);
});

// ── exit 4: config / environment ────────────────────────────────────

test('a missing provider key is a config error, distinct from a failed check', async (t) => {
  const dir = tempDir(t);
  const jd = join(dir, 'jd.txt');
  writeFileSync(jd, 'a job');

  const gem = await commands.gemini.run(['--file', jd], { env: BARE_ENV, spawnFn: forbiddenSpawn });
  assert.equal(gem.code, 4);
  assert.match(gem.envelope.errors[0].message, /GEMINI_API_KEY is not set/);

  const oai = await commands.openai.run(['--file', jd], { env: BARE_ENV, spawnFn: forbiddenSpawn });
  assert.equal(oai.code, 4);
  assert.match(oai.envelope.errors[0].message, /no API key for api\.openai\.com/);
});

test('a remote endpoint that would leak the CV is refused before anything runs', async (t) => {
  const dir = tempDir(t);
  const jd = join(dir, 'jd.txt');
  writeFileSync(jd, 'a job');

  const http = await commands.openai.run(
    ['--file', jd, '--url', 'http://example.com/v1', '--key', 'k'],
    { env: BARE_ENV, spawnFn: forbiddenSpawn },
  );
  assert.equal(http.code, 4);
  assert.match(http.envelope.errors[0].message, /non-HTTPS remote endpoint/);

  const remoteOllama = await commands.ollama.run(
    ['--file', jd, '--url', 'http://box.local:11434'],
    { env: BARE_ENV, spawnFn: forbiddenSpawn, fetchFn: async () => ({ ok: true }) },
  );
  assert.equal(remoteOllama.code, 4);
  assert.match(remoteOllama.envelope.errors[0].message, /OLLAMA_ALLOW_REMOTE/);
});

// ── exit 2: usage ───────────────────────────────────────────────────

test('an unknown flag is a usage error on every command, and spawns nothing', async () => {
  for (const verb of VERBS) {
    const res = await commands[verb].run(['--definitely-not-a-flag'], { env: BARE_ENV, spawnFn: forbiddenSpawn });
    assert.equal(res.code, 2, `${verb} unknown flag`);
    assertEnvelope(res.envelope, { command: `eval ${verb}`, ok: false });
    assert.equal(res.envelope.errors[0].code, 'unknown-flag');
  }
});

test('golden refuses --replay and --live together — src/scripts/eval-golden.mjs silently preferred --live', async () => {
  const res = await commands.golden.run(['--replay', '--live'], { env: BARE_ENV, spawnFn: forbiddenSpawn });
  assert.equal(res.code, 2);
  assert.match(res.envelope.errors[0].message, /mutually exclusive/);
});

test('a JD given twice is a usage error — the runners concatenated the two', async (t) => {
  const dir = tempDir(t);
  const jd = join(dir, 'jd.txt');
  writeFileSync(jd, 'a job');
  const res = await commands.gemini.run(['--file', jd, 'and some inline text'], {
    env: { GEMINI_API_KEY: 'k' },
    spawnFn: forbiddenSpawn,
  });
  assert.equal(res.code, 2);
  assert.match(res.envelope.errors[0].message, /not both/);
});

test('no JD at all is a usage error, not an empty evaluation', async () => {
  for (const verb of ['gemini', 'ollama', 'openai']) {
    const res = await commands[verb].run([], { env: BARE_ENV, spawnFn: forbiddenSpawn, fetchFn: async () => ({ ok: true }) });
    assert.equal(res.code, 2, verb);
    assert.match(res.envelope.errors[0].message, /no job description given/, verb);
  }
});

test('tailor names both missing required flags at once', async () => {
  const res = await commands.tailor.run([], { env: BARE_ENV, spawnFn: forbiddenSpawn });
  assert.equal(res.code, 2);
  assert.match(res.envelope.errors[0].message, /--jd and --report are required/);
});

test('openrouter rejects a missing, unknown, or under-specified action at exit 2', async () => {
  const env = { OPENROUTER_API_KEY: 'k' };
  const none = await commands.openrouter.run([], { env, spawnFn: forbiddenSpawn });
  assert.equal(none.code, 2);
  assert.match(none.envelope.errors[0].message, /no action given/);

  const unknown = await commands.openrouter.run(['summarise'], { env, spawnFn: forbiddenSpawn });
  assert.equal(unknown.code, 2);
  assert.match(unknown.envelope.errors[0].message, /unknown action: summarise/);

  // src/scripts/openrouter-runner.mjs prints a usage line here and exits 0.
  const apply = await commands.openrouter.run(['apply'], { env, spawnFn: forbiddenSpawn });
  assert.equal(apply.code, 2);
  assert.match(apply.envelope.errors[0].message, /needs a report number/);
});

test('openrouter needs a key for the model actions but not for scan', async () => {
  const noKey = await commands.openrouter.run(['pipeline'], { env: BARE_ENV, spawnFn: forbiddenSpawn });
  assert.equal(noKey.code, 4);
  assert.match(noKey.envelope.errors[0].message, /OPENROUTER_API_KEY is not set/);

  const { spawnFn, calls } = fakeSpawn({ status: 0 });
  const scan = await commands.openrouter.run(['scan'], { env: BARE_ENV, spawnFn, capture: true });
  assert.equal(scan.code, 0);
  assert.deepEqual(calls[0].args.slice(1), ['scan']);
});

test('openrouter accepts the runner\'s own "eval" alias for evaluate', async () => {
  const { spawnFn, calls } = fakeSpawn({ status: 0 });
  const res = await commands.openrouter.run(['eval', 'https://example.com/job'], {
    env: { OPENROUTER_API_KEY: 'k' },
    spawnFn,
    capture: true,
  });
  assert.equal(res.code, 0);
  assert.deepEqual(calls[0].args.slice(1), ['evaluate', 'https://example.com/job']);
});

// ── exit 1: the check ran and failed ────────────────────────────────

test('a runner exiting non-zero after a clean preflight is a real negative finding', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ id: 'a', jd: 'x', label: { archetype: 'ic', score: 4 } }));
  const { spawnFn } = fakeSpawn({ status: 1, stderr: '❌ FAIL — archetype agreement below gate\n' });
  const res = await commands.golden.run(['--golden', dir], { env: BARE_ENV, spawnFn, capture: true });

  assert.equal(res.code, 1, 'a gate that ran and failed is 1, never 3');
  assertEnvelope(res.envelope, { command: 'eval golden', ok: false });
  assert.equal(res.envelope.errors[0].code, 'runner-failed');
  assert.equal(res.envelope.data.exitCode, 1);
  assert.match(res.envelope.errors[0].message, /archetype agreement below gate/);
});

// ── delegation details ──────────────────────────────────────────────

test('a relative path is resolved against the caller cwd, not the repo root', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'jd.txt'), 'a job');
  const { spawnFn, calls } = fakeSpawn({ status: 0 });

  const res = await commands.gemini.run(['--file', 'jd.txt'], {
    env: { GEMINI_API_KEY: 'k' },
    cwd: dir,
    spawnFn,
    capture: true,
  });

  assert.equal(res.code, 0);
  const fileArg = calls[0].args[calls[0].args.indexOf('--file') + 1];
  assert.ok(isAbsolute(fileArg), 'the child is handed an absolute path');
  assert.equal(fileArg, join(dir, 'jd.txt'));
  // The child runs from the repo root, which is why the path had to be made
  // absolute before being handed over.
  assert.ok(isAbsolute(calls[0].options.cwd));
});

test('only the flags the caller gave are forwarded — the runner keeps its own defaults', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'jd.txt'), 'a job');
  const { spawnFn, calls } = fakeSpawn({ status: 0 });

  await commands.openai.run(['--file', join(dir, 'jd.txt'), '--no-save'], {
    env: { OPENAI_API_KEY: 'k' },
    spawnFn,
    capture: true,
  });

  const args = calls[0].args.slice(1);
  assert.ok(args.includes('--no-save'));
  assert.ok(!args.includes('--model'), 'no --model was given, so none is forwarded');
  assert.ok(!args.includes('--no-compress'), 'an unset switch is not forwarded');
  assert.ok(!args.includes('--key'), 'a key taken from the env is not put on the command line');
});

test('without --json the child streams to the inherited stdio', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ id: 'a', jd: 'x', label: { archetype: 'ic', score: 4 } }));
  const { spawnFn, calls } = fakeSpawn({ status: 0 });
  const res = await commands.golden.run(['--golden', dir], { env: BARE_ENV, spawnFn });

  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(res.streamed, true);
  assert.equal(res.text, '', 'nothing to reprint — the child already wrote it');
});

test('--json captures the child instead of inheriting stdio', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ id: 'a', jd: 'x', label: { archetype: 'ic', score: 4 } }));
  const { spawnFn, calls } = fakeSpawn({ status: 0, stdout: 'PASS' });
  const res = await commands.golden.run(['--json', '--golden', dir], { env: BARE_ENV, spawnFn });

  assert.notEqual(calls[0].options.stdio, 'inherit');
  assert.equal(res.streamed, false);
  assert.equal(res.envelope.data.stdout, 'PASS');
});

