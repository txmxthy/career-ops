# dup-data-access — duplicate-functionality audit (cluster: data access)

Scope: how scripts locate the tracker (`applications.md`), the pipeline inbox (`pipeline.md`)
and config (`config/profile.yml`); how they read and write them (missing-file behaviour,
encoding, atomicity, locking, backup); plus status normalisation and dedup keys.

Repo root: `/Users/tim/Documents/Personal/workspaces/career-ops/dedupe-core/career-ops`.
All paths below are repo-relative. Every claim carries `path:line`.

---

## Capability 1 — Tracker path resolution (`applications.md`)

### Implementations (12)

| # | Location | Env override | Root-layout fallback | Canonicalised (realpath) | Base |
|---|---|---|---|---|---|
| 1 | `tracker-utils.mjs:109-117` `resolveTrackerPath(rootDir)` | `CAREER_OPS_TRACKER` | yes (`data/applications.md` → `applications.md`) | **yes** (`canonicalizeTrackerPath`, `tracker-utils.mjs:166-173`) | caller-supplied root |
| 2 | `followup-seed.mjs:204-210` (private `resolveTrackerPath(override)`) | `CAREER_OPS_TRACKER` | yes | no | `CAREER_OPS` (script dir) |
| 3 | `verify-pipeline.mjs:36-40` (inline ternary) | `CAREER_OPS_TRACKER` | yes | no | script dir |
| 4 | `find.mjs:165` | `CAREER_OPS_TRACKER` | **no** — hardcodes `data/applications.md` | no | script dir (`find.mjs:34`) |
| 5 | `tracker.mjs:47` | `CAREER_OPS_TRACKER` | no | at use sites only (`tracker.mjs:459,522` via `openTrackerTransaction`) | **CWD** (bare relative string) |
| 6 | `followup-cadence.mjs:24-26` | **no** | yes | no | script dir |
| 7 | `analyze-patterns.mjs:23-25` | **no** | yes | no | script dir |
| 8 | `upskill.mjs:33-35` | **no** | yes | no | script dir |
| 9 | `invite-match.mjs:44-46` | **no** | yes | no | script dir |
| 10 | `tracker-sync-check.mjs:66-68` (CLI `--apps-file` at `tracker-sync-check.mjs:48`) | **no** | yes | no | script dir |
| 11 | `stats.mjs:30` | **no** | **no** | no | script dir |
| 12 | `plugins.mjs:34` | **no** | **no** | no | script dir (`plugins.mjs:33`) |
| 13 | `scan.mjs:83` (`APPLICATIONS_PATH`, read-only dedup source) | **no** | no | no | **CWD** |

Consumers of #1 (the shared one): `reserve-report-num.mjs:56`, `funnel-velocity.mjs:700`,
`reply-watch.mjs:27`, `normalize-statuses.mjs:23`, `outcome.mjs:150`, `set-status.mjs:263`,
`sync-pdf-flags.mjs:23`, `dedup-tracker.mjs:26`, `company-history.mjs:271`,
`mark-pdf-ready.mjs:105`, `merge-tracker.mjs:35`, `generate-pdf.mjs:46`.

### Canonical pick

**`tracker-utils.mjs:109` `resolveTrackerPath()`.** Most callers (12), only one that
canonicalises (which the lock key depends on — `trackerLockDirFor` hashes the path,
`tracker-utils.mjs:225-241`), only one covered by a dedicated unit test
(`tests/tracker-utils.test.mjs:55-62`), and the only one paired with
`resolveWorkspaceRoot()`/`resolvePdfIndexPath()` (`tracker-utils.mjs:129-155`) so sibling
files follow a redirected tracker.

### DIVERGENCE

**D1.1 — `CAREER_OPS_TRACKER` is silently ignored by 8 scripts.**
With `CAREER_OPS_TRACKER=/tmp/t.md`, `set-status.mjs`, `dedup-tracker.mjs`,
`merge-tracker.mjs` etc. operate on `/tmp/t.md`, while `followup-cadence.mjs:24`,
`analyze-patterns.mjs:23`, `upskill.mjs:33`, `invite-match.mjs:44`,
`tracker-sync-check.mjs:66`, `stats.mjs:30`, `plugins.mjs:34` and `scan.mjs:83` read the
install's own tracker. Two workspaces in one process tree therefore report on one file and
mutate another.

**D1.2 — `invite-match.mjs` reads one tracker and writes another.**
`invite-match.mjs:44` ignores `CAREER_OPS_TRACKER`, but `applyRejectionStatus()` at
`invite-match.mjs:728` forwards `process.env` unchanged to `set-status.mjs`, which *does*
honour it (`set-status.mjs:263` → `tracker-utils.mjs:110`). Input: `CAREER_OPS_TRACKER=/tmp/t.md
node invite-match.mjs --apply …` → the match is computed against the repo tracker, the status
write lands in `/tmp/t.md`, possibly on a row number that means something else there.

