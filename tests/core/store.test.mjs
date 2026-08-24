/**
 * Characterisation tests for src/core/store.js — the one data-access module,
 * replacing the 12 tracker path resolutions, 8 pipeline path resolutions,
 * 15 missing-file contracts and the write/lock/backup cluster catalogued in
 * docs/audit/duplicate-functionality.md (Part III, Capabilities 1-4).
 *
 * Every input the audit lists as behaviourally divergent (D1.1-D1.5, D2.1-D2.4,
 * D3.1-D3.4, D4.1-D4.2) has a test here. Where the module deliberately changes
 * what one of the old readers did, the test says so and names the ADR or the
 * audit item.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
  rmSync, symlinkSync, chmodSync, realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import {
  canonicalPath,
  workspaceDir,
  resolveTrackerPath,
  resolveWorkspaceRoot,
  resolveDataRoot,
  resolvePdfIndexPath,
  resolvePipelinePath,
  resolveScanHistoryPath,
  resolveFollowupsPath,
  readFile,
  readText,
  requireText,
  readTracker,
  readPipeline,
  ensureDir,
  ensurePipeline,
  writeFileAtomic,
  PIPELINE_SKELETON,
  trackerLockDirFor,
  withTrackerLock,
  withTrackerTransaction,
  withFileLock,
  readLockOwner,
  sameLockDirectory,
  isLockTimeout,
} from '../../src/core/store.js';

// Temp roots are realpath'd up front: on macOS /var is a symlink to
// /private/var, and canonicalPath() resolves it — comparing against the
// unresolved spelling would fail for reasons that have nothing to do with the
// behaviour under test.
const TMP_ROOT = realpathSync(tmpdir());
const made = [];

function tmpRoot() {
  const dir = mkdtempSync(join(TMP_ROOT, 'store-test-'));
  made.push(dir);
  return dir;
}

function write(path, content = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

test.after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Running as root defeats a chmod-based permission test: root reads anything.
const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0;

// ── canonicalPath ───────────────────────────────────────────────────

// Mirrors canonicalizeTrackerPath (tracker-utils.mjs:168) verbatim, and the Go
// mirror canonicalPath (dashboard/internal/data/tracker_lock.go:68) — the lock
// key hashes this string, so the two must keep agreeing. Renamed only.
test('canonicalPath resolves a relative path against cwd', () => {
  assert.equal(canonicalPath('data/applications.md'), join(process.cwd(), 'data/applications.md'));
});

test('canonicalPath returns the resolved path when the file does not exist', () => {
  const root = tmpRoot();
  assert.equal(canonicalPath(join(root, 'nope.md')), join(root, 'nope.md'));
});

test('canonicalPath follows a symlink to one spelling, so two spellings hash alike', () => {
  const root = tmpRoot();
  const real = write(join(root, 'real/applications.md'), '');
  symlinkSync(join(root, 'real'), join(root, 'link'));
  assert.equal(canonicalPath(join(root, 'link/applications.md')), real);
  // D1.5: the whole point — a writer reaching the tracker through a symlink and
  // one reaching it directly must contend on the SAME lock directory.
  assert.equal(trackerLockDirFor(canonicalPath(join(root, 'link/applications.md'))),
    trackerLockDirFor(real));
});

// ── workspaceDir (ADR 0007) ─────────────────────────────────────────

test('workspaceDir prefers workspace/<name> when it exists', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'workspace/data'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  assert.equal(workspaceDir('data', root), join(root, 'workspace/data'));
});

test('workspaceDir falls back to the legacy root dir when only that exists', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'reports'), { recursive: true });
  assert.equal(workspaceDir('reports', root), join(root, 'reports'));
});

test('workspaceDir returns the workspace path when neither exists (fresh install)', () => {
  const root = tmpRoot();
  assert.equal(workspaceDir('jds', root), join(root, 'workspace/jds'));
});

// ── resolveTrackerPath ──────────────────────────────────────────────

test('resolveTrackerPath honours CAREER_OPS_TRACKER and canonicalises it', () => {
  const root = tmpRoot();
  const target = write(join(root, 'elsewhere/t.md'), '');
  assert.equal(resolveTrackerPath(root, { CAREER_OPS_TRACKER: join(root, 'elsewhere/../elsewhere/t.md') }), target);
});

test('resolveTrackerPath prefers data/applications.md when it exists', () => {
  const root = tmpRoot();
  const target = write(join(root, 'data/applications.md'), '');
  write(join(root, 'applications.md'), '');
  assert.equal(resolveTrackerPath(root, {}), target);
});

test('resolveTrackerPath falls back to the root layout when data/ has no tracker', () => {
  const root = tmpRoot();
  const target = write(join(root, 'applications.md'), '');
  assert.equal(resolveTrackerPath(root, {}), target);
});

test('resolveTrackerPath returns the root-layout path when neither file exists', () => {
  const root = tmpRoot();
  assert.equal(resolveTrackerPath(root, {}), join(root, 'applications.md'));
});

// ADR 0007: the workspace/ layout moves the tracker with the rest of the user
// data. No install has workspace/data today, so this is additive — the two
// tests above pin that the legacy layouts are untouched.
test('resolveTrackerPath finds the tracker under workspace/data when that layout is present', () => {
  const root = tmpRoot();
  const target = write(join(root, 'workspace/data/applications.md'), '');
  assert.equal(resolveTrackerPath(root, {}), target);
});

// D1.1: eight scripts (followup-cadence.mjs:24, analyze-patterns.mjs:23,
// upskill.mjs:33, invite-match.mjs:44, tracker-sync-check.mjs:66, stats.mjs:30,
// plugins.mjs:34, scan.mjs:83) ignored the env var entirely. There is now one
// resolver, so "ignores it" is not reachable — env is an injected parameter,
// never read from a module-level constant.
test('resolveTrackerPath reads the injected env, not process.env', () => {
  const root = tmpRoot();
  write(join(root, 'data/applications.md'), '');
  const previous = process.env.CAREER_OPS_TRACKER;
  process.env.CAREER_OPS_TRACKER = '/should/be/ignored.md';
  try {
    assert.equal(resolveTrackerPath(root, {}), join(root, 'data/applications.md'));
  } finally {
    if (previous === undefined) delete process.env.CAREER_OPS_TRACKER;
    else process.env.CAREER_OPS_TRACKER = previous;
  }
});

// ── resolveWorkspaceRoot / resolveDataRoot ──────────────────────────

test('resolveWorkspaceRoot climbs out of data/ but not out of a root-layout dir', () => {
  assert.equal(resolveWorkspaceRoot('/w/data/applications.md'), '/w');
  assert.equal(resolveWorkspaceRoot('/w/applications.md'), '/w');
});

test('resolveDataRoot follows a redirected tracker into its own workspace', () => {
  const root = tmpRoot();
  const other = tmpRoot();
  write(join(other, 'data/applications.md'), '');
  assert.equal(resolveDataRoot(root, { CAREER_OPS_TRACKER: join(other, 'data/applications.md') }), other);
});

// ── resolvePdfIndexPath ─────────────────────────────────────────────

test('resolvePdfIndexPath honours CAREER_OPS_PDF_INDEX', () => {
  assert.equal(resolvePdfIndexPath('/w/data/applications.md', { CAREER_OPS_PDF_INDEX: '/tmp/i.tsv' }), '/tmp/i.tsv');
});

test('resolvePdfIndexPath sits in the workspace that owns the tracker', () => {
  assert.equal(resolvePdfIndexPath('/w/data/applications.md', {}), join('/w', 'data', 'pdf-index.tsv'));
  assert.equal(resolvePdfIndexPath('/w/applications.md', {}), join('/w', 'data', 'pdf-index.tsv'));
});

// ── resolvePipelinePath ─────────────────────────────────────────────

// D2.2: CAREER_OPS_PIPELINE was honoured by scan.mjs:82 alone, so
// scan-ats-full.mjs:60 created an unredirected skeleton beside the real inbox.
test('resolvePipelinePath honours CAREER_OPS_PIPELINE', () => {
  const root = tmpRoot();
  const target = write(join(root, 'lane-b/pipeline.md'), '');
  assert.equal(resolvePipelinePath(root, { CAREER_OPS_PIPELINE: join(root, 'lane-b/pipeline.md') }), target);
});

// D1.3 / D2.1, DELIBERATE CHANGE: scan.mjs:82 and scan-ats-full.mjs:60 default
// to the bare relative string 'data/pipeline.md', so `cd /tmp && node
// /repo/scan.mjs` appends to /tmp/data/pipeline.md while plugins.mjs:35 dedups
// against /repo/data/pipeline.md. The CWD base is the loser: this resolver is
// anchored to the workspace root and never to process.cwd().
test('resolvePipelinePath is anchored to the workspace root, not the cwd', () => {
  const root = tmpRoot();
  const target = write(join(root, 'data/pipeline.md'), '');
  assert.equal(resolvePipelinePath(root, {}), target);
  assert.notEqual(resolvePipelinePath(root, {}), join(process.cwd(), 'data/pipeline.md'));
});

// D2.4: reconcile-pipeline.mjs:73-75 was the only reader with this fallback, so
// on a root-layout install it worked on the real inbox while scan.mjs,
// rank-pipeline.mjs and plugins.mjs all targeted a nonexistent data/pipeline.md.
test('resolvePipelinePath falls back to the root-layout pipeline.md', () => {
  const root = tmpRoot();
  const target = write(join(root, 'pipeline.md'), '');
  assert.equal(resolvePipelinePath(root, {}), target);
});

test('resolvePipelinePath defaults to data/pipeline.md when neither file exists', () => {
  const root = tmpRoot();
  assert.equal(resolvePipelinePath(root, {}), join(root, 'data/pipeline.md'));
});

test('resolvePipelinePath follows a redirected tracker into its workspace', () => {
  const root = tmpRoot();
  const other = tmpRoot();
  write(join(other, 'data/applications.md'), '');
  const target = write(join(other, 'data/pipeline.md'), '');
  assert.equal(resolvePipelinePath(root, { CAREER_OPS_TRACKER: join(other, 'data/applications.md') }), target);
});

// ── scan history / follow-ups ───────────────────────────────────────

test('resolveScanHistoryPath honours CAREER_OPS_SCAN_HISTORY, else sits beside the tracker', () => {
  const root = tmpRoot();
  assert.equal(resolveScanHistoryPath(root, {}), join(root, 'data/scan-history.tsv'));
  assert.equal(resolveScanHistoryPath(root, { CAREER_OPS_SCAN_HISTORY: '/tmp/h.tsv' }), '/tmp/h.tsv');
});

test('resolveFollowupsPath honours CAREER_OPS_FOLLOWUPS, else sits beside the tracker', () => {
  const root = tmpRoot();
  assert.equal(resolveFollowupsPath(root, {}), join(root, 'data/follow-ups.md'));
  assert.equal(resolveFollowupsPath(root, { CAREER_OPS_FOLLOWUPS: '/tmp/f.md' }), '/tmp/f.md');
});

// ── The unified read contract (ADR 0004 #7) ─────────────────────────

// ADR 0004 #7: EMPTY on absent. This is the contract the four "return []
// silently" and three "return ''" readers already had (D4.2) — it survives.
test('readFile reports an absent file as {exists:false, content:""}', () => {
  const root = tmpRoot();
  assert.deepEqual(readFile(join(root, 'gone.md')), { exists: false, content: '' });
});

// ADR 0004 #7 / D4.2, DELIBERATE CHANGE: followup-cadence.mjs:885,
// funnel-velocity.mjs:702 and rejection-latency.mjs:347 returned '' for BOTH an
// absent tracker and an empty one, so a mis-pointed CAREER_OPS_TRACKER reported
// "0 applications" instead of an error. `exists` keeps the two apart — the
// distinction company-history.mjs:272 carried as {rows, loaded}.
test('readFile distinguishes a present-but-empty file from an absent one', () => {
  const root = tmpRoot();
  const path = write(join(root, 'empty.md'), '');
  assert.deepEqual(readFile(path), { exists: true, content: '' });
});

test('readFile returns the file content as utf-8', () => {
  const root = tmpRoot();
  const path = write(join(root, 't.md'), '| # | Company |\n');
  assert.deepEqual(readFile(path), { exists: true, content: '| # | Company |\n' });
});

// ADR 0004 #7: THROW on unreadable. scan.mjs:1597's readIfExists tested
// existsSync first, which answers false for a file under a directory this
// process cannot traverse — an unreadable tracker was silently an empty one.
test('readFile throws when the file exists but cannot be read', { skip: !CAN_DENY_READ }, () => {
  const root = tmpRoot();
  const path = write(join(root, 'secret.md'), 'x');
  chmodSync(path, 0o000);
  try {
    assert.throws(() => readFile(path), err => err.code === 'EACCES');
  } finally {
    chmodSync(path, 0o600);
  }
});

test('readFile throws when the path is a directory', () => {
  const root = tmpRoot();
  assert.throws(() => readFile(root), err => err.code === 'EISDIR');
});

// ENOTDIR is the same fact as ENOENT — nothing is there — reached through a
// path whose parent is a file rather than a directory.
test('readFile reports a path under a non-directory as absent', () => {
  const root = tmpRoot();
  const file = write(join(root, 'file.md'), 'x');
  assert.deepEqual(readFile(join(file, 'inner.md')), { exists: false, content: '' });
});

test('readText returns "" for an absent file and the content otherwise', () => {
  const root = tmpRoot();
  assert.equal(readText(join(root, 'gone.md')), '');
  assert.equal(readText(write(join(root, 'there.md'), 'hi')), 'hi');
});

// The mutating-CLI half of D4.1: set-status.mjs:264 exits 2 on a missing
// tracker, verify-pipeline.mjs:76 exits 0 and find.mjs:166 exits 1. One
// condition, three verdicts. requireText raises one error the CLI layer maps.
test('requireText throws an ENOENT-coded error naming the path', () => {
  const root = tmpRoot();
  const missing = join(root, 'gone.md');
  assert.throws(() => requireText(missing), err => err.code === 'ENOENT' && err.path === missing);
});

test('requireText returns the content of a present but empty file', () => {
  const root = tmpRoot();
  assert.equal(requireText(write(join(root, 'e.md'), '')), '');
});

test('readTracker binds resolution and reading in one call', () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/applications.md'), 'rows');
  assert.deepEqual(readTracker(root, {}), { path, exists: true, content: 'rows' });
});

test('readTracker reports a fresh clone as absent rather than empty', () => {
  const root = tmpRoot();
  assert.deepEqual(readTracker(root, {}), { path: join(root, 'applications.md'), exists: false, content: '' });
});

test('readPipeline binds resolution and reading in one call', () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/pipeline.md'), '## Pending\n');
  assert.deepEqual(readPipeline(root, {}), { path, exists: true, content: '## Pending\n' });
});

// ── Writes ──────────────────────────────────────────────────────────

test('writeFileAtomic writes the content and leaves no temporary file behind', () => {
  const root = tmpRoot();
  const path = join(root, 'data/applications.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, 'one');
  assert.equal(readFileSync(path, 'utf-8'), 'one');
  assert.deepEqual(readdirSync(dirname(path)), ['applications.md']);
});

test('writeFileAtomic replaces an existing file', () => {
  const root = tmpRoot();
  const path = write(join(root, 't.md'), 'old');
  writeFileAtomic(path, 'new');
  assert.equal(readFileSync(path, 'utf-8'), 'new');
});

// D3.3: reconcile-pipeline.mjs:297 is the only writer in the cluster that keeps
// a .bak, and it is the UNLOCKED one. The backup is a parameter here so a
// locked writer can have it too.
test('writeFileAtomic with a backup suffix keeps the previous content', () => {
  const root = tmpRoot();
  const path = write(join(root, 'pipeline.md'), 'before');
  writeFileAtomic(path, 'after', { backup: '.pre-reconcile.bak' });
  assert.equal(readFileSync(path, 'utf-8'), 'after');
  assert.equal(readFileSync(`${path}.pre-reconcile.bak`, 'utf-8'), 'before');
});

test('writeFileAtomic skips the backup when there is nothing to back up', () => {
  const root = tmpRoot();
  const path = join(root, 'pipeline.md');
  writeFileAtomic(path, 'first', { backup: '.bak' });
  assert.equal(readFileSync(path, 'utf-8'), 'first');
  assert.equal(existsSync(`${path}.bak`), false);
});

// Deliberately NOT mkdir -p: a missing parent means the resolved path is wrong,
// and creating it turns a typo'd CAREER_OPS_TRACKER into a silent second
// workspace. ensureDir() is the explicit opt-in.
test('writeFileAtomic throws when the parent directory is missing, and cleans up', () => {
  const root = tmpRoot();
  const path = join(root, 'no-such-dir/t.md');
  assert.throws(() => writeFileAtomic(path, 'x'), err => err.code === 'ENOENT');
  assert.deepEqual(readdirSync(root), []);
});

test('ensureDir creates the directory tree and is idempotent', () => {
  const root = tmpRoot();
  const dir = join(root, 'a/b/c');
  ensureDir(dir);
  ensureDir(dir);
  assert.equal(existsSync(dir), true);
});

// D2.3: three skeletons existed for one file — scan.mjs:1857 (Pending +
// Processed), scan-ats-full.mjs:1014 ('## Pendientes', no Processed) and
// openrouter-runner.mjs:512 ('## Pending', no Processed). rank-pipeline.mjs:369
// recognises only '## Pending', so an inbox created by scan-ats-full ranked
// nothing, silently. scan.mjs's skeleton is the winner.
test('ensurePipeline creates the one skeleton, with both sections', () => {
  const root = tmpRoot();
  const path = join(root, 'data/pipeline.md');
  ensureDir(dirname(path));
  assert.equal(ensurePipeline(path), true);
  const text = readFileSync(path, 'utf-8');
  assert.equal(text, PIPELINE_SKELETON);
  assert.match(text, /^## Pending$/m);
  assert.match(text, /^## Processed$/m);
  assert.doesNotMatch(text, /Pendientes/);
});

test('ensurePipeline leaves an existing inbox untouched', () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/pipeline.md'), '## Pendientes\n- [ ] https://x');
  assert.equal(ensurePipeline(path), false);
  assert.equal(readFileSync(path, 'utf-8'), '## Pendientes\n- [ ] https://x');
});

// ── Locks ───────────────────────────────────────────────────────────

// The lock key is a hash of the canonical path, mirrored by
// dashboard/internal/data/tracker_lock.go:99. Delegated unchanged — ADR 0004
// lists the JS<->Go mirror under "not divergences".
test('trackerLockDirFor is stable and path-derived', () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/applications.md'), '');
  assert.equal(trackerLockDirFor(path), trackerLockDirFor(path));
  assert.notEqual(trackerLockDirFor(path), trackerLockDirFor(join(root, 'other.md')));
  assert.match(trackerLockDirFor(path), /career-ops-merge-tracker-[0-9a-f]{16}\.lock$/);
});

test('withTrackerLock runs the body and releases the lock afterwards', async () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/applications.md'), '');
  let lockDirDuring;
  const result = await withTrackerLock(path, () => {
    lockDirDuring = trackerLockDirFor(path);
    assert.equal(existsSync(lockDirDuring), true);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(existsSync(lockDirDuring), false);
});

test('withTrackerLock releases the lock when the body throws', async () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/applications.md'), '');
  await assert.rejects(withTrackerLock(path, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(trackerLockDirFor(path)), false);
});

// D3.1: the lost-update this whole cluster exists to prevent. A second holder
// must not get in while the first is inside its read-modify-write.
test('withTrackerLock excludes a second holder', async () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/applications.md'), '');
  await withTrackerLock(path, async () => {
    await assert.rejects(
      withTrackerLock(path, () => 'never', { timeoutMs: 50, retryMs: 5 }),
      err => isLockTimeout(err),
    );
  });
});

// The two spellings must contend, which is what canonicalisation buys (D1.5).
test('withTrackerLock canonicalises before hashing, so a symlinked path contends', async () => {
  const root = tmpRoot();
  const real = write(join(root, 'real/applications.md'), '');
  symlinkSync(join(root, 'real'), join(root, 'link'));
  await withTrackerLock(join(root, 'link/applications.md'), () => {
    assert.equal(existsSync(trackerLockDirFor(real)), true);
  });
});

// The canonical pick for the tracker (audit Capability 3): the lock must cover
// the read AND the write, not just the write.
test('withTrackerTransaction reads and replaces inside one lock lifetime', async () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/applications.md'), 'old');
  const seen = await withTrackerTransaction(path, tx => {
    assert.equal(existsSync(trackerLockDirFor(path)), true);
    const before = tx.read();
    tx.replace(`${before.content}+new`);
    return before;
  });
  assert.deepEqual(seen, { exists: true, content: 'old' });
  assert.equal(readFileSync(path, 'utf-8'), 'old+new');
  assert.equal(existsSync(trackerLockDirFor(path)), false);
});

// ADR 0004 #7 reaches inside the transaction too: a first write to a tracker
// that does not exist yet reads as absent rather than throwing ENOENT, which is
// what openTrackerTransaction's read() (tracker-utils.mjs:490) did.
test('withTrackerTransaction reports an absent tracker instead of throwing', async () => {
  const root = tmpRoot();
  const path = join(root, 'data/applications.md');
  ensureDir(dirname(path));
  await withTrackerTransaction(path, tx => {
    assert.deepEqual(tx.read(), { exists: false, content: '' });
    tx.replace('created');
  });
  assert.equal(readFileSync(path, 'utf-8'), 'created');
});

test('withTrackerTransaction refuses use after the lock is released', async () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/applications.md'), '');
  const escaped = await withTrackerTransaction(path, tx => tx);
  assert.throws(() => escaped.read(), /closed/);
  assert.throws(() => escaped.replace('x'), /closed/);
});

// The pipeline family locks a directory beside the file (pipeline-lock.mjs:56),
// not a hashed temp dir. Unchanged: it is the canonical module.
test('withFileLock holds <path>.lock for the duration and removes it after', async () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/pipeline.md'), '');
  await withFileLock(path, () => {
    assert.equal(existsSync(`${path}.lock`), true);
  });
  assert.equal(existsSync(`${path}.lock`), false);
});

test('withFileLock excludes a second holder', async () => {
  const root = tmpRoot();
  const path = write(join(root, 'data/pipeline.md'), '');
  await withFileLock(path, async () => {
    await assert.rejects(
      withFileLock(path, () => 'never', { timeoutMs: 50, retryMs: 5 }),
      err => isLockTimeout(err),
    );
  });
});

// ── readLockOwner (ADR 0004 #1) ─────────────────────────────────────

// ADR 0004 #1, DELIBERATE CHANGE: pipeline-lock.mjs:76 is the winner and the
// three copies (portal-health-lock.mjs:75, tracker-utils.mjs:244,
// followup-seed.mjs:291) answered a bare null. They could not have imported it
// — pipeline-lock exported 14 symbols and this was not one. It is now exported,
// and store.js re-exports it so there is one reachable definition.
test('readLockOwner returns the parsed stamp', () => {
  const root = tmpRoot();
  write(join(root, 'l.lock/owner.json'), JSON.stringify({ pid: 42, token: 'abc' }));
  assert.deepEqual(readLockOwner(join(root, 'l.lock')), { inspected: true, owner: { pid: 42, token: 'abc' } });
});

// ENOENT is a FACT: a lock genuinely has no stamp between its mkdir and its
// owner.json write. The age rule is the right judge.
test('readLockOwner reports a missing stamp as inspected', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'l.lock'));
  assert.deepEqual(readLockOwner(join(root, 'l.lock')), { inspected: true, owner: null });
});

test('readLockOwner reports a torn stamp as inspected', () => {
  const root = tmpRoot();
  write(join(root, 'l.lock/owner.json'), '{"pid": 4');
  assert.deepEqual(readLockOwner(join(root, 'l.lock')), { inspected: true, owner: null });
});

// The #2984 property the three copies lose: an unreadable stamp is absence we
// merely failed to observe, and collapsing it into null lets the age rule
// condemn a live lock.
test('readLockOwner reports an unreadable stamp as NOT inspected', { skip: !CAN_DENY_READ }, () => {
  const root = tmpRoot();
  const stamp = write(join(root, 'l.lock/owner.json'), '{}');
  chmodSync(stamp, 0o000);
  try {
    assert.deepEqual(readLockOwner(join(root, 'l.lock')), { inspected: false, owner: null });
  } finally {
    chmodSync(stamp, 0o600);
  }
});

// ADR 0004 #2: one definition, from pipeline-lock.mjs:105.
test('sameLockDirectory compares device, inode and birthtime', () => {
  const a = { dev: 1, ino: 7, birthtimeMs: 100 };
  assert.equal(sameLockDirectory(a, { dev: 1, ino: 7, birthtimeMs: 100 }), true);
  assert.equal(sameLockDirectory(a, { dev: 1, ino: 8, birthtimeMs: 100 }), false);
  assert.equal(sameLockDirectory(a, { dev: 2, ino: 7, birthtimeMs: 100 }), false);
  // ino 0 happens on some Windows volumes, hence birthtime as the tiebreaker.
  assert.equal(sameLockDirectory({ dev: 1, ino: 0, birthtimeMs: 100 }, { dev: 1, ino: 0, birthtimeMs: 101 }), false);
});

// D3.4 addendum (not in the audit): the three lock modules report a timeout in
// three shapes — pipeline-lock throws LockTimeoutError, tracker-utils throws an
// Error tagged code 'LOCK_TIMEOUT', followup-seed throws SeedError('LOCK_TIMEOUT').
// One predicate so the CLI layer can map all three to one exit code.
test('isLockTimeout recognises all three lock-timeout shapes', () => {
  const tagged = Object.assign(new Error('t'), { code: 'LOCK_TIMEOUT' });
  const named = Object.assign(new Error('t'), { name: 'LockTimeoutError' });
  const seedError = Object.assign(new Error('t'), { name: 'SeedError', code: 'LOCK_TIMEOUT' });
  assert.equal(isLockTimeout(tagged), true);
  assert.equal(isLockTimeout(named), true);
  assert.equal(isLockTimeout(seedError), true);
  assert.equal(isLockTimeout(new Error('nope')), false);
  assert.equal(isLockTimeout(undefined), false);
});
