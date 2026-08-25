/**
 * eval.js — the `career-ops eval` noun: the LLM evaluation and CV-tailoring
 * runners (ADR 0003's eight `eval` rows).
 *
 * Adapters only. Every command here does exactly four things: parse argv with
 * src/core/flags.js, decide whether the run CAN happen, delegate to the runner
 * that already holds the logic, and shape the answer into the ADR 0006
 * envelope. There is no evaluation logic in this file and there must not be —
 * the eight runners are ~3,300 lines of prompt assembly, provider transport and
 * report writing, and duplicating any of it here is how the two copies drift.
 *
 * Delegation is by CHILD PROCESS, not by import, and that is forced rather than
 * chosen: seven of the eight runners parse `process.argv` and call
 * `process.exit()` at module scope (batch-tailor.mjs:28, eval-golden.mjs:56,
 * gemini-eval.mjs:84, ollama-eval.mjs:61, openai-eval.mjs:65,
 * openai-tailor.mjs:50, plus openrouter-runner.mjs's guarded switch). Importing
 * one runs it. When ADR 0005 step 5 moves them into src/ and gives them
 * argv-free entry points, `plan()` stays exactly as it is and only `runChild`
 * changes.
 *
 * What the adapter adds over `node <runner>.mjs`, which is the whole point:
 *
 *   - **Exit code 3 instead of a lie.** Every runner collapses "could not run"
 *     into exit 1 — or worse. `batch-evaluate-gemini.mjs:325` prints "No
 *     pipeline.md found." and returns 0; `openrouter-runner.mjs:826` prints a
 *     usage line for `apply` with no report and falls through to 0. Both report
 *     success for a check that never executed, which is the exact pattern
 *     ADR 0006 exists to end. The preflight in each `plan()` below separates
 *     missing input and unreachable service (3) and bad key/endpoint (4) from a
 *     real negative finding (1) BEFORE anything is spawned.
 *   - **Unknown flags are rejected.** The runners hand-roll `for (i of args)`
 *     loops that silently ignore anything they do not recognise, so a typo runs
 *     a full paid evaluation against the defaults.
 *   - **Relative paths keep working.** The child runs with cwd at the repo
 *     root, so a user's `--file ./jd.txt` is resolved against the CALLER's cwd
 *     here and handed over absolute.
 *
 * Deliberate contract changes, each pinned by a test in
 * tests/commands/eval.test.mjs:
 *   - Usage errors are exit 2, not 1 (ADR 0006).
 *   - `golden --live --replay` is a usage error; eval-golden.mjs:56 silently
 *     preferred `--live`.
 *   - A JD given as both `--file` and inline text is a usage error; the runners
 *     appended the inline text to the file's contents.
 *   - `openrouter` with no action, an unknown action, or `apply` with no report
 *     is a usage error; the runner printed help and exited 0.
 *
 * Facade contract — `run(argv, ctx)` resolves to:
 *   { code, json, envelope, text, streamed }
 * `code` is the process exit code, `json` whether the caller asked for the
 * envelope, `envelope` the ADR 0006 result, `text` the prose the ADAPTER
 * produced (help, or a preflight failure), and `streamed` is true when the
 * child's own output already went to the inherited stdio and the caller must
 * not print `text` after it. Print `envelope` as JSON when `json`, `text`
 * otherwise.
 *
 * ctx (all optional, all for tests):
 *   { env, cwd, spawnFn, fetchFn, capture }
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  EXIT, parseFlags, renderHelp, envelope, errorEnvelope, couldNotVerify,
} from '../core/flags.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where a runner may live. Root today; `src/` after ADR 0005 step 5 moves it
 *  with `git mv`. Two entries so the move needs no edit here — and a runner
 *  that is in neither is reported as could-not-verify rather than spawned. */
const RUNNER_DIRS = [ROOT, join(ROOT, 'src')];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

// ── preflight verdicts ──────────────────────────────────────────────

