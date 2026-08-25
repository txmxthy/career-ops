/**
 * flags.js — the one argv reader, --help renderer and CLI result contract.
 *
 * Replaces the 3 `flagValue` + 10 `parseArgs` + 3 `parseCliArgs` catalogued in
 * docs/audit/duplicate-functionality.md (Part II, CAPABILITY 2), plus the ~24
 * bare `args.indexOf('--flag')` value reads and the ad-hoc `--flag=value`-only
 * parsers that are its mirror image. The canonical body is src/lib/cli-flags.mjs:29
 * — most callers, only implementation with dedicated tests, and the only one
 * whose semantics are documented with the defect IDs they close.
 *
 * The defect class all of this exists to end is silent: a flag form the parser
 * cannot see falls through to a default, and the script reports a result for
 * inputs nobody asked for, at exit 0. `--file=x` is invisible to `indexOf`;
 * `--format html` is invisible to a `startsWith('--format=')` parser. Both
 * forms work everywhere here, and anything malformed is reported rather than
 * ignored.
 *
 * Pure: no argv, no exiting, no printing. A parse returns what it found and
 * what was wrong with it; the command adapter decides how to say so. That is
 * also why nothing here corresponds to src/lib/cli-flags.mjs's `validateFlags` —
 * its whole body is printing and exiting, which belongs in an adapter.
 *
 * Deliberate changes to the canonical behaviour, each pinned by a test:
 *   - `--flag --next` no longer swallows `--next` as a value (ADR 0004 #6).
 *   - A usage error is exit code 2, not 1 (ADR 0006 reserves 1 for a real
 *     negative finding).
 *   - A value flag left without an operand is always an error, never opt-in.
 *   - An empty value (`--company ""`, `--company=`) is a usage error, which is
 *     src/scripts/company-history.mjs:163-170's rule generalised (audit A7).
 *   - A repeated non-repeatable value flag is reported rather than silently
 *     resolved first-wins.
 */

/** Exit codes, per ADR 0006. 1 and 3 are deliberately distinct: an empty
 *  result and an unperformed check must never share a representation. */
export const EXIT = Object.freeze({
  OK: 0,        // the check ran and passed
  FAILED: 1,    // the check ran and failed — a real negative finding
  USAGE: 2,     // bad flags, unknown command
  UNVERIFIED: 3,// could not verify — the check could not run
  CONFIG: 4,    // config or environment error
});

/** Flags every command answers, whether or not it declares them (ADR 0006). */
const IMPLICIT_FLAGS = {
  '--json': { type: 'boolean', describe: 'Print the JSON result envelope instead of prose' },
  '--help': { type: 'boolean', short: '-h', describe: 'Show this help and exit' },
};

/** A token starting with `--` is another flag; a single dash is a value. This
 *  is the adjacency rule every hand-rolled parser in the repo copied, and it is
 *  what lets `--since -5` carry a negative day count. */
const isFlagToken = (t) => typeof t === 'string' && t.startsWith('--');

const takesValue = (def) => def.type === 'string' || def.type === 'number';

/**
 * Value of a value-taking flag, accepting both `--flag value` and
 * `--flag=value`.
 *
 * The `=` form is checked first: `indexOf()` cannot see it, so checking it
 * second would let the space-separated lookup fall through and drop the value.
 *
 * @param {string[]} args - argv slice.
 * @param {string} flag - Flag name including leading dashes, e.g. '--file'.
 * @returns {string|undefined} The value, or undefined when the flag is absent
 *   or was supplied without one. Never null — pair with `hasFlag` when the
 *   difference matters.
 */
export function flagValue(args, flag) {
  if (!Array.isArray(args)) return undefined;
  const eq = args.find((a) => typeof a === 'string' && a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  // ADR 0004 #6: `--status --applied` must not read '--applied' as the status.
  if (typeof next !== 'string' || isFlagToken(next)) return undefined;
  return next;
}

/**
 * Every value supplied for a repeatable flag, in argv order, in either form.
 *
 * Only src/scripts/verify-cv-facts.mjs:422 accumulates repeats today (`--source`); every
 * other reader keeps the first and discards the rest without saying so.
 *
 * @param {string[]} args - argv slice.
 * @param {string} flag - Flag name including leading dashes.
 * @returns {string[]} Empty when the flag never appears with a value.
 */
export function flagValues(args, flag) {
  if (!Array.isArray(args)) return [];
  const found = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith(`${flag}=`)) { found.push(a.slice(flag.length + 1)); continue; }
    if (a !== flag) continue;
    const next = args[i + 1];
    if (typeof next === 'string' && !isFlagToken(next)) { found.push(next); i++; }
  }
  return found;
}

