/**
 * tests/commands/insight.test.mjs — the `career-ops insight` command adapters.
 *
 * Contract tests for ADR 0006, not behaviour tests for the fifteen scripts
 * behind them. What is pinned here is the part src/commands/insight.js owns:
 * the flag surface, the envelope, the exit codes, and above all the rule those
 * exist for — a check that could not RUN is exit 3 with `ok: false` and a
 * stated reason, never a clean empty result at exit 0.
 *
 * Three fixture strategies, chosen per case rather than uniformly:
 *
 *   - An EMPTY root, for the could-not-run sweep. Every command has to say why
 *     it cannot answer, and none may report an empty success.
 *   - The REAL checkout plus temp files reached through explicit path flags
 *     (`--file`, `--dir`, `--cv`, positionals) or the `CAREER_OPS_*` env, for
 *     the eleven commands that import their logic. The real root is needed
 *     because that is where the scripts under adaptation still live; the temp
 *     files are what keep the case off this machine's real tracker.
 *   - STUB scripts in a sandbox root, for the four the adapter spawns. What is
 *     under test there is the translation of a child's exit code and stdout,
 *     and a stub is the only way to drive `{"error": …}` at exit 1
 *     deterministically.
 *
 * `insight funded` is never driven to a successful run: it fetches live RSS,
 * so every case for it terminates at a usage error or --help. That is a gap in
 * coverage and it is stated rather than papered over.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { noun, commands } from '../../src/commands/insight.js';
import { EXIT } from '../../src/core/flags.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const boxes = [];
function box(name) {
  const dir = mkdtempSync(join(tmpdir(), `career-ops-insight-${name}-`));
  boxes.push(dir);
  return dir;
}
process.on('exit', () => { for (const d of boxes) rmSync(d, { recursive: true, force: true }); });

/** A context whose data paths are pinned, so an ambient CAREER_OPS_* on the
 *  developer's machine cannot reach any case here. */
const ctx = (rootDir, env = {}) => ({
  rootDir,
  env: {
    ...process.env,
    CAREER_OPS_TRACKER: join(rootDir, 'data', 'applications.md'),
    CAREER_OPS_SCAN_HISTORY: join(rootDir, 'data', 'scan-history.tsv'),
    CAREER_OPS_PORTALS: join(rootDir, 'portals.yml'),
    ...env,
  },
});

// ── The envelope contract ───────────────────────────────────────────

/**
 * Every invariant ADR 0006 states about a result, asserted on every result.
 *
 * The load-bearing one is the last: `ok` and the exit code cannot disagree.
 * An `ok: true` at exit 3, or an `ok: false` at exit 0, is precisely how an
 * unperformed check gets read as a performed one.
 */
function assertEnvelope(result, verb) {
  const e = result.envelope;
  assert.deepEqual(Object.keys(e).sort(), ['command', 'data', 'errors', 'ok', 'warnings'],
    `${verb}: envelope has exactly the five ADR 0006 keys`);
  assert.equal(e.command, `insight ${verb}`, `${verb}: envelope names the command`);
  assert.equal(typeof e.ok, 'boolean');
  assert.ok(Array.isArray(e.warnings) && Array.isArray(e.errors));
  assert.equal(typeof result.text, 'string', `${verb}: text is always renderable`);
  assert.equal(typeof result.json, 'boolean', `${verb}: the facade is told which to print`);
  assert.equal(e.ok, result.exitCode === EXIT.OK,
    `${verb}: ok:${e.ok} contradicts exit ${result.exitCode}`);
  assert.equal(e.errors.length > 0, !e.ok, `${verb}: a failure carries a reason, a success carries none`);
  // The envelope must survive the round trip the facade puts it through.
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e, `${verb}: envelope is JSON-serialisable`);
}

const verbs = Object.keys(commands);

