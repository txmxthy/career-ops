# DUP AUDIT — cluster "text-parsing"

Repo: `/Users/tim/Documents/Personal/workspaces/career-ops/dedupe-core/career-ops`

Measured counts (this audit):
- 67 `split('|')` call sites across `*.mjs` excluding `test-all.mjs` (`rg -c "split\('\|'\)"`).
- 84 root `.mjs` reference `process.argv`; 28 of those import `lib/cli-flags.mjs`
  → **56 root scripts hand-roll argv with no shared helper**.
- 29 root `.mjs` import `lib/cli-flags.mjs` in total.

---

## CAPABILITY 1 — Markdown table: split a row into cells

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

## CAPABILITY 2 — argv / flag parsing

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

## Uncertainty

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
