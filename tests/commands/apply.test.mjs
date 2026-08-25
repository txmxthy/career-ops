/**
 * Contract tests for src/commands/apply.js — the `career-ops apply` noun.
 *
 * These are contract tests, not characterisation tests: nothing here pins the
 * behaviour of a root script, because an adapter has none of its own. What they
 * pin is ADR 0006, on every command, from the outside:
 *
 *   1. --help works and is itself available as JSON.
 *   2. --json emits a valid envelope, and the envelope agrees with the exit
 *      code — ok:false with at least one error whenever the code is non-zero,
 *      ok:true with none whenever it is 0.
 *   3. A check that could not RUN exits 3 with ok:false, and is distinguishable
 *      from a check that ran and found nothing (exit 1). Every command with an
 *      input file is exercised on both paths, because collapsing them is the
 *      one failure mode ADR 0006 exists to prevent.
 *
 * Every command runs against an injected sandbox root, so nothing here reads
 * the developer's own tracker or CV.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { noun, commands } from '../../src/commands/apply.js';
import { EXIT } from '../../src/core/flags.js';

const VERBS = Object.keys(commands);

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1 | 2026-08-01 | Acme Corp | Backend Engineer | B+ | Applied | ✅ | [042](../reports/042.md) | — |',
  '',
].join('\n');

// A claim whose number is nowhere in cv.md and whose wording shares little with
// it: derived-unverified, which is the story-provenance failure finding.
const STORY_BANK = [
  '### [Scale] Statewide Rollout',
  '**Situation:** Leadership wanted a large-scale training rollout.',
  '**Task:** Reach as many staff as possible within one quarter.',
  '**Action:** Built self-paced modules and distributed them broadly.',
  '**Result:** 500+ employees completed the rollout within the quarter.',
  '**Best for questions about:** scale, training design',
  '',
].join('\n');

const CV = [
  '# Experience',
  '',
  '## Instructional Designer — Acme University (2022-2025)',
  '- Led a cross-functional team through a full LMS migration with zero data loss.',
  '',
].join('\n');

/** A repo-shaped sandbox. Commands are given it as `root`, so no path in the
 *  test resolves against the developer's own checkout. */
const SANDBOXES = [];
function sandbox(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'apply-cmd-'));
  SANDBOXES.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

/** `env: {}` rather than process.env: a developer with CAREER_OPS_TRACKER
 *  exported must not redirect these commands out of the sandbox. */
const ctxFor = (root) => ({ root, cwd: root, env: {} });

/**
 * Assert the ADR 0006 invariants that hold for every result of every command,
 * then hand the result back for command-specific assertions.
 */
function checkEnvelope(result, expectedCommand) {
  const { envelope: env, exitCode } = result;
  assert.ok(env && typeof env === 'object', 'a result always carries an envelope');
  assert.equal(env.command, expectedCommand);
  assert.equal(typeof env.ok, 'boolean');
  assert.ok(env.data && typeof env.data === 'object', 'data is always an object');
  assert.ok(Array.isArray(env.warnings), 'warnings is always an array');
  assert.ok(Array.isArray(env.errors), 'errors is always an array');
  assert.deepEqual(Object.keys(env).sort(), ['command', 'data', 'errors', 'ok', 'warnings']);

  if (exitCode === EXIT.OK) {
    assert.equal(env.ok, true, 'exit 0 means ok:true');
    assert.equal(env.errors.length, 0, 'a successful result carries no errors');
  } else {
    assert.equal(env.ok, false, `exit ${exitCode} means ok:false`);
    assert.ok(env.errors.length > 0, `exit ${exitCode} must carry at least one error`);
    for (const e of env.errors) {
      assert.equal(typeof e.code, 'string');
      assert.ok(e.message.length > 0, 'an error without a message is the silence being removed');
    }
  }
  // The envelope must survive the round trip an agent puts it through.
  assert.deepEqual(JSON.parse(JSON.stringify(env)), env);
  return result;
}

// ── Shape of the noun ───────────────────────────────────────────────

test('exports the apply noun and a command per verb', () => {
  assert.equal(noun, 'apply');
  assert.ok(VERBS.length > 0);
  for (const verb of VERBS) {
    const cmd = commands[verb];
    assert.equal(typeof cmd.run, 'function', `${verb}.run`);
    assert.equal(typeof cmd.help, 'string', `${verb}.help`);
    assert.ok(cmd.flags && typeof cmd.flags === 'object', `${verb}.flags`);
  }
});

// ── --help, on every command ────────────────────────────────────────

