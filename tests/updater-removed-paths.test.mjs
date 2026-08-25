/**
 * updater-removed-paths.test.mjs — part 1 of the ADR 0001 updater fork.
 *
 * The failure this pins: `apply` computes its checkout set as
 * mergePathLists(SYSTEM_PATHS, remoteSystemPaths, BOOTSTRAP_PATHS), and
 * mergePathLists is a de-duplicating concatenation that never subtracts.
 * Upstream's SYSTEM_PATHS still names every root path this fork moved
 * into src/, so without a subtraction step every one of them is checked back
 * in beside its replacement — and staleSystemFiles cannot clean up after it,
 * because it only prunes what is ABSENT upstream.
 *
 * Covered here:
 *   - the union restores removed paths, and subtractRemovedPaths takes them
 *     back out without touching anything else
 *   - REMOVED_PATHS never contradicts SYSTEM_PATHS (pruning a shipped file
 *     would delete part of the install)
 *   - no removed path is on disk in this checkout — the root-stays-15 invariant
 *   - the manifest is readable by the source parser doctor.mjs uses, which is
 *     the coupling that makes part 3 work at all
 *   - apply() actually applies the subtraction
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';
import {
  extractArrayFromSource,
  removedPathConflicts,
  resurrectedPaths,
  subtractRemovedPaths,
} from '../update-system.mjs';

const source = readFileSync(join(ROOT, 'update-system.mjs'), 'utf-8');
const REMOVED = extractArrayFromSource(source, 'REMOVED_PATHS');
const SYSTEM = extractArrayFromSource(source, 'SYSTEM_PATHS');

// ── 1. The manifest exists and is big enough to be the real one ────────────
{
  if (REMOVED.length >= 100) {
    pass(`REMOVED_PATHS declares ${REMOVED.length} removed root paths`);
  } else {
    fail(`REMOVED_PATHS has ${REMOVED.length} entries — the moves removed 157 root paths`);
  }
}

// ── 2. The union restores them; the subtraction takes them back out ────────
// Stands in for apply()'s merge: upstream's manifest still lists the root
// scripts, ours does not, and the concatenation keeps both sides.
{
  const upstreamManifest = ['scan-hn.mjs', 'find.mjs', 'add-entry.mjs', 'modes/scan.md'];
  const union = [...new Set([...SYSTEM, ...upstreamManifest])];

  const restored = upstreamManifest.filter((p) => union.includes(p) && REMOVED.includes(p));
  if (restored.length === 3) {
    pass('the merged manifest restores removed root scripts (the bug being fixed)');
  } else {
    fail(`expected the union to restore 3 removed paths, it restored ${restored.length}`);
  }

  const subtracted = subtractRemovedPaths(union);
  const survivors = REMOVED.filter((p) => subtracted.includes(p));
  if (survivors.length === 0) {
    pass('subtractRemovedPaths removes every removed path from the merged manifest');
  } else {
    fail(`subtractRemovedPaths left ${survivors.length} removed path(s): ${survivors.slice(0, 5).join(', ')}`);
  }

  // The other side of the same assertion: it must not eat the system layer.
  const lost = SYSTEM.filter((p) => !subtracted.includes(p));
  if (lost.length === 0) {
    pass('subtractRemovedPaths keeps every SYSTEM_PATHS entry');
  } else {
    fail(`subtractRemovedPaths dropped ${lost.length} system path(s): ${lost.slice(0, 5).join(', ')}`);
  }

  if (subtracted.includes('modes/scan.md')) {
    pass('subtractRemovedPaths keeps an upstream-only path that was never removed');
  } else {
    fail('subtractRemovedPaths dropped modes/scan.md, which this fork never removed');
  }
}

// ── 3. A path cannot be both removed and shipped ───────────────────────────
{
  const conflicts = removedPathConflicts();
  if (conflicts.length === 0) {
    pass('no REMOVED_PATHS entry is also covered by SYSTEM_PATHS');
  } else {
    fail(`${conflicts.length} path(s) are both removed and shipped: ${conflicts.join(', ')}`);
  }
}

// ── 4. None of them are on disk here ───────────────────────────────────────
{
  const back = resurrectedPaths(ROOT);
  if (back.length === 0) {
    pass('no removed path exists in this checkout');
  } else {
    fail(`${back.length} removed path(s) are back at the root: ${back.slice(0, 5).join(', ')}`);
  }
}

// ── 5. doctor.mjs's parser can read the manifest out of the source ─────────
// doctor reads REMOVED_PATHS as TEXT (so `--target` reads the target's copy,
// and so a clobbered updater cannot be executed by the check). That only works
// while the array stays a plain literal the extractor can see.
{
  if (REMOVED.length > 0 && REMOVED.includes('scan-hn.mjs')) {
    pass('extractArrayFromSource reads REMOVED_PATHS out of update-system.mjs');
  } else {
    fail('extractArrayFromSource could not read REMOVED_PATHS — doctor’s check cannot run');
  }
}

// ── 6. apply() applies it ──────────────────────────────────────────────────
// Asserted against the source rather than by driving apply(), which needs a
// network fetch and a re-exec. A manifest that exists but is never subtracted
// is exactly the silent half-fix this file exists to prevent, so the wiring is
// worth pinning even in this weaker form.
{
  if (/const updatePaths = subtractRemovedPaths\(\s*\n\s*mergePathLists\(/.test(source)) {
    pass('apply() subtracts REMOVED_PATHS from the merged update set');
  } else {
    fail('apply() no longer wraps mergePathLists in subtractRemovedPaths — removed paths will be restored');
  }
}

// ── 7. The post-reexec cleanup is wired ────────────────────────────────────
// The re-exec runs the updater fetched from upstream, which has no manifest at
// all; this process is the last one that holds ours, so the prune has to
// happen here or not at all.
{
  if (/execFileSync\(process\.execPath[\s\S]{0,1200}?printPruneResult\(pruneRemovedPaths\(ROOT\)\)/.test(source)) {
    pass('apply() prunes with the in-memory manifest after the re-exec returns');
  } else {
    fail('apply() no longer prunes after the self-reexec — upstream’s updater runs unchecked');
  }
}
