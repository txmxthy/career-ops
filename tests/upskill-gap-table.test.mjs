// tests/upskill-gap-table.test.mjs — characterisation of src/scripts/upskill.mjs's Gap
// table reader across the move onto src/core/table.js (ADR 0005).
//
// parseReportGaps used `row.split('|').map(trim).filter(Boolean)`, one of the
// 11 row-split algorithms in docs/audit/duplicate-functionality.md and the
// exact `.filter(Boolean)` that tests/core/table.test.mjs:49 names: dropping
// empty cells renumbers every column after a blank one. Most rows read the
// same either way and are pinned below unchanged. Two are CHANGED, and only
// blank cells reach them:
//
//   - a trailing blank cell no longer shortens the row below the arity check,
//     so the gap survives instead of being dropped;
//   - a blank gap no longer promotes the next cell into the gap's place, which
//     is how a severity word ended up in the skill-extraction haystack.
//
// The haystack keeps its old invariant either way: it never contains an empty
// description, so a blank gap contributes nothing rather than a blank line.
import { pass, fail } from './helpers.mjs';
import { parseReportGaps } from '../src/scripts/upskill.mjs';

console.log('\nupskill.mjs — Gap table row grammar (characterisation)');

const gaps = (header, ...rows) => {
  const report = [header, '|---|---|---|', ...rows, ''].join('\n');
  return parseReportGaps(report).gapText.split('\n').filter(Boolean);
};
const wide = (...rows) => gaps('| Gap | Severity | Mitigation |', ...rows);
const narrow = (...rows) => gaps('| Gap | Severity |', ...rows);

const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  a === e ? pass(name) : fail(`${name}: expected ${e}, got ${a}`);
};

// Unchanged: the shape every report actually writes.
eq('a full row contributes its gap description',
  wide('| Kubernetes at scale | High | pair with SRE |'), ['Kubernetes at scale']);

eq('several rows keep their order',
  wide('| Kubernetes | High | x |', '| Terraform | Medium | y |'),
  ['Kubernetes', 'Terraform']);

// Unchanged: a one-cell row is not a gap row.
eq('a row with a single cell is skipped', wide('| Kubernetes |'), []);

// Unchanged: a row written without its trailing pipe keeps its last cell.
eq('a row without a trailing pipe still parses',
  wide('| Kubernetes | High'), ['Kubernetes']);

// Unchanged: an INTERIOR blank cell never shortened the row past the arity
// check, because the mitigation cell took the missing severity's slot.
eq('an interior blank cell still yields the gap',
  wide('| Kubernetes |  | pair with SRE |'), ['Kubernetes']);

// CHANGED (was: dropped — the trailing blank vanished, leaving one cell, and
// the row failed the `>= 2` arity check).
eq('a trailing blank cell no longer drops the gap',
  narrow('| Kubernetes |  |'), ['Kubernetes']);

// CHANGED (was: 'High' — every cell shifted left into the gap column).
eq('a blank gap contributes nothing, not the severity',
  wide('|  | High | pair with SRE |'), []);
