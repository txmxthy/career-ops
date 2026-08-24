// tests/paste-reply-file-flag.test.mjs — paste-reply.mjs's --file flag, pinned
// as part of moving its argv layer onto src/core/flags.js.
//
// paste-reply-tests.mjs covers what --file DOES once it is found. It always
// passes the flag as two tokens, so nothing covered how the flag is FOUND —
// and paste-reply.mjs found it with a bare `args.indexOf('--file')`, which
// cannot see `--file=path`. That is defect #2401's exact shape: the equals form
// fell through to INTERACTIVE mode, so the script sat waiting on stdin for an
// email the caller had already handed it, and under a closed stdin reported
// "no subject or body text found — nothing to add" at exit 1. The file was
// never opened and nothing said so.
//
// src/core/flags.js checks the `=` form FIRST for precisely this reason
// (flags.js:60-63). This file pins both spellings, plus the operand and
// ordering rules the swap must not disturb.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

console.log('\npaste-reply.mjs — --file flag forms (characterisation)');

const SCRIPT = join(ROOT, 'paste-reply.mjs');
const check = (label, cond) => (cond ? pass(label) : fail(label));

// One sandbox per invocation, so each assertion reads its own candidates file
// and never the developer's real data/reply-candidates.json.
function runWith(argvBuilder) {
  const box = mkdtempSync(join(tmpdir(), 'paste-reply-flag-'));
  const mail = join(box, 'mail.txt');
  const out = join(box, 'reply-candidates.json');
  writeFileSync(mail, 'Subject: Interview invitation\nFrom: talent@acme.test\n\nCan you meet Thursday?\n', 'utf-8');
  const r = spawnSync(NODE, [SCRIPT, ...argvBuilder(mail)], {
    encoding: 'utf-8',
    timeout: 20000,
    stdio: ['ignore', 'pipe', 'pipe'],   // closed stdin: interactive mode cannot hang or succeed
    env: { ...process.env, CAREER_OPS_REPLY_CANDIDATES: out },
  });
  return { ...r, out, mail };
}

const readCandidates = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null);

// PRESERVED: the two-token form is what paste-reply-tests.mjs already exercises.
const spaced = runWith((m) => ['--file', m]);
check('--file <path> exits 0', spaced.status === 0);
const spacedOut = readCandidates(spaced.out);
check('--file <path> appends one candidate', spacedOut?.length === 1);
check('--file <path> carries the subject through',
  spacedOut?.[0]?.subject === 'Interview invitation');

// CHANGED by the move onto src/core/flags.js. Before: invisible to indexOf, so
// the script fell into interactive mode and reported an empty paste at exit 1.
// After: the same candidate as the two-token form.
const equals = runWith((m) => [`--file=${m}`]);
check('--file=<path> exits 0', equals.status === 0);
const equalsOut = readCandidates(equals.out);
check('--file=<path> appends one candidate', equalsOut?.length === 1);
check('--file=<path> produces the same candidate as --file <path>',
  equalsOut?.[0]?.subject === 'Interview invitation'
  && equalsOut?.[0]?.from === 'talent@acme.test'
  && equalsOut?.[0]?.body_snippet === 'Can you meet Thursday?');

// PRESERVED: a flag with no operand is a usage error, not a silent fallback to
// interactive mode — the pairing hasFlag/flagValue exists to keep those apart.
const noOperand = runWith(() => ['--file']);
check('--file with no operand exits 1', noOperand.status === 1);
check('--file with no operand says the path is missing',
  /--file requires a path/.test(noOperand.stderr));
check('--file with no operand writes no candidates file', readCandidates(noOperand.out) === null);

// PRESERVED: a path that is not there fails loudly and writes nothing.
const missing = runWith(() => ['--file', join(tmpdir(), 'no-such-paste-reply-input.txt')]);
check('a missing --file path exits 1', missing.status === 1);
check('a missing --file path names the file', /file not found/.test(missing.stderr));

// PRESERVED: --help wins over everything, on stdout, at exit 0. paste-reply.mjs
// answers --help before it looks at --file; the shared parser reports flag
// errors first by default, and that ordering difference must not leak in.
const help = runWith((m) => ['--file', m, '--help']);
check('--file <path> --help exits 0', help.status === 0);
check('--file <path> --help prints help on stdout', help.stdout.includes('manual/no-Gmail input'));
check('--file <path> --help writes no candidate', readCandidates(help.out) === null);

const helpFirst = runWith(() => ['--file', '--help']);
check('--file --help prints help rather than treating --help as the path',
  helpFirst.status === 0 && helpFirst.stdout.includes('manual/no-Gmail input'));
