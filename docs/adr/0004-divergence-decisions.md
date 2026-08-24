# ADR 0004 — Divergence decisions

**Status:** accepted, **with one item requiring a human decision before execution**
**Date:** 2026-08-24

## Context

`docs/audit/duplicate-functionality.md` records 28 `### DIVERGENCE` blocks. Consolidating
implementations that disagree is a behaviour change whether or not anyone decides it
deliberately. This ADR decides them in advance so no consolidating agent picks a winner at 3am.

Rule: where implementations diverge, the ADR picks the winner and a **characterisation test
records the deliberate change**. Where the audit found no divergence, consolidation is
mechanical and needs no entry here.

## BLOCKED — human decision required

### URL path casing

Two documented, contradictory contracts, each citing a real production incident:

- `scan.mjs:1039-1041` argues path casing is meaningless and lowercases the path at `:1067`.
- `web/src/lib/core/url-key.mjs:23-28` calls exactly that *"the over-normalization that
  collapsed two different Greenhouse postings"* into one key.

Both cannot be right, and the failure modes are asymmetric: lowercasing risks **merging two
distinct postings** (silent data loss); not lowercasing risks **duplicate rows for one posting**
(visible noise). The duplicate-row failure is recoverable by the user; the merge failure is not.

**Recommendation: preserve path case** (adopt the `web/` contract), on the grounds that a
recoverable failure beats a silent one. **Not adopted until Tim confirms** — this is the one
decision in the refactor that can lose data either way.

Do not begin consolidation step 2 (data access) until this is resolved. Nothing else blocks.

## Decided

| # | Divergence | Winner | Behaviour change accepted |
|---|---|---|---|
| 1 | Lock-owner read: `{inspected, owner}` vs bare `null` | `pipeline-lock.mjs:76` | The three bare-`null` copies (`portal-health-lock.mjs:75`, `tracker-utils.mjs:244`, `followup-seed.mjs:291`) start distinguishing "no stamp" from "unreadable stamp". Per the repo's own comments this stops an unreadable stamp condemning a live lock. Strictly a bug fix. |
| 2 | `sameLockDirectory` duplicated despite being exported | `pipeline-lock.mjs:105` | None — bodies are equivalent. Mechanical. |
| 3 | Company key: separator, script preservation, input type | `tracker-parse.mjs:434` `normalizeTextKey` | `company-funded.mjs:388` stops using `[^a-z0-9]+`, which deletes all non-Latin script — the exact bug `fingerprint-core.mjs:172-179` documents as #2500. Non-Latin company names stop collapsing to empty keys. Deliberate, and a fix. |
| 4 | Status normalization: alias source, Turkish fold, return type, date regex | `followup-cadence.mjs:139` | Callers using the other 6 gain `templates/states.yml` as the single alias source and Turkish-safe folding. Test each caller's expectations. |
| 5 | "Today": UTC day vs local day | `lib/local-today.mjs:28` | 12 root sites move from UTC to local day. **Changes date output near midnight.** Characterisation test must pin the timezone. |
| 6 | Flag parsing: `--`-prefixed values, `null` vs `undefined` | `lib/cli-flags.mjs:29` | `--flag --next` stops swallowing `--next` as a value. Any script relying on the old behaviour is buggy today. `weekly-digest.mjs:96` re-implements `flagValue` despite importing from the same module at `:45-47`; bodies equivalent, so its removal is mechanical. |
| 7 | Missing-file behaviour on tracker read (15 contracts) | see `store.js` contract below | Unified: **throw** on unreadable, **empty** on absent. Silent-default readers become explicit. This is the change most likely to surface latent bugs — expect fallout and treat it as signal. |
| 8 | Empty-key contract on URL key | `url-key.mjs:55` | Consistent empty-string return rather than mixed `null`/`''`/throw. |

## Not divergences — do not "fix"

- **JS↔Go mirrors.** Verified line by line: `tracker-utils.mjs:207` and `tracker_lock.go:99`
  derive the same 8 bytes; `canonicalPath` (`tracker_lock.go:68-77`) matches
  `canonicalizeTrackerPath` (`tracker-utils.mjs:168-175`). Managed duplication with parity
  tests. Keep the tests; keep the mirror.
- **PDF rendering.** 3 production implementations render different documents.
- **`web/src/lib/core/url-key.mjs:46`.** A sanctioned mirror, parity-tested at
  `web/tests/lib/url-key.test.mjs`.
