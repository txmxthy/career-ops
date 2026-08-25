/**
 * render.js — the `career-ops render` commands.
 *
 * ADR 0003 assigns four rows to this noun. Three of the four verbs are renamed
 * here, which that ADR explicitly invites ("a name that reads badly in --help
 * should be changed during execution, in this ADR, not silently"):
 *
 *   render generate-pdf    → render pdf         — "render generate" is a stutter
 *   render img-to-pdf      → render image       — "-to-pdf" is the noun's job
 *   render build-dashboard → render dashboard   — "render build" is a stutter
 *   render mark-pdf-ready  → render mark-ready  — "pdf" is already implied
 *
 * Every command carries `aliases` with its taxonomy spelling, so the facade can
 * keep the ADR names working without a second entry in `career-ops --help`.
 *
 * These are adapters and nothing else: they map parsed flags to a call, and a
 * result to the ADR 0006 envelope. Where the logic still lives in a frozen root
 * script whose entrypoint reads `process.argv` and exits — generate-pdf.mjs,
 * mark-pdf-ready.mjs, build-dashboard.mjs — the adapter DELEGATES to that
 * script rather than re-implementing it. That is ADR 0006's "exactly one code
 * path per capability and two ways to invoke it", held even while the code path
 * is still a root script. Those three become direct imports when ADR 0005 step 5
 * moves the logic into src/; only the body of `delegate()` changes.
 * img-to-pdf.mjs already exports an argv-free `convertImageToPdf`, so `render
 * image` calls it in process — the shape the other three are heading for.
 *
 * The delegates predate ADR 0006 and use their own exit codes, so translating
 * them is this file's other job. ADR 0006 is explicit that this is where that
 * happens: "Where the old and new codes conflict, the shim translates; the CLI
 * does not inherit the inconsistency." The one translation that matters most is
 * 1-vs-3: an absent tracker, an absent input file, an unavailable browser and a
 * busy lock are all "could not run" (3), never a negative finding (1).
 *
 * Nothing here prints or exits. `run()` returns `{ code, json, envelope, text }`
 * and the facade decides which stream that goes to.
 */

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { EXIT, parseFlags, renderHelp, envelope, errorEnvelope, couldNotVerify } from '../core/flags.js';

/** Repo root: src/commands/render.js → two levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const execFileAsync = promisify(execFile);

/** A delegate that renders through Chromium cannot report a real finding when
 *  the browser is not installed — that is exit 3, not exit 1. These are the
 *  strings Playwright emits for that state; a miss costs a 1 where a 3 was
 *  warranted, never the reverse. */
const BROWSER_UNAVAILABLE = /Executable doesn't exist|playwright install|Host system is missing dependencies|Failed to launch/i;

/** Node could not even start the delegate (missing runtime, unreadable file). */
const SPAWN_FAILED = new Set(['ENOENT', 'EACCES', 'EPERM']);

// ── delegation ──────────────────────────────────────────────────────

/**
 * Run a root script and capture what it said, without ever throwing.
 *
 * @param {string} file - Executable to run.
 * @param {string[]} args - Argument vector.
 * @param {object} [options] - Passed through to execFile.
 * @returns {Promise<{status: number|null, stdout: string, stderr: string, error?: Error}>}
 *   `status` is null only when the process could not be spawned at all.
 */
async function defaultExec(file, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { maxBuffer: 32 * 1024 * 1024, ...options });
    return { status: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    // execFile reports a non-zero exit as a numeric `code` and a failed spawn
    // as a string one. Collapsing the two loses the distinction between "the
    // script ran and failed" and "the script never ran".
    const status = typeof err?.code === 'number' ? err.code : null;
    return { status, stdout: err?.stdout ?? '', stderr: err?.stderr ?? '', error: err };
  }
}

/** The lines a delegate printed, blank ones dropped. */
const logLines = (text) => String(text ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean);

/**
 * The delegate's own words, as one error. Its message is more specific than
 * anything this layer could invent, so it is passed through rather than
 * summarised.
 *
 * @param {{stdout: string, stderr: string, status: number|null}} res
 * @param {string} fallback - Used when the delegate failed silently.
 * @returns {Array<{code: string, message: string}>}
 */
function delegateErrors(res, fallback) {
  const said = logLines(res.stderr).length ? logLines(res.stderr) : logLines(res.stdout);
  return [{ code: 'delegate-failed', message: said.length ? said.join('\n') : fallback }];
}

