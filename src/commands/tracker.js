/**
 * src/commands/tracker.js — the `career-ops tracker` noun (ADR 0003).
 *
 * Every row ADR 0003 assigns to `tracker` is here, as a thin adapter: parse
 * argv with src/core/flags.js, run the existing implementation, map the result
 * onto the ADR 0006 envelope and exit codes. No business logic lives in this
 * file. If a decision about tracker rows, statuses or report numbers appears
 * below, it is in the wrong place.
 *
 * ## How the adapters reach the logic, and why
 *
 * ADR 0006 wants "importable, argv-free core". Nine of the eleven scripts this
 * noun covers are not that yet, and four of them — dedup-tracker, merge-tracker,
 * set-status, reconcile-pipeline — read `process.argv` and write files at MODULE
 * SCOPE, so importing one runs it. Until ADR 0005 step 5 moves them into `src/`
 * and hollows out their CLIs, the only faithful delegation is a child process:
 * `spawnSync(node, [<script>, ...argv])`. That is the strangler fig's outer
 * layer, not a permanent design. When a script becomes argv-free, its spec's
 * `script`/`argvFor` pair is replaced by a direct call and nothing else in this
 * file moves.
 *
 * `normalize-link` is already argv-free (src/scripts/tracker-links.mjs exports one pure
 * function), so it is called in-process. It is the shape all fifteen end up in.
 *
 * ## What every command returns
 *
 *   { code, envelope, stdout, stderr }
 *
 * `code` is an ADR 0006 exit code. `envelope` is the ADR 0006 result envelope.
 * `stdout`/`stderr` are the human-facing streams. The facade prints
 * `JSON.stringify(envelope)` under `--json` and `stdout`/`stderr` otherwise,
 * then exits `code`. Adapters print nothing themselves, so they stay testable
 * as functions.
 *
 * ## Delegated output is captured, not streamed
 *
 * stdout and stderr are piped rather than inherited, because the exit code and
 * the envelope's `data` are both derived from what the child printed — a
 * verdict cannot be computed from output that went straight to the terminal,
 * and a check whose verdict depends on how it was invoked is the inconsistency
 * ADR 0006 exists to remove. The cost is that a long run (`merge`,
 * `archive-posting` with a browser) shows nothing until it finishes. stdin IS
 * inherited, so `add-entry --stdin` still reads a piped payload.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  EXIT, parseFlags, renderHelp, envelope, errorEnvelope, couldNotVerify,
} from '../core/flags.js';
import {
  resolveTrackerPath, resolvePipelinePath, resolveWorkspaceRoot,
} from '../core/store.js';
// Pure and argv-free already, so it is imported rather than spawned. The four
// module-scope-argv scripts below cannot be imported at all — importing one
// runs it.
import { normalizeReportLink } from '../scripts/tracker-links.mjs';

/** Repo root: src/commands/ -> src/ -> root. The scripts still live there. */
const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

/** Generous enough for merge-tracker's full run; a truncated capture would be
 *  reported as a short one, which is the silence this whole ADR is about. */
const MAX_BUFFER = 64 * 1024 * 1024;

const NOUN = 'tracker';

// ── Preflight: the inputs a command cannot run without ───────────────
//
// src/scripts/dedup-tracker.mjs:268 and src/scripts/normalize-statuses.mjs:113 both print "Nothing to
// dedup/normalize" and exit 0 when the tracker is absent — the exact pattern
// ADR 0006 bans, because a mis-pointed CAREER_OPS_TRACKER is indistinguishable
// from a clean tracker. Checking the input up front turns both into exit 3.

const NEEDS = {
  tracker: (ctx) => ({ label: 'tracker', path: resolveTrackerPath(ctx.rootDir, ctx.env) }),
  pipeline: (ctx) => ({ label: 'pipeline inbox', path: resolvePipelinePath(ctx.rootDir, ctx.env) }),
};

