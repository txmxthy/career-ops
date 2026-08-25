/**
 * Characterisation of followup-seed.mjs's "is this app already seeded?" check
 * across its move onto src/core/table.js.
 *
 * The de-dup reads the appNum out of an existing follow-ups TABLE row (the
 * other half, a `next:` pin override, is covered by tests/followup-seed.test.mjs).
 * A miss here appends a second follow-up for one application, so the row
 * shapes it must recognise are pinned rather than left to the parser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'followup-seed.mjs');
const PROFILE = join(ROOT, 'tests', 'fixtures', 'profile-default-cadence.yml');

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1 | 2026-01-05 | Acme | Engineer | 8 | Applied | ❌ | — | applied 2026-01-05 |',
  '',
].join('\n');

/** Seed app #1 against a follow-ups file holding `followupsBody`. */
function seedAgainst(followupsBody) {
  const dir = mkdtempSync(join(tmpdir(), 'co-dedup-'));
  const tracker = join(dir, 'applications.md');
  const followups = join(dir, 'follow-ups.md');
  const lock = join(dir, 'career-ops-followups-dedup.lock');
  writeFileSync(tracker, TRACKER);
  writeFileSync(followups, followupsBody);
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '1', '--json'], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        CAREER_OPS_TRACKER: tracker,
        CAREER_OPS_FOLLOWUPS: followups,
        CAREER_OPS_PROFILE: PROFILE,
        CAREER_OPS_FOLLOWUPS_LOCK: lock,
      },
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HEADER = [
  '# Follow-ups',
  '',
  '| num | appNum | date | company | role | channel | contact | notes |',
  '|-----|--------|------|---------|------|---------|---------|-------|',
];

test('an existing table row for the app suppresses a second seed', () => {
  const body = [...HEADER, '| 1 | 1 | 2026-01-12 | Acme | Engineer | email | — | — |', ''].join('\n');
  assert.equal(seedAgainst(body).seeded, false);
});

test('a full row written without a trailing pipe is recognised', () => {
  const body = [...HEADER, '| 1 | 1 | 2026-01-12 | Acme | Engineer | email | — | —', ''].join('\n');
  assert.equal(seedAgainst(body).seeded, false);
});

test('DELIBERATE: a six-cell row without a trailing pipe is now recognised', () => {
  // The floor used to count `split('|')` parts, which include the empty string
  // before the leading pipe and, only when present, the one after the trailing
  // pipe. A short row missing its trailing pipe therefore had to carry one
  // MORE real cell than the same row with it, fell under the floor, and the
  // application was seeded a second time. The floor now counts real cells.
  const body = [...HEADER, '| 1 | 1 | 2026-01-12 | Acme | Engineer | email', ''].join('\n');
  assert.equal(seedAgainst(body).seeded, false);
});

test('DELIBERATE: an indented row is now recognised', () => {
  // `startsWith('|')` was tested against the raw line, so a row indented by a
  // list or a blockquote was invisible to the de-dup. parseRow trims first.
  const body = [...HEADER, '  | 1 | 1 | 2026-01-12 | Acme | Engineer | email | — | — |', ''].join('\n');
  assert.equal(seedAgainst(body).seeded, false);
});

test('a row for a different app does not suppress the seed', () => {
  const body = [...HEADER, '| 1 | 2 | 2026-01-12 | Beta | Engineer | email | — | — |', ''].join('\n');
  assert.equal(seedAgainst(body).seeded, true);
});

test('a narrow fragment is not read as a follow-ups row', () => {
  const body = [...HEADER, '| 1 | 1 |', ''].join('\n');
  assert.equal(seedAgainst(body).seeded, true);
});

test('the header row itself is never read as app 1', () => {
  assert.equal(seedAgainst([...HEADER, ''].join('\n')).seeded, true);
});
