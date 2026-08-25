/**
 * followup.js — the `career-ops followup <verb>` command adapters.
 *
 * Seven verbs, one per ADR 0003 row assigned to the `followup` noun. Each is a
 * thin adapter: parse argv with src/core/flags.js, resolve paths with
 * src/core/store.js, call the capability's exported functions, and map the
 * result to the ADR 0006 envelope plus an exit code. No business logic lives
 * here — where a capability's logic is private to its root script, the verb
 * exposes the part that IS exported and `--help` names what is missing.
 *
 * Verb names differ from ADR 0003's classifier where its output read as a tool
 * name rather than an action (the ADR calls itself "a starting point, not a
 * finished API"):
 *
 *   invite-match  -> match-invite     verb first, like every other verb
 *   paste-reply   -> add-reply        "paste" described the old stdin prompt,
 *                                     not what the command does
 *   reply-matcher -> match-replies    a module name, not an action
 *   reply-watch   -> review-replies   "watch" implies a daemon; it reviews once
 *
 * `cadence`, `seed` and `contacts` are kept as the ADR names them.
 *
 * ## Contract with the facade (src/cli.js)
 *
 * Every verb exports `{ run, help, flags }`:
 *
 *   run(argv, { env, stdin } = {}) -> Promise<{ exitCode, json, text }>
 *     `argv` is the slice AFTER `followup <verb>`. `json` is always the ADR
 *     0006 envelope; `text` is the prose rendering. The facade prints `json`
 *     when the parse set `--json`, otherwise `text`, and exits `exitCode`.
 *     Nothing here writes to stdout or calls process.exit, which is what makes
 *     every branch testable in-process.
 *   help   the rendered `--help` block (a string).
 *   flags  the flag spec, so the facade can enumerate without re-parsing.
 *
 * ## Why the legacy imports are shielded
 *
 * contacts.mjs, followup-cadence.mjs and invite-match.mjs read `process.argv`
 * at module scope — contacts.mjs even runs validateFlags there, which exits the
 * process on a flag it does not know. Importing them from a facade whose argv
 * is `followup contacts --json` would kill the CLI before the adapter ran. Each
 * dynamic import therefore swaps in an argv those modules can accept, and
 * restores it afterwards. `process.argv[1]` is deliberately left as the
 * facade's own path so none of their `import.meta.url === argv[1]` main guards
 * fires. The real fix is making those modules argv-free (ADR 0002's
 * "importable, argv-free core"); until then this is the adapter's job.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseFlags,
  renderHelp,
  EXIT,
  envelope,
  errorEnvelope,
  couldNotVerify,
} from '../core/flags.js';
import {
  readFile,
  readText,
  resolveTrackerPath,
  resolveFollowupsPath,
  resolveDataRoot,
  workspaceDir,
} from '../core/store.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ── adapter plumbing ────────────────────────────────────────────────

/**
 * Import a module that reads `process.argv` at module scope, with an argv it
 * can accept. See the header note; `process.argv[1]` is left alone so no main
 * guard fires.
 *
 * @param {string} specifier - Module specifier, relative to this file.
 * @param {string[]} [argv] - argv slice the module should see.
 * @returns {Promise<object>} The module namespace.
 */
async function importShielded(specifier, argv = []) {
  const saved = process.argv;
  process.argv = [saved[0], saved[1], ...argv];
  try {
    return await import(specifier);
  } finally {
    process.argv = saved;
  }
}

/** A verb's data directory, following any `CAREER_OPS_TRACKER` redirection. */
const dataDir = (env) => workspaceDir('data', resolveDataRoot(ROOT, env));

/** The result a `run` returns. `json` is always an envelope. */
const result = (exitCode, json, text) => ({ exitCode, json, text });

/** Envelope + exit 3 for a check that could not run (ADR 0006). */
const unverified = (command, reason, extra) => {
  const json = couldNotVerify(command, reason, extra);
  return result(EXIT.UNVERIFIED, json, `${command}: could not verify — ${reason}`);
};

