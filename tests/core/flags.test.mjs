/**
 * Characterisation tests for src/core/flags.js — the one argv reader, --help
 * renderer and CLI result contract, replacing the 3 `flagValue` + 10
 * `parseArgs` + 3 `parseCliArgs` catalogued in
 * docs/audit/duplicate-functionality.md (Part II, CAPABILITY 2).
 *
 * Every input the audit lists as behaviourally divergent (A1–A8, §6 1–3) has a
 * test here. Where the module deliberately changes what one of the old parsers
 * did, the test says so and names the ADR or the audit item.
 *
 * The canonical implementation is lib/cli-flags.mjs:29; every assertion carried
 * over from tests/cli-flags.test.mjs keeps its original wording so a drift is
 * visible as a diff rather than as a rewrite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  flagValue,
  flagValues,
  hasFlag,
  parseFlags,
  renderHelp,
  EXIT,
  envelope,
  errorEnvelope,
  couldNotVerify,
} from '../../src/core/flags.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** First error code a failed parse reported, for terse assertions. */
const codes = (result) => result.errors.map((e) => e.code);

// ── flagValue — carried over from tests/cli-flags.test.mjs ───────────

test('flagValue reads the space-separated form', () => {
  assert.equal(flagValue(['--file', 'a.md'], '--file'), 'a.md');
});

test('flagValue reads the equals form', () => {
  // The #2401 defect: args.indexOf('--file') is -1 for `--file=a.md`, so a
  // space-only lookup silently discards the value and runs on the default.
  assert.equal(flagValue(['--file=a.md'], '--file'), 'a.md');
});

test('an absent flag is undefined, never null', () => {
  // ADR 0004 #6: tracker.mjs:376 returns null on a miss, which differs under
  // ??, Object.hasOwn and strict equality. undefined is the canonical miss.
  const v = flagValue(['--summary'], '--file');
  assert.equal(v, undefined);
  assert.notEqual(v, null);
  assert.equal(v === null, false);
});

test('an explicitly empty value is empty, not absent', () => {
  // `--file=` is a supplied-but-empty value: folding it into undefined would
  // hand the caller the default instead of a rejectable mistake.
  assert.equal(flagValue(['--file='], '--file'), '');
});

test('only the first = separates', () => {
  assert.equal(flagValue(['--file=a=b.md'], '--file'), 'a=b.md');
});

test('a trailing flag with no value is undefined', () => {
  assert.equal(flagValue(['--file'], '--file'), undefined);
});

test('a longer flag sharing the prefix does not match', () => {
  assert.equal(flagValue(['--filename', 'x'], '--file'), undefined);
  assert.equal(flagValue(['--filename=x'], '--file'), undefined);
});

test('the equals form is found even after a bare flag', () => {
  // Checking indexOf first would let the space lookup shadow the = form.
  assert.equal(flagValue(['--file', 'space.md', '--file=eq.md'], '--file'), 'eq.md');
});

test('a non-array argv yields undefined rather than throwing', () => {
  assert.equal(flagValue(null, '--file'), undefined);
});

test('a non-string argv entry is skipped', () => {
  assert.equal(flagValue([42, '--file=a.md'], '--file'), 'a.md');
});

test('flagValue does not swallow the following flag as a value (ADR 0004 #6)', () => {
  // The one deliberate change to the canonical lib/cli-flags.mjs:29 body.
  // There, `--status --applied` returned the literal '--applied'; tracker.mjs:375
  // rejected it. ADR 0004 #6 adopts the rejection: `--flag --next` must NOT
  // swallow `--next`. hasFlag still separates absent from supplied-without-value.
  assert.equal(flagValue(['--status', '--applied'], '--status'), undefined);
  assert.equal(hasFlag(['--status', '--applied'], '--status'), true);
  assert.equal(flagValue(['--status', '--applied'], '--applied'), undefined);
});

