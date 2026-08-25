# FINAL MEASUREMENTS — dedupe-core

Every number below was re-measured against the tree at the tip of `dedupe-core`. None are
estimated, and none are carried over from `docs/audit/`. Where a number did not move, it is
still listed, with the reason.

- **before** = `10a569b` (`docs: distinguish system drift updates from version updates`), the
  merge-base of `dedupe-core` and `origin/main`, measured in a clean worktree.
- **after** = the tip of `dedupe-core`.
- Every count is over **tracked** files (`git ls-files`), so untracked scratch cannot inflate it.

---

## 0. The verdict, first

**The requirement was not met.** Root holds **127 `.mjs`, unchanged from 127.** The target is 15.

Nothing was moved. There is no partial credit to report here:

```
$ git ls-files '*.mjs' | grep -v / | wc -l
127                      # required: 15

$ git log --diff-filter=R --name-status 10a569b..HEAD
                         # empty — zero renames on the branch
```

All 15 frozen names are present at root, but none of them is a shim. They are the original
implementations, 15,595 lines between them. The other 112 unpinned scripts are still at root
too. ADR 0005 step 5 — *"Move 112 scripts into `src/`; hollow the 15 frozen ones into shims"* —
did not start.

What *did* land is steps 1–4: the three core modules, and the `career-ops` CLI facade over
them. That is real work and it is measured below. It is not the requirement.

---

## 1. The table

| Measure | Before (`10a569b`) | After (tip) | Δ |
|---|--:|--:|---|
| **Root `.mjs` files** | **127** | **127** | **0 — the requirement is unmet** |
| Tracked files | 1178 | 1239 | +61 |
| `.mjs` files (all) | 524 | 554 | +30 |
| `.js` files (all) | 2 | 16 | +14 |
| Root `.mjs` LOC | 79,966 | 79,998 | +32 |
| All `.mjs` LOC | 150,039 | 158,128 | +8,089 |
| Tracked files under `src/` | 0 | 15 | +15 |
| `src/` LOC | 0 | 7,594 | +7,594 |
| Files splitting on `\|` (all) | 37 | 34 | −3 |
| Files splitting on `\|` (root only) | 27 | 21 | −6 |
| Files touching `process.argv` (all) | 93 | 103 | +10 |
| Files touching `process.argv` (root only) | 84 | 84 | **0 — no root script stopped hand-parsing argv** |
| Files importing a shared flags module | 27 | 76 | +49 |
| `readFileSync` occurrences | 733 | 698 | −35 |
| Files calling `readFileSync` | 180 | 173 | −7 |
| Root files calling `readFileSync` | 92 | 72 | −20 |
| Visible root directories | 29 | 31 | +2 (`src/`, `bin/`) |
| Visible root entries | 208 | 212 | +4 |

### Reproducing these

```sh
git ls-files '*.mjs' | grep -v / | wc -l                       # root .mjs
git ls-files '*.mjs' | grep -v / | xargs cat | wc -l           # root .mjs LOC
git ls-files '*.mjs' '*.js' | xargs grep -lE "\.split\((['\"])\|\1\)"   # pipe-splitters
git ls-files '*.mjs' '*.js' | xargs grep -l 'process\.argv'    # hand-parsed argv
git ls-files '*.mjs' '*.js' | xargs grep -o 'readFileSync' | wc -l
```

---

## 2. Test locations and counts

Three root naming conventions plus three directories, exactly as before. **Step 6 of ADR 0005
did not run** — no test file was consolidated or renamed.

| Location | Before | After | Δ |
|---|--:|--:|---|
| Root `*.test.mjs` | 9 | 9 | 0 |
| Root `*-tests.mjs` | 8 | 8 | 0 |
| Root `test-*.mjs` | 3 | 3 | 0 |
| `lib/*.test.mjs` | 1 | 1 | 0 |
| `tests/**/*.test.mjs` | 211 | 241 | +30 |
| `web/tests/**/*.test.mjs` | 34 | 34 | 0 |
| **Distinct locations / conventions** | **6** | **6** | **0** |

