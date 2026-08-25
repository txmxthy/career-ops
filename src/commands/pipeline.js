/**
 * pipeline.js — command adapters for the `pipeline` noun (ADR 0003).
 *
 * Two scripts are assigned to this noun: verify-pipeline.mjs and
 * agent-inbox.mjs. Neither exports anything — both do their work at module
 * scope and call process.exit — so until ADR 0005 step 5 moves them into
 * `src/` and their bodies become importable, the only way to reach their logic
 * without COPYING it is across the process boundary. That is what these
 * adapters do: spawn the existing script, translate its output and exit status
 * into the ADR 0006 envelope, and hold no rules of their own. When the bodies
 * become importable, `runDelegate` is the single seam to replace — every
 * command below goes through it.
 *
 * Translation, not inheritance. ADR 0006 is explicit that where the old and new
 * exit codes conflict the adapter translates, and there are three conflicts
 * worth naming because each is the "nothing found" defect the ADR bans:
 *
 *   1. verify-pipeline.mjs exits 0 with "No applications.md found. This is
 *      normal for a fresh setup." — a health check that never ran, reported as
 *      a clean pipeline. Here that is EXIT.UNVERIFIED.
 *   2. verify-pipeline.mjs's fourteen checks are prose. A crash, a truncated
 *      run or a changed glyph vocabulary all read as "no errors found" to a
 *      caller that only looks at the exit status. Here the parsed ❌/⚠️ counts
 *      are cross-checked against the script's own summary line and against its
 *      exit status; a disagreement is EXIT.UNVERIFIED, never a green.
 *   3. agent-inbox.mjs's `resolve` says "no pending item #1 (0 pending)" and
 *      exits 1 whether the queue is empty or the queue FILE does not exist.
 *      The first is a real negative finding (1); the second could not run (3).
 *
 * Naming (ADR 0003 calls the classifier a starting point, not a finished API):
 *   - `pipeline verify-pipeline` → `pipeline verify`. The noun was stuttering.
 *   - `pipeline agent-inbox` → `pipeline inbox-add` / `inbox-list` /
 *     `inbox-resolve`. agent-inbox.mjs is a sub-CLI with three actions and
 *     three different result shapes; one verb would hide all three behind a
 *     single --help, which is the prose-parsing failure ADR 0006 exists to
 *     remove. Split, the top-level enumeration names each one.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseFlags, renderHelp, envelope, errorEnvelope, couldNotVerify, EXIT,
} from '../core/flags.js';

/** Repo root: src/commands/pipeline.js → src/commands → src → root. */
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** spawnSync's 1 MB default truncates a big tracker's report and sets ENOBUFS,
 *  which would surface as "could not verify" on a run that was fine. */
const MAX_BUFFER = 32 * 1024 * 1024;

/** A hung child must become a reported failure, not a hang. agent-inbox's own
 *  lock budget is 30s; this is comfortably past it. */
const TIMEOUT_MS = 120_000;

/**
 * Fill in the parts of a run context the caller did not supply.
 *
 * Everything the adapters touch outside their own arguments comes through
 * here, so a test can drive them without a repo, a queue or a real child.
 */
function context(ctx = {}) {
  return {
    root: ctx.root ?? ROOT,
    cwd: ctx.cwd ?? process.cwd(),
    env: ctx.env ?? process.env,
    node: ctx.node ?? process.execPath,
    spawn: ctx.spawn ?? spawnSync,
  };
}

/**
 * Locate a delegate script, at root or already moved under `src/`.
 *
 * ADR 0005 step 5 moves both of these into `src/` with `git mv`. Checking both
 * places means these adapters do not break in the window between that move and
 * the commit that rewires them.
 *
 * @returns {string|null} Absolute path, or null when the script is missing.
 */