test('a single-dash value is a value, not a flag', () => {
  // `--since -5` is a negative day count. Only a `--`-prefixed token is a flag;
  // this is the adjacency rule lib/cli-flags.mjs:100-105 hand-rolls per caller.
  assert.equal(flagValue(['--since', '-5'], '--since'), '-5');
});

test('a repeated flag reads its first occurrence', () => {
  assert.equal(flagValue(['--file', 'a.md', '--file', 'b.md'], '--file'), 'a.md');
});

// ── flagValues — repeats ────────────────────────────────────────────

test('flagValues returns every occurrence in argv order, both forms', () => {
  // src/scripts/verify-cv-facts.mjs:422 accumulates repeated --source into an array; every
  // other reader silently drops all but the first.
  assert.deepEqual(
    flagValues(['--source', 'a.md', '--source=b.md', '--source', 'c.md'], '--source'),
    ['a.md', 'b.md', 'c.md'],
  );
});

test('flagValues on an absent flag is an empty array', () => {
  assert.deepEqual(flagValues(['--summary'], '--source'), []);
  assert.deepEqual(flagValues(null, '--source'), []);
});

test('flagValues skips a bare occurrence with no value', () => {
  assert.deepEqual(flagValues(['--source', '--json', '--source=b.md'], '--source'), ['b.md']);
});

// ── hasFlag — carried over from tests/cli-flags.test.mjs ─────────────

test('hasFlag sees every supplied form and respects the prefix boundary', () => {
  assert.equal(hasFlag(['--only', 'x'], '--only'), true);
  assert.equal(hasFlag(['--only'], '--only'), true);
  assert.equal(hasFlag(['--only=x'], '--only'), true);
  assert.equal(hasFlag(['--only='], '--only'), true);
  assert.equal(hasFlag(['--summary'], '--only'), false);
  assert.equal(hasFlag(['--only-me'], '--only'), false);
  assert.equal(hasFlag(null, '--only'), false);
});

// ── parseFlags — shapes ─────────────────────────────────────────────

const SPEC = {
  command: 'tracker set-status',
  flags: {
    '--file': { type: 'string', short: '-f', describe: 'Tracker path' },
    '--since': { type: 'number', describe: 'Day window' },
    '--dry-run': { type: 'boolean', describe: 'Preview only' },
    '--source': { type: 'string', repeat: true, describe: 'Extra source' },
  },
  positionals: { name: 'target', min: 0, max: 2 },
};

test('parseFlags reads both flag forms and collects positionals', () => {
  const r = parseFlags(['--file=a.md', '--since', '7', '--dry-run', 'acme'], SPEC);
  assert.equal(r.ok, true);
  assert.equal(r.values['--file'], 'a.md');
  assert.equal(r.values['--since'], 7);
  assert.equal(r.values['--dry-run'], true);
  assert.deepEqual(r.positionals, ['acme']);
  assert.equal(r.exitCode, EXIT.OK);
});

test('an absent value flag is undefined, an absent boolean is false, an absent repeat is []', () => {
  const r = parseFlags([], SPEC);
  assert.equal(r.ok, true);
  assert.equal(r.values['--file'], undefined);
  assert.equal(r.values['--file'] === null, false);
  assert.equal(r.values['--since'], undefined);
  assert.equal(r.values['--dry-run'], false);
  assert.deepEqual(r.values['--source'], []);
});

test('a repeatable flag collects every value in argv order', () => {
  const r = parseFlags(['--source', 'a.md', '--source=b.md'], SPEC);
  assert.equal(r.ok, true);
  assert.deepEqual(r.values['--source'], ['a.md', 'b.md']);
});

test('a repeated non-repeatable value flag is a usage error, not a silent first-wins', () => {
  // The audit records the divergence without deciding it: lib/cli-flags.mjs:35
  // and every bare-indexOf site silently take the FIRST occurrence, while
  // scan.mjs:2345 requireValue() reports the repeat. Reporting it is the only
  // behaviour that cannot discard input the user typed.
  const r = parseFlags(['--file', 'a.md', '--file', 'b.md'], SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['repeated-flag']);
  assert.equal(r.exitCode, EXIT.USAGE);
});

