/**
 * apply.js — the `career-ops apply` noun (ADR 0003): the commands that act on
 * one application, from the answers you gave a form to the ROI of what you
 * claimed in it.
 *
 * Every command here is an ADAPTER and nothing else. It parses argv with
 * src/core/flags.js, reads and writes through src/core/store.js, calls an
 * argv-free implementation, and maps the result onto the ADR 0006 envelope.
 * There is no business logic below this line — where a taxonomy row had no
 * importable entry point to call, the verb is absent rather than reimplemented
 * here. `docs/adr/0005-migration-strategy.md` step 5 is what unblocks the rest.
 *
 * The implementation imports reach up out of src/ because those files are still
 * at the repo root; they become intra-src imports when step 5 moves them. This
 * is the same reach store.js makes for pipeline-lock.mjs, for the same reason.
 *
 * ── The command contract the facade consumes ─────────────────────────
 *
 *   run(argv, ctx) -> Promise<{ exitCode, envelope, text }>
 *
 *   argv     the tokens after `career-ops apply <verb>`.
 *   ctx      { root, cwd, env } — injected, never resolved from a module-level
 *            constant, so a redirected CAREER_OPS_TRACKER lane and a test
 *            sandbox are the same thing to every command (store.js's rule).
 *   envelope the ADR 0006 result, always present, including for --help.
 *   text     the prose rendering, for when --json is off.
 *
 * A command never prints and never exits — the facade owns stdout and the
 * process. That is also what makes every path here testable without a
 * subprocess.
 *
 * ── Exit codes: what this noun means by each ─────────────────────────
 *
 *   0  the command ran and its answer is clean
 *   1  it ran and found something wrong — no match, an unverified claim
 *   2  bad flags or a missing required one
 *   3  it could not run at all: an input file is absent or unreadable
 *
 * 1 and 3 are the pair that matters. `apply find` on an empty tracker is a
 * real negative finding; `apply find` with no tracker at all is a check that
 * never happened, and the two must never share a code (ADR 0006).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseFlags, renderHelp, envelope, errorEnvelope, couldNotVerify, EXIT,
} from '../core/flags.js';
import {
  readFile, writeFileAtomic, resolveDataRoot, resolvePdfIndexPath, resolveTrackerPath,
} from '../core/store.js';

import {
  normalizeApplicationAnswersSnapshot, upsertApplicationAnswersSection,
} from '../../application-answers.mjs';
import {
  applicationArtifactPaths, ensureApplicationArtifactDirs,
} from '../../application-artifacts.mjs';
import { parseAssessments, summarize as summarizeAssessments } from '../../assessment-log.mjs';
import { findMatches, parsePdfIndex, parseTrackerRows } from '../../find.mjs';
import {
  analyze as analyzeRoi, parsePositiveNumberFlag, resolveFrequency,
} from '../../negotiation-roi.mjs';
import {
  classifyStoryBank, diagnose as diagnoseStoryBank, parseStoryBlocks,
} from '../../story-provenance-check.mjs';

/** Repo root: src/commands/apply.js sits two levels down from it. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── The shared adapter shell ────────────────────────────────────────

/** The flags parseFlags appends to every spec; listed so `--help --json` is
 *  as complete as the prose help is. */
const IMPLICIT_FLAGS = [
  { name: '--json', type: 'boolean', repeat: false, describe: 'Print the JSON result envelope instead of prose' },
  { name: '--help', type: 'boolean', repeat: false, describe: 'Show this help and exit' },
];

function describeFlags(spec) {
  const declared = Object.entries(spec.flags ?? {}).map(([name, def]) => ({
    name,
    type: def.type ?? 'boolean',
    repeat: Boolean(def.repeat),
    describe: def.describe ?? '',
  }));
  const names = new Set(declared.map((f) => f.name));
  return [...declared, ...IMPLICIT_FLAGS.filter((f) => !names.has(f.name))];
}

const ok = (spec, data, { warnings = [], text = '' } = {}) => ({
  exitCode: EXIT.OK,
  envelope: envelope(spec.command, { data, warnings }),
  text,
});

const failed = (spec, errors, { data = {}, warnings = [], text = '' } = {}) => ({
  exitCode: EXIT.FAILED,
  envelope: errorEnvelope(spec.command, errors, { data, warnings }),
  text,
});

