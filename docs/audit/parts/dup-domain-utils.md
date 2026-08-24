# dup-domain-utils — duplicate-functionality audit

Scope: date handling, slug generation, ASCII folding, HTML/PDF rendering, ATS provider dispatch.
All claims cite `path:line` in the fork root `/Users/tim/Documents/Personal/workspaces/career-ops/dedupe-core/career-ops`.

---

## 0. Prior art: `lib/` already exists and is the pattern

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

## 1. "What day is it" (today as `YYYY-MM-DD`)

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

## 2. ISO date parse + validate (`YYYY-MM-DD` → `Date`)

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

## 3. Day-difference arithmetic (`daysBetween`)

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

## 4. Slug generation

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

## 5. ASCII folding / Unicode normalization

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

## 6. Epoch-ms date coercion in providers (`toEpochMs`)

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

## 7. HTML → text

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

## 8. HTML escaping / URL sanitizing for generated documents

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

## 9. PDF rendering

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

## 10. ATS provider dispatch

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

## Consolidation risk ranking

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