test('a repeated boolean stays true rather than erroring', () => {
  const r = parseFlags(['--dry-run', '--dry-run'], SPEC);
  assert.equal(r.ok, true);
  assert.equal(r.values['--dry-run'], true);
});

// ── parseFlags — unknown flags and --help ordering ───────────────────

test('an unrecognized flag fails with exit code 2, not 1 (ADR 0006)', () => {
  // lib/cli-flags.mjs:117 exits 1 for a bad flag. ADR 0006 reserves 1 for "the
  // check ran and failed" and gives usage errors code 2, so a caller can tell a
  // real negative finding from a typo.
  const r = parseFlags(['--dryrun'], SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['unknown-flag']);
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.match(r.errors[0].message, /unrecognized flag: --dryrun/);
  assert.equal(r.errors[0].flag, '--dryrun');
});

test('the unrecognized-flag message lists the valid flags', () => {
  const r = parseFlags(['--bogus'], SPEC);
  assert.match(r.errors[0].message, /--file/);
  assert.match(r.errors[0].message, /--help/);
});

test('--help alone requests help and does not fail', () => {
  const r = parseFlags(['--help'], SPEC);
  assert.equal(r.ok, true);
  assert.equal(r.help, true);
  assert.equal(r.exitCode, EXIT.OK);
});

test('-h requests help too', () => {
  assert.equal(parseFlags(['-h'], SPEC).help, true);
});

test('--help plus an unrecognized flag still errors (A1)', () => {
  // src/scripts/company-history.mjs:123, src/scripts/discover-ats.mjs:908 and src/scripts/assessment-log.mjs:290
  // check --help FIRST, so `--help --bogus` exits 0 having never looked at
  // --bogus. lib/cli-flags.mjs:145 checks it last, deliberately; that ordering
  // is canonical here.
  const r = parseFlags(['--help', '--bogus'], SPEC);
  assert.equal(r.ok, false);
  assert.equal(r.help, true);
  assert.deepEqual(codes(r), ['unknown-flag']);
});

test('--help does not rescue a flag left without its value', () => {
  // #2961: `--since --help` printed usage and exited 0, so the malformed flag
  // was never reported. lib/cli-flags.mjs made that check opt-in
  // (requireOperand); here it is unconditional.
  const r = parseFlags(['--since', '--help'], SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['missing-value']);
  assert.match(r.errors[0].message, /--since requires a value/);
});

test('--json is accepted on every command without being declared (ADR 0006)', () => {
  const r = parseFlags(['--json'], { command: 'x', flags: {} });
  assert.equal(r.ok, true);
  assert.equal(r.json, true);
});

test('--json defaults to false', () => {
  assert.equal(parseFlags([], { command: 'x', flags: {} }).json, false);
});

// ── parseFlags — values ─────────────────────────────────────────────

test('a value flag left before another flag reports a missing value (ADR 0004 #6)', () => {
  // src/scripts/archive-posting.mjs:120 documents the live version of this bug (#3087):
  // `--company --pipeline` set the company to "--pipeline" and left pipeline
  // mode off, silently, at exit 0.
  const r = parseFlags(['--file', '--dry-run'], SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['missing-value']);
  assert.equal(r.errors[0].flag, '--file');
  // The following flag is still parsed as a flag, not eaten as a value.
  assert.equal(r.values['--dry-run'], true);
});

test('a value flag at the end of argv reports a missing value', () => {
  const r = parseFlags(['--file'], SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['missing-value']);
});

test('an empty value is rejected in both forms (A7)', () => {
  // src/scripts/company-history.mjs:163-170 rejects `--company ""` and `--company=`;
  // lib/cli-flags.mjs's requireOperand does not. The rejection wins: an empty
  // value filters to something that cannot exist, which reads as "no results".
  const spaced = parseFlags(['--file', ''], SPEC);
  assert.equal(spaced.ok, false);
  assert.deepEqual(codes(spaced), ['missing-value']);

  const equals = parseFlags(['--file='], SPEC);
  assert.equal(equals.ok, false);
  assert.deepEqual(codes(equals), ['missing-value']);
});

