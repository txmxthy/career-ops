/**
 * The `career-ops` CLI facade.
 *
 * Ten noun modules, `<noun> <verb>` dispatch, one result contract. The facade
 * owns stdout and the exit status; the command adapters own neither — they
 * return a result and the rendering decision is made here, once.
 *
 * The adapters were written in parallel and their return shapes drifted:
 * `exitCode` vs `code`, `text` vs `stdout`/`stderr`, and a `json` key that is a
 * boolean in six modules and the envelope itself in `followup`. Rather than
 * edit ten files this normalises at the boundary — see `normalise`, which is
 * the single place that knowledge lives.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT, envelope, errorEnvelope, hasFlag } from './core/flags.js';

import * as applyNoun from './commands/apply.js';
import * as cvNoun from './commands/cv.js';
import * as evalNoun from './commands/eval.js';
import * as followupNoun from './commands/followup.js';
import * as insightNoun from './commands/insight.js';
import * as pipelineNoun from './commands/pipeline.js';
import * as renderNoun from './commands/render.js';
import * as scanNoun from './commands/scan.js';
import * as systemNoun from './commands/system.js';
import * as trackerNoun from './commands/tracker.js';

/** Namespace imports, not defaults: `scan.js` exports no default. */
const MODULES = [
  applyNoun, cvNoun, evalNoun, followupNoun, insightNoun,
  pipelineNoun, renderNoun, scanNoun, systemNoun, trackerNoun,
];

/** `<root>/src/cli.js` — the repo root is two levels up. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** noun -> commands. Insertion order is the order `--help` prints. */
export const REGISTRY = new Map(MODULES.map((m) => [m.noun, m.commands]));

const BIN = 'career-ops';

/** Read lazily and forgivingly: a missing version must not break dispatch. */
function version() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Reading the command records
// ---------------------------------------------------------------------------

/** `help` is a string in nine modules and a function in `system`. */
function helpTextOf(cmd) {
  const h = typeof cmd.help === 'function' ? cmd.help() : cmd.help;
  return typeof h === 'string' ? h : '';
}

/**
 * The one-line summary for the enumerations.
 *
 * Four modules expose an explicit key and they disagree on its name
 * (`describe`, `summary`, `description`); the rest expose none. Every help
 * string opens with a prose paragraph before the first blank line, so that is
 * the fallback. `tracker`'s `command` key is deliberately not consulted — it
 * holds the command name, not a description.
 */
function summaryOf(cmd) {
  const explicit = cmd.describe ?? cmd.summary ?? cmd.description;
  const text = Array.isArray(explicit) ? explicit.join(' ') : explicit;
  const source = typeof text === 'string' && text.trim()
    ? text
    : helpTextOf(cmd).split('\n\n')[0];
  const line = String(source || '').split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
  return line.length > 96 ? `${line.slice(0, 93).trimEnd()}...` : line;
}

// ---------------------------------------------------------------------------
// Close-match suggestions
// ---------------------------------------------------------------------------

/** Levenshtein distance. One consumer, so it stays inline (ADR 0002). */
function distance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** The closest candidate, or null when nothing is close enough to be useful. */
function closest(token, candidates) {
  const needle = String(token || '').toLowerCase();
  if (!needle) return null;
  const limit = Math.max(2, Math.floor(needle.length / 3));
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const target = candidate.toLowerCase();
    // A prefix or substring hit beats edit distance: `veri` -> `verify`.
    const score = target.startsWith(needle) || needle.startsWith(target)
      ? 0
      : distance(needle, target);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  return bestScore <= limit ? best : null;
}