test('exports the noun, fifteen commands, and { run, help, flags } on each', () => {
  assert.equal(noun, 'insight');
  assert.equal(verbs.length, 15);
  for (const [verb, cmd] of Object.entries(commands)) {
    assert.equal(typeof cmd.run, 'function', `${verb} has run`);
    assert.equal(typeof cmd.help, 'string', `${verb} has help`);
    assert.equal(typeof cmd.flags, 'object', `${verb} has flags`);
  }
});

/**
 * ADR 0003 assigns fifteen rows to `insight`. Four verbs were renamed under the
 * ADR's own instruction that the classifier is a starting point — recorded here
 * so the mapping is traceable from either name, and so a fifth silent rename
 * fails this test.
 */
test('every ADR 0003 insight row has a command, renames recorded', () => {
  const taxonomy = {
    'src/scripts/analyze-patterns.mjs': 'patterns',        // renamed: the noun already says "analysis"
    'src/scripts/classify-tier.mjs': 'tier',               // renamed: reads as a question, not an order
    'src/scripts/company-funded.mjs': 'funded',
    'src/scripts/company-history.mjs': 'history',
    'src/scripts/detect-reposts.mjs': 'reposts',           // renamed: "detect-" earns nothing
    'src/scripts/funnel-velocity.mjs': 'funnel-velocity',
    'src/scripts/jd-capture.mjs': 'jd-lookup',             // renamed: it finds a capture, it does not make one
    'src/scripts/jd-similarity.mjs': 'jd-similarity',
    'src/scripts/jd-skill-gap.mjs': 'jd-skill-gap',
    'src/scripts/process-quality.mjs': 'process-quality',
    'src/scripts/rejection-latency.mjs': 'rejection-latency',
    'src/scripts/salary-gap.mjs': 'salary-gap',
    'src/scripts/stats.mjs': 'stats',
    'src/scripts/upskill.mjs': 'upskill',
    'src/scripts/weekly-digest.mjs': 'weekly-digest',
  };
  assert.equal(Object.keys(taxonomy).length, 15);
  assert.deepEqual([...new Set(Object.values(taxonomy))].sort(), verbs.slice().sort());
});

// ── --help, on every command ────────────────────────────────────────

test('--help works on all fifteen, and works with no data present', async () => {
  const empty = box('help');
  for (const verb of verbs) {
    const r = await commands[verb].run(['--help'], ctx(empty));
    assert.equal(r.exitCode, EXIT.OK, `${verb} --help exits 0`);
    assertEnvelope(r, verb);
    assert.equal(r.text, commands[verb].help, `${verb} --help prints the exported help`);
    assert.match(r.text, /^Usage: career-ops insight /m, `${verb} --help states its usage`);
    assert.match(r.text, /--json/, `${verb} --help documents --json`);
    assert.match(r.text, /Exit codes:/, `${verb} --help documents its exit codes`);
    assert.match(r.text, /could not verify — the check could not run/,
      `${verb} --help names exit 3, so a caller can interpret it`);
  }
});

test('a flag error beats --help, so a typo is never answered with a clean exit 0', async () => {
  const empty = box('helporder');
  for (const verb of verbs) {
    const r = await commands[verb].run(['--help', '--not-a-flag'], ctx(empty));
    assert.equal(r.exitCode, EXIT.USAGE, `${verb} reports the typo rather than printing help`);
    assert.equal(r.envelope.errors[0].code, 'unknown-flag');
    assertEnvelope(r, verb);
  }
});

// ── --json, on every command ────────────────────────────────────────

test('--json is accepted by all fifteen and sets the flag the facade reads', async () => {
  const empty = box('json');
  for (const verb of verbs) {
    const r = await commands[verb].run(['--help', '--json'], ctx(empty));
    assert.equal(r.json, true, `${verb} passes --json through`);
    assertEnvelope(r, verb);
  }
});