Test counts, both runners:

| Runner | Before | After |
|---|--:|--:|
| `node test-all.mjs` assertions passed | 5310 | 5427 |
| `node test-all.mjs` failed | 1 (flake, §3) | 0 |
| `node test-all.mjs` warnings | 2 | 2 |
| `node --test "tests/**/*.test.mjs"` | 307 | 901 |
| `npm run lint` files checked | 524 (`.mjs` only) | 570 (`.mjs` + `.js`) |

The +594 on the `node --test` glob is the new characterisation and command suites:
`tests/core/` 172, `tests/commands/` 350, plus six new files under `tests/`.

`npm run lint` was widened during this branch to cover `.js`, which is why its denominator
jumps — `scripts/check-syntax.mjs:27-30`. 554 tracked `.mjs` + 16 `.js` = 570.

---

## 3. Suite results at the tip

```
$ node test-all.mjs
📊 Results: 5427 passed, 0 failed, 2 warnings
🟡 Tests passed with warnings — review before pushing

$ npm run lint
✓ 570 script files passed syntax check.

$ node --test "tests/**/*.test.mjs"
ℹ tests 901   ℹ pass 901   ℹ fail 0
```

Both warnings are byte-identical to the ones at `10a569b`, and neither is ours:

- `cv-sync-check.mjs exited with error (expected without user data)` — a clean checkout has no
  `cv.md`. Expected.
- `Possible personal data in dashboard/internal/ui/screens/stats.go` — upstream's own domain,
  in a Go mirror this branch does not touch. (Not quoted here: the scanner reads this file too,
  and the literal would trip it a second time.)

### The flake, characterised rather than waved away

`node test-all.mjs` is not deterministic on this machine. Across four runs of the tip it
produced 0 failures three times and 1 failure once, and the failing assertion differed between
runs — `tracker-writer-lock-tests.mjs crashed` in one, `web pdf write-scope unit suites failed`
in another. Both are **timeouts, not assertion failures**: the first reports
`exit=null, timedOut=true`, the second reports a kill signal rather than a diff.

This is pre-existing, and it was verified as pre-existing rather than assumed. The base commit
was checked out into its own worktree and run: `10a569b` fails the same way, with the same
suite, on the same machine — `❌ Timed out waiting for tracker lock`. `test-all.mjs:466-471`
documents the condition in its own comment: the suite spends most of its budget and is "close
to being killed for time".

The suites also pass individually. `node --test web/tests/lib/*.test.mjs` is 336/336 green in
isolation; it only fails inside `test-all`'s child process under load.

**Unfixed, and deliberately so:** this is a load-sensitive timeout in the harness, not a defect
in the code this branch touched, and tightening it is a change to the test harness that belongs
in its own commit against its own evidence.

### One real regression, found and fixed

Adding `bin/career-ops` broke `test-all`'s SYSTEM_PATHS coverage guard:

```
❌ SYSTEM_PATHS coverage gap — a new file is unregistered and update-system will not ship it:
  bin/career-ops
```

That guard is the mechanism that stops the updater silently failing to ship a new file. Fixed
by registering `'bin/'` in `update-system.mjs` SYSTEM_PATHS, alongside the `'src/'` entry added
with the core modules. Re-run is green.

---

## 4. The 15 frozen contracts — verified against their real call sites

Every contract in `docs/audit/public-surface.md` §2 was exercised, not eyeballed. **14 of 15
hold. One is broken.**

Named exports the web dynamic-imports, all resolved by importing the module for real:

