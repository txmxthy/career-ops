/**
 * system-prune.test.mjs — part 2 of the ADR 0001 updater fork.
 *
 * Subtracting REMOVED_PATHS inside apply() only binds the copy of the updater
 * that runs the update, and normally that is not ours: the re-exec stage
 * checks update-system.mjs out of FETCH_HEAD and runs THAT, so an update
 * executes upstream's merge logic, which restores every root script the move
 * removed. `prune` is the repair, so what it has to prove is the failure mode
 * itself — seed a resurrected file, then show it goes away.
 *
 * Each case is a throwaway git repo holding a copy of the real updater, so the
 * code under test is the shipped file, not a stub of it.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, run, lastRunFailure, rmSync, ROOT } from './helpers.mjs';

const sandboxes = [];

/**
 * A git repo shaped like this fork after the move: the real updater, one
 * frozen root script, one moved script in its new home.
 *
 * @param {(source: string) => string} [rewriteUpdater] - Optional transform of
 *   the updater source, for the copies that have lost their manifest.
 * @returns {string} Absolute path to the sandbox.
 */
function install(rewriteUpdater) {
  // realpathSync: on macOS tmpdir() is under a symlinked /var, and the
  // updater only runs its CLI when process.argv[1] resolves to its own
  // import.meta.url — through the symlink it silently exits 0 doing nothing.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'co-prune-')));
  sandboxes.push(dir);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' });
  g('init', '-q', '-b', 'main', '.');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');

  const source = readFileSync(join(ROOT, 'update-system.mjs'), 'utf-8');
  writeFileSync(join(dir, 'update-system.mjs'), rewriteUpdater ? rewriteUpdater(source) : source);
  writeFileSync(join(dir, 'scan.mjs'), '// frozen root script\n');
  mkdirSync(join(dir, 'src', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'src', 'scripts', 'scan-hn.mjs'), '// the replacement\n');
  g('add', '-A');
  g('commit', '-qm', 'fork state');
  return dir;
}

