/**
 * Characterisation tests for src/core/text.js — the one text/identity/date
 * module, replacing the clusters catalogued in
 * docs/audit/duplicate-functionality.md: status normalization (7),
 * company key (5), URL key (4), slugs (14+2), ASCII folding (13),
 * toEpochMs (27), HTML→text (7), HTML escaping (4).
 *
 * Every input the audit names as behaviourally divergent (D1–D27) has a test
 * here. Where the module deliberately changes what one of the old copies did,
 * the test says so and names the ADR or the audit item — the point of a
 * characterisation test is that the change is visible in the diff rather than
 * inferred from a passing suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asciiFold,
  buildStatusAliasMap,
  daysBetween,
  escapeHtml,
  foldStatus,
  htmlToText,
  normalizeStatus,
  normalizeTextKey,
  parseIsoDate,
  sanitizeUrl,
  slugify,
  toEpochMs,
  today,
  urlKey,
} from '../../src/core/text.js';

// ── normalizeTextKey — identity keys that must not merge distinct entities ──
// Audit §2 (company key), ADR 0004 #3. Winner: tracker-parse.mjs:434.

test('normalizeTextKey folds case and drops punctuation', () => {
  assert.equal(normalizeTextKey('Acme Inc.'), 'acmeinc');
});

test('normalizeTextKey with a separator keeps word boundaries', () => {
  // scan.mjs keys role titles space-separated so "engineer (senior)" and
  // "engineer, senior" collapse without "data engineer" and "dataengineer"
  // merging. Same rule, different shape — not a second implementation.
  assert.equal(normalizeTextKey('Acme Inc.', ' '), 'acme inc');
  assert.notEqual(normalizeTextKey('data engineer', ' '), normalizeTextKey('dataengineer', ' '));
});

test('normalizeTextKey folds the Turkish dotted capital (#2705)', () => {
  // 'İ'.toLowerCase() is `i` + U+0307, so these read identically and keyed
  // differently — one employer counted as two, with nothing on screen to
  // explain why.
  assert.equal(normalizeTextKey('İstanbul Tekstil'), normalizeTextKey('Istanbul Tekstil'));
});

test('normalizeTextKey does NOT decompose: Żubr, Ėmė and Ġenerali stay distinct', () => {
  // The structural safety property. NFD → strip → NFC looks equivalent and is
  // not: it collapses Polish, Lithuanian and Maltese letters onto their bare
  // Latin base. NFKC leaves them as single precomposed code points, which the
  // U+0307 strip cannot reach.
  assert.notEqual(normalizeTextKey('Żubr'), normalizeTextKey('Zubr'));
  assert.notEqual(normalizeTextKey('Ėmė'), normalizeTextKey('Eme'));
  assert.notEqual(normalizeTextKey('Ġenerali'), normalizeTextKey('Generali'));
});

test('normalizeTextKey keeps non-Latin script — bug #2500 stays fixed', () => {
  // The `[^a-z0-9]+` form in src/scripts/company-funded.mjs deleted every
  // non-Latin character, so アクメ株式会社, グロベックス合同会社 and Яндекс all
  // keyed to '' and three unrelated employers compared equal.
  const keys = ['アクメ株式会社', 'グロベックス合同会社', 'Яндекс'].map((n) => normalizeTextKey(n));
  for (const k of keys) assert.notEqual(k, '', 'a non-Latin name must still produce a key');
  assert.equal(new Set(keys).size, 3, 'three distinct employers must produce three distinct keys');
});

test('normalizeTextKey keeps combining marks — Devanagari कंपनी ≠ कपनी (D16/D17)', () => {
  // Indic matras have no precomposed form, so stripping \p{M} would merge two
  // different words. src/scripts/rejection-latency.mjs's `[^\p{L}\p{N}]` does
  // exactly that and merged two employers' latencies.
  assert.notEqual(normalizeTextKey('कंपनी'), normalizeTextKey('कपनी'));
});

test('normalizeTextKey maps an absent value to the empty key, not to "null"', () => {
  // String(value) would key null and undefined to the literal strings
  // "null"/"undefined", which compare equal and form a bogus group.
  assert.equal(normalizeTextKey(null), '');
  assert.equal(normalizeTextKey(undefined), '');
  assert.equal(normalizeTextKey('   '), '');
});

test('normalizeTextKey compares full-width and half-width forms equal (NFKC)', () => {
  assert.equal(normalizeTextKey('ＡＣＭＥ'), normalizeTextKey('ACME'));
});

// ── foldStatus — the status-alias fold ──────────────────────────────────────
// Audit §1 / §5 H. Winner: tracker-utils.mjs:660 foldStatusInput.

test('foldStatus strips bold markers and folds case', () => {
  assert.equal(foldStatus('**Applied**'), 'applied');
  assert.equal(foldStatus('  REJECTED  '), 'rejected');
});

test('foldStatus is Turkish-safe: TEKLİF folds to teklif (#2704)', () => {
  // A bare toLowerCase leaves `tekli` + U+0307 + `f`, which equals no alias
  // anyone would ever write, so every all-caps Turkish row missed every alias.
  assert.equal(foldStatus('TEKLİF'), 'teklif');
});

test('foldStatus does not decompose either — Żubr keeps its dot', () => {
  assert.equal(foldStatus('Żubr'), 'żubr');
});

test('foldStatus maps an absent value to the empty string', () => {
  assert.equal(foldStatus(null), '');
  assert.equal(foldStatus(undefined), '');
});

// ── normalizeStatus — ADR 0004 #4 ───────────────────────────────────────────
// Winner: followup-cadence.mjs:139. templates/states.yml is the single alias
// source, so the map is INJECTED — how a caller loads states.yml stays the
// caller's decision, exactly as src/core/table.js takes its alias table as data.

const STATES = [
  { id: 'applied', label: 'Applied', aliases: ['enviado', 'postulado'] },
  { id: 'rejected', label: 'Rejected', aliases: ['rechazado', 'RED'] },
  { id: 'offer', label: 'Offer', aliases: ['teklif'] },
];
const ALIASES = buildStatusAliasMap(STATES);

test('buildStatusAliasMap keys id, label and every alias to the canonical id', () => {
  assert.equal(ALIASES.get('applied'), 'applied');
  assert.equal(ALIASES.get('enviado'), 'applied');
  assert.equal(ALIASES.get('rechazado'), 'rejected');
  assert.equal(ALIASES.get('red'), 'rejected');
});

test('buildStatusAliasMap folds its own keys, so a Turkish alias is reachable', () => {
  assert.equal(normalizeStatus('TEKLİF', ALIASES), 'offer');
});

test('buildStatusAliasMap degrades to an empty map, never to a hardcoded copy', () => {
  // A missing/malformed states.yml is a broken install. followup-cadence.mjs
  // states the reasoning: "a fallback copy is the same copy in disguise and
  // drifts the same way." An empty map means identity normalization.
  const empty = buildStatusAliasMap([]);
  assert.equal(empty.size, 0);
  assert.equal(normalizeStatus('Applied', empty), 'applied');
});

test('normalizeStatus resolves a Spanish alias — the dedup ranker stops seeing it as unknown', () => {
  // src/scripts/dedup-tracker.mjs:88 had no alias map at all, so a
  // Spanish-language tracker row reached the ranker as an unrecognized status.
  assert.equal(normalizeStatus('Enviado', ALIASES), 'applied');
});

test('normalizeStatus strips a TRAILING date and everything after it', () => {
  assert.equal(normalizeStatus('Applied 2026-01-02 — recruiter', ALIASES), 'applied');
});

test('normalizeStatus keeps a PARENTHESISED inline date — the trailing-only regex wins (D3)', () => {
  // Two contracts existed: /\s+\d{4}-\d{2}-\d{2}.*$/ (trailing only, 5 copies)
  // and /\(?\d{4}-\d{2}-\d{2}\)?/g (global, unanchored, tracker.mjs:149).
  // ADR 0004 #4 picks followup-cadence.mjs, which is the trailing-only form, so
  // an inline parenthesised date is left in the value rather than excised.
  assert.equal(normalizeStatus('Applied (2026-01-02) — recruiter', ALIASES), 'applied (2026-01-02) — recruiter');
});

test('normalizeStatus returns the cleaned input for an unknown status, never null (D2)', () => {
  // Deliberate: tracker.mjs:145 returned null. A caller written against one and
  // passed the other silently changes from "unknown status" to "status named
  // <garbage>". ADR 0004 picks the identity contract; tracker.mjs's callers
  // must test for a value that is not a canonical id instead of for null.
  assert.equal(normalizeStatus('Ghosted by the recruiter', ALIASES), 'ghosted by the recruiter');
  assert.equal(normalizeStatus('', ALIASES), '');
});

test('normalizeStatus works with a plain object alias table as well as a Map', () => {
  assert.equal(normalizeStatus('Enviado', { enviado: 'applied' }), 'applied');
});

// ── asciiFold — fold to an ASCII target ─────────────────────────────────────
// Audit §5 canonical 1. Winner: lib/ascii-fold.mjs:54.

test('asciiFold produces the slug an ATS board actually uses (#2924/#2930)', () => {
  assert.equal(asciiFold('Société Générale'), 'societe generale');
  assert.equal(asciiFold('Telefónica'), 'telefonica');
});

test('asciiFold handles Latin letters NFD does not decompose (D14)', () => {
  // A stroke or bar through a letter is part of the GLYPH, so NFD leaves it and
  // a bare [^a-z0-9] strip then deletes the letter outright.
  assert.equal(asciiFold('Đại Việt Engineer'), 'dai viet engineer');
  assert.equal(asciiFold('Ørsted'), 'orsted');
  assert.equal(asciiFold('Æon'), 'aeon');
  assert.equal(asciiFold('Işık'), 'isik');
  assert.equal(asciiFold('Ħamrun'), 'hamrun');
  assert.equal(asciiFold('Ŋaro'), 'ngaro', 'ŋ is "ng"; the one-to-one mapping is the wrong one');
});

test('asciiFold punctuation option changes the WORD count, not just the spelling (#3040)', () => {
  // `smith` substring-matches smithfield.com, so a caller that then matches
  // words gains words it never had. The caller states which it needs.
  assert.equal(asciiFold('Smith&Jones'), 'smith jones');
  assert.equal(asciiFold('Smith&Jones', { punctuation: 'delete' }), 'smithjones');
});

test('asciiFold returns the empty string when nothing Latin survives', () => {
  // A real answer, not a failure: no ASCII target can contain it.
  assert.equal(asciiFold('株式会社アクメ'), '');
  assert.equal(asciiFold('Яндекс'), '');
});

// ── slugify — the filesystem/display slug ───────────────────────────────────
// Audit §4 canonical 1: src/scripts/application-artifacts.mjs:20
// slugifySegment, plus an asciiFold pre-pass and an explicit maxLength.

test('slugify folds to ASCII first — the D9 five-way disagreement collapses to one answer', () => {
  // The eight `[^a-z0-9]+` copies gave "soci-t-g-n-rale"; the two `\w` copies
  // gave "socit-gnrale"; company-funded gave "socitgnrale". None of them is a
  // slug any board or human uses. This is the deliberate change.
  assert.equal(slugify('Société Générale'), 'societe-generale');
});

test('slugify treats "_" as a separator, so Acme_Corp and "Acme Corp" agree (D10)', () => {
  assert.equal(slugify('Acme_Corp'), 'acme-corp');
  assert.equal(slugify('Acme Corp'), 'acme-corp');
  assert.equal(slugify('C_plus_plus Engineer'), 'c-plus-plus-engineer');
});

test('slugify trims separator runs rather than emitting leading/trailing dashes', () => {
  assert.equal(slugify('  --Senior  Engineer!!  '), 'senior-engineer');
});

test('slugify returns the caller-supplied fallback when nothing survives (D12)', () => {
  // Every impl had a different fallback ('', 'unknown', 'application', 'role',
  // 'job'), and src/scripts/application-artifacts.mjs's 'application' collided
  // with the fallback for a MISSING company. The fallback is the caller's, and
  // the default is '' so a caller that does not choose one cannot silently
  // inherit somebody else's collision.
  assert.equal(slugify('株式会社アクメ'), '');
  assert.equal(slugify('株式会社アクメ', { fallback: 'company' }), 'company');
  assert.equal(slugify('', { fallback: 'role' }), 'role');
  assert.equal(slugify(null, { fallback: 'role' }), 'role');
});

test('slugify maxLength never leaves a trailing dash (D11)', () => {
  // src/scripts/archive-posting.mjs sliced at 60 unconditionally and then built
  // "2026-06-20__.pdf" out of the remains.
  assert.equal(slugify('senior staff software engineer', { maxLength: 17 }), 'senior-staff');
  assert.equal(slugify('senior staff software engineer', { maxLength: 12 }), 'senior-staff');
});

test('slugify applies the fallback AFTER truncation, so a cap cannot yield an empty slug', () => {
  // src/scripts/outcome.mjs:52 applied `|| 'unknown'` after .slice(0,60) and
  // src/scripts/archive-posting.mjs:177 did not — same input, two answers.
  assert.equal(slugify('!!!!!!!!!!', { maxLength: 4, fallback: 'unknown' }), 'unknown');
});

test('slugify without folding keeps the old delete-the-accent behaviour available', () => {
  // Kept as an option because a caller comparing against an EXISTING on-disk
  // key cannot change its answer without renaming the directory.
  assert.equal(slugify('Société Générale', { fold: false }), 'soci-t-g-n-rale');
});

// ── urlKey — ADR 0004's URL path-casing decision ────────────────────────────

test('urlKey PRESERVES path case — ADR 0004 chose this deliberately', () => {
  // The asymmetry is the whole argument. Lowercasing the path silently MERGES
  // two distinct postings into one key, and the merge is unrecoverable from the
  // tracker afterwards. Not lowercasing produces a visible duplicate row, which
  // the user can see and fix. A recoverable failure beats a silent one.
  const cased = 'https://boards.greenhouse.io/Acme/Jobs/4012345';
  const folded = 'https://boards.greenhouse.io/acme/jobs/4012345';
  assert.notEqual(urlKey(cased), urlKey(folded), 'two path spellings must stay two keys');
  assert.equal(urlKey(cased), 'https://boards.greenhouse.io/Acme/Jobs/4012345');
});

test('urlKey lowercases the HOST — DNS is case-insensitive, so this half is safe', () => {
  // RFC 3986 §6.2.2 syntax-based normalization. Not part of the casing argument.
  assert.equal(urlKey('https://Boards.Greenhouse.IO/Acme/Jobs/1'), 'https://boards.greenhouse.io/Acme/Jobs/1');
});

test('urlKey forces https and drops the fragment', () => {
  assert.equal(urlKey('http://x.test/Jobs/1#apply'), 'https://x.test/Jobs/1');
});

test('urlKey drops one trailing slash but never the root slash', () => {
  assert.equal(urlKey('https://x.test/Jobs/1/'), 'https://x.test/Jobs/1');
  assert.equal(urlKey('https://x.test/'), 'https://x.test/');
});

test("urlKey returns '' for anything that is not a keyable posting (ADR 0004 #8)", () => {
  // '' means NO KEY. A placeholder is a sentinel for a MISSING value, and SQL's
  // three-valued logic is the settled answer: NULL is never equal to NULL.
  // Returning s.toLowerCase() gave every "N/A" row one shared key, so unrelated
  // employers compared equal on it.
  for (const bad of ['N/A', 'TBD', '—', 'local:jds/acme.md', 'ftp://x.test/j', '', '   ', null, undefined, 42]) {
    assert.equal(urlKey(bad), '', `${JSON.stringify(bad)} must not become a key`);
  }
});

test('urlKey strips tracking params and keeps functional ones', () => {
  // gh_jid is the canonical posting id on some corporate-hosted Greenhouse
  // boards, so stripping it would merge every role on that board.
  assert.equal(urlKey('https://x.test/Jobs/1?utm_source=li&gh_jid=99&fbclid=z'), 'https://x.test/Jobs/1?gh_jid=99');
  assert.equal(urlKey('https://x.test/Jobs/1?ref=abc'), 'https://x.test/Jobs/1?ref=abc');
});

test('urlKey sorts the surviving query, so input order does not change the key', () => {
  assert.equal(urlKey('https://x.test/Jobs/1?b=2&a=1'), urlKey('https://x.test/Jobs/1?a=1&b=2'));
});

test('urlKey keeps query VALUE casing — a value can be the posting id', () => {
  assert.equal(urlKey('https://x.test/Jobs/1?gh_jid=AbC'), 'https://x.test/Jobs/1?gh_jid=AbC');
});

// ── escapeHtml / sanitizeUrl ────────────────────────────────────────────────
// Audit §8. Winner on D27: src/scripts/build-cv-html.mjs:66.

test('escapeHtml covers the five characters that change meaning in markup', () => {
  assert.equal(escapeHtml(`R&D "north star" <b>10x</b> 'x'`), 'R&amp;D &quot;north star&quot; &lt;b&gt;10x&lt;/b&gt; &#39;x&#39;');
});

test('escapeHtml renders a falsy SCALAR rather than blanking it (D27)', () => {
  // src/scripts/generate-cover-letter.mjs:84 returned '' for any falsy value, so
  // a payload with `year: 2024` rendered but `count: 0` silently vanished while
  // `present` stayed true.
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});

test('escapeHtml blanks only structurally absent values', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml({}), '');
});

test('sanitizeUrl rejects an explicit disallowed scheme', () => {
  assert.equal(sanitizeUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeUrl('data:text/html;base64,PHNjcmlwdD4='), '');
});

test('sanitizeUrl coerces a bare email to mailto: and a bare domain to https:', () => {
  assert.equal(sanitizeUrl('me@example.com'), 'mailto:me@example.com');
  assert.equal(sanitizeUrl('example.com/cv'), 'https://example.com/cv');
});

test('sanitizeUrl takes its scheme allowlist from the caller', () => {
  // The HTML contact row allows tel:; the LaTeX \href does not. Same allowlist
  // mechanism, two different lists — which is why it is a parameter.
  assert.equal(sanitizeUrl('tel:+123'), 'tel:+123');
  assert.equal(sanitizeUrl('tel:+123', { schemes: ['mailto:', 'http:', 'https:'] }), '');
});

test('sanitizeUrl does NOT escape — the output context decides that', () => {
  // src/scripts/build-cv-html.mjs escapes for an attribute; lib/latex-escape.mjs
  // strips LaTeX metacharacters. Folding either in here would corrupt the other.
  assert.equal(sanitizeUrl('https://x.test/a?b=1&c=2'), 'https://x.test/a?b=1&c=2');
});

// ── htmlToText ──────────────────────────────────────────────────────────────
// Audit §7. Winner: providers/_html-to-text.mjs:28, absorbing personio's
// fixed-point loop and workable's block→newline handling.

test('htmlToText removes script and style bodies (D24)', () => {
  // The description is what content_filter / visa_filter substring-match
  // against, so injected script text could satisfy or veto a filter.
  assert.equal(htmlToText('<p>Hi</p><script>var x = "Senior Engineer";</script>'), 'Hi');
  assert.equal(htmlToText('<style>.a{content:"Senior"}</style><p>Hi</p>'), 'Hi');
});

test('htmlToText double-decodes, so entity-escaped markup is stripped too', () => {
  assert.equal(htmlToText('&lt;p&gt;R&amp;amp;D Engineer&lt;/p&gt;'), 'R&D Engineer');
});

test('htmlToText decodes text-level entities (D26)', () => {
  // providers/personio.mjs and providers/jobbankca.mjs never decoded, so a
  // content_filter for "R&D" missed on those two boards.
  assert.equal(htmlToText('<p>R&amp;D Engineer</p>'), 'R&D Engineer');
});

test('htmlToText strips nested tags to a fixed point (D26, js/incomplete-sanitization)', () => {
  // A single global replace only removes non-overlapping matches in one
  // left-to-right sweep, so adversarial nesting can leave a `<`-fragment that
  // the next pass reveals as a tag. The contract asserted here is the one that
  // matters to the caller: no <tag> survives, whatever the nesting.
  const out = htmlToText('<<div>div>Senior<</div>/div><p>Engineer</p>');
  assert.equal(/<[^>]*>/.test(out), false, 'a <tag> survived the strip');
  assert.match(out, /Senior/);
  assert.match(out, /Engineer/);
});

test('htmlToText caps the description, and the cap is a parameter (D25)', () => {
  // A 40 KB Workable description entered the scan payload whole on six of the
  // seven implementations.
  assert.equal(htmlToText(`<p>${'a'.repeat(5000)}</p>`).length, 4000);
  assert.equal(htmlToText(`<p>${'a'.repeat(5000)}</p>`, { cap: 10 }).length, 10);
  assert.equal(htmlToText(`<p>${'a'.repeat(5000)}</p>`, { cap: 0 }).length, 5000);
});

test('htmlToText can preserve block structure as newlines (workable)', () => {
  const html = '<p>First</p><p>Second</p><ul><li>A</li><li>B</li></ul>';
  assert.equal(htmlToText(html), 'First Second A B');
  assert.equal(htmlToText(html, { blockNewlines: true }), 'First\nSecond\nA\nB');
});

test('htmlToText maps a non-string to the empty string', () => {
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
  assert.equal(htmlToText(42), '');
});

// ── today — LOCAL day, with the timezone pinned ─────────────────────────────
// Audit Part III §1, D1. Winner: lib/local-today.mjs:27.

/**
 * Run `fn` with the process timezone pinned, then restore it.
 *
 * The window where the UTC day and the local day disagree only exists for part
 * of the UTC day, so a test that reads the ambient zone passes for most of the
 * day regardless of the bug — which is how this survived two previous fixes.
 * Restoring in a finally is not optional: tests/run-all.mjs discovers this file
 * in-process, and a leaked TZ would silently re-date every later suite.
 */
