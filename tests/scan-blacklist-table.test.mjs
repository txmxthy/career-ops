// tests/scan-blacklist-table.test.mjs — characterisation of scan.mjs's
// parseBlacklist(), written BEFORE it was moved onto src/core/table.js
// (ADR 0005: capture current behaviour first, refactor against it).
//
// parseBlacklist was entry 11 of the 11 row-split algorithms in
// docs/audit/duplicate-functionality.md — a raw `line.split('|')` with its own
// header and separator sniffs. Every cell below is a decision that split made
// and that the shared reader has to keep making the same way: which lines count
// as rows, where the cells land, which rows are furniture, and who wins a
// duplicate key.
//
// One case is deliberately marked as CHANGED rather than pinned: a `\|` inside
// a cell. The raw split treated the backslash as data and the pipe as a column
// break; src/core/table.js implements GFM's escape, so the cell keeps its pipe.
// That is the documented contract of the shared reader (table.js:33-40), it is
// the direction that loses no user input, and no blacklist in the wild is known
// to contain one. Recorded here so the change is deliberate and visible.
import { pass, fail } from './helpers.mjs';
import { parseBlacklist } from '../scan.mjs';

console.log('\nscan.mjs — parseBlacklist row grammar (characterisation)');

const only = (text) => {
  const entries = [...parseBlacklist(text).entries()];
  return entries.length === 1 ? entries[0] : null;
};
const keys = (text) => [...parseBlacklist(text).keys()];

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(`parseBlacklist ${label}`);
  else fail(`parseBlacklist ${label}: got ${a}, expected ${e}`);
};

// Cell positions. The four columns are Company | Since | Scope | Reason.
check('maps the four columns',
  only('| Acme Corp. | 2026-01-15 | company | post-interview signals |'),
  ['acmecorp', { company: 'Acme Corp.', since: '2026-01-15', scope: 'company', reason: 'post-interview signals' }]);

// A hand-edited row written without a closing pipe must not lose its last cell
// (#2369 — the bug an unconditional slice(1, -1) causes).
check('keeps the last cell when the row has no trailing pipe',
  only('| Beta Inc | 2026-02-02 | company | why'),
  ['betainc', { company: 'Beta Inc', since: '2026-02-02', scope: 'company', reason: 'why' }]);

// Short rows are not skipped: absent cells are empty strings, not undefined.
check('a company-only row yields empty siblings',
  only('| Solo Co |'),
  ['soloco', { company: 'Solo Co', since: '', scope: '', reason: '' }]);

// Surplus user-owned columns are ignored rather than shifting the mapped ones.
check('surplus columns are ignored',
  only('| Wide Co | a | b | c | d | e |'),
  ['wideco', { company: 'Wide Co', since: 'a', scope: 'b', reason: 'c' }]);

// Table furniture. The separator test is applied to the COMPANY cell, so all
// three alignment spellings drop out, and so does an empty company.
check('drops the --- separator row', keys('|---|---|---|---|'), []);
check('drops a spaced separator row', keys('| --- | --- | --- | --- |'), []);
check('drops an aligned separator row', keys('| :---: | :---: | :---: | :---: |'), []);
check('drops the header row', keys('| Company | Since | Scope | Reason |'), []);
check('drops a lower-cased header row', keys('| company | since | scope | reason |'), []);
check('drops a row with no company', keys('|  | 2026-01-01 | company | x |'), []);

// Line selection: only pipe-led lines are rows, and leading whitespace is fine.
check('ignores a non-table line', keys('Acme Corp is bad'), []);
check('accepts an indented row', keys('   | Indented Co | 2026-01-01 | company | r |'), ['indentedco']);
check('tolerates a CRLF line ending', keys('| CR Co | 2026-01-01 | company | r |\r'), ['crco']);
check('a bare pipe is not a row', keys('|'), []);

// Duplicate keys: first row wins, and the key is normalizeCompany's, so two
// spellings of one employer collide on purpose.
check('first row wins on a duplicate normalized key',
  only('| Acme Corp | 1 | c | first |\n| ACME-CORP | 2 | c | second |'),
  ['acmecorp', { company: 'Acme Corp', since: '1', scope: 'c', reason: 'first' }]);

// Non-string input is a no-op rather than a throw.
check('null input yields no entries', keys(null), []);

// CHANGED by the move onto src/core/table.js, deliberately. Before: the raw
// split broke the cell at the escaped pipe and left the backslash in the
// company name. After: GFM's escape, so the cell keeps its pipe.
check('an escaped pipe stays inside its cell (ADR 0005 consolidation)',
  only('| Acme \\| Corp | 2026-01-01 | company | r |'),
  ['acmecorp', { company: 'Acme | Corp', since: '2026-01-01', scope: 'company', reason: 'r' }]);
