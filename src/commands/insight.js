/**
 * insight.js — the `career-ops insight` noun.
 *
 * Fifteen read-only analytics commands, one per ADR 0003's `insight` rows.
 * Every one is an ADR 0006 adapter and nothing else: parse argv through
 * src/core/flags.js, call something that already exists, wrap the result in the
 * envelope. No analysis happens in this file. If a line here starts computing
 * something the answer depends on, it is in the wrong file.
 *
 * ── Two delegation strategies, both adapters ────────────────────────
 *
 * `imported` (11 commands) — the root script exports the whole computation, so
 * the adapter imports it and calls it. This is the destination shape: when
 * ADR 0005 step 5 moves the script under src/, only the specifier changes.
 *
 * `spawned` (4 commands: patterns, rejection-latency, salary-gap, upskill) —
 * the computation lives in the script's unexported main block, or the module
 * reads the IMPORTER's argv at module scope and can exit the process before
 * this file gets control. Both were measured, not assumed:
 *
 *   - rejection-latency.mjs:110 runs `validateFlags(process.argv.slice(2), …)`
 *     at module scope. Importing it under `career-ops insight rejection-latency
 *     --json` kills the CLI with "unrecognized flag(s): --json" at exit 1,
 *     because --json is not in ITS flag list.
 *   - analyze-patterns.mjs has no main guard at all: importing it runs the
 *     whole analysis and prints to stdout.
 *   - salary-gap.mjs's `collectSources` and upskill.mjs's `analyze` are not
 *     exported, and reimplementing them here would be exactly the business
 *     logic an adapter must not hold.
 *
 * A spawn is a legitimate adapter — it is a boundary, not an algorithm — and it
 * collapses into an import the moment those four files gain an exported entry
 * point. Nothing else in this file needs to change when they do.
 *
 * ── The one behaviour this layer adds ───────────────────────────────
 *
 * ADR 0006's rule that an empty result and an unperformed check must never
 * share a representation. Seven of these fifteen violate it today at the root:
 * `analyze-patterns.mjs` exits 1 with "No applications found in tracker.",
 * `upskill.mjs` returns `{error: …}` at exit 0, `funnel-velocity.mjs` prints
 * `calibration: null` at exit 0 with no tracker, `company-funded.mjs` reports
 * `companies: []` at exit 0 when every feed was blocked. Each becomes exit 3
 * with a stated reason here. The root scripts keep their exit codes for the
 * consumers that pin them; ADR 0006 is explicit that the CLI does not inherit
 * the inconsistency.
 *
 * Exit codes used by this noun:
 *   0  the command ran and produced a result
 *   1  a lookup ran and found nothing — `jd-lookup` and `history --company`
 *      only. The other thirteen are reports, not pass/fail checks, and never
 *      return 1: an analysis that finds zero reposts succeeded.
 *   2  usage error, from parseFlags
 *   3  the command could not run — missing input, blocked feed, inconclusive
 *      extraction
 *   4  config error — a malformed benchmarks or profile file
 */

import { existsSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn } from 'child_process';

import {
  EXIT, parseFlags, renderHelp, envelope, errorEnvelope, couldNotVerify,
} from '../core/flags.js';
import { readFile, resolveTrackerPath, resolveScanHistoryPath, resolveDataRoot } from '../core/store.js';

/** The checkout this file ships in — where the root scripts still live. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const noun = 'insight';

// ── Result shapes ───────────────────────────────────────────────────
//
// A command returns { exitCode, envelope, text, json }: the facade writes
// `JSON.stringify(envelope)` when `json` is true and `text` otherwise, then
// exits `exitCode`. Nothing here writes to stdout or calls process.exit, which
// is what makes every case below testable by calling it.

/** Pretty `data`, which is what a command prints without --json. */
const asText = (data) => JSON.stringify(data, null, 2);

const succeed = (name, data, warnings = []) => ({
  envelope: envelope(name, { data, warnings }),
  exitCode: EXIT.OK,
  text: asText(data),
});

/** The check could not run. The one thing this layer exists to say properly. */
const unverified = (name, reason, { data = {}, warnings = [] } = {}) => ({
  envelope: couldNotVerify(name, reason, { data, warnings }),
  exitCode: EXIT.UNVERIFIED,
  text: `${name}: could not verify: ${reason}`,
});