/** Envelope + exit 2 for a usage error. */
const usage = (command, message) => {
  const json = errorEnvelope(command, [{ code: 'usage', message }]);
  return result(EXIT.USAGE, json, `${command}: ${message}`);
};

/**
 * The two steps every verb starts with: parse, then answer `--help` and bad
 * flags. Returns the parse when the verb should carry on, or a finished result.
 *
 * Errors are checked before `--help` because flags.js collects them in that
 * order — `--help --bogus` must report `--bogus`.
 *
 * @param {string[]} argv - argv slice after `followup <verb>`.
 * @param {object} spec - Command spec for parseFlags/renderHelp.
 * @returns {{parsed: object}|{done: object}}
 */
function begin(argv, spec) {
  const parsed = parseFlags(argv, spec);
  if (!parsed.ok) {
    const json = errorEnvelope(spec.command, parsed.errors);
    const lines = parsed.errors.map((e) => `${spec.command}: ${e.message}`);
    return { done: result(EXIT.USAGE, json, [...lines, '', renderHelp(spec)].join('\n')) };
  }
  if (parsed.help) {
    const json = envelope(spec.command, { data: { help: renderHelp(spec) } });
    return { done: result(EXIT.OK, json, renderHelp(spec)) };
  }
  return { parsed };
}

/**
 * Text a verb was handed on `--file` or on stdin.
 *
 * A TTY stdin with no `--file` is a usage error, not an empty read: waiting on
 * a terminal that has nothing to give is the hang this replaces.
 *
 * @param {string} command - Command name, for the envelope.
 * @param {string|undefined} file - The `--file` value, if any.
 * @param {{isTTY?: boolean, fd?: number}} stdin - Injectable stdin.
 * @returns {{text: string}|{done: object}}
 */
function readInput(command, file, stdin) {
  if (file !== undefined) {
    const { exists, content } = readFile(file);
    if (!exists) return { done: unverified(command, `no such file: ${file}`) };
    return { text: content };
  }
  if (stdin.isTTY) {
    return { done: usage(command, 'no input — pass --file <path> or pipe the text on stdin') };
  }
  try {
    return { text: readFileSync(stdin.fd ?? 0, 'utf-8') };
  } catch (err) {
    return { done: unverified(command, `could not read stdin: ${err.message}`) };
  }
}

/** Tracker rows, parsed with the tracker's own column resolver. */
async function loadTrackerRows(command, env) {
  const path = resolveTrackerPath(ROOT, env);
  const { exists, content } = readFile(path);
  if (!exists) return { done: unverified(command, `no tracker at ${path}`) };
  const { resolveColumns, parseTrackerRow } = await import('../../tracker-parse.mjs');
  const lines = content.split('\n');
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (row) rows.push(row);
  }
  return { rows, path };
}

/** The reply candidates store, or a finished could-not-verify result. */
function loadCandidates(command, file, env) {
  const path = file ?? join(dataDir(env), 'reply-candidates.json');
  const { exists, content } = readFile(path);
  if (!exists) return { done: unverified(command, `no reply candidates at ${path}`) };
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { done: unverified(command, `${path} is not valid JSON: ${err.message}`) };
  }
  if (!Array.isArray(parsed)) {
    return { done: unverified(command, `${path} is not a JSON array of candidates`) };
  }
  return { candidates: parsed, path };
}

/** Follow-up history rows, empty when the file is absent. */
async function loadFollowups(env) {
  const content = readText(resolveFollowupsPath(ROOT, env));
  if (!content) return [];
  const { parseFollowups } = await importShielded('../../followup-cadence.mjs');
  return parseFollowups(content);
}

// ── followup cadence ────────────────────────────────────────────────

const cadenceSpec = {
  command: 'followup cadence',
  usage: 'career-ops followup cadence [--overdue-only] [--applied-days <n>]',
  description:
    'Follow-up cadence for every actionable application: which are overdue, urgent,\n'
    + 'waiting or cold, and the date each is next due.',
  flags: {
    '--overdue-only': { type: 'boolean', describe: 'List only the overdue and urgent entries' },
    '--applied-days': { type: 'number', describe: 'Override the applied_first cadence, in whole days' },
  },
};