test('--help works on every command', async () => {
  for (const verb of VERBS) {
    const result = await commands[verb].run(['--help'], ctxFor(sandbox()));
    checkEnvelope(result, `apply ${verb}`);
    assert.equal(result.exitCode, EXIT.OK, `apply ${verb} --help exits 0`);
    assert.match(result.text, /Usage: career-ops apply /, `apply ${verb} --help shows usage`);
    assert.match(result.text, /Options:/);
    // The exit-code table is part of --help precisely so a caller reading a
    // non-zero status does not have to guess which of the five it got.
    assert.match(result.text, /could not verify — the check could not run/);
  }
});

test('--help --json describes the command as data, not prose', async () => {
  for (const verb of VERBS) {
    const result = await commands[verb].run(['--help', '--json'], ctxFor(sandbox()));
    checkEnvelope(result, `apply ${verb}`);
    assert.equal(result.exitCode, EXIT.OK);
    const { data } = result.envelope;
    assert.equal(data.command, `apply ${verb}`);
    assert.ok(data.usage.startsWith('career-ops apply '));
    assert.ok(Array.isArray(data.flags));
    // --json and --help are implicit in flags.js; a help listing that omitted
    // them would document a smaller surface than the command answers.
    const names = data.flags.map((f) => f.name);
    assert.ok(names.includes('--json'), `apply ${verb} lists --json`);
    assert.ok(names.includes('--help'), `apply ${verb} lists --help`);
    for (const flag of data.flags) {
      assert.ok(flag.describe.length > 0, `${verb} ${flag.name} is described`);
    }
  }
});

test('every command declares --json and answers it', async () => {
  // Not a spot check: ADR 0006 says "without exception", and the exception is
  // what an agent parsing prose would trip over.
  for (const verb of VERBS) {
    const result = await commands[verb].run(['--json', '--help'], ctxFor(sandbox()));
    assert.equal(result.envelope.command, `apply ${verb}`);
  }
});

// ── Usage errors ────────────────────────────────────────────────────

test('an unknown flag is a usage error on every command', async () => {
  for (const verb of VERBS) {
    const result = await commands[verb].run(['--not-a-real-flag'], ctxFor(sandbox()));
    checkEnvelope(result, `apply ${verb}`);
    assert.equal(result.exitCode, EXIT.USAGE, `apply ${verb} rejects an unknown flag with 2`);
    assert.equal(result.envelope.errors[0].code, 'unknown-flag');
    assert.match(result.text, /Usage: career-ops apply /, 'a usage error prints the usage');
  }
});

test('a required flag left out is a usage error, not a could-not-verify', async () => {
  const root = sandbox();
  for (const [verb, argv] of [
    ['answers', ['--report', 'r.md']],
    ['artifacts', ['--report', '42', '--company', 'Acme']],
  ]) {
    const result = await commands[verb].run(argv, ctxFor(root));
    checkEnvelope(result, `apply ${verb}`);
    assert.equal(result.exitCode, EXIT.USAGE);
    assert.equal(result.envelope.errors[0].code, 'missing-flag');
  }
});

test('a bad flag VALUE is a usage error', async () => {
  const root = sandbox();
  const artifacts = await commands.artifacts.run(
    ['--report', 'not-a-number', '--company', 'Acme', '--role', 'Engineer'], ctxFor(root),
  );
  checkEnvelope(artifacts, 'apply artifacts');
  assert.equal(artifacts.exitCode, EXIT.USAGE);

  const roi = await commands['negotiation-roi'].run(['--frequency', 'fortnightly'], ctxFor(root));
  checkEnvelope(roi, 'apply negotiation-roi');
  assert.equal(roi.exitCode, EXIT.USAGE);
  assert.equal(roi.envelope.errors[0].flag, '--frequency');
});

// ── Exit 3: the check could not run ─────────────────────────────────

test('apply find: no tracker is exit 3, an empty tracker is exit 1', async () => {
  const missing = await commands.find.run(['Acme'], ctxFor(sandbox()));
  checkEnvelope(missing, 'apply find');
  assert.equal(missing.exitCode, EXIT.UNVERIFIED, 'no tracker: the search never happened');
  assert.equal(missing.envelope.ok, false);
  assert.equal(missing.envelope.errors[0].code, 'could-not-verify');
  assert.match(missing.envelope.errors[0].message, /could not verify: /);
  assert.doesNotMatch(missing.text, /No application matches/, 'an unperformed search never says "no match"');

  const present = await commands.find.run(['Nowhere Ltd'], ctxFor(sandbox({ 'data/applications.md': TRACKER })));
  checkEnvelope(present, 'apply find');
  assert.equal(present.exitCode, EXIT.FAILED, 'a tracker with no match: a real negative finding');
  assert.equal(present.envelope.errors[0].code, 'no-match');
  assert.equal(present.envelope.data.count, 0);
  // The whole point of the pair: the two states never share a code.
  assert.notEqual(missing.exitCode, present.exitCode);
});

