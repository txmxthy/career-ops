# career-ops fork — deduplicate the core, keep the paths

Collated program plan. Supersedes nothing in `docs/audit/`; that is the evidence, this is
the sequencing.

## Why this fork exists

The product design is sound — the A–G rubric, human-in-the-loop by default, the refusal to
auto-submit. The internals have no owner. This fork takes ownership of the internals and
changes nothing about the product.

Upstream declined a root reorg because 12,928 forks depend on his paths. That reasoning is
correct for him. We inherit none of it: this fork has no downstream, and its only consumers
are `modes/*.md` files we control and rewrite in the same commit.

## What the audit changed about the premise

Upstream is **already running this consolidation by hand, one symbol at a time, and it has
stalled mid-migration.** `src/lib/portal-health-lock.mjs:35-37`, `tracker-utils.mjs:22-24` and
`followup-seed.mjs:68-70` all import `lockRecoveryVerdict`, `RECOVER_STALE` and
`OWNERLESS_GRACE_MS` from `src/lib/pipeline-lock.mjs`. But `readLockOwner` was left behind in all
three (`:75`, `:244`, `:291`) — still returning bare `null` where the canonical copy
(`src/lib/pipeline-lock.mjs:76`) returns `{inspected, owner}`. It could not have been imported:
`src/lib/pipeline-lock.mjs` exports 14 symbols and that is not one of them. `sameLockDirectory` is
duplicated in two files despite the canonical one being exported at `src/lib/pipeline-lock.mjs:105`.

This is the argument for the work, and it is stronger than "there are 27 parsers":
**hand-migration does not converge.** The leftovers are the proof.

## Constraints

1. **Public paths do not move.** Where a root path has a real external consumer, it stays and
   becomes a shim. The frozen set is derived in `docs/audit/public-surface.md`, not assumed.
2. **`package.json` script *names* are the contract, not the paths they point at.** All 59 can
   be repointed (`"scan": "node src/commands/scan.js"`) without breaking a documented
   invocation. This is what keeps the frozen set small.
3. **Deduplication is unconditional** and does not depend on the path decision.
4. **Divergences are decided in an ADR before consolidation, never by the consolidating agent.**
   Where two implementations disagree, a human picks the winner and a characterisation test
   records the deliberate change.
5. **Leave alone:** the A–G rubric, `providers/` (87 `.mjs`, already well-factored), the `cops`
   launcher, translations.

## Phase 1 — Design (documents only, `docs/adr/`)

- **Module boundaries** as ADRs. Ports-and-adapters: pure domain core (evaluation, scoring,
  tracker state), I/O at the edges (filesystem, Playwright, ATS providers, PDF).
  Bias against ceremony — four honest modules beat twelve. A module with one consumer and no
  plausible second is the same debt in a nicer hat.
- **Command taxonomy.** Every one of the 127 root scripts mapped to `career-ops <noun> <verb>`,
  or "dead, delete", or "merged into X". Full table, no gaps.
- **Divergence decisions.** One ADR per divergence the audit flagged, each naming the winner
  and the behaviour change it accepts.
- **Migration strategy.** Strangler fig: core extracted first, shims hollowed one at a time,
  public names untouched throughout. No big-bang commit.

## Phase 2 — Execution, in this order

Each step shrinks the next.

1. Markdown table parser → `src/core/` — **landed** (`src/core/table.js`)
2. Data access (pipeline/tracker/config location and I/O) — **landed** (`src/core/store.js`)
3. Flag parsing — **landed** (`src/core/flags.js`)
4. Command modules — **landed** (`src/cli.js`, `src/commands/`, 84 commands)
5. Hollow root scripts into shims, one per commit — **landed** (112 moved, 15 left at root)
6. Consolidate 3 test locations and 3 naming conventions into one `tests/` — **landed**
   (5 locations → 3; `test/` and `test-fixtures/` folded in, 17 loose root suites moved)

Rules: characterisation tests before consolidating anything; `"type": "module"` in
`package.json`; new files `.js`, existing root `.mjs` names stay; one logical change per
commit, conventional commits, green suite at every commit; delete dead code aggressively —
git has it. Shims are not dead code.

## The CLI — additive, not a replacement

`career-ops <noun> <verb>`, built **alongside** the shims. Shims delegate into it, so there is
exactly one code path per capability and two ways to invoke it. The 127 scripts are the LLM's
tool surface — `modes/*.md` shells out by name — and that is a legitimate design for agent
invocation. The CLI must be a better tool surface, not merely a tidier one:

- `--help` enumerates every command; `<cmd> --help` documents each.
- **Every command supports `--json`.** Agents parsing prose is the failure mode being removed.
- Documented, meaningful exit codes.
- A failed check reports "could not verify", never "nothing found".