/**
 * Whether the flag appears at all, in either form.
 *
 * `flagValue` alone cannot tell an ABSENT flag from one supplied without a
 * value: both give undefined. A caller that treats the second as absent
 * silently falls back to its default — for `test-all --only` that meant running
 * the whole suite instead of refusing a filter it could not honour.
 *
 * @param {string[]} args - argv slice.
 * @param {string} flag - Flag name including leading dashes.
 * @returns {boolean}
 */
export function hasFlag(args, flag) {
  if (!Array.isArray(args)) return false;
  return args.some((a) => typeof a === 'string' && (a === flag || a.startsWith(`${flag}=`)));
}

/**
 * Fill in a command spec's defaults and append the flags every command answers.
 *
 * @param {object} spec - Command spec; see `parseFlags`.
 * @returns {object} The spec with a complete, ordered `flags` map.
 */
function normaliseSpec(spec = {}) {
  const flags = {};
  for (const [name, def] of Object.entries(spec.flags || {})) {
    flags[name] = { type: 'boolean', repeat: false, ...def };
  }
  // Appended last so they render at the bottom of --help, and only when the
  // command has not defined its own.
  for (const [name, def] of Object.entries(IMPLICIT_FLAGS)) {
    if (!flags[name]) flags[name] = { repeat: false, ...def };
  }
  return { ...spec, flags };
}

/**
 * Parse an argv slice against a command spec.
 *
 * Spec shape:
 *   {
 *     command: 'tracker set-status',       // used by renderHelp and the envelope
 *     usage: 'career-ops … <target>',      // optional; derived when absent
 *     description: '…',                    // optional
 *     flags: {
 *       '--file':    { type: 'string', short: '-f', describe: '…' },
 *       '--since':   { type: 'number', describe: '…' },
 *       '--dry-run': { type: 'boolean', describe: '…' },
 *       '--source':  { type: 'string', repeat: true, describe: '…' },
 *     },
 *     positionals: { name: 'target', min: 0, max: 2 },  // omit to reject any
 *   }
 *
 * Values are keyed by the full flag name, dashes included, so one vocabulary
 * covers the spec, the parse result, `flagValue` and the error messages.
 *
 * Absent flags: a value flag is `undefined` (never null), a boolean is `false`,
 * a repeatable flag is `[]`.
 *
 * Order of checks matters. Flag errors are collected BEFORE `--help` is
 * honoured, so `--help --bogus` reports `--bogus` instead of exiting 0 having
 * never looked at it (the ordering CodeRabbit caught on #2745/#2746, inverted
 * in src/scripts/company-history.mjs:123, src/scripts/discover-ats.mjs:908 and src/scripts/assessment-log.mjs:290).
 * Positional arity is checked AFTER, so a bare `<cmd> --help` prints help
 * rather than complaining about the argument it was never given.
 *
 * @param {string[]} argv - argv slice, without the node and script entries.
 * @param {object} spec - Command spec, as above.
 * @returns {{ok: boolean, values: object, positionals: string[], help: boolean,
 *   json: boolean, errors: Array<{code: string, message: string, flag?: string}>,
 *   exitCode: number}}
 */
