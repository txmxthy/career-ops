/**
 * Contract tests for src/commands/followup.js — the `career-ops followup <verb>`
 * adapters.
 *
 * Three things are pinned for every verb, because they are the three ADR 0006
 * requires of every command and the three a facade will assume:
 *
 *   1. `--help` renders and exits 0.
 *   2. `--json` produces a valid envelope — `{ok, command, data, warnings,
 *      errors}` with the ok/errors invariant intact.
 *   3. A check that could not RUN exits 3 with `ok: false` and a
 *      `could-not-verify` error. Never exit 0 with empty data, never exit 1:
 *      an empty result and an unperformed check are different states.
 *
 * The verbs are driven in-process rather than spawned. `run` returns
 * `{exitCode, json, text}` and neither prints nor exits, which is what lets a
 * refusal branch be asserted directly instead of scraped out of stdout.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { noun, commands } from '../../src/commands/followup.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const VERBS = ['cadence', 'seed', 'contacts', 'match-invite', 'add-reply', 'match-replies', 'review-replies'];

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1 | 2026-01-05 | Acme | Engineer | 8 | Applied | ❌ | — | applied 2026-01-05 hr@acme.com |',
  '',
].join('\n');

/** A throwaway workspace: `<dir>/data/` with whatever files a test seeds. */
function sandbox(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'co-followup-'));
  mkdirSync(join(dir, 'data'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, 'data', name), content);
  }
  return {
    dir,
    path: (name) => join(dir, 'data', name),
    /** A ctx whose env points every path resolver at this sandbox. */
    ctx: (extra = {}) => ({
      env: {
        ...process.env,
        CAREER_OPS_TRACKER: join(dir, 'data', 'applications.md'),
        CAREER_OPS_FOLLOWUPS: join(dir, 'data', 'follow-ups.md'),
      },
      stdin: { isTTY: true },
      ...extra,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Run a verb inside a sandbox, cleaning up afterwards. */
async function run(verb, argv, files = {}, extraCtx = {}) {
  const box = sandbox(files);
  try {
    return await commands[verb].run(argv, box.ctx(extraCtx));
  } finally {
    box.cleanup();
  }
}

/** stdin ctx backed by a real file descriptor, so a piped read can be driven. */
function withStdinFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'co-stdin-'));
  const file = join(dir, 'stdin.txt');
  writeFileSync(file, content);
  const fd = openSync(file, 'r');
  try {
    return fn({ isTTY: false, fd });
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The ADR 0006 envelope invariants, asserted structurally. */
function assertEnvelope(json, command) {
  assert.equal(typeof json, 'object', 'envelope must be an object');
  assert.deepEqual(
    Object.keys(json).sort(),
    ['command', 'data', 'errors', 'ok', 'warnings'],
    'envelope carries exactly ok, command, data, warnings, errors',
  );
  assert.equal(json.command, command);
  assert.equal(typeof json.ok, 'boolean');
  assert.equal(typeof json.data, 'object');
  assert.ok(Array.isArray(json.warnings));
  assert.ok(Array.isArray(json.errors));
  // The invariant the envelope exists to enforce: a failure always says why.
  if (json.ok === false) assert.ok(json.errors.length > 0, 'a failed envelope must carry an error');
  else assert.equal(json.errors.length, 0, 'a successful envelope must carry no errors');
  for (const e of json.errors) {
    assert.equal(typeof e.code, 'string');
    assert.equal(typeof e.message, 'string');
  }
}

/** A could-not-run result: exit 3, ok false, and the one named failure mode. */
function assertCouldNotVerify(res, command) {
  assert.equal(res.exitCode, 3, `${command} must exit 3 when the check could not run`);
  assertEnvelope(res.json, command);
  assert.equal(res.json.ok, false);
  assert.ok(
    res.json.errors.some((e) => e.code === 'could-not-verify'),
    'the failure must be reported as could-not-verify, not as an empty result',
  );
  assert.match(res.json.errors[0].message, /^could not verify: /);
  assert.deepEqual(res.json.data, res.json.data, 'data may carry partial context');
}

// ── the export shape the facade assembles from ──────────────────────

test('exports the followup noun and one command per ADR 0003 row', () => {
  assert.equal(noun, 'followup');
  assert.deepEqual(Object.keys(commands).sort(), [...VERBS].sort());
  for (const verb of VERBS) {
    const c = commands[verb];
    assert.equal(typeof c.run, 'function', `${verb}.run`);
    assert.equal(typeof c.help, 'string', `${verb}.help`);
    assert.equal(typeof c.flags, 'object', `${verb}.flags`);
  }
});

// ── --help, on every verb ───────────────────────────────────────────

for (const verb of VERBS) {
  test(`${verb} --help renders, exits 0, and documents the exit codes`, async () => {
    const res = await run(verb, ['--help']);
    assert.equal(res.exitCode, 0);
    assertEnvelope(res.json, `followup ${verb}`);
    assert.equal(res.json.ok, true);
    assert.match(res.text, /^Usage: career-ops followup /m);
    assert.match(res.text, /Exit codes:/);
    assert.match(res.text, /3 {2}could not verify/);
    assert.equal(res.json.data.help, res.text);
    assert.equal(commands[verb].help, res.text);
  });

  test(`${verb} rejects an unknown flag with exit 2, before --help`, async () => {
    const res = await run(verb, ['--help', '--not-a-flag']);
    assert.equal(res.exitCode, 2, 'a usage error is 2, never 1');
    assertEnvelope(res.json, `followup ${verb}`);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.errors[0].code, 'unknown-flag');
  });
}

// ── could-not-run, one per verb ─────────────────────────────────────

test('cadence with no tracker could not verify', async () => {
  const res = await run('cadence', ['--json']);
  assertCouldNotVerify(res, 'followup cadence');
  assert.match(res.json.errors[0].message, /no tracker at /);
});

test('cadence with a tracker holding no applications could not verify', async () => {
  // The tracker is present but unparseable/empty. That is a check with nothing
  // to run against, not a finding of zero overdue follow-ups.
  const res = await run('cadence', ['--json'], { 'applications.md': '# Applications Tracker\n' });
  assertCouldNotVerify(res, 'followup cadence');
});

test('seed against a missing tracker could not verify', async () => {
  const box = sandbox();
  const saved = { ...process.env };
  try {
    process.env.CAREER_OPS_TRACKER = box.path('applications.md');
    process.env.CAREER_OPS_FOLLOWUPS = box.path('follow-ups.md');
    const res = await commands.seed.run(['1', '--json'], box.ctx());
    assertCouldNotVerify(res, 'followup seed');
    assert.match(res.json.errors[0].message, /Tracker not found/);
  } finally {
    process.env = saved;
    box.cleanup();
  }
});

test('contacts with no contacts file could not verify', async () => {
  const res = await run('contacts', ['--json']);
  assertCouldNotVerify(res, 'followup contacts');
  assert.match(res.json.errors[0].message, /no contacts file at /);
});

test('match-invite with a missing --file could not verify', async () => {
  const res = await run('match-invite', ['--file', '/nope/does-not-exist.txt', '--json']);
  assertCouldNotVerify(res, 'followup match-invite');
  assert.match(res.json.errors[0].message, /no such file/);
});

test('match-invite on empty text could not verify', async () => {
  const res = await withStdinFile('   \n', (stdin) => run('match-invite', ['--json'], {}, { stdin }));
  assertCouldNotVerify(res, 'followup match-invite');
  assert.match(res.json.errors[0].message, /nothing to classify/);
});

test('add-reply with a missing --file could not verify', async () => {
  const res = await run('add-reply', ['--file', '/nope/does-not-exist.txt', '--json']);
  assertCouldNotVerify(res, 'followup add-reply');
});

test('add-reply on input with neither subject nor body could not verify', async () => {
  const res = await withStdinFile('\n \n', (stdin) => run('add-reply', ['--json'], {}, { stdin }));
  assertCouldNotVerify(res, 'followup add-reply');
  assert.match(res.json.errors[0].message, /nothing to add/);
});

test('match-replies with no candidates store could not verify', async () => {
  const res = await run('match-replies', ['--json'], { 'applications.md': TRACKER });
  assertCouldNotVerify(res, 'followup match-replies');
  assert.match(res.json.errors[0].message, /no reply candidates at /);
});

test('match-replies with no tracker could not verify', async () => {
  const res = await run('match-replies', ['--json'], { 'reply-candidates.json': '[]' });
  assertCouldNotVerify(res, 'followup match-replies');
  assert.match(res.json.errors[0].message, /no tracker at /);
});

test('review-replies on an unparseable candidates store could not verify', async () => {
  const res = await run('review-replies', ['--json'], {
    'applications.md': TRACKER,
    'reply-candidates.json': '{ not json',
  });
  assertCouldNotVerify(res, 'followup review-replies');
  assert.match(res.json.errors[0].message, /not valid JSON/);
});

test('review-replies on a candidates store that is not an array could not verify', async () => {
  const res = await run('review-replies', ['--json'], {
    'applications.md': TRACKER,
    'reply-candidates.json': '{"message_id":"m1"}',
  });
  assertCouldNotVerify(res, 'followup review-replies');
});

// ── usage errors are 2, and never 1 or 3 ────────────────────────────

test('seed without an appNum is a usage error', async () => {
  const res = await run('seed', ['--json']);
  assert.equal(res.exitCode, 2);
  assert.equal(res.json.ok, false);
  assert.match(res.json.errors[0].message, /expected one <appNum>/);
});

test('seed rejects a non-numeric appNum rather than truncating it', async () => {
  const res = await run('seed', ['1.5', '--json']);
  assert.equal(res.exitCode, 2);
  assert.match(res.json.errors[0].message, /invalid appNum: 1\.5/);
});

test('seed rejects --date combined with --backfill', async () => {
  const res = await run('seed', ['--backfill', '--date', '2026-01-05', '--json']);
  assert.equal(res.exitCode, 2);
  assert.match(res.json.errors[0].message, /--date cannot be combined with --backfill/);
});

test('cadence rejects a fractional --applied-days rather than truncating it', async () => {
  const res = await run('cadence', ['--applied-days', '1.5', '--json'], { 'applications.md': TRACKER });
  assert.equal(res.exitCode, 2);
  assert.match(res.json.errors[0].message, /non-negative whole number/);
});

test('cadence rejects --applied-days with no operand', async () => {
  const res = await run('cadence', ['--applied-days', '--overdue-only'], { 'applications.md': TRACKER });
  assert.equal(res.exitCode, 2);
  assert.equal(res.json.errors[0].code, 'missing-value');
});

test('add-reply with a TTY stdin and no --file is a usage error, not a hang', async () => {
  const res = await run('add-reply', ['--json'], {}, { stdin: { isTTY: true } });
  assert.equal(res.exitCode, 2);
  assert.match(res.json.errors[0].message, /pass --file <path> or pipe/);
});

// ── the ok paths, and the envelopes they emit ───────────────────────

test('cadence --json emits {entries, metadata, cadenceConfig} in a valid envelope', async () => {
  const res = await run('cadence', ['--json'], { 'applications.md': TRACKER });
  assert.equal(res.exitCode, 0);
  assertEnvelope(res.json, 'followup cadence');
  assert.equal(res.json.ok, true);
  for (const key of ['entries', 'metadata', 'cadenceConfig', 'cadenceDefaults']) {
    assert.ok(key in res.json.data, `data.${key}`);
  }
  assert.equal(res.json.data.metadata.totalTracked, 1);
  assert.equal(res.json.data.entries[0].company, 'Acme');
});

test('cadence --applied-days reaches the cadence config it overrides', async () => {
  // followup-cadence.mjs builds its config once per module instance from argv;
  // this is what proves the adapter's shielded import actually rebuilt it.
  const res = await run('cadence', ['--applied-days', '3', '--json'], { 'applications.md': TRACKER });
  assert.equal(res.exitCode, 0);
  assert.equal(res.json.data.cadenceConfig.applied_first, 3);
});

test('contacts --json reports parsed contacts and row quality as warnings', async () => {
  const contacts = [
    'Jane Doe\tAcme\trecruiter\tTalent Partner\t\tjane@acme.com\t\t1\tmet at a meetup',
    'Bad Row\tBeta\trecruter\t—',
    '\tGamma\tpeer\tEngineer',
  ].join('\n');
  const res = await run('contacts', ['--json'], { 'contacts.tsv': contacts });
  assert.equal(res.exitCode, 0);
  assertEnvelope(res.json, 'followup contacts');
  assert.equal(res.json.data.total, 2);
  assert.equal(res.json.data.contacts[0].name, 'Jane Doe');
  // An off-enum type is a warning, not a failure — the contact still exports.
  assert.ok(res.json.warnings.some((w) => /off-enum type/.test(w)));
  assert.ok(res.json.warnings.some((w) => /missing name or company/.test(w)));
});

test('contacts on an empty-but-present store is an empty result, not an unverified one', async () => {
  const res = await run('contacts', ['--json'], { 'contacts.tsv': '' });
  assert.equal(res.exitCode, 0, 'a store that exists and holds nothing is a real, empty finding');
  assert.equal(res.json.ok, true);
  assert.equal(res.json.data.total, 0);
});

test('add-reply appends one candidate and reports the new total', async () => {
  const box = sandbox();
  try {
    const email = 'Subject: Update on your application\nFrom: hr@acme.com\n\nWe are moving forward.';
    const res = await withStdinFile(email, (stdin) => commands['add-reply'].run(['--json'], box.ctx({ stdin })));
    assert.equal(res.exitCode, 0);
    assertEnvelope(res.json, 'followup add-reply');
    assert.equal(res.json.data.total, 1);
    assert.equal(res.json.data.candidate.subject, 'Update on your application');
    assert.equal(res.json.data.candidate.from, 'hr@acme.com');
    assert.equal(res.json.data.path, box.path('reply-candidates.json'));

    // A second append must not disturb the first.
    const again = await withStdinFile(email, (stdin) => commands['add-reply'].run(['--json'], box.ctx({ stdin })));
    assert.equal(again.json.data.total, 2);
  } finally {
    box.cleanup();
  }
});

test('match-replies attributes a reply to its application', async () => {
  const candidates = JSON.stringify([
    { message_id: 'm1', from: 'hr@acme.com', subject: 'Acme — Engineer', body_snippet: 'Thanks for applying.' },
  ]);
  const res = await run('match-replies', ['--json'], {
    'applications.md': TRACKER,
    'reply-candidates.json': candidates,
  });
  assert.equal(res.exitCode, 0);
  assertEnvelope(res.json, 'followup match-replies');
  assert.equal(res.json.data.counts.candidates, 1);
  assert.equal(res.json.data.matches.length, 1);
  assert.equal(res.json.data.matches[0].application_num, 1);
});

test('match-replies on an empty candidates array is an empty result at exit 0', async () => {
  const res = await run('match-replies', ['--json'], {
    'applications.md': TRACKER,
    'reply-candidates.json': '[]',
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.data.counts, { candidates: 0, matched: 0, unmatched: 0 });
});

test('review-replies classifies a reply and proposes the status it implies', async () => {
  const candidates = JSON.stringify([
    {
      message_id: 'm1',
      from: 'hr@acme.com',
      subject: 'Acme — Engineer interview',
      body_snippet: 'We would like to invite you to an interview next week.',
    },
  ]);
  const res = await run('review-replies', ['--json'], {
    'applications.md': TRACKER,
    'reply-candidates.json': candidates,
  });
  assert.equal(res.exitCode, 0);
  assertEnvelope(res.json, 'followup review-replies');
  assert.equal(res.json.data.reviewed.length, 1);
  assert.equal(res.json.data.reviewed[0].applicationNum, 1);
  assert.equal(typeof res.json.data.reviewed[0].type, 'string');
  // Every proposal names both ends of the transition, so a consumer can apply
  // it without re-reading the tracker to find out what it is replacing.
  for (const p of res.json.data.proposals) {
    assert.equal(p.num, 1);
    assert.equal(typeof p.oldStatus, 'string');
    assert.equal(typeof p.newStatus, 'string');
    assert.notEqual(p.oldStatus, p.newStatus);
  }
});

test('review-replies documents that it cannot apply the transitions it proposes', () => {
  // reply-watch.mjs keeps groupStatusRecommendations/updateTrackerStatuses
  // private, so the adapter has nothing to call. --help has to say so rather
  // than let a caller assume --apply exists.
  assert.match(commands['review-replies'].help, /Read-only/);
  assert.ok(!('--apply' in commands['review-replies'].flags));
});

test('contacts documents that vCard export is not exposed yet', () => {
  assert.match(commands.contacts.help, /vCard export is not here yet/);
  assert.ok(!('--vcf' in commands.contacts.flags));
});

// ── the adapter must not leak the argv it lends to legacy modules ───

test('running a verb leaves process.argv untouched', async () => {
  const before = [...process.argv];
  await run('cadence', ['--json'], { 'applications.md': TRACKER });
  await run('contacts', ['--json'], { 'contacts.tsv': 'Jane\tAcme\trecruiter\t—' });
  assert.deepEqual(process.argv, before);
});

// ── seed, end to end under its lock ─────────────────────────────────

test('seed --dry-run reports the pin it would write without writing it', async () => {
  const box = sandbox({ 'applications.md': TRACKER });
  const saved = { ...process.env };
  try {
    process.env.CAREER_OPS_TRACKER = box.path('applications.md');
    process.env.CAREER_OPS_FOLLOWUPS = box.path('follow-ups.md');
    process.env.CAREER_OPS_FOLLOWUPS_LOCK = join(box.dir, 'followups.lock');
    process.env.CAREER_OPS_PROFILE = join(ROOT, 'tests', 'fixtures', 'profile-default-cadence.yml');
    const res = await commands.seed.run(['1', '--dry-run', '--json'], box.ctx());
    assert.equal(res.exitCode, 0);
    assertEnvelope(res.json, 'followup seed');
    assert.equal(res.json.data.seeded, true);
    assert.equal(res.json.data.dryRun, true);
    assert.equal(res.json.data.appNum, 1);
  } finally {
    process.env = saved;
    box.cleanup();
  }
});

test('seed on a row that is not in the tracker could not verify', async () => {
  const box = sandbox({ 'applications.md': TRACKER });
  const saved = { ...process.env };
  try {
    process.env.CAREER_OPS_TRACKER = box.path('applications.md');
    process.env.CAREER_OPS_FOLLOWUPS = box.path('follow-ups.md');
    process.env.CAREER_OPS_FOLLOWUPS_LOCK = join(box.dir, 'followups.lock');
    const res = await commands.seed.run(['99', '--json'], box.ctx());
    assertCouldNotVerify(res, 'followup seed');
    assert.match(res.json.errors[0].message, /#99 not found/);
  } finally {
    process.env = saved;
    box.cleanup();
  }
});

// ── match-invite: classification, and the 1-vs-3 distinction ────────

test('match-invite classifies a rejection into a valid envelope', async () => {
  const email = 'Subject: Your application to Acme\n\nUnfortunately we have decided not to move forward with your application.';
  const res = await withStdinFile(email, (stdin) => run('match-invite', ['--json'], { 'applications.md': TRACKER }, { stdin }));
  assert.equal(res.exitCode, 0);
  assertEnvelope(res.json, 'followup match-invite');
  assert.equal(res.json.data.classification, 'rejection');
  assert.ok(Array.isArray(res.json.data.candidates));
});

test('match-invite --apply on a non-rejection exits 1, not 3', async () => {
  // The check RAN and produced a real negative finding: this text is not a
  // rejection, so the Rejected transition does not apply. ADR 0006 keeps that
  // apart from a check that never got to run.
  const email = 'Subject: Interview invitation\n\nWe would like to invite you to an interview next week.';
  const res = await withStdinFile(email, (stdin) => run('match-invite', ['--apply', '--json'], { 'applications.md': TRACKER }, { stdin }));
  assert.equal(res.exitCode, 1);
  assertEnvelope(res.json, 'followup match-invite');
  assert.equal(res.json.ok, false);
  assert.equal(res.json.errors[0].code, 'not-a-rejection');
  // The classification is still reported: a refusal is not an empty result.
  assert.equal(typeof res.json.data.classification, 'string');
});

test('match-invite rejects a non-numeric --id with exit 2', async () => {
  const res = await run('match-invite', ['--apply', '--id', 'abc', '--json']);
  assert.equal(res.exitCode, 2);
  assert.equal(res.json.errors[0].code, 'invalid-value');
});