test('a boolean flag given a value is rejected (#2778)', () => {
  // `--dry-run=1` is not `--dry-run`: every caller checks the exact token, so
  // accepting it silently runs with zero dry-run protection.
  const r = parseFlags(['--dry-run=1'], SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['unexpected-value']);
});

test('a negative number operand is an operand, not an unrecognized flag', () => {
  const r = parseFlags(['--since', '-5'], SPEC);
  assert.equal(r.ok, true);
  assert.equal(r.values['--since'], -5);
});

test('the equals form of a value flag accepts a negative number', () => {
  assert.equal(parseFlags(['--since=-5'], SPEC).values['--since'], -5);
});

test('zero is a value, not a falsy fallback (A3)', () => {
  // src/scripts/check-liveness.mjs:40 is `Number(...) || 5000`, so `--throttle=0` yields
  // 5000 — the user asked for no throttle and got the default.
  const r = parseFlags(['--since=0'], SPEC);
  assert.equal(r.ok, true);
  assert.equal(r.values['--since'], 0);
});

test('a non-numeric value for a number flag is a usage error', () => {
  // scan-ats-full.mjs:270 documents `Number(...) || 3` swallowing `--since abc`
  // into the default while the user believed they scanned the window they typed.
  const r = parseFlags(['--since', 'abc'], SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['invalid-value']);
  assert.match(r.errors[0].message, /--since expects a number, got "abc"/);
});

test('an overflowing number is rejected rather than becoming Infinity', () => {
  // `--since 1e400` became Infinity, i.e. no window at all.
  const r = parseFlags(['--since', '1e400'], SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['invalid-value']);
});

// ── parseFlags — short flags ────────────────────────────────────────

test('a declared short flag reads its value in both forms', () => {
  assert.equal(parseFlags(['-f', 'a.md'], SPEC).values['--file'], 'a.md');
  assert.equal(parseFlags(['-f=a.md'], SPEC).values['--file'], 'a.md');
});

test('clustered short flags are not supported and fail loudly', () => {
  // The audit found no script anywhere that supports clustering, so accepting
  // `-fd` would invent a syntax no caller has ever emitted.
  const r = parseFlags(['-fd'], SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['unknown-flag']);
});

test('a stray dash-prefixed token is an unrecognized flag', () => {
  // lib/cli-flags.mjs:110 treats any `-`-prefixed token as a flag candidate;
  // src/scripts/assessment-log.mjs:308 and src/scripts/company-history.mjs:139 agree. No divergence.
  assert.deepEqual(codes(parseFlags(['-5'], SPEC)), ['unknown-flag']);
  assert.deepEqual(codes(parseFlags(['-'], SPEC)), ['unknown-flag']);
});

// ── parseFlags — positionals ────────────────────────────────────────

test('a flag operand is excluded from the positionals by position (A6)', () => {
  // src/scripts/jd-skill-gap.mjs:374 is `args.find(a => !a.startsWith('--'))`, so
  // `--top 5 jd.txt` picks 5 as the JD path. src/lib/match-star.mjs:36-38 excludes
  // operands by index, which is the behaviour kept here.
  const spec = { command: 'insight jd-skill-gap', flags: { '--top': { type: 'number' } }, positionals: { name: 'jd', min: 1, max: 1 } };
  const r = parseFlags(['--top', '5', 'jd.txt'], spec);
  assert.equal(r.ok, true);
  assert.deepEqual(r.positionals, ['jd.txt']);
  assert.equal(r.values['--top'], 5);
});

test('a command that declares no positionals rejects one', () => {
  // src/scripts/verify-cv-facts.mjs:437 already reports "unexpected extra positional
  // argument"; every ad-hoc parser silently ignores it.
  const r = parseFlags(['stray'], { command: 'x', flags: {} });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['unexpected-positional']);
});