Facade over Command adapters over importable, argv-free core logic.

Deprecating the shims is a separate, later decision, on a major version with a deprecation
window. Not proposed here.

## Gates

- Phase 0 → Phase 1: audit read. **Waived by Tim, 2026-08-24.**
- Phase 1 → Phase 2: design approved before any code moves. **Held.**

## Status — measured 2026-08-25

Every number below is re-measured in `docs/audit/final-measurements.md`; none are estimated.

**Root is 15 `.mjs`, down from 127. The requirement is met.** All 43 assertions of the fifteen
frozen contracts against their `web/` and `dashboard/` call sites still hold, and
`git log --follow` crosses the move on every file checked.

### What landed

- **Phase 2 steps 5 and 6.** 112 scripts moved (72 → `src/scripts/`, 20 → `src/lib/`,
  19 tests + the runner → `tests/`), every relative import repointed. Root files 189 → 51,
  root LOC 92,476 → 22,053.
- **ADR 0007, the directory half.** `test/`, `test-fixtures/` → `tests/`; `lib/`, `utils/`,
  `scripts/` → `src/`; the 16 translated READMEs → `docs/i18n/`; governance docs split between
  `docs/` and `.github/`; `evals/` → `tests/evals/`; `examples/` → `docs/examples/`;
  `fonts/` → `templates/fonts/`. Root directories 38 → 33 (visible 28 → 23).
  `lib/cli-flags.mjs` and `lib/local-today.mjs` remain as re-export shims because `web/`
  resolves them by literal path.
- **ADR 0001 step 5b, the updater fork.** `REMOVED_PATHS` (157 entries, both ADRs),
  `subtractRemovedPaths` inside `apply()`, a prune of the in-memory manifest after the re-exec
  returns, `career-ops system prune` (exit 3 for "could not verify"), and a doctor check that
  reads the manifest back out of the target's own source. `SYSTEM_PATHS` 197 → 152, with every
  remaining entry present on disk.
- **ADR 0004's URL path-casing decision.** `src/lib/url-key.mjs` now lowercases the hostname
  only; path case is preserved.
- **`src/core/text.js`**, the fourth core module.
- **`followup-cadence.mjs --json`** — accepted, and `tests/frozen-flag-surface.test.mjs` pins
  the flags every out-of-tree consumer actually sends, transcribed from the call sites. The
  home dashboard no longer renders "all caught up" when the cadence engine did not run.

### What did not land

- **ADR 0007's `workspace/` migration.** The 8 user-data directories (`data/`, `documents/`,
  `jds/`, `output/`, `reports/`, `interview-prep/`, `writing-samples/`, `seeds/`) are still at
  the root, and `src/core/store.js` has no `workspaceDir()` resolver. This is the whole gap
  between 23 visible root directories and the ADR's target of 14. It is the one move in that
  ADR with a behavioural fallback, and it touches where users keep their CV — it wants its own
  commit and its own test, not a tail-end of this one.
- **The `tests/` prune loop** (`update-system.mjs:1948`). It deletes every tracked file under
  `tests/` that is absent from `FETCH_HEAD`. That was near-harmless while `tests/` was
  upstream-owned; after the move it is 40+ fork-owned suites, so an `npm run update` would take
  them all. The code predates this branch but the move is what armed it. Fixing it changes
  prune semantics broadly and needs a decision, not a patch — it is the same class of hole as
  the one `REMOVED_PATHS` closed.
- **`BOOTSTRAP_PATHS`** was repointed at `src/` paths by the move and can now never resolve
  against any upstream ref. Harmless — the entries skip — but the fallback is dead weight.
- **The duplicate-symbol lint** ADR 0005 calls "the mechanism that makes it stay finished".
- **`src/core/table.js` adoption.** 37 files still split tracker rows on `|` by hand, down only
  3. The module exists and is tested; nothing was migrated onto it beyond the first three.
- **`src/lib/context-budget.test.mjs` runs nowhere** — outside the `tests/**` glob and
  unregistered in `tests/run-all.mjs`. Pre-existing: it was orphaned at `lib/` too.
- **`package.json` has no `test` script.** CI invokes the runner by path. Pre-existing.

## Final phase — writeup

Only after the refactor lands and survives a week of real use. Every number re-measured
against the final tree; no estimates. Fair to upstream, specifically: he declined the reorg
for a defensible reason, documented it publicly, and volunteers his own gaps. The disclaimer
about AI authorship goes in unsoftened — what we added was architectural judgement and the
willingness to delete, the constraints rather than the keystrokes.
