
```markdown
# Duplicate functionality

Every claim below is a direct read of the cited line in this checkout. Nothing is inferred from
filenames. Where a prior agent's claim did not survive verification it is marked **CORRECTION**.

## Summary

| Capability | Implementations | Canonical | Divergences |
|---|---|---|---|
| Status normalization | 7 (`analyze-patterns.mjs:95`, `dedup-tracker.mjs:88`, `tracker-sync-check.mjs:152`, `tracker.mjs:145`, `followup-cadence.mjs:139`, `normalize-statuses.mjs:42`, `invite-match.mjs:132`) | `followup-cadence.mjs:139` | 4: alias source, Turkish fold, return type, date regex |
| Company key | 5 (`company-funded.mjs:388`, `rejection-latency.mjs:164`, `fingerprint-core.mjs:184`, `detect-reposts.mjs:198`, `process-quality.mjs:172`) | `tracker-parse.mjs:434` `normalizeTextKey` | 3: separator, script preservation, input type |
| URL key | 4 (`url-key.mjs:55`, `scan.mjs:1053`, `discover-ats.mjs:402`, `web/src/lib/core/url-key.mjs:46`) | `url-key.mjs:55` | 2: path casing, empty-key contract |
| Lock-owner read | 4 (`pipeline-lock.mjs:76`, `portal-health-lock.mjs:75`, `tracker-utils.mjs:244`, `followup-seed.mjs:291`) | `pipeline-lock.mjs:76` | 1: `{inspected,owner}` vs bare `null` |
| "Today" | 3 forms across 21 root sites; `lib/local-today.mjs` adopted by 9 root files | `lib/local-today.mjs:28` | 1: UTC day vs local day |
| CLI flag parsing | 3 `flagValue` + 10 `parseArgs` + 3 `parseCliArgs` | `lib/cli-flags.mjs:29` | 1: `--`-prefixed values, `null` vs `undefined` |
| Embedded test harness | 27 `selfTest`, 34 `--self-test`, 17 `printSummary` | none exists | n/a — no shared module to diverge from |
| Provider file reader | 8 `function readFile` | none exists | 4 signatures |
| JS↔Go core logic | 3 (`tracker_lock.go:87`, `career.go:595`, `career.go:937`) | JS side | **none found** — see note |

Ordered below by consolidation payoff = sites x blast radius.

---

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
```

---

