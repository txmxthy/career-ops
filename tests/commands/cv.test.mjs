/**
 * Tests for src/commands/cv.js — the `career-ops cv <verb>` adapters.
 *
 * Three things are pinned here:
 *
 *   1. The ADR 0006 contract every command owes: `--help` works, `--json`
 *      emits a valid envelope, and the envelope's invariants hold on every
 *      path (ok:false always carries an error; ok:true never does).
 *   2. The exit codes, and in particular the ones this layer deliberately
 *      changes. The root scripts answer 1 for "the input was not there", which
 *      is indistinguishable from "the CV failed the fact gate". Every such
 *      case is 3 here and has a test naming the root behaviour it replaces.
 *   3. The verb names, so a rename away from the ADR 0003 classifier's output
 *      is a visible diff rather than a silent drift.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { noun, commands } from '../../src/commands/cv.js';
import { EXIT } from '../../src/core/flags.js';

const VERBS = ['build-html', 'build-latex', 'sync-check', 'cover-letter', 'verify-facts'];

let sandbox;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'career-ops-cv-'));
  mkdirSync(join(sandbox, 'out'), { recursive: true });

  writeFileSync(join(sandbox, 'cv.md'), 'Reached 16,181 active users across 80 courses.\n');
  writeFileSync(join(sandbox, 'supported.md'), 'We reached 16,181 active users.\n');
  writeFileSync(join(sandbox, 'invented.md'), 'We reached 999,999 active users.\n');
  writeFileSync(join(sandbox, 'payload.json'), JSON.stringify({
    name: 'Test Candidate',
    contact_line: 'City | +1 234 567 8900',
    email: { url: 'test@example.com', display: 'test@example.com' },
    linkedin: { url: 'https://linkedin.com/in/test', display: 'linkedin.com/in/test' },
    github: { url: 'https://github.com/test', display: 'github.com/test' },
    education: [{ institution: 'Test University', location: 'City', degree: 'BSc Testing', dates: '2020 - 2024' }],
    experience: [{ company: 'Test Corp', role: 'Engineer', location: 'Remote', dates: '2024 - Present', bullets: ['Built pipelines'] }],
    projects: [{ name: 'Proj', context: 'Python', dates: '2024', bullets: ['Built an API'] }],
    awards: [{ title: 'Award', org: 'Org', year: '2023' }],
    skills: [{ category: 'Languages', items: 'Python' }],
  }));
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/** Assert the ADR 0006 envelope shape and its two invariants. */
function assertEnvelope(res, command) {
  const env = res.envelope;
  assert.equal(typeof env, 'object', 'a result must carry an envelope');
  assert.deepEqual(Object.keys(env).sort(), ['command', 'data', 'errors', 'ok', 'warnings']);
  assert.equal(env.command, command);
  assert.equal(typeof env.ok, 'boolean');
  assert.equal(typeof env.data, 'object');
  assert.ok(Array.isArray(env.warnings));
  assert.ok(Array.isArray(env.errors));
  // The invariant the whole contract rests on: a check that could not run must
  // never look like one that ran and found nothing.
  if (env.ok === false) assert.ok(env.errors.length > 0, 'a failed envelope must carry an error');
  if (env.ok === true) assert.equal(env.errors.length, 0, 'a successful envelope must carry no errors');
  assert.equal(env.ok, res.exitCode === EXIT.OK, 'ok must agree with a zero exit code');
  // The envelope must survive the round trip an agent will put it through.
  assert.deepEqual(JSON.parse(JSON.stringify(env)), env);
  return env;
}

// ── The noun's shape ────────────────────────────────────────────────

test('exports the cv noun with a run, help and flags per verb', () => {
  assert.equal(noun, 'cv');
  assert.deepEqual(Object.keys(commands).sort(), [...VERBS].sort());
  for (const verb of VERBS) {
    const cmd = commands[verb];
    assert.equal(typeof cmd.run, 'function', `${verb}.run`);
    assert.equal(typeof cmd.help, 'string', `${verb}.help`);
    assert.equal(typeof cmd.flags, 'object', `${verb}.flags`);
  }
});

