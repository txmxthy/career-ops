# ADR 0003 — Command taxonomy

**Status:** accepted
**Date:** 2026-08-24

## Context

The 127 root scripts are the LLM's tool surface: `modes/*.md` shells out to them by name. That
is a legitimate design for agent invocation, and it is why the sprawl exists. The new CLI must
be at least as good a tool surface, not merely a tidier one.

Per ADR 0001 the root filenames stay. This taxonomy therefore defines what each script's logic
*becomes* inside the CLI, with the root file remaining as a shim that delegates to it.

## Decision

`career-ops <noun> <verb>`, ten nouns. Every one of the 127 root `.mjs` is accounted for below —
as a command, as a library module, or as a test to relocate. There are no unclassified entries.

| Bucket | Count |
|---|--:|
| Commands | 85 |
| Library modules (become `src/core/`, not commands) | 22 |
| Tests (move to `tests/`, one convention) | 20 |
| **Total** | **127** |

Nouns, by command count: `insight` 15, `system` 12, `tracker` 11, `apply` 11, `scan` 9,
`eval` 8, `followup` 7, `cv` 6, `render` 4, `pipeline` 2.

**Method, stated so it is reproducible and falsifiable:** assignment is by an explicit
classifier (prefix rules plus a hand-maintained library set), run over `git ls-files '*.mjs'`
filtered to root. It is a starting point, not a finished API — a name that reads badly in
`--help` should be changed during execution, in this ADR, not silently.

## The 15 frozen paths

Marked **Y** below. Each is pinned by a consumer outside this refactor's reach — the Go binary,
the separately-versioned web app, or the updater itself. They keep both their filename *and*
their observable contract (argv shape, exit codes, stdout format, named exports). See
`docs/audit/public-surface.md` §2 for the consumer that pins each one.

Note that `dedup=` columns below are reference counts, not importance: `pkg` = `package.json`
invocations, `modes` = `modes/*.md` files naming it, `ext` = files under `web/` or `dashboard/`
naming it.