export function parseFlags(argv, spec = {}) {
  const s = normaliseSpec(spec);
  const known = new Set(Object.keys(s.flags));
  const shorts = {};
  for (const [name, def] of Object.entries(s.flags)) if (def.short) shorts[def.short] = name;

  const values = {};
  const positionals = [];
  const errors = [];
  const seen = new Set();

  const finish = () => {
    for (const [name, def] of Object.entries(s.flags)) {
      if (values[name] !== undefined) continue;
      if (def.repeat) values[name] = [];
      else if (def.type === 'boolean') values[name] = false;
    }
    const help = values['--help'] === true;
    const json = values['--json'] === true;
    const ok = errors.length === 0;
    return { ok, values, positionals, help, json, errors, exitCode: ok ? EXIT.OK : EXIT.USAGE };
  };

  if (!Array.isArray(argv)) {
    errors.push({ code: 'invalid-argv', message: 'arguments must be an array of strings' });
    return finish();
  }

  let terminated = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== 'string') {
      errors.push({ code: 'invalid-argv', message: `argument ${i} is not a string` });
      continue;
    }
    if (terminated) { positionals.push(token); continue; }
    // Everything after a bare `--` is data, however it is spelled.
    if (token === '--') { terminated = true; continue; }
    if (!token.startsWith('-')) { positionals.push(token); continue; }

    const eq = token.indexOf('=');
    const head = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const name = known.has(head) ? head : shorts[head];
    const def = name ? s.flags[name] : undefined;
    if (!def) {
      errors.push({
        code: 'unknown-flag',
        flag: token,
        message: `unrecognized flag: ${token}. Valid flags: ${[...known].join(', ')}`,
      });
      continue;
    }

    if (!takesValue(def)) {
      // `--dry-run=1` is not `--dry-run`: callers test the exact token, so
      // accepting it would run with zero dry-run protection (#2778).
      if (inline !== undefined) {
        errors.push({ code: 'unexpected-value', flag: name, message: `${name} does not accept a value` });
        continue;
      }
      // A repeated boolean is idempotent — nothing the user typed is lost.
      values[name] = def.repeat ? [...(values[name] || []), true] : true;
      seen.add(name);
      continue;
    }

    let raw = inline;
    if (raw === undefined) {
      const next = argv[i + 1];
      // ADR 0004 #6. src/scripts/archive-posting.mjs:120 records the live version of this
      // bug (#3087): `--company --pipeline` set the company to "--pipeline"
      // and left pipeline mode off, silently, at exit 0.
      if (typeof next !== 'string' || isFlagToken(next)) {
        errors.push({ code: 'missing-value', flag: name, message: `${name} requires a value` });
        continue;
      }
      raw = next;
      i++;
    }
    // Audit A7: an empty value filters to something that cannot exist, which
    // reads to the user as "no results" rather than as the typo it is.
    if (raw === '') {
      errors.push({ code: 'missing-value', flag: name, message: `${name} requires a non-empty value` });
      continue;
    }

    let value = raw;
    if (def.type === 'number') {
      const n = Number(raw);
      // `Number(...) || default` swallowed every malformed operand: `--since
      // abc` and `--since 0` became the default while the user believed they
      // had scanned the window they typed, and `--since 1e400` became Infinity
      // — no window at all.
      if (!Number.isFinite(n)) {
        errors.push({ code: 'invalid-value', flag: name, message: `${name} expects a number, got "${raw}"` });
        continue;
      }
      value = n;
    }

    if (def.repeat) {
      values[name] = [...(values[name] || []), value];
    } else if (seen.has(name)) {
      // Every bare-indexOf site silently takes the first occurrence; only
      // scan.mjs:2345 reports the repeat. Reporting it is the only behaviour
      // that cannot discard something the user typed.
      errors.push({ code: 'repeated-flag', flag: name, message: `${name} was given more than once` });
      continue;
    } else {
      values[name] = value;
    }
    seen.add(name);
  }

  if (errors.length > 0) return finish();
  if (values['--help'] === true) return finish();

  const p = s.positionals;
  const label = p?.name || 'argument';
  const min = p ? (p.min ?? 0) : 0;
  const max = p ? (p.max ?? Infinity) : 0;
  if (positionals.length < min) {
    errors.push({ code: 'missing-positional', message: `expected at least ${min} <${label}>, got ${positionals.length}` });
  }
  if (positionals.length > max) {
    errors.push({
      code: 'unexpected-positional',
      message: max === 0
        ? `unexpected argument: ${positionals[0]}`
        : `expected at most ${max} <${label}>, got ${positionals.length}`,
    });
  }
  return finish();
}

/**
 * The shared --help block for a command spec.
 *
 * Every command gets the same shape, including the exit-code table: a caller
 * reading `--help` to decide how to interpret a non-zero status should not have
 * to guess which of the five codes a given command uses.
 *
 * @param {object} spec - Command spec; see `parseFlags`.
 * @returns {string} The help text, with no trailing newline.
 */
