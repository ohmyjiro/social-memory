import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';

function captureOutput() {
  return { write() {} };
}

async function initializeImportLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'social-memory-import-'));
  const dataDir = join(root, 'library');
  const env = { SOCIAL_MEMORY_DATA_DIR: dataDir };
  await runCli(['init', '--data-dir', dataDir, '--json'], { env: {}, stdout: captureOutput() });
  const config = loadConfig(env);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  return { config, dataDir, db, env, root };
}

function importDocument(captures) {
  return { schema: 'social-memory.capture-export', version: 1, captures };
}

function sharedCapture(kind, nativeKind) {
  return {
    kind,
    nativeKind,
    capturedAt: '2026-08-01T01:02:03.000Z',
    source: {
      externalId: 'portable-shared-source',
      canonicalUrl: 'https://example.test/import/shared',
      author: { handle: 'portable_author', name: 'Portable Author' },
      text: 'Portable import about pricing and retention',
      sourceCreatedAt: '2026-07-01T01:02:03.000Z',
    },
    evidence: [],
  };
}

test('versioned import keeps like and save as distinct captures on one source', async (t) => {
  const { db, env, root } = await initializeImportLibrary(t);
  const filePath = join(root, 'capture export.json');
  await writeFile(filePath, JSON.stringify(importDocument([
    sharedCapture('like', 'favorite'),
    sharedCapture('save', 'bookmark'),
  ])));

  const result = await runCli([
    'import', '--file', filePath,
    '--account', 'portable_reader',
    '--include', 'like,save',
    '--json',
  ], { env, stdout: captureOutput() });

  assert.equal(result.sources, 1);
  assert.equal(result.captures, 2);
  assert.deepEqual(
    db.prepare('SELECT kind, native_kind FROM captures ORDER BY kind').all().map((row) => ({ ...row })),
    [
      { kind: 'like', native_kind: 'favorite' },
      { kind: 'save', native_kind: 'bookmark' },
    ],
  );
});

test('malformed import is rejected before any source or capture is written', async (t) => {
  const { db, env, root } = await initializeImportLibrary(t);
  const filePath = join(root, 'bad export.json');
  await writeFile(filePath, JSON.stringify(importDocument([
    sharedCapture('like', 'favorite'),
    { ...sharedCapture('save', 'bookmark'), source: { externalId: '' } },
  ])));

  await assert.rejects(
    runCli([
      'import', '--file', filePath,
      '--account', 'portable_reader',
      '--include', 'like,save',
      '--json',
    ], { env, stdout: captureOutput() }),
    /externalId/i,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sources').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM captures').get().count, 0);
});

test('import evidence paths cannot escape the export directory', async (t) => {
  const { db, env, root } = await initializeImportLibrary(t);
  const filePath = join(root, 'escaping export.json');
  const capture = sharedCapture('save', 'bookmark');
  capture.evidence = [{
    kind: 'file',
    path: '../outside.txt',
    mimeType: 'text/plain',
    provenance: 'export',
  }];
  await writeFile(filePath, JSON.stringify(importDocument([capture])));

  await assert.rejects(
    runCli([
      'import', '--file', filePath,
      '--account', 'portable_reader',
      '--include', 'save',
      '--json',
    ], { env, stdout: captureOutput() }),
    /escape/i,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evidence').get().count, 0);
});
