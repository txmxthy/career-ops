/**
 * Tests for src/commands/render.js — the four `career-ops render` commands.
 *
 * What is being pinned, in ADR terms:
 *
 *   ADR 0003 — every row the taxonomy assigns to `render` is present, under its
 *     renamed verb, with the taxonomy spelling kept as an alias.
 *   ADR 0006 — `--help` and `--json` on every command without exception; every
 *     outcome is a valid envelope; and, above all, exit 3 is reachable and
 *     distinct from exit 1. A check that could not run must never come back as
 *     `ok: true` with empty data, and must never come back as exit 1 either —
 *     that is the "nothing found" report the ADR exists to ban.
 *   ADR 0004 A4 — `--max-pages 3` reaches the frozen delegate as
 *     `--max-pages=3`, the only form generate-pdf.mjs:1093-1099 can see.
 *
 * The delegates are injected (`ctx.exec`, `ctx.convert`), so nothing here
 * launches Chromium, the Go toolchain, or a tracker write. The translation
 * table between the delegates' exit codes and ADR 0006's IS the adapter, so it
 * is what these tests exercise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import render, { noun, commands } from '../../src/commands/render.js';
import { EXIT } from '../../src/core/flags.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A sandbox that cleans itself up when the process ends. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'render-cmd-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
  return dir;
}

/** A delegate stand-in that records how it was called. */
function fakeExec(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const exec = async (file, args, options) => { calls.push({ file, args, options }); return result; };
  exec.calls = calls;
  return exec;
}

/** Assert the ADR 0006 envelope shape and both of its invariants. */
function assertEnvelope(env, command) {
  assert.deepEqual(Object.keys(env).sort(), ['command', 'data', 'errors', 'ok', 'warnings']);
  assert.equal(env.command, command);
  assert.equal(typeof env.ok, 'boolean');
  assert.equal(typeof env.data, 'object');
  assert.ok(Array.isArray(env.warnings));
  assert.ok(Array.isArray(env.errors));
  // ok:false must carry a reason; ok:true must carry none. This is what stops
  // an unperformed check being reported as an empty one.
  if (env.ok === false) assert.ok(env.errors.length > 0, 'a failed envelope must carry an error');
  else assert.equal(env.errors.length, 0, 'a successful envelope must not carry errors');
  for (const e of env.errors) {
    assert.equal(typeof e.code, 'string');
    assert.equal(typeof e.message, 'string');
    assert.notEqual(e.message.trim(), '');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(env)), env, 'the envelope must survive a JSON round trip');
}

// ── the noun's shape (ADR 0003) ─────────────────────────────────────

test('the module exports the render noun and its four commands', () => {
  assert.equal(noun, 'render');
  assert.equal(render.noun, 'render');
  assert.deepEqual(Object.keys(commands).sort(), ['dashboard', 'image', 'mark-ready', 'pdf']);
});

test('every command exposes run, help and flags', () => {
  for (const [verb, cmd] of Object.entries(commands)) {
    assert.equal(typeof cmd.run, 'function', `${verb}.run`);
    assert.equal(typeof cmd.help, 'string', `${verb}.help`);
    assert.notEqual(cmd.help.trim(), '', `${verb}.help is empty`);
    assert.equal(typeof cmd.flags, 'object', `${verb}.flags`);
    assert.equal(typeof cmd.describe, 'string', `${verb}.describe`);
  }
});

test('every ADR 0003 render row survives the rename as an alias', () => {
  // The taxonomy names four scripts; the verbs read better shortened, so the
  // old spelling has to remain reachable or the ADR row is silently dropped.
  const aliases = Object.values(commands).flatMap((c) => c.aliases);
  for (const taxonomyVerb of ['generate-pdf', 'img-to-pdf', 'build-dashboard', 'mark-pdf-ready']) {
    assert.ok(aliases.includes(taxonomyVerb), `${taxonomyVerb} has no home in the render noun`);
  }
});

// ── --help and --json on every command (ADR 0006) ───────────────────

