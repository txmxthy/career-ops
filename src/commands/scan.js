/**
 * src/commands/scan.js — the `scan` noun: nine command adapters over the
 * scanning scripts ADR 0003 assigns to it.
 *
 * Each adapter is a mapping, not an implementation. It declares the flags the
 * verb accepts, parses them with src/core/flags.js, decides whether the check
 * can run at all, hands the work to the delegate, and turns what comes back
 * into the ADR 0006 envelope. There is no scanning logic here and there must
 * never be: every line of it still lives in the delegate.
 *
 * WHY THE DELEGATE IS A CHILD PROCESS
 * ADR 0005 puts command modules at step 4 and the file moves at step 5, so
 * these adapters have to drive the scripts as they stand today. None of the
 * nine exports a runnable entry point — `main()` is private in all of them —
 * and three (`src/scripts/scan-interamt.mjs`, `src/scripts/check-liveness.mjs`, `src/scripts/validate-portals.mjs`)
 * call `main()` at module scope, so importing them starts a browser. Spawning
 * is therefore the only delegation available without editing files this agent
 * does not own. When step 5 lands and the logic is importable and argv-free,
 * `spawnDelegate` is the single function that changes; nothing else here does.
 *
 * WHAT THE ADAPTER ADDS ON TOP OF THE DELEGATE
 *   - `--help` and `--json` on all nine, including the four that had neither.
 *   - Unknown flags become exit 2 instead of exit 1 or silence (ADR 0006).
 *   - A check that could not run becomes exit 3 with a reason, instead of a
 *     clean exit 0 over an empty result. Two of these are behaviour changes
 *     against the delegate and are named at their `preflight`.
 *
 * `run()` neither prints nor exits: it returns `{ exitCode, envelope, text }`
 * and the facade decides what reaches the terminal. In prose mode the child
 * inherits stdio so a twenty-minute sweep still reports progress live, which
 * is why `data.output` is only populated under `--json`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT,
  parseFlags,
  renderHelp,
  envelope,
  errorEnvelope,
  couldNotVerify,
} from '../core/flags.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Longest stderr tail attached to a failure. Enough to name the cause, short
 *  enough that an agent parsing the envelope is not handed a scan log. */
const STDERR_TAIL_LINES = 20;

// ── delegate plumbing ────────────────────────────────────────────────

/**
 * Where the delegate lives. `src/` wins so this keeps working after ADR 0005
 * step 5 moves the unfrozen scripts; root is the fallback for today and for
 * the frozen filenames.
 *
 * @param {string} name - Delegate basename, e.g. 'scan.mjs'.
 * @param {string} root - Repository root.
 * @returns {string} Absolute path, whether or not it exists.
 */
function delegatePath(name, root) {
  const moved = path.join(root, 'src', name);
  return existsSync(moved) ? moved : path.join(root, name);
}

/**
 * Child argv for a parsed flag set.
 *
 * The `--flag=value` form is used throughout: every delegate reads values with
 * a parser that sees it, and it cannot be mistaken for a positional the way a
 * space-separated operand can. A flag definition may override with `emit`, and
 * `local: true` keeps an adapter-only flag out of the child's argv entirely.
 *
 * @param {object} spec - Command spec.
 * @param {object} values - `parseFlags` values.
 * @param {string[]} positionals - `parseFlags` positionals.
 * @returns {string[]}
 */
function childArgv(spec, values, positionals) {
  const out = [];
  for (const [name, def] of Object.entries(spec.flags)) {
    if (def.local) continue;
    const v = values[name];
    if (v === undefined || v === false) continue;
    if (def.emit) { out.push(...def.emit(v)); continue; }
    if (def.type === 'boolean') out.push(name);
    else out.push(`${name}=${v}`);
  }
  out.push(...positionals);
  return out;
}

/**
 * Run the delegate and report how it went, without interpreting the result.
 *
 * @param {string} file - Absolute delegate path.
 * @param {string[]} args - Child argv.
 * @param {{root: string, capture: boolean}} opts
 * @returns {{status: number|null, signal: string|null, error: Error|undefined,
 *   stdout: string, stderr: string}}
 */
function spawnDelegate(file, args, { root, capture }) {
  const res = spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    signal: res.signal,
    error: res.error,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

/** Last few stderr lines, for an error message that names a cause. */
function stderrTail(stderr) {
  const lines = String(stderr).split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-STDERR_TAIL_LINES).join('\n');
}

