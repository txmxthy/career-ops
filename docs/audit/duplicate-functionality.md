# Duplicate functionality

Every claim is a direct read of the cited line in this checkout. Nothing is inferred from
filenames. Where a prior agent's claim did not survive verification it is marked **CORRECTION**.

## What the headline numbers actually mean

The brief said "27 markdown-table parsers" and "84 argv parsers". Both are real, and both are
counts of *sites*, not of *algorithms*. Measured here:

| Claim | Sites | Distinct algorithms |
|---|---|---|
| Markdown table row parse | **27 root `.mjs`** (37 repo-wide, 81 call sites) | **11** |
| argv / flag parsing | **84 root `.mjs`** | 3 `flagValue` + 10 `parseArgs` + 3 `parseCliArgs` |
| `toEpochMs` in providers | 28 files | 1 algorithm, 27 copies |
| Slug generation | 43 files define a slug-ish function | 14 at root/web + 2 in `providers/` |

The site count is what makes the consolidation worth doing. The algorithm count is what makes
it dangerous: eleven table parsers that disagree cannot be replaced by one without deciding,
eleven times, whose behaviour survives. Those decisions are the `### DIVERGENCE` blocks below.

## Master summary

| Capability | Implementations | Canonical | Divergences |
|---|---|---|---|
| Markdown table row parse | 27 root sites / 11 algorithms | `tracker-parse.mjs` (see Part II) | escaped pipes, ragged rows, alignment row, trimming |
| argv / flag parsing | 84 root sites | `lib/cli-flags.mjs:29` | `--`-prefixed values, `null` vs `undefined` |
| Tracker path resolution | 12 | see Part III | env override, walk-up, default |
| Pipeline inbox path resolution | 8 | see Part III | — |
| Missing-file behaviour on read | 15 distinct contracts | see Part III | throw vs empty vs silent default |
| Status normalization | 7 | `followup-cadence.mjs:139` | 4: alias source, Turkish fold, return type, date regex |
| Company key | 5 | `tracker-parse.mjs:434` `normalizeTextKey` | 3: separator, script preservation, input type |
| URL key | 4 | `url-key.mjs:55` | 2: **path casing (HUMAN DECISION)**, empty-key contract |
| Lock-owner read | 4 | `pipeline-lock.mjs:76` | 1: `{inspected,owner}` vs bare `null` |
| "Today" | 3 forms / 21 root sites | `lib/local-today.mjs:28` | 1: UTC day vs local day |
| ISO date parse | 6 | see Part IV | — |
| Day-difference arithmetic | 5 | see Part IV | DST handling |
| Slug generation | 14 + 2 | see Part IV | separator, unicode, length cap |
| ASCII folding | see Part IV | see Part IV | **non-Latin script deletion** |
| `toEpochMs` | 27 copies | see Part IV | — |
| HTML → text | 7 | see Part IV | — |
| HTML escaping | 4 | see Part IV | — |
| ATS provider dispatch | 9 dispatch tables | see Part IV | — |
| PDF rendering | 3 + 1 test | **not a duplicate** — see Part IV | n/a |
| Embedded test harness | 27 `selfTest`, 34 `--self-test`, 17 `printSummary` | none exists | n/a |
| Provider file reader | 8 `function readFile` | none exists | 4 signatures |
| JS↔Go core logic | 3 | JS side | **none** — managed mirror, keep parity tests |

---

# Part I — Reconciled capabilities

## 1. Status normalization — 7 implementations, 4 alias sources

| Implementation | Signature | Alias source | Turkish fold | Date strip |
|---|---|---|---|---|
| `followup-cadence.mjs:139` | `(raw) -> string` | `statusAliasMap()` from `templates/states.yml` | yes (`foldStatusInput`) | `/\s+\d{4}-\d{2}-\d{2}.*$/` |
| `tracker.mjs:145` | `(raw, states) -> string\|null` | injected `states.byKey` | no | `/\(?\d{4}-\d{2}-\d{2}\)?/g` |
| `normalize-statuses.mjs:42` | `(raw) -> {status, moveToNotes?}` | hardcoded regex ladder | no | per-branch |
| `tracker-sync-check.mjs:152` | `(raw) -> string` | module-local `STATUS_ALIASES` | no | `/\s+\d{4}-\d{2}-\d{2}.*$/` |
| `analyze-patterns.mjs:95` | `(raw) -> string` | module-local `ALIASES` (`:80`) | no | `/\s+\d{4}-\d{2}-\d{2}.*$/` |
| `dedup-tracker.mjs:88` | `(status) -> string` | **none** | no | `/\s+\d{4}-\d{2}-\d{2}.*$/` |
| `invite-match.mjs:132` `normalizeStatusKey` | `(status) -> string` | n/a | not verified | not verified |

**Behaviour diff.** Only `followup-cadence.mjs:139` reads aliases from `templates/states.yml`, the
file `normalize-statuses.mjs:35` calls "canonical". `analyze-patterns.mjs:80` and
`tracker-sync-check.mjs:140` carry two independent hand-copies of the same Spanish alias table.
`dedup-tracker.mjs:88` has no alias map at all, so a Spanish-language tracker row reaches the
dedup ranker as an unrecognized status.

**Canonical: `followup-cadence.mjs:139`.** It is the only one that (a) sources aliases from
`templates/states.yml` rather than a copy and (b) degrades to identity rather than to a hardcoded
fallback table — `followup-cadence.mjs:130-133` states the reasoning: *"a fallback copy is the
same copy in disguise and drifts the same way."*

### DIVERGENCE

1. **Turkish dotted-İ.** `followup-cadence.mjs:140-142` folds `İ` -> `i` because JS lowercases it
   to `i` + U+0307 and *"every all-caps Turkish row missed every alias (#2704 review)"*. The other
   five use a bare `.toLowerCase()`. Same input, two answers.
2. **Return type.** `tracker.mjs:145` returns `null` on an unrecognized status; the others return
   the cleaned input string. A caller written against one and passed the other silently changes
   from "unknown status" to "status named `<garbage>`".
3. **Date regex.** `tracker.mjs:149` uses `/\(?\d{4}-\d{2}-\d{2}\)?/g` (global, unanchored, strips
   parenthesised dates anywhere); the other five use `/\s+\d{4}-\d{2}-\d{2}.*$/` (trailing only).
   `Applied (2026-01-02) — recruiter` folds differently under the two.
4. **Shape.** `normalize-statuses.mjs:42` returns an object with a `moveToNotes` side channel
   (`:50`). It cannot be swapped for any of the others without a caller change.

---

## 2. Company key — 5 implementations, 3 signatures, non-equal outputs

| Implementation | Body | `"Acme Inc"` -> |
|---|---|---|
| `company-funded.mjs:388` | `compact(name).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()` | `"acme inc"` |
| `rejection-latency.mjs:164` | NFKC, lowercase, `.replace(/[^\p{L}\p{N}]/gu,'')` | `"acmeinc"` |
| `fingerprint-core.mjs:184` | delegates to `normalizeTextKey` (`tracker-parse.mjs:434`) | `"acmeinc"` |
| `detect-reposts.mjs:198` | takes a **row**; `row.normCompany \|\| normalizeCompanyName(row.company) \|\| raw.toLowerCase()` | n/a — different input type |
| `process-quality.mjs:172` | `findColumn(row,'company').trim()` — case-preserving, no folding | `"Acme Inc"` |

**Canonical: `tracker-parse.mjs:434` `normalizeTextKey`.** It is the only implementation with a
documented safety property. `tracker-parse.mjs:449-457` explains the Turkish-İ strip; `:458-463`
explains why it uses NFKC and **not** NFD — decomposing first *"collapsed Żubr/Zubr, Ėmė/Eme and
Ġenerali/Generali"*. It also takes a `separator` argument (`:434`) so a caller wanting
space-separated keys gets them from the same rule rather than writing a second strip.

### DIVERGENCE

1. **`company-funded.mjs:388` strips non-ASCII letters.** `[^a-z0-9]+` deletes every
   non-Latin character. `fingerprint-core.mjs:172-179` documents this exact class of bug as #2500:
   *"アクメ株式会社, グロベックス合同会社 and Яндекс all keyed to '' and compared equal"*, causing
   genuinely different employers to be silently treated as one.
   `web/src/lib/core/normalize-text-key.mjs` restates the prohibition. `company-funded.mjs:388` is
   the surviving instance of the banned pattern.
2. **Separator.** `company-funded.mjs:388` keeps spaces; `rejection-latency.mjs:164` removes them.
   `"acme inc"` and `"acmeinc"` never compare equal across the two modules.
3. **Input type.** `detect-reposts.mjs:198` takes a row and prefers a stored `normCompany` column;
   `process-quality.mjs:172` does no folding at all. Neither is a drop-in for the other three.

**CORRECTION to the prior critic:** it listed four `companyKey` implementations. There are five —
`process-quality.mjs:172` was missed, and it is the only one that does no normalization whatsoever.

---

## 3. URL key — 4 implementations, 2 incompatible contracts

| Implementation | Unparseable input | Path case | Tracking params | Scheme |
|---|---|---|---|---|
| `url-key.mjs:55` | `''` (= NO KEY, contract at `:52-54`) | **preserved** | denylist at `:42-46`, remainder sorted | forced `https:` |
| `scan.mjs:1053` | **returns the raw string** (`:1055,:1059`) | **lowercased** (`:1067`) | `DEDUP_STRIP_PARAMS` | untouched |
| `discover-ats.mjs:402` | returns the trimmed lowercased string | lowercased | **none kept out** | untouched |
| `web/src/lib/core/url-key.mjs:46` | `''` | preserved | same denylist | forced `https:` |