/**
 * The requirement this whole file exists for. In a root with no data and no
 * scripts, not one of the fifteen may answer with an empty success.
 *
 * `funded` is the exception and is driven to a usage error instead: a real run
 * fetches live RSS feeds, which has no place in a test.
 */
test('with nothing to read, every command reports could-not-verify at exit 3', async () => {
  const empty = box('empty');
  const cases = {
    patterns: [],
    tier: ['Staff Engineer'],
    history: [],
    reposts: [],
    'funnel-velocity': [],
    'jd-lookup': ['--report', '1'],
    'jd-similarity': [join(empty, 'a.txt'), join(empty, 'b.txt')],
    'jd-skill-gap': [join(empty, 'a.txt')],
    'process-quality': [],
    'rejection-latency': [],
    'salary-gap': [],
    stats: [],
    upskill: [],
    'weekly-digest': [],
  };
  assert.deepEqual(Object.keys(cases).sort(), verbs.filter((v) => v !== 'funded').sort(),
    'every command except funded is covered by the sweep');

  for (const [verb, argv] of Object.entries(cases)) {
    const r = await commands[verb].run([...argv, '--json'], ctx(empty));
    assertEnvelope(r, verb);
    assert.equal(r.json, true, `${verb} honours --json on a failure too`);
    assert.equal(r.exitCode, EXIT.UNVERIFIED, `${verb} could not run, so it must exit 3`);
    assert.equal(r.envelope.ok, false, `${verb} must not report ok:true for work it did not do`);
    assert.equal(r.envelope.errors[0].code, 'could-not-verify');
    assert.match(r.envelope.errors[0].message, /^could not verify: \S/,
      `${verb} states a reason — a reasonless "could not verify" is the same silence`);
    assert.equal(r.envelope.data.error, undefined, `${verb} does not smuggle the failure into data`);
  }
});

test('funded rejects an out-of-range flag rather than substituting a default', async () => {
  // src/scripts/company-funded.mjs reads `opts.limit || DEFAULT_LIMIT`, so `--limit 0`
  // would come back as a 25-company report nobody asked for, at exit 0.
  const r = await commands.funded.run(['--limit', '0'], ctx(box('funded')));
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.match(r.envelope.errors[0].message, /--limit expects an integer from 1 to 100/);
  assertEnvelope(r, 'funded');

  for (const argv of [['--limit', '101'], ['--months', '0'], ['--sort', 'sideways']]) {
    const bad = await commands.funded.run(argv, ctx(box('funded')));
    assert.equal(bad.exitCode, EXIT.USAGE, `${argv.join(' ')} is a usage error`);
    assertEnvelope(bad, 'funded');
  }
});

// ── The imported commands, against real inputs ──────────────────────

test('tier answers a title and never touches the filesystem', async () => {
  const r = await commands.tier.run(['Staff Engineer', '--json'], ctx(ROOT));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r, 'tier');
  assert.equal(r.json, true);
  assert.deepEqual(r.envelope, {
    ok: true, command: 'insight tier', data: { title: 'Staff Engineer', tier: 'senior' }, warnings: [], errors: [],
  }, 'a successful --json result is the ADR 0006 envelope, verbatim');

  // Without --json the facade prints `text`; the data is the same either way.
  const prose = await commands.tier.run(['Staff Engineer'], ctx(ROOT));
  assert.equal(prose.json, false);
  assert.deepEqual(JSON.parse(prose.text), prose.envelope.data);

  const missing = await commands.tier.run([], ctx(ROOT));
  assert.equal(missing.exitCode, EXIT.USAGE, 'a bare `insight tier` is a usage error, not tier "mid"');
  assert.equal(missing.envelope.errors[0].code, 'missing-positional');
});

