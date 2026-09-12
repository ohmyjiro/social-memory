import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';

test('library configuration requires an absolute data directory', () => {
  assert.throws(
    () => loadConfig({ SOCIAL_MEMORY_DATA_DIR: 'relative/library' }),
    /absolute/i,
  );
});

test('initialization creates a private library and the complete core schema', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'social-memory-library-'));
  const dataDir = join(parent, 'private library');
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir });

  await initializeLibrary(config);

  for (const directory of [config.dataDir, config.objectsDir, config.stagingDir]) {
    const details = await stat(directory);
    assert.equal(details.mode & 0o777, 0o700, `${directory} should be private`);
  }

  for (const file of [config.configPath, config.dbPath]) {
    const details = await stat(file);
    assert.equal(details.mode & 0o777, 0o600, `${file} should be private`);
  }

  const db = openDatabase(config.dbPath);
  t.after(() => db.close());

  const expectedTables = [
    'account_capture_kinds',
    'accounts',
    'captures',
    'collection_runs',
    'connectors',
    'evidence',
    'manual_sync_receipts',
    'objects',
    'sources',
    'sources_fts',
    'sync_cursors',
  ];
  const actualTables = db
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name IN (${expectedTables.map(() => '?').join(', ')})
      ORDER BY name
    `)
    .all(...expectedTables)
    .map(({ name }) => name);

  assert.deepEqual(actualTables, expectedTables);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('initialization refuses database and config symbolic links', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'social-memory-symlink-'));
  const victim = join(parent, 'victim');
  await writeFile(victim, 'do not touch', { mode: 0o644 });

  for (const filename of ['config.json', 'social-memory.sqlite']) {
    const dataDir = join(parent, filename.replace('.', '-'));
    const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir });
    await mkdir(dataDir, { recursive: true });
    await symlink(victim, join(dataDir, filename));
    await assert.rejects(() => initializeLibrary(config), /symbolic link/i);
  }

  assert.equal(await readFile(victim, 'utf8'), 'do not touch');
  assert.equal((await stat(victim)).mode & 0o777, 0o644);
});

test('database open refuses a database replaced by a symbolic link', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'social-memory-db-link-'));
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: join(parent, 'library') });
  await initializeLibrary(config);
  const victim = join(parent, 'victim.sqlite');
  await writeFile(victim, 'not a database');
  await unlink(config.dbPath);
  await symlink(victim, config.dbPath);

  assert.throws(() => openDatabase(config.dbPath), /symbolic link/i);
  assert.equal(await readFile(victim, 'utf8'), 'not a database');
});