// ── result shaping ──────────────────────────────────────────────────

/**
 * @param {object} spec - Command spec.
 * @param {object} parsed - parseFlags result.
 * @param {object} data - Envelope `data`.
 * @param {{warnings?: Array, text?: string}} [extra]
 * @returns {{code: number, json: boolean, envelope: object, text: string}}
 */
const succeed = (spec, parsed, data, { warnings = [], text = '' } = {}) => ({
  code: EXIT.OK,
  json: parsed.json,
  envelope: envelope(spec.command, { data, warnings }),
  text,
});

/**
 * @param {object} spec - Command spec.
 * @param {object} parsed - parseFlags result.
 * @param {number} code - ADR 0006 exit code; must not be 0.
 * @param {*} errors - One error or a non-empty list.
 * @param {{data?: object, warnings?: Array}} [extra]
 * @returns {{code: number, json: boolean, envelope: object, text: string}}
 */
function refuse(spec, parsed, code, errors, { data = {}, warnings = [] } = {}) {
  const env = errorEnvelope(spec.command, errors, { data, warnings });
  return { code, json: parsed.json, envelope: env, text: env.errors.map((e) => `❌ ${e.message}`).join('\n') };
}

/**
 * The one way this file says "could not run" — ADR 0006's exit 3 paired with
 * its named envelope, so the two can never drift apart into a bare empty result.
 *
 * @param {object} spec - Command spec.
 * @param {object} parsed - parseFlags result.
 * @param {string} reason - Why the command could not run.
 * @param {{data?: object, warnings?: Array}} [extra]
 * @returns {{code: number, json: boolean, envelope: object, text: string}}
 */
function unverified(spec, parsed, reason, { data = {}, warnings = [] } = {}) {
  const env = couldNotVerify(spec.command, reason, { data, warnings });
  return { code: EXIT.UNVERIFIED, json: parsed.json, envelope: env, text: env.errors.map((e) => `❌ ${e.message}`).join('\n') };
}

/**
 * The `--help` result. Returned from `run()` rather than handled by the facade,
 * so `--json --help` is a valid envelope like every other outcome.
 *
 * @param {object} spec - Command spec.
 * @param {object} parsed - parseFlags result.
 * @returns {{code: number, json: boolean, envelope: object, text: string}}
 */
function helpResult(spec, parsed) {
  const text = renderHelp(spec);
  return { code: EXIT.OK, json: parsed.json, envelope: envelope(spec.command, { data: { help: text } }), text };
}

/**
 * Parse, then short-circuit the two outcomes every command shares.
 *
 * @param {string[]} argv - Argument vector for this command.
 * @param {object} spec - Command spec.
 * @returns {{parsed: object, done: object|null}} `done` is non-null when the
 *   caller should return it unchanged.
 */
function preamble(argv, spec) {
  const parsed = parseFlags(argv, spec);
  if (!parsed.ok) return { parsed, done: refuse(spec, parsed, EXIT.USAGE, parsed.errors) };
  if (parsed.help) return { parsed, done: helpResult(spec, parsed) };
  return { parsed, done: null };
}

/**
 * Apply a command's argument rules in order, reporting the first breach as a
 * usage error. The delegates re-validate all of this and exit 1; ADR 0006
 * reserves 1 for a real negative finding, so the translation happens here.
 *
 * @param {Array<{when: boolean, message: string}>} guards
 * @returns {{code: string, message: string}|null}
 */
function firstBreach(guards) {
  const hit = guards.find((g) => g.when);
  return hit ? { code: 'usage', message: hit.message } : null;
}

/**
 * Resolve a delegate script and confirm it is there. A missing delegate is a
 * could-not-run, not a failure of whatever it would have checked.
 *
 * @param {string} rootDir - Repo root.
 * @param {string} name - Script filename.
 * @returns {{path: string, missing: boolean}}
 */
function delegatePath(rootDir, name) {
  const path = resolve(rootDir, name);
  return { path, missing: !existsSync(path) };
}

// ── render pdf (ADR 0003: render generate-pdf) ──────────────────────

const PDF_FORMATS = ['a4', 'letter'];