// ── the one runner every verb shares ─────────────────────────────────

/**
 * Parse, gate, delegate, render.
 *
 * @param {object} spec - Command spec.
 * @param {string[]} argv - argv slice for this verb.
 * @param {{root?: string, entry?: string|null}} [ctx] - `root` overrides the
 *   repository root (tests point it at a sandbox); `entry` overrides the
 *   running script path used by the self-delegation guard.
 * @returns {{exitCode: number, envelope: object, text: string|null}}
 */
function runCommand(spec, argv, ctx = {}) {
  const root = ctx.root || REPO_ROOT;
  const parsed = parseFlags(argv, spec);

  if (!parsed.ok) {
    return {
      exitCode: EXIT.USAGE,
      envelope: errorEnvelope(spec.command, parsed.errors),
      text: `${parsed.errors.map((e) => e.message).join('\n')}\n\n${renderHelp(spec)}`,
    };
  }

  if (parsed.help) {
    const text = renderHelp(spec);
    return { exitCode: EXIT.OK, envelope: envelope(spec.command, { data: { help: text } }), text };
  }

  const { values, positionals, json } = parsed;

  // Adapter-level argument rules — the ones the delegate cannot express
  // because it never sees a parse it could reject.
  const misuse = spec.validate ? spec.validate(values, positionals) : null;
  if (misuse) {
    return {
      exitCode: EXIT.USAGE,
      envelope: errorEnvelope(spec.command, [{ code: 'invalid-arguments', message: misuse }]),
      text: `${misuse}\n\n${renderHelp(spec)}`,
    };
  }

  const file = delegatePath(spec.delegate, root);
  if (!existsSync(file)) {
    return unverified(spec, `${spec.delegate} is not present at ${path.relative(root, file) || file}`);
  }

  // After step 5 the frozen root filenames are shims that call back into this
  // CLI. If the delegate resolves to the file that is running, spawning it is
  // a fork bomb; say so instead.
  const entry = ctx.entry !== undefined ? ctx.entry : (process.argv[1] ? path.resolve(process.argv[1]) : null);
  if (entry && path.resolve(file) === entry) {
    return {
      exitCode: EXIT.CONFIG,
      envelope: errorEnvelope(spec.command, [{
        code: 'self-delegation',
        message: `${spec.delegate} resolves to the running script — the shim and the command point at each other; the implementation belongs under src/`,
      }]),
      text: null,
    };
  }

  // A check that cannot see its input has not run. This is the state ADR 0006
  // reserves exit 3 for, and it is decided before anything is spawned.
  const blocked = spec.preflight ? spec.preflight(values, positionals, root) : null;
  if (blocked) return unverified(spec, blocked);

  const mode = typeof spec.jsonMode === 'function' ? spec.jsonMode(values) : (spec.jsonMode || 'prose');
  const args = childArgv(spec, values, positionals);
  if (json && mode === 'native') args.push('--json');

  const res = spawnDelegate(file, args, { root, capture: json });

  if (res.error) return unverified(spec, `could not start ${spec.delegate}: ${res.error.message}`);
  if (res.signal) return unverified(spec, `${spec.delegate} was killed by ${res.signal} before it finished`);

  if (!json) {
    // stdio was inherited: the delegate has already said everything it has to
    // say, so the envelope carries the verdict and nothing else.
    return fromStatus(spec, res, { delegate: spec.delegate, exitCode: res.status });
  }

  if (mode === 'prose') {
    return fromStatus(spec, res, { delegate: spec.delegate, exitCode: res.status, output: res.stdout });
  }

  // A machine-readable verb that exited cleanly without a machine-readable
  // result has not delivered the check, whatever its exit code said.
  let payload;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    if (res.status === 0) {
      return unverified(spec, `${spec.delegate} exited 0 without a JSON result on stdout`, {
        data: { delegate: spec.delegate, exitCode: res.status, output: res.stdout },
      });
    }
    return fromStatus(spec, res, { delegate: spec.delegate, exitCode: res.status, output: res.stdout });
  }

  const data = { delegate: spec.delegate, exitCode: res.status, result: payload };
  const verdict = spec.classify ? spec.classify(payload) : null;
  if (verdict?.unverified) return unverified(spec, verdict.unverified, { data, warnings: verdict.warnings });
  return fromStatus(spec, res, data, verdict?.warnings);
}