/** The check ran and found nothing — a real negative finding, not a silence. */
const negative = (name, message, { code = 'not-found', data = {}, warnings = [] } = {}) => ({
  envelope: errorEnvelope(name, [{ code, message }], { data, warnings }),
  exitCode: EXIT.FAILED,
  text: `${name}: ${message}`,
});

const configError = (name, message) => ({
  envelope: errorEnvelope(name, [{ code: 'config-error', message }]),
  exitCode: EXIT.CONFIG,
  text: `${name}: ${message}`,
});

const usageError = (name, errors, help = '') => {
  const said = errors.map((e) => e.message).join('\n');
  return {
    envelope: errorEnvelope(name, errors),
    exitCode: EXIT.USAGE,
    // The help block follows the complaint, so a caller who mistyped one flag
    // sees the valid ones without asking again. A child's own usage rejection
    // has no help of ours to append.
    text: help ? `${said}\n\n${help}` : said,
  };
};

/**
 * Map a thrown error onto an exit code.
 *
 * The default is 3, not 1. A throw means the command did not finish, and
 * reporting an unfinished command as a negative finding is the exact collapse
 * ADR 0006 forbids. Only a file this repo owns being malformed is a 4.
 */
function fromThrown(name, err) {
  const message = err?.message || String(err);
  if (/^(Malformed|Cannot read benchmarks|Cannot read profile)/.test(message)) {
    return configError(name, message);
  }
  return unverified(name, message);
}

// ── Input checks ────────────────────────────────────────────────────
//
// Presence, not content. Deciding whether a file is USABLE is the job of the
// thing that reads it; deciding whether it is THERE is what separates exit 3
// from exit 0, so it has to happen before the call.

const fileExists = (path) => {
  try { return statSync(path).isFile(); } catch { return false; }
};
const dirExists = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/** Paths a command reads, resolved against an injected root. */
function paths(rootDir, env) {
  const dataRoot = resolveDataRoot(rootDir, env);
  return {
    tracker: resolveTrackerPath(rootDir, env),
    scanHistory: resolveScanHistoryPath(rootDir, env),
    followups: join(dataRoot, 'data', 'follow-ups.md'),
    activeInterviews: existsSync(join(rootDir, 'data', 'active-interviews.md'))
      ? join(rootDir, 'data', 'active-interviews.md')
      : join(rootDir, 'active-interviews.md'),
    salaryObservations: join(rootDir, 'data', 'salary-observations.tsv'),
    reports: join(rootDir, 'reports'),
    jds: join(rootDir, 'jds'),
    cv: join(rootDir, 'cv.md'),
    sessions: join(rootDir, 'interview-prep', 'sessions'),
    portals: env.CAREER_OPS_PORTALS || join(rootDir, 'portals.yml'),
  };
}

// ── Delegation ──────────────────────────────────────────────────────

/** Import a root script through an injected root, so tests can sandbox it. */
const load = (rootDir, script) => import(pathToFileURL(join(rootDir, script)).href);

/**
 * Run a root script as a child process and hand back its three outputs.
 *
 * stdio is captured rather than inherited: the child's stdout is DATA to this
 * layer, and letting it reach the terminal directly would print a bare result
 * next to the envelope that describes it.
 */
function runScript(rootDir, script, argv, env) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(rootDir, script), ...argv], {
      cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rej);
    child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}

const tryParse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

/**
 * The spawn adapter's result mapping, in one place so all four agree.
 *
 * `{ "error": "…" }` on stdout is the shape three of these four scripts use to
 * say "I had nothing to work from" — `analyze-patterns.mjs` at exit 1,
 * `upskill.mjs` at exit 0. Both are a check that did not run, so both become 3.
 * A non-zero exit with no such payload is a crash or a usage rejection, which
 * is also not a finding: 2 if the child said so, otherwise 3.
 */
function fromChild(name, script, { code, stdout, stderr }) {
  const data = tryParse(stdout);
  const firstLine = stderr.trim().split('\n')[0] || '';
  if (data && typeof data.error === 'string' && data.error.trim()) {
    return unverified(name, data.error.trim());
  }
  if (code === EXIT.USAGE) {
    const message = stderr.trim() || `${script} rejected the arguments`;
    return usageError(name, [{ code: 'usage', message }]);
  }
  if (code !== 0) {
    return unverified(name, `${script} exited ${code}${firstLine ? `: ${firstLine}` : ''}`);
  }
  if (data === undefined) return unverified(name, `${script} did not emit JSON on stdout`);
  return succeed(name, data, stderr.trim() ? stderr.trim().split('\n') : []);
}