test('the ADR 0003 classifier names are renamed, not silently kept', () => {
  // ADR 0003 calls the classifier a starting point. `cv build-cv-html` stutters
  // against its own noun and `generate-cover-letter` is the only verb with a
  // verb prefix; both are renamed. playwright.cv.config is not a command at all
  // — it is the config file `playwright test --config=` reads.
  for (const stale of ['build-cv-html', 'build-cv-latex', 'generate-cover-letter', 'verify-cv-facts', 'playwright.cv.config']) {
    assert.equal(commands[stale], undefined, `${stale} should not be a verb`);
  }
});

// ── --help ──────────────────────────────────────────────────────────

test('--help documents each command and exits 0', async () => {
  for (const verb of VERBS) {
    const res = await commands[verb].run(['--help']);
    assert.equal(res.exitCode, EXIT.OK, `${verb} --help exit`);
    const env = assertEnvelope(res, `cv ${verb}`);
    assert.ok(env.data.help.includes('Usage:'), `${verb} --help usage`);
    assert.ok(env.data.help.includes('Exit codes:'), `${verb} --help exit codes`);
    assert.ok(env.data.help.includes('--json'), `${verb} --help mentions --json`);
    assert.equal(res.text, env.data.help);
    // The precomputed help on the export matches what --help prints.
    assert.equal(commands[verb].help, env.data.help, `${verb} help export`);
  }
});

test('-h is the same as --help', async () => {
  const short = await commands['sync-check'].run(['-h']);
  const long = await commands['sync-check'].run(['--help']);
  assert.equal(short.exitCode, EXIT.OK);
  assert.equal(short.text, long.text);
});

// ── --json ──────────────────────────────────────────────────────────

test('--json is answered by every command and emits a valid envelope', async () => {
  for (const verb of VERBS) {
    const res = await commands[verb].run(['--help', '--json']);
    assert.equal(res.json, true, `${verb} should report --json`);
    assertEnvelope(res, `cv ${verb}`);
  }
});

test('--json survives a failure path too', async () => {
  const res = await commands['verify-facts'].run([join(sandbox, 'absent.md'), '--json']);
  assert.equal(res.json, true);
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assertEnvelope(res, 'cv verify-facts');
});

// ── Usage errors — exit 2 ───────────────────────────────────────────

test('an unknown flag is a usage error, not a failed check', async () => {
  const res = await commands['build-latex'].run(['--bogus']);
  assert.equal(res.exitCode, EXIT.USAGE);
  const env = assertEnvelope(res, 'cv build-latex');
  assert.equal(env.errors[0].code, 'unknown-flag');
  assert.ok(res.text.includes('Usage:'), 'a usage error should print the help');
});

test('a bad flag is reported even alongside --help', async () => {
  // flags.js collects flag errors before it honours --help, so `--help --bogus`
  // must not exit 0 having never looked at --bogus.
  const res = await commands['build-latex'].run(['--help', '--bogus']);
  assert.equal(res.exitCode, EXIT.USAGE);
  assert.equal(res.envelope.errors[0].flag, '--bogus');
});

test('build-html without an output path is a usage error', async () => {
  const res = await commands['build-html'].run([join(sandbox, 'payload.json')]);
  assert.equal(res.exitCode, EXIT.USAGE);
  assert.equal(assertEnvelope(res, 'cv build-html').errors[0].code, 'missing-positional');
});

test('build-html rejects --preview together with an output path', async () => {
  const res = await commands['build-html'].run(['--preview', join(sandbox, 'payload.json'), 'out.html']);
  assert.equal(res.exitCode, EXIT.USAGE);
  assert.equal(res.envelope.errors[0].code, 'unexpected-positional');
});

test('cover-letter requires --payload', async () => {
  const res = await commands['cover-letter'].run([]);
  assert.equal(res.exitCode, EXIT.USAGE);
  assert.equal(assertEnvelope(res, 'cv cover-letter').errors[0].flag, '--payload');
});

