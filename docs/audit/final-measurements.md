# FINAL MEASUREMENTS — dedupe-core

Every number below was re-measured, on both sides, against real trees. None is estimated and
none is carried over from an earlier edition of this file — the previous edition was written
before the move landed and reported the root at 127.

- **before** = `10a569b` (`docs: distinguish system drift updates from version updates`), the
  merge-base of `dedupe-core` and `origin/main`, read with `git ls-tree -r 10a569b` and
  `git show 10a569b:<path>`.
- **after** = the tip of `dedupe-core`, read with `git ls-files` and `cat`.
- Every count is over **tracked** files, so untracked scratch cannot inflate it.
- "Root" means a path with no `/` in it. "Visible" excludes dotfiles and dotdirs.

---

## 0. The verdict

**The requirement is met.** Root holds **15 `.mjs`, down from 127.**

```
$ git ls-files '*.mjs' | grep -v / | wc -l
15
```

Those 15 are the frozen contracts in `docs/audit/public-surface.md` §2 and nothing else. All
43 assertions of those contracts against their `web/` and `dashboard/` call sites still hold —
filenames, flags, named exports, source-text probes and exit-code mappings.

---

## 1. The table

| Measure | Before (`10a569b`) | After (tip) | Δ |
|---|--:|--:|---|
| **Root `.mjs` files** | **127** | **15** | **−112** |
| Root files (all extensions) | 189 | 51 | −138 |
| Root directories (visible) | 28 | 23 | −5 |
| Root directories (incl. dotdirs) | 38 | 33 | −5 |
| Visible root entries (files + dirs) | 207 | 64 | −143 |
| Root LOC (every tracked root file) | 92,476 | 22,053 | −70,423 |
| Root `.mjs` LOC | 79,966 | 15,929 | −64,037 |
| Tracked files | 1,178 | 1,247 | +69 |
| `.mjs` files (all) | 524 | 561 | +37 |
| `.js` files (all) | 2 | 17 | +15 |
| All `.mjs` LOC | 150,039 | 159,742 | +9,703 |
| Tracked files under `src/` | 0 | 119 | +119 |
| `src/` LOC | 0 | 46,895 | +46,895 |
| Files splitting on `\|` (all) | 40 | 37 | −3 |
| Files splitting on `\|` (root only) | 29 | 9 | −20 |
| Files touching `process.argv` (all) | 93 | 104 | +11 |
| Files touching `process.argv` (root only) | 84 | 13 | −71 |
| Files importing a shared flags module | 36 | 87 | +51 |
| `readFileSync` occurrences | 533 | 510 | −23 |
| Files calling `readFileSync` | 177 | 174 | −3 |
| Root files calling `readFileSync` | 91 | 14 | −77 |
| Distinct test locations | 5 | 3 | −2 |
| Test files (`*.test.mjs`, `*-tests.mjs`) | 269 | 304 | +35 |
| Assertions — the whole-suite runner | 5,311 | 7,017 | +1,706 |
| Assertions — `node --test "tests/**/*.test.mjs"` | 307 | 1,091 | +784 |
| `npm run lint` files (clean tree) | 526 | 578 | +52 |

---

## 2. Where a number did not move, and why

Nothing in the table is unchanged, but three rows moved for reasons worth stating plainly,
because each looks like the opposite of progress:

- **Tracked files +69, `.mjs` +37, all-`.mjs` LOC +9,703.** A move does not add files. These
  are the new core modules under `src/core/`, the `career-ops` command adapters, and the test
  suites written alongside them. The root shrank; the repository grew. Both are true.
- **`process.argv` (all) +11.** The count that mattered is the root one, and it went 84 → 13.
  The eleven new touches are the CLI facade and the command adapters, which are the *one*
  place argv is supposed to be read.
- **`readFileSync` occurrences −23 only.** The audit's target was concentration, not deletion:
  root files calling it went 91 → 14. The calls moved into `src/`, they did not disappear, and
  `src/core/store.js` is where consolidating them belongs. That work is not finished.

Two rows are honest disappointments rather than wins:

