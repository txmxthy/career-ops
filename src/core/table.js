/**
 * table.js — the one markdown table reader/writer.
 *
 * Replaces the 11 row-split algorithms catalogued in
 * docs/audit/duplicate-functionality.md (Part II, CAPABILITY 1): every reader
 * had its own answer for trailing pipes, ragged rows, separator rows and empty
 * cells, and the answers disagreed. The behaviour here is the canonical one —
 * tracker-parse.mjs plus tracker-utils.mjs's rebuildRow — generalized so a
 * non-tracker table (active-interviews, blacklist, plugin exports, gap tables)
 * can use it without a private copy.
 *
 * Pure: no I/O, no argv, no process.exit, no console. The alias table is passed
 * in as data, so how a caller LOADS it — tracker-parse.mjs:39 throws on a
 * missing file, web/src/lib/tracker-table.mjs:62 degrades to the legacy order —
 * stays the caller's decision (audit D4 says keep both).
 *
 * Indexing: cells are indexed 0-based over the REAL cells, outer pipes removed.
 * The legacy readers index into `line.split('|')`, where index 0 is the empty
 * string before the leading pipe — those maps are one higher throughout.
 */

/** A cell of a markdown alignment row: `---`, `:---`, `---:`, `:---:`. */
const ALIGNMENT_CELL_RE = /^:?-+:?$/;

/**
 * Split a table line on its unescaped pipes.
 *
 * A backslash escapes the next character, so `\|` is a literal pipe inside the
 * cell (GFM's rule) and `\\` is a literal backslash that leaves a following
 * pipe as a delimiter. Only `\|` is unescaped: other backslash sequences are
 * markdown inline escapes the renderer owns, and rewriting them here would
 * change values every current reader passes through untouched.
 */
function splitCells(line) {
  const cells = [];
  let cell = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      const next = line[i + 1];
      if (next === undefined) { cell += ch; break; }
      cell += (next === '|' || next === '\\') ? next : ch + next;
      i++;
    } else if (ch === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/**
 * Split one markdown table row into its trimmed cells.
 *
 * The leading empty part (before the opening pipe) is always dropped; the
 * trailing one only when the row actually ends with a pipe. An unconditional
 * `slice(1, -1)` ate the last cell of hand-edited rows written without a
 * trailing pipe (#2369, still live in plugins.mjs:65), and empty cells are kept
 * as positional slots rather than filtered away (upskill.mjs:298's
 * `.filter(Boolean)` shifts every column after a blank one).
 *
 * @param {string} line - One line of markdown.
 * @returns {string[]|null} Cells, or null when the line is not a table row.
 */
export function parseRow(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const parts = splitCells(trimmed);
  parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map(c => c.trim());
}

/**
 * Whether a line is a table's alignment row (`|---|:---:|`).
 *
 * Tested per cell rather than against the whole line, so a separator written
 * without a trailing pipe still counts. Structural, not a substring sniff:
 * `line.includes('---')` also matched a data row carrying a slug such as
 * `Senior-Engineer---Platform-Team` (tracker-parse.mjs:70-73). An all-empty row
 * is not a separator either, which `/^[-: ]*$/` over the joined cells
 * (tracker.mjs:182) gets wrong.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isSeparatorRow(line) {
  const cells = parseRow(line);
  return cells != null && cells.length > 0 && cells.every(c => ALIGNMENT_CELL_RE.test(c));
}

/** Header text → lookup key: case- and whitespace-insensitive. */
function headerKey(cell) {
  return cell.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Find the header row and map its cells to field names.
 * @returns {{index: number, cells: string[], columns: Object<string,number>}|null}
 */
function findHeader(entries, aliases, required) {
  for (const entry of entries) {
    if (isSeparatorRow(entry.line)) continue;
    const columns = {};
    entry.cells.forEach((cell, i) => {
      const key = headerKey(cell);
      const field = aliases ? aliases[key] : key;
      if (field) columns[field] = i; // last occurrence wins
    });
    if (required.every(field => columns[field] != null)) {
      return { index: entry.index, cells: entry.cells, columns };
    }
  }
  return null;
}

/** Table lines of `input`, as `{line, cells, index}` (index is 0-based). */
function tableLines(input, contiguous) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    if (cells == null || cells.length === 0) {
      if (contiguous && entries.length > 0) break;
      continue;
    }
    entries.push({ line: lines[i], cells, index: i });
  }
  return entries;
}

/**
 * Locate the header row and map field name → cell index.
 *
 * With an `aliases` table the header is the first row that labels every field
 * in `required` — the whole schema, not one telltale cell, so a company
 * genuinely named "Company" is never read as table furniture
 * (tracker-parse.mjs:90-93). Without one, every cell keys itself (lowercased,
 * whitespace-collapsed) and the first table row is the header — the contract
 * plugins.mjs:61 and process-quality.mjs:118 already use.
 *
 * @param {string|string[]} input - Markdown text, or its lines.
 * @param {object} [options]
 * @param {Object<string,string>|null} [options.aliases] - Header text → field name.
 * @param {string[]} [options.required] - Fields a header must resolve to qualify.
 * @param {boolean} [options.contiguous] - Only the first contiguous table block.
 * @returns {Object<string,number>|null} Field → cell index, or null.
 */