async function runCadence(argv, { env = process.env, stdin = process.stdin } = {}) {
  void stdin;
  const started = begin(argv, cadenceSpec);
  if (started.done) return started.done;
  const { values } = started.parsed;

  const appliedDays = values['--applied-days'];
  if (appliedDays !== undefined && !(Number.isInteger(appliedDays) && appliedDays >= 0)) {
    return usage(cadenceSpec.command, `--applied-days requires a non-negative whole number, got "${appliedDays}"`);
  }
  const overdueOnly = values['--overdue-only'] === true;

  const trackerPath = resolveTrackerPath(ROOT, env);
  const tracker = readFile(trackerPath);
  if (!tracker.exists) return unverified(cadenceSpec.command, `no tracker at ${trackerPath}`);

  // followup-cadence.mjs builds its cadence config from process.argv once, at
  // import time, and analyzeFromContent closes over that singleton — so both
  // flags have to reach it through argv, and a differing pair needs its own
  // module instance. The query string is the cache key. Making the config a
  // parameter of analyzeFromContent removes the need for all of this.
  const shieldArgv = [
    ...(overdueOnly ? ['--overdue-only'] : []),
    ...(appliedDays !== undefined ? ['--applied-days', String(appliedDays)] : []),
  ];
  const key = `${overdueOnly ? 1 : 0}-${appliedDays ?? 'default'}`;
  const { analyzeFromContent } = await importShielded(`../../followup-cadence.mjs?cadence=${key}`, shieldArgv);

  const followupsContent = readText(resolveFollowupsPath(ROOT, env));
  const analysis = analyzeFromContent(tracker.content, followupsContent);
  // analyzeFromContent reports an unusable tracker through `error`. That is a
  // check that could not run, not an empty finding — ADR 0006 keeps them apart.
  if (analysis.error) return unverified(cadenceSpec.command, analysis.error, { data: { trackerPath } });

  const json = envelope(cadenceSpec.command, { data: analysis });
  const m = analysis.metadata;
  const head = `${m.actionable} actionable of ${m.totalTracked} tracked — `
    + `${m.urgent} urgent, ${m.overdue} overdue, ${m.waiting} waiting, ${m.cold} cold, ${m.retired} retired`;
  const rows = analysis.entries.map(
    (e) => `  [${e.urgency}] #${e.num} ${e.company} — ${e.role}: next ${e.nextFollowupDate ?? 'none'}`,
  );
  return result(EXIT.OK, json, [head, ...rows].join('\n'));
}

// ── followup seed ───────────────────────────────────────────────────

const seedSpec = {
  command: 'followup seed',
  usage: 'career-ops followup seed <appNum> [--date YYYY-MM-DD] [--force] [--dry-run]',
  description:
    'Pin the next follow-up date for an application, or --backfill every Applied row\n'
    + 'that has no pin yet. Writes under the follow-ups lock.',
  flags: {
    '--date': { type: 'string', describe: 'Apply date to count the cadence from (YYYY-MM-DD)' },
    '--force': { type: 'boolean', describe: 'Seed even when the row is not Applied, or re-seed one already pinned' },
    '--dry-run': { type: 'boolean', describe: 'Report what would be written without writing it' },
    '--backfill': { type: 'boolean', describe: 'Seed every unpinned Applied row instead of one appNum' },
  },
  positionals: { name: 'appNum', min: 0, max: 1 },
};

/** SeedError codes to ADR 0006 exit codes. */
const SEED_EXIT = {
  USAGE: EXIT.USAGE,
  INVALID_DATE: EXIT.USAGE,
  NOT_APPLIED: EXIT.FAILED,   // ran, and refused for a real reason
  ROW_NOT_FOUND: EXIT.UNVERIFIED, // nothing to check against
  LOCK_TIMEOUT: EXIT.UNVERIFIED,  // never got to run
};

