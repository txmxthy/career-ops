#!/usr/bin/env node

/**
 * src/lib/extract-latex-content.mjs — Detect LaTeX CV family and list editable prose slots.
 *
 * v1 families:
 *   - resumeSubheading (\\resumeItem bullets + \\textbf{Category}{: skills})
 *   - tabularx-itemize (\\item bodies inside itemize, no resume macros)
 *
 * Usage:
 *   node src/lib/extract-latex-content.mjs <source.tex>
 *   node src/lib/extract-latex-content.mjs <source.tex> --out manifest.json
 */

import { writeFile } from 'fs/promises';
import { resolve, basename } from 'path';
import { pathToFileURL } from 'url';
import { readFile } from '../core/store.js';
import { buildManifest } from './latex-content.mjs';

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--help');
  const outIdx = args.indexOf('--out');
  let outPath = null;
  if (outIdx !== -1) {
    outPath = args[outIdx + 1];
    args.splice(outIdx, 2);
  }

  const sourcePath = args[0];
  if (!sourcePath) {
    console.error('Usage: node src/lib/extract-latex-content.mjs <source.tex> [--out manifest.json]');
    process.exit(1);
  }

  const absPath = resolve(sourcePath);

  // One read, two outcomes: absent is "not found", anything else that stops the
  // read is "failed to read". The old existsSync pre-flight answered false for
  // a path this process cannot traverse to, reporting an unreadable source as
  // a missing one.
  let tex;
  try {
    const source = readFile(absPath);
    if (!source.exists) {
      console.error(`Source not found: ${absPath}`);
      process.exit(1);
    }
    tex = source.content;
  } catch (err) {
    console.error(`Failed to read ${absPath}: ${err.message}`);
    process.exit(1);
  }

  const manifest = buildManifest(basename(absPath), tex);
  const json = JSON.stringify(manifest, null, 2);

  if (outPath) {
    await writeFile(resolve(outPath), json, 'utf-8');
  }
  console.log(json);
  process.exit(manifest.supported ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
