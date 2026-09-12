import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { configureAccount } from '../src/accounts.mjs';
import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { fixtureConnector } from '../src/connectors/fixture.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import { openDatabase } from '../src/db.mjs';
import { storeObject } from '../src/evidence-store.mjs';
import { ingestCaptureBatch } from '../src/ingest.mjs';

const fixtureFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'files',
  'sample-note.txt',
);

async function createTestContext(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'social-memory-ingest-'));
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  const registry = createConnectorRegistry([fixtureConnector]);
  const account = configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'fictional_reader',
    selectedCaptureKinds: ['like', 'save'],
  });
  return { account, config, db };
}

function eventFor(kind, nativeKind, overrides = {}) {
  return {
    externalId: 'shared-source',
    canonicalUrl: 'https://example.test/posts/shared-source',
    author: { handle: 'fictional_author', name: 'Fictional Author' },
    text: 'A deliberately synthetic product note',
    sourceCreatedAt: '2026-01-02T03:04:05.000Z',
    capture: {
      kind,
      nativeKind,
      capturedAt: '2026-01-03T04:05:06.000Z',
    },
    evidence: [],
    ...overrides,
  };
}

test('one source retains separate like and save captures idempotently', async (t) => {
  const { account, config, db } = await createTestContext(t);

  const liked = await ingestCaptureBatch(
    db,
    config,
    account,
    'like',
    [eventFor('like', 'favorite')],
  );
  const saved = await ingestCaptureBatch(
    db,
    config,
    account,
    'save',
    [eventFor('save', 'bookmark')],
  );

  assert.equal(liked.insertedSources, 1);
  assert.equal(liked.insertedCaptures, 1);
  assert.equal(saved.insertedSources, 0);
  assert.equal(saved.insertedCaptures, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sources').get().count, 1);
  assert.deepEqual(
    db.prepare('SELECT kind, native_kind FROM captures ORDER BY kind').all()
      .map((row) => ({ ...row })),
    [
      { kind: 'like', native_kind: 'favorite' },
      { kind: 'save', native_kind: 'bookmark' },
    ],
  );

  const repeated = await ingestCaptureBatch(
    db,
    config,
    account,
    'save',
    [eventFor('save', 'bookmark')],
  );
  assert.equal(repeated.insertedSources, 0);
  assert.equal(repeated.insertedCaptures, 0);
  assert.equal(repeated.updatedCaptures, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM captures').get().count, 2);
});

test('content-addressed evidence stores duplicate bytes once', async (t) => {
  const { account, config, db } = await createTestContext(t);
  const firstObject = await storeObject(config, fixtureFile);
  const secondObject = await storeObject(config, fixtureFile);

  assert.equal(firstObject.sha256, secondObject.sha256);
  assert.equal(firstObject.objectPath, secondObject.objectPath);
  assert.equal(await readFile(join(config.dataDir, firstObject.objectPath), 'utf8'), await readFile(fixtureFile, 'utf8'));
  assert.equal((await stat(join(config.dataDir, firstObject.objectPath))).isFile(), true);

  const result = await ingestCaptureBatch(
    db,
    config,
    account,
    'save',
    [eventFor('save', 'bookmark', {
      evidence: [
        { kind: 'file', filePath: fixtureFile, mimeType: 'text/plain', provenance: 'attachment' },
        { kind: 'file', filePath: fixtureFile, mimeType: 'text/plain', provenance: 'download' },
      ],
    })],
  );

  assert.equal(result.storedObjects, 1);
  assert.equal(result.insertedEvidence, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM objects').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evidence').get().count, 2);
});

test('a malformed event rolls back the entire database batch', async (t) => {
  const { account, config, db } = await createTestContext(t);
  const valid = eventFor('like', 'favorite', { externalId: 'valid-in-bad-batch' });
  const malformed = eventFor('like', 'favorite', {
    externalId: '',
    canonicalUrl: 'not a URL',
  });

  await assert.rejects(
    ingestCaptureBatch(db, config, account, 'like', [valid, malformed]),
    /externalId/i,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sources').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM captures').get().count, 0);
});
