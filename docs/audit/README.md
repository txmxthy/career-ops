# Phase 0 audit — career-ops fork

Evidence for the consolidation. No code changes here. Read
[`duplicate-functionality.md`](duplicate-functionality.md) first; it is the deliverable the
rest support.

## Verified baseline

Re-measured in this checkout at `1579f3a`, not taken on trust.

| Metric | Value |
|---|---|
| Tracked files | 1,178 |
| `.mjs` files | 524 |
| `.mjs` at repo root | 127 |
| `.mjs` in `lib/` | 9 |
| Root-level LOC | 79,966 (of 150,039 total `.mjs`) |
| Root scripts calling `readFileSync` | 92 |
| Root scripts hand-parsing `process.argv` | 84 |
| Root files splitting on `\|` to read a table row | 27 (37 repo-wide, 81 call sites, 11 distinct algorithms) |
| Root scripts importing from `lib/` | 39 (across all 7 lib modules) |
| Test locations | 3 (root, `test/`, `tests/`) |
| Root test files | **20**, across **3** naming conventions — `*.test.mjs` (9), `*-tests.mjs` (8), `test-*.mjs` (3) |
| `package.json` scripts | 59 |
| `"type": "module"` | **absent** — no `type` key at all |
| Largest root file | `test-all.mjs`, 17,101 lines |

Two corrections to the brief: root test files are 20, not 17; and `cops` is a 73-line **bash**
launcher, not Go.

## The deliverables

| Document | Concludes |
|---|---|
| [`duplicate-functionality.md`](duplicate-functionality.md) | 20+ capabilities implemented more than once, with 28 flagged divergences. Site counts justify the work; algorithm counts are the risk. |
| [`dead-code.md`](dead-code.md) | Import-graph dead-code analysis is nearly vacuous here — almost nothing imports anything. Reachability is by shell-out name, and `test-all.mjs` plus `update-system.mjs`'s 135-entry filename manifest reference nearly every root script. |
| [`public-surface.md`](public-surface.md) | The frozen list, derived from real references. `package.json` script *names* are the contract, not the paths they invoke — so all 59 can be repointed. |
| [`dependency-graph.md`](dependency-graph.md) | Real import edges plus implicit ones (shared data files, shared formats, shell-outs). Overview first, then per-component. |
| [`tech-debt.md`](tech-debt.md) | Everything else, severity-ranked: three test layouts, the 17k-line `test-all.mjs`, missing `"type": "module"`, swallowed errors, sync I/O, injection surface. |

## The five things that most surprised us

1. **Upstream is already running this consolidation by hand, and it stalled mid-migration.**
   `portal-health-lock.mjs:35-37`, `tracker-utils.mjs:22-24` and `followup-seed.mjs:68-70` each
   import `lockRecoveryVerdict`, `RECOVER_STALE` and `OWNERLESS_GRACE_MS` from
   `pipeline-lock.mjs` — but `readLockOwner` was left behind in all three (`:75`, `:244`,
   `:291`), still returning bare `null` where the canonical copy (`pipeline-lock.mjs:76`)
   returns `{inspected, owner}`. It could not have been imported: `pipeline-lock.mjs` exports
   14 symbols and that is not one of them. `sameLockDirectory` is likewise still duplicated in
   two files despite being exported at `pipeline-lock.mjs:105`.
   Per the repo's own comments, the consequence is that an unreadable owner stamp falls through
   to the age rule and can condemn a live lock. **Hand-migration does not converge; the
   leftovers are the proof.**

2. **Two documented, contradictory URL-normalisation contracts, each citing a real incident.**
   `scan.mjs:1039-1041` argues path casing is meaningless and lowercases at `:1067`.
   `web/src/lib/core/url-key.mjs:23-28` calls precisely that "the over-normalization that
   collapsed two different Greenhouse postings" into one key. This cannot be resolved by an
   agent. **Human decision required.**

3. **A banned pattern survived in one place.** `company-funded.mjs:388` uses `[^a-z0-9]+`,
   which deletes all non-Latin script — the exact bug `fingerprint-core.mjs:172-179` documents
   as #2500 and `tracker-parse.mjs:449-463` structurally guards against.

4. **Self-documented duplication.** `weekly-digest.mjs:45-47` imports `validateFlags` from
   `lib/cli-flags.mjs`, then re-implements `flagValue` at `:96` anyway, with a comment saying
   it does so deliberately. The bodies are equivalent.

5. **Not all duplication is drift.** The Go dashboard mirrors three JS capabilities
   (`tracker_lock.go:87`, `career.go:595`, `career.go:937`). We verified the lock derivation
   line by line and found **no divergence**; two of the three are parity-tested. Go cannot
   import `.mjs`, so the correct action is to keep the parity tests, not remove the mirror.
   Listed so a future audit does not "discover" it as unmanaged drift.

## What we could NOT verify

Stated as failures, not as absence of findings.

- **A systematic citation check was never completed.** Two attempts were sandboxed read-only
  and returned `checked: 0`. That is "nothing was checked", **not** "the citations are clean".
  Spot-checks by the lead confirmed the lock-module findings (§1 above) and the 27/11 table
  parser counts by hand; the remainder carry their authoring agent's confidence only.
- **`computeFunnel` and `detectColumns` JS↔Go parity** — the Go comments assert it and the
  parity tests exist (`career_test.go:357,366`, `progress_metrics_test.go:28`), but the bodies
  were not diffed. Confidence: medium.
- **`invite-match.mjs:132`** behaviour was not read directly.
- **Disk persistence of the 5 eval-runner `today()` sites** was not established.
- **Whether `.npmignore` under `private: true` is vestigial** — confidence low on intent.

## Provenance

Produced by a multi-agent run. The first two attempts lost their output to plan-mode
sandboxing; the content was recovered from staged agent files rather than re-derived, so
authoring confidence is inherited from those runs except where the lead re-verified by hand
(marked inline). Citation coverage is **partial** — see above.
