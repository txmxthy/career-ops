// tests/url-key-path-casing.test.mjs — the ADR 0004 URL-path-casing decision,
// pinned on both sides of the divergence it settles.
//
// docs/audit/duplicate-functionality.md records two contradictory contracts for
// the same question, each citing a real incident:
//
//   scan.mjs               argued "path casing is not meaningfully distinct for
//                          any provider these scanners target", and lowercased
//                          the path — until this change.
//   src/lib/url-key.mjs    calls exactly that the over-normalization that
//                          collapsed two different Greenhouse postings into one
//                          key, and preserves path case.
//
// ADR 0004 resolves it: PRESERVE PATH CASE. The failure modes are asymmetric.
// Lowercasing risks MERGING two distinct postings — silent, unrecoverable data
// loss. Preserving risks a DUPLICATE ROW for one posting — visible, and the
// user can fix it.
//
// The casing half of that decision is now IMPLEMENTED, in the commit that also
// added src/core/text.js `urlKey`. This file has two halves:
//
//   1. The WINNER's contract, asserted directly — what the canonical key does.
//   2. scan.mjs's key, asserted as it stands. Its path casing has flipped to
//      match the winner; the other four divergences (the empty-key contract #8,
//      the wider `ref`/`src`/`source` denylist, the untouched scheme, the greedy
//      trailing-slash strip) have NOT, and are pinned below as
//      PRE-CONSOLIDATION so the next step is visible in a diff rather than
//      inferred from a passing suite.
import { pass, fail } from './helpers.mjs';
import { normalizeUrl } from '../src/lib/url-key.mjs';
import { normalizeUrlForDedup } from '../scan.mjs';

console.log('\nURL key — ADR 0004 path-casing decision (characterisation)');

const eq = (label, actual, expected) => {
  if (actual === expected) pass(label);
  else fail(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};
const isTrue = (label, cond) => (cond ? pass(label) : fail(label));

// ── 1. The winner: src/lib/url-key.mjs preserves path case ──────────────────

// Two Greenhouse postings that differ only in path casing. This is the incident
// src/lib/url-key.mjs:23-28 documents: a case-folding key merged them, and the merge is
// not recoverable from the tracker afterwards.
const CASED = 'https://boards.greenhouse.io/Acme/Jobs/4012345';
const FOLDED = 'https://boards.greenhouse.io/acme/jobs/4012345';
isTrue('winner: two path spellings are two keys (no silent merge)',
  normalizeUrl(CASED) !== normalizeUrl(FOLDED));
eq('winner: the path is returned verbatim',
  normalizeUrl(CASED), 'https://boards.greenhouse.io/Acme/Jobs/4012345');

// Host case IS folded — RFC 3986 §6.2.2 syntax-based normalization, always safe.
eq('winner: the host is lowercased',
  normalizeUrl('https://Boards.Greenhouse.IO/Acme/Jobs/1'),
  'https://boards.greenhouse.io/Acme/Jobs/1');

// http and https are the same posting; the fragment never identifies one.
eq('winner: http is forced to https, the fragment dropped',
  normalizeUrl('http://x.test/Jobs/1#apply'), 'https://x.test/Jobs/1');

// One trailing slash, never the root.
eq('winner: one trailing slash is dropped', normalizeUrl('https://x.test/Jobs/1/'), 'https://x.test/Jobs/1');
eq('winner: the root slash survives', normalizeUrl('https://x.test/'), 'https://x.test/');

// ADR 0004 #8: '' means NO KEY. A placeholder is a missing value, not a value
// that can match another missing value.
eq('winner: a placeholder yields no key', normalizeUrl('N/A'), '');
eq('winner: a non-http scheme yields no key', normalizeUrl('local:jds/acme.md'), '');
eq('winner: an empty input yields no key', normalizeUrl('   '), '');
eq('winner: a non-string yields no key', normalizeUrl(null), '');

// Tracking params go; functional ones stay. gh_jid is the canonical posting id
// on some corporate-hosted Greenhouse boards, so stripping it would merge every
// role on that board.
eq('winner: tracking params are stripped, gh_jid kept',
  normalizeUrl('https://x.test/Jobs/1?utm_source=li&gh_jid=99&fbclid=z'),
  'https://x.test/Jobs/1?gh_jid=99');
eq('winner: query order does not change the key',
  normalizeUrl('https://x.test/Jobs/1?b=2&a=1'), normalizeUrl('https://x.test/Jobs/1?a=1&b=2'));
// Deliberately NOT stripped — functional on some boards (src/lib/url-key.mjs:24-26).
eq('winner: ref/src/source are kept',
  normalizeUrl('https://x.test/Jobs/1?ref=abc'), 'https://x.test/Jobs/1?ref=abc');

// ── 2. scan.mjs, recorded as it stands today ────────────────────────

// FLIPPED with the code change. scan.mjs lowercased the path until ADR 0004,
// on the argument that scan.mjs and scan-ats-full.mjs run as separate processes
// and can produce different casing for one posting (#2089), so a case-sensitive
// key lands the same role in pipeline.md twice. That is a real failure and the
// ADR still ruled against it, because the two failures differ in KIND: folding
// the case MERGES two distinct postings, and the loser is never written and
// leaves no trace, which is unrecoverable; preserving it leaves a duplicate row,
// which is visible and the user can delete. A recoverable failure beats a silent
// one, so the cross-source duplicate is the accepted cost.
eq('scan.mjs preserves the path case (ADR 0004)',
  normalizeUrlForDedup('https://x.test/Jobs/Senior-Engineer'), 'https://x.test/Jobs/Senior-Engineer');
isTrue('scan.mjs keeps two path spellings as two keys — no silent merge',
  normalizeUrlForDedup(CASED) !== normalizeUrlForDedup(FOLDED));
eq('scan.mjs still folds the host — DNS is case-insensitive, safe either way',
  normalizeUrlForDedup('https://X.TEST/Jobs/1'), 'https://x.test/Jobs/1');

// Still divergent. These are the ADR 0004 items the casing flip does NOT settle.
eq('PRE-CONSOLIDATION loser: a placeholder becomes its own key, not no key',
  normalizeUrlForDedup('N/A'), 'N/A');
eq('PRE-CONSOLIDATION loser: ref is stripped',
  normalizeUrlForDedup('https://x.test/jobs/1?ref=abc'), 'https://x.test/jobs/1');
eq('PRE-CONSOLIDATION loser: the scheme is left as it arrived',
  normalizeUrlForDedup('http://x.test/jobs/1'), 'http://x.test/jobs/1');
eq('PRE-CONSOLIDATION loser: every trailing slash is dropped',
  normalizeUrlForDedup('https://x.test/jobs/1///'), 'https://x.test/jobs/1');

// The behaviour both keep, and the reason the identity risk is real either way:
// query VALUES stay cased, because they can be the posting id.
eq('both: query values keep their case (winner)',
  normalizeUrl('https://x.test/Jobs/1?gh_jid=AbC'), 'https://x.test/Jobs/1?gh_jid=AbC');
eq('both: query values keep their case (scan.mjs)',
  normalizeUrlForDedup('https://x.test/Jobs/1?gh_jid=AbC'), 'https://x.test/Jobs/1?gh_jid=AbC');
