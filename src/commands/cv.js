/**
 * cv.js — the `career-ops cv <verb>` adapters.
 *
 * Covers the ADR 0003 rows assigned to the `cv` noun. Three verbs are renamed
 * from the classifier's output, which ADR 0003 calls a starting point:
 *
 *   build-cv-html       -> build-html      (`cv build-cv-html` stutters)
 *   build-cv-latex      -> build-latex     (same)
 *   generate-cover-letter -> cover-letter  (every other verb is bare)
 *   playwright.cv.config  -> DROPPED       (a Playwright config file, not a
 *                                           command — see the note below)
 *
 * Adapters only. Nothing here decides what a CV looks like or what counts as an
 * unsupported claim; each verb parses flags with src/core/flags.js, hands the
 * work to the code that already owns it, and maps the result onto the ADR 0006
 * envelope and exit codes.
 *
 * Two ways of reaching that code, for one reason:
 *
 *   - `verify-facts` imports `verifyFacts` from verify-cv-facts.mjs, which is
 *     already argv-free and exported.
 *   - `build-html`, `build-latex`, `cover-letter` and `sync-check` run their
 *     root script as a child process. Those four export nothing usable —
 *     cv-sync-check.mjs does its work at module scope and exits, and the two
 *     builders keep `renderHtml`/`buildEducation` module-local. Copying those
 *     bodies in here is exactly the duplication this refactor exists to remove,
 *     so the process boundary stands in until the logic moves into core. The
 *     builders already print a JSON report, so the envelope's `data` is theirs,
 *     not something reconstructed from prose.
 *
 * What the adapters DO add, in every case, is the ADR 0006 distinction the root
 * scripts do not draw: a check that could not run exits 3, never 1. Missing
 * input, a missing template, a `--config` naming a file that is not there — all
 * of those are exit 1 at root today, reported in the same breath as a genuine
 * fact-gate failure. Each such change is marked below and pinned by a test.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT, couldNotVerify, envelope, errorEnvelope, parseFlags, renderHelp,
} from '../core/flags.js';

/**
 * The root scripts these adapters drive. ADR 0005 step 5 moves them under
 * `src/`; this constant is the only line in the file that changes when it does.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Fact sources verify-cv-facts.mjs:20 falls back to when none are named. */
const DEFAULT_FACT_SOURCES = ['cv.md', 'article-digest.md'];

/** Page formats generate-pdf accepts; anything else is a usage error, not a
 *  silent fall-through to the default (the defect class flags.js exists for). */
const PDF_FORMATS = new Set(['letter', 'a4']);

// ── Result plumbing ─────────────────────────────────────────────────

/**
 * What every `run` returns. The command prints nothing and exits nothing; the
 * facade writes `text` or `JSON.stringify(envelope)` and exits with `exitCode`.
 *
 * @typedef {object} CommandResult
 * @property {number} exitCode - ADR 0006 code.
 * @property {boolean} json - Whether --json was asked for.
 * @property {object} envelope - The ADR 0006 result envelope.
 * @property {string} text - Human rendering, no trailing newline.
 */

/** @returns {CommandResult} */
const result = (env, exitCode, json, text) => ({ exitCode, json, envelope: env, text });

/** The rendered errors, one per line, as the prose form of a failed envelope. */
const errorText = (env) => env.errors.map((e) => `ERROR: ${e.message}`).join('\n');

/** A usage failure: exit 2, the errors, and the command's own help beneath. */
function usageResult(spec, json, errors) {
  const env = errorEnvelope(spec.command, errors);
  return result(env, EXIT.USAGE, json, `${errorText(env)}\n\n${renderHelp(spec)}`);
}

/** A check that could not run: exit 3, never an empty exit-0 result. */
function unverified(spec, json, reason, extra = {}) {
  const env = couldNotVerify(spec.command, reason, extra);
  return result(env, EXIT.UNVERIFIED, json, errorText(env));
}

/**
 * Honour `--help` and reject bad flags, in that order — parseFlags collects
 * flag errors before it reports `help`, so `--help --bogus` names `--bogus`.
 *
 * @returns {CommandResult|null} Null when the command should carry on.
 */
function gate(spec, parse) {
  if (!parse.ok) return usageResult(spec, parse.json, parse.errors);
  if (parse.help) {
    const help = renderHelp(spec);
    return result(envelope(spec.command, { data: { help } }), EXIT.OK, parse.json, help);
  }
  return null;
}