test('too few positionals is a usage error naming the count', () => {
  const spec = { command: 'x', flags: {}, positionals: { name: 'appNum', min: 1, max: 1 } };
  const r = parseFlags([], spec);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['missing-positional']);
  assert.match(r.errors[0].message, /appNum/);
});

test('too many positionals is a usage error', () => {
  const r = parseFlags(['a', 'b', 'c'], SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['unexpected-positional']);
});

test('--help wins over a positional-arity error', () => {
  // src/scripts/verify-cv-facts.mjs:433 returns {help:true} before it can complain about a
  // missing target. A bare `<cmd> --help` must print help, not a usage error.
  const spec = { command: 'x', flags: {}, positionals: { name: 'appNum', min: 1, max: 1 } };
  const r = parseFlags(['--help'], spec);
  assert.equal(r.ok, true);
  assert.equal(r.help, true);
});

test('-- ends flag parsing so a dash-prefixed positional survives', () => {
  const spec = { command: 'x', flags: {}, positionals: { name: 'text', min: 1, max: 3 } };
  const r = parseFlags(['--', '-5', '--not-a-flag'], spec);
  assert.equal(r.ok, true);
  assert.deepEqual(r.positionals, ['-5', '--not-a-flag']);
});

// ── parseFlags — defensive ──────────────────────────────────────────

test('a non-array argv is a usage error rather than a throw', () => {
  const r = parseFlags(null, SPEC);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['invalid-argv']);
  assert.equal(r.exitCode, EXIT.USAGE);
});

test('every failure reports every problem, not just the first', () => {
  const r = parseFlags(['--bogus', '--alsobogus'], SPEC);
  assert.equal(r.errors.length, 2);
});

test('parseFlags never mutates the argv it was given', () => {
  const argv = ['--file', 'a.md', 'x'];
  const copy = [...argv];
  parseFlags(argv, SPEC);
  assert.deepEqual(argv, copy);
});

// ── renderHelp ──────────────────────────────────────────────────────

test('renderHelp names the command, every flag and its description', () => {
  const help = renderHelp(SPEC);
  assert.equal(typeof help, 'string');
  assert.match(help, /tracker set-status/);
  assert.match(help, /--file/);
  assert.match(help, /-f/);
  assert.match(help, /Tracker path/);
  assert.match(help, /--dry-run/);
  assert.match(help, /Preview only/);
});

test('renderHelp always documents --json and --help (ADR 0006)', () => {
  const help = renderHelp({ command: 'x', flags: {} });
  assert.match(help, /--json/);
  assert.match(help, /--help/);
});

test('renderHelp documents the exit codes', () => {
  const help = renderHelp({ command: 'x', flags: {} });
  assert.match(help, /could not verify/i);
  assert.match(help, /\b3\b/);
});

test('renderHelp marks which flags take a value and which repeat', () => {
  const help = renderHelp(SPEC);
  assert.match(help, /--file .*<value>/);
  assert.match(help, /--source .*repeatable/i);
});

test('renderHelp uses an explicit usage line when the spec gives one', () => {
  const help = renderHelp({ command: 'x', usage: 'career-ops x [options] <jd>', flags: {} });
  assert.match(help, /career-ops x \[options\] <jd>/);
});

// ── EXIT codes ──────────────────────────────────────────────────────

test('the exit codes are the five ADR 0006 codes', () => {
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.FAILED, 1);
  assert.equal(EXIT.USAGE, 2);
  assert.equal(EXIT.UNVERIFIED, 3);
  assert.equal(EXIT.CONFIG, 4);
});

test('"ran and failed" and "could not verify" are different codes', () => {
  // Collapsing them is how "nothing found" gets reported for a check that
  // never executed (ADR 0006).
  assert.notEqual(EXIT.FAILED, EXIT.UNVERIFIED);
});

test('EXIT is frozen', () => {
  assert.equal(Object.isFrozen(EXIT), true);
});

// ── JSON envelope ───────────────────────────────────────────────────