async function runSeed(argv, { env = process.env, stdin = process.stdin } = {}) {
  void env;
  void stdin;
  const started = begin(argv, seedSpec);
  if (started.done) return started.done;
  const { values, positionals } = started.parsed;

  const backfill = values['--backfill'] === true;
  const date = values['--date'];
  if (backfill && positionals.length > 0) {
    return usage(seedSpec.command, '--backfill does not take an appNum');
  }
  if (backfill && date !== undefined) {
    return usage(seedSpec.command, '--date cannot be combined with --backfill — each row resolves its own apply date');
  }

  let appNum = null;
  if (!backfill) {
    if (positionals.length !== 1) return usage(seedSpec.command, 'expected one <appNum>, or --backfill');
    const raw = positionals[0];
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      return usage(seedSpec.command, `invalid appNum: ${raw}`);
    }
    appNum = Number(raw);
  }

  const seed = await import('../../followup-seed.mjs');
  const opts = { force: values['--force'] === true, dryRun: values['--dry-run'] === true };
  try {
    if (backfill) {
      const data = await seed.seedBackfill(opts);
      const tag = opts.dryRun ? ' [dry-run]' : '';
      const lines = [
        `Backfill${tag}: seeded ${data.seeded.length}, skipped ${data.skipped.length}`,
        ...data.seeded.map((s) => `  + #${s.appNum}: next ${s.nextDate}`),
        ...data.skipped.map((s) => `  - #${s.appNum}: ${s.reason}`),
      ];
      return result(EXIT.OK, envelope(seedSpec.command, { data }), lines.join('\n'));
    }
    const data = await seed.seedFollowup(appNum, { ...opts, date });
    const tag = data.dryRun ? ' [dry-run]' : '';
    const text = data.seeded
      ? `Seeded #${data.appNum}: next follow-up ${data.nextDate} (applied ${data.appliedDate})${tag}`
      : `#${data.appNum} already seeded — no-op (${data.reason})${tag}`;
    return result(EXIT.OK, envelope(seedSpec.command, { data }), text);
  } catch (err) {
    const code = err?.code || 'ERROR';
    const exitCode = SEED_EXIT[code] ?? EXIT.FAILED;
    const json = exitCode === EXIT.UNVERIFIED
      ? couldNotVerify(seedSpec.command, err.message)
      : errorEnvelope(seedSpec.command, [{ code, message: err.message }]);
    return result(exitCode, json, `${seedSpec.command}: ${err.message}`);
  }
}

// ── followup contacts ───────────────────────────────────────────────

const contactsSpec = {
  command: 'followup contacts',
  usage: 'career-ops followup contacts',
  description:
    'The recruiter/hiring-manager phonebook from data/contacts.tsv, with the row-level\n'
    + 'quality problems that would otherwise be silently skipped.\n'
    + '\n'
    + 'vCard export is not here yet: contacts.mjs keeps its writer and its\n'
    + 'path-containment guard private, and an adapter must not re-implement either.\n'
    + 'Use `node contacts.mjs --vcf [path]` until that moves into core.',
  flags: {},
};

async function runContacts(argv, { env = process.env, stdin = process.stdin } = {}) {
  void stdin;
  const started = begin(argv, contactsSpec);
  if (started.done) return started.done;

  const path = join(dataDir(env), 'contacts.tsv');
  const { exists, content } = readFile(path);
  if (!exists) return unverified(contactsSpec.command, `no contacts file at ${path}`);

  const { parseContacts } = await importShielded('../../contacts.mjs');
  const { contacts, quality } = parseContacts(content);

  // Quality problems are warnings, not failures: the contacts that did parse
  // are a real result, and the skipped rows have to stay visible either way.
  const warnings = [];
  if (quality.shortRows.length) warnings.push(`${quality.shortRows.length} row(s) with fewer than 4 cells — skipped`);
  if (quality.missingRequired.length) warnings.push(`${quality.missingRequired.length} row(s) missing name or company — skipped`);
  if (quality.invalidTypes.length) warnings.push(`${quality.invalidTypes.length} contact(s) with an off-enum type — kept`);
  if (quality.duplicates.length) warnings.push(`${quality.duplicates.length} duplicated contact(s) — the last line wins`);

  const json = envelope(contactsSpec.command, {
    data: { path, contacts, quality, total: contacts.length },
    warnings,
  });
  const lines = [
    `${contacts.length} contact(s) in ${path}`,
    ...contacts.map((c) => `  ${c.name} — ${c.company}${c.type ? ` (${c.type})` : ''}${c.email ? ` <${c.email}>` : ''}`),
    ...warnings.map((w) => `  ! ${w}`),
  ];
  return result(EXIT.OK, json, lines.join('\n'));
}

