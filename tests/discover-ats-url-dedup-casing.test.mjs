// tests/discover-ats-url-dedup-casing.test.mjs — records discover-ats.mjs's
// portal dedupe key, and specifically its URL path casing.
//
// ADR 0004 resolves URL path casing by PRESERVING case: lowercasing risks
// silently merging two distinct postings, which is unrecoverable, while not
// lowercasing risks a visible duplicate row, which the user can fix. It names
// scan.mjs:1067 as the loser.
//
// discover-ats.mjs:402 normalizeUrl lowercases the WHOLE careers_url, path
// included — the same over-normalization, at a site the ADR does not name. It
// is left as-is deliberately: this dedupes company BOARD urls against
// portals.yml rather than individual postings, and flipping it would newly
// admit duplicate portal entries for existing users with no ADR mandate.
//
// This test does not endorse the behaviour. It pins it, so the divergence is
// visible and any future consolidation onto src/core/text.js has to decide it
// on purpose rather than inherit it.
import { pass, fail } from './helpers.mjs';
import { dedupeAgainstPortals } from '../discover-ats.mjs';

console.log('\ndiscover-ats.mjs — portal dedupe URL casing');

// Two board tokens differing ONLY in path case.
const existing = [{ name: 'Acme', careers_url: 'https://boards.greenhouse.io/AcmeCorp' }];
const matches = [{ name: 'Acme Rival', careers_url: 'https://boards.greenhouse.io/acmecorp' }];

const { fresh, duplicates } = dedupeAgainstPortals(matches, existing);

// CURRENT behaviour: the path is lowercased, so these collapse to one key and
// the second board is treated as already tracked.
if (duplicates.length === 1 && fresh.length === 0) {
  pass('path case is folded — boards differing only by path case dedupe together (ADR 0004 unresolved at this site)');
} else if (fresh.length === 1 && duplicates.length === 0) {
  fail('path case is now PRESERVED here — intended per ADR 0004, but it is a behaviour change: update this test and note it in the ADR');
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