**D1.3 — CWD-relative vs script-relative.**
`tracker.mjs:47` defaults to the bare string `'data/applications.md'`; `scan.mjs:83` likewise.
Every other implementation anchors to the script directory. Input: `cd /tmp && node
/repo/tracker.mjs sync` → resolves `/tmp/data/applications.md`, i.e. creates/queries a
different DB (`tracker.mjs:48-49` derives `DB_PATH` from `MD_PATH`) than `node tracker.mjs`
run from the repo.

**D1.4 — root-layout fallback missing in 3 places.**
`stats.mjs:30`, `plugins.mjs:34` and `find.mjs:165` hardcode `data/applications.md`. On an
original-layout install (tracker at repo-root `applications.md`, the layout every other
script still supports at `tracker-utils.mjs:112-114`), `stats.mjs` reports
`Tracker: — no data (data/applications.md missing)` (`stats.mjs:554`), `find.mjs` exits 1
(`find.mjs:166-170`) and `plugins.mjs` exports an empty snapshot (`plugins.mjs:85-86`) — all
three claiming an empty tracker that is not empty.

**D1.5 — no canonicalisation outside #1.**
`followup-seed.mjs:204`, `verify-pipeline.mjs:36`, `find.mjs:165`, `tracker-sync-check.mjs:66`
return a non-realpathed path. Where the repo is reached through a symlink, a writer using #1
and a writer using #2 hash different strings into `trackerLockDirFor`
(`tracker-utils.mjs:226`) and therefore do **not** exclude each other.

---

## Capability 2 — Pipeline inbox path resolution (`data/pipeline.md`)

### Implementations (8)

| # | Location | Env override | Base | Fallback |
|---|---|---|---|---|
| 1 | `scan.mjs:82` | `CAREER_OPS_PIPELINE` | **CWD** | none |
| 2 | `scan-ats-full.mjs:60` | **no** | **CWD** | none |
| 3 | `plugins.mjs:35` | no | script dir | none |
| 4 | `rank-pipeline.mjs:41` | no | script dir | none |
| 5 | `batch-evaluate-gemini.mjs:39` | no | script dir | none |
| 6 | `openrouter-runner.mjs:482,499,505,512,540` via `readFile`/`writeFile` (`openrouter-runner.mjs:162-171`) | no | script dir (`__dirname`) | none |
| 7 | `reconcile-pipeline.mjs:73-75` (`--pipeline` flag, `reconcile-pipeline.mjs:77` pattern) | no | script dir | **yes** (`pipeline.md` at root) |
| 8 | `doctor.mjs:491` | no | `projectRoot` | none |

`scan-interamt.mjs:23` and `plugins.mjs:31` import `appendToPipeline` from `scan.mjs`, so
their *writes* go to #1 regardless of their own constants.

### Canonical pick

**None of these is fit as-is.** The nearest is #1 (`scan.mjs:82`) because it is the only
env-overridable one and it owns the only locked writer (`scan.mjs:1877`), but its CWD base is
wrong. Recommendation: promote a `resolvePipelinePath(rootDir)` into `tracker-utils.mjs`
alongside `resolveTrackerPath`, honouring `CAREER_OPS_PIPELINE`, anchored to the workspace
root from `resolveWorkspaceRoot()` (`tracker-utils.mjs:129`), with the root-layout fallback #7
already implements.

### DIVERGENCE

**D2.1 — `plugins.mjs` dedups against a different file than it appends to.**
`plugins.mjs:35` reads `<scriptdir>/data/pipeline.md` for `existingPipelineUrls()`
(`plugins.mjs:74-81`), then calls `appendToPipeline` (`plugins.mjs:165`), which writes
`scan.mjs`'s CWD-relative `PIPELINE_PATH` (`scan.mjs:82`, `scan.mjs:1907`). Input: run
`node /repo/plugins.mjs run import` from any directory other than `/repo` → dedup set is
computed from the real inbox, jobs are appended to `$PWD/data/pipeline.md`, and every
subsequent run re-appends the same URLs (dedup can never see them).

**D2.2 — `CAREER_OPS_PIPELINE` half-honoured.**
With the env set, `scan-ats-full.mjs:1012-1014` tests and creates the *unredirected*
`data/pipeline.md` (its own constant, `scan-ats-full.mjs:60`) while its appends go through
`scan.mjs`'s redirected path. Result: a stray empty skeleton file next to the real inbox.

