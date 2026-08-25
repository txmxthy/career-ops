/**
 * system.js — the `career-ops system` noun.
 *
 * ADR 0003 assigns twelve rows to `system`. Eleven ship here as command
 * adapters; the twelfth (`src/scripts/plugin-install.mjs`) is reclassified as a library —
 * see "Reclassified" below.
 *
 * ## What an adapter is allowed to do
 *
 * ADR 0006: "Each command file parses nothing and prints nothing; it maps
 * parsed flags to a core call and a result to a renderer." So every command
 * here is a table row — flag spec, preflight, child argv, exit-code map — fed
 * to one shared executor. There is no branching business logic in this file,
 * and there must not be: if a check's rules need editing, they live in the
 * script the row names, and after ADR 0005 step 5 they live in `src/`.
 *
 * ## Why the executor spawns instead of importing
 *
 * The eleven backing scripts are not yet importable cores. Four of them
 * (`src/scripts/sync-pdf-flags.mjs`, `src/scripts/validate-system-paths-coverage.mjs`, and the two
 * report writers inside `src/scripts/plugins.mjs`) run work and call `process.exit()` at
 * module top level, so importing them executes them. Extracting an argv-free
 * core from each is ADR 0005 step 4 and belongs in `src/core/`, not in an
 * adapter. Until then the process boundary IS the port: the adapter hands the
 * script argv and turns its exit code and stdout into the ADR 0006 envelope.
 * `resolveScript` looks in the repo root and then in `src/`, so the migration
 * that moves these files does not need to touch this table.
 *
 * ## Why the exit-code maps are not pass-throughs
 *
 * ADR 0006 makes 1 ("ran and failed") and 3 ("could not verify") distinct, and
 * the backing scripts predate that. The conflicts, each translated in its row:
 *
 *   - `src/scripts/sync-pdf-flags.mjs` exits 2 for a missing tracker and 4 for a lock
 *     timeout. Neither is a finding; both become 3.
 *   - `src/scripts/fix-slugs.mjs` exits 0 and prints "nothing to fix" when portals.yml is
 *     absent — a check that never ran, reported as a clean pass. Preflight
 *     turns that into 3.
 *   - `src/scripts/check-table-freshness.mjs` reports `tablesScanned: 0` at exit 0 when
 *     `templates/` is missing. Same shape, same fix.
 *   - `src/scripts/plugin-audit.mjs` exits 2 both for a usage error and for "audit
 *     failed" — the second is 3; the first never reaches the child, because
 *     flags are parsed here first and a usage error is 2 without spawning.
 *   - Anything whose stderr names an unreachable network or a timeout is 3,
 *     never 1. That is the whole point of the code.
 *
 * ## Verb renames (ADR 0003: "a starting point, not a finished API")
 *
 *   - `update-system`                    → `update`
 *   - `validate-system-paths-coverage`   → `validate-path-coverage`
 *   - `validate-untrusted-content-coverage` → `validate-untrusted-coverage`
 *
 * Each dropped a word the noun already says. `career-ops system update-system`
 * and `career-ops system validate-system-paths-coverage` both stutter, and the
 * second is 38 characters of which `system` is a repeat.
 *
 * ## Reclassified
 *
 * `src/scripts/plugin-install.mjs` has no CLI: no `main`, no `import.meta.url` guard, six
 * exports and one consumer (`src/scripts/plugins.mjs`). ADR 0003's classifier gave it a
 * command slot by prefix; ADR 0002's rule ("a module with one consumer stays
 * inline") and the file's own header ("Imported by src/scripts/plugins.mjs") both say
 * library. Giving it a CLI would also mint a second install path that skips
 * the consent card and lock entry `plugins add` writes — a security
 * regression, not a missing feature. Its capabilities stay reachable through
 * `system plugins add` and `system validate-plugin-registry --deep`.
 *
 * ## Twelve rows, not eleven
 *
 * `system prune` (ADR 0001, part 2 of the updater fork) is the twelfth. It is
 * the only row whose backing verb this fork wrote rather than inherited:
 * `update-system.mjs prune` removes the root scripts an update put back.
 *
 * ## Contract with the facade
 *
 * Every `run(argv, ctx)` resolves to `{ exitCode, envelope, text, json }` and
 * prints nothing. The facade prints `JSON.stringify(envelope)` when `json` is
 * true and `text` otherwise, then exits `exitCode`. `ctx` is optional:
 * `{ root, exec, env }` — `root` overrides the repo root, `exec` replaces the
 * child-process executor (tests use it to run no children at all), and `env`
 * is what path resolution reads `CAREER_OPS_TRACKER` from.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT,
  parseFlags,
  renderHelp,
  envelope,
  errorEnvelope,
  couldNotVerify,
} from '../core/flags.js';
import { resolveTrackerPath } from '../core/store.js';

/** src/commands/system.js → src/commands → src → repo root. */
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * stderr that means "the check could not run", not "the check found a
 * problem". Kept narrow and in one place: every row that can touch the network
 * or a clock consults it, and nothing else classifies by message text.
 */
