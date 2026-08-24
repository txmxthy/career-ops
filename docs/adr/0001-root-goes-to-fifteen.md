# ADR 0001 — Root goes to 15 files; the updater gets forked to allow it

**Status:** accepted (revised 2026-08-24 after review — the earlier "root filenames stay"
version is superseded and recorded below as the rejected option)
**Date:** 2026-08-24

## Context

The requirement is a root directory you can read in one screen. Today it holds 127 `.mjs`.

The audit derived the genuinely-frozen set from real references rather than assuming it:
**15 root scripts**, each pinned by a consumer outside this refactor's reach — the separately
distributed Go binary, the separately-versioned web app, or the updater itself
(`docs/audit/public-surface.md` §2 names the consumer for each). That is comfortably under the
20 the brief expected, and it means **112 of 127 root files have no external consumer at all.**

The obstacle is not downstream. It is `update-system.mjs`:

- It computes its checkout set as the **union** of local and upstream manifests (`:1648-1658`).
- `mergePathLists` (`:801-812`) is a de-duplicating concatenation that never subtracts.
- The only prune, `staleSystemFiles` (`:824-832`, called at `:1764` with the **local**
  `SYSTEM_PATHS`), filters to files **absent from the remote tree** — so anything still present
  upstream can never be pruned.

Left alone, every moved file is restored on the next `npm run update` and then coexists with
its replacement in `src/`. `package.json` is not in `USER_PATHS` (`:412`), so a wrapper script
there would itself be overwritten.

## Decision

**Move all 112 unpinned scripts into `src/`. Keep 15 at root as shims. Fork the updater.**

Root after this change: 15 `.mjs` shims, each ~3 lines, delegating into `src/`.

The updater fork has three parts, because one alone is not enough:

1. **`REMOVED_PATHS`** — a local manifest subtracted from `updatePaths` after `mergePathLists`.
   Handles the normal case.
2. **`career-ops system prune`** — removes any file matching `REMOVED_PATHS` that exists on
   disk. Handles the case the updater re-execs the **remote** copy of itself (`:1650`,
   `resolveReexecCheckout` at `:853+`) and so runs upstream's merge logic instead of ours.
3. **A check in `doctor.mjs`** that reports resurrected files as a warning. Detection is the
   part that must not fail, because the other two can be bypassed by a mid-update overwrite.

`update-system.mjs` itself stays at root — it is frozen absolutely, since every installed copy
resolves it by literal name in `FETCH_HEAD`.

## Consequences

- Root goes 127 → 15. This is the requirement.
- **Upstream cherry-picks get harder.** Priced honestly: this is real, and it is the main cost.
  It is also weaker than it looks — consolidating 11 table-parse algorithms into one means
  those files would not merge cleanly regardless of where they live.
- `npm run update` is no longer the recommended path for this fork. Deliberate
  `git fetch upstream && git cherry-pick` is, and the README must say so.
- Steps 2 and 3 above exist because step 1 can be silently bypassed. If a resurrected file ever
  ships, it will be because detection was skipped — so `doctor.mjs`'s check is not optional.

## Rejected

- **Keep root filenames, dedupe only inside files.** Costs nothing and delivers every
  deduplication target, but leaves 127 files at root. Rejected: the root count is the
  requirement, not a side effect of it.
- **Stop tracking upstream entirely.** Simplest, but discards upstream's fixes permanently for
  no gain over forking the updater.
