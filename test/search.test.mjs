import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureAccount } from '../src/accounts.mjs';
import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { fixtureConnector } from '../src/connectors/fixture.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import { openDatabase } from '../src/db.mjs';
import { ingestCaptureBatch } from '../src/ingest.mjs';
import { getSource, searchSources } from '../src/search.mjs';

async function createSearchFixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'social-memory-search-'));
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());

  const archiveConnector = {
    id: 'archive',
    capabilities: ['save'],
    async verify() { return { status: 'ready' }; },
    async collect() { return { events: [], nextCursor: null }; },
  };
  const registry = createConnectorRegistry([fixtureConnector, archiveConnector]);
  const reader = configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['like', 'save'],
  });
  const archivist = configureAccount(db, registry, {
    connectorId: 'archive',
    identity: 'archivist_one',
    selectedCaptureKinds: ['save'],
  });

  const shared = {
    externalId: 'shared-idea',
    canonicalUrl: 'https://example.test/ideas/shared',
    author: { handle: 'market_maker', name: 'Market Maker' },
    text: 'A pricing engine for independent makers',
    sourceCreatedAt: '2026-01-02T03:04:05.000Z',
    evidence: [{
      kind: 'text',
      text: 'Retention loops depend on a clear return trigger.',
      provenance: 'linked-page',
    }],
  };
  await ingestCaptureBatch(db, config, reader, 'like', [{
    ...shared,
    capture: { kind: 'like', nativeKind: 'favorite', capturedAt: null },
  }]);
  await ingestCaptureBatch(db, config, reader, 'save', [{
    ...shared,
    capture: { kind: 'save', nativeKind: 'bookmark', capturedAt: null },
  }]);
  await ingestCaptureBatch(db, config, archivist, 'save', [{
    externalId: 'archive-idea',
    canonicalUrl: 'https://archive.example.test/ideas/creator',
    author: { handle: 'creator_lab', name: 'Creator Lab' },
    text: 'Creator economy field notes',
    sourceCreatedAt: '2026-07-02T03:04:05.000Z',
    capture: { kind: 'save', nativeKind: 'saved', capturedAt: null },
    evidence: [],
  }]);

  const ids = Object.fromEntries(
    db.prepare('SELECT external_id, id FROM sources').all().map((row) => [row.external_id, row.id]),
  );
  return { archivist, db, ids, reader };
}

test('blank, lexical, author, and evidence searches return hand-derived source ids', async (t) => {
  const { db, ids } = await createSearchFixture(t);

  assert.deepEqual(searchSources(db, { query: '' }).map(({ id }) => id), [
    ids['archive-idea'],
    ids['shared-idea'],
  ]);
  assert.deepEqual(searchSources(db, { query: 'pricing' }).map(({ id }) => id), [ids['shared-idea']]);
  assert.deepEqual(searchSources(db, { query: 'market_maker' }).map(({ id }) => id), [ids['shared-idea']]);
  assert.deepEqual(searchSources(db, { query: 'retention' }).map(({ id }) => id), [ids['shared-idea']]);
});

test('metadata filters distinguish like from save exactly', async (t) => {
  const { archivist, db, ids, reader } = await createSearchFixture(t);

  assert.deepEqual(searchSources(db, { query: '', kinds: ['like'] }).map(({ id }) => id), [ids['shared-idea']]);
  assert.deepEqual(searchSources(db, { query: '', kinds: ['save'] }).map(({ id }) => id), [
    ids['archive-idea'],
    ids['shared-idea'],
  ]);
  assert.deepEqual(searchSources(db, { query: '', connectorId: 'fixture' }).map(({ id }) => id), [ids['shared-idea']]);
  assert.deepEqual(searchSources(db, { query: '', accountId: reader.id }).map(({ id }) => id), [ids['shared-idea']]);
  assert.deepEqual(searchSources(db, { query: '', accountId: archivist.id }).map(({ id }) => id), [ids['archive-idea']]);
  assert.deepEqual(searchSources(db, { query: '', since: '2026-06-01T00:00:00.000Z' }).map(({ id }) => id), [ids['archive-idea']]);
});

test('search and detail results preserve reaction and evidence provenance', async (t) => {
  const { db, ids } = await createSearchFixture(t);

  const [result] = searchSources(db, { query: 'retention', limit: 500 });
  assert.equal(result.id, ids['shared-idea']);
  assert.deepEqual(result.captureKinds, ['like', 'save']);
  assert.deepEqual(result.nativeKinds, ['favorite', 'bookmark']);

  const detail = getSource(db, result.id);
  assert.deepEqual(detail.captures.map(({ kind, nativeKind }) => ({ kind, nativeKind })), [
    { kind: 'like', nativeKind: 'favorite' },
    { kind: 'save', nativeKind: 'bookmark' },
  ]);
  assert.deepEqual(detail.evidence.map(({ provenance, text }) => ({ provenance, text })), [{
    provenance: 'linked-page',
    text: 'Retention loops depend on a clear return trigger.',
  }]);
  assert.equal('rawJson' in detail, false);
});
