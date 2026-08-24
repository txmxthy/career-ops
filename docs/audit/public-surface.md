# PUBLIC SURFACE AUDIT — career-ops root scripts

Scope: which root `.mjs` paths are frozen (cannot move without breaking a consumer we
cannot update in the same commit), derived from actual references, not repo shape.

---

## 0. Method

Every root `.mjs` name was matched against, in order: `package.json`, `.github/**`,
`dashboard/**` (Go), `web/**` (Next.js), `batch/**`, `docs/**`, `README*.md`,
`DOCKER.md`, `Dockerfile`, `docker-compose.yml`, `cops`, `modes/**`,
`plugins/**`, `scaffolder/**`, `.claude-plugin/`, `.agents/`, `.opencode/`,
and `update-system.mjs`'s `SYSTEM_PATHS`.

**Freeze test applied:** a reference freezes a path only if the referencing consumer
*cannot be edited in the same commit as the move*. In-repo text (modes, docs, README,
`package.json`, `cops`, `batch/batch-runner.sh`, CI workflows, `test-all.mjs`) is ours;
it does not freeze anything. What freezes a path is (a) an already-installed copy of the
software, or (b) a component that resolves paths in a *different* checkout at runtime.

---

## 1. What actually consumes root scripts by machine

### 1.1 The Go TUI (`dashboard/`) — one exec

`dashboard/main.go:269`

```go
args := []string{"generate-pdf.mjs", msg.HTMLPath, msg.PDFPath}
// ...
cmd := exec.Command("node", args...)
cmd.Dir = msg.CareerOpsPath
```

The dashboard is built into a **standalone binary** (`dashboard/README.md:18,21-23`,
`build-dashboard.mjs`) which accepts `--path <dir>` pointing at *any* career-ops
directory (`dashboard/README.md:25-27`). So a binary built at version N can exec
`generate-pdf.mjs` in a checkout at version M. That is the definition of a frozen path.

