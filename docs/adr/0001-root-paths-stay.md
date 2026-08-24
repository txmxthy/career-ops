# ADR 0001 — Root filenames stay; deduplication happens inside them

**Status:** accepted (supersedes the brief's "everything moves into `src/`" default)
**Date:** 2026-08-24

## Context

The brief's default was: everything moves into `src/`, and a root-level file must be argued
for. The reasoning was that this fork has no downstream, so upstream's path-stability
constraint is not ours.

That is true about *downstream*. The audit found a constraint in the other direction that the
brief did not price.

`update-system.mjs apply` computes its checkout set as the **union** of the local and upstream
manifests (`update-system.mjs:1648-1658`). `mergePathLists` (`:801-812`) is a de-duplicating
concatenation that never subtracts. The only deletion mechanism, `staleSystemFiles`
(`:824-832`, called at `:1764`), filters to files **absent from the remote tree** — so a file
that still exists upstream can never be pruned.

Therefore: **every root script we delete or move is restored on the next `npm run update`**,
and then coexists with our replacement. Confidence high — the code path was read end to end,
not executed.

There are exactly three shapes available:

| Option | Cost |
|---|---|
| 1. Stop tracking upstream | Lose upstream's fixes permanently. Only the 15 frozen paths bind. |
| 2. Keep tracking; dedupe *inside* files, leave root filenames alone | None identified. |
| 3. Fork the updater to subtract a local `REMOVED_PATHS` | Collides with the absolute freeze: the updater re-execs the **remote** copy of itself (`:1650`, `resolveReexecCheckout` at `:853+`), so the change must survive being overwritten by upstream's own version mid-update. |

## Decision

**Option 2.** Root `.mjs` filenames stay where they are. Each becomes a thin shim over
extracted core logic.

This is not a concession. It delivers every non-negotiable in the brief in full — one table
parser, one data-access module, one flag parser, one test directory — because the duplication
is *inside* the files, not in their arrangement. 92 root scripts read files directly and 84
hand-parse `argv`; shimming costs one import line each.

The brief asked that a root-level file be argued for rather than assumed. The argument, derived
rather than assumed, is that while we track upstream all 127 are argued for by the updater.

## Consequences

- The strong claim survives intact and becomes literally true: the parsers collapse to one and
  **not a single public path moves**.
- Upstream cherry-picks stay mechanically easy for files we only hollow out.
- Root stays visually noisy. That cost is real and is accepted. Revisit only by taking
  Option 1 or 3 deliberately, in a separate ADR.
- `src/` still gets created — it holds the extracted core and the new CLI. Root becomes a layer
  of shims over it, not a parallel implementation.

## Follow-up

If the root listing later matters more than upstream tracking, Option 3 is the path, and
ADR 0001 is superseded rather than amended. Do not attempt it incrementally: a half-forked
updater that gets overwritten mid-run is worse than either endpoint.