test('jd-similarity reports a decision, and an unreadable input as exit 3', async () => {
  const dir = box('sim');
  writeFileSync(join(dir, 'new.txt'), 'Senior Python engineer, FastAPI, PostgreSQL, Kubernetes.');
  writeFileSync(join(dir, 'old.txt'), 'Senior Python engineer, FastAPI, PostgreSQL, Kubernetes.');

  const r = await commands['jd-similarity'].run([join(dir, 'new.txt'), join(dir, 'old.txt')], ctx(ROOT));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r, 'jd-similarity');
  assert.equal(r.envelope.data.decision, 'reuse');
  assert.equal(typeof r.envelope.data.score, 'number');

  const gone = await commands['jd-similarity'].run([join(dir, 'nope.txt'), join(dir, 'old.txt')], ctx(ROOT));
  assert.equal(gone.exitCode, EXIT.UNVERIFIED, 'a missing JD is could-not-verify, not a low score');
  assertEnvelope(gone, 'jd-similarity');
});

test('jd-skill-gap classifies against a CV, and calls an inconclusive extraction exit 3', async () => {
  const dir = box('gap');
  writeFileSync(join(dir, 'jd.txt'), [
    'Senior Backend Engineer', '', '## Requirements',
    '- Python, FastAPI, PostgreSQL', '- Experience with Kubernetes', '- Terraform and Rust', '',
  ].join('\n'));
  writeFileSync(join(dir, 'cv.md'), [
    '# Skills', 'Python, PostgreSQL, Docker', '',
    '# Experience', 'Deployed services onto Kubernetes clusters and wrote FastAPI endpoints.', '',
  ].join('\n'));

  const r = await commands['jd-skill-gap'].run([join(dir, 'jd.txt'), '--cv', join(dir, 'cv.md')], ctx(ROOT));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r, 'jd-skill-gap');
  assert.ok(r.envelope.data.gap.includes('Rust'), 'a skill the CV never mentions is a gap');
  assert.ok(r.envelope.data.existing.includes('Python'), 'a named skill is existing');
  assert.equal(r.envelope.data.lowConfidence, null);

  // src/scripts/jd-skill-gap.mjs prints the three buckets and exits 0 with a LOW CONFIDENCE
  // banner. Three empty buckets at exit 0 are indistinguishable from a clean
  // bill of health, which is the state ADR 0006 forbids sharing.
  writeFileSync(join(dir, 'empty-jd.txt'), 'This posting says nothing about tools.\n');
  const weak = await commands['jd-skill-gap'].run([join(dir, 'empty-jd.txt'), '--cv', join(dir, 'cv.md')], ctx(ROOT));
  assert.equal(weak.exitCode, EXIT.UNVERIFIED);
  assert.match(weak.envelope.errors[0].message, /extraction was inconclusive/);
  assert.ok(weak.envelope.data.lowConfidence, 'the diagnosis is kept, not discarded');
  assertEnvelope(weak, 'jd-skill-gap');

  const noCv = await commands['jd-skill-gap'].run([join(dir, 'jd.txt'), '--cv', join(dir, 'nope.md')], ctx(ROOT));
  assert.equal(noCv.exitCode, EXIT.UNVERIFIED);
  assert.match(noCv.envelope.errors[0].message, /no CV at/);
});

test('process-quality aggregates a friction table, and reports a missing one as exit 3', async () => {
  const dir = box('pq');
  const file = join(dir, 'active-interviews.md');
  writeFileSync(file, [
    '| Company | Role | Round | Date/Time | Interviewer | Status | Notes |',
    '|---|---|---|---|---|---|---|',
    '| Acme | Engineer | 3 | 2026-05-01 | Bo | Done | [process-friction: five rounds] |',
    '',
  ].join('\n'));

  const r = await commands['process-quality'].run(['--file', file], ctx(ROOT));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r, 'process-quality');
  assert.equal(r.envelope.data.metadata.totalRows, 1);
  assert.equal(r.envelope.data.signals[0].company, 'Acme');

  const gone = await commands['process-quality'].run(['--file', join(dir, 'nope.md')], ctx(ROOT));
  assert.equal(gone.exitCode, EXIT.UNVERIFIED,
    'a missing interviews file is could-not-verify, never "no friction found"');
  assertEnvelope(gone, 'process-quality');
});

