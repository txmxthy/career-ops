/**
 * store.js — the one data-access module.
 *
 * Replaces the four clusters catalogued in
 * docs/audit/duplicate-functionality.md, Part III: 12 tracker path
 * resolutions, 8 pipeline path resolutions, 15 missing-file contracts, and the
 * write/lock/backup cluster — across 92 readFileSync sites.
 *
 * Two rules run through all of it:
 *
 *   - Paths are resolved from an injected root and an injected env, never from
 *     a module-level constant and never from process.cwd(). Eight scripts
 *     ignored CAREER_OPS_TRACKER (D1.1) and two anchored the pipeline to the
 *     cwd (D1.3, D2.1); both failures are unreachable once there is one
 *     resolver taking its inputs as arguments.
 *   - THROW on unreadable, EMPTY on absent (ADR 0004 #7). `exists` carries the
 *     distinction the analytics readers lost when they collapsed "no tracker"
 *     into "empty tracker" (D4.2). Silent-default readers become explicit;
 *     surfacing latent bugs is the point.
 *
 * Locking is DELEGATED, not reimplemented. src/lib/pipeline-lock.mjs is canonical for
 * the wait policy, the recovery verdict and the owner read; tracker-utils.mjs
 * owns the tracker acquire loop and the Go-mirrored lock-key derivation
 * (dashboard/internal/data/tracker_lock.go:99), which ADR 0004 lists under "not
 * divergences — do not fix". A fourth copy of either is exactly the drift
 * ADR 0005 blames for the migration stalling. Those two imports reach up out of
 * src/ because both files are still at root; they become intra-src imports when
 * ADR 0005 step 5 moves them.
 *
 * I/O lives here so everything above it can stay pure. No argv, no
 * process.exit, no console.
 */

import {
  readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, realpathSync, existsSync,
} from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { randomUUID } from 'crypto';

import {
  withPipelineLock, readLockOwner, sameLockDirectory, lockDirFor,
} from '../lib/pipeline-lock.mjs';
import {
  acquireTrackerLock, trackerLockDirFor, renameSyncWithRetry,
} from '../../tracker-utils.mjs';

export { readLockOwner, sameLockDirectory, trackerLockDirFor, renameSyncWithRetry };

/** Filesystem answers that mean "nothing is there", as opposed to "I could not look". */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

// ── Paths ───────────────────────────────────────────────────────────

/**
 * One stable absolute spelling for a path, before anything hashes or compares
 * it. Relative spellings, absolute ones and paths reached through a symlink
 * must all produce the same string, or two writers of the same file hash
 * different keys into `trackerLockDirFor` and fail to exclude each other
 * (D1.5). Mirrored in Go by `canonicalPath` (tracker_lock.go:68).
 *
 * @param {string} path - Raw path from config, env, a flag, or a default.
 * @returns {string} The realpath when the file exists, else the resolved path.
 */
export function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Resolve one of the user-data directories (`data`, `reports`, `documents`,
 * `jds`, `output`, `interview-prep`, `writing-samples`, `seeds`).
 *
 * ADR 0007 moves these under `workspace/`, and this is the compat shim that
 * makes the move invisible: `workspace/<name>` wins when it exists, the legacy
 * root path is kept when it is the one that exists, and a fresh install gets
 * the tidy layout. Existing installs have real user files in the legacy dirs,
 * so nothing is moved on their behalf.
 *
 * @param {string} name - Directory name, e.g. 'data'.
 * @param {string} rootDir - The career-ops repository root.
 * @returns {string} Absolute directory path (which may not exist yet).
 */
export function workspaceDir(name, rootDir) {
  const modern = join(rootDir, 'workspace', name);
  if (existsSync(modern)) return modern;
  const legacy = join(rootDir, name);
  return existsSync(legacy) ? legacy : modern;
}

/**
 * Resolve the applications tracker.
 *
 * `CAREER_OPS_TRACKER` wins; otherwise `data/applications.md` when it exists
 * (through `workspaceDir`, so the ADR 0007 layout is found too), else the
 * original root layout `applications.md`. The result is canonicalised, because
 * the lock key is derived from it.
 *
 * @param {string} rootDir - The career-ops repository root.
 * @param {object} [env] - Environment to read overrides from.
 * @returns {string} Absolute canonical tracker path.
 */
export function resolveTrackerPath(rootDir, env = process.env) {
  if (env.CAREER_OPS_TRACKER) return canonicalPath(env.CAREER_OPS_TRACKER);
  const inData = join(workspaceDir('data', rootDir), 'applications.md');
  return canonicalPath(existsSync(inData) ? inData : join(rootDir, 'applications.md'));
}

