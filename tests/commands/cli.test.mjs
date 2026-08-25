// tests/commands/cli.test.mjs — the `career-ops` facade: dispatch, help,
// unknown-command handling, and the result normalisation that absorbs the ten
// noun modules' divergent return shapes.
//
// The normalisation cases are characterisation tests. The ten adapters were
// written in parallel and disagree on three keys; the collision that matters is
// `json`, which is a boolean ("was --json asked for") in six modules and the
// result envelope itself in `followup`. Reading one as the other is a silent
// corruption, so both readings are pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const { run, REGISTRY } = await import(join(HERE, '..', '..', 'src', 'cli.js'));

/** Drive the facade with captured streams. */
async function cli(argv, io = {}) {
  let out = '';
  let err = '';
  const code = await run(argv, { out: (s) => { out += s; }, err: (s) => { err += s; }, ...io });
  return { code, out, err };
}

const json = (s) => JSON.parse(s);

/** Register a synthetic noun for the normalisation cases, then remove it. */
function withNoun(noun, commands, fn) {
  REGISTRY.set(noun, commands);
  return (async () => {
    try { return await fn(); } finally { REGISTRY.delete(noun); }
  })();
}

const stub = (result) => ({ help: 'Stub.\n\nUsage: stub', flags: {}, run: async () => result });

// --------------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------------

test('all ten nouns are registered', () => {
  assert.deepEqual([...REGISTRY.keys()], [
    'apply', 'cv', 'eval', 'followup', 'insight',
    'pipeline', 'render', 'scan', 'system', 'tracker',
  ]);
});

test('every registered verb exposes a callable run and a help text', () => {
  for (const [noun, commands] of REGISTRY) {
    for (const [verb, cmd] of Object.entries(commands)) {
      assert.equal(typeof cmd.run, 'function', `${noun} ${verb} run`);
      const help = typeof cmd.help === 'function' ? cmd.help() : cmd.help;
      assert.ok(typeof help === 'string' && help.length > 0, `${noun} ${verb} help`);
    }
  }
});

// --------------------------------------------------------------------------
// Help at three levels
// --------------------------------------------------------------------------