test('jd-lookup separates "no captures directory" from "no capture for this report"', async () => {
  const dir = box('jds');
  const jds = join(dir, 'jds');
  mkdirSync(jds);
  writeFileSync(join(jds, '064-acme-engineer.pdf'), 'x');

  const hit = await commands['jd-lookup'].run(['--report', '64', '--dir', jds], ctx(ROOT));
  assert.equal(hit.exitCode, EXIT.OK);
  assertEnvelope(hit, 'jd-lookup');
  assert.equal(hit.envelope.data.filename, '064-acme-engineer.pdf');

  // The lookup ran and found nothing: a real negative finding, exit 1.
  const miss = await commands['jd-lookup'].run(['--report', '99', '--dir', jds], ctx(ROOT));
  assert.equal(miss.exitCode, EXIT.FAILED);
  assert.equal(miss.envelope.errors[0].code, 'not-found');
  assertEnvelope(miss, 'jd-lookup');

  // The lookup could not run at all: exit 3. These must not collapse together.
  const noDir = await commands['jd-lookup'].run(['--report', '64', '--dir', join(dir, 'gone')], ctx(ROOT));
  assert.equal(noDir.exitCode, EXIT.UNVERIFIED);
  assert.notEqual(noDir.exitCode, miss.exitCode, 'ADR 0006: 1 and 3 are deliberately distinct');
  assertEnvelope(noDir, 'jd-lookup');

  const noReport = await commands['jd-lookup'].run(['--dir', jds], ctx(ROOT));
  assert.equal(noReport.exitCode, EXIT.USAGE);
  assert.equal(noReport.envelope.errors[0].flag, '--report');
});

test('weekly-digest builds a digest, and rejects half a range as a usage error', async () => {
  const dir = box('digest');
  const sessions = join(dir, 'sessions');
  mkdirSync(sessions);

  const r = await commands['weekly-digest'].run(['--dir', sessions], ctx(ROOT));
  assert.equal(r.exitCode, EXIT.OK, 'an empty but present sessions directory is a real, empty answer');
  assertEnvelope(r, 'weekly-digest');
  assert.equal(r.envelope.data.metadata.sessionsDirFound, true);

  const gone = await commands['weekly-digest'].run(['--dir', join(dir, 'nope')], ctx(ROOT));
  assert.equal(gone.exitCode, EXIT.UNVERIFIED, 'an absent directory is a different state from an empty one');

  // One bound without the other silently widened the window before ADR 0006.
  const half = await commands['weekly-digest'].run(['--dir', sessions, '--from', '2026-01-01'], ctx(ROOT));
  assert.equal(half.exitCode, EXIT.USAGE);
  assertEnvelope(half, 'weekly-digest');

  const junk = await commands['weekly-digest'].run(['--dir', sessions, '--from', 'last-tuesday'], ctx(ROOT));
  assert.equal(junk.exitCode, EXIT.USAGE);
  assert.match(junk.envelope.errors[0].message, /expects YYYY-MM-DD/);
});

