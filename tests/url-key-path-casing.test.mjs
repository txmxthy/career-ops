// tests/url-key-path-casing.test.mjs — the ADR 0004 URL-path-casing decision,
// pinned on both sides of the divergence it settles.
//
// docs/audit/duplicate-functionality.md records two contradictory contracts for
// the same question, each citing a real incident:
//
//   scan.mjs:1039-1041   "path casing is not meaningfully distinct for any
//                         provider these scanners target" — and lowercases the
//                         path at :1067.
//   src/lib/url-key.mjs:6-36     calls exactly that the over-normalization that
//                         collapsed two different Greenhouse postings into one
//                         key, and preserves path case.
//
// ADR 0004 resolves it: PRESERVE PATH CASE. The failure modes are asymmetric.
// Lowercasing risks MERGING two distinct postings — silent, unrecoverable data
// loss. Preserving risks a DUPLICATE ROW for one posting — visible, and the
// user can fix it. src/lib/url-key.mjs:55 is the winner; scan.mjs's lowercasing is the
// loser and is scheduled for removal when the two normalizers consolidate.
//
// This file is the characterisation test that consolidation will be refactored
// against. It has two halves:
//
//   1. The WINNER's contract, asserted directly. These assertions survive the
//      consolidation unchanged — they are what the merged implementation must
//      keep doing.
//   2. The LOSER's current behaviour, recorded so the change is visible in a
//      diff rather than inferred from a passing suite. Each is labelled
//      PRE-CONSOLIDATION; when scan.mjs adopts the winner these flip, and they
//      must flip in the same commit that makes the change.
//
// The two normalizers also disagree on three further points that ADR 0004 has
// already decided (empty-key contract #8, the `ref`/`src`/`source` denylist,
// forced https). Those are pinned here too, because the same consolidation
// moves all of them at once and a test that covered only the casing question
// would let the others change unremarked.
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

// ── 2. The loser: scan.mjs, recorded as it stands today ─────────────

eq('PRE-CONSOLIDATION loser: scan.mjs lowercases the path',
  normalizeUrlForDedup('https://x.test/Jobs/Senior-Engineer'), 'https://x.test/jobs/senior-engineer');
isTrue('PRE-CONSOLIDATION loser: two path spellings collapse to one key',
  normalizeUrlForDedup(CASED) === normalizeUrlForDedup(FOLDED));
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
eq('both: query values keep their case (loser)',
  normalizeUrlForDedup('https://x.test/jobs/1?gh_jid=AbC'), 'https://x.test/jobs/1?gh_jid=AbC');
