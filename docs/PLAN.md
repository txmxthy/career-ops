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
5. Hollow root scripts into shims, one per commit — **not started**
6. Consolidate 3 test locations and 3 naming conventions into one `tests/` — **not started**

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

**Root is 127 `.mjs`, unchanged. The target is 15, and that is the requirement.** Zero `git mv`
on the branch; the 15 frozen scripts are still full implementations rather than shims. Steps 1
to 4 landed — three core modules with 172 characterisation tests, and the `career-ops` facade
with 350. Steps 5 and 6 did not start.

Also outstanding:

- **ADR 0001 step 5b, the updater fork** — no `REMOVED_PATHS`, no `system prune`, no doctor
  resurrection check. Blocking: nothing may move before it exists, or the next
  `npm run update` restores every moved file alongside its replacement.
- **ADR 0004's URL path-casing decision** — resolved as *preserve path case*, not implemented.
  `scan.mjs:1068` and `src/scripts/discover-ats.mjs:403` still lowercase.
  `tests/discover-ats-url-dedup-casing.test.mjs` pins the current behaviour and fails loudly
  when it is flipped; `web/tests/lib/url-key.test.mjs` must move with it.
- **The duplicate-symbol lint** ADR 0005 calls "the mechanism that makes it stay finished" —
  not written. 84 root scripts still hand-parse `process.argv` beside a shared flags module,
  which is the same drift the fork exists to stop.
- **`followup-cadence.mjs --json` is rejected** (`:939` `KNOWN_FLAGS` omits it) while both web
  routes send it. The web swallows the error and renders "no follow-ups due" — a live instance
  of the "nothing found" vs "could not verify" collapse ADR 0006 forbids. Pre-existing, not
  from this branch; needs a characterisation test with its fix.

## Final phase — writeup

Only after the refactor lands and survives a week of real use. Every number re-measured
against the final tree; no estimates. Fair to upstream, specifically: he declined the reorg
for a defensible reason, documented it publicly, and volunteers his own gaps. The disclaimer
about AI authorship goes in unsoftened — what we added was architectural judgement and the
willingness to delete, the constraints rather than the keystrokes.