export function renderHelp(spec = {}) {
  const s = normaliseSpec(spec);
  const command = s.command || 'command';
  const lines = [];

  if (s.description) lines.push(s.description, '');

  const operand = s.positionals ? ` <${s.positionals.name || 'argument'}>` : '';
  lines.push(`Usage: ${s.usage || `${command} [options]${operand}`}`, '');

  const rows = Object.entries(s.flags).map(([name, def]) => {
    const lead = def.short ? `${def.short}, ` : '    ';
    const arg = def.type === 'string' ? ' <value>' : def.type === 'number' ? ' <n>' : '';
    const repeat = def.repeat ? ' (repeatable)' : '';
    return [`${lead}${name}${arg}${repeat}`, def.describe || ''];
  });
  const width = rows.reduce((w, [left]) => Math.max(w, left.length), 0);
  lines.push('Options:');
  for (const [left, describe] of rows) lines.push(`  ${left.padEnd(width)}  ${describe}`.trimEnd());

  lines.push('', 'Exit codes:');
  lines.push(`  ${EXIT.OK}  success — the check ran and passed`);
  lines.push(`  ${EXIT.FAILED}  the check ran and failed`);
  lines.push(`  ${EXIT.USAGE}  usage error — bad flags or unknown command`);
  lines.push(`  ${EXIT.UNVERIFIED}  could not verify — the check could not run`);
  lines.push(`  ${EXIT.CONFIG}  config or environment error`);

  return lines.join('\n');
}

/**
 * Coerce whatever a caller collected into the envelope's error shape.
 *
 * @param {*} errors - One error or a list, as strings, Errors or objects.
 * @returns {Array<{code: string, message: string}>}
 */
function normaliseErrors(errors) {
  if (errors === undefined || errors === null) return [];
  const list = Array.isArray(errors) ? errors : [errors];
  return list.map((e) => {
    if (typeof e === 'string') return { code: 'error', message: e };
    if (e instanceof Error) return { code: 'error', message: e.message };
    const { code = 'error', message = '', ...rest } = e || {};
    return { code, message: String(message), ...rest };
  });
}

/**
 * The ADR 0006 result envelope: `{ ok, command, data, warnings, errors }`.
 *
 * The two invariants are enforced rather than documented, because breaking the
 * first is precisely how an unperformed check gets reported as an empty one.
 *
 * @param {string} command - The command name, e.g. 'scan run'.
 * @param {{ok?: boolean, data?: object, warnings?: *, errors?: *}} [parts]
 * @returns {{ok: boolean, command: string, data: object, warnings: Array, errors: Array}}
 * @throws {TypeError} On a missing command, a non-boolean `ok`, a failure with
 *   no errors, or a success carrying them.
 */
export function envelope(command, { ok = true, data = {}, warnings = [], errors = [] } = {}) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new TypeError('envelope: command must be a non-empty string');
  }
  if (ok !== true && ok !== false) throw new TypeError('envelope: ok must be a boolean');
  const errs = normaliseErrors(errors);
  const warns = warnings === undefined || warnings === null
    ? []
    : (Array.isArray(warnings) ? [...warnings] : [warnings]);
  if (ok === false && errs.length === 0) {
    throw new TypeError('envelope: a failed result must carry at least one error — a check that could not run must not be reported as an empty one');
  }
  if (ok === true && errs.length > 0) {
    throw new TypeError('envelope: a successful result cannot carry errors');
  }
  return { ok, command, data: data ?? {}, warnings: warns, errors: errs };
}

/**
 * A failed envelope. `errors` may be a `parseFlags` error list verbatim —
 * extra keys such as `flag` are preserved.
 *
 * @param {string} command - The command name.
 * @param {*} errors - One error or a non-empty list.
 * @param {{data?: object, warnings?: *}} [extra] - Partial results worth
 *   keeping alongside the failure.
 * @returns {object} The envelope.
 */
export function errorEnvelope(command, errors, { data = {}, warnings = [] } = {}) {
  return envelope(command, { ok: false, data, warnings, errors });
}

/**
 * The envelope for a check that could not run — ADR 0006's one named failure
 * mode, pairing with `EXIT.UNVERIFIED`.
 *
 * "could not verify" and "nothing found" are different states. This is the only
 * way to say the first, and it refuses to be used without a reason, because a
 * reasonless "could not verify" is the same silence in different words.
 *
 * @param {string} command - The command name.
 * @param {string} reason - Why the check could not run.
 * @param {{data?: object, warnings?: *}} [extra] - Anything gathered before
 *   giving up.
 * @returns {object} The envelope.
 */
export function couldNotVerify(command, reason, { data = {}, warnings = [] } = {}) {
  const why = String(reason ?? '').trim();
  if (!why) throw new TypeError('couldNotVerify: a reason is required');
  return errorEnvelope(command, [{ code: 'could-not-verify', message: `could not verify: ${why}` }], { data, warnings });
}