/** The could-not-verify result, exit 3, with a reason that is never optional. */
function unverified(spec, reason, { data = {}, warnings = [] } = {}) {
  return {
    exitCode: EXIT.UNVERIFIED,
    envelope: couldNotVerify(spec.command, reason, { data, warnings }),
    text: null,
  };
}

/**
 * Envelope for a delegate that ran to completion.
 *
 * 0 is success; anything else is a real negative finding (exit 1). The
 * delegates do not distinguish "failed" from "could not run" in their own exit
 * codes, so every case where that distinction is recoverable is handled before
 * this point — by `preflight`, by the signal and spawn-error checks, or by a
 * verb's `classify`.
 */
function fromStatus(spec, res, data, warnings = []) {
  if (res.status === 0) {
    return { exitCode: EXIT.OK, envelope: envelope(spec.command, { data, warnings }), text: null };
  }
  const tail = stderrTail(res.stderr);
  return {
    exitCode: EXIT.FAILED,
    envelope: errorEnvelope(spec.command, [{
      code: 'delegate-failed',
      message: `${spec.delegate} exited ${res.status}${tail ? `: ${tail}` : ''}`,
      exitCode: res.status,
    }], { data, warnings }),
    text: null,
  };
}

// ── flags shared by more than one verb ───────────────────────────────

const DRY_RUN = { type: 'boolean', describe: 'Preview without writing files' };
const INCLUDE_BLACKLISTED = { type: 'boolean', describe: 'Let data/blacklist.md matches through, annotated' };
const SINCE = { type: 'number', describe: 'Only postings from the last <n> days' };

/**
 * `--throttle` is bare-or-`=ms` in the delegates, a shape src/core/flags.js
 * cannot express: a value flag there always requires an operand. Split into a
 * boolean and an explicit `--throttle-ms`, which emits the delegate's own
 * `--throttle=<ms>` spelling. The frozen scripts keep both original forms.
 */
const THROTTLE = { type: 'boolean', describe: 'Jittered ~5-10s gap between checks (stay under rate limits)' };
const THROTTLE_MS = {
  type: 'number',
  describe: 'Custom throttle base in ms; waits base..2*base',
  emit: (n) => [`--throttle=${n}`],
};

/** Portals file a portals verb will read, honouring the delegate's env override. */
const portalsTarget = (values, root) => {
  const given = values['--file'];
  const fallback = process.env.CAREER_OPS_PORTALS || 'portals.yml';
  return path.resolve(root, given || fallback);
};

// ── the nine verbs ───────────────────────────────────────────────────