function withTimezone(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('today answers with the local day west of Greenwich, where UTC is already tomorrow', () => {
  withTimezone('America/New_York', () => {
    // 2026-06-20 22:00 in New York. toISOString().slice(0,10) says 2026-06-21.
    const instant = new Date('2026-06-21T02:00:00Z');
    assert.equal(instant.toISOString().slice(0, 10), '2026-06-21', 'the UTC day really is the next one');
    assert.equal(today(instant), '2026-06-20');
  });
});

test('today answers with the local day east of Greenwich, where UTC is still yesterday', () => {
  withTimezone('Pacific/Kiritimati', () => {
    // The user's own today read as a FUTURE date, so a check that rejects future
    // dates rejected the present one (#2932).
    const instant = new Date('2026-06-20T22:00:00Z');
    assert.equal(instant.toISOString().slice(0, 10), '2026-06-20');
    assert.equal(today(instant), '2026-06-21');
  });
});

test('today zero-pads the month and day', () => {
  withTimezone('UTC', () => {
    assert.equal(today(new Date('2026-01-05T12:00:00Z')), '2026-01-05');
  });
});

// ── parseIsoDate ────────────────────────────────────────────────────────────
// Audit Part III §2, D4. Winner: src/scripts/check-table-freshness.mjs:105.

test('parseIsoDate anchors at UTC midnight', () => {
  const d = parseIsoDate('2026-06-20');
  assert.equal(d.toISOString(), '2026-06-20T00:00:00.000Z');
});

test('parseIsoDate REJECTS an impossible calendar date (D4)', () => {
  // src/scripts/funnel-velocity.mjs:87 accepted "2026-02-31" and rolled it to
  // 2026-03-03, so a typo'd ledger row silently shifted a stage duration by
  // three days instead of being dropped.
  assert.equal(parseIsoDate('2026-02-31'), null);
  assert.equal(parseIsoDate('2026-13-45'), null);
});

test('parseIsoDate rejects anything that is not a bare YYYY-MM-DD', () => {
  for (const bad of ['2026-6-20', '20260620', '2026-06-20T00:00:00Z', 'yesterday', '', '   ', null, undefined, 0]) {
    assert.equal(parseIsoDate(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('parseIsoDate tolerates surrounding whitespace', () => {
  assert.equal(parseIsoDate('  2026-06-20 ').toISOString().slice(0, 10), '2026-06-20');
});

// ── daysBetween ─────────────────────────────────────────────────────────────
// Audit Part III §3, D6–D8. Winner: src/scripts/rejection-latency.mjs:149,
// generalized to take strings or Dates and to return an integer.

test('daysBetween compares CALENDAR days, so an afternoon "now" does not tip the count (D6)', () => {
  // The real call shape is a parsed posting date (UTC midnight) against wall
  // clock now. Subtracting raw timestamps and rounding tips one day early after
  // noon UTC: floor gave 10, round gave 11, for the same pair of instants.
  const from = new Date('2026-06-01T00:00:00Z');
  const to = new Date('2026-06-11T18:00:00Z');
  assert.equal(daysBetween(from, to), 10);
});

test('daysBetween accepts strings and Dates interchangeably (D8)', () => {
  // Two functions shared the name `daysBetween` and disagreed on the argument
  // type: src/scripts/funnel-velocity.mjs took strings, followup-cadence.mjs
  // took Dates. A naive merge silently broke one of them.
  assert.equal(daysBetween('2026-06-01', '2026-06-11'), 10);
  assert.equal(daysBetween(new Date('2026-06-01T00:00:00Z'), '2026-06-11'), 10);
});

test('daysBetween returns an integer, never a fraction (D7)', () => {
  const n = daysBetween('2026-06-01', new Date('2026-06-11T18:00:00Z'));
  assert.equal(Number.isInteger(n), true);
});

test('daysBetween is signed — a later "from" gives a negative count', () => {
  assert.equal(daysBetween('2026-06-11', '2026-06-01'), -10);
  assert.equal(daysBetween('2026-06-01', '2026-06-01'), 0);
});

test('daysBetween returns null when either side is not a date', () => {
  // Not NaN: NaN propagates silently through comparisons and reports a
  // confident-looking number downstream.
  assert.equal(daysBetween('2026-02-31', '2026-06-01'), null);
  assert.equal(daysBetween('2026-06-01', null), null);
  assert.equal(daysBetween(undefined, undefined), null);
});

test('daysBetween crosses a DST boundary without gaining or losing a day', () => {
  withTimezone('America/New_York', () => {
    // 2026-03-08 is the US spring-forward. UTC-midnight anchoring makes this
    // arithmetic independent of the host zone; a local-midnight version would
    // return 6.96 days here.
    assert.equal(daysBetween('2026-03-05', '2026-03-12'), 7);
  });
});

// ── toEpochMs ───────────────────────────────────────────────────────────────
// Audit Part III §6, D20–D23. Winner: the V3 body (joinup/getro/consider),
// with the return changed to `undefined` to match the 24-file majority.

test('toEpochMs parses an ISO date string', () => {
  assert.equal(toEpochMs('2026-06-20T00:00:00Z'), Date.parse('2026-06-20T00:00:00Z'));
});

test('toEpochMs promotes Unix SECONDS to milliseconds', () => {
  assert.equal(toEpochMs(1_750_000_000), 1_750_000_000_000);
});

test('toEpochMs treats exactly 1e12 as milliseconds, not seconds (D20)', () => {
  // providers/meituan.mjs used a strict `>`, so 1e12 became 1e15 — the year
  // 33658, which passes every "is it newer than the cutoff" filter forever.
  assert.equal(toEpochMs(1_000_000_000_000), 1_000_000_000_000);
});

test('toEpochMs accepts a number without silently losing it (D23)', () => {
  // Date.parse(1750000000000) is NaN, so the 17-file V1 variant lost EVERY
  // postedAt with no error the moment an upstream switched to epoch ms.
  assert.equal(toEpochMs(1_750_000_000_000), 1_750_000_000_000);
});

test('toEpochMs does NOT number-coerce a date-like string (D21)', () => {
  // providers/himalayas.mjs ran Number(value) before Date.parse, so a year-only
  // date "2024" became 2024 seconds — 1970-01-01T00:33:44Z — while every other
  // provider read it as 2024-01-01.
  assert.equal(toEpochMs('2024'), Date.parse('2024'));
  assert.notEqual(toEpochMs('2024'), 2_024_000);
});

test('toEpochMs returns undefined for an absent value (D22)', () => {
  // V3 returned null and the other 24 returned undefined. Consumers doing
  // `?? fallback` agree; consumers testing `=== undefined` do not, so the
  // majority contract wins.
  for (const absent of [null, undefined, '', '   ', {}, [], true, NaN]) {
    assert.equal(toEpochMs(absent), undefined, `${JSON.stringify(absent)} must be absent`);
  }
});

test('toEpochMs treats a non-positive instant as missing, not as 1970', () => {
  assert.equal(toEpochMs(0), undefined);
  assert.equal(toEpochMs(-1), undefined);
  assert.equal(toEpochMs('1969-01-01T00:00:00Z'), undefined);
});

test('toEpochMs returns undefined for an unparseable string', () => {
  assert.equal(toEpochMs('not a date'), undefined);
});
