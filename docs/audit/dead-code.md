# DEAD CODE AUDIT — career-ops

## Method (and its limits)

Reachability was computed from four entrypoint classes, not from filenames:

1. **`package.json` scripts** — `package.json:9-69`, 59 entries. The file has **no `"type"`
   key at all** (verified).
2. **CI** — `.github/workflows/test.yml:45` (`node test-all.mjs --quick`), `:89-93`
   (`upgrade-tests.mjs --pr-gate/--canary/--local-paths`),
   `.github/workflows/plugin-registry-validate.yml:37,42` (`validate-plugin-registry.mjs`).
   **No other workflow runs any `.mjs`** (`rg -n "\.mjs" .github/workflows/*.yml` returns
   only those five lines plus comments).
3. **Shell-outs** — `modes/**/*.md`, `batch/batch-runner.sh`, `web/src/**` `spawn`/`execFile`
   calls, `cops`.
4. **Static imports / dynamic `import()`** across all 524 `.mjs`.

Two facts govern everything below:

- **Test discovery is scoped to `tests/` only.** `test-all.mjs:104-107`: *"Discovery is
  limited to tests/ so root-level standalone `*.test.mjs` files are never picked up."*
  Root and `test/` and `lib/` suites therefore run **only if hand-registered** in the
  `scripts` array at `test-all.mjs:287-357`.
- **`update-system.mjs`'s `SYSTEM_PATHS` is a shipping manifest, not an invocation.**
  `validate-system-paths-coverage.mjs:6-14` states its job is coverage of the updater layer
  split. It is enforced (`test-all.mjs:1677`), but it proves only that a file is *shipped* —
  never that anything *calls* it. Several files below are registered there and called by
  nothing.

**Not covered / uncertain:** references built from variables (`join(ROOT, someVar)`) would be
missed. I checked for this in `test-all.mjs`, `scan.mjs`, `plugins.mjs` and
`providers/_registry.mjs`. Provider adapters are loaded by directory scan — the production
vector is `providers/_registry.mjs`, imported at `scan.mjs:47`, whose loader
(`providers/_registry.mjs:27-34`) does `readdirSync` + `filter(f => f.endsWith('.mjs') &&
!f.startsWith('_'))`; `validate-portals.mjs:94` mirrors the same filter. So **no provider
adapter can be dead by this method** and none is listed. Confidence on completeness of the
root-level sweep: **high**. On `web/` (62 `.mjs`, its own `npm test` at
`.github/workflows/web-ci.yml:34`): **not audited in depth**.

**A note on the brief:** `cops` is a **bash script** (73 lines — passthrough at `cops:71`,
npm-script map at `cops:67`, tool passthrough at `cops:57`), not a Go binary. The original
task brief said Go; it is wrong.

---

## 1. Certainly dead

Evidence standard: an exhaustive whole-repo `rg -F` on the filename returns **no invocation
and no import** — only the file's own text, `update-system.mjs`'s `SYSTEM_PATHS`, and
`CHANGELOG.md`.

### 1.1 `jd-similarity.test.mjs` — 91 LOC — **certain**

The only one of the **nine** root `*.test.mjs` files not hand-registered in `test-all.mjs`.

- Registered at `test-all.mjs:320,348-354`: `invite-match`, `detect-reposts`, `discover-ats`,
  `followup-cadence`, `process-quality`, `company-history`, `contacts`, `reply-matcher` — 8 of 9.
- `rg -n "jd-similarity" test-all.mjs` → **zero hits**.
- Auto-discovery cannot reach it (`test-all.mjs:104-107`).
- It is not a Playwright spec (`playwright.cv.config.mjs:4-5`: `testDir: './test/cv-visual'`,
  `testMatch: '**/*.spec.mjs'`).
- It imports four real exports (`jd-similarity.test.mjs:1`: `hardMismatch,
  jaccardSimilarity, recommendCvReuse, tokenize`) and spawns the CLI
  (`jd-similarity.test.mjs:32,40`), so this is genuine coverage that has silently never run.
  Partial overlap only: `tests/jd-similarity-seniority.test.mjs` covers the seniority gate.

### 1.2 `test/profile-photo.test.mjs` — 103 LOC — **certain**
### 1.3 `test/zh-minimal-template.test.mjs` — 101 LOC — **certain**