// ── followup match-invite (ADR 0003: invite-match) ──────────────────

const matchInviteSpec = {
  command: 'followup match-invite',
  usage: 'career-ops followup match-invite [--file <path>] [--apply [--id <n>]]',
  description:
    'Classify an interview invite or rejection email and match it to a tracker row.\n'
    + 'Reads the email from --file, or from stdin when it is piped.\n'
    + '\n'
    + '--apply advances a confidently matched row to Rejected and nothing else. It\n'
    + 'refuses (exit 1) on a non-rejection, on no match, on an ambiguous match, and\n'
    + 'on a sole match below the confidence bar — pass --id to confirm one.',
  flags: {
    '--file': { type: 'string', describe: 'Read the email text from this file instead of stdin' },
    '--apply': { type: 'boolean', describe: 'Advance the matched row to Rejected' },
    '--id': { type: 'number', describe: 'Tracker # to apply to, when the match is ambiguous' },
  },
};

async function runMatchInvite(argv, { env = process.env, stdin = process.stdin } = {}) {
  void env;
  const started = begin(argv, matchInviteSpec);
  if (started.done) return started.done;
  const { values } = started.parsed;

  const id = values['--id'];
  if (id !== undefined && !(Number.isInteger(id) && id > 0)) {
    return usage(matchInviteSpec.command, `--id must be a positive tracker #, got "${id}"`);
  }

  const input = readInput(matchInviteSpec.command, values['--file'], stdin);
  if (input.done) return input.done;
  if (input.text.trim() === '') {
    return unverified(matchInviteSpec.command, 'the email text is empty — nothing to classify');
  }

  const invite = await importShielded('../../invite-match.mjs');
  const analysis = invite.analyzeInvite(input.text);

  const summary = `${analysis.classification} — company "${analysis.signals.company || '(not found)'}", `
    + `${analysis.candidates.length} candidate(s)`;

  if (values['--apply'] !== true) {
    return result(EXIT.OK, envelope(matchInviteSpec.command, { data: analysis }), summary);
  }

  if (analysis.classification !== 'rejection') {
    const message = `--apply only performs the Rejected transition, but this text classified as "${analysis.classification}"`;
    const json = errorEnvelope(matchInviteSpec.command, [{ code: 'not-a-rejection', message }], { data: analysis });
    return result(EXIT.FAILED, json, `${summary}\n${matchInviteSpec.command}: ${message}`);
  }

  const selection = invite.selectApplyTarget(analysis, id ?? null);
  if (selection.error) {
    const data = { ...analysis, refusal: { code: selection.code, candidates: selection.candidates ?? null } };
    const json = errorEnvelope(matchInviteSpec.command, [{ code: 'not-applied', message: selection.error }], { data });
    return result(EXIT.FAILED, json, `${summary}\n${matchInviteSpec.command}: ${selection.error}`);
  }

  const applied = invite.applyRejectionStatus(selection.target.appNumber);
  const data = { ...analysis, applied };
  if (applied.error) {
    const json = errorEnvelope(matchInviteSpec.command, [{ code: 'apply-failed', message: applied.error }], { data });
    return result(EXIT.FAILED, json, `${summary}\n${matchInviteSpec.command}: apply failed — ${applied.error}`);
  }
  const text = `${summary}\nApplied: #${applied.num} ${applied.company} — ${applied.role}: ${applied.oldStatus} → ${applied.newStatus}`;
  return result(EXIT.OK, envelope(matchInviteSpec.command, { data }), text);
}

