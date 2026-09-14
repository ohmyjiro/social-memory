import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import { openDatabase } from '../src/db.mjs';
import {
  connectExtension,
  extensionConnectors,
  getExtensionConnection,
  ingestExtensionBatch,
} from '../src/extension-connections.mjs';
import { searchSources } from '../src/search.mjs';

const firstInstallation = '11111111-1111-4111-8111-111111111111';
const secondInstallation = '22222222-2222-4222-8222-222222222222';

async function context(t) {
  const config = loadConfig({
    SOCIAL_MEMORY_DATA_DIR: await mkdtemp(join(tmpdir(), 'social-memory-extension-')),
  });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  return { config, db, registry: createConnectorRegistry(extensionConnectors) };
}

function xItem(overrides = {}) {
  return {
    postId: '1900000000000000000',
    sourceUrl: 'https://x.com/fictional_author/status/1900000000000000000',
    authorHandle: 'fictional_author',
    authorName: 'Fictional Author',
    text: 'A synthetic saved idea',
    postedAt: '2026-09-01T02:03:04.000Z',
    assets: [],
    ...overrides,
  };
}

test('multiple Chrome profiles share one verified account and one source', async (t) => {
  const { config, db, registry } = await context(t);
  const first = await connectExtension(db, registry, {
    installationId: firstInstallation,
    platform: 'x',
    authenticatedIdentity: 'reader_one',
    selectedCaptureKinds: ['save'],
  });
  const second = await connectExtension(db, registry, {
    installationId: secondInstallation,
    platform: 'x',
    authenticatedIdentity: '@Reader_One',
    selectedCaptureKinds: ['save'],
  });

  assert.equal(first.account.id, second.account.id);
  assert.notEqual(first.connection.installationId, second.connection.installationId);
  assert.equal(getExtensionConnection(db, firstInstallation, 'x').account.configuredIdentity, 'reader_one');

  for (const installationId of [firstInstallation, secondInstallation]) {
    await ingestExtensionBatch(db, config, {
      installationId,
      platform: 'x',
      authenticatedIdentity: 'reader_one',
      kind: 'save',
      items: [xItem()],
    });
  }
  assert.equal(searchSources(db).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM captures').get().count, 1);
});

test('invalid extension input and changed identities write nothing', async (t) => {
  const { config, db, registry } = await context(t);
  for (const input of [
    { installationId: 'not-a-uuid', platform: 'x', authenticatedIdentity: 'reader', selectedCaptureKinds: ['save'] },
    { installationId: firstInstallation, platform: 'mastodon', authenticatedIdentity: 'reader', selectedCaptureKinds: ['save'] },
  ]) {
    await assert.rejects(connectExtension(db, registry, input));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM extension_connections').get().count, 0);

  await connectExtension(db, registry, {
    installationId: firstInstallation,
    platform: 'x',
    authenticatedIdentity: 'reader',
    selectedCaptureKinds: ['save'],
  });
  const before = db.prepare('SELECT COUNT(*) AS count FROM sources').get().count;
  for (const input of [
    { authenticatedIdentity: 'other_reader', kind: 'save', items: [xItem()] },
    { authenticatedIdentity: 'reader', kind: 'like', items: [xItem()] },
    { authenticatedIdentity: 'reader', kind: 'save', items: [xItem({ sourceUrl: 'not-a-url' })] },
    { authenticatedIdentity: 'reader', kind: 'save', items: [xItem({ sourceUrl: 'https://evil.test/a/status/1900000000000000000' })] },
  ]) {
    await assert.rejects(ingestExtensionBatch(db, config, {
      installationId: firstInstallation,
      platform: 'x',
      ...input,
    }));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sources').get().count, before);
});

test('version 3 libraries are rejected without mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'social-memory-v3-'));
  const path = join(root, 'old.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(3, 'old'); CREATE TABLE sources(id INTEGER PRIMARY KEY, platform TEXT);");
  db.close();
  const before = await readFile(path);
  assert.throws(() => openDatabase(path), /new data directory/i);
  assert.deepEqual(await readFile(path), before);
});
