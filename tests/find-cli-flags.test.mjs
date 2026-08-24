// tests/find-cli-flags.test.mjs — find.mjs's CLI contract, pinned BEFORE its
// hand-rolled parseArgs was moved onto src/core/flags.js.
//
// find.mjs carried one of the ten private `parseArgs` implementations
// docs/audit/duplicate-functionality.md counts (Part II, CAPABILITY 2). Its
// exported lookup functions were covered by test-all.mjs; its argv layer was
// not, so nothing pinned the two things a user actually hits — which flags are
// accepted, and what a rejected one costs. This file pins them.
//
// Exit codes are find.mjs's existing ones, NOT ADR 0006's. Frozen scripts keep
// the codes their consumers pin and the CLI facade translates (ADR 0006, last
// paragraph); find.mjs is not frozen, but a rewiring batch is the wrong commit
// to change a code in, so 1 stays 1 here and moves with the facade.
//
// Two cases are marked CHANGED. Both are places where the shared parser's
// documented contract differs from the copy it replaces, and both are in the
// direction that loses less of what the user typed.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nfind.mjs — argv contract (characterisation)');

const SCRIPT = join(ROOT, 'find.mjs');
// An empty workspace, so the "no tracker" path is reached deterministically
// wherever this runs: a contributor with a real data/applications.md must get
// the same verdict as CI.
const EMPTY = mkdtempSync(join(tmpdir(), 'find-cli-'));

const find = (...argv) => spawnSync(NODE, [SCRIPT, ...argv], {
  encoding: 'utf-8',
  timeout: 20000,
  env: { ...process.env, CAREER_OPS_TRACKER: join(EMPTY, 'applications.md') },
});

const check = (label, cond) => (cond ? pass(label) : fail(label));

// --help is answered on stdout at exit 0, in both spellings.
for (const flag of ['--help', '-h']) {
  const r = find(flag);
  check(`${flag} exits 0`, r.status === 0);
  check(`${flag} prints usage on stdout`, r.stdout.startsWith('Usage:'));
  check(`${flag} writes nothing to stderr`, r.stderr === '');
}

// An unrecognized flag is a usage error: named on stderr, with the valid set,
// and nothing on stdout for a caller that is piping results.
const bogus = find('--bogus');
check('--bogus exits 1', bogus.status === 1);
check('--bogus names the flag on stderr', bogus.stderr.includes('--bogus'));
check('--bogus lists the valid flags', bogus.stderr.includes('Valid flags: --json, --help, -h'));
check('--bogus repeats the usage block on stderr', bogus.stderr.includes('node find.mjs'));
check('--bogus writes nothing to stdout', bogus.stdout === '');

// Ordering: --help wins over a bad flag. find.mjs checked --help FIRST, which
// is the opposite of lib/cli-flags.mjs's validateFlags, and the ordering is
// preserved here rather than silently harmonised — that is a CLI-contract
// decision for the facade commit, not for a rewiring batch.
const helpBogus = find('--help', '--bogus');
check('--help --bogus exits 0 (--help is checked first)', helpBogus.status === 0);
check('--help --bogus prints usage on stdout', helpBogus.stdout.startsWith('Usage:'));

// No query at all: usage on STDOUT (not stderr) at exit 1. The one-copy rule
// find.mjs:158-159 states — the same USAGE the flag paths print.
const bare = find();
check('no query exits 1', bare.status === 1);
check('no query prints usage on stdout', bare.stdout.startsWith('Usage:'));

// A multi-word query is joined with spaces, and --json may sit anywhere in it.
const missing = find('--json', 'acme', 'corp');
check('a missing tracker exits 1', missing.status === 1);
check('a missing tracker says so on stderr, naming the path',
  missing.stderr.includes('not found — nothing to search.') && missing.stderr.includes('applications.md'));
check('a missing tracker writes nothing to stdout', missing.stdout === '');

// CHANGED by the move onto src/core/flags.js. Before: `--json=x` was reported
// verbatim as an unrecognized flag. After: the shared parser recognises the
// flag and rejects the VALUE, so the message names `--json`. Still exit 1,
// still nothing on stdout — only the token in the message narrows.
const jsonEq = find('--json=x');
check('--json=x exits 1', jsonEq.status === 1);
check('--json=x is reported as a bad flag naming --json', jsonEq.stderr.includes('--json'));
check('--json=x writes nothing to stdout', jsonEq.stdout === '');

// CHANGED by the move onto src/core/flags.js. Before: a bare `--` was itself
// reported as an unrecognized flag, so a query beginning with a dash could not
// be expressed at all. After: `--` ends the flags and everything after it is
// query text, which is the contract every other consumer of the shared parser
// already has.
const dashdash = find('--', '--json');
check('-- passes the rest through as query text (reaches the tracker read)',
  dashdash.status === 1 && dashdash.stderr.includes('not found — nothing to search.'));