/**
 * The workspace root that owns a tracker — where `data/` and `reports/` sit.
 *
 * Sibling paths are derived from THIS rather than from a script's own
 * directory, so pointing `CAREER_OPS_TRACKER` at another workspace moves the
 * whole set together. A script that mixes the two reads one workspace and
 * writes another (#2471).
 *
 * @param {string} trackerPath - Tracker path, typically from resolveTrackerPath().
 * @returns {string} Absolute workspace root directory.
 */
export function resolveWorkspaceRoot(trackerPath) {
  const trackerDir = dirname(trackerPath);
  return basename(trackerDir) === 'data' ? dirname(trackerDir) : trackerDir;
}

/**
 * The workspace root for a repository root, following any tracker redirection.
 *
 * @param {string} rootDir - The career-ops repository root.
 * @param {object} [env] - Environment to read overrides from.
 * @returns {string} Absolute workspace root directory.
 */
export function resolveDataRoot(rootDir, env = process.env) {
  return resolveWorkspaceRoot(resolveTrackerPath(rootDir, env));
}

/**
 * Resolve the PDF manifest (`data/pdf-index.tsv`) for the workspace that owns a
 * tracker. `CAREER_OPS_PDF_INDEX` overrides it.
 *
 * @param {string} trackerPath - Tracker path, typically from resolveTrackerPath().
 * @param {object} [env] - Environment to read overrides from.
 * @returns {string} Path to the PDF manifest.
 */
export function resolvePdfIndexPath(trackerPath, env = process.env) {
  return env.CAREER_OPS_PDF_INDEX
    || join(resolveWorkspaceRoot(trackerPath), 'data', 'pdf-index.tsv');
}

/**
 * Resolve the pipeline inbox (`data/pipeline.md`).
 *
 * Three fixes over the eight implementations it replaces: `CAREER_OPS_PIPELINE`
 * is honoured everywhere rather than in scan.mjs alone (D2.2); the base is the
 * workspace root rather than `process.cwd()`, so `src/scripts/plugins.mjs` can no longer
 * dedup against one inbox and append to another (D2.1, D1.3); and the
 * root-layout fallback that only `src/scripts/reconcile-pipeline.mjs:73` had is applied for
 * every reader (D2.4).
 *
 * @param {string} rootDir - The career-ops repository root.
 * @param {object} [env] - Environment to read overrides from.
 * @returns {string} Absolute canonical pipeline path.
 */
export function resolvePipelinePath(rootDir, env = process.env) {
  if (env.CAREER_OPS_PIPELINE) return canonicalPath(env.CAREER_OPS_PIPELINE);
  const base = resolveDataRoot(rootDir, env);
  const inData = join(base, 'data', 'pipeline.md');
  if (existsSync(inData)) return canonicalPath(inData);
  const atRoot = join(base, 'pipeline.md');
  return canonicalPath(existsSync(atRoot) ? atRoot : inData);
}

/**
 * Resolve the scan history (`data/scan-history.tsv`) — the dedup source, so a
 * second search lane pointing elsewhere must move it with the rest.
 *
 * @param {string} rootDir - The career-ops repository root.
 * @param {object} [env] - Environment to read overrides from.
 * @returns {string} Path to the scan history.
 */
export function resolveScanHistoryPath(rootDir, env = process.env) {
  return env.CAREER_OPS_SCAN_HISTORY || join(resolveDataRoot(rootDir, env), 'data', 'scan-history.tsv');
}

/**
 * Resolve the follow-ups file (`data/follow-ups.md`).
 *
 * @param {string} rootDir - The career-ops repository root.
 * @param {object} [env] - Environment to read overrides from.
 * @returns {string} Path to the follow-ups file.
 */
export function resolveFollowupsPath(rootDir, env = process.env) {
  return env.CAREER_OPS_FOLLOWUPS || join(resolveDataRoot(rootDir, env), 'data', 'follow-ups.md');
}

// ── Reads ───────────────────────────────────────────────────────────

/**
 * Read a file under the one contract: THROW on unreadable, EMPTY on absent
 * (ADR 0004 #7).
 *
 * `exists` is the half the 15 old contracts kept losing. An absent tracker and
 * an empty one are different states — a mis-pointed `CAREER_OPS_TRACKER` used
 * to report "0 applications" rather than an error (D4.2) — and only a caller
 * that can see the difference can report it.
 *
 * The read is attempted directly rather than gated on `existsSync`: the gate
 * answers false for a file this process cannot traverse to, which turned an
 * unreadable tracker into a silently empty one, and it is a TOCTOU besides.
 *
 * @param {string} path - File to read.
 * @returns {{exists: boolean, content: string}} Content, and whether it was there.
 */