/** Put removed root scripts back, committed, exactly as an update leaves them. */
function resurrect(dir, paths) {
  for (const path of paths) writeFileSync(join(dir, path), '// restored by upstream\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'auto-update system files'], { cwd: dir, stdio: 'pipe' });
}

/** Run the sandbox's own updater. Returns {code, stdout, stderr}. */
function prune(dir, args = []) {
  // stdio piped: the exit-3 cases print their reason to stderr on purpose,
  // and an inherited stderr puts it in the middle of the suite's own output.
  const stdout = run('node', [join(dir, 'update-system.mjs'), 'prune', ...args],
    { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const failure = lastRunFailure();
  return failure
    ? { code: failure.status, stdout: failure.stdout, stderr: failure.stderr }
    : { code: 0, stdout, stderr: '' };
}

const gitStatus = (dir) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' });

try {
  // ── 1. A resurrected file is removed ─────────────────────────────────────
  {
    const dir = install();
    resurrect(dir, ['scan-hn.mjs', 'find.mjs']);

    // The failure mode, asserted before the fix runs — without this the rest
    // could pass against a repo that never had the problem.
    if (existsSync(join(dir, 'scan-hn.mjs')) && existsSync(join(dir, 'find.mjs'))) {
      pass('seeded: two removed root scripts are back on disk');
    } else {
      fail('could not seed the resurrection — the rest of this case proves nothing');
    }

    const result = prune(dir, ['--json']);
    const data = JSON.parse(result.stdout || '{}');

    if (result.code === 0) pass('prune exits 0 after cleaning up');
    else fail(`prune exited ${result.code}: ${result.stderr.trim()}`);

    if (!existsSync(join(dir, 'scan-hn.mjs')) && !existsSync(join(dir, 'find.mjs'))) {
      pass('prune removed both resurrected files from disk');
    } else {
      fail('prune left a resurrected file on disk');
    }

    if (data.pruned?.length === 2 && data.pruned.includes('scan-hn.mjs') && data.pruned.includes('find.mjs')) {
      pass('prune --json reports exactly what it removed');
    } else {
      fail(`prune --json reported ${JSON.stringify(data.pruned)}`);
    }

    // Staged, not committed: the deletion has to reach the index or the next
    // checkout writes the file straight back out of it.
    const status = gitStatus(dir);
    if (/^D\s+find\.mjs$/m.test(status) && /^D\s+scan-hn\.mjs$/m.test(status)) {
      pass('prune stages the deletions rather than only unlinking');
    } else {
      fail(`deletions are not staged — git status:\n${status}`);
    }

    if (existsSync(join(dir, 'scan.mjs')) && existsSync(join(dir, 'src', 'scripts', 'scan-hn.mjs'))) {
      pass('prune touches neither the frozen root script nor the replacement in src/');
    } else {
      fail('prune deleted a file it must never touch');
    }
  }

  // ── 2. An untracked resurrection is removed but never called "staged" ────
  // `git rm --ignore-unmatch` exits 0 on an untracked path, so trackedness has
  // to be checked rather than inferred — otherwise prune claims an index change
  // that did not happen, and the user commits nothing believing they did.
  {
    const dir = install();
    writeFileSync(join(dir, 'scan-hn.mjs'), '// left behind by a crashed apply\n');
    const result = prune(dir, ['--json']);
    const data = JSON.parse(result.stdout || '{}');

    if (!existsSync(join(dir, 'scan-hn.mjs')) && data.pruned?.includes('scan-hn.mjs')) {
      pass('an untracked resurrected file is removed too');
    } else {
      fail(`untracked file not removed: ${JSON.stringify(data)}`);
    }

    if (Array.isArray(data.staged) && data.staged.length === 0) {
      pass('and it is not reported as staged, because nothing was staged');
    } else {
      fail(`prune claimed it staged ${JSON.stringify(data.staged)} for an untracked file`);
    }
  }

  // ── 3. A clean install ───────────────────────────────────────────────────
  {
    const dir = install();
    const result = prune(dir, ['--json']);
    const data = JSON.parse(result.stdout || '{}');
    if (result.code === 0 && data.found?.length === 0 && data.scanned >= 100) {
      pass(`prune on a clean install reports 0 of ${data.scanned} paths back`);
    } else {
      fail(`prune on a clean install: exit ${result.code}, ${JSON.stringify(data)}`);
    }
  }

  // ── 4. --dry-run deletes nothing ─────────────────────────────────────────
  {
    const dir = install();
    resurrect(dir, ['scan-hn.mjs']);
    const result = prune(dir, ['--json', '--dry-run']);
    const data = JSON.parse(result.stdout || '{}');
    if (existsSync(join(dir, 'scan-hn.mjs')) && data.pruned?.includes('scan-hn.mjs') && data.dryRun === true) {
      pass('--dry-run names the file it would remove and leaves it alone');
    } else {
      fail(`--dry-run misbehaved: exists=${existsSync(join(dir, 'scan-hn.mjs'))}, json=${JSON.stringify(data)}`);
    }
  }

  // ── 5. An updater with no manifest cannot report a clean tree ────────────
  // This is the state an update leaves behind when it overwrites our copy with
  // upstream's: no REMOVED_PATHS at all. "Nothing to prune" and "I do not know
  // what was removed" produce identical output, so the second has to be 3.
  {
    const dir = install((src) => src.replace(/const REMOVED_PATHS = \[[\s\S]*?\n\];/, 'const REMOVED_PATHS = [];'));
    resurrect(dir, ['scan-hn.mjs']);
    const result = prune(dir);

    if (result.code === 3) pass('an updater with an empty manifest exits 3, not 0');
    else fail(`empty manifest exited ${result.code}, expected 3`);

    if (/could not verify/.test(result.stderr)) {
      pass('it says "could not verify" rather than reporting nothing found');
    } else {
      fail(`no "could not verify" in stderr: ${result.stderr.trim()}`);
    }

    if (existsSync(join(dir, 'scan-hn.mjs'))) {
      pass('it deletes nothing when it cannot tell what to delete');
    } else {
      fail('an updater with no manifest deleted a file anyway');
    }
  }

  // ── 6. A manifest that contradicts the system layer is refused ───────────
  // A path that is both removed and shipped is a manifest bug, and acting on
  // it means deleting part of the install.
  {
    const dir = install((src) => src.replace(/const REMOVED_PATHS = \[[\s\S]*?\n\];/, "const REMOVED_PATHS = [\n  'scan.mjs',\n];"));
    const result = prune(dir);

    if (result.code === 3 && /could not verify/.test(result.stderr)) {
      pass('a REMOVED_PATHS entry that SYSTEM_PATHS ships is refused at exit 3');
    } else {
      fail(`conflicting manifest: exit ${result.code}, stderr ${result.stderr.trim()}`);
    }

    if (existsSync(join(dir, 'scan.mjs'))) {
      pass('the shipped file it would have deleted is still there');
    } else {
      fail('prune deleted a file the system layer ships');
    }
  }
  // ── 7. A resurrected DIRECTORY is removed, recursively ───────────────────
  // ADR 0007 put whole directories in REMOVED_PATHS ('fonts/', 'examples/',
  // 'evals/', 'test-fixtures/', 'test/cv-visual/'). Upstream checks a directory
  // pathspec back out with its whole contents, so a plain unlink or a `git rm`
  // without -r leaves the resurrection standing and prune reports success over
  // a directory that is still there.
  {
    const dir = install();
    mkdirSync(join(dir, 'examples', 'latex-tex'), { recursive: true });
    writeFileSync(join(dir, 'examples', 'README.md'), '# restored by upstream\n');
    writeFileSync(join(dir, 'examples', 'latex-tex', 'resume.tex'), '% restored\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'auto-update system files'], { cwd: dir, stdio: 'pipe' });

    if (existsSync(join(dir, 'examples', 'latex-tex', 'resume.tex'))) {
      pass('seeded: a removed directory is back, with a file nested inside it');
    } else {
      fail('could not seed the directory resurrection — the rest of this case proves nothing');
    }

    const result = prune(dir, ['--json']);
    const data = JSON.parse(result.stdout || '{}');

    if (result.code === 0) pass('prune exits 0 after cleaning up a directory');
    else fail(`prune exited ${result.code}: ${result.stderr.trim()}`);

    if (!existsSync(join(dir, 'examples'))) {
      pass('prune removed the directory and everything under it');
    } else {
      fail('prune left the resurrected directory on disk');
    }

    if (data.pruned?.includes('examples/')) {
      pass('prune --json names the directory entry it removed');
    } else {
      fail(`prune --json reported ${JSON.stringify(data.pruned)}`);
    }

    // `git rm` without -r fails on a directory, which would leave the nested
    // blobs in the index for the next checkout to write straight back.
    const status = gitStatus(dir);
    if (/^D\s+examples\/README\.md$/m.test(status) && /^D\s+examples\/latex-tex\/resume\.tex$/m.test(status)) {
      pass('prune stages the deletion of every file under the directory');
    } else {
      fail(`nested deletions are not staged — git status:\n${status}`);
    }
  }
} finally {
  for (const dir of sandboxes) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* leave it to the OS */ }
  }
}
