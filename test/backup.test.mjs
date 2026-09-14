import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureAccount } from '../src/accounts.mjs';
import { createBackup, restoreBackup } from '../src/backup.mjs';
import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { fixtureConnector } from '../src/connectors/fixture.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import { openDatabase } from '../src/db.mjs';
import { runSync } from '../src/sync.mjs';

async function populatedLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'social-memory-backup-'));
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: join(root, 'source library') });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  const registry = createConnectorRegistry([fixtureConnector]);
  configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['like', 'save'],
  });
  await runSync({ db, config, registry });
  return { root, config, db };
}

test('backup and restore preserve the database in a new path with spaces', async (t) => {
  const { root, config, db } = await populatedLibrary(t);
  const backupDir = join(root, 'portable backup');
  const restoredDir = join(root, 'restored library');

  const created = await createBackup({ db, config, outputDir: backupDir });
  const restored = await restoreBackup({ backupDir, dataDir: restoredDir });
  const restoredDb = openDatabase(loadConfig({ SOCIAL_MEMORY_DATA_DIR: restoredDir }).dbPath);
  t.after(() => restoredDb.close());

  assert.equal(created.status, 'created');
  assert.equal(restored.status, 'restored');
  assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM sources').get().count, 1);
  assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM captures').get().count, 2);
  const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'social-memory-backup');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.schemaVersion, 4);
  assert.ok(manifest.files.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));
});

test('restore rejects tampered backup bytes before creating a target library', async (t) => {
  const { root, config, db } = await populatedLibrary(t);
  const backupDir = join(root, 'portable backup');
  const restoredDir = join(root, 'must not exist');
  await createBackup({ db, config, outputDir: backupDir });
  await writeFile(join(backupDir, 'social-memory.sqlite'), 'tampered');

  await assert.rejects(
    () => restoreBackup({ backupDir, dataDir: restoredDir }),
    (error) => error.code === 'backup_integrity_failed',
  );
  await assert.rejects(() => readFile(join(restoredDir, 'config.json')), /ENOENT/);
});

test('backup refuses to overwrite an existing destination', async (t) => {
  const { root, config, db } = await populatedLibrary(t);
  const backupDir = join(root, 'existing');
  await writeFile(backupDir, 'occupied');

  await assert.rejects(
    () => createBackup({ db, config, outputDir: backupDir }),
    (error) => error.code === 'backup_destination_exists',
  );
});

test('backup destination cannot be nested inside the live library', async (t) => {
  const { config, db } = await populatedLibrary(t);

  await assert.rejects(
    () => createBackup({ db, config, outputDir: join(config.objectsDir, 'recursive backup') }),
    (error) => error.code === 'invalid_path',
  );
});
