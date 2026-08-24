# Tech-debt audit — career-ops

Repo: `/Users/tim/Documents/Personal/workspaces/career-ops/dedupe-core/career-ops`
Method: read the code. Every claim cites `path:line`. Confidence stated where measurement was partial.

---

## Severity ranking

| # | Finding | Severity | Confidence |
|---|---|---|---|
| 1 | `update-system.mjs apply` reports success after `npm install` / Playwright install failed | **High** | High |
| 2 | `engines: node >=18` is false — `fs.globSync` needs Node ≥22; CI only ever tests Node 24 | **High** | High |
| 3 | `reply-watch.mjs` swallows the tracker DB sync failure with `stdio:'ignore'` + empty catch | Medium-High | High |
| 4 | `test-all.mjs` — 17,101 lines, flat top-level script, duplicated section numbering | Medium | High |
| 5 | `plugins/_registry.mjs` fails open on a malformed registry entry (trust root) | Medium | High |
| 6 | `warn()` in `test-all.mjs` exits 0 — 14 checks are non-gating | Medium | High |
| 7 | `scripts/check-syntax.mjs` spawns one process per `.mjs` file, serially | Low-Medium | High |
| 8 | Sync file reads inside per-item loops across the report/tracker scripts | Low | High |
| 9 | Injection surface (Playwright / execSync) | **Low — refuted as a risk** | High |
| 10 | `package.json` missing `"type": "module"` | **Low — refuted as breakage** | High |
| 11 | Duplicate `ARCHITECTURE.md` | **Refuted — not a duplicate** | High |
| 12 | `plugins/` vs `plugins-registry/` | **Refuted — not duplication** | High |

---

## 1. `update-system.mjs apply` reports success after dependency install failed — HIGH

This is the "silenced stderr, reported success" pattern, and it is in the updater, not the watcher.

```
update-system.mjs:1965-1969   try { execSync('npm install --silent', …) }
                              catch { console.log('npm install skipped (may need manual run)'); }
update-system.mjs:1972-1976   try { execSync('npx playwright install chromium', { …, stdio: 'ignore' }) }
                              catch { console.log('playwright install skipped (run manually: …)'); }
update-system.mjs:1255-1265   try { execFileSync('go', ['build', …], { stdio: 'pipe' }) }
                              catch { console.log('dashboard binary rebuild skipped -- run: …'); }
```

Three failure modes, three identical shapes: the child's stderr is discarded (`stdio:'ignore'` at
`:1973`, `stdio:'pipe'` never read at `:1259`, `--silent` at `:1966`), the exception is caught, and
the message says **"skipped"** — the word for *we chose not to do this*, not *this failed*.
Control then falls through to step 7, which commits the update (`update-system.mjs:1979-1984`), and
the process exits 0.

What actually breaks: a user runs `npm run update`, the version bumps, the commit lands, and the
node_modules tree is stale or the chromium binary is absent. The next `npm run pdf` fails inside
Playwright with an unrelated-looking error, at a point far from the update. There is no record of
the real cause — the install stderr is gone.

Fix shape: keep the update non-fatal, but distinguish *skipped* from *failed*, capture stderr into
the message, and set a non-zero exit or a summary line at the end listing degraded steps.

## 2. `engines: node >=18` is false — HIGH

`package.json:6-8` declares `"node": ">=18"`.

`validate-untrusted-content-coverage.mjs:27` imports `globSync` from `'fs'` and calls it at
`:244-245`. `fs.globSync` landed in Node 22 — this script throws `TypeError: globSync is not a
function` on Node 18 and 20. It is the CI gate for the untrusted-content directive
(`validate-untrusted-content-coverage.mjs:222-266`), so on a supported-per-`engines` Node it does
not merely fail, it cannot run at all.