`test/` holds five node test files. Three are explicitly invoked by `test-all.mjs`:
`test/cv-templates.test.mjs` (`test-all.mjs:15911`), `test/pipeline-lock.test.mjs`
(`:15929`), `test/cover-resolver.test.mjs` (`:15966`). These two are not.

- Whole-repo grep for `profile-photo` / `zh-minimal` outside the files themselves returns
  only: `update-system.mjs:351,353` (SYSTEM_PATHS), `CHANGELOG.md:477`,
  `config/profile.example.yml:137`, `docs/FAQ.md:65`,
  `tests/cv-optional-sections.test.mjs:74,88`, `tests/cv-section-order.test.mjs:669`
  — the last three referring to the *template*, not the test file.
- `test/` is not `tests/`, so auto-discovery skips it; the Playwright config only matches
  `test/cv-visual/**/*.spec.mjs`.

### 1.4 `lib/context-budget.test.mjs` — 345 LOC — **certain**

Whole-repo grep returns exactly two non-self hits: `update-system.mjs:163` (SYSTEM_PATHS) and
its own header `lib/context-budget.test.mjs:11` — *"Run: node lib/context-budget.test.mjs"*,
which documents a manual invocation nothing performs. `lib/` is outside `tests/`, so
discovery skips it. The module it tests, `lib/context-budget.mjs`, is live (8 referrers).

### 1.5 `lib/golden-budget-analysis.mjs` — 245 LOC — **certain**

Whole-repo grep returns `update-system.mjs:164` and its own header
`lib/golden-budget-analysis.mjs:15` (*"node lib/golden-budget-analysis.mjs"*). No import, no
npm script, no mode, no CI step. A standalone analysis tool shipped and never wired.

### 1.6 `batch-evaluate-gemini.mjs` — 403 LOC — **certain (as an entrypoint)**

Self-described replacement for the bash batch path (`batch-evaluate-gemini.mjs:4-5`:
*"Replaces the fragile bash array + CLI agent approach"*). It replaced nothing:

- `batch/batch-runner.sh` — the bash path it claims to replace — never calls it.
  `rg -n "\.mjs" batch/batch-runner.sh` shows only `reserve-report-num.mjs`,
  `merge-tracker.mjs`, `reconcile-pipeline.mjs`, `verify-pipeline.mjs`,
  `batch/aggregate-tokens.mjs` (`:682,696,1100,1103,1106,1147,1253`).
- Not in `package.json`, not in any `modes/**`, not in `README.md`, `AGENTS.md`,
  `docs/SCRIPTS.md`, not in any workflow.
- Its **only** live referrer is `tests/batch-evaluate.test.mjs:2` (154 LOC), which imports
  `processPipelineBatch, processOffer, PATHS`. That suite *does* run (it is under `tests/`).
- So: 403 LOC of Playwright + Gemini-SDK pipeline code, plus 154 LOC of tests, exercising an
  entrypoint no human or agent path reaches. **Dead as a program, live as a test fixture.**

### 1.7 `batch-tailor.mjs` — 140 LOC — **certain (as an entrypoint)**

Same shape, weaker excuse. A CLI with a full usage block
(`batch-tailor.mjs:18-26`, `node batch-tailor.mjs [--min-score N]`).

- Whole-repo grep for `batch-tailor.mjs` returns exactly four things:
  `CHANGELOG.md:402`, `update-system.mjs:282` (SYSTEM_PATHS), its own source, and
  `tests/batch-tailor-flags.test.mjs` (182 LOC).
- **Zero** hits in `docs/SCRIPTS.md`, `AGENTS.md`, `README.md`, `modes/**`, `package.json`,
  `batch/batch-runner.sh`, `.github/`.
- It spawns agent runs per matching job (`tests/batch-tailor-flags.test.mjs:4`), so it is a
  real workhorse — with no caller.

**Certainly-dead subtotal: 7 files, 1,428 LOC**, plus 336 LOC of tests
(`tests/batch-evaluate.test.mjs` 154, `tests/batch-tailor-flags.test.mjs` 182) that exist
solely to cover two unreachable entrypoints.

---

## 2. Probably dead

These are reachable *only* from `test-all.mjs`. They are exercised, so CI is green; but no
user, agent mode, npm script, or other script ever invokes them. The distinction that saves
some of them is documentation: a script listed in `docs/SCRIPTS.md` is a published CLI
surface even if nothing internal calls it.