// ── Command construction ────────────────────────────────────────────

/**
 * Turn a spec plus a handler into `{ run, help, flags }`.
 *
 * The three things every command must do — reject bad flags at exit 2, answer
 * --help, and never let a throw escape as an unhandled rejection — happen here
 * once rather than fifteen times. A handler only sees a successful parse.
 */
function command(spec, handler) {
  const name = `insight ${spec.verb}`;
  const full = {
    ...spec,
    command: `career-ops ${name}`,
    usage: spec.usage || `career-ops ${name} [options]${spec.positionals ? ` <${spec.positionals.name}>` : ''}`,
    flags: spec.flags || {},
  };
  const help = renderHelp(full);

  return {
    flags: full.flags,
    help,
    /**
     * @param {string[]} argv - argv slice AFTER the noun and verb.
     * @param {{rootDir?: string, env?: object}} [ctx] - Injected for tests.
     * @returns {Promise<{exitCode: number, envelope: object, text: string, json: boolean}>}
     */
    async run(argv = [], ctx = {}) {
      const parsed = parseFlags(argv, full);
      // Flag errors before --help, matching parseFlags' own ordering: `--help
      // --bogus` must report --bogus rather than exit 0 having never read it.
      // Spec-level constraints join them: flags.js checks shape, `validate`
      // checks range, and a range the callee would silently substitute a
      // default for has to be rejected here or not at all.
      const extra = parsed.ok && !parsed.help && spec.validate ? spec.validate(parsed) : [];
      const bad = [...parsed.errors, ...extra];
      if (bad.length > 0) return { ...usageError(name, bad, help), json: parsed.json };
      if (parsed.help) {
        return { exitCode: EXIT.OK, envelope: envelope(name, { data: { help } }), text: help, json: parsed.json };
      }
      const rootDir = ctx.rootDir || REPO_ROOT;
      const env = ctx.env || process.env;
      let out;
      try {
        out = await handler({
          values: parsed.values,
          positionals: parsed.positionals,
          name,
          rootDir,
          env,
          p: paths(rootDir, env),
        });
      } catch (err) {
        out = fromThrown(name, err);
      }
      return { ...out, json: parsed.json };
    },
  };
}

/**
 * A spawned command, from a flag spec and a mapping of parsed flags to the
 * child's argv. `preflight` returns a reason string when a required input is
 * absent — checked here so a missing tracker is exit 3 with a sentence rather
 * than whatever the child does about it.
 */
function spawned(spec, { script, childArgs, preflight }) {
  return command(spec, async (c) => {
    if (!fileExists(join(c.rootDir, script))) {
      return unverified(c.name, `${script} is not in ${c.rootDir}`);
    }
    const why = preflight ? preflight(c) : null;
    if (why) return unverified(c.name, why);
    return fromChild(c.name, script, await runScript(c.rootDir, script, childArgs(c), c.env));
  });
}

/**
 * A `validate` entry for a numeric flag that must fall in a range.
 *
 * Out-of-range is a usage error here rather than a silent substitution.
 * `discoverFundedCompanies` reads `opts.limit || DEFAULT_LIMIT`, so `--limit 0`
 * would come back as a 25-company report the caller never asked for, at exit 0
 * — the same falsy-default defect flags.js was written to end, one layer up.
 */
const inRange = (flag, lo, hi) => (p) => {
  const v = p.values[flag];
  if (v === undefined) return [];
  if (!Number.isInteger(v) || v < lo || v > hi) {
    return [{ code: 'invalid-value', flag, message: `${flag} expects an integer from ${lo} to ${hi}, got ${v}` }];
  }
  return [];
};

/** A `validate` entry for a flag that must be a calendar date, when supplied. */
const isoDate = (flag) => (p) => {
  const v = p.values[flag];
  if (v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(v)) return [];
  return [{ code: 'invalid-value', flag, message: `${flag} expects YYYY-MM-DD, got "${v}"` }];
};