const UNREACHABLE_RE =
  /(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|LOCK_TIMEOUT|could not resolve host|network is unreachable|unable to access|timed out)/i;

/**
 * Locate a backing script, tolerating ADR 0005 step 5 moving it into `src/`.
 *
 * @param {string} root - Repo root.
 * @param {string} name - Script filename, e.g. 'doctor.mjs'.
 * @returns {string|null} Absolute path, or null when it is on neither path.
 */
function resolveScript(root, name) {
  for (const candidate of [join(root, name), join(root, 'src', name)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run a script as a child of this node, capturing everything.
 *
 * Never rejects: a spawn failure and a non-zero exit are both results, because
 * the difference between them is exactly the difference between exit 3 and
 * exit 1, and a thrown error erases it.
 *
 * @param {string} script - Absolute path to the script.
 * @param {string[]} argv - Arguments after the script.
 * @param {{cwd: string, timeoutMs: number}} opts
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, failure?: string}>}
 */
function execNode(script, argv, { cwd, timeoutMs }) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [script, ...argv],
      { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '');
        const errOut = String(stderr ?? '');
        if (!err) return done({ code: 0, stdout: out, stderr: errOut });
        if (err.killed || err.signal) {
          return done({
            code: null,
            stdout: out,
            stderr: errOut,
            failure: `${script} did not finish within ${timeoutMs}ms`,
          });
        }
        if (typeof err.code === 'number') return done({ code: err.code, stdout: out, stderr: errOut });
        // A string code (ENOENT, EACCES) is node failing to start the child.
        return done({ code: null, stdout: out, stderr: errOut, failure: err.message });
      },
    );
  });
}