Everything else in `dashboard/` referencing `.mjs` is a **parity comment**, not a call:
`internal/data/career.go:597,619,630` (mirrors `tracker-parse.mjs`),
`career.go:937,954` (mirrors `stats.mjs`'s `computeFunnel`),
`internal/data/tracker_lock.go:87` (mirrors `tracker-utils.mjs`),
`internal/data/pdf.go:15,121,173` (describes `generate-pdf.mjs` output).
Those freeze *behaviour*, not *paths*.

### 1.2 The web app (`web/`) — the largest and hardest consumer

`web/` is a separate npm package (`web/package.json:2-4`, `@career-ops/web`, own
`node_modules`, Node ≥22 vs the core's ≥18 at `package.json:7`). It resolves the core at
runtime:

`web/src/lib/career-ops.ts:16-20`
```ts
export function careerOpsRoot(): string {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  if (env) return env;
  return path.resolve(process.cwd(), "..");
}
```
`web/src/lib/career-ops.ts:28-30`
```ts
export function rootScript(nameNoExt: string): string {
  return path.join(careerOpsRoot(), `${nameNoExt}.mjs`);
}
```

`CAREER_OPS_ROOT` is a documented user setting (`web/README.md:64`), so the web app can
point at a **different, independently-versioned checkout**. It is written for that skew
explicitly — it feature-detects the core rather than assuming a version:

- `web/src/lib/career-ops.ts:34-41` — `trackerCanDelete()` greps `tracker.mjs` source for
  `delete` + `--num` and hides the UI on older cores.
- `web/src/lib/core/scan.ts:62-69` — `scannerSupportsJson()` greps `scan-ats-full.mjs`
  source for `--json` + `capHit`.
- `web/src/app/api/status/route.ts:141-146` — "The web can run against a
  `CAREER_OPS_ROOT` that holds data and no scripts."
- `web/src/lib/core/text-key.ts:39-45` — dynamic-imports `tracker-parse.mjs`, warns
  "Update career-ops to keep web dedup identical to CLI dedup" when the export is absent.

A codebase that ships version-skew fallbacks for these paths has, in effect, published
them as an API.

**Spawn / exec sites (path is an argv element):**

| Root script | Site |
|---|---|
| `generate-pdf.mjs` | `web/src/lib/pdf-render.mjs:102` (`path.join(root, "generate-pdf.mjs")`) |
| `mark-pdf-ready.mjs` | `web/src/lib/pdf-render.mjs:122` |
| `set-status.mjs` | `web/src/app/api/status/route.ts:75` (`rootScript("set-status")`), existence-probed at `:146` |
| `doctor.mjs` | `web/src/app/api/doctor/route.ts:13,18` (`execFile("node", [doctor, "--json"])`) |
| `tracker.mjs` | `web/src/app/api/tracker/delete/route.ts:58` (`[rootScript("tracker"), "delete", "--num", num]`) |
| `scan-ats-full.mjs` | `web/src/lib/core/scan.ts:89` (argv), probed at `:64` and `web/src/app/api/explore/route.ts:27` |
| `verify-portals.mjs` | `web/src/app/api/portals/verify/route.ts:23,35` |
| `followup-cadence.mjs` | `web/src/app/api/followups/route.ts:15,18`; `web/src/app/api/followups/cadence/route.ts:39` |
| `verify-portals.mjs`, `generate-pdf.mjs` | `web/src/app/api/run/route.ts:45` — existence gate keyed by literal filename |

**Dynamic-import sites (path *and* named export are the contract):**

| Root module | Site | Exports depended on |
|---|---|---|
| `scan.mjs` | `web/src/lib/core/pipeline.ts:39,43,47` | `appendToPipeline`, `appendToScanHistory` |
| `tracker-utils.mjs` | `web/src/lib/core/tracker-lock.ts:44,48-51` | `acquireTrackerLock`, `trackerLockDirFor` (throws by name if absent); exit codes `CLI_EXIT` consumed at `web/src/app/api/status/route.ts:53` |
| `tracker-parse.mjs` | `web/src/lib/core/text-key.ts:39,43` | `normalizeTextKey` |
| `followup-seed.mjs` | `web/src/lib/core/followups-lock.ts:55,59-61` | `withFollowupsLock` (throws by name if absent) |
| `lib/local-today.mjs` | `web/src/lib/core/pipeline.ts:44,47` | `localToday` — **not a root path**, but frozen by the same consumer |

**Prompt-text sites** — the web hands these strings to an agent CLI which then runs them
verbatim in the core checkout:

- `web/src/lib/run-prompts.mjs:128` — "Reserve a report number: run \`node reserve-report-num.mjs\`"
- `web/src/lib/run-prompts.mjs:132` — "run \`node merge-tracker.mjs\`"

### 1.3 `update-system.mjs` — the strongest freeze of all

`update-system.mjs:40` pins `CANONICAL_REPO = 'https://github.com/santifer/career-ops.git'`;
this checkout has `upstream → santifer/career-ops` (`git remote -v`).

- `update-system.mjs:1649-1650` fetches the **remote** updater by literal path:
  `git('show', 'FETCH_HEAD:update-system.mjs')`.
- `update-system.mjs:838` — `REEXEC_FALLBACK_FILES = ['update-system.mjs', 'scaffolder/bin/skill-entrypoints.mjs']`.
- `package.json:33-36` — `update:check` / `update` / `rollback` all `node update-system.mjs`.

Renaming `update-system.mjs` breaks the update path for **every already-installed copy**,
including a fresh clone of this fork.

### 1.4 CI, `cops`, `batch/`, `modes/`, docs — all in-repo, none freeze

- CI: `.github/workflows/test.yml:34` (`npm run lint`), `:45` (`node test-all.mjs --quick`),
  `:63` (`npm run test:cv-visual`), `:89,91,93` (`node upgrade-tests.mjs --pr-gate|--canary|--local-paths`);
  `.github/workflows/plugin-registry-validate.yml:37,42` (`node validate-plugin-registry.mjs`).
  All live in this repo and move in the same commit.
- `.github/PULL_REQUEST_TEMPLATE.md:23` — "I ran `node test-all.mjs`". Social convention,
  not a machine consumer.
- `.github/CODEOWNERS:37,38,43-49` — ownership rules keyed by path. Editable in-commit.
- `cops:65` — allowlist `doctor|verify|normalize|dedup|merge|pdf|sync-check|liveness|scan|gemini:eval|update|update:check|rollback`;
  everything else is forwarded raw (`cops:69-72`). It maps to **npm script names**, not
  file paths — it is insulated from renames by `package.json`.
- `Dockerfile` and `docker-compose.yml` name **zero** `.mjs` files (full read of both;
  Dockerfile:1-45, docker-compose.yml:1-33). The only `.mjs` in `DOCKER.md` is an example,
  `DOCKER.md:46`.
- `batch/batch-runner.sh:682,696` (`reserve-report-num.mjs`), `:1100` (`merge-tracker.mjs`),
  `:1103` (`reconcile-pipeline.mjs`), `:1106,1253,1256` (`verify-pipeline.mjs`). In-repo shell.
- `modes/**` — 42 distinct shell-outs. Ours by the task's own framing.
- `plugins/**` — plugins are data-driven (`plugins/README.md:47-60`); no third-party
  plugin imports a root script. `plugins.mjs:31` imports `./scan.mjs` — that is the core
  importing itself, in-repo.
- `scaffolder/` publishes `@santifer/career-ops` to npm with `files: ["bin/cli.mjs",
  "bin/skill-entrypoints.mjs", "README.md"]` (`scaffolder/package.json:9-12`) — it ships
  **no** root script and references none.
- `.claude-plugin/plugin.json` ships only `./.agents/skills/career-ops`;
  `.agents/skills/career-ops/SKILL.md` and `.opencode/commands/*.md` reference **zero**
  `.mjs` files (measured).

---

## 2. THE FROZEN LIST — 14 root paths + 1 `lib/` path

Each entry names the *external* consumer that pins it.

| # | Path | Frozen by | Contract surface |
|---|---|---|---|
| 1 | `update-system.mjs` | Every already-installed copy, and upstream `santifer/career-ops`. `update-system.mjs:1650` resolves it by literal name in `FETCH_HEAD`; `:838` re-exec fallback. | Filename + CLI verbs `check`/`apply`/`rollback` |
| 2 | `generate-pdf.mjs` | **Two** external consumers: the standalone Go binary (`dashboard/main.go:269`, run against any `--path`) and the web app (`web/src/lib/pdf-render.mjs:102`; existence-gated at `web/src/app/api/run/route.ts:45`) | Filename + positional `<html> <pdf>` + `--format=`, `--report=`, `--allow-reorder` |
| 3 | `mark-pdf-ready.mjs` | web app — `web/src/lib/pdf-render.mjs:122`; failure message tells the user to run it by name at `:209` | Filename + `<reportNum> --json` |
| 4 | `set-status.mjs` | web app — `web/src/app/api/status/route.ts:75`, probed `:146` | Filename + argv + exit codes (`CLI_EXIT`, `route.ts:53`) |
| 5 | `doctor.mjs` | web app — `web/src/app/api/doctor/route.ts:13,18` | Filename + `--json` emitting `{onboardingNeeded, missing, warnings}` |
| 6 | `tracker.mjs` | web app — `web/src/app/api/tracker/delete/route.ts:58`; source-grepped for capability at `web/src/lib/career-ops.ts:36` | Filename + `delete --num <n> [--dry-run]`; **source text** `delete`/`--num` is itself probed |
| 7 | `scan.mjs` | web app — dynamic import, `web/src/lib/core/pipeline.ts:39,43,47` | Filename + named exports `appendToPipeline`, `appendToScanHistory` |
| 8 | `scan-ats-full.mjs` | web app — `web/src/lib/core/scan.ts:89`, probed `:64` and `web/src/app/api/explore/route.ts:27` | Filename + `--dry-run --since --ats --limit [--json]`; source text `--json`/`capHit` probed |
| 9 | `verify-portals.mjs` | web app — `web/src/app/api/portals/verify/route.ts:23,35`; existence-gated `web/src/app/api/run/route.ts:45` | Filename + stdout glyph format |
| 10 | `followup-cadence.mjs` | web app — `web/src/app/api/followups/route.ts:15,18`; `web/src/app/api/followups/cadence/route.ts:39` | Filename + `--json` emitting `{entries, metadata, cadenceConfig}` |
| 11 | `followup-seed.mjs` | web app — dynamic import, `web/src/lib/core/followups-lock.ts:55,59-61` | Filename + named export `withFollowupsLock` |
| 12 | `tracker-utils.mjs` | web app — dynamic import, `web/src/lib/core/tracker-lock.ts:44,48-51` | Filename + named exports `acquireTrackerLock`, `trackerLockDirFor`, `CLI_EXIT` |
| 13 | `tracker-parse.mjs` | web app — dynamic import, `web/src/lib/core/text-key.ts:39,43` | Filename + named export `normalizeTextKey` |
| 14 | `reserve-report-num.mjs` **and** `merge-tracker.mjs` | web app emits them as literal shell commands into an agent prompt: `web/src/lib/run-prompts.mjs:128,132` | Filename + stdout (`reserve` prints a bare 3-digit number) |
| — | `lib/local-today.mjs` | web app — dynamic import, `web/src/lib/core/pipeline.ts:44,47` | Not a root path; listed because the same consumer pins it. Named export `localToday` |

**Count: 15 root scripts** (item 14 is two files), plus one `lib/` module.

### Freeze strength, ranked

- **Absolute** — `update-system.mjs`. Breaks self-update for installed copies.
- **Hard** — `generate-pdf.mjs`. The only path pinned by a *compiled, separately
  distributed* artifact (the Go binary).
- **Hard** — the 12 web-app paths. Pinned by a separately-versioned Node app that is
  explicitly coded for cross-version operation against an arbitrary `CAREER_OPS_ROOT`.
  Note that `web/` lives in this repo, so a *co-versioned* move is mechanically possible —
  but the app's own skew-tolerance code proves the maintainer treats these as an API for
  older/newer cores, and moving them silently degrades every mismatched pair.

### Explicitly NOT frozen

- **The 17 registered root test files** — `invite-match.test.mjs`,
  `updater-migration-tests.mjs`, `tracker-columns-tests.mjs`, `agent-inbox-tests.mjs`,
  `followup-seed-tests.mjs`, `paste-reply-tests.mjs`, `set-status-tests.mjs`,
  `tracker-writer-lock-tests.mjs`, `test-trust-validator.mjs`, `test-salary-filter.mjs`,
  `detect-reposts.test.mjs`, `discover-ats.test.mjs`, `followup-cadence.test.mjs`,
  `process-quality.test.mjs`, `company-history.test.mjs`, `contacts.test.mjs`,
  `reply-matcher.test.mjs`. Their **only** consumer is the hand-written list at
  `test-all.mjs:320-354`, in this repo. `test-all.mjs:103-115` auto-discovers only
  `tests/**/*.test.mjs`, and `:106` says so explicitly: "standalone `*.test.mjs` files are
  never picked up."
- **`test-all.mjs`, `upgrade-tests.mjs`, `validate-plugin-registry.mjs`** — CI-only
  (`test.yml:45,89-93`; `plugin-registry-validate.yml:37,42`) plus
  `PULL_REQUEST_TEMPLATE.md:23`. All editable in-commit. Convention, not contract.
- **Everything referenced only by `modes/**`** — 42 scripts. Ours to rewrite.
- **Everything referenced only by `docs/`, `README*`, `package.json`, `cops`, `batch/`** —
  including `cv-sync-check.mjs` (38 mode files, 0 machine consumers),
  `verify-pipeline.mjs`, `dedup-tracker.mjs`, `normalize-statuses.mjs`,
  `reconcile-pipeline.mjs`, `stats.mjs`, `salary-gap.mjs`, `company-history.mjs`,
  `funnel-velocity.mjs`, all six `*-eval.mjs` / `openrouter-runner.mjs`, all `latex`
  scripts, `browser-extract.mjs`, `check-liveness.mjs`, `find.mjs`, `upskill.mjs`.
- **`stats.mjs`** deserves a call-out: it looks frozen (hits in both `dashboard/` and
  `web/`) but every hit is a *parity comment* — `dashboard/internal/data/career.go:937,954`,
  `web/src/lib/funnel-tiles.mjs:15,20`, `web/src/app/analytics/page.tsx:48`. Both consumers
  reimplement its funnel maths rather than call it. Its **semantics** are frozen; its path is not.

---

## 3. Dead

- **`jd-similarity.test.mjs` is dead.** It is shipped (present in `update-system.mjs`'s
  `SYSTEM_PATHS`) but it is not in `test-all.mjs`'s registered list (`test-all.mjs:320-354`)
  and root-level `*.test.mjs` is never auto-discovered (`test-all.mjs:106`). Repo-wide, the
  only files naming it are `update-system.mjs` and `CHANGELOG.md`. It never runs.
  *Confidence: high (measured; the exclusion is stated in the harness's own comment).*
- Nothing else at root is orphaned. A by-name scan across all 1178 tracked files found
  **zero** root `.mjs` with no reference outside itself.

---

## 4. Corrections to the recon brief

1. **The "34 unreferenced root scripts" are not unreferenced.** Every one is imported by
   other root scripts. Measured import-site counts: `pipeline-lock.mjs` 20,
   `liveness-browser.mjs` 12, `role-matcher.mjs` 11, `process-quality.mjs` 10,
   `user-agent.mjs` 9, `profile-language.mjs` 8, `theme-style.mjs` 8, `title-keywords.mjs` 6,
   `skill-extract.mjs` 6, `url-key.mjs` 5, `tracker-links.mjs` 5, `sync-pdf-flags.mjs` 5,
   `reply-matcher.mjs` 5, `fingerprint-core.mjs` 4, `jsonc-parse.mjs` 3, etc. They are
   undocumented **internal library modules squatting at root**, and they are the cleanest
   `lib/` extraction candidates precisely *because* nothing external names them.
2. **The recon brief missed `web/` entirely.** It is by far the largest external consumer
   of root paths — 12 of the 15 frozen entries exist only because of it — and it is the
   only consumer that pins *named exports* as well as filenames.
3. **`scan-apify.mjs`** — confirmed dangling. `AGENTS.md:401` lists it; no such file, no
   other reference.
4. **`cops` does not freeze anything.** Its allowlist (`cops:65`) is npm-script names, so
   it is insulated from file renames by `package.json`. The recon brief's framing of it as
   "a second, narrower public surface that has already drifted" is right about drift but
   wrong about it constraining paths.
5. **`Dockerfile` / `docker-compose.yml` reference no scripts at all** — the whole project
   is bind-mounted (`Dockerfile:40-42`, `docker-compose.yml:16`).

---

## 5. The constraint that dominates any dedupe (read this before moving anything)

`update-system.mjs apply` computes its checkout set as the **union of local and upstream**
manifests:

`update-system.mjs:1648-1658`
```js
const remoteUpdaterSource = git('show', 'FETCH_HEAD:update-system.mjs');
remoteSystemPaths = extractArrayFromSource(remoteUpdaterSource, 'SYSTEM_PATHS');
// ...
const updatePaths = mergePathLists(SYSTEM_PATHS, remoteSystemPaths, BOOTSTRAP_PATHS);
```
`mergePathLists` (`update-system.mjs:801-812`) is a plain de-duplicating concatenation —
it never subtracts.

The prune step is the only deletion mechanism, and it is scoped to the **local** manifest
and to files **absent from the remote tree**:

`update-system.mjs:824-832`
```js
export function staleSystemFiles(localFiles, remoteFiles, systemPaths, userPaths = USER_PATHS) {
  const remote = new Set([...remoteFiles].map(normalizeRepoPath));
  if (remote.size === 0) return [];
  return [...localFiles]
    .map(normalizeRepoPath)
    .filter((file) => !remote.has(file))          // ← still present upstream ⇒ never pruned
    .filter((file) => systemPaths.some((entry) => pathMatchesManifest(file, entry)))
    .filter((file) => !userPaths.some((entry) => pathMatchesManifest(file, entry)));
}
```
called at `update-system.mjs:1764` with **`SYSTEM_PATHS`** (local), not `updatePaths`.

**Consequence for this fork:** if we delete or move a root script and drop it from our
local `SYSTEM_PATHS`, then on the next `npm run update` against `santifer/career-ops`:
upstream's `SYSTEM_PATHS` still lists the old path → it enters `updatePaths` → it is
checked out again; and the prune cannot remove it because the file *is* present in
`FETCH_HEAD`. **Every removed root script is resurrected on every upstream update.**
*Confidence: high — read the code path end to end; not executed.*

So the dedupe has exactly three viable shapes:

1. **Stop tracking upstream** — never run `update-system.mjs apply` against
   `santifer/career-ops`. Then only the 15 frozen paths bind.
2. **Keep tracking upstream and leave root filenames alone** — dedupe *inside* files
   (extract shared logic into `lib/`, leave each root script as a thin shim at its
   original path). The 15-entry frozen list becomes irrelevant because nothing moves.
3. **Fork the updater** — rewrite `update-system.mjs`'s merge to subtract a local
   `REMOVED_PATHS` list. Note this collides with freeze #1: the updater re-execs the
   *remote* copy of itself (`update-system.mjs:1650`, `resolveReexecCheckout` at `:853+`),
   so the fix has to survive being overwritten by upstream's version mid-update.

Option 2 is the one that costs nothing and loses nothing: 92 root scripts read files
directly and 84 hand-parse `argv` (verified baseline), so the duplication is *inside* the
files, and shim-ing costs one import line per script.
