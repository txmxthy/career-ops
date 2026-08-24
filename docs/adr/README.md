# ADRs — career-ops fork

Design for the consolidation. Evidence is in [`../audit/`](../audit/); read that first.

| ADR | Decision |
|---|---|
|  [0001](0001-root-goes-to-fifteen.md) | **Root goes 127 → 15.** The 112 unpinned scripts move to `src/`; the 15 with real external consumers stay as 3-line shims. `update-system.mjs` is forked (`REMOVED_PATHS` + a prune command + a `doctor` check) because it otherwise resurrects every moved file. |
| [0002](0002-module-boundaries.md) | **Four** core modules (`table`, `store`, `flags`, `text`), not twelve. Each justified by a measured consumer count. |
| [0003](0003-command-taxonomy.md) | `career-ops <noun> <verb>`, ten nouns. All 127 root scripts classified: 85 commands, 22 library modules, 20 tests. No gaps. |
| [0004](0004-divergence-decisions.md) | 8 divergences decided in advance. **One blocked on a human decision** — URL path casing. |
| [0005](0005-migration-strategy.md) | Strangler fig in a fixed order, finishing the migration upstream started and stalled. Plus the CI check that stops it stalling again. |
| [0007](0007-root-directories.md) | **Root dirs 38 → 14 visible.** Tests, `lib`/`utils`/`scripts`, translated READMEs and governance files relocate. The 8 user-data dirs move to `workspace/` behind a legacy-path fallback, since moving them outright is a product change. |
| [0006](0006-cli-contract.md) | `--json` everywhere; exit code 3 means "could not verify" and is distinct from 1, "ran and failed". |

## Blocked before execution

**ADR 0004 — URL path casing.** `scan.mjs:1039-1041` lowercases the path;
`web/src/lib/core/url-key.mjs:23-28` calls that the over-normalisation that merged two distinct
Greenhouse postings. Both cite real incidents. Recommendation is to preserve case (a
recoverable failure beats a silent one), pending Tim's confirmation. Step 2 of the migration
cannot start until this is settled; step 1 can.