**D2.3 — three different skeletons for the same file.**
- `scan.mjs:1857-1864` / `doctor.mjs:483-488`: `# Pipeline — Pending URLs` + `## Pending` + `## Processed`
- `scan-ats-full.mjs:1014`: `# Pipeline\n\n## Pendientes\n` (Spanish heading, **no Processed section**)
- `openrouter-runner.mjs:512`: `# Pipeline\n\n## Pending\n` (no Processed section)

Consumers disagree on the heading vocabulary: `scan.mjs:1868-1869` accepts both
`## Pending`/`## Pendientes`; `rank-pipeline.mjs:369,422,443` recognises **only** `## Pending`;
`reconcile-pipeline.mjs:153-154` accepts both. Input: an inbox first created by
`scan-ats-full.mjs` → `rank-pipeline.mjs` finds no pending section and ranks nothing, silently.

**D2.4 — reconcile has a root-layout fallback nobody else has.**
`reconcile-pipeline.mjs:73-75` falls back to `<root>/pipeline.md`. On such an install
`reconcile-pipeline.mjs` operates on the real inbox while `scan.mjs`, `rank-pipeline.mjs`,
`plugins.mjs` and `batch-evaluate-gemini.mjs` all target a nonexistent `data/pipeline.md`.

---

## Capability 3 — Pipeline/tracker WRITE: atomicity, locking, backup

### Implementations

| Writer | Lock | Atomic | Backup |
|---|---|---|---|
| `tracker-utils.mjs:595-604` `writeFileAtomic` | caller's | **yes** (tmp in same dir + `renameSyncWithRetry`, `tracker-utils.mjs:570-580`) | no |
| `tracker-utils.mjs:474-511` `openTrackerTransaction` | `acquireTrackerLock` | yes (`replace()` → `writeFileAtomic`, `:497`) | no |
| `merge-tracker.mjs:124` + `:760,796,881,918,927,1349` | `acquireTrackerLock` (manual) | yes | no |
| `set-status.mjs:368` + `:529` | `acquireTrackerLockForCli` | yes | no |
| `mark-pdf-ready.mjs:113` + `:167` | `acquireTrackerLockForCli` | yes | no |
| `scan.mjs:1877-1908` `appendToPipeline` | `withPipelineLock` | **no** — plain `writeFileSync` (`:1907`) | no |
| `scan.mjs:1921-1940` `appendToScanHistory` | `withPipelineLock` | no (`appendFileSync`, `:1938`) | no |
| `rank-pipeline.mjs:327-331` | `withPipelineLock` | **no** — `writeFileSync` (`:331`) | no |
| `agent-inbox.mjs:191` | `withPipelineLock` | (see file) | no |
| `batch-evaluate-gemini.mjs:353` | **none** | **no** — whole-file `writeFileSync` | no |
| `reconcile-pipeline.mjs:297-298` | **none** | **no** — `writeFileSync` | **yes** (`copyFileSync` → `.pre-reconcile.bak`, `:297`) |
| `openrouter-runner.mjs:167-171` `writeFile` (pipeline at `:505,540`) | **none** | **no** | no |
| `scan-ats-full.mjs:1014` (create-only) | **none** | no | no |
| `followup-seed.mjs:440-446` `writeFileAtomic` (follow-ups.md) | own `acquireFollowupsLock` (`:318`) | yes (delegates `renameSyncWithRetry`, `:71,444`) | no |

### Canonical pick

**`openTrackerTransaction` (`tracker-utils.mjs:474`)** for the tracker — it is the only API
that forces lock-covers-read-modify-write, which is the exact lost-update the file documents
at `tracker-utils.mjs:266-272`. For the pipeline, `withPipelineLock` + a `writeFileAtomic`
replace (the two primitives already exist; only `scan.mjs:1907` and `rank-pipeline.mjs:331`
need to stop calling raw `writeFileSync`).

### DIVERGENCE

**D3.1 — the pipeline inbox has three unlocked whole-file rewriters.**
`batch-evaluate-gemini.mjs:353`, `reconcile-pipeline.mjs:298` and
`openrouter-runner.mjs:505/540` read the whole `pipeline.md`, mutate lines in memory and
truncate-write it back, taking **no** lock — while `scan.mjs:1877`, `rank-pipeline.mjs:327`
and `agent-inbox.mjs:191` do take `withPipelineLock` on the same file. Input: a scan appending
via `appendToPipeline` concurrently with `node reconcile-pipeline.mjs` → the reconcile writes
back a snapshot taken before the append and the appended offers are erased. The lock provides
no protection because the other side never asks for it.

**D3.2 — pipeline writes are non-atomic even under lock.**
`scan.mjs:1907` and `rank-pipeline.mjs:331` `writeFileSync` in place. A crash mid-write leaves
a truncated inbox. The tracker path solved this at `tracker-utils.mjs:595`; the pipeline path
never adopted it.

