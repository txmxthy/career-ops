# ADR 0007 — Root directories: 38 → 14 visible

**Status:** accepted
**Date:** 2026-08-24

## Context

ADR 0001 takes root from 127 `.mjs` to 15. That is only part of the problem: root also holds
**38 directories** and **62 non-`.mjs` files**. A root you can read in one screen needs all
three fixed.

Measured composition:

- **8 near-empty user-data dirs** — `data/`(3 tracked), `documents/`(2), `jds/`(1), `output/`(1),
  `reports/`(1), `interview-prep/`(3), `writing-samples/`(1), `seeds/`(2). Scaffolding plus a
  `.gitkeep`, but written to at runtime and listed in `USER_PATHS` (`update-system.mjs:412`).
- **3 single-file dirs** — `utils/`, `scripts/`, plus `lib/`(9) which ADR 0002 absorbs.
- **3 test locations** — `tests/`(223), `test/`(12), `test-fixtures/`(21).
- **17 translated READMEs** at root (`README.ar.md` … `README.zh-TW.md`).
- **11 governance files** — `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`,
  `MAINTAINERS.md`, `SECURITY.md`, `SUPPORT.md`, `TRADEMARK.md`, `LEGAL_DISCLAIMER.md`,
  `MANIFESTO.md`, `SIGNATURES.md`, `CITATION.cff`.
- **7 per-CLI discovery dirs** — `.agents/`, `.antigravitycli/`, `.cursor/`, `.grok/`,
  `.kimi/`, `.opencode/`, `.qwen/`.

## Decision

| Move | To | Why it is safe |
|---|---|---|
| `test/`, `test-fixtures/` | `tests/` | Already the majority location. ADR 0005 step 6. |
| `lib/`, `utils/`, `scripts/` | `src/` | ADR 0002. `lib/cli-flags.mjs` and `lib/local-today.mjs` keep re-export shims — `web/` imports them. |
| 17 `README.<lang>.md` | `docs/i18n/` | Only `README.md` is rendered by GitHub. The rest are linked from it; update those links. |
| `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md` | `.github/` | These four are GitHub **community-health files**: GitHub resolves them from root, `.github/` or `docs/`, so the community-health UI keeps working. |
| `GOVERNANCE.md`, `MAINTAINERS.md`, `TRADEMARK.md`, `LEGAL_DISCLAIMER.md`, `MANIFESTO.md`, `SIGNATURES.md` | `docs/` | Not GitHub-special — ordinary docs with no resolution rules. Update inbound links. |
| `evals/` | `tests/evals/` | Test material. |
| `examples/` | `docs/examples/` | Documentation. |
| `fonts/` | `templates/fonts/` | Only consumed by CV rendering. |
| 8 user-data dirs | `workspace/` | See below — behind a compat shim. |

**`LICENSE` and `CITATION.cff` must stay at root** — unlike the community-health four, GitHub
reads the license banner and the "Cite this repository" widget from the root copy only.

**Stays at root, argued individually:** `README.md`, `LICENSE`, `CITATION.cff`, `VERSION`,
`package.json`, `Dockerfile`, `docker-compose.yml`, `flake.nix`/`flake.lock`, `cops`,
the dotfiles (`.gitignore`, `.editorconfig`, …), the 7 per-CLI discovery dirs (each CLI finds
its skills by that literal path — moving them breaks tool discovery), and the agent entrypoints
`AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `GEMINI.md`, `KIMI.md`, `OPENCODE.md` (discovered by name).

**Result: 14 visible root directories, down from 38** — `.github`, `config`, `dashboard`,
`docs`, `modes`, `plugins`, `plugins-registry`, `providers`, `scaffolder`, `src`, `templates`,
`tests`, `web`, `workspace`. Plus 7 dotdirs that do not appear in a plain `ls`.

## The user-data dirs need a compat shim, not a move

`data/`, `documents/`, `jds/`, `output/`, `reports/`, `interview-prep/`, `writing-samples/` and
`seeds/` are where the user puts their CV and job descriptions. **Moving them is a product
change, not a cleanup**, and existing installs have real files there.

So: `src/core/store.js` resolves each through a single `workspaceDir(name)` function that
prefers `workspace/<name>/` and **falls back to the legacy root path when it exists**. New
installs get the tidy layout; existing installs keep working untouched. `doctor.mjs` reports
when legacy dirs are in use and offers the migration. `USER_PATHS` gains the `workspace/`
entries while keeping the legacy ones, so the updater protects both.

This is the only entry here with a behavioural fallback, and it earns it: every other move is
invisible to users.

## Consequences

- One `store.js` function owns data-directory resolution — which is the ADR 0002 boundary doing
  its job rather than an exception to it.
- Upstream divergence widens beyond the `.mjs` moves. Already priced in ADR 0001.
- The 7 per-CLI dotdirs are the one irreducible piece of root sprawl. They are invisible in
  normal use, and each is load-bearing for a different CLI's discovery.
