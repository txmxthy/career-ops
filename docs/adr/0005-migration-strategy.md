# ADR 0005 — Migration strategy: finish the strangler fig upstream started

**Status:** accepted
**Date:** 2026-08-24

## Context

Upstream is already running this consolidation by hand. `portal-health-lock.mjs:35-37`,
`tracker-utils.mjs:22-24` and `followup-seed.mjs:68-70` each import `lockRecoveryVerdict`,
`RECOVER_STALE` and `OWNERLESS_GRACE_MS` from `pipeline-lock.mjs`. But `readLockOwner` was left
behind in all three (`:75`, `:244`, `:291`), and could not have been imported —
`pipeline-lock.mjs` exports 14 symbols and that is not one of them.

That is the evidence for the whole approach: **hand-migration does not converge.** A partial
strangler fig is worse than either endpoint, because the comments now describe an end state the
code has not reached. We are not fighting the design; we are finishing a migration and adding
the mechanism that makes it stay finished.

## Decision

Strangler fig, in this order. Each step shrinks the next.

| # | Step | Why here |
|---|---|---|
| 1 | `src/core/table.js` | Largest single win (27 files), lowest risk — parsing is pure. |
| 2 | `src/core/store.js` | **Blocked on ADR 0004's URL-casing decision.** Touches 92 sites. |
| 3 | `src/core/flags.js` | 84 sites, but trivial once 1 and 2 have proven the shim pattern. |
| 4 | Command modules + CLI facade | Needs 1–3 to exist. |
| 5 | Move 112 scripts into `src/`; hollow the 15 frozen ones into shims | Needs 4. Move with `git mv`, update every `modes/*.md` and `package.json` reference in the same commit. |
| 5b | Fork the updater: `REMOVED_PATHS`, `system prune`, `doctor` check | Must land with step 5 or the moved files come back. |
| 6 | Consolidate tests into one `tests/`, one convention | Last: the suite must stay green throughout, so moving it early would obscure regressions. |

## Rules

- **Characterisation tests before consolidating any duplicated function.** Capture current
  behaviour first, then refactor against it. Where implementations diverged, ADR 0004 names the
  winner and the test records the deliberate change.
- `"type": "module"` added to `package.json`. New files are `.js`. The 15 frozen root `.mjs`
  filenames stay (ADR 0001); the other 112 move into `src/` **with `git mv`**, so history
  follows them.
- One logical change per commit; conventional commits; green suite at every commit.
- Delete dead code aggressively — git has it. **Shims are not dead code.**
- Leave alone: the A–G rubric, `providers/` (87 `.mjs`, already well-factored), the `cops`
  launcher, translations.

## The mechanism that makes it stay finished

Hand-migration stalled because nothing failed when a symbol was left behind. Add a check that
fails CI when a function defined in `src/core/` is re-implemented at root: a duplicate-symbol
lint over root `.mjs` against the core module's export list. Without it this fork acquires the
same drift for the same reason.

## Rollback

Each step is a commit against a green suite. Rollback is `git revert` of one commit. No step
depends on a later step having landed, which is why the order above is not negotiable.