export function detectColumns(input, options = {}) {
  const { aliases = null, required = [], contiguous = false } = options;
  const header = findHeader(tableLines(input, contiguous), aliases, required);
  return header ? header.columns : null;
}

/**
 * Parse a markdown table.
 *
 * Rows narrower than the mapped width are skipped rather than read: a row
 * missing an INTERIOR cell shifts every later column one left while still
 * covering the highest mapped index, so `parts.length <= MAX_IDX`
 * (verify-pipeline.mjs:103, merge-tracker.mjs:567) silently mis-reads it.
 * Skipped rows are returned rather than dropped — an unparseable row and an
 * absent one are different states (ADR 0006).
 *
 * Wider rows are kept, with the surplus in `cells` and out of `values`: extra
 * user-owned columns are the reason mapping is by header name at all.
 *
 * @param {string|string[]} input - Markdown text, or its lines.
 * @param {object} [options]
 * @param {Object<string,string>|null} [options.aliases] - Header text → field name.
 * @param {string[]} [options.required] - Fields a header must resolve to qualify.
 * @param {Object<string,number>|null} [options.columns] - Explicit map; skips header detection.
 * @param {boolean} [options.contiguous] - Parse only the first contiguous table block.
 * @returns {{columns: Object<string,number>|null, header: string[]|null,
 *   headerLineNumber: number|null,
 *   rows: Array<{cells: string[], values: Object<string,string>|null, line: string, lineNumber: number}>,
 *   skipped: Array<{cells: string[], line: string, lineNumber: number, reason: string}>}}
 *   Line numbers are 1-based and `line` is the source line verbatim, so callers
 *   can locate or replace the exact line they read.
 */
export function parseTable(input, options = {}) {
  const { aliases = null, required = [], columns: explicitColumns = null, contiguous = false } = options;
  const entries = tableLines(input, contiguous);

  const header = explicitColumns ? null : findHeader(entries, aliases, required);
  const columns = explicitColumns || (header ? header.columns : null);
  const indices = columns ? Object.values(columns) : [];
  const width = indices.length > 0 ? Math.max(...indices) + 1 : 0;

  const rows = [];
  const skipped = [];
  for (const entry of entries) {
    if (header && entry.index === header.index) continue;
    if (isSeparatorRow(entry.line)) continue;
    const at = { cells: entry.cells, line: entry.line, lineNumber: entry.index + 1 };
    if (entry.cells.length < width) {
      skipped.push({ ...at, reason: 'width' });
      continue;
    }
    let values = null;
    if (columns) {
      values = {};
      for (const [field, i] of Object.entries(columns)) values[field] = entry.cells[i] ?? '';
    }
    rows.push({ ...at, values });
  }

  return {
    columns,
    header: header ? header.cells : null,
    headerLineNumber: header ? header.index + 1 : null,
    rows,
    skipped,
  };
}

/**
 * Make one value safe to sit in a table cell.
 *
 * The default rewrites a pipe as ` / ` rather than escaping it, because the
 * repo's other readers of these files — the Go TUI in dashboard/ — split on raw
 * pipes and would see a `\|` as a column break (tracker-utils.mjs:84-88).
 * `escapePipes` is the other live contract (company-funded.mjs:829) and is the
 * only one that round-trips through parseRow.
 */
function sanitiseCell(value, escapePipes) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (!escapePipes) return text.replace(/\s*\|\s*/g, ' / ').trim();
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim();
}

/**
 * Serialise cells as a `| a | b |` row.
 *
 * @param {Array<*>} cells - Cell values; null/undefined become empty cells.
 * @param {object} [options]
 * @param {boolean} [options.escapePipes] - Write `\|` instead of substituting ` / `.
 * @returns {string}
 */
export function serialiseRow(cells, options = {}) {
  const list = Array.isArray(cells) ? cells : [];
  if (list.length === 0) return '|';
  return `| ${list.map(v => sanitiseCell(v, options.escapePipes === true)).join(' | ')} |`;
}

/**
 * Serialise a whole table, with the alignment row when a header is given.
 *
 * @param {Array<Array<*>>} rows - Rows of cells.
 * @param {object} [options]
 * @param {Array<*>} [options.header] - Header cells; omitted writes rows only.
 * @param {boolean} [options.escapePipes] - Passed to serialiseRow.
 * @returns {string} Table lines joined by newlines, with no trailing newline.
 */
export function serialiseTable(rows, options = {}) {
  const lines = [];
  if (Array.isArray(options.header) && options.header.length > 0) {
    lines.push(serialiseRow(options.header, options));
    lines.push(serialiseRow(options.header.map(() => '---'), options));
  }
  for (const row of rows ?? []) lines.push(serialiseRow(row, options));
  return lines.join('\n');
}