test('reposts clusters real scan history, and says so when there is none', async () => {
  const dir = box('reposts');
  mkdirSync(join(dir, 'data'));
  const history = join(dir, 'data', 'scan-history.tsv');
  // Dates relative to today, not fixed: src/scripts/detect-reposts.mjs only looks back 90
  // days, so a hard-coded fixture stops clustering the moment it ages out and
  // the test would then be asserting "no reposts" against a check that never
  // examined the rows.
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  writeFileSync(history, [
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation',
    `https://acme.example/j/1\t${daysAgo(40)}\tlever\tBackend Engineer\tAcme\tadded\tRemote`,
    `https://acme.example/j/2\t${daysAgo(5)}\tlever\tBackend Engineer\tAcme\tadded\tRemote`,
    '',
  ].join('\n'));
  const portals = join(dir, 'portals.yml');
  writeFileSync(portals, 'tracked_companies:\n  - name: Acme\n    provider: lever\n');

  const env = { CAREER_OPS_SCAN_HISTORY: history, CAREER_OPS_PORTALS: portals };
  const r = await commands.reposts.run([], ctx(ROOT, env));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r, 'reposts');
  assert.equal(r.envelope.data.metadata.totalRows, 2);
  assert.equal(r.envelope.data.metadata.clusters, 1, 'two listings of one role five weeks apart is a repost');

  // Zero configured aggregators looks identical to a working exclusion list,
  // so the adapter says which one it was.
  assert.ok(r.envelope.warnings.some((w) => /no aggregator companies configured/.test(w)));

  const gone = await commands.reposts.run([], ctx(ROOT, { CAREER_OPS_SCAN_HISTORY: join(dir, 'nope.tsv') }));
  assert.equal(gone.exitCode, EXIT.UNVERIFIED, 'no history is could-not-verify, never "no reposts"');
});

test('stats counts what is present and names every source that is not', async () => {
  const dir = box('stats');
  mkdirSync(join(dir, 'data'));
  const tracker = join(dir, 'data', 'applications.md');
  writeFileSync(tracker, [
    '# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-05-01 | Acme | Engineer | 4 | Applied | | | |',
    '',
  ].join('\n'));

  const r = await commands.stats.run([], ctx(ROOT, { CAREER_OPS_TRACKER: tracker }));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r, 'stats');
  assert.equal(r.envelope.data.metadata.sources.tracker, true);
  assert.equal(r.envelope.data.tracker.total, 1);
  // An absent source leaves its section null. Reporting that as zero is the
  // "nothing found" ADR 0006 bans, so it is a warning on a real result.
  assert.equal(r.envelope.data.scan, null);
  assert.ok(r.envelope.warnings.some((w) => /no data for scanHistory/.test(w)));

  const bare = box('stats-bare');
  const gone = await commands.stats.run([], ctx(bare));
  assert.equal(gone.exitCode, EXIT.UNVERIFIED, 'no data at all is could-not-verify, not a zero count');
});

test('funnel-velocity calibrates against a tracker, and refuses to without one', async () => {
  const dir = box('velocity');
  mkdirSync(join(dir, 'data'));
  const tracker = join(dir, 'data', 'applications.md');
  writeFileSync(tracker, [
    '# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-05-01 | Acme | Engineer | 4 | Applied | | | |',
    '',
  ].join('\n'));

  const r = await commands['funnel-velocity'].run([], ctx(ROOT, { CAREER_OPS_TRACKER: tracker }));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r, 'funnel-velocity');
  assert.equal(r.envelope.data.calibration.everApplied, 1);
  assert.ok(r.envelope.warnings.some((w) => /no status log at/.test(w)));

  // src/scripts/funnel-velocity.mjs prints `{"calibration": null, …}` at exit 0 with no
  // tracker — a calibration report for a calibration that never happened.
  const gone = await commands['funnel-velocity'].run([], ctx(ROOT, { CAREER_OPS_TRACKER: join(dir, 'nope.md') }));
  assert.equal(gone.exitCode, EXIT.UNVERIFIED);
  assert.equal(gone.envelope.data.calibration, undefined);
});

