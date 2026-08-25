// Pins src/scripts/intake.mjs's documents/ and state-file resolution after it moved onto
// src/core/store.js's workspaceDir().
//
// tests/intake.test.mjs sets CAREER_OPS_DOCUMENTS_DIR and CAREER_OPS_INTAKE_STATE
// on every run, so the env override is the only branch it ever exercises. The
// resolution BELOW that override is what changed — it now prefers
// workspace/<name>/ and keeps the legacy root path when that is the one on disk
// (ADR 0007's compat shim) — and without this file that change ships untested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, copyFileSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// src/scripts/intake.mjs anchors both paths to its own directory, so a temp checkout holding
// a real copy of it is the only way to vary the layout underneath it.
function makeRoot(layout) {
  // realpath: macOS hands out /var/folders/… for a /private/var/folders/… dir,
  // and src/scripts/intake.mjs resolves its own location, so the two spellings must be
  // reconciled here or every path assertion below compares the wrong pair.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'intake-paths-')));
  // src/scripts/ is real (it holds the copy under test) so only the directories
  // the copy imports from are linked back to the checkout.
  mkdirSync(join(root, 'src', 'scripts'), { recursive: true });
  copyFileSync(join(REPO, 'src/scripts/intake.mjs'), join(root, 'src/scripts/intake.mjs'));
  symlinkSync(join(REPO, 'src', 'core'), join(root, 'src', 'core'), 'dir');
  if (layout) {
    mkdirSync(join(root, layout, 'cv'), { recursive: true });
    writeFileSync(join(root, layout, 'cv', 'master.md'), '# CV\n\nShipped things.\n');
  }
  return root;
}

function scan(root) {
  // The env overrides are deliberately NOT set: this is the branch under test.
  const r = spawnSync(process.execPath, ['src/scripts/intake.mjs'], { cwd: root, encoding: 'utf-8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('an install that already has documents/ keeps using it', () => {
  const root = makeRoot('documents');
  try {
    const out = scan(root);
    assert.equal(out.documentsDir, resolve(root, 'documents'));
    assert.deepEqual(out.sources.map(s => s.path), ['cv/master.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an install laid out under workspace/ is found there', () => {
  const root = makeRoot(join('workspace', 'documents'));
  try {
    const out = scan(root);
    assert.equal(out.documentsDir, resolve(root, 'workspace', 'documents'));
    assert.deepEqual(out.sources.map(s => s.path), ['cv/master.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace/ wins when both layouts are present', () => {
  const root = makeRoot('documents');
  try {
    mkdirSync(join(root, 'workspace', 'documents', 'cv'), { recursive: true });
    writeFileSync(join(root, 'workspace', 'documents', 'cv', 'modern.md'), '# CV\n\nNewer.\n');
    const out = scan(root);
    assert.equal(out.documentsDir, resolve(root, 'workspace', 'documents'));
    assert.deepEqual(out.sources.map(s => s.path), ['cv/modern.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a fresh install scaffolds the intake folders under workspace/', () => {
  const root = makeRoot(null);
  try {
    scan(root);
    for (const folder of ['cv', 'linkedin', 'diplomas', 'references']) {
      assert.equal(existsSync(join(root, 'workspace', 'documents', folder)), true, folder);
    }
    assert.equal(existsSync(join(root, 'documents')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the env overrides still beat both layouts', () => {
  const root = makeRoot('documents');
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'intake-docs-')));
  try {
    mkdirSync(join(elsewhere, 'cv'), { recursive: true });
    writeFileSync(join(elsewhere, 'cv', 'override.md'), '# CV\n\nOverridden.\n');
    const state = join(elsewhere, 'state.json');
    const r = spawnSync(process.execPath, ['src/scripts/intake.mjs'], {
      cwd: root,
      encoding: 'utf-8',
      env: { ...process.env, CAREER_OPS_DOCUMENTS_DIR: elsewhere, CAREER_OPS_INTAKE_STATE: state },
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.documentsDir, elsewhere);
    assert.deepEqual(out.sources.map(s => s.path), ['cv/override.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('--text accepts both flag forms and refuses a missing operand', () => {
  const root = makeRoot('documents');
  try {
    const run = (...args) => spawnSync(process.execPath, ['src/scripts/intake.mjs', ...args], { cwd: root, encoding: 'utf-8' });

    for (const args of [['--text', 'cv/master.md'], ['--text=cv/master.md']]) {
      const r = run(...args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stdout, /Shipped things\./);
    }

    // `--text --summary` must report the missing operand rather than read
    // '--summary' as a path (ADR 0004 #6).
    const swallowed = run('--text', '--summary');
    assert.equal(swallowed.status, 1);
    assert.match(swallowed.stderr, /Usage: node \S*intake\.mjs --text/);

    const bare = run('--text');
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /Usage: node \S*intake\.mjs --text/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