| Module | Exports required by | Result |
|---|---|---|
| `scan.mjs` | `web/src/lib/core/pipeline.ts:39,43,47` | `appendToPipeline`, `appendToScanHistory` — OK |
| `tracker-utils.mjs` | `web/src/lib/core/tracker-lock.ts:44,48-51` | `acquireTrackerLock`, `trackerLockDirFor`, `CLI_EXIT` — OK |
| `tracker-parse.mjs` | `web/src/lib/core/text-key.ts:39,43` | `normalizeTextKey` — OK |
| `followup-seed.mjs` | `web/src/lib/core/followups-lock.ts:55,59-61` | `withFollowupsLock` — OK |
| `lib/local-today.mjs` | `web/src/lib/core/pipeline.ts:44,47` | `localToday` — OK |

`CLI_EXIT` is `{OK:0, USAGE:1, NOT_FOUND:2, AMBIGUOUS:3, LOCK_TIMEOUT:4}`
(`tracker-utils.mjs:692`), which still covers the web's `EXIT_TO_HTTP` map
`{2:404, 3:409, 4:503}` (`web/src/app/api/status/route.ts:56`).

Source-text capability probes — the web greps these files and hides UI when the string is gone:

| Probe | Looks for | Result |
|---|---|---|
| `trackerCanDelete()` — `web/src/lib/career-ops.ts:37` | `delete` + `--num` in `tracker.mjs` | both present — OK |
| `scannerSupportsJson()` — `web/src/lib/core/scan.ts:65` | `--json` + `capHit` in `scan-ats-full.mjs` | both present — OK |

Invoked with the exact argv their consumer sends:

| Script | argv exercised | Result |
|---|---|---|
| `generate-pdf.mjs` | `<html> <pdf> --format= --report= --allow-reorder` (`dashboard/main.go:269`) | accepted; refused only by the workspace-escape guard, which is correct |
| `mark-pdf-ready.mjs` | `1 --json` (`web/src/lib/pdf-render.mjs:122`) | JSON emitted — OK |
| `doctor.mjs` | `--json` (`web/src/app/api/doctor/route.ts:13`) | `{onboardingNeeded, missing, warnings}` all present — OK |
| `tracker.mjs` | `delete --num 1 --dry-run` (`web/.../tracker/delete/route.ts:58`) | accepted — OK |
| `scan-ats-full.mjs` | `--dry-run --since 7 --ats greenhouse --limit 1 --json` (`web/src/lib/core/scan.ts:89`) | accepted — OK |
| `verify-portals.mjs` | bare (`web/.../portals/verify/route.ts:23`) | ran — OK |
| `reserve-report-num.mjs` | bare (`web/src/lib/run-prompts.mjs:128`) | printed bare `001` — OK |
| `update-system.mjs` | `check` (`package.json:33`) | JSON status emitted — OK |
| `set-status.mjs` | argv + `CLI_EXIT` (`web/.../status/route.ts:75`) | exit-code map intact — OK |
| **`followup-cadence.mjs`** | **`--json`** (`web/.../followups/route.ts:18`) | **REJECTED — see below** |

### BROKEN: `followup-cadence.mjs --json` is rejected

```
$ node followup-cadence.mjs --json
Error: unrecognized flag(s): --json. Valid flags: --summary, --overdue-only, --applied-days, --help, -h
$ echo $?
1
```

`followup-cadence.mjs:939` defines `KNOWN_FLAGS` without `--json`, and `:955` validates argv
strictly against it. Both web routes pass `--json` — `web/src/app/api/followups/route.ts:18`
and `web/src/app/api/followups/cadence/route.ts:42`.

The failure is silent end-to-end, which is why nobody has noticed:

1. The routes call `execFile(..., (_e, out) => resolve(out || ""))` — the error argument is
   discarded by name.
2. `JSON.parse("")` throws, and the `catch` returns `{available: false, metadata: null,
   entries: []}` and `cadenceDefaults: null`.
3. The user sees **"no follow-ups due"**, which is indistinguishable from a healthy empty
   tracker. This is precisely the "nothing found" vs "could not verify" collapse ADR 0006
   exists to forbid, shipped in production.