for (const [verb, cmd] of Object.entries(commands)) {
  test(`render ${verb} --help prints usage and exits 0`, async () => {
    const res = await cmd.run(['--help']);
    assert.equal(res.code, EXIT.OK);
    assert.match(res.text, /\nUsage: career-ops render /);
    assert.match(res.text, /Exit codes:/);
    assert.match(res.text, /--json/, '--json must be documented, not just accepted');
    assertEnvelope(res.envelope, `render ${verb}`);
    assert.equal(res.envelope.ok, true);
    assert.equal(res.envelope.data.help, res.text);
  });

  test(`render ${verb} --help --json is still a valid envelope`, async () => {
    const res = await cmd.run(['--help', '--json']);
    assert.equal(res.code, EXIT.OK);
    assert.equal(res.json, true, '--json must be visible to the facade');
    assertEnvelope(res.envelope, `render ${verb}`);
  });

  test(`render ${verb} reports an unknown flag as a usage error, not a failure`, async () => {
    const res = await cmd.run(['--definitely-not-a-flag']);
    assert.equal(res.code, EXIT.USAGE);
    assertEnvelope(res.envelope, `render ${verb}`);
    assert.equal(res.envelope.ok, false);
    assert.match(res.envelope.errors[0].message, /--definitely-not-a-flag/);
  });
}

// ── could not run is exit 3, never exit 1 (ADR 0006) ────────────────

test('render pdf: a missing input HTML could not be rendered — 3, not 1', async () => {
  const exec = fakeExec();
  const res = await commands.pdf.run(['no-such-file.html', 'out.pdf'], { rootDir: ROOT, cwd: sandbox(), exec });
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.equal(res.envelope.ok, false);
  assertEnvelope(res.envelope, 'render pdf');
  assert.match(res.envelope.errors[0].message, /^could not verify: input HTML not found/);
  assert.equal(res.envelope.errors[0].code, 'could-not-verify');
  assert.equal(exec.calls.length, 0, 'the delegate must not be launched with no input');
});

test('render pdf: a missing batch manifest could not be rendered — 3', async () => {
  const exec = fakeExec();
  const res = await commands.pdf.run(['--batch', 'gone.json'], { rootDir: ROOT, cwd: sandbox(), exec });
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /could not verify: batch manifest not found/);
});

test('render pdf: an absent delegate is a could-not-run, not a render failure', async () => {
  const res = await commands.pdf.run(['a.html', 'b.pdf'], { rootDir: sandbox(), cwd: sandbox(), exec: fakeExec() });
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /generate-pdf\.mjs not found/);
});

test('render pdf: an unavailable Chromium is a could-not-run, not a failed render', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'cv.html'), '<html></html>');
  const exec = fakeExec({
    status: 1, stdout: '', stderr: "browserType.launch: Executable doesn't exist at /ms-playwright/chromium",
  });
  const res = await commands.pdf.run(['cv.html', 'cv.pdf'], { rootDir: ROOT, cwd: dir, exec });
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.equal(res.envelope.ok, false);
  assert.match(res.envelope.errors[0].message, /could not verify: the Chromium build/);
  // What was gathered before giving up is kept — an unverified result is still
  // allowed to say what it was trying to do.
  assert.equal(res.envelope.data.mode, 'single');
});

test('render image: a missing image could not be converted — 3', async () => {
  const res = await commands.image.run(['gone.png', 'out.pdf'], { cwd: sandbox() });
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.equal(res.envelope.ok, false);
  assert.match(res.envelope.errors[0].message, /^could not verify: image not found/);
});

test('render dashboard: no dashboard source is a could-not-run — 3', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'src/scripts/build-dashboard.mjs'), '// stand-in\n');
  const exec = fakeExec();
  const res = await commands.dashboard.run([], { rootDir: dir, cwd: dir, exec });
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /could not verify: no dashboard source/);
  assert.equal(exec.calls.length, 0);
});

test('render mark-ready: an unparseable delegate result is 3, not "not ready"', async () => {
  // The delegate was asked for JSON and did not give any, so no verdict was
  // received. Exit 1 here would assert a finding on evidence that does not exist.
  const exec = fakeExec({ status: 1, stdout: 'Segmentation fault', stderr: '' });
  const res = await commands['mark-ready'].run(['18'], { rootDir: ROOT, cwd: sandbox(), exec });
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.equal(res.envelope.ok, false);
  assert.match(res.envelope.errors[0].message, /could not verify: mark-pdf-ready\.mjs --json emitted no parseable result/);
});

test('render mark-ready: a delegate that never started is 3', async () => {
  const exec = fakeExec({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } });
  const res = await commands['mark-ready'].run(['18'], { rootDir: ROOT, cwd: sandbox(), exec });
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /could not verify: could not start mark-pdf-ready\.mjs \(ENOENT\)/);
});

// ── usage errors are 2, not 1 (ADR 0006) ────────────────────────────