/** Resolve a user-supplied path against the invoking directory, not the repo. */
const at = (cwd, path) => (isAbsolute(path) ? path : resolve(cwd, path));

// ── Child-process adapter ───────────────────────────────────────────

/**
 * Run a root script and collect its output.
 *
 * `spawned: false` is the case that must not be confused with a failing check:
 * the script could not be started at all, which is exit 3, not exit 1.
 *
 * @param {string} script - Filename at the repo root.
 * @param {string[]} argv - Arguments for the child.
 * @param {string} cwd - Working directory for the child.
 * @returns {Promise<{spawned: boolean, code: number|null, stdout: string, stderr: string, error?: Error}>}
 */
function runScript(script, argv, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, script), ...argv], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => done({ spawned: false, code: null, stdout, stderr, error }));
    child.once('close', (code) => done({ spawned: true, code, stdout, stderr }));
  });
}

/** The most useful line the child left behind, for an error message. */
function childMessage(proc) {
  const lines = `${proc.stderr}\n${proc.stdout}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.slice(-4).join('; ').slice(0, 500) : `exited ${proc.code}`;
}

/**
 * Map a child run onto the envelope.
 *
 * The builders print their report as JSON, so a successful run carries real
 * structured data. An unparseable report is a warning, not a failure — the
 * artifact was written either way, and claiming otherwise would be the same
 * category error in the opposite direction.
 *
 * @param {object} spec - Command spec.
 * @param {boolean} json - Whether --json was asked for.
 * @param {string} script - Script name, for the could-not-run message.
 * @param {object} proc - `runScript` result.
 * @param {object} [extra] - Fields to merge into `data` on success.
 * @param {(data: object) => string} [render] - Prose rendering of a success.
 * @returns {CommandResult}
 */
function fromChild(spec, json, script, proc, extra = {}, render = null) {
  if (!proc.spawned) {
    return unverified(spec, json, `could not start ${script}: ${proc.error?.message ?? 'spawn failed'}`);
  }
  if (proc.code !== 0) {
    const env = errorEnvelope(spec.command, [{ code: 'command-failed', message: childMessage(proc) }]);
    return result(env, EXIT.FAILED, json, errorText(env));
  }

  const warnings = [];
  let report = null;
  try {
    report = JSON.parse(proc.stdout);
  } catch {
    warnings.push(`${script} exited 0 but its report was not JSON; the artifact was written`);
  }
  const data = { ...(report ?? {}), ...extra };
  const env = envelope(spec.command, { data, warnings });
  const prose = render ? render(data) : proc.stdout.trimEnd();
  return result(env, EXIT.OK, json, [prose, ...warnings.map((w) => `WARN: ${w}`)].filter(Boolean).join('\n'));
}

// ── cv build-html ───────────────────────────────────────────────────

const BUILD_HTML = {
  command: 'cv build-html',
  usage: 'career-ops cv build-html <input.json> <output.html> [--template <path>]',
  description: 'Render a CV payload to HTML. Data: the builder\'s report — file, path, sizeKB, per-section counts.',
  flags: {
    '--template': { type: 'string', describe: 'Template .html path (default templates/cv-template.html)' },
    '--preview': { describe: 'Write output/cv-preview.html instead of taking an output path' },
  },
  positionals: { name: 'path', min: 1, max: 2 },
};

async function buildHtml(argv, { cwd = process.cwd() } = {}) {
  const parse = parseFlags(argv, BUILD_HTML);
  const stop = gate(BUILD_HTML, parse);
  if (stop) return stop;

  const preview = parse.values['--preview'];
  const [inputArg, outputArg] = parse.positionals;

  if (preview && outputArg !== undefined) {
    return usageResult(BUILD_HTML, parse.json, [{
      code: 'unexpected-positional',
      message: '--preview writes output/cv-preview.html; do not also pass <output.html>',
    }]);
  }
  if (!preview && outputArg === undefined) {
    return usageResult(BUILD_HTML, parse.json, [{
      code: 'missing-positional',
      message: 'expected <input.json> and <output.html>; pass --preview to write output/cv-preview.html instead',
    }]);
  }

  // Exit 3, not the root script's exit 1: a payload that is not there is a
  // build that could not run, not a build that ran and produced a bad CV.
  const input = at(cwd, inputArg);
  if (!existsSync(input)) return unverified(BUILD_HTML, parse.json, `input payload not found: ${input}`);

  const template = parse.values['--template'] ? at(cwd, parse.values['--template']) : null;
  if (template && !existsSync(template)) {
    return unverified(BUILD_HTML, parse.json, `template not found: ${template}`);
  }

  const output = preview ? null : at(cwd, outputArg);
  const childArgs = preview ? ['--preview', input] : [input, output];
  if (template) childArgs.push(template);

  const proc = await runScript('build-cv-html.mjs', childArgs, cwd);
  return fromChild(BUILD_HTML, parse.json, 'build-cv-html.mjs', proc, {}, (d) => `CV HTML: ${d.path ?? output ?? 'output/cv-preview.html'}`);
}

// ── cv build-latex ──────────────────────────────────────────────────

const BUILD_LATEX = {
  command: 'cv build-latex',
  usage: 'career-ops cv build-latex <input.json> <output.tex> [--template <name>]',
  description: 'Render a CV payload to LaTeX. Data: the builder\'s report — file, path, sizeKB, per-section counts.',
  flags: {
    // A NAME resolved through cv-templates.mjs, unlike build-html's template
    // path. The two root scripts differ here; the help says which is which
    // rather than papering over it.
    '--template': { type: 'string', describe: 'Template name resolved through cv-templates (a name, not a path)' },
  },
  positionals: { name: 'path', min: 2, max: 2 },
};

async function buildLatex(argv, { cwd = process.cwd() } = {}) {
  const parse = parseFlags(argv, BUILD_LATEX);
  const stop = gate(BUILD_LATEX, parse);
  if (stop) return stop;

  const [inputArg, outputArg] = parse.positionals;
  const input = at(cwd, inputArg);
  if (!existsSync(input)) return unverified(BUILD_LATEX, parse.json, `input payload not found: ${input}`);
  const output = at(cwd, outputArg);

  // The template flag goes last: build-cv-latex.mjs reads its two positionals
  // straight off argv[0] and argv[1], so a leading flag would become the input
  // path.
  const childArgs = [input, output];
  const name = parse.values['--template'];
  if (name) childArgs.push(`--template=${name}`);

  const proc = await runScript('build-cv-latex.mjs', childArgs, cwd);
  return fromChild(BUILD_LATEX, parse.json, 'build-cv-latex.mjs', proc, {}, (d) => `CV LaTeX: ${d.path ?? output}`);
}

// ── cv sync-check ───────────────────────────────────────────────────

const SYNC_CHECK = {
  command: 'cv sync-check',
  usage: 'career-ops cv sync-check',
  description: 'Check cv.md, config/profile.yml and the prompt files for missing or example data. Data: { errors, warnings }.',
  flags: {},
};

/** Pull the `  ERROR: …` / `  WARN: …` lines cv-sync-check.mjs prints. */
function syncFindings(stdout) {
  const errors = [];
  const warnings = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('ERROR: ')) errors.push(trimmed.slice(7));
    else if (trimmed.startsWith('WARN: ')) warnings.push(trimmed.slice(6));
  }
  return { errors, warnings };
}

async function syncCheck(argv, { cwd = process.cwd() } = {}) {
  const parse = parseFlags(argv, SYNC_CHECK);
  const stop = gate(SYNC_CHECK, parse);
  if (stop) return stop;

  const proc = await runScript('cv-sync-check.mjs', [], cwd);
  if (!proc.spawned) {
    return unverified(SYNC_CHECK, parse.json, `could not start cv-sync-check.mjs: ${proc.error?.message ?? 'spawn failed'}`);
  }
  // The script speaks two exit codes and only two. Anything else — a throw, a
  // signal — means it did not finish its checks, which is exit 3, not a clean
  // bill of health and not a finding.
  if (proc.code !== 0 && proc.code !== 1) {
    return unverified(SYNC_CHECK, parse.json, `cv-sync-check.mjs exited ${proc.code}: ${childMessage(proc)}`);
  }

  const { errors, warnings } = syncFindings(proc.stdout);
  if (proc.code === 0) {
    const env = envelope(SYNC_CHECK.command, { data: { errors: [], warnings }, warnings });
    const text = warnings.length
      ? warnings.map((w) => `WARN: ${w}`).join('\n')
      : 'career-ops sync check: all checks passed.';
    return result(env, EXIT.OK, parse.json, text);
  }

  // Exit 1 with nothing parsed would be a failure we cannot describe; say that
  // rather than emit a failed envelope with an empty reason.
  const found = errors.length
    ? errors.map((message) => ({ code: 'sync-check', message }))
    : [{ code: 'sync-check', message: childMessage(proc) }];
  const env = errorEnvelope(SYNC_CHECK.command, found, { data: { errors, warnings }, warnings });
  return result(env, EXIT.FAILED, parse.json, [errorText(env), ...warnings.map((w) => `WARN: ${w}`)].join('\n'));
}

// ── cv cover-letter ─────────────────────────────────────────────────

const COVER_LETTER = {
  command: 'cv cover-letter',
  usage: 'career-ops cv cover-letter --payload <payload.json> [--out <path>] [--format letter|a4] [--report <n>]',
  description: 'Render a cover-letter PDF from a JSON payload, through the CV fact gate. Data: { output }.',
  flags: {
    '--payload': { type: 'string', describe: 'JSON payload file (required)' },
    '--out': { type: 'string', describe: 'Output PDF path; must stay inside output/' },
    '--format': { type: 'string', describe: 'Page format: letter or a4 (default a4)' },
    '--report': { type: 'string', describe: 'Tracker report number to link in data/pdf-index.tsv' },
  },
};

async function coverLetter(argv, { cwd = process.cwd() } = {}) {
  const parse = parseFlags(argv, COVER_LETTER);
  const stop = gate(COVER_LETTER, parse);
  if (stop) return stop;

  const payloadArg = parse.values['--payload'];
  if (payloadArg === undefined) {
    return usageResult(COVER_LETTER, parse.json, [{ code: 'missing-value', flag: '--payload', message: '--payload is required' }]);
  }

  // Root passes --format through untouched, so a typo renders at the default
  // page size and nobody is told. Reject it instead.
  const format = parse.values['--format'];
  if (format !== undefined && !PDF_FORMATS.has(format)) {
    return usageResult(COVER_LETTER, parse.json, [{
      code: 'invalid-value',
      flag: '--format',
      message: `--format expects one of ${[...PDF_FORMATS].join(', ')}, got "${format}"`,
    }]);
  }

  const payload = at(cwd, payloadArg);
  if (!existsSync(payload)) return unverified(COVER_LETTER, parse.json, `payload not found: ${payload}`);

  const childArgs = ['--payload', payload];
  if (parse.values['--out'] !== undefined) childArgs.push('--out', parse.values['--out']);
  if (format !== undefined) childArgs.push('--format', format);
  if (parse.values['--report'] !== undefined) childArgs.push('--report', parse.values['--report']);

  const proc = await runScript('generate-cover-letter.mjs', childArgs, cwd);
  if (proc.spawned && proc.code === 0) {
    // The script's one success line, `Cover letter PDF: <path>`.
    const match = proc.stdout.match(/^Cover letter PDF:\s*(.+)$/m);
    const output = match ? match[1].trim() : null;
    const warnings = output ? [] : ['generate-cover-letter.mjs exited 0 without naming an output path'];
    const env = envelope(COVER_LETTER.command, { data: { output }, warnings });
    return result(env, EXIT.OK, parse.json, `Cover letter PDF: ${output ?? '(path not reported)'}`);
  }
  return fromChild(COVER_LETTER, parse.json, 'generate-cover-letter.mjs', proc);
}

// ── cv verify-facts ─────────────────────────────────────────────────

const VERIFY_FACTS = {
  command: 'cv verify-facts',
  usage: 'career-ops cv verify-facts <document> [--source <path>]... [--config <path>]',
  description: 'Check a generated document for metrics and facts absent from your evidence files. Data: { verdict, invented, unsupportedFacts, forbidden, warnings }.',
  flags: {
    '--source': { type: 'string', repeat: true, describe: `Evidence file (repeatable; default ${DEFAULT_FACT_SOURCES.join(', ')})` },
    '--config': { type: 'string', describe: 'Fact-gate config (default config/cv-facts.json)' },
  },
  positionals: { name: 'document', min: 1, max: 1 },
};

async function verifyFactsCmd(argv, { cwd = process.cwd() } = {}) {
  const parse = parseFlags(argv, VERIFY_FACTS);
  const stop = gate(VERIFY_FACTS, parse);
  if (stop) return stop;

  const target = at(cwd, parse.positionals[0]);
  if (!existsSync(target)) return unverified(VERIFY_FACTS, parse.json, `target document not found: ${target}`);

  const named = parse.values['--source'];
  const sources = (named.length ? named : DEFAULT_FACT_SOURCES).map((p) => at(cwd, p));
  const present = sources.filter((p) => existsSync(p));
  // verify-cv-facts.mjs reads sources with readText, which turns an absent file
  // into ''. With no evidence at all every metric in the document looks
  // invented and the gate reports a confident `block` — a finding produced by a
  // check that never ran. That is the exact ADR 0006 confusion; refuse instead.
  if (present.length === 0) {
    return unverified(VERIFY_FACTS, parse.json, `no fact sources readable: ${sources.join(', ')}`);
  }
  const warnings = sources.filter((p) => !present.includes(p)).map((p) => `fact source not found, skipped: ${p}`);

  // An explicit --config naming a file that is not there falls back to an empty
  // gate at root, which passes everything. Treat it as could-not-verify.
  const configArg = parse.values['--config'];
  let configPath;
  if (configArg !== undefined) {
    configPath = at(cwd, configArg);
    if (!existsSync(configPath)) return unverified(VERIFY_FACTS, parse.json, `fact-gate config not found: ${configPath}`, { warnings });
  }

  let verifyFacts;
  try {
    ({ verifyFacts } = await import('../../verify-cv-facts.mjs'));
  } catch (err) {
    return unverified(VERIFY_FACTS, parse.json, `verify-cv-facts.mjs could not be loaded: ${err?.message ?? err}`, { warnings });
  }

  let outcome;
  try {
    outcome = verifyFacts(readFileSync(target, 'utf-8'), {
      sourcePaths: present,
      ...(configPath ? { configPath } : {}),
      cwd,
    });
  } catch (err) {
    // Target and sources are already known good, so what is left is the config:
    // unreadable, not JSON, or a key that is not an array. ADR 0006 code 4.
    const env = errorEnvelope(VERIFY_FACTS.command, [{ code: 'config-error', message: err?.message ?? String(err) }], { warnings });
    return result(env, EXIT.CONFIG, parse.json, errorText(env));
  }

  const data = { ...outcome, target, sources: present };
  const advisories = [...warnings, ...outcome.warnings.map((p) => `advisory phrase: ${p}`)];

  if (outcome.verdict === 'block') {
    const errors = [
      ...outcome.invented.map((c) => ({ code: 'invented-metric', message: `metric-like claim absent from sources: ${c}` })),
      ...outcome.unsupportedFacts.map(({ kind, value }) => ({ code: 'unsupported-fact', message: `${kind} absent from sources: ${value}` })),
      ...outcome.forbidden.map((p) => ({ code: 'forbidden-phrase', message: `forbidden phrase: ${p}` })),
    ];
    const env = errorEnvelope(VERIFY_FACTS.command, errors, { data, warnings: advisories });
    const text = [errorText(env), ...advisories.map((w) => `WARN: ${w}`),
      '', 'Add real evidence to your source files, or allow a verified exception in the fact-gate config.'].join('\n');
    return result(env, EXIT.FAILED, parse.json, text);
  }

  const env = envelope(VERIFY_FACTS.command, { data, warnings: advisories });
  const headline = outcome.verdict === 'warn' ? 'CV fact check passed with advisories' : 'CV fact check passed';
  return result(env, EXIT.OK, parse.json, [headline, ...advisories.map((w) => `WARN: ${w}`)].join('\n'));
}

// ── Noun ────────────────────────────────────────────────────────────

export const noun = 'cv';

export const commands = {
  'build-html': { run: buildHtml, help: renderHelp(BUILD_HTML), flags: BUILD_HTML.flags },
  'build-latex': { run: buildLatex, help: renderHelp(BUILD_LATEX), flags: BUILD_LATEX.flags },
  'sync-check': { run: syncCheck, help: renderHelp(SYNC_CHECK), flags: SYNC_CHECK.flags },
  'cover-letter': { run: coverLetter, help: renderHelp(COVER_LETTER), flags: COVER_LETTER.flags },
  'verify-facts': { run: verifyFactsCmd, help: renderHelp(VERIFY_FACTS), flags: VERIFY_FACTS.flags },
};

export default { noun, commands };