| Script | LOC | pkg | modes | ext | Frozen | Command |
|---|--:|--:|--:|--:|:--:|---|
| `add-entry.mjs` | 278 | 1 | 2 | 0 |  | `career-ops tracker add-entry` |
| `agent-inbox-tests.mjs` | 520 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `agent-inbox.mjs` | 240 | 0 | 1 | 0 |  | `career-ops pipeline agent-inbox` |
| `analyze-patterns.mjs` | 1412 | 1 | 2 | 0 |  | `career-ops insight analyze-patterns` |
| `application-answers.mjs` | 402 | 0 | 1 | 0 |  | `career-ops apply application-answers` |
| `application-artifacts.mjs` | 135 | 1 | 0 | 0 |  | `career-ops apply application-artifacts` |
| `archive-posting.mjs` | 480 | 1 | 1 | 0 |  | `career-ops tracker archive-posting` |
| `assessment-log.mjs` | 333 | 0 | 0 | 0 |  | `career-ops apply assessment-log` |
| `batch-evaluate-gemini.mjs` | 403 | 0 | 0 | 0 |  | `career-ops eval evaluate-gemini` |
| `batch-tailor.mjs` | 140 | 0 | 0 | 0 |  | `career-ops eval tailor` |
| `browser-extract.mjs` | 310 | 1 | 22 | 0 |  | `career-ops scan browser-extract` |
| `build-cv-html.mjs` | 951 | 0 | 1 | 0 |  | `career-ops cv build-cv-html` |
| `build-cv-latex.mjs` | 347 | 0 | 2 | 0 |  | `career-ops cv build-cv-latex` |
| `build-dashboard.mjs` | 34 | 1 | 0 | 1 |  | `career-ops render build-dashboard` |
| `check-liveness.mjs` | 115 | 1 | 7 | 0 |  | `career-ops scan check-liveness` |
| `check-table-freshness.mjs` | 618 | 1 | 0 | 1 |  | `career-ops system check-table-freshness` |
| `classify-tier.mjs` | 264 | 0 | 0 | 0 |  | `career-ops insight classify-tier` |
| `company-funded.mjs` | 1023 | 1 | 0 | 0 |  | `career-ops insight funded` |
| `company-history.mjs` | 1813 | 0 | 4 | 0 |  | `career-ops insight history` |
| `company-history.test.mjs` | 421 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `contacts.mjs` | 485 | 0 | 1 | 0 |  | `career-ops followup contacts` |
| `contacts.test.mjs` | 499 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `cv-sections-core.mjs` | 155 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `cv-sync-check.mjs` | 102 | 1 | 38 | 0 |  | `career-ops cv sync-check` |
| `cv-templates.mjs` | 191 | 0 | 2 | 1 |  | _library — becomes `src/core/`, not a command_ |
| `dedup-tracker.mjs` | 457 | 1 | 3 | 0 |  | `career-ops tracker dedup-tracker` |
| `detect-reposts.mjs` | 828 | 1 | 0 | 0 |  | `career-ops insight detect-reposts` |
| `detect-reposts.test.mjs` | 1376 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `discover-ats.mjs` | 1066 | 0 | 1 | 0 |  | `career-ops scan discover-ats` |
| `discover-ats.test.mjs` | 497 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `doctor.mjs` | 673 | 1 | 6 | 5 | **Y** | `career-ops system doctor` |
| `eval-golden.mjs` | 264 | 1 | 0 | 0 |  | `career-ops eval eval-golden` |
| `extract-latex-content.mjs` | 62 | 0 | 1 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `find.mjs` | 207 | 1 | 1 | 0 |  | `career-ops apply find` |
| `fingerprint-core.mjs` | 262 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `fix-slugs.mjs` | 378 | 0 | 0 | 0 |  | `career-ops system fix-slugs` |
| `followup-cadence.mjs` | 976 | 0 | 2 | 8 | **Y** | `career-ops followup cadence` |
| `followup-cadence.test.mjs` | 255 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `followup-seed-tests.mjs` | 576 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `followup-seed.mjs` | 824 | 0 | 2 | 3 | **Y** | `career-ops followup seed` |
| `funnel-velocity.mjs` | 721 | 0 | 3 | 0 |  | `career-ops insight funnel-velocity` |
| `gemini-eval.mjs` | 474 | 1 | 0 | 0 |  | `career-ops eval gemini-eval` |
| `generate-cover-letter.mjs` | 351 | 1 | 2 | 0 |  | `career-ops cv generate-cover-letter` |
| `generate-latex.mjs` | 254 | 0 | 2 | 0 |  | `career-ops system generate-latex` |
| `generate-pdf.mjs` | 1710 | 1 | 20 | 9 | **Y** | `career-ops render generate-pdf` |
| `img-to-pdf.mjs` | 259 | 1 | 0 | 0 |  | `career-ops render img-to-pdf` |
| `intake.mjs` | 478 | 0 | 1 | 0 |  | `career-ops apply intake` |
| `invite-match.mjs` | 1186 | 1 | 2 | 0 |  | `career-ops followup invite-match` |
| `invite-match.test.mjs` | 421 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `jd-capture.mjs` | 117 | 0 | 0 | 0 |  | `career-ops insight jd-capture` |
| `jd-similarity.mjs` | 178 | 1 | 0 | 0 |  | `career-ops insight jd-similarity` |
| `jd-similarity.test.mjs` | 91 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `jd-skill-gap.mjs` | 811 | 0 | 3 | 1 |  | `career-ops insight jd-skill-gap` |
| `jsonc-parse.mjs` | 116 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `liveness-api.mjs` | 377 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `liveness-browser.mjs` | 516 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `liveness-core.mjs` | 191 | 0 | 3 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `manifesto.mjs` | 36 | 1 | 0 | 0 |  | `career-ops apply manifesto` |
| `mark-pdf-ready.mjs` | 192 | 0 | 0 | 4 | **Y** | `career-ops render mark-pdf-ready` |
| `match-star.mjs` | 268 | 1 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `merge-tracker.mjs` | 1394 | 1 | 27 | 6 | **Y** | `career-ops tracker merge-tracker` |
| `negotiation-roi.mjs` | 704 | 0 | 0 | 0 |  | `career-ops apply negotiation-roi` |
| `normalize-statuses.mjs` | 215 | 1 | 3 | 1 |  | `career-ops tracker normalize-statuses` |
| `ollama-eval.mjs` | 410 | 1 | 0 | 0 |  | `career-ops eval ollama-eval` |
| `openai-eval.mjs` | 440 | 1 | 1 | 0 |  | `career-ops eval openai-eval` |
| `openai-tailor.mjs` | 349 | 1 | 0 | 0 |  | `career-ops eval openai-tailor` |
| `openrouter-runner.mjs` | 862 | 5 | 0 | 0 |  | `career-ops eval openrouter-runner` |
| `outcome.mjs` | 448 | 0 | 1 | 0 |  | `career-ops apply outcome` |
| `paste-reply-tests.mjs` | 209 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `paste-reply.mjs` | 255 | 1 | 1 | 0 |  | `career-ops followup paste-reply` |
| `patch-latex-content.mjs` | 86 | 0 | 1 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `pipeline-lock.mjs` | 642 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `playwright.cv.config.mjs` | 21 | 0 | 0 | 0 |  | `career-ops cv playwright.cv.config` |
| `plugin-audit.mjs` | 124 | 0 | 0 | 0 |  | `career-ops system plugin-audit` |
| `plugin-install.mjs` | 133 | 0 | 0 | 0 |  | `career-ops system plugin-install` |
| `plugins.mjs` | 366 | 0 | 0 | 0 |  | `career-ops system plugins` |
| `portal-health-lock.mjs` | 247 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `prepare-application.mjs` | 241 | 1 | 0 | 0 |  | `career-ops apply prepare-application` |
| `process-quality.mjs` | 390 | 0 | 0 | 0 |  | `career-ops insight process-quality` |
| `process-quality.test.mjs` | 391 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `profile-language.mjs` | 35 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `rank-pipeline.mjs` | 474 | 0 | 1 | 0 |  | `career-ops apply rank-pipeline` |
| `reconcile-pipeline.mjs` | 297 | 1 | 1 | 0 |  | `career-ops tracker reconcile-pipeline` |
| `rejection-latency.mjs` | 603 | 1 | 1 | 0 |  | `career-ops insight rejection-latency` |
| `reply-matcher.mjs` | 550 | 0 | 0 | 0 |  | `career-ops followup reply-matcher` |
| `reply-matcher.test.mjs` | 534 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `reply-watch.mjs` | 343 | 0 | 1 | 0 |  | `career-ops followup reply-watch` |
| `reserve-report-num.mjs` | 364 | 0 | 33 | 8 | **Y** | `career-ops tracker reserve-report-num` |
| `role-matcher.mjs` | 238 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `salary-gap.mjs` | 706 | 0 | 9 | 0 |  | `career-ops insight salary-gap` |
| `scan-ats-full.mjs` | 1106 | 3 | 1 | 2 | **Y** | `career-ops scan ats-full` |
| `scan-hn.mjs` | 122 | 1 | 0 | 0 |  | `career-ops scan hn` |
| `scan-interamt.mjs` | 366 | 1 | 0 | 0 |  | `career-ops scan interamt` |
| `scan.mjs` | 3004 | 1 | 3 | 8 | **Y** | `career-ops scan run` |
| `seed-fixture.mjs` | 125 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `set-status-tests.mjs` | 1418 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `set-status.mjs` | 590 | 0 | 21 | 6 | **Y** | `career-ops tracker set-status` |
| `skill-extract.mjs` | 217 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `stats.mjs` | 608 | 0 | 1 | 5 |  | `career-ops insight stats` |
| `story-provenance-check.mjs` | 752 | 0 | 1 | 0 |  | `career-ops apply story-provenance-check` |
| `sync-pdf-flags.mjs` | 140 | 0 | 0 | 0 |  | `career-ops system sync-pdf-flags` |
| `test-all.mjs` | 17101 | 0 | 0 | 7 |  | _test — move to `tests/`, one convention_ |
| `test-salary-filter.mjs` | 593 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `test-trust-validator.mjs` | 458 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `theme-style.mjs` | 149 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `title-keywords.mjs` | 170 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `tracker-columns-tests.mjs` | 706 | 0 | 0 | 1 |  | _test — move to `tests/`, one convention_ |
| `tracker-links.mjs` | 34 | 0 | 0 | 0 |  | `career-ops tracker links` |
| `tracker-parse.mjs` | 458 | 0 | 0 | 8 | **Y** | _library — becomes `src/core/`, not a command_ |
| `tracker-sync-check.mjs` | 778 | 0 | 0 | 0 |  | `career-ops tracker sync-check` |
| `tracker-utils.mjs` | 759 | 0 | 0 | 8 | **Y** | _library — becomes `src/core/`, not a command_ |
| `tracker-writer-lock-tests.mjs` | 858 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `tracker.mjs` | 569 | 1 | 27 | 11 | **Y** | `career-ops tracker run` |
| `update-system.mjs` | 2221 | 3 | 6 | 1 | **Y** | `career-ops system update-system` |
| `updater-migration-tests.mjs` | 331 | 1 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `upgrade-tests.mjs` | 384 | 0 | 0 | 0 |  | _test — move to `tests/`, one convention_ |
| `upskill.mjs` | 1018 | 1 | 1 | 0 |  | `career-ops insight upskill` |
| `url-key.mjs` | 95 | 0 | 0 | 3 |  | _library — becomes `src/core/`, not a command_ |
| `user-agent.mjs` | 23 | 0 | 0 | 0 |  | _library — becomes `src/core/`, not a command_ |
| `validate-plugin-registry.mjs` | 61 | 0 | 0 | 0 |  | `career-ops system validate-plugin-registry` |
| `validate-portals.mjs` | 342 | 1 | 0 | 0 |  | `career-ops scan validate-portals` |
| `validate-system-paths-coverage.mjs` | 185 | 0 | 0 | 0 |  | `career-ops system validate-system-paths-coverage` |
| `validate-untrusted-content-coverage.mjs` | 267 | 0 | 0 | 0 |  | `career-ops system validate-untrusted-content-coverage` |
| `verify-cv-facts.mjs` | 767 | 1 | 2 | 0 |  | `career-ops cv verify-cv-facts` |
| `verify-pipeline.mjs` | 515 | 1 | 5 | 0 |  | `career-ops pipeline verify-pipeline` |
| `verify-portals.mjs` | 765 | 1 | 0 | 6 | **Y** | `career-ops scan verify-portals` |
| `weekly-digest.mjs` | 721 | 1 | 0 | 0 |  | `career-ops insight weekly-digest` |