/** Compose several `validate` entries into one. */
const all = (...checks) => (p) => checks.flatMap((c) => c(p));

// ── The fifteen ─────────────────────────────────────────────────────

const commands = {};

/**
 * `insight patterns` — ADR 0003 calls it `analyze-patterns`. Renamed: the noun
 * already says this is analysis, so `insight analyze-patterns` says it twice.
 */
commands.patterns = spawned({
  verb: 'patterns',
  description: 'What the tracker says about which applications convert, and why.',
  flags: {
    '--min-threshold': { type: 'number', describe: 'Minimum occurrences before a pattern is claimed (default 5)' },
    '--min-vendor-n': { type: 'number', describe: 'Minimum per-vendor sample for a channel-yield claim (default 8)' },
  },
  // Zero floors make every sample "sufficient", which silently defeats the
  // guard the claims rest on. analyze-patterns.mjs substitutes its default
  // instead of saying so.
  validate: all(inRange('--min-threshold', 1, 1000), inRange('--min-vendor-n', 1, 1000)),
}, {
  script: 'analyze-patterns.mjs',
  preflight: (c) => (fileExists(c.p.tracker) ? null : `no tracker at ${c.p.tracker}`),
  childArgs: (c) => [
    ...(c.values['--min-threshold'] !== undefined ? ['--min-threshold', String(c.values['--min-threshold'])] : []),
    ...(c.values['--min-vendor-n'] !== undefined ? ['--min-vendor-n', String(c.values['--min-vendor-n'])] : []),
  ],
});

/**
 * `insight tier` — ADR 0003 calls it `classify-tier`. Renamed: `insight
 * classify-tier "Staff Engineer"` reads as an instruction to reclassify
 * something; `insight tier "Staff Engineer"` reads as the question it is.
 *
 * The only command here that reads no files, so exit 3 is unreachable for it.
 */
commands.tier = command({
  verb: 'tier',
  description: 'Seniority tier for a job title: intern, entry, mid or senior.',
  positionals: { name: 'title', min: 1, max: 1 },
}, async (c) => {
  const { classifyTier } = await load(c.rootDir, 'classify-tier.mjs');
  const title = c.positionals[0];
  return succeed(c.name, { title, tier: classifyTier(title) });
});

commands.funded = command({
  verb: 'funded',
  description: 'Recently funded companies worth adding to the portal list.',
  flags: {
    '--limit': { type: 'number', describe: 'Maximum companies to return, 1-100 (default 25)' },
    '--months': { type: 'number', describe: 'Funding window in months, 1-120 (default 12)' },
    '--sort': { type: 'string', describe: 'date or score (default score)' },
    '--sources': { type: 'string', describe: 'Comma-separated feed names to query' },
  },
  validate: all(
    inRange('--limit', 1, 100),
    inRange('--months', 1, 120),
    (p) => (p.values['--sort'] === undefined || ['date', 'score'].includes(p.values['--sort'])
      ? []
      : [{ code: 'invalid-value', flag: '--sort', message: '--sort expects date or score' }]),
  ),
}, async (c) => {
  const { discoverFundedCompanies } = await load(c.rootDir, 'company-funded.mjs');
  const sources = c.values['--sources'];
  const result = await discoverFundedCompanies({
    limit: c.values['--limit'],
    months: c.values['--months'],
    sort: c.values['--sort'],
    sources: sources === undefined ? undefined : sources.split(',').map((s) => s.trim()).filter(Boolean),
    dryRun: true, // this layer never writes artifacts; the root script still can
  });
  // Every feed blocked is not "no companies were funded" — it is no answer at
  // all, and today it renders as an empty list at exit 0.
  const usable = (result.diagnostics || []).filter((d) => d.status === 'ok');
  if (result.diagnostics?.length && usable.length === 0) {
    const why = result.diagnostics.map((d) => `${d.source} ${d.status}`).join(', ');
    return unverified(c.name, `every funding source failed: ${why}`, { data: result });
  }
  const warnings = (result.diagnostics || [])
    .filter((d) => d.status !== 'ok')
    .map((d) => `source ${d.source} ${d.status}: ${(d.errors || []).join('; ') || 'no detail'}`);
  return succeed(c.name, result, warnings);
});