**Canonical: `url-key.mjs:55`.** It is the only one that states a contract for the empty case
(`url-key.mjs:52-54`: *"'' means NO KEY — callers must treat it as unknown, never as a value that
can match another ''"*), the only one that rejects non-http schemes (`:70`), and the only one that
sorts the surviving query for order-independence (`:83`).

`web/src/lib/core/url-key.mjs` is a **sanctioned mirror, not unmanaged duplication** —
`web/src/lib/core/url-key.mjs:9-19` explains that the client bundle cannot resolve the core through
`careerOpsRoot()`, and `:21-22` names the parity test that fails the build on drift
(`web/tests/lib/url-key.test.mjs`, present). Do not consolidate it away.

### DIVERGENCE

1. **The empty-key contract is inverted.** `url-key.mjs:63-67` returns `''` for `"N/A"`, `"TBD"`,
   `local:jds/...` and free text, and forbids callers from matching two `''`s.
   `scan.mjs:1054` returns the input unchanged for the same strings, and
   `discover-ats.mjs:403` returns `"n/a"` — a **non-empty key that matches every other `"N/A"` row**.
   `discover-ats.mjs:406-414` states this value decides portal duplicates. Two placeholder rows
   therefore dedup against each other in `discover-ats.mjs` and do not in `url-key.mjs`.
2. **Path casing is a deliberate, documented disagreement — not an oversight.**
   `scan.mjs:1039-1041` argues *"Path casing is not meaningfully distinct for any provider these
   scanners target"* and lowercases at `:1067`. `web/src/lib/core/url-key.mjs:23-28` argues the
   exact opposite and calls path/query lowercasing *"exactly the over-normalization that collapsed
   two different Greenhouse postings ... into one dedup key"*. Both comments are in the tree, both
   cite real incidents, and they contradict each other. **This one needs a human decision before
   consolidation — do not silently pick a side.**

**CORRECTION to the prior critic:** it framed path-lowercasing as a `discover-ats.mjs` defect. It
is `scan.mjs`'s documented intent too (`scan.mjs:1039`), which makes this a genuine contract
conflict rather than a one-file bug.

---

## 4. Lock-owner read — the "#2984 fix" landed in 1 of 4 copies

| Implementation | Returns | Live callers |
|---|---|---|
| `pipeline-lock.mjs:76` | `{inspected: boolean, owner: object\|null}` | `:202, :311, :396, :593, :615` |
| `portal-health-lock.mjs:75` | bare `object\|null` | `:220` |
| `tracker-utils.mjs:244` | bare `object\|null` | `:360, :379` |
| `followup-seed.mjs:291` | bare `object\|null` | `:364` |

**Canonical: `pipeline-lock.mjs:76`.** `pipeline-lock.mjs:60-75` states the safety property: ENOENT
is a *fact* (there genuinely is no stamp — which happens by construction between `mkdir` and the
`owner.json` write), whereas any other error code is *"absence we merely failed to observe"*. On
Windows a live holder's stamp is momentarily unreadable, and collapsing that into the same `null`
*"lets the age rule condemn a lock that is very much alive."*

### DIVERGENCE

All three other copies collapse both cases into `null` (`portal-health-lock.mjs:76-80`,
`tracker-utils.mjs:245-249`, `followup-seed.mjs:292-296`) and are live at the call sites listed
above. They therefore still carry the #2984 defect on Windows.

**The in-tree comments overstate what was fixed.** `portal-health-lock.mjs:90-95`,
`tracker-utils.mjs:257-263` and `followup-seed.mjs:299-304` each claim *"The recovery judgment
comes from pipeline-lock rather than a fourth copy of it"* and specifically say the copy *"predated
#2984."* The import covers only the **verdict**: `pipeline-lock.mjs` exports 14 symbols
(`:38, :48, :56, :105, :128, :140, :151, :197, :198, :199, :201, :252, :331, :635`) and
`readLockOwner` is not among them — it is module-private at `:76`. A reader trusting those comments
concludes the drift is cured. It is not.

**Consolidation:** export `readLockOwner` from `pipeline-lock.mjs` and delete the three copies.
Lowest-risk item on this page: 3 deletions, 1 added export, 4 call sites to widen to
`{inspected, owner}`.

---

## 5. "Today" — `lib/local-today.mjs` adoption is ~45%, not ~60%

`lib/local-today.mjs:4-13` exists to kill `new Date().toISOString()`-as-today, citing #2765
(*"at 20:00 US Eastern this returned the next calendar day"*) and #2932 (east of Greenwich the
user's own today reads as a future date). `lib/local-today.mjs:14-17` scopes it deliberately: only
"what day is it here" belongs there; date *arithmetic* stays on UTC-midnight parsing.

**Adopters (9 root .mjs + 1 lib + 2 test files):** `assessment-log.mjs:32`,
`check-table-freshness.mjs:58`, `company-history.mjs:60`, `followup-cadence.mjs:20`,
`followup-seed.mjs:74`, `funnel-velocity.mjs:46`, `scan.mjs:58`, `set-status.mjs:97`, plus
`set-status-tests.mjs:33` and `tests/local-today-gates.test.mjs:27`.

**Still on the defective form — 13 root non-test sites, verified individually:**

`new Date().toISOString().slice(0, 10)` (8): `application-answers.mjs:45`, `fix-slugs.mjs:279`,
`generate-pdf.mjs:1052`, `scan-ats-full.mjs:687`, `scan-hn.mjs:116`, `scan-interamt.mjs:260`,
`stats.mjs:516`, `tracker.mjs:305`.

`new Date().toISOString().split('T')[0]` (5 non-eval-runner): `analyze-patterns.mjs:1257`,
`archive-posting.mjs:181`, `openai-tailor.mjs:340`, `outcome.mjs:56`, plus `test-all.mjs:6520`.

Plus 5 in the LLM eval runners: `batch-evaluate-gemini.mjs:273`, `gemini-eval.mjs:403`,
`ollama-eval.mjs:369`, `openai-eval.mjs:399`, `openrouter-runner.mjs:531` and `:667`.

Two of these define a private `today()` helper of exactly the shape the lib replaced —
`archive-posting.mjs:180-182` and `outcome.mjs:55-57` — and both feed persisted artefacts:
`archive-posting.mjs:190` builds the capture filename, `outcome.mjs:368` and `:383` write dated
entries into `outcome.md`. Meanwhile `followup-cadence.mjs:148-156` carries the *fix plus the
explanatory comment*, so the correct and defective variants sit in the same repo, in files that
call each other.

### DIVERGENCE

Not a behavioural disagreement between implementations — a **partial migration**. All 13+5 sites
answer a different calendar day than the 9 adopters for up to 19 hours of every day depending on
the host's offset.

**CORRECTION to the prior critic (two counts):** it said *"13 files import it"* and *"19 root call
sites still use the defective form."* Measured: **11 files contain the import statement**
(9 root non-test + 1 test + 1 test-generator string), and **13 root non-test sites** use the
defective form, rising to 18 if the five eval runners are counted. The critic's list also included
`company-history.mjs` as an adopter (correct, `:60`) but omitted `check-table-freshness.mjs:58`
and `funnel-velocity.mjs:46`. Its named site list was accurate for every line it cited; the
aggregate numbers were not.

---

## 6. CLI flag parsing — 3 `flagValue`, one behaviourally different

| Implementation | `--flag=v` checked first | Rejects `--`-prefixed value | Miss returns |
|---|---|---|---|
| `lib/cli-flags.mjs:29` | yes (`:32-34`) | no | `undefined` |
| `weekly-digest.mjs:96` | yes (`:97-99`) | no | `undefined` |
| `tracker.mjs:373` | **no** — `indexOf` first (`:374`) | **yes** (`:375`) | `null` |

`lib/cli-flags.mjs:31-32` and `weekly-digest.mjs:97-98` carry the *identical* comment explaining
the ordering: *"indexOf() cannot see it, so checking it second would let the space-separated lookup
fall through and drop the value."*

**Canonical: `lib/cli-flags.mjs:29`.** It is the only one that null-guards its input (`:30`),
and it is the only one paired with `hasFlag` (`:52`), which `lib/cli-flags.mjs:41-49` documents as
necessary because `flagValue` alone *"cannot tell an ABSENT flag from one supplied without a value
— for `test-all --only` that meant running the whole suite instead of refusing a filter it could
not honour."*

### DIVERGENCE

1. `tracker.mjs:375` rejects any value beginning with `--`. `node tracker.mjs --status --applied`
   yields `null` there and the literal `"--applied"` from the other two.
2. `tracker.mjs:376` returns `null` on a miss where the others return `undefined` — differs under
   `??`, `Object.hasOwn`, and strict equality checks.
3. **`weekly-digest.mjs` already imports from the shared module and then re-implements the function
   anyway.** `weekly-digest.mjs:47` imports only `validateFlags`, and `weekly-digest.mjs:45-46`
   states the reason: *"this module keeps its own flagValue (see below), so importing the shared one
   too would shadow it."* The two bodies are equivalent. This is a pure, self-documented duplication
   with no behavioural justification — the cheapest single deletion in the audit.

**CORRECTION to the prior critic:** it wrote that `lib/cli-flags.mjs` is *"imported by 39 root
files."* Measured: **27 import sites for `./lib/cli-flags.mjs`**, in **29 root files** that mention
it. The figure 39 is the baseline's count of root files importing from `./lib/` **at all** — across
all seven lib modules (`cli-flags` 27, `local-today` 9, `context-budget` 3, `latex-content` 2,
`latex-escape` 1, `gemini-node-floor` 1, `ascii-fold` 1). Confirmed independently: 39 root .mjs
contain `from './lib/`.

---

## 7. Embedded test harness — a whole duplicated layer

Counts over root `.mjs`: **27** files define `runSelfTest`/`selfTest`; **34** handle a
`--self-test` flag; **17** define `printSummary`; **10** define `parseArgs`; **3** define
`parseCliArgs`; **8** define `function readFile` (`test-all.mjs:67`, `ollama-eval.mjs:143`,
`openrouter-runner.mjs:162`, `batch-evaluate-gemini.mjs:87`, `openai-tailor.mjs:168`,
`openai-eval.mjs:204`, `gemini-eval.mjs:164`, `lib/golden-budget-analysis.mjs:34`) with four
different signatures — `(path)`, `(path,label)`, `(relPath)`, `(path,label,required)`.

**Canonical: none exists.** `lib/cli-flags.mjs` covers flag parsing only; there is no shared
assertion, summary-printing or file-reading module. The 10 `parseArgs` and 3 `parseCliArgs`
definitions coexist with 27 imports of `lib/cli-flags.mjs`, so the shared module is being adopted
for `flagValue`/`validateFlags` while argument *shaping* is still rewritten per script.

Highest raw LOC payoff, lowest per-site risk (self-test code is not on the user's data path). The
six LLM provider runners (`batch-evaluate-gemini.mjs`, `gemini-eval.mjs`, `ollama-eval.mjs`,
`openai-eval.mjs`, `openai-tailor.mjs`, `openrouter-runner.mjs`) duplicate a whole provider layer
— `readFile`, `today`, arg parsing and summary printing each appear once per runner.

---

## 8. JS↔Go — three mirrored capabilities, no divergence found

A duplication audit scoped to `.mjs` cannot see these. The Go dashboard re-implements:

- **Tracker lock derivation** — `dashboard/internal/data/tracker_lock.go:87`:
  *"trackerLockDirFor mirrors tracker-utils.mjs exactly so Go and Node writers contend on the same
  lock directory."* Algorithm at `tracker_lock.go:89-111` vs `tracker-utils.mjs:206-219`.
- **Tracker column detection** — `dashboard/internal/data/career.go:597` *"Mirrors HEADER_ALIASES
  in tracker-parse.mjs"*; `career.go:618-619` and `:630` mirror `detectColumns`. Parity is
  test-guarded: `dashboard/internal/data/career_test.go:357,366`.
- **Funnel stats** — `dashboard/internal/data/career.go:937` and `:954`, *"matching computeFunnel()
  in stats.mjs"*; also `progress_metrics_test.go:28`.

### DIVERGENCE

**None found.** I verified the lock derivation by hand and the two agree: JS
`createHash('sha256').update(appsFile).digest('hex').slice(0,16)` (`tracker-utils.mjs:207`) is the
same 8 bytes as Go `fmt.Sprintf("%x", sum[:8])` (`tracker_lock.go:99`); `canonicalPath`
(`tracker_lock.go:68-77`, `filepath.Abs` then `EvalSymlinks` with a `Clean` fallback) matches
`canonicalizeTrackerPath` (`tracker-utils.mjs:168-175`, `resolve` then `realpathSync` with an
absolute-path fallback); both apply the same three env-override guards (absolute, inside temp,
correct prefix) — `tracker_lock.go:105-110` vs `tracker-utils.mjs:212-218`.

This is **managed** duplication: a mirror in a second language, with the invariant stated at the
mirror site and, for two of the three, a parity test. Consolidation is not available (Go cannot
import `.mjs`). The correct action is to keep the parity tests, not to remove the copy. Listed here
so a future audit does not "discover" it as unmanaged drift.

**Confidence: high** on the lock derivation (read both bodies line by line). **Medium** on
`computeFunnel` and `detectColumns` — I read the Go comments and the parity tests exist, but I did
not diff the two funnel implementations line by line.

---



---

# Part II — Text parsing detail (tables, argv)

### CAPABILITY 1 — Markdown table: split a row into cells

### Implementations (11 distinct algorithms)

| # | Site | Algorithm |
|---|---|---|
| 1 | `tracker-parse.mjs:191` (`parseTrackerRow`) | `line.split('|').map(trim)`, keeps leading `''`, dynamic width guard at `:199` |
| 2 | `tracker-utils.mjs:52` (`rebuildRow`) | inverse: `parts.slice(1)`, pops trailing cell only if `''` |
| 3 | `web/src/lib/tracker-table.mjs:66` (`trackerCells`) | `split("|").map(trim)` then `slice(1, endsWith('|') ? -1 : undefined)` |
| 4 | `plugins.mjs:61,65` (`parseMarkdownTable`) | `split('|').slice(1,-1).map(trim)` — **unconditional** `-1` |
| 5 | `process-quality.mjs:109-115` (`parseActiveInterviews`) | `trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(trim)` |
| 6 | `tracker-sync-check.mjs:281` (`parseActiveInterviewsWithLines`) | byte-identical to #5 plus line numbers |
| 7 | `stats.mjs:335` / `stats.mjs:395` | `split('|').map(trim)`, `parts.length < 8` guard, positional |
| 8 | `followup-cadence.mjs:426` (`parseFollowups`) | same as #7, different field mapping |
| 9 | `reply-watch.mjs:125` (`loadFollowups`) | same as #7 again |
| 10 | `followup-seed.mjs:247` (`hasFollowupTableRow`) | same as #7 again, only reads `parts[2]` |
| 11 | `scan.mjs:1964` (`parseBlacklist`) | `split('|').map(trim)`, positional 1–4, own header/separator sniffs |

Plus positional pipe-splitters over **non-table** pipe-delimited lines (different
grammar, same primitive): `rank-pipeline.mjs:105`, `reconcile-pipeline.mjs:191,223`,
`scan.mjs:1194`, `archive-posting.mjs:273`, `upskill.mjs:298`,
`analyze-patterns.mjs:751`, `scan-ats-full.mjs:210`, `providers/hackernews.mjs:89`,
`providers/workable.mjs:285`, `providers/rheinmetall.mjs:76`.

And in-place row rewriters that all round-trip through `rebuildRow`:
`dedup-tracker.mjs:394,416`, `normalize-statuses.mjs:153/185`, `set-status.mjs:496/527`,
`mark-pdf-ready.mjs:162/165`, `sync-pdf-flags.mjs:102/106`, `reply-watch.mjs:199/201`.
Plus `merge-tracker.mjs` which does **not** use `rebuildRow`: it has its own
`buildRow` (`merge-tracker.mjs:535`), `buildHeaderRows` (`:550-551`), a Via-migration
writer (`:790-791`), and its own row reader `parseAppLine` (`:565`).

### Behavioural diff — concrete inputs

Input A — row without trailing pipe: `| 7 | Acme | great note`
- #1 `parseTrackerRow`: width = maxIdx+1, row parses, notes preserved (`tracker-parse.mjs:199`).
- #2 `rebuildRow(['','7','Acme','great note'])` → `| 7 | Acme | great note |` (`tests/tracker-utils.test.mjs:29`).
- #3 `trackerCells`: `slice(1, undefined)` → notes preserved.
- **#4 `plugins.mjs:65`: `slice(1,-1)` DROPS `great note`.** Documented as the #2369
  defect at `web/src/lib/tracker-table.mjs:69-71`; `plugins.mjs` still has it.
- #5/#6: `.replace(/\|$/,'')` is a no-op here → cells correct.

Input B — cell containing a literal pipe. No reader anywhere unescapes `\|`.
Only escape-on-write is `company-funded.mjs:829` (`.replace(/\|/g,'\\|')`).
`tracker-utils.mjs:93` `cell()` instead **rewrites** `|` → ` / ` and explicitly
documents why backslash-escaping is refused (`tracker-utils.mjs:84-88`).
→ A `company-funded`-produced cell containing `\|` splits into two cells in every
reader above and shifts all later columns.

Input C — separator row `|:---:|---|`. Six different predicates:
- `tracker-parse.mjs:75` `/^\|(?:\s*:?-+:?\s*\|)+\s*$/` — strict, whole-row.
- `plugins.mjs:64` `/^\|[\s|:-]+\|?$/` — no trailing-whitespace tolerance.
- `stats.mjs:382` `/^\|[\s|:-]+\|?\s*$/` — same but tolerates trailing space.
- `process-quality.mjs:117` + `tracker-sync-check.mjs:282` `cells.every(/^:?-+:?$/)` — per-cell.
- `merge-tracker.mjs:785` and `tracker.mjs:182,213` `/^[-: ]*$/.test(parts.join(''))`.
- `scan.mjs:1966` `/^[-: ]+/` on the **company cell only**.
Differences that bite: a separator written `| --- | --- |` (spaces inside cells)
fails `process-quality.mjs:117`/`tracker-sync-check.mjs:282` (`' --- '` ≠ `/^:?-+:?$/`
after… actually cells are trimmed, so it passes) but a row of `| — | — |` (em dashes,
which `merge-tracker.mjs:526` writes as the empty-cell filler) **passes**
`merge-tracker.mjs:785`'s `/^[-: ]*$/`? No — em dash U+2014 is not in `[-: ]`, so it
fails there but the ASCII `-` filler at `merge-tracker.mjs:790` (`c || '---'`) passes.
Confidence: medium-high (static reading, not executed).

Input D — ragged row (missing interior cell).
- #1 rejects (full-width requirement, `tracker-parse.mjs:196-200`).
- #3 rejects (`web/src/lib/tracker-table.mjs:135`, `cells.length < mappedWidth`).
- **`verify-pipeline.mjs:103` and `merge-tracker.mjs:567` use `parts.length <= MAX_IDX`
  — coverage of the highest index only, not full width.** A row missing an interior
  cell passes there and is read one column shifted. This is exactly the #2369 class
  that #1 and #3 were hardened against; the two merge/verify readers were not.
- #5/#6 reject on `cells.length !== colCount`.
- `plugins.mjs:68` accepts any non-empty row and pads with `''`.

Input E — header matching.
- #1 `isHeaderRow` (`tracker-parse.mjs:126`): requires **all five** of
  `num, company, role, score, status` to resolve via `tracker-aliases.json`, case-folded.
- #3 `detectColumnMap` (`web/src/lib/tracker-table.mjs:83`): same five, same aliases,
  but **degrades to legacy order on a missing/corrupt alias file**
  (`web/src/lib/tracker-table.mjs:62`), whereas #1 **throws** (`tracker-parse.mjs:39-44`).
  Deliberate and documented (`tracker-parse.mjs:30-33`).
- #4 `plugins.mjs:61`: first pipe line is the header, no validation.
- #5/#6: first table line is the header, no validation.
- `scan.mjs:1967`: header detected by the literal string `company` in cell 1 — a real
  company named "Company" is dropped.
- `tracker.mjs:182,213`: header detected by `parts[colmap.num] === '#'` — a localized
  header (`| Núm | …`) is **not** recognized, the very case
  `tracker-parse.mjs:106-113` documents as #2274.

Input F — empty cells: #1/#3 keep `''`; **`upskill.mjs:298` and
`analyze-patterns.mjs:751` apply `.filter(Boolean)` after the split**, so an empty
Gap/Severity cell silently shifts `cols[1]`/`cols[2]` left — severity read from
mitigation. Both parse the same Gap table with the same regex
(`upskill.mjs:295`, `analyze-patterns.mjs:746`); it is one algorithm in two files.

Input G — multi-line cells: unsupported everywhere (all readers are line-oriented).
No divergence.

### Canonical pick

**`tracker-parse.mjs` (+ `tracker-utils.mjs:52 rebuildRow`) for the tracker table.**
Justification: most callers — 14 importers of `tracker-parse.mjs`
(`funnel-velocity, stats, company-history, tracker, sync-pdf-flags, invite-match,
reserve-report-num, find, verify-pipeline, followup-seed, reply-watch,
normalize-statuses, scan, merge-tracker`); best tested (`test-all.mjs:10502-10542`,
`:11307`, `:11901`, `:13980`, `:15348`, `tests/tracker-utils.test.mjs`); most complete
(alias table, full-width guard, score/status-by-content disambiguation at
`tracker-parse.mjs:145`).

**For generic markdown tables there is no canonical implementation.** Nominate
`process-quality.mjs:93-136 parseActiveInterviews` promoted to `lib/markdown-table.mjs`
with an optional line-number output — it is the only generic parser that validates
column count and is already the acknowledged source for the
`tracker-sync-check.mjs` copy (`tracker-sync-check.mjs:257-263`).

---

### DIVERGENCE — table parsing

**D1. `plugins.mjs:61,65` drops the last cell of any row without a trailing pipe.**
`slice(1,-1)` unconditional. Every other current reader (`tracker-parse.mjs:199`,
`web/src/lib/tracker-table.mjs:67`, `tracker-utils.mjs:53`) was fixed for this (#2369).
Consolidating `plugins.mjs` onto the shared splitter **changes its output**: rows that
currently lose their final column will start carrying it.

**D2. Width guard: `<= MAX_IDX` vs full width.**
`verify-pipeline.mjs:103` and `merge-tracker.mjs:567` accept ragged rows that
`tracker-parse.mjs:200` and `web/src/lib/tracker-table.mjs:135` reject. Moving
`verify-pipeline`/`merge-tracker` to `parseTrackerRow` will make previously-parsed
rows disappear from their entry lists — changing `verify-pipeline`'s error counts and
`merge-tracker`'s duplicate detection and `usedNumbers` set (`merge-tracker.mjs:895-905`).

**D3. `.filter(Boolean)` in `upskill.mjs:298` / `analyze-patterns.mjs:751`.**
Empty gap-table cells are deleted, not preserved. Both files then read `cols[0..2]`
positionally. Consolidating onto a non-filtering splitter shifts severity/mitigation
for any row with an empty cell. Currently the two agree with each other and disagree
with every other reader.

**D4. Missing alias file: throw vs degrade.**
`tracker-parse.mjs:39` throws; `web/src/lib/tracker-table.mjs:62` returns `{}` and falls
back to legacy fixed order. Deliberate (documented `tracker-parse.mjs:30-33`) — a
consolidation must keep both behaviours, not pick one.

**D5. Header detection by `'#'` literal.**
`tracker.mjs:182` and `tracker.mjs:213` use `parts[colmap.num] === '#'`. A localized or
aliased header (`Num`, `Núm`) is treated as a data row. `tracker.mjs:42` already imports
`resolveColumns` from `tracker-parse.mjs` but not `isHeaderRow`.

**D6. Escaped pipes are write-only.**
`company-funded.mjs:829` emits `\|`; nothing unescapes it. `tracker-utils.mjs:93`
`cell()` uses an incompatible strategy (` / ` substitution). Two different escaping
contracts in one repo; picking one changes existing file contents.

**D7. `merge-tracker.mjs` writes rows through its own `buildRow` (`:535`),
not `rebuildRow`.** `buildRow` pads to `HEADER_WIDTH` and fills unmapped cells with
`—` (`merge-tracker.mjs:526`, `:817-821`); `rebuildRow` preserves whatever cells it
was handed. Unifying the writers changes what merge-tracker emits for trackers with
unmapped extra columns.

**D8. `tracker-sync-check.mjs:257-263` is a knowingly-maintained hand-mirror of
`process-quality.mjs:93-136`** — the comment instructs future editors to copy changes
by hand. Confirmed byte-level near-identical by diff; only the line-number capture and
whitespace differ.

---

### CAPABILITY 2 — argv / flag parsing

### Implementations

**Shared:** `lib/cli-flags.mjs` — `flagValue` (`:31`), `hasFlag` (`:55`),
`validateFlags` (`:91`). Tested by `tests/cli-flags.test.mjs` and
`tests/cli-flag-validation.test.mjs`. 29 root files import it.

**Hand-rolled near-clones of `validateFlags`** (same variable names, same
`consumedValueIndices` set, same error string):
- `company-history.mjs:121-199` (`parseArgs`)
- `discover-ats.mjs:906-966` (`parseArgs`)
- `assessment-log.mjs:288-315` (`main`)
- `scan-ats-full.mjs:264` retains a local `valueOf` alongside its `validateFlags` call (`:55`, `:257`)

**Hand-rolled `flagValue` clones:**
`company-history.mjs:146`, `discover-ats.mjs:928`, `scan-ats-full.mjs:264`,
`agent-inbox.mjs:134` (`opt(name, def)`), `tracker.mjs:373-377`.

**Bare `args.indexOf('--flag')` value reads — the #2401 defect shape, still live
(20 sites):**
`plugins.mjs:313`, `analyze-patterns.mjs:63`, `analyze-patterns.mjs:70`,
`intake.mjs:419`, `intake.mjs:457`, `extract-latex-content.mjs:23`,
`doctor.mjs:54`, `doctor.mjs:62`, `verify-portals.mjs:704`, `verify-portals.mjs:710`,
`scan-interamt.mjs:53`, `invite-match.mjs:91`, `invite-match.mjs:106`,
`tracker-sync-check.mjs:77`, `tracker-sync-check.mjs:81`, `salary-gap.mjs:42`,
`scan.mjs:371`, `paste-reply.mjs:209`, `upskill.mjs:876`, `upskill.mjs:1004`,
`match-star.mjs:26`, `match-star.mjs:28`, `seed-fixture.mjs:108`,
`agent-inbox.mjs:135`.

**Ad-hoc `--flag=value`-only parsers (the mirror-image defect — space form dropped):**
- `generate-pdf.mjs:1093-1099`: `arg.startsWith('--format=')` etc. `--format html`
  (space form) is silently ignored.
- `cv-templates.mjs:169-171`: `a.replace(/^--/,'').split('=')` — a flag with no `=`
  yields `undefined` value.
- `check-liveness.mjs:39-40`: accepts both, but `Number(split('=')[1]) || 5000` means
  `--throttle` bare → 5000, and `--throttle=0` → 5000 (falsy-zero bug).

**Own dispatchers:** `outcome.mjs:90-135`, `set-status.mjs:135-175`,
`mark-pdf-ready.mjs:59-70`, `application-answers.mjs:340-366`,
`company-funded.mjs:100-120`, `openrouter-runner.mjs:801-803` (`[,,command,...args]`),
`reserve-report-num.mjs:299` (`const [,,cmd,arg]`), `plugins.mjs:346`,
`tracker.mjs:554`, `sync-pdf-flags.mjs:30`, `gemini-eval.mjs:82-142`,
`jd-skill-gap.mjs:371-374`, `build-cv-html.mjs:688-705`, `eval-golden.mjs:55-64`.

### Behavioural diff — concrete inputs

`--flag=value` vs `--flag value`:
- `lib/cli-flags.mjs:31 flagValue`: both. `=` checked first (`:35`) so the space form
  cannot shadow it.
- `discover-ats.mjs:928 valueOf`: both, **but space form is checked first** and
  requires the next token to be truthy and not start with `--`. `--in "" --in=x`
  → returns `''`? No: `args[idx+1]` is `''` (falsy) so it falls through to the `=`
  form and returns `x`. `lib/cli-flags` returns `x` too (finds `=` first). Agrees.
- `company-history.mjs:146 valueOf`: `=` first, identical to `lib/cli-flags`.
- `doctor.mjs:54,62`: `indexOf` only. **`node doctor.mjs --target=/some/path` passes
  `validateFlags` at `doctor.mjs:52` (it strips at `=` and `--target` is in
  `VALUE_FLAGS`) and then `projectRoot` falls back to `__dirname`** — the exact
  silent-wrong-input defect `lib/cli-flags.mjs:7-14` was written to end, in the file
  that imports the fix. Same shape at `--cli=opencode` (`doctor.mjs:62`), which is
  the invocation `OPENCODE.md:5` documents. Confidence: high (static; the `=` branch
  exists nowhere in `doctor.mjs`).
- `salary-gap.mjs:42`, `match-star.mjs:26,28`, `tracker-sync-check.mjs:77,81`,
  `analyze-patterns.mjs:63,70`, `invite-match.mjs:91,106`, `scan-interamt.mjs:53`,
  `paste-reply.mjs:209`, `seed-fixture.mjs:108`, `verify-portals.mjs:704,710`:
  `=` form silently ignored → default used.

Short flags: only `-h` is recognized anywhere (`lib/cli-flags.mjs:147`). No script
supports clustered or single-dash flags. `assessment-log.mjs:308` and
`company-history.mjs:139` treat **any** `-`-prefixed token as a flag candidate;
`lib/cli-flags.mjs:110` does the same. No divergence.

Negative-number operands (`--since -5`):
- `lib/cli-flags.mjs:100-105`: exempted via `consumedValueIndices`, only when the
  flag is listed in `valueFlags`.
- `company-history.mjs:131-137`, `discover-ats.mjs:915-920`,
  `assessment-log.mjs:298-305`: same rule, hand-copied.
- Every bare-`indexOf` site: no exemption logic at all, but also no unknown-flag
  check, so the operand is simply consumed. Different failure mode, same result.

`--help` ordering:
- **`lib/cli-flags.mjs:145` checks `--help` LAST**, after unknown-flag and
  missing-operand checks — documented at `:74-77` as a CodeRabbit-caught bug.
- **`company-history.mjs:123-127`, `discover-ats.mjs:908-912` and
  `assessment-log.mjs:290-294` check `--help` FIRST.**
  → `node company-history.mjs --help --bogus` exits **0** printing usage;
  `node fix-slugs.mjs --help --bogus` exits **1** (`tests/cli-flag-validation.test.mjs:61-65`).
  The three hand-rolled copies carry the bug the shared helper documents as fixed.

`--help` presence: `application-artifacts.mjs`, `generate-cover-letter.mjs`,
`normalize-statuses.mjs`, `sync-pdf-flags.mjs`, `prepare-application.mjs`,
`analyze-patterns.mjs`, `salary-gap.mjs` have **no `--help`/`-h` handling at all**
(no match for `--help` in their argv blocks).

Boolean flags with a value: `company-history.mjs:193-198` explicitly rejects
`--emit-signal=true`. **`lib/cli-flags.mjs:112` also rejects it** (the
`a.includes('=') && !valueFlags.includes(flag)` clause) — so this hand-rolled guard is
redundant, but only because of a clause added later. `assessment-log.mjs:308` and
`discover-ats.mjs:921` use `!KNOWN_FLAGS.includes(a.split('=')[0])` with **no**
`=`-on-boolean rejection → `assessment-log.mjs --summary=false` is accepted and
ignored; `discover-ats.mjs --write=false` is accepted and **turns writing on**
(`discover-ats.mjs:960` is `args.includes('--write')` — false — so actually it stays
off, and the user's intent is met by accident). Confidence: medium — not executed.

Repeated flags: `lib/cli-flags.mjs:35` `.find()` → **first** `=`-form wins;
`:37` `indexOf` → **first** space-form wins. `discover-ats.mjs:929` `indexOf` first
→ first space-form wins, but if only `=` forms are repeated, `.find` → first.
`scan.mjs` has its own `requireValue()` at `scan.mjs:2345` that explicitly reports a
repeated flag (referenced by `lib/cli-flags.mjs:135-137`). Every bare-`indexOf`
site silently takes the first.

Unknown-flag behaviour: `lib/cli-flags.mjs:114-117` exits 1 and lists valid flags.
`outcome.mjs:130`, `set-status.mjs:174`, `mark-pdf-ready.mjs:66` call a local
`failUsage`. The 20 bare-`indexOf` sites **silently ignore** unknown flags.

Positional handling:
- `discover-ats.mjs:954`: `!a.startsWith('-') && !consumedValueIndices.has(idx)`.
- `match-star.mjs:36-38`: excludes operands **by index**, explicitly to keep repeated
  question text (`match-star.mjs:33` comment).
- `jd-skill-gap.mjs:374`: `args.find(a => !a.startsWith('--'))` — first non-flag,
  **no operand exclusion**, so `--top 5 jd.txt` picks `5` as the JD path.
  Confidence: high (no `consumedValueIndices` equivalent exists in the file).
- `plugins.mjs:254,311`: `!a.startsWith('--')`, same defect shape.
- `intake.mjs:459`: `args.slice(commitIdx+1).filter(a => !a.startsWith('--'))`.

### Canonical pick

**`lib/cli-flags.mjs`.** Most callers (29 root files), only implementation with
dedicated tests (`tests/cli-flags.test.mjs`, `tests/cli-flag-validation.test.mjs`,
`tests/scan-flag-forms.test.mjs`), most complete (both forms, unknown-flag rejection,
`valueFlags` adjacency, opt-in `requireOperand`, correct `--help` ordering), and the
only one whose semantics are documented with the defect IDs they close.

---

### DIVERGENCE — argv

**A1. `--help` ordering inverted in three hand-rolled copies.**
`company-history.mjs:123`, `discover-ats.mjs:908`, `assessment-log.mjs:290` check
`--help` before unknown flags. `lib/cli-flags.mjs:145` checks it last, deliberately
(`lib/cli-flags.mjs:74-77`). Migrating these three flips
`<script> --help --bogus` from exit 0 to exit 1.

**A2. `doctor.mjs` calls `validateFlags` then reads values with bare `indexOf`.**
`doctor.mjs:52` vs `doctor.mjs:54` and `doctor.mjs:62`. `--target=<path>` and
`--cli=<name>` validate as recognized and are then discarded. `--cli=opencode` is the
form `OPENCODE.md:5` tells agents to use. **This is a live bug, not just duplication.**

**A3. `check-liveness.mjs:40` — `Number(...) || 5000`.**
`--throttle=0` yields 5000. Any consolidation onto `flagValue` + explicit
`Number.isFinite` changes this to 0.

**A4. `generate-pdf.mjs:1093-1099` accepts only the `=` form; `analyze-patterns.mjs:63`
and 18 sibling sites accept only the space form.** They are mirror-image halves of the
same parser. Consolidating makes both forms work everywhere — which is the point, but
it means invocations that currently fall back to defaults will start taking effect.
`generate-pdf.mjs --max-pages 3` currently does nothing; after consolidation it caps
pages. That is an output change for any caller relying on the current silent default.

**A5. `assessment-log.mjs:308` / `discover-ats.mjs:921` accept `--boolean=value`;
`lib/cli-flags.mjs:112` rejects it.** Migration turns a currently-silent no-op into
exit 1.

**A6. `jd-skill-gap.mjs:374` and `plugins.mjs:254,311` pick positionals without
excluding flag operands.** `lib/cli-flags.mjs` has no positional API at all — a
consolidation must add one, and adding it changes which token these scripts treat as
the positional.

**A7. `company-history.mjs:163-170` rejects empty-string values
(`--company ""`, `--company=`); `lib/cli-flags.mjs`'s `requireOperand`
(`:129-133`) does NOT** — it only checks for a missing token or a following `--flag`.
Migrating `company-history.mjs` loses the empty-string rejection unless
`requireOperand` is extended.

**A8. `scan.mjs:2345 requireValue()` is deliberately NOT migrated** — documented at
`lib/cli-flags.mjs:135-140`: it distinguishes five conditions the shared message
cannot. Any "consolidate everything" pass must leave it alone.

---

### Uncertainty

- Nothing in this report was executed; all claims are from reading source. The
  behavioural predictions (D1–D8, A1–A8) are static inferences. Confidence high for
  the ones where the missing branch demonstrably does not exist in the file
  (D1, A1, A2, A4); medium for the ones depending on operator precedence in
  multi-clause guards (D3 separator em-dash case, A5).
- `test-all.mjs` (17101 lines) was sampled by grep, not read end to end; there may be
  additional assertions pinning behaviours listed above as untested.
- The bare-`indexOf` census used a fixed regex (`args\.indexOf\('--`); a site using a
  variable flag name or `argv.indexOf(FLAG)` would be missed. Medium-high confidence
  on completeness.

---

# Part III — Data access detail (paths, locks, missing-file contracts)

### Capability 1 — Tracker path resolution (`applications.md`)

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

### Capability 2 — Pipeline inbox path resolution (`data/pipeline.md`)

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

### Capability 3 — Pipeline/tracker WRITE: atomicity, locking, backup

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

### Capability 4 — Missing-file behaviour on tracker read

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

### Capability 5 — Status normalisation

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

### Capability 6 — Dedup keys

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

### Capability 7 — `config/profile.yml` location and parsing

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

### Capability 8 — Markdown table row parsing

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

### Consolidation summary — the eight canonical picks

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

### Confidence

- All path/line citations were read directly in this session. High confidence.
- Divergence claims D1.1–D1.5, D2.1–D2.4, D3.1–D3.4, D4.1–D4.2, D5.1–D5.6, D6.1–D6.4,
  D6.6–D6.7, D7.1–D7.3, D8.1: derived from the code as read. High confidence on the code;
  the *runtime* consequences are reasoned from the code, not executed.
- D6.5 (web mirror untested) and D8.2 (`upskill.mjs:298`): medium confidence, flagged inline.
- Not covered in this pass: `test-all.mjs` (17 101 lines) — I did not check which of these
  divergences are already pinned by assertions there. That matters for the consolidation plan
  and should be a follow-up. Also not covered: `dashboard/` (Go) as a second reader of
  `templates/states.yml`, and the `data/*.tsv` writers beyond `scan-history.tsv`.

---

# Part IV — Domain utilities detail (dates, slugs, folding, rendering, dispatch)

### 0. Prior art: `lib/` already exists and is the pattern

Two capabilities have already been consolidated into `lib/` and the modules carry
the reasoning in-file:

- `lib/ascii-fold.mjs:54` `asciiFold(value, {punctuation})` — 2 importers
  (`verify-portals.mjs:35`, `providers/_trust-validator.mjs:19`).
- `lib/local-today.mjs:27` `localToday(now)` — 9 importers
  (`scan.mjs:58`, `set-status.mjs:97`, `followup-seed.mjs:74`, `followup-cadence.mjs:20`,
  `company-history.mjs:60`, `funnel-velocity.mjs:46`, `assessment-log.mjs:32`,
  `check-table-freshness.mjs:58`, `set-status-tests.mjs:33`).
- `providers/_html-entities.mjs` — 31 importers; its header (`providers/_html-entities.mjs:1-33`)
  documents **four** separate rounds of re-duplication before the guard test landed.
- `providers/_html-to-text.mjs:28` — only **3** importers
  (`providers/greenhouse.mjs`, `providers/recruitee.mjs`, `providers/smartrecruiters.mjs`).

The consolidation precedent is established and the tests to enforce it exist. What
follows is the work that was never finished.

---

### 1. "What day is it" (today as `YYYY-MM-DD`)

### Implementations — 3 distinct algorithms, 20+ call sites

| # | Impl | Location | Semantics |
|---|---|---|---|
| A | `localToday()` | `lib/local-today.mjs:27` | **Local** calendar day via `getFullYear/getMonth/getDate` |
| A' | `today()` → `new Date(localToday())` | `company-history.mjs:253`, `followup-cadence.mjs:148` | local day, re-anchored at UTC midnight |
| A'' | `todayStr()` → `localToday()` | `followup-seed.mjs:114` | thin alias |
| B | `new Date().toISOString().slice(0,10)` | `archive-posting.mjs:180-182`, `outcome.mjs:55-57`, `tracker.mjs:305`, `generate-pdf.mjs:1052`, `application-answers.mjs:45`, `scan-ats-full.mjs:687`, `scan-interamt.mjs:260`, `scan-hn.mjs:116`, `stats.mjs:516`, `company-funded.mjs:953`, `plugins/apify/index.mjs:135` | **UTC** day |
| C | `new Date().toISOString().split('T')[0]` | `openrouter-runner.mjs:531,667`, `gemini-eval.mjs:403`, `openai-eval.mjs:399`, `ollama-eval.mjs:369`, `batch-evaluate-gemini.mjs:273` | UTC day (B by another spelling) |

### DIVERGENCE

**D1 — B/C disagree with A by one whole day for half the planet's clock.**
`lib/local-today.mjs:4-15` states the defect (#2765, #2932, #3070) explicitly.
Concrete: host at `America/New_York`, wall clock `2026-06-20 20:00`.
- A → `2026-06-20`
- B/C → `2026-06-21`

This is not cosmetic; it is written into user-visible artifacts:
- `archive-posting.mjs:190` — capture filename `2026-06-21_acme_engineer.pdf`, dated tomorrow.
- `outcome.mjs:368,383` — the outcome-log `**Date**:` field and the `## Entry:` header,
  which are the primary-source timestamps other reports trace back to.
- `generate-pdf.mjs:1052` — the PDF manifest row date.
- `tracker.mjs:305` — a `today` value fed into the SQLite index rebuild.

**D2 — the same repo file can be on both sides.** `scan.mjs:1493` (dedupe key) uses
`localToday()` via `scan.mjs:993`, while `scan.mjs:778`, `scan.mjs:1749` and
`scan.mjs:409` still emit `toISOString().slice(0,10)` for other date fields.

**D3 — `new Date(localToday())` is not the same object as `localToday()`.**
`company-history.mjs:259` and `followup-cadence.mjs:156` return a `Date` at UTC
midnight of the local day. A consolidation that swaps them for a bare `localToday()`
string changes the return type of an exported function (`company-history.mjs:253` is
`export function today()`).

### Canonical
`lib/local-today.mjs:27` `localToday()`. Justification: most callers (9 importers),
only implementation with an injectable `now` (`lib/local-today.mjs:27`) so it is
testable, has a dedicated test file (`tests/local-today-gates.test.mjs`) plus a
web-side source-level gate (`web/tests/lib/pipeline-local-today.test.mjs:53`) that
fails the build when a new UTC-day expression appears. B and C are the defect.

---

### 2. ISO date parse + validate (`YYYY-MM-DD` → `Date`)

### Implementations — 6

| # | Location | Anchor | Rejects rollover? |
|---|---|---|---|
| 1 | `funnel-velocity.mjs:87` `parseISODate` | `T00:00:00Z` | **No** — only `isNaN` |
| 2 | `followup-cadence.mjs:159` `parseDate` | `new Date(s)` (spec: UTC) | Yes, round-trip |
| 3 | `rejection-latency.mjs:130` `parseDate` | `T00:00:00Z` | Yes, round-trip |
| 4 | `detect-reposts.mjs:141` `parseDate` | `T00:00:00Z` | Yes, round-trip |
| 5 | `check-table-freshness.mjs:105` `parseDate` | `T00:00:00Z` | Yes, round-trip |
| 6 | `scan.mjs:979` `daysBetweenIsoDates` (inline) | `T00:00:00Z` | Yes, round-trip |

3, 4 and 5 are byte-equivalent modulo `|| ''` vs `?? ''` on the coercion
(`rejection-latency.mjs:131` / `detect-reposts.mjs:142` vs `check-table-freshness.mjs:106`).
`followup-seed.mjs:129` `isValidCalendarDate` delegates to #2.

### DIVERGENCE

**D4 — `funnel-velocity.parseISODate` accepts impossible calendar dates.**
Input `"2026-02-31"`:
- `funnel-velocity.mjs:87` → a valid `Date` for **2026-03-03**.
- All five others → `null`.

`funnel-velocity.mjs:93-97` then computes `daysBetween` off that rolled-over date, so a
typo'd ledger row silently shifts a stage duration by 3 days instead of being dropped.
`followup-cadence.mjs:163-166` documents exactly this class of failure as the reason its
own round-trip check exists.

**D5 — `|| ''` vs `?? ''` on the input coercion.** `String(0)` is `'0'` for
`check-table-freshness.mjs:106` (`?? ''`) and `''` for `rejection-latency.mjs:131`
(`|| ''`). Both then fail the regex, so no observable difference today — noted as a
consolidation footgun only. **Confidence: high, but low impact.**

### Canonical
`check-table-freshness.mjs:105`. Reason: explicit `T00:00:00Z` anchor (unlike #2, which
relies on the ES date-only-string spec), round-trip validation, `?? ''` coercion, and it
ships alongside `addMonthsUTC` (`check-table-freshness.mjs:118`) — i.e. it is the
version already sitting in a date-arithmetic module rather than bolted onto a report script.

---

### 3. Day-difference arithmetic (`daysBetween`)

### Implementations — 5

| # | Location | Signature | Rounding | Normalizes to UTC midnight? |
|---|---|---|---|---|
| 1 | `funnel-velocity.mjs:93` | `(fromStr, toStr)` strings | `Math.round` | via `parseISODate` |
| 2 | `followup-cadence.mjs:382` | `(d1, d2)` Dates | `Math.floor` | **No** |
| 3 | `rejection-latency.mjs:149` | `(d1, d2)` Dates | **none — fractional** | **Yes**, `Date.UTC(getUTC*)` |
| 4 | `detect-reposts.mjs:149` | `(d1, d2)` Dates | `Math.round` | **No** |
| 5 | `scan.mjs:979` `daysBetweenIsoDates` | `(start, end)` strings | `Math.floor` | via inline parse |

Plus one test-local copy at `detect-reposts.test.mjs:137` and one at
`tests/fingerprint-core.test.mjs:54`.

### DIVERGENCE

**D6 — three different answers for the same pair of instants.**
`d1 = 2026-06-01T00:00:00Z`, `d2 = new Date()` at `2026-06-11T18:00:00Z`
(this is the real shape: a parsed posting date vs. wall-clock now):
- `followup-cadence.mjs:383` (`floor`) → **10**
- `detect-reposts.mjs:150` (`round`) → **11**
- `rejection-latency.mjs:151` (UTC-midnight normalize, no rounding) → **10**

`rejection-latency.mjs:146-148` documents the trap explicitly ("subtracting raw timestamps
and rounding would tip the count one day early after noon UTC") — and
`detect-reposts.mjs:150` is the code it is describing.

**D7 — return type is not integral in #3.** `rejection-latency.mjs:151` returns a
`number` that is fractional whenever either argument is not UTC-midnight; every other
impl returns an integer. `rejection-latency.mjs:289,311` consume it directly.

**D8 — same exported name, incompatible signature.** `funnel-velocity.mjs:93`
`export function daysBetween(fromStr, toStr)` takes **strings**;
`followup-cadence.mjs:382` `export function daysBetween(d1, d2)` takes **Dates**.
Both are exported. A naive merge silently breaks one of them (`Date - Date` works,
`string - string` is `NaN`).

### Canonical
`rejection-latency.mjs:149`, generalized to accept either strings or Dates and to
`Math.round` the (now exact) integer. It is the only one that is correct for a
mixed midnight-vs-wall-clock pair, which is the majority call shape
(`company-history.mjs:410`, `followup-cadence.mjs:776`, `scan.mjs:1002` all compare a
parsed date against "now"). #2 and #4 are the ones that drift.

---

### 4. Slug generation

### Implementations — 14 at root/web + 2 in providers

| # | Location | Charset rule | Separator | Cap | Empty fallback | Unicode |
|---|---|---|---|---|---|---|
| 1 | `archive-posting.mjs:171` | `[^\w\s-]` deleted, then `[\s_]+`→`-` | `-` | **60** | `''` | none (`\w` = ASCII) |
| 2 | `outcome.mjs:46` | same as 1 | `-` | **60** | `'unknown'` | none |
| 3 | `application-artifacts.mjs:20` | `[^a-z0-9]+`→`-` | `-` | — | param, dflt `'application'`/`'role'` | none |
| 4 | `contacts.mjs:163` | `[^a-z0-9]+`→`-` | `-` | — | `''` | none |
| 5 | `company-history.mjs:758` | `[^a-z0-9]+`→`-` | `-` | — | `''` | none |
| 6 | `gemini-eval.mjs:213` | `[^a-z0-9]+`→`-` | `-` | — | `'unknown'` | none |
| 7 | `batch-evaluate-gemini.mjs:100` | `[^a-z0-9]+`→`-` | `-` | — | `'unknown'` | none |
| 8 | `web/src/lib/pdf-paths.mjs:18` | `[^a-z0-9]+`→`-` | `-` | — | `''` | none |
| 9 | `discover-ats.mjs:162` `deriveSlug` | `[^a-z0-9]+`→`-` | `-` | — | `''` | none |
| 10 | `plugins/apify/index.mjs:71` | `[^a-z0-9]+`→`-` | `-` | **80** | `jd-<sha1[0:10]>` | none |
| 11 | `company-funded.mjs:157` `companySlug` | `&`→` and `, `[^a-z0-9]+`→**deleted** | none | — | `''` | none |
| 12 | `providers/phenom.mjs:98` | NFKD + strip `[̀-ͯ]`, `[^a-zA-Z0-9]+`→`-` | `-` | — | `'job'` | partial |
| 13 | `providers/tkms.mjs:61` | **identical to 12** | `-` | — | `'job'` | partial |
| 14 | `verify-portals.mjs:171` `deriveSlugCandidates` | `asciiFold()` then joins | `''`/`-`/`_` (all 3) | — | `[]` | **full** |
| 15 | `providers/join.mjs:26`, `providers/smartrecruiters.mjs:79`, `providers/rippling.mjs:27`, `providers/workable.mjs:127`, `providers/jobvite.mjs:127` | slug *extractors*, not generators | — | — | — | — |

`providers/phenom.mjs:98-104` and `providers/tkms.mjs:61-67` are **byte-identical
function bodies** — a straight copy/paste with a different comment above it.

### DIVERGENCE

**D9 — five different slugs for one company name.** Input `"Société Générale"`:

| Impl | Output |
|---|---|
| `archive-posting.mjs:171` / `outcome.mjs:46` | `socit-gnrale` |
| `application-artifacts.mjs:20`, `contacts.mjs:163`, `company-history.mjs:758`, `gemini-eval.mjs:213`, `batch-evaluate-gemini.mjs:100`, `web/src/lib/pdf-paths.mjs:18`, `discover-ats.mjs:162`, `plugins/apify/index.mjs:71` | `soci-t-g-n-rale` |
| `company-funded.mjs:157` | `socitgnrale` |
| `providers/phenom.mjs:98` / `providers/tkms.mjs:61` | `societe-generale` |
| `verify-portals.mjs:171` | `societegenerale`, `societe-generale`, `societe_generale`, `societe`, … |

Only #14 (via `lib/ascii-fold.mjs`) produces the slug an ATS board actually uses.
`lib/ascii-fold.mjs:11-16` names this exact company as the bug (#2924/#2930).

**D10 — `\w` vs `[a-z0-9]` is not the same class.** `\w` includes `_`.
Input `"C_plus_plus Engineer"`:
- `archive-posting.mjs:171` keeps `_` past the first pass then `[\s_]+`→`-` → `c-plus-plus-engineer`
- `contacts.mjs:163` → `c-plus-plus-engineer` (same, by a different route)
- `company-funded.mjs:157` → `cplusplusengineer`

Input `"Acme_Corp"` (no spaces): #1 → `acme-corp`; #11 → `acmecorp`. Same company, two keys.

**D11 — length caps are inconsistent and silently truncate mid-word.**
`archive-posting.mjs:177` and `outcome.mjs:52` cap at 60; `plugins/apify/index.mjs:75`
caps at 80; every other impl is uncapped. A 70-char role title produces a *different*
directory name in `application-artifacts.mjs:37` than the filename in
`archive-posting.mjs:190` for the same application. `outcome.mjs:52` applies
`|| 'unknown'` **after** `.slice(0,60)`, so a 60-char string of pure punctuation
yields `'unknown'` while `archive-posting.mjs:177` yields `''` — and
`archive-posting.mjs:190` then builds `2026-06-20__.pdf`.

**D12 — CJK names collapse to a shared key, differently per impl.**
Input `"株式会社アクメ"`:
- `archive-posting.mjs:171` → `''` → filename `2026-06-20__engineer.pdf`
- `outcome.mjs:46`, `gemini-eval.mjs:213`, `batch-evaluate-gemini.mjs:100` → `'unknown'`
  (every Japanese company shares one slug)
- `application-artifacts.mjs:20` → `'application'` (**collides with the fallback for a
  missing company**, `application-artifacts.mjs:20`)
- `plugins/apify/index.mjs:71` → `jd-<sha1>` — the only impl that stays distinct
- `providers/phenom.mjs:98` → `'job'`

**D13 — case handling for case-sensitive boards.** `discover-ats.mjs:162` lowercases
unconditionally and `discover-ats.mjs:156-158` warns that this misses camelCase Ashby
boards (`AlephAlpha`, `DeepL`); `discover-ats.mjs:86` then re-lowercases per-vendor
only for subdomain vendors, deliberately *not* globally. Any consolidation that
lowercases everywhere breaks Ashby.

### Canonical
Two functions, not one — the repo already knows they are different questions
(`lib/ascii-fold.mjs:14-21`):

- **Filesystem/display slug** → promote `application-artifacts.mjs:20` `slugifySegment`
  into `lib/`, adding an `asciiFold` pre-pass and an explicit `maxLength` option.
  It is the only impl with a parameterized fallback, it is exported, and it is the one
  whose output is a stable on-disk contract (`application-artifacts.mjs:37`).
- **ATS-target slug** → `verify-portals.mjs:171` `deriveSlugCandidates` /
  `lib/ascii-fold.mjs:54`. Already correct, already tested
  (`tests/ascii-fold-punctuation.test.mjs`), and its docstring
  (`verify-portals.mjs:181-198`) encodes a safety rule (`firstWordSuffixes:false` on
  write paths) that no other impl knows about.

`providers/phenom.mjs:98` and `providers/tkms.mjs:61` should both import one
`slugifyTitle` — they are literally the same function.

---

### 5. ASCII folding / Unicode normalization

This is the densest cluster: **13 normalizers, 5 mutually incompatible policies.**

### Implementations

| # | Location | Normal form | Mark handling | Non-decomposing Latin (ø æ ß đ ł ı ŋ þ ð ħ ŧ ĸ œ ſ) |
|---|---|---|---|---|
| A | `lib/ascii-fold.mjs:54` | NFD | strip all `\p{M}` | **handled** (`lib/ascii-fold.mjs:38-43`) |
| B | `providers/phenom.mjs:98`, `providers/tkms.mjs:61` | NFKD | strip `[̀-ͯ]` | not handled |
| C | `generate-pdf.mjs:222` `foldDiacritics` | NFD | strip `[̀-ͯ]` | **only `ł`** (`generate-pdf.mjs:226`) |
| D | `liveness-core.mjs:7` `normalizeForMatch` | NFD | strip `[̀-ͯ]` | not handled; also folds smart quotes; **does not lowercase** |
| E | `role-matcher.mjs:102` `normalizeTitle` | NFD → NFC | strip only `(?<=[a-z])\p{Mn}` | not handled |
| F | `detect-reposts.mjs:297` `titleIdentityKey` | NFD | strip **all** `\p{Mn}` | n/a (`[^\p{L}\p{N}]`→space) |
| G | `tracker-parse.mjs:434` `normalizeTextKey` | NFKC | **keep** `\p{M}`, strip only `U+0307` | n/a (keeps all letters) |
| G' | `web/src/lib/core/normalize-text-key.mjs:27` | mirror of G | mirror | mirror |
| H | `tracker-utils.mjs:660` `foldStatusInput` | NFKC | strip only `U+0307` | n/a |
| H' | `web/src/lib/status-alias.mjs:110` `foldStatus` | mirror of H | mirror | n/a |
| I | `rejection-latency.mjs:164` `companyKey` | NFKC | strip all via `[^\p{L}\p{N}]` | n/a |
| J | `invite-match.mjs:177` `normalizeCompanyName` | NFKC | **keep** `\p{M}` | n/a |
| K | `contacts.mjs:173` `normalizeForHash` | NFC | **keep everything** (deliberate) | n/a |
| L | `verify-cv-facts.mjs:148` `foldDigits` | NFKC | digits only — different capability | n/a |

G/G' and H/H' are intentional mirrors with a parity test
(`web/src/lib/core/normalize-text-key.mjs:14-16` claims `test-all §55.7` fails the
build on drift). Those two pairs are **not** a defect; they are a documented
web/CLI boundary. Everything else is unmanaged.

### DIVERGENCE

**D14 — A vs B/C/D on letters that NFD does not decompose.**
Input `"Đại Việt Engineer"`:
- `lib/ascii-fold.mjs:54` → `dai viet engineer` (`đ`→`d` at `lib/ascii-fold.mjs:40`)
- `providers/phenom.mjs:98` / `providers/tkms.mjs:61` → `ai-Vi-t-Engineer`… precisely:
  NFKD leaves `Đ` intact, then `[^a-zA-Z0-9]+`→`-` **deletes** it → `ai-Viet-Engineer`
- `generate-pdf.mjs:222` → `Đai Viet Engineer` (`Đ` survives, unmatched by its `ł`-only pass)

Same class for `Ørsted`, `Æon`, `Işık`, `Ħamrun`, `Ŋaro` — every one of which is
pinned as a *passing* assertion against A at `test-trust-validator.mjs:145-165`, and
every one of which B and C get wrong.

**D15 — `[̀-ͯ]` ≠ `\p{M}`.** B, C and D use the Combining Diacritical Marks
block only. `\p{M}` (A) and `\p{Mn}` (E, F) cover Combining Diacritical Marks
Supplement (U+1DC0–1DFF), Extended (U+1AB0–1AFF), and every non-Latin script's marks.
Concrete: a Devanagari or Arabic company name passed to `generate-pdf.mjs:222` keeps
its matras; passed to `lib/ascii-fold.mjs:54` it folds to `''`. Both may be
intentional in their own contexts — but nothing in the code says which is which, and
`generate-pdf.mjs:213-220` claims the pass exists "so a heading is recognized
regardless of how it was typed", which is A's contract, not C's behaviour.

**D16 — `detect-reposts.mjs` contradicts itself inside one file.**
`detect-reposts.mjs:198` `companyKey` → `invite-match.mjs:177`, which **keeps**
`\p{M}` and cites #2517 for doing so (`invite-match.mjs:186-192`).
`detect-reposts.mjs:297` `titleIdentityKey` **strips all `\p{Mn}`**
(`detect-reposts.mjs:300-301`) while its own comment at `detect-reposts.mjs:288-290`
appeals to "#2429 for company names" as the justification.
Concrete: Devanagari titles `कंपनी` and `कपनी` (differ only in the anusvara) key
**identically** at `detect-reposts.mjs:297`, so two distinct roles at one employer
cluster as a repost. `tests/fingerprint-core.test.mjs:296` pins exactly this pair as
a must-stay-distinct case for `fingerprint-core.mjs:185` — the same repo, the
opposite verdict.

**D17 — `rejection-latency.companyKey` drops marks; `normalizeTextKey` keeps them.**
`rejection-latency.mjs:165` uses `[^\p{L}\p{N}]` — `\p{M}` is neither `\p{L}` nor
`\p{N}`, so **every** combining mark is deleted. `tracker-parse.mjs:434` keeps them.
Concrete: `कंपनी` vs `कपनी` → `rejection-latency.mjs:165` gives one key for both;
`tracker-parse.mjs:434` gives two. `rejection-latency.mjs:154-156` claims it is
"the same normalization idea as tracker-parse.mjs's normalizeVia" — it is not.
Consequence: `rejection-latency.mjs:311` merges two employers' rejection latencies.
Confidence: **high** (read both regex classes directly).

**D18 — `role-matcher` vs `detect-reposts` on non-Latin marks.**
`role-matcher.mjs:114` strips a mark only when it follows an ASCII `[a-z]`;
`detect-reposts.mjs:301` strips unconditionally. Input `"Йогурт Engineer"`
(Cyrillic И + breve, decomposed): E → `йогурт engineer` (breve preserved, re-NFC'd
at `role-matcher.mjs:115`); F → `иогурт engineer`. Two title-matching subsystems
disagree on whether Й and И are the same letter. `role-matcher.mjs:107-113` names
this case as the bug it was fixed for.

**D19 — `liveness-core.normalizeForMatch` does not lowercase.**
`liveness-core.mjs:7-15` folds quotes and marks but never `.toLowerCase()`; every
consumer pattern at `liveness-core.mjs:17+` carries an `/i` flag instead. Folding
it into a shared normalizer that lowercases would be behaviour-preserving only if
every one of those patterns keeps `/i`. Flagged as a merge hazard, not a defect.
**Confidence: medium** — I did not enumerate all patterns below `liveness-core.mjs:17`.

### Canonical
Three canonical functions, because there are genuinely three questions
(the reasoning is already written down at `lib/ascii-fold.mjs:14-21` and
`tracker-parse.mjs:414-421`):

1. **Fold to an ASCII target** (hostnames, ATS slugs) → `lib/ascii-fold.mjs:54`.
   Most complete table, only one with a punctuation option, only one with dedicated
   tests (`tests/ascii-fold-punctuation.test.mjs`, `test-trust-validator.mjs:145-172`).
   B, C and D should all become callers.
2. **Identity key that must not merge distinct entities** → `tracker-parse.mjs:434`
   `normalizeTextKey`. Most callers (`scan.mjs:1495`, `set-status.mjs:463`,
   `fingerprint-core.mjs:185`, `verify-pipeline`), has a build-failing parity gate
   with its web mirror. `rejection-latency.mjs:164` (D17) and
   `detect-reposts.mjs:297` (D16) are the two that should be replaced by it.
3. **Status-alias fold** → `tracker-utils.mjs:660` `foldStatusInput`, mirrored at
   `web/src/lib/status-alias.mjs:110`. Already canonical; no action.

`contacts.mjs:173` (K) must **not** be folded in — `contacts.mjs:169-172` states the
UID contract requires accent preservation, and `contacts.mjs:324` asserts it.

---

### 6. Epoch-ms date coercion in providers (`toEpochMs`)

### Implementations — 27 copies

`providers/{teamtailor,personio,landingjobs,weworkremotely,higheredjobs,remotli,larajobs,himalayas,dassault,nodesk,ashby,joinup,gem,meituan,flowxtra,jobvite,amazon,jobspresso,jobstreet,oraclecloud,greenhouse,glints,4dayweek,consider,getro,comeet,a16z-speedrun-talent}.mjs`
each declare a private `toEpochMs`. `providers/oraclecloud.mjs:76` says "(copied from
greenhouse.mjs)" in the source.

Five behavioural variants:

| Variant | Members | Absent → | Numeric input | Epoch-seconds |
|---|---|---|---|---|
| V1 (17 files) | teamtailor:112, personio:50, weworkremotely:31, larajobs:35, higheredjobs:22, nodesk:31, jobspresso:34, ashby:113, glints:84, jobstreet:80, jobvite:114, flowxtra:48, oraclecloud:77, comeet:69, greenhouse:47, remotli:84, 4dayweek | `undefined` | `Date.parse(number)` → `NaN` → `undefined` | no |
| V2 | landingjobs:36, a16z-speedrun-talent:71 | `undefined` (also non-string) | rejected | no |
| V3 | joinup:22, getro:53, consider:33 | **`null`** | `<1e12`→×1000 | **yes** |
| V4 | himalayas:56 | `undefined` | `<1e12`→×1000 | yes, **and coerces numeric strings** |
| V5 | meituan:39 | `undefined` | `>1e12 ? v : v*1000` | yes, **strict `>`** |
| — | amazon:53, dassault:98, gem:76 | bespoke (field-specific / regex / seconds-only) | — | — |

### DIVERGENCE

**D20 — V3/V4 vs V5 disagree at exactly `1e12`.** Input `postedAt = 1000000000000`:
- `providers/joinup.mjs:27`, `providers/getro.mjs:58`, `providers/consider.mjs:38`,
  `providers/himalayas.mjs:58` (`value < 1e12 ? ×1000 : value`) → `1000000000000`
  = **2001-09-09**
- `providers/meituan.mjs:41` (`v > 1e12 ? v : v*1000`) → `1e15` = **year 33658**

A posting dated year 33658 passes every "is it newer than the cutoff" filter forever.

**D21 — V4 turns a numeric-looking date string into 1970.**
`providers/himalayas.mjs:61-62` runs `Number(value)` *before* `Date.parse`.
Input `"2024"` → `Number("2024")` = 2024 → `< 1e12` → `2024 * 1000` = **1970-01-01T00:33:44Z**.
Every other variant → `Date.parse("2024")` = **2024-01-01**. A posting with a
year-only date is dated 1970 on Himalayas and 2024 everywhere else.

**D22 — `null` vs `undefined` return contract.** V3 returns `null`
(`providers/joinup.mjs:23`), the other 24 return `undefined`. Consumers that do
`postedAt ?? fallback` behave the same; consumers that check `=== undefined` do not.
**Confidence: medium** — I did not audit every `postedAt` consumer in `scan.mjs`.

**D23 — V1 silently accepts a number and returns `undefined`.**
`Date.parse(1750000000000)` is `NaN` (Date.parse coerces to string `"1750000000000"`,
which is not a valid date string), so a provider whose upstream starts returning epoch
ms instead of ISO loses **every** `postedAt` with no error. V3/V4/V5 handle it.

### Canonical
`providers/joinup.mjs:22` / `providers/getro.mjs:53` / `providers/consider.mjs:33`
(V3, three identical copies) — extracted to `providers/_epoch.mjs`, with the return
changed to `undefined` to match the 24-file majority contract. V3 is the only variant
that handles the number case correctly, guards `<= 0`, and uses the non-ambiguous
`<` comparison. `providers/_html-entities.mjs:1-33` is the precedent and the header
there already predicts this exact failure mode.

---

### 7. HTML → text

### Implementations — 7

| # | Location | script/style removal | Double-decode | Length cap | Block→newline |
|---|---|---|---|---|---|
| 1 | `providers/_html-to-text.mjs:28` (shared, 3 importers) | yes | **yes** | **4000** (`:11`) | no |
| 2 | `providers/agentic-jobs.mjs:78` `stripHtml` | yes | no | none | no |
| 3 | `providers/remotli.mjs:107` `htmlToText` | **no** | no | none | no |
| 4 | `providers/gem.mjs:84` `htmlToText` | **no** | no | none | no |
| 5 | `providers/workable.mjs:220` `toPlainText` | yes | no | none | **yes** (`:224-225`) |
| 6 | `providers/personio.mjs:103` `stripTags` | no | no (no decode at all) | none | no |
| 7 | `providers/jobbankca.mjs:174` `stripTags` | no | no decode | none | no |

`providers/_html-to-text.mjs:1-6` states the module exists "so later providers cannot
grow a divergent copy". Six providers grew one anyway.

### DIVERGENCE

**D24 — #3 and #4 leak script bodies into the job description.**
Input `<p>Hi</p><script>var x = "Senior Engineer";</script>`:
- `providers/_html-to-text.mjs:31` → `Hi`
- `providers/remotli.mjs:109`, `providers/gem.mjs:86` → `Hi var x = "Senior Engineer";`

The description is what `content_filter` / `visa_filter` substring-match against
(`providers/agentic-jobs.mjs:72-75`), so injected script text can satisfy or veto a filter.

**D25 — only the shared module caps length.** `providers/_html-to-text.mjs:11`
caps at 4000 chars; #2–#7 are uncapped. A 40 KB Workable description
(`providers/workable.mjs:220`) enters the scan payload whole.

**D26 — #6/#7 do not decode entities at all.** `providers/personio.mjs:103` and
`providers/jobbankca.mjs:174` strip tags but never call `decodeEntities`.
Input `R&amp;D Engineer` → `R&amp;D Engineer` (literal), where every other impl
gives `R&D Engineer`. A `content_filter` for `R&D` misses on those two boards.
They do, however, loop-to-fixed-point (`providers/personio.mjs:105-109`,
`providers/jobbankca.mjs:176-181`) against nested-tag evasion, which the shared
module's single-pass `replace(/<[^>]+>/g, ' ')` (`providers/_html-to-text.mjs:31`) does not.

### Canonical
`providers/_html-to-text.mjs:28` — but it must first absorb #6's fixed-point loop
(the CodeQL `js/incomplete-sanitization` concern documented at
`providers/personio.mjs:100-102`) and #5's block→newline handling as an option.
It already has the only entity double-decode and the only cap, and it is the module
whose stated purpose is exactly this.

---

### 8. HTML escaping / URL sanitizing for generated documents

### Implementations — 4

| # | Location | Escapes |
|---|---|---|
| 1 | `build-cv-html.mjs:66` `escapeHtml` | `& < > " '` |
| 2 | `generate-cover-letter.mjs:83` `escapeHtml` | `& < > " '` |
| 3 | `build-cv-html.mjs:83` `sanitizeUrl` | scheme allowlist + escape |
| 4 | `lib/latex-escape.mjs:56` `sanitizeUrl` | scheme allowlist, no escape |

### DIVERGENCE

**D27 — the two `escapeHtml` copies differ on non-string input.**
`build-cv-html.mjs:71` returns `''` only for `null`/`undefined`/`object` and
otherwise `String(text)`; `generate-cover-letter.mjs:84` returns `''` for **any
falsy** value.
Concrete: input `0` → `build-cv-html.mjs:66` yields `"0"`;
`generate-cover-letter.mjs:83` yields `""`. Same for `false`.
`build-cv-html.mjs:67-70` documents this as bug #2641 ("silently dropped numeric
years/dates from the CV"), fixed in the CV renderer and **not** in the cover-letter
renderer — the identical defect is still live at `generate-cover-letter.mjs:84`.
`lib/latex-escape.mjs:12-20` shows the LaTeX path was also fixed. Two of three.

**D28 — the two `sanitizeUrl` copies disagree on a hostile scheme.**
Input `"javascript:alert(1)"`:
- `build-cv-html.mjs:91-93` → `''` (explicit-but-disallowed scheme rejected)
- `lib/latex-escape.mjs:61-66` → no allowlist hit, no `@`, so → `https://javascript:alert(1)`

Also `tel:` is allowed by `build-cv-html.mjs:87` and not by
`lib/latex-escape.mjs:60`, so a profile with `tel:+441234567890` renders a working
link in the HTML CV and `https://tel:+441234567890` in the LaTeX CV.

### Canonical
`build-cv-html.mjs:66` `escapeHtml` and `build-cv-html.mjs:83` `sanitizeUrl` →
`lib/html-escape.mjs`. Justification: `build-cv-html`'s versions carry both fixes
(#2641 scalar coercion, explicit-scheme rejection) that the others lack.
`lib/latex-escape.mjs:56` should keep its LaTeX-specific tail
(`lib/latex-escape.mjs:68`) but adopt the same allowlist logic.

---

### 9. PDF rendering

### Implementations — 3 production + 1 test

| # | Location | Page geometry |
|---|---|---|
| 1 | `generate-pdf.mjs:1581` | `preferCSSPageSize: true`, zero margins |
| 2 | `img-to-pdf.mjs:154` | explicit `width`/`height` in inches from image px ÷ 96 |
| 3 | `archive-posting.mjs:374` | `format: 'a4'`, `0.5in` margins, `preferCSSPageSize: false` |
| 4 | `test/cv-visual/cv-visual.spec.mjs:93` | `format: 'A4'`, `0.6in` margins |

### Assessment — **not a duplicate capability**

These render three different documents (tailored CV, an image, a scraped web page) and
the geometry differences are intentional. What *is* duplicated is the
launch/teardown boilerplate: `chromium.launch({headless:true})` appears at
`scan-interamt.mjs:277`, `scan-ats-full.mjs:599`, `browser-extract.mjs:271`,
`openrouter-runner.mjs:411`, `scan.mjs:2141`, `check-liveness.mjs:68`,
`img-to-pdf.mjs:129`, `archive-posting.mjs:434`, `doctor.mjs:174`,
`batch-evaluate-gemini.mjs:340`, `upskill.mjs:894` — **11 sites** — plus
`liveness-browser.mjs:473` with `headless:false`.

**No divergence to flag**; `generate-pdf.mjs:1480,1666` already parameterizes the
launcher (`opts.launchBrowser`) for testability, and that is the pattern to lift into
`lib/`. The 4th case at `test/cv-visual/cv-visual.spec.mjs:93` should probably match #1
but is a snapshot test, out of scope.

**Canonical**: no consolidation of the `page.pdf()` calls. Extract only
`launchBrowser`/`withBrowser` from `generate-pdf.mjs:1480`.

---

### 10. ATS provider dispatch

### Independent dispatch tables — 9

| # | Location | Vendors | Detection method |
|---|---|---|---|
| 1 | `providers/_registry.mjs:65` `resolveProvider` + 84 per-provider `detect()` | **84** | explicit `provider:` field → `local-parser` → `detect()` in filename order |
| 2 | `verify-portals.mjs:47` `ATS` + `verify-portals.mjs:84` `ATS_URL_PATTERNS` | 3 (gh, ashby, lever) | regex over the URL string; lever host-pinned |
| 3 | `discover-ats.mjs:88` `VENDORS` + `discover-ats.mjs:113` `VENDOR_ORDER` | **11** | slug→URL construction + `new URL().hostname` assertion + provider `detect()` |
| 4 | `scan-ats-full.mjs:177` `SOURCES` | 3 | dataset-driven, `entryOnHost` host equality |
| 5 | `liveness-api.mjs:68` `ATS_PROVIDERS` | 5 (gh, lever, ashby, workday, linkedin) | per-entry `match(u)` on a parsed `URL` |
| 6 | `prepare-application.mjs:27` `ALLOWED_HOSTS` + `prepare-application.mjs:99` `detectAts` | 3 | hostname `Set` membership |
| 7 | `fix-slugs.mjs:88` `resolvedUrls` | 3 | `if/else` on an `ats` string from #2 |
| 8 | `seeds/vc-portfolios.mjs:287-292` | 3 | `if/else` on `company.ats` |
| 9 | `archive-posting.mjs:239` + `archive-posting.mjs:206` | 1 + a title-suffix regex naming 8 vendors | hostname equality |

### DIVERGENCE

**D29 — `prepare-application.mjs` rejects the Greenhouse host every other component emits.**
`prepare-application.mjs:27-35` allows `boards.greenhouse.io` and bare `greenhouse.io`
but **not** `job-boards.greenhouse.io` or `job-boards.eu.greenhouse.io`.
Meanwhile:
- `providers/greenhouse.mjs:16-17` allows both `job-boards.greenhouse.io` and `job-boards.eu.greenhouse.io`
- `discover-ats.mjs:89` **builds** `https://job-boards.greenhouse.io/${s}`
- `scan-ats-full.mjs:184` builds the same
- `seeds/vc-portfolios.mjs:288,300` builds the same
- `verify-portals.mjs:48-49` probes it
- `liveness-api.mjs:73` accepts `/(^|\.)greenhouse\.io$/` — i.e. all of them

So a URL discovered and written into `portals.yml` by `discover-ats.mjs` and scanned
successfully by `scan.mjs` is rejected at `prepare-application.mjs:87` with
`"is not a supported ATS host"`. **Confidence: high** — read both tables directly.

**D30 — Greenhouse/Ashby detection in `verify-portals` is not host-pinned; Lever is.**
`verify-portals.mjs:96-99` explains that Lever entries are host-pinned "otherwise a
crafted `https://evil.com/jobs.lever.co/x` careers_url would falsely resolve as Lever",
then `verify-portals.mjs:87-92` leaves greenhouse and ashby as bare substring regexes
matched against the full URL text at `verify-portals.mjs:118-120`.
Concrete: `parseAtsSlug("https://evil.example/jobs.ashbyhq.com/acme")` returns
`{ats:'ashby', slug:'acme'}`. `providers/ashby.mjs:107` has the same unpinned regex,
but `providers/ashby.mjs:81` locks the *fetched* host to `api.ashbyhq.com`, so the
blast radius differs between the two. The defence the comment describes was applied
to one of three vendors. **Confidence: high** on the parse behaviour; **medium** on
downstream impact (I did not trace every `parseAtsSlug` consumer past
`fix-slugs.mjs:88`).

**D31 — five different answers to "what is this ATS" for one URL.**
`https://job-boards.eu.greenhouse.io/acme/jobs/123`:
- `providers/greenhouse.mjs:17` → greenhouse
- `verify-portals.mjs:88` → greenhouse
- `liveness-api.mjs:73` → greenhouse
- `discover-ats.mjs:89` → not representable (its `host` constant is the non-EU one, so
  `buildCandidateUrls`'s assertion at `discover-ats.mjs:273` would reject it)
- `prepare-application.mjs:87` → **rejected**

**D32 — Lever EU is known to three tables and unknown to three others.**
`providers/lever.mjs:8` (`api.eu.lever.co`), `verify-portals.mjs:73,95-96`,
`liveness-api.mjs:83` and `prepare-application.mjs:32` all handle `eu`.
`discover-ats.mjs:91` (`host: 'jobs.lever.co'`), `scan-ats-full.mjs:193` and
`seeds/vc-portfolios.mjs:290` do not — an EU-resident company is discoverable only
by hand-editing `portals.yml`.

**D33 — vendor coverage is inconsistent by an order of magnitude.**
`providers/_registry.mjs:25-49` loads **84** providers. `discover-ats.mjs:113`
knows 11. `verify-portals.mjs:47`, `scan-ats-full.mjs:177`, `fix-slugs.mjs:88` and
`seeds/vc-portfolios.mjs:287` know 3 each. So `verify-portals.mjs` — the tool whose
job is verifying portals — silently skips the other 81 (documented as intentional at
`verify-portals.mjs:225-227`, "non-ATS URLs … which this tool skips", but the
consequence is that `fix-slugs --fix` can never repair a Workable/Personio/Recruitee entry).

### Canonical
`providers/_registry.mjs:65` `resolveProvider` + each provider's own `detect()`.
Justification: 84 providers vs 3–11; it is the runtime path `scan.mjs` actually uses;
`verify-portals.mjs:40-42` already routes non-ATS boards through it and says so; and
each provider already owns the authoritative host allowlist
(`providers/greenhouse.mjs:14-17`, `providers/lever.mjs:8`, `providers/ashby.mjs:81`)
that the six side tables re-state incorrectly.

Tables #2, #6, #7, #8 should derive from a single exported
`{id, hosts[], buildBoardUrl(slug), buildApiUrl(slug, {eu})}` per provider module,
so `prepare-application.mjs:27` becomes a union of every provider's `hosts` instead
of a hand-maintained `Set`. Table #5 (`liveness-api.mjs:68`) is genuinely different —
it maps a *single posting* URL to a *per-job* API, not a board — and should stay, but
its `match()` host regexes should be checked against the provider allowlists.

Table #3 (`discover-ats.mjs:88`) carries a real safety property no other table has —
the `new URL().hostname === expected` assertion at `discover-ats.mjs:267-276` plus the
provider `detect()` re-check at `discover-ats.mjs:277-289`. That belongs in the shared
layer, not in one script.

---

### Consolidation risk ranking

| Rank | Divergence | Why it is first |
|---|---|---|
| 1 | D29 / D31 (Greenhouse host tables) | A user-facing hard failure exists **today**, no consolidation required to hit it |
| 2 | D16 / D17 (mark-stripping identity keys) | Silently merges distinct employers/roles; the fix pattern is already in-repo |
| 3 | D21 / D20 (`toEpochMs`) | Dates in 1970 and year 33658 defeat every freshness filter |
| 4 | D24 (script text in descriptions) | Filter evasion via posting content, which `AGENTS.md:52-60` classes as untrusted |
| 5 | D1 (UTC vs local today) | Off-by-one dates written into primary-source artifacts |
| 6 | D30 (unpinned host regexes) | Spoofable `careers_url` resolves to a trusted ATS |
| 7 | D27 (`escapeHtml` scalar drop) | Numeric years vanish from generated cover letters |
| 8 | D9–D12 (slug divergence) | Breaks path stability on consolidation — the doctrine at `ARCHITECTURE.md:26-28` |
| 9 | D6 / D8 (`daysBetween`) | Signature collision makes a naive merge a silent `NaN` |
| 10 | D28 (`sanitizeUrl`) | LaTeX path lacks the scheme rejection |
