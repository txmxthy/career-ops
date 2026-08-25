/**
 * text.js — the one text normalizer, identity key, slug, URL key and date rule.
 *
 * Replaces the clusters catalogued in docs/audit/duplicate-functionality.md:
 * status normalization (7 implementations, 4 alias sources), company key (5),
 * URL key (4), slug generation (14 + 2), ASCII folding (13 normalizers under 5
 * mutually incompatible policies), toEpochMs (27 copies), HTML→text (7) and
 * HTML escaping (4). ADR 0002 sizes it as one module because these are all the
 * same question — "reduce this text to a comparable form" — asked of different
 * fields, and every time a caller answered it privately the answers diverged.
 *
 * The defect class is quieter than a crash and worse: two normalizers that
 * DISAGREE turn one entity into two (a duplicate row, visible) or two entities
 * into one (a silent merge, unrecoverable). Every choice below is made on that
 * asymmetry, and each one names the incident it comes from.
 *
 * Three different questions live here and must not be confused, because the
 * right answer to each is the wrong answer to the others:
 *
 *   normalizeTextKey — an IDENTITY key that must never merge distinct entities.
 *                      Keeps every script and every combining mark. NFKC only.
 *   asciiFold        — a fold toward an ASCII TARGET (a hostname, an ATS slug),
 *                      where losing the accent IS the intent. NFD, marks gone.
 *   foldStatus       — an ALIAS lookup key over a closed vocabulary.
 *
 * Pure: no I/O, no argv, no process.exit, no console. The status alias table is
 * passed in as data, so how a caller LOADS templates/states.yml stays the
 * caller's decision — the same boundary src/core/table.js draws for its column
 * aliases. Dates live here rather than in a sibling src/core/dates.js because
 * the date section is well under the ~150-line threshold ADR 0002 set for
 * splitting it out.
 *
 * The one import is providers/_html-entities.mjs, which is already the
 * canonical shared decoder (three documented drift incidents: #1555, #1639,
 * #2623) and is not a duplicate this module is meant to absorb.
 */

import { decodeEntities } from '../../providers/_html-entities.mjs';

// ── Identity keys ───────────────────────────────────────────────────────────

/**
 * Unicode-aware grouping key for any free-text field: company, role, agency, via.
 *
 * Keeps letters, digits and combining marks of ANY script. NFKC first so
 * full-width and half-width variants compare equal.
 *
 * Two properties are load-bearing and neither is obvious:
 *
 * 1. NO `NFD`. NFKC leaves ż, ė and ġ as SINGLE precomposed code points, so the
 *    U+0307 strip below cannot reach their dots — while `i` + U+0307 (what
 *    lowercasing the Turkish dotted `İ` produces) has no precomposed form and
 *    stays exposed. Decomposing first looks equivalent and is not: it collapsed
 *    Żubr/Zubr, Ėmė/Eme and Ġenerali/Generali, which is Polish, Lithuanian and
 *    Maltese losing the distinction. The protection is structural, not a list.
 *
 * 2. Combining marks are KEPT (`\p{M}`). NFKC composes Latin diacritics into
 *    single code points, but Indic matras have no precomposed form, so
 *    stripping marks would make Devanagari कंपनी and कपनी the same key.
 *
 * The `[^a-z0-9]+` shape this replaces deleted every non-Latin character, so
 * アクメ株式会社, グロベックス合同会社 and Яндекс all keyed to '' and three
 * unrelated employers compared equal (#2500).
 *
 * @param {*} value - Raw cell value.
 * @param {string} [separator=''] - Replacement for each run of stripped chars.
 *   Passed straight to String.replace, so `$` is special; pass a literal such
 *   as '' or ' '. ' ' is how scan.mjs keys role titles, so "engineer (senior)"
 *   and "engineer, senior" collapse without "data engineer" and "dataengineer"
 *   merging.
 * @returns {string} Case-folded, punctuation-free, script-preserving key.
 */
export function normalizeTextKey(value, separator = '') {
  // `value ?? ''` rather than String(value): a null/undefined cell must key to
  // '' like any other empty field, not to the literal strings "null"/"undefined"
  // — which would compare equal to each other and form a bogus group.
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/̇/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, separator)
    .trim();
}