commands.history = command({
  verb: 'history',
  description: 'Per-company responsiveness and posting-churn cards from the tracker.',
  flags: {
    '--company': { type: 'string', describe: 'One company card instead of all of them' },
    '--silence-window': { type: 'number', describe: 'Days of silence before a company is called unresponsive' },
    '--include-stale': { type: 'boolean', describe: 'Keep companies whose last activity is outside the window' },
    '--followups': { type: 'string', describe: 'A different follow-ups file' },
    '--scan-history': { type: 'string', describe: 'A different scan-history file' },
  },
  validate: inRange('--silence-window', 1, 3650),
}, async (c) => {
  const m = await load(c.rootDir, 'company-history.mjs');
  const tracker = m.loadTrackerRows(c.rootDir);
  if (!tracker.loaded) return unverified(c.name, `no tracker at ${c.p.tracker}`);

  const followups = m.loadFollowupRows(c.rootDir, c.values['--followups']);
  const scanHistory = m.loadRepostClusters(c.rootDir, c.values['--scan-history'], c.p.portals);
  const statusLog = await m.loadStatusLogSource();
  const includeStale = c.values['--include-stale'];

  const result = m.buildCompanyCards({
    trackerRows: tracker.rows,
    followupRows: followups.rows,
    repostClusters: scanHistory.clusters,
    aggregators: scanHistory.aggregators,
    sourcesLoaded: {
      tracker: tracker.loaded,
      followups: followups.loaded,
      scanHistory: scanHistory.loaded,
      statusLog: statusLog.loaded,
    },
    statusLogAppliedByNum: statusLog.appliedDateByNum,
    medianResponseDays: statusLog.medianResponseDays,
  }, {
    silenceWindowDays: c.values['--silence-window'] ?? m.resolveDefaultSilenceWindow(c.rootDir),
    includeStale,
  });

  const warnings = [];
  if (!scanHistory.loaded) warnings.push('no scan history — posting churn was not evaluated');
  if (!followups.loaded) warnings.push('no follow-ups file — response facts omit follow-up counts');

  // `result.aggregators` is a Map, and JSON.stringify turns a Map into `{}` —
  // the aggregator list would vanish from --json output without a word. The
  // envelope has to survive the round trip the facade puts it through.
  const data = { ...result, aggregators: [...(result.aggregators?.values?.() ?? [])] };

  const company = c.values['--company'];
  if (company === undefined) return succeed(c.name, data, warnings);

  const card = m.getCompanyCard(result, company, scanHistory.aggregators);
  // getCompanyCard never returns null: an unknown company comes back as a
  // synthetic no-history card. Returning that at exit 0 would report an empty
  // card as a real one, so the lookup reports the miss and still hands back
  // what it built.
  if (card.responsiveness?.label === 'no-history') {
    return negative(c.name, `no tracker history for "${company}"`, { code: 'no-history', data: card, warnings });
  }
  return succeed(c.name, card, warnings);
});

/**
 * `insight reposts` — ADR 0003 calls it `detect-reposts`. Renamed: `detect-` is
 * the only verb every command here would earn, so it carries nothing.
 */
commands.reposts = command({
  verb: 'reposts',
  description: 'Postings the scanner has seen re-listed, clustered by company and role.',
  flags: {
    '--window': { type: 'number', describe: 'Lookback window in days (default 90)' },
    '--min-span': { type: 'number', describe: 'Smallest day span that still counts as a repost (default 1)' },
  },
  // detect-reposts.mjs:126 falls back to its default for anything that is not a
  // non-negative integer, so a typo'd window reports a 90-day result. A
  // negative --min-span disables the very guard it exists to set.
  validate: all(inRange('--window', 1, 36500), inRange('--min-span', 1, 3650)),
}, async (c) => {
  const scan = readFile(c.p.scanHistory);
  if (!scan.exists) return unverified(c.name, `no scan history at ${c.p.scanHistory}`);

  const m = await load(c.rootDir, 'detect-reposts.mjs');
  const rows = m.parseScanHistory(scan.content);
  const aggregators = m.loadAggregatorCompanies(c.p.portals);
  const clusters = m.detectReposts(rows, c.values['--window'], c.values['--min-span'], aggregators);

  const warnings = aggregators.size === 0
    ? [`no aggregator companies configured in ${c.p.portals} — multi-employer boards are not excluded`]
    : [];
  return succeed(c.name, {
    metadata: { totalRows: rows.length, aggregatorCompanies: aggregators.size, clusters: clusters.length },
    clusters,
  }, warnings);
});