test('cover-letter rejects a page format generate-pdf does not know', async () => {
  // generate-cover-letter.mjs passes --format straight through, so a typo
  // renders at the default size and says nothing.
  const res = await commands['cover-letter'].run(['--payload', join(sandbox, 'payload.json'), '--format', 'tabloid']);
  assert.equal(res.exitCode, EXIT.USAGE);
  const env = assertEnvelope(res, 'cv cover-letter');
  assert.equal(env.errors[0].code, 'invalid-value');
  assert.ok(env.errors[0].message.includes('tabloid'));
});

test('sync-check takes no arguments', async () => {
  const res = await commands['sync-check'].run(['extra']);
  assert.equal(res.exitCode, EXIT.USAGE);
  assertEnvelope(res, 'cv sync-check');
});

// ── Could not run — exit 3 ──────────────────────────────────────────

test('a missing build payload is exit 3, not exit 1', async () => {
  // build-cv-html.mjs:727 and build-cv-latex.mjs:114 both exit 1 here, which
  // reads identically to a build that ran and produced a broken document.
  for (const verb of ['build-html', 'build-latex']) {
    const res = await commands[verb].run([join(sandbox, 'absent.json'), join(sandbox, 'out', 'x.out')]);
    assert.equal(res.exitCode, EXIT.UNVERIFIED, `${verb} missing input`);
    const env = assertEnvelope(res, `cv ${verb}`);
    assert.equal(env.ok, false);
    assert.equal(env.errors[0].code, 'could-not-verify');
    assert.ok(env.errors[0].message.startsWith('could not verify: '));
    assert.deepEqual(env.data, {}, 'a check that did not run reports no data');
  }
});

test('a missing build template is exit 3', async () => {
  const res = await commands['build-html'].run([
    join(sandbox, 'payload.json'), join(sandbox, 'out', 'x.html'), '--template', join(sandbox, 'absent.html'),
  ]);
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.equal(assertEnvelope(res, 'cv build-html').errors[0].code, 'could-not-verify');
});

test('a missing verify-facts target is exit 3', async () => {
  const res = await commands['verify-facts'].run([join(sandbox, 'absent.md')]);
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.equal(assertEnvelope(res, 'cv verify-facts').ok, false);
});

