/**
 * doctor-resurrected-paths.test.mjs — part 3 of the ADR 0001 updater fork.
 *
 * Parts 1 and 2 can both be bypassed. apply()'s subtraction only binds the
 * copy of the updater that runs the update, and the re-exec stage runs the one
 * it fetched from upstream; prune() repairs that, but only when someone runs
 * it. Detection is what has to hold, so this suite drives doctor.mjs against
 * seeded checkouts and pins what it says about each.
 *
 * Both surfaces are checked, because they have different consumers: the human
 * report (a ⚠ line in `npm run doctor`) and `--json`'s `warnings` array, which
 * is the frozen field the web app reads (public-surface.md §2 row 5).
 *
 * The load-bearing case is the third one. An updater that has lost its
 * manifest and a checkout with nothing resurrected produce the same evidence —
 * no files listed — and mean opposite things, so a doctor that reports the
 * first as a pass is worse than one that does not check at all.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, run, lastRunFailure, rmSync, ROOT } from './helpers.mjs';

const sandboxes = [];
const UPDATER = readFileSync(join(ROOT, 'update-system.mjs'), 'utf-8');

/**
 * A checkout for doctor to diagnose.
 *
 * @param {{updater?: string|null, resurrect?: string[]}} [opts] - `updater` is
 *   the update-system.mjs source (null writes no updater at all); `resurrect`
 *   names removed root scripts to put back.
 * @returns {string} Absolute path to the sandbox.
 */
function checkout({ updater = UPDATER, resurrect = [] } = {}) {
  // realpathSync for the same reason the prune suite needs it: doctor resolves
  // its target against real paths, and macOS tmpdir() sits under a symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'co-doctor-resurrect-')));
  sandboxes.push(dir);
  if (updater !== null) writeFileSync(join(dir, 'update-system.mjs'), updater);
  mkdirSync(join(dir, 'src', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'src', 'scripts', 'scan-hn.mjs'), '// the replacement\n');
  for (const path of resurrect) writeFileSync(join(dir, path), '// restored by upstream\n');
  return dir;
}

/** doctor's `--json` warnings for a target. */
function jsonWarnings(dir) {
  const stdout = run('node', [join(ROOT, 'doctor.mjs'), '--target', dir, '--json'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  if (stdout === null) {
    const failure = lastRunFailure();
    throw new Error(`doctor --json exited ${failure?.status}: ${failure?.stderr}`);
  }
  return JSON.parse(stdout).warnings || [];
}

/** The line the human report prints for this check, or ''. */
function reportLine(dir) {
  // doctor exits 1 on a bare checkout (no cv.md, no deps) — expected, and not
  // what this suite is about. The line is read out of stdout either way.
  const stdout = run('node', [join(ROOT, 'doctor.mjs'), '--target', dir],
    { stdio: ['pipe', 'pipe', 'pipe'] }) ?? lastRunFailure()?.stdout ?? '';
  return String(stdout).split('\n').find((l) => l.includes('Removed root scripts')) || '';
}

const strip = (text) => String(text).replace(/\[\d+m/g, '');

try {
  // ── 1. Resurrected files are reported ────────────────────────────────────
  {
    const dir = checkout({ resurrect: ['scan-hn.mjs', 'find.mjs'] });

    // The seed itself, asserted — otherwise a check that reports nothing would
    // pass this case for the wrong reason.
    if (existsSync(join(dir, 'scan-hn.mjs')) && existsSync(join(dir, 'find.mjs'))) {
      pass('seeded: two removed root scripts are back in the target checkout');
    } else {
      fail('could not seed the resurrection — the rest of this case proves nothing');
    }

    const warnings = jsonWarnings(dir);
    const warning = warnings.find((w) => w.includes('Removed root scripts'));
    if (warning) {
      pass('doctor --json warns about resurrected root scripts');
    } else {
      fail(`doctor --json did not warn. warnings: ${JSON.stringify(warnings)}`);
    }

    if (warning && warning.includes('scan-hn.mjs') && warning.includes('find.mjs')) {
      pass('the warning names the files that came back');
    } else {
      fail(`the warning does not name both files: ${warning}`);
    }

    if (warning && /career-ops system prune/.test(warning)) {
      pass('the warning points at the command that fixes it');
    } else {
      fail(`the warning offers no fix: ${warning}`);
    }

    const line = strip(reportLine(dir));
    if (/^⚠/.test(line.trim()) && line.includes('2 back at the root')) {
      pass('the human report prints it as a warning, not a pass');
    } else {
      fail(`human report line was: ${line || '(absent)'}`);
    }
  }

  // ── 2. A clean checkout passes ───────────────────────────────────────────
  {
    const dir = checkout();
    const warnings = jsonWarnings(dir);
    if (!warnings.some((w) => w.includes('Removed root scripts'))) {
      pass('a checkout with nothing resurrected produces no warning');
    } else {
      fail(`clean checkout warned anyway: ${JSON.stringify(warnings)}`);
    }

    const line = strip(reportLine(dir));
    if (/none of \d+ are back/.test(line)) {
      pass('the human report says how many paths it checked, not just "ok"');
    } else {
      fail(`clean report line was: ${line || '(absent)'}`);
    }
  }

  // ── 3. A lost manifest is "could not verify", never a pass ───────────────
  // This is the state an update leaves behind: our updater overwritten by
  // upstream's, which has no REMOVED_PATHS. The file that came back is still
  // there; the only thing missing is the knowledge that it should not be.
  {
    const dir = checkout({
      updater: UPDATER.replace(/const REMOVED_PATHS = \[[\s\S]*?\n\];/, 'const REMOVED_PATHS = [];'),
      resurrect: ['scan-hn.mjs'],
    });
    const warnings = jsonWarnings(dir);
    const warning = warnings.find((w) => w.includes('Removed root scripts'));

    if (warning && /could not verify/.test(warning)) {
      pass('an updater with no manifest reports "could not verify"');
    } else {
      fail(`expected a could-not-verify warning, got: ${warning || JSON.stringify(warnings)}`);
    }

    const line = strip(reportLine(dir));
    if (/^⚠/.test(line.trim())) {
      pass('and it is a warning in the human report, not a ✓');
    } else {
      fail(`human report line was: ${line || '(absent)'}`);
    }
  }

  // ── 4. No updater at all ─────────────────────────────────────────────────
  {
    const dir = checkout({ updater: null, resurrect: ['scan-hn.mjs'] });
    const warning = jsonWarnings(dir).find((w) => w.includes('Removed root scripts'));
    if (warning && /could not verify/.test(warning) && /does not exist/.test(warning)) {
      pass('a missing update-system.mjs is reported as unverifiable, naming the path');
    } else {
      fail(`expected could-not-verify for a missing updater, got: ${warning || '(no warning)'}`);
    }
  }
} finally {
  for (const dir of sandboxes) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* leave it to the OS */ }
  }
}