/**
 * Fold raw status text to the key an alias table is indexed by.
 *
 * Strips the bold markers a hand-edited tracker cell picks up, then folds the
 * same Turkish-safe way as normalizeTextKey: `'İ'.toLowerCase()` is `i` +
 * U+0307 and the mark survives, so `TEKLİF` became `tekli̇f` and every
 * all-caps Turkish row missed every alias (#2704).
 *
 * No canonical state, label or alias legitimately contains U+0307, so dropping
 * it cannot collapse two different states together.
 *
 * @param {*} input - Raw status text.
 * @returns {string} Lowercased, mark-folded, bold/whitespace-stripped status.
 */
export function foldStatus(input) {
  return String(input ?? '')
    .replace(/\*\*/g, '')
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/̇/gu, '');
}

/**
 * Fold a name toward an ASCII comparison target.
 *
 * The opposite decision to normalizeTextKey, for the opposite reason: here the
 * thing being compared against is ASCII by construction (a hostname, an ATS
 * slug), so folding to the base letter IS the intent. "telefonica" is the ASCII
 * folding of "Telefónica" (#2930), and "societe generale" is what the board
 * actually uses (#2924).
 *
 * A name with no Latin content at all (CJK, Cyrillic, Greek) folds to ''. That
 * is a real answer, not a failure: no ASCII target can contain it. Callers
 * decide what '' means for them.
 *
 * @param {*} value - Raw display name.
 * @param {{punctuation?: 'space'|'delete'}} [options]
 * @returns {string} Folded name, or '' when nothing Latin survives.
 */