function findDelegate(name, ctx) {
  for (const candidate of [join(ctx.root, name), join(ctx.root, 'src', name)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run a delegate script and return its raw result.
 *
 * @returns {{ok: true, status: number, stdout: string, stderr: string}
 *   | {ok: false, reason: string}} `ok: false` is always a could-not-run: the
 *   process failed to start, was killed, timed out or overflowed its buffer.
 */
function runDelegate(script, args, ctx) {
  const res = ctx.spawn(ctx.node, [script, ...args], {
    cwd: ctx.cwd,
    env: ctx.env,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: TIMEOUT_MS,
  });
  if (res?.error) return { ok: false, reason: `${script} could not be run (${res.error.code || res.error.message})` };
  // status is null when the child died on a signal — including the SIGTERM
  // spawnSync sends on timeout. An unread null compares equal to nothing and
  // would fall through the status checks below as "not 1, so fine".
  if (res?.status === null || res?.status === undefined) {
    return { ok: false, reason: `${script} was killed${res?.signal ? ` by ${res.signal}` : ''} before it finished` };
  }
  return { ok: true, status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * The shape every `run` returns. The facade prints `text` or `envelope`
 * depending on `json`, then exits with `exitCode`.
 *
 * @typedef {{exitCode: number, envelope: object, text: string, json: boolean}} CommandResult
 */

/** A successful result. */
function ok(command, { data = {}, warnings = [], text = '', json = false, exitCode = EXIT.OK } = {}) {
  return { exitCode, json, text, envelope: envelope(command, { ok: true, data, warnings }) };
}

/** A failed result. `errors` may be a parseFlags error list verbatim. */
function bad(command, errors, { data = {}, warnings = [], text, json = false, exitCode = EXIT.FAILED } = {}) {
  const env = errorEnvelope(command, errors, { data, warnings });
  return {
    exitCode,
    json,
    text: text ?? `${env.errors.map((e) => e.message).join('\n')}\n`,
    envelope: env,
  };
}

/** A check that could not run: EXIT.UNVERIFIED and a reason, never an empty pass. */
function unverified(command, reason, { data = {}, warnings = [], json = false } = {}) {
  const env = couldNotVerify(command, reason, { data, warnings });
  return { exitCode: EXIT.UNVERIFIED, json, text: `${env.errors[0].message}\n`, envelope: env };
}

/** Usage error: EXIT.USAGE, with the help text so the caller can correct it. */
function usage(command, errors, spec, json = false) {
  const env = errorEnvelope(command, errors);
  return {
    exitCode: EXIT.USAGE,
    json,
    text: `${env.errors.map((e) => e.message).join('\n')}\n\n${renderHelp(spec)}\n`,
    envelope: env,
  };
}

/** `--help`, in both modes: prose prints it, --json carries it in `data`. */
function help(spec, json) {
  const text = renderHelp(spec);
  return ok(spec.command, { data: { help: text }, text: `${text}\n`, json });
}

/** stderr is worth keeping on a success — a delegate that complained and still
 *  exited 0 is exactly the half-silence this refactor is removing. */
const stderrWarnings = (stderr) => {
  const trimmed = String(stderr || '').trim();
  return trimmed ? [trimmed] : [];
};

// ── pipeline verify ──────────────────────────────────────────────────

const VERIFY_SPEC = {
  command: 'pipeline verify',
  usage: 'career-ops pipeline verify [--json]',
  description: [
    'Check pipeline integrity: canonical statuses, duplicate company+role rows,',
    'duplicate tracker numbers, report links, score formats, row shape, pending',
    'TSVs, stale reservation sentinels, orphan and duplicate reports, Via channel',
    'consistency, tracker/active-interviews sync and the follow-ups schema.',
    '',
    '--json data: { entries, passed[], counts: { errors, warnings } }.',
    'Findings are in the envelope\'s own errors[] and warnings[].',
  ].join('\n'),
  flags: {},
};

/** verify-pipeline.mjs's line vocabulary. Anchored: an inline glyph inside a
 *  company name must not read as a second finding. */
// The variation selector after ⚠ is optional in the pattern: the delegate emits
// U+26A0 U+FE0F, and a pattern that hard-codes the pair silently matches nothing
// if the emoji is ever normalised — which would read as "no warnings".
const VERIFY_LINE = /^(\u274C|\u26A0|\u2705)\uFE0F?\s+(.*)$/;
const VERIFY_HEADER = /^\u{1F4CA} Checking (\d+) entries/mu;
const VERIFY_SUMMARY = /^\u{1F4CA} Pipeline Health: (\d+) errors?, (\d+) warnings?\s*$/mu;
/** The fresh-setup early exit — status 0 for a check that never ran. */
const VERIFY_NO_TRACKER = /No applications\.md found/;

async function runVerify(argv = [], rawCtx = {}) {
  const spec = VERIFY_SPEC;
  const parsed = parseFlags(argv, spec);
  if (!parsed.ok) return usage(spec.command, parsed.errors, spec, parsed.json);
  if (parsed.help) return help(spec, parsed.json);

  const ctx = context(rawCtx);
  const json = parsed.json;
  const script = findDelegate('verify-pipeline.mjs', ctx);
  if (!script) {
    return unverified(spec.command, `verify-pipeline.mjs not found under ${ctx.root} — the integrity checks did not run`, { json });
  }

  const res = runDelegate(script, [], ctx);
  if (!res.ok) return unverified(spec.command, res.reason, { json });

  const stdout = res.stdout;
  if (VERIFY_NO_TRACKER.test(stdout)) {
    // The script calls this "normal for a fresh setup" and exits 0. It is
    // normal, and it is still not a verified pipeline: fourteen checks were
    // skipped. Reporting it as a pass is the exact conflation ADR 0006 bans.
    return unverified(spec.command, 'no tracker found — none of the pipeline checks could run (evaluate an offer, or set CAREER_OPS_TRACKER)', { json });
  }

  const errors = [];
  const warnings = [];
  const passed = [];
  for (const line of stdout.split('\n')) {
    const m = VERIFY_LINE.exec(line.trimEnd());
    if (!m) continue;
    if (m[1] === '\u274C') errors.push({ code: 'pipeline-check-failed', message: m[2].trim() });
    else if (m[1] === '\u26A0') warnings.push(m[2].trim());
    else passed.push(m[2].trim());
  }

  const header = VERIFY_HEADER.exec(stdout);
  const summary = VERIFY_SUMMARY.exec(stdout);

  // Three independent statements about the same run: the glyph lines, the
  // script's own tally, and its exit status. A caller that trusts only the
  // status cannot tell a crash from a clean pipeline, so any disagreement is
  // reported as unverified rather than resolved in favour of the quiet one.
  const contractBreaks = [];
  if (!summary) contractBreaks.push('no "Pipeline Health" summary line');
  else if (Number(summary[1]) !== errors.length || Number(summary[2]) !== warnings.length) {
    contractBreaks.push(`summary says ${summary[1]} errors / ${summary[2]} warnings but ${errors.length} / ${warnings.length} were reported`);
  }
  if (passed.length === 0 && errors.length === 0 && warnings.length === 0) {
    contractBreaks.push('no check lines at all');
  }
  if ((res.status === 0) !== (errors.length === 0)) {
    contractBreaks.push(`exit ${res.status} with ${errors.length} error line(s)`);
  }
  if (contractBreaks.length > 0) {
    return unverified(
      spec.command,
      `verify-pipeline.mjs output could not be read (${contractBreaks.join('; ')})${res.stderr.trim() ? `: ${res.stderr.trim()}` : ''}`,
      { data: { entries: header ? Number(header[1]) : null, passed }, json },
    );
  }

  const data = {
    entries: header ? Number(header[1]) : null,
    passed,
    counts: { errors: errors.length, warnings: warnings.length },
  };
  const text = stdout.endsWith('\n') || stdout === '' ? stdout : `${stdout}\n`;
  if (errors.length > 0) {
    return bad(spec.command, errors, { data, warnings, text, json, exitCode: EXIT.FAILED });
  }
  return ok(spec.command, { data, warnings: [...warnings, ...stderrWarnings(res.stderr)], text, json });
}

// ── the agent inbox ──────────────────────────────────────────────────

/**
 * Where agent-inbox.mjs will look for the queue.
 *
 * Duplicated from agent-inbox.mjs:37 rather than derived, on purpose and
 * unhappily: it is cwd-relative there, and resolving it through
 * src/core/store.js's data-root helpers would point somewhere else. Parity with
 * the delegate is what makes the exit-3 check below true. This constant is the
 * one thing in this file that belongs in store.js as `resolveInboxPath` once
 * the queue's own path resolution moves there.
 */
function inboxPath(ctx) {
  const configured = ctx.env.CAREER_OPS_INBOX || 'data/agent-inbox.md';
  return isAbsolute(configured) ? configured : resolvePath(ctx.cwd, configured);
}

const INBOX_ITEM = /^\s*(\d+)\.\s+\[([ xX])\]\s*(.*)$/;

const INBOX_ADD_SPEC = {
  command: 'pipeline inbox-add',
  usage: 'career-ops pipeline inbox-add [--json] [--] <request>',
  description: [
    'Queue a request for the agent to action at the start of the next session.',
    'The request is joined from all remaining arguments; use -- before a request',
    'that starts with a dash.',
    '',
    '--json data: { queued }.',
  ].join('\n'),
  flags: {},
  positionals: { name: 'request', min: 1, max: Infinity },
};

const INBOX_LIST_SPEC = {
  command: 'pipeline inbox-list',
  usage: 'career-ops pipeline inbox-list [--all] [--json]',
  description: [
    'List queued agent-inbox items — pending only by default.',
    '',
    '--json data: { exists, all, items[{ n, done, text }] }. `exists: false` with',
    'a warning means there is no queue file yet, which is not the same as an',
    'empty queue.',
  ].join('\n'),
  flags: {
    '--all': { type: 'boolean', describe: 'Include already-resolved items' },
  },
};

const INBOX_RESOLVE_SPEC = {
  command: 'pipeline inbox-resolve',
  usage: 'career-ops pipeline inbox-resolve [--result <value>] [--json] <item>',
  description: [
    'Mark a pending inbox item resolved. <item> is its 1-based number in',
    '`inbox-list` (pending view), so list then resolve line up.',
    '',
    '--json data: { resolved, text, result }.',
  ].join('\n'),
  flags: {
    '--result': { type: 'string', describe: 'One-line result appended to the item' },
  },
  positionals: { name: 'item', min: 1, max: 1 },
};

/** Shared prologue: parse, answer --help, locate the delegate. Returns either a
 *  finished CommandResult or the pieces the caller needs to continue. */
function prepareInbox(spec, argv, rawCtx) {
  const parsed = parseFlags(argv, spec);
  if (!parsed.ok) return { done: usage(spec.command, parsed.errors, spec, parsed.json) };
  if (parsed.help) return { done: help(spec, parsed.json) };

  const ctx = context(rawCtx);
  const script = findDelegate('agent-inbox.mjs', ctx);
  if (!script) {
    return { done: unverified(spec.command, `agent-inbox.mjs not found under ${ctx.root} — the queue could not be reached`, { json: parsed.json }) };
  }
  return { parsed, ctx, script, json: parsed.json };
}

async function runInboxAdd(argv = [], rawCtx = {}) {
  const spec = INBOX_ADD_SPEC;
  const prep = prepareInbox(spec, argv, rawCtx);
  if (prep.done) return prep.done;
  const { parsed, ctx, script, json } = prep;

  const res = runDelegate(script, ['add', ...parsed.positionals], ctx);
  if (!res.ok) return unverified(spec.command, res.reason, { json });

  const stderr = res.stderr.trim();
  if (res.status !== 0) {
    // "add needs a request" is the delegate's own arity check reaching exit 1.
    // ADR 0006 gives usage errors code 2; everything else that stops the append
    // — a lock timeout, an unwritable data/ — stopped the write from running.
    if (/needs a request/.test(stderr)) {
      return usage(spec.command, [{ code: 'missing-positional', message: stderr || 'add needs a request' }], spec, json);
    }
    return unverified(spec.command, `the request was not queued: ${stderr || `agent-inbox.mjs exited ${res.status}`}`, { json });
  }

  const queued = /^Queued: (.*)$/m.exec(res.stdout);
  if (!queued) {
    return unverified(spec.command, `agent-inbox.mjs exited 0 without confirming the append${stderr ? `: ${stderr}` : ''} — the request may not be queued`, { json });
  }
  return ok(spec.command, {
    data: { queued: queued[1] },
    warnings: stderrWarnings(res.stderr),
    text: res.stdout,
    json,
  });
}

async function runInboxList(argv = [], rawCtx = {}) {
  const spec = INBOX_LIST_SPEC;
  const prep = prepareInbox(spec, argv, rawCtx);
  if (prep.done) return prep.done;
  const { parsed, ctx, script, json } = prep;

  const all = parsed.values['--all'] === true;
  const res = runDelegate(script, all ? ['list', '--all'] : ['list'], ctx);
  if (!res.ok) return unverified(spec.command, res.reason, { json });
  if (res.status !== 0) {
    return unverified(spec.command, `agent-inbox.mjs exited ${res.status} listing the queue${res.stderr.trim() ? `: ${res.stderr.trim()}` : ''}`, { json });
  }

  const items = [];
  for (const line of res.stdout.split('\n')) {
    const m = INBOX_ITEM.exec(line);
    if (m) items.push({ n: Number(m[1]), done: m[2].toLowerCase() === 'x', text: m[3].trim() });
  }

  // "No pending items." reads the same whether the queue is empty or the file
  // is missing — the second usually means CAREER_OPS_INBOX points somewhere
  // unintended. Listing did run, so this is a warning and not exit 3, but the
  // two states get different answers.
  const path = inboxPath(ctx);
  const exists = existsSync(path);
  const warnings = [...stderrWarnings(res.stderr)];
  if (!exists) warnings.push(`no queue file at ${path} — nothing has been queued yet`);

  return ok(spec.command, { data: { exists, all, items }, warnings, text: res.stdout, json });
}

async function runInboxResolve(argv = [], rawCtx = {}) {
  const spec = INBOX_RESOLVE_SPEC;
  const prep = prepareInbox(spec, argv, rawCtx);
  if (prep.done) return prep.done;
  const { parsed, ctx, script, json } = prep;

  // Without a queue file the delegate says "no pending item #N (0 pending)" and
  // exits 1 — the code reserved for a real negative finding, for a resolve that
  // never had anything to run against.
  const path = inboxPath(ctx);
  if (!existsSync(path)) {
    return unverified(spec.command, `no queue file at ${path} — there is nothing to resolve against`, { json });
  }

  const item = parsed.positionals[0];
  const result = parsed.values['--result'];
  const args = ['resolve', item, ...(result === undefined ? [] : ['--result', result])];
  const res = runDelegate(script, args, ctx);
  if (!res.ok) return unverified(spec.command, res.reason, { json });

  const stderr = res.stderr.trim();
  if (res.status !== 0) {
    if (/1-based item number/.test(stderr)) {
      return usage(spec.command, [{ code: 'invalid-value', message: stderr }], spec, json);
    }
    if (/no pending item/.test(stderr)) {
      // The queue exists and the number is out of range: the operation ran and
      // failed. That is a finding, not an unverified check.
      return bad(spec.command, [{ code: 'no-such-item', message: stderr }], { json, exitCode: EXIT.FAILED });
    }
    return unverified(spec.command, `the item was not resolved: ${stderr || `agent-inbox.mjs exited ${res.status}`}`, { json });
  }

  const resolved = /^Resolved #(\d+): (.*)$/m.exec(res.stdout);
  if (!resolved) {
    return unverified(spec.command, `agent-inbox.mjs exited 0 without confirming the resolve${stderr ? `: ${stderr}` : ''} — the item may still be pending`, { json });
  }
  return ok(spec.command, {
    data: { resolved: Number(resolved[1]), text: resolved[2], result: result ?? null },
    warnings: stderrWarnings(res.stderr),
    text: res.stdout,
    json,
  });
}

// ── exports ──────────────────────────────────────────────────────────

/** One entry per command. `help` is the rendered text; `flags` is the spec's
 *  flag map so the facade can enumerate without re-deriving it. */
const commands = {
  verify: {
    run: runVerify,
    help: renderHelp(VERIFY_SPEC),
    flags: VERIFY_SPEC.flags,
    usage: VERIFY_SPEC.usage,
    summary: 'Check pipeline integrity across the tracker, reports and follow-ups',
  },
  'inbox-add': {
    run: runInboxAdd,
    help: renderHelp(INBOX_ADD_SPEC),
    flags: INBOX_ADD_SPEC.flags,
    usage: INBOX_ADD_SPEC.usage,
    summary: 'Queue a request for the agent to action next session',
  },
  'inbox-list': {
    run: runInboxList,
    help: renderHelp(INBOX_LIST_SPEC),
    flags: INBOX_LIST_SPEC.flags,
    usage: INBOX_LIST_SPEC.usage,
    summary: 'List queued agent-inbox items',
  },
  'inbox-resolve': {
    run: runInboxResolve,
    help: renderHelp(INBOX_RESOLVE_SPEC),
    flags: INBOX_RESOLVE_SPEC.flags,
    usage: INBOX_RESOLVE_SPEC.usage,
    summary: 'Mark a pending inbox item resolved',
  },
};

export const noun = 'pipeline';
export { commands };
export default { noun, commands };