**D3.3 — backup-on-write exists exactly once.**
`reconcile-pipeline.mjs:297` is the only writer in the cluster that keeps a `.bak`. No tracker
writer does. So the *unlocked* writer is the safe-by-backup one and the locked writers are not.

**D3.4 — four separate lock-acquire loops with different timing.**

| Lock | Location | timeout | retry | stale |
|---|---|---|---|---|
| pipeline | `pipeline-lock.mjs:335-337`, defaults `:37-40` | 8 000 ms | 80 ms | 30 000 ms |
| portal-health | `portal-health-lock.mjs:111-113`, defaults `:39-41` | 8 000 ms | 80 ms | 30 000 ms |
| tracker | `tracker-utils.mjs:453-455` / `:477-479` | 60 000 ms | 75 ms | 600 000 ms |
| follow-ups | `followup-seed.mjs:319-321` | 60 000 ms | 75 ms | 600 000 ms |

All four share the classifiers and wait policy from `pipeline-lock.mjs` (imported at
`tracker-utils.mjs:21-24`, `followup-seed.mjs:67-70`) but each re-implements the acquire loop.
Concrete consequence: a process killed mid-write leaves a pipeline lock reclaimable after 30 s
and a tracker lock only after 10 min — the same crash blocks `set-status.mjs` for twenty times
longer than `scan.mjs`, with no stated reason for the asymmetry.

---

## Capability 4 — Missing-file behaviour on tracker read

### Implementations (15 distinct contracts)

| Behaviour | Sites |
|---|---|
| exit 0, "nothing to do" message | `dedup-tracker.mjs:268-271`, `merge-tracker.mjs:733-736`, `normalize-statuses.mjs:117-120`, `verify-pipeline.mjs:76-81` |
| exit 2, structured `no-tracker` error | `set-status.mjs:264-266`, `mark-pdf-ready.mjs:106-108`, `sync-pdf-flags.mjs:43-46`, `outcome.mjs:151-153` |
| exit 1 | `find.mjs:166-170` |
| return `[]` silently | `analyze-patterns.mjs:568`, `invite-match.mjs:614`, `reply-watch.mjs:99-101`, `tracker-sync-check.mjs:243` |
| return `''` (empty content, analysed as an empty tracker) | `followup-cadence.mjs:885`, `funnel-velocity.mjs:702`, `rejection-latency.mjs:347-348` |
| return `{rows: [], loaded: false}` (distinguishes absent from empty) | `company-history.mjs:272,286,301` |
| return `{error: …}` object | `upskill.mjs:390-392` |
| null section + `metadata.sources` flag | `stats.mjs:554` |

### Canonical pick

**`company-history.mjs:272`'s `{rows, loaded}` shape** is the only one that distinguishes
"file absent" from "file present and empty" without conflating the two into an exit code. For
mutating CLIs, **`set-status.mjs:264` + `CLI_EXIT` (`tracker-utils.mjs:694`)** is the canonical
contract — it is the one already centralised (`CLI_EXIT.NOT_FOUND = 2`) and the one the JSON
error shape is bound to (`makeCliFailWith`, `tracker-utils.mjs:700+`).

### DIVERGENCE

**D4.1 — a missing tracker is exit 0, 1 and 2 depending on which script you call.**
A wrapper that chains `verify-pipeline.mjs` (exit 0) then `set-status.mjs` (exit 2) then
`find.mjs` (exit 1) on a fresh clone gets three different verdicts for one condition.
`AGENTS.md:363` claims CI gates on the suite; nothing gates this contract.

**D4.2 — "absent" collapses into "empty" in the analytics path.**
`followup-cadence.mjs:885`, `funnel-velocity.mjs:702` and `rejection-latency.mjs:347` return
`''` for a missing file, which flows into the same analyser as a real empty tracker. A user
whose `CAREER_OPS_TRACKER` points somewhere wrong gets "0 applications, 0 overdue follow-ups",
not an error. `company-history.mjs:272` and `stats.mjs:554` are the only two that report the
distinction.

---

## Capability 5 — Status normalisation

### Implementations (11)