/** Every `<noun> <verb>` pair whose verb matches the token exactly. */
function verbMatchesAcrossNouns(token) {
  const hits = [];
  for (const [noun, commands] of REGISTRY) {
    if (Object.hasOwn(commands, token)) hits.push(`${noun} ${token}`);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function topHelpText() {
  const lines = [
    'career-ops — job-search operations, as one command.',
    '',
    `Usage: ${BIN} <noun> <verb> [options]`,
    `       ${BIN} <noun> --help          list the verbs under a noun`,
    `       ${BIN} <noun> <verb> --help   document one command`,
    '',
    'Global options:',
    '      --json     Print the JSON result envelope instead of prose (every command)',
    '  -h, --help     Show this help and exit',
    '      --version  Print the version and exit',
    '',
  ];
  for (const [noun, commands] of REGISTRY) {
    const verbs = Object.keys(commands);
    lines.push(`${noun} (${verbs.length}):`);
    const width = verbs.reduce((w, v) => Math.max(w, v.length), 0);
    for (const verb of verbs) {
      lines.push(`  ${verb.padEnd(width)}  ${summaryOf(commands[verb])}`.trimEnd());
    }
    lines.push('');
  }
  lines.push('Exit codes:');
  lines.push(`  ${EXIT.OK}  success — the check ran and passed`);
  lines.push(`  ${EXIT.FAILED}  the check ran and failed`);
  lines.push(`  ${EXIT.USAGE}  usage error — bad flags or unknown command`);
  lines.push(`  ${EXIT.UNVERIFIED}  could not verify — the check could not run`);
  lines.push(`  ${EXIT.CONFIG}  config or environment error`);
  return lines.join('\n');
}

function topHelpData() {
  return {
    version: version(),
    nouns: [...REGISTRY].map(([noun, commands]) => ({
      noun,
      verbs: Object.keys(commands).map((verb) => ({
        verb,
        command: `${noun} ${verb}`,
        summary: summaryOf(commands[verb]),
      })),
    })),
  };
}

function nounHelpText(noun) {
  const commands = REGISTRY.get(noun);
  const verbs = Object.keys(commands);
  const width = verbs.reduce((w, v) => Math.max(w, v.length), 0);
  const lines = [
    `${BIN} ${noun} — ${verbs.length} command${verbs.length === 1 ? '' : 's'}.`,
    '',
    `Usage: ${BIN} ${noun} <verb> [options]`,
    '',
    'Commands:',
  ];
  for (const verb of verbs) {
    lines.push(`  ${verb.padEnd(width)}  ${summaryOf(commands[verb])}`.trimEnd());
  }
  lines.push('', `Run \`${BIN} ${noun} <verb> --help\` for one command.`);
  return lines.join('\n');
}

function nounHelpData(noun) {
  const commands = REGISTRY.get(noun);
  return {
    noun,
    verbs: Object.keys(commands).map((verb) => ({
      verb,
      command: `${noun} ${verb}`,
      summary: summaryOf(commands[verb]),
    })),
  };
}

// ---------------------------------------------------------------------------
// Result normalisation
// ---------------------------------------------------------------------------

/**
 * Flatten one adapter's result into `{ code, envelope, stdout, stderr, streamed }`.
 *
 * `json` is only treated as the envelope when the module offers no `envelope`
 * key — in six of the ten it is a boolean recording whether `--json` was asked
 * for, and reading that as a result would be a silent corruption.
 */
function normalise(result) {
  const r = result || {};
  const code = typeof r.exitCode === 'number' ? r.exitCode
    : typeof r.code === 'number' ? r.code
      : EXIT.OK;
  const env = r.envelope && typeof r.envelope === 'object'
    ? r.envelope
    : (r.json && typeof r.json === 'object' ? r.json : null);
  const stdout = typeof r.text === 'string' ? r.text
    : typeof r.stdout === 'string' ? r.stdout
      : '';
  return {
    code,
    envelope: env,
    stdout,
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    streamed: r.streamed === true,
  };
}

/** Append a newline unless the payload already ends in one. */
const line = (s) => (s.endsWith('\n') ? s : `${s}\n`);

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run one `career-ops` invocation.
 *
 * Prints through the injected writers and returns the exit code rather than
 * calling `process.exit`, so the whole surface is drivable from a test.
 *
 * @param {string[]} argv - Arguments after the binary name.
 * @param {object} [io] - Injectable environment; every field is defaulted.
 * @returns {Promise<number>} The exit code.
 */
export async function run(argv = [], io = {}) {
  const {
    out = (s) => process.stdout.write(s),
    err = (s) => process.stderr.write(s),
    env = process.env,
    cwd = process.cwd(),
    stdin = process.stdin,
    root = ROOT,
  } = io;

  const args = [...argv];
  const wantsJson = hasFlag(args, '--json');
  // `-h` only means help before a verb resolves. Once a command owns the argv
  // the adapter decides, so this never shadows a command's own `-h`.
  const wantsHelp = hasFlag(args, '--help') || hasFlag(args, '-h');

  /** Emit one result. Prose goes to stdout; `--json` replaces it entirely. */
  const emit = (code, envelopeObj, text, extraErr = '') => {
    if (wantsJson) {
      out(line(JSON.stringify(envelopeObj)));
    } else {
      if (text) out(line(text));
      if (extraErr) err(line(extraErr));
    }
    return code;
  };

  const usageError = (message, hint) => {
    const errors = [{ code: 'usage', message }];
    const data = hint ? { hint } : {};
    if (wantsJson) {
      out(line(JSON.stringify(errorEnvelope(BIN, errors, { data }))));
    } else {
      err(line(hint ? `${message}\n${hint}` : message));
      err(line(`Run \`${BIN} --help\` for the full command list.`));
    }
    return EXIT.USAGE;
  };

  const positional = args.filter((a) => !a.startsWith('-'));
  const nounToken = positional[0];

  // `--version` is global only before a noun resolves. `apply artifacts`
  // declares its own `--version <n>` (the tailored-CV version), so once a
  // command owns the argv every flag in it belongs to that command.
  if (!nounToken && hasFlag(args, '--version')) {
    const v = version();
    return emit(EXIT.OK, envelope(BIN, { data: { version: v } }), v);
  }

  // No noun: `--help` is a request and exits 0; a bare invocation is a usage error.
  if (!nounToken) {
    if (wantsHelp || args.length === 0) {
      const code = wantsHelp ? EXIT.OK : EXIT.USAGE;
      if (wantsJson) {
        out(line(JSON.stringify(
          code === EXIT.OK
            ? envelope(BIN, { data: topHelpData() })
            : errorEnvelope(BIN, [{ code: 'usage', message: 'no command given' }], { data: topHelpData() }),
        )));
      } else {
        (code === EXIT.OK ? out : err)(line(topHelpText()));
      }
      return code;
    }
    return usageError('no command given');
  }

  if (!REGISTRY.has(nounToken)) {
    const asVerb = verbMatchesAcrossNouns(nounToken);
    const nearNoun = closest(nounToken, [...REGISTRY.keys()]);
    const hint = asVerb.length > 0
      ? `Did you mean \`${BIN} ${asVerb[0]}\`?`
      : nearNoun
        ? `Did you mean \`${BIN} ${nearNoun}\`?`
        : `Nouns: ${[...REGISTRY.keys()].join(', ')}`;
    return usageError(`unknown command: ${nounToken}`, hint);
  }

  const commands = REGISTRY.get(nounToken);
  const verbToken = positional[1];

  // `<noun> --help` lists the verbs; a bare `<noun>` is the same list, as an error.
  if (!verbToken) {
    if (wantsHelp) {
      return emit(EXIT.OK, envelope(`${BIN} ${nounToken}`, { data: nounHelpData(nounToken) }), nounHelpText(nounToken));
    }
    if (wantsJson) {
      out(line(JSON.stringify(errorEnvelope(
        `${BIN} ${nounToken}`,
        [{ code: 'usage', message: `no verb given for \`${nounToken}\`` }],
        { data: nounHelpData(nounToken) },
      ))));
    } else {
      err(line(`no verb given for \`${nounToken}\`.\n\n${nounHelpText(nounToken)}`));
    }
    return EXIT.USAGE;
  }

  if (!Object.hasOwn(commands, verbToken)) {
    const near = closest(verbToken, Object.keys(commands));
    const elsewhere = verbMatchesAcrossNouns(verbToken).filter((c) => !c.startsWith(`${nounToken} `));
    const hint = near
      ? `Did you mean \`${BIN} ${nounToken} ${near}\`?`
      : elsewhere.length > 0
        ? `Did you mean \`${BIN} ${elsewhere[0]}\`?`
        : `Verbs under \`${nounToken}\`: ${Object.keys(commands).join(', ')}`;
    return usageError(`unknown verb: ${nounToken} ${verbToken}`, hint);
  }

  const cmd = commands[verbToken];
  const name = `${nounToken} ${verbToken}`;

  // Everything after the verb, flags included, belongs to the command. The
  // adapters answer `--help` themselves, so it needs no special case here.
  const rest = [];
  let seen = 0;
  for (const token of args) {
    if (seen < 2 && !token.startsWith('-')) { seen += 1; continue; }
    rest.push(token);
  }

  // The adapters were written against different ctx names for the same repo
  // root; passing the union keeps all ten injectable from one call site.
  const ctx = { root, rootDir: root, cwd, env, stdin, entry: join(root, 'src', 'cli.js') };

  let result;
  try {
    result = await cmd.run(rest, ctx);
  } catch (cause) {
    // A crash is a check that did not run, not a check that found nothing.
    const message = `could not verify: ${name} failed to run — ${cause?.message || cause}`;
    const failed = errorEnvelope(name, [{ code: 'could-not-verify', message }]);
    if (wantsJson) out(line(JSON.stringify(failed)));
    else err(line(message));
    return EXIT.UNVERIFIED;
  }

  const { code, envelope: resultEnvelope, stdout, stderr, streamed } = normalise(result);

  if (wantsJson) {
    if (!resultEnvelope) {
      // The adapter owes an envelope under --json. Guessing one from prose is
      // how "nothing found" gets printed for a check nobody performed.
      const message = `could not verify: ${name} returned no JSON envelope`;
      out(line(JSON.stringify(errorEnvelope(name, [{ code: 'could-not-verify', message }]))));
      return EXIT.UNVERIFIED;
    }
    out(line(JSON.stringify(resultEnvelope)));
    return code;
  }

  // `streamed` (eval) means the child already wrote to the inherited stdio.
  if (!streamed && stdout) out(line(stdout));
  if (stderr) err(line(stderr));
  return code;
}

export default { run, REGISTRY, ROOT };