Why nobody noticed: `.github/workflows/test.yml:29-33` is labelled
`name: Set up Node 18 for syntax compatibility` but sets `node-version: '24'`. The step directly
below it (`:35-38`) sets up Node 24 again. The Node-18 leg of the matrix does not exist; the comment
is the only trace of the intent. So `npm run lint` (`scripts/check-syntax.mjs`, `node --check`) has
never validated the declared floor.

Confidence on the `fs.globSync` version: high. Confidence that this is the *only* ≥20 API in the
tree: medium — I grepped for `structuredClone`, `toSorted`, `toReversed`, `Object.groupBy`,
`findLast`, `fs.glob` and found none outside `web/` and `tests/`, but a runtime-only feature
(e.g. a `node:` builtin flag) would be missed by that grep.

## 3. `reply-watch.mjs` — the watcher that silences stderr — MEDIUM-HIGH

```
reply-watch.mjs:328-334
  try {
    const { execSync } = await import('child_process');
    execSync('node tracker.mjs sync', { stdio: 'ignore' });
    console.log('Synced database index (applications.db).');
  } catch (e) {
    // ignore
  }
```

Be precise about what does and does not go wrong here: the success message is *inside* the `try`,
after the call, so a failure does **not** print a false "Synced". What it prints is **nothing** —
and the line above it, `reply-watch.mjs:324`, has already printed `✅ Tracker review complete`.
The tracker markdown was mutated; the derived SQLite index was not; the user sees a green tick and
exit 0 (`main()` only exits 1 on an uncaught throw, `reply-watch.mjs:340-343`).

`stdio:'ignore'` means the reason is unrecoverable — no stderr is captured anywhere.

What actually breaks: `data/applications.md` and `applications.db` diverge silently. Anything
reading the DB (the Go dashboard, `find.mjs`) shows stale statuses, and the divergence has no
timestamp or log to bisect from.

## 4. `test-all.mjs` — 17,101 lines — MEDIUM

Structure (verified by reading, not inferred):

- Not a framework. A flat, top-level, **sequentially executed** ESM script. Assertions are bare
  calls to `pass()` / `fail()` / `warn()` imported from `tests/helpers.mjs`
  (`test-all.mjs:58`). Counts: **1,124** `pass(` call sites, **1,325** `fail(` call sites,
  **14** `warn(`.
- Sections are `console.log` banners at top level, ~120 of them. Numbering has broken down under
  append-only growth: `11.` appears at `:5849` (*AGENTS.md integrity*) **and** `:5868`
  (*CLI wrapper file integrity*); `12.` appears at `:5944`, `:6518`, and `:8952`; `14.` at `:6501`
  precedes `13.` at `:6664`; and from `:9055` onward the banners abandon numbering entirely for
  `🧪 Testing …` strings. There is no index and no way to run one section.
- Real phases: syntax fan-out (`:223-277`), script smoke execution (`:278`), liveness (`:652`),
  dashboard build — **skipped under `--quick`** (`:1525-1560`), data contract (`:1565`), secret-leak
  scan (`:1831`), absolute-path scan (`:1890`), then ~14,000 lines of feature assertions.
- It also **discovers and re-runs** `tests/*.test.mjs` as child processes
  (`test-all.mjs:107-207`, `discoverTests` / `runDiscovered`), which is why there are 214 `.mjs`
  under `tests/` and a 17k-line file that still calls itself the suite.

**Correction to the brief:** `AGENTS.md:363`'s claim that CI runs the full suite is nearly true.
CI runs `node test-all.mjs --quick` (`.github/workflows/test.yml:45`), and `--quick` skips exactly
one thing — the Go dashboard build (`test-all.mjs:1525`, `:1560`) — which `test.yml:46-48` covers
separately with `go test ./...`. Do not report `--quick` as a coverage gap; it is not one.

## 5. `plugins/_registry.mjs` fails open on a malformed trust-root entry — MEDIUM

`plugins-registry/` is the security boundary: each JSON file pins an external plugin repo to a
reviewed commit (`plugins-registry/tavily.json` — `sha`, `allowedHosts`, `requiredEnv`), and
`_registry.mjs:70-79` derives a plugin's trust class (`bundled` / `approved` / `off-registry` /
`unverified`) from it.