/**
 * Resolve a spec's `requires` into the one input to check, or null.
 *
 * @param {object} spec - Command spec.
 * @param {object} parsed - parseFlags result.
 * @param {{rootDir: string, env: object}} ctx - Execution context.
 * @returns {{label: string, path: string}|null}
 */
function requirement(spec, parsed, ctx) {
  if (!spec.requires) return null;
  if (typeof spec.requires === 'function') return spec.requires(parsed, ctx);
  return NEEDS[spec.requires](ctx);
}

// ── Delegation ──────────────────────────────────────────────────────

/**
 * Run one of the root scripts and return its streams and status.
 *
 * @param {string} script - Script filename, relative to the repo root.
 * @param {string[]} argv - Argument vector for the child.
 * @param {{rootDir: string, env: object}} ctx - Execution context.
 * @returns {{status: number|null, stdout: string, stderr: string, error: Error|undefined}}
 */
function delegate(script, argv, ctx) {
  const res = spawnSync(process.execPath, [join(ctx.rootDir, script), ...argv], {
    cwd: ctx.rootDir,
    env: ctx.env,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

/** JSON on stdout when the child emits it, otherwise null. Adapters render; a
 *  child that speaks JSON should not have it re-wrapped as a string blob. */
function parseChildJson(stdout) {
  const t = stdout.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** The most useful single line to attribute a failure to. */
function firstMessage(stderr, stdout, fallback) {
  for (const stream of [stderr, stdout]) {
    const line = String(stream).split('\n').map((l) => l.trim()).find(Boolean);
    if (line) return line;
  }
  return fallback;
}

/** Default translation: anything non-zero is a real negative finding. Commands
 *  whose script uses a richer scheme override this (see `set-status`). */
const defaultExitMap = (status) => (status === 0 ? EXIT.OK : EXIT.FAILED);

// ── The one execution path every command shares ─────────────────────

/**
 * Parse, preflight, run, render.
 *
 * The order is fixed and matters: flag errors before `--help` (so `--help
 * --bogus` reports the typo), `--help` before preflight (so help works on a
 * machine with no tracker at all), preflight before the run.
 *
 * @param {object} spec - Command spec.
 * @param {string[]} argv - Argument vector, without node and the script.
 * @param {{rootDir?: string, env?: object}} [ctx] - Execution context.
 * @returns {{code: number, envelope: object, stdout: string, stderr: string}}
 */
function execute(spec, argv, ctx = {}) {
  const c = { rootDir: ctx.rootDir || REPO_ROOT, env: ctx.env || process.env };
  const name = spec.command;
  const help = renderHelp(spec);

  const parsed = parseFlags(argv, spec);
  const extra = parsed.ok && !parsed.help && spec.validate ? spec.validate(parsed) : [];
  const usageErrors = [...parsed.errors, ...extra];
  if (usageErrors.length > 0) {
    return {
      code: EXIT.USAGE,
      envelope: errorEnvelope(name, usageErrors),
      stdout: '',
      stderr: `${usageErrors.map((e) => e.message).join('\n')}\n\n${help}\n`,
    };
  }

  if (parsed.help) {
    return {
      code: EXIT.OK,
      envelope: envelope(name, { data: { help } }),
      stdout: `${help}\n`,
      stderr: '',
    };
  }

  let need;
  try {
    need = requirement(spec, parsed, c);
  } catch (err) {
    // A resolver that throws means we cannot even name the input, which is
    // still "could not run" — never a clean result.
    return unverified(name, `could not resolve the input path (${err.message})`);
  }
  if (need && !existsSync(need.path)) {
    return unverified(name, `no ${need.label} at ${need.path}`);
  }

  if (spec.call) return spec.call(parsed, c, { name, need });

  // A missing script is a check that could not run, not one that ran and
  // failed. Without this, node exits 1 on ERR_MODULE_NOT_FOUND and the
  // envelope would report a negative finding for work nothing performed.
  const scriptPath = join(c.rootDir, spec.script);
  if (!existsSync(scriptPath)) return unverified(name, `${spec.script} is not installed at ${scriptPath}`);

  const res = delegate(spec.script, spec.argvFor(parsed), c);
  if (res.error) return unverified(name, `${spec.script} could not be started (${res.error.message})`);
  if (res.status === null) return unverified(name, `${spec.script} was terminated before it finished`);

  const code = (spec.exitMap || defaultExitMap)(res.status, parsed);
  const parsedJson = parseChildJson(res.stdout);
  const data = {
    exitCode: res.status,
    ...(spec.dataFrom ? spec.dataFrom(res, parsedJson) : (parsedJson ? { result: parsedJson } : { stdout: res.stdout })),
  };

  if (code === EXIT.UNVERIFIED) {
    return unverified(name, firstMessage(res.stderr, res.stdout, `${spec.script} could not complete`), {
      data, stdout: res.stdout, stderr: res.stderr,
    });
  }
  if (code === EXIT.OK) {
    return { code, envelope: envelope(name, { data }), stdout: res.stdout, stderr: res.stderr };
  }
  return {
    code,
    envelope: errorEnvelope(name, [{
      code: code === EXIT.USAGE ? 'usage' : 'failed',
      message: firstMessage(res.stderr, res.stdout, `${spec.script} exited ${res.status}`),
    }], { data }),
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

/**
 * The ADR 0006 could-not-run result: exit 3, ok:false, a stated reason.
 *
 * @param {string} name - Command name.
 * @param {string} reason - Why the check could not run.
 * @param {{data?: object, stdout?: string, stderr?: string}} [extra]
 * @returns {{code: number, envelope: object, stdout: string, stderr: string}}
 */
function unverified(name, reason, extra = {}) {
  const env = couldNotVerify(name, reason, { data: extra.data || {} });
  return {
    code: EXIT.UNVERIFIED,
    envelope: env,
    stdout: extra.stdout || '',
    stderr: extra.stderr || `${env.errors[0].message}\n`,
  };
}

/**
 * Turn a spec into the `{ run, help, flags }` shape the facade consumes.
 *
 * @param {object} spec - Command spec.
 * @returns {{run: Function, help: string, flags: object, command: string}}
 */
function command(spec) {
  return {
    command: spec.command,
    flags: spec.flags || {},
    help: renderHelp(spec),
    run: (argv = [], ctx = {}) => execute(spec, argv, ctx),
  };
}

// ── Shared flag definitions ─────────────────────────────────────────

const DRY_RUN = { '--dry-run': { type: 'boolean', describe: 'Resolve and report, but write nothing' } };

/** `--flag` when true, nothing when false. */
const bool = (parsed, flag) => (parsed.values[flag] ? [flag] : []);
/** `--flag value` when supplied, nothing when absent. */
const val = (parsed, flag) => (parsed.values[flag] === undefined ? [] : [flag, String(parsed.values[flag])]);

// ── The commands ────────────────────────────────────────────────────

const specs = {
  // ADR 0003 row: add-entry.mjs. NOTE (reported to the facade owner): this
  // script writes cv.md and article-digest.md, not the tracker — the
  // classifier put it under the wrong noun. Kept here so no row is dropped;
  // it belongs under `cv`.
  'add-entry': {
    command: `${NOUN} add-entry`,
    script: 'src/scripts/add-entry.mjs',
    description: 'Add one CV or article-digest entry from a JSON payload, skipping duplicates.',
    usage: 'career-ops tracker add-entry <payload.json> [--dry-run]\n       career-ops tracker add-entry --stdin [--dry-run]',
    flags: {
      '--stdin': { type: 'boolean', describe: 'Read the JSON payload from stdin instead of a file' },
      ...DRY_RUN,
    },
    positionals: { name: 'payload.json', min: 0, max: 1 },
    validate: (p) => (p.values['--stdin'] || p.positionals.length === 1 ? [] : [{
      code: 'missing-input', message: 'a payload path or --stdin is required',
    }]),
    // The payload file is the input this cannot run without. Missing it is
    // exit 3, not "added nothing".
    requires: (p) => (p.positionals[0] ? { label: 'payload', path: p.positionals[0] } : null),
    argvFor: (p) => [...p.positionals, ...bool(p, '--stdin'), ...bool(p, '--dry-run')],
  },

  // ADR 0003 row: archive-posting.mjs. Same caveat as add-entry — it writes
  // jds/, which is scan/apply territory rather than the tracker's.
  'archive-posting': {
    command: `${NOUN} archive-posting`,
    script: 'src/scripts/archive-posting.mjs',
    description: 'Archive a job posting to jds/, one URL or every pending pipeline entry.',
    usage: 'career-ops tracker archive-posting <url> [--company <c>] [--role <r>] [--report <n>]\n       career-ops tracker archive-posting --pipeline [--dry-run]',
    flags: {
      '--company': { type: 'string', describe: 'Override the company inferred from the posting' },
      '--role': { type: 'string', describe: 'Override the role inferred from the posting' },
      '--report': { type: 'string', describe: 'Prefix the capture with a report number' },
      '--pipeline': { type: 'boolean', describe: 'Archive every pending (- [ ]) URL in the pipeline inbox' },
      ...DRY_RUN,
    },
    positionals: { name: 'url', min: 0, max: 1 },
    validate: (p) => {
      const errs = [];
      if (!p.values['--pipeline'] && p.positionals.length === 0) {
        errs.push({ code: 'missing-input', message: 'a posting URL or --pipeline is required' });
      }
      if (p.values['--pipeline'] && p.values['--report'] !== undefined) {
        errs.push({ code: 'incompatible-flags', message: '--report applies to a single posting; it cannot be combined with --pipeline' });
      }
      return errs;
    },
    requires: (p, ctx) => (p.values['--pipeline'] ? NEEDS.pipeline(ctx) : null),
    argvFor: (p) => [
      ...p.positionals,
      ...val(p, '--company'), ...val(p, '--role'), ...val(p, '--report'),
      ...bool(p, '--pipeline'), ...bool(p, '--dry-run'),
    ],
  },

  // ADR 0003 row: dedup-tracker.mjs. Verb renamed: `tracker dedup-tracker`
  // stutters the noun.
  dedup: {
    command: `${NOUN} dedup`,
    script: 'src/scripts/dedup-tracker.mjs',
    description: 'Collapse duplicate tracker rows, keeping the most advanced status.',
    usage: 'career-ops tracker dedup [--dry-run]',
    flags: { ...DRY_RUN },
    requires: 'tracker',
    argvFor: (p) => bool(p, '--dry-run'),
  },

  // ADR 0003 row: merge-tracker.mjs (frozen filename). Verb renamed for the
  // same reason as dedup.
  merge: {
    command: `${NOUN} merge`,
    script: 'merge-tracker.mjs',
    description: 'Merge queued TSV additions into the tracker, and run the schema migrations.',
    usage: 'career-ops tracker merge [--dry-run] [--verify] [--migrate] [--migrate-via] [--backfill-urls]',
    flags: {
      '--verify': { type: 'boolean', describe: 'Verify the merged tracker without merging anything new' },
      '--migrate': { type: 'boolean', describe: 'Run the tracker schema migration' },
      '--migrate-via': { type: 'boolean', describe: 'Add the Via column to an older tracker' },
      '--backfill-urls': { type: 'boolean', describe: 'Backfill posting URLs onto existing rows' },
      ...DRY_RUN,
    },
    // No `requires`: merge is the writer that creates a first tracker.
    argvFor: (p) => [
      ...bool(p, '--dry-run'), ...bool(p, '--verify'), ...bool(p, '--migrate'),
      ...bool(p, '--migrate-via'), ...bool(p, '--backfill-urls'),
    ],
  },

  // ADR 0003 row: normalize-statuses.mjs.
  'normalize-statuses': {
    command: `${NOUN} normalize-statuses`,
    script: 'src/scripts/normalize-statuses.mjs',
    description: 'Rewrite tracker status cells to the canonical labels in templates/states.yml.',
    usage: 'career-ops tracker normalize-statuses [--dry-run]',
    flags: { ...DRY_RUN },
    requires: 'tracker',
    argvFor: (p) => bool(p, '--dry-run'),
  },

  // ADR 0003 row: reconcile-pipeline.mjs. Verb shortened: the noun already
  // says tracker, and `reconcile` is the verb.
  reconcile: {
    command: `${NOUN} reconcile`,
    script: 'src/scripts/reconcile-pipeline.mjs',
    description: 'Move batch-processed offers from the pipeline inbox\'s Pendientes into Procesadas.',
    usage: 'career-ops tracker reconcile [--dry-run] [--state <path>] [--pipeline <path>]',
    flags: {
      '--state': { type: 'string', describe: 'Batch state TSV (default batch/batch-state.tsv)' },
      '--pipeline': { type: 'string', describe: 'Pipeline inbox to reconcile (default data/pipeline.md)' },
      ...DRY_RUN,
    },
    requires: (p, ctx) => (p.values['--pipeline'] !== undefined
      ? { label: 'pipeline inbox', path: resolve(ctx.rootDir, p.values['--pipeline']) }
      : NEEDS.pipeline(ctx)),
    argvFor: (p) => [...bool(p, '--dry-run'), ...val(p, '--state'), ...val(p, '--pipeline')],
  },

  // ADR 0003 row: reserve-report-num.mjs (frozen filename and stdout).
  'reserve-report-num': {
    command: `${NOUN} reserve-report-num`,
    script: 'reserve-report-num.mjs',
    description: 'Reserve the next report number(s), or release/GC an existing reservation.',
    usage: 'career-ops tracker reserve-report-num [--count <n>]\n       career-ops tracker reserve-report-num --release <NNN[-MMM]>\n       career-ops tracker reserve-report-num --gc',
    flags: {
      '--count': { type: 'number', describe: 'How many consecutive numbers to reserve (default 1)' },
      '--release': { type: 'string', describe: 'Release a reserved number or ascending range' },
      '--gc': { type: 'boolean', describe: 'Drop stale reservation sentinels and exit' },
    },
    validate: (p) => {
      const modes = ['--count', '--release', '--gc'].filter((f) => p.values[f] !== undefined && p.values[f] !== false);
      return modes.length > 1
        ? [{ code: 'incompatible-flags', message: `pick one of ${modes.join(', ')}` }]
        : [];
    },
    argvFor: (p) => {
      if (p.values['--gc']) return ['--gc'];
      if (p.values['--release'] !== undefined) return ['--release', p.values['--release']];
      if (p.values['--count'] !== undefined) return ['--count', String(p.values['--count'])];
      return [];
    },
    // The reserved number is the whole point of the command, so it gets a name
    // in `data` rather than arriving as an unlabelled stdout blob.
    dataFrom: (res) => ({ reserved: res.stdout.trim() || null, stdout: res.stdout }),
  },

  // ADR 0003 row: set-status.mjs (frozen filename, argv and exit codes).
  'set-status': {
    command: `${NOUN} set-status`,
    script: 'set-status.mjs',
    description: 'Move one tracker row to a new lifecycle state, with an optional note.',
    usage: 'career-ops tracker set-status <report#|company> <state> [options]\n       career-ops tracker set-status --row <n> <state> [options]\n       career-ops tracker set-status --report <n> <state> [options]',
    flags: {
      '--row': { type: 'string', describe: 'Select by tracker # explicitly' },
      '--report': { type: 'string', describe: 'Select the row whose Report cell links report #N' },
      '--note': { type: 'string', describe: 'Append to the Notes cell' },
      '--role': { type: 'string', describe: 'Disambiguate when several rows share the company' },
      '--on': { type: 'string', describe: 'Real event date (YYYY-MM-DD) for the status-log entry' },
      '--source': { type: 'string', describe: 'Attribution for the transition ledger: set-status or web' },
      '--force': { type: 'boolean', describe: 'Allow a numeric selector despite a report-link mismatch' },
      ...DRY_RUN,
    },
    positionals: { name: 'selector', min: 1, max: 2 },
    requires: 'tracker',
    // set-status.mjs speaks tracker-utils' CLI_EXIT, which a frozen web
    // consumer pins (public-surface.md §2 row 4). ADR 0006 says the shim keeps
    // those codes and the CLI translates rather than inheriting them.
    //   1 USAGE -> 2   bad flags are a usage error, not a finding
    //   2 NOT_FOUND, 3 AMBIGUOUS -> 1   the check ran and found a real problem
    //   4 LOCK_TIMEOUT -> 3   the write never happened; nothing was verified
    exitMap: (status) => ({ 0: EXIT.OK, 1: EXIT.USAGE, 2: EXIT.FAILED, 3: EXIT.FAILED, 4: EXIT.UNVERIFIED }[status] ?? EXIT.FAILED),
    argvFor: (p) => [
      ...p.positionals,
      ...val(p, '--row'), ...val(p, '--report'), ...val(p, '--note'), ...val(p, '--role'),
      ...val(p, '--on'), ...val(p, '--source'),
      ...bool(p, '--force'), ...bool(p, '--dry-run'),
      // set-status.mjs has its own --json contract; hand it through so the
      // envelope carries the structured result rather than a prose line.
      ...(p.json ? ['--json'] : []),
    ],
  },

  // ADR 0003 row: tracker-links.mjs. It had no CLI at all — `tracker links`
  // named a library. Renamed to the verb it actually performs, and called
  // in-process because the function is already pure and argv-free.
  'normalize-link': {
    command: `${NOUN} normalize-link`,
    description: 'Rewrite report links so their paths are relative to the tracker file.',
    usage: 'career-ops tracker normalize-link "[report 042](reports/042.md)"',
    flags: {},
    positionals: { name: 'report-field', min: 1, max: 1 },
    // The answer depends on where the tracker actually lives. With no tracker
    // there is no relativity to compute, and a confident answer would be a
    // guess presented as a result.
    requires: 'tracker',
    call: (p, ctx, { name, need }) => {
      const trackerDir = dirname(need.path);
      const normalized = normalizeReportLink(p.positionals[0], trackerDir, resolveWorkspaceRoot(need.path));
      return {
        code: EXIT.OK,
        envelope: envelope(name, { data: { input: p.positionals[0], normalized, trackerDir } }),
        stdout: `${normalized}\n`,
        stderr: '',
      };
    },
  },

  // ADR 0003 row: tracker-sync-check.mjs.
  'sync-check': {
    command: `${NOUN} sync-check`,
    script: 'src/scripts/tracker-sync-check.mjs',
    description: 'Compare the tracker against active-interviews.md and report the mismatches.',
    usage: 'career-ops tracker sync-check [--summary] [--apps-file <path>] [--interviews-file <path>]',
    flags: {
      '--summary': { type: 'boolean', describe: 'Human-readable table instead of the raw report' },
      '--apps-file': { type: 'string', describe: 'Tracker to read (default data/applications.md)' },
      '--interviews-file': { type: 'string', describe: 'Interviews file to compare against' },
      '--self-test': { type: 'boolean', describe: 'Run the module\'s own matcher self-test and exit' },
    },
    requires: (p, ctx) => (p.values['--self-test']
      ? null
      : (p.values['--apps-file'] !== undefined
        ? { label: 'tracker', path: resolve(ctx.rootDir, p.values['--apps-file']) }
        : NEEDS.tracker(ctx))),
    argvFor: (p) => [
      ...bool(p, '--summary'), ...bool(p, '--self-test'),
      ...val(p, '--apps-file'), ...val(p, '--interviews-file'),
    ],
    // src/scripts/tracker-sync-check.mjs exits 0 whether or not it found mismatches, so
    // the finding is invisible to a caller reading the status. ADR 0006
    // reserves 1 for exactly this: the check ran and found something.
    exitMap: (status) => (status === 0 ? EXIT.OK : EXIT.FAILED),
    dataFrom: (res, json) => {
      if (!json) return { stdout: res.stdout };
      const s = json.summary || {};
      return { report: json, mismatched: (s.tier1 || 0) + (s.tier2 || 0) };
    },
  },

  // ADR 0003 row: tracker.mjs (frozen filename), whose five subcommands are
  // exposed as five verbs — `tracker run delete --num 3` reads badly and hides
  // four capabilities behind a positional. `sync` is renamed `index`: it
  // rebuilds the derived SQLite index, and `tracker sync` beside `tracker
  // sync-check` named two unrelated things almost identically.
  index: {
    command: `${NOUN} index`,
    script: 'tracker.mjs',
    description: 'Rebuild the derived SQLite index from the tracker markdown.',
    usage: 'career-ops tracker index [--check]',
    flags: { '--check': { type: 'boolean', describe: 'Diagnose only — report issues, write nothing' } },
    requires: 'tracker',
    argvFor: (p) => ['sync', ...bool(p, '--check')],
  },

  query: {
    command: `${NOUN} query`,
    script: 'tracker.mjs',
    description: 'Query tracker rows through the derived index, which resyncs itself when stale.',
    usage: 'career-ops tracker query [--status <s>] [--company <c>] [--role <r>] [--since <date>] [--id <n>] [--limit <n>]',
    flags: {
      '--status': { type: 'string', describe: 'Canonical status (aliases accepted)' },
      '--company': { type: 'string', describe: 'Substring match on the company cell' },
      '--role': { type: 'string', describe: 'Substring match on the role cell' },
      '--since': { type: 'string', describe: 'Only rows dated on or after YYYY-MM-DD' },
      '--id': { type: 'number', describe: 'A single tracker row number' },
      '--limit': { type: 'number', describe: 'Cap the number of rows returned' },
    },
    requires: 'tracker',
    argvFor: (p) => [
      'query',
      ...val(p, '--status'), ...val(p, '--company'), ...val(p, '--role'),
      ...val(p, '--since'), ...val(p, '--id'), ...val(p, '--limit'),
      ...(p.json ? ['--json'] : []),
    ],
  },

  history: {
    command: `${NOUN} history`,
    script: 'tracker.mjs',
    description: 'Status transitions observed for one application across syncs.',
    usage: 'career-ops tracker history --id <n>',
    flags: { '--id': { type: 'number', describe: 'Tracker row number' } },
    validate: (p) => (p.values['--id'] === undefined
      ? [{ code: 'missing-value', flag: '--id', message: '--id requires a value' }]
      : []),
    requires: 'tracker',
    argvFor: (p) => ['history', ...val(p, '--id')],
  },

  export: {
    command: `${NOUN} export`,
    script: 'tracker.mjs',
    description: 'Regenerate canonical tracker markdown from the index — stdout unless --out is given.',
    usage: 'career-ops tracker export [--out <file>]',
    flags: { '--out': { type: 'string', describe: 'Write to this file instead of stdout (backs up any existing copy)' } },
    requires: 'tracker',
    argvFor: (p) => ['export', ...val(p, '--out')],
  },

  delete: {
    command: `${NOUN} delete`,
    script: 'tracker.mjs',
    description: 'Remove one application row from the tracker markdown and reindex.',
    usage: 'career-ops tracker delete --num <n> [--dry-run]',
    flags: {
      '--num': { type: 'number', describe: 'Application number to remove' },
      ...DRY_RUN,
    },
    validate: (p) => (p.values['--num'] === undefined
      ? [{ code: 'missing-value', flag: '--num', message: '--num requires a value' }]
      : []),
    requires: 'tracker',
    argvFor: (p) => ['delete', ...val(p, '--num'), ...bool(p, '--dry-run')],
  },
};

/** The noun this module contributes to the facade. */
export const noun = NOUN;

/** Verb -> { run, help, flags }, per ADR 0006. */
export const commands = Object.fromEntries(
  Object.entries(specs).map(([verb, spec]) => [verb, command(spec)]),
);

export default { noun, commands };
