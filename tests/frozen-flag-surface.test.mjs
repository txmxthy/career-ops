/**
 * frozen-flag-surface.test.mjs — the flags external consumers actually send.
 *
 * docs/audit/public-surface.md §2 freezes fifteen root scripts by FILENAME PLUS
 * FLAGS: the web app and the dashboard binary are separately versioned and are
 * coded to run against an arbitrary CAREER_OPS_ROOT, so a flag they send is as
 * much a contract as the path they send it to.
 *
 * The defect this pins is real and shipped: followup-cadence.mjs validated its
 * argv strictly and did not list `--json`, while BOTH web routes send it. The
 * script exited 1 having printed nothing, the routes swallow the error, and
 * `JSON.parse("")` threw — so the home dashboard rendered "all clear" for a
 * cadence engine that never ran. That is ADR 0006's forbidden collapse: an
 * unperformed check and an empty result sharing one representation.
 *
 * The table below is transcribed from the call sites, not from the freeze doc,
 * so it stays true to what is actually sent. Each entry cites its consumer.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';
import { extractArrayFromSource } from '../update-system.mjs';

// Flags sent by an out-of-tree consumer, per call site. Adding a flag here
// without adding it to the script's KNOWN_FLAGS is the failure this catches.
const CONSUMER_FLAGS = [
  {
    script: 'followup-cadence.mjs',
    flags: ['--json'],
    consumer: 'web/src/app/api/followups/route.ts:18, web/src/app/api/followups/cadence/route.ts:42',
  },
  {
    script: 'doctor.mjs',
    flags: ['--json'],
    consumer: 'web/src/app/api/doctor/route.ts:18',
  },
  {
    script: 'scan-ats-full.mjs',
    flags: ['--dry-run', '--since', '--ats', '--limit', '--json'],
    consumer: 'web/src/lib/core/scan.ts:89-98',
  },
];

// Frozen scripts that do NOT validate their argv strictly. They cannot reject
// a consumer's flag, so there is nothing to pin — but they are listed rather
// than omitted, so "no KNOWN_FLAGS" reads as a stated finding instead of a
// silent gap in the coverage.
const UNVALIDATED = [
  'followup-seed.mjs', 'generate-pdf.mjs', 'mark-pdf-ready.mjs', 'merge-tracker.mjs',
  'reserve-report-num.mjs', 'set-status.mjs', 'tracker.mjs', 'tracker-parse.mjs',
  'tracker-utils.mjs', 'update-system.mjs', 'verify-portals.mjs',
];

const sourceOf = (script) => readFileSync(join(ROOT, script), 'utf-8');

// ── 1. Every consumer flag is accepted by the script it is sent to ─────────
for (const { script, flags, consumer } of CONSUMER_FLAGS) {
  const source = sourceOf(script);
  const known = extractArrayFromSource(source, 'KNOWN_FLAGS');

  // A missing manifest is "could not verify", never a quiet pass: a script
  // that stopped declaring KNOWN_FLAGS would otherwise sail through with an
  // empty list and no flag to check against.
  if (known.length === 0) {
    fail(`${script}: could not verify — no KNOWN_FLAGS array found, so the flags ${consumer} sends cannot be checked`);
    continue;
  }

  for (const flag of flags) {
    if (known.includes(flag)) {
      pass(`${script} accepts ${flag} (sent by ${consumer.split(',')[0]})`);
    } else {
      fail(`${script} rejects ${flag}, which ${consumer} sends — the call exits 1 printing nothing`);
    }
  }
}

// ── 2. The scripts that cannot reject anything are named, not skipped ──────
for (const script of UNVALIDATED) {
  const source = sourceOf(script);
  if (extractArrayFromSource(source, 'KNOWN_FLAGS').length === 0) {
    pass(`${script} does not validate argv strictly — no flag surface to pin`);
  } else {
    // It grew one. That is an improvement, but an unpinned one: its consumer's
    // flags now have to be in CONSUMER_FLAGS or the next update can break them
    // exactly the way followup-cadence.mjs broke.
    fail(`${script} now declares KNOWN_FLAGS — add its consumer's flags to CONSUMER_FLAGS above`);
  }
}

// ── 3. followup-cadence.mjs --json actually emits JSON ─────────────────────
// The regression in full: accepting the flag is not enough, the flag has to
// produce the JSON the routes parse. Read-only, no user data required — an
// empty tracker yields `{"error": ...}`, which is still valid JSON.
{
  const { execFileSync } = await import('child_process');
  let stdout = '';
  let threw = null;
  try {
    stdout = execFileSync('node', [join(ROOT, 'followup-cadence.mjs'), '--json'],
      { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    // Exit 1 with a populated stdout is the no-applications case, not a flag
    // rejection. Exit 1 with empty stdout is the defect.
    stdout = err.stdout || '';
    threw = err;
  }

  if (stdout.trim() === '') {
    fail(`followup-cadence.mjs --json printed nothing (exit ${threw?.status}) — the web routes get "" and JSON.parse throws`);
  } else {
    pass('followup-cadence.mjs --json prints to stdout');
    try {
      JSON.parse(stdout.slice(stdout.indexOf('{')));
      pass('followup-cadence.mjs --json output parses as JSON, the way the routes parse it');
    } catch (err) {
      fail(`followup-cadence.mjs --json output is not parseable JSON: ${err.message}`);
    }
  }
}

// ── 4. --json wins over --summary when both are given ──────────────────────
// ADR 0006 requires --json on every command. A caller that passes it is asking
// for machine output; silently handing back the human dashboard would give the
// routes prose to JSON.parse.
{
  const { execFileSync } = await import('child_process');
  let stdout = '';
  try {
    stdout = execFileSync('node', [join(ROOT, 'followup-cadence.mjs'), '--summary', '--json'],
      { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    stdout = err.stdout || '';
  }
  if (stdout.trim().startsWith('{')) {
    pass('followup-cadence.mjs --summary --json yields JSON, not the human dashboard');
  } else {
    fail(`followup-cadence.mjs --summary --json yielded non-JSON: ${stdout.slice(0, 80)}`);
  }
}