commands['funnel-velocity'] = command({
  verb: 'funnel-velocity',
  description: 'Stage-to-stage timings and how they compare against the benchmarks.',
  flags: {
    '--benchmarks': { type: 'string', describe: 'A different benchmarks.yml' },
  },
}, async (c) => {
  const tracker = readFile(c.p.tracker);
  // Today this prints `{calibration: null, …}` at exit 0 with no tracker, which
  // is a calibration report for a calibration that never happened.
  if (!tracker.exists || !tracker.content.trim()) {
    return unverified(c.name, `no tracker at ${c.p.tracker} — there is nothing to calibrate against`);
  }
  const m = await load(c.rootDir, 'funnel-velocity.mjs');
  const { loadCanonicalStates } = await load(c.rootDir, 'tracker-utils.mjs');
  const { localToday } = await load(c.rootDir, 'lib/local-today.mjs');

  const { benchmarks } = m.loadBenchmarks(c.values['--benchmarks']);
  const logPath = join(dirname(c.p.tracker), 'status-log.tsv');
  const log = readFile(logPath);
  const todayStr = localToday();

  const result = m.analyze({
    trackerContent: tracker.content,
    logContent: log.content,
    benchmarks,
    states: loadCanonicalStates(join(c.rootDir, 'templates/states.yml')),
    todayStr,
  });
  const warnings = log.exists ? [] : [`no status log at ${logPath} — velocity is computed from tracker dates alone`];
  return succeed(c.name, { ...result, generatedAt: todayStr }, warnings);
});

/**
 * `insight jd-lookup` — ADR 0003 calls it `jd-capture`. Renamed because the old
 * name lies: this command captures nothing, it finds a capture that
 * `archive-posting.mjs` already made. `insight jd-capture 64` reads as a
 * request to archive report 64's posting, which is a different, writing command.
 */
commands['jd-lookup'] = command({
  verb: 'jd-lookup',
  description: 'The archived job posting for a report number.',
  flags: {
    '--report': { type: 'number', describe: 'Report number to resolve (required)' },
    '--company': { type: 'string', describe: 'Company slug the capture must belong to' },
    '--dir': { type: 'string', describe: 'A different captures directory (default jds/)' },
  },
  validate: all(
    (p) => (p.values['--report'] === undefined
      ? [{ code: 'missing-value', flag: '--report', message: '--report is required' }]
      : []),
    inRange('--report', 1, 999999),
  ),
}, async (c) => {
  const report = c.values['--report'];
  const jdsDir = c.values['--dir'] || c.p.jds;
  if (!dirExists(jdsDir)) return unverified(c.name, `no captures directory at ${jdsDir}`);

  const { findCaptureForReport } = await load(c.rootDir, 'jd-capture.mjs');
  const found = findCaptureForReport(jdsDir, report, { companySlug: c.values['--company'] });
  if (!found) {
    const scoped = c.values['--company'] ? ` for company "${c.values['--company']}"` : '';
    return negative(c.name, `no capture in ${jdsDir} for report ${report}${scoped}`, { data: { report, dir: jdsDir } });
  }
  return succeed(c.name, { report, ...found });
});

commands['jd-similarity'] = command({
  verb: 'jd-similarity',
  description: 'Whether a new JD is close enough to a previous one to reuse the CV.',
  usage: 'career-ops insight jd-similarity <new-jd> <previous-jd-or-cv>',
  positionals: { name: 'file', min: 2, max: 2 },
}, async (c) => {
  const [newPath, prevPath] = c.positionals;
  for (const path of [newPath, prevPath]) {
    const r = readFile(path);
    if (!r.exists) return unverified(c.name, `cannot read ${path}`);
  }
  const { recommendCvReuse } = await load(c.rootDir, 'jd-similarity.mjs');
  const result = recommendCvReuse(readFile(newPath).content, readFile(prevPath).content);
  return succeed(c.name, { newJd: newPath, previous: prevPath, ...result });
});