- **Files splitting on `|` (all) 40 → 37.** Only three of the duplicate row-splitters were
  actually retired. `src/core/table.js` exists and is tested, but 37 files still parse tracker
  rows by hand. The root-only figure (29 → 9) reflects the move, not adoption.
- **Files calling `readFileSync` 177 → 174.** Same story.

---

## 3. Test locations

| | Before | After |
|---|---|---|
| Locations | 5 | 3 |
| | root (17 loose suites) | `src/` (1) |
| | `lib/` (1) | `tests/` (269) |
| | `test/` (5) | `web/` (34) |
| | `tests/` (211) | |
| | `web/` (34) | |

The 17 loose root suites and the split `test/` / `test-fixtures/` directories are gone.
`tests/test-fixtures` did not become a directory of that name — the fixtures landed at
`tests/fixtures/`, and `.gitignore`'s re-include was repointed to match. Before that repoint a
*new* fixture state would have been silently ignored by the unanchored `cv.md` and
`portals.yml` patterns; the existing files stayed tracked only because `git mv` kept them in
the index.

`src/lib/context-budget.test.mjs` is the one suite that does not live under `tests/`. It is
also not executed by anything: `node --test "tests/**/*.test.mjs"` does not reach outside
`tests/`, and `tests/run-all.mjs` does not register it. **This is pre-existing, not caused by
the move** — at `10a569b` it was `lib/context-budget.test.mjs` and `test-all.mjs` did not
register it either. The move relocated an orphan; it did not create one.

---

## 4. How each number was produced

```bash
# tracked files / .mjs / .js
git ls-files | wc -l
git ls-files | grep -c '\.mjs$'
git ls-files | grep -c '\.js$'

# root
git ls-files '*.mjs' | grep -v / | wc -l
git ls-files | grep -v / | wc -l
git ls-files | grep / | cut -d/ -f1 | sort -u | grep -v '^\.' | wc -l   # visible dirs
git ls-files | grep / | cut -d/ -f1 | sort -u | wc -l                   # incl. dotdirs

# LOC — summed per file with `wc -l`, over tracked paths only
# split on '|'   : .split(<quote>…|  matched per file, counted once per file
# process.argv   : literal 'process.argv', counted once per file
# flags module   : 'cli-flags.mjs' or 'core/flags.js' in the file's text
# readFileSync   : 'readFileSync(' occurrences, summed
```

The "before" side of every one of these ran against `git show 10a569b:<path>`, not against a
checkout, so no working-tree state could leak into it.

The three suite counts are the exception — an assertion count cannot be read out of a blob.
Those came from an actual run in a detached worktree at `10a569b`, since removed:

```
$ git worktree add --detach /tmp/co-before 10a569b
$ (cd /tmp/co-before && node test-all.mjs)
📊 Results: 5311 passed, 0 failed, 2 warnings
$ (cd /tmp/co-before && node --test "tests/**/*.test.mjs")
ℹ tests 307   ℹ pass 307   ℹ fail 0
```

against, on the tip:

```
$ node tests/run-all.mjs
📊 Results: 7017 passed, 0 failed, 2 warnings
$ node --test "tests/**/*.test.mjs"
ℹ tests 1091  ℹ pass 1091  ℹ fail 0
$ npm run lint
✓ 578 script files passed syntax check.
```

The lint row is the one number that is not a run on both sides, and it says so: on a clean
tree `src/scripts/check-syntax.mjs` visits exactly the tracked `.mjs` plus `.js` files, so the
before figure is `git ls-tree -r 10a569b | grep -cE '\.(mjs|js)$'` = 526 (none of them under
its `SKIP_DIRS`), against 578 today. The tip figure was also confirmed by running it.

That equality only holds on a clean tree, which is worth recording: check-syntax walks the
working tree rather than the index, and its `SKIP_DIRS` does not exclude
`tests/run-all.mjs`'s own `.tmp-script-test-*` fixture copies. A killed suite run leaves one
behind, the next run copies it into its own fixture, and the count compounds — this tree
reported **4,589** with three stale fixtures present and **578** once they were removed.
**A lint count can be inflated by leftover state. That is pre-existing, not a regression from
the move, and it is not fixed here.**
