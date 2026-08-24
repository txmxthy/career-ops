/**
 * Characterisation of tracker-sync-check.mjs's active-interviews reader, taken
 * before it moved onto src/core/table.js (audit CAPABILITY 1, algorithm #6 —
 * the hand-mirror of process-quality.mjs recorded as divergence D8).
 *
 * Everything the old hand-rolled splitter decided is pinned here. Only the
 * table-line predicate, the strict column-count rule and the raw header keys
 * are load-bearing for this file's callers, so those are what the migration had
 * to keep; the two backslash cases at the bottom are the change it accepted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActiveInterviewsWithLines } from '../tracker-sync-check.mjs';

const table = (...rows) => rows.join('\n');
const HEADER = table('| Company | Stage |', '| --- | --- |');

test('reads a well-formed row and reports its 1-based line number', () => {
  assert.deepEqual(
    parseActiveInterviewsWithLines(table(HEADER, '| Acme | Onsite |')),
    [{ row: { Company: 'Acme', Stage: 'Onsite' }, lineNum: 3 }],
  );
});

test('line numbers count from the top of the file, not from the table', () => {
  const content = table('intro', '', HEADER, '| Acme | Onsite |');
  assert.equal(parseActiveInterviewsWithLines(content)[0].lineNum, 5);
});

// The block ends at the first non-table line: only the first contiguous run is
// read, which is what keeps a second, unrelated table out of the results.
test('stops at the first non-table line', () => {
  const content = table(HEADER, '| A | x |', '', '| B | y |');
  assert.deepEqual(
    parseActiveInterviewsWithLines(content).map(r => r.row.Company),
    ['A'],
  );
});

// A row must open AND close with a pipe to count as a table line. This is
// stricter than core parseRow, which accepts a row that only opens with one,
// and it is deliberately kept: a row without its closing pipe ends the block.
test('a row without a trailing pipe is not a table line', () => {
  assert.deepEqual(parseActiveInterviewsWithLines(table(HEADER, '| Acme | Onsite')), []);
});

// Strict equality against the header width, so a ragged row is dropped rather
// than read one column shifted, and a wider row is dropped rather than read
// with surplus cells. core parseTable keeps wider rows; this reader must not.
test('drops rows narrower than the header', () => {
  assert.deepEqual(parseActiveInterviewsWithLines(table(HEADER, '| Acme |')), []);
});

test('drops rows wider than the header', () => {
  assert.deepEqual(parseActiveInterviewsWithLines(table(HEADER, '| Acme | Onsite | extra |')), []);
});

test('skips the alignment row, including one padded with spaces', () => {
  const content = table('| Company | Stage |', '|  ---  |  ---  |', '| Acme | Onsite |');
  assert.deepEqual(
    parseActiveInterviewsWithLines(content).map(r => r.row.Company),
    ['Acme'],
  );
});

test('keeps an empty interior cell as a positional slot', () => {
  const content = table('| Company | Stage | Notes |', '| --- | --- | --- |', '| Acme |  | later |');
  assert.deepEqual(
    parseActiveInterviewsWithLines(content)[0].row,
    { Company: 'Acme', Stage: '', Notes: 'later' },
  );
});

// Keys are the header text verbatim — trimmed, but neither lowercased nor
// whitespace-collapsed. findColumn() does the case-insensitive lookup on top,
// so folding the keys here would move a decision that is already made once.
test('row keys are the header text verbatim, whitespace and all', () => {
  const content = table('| Next  Step | Stage |', '| --- | --- |', '| A | x |');
  assert.deepEqual(Object.keys(parseActiveInterviewsWithLines(content)[0].row), ['Next  Step', 'Stage']);
});

test('returns [] for content with no table, and for non-strings', () => {
  assert.deepEqual(parseActiveInterviewsWithLines(''), []);
  assert.deepEqual(parseActiveInterviewsWithLines('no table here'), []);
  assert.deepEqual(parseActiveInterviewsWithLines(null), []);
});

test('a header with no separator row under it yields no rows', () => {
  assert.deepEqual(parseActiveInterviewsWithLines('| Company | Stage |'), []);
});

// ── The two accepted changes ────────────────────────────────────────
//
// active-interviews.md has no machine writer — nothing in the repo emits a
// backslash into it — so both of these are reachable only by hand-editing, and
// both move from "wrong" to GFM's answer.

// Was: split on the raw pipe, giving three cells against a two-cell header, so
// the row was dropped entirely. Now the escape is honoured and the row reads.
test('an escaped pipe is a literal pipe inside the cell, not a column break', () => {
  const content = table(HEADER, '| Ac\\|me | Onsite |');
  assert.deepEqual(
    parseActiveInterviewsWithLines(content),
    [{ row: { Company: 'Ac|me', Stage: 'Onsite' }, lineNum: 3 }],
  );
});

// Was: `\\` passed through as two characters. Now it is one literal backslash.
test('a doubled backslash is one literal backslash', () => {
  const content = table(HEADER, '| a\\\\ | Onsite |');
  assert.equal(parseActiveInterviewsWithLines(content)[0].row.Company, 'a\\');
});