test('history builds company cards, and separates an unknown company from a missing tracker', async () => {
  const dir = box('history');
  mkdirSync(join(dir, 'data'));
  const tracker = join(dir, 'data', 'applications.md');
  writeFileSync(tracker, [
    '# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-05-01 | Acme | Engineer | 4 | Applied | | | |',
    '',
  ].join('\n'));

  // src/scripts/company-history.mjs's loaders take a rootDir and read process.env
  // themselves, so this is the one case that cannot be driven by the injected
  // env alone. Restored immediately; noted so the coupling is visible rather
  // than mysterious.
  const saved = process.env.CAREER_OPS_TRACKER;
  process.env.CAREER_OPS_TRACKER = tracker;
  try {
    const r = await commands.history.run([], ctx(ROOT, { CAREER_OPS_TRACKER: tracker }));
    assert.equal(r.exitCode, EXIT.OK);
    assertEnvelope(r, 'history');
    assert.equal(r.envelope.data.companies.length, 1);

    const hit = await commands.history.run(['--company', 'Acme'], ctx(ROOT, { CAREER_OPS_TRACKER: tracker }));
    assert.equal(hit.exitCode, EXIT.OK);
    assert.equal(hit.envelope.data.company, 'Acme');

    // getCompanyCard never returns null — an unknown company comes back as a
    // synthetic no-history card, which at exit 0 would read as a real one.
    const miss = await commands.history.run(['--company', 'Nowhere Ltd'], ctx(ROOT, { CAREER_OPS_TRACKER: tracker }));
    assert.equal(miss.exitCode, EXIT.FAILED);
    assert.equal(miss.envelope.errors[0].code, 'no-history');
    assert.equal(miss.envelope.data.company, 'Nowhere Ltd', 'the card it built is still returned');
    assertEnvelope(miss, 'history');
  } finally {
    if (saved === undefined) delete process.env.CAREER_OPS_TRACKER;
    else process.env.CAREER_OPS_TRACKER = saved;
  }

  const gone = await commands.history.run([], ctx(box('history-bare')));
  assert.equal(gone.exitCode, EXIT.UNVERIFIED);
});

// ── The spawned commands, against stub scripts ──────────────────────

/**
 * A root holding a tracker plus whichever stub scripts a case needs.
 * `active-interviews.md` and `data/salary-observations.tsv` satisfy the
 * preflights of rejection-latency and salary-gap.
 */
function spawnBox(scripts) {
  const dir = box('spawn');
  mkdirSync(join(dir, 'data'));
  mkdirSync(join(dir, 'reports'));
  writeFileSync(join(dir, 'data', 'applications.md'), '# Applications Tracker\n');
  writeFileSync(join(dir, 'active-interviews.md'), '| Company |\n|---|\n');
  writeFileSync(join(dir, 'data', 'salary-observations.tsv'), 'num\ttype\n');
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(dir, name), body);
  return dir;
}

test('a child that reports an empty input becomes exit 3, not a finding', async () => {
  // src/scripts/analyze-patterns.mjs's live behaviour: `{"error": "No applications found
  // in tracker."}` at exit 1 — ADR 0006's banned phrasing on ADR 0006's code
  // for a real negative finding. The adapter is where that is corrected.
  const dir = spawnBox({
    'src/scripts/analyze-patterns.mjs': 'console.log(JSON.stringify({ error: "No applications found in tracker." }));\nprocess.exit(1);\n',
  });
  const r = await commands.patterns.run([], ctx(dir));
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.equal(r.envelope.ok, false);
  assert.match(r.envelope.errors[0].message, /could not verify: No applications found in tracker\./);
  assertEnvelope(r, 'patterns');
});

test('a child that succeeds is lifted into the envelope, stderr becomes warnings', async () => {
  const dir = spawnBox({
    'src/scripts/upskill.mjs': 'console.error("cv.md not found, using the example");\nconsole.log(JSON.stringify({ gaps: [{ skill: "Rust" }] }));\n',
  });
  const r = await commands.upskill.run([], ctx(dir));
  assert.equal(r.exitCode, EXIT.OK);
  assertEnvelope(r, 'upskill');
  assert.deepEqual(r.envelope.data, { gaps: [{ skill: 'Rust' }] });
  assert.deepEqual(r.envelope.warnings, ['cv.md not found, using the example']);
});

