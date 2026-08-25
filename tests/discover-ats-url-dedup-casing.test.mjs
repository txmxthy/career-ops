// tests/discover-ats-url-dedup-casing.test.mjs — records src/scripts/discover-ats.mjs's
// portal dedupe key, and specifically its URL path casing.
//
// ADR 0004 resolves URL path casing by PRESERVING case, and the consolidation
// onto src/core/text.js has now applied it here. The decision was deliberate
// and it is worth restating why, because the losing side had a real argument:
// folding the case catches a board reached through two differently-cased URLs.
//
// It lost on the asymmetry of the two failures. Lowercasing MERGES two boards
// that differ only in path case into one key, and the losing board is then
// simply never tracked — nothing in portals.yml records that it was ever found,
// so the loss is silent and unrecoverable. Preserving the case admits a
// duplicate portal entry, which is visible in the file and deletable. A
// recoverable failure beats a silent one.
//
// This site has a second reason of its own: Ashby board slugs are
// case-sensitive, which is why buildCandidates preserves an explicit mixed-case
// slug (`jobs.ashbyhq.com/DeepL`, asserted in tests/discover-ats.test.mjs).
// Folding the case in the dedupe key threw that distinction away one step later.
//
// The earlier version of this file pinned the LOSING behaviour and said so.
// The assertion below is the flip, in the same commit as the code change.
import { pass, fail } from './helpers.mjs';
import { dedupeAgainstPortals } from '../src/scripts/discover-ats.mjs';

console.log('\ndiscover-ats.mjs — portal dedupe URL casing');

// Two board tokens differing ONLY in path case.
const existing = [{ name: 'Acme', careers_url: 'https://boards.greenhouse.io/AcmeCorp' }];
const matches = [{ name: 'Acme Rival', careers_url: 'https://boards.greenhouse.io/acmecorp' }];

const { fresh, duplicates } = dedupeAgainstPortals(matches, existing);

// Path case is PRESERVED, so these are two boards, not one. `AcmeCorp` and
// `acmecorp` are distinct slugs on a case-sensitive board vendor.
if (fresh.length === 1 && duplicates.length === 0) {
  pass('path case is preserved — two boards differing only by path case stay two entries (ADR 0004)');
} else if (duplicates.length === 1 && fresh.length === 0) {
  fail('path case is being folded again — this silently drops one of two distinct boards (ADR 0004)');
} else {
  fail(`unexpected dedupe result: fresh=${fresh.length} duplicates=${duplicates.length}`);
}

// Host casing must fold regardless — DNS is case-insensitive, so this half is
// not part of the ADR 0004 argument and is safe in both contracts.
const hostCase = dedupeAgainstPortals(
  [{ name: 'X', careers_url: 'https://BOARDS.greenhouse.io/acmecorp' }],
  [{ name: 'Y', careers_url: 'https://boards.greenhouse.io/acmecorp' }],
);
if (hostCase.duplicates.length === 1) {
  pass('host case folds — the same board reached through a differently-cased host is one entry');
} else {
  fail('host casing is no longer folded; DNS is case-insensitive so this is a real regression');
}