### 2.1 `negotiation-roi.mjs` — 704 LOC — **probable**

- Invocation: `test-all.mjs:308` — `negotiation-roi.mjs --self-test`. That is all.
- `pj=0 modes=0 ci=0`; measured across the whole tree, its only other mentions are
  `AGENTS.md:130` (a one-row capability table) and `update-system.mjs:232`.
- **Absent from `docs/SCRIPTS.md`** (verified: `rg -c -F "negotiation-roi.mjs"
  docs/SCRIPTS.md` → 0), so it is not even a documented CLI. `modes/offer-prep.md` — the mode
  where a salary-negotiation generator belongs — shells out to nothing at all.
- It does import a live module (`negotiation-roi.mjs:64`, `parseStories` from
  `match-star.mjs`), so it is a consumer, never a dependency.
- **Why "probable" not "certain":** a user could run `node negotiation-roi.mjs` by hand from
  the AGENTS.md table. Nothing in the repo teaches them to.
- Largest single dead-ish artefact in the audit: 704 LOC behind one `--self-test` call.

### 2.2 `fix-slugs.mjs` — 378 LOC — **probable, but documented**

- Invocation: `test-all.mjs:5529-5841` (a whole `10c. SLUG AUTO-FIXER` section, ~15
  assertions) and `tests/cli-flag-validation.test.mjs:35-116` (~14 assertions). Nothing else.
- `pj=0 modes=0 ci=0`, no importer.
- **But** `docs/SCRIPTS.md:44,191,198-202` documents it as a first-class CLI with four
  invocation forms. It is a published surface with an unusually thorough test suite and no
  internal caller — deliberate, not rotted. **Not a deletion candidate; a wiring gap.**

### 2.3 `assessment-log.mjs` — 333 LOC — **probable, but documented**

- Invocation: `test-all.mjs:311` (`--self-test`) and `:494-539` (CLI-contract block).
- `pj=0 modes=0 ci=0`, no importer.
- Documented at `docs/SCRIPTS.md:359-362`, `AGENTS.md:131`, and named as the *only* writer of
  `data/assessments.tsv` in `DATA_CONTRACT.md:48`. Same verdict as `fix-slugs.mjs`: a
  documented user CLI that no mode ever reaches for, which means the agent-facing half of the
  product cannot log an assessment.

### 2.4 The three root test-naming conventions — **probable duplication of process**

Root carries **21 non-production `.mjs`** (out of 127). **20 of them are test-ish**, split
across three naming conventions:

- **`*.test.mjs` — 9**: `company-history`, `contacts`, `detect-reposts`, `discover-ats`,
  `followup-cadence`, `invite-match`, `jd-similarity`, `process-quality`, `reply-matcher`.
- **`*-tests.mjs` — 8**: `agent-inbox-tests`, `followup-seed-tests`, `paste-reply-tests`,
  `set-status-tests`, `tracker-columns-tests`, `tracker-writer-lock-tests`,
  `updater-migration-tests`, `upgrade-tests`.
- **`test-*.mjs` — 3**: `test-all.mjs` (the runner itself), `test-salary-filter.mjs`,
  `test-trust-validator.mjs`.