commands['jd-skill-gap'] = command({
  verb: 'jd-skill-gap',
  description: 'Skills a JD asks for that the CV does not evidence.',
  usage: 'career-ops insight jd-skill-gap <jd-file>',
  positionals: { name: 'jd-file', min: 1, max: 1 },
  flags: {
    '--cv': { type: 'string', describe: 'A different CV (default cv.md in the checkout)' },
  },
}, async (c) => {
  const jdPath = c.positionals[0];
  // jd-skill-gap.mjs:35 resolves cv.md against process.cwd(), so running it
  // from anywhere but the checkout reads a different file or none. Resolved
  // against the injected root here instead.
  const cvPath = c.values['--cv'] || c.p.cv;
  const jd = readFile(jdPath);
  if (!jd.exists) return unverified(c.name, `cannot read the JD at ${jdPath}`);
  const cv = readFile(cvPath);
  if (!cv.exists) return unverified(c.name, `no CV at ${cvPath} — it is a user-layer file, create it first`);

  const m = await load(c.rootDir, 'jd-skill-gap.mjs');
  const jdSkills = m.extractJdSkills(jd.content);
  const diagnosis = m.diagnoseExtraction(jd.content, jdSkills);
  // The root script prints the three buckets anyway and exits 0 with a
  // LOW CONFIDENCE banner. An inconclusive extraction has not answered the
  // question, and a caller reading exit 0 cannot tell that from a clean bill.
  if (diagnosis) {
    return unverified(c.name, `skill extraction was inconclusive: ${diagnosis.message} (${diagnosis.reason})`,
      { data: { jd: jdPath, cv: cvPath, jdSkills, lowConfidence: diagnosis } });
  }
  return succeed(c.name, {
    jd: jdPath, cv: cvPath, jdSkills, ...m.classifySkillGaps(jdSkills, cv.content), lowConfidence: null,
  });
});

commands['process-quality'] = command({
  verb: 'process-quality',
  description: 'Companies whose interview process the notes flag as friction.',
  flags: {
    '--file': { type: 'string', describe: 'A different active-interviews.md' },
    '--min-threshold': { type: 'number', describe: 'Minimum rounds before a company is reported (default 1)' },
  },
  validate: inRange('--min-threshold', 0, 1000),
}, async (c) => {
  const path = c.values['--file'] || c.p.activeInterviews;
  const file = readFile(path);
  if (!file.exists) return unverified(c.name, `no active-interviews file at ${path}`);

  const m = await load(c.rootDir, 'process-quality.mjs');
  const rows = m.parseActiveInterviews(file.content);
  const minThreshold = c.values['--min-threshold'] ?? 1;
  const signals = m.aggregateProcessQuality(rows, minThreshold);
  return succeed(c.name, {
    metadata: { minThreshold, totalRows: rows.length, companies: signals.length },
    signals,
  });
});

commands['rejection-latency'] = spawned({
  verb: 'rejection-latency',
  description: 'Interviews left without an answer past the courtesy window. Observation only.',
  flags: {
    '--file': { type: 'string', describe: 'A different active-interviews.md' },
    '--tracker': { type: 'string', describe: 'A different applications.md' },
    '--courtesy-days': { type: 'number', describe: 'Days of silence before a company is flagged (default 30)' },
    '--today': { type: 'string', describe: 'Evaluate as of a fixed YYYY-MM-DD' },
  },
  validate: all(inRange('--courtesy-days', 1, 3650), isoDate('--today')),
}, {
  script: 'rejection-latency.mjs',
  preflight: (c) => {
    const interviews = c.values['--file'] || c.p.activeInterviews;
    if (!fileExists(interviews)) return `no active-interviews file at ${interviews}`;
    const tracker = c.values['--tracker'] || c.p.tracker;
    if (!fileExists(tracker)) return `no tracker at ${tracker}`;
    return null;
  },
  childArgs: (c) => [
    ...(c.values['--file'] ? ['--file', c.values['--file']] : []),
    ...(c.values['--tracker'] ? ['--tracker', c.values['--tracker']] : []),
    ...(c.values['--courtesy-days'] !== undefined ? ['--courtesy-days', String(c.values['--courtesy-days'])] : []),
    ...(c.values['--today'] ? ['--today', c.values['--today']] : []),
  ],
});

