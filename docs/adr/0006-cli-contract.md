# ADR 0006 — CLI contract

**Status:** accepted
**Date:** 2026-08-24

## Context

The CLI is **additive**. Root shims and `career-ops <noun> <verb>` both delegate to the same
core, so there is exactly one code path per capability and two ways to invoke it. Deprecating
the shims is a separate, later decision, on a major version with a deprecation window — not
proposed here.

The consumer that matters is an LLM. `modes/*.md` shells out and reads the result, so the
contract is machine-facing first.

## Decision

Facade → Command adapters → importable, argv-free core. Each command file parses nothing and
prints nothing; it maps parsed flags to a core call and a result to a renderer.

### Required of every command

- `career-ops --help` enumerates every command; `career-ops <cmd> --help` documents that one.
- **`--json` on every command, without exception.** Agents parsing prose is the failure mode
  being removed.
- Meaningful, documented exit codes.
- **A failed check reports "could not verify", never "nothing found".** Upstream lost hours to a
  watcher that silenced stderr and reported success; the audit found that pattern still present
  (see `docs/audit/tech-debt.md`). An empty result and an unperformed check are different
  states and must never share a representation.

### JSON envelope

```json
{ "ok": true, "command": "scan run", "data": {}, "warnings": [], "errors": [] }
```

`ok: false` with a populated `errors` array whenever the exit code is non-zero. `data` shape is
per-command and documented in that command's `--help`. **A check that could not run sets
`ok: false` and an error — it never returns `ok: true` with empty `data`.**

### Exit codes

| Code | Meaning |
|--:|---|
| 0 | Success; the check ran and passed |
| 1 | The check ran and failed (a real negative finding) |
| 2 | Usage error — bad flags, unknown command |
| 3 | **Could not verify** — the check could not run (missing input, unreachable service) |
| 4 | Config or environment error |

Codes 1 and 3 are deliberately distinct. Collapsing them is how "nothing found" gets reported
for a check that never executed.

Frozen scripts keep their existing exit codes where a consumer pins them — `set-status.mjs`'s
`CLI_EXIT` is read by `web/src/app/api/status/route.ts:53`. Where the old and new codes
conflict, the shim translates; the CLI does not inherit the inconsistency.