The 21st non-production file is `playwright.cv.config.mjs`. Excluding the runner, all **19
suites** are hand-registered at `test-all.mjs:320-354`, each with its own comment explaining
why it is in the list — including `test-all.mjs:344-345`: *"Root-level standalone suites
shipped in SYSTEM_PATHS but previously never executed by CI (issue #1624)"*, which is exactly
the failure mode §1.1–1.5 above are recurrences of. **`ARCHITECTURE.md:26-28`'s stated
convention — "`*.test.mjs` sits next to what it tests" — is followed by 9 root files and
violated by 10.** Moving all 19 into `tests/` would make them auto-discovered and would have
prevented every finding in §1.1–1.5.

**Probably-dead subtotal: 3 files, 1,415 LOC**, of which 711 LOC (`fix-slugs`,
`assessment-log`) are documented CLIs that should be *wired*, not deleted.

---

## 3. Ambiguous

### 3.1 `manifesto.mjs` — 36 LOC — **ambiguous, lean alive**

`package.json:68` → `"manifesto": "node manifesto.mjs"`. Reachable by definition. Flagged only
because that is its sole referrer in 1,178 tracked files: no mode, no doc, no test, no import.
36 LOC.

### 3.2 `seed-fixture.mjs` — 125 LOC — **alive, CI-only**

`upgrade-tests.mjs:26` imports `seedFixture, loadExpectations`; `upgrade-tests.mjs` is run by
`.github/workflows/test.yml:89-93`. Listed here only because its `pj=0 modes=0` profile makes
it look dead on a naive scan. **It is not dead.**

### 3.3 `validate-untrusted-content-coverage.mjs` — 267 LOC — **alive, CI-only**

Single referrer: `test-all.mjs:1692` (`spawnSync`). No npm script, no docs. Same category as
`validate-system-paths-coverage.mjs` (`test-all.mjs:1655-1677`) — a CI guard whose only
consumer is the suite. Correct design; noted so a dedupe pass does not mistake it for rot.

### 3.4 `plugin-audit.mjs` — 124 LOC — **alive**

`plugin-install.mjs:19` imports `auditPlugin`; `validate-plugin-registry.mjs:53` imports
`auditRegistryEntry` from `plugin-install.mjs`; that runs in CI at
`.github/workflows/plugin-registry-validate.yml:37,42`. Documented at `docs/SCRIPTS.md:957`.

### 3.5 The 55 root scripts absent from `docs/SCRIPTS.md`

`docs/SCRIPTS.md` is described in the recon brief as the de-facto public catalogue. Measured:
**55 of 127 root `.mjs` are absent from it**. Most are legitimately internal (20 test-ish
files plus `playwright.cv.config.mjs`, and library modules like `theme-style.mjs`,
`url-key.mjs`, `user-agent.mjs`). The ones that matter are the *user-facing CLIs* missing from
it: `batch-tailor.mjs`, `batch-evaluate-gemini.mjs`, `negotiation-roi.mjs`, `intake.mjs`,
`outcome.mjs`, `scan-hn.mjs`, `scan-interamt.mjs`, `manifesto.mjs`, `eval-golden.mjs`.
Absence from the catalogue is a strong (not conclusive) death signal — it is what separates
§1.6/§1.7 from §2.2/§2.3.

### 3.6 Anti-findings — scripts that look dead and are not

Recorded so a later pass does not re-litigate them:

| File | Looks dead because | Actually reached by |
|---|---|---|
| `mark-pdf-ready.mjs` | `pj=0 modes=0 ci=0`, no root importer | spawned by the web app: `web/src/lib/pdf-render.mjs:122` |
| `sync-pdf-flags.mjs` | `pj=0 modes=0 ci=0`, no importer | `merge-tracker.mjs:1370` `execFileSync` |
| `classify-tier.mjs` | no npm/mode | `scan.mjs:2391` dynamic `import()` |
| `jd-capture.mjs` | no npm/mode/SCRIPTS.md | `outcome.mjs:34`, `archive-posting.mjs:30` |
| `jsonc-parse.mjs` | no npm/mode/docs | `doctor.mjs:16` |
| `tracker-sync-check.mjs` | `pj=0 modes=0` | `verify-pipeline.mjs:30` |
| `portal-health-lock.mjs` | no npm/mode | `scan.mjs:57` |
| `fingerprint-core.mjs` | no npm/mode/docs | `scan.mjs:50` |
| `profile-language.mjs` | no npm/mode/docs | all four eval CLIs (`gemini-eval.mjs:42`, `openai-eval.mjs:33`, `ollama-eval.mjs:28`, `openrouter-runner.mjs:26`) |
| the 78 provider adapters in `providers/` | 25 have a single non-self reference | directory-scanned at `providers/_registry.mjs:27-34`, reached in production via `scan.mjs:47` |
| the 9 `providers/_*.mjs` internals | excluded by the `!f.startsWith('_')` filter (`providers/_registry.mjs:28`, `validate-portals.mjs:94`) | imported directly by the adapters and by `scan.mjs` |

`providers/` holds **89 entries — 87 `.mjs`** plus `_types.js` and `README.md`. Ten entries
are underscore-prefixed internals (`_config-utils`, `_dns-cache`, `_html-entities`,
`_html-to-text`, `_http`, `_ip-guard`, `_profile-keywords`, `_registry`, `_trust-validator`,
`_types.js`); the remaining **78** are the adapters the registry scan loads.

---

## 4. Duplicates-in-waiting (reachable, but near-identical twins)

Measured by Jaccard similarity over normalised source lines (trimmed, >25 chars, comment
lines dropped), whole-repo, all 524 `.mjs`. Only pairs above J=0.25 or ≥60% coverage of the
smaller file are reported.

| J | shared lines | pair |
|---|---|---|
| **0.486** | 118 | `ollama-eval.mjs` (410 LOC) ~ `openai-eval.mjs` (440 LOC) |
| 0.406 | 28 | `providers/nodesk.mjs` ~ `providers/weworkremotely.mjs` |
| 0.385 | 25 | `providers/larajobs.mjs` ~ `providers/nodesk.mjs` |
| 0.348 | 23 | `providers/larajobs.mjs` ~ `providers/weworkremotely.mjs` |
| 0.338 | 24 | `providers/higheredjobs.mjs` ~ `providers/weworkremotely.mjs` |
| 0.333 | 22 | `providers/higheredjobs.mjs` ~ `providers/larajobs.mjs` |
| 0.324 | 23 | `providers/larajobs.mjs` ~ `providers/teamtailor.mjs` |
| 0.315 | 23 | `providers/higheredjobs.mjs` ~ `providers/nodesk.mjs` |
| **0.303** | 89 | `gemini-eval.mjs` (474) ~ `ollama-eval.mjs` (410) |
| **0.302** | 91 | `gemini-eval.mjs` (474) ~ `openai-eval.mjs` (440) |
| 0.276 | 16 | `providers/arbeitnow.mjs` ~ `providers/getonbrd.mjs` |
| 0.259 | 21 | `providers/nodesk.mjs` ~ `providers/teamtailor.mjs` |
| 0.257 | 18 | `providers/jobspresso.mjs` ~ `providers/weworkremotely.mjs` |
| 0.254 | 18 | `providers/jobspresso.mjs` ~ `providers/nodesk.mjs` |
| 0.208 | 55 | `openai-eval.mjs` ~ `openai-tailor.mjs` (349) |
| 0.199 (cov 0.55) | 29 | `pipeline-lock.mjs` (642) ~ `portal-health-lock.mjs` (247) |
| 0.177 (cov 0.56) | 37 | `mark-pdf-ready.mjs` (192) ~ `set-status.mjs` (590) |

**The eval quadruplet is the single biggest consolidation target.**
`gemini-eval.mjs` + `openai-eval.mjs` + `ollama-eval.mjs` + `openai-tailor.mjs` = **1,673
LOC** with 118 lines literally shared between two of them and ~90 shared across each other
pair. They already share three extracted helpers — `profile-language.mjs`
(`gemini-eval.mjs:42`, `openai-eval.mjs:33`, `ollama-eval.mjs:28`), `utils/token-tracker.mjs`
(`gemini-eval.mjs:36`, `openai-eval.mjs:37`, `openrouter-runner.mjs:30`), and
`user-agent.mjs` — so the extraction pattern is established and half-applied. The remaining
118 duplicated lines between `ollama` and `openai` are prompt assembly, JD/report I/O and
output shaping, none of which is provider-specific.

**Two already-managed twins** (flagged so they are not "fixed" by accident):

- `url-key.mjs` (95 LOC) ~ `web/src/lib/core/url-key.mjs` (79 LOC) — a *deliberate,
  sanctioned* mirror with a parity test that imports both sides simultaneously:
  `web/tests/lib/url-key.test.mjs:1-15` (*"Imports the core and the web copy side-by-side so
  they can never drift, same pattern as normalize-text-key.test.mjs (#2369/#2666)"*). The web
  copy's `normalizeUrl` is at `web/src/lib/core/url-key.mjs:46`.
- `providers/_profile-keywords.mjs` (67) ~ `web/src/lib/profile-keywords.mjs` (47) ~
  `profile-language.mjs` (35) — three readers of `config/profile.yml` role fields, only the
  web copy carrying shape tests (`web/tests/lib/profile-keywords.test.mjs:4-9`, which
  documents that the inline predecessor *"read both fields with the wrong shape and returned
  []"*). No parity test binds these three. This is the drift the `url-key` pattern exists to
  prevent, un-applied.

**The `providers/` cluster** (8 pairs above J=0.25 among `nodesk`, `weworkremotely`,
`larajobs`, `higheredjobs`, `teamtailor`, `jobspresso`, `arbeitnow`, `getonbrd`) is small in
absolute terms — 16–28 shared lines per pair on 35–53-line files — but it means roughly a
third of each of those adapters is boilerplate. `providers/_http.mjs`,
`providers/_html-to-text.mjs` and `providers/_html-entities.mjs` already exist as the shared
layer; these eight simply predate or bypass it.

---

## 5. Headline numbers

| Measure | Value |
|---|---|
| `.mjs` in repo | 524 (127 root, 214 `tests/`, 87 `providers/`, 62 `web/`, 12 `plugins/`, 9 `lib/`, 7 `test/`, 6 other) |
| Total `.mjs` LOC | **150,039** (measured) |
| Root `.mjs` LOC | **79,966** — 53% of all `.mjs` sits in the flat root |
| **Certainly dead** | **7 files, 1,428 LOC** (+336 LOC of tests covering two of them) |
| **Probably dead** | **3 files, 1,415 LOC** (711 of which are documented CLIs → wire, don't delete) |
| Test suites shipped but never executed | **5** (`jd-similarity.test.mjs`, `test/profile-photo.test.mjs`, `test/zh-minimal-template.test.mjs`, `lib/context-budget.test.mjs`, and `lib/golden-budget-analysis.mjs` as a runner) — **885 LOC** |
| Root `.mjs` that are not production code | **21 of 127** (16.5%) — 20 test-ish + `playwright.cv.config.mjs` |
| Root test-ish naming conventions | **3** — `*.test.mjs` (9), `*-tests.mjs` (8), `test-*.mjs` (3) |
| Root `.mjs` absent from `docs/SCRIPTS.md` | 55 of 127 |
| Near-duplicate pairs above J=0.25 | 14 |
| Largest consolidation target | eval quadruplet, **1,673 LOC**, J=0.49 on its closest pair |
| Dead provider adapters | **0** of 78 — `providers/_registry.mjs:27-34` directory-scans |
| `package.json` scripts | 59 (`package.json:9-69`); no `"type"` key |

---

## 6. What contradicts the stated contract

1. **`ARCHITECTURE.md:26-28` claims "every script is registered in `SYSTEM_PATHS` (enforced in
   CI by the coverage guard)"** and presents that as the completeness invariant. It holds —
   and it is the wrong invariant. All seven certainly-dead files *are* registered
   (`update-system.mjs:163,164,282,203,351,353` + the root `.test.mjs` block). The guard
   proves a file ships; nothing proves a file runs. The repo has a **shipping-coverage guard
   and no invocation-coverage guard**, which is precisely how five suites came to be shipped
   and never executed — twice, since `test-all.mjs:344-345` records issue #1624 as the same
   bug already fixed once by hand-registering nine files. The manifest itself holds **135
   quoted `*.mjs` literals** — well short of the 524 `.mjs` in the tree, so "every script" is
   already an overstatement of what it covers.

2. **`ARCHITECTURE.md:26` says "~70 scripts at the root". There are 127** (verified baseline),
   and 21 of them are test infrastructure. The doctrine defending the flat root is arguing
   about a repo 45% smaller than the one that exists.

3. **`ARCHITECTURE.md:26-28` states the convention "`*.test.mjs` sits next to what it tests".**
   Nine root files follow it; ten (`*-tests.mjs`, `test-*`) do not; 214 more live in `tests/`,
   away from what they test. And following the stated convention is what makes a suite
   invisible to auto-discovery (`test-all.mjs:104-107`) — **the documented convention is the
   direct cause of §1.1.**

4. **`AGENTS.md:363` claims CI runs "the full `test-all.mjs` suite".** `.github/workflows/test.yml:45`
   runs `node test-all.mjs --quick`. The only thing `--quick` gates is the dashboard Go build
   (`test-all.mjs:1525`), so the gap is small — but the claim as written is false.

5. **`package.json` has no `test` script** (verified against `package.json:9-69`, 59 entries).
   CI invokes `node test-all.mjs --quick` directly. A contributor running `npm test` gets
   npm's error. `cops:67` carries its own npm-script map, so the `cops` path works where
   `npm test` does not.