test('render pdf: the operands are required', async () => {
  const res = await commands.pdf.run(['only-one.html'], { rootDir: ROOT, cwd: sandbox(), exec: fakeExec() });
  assert.equal(res.code, EXIT.USAGE);
  assert.match(res.envelope.errors[0].message, /expected <input\.html> <output\.pdf>/);
});

test('render pdf: --batch takes no positionals', async () => {
  const res = await commands.pdf.run(['--batch', 'm.json', 'a.html'], { rootDir: ROOT, cwd: sandbox(), exec: fakeExec() });
  assert.equal(res.code, EXIT.USAGE);
  assert.match(res.envelope.errors[0].message, /--batch takes no positional arguments/);
});

test('render pdf: --report is refused with --batch rather than mislabelling N CVs', async () => {
  const res = await commands.pdf.run(['--batch', 'm.json', '--report', '18'], { rootDir: ROOT, cwd: sandbox(), exec: fakeExec() });
  assert.equal(res.code, EXIT.USAGE);
  assert.match(res.envelope.errors[0].message, /--report is not valid with --batch/);
});

test('render pdf: a bad --format is a usage error, not a failed render', async () => {
  const res = await commands.pdf.run(['a.html', 'b.pdf', '--format', 'a3'], { rootDir: ROOT, cwd: sandbox(), exec: fakeExec() });
  assert.equal(res.code, EXIT.USAGE);
  assert.match(res.envelope.errors[0].message, /invalid --format "a3"/);
});

test('render pdf: a non-integer --max-pages is a usage error', async () => {
  const res = await commands.pdf.run(['a.html', 'b.pdf', '--max-pages', '0'], { rootDir: ROOT, cwd: sandbox(), exec: fakeExec() });
  assert.equal(res.code, EXIT.USAGE);
  assert.match(res.envelope.errors[0].message, /invalid --max-pages "0"/);
});

test('render mark-ready: a non-numeric report selector is a usage error', async () => {
  const res = await commands['mark-ready'].run(['eighteen'], { rootDir: ROOT, cwd: sandbox(), exec: fakeExec() });
  assert.equal(res.code, EXIT.USAGE);
  assert.match(res.envelope.errors[0].message, /"eighteen" is not a valid report number/);
});

test('render image: both operands are required', async () => {
  const res = await commands.image.run(['only.png'], { cwd: sandbox() });
  assert.equal(res.code, EXIT.USAGE);
  assert.match(res.envelope.errors[0].message, /expected <image> <output\.pdf>/);
});

// ── the delegate is called with the frozen argv shape ───────────────

test('render pdf rewrites the space form into the = form the delegate can see', async () => {
  // ADR 0004 A4: generate-pdf.mjs:1093-1099 reads only `--flag=value`, so
  // `--max-pages 3` is invisible to it and silently falls back to the default.
  // Parsing with flags.js and re-emitting in the = form is how the space form
  // starts working without editing the frozen script.
  const dir = sandbox();
  writeFileSync(join(dir, 'cv.html'), '<html></html>');
  const exec = fakeExec({ status: 0, stdout: 'PDF generated\n', stderr: '' });
  const res = await commands.pdf.run(
    ['cv.html', 'cv.pdf', '--max-pages', '3', '--format', 'LETTER', '--report', '018', '--strict-pages', '--allow-reorder'],
    { rootDir: ROOT, cwd: dir, exec },
  );
  assert.equal(res.code, EXIT.OK);
  const args = exec.calls[0].args;
  assert.equal(args[0], resolve(ROOT, 'generate-pdf.mjs'));
  assert.equal(args[1], join(dir, 'cv.html'));
  assert.equal(args[2], join(dir, 'cv.pdf'));
  assert.ok(args.includes('--max-pages=3'), `expected --max-pages=3 in ${args.join(' ')}`);
  assert.ok(args.includes('--format=letter'), 'the delegate only accepts lowercase formats');
  assert.ok(args.includes('--report=018'));
  assert.ok(args.includes('--strict-pages'));
  assert.ok(args.includes('--allow-reorder'));
  assertEnvelope(res.envelope, 'render pdf');
  assert.deepEqual(res.envelope.data.log, ['PDF generated']);
  assert.equal(res.envelope.data.format, 'letter');
  assert.equal(res.envelope.data.maxPages, 3);
});