test('--help enumerates every noun and every verb', async () => {
  const { code, out } = await cli(['--help']);
  assert.equal(code, 0);
  for (const [noun, commands] of REGISTRY) {
    assert.match(out, new RegExp(`^${noun} \\(${Object.keys(commands).length}\\):`, 'm'), noun);
    for (const verb of Object.keys(commands)) {
      assert.match(out, new RegExp(`^  ${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm'), `${noun} ${verb}`);
    }
  }
});

test('--help --json carries every noun and verb as data', async () => {
  const { code, out } = await cli(['--help', '--json']);
  assert.equal(code, 0);
  const env = json(out);
  assert.equal(env.ok, true);
  assert.equal(env.data.nouns.length, REGISTRY.size);
  const total = env.data.nouns.reduce((n, x) => n + x.verbs.length, 0);
  const expected = [...REGISTRY.values()].reduce((n, c) => n + Object.keys(c).length, 0);
  assert.equal(total, expected);
});

test('<noun> --help lists that noun\'s verbs and nothing else', async () => {
  const { code, out } = await cli(['render', '--help']);
  assert.equal(code, 0);
  for (const verb of Object.keys(REGISTRY.get('render'))) assert.match(out, new RegExp(`\\b${verb}\\b`));
  assert.doesNotMatch(out, /\bjd-skill-gap\b/);
});

test('<noun> <verb> --help documents that one command', async () => {
  const { code, out } = await cli(['render', 'mark-ready', '--help']);
  assert.equal(code, 0);
  assert.match(out, /Usage: career-ops render mark-ready/);
  assert.match(out, /Exit codes:/);
});

test('--help is answerable as JSON at all three levels', async () => {
  for (const argv of [['--help'], ['render', '--help'], ['render', 'mark-ready', '--help']]) {
    const { code, out } = await cli([...argv, '--json']);
    assert.equal(code, 0, argv.join(' '));
    const env = json(out);
    assert.equal(env.ok, true);
    assert.ok(Array.isArray(env.errors) && Array.isArray(env.warnings));
  }
});

test('every verb dispatches and answers --help with a valid envelope', async () => {
  for (const [noun, commands] of REGISTRY) {
    for (const verb of Object.keys(commands)) {
      const { code, out } = await cli([noun, verb, '--help', '--json']);
      assert.equal(code, 0, `${noun} ${verb} exit`);
      const env = json(out);
      assert.equal(env.ok, true, `${noun} ${verb} ok`);
      assert.equal(env.command, `${noun} ${verb}`, `${noun} ${verb} command field`);
    }
  }
});

// --------------------------------------------------------------------------
// Unknown commands — exit 2 with a suggestion
// --------------------------------------------------------------------------

test('an unknown noun exits 2 and suggests the closest one', async () => {
  const { code, err } = await cli(['trakcer', 'list']);
  assert.equal(code, 2);
  assert.match(err, /unknown command: trakcer/);
  assert.match(err, /career-ops tracker/);
});

test('an unknown noun that names a verb suggests the full command', async () => {
  const { code, err } = await cli(['doctor']);
  assert.equal(code, 2);
  assert.match(err, /career-ops system doctor/);
});

test('an unknown verb exits 2 and suggests the closest verb under that noun', async () => {
  const { code, err } = await cli(['render', 'markready']);
  assert.equal(code, 2);
  assert.match(err, /unknown verb: render markready/);
  assert.match(err, /career-ops render mark-ready/);
});

test('a token close to nothing lists the nouns rather than guessing', async () => {
  const { code, err } = await cli(['zzzzzzzz']);
  assert.equal(code, 2);
  assert.match(err, /Nouns: apply, cv, eval/);
});

test('an unknown command reports as JSON when asked', async () => {
  const { code, out } = await cli(['zzzzzzzz', '--json']);
  assert.equal(code, 2);
  const env = json(out);
  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, 'usage');
});

test('no command and a bare noun are both usage errors', async () => {
  assert.equal((await cli([])).code, 2);
  assert.equal((await cli(['pipeline'])).code, 2);
});

test('a bare noun still shows that noun\'s verbs', async () => {
  const { err } = await cli(['pipeline']);
  assert.match(err, /no verb given for `pipeline`/);
  assert.match(err, /inbox-list/);
});

test('--version answers in both modes', async () => {
  const prose = await cli(['--version']);
  assert.equal(prose.code, 0);
  assert.match(prose.out.trim(), /^\d+\.\d+\.\d+/);
  const asJson = await cli(['--version', '--json']);
  assert.equal(json(asJson.out).data.version, prose.out.trim());
});

test('a command\'s own --version is not shadowed by the global one', async () => {
  // `apply artifacts --version <n>` is the tailored-CV version. A global
  // --version that fired after dispatch would print the package version and
  // silently never build the bundle.
  const { code, out } = await cli(['apply', 'artifacts', '--report', '7', '--company', 'Acme', '--role', 'Engineer', '--version', '3', '--json']);
  assert.equal(code, 0);
  assert.match(json(out).data.cv.tailored.root, /v003$/);
});

// --------------------------------------------------------------------------
// Result normalisation — the ten modules' divergent shapes
// --------------------------------------------------------------------------

test('a boolean `json` key is never mistaken for the envelope', () => withNoun('stubnoun', {
  // cv/eval/insight/pipeline/render/system return `json: false` meaning "prose
  // was asked for". Reading that as the result would drop the real envelope.
  v: stub({ exitCode: 0, json: false, envelope: { ok: true, command: 'stubnoun v', data: { real: 1 }, warnings: [], errors: [] }, text: 'prose' }),
}, async () => {
  const { code, out } = await cli(['stubnoun', 'v', '--json']);
  assert.equal(code, 0);
  assert.deepEqual(json(out).data, { real: 1 });
}));

test('an object `json` key IS the envelope when no envelope key is offered', () => withNoun('stubnoun', {
  // followup's shape: `json` holds the envelope and there is no `envelope` key.
  v: stub({ exitCode: 0, json: { ok: true, command: 'stubnoun v', data: { fromJson: true }, warnings: [], errors: [] }, text: 'prose' }),
}, async () => {
  const { out } = await cli(['stubnoun', 'v', '--json']);
  assert.deepEqual(json(out).data, { fromJson: true });
}));

test('`envelope` wins when a module offers both keys', () => withNoun('stubnoun', {
  // No module does this today (checked across all 84 verbs: an object `json`
  // and an `envelope` never coexist). Pinned so that if one ever returns a
  // delegate's parsed stdout as `json`, the declared envelope still wins.
  v: stub({
    exitCode: 0,
    json: { ok: true, command: 'stubnoun v', data: { from: 'json' }, warnings: [], errors: [] },
    envelope: { ok: true, command: 'stubnoun v', data: { from: 'envelope' }, warnings: [], errors: [] },
  }),
}, async () => {
  const { out } = await cli(['stubnoun', 'v', '--json']);
  assert.deepEqual(json(out).data, { from: 'envelope' });
}));

test('`code` is honoured where a module does not return `exitCode`', () => withNoun('stubnoun', {
  // eval, render and tracker return `code`; the other seven return `exitCode`.
  v: stub({ code: 1, envelope: { ok: false, command: 'stubnoun v', data: {}, warnings: [], errors: [{ code: 'x', message: 'y' }] } }),
}, async () => {
  assert.equal((await cli(['stubnoun', 'v'])).code, 1);
}));

test('tracker\'s stdout/stderr pair is routed to the right streams', () => withNoun('stubnoun', {
  v: stub({ code: 1, stdout: 'to-stdout', stderr: 'to-stderr', envelope: { ok: false, command: 'stubnoun v', data: {}, warnings: [], errors: [{ code: 'x', message: 'y' }] } }),
}, async () => {
  const { code, out, err } = await cli(['stubnoun', 'v']);
  assert.equal(code, 1);
  assert.match(out, /to-stdout/);
  assert.match(err, /to-stderr/);
}));

test('a streamed result is not reprinted', () => withNoun('stubnoun', {
  // eval streams long runs to inherited stdio; printing `text` too would double it.
  v: stub({ code: 0, streamed: true, text: 'already-on-screen', envelope: { ok: true, command: 'stubnoun v', data: {}, warnings: [], errors: [] } }),
}, async () => {
  const { out } = await cli(['stubnoun', 'v']);
  assert.equal(out, '');
}));

// --------------------------------------------------------------------------
// ADR 0006 — could not verify is never nothing found
// --------------------------------------------------------------------------

test('an adapter that throws is exit 3, not exit 1', () => withNoun('stubnoun', {
  v: { help: 'Stub.', flags: {}, run: async () => { throw new Error('boom'); } },
}, async () => {
  const { code, err } = await cli(['stubnoun', 'v']);
  assert.equal(code, 3);
  assert.match(err, /could not verify/);
  const asJson = await cli(['stubnoun', 'v', '--json']);
  assert.equal(asJson.code, 3);
  assert.equal(json(asJson.out).ok, false);
}));

test('--json with no envelope is exit 3, never a green empty result', () => withNoun('stubnoun', {
  v: stub({ exitCode: 0, text: 'prose only' }),
}, async () => {
  const { code, out } = await cli(['stubnoun', 'v', '--json']);
  assert.equal(code, 3);
  const env = json(out);
  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, 'could-not-verify');
}));

test('a real command distinguishes "ran and found nothing" (1) from "could not run" (3)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-cli-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    const tracker = join(dir, 'data', 'applications.md');
    writeFileSync(tracker, '# Applications\n\n| # | Company | Role | Status | Report |\n|---|---|---|---|---|\n| 1 | Acme | Engineer | Applied | |\n');

    const ran = await cli(['apply', 'find', 'zzzznomatch', '--json'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker } });
    assert.equal(ran.code, 1, 'a search that ran and matched nothing is a finding');
    assert.equal(json(ran.out).errors[0].code, 'no-match');

    const absent = await cli(['apply', 'find', 'zzzznomatch', '--json'], { env: { ...process.env, CAREER_OPS_TRACKER: join(dir, 'gone.md') } });
    assert.equal(absent.code, 3, 'a search with no tracker did not run');
    assert.equal(json(absent.out).ok, false);
    assert.equal(json(absent.out).errors[0].code, 'could-not-verify');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  }
});