const PDF_SPEC = {
  command: 'render pdf',
  usage: 'career-ops render pdf <input.html> <output.pdf> [options]\n'
    + '   or: career-ops render pdf --batch <manifest.json> [options]',
  description: 'Render a built CV HTML file to an ATS-safe PDF (delegates to generate-pdf.mjs).\n'
    + 'JSON data: { mode, input, output, manifest, format, maxPages, strictPages, allowReorder, report, log }.',
  flags: {
    '--format': { type: 'string', describe: `Page size: ${PDF_FORMATS.join(' or ')} (default a4)` },
    '--report': { type: 'string', describe: 'Report number NNN this PDF belongs to, for the manifest row' },
    '--batch': { type: 'string', describe: 'JSON manifest of {input, output, format?, reportNum?} rendered in one Chromium' },
    '--max-pages': { type: 'number', describe: 'Page budget (default 2)' },
    '--allow-reorder': { type: 'boolean', describe: 'Accept CV sections in a non-canonical order' },
    '--strict-pages': { type: 'boolean', describe: 'Fail, rather than warn, when the page budget is exceeded' },
  },
  positionals: { name: 'path', min: 0, max: 2 },
};

/**
 * @param {string[]} argv - Argument vector for this command.
 * @param {{rootDir?: string, cwd?: string, exec?: Function}} [ctx]
 * @returns {Promise<{code: number, json: boolean, envelope: object, text: string}>}
 */
async function runPdf(argv, ctx = {}) {
  const { rootDir = REPO_ROOT, cwd = process.cwd(), exec = defaultExec } = ctx;
  const { parsed, done } = preamble(argv, PDF_SPEC);
  if (done) return done;

  const batch = parsed.values['--batch'];
  const format = parsed.values['--format'];
  const report = parsed.values['--report'];
  const maxPages = parsed.values['--max-pages'];
  const allowReorder = parsed.values['--allow-reorder'];
  const strictPages = parsed.values['--strict-pages'];
  const [input, output] = parsed.positionals;

  const breach = firstBreach([
    { when: Boolean(batch) && parsed.positionals.length > 0,
      message: '--batch takes no positional arguments — each entry carries its own input and output' },
    // A batch renders N distinct CVs, so one global --report would mislabel
    // them all. The manifest's per-entry "reportNum" is the channel.
    { when: Boolean(batch) && report !== undefined,
      message: '--report is not valid with --batch. Set "reportNum" per entry in the manifest instead' },
    { when: !batch && parsed.positionals.length !== 2,
      message: 'expected <input.html> <output.pdf>, or --batch <manifest.json>' },
    { when: format !== undefined && !PDF_FORMATS.includes(format.toLowerCase()),
      message: `invalid --format "${format}". Use: ${PDF_FORMATS.join(', ')}` },
    { when: report !== undefined && !/^\d+$/.test(report),
      message: `invalid --report "${report}". Use the numeric tracker/report number, e.g. --report=018` },
    { when: maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1),
      message: `invalid --max-pages "${maxPages}". Use a positive integer, e.g. --max-pages=1` },
  ]);
  if (breach) return refuse(PDF_SPEC, parsed, EXIT.USAGE, breach);

  const script = delegatePath(rootDir, 'generate-pdf.mjs');
  if (script.missing) return unverified(PDF_SPEC, parsed, `generate-pdf.mjs not found at ${script.path}`);

  const inputPath = batch ? resolve(cwd, batch) : resolve(cwd, input);
  const outputPath = batch ? null : resolve(cwd, output);
  if (!existsSync(inputPath)) {
    return unverified(PDF_SPEC, parsed,
      `${batch ? 'batch manifest' : 'input HTML'} not found at ${inputPath}`);
  }

  // The `=` form is the only one generate-pdf.mjs:1093-1099 can see (audit A4).
  // Accepting `--max-pages 3` here and re-emitting it as `--max-pages=3` is how
  // the space form starts working without touching the frozen script.
  const args = [script.path];
  if (batch) args.push(`--batch=${inputPath}`);
  else args.push(inputPath, outputPath);
  if (format !== undefined) args.push(`--format=${format.toLowerCase()}`);
  if (report !== undefined) args.push(`--report=${report}`);
  if (maxPages !== undefined) args.push(`--max-pages=${maxPages}`);
  if (allowReorder) args.push('--allow-reorder');
  if (strictPages) args.push('--strict-pages');

  const res = await exec(process.execPath, args, { cwd });
  const data = {
    mode: batch ? 'batch' : 'single',
    input: batch ? null : inputPath,
    output: outputPath,
    manifest: batch ? inputPath : null,
    format: format ? format.toLowerCase() : 'a4',
    maxPages: maxPages ?? 2,
    strictPages,
    allowReorder,
    report: report ?? null,
    log: logLines(res.stdout),
  };

  if (res.status === 0) {
    return succeed(PDF_SPEC, parsed, data, {
      warnings: logLines(res.stderr),
      text: data.log.length ? data.log.join('\n') : `✅ rendered ${outputPath ?? inputPath}`,
    });
  }
  if (res.status === null) {
    const why = SPAWN_FAILED.has(res.error?.code)
      ? `could not start generate-pdf.mjs (${res.error.code})`
      : `generate-pdf.mjs did not run (${res.error?.message ?? 'unknown reason'})`;
    return unverified(PDF_SPEC, parsed, why, { data });
  }
  if (BROWSER_UNAVAILABLE.test(`${res.stderr}\n${res.stdout}`)) {
    return unverified(PDF_SPEC, parsed,
      'the Chromium build Playwright renders with is unavailable — run `npx playwright install chromium`', { data });
  }
  return refuse(PDF_SPEC, parsed, EXIT.FAILED,
    delegateErrors(res, `generate-pdf.mjs exited ${res.status} without a message`), { data });
}