test('verify-facts with no readable sources is exit 3, never a clean block', async () => {
  // The defect this closes: verify-cv-facts.mjs reads sources with readText,
  // which turns an absent file into ''. With no evidence every metric in the
  // document looks invented, so the gate returns a confident `block` — a
  // finding produced by a check that never ran.
  const empty = mkdtempSync(join(tmpdir(), 'career-ops-cv-nosrc-'));
  try {
    writeFileSync(join(empty, 'doc.md'), 'We reached 999,999 active users.\n');
    const res = await commands['verify-facts'].run(['doc.md'], { cwd: empty });
    assert.equal(res.exitCode, EXIT.UNVERIFIED);
    const env = assertEnvelope(res, 'cv verify-facts');
    assert.ok(env.errors[0].message.includes('no fact sources readable'));
    assert.equal(env.data.verdict, undefined, 'no verdict may be reported for a check that did not run');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('verify-facts with an explicit --config that is not there is exit 3', async () => {
  // loadConfig falls back to an empty gate when the file is absent, so at root
  // a typo'd --config passes everything at exit 0.
  const res = await commands['verify-facts'].run(
    ['invented.md', '--source', 'cv.md', '--config', 'absent.json'], { cwd: sandbox },
  );
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.ok(assertEnvelope(res, 'cv verify-facts').errors[0].message.includes('absent.json'));
});

test('a missing cover-letter payload is exit 3', async () => {
  const res = await commands['cover-letter'].run(['--payload', join(sandbox, 'absent.json')]);
  assert.equal(res.exitCode, EXIT.UNVERIFIED);
  assert.equal(assertEnvelope(res, 'cv cover-letter').errors[0].code, 'could-not-verify');
});

// ── verify-facts — the check itself ─────────────────────────────────

test('a supported document passes at exit 0', async () => {
  const res = await commands['verify-facts'].run(['supported.md', '--source', 'cv.md'], { cwd: sandbox });
  assert.equal(res.exitCode, EXIT.OK);
  const env = assertEnvelope(res, 'cv verify-facts');
  assert.equal(env.data.verdict, 'pass');
  assert.deepEqual(env.data.invented, []);
  assert.deepEqual(env.data.sources, [join(sandbox, 'cv.md')]);
});

test('an invented metric is exit 1 — a check that ran and failed', async () => {
  const res = await commands['verify-facts'].run(['invented.md', '--source', 'cv.md'], { cwd: sandbox });
  assert.equal(res.exitCode, EXIT.FAILED);
  const env = assertEnvelope(res, 'cv verify-facts');
  assert.equal(env.data.verdict, 'block');
  assert.ok(env.data.invented.length > 0);
  assert.equal(env.errors[0].code, 'invented-metric');
});

test('--source is repeatable and a source that is absent is a warning, not a verdict', async () => {
  const res = await commands['verify-facts'].run(
    ['supported.md', '--source', 'cv.md', '--source=absent.md'], { cwd: sandbox },
  );
  assert.equal(res.exitCode, EXIT.OK);
  const env = assertEnvelope(res, 'cv verify-facts');
  assert.equal(env.data.sources.length, 1);
  assert.ok(env.warnings.some((w) => w.includes('absent.md')), 'the skipped source must be reported');
});

// ── The builders — the happy path ───────────────────────────────────

test('build-latex renders a .tex and reports the builder\'s counts', async () => {
  const out = join(sandbox, 'out', 'cv.tex');
  const res = await commands['build-latex'].run([join(sandbox, 'payload.json'), out], { cwd: sandbox });
  assert.equal(res.exitCode, EXIT.OK, res.text);
  const env = assertEnvelope(res, 'cv build-latex');
  assert.equal(env.data.path, out);
  assert.equal(env.data.valid, true);
  assert.equal(env.data.counts.experienceEntries, 1);
});

test('build-html renders an .html and reports the builder\'s counts', async () => {
  const out = join(sandbox, 'out', 'cv.html');
  const res = await commands['build-html'].run([join(sandbox, 'payload.json'), out], { cwd: sandbox });
  assert.equal(res.exitCode, EXIT.OK, res.text);
  const env = assertEnvelope(res, 'cv build-html');
  assert.equal(env.data.path, out);
  assert.equal(env.data.valid, true);
  assert.equal(env.data.counts.experienceEntries, 1);
});

test('a builder that ran and failed is exit 1, distinct from exit 3', async () => {
  const broken = join(sandbox, 'broken.json');
  writeFileSync(broken, '{ not json');
  const res = await commands['build-latex'].run([broken, join(sandbox, 'out', 'broken.tex')], { cwd: sandbox });
  assert.equal(res.exitCode, EXIT.FAILED);
  const env = assertEnvelope(res, 'cv build-latex');
  assert.equal(env.errors[0].code, 'command-failed');
});

// ── sync-check ──────────────────────────────────────────────────────

test('sync-check reports its findings as data, whichever way it lands', async () => {
  // The script checks the real checkout, so the verdict depends on whether the
  // user's cv.md and profile.yml are present. What is asserted is the contract:
  // one of the two codes it speaks, an envelope that agrees with it, and
  // findings carried as data rather than only as prose.
  const res = await commands['sync-check'].run([]);
  assert.ok([EXIT.OK, EXIT.FAILED].includes(res.exitCode), `unexpected exit ${res.exitCode}: ${res.text}`);
  const env = assertEnvelope(res, 'cv sync-check');
  assert.ok(Array.isArray(env.data.errors));
  assert.ok(Array.isArray(env.data.warnings));
  if (res.exitCode === EXIT.FAILED) {
    assert.equal(env.errors.length, Math.max(env.data.errors.length, 1));
  } else {
    assert.deepEqual(env.data.errors, []);
  }
});