```
plugins/_registry.mjs:38   try { entry = JSON.parse(readFileSync(…)) } catch { /* fail-open */ }
plugins/_registry.mjs:58-60  catch { return { registryVersion: 1, plugins: [] }; }
```

A registry file that does not parse yields `entry: null`, is filtered out at `:48`, and the plugin
it approved silently reclassifies from `approved` to `unverified` (or, for the legacy single-file
path at `:53-60`, the *entire* registry does). That direction is fail-*closed* for trust, which is
the right way round — but the demotion is silent at the call site. `validate-plugin-registry.mjs`
catches it in CI; a fork that edits a registry file locally gets no signal.

Minor drift worth noting: `_registry.mjs:5` documents the pinned field as `pinnedSha`; the actual
field in every registry file is `sha` (`plugins-registry/tavily.json:8`). `pinnedSha` appears
nowhere else in the repo.

## 6. 14 non-gating `warn()` checks — MEDIUM

`tests/helpers.mjs:72` increments a warnings counter; `finish()` at `:100-108` exits **0** when
`warnings > 0` and `failed === 0`, printing `🟡 Tests passed with warnings`. CI treats that as a
pass. Any check that degrades to `warn` — e.g. `warn('Dashboard build skipped — go compiler not in
env')` at `test-all.mjs:1533` — is a gate that disappears when its precondition is missing rather
than failing loudly.

**Credit where due:** `tests/helpers.mjs:81-98` documents the *exact* bug the brief asked me to hunt
for, and it is already fixed. A failing `node:test` suite under `tests/` set `process.exitCode = 1`,
which the unconditional `process.exit(0)` in `finish()` then overwrote — "📊 2049 passed, 0 failed /
🟢 All tests passed / exit 0" while 16 discovered suites were failing (verified 2026-08-03 per the
comment). The fix reads `process.exitCode` into `runnerFailed` before printing (`:96`) and ORs it
into the exit decision (`:100`). This is the highest-value comment in the repo.

## 7. `scripts/check-syntax.mjs` — one process per file, serially — LOW-MEDIUM

`scripts/check-syntax.mjs:35-43` loops over every `.mjs` in the tree and calls
`execFileSync(process.execPath, ['--check', file])` — **one Node process spawn per file**, blocking,
no concurrency. At 524 tracked `.mjs` that is 524 sequential interpreter startups on every
`npm run lint`, on all three OS legs of the matrix (`test.yml:34`).

`test-all.mjs` already solved this for itself: `:233-282` runs the same `node --check` fan-out
through `promisify(execFile)` with a `SYNTAX_POOL_SIZE = 8` worker pool (`:233`). The lint script
never picked that up. Straight duplication of intent with the slow implementation left in the
critical path.

## 8. Sync reads in per-item loops — LOW

Real instances, each reading one file per iteration with no batching or caching:

- `salary-gap.mjs:564` — `readFileSync(join(REPORTS_DIR, file))` per report, inside `catch { continue; }`
- `weekly-digest.mjs:168` — per report file
- `verify-pipeline.mjs:301` — `extractRole(readFileSync(…))` per report
- `check-table-freshness.mjs:270`, `:552` — `yaml.load(readFileSync(…))` per config file
- `eval-golden.mjs:193`, `lib/golden-budget-analysis.mjs:141` — `JSON.parse(readFileSync(…))` per golden case
- `plugins/_lock.mjs:51` — `sha256(readFileSync(childAbs))` per file during a directory walk

At the scale this tool runs (tens to low hundreds of reports) none of these is a user-visible
problem. Listed for completeness; do not spend effort here.

## 9. Injection surface — LOW, and largely refuted

I looked for the two shapes the brief named and found neither.

