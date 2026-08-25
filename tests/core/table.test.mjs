/**
 * Characterisation tests for src/core/table.js — the one markdown table
 * parser/serialiser, replacing the 11 row-split algorithms catalogued in
 * docs/audit/duplicate-functionality.md (Part II, CAPABILITY 1).
 *
 * Every input the audit lists as behaviourally divergent (Inputs A–G, D1–D8)
 * has a test here. Where the module deliberately changes what one of the old
 * readers did, the test says so and names the ADR or the audit item.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRow,
  parseTable,
  serialiseRow,
  serialiseTable,
  detectColumns,
  isSeparatorRow,
} from '../../src/core/table.js';

const ALIASES = {
  '#': 'num', num: 'num', date: 'date', company: 'company', empresa: 'company',
  via: 'via', role: 'role', puesto: 'role', location: 'location', score: 'score',
  status: 'status', pdf: 'pdf', materials: 'pdf', report: 'report',
  'apply link': 'applylink', apply: 'applylink', 'follow-up': 'followup',
  'follow up': 'followup', followup: 'followup', notes: 'notes', url: 'url',
};
const REQUIRED = ['num', 'company', 'role', 'score', 'status'];
const TRACKER = { aliases: ALIASES, required: REQUIRED };

// ── parseRow ────────────────────────────────────────────────────────

test('parseRow drops the outer pipes and trims every cell', () => {
  assert.deepEqual(parseRow('|  7 |Acme  | Senior Engineer |'), ['7', 'Acme', 'Senior Engineer']);
});

// Input A / D1: src/scripts/plugins.mjs:65 slice(1,-1) drops `great note`. Every hardened
// reader (tracker-parse.mjs:199, tracker-utils rebuildRow, web trackerCells)
// keeps it; the shared splitter keeps it too.
test('parseRow keeps the final cell of a row written without a trailing pipe', () => {
  assert.deepEqual(parseRow('| 7 | Acme | great note'), ['7', 'Acme', 'great note']);
  assert.deepEqual(parseRow('| 7 | Acme | great note |'), ['7', 'Acme', 'great note']);
});

// Input F / D3: src/scripts/upskill.mjs:298 and src/scripts/analyze-patterns.mjs:751 .filter(Boolean)
// here, which shifts every column after a blank one. Positional slots survive.
test('parseRow preserves empty cells as positional slots', () => {
  assert.deepEqual(parseRow('| Gap |  | mitigation |'), ['Gap', '', 'mitigation']);
  assert.deepEqual(parseRow('| a | b ||'), ['a', 'b', '']);
  assert.deepEqual(parseRow('| a |  |'), ['a', '']);
});

test('parseRow rejects anything that is not a table row', () => {
  assert.equal(parseRow('just prose'), null);
  assert.equal(parseRow(''), null);
  assert.equal(parseRow(null), null);
  assert.equal(parseRow(undefined), null);
  assert.equal(parseRow(42), null);
  assert.equal(parseRow('- [ ] https://example.com/jobs/1'), null);
});

// NOT in the audit: tracker-parse.mjs:190 requires line.startsWith('|') while
// tracker.mjs:178, web trackerCells, scan.mjs:1962 and src/scripts/process-quality.mjs:97
// all trim first. The shared splitter takes the tolerant majority behaviour, so
// an indented table row now parses where parseTrackerRow skipped it.
test('parseRow tolerates surrounding whitespace and a CRLF line ending', () => {
  assert.deepEqual(parseRow('   | 7 | Acme |'), ['7', 'Acme']);
  assert.deepEqual(parseRow('| 7 | Acme |\r'), ['7', 'Acme']);
});

// Input B / D6: no reader in the repo unescapes `\|` today, so a cell written
// by src/scripts/company-funded.mjs:829 splits in two and shifts every later column. The
// shared splitter treats `\|` as GFM does — a literal pipe inside the cell.
test('parseRow treats an escaped pipe as cell content, not a delimiter', () => {
  assert.deepEqual(parseRow('| a \\| b | c |'), ['a | b', 'c']);
  assert.deepEqual(parseRow('| a \\|'), ['a |']);
});

test('parseRow treats an escaped backslash as content, so the next pipe still delimits', () => {
  assert.deepEqual(parseRow('| a\\\\ | b |'), ['a\\', 'b']);
});

test('parseRow leaves markdown escapes other than the pipe untouched', () => {
  assert.deepEqual(parseRow('| \\[draft\\] | b |'), ['\\[draft\\]', 'b']);
});

test('parseRow handles degenerate rows', () => {
  assert.deepEqual(parseRow('|'), []);
  assert.deepEqual(parseRow('||'), ['']);
});

// ── isSeparatorRow ──────────────────────────────────────────────────

test('isSeparatorRow accepts every alignment-row spelling in the repo', () => {
  for (const line of ['|---|---|', '|:---:|---|', '| --- | --- |', '|:-:|', '|---|---', '| :--- | ---: |']) {
    assert.equal(isSeparatorRow(line), true, line);
  }
});

// tracker-parse.mjs:70-73: readers used to sniff separators with
// includes('---'), which matched a URL slug in free text.
test('isSeparatorRow rejects data rows that merely contain dashes', () => {
  assert.equal(isSeparatorRow('| 7 | Acme | Senior-Engineer---Platform-Team |'), false);
  assert.equal(isSeparatorRow('not a row'), false);
});

// merge-tracker.mjs:526 writes an em dash as the empty-cell filler; that is a
// data row, not table furniture.
test('isSeparatorRow rejects em-dash filler and all-empty rows', () => {
  assert.equal(isSeparatorRow('| — | — |'), false);
  assert.equal(isSeparatorRow('|  |  |'), false); // tracker.mjs:182 /^[-: ]*$/ calls this a separator
});

// ── detectColumns ───────────────────────────────────────────────────

test('detectColumns maps the tracker header by alias, indexed over real cells', () => {
  const lines = ['# Applications', '', '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |', '|---|---|---|---|---|---|---|---|---|'];
  assert.deepEqual(detectColumns(lines, TRACKER), {
    num: 0, date: 1, company: 2, role: 3, score: 4, status: 5, pdf: 6, report: 7, notes: 8,
  });
});

// #946/#2274: an inserted Location column shifts Score, which is why mapping is
// by header name rather than position.
test('detectColumns follows an inserted column', () => {
  const lines = ['| # | Date | Company | Location | Role | Score | Status | PDF | Report | Notes |'];
  const columns = detectColumns(lines, TRACKER);
  assert.equal(columns.location, 3);
  assert.equal(columns.score, 5);
});

// #2274: the alias table is the whole contract, so a header localized past the
// aliases it has still resolves — unmapped labels simply carry no field.
test('detectColumns resolves a partially localized header and leaves unknown labels unmapped', () => {
  const lines = ['| # | Fecha | Empresa | Puesto | Score | Status | PDF | Report | Notes |'];
  const columns = detectColumns(lines, TRACKER);
  assert.equal(columns.company, 2);
  assert.equal(columns.role, 3);
  assert.equal(columns.date, undefined); // "fecha" is not in the alias table
});

test('detectColumns matches header labels regardless of case and internal whitespace', () => {
  const lines = ['| # | DATE | company | Role | Score | STATUS | Follow  Up | Apply   Link |'];
  const columns = detectColumns(lines, TRACKER);
  assert.equal(columns.date, 1);
  assert.equal(columns.status, 5);
  assert.equal(columns.followup, 6);
  assert.equal(columns.applylink, 7);
});

// tracker-parse.mjs:90-93: a company genuinely named "Company" must not be
// read as table furniture — the whole schema has to resolve.
test('detectColumns requires the full schema, so a data row is never the header', () => {
  const lines = ['| 7 | 2026-01-01 | Company | Engineer | 4/5 | Applied | — | — | note |'];
  assert.equal(detectColumns(lines, TRACKER), null);
});

test('detectColumns returns null when a required field is missing', () => {
  const lines = ['| # | Date | Company | Role | Notes |'];
  assert.equal(detectColumns(lines, TRACKER), null);
});

// src/scripts/plugins.mjs:61 / src/scripts/process-quality.mjs:118: no alias table, the first table row
// is the header and every cell keys itself.
test('detectColumns without aliases keys the first table row by its own labels', () => {
  const lines = ['| Stage | Company | Next step |', '|---|---|---|', '| Onsite | Acme | 2026-02-01 |'];
  assert.deepEqual(detectColumns(lines), { stage: 0, company: 1, 'next step': 2 });
});

test('detectColumns ignores empty header cells and lets the last duplicate label win', () => {
  assert.deepEqual(detectColumns(['| Stage |  | Stage |']), { stage: 2 });
});

test('detectColumns accepts a raw string as well as lines', () => {
  assert.deepEqual(detectColumns('| Stage | Company |\n|---|---|'), { stage: 0, company: 1 });
});

// ── parseTable ──────────────────────────────────────────────────────

const TRACKER_MD = [
  '# Applications',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1 | 2026-01-01 | Acme | Engineer | 4/5 | Applied | ✓ | [12](reports/012-acme.md) | first |',
  '| 2 | 2026-01-02 | Globex | Analyst | 3/5 | Rejected | — | — |  |',
  '',
].join('\n');

test('parseTable reads the tracker: header mapped, separator skipped, values keyed', () => {
  const { columns, header, headerLineNumber, rows, skipped } = parseTable(TRACKER_MD, TRACKER);
  assert.equal(headerLineNumber, 3);
  assert.deepEqual(header.slice(0, 3), ['#', 'Date', 'Company']);
  assert.equal(columns.status, 5);
  assert.equal(rows.length, 2);
  assert.equal(skipped.length, 0);
  assert.deepEqual(rows[0].values, {
    num: '1', date: '2026-01-01', company: 'Acme', role: 'Engineer', score: '4/5',
    status: 'Applied', pdf: '✓', report: '[12](reports/012-acme.md)', notes: 'first',
  });
  assert.equal(rows[1].values.notes, '');
});

test('parseTable reports each row 1-based with its verbatim source line', () => {
  const { rows } = parseTable(TRACKER_MD, TRACKER);
  assert.equal(rows[0].lineNumber, 5);
  assert.equal(rows[0].line, TRACKER_MD.split('\n')[4]);
});

// D2 (ADR 0004 canonical: tracker-parse.mjs:200's full-width guard).
// src/scripts/verify-pipeline.mjs:103 and merge-tracker.mjs:567 use `parts.length <= MAX_IDX`,
// which accepts a row missing an interior cell and reads it one column shifted.
test('parseTable drops a ragged row instead of reading it column-shifted', () => {
  const md = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-01-01 | Acme | Engineer | 4/5 | Applied | ✓ | [12](reports/012.md) | ok |',
    '| 2 | 2026-01-02 | Globex | 3/5 | Rejected | — | — | short |',
  ].join('\n');
  const { rows, skipped } = parseTable(md, TRACKER);
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].lineNumber, 4);
  assert.equal(skipped[0].reason, 'width');
});

// D1 again, at table level: the notes column survives on a hand-edited row.
test('parseTable keeps the last column of a row written without a trailing pipe', () => {
  const md = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-01-01 | Acme | Engineer | 4/5 | Applied | ✓ | — | hand edited',
  ].join('\n');
  const { rows } = parseTable(md, TRACKER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].values.notes, 'hand edited');
});

// src/scripts/process-quality.mjs:126 rejects on `cells.length !== colCount`; the canonical
// reader (tracker-parse.mjs:200, web tracker-table.mjs:135) accepts wider rows
// and ignores the surplus. Wider rows are kept, and the surplus stays in cells.
test('parseTable accepts a row wider than the header and keeps the surplus in cells', () => {
  const md = [
    '| Stage | Company |',
    '|---|---|',
    '| Onsite | Acme | scratch note |',
  ].join('\n');
  const { rows } = parseTable(md);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].cells, ['Onsite', 'Acme', 'scratch note']);
  assert.deepEqual(rows[0].values, { stage: 'Onsite', company: 'Acme' });
});

test('parseTable maps a generic table by its own header labels', () => {
  const md = [
    'Some prose.',
    '',
    '| Stage | Company | Next step |',
    '| :--- | :---: | ---: |',
    '| Onsite | Acme |  |',
  ].join('\n');
  const { rows } = parseTable(md);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].values, { stage: 'Onsite', company: 'Acme', 'next step': '' });
});

// src/scripts/process-quality.mjs:100-106: only the FIRST contiguous pipe block is the
// table; tracker readers instead scan every pipe line in the file.
test('parseTable scans every table line by default and one block with contiguous', () => {
  const md = [
    '| Stage | Company |',
    '|---|---|',
    '| Onsite | Acme |',
    '',
    '## Later',
    '| Stage | Company |',
    '| Offer | Globex |',
  ].join('\n');
  assert.equal(parseTable(md).rows.length, 3); // second header is data under the first map
  assert.equal(parseTable(md, { contiguous: true }).rows.length, 1);
});

// web/src/lib/tracker-table.mjs:62 degrades to the legacy fixed order when the
// alias file is missing; tracker-parse.mjs:39 throws. D4 says keep BOTH, so
// table.js takes the alias table as data and decides neither — with no header
// match it consumes no line and hands the caller raw cells to map itself.
test('parseTable with no recognizable header returns unmapped rows and eats no line', () => {
  const md = [
    '| Num | Fecha | Firma |',
    '|---|---|---|',
    '| 1 | 2026-01-01 | Acme |',
  ].join('\n');
  const { columns, header, rows } = parseTable(md, TRACKER);
  assert.equal(columns, null);
  assert.equal(header, null);
  assert.equal(rows.length, 2); // the unrecognized header row is data now
  assert.equal(rows[0].values, null);
  assert.deepEqual(rows[1].cells, ['1', '2026-01-01', 'Acme']);
});

test('parseTable with an explicit column map skips header detection', () => {
  const md = ['| 1 | Acme |', '| 2 | Globex |'].join('\n');
  const { rows, header } = parseTable(md, { columns: { num: 0, company: 1 } });
  assert.equal(header, null);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].values, { num: '2', company: 'Globex' });
});

test('parseTable accepts an array of lines and CRLF text alike', () => {
  const rowsFromArray = parseTable(TRACKER_MD.split('\n'), TRACKER).rows;
  const rowsFromCrlf = parseTable(TRACKER_MD.replace(/\n/g, '\r\n'), TRACKER).rows;
  assert.equal(rowsFromArray.length, 2);
  assert.equal(rowsFromCrlf.length, 2);
  assert.equal(rowsFromCrlf[0].values.company, 'Acme');
});

// Input B at table level: an escaped pipe in a free-text cell no longer shifts
// the columns after it.
test('parseTable keeps columns aligned when a cell carries an escaped pipe', () => {
  const md = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-01-01 | Acme | Engineer \\| Platform | 4/5 | Applied | ✓ | — | ok |',
  ].join('\n');
  const { rows } = parseTable(md, TRACKER);
  assert.equal(rows[0].values.role, 'Engineer | Platform');
  assert.equal(rows[0].values.status, 'Applied');
});

test('parseTable returns nothing findable for input without a table', () => {
  const { columns, rows, skipped } = parseTable('no table here\n\njust prose');
  assert.equal(columns, null);
  assert.deepEqual(rows, []);
  assert.deepEqual(skipped, []);
  assert.deepEqual(parseTable('').rows, []);
  assert.deepEqual(parseTable(null).rows, []);
});

// ── serialiseRow ────────────────────────────────────────────────────

// tracker-utils.mjs:52 rebuildRow's output shape, from tests/tracker-utils.test.mjs:29.
test('serialiseRow writes the canonical `| a | b |` shape', () => {
  assert.equal(serialiseRow(['7', 'Acme', 'great note']), '| 7 | Acme | great note |');
  assert.equal(serialiseRow(['7', 'Acme', '']), '| 7 | Acme |  |');
  assert.equal(serialiseRow([]), '|');
});

// tracker-utils.mjs:93 cell(): substitute rather than backslash-escape, so the
// Go reader in dashboard/ (which splits raw) still sees the right columns.
test('serialiseRow neutralizes pipes and newlines in a value by default', () => {
  assert.equal(serialiseRow([' Acme | Remote\nline ']), '| Acme / Remote line |');
  assert.equal(serialiseRow([null, undefined, 7]), '|  |  | 7 |');
});

// D6: the other live contract (src/scripts/company-funded.mjs:829 writes `\|`). Opt-in, and
// it round-trips through parseRow, which the substitution deliberately does not.
test('serialiseRow can escape pipes instead, and that round-trips', () => {
  assert.equal(serialiseRow(['a | b', 'c'], { escapePipes: true }), '| a \\| b | c |');
  assert.deepEqual(parseRow(serialiseRow(['a | b', 'c'], { escapePipes: true })), ['a | b', 'c']);
  assert.deepEqual(parseRow(serialiseRow(['a \\| b'], { escapePipes: true })), ['a \\| b']);
});

test('parseRow round-trips whatever serialiseRow writes', () => {
  for (const cells of [['a', 'b'], ['a', '', 'c'], ['a'], ['', ''], ['—', '4/5']]) {
    assert.deepEqual(parseRow(serialiseRow(cells)), cells);
  }
});

// ── serialiseTable ──────────────────────────────────────────────────

test('serialiseTable writes header, separator and rows', () => {
  const out = serialiseTable([['1', 'Acme'], ['2', 'Globex']], { header: ['#', 'Company'] });
  assert.equal(out, ['| # | Company |', '| --- | --- |', '| 1 | Acme |', '| 2 | Globex |'].join('\n'));
});

test('serialiseTable without a header writes rows only', () => {
  assert.equal(serialiseTable([['1', 'Acme']]), '| 1 | Acme |');
  assert.equal(serialiseTable([]), '');
});

test('parseTable round-trips serialiseTable', () => {
  const header = ['#', 'Date', 'Company', 'Role', 'Score', 'Status', 'PDF', 'Report', 'Notes'];
  const row = ['1', '2026-01-01', 'Acme', 'Engineer', '4/5', 'Applied', '✓', '—', ''];
  const { rows, columns } = parseTable(serialiseTable([row], { header }), TRACKER);
  assert.equal(columns.notes, 8);
  assert.deepEqual(rows[0].cells, row);
});