const SPECS = {
  run: {
    command: 'scan run',
    delegate: 'scan.mjs',
    description: 'Scan every enabled company portal and append new postings to the pipeline.',
    usage: 'career-ops scan run [options]',
    jsonMode: 'prose',
    flags: {
      '--dry-run': DRY_RUN,
      '--verify': { type: 'boolean', describe: 'Playwright-check each new URL; drop expired postings' },
      '--headed-fallback': { type: 'boolean', describe: 'Retry anti-bot-blocked URLs in a headed browser (needs a display)' },
      '--throttle': THROTTLE,
      '--throttle-ms': THROTTLE_MS,
      '--rediscover-404': { type: 'boolean', describe: 'Re-verify tracked URLs that 404/410 (rides on --verify)' },
      '--include-blacklisted': INCLUDE_BLACKLISTED,
      '--company': { type: 'string', describe: 'Scan a single company' },
      '--posted-after': { type: 'string', describe: 'Absolute lower bound on posting date (YYYY-MM-DD)' },
      '--posted-before': { type: 'string', describe: 'Absolute upper bound on posting date (YYYY-MM-DD)' },
      '--since': SINCE,
      '--quiet': { type: 'boolean', describe: 'Suppress the manifesto footer' },
    },
  },

  'ats-full': {
    command: 'scan ats-full',
    delegate: 'scan-ats-full.mjs',
    description: 'Sweep the ATS directories (Greenhouse, Lever, Ashby, Workday, iCIMS) for fresh postings.',
    usage: 'career-ops scan ats-full [options]',
    jsonMode: 'native',
    flags: {
      '--since': { type: 'number', describe: 'Only postings from the last <n> days (default: 3)' },
      '--limit': { type: 'number', describe: 'Max companies per ATS (default: all)' },
      '--ats': { type: 'string', describe: 'Comma-separated subset of sources, e.g. greenhouse,workday' },
      '--seeds': { type: 'string', describe: 'Comma-separated VC portfolio seed sources, e.g. yc,a16z' },
      '--dry-run': DRY_RUN,
      '--liveness': { type: 'boolean', describe: 'Playwright-verify matches before writing' },
      '--verbose': { type: 'boolean', describe: 'Log per-board fetch failures' },
      '--md-out': { type: 'string', describe: 'Also write a dated markdown digest to <dir>' },
      '--include-undated': { type: 'boolean', describe: 'Keep postings with no usable publish date' },
      '--include-blacklisted': INCLUDE_BLACKLISTED,
      '--shuffle': { type: 'boolean', describe: 'Randomise company order within each source' },
      '--resume': { type: 'boolean', describe: 'Continue an interrupted sweep from its checkpoint' },
    },
    // scan-ats-full.mjs already tells a degraded sweep from an empty one; it
    // just does not let the exit code say so. `datasetStatus: 'empty'` means no
    // company list was downloaded and no cache existed — the sweep never ran,
    // and today that is reported as exit 0 with zero postings, which is exactly
    // the "nothing found" ADR 0006 bans.
    classify: (r) => {
      if (r?.datasetStatus === 'empty') {
        return { unverified: 'no ATS company list was reachable and no cache was available — the sweep did not run' };
      }
      const warnings = [];
      if (r?.datasetStatus === 'stale') warnings.push('company list came from an expired cache — results may be incomplete');
      if (r?.stoppedByOutage) warnings.push('sweep stopped early on an outage; a checkpoint is waiting for --resume');
      if (r?.capHit) warnings.push('per-source cap was hit; some companies were not scanned');
      return { warnings };
    },
  },

  hn: {
    command: 'scan hn',
    delegate: 'src/scripts/scan-hn.mjs',
    description: 'Scan the Hacker News "Who is hiring" feed and append matches to the pipeline.',
    usage: 'career-ops scan hn [options]',
    jsonMode: 'prose',
    flags: {},
  },

  interamt: {
    command: 'scan interamt',
    delegate: 'src/scripts/scan-interamt.mjs',
    description: 'Scan Interamt.de (German public sector) via Playwright, driven by interamt_searches in portals.yml.',
    usage: 'career-ops scan interamt [options]',
    jsonMode: 'prose',
    flags: {
      '--dry-run': DRY_RUN,
      '--all': { type: 'boolean', describe: 'Skip the date filter (use for a first scan)' },
      '--keyword': { type: 'string', describe: 'Scan one search term instead of every configured one' },
      '--debug': { type: 'boolean', describe: 'Verbose Playwright progress' },
    },
  },

  extract: {
    command: 'scan extract',
    delegate: 'src/scripts/browser-extract.mjs',
    description: 'Read one page headlessly and return compact JSON — a job description, or a board\'s posting links.',
    usage: 'career-ops scan extract <url> [options]',
    jsonMode: 'stdout-json',
    positionals: { name: 'url', min: 1, max: 1 },
    flags: {
      '--mode': { type: 'string', describe: 'jd (one posting) or listing (a board page); default jd' },
      '--max': { type: 'number', describe: 'Max links to return in listing mode' },
      '--max-chars': { type: 'number', describe: 'Cap on extracted JD text (default 12000)' },
      '--timeout': { type: 'number', describe: 'Navigation timeout in ms (default 15000)' },
    },
  },

  liveness: {
    command: 'scan liveness',
    delegate: 'src/scripts/check-liveness.mjs',
    description: 'Check whether job posting URLs are still live, via the free public API first and Playwright second.',
    usage: 'career-ops scan liveness <url…> | --file <urls.txt>',
    jsonMode: 'prose',
    positionals: { name: 'url', min: 0, max: Infinity },
    flags: {
      // The delegate reads --file positionally (`positional[0] === '--file'`),
      // so this one keeps the space-separated form.
      '--file': { type: 'string', describe: 'Read URLs from a file, one per line (# comments ignored)', emit: (v) => ['--file', v] },
      '--no-fallback': { type: 'boolean', describe: 'Stay headless on an anti-bot challenge (no display available)' },
      '--throttle': THROTTLE,
      '--throttle-ms': THROTTLE_MS,
    },
    validate: (values, positionals) => {
      if (values['--file'] && positionals.length > 0) return '--file and URL arguments are mutually exclusive';
      if (!values['--file'] && positionals.length === 0) return 'expected at least one <url>, or --file <urls.txt>';
      return null;
    },
    preflight: (values, positionals, root) => {
      const file = values['--file'];
      if (file && !existsSync(path.resolve(root, file))) return `URL list not found: ${file}`;
      return null;
    },
  },

  discover: {
    command: 'scan discover',
    delegate: 'src/scripts/discover-ats.mjs',
    description: 'Resolve company names to ATS portal entries. Previews by default; only --write touches portals.yml.',
    usage: 'career-ops scan discover [<company>…] [--in <companies.yml>] [options]',
    // --summary swaps the delegate's JSON for a human table, so --json cannot
    // promise a parsed result alongside it.
    jsonMode: (values) => (values['--summary'] ? 'prose' : 'stdout-json'),
    positionals: { name: 'company', min: 0, max: Infinity },
    flags: {
      '--in': { type: 'string', describe: 'YAML file of company names to resolve' },
      '--vendors': { type: 'string', describe: 'Restrict probes, e.g. gh,ashby,lever or workday' },
      '--write': { type: 'boolean', describe: 'Append resolved entries to portals.yml' },
      '--summary': { type: 'boolean', describe: 'Human-readable table instead of JSON' },
      '--self-test': { type: 'boolean', describe: 'Run the delegate\'s inline test suite' },
    },
    validate: (values, positionals) => {
      if (!values['--in'] && positionals.length === 0 && !values['--self-test']) {
        return 'expected at least one <company>, or --in <companies.yml>';
      }
      return null;
    },
    preflight: (values, positionals, root) => {
      const file = values['--in'];
      if (file && !existsSync(path.resolve(root, file))) return `input file not found: ${file}`;
      return null;
    },
  },

  'validate-portals': {
    command: 'scan validate-portals',
    delegate: 'src/scripts/validate-portals.mjs',
    description: 'Check portals.yml against the schema offline — shape, duplicates, unknown providers. No network.',
    usage: 'career-ops scan validate-portals [--file <portals.yml>]',
    jsonMode: 'prose',
    flags: {
      '--file': { type: 'string', describe: 'Portals file to validate (default: portals.yml)' },
      '--self-test': { type: 'boolean', describe: 'Run the delegate\'s inline test suite' },
    },
    preflight: (values, positionals, root) => {
      if (values['--self-test']) return null;
      const target = portalsTarget(values, root);
      if (!existsSync(target)) return `no portals file at ${target}`;
      return null;
    },
  },

  'verify-portals': {
    command: 'scan verify-portals',
    delegate: 'verify-portals.mjs',
    description: 'Probe every portal in portals.yml over the network and report live / empty / unresolved.',
    usage: 'career-ops scan verify-portals [--file <portals.yml>] [--strict] [--add <company>]',
    jsonMode: 'prose',
    flags: {
      '--file': { type: 'string', describe: 'Portals file to verify (default: portals.yml)' },
      '--strict': { type: 'boolean', describe: 'Exit non-zero when any slug is unresolved' },
      '--add': { type: 'string', describe: 'Probe slug candidates for one company name instead of verifying the file' },
    },
    // Deliberate divergence from the delegate, per ADR 0006's rule that the
    // shim translates where old and new codes conflict: verify-portals.mjs
    // prints "nothing to verify" and exits 0 when portals.yml is absent. A file
    // that is not there is a check that did not run, so the CLI reports 3. The
    // frozen root script and the web route that spawns it are untouched.
    preflight: (values, positionals, root) => {
      if (values['--add']) return null;
      const target = portalsTarget(values, root);
      if (!existsSync(target)) return `no portals file at ${target} — run onboarding first`;
      return null;
    },
  },
};

// ── exports ──────────────────────────────────────────────────────────

/** The noun this module owns; the facade keys its command table by it. */
export const noun = 'scan';

/**
 * `{ <verb>: { run, help, flags, description } }`.
 *
 * `run(argv, ctx)` returns `{ exitCode, envelope, text }` and does not print or
 * exit — printing belongs to the facade. `text` is non-null only when the
 * adapter has something to say the delegate did not already print itself.
 */
export const commands = Object.fromEntries(
  Object.entries(SPECS).map(([verb, spec]) => [verb, {
    description: spec.description,
    flags: spec.flags,
    help: renderHelp(spec),
    run: (argv = [], ctx = {}) => runCommand(spec, argv, ctx),
  }]),
);