test('apply find: a match is exit 0 with the row in data', async () => {
  const result = await commands.find.run(['Acme'], ctxFor(sandbox({ 'data/applications.md': TRACKER })));
  checkEnvelope(result, 'apply find');
  assert.equal(result.exitCode, EXIT.OK);
  assert.equal(result.envelope.data.count, 1);
  assert.equal(result.envelope.data.matches[0].company, 'Acme Corp');
  assert.match(result.text, /Acme Corp/);
});

test('apply negotiation-roi: a missing story bank is exit 3', async () => {
  const result = await commands['negotiation-roi'].run([], ctxFor(sandbox({ 'cv.md': CV })));
  checkEnvelope(result, 'apply negotiation-roi');
  assert.equal(result.exitCode, EXIT.UNVERIFIED);
  assert.equal(result.envelope.errors[0].code, 'could-not-verify');
  assert.match(result.envelope.errors[0].message, /story-bank\.md/);
});

test('apply negotiation-roi: a missing cv.md is exit 3, not a clean zero', async () => {
  const result = await commands['negotiation-roi'].run(
    [], ctxFor(sandbox({ 'interview-prep/story-bank.md': STORY_BANK })),
  );
  checkEnvelope(result, 'apply negotiation-roi');
  assert.equal(result.exitCode, EXIT.UNVERIFIED);
  assert.match(result.envelope.errors[0].message, /cv\.md/);
});

test('apply answers: a missing report is exit 3', async () => {
  const root = sandbox({ 'answers.json': '{"freeText":"hello"}' });
  const result = await commands.answers.run(
    ['--report', 'nope.md', '--input', 'answers.json'], ctxFor(root),
  );
  checkEnvelope(result, 'apply answers');
  assert.equal(result.exitCode, EXIT.UNVERIFIED);
});

test('apply answers: an input file that is not JSON is exit 3', async () => {
  const root = sandbox({ 'answers.json': 'not json at all', 'report.md': '# Report 042\n' });
  const result = await commands.answers.run(
    ['--report', 'report.md', '--input', 'answers.json'], ctxFor(root),
  );
  checkEnvelope(result, 'apply answers');
  assert.equal(result.exitCode, EXIT.UNVERIFIED);
  assert.match(result.envelope.errors[0].message, /not valid JSON/);
});

test('apply assessments: an ABSENT log is an empty log; an UNREADABLE one is exit 3', async () => {
  const absent = await commands.assessments.run([], ctxFor(sandbox()));
  checkEnvelope(absent, 'apply assessments');
  assert.equal(absent.exitCode, EXIT.OK, 'nothing logged yet is a real, clean, empty answer');
  assert.equal(absent.envelope.data.quality.total, 0);
  assert.ok(absent.envelope.warnings.some((w) => /not found/.test(w)), 'and it says the log was absent');

  // A directory read as a file throws EISDIR, which store.js does not treat as
  // absent — the command produced no summary and must not report an empty one.
  const root = sandbox({ 'data/assessments.tsv/keep': '' });
  const unreadable = await commands.assessments.run([], ctxFor(root));
  checkEnvelope(unreadable, 'apply assessments');
  assert.equal(unreadable.exitCode, EXIT.UNVERIFIED);
  assert.equal(unreadable.envelope.errors[0].code, 'could-not-verify');
});

test('apply story-provenance: nothing to check is exit 3, an unverified claim is exit 1', async () => {
  const noBank = await commands['story-provenance'].run([], ctxFor(sandbox({ 'cv.md': CV })));
  checkEnvelope(noBank, 'apply story-provenance');
  assert.equal(noBank.exitCode, EXIT.UNVERIFIED, 'no story bank: nothing was checked');
  assert.equal(noBank.envelope.data.lowConfidence.reason, 'no-story-bank');

  const noCv = await commands['story-provenance'].run(
    [], ctxFor(sandbox({ 'interview-prep/story-bank.md': STORY_BANK })),
  );
  checkEnvelope(noCv, 'apply story-provenance');
  assert.equal(noCv.exitCode, EXIT.UNVERIFIED);
  assert.equal(noCv.envelope.data.lowConfidence.reason, 'no-cv');

  const both = await commands['story-provenance'].run([], ctxFor(sandbox({
    'cv.md': CV,
    'interview-prep/story-bank.md': STORY_BANK,
  })));
  checkEnvelope(both, 'apply story-provenance');
  assert.equal(both.exitCode, EXIT.FAILED, 'a claim traceable to no primary source is a finding, not a silence');
  assert.equal(both.envelope.errors[0].code, 'derived-unverified');
  assert.ok(both.envelope.data.counts.derivedUnverified > 0);
});

