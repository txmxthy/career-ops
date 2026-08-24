// Characterisation test for reconcile-pipeline.mjs, written before the file was
// rewired onto src/core (ADR 0005's "capture current behaviour first" rule).
// The script had no coverage at all, and it anchors every path to its OWN
// directory — REPORTS_DIR is join(CAREER_OPS, 'reports') with no override — so
// the only way to exercise it in isolation is to run a copy of it from a temp
// root and symlink the modules it imports back to the real checkout.
//
// What is pinned here, all of it observable behaviour the rewiring must keep:
//   - the flag forms `--pipeline <path>` / `--state <path>` and `--dry-run`
//   - the "nothing to reconcile" early exits (each is exit 0 with its own line)
//   - the repository-containment refusal on a crafted --pipeline
//   - the Pendientes → Procesadas move, its cell layout, and the .bak backup
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, copyFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** A temp checkout holding a real copy of the script and links to its imports. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-'));
  copyFileSync(join(REPO, 'reconcile-pipeline.mjs'), join(root, 'reconcile-pipeline.mjs'));
  // Node resolves a symlink to its realpath before resolving that file's own
  // imports, so linking the directory is enough — src/core/store.js still finds
  // ../../pipeline-lock.mjs in the real checkout.
  symlinkSync(join(REPO, 'src'), join(root, 'src'), 'dir');
  symlinkSync(join(REPO, 'tracker-links.mjs'), join(root, 'tracker-links.mjs'));
  for (const d of ['batch', 'data', 'reports']) mkdirSync(join(root, d), { recursive: true });
  return root;
}