// ── render image (ADR 0003: render img-to-pdf) ──────────────────────

const IMAGE_SPEC = {
  command: 'render image',
  usage: 'career-ops render image <image> <output.pdf> [--force]',
  description: 'Wrap one screenshot or image in a single-page PDF, for ATS upload fields that reject images.\n'
    + 'JSON data: { input, output, width, height, bytes }.',
  flags: {
    '--force': { type: 'boolean', describe: 'Overwrite <output.pdf> if it already exists' },
  },
  positionals: { name: 'path', min: 0, max: 2 },
};

/**
 * @param {string[]} argv - Argument vector for this command.
 * @param {{cwd?: string, convert?: Function}} [ctx] - `convert` defaults to
 *   img-to-pdf.mjs's `convertImageToPdf`; it is imported lazily so that
 *   `--help` works on a checkout with no Playwright installed.
 * @returns {Promise<{code: number, json: boolean, envelope: object, text: string}>}
 */
async function runImage(argv, ctx = {}) {
  const { cwd = process.cwd(), convert } = ctx;
  const { parsed, done } = preamble(argv, IMAGE_SPEC);
  if (done) return done;

  const [input, output] = parsed.positionals;
  const force = parsed.values['--force'];
  if (parsed.positionals.length !== 2) {
    return refuse(IMAGE_SPEC, parsed, EXIT.USAGE, { code: 'usage', message: 'expected <image> <output.pdf>' });
  }

  const inputPath = resolve(cwd, input);
  const outputPath = resolve(cwd, output);
  if (!existsSync(inputPath)) return unverified(IMAGE_SPEC, parsed, `image not found at ${inputPath}`);
  if (existsSync(outputPath) && !force) {
    // The command ran, looked, and refused — a real negative finding, so 1.
    return refuse(IMAGE_SPEC, parsed, EXIT.FAILED,
      { code: 'output-exists', message: `${outputPath} already exists. Pass --force to overwrite it` });
  }

  let convertImageToPdf = convert;
  if (!convertImageToPdf) {
    try {
      ({ convertImageToPdf } = await import('../../img-to-pdf.mjs'));
    } catch (err) {
      return unverified(IMAGE_SPEC, parsed, `img-to-pdf.mjs could not be loaded: ${err?.message ?? err}`);
    }
  }

  try {
    const res = await convertImageToPdf(inputPath, outputPath);
    const data = { input: inputPath, output: res.outputPath, width: res.width, height: res.height, bytes: res.size };
    return succeed(IMAGE_SPEC, parsed, data, {
      text: `✅ ${data.output} — ${data.width}x${data.height}px, ${(data.bytes / 1024).toFixed(1)} KB`,
    });
  } catch (err) {
    const message = err?.message ?? String(err);
    if (BROWSER_UNAVAILABLE.test(message)) {
      return unverified(IMAGE_SPEC, parsed,
        'the Chromium build Playwright renders with is unavailable — run `npx playwright install chromium`');
    }
    return refuse(IMAGE_SPEC, parsed, EXIT.FAILED, { code: 'conversion-failed', message });
  }
}

// ── render dashboard (ADR 0003: render build-dashboard) ─────────────