// ── followup add-reply (ADR 0003: paste-reply) ──────────────────────

const addReplySpec = {
  command: 'followup add-reply',
  usage: 'career-ops followup add-reply [--file <path>]',
  description:
    'Append one employer reply to the candidates store, for `followup review-replies`\n'
    + 'to classify. Reads the email from --file, or from stdin when it is piped.\n'
    + '\n'
    + 'File format: an optional "Subject:" line and an optional "From:" line, then the\n'
    + 'body. With neither header the whole file is the body. Existing candidates are\n'
    + 'never overwritten or removed.',
  flags: {
    '--file': { type: 'string', describe: 'Read the reply from this file instead of stdin' },
  },
};

async function runAddReply(argv, { env = process.env, stdin = process.stdin } = {}) {
  const started = begin(argv, addReplySpec);
  if (started.done) return started.done;
  const { values } = started.parsed;

  const input = readInput(addReplySpec.command, values['--file'], stdin);
  if (input.done) return input.done;

  const paste = await import('../../paste-reply.mjs');
  const parsedInput = paste.parseFileInput(input.text);
  if (!parsedInput.subject && !parsedInput.body) {
    return unverified(addReplySpec.command, 'the input carried no subject and no body — nothing to add');
  }

  const candidate = paste.normalizeCandidate(parsedInput);
  const path = join(dataDir(env), 'reply-candidates.json');
  let total;
  try {
    total = paste.appendCandidate(candidate, path);
  } catch (err) {
    return unverified(addReplySpec.command, err.message, { data: { path } });
  }

  const json = envelope(addReplySpec.command, { data: { path, candidate, total } });
  const text = [
    `Appended a reply candidate to ${path} (${total} total)`,
    `  message_id: ${candidate.message_id}`,
    `  from:       ${candidate.from || '(none)'}`,
    `  subject:    ${candidate.subject || '(none)'}`,
  ].join('\n');
  return result(EXIT.OK, json, text);
}

// ── followup match-replies (ADR 0003: reply-matcher) ────────────────

const matchRepliesSpec = {
  command: 'followup match-replies',
  usage: 'career-ops followup match-replies [--file <path>]',
  description:
    'Attribute each stored reply to the application it belongs to, by sender domain,\n'
    + 'company name and role. Matching only — see `followup review-replies` for the\n'
    + 'classification and the status transitions it implies.',
  flags: {
    '--file': { type: 'string', describe: 'Candidates JSON (default data/reply-candidates.json)' },
  },
};

