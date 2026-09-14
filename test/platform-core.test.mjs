import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import * as accounts from '../src/accounts.mjs';
import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import { openDatabase } from '../src/db.mjs';
import { ingestCaptureBatch } from '../src/ingest.mjs';
import { searchSources } from '../src/search.mjs';

async function context(t) {
  const config = loadConfig({
    SOCIAL_MEMORY_DATA_DIR: await mkdtemp(join(tmpdir(), 'sm-platform-')),
  });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  return { db, config };
}

const connector = (id) => ({
  id,
  capabilities: ['like', 'save'],
  async verify() { return { status: 'ready', authenticatedIdentity: '@Reader' }; },
});

const event = (kind) => ({
  externalId: 'same-id',
  canonicalUrl: 'https://example.test/post/same-id',
  text: 'platform evidence',
  capture: { kind, nativeKind: kind },
  evidence: [],
});

test('one platform post survives alternate transports and remains searchable by either connector', async (t) => {
  const { db, config } = await context(t);
  const registry = createConnectorRegistry(['x', 'x-chrome', 'threads'].map(connector));
  for (const [id, kind] of [['x', 'like'], ['x-chrome', 'save'], ['threads', 'save']]) {
    const account = accounts.configureAccount(db, registry, {
      connectorId: id,
      identity: 'reader',
      selectedCaptureKinds: [kind],
    });
    await ingestCaptureBatch(db, config, account, kind, [event(kind)]);
  }
  assert.equal(searchSources(db).length, 2);
  const x = searchSources(db, { connectorId: 'x' })[0];
  assert.equal(searchSources(db, { connectorId: 'x-chrome' })[0].id, x.id);
  assert.equal(x.platform, 'x');
  assert.deepEqual(x.captureKinds, ['like', 'save']);
  const list = accounts.listAccounts(db);
  assert.equal(
    list.find((account) => account.connectorId === 'x').identityId,
    list.find((account) => account.connectorId === 'x-chrome').identityId,
  );
});

test('a trusted adapter can register the observed account without a profile or typed handle', async (t) => {
  const { db } = await context(t);
  const registry = createConnectorRegistry([connector('x')]);
  const account = await accounts.connectAccount(db, registry, {
    connectorId: 'x',
    selectedCaptureKinds: ['save'],
  });
  assert.equal(account.configuredIdentity, 'reader');
  assert.equal(account.profileRef, null);
  assert.equal(account.status, 'ready');
  assert.deepEqual(account.selectedCaptureKinds, ['save']);
});

test('adapter discovery ignores a caller-supplied identity and failed discovery writes nothing', async (t) => {
  const { db } = await context(t);
  const ready = createConnectorRegistry([connector('x')]);
  const account = await accounts.connectAccount(db, ready, {
    connectorId: 'x',
    identity: 'forged',
    selectedCaptureKinds: ['save'],
  });
  assert.equal(account.configuredIdentity, 'reader');

  const failed = createConnectorRegistry([{
    id: 'threads',
    capabilities: ['save'],
    async verify() { return { status: 'reauth_required' }; },
  }]);
  await assert.rejects(
    accounts.connectAccount(db, failed, {
      connectorId: 'threads',
      selectedCaptureKinds: ['save'],
    }),
    /could not verify/i,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE connector_id = 'threads'").get().count,
    0,
  );
});

test('an extension connector declaring its platform shares the platform source identity', async (t) => {
  const { db, config } = await context(t);
  const extension = { ...connector('browser-extension'), platform: 'x' };
  const registry = createConnectorRegistry([connector('x-chrome'), extension]);
  for (const id of ['x-chrome', 'browser-extension']) {
    const account = accounts.configureAccount(db, registry, {
      connectorId: id,
      identity: 'reader',
      selectedCaptureKinds: ['save'],
    });
    await ingestCaptureBatch(db, config, account, 'save', [event('save')]);
  }
  assert.equal(searchSources(db).length, 1);
});

test('account and kind filters must match the same capture record', async (t) => {
  const { db, config } = await context(t);
  const registry = createConnectorRegistry(['x', 'x-chrome'].map(connector));
  const liked = accounts.configureAccount(db, registry, {
    connectorId: 'x', identity: 'reader', selectedCaptureKinds: ['like'],
  });
  const saved = accounts.configureAccount(db, registry, {
    connectorId: 'x-chrome', identity: 'reader', selectedCaptureKinds: ['save'],
  });
  await ingestCaptureBatch(db, config, liked, 'like', [event('like')]);
  await ingestCaptureBatch(db, config, saved, 'save', [event('save')]);
  assert.deepEqual(searchSources(db, { accountId: liked.id, kinds: ['save'] }), []);
});

test('legacy databases are rejected without conversion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sm-migrate-'));
  const path = join(root, 'old.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sources(id INTEGER PRIMARY KEY, text TEXT); INSERT INTO sources VALUES(1,'legacy content');");
  db.close();
  const before = await readFile(path);
  assert.throws(() => openDatabase(path), /Legacy library is unsupported/);
  assert.deepEqual(await readFile(path), before);
  const unchanged = new DatabaseSync(path);
  try {
    assert.equal(unchanged.prepare('SELECT text FROM sources').get().text, 'legacy content');
  } finally {
    unchanged.close();
  }
});