test('render mark-ready always asks the delegate for JSON, whatever the user asked for', async () => {
  // The exit-code translation reads the delegate's structured `code`; its exit
  // status alone cannot tell no-pdf-column from write-failure.
  const exec = fakeExec({ status: 0, stdout: JSON.stringify({ changed: true, num: 4, company: 'Acme', role: 'SRE', reportNum: 18, tracker: '/t.md' }), stderr: '' });
  const res = await commands['mark-ready'].run(['18', '--dry-run'], { rootDir: ROOT, cwd: sandbox(), exec });
  assert.equal(res.code, EXIT.OK);
  const args = exec.calls[0].args;
  assert.deepEqual(args.slice(1), ['18', '--json', '--dry-run']);
  assert.equal(res.json, false, 'the delegate flag must not leak into the caller-facing --json');
  assertEnvelope(res.envelope, 'render mark-ready');
  assert.equal(res.envelope.data.changed, true);
  assert.match(res.text, /^✅ #4 Acme — SRE: marked PDF ready$/);
});

// ── the delegates' exit codes are translated, not inherited ─────────

test('mark-pdf-ready.mjs codes map onto ADR 0006 codes', async () => {
  // Its CLI_EXIT spends 2 on not-found and 3 on ambiguous — both real findings
  // under ADR 0006, and 3 there means the opposite of what it means here.
  const cases = [
    ['usage', EXIT.USAGE],
    ['no-tracker', EXIT.UNVERIFIED],
    ['read-failure', EXIT.UNVERIFIED],
    ['lock-timeout', EXIT.UNVERIFIED],
    ['lock-error', EXIT.CONFIG],
    ['write-failure', EXIT.CONFIG],
    ['no-pdf-column', EXIT.FAILED],
    ['empty-tracker', EXIT.FAILED],
    ['not-found', EXIT.FAILED],
    ['ambiguous', EXIT.FAILED],
  ];
  for (const [code, expected] of cases) {
    const exec = fakeExec({ status: 2, stdout: JSON.stringify({ error: `boom: ${code}`, code }), stderr: '' });
    const res = await commands['mark-ready'].run(['18'], { rootDir: ROOT, cwd: sandbox(), exec });
    assert.equal(res.code, expected, `${code} should exit ${expected}, got ${res.code}`);
    assert.equal(res.envelope.ok, false, `${code} must not report ok:true`);
    assertEnvelope(res.envelope, 'render mark-ready');
    assert.match(res.envelope.errors[0].message, new RegExp(`boom: ${code}`));
  }
});

test('mark-pdf-ready.mjs keeps the extra fields it reported alongside a failure', async () => {
  const candidates = [{ num: 3, company: 'A', role: 'X' }, { num: 9, company: 'B', role: 'Y' }];
  const exec = fakeExec({ status: 3, stdout: JSON.stringify({ error: 'two rows', code: 'ambiguous', candidates }), stderr: '' });
  const res = await commands['mark-ready'].run(['18'], { rootDir: ROOT, cwd: sandbox(), exec });
  assert.equal(res.code, EXIT.FAILED);
  assert.deepEqual(res.envelope.data.candidates, candidates);
});

test('render dashboard: a missing Go toolchain is an environment error, not a failed build', async () => {
  const exec = fakeExec({ status: 1, stdout: '', stderr: 'Go toolchain not found. Install Go 1.24+ from https://go.dev/dl/ and retry.' });
  const res = await commands.dashboard.run([], { rootDir: ROOT, cwd: sandbox(), exec });
  assert.equal(res.code, EXIT.CONFIG);
  assert.equal(res.envelope.ok, false);
  assert.equal(res.envelope.errors[0].code, 'no-toolchain');
});

test('render dashboard: a compile failure is a real finding — 1', async () => {
  const exec = fakeExec({ status: 2, stdout: '', stderr: 'internal/ui/app.go:12:2: undefined: foo' });
  const res = await commands.dashboard.run([], { rootDir: ROOT, cwd: sandbox(), exec });
  assert.equal(res.code, EXIT.FAILED);
  assert.match(res.envelope.errors[0].message, /undefined: foo/);
});

test('render dashboard reads the built binary name back from the delegate', async () => {
  // The name is platform-dependent (.exe on Windows); deriving it a second time
  // here is exactly the duplication this refactor exists to remove.
  const exec = fakeExec({ status: 0, stdout: 'Built dashboard/career-dashboard — run it with: npm run serve:dashboard\n', stderr: '' });
  const res = await commands.dashboard.run([], { rootDir: ROOT, cwd: sandbox(), exec });
  assert.equal(res.code, EXIT.OK);
  assert.equal(res.envelope.data.binary, 'dashboard/career-dashboard');
  assertEnvelope(res.envelope, 'render dashboard');
});

test('render pdf: a delegate failure with a message is a finding — 1', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'cv.html'), '<html></html>');
  const exec = fakeExec({ status: 1, stdout: '', stderr: 'CV section order is wrong: Experience before Summary' });
  const res = await commands.pdf.run(['cv.html', 'cv.pdf'], { rootDir: ROOT, cwd: dir, exec });
  assert.equal(res.code, EXIT.FAILED);
  assert.match(res.envelope.errors[0].message, /CV section order is wrong/);
  assertEnvelope(res.envelope, 'render pdf');
});

