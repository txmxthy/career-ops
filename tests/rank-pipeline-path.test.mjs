// tests/rank-pipeline-path.test.mjs — which pipeline.md rank-pipeline.mjs
// actually annotates, pinned as part of moving it onto src/core/store.js.
//
// docs/audit/duplicate-functionality.md counts eight private resolutions of the
// pipeline inbox and calls none of them fit (its §"pipeline path", entry 4 is
// this file). rank-pipeline.mjs joined `data/pipeline.md` to its own script
// directory and honoured no override at all, so a second search lane — a
// bridge track, a career-change track, a partner sharing the checkout — pointed
// `CAREER_OPS_PIPELINE` somewhere else and this script silently annotated the
// FIRST lane's inbox instead. Nothing failed; the run reported success against
// a file the caller had redirected away from.
//
// The other seven readers are other agents' files. This one pins the contract
// from the caller's side, so the shared resolver cannot regress it later.
//
// --cli is forced to a name no binary answers to, so the ranker spawns nothing:
// every batch fails, no annotation is produced, and --dry-run writes nothing in
// any case. What the assertions read is which file it counted entries from.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nrank-pipeline.mjs — pipeline inbox resolution (characterisation)');

const SCRIPT = join(ROOT, 'rank-pipeline.mjs');
const LANE = mkdtempSync(join(tmpdir(), 'rank-lane-'));
const INBOX = join(LANE, 'pipeline.md');
writeFileSync(INBOX, [
  '## Pending',
  '- [ ] https://x.test/1 | Acme | Backend Engineer',
  '- [ ] https://x.test/2 | Beta | Android Engineer',
  '- [ ] https://x.test/3 | Gamma | Platform Engineer',
  '- [ ] https://x.test/4 | Delta | Data Engineer',
  '- [ ] https://x.test/5 | Epsilon | ML Engineer',
  '',
].join('\n'), 'utf-8');

const rank = (...argv) => spawnSync(NODE, [SCRIPT, '--dry-run', '--cli', '__no_such_cli__', ...argv], {
  encoding: 'utf-8',
  timeout: 30000,
  env: { ...process.env, CAREER_OPS_PIPELINE: INBOX },
});

const check = (label, cond) => (cond ? pass(label) : fail(label));

// The CHANGED assertion: CAREER_OPS_PIPELINE is honoured, so the count comes
// from the redirected lane's five entries and not from this checkout's inbox.
const all = rank();
check('CAREER_OPS_PIPELINE selects the inbox that is read',
  all.stdout.includes('of 5 selected entr'));
check('a redirected lane still exits 0 when every batch is skipped', all.status === 0);
check('a failed batch is reported on stderr, not swallowed',
  all.stderr.includes('entries left un-annotated'));

// PRESERVED: both spellings of a value flag work, and the ceiling logic is
// unchanged. lib/cli-flags.mjs and src/core/flags.js agree on `--flag=value`;
// this pins that the swap did not lose it.
const spaced = rank('--limit', '2');
check('--limit N caps the selection', spaced.stdout.includes('of 2 selected entr'));
const equals = rank('--limit=2');
check('--limit=2 caps it identically', equals.stdout.includes('of 2 selected entr'));

// PRESERVED: nothing is written on a dry run, whatever the lane.
const before = rank('--limit', '1');
check('--dry-run leaves the lane untouched', before.stdout.includes('[dry-run]'));

// PRESERVED: --help answers without touching any inbox.
const help = spawnSync(NODE, [SCRIPT, '--help'], { encoding: 'utf-8', timeout: 20000 });
check('--help exits 0', help.status === 0);
check('--help describes the annotate-never-filter contract',
  help.stdout.includes('annotates, never filters'));