test('the envelope carries exactly the five ADR 0006 keys, in order', () => {
  const env = envelope('scan run', { ok: true, data: { found: 3 } });
  assert.deepEqual(Object.keys(env), ['ok', 'command', 'data', 'warnings', 'errors']);
  assert.equal(env.ok, true);
  assert.equal(env.command, 'scan run');
  assert.deepEqual(env.data, { found: 3 });
  assert.deepEqual(env.warnings, []);
  assert.deepEqual(env.errors, []);
});

test('an omitted data/warnings/errors still appear as empty', () => {
  const env = envelope('scan run');
  assert.deepEqual(env.data, {});
  assert.deepEqual(env.warnings, []);
  assert.deepEqual(env.errors, []);
});

test('a failed envelope with no errors is refused (ADR 0006)', () => {
  // ok:false with an empty errors array is exactly "nothing found" standing in
  // for a check that never ran.
  assert.throws(() => envelope('scan run', { ok: false }), /at least one error/);
});

test('a successful envelope carrying errors is refused', () => {
  assert.throws(() => envelope('scan run', { ok: true, errors: ['boom'] }), /cannot carry errors/);
});

test('the envelope requires a command name', () => {
  assert.throws(() => envelope('', { ok: true }), /non-empty string/);
  assert.throws(() => envelope(undefined, { ok: true }), /non-empty string/);
});

test('errorEnvelope normalises strings, Errors and objects to {code, message}', () => {
  const env = errorEnvelope('scan run', ['plain', new Error('thrown'), { code: 'x', message: 'shaped' }]);
  assert.equal(env.ok, false);
  assert.deepEqual(env.errors, [
    { code: 'error', message: 'plain' },
    { code: 'error', message: 'thrown' },
    { code: 'x', message: 'shaped' },
  ]);
});

test('errorEnvelope accepts a bare error rather than an array', () => {
  const env = errorEnvelope('scan run', 'boom');
  assert.deepEqual(env.errors, [{ code: 'error', message: 'boom' }]);
});

test('errorEnvelope refuses an empty error list', () => {
  assert.throws(() => errorEnvelope('scan run', []), /at least one error/);
});

test('errorEnvelope keeps a parseFlags error verbatim, flag and all', () => {
  const parsed = parseFlags(['--dryrun'], SPEC);
  const env = errorEnvelope(SPEC.command, parsed.errors);
  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, 'unknown-flag');
  assert.equal(env.errors[0].flag, '--dryrun');
});

test('couldNotVerify says "could not verify", never "nothing found" (ADR 0006)', () => {
  const env = couldNotVerify('scan verify-portals', 'portals.yml is unreadable');
  assert.equal(env.ok, false);
  assert.equal(env.errors[0].code, 'could-not-verify');
  assert.match(env.errors[0].message, /^could not verify: portals\.yml is unreadable$/);
  assert.doesNotMatch(JSON.stringify(env), /nothing found/i);
});

test('couldNotVerify demands a reason', () => {
  assert.throws(() => couldNotVerify('scan verify-portals', ''), /reason is required/);
});

test('couldNotVerify keeps any warnings the caller collected before it gave up', () => {
  const env = couldNotVerify('scan verify-portals', 'network unreachable', { warnings: ['2 portals skipped'] });
  assert.deepEqual(env.warnings, ['2 portals skipped']);
});

test('the envelope survives a JSON round trip unchanged', () => {
  const env = errorEnvelope('scan run', 'boom', { warnings: ['w'] });
  assert.deepEqual(JSON.parse(JSON.stringify(env)), env);
});

// ── purity ──────────────────────────────────────────────────────────

test('the module reads no argv, prints nothing and exits nothing', () => {
  // ADR 0002: the core is importable and argv-free; I/O lives in store.js and
  // printing lives in the command adapters.
  const src = readFileSync(join(ROOT, 'src/core/flags.js'), 'utf-8');
  assert.doesNotMatch(src, /console\./);
  assert.doesNotMatch(src, /process\.(exit|argv|env)/);
  assert.doesNotMatch(src, /^import /m);
});