const cannotRun = (reason) => ({ ok: false, code: EXIT.UNVERIFIED, reason });
const configError = (message) => ({ ok: false, code: EXIT.CONFIG, errors: [{ code: 'config-error', message }] });
const usageError = (message) => ({ ok: false, code: EXIT.USAGE, errors: [{ code: 'usage-error', message }] });
const ready = (argv, extra = {}) => ({ ok: true, argv, warnings: [], ...extra });

// ── shared preflight pieces ─────────────────────────────────────────

/**
 * Locate a runner script.
 *
 * @param {string} file - Runner filename, e.g. 'gemini-eval.mjs'.
 * @returns {string|null} Absolute path, or null when it is in neither dir.
 */
function resolveRunner(file) {
  for (const dir of RUNNER_DIRS) {
    const candidate = join(dir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Absolute form of a user-supplied path, anchored on the CALLER's cwd.
 *
 * The child is spawned with cwd at the repo root, so a relative path handed
 * straight through would resolve somewhere the user never meant.
 *
 * @param {string} path - The path as typed.
 * @param {string} cwd - The caller's working directory.
 * @returns {string} Absolute path.
 */
const fromCwd = (path, cwd) => resolve(cwd, path);

/**
 * The JD source shared by the three single-role evaluators.
 *
 * @param {object} parsed - parseFlags result.
 * @param {string} cwd - The caller's working directory.
 * @returns {{ok: boolean, argv?: string[], code?: number, reason?: string, errors?: Array}}
 *   On success, the argv fragment naming the JD.
 */
function jdSource(parsed, cwd) {
  const file = parsed.values['--file'];
  const inline = parsed.positionals;
  if (file && inline.length > 0) {
    // The runners read --file into jdText and then APPENDED each positional to
    // it, so the model silently scored a JD nobody wrote.
    return usageError('give the job description as --file <path> OR as inline text, not both');
  }
  if (!file && inline.length === 0) {
    return usageError('no job description given — pass --file <path> or the JD text as an argument');
  }
  if (!file) return { ok: true, argv: inline };

  const path = fromCwd(file, cwd);
  if (!existsSync(path)) return cannotRun(`job description file not found: ${path}`);
  return { ok: true, argv: ['--file', path] };
}

/**
 * Endpoint and credential guard for the OpenAI-compatible runners.
 *
 * Mirrors openai-eval.mjs:155-186 — cv.md, the JD and the key go to this
 * endpoint, so a remote host must be HTTPS and must have a key. These are
 * environment faults, not findings: exit 4.
 *
 * @param {object} parsed - parseFlags result.
 * @param {object} env - Environment to read.
 * @returns {{ok: boolean, argv?: string[], code?: number, errors?: Array}}
 *   On success, the argv fragment carrying --url/--key when they were given.
 */
function openAiEndpoint(parsed, env) {
  const base = String(parsed.values['--url'] || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const key = parsed.values['--key'] || env.OPENAI_API_KEY || '';

  let url;
  try {
    url = new URL(base);
  } catch {
    return configError(`invalid OpenAI base URL: "${base}"`);
  }
  if (!LOOPBACK.has(url.hostname)) {
    if (url.protocol !== 'https:') {
      return configError(`refusing a non-HTTPS remote endpoint: ${base} — your CV, the job description and your API key would be sent in cleartext`);
    }
    if (!key) {
      return configError(`no API key for ${url.hostname} — set OPENAI_API_KEY or pass --key`);
    }
  }
  const argv = ['--url', base];
  if (parsed.values['--key']) argv.push('--key', parsed.values['--key']);
  return { ok: true, argv };
}

/**
 * Append `--model <id>` when one was asked for, so the runner keeps its own
 * default (each has a different one, and several read it from env).
 *
 * @param {object} parsed - parseFlags result.
 * @returns {string[]} Empty when no model was given.
 */
const modelArgv = (parsed) => (parsed.values['--model'] ? ['--model', parsed.values['--model']] : []);

/**
 * Pass through the boolean switches the runner understands.
 *
 * @param {object} parsed - parseFlags result.
 * @param {string[]} names - Flag names to forward when set.
 * @returns {string[]} The subset that was set.
 */
const switchArgv = (parsed, names) => names.filter((n) => parsed.values[n] === true);

// ── the child process ───────────────────────────────────────────────

/**
 * Spawn a runner and collect its outcome. Never throws: a spawn failure is an
 * outcome, because "the runner would not start" is a could-not-verify and must
 * not surface as a stack trace.
 *
 * @param {string} script - Absolute runner path.
 * @param {string[]} argv - Arguments after the script.
 * @param {{spawnFn: Function, env: object, capture: boolean}} opts - Injection points.
 * @returns {Promise<{status: number|null, signal: string|null, stdout: string, stderr: string, error: Error|null}>}
 */
function runChild(script, argv, { spawnFn, env, capture }) {
  return new Promise((res) => {
    let child;
    try {
      child = spawnFn(process.execPath, [script, ...argv], {
        cwd: ROOT,
        env,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      });
    } catch (err) {
      res({ status: null, signal: null, stdout: '', stderr: '', error: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });
    }
    let settled = false;
    const done = (out) => { if (!settled) { settled = true; res(out); } };
    child.on('error', (err) => done({ status: null, signal: null, stdout, stderr, error: err }));
    child.on('close', (status, signal) => done({ status, signal, stdout, stderr, error: null }));
  });
}

/** Last few non-empty lines of a stream, for an actionable error message. */
const tail = (text, n = 6) => String(text || '').split('\n').filter((l) => l.trim() !== '').slice(-n).join('\n');

// ── the adapter ─────────────────────────────────────────────────────

/**
 * Build one command from a spec.
 *
 * @param {object} spec - parseFlags spec plus `runner` (the script filename)
 *   and `plan(parsed, ctx)` (the preflight, returning a verdict).
 * @returns {{run: Function, help: string, flags: object, runner: string}}
 */
function makeCommand(spec) {
  const help = renderHelp(spec);
  const { command } = spec;

  const fail = (code, env_, json) => ({ code, json, envelope: env_, text: env_.errors.map((e) => e.message).join('\n'), streamed: false });

  async function run(argv, ctx = {}) {
    const env = ctx.env || process.env;
    const cwd = ctx.cwd || process.cwd();
    const spawnFn = ctx.spawnFn || spawn;

    const parsed = parseFlags(argv, spec);
    if (!parsed.ok) {
      return {
        code: EXIT.USAGE,
        json: parsed.json,
        envelope: errorEnvelope(command, parsed.errors),
        text: `${parsed.errors.map((e) => e.message).join('\n')}\n\n${help}`,
        streamed: false,
      };
    }
    if (parsed.help) {
      return { code: EXIT.OK, json: parsed.json, envelope: envelope(command, { data: { help } }), text: help, streamed: false };
    }

    let verdict;
    try {
      verdict = await spec.plan(parsed, { env, cwd, fetchFn: ctx.fetchFn || globalThis.fetch });
    } catch (err) {
      // A preflight that itself broke has NOT established that the check would
      // fail — it established that it could not be run.
      return fail(EXIT.UNVERIFIED, couldNotVerify(command, `preflight failed: ${err.message}`), parsed.json);
    }
    if (!verdict.ok) {
      const env_ = verdict.reason !== undefined
        ? couldNotVerify(command, verdict.reason)
        : errorEnvelope(command, verdict.errors);
      return fail(verdict.code, env_, parsed.json);
    }

    const script = resolveRunner(spec.runner);
    if (!script) {
      return fail(EXIT.UNVERIFIED, couldNotVerify(command, `runner not found: ${spec.runner} is in neither ${RUNNER_DIRS.join(' nor ')}`), parsed.json);
    }

    const capture = ctx.capture ?? parsed.json;
    const childArgv = verdict.argv;
    const outcome = await runChild(script, childArgv, { spawnFn, env, capture });

    const data = {
      runner: script.slice(ROOT.length + 1),
      argv: childArgv,
      exitCode: outcome.status,
      ...(capture ? { stdout: outcome.stdout, stderr: outcome.stderr } : {}),
      ...(verdict.data || {}),
    };
    const warnings = verdict.warnings || [];

    if (outcome.error) {
      return fail(EXIT.UNVERIFIED, couldNotVerify(command, `could not start ${data.runner}: ${outcome.error.message}`, { data, warnings }), parsed.json);
    }
    if (outcome.status === null) {
      // Killed by a signal. Nothing ran to completion, so nothing was verified.
      return fail(EXIT.UNVERIFIED, couldNotVerify(command, `${data.runner} was killed by ${outcome.signal}`, { data, warnings }), parsed.json);
    }
    if (outcome.status !== 0) {
      // Preflight has already taken the could-not-run causes it can see, so a
      // non-zero status here is treated as a real negative finding. The raw
      // status stays in `data.exitCode` either way.
      const detail = tail(outcome.stderr) || tail(outcome.stdout);
      return {
        code: EXIT.FAILED,
        json: parsed.json,
        envelope: errorEnvelope(command, [{
          code: 'runner-failed',
          message: `${data.runner} exited ${outcome.status}${detail ? `: ${detail}` : ''}`,
        }], { data, warnings }),
        text: capture ? detail : '',
        streamed: !capture,
      };
    }

    return {
      code: EXIT.OK,
      json: parsed.json,
      envelope: envelope(command, { data, warnings }),
      text: capture ? outcome.stdout : '',
      streamed: !capture,
    };
  }

  return { run, help, flags: spec.flags, runner: spec.runner };
}

// ── command specs ───────────────────────────────────────────────────

const JD_FLAGS = {
  '--file': { type: 'string', describe: 'Read the job description from a file instead of inline text' },
  '--model': { type: 'string', describe: 'Model id (runner default when omitted)' },
  '--no-save': { type: 'boolean', describe: 'Do not write a report into reports/' },
};

const JD_POSITIONALS = { name: 'jd-text', min: 0, max: Infinity };

const golden = makeCommand({
  command: 'eval golden',
  runner: 'eval-golden.mjs',
  description: 'Run the golden-set gate: score a candidate model against the labelled cases and check archetype agreement.',
  usage: 'career-ops eval golden [--replay|--live] [--model <id>] [--golden <dir>]',
  flags: {
    '--replay': { type: 'boolean', describe: 'Replay recorded fixtures — offline, deterministic, $0 (default)' },
    '--live': { type: 'boolean', describe: 'Call the model live through the OpenAI-compatible runner' },
    '--model': { type: 'string', describe: 'Candidate model id (default: cheap-stub)' },
    '--golden': { type: 'string', describe: 'Golden-set directory (default: evals/golden)' },
    '--fixtures': { type: 'string', describe: 'Replay fixture directory (default: a sibling of the golden dir)' },
  },
  plan(parsed, { env, cwd }) {
    const live = parsed.values['--live'];
    if (live && parsed.values['--replay']) {
      // eval-golden.mjs:56 resolves this by preferring --live, so a caller who
      // meant to stay offline could be billed for a live run.
      return usageError('--replay and --live are mutually exclusive');
    }

    const given = parsed.values['--golden'];
    // Check the directory the CHILD will read: it is passed through absolute
    // below, so the two can never disagree. ADR 0007 moves evals/ under tests/,
    // hence the second default.
    const dir = given
      ? fromCwd(given, cwd)
      : [join(ROOT, 'evals', 'golden'), join(ROOT, 'tests', 'evals', 'golden')].find((d) => existsSync(d))
        || join(ROOT, 'evals', 'golden');
    if (!existsSync(dir)) return cannotRun(`golden-set directory not found: ${dir}`);
    if (!statSync(dir).isDirectory()) return cannotRun(`golden-set path is not a directory: ${dir}`);
    const cases = readdirSync(dir).filter((f) => f.endsWith('.json'));
    // eval-golden.mjs:198 exits 1 here, which reads as "the gate failed". A
    // gate with nothing to run did not fail; it did not run.
    if (cases.length === 0) return cannotRun(`no golden cases (*.json) in ${dir}`);

    const argv = [live ? '--live' : '--replay', '--golden', dir, ...modelArgv(parsed)];
    if (parsed.values['--fixtures']) argv.push('--fixtures', fromCwd(parsed.values['--fixtures'], cwd));

    if (live) {
      // Live mode shells out to the OpenAI-compatible runner (eval-golden.mjs:227),
      // so its endpoint rules apply before a single case is spent.
      const endpoint = openAiEndpoint(parsed, env);
      if (!endpoint.ok) return endpoint;
    }
    return ready(argv, { data: { goldenDir: dir, cases: cases.length, mode: live ? 'live' : 'replay' } });
  },
});

const gemini = makeCommand({
  command: 'eval gemini',
  runner: 'gemini-eval.mjs',
  description: 'Evaluate one job description with Google Gemini.',
  usage: 'career-ops eval gemini [--file <path> | <jd text>] [--model <id>]',
  flags: {
    ...JD_FLAGS,
    '--no-compress': { type: 'boolean', describe: 'Skip token-budget compression (full context injection)' },
  },
  positionals: JD_POSITIONALS,
  plan(parsed, { env, cwd }) {
    const jd = jdSource(parsed, cwd);
    if (!jd.ok) return jd;
    if (!env.GEMINI_API_KEY) {
      return configError('GEMINI_API_KEY is not set — get a free key at https://aistudio.google.com/apikey and add it to .env');
    }
    return ready([...jd.argv, ...modelArgv(parsed), ...switchArgv(parsed, ['--no-save', '--no-compress'])]);
  },
});

const ollama = makeCommand({
  command: 'eval ollama',
  runner: 'ollama-eval.mjs',
  description: 'Evaluate one job description with a local Ollama model.',
  usage: 'career-ops eval ollama [--file <path> | <jd text>] [--model <id>] [--url <base>]',
  flags: {
    ...JD_FLAGS,
    '--url': { type: 'string', describe: 'Ollama base URL (default: http://localhost:11434)' },
  },
  positionals: JD_POSITIONALS,
  async plan(parsed, { env, cwd, fetchFn }) {
    const jd = jdSource(parsed, cwd);
    if (!jd.ok) return jd;

    const base = String(parsed.values['--url'] || env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    let url;
    try {
      url = new URL(base);
    } catch {
      return configError(`invalid Ollama base URL: "${base}"`);
    }
    // ollama-eval.mjs:167 — cv.md and the full JD go to this endpoint, so a
    // remote one has to be opted into explicitly.
    if (!LOOPBACK.has(url.hostname) && env.OLLAMA_ALLOW_REMOTE !== '1') {
      return configError(`refusing a remote Ollama endpoint: ${base} — your CV and job description would leave this machine. Set OLLAMA_ALLOW_REMOTE=1 to allow it.`);
    }

    // The canonical could-not-verify: an unreachable service. The runner exits
    // 1 for this, which is indistinguishable from a real negative finding.
    try {
      const probe = await fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) });
      if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    } catch (err) {
      return cannotRun(`Ollama is not reachable at ${base} (${err.message}) — start it with \`ollama serve\``);
    }

    const argv = [...jd.argv, ...modelArgv(parsed), ...switchArgv(parsed, ['--no-save'])];
    if (parsed.values['--url']) argv.push('--url', base);
    return ready(argv, { data: { endpoint: base } });
  },
});

const openai = makeCommand({
  command: 'eval openai',
  runner: 'openai-eval.mjs',
  description: 'Evaluate one job description with any OpenAI-compatible chat API.',
  usage: 'career-ops eval openai [--file <path> | <jd text>] [--url <base>] [--model <id>]',
  flags: {
    ...JD_FLAGS,
    '--url': { type: 'string', describe: 'OpenAI-compatible base URL including any /v1 (env OPENAI_BASE_URL)' },
    '--key': { type: 'string', describe: 'API key (env OPENAI_API_KEY)' },
    '--no-compress': { type: 'boolean', describe: 'Skip token-budget compression (full context injection)' },
  },
  positionals: JD_POSITIONALS,
  plan(parsed, { env, cwd }) {
    const jd = jdSource(parsed, cwd);
    if (!jd.ok) return jd;
    const endpoint = openAiEndpoint(parsed, env);
    if (!endpoint.ok) return endpoint;
    return ready([
      ...jd.argv, ...endpoint.argv, ...modelArgv(parsed),
      ...switchArgv(parsed, ['--no-save', '--no-compress']),
    ]);
  },
});

const tailor = makeCommand({
  command: 'eval tailor',
  runner: 'openai-tailor.mjs',
  description: 'Tailor the CV for one role from its JD and evaluation report, with any OpenAI-compatible API.',
  usage: 'career-ops eval tailor --jd <path> --report <path> [--model <id>]',
  flags: {
    '--jd': { type: 'string', describe: 'Path to the job description text file' },
    '--report': { type: 'string', describe: 'Path to the evaluation report for that role' },
    '--model': { type: 'string', describe: 'Model id (env OPENAI_MODEL, default gpt-4o)' },
    '--url': { type: 'string', describe: 'OpenAI-compatible base URL including any /v1 (env OPENAI_BASE_URL)' },
    '--key': { type: 'string', describe: 'API key (env OPENAI_API_KEY)' },
  },
  plan(parsed, { env, cwd }) {
    const missing = ['--jd', '--report'].filter((f) => !parsed.values[f]);
    if (missing.length > 0) return usageError(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} required`);

    const jdPath = fromCwd(parsed.values['--jd'], cwd);
    if (!existsSync(jdPath)) return cannotRun(`job description file not found: ${jdPath}`);
    const reportPath = fromCwd(parsed.values['--report'], cwd);
    if (!existsSync(reportPath)) return cannotRun(`evaluation report not found: ${reportPath}`);

    const endpoint = openAiEndpoint(parsed, env);
    if (!endpoint.ok) return endpoint;
    return ready(['--jd', jdPath, '--report', reportPath, ...endpoint.argv, ...modelArgv(parsed)]);
  },
});

const batchTailor = makeCommand({
  command: 'eval batch-tailor',
  runner: 'batch-tailor.mjs',
  description: 'Tailor a CV for every completed batch job scoring at or above a threshold.',
  usage: 'career-ops eval batch-tailor [--min-score <n>]',
  flags: {
    '--min-score': { type: 'number', describe: 'Minimum score to tailor (default: 4.0)' },
  },
  plan(parsed, { env }) {
    // batch-tailor.mjs:14 honours CAREER_OPS_BATCH_STATE; check the same path
    // the child will read, not a store.js resolution it does not use.
    const stateFile = env.CAREER_OPS_BATCH_STATE
      ? resolve(env.CAREER_OPS_BATCH_STATE)
      : join(ROOT, 'batch', 'batch-state.tsv');
    if (!existsSync(stateFile)) return cannotRun(`batch state file not found: ${stateFile} — run a batch evaluation first`);

    const min = parsed.values['--min-score'];
    return ready(min === undefined ? [] : ['--min-score', String(min)], { data: { stateFile } });
  },
});

const batchGemini = makeCommand({
  command: 'eval batch-gemini',
  runner: 'batch-evaluate-gemini.mjs',
  description: 'Evaluate every pending pipeline entry with Gemini, then merge the tracker additions.',
  usage: 'career-ops eval batch-gemini [--limit <n>] [--concurrency <n>] [--model <id>]',
  flags: {
    '--model': { type: 'string', describe: 'Gemini model id (default: from the profile spend tier)' },
    '--limit': { type: 'number', describe: 'Process at most this many pending entries' },
    '--concurrency': { type: 'number', describe: 'Parallel evaluations (default: 2)' },
  },
  plan(parsed, { env }) {
    if (!env.GEMINI_API_KEY) {
      return configError('GEMINI_API_KEY is not set — get a free key at https://aistudio.google.com/apikey and add it to .env');
    }
    // batch-evaluate-gemini.mjs:39 anchors the pipeline to `data/pipeline.md`
    // and ignores CAREER_OPS_PIPELINE (audit Part III, row 5), so the preflight
    // checks that literal path — a store.js resolution would pass on a file the
    // child never opens. The child prints "No pipeline.md found." and returns
    // 0; a batch that evaluated nothing because its input is missing is a
    // could-not-verify.
    const pipeline = join(ROOT, 'data', 'pipeline.md');
    if (!existsSync(pipeline)) return cannotRun(`pipeline not found: ${pipeline} — nothing to evaluate`);

    const argv = [...modelArgv(parsed)];
    for (const flag of ['--limit', '--concurrency']) {
      const v = parsed.values[flag];
      if (v !== undefined) {
        if (!Number.isInteger(v) || v < 1) return usageError(`${flag} expects a whole number of at least 1, got ${v}`);
        argv.push(flag, String(v));
      }
    }
    return ready(argv, { data: { pipeline } });
  },
});

/** openrouter-runner.mjs's own sub-commands, and the one alias it accepts. */
const OPENROUTER_ACTIONS = ['scan', 'evaluate', 'pipeline', 'apply', 'models'];
const OPENROUTER_ALIASES = { eval: 'evaluate' };
/** Actions that call the model, and so need a key (openrouter-runner.mjs:200). */
const OPENROUTER_KEYED = new Set(['evaluate', 'pipeline', 'apply', 'models']);

const openrouter = makeCommand({
  command: 'eval openrouter',
  runner: 'openrouter-runner.mjs',
  description: `Run the OpenRouter free-model rotation. Actions: ${OPENROUTER_ACTIONS.join(', ')}.`,
  usage: 'career-ops eval openrouter <action> [args]',
  flags: {},
  positionals: { name: 'action', min: 0, max: Infinity },
  plan(parsed, { env }) {
    const [raw, ...rest] = parsed.positionals;
    if (!raw) {
      // The runner prints its help and exits 0 for this, so a scripted caller
      // that forgot the action reads success.
      return usageError(`no action given — one of: ${OPENROUTER_ACTIONS.join(', ')}`);
    }
    const action = OPENROUTER_ALIASES[raw] || raw;
    if (!OPENROUTER_ACTIONS.includes(action)) {
      return usageError(`unknown action: ${raw}. Valid actions: ${OPENROUTER_ACTIONS.join(', ')}`);
    }
    // openrouter-runner.mjs:826 prints a usage line and breaks — exit 0 for a
    // run that never happened.
    if (action === 'apply' && rest.length === 0) {
      return usageError('openrouter apply needs a report number or report path');
    }
    if (OPENROUTER_KEYED.has(action) && !env.OPENROUTER_API_KEY) {
      return configError('OPENROUTER_API_KEY is not set — copy .env.example to .env and add your key (free at https://openrouter.ai)');
    }
    return ready([action, ...rest], { data: { action } });
  },
});

export const noun = 'eval';

export const commands = {
  golden,
  gemini,
  ollama,
  openai,
  tailor,
  'batch-tailor': batchTailor,
  'batch-gemini': batchGemini,
  openrouter,
};

export default { noun, commands };