export function readFile(path) {
  try {
    return { exists: true, content: readFileSync(path, 'utf-8') };
  } catch (err) {
    if (ABSENT_CODES.has(err?.code)) return { exists: false, content: '' };
    throw err;
  }
}

/**
 * File content, or '' when the file is absent. For readers that genuinely treat
 * the two alike; anything that reports a count to a user wants `readFile`.
 *
 * @param {string} path - File to read.
 * @returns {string} Content, or '' when absent.
 */
export function readText(path) {
  return readFile(path).content;
}

/**
 * File content, throwing an ENOENT-coded error when the file is absent.
 *
 * The mutating-CLI half of the contract: a missing tracker was exit 0, 1 and 2
 * depending on which script you called (D4.1). One error, mapped once by the
 * CLI layer.
 *
 * @param {string} path - File to read.
 * @returns {string} Content.
 */
export function requireText(path) {
  const { exists, content } = readFile(path);
  if (!exists) {
    const err = new Error(`No such file: ${path}`);
    err.code = 'ENOENT';
    err.path = path;
    throw err;
  }
  return content;
}

/**
 * Resolve and read the tracker in one call.
 *
 * @param {string} rootDir - The career-ops repository root.
 * @param {object} [env] - Environment to read overrides from.
 * @returns {{path: string, exists: boolean, content: string}}
 */
export function readTracker(rootDir, env = process.env) {
  const path = resolveTrackerPath(rootDir, env);
  return { path, ...readFile(path) };
}

/**
 * Resolve and read the pipeline inbox in one call.
 *
 * @param {string} rootDir - The career-ops repository root.
 * @param {object} [env] - Environment to read overrides from.
 * @returns {{path: string, exists: boolean, content: string}}
 */
export function readPipeline(rootDir, env = process.env) {
  const path = resolvePipelinePath(rootDir, env);
  return { path, ...readFile(path) };
}

// ── Writes ──────────────────────────────────────────────────────────

/**
 * Create a directory and its parents. Explicit, because `writeFileAtomic` will
 * not do it implicitly: a missing parent usually means the resolved path is
 * wrong, and creating it turns a typo'd override into a silent second
 * workspace.
 *
 * @param {string} dir - Directory to create.
 * @returns {void}
 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/**
 * Replace a file atomically, optionally keeping a backup of what was there.
 *
 * The temporary file sits in the destination directory so the final rename is
 * atomic on normal filesystems and no reader ever sees a half-written tracker.
 * The rename retries through short Windows contention. The pipeline writers
 * never adopted this and rewrite in place under their lock, so a crash
 * mid-write truncates the inbox (D3.2).
 *
 * `backup` is a suffix rather than a flag because the one writer that keeps a
 * backup today names it `.pre-reconcile.bak` (src/scripts/reconcile-pipeline.mjs:297) — and
 * it is the UNLOCKED writer, which is how the safest-by-backup writer came to
 * be the least safe by locking (D3.3).
 *
 * @param {string} path - Final file path to replace.
 * @param {string} content - Complete file content.
 * @param {{backup?: string}} [options] - Suffix for a copy of the previous content.
 * @returns {void}
 */