const unverified = (spec, reason, { data = {}, warnings = [], text } = {}) => ({
  exitCode: EXIT.UNVERIFIED,
  envelope: couldNotVerify(spec.command, reason, { data, warnings }),
  text: text ?? `${spec.command}: could not verify — ${reason}`,
});

const usageError = (spec, errors, help) => ({
  exitCode: EXIT.USAGE,
  envelope: errorEnvelope(spec.command, errors),
  text: `${[].concat(errors).map((e) => e.message).join('\n')}\n\n${help}`,
});

/** The flags a command declares as required. parseFlags has no notion of a
 *  required value flag — it validates the shape of what was typed, not whether
 *  the command can work without it — so the check lives here, once. */
function missingRequired(values, required) {
  return required
    .filter((flag) => values[flag] === undefined)
    .map((flag) => ({ code: 'missing-flag', flag, message: `${flag} is required` }));
}

/**
 * Wrap a handler in the parts every command repeats: parse, report bad flags,
 * answer --help, and turn an unexpected throw into "could not verify".
 *
 * That last one is deliberate. store.js throws on an unreadable file and
 * returns absent for a missing one (ADR 0004 #7), so a throw reaching here
 * means the command produced no answer — which is exit 3, never an empty
 * result at exit 0.
 */
function defineCommand(spec, handler) {
  const help = renderHelp(spec);
  return {
    flags: spec.flags ?? {},
    help,
    async run(argv = [], ctx = {}) {
      const parsed = parseFlags(argv, spec);
      if (!parsed.ok) return usageError(spec, parsed.errors, help);
      if (parsed.help) {
        const data = {
          command: spec.command,
          usage: spec.usage,
          description: spec.description,
          flags: describeFlags(spec),
          help,
        };
        return { exitCode: EXIT.OK, envelope: envelope(spec.command, { data }), text: help };
      }
      const context = {
        root: ctx.root ?? ROOT,
        cwd: ctx.cwd ?? process.cwd(),
        env: ctx.env ?? process.env,
        stdin: ctx.stdin,
      };
      try {
        return await handler(parsed, context, help);
      } catch (err) {
        return unverified(spec, err?.message || String(err));
      }
    },
  };
}

/** A path the user typed resolves against their cwd, not the repo root. */
const userPath = (ctx, value) => resolve(ctx.cwd, value);

// ── apply find ──────────────────────────────────────────────────────

const FIND = {
  command: 'apply find',
  usage: 'career-ops apply find <query> [--json]',
  description: [
    'Find an application by report #, tracker # or a company/role fragment.',
    '',
    'Exit 1 means the tracker was searched and nothing matched. Exit 3 means',
    'there was no tracker to search — find.mjs reported both as 1.',
  ].join('\n'),
  flags: {},
  positionals: { name: 'query', min: 1, max: Infinity },
};