- **`execSync`/`exec` with interpolated data: zero.** There are exactly **three** `execSync` call
  sites outside tests (`reply-watch.mjs:329`, `update-system.mjs:1966`, `:1973`) and all three are
  **constant string literals**. A PCRE2 scan for `` exec(Sync)?(`…${ `` across all non-test `.mjs`
  returns no matches.
- **Playwright `page.evaluate` with interpolated data: zero.** Every call site passes a **closure**,
  not a string: `browser-extract.mjs:201`, `liveness-browser.mjs:308`/`:342`, `scan.mjs:955`,
  `openrouter-runner.mjs:415`, `batch-evaluate-gemini.mjs:194`, `img-to-pdf.mjs:143`,
  `generate-pdf.mjs:1578`. No `addInitScript` with a template string.
- **`page.goto` with a URL from data**: `browser-extract.mjs:117` gates on
  `/^https?:$/.test(new URL(url).protocol)`, which closes `file:`/`javascript:` for that path.
  I did **not** verify an equivalent guard on `archive-posting.mjs:331`, `liveness-browser.mjs:300`,
  `upskill.mjs:909`, or `openrouter-runner.mjs:413` — **confidence medium, unverified**. Worth a
  targeted follow-up; the impact is bounded (a local-first tool navigating to `file://` from a URL
  the user themselves pasted into the tracker).
- **`generate-pdf.mjs:1538-1573`** writes HTML to a temp file and navigates `file://` deliberately,
  documented at `:1459` as the way to get relative asset resolution. The HTML is built from
  user-authored CV content, so it is the user's own trust domain — but a JD-derived string reaching
  that template unescaped would execute with a `file://` origin. I did not trace the escaping;
  **confidence low, flagged for the follow-up, not asserted**.

Honest calibration: this is a single-user local tool run from a terminal against URLs the user
supplied. The `execSync` and `evaluate` surfaces are genuinely clean — someone has been careful
here. `tests/helpers.mjs:120-135` even maintains an explicit executable allowlist so CodeQL's
uncontrolled-command-line finding is closed by construction rather than dismissed.

## 10. `package.json` missing `"type": "module"` — verified absent, breaks nothing — LOW

Verified: the root `package.json` has no `"type"` key. The single `"type"` in the file is
`"type": "git"` inside `repository` (`package.json:90`). `scaffolder/package.json:8` **does** set
`"type": "module"`; `web/package.json` does not.

What breaks: **nothing at runtime.** `.mjs` is unconditionally ESM regardless of the field, and
every executable file in the tree is `.mjs`. The only two `.js` files are
`plugins/_types.js` and `providers/_types.js`, and both are documentation-only JSDoc typedef
catalogues that are never imported at runtime — they appear solely inside
`@typedef {import('./_types.js')…}` annotations (`providers/personio.mjs:3`, `verify-portals.mjs:466`,
`providers/mycareersfuture.mjs:2`, and ~10 more). Both files say so in their own headers
(`plugins/_types.js:3-8`, `providers/_types.js:3-6`).

The residual cost is real but small: any future `.js` file is CJS by default, and a `tsc --checkJs`
pass resolves the two `_types.js` files under CJS semantics. Adding `"type": "module"` is a one-line,
zero-risk correctness improvement — but do not sell it as a bug fix.

## 11. Duplicate `ARCHITECTURE.md` — REFUTED

There is no duplication. The two files share a `# Architecture` H1 and **nothing else**:

| `ARCHITECTURE.md` (93 lines) | `docs/ARCHITECTURE.md` (115 lines) |
|---|---|
| Principles · The two layers · Files are canonical · Why the flat root · Component map · Data flow · Quality gates · Where to start reading | System Overview · Evaluation Flow · Batch Processing · Data Flow · File Naming Conventions · Pipeline Integrity · Dashboard TUI |

The split is explicit and bidirectional: `ARCHITECTURE.md:3` points to `docs/ARCHITECTURE.md` "for
runtime flow diagrams", and `docs/ARCHITECTURE.md:3-4` points back — "Design principles and the
system/user data-contract layers live in `../ARCHITECTURE.md`". A `diff` shares only the H1 and a
`## Data Flow` heading whose contents differ.