const DASHBOARD_SPEC = {
  command: 'render dashboard',
  usage: 'career-ops render dashboard',
  description: 'Build the Go TUI dashboard binary for this platform (delegates to build-dashboard.mjs).\n'
    + 'JSON data: { binary, log }.',
  flags: {},
};

/**
 * @param {string[]} argv - Argument vector for this command.
 * @param {{rootDir?: string, cwd?: string, exec?: Function}} [ctx]
 * @returns {Promise<{code: number, json: boolean, envelope: object, text: string}>}
 */
async function runDashboard(argv, ctx = {}) {
  const { rootDir = REPO_ROOT, cwd = process.cwd(), exec = defaultExec } = ctx;
  const { parsed, done } = preamble(argv, DASHBOARD_SPEC);
  if (done) return done;

  const script = delegatePath(rootDir, 'build-dashboard.mjs');
  if (script.missing) return unverified(DASHBOARD_SPEC, parsed, `build-dashboard.mjs not found at ${script.path}`);
  const source = resolve(rootDir, 'dashboard');
  if (!existsSync(source)) return unverified(DASHBOARD_SPEC, parsed, `no dashboard source at ${source} — nothing to build`);

  const res = await exec(process.execPath, [script.path], { cwd });
  // The output name is platform-dependent (.exe on Windows); read it back from
  // the delegate rather than deriving it a second time here.
  const built = /Built (\S+)/.exec(res.stdout ?? '');
  const data = { binary: built ? built[1] : null, log: logLines(res.stdout) };

  if (res.status === 0) {
    return succeed(DASHBOARD_SPEC, parsed, data, {
      warnings: logLines(res.stderr),
      text: data.log.length ? data.log.join('\n') : '✅ dashboard built',
    });
  }
  if (res.status === null) {
    return unverified(DASHBOARD_SPEC, parsed,
      `could not start build-dashboard.mjs (${res.error?.code ?? res.error?.message ?? 'unknown reason'})`, { data });
  }
  // build-dashboard.mjs prints this exact line and exits 1 when `go` is absent.
  // A missing toolchain is an environment error (4), not a failed build (1).
  if (/Go toolchain not found/.test(`${res.stderr}\n${res.stdout}`)) {
    return refuse(DASHBOARD_SPEC, parsed, EXIT.CONFIG,
      { code: 'no-toolchain', message: 'Go toolchain not found. Install Go 1.24+ from https://go.dev/dl/ and retry' },
      { data });
  }
  return refuse(DASHBOARD_SPEC, parsed, EXIT.FAILED,
    delegateErrors(res, `build-dashboard.mjs exited ${res.status} without a message`), { data });
}

// ── render mark-ready (ADR 0003: render mark-pdf-ready) ─────────────

/**
 * mark-pdf-ready.mjs's structured error codes, mapped onto ADR 0006's.
 *
 * The rule the mapping follows: if the tracker was readable and a verdict was
 * reached, that is a finding (1); if the tracker could not be reached at all,
 * nothing was checked (3); if the environment refused, that is 4. Its own
 * CLI_EXIT numbers cannot be reused — it spends 2 on not-found and 3 on
 * ambiguous, both of which are real findings under ADR 0006.
 */
const MARK_READY_EXIT = Object.freeze({
  usage: EXIT.USAGE,            // bad argv
  'no-tracker': EXIT.UNVERIFIED, // no tracker file — nothing was inspected
  'read-failure': EXIT.UNVERIFIED,
  'lock-timeout': EXIT.UNVERIFIED, // another writer holds it; retry later
  'lock-error': EXIT.CONFIG,     // unwritable lock dir — environment
  'write-failure': EXIT.CONFIG,  // the row resolved; the filesystem refused
  'no-pdf-column': EXIT.FAILED,
  'empty-tracker': EXIT.FAILED,
  'not-found': EXIT.FAILED,
  ambiguous: EXIT.FAILED,
});

const MARK_READY_SPEC = {
  command: 'render mark-ready',
  usage: 'career-ops render mark-ready <report#> [--dry-run]',
  description: "Flip a tracker row's PDF column ❌→✅ by report number (delegates to mark-pdf-ready.mjs).\n"
    + 'The report number is the NNN in reports/NNN-{slug}-{date}.md, not the tracker # column.\n'
    + 'JSON data: { changed, num, company, role, reportNum, tracker, dryRun? }.',
  flags: {
    '--dry-run': { type: 'boolean', describe: 'Resolve and validate, but write nothing' },
  },
  positionals: { name: 'report#', min: 0, max: 1 },
};