// Both streams are returned together: the warn for an entry left behind goes to
// stderr even on an exit-0 run, so a stdout-only harness cannot see it.
function run(root, args = []) {
  const r = spawnSync(process.execPath, ['reconcile-pipeline.mjs', ...args], {
    cwd: root, encoding: 'utf-8',
  });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const STATE_HEADER = 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n';

function seed(root, { state = '', pipeline = '', reports = {} } = {}) {
  writeFileSync(join(root, 'batch/batch-state.tsv'), STATE_HEADER + state);
  writeFileSync(join(root, 'data/pipeline.md'), pipeline);
  for (const [name, body] of Object.entries(reports)) writeFileSync(join(root, 'reports', name), body);
}

const PENDING_THREE = `# Pipeline

## Pendientes

- [ ] https://ex.com/JobABC | Acme | Eng
- [ ] https://ex.com/other | Beta | Ops
- [ ] https://ex.com/keep | Gamma | Sales
`;

test('moves completed and skipped entries into Procesadas, leaving the rest', () => {
  const root = makeRoot();
  try {
    seed(root, {
      state: '1\thttps://ex.com/JobABC\tcompleted\t-\t-\t7\t4.5\t\t0\n'
           + '2\thttps://ex.com/other\tskipped\t-\t-\t8\t\t\t0\n',
      pipeline: PENDING_THREE,
      reports: {
        '7-acme.md': '**Score:** 3.2/5\n**PDF:** generated\n',
        '8-beta.md': '**Score:** N/A\n**PDF:** not generated\n',
      },
    });
    const r = run(root);
    assert.equal(r.code, 0, r.out);

    const after = readFileSync(join(root, 'data/pipeline.md'), 'utf-8');
    // The state's own numeric score wins over the report's; a non-numeric one
    // falls back to the report, and "not generated" is the ❌ half of the PDF flag.
    assert.match(after, /^- \[x\] \[7\]\(\.\.\/reports\/7-acme\.md\) \| https:\/\/ex\.com\/JobABC \| Acme \| Eng \| 4\.5\/5 \| PDF ✅$/m);
    assert.match(after, /^- \[x\] \[8\]\(\.\.\/reports\/8-beta\.md\) \| https:\/\/ex\.com\/other \| Beta \| Ops \| N\/A \| PDF ❌$/m);
    // Untouched entry stays pending; the moved ones are gone from Pendientes.
    assert.match(after, /^- \[ \] https:\/\/ex\.com\/keep \| Gamma \| Sales$/m);
    assert.doesNotMatch(after, /^- \[ \] https:\/\/ex\.com\/JobABC/m);
    // URL path case is preserved on both sides of the move (ADR 0004).
    assert.ok(after.includes('/JobABC'));
    assert.equal(existsSync(join(root, 'data/pipeline.md.pre-reconcile.bak')), true);
    assert.equal(readFileSync(join(root, 'data/pipeline.md.pre-reconcile.bak'), 'utf-8'), PENDING_THREE);
    assert.match(r.out, /2 processed entries moved Pendientes → Procesadas/);
    assert.match(r.out, /📋 Pendientes now: 1 entry/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--dry-run reports the moves but writes nothing', () => {
  const root = makeRoot();
  try {
    seed(root, {
      state: '1\thttps://ex.com/JobABC\tcompleted\t-\t-\t7\t4.5\t\t0\n',
      pipeline: PENDING_THREE,
      reports: { '7-acme.md': '**Score:** 3.2/5\n**PDF:** generated\n' },
    });
    const r = run(root, ['--dry-run']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\(dry-run — no changes written\)/);
    assert.equal(readFileSync(join(root, 'data/pipeline.md'), 'utf-8'), PENDING_THREE);
    assert.equal(existsSync(join(root, 'data/pipeline.md.pre-reconcile.bak')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an entry whose report is not on disk stays pending and is warned about', () => {
  const root = makeRoot();
  try {
    seed(root, {
      state: '1\thttps://ex.com/JobABC\tcompleted\t-\t-\t99\t4.5\t\t0\n',
      pipeline: PENDING_THREE,
    });
    const r = run(root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /reports\/99-\*\.md found; left in Pendientes/);
    assert.equal(readFileSync(join(root, 'data/pipeline.md'), 'utf-8'), PENDING_THREE);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a URL already in Procesadas is dropped from Pendientes without a second copy', () => {
  const root = makeRoot();
  try {
    seed(root, {
      state: '1\thttps://ex.com/JobABC\tcompleted\t-\t-\t7\t4.5\t\t0\n',
      pipeline: `## Pendientes

- [ ] https://ex.com/JobABC | Acme | Eng

## Procesadas

- [x] [7](reports/7-acme.md) | https://ex.com/JobABC | Acme | Eng | 4.5/5 | PDF ✅
`,
      reports: { '7-acme.md': '**Score:** 3.2/5\n**PDF:** generated\n' },
    });
    const r = run(root);
    assert.equal(r.code, 0, r.out);
    const after = readFileSync(join(root, 'data/pipeline.md'), 'utf-8');
    assert.equal(after.match(/https:\/\/ex\.com\/JobABC/g).length, 1);
    assert.match(r.out, /stale Pendientes entr\w+ dropped/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('each nothing-to-do case exits 0 with its own message', () => {
  const root = makeRoot();
  try {
    // No state file at all.
    rmSync(join(root, 'batch/batch-state.tsv'), { force: true });
    writeFileSync(join(root, 'data/pipeline.md'), PENDING_THREE);
    let r = run(root);
    assert.equal(r.code, 0);
    assert.match(r.out, /No batch-state\.tsv found — nothing to reconcile\./);

    // State present but no completed rows.
    seed(root, { state: '1\thttps://ex.com/x\trunning\t-\t-\t-\t-\t\t0\n', pipeline: PENDING_THREE });
    r = run(root);
    assert.equal(r.code, 0);
    assert.match(r.out, /No completed batch entries/);

    // Completed rows, but no Pendientes section to take them from.
    seed(root, {
      state: '1\thttps://ex.com/x\tcompleted\t-\t-\t7\t4.5\t\t0\n',
      pipeline: '# Pipeline\n\n## Procesadas\n',
    });
    r = run(root);
    assert.equal(r.code, 0);
    assert.match(r.out, /No "Pendientes" section/);

    // Nothing in Pendientes matches: already in sync.
    seed(root, {
      state: '1\thttps://ex.com/nomatch\tcompleted\t-\t-\t7\t4.5\t\t0\n',
      pipeline: PENDING_THREE,
      reports: { '7-acme.md': '**Score:** 3.2/5\n' },
    });
    r = run(root);
    assert.equal(r.code, 0);
    assert.match(r.out, /already in sync/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--pipeline outside the repository is refused, and --help exits 0', () => {
  const root = makeRoot();
  try {
    seed(root, { state: '1\thttps://ex.com/x\tcompleted\t-\t-\t7\t4.5\t\t0\n', pipeline: PENDING_THREE });
    const outside = join(tmpdir(), 'definitely-not-in-the-repo.md');
    writeFileSync(outside, PENDING_THREE);
    const r = run(root, ['--pipeline', outside]);
    assert.equal(r.code, 1);
    assert.match(r.out, /path must stay inside the repository/);
    rmSync(outside, { force: true });

    // A directory where a file was expected is named as such, not left to EISDIR.
    const dir = run(root, ['--pipeline', join(root, 'data')]);
    assert.equal(dir.code, 1);
    assert.match(dir.out, /expected a file, not a directory/);

    for (const flag of ['--help', '-h']) {
      const h = run(root, [flag]);
      assert.equal(h.code, 0);
      assert.match(h.out, /Usage: node reconcile-pipeline\.mjs/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--state and --pipeline accept a space-separated in-repo path', () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, 'alt'), { recursive: true });
    writeFileSync(join(root, 'alt/state.tsv'), STATE_HEADER
      + '1\thttps://ex.com/JobABC\tcompleted\t-\t-\t7\t4.5\t\t0\n');
    writeFileSync(join(root, 'alt/pipe.md'), PENDING_THREE);
    writeFileSync(join(root, 'data/pipeline.md'), '# untouched\n');
    writeFileSync(join(root, 'reports/7-acme.md'), '**Score:** 3.2/5\n**PDF:** generated\n');
    const r = run(root, ['--state', join(root, 'alt/state.tsv'), '--pipeline', join(root, 'alt/pipe.md')]);
    assert.equal(r.code, 0, r.out);
    assert.match(readFileSync(join(root, 'alt/pipe.md'), 'utf-8'), /- \[x\] \[7\]/);
    assert.equal(readFileSync(join(root, 'data/pipeline.md'), 'utf-8'), '# untouched\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