// ── render image runs in process ────────────────────────────────────

test('render image refuses to clobber an existing PDF without --force', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'shot.png'), 'not really a png');
  writeFileSync(join(dir, 'out.pdf'), 'existing');
  let called = false;
  const convert = async () => { called = true; };
  const res = await commands.image.run(['shot.png', 'out.pdf'], { cwd: dir, convert });
  assert.equal(res.code, EXIT.FAILED);
  assert.equal(res.envelope.errors[0].code, 'output-exists');
  assert.equal(called, false);
  assert.equal(readFileSync(join(dir, 'out.pdf'), 'utf-8'), 'existing', 'the existing PDF must be untouched');
});

test('render image overwrites with --force and reports the page size', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'shot.png'), 'not really a png');
  writeFileSync(join(dir, 'out.pdf'), 'existing');
  const convert = async (input, output) => ({ outputPath: output, size: 2048, width: 800, height: 600 });
  const res = await commands.image.run(['shot.png', 'out.pdf', '--force'], { cwd: dir, convert });
  assert.equal(res.code, EXIT.OK);
  assertEnvelope(res.envelope, 'render image');
  assert.deepEqual(res.envelope.data, {
    input: join(dir, 'shot.png'), output: join(dir, 'out.pdf'), width: 800, height: 600, bytes: 2048,
  });
  assert.match(res.text, /800x600px, 2\.0 KB/);
});

test('render image reports an unsupported type as a finding, in the converter\'s own words', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'notes.txt'), 'hello');
  const convert = async () => { throw new Error('Unsupported image type: .txt. Supported: .png, .jpg'); };
  const res = await commands.image.run(['notes.txt', 'out.pdf'], { cwd: dir, convert });
  assert.equal(res.code, EXIT.FAILED);
  assert.match(res.envelope.errors[0].message, /^Unsupported image type: \.txt/);
});

test('render image: an unavailable Chromium is a could-not-run — 3', async () => {
  const dir = sandbox();
  writeFileSync(join(dir, 'shot.png'), 'x');
  const convert = async () => { throw new Error("browserType.launch: Executable doesn't exist"); };
  const res = await commands.image.run(['shot.png', 'out.pdf'], { cwd: dir, convert });
  assert.equal(res.code, EXIT.UNVERIFIED);
  assert.match(res.envelope.errors[0].message, /^could not verify: the Chromium build/);
});

// ── adapters hold no logic and no I/O of their own ──────────────────

test('the adapters neither print nor exit', () => {
  // ADR 0006: a command file parses nothing and prints nothing. run() returns
  // the envelope and the facade decides which stream it goes to — a console
  // call here would put prose on stdout in front of a --json consumer.
  const src = readFileSync(join(ROOT, 'src/commands/render.js'), 'utf-8');
  assert.doesNotMatch(src, /console\./);
  assert.doesNotMatch(src, /process\.exit\s*\(/);
});

test('the render module imports no delegate at load time', async () => {
  // src/scripts/img-to-pdf.mjs pulls in Playwright. A static import would make
  // `career-ops render dashboard --help` fail on a checkout with no browser
  // installed, which is the whole point of loading it inside run().
  const src = readFileSync(join(ROOT, 'src/commands/render.js'), 'utf-8');
  const staticImports = [...src.matchAll(/^import .*from '([^']+)';$/gm)].map((m) => m[1]);
  for (const spec of staticImports) {
    assert.ok(spec.startsWith('node:') || spec.startsWith('../core/'),
      `${spec} is imported at load time — delegates must be reached lazily`);
  }
});

test('a fresh sandbox with no repo around it still gets a usable --help', async () => {
  // The facade must be able to print help on a broken checkout; --help may not
  // depend on any delegate being present.
  const dir = sandbox();
  mkdirSync(join(dir, 'empty'));
  for (const [verb, cmd] of Object.entries(commands)) {
    const res = await cmd.run(['--help'], { rootDir: join(dir, 'empty'), cwd: dir, exec: fakeExec() });
    assert.equal(res.code, EXIT.OK, `render ${verb} --help`);
  }
});