// ── Successful runs ─────────────────────────────────────────────────

test('apply artifacts: paths are anchored to the injected root, not the cwd', async () => {
  const root = sandbox();
  const result = await commands.artifacts.run(
    ['--report', '42', '--company', 'Acme Corp', '--role', 'Backend Engineer', '--init'], ctxFor(root),
  );
  checkEnvelope(result, 'apply artifacts');
  assert.equal(result.exitCode, EXIT.OK);
  assert.equal(result.envelope.data.key, '042-acme-corp-backend-engineer');
  assert.ok(result.envelope.data.root.startsWith(join(root, 'output')), 'not resolve("output") from the cwd');
  assert.equal(result.envelope.data.initialised, true);
});

test('apply answers: the report is updated and the change reported', async () => {
  const root = sandbox({
    'answers.json': JSON.stringify({ freeText: 'Why us? Because.', state: 'submitted', date: '2026-08-24' }),
    'report.md': '# Report 042\n\nSome prose.\n',
  });
  const result = await commands.answers.run(
    ['--report', 'report.md', '--input', 'answers.json'], ctxFor(root),
  );
  checkEnvelope(result, 'apply answers');
  assert.equal(result.exitCode, EXIT.OK);
  assert.equal(result.envelope.data.state, 'submitted');
  assert.equal(result.envelope.data.changed, true);
});

test('apply assessments: a real log is summarised at exit 0', async () => {
  const root = sandbox({
    'data/assessments.tsv': [
      '2026-07-01\tAcme\t042\teSkill\tMS Office\t70\t92\treferences Acrobat 9',
      '2026-07-02\tGlobex\t-\tHackerRank\tJavaScript\t-\t85\t',
      '2026-07-03\tOnly',
      '',
    ].join('\n'),
  });
  const result = await commands.assessments.run([], ctxFor(root));
  checkEnvelope(result, 'apply assessments');
  assert.equal(result.exitCode, EXIT.OK);
  assert.equal(result.envelope.data.quality.total, 2);
  // A malformed line is dropped by the parser, so it is reported as a warning
  // rather than disappearing into a smaller count.
  assert.ok(result.envelope.warnings.some((w) => /malformed line/.test(w)));
});

test('apply negotiation-roi: a corroborated bank analyses at exit 0', async () => {
  const root = sandbox({
    'cv.md': CV,
    'interview-prep/story-bank.md': STORY_BANK,
  });
  const result = await commands['negotiation-roi'].run([], ctxFor(root));
  checkEnvelope(result, 'apply negotiation-roi');
  assert.equal(result.exitCode, EXIT.OK);
  assert.equal(typeof result.envelope.data.claimsFound, 'number');
  assert.ok(Array.isArray(result.envelope.data.calculable));
});

// ── The invariant, swept across everything above ────────────────────

test('no command ever reports an empty result for a check that did not run', async () => {
  // An empty sandbox: every command that needs an input file is missing it.
  const root = sandbox();
  const argv = {
    answers: ['--report', 'missing.md', '--input', 'missing.json'],
    artifacts: ['--report', '42', '--company', 'Acme', '--role', 'Engineer'],
    assessments: [],
    find: ['Acme'],
    'negotiation-roi': [],
    'story-provenance': [],
  };
  for (const verb of VERBS) {
    const result = await commands[verb].run(argv[verb], ctxFor(root));
    checkEnvelope(result, `apply ${verb}`);
    assert.ok([EXIT.OK, EXIT.FAILED, EXIT.UNVERIFIED].includes(result.exitCode),
      `apply ${verb} returned an undocumented exit code ${result.exitCode}`);
    if (result.exitCode === EXIT.OK) {
      // The only two that can legitimately succeed with nothing on disk:
      // artifacts computes paths, assessments reports an empty log and says so.
      assert.ok(['artifacts', 'assessments'].includes(verb), `apply ${verb} succeeded with no inputs`);
    }
  }
});

test('a command never throws — a failure is always an envelope', async () => {
  // A path that cannot be read at all, handed to everything that takes one.
  const root = sandbox({ 'cv.md/keep': '' });
  for (const [verb, argv] of [
    ['negotiation-roi', ['--cv', 'cv.md']],
    ['story-provenance', ['--cv', 'cv.md']],
    ['answers', ['--report', 'cv.md', '--input', 'cv.md']],
  ]) {
    const result = await commands[verb].run(argv, ctxFor(root));
    checkEnvelope(result, `apply ${verb}`);
    assert.equal(result.exitCode, EXIT.UNVERIFIED, `apply ${verb} turns an unreadable input into exit 3`);
  }
});

test.after(() => {
  for (const dir of SANDBOXES) rmSync(dir, { recursive: true, force: true });
});