commands['salary-gap'] = spawned({
  verb: 'salary-gap',
  description: 'Advertised, stated and confirmed pay against the profile target.',
  flags: {
    '--stated-for': { type: 'string', describe: 'Only the stated observations for one tracker number' },
  },
}, {
  script: 'salary-gap.mjs',
  // Either source alone produces a real answer; neither means there is nothing
  // to fold, which the script reports as an empty result at exit 0.
  preflight: (c) => (fileExists(c.p.salaryObservations) || dirExists(c.p.reports)
    ? null
    : `no salary observations at ${c.p.salaryObservations} and no reports at ${c.p.reports}`),
  childArgs: (c) => (c.values['--stated-for'] ? ['--stated-for', c.values['--stated-for']] : []),
});

commands.stats = command({
  verb: 'stats',
  description: 'Counts across the tracker, scanner, portals, follow-ups and runs.',
}, async (c) => {
  const dataRoot = resolveDataRoot(c.rootDir, c.env);
  const files = {
    appsFile: c.p.tracker,
    scanHistoryFile: c.p.scanHistory,
    followupsFile: c.p.followups,
    scanRunsFile: join(dataRoot, 'data', 'scan-runs.tsv'),
    portalsFile: c.p.portals,
    portalHealthFile: join(dataRoot, 'data', 'portal-health.tsv'),
  };
  // Checked before the module is loaded, so an empty workspace is answered with
  // the workspace it looked in rather than with whatever failed first.
  if (!Object.values(files).some(fileExists)) {
    return unverified(c.name, `none of the data files exist under ${dataRoot} — there is nothing to count`);
  }
  const { computeAllStats } = await load(c.rootDir, 'stats.mjs');
  const stats = computeAllStats(files);
  const sources = stats.metadata?.sources || {};
  const absent = Object.entries(sources).filter(([, present]) => !present).map(([k]) => k);
  return succeed(c.name, stats, absent.map((k) => `no data for ${k} — that section is null, not zero`));
});

commands.upskill = spawned({
  verb: 'upskill',
  description: 'Skill gaps aggregated across scored reports, or against one JD.',
  flags: {
    '--min-reports': { type: 'number', describe: 'Minimum scored reports before a gap map is claimed (default 5)' },
    '--url-text': { type: 'string', describe: 'Targeted analysis against one JD, by URL or path' },
  },
  validate: inRange('--min-reports', 1, 1000),
}, {
  script: 'upskill.mjs',
  // Only aggregate mode reads the tracker; targeted mode reads the URL or path
  // it was given, and the script's own guards cover that.
  preflight: (c) => (c.values['--url-text'] || fileExists(c.p.tracker)
    ? null
    : `no tracker at ${c.p.tracker}`),
  childArgs: (c) => (c.values['--url-text']
    ? ['--url-text', c.values['--url-text']]
    : (c.values['--min-reports'] !== undefined ? ['--min-reports', String(c.values['--min-reports'])] : [])),
});

commands['weekly-digest'] = command({
  verb: 'weekly-digest',
  description: 'Interview sessions and the questions they raised, for a date range.',
  flags: {
    '--from': { type: 'string', describe: 'Start of the window, YYYY-MM-DD' },
    '--to': { type: 'string', describe: 'End of the window, YYYY-MM-DD' },
    '--dir': { type: 'string', describe: 'A different interview-prep/sessions directory' },
  },
  validate: all(isoDate('--from'), isoDate('--to')),
}, async (c) => {
  const sessionsDir = c.values['--dir'] || c.p.sessions;
  if (!dirExists(sessionsDir)) return unverified(c.name, `no sessions directory at ${sessionsDir}`);

  const from = c.values['--from'];
  const to = c.values['--to'];
  // computeWeeklyDigest throws on one bound without the other, and on from>to.
  // Both are things the caller typed, so both are usage errors, not exit 3.
  const { computeWeeklyDigest } = await load(c.rootDir, 'weekly-digest.mjs');
  let result;
  try {
    result = computeWeeklyDigest({ from, to, sessionsDir });
  } catch (err) {
    return usageError(c.name, [{ code: 'invalid-range', message: err.message }], commands['weekly-digest'].help);
  }
  return succeed(c.name, result);
});

export { commands };
export default { noun, commands };
