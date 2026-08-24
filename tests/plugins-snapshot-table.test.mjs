/**
 * Characterisation of plugins.mjs's snapshot table reader.
 *
 * Pins the contract the `export` hook sees, across the move onto
 * src/core/table.js. Two behaviours change deliberately and are marked; the
 * rest must not move, because plugin authors read these row objects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownTable } from '../plugins.mjs';

const table = (...lines) => lines.join('\n');

test('rows are keyed by the lowercased header cell', () => {
  const rows = parseMarkdownTable(table('| Num | Company |', '|---|---|', '| 7 | Acme |'));
  assert.deepEqual(rows, [{ num: '7', company: 'Acme' }]);
});

test('a row shorter than the header is padded, not dropped', () => {
  // plugins.mjs keeps its own padding policy: an export hook relies on every
  // header key being present on every row.
  const rows = parseMarkdownTable(table('| A | B | C |', '|---|---|---|', '| 1 | 2 |'));
  assert.deepEqual(rows, [{ a: '1', b: '2', c: '' }]);
});

test('DELIBERATE (#2369): a row without a trailing pipe keeps its last cell', () => {
  // Was `| 1 | 2 | great note` → {c: ''}: slice(1,-1) ate the final cell.
  const rows = parseMarkdownTable(table('| A | B | C |', '|---|---|---|', '| 1 | 2 | great note'));
  assert.deepEqual(rows, [{ a: '1', b: '2', c: 'great note' }]);
});

test('DELIBERATE: an all-blank row is still skipped, but as a blank row', () => {
  // The old separator regex /^\|[\s|:-]+\|?$/ swallowed `|   |   |` as table
  // furniture. isSeparatorRow correctly says it is not a separator, so the
  // skip is now an explicit blank-row rule rather than a misfiring predicate.
  const rows = parseMarkdownTable(table('| A | B |', '|---|---|', '|   |   |', '| 1 | 2 |'));
  assert.deepEqual(rows, [{ a: '1', b: '2' }]);
});

test('surplus cells beyond the header are dropped', () => {
  const rows = parseMarkdownTable(table('| A | B |', '|---|---|', '| 1 | 2 | 3 |'));
  assert.deepEqual(rows, [{ a: '1', b: '2' }]);
});

test('a duplicated header name keeps the last column', () => {
  const rows = parseMarkdownTable(table('| A | A |', '|---|---|', '| 1 | 2 |'));
  assert.deepEqual(rows, [{ a: '2' }]);
});

test('an empty header cell keeps its column under the empty key', () => {
  const rows = parseMarkdownTable(table('| A |  | C |', '|---|---|---|', '| 1 | 2 | 3 |'));
  assert.deepEqual(rows, [{ a: '1', '': '2', c: '3' }]);
});

test('internal whitespace in a header is preserved, not collapsed', () => {
  const rows = parseMarkdownTable(table('| Job  Title |', '|---|', '| x |'));
  assert.deepEqual(rows, [{ 'job  title': 'x' }]);
});

test('alignment rows in any form are skipped', () => {
  const rows = parseMarkdownTable(table('| A | B |', '| :--- | ---: |', '| 1 | 2 |'));
  assert.deepEqual(rows, [{ a: '1', b: '2' }]);
});

test('fewer than two table lines yields no rows', () => {
  assert.deepEqual(parseMarkdownTable('| A | B |'), []);
  assert.deepEqual(parseMarkdownTable(''), []);
});

test('non-table prose around the table is ignored', () => {
  const rows = parseMarkdownTable(table('# Heading', '', '| A |', '|---|', '| 1 |', '', 'trailing prose'));
  assert.deepEqual(rows, [{ a: '1' }]);
});

test('rows are frozen so an export hook cannot mutate the snapshot', () => {
  const [row] = parseMarkdownTable(table('| A |', '|---|', '| 1 |'));
  assert.ok(Object.isFrozen(row));
});