test('a child that crashes is could-not-verify, never a negative finding', async () => {
  const dir = spawnBox({
    'src/scripts/salary-gap.mjs': 'console.error("TypeError: cannot read properties of undefined");\nprocess.exit(1);\n',
  });
  const r = await commands['salary-gap'].run([], ctx(dir));
  assert.equal(r.exitCode, EXIT.UNVERIFIED, 'an unfinished run is not a result');
  assert.match(r.envelope.errors[0].message, /salary-gap\.mjs exited 1/);
  assertEnvelope(r, 'salary-gap');
});

test("a child's own usage rejection stays a usage error", async () => {
  const dir = spawnBox({
    'src/scripts/rejection-latency.mjs': 'console.error("--today expects YYYY-MM-DD");\nprocess.exit(2);\n',
  });
  const r = await commands['rejection-latency'].run([], ctx(dir));
  assert.equal(r.exitCode, EXIT.USAGE);
  assertEnvelope(r, 'rejection-latency');
});

test('a child that prints prose instead of JSON is could-not-verify', async () => {
  const dir = spawnBox({ 'src/scripts/upskill.mjs': 'console.log("everything looks fine!");\n' });
  const r = await commands.upskill.run([], ctx(dir));
  assert.equal(r.exitCode, EXIT.UNVERIFIED, 'unparseable output is not evidence of anything');
  assert.match(r.envelope.errors[0].message, /did not emit JSON/);
});

test('a spawned command checks its inputs before starting the child', async () => {
  // The stub would exit 0 with an empty result. The preflight has to fire
  // first, or an absent tracker is reported as an analysis that found nothing.
  const dir = spawnBox({ 'src/scripts/analyze-patterns.mjs': 'console.log("{}");\n' });
  rmSync(join(dir, 'data', 'applications.md'));
  const r = await commands.patterns.run([], ctx(dir));
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.match(r.envelope.errors[0].message, /no tracker at/);
});

test('a spawned command reports a missing script rather than exiting 1 on it', async () => {
  const r = await commands['salary-gap'].run([], ctx(spawnBox({})));
  assert.equal(r.exitCode, EXIT.UNVERIFIED);
  assert.match(r.envelope.errors[0].message, /salary-gap\.mjs is not in/);
});

test('flags reach the child in the spelling it understands', async () => {
  const dir = spawnBox({
    'src/scripts/analyze-patterns.mjs': 'console.log(JSON.stringify({ argv: process.argv.slice(2) }));\n',
  });
  const r = await commands.patterns.run(['--min-threshold', '9', '--min-vendor-n', '3'], ctx(dir));
  assert.equal(r.exitCode, EXIT.OK);
  assert.deepEqual(r.envelope.data.argv, ['--min-threshold', '9', '--min-vendor-n', '3']);

  // The `=` form must arrive identically: `--min-threshold=9` is invisible to
  // the child's own indexOf lookup, so the adapter normalises it.
  const eq = await commands.patterns.run(['--min-threshold=9'], ctx(dir));
  assert.deepEqual(eq.envelope.data.argv, ['--min-threshold', '9']);
});

test('upskill sends only the flags the mode it selected understands', async () => {
  const dir = spawnBox({
    'src/scripts/upskill.mjs': 'console.log(JSON.stringify({ argv: process.argv.slice(2) }));\n',
  });
  const aggregate = await commands.upskill.run(['--min-reports', '7'], ctx(dir));
  assert.deepEqual(aggregate.envelope.data.argv, ['--min-reports', '7']);

  // Targeted mode reads the URL it was given, not the tracker, so its preflight
  // is skipped and --min-reports would be meaningless.
  rmSync(join(dir, 'data', 'applications.md'));
  const targeted = await commands.upskill.run(['--url-text', 'https://example.com/jd'], ctx(dir));
  assert.deepEqual(targeted.envelope.data.argv, ['--url-text', 'https://example.com/jd']);
});