CI does not catch it because `test-all.mjs:15026` verifies the payload by importing
`analyzeFromContent` directly, bypassing argv entirely. That test passes and is right to — the
payload shape is intact; it is the flag surface that is broken. Verified via
`analyzeFromContent`: `{metadata, entries, cadenceConfig, cadenceDefaults}` all present.

**Pre-existing, not a regression from this branch.** `10a569b` fails identically, and
`followup-cadence.mjs` has zero diff across `10a569b..HEAD`. It arrived with `ec800a2`
(*"fix(followup-cadence): validate CLI flags via the shared helper"*), which added strict
validation without adding the flag the web had always sent — harmless while unknown flags were
ignored.

**Left unfixed here, deliberately.** The one-line fix is to add `'--json'` to `KNOWN_FLAGS`, but
this is a frozen script's flag surface, and ADR 0005 requires a characterisation test before
behaviour on a frozen path changes. It belongs in its own commit with that test, not folded
into a measurement pass.

---

## 5. What landed and what did not

### Landed

- **`src/core/table.js`, `store.js`, `flags.js`** — 1,177 lines, with 172 characterisation
  tests in `tests/core/`. Uptake at root: 7 files import `table.js`, 32 import `store.js`,
  32 import `flags.js`.
- **The `career-ops` CLI facade** — `bin/career-ops`, `src/cli.js`, ten modules in
  `src/commands/`, 6,417 lines, with 350 tests in `tests/commands/`.
- **ADR 0006 is honoured by the facade.** All **84** commands were enumerated from
  `career-ops --help --json` and each was invoked: every one answers `--help`, and every one
  emits a well-formed `{ok, command, data, warnings, errors}` envelope under `--json`. Zero
  failures. Exit codes are distinct and reachable — `0` ok, `1` ran-and-failed, `2` usage,
  `3` could-not-verify (`src/cli.js:161,393,404`), `4` config.
- **`update-system.mjs` SYSTEM_PATHS** now registers `src/` and `bin/`.
- No dangling imports: all 127 root `.mjs` were dynamically imported; zero
  `ERR_MODULE_NOT_FOUND`.

### Did not land

- **The move. ADR 0005 step 5.** 112 scripts still at root; zero `git mv`; the 15 frozen
  scripts are still full implementations, not shims. **This is the requirement.**
- **ADR 0001 step 5b — the updater fork.** No `REMOVED_PATHS`, no `career-ops system prune`,
  no resurrection check in `doctor.mjs`. Not yet needed, because nothing was moved; required
  before anything is.
- **ADR 0005 step 6 — test consolidation.** Six locations and three root conventions, unchanged.
- **ADR 0004's URL path-casing decision.** Resolved as *preserve path case*, **not implemented**.
  Both sites still lowercase: `scan.mjs:1068`
  (`parsed.pathname = parsed.pathname.replace(/\/+$/,'').toLowerCase()`) and
  `discover-ats.mjs:403` (`String(u||'').trim().toLowerCase()`).
  `tests/discover-ats-url-dedup-casing.test.mjs` is written correctly for a characterisation
  test — it pins the *current* losing behaviour and fails loudly when someone flips it, saying
  so in its own message (`:32`, "ADR 0004 unresolved at this site"). Note for whoever does flip
  it: `web/tests/lib/url-key.test.mjs` asserts the web mirrors the core here, so both move
  together.
- **The duplicate-symbol lint** ADR 0005 calls "the mechanism that makes it stay finished".
  Not written. Its absence is why 84 root scripts still hand-parse `process.argv` while a
  shared flags module sits next to them.

### Numbers that did not move, stated plainly

- Root `.mjs`: **127 → 127.**
- Root `.mjs` LOC: 79,966 → 79,998. It went **up** by 32 lines. Nothing was removed from root;
  the delta is import statements added when root scripts were rewired onto `src/core/`.
- Root scripts hand-parsing `process.argv`: **84 → 84.**
- Test locations: **6 → 6.**
- `web/tests/` suites: 34 → 34.