/** Fixed-width columns, the same set find.mjs prints. */
function renderMatches(matches) {
  const headers = ['Tracker#', 'Report#', 'Company', 'Role', 'Status', 'PDF', 'Report'];
  const table = matches.map((m) => [
    String(m.trackerNum), m.reportNum ?? '—', m.company, m.role,
    m.status || '—', m.pdfPath ?? '—', m.reportPath ?? '—',
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
  const row = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [row(headers), row(widths.map((w) => '-'.repeat(w))), ...table.map(row)].join('\n');
}

const find = defineCommand(FIND, (parsed, ctx, help) => {
  // Free text: a company name is routinely two or three words, so every
  // positional is kept and joined.
  const query = parsed.positionals.join(' ').trim();
  if (!query) {
    return usageError(FIND, [{ code: 'missing-positional', message: 'a query is required' }], help);
  }

  const trackerPath = resolveTrackerPath(ctx.root, ctx.env);
  const tracker = readFile(trackerPath);
  if (!tracker.exists) {
    return unverified(FIND, `${trackerPath} not found — there is no tracker to search`, {
      data: { query, trackerPath, matches: [] },
    });
  }

  // Derived from the tracker just resolved, not from the repo root: a
  // redirected lane must not be searched against this install's manifest.
  const manifest = readFile(resolvePdfIndexPath(trackerPath, ctx.env));
  const matches = findMatches(
    parseTrackerRows(tracker.content),
    query,
    manifest.exists ? parsePdfIndex(manifest.content) : new Map(),
  );

  const data = { query, trackerPath, count: matches.length, matches };
  if (matches.length === 0) {
    return failed(FIND, [{ code: 'no-match', message: `no application matches "${query}"` }], {
      data,
      text: `No application matches "${query}" — try a report #, tracker #, or company fragment.`,
    });
  }
  return ok(FIND, data, { text: `${renderMatches(matches)}\n\n${matches.length} match(es)` });
});

// ── apply answers ───────────────────────────────────────────────────

const ANSWERS = {
  command: 'apply answers',
  usage: 'career-ops apply answers --report <report.md> --input <answers.json|-> [--state <s>] [--date <YYYY-MM-DD>]',
  description: [
    'Record the answers given on an application form into that application\'s',
    'report, as a section the report can be re-read from later.',
    '',
    'The input JSON may carry: freeText, selections, fieldValues, files, date, state.',
  ].join('\n'),
  flags: {
    '--report': { type: 'string', describe: 'Report markdown file to update' },
    '--input': { type: 'string', describe: 'Answers JSON file, or - to read stdin' },
    '--state': { type: 'string', describe: 'filled | submitted — overrides the input' },
    '--date': { type: 'string', describe: 'YYYY-MM-DD — overrides the input' },
  },
};

const answers = defineCommand(ANSWERS, (parsed, ctx, help) => {
  const missing = missingRequired(parsed.values, ['--report', '--input']);
  if (missing.length) return usageError(ANSWERS, missing, help);

  const inputFlag = parsed.values['--input'];
  const reportPath = userPath(ctx, parsed.values['--report']);

  let inputText;
  if (inputFlag === '-') {
    // stdin is this adapter's own input channel, so reading it here is not a
    // reach into store.js's territory.
    inputText = ctx.stdin ?? readFileSync(0, 'utf-8');
  } else {
    const inputPath = userPath(ctx, inputFlag);
    const input = readFile(inputPath);
    if (!input.exists) {
      return unverified(ANSWERS, `${inputPath} not found — there are no answers to record`);
    }
    inputText = input.content;
  }

  let input;
  try {
    input = JSON.parse(inputText);
  } catch (err) {
    // Not a usage error: the flags were well formed. The command could not run
    // because the file it was pointed at is not answers.
    return unverified(ANSWERS, `${inputFlag} is not valid JSON — ${err.message}`);
  }

  const report = readFile(reportPath);
  if (!report.exists) {
    return unverified(ANSWERS, `${reportPath} not found — there is no report to record answers in`);
  }

  const snapshot = {
    ...input,
    date: parsed.values['--date'] ?? input.date,
    state: parsed.values['--state'] ?? input.state,
  };
  const updated = upsertApplicationAnswersSection(report.content, snapshot);
  // Atomic, unlike application-answers.mjs's writeFileSync: a report is the
  // durable record of what was submitted, and a half-written one is worse than
  // an unwritten one.
  writeFileAtomic(reportPath, updated);

  const normalized = normalizeApplicationAnswersSnapshot(snapshot);
  const changed = updated !== report.content;
  return ok(ANSWERS, { report: reportPath, date: normalized.date, state: normalized.state, changed }, {
    text: `${changed ? 'Recorded' : 'Unchanged'}: ${reportPath} (${normalized.state}, ${normalized.date})`,
  });
});

// ── apply artifacts ─────────────────────────────────────────────────

const ARTIFACTS = {
  command: 'apply artifacts',
  usage: 'career-ops apply artifacts --report <n> --company <name> --role <role> [--version <n>] [--root <dir>] [--init]',
  description: [
    'Resolve the artifact bundle for one application — JD, source CV, tailored',
    'CV, PDF and reuse decision, all under one stable key.',
    '',
    'Prints the paths; --init also creates the directories.',
  ].join('\n'),
  flags: {
    '--report': { type: 'string', describe: 'Report number (digits)' },
    '--company': { type: 'string', describe: 'Company name' },
    '--role': { type: 'string', describe: 'Role title' },
    '--version': { type: 'number', describe: 'Tailored-CV version (default 1)' },
    '--root': { type: 'string', describe: 'Artifact root (default <repo>/output)' },
    '--init': { type: 'boolean', describe: 'Create the directories as well as printing them' },
  },
};

const artifacts = defineCommand(ARTIFACTS, (parsed, ctx, help) => {
  const missing = missingRequired(parsed.values, ['--report', '--company', '--role']);
  if (missing.length) return usageError(ARTIFACTS, missing, help);

  // application-artifacts.mjs defaults to resolve('output') — the cwd's output
  // directory, wherever that happens to be. Anchored to the injected root here,
  // which is what every other path in this noun does.
  const root = parsed.values['--root']
    ? userPath(ctx, parsed.values['--root'])
    : join(ctx.root, 'output');

  let paths;
  try {
    paths = applicationArtifactPaths({
      reportNum: parsed.values['--report'],
      company: parsed.values['--company'],
      role: parsed.values['--role'],
      version: parsed.values['--version'] ?? 1,
      root,
    });
  } catch (err) {
    // Thrown for a malformed --report or --version, which is a bad flag value.
    return usageError(ARTIFACTS, [{ code: 'invalid-value', message: err.message }], help);
  }

  if (parsed.values['--init']) ensureApplicationArtifactDirs(paths);
  return ok(ARTIFACTS, { ...paths, initialised: parsed.values['--init'] === true }, {
    text: JSON.stringify(paths, null, 2),
  });
});

// ── apply assessments ───────────────────────────────────────────────

const ASSESSMENTS = {
  command: 'apply assessments',
  usage: 'career-ops apply assessments [--file <assessments.tsv>] [--json]',
  description: [
    'Summarise the skills-assessment log — one row per assessment event, with',
    'per-platform pass/fail counts and the staleness the candidate observed.',
    '',
    'An absent log is an empty log, reported at exit 0 with a warning. An',
    'UNREADABLE log is exit 3: nothing was summarised and the summary must not',
    'pretend otherwise.',
  ].join('\n'),
  flags: {
    '--file': { type: 'string', describe: 'Log to read (default <data>/assessments.tsv)' },
  },
};

const assessments = defineCommand(ASSESSMENTS, (parsed, ctx) => {
  // assessment-log.mjs hardcodes <script dir>/data/assessments.tsv, so a lane
  // redirected with CAREER_OPS_TRACKER read the default install's log. The
  // shared resolver moves it with the rest of the workspace.
  const path = parsed.values['--file']
    ? userPath(ctx, parsed.values['--file'])
    : join(resolveDataRoot(ctx.root, ctx.env), 'data', 'assessments.tsv');

  // Throws on unreadable, absent-and-empty otherwise (ADR 0004 #7) — the throw
  // becomes exit 3 in defineCommand.
  const log = readFile(path);
  const { rows, malformed } = parseAssessments(log.content);
  const result = summarizeAssessments(rows, malformed);

  const warnings = [];
  if (!log.exists) warnings.push(`${path} not found — no assessments have been logged yet`);
  for (const m of malformed) warnings.push(`malformed line skipped: "${m.line}"`);

  const lines = [`Skills assessments — ${result.quality.total} event(s) from ${path}`];
  for (const a of result.assessments) {
    const ref = a.reportNum ? ` (#${a.reportNum})` : '';
    const score = a.score !== null ? `${a.score}%` : 'no score';
    const threshold = a.threshold !== null ? ` vs ${a.threshold}%` : '';
    lines.push(`  ${a.date} ${a.company}${ref} — ${a.platform}: ${a.subject} — ${score}${threshold}`);
    if (a.staleNote) lines.push(`      stale: ${a.staleNote}`);
  }
  for (const [platform, agg] of Object.entries(result.aggregates.byPlatform)) {
    lines.push(`  ${platform}: ${agg.count} event(s) — ${agg.passed} passed, ${agg.failed} failed, ${agg.unknownOutcome} unknown`);
  }

  return ok(ASSESSMENTS, { path, ...result }, { warnings, text: lines.join('\n') });
});

// ── apply negotiation-roi ───────────────────────────────────────────

const ROI = {
  command: 'apply negotiation-roi',
  usage: 'career-ops apply negotiation-roi [--wage <n>] [--frequency <cadence>] [--occurrences <n>] [--story-bank <path>] [--cv <path>]',
  description: [
    'Turn the quantified claims in your story bank into negotiation arithmetic,',
    'keeping only the claims cv.md corroborates.',
    '',
    'Arithmetic only: it does not judge whether an achievement\'s context',
    'transfers to the role you are negotiating for.',
    '',
    'A missing story bank or cv.md is exit 3 — negotiation-roi.mjs exited 1,',
    'which is the code reserved for a claim that failed verification.',
  ].join('\n'),
  flags: {
    '--wage': { type: 'number', describe: 'Hourly wage used to price saved time' },
    '--frequency': { type: 'string', describe: 'Cadence of a recurring saving (daily, weekly, monthly, ...)' },
    '--occurrences': { type: 'number', describe: 'Occurrences per year, instead of --frequency' },
    '--story-bank': { type: 'string', describe: 'Story bank (default <repo>/interview-prep/story-bank.md)' },
    '--cv': { type: 'string', describe: 'CV to corroborate claims against (default <repo>/cv.md)' },
  },
};

const negotiationRoi = defineCommand(ROI, (parsed, ctx, help) => {
  const wage = parsePositiveNumberFlag(parsed.values['--wage'], '--wage');
  if (wage.error) return usageError(ROI, [{ code: 'invalid-value', flag: '--wage', message: wage.error }], help);
  const occurrences = parsePositiveNumberFlag(parsed.values['--occurrences'], '--occurrences');
  if (occurrences.error) {
    return usageError(ROI, [{ code: 'invalid-value', flag: '--occurrences', message: occurrences.error }], help);
  }

  const frequency = parsed.values['--frequency'] ?? null;
  // The cadence vocabulary lives in negotiation-roi.mjs and is not exported, so
  // it is probed rather than copied: resolveFrequency answers null for a
  // cadence it does not know. A second copy of that table here is exactly the
  // drift this refactor exists to remove.
  if (frequency && resolveFrequency('', { frequency, occurrencesPerYear: null }) === null) {
    return usageError(ROI, [{
      code: 'invalid-value',
      flag: '--frequency',
      message: `--frequency "${frequency}" is not a recognised cadence`,
    }], help);
  }

  const storyBankPath = parsed.values['--story-bank']
    ? userPath(ctx, parsed.values['--story-bank'])
    : join(ctx.root, 'interview-prep', 'story-bank.md');
  const cvPath = parsed.values['--cv'] ? userPath(ctx, parsed.values['--cv']) : join(ctx.root, 'cv.md');

  const storyBank = readFile(storyBankPath);
  if (!storyBank.exists) {
    return unverified(ROI, `${storyBankPath} not found — run interview-prep on a role to populate your story bank`);
  }
  const cv = readFile(cvPath);
  if (!cv.exists) {
    return unverified(ROI, `${cvPath} not found — claims cannot be corroborated without it`);
  }

  const result = analyzeRoi(storyBank.content, cv.content, {
    wage: wage.value,
    frequency,
    occurrencesPerYear: occurrences.value,
  });

  const lines = [
    `Negotiation ROI — ${result.claimsFound ?? 0} claim(s) found in ${storyBankPath}`,
    `  calculable:   ${result.calculable?.length ?? 0}`,
    `  uncalculable: ${result.uncalculable?.length ?? 0}`,
  ];
  for (const c of result.calculable ?? []) lines.push(`  · ${c.story}: ${c.calculation?.formula ?? ''}`);

  return ok(ROI, { storyBankPath, cvPath, ...result }, {
    warnings: result.warnings ?? [],
    text: lines.join('\n'),
  });
});

// ── apply story-provenance ──────────────────────────────────────────

const PROVENANCE = {
  command: 'apply story-provenance',
  usage: 'career-ops apply story-provenance [--story-bank <path>] [--cv <path>] [--json]',
  description: [
    'Classify every numeric claim in your story bank against cv.md, in four',
    'buckets: existing, supportedByResume, derived-unverified, user-cannot-confirm.',
    '',
    'Exit 1 when a claim is derived-unverified — a number that appears only in',
    'the story bank is a real negative finding, and this is the check that says',
    'so. user-cannot-confirm is a durable, accepted state and does not fail.',
    '',
    'Exit 3 for anything the checker itself calls low-confidence: no story bank,',
    'no cv.md, no stories parsed, no claims found. story-provenance-check.mjs',
    'printed "LOW CONFIDENCE" and exited 0, which is the exact shape ADR 0006',
    'forbids — an unperformed check reported as a clean one.',
  ].join('\n'),
  flags: {
    '--story-bank': { type: 'string', describe: 'Story bank (default <repo>/interview-prep/story-bank.md)' },
    '--cv': { type: 'string', describe: 'CV to check claims against (default <repo>/cv.md)' },
  },
};

const storyProvenance = defineCommand(PROVENANCE, (parsed, ctx) => {
  const storyBankPath = parsed.values['--story-bank']
    ? userPath(ctx, parsed.values['--story-bank'])
    : join(ctx.root, 'interview-prep', 'story-bank.md');
  const cvPath = parsed.values['--cv'] ? userPath(ctx, parsed.values['--cv']) : join(ctx.root, 'cv.md');

  const storyBank = readFile(storyBankPath);
  const cv = readFile(cvPath);
  const result = classifyStoryBank(storyBank.content, cv.content);
  const storyCount = storyBank.exists ? parseStoryBlocks(storyBank.content).length : 0;
  const claimCount = result.existing.length + result.supportedByResume.length
    + result.derivedUnverified.length + result.userCannotConfirm.length;

  const counts = {
    existing: result.existing.length,
    supportedByResume: result.supportedByResume.length,
    derivedUnverified: result.derivedUnverified.length,
    userCannotConfirm: result.userCannotConfirm.length,
  };
  const data = { storyBankPath, cvPath, storyCount, claimCount, counts, ...result };

  const diagnosis = diagnoseStoryBank(
    storyBank.exists, cv.exists, storyCount, claimCount, storyBankPath, cvPath,
  );
  if (diagnosis) {
    return unverified(PROVENANCE, diagnosis.message, {
      data: { ...data, lowConfidence: diagnosis },
    });
  }

  const lines = [
    `Story provenance — ${claimCount} claim(s) across ${storyCount} story(ies)`,
    `  existing:            ${counts.existing}`,
    `  supportedByResume:   ${counts.supportedByResume}`,
    `  derived-unverified:  ${counts.derivedUnverified}`,
    `  user-cannot-confirm: ${counts.userCannotConfirm}`,
  ];
  for (const c of result.derivedUnverified) lines.push(`  · [${c.story}] "${c.claim}" (${c.pattern})`);

  if (counts.derivedUnverified > 0) {
    return failed(PROVENANCE, [{
      code: 'derived-unverified',
      message: `${counts.derivedUnverified} claim(s) appear only in ${storyBankPath} and trace to no primary source`,
    }], { data, text: lines.join('\n') });
  }
  return ok(PROVENANCE, data, { text: lines.join('\n') });
});

// ── Not yet adaptable ───────────────────────────────────────────────
//
// Five taxonomy rows are absent from `commands` below, each for the same
// reason: the script has no importable, argv-free entry point, so a "thin"
// adapter for it would have to copy its body into this file. Recorded here so
// the gap is a known quantity rather than a silent omission.
//
//   intake              intake.mjs's main() owns the documents/ walk; only
//                       classifySource/computeDelta/sha256 are exported.
//   manifesto           manifesto.mjs is 36 lines of top-level statements with
//                       no exports, and its effect is spawning a browser.
//   outcome             outcome.mjs runs at import: argv parsing, set-status
//                       and archive-posting subprocesses, no exports at all.
//   prepare             prepare-application.mjs is top-level statements;
//                       detectAts and the prefill builder are not exported.
//   rank                rank-pipeline.mjs exports its pure parts but not the
//                       main() that drives the LLM CLI, and the pure parts
//                       alone are a preflight, not the command.
//
// `apply assessments` covers assessment-log.mjs's reporting path only. Its
// `add` subcommand appends a row, and store.js has no append — an atomic
// replace would break the file's append-only rule under concurrent writers.

export const noun = 'apply';

export const commands = {
  answers,
  artifacts,
  assessments,
  find,
  'negotiation-roi': negotiationRoi,
  'story-provenance': storyProvenance,
};

export default { noun, commands };
