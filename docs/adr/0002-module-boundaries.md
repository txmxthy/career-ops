# ADR 0002 — Four core modules, not twelve

**Status:** accepted
**Date:** 2026-08-24

## Context

The instruction was ports-and-adapters with a pure domain core. The stated risk was
over-modularisation: upstream over-produced *files*, and the classic overcorrection is
over-producing *packages*. A module with one consumer and no plausible second is the same debt
in a nicer hat.

The audit gives consumer counts, so module boundaries can be drawn from evidence rather than
taste. `lib/` already demonstrates the pattern in this repo (9 modules, 39 root importers).

## Decision

Four core modules under `src/core/`, each justified by a real multi-consumer count from the
audit. Anything with one consumer stays inline in its caller.

| Module | Replaces | Consumers |
|---|---|---|
| `src/core/table.js` | 11 distinct row-parse algorithms across 27 root files (81 call sites) | 27 |
| `src/core/store.js` | tracker path resolution (12), pipeline path resolution (8), missing-file contracts (15), write/lock/backup | 92 `readFileSync` sites |
| `src/core/flags.js` | 3 `flagValue` + 10 `parseArgs` + 3 `parseCliArgs`; absorbs `lib/cli-flags.mjs` | 84 |
| `src/core/text.js` | status normalization (7), company key (5), URL key (4), slugs (14+2), ASCII folding, `toEpochMs` (27 copies), HTML→text (7), HTML escaping (4) | broad |

Dates (`today` 3 forms/21 sites, ISO parse 6, day-diff 5) fold into `src/core/text.js`'s
sibling `src/core/dates.js` **only if** it exceeds ~150 lines; otherwise it lives in `text.js`.
Decided at implementation time by size, not up front.

Adapters, at the edges, one file each: `src/adapters/{fs,playwright,ats,pdf}.js`.

## Explicitly rejected

- A module per capability (would be ~20). Most have a single natural home above.
- A `src/domain/` / `src/application/` / `src/infrastructure/` triple. Ceremony; this codebase
  has no layering problem, it has a duplication problem.
- Extracting PDF rendering. The audit found 3 production + 1 test implementation and concluded
  it is **not** a duplicate capability — they render different documents.
- Consolidating the Go mirrors (`tracker_lock.go:87`, `career.go:595`, `career.go:937`). Go
  cannot import `.mjs`; the correct action is keeping the parity tests.

## Consequences

Four modules is a number a person can hold in their head. If a fifth becomes obviously
necessary during execution, add it in a superseding ADR with its consumer count — not by
drifting.