async function runMatchReplies(argv, { env = process.env, stdin = process.stdin } = {}) {
  void stdin;
  const started = begin(argv, matchRepliesSpec);
  if (started.done) return started.done;
  const { values } = started.parsed;

  const store = loadCandidates(matchRepliesSpec.command, values['--file'], env);
  if (store.done) return store.done;
  const tracker = await loadTrackerRows(matchRepliesSpec.command, env);
  if (tracker.done) return tracker.done;

  const { matchCandidates } = await import('../../reply-matcher.mjs');
  const matches = matchCandidates(store.candidates, tracker.rows, await loadFollowups(env));
  const matched = matches.filter((m) => m.application_num !== null).length;

  const json = envelope(matchRepliesSpec.command, {
    data: {
      candidatesPath: store.path,
      trackerPath: tracker.path,
      counts: { candidates: store.candidates.length, matched, unmatched: matches.length - matched },
      matches,
    },
  });
  const lines = [
    `${matched} of ${store.candidates.length} repl(ies) matched a tracker row`,
    ...matches.map((m) => `  ${m.message_id}: ${m.application_num !== null ? `#${m.application_num}` : `unmatched (${m.company_hint || 'no company hint'})`}`),
  ];
  return result(EXIT.OK, json, lines.join('\n'));
}

// ── followup review-replies (ADR 0003: reply-watch) ─────────────────

const reviewRepliesSpec = {
  command: 'followup review-replies',
  usage: 'career-ops followup review-replies [--file <path>]',
  description:
    'The reply review digest: every stored reply matched to its application, classified,\n'
    + 'and the tracker status transition it proposes.\n'
    + '\n'
    + 'Read-only. Applying the transitions is not here yet: reply-watch.mjs keeps its\n'
    + 'recommendation grouping and its locked tracker write private, and an adapter must\n'
    + 'not re-implement either. Use `node reply-watch.mjs`, or apply one row with\n'
    + '`career-ops tracker set-status`, until those move into core.',
  flags: {
    '--file': { type: 'string', describe: 'Candidates JSON (default data/reply-candidates.json)' },
  },
};

async function runReviewReplies(argv, { env = process.env, stdin = process.stdin } = {}) {
  void stdin;
  const started = begin(argv, reviewRepliesSpec);
  if (started.done) return started.done;
  const { values } = started.parsed;

  const store = loadCandidates(reviewRepliesSpec.command, values['--file'], env);
  if (store.done) return store.done;
  const tracker = await loadTrackerRows(reviewRepliesSpec.command, env);
  if (tracker.done) return tracker.done;

  const { matchCandidates, classifyReply } = await import('../../reply-matcher.mjs');
  const matches = matchCandidates(store.candidates, tracker.rows, await loadFollowups(env));

  const reviewed = [];
  const proposals = [];
  for (const match of matches) {
    const candidate = store.candidates.find((c) => c.message_id === match.message_id);
    const classification = classifyReply(candidate);
    const app = match.application_num === null
      ? null
      : tracker.rows.find((r) => r.num === match.application_num) ?? null;
    reviewed.push({
      message_id: match.message_id,
      applicationNum: match.application_num,
      company: app?.company ?? match.company_hint ?? null,
      role: app?.role ?? null,
      subject: candidate?.subject ?? null,
      type: classification.type,
      evidence: classification.evidence ?? [],
      suggestedStatus: classification.suggestedTrackerUpdate,
    });
    const suggested = classification.suggestedTrackerUpdate;
    if (app && suggested && suggested !== 'none' && suggested !== 'Needs Review' && app.status !== suggested) {
      proposals.push({
        num: app.num,
        company: app.company,
        role: app.role,
        oldStatus: app.status,
        newStatus: suggested,
        message_id: match.message_id,
      });
    }
  }

  const json = envelope(reviewRepliesSpec.command, {
    data: {
      candidatesPath: store.path,
      trackerPath: tracker.path,
      counts: { reviewed: reviewed.length, proposals: proposals.length },
      reviewed,
      proposals,
    },
  });
  const lines = [
    `${reviewed.length} repl(ies) reviewed, ${proposals.length} status change(s) proposed`,
    ...reviewed.map((r, i) => `  ${i + 1}. ${r.company ?? 'unknown'}${r.role ? ` — ${r.role}` : ''}: ${r.type} → ${r.suggestedStatus}`),
    ...(proposals.length
      ? ['', 'Proposed:', ...proposals.map((p) => `  #${p.num} ${p.company}: ${p.oldStatus} → ${p.newStatus}`)]
      : []),
  ];
  return result(EXIT.OK, json, lines.join('\n'));
}

// ── exports ─────────────────────────────────────────────────────────

const command = (spec, run) => ({ run, help: renderHelp(spec), flags: spec.flags, spec });

export const noun = 'followup';

export const commands = {
  cadence: command(cadenceSpec, runCadence),
  seed: command(seedSpec, runSeed),
  contacts: command(contactsSpec, runContacts),
  'match-invite': command(matchInviteSpec, runMatchInvite),
  'add-reply': command(addReplySpec, runAddReply),
  'match-replies': command(matchRepliesSpec, runMatchReplies),
  'review-replies': command(reviewRepliesSpec, runReviewReplies),
};

export default { noun, commands };