| # | Location | Alias source | Case folding | Strips trailing date | Unknown → |
|---|---|---|---|---|---|
| 1 | `tracker-utils.mjs:675-684` `resolveCanonicalState` (+ `foldStatusInput` `:660-673`) | **`templates/states.yml`** | NFKC + U+0307 strip | no (caller's job) | `null` |
| 2 | `followup-cadence.mjs:139-144` `normalizeStatus` | states.yml (cached map, `:118-134`) | `foldStatusInput` | **yes** (`:142`) | passthrough of the folded string |
| 3 | `normalize-statuses.mjs:42-101` | regex ladder `:47-88` **then** states.yml `:99` | plain `toLowerCase` for the ladder | partial (`:66,68`) | `{status:null, unknown:true}` |
| 4 | `tracker.mjs:145-154` | states.yml (`:129-141`) | plain `toLowerCase` | yes (`:150`) | `null` |
| 5 | `merge-tracker.mjs:154-181` `validateStatus` | **hardcoded** map `:163-174` | plain `toLowerCase` | yes (`:155`) | **`'Evaluated'` + warning** (`:180-181`) |
| 6 | `verify-pipeline.mjs:57-68` `ALIASES` + `:52-55` | **hardcoded** | plain `toLowerCase` | yes (`:128`) | reports an error (`:131`) |
| 7 | `analyze-patterns.mjs:95-99` | **hardcoded** `:~80-93` | plain `toLowerCase` | yes | passthrough → `classifyOutcome` `'pending'` (`:110`) |
| 8 | `tracker-sync-check.mjs:152-156` | **hardcoded** `:133-146` | plain `toLowerCase` | yes | passthrough (treated as unrecognised) |
| 9 | `stats.mjs:54-59` | delegates to #2, then title-cases | — | via #2 | `'Unknown'` |
| 10 | `dedup-tracker.mjs:88-94` + `STATUS_RANK:47-61` | **hardcoded rank table** | plain `toLowerCase` | yes (`:91`) | rank 0 (`:107`) |
| 11 | `plugins/notion/_notion.mjs:39-43` | states.yml labels+aliases, **not ids** (`:30-35`) | plain `toLowerCase` | **no** | `null` |

Also `invite-match.mjs:132-138` (`normalizeStatusKey`, cleaning only, its own rank table
`:120-130`) and `application-answers.mjs:36-42` (unrelated vocabulary — answer states, not
tracker states).

### Canonical pick

**#1 `resolveCanonicalState` + `foldStatusInput` (`tracker-utils.mjs:660-684`)**, driven by
`templates/states.yml`. Justification: it is the only implementation whose alias table is the
declared source of truth (`templates/states.yml:2-3` says both systems MUST use these), the
only one with correct Turkish case folding (`tracker-utils.mjs:645-658` documents the U+0307
defect), and the strict/null contract composes — `normalize-statuses.mjs:99` and
`followup-cadence.mjs:122` already delegate to it. The lenient
"unknown → Evaluated" variant that `merge-tracker.mjs:180` needs should be a wrapper, not a
second table.

### DIVERGENCE

**D5.1 — hardcoded alias tables have no Turkish aliases; states.yml has 20 of them.**
`templates/states.yml:19,25,30,36,42,48,54,60,66` define `mülakat`, `teklif`, `başvuruldu`,
`reddedildi`, `değerlendirildi`, `iptal edildi`, `uygun değil`, `kabul edildi`, `yanıt verildi`
and their dotless variants. Implementations #5, #6, #7, #8, #10 carry none of them.

Input `Mülakat` (a real states.yml alias for Interview):
- #1/#2/#3/#4 → `Interview` / `interview`
- #6 `verify-pipeline.mjs:130` → **prints `❌ Non-canonical status "Mülakat"` and increments the error count** — the validator fails a legal value
- #7 `analyze-patterns.mjs:110` → falls to `'pending'`, so an active interview is counted as not-yet-actioned
- #8 `tracker-sync-check.mjs:155` → unrecognised, so `compareLifecycle` (`:196`) reports Tier-2 "not comparable"
- #10 `dedup-tracker.mjs:107` → rank **0**, i.e. `isAdvancedStatus` false (`:126`), so the row loses its protection and a fuzzy-title dedup may **delete an active interview row**
- #5 `merge-tracker.mjs:180` → warns and rewrites the cell to `Evaluated` — silent stage regression

**D5.2 — Turkish uppercase breaks every implementation except the three using `foldStatusInput`.**
JS lowercases `İ` (U+0130) to `i` + U+0307. `foldStatusInput` strips the mark
(`tracker-utils.mjs:672`). Input `TEKLİF` (Offer):
- #1/#2 (and #3 via `:99`) → `Offer`
- #4 `tracker.mjs:153` → `null` (row dropped from the SQLite sync)
- #11 `plugins/notion/_notion.mjs:42` → `null` (property omitted on export)
- #5 → `Evaluated` (regression), #6 → error, #10 → rank 0

**D5.3 — `contratado`/`hired` coverage is inconsistent.**
`tracker-sync-check.mjs:133-146` has **no** `contratado`/`contratada`/`accepted` entries, while
`analyze-patterns.mjs:~89`, `verify-pipeline.mjs:66` and `merge-tracker.mjs:171` all map them to
Hired. Input `Contratado` → `tracker-sync-check` treats the row as an unrecognised status and
cannot compare its lifecycle position; every other reader sees a landed job.

**D5.4 — `normalize-statuses.mjs` has behaviour no other implementation has.**
`normalize-statuses.mjs:83` maps a bare `—`, `-` or empty status cell to **`Discarded`**;
`:48-50` and `:80` map `DUPLICADO…`/`Repost…` to `Discarded` and move the original text to
Notes. Every other implementation treats `—` as unknown/empty. Running
`npm run normalize` therefore silently discards every row whose status cell is a placeholder.

**D5.5 — unknown-input contract differs four ways.**
`null` (#1, #4, #11) vs passthrough of the raw folded token (#2, #7, #8) vs `'Evaluated'` (#5)
vs `'Unknown'` (#9) vs `{unknown:true}` (#3). Any consolidation must pick one; #5's default is
the only one that *writes* its guess back to the tracker (`merge-tracker.mjs:180-181`).

**D5.6 — `plugins/notion/_notion.mjs:30-35` indexes labels and aliases but not `id`.**
`tracker-utils.mjs:680` matches on `id` too. Input `skip` is fine (it is also an alias,
`templates/states.yml:66`), but any future state whose `id` is not repeated in `aliases`
resolves to `null` in the Notion export and to a label everywhere else.

---

## Capability 6 — Dedup keys

### 6a. Posting-URL key — 4 implementations

| # | Location | Strategy | Params |
|---|---|---|---|
| 1 | `url-key.mjs:55-93` `normalizeUrl` | **denylist**, force https, lowercase host only, sort query, drop fragment + one trailing slash | strips `utm_*`, `gh_src`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `igshid`, `_hsenc`, `_hsmi`, `trk`, `trackingid` (`:43-45`) |
| 2 | `scan.mjs:1053-1070` `normalizeUrlForDedup` | **allowlist**, keeps scheme as-is, **lowercases the path**, drops fragment + all trailing slashes | strips `language`,`lang`,`locale`,`utm_*`,`ref`,`src`,`source`,`gh_src`,`lever-origin`,`lever-source`,`rltr` (`:1019-1024`) |
| 3 | `discover-ats.mjs:402-404` | trim + `toLowerCase()` + strip trailing slashes; no URL parsing | none |
| 4 | `web/src/lib/core/url-key.mjs:46` | declared byte-mirror of #1 (`:2-3,20`) | same list (`:34`) |
| 5 | `plugins.mjs:74-81` | **no normalisation at all** — raw regex capture `\S+` into a Set | — |

`providers/yourator.mjs:118-121` additionally strips `utm_*` from the URL it *emits*.

### Canonical pick

**`url-key.mjs:55` `normalizeUrl`.** It is the only one with a written rationale tied to
RFC 3986 §6 and an explicit asymmetry argument (`url-key.mjs:6-36`), the only one that returns
`''` for a non-URL rather than a lowercased stand-in (`:33-35, :65-72`) — which is what stops
every `N/A` row sharing a key — and it is already the tracker merge's natural key
(`merge-tracker.mjs:28,1036-1073`). The scanner's extra strips (`locale`, `rltr`) are real and
should be added to it as a scanner-scoped extension, not kept as a second function.

### DIVERGENCE

**D6.1 — the scanner and the merge disagree on whether two URLs are the same posting.**
Input `https://boards.example.com/jobs/123?ref=partner`:
- `scan.mjs:1053` strips `ref` → same key as `…/jobs/123`; the posting is treated as already
  seen and never enters the inbox.
- `url-key.mjs:55` keeps `ref` (deliberately, `:24-27`) → a different key; `merge-tracker.mjs:1039`
  will not match it against the existing tracker row and creates a duplicate.
The two keys are the two ends of the same pipeline, and they resolve the same input opposite ways.

**D6.2 — path case.**
`scan.mjs:1063` lowercases `pathname`; `url-key.mjs` does not (only `hostname`, `:76`). Input
`https://x.com/Jobs/ABC` vs `https://x.com/jobs/abc` → one key in the scanner, two in the merge.

**D6.3 — unparsable input.**
`scan.mjs:1057-1058` returns the raw string; `url-key.mjs:66-72` returns `''` explicitly so
callers cannot match `''` to `''`. Input: two tracker rows whose URL cell is `N/A` → the
scanner's history dedup treats them as the same key, the merge treats them as keyless.

**D6.4 — `plugins.mjs` dedups on raw strings.**
`plugins.mjs:78` adds the literal captured token to the Set. A plugin returning
`https://x.com/j/1?utm_source=slack` never matches the already-present
`https://x.com/j/1`, so plugin imports re-add postings the scanner already filtered.

**D6.5 — `web/src/lib/core/url-key.mjs` is a hand-maintained copy.**
`web/src/lib/core/url-key.mjs:2-3,20` states the requirement to keep it "byte-for-byte
aligned" with the root module. That is a manual invariant with no enforcing test found in
this pass. *(Confidence: medium — I did not exhaustively search `web/tests/` for a
cross-file equality assertion.)*

### 6b. Tracker-row dedup (company/role identity)

| # | Location | Key |
|---|---|---|
| 1 | `merge-tracker.mjs:1036-1073` | URL key first (`normalizeUrl`), then company (`normalizeCompany`) + fuzzy role, then report number (`:566+`) |
| 2 | `dedup-tracker.mjs:330-334` | `normalizeCompany(company)`, with a NUL-prefixed Via key when company is `?` (`:307-321`) |
| 3 | `scan.mjs:1499-1515` `companyRoleDedupKey` | `company::role` after a company canonicaliser (`:1251-1267`) and suffix stripping (`:1429-1494`) |
| 4 | `fingerprint-core.mjs:~60+` | 64-bit SimHash of the JD body, threshold 0.92 (`:29-30`), 90-day window (`:32`) |
| 5 | `discover-ats.mjs:415-430` | lowercased name **or** normalised careers_url/api |

Company key itself is shared: `normalizeCompany` (`tracker-utils.mjs:73-75`) delegates to
`normalizeTextKey` (`tracker-parse.mjs:434`) — this one **is** already consolidated, and the
comment at `tracker-utils.mjs:60-72` records the non-Latin data-loss bug (#2429) that forced it.

### DIVERGENCE

**D6.6 — the scanner's company key and the tracker's company key are different functions.**
`scan.mjs:1499-1515` applies its own alias map (`:1251-1267`) and legal-suffix stripping
(`:1429-1494`) on top; `dedup-tracker.mjs:332` and `merge-tracker.mjs` use bare
`normalizeCompany`. Input: `Acme Corp.` in the tracker vs `Acme` from an ATS feed → the
scanner suppresses it as already-seen (suffix stripped), the tracker dedup would have kept
them as two rows. The two answers are only consistent because the scanner's decision happens
first and is invisible downstream.

**D6.7 — status rank tables are duplicated and disagree.**
`dedup-tracker.mjs:47-61` ranks `rejected: 1` **above** `discarded: 0`/`skip: 0` and
`evaluated: 2`; `invite-match.mjs:120-130` ranks `evaluated: 3`, `offer: 4`, `rejected: 5`,
`discarded: 6`, `skip: 7` — i.e. ascending in the opposite sense, with rejected/discarded/skip
ranked *above* offer. Neither derives from `templates/states.yml`'s `terminal:` flags
(`templates/states.yml:9-15,47,53,59,65,71`), which `tracker-sync-check.mjs:128` does use.
Three orderings, one lifecycle.

---

## Capability 7 — `config/profile.yml` location and parsing

### Implementations (8)

| # | Location | Base | Env | Parser | Missing → |
|---|---|---|---|---|---|
| 1 | `theme-style.mjs:46-53` `readStyleTokens` | **CWD** (default arg `'config/profile.yml'`) | no | js-yaml | `{}` |
| 2 | `theme-style.mjs:83-90` `readCvSectionOrder` | **CWD** default | no | js-yaml | `[]` |
| 3 | `browser-extract.mjs:65-74` | script dir | no | js-yaml | `'mcp'` |
| 4 | `scan.mjs:74` | **CWD** | `CAREER_OPS_PROFILE` | js-yaml | — |
| 5 | `followup-cadence.mjs:28` | script dir | `CAREER_OPS_PROFILE` | js-yaml | — |
| 6 | `salary-gap.mjs:585-595` | script dir | no | js-yaml | `null` |
| 7 | `prepare-application.mjs:131-147` | script dir | no | **regex line matching** (`:135-138`) | `{}` |
| 8 | `openai-tailor.mjs:39,192` / `openai-eval.mjs:58,220` | script dir | no | raw text + js-yaml (`openai-tailor.mjs:328`) | warning |

### Canonical pick

**`browser-extract.mjs:65`'s shape** — script-dir anchored, js-yaml, try/catch to a documented
default — extended with the `CAREER_OPS_PROFILE` override that #4 and #5 honour, and anchored
to `resolveWorkspaceRoot()` rather than the script directory so a redirected tracker moves the
profile with it (`tracker-utils.mjs:129-142` argues exactly this for the PDF manifest).

### DIVERGENCE

**D7.1 — `theme-style.mjs` defaults to a CWD-relative path.**
`theme-style.mjs:46,83`. `generate-pdf.mjs:1200,1220,1295` correctly pass a workspace-anchored
path, but `generate-pdf.mjs:1531` calls `readStyleTokens()` **with no argument** on the
`opts.styleTokens` fallback path. Input: render from a directory other than the workspace root
via that path → no theme tokens, silently (the function swallows everything, `:51-53`).

**D7.2 — `CAREER_OPS_PROFILE` is honoured by 2 of 8 readers.**
`scan.mjs:74` and `followup-cadence.mjs:28` only. `salary-gap.mjs:585`,
`browser-extract.mjs:65`, `prepare-application.mjs:131`, `openai-eval.mjs:58` ignore it.

**D7.3 — `prepare-application.mjs` parses YAML with a regex.**
`prepare-application.mjs:135-138`: `new RegExp('^\\s*' + key + ':\\s*["\']?([^"\'\\n]+?)["\']?\\s*$', 'm')`.
Concrete failures no other reader has:
- `^\s*` is unanchored to nesting, so `pick('email')` returns the **first** `email:` at any
  indentation — a nested `references:\n  email: …` block wins over the top-level one.
- the value class excludes `'` and `"`, so `full_name: O'Brien` yields `O` (and
  `firstName`/`lastName` are then split from the truncated value, `:143-144`).
- a YAML block scalar or a flow list is silently truncated to its first line.
Every other reader uses `yaml.load`.

---

## Capability 8 — Markdown table row parsing

`tracker-parse.mjs` is genuinely consolidated: 26 root scripts import it
(`resolveColumns`/`parseTrackerRow`/`normalizeVia`/`normalizeTextKey`, exports at
`tracker-parse.mjs:161,175,189,400,434`), and `verify-pipeline.mjs:93-97` records the drift
that forced it.

Remaining independent parsers:
- `plugins.mjs:59-71` `parseMarkdownTable` — header-name keyed, `slice(1,-1)` on both header
  and cells.
- `tracker-sync-check.mjs:281` — strips leading/trailing `|` then splits.
- `upskill.mjs:298` — `split('|').map(trim).filter(Boolean)`.
- `process-quality.mjs:114`, `archive-posting.mjs:273`, `rank-pipeline.mjs:105`.

### DIVERGENCE

**D8.1 — `plugins.mjs:65` uses `slice(1, -1)`, the exact bug `rebuildRow` documents.**
`tracker-utils.mjs:40-47` spells out that `slice(1,-1)` drops the real last cell on a row
written without a trailing pipe. `plugins.mjs:65` does precisely that. Input: a tracker row
`| 5 | 2026-01-01 | Acme | SWE | 4/5 | Applied | ✓ | [12](…) | some note` (valid, no trailing
pipe) → the `notes` value is dropped from the plugin export snapshot, and because the header
is sliced the same way (`:61`) the column count can shift too.

**D8.2 — `upskill.mjs:298` uses `.filter(Boolean)`.**
An empty cell is removed rather than preserved as a positional slot, so every column after the
first blank one shifts left. Input: a row with an empty Score cell → Status is read from the
PDF column. *(Confidence: medium — I read the parse line, not the full consumer at
`upskill.mjs:290-320`; `upskill.mjs:394-396` uses the shared parser for the main tracker read,
so this affects only the secondary table parsed at `:298`.)*

---

## Consolidation summary — the eight canonical picks

| Capability | Canonical | Absorbs |
|---|---|---|
| Tracker path | `tracker-utils.mjs:109` | 12 others (§1) |
| Pipeline path | **new** `resolvePipelinePath` in `tracker-utils.mjs` | 8 (§2) |
| Tracker write | `tracker-utils.mjs:474` `openTrackerTransaction` | 6 unlocked/non-atomic writers (§3) |
| Missing-file contract | `{rows, loaded}` for readers; `CLI_EXIT` (`tracker-utils.mjs:694`) for CLIs | 15 contracts (§4) |
| Status normalisation | `tracker-utils.mjs:675` + `templates/states.yml` | 10 others (§5) |
| URL dedup key | `url-key.mjs:55` (+ scanner-scoped param extension) | 4 others (§6a) |
| Profile config | script-root-anchored js-yaml reader + `CAREER_OPS_PROFILE` | 8 (§7) |
| Row parsing | `tracker-parse.mjs` | 6 stragglers (§8) |

## Confidence

- All path/line citations were read directly in this session. High confidence.
- Divergence claims D1.1–D1.5, D2.1–D2.4, D3.1–D3.4, D4.1–D4.2, D5.1–D5.6, D6.1–D6.4,
  D6.6–D6.7, D7.1–D7.3, D8.1: derived from the code as read. High confidence on the code;
  the *runtime* consequences are reasoned from the code, not executed.
- D6.5 (web mirror untested) and D8.2 (`upskill.mjs:298`): medium confidence, flagged inline.
- Not covered in this pass: `test-all.mjs` (17 101 lines) — I did not check which of these
  divergences are already pinned by assertions there. That matters for the consolidation plan
  and should be a follow-up. Also not covered: `dashboard/` (Go) as a second reader of
  `templates/states.yml`, and the `data/*.tsv` writers beyond `scan-history.tsv`.