export function writeFileAtomic(path, content, options = {}) {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, content);
    if (options.backup) copyIfPresent(path, `${path}${options.backup}`);
    renameSyncWithRetry(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/** Copy `from` to `to`, unless there is nothing to copy (first write). */
function copyIfPresent(from, to) {
  try {
    copyFileSync(from, to);
  } catch (err) {
    if (!ABSENT_CODES.has(err?.code)) throw err;
  }
}

/**
 * The one pipeline skeleton, matching the format documented in
 * modes/pipeline.md.
 *
 * Three existed (D2.3): this one, scan-ats-full.mjs:1014's Spanish-headed
 * `## Pendientes` with no Processed section, and src/scripts/openrouter-runner.mjs:512's
 * `## Pending` with no Processed section. `src/scripts/rank-pipeline.mjs:369` recognises
 * only `## Pending`, so an inbox first created by scan-ats-full ranked nothing,
 * silently. Reading still accepts the legacy Spanish headings; only creation is
 * unified.
 */
export const PIPELINE_SKELETON = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

## Pending

## Processed
`;

/**
 * Create the pipeline inbox with the standard skeleton when it is missing.
 *
 * A create-if-absent, not a locked operation: callers already hold the file
 * lock around their read-modify-write and this belongs inside it.
 *
 * @param {string} path - Pipeline path, from resolvePipelinePath().
 * @returns {boolean} True when this call created the file.
 */
export function ensurePipeline(path) {
  if (existsSync(path)) return false;
  writeFileSync(path, PIPELINE_SKELETON, 'utf-8');
  return true;
}

// ── Locks ───────────────────────────────────────────────────────────

/** Lock timing, from the env the tracker CLIs already document. */
function trackerLockTiming(env) {
  return {
    timeoutMs: Number(env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
    retryMs: Number(env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
    staleMs: Number(env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
  };
}

/**
 * Hold the tracker lock for the duration of `fn`.
 *
 * The lock directory is derived from the CANONICAL path, so a writer reaching
 * the tracker through a symlink contends with one reaching it directly (D1.5).
 * The acquire loop itself is tracker-utils.mjs's, unchanged — its lock-key
 * derivation is mirrored in Go and parity-tested.
 *
 * @param {string} trackerPath - Tracker path.
 * @param {(path: string) => any} fn - Body, run while the lock is held.
 * @param {object} [options] - Lock timing overrides, plus `env`.
 * @returns {Promise<any>} Whatever `fn` returned.
 */
export async function withTrackerLock(trackerPath, fn, options = {}) {
  const { env = process.env, ...lockOptions } = options;
  const path = canonicalPath(trackerPath);
  const lock = await acquireTrackerLock(trackerLockDirFor(path), {
    ...trackerLockTiming(env),
    tracker: path,
    ...lockOptions,
  });
  try {
    return await fn(path);
  } finally {
    lock.release();
  }
}

/**
 * One serialized read/modify/write against the tracker.
 *
 * The lock must cover the READ as well as the write: two processes that read
 * the same snapshot and write independent updates lose the earlier writer's
 * rows entirely, with no error (D3.1). `fn` gets read and replace and nothing
 * else, so the sequence cannot be split.
 *
 * @param {string} trackerPath - Tracker path.
 * @param {(tx: {path: string, read: Function, replace: Function}) => any} fn - Body.
 * @param {object} [options] - Lock timing overrides, plus `env`.
 * @returns {Promise<any>} Whatever `fn` returned.
 */
export async function withTrackerTransaction(trackerPath, fn, options = {}) {
  return withTrackerLock(trackerPath, path => {
    let open = true;
    const assertOpen = () => {
      if (!open) throw new Error('Tracker transaction is already closed');
    };
    try {
      return fn({
        path,
        read() { assertOpen(); return readFile(path); },
        replace(content) { assertOpen(); writeFileAtomic(path, content); },
      });
    } finally {
      open = false;
    }
  }, options);
}

/**
 * Hold the lock on a pipeline-family file (`data/pipeline.md`,
 * `data/scan-history.tsv`, the agent inbox) for the duration of `fn`.
 *
 * src/lib/pipeline-lock.mjs verbatim: its lock is a directory beside the file, and its
 * wait policy is the one the other three lock modules import their verdict
 * from. The three unlocked whole-file rewriters (src/scripts/batch-evaluate-gemini.mjs:353,
 * src/scripts/reconcile-pipeline.mjs:298, src/scripts/openrouter-runner.mjs:505) are the ones that
 * need to start calling this — the lock protects nobody while one side never
 * asks for it (D3.1).
 *
 * @param {string} path - File the lock guards.
 * @param {() => any} fn - Body, run while the lock is held.
 * @param {object} [options] - Lock timing overrides.
 * @returns {Promise<any>} Whatever `fn` returned.
 */
export async function withFileLock(path, fn, options = {}) {
  return withPipelineLock(path, fn, options);
}

/**
 * Is this error a lock that stayed busy, as opposed to a filesystem or config
 * failure? The distinction decides exit 4 vs exit 2.
 *
 * Three shapes exist and none of the modules knows about the others:
 * src/lib/pipeline-lock.mjs:48 throws `LockTimeoutError`, tracker-utils.mjs:459 throws
 * an Error tagged `code: 'LOCK_TIMEOUT'`, and followup-seed.mjs:435 throws
 * `SeedError('LOCK_TIMEOUT')`. One predicate rather than three call-site checks.
 *
 * @param {unknown} err - Error to classify.
 * @returns {boolean} True when the operation timed out waiting for a lock.
 */
export function isLockTimeout(err) {
  return err?.code === 'LOCK_TIMEOUT' || err?.name === 'LockTimeoutError';
}

export { lockDirFor };