export function asciiFold(value, { punctuation = 'space' } = {}) {
  let out = String(value ?? '').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  for (const [re, to] of NON_DECOMPOSING_LATIN) out = out.replace(re, to);
  // 'space' turns residual punctuation into a separator, so "Smith&Jones"
  // becomes two words; 'delete' keeps it one. NOT cosmetic (#3040): a caller
  // that then matches WORDS gains words it never had, and `smith` substring-
  // matches smithfield.com, so a company/hostname mismatch that should be
  // flagged silently is not. Slug-style callers converge either way; word-level
  // callers do not, so the caller states which it needs.
  //
  // The 'delete' class is `[^a-z0-9 ]` with a LITERAL space, not `\s`: a tab or
  // newline is removed rather than collapsed.
  out = punctuation === 'delete'
    ? out.replace(/[^a-z0-9 ]/g, '')
    : out.replace(/[^a-z0-9\s]/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Latin letters that do NOT decompose under NFD, so stripping combining marks
 * alone still deletes them. A stroke or bar through a letter is part of the
 * GLYPH, not a combining mark: "Işık" derived "isk" and never "isik", so a
 * portal probe asked for a slug no board uses. ŋ is "ng", not "n" — the
 * plausible one-to-one mapping is the wrong one.
 */
const NON_DECOMPOSING_LATIN = [
  [/ø/g, 'o'], [/æ/g, 'ae'], [/œ/g, 'oe'], [/ß/g, 'ss'],
  [/đ/g, 'd'], [/ł/g, 'l'], [/þ/g, 'th'], [/ð/g, 'd'],
  [/ħ/g, 'h'], [/ı/g, 'i'], [/ŋ/g, 'ng'], [/ŧ/g, 't'],
  [/ĸ/g, 'k'], [/ſ/g, 's'],
];

// ── Status normalization ────────────────────────────────────────────────────

/**
 * Build the alias lookup a status normalizer needs, from already-parsed states.
 *
 * Takes the parsed `templates/states.yml` rather than a path, so this module
 * stays pure and there is exactly one alias SOURCE rather than the four the
 * audit found. A caller with no states (a broken install) passes `[]` and gets
 * an empty map, which degrades normalizeStatus to identity — deliberately, and
 * never to a hardcoded fallback table: a fallback copy is the same copy in
 * disguise and drifts the same way.
 *
 * @param {{id: string, label?: string, aliases?: string[]}[]} states
 * @returns {Map<string, string>} folded spelling → canonical lowercase id.
 */
export function buildStatusAliasMap(states) {
  const map = new Map();
  for (const state of Array.isArray(states) ? states : []) {
    if (!state?.id) continue;
    const id = String(state.id).toLowerCase();
    map.set(foldStatus(id), id);
    if (state.label) map.set(foldStatus(state.label), id);
    for (const alias of state.aliases ?? []) map.set(foldStatus(alias), id);
  }
  return map;
}

/**
 * Reduce a tracker status cell to its canonical id.
 *
 * Two contracts existed for the date strip. This is the trailing-only form:
 * a status cell should carry no date at all (the tracker has a date column),
 * so what is being cleaned up is a trailing " 2026-01-02 — recruiter" tail.
 * The global `/\(?\d{4}-\d{2}-\d{2}\)?/g` alternative excised a parenthesised
 * date from the MIDDLE of a value too, silently editing text the user wrote.
 *
 * An unrecognized status returns the cleaned input, never null. A caller
 * written against the null contract and handed this one changes from "unknown
 * status" to "status named <garbage>", so callers must test for a value that is
 * not a canonical id rather than for null (ADR 0004 #4).
 *
 * @param {*} raw - Raw status cell.
 * @param {Map<string,string>|Record<string,string>} aliases - from buildStatusAliasMap.
 * @returns {string} Canonical id, or the cleaned input when nothing matches.
 */
export function normalizeStatus(raw, aliases) {
  const clean = foldStatus(String(raw ?? '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, ''));
  if (!clean) return '';
  const canonical = aliases instanceof Map ? aliases.get(clean) : aliases?.[clean];
  return canonical || clean;
}

// ── Slugs ───────────────────────────────────────────────────────────────────

/**
 * Turn a user-facing label into a safe, readable path or URL segment.
 *
 * Folds to ASCII FIRST, which is the deliberate change: the eight `[^a-z0-9]+`
 * copies turned "Société Générale" into "soci-t-g-n-rale", the two `\w` copies
 * into "socit-gnrale", and company-funded.mjs into "socitgnrale". None of those
 * is a slug a board or a human uses, and each was a different on-disk key for
 * one company.
 *
 * `_` is a separator here, so "Acme_Corp" and "Acme Corp" agree — the `\w`
 * copies kept the underscore through their first pass and produced a second key
 * for the same company.
 *
 * @param {*} value - Raw label.
 * @param {object} [options]
 * @param {string} [options.fallback=''] - Returned when nothing survives. The
 *   caller's, and defaulting to '' on purpose: 'application' collided with the
 *   fallback for a MISSING company, and 'unknown' gave every Japanese company
 *   one shared slug. A caller that does not choose cannot inherit a collision.
 * @param {number} [options.maxLength=0] - 0 means uncapped. A cap never leaves
 *   a trailing separator and never cuts mid-word: slicing at 60 unconditionally
 *   is how "2026-06-20__.pdf" got built.
 * @param {boolean} [options.fold=true] - false keeps the old delete-the-accent
 *   behaviour, for a caller comparing against an existing on-disk key it cannot
 *   rename.
 * @returns {string} Slug, or `fallback`.
 */
export function slugify(value, { fallback = '', maxLength = 0, fold = true } = {}) {
  const source = fold ? asciiFold(value) : String(value ?? '').toLowerCase();
  let slug = source.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (maxLength > 0 && slug.length > maxLength) {
    const cut = slug.slice(0, maxLength);
    // Cutting exactly on a separator is a clean word boundary; cutting inside a
    // word is not, so the partial word goes rather than being truncated.
    const whole = slug[maxLength] === '-' ? cut : cut.replace(/-[^-]*$/, '');
    slug = (whole || cut).replace(/-+$/, '');
  }
  return slug || fallback;
}

// ── URL key ─────────────────────────────────────────────────────────────────

/**
 * Query params that identify a click or campaign, never the posting itself.
 * Deliberately literal and board-specific: generic names (ref, source, src) are
 * functional on some boards, and stripping them merges two distinct postings —
 * the failure direction RFC 3986 §6 tells us to avoid.
 */
const TRACKING_PARAMS = [
  /^utm_/i, /^gh_src$/i, /^fbclid$/i, /^gclid$/i,
  /^mc_cid$/i, /^mc_eid$/i, /^igshid$/i, /^_hsenc$/i, /^_hsmi$/i, /^trk$/i, /^trackingid$/i,
];

/**
 * Reduce a posting URL to a stable comparison key.
 *
 * PATH CASE IS PRESERVED. This is the divergence ADR 0004 was written to settle
 * and it was decided on the asymmetry of the two failure modes, not on which
 * comment was written last:
 *
 *   - lowercasing the path can MERGE two distinct postings into one key. The
 *     merge is silent and unrecoverable — the tracker keeps one row and there
 *     is nothing left to reconstruct the other from. It is the bug that
 *     collapsed two different Greenhouse postings.
 *   - preserving the path can leave two spellings of the SAME posting as two
 *     keys. That is a duplicate row: visible, and the user can fix it.
 *
 * A recoverable failure beats a silent one, so the path is returned verbatim.
 * The host IS lowercased — DNS is case-insensitive, so that half is RFC 3986
 * §6.2.2 syntax-based normalization and is safe under either contract.
 *
 * NO KEY IS NOT A KEY. An input that is not a usable http(s) posting URL
 * returns '' — never a lowercased-string stand-in. A placeholder like "N/A" is
 * a sentinel for a MISSING value, and SQL's three-valued logic is the settled
 * answer: NULL is never equal to NULL. Returning `s.toLowerCase()` gave every
 * "N/A" row one shared key, so unrelated employers compared equal on it.
 *
 * @param {*} raw - A posting URL (or any value) from a tracker row / TSV.
 * @returns {string} A normalized key, or '' when there is nothing to key on.
 *   '' means NO KEY — callers must treat it as unknown, never as a value that
 *   can match another ''.
 */
export function urlKey(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';

  let u;
  try {
    u = new URL(s);
  } catch {
    // A placeholder ("N/A", "TBD", "—"), a `local:jds/...` pipeline reference,
    // or free text. None identifies a posting, so none may become a key.
    return '';
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';

  u.protocol = 'https:';            // http vs https is the same posting
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';                      // fragments never identify the posting

  // Drop tracking params, keep functional ones (gh_jid is the canonical posting
  // id on some corporate-hosted Greenhouse boards), sort for order-independence.
  const keep = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING_PARAMS.some((re) => re.test(k))) keep.push([k, v]);
  }
  keep.sort((x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);

  // Drop a single trailing slash on the path (but never the root "/").
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

/** Schemes a generated document's contact row may link to. */
const DEFAULT_URL_SCHEMES = ['mailto:', 'tel:', 'http:', 'https:'];

/**
 * Validate a URL for a generated document and coerce the bare forms users type.
 *
 * Returns the URL UNESCAPED. The two callers escape for different output
 * contexts — HTML entity-escaping for an href attribute, LaTeX metacharacter
 * stripping for \href — and folding either in here would corrupt the other.
 *
 * @param {*} url
 * @param {{schemes?: string[]}} [options] - Allowlist; the LaTeX path omits
 *   `tel:` because \href cannot dial.
 * @returns {string} A safe URL, or '' when the scheme is disallowed.
 */
export function sanitizeUrl(url, { schemes = DEFAULT_URL_SCHEMES } = {}) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (schemes.some((s) => lower.startsWith(s))) return trimmed;
  // An explicit but disallowed scheme (javascript:, data:, …) — reject it
  // rather than coercing it into something that looks safe.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return '';
  if (trimmed.includes('@') && !trimmed.includes('/')) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

// ── HTML ────────────────────────────────────────────────────────────────────

/**
 * Capped like the full-text JDs the scrapers see: a 10 KB/posting body is
 * normal on these boards, and scan payloads must stay sane.
 */
export const DESCRIPTION_CAP = 4000;

/**
 * Escape user text for an HTML text or attribute context.
 *
 * Blanks only structurally absent values. A falsy SCALAR must render: the
 * `if (!text) return ''` form silently dropped a `0` or a `false` from a
 * generated document while the surrounding "present" flag stayed true.
 *
 * @param {*} text
 * @returns {string}
 */
export function escapeHtml(text) {
  if (text === null || text === undefined || typeof text === 'object') return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip tags to a fixed point.
 *
 * A single global replace only removes non-overlapping matches in one
 * left-to-right sweep, which CodeQL flags as an incomplete sanitizer
 * (js/incomplete-sanitization): adversarial nesting can leave a `<`-fragment
 * that pass N reveals. Repeating until the string stops changing removes it.
 */
function stripTagsToFixedPoint(html) {
  let previous;
  let out = html;
  do {
    previous = out;
    out = out.replace(/<[^>]*>/g, ' ');
  } while (out !== previous);
  return out;
}

/**
 * Entity-decoded markup → plain text.
 *
 * Double-decode: the payload often carries entity-escaped tags (`&lt;p&gt;`),
 * so the first pass reveals real tags, and text-level entities (`&amp;`,
 * `&#39;`) only become decodable once those tags are gone. Plain text is what
 * the description-consuming filters match against, and a filter for "R&D"
 * missed on the two boards whose stripper never decoded at all.
 *
 * script and style bodies go before anything else. They are not description
 * text, and the filters substring-match the description — so a script body
 * leaking into it could satisfy or veto a content or visa filter.
 *
 * @param {*} content
 * @param {object} [options]
 * @param {number} [options.cap=DESCRIPTION_CAP] - 0 means uncapped.
 * @param {boolean} [options.blockNewlines=false] - Render block ends as
 *   newlines instead of spaces, for a caller that shows the description to a
 *   human rather than substring-matching it.
 * @returns {string}
 */
export function htmlToText(content, { cap = DESCRIPTION_CAP, blockNewlines = false } = {}) {
  if (typeof content !== 'string' || !content) return '';
  let text = decodeEntities(content).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  if (blockNewlines) {
    text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
  }
  text = decodeEntities(stripTagsToFixedPoint(text));
  text = blockNewlines
    ? text.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : text.replace(/\s+/g, ' ').trim();
  return cap > 0 ? text.slice(0, cap) : text;
}

// ── Dates ───────────────────────────────────────────────────────────────────

/**
 * Today's date in the host's local timezone, as YYYY-MM-DD.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day and is wrong in both
 * directions: west of Greenwich an evening run answers "today" with TOMORROW
 * (#2765), and east of it the user's own today reads as a FUTURE date for the
 * first hours of their local day, so a check that rejects future dates rejects
 * the present one (#2932). It is written into user-visible artifacts —
 * capture filenames, the outcome-log date field, PDF manifest rows.
 *
 * Only "what day is it here" is local. Date ARITHMETIC below stays on
 * UTC-midnight parsing, which is internally consistent and deliberate.
 *
 * @param {Date} [now] - Injectable so a test can pin an instant instead of
 *   depending on the wall clock. The window where the UTC day and the local day
 *   disagree only exists for part of the UTC day.
 * @returns {string} Local calendar day, YYYY-MM-DD.
 */
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Parse a bare YYYY-MM-DD to a Date anchored at UTC midnight.
 *
 * Round-trips through toISOString to reject an impossible calendar date. The
 * copy without that check accepted "2026-02-31", rolled it to 2026-03-03, and
 * then computed a stage duration off it — so a typo'd ledger row silently
 * shifted the answer by three days instead of being dropped.
 *
 * @param {*} value
 * @returns {Date|null} null when the input is not a real calendar day.
 */
export function parseIsoDate(value) {
  const iso = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  return date;
}

/** Accept either shape of date argument; the two `daysBetween` exports this
 *  replaces disagreed on it, and a naive merge broke one of them silently. */
function coerceDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  return parseIsoDate(value);
}

/**
 * Whole calendar days from `from` to `to`, signed.
 *
 * Both sides are reduced to UTC midnight FIRST. The real call shape is a parsed
 * posting date (already at midnight) against wall-clock now, and subtracting
 * raw timestamps tips the count one day early after noon UTC — which is how the
 * floor and round variants returned 10 and 11 for the same pair of instants.
 *
 * @param {Date|string} from
 * @param {Date|string} to
 * @returns {number|null} An integer, or null when either side is not a date.
 *   Not NaN: NaN propagates silently through comparisons and reports a
 *   confident-looking number downstream.
 */
export function daysBetween(from, to) {
  const a = coerceDate(from);
  const b = coerceDate(to);
  if (!a || !b) return null;
  const first = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const second = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((second - first) / 86_400_000);
}

/**
 * Coerce a provider's posted-at field to epoch milliseconds.
 *
 * Handles the number case, which 17 of the 27 copies did not: `Date.parse` of a
 * number coerces it to a string first and yields NaN, so a provider whose
 * upstream switched from ISO to epoch ms lost EVERY posted date with no error.
 *
 * Values below 1e12 are Unix seconds; at or above, already milliseconds. The
 * comparison is `<`, not `>`: the strict-`>` variant turned exactly 1e12 into
 * 1e15 — the year 33658, which passes every "is it newer than the cutoff"
 * filter forever.
 *
 * A string is NEVER number-coerced first. The copy that did turned a year-only
 * "2024" into 2024 seconds — 1970-01-01T00:33:44Z — while every other provider
 * read it as 2024-01-01.
 *
 * @param {*} value
 * @returns {number|undefined} undefined when absent or unparseable — the
 *   24-file majority contract. A consumer testing `=== undefined` and handed
 *   the `null` variant behaves differently.
 */
export function toEpochMs(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number') {
    // A non-positive instant is treated as missing rather than dating the
    // posting to 1970 and passing every freshness filter from the wrong end.
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms <= 0 ? undefined : ms;
}