The only defect is the shared filename: an agent or contributor grepping for `ARCHITECTURE.md` hits
an ambiguous path. Renaming `docs/ARCHITECTURE.md` → `docs/RUNTIME-FLOWS.md` would fix it, but it is
a documented system path and the repo's stated doctrine is path stability
(`ARCHITECTURE.md:26-28`). **Recommend leaving it alone.**

## 12. `plugins/` vs `plugins-registry/` — REFUTED

Different things, cleanly separated, documented at `plugins/_registry.mjs:1-12`.

- **`plugins/`** — *bundled implementations*, system layer, in-tree code. Four real plugins
  (`apify`, `gmail`, `notion`) plus `_template/`, each a directory with a `manifest.json`,
  `index.mjs`, and `skill.md` (`plugins/apify/manifest.json`). Files prefixed `_` are shared helpers
  and are never discovered as plugins (`plugins/_types.js:10`).
- **`plugins-registry/`** — *a curated allowlist of external repos*, one JSON file per plugin, no
  code. Each entry pins `repo` + `sha` + `allowedHosts` + `requiredEnv` + the registration issue
  (`plugins-registry/tavily.json`). Users install these into a gitignored `plugins.local/`.

The one-file-per-plugin layout is a deliberate fix, explained at `plugins/_registry.mjs:8-11`: the
old single-array `plugins-registry.json` made every concurrent registry PR a guaranteed merge
conflict. The legacy single-file format is still read as a fallback (`_registry.mjs:52-60`) — that
dead path is the only thing here worth eventually deleting.

---

## Three test locations, three naming conventions — CONFIRMED (four, actually)

| Location | Count | Naming | Runner |
|---|---|---|---|
| Repo root | 20 `.mjs` | **two** conventions: `*.test.mjs` (10) and `*-tests.mjs` (7), plus `test-all.mjs`, `test-salary-filter.mjs`, `test-trust-validator.mjs` with a `test-` **prefix** | invoked by name from `test-all.mjs`; not auto-discovered |
| `tests/` | 214 `.mjs` | `*.test.mjs`, plus 3 non-test support files: `helpers.mjs`, `portal-health-guard.mjs`, `fixtures/three-city-board.mjs` | auto-discovered by `test-all.mjs:107-207` |
| `test/` (singular) | 7 `.mjs` | `*.test.mjs` **and** `cv-visual/cv-visual.spec.mjs` (a `.spec.mjs` — a fourth convention) | Playwright, via `playwright.cv.config.mjs` / `npm run test:cv-visual` |
| `web/tests/` | 34 files | `*.test.mjs` | `npm test` inside `web/` (`.github/workflows/web-ci.yml:34`) |

Root naming breakdown, exactly:

- `*.test.mjs` (10): `company-history`, `contacts`, `detect-reposts`, `discover-ats`,
  `followup-cadence`, `invite-match`, `jd-similarity`, `process-quality`, `reply-matcher`
- `*-tests.mjs` (7): `agent-inbox-tests`, `followup-seed-tests`, `paste-reply-tests`,
  `set-status-tests`, `tracker-columns-tests`, `tracker-writer-lock-tests`, `updater-migration-tests`,
  `upgrade-tests`
- `test-*` prefix (3): `test-all`, `test-salary-filter`, `test-trust-validator`

`test/` vs `tests/` is the sharpest edge — two directories one character apart, both containing
`*.test.mjs`, discovered by two different runners. `test-all.mjs:107` hardcodes
`TESTS_DIR = join(ROOT, 'tests')`, so anything dropped into `test/` by mistake is silently never run
by the main suite. That is a live footgun, not a cosmetic one.

Also: `package.json` has **no `test` script** (`package.json:9-69`, 59 entries). `npm test` at the
repo root does nothing. The suite is `node test-all.mjs`, discoverable only from `AGENTS.md:363` and
CI.