/**
 * @param {string[]} argv - Argument vector for this command.
 * @param {{rootDir?: string, cwd?: string, exec?: Function}} [ctx]
 * @returns {Promise<{code: number, json: boolean, envelope: object, text: string}>}
 */
async function runMarkReady(argv, ctx = {}) {
  const { rootDir = REPO_ROOT, cwd = process.cwd(), exec = defaultExec } = ctx;
  const { parsed, done } = preamble(argv, MARK_READY_SPEC);
  if (done) return done;

  const [reportNum] = parsed.positionals;
  const dryRun = parsed.values['--dry-run'];
  const breach = firstBreach([
    { when: parsed.positionals.length !== 1, message: 'expected 1 argument: <report#>' },
    { when: parsed.positionals.length === 1 && !/^\d+$/.test(reportNum),
      message: `"${reportNum}" is not a valid report number` },
  ]);
  if (breach) return refuse(MARK_READY_SPEC, parsed, EXIT.USAGE, breach);

  const script = delegatePath(rootDir, 'mark-pdf-ready.mjs');
  if (script.missing) return unverified(MARK_READY_SPEC, parsed, `mark-pdf-ready.mjs not found at ${script.path}`);

  // Always `--json`, whatever the user asked for: the delegate's structured
  // `code` is what the exit-code translation reads. Its exit status alone
  // cannot tell no-pdf-column from write-failure, and both share CLI_EXIT.USAGE.
  const args = [script.path, reportNum, '--json'];
  if (dryRun) args.push('--dry-run');
  const res = await exec(process.execPath, args, { cwd });

  if (res.status === null) {
    return unverified(MARK_READY_SPEC, parsed,
      `could not start mark-pdf-ready.mjs (${res.error?.code ?? res.error?.message ?? 'unknown reason'})`);
  }

  let payload;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    // No verdict was received, so none can be reported. Exit 1 here would say
    // "the row is not ready" on evidence that does not exist.
    return unverified(MARK_READY_SPEC, parsed,
      `mark-pdf-ready.mjs --json emitted no parseable result (exit ${res.status})`,
      { warnings: logLines(res.stderr) });
  }

  if (payload && typeof payload.code === 'string') {
    const code = MARK_READY_EXIT[payload.code] ?? EXIT.FAILED;
    const { error, code: kind, ...rest } = payload;
    if (code === EXIT.UNVERIFIED) {
      return unverified(MARK_READY_SPEC, parsed, error ?? kind, { data: rest });
    }
    return refuse(MARK_READY_SPEC, parsed, code, { code: kind, message: error ?? kind }, { data: rest });
  }

  if (res.status !== 0) {
    return refuse(MARK_READY_SPEC, parsed, EXIT.FAILED,
      delegateErrors(res, `mark-pdf-ready.mjs exited ${res.status} without a message`), { data: payload ?? {} });
  }

  const verb = payload.dryRun ? (payload.changed ? 'would mark' : 'already') : payload.changed ? 'marked' : 'already';
  return succeed(MARK_READY_SPEC, parsed, payload, {
    warnings: logLines(res.stderr),
    text: `✅ #${payload.num} ${payload.company} — ${payload.role}: ${verb} PDF ready`,
  });
}

// ── the noun ────────────────────────────────────────────────────────

/**
 * Assemble the `{ run, help, flags }` record the facade consumes.
 *
 * @param {object} spec - Command spec.
 * @param {Function} run - The adapter.
 * @param {string[]} aliases - Other names this verb answers to.
 * @returns {{run: Function, help: string, flags: object, spec: object, describe: string, aliases: string[]}}
 */
const command = (spec, run, aliases = []) => ({
  run,
  help: renderHelp(spec),
  flags: spec.flags,
  spec,
  describe: spec.description.split('\n')[0],
  aliases,
});

export const noun = 'render';

export const commands = {
  pdf: command(PDF_SPEC, runPdf, ['generate-pdf']),
  image: command(IMAGE_SPEC, runImage, ['img-to-pdf']),
  dashboard: command(DASHBOARD_SPEC, runDashboard, ['build-dashboard']),
  'mark-ready': command(MARK_READY_SPEC, runMarkReady, ['mark-pdf-ready']),
};

export default { noun, commands };