/** First non-blank line of the child's output, for a one-line error message. */
function firstLine(...streams) {
  for (const stream of streams) {
    for (const line of String(stream ?? '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

/** Non-empty stderr lines, kept as envelope warnings on an otherwise-ok run. */
function warningsFrom(stderr) {
  return String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Parse a child's JSON stdout.
 *
 * @param {string} stdout
 * @returns {{ok: true, value: object}|{ok: false, reason: string}}
 */
function parseJsonStdout(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return { ok: false, reason: 'it produced no output to read' };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object') {
      return { ok: false, reason: 'its output was not a JSON object' };
    }
    return { ok: true, value: Array.isArray(value) ? { items: value } : value };
  } catch (err) {
    return { ok: false, reason: `its output was not valid JSON (${err.message})` };
  }
}

/**
 * Turn one row of the table below into a `{ run, help, flags }` command.
 *
 * Row shape:
 *   command      - envelope name, e.g. 'system doctor'
 *   script       - backing filename, resolved against root then src/
 *   description  - one line for --help
 *   flags        - src/core/flags.js flag spec
 *   positionals  - src/core/flags.js positional spec (omit to reject any)
 *   timeoutMs    - number, or (parsed) => number
 *   validate     - (parsed) => error[]|null, for usage rules flags.js cannot
 *                  express (a closed set of subcommands)
 *   preflight    - (parsed, root, env) => reason|null; a reason is exit 3, and
 *                  child is never spawned
 *   childArgv    - (parsed) => string[]
 *   expectJson   - (parsed) => boolean; when true, stdout must parse or the
 *                  result is exit 3
 *   mapExit      - ({code, stdout, stderr, data, parsed}) => exit code
 *   enrich       - optional async ({parsed, run, childArgv}) => {data?, warnings?}
 *
 * @param {object} spec
 * @returns {{run: Function, help: Function, flags: object}}
 */
function makeCommand(spec) {
  const helpSpec = {
    command: `career-ops ${spec.command}`,
    description: spec.description,
    flags: spec.flags || {},
    positionals: spec.positionals,
  };

  const help = () => renderHelp(helpSpec);

  async function run(argv = [], ctx = {}) {
    const root = ctx.root ? resolve(ctx.root) : REPO_ROOT;
    const exec = ctx.exec || execNode;
    const env = ctx.env || process.env;
    const name = spec.command;

    const parsed = parseFlags(argv, {
      command: name,
      flags: spec.flags || {},
      positionals: spec.positionals,
    });

    if (!parsed.ok) {
      return {
        exitCode: EXIT.USAGE,
        envelope: errorEnvelope(name, parsed.errors),
        text: `${parsed.errors.map((e) => e.message).join('\n')}\n\n${help()}`,
        json: parsed.json,
      };
    }

    if (parsed.help) {
      const text = help();
      return { exitCode: EXIT.OK, envelope: envelope(name, { data: { help: text } }), text, json: parsed.json };
    }

    const usageErrors = spec.validate ? spec.validate(parsed) : null;
    if (usageErrors && usageErrors.length > 0) {
      return {
        exitCode: EXIT.USAGE,
        envelope: errorEnvelope(name, usageErrors),
        text: `${usageErrors.map((e) => e.message).join('\n')}\n\n${help()}`,
        json: parsed.json,
      };
    }

    const unverified = (reason, data = {}) => ({
      exitCode: EXIT.UNVERIFIED,
      envelope: couldNotVerify(name, reason, { data }),
      text: `${name}: could not verify — ${reason}`,
      json: parsed.json,
    });

    const blocked = spec.preflight ? spec.preflight(parsed, root, env) : null;
    if (blocked) return unverified(blocked);

    const script = resolveScript(root, spec.script);
    if (!script) return unverified(`${spec.script} is not in ${root} or ${join(root, 'src')}`);

    const timeoutMs =
      typeof spec.timeoutMs === 'function' ? spec.timeoutMs(parsed) : spec.timeoutMs || DEFAULT_TIMEOUT_MS;
    const runScript = (childArgv, opts = {}) =>
      exec(script, childArgv, { cwd: root, timeoutMs, ...opts });

    const childArgv = spec.childArgv ? spec.childArgv(parsed) : [];
    const result = await runScript(childArgv);

    if (result.failure) return unverified(result.failure, { output: result.stdout.trim() });
    if (result.code === null) return unverified(`${spec.script} exited without a status`, {});

    let data;
    if (spec.expectJson && spec.expectJson(parsed)) {
      const json = parseJsonStdout(result.stdout);
      if (!json.ok) return unverified(`${spec.script} ran but ${json.reason}`, { stderr: result.stderr.trim() });
      data = json.value;
    } else {
      data = { output: result.stdout.trim() };
    }

    let warnings = warningsFrom(result.stderr);

    if (spec.enrich) {
      const extra = await spec.enrich({ parsed, run: runScript, childArgv });
      if (extra?.data) data = { ...data, ...extra.data };
      if (extra?.warnings) warnings = [...warnings, ...extra.warnings];
    }

    const exitCode = spec.mapExit({ code: result.code, stdout: result.stdout, stderr: result.stderr, data, parsed });

    if (exitCode === EXIT.OK) {
      return {
        exitCode,
        envelope: envelope(name, { data, warnings }),
        text: result.stdout.trim() || `${name}: ok`,
        json: parsed.json,
      };
    }

    if (exitCode === EXIT.UNVERIFIED) {
      const reason = firstLine(result.stderr, result.stdout) || `${spec.script} exited ${result.code}`;
      return {
        exitCode,
        envelope: couldNotVerify(name, reason, { data, warnings }),
        text: `${name}: could not verify — ${reason}`,
        json: parsed.json,
      };
    }

    const code = exitCode === EXIT.CONFIG ? 'environment' : exitCode === EXIT.USAGE ? 'usage' : 'check-failed';
    const message = firstLine(result.stderr, result.stdout) || `${spec.script} exited ${result.code}`;
    return {
      exitCode,
      envelope: errorEnvelope(name, [{ code, message }], { data, warnings }),
      text: `${result.stdout.trim()}\n${result.stderr.trim()}`.trim() || message,
      json: parsed.json,
    };
  }

  return { run, help, flags: spec.flags || {} };
}

// ── shared row fragments ────────────────────────────────────────────

/** Non-zero means "ran and failed", unless the message says it never ran. */
const failedUnlessUnreachable = ({ code, stdout, stderr }) => {
  if (code === 0) return EXIT.OK;
  return UNREACHABLE_RE.test(`${stderr}\n${stdout}`) ? EXIT.UNVERIFIED : EXIT.FAILED;
};

const requireFile = (relative, describe) => (parsed, root) =>
  existsSync(join(root, relative)) ? null : `${describe} — ${join(root, relative)} does not exist`;

// ── the table ───────────────────────────────────────────────────────

/**
 * `system doctor` — the environment diagnostic.
 *
 * `doctor.mjs --json` is a different report from `doctor.mjs`: the first is the
 * onboarding state the web app reads (frozen, public-surface.md §2 row 5), the
 * second is the check run whose exit code is the verdict. Reporting the first
 * as if it were the second would let a missing prerequisite pass at exit 0, so
 * the diagnostic always runs and `--json` adds the state alongside it under
 * `data.onboarding` rather than replacing it.
 */
const doctor = makeCommand({
  command: 'system doctor',
  script: 'doctor.mjs',
  description: 'Check that this machine can run career-ops: node, deps, fonts, data dirs, plugins.',
  flags: {
    '--strict': { type: 'boolean', describe: 'Also probe portals.yml ATS slugs over the network' },
    '--target': { type: 'string', describe: 'Diagnose a different checkout' },
    '--cli': { type: 'string', describe: 'Assume a specific agent CLI (claude, gemini, opencode)' },
  },
  timeoutMs: (parsed) => (parsed.values['--strict'] ? 300_000 : DEFAULT_TIMEOUT_MS),
  childArgv: (parsed) => {
    const argv = [];
    if (parsed.values['--strict']) argv.push('--strict');
    if (parsed.values['--target']) argv.push('--target', parsed.values['--target']);
    if (parsed.values['--cli']) argv.push('--cli', parsed.values['--cli']);
    return argv;
  },
  expectJson: () => false,
  enrich: async ({ parsed, run, childArgv }) => {
    if (!parsed.json) return null;
    // Same argv, so --target/--cli describe the same checkout the diagnostic ran on.
    const res = await run([...childArgv.filter((a) => a !== '--strict'), '--json'], { timeoutMs: 60_000 });
    if (res.failure || res.code !== 0) {
      return { warnings: [`doctor --json state unavailable: ${res.failure || firstLine(res.stderr) || `exit ${res.code}`}`] };
    }
    const json = parseJsonStdout(res.stdout);
    return json.ok
      ? { data: { onboarding: json.value } }
      : { warnings: [`doctor --json ran but ${json.reason}`] };
  },
  mapExit: failedUnlessUnreachable,
});

/**
 * `system update` — renamed from `update-system`; the noun already says system.
 *
 * The subcommand set is closed and validated here, so the child's exit 1 always
 * means a real abort rather than the usage message it prints for a typo.
 */
const UPDATE_ACTIONS = ['check', 'apply', 'rollback', 'dismiss'];
const update = makeCommand({
  command: 'system update',
  script: 'update-system.mjs',
  description: `Self-update against upstream. Actions: ${UPDATE_ACTIONS.join(', ')} (default: check).`,
  flags: {
    '--force': { type: 'boolean', describe: 'apply: proceed despite local modifications to system files' },
  },
  positionals: { name: 'action', min: 0, max: 1 },
  validate: (parsed) => {
    const action = parsed.positionals[0];
    if (action === undefined || UPDATE_ACTIONS.includes(action)) return null;
    return [{
      code: 'unknown-action',
      message: `unknown action: ${action}. Valid actions: ${UPDATE_ACTIONS.join(', ')}`,
    }];
  },
  timeoutMs: (parsed) => (parsed.positionals[0] === 'apply' ? 600_000 : 180_000),
  childArgv: (parsed) => {
    const argv = [parsed.positionals[0] || 'check'];
    if (parsed.values['--force']) argv.push('--force');
    return argv;
  },
  expectJson: () => false,
  mapExit: failedUnlessUnreachable,
});

/**
 * `system check-table-freshness` — jurisdiction tables past their review date.
 *
 * The script emits JSON by default and prose under `--summary`, which is the
 * inverse of the CLI contract, so the flag is set from `--json` rather than
 * exposed. A missing `templates/` makes it report zero tables scanned at exit
 * 0; preflight turns that into "could not verify".
 */
const checkTableFreshness = makeCommand({
  command: 'system check-table-freshness',
  script: 'src/scripts/check-table-freshness.mjs',
  description: 'Report jurisdiction tables in templates/ that are past their review date.',
  flags: {
    '--max-age-months': { type: 'number', describe: 'Review-due threshold in whole months (default: 12)' },
    '--today': { type: 'string', describe: 'Evaluate as of a fixed YYYY-MM-DD, for deterministic runs' },
    '--self-test': { type: 'boolean', describe: 'Run the script’s inline self-test instead of a scan' },
  },
  validate: (parsed) => {
    // The script exits 1 for both of these, which would report a typo as a
    // finding. Checking the shape here keeps a usage error at exit 2.
    const errors = [];
    const today = parsed.values['--today'];
    if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      errors.push({ code: 'invalid-value', flag: '--today', message: `--today expects YYYY-MM-DD, got "${today}"` });
    }
    const months = parsed.values['--max-age-months'];
    if (months !== undefined && !(Number.isInteger(months) && months > 0)) {
      errors.push({ code: 'invalid-value', flag: '--max-age-months', message: `--max-age-months expects a positive whole number of months, got ${months}` });
    }
    return errors;
  },
  preflight: (parsed, root) =>
    parsed.values['--self-test']
      ? null
      : requireFile('templates', 'there are no jurisdiction tables to scan')(parsed, root),
  childArgv: (parsed) => {
    if (parsed.values['--self-test']) return ['--self-test'];
    const argv = parsed.json ? [] : ['--summary'];
    if (parsed.values['--max-age-months'] !== undefined) {
      argv.push('--max-age-months', String(parsed.values['--max-age-months']));
    }
    if (parsed.values['--today']) argv.push('--today', parsed.values['--today']);
    return argv;
  },
  expectJson: (parsed) => parsed.json && !parsed.values['--self-test'],
  mapExit: ({ code }) => (code === 0 ? EXIT.OK : EXIT.FAILED),
});

/**
 * `system fix-slugs` — repair ATS slugs in portals.yml.
 *
 * Read-only by default; `--fix` writes. The script prints "no portals file …
 * nothing to fix" and exits 0 when the file is absent, which is a check that
 * never ran reported as a clean pass — preflight makes it exit 3 instead.
 */
const fixSlugs = makeCommand({
  command: 'system fix-slugs',
  script: 'src/scripts/fix-slugs.mjs',
  description: 'Verify portals.yml against live ATS boards and repair resolvable slugs. Read-only unless --fix.',
  flags: {
    '--file': { type: 'string', describe: 'Portals file to check (default: portals.yml)' },
    '--fix': { type: 'boolean', describe: 'Write the repairs instead of listing them' },
  },
  preflight: (parsed, root) => {
    const file = parsed.values['--file'] || 'portals.yml';
    const path = isAbsolute(file) ? file : join(root, file);
    return existsSync(path) ? null : `there is no portals file at ${path} — nothing was checked`;
  },
  timeoutMs: 300_000,
  childArgv: (parsed) => {
    const argv = [];
    if (parsed.values['--file']) argv.push('--file', parsed.values['--file']);
    if (parsed.values['--fix']) argv.push('--fix');
    return argv;
  },
  expectJson: () => false,
  mapExit: failedUnlessUnreachable,
});

/**
 * `system generate-latex` — validate and compile a .tex file.
 *
 * A missing LaTeX engine is exit 4 (environment), not 1: nothing about the
 * document was assessed. The script folds both into 1, so this row reads the
 * JSON report it always prints rather than its status.
 */
const generateLatex = makeCommand({
  command: 'system generate-latex',
  script: 'src/scripts/generate-latex.mjs',
  description: 'Validate a .tex file and compile it to PDF with tectonic or pdflatex.',
  flags: {
    '--compile-only': { type: 'boolean', describe: 'Skip content validation and compile as-is' },
  },
  positionals: { name: 'input.tex [output.pdf]', min: 1, max: 2 },
  preflight: (parsed, root) => {
    const input = parsed.positionals[0];
    const path = isAbsolute(input) ? input : join(root, input);
    return existsSync(path) ? null : `there is no file at ${path} — nothing was compiled`;
  },
  timeoutMs: 300_000,
  childArgv: (parsed) => {
    const argv = [...parsed.positionals];
    if (parsed.values['--compile-only']) argv.push('--compile-only');
    return argv;
  },
  expectJson: () => true,
  mapExit: ({ code, data }) => {
    if (code === 0) return EXIT.OK;
    if (typeof data?.compileError === 'string' && /no latex engine found/i.test(data.compileError)) {
      return EXIT.CONFIG;
    }
    return EXIT.FAILED;
  },
});

/**
 * `system plugin-audit` — static safety audit of one plugin directory.
 *
 * The script uses exit 2 for both a usage error and an audit that threw. Flags
 * are parsed here, so a usage error never reaches it; its 2 is always the
 * second case, which is exit 3.
 */
const pluginAudit = makeCommand({
  command: 'system plugin-audit',
  script: 'src/scripts/plugin-audit.mjs',
  description: 'Statically audit a plugin directory for egress, eval and manifest violations.',
  positionals: { name: 'dir', min: 1, max: 1 },
  preflight: (parsed, root) => {
    const dir = parsed.positionals[0];
    const path = isAbsolute(dir) ? dir : join(root, dir);
    return existsSync(path) ? null : `there is no plugin directory at ${path} — nothing was audited`;
  },
  childArgv: (parsed) => [parsed.positionals[0]],
  expectJson: () => false,
  mapExit: ({ code }) => (code === 0 ? EXIT.OK : code === 2 ? EXIT.UNVERIFIED : EXIT.FAILED),
});

/**
 * `system plugins` — the plugin lifecycle.
 *
 * `data.output` carries prose rather than structure: `src/scripts/plugins.mjs` renders
 * every action to the terminal and exposes no JSON. Wrapping that prose is the
 * honest representation until its listing moves into `src/core/`; inventing
 * fields by scraping the output would be business logic in an adapter and
 * would silently drift from what the script prints.
 */
const PLUGIN_ACTIONS = ['list', 'available', 'run', 'skill', 'new', 'add', 'enable', 'trust', 'remove'];
const plugins = makeCommand({
  command: 'system plugins',
  script: 'src/scripts/plugins.mjs',
  description: `Manage plugins. Actions: ${PLUGIN_ACTIONS.join(', ')} (default: list). Use -- before a payload containing flags.`,
  flags: {
    '--dry-run': { type: 'boolean', describe: 'run: show what the hook would do without doing it' },
    '--confirm': { type: 'boolean', describe: 'add/enable: grant the capabilities shown on the consent card' },
    '--sha': { type: 'string', describe: 'add: the 40-hex commit to pin an unregistered repo to' },
  },
  positionals: { name: 'action [args…]', min: 0 },
  validate: (parsed) => {
    const action = parsed.positionals[0];
    if (action === undefined || PLUGIN_ACTIONS.includes(action)) return null;
    return [{
      code: 'unknown-action',
      message: `unknown action: ${action}. Valid actions: ${PLUGIN_ACTIONS.join(', ')}`,
    }];
  },
  timeoutMs: 300_000,
  childArgv: (parsed) => {
    const argv = [...parsed.positionals];
    if (parsed.values['--sha']) argv.push('--sha', parsed.values['--sha']);
    if (parsed.values['--confirm']) argv.push('--confirm');
    if (parsed.values['--dry-run']) argv.push('--dry-run');
    return argv;
  },
  expectJson: () => false,
  mapExit: failedUnlessUnreachable,
});

/**
 * `system sync-pdf-flags` — reconcile the tracker PDF column against
 * data/pdf-index.tsv.
 *
 * Every non-zero exit this script produces is a could-not-complete, not a
 * finding: 2 is a missing tracker, 4 is a lock timeout, 1 is a lock, read or
 * write failure. All three become 3. Its `--json` mode prints `{error, code}`
 * to stdout on those paths, so the parsed body is checked too.
 *
 * Noun note: this writes tracker rows, so `career-ops tracker sync-pdf-flags`
 * would read better. ADR 0003 files it under `system` and the tracker noun is
 * another agent's file, so it stays here and the mismatch is recorded.
 */
const syncPdfFlags = makeCommand({
  command: 'system sync-pdf-flags',
  script: 'src/scripts/sync-pdf-flags.mjs',
  description: 'Upgrade tracker PDF cells to ✅ for every report present in the PDF manifest.',
  flags: {
    '--dry-run': { type: 'boolean', describe: 'List the rows that would change without writing' },
  },
  preflight: (parsed, root, env) => {
    const tracker = resolveTrackerPath(root, env);
    return existsSync(tracker) ? null : `there is no tracker at ${tracker} — no rows were read`;
  },
  childArgv: (parsed) => {
    const argv = [];
    if (parsed.json) argv.push('--json');
    if (parsed.values['--dry-run']) argv.push('--dry-run');
    return argv;
  },
  expectJson: (parsed) => parsed.json,
  mapExit: ({ code, data }) => {
    if (code !== 0) return EXIT.UNVERIFIED;
    // --json reports a lock or read failure in the body at exit 0 on some paths.
    return typeof data?.error === 'string' ? EXIT.UNVERIFIED : EXIT.OK;
  },
});

/** `system validate-plugin-registry` — shape gate for the curated registry. */
const validatePluginRegistry = makeCommand({
  command: 'system validate-plugin-registry',
  script: 'src/scripts/validate-plugin-registry.mjs',
  description: 'Check the plugin registry’s shape and uniqueness. --deep also clones each pinned entry.',
  flags: {
    '--deep': { type: 'boolean', describe: 'Clone every entry at its pinned SHA and audit it (network)' },
  },
  preflight: (parsed, root) => {
    if (existsSync(join(root, 'plugins-registry'))) return null;
    if (existsSync(join(root, 'plugins-registry.json'))) return null;
    return `there is no registry at ${join(root, 'plugins-registry')} — no entries were checked`;
  },
  timeoutMs: (parsed) => (parsed.values['--deep'] ? 600_000 : DEFAULT_TIMEOUT_MS),
  childArgv: (parsed) => (parsed.values['--deep'] ? ['--deep'] : []),
  expectJson: () => false,
  mapExit: failedUnlessUnreachable,
});

/**
 * `system validate-path-coverage` — renamed from `validate-system-paths-coverage`.
 *
 * Every tracked file must be covered by SYSTEM_PATHS or USER_PATHS; anything
 * else is invisible to the updater. It shells out to `git ls-files` and parses
 * `update-system.mjs`, so both are preflighted: without either it reports
 * nothing, and "nothing" would read as "no orphans".
 */
const validatePathCoverage = makeCommand({
  command: 'system validate-path-coverage',
  script: 'src/scripts/validate-system-paths-coverage.mjs',
  description: 'Find tracked files covered by neither SYSTEM_PATHS nor USER_PATHS — the updater would not ship them.',
  preflight: (parsed, root) => {
    if (!existsSync(join(root, '.git'))) return `${root} is not a git checkout — the tracked-file list is unavailable`;
    return resolveScript(root, 'update-system.mjs')
      ? null
      : `update-system.mjs is not in ${root} — the path manifests cannot be read`;
  },
  childArgv: () => [],
  expectJson: () => false,
  mapExit: ({ code, stderr }) => {
    if (code === 0) return EXIT.OK;
    // The script's own could-not-run messages, all sharing its exit 1.
    if (/FAIL: (update-system\.mjs not found|SYSTEM_PATHS or USER_PATHS not found)/.test(stderr)) {
      return EXIT.UNVERIFIED;
    }
    return failedUnlessUnreachable({ code, stdout: '', stderr });
  },
});

/**
 * `system validate-untrusted-coverage` — renamed from
 * `validate-untrusted-content-coverage`; "untrusted" is unambiguous here.
 *
 * Every mode that ingests external text must reference the untrusted-content
 * directive. The marker is canonical in AGENTS.md, so without AGENTS.md there
 * is nothing to compare against and the answer is 3, not "all clear".
 */
const validateUntrustedCoverage = makeCommand({
  command: 'system validate-untrusted-coverage',
  script: 'src/scripts/validate-untrusted-content-coverage.mjs',
  description: 'Check that every mode ingesting external text references the untrusted-content directive.',
  flags: {
    '--self-test': { type: 'boolean', describe: 'Run the script’s inline self-test instead of a scan' },
  },
  preflight: (parsed, root) =>
    requireFile('AGENTS.md', 'the canonical directive is unavailable')(parsed, root),
  childArgv: (parsed) => (parsed.values['--self-test'] ? ['--self-test'] : []),
  expectJson: () => false,
  mapExit: ({ code }) => (code === 0 ? EXIT.OK : EXIT.FAILED),
});

/**
 * `system prune` — ADR 0001 part 2 of the updater fork.
 *
 * `update-system.mjs apply` subtracts REMOVED_PATHS from its checkout set, but
 * only the copy of the updater that actually runs the update binds that: the
 * re-exec stage checks the target updater out of FETCH_HEAD and runs THAT, so
 * on a fork an update normally executes upstream's merge logic, which restores
 * every root script ADR 0001 moved into src/. This verb is the repair.
 *
 * Its 3 is load-bearing. `update-system.mjs prune` exits 3 when REMOVED_PATHS
 * is empty or contradicts SYSTEM_PATHS, because a copy of the updater that
 * does not know what was removed cannot report "nothing to prune" — that is
 * the same output a clean install gives, and the two mean opposite things.
 */
const prune = makeCommand({
  command: 'system prune',
  script: 'update-system.mjs',
  description: 'Remove root scripts this fork moved out of the root that an update put back.',
  flags: {
    '--dry-run': { type: 'boolean', describe: 'List what would be removed without deleting anything' },
  },
  timeoutMs: 60_000,
  childArgv: (parsed) => {
    const argv = ['prune'];
    if (parsed.values['--dry-run']) argv.push('--dry-run');
    if (parsed.json) argv.push('--json');
    return argv;
  },
  expectJson: (parsed) => parsed.json,
  mapExit: ({ code }) => {
    if (code === 0) return EXIT.OK;
    return code === EXIT.UNVERIFIED ? EXIT.UNVERIFIED : EXIT.FAILED;
  },
});

export const noun = 'system';

export const commands = {
  'doctor': doctor,
  'update': update,
  'prune': prune,
  'check-table-freshness': checkTableFreshness,
  'fix-slugs': fixSlugs,
  'generate-latex': generateLatex,
  'plugin-audit': pluginAudit,
  'plugins': plugins,
  'sync-pdf-flags': syncPdfFlags,
  'validate-plugin-registry': validatePluginRegistry,
  'validate-path-coverage': validatePathCoverage,
  'validate-untrusted-coverage': validateUntrustedCoverage,
};

export default { noun, commands };
